/** Route/contract tests against a small hand-built source (see helpers.memoryApp). */
import { describe, expect, it } from 'vitest';

import { API_VERSION, route } from '../src/app.js';
import { IMMUTABLE, NO_STORE, SHORT } from '../src/cache.js';
import { decodeCursor, encodeCursor } from '../src/cursor.js';
import { StaticRegistry } from '../src/registry.js';
import { appFor, body, memoryApp } from './helpers.js';

const PROBLEM = 'application/problem+json; charset=utf-8';

describe('routing', () => {
  it('recognises the five endpoints, tolerating a trailing slash and encoded source names', () => {
    expect(route('/health')).toEqual({ endpoint: 'health', source: null });
    expect(route('/v1/sources/')).toEqual({ endpoint: 'sources', source: null });
    expect(route('/v1/mini/asof')).toEqual({ endpoint: 'asof', source: 'mini' });
    expect(route('/v1/my%20src/diff')).toEqual({ endpoint: 'diff', source: 'my src' });
    expect(route('/v1/mini/history/')).toEqual({ endpoint: 'history', source: 'mini' });
    expect(route('/')).toBeNull();
    expect(route('/v1/mini')).toBeNull();
    expect(route('/v1/mini/asof/extra')).toBeNull();
    expect(route('/v2/mini/asof')).toBeNull();
  });
  it('404s unknown paths as problem+json', async () => {
    const t = memoryApp();
    const res = await t.get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe(PROBLEM);
    expect(await body(res)).toMatchObject({ code: 'not_found', status: 404, instance: '/nope' });
  });
  it('405s non-GET methods with an Allow header', async () => {
    const t = memoryApp();
    const res = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(await body(res)).toMatchObject({ code: 'method_not_allowed' });
  });
  it('HEAD returns headers only', async () => {
    const t = memoryApp();
    const res = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
  });
  it('every response carries x-request-id', async () => {
    const t = memoryApp();
    for (const p of ['/health', '/v1/sources', '/nope', '/v1/mini/asof?key=A&date=2025-01-01']) {
      const res = await t.get(p);
      expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('GET /health', () => {
  it('reports ok, version and source count, uncached', async () => {
    const t = memoryApp();
    const res = await t.get('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(res.headers.get('x-cache')).toBeNull();
    expect(await body(res)).toMatchObject({ status: 'ok', version: API_VERSION, sources: 1 });
  });
});

describe('GET /v1/sources', () => {
  it('lists configured sources with capture bounds and counts', async () => {
    const t = memoryApp();
    const res = await t.get('/v1/sources');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(SHORT);
    expect(await body(res)).toEqual({
      sources: [
        {
          id: 7,
          name: 'mini',
          upstreamUrl: 'https://upstream.test/mini.json',
          windowDays: null,
          captures: 4,
          okCaptures: 3,
          firstCapture: '2025-01-01',
          lastCapture: '2025-01-05',
        },
      ],
    });
  });
  it('unknown source is a 404 problem on every query endpoint', async () => {
    const t = memoryApp();
    for (const p of ['/v1/ghost/asof?key=A&date=2025-01-01', '/v1/ghost/diff?from=2025-01-01&to=2025-01-02', '/v1/ghost/history?key=A']) {
      const res = await t.get(p);
      expect(res.status).toBe(404);
      expect(await body(res)).toMatchObject({ code: 'unknown_source', detail: expect.stringContaining('ghost') });
    }
  });
});

describe('GET /v1/{source}/asof', () => {
  it('exact hit: payload, hash, and provenance naming source, upstream, capture time, sha and chain position', async () => {
    const t = memoryApp();
    const res = await t.get('/v1/mini/asof?key=B&date=2025-01-02');
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b).toMatchObject({
      source: 'mini',
      key: 'B',
      date: '2025-01-02',
      resolution: 'exact',
      valueHash: 'b2',
      payload: { entity: 'Beta', v: 2 },
    });
    expect(b['provenance']).toMatchObject({
      source: { id: 7, name: 'mini', upstreamUrl: 'https://upstream.test/mini.json' },
      captures: [{ snapshotId: 2, fetchedAt: '2025-01-02T06:00:00Z', contentHash: 'c2', prevHash: 'c1', chainIndex: 1 }],
    });
  });
  it('absent and unknown_gap are explicit, never a nearest-neighbour guess', async () => {
    const t = memoryApp();
    const absent = await body(await t.get('/v1/mini/asof?key=C&date=2025-01-02'));
    expect(absent).toMatchObject({ resolution: 'absent' });
    expect(absent).not.toHaveProperty('payload');
    const gap = await body(await t.get('/v1/mini/asof?key=B&date=2025-01-04'));
    expect(gap).toMatchObject({ resolution: 'unknown_gap', reason: 'state_changed_across_gap', hashBefore: 'b2', hashAfter: null });
    const cf = await body(await t.get('/v1/mini/asof?key=A&date=2025-01-04'));
    expect(cf).toMatchObject({ resolution: 'carried_forward', valueHash: 'a1' });
  });
  it('surfaces rejected captures on the requested date', async () => {
    const t = memoryApp();
    const b = await body<{ rejectedOnDate: Array<{ snapshotId: number; outcome: string }> }>(await t.get('/v1/mini/asof?key=A&date=2025-01-03'));
    expect(b.rejectedOnDate).toEqual([expect.objectContaining({ snapshotId: 3, outcome: 'validation_failed' })]);
  });
  it('400s a missing key or date, and a malformed date', async () => {
    const t = memoryApp();
    expect(await body(await t.get('/v1/mini/asof?date=2025-01-01'))).toMatchObject({ code: 'missing_parameter', parameter: 'key', status: 400 });
    expect(await body(await t.get('/v1/mini/asof?key=A'))).toMatchObject({ code: 'missing_parameter', parameter: 'date' });
    const bad = await t.get('/v1/mini/asof?key=A&date=2025-13-40');
    expect(bad.status).toBe(400);
    expect(await body(bad)).toMatchObject({ code: 'invalid_parameter', code_detail: 'invalid_date' });
  });
  it('is immutable up to the last capture and short-lived beyond it', async () => {
    const t = memoryApp();
    expect((await t.get('/v1/mini/asof?key=A&date=2024-06-01')).headers.get('cache-control')).toBe(IMMUTABLE);
    expect((await t.get('/v1/mini/asof?key=A&date=2025-01-05')).headers.get('cache-control')).toBe(IMMUTABLE);
    expect((await t.get('/v1/mini/asof?key=A&date=2025-01-06')).headers.get('cache-control')).toBe(SHORT);
  });
});

describe('GET /v1/{source}/history', () => {
  it('returns the full spine with provenance and short caching', async () => {
    const t = memoryApp();
    const res = await t.get('/v1/mini/history?key=B');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(SHORT);
    const b = await body<{ transitions: Array<{ kind: string }>; status: string; provenance: { captures: unknown[] } }>(res);
    expect(b.transitions.map((x) => x.kind)).toEqual(['appeared', 'mutated', 'removed']);
    expect(b.status).toBe('absent');
    expect(b.provenance.captures.length).toBeGreaterThan(0);
  });
  it('never-seen keys are a 200 with status never_seen, not a 404', async () => {
    const t = memoryApp();
    const res = await t.get('/v1/mini/history?key=ZZZ');
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ status: 'never_seen', firstSeen: null, transitions: [] });
  });
  it('400s without a key', async () => {
    const t = memoryApp();
    expect(await body(await t.get('/v1/mini/history'))).toMatchObject({ code: 'missing_parameter', parameter: 'key' });
  });
});

describe('GET /v1/{source}/diff', () => {
  it('returns summary, sorted entries with hashes for every category, endpoint provenance and gaps', async () => {
    const t = memoryApp();
    const res = await t.get('/v1/mini/diff?from=2025-01-02&to=2025-01-05');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    const b = await body(res);
    expect(b).toMatchObject({
      source: 'mini',
      from: { snapshotId: 2, date: '2025-01-02' },
      to: { snapshotId: 4, date: '2025-01-05' },
      summary: { added: 2, removed: 1, mutated: 0, aged_out: 0, unchanged: 1 },
      entries: [
        { category: 'added', key: 'C', before: null, after: 'c1' },
        { category: 'added', key: 'D', before: null, after: 'd1' },
        { category: 'removed', key: 'B', before: 'b2', after: null },
      ],
      next_cursor: null,
      next_url: null,
    });
    expect(b['gaps']).toEqual([expect.objectContaining({ from: '2025-01-03', to: '2025-01-04' })]);
    expect(b['provenance']).toMatchObject({ captures: [{ snapshotId: 2 }, { snapshotId: 4 }] });
  });
  it('mutations carry before/after hashes', async () => {
    const t = memoryApp();
    const b = await body(await t.get('/v1/mini/diff?from=2025-01-01&to=2025-01-02'));
    expect(b['entries']).toEqual([{ category: 'mutated', key: 'B', before: 'b1', after: 'b2' }]);
  });
  it('paginates with an opaque cursor and a ready-to-follow next_url; no offsets anywhere', async () => {
    const t = memoryApp();
    const p1 = await body<{ entries: Array<{ key: string }>; next_cursor: string; next_url: string }>(
      await t.get('/v1/mini/diff?from=2025-01-02&to=2025-01-05&limit=2'),
    );
    expect(p1.entries.map((e) => e.key)).toEqual(['C', 'D']);
    expect(decodeCursor(p1.next_cursor)).toEqual({ c: 'removed', k: '' });
    expect(p1.next_url).toBe(`/v1/mini/diff?from=2025-01-02&to=2025-01-05&limit=2&cursor=${p1.next_cursor}`);
    expect(p1.next_url).not.toMatch(/offset|page=/);
    const p2 = await body<{ entries: Array<{ key: string }>; next_cursor: null }>(await t.get(p1.next_url));
    expect(p2.entries.map((e) => e.key)).toEqual(['B']);
    expect(p2.next_cursor).toBeNull();
  });
  it('a cursor for a later category skips earlier ones', async () => {
    const t = memoryApp();
    const c = encodeCursor({ c: 'removed', k: '' });
    const b = await body<{ entries: Array<{ key: string }> }>(await t.get(`/v1/mini/diff?from=2025-01-02&to=2025-01-05&cursor=${c}`));
    expect(b.entries.map((e) => e.key)).toEqual(['B']);
  });
  it('include=payload inlines before/after payloads from the raw snapshots', async () => {
    const t = memoryApp();
    const b = await body<{ entries: Array<Record<string, unknown>> }>(await t.get('/v1/mini/diff?from=2025-01-01&to=2025-01-05&include=payload'));
    expect(b.entries).toEqual([
      { category: 'added', key: 'C', before: null, after: 'c1', payload_after: { entity: 'Gamma', v: 1 } },
      { category: 'added', key: 'D', before: null, after: 'd1', payload_after: { entity: 'Delta', v: 1 } },
      { category: 'removed', key: 'B', before: 'b1', after: null, payload_before: { entity: 'Beta', v: 1 } },
    ]);
  });
  it('rejects bad limit, bad cursor and bad include with distinct problem codes', async () => {
    const t = memoryApp();
    const q = '/v1/mini/diff?from=2025-01-01&to=2025-01-02';
    expect(await body(await t.get(`${q}&limit=0`))).toMatchObject({ code: 'invalid_parameter', parameter: 'limit' });
    expect(await body(await t.get(`${q}&limit=1001`))).toMatchObject({ code: 'invalid_parameter', parameter: 'limit' });
    expect(await body(await t.get(`${q}&limit=abc`))).toMatchObject({ code: 'invalid_parameter', parameter: 'limit' });
    expect(await body(await t.get(`${q}&cursor=%%%`))).toMatchObject({ code: 'invalid_cursor', status: 400 });
    expect(await body(await t.get(`${q}&cursor=${btoa('{"offset":10}')}`))).toMatchObject({ code: 'invalid_cursor' });
    expect(await body(await t.get(`${q}&include=everything`))).toMatchObject({ code: 'invalid_parameter', parameter: 'include' });
  });
  it('400s a reversed range and missing endpoints', async () => {
    const t = memoryApp();
    expect(await body(await t.get('/v1/mini/diff?from=2025-01-02&to=2025-01-01'))).toMatchObject({ code: 'invalid_parameter', code_detail: 'invalid_range' });
    expect(await body(await t.get('/v1/mini/diff?to=2025-01-01'))).toMatchObject({ code: 'missing_parameter', parameter: 'from' });
    expect(await body(await t.get('/v1/mini/diff?from=2025-01-01'))).toMatchObject({ code: 'missing_parameter', parameter: 'to' });
  });
  it('422 no_capture names the nearest ok captures and any rejected capture on the day', async () => {
    const t = memoryApp();
    const res = await t.get('/v1/mini/diff?from=2025-01-03&to=2025-01-05');
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toBe(PROBLEM);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    const b = await body(res);
    expect(b).toMatchObject({
      code: 'no_capture',
      date: '2025-01-03',
      nearest_before: expect.objectContaining({ date: '2025-01-02' }),
      nearest_after: expect.objectContaining({ date: '2025-01-05' }),
      rejected_on_date: [expect.objectContaining({ snapshotId: 3, outcome: 'validation_failed' })],
    });
    const none = await body(await t.get('/v1/mini/diff?from=2025-01-04&to=2025-01-05'));
    expect(none).toMatchObject({ code: 'no_capture', rejected_on_date: [] });
  });
});

describe('response cache', () => {
  it('misses then hits on the same question, regardless of parameter order', async () => {
    const t = memoryApp();
    const a = await t.get('/v1/mini/asof?key=A&date=2025-01-01');
    expect(a.headers.get('x-cache')).toBe('MISS');
    const b = await t.get('/v1/mini/asof?date=2025-01-01&key=A');
    expect(b.headers.get('x-cache')).toBe('HIT');
    expect(await b.json()).toEqual(await a.json());
    expect(t.cache.size).toBe(1);
  });
  it('a different parameter is a different entry', async () => {
    const t = memoryApp();
    await t.get('/v1/mini/asof?key=A&date=2025-01-01');
    expect((await t.get('/v1/mini/asof?key=B&date=2025-01-01')).headers.get('x-cache')).toBe('MISS');
    expect(t.cache.size).toBe(2);
  });
  it('never stores problems', async () => {
    const t = memoryApp();
    await t.get('/v1/mini/asof?key=A');
    await t.get('/v1/mini/diff?from=2025-01-04&to=2025-01-05');
    await t.get('/v1/ghost/history?key=A');
    expect(t.cache.size).toBe(0);
    expect((await t.get('/v1/mini/asof?key=A')).headers.get('x-cache')).toBe('MISS');
  });
  it('/health bypasses the cache', async () => {
    const t = memoryApp();
    await t.get('/health');
    await t.get('/health');
    expect(t.cache.size).toBe(0);
  });
});

describe('structured request log', () => {
  it('records endpoint, source, key, status, latency, tier and cache state', async () => {
    const t = memoryApp();
    await t.get('/v1/mini/asof?key=A&date=2025-01-01');
    await t.get('/v1/mini/asof?key=A&date=2025-01-01');
    expect(t.logger.entries).toHaveLength(2);
    expect(t.logger.entries[0]).toMatchObject({
      method: 'GET',
      endpoint: 'asof',
      source: 'mini',
      record_key: 'A',
      status: 200,
      cache: 'miss',
      tier: 'team',
      key_prefix: 'ak_test_teamteam',
      problem: null,
    });
    expect(t.logger.entries[1]).toMatchObject({ cache: 'hit' });
    expect(typeof t.logger.entries[0]?.latency_ms).toBe('number');
    expect(t.logger.entries[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('names the problem code on errors and uses bypass for uncached routes', async () => {
    const t = memoryApp();
    await t.get('/v1/mini/asof?key=A&date=nope');
    await t.get('/health');
    await t.get('/nope', { method: 'DELETE' });
    expect(t.logger.entries.map((e) => [e.endpoint, e.status, e.cache, e.problem])).toEqual([
      ['asof', 400, 'miss', 'invalid_parameter'],
      ['health', 200, 'bypass', null],
      ['/nope', 405, 'bypass', 'method_not_allowed'],
    ]);
  });
  it('never contains payload contents', async () => {
    const t = memoryApp();
    await t.get('/v1/mini/asof?key=B&date=2025-01-02');
    await t.get('/v1/mini/diff?from=2025-01-01&to=2025-01-05&include=payload');
    // request_id is random hex and may legitimately contain "b2"; every other field must be payload-free.
    const text = JSON.stringify(t.logger.entries.map(({ request_id: _id, ...rest }) => rest));
    expect(text).not.toContain('Beta');
    expect(text).not.toContain('Gamma');
    expect(text).not.toContain('b2');
  });
  it('uses the injected clock for timestamps', async () => {
    const fixed = new Date('2026-01-01T00:00:00Z');
    const t = appFor(new StaticRegistry([memoryApp().store]), () => fixed);
    await t.get('/health');
    expect(t.logger.entries[0]?.ts).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('internal errors', () => {
  it('a throwing store becomes a 500 problem with the request id, and is logged', async () => {
    const boom = {
      list: () => Promise.reject(new Error('d1 down')),
      get: () => Promise.reject(new Error('d1 down')),
    };
    const t = appFor(boom);
    const res = await t.get('/v1/sources');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe(PROBLEM);
    const b = await body(res);
    expect(b).toMatchObject({ code: 'internal', request_id: res.headers.get('x-request-id') });
    expect(JSON.stringify(b)).not.toContain('d1 down');
    expect(t.logger.entries[0]).toMatchObject({ status: 500, problem: 'internal' });
  });
});
