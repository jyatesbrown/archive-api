import { addDays, isIsoDate } from '@archive-api/engine';

import type { BillingProvider, UpgradePath } from './billing.js';
import { extractBearer, looksLikeKey, prefixOf, sha256Hex, type KeyStore } from './keys.js';
import { monthOf, usageFor, type Meter, type Usage } from './meter.js';
import { PAID_TIERS, TIERS, type Tier } from './tiers.js';

import { problem } from '../problem.js';

export interface Principal {
  tier: Tier;
  /** Meter subject: key id, or a hash of the client address for anonymous callers. */
  subject: string;
  keyId: string | null;
  keyPrefix: string | null;
}

export interface AuthDeps {
  keys: KeyStore;
  meter: Meter;
  billing: BillingProvider;
}

export type AuthOutcome = { ok: true; principal: Principal } | { ok: false; response: Response };

/**
 * Identify the caller. No credential → anonymous (allowed, tightly limited).
 * A credential that is malformed, unknown or revoked → 401; we never fall back
 * to anonymous for a bad key, that would hide broken integrations.
 */
export async function authenticate(request: Request, keys: KeyStore, instance: string): Promise<AuthOutcome> {
  const presented = extractBearer(request);
  if (presented === null) {
    const addr = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
    return { ok: true, principal: { tier: 'anonymous', subject: `anon:${(await sha256Hex(addr)).slice(0, 32)}`, keyId: null, keyPrefix: null } };
  }
  const prefix = prefixOf(presented);
  if (!looksLikeKey(presented) || prefix === null) {
    return { ok: false, response: unauthorized('The API key is malformed', instance, null) };
  }
  const record = await keys.byHash(await sha256Hex(presented));
  if (!record) return { ok: false, response: unauthorized('Unknown API key', instance, prefix) };
  if (record.revokedAt !== null) {
    return { ok: false, response: unauthorized('This API key was revoked', instance, prefix, { revoked_at: record.revokedAt }) };
  }
  return { ok: true, principal: { tier: record.tier, subject: `key:${record.id}`, keyId: record.id, keyPrefix: record.prefix } };
}

function unauthorized(detail: string, instance: string, prefix: string | null, ext: Record<string, unknown> = {}): Response {
  const res = problem('invalid_key', 401, detail, instance, { key_prefix: prefix, ...ext });
  res.headers.set('www-authenticate', 'Bearer realm="archive-api"');
  return res;
}

/** Earliest date a tier may ask about, or null for the full archive. */
export function earliestAllowed(tier: Tier, today: string): string | null {
  const days = TIERS[tier].lookbackDays;
  if (days === null) return null;
  if (!isIsoDate(today)) throw new Error(`bad today ${today}`);
  return addDays(today, -days);
}

export async function upgradePath(billing: BillingProvider, principal: Principal, need: 'lookback' | 'calls'): Promise<UpgradePath> {
  const tier =
    need === 'lookback' ? (PAID_TIERS.find((t) => TIERS[t].lookbackDays === null) as Tier) : principal.tier === 'anonymous' ? 'free' : 'indie';
  return { tier, checkoutUrl: await billing.checkoutUrl(tier, principal.keyId), pricingUrl: billing.pricingUrl() };
}

/**
 * 402 when `date` lies before the tier's window. Malformed dates are not our
 * concern here (the engine rejects them with 400); only well-formed, too-old ones.
 */
export async function lookbackProblem(
  principal: Principal,
  date: string,
  parameter: string,
  today: string,
  instance: string,
  billing: BillingProvider,
): Promise<Response | null> {
  const earliest = earliestAllowed(principal.tier, today);
  if (earliest === null || !isIsoDate(date) || date >= earliest) return null;
  const up = await upgradePath(billing, principal, 'lookback');
  return problem(
    'lookback_exceeded',
    402,
    `The ${principal.tier} tier can query the last ${TIERS[principal.tier].lookbackDays} days (from ${earliest}); '${parameter}=${date}' is earlier. Upgrade to ${up.tier} for the full archive.`,
    instance,
    {
      parameter,
      requested: date,
      tier: principal.tier,
      lookback_days: TIERS[principal.tier].lookbackDays,
      earliest_allowed: earliest,
      upgrade: up,
    },
  );
}

export interface MeterOutcome {
  usage: Usage;
  /** Set when the tier blocks rather than accrues overage and the allowance is gone. */
  blocked: Response | null;
}

export async function meterCall(principal: Principal, deps: AuthDeps, now: Date, instance: string): Promise<MeterOutcome> {
  const month = monthOf(now);
  const used = await deps.meter.hit(principal.subject, month);
  const usage = usageFor(principal.tier, month, used);
  if (usage.limit !== null && usage.used > usage.limit && TIERS[principal.tier].onExhausted === 'block') {
    const up = await upgradePath(deps.billing, principal, 'calls');
    const res = problem(
      'quota_exhausted',
      429,
      `Anonymous callers get ${usage.limit} calls per month; a free API key raises that to ${TIERS.free.callsPerMonth} with overage instead of a cutoff.`,
      instance,
      { tier: principal.tier, limit: usage.limit, used: usage.used, month, upgrade: up },
    );
    res.headers.set('retry-after', String(secondsToNextMonth(now)));
    return { usage, blocked: res };
  }
  return { usage, blocked: null };
}

export function secondsToNextMonth(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export function usageHeaders(res: Response, usage: Usage): void {
  res.headers.set('x-tier', usage.tier);
  if (usage.limit !== null) {
    res.headers.set('x-ratelimit-limit', String(usage.limit));
    res.headers.set('x-ratelimit-used', String(usage.used));
    res.headers.set('x-ratelimit-remaining', String(usage.remaining));
    if (usage.overage > 0) res.headers.set('x-overage-calls', String(usage.overage));
  }
}
