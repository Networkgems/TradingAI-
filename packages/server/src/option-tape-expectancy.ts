// TRA-3391 (TRA-3388 Ruling 2) — the TAPE-CALIBRATED, EXIT-POLICY-CONDITIONAL
// expectancy that REPLACES the delta-proxy `estimateModeledGrossR`.
//
// ── What was deleted, and why no knob could have saved it ────────────────────
//
// `option-modeled-gross-r.ts` priced a race between two premium barriers
// (`mark·1.5` take-profit vs `mark·0.75` stop) and read the win probability off
// `|delta|·mult`. QuantTrader measured all three legs against the tape
// (`/api/health/option-journal?rows=all`, bqb1 `eb1dcf0c8a6f`, model-facing
// basis, `single_leg_otm` n=1073 closed) and every one of them is false:
//
//   1. THE RACE IS NOT WHAT THIS SLEEVE TRADES. The two barriers jointly resolve
//      30.8% of closes (target 5.2%, stop leg 25.6%). 69.2% exit via `manual` /
//      `trail` / `chandelier` / `time_stop` FIRST. `rewardR = 2.0` is therefore
//      not a property of the trades — a perfect touch-probability estimator
//      would still be estimating the wrong random variable.
//   2. THE R UNIT IS WRONG. The largest single mass point in the realized
//      distribution is `realizedR = −0.20` (227 rows), so the modelled
//      `lossR = 1` (a −25% premium stop) is empirically −0.80 R_gate.
//   3. NO MULTIPLIER EXISTS. Solving `3w − 1 = E_tape` for the implied win prob
//      needs `mult = 8.21` at |Δ|≈0.036 and `0.96` at |Δ|≈0.47 — non-monotone
//      and outside the old `[0, 5]` env clamp. That is why the knobs
//      (`OPTION_COST_GATE_WIN_PROB_DELTA_MULT` / `_WIN_PROB_CAP` /
//      `_DEFAULT_REWARD_R`) are DELETED rather than retuned: TRA-1602's header
//      said "pending QuantTrader spec sign-off", and TRA-3388 is that sign-off
//      arriving as a rejection of the CONSTRUCTION.
//
// ── The adopted frame ────────────────────────────────────────────────────────
//
// Compare a MEASURED E[R] produced under the exit policy the trade will actually
// face against the bar, instead of a modelled expectancy under an exit policy the
// sleeve does not use. The estimate for a candidate is the realized expectancy of
// its own `structure × |entryDelta| bucket` cell on the journal tape:
//
//   admit  ⟺  mean(R_gate) − 1.96·SE  ≥  admissionBarR(structure)
//
// LOWER CI BOUND, not the point estimate (Ruling 2.4). Point-estimate admission
// re-imports exactly the overconfidence that produced this ticket, and it is the
// same lower-bound discipline TRA-431 exists to enforce.
//
// ── `insufficient_evidence` DECLINES ─────────────────────────────────────────
//
// A cell with `n < 30` BLOCKS under its own reason code, distinct from
// `gross_negative` (Ruling 2.5). That distinction is the main deliverable: today
// the board cannot tell "we measured a loser" from "we never measured".
//
// ⚠ TRA-3401 — READ THE CELL KEY BEFORE SCOPING THAT CLAIM BY SYMBOL. On the
// restricted live universe [AAPL,SPY,QQQ,PLTR,TSLA] the tape holds 471 rows, all
// of them |Δ| < 0.20. That is a true statement about where the live sleeve has
// historically NOMINATED, and it is NOT a statement about the evidence a live
// candidate is decided under: {@link tapeExpectancyCellKey} is
// `structure × |delta| bucket` with **no symbol axis**, so the universe
// restriction does not scope the fold. A live AAPL candidate at |Δ|=0.51 is
// decided under `single_leg_otm::0.50-0.55` — pooled across every symbol and
// mode on the model-facing basis, n=87 on 2026-08-12, which ADMITS.
//
// Reading the 471 as "the admitted band is unmeasured" cost TRA-3401 a wrong
// recommendation to the board (it reported an evidence deadlock that does not
// exist). The readable answer is /api/health/option-expectancy-table, which
// publishes n / lowerCI95 / admits per cell — never re-derive it by symbol.
//
// ── TRA-4623 (QuantTrader ruling on TRA-4621) — the R BASIS convention ───────
//
// `single_leg_otm` expectancy and R-multiples are computed off the REALIZED
// BROKER-FILL basis — live closes only, `markSource: quote`, points of
// broker-fill basis — never off the trigger level. The −35% day-one stop is a
// TRIGGER (a firing condition), not a realized-loss budget: a limit order
// bounds its price only conditional on filling, and the exit escalates until
// it fills, so grading the sleeve at the trigger level understates every
// realized loss by the concession actually paid (TRA-4534 item 3, ratified as
// the standing sleeve convention on TRA-4621).
//
// ⛔ Explicitly NOT the cap basis. `atRiskUsd` / `openPremiumAtRiskUsd` stay
// FULL PREMIUM (`rowOpenPremiumAtRisk` in options-account.ts): a long option's
// max loss is 100% of premium and the fleet cap must keep folding it that way.
// A cap hold is never implemented by rewriting a risk basis — the fold is
// conservative HIGH, the stop is LOW, and an "expectancy-informed" at-risk
// figure would quietly widen admission on exactly the books the cap exists to
// bound (the TRA-3703 ruling's arithmetic).
//
// PURE — no env, no I/O, no clock (the caller passes `nowMs`). The rolling window
// and the journal read live in `option-tape-expectancy-cache.ts`.

import {
  GATE_R_BASIS_STRUCTURES,
  GATE_R_PER_PREMIUM_R,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import {
  admissionBarR,
  COST_GATE_SHORTFALL_BUCKETS_R,
  DEFAULT_COST_GATE_CONFIG,
  type CostGateConfig,
} from './option-cost-gate.js';
// TRA-3394 item 2 — the ratified authorization, as data. Imported for its
// DE-AUTHORIZATION predicate only; the module holds no bar and no env, so the
// admission decision cannot acquire one through this edge.
import { mandateBandFor, OTM_SLEEVE_MANDATE_ISSUE } from './otm-sleeve-mandate.js';
// TRA-4578 — the ACCOUNT-CLASS predicate, imported rather than re-written, so the
// per-cell census cannot drift from the table-level one in `applyModelFacingBasis`.
import { isUnattributedRow } from './model-facing-journal.js';

/**
 * Ruling 2.5 — a cell needs this many closed rows before its expectancy may
 * decide anything. Below it the verdict is `insufficient_evidence` and the
 * candidate is DECLINED.
 *
 * Deliberately NOT env-overridable. Every knob on the estimator this replaces
 * turned out to be a way of tuning a decision until it agreed with a prior; the
 * whole point of Ruling 2 is that the tape decides. Changing 30 is a code change
 * with a ruling behind it.
 */
export const TAPE_EXPECTANCY_MIN_CELL_N = 30;

/** Two-sided 95% normal quantile — the `1.96` in Ruling 2.4's decision rule. */
export const TAPE_EXPECTANCY_Z95 = 1.96;

/**
 * Ruling 2.3's bucket edges, half-open `[from, to)` except the top band which is
 * CLOSED at 1.0 (a |delta| above 1 is not a delta, it is a data error, and gets
 * no cell — see {@link tapeExpectancyBucket}).
 *
 * ⚠ Edges are derived by INTEGER arithmetic (hundredths ÷ 100), never by float
 * accumulation — the same discipline `entryDeltaBucket` documents. Real rows pile
 * up EXACTLY on 0.40 / 0.45 / 0.50 (the OTM floor and the RV greeks band), and
 * `0.45 − 0.40 = 0.04999999999999999` in IEEE-754 misassigns every one of them.
 */
const BAND_EDGES_HUNDREDTHS: readonly number[] = [0, 10, 20, 30, 40, 45, 50, 55, 100];

export interface TapeExpectancyBand {
  /** Inclusive lower edge. */
  from: number;
  /** Exclusive upper edge, EXCEPT on the top band where it is inclusive. */
  to: number;
  /** Stable label, e.g. `0.45-0.50`. Used as a map key and a wire field. */
  label: string;
}

/** The eight bands of Ruling 2.3, ascending. */
export const TAPE_EXPECTANCY_BANDS: readonly TapeExpectancyBand[] = BAND_EDGES_HUNDREDTHS
  .slice(0, -1)
  .map((e, i) => {
    const from = e / 100;
    const to = BAND_EDGES_HUNDREDTHS[i + 1]! / 100;
    return { from, to, label: `${from.toFixed(2)}-${to.toFixed(2)}` };
  });

/** Canonical bucket order for a readout — ascending in |delta|. */
export function tapeExpectancyBucketOrder(): string[] {
  return TAPE_EXPECTANCY_BANDS.map((b) => b.label);
}

/**
 * The band a candidate's (or a closed row's) entry |delta| falls in, or `null`
 * when it has none: a non-finite delta, or a magnitude above 1.0.
 *
 * `null` is NOT a bucket. It fails the candidate CLOSED (`gross_unknown`) and
 * drops the row from the fold — an unmeasurable delta must never be folded into
 * a real band, which is the TRA-1691 `unknown ≠ lt0.20` lesson.
 */
export function tapeExpectancyBucket(delta: number): string | null {
  const d = Math.abs(delta);
  if (!Number.isFinite(d) || d > 1) return null;
  for (const band of TAPE_EXPECTANCY_BANDS) {
    // Top band is closed at 1.0 so a true 1.00-delta row is not dropped.
    if (d >= band.from && (d < band.to || (band.to === 1 && d <= 1))) return band.label;
  }
  return null;
}

/**
 * The journal `structure` labels that are ONE sleeve wearing two names.
 *
 * The gate's call sites pass `directional`; the journal has written
 * `single_leg_directional` since TRA-2245 (`directional` is the legacy
 * live-fill-ledger tag for the same instrument — see
 * {@link GATE_R_BASIS_STRUCTURES}). Without this, every directional candidate
 * would look up a cell the journal never writes and be declined
 * `insufficient_evidence` forever while the evidence sat in the next key over.
 */
const STRUCTURE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['directional', 'single_leg_directional'],
]);

/** Fold a gate-side or journal-side structure label onto one canonical cell key. */
export function canonicalTapeStructure(structure: string): string {
  const s = structure.trim().toLowerCase();
  return STRUCTURE_ALIASES.get(s) ?? s;
}

/** `structure::bucket` — the stamped cell identity, stable across the wire. */
export function tapeExpectancyCellKey(structure: string, bucket: string): string {
  return `${canonicalTapeStructure(structure)}::${bucket}`;
}

/**
 * TRA-4578 — the per-cell PROVENANCE block, and the reason it exists.
 *
 * `lowerCI95` is the edge side of the live `single_leg_otm` cost-bar admission,
 * so a cell whose `admits` flips is a cell that opens real-money positions. Until
 * this block shipped, **a cell reading `lowerCI95: 0.3617` was byte-identical
 * whether it was 110 desk real-money closes or 84 July demo rows booked at mid.**
 * Provenance existed only at TABLE level (`basis.desk` / `basis.unattributed` /
 * `basis.byMode` on the cache's census), which cannot be attributed down to the
 * cell a candidate was actually decided under — TRA-4520 and TRA-4569 both had to
 * reconstruct `single_leg_otm::0.50-0.55` by hand off
 * `/api/health/option-journal?rows=all` to find that its positive mean was
 * carried entirely by pre-08-20 demo rows, 53 of them `unattributed`, while the
 * 23 desk rows the band actually produced returned mean −0.835 R_gate / −$497.
 *
 * ⚠ This block DECIDES NOTHING. `admits`, `barR` and the basis predicate are
 * unchanged by TRA-4578 — the defect was that the choice was invisible at the row
 * a verdict cites, not that the choice was wrong. The `desk+unattributed` basis
 * is deliberate (see `option-tape-expectancy-cache.ts`'s header: it avoids
 * `loadModelFacingJournalRows()` precisely so the handful of live rows survive).
 */
export interface TapeExpectancyCellProvenance {
  /**
   * Rows in THIS cell by journal `mode`, e.g. `{ demo: 93, live: 17 }`. Keys are
   * only present when non-zero — read a missing key as "no rows of that mode",
   * which is exactly what `n − (sum of present keys) === 0` asserts.
   */
  byMode: Record<string, number>;
  /**
   * Rows in THIS cell by account class, on the fold's own basis.
   * `desk + unattributed === n` by construction (both derived from
   * {@link isUnattributedRow}, the same predicate `applyModelFacingBasis` uses).
   * `unattributed` is NOT desk: it is a row written before TRA-1475 added
   * `account`.
   */
  byAccountClass: { desk: number; unattributed: number };
  /**
   * Oldest / newest `closeTs` among THIS cell's rows; null when no row in it
   * carried a finite `closeTs`. The table-level `fromTs`/`toTs` span every cell
   * at once and so cannot separate two populations inside one cell — these can
   * (item 3 of the ask: the 08-20 provenance change is visible here).
   */
  fromTs: number | null;
  toTs: number | null;
}

/**
 * TRA-4578 item 2 — the NET-OF-MODELLED-CROSS companion's own provenance.
 *
 * Demo rows cannot pay the cost the bar prices: `/api/health/option-spread-cost`
 * → `demoCostModel` reads `demoSlippagePct: 0`, `demoFeePerContract: 0`, and the
 * route's own note says "demo realized R is gross of spread". Live rows already
 * paid a real spread and real fees, so charging them again would double-count.
 * The companion therefore deducts the cell's own measured round-trip `costR` from
 * **demo rows only** — exactly one deduction, which is correct because
 * `netEdgeCostBreakdown` already builds `costR` as `ask − bid` plus round-trip
 * fees.
 *
 * ⛔ FAIL-NULL, never fail-zero. When no measured `costR` exists for the cell the
 * whole companion is `null` and {@link unavailableReason} says which of the two
 * ignorance cases it is. An absent cost charged as `0` would make the companion
 * byte-identical to the gross number — i.e. it would reproduce the exact defect
 * this ticket exists to close.
 */
export interface TapeExpectancyCrossCharge {
  /** Per-row round-trip charge applied to demo rows, in gate R. Null ⇒ not charged. */
  costR_gate: number | null;
  /** A LITERAL naming where the charge came from, greppable; null when uncharged. */
  source: string | null;
  /** Demo rows — the ones charged. */
  rowsCharged: number;
  /** Live rows — already net of real spread and fees, so NOT charged. */
  rowsUncharged: number;
  sdR_gate: number | null;
  seR_gate: number | null;
  /**
   * ⚠ READ-ONLY, and it is not a decision. `admits` beside it is what the live
   * gate does; this is what it WOULD do if the modelled cross were charged.
   * Null whenever {@link costR_gate} is null.
   */
  wouldAdmit: boolean | null;
  /** Why the companion is null; null when the companion is populated. */
  unavailableReason: string | null;
}

/** One `structure × |delta| bucket` cell of the tape. */
export interface TapeExpectancyCell {
  /** Canonical structure (see {@link canonicalTapeStructure}). */
  structure: string;
  bucket: string;
  /** `structure::bucket`. */
  cellKey: string;
  deltaFrom: number;
  deltaTo: number;
  /** Closed rows in the cell, on the model-facing basis. */
  n: number;
  /**
   * TRA-4857 — unpriced closes dropped from THIS CELL: `outcome: 'UNMEASURED'`
   * (broker_reconcile with no fill to price against). Distinct from
   * `rowsDroppedUnresolved` (still OPEN, or no finite realizedR on a resolved
   * row). A cell carrying unpriced closes cannot present as fully measured.
   */
  droppedUnpricedCloses: number;
  /** Mean realized R in the GATE's R (`realizedR / 0.25`) — same unit as the bar. */
  meanR_gate: number;
  /** Sample SD (n−1) in gate R; null at n < 2. */
  sdR_gate: number | null;
  /** SE of the mean (sd/√n) in gate R; null at n < 2. */
  seR_gate: number | null;
  /** `mean − 1.96·SE`; null when SE is unknown (the decision then declines). */
  lowerCI95: number | null;
  /** The bar this cell's structure faces under the config the table was built with. */
  barR: number;
  /** Ruling 2.4 + 2.5: `n >= 30 && lowerCI95 >= barR`. */
  admits: boolean;
  /** TRA-4578 — who is in this cell. Decides nothing; see the interface doc. */
  provenance: TapeExpectancyCellProvenance;
  /**
   * TRA-4578 item 2 — `meanR_gate` with the cell's measured round-trip cost
   * charged to its demo rows. **Published BESIDE `meanR_gate`, never instead of
   * it** — the deciding value is unchanged by this ticket. Null when no measured
   * cost exists for the cell (see `netOfModelledCross.unavailableReason`).
   */
  meanR_gate_netOfModelledCross: number | null;
  /** TRA-4578 item 2 — the companion of `lowerCI95`. Decides nothing. */
  lowerCI95_netOfModelledCross: number | null;
  /** TRA-4578 item 2 — the charge, its source, and why it is null when it is. */
  netOfModelledCross: TapeExpectancyCrossCharge;
}

/** Provenance for the fold — what went in, what was dropped, and on what basis. */
export interface TapeExpectancyTable {
  /** Rows offered to the fold (post model-facing basis). */
  rowsConsidered: number;
  /** Closed rows that produced a cell contribution. */
  rowsUsed: number;
  /** Dropped: still open, or no finite `realizedR`. */
  rowsDroppedUnresolved: number;
  /**
   * TRA-4857 — dropped unpriced closes: `outcome: 'UNMEASURED'`
   * (broker_reconcile with no fill to price against). Distinct from
   * `rowsDroppedUnresolved` (still OPEN) and reported separately so the
   * "closed but unpriceable" shape is visible, not conflated.
   */
  rowsDroppedUnpriced: number;
  /** Dropped: `|delta|` non-finite or > 1 — never folded into a real band. */
  rowsDroppedUnknownDelta: number;
  /** Dropped: structure has no valid premium→gate R conversion (credit spreads). */
  rowsDroppedNoGateBasis: number;
  /** Dropped: closed outside the rolling window. */
  rowsDroppedOutOfWindow: number;
  /** The rolling window in days; null = every retained row. */
  windowDays: number | null;
  /** Oldest / newest `closeTs` actually folded; null on an empty fold. */
  fromTs: number | null;
  toTs: number | null;
  /** ms-epoch the fold ran (caller-supplied — this module has no clock). */
  computedAt: number;
  minCellN: number;
  z: number;
  /** Cells, ascending by structure then bucket. Empty cells are omitted. */
  cells: TapeExpectancyCell[];
}

export interface BuildTapeExpectancyOpts {
  /** Rolling window in days, measured back from `nowMs`. Null/absent = all rows. */
  windowDays?: number | null;
  /** ms-epoch "now" for the window. Required when `windowDays` is set. */
  nowMs?: number;
  /** Cost-gate config the `admits` / `barR` columns are computed against. */
  config?: CostGateConfig;
  minCellN?: number;
  /**
   * TRA-4578 item 2 — measured round-trip cross cost per cell, in gate R, keyed
   * by `cellKey`. INJECTED: this module has no ledger edge and must keep none
   * (it is the pure fold the gate decides on), so the coupling to the
   * live-enforce ledger lives one layer up in `option-tape-expectancy-cache.ts`
   * where it is visible and testable.
   *
   * Absent map, or absent key ⇒ the companion is NULL for that cell. Never 0.
   */
  modelledCrossRByCell?: ReadonlyMap<string, number> | null;
  /**
   * A literal naming where {@link modelledCrossRByCell} came from, echoed onto
   * every charged cell. Required in spirit whenever the map is supplied — a
   * charge whose origin is unstated is the same class of unlabelled number this
   * ticket exists to end.
   */
  modelledCrossRSource?: string | null;
}

/** A cell's accumulator: the gate-R values plus who produced each one. */
interface CellAccumulator {
  structure: string;
  bucket: string;
  values: number[];
  /**
   * Parallel to {@link values}: true when the row's realized R is GROSS of the
   * cross (i.e. `mode: 'demo'`), and so is the one the companion charges.
   */
  grossOfCross: boolean[];
  byMode: Record<string, number>;
  desk: number;
  unattributed: number;
  fromTs: number | null;
  toTs: number | null;
  /**
   * TRA-4857 — unpriced closes dropped from this cell before accumulation:
   * `outcome: 'UNMEASURED'`. Tracked per cell so a cell carrying unpriced
   * closes cannot present as fully measured.
   */
  droppedUnpriced: number;
}

/** Mean / sample-SD / SE / lower 95% bound over one value list. Shared by both columns. */
function cellStats(values: readonly number[]): {
  mean: number;
  sd: number | null;
  se: number | null;
  lowerCI95: number | null;
} {
  const n = values.length;
  const mean = values.reduce((a, v) => a + v, 0) / n;
  // Sample SD (n−1): the unbiased dispersion estimate a CI on the mean needs.
  // Undefined at n=1 — which declines anyway, well under minCellN.
  const sd = n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : null;
  const se = sd !== null ? sd / Math.sqrt(n) : null;
  return { mean, sd, se, lowerCI95: se !== null ? mean - TAPE_EXPECTANCY_Z95 * se : null };
}

/**
 * Fold journal rows into the per-cell expectancy table.
 *
 * ⚠ BASIS IS THE CALLER'S JOB and it is load-bearing (Ruling 2.1): pass rows that
 * have already been through `applyModelFacingBasis` / `loadModelFacingJournal`.
 * 110 of the 116 QA-fixture OTM rows sit in the 0.45–0.55 delta band — i.e.
 * EXACTLY the decision band — so a fixture-inclusive fold does not merely add
 * noise, it manufactures the admission. `option-tape-expectancy-cache.ts` is the
 * production loader and applies the basis; nothing else should build this table.
 *
 * Pure: no env, no I/O, no clock.
 */
export function buildTapeExpectancyTable(
  rows: readonly OptionTradeJournalRecord[],
  opts: BuildTapeExpectancyOpts = {},
): TapeExpectancyTable {
  const config = opts.config ?? DEFAULT_COST_GATE_CONFIG;
  const minCellN = opts.minCellN ?? TAPE_EXPECTANCY_MIN_CELL_N;
  const windowDays = opts.windowDays ?? null;
  const computedAt = opts.nowMs ?? 0;
  // TRA-4578 item 2 — `null` and `undefined` are both "no source"; kept as a
  // nullish check so an explicitly-passed `null` reads the same as omission.
  const crossByCell = opts.modelledCrossRByCell ?? null;
  const crossSource = opts.modelledCrossRSource ?? null;
  const cutoff =
    windowDays !== null && Number.isFinite(windowDays) && windowDays > 0
      ? computedAt - windowDays * 24 * 60 * 60 * 1000
      : null;

  let rowsDroppedUnresolved = 0;
  let rowsDroppedUnpriced = 0;
  let rowsDroppedUnknownDelta = 0;
  let rowsDroppedNoGateBasis = 0;
  let rowsDroppedOutOfWindow = 0;
  let rowsUsed = 0;
  let fromTs: number | null = null;
  let toTs: number | null = null;

  /** cellKey -> gate-basis realized R values, plus TRA-4578's per-cell provenance. */
  const cells = new Map<string, CellAccumulator>();

  for (const r of rows) {
    // TRA-4857 — unpriced closes (broker_reconcile with no fill) are dropped
    // BEFORE the generic unresolved check and counted separately, so "closed
    // but unpriceable" is visible, not conflated with "still OPEN". Tracked per
    // cell so a cell carrying unpriced closes cannot present as fully measured.
    if (r.outcome === 'UNMEASURED') {
      rowsDroppedUnpriced += 1;
      // Track per cell: need to know which cell this row would have landed in.
      // Compute bucket and structure, then increment the cell's unpriced counter.
      if (GATE_R_BASIS_STRUCTURES.has(r.structure)) {
        const bucket = tapeExpectancyBucket(r.entryDelta as number);
        if (bucket !== null) {
          const structure = canonicalTapeStructure(r.structure);
          const key = tapeExpectancyCellKey(structure, bucket);
          let cell = cells.get(key);
          if (!cell) {
            cell = {
              structure,
              bucket,
              values: [],
              grossOfCross: [],
              byMode: {},
              desk: 0,
              unattributed: 0,
              fromTs: null,
              toTs: null,
              droppedUnpriced: 0,
            };
            cells.set(key, cell);
          }
          cell.droppedUnpriced += 1;
        }
      }
      continue;
    }
    if (r.outcome === 'OPEN' || typeof r.realizedR !== 'number' || !Number.isFinite(r.realizedR)) {
      rowsDroppedUnresolved += 1;
      continue;
    }
    // The premium→gate R conversion is a property of the INSTRUMENT (full-premium
    // `atRiskUsd` + a `mark·0.75` stop). A credit spread has no valid conversion,
    // so it is dropped rather than scaled by a 4× that does not apply to it.
    if (!GATE_R_BASIS_STRUCTURES.has(r.structure)) {
      rowsDroppedNoGateBasis += 1;
      continue;
    }
    const bucket = tapeExpectancyBucket(r.entryDelta as number);
    if (bucket === null) {
      rowsDroppedUnknownDelta += 1;
      continue;
    }
    const closeTs = typeof r.closeTs === 'number' && Number.isFinite(r.closeTs) ? r.closeTs : null;
    if (cutoff !== null && (closeTs === null || closeTs < cutoff)) {
      rowsDroppedOutOfWindow += 1;
      continue;
    }

    const structure = canonicalTapeStructure(r.structure);
    const key = tapeExpectancyCellKey(structure, bucket);
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        structure,
        bucket,
        values: [],
        grossOfCross: [],
        byMode: {},
        desk: 0,
        unattributed: 0,
        fromTs: null,
        toTs: null,
        droppedUnpriced: 0, // TRA-4857
      };
      cells.set(key, cell);
    }
    cell.values.push(r.realizedR * GATE_R_PER_PREMIUM_R);
    // TRA-4578 — census the row that actually LANDED in the cell. It is counted
    // here, after all four drop predicates and the window cutoff, and not in the
    // cache beside the table-level census, precisely because only this loop knows
    // which rows survived: a census re-derived upstream would have to re-implement
    // the bucket, structure-alias, gate-basis and window logic and could drift
    // from it silently — the same-reading-instrument failure this ticket is about.
    cell.grossOfCross.push(r.mode === 'demo');
    cell.byMode[r.mode] = (cell.byMode[r.mode] ?? 0) + 1;
    if (isUnattributedRow(r)) cell.unattributed += 1;
    else cell.desk += 1;
    rowsUsed += 1;
    if (closeTs !== null) {
      fromTs = fromTs === null ? closeTs : Math.min(fromTs, closeTs);
      toTs = toTs === null ? closeTs : Math.max(toTs, closeTs);
      cell.fromTs = cell.fromTs === null ? closeTs : Math.min(cell.fromTs, closeTs);
      cell.toTs = cell.toTs === null ? closeTs : Math.max(cell.toTs, closeTs);
    }
  }

  const bucketOrder = tapeExpectancyBucketOrder();
  const out: TapeExpectancyCell[] = [...cells.entries()]
    .map(([cellKey, acc]) => {
      const { structure, bucket, values, grossOfCross } = acc;
      const n = values.length;
      const { mean, sd, se, lowerCI95 } = cellStats(values);
      const barR = admissionBarR(structure, config);
      const band = TAPE_EXPECTANCY_BANDS.find((b) => b.label === bucket)!;

      // ── TRA-4578 item 2 — the net-of-modelled-cross companion ──────────────
      // Fail-NULL: `costR` is read from the injected map and must be a finite
      // number. An absent map and an absent key are DIFFERENT ignorance cases and
      // say so; neither is charged as 0, because a 0 charge renders the companion
      // byte-identical to the gross column it exists to discriminate against.
      const rowsCharged = grossOfCross.reduce((a, g) => a + (g ? 1 : 0), 0);
      const supplied = crossByCell?.get(cellKey);
      const costR = typeof supplied === 'number' && Number.isFinite(supplied) ? supplied : null;
      const unavailableReason =
        costR !== null
          ? null
          : crossByCell == null
            ? 'no per-cell cross-cost source was supplied to this fold'
            : `no measured round-trip costR for ${cellKey} in ${crossSource ?? 'the supplied source'} — NOT charged as zero`;
      // The deduction is per-ROW, not applied to the mean, because it lands on a
      // SUBSET: it shifts the demo rows relative to the live ones and therefore
      // moves the dispersion too. `mean − costR·(charged/n)` would get the mean
      // right and the SE — which is the half that decides — wrong.
      const netValues = costR === null ? null : values.map((v, i) => (grossOfCross[i] ? v - costR : v));
      const net = netValues === null ? null : cellStats(netValues);

      return {
        structure,
        bucket,
        cellKey,
        deltaFrom: band.from,
        deltaTo: band.to,
        n,
        droppedUnpricedCloses: acc.droppedUnpriced, // TRA-4857
        meanR_gate: mean,
        sdR_gate: sd,
        seR_gate: se,
        lowerCI95,
        barR,
        admits: n >= minCellN && lowerCI95 !== null && lowerCI95 >= barR,
        provenance: {
          byMode: { ...acc.byMode },
          byAccountClass: { desk: acc.desk, unattributed: acc.unattributed },
          fromTs: acc.fromTs,
          toTs: acc.toTs,
        },
        meanR_gate_netOfModelledCross: net?.mean ?? null,
        lowerCI95_netOfModelledCross: net?.lowerCI95 ?? null,
        netOfModelledCross: {
          costR_gate: costR,
          source: costR === null ? null : (crossSource ?? null),
          rowsCharged,
          rowsUncharged: n - rowsCharged,
          sdR_gate: net?.sd ?? null,
          seR_gate: net?.se ?? null,
          wouldAdmit:
            net === null ? null : n >= minCellN && net.lowerCI95 !== null && net.lowerCI95 >= barR,
          unavailableReason,
        },
      };
    })
    .sort(
      (a, b) =>
        a.structure.localeCompare(b.structure)
        || bucketOrder.indexOf(a.bucket) - bucketOrder.indexOf(b.bucket),
    );

  return {
    rowsConsidered: rows.length,
    rowsUsed,
    rowsDroppedUnresolved,
    rowsDroppedUnpriced, // TRA-4857
    rowsDroppedUnknownDelta,
    rowsDroppedNoGateBasis,
    rowsDroppedOutOfWindow,
    windowDays,
    fromTs,
    toTs,
    computedAt,
    minCellN,
    z: TAPE_EXPECTANCY_Z95,
    cells: out,
  };
}

/** Look one cell up by structure + |delta|. Null when the tape has no such cell. */
export function findTapeExpectancyCell(
  table: TapeExpectancyTable | null,
  structure: string,
  delta: number,
): TapeExpectancyCell | null {
  if (!table) return null;
  const bucket = tapeExpectancyBucket(delta);
  if (bucket === null) return null;
  const key = tapeExpectancyCellKey(structure, bucket);
  return table.cells.find((c) => c.cellKey === key) ?? null;
}

/**
 * Bounded, foldable classification of a tape-expectancy BLOCK — the `reasonCode`
 * the live-enforce ledger folds on (`byReason`).
 *
 *   `band_deauthorized`      — NEW (TRA-3394 item 2, authorization TRA-3392 §1).
 *                              The candidate's |delta| is in a band the CTO
 *                              DE-AUTHORIZED BY EVIDENCE. **We measured it and
 *                              the mandate forbids it.** Sourced from
 *                              `otm-sleeve-mandate.ts`, NOT from the bar, and
 *                              checked BEFORE any bar arithmetic — see
 *                              {@link tapeExpectancyVerdict}.
 *   `insufficient_evidence`  — Ruling 2.5. The cell exists on the delta axis but
 *                              holds `n < 30` closed rows, or the tape has never
 *                              been folded. **We never measured.** It DECLINES,
 *                              and it is deliberately NOT `gross_negative`: the
 *                              board could not previously tell those two apart,
 *                              and on the live universe today every candidate in
 *                              the admitted band is in this state.
 *   `gross_unknown`          — the candidate has no usable |delta|, so it has no
 *                              cell at all. Fails closed. An input defect, not a
 *                              tape gap.
 *   `gross_negative`         — measured, n sufficient, and the cell's MEAN is
 *                              below zero. **We measured a loser.** Classified on
 *                              the mean, not on the lower bound: a cell with a
 *                              positive mean whose CI straddles the bar is not a
 *                              measured loser, it is a measured-but-imprecise
 *                              cell, and calling it `gross_negative` would put
 *                              the two back in one bucket — the same conflation
 *                              `insufficient_evidence` exists to end.
 *   `shortfall_*`            — mean non-negative but the LOWER BOUND is under the
 *                              bar, bucketed by how far (same edges as the retired
 *                              flat form, so the ledger's tuning axis survives the
 *                              swap). Includes cells that are positive on the point
 *                              estimate and lose on CI width.
 */
export type TapeExpectancyReasonCode =
  | 'band_deauthorized'
  | 'insufficient_evidence'
  | 'gross_unknown'
  | 'gross_negative'
  | string;

/**
 * TRA-3394 item 2 — the three codes the board asked to be able to tell apart,
 * with the question each one answers. Published on the health surface so the
 * distinction is documented where it is read, not only where it is written.
 *
 * The whole point is that these want THREE DIFFERENT RESPONSES:
 *   • `band_deauthorized`     → nothing. The answer is settled; do not retune.
 *   • `insufficient_evidence` → accrue evidence (doc §5 pre-registers the test).
 *   • `gross_negative`        → the cell is measured and losing; the bar is
 *                               working as intended.
 */
export const DECLINE_REASON_TAXONOMY: readonly {
  code: string;
  meaning: string;
  source: string;
  response: string;
}[] = [
  {
    code: 'band_deauthorized',
    meaning: 'WE MEASURED IT AND THE MANDATE FORBIDS IT — the band is closed by ratified evidence.',
    source: 'otm-sleeve-mandate.ts (TRA-3392 §1/§2). NOT derived from the cost bar.',
    response:
      'None. A bar / k / multiplier change may not reopen it; that would take a new CTO ruling. '
      + 'This code exists so a future TRA-3272-style retune cannot silently reopen the band.',
  },
  {
    code: 'insufficient_evidence',
    meaning: 'WE NEVER MEASURED — the cell holds fewer than the minimum closed rows, or the tape is unfolded.',
    source: 'option-tape-expectancy.ts, cell n vs minCellN (TRA-3388 Ruling 2.5).',
    response:
      'Accrue evidence. TRA-3392 §5 pre-registers the reopening test for [0.20,0.45); note the doc '
      + 'also records that it cannot currently fire at the observed arrival rate.',
  },
  {
    code: 'gross_negative',
    meaning: 'WE MEASURED A LOSER — the cell is adequately powered and its MEAN is below zero.',
    source: 'option-tape-expectancy.ts, cell mean vs 0 (classified on the MEAN, not the lower bound).',
    response: 'None needed — the bar is doing its job. Do not confuse with an imprecise-but-positive cell.',
  },
];

/** The admit/decline verdict for one candidate under the tape-calibrated form. */
export interface TapeExpectancyVerdict {
  admit: boolean;
  /** Canonical structure the cell was looked up under. */
  structure: string;
  /** The |delta| band, or null when the candidate had no usable delta. */
  bucket: string | null;
  /** `structure::bucket`, or null — the cell each decision was made under. */
  cellKey: string | null;
  /** Rows behind the decision; 0 when no cell was found. */
  n: number;
  meanR_gate: number | null;
  seR_gate: number | null;
  /** The decision statistic: `mean − 1.96·SE`. Null ⇒ declined for want of it. */
  lowerCI95: number | null;
  /** The bar the lower bound had to clear. */
  barR: number;
  /** Bounded classification for the ledger fold; null when admitted. */
  reasonCode: TapeExpectancyReasonCode | null;
  /** Human-readable decline reason (empty when admitted). */
  reason: string;
}

/**
 * The candidate's edge in R, as a plain number, for the consumers that still take
 * one (the net-edge bar form, the demo cost-aware ledger). It is the LOWER CI
 * BOUND, not the mean — the same statistic the flat form admits on, so arming the
 * net-edge form cannot silently swap in a more optimistic edge. `NaN` when the
 * cell is unknown/underpowered, which those consumers already treat as fail-closed.
 */
export function tapeEdgeR(verdict: TapeExpectancyVerdict): number {
  return verdict.lowerCI95 ?? Number.NaN;
}

/** Shortfall bucketing, shared with the retired flat form's ledger vocabulary. */
function shortfallCode(shortfall: number): string {
  const [near, mid, far] = COST_GATE_SHORTFALL_BUCKETS_R as unknown as [number, number, number];
  if (shortfall < near) return `shortfall_lt_${near.toFixed(2)}`;
  if (shortfall < mid) return `shortfall_${near.toFixed(2)}_${mid.toFixed(2)}`;
  if (shortfall < far) return `shortfall_${mid.toFixed(2)}_${far.toFixed(2)}`;
  return `shortfall_gte_${far.toFixed(2)}`;
}

/**
 * Ruling 2.4/2.5 — the admission decision for one candidate.
 *
 * FAIL-CLOSED in all three ignorance cases: no table folded yet, no cell, or too
 * few rows. "We have not measured this" declines; it never admits.
 *
 * ── TRA-3394 item 2: the de-authorization check runs FIRST ───────────────────
 *
 * Before this, `[0.00, 0.20)` was closed by ALGEBRAIC ACCIDENT — the cost bar
 * happened to work out to a 0.495 delta floor. Nothing in the code knew the band
 * was a measured loser (n=638, t=−4.45), so any bar / k / multiplier change (the
 * change TRA-3272 was opened to make) would have reopened the single most
 * significantly negative cell on the tape with real money, silently.
 *
 * So the mandate is consulted BEFORE `barR`, before the cell lookup, and before
 * any comparison a retune could move. The ORDER is the guarantee: a de-authorized
 * band cannot be reached by a number. It declines under `band_deauthorized`,
 * which is distinct from `gross_negative` (we measured a loser) and from
 * `insufficient_evidence` (we never measured) precisely because the three want
 * different responses — see {@link DECLINE_REASON_TAXONOMY}.
 */
export function tapeExpectancyVerdict(
  candidate: { structure: string; delta: number },
  table: TapeExpectancyTable | null,
  config: CostGateConfig = DEFAULT_COST_GATE_CONFIG,
): TapeExpectancyVerdict {
  const structure = canonicalTapeStructure(candidate.structure);
  const barR = admissionBarR(structure, config);
  const bucket = tapeExpectancyBucket(candidate.delta);
  const base = {
    structure,
    bucket,
    cellKey: bucket === null ? null : tapeExpectancyCellKey(structure, bucket),
    barR,
  };

  if (bucket === null) {
    return {
      ...base,
      admit: false,
      n: 0,
      meanR_gate: null,
      seR_gate: null,
      lowerCI95: null,
      reasonCode: 'gross_unknown',
      reason: `tape-expectancy gate (TRA-3391): candidate |delta| ${candidate.delta} is not a usable delta — no cell exists, fail closed`,
    };
  }

  // TRA-3394 item 2 — the mandate, ahead of every bar-derived number. Note this
  // runs AFTER the unusable-delta check on purpose: a candidate with no delta has
  // no band either, and `gross_unknown` (an input defect) must not be relabelled
  // as a mandate decision.
  const deAuthorized = mandateBandFor(structure, candidate.delta);
  if (deAuthorized?.authorization === 'de_authorized') {
    const cell = findTapeExpectancyCell(table, structure, candidate.delta);
    return {
      ...base,
      admit: false,
      // The tape stats are reported even though they did not decide anything —
      // a reader must be able to see that the mandate and the tape AGREE here,
      // rather than take the de-authorization on trust.
      n: cell?.n ?? 0,
      meanR_gate: cell?.meanR_gate ?? null,
      seR_gate: cell?.seR_gate ?? null,
      lowerCI95: cell?.lowerCI95 ?? null,
      reasonCode: 'band_deauthorized',
      reason:
        `sleeve mandate (${OTM_SLEEVE_MANDATE_ISSUE}, enforced by TRA-3394): |delta| band `
        + `${deAuthorized.label} on ${structure} is DE-AUTHORIZED BY EVIDENCE, permanently. `
        + `${deAuthorized.rationale} This decline is sourced from the ratified band table, NOT from `
        + 'the cost bar — no bar, k or multiplier change can reopen it.',
    };
  }

  const minCellN = table?.minCellN ?? TAPE_EXPECTANCY_MIN_CELL_N;
  const cell = findTapeExpectancyCell(table, structure, candidate.delta);
  if (table === null || cell === null || cell.n < minCellN || cell.lowerCI95 === null) {
    const n = cell?.n ?? 0;
    const why =
      table === null
        ? 'the expectancy tape has not been folded yet'
        : `cell holds n=${n} closed rows (< ${minCellN} required)`;
    return {
      ...base,
      admit: false,
      n,
      meanR_gate: cell?.meanR_gate ?? null,
      seR_gate: cell?.seR_gate ?? null,
      lowerCI95: cell?.lowerCI95 ?? null,
      reasonCode: 'insufficient_evidence',
      reason: `tape-expectancy gate (TRA-3391): INSUFFICIENT EVIDENCE for ${structure} |delta| ${bucket} — ${why}. This is NOT a measured loser; it is an unmeasured cell, and an unmeasured cell declines (TRA-3388 Ruling 2.5).`,
    };
  }

  const lower = cell.lowerCI95;
  if (lower >= barR) {
    return {
      ...base,
      admit: true,
      n: cell.n,
      meanR_gate: cell.meanR_gate,
      seR_gate: cell.seR_gate,
      lowerCI95: lower,
      reasonCode: null,
      reason: '',
    };
  }

  const detail = `${structure} |delta| ${bucket}: mean ${cell.meanR_gate.toFixed(3)}R_gate, SE ${(cell.seR_gate ?? 0).toFixed(3)}, lower 95% CI ${lower.toFixed(3)}R < ${barR.toFixed(3)}R bar over n=${cell.n} closed tape rows`;
  return {
    ...base,
    admit: false,
    n: cell.n,
    meanR_gate: cell.meanR_gate,
    seR_gate: cell.seR_gate,
    lowerCI95: lower,
    reasonCode: cell.meanR_gate < 0 ? 'gross_negative' : shortfallCode(barR - lower),
    reason: `tape-expectancy gate (TRA-3391): ${detail}`,
  };
}

// ── TRA-4783 — INPUT staleness, as a first-class degradation signal ──────────
//
// `TapeExpectancyFreshness` (the cache's block) times the RECOMPUTE: the fold
// re-runs on a 60s TTL and on every option close, so `dirty: false, ageMs
// ~27000` is what a reader saw on 2026-09-22 (build 9472ced3) while every input
// cell's tape had been frozen 20–76 days. A healthy-and-current edge
// computation and a 76-day-stale one rendered IDENTICALLY on the one field the
// TRA-2879 routine body says to gate on. This fold is the discriminator: it
// aggregates the CELLS' OWN tape windows (`provenance.toTs`, the newest close
// actually inside each cell) into fields published beside the cache ones.
//
// PURE — no clock (the caller passes `nowMs`, the same single read the cells'
// `tapeWindow` blocks are stamped with), no env, no I/O. Decides nothing:
// read-only observability, exactly like the TRA-4753 `tapeWindow` it folds.

/**
 * The staleness bar, in days. TRA-4783 asked for a bar "anywhere in roughly
 * 7–14 days"; the frozen state's NEWEST cell read 20.0 days while a normally
 * accruing tape refreshes its active cells in single-digit days. 10 sits
 * mid-band: above a long weekend plus a quiet week, below every reading the
 * defect produced. Deliberately NOT env-tunable — a knob on a degradation
 * detector is how the detector gets quietly widened until it agrees with the
 * state it exists to flag.
 */
export const TAPE_INPUT_STALE_THRESHOLD_DAYS = 10;

/** TRA-4783 — the input-staleness fields merged into `arm.costBar.edge.freshness`. */
export interface TapeInputStaleness {
  /**
   * Age in days (1 decimal, the same rounding as `tapeWindow.tapeAgeDays`) of
   * the OLDEST cell window end — `nowMs − min(provenance.toTs)` over the
   * measurable cells. Null ⇒ no cell carried a finite `toTs`: NOT COMPUTABLE,
   * never 0.
   */
  inputTapeAgeDaysMax: number | null;
  /** ISO of that oldest window end (`min(provenance.toTs)`). Null with the above. */
  inputTapeToIsoOldest: string | null;
  /**
   * THREE-VALUED, deliberately (TRA-4783 item 3):
   *   true  — at least one measurable cell's tape is older than the threshold.
   *   false — EVERY cell was measurable and EVERY one is inside the threshold.
   *   null  — not computable as a clean pass: no measurable cells at all, or
   *           the measurable ones read fresh while ≥1 cell has no `toTs` — an
   *           unmeasured cell can be arbitrarily old, so attesting `false`
   *           there would coerce unknown → healthy, the exact bug one layer up.
   * At the wire that makes the field three-valued-plus-absent: absent = not
   * deployed, `null` = not computable, boolean = a real measurement. A reader
   * must never `?? false` it.
   */
  inputStale: boolean | null;
  /** The bar `inputStale` was decided against, published so a reader need not guess. */
  inputStaleThresholdDays: number;
  /** Cells with a finite `provenance.toTs` — the ones inside the max/oldest fold. */
  inputCellsMeasured: number;
  /** Cells with `toTs: null` (no row carried a finite closeTs). Counted, never coerced. */
  inputCellsUnmeasured: number;
}

/**
 * Fold the cells' own tape windows into the TRA-4783 staleness summary.
 *
 * The threshold compare runs on the RAW age; only the published number is
 * rounded — so 10.04 days against a 10-day bar reads `{ 10.0, true }` (rounding
 * may not un-trip the flag), and 9.96 reads `{ 10.0, false }` (the flag is the
 * verdict; the rounded age is display).
 */
export function summarizeTapeInputStaleness(
  cells: readonly Pick<TapeExpectancyCell, 'provenance'>[],
  nowMs: number,
  thresholdDays: number = TAPE_INPUT_STALE_THRESHOLD_DAYS,
): TapeInputStaleness {
  let oldestToTs: number | null = null;
  let measured = 0;
  let unmeasured = 0;
  for (const c of cells) {
    const toTs = c.provenance.toTs;
    if (typeof toTs === 'number' && Number.isFinite(toTs)) {
      measured += 1;
      oldestToTs = oldestToTs === null ? toTs : Math.min(oldestToTs, toTs);
    } else {
      unmeasured += 1;
    }
  }
  if (oldestToTs === null) {
    return {
      inputTapeAgeDaysMax: null,
      inputTapeToIsoOldest: null,
      inputStale: null,
      inputStaleThresholdDays: thresholdDays,
      inputCellsMeasured: measured,
      inputCellsUnmeasured: unmeasured,
    };
  }
  const rawAgeDays = (nowMs - oldestToTs) / 86_400_000;
  return {
    inputTapeAgeDaysMax: Math.round(rawAgeDays * 10) / 10,
    inputTapeToIsoOldest: new Date(oldestToTs).toISOString(),
    inputStale: rawAgeDays > thresholdDays ? true : unmeasured > 0 ? null : false,
    inputStaleThresholdDays: thresholdDays,
    inputCellsMeasured: measured,
    inputCellsUnmeasured: unmeasured,
  };
}
