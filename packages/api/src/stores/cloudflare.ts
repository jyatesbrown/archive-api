/** D1 / R2 bindings for SqlClient / BlobReader. Not unit-tested (needs the Workers runtime). */
import type { BlobReader, SqlClient, SqlValue } from './sql-store.js';

import type { Meter } from '../auth/meter.js';
import type { ExportObject, ObjectReader, SqlRunner } from '../export.js';

export class D1Client implements SqlClient, SqlRunner {
  constructor(private readonly db: D1Database) {}
  /** Writes are confined to the bulk_exports ledger; the archive tables stay read-only. */
  async run(sql: string, params: readonly SqlValue[]): Promise<void> {
    await this.db
      .prepare(sql)
      .bind(...params)
      .run();
  }
  async all<T>(sql: string, params: readonly SqlValue[]): Promise<T[]> {
    const res = await this.db
      .prepare(sql)
      .bind(...params)
      .all<T & Record<string, unknown>>();
    return res.results;
  }
  async first<T>(sql: string, params: readonly SqlValue[]): Promise<T | null> {
    const row = await this.db
      .prepare(sql)
      .bind(...params)
      .first<T & Record<string, unknown>>();
    return row ?? null;
  }
}

export class R2Reader implements BlobReader, ObjectReader {
  constructor(private readonly bucket: R2Bucket) {}
  async text(key: string): Promise<string | null> {
    const obj = await this.bucket.get(key);
    return obj ? obj.text() : null;
  }
  async get(key: string): Promise<ExportObject | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, size: obj.size, etag: obj.httpEtag, contentType: obj.httpMetadata?.contentType ?? null };
  }
}

/**
 * One Durable Object per meter subject: a single-threaded counter, so
 * concurrent calls from the same key never lose increments (KV would).
 * Storage keys are `YYYY-MM`; old months are kept for invoicing/audit.
 */
export class MonthlyCounter implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const month = url.searchParams.get('month');
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return new Response('bad month', { status: 400 });
    const current = (await this.state.storage.get<number>(month)) ?? 0;
    if (request.method === 'POST') {
      const next = current + 1;
      await this.state.storage.put(month, next);
      return Response.json({ used: next });
    }
    return Response.json({ used: current });
  }
}

export class DurableObjectMeter implements Meter {
  constructor(private readonly ns: DurableObjectNamespace) {}
  private stub(subject: string): DurableObjectStub {
    return this.ns.get(this.ns.idFromName(subject));
  }
  async hit(subject: string, month: string): Promise<number> {
    const res = await this.stub(subject).fetch(`https://meter/hit?month=${month}`, { method: 'POST' });
    return ((await res.json()) as { used: number }).used;
  }
  async peek(subject: string, month: string): Promise<number> {
    const res = await this.stub(subject).fetch(`https://meter/peek?month=${month}`);
    return ((await res.json()) as { used: number }).used;
  }
}
