import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GENERIC_JSON_ADAPTER_MODULE,
  GENERIC_JSON_ADAPTER_VERSION,
  recordKey,
  valueHash,
  type JsonRecord,
} from '../src/index.js';
import { buildFixture, type Fixture } from './helpers.js';

let fx: Fixture;
beforeAll(() => {
  fx = buildFixture();
});
afterAll(() => fx.close());

describe('R2 layout', () => {
  it('emits harness.sqlite, payloads/<source>/YYYY/MM/*.raw and a manifest', () => {
    expect(existsSync(fx.dbPath)).toBe(true);
    expect(existsSync(fx.manifestPath)).toBe(true);
    const src = join(fx.payloadsRoot, fx.manifest.source.name);
    for (const y of readdirSync(src)) {
      expect(y).toMatch(/^\d{4}$/);
      for (const m of readdirSync(join(src, y))) {
        expect(m).toMatch(/^\d{2}$/);
        for (const f of readdirSync(join(src, y, m))) {
          expect(f).toMatch(/^\d{8}T\d{12}Z-[0-9a-f]{12}\.raw$/);
        }
      }
    }
  });

  it('every snapshots row points at an existing payload whose sha256 and size match', () => {
    const rows = fx.db.prepare('SELECT raw_path, content_hash, byte_length FROM snapshots').all() as Array<{
      raw_path: string;
      content_hash: string;
      byte_length: number;
    }>;
    expect(rows.length).toBe(fx.manifest.snapshots.filter((s) => s.snapshotId !== null).length);
    for (const r of rows) {
      const p = join(fx.payloadsRoot, r.raw_path);
      expect(statSync(p).size).toBe(r.byte_length);
      expect(createHash('sha256').update(readFileSync(p)).digest('hex')).toBe(r.content_hash);
      expect(r.raw_path.endsWith(`${r.content_hash.slice(0, 12)}.raw`)).toBe(true);
    }
  });

  it('prev_hash chain is intact and starts at null', () => {
    const rows = fx.db.prepare('SELECT content_hash, prev_hash FROM snapshots ORDER BY id').all() as Array<{
      content_hash: string;
      prev_hash: string | null;
    }>;
    expect(rows[0]?.prev_hash).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i]?.prev_hash).toBe(rows[i - 1]?.content_hash);
  });

  it('record_index re-derives from the raw payload with the adapter config (extract parity)', () => {
    const cfg = fx.manifest.source.adapter_config;
    for (const s of fx.manifest.snapshots) {
      if (s.snapshotId === null || s.outcome !== 'ok') continue;
      const payload = fx.payloadFor(s.snapshotId);
      const derived = new Map<string, string>();
      for (const rec of payload.records as JsonRecord[]) {
        derived.set(recordKey(rec, cfg.key_fields, cfg.key_date_field), valueHash(rec, cfg.key_fields, cfg.ignore_fields));
      }
      const indexed = fx.indexFor(s.snapshotId);
      expect(indexed.size, `day ${s.day}`).toBe(derived.size);
      for (const [k, v] of derived) expect(indexed.get(k), `${s.day} ${k}`).toBe(v);
    }
  });

  it('sources row uses the generic JSON adapter with the harness module path and version', () => {
    const src = fx.db.prepare('SELECT * FROM sources').all() as Array<Record<string, unknown>>;
    expect(src).toHaveLength(1);
    expect(src[0]?.['adapter_module']).toBe(GENERIC_JSON_ADAPTER_MODULE);
    expect(JSON.parse(src[0]?.['adapter_config'] as string)).toEqual(fx.manifest.source.adapter_config);
    const versions = fx.db.prepare('SELECT DISTINCT adapter_version AS v FROM snapshots').all() as Array<{ v: string }>;
    expect(versions).toEqual([{ v: GENERIC_JSON_ADAPTER_VERSION }]);
  });

  it('run_diffs per ok snapshot; source_health per stored snapshot (as runner.py does)', () => {
    const ok = fx.manifest.snapshots.filter((s) => s.outcome === 'ok').length;
    const stored = fx.manifest.snapshots.filter((s) => s.snapshotId !== null).length;
    const diffs = fx.db.prepare('SELECT COUNT(*) AS n FROM run_diffs').get() as { n: number };
    const health = fx.db.prepare('SELECT COUNT(*) AS n FROM source_health').get() as { n: number };
    expect(diffs.n).toBe(ok);
    expect(health.n).toBe(stored);
    expect(stored).toBe(ok + 1);
  });
});

describe('append-only enforcement (harness triggers)', () => {
  it('rejects UPDATE and DELETE on every harness table', () => {
    const rw = new DatabaseSync(fx.dbPath);
    try {
      for (const t of ['snapshots', 'record_index', 'run_diffs', 'key_events', 'source_health', 'alerts']) {
        expect(() => rw.exec(`DELETE FROM ${t}`), `delete ${t}`).toThrow(/append-only/);
      }
      expect(() => rw.exec("UPDATE snapshots SET content_hash = 'x'")).toThrow(/append-only/);
      expect(() => rw.exec("UPDATE record_index SET value_hash = 'x'")).toThrow(/append-only/);
    } finally {
      rw.close();
    }
  });
});
