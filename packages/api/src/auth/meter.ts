/**
 * Per-subject monthly call counter. A subject is an API key id, or for
 * anonymous callers a hashed client address. Months are UTC `YYYY-MM`.
 *
 * The meter only counts; tier arithmetic (allowance, overage) is `usageFor`.
 */
import { OVERAGE_USD_PER_1000, TIERS, type Tier } from './tiers.js';

export interface Meter {
  /** Record one call and return the month-to-date total including it. */
  hit(subject: string, month: string): Promise<number>;
  /** Month-to-date total without recording. */
  peek(subject: string, month: string): Promise<number>;
}

export interface Usage {
  tier: Tier;
  month: string;
  used: number;
  /** Included calls; null when unmetered. */
  limit: number | null;
  /** Calls past the allowance this month (0 while inside it). */
  overage: number;
  /** Accrued overage charge in USD for the month so far. */
  overageUsd: number;
  remaining: number | null;
}

export function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function usageFor(tier: Tier, month: string, used: number): Usage {
  const limit = TIERS[tier].callsPerMonth;
  const overage = limit === null ? 0 : Math.max(0, used - limit);
  return {
    tier,
    month,
    used,
    limit,
    overage,
    overageUsd: Math.ceil(overage / 1000) * OVERAGE_USD_PER_1000,
    remaining: limit === null ? null : Math.max(0, limit - used),
  };
}

export class MemoryMeter implements Meter {
  readonly counts = new Map<string, number>();
  async hit(subject: string, month: string): Promise<number> {
    const k = `${subject}:${month}`;
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    return n;
  }
  async peek(subject: string, month: string): Promise<number> {
    return this.counts.get(`${subject}:${month}`) ?? 0;
  }
}
