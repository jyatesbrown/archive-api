import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { history, type Capture, type JsonValue, type SourceMeta } from '@archive-api/engine';
import { SMALL_PARAMS } from '@archive-api/fixture';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MemoryExportLedger,
  entitlement,
  nextQuarterStart,
  parseManifest,
  quarterStart,
  signLink,
  verifyLink,
  type ExportDeps,
  type ExportGrant,
  type ExportObject,
  type ObjectReader,
} from '../src/export.js';
import { sha256Hex } from '../src/auth/keys.js';
import { SqlStore } from '../src/stores/sql-store.js';

import { exportParquet, historyRows, stampFor, type ExportManifest, type HistoryRow } from '../scripts/parquet-export.ts';

import { appFor, body, buildFixture, type FixtureHarness, type TestApp } from './helpers.js';

const SOURCE = SMALL_PARAMS.sourceName;
const SECRET = 'test-signing-secret';
const NOW = new Date('2025-05-10T12:00:00Z');

/** R2 stand-in: `<prefix><source>/...` -> files under the export output dir. */
class FsObjects implements ObjectReader {
  constructor(
    private readonly root: string,
    private readonly prefix: string,
  ) {}
  private path(key: string): string | null {
    if (!key.startsWith(`${this.prefix}${SOURCE}/`)) return null;
    return join(this.root, key.slice(this.prefix.length + SOURCE.length + 1));
  }
  async text(key: string): Promise<string | null> {
    const p = this.path(key);
    return p && existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  async get(key: string): Promise<ExportObject | null> {
    const p = this.path(key);
    if (!p || !existsSync(p)) return null;
    const bytes = readFileSync(p);
    return {
      body: new Blob([bytes]).stream(),
      size: bytes.length,
      etag: '"etag"',
      contentType: key.endsWith('.parquet') ? 'application/vnd.apache.parquet' : 'application/json',
    };
  }
}

describe('bulk export policy', () => {
  const g = (source: string, stamp: string, issuedAt: string): ExportGrant => ({ keyId: 'k', source, stamp, issuedAt });
  const now = '2025-05-10T00:00:00Z';

  it('calendar quarters', () => {
    expect(quarterStart('2025-05-10T00:00:00Z')).toBe('2025-04-01T00:00:00.000Z');
    expect(nextQuarterStart('2025-05-10T00:00:00Z')).toBe('2025-07-01T00:00:00.000Z');
    expect(nextQuarterStart('2025-11-30T23:59:59Z')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('tiers without bulk export are refused regardless of history', () => {
    for (const tier of ['anonymous', 'free', 'indie'] as const) {
      expect(entitlement(tier, [], 'a', 's1', now)).toEqual({ ok: false, reason: 'not_included' });
    }
  });

  it('bulk: exactly one export ever, but the same stamp can be re-signed', () => {
    expect(entitlement('bulk', [], 'a', 's1', now)).toEqual({ ok: true });
    const used = [g('a', 's1', '2024-01-01T00:00:00Z')];
    expect(entitlement('bulk', used, 'a', 's1', now)).toEqual({ ok: true });
    expect(entitlement('bulk', used, 'a', 's2', now)).toEqual({ ok: false, reason: 'exhausted', used, resetsAt: null });
    expect(entitlement('bulk', used, 'b', 's1', now)).toMatchObject({ ok: false, reason: 'exhausted' });
  });

  it('team: one export per calendar quarter', () => {
    const lastQuarter = [g('a', 's0', '2025-03-31T23:59:59Z')];
    expect(entitlement('team', lastQuarter, 'a', 's1', now)).toEqual({ ok: true });
    const thisQuarter = [...lastQuarter, g('a', 's1', '2025-04-02T00:00:00Z')];
    expect(entitlement('team', thisQuarter, 'b', 's9', now)).toEqual({
      ok: false,
      reason: 'exhausted',
      used: [thisQuarter[1]],
      resetsAt: '2025-07-01T00:00:00.000Z',
    });
    expect(entitlement('team', thisQuarter, 'a', 's1', now)).toEqual({ ok: true });
  });

  it('signed links: valid, tampered, expired, malformed', async () => {
    const exp = 1_800_000_000;
    const sig = await signLink(SECRET, 'src', 'stamp', 'history.parquet', exp);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyLink(SECRET, 'src', 'stamp', 'history.parquet', String(exp), sig, exp - 1)).toBe('ok');
    expect(await verifyLink(SECRET, 'src', 'stamp', 'history.parquet', String(exp), sig, exp + 1)).toBe('expired');
    expect(await verifyLink(SECRET, 'src', 'stamp', 'snapshots.parquet', String(exp), sig, exp - 1)).toBe('bad_signature');
    expect(await verifyLink(SECRET, 'src', 'stamp', 'history.parquet', String(exp + 1), sig, exp - 1)).toBe('bad_signature');
    expect(await verifyLink('other', 'src', 'stamp', 'history.parquet', String(exp), sig, exp - 1)).toBe('bad_signature');
    expect(await verifyLink(SECRET, 'src', 'stamp', 'history.parquet', null, sig, exp - 1)).toBe('malformed');
    expect(await verifyLink(SECRET, 'src', 'stamp', 'history.parquet', String(exp), 'zz', exp - 1)).toBe('malformed');
  });

  it('parseManifest rejects garbage and path-hostile names', () => {
    expect(parseManifest('nope')).toBeNull();
    expect(parseManifest('{"stamp":"../x","files":[]}')).toBeNull();
    expect(parseManifest('{"stamp":"s1","files":[{"name":"../etc/passwd"}]}')).toBeNull();
    expect(parseManifest('{"stamp":"s1","files":[{"name":"history.parquet"}]}')).not.toBeNull();
  });

  it('historyRows follows the engine: appear / mutate / remove / age out / reappear', () => {
    const meta: SourceMeta = { id: 1, name: 'm', upstreamUrl: 'u', windowDays: 10, windowKeyPart: 0, entityFields: [] };
    const cap = (id: number, date: string, outcome: Capture['outcome'] = 'ok'): Capture => ({
      snapshotId: id,
      fetchedAt: `${date}T06:00:00Z`,
      date,
      outcome,
      contentHash: `c${id}`,
      prevHash: null,
      rawPath: null,
      adapterVersion: '0.1',
      chainIndex: id - 1,
    });
    const idx = new Map<number, Map<string, string>>([
      [1, new Map([['2025-01-01|A', 'a1'], ['2025-01-01|B', 'b1']])],
      [2, new Map([['2025-01-01|A', 'a2']])],
      [3, new Map()],
      [4, new Map([['2025-01-01|B', 'b2']])],
      [5, new Map()],
    ]);
    const payloads = new Map<number, Map<string, JsonValue>>([[1, new Map([['2025-01-01|A', { v: 1 }]])]]);
    const stats = { keys: new Set<string>() };
    const rows = [
      ...historyRows(
        meta,
        [cap(1, '2025-01-02'), cap(2, '2025-01-03'), cap(3, '2025-01-04', 'fetch_failed'), cap(4, '2025-01-05'), cap(5, '2025-01-20')],
        (id) => idx.get(id) ?? new Map(),
        (id) => payloads.get(id) ?? null,
        stats,
      ),
    ].map((r: HistoryRow) => [r.record_key.slice(11), r.event, r.snapshot_id, r.value_hash, r.payload] as const);
    expect(rows).toEqual([
      ['A', 'appeared', 1, 'a1', '{"v":1}'],
      ['B', 'appeared', 1, 'b1', null],
      ['A', 'mutated', 2, 'a2', null],
      ['B', 'removed', 2, null, null],
      ['B', 'reappeared', 4, 'b2', null],
      ['A', 'removed', 4, null, null],
      ['B', 'aged_out', 5, null, null],
    ]);
    expect(stats.keys.size).toBe(2);
    expect(stampFor(null)).toBe('empty');
    expect(stampFor(cap(9, '2025-01-02'))).toBe('20250102T060000Z-c9');
  });
});

describe('bulk export job + delivery (small fixture)', () => {
  let fx: FixtureHarness;
  let out: string;
  let manifest: ExportManifest;
  let store: SqlStore;
  let deps: ExportDeps;
  let ledger: MemoryExportLedger;

  beforeAll(async () => {
    fx = buildFixture();
    out = join(fx.dir, 'exports');
    manifest = await exportParquet({
      db: join(fx.dir, 'out', 'harness.sqlite'),
      payloads: join(fx.dir, 'out', 'payloads'),
      source: SOURCE,
      out,
      rowGroupSize: 500,
    });
    store = (await fx.registry.get(SOURCE)) as SqlStore;
    ledger = new MemoryExportLedger();
    deps = { objects: new FsObjects(out, 'exports/'), ledger, signingSecret: SECRET, prefix: 'exports/', linkTtlS: 3600 };
  });
  afterAll(() => fx.close());

  const app = (opts: Partial<ExportDeps> = {}): TestApp => appFor(fx.registry, { now: () => NOW, exports: { ...deps, ...opts } });

  it('refuses unknown sources before touching the ledger', async () => {
    const res = await exportParquet({ db: join(fx.dir, 'out', 'harness.sqlite'), payloads: '', source: 'nope', out }).catch((e: Error) => e);
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toContain("source 'nope' not found");
  });

  it('writes valid Parquet whose rows match the engine, plus a manifest and upload script', async () => {
    const caps = await store.captures();
    const ok = caps.filter((c) => c.outcome === 'ok');
    expect(manifest.captures).toMatchObject({ total: caps.length, ok: ok.length, last: ok.at(-1)?.fetchedAt });
    expect(manifest.chain_head).toBe(ok.at(-1)?.contentHash);
    expect(manifest.stamp).toBe(stampFor(ok.at(-1) ?? null));
    expect(manifest.files.map((f) => f.name)).toEqual(['history.parquet', 'snapshots.parquet']);

    const dir = join(out, manifest.stamp);
    for (const f of manifest.files) expect(readFileSync(join(dir, f.name)).length).toBe(f.bytes);
    expect(JSON.parse(readFileSync(join(out, 'latest.json'), 'utf8'))).toEqual(manifest);
    expect(readFileSync(join(out, 'upload.sh'), 'utf8')).toContain(`exports/${SOURCE}/${manifest.stamp}/history.parquet`);

    const hf = await asyncBufferFromFile(join(dir, 'history.parquet'));
    const md = await parquetMetadataAsync(hf);
    expect(Number(md.num_rows)).toBe(manifest.rows.history);
    expect(md.key_value_metadata?.find((k) => k.key === 'archive_api.chain_head')?.value).toBe(manifest.chain_head);
    expect(md.row_groups.length).toBeGreaterThan(1);
    const rows = (await parquetReadObjects({ file: hf })) as unknown as HistoryRow[];
    expect(rows.length).toBe(manifest.rows.history);

    const byKey = new Map<string, HistoryRow[]>();
    for (const r of rows) {
      let arr = byKey.get(r.record_key);
      if (!arr) byKey.set(r.record_key, (arr = []));
      arr.push(r);
    }
    expect(byKey.size).toBe(manifest.rows.keys);
    // Every key with any activity beyond a plain 'appeared', plus a few plain ones.
    const interesting = [...byKey.entries()].filter(([, rs]) => rs.length > 1).map(([k]) => k);
    expect(interesting.length).toBeGreaterThan(20);
    const sample = [...interesting.slice(0, 40), ...[...byKey.keys()].slice(0, 5)];
    for (const key of sample) {
      const h = await history(store, key);
      const got = byKey.get(key)!.map((r) => [r.event, r.snapshot_id, r.value_hash]);
      expect(got, key).toEqual(h.transitions.map((t) => [t.kind, t.capture.snapshotId, t.hash]));
    }
    for (const kind of ['mutated', 'removed', 'aged_out', 'reappeared']) expect(rows.some((r) => r.event === kind), kind).toBe(true);
    // Payloads are the harness's own records, verbatim.
    const withPayload = rows.filter((r) => r.payload !== null);
    expect(withPayload.length).toBe(rows.filter((r) => r.value_hash !== null).length);
    for (const r of withPayload.slice(0, 20)) {
      expect(JSON.parse(r.payload as string)).toEqual(await store.payloadOf(r.snapshot_id, r.record_key));
    }

    const snaps = await parquetReadObjects({ file: await asyncBufferFromFile(join(dir, 'snapshots.parquet')) });
    expect(snaps.length).toBe(caps.length);
    expect(snaps.map((s) => s.snapshot_id)).toEqual(caps.map((c) => c.snapshotId));
    expect(snaps.filter((s) => s.outcome !== 'ok').length).toBe(caps.length - ok.length);
    const first = snaps[0]!;
    expect(first.record_count).toBe((await store.indexOf(caps[0]!.snapshotId)).size);
    expect(typeof first.byte_length).toBe('bigint');
  });

  it('re-running on unchanged data is idempotent (same stamp, same bytes)', async () => {
    const again = await exportParquet({
      db: join(fx.dir, 'out', 'harness.sqlite'),
      payloads: join(fx.dir, 'out', 'payloads'),
      source: SOURCE,
      out: join(fx.dir, 'exports2'),
      rowGroupSize: 500,
    });
    expect(again.stamp).toBe(manifest.stamp);
    expect(again.files.map((f) => f.sha256)).toEqual(manifest.files.map((f) => f.sha256));
  });

  it('team key: grants, signs, serves; a repeat re-signs without a new grant; downloads are unmetered', async () => {
    const t = app();
    const res = await t.get(`/v1/${SOURCE}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const b = await body<{ stamp: string; grant: { repeat: boolean; allowance: string }; files: Array<{ name: string; url: string; bytes: number; sha256: string }>; links_expire_at: string; license_url: string }>(res);
    expect(b.stamp).toBe(manifest.stamp);
    expect(b.grant).toEqual({ issued_at: NOW.toISOString(), repeat: false, allowance: 'quarterly' });
    expect(b.links_expire_at).toBe(new Date(NOW.getTime() + 3600_000).toISOString());
    expect(b.license_url).toBe(manifest.source.license_url);
    expect(b.files.map((f) => f.name)).toEqual(['history.parquet', 'snapshots.parquet']);
    expect(ledger.grants).toHaveLength(1);

    const dl = await t.get(b.files[0]!.url, { anonymous: true });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/vnd.apache.parquet');
    expect(dl.headers.get('content-length')).toBe(String(b.files[0]!.bytes));
    expect(dl.headers.get('content-disposition')).toContain(`${SOURCE}-${manifest.stamp}-history.parquet`);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(readFileSync(join(out, manifest.stamp, 'history.parquet'))));
    expect(dl.headers.get('x-tier')).toBeNull();
    expect(dl.headers.get('x-ratelimit-used')).toBeNull();
    expect([...t.meter.counts.values()].reduce((a, n) => a + n, 0)).toBe(1);

    const repeat = await body<{ grant: { repeat: boolean } }>(await t.get(`/v1/${SOURCE}/export`));
    expect(repeat.grant.repeat).toBe(true);
    expect(ledger.grants).toHaveLength(1);
    expect(t.logger.entries.map((e) => e.endpoint)).toEqual(['export', 'export_file', 'export']);
  });

  it('bulk key: one export ever; a newer stamp is refused with 409 listing the one used', async () => {
    const l = new MemoryExportLedger();
    const t = app({ ledger: l });
    const { plaintext, record } = await t.mint('bulk');
    const hash = await sha256Hex(plaintext);
    const auth = { headers: { authorization: `Bearer ${plaintext}` } };
    const first = await body<{ grant: { allowance: string } }>(await t.get(`/v1/${SOURCE}/export`, auth));
    expect(first.grant.allowance).toBe('once');
    expect((await t.get(`/v1/${SOURCE}/export`, auth)).status).toBe(200);
    expect(l.grants).toHaveLength(1);

    // A newer export is published: latest.json now names a different stamp.
    const alt = join(fx.dir, 'exports-alt');
    mkdirSync(alt, { recursive: true });
    writeFileSync(join(alt, 'latest.json'), JSON.stringify({ ...manifest, stamp: 'newer-stamp' }));
    const t2 = appFor(fx.registry, { now: () => NOW, exports: { ...deps, objects: new FsObjects(alt, 'exports/'), ledger: l } });
    t2.keys.add(hash, record);
    const res = await t2.get(`/v1/${SOURCE}/export`, auth);
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({
      code: 'export_exhausted',
      allowance: 'once',
      resets_at: null,
      used: [{ source: SOURCE, stamp: manifest.stamp, issued_at: NOW.toISOString() }],
    });
    expect(l.grants).toHaveLength(1);

    // A team key in the same situation is told when its quarter resets.
    const team = appFor(fx.registry, { now: () => NOW, exports: { ...deps, objects: new FsObjects(alt, 'exports/'), ledger: l } });
    expect((await team.get(`/v1/${SOURCE}/export`)).status).toBe(200);
    const again = await team.get(`/v1/${SOURCE}/export`);
    expect((await body(again)).grant).toMatchObject({ repeat: true });
    const t3 = appFor(fx.registry, { now: () => NOW, exports: { ...deps, ledger: l } });
    const blocked = await t3.get(`/v1/${SOURCE}/export`);
    expect(blocked.status).toBe(409);
    expect(await body(blocked)).toMatchObject({ allowance: 'quarterly', resets_at: '2025-07-01T00:00:00.000Z' });
    const nextQuarter = appFor(fx.registry, { now: () => new Date('2025-07-02T00:00:00Z'), exports: { ...deps, ledger: l } });
    expect((await nextQuarter.get(`/v1/${SOURCE}/export`)).status).toBe(200);
  });

  it('free / anonymous keys get 402 with an upgrade path', async () => {
    const t = app();
    const { plaintext } = await t.mint('free');
    const res = await t.get(`/v1/${SOURCE}/export`, { headers: { authorization: `Bearer ${plaintext}` } });
    expect(res.status).toBe(402);
    expect(await body(res)).toMatchObject({ code: 'export_not_included', tier: 'free', upgrade: { tier: 'bulk', pricingUrl: expect.any(String) } });
    const anon = await t.get(`/v1/${SOURCE}/export`, { anonymous: true });
    expect(anon.status).toBe(402);
    expect(await body(anon)).toMatchObject({ code: 'export_not_included', tier: 'anonymous' });
  });

  it('unknown source → 404 unknown_source; source without a published export → 404 export_unavailable', async () => {
    const t = app();
    expect(await body(await t.get('/v1/nope/export'))).toMatchObject({ code: 'unknown_source' });
    const empty = app({ objects: new FsObjects(join(fx.dir, 'nowhere'), 'exports/') });
    const res = await empty.get(`/v1/${SOURCE}/export`);
    expect(res.status).toBe(404);
    expect(await body(res)).toMatchObject({ code: 'export_unavailable', source: SOURCE });
    expect(ledger.grants.filter((g) => g.source === 'nope')).toHaveLength(0);
  });

  it('no signing secret → 503 for both endpoints; nothing is granted', async () => {
    const l = new MemoryExportLedger();
    const t = app({ signingSecret: null, ledger: l });
    expect((await t.get(`/v1/${SOURCE}/export`)).status).toBe(503);
    expect((await t.get(`/v1/${SOURCE}/export/${manifest.stamp}/history.parquet?exp=1&sig=${'0'.repeat(64)}`, { anonymous: true })).status).toBe(503);
    expect(l.grants).toHaveLength(0);
    const off = appFor(fx.registry, { now: () => NOW });
    expect(await body(await off.get(`/v1/${SOURCE}/export`))).toMatchObject({ code: 'export_unconfigured' });
  });

  it('download links: tampered → 403, expired → 410, missing object → 404', async () => {
    const t = app();
    const b = await body<{ files: Array<{ url: string }> }>(await t.get(`/v1/${SOURCE}/export`));
    const url = new URL(`https://api.test${b.files[0]!.url}`);
    const tampered = new URL(url);
    tampered.pathname = tampered.pathname.replace('history', 'snapshots');
    const bad = await t.get(tampered.pathname + tampered.search, { anonymous: true });
    expect(bad.status).toBe(403);
    expect(await body(bad)).toMatchObject({ code: 'invalid_signature' });

    const later = appFor(fx.registry, { now: () => new Date(NOW.getTime() + 2 * 3600_000), exports: deps });
    const expired = await later.get(url.pathname + url.search, { anonymous: true });
    expect(expired.status).toBe(410);
    expect(await body(expired)).toMatchObject({ code: 'link_expired' });

    const exp = Math.floor(NOW.getTime() / 1000) + 60;
    const sig = await signLink(SECRET, SOURCE, 'gone', 'history.parquet', exp);
    const missing = await t.get(`/v1/${SOURCE}/export/gone/history.parquet?exp=${exp}&sig=${sig}`, { anonymous: true });
    expect(missing.status).toBe(404);
    expect(await body(missing)).toMatchObject({ code: 'not_found' });
  });
});
