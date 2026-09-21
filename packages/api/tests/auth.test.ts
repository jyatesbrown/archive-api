import { describe, expect, it } from 'vitest';

import { isBillableBoundary, NoopBilling } from '../src/auth/billing.js';
import { earliestAllowed, secondsToNextMonth } from '../src/auth/guard.js';
import { extractBearer, looksLikeKey, mintKey, prefixOf, sha256Hex, SqlKeyStore } from '../src/auth/keys.js';
import { MemoryMeter, monthOf, usageFor } from '../src/auth/meter.js';
import { TIERS } from '../src/auth/tiers.js';
import { body, memoryApp } from './helpers.js';

// Fixed clock: the store's captures are 2025-01-01..05, so a 90-day window from
// here excludes all of them, and a clock 60 days later includes all of them.
const FAR = () => new Date('2025-06-01T12:00:00Z'); // earliest free = 2025-03-03
const NEAR = () => new Date('2025-03-01T12:00:00Z'); // earliest free = 2024-12-01

describe('API keys', () => {
  it('mints ak_<env>_<prefix>_<secret>, stores only the sha256 and a support-visible prefix', async () => {
    const m = await mintKey('indie', 'a@b.c', 'live');
    expect(looksLikeKey(m.plaintext)).toBe(true);
    expect(m.plaintext.startsWith(`${m.record.prefix}_`)).toBe(true);
    expect(m.record.prefix).toMatch(/^ak_live_[a-z2-9]{8}$/);
    expect(m.hash).toBe(await sha256Hex(m.plaintext));
    expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(m.record)).not.toContain(m.plaintext.slice(-32));
    expect(prefixOf(m.plaintext)).toBe(m.record.prefix);
    expect(prefixOf('nonsense')).toBeNull();
  });
  it('two mints never collide and anonymous cannot be minted', async () => {
    const [a, b] = await Promise.all([mintKey('free', null), mintKey('free', null)]);
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.record.id).not.toBe(b.record.id);
    await expect(mintKey('anonymous' as 'free', null)).rejects.toThrow(/anonymous/);
  });
  it('accepts Bearer and x-api-key, preferring Bearer', () => {
    const h = (o: Record<string, string>) => new Request('https://x', { headers: o });
    expect(extractBearer(h({ authorization: 'Bearer k1' }))).toBe('k1');
    expect(extractBearer(h({ authorization: 'bearer   k1' }))).toBe('k1');
    expect(extractBearer(h({ 'x-api-key': 'k2' }))).toBe('k2');
    expect(extractBearer(h({ authorization: 'Bearer k1', 'x-api-key': 'k2' }))).toBe('k1');
    expect(extractBearer(h({ authorization: 'Basic abc' }))).toBeNull();
    expect(extractBearer(h({}))).toBeNull();
  });
  it('SqlKeyStore reads api_keys and refuses unknown tiers', async () => {
    const rows: Record<string, unknown>[] = [
      { id: 'k1', prefix: 'ak_live_aaaaaaaa', key_hash: 'h1', tier: 'indie', owner: null, created_at: 't', revoked_at: null },
      { id: 'k2', prefix: 'ak_live_bbbbbbbb', key_hash: 'h2', tier: 'platinum', owner: null, created_at: 't', revoked_at: null },
    ];
    const sql = {
      all: async <T>(): Promise<T[]> => [],
      first: async <T>(_q: string, p: readonly unknown[]): Promise<T | null> => (rows.find((r) => r['key_hash'] === p[0]) as T) ?? null,
    };
    const store = new SqlKeyStore(sql);
    expect((await store.byHash('h1'))?.tier).toBe('indie');
    expect(await store.byHash('nope')).toBeNull();
    await expect(store.byHash('h2')).rejects.toThrow(/platinum/);
  });
});

describe('meter arithmetic', () => {
  it('counts per subject per UTC month', async () => {
    const m = new MemoryMeter();
    expect(await m.hit('k', '2025-01')).toBe(1);
    expect(await m.hit('k', '2025-01')).toBe(2);
    expect(await m.hit('k', '2025-02')).toBe(1);
    expect(await m.hit('j', '2025-01')).toBe(1);
    expect(await m.peek('k', '2025-01')).toBe(2);
    expect(monthOf(new Date('2025-01-31T23:59:59.999Z'))).toBe('2025-01');
  });
  it('overage is recorded, never a cutoff, and priced per 1,000', () => {
    expect(usageFor('free', '2025-01', 999)).toMatchObject({ overage: 0, remaining: 1, overageUsd: 0 });
    expect(usageFor('free', '2025-01', 1000)).toMatchObject({ overage: 0, remaining: 0 });
    expect(usageFor('free', '2025-01', 1001)).toMatchObject({ overage: 1, remaining: 0, overageUsd: 1 });
    expect(usageFor('indie', '2025-01', 27_500)).toMatchObject({ overage: 2500, overageUsd: 3 });
    expect(usageFor('bulk', '2025-01', 10 ** 7)).toMatchObject({ limit: null, overage: 0, remaining: null });
  });
  it('reports to billing exactly at the allowance and each further 1,000', () => {
    const at = (n: number) => isBillableBoundary(usageFor('free', '2025-01', n));
    expect([999, 1000, 1001, 1002, 1999, 2000, 2001, 3000].map(at)).toEqual([false, false, true, false, false, true, false, true]);
    expect(isBillableBoundary(usageFor('bulk', '2025-01', 1001))).toBe(false);
  });
  it('the tier table matches the pricing page', () => {
    expect(TIERS.free).toMatchObject({ callsPerMonth: 1000, lookbackDays: 90, onExhausted: 'overage', priceUsd: 0 });
    expect(TIERS.indie).toMatchObject({ callsPerMonth: 25_000, lookbackDays: null, priceUsd: 29 });
    expect(TIERS.team).toMatchObject({ callsPerMonth: 250_000, lookbackDays: null, bulkExport: 'quarterly', priceUsd: 149 });
    expect(TIERS.bulk).toMatchObject({ callsPerMonth: null, bulkExport: 'once', priceUsd: 400 });
    expect(TIERS.anonymous.onExhausted).toBe('block');
  });
  it('lookback window is measured in calendar days from today', () => {
    expect(earliestAllowed('free', '2025-06-01')).toBe('2025-03-03');
    expect(earliestAllowed('anonymous', '2025-03-01')).toBe('2024-12-01');
    expect(earliestAllowed('indie', '2025-06-01')).toBeNull();
    expect(secondsToNextMonth(new Date('2025-01-31T23:59:30Z'))).toBe(30);
  });
});

describe('authentication at the edge', () => {
  it('no credential is anonymous: allowed, logged as such, tightly limited', async () => {
    const t = memoryApp(NEAR);
    const r = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { anonymous: true });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-tier')).toBe('anonymous');
    expect(r.headers.get('x-ratelimit-limit')).toBe('100');
    expect(r.headers.get('x-ratelimit-used')).toBe('1');
    expect(t.logger.entries[0]).toMatchObject({ tier: 'anonymous', key_prefix: null });
  });
  it('a malformed, unknown or revoked key is 401 — never silently downgraded to anonymous', async () => {
    const t = memoryApp(NEAR);
    const bad = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: 'Bearer not-a-key' } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('Bearer');
    expect(await body(bad)).toMatchObject({ code: 'invalid_key', key_prefix: null });

    const unknown = (await mintKey('free', null, 'test')).plaintext;
    const u = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { 'x-api-key': unknown } });
    expect(u.status).toBe(401);
    expect(await body(u)).toMatchObject({ code: 'invalid_key', key_prefix: unknown.slice(0, 16) });

    const revoked = await t.mint('indie', true);
    const rv = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${revoked.plaintext}` } });
    expect(rv.status).toBe(401);
    expect(await body(rv)).toMatchObject({ code: 'invalid_key', revoked_at: '2025-06-01T00:00:00Z', key_prefix: revoked.record.prefix });
    expect(t.logger.entries.map((e) => e.status)).toEqual([401, 401, 401]);
    expect(t.meter.counts.size).toBe(0);
  });
  it('logs the key prefix, never the key', async () => {
    const t = memoryApp(NEAR);
    const k = await t.mint('indie');
    await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${k.plaintext}` } });
    const line = JSON.stringify(t.logger.entries);
    expect(line).toContain(k.record.prefix);
    expect(line).not.toContain(k.plaintext.slice(-32));
    expect(t.logger.entries[0]).toMatchObject({ tier: 'indie', key_prefix: k.record.prefix });
  });
  it('/health needs no key and is not metered', async () => {
    const t = memoryApp(NEAR);
    expect((await t.get('/health', { anonymous: true })).status).toBe(200);
    expect((await t.get('/health', { headers: { authorization: 'Bearer garbage' } })).status).toBe(200);
    expect(t.meter.counts.size).toBe(0);
  });
});

describe('metering', () => {
  it('every /v1 call, hits included, increments the caller’s monthly counter and is echoed in headers', async () => {
    const t = memoryApp(NEAR);
    const k = await t.mint('free');
    const h = { authorization: `Bearer ${k.plaintext}` };
    const a = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: h });
    const b = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: h });
    const c = await t.get('/v1/sources', { headers: h });
    expect([a, b, c].map((r) => r.headers.get('x-cache'))).toEqual(['MISS', 'HIT', 'MISS']);
    expect([a, b, c].map((r) => r.headers.get('x-ratelimit-used'))).toEqual(['1', '2', '3']);
    expect(c.headers.get('x-ratelimit-limit')).toBe('1000');
    expect(c.headers.get('x-ratelimit-remaining')).toBe('997');
    expect(await t.meter.peek(`key:${k.record.id}`, '2025-03')).toBe(3);
  });
  it('separate keys have separate counters; the cache is still shared', async () => {
    const t = memoryApp(NEAR);
    const k1 = await t.mint('free');
    const k2 = await t.mint('free');
    await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${k1.plaintext}` } });
    const r = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${k2.plaintext}` } });
    expect(r.headers.get('x-cache')).toBe('HIT');
    expect(r.headers.get('x-ratelimit-used')).toBe('1');
  });
  it('a keyed caller past the allowance keeps getting answers; overage is recorded and billing is told', async () => {
    const t = memoryApp(NEAR);
    const k = await t.mint('free');
    t.meter.counts.set(`key:${k.record.id}:2025-03`, TIERS.free.callsPerMonth as number);
    const r = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${k.plaintext}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-ratelimit-used')).toBe('1001');
    expect(r.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(r.headers.get('x-overage-calls')).toBe('1');
    expect(t.billing.reports).toHaveLength(1);
    expect(t.billing.reports[0]).toMatchObject({ keyId: k.record.id, usage: { tier: 'free', month: '2025-03', used: 1001, overage: 1, overageUsd: 1 } });
    // The next call is not a boundary: no second report.
    await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${k.plaintext}` } });
    expect(t.billing.reports).toHaveLength(1);
  });
  it('anonymous callers past the allowance are refused with 429 + problem naming the free key as the way out', async () => {
    const t = memoryApp(NEAR);
    const first = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { anonymous: true });
    const subject = [...t.meter.counts.keys()][0] as string;
    expect(subject).toMatch(/^anon:[0-9a-f]{32}:2025-03$/);
    t.meter.counts.set(subject, TIERS.anonymous.callsPerMonth as number);
    const r = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { anonymous: true });
    expect(first.status).toBe(200);
    expect(r.status).toBe(429);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await body(r)).toMatchObject({
      code: 'quota_exhausted',
      tier: 'anonymous',
      limit: 100,
      used: 101,
      upgrade: { tier: 'free', checkoutUrl: null, pricingUrl: 'https://archive-api.dev/pricing' },
    });
    expect(t.billing.reports).toHaveLength(0);
    expect(t.logger.entries[1]).toMatchObject({ status: 429, problem: 'quota_exhausted', cache: 'bypass' });
  });
  it('the anonymous subject is derived from the client address, not shared globally', async () => {
    const t = memoryApp(NEAR);
    await t.get('/v1/mini/asof?key=A&date=2025-01-01', { anonymous: true, headers: { 'cf-connecting-ip': '10.0.0.1' } });
    await t.get('/v1/mini/asof?key=A&date=2025-01-01', { anonymous: true, headers: { 'cf-connecting-ip': '10.0.0.2' } });
    expect(t.meter.counts.size).toBe(2);
    expect(JSON.stringify([...t.meter.counts.keys()])).not.toContain('10.0.0');
  });
});

describe('free-tier lookback (90 days)', () => {
  it('asof past the window is 402 problem+json naming the limit and the upgrade path, before any store or cache work', async () => {
    const t = memoryApp(FAR);
    const k = await t.mint('free');
    const r = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${k.plaintext}` } });
    expect(r.status).toBe(402);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await body(r)).toMatchObject({
      type: 'https://archive-api.dev/problems/lookback_exceeded',
      code: 'lookback_exceeded',
      status: 402,
      parameter: 'date',
      requested: '2025-01-01',
      tier: 'free',
      lookback_days: 90,
      earliest_allowed: '2025-03-03',
      upgrade: { tier: 'indie', checkoutUrl: null, pricingUrl: 'https://archive-api.dev/pricing' },
    });
    expect((await body<{ detail: string }>(await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${k.plaintext}` } }))).detail).toMatch(
      /90 days.*Upgrade to indie/,
    );
    expect(t.cache.size).toBe(0);
    expect(t.logger.entries[0]).toMatchObject({ status: 402, problem: 'lookback_exceeded', tier: 'free', cache: 'bypass' });
  });
  it('the same date is fine once it is inside the window, and for full-archive tiers regardless', async () => {
    const near = memoryApp(NEAR);
    const k = await near.mint('free');
    expect((await near.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${k.plaintext}` } })).status).toBe(200);
    const far = memoryApp(FAR);
    for (const tier of ['indie', 'team', 'bulk'] as const) {
      const p = await far.mint(tier);
      expect((await far.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${p.plaintext}` } })).status).toBe(200);
    }
    expect((await far.get('/v1/mini/asof?key=A&date=2025-01-01')).status).toBe(200); // default team key
  });
  it('the window is inclusive at its boundary', async () => {
    const t = memoryApp(() => new Date('2025-04-01T00:00:00Z')); // earliest = 2025-01-01
    const k = await t.mint('free');
    const h = { authorization: `Bearer ${k.plaintext}` };
    expect((await t.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: h })).status).toBe(200);
    const t2 = memoryApp(() => new Date('2025-04-02T00:00:00Z')); // earliest = 2025-01-02
    const k2 = await t2.mint('free');
    expect((await t2.get('/v1/mini/asof?key=A&date=2025-01-01', { headers: { authorization: `Bearer ${k2.plaintext}` } })).status).toBe(402);
    expect((await t2.get('/v1/mini/asof?key=A&date=2025-01-02', { headers: { authorization: `Bearer ${k2.plaintext}` } })).status).toBe(200);
  });
  it('diff: either endpoint outside the window is 402 and names the offending parameter', async () => {
    const t = memoryApp(() => new Date('2025-04-02T00:00:00Z')); // earliest = 2025-01-02
    const k = await t.mint('free');
    const h = { authorization: `Bearer ${k.plaintext}` };
    const r = await t.get('/v1/mini/diff?from=2025-01-01&to=2025-01-05', { headers: h });
    expect(r.status).toBe(402);
    expect(await body(r)).toMatchObject({ code: 'lookback_exceeded', parameter: 'from', requested: '2025-01-01' });
    expect((await t.get('/v1/mini/diff?from=2025-01-02&to=2025-01-05', { headers: h })).status).toBe(200);
  });
  it('anonymous callers get the same window as free', async () => {
    const t = memoryApp(FAR);
    const r = await t.get('/v1/mini/asof?key=A&date=2025-01-01', { anonymous: true });
    expect(r.status).toBe(402);
    expect(await body(r)).toMatchObject({ tier: 'anonymous', lookback_days: 90 });
  });
  it('malformed dates are still 400, not 402 (the window check only judges real dates)', async () => {
    const t = memoryApp(FAR);
    const k = await t.mint('free');
    const r = await t.get('/v1/mini/asof?key=A&date=yesterday', { headers: { authorization: `Bearer ${k.plaintext}` } });
    expect(r.status).toBe(400);
  });
  it('history is truncated to the window and says so; nothing older leaks, and firstSeen is withheld rather than moved', async () => {
    const t = memoryApp(() => new Date('2025-04-02T00:00:00Z')); // earliest = 2025-01-02
    const k = await t.mint('free');
    type H = {
      firstSeen: { date: string } | null;
      lastSeen: { date: string } | null;
      transitions: Array<{ capture: { date: string } }>;
      gaps: Array<{ to: string }>;
      provenance: { captures: Array<{ date: string }> };
      lookback: Record<string, unknown>;
    };
    const limited = await body<H>(await t.get('/v1/mini/history?key=B', { headers: { authorization: `Bearer ${k.plaintext}` } }));
    const full = await body<H>(await t.get('/v1/mini/history?key=B'));
    expect(full.firstSeen?.date).toBe('2025-01-01');
    expect(full.transitions.map((x) => x.capture.date)).toEqual(['2025-01-01', '2025-01-02', '2025-01-05']);
    expect(full.lookback).toEqual({ limited: false });

    expect(limited.firstSeen).toBeNull();
    expect(limited.lastSeen?.date).toBe('2025-01-02');
    expect(limited.transitions.map((x) => x.capture.date)).toEqual(['2025-01-02', '2025-01-05']);
    expect(limited.provenance.captures.every((c) => c.date >= '2025-01-02')).toBe(true);
    expect(JSON.stringify(limited)).not.toContain('2025-01-01');
    expect(limited.lookback).toMatchObject({
      limited: true,
      tier: 'free',
      lookback_days: 90,
      earliest_allowed: '2025-01-02',
      omitted_transitions: 1,
      upgrade: { pricing_url: 'https://archive-api.dev/pricing' },
    });
  });
  it('a truncated history and the full history never share a cache entry', async () => {
    const t = memoryApp(() => new Date('2025-04-02T00:00:00Z'));
    const k = await t.mint('free');
    const a = await t.get('/v1/mini/history?key=B'); // team, full
    const b = await t.get('/v1/mini/history?key=B', { headers: { authorization: `Bearer ${k.plaintext}` } });
    expect(a.headers.get('x-cache')).toBe('MISS');
    expect(b.headers.get('x-cache')).toBe('MISS');
    expect(t.cache.size).toBe(2);
    const c = await t.get('/v1/mini/history?key=B', { headers: { authorization: `Bearer ${k.plaintext}` } });
    expect(c.headers.get('x-cache')).toBe('HIT');
    expect((await body<{ lookback: { limited: boolean } }>(c)).lookback.limited).toBe(true);
  });
});

describe('billing seam', () => {
  it('the no-op provider sells nothing but always has a pricing page', async () => {
    const b = new NoopBilling('https://example.test/pricing');
    expect(b.name).toBe('noop');
    expect(await b.checkoutUrl('indie', null)).toBeNull();
    expect(b.pricingUrl()).toBe('https://example.test/pricing');
    await b.reportUsage('k', usageFor('free', '2025-01', 1001));
    expect(b.reports).toHaveLength(1);
  });
});

describe('mint-key script → api_keys → SqlKeyStore', () => {
  it('a key minted by the script is accepted by the Worker through the SQL store', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const { SqliteClient } = await import('./helpers.js');
    const dir = mkdtempSync(join(tmpdir(), 'ak-'));
    try {
      const dbPath = join(dir, 'keys.sqlite');
      new DatabaseSync(dbPath).exec(readFileSync(new URL('../contract/api-keys.sql', import.meta.url), 'utf8'));
      const plaintext = execFileSync(
        process.execPath,
        ['--experimental-strip-types', new URL('../scripts/mint-key.ts', import.meta.url).pathname, '--tier', 'team', '--owner', 'ops@x', '--db', dbPath],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      expect(looksLikeKey(plaintext)).toBe(true);
      const store = new SqlKeyStore(new SqliteClient(dbPath));
      const rec = await store.byHash(await sha256Hex(plaintext));
      expect(rec).toMatchObject({ tier: 'team', owner: 'ops@x', revokedAt: null, prefix: prefixOf(plaintext) });
      expect(await store.byHash(await sha256Hex(`${plaintext}x`))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
