// TRA-1981 (parent TRA-1967 item 2) — realized-vs-modeled slippage KPI per fill,
// aggregated per asset class.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The pre-trade LIQUIDITY gate (TRA-1967 item 1) MODELS a cost per fill (spread
// cross + impact bps). This module measures the REALIZED execution cost against
// that model, per asset class (equity / options / crypto), so execution decay is
// visible BEFORE it eats the edge. It is the out-of-sample check that justifies
// arming the liquidity-gate veto: if realized cost tracks the model, the model is
// trustworthy; if it runs materially hotter, the veto is arming on fiction.
//
// ── PURE FOLD, NO I/O ────────────────────────────────────────────────────────
// Inputs are per-fill {realized, modeled} USD samples tagged by asset class. The
// server layer sources them from the option fee/slippage ledger (realized fill-vs-
// mid; live-options-fee-slippage-ledger.ts) and the TRA-536 equity/crypto entry-
// slippage stamps on positions (realizedSlippage / modeledSlippage). This core only
// aggregates — it never reaches for state.
//
// ── UNMEASURED IS null, NEVER 0 (TRA-1707) ───────────────────────────────────
// A `0` reads as "measured, and it was zero" — a false datapoint that would bias
// the decay ratio the board reads. `null` reads as "not measured" and drops out of
// every mean/ratio. A fill only enters the decay-ratio sample when BOTH legs are
// measured; a partially-measured fill still counts in `fills` (it happened) but
// contributes nothing to the ratio.

/** The three per-fill cost regimes measured separately. */
export type ExecutionAssetClass = 'equity' | 'options' | 'crypto';

export const EXECUTION_ASSET_CLASSES: readonly ExecutionAssetClass[] = ['equity', 'options', 'crypto'];

/**
 * One realized-vs-modeled fill sample. Both figures in account USD. `realizedUsd`
 * is SIGNED in the direction of cost (positive = filled worse than the reference —
 * paid up / gave up edge; negative = price improvement). `modeledUsd` is a cost
 * BUDGET (non-negative). Either leg is `null` when it could not be measured for this
 * fill (TRA-1707), never 0.
 */
export interface ExecutionSlippageFill {
  assetClass: ExecutionAssetClass;
  symbol: string;
  /** ms-epoch of the fill, when known (diagnostics only). */
  ts?: number;
  /** Realized execution slippage cost, USD, signed into the direction of cost. null = unmeasured. */
  realizedUsd: number | null;
  /** Modeled cost the trade was charged (tier-table / spread-cross budget), USD ≥ 0. null = unmeasured. */
  modeledUsd: number | null;
}

/** Folded realized-vs-modeled figures over a set of fills. */
export interface ExecutionQualityAggregate {
  /** Fills seen (any measurement state) — proof the population is non-empty. */
  fills: number;
  /** Fills carrying BOTH a realized and a modeled leg — the decay-ratio sample size. */
  measured: number;
  /** Σ realized (SIGNED) over measured fills, USD. null when none measured. */
  realizedTotalUsd: number | null;
  /** Σ |modeled| over measured fills, USD. null when none measured. */
  modeledTotalUsd: number | null;
  /** Mean signed realized over measured fills, USD. null when none measured. */
  meanRealizedUsd: number | null;
  /** Mean modeled over measured fills, USD. null when none measured. */
  meanModeledUsd: number | null;
  /**
   * Σ|realized| ÷ Σ|modeled| over measured fills — the execution-decay ratio. > 1 ⇒
   * realized cost is running hotter than the model assumed (execution decay). Uses
   * magnitudes, mirroring the TRA-532 promotion gate's `maxSlippageRatio` semantics.
   * null when nothing is measured or Σ|modeled| is 0 (advisory, never a fake 0).
   */
  decayRatio: number | null;
}

export interface ExecutionQualityClassKpi extends ExecutionQualityAggregate {
  assetClass: ExecutionAssetClass;
}

/** The per-asset-class KPI plus a blended overall roll-up. */
export interface ExecutionQualityKpi {
  byAssetClass: Record<ExecutionAssetClass, ExecutionQualityClassKpi>;
  overall: ExecutionQualityAggregate;
}

function round(n: number | null, dp = 2): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function measured(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function foldAggregate(fills: readonly ExecutionSlippageFill[]): ExecutionQualityAggregate {
  let measuredCount = 0;
  let sumRealizedSigned = 0;
  let sumRealizedAbs = 0;
  let sumModeledAbs = 0;
  for (const f of fills) {
    // The decay ratio is only meaningful over fills where BOTH legs are measured —
    // pairing a realized figure against an absent budget (or vice-versa) would skew
    // the numerator and denominator against different samples.
    if (measured(f.realizedUsd) && measured(f.modeledUsd)) {
      measuredCount += 1;
      sumRealizedSigned += f.realizedUsd;
      sumRealizedAbs += Math.abs(f.realizedUsd);
      sumModeledAbs += Math.abs(f.modeledUsd);
    }
  }
  return {
    fills: fills.length,
    measured: measuredCount,
    realizedTotalUsd: measuredCount > 0 ? round(sumRealizedSigned) : null,
    modeledTotalUsd: measuredCount > 0 ? round(sumModeledAbs) : null,
    meanRealizedUsd: measuredCount > 0 ? round(sumRealizedSigned / measuredCount) : null,
    meanModeledUsd: measuredCount > 0 ? round(sumModeledAbs / measuredCount) : null,
    decayRatio: measuredCount > 0 && sumModeledAbs > 0 ? round(sumRealizedAbs / sumModeledAbs, 4) : null,
  };
}

/**
 * Fold per-fill realized-vs-modeled samples into the per-asset-class + overall KPI.
 * Pure: no I/O, no clock, no state. A class with no fills still appears (with
 * `fills: 0` and every measured figure `null`) so the reader always sees all three
 * regimes and can tell "no data" from "measured zero".
 */
export function computeExecutionQualityKpi(fills: readonly ExecutionSlippageFill[]): ExecutionQualityKpi {
  const byAssetClass = Object.fromEntries(
    EXECUTION_ASSET_CLASSES.map((ac) => [
      ac,
      { assetClass: ac, ...foldAggregate(fills.filter((f) => f.assetClass === ac)) },
    ]),
  ) as Record<ExecutionAssetClass, ExecutionQualityClassKpi>;
  return { byAssetClass, overall: foldAggregate(fills) };
}
