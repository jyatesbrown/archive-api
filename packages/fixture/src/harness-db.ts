/**
 * Writer for harness.sqlite in the exact schema archive-harness creates
 * (contract/harness-schema.sql, copied verbatim from harness/db.py). Append-only
 * triggers are installed just as the harness does, so the fixture cannot rewrite
 * history any more than the harness can.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'contract', 'harness-schema.sql');

export type SnapshotOutcome = 'ok' | 'fetch_failed' | 'extract_failed' | 'validation_failed' | 'robots_disallowed';
export type Classification = 'append_only' | 'mutating' | 'destructive' | 'baseline';
export type KeyEvent = 'removed' | 'reappeared' | 'aged_out' | 'exited';

export interface SourceRow {
  name: string;
  tier: string;
  endpoint: string;
  format: string;
  adapter_module: string;
  adapter_config: string;
  identity_key: string;
  license_url: string;
  window_days: number | null;
  window_key_part: number | null;
  control_group: string | null;
  timeout_s: number | null;
  cadence: string | null;
  expected_silent: boolean;
  unverified_contrary_claim: boolean;
  exit_target: string | null;
  active: boolean;
  added_at: string;
}

export interface SnapshotRow {
  source_id: number;
  fetched_at: string;
  http_status: number | null;
  byte_length: number | null;
  content_hash: string | null;
  prev_hash: string | null;
  raw_path: string | null;
  adapter_version: string;
  outcome: SnapshotOutcome;
  detail: string | null;
  duration_s: number | null;
}

export interface RunDiffRow {
  source_id: number;
  snapshot_id: number;
  prev_snapshot_id: number | null;
  added: number;
  removed: number;
  mutated: number;
  aged_out: number;
  reappeared: number;
  unchanged: number;
  classification: Classification;
}

export class HarnessDb {
  readonly db: DatabaseSync;
  private readonly insRecord: StatementSync;
  private readonly insEvent: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    this.insRecord = this.db.prepare('INSERT INTO record_index (snapshot_id, record_key, value_hash) VALUES (?, ?, ?)');
    this.insEvent = this.db.prepare(
      'INSERT INTO key_events (source_id, snapshot_id, record_key, event) VALUES (?, ?, ?, ?)',
    );
  }

  close(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  addSource(s: SourceRow): number {
    const r = this.db
      .prepare(
        `INSERT INTO sources (name,tier,endpoint,format,adapter_module,adapter_config,identity_key,license_url,
         window_days,window_key_part,control_group,timeout_s,cadence,expected_silent,unverified_contrary_claim,
         exit_target,active,added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.name,
        s.tier,
        s.endpoint,
        s.format,
        s.adapter_module,
        s.adapter_config,
        s.identity_key,
        s.license_url,
        s.window_days,
        s.window_key_part,
        s.control_group,
        s.timeout_s,
        s.cadence,
        s.expected_silent ? 1 : 0,
        s.unverified_contrary_claim ? 1 : 0,
        s.exit_target,
        s.active ? 1 : 0,
        s.added_at,
      );
    return Number(r.lastInsertRowid);
  }

  addSnapshot(s: SnapshotRow): number {
    const r = this.db
      .prepare(
        `INSERT INTO snapshots (source_id,fetched_at,http_status,byte_length,content_hash,prev_hash,raw_path,
         adapter_version,outcome,detail,duration_s) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.source_id,
        s.fetched_at,
        s.http_status,
        s.byte_length,
        s.content_hash,
        s.prev_hash,
        s.raw_path,
        s.adapter_version,
        s.outcome,
        s.detail,
        s.duration_s,
      );
    return Number(r.lastInsertRowid);
  }

  addRecords(snapshotId: number, pairs: Iterable<readonly [string, string]>): void {
    for (const [key, hash] of pairs) this.insRecord.run(snapshotId, key, hash);
  }

  addRunDiff(d: RunDiffRow): number {
    const r = this.db
      .prepare(
        `INSERT INTO run_diffs (source_id,snapshot_id,prev_snapshot_id,added,removed,mutated,aged_out,reappeared,
         unchanged,classification) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        d.source_id,
        d.snapshot_id,
        d.prev_snapshot_id,
        d.added,
        d.removed,
        d.mutated,
        d.aged_out,
        d.reappeared,
        d.unchanged,
        d.classification,
      );
    return Number(r.lastInsertRowid);
  }

  addHealth(
    sourceId: number,
    snapshotId: number,
    fingerprint: string,
    recordCount: number,
    drifted: boolean,
    driftDetail: string | null,
  ): void {
    this.db
      .prepare(
        'INSERT INTO source_health (source_id,snapshot_id,fingerprint,record_count,drifted,drift_detail) VALUES (?,?,?,?,?,?)',
      )
      .run(sourceId, snapshotId, fingerprint, recordCount, drifted ? 1 : 0, driftDetail);
  }

  addKeyEvents(sourceId: number, snapshotId: number, event: KeyEvent, keys: readonly string[]): void {
    for (const k of keys) this.insEvent.run(sourceId, snapshotId, k, event);
  }

  addAlert(raisedAt: string, kind: string, message: string, sourceId: number | null, snapshotId: number | null): void {
    this.db
      .prepare('INSERT INTO alerts (raised_at,source_id,snapshot_id,kind,message) VALUES (?,?,?,?,?)')
      .run(raisedAt, sourceId, snapshotId, kind, message);
  }
}
