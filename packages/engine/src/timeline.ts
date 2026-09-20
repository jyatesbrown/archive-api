import { addDays, daysBetween, toEpochDay } from './calendar.js';
import type { Capture, CaptureGap, CaptureRef, IsoDate, Provenance, SourceMeta } from './types.js';

export const KEY_SEP = '|';

export function toRef(c: Capture): CaptureRef {
  return {
    snapshotId: c.snapshotId,
    fetchedAt: c.fetchedAt,
    date: c.date,
    outcome: c.outcome,
    contentHash: c.contentHash,
    prevHash: c.prevHash,
    chainIndex: c.chainIndex,
    rawPath: c.rawPath,
  };
}

export function provenance(source: SourceMeta, captures: readonly CaptureRef[]): Provenance {
  const sorted = [...captures].sort((a, b) => a.chainIndex - b.chainIndex);
  const dedup = sorted.filter((c, i) => i === 0 || sorted[i - 1]?.snapshotId !== c.snapshotId);
  return {
    source: { id: source.id, name: source.name, upstreamUrl: source.upstreamUrl },
    captures: dedup,
  };
}

/**
 * Harness `Window.is_outside`: a key is outside the rolling window at `asOf`
 * when the date carried in its key part precedes `asOf - windowDays`.
 */
export function isOutsideWindow(source: SourceMeta, recordKey: string, asOf: IsoDate): boolean {
  if (source.windowDays === null) return false;
  const part = recordKey.split(KEY_SEP)[source.windowKeyPart];
  if (part === undefined) return false;
  const d = part.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return d < addDays(asOf, -source.windowDays);
}

export interface Bounds {
  /** Last ok capture on the date, if any. */
  onDate: Capture | null;
  /** Nearest ok capture strictly before the date. */
  before: Capture | null;
  /** Nearest ok capture strictly after the date. */
  after: Capture | null;
  /** Non-ok captures stored on the date. */
  rejectedOnDate: Capture[];
}

/** Ordered, indexed view over one source's captures. Cheap to build; build per query. */
export class Timeline {
  readonly all: readonly Capture[];
  readonly ok: readonly Capture[];
  private readonly okByDate: Map<IsoDate, Capture>;
  private readonly okEpochDays: number[];

  constructor(captures: readonly Capture[]) {
    this.all = [...captures].sort((a, b) => a.chainIndex - b.chainIndex);
    for (let i = 0; i < this.all.length; i++) {
      const c = this.all[i] as Capture;
      if (c.chainIndex !== i) throw new RangeError(`capture chain is not contiguous at index ${i}`);
    }
    const byDate = new Map<IsoDate, Capture>();
    for (const c of this.all) if (c.outcome === 'ok') byDate.set(c.date, c);
    this.okByDate = byDate;
    this.ok = [...byDate.values()].sort((a, b) => a.chainIndex - b.chainIndex);
    this.okEpochDays = this.ok.map((c) => toEpochDay(c.date));
  }

  get isEmpty(): boolean {
    return this.ok.length === 0;
  }

  okOn(date: IsoDate): Capture | null {
    return this.okByDate.get(date) ?? null;
  }

  bounds(date: IsoDate): Bounds {
    const e = toEpochDay(date);
    // first ok index with epochDay >= e
    let lo = 0;
    let hi = this.ok.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.okEpochDays[mid] as number) < e) lo = mid + 1;
      else hi = mid;
    }
    const at = this.ok[lo];
    const onDate = at !== undefined && at.date === date ? at : null;
    const before = lo > 0 ? (this.ok[lo - 1] as Capture) : null;
    const afterIdx = onDate ? lo + 1 : lo;
    const after = afterIdx < this.ok.length ? (this.ok[afterIdx] as Capture) : null;
    const rejectedOnDate = this.all.filter((c) => c.date === date && c.outcome !== 'ok');
    return { onDate, before, after, rejectedOnDate };
  }

  /** Ok captures with `from.date <= date <= to.date`, ascending. */
  okBetween(from: IsoDate, to: IsoDate): Capture[] {
    return this.ok.filter((c) => c.date >= from && c.date <= to);
  }

  /** Calendar gaps without an ok capture strictly between two ok captures. */
  gapsBetween(from: Capture, to: Capture): CaptureGap[] {
    const gaps: CaptureGap[] = [];
    const inside = this.okBetween(from.date, to.date);
    for (let i = 1; i < inside.length; i++) {
      const prev = inside[i - 1] as Capture;
      const curr = inside[i] as Capture;
      const span = daysBetween(prev.date, curr.date);
      if (span <= 1) continue;
      const gFrom = addDays(prev.date, 1);
      const gTo = addDays(curr.date, -1);
      const rejected = this.all
        .filter((c) => c.outcome !== 'ok' && c.date >= gFrom && c.date <= gTo)
        .map(toRef);
      gaps.push({ from: gFrom, to: gTo, days: span - 1, rejected });
    }
    return gaps;
  }
}
