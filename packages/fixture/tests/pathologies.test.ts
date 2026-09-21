import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CASE_NAMES, isOutsideWindow } from '../src/index.js';
import { buildFixture, okSnapshotId, type Fixture } from './helpers.js';

let fx: Fixture;
beforeAll(() => {
  fx = buildFixture();
});
afterAll(() => fx.close());

function keyEvents(key: string): Array<{ day: number; event: string }> {
  const rows = fx.db
    .prepare(
      `SELECT ke.event, s.fetched_at FROM key_events ke JOIN snapshots s ON s.id = ke.snapshot_id
       WHERE ke.record_key = ? ORDER BY ke.snapshot_id`,
    )
    .all(key) as Array<{ event: string; fetched_at: string }>;
  return rows.map((r) => ({ event: r.event, day: fx.manifest.dates.indexOf(r.fetched_at.slice(0, 10)) }));
}

describe('manifest', () => {
  it('tags every named pathology', () => {
    for (const name of CASE_NAMES) expect(fx.manifest.cases[name], name).toBeDefined();
    expect(Object.keys(fx.manifest.cases).sort()).toEqual([...CASE_NAMES].sort());
  });
});

describe('resurrect: key disappears for 30 days and returns with a different payload', () => {
  it('is present before, absent during, back after, with a changed hash', () => {
    const c = fx.manifest.cases.resurrect;
    expect(c.returnsOnDay - c.disappearsOnDay).toBe(30);
    expect(fx.indexFor(okSnapshotId(fx, c.disappearsOnDay - 1)).get(c.key)).toBe(c.hashBefore);
    for (let d = c.disappearsOnDay; d < c.returnsOnDay; d++) {
      const s = fx.snapshotOnDay(d);
      if (s.snapshotId === null || s.outcome !== 'ok') continue;
      expect(fx.indexFor(s.snapshotId).has(c.key), `day ${d}`).toBe(false);
    }
    expect(fx.indexFor(okSnapshotId(fx, c.returnsOnDay)).get(c.key)).toBe(c.hashAfter);
    expect(c.hashAfter).not.toBe(c.hashBefore);
  });
  it('is recorded by the harness as removed then reappeared', () => {
    const c = fx.manifest.cases.resurrect;
    expect(keyEvents(c.key)).toEqual([
      { day: c.disappearsOnDay, event: 'removed' },
      { day: c.returnsOnDay, event: 'reappeared' },
    ]);
  });
});

describe('resurrect_identical: key disappears and returns byte-identical', () => {
  it('has identical hash and identical serialized record before and after', () => {
    const c = fx.manifest.cases.resurrect_identical;
    expect(c.hashAfter).toBe(c.hashBefore);
    const before = fx.payloadFor(okSnapshotId(fx, c.disappearsOnDay - 1)).records.find((r) => r['id'] === c.key.split('|')[1]);
    const after = fx.payloadFor(okSnapshotId(fx, c.returnsOnDay)).records.find((r) => r['id'] === c.key.split('|')[1]);
    expect(before).toBeDefined();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(fx.indexFor(okSnapshotId(fx, c.disappearsOnDay)).has(c.key)).toBe(false);
  });
  it('is distinguishable from resurrect only by hash equality', () => {
    expect(fx.manifest.cases.resurrect.hashAfter).not.toBe(fx.manifest.cases.resurrect.hashBefore);
    expect(fx.manifest.cases.resurrect_identical.hashAfter).toBe(fx.manifest.cases.resurrect_identical.hashBefore);
  });
});

describe('silent_field: payload changes outside the hashed subset', () => {
  it('changes the raw payload but not the indexed value hash', () => {
    const c = fx.manifest.cases.silent_field;
    expect(fx.manifest.source.adapter_config.ignore_fields).toContain(c.field);
    const id = c.key.split('|')[1];
    const before = fx.payloadFor(okSnapshotId(fx, c.day - 1)).records.find((r) => r['id'] === id);
    const after = fx.payloadFor(okSnapshotId(fx, c.day)).records.find((r) => r['id'] === id);
    expect(before?.[c.field]).toBe(c.valueBefore);
    expect(after?.[c.field]).toBe(c.valueAfter);
    expect(c.valueAfter).not.toBe(c.valueBefore);
    expect(fx.indexFor(okSnapshotId(fx, c.day - 1)).get(c.key)).toBe(c.hash);
    expect(fx.indexFor(okSnapshotId(fx, c.day)).get(c.key)).toBe(c.hash);
  });
  it('is invisible to the harness diff (not counted as mutated)', () => {
    const c = fx.manifest.cases.silent_field;
    expect(keyEvents(c.key)).toEqual([]);
  });
});

describe('missing_day: no snapshot exists for a date', () => {
  it('has no snapshots row and no payload for that date, and neighbours exist', () => {
    const c = fx.manifest.cases.missing_day;
    expect(fx.manifest.dates[c.day]).toBe(c.date);
    expect(fx.snapshotOnDay(c.day)).toMatchObject({ snapshotId: null, outcome: null, rawPath: null });
    const n = fx.db
      .prepare("SELECT COUNT(*) AS n FROM snapshots WHERE substr(fetched_at, 1, 10) = ?")
      .get(c.date) as { n: number };
    expect(n.n).toBe(0);
    expect(fx.snapshotOnDay(c.day - 1).outcome).toBe('ok');
    expect(fx.snapshotOnDay(c.day + 1).outcome).toBe('ok');
  });
  it('is the only calendar gap in the capture series', () => {
    const gaps = fx.manifest.snapshots.filter((s) => s.snapshotId === null).map((s) => s.day);
    expect(gaps).toEqual([fx.manifest.cases.missing_day.day]);
  });
});

describe('truncated_day: snapshot exists with ~40% of expected keys', () => {
  it('stores the raw payload but rejects it (validation_failed) and indexes nothing', () => {
    const c = fx.manifest.cases.truncated_day;
    expect(c.outcome).toBe('validation_failed');
    expect(c.deliveredRecords / c.expectedRecords).toBeGreaterThan(0.35);
    expect(c.deliveredRecords / c.expectedRecords).toBeLessThan(0.45);
    const row = fx.db.prepare('SELECT outcome, detail, byte_length FROM snapshots WHERE id = ?').get(c.snapshotId) as {
      outcome: string;
      detail: string | null;
      byte_length: number;
    };
    expect(row.outcome).toBe('validation_failed');
    expect(row.detail).toMatch(/deviates 60%/);
    expect(row.byte_length).toBeGreaterThan(0);
    expect(fx.payloadFor(c.snapshotId).records).toHaveLength(c.deliveredRecords);
    expect(fx.indexFor(c.snapshotId).size).toBe(0);
  });
  it('does not produce removals; the next ok snapshot diffs against the last ok one', () => {
    const c = fx.manifest.cases.truncated_day;
    const next = fx.snapshotOnDay(c.day + 1);
    const diff = fx.db
      .prepare('SELECT prev_snapshot_id, removed, classification FROM run_diffs WHERE snapshot_id = ?')
      .get(next.snapshotId) as { prev_snapshot_id: number; removed: number; classification: string };
    expect(diff.prev_snapshot_id).toBe(okSnapshotId(fx, c.day - 1));
    expect(diff.removed).toBeLessThan(c.expectedRecords * 0.05);
    const truncatedEvents = fx.db
      .prepare('SELECT COUNT(*) AS n FROM key_events WHERE snapshot_id = ?')
      .get(c.snapshotId) as { n: number };
    expect(truncatedEvents.n).toBe(0);
  });
});

describe('aged_out: rolling-window cohort leaves on schedule', () => {
  it('cohort is present the day before and absent from the day it leaves', () => {
    const c = fx.manifest.cases.aged_out;
    expect(c.keys.length).toBeGreaterThan(0);
    const before = fx.indexFor(okSnapshotId(fx, c.leavesOnDay - 1));
    const after = fx.indexFor(okSnapshotId(fx, c.leavesOnDay));
    for (const k of c.keys) {
      expect(before.has(k), k).toBe(true);
      expect(after.has(k), k).toBe(false);
      expect(isOutsideWindow(k, fx.manifest.dates[c.leavesOnDay - 1]!, fx.manifest.source.window_days, 0)).toBe(false);
      expect(isOutsideWindow(k, fx.manifest.dates[c.leavesOnDay]!, fx.manifest.source.window_days, 0)).toBe(true);
    }
  });
  it('is classified aged_out, not removed, and never reappears', () => {
    const c = fx.manifest.cases.aged_out;
    for (const k of c.keys) expect(keyEvents(k), k).toEqual([{ day: c.leavesOnDay, event: 'aged_out' }]);
    const diff = fx.db
      .prepare('SELECT removed, aged_out, classification FROM run_diffs WHERE snapshot_id = ?')
      .get(okSnapshotId(fx, c.leavesOnDay)) as { removed: number; aged_out: number; classification: string };
    expect(diff.aged_out).toBeGreaterThanOrEqual(c.keys.length);
    expect(diff.removed).toBeLessThan(c.keys.length);
  });
});

describe('key_reuse: retired upstream key reassigned to a different entity', () => {
  it('same record_key, different entity and different hash after reassignment', () => {
    const c = fx.manifest.cases.key_reuse;
    const id = c.key.split('|')[1];
    const before = fx.payloadFor(okSnapshotId(fx, c.retiredOnDay - 1)).records.find((r) => r['id'] === id);
    const after = fx.payloadFor(okSnapshotId(fx, c.reassignedOnDay)).records.find((r) => r['id'] === id);
    expect(before?.['entity']).toBe(c.entityBefore);
    expect(after?.['entity']).toBe(c.entityAfter);
    expect(c.entityAfter).not.toBe(c.entityBefore);
    expect(fx.indexFor(okSnapshotId(fx, c.retiredOnDay - 1)).get(c.key)).toBe(c.hashBefore);
    expect(fx.indexFor(okSnapshotId(fx, c.retiredOnDay)).has(c.key)).toBe(false);
    expect(fx.indexFor(okSnapshotId(fx, c.reassignedOnDay)).get(c.key)).toBe(c.hashAfter);
    expect(c.hashAfter).not.toBe(c.hashBefore);
  });
  it('looks like a resurrection to the harness; only the entity field disambiguates', () => {
    const c = fx.manifest.cases.key_reuse;
    expect(keyEvents(c.key)).toEqual([
      { day: c.retiredOnDay, event: 'removed' },
      { day: c.reassignedOnDay, event: 'reappeared' },
    ]);
    // the entity is never seen under any other key in the reassignment snapshot
    const recs = fx.payloadFor(okSnapshotId(fx, c.reassignedOnDay)).records;
    expect(recs.filter((r) => r['entity'] === c.entityAfter)).toHaveLength(1);
  });
});
