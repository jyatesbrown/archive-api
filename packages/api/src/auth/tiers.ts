/** Tier ladder from the work order: the meter is calls, the lever is lookback depth. */

export type Tier = 'anonymous' | 'free' | 'indie' | 'team' | 'bulk';

export interface TierLimits {
  /** Included calls per calendar month (UTC). `null` = unmetered. */
  callsPerMonth: number | null;
  /** How far back a request may reach, in days from today. `null` = full archive. */
  lookbackDays: number | null;
  /** When the monthly allowance is exhausted: record overage and keep serving, or refuse. */
  onExhausted: 'overage' | 'block';
  bulkExport: 'none' | 'quarterly' | 'once';
  priceUsd: number;
}

export const TIERS: Readonly<Record<Tier, TierLimits>> = {
  // No key at all: enough for the docs console and a curl, nothing more. There is nobody to bill.
  anonymous: { callsPerMonth: 100, lookbackDays: 90, onExhausted: 'block', bulkExport: 'none', priceUsd: 0 },
  free: { callsPerMonth: 1_000, lookbackDays: 90, onExhausted: 'overage', bulkExport: 'none', priceUsd: 0 },
  indie: { callsPerMonth: 25_000, lookbackDays: null, onExhausted: 'overage', bulkExport: 'none', priceUsd: 29 },
  team: { callsPerMonth: 250_000, lookbackDays: null, onExhausted: 'overage', bulkExport: 'quarterly', priceUsd: 149 },
  bulk: { callsPerMonth: null, lookbackDays: null, onExhausted: 'overage', bulkExport: 'once', priceUsd: 400 },
};

/** $1 per 1,000 calls past the allowance. */
export const OVERAGE_USD_PER_1000 = 1;

export const PAID_TIERS: readonly Tier[] = ['indie', 'team', 'bulk'];

export function isTier(s: string): s is Tier {
  return Object.prototype.hasOwnProperty.call(TIERS, s);
}
