import type { OptionType } from '@trading-app/shared';
import { blackScholesPrice, blackScholesDelta, daysToExpiration } from './black-scholes.js';

/**
 * One row of an option chain enriched with quote/greeks/IV — what Tradier returns
 * via `/markets/options/chains?greeks=true`. All fields except symbol/strike/expiration
 * are optional because providers occasionally return them empty.
 */
export interface OptionChainRow {
  optionSymbol: string;
  underlying: string;
  optionType: OptionType;
  strike: number;
  expiration: string; // YYYY-MM-DD

  bid?: number;
  ask?: number;
  last?: number;
  volume?: number;
  openInterest?: number;

  /** Mid implied volatility from the market. */
  midIv?: number;
  /**
   * Smoothed market volatility ("Theo IV"). When present this is what we use as the
   * model σ to compute the theoretical price — the same surface ThinkOrSwim's "Theo"
   * column is built on. Falls back to averaged neighbour `midIv` when missing.
   */
  smvVol?: number;
}

export type Mispricing = 'expensive' | 'cheap' | 'fair';

export interface OtmMispricingCandidate {
  optionSymbol: string;
  underlying: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  daysToExpiration: number;

  mark: number;
  theo: number;
  /** (mark − theo) / theo. Positive → expensive, negative → cheap. */
  mispricingPct: number;
  classification: Mispricing;

  bid: number;
  ask: number;
  spreadPct: number;
  openInterest: number;
  volume: number;

  /** σ used to compute theo (smvVol if available, else smoothed midIv). */
  ivUsed: number;
  /** Sign-adjusted Black-Scholes delta of the OTM contract. */
  delta: number;
}

export interface OtmScannerOptions {
  /** Annualized risk-free rate used by the BS model (default 0.045). */
  riskFreeRate?: number;
  /** Continuous dividend yield (default 0). */
  dividendYield?: number;
  /** Reject contracts whose (ask − bid)/mid exceeds this (default 0.20 = 20%). */
  maxSpreadPct?: number;
  /** Reject contracts with open interest below this (default 50). */
  minOpenInterest?: number;
  /**
   * Reject contracts whose mid quote is below this dollar floor — penny-quoted
   * far-OTM strikes have unstable mispricing ratios (default 0.05).
   */
  minMark?: number;
  /** |mispricingPct| above this → flagged as expensive/cheap (default 0.15 = 15%). */
  mispricingThresholdPct?: number;
  /** Number of neighbour strikes (each side) used when smoothing midIv (default 3). */
  ivSmoothingWindow?: number;
  /**
   * TRA-1407 — reject candidates whose |Black-Scholes delta| is below this floor
   * (default 0 = no floor, preserving legacy far-OTM behaviour). The demo option
   * journal showed the single_leg_otm sleeve bleeds entirely in low delta
   * (Δ<0.15 avgR −0.075) while Δ≥0.45 makes avgR +0.55 — a floor drops the
   * lottery-ticket tail without touching near-money reads. Applied post-greeks,
   * so it filters the same `delta` that lands on each candidate. Callers pass the
   * board-tuned floor (recommend 0.40) only when the OTM delta-floor flag is on.
   */
  minAbsDelta?: number;
  /** Override of `Date.now()` — test seam. */
  now?: number;
}

const DEFAULTS: Required<Omit<OtmScannerOptions, 'now'>> = {
  riskFreeRate: 0.045,
  dividendYield: 0,
  maxSpreadPct: 0.2,
  minOpenInterest: 50,
  minMark: 0.05,
  mispricingThresholdPct: 0.15,
  ivSmoothingWindow: 3,
  minAbsDelta: 0,
};

function classify(mispricingPct: number, threshold: number): Mispricing {
  if (mispricingPct > threshold) return 'expensive';
  if (mispricingPct < -threshold) return 'cheap';
  return 'fair';
}

/**
 * Average `midIv` across same-type, same-expiration contracts whose strike index
 * is within ±window of `targetIdx`. Used as a fallback when smvVol is missing —
 * a poor-man's vol-surface smoothing.
 */
function smoothedIv(
  sortedSameTypeRows: OptionChainRow[],
  targetIdx: number,
  window: number,
): number | null {
  const lo = Math.max(0, targetIdx - window);
  const hi = Math.min(sortedSameTypeRows.length - 1, targetIdx + window);
  let sum = 0;
  let count = 0;
  for (let i = lo; i <= hi; i += 1) {
    if (i === targetIdx) continue;
    const iv = sortedSameTypeRows[i].midIv;
    if (typeof iv === 'number' && iv > 0) {
      sum += iv;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

/**
 * Scan an option chain for **mispriced out-of-the-money** contracts.
 *
 * Implements the workflow from the task description (TRA-158): compares each OTM
 * contract's market mark to a theoretical Black-Scholes price built off Tradier's
 * smoothed IV (`smv_vol`), gated by tight bid-ask spreads and open interest.
 *
 * The scanner is pure — `chain` is whatever the caller provides (Tradier snapshot,
 * fixture, or merged chain across expirations). Results are sorted by `|mispricingPct|`.
 */
export function findMispricedOtmContracts(
  chain: OptionChainRow[],
  underlyingPrice: number,
  options: OtmScannerOptions = {},
): OtmMispricingCandidate[] {
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) return [];

  const opts = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();

  // Pre-sort same-type rows by strike — needed for IV smoothing fallback.
  const sortedByType = new Map<string, OptionChainRow[]>();
  for (const row of chain) {
    const key = `${row.expiration}|${row.optionType}`;
    let bucket = sortedByType.get(key);
    if (!bucket) {
      bucket = [];
      sortedByType.set(key, bucket);
    }
    bucket.push(row);
  }
  for (const bucket of sortedByType.values()) {
    bucket.sort((a, b) => a.strike - b.strike);
  }

  const candidates: OtmMispricingCandidate[] = [];

  for (const row of chain) {
    // OTM filter: calls need strike > S, puts need strike < S.
    const isOtm =
      row.optionType === 'call' ? row.strike > underlyingPrice : row.strike < underlyingPrice;
    if (!isOtm) continue;

    const bid = row.bid ?? 0;
    const ask = row.ask ?? 0;
    if (bid <= 0 || ask <= 0 || ask < bid) continue;

    const mark = (bid + ask) / 2;
    if (mark < opts.minMark) continue;

    const spreadPct = (ask - bid) / mark;
    if (spreadPct > opts.maxSpreadPct) continue;

    const openInterest = row.openInterest ?? 0;
    if (openInterest < opts.minOpenInterest) continue;

    const dte = daysToExpiration(row.expiration, now);
    if (dte <= 0) continue;

    // Theo IV: smvVol > smoothed neighbour midIv > skip.
    let ivUsed = row.smvVol && row.smvVol > 0 ? row.smvVol : null;
    if (ivUsed == null) {
      const bucket = sortedByType.get(`${row.expiration}|${row.optionType}`)!;
      const idx = bucket.indexOf(row);
      ivUsed = smoothedIv(bucket, idx, opts.ivSmoothingWindow);
    }
    if (ivUsed == null) continue;

    const theo = blackScholesPrice({
      spot: underlyingPrice,
      strike: row.strike,
      timeToExpiryYears: dte / 365,
      riskFreeRate: opts.riskFreeRate,
      volatility: ivUsed,
      optionType: row.optionType,
      dividendYield: opts.dividendYield,
    });
    if (theo <= 0) continue;

    const delta = blackScholesDelta({
      spot: underlyingPrice,
      strike: row.strike,
      timeToExpiryYears: dte / 365,
      riskFreeRate: opts.riskFreeRate,
      volatility: ivUsed,
      optionType: row.optionType,
      dividendYield: opts.dividendYield,
    });

    // TRA-1407 — delta floor: drop far-OTM lottery tickets whose |delta| is below
    // the caller's floor. Off by default (minAbsDelta 0). A missing/NaN delta is
    // treated as failing the floor when one is set (don't admit an un-scored
    // contract past a hard risk gate).
    if (opts.minAbsDelta > 0 && !(Math.abs(delta) >= opts.minAbsDelta)) continue;

    const mispricingPct = (mark - theo) / theo;

    candidates.push({
      optionSymbol: row.optionSymbol,
      underlying: row.underlying,
      optionType: row.optionType,
      strike: row.strike,
      expiration: row.expiration,
      daysToExpiration: dte,
      mark,
      theo,
      mispricingPct,
      classification: classify(mispricingPct, opts.mispricingThresholdPct),
      bid,
      ask,
      spreadPct,
      openInterest,
      volume: row.volume ?? 0,
      ivUsed,
      delta,
    });
  }

  candidates.sort((a, b) => Math.abs(b.mispricingPct) - Math.abs(a.mispricingPct));
  return candidates;
}
