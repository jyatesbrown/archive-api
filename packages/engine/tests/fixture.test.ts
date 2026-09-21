/**
 * The engine against the real @archive-api/fixture output (small profile),
 * one named test per pathology plus whole-timeline invariants.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SMALL_PARAMS, writeFixture, type FixtureManifest } from '@archive-api/fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NoCaptureError, addDays, asOf, diff, history, type AsOfResult } from '../src/index.js';
import { SqliteStore } from './sqlite-store.js';

let dir: string;
let store: SqliteStore;
let m: FixtureManifest;
const date = (day: number) => m.dates[day] as string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'archive-engine-'));
  const res = writeFixture(SMALL_PARAMS, join(dir, 'out'));
  m = res.manifest;
  store = new SqliteStore(res.dbPath, res.payloadsRoot, ['entity']);
}, 120_000);

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('fixture: store adapter', () => {
  it('exposes source metadata from the harness sources row', () => {
    expect(store.source.name).toBe(SMALL_PARAMS.sourceName);
    expect(store.source.upstreamUrl).toBe(m.source.upstream_url);
    expect(store.source.windowDays).toBe(SMALL_PARAMS.windowDays);
    expect(store.source.windowKeyPart).toBe(m.source.window_key_part);
  });
  it('captures follow the snapshots table in chain order', async () => {
    const caps = await store.captures();
    const stored = m.snapshots.filter((s) => s.snapshotId !== null);
    expect(caps.map((c) => c.snapshotId)).toEqual(stored.map((s) => s.snapshotId));
    expect(caps.map((c) => c.date)).toEqual(stored.map((s) => s.date));
    for (let i = 1; i < caps.length; i++) expect(caps[i]?.prevHash).toBe(caps[i - 1]?.contentHash);
  });
});

describe('pathology: resurrect', () => {
  it('asOf during the absence is a definite absence bounded by ok captures', async () => {
    const c = m.cases.resurrect;
    const mid = date(Math.floor((c.disappearsOnDay + c.returnsOnDay) / 2));
    const r = await asOf(store, c.key, mid);
    expect(r.resolution).toBe('absent');
  });
  it('asOf on return is exact with the new hash; before disappearance exact with the old one', async () => {
    const c = m.cases.resurrect;
    const back = await asOf(store, c.key, date(c.returnsOnDay));
    expect(back).toMatchObject({ resolution: 'exact', valueHash: c.hashAfter });
    const before = await asOf(store, c.key, date(c.disappearsOnDay - 1));
    expect(before).toMatchObject({ resolution: 'exact', valueHash: c.hashBefore });
  });
  it('history shows removed then reappeared with different hashes and one absence gap', async () => {
    const c = m.cases.resurrect;
    const h = await history(store, c.key);
    const removed = h.transitions.find((t) => t.kind === 'removed');
    const back = h.transitions.find((t) => t.kind === 'reappeared');
    expect(removed?.capture.date).toBe(date(c.disappearsOnDay));
    expect(removed?.previousHash).toBe(c.hashBefore);
    expect(back?.capture.date).toBe(date(c.returnsOnDay));
    expect(back?.hash).toBe(c.hashAfter);
    expect(c.hashAfter).not.toBe(c.hashBefore);
    const absent = h.gaps.filter((g) => g.kind === 'absent');
    expect(absent).toHaveLength(1);
    expect(h.reused).toBe(false);
  });
  it('diff across the absence sees a mutation, diff into the absence sees a removal', async () => {
    const c = m.cases.resurrect;
    const across = await diff(store, date(c.disappearsOnDay - 1), date(c.returnsOnDay));
    expect(across.mutated.find((x) => x.key === c.key)).toEqual({ key: c.key, before: c.hashBefore, after: c.hashAfter });
    const into = await diff(store, date(c.disappearsOnDay - 1), date(c.disappearsOnDay));
    expect(into.removed).toContain(c.key);
    expect(into.agedOut).not.toContain(c.key);
  });
});

describe('pathology: resurrect_identical', () => {
  it('history still records the removal and reappearance', async () => {
    const c = m.cases.resurrect_identical;
    const h = await history(store, c.key);
    expect(h.transitions.map((t) => t.kind)).toContain('removed');
    expect(h.transitions.map((t) => t.kind)).toContain('reappeared');
    expect(c.hashAfter).toBe(c.hashBefore);
  });
  it('diff across the absence is a no-op for the key (byte-identical return)', async () => {
    const c = m.cases.resurrect_identical;
    const across = await diff(store, date(c.disappearsOnDay - 1), date(c.returnsOnDay));
    expect(across.mutated.find((x) => x.key === c.key)).toBeUndefined();
    expect(across.removed).not.toContain(c.key);
    expect(across.added).not.toContain(c.key);
  });
  it('asOf inside the absence does not carry the value forward — absence is absence', async () => {
    const c = m.cases.resurrect_identical;
    for (let d = c.disappearsOnDay; d < c.returnsOnDay; d++) {
      const r = await asOf(store, c.key, date(d));
      if (m.snapshots[d]?.outcome === 'ok') expect(r.resolution, date(d)).toBe('absent');
      else expect(['absent', 'unknown_gap'], date(d)).toContain(r.resolution);
    }
  });
});

describe('pathology: silent_field', () => {
  it('the ignored field changes but the value hash and history do not', async () => {
    const c = m.cases.silent_field;
    const before = await asOf(store, c.key, date(c.day - 1));
    const after = await asOf(store, c.key, date(c.day));
    expect(before).toMatchObject({ resolution: 'exact', valueHash: c.hash });
    expect(after).toMatchObject({ resolution: 'exact', valueHash: c.hash });
    if (before.resolution !== 'exact' || after.resolution !== 'exact') throw new Error();
    const rec = (p: unknown) => p as Record<string, unknown>;
    expect(rec(before.payload)[c.field]).toBe(c.valueBefore);
    expect(rec(after.payload)[c.field]).toBe(c.valueAfter);
    const h = await history(store, c.key);
    expect(h.transitions.some((t) => t.kind === 'mutated' && t.capture.date === date(c.day))).toBe(false);
  });
  it('diff does not report the key as mutated', async () => {
    const c = m.cases.silent_field;
    const d = await diff(store, date(c.day - 1), date(c.day));
    expect(d.mutated.find((x) => x.key === c.key)).toBeUndefined();
  });
  it('the payload served for a carried_forward result is the bounding capture payload, not a blend', async () => {
    // find any missing/rejected day and a stable key spanning it
    const c = m.cases.missing_day;
    const idx = await store.indexOf(m.snapshots[c.day - 1]?.snapshotId as number);
    const idx2 = await store.indexOf(m.snapshots[c.day + 1]?.snapshotId as number);
    const stable = [...idx].find(([k, h]) => idx2.get(k) === h);
    expect(stable).toBeDefined();
    const [k, h] = stable as [string, string];
    const r = await asOf(store, k, c.date);
    expect(r).toMatchObject({ resolution: 'carried_forward', valueHash: h });
    if (r.resolution !== 'carried_forward') throw new Error();
    expect(r.payload).toEqual(await store.payloadOf(r.before.snapshotId, k));
  });
});

describe('pathology: missing_day', () => {
  it('no capture exists for the date and diff refuses it with neighbours', async () => {
    const c = m.cases.missing_day;
    expect(m.snapshots[c.day]?.snapshotId).toBeNull();
    const err = (await diff(store, c.date, date(c.day + 1)).catch((e: unknown) => e)) as NoCaptureError;
    expect(err).toBeInstanceOf(NoCaptureError);
    expect(err.nearestBefore?.date).toBe(date(c.day - 1));
    expect(err.nearestAfter?.date).toBe(date(c.day + 1));
    expect(err.rejectedOnDate).toEqual([]);
  });
  it('asOf: a key that changed across the missing day is unknown_gap, one that did not is carried_forward', async () => {
    const c = m.cases.missing_day;
    const idx = await store.indexOf(m.snapshots[c.day - 1]?.snapshotId as number);
    const idx2 = await store.indexOf(m.snapshots[c.day + 1]?.snapshotId as number);
    const changed = [...idx].find(([k, h]) => idx2.has(k) && idx2.get(k) !== h);
    const stable = [...idx].find(([k, h]) => idx2.get(k) === h);
    expect(changed).toBeDefined();
    expect(stable).toBeDefined();
    const u = await asOf(store, (changed as [string, string])[0], c.date);
    expect(u).toMatchObject({ resolution: 'unknown_gap', reason: 'state_changed_across_gap' });
    const cf = await asOf(store, (stable as [string, string])[0], c.date);
    expect(cf.resolution).toBe('carried_forward');
    expect(cf.rejectedOnDate).toEqual([]);
  });
  it('the missing day appears as a no_capture gap in diff and history', async () => {
    const c = m.cases.missing_day;
    const d = await diff(store, date(c.day - 1), date(c.day + 1));
    expect(d.gaps).toEqual([{ from: c.date, to: c.date, days: 1, rejected: [] }]);
    const idx = await store.indexOf(m.snapshots[c.day - 1]?.snapshotId as number);
    const h = await history(store, [...idx.keys()][0] as string);
    expect(h.gaps.some((g) => g.kind === 'no_capture' && g.from === c.date)).toBe(true);
  });
});

describe('pathology: truncated_day', () => {
  it('the rejected snapshot is stored but never used as state', async () => {
    const c = m.cases.truncated_day;
    const caps = await store.captures();
    const cap = caps.find((x) => x.snapshotId === c.snapshotId);
    expect(cap?.outcome).toBe(c.outcome);
    expect(cap?.outcome).not.toBe('ok');
    expect(cap?.rawPath).not.toBeNull();
    expect((await store.indexOf(c.snapshotId).catch(() => new Map())).size).toBe(0);
  });
  it('asOf on that date reports the rejected capture and carries forward unchanged keys', async () => {
    const c = m.cases.truncated_day;
    const idx = await store.indexOf(m.snapshots[c.day - 1]?.snapshotId as number);
    const idx2 = await store.indexOf(m.snapshots[c.day + 1]?.snapshotId as number);
    const stable = [...idx].find(([k, h]) => idx2.get(k) === h) as [string, string];
    const r = await asOf(store, stable[0], c.date);
    expect(r.resolution).toBe('carried_forward');
    expect(r.rejectedOnDate.map((x) => x.snapshotId)).toEqual([c.snapshotId]);
    expect(r.rejectedOnDate[0]?.outcome).toBe(c.outcome);
    expect(r.provenance.captures.map((x) => x.snapshotId)).toContain(c.snapshotId);
  });
  it('a key only in the ~40% delivered is not treated as present; a key missing from it is not removed', async () => {
    const c = m.cases.truncated_day;
    const prev = await store.indexOf(m.snapshots[c.day - 1]?.snapshotId as number);
    const next = await store.indexOf(m.snapshots[c.day + 1]?.snapshotId as number);
    let checked = 0;
    for (const [k, h] of prev) {
      if (next.get(k) !== h) continue;
      const r = await asOf(store, k, c.date);
      expect(r.resolution).toBe('carried_forward');
      if (++checked >= 25) break;
    }
    expect(checked).toBe(25);
    const d = await diff(store, date(c.day - 1), date(c.day + 1));
    expect(d.gaps).toHaveLength(1);
    expect(d.gaps[0]?.rejected.map((x) => x.snapshotId)).toEqual([c.snapshotId]);
  });
  it('diff refuses the truncated date and explains the rejection', async () => {
    const c = m.cases.truncated_day;
    const err = (await diff(store, date(c.day - 1), c.date).catch((e: unknown) => e)) as NoCaptureError;
    expect(err).toBeInstanceOf(NoCaptureError);
    expect(err.rejectedOnDate.map((x) => x.outcome)).toEqual([c.outcome]);
  });
});

describe('pathology: aged_out', () => {
  it('diff puts window-expired keys in agedOut, never in removed', async () => {
    const c = m.cases.aged_out;
    const d = await diff(store, date(c.leavesOnDay - 1), date(c.leavesOnDay));
    for (const k of c.keys) {
      expect(d.agedOut, k).toContain(k);
      expect(d.removed, k).not.toContain(k);
    }
  });
  it('history classifies the departure as aged_out with matching status', async () => {
    const c = m.cases.aged_out;
    const h = await history(store, c.keys[0] as string);
    const last = h.transitions[h.transitions.length - 1];
    expect(last?.kind).toBe('aged_out');
    expect(last?.capture.date).toBe(date(c.leavesOnDay));
    expect(h.status).toBe('aged_out');
  });
  it('asOf after expiry is a definite absence, before expiry exact', async () => {
    const c = m.cases.aged_out;
    const k = c.keys[0] as string;
    expect((await asOf(store, k, date(c.leavesOnDay))).resolution).toBe('absent');
    expect((await asOf(store, k, date(c.leavesOnDay - 1))).resolution).toBe('exact');
  });
  it('the whole cohort shares the created date and leaves on the same day', () => {
    const c = m.cases.aged_out;
    expect(c.keys.length).toBeGreaterThan(0);
    for (const k of c.keys) expect(k.startsWith(`${c.createdDate}|`)).toBe(true);
    expect(addDays(c.createdDate, SMALL_PARAMS.windowDays + 1)).toBe(date(c.leavesOnDay));
  });
});

describe('pathology: key_reuse', () => {
  it('history flags the key as reused with entity evidence', async () => {
    const c = m.cases.key_reuse;
    const h = await history(store, c.key);
    expect(h.reused).toBe(true);
    expect(h.reuseEvidence).toEqual([
      { field: 'entity', before: c.entityBefore, after: c.entityAfter, at: expect.objectContaining({ date: date(c.reassignedOnDay) }) },
    ]);
    expect(h.transitions.map((t) => t.kind)).toEqual(expect.arrayContaining(['appeared', 'removed', 'reappeared']));
  });
  it('asOf before and after retirement yields different entities under the same key', async () => {
    const c = m.cases.key_reuse;
    const a = await asOf(store, c.key, date(c.retiredOnDay - 1));
    const b = await asOf(store, c.key, date(c.reassignedOnDay));
    expect(a).toMatchObject({ resolution: 'exact', valueHash: c.hashBefore });
    expect(b).toMatchObject({ resolution: 'exact', valueHash: c.hashAfter });
    if (a.resolution !== 'exact' || b.resolution !== 'exact') throw new Error();
    expect((a.payload as { entity: string }).entity).toBe(c.entityBefore);
    expect((b.payload as { entity: string }).entity).toBe(c.entityAfter);
  });
  it('the ordinary resurrect key is NOT flagged as reused', async () => {
    expect((await history(store, m.cases.resurrect.key)).reused).toBe(false);
    expect((await history(store, m.cases.resurrect_identical.key)).reused).toBe(false);
  });
});

describe('fixture: whole-timeline invariants', () => {
  it('asOf on every capture day for a churned key agrees with record_index', async () => {
    const key = m.cases.resurrect.key;
    const presence = await store.presenceOf(key);
    for (const s of m.snapshots) {
      const r: AsOfResult = await asOf(store, key, s.date);
      if (s.outcome === 'ok') {
        const h = presence.get(s.snapshotId as number);
        if (h === undefined) expect(r.resolution, s.date).toBe('absent');
        else expect(r, s.date).toMatchObject({ resolution: 'exact', valueHash: h });
      } else {
        expect(r.resolution, s.date).not.toBe('exact');
      }
    }
  });
  it('adjacent-day diffs compose: sum of per-day changes covers the net diff', async () => {
    const oks = m.snapshots.filter((s) => s.outcome === 'ok').slice(0, 20);
    const net = await diff(store, oks[0]?.date as string, oks[oks.length - 1]?.date as string);
    const seen = new Set<string>();
    for (let i = 1; i < oks.length; i++) {
      const d = await diff(store, oks[i - 1]?.date as string, oks[i]?.date as string);
      for (const k of [...d.added, ...d.removed, ...d.agedOut, ...d.mutated.map((x) => x.key)]) seen.add(k);
    }
    for (const k of [...net.added, ...net.removed, ...net.agedOut, ...net.mutated.map((x) => x.key)]) {
      expect(seen.has(k), k).toBe(true);
    }
  });
  it('diff counts are consistent with index sizes', async () => {
    const [a, b] = [m.snapshots[10], m.snapshots[30]] as [FixtureManifest['snapshots'][number], FixtureManifest['snapshots'][number]];
    const d = await diff(store, a.date, b.date);
    expect(d.unchanged + d.mutated.length + d.removed.length + d.agedOut.length).toBe(a.recordCount);
    expect(d.unchanged + d.mutated.length + d.added.length).toBe(b.recordCount);
  });
  it('every provenance capture is a real snapshot in the chain', async () => {
    const caps = new Map((await store.captures()).map((c) => [c.snapshotId, c]));
    const results = await Promise.all([
      asOf(store, m.cases.resurrect.key, m.cases.missing_day.date),
      asOf(store, m.cases.silent_field.key, m.cases.truncated_day.date),
      history(store, m.cases.key_reuse.key),
      diff(store, date(1), date(50)),
    ]);
    for (const r of results) {
      expect(r.provenance.source.upstreamUrl).toBe(m.source.upstream_url);
      for (const c of r.provenance.captures) {
        const real = caps.get(c.snapshotId);
        expect(real).toBeDefined();
        expect(c.contentHash).toBe(real?.contentHash);
        expect(c.prevHash).toBe(real?.prevHash);
        expect(c.chainIndex).toBe(real?.chainIndex);
      }
    }
  });
  it('history for a sample of keys never reports transitions on rejected captures', async () => {
    const idx = await store.indexOf(m.snapshots[0]?.snapshotId as number);
    const keys = [...idx.keys()].slice(0, 15);
    for (const k of keys) {
      const h = await history(store, k);
      expect(h.firstSeen?.date).toBe(date(0));
      for (const t of h.transitions) expect(t.capture.outcome).toBe('ok');
    }
  });
});
