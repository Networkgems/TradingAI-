import type { OptionType } from '@trading-app/shared';
import { RV_MIN_MARK_FLOOR } from '@trading-app/shared';
import {
  blackScholesPrice,
  blackScholesDelta,
  bsImpliedVolatility,
  daysToExpiration,
} from './black-scholes.js';
import type { OptionChainRow } from './otm-mispricing.js';

/**
 * Outcome class assigned to each contract by the relative-value scanner (TRA-191).
 *
 *   • `cheap` / `expensive` — IV residual versus the fitted skew curve crosses
 *     the configured z-score threshold.
 *   • `monotonic_violation` — adjacent-strike vertical spread violates the
 *     normal monotonic price relationship (calls cheaper as strike rises;
 *     puts more expensive). Implies a flagged side of a vertical spread.
 *   • `below_intrinsic` — hard no-arbitrage error: mark < discounted intrinsic.
 *   • `fair` — passes filters but no anomaly detected.
 */
export type RelativeValueClassification =
  | 'cheap'
  | 'expensive'
  | 'monotonic_violation'
  | 'below_intrinsic'
  | 'fair';

export interface RelativeValueCandidate {
  optionSymbol: string;
  underlying: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  daysToExpiration: number;

  /** (bid + ask) / 2. */
  mark: number;
  bid: number;
  ask: number;
  spreadPct: number;
  volume: number;
  openInterest: number;

  /** σ used for this row (Tradier midIv > smvVol > BS-implied from mark). */
  ivUsed: number;
  /** σ predicted by the fitted quadratic skew curve at this row's strike. */
  ivFitted: number;
  /** ivUsed − ivFitted in raw vol points. */
  ivResidual: number;
  /** ivResidual / σ_resid across the same expiration / type. */
  zScore: number;

  /** Black-Scholes price built from the fitted IV. */
  fairPrice: number;
  /** (mark − fairPrice) / fairPrice. Positive → expensive vs curve. */
  mispricingPct: number;
  /** Sign-adjusted Black-Scholes delta of the contract at ivFitted. */
  delta: number;

  classification: RelativeValueClassification;
  /**
   * Composite ranking score — combines |z|, theoretical edge, liquidity
   * (OI + volume), and a tight-spread bonus. Higher is better.
   */
  score: number;
  /**
   * Free-text reason for callers / UI to explain *why* the row was flagged.
   * Empty string for `fair`.
   */
  reason: string;
}

export interface RelativeValueScannerOptions {
  /** Annualized risk-free rate (default 0.045). */
  riskFreeRate?: number;
  /** Continuous dividend yield (default 0). */
  dividendYield?: number;
  /** Reject rows with (ask − bid)/mid > this (default 0.10 = 10%). */
  maxSpreadPct?: number;
  /** Reject rows with open interest below this (default 250). */
  minOpenInterest?: number;
  /**
   * Reject rows whose mark falls below this dollar floor (default 0.40 —
   * `RV_MIN_MARK_FLOOR`, the TRA-461 sub-tick / penny-option guard).
   */
  minMark?: number;
  /** Minimum rows per (expiration, type) group required to fit a skew (default 5). */
  minGroupSize?: number;
  /** |z| above this → flagged cheap/expensive (default 2.0 — ~2σ). */
  zScoreThreshold?: number;
  /**
   * Adjacent-strike vertical-spread violation tolerance. The detector flags
   * pairs where price moves the wrong direction by more than this fraction
   * of the lower-strike mark (default 0.02 = 2%).
   */
  monotonicEpsilonPct?: number;
  /**
   * TRA-495 — minimum calendar days to expiration on each row. Defense in
   * depth against the RV swing thesis: the scanner already auto-picks an
   * expiration ≥ `dteMin` (default 21d), but a chain that's loaded for an
   * older expiration (cache + clock drift) shouldn't slip a 1-DTE lottery
   * ticket through. Default 7 — aligns with the swing rules in TRA-495.
   */
  minDaysToExpiry?: number;
  /** Override of `Date.now()` — test seam. */
  now?: number;
}

const DEFAULTS: Required<Omit<RelativeValueScannerOptions, 'now'>> = {
  riskFreeRate: 0.045,
  dividendYield: 0,
  maxSpreadPct: 0.10,
  minOpenInterest: 250,
  minMark: RV_MIN_MARK_FLOOR,
  minGroupSize: 5,
  zScoreThreshold: 2.0,
  monotonicEpsilonPct: 0.02,
  minDaysToExpiry: 7,
};

interface PreparedRow {
  row: OptionChainRow;
  mark: number;
  spreadPct: number;
  iv: number;
  /** log(K / S) — log-moneyness. */
  x: number;
  /** Calendar days to expiration. */
  dte: number;
  /** Years to expiration (dte / 365). */
  T: number;
}

/**
 * Solve a 3-variable linear system Ax = b via direct cofactor expansion.
 * Returns null when the system is singular (determinant ≈ 0). Used to fit
 * the quadratic IV skew without pulling in an external matrix dependency.
 */
function solve3x3(A: number[][], b: number[]): [number, number, number] | null {
  const [
    [a11, a12, a13],
    [a21, a22, a23],
    [a31, a32, a33],
  ] = A;
  const det =
    a11 * (a22 * a33 - a23 * a32) -
    a12 * (a21 * a33 - a23 * a31) +
    a13 * (a21 * a32 - a22 * a31);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;

  const detX =
    b[0] * (a22 * a33 - a23 * a32) -
    a12 * (b[1] * a33 - a23 * b[2]) +
    a13 * (b[1] * a32 - a22 * b[2]);
  const detY =
    a11 * (b[1] * a33 - a23 * b[2]) -
    b[0] * (a21 * a33 - a23 * a31) +
    a13 * (a21 * b[2] - b[1] * a31);
  const detZ =
    a11 * (a22 * b[2] - b[1] * a32) -
    a12 * (a21 * b[2] - b[1] * a31) +
    b[0] * (a21 * a32 - a22 * a31);

  return [detX / det, detY / det, detZ / det];
}

/**
 * Fit IV(x) = a + b·x + c·x² across a same-type / same-expiration group via
 * ordinary least squares. Falls back to a flat mean when the system is
 * singular (e.g. all strikes equal — shouldn't happen but cheap to guard).
 */
function fitQuadraticSkew(
  xs: number[],
  ys: number[],
): { a: number; b: number; c: number } {
  const n = xs.length;
  let Sx = 0;
  let Sxx = 0;
  let Sxxx = 0;
  let Sxxxx = 0;
  let Sy = 0;
  let Sxy = 0;
  let Sxxy = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xs[i];
    const y = ys[i];
    const x2 = x * x;
    Sx += x;
    Sxx += x2;
    Sxxx += x2 * x;
    Sxxxx += x2 * x2;
    Sy += y;
    Sxy += x * y;
    Sxxy += x2 * y;
  }
  const A = [
    [n, Sx, Sxx],
    [Sx, Sxx, Sxxx],
    [Sxx, Sxxx, Sxxxx],
  ];
  const b = [Sy, Sxy, Sxxy];
  const sol = solve3x3(A, b);
  if (sol) {
    const [a, b1, c] = sol;
    if (Number.isFinite(a) && Number.isFinite(b1) && Number.isFinite(c)) {
      return { a, b: b1, c };
    }
  }
  return { a: Sy / n, b: 0, c: 0 };
}

/**
 * Resolve usable IV for a row, in priority order:
 *   1. midIv from Tradier greeks
 *   2. smvVol (smoothed market vol) from Tradier greeks
 *   3. Newton-Raphson implied vol from the contract's own mark price
 *
 * Returns null when none of the above produce a finite positive σ.
 */
function resolveIv(
  row: OptionChainRow,
  mark: number,
  spot: number,
  T: number,
  r: number,
  q: number,
): number | null {
  if (typeof row.midIv === 'number' && row.midIv > 0 && Number.isFinite(row.midIv)) {
    return row.midIv;
  }
  if (typeof row.smvVol === 'number' && row.smvVol > 0 && Number.isFinite(row.smvVol)) {
    return row.smvVol;
  }
  return bsImpliedVolatility({
    spot,
    strike: row.strike,
    timeToExpiryYears: T,
    riskFreeRate: r,
    optionType: row.optionType,
    dividendYield: q,
    marketPrice: mark,
  });
}

/**
 * Detect adjacent-strike vertical-spread violations within a sorted group.
 *
 * Calls: mid should generally fall as strike rises; flag when mid[i+1] > mid[i] + ε.
 * Puts: mid should generally rise as strike rises; flag when mid[i+1] < mid[i] − ε.
 *
 * Both rows of the offending pair are flagged so the caller can decide which
 * leg is the relative outlier (typically the leg whose IV residual sign agrees
 * with the violation direction).
 */
function findMonotonicViolations(prepared: PreparedRow[]): Set<string> {
  const flagged = new Set<string>();
  if (prepared.length < 2) return flagged;
  for (let i = 0; i < prepared.length - 1; i += 1) {
    const a = prepared[i];
    const b = prepared[i + 1];
    if (a.row.optionType !== b.row.optionType) continue;
    if (a.row.expiration !== b.row.expiration) continue;
    const epsA = a.mark * 0.02; // local 2% slack — quote noise
    const epsB = b.mark * 0.02;
    const slack = Math.max(epsA, epsB, 0.01);

    const isCall = a.row.optionType === 'call';
    const violates = isCall ? b.mark > a.mark + slack : b.mark < a.mark - slack;
    if (violates) {
      flagged.add(a.row.optionSymbol);
      flagged.add(b.row.optionSymbol);
    }
    // No-arb vertical-spread bound: |C(K1) − C(K2)| ≤ |K2 − K1|. Crossing this
    // is a hard pricing error regardless of direction.
    if (Math.abs(b.mark - a.mark) > Math.abs(b.row.strike - a.row.strike)) {
      flagged.add(a.row.optionSymbol);
      flagged.add(b.row.optionSymbol);
    }
  }
  return flagged;
}

/**
 * Detect contracts trading below their no-arbitrage intrinsic floor.
 * Discounted intrinsic = max(0, S·e^{-qT} − K·e^{-rT}) for calls
 *                      = max(0, K·e^{-rT} − S·e^{-qT}) for puts.
 */
function findBelowIntrinsic(
  prepared: PreparedRow[],
  spot: number,
  r: number,
  q: number,
): Set<string> {
  const flagged = new Set<string>();
  for (const p of prepared) {
    const discS = spot * Math.exp(-q * p.T);
    const discK = p.row.strike * Math.exp(-r * p.T);
    const intrinsic = p.row.optionType === 'call'
      ? Math.max(0, discS - discK)
      : Math.max(0, discK - discS);
    if (p.mark < intrinsic - 1e-4) {
      flagged.add(p.row.optionSymbol);
    }
  }
  return flagged;
}

/**
 * Score the candidate so the caller can sort by descending edge*quality.
 *   • edge       = max(|z|, |mispricingPct| / 0.05)  — z-score is preferred,
 *     but for monotonic / below-intrinsic violations we lean on the
 *     mark-vs-fair gap.
 *   • liquidity  = log10(1 + OI) + 0.5·log10(1 + volume)
 *   • spread     = max(0.5, 1 − 2·spreadPct) — tighter is better, capped.
 */
function scoreCandidate(
  zScore: number,
  mispricingPct: number,
  openInterest: number,
  volume: number,
  spreadPct: number,
): number {
  const edge = Math.max(Math.abs(zScore), Math.abs(mispricingPct) / 0.05);
  const liquidity = Math.log10(1 + openInterest) + 0.5 * Math.log10(1 + volume);
  const spreadFactor = Math.max(0.5, 1 - 2 * spreadPct);
  return edge * Math.max(0.1, liquidity) * spreadFactor;
}

/**
 * Scan an option chain for **relative-value mispricings** across strikes.
 *
 * Workflow (TRA-191):
 *   1. Group rows by expiration + option type.
 *   2. Filter each row by quality (tight spread, dollar floor, open interest,
 *      live bid/ask) and resolve a usable σ (Tradier IV → BS-implied fallback).
 *   3. Fit a quadratic IV(log-moneyness) curve via OLS on the survivors.
 *   4. Compute residuals; z-score them against the group's residual RMSE.
 *   5. Walk adjacent strikes for vertical-spread monotonic violations.
 *   6. Check each row against the no-arb discounted-intrinsic floor.
 *   7. Build candidates: classify as cheap/expensive/monotonic/intrinsic/fair,
 *      compute fair price from the fitted IV, attach delta, rank by score.
 *
 * Pure — no I/O, no broker calls. Caller wires this to its data source.
 */
export function findRelativeValueOpportunities(
  chain: OptionChainRow[],
  underlyingPrice: number,
  options: RelativeValueScannerOptions = {},
): RelativeValueCandidate[] {
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) return [];
  if (chain.length === 0) return [];

  const opts = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();

  // Group by expiration + type so each fitted skew is for a single slice.
  const groups = new Map<string, OptionChainRow[]>();
  for (const row of chain) {
    const key = `${row.expiration}|${row.optionType}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(row);
  }

  const allCandidates: RelativeValueCandidate[] = [];

  for (const [, rows] of groups) {
    rows.sort((a, b) => a.strike - b.strike);

    const prepared: PreparedRow[] = [];
    for (const row of rows) {
      const bid = row.bid ?? 0;
      const ask = row.ask ?? 0;
      if (bid <= 0 || ask <= 0 || ask < bid) continue;
      const mark = (bid + ask) / 2;
      if (mark < opts.minMark) continue;
      const spreadPct = (ask - bid) / mark;
      if (spreadPct > opts.maxSpreadPct) continue;
      const oi = row.openInterest ?? 0;
      if (oi < opts.minOpenInterest) continue;

      const dte = daysToExpiration(row.expiration, now);
      if (dte <= 0) continue;
      // TRA-495 — defense in depth on the swing thesis: reject rows whose
      // expiration is closer than the configured floor (default 7d). The
      // scanner's auto-pick already filters expirations by `dteMin`/`dteMax`,
      // but a cached chain for a stale expiration shouldn't slip a near-DTE
      // lottery ticket through.
      if (dte < opts.minDaysToExpiry) continue;
      const T = dte / 365;

      const iv = resolveIv(row, mark, underlyingPrice, T, opts.riskFreeRate, opts.dividendYield);
      if (iv == null || iv <= 0 || !Number.isFinite(iv)) continue;

      const x = Math.log(row.strike / underlyingPrice);
      prepared.push({ row, mark, spreadPct, iv, x, dte, T });
    }

    if (prepared.length < opts.minGroupSize) continue;

    // Fit IV(x) = a + b·x + c·x²
    const xs = prepared.map((p) => p.x);
    const ys = prepared.map((p) => p.iv);
    const fit = fitQuadraticSkew(xs, ys);

    // Residuals + sigma (RMSE).
    const residuals = prepared.map((p) => p.iv - (fit.a + fit.b * p.x + fit.c * p.x * p.x));
    const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
    // Floor so a near-perfect fit doesn't blow up |z| on tiny noise.
    const sigmaResid = Math.max(rmse, 0.005);

    const monotonicFlags = findMonotonicViolations(prepared);
    const intrinsicFlags = findBelowIntrinsic(prepared, underlyingPrice, opts.riskFreeRate, opts.dividendYield);

    for (let i = 0; i < prepared.length; i += 1) {
      const p = prepared[i];
      const ivFitted = fit.a + fit.b * p.x + fit.c * p.x * p.x;
      const safeFitIv = ivFitted > 0 ? ivFitted : Math.max(0.01, p.iv);
      const ivResidual = p.iv - ivFitted;
      const zScore = ivResidual / sigmaResid;

      const fairPrice = blackScholesPrice({
        spot: underlyingPrice,
        strike: p.row.strike,
        timeToExpiryYears: p.T,
        riskFreeRate: opts.riskFreeRate,
        volatility: safeFitIv,
        optionType: p.row.optionType,
        dividendYield: opts.dividendYield,
      });
      const mispricingPct = fairPrice > 0 ? (p.mark - fairPrice) / fairPrice : 0;

      const delta = blackScholesDelta({
        spot: underlyingPrice,
        strike: p.row.strike,
        timeToExpiryYears: p.T,
        riskFreeRate: opts.riskFreeRate,
        volatility: safeFitIv,
        optionType: p.row.optionType,
        dividendYield: opts.dividendYield,
      });

      // Classification — order matters: hard arb violations dominate.
      let classification: RelativeValueClassification = 'fair';
      let reason = '';
      if (intrinsicFlags.has(p.row.optionSymbol)) {
        classification = 'below_intrinsic';
        reason = 'mark below discounted intrinsic';
      } else if (monotonicFlags.has(p.row.optionSymbol)) {
        classification = 'monotonic_violation';
        reason = p.row.optionType === 'call'
          ? 'higher-strike call ≥ lower-strike call'
          : 'higher-strike put ≤ lower-strike put';
      } else if (zScore >= opts.zScoreThreshold) {
        classification = 'expensive';
        reason = `IV residual ${zScore.toFixed(2)}σ above fitted skew`;
      } else if (zScore <= -opts.zScoreThreshold) {
        classification = 'cheap';
        reason = `IV residual ${(-zScore).toFixed(2)}σ below fitted skew`;
      }

      const score = scoreCandidate(zScore, mispricingPct, p.row.openInterest ?? 0, p.row.volume ?? 0, p.spreadPct);

      allCandidates.push({
        optionSymbol: p.row.optionSymbol,
        underlying: p.row.underlying,
        optionType: p.row.optionType,
        strike: p.row.strike,
        expiration: p.row.expiration,
        daysToExpiration: p.dte,
        mark: p.mark,
        bid: p.row.bid ?? 0,
        ask: p.row.ask ?? 0,
        spreadPct: p.spreadPct,
        volume: p.row.volume ?? 0,
        openInterest: p.row.openInterest ?? 0,
        ivUsed: p.iv,
        ivFitted: safeFitIv,
        ivResidual,
        zScore,
        fairPrice,
        mispricingPct,
        delta,
        classification,
        score,
        reason,
      });
    }
  }

  allCandidates.sort((a, b) => b.score - a.score);
  return allCandidates;
}

/** Option side the RV single-leg long is permitted to open (TRA-968). */
export type RvLongTrendSide = 'call' | 'put';

/** TRA-968 — directional delta band (slightly-ITM/ATM) per the swing spec. */
export const RV_LONG_DELTA_TARGET_MIN = 0.55;
export const RV_LONG_DELTA_TARGET_MAX = 0.65;

/**
 * TRA-972 — hard far-OTM |delta| floor for the midpoint fallback. When no
 * candidate sits inside the [0.55, 0.65] band, the selector falls back to the
 * survivor whose |delta| is closest to the band midpoint — but a deep-OTM cheap
 * strike (e.g. |delta| 0.20 screening `cheap` on IV z ≤ −2σ) is a vol-mispricing
 * bet, not a directional swing entry, and opening it tagged `sleeve:'directional'`
 * muddies exactly the grading TRA-957 cleaned up. The floor is set ~0.10 below
 * the band's lower edge: it still admits a near-ATM strike that sits just under
 * the band (a fine slightly-OTM swing entry) but rejects genuine far-OTM strikes,
 * so the directional sleeve stands down (returns `null`) rather than open one.
 * No symmetric deep-ITM ceiling — high-|delta| longs are stock-like and fine.
 */
export const RV_LONG_DELTA_FLOOR = 0.45;

/**
 * TRA-970 — DTE entry window for *new* directional single-leg long entries,
 * per the QuantTrader decision on TRA-957. The swing spec says "buy 30-45 DTE",
 * so new entries are post-filtered to **[30, 45]**. This is deliberately
 * tighter than the scanner's 21-DTE floor: that 21d floor is a *short-premium
 * management* never-below inherited from the selector and must NOT widen the
 * long-entry window — opening a directional long at 21–30 DTE eats theta and
 * cuts swing runway, exactly what a trend-following long should avoid.
 */
export const RV_LONG_DTE_ENTRY_MIN = 30;
export const RV_LONG_DTE_ENTRY_MAX = 45;

export interface RvLongSelectionOptions {
  /**
   * Daily-trend direction from the confluence stack (Supertrend / MA-stack /
   * MACD / RSI), mapped to the option side it permits: `'call'` in an uptrend,
   * `'put'` in a downtrend. `null` (range / trend unknown) makes the selector
   * return `null` so the caller opens nothing — a trend-blind long is exactly
   * the entry the swing spec forbids.
   */
  trendSide: RvLongTrendSide | null;
  /** Lower bound of the directional delta target band (default 0.55). */
  deltaTargetMin?: number;
  /** Upper bound of the directional delta target band (default 0.65). */
  deltaTargetMax?: number;
  /**
   * Lower bound of the DTE entry window for new directional entries
   * (default 30 — `RV_LONG_DTE_ENTRY_MIN`, TRA-970).
   */
  dteEntryMin?: number;
  /**
   * Upper bound of the DTE entry window for new directional entries
   * (default 45 — `RV_LONG_DTE_ENTRY_MAX`, TRA-970).
   */
  dteEntryMax?: number;
  /**
   * Far-OTM |delta| floor applied to the midpoint fallback only
   * (default 0.45 — `RV_LONG_DELTA_FLOOR`, TRA-972). When no candidate is
   * in-band, the closest-to-midpoint survivor is rejected (selector returns
   * `null`) if its |delta| is strictly below this floor, so a deep-OTM cheap
   * strike never opens as a directional long.
   */
  deltaFloor?: number;
}

/**
 * TRA-968 — choose the single-leg long to open from the RV scanner's candidates,
 * gated on the daily-trend side and a directional delta target (swing spec).
 *
 * The bare scanner ({@link findRelativeValueOpportunities}) ranks every
 * cheap / below-intrinsic outlier purely by IV edge + liquidity, so its top
 * pick can be a long *put* while the daily trend is *up*, or a deep-OTM lottery
 * strike — both contradict the swing spec's "align option direction to the
 * daily-trend signal" rule and would muddy Phase-B grading. This selector:
 *
 *   1. Drops candidates whose side opposes the daily trend — calls only in an
 *      uptrend, puts only in a downtrend. With no trend (`trendSide == null`)
 *      it returns `null` so the caller stands down rather than open blind.
 *   1b. Drops candidates outside the DTE entry window ([30, 45] by default,
 *      TRA-970) — new directional longs buy 30–45 DTE per the swing spec; the
 *      scanner's 21-DTE floor is a short-premium management never-below, not an
 *      entry window, so it must not slip a 21–30-DTE theta-bleeding long through.
 *   2. Among the survivors it prefers a strike whose |delta| sits inside the
 *      directional target band (~0.55–0.65, slightly-ITM/ATM). Inside the band
 *      it keeps the scanner's own ranking (candidates arrive sorted by score,
 *      best first); with none in-band it falls back to the strike whose |delta|
 *      is *closest* to the band midpoint rather than taking the cheapest-IV
 *      strike regardless of moneyness — but only down to a hard far-OTM floor
 *      ({@link RV_LONG_DELTA_FLOOR}, TRA-972): if even the closest survivor is
 *      below the floor it stands down (returns `null`) rather than open a
 *      deep-OTM cheap strike as a "directional" long.
 *
 * Long-only: only `cheap` and `below_intrinsic` rows are eligible (taking the
 * short leg of an `expensive` / `monotonic_violation` needs a defined-risk
 * spread, out of scope for this single-leg path). Returns `null` when nothing
 * qualifies. Pure — the caller supplies the trend side from its own confluence
 * read so this stays free of candle/indicator I/O.
 */
export function selectRvLongCandidate(
  candidates: RelativeValueCandidate[],
  options: RvLongSelectionOptions,
): RelativeValueCandidate | null {
  const { trendSide } = options;
  if (trendSide == null) return null;

  const lo = options.deltaTargetMin ?? RV_LONG_DELTA_TARGET_MIN;
  const hi = options.deltaTargetMax ?? RV_LONG_DELTA_TARGET_MAX;
  const mid = (lo + hi) / 2;

  const dteLo = options.dteEntryMin ?? RV_LONG_DTE_ENTRY_MIN;
  const dteHi = options.dteEntryMax ?? RV_LONG_DTE_ENTRY_MAX;

  const deltaFloor = options.deltaFloor ?? RV_LONG_DELTA_FLOOR;

  const eligible = candidates.filter(
    (c) =>
      (c.classification === 'cheap' || c.classification === 'below_intrinsic') &&
      c.optionType === trendSide &&
      c.daysToExpiration >= dteLo &&
      c.daysToExpiration <= dteHi,
  );
  if (eligible.length === 0) return null;

  // Candidates arrive ranked by composite score (desc). Prefer the
  // highest-scoring strike already inside the delta target band …
  const inBand = eligible.find((c) => {
    const ad = Math.abs(c.delta);
    return ad >= lo && ad <= hi;
  });
  if (inBand) return inBand;

  // … otherwise the strike whose |delta| is closest to the band midpoint …
  const fallback = eligible.reduce((best, c) =>
    Math.abs(Math.abs(c.delta) - mid) < Math.abs(Math.abs(best.delta) - mid)
      ? c
      : best,
  );

  // … but stand down rather than open a genuine far-OTM cheap strike: a survivor
  // whose |delta| is below the floor is a vol-mispricing bet, not a directional
  // swing entry, and must not land tagged `sleeve:'directional'` (TRA-972).
  if (Math.abs(fallback.delta) < deltaFloor) return null;
  return fallback;
}
