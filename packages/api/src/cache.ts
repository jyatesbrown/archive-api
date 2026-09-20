/**
 * Response caching. The key is the normalised request URL (source, endpoint
 * and sorted query parameters) — never the caller's identity, so every
 * customer shares one cache entry for the same historical question.
 */

export interface ResponseCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** Deterministic cache key: path + query with sorted parameter names. */
export function cacheKey(url: URL): string {
  const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = new URLSearchParams(params).toString();
  return `${url.origin}${url.pathname}${qs ? `?${qs}` : ''}`;
}

/** Forever: the answer is a function of captures that already exist and can never change. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Answers that new captures could change (open-ended ranges, listings). */
export const SHORT = 'public, max-age=60';
export const NO_STORE = 'no-store';

export class MemoryResponseCache implements ResponseCache {
  private readonly map = new Map<string, { body: string; status: number; headers: [string, string][] }>();
  puts = 0;

  async match(key: string): Promise<Response | undefined> {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    return new Response(hit.body, { status: hit.status, headers: hit.headers });
  }

  /** Like the Cache API, refuses `no-store` responses. */
  async put(key: string, response: Response): Promise<void> {
    if (response.headers.get('cache-control')?.includes('no-store')) return;
    this.puts++;
    this.map.set(key, {
      body: await response.text(),
      status: response.status,
      headers: [...response.headers.entries()],
    });
  }

  get size(): number {
    return this.map.size;
  }
}

/** Adapter over the Workers Cache API (`caches.default`). */
export class WorkersResponseCache implements ResponseCache {
  constructor(private readonly cache: Cache) {}
  async match(key: string): Promise<Response | undefined> {
    return this.cache.match(new Request(key));
  }
  async put(key: string, response: Response): Promise<void> {
    await this.cache.put(new Request(key), response);
  }
}
