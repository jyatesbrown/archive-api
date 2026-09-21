import type { DiffResult } from '@archive-api/engine';
import { describe, expect, it } from 'vitest';

import { IMMUTABLE, MemoryResponseCache, NO_STORE, SHORT, cacheKey } from '../src/cache.js';
import { DIFF_CATEGORIES, decodeCursor, encodeCursor, pageOf } from '../src/cursor.js';
import { MemoryLogger, type RequestLog } from '../src/logging.js';
import { PROBLEM_CODE_HEADER, PROBLEM_TYPE_BASE, problem } from '../src/problem.js';
import { openSources, parseSourceConfig } from '../src/registry.js';

describe('problem()', () => {
  it('emits RFC 9457 problem+json with type/title/status/detail/instance and no-store', async () => {
    const res = problem('invalid_parameter', 400, 'bad date', '/v1/x/asof', { parameter: 'date' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(res.headers.get(PROBLEM_CODE_HEADER)).toBe('invalid_parameter');
    expect(await res.json()).toEqual({
      type: `${PROBLEM_TYPE_BASE}invalid_parameter`,
      title: 'Invalid parameter',
      status: 400,
      detail: 'bad date',
      instance: '/v1/x/asof',
      code: 'invalid_parameter',
      parameter: 'date',
    });
  });
});

describe('cacheKey()', () => {
  it('is independent of query-parameter order', () => {
    const a = cacheKey(new URL('https://h/v1/s/diff?to=2025-02-01&from=2025-01-01&limit=5'));
    const b = cacheKey(new URL('https://h/v1/s/diff?limit=5&from=2025-01-01&to=2025-02-01'));
    expect(a).toBe(b);
    expect(a).toBe('https://h/v1/s/diff?from=2025-01-01&limit=5&to=2025-02-01');
  });
  it('differs by source, endpoint and every parameter', () => {
    const base = 'https://h/v1/s/asof?key=A&date=2025-01-01';
    const k = cacheKey(new URL(base));
    expect(cacheKey(new URL(base.replace('/s/', '/t/')))).not.toBe(k);
    expect(cacheKey(new URL(base.replace('asof', 'history')))).not.toBe(k);
    expect(cacheKey(new URL(base.replace('key=A', 'key=B')))).not.toBe(k);
    expect(cacheKey(new URL(`${base}&include=payload`))).not.toBe(k);
  });
  it('exposes the three cache policies', () => {
    expect(IMMUTABLE).toContain('immutable');
    expect(SHORT).toMatch(/max-age=\d+/);
    expect(SHORT).not.toContain('immutable');
  });
});

describe('MemoryResponseCache', () => {
  it('stores a copy and serves it back with the original headers', async () => {
    const c = new MemoryResponseCache();
    const r = new Response('{"a":1}', { headers: { 'cache-control': IMMUTABLE, 'content-type': 'application/json' } });
    await c.put('k', r);
    const hit = await c.match('k');
    expect(hit).toBeDefined();
    expect(await hit?.text()).toBe('{"a":1}');
    expect(hit?.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(await c.match('other')).toBeUndefined();
  });
  it('refuses to store no-store responses', async () => {
    const c = new MemoryResponseCache();
    await c.put('k', new Response('x', { headers: { 'cache-control': NO_STORE } }));
    expect(await c.match('k')).toBeUndefined();
  });
});

describe('cursor', () => {
  it('round-trips through an opaque base64url string', () => {
    const s = encodeCursor({ c: 'mutated', k: 'K|2025-01-01|é' });
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(s)).toEqual({ c: 'mutated', k: 'K|2025-01-01|é' });
  });
  it('rejects garbage, wrong shapes and unknown categories', () => {
    expect(decodeCursor('not base64!!')).toBeNull();
    expect(decodeCursor(btoa('[1,2]'))).toBeNull();
    expect(decodeCursor(btoa('{"c":"added"}'))).toBeNull();
    expect(decodeCursor(btoa('{"c":"offset","k":"10"}'))).toBeNull();
    expect(decodeCursor(btoa('{"c":"added","k":5}'))).toBeNull();
  });
  const fake = (added: string[], removed: string[], mutated: string[], agedOut: string[]): DiffResult =>
    ({
      added,
      removed,
      agedOut,
      mutated: mutated.map((key) => ({ key, before: `${key}-b`, after: `${key}-a` })),
      unchanged: 0,
      gaps: [],
    }) as unknown as DiffResult;
  it('walks categories in a fixed order and yields the whole set exactly once', () => {
    const d = fake(['a1', 'a2', 'a3'], ['r1'], ['m1', 'm2'], ['z1', 'z2']);
    const seen: string[] = [];
    let cursor = null;
    let pages = 0;
    do {
      const p = pageOf(d, cursor, 2);
      pages++;
      seen.push(...p.entries.map((e) => `${e.category}:${e.key}`));
      cursor = p.nextCursor === null ? null : decodeCursor(p.nextCursor);
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toEqual(['added:a1', 'added:a2', 'added:a3', 'removed:r1', 'mutated:m1', 'mutated:m2', 'aged_out:z1', 'aged_out:z2']);
    expect(DIFF_CATEGORIES).toEqual(['added', 'removed', 'mutated', 'aged_out']);
  });
  it('is stable: a cursor points strictly after the last key, so a page never repeats', () => {
    const d = fake(['a', 'b', 'c'], [], [], []);
    const p1 = pageOf(d, null, 2);
    const p2 = pageOf(d, decodeCursor(p1.nextCursor as string), 2);
    expect(p1.entries.map((e) => e.key)).toEqual(['a', 'b']);
    expect(p2.entries.map((e) => e.key)).toEqual(['c']);
    expect(p2.nextCursor).toBeNull();
  });
  it('an exactly-filled final page still ends the sequence', () => {
    const d = fake(['a', 'b'], [], [], []);
    const p = pageOf(d, null, 2);
    expect(p.entries).toHaveLength(2);
    expect(p.nextCursor).toBeNull();
  });
  it('carries before/after hashes for mutations', () => {
    const p = pageOf(fake([], [], ['m'], []), null, 10);
    expect(p.entries[0]).toEqual({ category: 'mutated', key: 'm', before: 'm-b', after: 'm-a' });
  });
});

describe('logging', () => {
  it('MemoryLogger records entries verbatim', () => {
    const l = new MemoryLogger();
    const e: RequestLog = {
      ts: '2025-01-01T00:00:00.000Z',
      request_id: 'r',
      method: 'GET',
      endpoint: 'asof',
      source: 's',
      record_key: 'k',
      status: 200,
      latency_ms: 1,
      cache: 'miss',
      tier: 'anonymous',
      key_prefix: null,
      problem: null,
    };
    l.log(e);
    expect(l.entries).toEqual([e]);
  });
});

describe('parseSourceConfig()', () => {
  it('reads openArchive and lists open sources', () => {
    const cfg = parseSourceConfig('{"demo":{"openArchive":true},"real":{"entityFields":["e"]},"off":{"openArchive":false}}');
    expect(cfg).toEqual({ demo: { openArchive: true }, real: { entityFields: ['e'] }, off: { openArchive: false } });
    expect([...openSources(cfg)]).toEqual(['demo']);
    expect(() => parseSourceConfig('{"x":{"openArchive":"yes"}}')).toThrow(/openArchive/);
  });
  it('accepts an empty/missing value and a well-formed map', () => {
    expect(parseSourceConfig(undefined)).toEqual({});
    expect(parseSourceConfig('{"a":{"entityFields":["x"]},"b":{}}')).toEqual({ a: { entityFields: ['x'] }, b: {} });
  });
  it('rejects non-object roots and bad entityFields', () => {
    expect(() => parseSourceConfig('[]')).toThrow(/object/);
    expect(() => parseSourceConfig('{"a":1}')).toThrow(/object/);
    expect(() => parseSourceConfig('{"a":{"entityFields":"x"}}')).toThrow(/string\[\]/);
  });
});
