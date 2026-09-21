import { describe, expect, it } from 'vitest';

import { Timeline, isOutsideWindow, provenance, toRef } from '../src/timeline.js';
import type { Capture } from '../src/types.js';
import { SOURCE, scenario } from './scenario.js';

const store = scenario()
  .ok('2025-01-01', { A: 'a1' })
  .ok('2025-01-02', { A: 'a1' })
  .rejected('2025-01-03')
  .ok('2025-01-05', { A: 'a1' })
  .rejected('2025-01-06', 'fetch_failed')
  .ok('2025-01-06', { A: 'a1' }, '09:00:00.000000')
  .ok('2025-01-09', { A: 'a1' })
  .store();

async function tl(): Promise<Timeline> {
  return new Timeline(await store.captures());
}

describe('Timeline', () => {
  it('orders by chain index and separates ok captures', async () => {
    const t = await tl();
    expect(t.all.map((c) => c.snapshotId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(t.ok.map((c) => c.date)).toEqual(['2025-01-01', '2025-01-02', '2025-01-05', '2025-01-06', '2025-01-09']);
    expect(t.isEmpty).toBe(false);
  });

  it('okOn returns the ok capture for a date, ignoring rejected ones', async () => {
    const t = await tl();
    expect(t.okOn('2025-01-02')?.snapshotId).toBe(2);
    expect(t.okOn('2025-01-03')).toBeNull();
    expect(t.okOn('2025-01-06')?.snapshotId).toBe(6);
  });

  it('bounds: exact date', async () => {
    const b = (await tl()).bounds('2025-01-05');
    expect(b.onDate?.snapshotId).toBe(4);
    expect(b.before?.snapshotId).toBe(2);
    expect(b.after?.snapshotId).toBe(6);
    expect(b.rejectedOnDate).toEqual([]);
  });

  it('bounds: rejected-only date exposes the rejected capture and both neighbours', async () => {
    const b = (await tl()).bounds('2025-01-03');
    expect(b.onDate).toBeNull();
    expect(b.before?.snapshotId).toBe(2);
    expect(b.after?.snapshotId).toBe(4);
    expect(b.rejectedOnDate.map((c) => c.snapshotId)).toEqual([3]);
  });

  it('bounds: missing date', async () => {
    const b = (await tl()).bounds('2025-01-04');
    expect(b.onDate).toBeNull();
    expect(b.before?.snapshotId).toBe(2);
    expect(b.after?.snapshotId).toBe(4);
  });

  it('bounds: before first / after last capture', async () => {
    const t = await tl();
    expect(t.bounds('2024-12-31')).toMatchObject({ onDate: null, before: null });
    expect(t.bounds('2024-12-31').after?.snapshotId).toBe(1);
    expect(t.bounds('2025-02-01')).toMatchObject({ onDate: null, after: null });
    expect(t.bounds('2025-02-01').before?.snapshotId).toBe(7);
  });

  it('bounds: a date with a rejected and an ok capture counts as ok', async () => {
    const b = (await tl()).bounds('2025-01-06');
    expect(b.onDate?.snapshotId).toBe(6);
    expect(b.rejectedOnDate.map((c) => c.snapshotId)).toEqual([5]);
  });

  it('gapsBetween lists calendar gaps with any rejected captures inside them', async () => {
    const t = await tl();
    const gaps = t.gapsBetween(t.ok[0] as Capture, t.ok[4] as Capture);
    expect(gaps).toEqual([
      { from: '2025-01-03', to: '2025-01-04', days: 2, rejected: [expect.objectContaining({ snapshotId: 3 })] },
      { from: '2025-01-07', to: '2025-01-08', days: 2, rejected: [] },
    ]);
  });

  it('gapsBetween is empty for adjacent captures', async () => {
    const t = await tl();
    expect(t.gapsBetween(t.ok[0] as Capture, t.ok[1] as Capture)).toEqual([]);
    expect(t.gapsBetween(t.ok[2] as Capture, t.ok[2] as Capture)).toEqual([]);
  });

  it('rejects a non-contiguous chain', async () => {
    const caps = [...(await store.captures())];
    caps.splice(2, 1);
    expect(() => new Timeline(caps)).toThrow(/contiguous/);
  });

  it('empty timeline', () => {
    const t = new Timeline([]);
    expect(t.isEmpty).toBe(true);
    expect(t.bounds('2025-01-01')).toEqual({ onDate: null, before: null, after: null, rejectedOnDate: [] });
  });
});

describe('isOutsideWindow', () => {
  const src = { ...SOURCE, windowDays: 365, windowKeyPart: 0 };
  it('follows harness Window.is_outside (strictly before as_of - days)', () => {
    expect(isOutsideWindow(src, '2024-01-02|K', '2025-01-01')).toBe(false);
    expect(isOutsideWindow(src, '2024-01-01|K', '2025-01-01')).toBe(true);
  });
  it('is never outside without a window or with a non-date key part', () => {
    expect(isOutsideWindow(SOURCE, '2000-01-01|K', '2025-01-01')).toBe(false);
    expect(isOutsideWindow(src, 'K', '2025-01-01')).toBe(false);
    expect(isOutsideWindow({ ...src, windowKeyPart: 5 }, '2000-01-01|K', '2025-01-01')).toBe(false);
  });
  it('honours windowKeyPart', () => {
    expect(isOutsideWindow({ ...src, windowKeyPart: 1 }, 'K|2000-01-01', '2025-01-01')).toBe(true);
    expect(isOutsideWindow({ ...src, windowKeyPart: 1 }, '2000-01-01|K', '2025-01-01')).toBe(false);
  });
});

describe('provenance', () => {
  it('sorts by chain position and de-duplicates captures', async () => {
    const caps = await store.captures();
    const [c1, c2] = [toRef(caps[0] as Capture), toRef(caps[3] as Capture)];
    const p = provenance(SOURCE, [c2, c1, c2]);
    expect(p.source).toEqual({ id: 1, name: 'test_source', upstreamUrl: 'https://example.invalid/data.json' });
    expect(p.captures.map((c) => c.snapshotId)).toEqual([1, 4]);
  });
  it('carries hash-chain fields on every ref', async () => {
    const caps = await store.captures();
    const ref = toRef(caps[1] as Capture);
    expect(ref).toEqual({
      snapshotId: 2,
      fetchedAt: '2025-01-02T06:00:00.000000Z',
      date: '2025-01-02',
      outcome: 'ok',
      contentHash: 'content-2',
      prevHash: 'content-1',
      chainIndex: 1,
      rawPath: 'test_source/2025/01/2.raw',
    });
  });
});
