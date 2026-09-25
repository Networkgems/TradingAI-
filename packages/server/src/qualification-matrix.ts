/**
 * TRA-4889 (parent TRA-4885, board item 5) — the COST / EDGE / DATA triage, one
 * row per tape cell.
 *
 * ## Why this exists
 *
 * All three answers already ship. None of them ship TOGETHER:
 *
 *   • `/api/health/live-enforce-gates` → `byGate[cost_bar]` — what the live gate
 *     DID, plus the `netEdgeShadow` k-sweep counterfactual.
 *   • `/api/health/cost-aware-gate` — the bar's COMPOSITION.
 *   • `/api/health/option-expectancy-table` — per-cell `admits` / `lowerCI95` /
 *     `nRealFill`.
 *
 * An operator asking the only question that matters — "is it cost, is it edge, or
 * is it not enough data?" — has to know all three route names and reconcile them
 * by hand. TRA-4885 was filed precisely because somebody did that by hand and
 * wanted the answer published instead.
 *
 * ## ⚠️ STRICTLY DIAGNOSTIC. THIS IS NOT A FOURTH GATE.
 *
 * Nothing here decides anything. The board's item 5 is to SEPARATE diagnostics
 * from enforcement, not to add an enforcement surface. This module is PURE, takes
 * every input by injection, and has no edge to the ledger, the cache, or the trade
 * path. If a future caller wires a verdict off `resolvedReason`, that is the bug
 * this paragraph exists to name.
 *
 * ## The reading this view makes possible, and which no single route above does
 *
 * Measured on bqb1 `a158c516`, ET day 2026-09-24: the `cost_bar` gate blocked
 * 3039 of 3039 live evaluations, and `netEdgeShadow` admits **0 at every `k`,
 * including `k` so loose it prices no cost at all**. The natural reading of a gate
 * literally named `cost_bar`, with reason codes literally named `shortfall_*`, is
 * "cost is too high".
 *
 * That reading is WRONG, and this view is what makes it wrong on its face. The
 * deployed form is FLAT (`admit ⟺ grossR >= barR`, TRA-4745) and `grossR` is the
 * cell's own `lowerCI95` — which on all three live-nominated cells is NEGATIVE
 * (`single_leg_otm::0.30-0.40` = −0.2154). A negative edge bound fails at EVERY
 * bar setting including OFF, and makes `costR <= k · grossR` unsatisfiable at
 * every `k` — so the k-sweep's flat zero is a restatement of the EDGE term, not a
 * measurement of the cost term. Cost is not binding; cost is not even reachable.
 *
 * Hence {@link QualificationCostColumn.admitsAtBarOff}: a cost column that cannot
 * distinguish "the bar is too tight" from "no bar could help" is the same
 * instrument-reads-identically defect the gate had before this view.
 *
 * ## `nextBindingReason`, and why one reason per cell is not enough
 *
 * A single resolved reason invites exactly one wrong move: clear it, redeploy,
 * discover the next constraint, repeat. `single_leg_otm::0.50-0.55` is the live
 * proof — it fails EDGE at the live bar (`lowerCI95` 0.3617 < `barR` 0.385, a gap
 * of 0.023 that the ratified 0.10 safety margin alone accounts for), and the
 * instant a retune cleared that it would be held by DATA (`nRealFill` 5 < 40,
 * TRA-4894). So every row publishes the ORDERED list of everything failing, with
 * `resolvedReason` as its head and `nextBindingReason` as its second element.
 *
 * ## `canAccrue`, and the deadlock
 *
 * `nRealFill < minCellRealFillN` reads IDENTICALLY whether evidence is accruing or
 * the population can never grow. Real-fill rows are produced by live broker fills;
 * live fills require the entry gate to admit; the entry gate admits nothing. That
 * is a closed loop, and on a level-only read it looks like patience. Measure the
 * RATE, not the level — {@link QualificationDataColumn.canAccrue} is `false` with
 * a named reason whenever the cell's own live admit rate is zero.
 */

import {
  canonicalTapeStructure,
  tapeExpectancyCellKey,
  type TapeExpectancyCell,
} from './option-tape-expectancy.js';

/**
 * The `cost_bar` per-cell fold, structurally typed so this module keeps no import
 * edge onto `live-enforce-gate-ledger.ts`. The caller passes
 * `byGate[cost_bar].byCell`; every field here is a prefix of
 * `LiveEnforceCellSummary`.
 */
export interface QualificationGateCell {
  /** `structure::bucket` as the GATE stamped it — may carry a structure alias. */
  cell: string;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
}

/**
 * One structure's bar composition, from `arm.costBar.barsByStructure` on
 * `/live-enforce-gates`.
 *
 * PER STRUCTURE, never a single scalar: TRA-4749 shipped precisely because `bar`
 * was scoped to `single_leg_otm` by a literal and nothing said so, so an
 * OTM-shaped cost read as if it had been charged to `single_leg_rv`. A view whose
 * whole job is "which of cost/edge binds" must not re-import that bug.
 */
export interface QualificationBar {
  /** Canonicalised on the way in — `directional` folds to `single_leg_directional`. */
  structure: string;
  barR: number;
  costModelR: number | null;
  safetyMarginR: number | null;
  /** The bar's FLOOR. `barR = max(costModelR + safetyMarginR, minGrossR)`. */
  minGrossR: number | null;
}

/** The fold-level k-sweep, CITED verbatim. Never recomputed here. */
export interface QualificationNetEdgeShadow {
  rowsEvaluated: number;
  flatFormAdmits: number;
  sweep: readonly { k: number; admits: number; admitRate: number | null }[];
}

export interface QualificationMatrixInputs {
  etDay: string;
  /**
   * The expectancy table's cells, or `null` when the tape has never folded in
   * this process. `null` is BLIND — see {@link QualificationMatrix.overall}.
   */
  cells: readonly TapeExpectancyCell[] | null;
  minCellN: number;
  minCellRealFillN: number;
  /**
   * `byGate[cost_bar].byCell` over whichever window the caller chose. Pass the
   * RETAINED fold, not the day fold: a per-day cell axis self-clears at ET
   * midnight (TRA-1703), and "this cell has never been admitted" is a claim about
   * the window, so a one-day window would manufacture `canAccrue: false` on a
   * cell that was admitted yesterday.
   */
  gateCells: readonly QualificationGateCell[];
  /**
   * ⭐ The PER-ET-DAY cell axis (`byGate[cost_bar].byEtDay[].byCell[]`), which is
   * what makes {@link QualificationDataColumn.canAccrue} a RATE instead of a
   * LEVEL. Without it, "this cell was admitted at some point in the 30-day
   * window" reads as "evidence is accruing" — and on the live fold that
   * sentence is TRUE of `single_leg_otm::0.50-0.55` on the strength of 428
   * admits that all landed on 2026-08-28 / 08-31 / 09-01 and nothing since.
   * The pooled axis alone cannot tell a live cell from a dead one.
   */
  gateCellDays: readonly { etDay: string; cell: string; evaluated: number; blocked: number }[];
  /** The window `gateCells` was folded over, published so the claim has a scope. */
  gateWindowEtDays: readonly string[];
  gateEvaluated: number | null;
  gateBlocked: number | null;
  netEdgeShadow: QualificationNetEdgeShadow | null;
  /**
   * The bar composition PER STRUCTURE. A cell whose structure is absent here
   * still gets a row — graded against its own `cell.barR`, with the composition
   * fields `null` — because dropping it would hide exactly the sleeve TRA-4749
   * found unpublished.
   */
  bars: readonly QualificationBar[];
  /** `arm.costBar.netEdge.enabled` — false ⇒ the sweep is a RECORDER, not the form. */
  netEdgeFormEnabled: boolean;
}

/**
 * The reason codes, in PRECEDENCE order. `resolvedReason` is the first that
 * fires.
 *
 * ⚠️ These are THIS VIEW's codes and are deliberately NOT the enforcement
 * surface's `reasonCode` strings. `insufficient_real_fill_evidence` in particular
 * means something narrower on the expectancy route (it fires only when the pooled
 * arm PASSES); here every failing check is listed independently, because a
 * short-circuiting ladder is exactly what hides `nextBindingReason`. Read
 * `heldByRealFillArm` for the enforcement-surface meaning.
 */
export type QualificationReason =
  | 'insufficient_evidence'
  | 'edge_unmeasurable'
  | 'no_bar_setting_admits'
  | 'edge_below_cost_bar'
  | 'insufficient_real_fill_evidence'
  | 'cost_bar_live_block';

/** The ladder, published as DATA so a reader never has to infer the precedence. */
export const QUALIFICATION_LADDER: readonly {
  reason: QualificationReason;
  column: 'cost' | 'edge' | 'data';
  test: string;
  meaning: string;
}[] = [
  {
    reason: 'insufficient_evidence',
    column: 'data',
    test: 'n < minCellN',
    meaning:
      'We never measured this cell. NOT a measured loser — every edge number below it is noise at this n and must not be quoted as a finding (TRA-3388 Ruling 2.5).',
  },
  {
    reason: 'edge_unmeasurable',
    column: 'edge',
    test: 'lowerCI95 === null',
    meaning:
      'No standard error exists (n < 2), so the decision rule has no left-hand side. Distinct from a bound that exists and is bad.',
  },
  {
    reason: 'no_bar_setting_admits',
    column: 'edge',
    test: 'lowerCI95 <= 0',
    meaning:
      'THE COST BAR IS NOT THE BINDING TERM. The deployed flat form admits iff lowerCI95 >= barR, so a non-positive bound fails at every bar setting INCLUDING OFF; and costR <= k*lowerCI95 is unsatisfiable at every k, which is what a flat-zero netEdgeShadow sweep is actually reporting. Retuning the bar cannot move this cell.',
  },
  {
    reason: 'edge_below_cost_bar',
    column: 'cost',
    test: '0 < lowerCI95 < barR',
    meaning:
      'The measured edge is positive but smaller than the modelled round-trip cost plus the ratified safety margin. THIS is the cell where the bar setting is a real lever — read maxAdmittingBarR and the per-setting pass flags.',
  },
  {
    reason: 'insufficient_real_fill_evidence',
    column: 'data',
    test: 'nRealFill < minCellRealFillN',
    meaning:
      'Too few rows carry broker truth on BOTH legs (TRA-4894). Read canAccrue BEFORE reading this as "accruing": a cell the live gate blocks 100% of cannot produce another real fill, ever.',
  },
  {
    reason: 'cost_bar_live_block',
    column: 'cost',
    test: 'every check above passes AND the live gate blocked every evaluation',
    meaning:
      'The only state in which the live cost gate is genuinely the binding constraint on a cell that otherwise qualifies. Nothing has ever reached it.',
  },
];

/** Which named bar setting would admit this cell. All DERIVED, none measured. */
export interface QualificationBarSetting {
  /** `live` | `without_safety_margin` | `min_gross_floor` | `off`. */
  setting: string;
  /** The bar value that setting implies, or null when its input is unpublished. */
  barR: number | null;
  /** `lowerCI95 >= barR`; null when either side is unknown. */
  admits: boolean | null;
}

export interface QualificationCostColumn {
  /** The DEPLOYED form. `flat` ⇒ `admit ⟺ grossR >= barR` (TRA-4745). */
  form: 'flat' | 'net_edge';
  barR: number | null;
  costModelR: number | null;
  safetyMarginR: number | null;
  minGrossR: number | null;
  /**
   * `false` ⇒ this structure publishes no bar composition, so `barR` fell back to
   * the cell's own recorded bar and the `without_safety_margin` / `min_gross_floor`
   * settings read `null`. Published rather than implied: an unpublished sleeve
   * silently inheriting the OTM composition is the TRA-4749 defect.
   */
  barCompositionPublished: boolean;
  /** `lowerCI95 >= barR` at the LIVE bar. */
  passesAtLiveBar: boolean | null;
  /**
   * DERIVED, not measured: the HIGHEST bar setting that would admit this cell is
   * its own `lowerCI95` (admit ⟺ barR <= lowerCI95). Null when the bound is null.
   * Negative ⇒ no admissible bar exists, which is the point of publishing it
   * signed rather than clamping it at zero.
   */
  maxAdmittingBarR: number | null;
  /**
   * `false` ⇒ NOT EVEN `barR = 0` ADMITS. The single most load-bearing field on
   * this route: it is the only thing separating "the bar is too tight" from "the
   * bar is irrelevant", which the gate's own counters cannot distinguish.
   */
  admitsAtBarOff: boolean | null;
  /** The named settings, so an operator sees the lever without doing arithmetic. */
  barSettings: QualificationBarSetting[];
  /**
   * The fold-level k-sweep, CITED. It is a per-FOLD number, never per-cell — a
   * cell-scoped sweep is not published by any surface and is NOT reconstructed
   * here. `netEdgeFormEnabled: false` ⇒ this describes a form that is not running.
   */
  netEdgeShadowCitation: {
    netEdgeFormEnabled: boolean;
    rowsEvaluated: number;
    flatFormAdmits: number;
    admitsAtEveryK: boolean;
    kRange: [number, number] | null;
    /**
     * Why the sweep reads flat FOR THIS CELL. On `lowerCI95 <= 0` the sweep is
     * arithmetically unable to admit at any k, so its zero says nothing about
     * cost — reporting that is the whole reason this field is not a number.
     */
    interpretation: string;
  } | null;
}

export interface QualificationEdgeColumn {
  n: number;
  meanR_gate: number;
  lowerCI95: number | null;
  barR: number;
  /** `barR − lowerCI95` — the same quantity the gate's `shortfall_*` buckets hold. */
  shortfallR: number | null;
  admitsPooled: boolean;
  /**
   * TRA-4578 — the same bound with this cell's own measured round-trip cost
   * charged to rows booked at the mid. A COMPANION: `admitsPooled` is still
   * decided by `lowerCI95` alone. Null ⇒ no measured cost for this cell, NOT zero.
   */
  lowerCI95_netOfModelledCross: number | null;
  netOfModelledCrossWouldAdmit: boolean | null;
  /** `n < minCellN` ⇒ every number in this column is underpowered, not a finding. */
  underpowered: boolean;
}

export interface QualificationDataColumn {
  n: number;
  minCellN: number;
  pooledSufficient: boolean;
  nRealFill: number;
  minCellRealFillN: number;
  realFillSufficient: boolean;
  admitsRealFill: boolean;
  /** The enforcement surface's narrow meaning: pooled PASSES and real-fill HOLDS. */
  heldByRealFillArm: boolean;
  realFillUnavailableReason: string | null;
  /** Rows in this cell by journal mode, e.g. `{ demo: 93, live: 17 }` (TRA-4578). */
  byMode: Readonly<Record<string, number>> | null;
  /**
   * Can this cell's real-fill population GROW? `false` ⇒ `nRealFill` is FROZEN
   * and waiting is not a strategy. Null ⇒ the gate fold could not answer.
   *
   * ⚠️ ASYMMETRIC, and the asymmetry is the honest part. The cost bar is a
   * NECESSARY condition for a live fill, not a sufficient one — `spread`,
   * `universe`, `otm_delta_floor` and the budget gates all sit downstream, and
   * the admits counted here include demo books. So:
   *   • `false` is DEFINITIVE — this cell is blocked at the cost bar, so nothing
   *     downstream can rescue it.
   *   • `true` means only NOT BLOCKED HERE. It is not a forecast.
   * Read `realFillPerAdmit` beside it: a cell with many cost-bar admits and
   * almost no real fills is being eaten downstream, which is a different
   * finding from a cell the bar refuses.
   */
  canAccrue: boolean | null;
  canAccrueReason: string;
  /** The live gate's own numbers for this cell over the fold window. */
  liveEvaluated: number;
  liveBlocked: number;
  liveAdmitRate: number | null;
  /** The most recent ET day the gate DECIDED this cell. Null ⇒ never, in window. */
  lastNominatedEtDay: string | null;
  /** The most recent ET day the gate ADMITTED this cell. Null ⇒ never, in window. */
  lastAdmitEtDay: string | null;
  /** ET days in the window on which the gate decided / admitted this cell. */
  etDaysNominated: number;
  etDaysWithAdmits: number;
  /**
   * ET days the GATE RAN (on any cell) strictly after this cell's last
   * nomination. `> 0` ⇒ the cell is DORMANT: it is not being refused, it is not
   * being offered, and that is a SELECTION-side finding, not a gate verdict.
   * Counted in gate-active days, not calendar days, so a weekend or a halt does
   * not read as dormancy.
   */
  gateActiveEtDaysSinceLastNomination: number | null;
  /**
   * `nRealFill / liveAdmits`. Far below 1 ⇒ the cost bar is admitting and
   * something DOWNSTREAM is consuming the admits; that is not a cost-bar
   * finding and must not be reported as one. Null when nothing was admitted.
   */
  realFillPerAdmit: number | null;
}

export interface QualificationRow {
  cellKey: string;
  structure: string;
  bucket: string;
  /** `false` ⇒ the live gate has never decided this cell in the fold window. */
  liveNominated: boolean;
  cost: QualificationCostColumn;
  edge: QualificationEdgeColumn;
  data: QualificationDataColumn;
  /** EVERY failing check, in ladder precedence order. Empty ⇒ the cell qualifies. */
  blockingReasons: QualificationReason[];
  /** `blockingReasons[0]`, or `null` when the cell qualifies. */
  resolvedReason: QualificationReason | null;
  /** `blockingReasons[1]` — what blocks it the instant `resolvedReason` is cleared. */
  nextBindingReason: QualificationReason | null;
  /** One sentence, so the row is readable without the schema. */
  narrative: string;
}

export interface QualificationMatrix {
  etDay: string;
  /** `blind` ⇒ the expectancy tape has never folded; NOT a clean bill. */
  overall: 'blind' | 'none_qualify' | 'some_qualify';
  minCellN: number;
  minCellRealFillN: number;
  gateWindowEtDays: string[];
  /** Per-structure bar composition, canonicalised. Never a single scalar (TRA-4749). */
  bars: QualificationBar[];
  rows: QualificationRow[];
  /** Count of rows per `resolvedReason`, so the shape is readable at a glance. */
  byResolvedReason: { reason: QualificationReason | 'qualifies'; cells: number }[];
  /**
   * The closed loop, named. `realFillFrozen: true` ⇒ no cell can accrue another
   * real fill, so no amount of waiting moves TRA-4894's arm and the escape is
   * EXECUTION, not thresholds.
   */
  accrual: {
    liveEvaluated: number | null;
    liveBlocked: number | null;
    liveAdmitRate: number | null;
    /**
     * The window's most recent ET day carrying ANY admit. This is what stops a
     * pooled admit count reading as current: on the live fold the retained
     * window holds 428 admits and the newest of them is 23 days old.
     */
    lastAdmitEtDay: string | null;
    realFillFrozen: boolean | null;
    reason: string;
  };
  /** Join residue, published rather than dropped — never a silent zero. */
  join: {
    /** Gate cells with no expectancy row. */
    cellsOnlyInGate: string[];
    /** Expectancy rows the live gate has never decided. */
    cellsOnlyInTable: string[];
    /** Gate cell keys whose structure half needed canonicalising to join. */
    cellsCanonicalised: { from: string; to: string }[];
  };
  ladder: typeof QUALIFICATION_LADDER;
  note: string;
}

/** `structure::bucket` with the structure half canonicalised (`directional` → `single_leg_directional`). */
function canonicalCellKey(cell: string): string {
  const i = cell.indexOf('::');
  if (i < 0) return cell;
  return tapeExpectancyCellKey(canonicalTapeStructure(cell.slice(0, i)), cell.slice(i + 2));
}

function round(x: number | null | undefined, dp = 6): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/**
 * PURE. Builds the cost / edge / data triage. Decides nothing, reads nothing,
 * writes nothing.
 */
export function buildQualificationMatrix(input: QualificationMatrixInputs): QualificationMatrix {
  const { minCellN, minCellRealFillN } = input;

  // Bars, canonicalised onto the same structure namespace the cells use. Without
  // this an `arm.costBar.barsByStructure` entry labelled `directional` would miss
  // every `single_leg_directional` cell and silently fall back.
  const barByStructure = new Map<string, QualificationBar>();
  for (const b of input.bars) {
    barByStructure.set(canonicalTapeStructure(b.structure), { ...b, structure: canonicalTapeStructure(b.structure) });
  }

  // Fold the gate axis onto canonical keys FIRST. A gate-side alias that fails to
  // join reads as `liveNominated: false`, which is the same string a genuinely
  // never-nominated cell produces — so the canonicalisation is recorded, not
  // assumed (this is the join the expectancy route's `note` tells a human to do
  // by hand, and doing it by hand is what this ticket is removing).
  const gateByKey = new Map<string, QualificationGateCell>();
  const cellsCanonicalised: { from: string; to: string }[] = [];
  for (const g of input.gateCells) {
    const key = canonicalCellKey(g.cell);
    if (key !== g.cell) cellsCanonicalised.push({ from: g.cell, to: key });
    const prior = gateByKey.get(key);
    if (prior) {
      gateByKey.set(key, {
        cell: key,
        evaluated: prior.evaluated + g.evaluated,
        blocked: prior.blocked + g.blocked,
        blockRate:
          prior.evaluated + g.evaluated > 0
            ? (prior.blocked + g.blocked) / (prior.evaluated + g.evaluated)
            : null,
      });
    } else {
      gateByKey.set(key, { ...g, cell: key });
    }
  }

  // The per-ET-day cell axis, canonicalised on the SAME rule as the pooled axis
  // (two canonicalisers would be two chances to disagree) and sorted ascending so
  // "last" means last.
  const cellDays = new Map<string, { etDay: string; evaluated: number; blocked: number }[]>();
  for (const d of input.gateCellDays) {
    const key = canonicalCellKey(d.cell);
    const list = cellDays.get(key) ?? [];
    list.push({ etDay: d.etDay, evaluated: d.evaluated, blocked: d.blocked });
    cellDays.set(key, list);
  }
  for (const list of cellDays.values()) list.sort((a, b) => a.etDay.localeCompare(b.etDay));

  // Every ET day the gate decided ANYTHING, ascending. The last of these is the
  // anchor `canAccrue` is measured against, and it is what makes the verdict
  // THRESHOLD-FREE: "was this cell admitted on the most recent day the gate
  // actually ran?" needs no arbitrary staleness window to be answered.
  //
  // Anchoring on the CELL's own last nomination instead is the trap the live
  // fold walked into: `single_leg_otm::0.50-0.55` was admitted on every day it
  // appears, so "admitted on its latest nomination day" is TRUE — and its latest
  // nomination day is 2026-09-01, 23 ET days and 16 gate-active days ago. The
  // cell is dormant, and a cell-relative anchor calls that healthy.
  const foldActiveEtDays = [
    ...new Set(input.gateCellDays.filter((d) => d.evaluated > 0).map((d) => d.etDay)),
  ].sort();
  const foldLastActiveEtDay = foldActiveEtDays.length > 0 ? foldActiveEtDays[foldActiveEtDays.length - 1]! : null;
  const activeDaysAfter = (etDay: string): number =>
    foldActiveEtDays.filter((d) => d > etDay).length;

  const sweep = input.netEdgeShadow?.sweep ?? [];
  const admitsAtEveryK = sweep.length > 0 && sweep.every((s) => s.admits > 0);
  const admitsAtNoK = sweep.length > 0 && sweep.every((s) => s.admits === 0);
  const kRange: [number, number] | null =
    sweep.length > 0
      ? [Math.min(...sweep.map((s) => s.k)), Math.max(...sweep.map((s) => s.k))]
      : null;

  const rows: QualificationRow[] = [];
  const seenTableKeys = new Set<string>();

  for (const c of input.cells ?? []) {
    seenTableKeys.add(c.cellKey);
    const g = gateByKey.get(c.cellKey) ?? null;
    const liveEvaluated = g?.evaluated ?? 0;
    const liveBlocked = g?.blocked ?? 0;
    const liveAdmitRate =
      liveEvaluated > 0 ? (liveEvaluated - liveBlocked) / liveEvaluated : null;

    const lo = c.lowerCI95;
    const bar = barByStructure.get(canonicalTapeStructure(c.structure)) ?? null;
    // Fall back to the cell's OWN recorded bar, never to another sleeve's.
    const barR = bar?.barR ?? c.barR;

    // ---- cost column -------------------------------------------------------
    const settingValues: { setting: string; barR: number | null }[] = [
      { setting: 'live', barR: barR },
      {
        setting: 'without_safety_margin',
        barR:
          bar?.costModelR !== null && bar?.costModelR !== undefined ? bar.costModelR : null,
      },
      {
        setting: 'min_gross_floor',
        barR: bar?.minGrossR !== null && bar?.minGrossR !== undefined ? bar.minGrossR : null,
      },
      { setting: 'off', barR: 0 },
    ];
    const barSettings: QualificationBarSetting[] = settingValues.map((s) => ({
      setting: s.setting,
      barR: round(s.barR),
      admits: lo === null || s.barR === null ? null : lo >= s.barR,
    }));
    const admitsAtBarOff = lo === null ? null : lo >= 0;
    const passesAtLiveBar = lo === null ? null : lo >= barR;

    const interpretation =
      lo === null
        ? 'This cell has no edge bound, so no k can be evaluated against it.'
        : lo <= 0
          ? `VACUOUS FOR THIS CELL: grossR = lowerCI95 = ${round(lo)} <= 0, so \`costR <= k * grossR\` cannot hold for any k >= 0 at any non-negative cost. A flat-zero sweep here restates the EDGE term and says NOTHING about cost.`
          : admitsAtNoK
            ? `The fold-level sweep admits at no k, but that fold is dominated by cells with a non-positive bound; this cell's own bound is ${round(lo)} > 0, so the fold zero is NOT attributable to it. No per-cell sweep is published by any surface.`
            : `This cell's bound is ${round(lo)} > 0, so a k-sweep is meaningful for it; the published sweep is per-FOLD and cannot be attributed to a single cell.`;

    const cost: QualificationCostColumn = {
      form: input.netEdgeFormEnabled ? 'net_edge' : 'flat',
      barR: round(barR),
      costModelR: round(bar?.costModelR ?? null),
      safetyMarginR: round(bar?.safetyMarginR ?? null),
      minGrossR: round(bar?.minGrossR ?? null),
      barCompositionPublished: bar !== null,
      passesAtLiveBar,
      maxAdmittingBarR: round(lo),
      admitsAtBarOff,
      barSettings,
      netEdgeShadowCitation: input.netEdgeShadow
        ? {
            netEdgeFormEnabled: input.netEdgeFormEnabled,
            rowsEvaluated: input.netEdgeShadow.rowsEvaluated,
            flatFormAdmits: input.netEdgeShadow.flatFormAdmits,
            admitsAtEveryK,
            kRange,
            interpretation,
          }
        : null,
    };

    // ---- edge column -------------------------------------------------------
    const edge: QualificationEdgeColumn = {
      n: c.n,
      meanR_gate: round(c.meanR_gate) ?? c.meanR_gate,
      lowerCI95: round(lo),
      barR: round(c.barR) ?? c.barR,
      shortfallR: lo === null ? null : round(c.barR - lo),
      admitsPooled: c.admitsPooled,
      lowerCI95_netOfModelledCross: round(c.lowerCI95_netOfModelledCross),
      netOfModelledCrossWouldAdmit:
        c.lowerCI95_netOfModelledCross === null
          ? null
          : c.lowerCI95_netOfModelledCross >= c.barR,
      underpowered: c.n < minCellN,
    };

    // ---- data column -------------------------------------------------------
    // `canAccrue` is the LEVEL-vs-RATE discriminator, and it is keyed on the most
    // recent ET day the cell was NOMINATED — never on the pooled window.
    //
    // ⭐ The live fold is the reason. `single_leg_otm::0.50-0.55` holds 428 admits
    // over the retained 30 days, which on a pooled read says "admitting, evidence
    // accruing". All 428 landed on 2026-08-28 / 08-31 / 09-01; the cell has not
    // been nominated ONCE since, and every ET day from 09-02 on is 100% blocked
    // across every cell. A pooled read calls that healthy. It is not: the cell is
    // dead, and it is dead on the SELECTION side, not at the gate.
    const days = cellDays.get(c.cellKey) ?? [];
    const nominatedDays = days.filter((d) => d.evaluated > 0);
    const admitDays = days.filter((d) => d.evaluated - d.blocked > 0);
    const lastNominatedEtDay = nominatedDays.length > 0 ? nominatedDays[nominatedDays.length - 1]!.etDay : null;
    const lastAdmitEtDay = admitDays.length > 0 ? admitDays[admitDays.length - 1]!.etDay : null;

    let canAccrue: boolean | null;
    let canAccrueReason: string;
    if (input.gateCellDays.length === 0 && liveEvaluated === 0) {
      canAccrue = null;
      canAccrueReason =
        'UNREAD — no per-ET-day cell axis was supplied and the pooled axis holds nothing for this cell, so the accrual question was not answered. Absent is NOT zero.';
    } else if (lastNominatedEtDay === null) {
      canAccrue = false;
      canAccrueReason = `FROZEN (SELECTION SIDE) — the gate has NEVER decided this cell in the ${input.gateWindowEtDays.length}-ET-day window. Nothing is being nominated into it, so no bar setting and no threshold can produce a fill here. This is upstream of the gate, not a gate verdict.`;
    } else if (lastAdmitEtDay === null) {
      canAccrue = false;
      canAccrueReason = `FROZEN (GATE SIDE) — the gate decided this cell on ${nominatedDays.length} ET day(s), most recently ${lastNominatedEtDay}, and admitted it on NONE of them (${liveBlocked}/${liveEvaluated} blocked). No live entry ⇒ no live close ⇒ nRealFill cannot grow. Waiting does not move this.`;
    } else if (lastNominatedEtDay !== foldLastActiveEtDay) {
      canAccrue = false;
      canAccrueReason = `DORMANT (SELECTION SIDE) — this cell has not been nominated since ${lastNominatedEtDay}, and the gate has run on ${activeDaysAfter(lastNominatedEtDay)} ET day(s) since without ever seeing it (most recent ${foldLastActiveEtDay}). Its ${liveEvaluated - liveBlocked} pooled admit(s) are HISTORICAL — reading them as "accruing" is exactly the level-for-rate error this field exists to stop. The cell is not being refused; it is not being offered.`;
    } else if (lastAdmitEtDay !== lastNominatedEtDay) {
      canAccrue = false;
      canAccrueReason = `STALLED (GATE SIDE) — this cell last ADMITTED on ${lastAdmitEtDay} but was blocked throughout its most recent nomination day ${lastNominatedEtDay}. Its ${liveEvaluated - liveBlocked} pooled admit(s) are historical.`;
    } else {
      canAccrue = true;
      canAccrueReason = `NOT BLOCKED HERE — the gate nominated this cell on its most recent ACTIVE day (${foldLastActiveEtDay}) and admitted it there, ${liveEvaluated - liveBlocked}/${liveEvaluated} over the window. NOTE: the cost bar is NECESSARY, not sufficient — spread / universe / delta-floor / budget gates sit downstream, so this is not a forecast that nRealFill will grow.`;
    }

    const data: QualificationDataColumn = {
      n: c.n,
      minCellN,
      pooledSufficient: c.n >= minCellN,
      nRealFill: c.nRealFill,
      minCellRealFillN,
      realFillSufficient: c.nRealFill >= minCellRealFillN,
      admitsRealFill: c.admitsRealFill,
      heldByRealFillArm: c.admitsPooled && !c.admitsRealFill,
      realFillUnavailableReason: c.realFillUnavailableReason,
      byMode: c.provenance?.byMode ?? null,
      canAccrue,
      canAccrueReason,
      liveEvaluated,
      liveBlocked,
      liveAdmitRate: round(liveAdmitRate),
      lastNominatedEtDay,
      lastAdmitEtDay,
      etDaysNominated: nominatedDays.length,
      etDaysWithAdmits: admitDays.length,
      gateActiveEtDaysSinceLastNomination:
        lastNominatedEtDay === null ? null : activeDaysAfter(lastNominatedEtDay),
      realFillPerAdmit:
        liveEvaluated - liveBlocked > 0 ? round(c.nRealFill / (liveEvaluated - liveBlocked)) : null,
    };

    // ---- the ladder --------------------------------------------------------
    // Every failing check, in precedence order. NOT short-circuited: a ladder that
    // stops at the first failure is exactly what hides `nextBindingReason`, which
    // is the field that stops an operator clearing one constraint at a time.
    const blockingReasons: QualificationReason[] = [];
    if (c.n < minCellN) blockingReasons.push('insufficient_evidence');
    if (lo === null) blockingReasons.push('edge_unmeasurable');
    else if (lo <= 0) blockingReasons.push('no_bar_setting_admits');
    else if (lo < barR) blockingReasons.push('edge_below_cost_bar');
    if (c.nRealFill < minCellRealFillN) blockingReasons.push('insufficient_real_fill_evidence');
    if (blockingReasons.length === 0 && liveEvaluated > 0 && liveAdmitRate === 0) {
      blockingReasons.push('cost_bar_live_block');
    }

    const resolvedReason = blockingReasons[0] ?? null;
    const nextBindingReason = blockingReasons[1] ?? null;

    const narrative = (() => {
      if (resolvedReason === null) {
        return liveNominatedNarrative(liveEvaluated, c.cellKey);
      }
      const head = QUALIFICATION_LADDER.find((l) => l.reason === resolvedReason)!;
      const tail =
        nextBindingReason === null
          ? ' Nothing else blocks it.'
          : ` Clearing that leaves \`${nextBindingReason}\` (${QUALIFICATION_LADDER.find((l) => l.reason === nextBindingReason)!.column.toUpperCase()}) binding next.`;
      return `${head.column.toUpperCase()} binds: \`${resolvedReason}\` (${head.test}).${tail}`;
    })();

    rows.push({
      cellKey: c.cellKey,
      structure: c.structure,
      bucket: c.bucket,
      liveNominated: liveEvaluated > 0,
      cost,
      edge,
      data,
      blockingReasons,
      resolvedReason,
      nextBindingReason,
      narrative,
    });
  }

  rows.sort((a, b) => b.edge.n - a.edge.n || a.cellKey.localeCompare(b.cellKey));

  const cellsOnlyInGate = [...gateByKey.keys()].filter((k) => !seenTableKeys.has(k)).sort();
  const cellsOnlyInTable = rows.filter((r) => !r.liveNominated).map((r) => r.cellKey).sort();

  const counts = new Map<QualificationReason | 'qualifies', number>();
  for (const r of rows) {
    const k = r.resolvedReason ?? 'qualifies';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const byResolvedReason = [...counts.entries()]
    .map(([reason, cells]) => ({ reason, cells }))
    .sort((a, b) => b.cells - a.cells || String(a.reason).localeCompare(String(b.reason)));

  const qualifying = rows.filter((r) => r.resolvedReason === null).length;
  const overall: QualificationMatrix['overall'] =
    input.cells === null ? 'blind' : qualifying > 0 ? 'some_qualify' : 'none_qualify';

  const foldAdmitRate =
    input.gateEvaluated !== null && input.gateEvaluated > 0 && input.gateBlocked !== null
      ? (input.gateEvaluated - input.gateBlocked) / input.gateEvaluated
      : null;
  // A cell is only evidence about the freeze if it was actually nominated; a table
  // row the gate never saw says nothing about whether the gate admits.
  //
  // ⚠️ ZERO EVALUATIONS IS `null`, NEVER `false`. A `cost_bar` row exists on the
  // retained fold from boot with `evaluated: 0`, so keying this on
  // `gateEvaluated !== null` alone made an EMPTY LEDGER read
  // `realFillFrozen: false` — "evidence is accruing" — off no data at all. That
  // is the exact inversion this block exists to prevent, and it was caught by
  // the route wiring test, not by the fold's own suite. Absent is not zero, and
  // a gate that never ran is not a gate that admitted.
  const nominated = rows.filter((r) => r.liveNominated);
  // The window's most recent ADMIT on any cell — the fold-level counterpart of
  // `lastAdmitEtDay`, and the number that makes a pooled admit count readable.
  const lastFoldAdmitEtDay =
    [...input.gateCellDays]
      .filter((d) => d.evaluated - d.blocked > 0)
      .map((d) => d.etDay)
      .sort()
      .pop() ?? null;
  const realFillFrozen =
    nominated.length > 0
      ? nominated.every((r) => r.data.canAccrue === false)
      : input.gateEvaluated === null || input.gateEvaluated === 0
        ? null
        : foldAdmitRate === 0;

  return {
    etDay: input.etDay,
    overall,
    minCellN,
    minCellRealFillN,
    gateWindowEtDays: [...input.gateWindowEtDays],
    bars: [...barByStructure.values()].sort((a, b) => a.structure.localeCompare(b.structure)),
    rows,
    byResolvedReason,
    accrual: {
      liveEvaluated: input.gateEvaluated,
      liveBlocked: input.gateBlocked,
      liveAdmitRate: round(foldAdmitRate),
      lastAdmitEtDay: lastFoldAdmitEtDay,
      realFillFrozen,
      reason:
        realFillFrozen === null
          ? `UNREAD — the cost_bar fold carried ${input.gateEvaluated === null ? 'no row at all' : 'zero evaluations'} over ${input.gateWindowEtDays.length} ET day(s), so the accrual question was not answered. This is NOT "nothing is frozen": absent is not zero, and a gate that never ran is not a gate that admitted.`
          : realFillFrozen
            ? `DEADLOCK — NOT ONE of the ${nominated.length} cell(s) the gate has decided can produce another real fill: each is either blocked at the bar on every nomination day, or has stopped being nominated altogether. ${input.gateBlocked ?? 0} of ${input.gateEvaluated ?? 0} evaluations blocked over ${input.gateWindowEtDays.length} ET day(s)${lastFoldAdmitEtDay === null ? ', with no admit anywhere in the window' : `; the window's most recent ADMIT was ${lastFoldAdmitEtDay}`}. TRA-4894's real-fill arm cannot be satisfied by waiting — the escape is EXECUTION, not a lower threshold. ⚠️ A pooled admit count over this window is NOT evidence against this: read \`rows[].data.lastAdmitEtDay\` vs \`lastNominatedEtDay\` per cell.`
            : `At least one cell was admitted on its most recent nomination day (window admit rate ${round(foldAdmitRate)}, most recent admit ${lastFoldAdmitEtDay ?? 'unknown'}), so a live entry is not blocked AT THE COST BAR. That is a necessary condition only — downstream gates are not modelled here.`,
    },
    join: { cellsOnlyInGate, cellsOnlyInTable, cellsCanonicalised },
    ladder: QUALIFICATION_LADDER,
    note:
      input.cells === null
        ? 'BLIND — the expectancy tape has never folded in this process. This is NOT a clean bill and NOT "nothing qualifies": the question was not answered. Check /api/health/option-expectancy-table → freshness.lastError.'
        : `${rows.length} cell(s); ${qualifying} qualify. Resolved reasons: ${byResolvedReason.map((b) => `${b.reason}=${b.cells}`).join(', ') || 'none'}. DIAGNOSTIC ONLY — nothing on this route decides anything, and \`resolvedReason\` must never be wired to a verdict (TRA-4889 exists to SEPARATE diagnostics from enforcement, not to add a fourth enforcement surface). Read \`cost.admitsAtBarOff\` before concluding the bar is the problem: \`false\` means no bar setting including OFF can admit that cell, so the \`cost_bar\` gate name and its \`shortfall_*\` reason codes are describing an EDGE failure. Read \`data.canAccrue\` before reading a low \`nRealFill\` as patience.`,
  };
}

function liveNominatedNarrative(liveEvaluated: number, cellKey: string): string {
  return liveEvaluated > 0
    ? 'QUALIFIES — cost, edge and data all pass, and the live gate has decided this cell.'
    : `QUALIFIES on cost, edge and data — but the live gate has NEVER nominated ${cellKey} in the fold window, so the qualification has never been exercised. That is a selection-side gap, not a gate-side one.`;
}
