/** Cloudflare Worker entry. Everything testable lives in ./app.ts. */
import { createApp, type App } from './app.js';
import { NoopBilling, type BillingProvider } from './auth/billing.js';
import { SqlKeyStore } from './auth/keys.js';
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
  /** `noop` today; a merchant-of-record adapter selects itself here once it exists. */
  BILLING_PROVIDER?: string;
}

function billingFor(env: Env): BillingProvider {
  const provider = env.BILLING_PROVIDER ?? 'noop';
  if (provider !== 'noop') throw new Error(`BILLING_PROVIDER '${provider}' is not implemented`);
  return new NoopBilling(env.PRICING_URL);
}

// Stateless per request: the registry holds no connections and `waitUntil`
// belongs to this request's ExecutionContext.
function appFor(env: Env, ctx: ExecutionContext): App {
  const db = new D1Client(env.DB);
  const config = parseSourceConfig(env.SOURCE_CONFIG);
  return createApp({
    openSources: openSources(config),
    auth: { keys: new SqlKeyStore(db), meter: new DurableObjectMeter(env.METER), billing: billingFor(env) },
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
    return appFor(env, ctx).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export { MonthlyCounter } from './stores/cloudflare.js';
