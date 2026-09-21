/**
 * Lemon Squeezy as merchant of record (the work order's stated posture: VAT/GST
 * stay their problem). Three pieces, none of which puts a network call on the
 * query path:
 *
 *   - checkout links: static `https://<store>.lemonsqueezy.com/checkout/buy/<variant>`
 *     with the API key id passed as `checkout[custom][key_id]`, so the resulting
 *     subscription webhooks can be tied back to the key.
 *   - usage reports: `POST /v1/usage-records` with `action: "set"` and quantity =
 *     overage in units of 1,000 calls (the $1 billing unit). Sent from
 *     `waitUntil`, only at billable boundaries (see isBillableBoundary).
 *   - webhooks: `X-Signature` is an HMAC-SHA256 hex digest of the raw body.
 *     `subscription_*` events carry `meta.custom_data.key_id`; we record the
 *     subscription item (needed for usage records) and move the key's tier.
 *
 * https://docs.lemonsqueezy.com/api/usage-records/create-usage-record
 * https://docs.lemonsqueezy.com/help/checkout/passing-custom-data
 * https://docs.lemonsqueezy.com/help/webhooks/signing-requests
 */
import type { BillingProvider } from './billing.js';
import type { Usage } from './meter.js';
import { PAID_TIERS, type Tier } from './tiers.js';

import type { SqlClient, SqlValue } from '../stores/sql-store.js';

export const LEMONSQUEEZY_API = 'https://api.lemonsqueezy.com/v1';

/** Paid tier → Lemon Squeezy variant id, as configured in the store. */
export type VariantMap = Partial<Record<Exclude<Tier, 'anonymous' | 'free'>, string>>;

export interface SubscriptionRef {
  keyId: string;
  subscriptionId: string;
  subscriptionItemId: string;
  variantId: string;
  status: string;
}

export interface SubscriptionLookup {
  forKey(keyId: string): Promise<SubscriptionRef | null>;
}

export interface SubscriptionWriter extends SubscriptionLookup {
  keyExists(keyId: string): Promise<boolean>;
  upsert(ref: SubscriptionRef, updatedAt: string): Promise<void>;
  setKeyTier(keyId: string, tier: Tier): Promise<void>;
}

export interface LemonSqueezyConfig {
  apiKey: string;
  /** Store slug: `<store>.lemonsqueezy.com`. */
  store: string;
  variants: VariantMap;
  pricingUrl: string;
  subscriptions: SubscriptionLookup;
  fetch?: typeof fetch;
  apiBase?: string;
}

export function parseVariantMap(raw: string | undefined): VariantMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('LEMONSQUEEZY_VARIANTS is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('LEMONSQUEEZY_VARIANTS must be an object of tier -> variant id');
  }
  const out: VariantMap = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!PAID_TIERS.includes(k as Tier)) throw new Error(`LEMONSQUEEZY_VARIANTS: '${k}' is not a paid tier`);
    if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(`LEMONSQUEEZY_VARIANTS: variant for '${k}' must be a numeric string`);
    out[k as keyof VariantMap] = v;
  }
  return out;
}

export function tierForVariant(variants: VariantMap, variantId: string): Tier | null {
  for (const [tier, id] of Object.entries(variants)) if (id === variantId) return tier as Tier;
  return null;
}

/** Overage expressed in the $1 billing unit; what we tell the provider. */
export function usageUnits(usage: Usage): number {
  return Math.ceil(usage.overage / 1000);
}

export class LemonSqueezyBilling implements BillingProvider {
  readonly name = 'lemonsqueezy';
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly cfg: LemonSqueezyConfig) {
    if (!cfg.apiKey) throw new Error('LEMONSQUEEZY_API_KEY is required');
    if (!/^[a-z0-9-]+$/i.test(cfg.store)) throw new Error('LEMONSQUEEZY_STORE must be the store slug');
    this.fetchImpl = cfg.fetch ?? fetch;
    this.apiBase = cfg.apiBase ?? LEMONSQUEEZY_API;
  }

  async checkoutUrl(tier: Tier, keyId: string | null): Promise<string | null> {
    const variant = this.cfg.variants[tier as keyof VariantMap];
    if (!variant) return null;
    const url = new URL(`https://${this.cfg.store}.lemonsqueezy.com/checkout/buy/${variant}`);
    if (keyId !== null) url.searchParams.set('checkout[custom][key_id]', keyId);
    return url.toString();
  }

  pricingUrl(): string {
    return this.cfg.pricingUrl;
  }

  /**
   * Keys without a linked subscription (free tier, or a paid key minted by hand)
   * have nowhere to report to; that is not an error.
   */
  async reportUsage(keyId: string, usage: Usage): Promise<void> {
    const units = usageUnits(usage);
    if (units === 0) return;
    const sub = await this.cfg.subscriptions.forKey(keyId);
    if (!sub) return;
    const res = await this.fetchImpl(`${this.apiBase}/usage-records`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.api+json',
        'content-type': 'application/vnd.api+json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        data: {
          type: 'usage-records',
          attributes: { quantity: units, action: 'set' },
          relationships: { 'subscription-item': { data: { type: 'subscription-items', id: sub.subscriptionItemId } } },
        },
      }),
    });
    if (!res.ok) throw new Error(`lemonsqueezy usage-records ${res.status} for key ${keyId}`);
  }
}

// ---------------------------------------------------------------------------
// Webhooks

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifySignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  const a = enc.encode(expected);
  const b = enc.encode(signature.trim().toLowerCase());
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export type SubscriptionEventName =
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_resumed'
  | 'subscription_unpaused'
  | 'subscription_paused'
  | 'subscription_cancelled'
  | 'subscription_expired'
  | 'subscription_payment_success'
  | 'subscription_payment_failed'
  | 'subscription_payment_recovered';

export interface SubscriptionEvent {
  event: SubscriptionEventName;
  ref: SubscriptionRef;
}

const SUBSCRIPTION_EVENTS = new Set<string>([
  'subscription_created',
  'subscription_updated',
  'subscription_resumed',
  'subscription_unpaused',
  'subscription_paused',
  'subscription_cancelled',
  'subscription_expired',
  'subscription_payment_success',
  'subscription_payment_failed',
  'subscription_payment_recovered',
]);

/** Statuses under which the customer is entitled to the paid tier. */
const ENTITLED = new Set(['active', 'on_trial', 'past_due', 'cancelled', 'paused']);

/**
 * Pull what we need out of a webhook body. Returns null for events we do not
 * act on (orders, license keys) or subscriptions not started from our checkout
 * link (no `key_id` custom field) — those are acknowledged, not errors.
 */
export function parseSubscriptionEvent(body: unknown): SubscriptionEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { meta?: unknown; data?: unknown };
  const meta = b.meta as { event_name?: unknown; custom_data?: unknown } | undefined;
  const event = meta?.event_name;
  if (typeof event !== 'string' || !SUBSCRIPTION_EVENTS.has(event)) return null;
  const custom = meta?.custom_data as { key_id?: unknown } | undefined;
  const keyId = custom?.key_id;
  if (typeof keyId !== 'string' || keyId === '') return null;

  const data = b.data as { id?: unknown; attributes?: unknown } | undefined;
  const attrs = data?.attributes as { variant_id?: unknown; status?: unknown; first_subscription_item?: unknown } | undefined;
  const item = attrs?.first_subscription_item as { id?: unknown } | undefined | null;
  const subscriptionId = data?.id;
  const variantId = attrs?.variant_id;
  const status = attrs?.status;
  const itemId = item?.id;
  if (typeof subscriptionId !== 'string' || typeof status !== 'string') return null;
  if (typeof variantId !== 'number' && typeof variantId !== 'string') return null;
  if (typeof itemId !== 'number' && typeof itemId !== 'string') return null;
  return {
    event: event as SubscriptionEventName,
    ref: { keyId, subscriptionId, subscriptionItemId: String(itemId), variantId: String(variantId), status },
  };
}

export interface WebhookDeps {
  secret: string;
  variants: VariantMap;
  subscriptions: SubscriptionWriter;
  now?: () => Date;
}

export interface WebhookOutcome {
  status: number;
  body: { ok: boolean; action: 'ignored' | 'linked' | 'downgraded' | 'rejected'; tier?: Tier; reason?: string };
}

/**
 * Apply one webhook. Entitlement follows the subscription status, not the event
 * name: `cancelled` keeps access until the period ends (Lemon Squeezy then
 * sends `subscription_expired`), `expired` drops the key to free.
 */
export async function handleWebhook(request: Request, deps: WebhookDeps): Promise<WebhookOutcome> {
  if (request.method !== 'POST') return { status: 405, body: { ok: false, action: 'rejected', reason: 'method' } };
  const raw = await request.text();
  if (!(await verifySignature(raw, request.headers.get('x-signature'), deps.secret))) {
    return { status: 401, body: { ok: false, action: 'rejected', reason: 'signature' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: { ok: false, action: 'rejected', reason: 'json' } };
  }
  const ev = parseSubscriptionEvent(parsed);
  if (!ev) return { status: 200, body: { ok: true, action: 'ignored' } };

  const tier = tierForVariant(deps.variants, ev.ref.variantId);
  if (tier === null) return { status: 200, body: { ok: true, action: 'ignored', reason: `unknown variant ${ev.ref.variantId}` } };
  // Forged or mistyped custom data must not 5xx (the provider would retry forever).
  if (!(await deps.subscriptions.keyExists(ev.ref.keyId))) {
    return { status: 200, body: { ok: true, action: 'ignored', reason: 'unknown key' } };
  }

  const at = (deps.now ?? (() => new Date()))().toISOString();
  await deps.subscriptions.upsert(ev.ref, at);
  if (ENTITLED.has(ev.ref.status)) {
    await deps.subscriptions.setKeyTier(ev.ref.keyId, tier);
    return { status: 200, body: { ok: true, action: 'linked', tier } };
  }
  await deps.subscriptions.setKeyTier(ev.ref.keyId, 'free');
  return { status: 200, body: { ok: true, action: 'downgraded', tier: 'free' } };
}

export function webhookResponse(o: WebhookOutcome): Response {
  return new Response(JSON.stringify(o.body), {
    status: o.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------
// Storage (contract/billing.sql)

export interface SqlWriter {
  run(sql: string, params: readonly SqlValue[]): Promise<void>;
}

interface SubRow {
  key_id: string;
  subscription_id: string;
  subscription_item_id: string;
  variant_id: string;
  status: string;
}

export class SqlSubscriptions implements SubscriptionWriter {
  constructor(
    private readonly sql: SqlClient,
    private readonly writer: SqlWriter,
  ) {}

  async forKey(keyId: string): Promise<SubscriptionRef | null> {
    const r = await this.sql.first<SubRow>(
      'SELECT key_id, subscription_id, subscription_item_id, variant_id, status FROM billing_subscriptions WHERE key_id = ? AND provider = ?',
      [keyId, 'lemonsqueezy'],
    );
    return r
      ? { keyId: r.key_id, subscriptionId: r.subscription_id, subscriptionItemId: r.subscription_item_id, variantId: r.variant_id, status: r.status }
      : null;
  }

  async keyExists(keyId: string): Promise<boolean> {
    return (await this.sql.first<{ id: string }>('SELECT id FROM api_keys WHERE id = ?', [keyId])) !== null;
  }

  async upsert(ref: SubscriptionRef, updatedAt: string): Promise<void> {
    await this.writer.run(
      `INSERT INTO billing_subscriptions (key_id, provider, subscription_id, subscription_item_id, variant_id, status, updated_at)
       VALUES (?, 'lemonsqueezy', ?, ?, ?, ?, ?)
       ON CONFLICT(key_id, provider) DO UPDATE SET subscription_id = excluded.subscription_id,
         subscription_item_id = excluded.subscription_item_id, variant_id = excluded.variant_id,
         status = excluded.status, updated_at = excluded.updated_at`,
      [ref.keyId, ref.subscriptionId, ref.subscriptionItemId, ref.variantId, ref.status, updatedAt],
    );
  }

  async setKeyTier(keyId: string, tier: Tier): Promise<void> {
    await this.writer.run('UPDATE api_keys SET tier = ? WHERE id = ?', [tier, keyId]);
  }
}

export class MemorySubscriptions implements SubscriptionWriter {
  readonly refs = new Map<string, SubscriptionRef>();
  readonly tiers = new Map<string, Tier>();
  /** Known key ids; empty set means "every key exists" (unit tests that don't care). */
  readonly keys = new Set<string>();
  async forKey(keyId: string): Promise<SubscriptionRef | null> {
    return this.refs.get(keyId) ?? null;
  }
  async keyExists(keyId: string): Promise<boolean> {
    return this.keys.size === 0 || this.keys.has(keyId);
  }
  async upsert(ref: SubscriptionRef): Promise<void> {
    this.refs.set(ref.keyId, ref);
  }
  async setKeyTier(keyId: string, tier: Tier): Promise<void> {
    this.tiers.set(keyId, tier);
  }
}
