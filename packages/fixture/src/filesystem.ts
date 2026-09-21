/**
 * Writes a fixture into a directory shaped like the harness's R2 bucket
 * (deploy/run_daily.sh):
 *
 *   <out>/harness.sqlite                                  current DB
 *   <out>/payloads/<source>/<YYYY>/<MM>/<ts>-<sha12>.raw   raw payloads
 *   <out>/fixture-manifest.json                            fixture-only: tagged cases
 *
 * db-history/, summaries/ and logs/ are operational artefacts of the runner
 * that nothing downstream reads; they are not emitted.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { generateFixture, type FixtureManifest, type FixtureParams } from './generator.js';
import { HarnessDb } from './harness-db.js';

export const DB_FILENAME = 'harness.sqlite';
export const PAYLOADS_DIR = 'payloads';
export const MANIFEST_FILENAME = 'fixture-manifest.json';

export interface WriteResult {
  manifest: FixtureManifest;
  dbPath: string;
  payloadsRoot: string;
  manifestPath: string;
  payloadsWritten: number;
}

export function writeFixture(params: FixtureParams, outDir: string): WriteResult {
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) {
    throw new Error(`refusing to write into non-empty directory ${outDir}; the store is append-only`);
  }
  const dbPath = join(outDir, DB_FILENAME);
  const payloadsRoot = join(outDir, PAYLOADS_DIR);
  const manifestPath = join(outDir, MANIFEST_FILENAME);
  const db = new HarnessDb(dbPath);
  let payloadsWritten = 0;
  try {
    const manifest = generateFixture(params, {
      db,
      writePayload(locator, data) {
        const target = join(payloadsRoot, locator);
        if (existsSync(target)) throw new Error(`refusing to overwrite payload ${target}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data, { flag: 'wx' });
        payloadsWritten++;
      },
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return { manifest, dbPath, payloadsRoot, manifestPath, payloadsWritten };
  } finally {
    db.close();
  }
}
