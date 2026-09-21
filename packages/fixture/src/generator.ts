/**
 * Synthetic source generator. Simulates a publisher that serves a rolling
 * window of registry records with daily churn, then records what the harness
 * would have written after fetching it every morning: raw payload, snapshot
 * row (with prev_hash chain), record_index, run_diffs, key_events,
 * source_health and alerts — following harness/runner.py step for step.
 *
 * Every pathological case the API must survive is injected on a fixed
 * schedule and reported in the manifest so tests can find it by name.
 */

import {
  GENERIC_JSON_ADAPTER_MODULE,
  GENERIC_JSON_ADAPTER_VERSION,
  addDays,
  fingerprintText,
  isOutsideWindow,
  isoMicros,
  payloadLocator,
  recordKey,
  sha256Hex,
  validateCount,
  valueHash,
  type GenericJsonConfig,
  type JsonRecord,
} from './harness-contract.js';
import type { Classification, HarnessDb, KeyEvent, SnapshotOutcome } from './harness-db.js';
import { Prng } from './prng.js';

// ---------------------------------------------------------------------------
// Parameters

export interface FixtureParams {
  /** PRNG seed; the whole fixture is a pure function of the parameters. */
  seed: number;
  /** Records present on day 0 (the steady-state population). */
  keys: number;
  /** Number of calendar days the capture ran, starting at `startDate`. */
  days: number;
  /** ISO date of the first capture. */
  startDate: string;
  /** Fraction of present records whose hashed payload changes each day. */
  mutationRate: number;
  /** Fraction of present records that vanish permanently each day. */
  removalRate: number;
  /** Rolling window (days) the publisher keeps, keyed on `created`. */
  windowDays: number;
  /** Source name in `sources.name` and the payload path. */
  sourceName: string;
}

/** The parameters named in Work Order 003. */
export const SPEC_PARAMS: FixtureParams = {
  seed: 20260920,
  keys: 50_000,
  days: 400,
  startDate: '2025-01-01',
  mutationRate: 0.02,
  removalRate: 0.003,
  windowDays: 365,
  sourceName: 'fixture_registry',
};

/** A reduced profile with the same pathology schedule; suitable for unit tests. */
export const SMALL_PARAMS: FixtureParams = { ...SPEC_PARAMS, keys: 400, days: 120 };

/** The pathology schedule below needs this many capture days to play out. */
export const MIN_DAYS = 100;
/** The aged-out cohort is created `windowDays - AGED_OUT_LEAD` days before day 0. */
const AGED_OUT_LEAD = 30;

export const ADAPTER_CONFIG: GenericJsonConfig = {
  key_fields: ['id'],
  records_path: 'records',
  ignore_fields: ['internal_note'],
  key_date_field: 'created',
};

/** Index of the key component carrying the ISO date (window_key_part). */
export const WINDOW_KEY_PART = 0;

// ---------------------------------------------------------------------------
// Records

export interface FixtureRecord extends JsonRecord {
  id: string;
  created: string;
  entity: string;
  name: string;
  status: string;
  amount: number;
  internal_note: string;
}

export const RECORD_FIELDS = ['id', 'created', 'entity', 'name', 'status', 'amount', 'internal_note'] as const;

const ADJECTIVES = ['amber', 'basalt', 'cobalt', 'dusky', 'ember', 'fallow', 'granite', 'hollow', 'iron', 'jade'];
const NOUNS = ['harbor', 'quarry', 'ridge', 'saltmarsh', 'terrace', 'upland', 'valley', 'weir', 'yard', 'zenith'];
const STATUSES = ['active', 'pending', 'suspended'];

function pad6(n: number): string {
  return n.toString().padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Manifest

export type CaseName =
  | 'resurrect'
  | 'resurrect_identical'
  | 'silent_field'
  | 'missing_day'
  | 'truncated_day'
  | 'aged_out'
  | 'key_reuse';

export const CASE_NAMES: readonly CaseName[] = [
  'resurrect',
  'resurrect_identical',
  'silent_field',
  'missing_day',
  'truncated_day',
  'aged_out',
  'key_reuse',
];

export interface ResurrectCase {
  key: string;
  /** First capture day on which the key is absent. */
  disappearsOnDay: number;
  /** Capture day on which the key is present again. */
  returnsOnDay: number;
  hashBefore: string;
  hashAfter: string;
}

export interface SilentFieldCase {
  key: string;
  /** Day the ignored field changes; the value hash is identical before and after. */
  day: number;
  field: string;
  hash: string;
  valueBefore: string;
  valueAfter: string;
}

export interface MissingDayCase {
  day: number;
  date: string;
}

export interface TruncatedDayCase {
  day: number;
  date: string;
  expectedRecords: number;
  deliveredRecords: number;
  outcome: SnapshotOutcome;
  snapshotId: number;
}

export interface AgedOutCase {
  createdDate: string;
  /** Capture day on which these keys are first outside the window. */
  leavesOnDay: number;
  keys: string[];
}

export interface KeyReuseCase {
  key: string;
  retiredOnDay: number;
  reassignedOnDay: number;
  entityBefore: string;
  entityAfter: string;
  hashBefore: string;
  hashAfter: string;
}

export interface FixtureCases {
  resurrect: ResurrectCase;
  resurrect_identical: ResurrectCase;
  silent_field: SilentFieldCase;
  missing_day: MissingDayCase;
  truncated_day: TruncatedDayCase;
  aged_out: AgedOutCase;
  key_reuse: KeyReuseCase;
}

export interface SnapshotSummary {
  day: number;
  date: string;
  /** null when no capture happened that day (missing_day). */
  snapshotId: number | null;
  fetchedAt: string | null;
  outcome: SnapshotOutcome | null;
  rawPath: string | null;
  contentHash: string | null;
  /** Records in the payload (indexed only when outcome is ok). */
  recordCount: number | null;
}

export interface FixtureManifest {
  version: 1;
  params: FixtureParams;
  source: {
    id: number;
    name: string;
    adapter_module: string;
    adapter_config: GenericJsonConfig;
    window_days: number;
    window_key_part: number;
    upstream_url: string;
  };
  /** Day index -> calendar date; `dates[0] === params.startDate`. */
  dates: string[];
  snapshots: SnapshotSummary[];
  cases: FixtureCases;
}

// ---------------------------------------------------------------------------
// Sink

export interface FixtureSink {
  db: HarnessDb;
  /** Persist a raw payload at the harness locator (relative to the payload root). */
  writePayload(locator: string, data: Uint8Array): void;
}

// ---------------------------------------------------------------------------
// Generator

interface Schedule {
  resurrect: { id: string; gone: number; back: number };
  resurrectIdentical: { id: string; gone: number; back: number };
  silentField: { id: string; day: number };
  missingDay: number;
  truncatedDay: number;
  keyReuse: { id: string; gone: number; back: number };
  agedOutCreated: string;
}

function schedule(p: FixtureParams): Schedule {
  return {
    resurrect: { id: 'R000000', gone: 40, back: 70 },
    resurrectIdentical: { id: 'R000001', gone: 45, back: 60 },
    silentField: { id: 'R000002', day: 50 },
    missingDay: 66,
    truncatedDay: 84,
    keyReuse: { id: 'R000003', gone: 55, back: 75 },
    agedOutCreated: addDays(p.startDate, -p.windowDays + AGED_OUT_LEAD),
  };
}

export function validateParams(p: FixtureParams): void {
  if (!Number.isInteger(p.days) || p.days < MIN_DAYS) throw new RangeError(`days must be >= ${MIN_DAYS}`);
  if (!Number.isInteger(p.keys) || p.keys < 100) throw new RangeError('keys must be >= 100');
  if (!Number.isInteger(p.windowDays) || p.windowDays <= AGED_OUT_LEAD) {
    throw new RangeError(`windowDays must be > ${AGED_OUT_LEAD}`);
  }
  if (p.mutationRate < 0 || p.mutationRate >= 1) throw new RangeError('mutationRate must be in [0, 1)');
  if (p.removalRate < 0 || p.removalRate >= 1) throw new RangeError('removalRate must be in [0, 1)');
  addDays(p.startDate, 0);
}

export function generateFixture(params: FixtureParams, sink: FixtureSink): FixtureManifest {
  validateParams(params);
  const p = params;
  const sch = schedule(p);
  const rng = new Prng(p.seed);
  const rngPop = rng.fork('population');
  const rngChurn = rng.fork('churn');
  const rngClock = rng.fork('clock');
  const db = sink.db;

  const keyOf = (r: FixtureRecord): string => recordKey(r, ADAPTER_CONFIG.key_fields, ADAPTER_CONFIG.key_date_field);
  const hashOf = (r: FixtureRecord): string => valueHash(r, ADAPTER_CONFIG.key_fields, ADAPTER_CONFIG.ignore_fields);

  // ---- population -------------------------------------------------------
  let nextId = 0;
  let nextEntity = 0;
  const newRecord = (created: string, r: Prng): FixtureRecord => {
    const id = `R${pad6(nextId++)}`;
    return {
      id,
      created,
      entity: `E${pad6(nextEntity++)}`,
      name: `${r.pick(ADJECTIVES)} ${r.pick(NOUNS)} ${r.int(1000)}`,
      status: r.pick(STATUSES),
      amount: r.int(100_000),
      internal_note: r.next() < 0.2 ? `note ${r.int(10_000)}` : '',
    };
  };

  const present = new Map<string, FixtureRecord>();
  const scenarioIds = new Set([sch.resurrect.id, sch.resurrectIdentical.id, sch.silentField.id, sch.keyReuse.id]);
  // Scenario records are created on day 0 so they stay inside the window for the whole run.
  for (let i = 0; i < 4; i++) {
    const r = newRecord(p.startDate, rngPop);
    present.set(r.id, r);
  }
  // A guaranteed aged-out cohort, then the rest spread across the window.
  const cohortSize = Math.max(25, Math.floor(p.keys / p.windowDays));
  for (let i = 0; i < cohortSize; i++) {
    const r = newRecord(sch.agedOutCreated, rngPop);
    present.set(r.id, r);
  }
  while (present.size < p.keys) {
    const created = addDays(p.startDate, -1 - rngPop.int(p.windowDays));
    const r = newRecord(created, rngPop);
    present.set(r.id, r);
  }
  const cohortIds = new Set([...present.values()].filter((r) => r.created === sch.agedOutCreated).map((r) => r.id));
  const agedOutKeys = [...present.values()]
    .filter((r) => cohortIds.has(r.id))
    .map(keyOf)
    .sort();

  // Steady state: replace what ages out and what is removed.
  const additionsPerDay = Math.max(1, Math.round(p.keys / p.windowDays + p.keys * p.removalRate));

  // ---- source row -------------------------------------------------------
  const upstreamUrl = `https://fixture.invalid/${p.sourceName}/registry.json`;
  const sourceId = db.addSource({
    name: p.sourceName,
    tier: 'FIXTURE',
    endpoint: upstreamUrl,
    format: 'json',
    adapter_module: GENERIC_JSON_ADAPTER_MODULE,
    adapter_config: JSON.stringify(ADAPTER_CONFIG),
    identity_key: 'created|id',
    license_url: 'synthetic fixture; no upstream',
    window_days: p.windowDays,
    window_key_part: WINDOW_KEY_PART,
    control_group: null,
    timeout_s: 30,
    cadence: 'daily (synthetic)',
    expected_silent: false,
    unverified_contrary_claim: false,
    exit_target: null,
    active: true,
    added_at: `${p.startDate}T05:59:00.000000Z`,
  });

  // ---- per-day capture --------------------------------------------------
  const dates: string[] = [];
  const snapshots: SnapshotSummary[] = [];
  let prevHash: string | null = null;
  const state: { prevOk: { id: number; records: Map<string, string> } | null } = { prevOk: null };
  const lastEvent = new Map<string, KeyEvent>();
  const retired = new Map<string, FixtureRecord>(); // scenario records parked while absent

  const cases: Partial<FixtureCases> = {};
  cases.aged_out = {
    createdDate: sch.agedOutCreated,
    leavesOnDay: AGED_OUT_LEAD + 1,
    keys: agedOutKeys,
  };

  for (let day = 0; day < p.days; day++) {
    const date = addDays(p.startDate, day);
    dates.push(date);

    // -- publisher state for the day ------------------------------------
    // 1. Window: records older than the window are no longer served.
    const floor = addDays(date, -p.windowDays);
    for (const [id, r] of present) if (r.created < floor) present.delete(id);

    // 2. Permanent removals among ordinary, in-window records (the aged-out
    //    cohort must leave via the window, never via removal).
    const ordinary = [...present.values()].filter(
      (r) => !scenarioIds.has(r.id) && !cohortIds.has(r.id) && r.created > floor,
    );
    const removals = rngChurn.sample(ordinary, Math.round(ordinary.length * p.removalRate));
    for (const r of removals) present.delete(r.id);

    // 3. Mutations.
    if (day > 0) {
      const survivors = [...present.values()].filter((r) => !scenarioIds.has(r.id));
      for (const r of rngChurn.sample(survivors, Math.round(survivors.length * p.mutationRate))) {
        present.set(r.id, {
          ...r,
          amount: r.amount + 1 + rngChurn.int(500),
          status: rngChurn.next() < 0.3 ? rngChurn.pick(STATUSES) : r.status,
        });
      }
    }

    // 4. Additions.
    if (day > 0) {
      for (let i = 0; i < additionsPerDay; i++) {
        const r = newRecord(date, rngChurn);
        present.set(r.id, r);
      }
    }

    // 5. Scenario overrides.
    applyScenario(day, sch, present, retired, rngChurn, cases, keyOf, hashOf);

    // -- what the harness saw -------------------------------------------
    if (day === sch.missingDay) {
      cases.missing_day = { day, date };
      snapshots.push({
        day,
        date,
        snapshotId: null,
        fetchedAt: null,
        outcome: null,
        rawPath: null,
        contentHash: null,
        recordCount: null,
      });
      continue;
    }

    const allRecords = [...present.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const served =
      day === sch.truncatedDay ? allRecords.slice(0, Math.round(allRecords.length * 0.4)) : allRecords;
    const body = Buffer.from(
      JSON.stringify({ generated_at: `${date}T05:58:00Z`, records: served.map(orderFields) }),
      'utf8',
    );
    const contentHash = sha256Hex(body);
    const micros = rngClock.int(1_000_000);
    const fetchedAtDate = new Date(`${date}T06:00:${pad2(rngClock.int(50))}.000Z`);
    const fetchedAt = isoMicros(fetchedAtDate, micros);
    const rawPath = payloadLocator(p.sourceName, fetchedAtDate, contentHash, micros);
    const durationS = (300 + rngClock.int(2_500)) / 1000;
    sink.writePayload(rawPath, body);

    const pairs: Array<readonly [string, string]> = served.map((r) => [keyOf(r), hashOf(r)] as const);
    const fieldNames = new Set<string>();
    for (const r of served) for (const k of Object.keys(r)) fieldNames.add(k);
    const fp = fingerprintText(served.length, [...fieldNames], ADAPTER_CONFIG);

    const prevOkNow = state.prevOk;
    const prevCount = prevOkNow ? prevOkNow.records.size : null;
    const validation = validateCount(prevCount, pairs.length);

    const snapshotBase = {
      source_id: sourceId,
      fetched_at: fetchedAt,
      http_status: 200,
      byte_length: body.byteLength,
      content_hash: contentHash,
      prev_hash: prevHash,
      raw_path: rawPath,
      adapter_version: GENERIC_JSON_ADAPTER_VERSION,
      duration_s: durationS,
    };

    const snapshotId = db.transaction((): number => {
      if (validation !== null) {
        const sid = db.addSnapshot({ ...snapshotBase, outcome: 'validation_failed', detail: validation });
        db.addHealth(sourceId, sid, fp, served.length, false, null);
        db.addAlert(isoMicros(new Date(fetchedAtDate.getTime() + 1000), micros), 'validation_failed', validation, sourceId, sid);
        if (day === sch.truncatedDay) {
          cases.truncated_day = {
            day,
            date,
            expectedRecords: allRecords.length,
            deliveredRecords: served.length,
            outcome: 'validation_failed',
            snapshotId: sid,
          };
        }
        return sid;
      }

      const sid = db.addSnapshot({ ...snapshotBase, outcome: 'ok', detail: null });
      db.addRecords(sid, pairs);
      db.addHealth(sourceId, sid, fp, served.length, false, null);

      const curr = new Map(pairs);
      const d = harnessDiff(prevOkNow?.records ?? null, curr, date, p.windowDays, lastEvent);
      db.addRunDiff({
        source_id: sourceId,
        snapshot_id: sid,
        prev_snapshot_id: prevOkNow?.id ?? null,
        added: d.added.length,
        removed: d.removed.length,
        mutated: d.mutated,
        aged_out: d.agedOut.length,
        reappeared: d.reappeared.length,
        unchanged: d.unchanged,
        classification: d.classification,
      });
      db.addKeyEvents(sourceId, sid, 'removed', d.removed);
      db.addKeyEvents(sourceId, sid, 'reappeared', d.reappeared);
      db.addKeyEvents(sourceId, sid, 'aged_out', d.agedOut);
      for (const k of d.removed) lastEvent.set(k, 'removed');
      for (const k of d.reappeared) lastEvent.set(k, 'reappeared');
      for (const k of d.agedOut) lastEvent.set(k, 'aged_out');
      state.prevOk = { id: sid, records: curr };
      return sid;
    });

    prevHash = contentHash;
    snapshots.push({
      day,
      date,
      snapshotId,
      fetchedAt,
      outcome: validation !== null ? 'validation_failed' : 'ok',
      rawPath,
      contentHash,
      recordCount: served.length,
    });
  }

  if (!isComplete(cases)) {
    throw new Error(`fixture schedule did not produce every case: ${Object.keys(cases).join(', ')}`);
  }

  return {
    version: 1,
    params: p,
    source: {
      id: sourceId,
      name: p.sourceName,
      adapter_module: GENERIC_JSON_ADAPTER_MODULE,
      adapter_config: ADAPTER_CONFIG,
      window_days: p.windowDays,
      window_key_part: WINDOW_KEY_PART,
      upstream_url: upstreamUrl,
    },
    dates,
    snapshots,
    cases,
  };
}

function isComplete(c: Partial<FixtureCases>): c is FixtureCases {
  return CASE_NAMES.every((n) => c[n] !== undefined);
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Serialise with a fixed field order so payload bytes are stable. */
function orderFields(r: FixtureRecord): FixtureRecord {
  const out: Partial<FixtureRecord> = {};
  for (const f of RECORD_FIELDS) (out as Record<string, unknown>)[f] = r[f];
  return out as FixtureRecord;
}

function applyScenario(
  day: number,
  sch: Schedule,
  present: Map<string, FixtureRecord>,
  retired: Map<string, FixtureRecord>,
  rng: Prng,
  cases: Partial<FixtureCases>,
  keyOf: (r: FixtureRecord) => string,
  hashOf: (r: FixtureRecord) => string,
): void {
  // resurrect: absent for 30 days, back with a different hashed payload.
  {
    const { id, gone, back } = sch.resurrect;
    if (day === gone) {
      const r = present.get(id) as FixtureRecord;
      retired.set(id, r);
      present.delete(id);
      cases.resurrect = { key: keyOf(r), disappearsOnDay: gone, returnsOnDay: back, hashBefore: hashOf(r), hashAfter: '' };
    } else if (day === back) {
      const r = retired.get(id) as FixtureRecord;
      const changed: FixtureRecord = { ...r, name: `${r.name} (reinstated)`, amount: r.amount + 7_000 };
      present.set(id, changed);
      (cases.resurrect as ResurrectCase).hashAfter = hashOf(changed);
    }
  }
  // resurrect_identical: absent, then back byte-identical.
  {
    const { id, gone, back } = sch.resurrectIdentical;
    if (day === gone) {
      const r = present.get(id) as FixtureRecord;
      retired.set(id, r);
      present.delete(id);
      const h = hashOf(r);
      cases.resurrect_identical = { key: keyOf(r), disappearsOnDay: gone, returnsOnDay: back, hashBefore: h, hashAfter: h };
    } else if (day === back) {
      present.set(id, retired.get(id) as FixtureRecord);
    }
  }
  // silent_field: an ignored field changes; the hash must not.
  {
    const { id, day: d } = sch.silentField;
    if (day === d) {
      const r = present.get(id) as FixtureRecord;
      const changed: FixtureRecord = { ...r, internal_note: `reviewed ${rng.int(10_000)} - not part of the hashed subset` };
      present.set(id, changed);
      cases.silent_field = {
        key: keyOf(r),
        day: d,
        field: 'internal_note',
        hash: hashOf(r),
        valueBefore: r.internal_note,
        valueAfter: changed.internal_note,
      };
    }
  }
  // key_reuse: the upstream retires the key, then hands it to a different entity.
  {
    const { id, gone, back } = sch.keyReuse;
    if (day === gone) {
      const r = present.get(id) as FixtureRecord;
      retired.set(id, r);
      present.delete(id);
      cases.key_reuse = {
        key: keyOf(r),
        retiredOnDay: gone,
        reassignedOnDay: back,
        entityBefore: r.entity,
        entityAfter: '',
        hashBefore: hashOf(r),
        hashAfter: '',
      };
    } else if (day === back) {
      const r = retired.get(id) as FixtureRecord;
      const reassigned: FixtureRecord = {
        ...r,
        entity: 'E999999',
        name: `${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)} ${rng.int(1000)}`,
        status: 'active',
        amount: rng.int(100_000),
        internal_note: '',
      };
      present.set(id, reassigned);
      const c = cases.key_reuse as KeyReuseCase;
      c.entityAfter = reassigned.entity;
      c.hashAfter = hashOf(reassigned);
    }
  }
}

interface HarnessDiffResult {
  added: string[];
  removed: string[];
  mutated: number;
  agedOut: string[];
  reappeared: string[];
  unchanged: number;
  classification: Classification;
}

/** harness.diff.diff against the previous *successful* snapshot. */
export function harnessDiff(
  prev: Map<string, string> | null,
  curr: Map<string, string>,
  asOfDate: string,
  windowDays: number,
  lastEvent: ReadonlyMap<string, KeyEvent>,
): HarnessDiffResult {
  if (prev === null) {
    return { added: [], removed: [], mutated: 0, agedOut: [], reappeared: [], unchanged: 0, classification: 'baseline' };
  }
  const added: string[] = [];
  const removed: string[] = [];
  const agedOut: string[] = [];
  const reappeared: string[] = [];
  let mutated = 0;
  let unchanged = 0;
  for (const [k, h] of curr) {
    const ph = prev.get(k);
    if (ph === undefined) {
      added.push(k);
      if (lastEvent.get(k) === 'removed') reappeared.push(k);
    } else if (ph !== h) mutated++;
    else unchanged++;
  }
  for (const k of prev.keys()) {
    if (curr.has(k)) continue;
    if (isOutsideWindow(k, asOfDate, windowDays, WINDOW_KEY_PART)) agedOut.push(k);
    else removed.push(k);
  }
  added.sort();
  removed.sort();
  agedOut.sort();
  reappeared.sort();
  const classification: Classification = removed.length ? 'destructive' : mutated ? 'mutating' : 'append_only';
  return { added, removed, mutated, agedOut, reappeared, unchanged, classification };
}
