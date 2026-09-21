/**
 * API keys. The plaintext is shown once at mint time and never stored; the
 * store holds sha256(plaintext) plus a short prefix so support can talk about
 * "the key starting ak_live_3f9c…" without ever seeing the secret.
 *
 * Format: ak_<env>_<prefix:8>_<secret:32>   (base32-ish alphabet, no ambiguous chars)
 */
import { isTier, type Tier } from './tiers.js';

import type { SqlClient } from '../stores/sql-store.js';

export const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const KEY_PREFIX_LENGTH = 8;
export const KEY_SECRET_LENGTH = 32;
const KEY_RE = /^ak_(live|test)_([a-z2-9]{8})_([a-z2-9]{32})$/;

export interface ApiKeyRecord {
  id: string;
  /** Visible part, e.g. `ak_live_3f9cq2mk`. Safe to log and to show in a dashboard. */
  prefix: string;
  tier: Tier;
  /** Free-form owner label (email, org). Never used for auth. */
  owner: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface KeyStore {
  /** Look up by sha256 hex of the plaintext key. Must return revoked keys too; the caller decides. */
  byHash(hash: string): Promise<ApiKeyRecord | null>;
}

export interface MintedKey {
  plaintext: string;
  hash: string;
  record: ApiKeyRecord;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function prefixOf(plaintext: string): string | null {
  const m = KEY_RE.exec(plaintext);
  return m ? `ak_${m[1]}_${m[2]}` : null;
}

export function looksLikeKey(s: string): boolean {
  return KEY_RE.test(s);
}

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  // 31-char alphabet; modulo bias is 256 % 31 = 8/256 per char, irrelevant at 32 chars of entropy (~158 bits).
  for (const b of bytes) out += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return out;
}

export async function mintKey(
  tier: Tier,
  owner: string | null,
  env: 'live' | 'test' = 'live',
  now: () => Date = () => new Date(),
): Promise<MintedKey> {
  if (!isTier(tier) || tier === 'anonymous') throw new Error(`cannot mint a key for tier '${tier}'`);
  const prefix = randomChars(KEY_PREFIX_LENGTH);
  const plaintext = `ak_${env}_${prefix}_${randomChars(KEY_SECRET_LENGTH)}`;
  const hash = await sha256Hex(plaintext);
  return {
    plaintext,
    hash,
    record: {
      id: crypto.randomUUID(),
      prefix: `ak_${env}_${prefix}`,
      tier,
      owner,
      createdAt: now().toISOString(),
      revokedAt: null,
    },
  };
}

/** Constant-time-ish compare is unnecessary: we compare hashes looked up by hash. */
export function extractBearer(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1] as string;
  }
  return request.headers.get('x-api-key');
}

export class MemoryKeyStore implements KeyStore {
  private readonly byHashMap = new Map<string, ApiKeyRecord>();
  add(hash: string, record: ApiKeyRecord): void {
    this.byHashMap.set(hash, record);
  }
  async byHash(hash: string): Promise<ApiKeyRecord | null> {
    return this.byHashMap.get(hash) ?? null;
  }
}

interface KeyRow {
  id: string;
  prefix: string;
  key_hash: string;
  tier: string;
  owner: string | null;
  created_at: string;
  revoked_at: string | null;
}

/** Reads the `api_keys` table (see contract/api-keys.sql). Minting/revoking happens via scripts, not the Worker. */
export class SqlKeyStore implements KeyStore {
  constructor(private readonly sql: SqlClient) {}
  async byHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = await this.sql.first<KeyRow>(
      'SELECT id, prefix, key_hash, tier, owner, created_at, revoked_at FROM api_keys WHERE key_hash = ?',
      [hash],
    );
    if (!row) return null;
    if (!isTier(row.tier)) throw new Error(`api_keys.tier '${row.tier}' for ${row.prefix} is not a known tier`);
    return {
      id: row.id,
      prefix: row.prefix,
      tier: row.tier,
      owner: row.owner,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }
}
