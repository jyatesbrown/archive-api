import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SMALL_PARAMS, writeFixture, type FixtureManifest, type FixtureParams, type WriteResult } from '../src/index.js';

export interface Fixture extends WriteResult {
  dir: string;
  db: DatabaseSync;
  /** value hashes indexed for a successful snapshot, keyed by record_key */
  indexFor(snapshotId: number): Map<string, string>;
  /** parsed raw payload for a snapshot */
  payloadFor(snapshotId: number): { records: Array<Record<string, unknown>> };
  snapshotOnDay(day: number): FixtureManifest['snapshots'][number];
  close(): void;
}

export function buildFixture(params: FixtureParams = SMALL_PARAMS): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'archive-fixture-'));
  const res = writeFixture(params, join(dir, 'out'));
  const db = new DatabaseSync(res.dbPath, { readOnly: true });
  return {
    ...res,
    dir,
    db,
    indexFor(snapshotId) {
      const rows = db
        .prepare('SELECT record_key, value_hash FROM record_index WHERE snapshot_id = ?')
        .all(snapshotId) as Array<{ record_key: string; value_hash: string }>;
      return new Map(rows.map((r) => [r.record_key, r.value_hash]));
    },
    payloadFor(snapshotId) {
      const row = db.prepare('SELECT raw_path FROM snapshots WHERE id = ?').get(snapshotId) as
        | { raw_path: string }
        | undefined;
      if (!row) throw new Error(`no snapshot ${snapshotId}`);
      return JSON.parse(readFileSync(join(res.payloadsRoot, row.raw_path), 'utf8'));
    },
    snapshotOnDay(day) {
      const s = res.manifest.snapshots[day];
      if (!s) throw new Error(`no day ${day}`);
      return s;
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function okSnapshotId(fx: Fixture, day: number): number {
  const s = fx.snapshotOnDay(day);
  if (s.snapshotId === null || s.outcome !== 'ok') throw new Error(`day ${day} is not an ok snapshot`);
  return s.snapshotId;
}
