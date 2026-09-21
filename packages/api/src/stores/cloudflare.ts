/** D1 / R2 bindings for SqlClient / BlobReader. Not unit-tested (needs the Workers runtime). */
import type { BlobReader, SqlClient, SqlValue } from './sql-store.js';

export class D1Client implements SqlClient {
  constructor(private readonly db: D1Database) {}
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

export class R2Reader implements BlobReader {
  constructor(private readonly bucket: R2Bucket) {}
  async text(key: string): Promise<string | null> {
    const obj = await this.bucket.get(key);
    return obj ? obj.text() : null;
  }
}
