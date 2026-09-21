/** Cloudflare Worker entry. Everything testable lives in ./app.ts. */
import { createApp, type App } from './app.js';
import { DEFAULT_PRICING_URL, NoopBilling, type BillingProvider } from './auth/billing.js';
import { SqlKeyStore } from './auth/keys.js';
import { LemonSqueezyBilling, SqlSubscriptions, handleWebhook, parseVariantMap, webhookResponse } from './auth/lemonsqueezy.js';
import { WorkersResponseCache } from './cache.js';
import { ConsoleLogger } from './logging.js';
import { openSources, parseSourceConfig } from './registry.js';
import { D1Client, DurableObjectMeter, R2Reader } from './stores/cloudflare.js';
import { SqlRegistry } from './stores/sql-store.js';

export interface Env {
  DB: D1Database;
  PAYLOADS: R2Bucket;
  METER: DurableObjectNamespace;
  SOURCE_CONFIG?: string;
  PAYLOAD_PREFIX?: string;
  PRICING_URL?: string;
  /** `noop` | `lemonsqueezy`. */
  BILLING_PROVIDER?: string;
  /** Store slug (`<slug>.lemonsqueezy.com`) and JSON `{ indie: "<variant id>", team: ..., bulk: ... }`. */
  LEMONSQUEEZY_STORE?: string;
  LEMONSQUEEZY_VARIANTS?: string;
  /** Secrets (`wrangler secret put`). */
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
}

// Not exported: workerd requires every export of `main` to be a handler.
const WEBHOOK_PATH = '/billing/lemonsqueezy/webhook';

function billingFor(env: Env, db: D1Client): BillingProvider {
  const provider = env.BILLING_PROVIDER ?? 'noop';
  if (provider === 'noop') return new NoopBilling(env.PRICING_URL);
  if (provider === 'lemonsqueezy') {
    return new LemonSqueezyBilling({
      apiKey: env.LEMONSQUEEZY_API_KEY ?? '',
      store: env.LEMONSQUEEZY_STORE ?? '',
      variants: parseVariantMap(env.LEMONSQUEEZY_VARIANTS),
      pricingUrl: env.PRICING_URL ?? DEFAULT_PRICING_URL,
      subscriptions: new SqlSubscriptions(db, db),
    });
  }
  throw new Error(`BILLING_PROVIDER '${provider}' is not implemented`);
}

/** The one write path in the Worker: provider webhooks moving keys between tiers. */
async function webhook(request: Request, env: Env): Promise<Response> {
  if (env.BILLING_PROVIDER !== 'lemonsqueezy') return new Response(null, { status: 404 });
  const db = new D1Client(env.DB);
  const outcome = await handleWebhook(request, {
    secret: env.LEMONSQUEEZY_WEBHOOK_SECRET ?? '',
    variants: parseVariantMap(env.LEMONSQUEEZY_VARIANTS),
    subscriptions: new SqlSubscriptions(db, db),
  });
  return webhookResponse(outcome);
}

// Stateless per request: the registry holds no connections and `waitUntil`
// belongs to this request's ExecutionContext.
function appFor(env: Env, ctx: ExecutionContext): App {
  const db = new D1Client(env.DB);
  const config = parseSourceConfig(env.SOURCE_CONFIG);
  return createApp({
    openSources: openSources(config),
    auth: { keys: new SqlKeyStore(db), meter: new DurableObjectMeter(env.METER), billing: billingFor(env, db) },
    registry: new SqlRegistry(
      db,
      new R2Reader(env.PAYLOADS),
      env.PAYLOAD_PREFIX ?? 'payloads/',
      config,
    ),
    cache: new WorkersResponseCache(caches.default),
    logger: new ConsoleLogger(),
    waitUntil: (p) => ctx.waitUntil(p),
  });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === WEBHOOK_PATH) return webhook(request, env);
    return appFor(env, ctx).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export { MonthlyCounter } from './stores/cloudflare.js';
