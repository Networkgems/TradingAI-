/**
 * TRA-185 — spread-aware cost model.
 *
 * Per-fill cost (commission + slippage, both expressed in basis points of
 * notional) keyed by symbol. Used by the backtest runner to drop the flat
 * 40 bps + 5 bps assumption that over-charges liquid majors and under-charges
 * thin names. See `docs/cost-model.md` for tier sourcing.
 */

/** Per-fill commission and slippage, both in basis points of notional. */
export interface FillCost {
  commissionBps: number;
  slippageBps: number;
}

/**
 * Strategy-agnostic per-fill cost lookup. The runner calls `resolve(symbol)`
 * once per backtest (each `BacktestConfig` is single-symbol) and reuses the
 * answer for every fill — entry and exit, every position.
 */
export interface CostModel {
  resolve(symbol: string): FillCost;
}

/**
 * Convenience flat cost model — keeps existing flat-cost callers convertible
 * to the `CostModel` interface without rewriting them.
 */
export function flatCostModel(fill: FillCost): CostModel {
  return { resolve: () => fill };
}
