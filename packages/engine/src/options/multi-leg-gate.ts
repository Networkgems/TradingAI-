/**
 * TRA-912 (TRA-908 Phase B) — pre-trade gate for defined-risk multi-leg
 * options orders. Pure and total: every input maps to an allow/reject verdict
 * with no side effects, so it is the explicitly-tested artifact the board
 * acceptance pins down ("pre-trade buying-power + max-loss gate rejects
 * oversized orders in tests").
 *
 * Two independent checks, evaluated BEFORE any broker placement:
 *  1. Per-trade max-loss cap — the structure's capital-at-risk
 *     (`maxLossPerLot x contracts`) must not exceed `maxLossPctCap` of account
 *     equity (default 1%). A defined-risk spread caps its own downside, so this
 *     is a sizing guard, not a stop: it refuses to open a single combo large
 *     enough to blow the per-trade risk budget.
 *  2. Buying-power — the same capital-at-risk must fit inside the broker's
 *     reported option buying power. `optionBuyingPower: null` means "unknown"
 *     (the paper book has no live broker hold to mirror), and the check is
 *     skipped rather than blocking blindly.
 *
 * The gate never sizes UP — it only rejects. Callers decide whether to trim
 * `contracts` and re-evaluate (the paper account does) or void the open.
 */

/** Default per-trade max-loss cap: 1% of account equity. */
export const DEFAULT_MAX_LOSS_PCT_CAP = 0.01;

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
  /** Per-trade max-loss cap as a fraction of equity. Defaults to 1%. */
  maxLossPctCap?: number;
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

  const totalMaxLoss = input.maxLossPerLot * input.contracts;
  const maxLossPct = totalMaxLoss / input.accountEquity;
  const capUsd = input.accountEquity * cap;

  if (totalMaxLoss > capUsd + 1e-9) {
    return {
      allowed: false,
      reason:
        `max loss $${totalMaxLoss.toFixed(2)} (${(maxLossPct * 100).toFixed(2)}%) ` +
        `exceeds ${(cap * 100).toFixed(2)}% cap $${capUsd.toFixed(2)}`,
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
