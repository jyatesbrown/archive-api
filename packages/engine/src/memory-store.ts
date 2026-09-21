import { dateOf } from './calendar.js';
import type { Capture, CaptureOutcome, JsonValue, SnapshotStore, SourceMeta } from './types.js';

export interface MemoryCaptureInput {
  snapshotId: number;
  fetchedAt: string;
  outcome: CaptureOutcome;
  contentHash?: string | null;
  prevHash?: string | null;
  rawPath?: string | null;
  adapterVersion?: string;
  /** record_key -> { hash, payload } for ok captures. */
  records?: ReadonlyMap<string, { hash: string; payload: JsonValue }>;
}

/**
 * Fully in-memory `SnapshotStore`. Used by tests and by anything that has
 * already loaded a source's captures (e.g. an edge cache).
 */
export class MemoryStore implements SnapshotStore {
  readonly source: SourceMeta;
  private readonly caps: Capture[];
  private readonly recs: Map<number, ReadonlyMap<string, { hash: string; payload: JsonValue }>>;
  private readonly hashIndex: Map<number, Map<string, string>>;
  private presenceCache: Map<string, Map<number, string>> | null = null;

  constructor(source: SourceMeta, captures: readonly MemoryCaptureInput[]) {
    this.source = source;
    const sorted = [...captures].sort((a, b) => (a.fetchedAt < b.fetchedAt ? -1 : a.fetchedAt > b.fetchedAt ? 1 : 0));
    this.caps = sorted.map((c, i) => ({
      snapshotId: c.snapshotId,
      fetchedAt: c.fetchedAt,
      date: dateOf(c.fetchedAt),
      outcome: c.outcome,
      contentHash: c.contentHash ?? null,
      prevHash: c.prevHash ?? null,
      rawPath: c.rawPath ?? null,
      adapterVersion: c.adapterVersion ?? '0.1',
      chainIndex: i,
    }));
    this.recs = new Map();
    this.hashIndex = new Map();
    for (const c of sorted) {
      if (c.outcome !== 'ok') continue;
      const records = c.records ?? new Map();
      this.recs.set(c.snapshotId, records);
      this.hashIndex.set(c.snapshotId, new Map([...records].map(([k, v]) => [k, v.hash])));
    }
  }

  captures(): Promise<readonly Capture[]> {
    return Promise.resolve(this.caps);
  }

  hashOf(snapshotId: number, key: string): Promise<string | null> {
    return Promise.resolve(this.hashIndex.get(snapshotId)?.get(key) ?? null);
  }

  indexOf(snapshotId: number): Promise<ReadonlyMap<string, string>> {
    const idx = this.hashIndex.get(snapshotId);
    if (!idx) return Promise.reject(new Error(`no ok snapshot ${snapshotId}`));
    return Promise.resolve(idx);
  }

  presenceOf(key: string): Promise<ReadonlyMap<number, string>> {
    if (this.presenceCache === null) {
      const cache = new Map<string, Map<number, string>>();
      for (const [sid, idx] of this.hashIndex) {
        for (const [k, h] of idx) {
          let m = cache.get(k);
          if (!m) cache.set(k, (m = new Map()));
          m.set(sid, h);
        }
      }
      this.presenceCache = cache;
    }
    return Promise.resolve(this.presenceCache.get(key) ?? new Map());
  }

  payloadOf(snapshotId: number, key: string): Promise<JsonValue | null> {
    return Promise.resolve(this.recs.get(snapshotId)?.get(key)?.payload ?? null);
  }
}
