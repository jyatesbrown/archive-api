import type { IsoDate } from './types.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Returns true for a real proleptic-Gregorian calendar date written as YYYY-MM-DD. */
export function isIsoDate(s: string): s is IsoDate {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function toEpochDay(date: IsoDate): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError(`not an ISO date: ${date}`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

export function fromEpochDay(n: number): IsoDate {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, n: number): IsoDate {
  return fromEpochDay(toEpochDay(date) + n);
}

/** `to - from` in whole days; negative when `to` precedes `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** Calendar date of a harness timestamp (`YYYY-MM-DDTHH:MM:SS.ffffffZ`). */
export function dateOf(fetchedAt: string): IsoDate {
  return fetchedAt.slice(0, 10);
}
