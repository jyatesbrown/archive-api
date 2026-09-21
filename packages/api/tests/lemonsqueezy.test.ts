import { describe, expect, it } from 'vitest';

import { isBillableBoundary } from '../src/auth/billing.js';
import {
  LemonSqueezyBilling,
  MemorySubscriptions,
  SqlSubscriptions,
  handleWebhook,
  parseSubscriptionEvent,
  parseVariantMap,
  tierForVariant,
  usageUnits,
  verifySignature,
  type SqlWriter,
} from '../src/auth/lemonsqueezy.js';
import { usageFor } from '../src/auth/meter.js';
import type { SqlClient, SqlValue } from '../src/stores/sql-store.js';

const VARIANTS = { indie: '111', team: '222', bulk: '333' } as const;
const SECRET = 'whsec_test';

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function event(name: string, over: Record<string, unknown> = {}, custom: Record<string, unknown> | null = { key_id: 'k1' }) {
  return {
    meta: { event_name: name, ...(custom ? { custom_data: custom } : {}) },
    data: {
      type: 'subscriptions',
      id: '9001',
      attributes: { variant_id: 222, status: 'active', first_subscription_item: { id: 5150, quantity: 1 }, ...over },
    },
  };
}

async function post(body: unknown, sig?: string): Promise<Request> {
  const raw = JSON.stringify(body);
  return new Request('https://api.test/billing/lemonsqueezy/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': sig ?? (await sign(raw)) },
    body: raw,
  });
}

describe('parseVariantMap / tierForVariant', () => {
  it('accepts paid tiers with numeric ids and maps back', () => {
    const m = parseVariantMap(JSON.stringify(VARIANTS));
    expect(m).toEqual(VARIANTS);
    expect(tierForVariant(m, '222')).toBe('team');
    expect(tierForVariant(m, '999')).toBeNull();
    expect(parseVariantMap(undefined)).toEqual({});
  });
  it('rejects free/anonymous tiers, non-numeric ids and bad JSON', () => {
    expect(() => parseVariantMap('{"free":"1"}')).toThrow(/not a paid tier/);
    expect(() => parseVariantMap('{"indie":"abc"}')).toThrow(/numeric/);
    expect(() => parseVariantMap('[1]')).toThrow(/object/);
    expect(() => parseVariantMap('{')).toThrow(/valid JSON/);
  });
});

describe('LemonSqueezyBilling', () => {
  const subs = new MemorySubscriptions();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{}', { status: 201 });
  }) as typeof fetch;
  const billing = new LemonSqueezyBilling({
    apiKey: 'lsk',
    store: 'archive-api',
    variants: VARIANTS,
    pricingUrl: 'https://archive-api.dev/pricing',
    subscriptions: subs,
    fetch: fetchImpl,
  });

  it('builds a static checkout link carrying the key id, null for unconfigured tiers', async () => {
    expect(await billing.checkoutUrl('team', 'k1')).toBe(
      'https://archive-api.lemonsqueezy.com/checkout/buy/222?checkout%5Bcustom%5D%5Bkey_id%5D=k1',
    );
    expect(await billing.checkoutUrl('indie', null)).toBe('https://archive-api.lemonsqueezy.com/checkout/buy/111');
    expect(await billing.checkoutUrl('free', 'k1')).toBeNull();
    expect(billing.pricingUrl()).toBe('https://archive-api.dev/pricing');
    expect(billing.name).toBe('lemonsqueezy');
  });

  it('rejects an unusable configuration', () => {
    const base = { variants: VARIANTS, pricingUrl: 'p', subscriptions: subs };
    expect(() => new LemonSqueezyBilling({ ...base, apiKey: '', store: 'x' })).toThrow(/API_KEY/);
    expect(() => new LemonSqueezyBilling({ ...base, apiKey: 'k', store: 'bad slug!' })).toThrow(/slug/);
  });

  it('reports overage as SET quantity in 1,000-call units against the subscription item', async () => {
    await subs.upsert({ keyId: 'k1', subscriptionId: '9001', subscriptionItemId: '5150', variantId: '222', status: 'active' });
    const u = usageFor('team', '2026-09', 250_001); // first call past 250k
    expect(isBillableBoundary(u)).toBe(true);
    expect(usageUnits(u)).toBe(1);
    await billing.reportUsage('k1', u);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://api.lemonsqueezy.com/v1/usage-records');
    expect(new Headers(c.init.headers).get('authorization')).toBe('Bearer lsk');
    expect(JSON.parse(c.init.body as string)).toEqual({
      data: {
        type: 'usage-records',
        attributes: { quantity: 1, action: 'set' },
        relationships: { 'subscription-item': { data: { type: 'subscription-items', id: '5150' } } },
      },
    });
    await billing.reportUsage('k1', usageFor('team', '2026-09', 253_000));
    expect(JSON.parse(calls[1]!.init.body as string).data.attributes.quantity).toBe(3);
  });

  it('is silent for keys with no subscription or no overage', async () => {
    const before = calls.length;
    await billing.reportUsage('nobody', usageFor('indie', '2026-09', 30_000));
    await billing.reportUsage('k1', usageFor('team', '2026-09', 10));
    await billing.reportUsage('k1', usageFor('bulk', '2026-09', 10_000_000));
    expect(calls.length).toBe(before);
  });

  it('surfaces provider errors', async () => {
    const failing = new LemonSqueezyBilling({
      apiKey: 'lsk',
      store: 'archive-api',
      variants: VARIANTS,
      pricingUrl: 'p',
      subscriptions: subs,
      fetch: (async () => new Response('nope', { status: 422 })) as typeof fetch,
    });
    await expect(failing.reportUsage('k1', usageFor('team', '2026-09', 250_001))).rejects.toThrow(/422/);
  });
});

describe('verifySignature', () => {
  it('matches the HMAC-SHA256 hex digest and nothing else', async () => {
    const body = '{"a":1}';
    const sig = await sign(body);
    expect(await verifySignature(body, sig, SECRET)).toBe(true);
    expect(await verifySignature(body, sig.toUpperCase(), SECRET)).toBe(true);
    expect(await verifySignature(body, await sign(body, 'other'), SECRET)).toBe(false);
    expect(await verifySignature(body + ' ', sig, SECRET)).toBe(false);
    expect(await verifySignature(body, null, SECRET)).toBe(false);
    expect(await verifySignature(body, sig, '')).toBe(false);
    expect(await verifySignature(body, 'abc', SECRET)).toBe(false);
  });
});

describe('parseSubscriptionEvent', () => {
  it('extracts the ref from subscription events with our custom key_id', () => {
    expect(parseSubscriptionEvent(event('subscription_created'))).toEqual({
      event: 'subscription_created',
      ref: { keyId: 'k1', subscriptionId: '9001', subscriptionItemId: '5150', variantId: '222', status: 'active' },
    });
  });
  it('ignores non-subscription events, foreign subscriptions and malformed bodies', () => {
    expect(parseSubscriptionEvent(event('order_created'))).toBeNull();
    expect(parseSubscriptionEvent(event('subscription_created', {}, null))).toBeNull();
    expect(parseSubscriptionEvent(event('subscription_created', {}, { key_id: '' }))).toBeNull();
    expect(parseSubscriptionEvent(event('subscription_created', { first_subscription_item: null }))).toBeNull();
    expect(parseSubscriptionEvent(event('subscription_created', { status: 7 }))).toBeNull();
    expect(parseSubscriptionEvent(null)).toBeNull();
    expect(parseSubscriptionEvent('x')).toBeNull();
  });
});

describe('handleWebhook', () => {
  const deps = () => ({ secret: SECRET, variants: VARIANTS, subscriptions: new MemorySubscriptions(), now: () => new Date('2026-09-21T00:00:00Z') });

  it('rejects non-POST, bad signatures and bad JSON', async () => {
    const d = deps();
    expect((await handleWebhook(new Request('https://x/w'), d)).status).toBe(405);
    const bad = await handleWebhook(await post(event('subscription_created'), 'deadbeef'), d);
    expect(bad).toEqual({ status: 401, body: { ok: false, action: 'rejected', reason: 'signature' } });
    const raw = '{not json';
    const r = new Request('https://x/w', { method: 'POST', headers: { 'x-signature': await sign(raw) }, body: raw });
    expect((await handleWebhook(r, d)).status).toBe(400);
    expect(d.subscriptions.refs.size).toBe(0);
  });

  it('links the subscription and lifts the key to the variant tier', async () => {
    const d = deps();
    const out = await handleWebhook(await post(event('subscription_created')), d);
    expect(out).toEqual({ status: 200, body: { ok: true, action: 'linked', tier: 'team' } });
    expect(d.subscriptions.refs.get('k1')).toEqual({ keyId: 'k1', subscriptionId: '9001', subscriptionItemId: '5150', variantId: '222', status: 'active' });
    expect(d.subscriptions.tiers.get('k1')).toBe('team');
  });

  it('keeps access while cancelled or past_due, drops to free on expired', async () => {
    const d = deps();
    await handleWebhook(await post(event('subscription_created')), d);
    let out = await handleWebhook(await post(event('subscription_cancelled', { status: 'cancelled' })), d);
    expect(out.body).toEqual({ ok: true, action: 'linked', tier: 'team' });
    out = await handleWebhook(await post(event('subscription_payment_failed', { status: 'past_due' })), d);
    expect(out.body.action).toBe('linked');
    out = await handleWebhook(await post(event('subscription_expired', { status: 'expired' })), d);
    expect(out.body).toEqual({ ok: true, action: 'downgraded', tier: 'free' });
    expect(d.subscriptions.tiers.get('k1')).toBe('free');
    expect(d.subscriptions.refs.get('k1')?.status).toBe('expired');
  });

  it('acknowledges but ignores events it cannot act on', async () => {
    const d = deps();
    expect((await handleWebhook(await post(event('order_created')), d)).body).toEqual({ ok: true, action: 'ignored' });
    expect((await handleWebhook(await post(event('subscription_created', { variant_id: 999 })), d)).body).toEqual({
      ok: true,
      action: 'ignored',
      reason: 'unknown variant 999',
    });
    expect(d.subscriptions.refs.size).toBe(0);
  });

  it('acknowledges a key_id that does not exist without writing anything', async () => {
    const d = deps();
    d.subscriptions.keys.add('someone-else');
    const out = await handleWebhook(await post(event('subscription_created')), d);
    expect(out).toEqual({ status: 200, body: { ok: true, action: 'ignored', reason: 'unknown key' } });
    expect(d.subscriptions.refs.size).toBe(0);
    expect(d.subscriptions.tiers.size).toBe(0);
  });
});

describe('SqlSubscriptions', () => {
  it('issues the expected upsert / select / tier update statements', async () => {
    const rows = new Map<string, Record<string, SqlValue>>();
    const runs: Array<{ sql: string; params: readonly SqlValue[] }> = [];
    const writer: SqlWriter = {
      async run(sql, params) {
        runs.push({ sql, params });
        if (sql.includes('INTO billing_subscriptions')) {
          const [key_id, subscription_id, subscription_item_id, variant_id, status] = params;
          rows.set(String(key_id), { key_id, subscription_id, subscription_item_id, variant_id, status } as Record<string, SqlValue>);
        }
      },
    };
    const reader: SqlClient = {
      async all() {
        return [];
      },
      async first<T>(sql: string, params: readonly SqlValue[]) {
        if (sql.startsWith('SELECT id FROM api_keys')) return (params[0] === 'k1' ? { id: 'k1' } : null) as T | null;
        return (rows.get(String(params[0])) as T | undefined) ?? null;
      },
    };
    const s = new SqlSubscriptions(reader, writer);
    expect(await s.forKey('k1')).toBeNull();
    expect(await s.keyExists('k1')).toBe(true);
    expect(await s.keyExists('k2')).toBe(false);
    await s.upsert({ keyId: 'k1', subscriptionId: '9001', subscriptionItemId: '5150', variantId: '222', status: 'active' }, 't0');
    expect(await s.forKey('k1')).toEqual({ keyId: 'k1', subscriptionId: '9001', subscriptionItemId: '5150', variantId: '222', status: 'active' });
    await s.setKeyTier('k1', 'team');
    expect(runs[0]!.sql).toMatch(/ON CONFLICT\(key_id, provider\) DO UPDATE/);
    expect(runs[1]).toEqual({ sql: 'UPDATE api_keys SET tier = ? WHERE id = ?', params: ['team', 'k1'] });
  });
});
