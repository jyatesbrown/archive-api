import { describe, expect, it } from 'vitest';

import { InvalidDateError, InvalidKeyError, asOf, type AsOfResult, type Resolution } from '../src/index.js';
import { scenario } from './scenario.js';

//  day:   01   02   03   04   05   06   07   08   09
//  A:     a1   a1   --   a1   a1   ..   a2   a2   a2      (-- rejected capture, .. no capture)
//  B:     b1   --   --   --   b1   ..   b2   b2   --
//  C:     --   --   --   --   --   ..   c1   c1   c1
const store = scenario()
  .ok('2025-01-01', { A: 'a1', B: 'b1' })
  .ok('2025-01-02', { A: 'a1' })
  .rejected('2025-01-03', 'validation_failed')
  .ok('2025-01-04', { A: 'a1' })
  .ok('2025-01-05', { A: 'a1', B: 'b1' })
  .missing('2025-01-06')
  .ok('2025-01-07', { A: 'a2', B: 'b2', C: 'c1' })
  .ok('2025-01-08', { A: 'a2', B: 'b2', C: 'c1' })
  .ok('2025-01-09', { A: 'a2', C: 'c1' })
  .store();

const sid = (date: string) => ['01', '02', '03', '04', '05', '07', '08', '09'].indexOf(date.slice(8)) + 1;

describe('asOf: exact', () => {
  it('returns the payload and value hash from the capture on that date', async () => {
    const r = await asOf(store, 'A', '2025-01-02');
    expect(r.resolution).toBe('exact');
    if (r.resolution !== 'exact') throw new Error();
    expect(r.valueHash).toBe('a1');
    expect(r.payload).toEqual({ key: 'A', hash: 'a1', entity: 'E-A' });
    expect(r.capture.snapshotId).toBe(sid('2025-01-02'));
    expect(r.capture.date).toBe('2025-01-02');
  });
  it('provenance names exactly that capture with its chain position', async () => {
    const r = await asOf(store, 'A', '2025-01-05');
    expect(r.provenance.source).toEqual({ id: 1, name: 'test_source', upstreamUrl: 'https://example.invalid/data.json' });
    expect(r.provenance.captures).toHaveLength(1);
    expect(r.provenance.captures[0]).toMatchObject({ snapshotId: 5, chainIndex: 4, contentHash: 'content-5', prevHash: 'content-4' });
  });
  it('is exact on the first and last capture dates', async () => {
    expect((await asOf(store, 'A', '2025-01-01')).resolution).toBe('exact');
    expect((await asOf(store, 'A', '2025-01-09')).resolution).toBe('exact');
  });
  it('reports rejectedOnDate as empty when the day was clean', async () => {
    expect((await asOf(store, 'A', '2025-01-02')).rejectedOnDate).toEqual([]);
  });
});

describe('asOf: absent', () => {
  it('a capture on the date that lacks the key is a definite absence', async () => {
    const r = await asOf(store, 'B', '2025-01-02');
    expect(r).toMatchObject({ resolution: 'absent', before: null, after: null });
    if (r.resolution !== 'absent') throw new Error();
    expect(r.capture?.snapshotId).toBe(2);
    expect(r.provenance.captures.map((c) => c.snapshotId)).toEqual([2]);
  });
  it('a never-seen key on a captured date is absent', async () => {
    expect((await asOf(store, 'ZZZ', '2025-01-05')).resolution).toBe('absent');
  });
  it('absent on both sides of a gap is a bounded absence, with both bounds in provenance', async () => {
    const r = await asOf(store, 'C', '2025-01-03');
    expect(r.resolution).toBe('absent');
    if (r.resolution !== 'absent') throw new Error();
    expect(r.capture).toBeNull();
    expect(r.before?.snapshotId).toBe(2);
    expect(r.after?.snapshotId).toBe(4);
    expect(r.provenance.captures.map((c) => c.snapshotId)).toEqual([2, 3, 4]);
  });
  it('absent on both sides of a truly missing day', async () => {
    const r = await asOf(store, 'C', '2025-01-06');
    // C appears on 07, so before=05 (absent) after=07 (present) -> not absent
    expect(r.resolution).toBe('unknown_gap');
    const r2 = await asOf(store, 'ZZZ', '2025-01-06');
    expect(r2.resolution).toBe('absent');
  });
});

describe('asOf: carried_forward', () => {
  it('rejected-capture day bounded by identical hashes', async () => {
    const r = await asOf(store, 'A', '2025-01-03');
    expect(r.resolution).toBe('carried_forward');
    if (r.resolution !== 'carried_forward') throw new Error();
    expect(r.valueHash).toBe('a1');
    expect(r.payload).toEqual({ key: 'A', hash: 'a1', entity: 'E-A' });
    expect(r.before.date).toBe('2025-01-02');
    expect(r.after.date).toBe('2025-01-04');
  });
  it('lists the rejected capture on that date so callers can explain why', async () => {
    const r = await asOf(store, 'A', '2025-01-03');
    expect(r.rejectedOnDate).toHaveLength(1);
    expect(r.rejectedOnDate[0]).toMatchObject({ snapshotId: 3, outcome: 'validation_failed' });
    expect(r.provenance.captures.map((c) => c.snapshotId)).toEqual([2, 3, 4]);
  });
  it('missing day bounded by identical hashes', async () => {
    const r = await asOf(store, 'C', '2025-01-06');
    expect(r.resolution).toBe('unknown_gap');
    const r2 = await asOf(store, 'A', '2025-01-06');
    expect(r2.resolution).toBe('unknown_gap'); // a1 -> a2 across the gap
    // B: b1 on 05, b2 on 07 -> unknown as well; build one that carries:
    const s = scenario().ok('2025-01-01', { K: 'k' }).ok('2025-01-03', { K: 'k' }).store();
    const r3 = await asOf(s, 'K', '2025-01-02');
    expect(r3.resolution).toBe('carried_forward');
    expect(r3.rejectedOnDate).toEqual([]);
  });
  it('is never reported as exact even when the value is certain', async () => {
    const s = scenario().ok('2025-01-01', { K: 'k' }).ok('2025-01-03', { K: 'k' }).store();
    const r = await asOf(s, 'K', '2025-01-02');
    expect(r.resolution).not.toBe('exact');
    expect(r.resolution).toBe('carried_forward');
  });
  it('spans multi-day gaps', async () => {
    const s = scenario().ok('2025-01-01', { K: 'k' }).ok('2025-02-01', { K: 'k' }).store();
    for (const d of ['2025-01-02', '2025-01-15', '2025-01-31']) {
      const r = await asOf(s, 'K', d);
      expect(r.resolution, d).toBe('carried_forward');
    }
  });
});

describe('asOf: unknown_gap', () => {
  it('value changed across the gap', async () => {
    const r = await asOf(store, 'A', '2025-01-06');
    expect(r).toMatchObject({ resolution: 'unknown_gap', reason: 'state_changed_across_gap', hashBefore: 'a1', hashAfter: 'a2' });
    if (r.resolution !== 'unknown_gap') throw new Error();
    expect(r.before?.date).toBe('2025-01-05');
    expect(r.after?.date).toBe('2025-01-07');
    expect(r.provenance.captures.map((c) => c.date)).toEqual(['2025-01-05', '2025-01-07']);
  });
  it('present on one side only (appeared or vanished inside the gap)', async () => {
    const appeared = await asOf(store, 'C', '2025-01-06');
    expect(appeared).toMatchObject({ resolution: 'unknown_gap', reason: 'state_changed_across_gap', hashBefore: null, hashAfter: 'c1' });
    const vanished = await asOf(store, 'B', '2025-01-06');
    expect(vanished).toMatchObject({ resolution: 'unknown_gap', hashBefore: 'b1', hashAfter: 'b2' });
    const s = scenario().ok('2025-01-01', { K: 'k' }).ok('2025-01-03', {}).store();
    expect(await asOf(s, 'K', '2025-01-02')).toMatchObject({ resolution: 'unknown_gap', hashBefore: 'k', hashAfter: null });
  });
  it('B on 03: absent on 02 and absent on 04 => absent, not unknown', async () => {
    // B: 01 present, 02 absent, 04 absent, 05 present. 03 is bounded by two absences.
    expect((await asOf(store, 'B', '2025-01-03')).resolution).toBe('absent');
  });
  it('before the first capture', async () => {
    const r = await asOf(store, 'A', '2024-12-31');
    expect(r).toMatchObject({ resolution: 'unknown_gap', reason: 'before_first_capture', before: null, hashBefore: null, hashAfter: 'a1' });
    if (r.resolution !== 'unknown_gap') throw new Error();
    expect(r.after?.snapshotId).toBe(1);
    expect(r.provenance.captures.map((c) => c.snapshotId)).toEqual([1]);
  });
  it('after the last capture — the archive does not predict', async () => {
    const r = await asOf(store, 'A', '2025-01-10');
    expect(r).toMatchObject({ resolution: 'unknown_gap', reason: 'after_last_capture', after: null, hashBefore: 'a2', hashAfter: null });
    const far = await asOf(store, 'A', '2030-01-01');
    expect(far.resolution).toBe('unknown_gap');
  });
  it('a source with no captures at all', async () => {
    const s = scenario().store();
    const r = await asOf(s, 'A', '2025-01-01');
    expect(r).toMatchObject({ resolution: 'unknown_gap', reason: 'no_captures', before: null, after: null });
    expect(r.provenance.captures).toEqual([]);
  });
  it('a source with only rejected captures', async () => {
    const s = scenario().rejected('2025-01-01').rejected('2025-01-02', 'fetch_failed').store();
    const r = await asOf(s, 'A', '2025-01-01');
    expect(r).toMatchObject({ resolution: 'unknown_gap', reason: 'no_captures' });
    expect(r.rejectedOnDate).toHaveLength(1);
  });
});

describe('asOf: validation and invariants', () => {
  it.each(['2025-1-1', '2025-02-30', 'tomorrow', ''])('rejects invalid date %j', async (d) => {
    await expect(asOf(store, 'A', d)).rejects.toBeInstanceOf(InvalidDateError);
  });
  it('rejects an empty key', async () => {
    await expect(asOf(store, '', '2025-01-01')).rejects.toBeInstanceOf(InvalidKeyError);
  });
  it('every result carries key, date, provenance with >=0 captures and a known resolution', async () => {
    const seen = new Set<Resolution>();
    for (const key of ['A', 'B', 'C', 'ZZZ']) {
      for (let d = 1; d <= 10; d++) {
        const date = `2025-01-${String(d).padStart(2, '0')}`;
        const r: AsOfResult = await asOf(store, key, date);
        seen.add(r.resolution);
        expect(r.key).toBe(key);
        expect(r.date).toBe(date);
        expect(['exact', 'carried_forward', 'absent', 'unknown_gap']).toContain(r.resolution);
        expect(r.provenance.source.id).toBe(1);
      }
    }
    expect([...seen].sort()).toEqual(['absent', 'carried_forward', 'exact', 'unknown_gap']);
  });
  it('exact <=> an ok capture exists on the date', async () => {
    const caps = await store.captures();
    const okDates = new Set(caps.filter((c) => c.outcome === 'ok').map((c) => c.date));
    for (let d = 1; d <= 9; d++) {
      const date = `2025-01-0${d}`;
      const r = await asOf(store, 'A', date);
      if (okDates.has(date)) expect(['exact', 'absent']).toContain(r.resolution);
      else expect(r.resolution).not.toBe('exact');
    }
  });
  it('payload is only ever returned with exact or carried_forward', async () => {
    for (let d = 1; d <= 9; d++) {
      const r = await asOf(store, 'B', `2025-01-0${d}`);
      const hasPayload = 'payload' in r;
      expect(hasPayload).toBe(r.resolution === 'exact' || r.resolution === 'carried_forward');
    }
  });
  it('does not mutate the store between calls (idempotent)', async () => {
    const a = await asOf(store, 'A', '2025-01-06');
    const b = await asOf(store, 'A', '2025-01-06');
    expect(a).toEqual(b);
  });
});
