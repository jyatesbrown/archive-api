import { isIsoDate } from './calendar.js';
import { InvalidDateError, InvalidRangeError, NoCaptureError } from './errors.js';
import { Timeline, isOutsideWindow, provenance, toRef } from './timeline.js';
import type { DiffResult, Mutation, SnapshotStore } from './types.js';

/**
 * What changed between the ok captures on `from` and `to`?
 *
 * Both dates must have an ok capture; otherwise `NoCaptureError` names the
 * nearest ones. Keys that disappeared because they left the source's rolling
 * window are reported as `agedOut`, never as `removed` (harness semantics).
 */
export async function diff(store: SnapshotStore, from: string, to: string): Promise<DiffResult> {
  if (!isIsoDate(from)) throw new InvalidDateError(from);
  if (!isIsoDate(to)) throw new InvalidDateError(to);
  if (from > to) throw new InvalidRangeError(from, to);

  const tl = new Timeline(await store.captures());
  const capFrom = requireOk(tl, from);
  const capTo = requireOk(tl, to);

  const [idxFrom, idxTo] = await Promise.all([store.indexOf(capFrom.snapshotId), store.indexOf(capTo.snapshotId)]);

  const added: string[] = [];
  const removed: string[] = [];
  const agedOut: string[] = [];
  const mutated: Mutation[] = [];
  let unchanged = 0;

  for (const [key, before] of idxFrom) {
    const after = idxTo.get(key);
    if (after === undefined) {
      if (isOutsideWindow(store.source, key, to)) agedOut.push(key);
      else removed.push(key);
    } else if (after === before) {
      unchanged++;
    } else {
      mutated.push({ key, before, after });
    }
  }
  for (const key of idxTo.keys()) if (!idxFrom.has(key)) added.push(key);

  added.sort();
  removed.sort();
  agedOut.sort();
  mutated.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const refFrom = toRef(capFrom);
  const refTo = toRef(capTo);
  return {
    from: refFrom,
    to: refTo,
    provenance: provenance(store.source, [refFrom, refTo]),
    added,
    removed,
    mutated,
    agedOut,
    unchanged,
    gaps: tl.gapsBetween(capFrom, capTo),
  };
}

function requireOk(tl: Timeline, date: string) {
  const b = tl.bounds(date);
  if (b.onDate) return b.onDate;
  throw new NoCaptureError(
    date,
    b.before ? toRef(b.before) : null,
    b.after ? toRef(b.after) : null,
    b.rejectedOnDate.map(toRef),
  );
}
