/**
 * scripts/export-store.ts against real fixture output: a full export followed by
 * an incremental one must cover exactly the same snapshots, and applying the
 * emitted SQL to a fresh SQLite reproduces the store the Worker reads.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SMALL_PARAMS } from '@archive-api/fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportStore, type ExportResult } from '../scripts/export-store.ts';
import { buildFixture, type FixtureHarness } from './helpers.js';

let fx: FixtureHarness;
let dbPath: string;
let payloadsRoot: string;

beforeAll(() => {
  fx = buildFixture();
  dbPath = join(fx.dir, 'out', 'harness.sqlite');
  payloadsRoot = join(fx.dir, 'out', 'payloads');
}, 120_000);

afterAll(() => fx.close());

function applyTo(out: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(out, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(out).filter((n) => /^data-\d{3}\.sql$/.test(n)).sort()) {
    db.exec(readFileSync(join(out, f), 'utf8'));
  }
  return db;
}

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('exportStore', () => {
  it('full export reproduces the store row-for-row', () => {
    const out = join(fx.dir, 'full');
    const r = exportStore({ db: dbPath, payloads: payloadsRoot, out });
    const src = new DatabaseSync(dbPath, { readOnly: true });
    const dst = applyTo(out);
    for (const t of ['sources', 'snapshots', 'record_index']) expect(count(dst, t)).toBe(count(src, t));
    expect(r.snapshots).toBe(count(src, 'snapshots'));
    expect(r.recordRows).toBe(count(src, 'record_index'));
    expect(r.afterSnapshotId).toBe(0);
    expect(r.maxSnapshotId).toBe((src.prepare('SELECT MAX(id) AS m FROM snapshots').get() as { m: number }).m);
    expect(JSON.parse(readFileSync(join(out, 'watermark.json'), 'utf8'))).toEqual(r);
    src.close();
    dst.close();
  });

  it('incremental export after a watermark emits only newer snapshots and their payloads', () => {
    const src = new DatabaseSync(dbPath, { readOnly: true });
    const ids = (src.prepare('SELECT id FROM snapshots ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
    const cut = ids[Math.floor(ids.length / 2)]!;
    const out = join(fx.dir, 'incr');
    const r = exportStore({ db: dbPath, payloads: payloadsRoot, out, afterSnapshotId: cut });

    const newer = ids.filter((i) => i > cut);
    expect(r.snapshots).toBe(newer.length);
    expect(r.maxSnapshotId).toBe(ids[ids.length - 1]);

    const dst = applyTo(out);
    expect((dst.prepare('SELECT id FROM snapshots ORDER BY id').all() as Array<{ id: number }>).map((x) => x.id)).toEqual(newer);
    expect(count(dst, 'sources')).toBe(count(src, 'sources'));
    const inList = newer.join(',');
    expect(count(dst, 'record_index')).toBe(
      (src.prepare(`SELECT COUNT(*) AS n FROM record_index WHERE snapshot_id IN (${inList})`).get() as { n: number }).n,
    );

    const rawPaths = (
      src.prepare(`SELECT raw_path FROM snapshots WHERE id > ? AND raw_path IS NOT NULL ORDER BY id`).all(cut) as Array<{
        raw_path: string;
      }>
    ).map((x) => x.raw_path);
    const sh = readFileSync(join(out, 'upload-payloads.sh'), 'utf8');
    const puts = sh.split('\n').filter((l) => l.includes(' r2 object put '));
    expect(puts).toHaveLength(rawPaths.length);
    expect(r.payloadUploads).toBe(rawPaths.length);
    for (const rp of rawPaths) expect(sh).toContain(`"$BUCKET/payloads/${rp}" --file "$ROOT/${rp}"`);
    src.close();
    dst.close();
  });

  it('full then incremental applied to one database equals the full export (idempotent, append-only)', () => {
    const full = join(fx.dir, 'full');
    const incr = join(fx.dir, 'incr');
    const db = applyTo(full);
    const before = { s: count(db, 'snapshots'), r: count(db, 'record_index') };
    for (const f of readdirSync(incr).filter((n) => /^data-\d{3}\.sql$/.test(n)).sort()) {
      db.exec(readFileSync(join(incr, f), 'utf8'));
    }
    expect({ s: count(db, 'snapshots'), r: count(db, 'record_index') }).toEqual(before);
    db.close();
  });

  it('a watermark at the tip emits nothing but still refreshes sources', () => {
    const out = join(fx.dir, 'tip');
    const full: ExportResult = JSON.parse(readFileSync(join(fx.dir, 'full', 'watermark.json'), 'utf8'));
    const r = exportStore({ db: dbPath, payloads: payloadsRoot, out, afterSnapshotId: full.maxSnapshotId });
    expect(r.snapshots).toBe(0);
    expect(r.payloadUploads).toBe(0);
    expect(r.maxSnapshotId).toBe(full.maxSnapshotId);
    expect(r.sqlFiles).toBe(1);
    expect(readFileSync(join(out, 'data-001.sql'), 'utf8')).toMatch(/^INSERT OR REPLACE INTO sources/);
  });

  it('rejects an unknown --source', () => {
    expect(() => exportStore({ db: dbPath, payloads: payloadsRoot, out: join(fx.dir, 'bad'), source: 'nope' })).toThrow(
      /no source named nope/,
    );
    expect(SMALL_PARAMS.sourceName).toBe('fixture_registry');
  });
});
