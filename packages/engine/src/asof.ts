import { isIsoDate } from './calendar.js';
import { InvalidDateError, InvalidKeyError } from './errors.js';
import { Timeline, provenance, toRef } from './timeline.js';
import type { AsOfResult, CaptureRef, SnapshotStore } from './types.js';

/**
 * What did `key` look like on `date`?
 *
 * - `exact`           an ok capture on `date` holds the key
 * - `absent`          an ok capture on `date` lacks the key, or the nearest ok
 *                     captures on both sides lack it
 * - `carried_forward` no ok capture on `date`; the nearest ok captures on both
 *                     sides hold the key with the same value_hash
 * - `unknown_gap`     anything else: the state on `date` cannot be bounded
 *
 * Never interpolates and never returns a one-sided nearest neighbour as fact.
 */
export async function asOf(store: SnapshotStore, key: string, date: string): Promise<AsOfResult> {
  if (typeof key !== 'string' || key.length === 0) throw new InvalidKeyError();
  if (!isIsoDate(date)) throw new InvalidDateError(date);

  const tl = new Timeline(await store.captures());
  const { onDate, before, after, rejectedOnDate } = tl.bounds(date);
  const rejected = rejectedOnDate.map(toRef);
  const src = store.source;
  const base = { key, date, rejectedOnDate: rejected };

  if (onDate) {
    const ref = toRef(onDate);
    const hash = await store.hashOf(onDate.snapshotId, key);
    if (hash === null) {
      return {
        ...base,
        resolution: 'absent',
        capture: ref,
        before: null,
        after: null,
        provenance: provenance(src, [ref]),
      };
    }
    const payload = await store.payloadOf(onDate.snapshotId, key);
    if (payload === null) throw new Error(`store inconsistency: ${key} indexed in ${onDate.snapshotId} but has no payload`);
    return { ...base, resolution: 'exact', valueHash: hash, payload, capture: ref, provenance: provenance(src, [ref]) };
  }

  const refBefore: CaptureRef | null = before ? toRef(before) : null;
  const refAfter: CaptureRef | null = after ? toRef(after) : null;
  const evidence = [...(refBefore ? [refBefore] : []), ...(refAfter ? [refAfter] : []), ...rejected];

  if (!before || !after) {
    const reason = tl.isEmpty ? 'no_captures' : !before ? 'before_first_capture' : 'after_last_capture';
    const hashBefore = before ? await store.hashOf(before.snapshotId, key) : null;
    const hashAfter = after ? await store.hashOf(after.snapshotId, key) : null;
    return {
      ...base,
      resolution: 'unknown_gap',
      reason,
      before: refBefore,
      after: refAfter,
      hashBefore,
      hashAfter,
      provenance: provenance(src, evidence.length > 0 ? evidence : []),
    };
  }

  const [hashBefore, hashAfter] = await Promise.all([
    store.hashOf(before.snapshotId, key),
    store.hashOf(after.snapshotId, key),
  ]);

  if (hashBefore === null && hashAfter === null) {
    return {
      ...base,
      resolution: 'absent',
      capture: null,
      before: refBefore,
      after: refAfter,
      provenance: provenance(src, evidence),
    };
  }

  if (hashBefore !== null && hashBefore === hashAfter) {
    const payload = await store.payloadOf(before.snapshotId, key);
    if (payload === null) throw new Error(`store inconsistency: ${key} indexed in ${before.snapshotId} but has no payload`);
    return {
      ...base,
      resolution: 'carried_forward',
      valueHash: hashBefore,
      payload,
      before: refBefore as CaptureRef,
      after: refAfter as CaptureRef,
      provenance: provenance(src, evidence),
    };
  }

  return {
    ...base,
    resolution: 'unknown_gap',
    reason: 'state_changed_across_gap',
    before: refBefore,
    after: refAfter,
    hashBefore,
    hashAfter,
    provenance: provenance(src, evidence),
  };
}
