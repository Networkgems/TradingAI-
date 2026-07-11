// TRA-1600 (parent TRA-1599 cost-gap plan, board-accepted TRA-1597 sequenced
// promotion) — the COST-AWARE options admission gate (deliverables B + C).
//
// The problem this closes (QuantTrader's TRA-1599 decomposition): the executing
// options sleeves fire on a flat, near-zero gross bar. On a high-scratch, thin-
// edge book (~68% scratch, gross +0.2R/idea) the per-round-trip bid-ask spread
// cross is nearly CONSTANT while the edge per trade is tiny, so the cost/edge
// ratio explodes and a ~flat-gross book goes sharply negative net (measured
// −0.63R on the live-gate cohort). Two levers attack the ratio; this module is
// Lever B: replace the flat +0 gross bar with a cost-aware admission bar so we
// fire FEWER, HIGHER-edge trades and stop paying spread cross on the mass of
// ~0-edge scratches.
//
//   admit idea  iff  modeledGrossR  >=  costModel(structure) + safetyMargin
//   costModel   =  commissionR  +  makerAdjustedSpreadCrossR      (per structure)
//   safetyMargin ~= 0.20R
//
// The pure decision logic ({@link resolveCostModel}, {@link admissionBarR},
// {@link admitByCostAwareGate}) is env-free and unit-tested; a thin env resolver
// ({@link resolveCostGateConfig}) reads the operator-tunable knobs so QuantTrader
// can retune the per-structure cost/bar from the MEASURED (deliverable D) slippage
// ledger WITHOUT a code change.
//
// OFF by default and DEMO-FIRST: the master flag `ENABLE_OPTION_COST_AWARE_GATE`
// gates enforcement; the caller additionally hard-gates on `mode === 'demo'` so
// live-capital admission is never touched by this ticket. Live promotion stays
// gated on the existing dark flags (TRA-1490/1491 → TRA-1582/1588) regardless.

/**
 * Master switch for the cost-aware options admission gate. OFF by default so a
 * deploy can't start rejecting ideas without an explicit opt-in; the executing
 * options paths keep their prior (flat) admission behaviour byte-for-byte until
 * an operator sets this. Enforcement is additionally demo-gated at the call site.
 */
export const OPTION_COST_AWARE_GATE_FLAG = 'ENABLE_OPTION_COST_AWARE_GATE';

// Operator-tunable knobs (all optional; each falls back to the shipped default so
// an unset/malformed env preserves the reference behaviour). QuantTrader retunes
// these off the measured slippage rollup (deliverable D) as it accrues.
//
//  - MIN_GROSS_R: hard floor on the effective options admission bar. The plan
//    calls for ~0.8R on options structures; this lets that be lifted/lowered
//    without touching the per-structure cost inputs. When set it is the LOWER
//    bound of the effective bar (the bar is max(costModel+margin, floor)).
//  - SAFETY_MARGIN_R: the buffer added on top of costModel (default 0.20R).
//  - COMMISSION_R / SPREAD_CROSS_R: per-structure cost inputs (defaults below),
//    overridable as a single blended options number for quick retunes.
export const OPTION_COST_GATE_MIN_GROSS_R_VAR = 'OPTION_COST_GATE_MIN_GROSS_R';
export const OPTION_COST_GATE_SAFETY_MARGIN_R_VAR = 'OPTION_COST_GATE_SAFETY_MARGIN_R';
export const OPTION_COST_GATE_COMMISSION_R_VAR = 'OPTION_COST_GATE_COMMISSION_R';
export const OPTION_COST_GATE_SPREAD_CROSS_R_VAR = 'OPTION_COST_GATE_SPREAD_CROSS_R';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the cost-aware options admission gate is enabled (1/true/yes/on). */
export function isOptionCostAwareGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_COST_AWARE_GATE_FLAG]);
}

/** A parsed non-negative finite float, or undefined when unset/invalid. */
function parseNonNegFloat(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The per-structure cost inputs (R-multiples of the trade's at-risk basis).
 *  - `commissionR`: Tradier options commission, round trip. $0.35/contract each
 *    way = $0.70/contract; on a single-leg long with R≈$40–180 (40–60% of a
 *    $100–300 premium) that is ~0.05–0.10R — we default to the conservative
 *    upper end (0.10R). Bounded and unavoidable.
 *  - `makerAdjustedSpreadCrossR`: the residual bid-ask spread cross AFTER
 *    maker-fill routing (Lever A) recovers ~60–70% of the raw 0.70–0.78R spread
 *    bucket. The plan models post-maker residual at 0.22–0.29R; we default to a
 *    conservative 0.50R so the shipped options bar lands at the plan's headline
 *    ~0.8R (0.10 + 0.50 + 0.20 margin) until the MEASURED (D) rollup lets
 *    QuantTrader tighten it toward the modeled post-maker figure.
 */
export interface StructureCost {
  commissionR: number;
  makerAdjustedSpreadCrossR: number;
}

/** costModel(structure) = commissionR + makerAdjustedSpreadCrossR. Pure. */
export function structureCostR(cost: StructureCost): number {
  return cost.commissionR + cost.makerAdjustedSpreadCrossR;
}

/**
 * Whether a structure is one of the options sleeves this gate governs. The
 * equity swing sleeve trades penny-wide spreads on liquid large-caps at $0
 * commission — spread cross is a small fraction of R there — so it is
 * deliberately EXEMPT (its far-lower bar is the `equity` default). Anything that
 * is not a known equity structure is treated as an options sleeve (conservative:
 * an unrecognised options-like structure gets the higher options bar, not a free
 * pass).
 */
export function isEquityStructure(structure: string): boolean {
  const s = structure.trim().toLowerCase();
  return s === 'equity' || s === 'equity_swing' || s === 'swing' || s.startsWith('equity_');
}

/** Resolved, fully-defaulted cost-gate configuration. Pure — no env access. */
export interface CostGateConfig {
  /** Per-structure cost inputs for the OPTIONS sleeves (single_leg_otm/rv, directional, spreads). */
  optionsCost: StructureCost;
  /** Per-structure cost inputs for the EQUITY sleeve (tiny spreads, $0 commission). */
  equityCost: StructureCost;
  /** Buffer added on top of costModel before admitting (default 0.20R). */
  safetyMarginR: number;
  /** Hard floor on the effective OPTIONS admission bar (default 0.80R). */
  optionsMinGrossR: number;
}

/**
 * The shipped reference config. Options bar resolves to
 * 0.10 (commission) + 0.50 (maker-adjusted spread) + 0.20 (margin) = 0.80R,
 * floored at 0.80R — the plan's headline options admission bar. Equity bar
 * resolves to 0.00 + 0.02 + 0.20 = 0.22R (kept low per the plan; equity is the
 * least cost-impaired leg).
 */
export const DEFAULT_COST_GATE_CONFIG: CostGateConfig = {
  optionsCost: { commissionR: 0.1, makerAdjustedSpreadCrossR: 0.5 },
  equityCost: { commissionR: 0.0, makerAdjustedSpreadCrossR: 0.02 },
  safetyMarginR: 0.2,
  optionsMinGrossR: 0.8,
};

/**
 * The effective admission bar (minimum modeled gross R) for a structure under a
 * config. For options structures the bar is
 * `max(costModel + safetyMargin, optionsMinGrossR)`; for equity it is
 * `costModel + safetyMargin` (no floor — equity is intentionally cheap to admit).
 * Pure.
 */
export function admissionBarR(structure: string, config: CostGateConfig = DEFAULT_COST_GATE_CONFIG): number {
  if (isEquityStructure(structure)) {
    return structureCostR(config.equityCost) + config.safetyMarginR;
  }
  const modelBar = structureCostR(config.optionsCost) + config.safetyMarginR;
  return Math.max(modelBar, config.optionsMinGrossR);
}

/** The admit/reject verdict for one candidate. */
export interface CostGateVerdict {
  admit: boolean;
  structure: string;
  modeledGrossR: number;
  /** The bar the candidate had to clear. */
  barR: number;
  /** commissionR + makerAdjustedSpreadCrossR for this structure. */
  costModelR: number;
  safetyMarginR: number;
  /** Human-readable rejection reason (empty when admitted). */
  reason: string;
}

/**
 * The core admission decision (deliverables B + C). Admit iff the candidate's
 * modeled gross R clears the cost-aware bar for its structure. A non-finite
 * modeledGrossR is treated as failing (we never admit on an unknown edge). Pure.
 */
export function admitByCostAwareGate(
  modeledGrossR: number,
  structure: string,
  config: CostGateConfig = DEFAULT_COST_GATE_CONFIG,
): CostGateVerdict {
  const barR = admissionBarR(structure, config);
  const costModelR = structureCostR(isEquityStructure(structure) ? config.equityCost : config.optionsCost);
  const gross = Number.isFinite(modeledGrossR) ? modeledGrossR : Number.NaN;
  const admit = Number.isFinite(gross) && gross >= barR;
  return {
    admit,
    structure,
    modeledGrossR: gross,
    barR,
    costModelR,
    safetyMarginR: config.safetyMarginR,
    reason: admit
      ? ''
      : `cost-aware gate: modeled gross ${Number.isFinite(gross) ? gross.toFixed(3) : 'unknown'}R < ${barR.toFixed(2)}R bar (costModel ${costModelR.toFixed(2)}R + margin ${config.safetyMarginR.toFixed(2)}R) for ${structure}`,
  };
}

/**
 * Resolve the operator-tunable cost-gate config from env, falling back to
 * {@link DEFAULT_COST_GATE_CONFIG} field-by-field so any unset/malformed knob
 * preserves the shipped reference behaviour. The commission/spread overrides
 * apply to the OPTIONS sleeve only (equity's tiny cost is not operator-tuned).
 */
export function resolveCostGateConfig(env: NodeJS.ProcessEnv = process.env): CostGateConfig {
  const commissionR = parseNonNegFloat(env[OPTION_COST_GATE_COMMISSION_R_VAR]);
  const spreadCrossR = parseNonNegFloat(env[OPTION_COST_GATE_SPREAD_CROSS_R_VAR]);
  const safetyMarginR = parseNonNegFloat(env[OPTION_COST_GATE_SAFETY_MARGIN_R_VAR]);
  const minGrossR = parseNonNegFloat(env[OPTION_COST_GATE_MIN_GROSS_R_VAR]);
  return {
    optionsCost: {
      commissionR: commissionR ?? DEFAULT_COST_GATE_CONFIG.optionsCost.commissionR,
      makerAdjustedSpreadCrossR: spreadCrossR ?? DEFAULT_COST_GATE_CONFIG.optionsCost.makerAdjustedSpreadCrossR,
    },
    equityCost: { ...DEFAULT_COST_GATE_CONFIG.equityCost },
    safetyMarginR: safetyMarginR ?? DEFAULT_COST_GATE_CONFIG.safetyMarginR,
    optionsMinGrossR: minGrossR ?? DEFAULT_COST_GATE_CONFIG.optionsMinGrossR,
  };
}
