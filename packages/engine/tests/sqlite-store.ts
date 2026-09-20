/**
 * Test-only `SnapshotStore` over a harness SQLite database + payload directory,
 * as written by @archive-api/fixture. Reads only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { dateOf, type Capture, type CaptureOutcome, type JsonValue, type SnapshotStore, type SourceMeta } from '../src/index.js';

interface SnapshotRow {
  id: number;
  fetched_at: string;
  outcome: CaptureOutcome;
  content_hash: string | null;
  prev_hash: string | null;
  raw_path: string | null;
  adapter_version: string;
}

export class SqliteStore implements SnapshotStore {
  readonly source: SourceMeta;
  private readonly db: DatabaseSync;
  private readonly payloadsRoot: string;
  private readonly caps: Capture[];
  private readonly payloadCache = new Map<number, Map<string, JsonValue>>();
  private readonly keyFields: string[];
  private readonly keyDateField: string | null;

  constructor(dbPath: string, payloadsRoot: string, entityFields: readonly string[] = []) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.payloadsRoot = payloadsRoot;
    const src = this.db.prepare('SELECT * FROM sources LIMIT 1').get() as {
      id: number;
      name: string;
      endpoint: string;
      window_days: number | null;
      window_key_part: number | null;
      adapter_config: string;
    };
    const cfg = JSON.parse(src.adapter_config) as {
      key_fields: string[];
      key_date_field: string | null;
    };
    this.keyFields = cfg.key_fields;
    this.keyDateField = cfg.key_date_field;
    this.source = {
      id: src.id,
      name: src.name,
      upstreamUrl: src.endpoint,
      windowDays: src.window_days,
      windowKeyPart: src.window_key_part ?? 0,
      entityFields,
    };
    const rows = this.db
      .prepare('SELECT id, fetched_at, outcome, content_hash, prev_hash, raw_path, adapter_version FROM snapshots WHERE source_id = ? ORDER BY id')
      .all(src.id) as unknown as SnapshotRow[];
    this.caps = rows.map((r, i) => ({
      snapshotId: r.id,
      fetchedAt: r.fetched_at,
      date: dateOf(r.fetched_at),
      outcome: r.outcome,
      contentHash: r.content_hash,
      prevHash: r.prev_hash,
      rawPath: r.raw_path,
      adapterVersion: r.adapter_version,
      chainIndex: i,
    }));
  }

  close(): void {
    this.db.close();
  }

  captures(): Promise<readonly Capture[]> {
    return Promise.resolve(this.caps);
  }

  hashOf(snapshotId: number, key: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT value_hash FROM record_index WHERE snapshot_id = ? AND record_key = ?')
      .get(snapshotId, key) as { value_hash: string } | undefined;
    return Promise.resolve(row?.value_hash ?? null);
  }

  indexOf(snapshotId: number): Promise<ReadonlyMap<string, string>> {
    const rows = this.db
      .prepare('SELECT record_key, value_hash FROM record_index WHERE snapshot_id = ?')
      .all(snapshotId) as unknown as Array<{ record_key: string; value_hash: string }>;
    return Promise.resolve(new Map(rows.map((r) => [r.record_key, r.value_hash])));
  }

  presenceOf(key: string): Promise<ReadonlyMap<number, string>> {
    const rows = this.db
      .prepare('SELECT snapshot_id, value_hash FROM record_index WHERE record_key = ?')
      .all(key) as unknown as Array<{ snapshot_id: number; value_hash: string }>;
    return Promise.resolve(new Map(rows.map((r) => [r.snapshot_id, r.value_hash])));
  }

  payloadOf(snapshotId: number, key: string): Promise<JsonValue | null> {
    let recs = this.payloadCache.get(snapshotId);
    if (!recs) {
      const cap = this.caps.find((c) => c.snapshotId === snapshotId);
      if (!cap?.rawPath) return Promise.resolve(null);
      const doc = JSON.parse(readFileSync(join(this.payloadsRoot, cap.rawPath), 'utf8')) as {
        records: Array<Record<string, JsonValue>>;
      };
      recs = new Map();
      for (const r of doc.records) {
        const parts = this.keyFields.map((f) => String(r[f]));
        if (this.keyDateField !== null) parts.unshift(String(r[this.keyDateField]).slice(0, 10));
        recs.set(parts.join('|'), r);
      }
      this.payloadCache.set(snapshotId, recs);
    }
    return Promise.resolve(recs.get(key) ?? null);
  }
}
