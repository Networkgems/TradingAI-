// TRA-4749 (parent TRA-4622 §4) — THE BAR EVERY GATED STRUCTURE ACTUALLY FACES.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `/api/health/live-enforce-gates` published `arm.costBar.bar` as ONE object,
// built by a literal:
//
//     const otmBar = describeCostGateBar('single_leg_otm', resolveCostGateConfig(env));
//
// and `arm.costBar.edge.otmCells` was likewise `cells.filter(c => c.structure === 'single_leg_otm')`.
// Both are correct and both are SCOPED, and nothing on the payload said to what.
// Meanwhile the retained ledger recorded a SECOND structure being refused by the
// same gate: `single_leg_rv`, 633 evaluated, **633 blocked, blockRate 1.000**,
// with a fully-populated `byCell` row (`single_leg_rv::0.55-1.00`) — refused by a
// bar that appeared nowhere on the surface. The sleeve owner could not tell
// whether RV was refused for a legitimate reason or because it was charged an
// OTM-shaped spread cost it does not incur (RV measured `costR` p50 **0.1645**
// against the published `costModelR` **0.285**), and that ambiguity is what made
// the whole RV sleeve verdict unrulable.
//
// ── WHAT THE CODE ACTUALLY DOES (the answer this module publishes) ───────────
// `admissionBarR(structure, config)` branches on EXACTLY ONE predicate,
// `isEquityStructure(structure)`. There is no `single_leg_rv` case, no
// per-structure cost table, and no unscoped fallback: every options sleeve —
// `single_leg_otm`, `single_leg_rv`, `single_leg_directional`, and anything
// unrecognised — is charged `config.optionsCost`, i.e. the SAME bar, to the
// last bit. So `single_leg_rv` faces `single_leg_otm`'s bar because they are
// one number, not two that happen to agree today.
//
// That is deliberate and documented: `makerAdjustedSpreadCrossR` is a SINGLE
// knob across every options sleeve, and `DEFAULT_COST_GATE_CONFIG`'s docstring
// records QuantTrader's TRA-1661 call to blend it conservatively onto the OTM
// (worse) measurement, "overcharg[ing] RV by ~0.075R". The defect closed here is
// that the blend was invisible on the surface a reader grades the sleeve from,
// NOT that the blend is wrong — retuning it is a nomination decision and is
// explicitly out of scope for this ticket.
//
// ⛔ PURE + READ-ONLY. No env, no I/O, no state, and nothing here is on the
// admission path. It renames nothing and moves no number: `describeCostGateBar`
// is the same function the single published `bar` has always been built by, so a
// structure's entry here is byte-identical to what `bar` would render for it.

import {
  describeCostGateBar,
  isEquityStructure,
  type CostGateBarDescription,
  type CostGateConfig,
} from './option-cost-gate.js';
import { canonicalTapeStructure } from './option-tape-expectancy.js';

/**
 * The structure the single pre-TRA-4749 `arm.costBar.bar` was hard-coded to.
 * Kept as a named constant so `barIdenticalToOtm` below is read against the same
 * literal the route publishes, not a second copy that could drift from it.
 */
export const COST_BAR_PUBLISHED_STRUCTURE = 'single_leg_otm';

/**
 * The gate that APPLIES this bar, and therefore the ONLY ledger gate whose
 * `byScope[].scope` can name a structure it charges.
 *
 * ⚠️ `scope` is not one axis across the live-enforce ledger. `cost_bar` scopes
 * by STRUCTURE (`single_leg_otm`, `single_leg_rv`); `universe` scopes by
 * SYMBOL (`AAPL`, `ABBV`, …). The first cut of this module was handed every
 * gate's scopes and published several hundred per-ticker "bars" — each one the
 * conservative `isEquityStructure`-false fallback rendered as if a ticker were
 * a sleeve. Caught on the first live read after deploy, 2026-09-20.
 */
export const COST_BAR_GATE = 'cost_bar';

/** Where a structure was OBSERVED — i.e. why it is on this list at all. */
export type GatedStructureSource =
  /** It is the structure `arm.costBar.bar` has always published. Always present. */
  | 'published_bar'
  /** The retained live-enforce ledger recorded at least one decision under it. */
  | 'ledger_scope'
  /** The tape-expectancy fold holds at least one cell for it. */
  | 'expectancy_cell';

/**
 * One structure's resolved bar, plus the provenance a reader needs to know it is
 * not a hypothetical: `sources` says this structure was seen in live recorded
 * state, and `scopeLabels` names the raw strings that fold onto it.
 */
export interface GatedStructureBar extends CostGateBarDescription {
  /** Why this structure is published — never an invented enumeration. */
  sources: GatedStructureSource[];
  /**
   * The RAW labels observed in the ledger / cache that canonicalize onto
   * `structure`. `directional` and `single_leg_directional` are one sleeve under
   * two names (`canonicalTapeStructure`), and the gate bars the CANONICAL one —
   * so publishing only the canonical key would leave a reader holding a
   * `byScope: "directional"` row unable to find its bar.
   */
  scopeLabels: string[];
  /**
   * WHICH of the two cost-input sets in `CostGateConfig` fed this bar. This is
   * the whole of `admissionBarR`'s structure-sensitivity: `equity` ⇒
   * `config.equityCost` and NO floor; `options` ⇒ `config.optionsCost` and the
   * `optionsMinGrossR` floor. There is no third case and no per-sleeve table.
   */
  costInputs: 'options' | 'equity';
  /**
   * ⭐ The one-field answer to "is this sleeve charged the OTM bar?".
   * TRUE ⇒ every number in this entry equals the published
   * `single_leg_otm` bar, because `admissionBarR` never distinguished them.
   */
  barIdenticalToOtm: boolean;
}

function dedupePush(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Resolve the bar for every structure this gate is OBSERVED to charge, under
 * `config`.
 *
 * The input is deliberately live recorded state (ledger scopes + folded cells)
 * rather than a hard-coded sleeve roster: a roster is exactly how
 * `single_leg_rv` went unpublished for 633 refusals while sitting in plain sight
 * one key over in `byScope`. A sleeve that starts trading tomorrow appears here
 * on its first recorded decision with no code change.
 *
 * `COST_BAR_PUBLISHED_STRUCTURE` is always included even at zero observations,
 * so the array is never empty and `bar` always has a counterpart here.
 */
export function resolveGatedStructureBars(input: {
  /** Raw `byScope[].scope` labels from the retained live-enforce ledger. */
  scopeLabels: readonly string[];
  /** Raw `structure` values from the folded tape-expectancy cells. */
  cellStructures: readonly string[];
  config: CostGateConfig;
}): GatedStructureBar[] {
  const byStructure = new Map<string, { sources: GatedStructureSource[]; scopeLabels: string[] }>();
  const observe = (raw: string, source: GatedStructureSource): void => {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const canonical = canonicalTapeStructure(trimmed);
    let entry = byStructure.get(canonical);
    if (entry === undefined) {
      entry = { sources: [], scopeLabels: [] };
      byStructure.set(canonical, entry);
    }
    if (!entry.sources.includes(source)) entry.sources.push(source);
    dedupePush(entry.scopeLabels, trimmed);
  };

  observe(COST_BAR_PUBLISHED_STRUCTURE, 'published_bar');
  for (const s of input.scopeLabels) observe(s, 'ledger_scope');
  for (const s of input.cellStructures) observe(s, 'expectancy_cell');

  const otmBarR = describeCostGateBar(COST_BAR_PUBLISHED_STRUCTURE, input.config).barR;
  return [...byStructure.entries()]
    .map(([structure, { sources, scopeLabels }]) => {
      const bar = describeCostGateBar(structure, input.config);
      return {
        ...bar,
        sources,
        scopeLabels: [...scopeLabels].sort(),
        costInputs: isEquityStructure(structure) ? ('equity' as const) : ('options' as const),
        barIdenticalToOtm: bar.barR === otmBarR,
      };
    })
    // The published structure first (it is the one every existing reader knows),
    // then alphabetical — a stable order so a diff of two probes is meaningful.
    .sort((a, b) => {
      if (a.structure === COST_BAR_PUBLISHED_STRUCTURE) return -1;
      if (b.structure === COST_BAR_PUBLISHED_STRUCTURE) return 1;
      return a.structure.localeCompare(b.structure);
    });
}
