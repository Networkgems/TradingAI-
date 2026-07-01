// TRA-1216 (parent TRA-1214, epic TRA-1210) — perpetual funding-rate carry
// OBSERVE-ONLY scanner. Thin sibling to `iv-rv-scanner.ts` (TRA-1156): a PURE
// `scanFundingCarry(observations, cfg)` over funding observations the caller
// already fetched, plus an in-memory latest-wins store backing the read-only
// `GET /api/health/perp-funding-carry` surface. It places NO orders, sizes
// nothing, and touches no account — the short-perp leg carries a liquidation
// note but is never sized here.
//
// The signal is a delta-neutral funding carry: long spot / short perp. When
// funding is POSITIVE longs pay shorts, so the short-perp leg RECEIVES funding
// and the structure earns carry. When funding is NEGATIVE the carry reverses and
// the structure bleeds — hence the funding-sign gate (spec §1/§3): candidacy
// requires `fundingRate > 0`; the signed magnitude is ALWAYS surfaced, never
// assumed positive. Null/missing funding fails closed (no phantom positive).
//
// In-memory (not a persisted store) by design: the carry candidates are
// transient observe-only reads the board watches to decide thresholds — the ONLY
// persisted artifact is the forward funding-history JSONL (perp-funding-history.ts),
// which is what unblocks a future carry backtest.

import type { PerpCarryConfig } from './perp-funding-carry-flag.js';

/** Hours between funding settlements for an observation's venue (INTX = 1). */
const HOURS_PER_YEAR = 365 * 24; // 8760

/** Observe note attached to every candidate (invariant #4 — no sizing here). */
export const SHORT_PERP_LIQ_NOTE =
  'short-perp leg; liquidation risk on upside — hold with margin buffer; ' +
  'spot hedge offsets PnL not margin-call timing';

/** Funding sign, or null when funding is missing. */
export type FundingSign = 'positive' | 'negative' | 'zero' | null;

/** Why a symbol is ineligible, or null when it is an eligible carry candidate. */
export type FundingCarryReason =
  | 'funding_sign_negative'
  | 'net_apr_negative'
  | 'funding_data_missing'
  | null;

/**
 * One funding observation the caller fetched for a perp product. `fundingRate`
 * is the per-interval decimal (signed); `null` means the venue returned no rate
 * (fail-closed). `intervalHours` is the venue's funding cadence — annualization
 * is driven OFF this, never a hardcoded 8h (spec §2): INTX funds hourly ⇒ 1.
 */
export interface FundingObservation {
  productId: string;
  fundingRate: number | null;
  intervalHours: number;
  markPrice?: number | null;
  /** Observation time, ms epoch. Defaults to the scan clock when omitted. */
  ts?: number;
}

/** A ranked (or ineligible-with-reason) funding-carry read — observe-only. */
export interface FundingCarryCandidate {
  productId: string;
  /** Signed per-interval funding magnitude, or null when missing. Always surfaced. */
  fundingRate: number | null;
  sign: FundingSign;
  intervalHours: number;
  /** Annualised funding APR off `intervalHours`, or null when funding is missing. */
  fundingApr: number | null;
  /** `fundingApr − borrowApr`, or null when funding is missing. */
  netApr: number | null;
  eligible: boolean;
  reason: FundingCarryReason;
  /** `strong` when `netApr ≥ minNetApr`, else `marginal`; null when ineligible. */
  strength: 'strong' | 'marginal' | null;
  /** Days of funding needed to earn back round-trip fees; null unless funding APR > 0. */
  daysToFeeBreakeven: number | null;
  /** Inherent to the short-perp leg — always true (invariant #4). */
  shortPerpLiquidationRisk: true;
  liqNote: string;
  markPrice: number | null;
  asOf: string;
}

function classifySign(rate: number | null): FundingSign {
  if (rate == null || !Number.isFinite(rate)) return null;
  if (rate > 0) return 'positive';
  if (rate < 0) return 'negative';
  return 'zero';
}

/**
 * Score one funding observation into a carry candidate. Pure. Annualization is
 * driven off the observation's own `intervalHours` (spec §2) so a venue that
 * differs from INTX's hourly cadence is handled without a code change.
 */
function scoreObservation(
  obs: FundingObservation,
  cfg: PerpCarryConfig,
  asOfIso: string,
): FundingCarryCandidate {
  const productId = obs.productId.trim().toUpperCase();
  const markPrice =
    obs.markPrice != null && Number.isFinite(obs.markPrice) && obs.markPrice > 0
      ? obs.markPrice
      : null;
  const base = {
    productId,
    intervalHours: obs.intervalHours,
    shortPerpLiquidationRisk: true as const,
    liqNote: SHORT_PERP_LIQ_NOTE,
    markPrice,
    asOf: asOfIso,
  };

  const rate = obs.fundingRate;
  const sign = classifySign(rate);

  // Fail-closed: missing funding is never a phantom positive.
  if (rate == null || sign == null) {
    return {
      ...base,
      fundingRate: null,
      sign: null,
      fundingApr: null,
      netApr: null,
      eligible: false,
      reason: 'funding_data_missing',
      strength: null,
      daysToFeeBreakeven: null,
    };
  }

  // Annualize off the per-observation interval — NOT a hardcoded multiplier.
  const intervalsPerYear =
    Number.isFinite(obs.intervalHours) && obs.intervalHours > 0
      ? HOURS_PER_YEAR / obs.intervalHours
      : NaN;
  const fundingApr = Number.isFinite(intervalsPerYear) ? rate * intervalsPerYear : null;
  const netApr = fundingApr == null ? null : fundingApr - cfg.borrowApr;

  // Funding-sign gate (invariant #3): non-positive funding cannot carry a
  // long-spot/short-perp structure — surface the signed magnitude but ineligible.
  if (rate <= 0) {
    return {
      ...base,
      fundingRate: rate,
      sign,
      fundingApr,
      netApr,
      eligible: false,
      reason: 'funding_sign_negative',
      strength: null,
      daysToFeeBreakeven: null,
    };
  }

  // Breakeven horizon: one-time round-trip fees amortized over funding days.
  // Only meaningful when funding APR is positive (guarded above via rate > 0).
  const fundingAprBps = (fundingApr ?? 0) * 10_000;
  const daysToFeeBreakeven =
    fundingAprBps > 0 ? cfg.feeBpsRoundTrip / (fundingAprBps / 365) : null;

  // Eligibility: fundingRate > 0 AND netApr > 0. Positive funding but net-negative
  // after borrow is an explicit ineligible reason.
  if (netApr == null || netApr <= 0) {
    return {
      ...base,
      fundingRate: rate,
      sign,
      fundingApr,
      netApr,
      eligible: false,
      reason: 'net_apr_negative',
      strength: null,
      daysToFeeBreakeven,
    };
  }

  return {
    ...base,
    fundingRate: rate,
    sign,
    fundingApr,
    netApr,
    eligible: true,
    reason: null,
    strength: netApr >= cfg.minNetApr ? 'strong' : 'marginal',
    daysToFeeBreakeven,
  };
}

/**
 * Score a batch of funding observations into carry candidates. Pure — no I/O, no
 * orders. Eligible candidates are ranked by `netApr` descending; ineligible ones
 * are surfaced too (observe-only wants the full distribution) after the eligible
 * block, ordered by productId for stability.
 *
 * @param now injected clock (ms) so the `asOf` stamp is deterministic in tests.
 */
export function scanFundingCarry(
  observations: readonly FundingObservation[],
  cfg: PerpCarryConfig,
  now: number = Date.now(),
): FundingCarryCandidate[] {
  const asOfIso = new Date(now).toISOString();
  const scored = observations.map((o) => scoreObservation(o, cfg, asOfIso));
  scored.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.eligible && b.eligible) {
      return (b.netApr ?? 0) - (a.netApr ?? 0) || a.productId.localeCompare(b.productId);
    }
    return a.productId.localeCompare(b.productId);
  });
  return scored;
}

// ── In-memory latest-scan store (backs GET /api/health/perp-funding-carry) ───

interface StoredCandidate {
  candidate: FundingCarryCandidate;
  recordedAt: number;
}

/** Cap on retained perps so the store can't grow unbounded over a long run. */
const MAX_STORED_SYMBOLS = 128;
/**
 * Entries older than this are swept on read. Funding refreshes hourly, so the
 * TTL sits above one hour (2h) — a top-of-hour scan stays fresh until the next
 * hourly refresh replaces it, with buffer for a missed tick.
 */
const STORE_TTL_MS = 2 * 60 * 60_000;

const store = new Map<string, StoredCandidate>();

/**
 * Record a batch of carry candidates (latest-wins per productId). Oldest-inserted
 * symbols are evicted past the cap. Observe-only — callers gate on the flag, so
 * the store stays empty when the scanner is off.
 */
export function recordFundingCarryScan(
  candidates: readonly FundingCarryCandidate[],
  now: number = Date.now(),
): void {
  for (const c of candidates) {
    const key = c.productId.trim().toUpperCase();
    store.delete(key); // re-insert at the tail so eviction is oldest-first
    store.set(key, { candidate: { ...c, productId: key }, recordedAt: now });
  }
  while (store.size > MAX_STORED_SYMBOLS) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Test seam — drop every recorded candidate. */
export function clearFundingCarryScans(): void {
  store.clear();
}

/** One perp's most-recent carry read, plus when it was recorded. */
export interface FundingCarryScanView extends FundingCarryCandidate {
  recordedAt: string;
}

export interface FundingCarryScansSummary {
  /** Perps with a fresh (within-TTL) recorded scan. */
  symbolCount: number;
  /** Eligible carry candidates across all fresh scans. */
  candidateCount: number;
  scans: FundingCarryScanView[];
}

/**
 * Fold the store into the read-only diagnostics summary, dropping entries past
 * the TTL and ranking eligible candidates by `netApr` first (then productId).
 * Pure beyond the injected clock.
 */
export function summarizeFundingCarryScans(now: number = Date.now()): FundingCarryScansSummary {
  const views: FundingCarryScanView[] = [];
  for (const [key, entry] of store) {
    if (now - entry.recordedAt >= STORE_TTL_MS) {
      store.delete(key);
      continue;
    }
    views.push({ ...entry.candidate, recordedAt: new Date(entry.recordedAt).toISOString() });
  }
  views.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.eligible && b.eligible) {
      return (b.netApr ?? 0) - (a.netApr ?? 0) || a.productId.localeCompare(b.productId);
    }
    return a.productId.localeCompare(b.productId);
  });
  return {
    symbolCount: views.length,
    candidateCount: views.filter((v) => v.eligible).length,
    scans: views,
  };
}
