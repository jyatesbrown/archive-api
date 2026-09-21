import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MemoryStore, type MemoryCaptureInput } from '@archive-api/engine';
import { SMALL_PARAMS, writeFixture, type FixtureManifest } from '@archive-api/fixture';

import { createApp, type App } from '../src/app.js';
import { MemoryResponseCache } from '../src/cache.js';
import { MemoryLogger } from '../src/logging.js';
import { StaticRegistry, type SourceRegistry } from '../src/registry.js';
import { SqlRegistry, type BlobReader, type SqlClient, type SqlValue } from '../src/stores/sql-store.js';

/** node:sqlite behind the async, read-only SqlClient contract. */
export class SqliteClient implements SqlClient {
  readonly db: DatabaseSync;
  readonly queries: string[] = [];
  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
  }
  all<T>(sql: string, params: readonly SqlValue[]): Promise<T[]> {
    this.queries.push(sql);
    return Promise.resolve(this.db.prepare(sql).all(...params) as T[]);
  }
  first<T>(sql: string, params: readonly SqlValue[]): Promise<T | null> {
    this.queries.push(sql);
    return Promise.resolve((this.db.prepare(sql).get(...params) as T | undefined) ?? null);
  }
  close(): void {
    this.db.close();
  }
}

/** Filesystem stand-in for R2: `<prefix><raw_path>` -> `<root>/<raw_path>`. */
export class FsBlobReader implements BlobReader {
  readonly reads: string[] = [];
  constructor(
    private readonly root: string,
    private readonly prefix: string,
  ) {}
  text(key: string): Promise<string | null> {
    this.reads.push(key);
    if (!key.startsWith(this.prefix)) return Promise.resolve(null);
    try {
      return Promise.resolve(readFileSync(join(this.root, key.slice(this.prefix.length)), 'utf8'));
    } catch {
      return Promise.resolve(null);
    }
  }
}

export interface FixtureHarness {
  dir: string;
  manifest: FixtureManifest;
  sql: SqliteClient;
  blobs: FsBlobReader;
  registry: SqlRegistry;
  close(): void;
}

export const PREFIX = 'payloads/';

export function buildFixture(): FixtureHarness {
  const dir = mkdtempSync(join(tmpdir(), 'archive-api-'));
  const res = writeFixture(SMALL_PARAMS, join(dir, 'out'));
  const sql = new SqliteClient(res.dbPath);
  const blobs = new FsBlobReader(res.payloadsRoot, PREFIX);
  const registry = new SqlRegistry(sql, blobs, PREFIX, { [SMALL_PARAMS.sourceName]: { entityFields: ['entity'] } });
  return {
    dir,
    manifest: res.manifest,
    sql,
    blobs,
    registry,
    close() {
      sql.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestApp {
  app: App;
  cache: MemoryResponseCache;
  logger: MemoryLogger;
  get(path: string, init?: RequestInit): Promise<Response>;
}

export function appFor(registry: SourceRegistry, now?: () => Date): TestApp {
  const cache = new MemoryResponseCache();
  const logger = new MemoryLogger();
  const app = createApp(now ? { registry, cache, logger, now } : { registry, cache, logger });
  return {
    app,
    cache,
    logger,
    get: (path, init) => app.fetch(new Request(`https://api.test${path}`, init)),
  };
}

/** Tiny hand-built source for shape/edge tests. */
export function memoryApp(): TestApp & { store: MemoryStore } {
  const rec = (hash: string, entity: string, v: number) => ({ hash, payload: { entity, v } });
  const caps: MemoryCaptureInput[] = [
    { snapshotId: 1, fetchedAt: '2025-01-01T06:00:00Z', outcome: 'ok', contentHash: 'c1', records: new Map([['A', rec('a1', 'Alpha', 1)], ['B', rec('b1', 'Beta', 1)]]) },
    { snapshotId: 2, fetchedAt: '2025-01-02T06:00:00Z', outcome: 'ok', contentHash: 'c2', prevHash: 'c1', records: new Map([['A', rec('a1', 'Alpha', 1)], ['B', rec('b2', 'Beta', 2)]]) },
    { snapshotId: 3, fetchedAt: '2025-01-03T06:00:00Z', outcome: 'validation_failed', contentHash: 'c3', prevHash: 'c2' },
    // 2025-01-04: no capture
    { snapshotId: 4, fetchedAt: '2025-01-05T06:00:00Z', outcome: 'ok', contentHash: 'c4', prevHash: 'c3', records: new Map([['A', rec('a1', 'Alpha', 1)], ['C', rec('c1', 'Gamma', 1)], ['D', rec('d1', 'Delta', 1)]]) },
  ];
  const store = new MemoryStore(
    { id: 7, name: 'mini', upstreamUrl: 'https://upstream.test/mini.json', windowDays: null, windowKeyPart: 0, entityFields: ['entity'] },
    caps,
  );
  return { ...appFor(new StaticRegistry([store])), store };
}

export async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
