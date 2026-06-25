import type { OptionType } from '@trading-app/shared';
import { blackScholesPrice, blackScholesDelta, bsImpliedVolatility, daysToExpiration } from './black-scholes.js';
import { trailingRealisedVol } from '../vol-kelly-sizer.js';
import type { OptionChainRow } from './otm-mispricing.js';

/**
 * TRA-1155 — Mispriced Options Signal Engine (implied-vol vs realised-vol edge).
 *
 * The existing scanners measure a strike's richness *cross-sectionally*:
 * {@link findMispricedOtmContracts} compares its mark to a Black-Scholes price
 * built off the contract's **own** smoothed IV, and the relative-value scanner
 * z-scores a strike against a fitted skew curve. Neither answers the question
 * the task asks first: **is the option's implied vol rich or cheap relative to
 * the underlying's realised (historical) volatility?** — the volatility-risk-
 * premium read.
 *
 * This engine closes that gap. For each liquid contract it:
 *   1. resolves the contract's market IV (smvVol → midIv → BS-implied fallback),
 *   2. prices a Black-Scholes "fair value" using **realised vol** as σ (the
 *      baseline a vol seller/buyer marks against),
 *   3. compares mark to that RV-fair value and the IV/RV ratio, and
 *   4. emits a SELL_PREMIUM / BUY_PREMIUM signal when both the IV/RV ratio and
 *      the price deviation clear their thresholds.
 *
 * It is pure — `chain`, `underlyingPrice` and `realizedVol` are whatever the
 * caller supplies (live Tradier snapshot, fixture, or backtest slice). The
 * realised-vol estimate can be produced from daily closes via
 * {@link realizedVolFromDailyCloses}, which wraps the same TRA-430
 * close-to-close estimator the vol/Kelly sizer uses.
 */

export type IvRvAction = 'SELL_PREMIUM' | 'BUY_PREMIUM' | 'NONE';

export interface IvRvMispricingCandidate {
  optionSymbol: string;
  underlying: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  daysToExpiration: number;

  mark: number;
  /** Black-Scholes fair value priced with realised vol as σ. */
  fairValue: number;
  /** (mark − fairValue) / fairValue. Positive → market richer than RV-fair. */
  mispricingPct: number;

  /** Contract's market implied vol (smvVol → midIv → BS-implied fallback). */
  impliedVol: number;
  /** Underlying's annualised realised vol used as the baseline σ. */
  realizedVol: number;
  /** impliedVol / realizedVol. > 1 → IV richer than RV (premium expensive). */
  ivRvRatio: number;

  action: IvRvAction;
  /** Composite rank: |mispricingPct| weighted by contract liquidity. */
  score: number;
  /** Human-readable explanation of the classification. */
  reason: string;

  bid: number;
  ask: number;
  spreadPct: number;
  openInterest: number;
  volume: number;
  /** Sign-adjusted Black-Scholes delta at the contract's own market IV. */
  delta: number;
}

export interface IvRvScannerOptions {
  /** Annualised risk-free rate used by the BS model (default 0.045). */
  riskFreeRate?: number;
  /** Continuous dividend yield (default 0). */
  dividendYield?: number;

  /** Reject contracts with open interest below this (default 1000 — task §3). */
  minOpenInterest?: number;
  /** Reject contracts with daily volume below this (default 250 — task §3). */
  minVolume?: number;
  /** Reject contracts whose mid quote is below this dollar floor (default 0.10). */
  minMark?: number;
  /** Reject contracts whose (ask − bid)/mid exceeds this (default 0.20 = 20%). */
  maxSpreadPct?: number;
  /** Only surface contracts with this many days-to-expiration or fewer (default 90 — task §3). */
  maxDaysToExpiration?: number;

  /**
   * IV/RV ratio at or above which a contract is a SELL_PREMIUM candidate
   * (default 1.30 — task §1: OTM IV materially above realised vol).
   */
  sellIvRvRatio?: number;
  /**
   * IV/RV ratio at or below which a contract is a BUY_PREMIUM candidate
   * (default 0.70).
   */
  buyIvRvRatio?: number;
  /**
   * |mispricingPct| above which the price deviation is considered actionable
   * (default 0.25 = 25%). A signal needs BOTH the ratio AND the price gate.
   */
  mispricingThresholdPct?: number;

  /** When true, also return contracts classified as fair (action NONE). Default false. */
  includeFair?: boolean;
  /** Override of `Date.now()` — test seam. */
  now?: number;
}

const DEFAULTS: Required<Omit<IvRvScannerOptions, 'now'>> = {
  riskFreeRate: 0.045,
  dividendYield: 0,
  minOpenInterest: 1000,
  minVolume: 250,
  minMark: 0.1,
  maxSpreadPct: 0.2,
  maxDaysToExpiration: 90,
  sellIvRvRatio: 1.3,
  buyIvRvRatio: 0.7,
  mispricingThresholdPct: 0.25,
  includeFair: false,
};

/**
 * Annualised realised volatility from a series of **daily** closes, using the
 * shared TRA-430 close-to-close estimator. Equities annualise off trading days
 * (≈252/yr) rather than calendar days, matching the convention every option
 * pricer treats "historical vol" with.
 *
 * Pass closed daily bars only (no look-ahead). Returns `null` when fewer than
 * two usable returns exist or the result is non-finite.
 */
export function realizedVolFromDailyCloses(
  dailyCloses: readonly number[],
  lookbackDays = 20,
  tradingDaysPerYear = 252,
): number | null {
  const rv = trailingRealisedVol(dailyCloses, lookbackDays, tradingDaysPerYear);
  return Number.isFinite(rv) && rv > 0 ? rv : null;
}

/** Resolve the contract's market IV: smvVol → midIv → Newton-Raphson BS-implied. */
function resolveImpliedVol(
  row: OptionChainRow,
  underlyingPrice: number,
  mark: number,
  dte: number,
  opts: Required<Omit<IvRvScannerOptions, 'now'>>,
): number | null {
  if (typeof row.smvVol === 'number' && row.smvVol > 0) return row.smvVol;
  if (typeof row.midIv === 'number' && row.midIv > 0) return row.midIv;
  const solved = bsImpliedVolatility({
    spot: underlyingPrice,
    strike: row.strike,
    timeToExpiryYears: dte / 365,
    riskFreeRate: opts.riskFreeRate,
    optionType: row.optionType,
    dividendYield: opts.dividendYield,
    marketPrice: mark,
  });
  return solved != null && solved > 0 ? solved : null;
}

/**
 * Scan an option chain for contracts whose **implied vol is mispriced relative
 * to realised vol**. `realizedVol` is the underlying's annualised historical
 * volatility (see {@link realizedVolFromDailyCloses}). Results are sorted by
 * `score` (descending) — strongest vol-risk-premium edge first.
 */
export function findIvRvMispricings(
  chain: OptionChainRow[],
  underlyingPrice: number,
  realizedVol: number,
  options: IvRvScannerOptions = {},
): IvRvMispricingCandidate[] {
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) return [];
  if (!Number.isFinite(realizedVol) || realizedVol <= 0) return [];

  const opts = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();
  const candidates: IvRvMispricingCandidate[] = [];

  for (const row of chain) {
    const bid = row.bid ?? 0;
    const ask = row.ask ?? 0;
    if (bid <= 0 || ask <= 0 || ask < bid) continue;

    const mark = (bid + ask) / 2;
    if (mark < opts.minMark) continue;

    const spreadPct = (ask - bid) / mark;
    if (spreadPct > opts.maxSpreadPct) continue;

    const openInterest = row.openInterest ?? 0;
    if (openInterest < opts.minOpenInterest) continue;

    const volume = row.volume ?? 0;
    if (volume < opts.minVolume) continue;

    const dte = daysToExpiration(row.expiration, now);
    if (dte <= 0 || dte > opts.maxDaysToExpiration) continue;

    const impliedVol = resolveImpliedVol(row, underlyingPrice, mark, dte, opts);
    if (impliedVol == null) continue;

    const bsArgs = {
      spot: underlyingPrice,
      strike: row.strike,
      timeToExpiryYears: dte / 365,
      riskFreeRate: opts.riskFreeRate,
      optionType: row.optionType,
      dividendYield: opts.dividendYield,
    };

    // Fair value uses realised vol as σ — the baseline a vol trader marks against.
    const fairValue = blackScholesPrice({ ...bsArgs, volatility: realizedVol });
    if (fairValue <= 0) continue;

    const mispricingPct = (mark - fairValue) / fairValue;
    const ivRvRatio = impliedVol / realizedVol;
    const delta = blackScholesDelta({ ...bsArgs, volatility: impliedVol });

    let action: IvRvAction = 'NONE';
    let reason: string;
    if (ivRvRatio >= opts.sellIvRvRatio && mispricingPct >= opts.mispricingThresholdPct) {
      action = 'SELL_PREMIUM';
      reason =
        `IV ${(impliedVol * 100).toFixed(0)}% is ${ivRvRatio.toFixed(2)}× realised ` +
        `${(realizedVol * 100).toFixed(0)}%; mark ${(mispricingPct * 100).toFixed(0)}% over RV-fair — premium rich`;
    } else if (ivRvRatio <= opts.buyIvRvRatio && mispricingPct <= -opts.mispricingThresholdPct) {
      action = 'BUY_PREMIUM';
      reason =
        `IV ${(impliedVol * 100).toFixed(0)}% is ${ivRvRatio.toFixed(2)}× realised ` +
        `${(realizedVol * 100).toFixed(0)}%; mark ${(mispricingPct * 100).toFixed(0)}% under RV-fair — premium cheap`;
    } else {
      reason = `IV/RV ${ivRvRatio.toFixed(2)}, mark ${(mispricingPct * 100).toFixed(0)}% vs RV-fair — within thresholds`;
    }

    if (action === 'NONE' && !opts.includeFair) continue;

    // Rank by deviation magnitude, weighted toward deeper, more-liquid books so
    // a thin penny-strike outlier never outranks a real, tradable edge.
    const score = Math.abs(mispricingPct) * Math.log10(10 + openInterest + volume);

    candidates.push({
      optionSymbol: row.optionSymbol,
      underlying: row.underlying,
      optionType: row.optionType,
      strike: row.strike,
      expiration: row.expiration,
      daysToExpiration: dte,
      mark,
      fairValue,
      mispricingPct,
      impliedVol,
      realizedVol,
      ivRvRatio,
      action,
      score,
      reason,
      bid,
      ask,
      spreadPct,
      openInterest,
      volume,
      delta,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}
