import { InvalidKeyError } from './errors.js';
import { Timeline, isOutsideWindow, provenance, toRef } from './timeline.js';
import type {
  Capture,
  CaptureRef,
  HistoryGap,
  HistoryResult,
  JsonValue,
  ReuseEvidence,
  SnapshotStore,
  Transition,
} from './types.js';

/**
 * Lifecycle of `key`: when it appeared, every value change, every absence,
 * whether it left via the rolling window, and whether it came back bound to a
 * different entity (key reuse).
 */
export async function history(store: SnapshotStore, key: string): Promise<HistoryResult> {
  if (typeof key !== 'string' || key.length === 0) throw new InvalidKeyError();

  const tl = new Timeline(await store.captures());
  const presence = await store.presenceOf(key);
  const src = store.source;

  const transitions: Transition[] = [];
  const gaps: HistoryGap[] = [];
  const reuseEvidence: ReuseEvidence[] = [];
  let firstSeen: Capture | null = null;
  let lastSeen: Capture | null = null;
  let lastPresent: Capture | null = null;
  let prevHash: string | null = null;
  let absentSince: Capture | null = null;
  let absentLast: Capture | null = null;
  let absentCount = 0;
  let agedOut = false;
  let prevOk: Capture | null = null;

  for (const cap of tl.ok) {
    const hash = presence.get(cap.snapshotId) ?? null;

    if (hash !== null) {
      if (prevHash === null) {
        if (firstSeen === null) {
          firstSeen = cap;
          transitions.push(t('appeared', cap, hash, null));
        } else {
          transitions.push(t('reappeared', cap, hash, null));
          if (lastPresent && absentSince && absentLast) {
            gaps.push({
              kind: 'absent',
              from: absentSince.date,
              to: absentLast.date,
              lastSeen: toRef(lastPresent),
              nextSeen: toRef(cap),
              captures: absentCount,
            });
            const ev = await reuse(store, lastPresent, cap, key);
            reuseEvidence.push(...ev);
          }
        }
        agedOut = false;
      } else if (hash !== prevHash) {
        transitions.push(t('mutated', cap, hash, prevHash));
      }
      lastSeen = cap;
      lastPresent = cap;
      absentSince = null;
      absentCount = 0;
    } else if (prevHash !== null) {
      const kind = isOutsideWindow(src, key, cap.date) ? 'aged_out' : 'removed';
      agedOut = kind === 'aged_out';
      transitions.push(t(kind, cap, null, prevHash));
      absentSince = cap;
      absentLast = cap;
      absentCount = 1;
    } else if (absentSince !== null) {
      absentLast = cap;
      absentCount++;
    }

    // Capture gaps from the key's first appearance onward (a gap right before
    // the appearance makes the appearance date itself uncertain).
    if (prevOk && firstSeen !== null) {
      for (const g of tl.gapsBetween(prevOk, cap)) gaps.push({ kind: 'no_capture', ...g });
    }
    prevHash = hash;
    prevOk = cap;
  }

  gaps.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const status: HistoryResult['status'] =
    firstSeen === null ? 'never_seen' : prevHash !== null ? 'present' : agedOut ? 'aged_out' : 'absent';

  const evidence: CaptureRef[] = transitions.map((x) => x.capture);
  if (evidence.length === 0 && tl.ok.length > 0) {
    evidence.push(toRef(tl.ok[0] as Capture), toRef(tl.ok[tl.ok.length - 1] as Capture));
  }

  return {
    key,
    provenance: provenance(src, evidence),
    firstSeen: firstSeen ? toRef(firstSeen) : null,
    lastSeen: lastSeen ? toRef(lastSeen) : null,
    status,
    transitions,
    gaps,
    reused: reuseEvidence.length > 0,
    reuseEvidence,
  };
}

function t(kind: Transition['kind'], cap: Capture, hash: string | null, previousHash: string | null): Transition {
  return { kind, capture: toRef(cap), hash, previousHash };
}

async function reuse(store: SnapshotStore, before: Capture, after: Capture, key: string): Promise<ReuseEvidence[]> {
  const fields = store.source.entityFields;
  if (fields.length === 0) return [];
  const [pb, pa] = await Promise.all([store.payloadOf(before.snapshotId, key), store.payloadOf(after.snapshotId, key)]);
  const out: ReuseEvidence[] = [];
  for (const field of fields) {
    const b = field_(pb, field);
    const a = field_(pa, field);
    if (JSON.stringify(b) !== JSON.stringify(a)) out.push({ field, before: b, after: a, at: toRef(after) });
  }
  return out;
}

function field_(payload: JsonValue | null, field: string): JsonValue | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload[field] ?? null;
}
