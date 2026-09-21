/** Cloudflare Worker entry. Everything testable lives in ./app.ts. */
import { createApp, type App } from './app.js';
import { WorkersResponseCache } from './cache.js';
import { ConsoleLogger } from './logging.js';
import { parseSourceConfig } from './registry.js';
import { D1Client, R2Reader } from './stores/cloudflare.js';
import { SqlRegistry } from './stores/sql-store.js';

export interface Env {
  DB: D1Database;
  PAYLOADS: R2Bucket;
  SOURCE_CONFIG?: string;
  PAYLOAD_PREFIX?: string;
}

// Stateless per request: the registry holds no connections and `waitUntil`
// belongs to this request's ExecutionContext.
function appFor(env: Env, ctx: ExecutionContext): App {
  return createApp({
    registry: new SqlRegistry(
      new D1Client(env.DB),
      new R2Reader(env.PAYLOADS),
      env.PAYLOAD_PREFIX ?? 'payloads/',
      parseSourceConfig(env.SOURCE_CONFIG),
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

export { createApp } from './app.js';
export * from './cache.js';
export * from './cursor.js';
export * from './logging.js';
export * from './problem.js';
export * from './registry.js';
export * from './stores/sql-store.js';
