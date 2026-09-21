/**
 * Cursor pagination over a `DiffResult`. The diff is deterministic and every
 * category is sorted, so a cursor is just (category, last key seen). It is
 * opaque to clients: base64url(JSON).
 */
import type { DiffResult, Mutation } from '@archive-api/engine';

export const DIFF_CATEGORIES = ['added', 'removed', 'mutated', 'aged_out'] as const;
export type DiffCategory = (typeof DIFF_CATEGORIES)[number];

export interface Cursor {
  /** Category the next page starts in. */
  c: DiffCategory;
  /** Last key emitted in that category ('' = start of category). */
  k: string;
}

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;

export interface DiffEntry {
  category: DiffCategory;
  key: string;
  /** value_hash at `from` (null when added). Filled for mutated here; the handler fills added/removed/aged_out. */
  before: string | null;
  /** value_hash at `to` (null when removed / aged out). */
  after: string | null;
}

export interface DiffPage {
  entries: DiffEntry[];
  nextCursor: string | null;
}

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function unb64url(s: string): string {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(c: Cursor): string {
  return b64url(JSON.stringify(c));
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const v: unknown = JSON.parse(unb64url(s));
    if (typeof v !== 'object' || v === null) return null;
    const { c, k } = v as { c?: unknown; k?: unknown };
    if (typeof c !== 'string' || typeof k !== 'string') return null;
    if (!(DIFF_CATEGORIES as readonly string[]).includes(c)) return null;
    return { c: c as DiffCategory, k };
  } catch {
    return null;
  }
}

function entriesOf(diff: DiffResult, cat: DiffCategory): readonly DiffEntry[] {
  switch (cat) {
    case 'added':
      return diff.added.map((key) => ({ category: cat, key, before: null, after: null }));
    case 'removed':
      return diff.removed.map((key) => ({ category: cat, key, before: null, after: null }));
    case 'aged_out':
      return diff.agedOut.map((key) => ({ category: cat, key, before: null, after: null }));
    case 'mutated':
      return diff.mutated.map((m: Mutation) => ({ category: cat, key: m.key, before: m.before, after: m.after }));
  }
}

/** First index in `arr` whose key is strictly greater than `after` (binary search). */
function firstAfter(arr: readonly DiffEntry[], after: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as DiffEntry).key <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function pageOf(diff: DiffResult, cursor: Cursor | null, limit: number): DiffPage {
  const entries: DiffEntry[] = [];
  let ci = cursor ? DIFF_CATEGORIES.indexOf(cursor.c) : 0;
  let startKey = cursor ? cursor.k : '';
  for (; ci < DIFF_CATEGORIES.length && entries.length < limit; ci++) {
    const cat = DIFF_CATEGORIES[ci] as DiffCategory;
    const all = entriesOf(diff, cat);
    const start = startKey === '' ? 0 : firstAfter(all, startKey);
    const take = Math.min(all.length - start, limit - entries.length);
    for (let i = start; i < start + take; i++) entries.push(all[i] as DiffEntry);
    if (start + take < all.length) {
      return { entries, nextCursor: encodeCursor({ c: cat, k: (entries[entries.length - 1] as DiffEntry).key }) };
    }
    startKey = '';
  }
  // The page filled exactly at a category boundary: point at the next non-empty category, if any.
  for (; ci < DIFF_CATEGORIES.length; ci++) {
    const cat = DIFF_CATEGORIES[ci] as DiffCategory;
    if (entriesOf(diff, cat).length > 0) return { entries, nextCursor: encodeCursor({ c: cat, k: '' }) };
  }
  return { entries, nextCursor: null };
}
