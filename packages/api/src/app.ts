import {
  EngineError,
  NoCaptureError,
  asOf,
  diff,
  history,
  type AsOfResult,
  type Capture,
  type DiffResult,
  type JsonValue,
  type SnapshotStore,
} from '@archive-api/engine';

import { IMMUTABLE, NO_STORE, SHORT, cacheKey, type ResponseCache } from './cache.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, decodeCursor, pageOf, type DiffEntry } from './cursor.js';
import type { Logger, RequestLog } from './logging.js';
import { PROBLEM_CODE_HEADER, problem, type ProblemCode } from './problem.js';
import type { SourceRegistry } from './registry.js';

export const API_VERSION = '0.1.0';

export interface AppDeps {
  registry: SourceRegistry;
  cache: ResponseCache;
  logger: Logger;
  /** Defer work past the response (Workers `ctx.waitUntil`). Defaults to awaiting inline. */
  waitUntil?: (p: Promise<unknown>) => void;
  now?: () => Date;
}

export interface App {
  fetch(request: Request): Promise<Response>;
}

interface Ctx {
  url: URL;
  requestId: string;
  source: string | null;
  recordKey: string | null;
  endpoint: string;
}

interface Handled {
  response: Response;
  cacheable: boolean;
}

/** A store that can resolve many hashes at once (SqlStore); others fall back to hashOf. */
interface BatchHashStore extends SnapshotStore {
  hashesOf(snapshotId: number, keys: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

function hasBatchHashes(store: SnapshotStore): store is BatchHashStore {
  return typeof (store as Partial<BatchHashStore>).hashesOf === 'function';
}

export function createApp(deps: AppDeps): App {
  const now = deps.now ?? (() => new Date());

  async function handle(request: Request): Promise<Response> {
    const started = Date.now();
    const deferred: Promise<unknown>[] = [];
    const waitUntil = deps.waitUntil ?? ((p: Promise<unknown>) => void deferred.push(p));
    const url = new URL(request.url);
    const ctx: Ctx = {
      url,
      requestId: crypto.randomUUID(),
      source: null,
      recordKey: null,
      endpoint: url.pathname,
    };
    let cacheState: RequestLog['cache'] = 'bypass';
    let response: Response;
    try {
      const routed = route(url.pathname);
      if (routed) {
        ctx.source = routed.source;
        ctx.endpoint = routed.endpoint;
      }
      ctx.recordKey = url.searchParams.get('key');

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response = problem('method_not_allowed', 405, `${request.method} is not supported`, url.pathname);
        response.headers.set('allow', 'GET, HEAD');
      } else if (!routed) {
        response = problem('not_found', 404, `No such endpoint: ${url.pathname}`, url.pathname);
      } else if (routed.endpoint === 'health') {
        response = await health();
      } else {
        const key = cacheKey(url);
        const hit = await deps.cache.match(key);
        if (hit) {
          cacheState = 'hit';
          response = new Response(hit.body, hit);
        } else {
          cacheState = 'miss';
          const h = await dispatch(routed, ctx);
          response = h.response;
          if (h.cacheable && response.headers.get('cache-control') !== NO_STORE) {
            waitUntil(deps.cache.put(key, response.clone()));
          }
        }
        response.headers.set('x-cache', cacheState === 'hit' ? 'HIT' : 'MISS');
      }
    } catch (err) {
      response = internal(err, ctx);
    }
    response.headers.set('x-request-id', ctx.requestId);
    if (request.method === 'HEAD') response = new Response(null, response);
    deps.logger.log({
      ts: now().toISOString(),
      request_id: ctx.requestId,
      method: request.method,
      endpoint: ctx.endpoint,
      source: ctx.source,
      record_key: ctx.recordKey,
      status: response.status,
      latency_ms: Date.now() - started,
      cache: cacheState,
      tier: 'anonymous',
      key_prefix: null,
      problem: response.headers.get('content-type')?.startsWith('application/problem+json') ? problemCode(response) : null,
    });
    await Promise.all(deferred);
    return response;
  }

  async function health(): Promise<Response> {
    const sources = await deps.registry.list();
    return json({ status: 'ok', version: API_VERSION, sources: sources.length, time: now().toISOString() }, NO_STORE);
  }

  async function dispatch(r: Route, ctx: Ctx): Promise<Handled> {
    if (r.endpoint === 'sources') {
      const list = await deps.registry.list();
      return { response: json({ sources: list }, SHORT), cacheable: true };
    }
    const store = await deps.registry.get(r.source as string);
    if (!store) {
      return {
        response: problem('unknown_source', 404, `Source '${r.source}' is not configured`, ctx.url.pathname),
        cacheable: false,
      };
    }
    try {
      switch (r.endpoint) {
        case 'asof':
          return await handleAsOf(store, ctx);
        case 'diff':
          return await handleDiff(store, ctx);
        case 'history':
          return await handleHistory(store, ctx);
      }
    } catch (err) {
      if (err instanceof NoCaptureError) {
        return {
          response: problem('no_capture', 422, err.message, ctx.url.pathname, {
            date: err.date,
            nearest_before: err.nearestBefore,
            nearest_after: err.nearestAfter,
            rejected_on_date: err.rejectedOnDate,
          }),
          cacheable: false,
        };
      }
      if (err instanceof EngineError) {
        return { response: problem('invalid_parameter', 400, err.message, ctx.url.pathname, { code_detail: err.code }), cacheable: false };
      }
      throw err;
    }
    return { response: problem('not_found', 404, 'No such endpoint', ctx.url.pathname), cacheable: false };
  }

  async function handleAsOf(store: SnapshotStore, ctx: Ctx): Promise<Handled> {
    const key = required(ctx, 'key');
    const date = required(ctx, 'date');
    if (typeof key !== 'string') return { response: key, cacheable: false };
    if (typeof date !== 'string') return { response: date, cacheable: false };
    const result: AsOfResult = await asOf(store, key, date);
    const settled = await isSettled(store, date);
    return { response: json({ source: store.source.name, ...result }, settled ? IMMUTABLE : SHORT), cacheable: true };
  }

  async function handleHistory(store: SnapshotStore, ctx: Ctx): Promise<Handled> {
    const key = required(ctx, 'key');
    if (typeof key !== 'string') return { response: key, cacheable: false };
    const result = await history(store, key);
    // The spine grows with every capture; only ever cache briefly.
    return { response: json({ source: store.source.name, ...result }, SHORT), cacheable: true };
  }

  async function handleDiff(store: SnapshotStore, ctx: Ctx): Promise<Handled> {
    const from = required(ctx, 'from');
    const to = required(ctx, 'to');
    if (typeof from !== 'string') return { response: from, cacheable: false };
    if (typeof to !== 'string') return { response: to, cacheable: false };

    const limitRaw = ctx.url.searchParams.get('limit');
    let limit = DEFAULT_PAGE_SIZE;
    if (limitRaw !== null) {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_PAGE_SIZE) {
        return {
          response: problem('invalid_parameter', 400, `limit must be an integer in 1..${MAX_PAGE_SIZE}`, ctx.url.pathname, {
            parameter: 'limit',
          }),
          cacheable: false,
        };
      }
      limit = Number(limitRaw);
    }
    const cursorRaw = ctx.url.searchParams.get('cursor');
    const cursor = cursorRaw === null ? null : decodeCursor(cursorRaw);
    if (cursorRaw !== null && cursor === null) {
      return { response: problem('invalid_cursor', 400, 'cursor is not valid for this endpoint', ctx.url.pathname), cacheable: false };
    }
    const include = ctx.url.searchParams.get('include');
    if (include !== null && include !== 'payload') {
      return {
        response: problem('invalid_parameter', 400, "include must be 'payload' when present", ctx.url.pathname, { parameter: 'include' }),
        cacheable: false,
      };
    }

    const result: DiffResult = await diff(store, from, to);
    const page = pageOf(result, cursor, limit);
    await fillHashes(store, result, page.entries);
    const entries: Array<DiffEntry & { payload_before?: JsonValue | null; payload_after?: JsonValue | null }> = page.entries;
    if (include === 'payload') {
      for (const e of entries) {
        if (e.before !== null) e.payload_before = await store.payloadOf(result.from.snapshotId, e.key);
        if (e.after !== null) e.payload_after = await store.payloadOf(result.to.snapshotId, e.key);
      }
    }

    let nextUrl: string | null = null;
    if (page.nextCursor !== null) {
      const u = new URL(ctx.url.toString());
      u.searchParams.set('cursor', page.nextCursor);
      nextUrl = u.pathname + u.search;
    }
    const body = {
      source: store.source.name,
      from: result.from,
      to: result.to,
      provenance: result.provenance,
      summary: {
        added: result.added.length,
        removed: result.removed.length,
        mutated: result.mutated.length,
        aged_out: result.agedOut.length,
        unchanged: result.unchanged,
      },
      gaps: result.gaps,
      entries,
      next_cursor: page.nextCursor,
      next_url: nextUrl,
    };
    // Both endpoints are existing ok captures, so this answer is final.
    return { response: json(body, IMMUTABLE), cacheable: true };
  }

  async function fillHashes(store: SnapshotStore, result: DiffResult, entries: DiffEntry[]): Promise<void> {
    const needBefore = entries.filter((e) => e.category === 'removed' || e.category === 'aged_out');
    const needAfter = entries.filter((e) => e.category === 'added');
    const [before, after] = await Promise.all([
      lookup(store, result.from.snapshotId, needBefore.map((e) => e.key)),
      lookup(store, result.to.snapshotId, needAfter.map((e) => e.key)),
    ]);
    for (const e of needBefore) e.before = before.get(e.key) ?? null;
    for (const e of needAfter) e.after = after.get(e.key) ?? null;
  }

  async function lookup(store: SnapshotStore, snapshotId: number, keys: string[]): Promise<ReadonlyMap<string, string>> {
    if (keys.length === 0) return new Map();
    if (hasBatchHashes(store)) return store.hashesOf(snapshotId, keys);
    const pairs = await Promise.all(keys.map(async (k) => [k, await store.hashOf(snapshotId, k)] as const));
    return new Map(pairs.flatMap(([k, h]) => (h === null ? [] : [[k, h] as [string, string]])));
  }

  /** True when no future capture can change the answer for `date`: an ok capture on or after it exists. */
  async function isSettled(store: SnapshotStore, date: string): Promise<boolean> {
    const caps: readonly Capture[] = await store.captures();
    let last: string | null = null;
    for (const c of caps) if (c.outcome === 'ok') last = c.date;
    return last !== null && date <= last;
  }

  function required(ctx: Ctx, name: string): string | Response {
    const v = ctx.url.searchParams.get(name);
    if (v === null || v === '') {
      return problem('missing_parameter', 400, `Query parameter '${name}' is required`, ctx.url.pathname, { parameter: name });
    }
    return v;
  }

  function internal(err: unknown, ctx: Ctx): Response {
    console.error(JSON.stringify({ request_id: ctx.requestId, error: err instanceof Error ? err.message : String(err) }));
    return problem('internal', 500, 'The request could not be completed', ctx.url.pathname, { request_id: ctx.requestId });
  }

  return { fetch: handle };
}

type Endpoint = 'health' | 'sources' | 'asof' | 'diff' | 'history';
interface Route {
  endpoint: Endpoint;
  source: string | null;
}

export function route(pathname: string): Route | null {
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (p === '/health') return { endpoint: 'health', source: null };
  if (p === '/v1/sources') return { endpoint: 'sources', source: null };
  const m = /^\/v1\/([^/]+)\/(asof|diff|history)$/.exec(p);
  if (!m) return null;
  return { endpoint: m[2] as Endpoint, source: decodeURIComponent(m[1] as string) };
}

function json(body: unknown, cacheControl: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl },
  });
}

function problemCode(res: Response): ProblemCode | null {
  return res.headers.get(PROBLEM_CODE_HEADER) as ProblemCode | null;
}

