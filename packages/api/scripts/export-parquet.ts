/**
 * CLI over parquet-export.ts.
 *
 *   node --experimental-strip-types scripts/export-parquet.ts \
 *     --db ../../fixture-data/small/harness.sqlite \
 *     --payloads ../../fixture-data/small/payloads \
 *     --source fixture_registry --out ../../fixture-data/small/exports
 *   bash ../../fixture-data/small/exports/upload.sh [--local]
 */
import { parseArgs } from 'node:util';

import { exportParquet } from './parquet-export.ts';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    payloads: { type: 'string' },
    source: { type: 'string' },
    out: { type: 'string' },
    bucket: { type: 'string', default: 'archive-store' },
    prefix: { type: 'string', default: 'exports/' },
  },
});

for (const k of ['db', 'payloads', 'source', 'out'] as const) {
  if (!values[k]) {
    process.stderr.write(`--${k} is required\n`);
    process.exit(2);
  }
}

const m = await exportParquet({
  db: values.db!,
  payloads: values.payloads!,
  source: values.source!,
  out: values.out!,
  bucket: values.bucket,
  prefix: values.prefix,
});
process.stderr.write(
  `${m.source.name} @ ${m.stamp}: ${m.rows.history} history row(s) over ${m.rows.keys} key(s), ${m.rows.snapshots} snapshot(s)\n` +
    m.files.map((f) => `  ${f.name}  ${f.bytes} bytes  sha256 ${f.sha256.slice(0, 12)}\n`).join('') +
    `upload: bash ${values.out}/upload.sh [--local]\n`,
);
