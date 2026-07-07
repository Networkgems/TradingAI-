import type { OptionType, Side } from '@trading-app/shared';
import { blackScholesDelta } from './black-scholes.js';
import type { RiskManager } from '../risk.js';

/**
 * TRA-728 (Phase 1) — options-selection + IV-gate + exit/sizing hooks for the
 * SupertrendConfluence signal.
 *
 * STRUCTURE-ONLY scaffold: every threshold below is a starting point exposed as
 * a parameter so the Phase-2 sweep can tune it. Nothing here routes to live; the
 * functions are pure (apart from {@link sizeOptionContracts}, which reads live
 * equity off the supplied {@link RiskManager}) so they are golden-fixture
 * testable. Greeks/IV reads reuse {@link blackScholesDelta}; IV-rank is passed in
 * by the caller (the IV store lives in the server package — the engine stays
 * dependency-free and never fabricates a rank).
 */

// ---------------------------------------------------------------------------
// 1. IV gate → structure selection
// ---------------------------------------------------------------------------

export type OptionsStructure = 'single_leg' | 'debit_vertical';

export interface IvGateParams {
  /** Below this IV-rank, prefer a single-leg call/put (default 40). */
  singleLegMaxIvRank: number;
  /** At/above this IV-rank, switch to a debit vertical to cut vega (default 60). */
  verticalMinIvRank: number;
}

export const DEFAULT_IV_GATE: IvGateParams = {
  singleLegMaxIvRank: 40,
  verticalMinIvRank: 60,
};

export interface StructureDecision {
  structure: OptionsStructure;
  reason: string;
}

/**
 * Pick the option structure from the underlying's IV-rank (0–100). Low IV → buy
 * premium outright (single leg); high IV → a debit vertical so we are not long
 * pure vega into a rich tape. In the in-between band (and when IV-rank is
 * unknown) we default to the single leg — the cheaper, simpler expression — and
 * let Phase 2 decide whether the dead-zone deserves its own rule.
 */
export function selectStructureByIv(
  ivRank: number | null,
  params: IvGateParams = DEFAULT_IV_GATE,
): StructureDecision {
  if (ivRank === null || !Number.isFinite(ivRank)) {
    return { structure: 'single_leg', reason: 'iv_rank_unknown' };
  }
  if (ivRank >= params.verticalMinIvRank) {
    return { structure: 'debit_vertical', reason: `iv_rank ${ivRank.toFixed(0)} >= ${params.verticalMinIvRank}` };
  }
  if (ivRank < params.singleLegMaxIvRank) {
    return { structure: 'single_leg', reason: `iv_rank ${ivRank.toFixed(0)} < ${params.singleLegMaxIvRank}` };
  }
  return { structure: 'single_leg', reason: `iv_rank ${ivRank.toFixed(0)} in dead-zone, defaulting single_leg` };
}

// ---------------------------------------------------------------------------
// 2. Expiry selection — 2-4 weeks out, no weeklies
// ---------------------------------------------------------------------------

export interface ExpiryParams {
  /** Minimum days-to-expiry (default 14 — two weeks). */
  minDays: number;
  /** Maximum days-to-expiry (default 28 — four weeks). */
  maxDays: number;
  /** Preferred target days-to-expiry; nearest wins (default 21 — three weeks). */
  targetDays: number;
  /** Reject weekly expirations (keep only standard monthlies). Default true. */
  excludeWeeklies: boolean;
}

export const DEFAULT_EXPIRY_PARAMS: ExpiryParams = {
  minDays: 14,
  maxDays: 28,
  targetDays: 21,
  excludeWeeklies: true,
};

export interface ExpiryCandidate {
  /** ISO `YYYY-MM-DD` expiration date. */
  expiration: string;
  /** Calendar days to expiry from the evaluation instant. */
  daysToExpiry: number;
  /**
   * Whether this is a standard monthly expiration (3rd Friday). When the chain
   * source does not flag it, callers can derive it via {@link isThirdFriday}.
   */
  isMonthly: boolean;
}

/** Is `YYYY-MM-DD` the third Friday of its month (the standard monthly expiry)? */
export function isThirdFriday(isoDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const dow = new Date(Date.UTC(year, month, day)).getUTCDay();
  if (dow !== 5) return false; // not a Friday
  return day >= 15 && day <= 21; // the Friday in this range is the 3rd Friday
}

/**
 * Choose the expiry closest to `targetDays` within `[minDays, maxDays]`,
 * optionally restricted to standard monthlies (no weeklies on this slow
 * confluence signal). Returns `null` when no candidate qualifies.
 */
export function selectExpiry(
  candidates: readonly ExpiryCandidate[],
  params: ExpiryParams = DEFAULT_EXPIRY_PARAMS,
): ExpiryCandidate | null {
  const eligible = candidates.filter(
    c =>
      c.daysToExpiry >= params.minDays &&
      c.daysToExpiry <= params.maxDays &&
      (!params.excludeWeeklies || c.isMonthly),
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((best, c) =>
    Math.abs(c.daysToExpiry - params.targetDays) < Math.abs(best.daysToExpiry - params.targetDays)
      ? c
      : best,
  );
}

// ---------------------------------------------------------------------------
// 3. Delta-target strike selection (~0.60–0.70, slightly ITM)
// ---------------------------------------------------------------------------

export interface DeltaTargetParams {
  /** Preferred absolute delta (default 0.65 — slightly ITM). */
  target: number;
  /** Inclusive absolute-delta band (default [0.60, 0.70]). */
  band: [number, number];
}

export const DEFAULT_DELTA_PARAMS: DeltaTargetParams = {
  target: 0.65,
  band: [0.6, 0.7],
};

export interface StrikeCandidate {
  strike: number;
  /** Signed delta (calls positive, puts negative); use |delta| for selection. */
  delta: number;
}

/**
 * Pick the strike whose absolute delta is nearest `target`, preferring one
 * inside `band`. If no candidate falls inside the band, the nearest-to-target
 * outside it is returned (Phase 2 decides whether to harden this into a reject).
 * Returns `null` only when there are no candidates.
 */
export function selectStrikeByDelta(
  candidates: readonly StrikeCandidate[],
  params: DeltaTargetParams = DEFAULT_DELTA_PARAMS,
): StrikeCandidate | null {
  if (candidates.length === 0) return null;
  const [lo, hi] = params.band;
  const inBand = candidates.filter(c => Math.abs(c.delta) >= lo && Math.abs(c.delta) <= hi);
  const pool = inBand.length > 0 ? inBand : candidates;
  return pool.reduce((best, c) =>
    Math.abs(Math.abs(c.delta) - params.target) < Math.abs(Math.abs(best.delta) - params.target)
      ? c
      : best,
  );
}

/**
 * Build {@link StrikeCandidate}s by pricing Black-Scholes delta for a set of
 * strikes — used when the chain source omits Greeks. Reuses {@link blackScholesDelta}.
 */
export function deltasForStrikes(
  strikes: readonly number[],
  ctx: { spot: number; timeToExpiryYears: number; riskFreeRate: number; volatility: number; optionType: OptionType },
): StrikeCandidate[] {
  return strikes.map(strike => ({
    strike,
    delta: blackScholesDelta({
      spot: ctx.spot,
      strike,
      timeToExpiryYears: ctx.timeToExpiryYears,
      riskFreeRate: ctx.riskFreeRate,
      volatility: ctx.volatility,
      optionType: ctx.optionType,
    }),
  }));
}

/** The option type a side wants: long → call, short → put. */
export function optionTypeForSide(side: Side): OptionType {
  return side === 'buy' ? 'call' : 'put';
}

// ---------------------------------------------------------------------------
// 4. Exit rules (parameterized)
// ---------------------------------------------------------------------------

export interface ExitParams {
  /** Exit when Supertrend flips against the position. Default true. */
  supertrendFlipExit: boolean;
  /**
   * TRA-1409 — number of CONSECUTIVE bars the Supertrend must be flipped against
   * the position before the `supertrend_flip` exit fires. Default 1 (legacy
   * single-bar flip). Set >1 (RV demo sleeve = 2) to cut single-bar whipsaw
   * scratches so winners survive to `ma20_close_through`. Only tightens when
   * {@link ExitState.recentSupertrendDirections} is supplied; absent/short
   * history holds the flip exit (conservative) rather than firing on one bar.
   */
  supertrendFlipConfirmBars?: number;
  /** Exit when the underlying closes through its MA20. Default true. */
  ma20CloseThroughExit: boolean;
  /** Premium stop as a fraction of entry premium (default -0.50 = -50%). */
  premiumStopPct: number;
  /** Premium take-profit as a fraction of entry premium (default +1.00 = +100%). */
  premiumTakeProfitPct: number;
  /** Time stop in bars with no follow-through (default 5). Set 0 to disable. */
  timeStopBars: number;
}

export const DEFAULT_EXIT_PARAMS: ExitParams = {
  supertrendFlipExit: true,
  supertrendFlipConfirmBars: 1,
  ma20CloseThroughExit: true,
  premiumStopPct: -0.5,
  premiumTakeProfitPct: 1.0,
  timeStopBars: 5,
};

export type ExitReason =
  | 'supertrend_flip'
  | 'ma20_close_through'
  | 'premium_stop'
  | 'premium_take_profit'
  | 'time_stop';

export interface ExitState {
  /** Position direction. */
  side: Side;
  /** Current Supertrend direction on the signal timeframe. */
  supertrendDirection: 'green' | 'red';
  /**
   * TRA-1409 — the last N Supertrend directions, MOST-RECENT-LAST (the final
   * element is this bar's direction, equal to {@link supertrendDirection}). Used
   * by {@link ExitParams.supertrendFlipConfirmBars} to require a multi-bar
   * confirmed flip. Optional: when absent the exit falls back to the legacy
   * single-bar behaviour.
   */
  recentSupertrendDirections?: readonly ('green' | 'red')[];
  /** Underlying close this bar. */
  underlyingClose: number;
  /** Underlying MA20 this bar. */
  ma20: number;
  /** Entry premium per share. */
  entryPremium: number;
  /** Current premium per share. */
  currentPremium: number;
  /** Bars elapsed since entry. */
  barsHeld: number;
  /**
   * Whether the trade has shown follow-through (e.g. made a new favorable
   * extreme). The time stop only fires when this is false.
   */
  hadFollowThrough: boolean;
}

/**
 * Evaluate the exit rule set against the current position state. Returns the
 * first triggered {@link ExitReason} (checked stop → target → structure → time),
 * or `null` to hold. Pure.
 */
export function evaluateExit(state: ExitState, params: ExitParams = DEFAULT_EXIT_PARAMS): ExitReason | null {
  const pnlPct =
    state.entryPremium > 0 ? (state.currentPremium - state.entryPremium) / state.entryPremium : 0;

  // Premium stop / take-profit first — hard risk limits.
  if (pnlPct <= params.premiumStopPct) return 'premium_stop';
  if (pnlPct >= params.premiumTakeProfitPct) return 'premium_take_profit';

  // Structure-based exits.
  if (params.supertrendFlipExit) {
    const flippedDir = state.side === 'buy' ? 'red' : 'green';
    const flipped = state.supertrendDirection === flippedDir;
    if (flipped) {
      // TRA-1409 — optional N-bar confirmation. With supertrendFlipConfirmBars>1
      // the flip must persist for that many consecutive bars against the position
      // before it exits (cuts single-bar whipsaw scratches on the RV sleeve).
      // N<=1 (the global default) keeps the legacy single-bar exit. When N>1 but
      // no `recentSupertrendDirections` history is available, we HOLD the flip
      // exit rather than fire on one bar — the other structural/time exits below
      // still apply, and the risk-side stops are unaffected.
      const confirmBars = params.supertrendFlipConfirmBars ?? 1;
      if (confirmBars <= 1) return 'supertrend_flip';
      const recent = state.recentSupertrendDirections;
      if (
        recent !== undefined &&
        recent.length >= confirmBars &&
        recent.slice(-confirmBars).every(d => d === flippedDir)
      ) {
        return 'supertrend_flip';
      }
    }
  }
  if (params.ma20CloseThroughExit) {
    const through = state.side === 'buy' ? state.underlyingClose < state.ma20 : state.underlyingClose > state.ma20;
    if (through) return 'ma20_close_through';
  }

  // Time stop only when the move has not followed through.
  if (params.timeStopBars > 0 && state.barsHeld >= params.timeStopBars && !state.hadFollowThrough) {
    return 'time_stop';
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5. Position sizing through the risk manager (per-name / per-sector caps)
// ---------------------------------------------------------------------------

export interface OptionSizingParams {
  /** Max fraction of managed equity at risk on one name (default 0.05 = 5%). */
  perNameCap: number;
  /** Max fraction of managed equity at risk across one sector (default 0.15 = 15%). */
  perSectorCap: number;
  /** Optional per-trade risk override fed to the RiskManager (else its default). */
  riskPct?: number;
}

export const DEFAULT_OPTION_SIZING: OptionSizingParams = {
  perNameCap: 0.05,
  perSectorCap: 0.15,
};

export interface OptionSizingInputs {
  /** Entry premium per share. */
  entryPremium: number;
  /** Premium stop fraction (negative, e.g. -0.50). Used to derive $-at-risk per contract. */
  premiumStopPct: number;
  /** Dollars already at risk on this name (existing positions). */
  nameRiskUsed: number;
  /** Dollars already at risk in this sector (existing positions). */
  sectorRiskUsed: number;
  /** Contract multiplier (default 100 — US equity options). */
  contractMultiplier?: number;
}

export interface OptionSizingResult {
  contracts: number;
  /** Dollars of premium at risk for the sized position. */
  riskDollars: number;
  /** Binding constraint that set the size. */
  bound: 'risk_budget' | 'per_name_cap' | 'per_sector_cap' | 'zero';
}

/**
 * Size an options position in whole contracts, routing the dollar risk budget
 * through the existing {@link RiskManager} (so the drawdown brake and equity
 * compounding apply) and then clamping to per-name and per-sector caps.
 *
 * Per-contract dollar risk = `entryPremium × |premiumStopPct| × multiplier`
 * (the premium we forfeit if the -50% stop hits). The budget is the smallest of
 * the risk-manager allowance and the remaining headroom under each cap.
 */
export function sizeOptionContracts(
  riskManager: RiskManager,
  inputs: OptionSizingInputs,
  params: OptionSizingParams = DEFAULT_OPTION_SIZING,
): OptionSizingResult {
  const multiplier = inputs.contractMultiplier ?? 100;
  const perContractRisk = inputs.entryPremium * Math.abs(inputs.premiumStopPct) * multiplier;
  if (!(perContractRisk > 0)) return { contracts: 0, riskDollars: 0, bound: 'zero' };

  const equity = riskManager.managedEquity();
  const riskBudget = riskManager.maxRiskPerTrade(params.riskPct);
  const nameHeadroom = Math.max(0, equity * params.perNameCap - inputs.nameRiskUsed);
  const sectorHeadroom = Math.max(0, equity * params.perSectorCap - inputs.sectorRiskUsed);

  const budgets: Array<{ dollars: number; bound: OptionSizingResult['bound'] }> = [
    { dollars: riskBudget, bound: 'risk_budget' },
    { dollars: nameHeadroom, bound: 'per_name_cap' },
    { dollars: sectorHeadroom, bound: 'per_sector_cap' },
  ];
  const binding = budgets.reduce((min, b) => (b.dollars < min.dollars ? b : min));

  const contracts = Math.floor(binding.dollars / perContractRisk);
  if (contracts <= 0) return { contracts: 0, riskDollars: 0, bound: 'zero' };
  return { contracts, riskDollars: contracts * perContractRisk, bound: binding.bound };
}
