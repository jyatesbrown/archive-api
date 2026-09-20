#!/usr/bin/env node
/**
 * Export a harness store (as written by @archive-api/fixture or the real
 * harness) into artefacts the Worker's bindings can ingest:
 *
 *   <out>/schema.sql      the three tables the API reads (sources, snapshots, record_index)
 *   <out>/data-NNN.sql    INSERT batches for `wrangler d1 execute <db> --remote --file`
 *   <out>/upload-payloads.sh
 *                         `wrangler r2 object put` per raw payload, keyed PAYLOAD_PREFIX + raw_path
 *
 * usage: load-fixture --db PATH --payloads DIR --out DIR [--bucket NAME] [--prefix payloads/] [--source NAME]
 *
 * Reads only. Nothing here talks to Cloudflare; run the emitted commands with
 * your own wrangler credentials (see RUNBOOK.md).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    payloads: { type: 'string' },
    out: { type: 'string' },
    bucket: { type: 'string', default: 'archive-store' },
    prefix: { type: 'string', default: 'payloads/' },
    source: { type: 'string' },
    'batch-rows': { type: 'string', default: '5000' },
  },
});

if (!values.db || !values.payloads || !values.out) {
  process.stderr.write('usage: load-fixture --db PATH --payloads DIR --out DIR [--bucket NAME] [--prefix payloads/] [--source NAME]\n');
  process.exit(2);
}

const db = new DatabaseSync(values.db, { readOnly: true });
const out = values.out;
mkdirSync(out, { recursive: true });
const batchRows = Number(values['batch-rows']);

const SCHEMA = `
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
`;
writeFileSync(join(out, 'schema.sql'), SCHEMA.trimStart());

type Row = Record<string, string | number | null>;
const lit = (v: string | number | null): string => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`);

/** D1 rejects statements over ~100 KB (SQLITE_TOOBIG); keep each INSERT well under that. */
const ROWS_PER_STATEMENT = 400;

function insertsFor(table: string, rows: Row[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0] as Row);
  let sql = '';
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const vals = rows
      .slice(i, i + ROWS_PER_STATEMENT)
      .map((r) => `(${cols.map((c) => lit(r[c] ?? null)).join(',')})`)
      .join(',\n');
    sql += `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES\n${vals};\n`;
  }
  return sql;
}

const sourceFilter = values.source ? ' WHERE name = ?' : '';
const sourceArgs = values.source ? [values.source] : [];
const sources = db.prepare(`SELECT * FROM sources${sourceFilter}`).all(...sourceArgs) as Row[];
if (sources.length === 0) {
  process.stderr.write('no matching sources\n');
  process.exit(1);
}
const sourceIds = sources.map((s) => s['id'] as number);
const inList = sourceIds.map(() => '?').join(',');

let fileNo = 0;
function emit(sql: string): void {
  fileNo++;
  writeFileSync(join(out, `data-${String(fileNo).padStart(3, '0')}.sql`), sql);
}

emit(insertsFor('sources', sources));

const snapshots = db.prepare(`SELECT * FROM snapshots WHERE source_id IN (${inList}) ORDER BY id`).all(...sourceIds) as Row[];
for (let i = 0; i < snapshots.length; i += batchRows) emit(insertsFor('snapshots', snapshots.slice(i, i + batchRows)));

const snapIds = snapshots.map((s) => s['id'] as number);
let pending: Row[] = [];
for (const id of snapIds) {
  const rows = db.prepare('SELECT snapshot_id, record_key, value_hash FROM record_index WHERE snapshot_id = ?').all(id) as Row[];
  pending.push(...rows);
  while (pending.length >= batchRows) {
    emit(insertsFor('record_index', pending.slice(0, batchRows)));
    pending = pending.slice(batchRows);
  }
}
if (pending.length > 0) emit(insertsFor('record_index', pending));

const lines = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '# BUCKET overrides the bucket; WRANGLER_FLAGS="--local" targets the wrangler dev store.',
  `BUCKET="\${BUCKET:-${values.bucket}}"`,
  `ROOT="${resolve(values.payloads)}"`,
  'FLAGS="${WRANGLER_FLAGS:-}"',
  '',
];
for (const s of snapshots) {
  const rp = s['raw_path'];
  if (typeof rp !== 'string') continue;
  lines.push(`wrangler r2 object put $FLAGS "$BUCKET/${values.prefix}${rp}" --file "$ROOT/${rp}" --content-type application/json`);
}
writeFileSync(join(out, 'upload-payloads.sh'), `${lines.join('\n')}\n`, { mode: 0o755 });

process.stdout.write(
  `${sources.length} source(s), ${snapshots.length} snapshot(s), ${fileNo} SQL file(s), ${lines.length - 7} payload upload(s) -> ${out}\n`,
);
db.close();
