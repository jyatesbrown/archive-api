/**
 * Bulk export delivery. The Parquet files are produced offline by
 * scripts/export-parquet.ts and uploaded under `<prefix><source>/<stamp>/`
 * with a `<prefix><source>/latest.json` manifest. The Worker only:
 *
 *   1. entitles: GET /v1/{source}/export — checks the tier's bulkExport
 *      allowance against the ledger, records the grant, and answers with the
 *      manifest plus signed download URLs (no-store, never cached);
 *   2. serves:   GET /v1/{source}/export/{stamp}/{file}?exp=&sig= — verifies
 *      the HMAC and expiry and streams the R2 object. No key, no metering: the
 *      URL is the credential, which is what "signed URL" means to a buyer.
 *
 * A grant is consumed per (key, source, stamp). Asking again for the same stamp
 * re-signs fresh links without consuming another grant, so a lost link is not a
 * lost purchase. A newer stamp is a new export and needs a new allowance.
 */
import type { Principal } from './auth/guard.js';
import { TIERS, type Tier } from './auth/tiers.js';
import type { SqlClient, SqlValue } from './stores/sql-store.js';

export const DEFAULT_EXPORT_PREFIX = 'exports/';
export const DEFAULT_LINK_TTL_S = 7 * 24 * 3600;

export interface ExportObject {
  body: ReadableStream;
  size: number;
  etag: string | null;
  contentType: string | null;
}

export interface ObjectReader {
  text(key: string): Promise<string | null>;
  get(key: string): Promise<ExportObject | null>;
}

export interface ExportGrant {
  keyId: string;
  source: string;
  stamp: string;
  issuedAt: string;
}

export interface ExportLedger {
  grantsFor(keyId: string): Promise<readonly ExportGrant[]>;
  record(grant: ExportGrant): Promise<void>;
}

/** Subset of scripts/parquet-export.ts ExportManifest the Worker relies on. */
export interface ManifestFile {
  name: string;
  content_type: string;
  bytes: number;
  sha256: string;
  rows: number;
}

export interface Manifest {
  schema_version: number;
  stamp: string;
  generated_at: string;
  source: { name: string; license_url: string };
  chain_head: string | null;
  captures: unknown;
  rows: unknown;
  files: ManifestFile[];
}

export function parseManifest(text: string): Manifest | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Partial<Manifest>;
  if (typeof m.stamp !== 'string' || !/^[A-Za-z0-9_-]+$/.test(m.stamp)) return null;
  if (!Array.isArray(m.files) || !m.files.every((f) => typeof f?.name === 'string' && /^[A-Za-z0-9._-]+$/.test(f.name))) return null;
  return m as Manifest;
}

export interface ExportDeps {
  objects: ObjectReader;
  ledger: ExportLedger;
  /** HMAC key for download links. Unset → the export endpoint answers 503. */
  signingSecret: string | null;
  prefix?: string;
  linkTtlS?: number;
}

export type Entitlement =
  | { ok: true }
  | { ok: false; reason: 'not_included' }
  | { ok: false; reason: 'exhausted'; used: readonly ExportGrant[]; resetsAt: string | null };

/** UTC calendar quarter containing `iso`, as its first instant. */
export function quarterStart(iso: string): string {
  const d = new Date(iso);
  const q = Math.floor(d.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(d.getUTCFullYear(), q, 1)).toISOString();
}

export function nextQuarterStart(iso: string): string {
  const d = new Date(quarterStart(iso));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1)).toISOString();
}

/**
 * May `tier` receive `stamp` of `source` now, given the grants already
 * recorded? Pure so the policy is testable without storage.
 */
export function entitlement(tier: Tier, grants: readonly ExportGrant[], source: string, stamp: string, now: string): Entitlement {
  const mode = TIERS[tier].bulkExport;
  if (mode === 'none') return { ok: false, reason: 'not_included' };
  if (grants.some((g) => g.source === source && g.stamp === stamp)) return { ok: true };
  if (mode === 'once') {
    return grants.length === 0 ? { ok: true } : { ok: false, reason: 'exhausted', used: grants, resetsAt: null };
  }
  const since = quarterStart(now);
  const thisQuarter = grants.filter((g) => g.issuedAt >= since);
  return thisQuarter.length === 0 ? { ok: true } : { ok: false, reason: 'exhausted', used: thisQuarter, resetsAt: nextQuarterStart(now) };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function signingInput(source: string, stamp: string, file: string, exp: number): string {
  return `${source}\n${stamp}\n${file}\n${exp}`;
}

export async function signLink(secret: string, source: string, stamp: string, file: string, exp: number): Promise<string> {
  return hmacHex(secret, signingInput(source, stamp, file, exp));
}

export type LinkCheck = 'ok' | 'expired' | 'bad_signature' | 'malformed';

export async function verifyLink(
  secret: string,
  source: string,
  stamp: string,
  file: string,
  expRaw: string | null,
  sig: string | null,
  nowS: number,
): Promise<LinkCheck> {
  if (expRaw === null || sig === null || !/^\d{1,12}$/.test(expRaw) || !/^[0-9a-f]{64}$/.test(sig)) return 'malformed';
  const exp = Number(expRaw);
  const expected = await hmacHex(secret, signingInput(source, stamp, file, exp));
  if (!constantTimeEqual(expected, sig)) return 'bad_signature';
  if (exp < nowS) return 'expired';
  return 'ok';
}

export function exportPath(source: string, stamp: string, file: string): string {
  return `/v1/${encodeURIComponent(source)}/export/${stamp}/${file}`;
}

export interface SignedFile extends ManifestFile {
  url: string;
  expires_at: string;
}

export async function signManifest(
  m: Manifest,
  source: string,
  secret: string,
  ttlS: number,
  now: Date,
): Promise<{ files: SignedFile[]; expiresAt: string }> {
  const exp = Math.floor(now.getTime() / 1000) + ttlS;
  const expiresAt = new Date(exp * 1000).toISOString();
  const files = await Promise.all(
    m.files.map(async (f) => {
      const sig = await signLink(secret, source, m.stamp, f.name, exp);
      return { ...f, url: `${exportPath(source, m.stamp, f.name)}?exp=${exp}&sig=${sig}`, expires_at: expiresAt };
    }),
  );
  return { files, expiresAt };
}

export function manifestKey(prefix: string, source: string): string {
  return `${prefix}${source}/latest.json`;
}

export function objectKey(prefix: string, source: string, stamp: string, file: string): string {
  return `${prefix}${source}/${stamp}/${file}`;
}

export type GrantOutcome =
  | { kind: 'unconfigured' }
  | { kind: 'unavailable' }
  | { kind: 'not_included' }
  | { kind: 'exhausted'; used: readonly ExportGrant[]; resetsAt: string | null }
  | { kind: 'granted'; manifest: Manifest; files: SignedFile[]; expiresAt: string; grant: ExportGrant; repeat: boolean };

/** The whole entitlement step for a keyed principal (callers reject anonymous first). */
export async function grantExport(deps: ExportDeps, principal: Principal & { keyId: string }, source: string, now: Date): Promise<GrantOutcome> {
  if (!deps.signingSecret) return { kind: 'unconfigured' };
  const prefix = deps.prefix ?? DEFAULT_EXPORT_PREFIX;
  const text = await deps.objects.text(manifestKey(prefix, source));
  const manifest = text === null ? null : parseManifest(text);
  if (!manifest) return { kind: 'unavailable' };
  const grants = await deps.ledger.grantsFor(principal.keyId);
  const nowIso = now.toISOString();
  const e = entitlement(principal.tier, grants, source, manifest.stamp, nowIso);
  if (!e.ok) return e.reason === 'not_included' ? { kind: 'not_included' } : { kind: 'exhausted', used: e.used, resetsAt: e.resetsAt };
  const existing = grants.find((g) => g.source === source && g.stamp === manifest.stamp);
  const grant: ExportGrant = existing ?? { keyId: principal.keyId, source, stamp: manifest.stamp, issuedAt: nowIso };
  if (!existing) await deps.ledger.record(grant);
  const signed = await signManifest(manifest, source, deps.signingSecret, deps.linkTtlS ?? DEFAULT_LINK_TTL_S, now);
  return { kind: 'granted', manifest, ...signed, grant, repeat: existing !== undefined };
}

export interface SqlRunner {
  run(sql: string, params: readonly SqlValue[]): Promise<void>;
}

/** contract/exports.sql */
export class SqlExportLedger implements ExportLedger {
  constructor(
    private readonly sql: SqlClient,
    private readonly writer: SqlRunner,
  ) {}
  async grantsFor(keyId: string): Promise<readonly ExportGrant[]> {
    const rows = await this.sql.all<{ key_id: string; source: string; stamp: string; issued_at: string }>(
      'SELECT key_id, source, stamp, issued_at FROM bulk_exports WHERE key_id = ? ORDER BY issued_at',
      [keyId],
    );
    return rows.map((r) => ({ keyId: r.key_id, source: r.source, stamp: r.stamp, issuedAt: r.issued_at }));
  }
  async record(g: ExportGrant): Promise<void> {
    await this.writer.run('INSERT OR IGNORE INTO bulk_exports (key_id, source, stamp, issued_at) VALUES (?, ?, ?, ?)', [
      g.keyId,
      g.source,
      g.stamp,
      g.issuedAt,
    ]);
  }
}

export class MemoryExportLedger implements ExportLedger {
  readonly grants: ExportGrant[] = [];
  async grantsFor(keyId: string): Promise<readonly ExportGrant[]> {
    return this.grants.filter((g) => g.keyId === keyId);
  }
  async record(g: ExportGrant): Promise<void> {
    if (!this.grants.some((x) => x.keyId === g.keyId && x.source === g.source && x.stamp === g.stamp)) this.grants.push(g);
  }
}
