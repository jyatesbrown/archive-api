/**
 * The parts of archive-harness's on-disk contract that the fixture must
 * reproduce byte-for-byte: record keys, value hashes, timestamps, payload
 * locators, fingerprints. Each function mirrors a named Python function in the
 * harness; the comment on each names it.
 *
 * Value hashes are computed by the harness as
 *   sha256( repr(("field", json.dumps(value, sort_keys=True))) + b"\x1f" ... )
 * so Python's `repr` and `json.dumps` are reproduced here for the JSON value
 * domain the fixture emits (strings, integers, booleans, null, arrays,
 * objects). Floats are rejected: Python's float repr is not reproduced.
 */

import { createHash } from 'node:crypto';

/** harness.adapter.KEY_SEP */
export const KEY_SEP = '|';

/** harness.adapters.base.PAGE_SEP */
export const PAGE_SEP = '\n--archive-harness-page--\n';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonRecord = { [k: string]: JsonValue };

/** Python `json.dumps(v, sort_keys=True)` with default separators and ensure_ascii=True. */
export function pyJsonDumps(v: JsonValue): string {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      throw new TypeError(`fixture values must be integers; Python float repr is not reproduced (${v})`);
    }
    return String(v);
  }
  if (typeof v === 'string') return pyJsonString(v);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(', ')}]`;
  const keys = Object.keys(v).sort(pyStrCompare);
  return `{${keys.map((k) => `${pyJsonString(k)}: ${pyJsonDumps(v[k] as JsonValue)}`).join(', ')}}`;
}

/** Python compares str by code point; JS `<` compares UTF-16 code units. Identical for BMP text. */
function pyStrCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pyJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (cp < 0x20 || cp > 0x7e) {
      // ensure_ascii: BMP as \uXXXX, astral as a surrogate pair.
      if (cp > 0xffff) {
        const u = cp - 0x10000;
        out += `\\u${hex4(0xd800 + (u >> 10))}\\u${hex4(0xdc00 + (u & 0x3ff))}`;
      } else {
        out += `\\u${hex4(cp)}`;
      }
    } else out += ch;
  }
  return out + '"';
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

/** Categories Python's str.isprintable() rejects (repr escapes these as \xNN/\uNNNN). */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

export function pyReprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp > 0x7f && NON_PRINTABLE.test(ch)) {
      throw new TypeError('pyReprStr: non-printable non-ASCII input is not reproduced');
    }
    if (ch === quote) out += `\\${ch}`;
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + quote;
}

/** Python `repr(("field", "dumped"))` — a 2-tuple of str. */
export function pyReprPair(a: string, b: string): string {
  return `(${pyReprStr(a)}, ${pyReprStr(b)})`;
}

/**
 * harness.adapter.value_hash over harness.adapters.generic_json.GenericJsonAdapter.record_values:
 * for each non-key, non-ignored field in sorted order, the tuple
 * (field, json.dumps(value, sort_keys=True)) is repr'd, hashed, followed by 0x1f.
 */
export function valueHash(record: JsonRecord, keyFields: readonly string[], ignoreFields: readonly string[]): string {
  const h = createHash('sha256');
  const skip = new Set<string>([...keyFields, ...ignoreFields]);
  for (const k of Object.keys(record).sort(pyStrCompare)) {
    if (skip.has(k)) continue;
    h.update(pyReprPair(k, pyJsonDumps(record[k] as JsonValue)), 'utf8');
    h.update(Buffer.from([0x1f]));
  }
  return h.digest('hex');
}

/** harness.adapter.compose_key */
export function composeKey(parts: readonly string[]): string {
  return parts.join(KEY_SEP);
}

/**
 * GenericJsonAdapter.record_key: key_fields in order, with the first 10
 * characters of key_date_field prepended when configured.
 */
export function recordKey(record: JsonRecord, keyFields: readonly string[], keyDateField: string | null): string {
  const parts = keyFields.map((f) => String(record[f]));
  if (keyDateField !== null) parts.unshift(String(record[keyDateField]).slice(0, 10));
  return composeKey(parts);
}

/** harness.storage.sha256 */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Python `dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")` (harness.db.iso). */
export function isoMicros(d: Date, micros = 0): string {
  const base = d.toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
  const us = (d.getUTCMilliseconds() * 1000 + micros).toString().padStart(6, '0');
  return `${base}.${us}Z`;
}

/** Python `dt.strftime("%Y%m%dT%H%M%S%fZ")` (FilesystemPayloadStore.write). */
export function compactMicros(d: Date, micros = 0): string {
  return isoMicros(d, micros).replace(/[-:]/g, '').replace('.', '');
}

/**
 * FilesystemPayloadStore locator: <source>/<YYYY>/<MM>/<compact-ts>-<sha256[:12]>.raw
 * Returned relative to the payload root, exactly as recorded in snapshots.raw_path.
 */
export function payloadLocator(sourceName: string, fetchedAt: Date, contentHash: string, micros = 0): string {
  const yyyy = fetchedAt.toISOString().slice(0, 4);
  const mm = fetchedAt.toISOString().slice(5, 7);
  return `${sourceName}/${yyyy}/${mm}/${compactMicros(fetchedAt, micros)}-${contentHash.slice(0, 12)}.raw`;
}

export interface GenericJsonConfig {
  key_fields: string[];
  records_path: string;
  ignore_fields: string[];
  key_date_field: string | null;
}

/** GenericJsonAdapter.fingerprint(...).as_text() — json.dumps with (",", ":") separators. */
export function fingerprintText(recordCount: number, fieldNames: readonly string[], cfg: GenericJsonConfig): string {
  let key = cfg.key_fields.join(',');
  if (cfg.key_date_field !== null) key = `date(${cfg.key_date_field}),${key}`;
  const selectors = [`json:${cfg.records_path || '$'}`, `key:${key}`, 'pages:none'];
  const fields = [...fieldNames].sort(pyStrCompare);
  return JSON.stringify({ count: recordCount, fields, selectors });
}

/** GenericJsonAdapter.version */
export const GENERIC_JSON_ADAPTER_VERSION = '0.1';
export const GENERIC_JSON_ADAPTER_MODULE = 'harness.adapters.generic_json:GenericJsonAdapter';

/** harness.runner.COUNT_DEVIATION_LIMIT */
export const COUNT_DEVIATION_LIMIT = 0.4;

/** harness.runner.validate_count — returns the ValidationFailed message or null. */
export function validateCount(prevCount: number | null, currCount: number): string | null {
  if (prevCount === null) return null;
  if (prevCount > 0 && currCount === 0) {
    return `zero records extracted; previous successful snapshot had ${prevCount}`;
  }
  if (prevCount > 0) {
    const dev = Math.abs(currCount - prevCount) / prevCount;
    if (dev > COUNT_DEVIATION_LIMIT) {
      return `record count ${currCount} deviates ${pyPercent(dev)} from previous ${prevCount} (limit ${pyPercent(COUNT_DEVIATION_LIMIT)})`;
    }
  }
  return null;
}

/** Python `f"{x:.0%}"` — round-half-even on the percentage. */
function pyPercent(x: number): string {
  const p = x * 100;
  const f = Math.floor(p);
  const frac = p - f;
  let r: number;
  if (frac > 0.5) r = f + 1;
  else if (frac < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  return `${r}%`;
}

/**
 * harness.diff.Window.is_outside: the key component at `keyPart` carries an
 * ISO date; the key is outside the window when that date < asOf.date() - days.
 */
export function isOutsideWindow(recordKey: string, asOfDate: string, days: number, keyPart: number): boolean {
  const parts = recordKey.split(KEY_SEP);
  const comp = parts[keyPart];
  if (comp === undefined) return false;
  const d = comp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return d < addDays(asOfDate, -days);
}

/** ISO date arithmetic in UTC. */
export function addDays(isoDate: string, n: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(t)) throw new RangeError(`bad ISO date ${isoDate}`);
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}
