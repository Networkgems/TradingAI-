import { dteFromExpiration } from '@trading-app/shared';
import { SHORT_PREMIUM_MIN_IV_RANK, type ShortPremiumScanResult } from './short-premium-scanner.js';

// TRA-1977 — PURE wheel selector + cycle planner. This module owns the decision
// logic that routes the observe-only short-premium scanner (TRA-1292) into the
// wheel paper primitive (`PaperOptionsAccount.openCashSecuredPut` /
// `openCoveredCall` / `settleCoveredWrite` / `liquidateAssignedShares`, landed
// TRA-1966/1976) under the SHADOW/paper flag. It places NO orders and touches no
// account — the signal-engine tick (`runWheelCycle`) is the thin executor that
// calls the account primitives off these decisions.
//
// Everything here is a pure function of its inputs so the wheel's entry/roll/
// assignment/liquidation branches are unit-testable without the whole engine,
// exactly as the TRA-1322 backtest state machine (`wheel-recovery.ts`) is. The
// selectors reuse the scanner's ALREADY-GATED candidates (ivRank >= 50 +
// VRP-positive + short-strike |Δ| 0.15–0.30 at 7–60 DTE); the CSP is the short
// PUT leg of the best put-credit-spread, the covered call the short CALL leg of
// the best call-credit-spread (the protective wing is dropped — a wheel write is
// a single cash-/share-secured short, never a spread).

/**
 * TRA-1322 (TRA-592) quality sub-universe — the validated-name set the wheel
 * backtest restricts to. Mirrors `packages/backtest/src/wheel-recovery.ts`
 * `WHEEL_QUALITY_UNIVERSE` (kept as a local copy so the server never takes a
 * dependency on the backtest package; the wheel-recovery test pins the backtest
 * constant to the same reference params). Routing is restricted to these names.
 */
export const WHEEL_QUALITY_UNIVERSE = [
  'SPY', 'QQQ', 'DIA', 'IWM', 'XLF', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'AVGO',
] as const;

const UNIVERSE = new Set<string>(WHEEL_QUALITY_UNIVERSE);

/** True iff `symbol` (case-insensitive) is in the TRA-1322 quality sub-universe. */
export function isWheelUniverseSymbol(symbol: string): boolean {
  return UNIVERSE.has(symbol.trim().toUpperCase());
}

/**
 * TRA-1322 guard bundle applied to the paper wheel. Defaults match the
 * board-approved backtest run (`run-tra1322-wheel-recovery.ts` GUARDS):
 * liquidate the assigned stock if it falls 15% below cost basis, and cap the
 * recovery window at 3 covered-call cycles before liquidating at market.
 */
export interface WheelGuards {
  /** Hard stock-side stop as a fraction below cost basis (guard #2). */
  stockStopPct: number;
  /** Max covered-call cycles before max-window liquidation (guard #3). */
  maxCcCycles: number;
}

export const DEFAULT_WHEEL_GUARDS: WheelGuards = { stockStopPct: 0.15, maxCcCycles: 3 };

/** A single-leg short write (CSP or CC) resolved from a scanner candidate leg. */
export interface WheelWriteLeg {
  symbol: string;
  optionSymbol: string;
  strike: number;
  expiration: string;
  /** Premium collected per share (the leg's mid mark), always > 0. */
  creditPerShare: number;
  /** Underlying spot at selection. */
  spot: number;
  /** Sign-adjusted short-leg delta (for evidence / roll decisions). */
  entryDelta: number;
}

/**
 * The full-pass gate for PAPER routing: unlike the observe-only ledger (which
 * accrues the honest-unknown `ivRank === null` warming case, TRA-1114), routing
 * requires the SAME finite `ivRank >= 50` elevated-IV pass the scanner asserts as
 * the hard LIVE-promotion gate — the "live method emits only on the full pass,
 * never a near-miss" half of the SHADOW pattern. A null/sub-floor rank never
 * routes.
 */
function passesRoutingGate(result: ShortPremiumScanResult): boolean {
  const r = result.ivRank;
  if (!(typeof r === 'number' && Number.isFinite(r) && r >= SHORT_PREMIUM_MIN_IV_RANK)) return false;
  if (result.spot == null || !(result.spot > 0)) return false;
  return isWheelUniverseSymbol(result.symbol);
}

/**
 * Select the cash-secured-put entry leg: the short PUT of the best (highest-
 * scoring, candidates are pre-sorted) put-credit-spread on a full-pass,
 * in-universe scan. Returns `null` when the scan doesn't clear the routing gate
 * or carries no usable put-credit structure. The protective long wing is
 * discarded — the CSP is cash-secured, single-leg.
 */
export function selectWheelCsp(result: ShortPremiumScanResult): WheelWriteLeg | null {
  if (!passesRoutingGate(result)) return null;
  const spot = result.spot as number;
  for (const c of result.candidates) {
    if (c.structure !== 'put_credit_spread') continue;
    const shortPut = c.legs.find((l) => l.action === 'sell' && l.optionType === 'put');
    if (!shortPut) continue;
    if (!(shortPut.mark > 0) || !(shortPut.strike > 0)) continue;
    return {
      symbol: c.underlying,
      optionSymbol: shortPut.optionSymbol,
      strike: shortPut.strike,
      expiration: c.expiration,
      creditPerShare: shortPut.mark,
      spot,
      entryDelta: shortPut.delta,
    };
  }
  return null;
}

/**
 * Select the covered-call write leg for an assigned lot: the short CALL of the
 * best call-credit-spread on a full-pass, in-universe scan whose strike sits at
 * or above the lot's `costBasisFloor` (TRA-1322 guard #1 — never write a call
 * that could lock a realized loss on the stock leg). Returns `null` when nothing
 * qualifies; the open primitive re-asserts the same floor as defense-in-depth.
 */
export function selectWheelCoveredCall(
  result: ShortPremiumScanResult,
  costBasisFloor: number,
): WheelWriteLeg | null {
  if (!passesRoutingGate(result)) return null;
  const spot = result.spot as number;
  for (const c of result.candidates) {
    if (c.structure !== 'call_credit_spread') continue;
    const shortCall = c.legs.find((l) => l.action === 'sell' && l.optionType === 'call');
    if (!shortCall) continue;
    if (!(shortCall.mark > 0) || !(shortCall.strike > 0)) continue;
    // GUARD #1 — floor the call strike at cost basis.
    if (shortCall.strike < costBasisFloor) continue;
    return {
      symbol: c.underlying,
      optionSymbol: shortCall.optionSymbol,
      strike: shortCall.strike,
      expiration: c.expiration,
      creditPerShare: shortCall.mark,
      spot,
      entryDelta: shortCall.delta,
    };
  }
  return null;
}

/**
 * True iff an ISO `YYYY-MM-DD` `expiration` is at or past its expiry relative to
 * `now` (0 DTE — expiring today — or later). A covered write is held to expiry;
 * this is the boundary at which the tick settles it. An unparseable expiration
 * returns `false` (never force-settle on bad data).
 */
export function isAtOrPastExpiry(expiration: string, now: number): boolean {
  const dte = dteFromExpiration(expiration, now);
  return dte !== null && dte <= 0;
}

/**
 * Settle-at-expiry outcome for a covered write, decided by the underlying spot
 * vs the short strike (the paper analog of exercise/assignment):
 *   • cash-secured put — ITM (assigned) when `spot < strike`, else expires worthless;
 *   • covered call     — ITM (called away) when `spot > strike`, else expires worthless.
 * At-the-money is treated as OTM (expires worthless) on both, matching the
 * backtest's strict inequality.
 */
export function planExpirySettlement(
  coveredWrite: 'cash_secured_put' | 'covered_call',
  strike: number,
  spot: number,
): { kind: 'expired_worthless' } | { kind: 'assigned' } {
  if (coveredWrite === 'cash_secured_put') {
    return spot < strike ? { kind: 'assigned' } : { kind: 'expired_worthless' };
  }
  return spot > strike ? { kind: 'assigned' } : { kind: 'expired_worthless' };
}

/** Minimal assigned-lot shape the guard planner reads (subset of `AssignedShareLot`). */
export interface WheelLotView {
  costBasisPerShare: number;
  ccCount: number;
  hasOpenCoveredCall: boolean;
}

/**
 * TRA-1322 tail-cap guard decision for an assigned lot:
 *   • `stock_stop` — the underlying has fallen to/through `costBasis·(1 − stockStopPct)`
 *     (guard #2, removes the unbounded left tail); takes priority.
 *   • `max_window_liquidation` — the lot has run its `maxCcCycles` covered calls and
 *     has none currently open (guard #3, don't bag-hold indefinitely).
 * Returns `null` when the lot should keep wheeling. `spot` must be a finite,
 * positive mark for the stock stop to engage (no mark ⇒ can't stop).
 */
export function planLotGuard(
  lot: WheelLotView,
  spot: number,
  guards: WheelGuards,
): 'stock_stop' | 'max_window_liquidation' | null {
  if (
    Number.isFinite(spot) && spot > 0 &&
    lot.costBasisPerShare > 0 &&
    spot <= lot.costBasisPerShare * (1 - guards.stockStopPct)
  ) {
    return 'stock_stop';
  }
  if (!lot.hasOpenCoveredCall && lot.ccCount >= guards.maxCcCycles) {
    return 'max_window_liquidation';
  }
  return null;
}
