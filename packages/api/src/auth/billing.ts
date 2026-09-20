/**
 * Merchant-of-record seam. The Worker never talks to a payment provider on the
 * request path; it only reports usage and asks for checkout URLs. A real
 * provider (Lemon Squeezy is the intended one) implements this interface; until
 * the account exists, `NoopBilling` keeps the whole build runnable.
 */
import type { Usage } from './meter.js';
import type { Tier } from './tiers.js';

export interface UpgradePath {
  /** Cheapest tier whose limits satisfy the request. */
  tier: Tier;
  /** Where to buy it. Null when the provider cannot sell yet (no-op / not configured). */
  checkoutUrl: string | null;
  /** Human-readable pricing page; always present. */
  pricingUrl: string;
}

export interface BillingProvider {
  readonly name: string;
  /**
   * Report month-to-date usage for a key. Called off the request path (waitUntil)
   * when the count crosses the allowance or a 1,000-call overage boundary,
   * so providers see every billable increment without seeing every call.
   */
  reportUsage(keyId: string, usage: Usage): Promise<void>;
  /** Checkout link for `tier`, optionally pre-associated with an existing key. */
  checkoutUrl(tier: Tier, keyId: string | null): Promise<string | null>;
  pricingUrl(): string;
}

export const DEFAULT_PRICING_URL = 'https://archive-api.dev/pricing';

export class NoopBilling implements BillingProvider {
  readonly name = 'noop';
  readonly reports: Array<{ keyId: string; usage: Usage }> = [];
  constructor(private readonly pricing: string = DEFAULT_PRICING_URL) {}
  async reportUsage(keyId: string, usage: Usage): Promise<void> {
    this.reports.push({ keyId, usage });
  }
  async checkoutUrl(_tier: Tier, _keyId: string | null): Promise<string | null> {
    return null;
  }
  pricingUrl(): string {
    return this.pricing;
  }
}

/** True exactly when this call is one a provider needs to hear about. */
export function isBillableBoundary(usage: Usage): boolean {
  if (usage.limit === null) return false;
  if (usage.used === usage.limit + 1) return true; // first call past the allowance
  return usage.overage > 0 && usage.overage % 1000 === 0; // every further 1,000
}
