// TRA-678 (F1) + TRA-1991 — the SINGLE SOURCE OF TRUTH for the AI-Options-Ideas
// transaction-cost model and the cost-efficiency gate threshold.
//
// Extracted from `options-forward-test.ts` (TRA-1991) so THREE call sites share
// one cost model + threshold without a runtime import cycle:
//   • options-ideas-feed.ts   — surface-time filter (drop uneconomic structures)
//   • options-idea-journal.ts — stamp `costEfficiencyRatio` on each captured idea
//   • options-forward-test.ts — cost-NET valuation + the `cost_uneconomic` exclusion
// `options-forward-test` ⇄ `options-idea-journal` already import each other at
// runtime (isoWeek / valueIdea), so these helpers must live in a LEAF module (no
// intra-package imports → no cycle). `options-forward-test` re-exports the names
// below so existing importers resolve them unchanged.

/** Contract multiplier — one option contract controls 100 shares. */
const CONTRACT = 100;
/** Round trip = entry + exit; commission + spread are paid on BOTH sides. */
const SIDES = 2;

const r2 = (v: number): number => Math.round(v * 100) / 100;

// ── transaction-cost model (TRA-678 F1) ─────────────────────────────────────
//
// Entry net and (open) marks price at MID; settlement is intrinsic. Real fills
// cross the bid/ask per leg and pay commission, on BOTH the entry and the exit.
// So mid-to-mid R is optimistically biased — a 4-leg condor crosses up to 8
// half-spreads round-trip. We haircut a conservative, fully-disclosed cost so the
// gate evaluates a *net* edge, not the paper-perfect one. Gross figures are kept
// alongside so the bias is auditable and the model can be retuned in one place.

export interface CostModel {
  /** Commission per contract, per side (entry and exit are separate sides), USD. */
  commissionPerContract: number;
  /** Half bid/ask spread crossed per contract, per side, in premium points (× 100). */
  halfSpreadPerContract: number;
}

/**
 * Default round-trip cost model — deliberately conservative-but-modest retail
 * assumptions for liquid US single-name/ETF options ($0.65/contract commission,
 * a $0.02 half-spread per leg per side). One source of truth; mirrored in
 * `docs/live-capital-gate.md`.
 */
export const DEFAULT_COST_MODEL: CostModel = {
  commissionPerContract: 0.65,
  halfSpreadPerContract: 0.02,
};

/** Modeled round-trip transaction cost (USD per 1-lot) for a structure's legs. */
export function structureCostUsd(legCount: number, model: CostModel = DEFAULT_COST_MODEL): number {
  const commission = legCount * SIDES * model.commissionPerContract;
  const spread = legCount * SIDES * model.halfSpreadPerContract * CONTRACT;
  return r2(commission + spread);
}

// ── cost-efficiency gate (TRA-1991) ─────────────────────────────────────────

/**
 * TRA-1991 — the maximum fraction of a defined-risk structure's defined max-loss
 * that its modeled round-trip cost (F1) may consume before the structure is
 * UNECONOMIC to trade with real capital.
 *
 * Measured on live bqb1 (2026-07-17) the gate ran a gross R-expectancy of +0.20
 * but a cost-NET R of −0.63 — an 0.83R haircut, i.e. the average modeled round-
 * trip cost was ~83% of max-loss. The failure mode is penny-wide, high-credit
 * spreads whose defined risk (~$13–25) is barely larger than the fixed $10–21
 * round-trip retail cost, so their live NET R is structurally negative regardless
 * of a marginally-positive gross edge. To keep net R positive against a ~+0.2R
 * gross edge, cost/maxLoss must sit well below 0.2; 0.15 leaves margin. This is
 * equivalent to a minimum-width / minimum-max-loss floor — favor wider spreads
 * (larger denominators) over penny-wide high-credit ones. Scaling lot size does
 * NOT help (both cost and max-loss scale with contracts, so the ratio is
 * lot-invariant); the only levers are wider spreads, fewer legs, or thicker edge.
 *
 * Overridable via `OPTIONS_COST_EFFICIENCY_MAX` (a positive fraction); an
 * unset/invalid value falls back to the default.
 */
export const COST_EFFICIENCY_MAX: number = (() => {
  const raw = Number(process.env['OPTIONS_COST_EFFICIENCY_MAX']);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.15;
})();

/**
 * TRA-1991 — cost-efficiency ratio = modeled round-trip cost ÷ defined max-loss
 * (USD/1-lot ÷ USD/1-lot). LOT-INVARIANT: both the cost and the max-loss scale
 * linearly with contract count, so the ratio is a property of the STRUCTURE
 * (leg-count + width), not the size. Returns null when there is no positive
 * max-loss denominator (the F4 case), so callers never divide by zero. Rounded to
 * 4 decimals for a stable, auditable stamp.
 */
export function costEfficiencyRatio(
  legCount: number,
  maxLossUsd: number,
  model: CostModel = DEFAULT_COST_MODEL,
): number | null {
  if (!(maxLossUsd > 0)) return null;
  return Math.round((structureCostUsd(legCount, model) / maxLossUsd) * 10000) / 10000;
}
