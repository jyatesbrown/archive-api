import { describe, expect, it } from 'vitest';

import { InvalidKeyError, history } from '../src/index.js';
import { SOURCE, scenario } from './scenario.js';

const rec = (hash: string, entity: string) => ({ hash, payload: { hash, entity } });

//  day:   01   02   03   04(rej)  05   06(miss)  07   08   09   10
//  A:     a1   a1   a2   --       a2   ..        --   --   a3   a3     resurrect (different value)
//  B:     b1   b1   --   --       --   ..        b1   b1   b1   b1     resurrect_identical
//  C:     c1   c1   --   --       --   ..        --   c9   c9   c9     key reuse (entity changes)
//  D:     --   --   --   --       d1   ..        d1   --   --   --     appears late, removed
const store = scenario()
  .ok('2025-01-01', { A: 'a1', B: 'b1', C: rec('c1', 'ent-1') })
  .ok('2025-01-02', { A: 'a1', B: 'b1', C: rec('c1', 'ent-1') })
  .ok('2025-01-03', { A: 'a2' })
  .rejected('2025-01-04')
  .ok('2025-01-05', { A: 'a2', D: 'd1' })
  .missing('2025-01-06')
  .ok('2025-01-07', { B: 'b1', D: 'd1' })
  .ok('2025-01-08', { B: 'b1', C: rec('c9', 'ent-2'), E: 'e1' })
  .ok('2025-01-09', { A: 'a3', B: 'b1', C: rec('c9', 'ent-2'), E: 'e1' })
  .ok('2025-01-10', { A: 'a3', B: 'b1', C: rec('c9', 'ent-2'), E: 'e1' })
  .store();

const kinds = (r: Awaited<ReturnType<typeof history>>) => r.transitions.map((t) => `${t.capture.date.slice(8)}:${t.kind}`);

describe('history: transitions', () => {
  it('appeared -> mutated -> removed -> reappeared with hashes', async () => {
    const r = await history(store, 'A');
    expect(kinds(r)).toEqual(['01:appeared', '03:mutated', '07:removed', '09:reappeared']);
    expect(r.transitions.map((t) => [t.previousHash, t.hash])).toEqual([
      [null, 'a1'],
      ['a1', 'a2'],
      ['a2', null],
      [null, 'a3'],
    ]);
    expect(r.firstSeen?.date).toBe('2025-01-01');
    expect(r.lastSeen?.date).toBe('2025-01-10');
    expect(r.status).toBe('present');
  });
  it('an identical resurrection is still a removed/reappeared pair', async () => {
    const r = await history(store, 'B');
    expect(kinds(r)).toEqual(['01:appeared', '03:removed', '07:reappeared']);
    expect(r.transitions[2]?.hash).toBe('b1');
    expect(r.reused).toBe(false);
  });
  it('a key appearing after day 0 and then vanishing', async () => {
    const r = await history(store, 'D');
    expect(kinds(r)).toEqual(['05:appeared', '08:removed']);
    expect(r.status).toBe('absent');
    expect(r.lastSeen?.date).toBe('2025-01-07');
  });
  it('unchanged presence produces no transitions beyond appeared', async () => {
    const s = scenario().ok('2025-01-01', { K: 'k' }).ok('2025-01-02', { K: 'k' }).ok('2025-01-03', { K: 'k' }).store();
    const r = await history(s, 'K');
    expect(kinds(r)).toEqual(['01:appeared']);
    expect(r.gaps).toEqual([]);
  });
  it('never-seen key', async () => {
    const r = await history(store, 'nope');
    expect(r).toMatchObject({ status: 'never_seen', firstSeen: null, lastSeen: null, transitions: [], gaps: [], reused: false });
    // provenance still says what was searched: first and last ok capture
    expect(r.provenance.captures.map((c) => c.date)).toEqual(['2025-01-01', '2025-01-10']);
  });
  it('rejected captures are ignored (no transition on 04)', async () => {
    const r = await history(store, 'A');
    expect(r.transitions.some((t) => t.capture.date === '2025-01-04')).toBe(false);
    expect(r.transitions.every((t) => t.capture.outcome === 'ok')).toBe(true);
  });
});

describe('history: gaps', () => {
  it('records absence gaps with bounding captures and absent-capture count', async () => {
    const r = await history(store, 'A');
    const absent = r.gaps.filter((g) => g.kind === 'absent');
    expect(absent).toEqual([
      {
        kind: 'absent',
        from: '2025-01-07',
        to: '2025-01-08',
        lastSeen: expect.objectContaining({ date: '2025-01-05' }),
        nextSeen: expect.objectContaining({ date: '2025-01-09' }),
        captures: 2,
      },
    ]);
  });
  it('records capture gaps (rejected day, missing day) during the lifetime', async () => {
    const r = await history(store, 'A');
    const noCap = r.gaps.filter((g) => g.kind === 'no_capture');
    expect(noCap).toEqual([
      expect.objectContaining({ kind: 'no_capture', from: '2025-01-04', to: '2025-01-04', days: 1 }),
      expect.objectContaining({ kind: 'no_capture', from: '2025-01-06', to: '2025-01-06', days: 1, rejected: [] }),
    ]);
    expect(noCap[0]).toMatchObject({ rejected: [expect.objectContaining({ outcome: 'validation_failed' })] });
  });
  it('capture gaps before the key ever appeared are not reported', async () => {
    const from = (r: Awaited<ReturnType<typeof history>>) => r.gaps.flatMap((g) => (g.kind === 'no_capture' ? [g.from] : []));
    // C appears on 01 so both gaps are in its lifetime
    expect(from(await history(store, 'C'))).toEqual(['2025-01-04', '2025-01-06']);
    // E appears on 08, after both gaps
    expect(from(await history(store, 'E'))).toEqual([]);
    // D appears on 05: the gap on 04 immediately precedes its appearance and is kept
    // (the appearance date itself is uncertain), as is 06 during its lifetime
    expect(from(await history(store, 'D'))).toEqual(['2025-01-04', '2025-01-06']);
  });
  it('gaps are in chronological order', async () => {
    const r = await history(store, 'A');
    const dates = r.gaps.map((g) => g.from);
    expect(dates).toEqual(['2025-01-04', '2025-01-06', '2025-01-07']);
  });
});

describe('history: key reuse', () => {
  it('flags a reappearance whose entity field changed', async () => {
    const r = await history(store, 'C');
    expect(kinds(r)).toEqual(['01:appeared', '03:removed', '08:reappeared']);
    expect(r.reused).toBe(true);
    expect(r.reuseEvidence).toEqual([
      { field: 'entity', before: 'ent-1', after: 'ent-2', at: expect.objectContaining({ date: '2025-01-08' }) },
    ]);
  });
  it('does not flag a resurrection with a changed value but the same entity', async () => {
    const r = await history(store, 'A');
    expect(r.reused).toBe(false);
    expect(r.reuseEvidence).toEqual([]);
  });
  it('cannot detect reuse without entity fields configured', async () => {
    const s = scenario({ ...SOURCE, entityFields: [] })
      .ok('2025-01-01', { C: rec('c1', 'ent-1') })
      .ok('2025-01-02', {})
      .ok('2025-01-03', { C: rec('c9', 'ent-2') })
      .store();
    const r = await history(s, 'C');
    expect(kinds(r)).toEqual(['01:appeared', '02:removed', '03:reappeared']);
    expect(r.reused).toBe(false);
  });
  it('checks every configured entity field', async () => {
    const s = scenario({ ...SOURCE, entityFields: ['entity', 'owner'] })
      .ok('2025-01-01', { C: { hash: 'c1', payload: { entity: 'e', owner: 'o1' } } })
      .ok('2025-01-02', {})
      .ok('2025-01-03', { C: { hash: 'c2', payload: { entity: 'e', owner: 'o2' } } })
      .store();
    const r = await history(s, 'C');
    expect(r.reused).toBe(true);
    expect(r.reuseEvidence.map((e) => e.field)).toEqual(['owner']);
  });
  it('a missing entity field on one side counts as a change', async () => {
    const s = scenario()
      .ok('2025-01-01', { C: { hash: 'c1', payload: { entity: 'e' } } })
      .ok('2025-01-02', {})
      .ok('2025-01-03', { C: { hash: 'c2', payload: {} } })
      .store();
    const r = await history(s, 'C');
    expect(r.reused).toBe(true);
    expect(r.reuseEvidence[0]).toMatchObject({ before: 'e', after: null });
  });
});

describe('history: aged_out', () => {
  const windowed = { ...SOURCE, windowDays: 10, windowKeyPart: 0 };
  it('a key leaving via the window is aged_out with matching status', async () => {
    const s = scenario(windowed)
      .ok('2025-01-10', { '2025-01-01|K': 'k' })
      .ok('2025-01-11', { '2025-01-01|K': 'k' })
      .ok('2025-01-12', {})
      .store();
    const r = await history(s, '2025-01-01|K');
    expect(kinds(r)).toEqual(['10:appeared', '12:aged_out']);
    expect(r.status).toBe('aged_out');
  });
  it('a key vanishing while inside the window is removed', async () => {
    const s = scenario(windowed)
      .ok('2025-01-10', { '2025-01-05|K': 'k' })
      .ok('2025-01-12', {})
      .store();
    const r = await history(s, '2025-01-05|K');
    expect(kinds(r)).toEqual(['10:appeared', '12:removed']);
    expect(r.status).toBe('absent');
  });
  it('status is present again if an aged-out key somehow returns', async () => {
    const s = scenario(windowed)
      .ok('2025-01-10', { '2025-01-01|K': 'k' })
      .ok('2025-01-12', {})
      .ok('2025-01-13', { '2025-01-01|K': 'k' })
      .store();
    const r = await history(s, '2025-01-01|K');
    expect(kinds(r)).toEqual(['10:appeared', '12:aged_out', '13:reappeared']);
    expect(r.status).toBe('present');
  });
});

describe('history: provenance and validation', () => {
  it('provenance lists every transition capture in chain order, de-duplicated', async () => {
    const r = await history(store, 'A');
    expect(r.provenance.captures.map((c) => c.date)).toEqual(['2025-01-01', '2025-01-03', '2025-01-07', '2025-01-09']);
    expect(r.provenance.source.name).toBe('test_source');
  });
  it('rejects an empty key', async () => {
    await expect(history(store, '')).rejects.toBeInstanceOf(InvalidKeyError);
  });
  it('empty store', async () => {
    const r = await history(scenario().store(), 'A');
    expect(r.status).toBe('never_seen');
    expect(r.provenance.captures).toEqual([]);
  });
});
