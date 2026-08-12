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
}

/** Provenance for the fold — what went in, what was dropped, and on what basis. */
export interface TapeExpectancyTable {
  /** Rows offered to the fold (post model-facing basis). */
  rowsConsidered: number;
  /** Closed rows that produced a cell contribution. */
  rowsUsed: number;
  /** Dropped: still open, or no finite `realizedR`. */
  rowsDroppedUnresolved: number;
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
  const cutoff =
    windowDays !== null && Number.isFinite(windowDays) && windowDays > 0
      ? computedAt - windowDays * 24 * 60 * 60 * 1000
      : null;

  let rowsDroppedUnresolved = 0;
  let rowsDroppedUnknownDelta = 0;
  let rowsDroppedNoGateBasis = 0;
  let rowsDroppedOutOfWindow = 0;
  let rowsUsed = 0;
  let fromTs: number | null = null;
  let toTs: number | null = null;

  /** cellKey -> gate-basis realized R values. */
  const cells = new Map<string, { structure: string; bucket: string; values: number[] }>();

  for (const r of rows) {
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
      cell = { structure, bucket, values: [] };
      cells.set(key, cell);
    }
    cell.values.push(r.realizedR * GATE_R_PER_PREMIUM_R);
    rowsUsed += 1;
    if (closeTs !== null) {
      fromTs = fromTs === null ? closeTs : Math.min(fromTs, closeTs);
      toTs = toTs === null ? closeTs : Math.max(toTs, closeTs);
    }
  }

  const bucketOrder = tapeExpectancyBucketOrder();
  const out: TapeExpectancyCell[] = [...cells.entries()]
    .map(([cellKey, { structure, bucket, values }]) => {
      const n = values.length;
      const mean = values.reduce((a, v) => a + v, 0) / n;
      // Sample SD (n−1): the unbiased dispersion estimate a CI on the mean needs.
      // Undefined at n=1 — which declines anyway, well under minCellN.
      const sd =
        n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : null;
      const se = sd !== null ? sd / Math.sqrt(n) : null;
      const lowerCI95 = se !== null ? mean - TAPE_EXPECTANCY_Z95 * se : null;
      const barR = admissionBarR(structure, config);
      const band = TAPE_EXPECTANCY_BANDS.find((b) => b.label === bucket)!;
      return {
        structure,
        bucket,
        cellKey,
        deltaFrom: band.from,
        deltaTo: band.to,
        n,
        meanR_gate: mean,
        sdR_gate: sd,
        seR_gate: se,
        lowerCI95,
        barR,
        admits: n >= minCellN && lowerCI95 !== null && lowerCI95 >= barR,
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
