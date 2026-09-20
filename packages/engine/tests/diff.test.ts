import { describe, expect, it } from 'vitest';

import { InvalidDateError, InvalidRangeError, NoCaptureError, diff } from '../src/index.js';
import { SOURCE, scenario } from './scenario.js';

const WINDOWED = { ...SOURCE, windowDays: 30, windowKeyPart: 0 };

// keys carry a date part so the rolling window can apply
const store = scenario(WINDOWED)
  .ok('2025-02-01', { '2025-01-01|A': 'a1', '2025-01-01|B': 'b1', '2025-01-10|C': 'c1', '2025-01-20|D': 'd1' })
  .ok('2025-02-02', { '2025-01-01|A': 'a1', '2025-01-01|B': 'b2', '2025-01-10|C': 'c1', '2025-01-20|D': 'd1', '2025-02-02|E': 'e1' })
  .rejected('2025-02-03')
  .missing('2025-02-04')
  .ok('2025-02-05', { '2025-01-10|C': 'c1', '2025-01-20|D': 'd2', '2025-02-02|E': 'e1', '2025-02-05|F': 'f1' })
  .ok('2025-02-12', { '2025-01-20|D': 'd2', '2025-02-02|E': 'e1', '2025-02-05|F': 'f1' })
  .store();

describe('diff: classification', () => {
  it('added / mutated / unchanged between adjacent captures', async () => {
    const r = await diff(store, '2025-02-01', '2025-02-02');
    expect(r.added).toEqual(['2025-02-02|E']);
    expect(r.removed).toEqual([]);
    expect(r.agedOut).toEqual([]);
    expect(r.mutated).toEqual([{ key: '2025-01-01|B', before: 'b1', after: 'b2' }]);
    expect(r.unchanged).toBe(3);
  });
  it('separates aged_out from removed using the window at `to`', async () => {
    // to=2025-02-05, window 30d => floor 2025-01-06; A,B (2025-01-01) are outside; C stays.
    const r = await diff(store, '2025-02-02', '2025-02-05');
    expect(r.agedOut).toEqual(['2025-01-01|A', '2025-01-01|B']);
    expect(r.removed).toEqual([]);
    expect(r.added).toEqual(['2025-02-05|F']);
    expect(r.mutated).toEqual([{ key: '2025-01-20|D', before: 'd1', after: 'd2' }]);
    expect(r.unchanged).toBe(2);
  });
  it('a key that leaves while still inside the window is removed, not aged out', async () => {
    // to=2025-02-12 => floor 2025-01-13; C (2025-01-10) is outside => aged; nothing inside is removed here...
    const r = await diff(store, '2025-02-05', '2025-02-12');
    expect(r.agedOut).toEqual(['2025-01-10|C']);
    expect(r.removed).toEqual([]);
    // shrink the window so C is still inside on 02-12 and therefore a real removal
    const s = scenario({ ...WINDOWED, windowDays: 60 })
      .ok('2025-02-05', { '2025-01-10|C': 'c1' })
      .ok('2025-02-12', {})
      .store();
    const r2 = await diff(s, '2025-02-05', '2025-02-12');
    expect(r2.removed).toEqual(['2025-01-10|C']);
    expect(r2.agedOut).toEqual([]);
  });
  it('without a window nothing ever ages out', async () => {
    const s = scenario()
      .ok('2025-02-05', { '1999-01-01|C': 'c1' })
      .ok('2025-02-12', {})
      .store();
    const r = await diff(s, '2025-02-05', '2025-02-12');
    expect(r.removed).toEqual(['1999-01-01|C']);
    expect(r.agedOut).toEqual([]);
  });
  it('removed and agedOut are disjoint and together equal keys lost', async () => {
    const r = await diff(store, '2025-02-01', '2025-02-12');
    const lost = new Set([...r.removed, ...r.agedOut]);
    expect(lost.size).toBe(r.removed.length + r.agedOut.length);
    expect([...lost].sort()).toEqual(['2025-01-01|A', '2025-01-01|B', '2025-01-10|C']);
  });
  it('a multi-hop diff reports net change only', async () => {
    const r = await diff(store, '2025-02-01', '2025-02-12');
    expect(r.added).toEqual(['2025-02-02|E', '2025-02-05|F']);
    expect(r.mutated).toEqual([{ key: '2025-01-20|D', before: 'd1', after: 'd2' }]);
    expect(r.unchanged).toBe(0);
  });
  it('from == to is an empty diff', async () => {
    const r = await diff(store, '2025-02-02', '2025-02-02');
    expect(r).toMatchObject({ added: [], removed: [], mutated: [], agedOut: [], unchanged: 5, gaps: [] });
    expect(r.from.snapshotId).toBe(r.to.snapshotId);
  });
  it('outputs are sorted for stable pagination', async () => {
    const s = scenario()
      .ok('2025-01-01', { b: '1', a: '1', c: '1', z: '1' })
      .ok('2025-01-02', { y: '1', x: '1', c: '2', z: '2' })
      .store();
    const r = await diff(s, '2025-01-01', '2025-01-02');
    expect(r.added).toEqual(['x', 'y']);
    expect(r.removed).toEqual(['a', 'b']);
    expect(r.mutated.map((m) => m.key)).toEqual(['c', 'z']);
  });
});

describe('diff: gaps and provenance', () => {
  it('lists calendar gaps between from and to with rejected captures inside', async () => {
    const r = await diff(store, '2025-02-01', '2025-02-12');
    expect(r.gaps).toEqual([
      { from: '2025-02-03', to: '2025-02-04', days: 2, rejected: [expect.objectContaining({ outcome: 'validation_failed' })] },
      { from: '2025-02-06', to: '2025-02-11', days: 6, rejected: [] },
    ]);
  });
  it('gaps are empty for adjacent captures', async () => {
    expect((await diff(store, '2025-02-01', '2025-02-02')).gaps).toEqual([]);
  });
  it('provenance is the two endpoint captures in chain order', async () => {
    const r = await diff(store, '2025-02-01', '2025-02-12');
    expect(r.provenance.captures.map((c) => c.snapshotId)).toEqual([1, 5]);
    expect(r.from).toMatchObject({ snapshotId: 1, date: '2025-02-01', contentHash: 'content-1' });
    expect(r.to).toMatchObject({ snapshotId: 5, date: '2025-02-12', prevHash: 'content-4' });
  });
});

describe('diff: errors', () => {
  it('rejects invalid dates', async () => {
    await expect(diff(store, '2025-02-30', '2025-02-12')).rejects.toBeInstanceOf(InvalidDateError);
    await expect(diff(store, '2025-02-01', 'x')).rejects.toBeInstanceOf(InvalidDateError);
  });
  it('rejects from > to', async () => {
    await expect(diff(store, '2025-02-12', '2025-02-01')).rejects.toBeInstanceOf(InvalidRangeError);
  });
  it('refuses a date with no capture and names the nearest ok captures', async () => {
    const err = await diff(store, '2025-02-04', '2025-02-12').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoCaptureError);
    const e = err as NoCaptureError;
    expect(e.date).toBe('2025-02-04');
    expect(e.nearestBefore?.date).toBe('2025-02-02');
    expect(e.nearestAfter?.date).toBe('2025-02-05');
    expect(e.rejectedOnDate).toEqual([]);
    expect(e.code).toBe('no_capture');
  });
  it('refuses a date whose only capture was rejected and says why', async () => {
    const err = (await diff(store, '2025-02-01', '2025-02-03').catch((e: unknown) => e)) as NoCaptureError;
    expect(err).toBeInstanceOf(NoCaptureError);
    expect(err.rejectedOnDate.map((c) => c.outcome)).toEqual(['validation_failed']);
    expect(err.message).toMatch(/validation_failed/);
  });
  it('refuses dates outside the captured range', async () => {
    const before = (await diff(store, '2025-01-01', '2025-02-01').catch((e: unknown) => e)) as NoCaptureError;
    expect(before.nearestBefore).toBeNull();
    expect(before.nearestAfter?.date).toBe('2025-02-01');
    const after = (await diff(store, '2025-02-12', '2025-03-01').catch((e: unknown) => e)) as NoCaptureError;
    expect(after.nearestAfter).toBeNull();
    expect(after.nearestBefore?.date).toBe('2025-02-12');
  });
});
