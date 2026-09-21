import type { SnapshotStore } from '@archive-api/engine';

export interface SourceSummary {
  id: number;
  name: string;
  upstreamUrl: string;
  windowDays: number | null;
  /** Total stored captures, including rejected ones. */
  captures: number;
  okCaptures: number;
  firstCapture: string | null;
  lastCapture: string | null;
}

/** Per-source configuration that is not in the harness DB. */
export interface SourceConfig {
  entityFields?: readonly string[];
}

export type SourceConfigMap = Readonly<Record<string, SourceConfig>>;

export function parseSourceConfig(raw: string | undefined): SourceConfigMap {
  if (!raw) return {};
  const v: unknown = JSON.parse(raw);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('SOURCE_CONFIG must be a JSON object');
  const out: Record<string, SourceConfig> = {};
  for (const [name, cfg] of Object.entries(v as Record<string, unknown>)) {
    if (typeof cfg !== 'object' || cfg === null) throw new Error(`SOURCE_CONFIG.${name} must be an object`);
    const ef = (cfg as { entityFields?: unknown }).entityFields;
    if (ef !== undefined && !(Array.isArray(ef) && ef.every((f) => typeof f === 'string'))) {
      throw new Error(`SOURCE_CONFIG.${name}.entityFields must be string[]`);
    }
    out[name] = ef === undefined ? {} : { entityFields: ef as string[] };
  }
  return out;
}

export interface SourceRegistry {
  list(): Promise<readonly SourceSummary[]>;
  /** null when the source is not configured. */
  get(name: string): Promise<SnapshotStore | null>;
}

/** Registry over pre-built stores (tests, or anything already in memory). */
export class StaticRegistry implements SourceRegistry {
  private readonly stores: Map<string, SnapshotStore>;
  constructor(stores: readonly SnapshotStore[]) {
    this.stores = new Map(stores.map((s) => [s.source.name, s]));
  }
  async list(): Promise<readonly SourceSummary[]> {
    const out: SourceSummary[] = [];
    for (const s of this.stores.values()) out.push(await summarize(s));
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  get(name: string): Promise<SnapshotStore | null> {
    return Promise.resolve(this.stores.get(name) ?? null);
  }
}

export async function summarize(store: SnapshotStore): Promise<SourceSummary> {
  const caps = await store.captures();
  const ok = caps.filter((c) => c.outcome === 'ok');
  return {
    id: store.source.id,
    name: store.source.name,
    upstreamUrl: store.source.upstreamUrl,
    windowDays: store.source.windowDays,
    captures: caps.length,
    okCaptures: ok.length,
    firstCapture: ok[0]?.date ?? null,
    lastCapture: ok[ok.length - 1]?.date ?? null,
  };
}
