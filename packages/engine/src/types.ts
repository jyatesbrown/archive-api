/**
 * Engine data model. Everything here is plain data; the engine never performs
 * I/O itself — it asks a `SnapshotStore` for what it needs.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** `YYYY-MM-DD` (UTC calendar date). */
export type IsoDate = string;

export type CaptureOutcome = 'ok' | 'fetch_failed' | 'extract_failed' | 'validation_failed' | 'robots_disallowed';

/** One row of the harness `snapshots` table plus its position in the hash chain. */
export interface Capture {
  snapshotId: number;
  /** ISO-8601 UTC timestamp with microseconds, as stored by the harness. */
  fetchedAt: string;
  /** `fetchedAt.slice(0, 10)`; the calendar day the capture belongs to. */
  date: IsoDate;
  outcome: CaptureOutcome;
  /** sha256 of the raw payload; null when nothing was fetched. */
  contentHash: string | null;
  prevHash: string | null;
  rawPath: string | null;
  adapterVersion: string;
  /** 0-based position in the source's snapshot chain (all outcomes). */
  chainIndex: number;
}

export interface SourceMeta {
  id: number;
  name: string;
  upstreamUrl: string;
  /** Rolling window in days; null when the source has none. */
  windowDays: number | null;
  /** Which `|`-separated part of the record key carries the date the window applies to. */
  windowKeyPart: number;
  /**
   * Payload fields that identify the real-world entity behind a key. When a
   * key reappears with different values here, the key was reused, not resurrected.
   */
  entityFields: readonly string[];
}

/**
 * Read-only view of one source in the append-only store. Implementations may
 * be in-memory, SQLite, R2 — the engine does not care. All methods are pure
 * reads and may be called concurrently.
 */
export interface SnapshotStore {
  readonly source: SourceMeta;
  /** Every capture of the source (all outcomes), ascending by `fetchedAt`. */
  captures(): Promise<readonly Capture[]>;
  /** value_hash of `key` in an ok snapshot, or null when the key is absent. */
  hashOf(snapshotId: number, key: string): Promise<string | null>;
  /** Full `record_key -> value_hash` index of an ok snapshot. */
  indexOf(snapshotId: number): Promise<ReadonlyMap<string, string>>;
  /** `snapshotId -> value_hash` for every ok snapshot in which `key` is present. */
  presenceOf(key: string): Promise<ReadonlyMap<number, string>>;
  /** The record's payload in a snapshot, or null when absent. */
  payloadOf(snapshotId: number, key: string): Promise<JsonValue | null>;
}

// ---------------------------------------------------------------------------
// Provenance

export interface CaptureRef {
  snapshotId: number;
  fetchedAt: string;
  date: IsoDate;
  outcome: CaptureOutcome;
  /** sha256 of the raw payload the answer was derived from. */
  contentHash: string | null;
  prevHash: string | null;
  chainIndex: number;
  rawPath: string | null;
}

export interface SourceRef {
  id: number;
  name: string;
  upstreamUrl: string;
}

export interface Provenance {
  source: SourceRef;
  /** Captures the answer is derived from, in chain order. Never empty. */
  captures: readonly CaptureRef[];
}

// ---------------------------------------------------------------------------
// asOf

export type Resolution = 'exact' | 'carried_forward' | 'absent' | 'unknown_gap';

export interface AsOfBase {
  key: string;
  date: IsoDate;
  provenance: Provenance;
  /** Captures on the requested date that were stored but rejected (e.g. validation_failed). */
  rejectedOnDate: readonly CaptureRef[];
}

/** An ok capture exists on `date` and contains the key. */
export interface AsOfExact extends AsOfBase {
  resolution: 'exact';
  valueHash: string;
  payload: JsonValue;
  capture: CaptureRef;
}

/**
 * No ok capture on `date`; the nearest ok captures before and after both hold
 * the key with the same value_hash, so the value is bounded on both sides.
 */
export interface AsOfCarriedForward extends AsOfBase {
  resolution: 'carried_forward';
  valueHash: string;
  payload: JsonValue;
  before: CaptureRef;
  after: CaptureRef;
}

/**
 * The key is known to be absent: either an ok capture on `date` lacks it, or
 * the bounding ok captures on both sides lack it.
 */
export interface AsOfAbsent extends AsOfBase {
  resolution: 'absent';
  /** Present when an ok capture exists on `date`. */
  capture: CaptureRef | null;
  before: CaptureRef | null;
  after: CaptureRef | null;
}

export type UnknownGapReason =
  | 'before_first_capture'
  | 'after_last_capture'
  | 'no_captures'
  | 'state_changed_across_gap';

/** No ok capture on `date` and the state cannot be bounded. */
export interface AsOfUnknownGap extends AsOfBase {
  resolution: 'unknown_gap';
  reason: UnknownGapReason;
  before: CaptureRef | null;
  after: CaptureRef | null;
  /** value_hash at `before` / `after` (null = absent there), when they exist. */
  hashBefore: string | null;
  hashAfter: string | null;
}

export type AsOfResult = AsOfExact | AsOfCarriedForward | AsOfAbsent | AsOfUnknownGap;

// ---------------------------------------------------------------------------
// diff

export interface Mutation {
  key: string;
  before: string;
  after: string;
}

export interface DiffResult {
  from: CaptureRef;
  to: CaptureRef;
  provenance: Provenance;
  added: readonly string[];
  removed: readonly string[];
  mutated: readonly Mutation[];
  /** Keys absent at `to` because they left the rolling window; disjoint from `removed`. */
  agedOut: readonly string[];
  unchanged: number;
  /** Calendar days strictly between `from` and `to` without an ok capture. */
  gaps: readonly CaptureGap[];
}

export interface CaptureGap {
  /** First and last calendar day without an ok capture. */
  from: IsoDate;
  to: IsoDate;
  days: number;
  /** Captures stored in the gap that were not ok (empty for a truly missing day). */
  rejected: readonly CaptureRef[];
}

// ---------------------------------------------------------------------------
// history

export type TransitionKind = 'appeared' | 'mutated' | 'removed' | 'reappeared' | 'aged_out';

export interface Transition {
  kind: TransitionKind;
  capture: CaptureRef;
  /** value_hash after the transition (null once removed / aged out). */
  hash: string | null;
  /** value_hash before the transition (null when appearing for the first time). */
  previousHash: string | null;
}

export type HistoryGap =
  | {
      kind: 'absent';
      /** Date of the first ok capture in which the key was absent. */
      from: IsoDate;
      /** Date of the last ok capture in which the key was absent. */
      to: IsoDate;
      /** Last ok capture holding the key before the gap. */
      lastSeen: CaptureRef;
      /** First ok capture holding the key after the gap. */
      nextSeen: CaptureRef;
      /** Number of ok captures in which the key was absent. */
      captures: number;
    }
  | ({ kind: 'no_capture' } & CaptureGap);

export interface ReuseEvidence {
  field: string;
  before: JsonValue | null;
  after: JsonValue | null;
  at: CaptureRef;
}

export interface HistoryResult {
  key: string;
  provenance: Provenance;
  firstSeen: CaptureRef | null;
  lastSeen: CaptureRef | null;
  /** State at the most recent ok capture. */
  status: 'present' | 'absent' | 'aged_out' | 'never_seen';
  transitions: readonly Transition[];
  gaps: readonly HistoryGap[];
  /** True when the key reappeared bound to a different entity (see `SourceMeta.entityFields`). */
  reused: boolean;
  reuseEvidence: readonly ReuseEvidence[];
}
