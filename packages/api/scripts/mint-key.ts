#!/usr/bin/env node
/**
 * Mint an API key. Prints the plaintext ONCE to stdout and the INSERT for D1 to
 * stderr (or applies it to a local sqlite file with --db). The Worker never
 * mints; it only reads api_keys.
 *
 * Requires a build first (`pnpm build`).
 * usage: mint-key --tier free|indie|team|bulk [--owner EMAIL] [--env live|test] [--db PATH]
 *   then: wrangler d1 execute archive-index --remote --command "<the INSERT>"
 */
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { mintKey } from '../dist/auth/keys.js';
import { isTier } from '../dist/auth/tiers.js';

const { values } = parseArgs({
  options: {
    tier: { type: 'string' },
    owner: { type: 'string' },
    env: { type: 'string', default: 'live' },
    db: { type: 'string' },
  },
});

if (!values.tier || !isTier(values.tier) || values.tier === 'anonymous' || (values.env !== 'live' && values.env !== 'test')) {
  process.stderr.write('usage: mint-key --tier free|indie|team|bulk [--owner EMAIL] [--env live|test] [--db PATH]\n');
  process.exit(2);
}

const minted = await mintKey(values.tier, values.owner ?? null, values.env);
const r = minted.record;
const q = (s: string | null): string => (s === null ? 'NULL' : `'${s.replaceAll("'", "''")}'`);
const insert =
  `INSERT INTO api_keys (id, prefix, key_hash, tier, owner, created_at, revoked_at) VALUES ` +
  `(${q(r.id)}, ${q(r.prefix)}, ${q(minted.hash)}, ${q(r.tier)}, ${q(r.owner)}, ${q(r.createdAt)}, NULL);`;

if (values.db) {
  const db = new DatabaseSync(values.db);
  db.exec(insert);
  db.close();
  process.stderr.write(`inserted ${r.prefix} (${r.tier}) into ${values.db}\n`);
} else {
  process.stderr.write(`${insert}\n`);
}
process.stdout.write(`${minted.plaintext}\n`);
