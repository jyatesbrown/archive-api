#!/usr/bin/env node
/**
 * archive-fixture --out DIR [--profile spec|small] [--keys N] [--days N]
 *                 [--seed N] [--start YYYY-MM-DD] [--window-days N]
 *                 [--mutation-rate F] [--removal-rate F] [--source NAME]
 */
import { parseArgs } from 'node:util';

import { writeFixture } from './filesystem.js';
import { SMALL_PARAMS, SPEC_PARAMS, type FixtureParams } from './generator.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    profile: { type: 'string', default: 'spec' },
    keys: { type: 'string' },
    days: { type: 'string' },
    seed: { type: 'string' },
    start: { type: 'string' },
    'window-days': { type: 'string' },
    'mutation-rate': { type: 'string' },
    'removal-rate': { type: 'string' },
    source: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || !values.out) {
  process.stderr.write(
    'usage: archive-fixture --out DIR [--profile spec|small] [--keys N] [--days N] [--seed N]\n' +
      '                       [--start YYYY-MM-DD] [--window-days N] [--mutation-rate F] [--removal-rate F] [--source NAME]\n',
  );
  process.exit(values.help ? 0 : 2);
}

const base: FixtureParams = values.profile === 'small' ? SMALL_PARAMS : SPEC_PARAMS;
if (values.profile !== 'small' && values.profile !== 'spec') {
  process.stderr.write(`unknown profile ${values.profile}\n`);
  process.exit(2);
}

const num = (s: string | undefined, fallback: number): number => {
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) {
    process.stderr.write(`not a number: ${s}\n`);
    process.exit(2);
  }
  return n;
};

const params: FixtureParams = {
  seed: num(values.seed, base.seed),
  keys: num(values.keys, base.keys),
  days: num(values.days, base.days),
  startDate: values.start ?? base.startDate,
  mutationRate: num(values['mutation-rate'], base.mutationRate),
  removalRate: num(values['removal-rate'], base.removalRate),
  windowDays: num(values['window-days'], base.windowDays),
  sourceName: values.source ?? base.sourceName,
};

const t0 = performance.now();
const res = writeFixture(params, values.out);
const secs = ((performance.now() - t0) / 1000).toFixed(1);
process.stdout.write(
  `wrote ${res.dbPath}\n` +
    `      ${res.payloadsWritten} payloads under ${res.payloadsRoot}\n` +
    `      ${res.manifestPath}\n` +
    `params ${JSON.stringify(params)} in ${secs}s\n`,
);
