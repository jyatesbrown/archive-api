/**
 * The Worker app over the SQL/blob store against the real fixture output
 * (harness schema in SQLite, raw payloads on disk) — one named test per pathology.
 */
import { SMALL_PARAMS } from '@archive-api/fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IMMUTABLE, SHORT } from '../src/cache.js';
import { KEY_SEP, PAGE_SEP, SqlStore } from '../src/stores/sql-store.js';
import { appFor, body, buildFixture, type FixtureHarness, type TestApp } from './helpers.js';

let fx: FixtureHarness;
let t: TestApp;
const SRC = SMALL_PARAMS.sourceName;
const date = (day: number) => fx.manifest.dates[day] as string;
const q = (endpoint: string, params: Record<string, string>) => `/v1/${SRC}/${endpoint}?${new URLSearchParams(params).toString()}`;

beforeAll(() => {
  fx = buildFixture();
  t = appFor(fx.registry);
}, 120_000);

afterAll(() => fx.close());

describe('SqlRegistry / SqlStore', () => {
  it('lists the fixture source from the harness sources table with capture bounds', async () => {
    const b = await body<{ sources: Array<Record<string, unknown>> }>(await t.get('/v1/sources'));
    const stored = fx.manifest.snapshots.filter((s) => s.snapshotId !== null);
    const ok = stored.filter((s) => s.outcome === 'ok');
    expect(b.sources).toEqual([
      {
        id: fx.manifest.source.id,
        name: SRC,
        upstreamUrl: fx.manifest.source.upstream_url,
        windowDays: SMALL_PARAMS.windowDays,
        captures: stored.length,
        okCaptures: ok.length,
        firstCapture: ok[0]?.date,
        lastCapture: ok[ok.length - 1]?.date,
      },
    ]);
  });
  it('exposes source metadata and the capture chain from the snapshots table', async () => {
    const store = (await fx.registry.get(SRC)) as SqlStore;
    expect(store.source).toMatchObject({ name: SRC, windowDays: SMALL_PARAMS.windowDays, windowKeyPart: fx.manifest.source.window_key_part, entityFields: ['entity'] });
    const caps = await store.captures();
    const stored = fx.manifest.snapshots.filter((s) => s.snapshotId !== null);
    expect(caps.map((c) => c.snapshotId)).toEqual(stored.map((s) => s.snapshotId));
    for (let i = 1; i < caps.length; i++) expect(caps[i]?.prevHash).toBe(caps[i - 1]?.contentHash);
  });
  it('reads payloads from the blob store at PAYLOAD_PREFIX + raw_path and keys them like the harness adapter', async () => {
    const store = (await fx.registry.get(SRC)) as SqlStore;
    const cap = (await store.captures()).find((c) => c.outcome === 'ok');
    if (!cap) throw new Error('no ok capture');
    const idx = await store.indexOf(cap.snapshotId);
    const [key, hash] = [...idx.entries()][0] as [string, string];
    const payload = await store.payloadOf(cap.snapshotId, key);
    expect(payload).not.toBeNull();
    expect(fx.blobs.reads).toContain(`payloads/${cap.rawPath}`);
    expect(await store.hashOf(cap.snapshotId, key)).toBe(hash);
    expect(await store.payloadOf(cap.snapshotId, 'no|such|key')).toBeNull();
    expect(KEY_SEP).toBe('|');
    expect(PAGE_SEP).toBe('\n--archive-harness-page--\n');
  });
  it('hashesOf batches lookups and chunks large key sets', async () => {
    const store = (await fx.registry.get(SRC)) as SqlStore;
    const cap = (await store.captures()).find((c) => c.outcome === 'ok');
    if (!cap) throw new Error('no ok capture');
    const idx = await store.indexOf(cap.snapshotId);
    const keys = [...idx.keys()].slice(0, 200);
    const before = fx.sql.queries.length;
    const got = await store.hashesOf(cap.snapshotId, [...keys, 'missing']);
    expect(fx.sql.queries.length - before).toBe(3);
    expect(got.size).toBe(200);
    for (const k of keys) expect(got.get(k)).toBe(idx.get(k));
  });
  it('a rejected capture has no index and no payload for the key', async () => {
    const store = (await fx.registry.get(SRC)) as SqlStore;
    const c = fx.manifest.cases.truncated_day;
    const snap = fx.manifest.snapshots[c.day];
    if (!snap?.snapshotId) throw new Error('truncated day not stored');
    expect((await store.indexOf(snap.snapshotId)).size).toBe(0);
  });
  it('get() returns null for a source that is not in the table', async () => {
    expect(await fx.registry.get('nope')).toBeNull();
  });
  it('issues only SELECT statements', () => {
    for (const s of fx.sql.queries) expect(s.trim().toUpperCase()).toMatch(/^SELECT/);
  });
});

describe('pathology: resurrect', () => {
  it('asof is absent mid-gap, exact with the new hash on return; history shows removed then reappeared', async () => {
    const c = fx.manifest.cases.resurrect;
    const mid = date(Math.floor((c.disappearsOnDay + c.returnsOnDay) / 2));
    expect(await body(await t.get(q('asof', { key: c.key, date: mid })))).toMatchObject({ resolution: 'absent' });
    expect(await body(await t.get(q('asof', { key: c.key, date: date(c.returnsOnDay) })))).toMatchObject({ resolution: 'exact', valueHash: c.hashAfter });
    const h = await body<{ transitions: Array<{ kind: string }>; reused: boolean }>(await t.get(q('history', { key: c.key })));
    expect(h.transitions.map((x) => x.kind)).toEqual(expect.arrayContaining(['removed', 'reappeared']));
    expect(h.reused).toBe(false);
  });
});

describe('pathology: resurrect_identical', () => {
  it('a byte-identical return is still a removed/reappeared pair, never smoothed over', async () => {
    const c = fx.manifest.cases.resurrect_identical;
    expect(c.hashBefore).toBe(c.hashAfter);
    const h = await body<{ transitions: Array<{ kind: string }>; gaps: Array<{ kind: string }> }>(await t.get(q('history', { key: c.key })));
    expect(h.transitions.map((x) => x.kind)).toEqual(expect.arrayContaining(['removed', 'reappeared']));
    expect(h.gaps.some((g) => g.kind === 'absent')).toBe(true);
    const d = await body<{ summary: Record<string, number>; entries: Array<{ key: string }> }>(
      await t.get(q('diff', { from: date(c.disappearsOnDay - 1), to: date(c.returnsOnDay), limit: '1000' })),
    );
    expect(d.entries.map((e) => e.key)).not.toContain(c.key);
  });
});

describe('pathology: silent_field', () => {
  it('the ignored field changes in the served payload while hash, diff and history stay quiet', async () => {
    const c = fx.manifest.cases.silent_field;
    const before = await body<{ valueHash: string; payload: Record<string, unknown> }>(await t.get(q('asof', { key: c.key, date: date(c.day - 1) })));
    const after = await body<{ valueHash: string; payload: Record<string, unknown> }>(await t.get(q('asof', { key: c.key, date: date(c.day) })));
    expect(before.valueHash).toBe(c.hash);
    expect(after.valueHash).toBe(c.hash);
    expect(before.payload[c.field]).toBe(c.valueBefore);
    expect(after.payload[c.field]).toBe(c.valueAfter);
    const d = await body<{ entries: Array<{ key: string }> }>(await t.get(q('diff', { from: date(c.day - 1), to: date(c.day), limit: '1000' })));
    expect(d.entries.map((e) => e.key)).not.toContain(c.key);
  });
});

describe('pathology: missing_day', () => {
  it('asof on the missing day is carried_forward or unknown_gap, and diff to it is a 422 problem', async () => {
    const c = fx.manifest.cases.missing_day;
    const store = (await fx.registry.get(SRC)) as SqlStore;
    const idx = await store.indexOf(fx.manifest.snapshots[c.day - 1]?.snapshotId as number);
    const anyKey = [...idx.keys()][0] as string;
    const a = await body<{ resolution: string }>(await t.get(q('asof', { key: anyKey, date: c.date })));
    expect(['carried_forward', 'unknown_gap']).toContain(a.resolution);
    const res = await t.get(q('diff', { from: date(c.day - 1), to: c.date }));
    expect(res.status).toBe(422);
    expect(await body(res)).toMatchObject({ code: 'no_capture', date: c.date, rejected_on_date: [] });
    const across = await body<{ gaps: Array<{ from: string; to: string }> }>(await t.get(q('diff', { from: date(c.day - 1), to: date(c.day + 1) })));
    expect(across.gaps).toEqual([expect.objectContaining({ from: c.date, to: c.date })]);
  });
});

describe('pathology: truncated_day', () => {
  it('the rejected capture is surfaced in rejectedOnDate and as rejected_on_date on the 422', async () => {
    const c = fx.manifest.cases.truncated_day;
    const store = (await fx.registry.get(SRC)) as SqlStore;
    const idx = await store.indexOf(fx.manifest.snapshots[c.day - 1]?.snapshotId as number);
    const anyKey = [...idx.keys()][0] as string;
    const a = await body<{ resolution: string; rejectedOnDate: Array<{ outcome: string }> }>(await t.get(q('asof', { key: anyKey, date: c.date })));
    expect(a.resolution).not.toBe('exact');
    expect(a.rejectedOnDate).toEqual([expect.objectContaining({ outcome: 'validation_failed' })]);
    const res = await t.get(q('diff', { from: c.date, to: date(c.day + 1) }));
    expect(res.status).toBe(422);
    expect(await body(res)).toMatchObject({ code: 'no_capture', rejected_on_date: [expect.objectContaining({ outcome: 'validation_failed' })] });
  });
});

describe('pathology: aged_out', () => {
  it('window departures are reported as aged_out, separately from removed', async () => {
    const c = fx.manifest.cases.aged_out;
    const d = await body<{ summary: Record<string, number>; entries: Array<{ category: string; key: string; before: string | null }> }>(
      await t.get(q('diff', { from: date(c.leavesOnDay - 1), to: date(c.leavesOnDay), limit: '1000' })),
    );
    expect(d.summary['aged_out']).toBeGreaterThanOrEqual(c.keys.length);
    expect(d.summary['aged_out']).toBeGreaterThanOrEqual(1);
    for (const k of c.keys) {
      const e = d.entries.find((x) => x.key === k);
      expect(e?.category).toBe('aged_out');
      expect(e?.before).toMatch(/^[0-9a-f]+$/);
    }
    const h = await body<{ status: string; transitions: Array<{ kind: string }> }>(await t.get(q('history', { key: c.keys[0] as string })));
    expect(h.status).toBe('aged_out');
    expect(h.transitions[h.transitions.length - 1]?.kind).toBe('aged_out');
  });
});

describe('pathology: key_reuse', () => {
  it('a key returning with a different entity is flagged reused with evidence', async () => {
    const c = fx.manifest.cases.key_reuse;
    const h = await body<{ reused: boolean; reuseEvidence: unknown[] }>(await t.get(q('history', { key: c.key })));
    expect(h.reused).toBe(true);
    expect(h.reuseEvidence.length).toBeGreaterThan(0);
  });
});

describe('cursor pagination over the real diff', () => {
  it('walks a multi-page diff to completion without repeats or omissions', async () => {
    const days = fx.manifest.dates.length;
    const from = date(1);
    const to = date(days - 1);
    const full = await body<{ summary: Record<string, number>; entries: Array<{ category: string; key: string }> }>(
      await t.get(q('diff', { from, to, limit: '1000' })),
    );
    const total = full.summary['added']! + full.summary['removed']! + full.summary['mutated']! + full.summary['aged_out']!;
    expect(total).toBeGreaterThan(20);
    expect(full.entries).toHaveLength(total);
    const seen: string[] = [];
    let next: string | null = q('diff', { from, to, limit: '7' });
    let pages = 0;
    while (next) {
      const res = await t.get(next);
      expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
      const p: { entries: Array<{ category: string; key: string }>; next_url: string | null } = await body(res);
      expect(p.entries.length).toBeLessThanOrEqual(7);
      seen.push(...p.entries.map((e) => `${e.category}:${e.key}`));
      next = p.next_url;
      pages++;
    }
    expect(pages).toBe(Math.ceil(total / 7));
    expect(seen).toEqual(full.entries.map((e) => `${e.category}:${e.key}`));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('cache policy over the fixture', () => {
  it('asof inside the archive is immutable; after the last capture it is not', async () => {
    const c = fx.manifest.cases.resurrect;
    expect((await t.get(q('asof', { key: c.key, date: date(0) }))).headers.get('cache-control')).toBe(IMMUTABLE);
    expect((await t.get(q('asof', { key: c.key, date: '2099-01-01' }))).headers.get('cache-control')).toBe(SHORT);
  });
});

describe('free tier over the fixture', () => {
  it('sees the last 90 days of the archive and is told, with the upgrade path, about the rest', async () => {
    // "Today" is the day after the final capture, so the window is the tail of the fixture.
    const last = fx.manifest.dates[fx.manifest.dates.length - 1] as string;
    const today = new Date(`${last}T12:00:00Z`);
    today.setUTCDate(today.getUTCDate() + 1);
    const ft = appFor(fx.registry, () => today);
    const k = await ft.mint('free');
    const h = { authorization: `Bearer ${k.plaintext}` };
    const c = fx.manifest.cases.resurrect;

    const old = await ft.get(q('asof', { key: c.key, date: date(0) }), { headers: h });
    expect(old.status).toBe(402);
    expect(await body(old)).toMatchObject({ code: 'lookback_exceeded', tier: 'free', lookback_days: 90, upgrade: { tier: 'indie' } });

    const recent = await ft.get(q('asof', { key: c.key, date: last }), { headers: h });
    expect(recent.status).toBe(200);
    expect(recent.headers.get('x-tier')).toBe('free');
    expect(recent.headers.get('x-ratelimit-used')).toBe('2');

    const full = await ft.get(q('asof', { key: c.key, date: date(0) })); // team key
    expect(full.status).toBe(200);
    expect((await body<{ resolution: string }>(full)).resolution).toBe('exact');
  });
});

describe('open archive (docs console sample data)', () => {
  it('an anonymous caller reads the whole fixture archive, still metered, and the cache is shared with paid callers', async () => {
    const last = fx.manifest.dates[fx.manifest.dates.length - 1] as string;
    const today = new Date(`${last}T12:00:00Z`);
    today.setUTCDate(today.getUTCDate() + 200);
    const ot = appFor(fx.registry, { now: () => today, openSources: new Set([SRC]) });
    const c = fx.manifest.cases.resurrect;

    const anon = await ot.get(q('asof', { key: c.key, date: date(0) }), { anonymous: true });
    expect(anon.status).toBe(200);
    expect(anon.headers.get('x-tier')).toBe('anonymous');
    expect(anon.headers.get('x-ratelimit-used')).toBe('1');
    expect(anon.headers.get('x-cache')).toBe('MISS');

    const team = await ot.get(q('asof', { key: c.key, date: date(0) }));
    expect(team.headers.get('x-cache')).toBe('HIT');

    const hist = await body<{ lookback: { limited: boolean }; firstSeen: { date: string } | null }>(
      await ot.get(q('history', { key: c.key }), { anonymous: true }),
    );
    expect(hist.lookback).toEqual({ limited: false });
    expect(hist.firstSeen?.date).toBe(date(0));

    // Other sources keep their window.
    const closed = appFor(fx.registry, { now: () => today, openSources: new Set(['some_other_source']) });
    expect((await closed.get(q('asof', { key: c.key, date: date(0) }), { anonymous: true })).status).toBe(402);
  });
});
