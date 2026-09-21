/**
 * `SnapshotStore` over the harness schema (sources / snapshots / record_index)
 * behind a minimal async SQL client, plus a blob reader for raw payloads.
 * Production binds these to D1 and R2 (see ./cloudflare.ts); tests bind them to
 * node:sqlite and the local filesystem. Read-only by construction: the client
 * interface has no exec/run.
 */
import { dateOf, type Capture, type CaptureOutcome, type JsonValue, type SnapshotStore, type SourceMeta } from '@archive-api/engine';

import type { SourceConfigMap, SourceRegistry, SourceSummary } from '../registry.js';

/** harness.adapter.KEY_SEP / harness.adapters.base.PAGE_SEP */
export const KEY_SEP = '|';
export const PAGE_SEP = '\n--archive-harness-page--\n';

/** harness.adapters.generic_json.date_part: ISO prefix, or epoch milliseconds. */
function datePart(v: JsonValue): string {
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export type SqlValue = string | number | null;

export interface SqlClient {
  all<T>(sql: string, params: readonly SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params: readonly SqlValue[]): Promise<T | null>;
}

export interface BlobReader {
  /** UTF-8 text of the object at `key`, or null when absent. */
  text(key: string): Promise<string | null>;
}

export interface SourceRow {
  id: number;
  name: string;
  endpoint: string;
  adapter_config: string;
  window_days: number | null;
  window_key_part: number | null;
}

interface SnapshotRow {
  id: number;
  fetched_at: string;
  outcome: CaptureOutcome;
  content_hash: string | null;
  prev_hash: string | null;
  raw_path: string | null;
  adapter_version: string;
}

/** harness.adapters.generic_json adapter_config. */
export interface GenericJsonConfig {
  key_fields: string[];
  records_path?: string | null;
  key_date_field?: string | null;
}

/**
 * Raw capture text -> record_key -> record, exactly as the harness indexed it.
 * Mirrors harness.adapters.generic_json: pages are joined by PAGE_SEP,
 * records_path is a dotted path into each page ('' = top-level array); key is
 * [date_part(key_date_field)] + key_fields joined by KEY_SEP.
 */
export function indexRawPayload(text: string, cfg: GenericJsonConfig): Map<string, JsonValue> {
  const out = new Map<string, JsonValue>();
  for (const page of text.split(PAGE_SEP)) {
    for (const r of recordsOf(JSON.parse(page) as JsonValue, cfg)) out.set(recordKeyOf(r, cfg), r);
  }
  return out;
}

function recordsOf(doc: JsonValue, cfg: GenericJsonConfig): Array<Record<string, JsonValue>> {
  let cur: JsonValue = doc;
  for (const part of (cfg.records_path ?? '').split('.').filter((p) => p !== '')) {
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)] ?? null;
    else if (typeof cur === 'object' && cur !== null && !Array.isArray(cur)) cur = cur[part] ?? null;
    else return [];
  }
  if (!Array.isArray(cur)) return [];
  return cur.filter((r): r is Record<string, JsonValue> => typeof r === 'object' && r !== null && !Array.isArray(r));
}

function recordKeyOf(r: Record<string, JsonValue>, cfg: GenericJsonConfig): string {
  const parts = cfg.key_fields.map((f) => String(r[f]));
  const df = cfg.key_date_field;
  if (df) parts.unshift(datePart(r[df] ?? null));
  return parts.join(KEY_SEP);
}

export class SqlStore implements SnapshotStore {
  readonly source: SourceMeta;
  private capsPromise: Promise<readonly Capture[]> | null = null;
  private readonly payloadCache = new Map<number, Promise<ReadonlyMap<string, JsonValue> | null>>();
  private readonly cfg: GenericJsonConfig;

  constructor(
    private readonly sql: SqlClient,
    private readonly blobs: BlobReader,
    private readonly payloadPrefix: string,
    row: SourceRow,
    entityFields: readonly string[],
  ) {
    this.cfg = JSON.parse(row.adapter_config) as GenericJsonConfig;
    this.source = {
      id: row.id,
      name: row.name,
      upstreamUrl: row.endpoint,
      windowDays: row.window_days,
      windowKeyPart: row.window_key_part ?? 0,
      entityFields,
    };
  }

  captures(): Promise<readonly Capture[]> {
    this.capsPromise ??= this.sql
      .all<SnapshotRow>(
        'SELECT id, fetched_at, outcome, content_hash, prev_hash, raw_path, adapter_version FROM snapshots WHERE source_id = ? ORDER BY id',
        [this.source.id],
      )
      .then((rows) =>
        rows.map((r, i) => ({
          snapshotId: r.id,
          fetchedAt: r.fetched_at,
          date: dateOf(r.fetched_at),
          outcome: r.outcome,
          contentHash: r.content_hash,
          prevHash: r.prev_hash,
          rawPath: r.raw_path,
          adapterVersion: r.adapter_version,
          chainIndex: i,
        })),
      );
    return this.capsPromise;
  }

  async hashOf(snapshotId: number, key: string): Promise<string | null> {
    const row = await this.sql.first<{ value_hash: string }>(
      'SELECT value_hash FROM record_index WHERE snapshot_id = ? AND record_key = ?',
      [snapshotId, key],
    );
    return row?.value_hash ?? null;
  }

  /** Batched hashOf; chunked to stay under D1's bound-parameter limit. */
  async hashesOf(snapshotId: number, keys: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    const CHUNK = 90;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const rows = await this.sql.all<{ record_key: string; value_hash: string }>(
        `SELECT record_key, value_hash FROM record_index WHERE snapshot_id = ? AND record_key IN (${chunk.map(() => '?').join(',')})`,
        [snapshotId, ...chunk],
      );
      for (const r of rows) out.set(r.record_key, r.value_hash);
    }
    return out;
  }

  async indexOf(snapshotId: number): Promise<ReadonlyMap<string, string>> {
    const rows = await this.sql.all<{ record_key: string; value_hash: string }>(
      'SELECT record_key, value_hash FROM record_index WHERE snapshot_id = ?',
      [snapshotId],
    );
    return new Map(rows.map((r) => [r.record_key, r.value_hash]));
  }

  async presenceOf(key: string): Promise<ReadonlyMap<number, string>> {
    const rows = await this.sql.all<{ snapshot_id: number; value_hash: string }>(
      'SELECT ri.snapshot_id, ri.value_hash FROM record_index ri JOIN snapshots s ON s.id = ri.snapshot_id WHERE s.source_id = ? AND ri.record_key = ?',
      [this.source.id, key],
    );
    return new Map(rows.map((r) => [r.snapshot_id, r.value_hash]));
  }

  async payloadOf(snapshotId: number, key: string): Promise<JsonValue | null> {
    let p = this.payloadCache.get(snapshotId);
    if (!p) {
      p = this.loadPayload(snapshotId);
      this.payloadCache.set(snapshotId, p);
    }
    return (await p)?.get(key) ?? null;
  }

  private async loadPayload(snapshotId: number): Promise<ReadonlyMap<string, JsonValue> | null> {
    const cap = (await this.captures()).find((c) => c.snapshotId === snapshotId);
    if (!cap?.rawPath) return null;
    const text = await this.blobs.text(this.payloadPrefix + cap.rawPath);
    if (text === null) return null;
    return indexRawPayload(text, this.cfg);
  }
}

export class SqlRegistry implements SourceRegistry {
  constructor(
    private readonly sql: SqlClient,
    private readonly blobs: BlobReader,
    private readonly payloadPrefix: string,
    private readonly config: SourceConfigMap,
  ) {}

  private store(row: SourceRow): SqlStore {
    return new SqlStore(this.sql, this.blobs, this.payloadPrefix, row, this.config[row.name]?.entityFields ?? []);
  }

  async list(): Promise<readonly SourceSummary[]> {
    const rows = await this.sql.all<SourceRow>(
      'SELECT id, name, endpoint, adapter_config, window_days, window_key_part FROM sources ORDER BY name',
      [],
    );
    const out: SourceSummary[] = [];
    for (const row of rows) {
      const agg = await this.sql.first<{
        n: number;
        ok: number;
        first_ok: string | null;
        last_ok: string | null;
      }>(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
                MIN(CASE WHEN outcome = 'ok' THEN fetched_at END) AS first_ok,
                MAX(CASE WHEN outcome = 'ok' THEN fetched_at END) AS last_ok
           FROM snapshots WHERE source_id = ?`,
        [row.id],
      );
      out.push({
        id: row.id,
        name: row.name,
        upstreamUrl: row.endpoint,
        windowDays: row.window_days,
        captures: agg?.n ?? 0,
        okCaptures: agg?.ok ?? 0,
        firstCapture: agg?.first_ok ? dateOf(agg.first_ok) : null,
        lastCapture: agg?.last_ok ? dateOf(agg.last_ok) : null,
      });
    }
    return out;
  }

  async get(name: string): Promise<SqlStore | null> {
    const row = await this.sql.first<SourceRow>(
      'SELECT id, name, endpoint, adapter_config, window_days, window_key_part FROM sources WHERE name = ?',
      [name],
    );
    return row ? this.store(row) : null;
  }
}
