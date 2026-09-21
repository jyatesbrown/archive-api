import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Prng } from '../src/prng.js';
import { SMALL_PARAMS, SPEC_PARAMS, validateParams, writeFixture } from '../src/index.js';
import { buildFixture } from './helpers.js';

describe('spec parameters', () => {
  it('match Work Order 003', () => {
    expect(SPEC_PARAMS).toMatchObject({ keys: 50_000, days: 400, mutationRate: 0.02, removalRate: 0.003 });
    expect(() => validateParams(SPEC_PARAMS)).not.toThrow();
    expect(() => validateParams(SMALL_PARAMS)).not.toThrow();
  });
  it('rejects runs too short to hold the pathologies', () => {
    expect(() => validateParams({ ...SMALL_PARAMS, days: 50 })).toThrow(/days/);
    expect(() => validateParams({ ...SMALL_PARAMS, keys: 10 })).toThrow(/keys/);
  });
});

// Pinned content hashes of the SMALL profile. Change deliberately (generator
// semantics changed) and say so in the PR; never to make a test pass.
const PIN_FIRST = '7ec8288a8a132c957f2b3f8cf45377b7e77716180d20ccf7087fe3025ed886bd';
const PIN_LAST = '61272e7ed295be7912ade42a93d2cf8db4712c138f24430d40469243b48f0564';

describe('determinism', () => {
  it('same seed => byte-identical index, hash chain and manifest', () => {
    const a = buildFixture();
    const b = buildFixture();
    try {
      const chain = (fx: typeof a) =>
        (fx.db.prepare('SELECT content_hash FROM snapshots ORDER BY id').all() as Array<{ content_hash: string }>).map(
          (r) => r.content_hash,
        );
      expect(chain(a)).toEqual(chain(b));
      expect(a.manifest).toEqual(b.manifest);
    } finally {
      a.close();
      b.close();
    }
  });
  it('different seed => different content', () => {
    const a = buildFixture();
    const b = buildFixture({ ...SMALL_PARAMS, seed: SMALL_PARAMS.seed + 1 });
    try {
      expect(a.manifest.cases.resurrect.hashBefore).not.toBe(b.manifest.cases.resurrect.hashBefore);
    } finally {
      a.close();
      b.close();
    }
  });
  it('the small profile is pinned (change this vector deliberately, never to make a test pass)', () => {
    const fx = buildFixture();
    try {
      expect(fx.manifest.snapshots[0]?.contentHash).toBe(PIN_FIRST);
      expect(fx.manifest.snapshots.at(-1)?.contentHash).toBe(PIN_LAST);
    } finally {
      fx.close();
    }
  });
});

describe('churn rates', () => {
  it('daily mutation and removal rates land near the configured 2% / 0.3%', () => {
    const fx = buildFixture();
    try {
      const rows = fx.db
        .prepare(
          `SELECT rd.mutated, rd.removed, rd.aged_out, rd.unchanged, rd.added, rd.reappeared
           FROM run_diffs rd WHERE rd.prev_snapshot_id IS NOT NULL`,
        )
        .all() as Array<{ mutated: number; removed: number; unchanged: number }>;
      let mut = 0;
      let rem = 0;
      let base = 0;
      for (const r of rows) {
        mut += r.mutated;
        rem += r.removed;
        base += r.mutated + r.removed + r.unchanged;
      }
      expect(mut / base).toBeGreaterThan(0.015);
      expect(mut / base).toBeLessThan(0.025);
      expect(rem / base).toBeGreaterThan(0.002);
      expect(rem / base).toBeLessThan(0.005);
    } finally {
      fx.close();
    }
  });
});

describe('writeFixture safety', () => {
  it('refuses to write into a non-empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-fixture-nonempty-'));
    try {
      writeFileSync(join(dir, 'existing'), '');
      expect(() => writeFixture(SMALL_PARAMS, dir)).toThrow(/non-empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Prng', () => {
  it('is deterministic and forks independently', () => {
    const a = new Prng(1);
    const b = new Prng(1);
    expect([a.next(), a.next(), a.int(10)]).toEqual([b.next(), b.next(), b.int(10)]);
    const f1 = new Prng(1).fork('x');
    const f2 = new Prng(1).fork('y');
    expect(f1.next()).not.toBe(f2.next());
  });
  it('sample returns k distinct items', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const s = new Prng(7).sample(items, 20);
    expect(new Set(s).size).toBe(20);
    for (const x of s) expect(items).toContain(x);
  });
});
