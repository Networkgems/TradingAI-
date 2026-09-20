// TRA-4753 — THE COST BAR'S **NUMERATOR**, STAMPED: where each row's `grossR`
// came from, which estimator fold produced it, and how old the tape behind it
// was AT THE DECISION.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// TRA-4745 recovered the cost bar's DENOMINATOR (`barRImplied` — the bar as
// applied). This is the other side. On 2026-09-20 the live route showed, for the
// three enforcing cells, a `grossRQuantiles` block with **zero dispersion**
// (`min === max === mean`) whose constants equalled
// `arm.costBar.edge.otmCells[].lowerCI95` to 15 significant figures — while
// `rowsCompared` was 0, `predicateUnstamped` was 9558 and `predicateSamples` was
// empty on every cell. Value-equality plus zero dispersion is an INFERENCE. The
// board was being asked to move a real-money band on it, and the CFO declined to
// (TRA-4622 comment `ca9a7c95`) precisely because nothing on the payload could
// confirm the direction estimator → gate.
//
// ── WHAT THE CODE SAYS (the confirmation, so a reader need not re-derive it) ──
// The deployed flat form is `tapeExpectancyVerdict`, and the value the gate
// compares against `admissionBarR` is
//
//     grossR = tapeEdgeR(verdict) = verdict.lowerCI95 = cell.lowerCI95
//
// read out of `TapeExpectancyCell` — the `structure × |delta| bucket` cell. The
// candidate contributes `structure` and `delta`, and those SELECT THE CELL; they
// do not enter the number. So `grossR` is a **per-cell constant**, identical for
// every candidate that lands in one cell against one fold of the tape. There is
// no per-candidate modelled edge on the deployed branch, and there is none on the
// net-edge branch either — `netEdgeBarVerdict` is handed `modeledGrossR:
// tapeEdgeR(tape)`, the same cell constant (TRA-3391 Ruling 2.8 made that
// deliberate, so arming the net-edge form could not swap in a more optimistic
// edge).
//
// That is also the whole explanation of the one cell that LOOKED per-candidate:
// `single_leg_otm::0.50-0.55` carries real dispersion across a POOLED fold
// because the tape **re-folds** (`option-tape-expectancy-cache.ts`, 60s TTL plus
// close-invalidation) and its bound moved between folds. The three pinned cells
// are pinned because their tape STOPPED GROWING — their windows end 2026-08-03 /
// 08-04. Dispersion here is a time axis, never a candidate axis.
//
// ── WHY A STAMP AND NOT A JOIN ───────────────────────────────────────────────
// The cell could be re-read from today's estimator at fold time. That read is
// worthless for this question: it is constant across every day BY CONSTRUCTION,
// so it can neither confirm nor refute "one verdict replayed". The value must be
// captured AT THE DECISION, with the generation that produced it, which is what
// this module does.
//
// ── THE SELF-SEALING LOOP THIS MAKES VISIBLE ─────────────────────────────────
// `tapeAgeMsAtDecision` is the field that was missing. `freshness.ageMs` on the
// same object times the RECOMPUTE, not the TAPE: a fold that re-runs every 60s
// over a population that stopped growing seven weeks ago reads `dirty: false,
// ageMs 242366` — indistinguishable from a healthy one. The tape only grows on a
// CLOSED FILL; the gate refuses every candidate that could produce one. Read
// `tapeAgeMsAtLastDecision` against `generations[].rows` before treating a
// refusal streak as a market fact.
//
// PURE, with one bounded memo (below). No env, no I/O, no clock of its own — it
// describes decisions that have already been made and can never change one.

import type { TapeExpectancyTable, TapeExpectancyVerdict } from './option-tape-expectancy.js';

/**
 * Where the compared `grossR` resolved from. Every member today is CELL-LEVEL —
 * that is the finding, not an omission. `per_candidate_model` exists so a future
 * form that genuinely models per candidate has a name to publish under, and so a
 * reader can tell "we checked and it is cell-level" from "nobody asked".
 */
export type GrossRSourceKind =
  /** The deployed comparison: the cell's lower 95% CI bound was read and compared. */
  | 'tape_cell_lower_ci95'
  /** A cell existed but held n < minCellN (or no bound) ⇒ no number, refuse. */
  | 'tape_cell_unmeasured'
  /** `|delta|` mapped to no bucket at all ⇒ there was never a cell to read. */
  | 'no_cell'
  /** The TRA-3394 ratified mandate refused UPSTREAM of every bar-derived number. */
  | 'mandate_deauthorized'
  /** The tape had never been folded in this process ⇒ fail closed. */
  | 'unfolded_tape'
  /** Reserved: a form that computes an edge from THIS candidate's own inputs. */
  | 'per_candidate_model';

/**
 * The numerator's provenance for ONE decision.
 *
 * Shared by reference across every row decided under the same `(cellKey,
 * estimatorGeneration)` — see {@link tapeExpectancyGrossProvenance}. Treat it as
 * FROZEN; a reader that mutates it corrupts every other row of that generation.
 */
export interface GrossRProvenance {
  /**
   * A concrete, greppable LITERAL naming the producing site and field. This is
   * the field TRA-4753's acceptance reads: never `null`, never `'unstamped'` —
   * a row that reached this module always knows where it looked, even when it
   * found nothing.
   */
  source: string;
  kind: GrossRSourceKind;
  /**
   * FALSE ⇒ this number is a property of the CELL: every candidate in the cell,
   * against this fold, was compared against the identical value. TRUE ⇒ it was
   * computed from this candidate's own inputs. Today it is FALSE on every row.
   */
  perCandidate: boolean;
  /** `structure::bucket` the value was read out of; null when no cell existed. */
  cellKey: string | null;
  /**
   * The estimator fold's identity: the table's `computedAt` (ms epoch).
   *
   * ⚠️ NOT `freshness.generation` — that is a per-process counter reset by every
   * redeploy, so two boots emit generation `1` for two different folds and a
   * cross-boot retained fold cannot group on it. `computedAt` is durable.
   */
  estimatorGeneration: number | null;
  /** The value AS APPLIED at this decision; null on every non-comparing branch. */
  grossR: number | null;
  /** Rows the cell held when this decision was made. 0 when no cell. */
  n: number;
  /**
   * The cell's rows by journal `mode` at decision time, e.g. `{ demo: 123, live: 1 }`.
   * A PROPERTY OF THE CELL — never sum it across rows, or 2627 decisions against
   * one 123-row cell publish 323,121 demo rows. The fold below groups by
   * generation for exactly this reason.
   */
  byMode: Record<string, number>;
  /** Oldest / newest `closeTs` among the cell's rows, as of this decision. */
  tapeFromTs: number | null;
  tapeToTs: number | null;
  /** The fold's rolling window in days; null = every retained row. */
  windowDays: number | null;
}

const UNFOLDED: GrossRProvenance = Object.freeze({
  source: 'option-tape-expectancy-cache.ts:peekTapeExpectancyTable → null (never folded in this process)',
  kind: 'unfolded_tape' as const,
  perCandidate: false,
  cellKey: null,
  estimatorGeneration: null,
  grossR: null,
  n: 0,
  byMode: Object.freeze({}) as Record<string, number>,
  tapeFromTs: null,
  tapeToTs: null,
  windowDays: null,
});

/**
 * Bounded memo. The stamp is a PURE function of `(kind, cellKey,
 * estimatorGeneration)` — nothing decision-specific is on it, by design: the
 * per-row part (when the decision happened, and therefore how stale the tape was
 * at that instant) is `rec.ts`, which the ledger already records. So one object
 * can be shared by every row of a generation, and a 20k-decision day costs a
 * handful of objects instead of 20k.
 *
 * ⚠️ This is a memo, not state: it can only ever return a value equal to the one
 * a fresh build would produce. It is bounded because `cellKey × computedAt` grows
 * with every refold.
 */
const MEMO = new Map<string, GrossRProvenance>();
const MEMO_MAX = 256;

/** Test seam — drop the memo between test files. */
export function resetGrossRProvenanceMemoForTests(): void {
  MEMO.clear();
}

function intern(key: string, build: () => GrossRProvenance): GrossRProvenance {
  const hit = MEMO.get(key);
  if (hit) return hit;
  // Cheap eviction: the keys are monotone in `computedAt`, so clearing wholesale
  // drops the oldest generations along with the newest and the next decision
  // re-interns in nanoseconds. A true LRU here would be more machinery than the
  // thing it protects.
  if (MEMO.size >= MEMO_MAX) MEMO.clear();
  const built = Object.freeze(build());
  MEMO.set(key, built);
  return built;
}

/**
 * Stamp the numerator for one flat-form (or net-edge) `cost_bar` verdict.
 *
 * ⚠️ Pass the **SAME `table` object the verdict was computed from**, captured in
 * a local before `tapeExpectancyVerdict` was called. `peekTapeExpectancyTable()`
 * can return a DIFFERENT fold milliseconds later, and a stamp built off a second
 * peek would describe an estimator the gate did not use — which is the exact
 * class of defect this ticket exists to close, one layer down.
 */
export function tapeExpectancyGrossProvenance(
  table: TapeExpectancyTable | null,
  verdict: TapeExpectancyVerdict,
): GrossRProvenance {
  if (table === null) return UNFOLDED;
  const generation = Number.isFinite(table.computedAt) ? table.computedAt : null;
  const cellKey = verdict.cellKey;
  if (cellKey === null) {
    return intern(`no_cell|${generation}`, () => ({
      source:
        'option-tape-expectancy.ts:tapeExpectancyVerdict → no |delta| bucket '
        + '(gross_unknown); no cell was ever read',
      kind: 'no_cell',
      perCandidate: false,
      cellKey: null,
      estimatorGeneration: generation,
      grossR: null,
      n: 0,
      byMode: {},
      tapeFromTs: null,
      tapeToTs: null,
      windowDays: table.windowDays ?? null,
    }));
  }
  const cell = table.cells.find((c) => c.cellKey === cellKey) ?? null;
  // The mandate refuses BEFORE any bar-derived number (TRA-3394), so its rows
  // are labelled by the thing that actually decided them even when the cell's
  // stats happen to be reportable beside it.
  const kind: GrossRSourceKind =
    verdict.reasonCode === 'band_deauthorized'
      ? 'mandate_deauthorized'
      : verdict.lowerCI95 !== null && verdict.reasonCode !== 'insufficient_evidence'
        ? 'tape_cell_lower_ci95'
        : 'tape_cell_unmeasured';
  // `grossR` is the value the comparison USED. On the two non-comparing kinds it
  // is null even when the cell carries a bound — publishing the bound there would
  // assert a comparison that never ran.
  const grossR = kind === 'tape_cell_lower_ci95' ? verdict.lowerCI95 : null;
  const grossKey = grossR === null ? 'null' : String(grossR);
  return intern(`${kind}|${cellKey}|${generation}|${grossKey}`, () => ({
    source:
      kind === 'tape_cell_lower_ci95'
        ? `option-tape-expectancy.ts:tapeEdgeR → TapeExpectancyCell.lowerCI95 [${cellKey}] `
          + '(PER-CELL constant — the candidate selects the cell, it does not enter the number)'
        : kind === 'mandate_deauthorized'
          ? `otm-sleeve-mandate.ts (TRA-3394) → band de-authorized upstream of the bar [${cellKey}]; `
            + 'no edge was weighed'
          : `option-tape-expectancy.ts:tapeExpectancyVerdict → cell [${cellKey}] holds `
            + `n=${cell?.n ?? 0} < minCellN ${table.minCellN} (insufficient_evidence); no bound to compare`,
    kind,
    perCandidate: false,
    cellKey,
    estimatorGeneration: generation,
    grossR,
    n: cell?.n ?? verdict.n ?? 0,
    // Copied, not referenced: the table is re-folded in place and a live
    // reference would let a later fold rewrite a recorded decision's provenance.
    byMode: { ...(cell?.provenance.byMode ?? {}) },
    tapeFromTs: cell?.provenance.fromTs ?? null,
    tapeToTs: cell?.provenance.toTs ?? null,
    windowDays: table.windowDays ?? null,
  }));
}

// ── The published fold ───────────────────────────────────────────────────────

/** One already-recorded decision, as the fold needs to see it. */
export interface GrossRProvenanceRow {
  provenance: GrossRProvenance | null;
  /** ms-epoch the decision was made — the only per-row input, and it dates the tape. */
  decidedAt: number;
}

/**
 * One estimator generation's contribution.
 *
 * ⭐ THE ROW THAT ANSWERS THE TICKET. `rows` is how many live decisions were made
 * against this one fold of this one cell; `grossR` is the single number all of
 * them were compared against. `rows: 2627, generations.length: 1` is "one
 * cell-level verdict replayed 2627 times", published rather than inferred.
 */
export interface GrossRProvenanceGeneration {
  estimatorGeneration: number | null;
  estimatorGenerationIso: string | null;
  /** Decisions made against this generation of this cell. */
  rows: number;
  /** The value as applied. Null on a non-comparing kind. */
  grossR: number | null;
  kind: GrossRSourceKind;
  /** Rows the cell held. NOT multiplied by `rows` — see {@link GrossRProvenance.byMode}. */
  n: number;
  byMode: Record<string, number>;
  tapeFromTs: number | null;
  tapeToTs: number | null;
  tapeFromIso: string | null;
  tapeToIso: string | null;
  /**
   * ⭐ ITEM 3 OF THE ASK — how old the TAPE was when this generation decided,
   * distinct from `freshness.ageMs`, which times the RECOMPUTE. First and last
   * are both published because a generation can span a session.
   */
  tapeAgeMsAtFirstDecision: number | null;
  tapeAgeMsAtLastDecision: number | null;
  firstDecisionAt: number;
  lastDecisionAt: number;
}

/** The per-cell (or whole-gate) numerator provenance fold. */
export interface GrossRProvenanceFold {
  /** Decisions carrying a numerator stamp. */
  rowsStamped: number;
  /**
   * Decisions carrying NONE — every row written before this deploy. The honest
   * coverage denominator: a short `generations` list over a 30-day retained fold
   * is COVERAGE, not a quiet gate. Same contract as `predicateUnstamped`.
   */
  rowsUnstamped: number;
  /** Distinct `source` literals seen, with their row counts. Usually exactly one. */
  sources: { source: string; kind: GrossRSourceKind; rows: number }[];
  /**
   * FALSE ⇒ every stamped row's number was a per-CELL constant. TRUE ⇒ at least
   * one was modelled per candidate. NULL ⇒ nothing stamped yet.
   */
  perCandidate: boolean | null;
  /** Distinct estimator generations these rows were decided against. */
  distinctGenerations: number;
  /** Distinct `grossR` values as applied (nulls excluded). */
  distinctGrossRValues: number;
  /**
   * ⭐ `true` ⇒ two or more decisions, ALL against a per-cell source, ALL against
   * the SAME single value. The refusal streak is then ONE cell-level verdict
   * replayed — it is not N independent measurements of N candidates, and its
   * count carries no more evidence than its first row does.
   *
   * ⚠️ It is a statement about these ROWS, not about the gate: a cell whose bound
   * genuinely held still for a day reads `true` and is working exactly as
   * designed. Read it with `generations[].tapeAgeMsAtLastDecision`.
   */
  constantAcrossRows: boolean;
  /** Newest generation first. Capped; see `generationsTruncated`. */
  generations: GrossRProvenanceGeneration[];
  /** Generations dropped by the cap. > 0 ⇒ `generations` is a head, not the set. */
  generationsTruncated: number;
  /** Max tape age over the stamped rows, at their own decision instants. */
  tapeAgeMsMaxAtDecision: number | null;
  /** Newest `closeTs` any stamped row's cell had behind it. */
  tapeToTsMax: number | null;
}

const MAX_GENERATIONS = 12;

function isoOrNull(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

/**
 * Fold a group of decisions into their numerator provenance. PURE; reads nothing
 * but the rows handed to it.
 *
 * Grouping key is `(estimatorGeneration, cellKey, grossR, kind)` — NOT generation
 * alone. Two cells share a fold instant, and a group that pooled them would
 * publish a `byMode` and an `n` belonging to neither.
 */
export function foldGrossRProvenance(rows: readonly GrossRProvenanceRow[]): GrossRProvenanceFold | null {
  if (rows.length === 0) return null;
  const groups = new Map<string, GrossRProvenanceGeneration>();
  const sources = new Map<string, { source: string; kind: GrossRSourceKind; rows: number }>();
  const grossValues = new Set<number>();
  const generationIds = new Set<string>();
  let rowsStamped = 0;
  let rowsUnstamped = 0;
  let anyPerCandidate = false;
  let tapeAgeMax: number | null = null;
  let tapeToTsMax: number | null = null;

  for (const row of rows) {
    const p = row.provenance;
    if (p === null) {
      rowsUnstamped += 1;
      continue;
    }
    rowsStamped += 1;
    if (p.perCandidate) anyPerCandidate = true;
    if (p.grossR !== null && Number.isFinite(p.grossR)) grossValues.add(p.grossR);
    generationIds.add(String(p.estimatorGeneration));
    if (p.tapeToTs !== null) {
      tapeToTsMax = tapeToTsMax === null ? p.tapeToTs : Math.max(tapeToTsMax, p.tapeToTs);
      const age = row.decidedAt - p.tapeToTs;
      if (Number.isFinite(age)) tapeAgeMax = tapeAgeMax === null ? age : Math.max(tapeAgeMax, age);
    }
    const src = sources.get(p.source);
    if (src) src.rows += 1;
    else sources.set(p.source, { source: p.source, kind: p.kind, rows: 1 });

    const key = `${p.estimatorGeneration}|${p.cellKey}|${p.grossR}|${p.kind}`;
    const g = groups.get(key);
    if (g) {
      g.rows += 1;
      if (row.decidedAt < g.firstDecisionAt) g.firstDecisionAt = row.decidedAt;
      if (row.decidedAt > g.lastDecisionAt) g.lastDecisionAt = row.decidedAt;
    } else {
      groups.set(key, {
        estimatorGeneration: p.estimatorGeneration,
        estimatorGenerationIso: isoOrNull(p.estimatorGeneration),
        rows: 1,
        grossR: p.grossR,
        kind: p.kind,
        n: p.n,
        byMode: { ...p.byMode },
        tapeFromTs: p.tapeFromTs,
        tapeToTs: p.tapeToTs,
        tapeFromIso: isoOrNull(p.tapeFromTs),
        tapeToIso: isoOrNull(p.tapeToTs),
        tapeAgeMsAtFirstDecision: null,
        tapeAgeMsAtLastDecision: null,
        firstDecisionAt: row.decidedAt,
        lastDecisionAt: row.decidedAt,
      });
    }
  }

  if (rowsStamped === 0) {
    return {
      rowsStamped: 0,
      rowsUnstamped,
      sources: [],
      perCandidate: null,
      distinctGenerations: 0,
      distinctGrossRValues: 0,
      constantAcrossRows: false,
      generations: [],
      generationsTruncated: 0,
      tapeAgeMsMaxAtDecision: null,
      tapeToTsMax: null,
    };
  }

  const all = [...groups.values()];
  for (const g of all) {
    if (g.tapeToTs !== null) {
      g.tapeAgeMsAtFirstDecision = g.firstDecisionAt - g.tapeToTs;
      g.tapeAgeMsAtLastDecision = g.lastDecisionAt - g.tapeToTs;
    }
  }
  // Newest fold first, then biggest — a reader scanning the head sees what the
  // gate is doing NOW, which is the question a stale-tape read is asked about.
  all.sort(
    (a, b) => (b.estimatorGeneration ?? 0) - (a.estimatorGeneration ?? 0) || b.rows - a.rows,
  );

  return {
    rowsStamped,
    rowsUnstamped,
    sources: [...sources.values()].sort((a, b) => b.rows - a.rows),
    perCandidate: anyPerCandidate,
    distinctGenerations: generationIds.size,
    distinctGrossRValues: grossValues.size,
    constantAcrossRows: rowsStamped >= 2 && !anyPerCandidate && grossValues.size === 1,
    generations: all.slice(0, MAX_GENERATIONS),
    generationsTruncated: Math.max(0, all.length - MAX_GENERATIONS),
    tapeAgeMsMaxAtDecision: tapeAgeMax,
    tapeToTsMax,
  };
}
