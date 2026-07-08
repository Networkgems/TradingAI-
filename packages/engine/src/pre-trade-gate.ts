// TRA-1457 — Universal PRE-TRADE GATE (pure evaluator).
//
// Board approved (TRA-1456, local-board 2026-07-08): "I approve the Universal
// pre-trade gate (MTF + volume + R:R>=1.5, ATR stop)". This is the ONE distilled
// improvement from the TRA-1456 strategy-card study (readout eda8bf72): fold the
// recurring tactical-chart pattern into a single reusable gate that EVERY trade
// candidate (options RV/exec-selector, equity directional, crypto DCA/TSMOM) must
// clear before order routing.
//
// This module is PURE and side-effect free: it takes the entry basis, direction,
// ATR, higher-timeframe trend sign, relative volume, and target, and returns
// pass/fail plus a per-reason rejection list and the computed R:R / ATR-stop
// detail. It knows nothing about flags, ledgers, engines, or capital — the
// SHADOW-FIRST recording and the ENABLE_PRE_TRADE_GATE kill switch live in the
// server-side ledger that consumes this (packages/server/src/pre-trade-gate-
// ledger.ts). Keeping the rules here means the unit tests below pin the exact
// pass/fail boundary independent of any wiring, and every engine shares one
// verbatim rule set rather than re-deriving R:R math per call site.

export type PreTradeDirection = 'long' | 'short';

/**
 * The four rejection reasons, one per gate rule. A passing candidate returns an
 * empty `reasons[]`; a failing one lists EVERY rule it broke (not just the first)
 * so the shadow ledger can attribute rejections per reason.
 */
export type PreTradeGateReason =
  /** Rule 1 — entry direction disagrees with the higher-timeframe trend sign. */
  | 'MTF_MISALIGNED'
  /** Rule 2 — relative volume is below the confirmation threshold. */
  | 'RVOL_BELOW_THRESHOLD'
  /** Rule 3 — reward:risk (target distance / ATR-stop distance) is under the min. */
  | 'RR_BELOW_MIN'
  /** Rule 4 — no usable ATR, so a `k * ATR` stop cannot be derived. */
  | 'ATR_STOP_MISSING';

/**
 * Tunable cuts. Defaults come straight from the TRA-1456 approval: RVOL floor
 * 1.0 (QuantTrader ratifies 1.5 as the eventual promotion cut — swap `minRvol`
 * when that lands), reward:risk >= 1.5, ATR-stop multiple k = 1.5.
 */
export interface PreTradeGateConfig {
  /** Rule 2 — minimum relative volume (RVOL) to confirm. Default 1.0. */
  minRvol: number;
  /** Rule 3 — minimum reward:risk ratio. Default 1.5. */
  minRewardRisk: number;
  /** Rule 4 — ATR multiple for the derived stop distance (`k * ATR`). Default 1.5. */
  atrStopK: number;
}

export const DEFAULT_PRE_TRADE_GATE_CONFIG: PreTradeGateConfig = {
  minRvol: 1.0,
  minRewardRisk: 1.5,
  atrStopK: 1.5,
};

/**
 * One candidate to evaluate. `mtfTrend` is the higher-timeframe trend SIGN, not a
 * price: > 0 up, < 0 down, 0 neutral (a flat/chop higher TF fails alignment for
 * both directions, by design). `atr` is the entry-timeframe ATR value; the stop
 * is derived from it as `k * ATR`, never passed in, so every candidate is held to
 * the same ATR-stop rule.
 */
export interface PreTradeGateInput {
  /** Entry price — the basis every distance is measured from. */
  entry: number;
  direction: PreTradeDirection;
  /** Entry-timeframe ATR value (absolute price units). */
  atr: number;
  /** Higher-timeframe trend sign: > 0 up, < 0 down, 0 neutral. */
  mtfTrend: number;
  /** Relative volume (current vs baseline). */
  rvol: number;
  /** Target/take-profit price. */
  target: number;
}

export interface PreTradeGateResult {
  /** True iff ALL four rules pass (`reasons` empty). */
  pass: boolean;
  /** Every broken rule; empty on a full pass. */
  reasons: PreTradeGateReason[];
  /** Derived ATR-stop distance (`k * ATR`); null when ATR is unusable. */
  stopDistance: number | null;
  /** Derived ATR-stop price (below entry for long, above for short); null w/o ATR. */
  stopPrice: number | null;
  /** Reward:risk = directional target distance / stop distance; null when uncomputable. */
  rewardRisk: number | null;
  /** The config actually applied (echoed so a ledger row is self-describing). */
  config: PreTradeGateConfig;
}

function isUsableNumber(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Evaluate one candidate against all four gate rules. Pure and total: any
 * non-finite / nonsensical input degrades to the corresponding rejection reason
 * rather than throwing, so a bad feed read can never crash the shadow pass.
 *
 * Reward:risk is DIRECTIONAL — for a long, reward is `target - entry` (negative
 * when the target sits on the wrong side, which then fails RR); for a short it is
 * `entry - target`. Risk is the ATR-stop distance `k * ATR`. This catches a
 * target placed on the wrong side of entry as an RR failure, not a silent pass.
 */
export function evaluatePreTradeGate(
  input: PreTradeGateInput,
  config: PreTradeGateConfig = DEFAULT_PRE_TRADE_GATE_CONFIG,
): PreTradeGateResult {
  const { entry, direction, atr, mtfTrend, rvol, target } = input;
  const cfg = config;
  const reasons: PreTradeGateReason[] = [];

  // Rule 4 — ATR stop. Must have a strictly-positive, finite ATR to derive a
  // `k * ATR` stop; otherwise there is no risk basis and R:R is uncomputable too.
  const atrUsable = isUsableNumber(atr) && atr > 0;
  const stopDistance = atrUsable ? cfg.atrStopK * atr : null;
  const stopPrice =
    stopDistance !== null && isUsableNumber(entry)
      ? direction === 'long'
        ? entry - stopDistance
        : entry + stopDistance
      : null;
  if (!atrUsable) reasons.push('ATR_STOP_MISSING');

  // Rule 1 — MTF trend alignment. Long needs an up higher-TF trend, short a down
  // one; a neutral (0) or non-finite trend aligns with neither.
  const mtfAligned =
    isUsableNumber(mtfTrend) &&
    ((direction === 'long' && mtfTrend > 0) || (direction === 'short' && mtfTrend < 0));
  if (!mtfAligned) reasons.push('MTF_MISALIGNED');

  // Rule 2 — volume confirmation.
  const rvolOk = isUsableNumber(rvol) && rvol >= cfg.minRvol;
  if (!rvolOk) reasons.push('RVOL_BELOW_THRESHOLD');

  // Rule 3 — reward:risk. Uncomputable (no ATR stop or non-finite entry/target)
  // is treated as a failure, not a pass.
  let rewardRisk: number | null = null;
  if (
    stopDistance !== null &&
    stopDistance > 0 &&
    isUsableNumber(entry) &&
    isUsableNumber(target)
  ) {
    const reward = direction === 'long' ? target - entry : entry - target;
    rewardRisk = reward / stopDistance;
  }
  const rrOk = rewardRisk !== null && rewardRisk >= cfg.minRewardRisk;
  if (!rrOk) reasons.push('RR_BELOW_MIN');

  return {
    pass: reasons.length === 0,
    reasons,
    stopDistance,
    stopPrice,
    rewardRisk,
    config: cfg,
  };
}
