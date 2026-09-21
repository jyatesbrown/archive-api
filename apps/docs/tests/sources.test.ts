/**
 * The docs' source list must describe what the Worker actually serves, and the
 * pre-filled console query must be a real fixture record on a real capture date
 * — the landing page promises "a real answer without signup".
 */
import { generateFixture, SMALL_PARAMS, HarnessDb, type FixtureSink } from '@archive-api/fixture';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SOURCES } from '../src/config/sources.ts';

const here = dirname(fileURLToPath(import.meta.url));
const wrangler = readFileSync(join(here, '../../../packages/api/wrangler.toml'), 'utf8');

function workerSourceConfig(): Record<string, { entityFields?: string[]; openArchive?: boolean }> {
  const m = /^SOURCE_CONFIG\s*=\s*'(.*)'\s*$/m.exec(wrangler);
  if (!m) throw new Error('SOURCE_CONFIG not found in wrangler.toml');
  return JSON.parse(m[1] as string) as Record<string, { entityFields?: string[]; openArchive?: boolean }>;
}

describe('SOURCES vs the Worker', () => {
  it('lists exactly the sources in SOURCE_CONFIG, with matching entity fields and open-archive flags', () => {
    const cfg = workerSourceConfig();
    expect(SOURCES.map((s) => s.name).sort()).toEqual(Object.keys(cfg).sort());
    for (const s of SOURCES) {
      const c = cfg[s.name] as { entityFields?: string[]; openArchive?: boolean };
      expect(c.entityFields ?? []).toEqual([...s.entityFields]);
      expect(c.openArchive ?? false).toBe(s.openArchive);
    }
  });

  it('has at least one open-archive source for the no-signup console, and unique URL-safe names', () => {
    expect(SOURCES.some((s) => s.openArchive)).toBe(true);
    const names = SOURCES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('fixture_registry sample query', () => {
  it('names a real record and real capture dates in the small fixture', () => {
    const doc = SOURCES.find((s) => s.name === 'fixture_registry');
    if (!doc) throw new Error('fixture_registry not documented');
    const db = new HarnessDb(':memory:');
    const sink: FixtureSink = { db, writePayload: () => undefined };
    const manifest = generateFixture(SMALL_PARAMS, sink);

    expect(doc.windowDays).toBe(SMALL_PARAMS.windowDays);
    expect(doc.sample.key).toBe(manifest.cases.resurrect.key);
    for (const d of [doc.sample.date, doc.sample.from, doc.sample.to]) {
      const snap = manifest.snapshots.find((s) => s.date === d);
      expect(snap, `${d} is a capture day`).toBeDefined();
      expect(snap?.outcome).toBe('ok');
    }
    // The sample asof date is before the record disappears, so the answer is `exact`.
    const gone = manifest.dates[manifest.cases.resurrect.disappearsOnDay] as string;
    const back = manifest.dates[manifest.cases.resurrect.returnsOnDay] as string;
    expect(doc.sample.date < gone).toBe(true);
    expect(doc.sample.from < gone && gone < doc.sample.to && back <= doc.sample.to).toBe(true);
    expect(doc.sample.note).toContain(gone);
    expect(doc.sample.note).toContain(back);
    db.db.close();
  });
});
