/**
 * TRA-912 (TRA-908 Phase B) — pre-trade gate for defined-risk multi-leg
 * options orders. Pure and total: every input maps to an allow/reject verdict
 * with no side effects, so it is the explicitly-tested artifact the board
 * acceptance pins down ("pre-trade buying-power + max-loss gate rejects
 * oversized orders in tests").
 *
 * Two independent checks, evaluated BEFORE any broker placement:
 *  1. Per-trade max-loss cap (the GOVERNOR) — the structure's capital-at-risk
 *     (`maxLossPerLot x contracts`) must not exceed the per-trade ceiling:
 *         capUsd = max(equity x cap, min(absFloor, equity x floorFrac))
 *     i.e. `max(2% of equity, min($500, 5% of equity))`.
 *     TRA-1348: the flat 1%-of-equity cap ($250 on the $25k demo book) sat
 *     below the max loss of a single standard $5-wide defined-risk vertical
 *     (~$350-450/lot), so 100% of AI options ideas returned `enterable:false`.
 *     The 2% cap + a $500 ABSOLUTE dollar floor lets a small book still enter
 *     one standard single lot; the floor is itself clamped to 5% of equity so
 *     it never over-risks a tiny live book. A defined-risk spread caps its own
 *     downside, so this is a sizing guard, not a stop: it refuses to open a
 *     single combo large enough to blow the per-trade risk budget.
 *  2. Buying-power — the same capital-at-risk must fit inside the broker's
 *     reported option buying power. `optionBuyingPower: null` means "unknown"
 *     (the paper book has no live broker hold to mirror), and the check is
 *     skipped rather than blocking blindly.
 *
 * The gate never sizes UP — it only rejects. Callers decide whether to trim
 * `contracts` and re-evaluate (the paper account does) or void the open.
 */

/** TRA-1348 — default per-trade max-loss cap: 2% of account equity. */
export const DEFAULT_MAX_LOSS_PCT_CAP = 0.02;
/**
 * TRA-1348 — absolute USD floor under the per-trade max-loss ceiling so a small
 * book can still enter one standard single defined-risk lot even when 2% of its
 * equity is below a single lot's max loss. Itself clamped to a fraction of
 * equity ({@link DEFAULT_MAX_LOSS_FLOOR_EQUITY_FRAC}) so it never over-risks a
 * tiny live book.
 */
export const DEFAULT_MAX_LOSS_ABS_FLOOR = 500;
/**
 * TRA-1348 — the absolute dollar floor is clamped to this fraction of equity
 * (5%) so on a truly tiny book the floor never lets a single trade risk more
 * than 5% of the account.
 */
export const DEFAULT_MAX_LOSS_FLOOR_EQUITY_FRAC = 0.05;

/**
 * TRA-1348 — the per-trade max-loss ceiling in USD (the governor):
 *   `max(equity x cap, min(absFloor, equity x floorFrac))`.
 * Exported so callers that pre-size lots against the same ceiling (the paper
 * open path's cap-lot trim) stay in lockstep with the gate below.
 */
export function maxLossCapUsd(
  equity: number,
  cap: number = DEFAULT_MAX_LOSS_PCT_CAP,
  absFloor: number = DEFAULT_MAX_LOSS_ABS_FLOOR,
  floorFrac: number = DEFAULT_MAX_LOSS_FLOOR_EQUITY_FRAC,
): number {
  return Math.max(equity * cap, Math.min(absFloor, equity * floorFrac));
}

export interface MultiLegPreTradeInput {
  /** Account equity the per-trade max-loss cap is measured against. */
  accountEquity: number;
  /**
   * Broker-reported option buying power, or `null` when unknown (paper book
   * with no live hold). When a finite number, the structure's capital-at-risk
   * must fit inside it.
   */
  optionBuyingPower: number | null;
  /** Capital at risk for a single combo lot, in USD (already x100 multiplier). */
  maxLossPerLot: number;
  /** Number of combo lots being opened. */
  contracts: number;
  /** Per-trade max-loss cap as a fraction of equity. Defaults to 2%. */
  maxLossPctCap?: number;
  /**
   * TRA-1348 — absolute USD floor under the ceiling. Defaults to $500. Set to 0
   * to disable the floor (pure percentage cap).
   */
  maxLossAbsFloor?: number;
  /**
   * TRA-1348 — the absolute floor is clamped to this fraction of equity.
   * Defaults to 5%.
   */
  maxLossFloorEquityFrac?: number;
}

export type MultiLegPreTradeVerdict =
  | {
      allowed: true;
      /** Total capital at risk across all lots, USD. */
      totalMaxLoss: number;
      /** Fraction of equity at risk (0-1). */
      maxLossPct: number;
    }
  | { allowed: false; reason: string };

/**
 * TRA-912 — evaluate the pre-trade gate. ASCII-only reject reasons so they are
 * safe to surface through the comment/log API.
 */
export function evaluateMultiLegPreTrade(
  input: MultiLegPreTradeInput,
): MultiLegPreTradeVerdict {
  const cap = input.maxLossPctCap ?? DEFAULT_MAX_LOSS_PCT_CAP;

  if (!Number.isFinite(input.accountEquity) || input.accountEquity <= 0) {
    return { allowed: false, reason: 'account equity unavailable or non-positive' };
  }
  if (!Number.isFinite(input.maxLossPerLot) || input.maxLossPerLot <= 0) {
    return { allowed: false, reason: 'max loss per lot must be a positive number' };
  }
  if (!Number.isInteger(input.contracts) || input.contracts < 1) {
    return { allowed: false, reason: 'contracts must be a positive integer' };
  }
  if (!Number.isFinite(cap) || cap <= 0) {
    return { allowed: false, reason: 'max-loss cap must be a positive fraction' };
  }

  const absFloor =
    Number.isFinite(input.maxLossAbsFloor) && (input.maxLossAbsFloor as number) >= 0
      ? (input.maxLossAbsFloor as number)
      : DEFAULT_MAX_LOSS_ABS_FLOOR;
  const floorFrac =
    Number.isFinite(input.maxLossFloorEquityFrac) && (input.maxLossFloorEquityFrac as number) >= 0
      ? (input.maxLossFloorEquityFrac as number)
      : DEFAULT_MAX_LOSS_FLOOR_EQUITY_FRAC;

  const totalMaxLoss = input.maxLossPerLot * input.contracts;
  const maxLossPct = totalMaxLoss / input.accountEquity;
  // TRA-1348 governor: max(equity x cap, min(absFloor, equity x floorFrac)).
  const capUsd = maxLossCapUsd(input.accountEquity, cap, absFloor, floorFrac);

  if (totalMaxLoss > capUsd + 1e-9) {
    return {
      allowed: false,
      reason:
        `max loss $${totalMaxLoss.toFixed(2)} (${(maxLossPct * 100).toFixed(2)}%) ` +
        `exceeds per-trade cap $${capUsd.toFixed(2)}`,
    };
  }

  if (
    input.optionBuyingPower !== null &&
    Number.isFinite(input.optionBuyingPower) &&
    totalMaxLoss > (input.optionBuyingPower as number) + 1e-9
  ) {
    return {
      allowed: false,
      reason:
        `option buying power $${(input.optionBuyingPower as number).toFixed(2)} ` +
        `< required $${totalMaxLoss.toFixed(2)}`,
    };
  }

  return { allowed: true, totalMaxLoss, maxLossPct };
}
