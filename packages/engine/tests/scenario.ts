/**
 * Tiny DSL for hand-built timelines:
 *
 *   scenario({ days: ['2025-01-01', ...], })
 *     .ok('2025-01-01', { A: 'a1', B: 'b1' })   // key -> value hash; payload derived
 *     .ok('2025-01-02', { A: 'a1' })
 *     .missing('2025-01-03')
 *     .rejected('2025-01-04', 'validation_failed')
 *     .store()
 */
import { MemoryStore, type CaptureOutcome, type JsonValue, type MemoryCaptureInput, type SourceMeta } from '../src/index.js';

export const SOURCE: SourceMeta = {
  id: 1,
  name: 'test_source',
  upstreamUrl: 'https://example.invalid/data.json',
  windowDays: null,
  windowKeyPart: 0,
  entityFields: ['entity'],
};

export type Records = Record<string, string | { hash: string; payload: JsonValue }>;

export class Scenario {
  private readonly caps: MemoryCaptureInput[] = [];
  private nextId = 1;
  private prevHash: string | null = null;
  constructor(private readonly source: SourceMeta = SOURCE) {}

  ok(date: string, records: Records, time = '06:00:00.000000'): this {
    const recs = new Map<string, { hash: string; payload: JsonValue }>();
    for (const [k, v] of Object.entries(records)) {
      if (typeof v === 'string') recs.set(k, { hash: v, payload: { key: k, hash: v, entity: `E-${k}` } });
      else recs.set(k, v);
    }
    const contentHash = `content-${this.nextId}`;
    this.caps.push({
      snapshotId: this.nextId,
      fetchedAt: `${date}T${time}Z`,
      outcome: 'ok',
      contentHash,
      prevHash: this.prevHash,
      rawPath: `test_source/${date.slice(0, 4)}/${date.slice(5, 7)}/${this.nextId}.raw`,
      records: recs,
    });
    this.prevHash = contentHash;
    this.nextId++;
    return this;
  }

  rejected(date: string, outcome: Exclude<CaptureOutcome, 'ok'> = 'validation_failed', time = '06:00:00.000000'): this {
    const stored = outcome === 'validation_failed' || outcome === 'extract_failed';
    const contentHash = stored ? `content-${this.nextId}` : null;
    this.caps.push({
      snapshotId: this.nextId,
      fetchedAt: `${date}T${time}Z`,
      outcome,
      contentHash,
      prevHash: this.prevHash,
      rawPath: stored ? `test_source/x/${this.nextId}.raw` : null,
    });
    if (contentHash) this.prevHash = contentHash;
    this.nextId++;
    return this;
  }

  /** No capture at all on that date; purely documentary. */
  missing(_date: string): this {
    return this;
  }

  store(): MemoryStore {
    return new MemoryStore(this.source, this.caps);
  }
}

export function scenario(source: SourceMeta = SOURCE): Scenario {
  return new Scenario(source);
}
