/**
 * Bulk export: one source's full history as Parquet, for the Team (quarterly)
 * and Bulk (one-off) tiers. Runs on a box that has the harness SQLite database
 * and raw payloads (the same inputs as export-store.ts); never in the Worker.
 *
 * Output:  <out>/<stamp>/history.parquet    one row per key transition
 *          <out>/<stamp>/snapshots.parquet  the capture chain (incl. failed runs)
 *          <out>/<stamp>/manifest.json      files + sha256 + provenance
 *          <out>/latest.json                copy of the manifest (Worker reads this)
 *          <out>/upload.sh                  wrangler r2 object put commands
 *
 * `stamp` is derived from the last ok capture, so re-running on unchanged data
 * produces the same stamp. Rows follow the engine's history semantics: a key
 * appears, mutates (value_hash changes), is removed, ages out of the source's
 * rolling window, or reappears. Failed captures contribute no history rows;
 * they are visible in snapshots.parquet as gaps in evidence, not as absence.
 *
 * Runtime dependency (job only, not the Worker): hyparquet-writer — single-dep
 * pure-JS Parquet writer with row streaming, so peak memory is one row group.
 * Imports the built package (../dist) like mint-key.ts: `pnpm build` first.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { dateOf, isOutsideWindow, type Capture, type JsonValue, type SourceMeta } from '@archive-api/engine';
import { fileWriter, parquetWriteRows } from 'hyparquet-writer';

import { indexRawPayload, type GenericJsonConfig } from '../dist/stores/sql-store.js';

export const EXPORT_SCHEMA_VERSION = 1;

export interface ParquetExportOptions {
  db: string;
  payloads: string;
  source: string;
  out: string;
  bucket?: string;
  /** R2 key prefix for exports (Worker `EXPORT_PREFIX`). */
  prefix?: string;
  rowGroupSize?: number;
}

export type HistoryEvent = 'appeared' | 'mutated' | 'removed' | 'aged_out' | 'reappeared';

export interface HistoryRow {
  record_key: string;
  event: HistoryEvent;
  snapshot_id: number;
  chain_index: number;
  captured_at: string;
  capture_date: string;
  value_hash: string | null;
  payload: string | null;
  content_hash: string | null;
}

export interface SnapshotRow {
  snapshot_id: number;
  chain_index: number;
  fetched_at: string;
  capture_date: string;
  outcome: string;
  content_hash: string | null;
  prev_hash: string | null;
  raw_path: string | null;
  byte_length: bigint | null;
  adapter_version: string;
  record_count: number | null;
}

export interface ExportFile {
  name: string;
  content_type: string;
  bytes: number;
  sha256: string;
  rows: number;
}

export interface ExportManifest {
  schema_version: number;
  stamp: string;
  generated_at: string;
  source: { id: number; name: string; endpoint: string; license_url: string; window_days: number | null };
  captures: { total: number; ok: number; first: string | null; last: string | null; snapshot_ids: [number, number] | null };
  /** content_hash of the last ok capture: the chain head this export is evidence of. */
  chain_head: string | null;
  rows: { history: number; snapshots: number; keys: number };
  files: ExportFile[];
}

interface SourceRow {
  id: number;
  name: string;
  endpoint: string;
  adapter_config: string;
  license_url: string;
  window_days: number | null;
  window_key_part: number | null;
}

interface DbSnapshot {
  id: number;
  fetched_at: string;
  outcome: string;
  content_hash: string | null;
  prev_hash: string | null;
  raw_path: string | null;
  byte_length: number | null;
  adapter_version: string;
}

export function stampFor(last: Capture | null): string {
  if (!last) return 'empty';
  return `${last.fetchedAt.replace(/[-:]/g, '').replace(/\.\d+/, '')}-${(last.contentHash ?? '').slice(0, 12)}`;
}

/**
 * Derive history rows from the capture chain. Pure: `indexOf`/`payloadOf`
 * are injected so tests can run it in memory. Emits per capture in chain
 * order; the caller streams rows into the Parquet writer.
 */
export function* historyRows(
  meta: SourceMeta,
  captures: readonly Capture[],
  indexOf: (snapshotId: number) => ReadonlyMap<string, string>,
  payloadOf: (snapshotId: number) => ReadonlyMap<string, JsonValue> | null,
  stats: { keys: Set<string> },
): Generator<HistoryRow> {
  let prev: ReadonlyMap<string, string> = new Map();
  const everSeen = new Set<string>();
  for (const cap of captures) {
    if (cap.outcome !== 'ok') continue;
    const cur = indexOf(cap.snapshotId);
    let payloads: ReadonlyMap<string, JsonValue> | null | undefined;
    const payload = (key: string): string | null => {
      if (payloads === undefined) payloads = payloadOf(cap.snapshotId);
      const v = payloads?.get(key);
      return v === undefined ? null : JSON.stringify(v);
    };
    const base = {
      snapshot_id: cap.snapshotId,
      chain_index: cap.chainIndex,
      captured_at: cap.fetchedAt,
      capture_date: cap.date,
      content_hash: cap.contentHash,
    };
    for (const [key, hash] of cur) {
      const before = prev.get(key);
      if (before === hash) continue;
      let event: HistoryEvent;
      if (before === undefined) event = everSeen.has(key) ? 'reappeared' : 'appeared';
      else event = 'mutated';
      everSeen.add(key);
      stats.keys.add(key);
      yield { record_key: key, event, value_hash: hash, payload: payload(key), ...base };
    }
    for (const key of prev.keys()) {
      if (cur.has(key)) continue;
      const event: HistoryEvent = isOutsideWindow(meta, key, cap.date) ? 'aged_out' : 'removed';
      yield { record_key: key, event, value_hash: null, payload: null, ...base };
    }
    prev = cur;
  }
}

const HISTORY_COLUMNS = [
  { name: 'record_key', type: 'STRING', nullable: false },
  { name: 'event', type: 'STRING', nullable: false },
  { name: 'snapshot_id', type: 'INT32', nullable: false },
  { name: 'chain_index', type: 'INT32', nullable: false },
  { name: 'captured_at', type: 'STRING', nullable: false },
  { name: 'capture_date', type: 'STRING', nullable: false },
  { name: 'value_hash', type: 'STRING' },
  { name: 'payload', type: 'JSON' },
  { name: 'content_hash', type: 'STRING' },
] as const;

const SNAPSHOT_COLUMNS = [
  { name: 'snapshot_id', type: 'INT32', nullable: false },
  { name: 'chain_index', type: 'INT32', nullable: false },
  { name: 'fetched_at', type: 'STRING', nullable: false },
  { name: 'capture_date', type: 'STRING', nullable: false },
  { name: 'outcome', type: 'STRING', nullable: false },
  { name: 'content_hash', type: 'STRING' },
  { name: 'prev_hash', type: 'STRING' },
  { name: 'raw_path', type: 'STRING' },
  { name: 'byte_length', type: 'INT64' },
  { name: 'adapter_version', type: 'STRING', nullable: false },
  { name: 'record_count', type: 'INT32' },
] as const;

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function* counting<T>(it: Iterable<T>, n: { rows: number }): Generator<T> {
  for (const r of it) {
    n.rows++;
    yield r;
  }
}

export async function exportParquet(opts: ParquetExportOptions): Promise<ExportManifest> {
  const prefix = opts.prefix ?? 'exports/';
  const db = new DatabaseSync(opts.db, { readOnly: true });
  try {
    const src = db
      .prepare('SELECT id, name, endpoint, adapter_config, license_url, window_days, window_key_part FROM sources WHERE name = ?')
      .get(opts.source) as SourceRow | undefined;
    if (!src) throw new Error(`source '${opts.source}' not found in ${opts.db}`);
    const cfg = JSON.parse(src.adapter_config) as GenericJsonConfig;
    const meta: SourceMeta = {
      id: src.id,
      name: src.name,
      upstreamUrl: src.endpoint,
      windowDays: src.window_days,
      windowKeyPart: src.window_key_part ?? 0,
      entityFields: [],
    };
    const snaps = db
      .prepare(
        'SELECT id, fetched_at, outcome, content_hash, prev_hash, raw_path, byte_length, adapter_version FROM snapshots WHERE source_id = ? ORDER BY id',
      )
      .all(src.id) as unknown as DbSnapshot[];
    const captures: Capture[] = snaps.map((r, i) => ({
      snapshotId: r.id,
      fetchedAt: r.fetched_at,
      date: dateOf(r.fetched_at),
      outcome: r.outcome as Capture['outcome'],
      contentHash: r.content_hash,
      prevHash: r.prev_hash,
      rawPath: r.raw_path,
      adapterVersion: r.adapter_version,
      chainIndex: i,
    }));
    const ok = captures.filter((c) => c.outcome === 'ok');
    const last = ok.at(-1) ?? null;
    const stamp = stampFor(last);
    const dir = join(opts.out, stamp);
    mkdirSync(dir, { recursive: true });

    const indexStmt = db.prepare('SELECT record_key, value_hash FROM record_index WHERE snapshot_id = ?');
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM record_index WHERE snapshot_id = ?');
    const indexOf = (id: number): ReadonlyMap<string, string> =>
      new Map((indexStmt.all(id) as unknown as Array<{ record_key: string; value_hash: string }>).map((r) => [r.record_key, r.value_hash]));
    const rawOf = new Map(captures.map((c) => [c.snapshotId, c.rawPath]));
    const payloadOf = (id: number): ReadonlyMap<string, JsonValue> | null => {
      const rp = rawOf.get(id);
      if (!rp) return null;
      return indexRawPayload(readFileSync(join(opts.payloads, rp), 'utf8'), cfg);
    };

    const kv = [
      { key: 'archive_api.schema_version', value: String(EXPORT_SCHEMA_VERSION) },
      { key: 'archive_api.source', value: src.name },
      { key: 'archive_api.stamp', value: stamp },
      { key: 'archive_api.chain_head', value: last?.contentHash ?? '' },
    ];
    const rowGroupSize = opts.rowGroupSize ?? 50_000;

    const stats = { keys: new Set<string>() };
    const hist = { rows: 0 };
    const historyPath = join(dir, 'history.parquet');
    await parquetWriteRows({
      writer: fileWriter(historyPath),
      rows: counting(historyRows(meta, captures, indexOf, payloadOf, stats), hist),
      columns: HISTORY_COLUMNS.map((c) => ({ ...c })),
      kvMetadata: kv,
      rowGroupSize,
    });

    const snapRows: SnapshotRow[] = snaps.map((r, i) => ({
      snapshot_id: r.id,
      chain_index: i,
      fetched_at: r.fetched_at,
      capture_date: dateOf(r.fetched_at),
      outcome: r.outcome,
      content_hash: r.content_hash,
      prev_hash: r.prev_hash,
      raw_path: r.raw_path,
      byte_length: r.byte_length === null ? null : BigInt(r.byte_length),
      adapter_version: r.adapter_version,
      record_count: r.outcome === 'ok' ? Number((countStmt.get(r.id) as { n: number }).n) : null,
    }));
    const snapshotsPath = join(dir, 'snapshots.parquet');
    await parquetWriteRows({
      writer: fileWriter(snapshotsPath),
      rows: snapRows,
      columns: SNAPSHOT_COLUMNS.map((c) => ({ ...c })),
      kvMetadata: kv,
      rowGroupSize,
    });

    const file = (name: string, path: string, rows: number): ExportFile => ({
      name,
      content_type: 'application/vnd.apache.parquet',
      bytes: statSync(path).size,
      sha256: sha256File(path),
      rows,
    });
    const manifest: ExportManifest = {
      schema_version: EXPORT_SCHEMA_VERSION,
      stamp,
      generated_at: new Date().toISOString(),
      source: { id: src.id, name: src.name, endpoint: src.endpoint, license_url: src.license_url, window_days: src.window_days },
      captures: {
        total: captures.length,
        ok: ok.length,
        first: ok[0]?.fetchedAt ?? null,
        last: last?.fetchedAt ?? null,
        snapshot_ids: captures.length ? [captures[0]!.snapshotId, captures.at(-1)!.snapshotId] : null,
      },
      chain_head: last?.contentHash ?? null,
      rows: { history: hist.rows, snapshots: snapRows.length, keys: stats.keys.size },
      files: [file('history.parquet', historyPath, hist.rows), file('snapshots.parquet', snapshotsPath, snapRows.length)],
    };
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(dir, 'manifest.json'), manifestJson);
    writeFileSync(join(opts.out, 'latest.json'), manifestJson);
    writeFileSync(join(opts.out, 'upload.sh'), uploadScript(opts, prefix, src.name, stamp, manifest), { mode: 0o755 });
    return manifest;
  } finally {
    db.close();
  }
}

function uploadScript(opts: ParquetExportOptions, prefix: string, source: string, stamp: string, m: ExportManifest): string {
  const bucket = opts.bucket ?? 'archive-store';
  const lines = [
    '#!/usr/bin/env bash',
    `# Generated by parquet-export.ts for ${source} @ ${stamp}. Pass --local to target the local dev bucket.`,
    'set -euo pipefail',
    'FLAGS="${1:-}"',
    'WRANGLER="${WRANGLER:-$(command -v wrangler || echo "pnpm exec wrangler")}"',
    `BUCKET="\${BUCKET:-${bucket}}"`,
    `ROOT="$(cd "$(dirname "$0")" && pwd)"`,
  ];
  for (const f of [...m.files, { name: 'manifest.json', content_type: 'application/json' }]) {
    lines.push(
      `$WRANGLER r2 object put $FLAGS "$BUCKET/${prefix}${source}/${stamp}/${f.name}" --file "$ROOT/${stamp}/${f.name}" --content-type ${f.content_type}`,
    );
  }
  lines.push(`$WRANGLER r2 object put $FLAGS "$BUCKET/${prefix}${source}/latest.json" --file "$ROOT/latest.json" --content-type application/json`);
  return `${lines.join('\n')}\n`;
}
