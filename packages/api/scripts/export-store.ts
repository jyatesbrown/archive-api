/**
 * Project a harness store (SQLite + raw payload tree) into artefacts that
 * `wrangler` can apply to the Worker's D1/R2 bindings. Pure file output; nothing
 * here talks to Cloudflare.
 *
 *   <out>/schema.sql          the tables the API reads (idempotent CREATE IF NOT EXISTS)
 *   <out>/data-NNN.sql        INSERT OR IGNORE batches, harness primary keys preserved
 *   <out>/upload-payloads.sh  `wrangler r2 object put` per new raw payload
 *   <out>/watermark.json      { afterSnapshotId, maxSnapshotId, snapshots }
 *
 * With `afterSnapshotId`, only snapshots with id > afterSnapshotId (and their
 * record_index rows / payloads) are emitted, which makes a daily sync cheap:
 * the harness only ever appends snapshots, so the max id already in D1 is a
 * complete description of what D1 has. `sources` rows are always re-emitted
 * (INSERT OR REPLACE) so metadata edits in the harness propagate.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ExportOptions {
  db: string;
  payloads: string;
  out: string;
  bucket?: string;
  prefix?: string;
  source?: string;
  afterSnapshotId?: number;
  batchRows?: number;
}

export interface ExportResult {
  sources: number;
  snapshots: number;
  recordRows: number;
  sqlFiles: number;
  payloadUploads: number;
  afterSnapshotId: number;
  maxSnapshotId: number;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL, endpoint TEXT NOT NULL, format TEXT NOT NULL,
    adapter_module TEXT NOT NULL, adapter_config TEXT NOT NULL DEFAULT '{}', identity_key TEXT NOT NULL, license_url TEXT NOT NULL,
    window_days INTEGER, window_key_part INTEGER, control_group TEXT, timeout_s REAL, cadence TEXT,
    expected_silent INTEGER NOT NULL DEFAULT 0, unverified_contrary_claim INTEGER NOT NULL DEFAULT 0, exit_target TEXT,
    active INTEGER NOT NULL DEFAULT 1, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id), fetched_at TEXT NOT NULL, http_status INTEGER,
    byte_length INTEGER, content_hash TEXT, prev_hash TEXT, raw_path TEXT, adapter_version TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok','fetch_failed','extract_failed','validation_failed','robots_disallowed')),
    detail TEXT, duration_s REAL);
CREATE INDEX IF NOT EXISTS snapshots_source_idx ON snapshots(source_id, id);
CREATE TABLE IF NOT EXISTS record_index (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id), record_key TEXT NOT NULL, value_hash TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, record_key)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS record_index_key_idx ON record_index(record_key, snapshot_id);
`.trimStart();

type Row = Record<string, string | number | null>;

const lit = (v: string | number | null): string =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`;

/** D1 rejects statements over ~100 KB (SQLITE_TOOBIG); keep each INSERT well under that. */
const ROWS_PER_STATEMENT = 400;

function insertsFor(table: string, rows: Row[], verb: 'INSERT OR IGNORE' | 'INSERT OR REPLACE'): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0] as Row);
  let sql = '';
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const vals = rows
      .slice(i, i + ROWS_PER_STATEMENT)
      .map((r) => `(${cols.map((c) => lit(r[c] ?? null)).join(',')})`)
      .join(',\n');
    sql += `${verb} INTO ${table} (${cols.join(',')}) VALUES\n${vals};\n`;
  }
  return sql;
}

export function exportStore(opts: ExportOptions): ExportResult {
  const bucket = opts.bucket ?? 'archive-store';
  const prefix = opts.prefix ?? 'payloads/';
  const after = opts.afterSnapshotId ?? 0;
  const batchRows = opts.batchRows ?? 5000;

  const db = new DatabaseSync(opts.db, { readOnly: true });
  try {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, 'schema.sql'), SCHEMA);

    const sources = (
      opts.source
        ? db.prepare('SELECT * FROM sources WHERE name = ?').all(opts.source)
        : db.prepare('SELECT * FROM sources').all()
    ) as Row[];
    if (sources.length === 0) throw new Error(opts.source ? `no source named ${opts.source}` : 'no sources in store');
    const sourceIds = sources.map((s) => s['id'] as number);
    const inList = sourceIds.map(() => '?').join(',');

    let fileNo = 0;
    const emit = (sql: string): void => {
      if (sql === '') return;
      fileNo++;
      writeFileSync(join(opts.out, `data-${String(fileNo).padStart(3, '0')}.sql`), sql);
    };

    emit(insertsFor('sources', sources, 'INSERT OR REPLACE'));

    const snapshots = db
      .prepare(`SELECT * FROM snapshots WHERE source_id IN (${inList}) AND id > ? ORDER BY id`)
      .all(...sourceIds, after) as Row[];
    for (let i = 0; i < snapshots.length; i += batchRows) {
      emit(insertsFor('snapshots', snapshots.slice(i, i + batchRows), 'INSERT OR IGNORE'));
    }

    const byId = db.prepare('SELECT snapshot_id, record_key, value_hash FROM record_index WHERE snapshot_id = ?');
    let recordRows = 0;
    let pending: Row[] = [];
    for (const s of snapshots) {
      const rows = byId.all(s['id'] as number) as Row[];
      recordRows += rows.length;
      pending.push(...rows);
      while (pending.length >= batchRows) {
        emit(insertsFor('record_index', pending.slice(0, batchRows), 'INSERT OR IGNORE'));
        pending = pending.slice(batchRows);
      }
    }
    if (pending.length > 0) emit(insertsFor('record_index', pending, 'INSERT OR IGNORE'));

    const header = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '# BUCKET overrides the bucket; WRANGLER_FLAGS="--local" targets the wrangler dev store.',
      `BUCKET="\${BUCKET:-${bucket}}"`,
      `ROOT="${resolve(opts.payloads)}"`,
      'FLAGS="${WRANGLER_FLAGS:-}"',
      'WRANGLER="${WRANGLER:-$(command -v wrangler || echo "pnpm exec wrangler")}"',
      '',
    ];
    const uploads: string[] = [];
    for (const s of snapshots) {
      const rp = s['raw_path'];
      if (typeof rp !== 'string') continue;
      uploads.push(
        `$WRANGLER r2 object put $FLAGS "$BUCKET/${prefix}${rp}" --file "$ROOT/${rp}" --content-type application/json`,
      );
    }
    writeFileSync(join(opts.out, 'upload-payloads.sh'), `${[...header, ...uploads].join('\n')}\n`, { mode: 0o755 });

    const maxSnapshotId = snapshots.length > 0 ? (snapshots[snapshots.length - 1]!['id'] as number) : after;
    const result: ExportResult = {
      sources: sources.length,
      snapshots: snapshots.length,
      recordRows,
      sqlFiles: fileNo,
      payloadUploads: uploads.length,
      afterSnapshotId: after,
      maxSnapshotId,
    };
    writeFileSync(join(opts.out, 'watermark.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    db.close();
  }
}
