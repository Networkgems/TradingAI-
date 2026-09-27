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
//  - MIN_GROSS_R: hard floor on the effective options admission bar (default
//    0.30R — a non-binding backstop, NOT the intended bar). When set it is the
//    LOWER bound of the effective bar (the bar is max(costModel+margin, floor)),
//    so a floor above the cost model PINS the bar and makes the cost inputs
//    inert. Retune it TOGETHER with COMMISSION_R / SPREAD_CROSS_R, never alone.
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
 *  - `commissionR`: Tradier options fees, round trip, in the estimator's true
 *    R = 25% of premium (R≈$50 on a $2.00 premium). RETUNED to the MEASURED fee
 *    by TRA-4890 (board direction on TRA-4885): the desk is on a Tradier **Pro**
 *    plan, which charges **$0 commission** on options. What survives is the
 *    unavoidable regulatory/clearing residue (ORF + OCC + SEC/TAF), ≈$0.09 per
 *    contract per side ⇒ 2 × $0.09 / $50 = **0.0036R**. Equivalently
 *    `commissionR(2.00, 1, 0.09)` in `option-spread-cost.ts` — this constant is
 *    that helper's output, not an independent guess.
 *
 *    The prior 0.05R default (TRA-1603) predates the Pro plan and was explicitly
 *    a CONSERVATIVE stand-in: it overstated even the old commissioned fee
 *    ($0.35/side ⇒ $0.70 round trip ⇒ 0.014R) by ~3.6×, and overstates the fee
 *    actually paid today by ~14×. ⚠ This is the one input of the three that
 *    LOOSENS the bar, so it is retuned under the TRA-1897 hold / TRA-4750
 *    stand-down on the TRA-4885 board direction and on NOTHING else. It is safe
 *    to land only because the TRA-4894 real-fill promotion arm is LIVE and
 *    independently refuses the single cell this move flips on the pooled arm —
 *    see {@link DEFAULT_COST_GATE_CONFIG}. Do not widen scope from it.
 *  - `makerAdjustedSpreadCrossR`: the round-trip bid-ask spread cross, in the
 *    estimator's 25%-of-premium R. MEASURED (TRA-1656) over 38 days of recorded
 *    chains, restricted to each sleeve's admissible universe: 0.235R mean on
 *    `single_leg_otm` (median 0.175, p90 0.533, n=222,026) and 0.160R on
 *    `single_leg_rv` (median 0.136, p90 0.324, n=94,548). See
 *    {@link DEFAULT_COST_GATE_CONFIG} for why the blended default is the OTM
 *    (worse) figure. This is a TAKER cross: it is not maker-adjusted, because
 *    maker-fill routing (TRA-1601, Lever A) is dark and its recovery has never
 *    been measured. Charging the full taker cross until it is, is the
 *    conservative direction.
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
  /**
   * Hard floor on the effective OPTIONS admission bar (default 0.30R). A
   * backstop, not the bar: it only binds if the cost inputs collapse toward
   * zero. When it sits ABOVE `costModel + safetyMargin` it pins the bar and the
   * cost inputs stop mattering — see {@link DEFAULT_COST_GATE_CONFIG}.
   */
  optionsMinGrossR: number;
}

/**
 * The shipped reference config. Options bar resolves to
 * 0.0036 (MEASURED commission, TRA-4890) + 0.235 (MEASURED spread cross)
 * + 0.20 (margin) = 0.4386R, clear of the 0.30R backstop floor. Equity bar
 * resolves to
 * 0.00 + 0.02 + 0.20 = 0.22R (kept low per the plan; equity is the least
 * cost-impaired leg).
 *
 * ── The 1.00R input was a DEFECT, not a preference (TRA-1656 → TRA-1661) ──────
 * The prior default charged `makerAdjustedSpreadCrossR: 1.00`, justified by a
 * chain of modeling (TRA-1599's parametric wedge, doubled into the 25%-premium R
 * basis by TRA-1603) that no one had ever checked against a quote. TRA-1656
 * checked it, two ways, and it fails both:
 *
 *  1. STRUCTURALLY INFEASIBLE. The round-trip cross obeys the identity
 *     `spreadCrossR = (ask − bid) / (0.25·mark) = 4 · spreadPct`, and the
 *     scanners hard-reject `spreadPct` above 0.20 (OTM) / 0.10 (RV) BEFORE a
 *     contract can be selected. So no admissible contract can cross above 0.80R
 *     (OTM) or 0.40R (RV) — see `SLEEVE_SPREAD_CEILINGS` in `option-spread-cost.ts`.
 *     A 1.00R input bills every candidate MORE than the worst contract the
 *     scanner is even allowed to buy. That is refutable at n=0.
 *  2. MEASURED 4–6× TOO HIGH. Over 38 days of recorded chains, restricted to each
 *     sleeve's admissible universe: OTM mean 0.235R (n=222,026), RV mean 0.160R
 *     (n=94,548).
 *
 * `makerAdjustedSpreadCrossR` is a SINGLE knob across every options sleeve, so a
 * blended value must be conservative: we take the OTM (worse) 0.235R and apply it
 * to all of them. It overcharges RV by ~0.075R — QuantTrader's call (TRA-1661),
 * deliberate.
 *
 * ── The floor must move WITH the cost input ───────────────────────────────────
 * {@link admissionBarR} returns `max(costModel + margin, optionsMinGrossR)`, so
 * the floor PINS the bar: left at 1.20 it would hold the effective bar at 1.20R
 * no matter what the spread cross says, and the measured input would be entirely
 * inert — the gate would read as "retuned" while behaving identically. The 1.20
 * floor was itself derived from the phantom 1.00R input (TRA-1603 decision #3),
 * so it comes down with it. 0.30 keeps a non-binding backstop against a future
 * cost-input collapse admitting everything. If you retune the cost inputs, CHECK
 * THE FLOOR — moving one knob alone is a no-op in the binding direction.
 *
 * FLOOR CHECKED for the TRA-4890 commission retune, both configs that exist:
 * shipped bar 0.4386R > 0.30, and the LIVE bqb1 bar 0.3386R > 0.30 (bqb1 sets
 * `OPTION_COST_GATE_SAFETY_MARGIN_R=0.10`, measured on the host 2026-09-25, so
 * its bar is 0.0036 + 0.235 + 0.10, not the shipped 0.4386). The floor does not
 * pin in either, so the retune is live-effective rather than inert — which is
 * the direction that needed checking, because an inert retune would have read
 * as "shipped" while behaving identically.
 *
 * ⚠ bqb1 sets SAFETY_MARGIN_R but does NOT set `OPTION_COST_GATE_COMMISSION_R`
 * (measured against the host's env list, same date). That is why this constant
 * is load-bearing on the host at all: had the env override been present it would
 * win over this default and the code change would be a no-op there.
 *
 * Effective bar 0.4386R ⇒ admits at `3·|delta| − 1 ≥ 0.4386`, i.e. |delta| ≥ ~0.48.
 * Note the delta-slope in that estimator is itself unvalidated and is what
 * TRA-1647 grades next off the `byDelta` journal rollup; this config fixes the
 * COST side only.
 */
export const DEFAULT_COST_GATE_CONFIG: CostGateConfig = {
  optionsCost: { commissionR: 0.0036, makerAdjustedSpreadCrossR: 0.235 },
  equityCost: { commissionR: 0.0, makerAdjustedSpreadCrossR: 0.02 },
  safetyMarginR: 0.2,
  optionsMinGrossR: 0.3,
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

/**
 * TRA-3391 — the per-candidate ingredients the open sites hand the gate, after
 * the delta-proxy estimator was retired.
 *
 * `targetPrice` / `riskRewardRatio` are GONE with it: they existed only to build
 * `rewardR = (target − mark)/(mark − stop)`, and QuantTrader measured that the
 * mark·1.5 / mark·0.75 bracket resolves 30.8% of closes, so the reward multiple
 * was never a property of the trades. What survives is what the tape-calibrated
 * decision and the net-edge cost side actually consume: the premium, the |delta|
 * that keys the cell, and the stop that defines the R the cost is measured in.
 */
export interface CostGateCandidateInputs {
  /** Option premium mid (per share) — the candidate's `mark`. */
  mark: number;
  /** Signed Black-Scholes delta; only the magnitude is used (it keys the cell). */
  delta: number;
  /** Stop-loss premium (per share). Absent on the directional path. */
  stopPrice?: number;
}

// ── TRA-3391 — where the admit/reject decision went ──────────────────────────
//
// `admitByCostAwareGate(modeledGrossR, structure, config)` and its
// `costGateBlockReasonCode` classifier lived here and were DELETED with the
// estimator that fed them. Both took a `modeledGrossR` that nothing computes any
// more: TRA-3388 Ruling 2 retired `3·|delta| − 1` as an estimate of an expectancy
// under an exit policy this sleeve does not use.
//
// The decision now lives in `option-tape-expectancy.ts`
// (`tapeExpectancyVerdict`), which compares the LOWER 95% CI BOUND of the
// candidate's measured `structure × |delta| bucket` cell against
// {@link admissionBarR} — the same bar, the same R unit, a measured edge instead
// of a modelled one. What stays HERE is the COST side, which the ruling did not
// touch: the bar, its composition, and the env resolver.
//
// They are deleted rather than deprecated on purpose. An exported admission
// primitive that still compiles is one import away from being wired back in, and
// nothing in its signature would say the number it wants no longer exists.

// ── TRA-3216: making a 99.15% block rate DIAGNOSABLE ─────────────────────────
//
// Over 5 armed live sessions the live cost bar evaluated 1528 OTM candidates and
// blocked 1515 of them. `byScope` could only ever answer `single_leg_otm`, and
// the verdict's `reason` is per-candidate prose carrying that candidate's own
// numbers — fold on it and you get 1515 buckets of size 1. Neither says
// whether the bar is off by a hair or by a mile, so the only way to retune it was
// to guess and redeploy.
//
// Note what is NOT a useful split here: "which cost term dominated the BAR"
// (commission vs spread cross vs safety margin vs the min-gross floor) is a
// property of the CONFIG, identical on all 1515 rows — a constant column. That
// belongs in the arm block of the health payload, published ONCE
// ({@link describeCostGateBar}), not in a per-decision fold.
//
// The informative axis is the CANDIDATE side: the shortfall distribution. It
// answers the question an operator actually has — "if I drop the bar 0.10R, how
// many of these come back?" — off recorded data instead of a live experiment.

/**
 * Bucket boundaries (in R) for the shortfall classification. Chosen so the first
 * bucket is roughly one safety-margin's worth of retune and the last is "no
 * plausible retune reaches these".
 *
 * The classifier that consumes them moved to `option-tape-expectancy.ts` with the
 * decision itself (TRA-3391); the EDGES stay here because they are read against
 * {@link admissionBarR}, which is this module's number. Keeping the vocabulary
 * identical is deliberate: the live ledger's `byReason` axis has a multi-session
 * history in these exact keys and a rename would silently reset it.
 */
export const COST_GATE_SHORTFALL_BUCKETS_R: readonly number[] = [0.1, 0.25, 0.5];

/** The resolved bar and its composition — the CONSTANT half of "why did it block". */
export interface CostGateBarDescription {
  structure: string;
  /** The bar a candidate of this structure must clear. */
  barR: number;
  costModelR: number;
  commissionR: number;
  spreadCrossR: number;
  safetyMarginR: number;
  minGrossR: number;
  /**
   * TRUE ⇒ `optionsMinGrossR` sits at or above `costModel + margin` and PINS the
   * bar, which makes the measured cost inputs inert: retuning commission or
   * spread cross alone changes nothing. The docstring on
   * {@link DEFAULT_COST_GATE_CONFIG} warns about exactly this; publishing it
   * removes the need to re-derive it by hand from four separate env vars.
   */
  barPinnedByFloor: boolean;
  /** Which single input contributes the most to the bar (`min_gross_floor` when pinned). */
  dominantTerm: 'min_gross_floor' | 'spread_cross' | 'commission' | 'safety_margin';
}

/** Describe the effective bar for `structure` under `config`. Pure. */
export function describeCostGateBar(
  structure: string,
  config: CostGateConfig = DEFAULT_COST_GATE_CONFIG,
): CostGateBarDescription {
  const cost = isEquityStructure(structure) ? config.equityCost : config.optionsCost;
  const costModelR = structureCostR(cost);
  const modelBar = costModelR + config.safetyMarginR;
  const barR = admissionBarR(structure, config);
  const barPinnedByFloor = !isEquityStructure(structure) && config.optionsMinGrossR >= modelBar;
  const terms: Array<[CostGateBarDescription['dominantTerm'], number]> = [
    ['spread_cross', cost.makerAdjustedSpreadCrossR],
    ['commission', cost.commissionR],
    ['safety_margin', config.safetyMarginR],
  ];
  terms.sort((a, b) => b[1] - a[1]);
  return {
    structure,
    barR,
    costModelR,
    commissionR: cost.commissionR,
    spreadCrossR: cost.makerAdjustedSpreadCrossR,
    safetyMarginR: config.safetyMarginR,
    minGrossR: config.optionsMinGrossR,
    barPinnedByFloor,
    dominantTerm: barPinnedByFloor ? 'min_gross_floor' : terms[0][0],
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
