#!/usr/bin/env node
/**
 * Export a harness store (as written by @archive-api/fixture or the real
 * harness) into artefacts the Worker's bindings can ingest. See export-store.ts
 * for the output layout; scripts/sync.sh drives this incrementally against a
 * live D1.
 *
 * usage: load-fixture --db PATH --payloads DIR --out DIR
 *          [--bucket NAME] [--prefix payloads/] [--source NAME] [--after-snapshot-id N]
 *
 * Reads only. Nothing here talks to Cloudflare; run the emitted commands with
 * your own wrangler credentials (see RUNBOOK.md).
 */
import { parseArgs } from 'node:util';

import { exportStore } from './export-store.ts';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    payloads: { type: 'string' },
    out: { type: 'string' },
    bucket: { type: 'string', default: 'archive-store' },
    prefix: { type: 'string', default: 'payloads/' },
    source: { type: 'string' },
    'after-snapshot-id': { type: 'string', default: '0' },
    'batch-rows': { type: 'string', default: '5000' },
  },
});

if (!values.db || !values.payloads || !values.out) {
  process.stderr.write(
    'usage: load-fixture --db PATH --payloads DIR --out DIR [--bucket NAME] [--prefix payloads/] [--source NAME] [--after-snapshot-id N]\n',
  );
  process.exit(2);
}

const after = Number(values['after-snapshot-id']);
if (!Number.isInteger(after) || after < 0) {
  process.stderr.write('--after-snapshot-id must be a non-negative integer\n');
  process.exit(2);
}

try {
  const r = exportStore({
    db: values.db,
    payloads: values.payloads,
    out: values.out,
    bucket: values.bucket,
    prefix: values.prefix,
    ...(values.source ? { source: values.source } : {}),
    afterSnapshotId: after,
    batchRows: Number(values['batch-rows']),
  });
  process.stdout.write(
    `${r.sources} source(s), ${r.snapshots} snapshot(s) after id ${r.afterSnapshotId} (max ${r.maxSnapshotId}), ` +
      `${r.recordRows} index row(s), ${r.sqlFiles} SQL file(s), ${r.payloadUploads} payload upload(s) -> ${values.out}\n`,
  );
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
