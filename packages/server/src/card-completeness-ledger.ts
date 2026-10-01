/**
 * TRA-4936 — the per-ET-day Trade Opportunity Card completeness fold, OUTSIDE
 * the card ring.
 *
 * ## The defect this exists to remove
 *
 * `/api/cards` keeps the newest {@link MAX_SIGNALS}=50 cards. Measured live on
 * 2026-09-27T22:17:37Z against `66a8a1ab40cc`: `signalTypeCounts
 * .otm_mispricing.built` read **907** while the ring held **50**, every one of
 * them stamped 15:49–15:54 ET — a 328-second span at the end of Friday's
 * session. 857 cards (94.5%) were evicted unread.
 *
 * Recency is not a neutral sampler here, it is **anti-correlated with
 * admissibility**. The TRA-3942 entry windows close at 15:45 ET and the scanner
 * keeps building cards until the close, so a newest-50 ring is *always*
 * back-filled with out-of-window rows before any post-close reader arrives.
 * `summary.complete` is therefore **structurally pinned at 0** for every read
 * after 15:45 ET — which makes a healthy card builder read exactly like a
 * broken one. Three consecutive attempts to grade TRA-4645 roadmap priorities
 * 1 and 4 each came back with an artifact instead of an answer.
 *
 * ⛔ The remedy is NOT a bigger `MAX_SIGNALS`. A wider FIFO evicts the rare
 * class later, not less (TRA-4920 measured that exact non-fix on the census
 * ring). The remedy is a counter and a retention path that the ring cannot
 * reach, which is what TRA-4788 already did for `signalTypeCounts` and what
 * this module does for completeness.
 *
 * ## What it is
 *
 * One row per (ET calendar day × `signalType`), incremented at the card sink as
 * each card is built — never derived by folding the ring, which would reproduce
 * the exact cap this exists to escape. Each row carries the day's `built` /
 * `complete` tallies, the same `refusedByField` / `missingByField` folds
 * `summarizeCards` publishes, and ONE retained exemplar card so the answer is
 * inspectable rather than only countable.
 *
 * ## The window partition is the point
 *
 * An out-of-window card counted as an ordinary failure is the bug. So the
 * window buckets NEVER share a cell: `in_window`, `out_of_window` and
 * `not_applicable` are three disjoint sub-folds, and the row's `built` is their
 * sum by construction. A day with zero in-window cards reads
 * `builtInWindow: 0`, which is distinguishable from a day that had in-window
 * cards and none of them completed — today those two read identically.
 *
 * Applicability is checked BEFORE the window (TRA-4645's lesson: a dark cell is
 * a lever only if applicability is checked first). The TRA-3942 gate is called
 * from the OTM open path and nowhere else, so every other carded family is
 * `not_applicable` — booking a `momentum` card as `out_of_window` would
 * manufacture a refusal nobody imposed.
 *
 * ## Fail direction on the retention cap
 *
 * Days are bounded ({@link RETAINED_ET_DAYS}) and the OLDEST day is dropped —
 * a day-granular eviction, not a row-granular FIFO, so the rare class cannot be
 * evicted by volume within its own day. Dropped days are COUNTED and named in
 * {@link CardCompletenessView.coverage}, and the per-type `sinceBoot` roll never
 * evicts at all, so "has this product EVER produced a complete card" survives
 * the cap even when the day it happened on does not.
 */

import type { TradeOpportunityCard } from './trade-opportunity-card.js';
import { etDateKey } from './et-clock.js';
import { OTM_ENTRY_WINDOW_CLOSED_CODE } from './otm-entry-window.js';

/**
 * Carded signal families the TRA-3942 ENTRY-TIME window gates.
 *
 * `otmEntryWindowRejectReason` is called from exactly one place — the OTM open
 * path in `runOtmScan` — so this list is that call site's signal type and
 * nothing else. Every other carded family is `not_applicable`: it has no
 * admission window, and giving it one in the fold would invent a constraint the
 * engine does not apply.
 */
export const WINDOW_GATED_CARD_SIGNAL_TYPES: readonly string[] = Object.freeze([
  'otm_mispricing',
]);

/**
 * Does the TRA-3942 entry window apply to this carded family at all?
 *
 * Call this BEFORE reading any window state. A family the gate never evaluates
 * has no side of the window, and labelling it `out_of_window` because the clock
 * happens to read 15:54 ET would invent a refusal nobody imposed.
 */
export function isWindowGatedCardSignalType(signalType: string): boolean {
  return WINDOW_GATED_CARD_SIGNAL_TYPES.includes(signalType);
}

/** How many ET days the per-day fold retains before dropping the oldest. */
export const RETAINED_ET_DAYS = 14;

/**
 * Which side of the TRA-3942 admission window a card was built on.
 *
 * `not_applicable` is a THIRD value on purpose, never folded into either of the
 * other two: a `momentum` card is not "in the window" (there is no window) and
 * is not "out of" one either.
 */
export type CardAdmissionWindowBucket = 'in_window' | 'out_of_window' | 'not_applicable';

/** The three buckets, in payload order. Exported so readers can iterate them. */
export const CARD_ADMISSION_WINDOW_BUCKETS: readonly CardAdmissionWindowBucket[] = Object.freeze([
  'in_window',
  'out_of_window',
  'not_applicable',
]);

/**
 * Which side of the window a card was built on, from the SAME source the card's
 * own `not_suppressed` criterion reads.
 *
 * The card builder's `not_suppressed` criterion reads `signal.signalSkipReason`
 * — prose, with the clock, the window spec and the resolution source
 * interpolated into it. `signalSkipReasonCode` is the low-cardinality twin
 * stamped in the SAME breath at `signal-engine.ts`'s window reject, and it is
 * the countable axis (TRA-3953 made it load-bearing for exactly this reason).
 * Folding on the prose would yield one bucket per decision.
 *
 * The window is the FIRST cut on the OTM funnel and it `continue`s, so a card
 * carrying any other skip code reached a gate BELOW the window and was
 * therefore in-window by construction. An unreadable ET clock stamps this same
 * code (the gate fails closed), so it lands in `out_of_window` — correct: the
 * entry was refused and nothing was admitted.
 */
export function classifyCardAdmissionWindow(
  signalType: string,
  skipReasonCode: string | null | undefined,
): CardAdmissionWindowBucket {
  // Applicability FIRST. A family with no window has no side of it.
  if (!isWindowGatedCardSignalType(signalType)) return 'not_applicable';
  return skipReasonCode === OTM_ENTRY_WINDOW_CLOSED_CODE ? 'out_of_window' : 'in_window';
}

/** Per-window-bucket sub-fold. The three of these sum to the row's own tallies. */
export interface CardCompletenessWindowCell {
  built: number;
  complete: number;
  /** Cards with ≥1 field the builder could not populate (the defect cell). */
  unbuildable: number;
  /** Per-field count of cards that built the field and whose rule declined entry. */
  refusedByField: Record<string, number>;
  /** Per-field count of cards that could not BUILD the field. */
  missingByField: Record<string, number>;
  /**
   * Oldest / newest `generatedAt` that landed in THIS bucket, `null` while the
   * bucket is empty (TRA-4936 provenance, CEO 2026-10-01).
   *
   * The row's own `firstBuiltAt`/`lastBuiltAt` span every bucket, so on a day
   * where the window side produced nothing they still read as healthy
   * timestamps — which is the confusion this ticket exists to kill, one level
   * down. `byWindow.in_window.lastBuiltAt === null` beside a populated
   * `byWindow.out_of_window.lastBuiltAt` says the classifier demonstrably RAN
   * and routed every card to the other side; `null` in both says nothing was
   * observed at all. Those are different findings.
   */
  firstBuiltAt: number | null;
  lastBuiltAt: number | null;
}

/**
 * The retained exemplar for one (ET day × signalType) — the "here is the actual
 * card" half of the answer, so a non-zero `complete` is inspectable and not
 * just a tally.
 */
export interface CardCompletenessExemplar {
  signalId: string;
  symbol: string;
  generatedAt: number;
  complete: boolean;
  window: CardAdmissionWindowBucket;
  incompleteFields: string[];
  refusedFields: string[];
  /** `incompleteFields.length + refusedFields.length`. Lower is more complete. */
  shortfall: number;
  /** The card itself. One per day per family, so the cost is bounded. */
  card: TradeOpportunityCard;
}

/** One (ET day × signalType) row. */
export interface CardCompletenessRow {
  /** ET CALENDAR day (`etDateKey`), not a trading session. */
  etDay: string;
  signalType: string;
  built: number;
  complete: number;
  /** = `byWindow.in_window.built`, hoisted because it is the headline cell. */
  builtInWindow: number;
  builtOutOfWindow: number;
  builtWindowNotApplicable: number;
  completeInWindow: number;
  completeOutOfWindow: number;
  byWindow: Record<CardAdmissionWindowBucket, CardCompletenessWindowCell>;
  /**
   * Independent cross-check of the bucket above against a FRESH
   * `otmEntryWindowVerdict` read at the card's own `generatedAt`, when the
   * caller supplied one. The bucket is decided by the stamp (the decision that
   * was actually taken); this column says whether a second, independently
   * computed reading agreed. `clockUnreadable` is its own cell — "could not
   * check" must never share a number with "checked and it agreed".
   */
  windowStampVsClock: {
    checked: number;
    agreed: number;
    disagreed: number;
    clockUnreadable: number;
  };
  exemplar: CardCompletenessExemplar | null;
  firstBuiltAt: number;
  lastBuiltAt: number;
}

/**
 * Never-evicted per-family roll. Survives the day cap; dies with the process.
 *
 * This is the row that answers "can this product EVER produce a complete Trade
 * Opportunity Card", which is the question the ring could not hold the evidence
 * for. `etDaysWithComplete: 0` alongside `etDaysWithInWindow: 0` says the
 * in-window population was never sampled; `etDaysWithComplete: 0` alongside a
 * non-zero `etDaysWithInWindow` says it WAS sampled and nothing completed.
 * Those are different findings and the ring conflated them.
 */
export interface CardCompletenessSinceBootRow {
  built: number;
  complete: number;
  builtInWindow: number;
  builtOutOfWindow: number;
  builtWindowNotApplicable: number;
  /** ET days this family built at least one card on. */
  etDaysSeen: number;
  /** ET days this family produced at least one `complete` card on. */
  etDaysWithComplete: number;
  /** Most recent ET day with a `complete` card, or null if there has never been one. */
  lastCompleteEtDay: string | null;
  /** ET days this family built at least one IN-WINDOW card on. */
  etDaysWithInWindow: number;
  /** Oldest / newest `generatedAt` this family ever folded, any bucket. */
  firstBuiltAt: number;
  lastBuiltAt: number;
  /**
   * Newest `generatedAt` that landed IN WINDOW, and its ET day — `null` when the
   * in-window population has never been sampled (TRA-4936 provenance).
   *
   * This is the cell that dates the last time the publish sink ran while the
   * admission window was open. On 2026-10-01 the sink's last run was stamped
   * 10:14:43 ET, 17 seconds BEFORE the 10:15 window opened, and nothing ran for
   * the 70 minutes the window was then open — a fact `lastBuiltAt` alone cannot
   * state, because it reads as a perfectly recent timestamp.
   */
  lastInWindowBuiltAt: number | null;
  lastInWindowEtDay: string | null;
}

/**
 * Why a family's `builtInWindow` reads the number it reads.
 *
 * `builtInWindow: 0` has FOUR causes that are indistinguishable from the cell
 * itself, and conflating them is the defect one layer below the one this ticket
 * was filed for (CEO, 2026-10-01): "0 because nothing was produced" must not
 * read the same as "0 because the fold is not wired".
 *
 * - `in_window_measured_nonzero` — the window population was sampled and is
 *   non-empty. `builtInWindow` is a real measurement.
 * - `in_window_measured_zero` — the sink ran, the fold saw every card, the
 *   classifier routed them, and **none** landed in window. The zero is REAL.
 *   This is the headline the fold exists to publish, not a wiring bug.
 * - `fold_not_reached` — the engine attempted cards for this family and the fold
 *   observed none of them. The zero says nothing about the market.
 * - `sink_never_ran` — the engine never even attempted a card for this family.
 * - `window_not_applicable` — the family is not window-gated, so it has no side
 *   of a window. Applicability FIRST: a family with no window must never be
 *   reported as a family that failed to reach one.
 * - `attempted_unreadable` — no `attemptedByType` was supplied, so the
 *   attempted-vs-observed identity could not be evaluated. "Could not check"
 *   gets its own name and never borrows a verdict from "checked and it is fine".
 */
export type CardFoldWiringVerdict =
  | 'in_window_measured_nonzero'
  | 'in_window_measured_zero'
  | 'fold_not_reached'
  | 'sink_never_ran'
  | 'window_not_applicable'
  | 'attempted_unreadable';

/** One per family the engine attempted OR the fold observed — the union, never one side. */
export interface CardCompletenessWiringRow {
  signalType: string;
  /**
   * The engine's own pre-try `attempted` counter, or `null` when the caller
   * supplied none.
   *
   * This is the term that makes the partition exhaustive, and it has to come
   * from OUTSIDE the fold: `bumpCardTypeCount(type, 'attempted')` is the first
   * statement in `recordOpportunityCard`, ABOVE the `try`, so it increments even
   * when everything below it — including this fold's own `record()` — throws.
   * A counter that only the fold maintains cannot distinguish "the fold was
   * never called" from "nothing ever happened", because in both cases the fold
   * holds zero.
   */
  attempted: number | null;
  /** `record()` calls this family's fold actually received. */
  observed: number;
  /** Cards folded into a RETAINED ET day; below `observed` when the day cap dropped some. */
  foldedIntoRetainedDays: number;
  builtInWindow: number;
  builtOutOfWindow: number;
  builtWindowNotApplicable: number;
  /** Newest `generatedAt` observed, any bucket. */
  lastBuiltAt: number | null;
  /** Newest `generatedAt` observed IN WINDOW — the CEO's provenance stamp. */
  lastInWindowBuiltAt: number | null;
  /** `attempted - observed`, or null when `attempted` is unreadable. */
  unobserved: number | null;
  verdict: CardFoldWiringVerdict;
}

/**
 * TRA-4936 provenance. Published so a reader who finds `builtInWindow: 0` can
 * tell which of the causes above produced it WITHOUT dividing two numbers on two
 * different keys — the TRA-4748 rule the ring's own coverage block already obeys.
 */
export interface CardCompletenessWiring {
  attemptedSource: 'engine_card_type_counts' | 'not_supplied';
  /** Total `record()` calls across every family. 0 ⇒ the fold was never reached. */
  observations: number;
  /** Newest `generatedAt` the fold has ever seen, any family, any bucket. */
  lastObservedBuiltAt: number | null;
  /** Newest `generatedAt` the fold has ever seen IN WINDOW. */
  lastInWindowBuiltAt: number | null;
  families: CardCompletenessWiringRow[];
  note: string;
}

/**
 * TRA-4748-style coverage. The surface must be able to say "I kept N of M, here
 * is what I dropped" — a reader must not have to divide two numbers on two
 * different keys to discover a loss rate.
 */
export interface CardCompletenessCoverage {
  retainedEtDays: string[];
  etDaysRetained: number;
  etDaysSeen: number;
  etDaysDropped: number;
  retainedDayCap: number;
  oldestDroppedEtDay: string | null;
  newestDroppedEtDay: string | null;
  /** Wall clock the fold started counting at (engine construction ≈ process boot). */
  countsSince: string;
  countsSinceBoot: true;
  note: string;
}

export interface CardCompletenessView {
  coverage: CardCompletenessCoverage;
  /** Why each family's `builtInWindow` reads what it reads. See {@link CardCompletenessWiring}. */
  wiring: CardCompletenessWiring;
  /** Newest ET day first; within a day, `signalType` ascending. */
  days: CardCompletenessRow[];
  /** Every family that has built a card, never evicted. */
  sinceBoot: Record<string, CardCompletenessSinceBootRow>;
}

/** The optional independent clock reading, for the cross-check column. */
export interface CardWindowClockReading {
  /** `otmEntryWindowVerdict(...).open` at the card's `generatedAt`. */
  open: boolean;
  /** FALSE ⇒ the ET wall clock could not be read; the reading proves nothing. */
  clockReadable: boolean;
}

function emptyCell(): CardCompletenessWindowCell {
  return {
    built: 0,
    complete: 0,
    unbuildable: 0,
    refusedByField: {},
    missingByField: {},
    firstBuiltAt: null,
    lastBuiltAt: null,
  };
}

function cloneCell(cell: CardCompletenessWindowCell): CardCompletenessWindowCell {
  return {
    built: cell.built,
    complete: cell.complete,
    unbuildable: cell.unbuildable,
    refusedByField: { ...cell.refusedByField },
    missingByField: { ...cell.missingByField },
    firstBuiltAt: cell.firstBuiltAt,
    lastBuiltAt: cell.lastBuiltAt,
  };
}

function bump(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

function shortfallOf(card: TradeOpportunityCard): number {
  return card.incompleteFields.length + card.refusedFields.length;
}

/**
 * Is `candidate` a STRICTLY better exemplar than the incumbent?
 *
 * The comparison is lexicographic over (complete, window-rank, −shortfall) and
 * it is **strict**: an equal candidate loses. That is the eviction direction
 * AC4 pins — a card built after the admission window cannot displace an
 * in-window `complete` card, and neither can an equally-good later card
 * displace an earlier one, so the retained row is stable for the rest of the
 * day once the best card has landed.
 *
 * `windowRank` treats `in_window` and `not_applicable` alike (1) and
 * `out_of_window` as 0: an un-gated family must not be penalised for a window
 * it never had. Note that an out-of-window card can never be `complete` in
 * practice — the window refusal is what makes the card's `not_suppressed`
 * criterion fail — but the ranking does not rely on that, because a ranking
 * that is only correct while a structural coincidence holds is not a ranking.
 */
function beatsIncumbent(
  candidate: { complete: boolean; window: CardAdmissionWindowBucket; shortfall: number },
  incumbent: { complete: boolean; window: CardAdmissionWindowBucket; shortfall: number },
): boolean {
  const rank = (w: CardAdmissionWindowBucket): number => (w === 'out_of_window' ? 0 : 1);
  if (candidate.complete !== incumbent.complete) return candidate.complete;
  const cr = rank(candidate.window);
  const ir = rank(incumbent.window);
  if (cr !== ir) return cr > ir;
  return candidate.shortfall < incumbent.shortfall;
}

/**
 * The per-ET-day completeness fold.
 *
 * Deliberately NOT cleared by `forceReset` / `clearSignals`, for the same
 * reason `cardTypeCounts` is not: those verbs clear the DISPLAY, and a census
 * that a display reset can zero is a census a reader cannot trust. It dies with
 * the process, and {@link CardCompletenessCoverage.countsSince} labels that
 * window rather than leaving the reader to assume it.
 */
export class CardCompletenessLedger {
  private readonly days = new Map<string, Map<string, CardCompletenessRow>>();
  private readonly sinceBoot = new Map<string, CardCompletenessSinceBootRow>();
  /**
   * Per-family ET-day membership for the day-granular `sinceBoot` columns.
   *
   * Held as explicit sets rather than derived from the day map, because the day
   * map EVICTS and these columns must not: a `lastCompleteEtDay` that a day
   * eviction can erase is exactly the instrument this ticket is replacing.
   * Cardinality is (carded families ≤ 20) × (ET days of process uptime), and
   * this process restarts several times a day.
   */
  private readonly sinceBootDays = new Map<
    string,
    { seen: Set<string>; complete: Set<string>; inWindow: Set<string> }
  >();
  private readonly countsSince: number;
  private readonly etDayKeysSeen = new Set<string>();
  private etDaysDropped = 0;
  private oldestDroppedEtDay: string | null = null;
  private newestDroppedEtDay: string | null = null;

  constructor(now: number = Date.now(), private readonly dayCap: number = RETAINED_ET_DAYS) {
    this.countsSince = now;
  }

  /**
   * Record one BUILT card. Call this at the card sink, beside the per-family
   * `built` counter, so the two agree by construction and a disagreement is a
   * real finding rather than two code paths drifting.
   *
   * @param card   the card as built (its `generatedAt` fixes the ET day)
   * @param skipReasonCode `signal.signalSkipReasonCode` — the low-cardinality
   *   emission-time refusal code; see {@link classifyCardAdmissionWindow}
   * @param clock  optional independent window reading for the cross-check column
   */
  record(
    card: TradeOpportunityCard,
    skipReasonCode: string | null | undefined,
    clock?: CardWindowClockReading | null,
  ): void {
    const bucket = classifyCardAdmissionWindow(card.signalType, skipReasonCode);
    const etDay = etDateKey(card.generatedAt);

    // sinceBoot FIRST and unconditionally. The per-day fold below can decline a
    // card whose ET day already fell out of the retained window; the never-
    // evicting roll must still see it, or the cap would be able to hide the one
    // complete card the whole surface exists to find.
    this.bumpSinceBoot(card, bucket, etDay);

    this.etDayKeysSeen.add(etDay);
    let byType = this.days.get(etDay);
    if (!byType) {
      byType = new Map<string, CardCompletenessRow>();
      this.days.set(etDay, byType);
      this.evictOldestDaysOverCap();
      // The day we just created can itself be the one evicted, when a card
      // arrives stamped older than every retained day. Then there is nothing to
      // fold into; the drop is counted in coverage and `sinceBoot` already has
      // the card.
      if (!this.days.has(etDay)) return;
    }
    let row = byType.get(card.signalType);
    if (!row) {
      row = {
        etDay,
        signalType: card.signalType,
        built: 0,
        complete: 0,
        builtInWindow: 0,
        builtOutOfWindow: 0,
        builtWindowNotApplicable: 0,
        completeInWindow: 0,
        completeOutOfWindow: 0,
        byWindow: {
          in_window: emptyCell(),
          out_of_window: emptyCell(),
          not_applicable: emptyCell(),
        },
        windowStampVsClock: { checked: 0, agreed: 0, disagreed: 0, clockUnreadable: 0 },
        exemplar: null,
        firstBuiltAt: card.generatedAt,
        lastBuiltAt: card.generatedAt,
      };
      byType.set(card.signalType, row);
    }

    const cell = row.byWindow[bucket];
    row.built += 1;
    cell.built += 1;
    // Per-BUCKET span. An empty bucket stays null rather than inheriting the
    // row's span, so "this side of the window produced nothing" is readable
    // without subtracting two other cells.
    cell.firstBuiltAt =
      cell.firstBuiltAt === null ? card.generatedAt : Math.min(cell.firstBuiltAt, card.generatedAt);
    cell.lastBuiltAt =
      cell.lastBuiltAt === null ? card.generatedAt : Math.max(cell.lastBuiltAt, card.generatedAt);
    if (card.complete) {
      row.complete += 1;
      cell.complete += 1;
      if (bucket === 'in_window') row.completeInWindow += 1;
      if (bucket === 'out_of_window') row.completeOutOfWindow += 1;
    }
    if (card.incompleteFields.length > 0) cell.unbuildable += 1;
    for (const f of card.incompleteFields) bump(cell.missingByField, f);
    for (const f of card.refusedFields) bump(cell.refusedByField, f);
    if (bucket === 'in_window') row.builtInWindow += 1;
    else if (bucket === 'out_of_window') row.builtOutOfWindow += 1;
    else row.builtWindowNotApplicable += 1;
    row.firstBuiltAt = Math.min(row.firstBuiltAt, card.generatedAt);
    row.lastBuiltAt = Math.max(row.lastBuiltAt, card.generatedAt);

    // The cross-check: only meaningful where a window exists at all.
    if (clock && bucket !== 'not_applicable') {
      if (!clock.clockReadable) row.windowStampVsClock.clockUnreadable += 1;
      else {
        row.windowStampVsClock.checked += 1;
        const clockBucket: CardAdmissionWindowBucket = clock.open ? 'in_window' : 'out_of_window';
        if (clockBucket === bucket) row.windowStampVsClock.agreed += 1;
        else row.windowStampVsClock.disagreed += 1;
      }
    }

    const candidate = { complete: card.complete, window: bucket, shortfall: shortfallOf(card) };
    if (row.exemplar === null || beatsIncumbent(candidate, row.exemplar)) {
      row.exemplar = {
        signalId: card.signalId,
        symbol: card.symbol,
        generatedAt: card.generatedAt,
        complete: card.complete,
        window: bucket,
        incompleteFields: [...card.incompleteFields],
        refusedFields: [...card.refusedFields],
        shortfall: candidate.shortfall,
        card,
      };
    }
  }

  private bumpSinceBoot(
    card: TradeOpportunityCard,
    bucket: CardAdmissionWindowBucket,
    etDay: string,
  ): void {
    let roll = this.sinceBoot.get(card.signalType);
    if (!roll) {
      roll = {
        built: 0,
        complete: 0,
        builtInWindow: 0,
        builtOutOfWindow: 0,
        builtWindowNotApplicable: 0,
        etDaysSeen: 0,
        etDaysWithComplete: 0,
        lastCompleteEtDay: null,
        etDaysWithInWindow: 0,
        firstBuiltAt: card.generatedAt,
        lastBuiltAt: card.generatedAt,
        lastInWindowBuiltAt: null,
        lastInWindowEtDay: null,
      };
      this.sinceBoot.set(card.signalType, roll);
    }
    let seen = this.sinceBootDays.get(card.signalType);
    if (!seen) {
      seen = { seen: new Set<string>(), complete: new Set<string>(), inWindow: new Set<string>() };
      this.sinceBootDays.set(card.signalType, seen);
    }
    roll.built += 1;
    roll.firstBuiltAt = Math.min(roll.firstBuiltAt, card.generatedAt);
    roll.lastBuiltAt = Math.max(roll.lastBuiltAt, card.generatedAt);
    seen.seen.add(etDay);
    roll.etDaysSeen = seen.seen.size;
    if (card.complete) {
      roll.complete += 1;
      seen.complete.add(etDay);
      roll.etDaysWithComplete = seen.complete.size;
      if (roll.lastCompleteEtDay === null || etDay > roll.lastCompleteEtDay) {
        roll.lastCompleteEtDay = etDay;
      }
    }
    if (bucket === 'in_window') {
      roll.builtInWindow += 1;
      seen.inWindow.add(etDay);
      roll.etDaysWithInWindow = seen.inWindow.size;
      // The provenance stamp: when did the sink last run while the window was
      // OPEN. Kept on the never-evicting roll so the day cap cannot erase it.
      if (roll.lastInWindowBuiltAt === null || card.generatedAt > roll.lastInWindowBuiltAt) {
        roll.lastInWindowBuiltAt = card.generatedAt;
        roll.lastInWindowEtDay = etDay;
      }
    } else if (bucket === 'out_of_window') roll.builtOutOfWindow += 1;
    else roll.builtWindowNotApplicable += 1;
  }

  /**
   * Build the provenance block.
   *
   * The family list is the **UNION** of the engine's attempted keys and the
   * fold's own keys, never one side: a family the engine attempted and the fold
   * never saw (`fold_not_reached`) only exists on the engine side, and reading
   * the fold's keys alone would make it vanish — the absence would then render
   * as an ordinary empty surface, which is the shape of every bug on this
   * ticket.
   */
  private buildWiring(
    days: CardCompletenessRow[],
    attemptedByType?: Readonly<Record<string, number>>,
  ): CardCompletenessWiring {
    const foldedByType = new Map<string, number>();
    for (const row of days) {
      foldedByType.set(row.signalType, (foldedByType.get(row.signalType) ?? 0) + row.built);
    }

    const families = new Set<string>(this.sinceBoot.keys());
    if (attemptedByType) for (const t of Object.keys(attemptedByType)) families.add(t);

    const rows: CardCompletenessWiringRow[] = [];
    let observations = 0;
    let lastObservedBuiltAt: number | null = null;
    let lastInWindowBuiltAt: number | null = null;

    for (const signalType of [...families].sort()) {
      const roll = this.sinceBoot.get(signalType);
      const observed = roll?.built ?? 0;
      const attempted = attemptedByType ? (attemptedByType[signalType] ?? 0) : null;
      observations += observed;
      if (roll) {
        if (lastObservedBuiltAt === null || roll.lastBuiltAt > lastObservedBuiltAt) {
          lastObservedBuiltAt = roll.lastBuiltAt;
        }
        if (
          roll.lastInWindowBuiltAt !== null
          && (lastInWindowBuiltAt === null || roll.lastInWindowBuiltAt > lastInWindowBuiltAt)
        ) {
          lastInWindowBuiltAt = roll.lastInWindowBuiltAt;
        }
      }

      // Applicability FIRST, exactly as `classifyCardAdmissionWindow` does it.
      // A family with no window has no side of one, so its zero is not a finding
      // and must not be reported in the same cell as one that is.
      const windowGated = isWindowGatedCardSignalType(signalType);
      let verdict: CardFoldWiringVerdict;
      if (attempted === null) verdict = 'attempted_unreadable';
      else if (!windowGated) verdict = 'window_not_applicable';
      else if (attempted === 0 && observed === 0) verdict = 'sink_never_ran';
      else if (observed === 0) verdict = 'fold_not_reached';
      else if ((roll?.builtInWindow ?? 0) > 0) verdict = 'in_window_measured_nonzero';
      else verdict = 'in_window_measured_zero';

      rows.push({
        signalType,
        attempted,
        observed,
        foldedIntoRetainedDays: foldedByType.get(signalType) ?? 0,
        builtInWindow: roll?.builtInWindow ?? 0,
        builtOutOfWindow: roll?.builtOutOfWindow ?? 0,
        builtWindowNotApplicable: roll?.builtWindowNotApplicable ?? 0,
        lastBuiltAt: roll?.lastBuiltAt ?? null,
        lastInWindowBuiltAt: roll?.lastInWindowBuiltAt ?? null,
        unobserved: attempted === null ? null : attempted - observed,
        verdict,
      });
    }

    return {
      attemptedSource: attemptedByType ? 'engine_card_type_counts' : 'not_supplied',
      observations,
      lastObservedBuiltAt,
      lastInWindowBuiltAt,
      families: rows,
      note:
        'TRA-4936 provenance. Read `verdict` BEFORE `builtInWindow`: '
        + '`in_window_measured_zero` means the sink ran, the fold saw every card and none landed '
        + 'in window — the zero is REAL and is a finding about the sleeve, not about this fold. '
        + '`fold_not_reached` / `sink_never_ran` mean the zero says nothing about the market. '
        + '`attempted_unreadable` means no engine counter was supplied, so the identity could not '
        + 'be checked — it is NOT a pass. `lastInWindowBuiltAt` dates the last time the sink ran '
        + 'with the admission window open; `lastObservedBuiltAt` spans every bucket and therefore '
        + 'reads as recent even when the in-window side produced nothing.',
    };
  }

  /** Drop oldest ET days beyond the cap, counting each one into coverage. */
  private evictOldestDaysOverCap(): void {
    while (this.days.size > this.dayCap) {
      let oldest: string | null = null;
      for (const key of this.days.keys()) {
        if (oldest === null || key < oldest) oldest = key;
      }
      if (oldest === null) return;
      this.days.delete(oldest);
      this.etDaysDropped += 1;
      if (this.oldestDroppedEtDay === null || oldest < this.oldestDroppedEtDay) {
        this.oldestDroppedEtDay = oldest;
      }
      if (this.newestDroppedEtDay === null || oldest > this.newestDroppedEtDay) {
        this.newestDroppedEtDay = oldest;
      }
    }
  }

  /**
   * Deep snapshot — the caller may not hold a reference into live state.
   *
   * @param opts.attemptedByType the engine's own per-family `attempted` counter
   *   (`cardTypeCounts`), bumped ABOVE the sink's `try` and therefore the only
   *   term that can say the sink ran when the fold holds nothing. Omit it and
   *   every `wiring` verdict reads `attempted_unreadable` — never a green.
   */
  snapshot(opts?: { attemptedByType?: Readonly<Record<string, number>> }): CardCompletenessView {
    const retainedEtDays = [...this.days.keys()].sort();
    const days: CardCompletenessRow[] = [];
    for (const etDay of [...retainedEtDays].reverse()) {
      const byType = this.days.get(etDay);
      if (!byType) continue;
      for (const signalType of [...byType.keys()].sort()) {
        const row = byType.get(signalType);
        if (!row) continue;
        days.push({
          ...row,
          byWindow: {
            in_window: cloneCell(row.byWindow.in_window),
            out_of_window: cloneCell(row.byWindow.out_of_window),
            not_applicable: cloneCell(row.byWindow.not_applicable),
          },
          windowStampVsClock: { ...row.windowStampVsClock },
          exemplar: row.exemplar
            ? {
                ...row.exemplar,
                incompleteFields: [...row.exemplar.incompleteFields],
                refusedFields: [...row.exemplar.refusedFields],
              }
            : null,
        });
      }
    }
    const sinceBoot: Record<string, CardCompletenessSinceBootRow> = {};
    for (const [t, roll] of this.sinceBoot) sinceBoot[t] = { ...roll };
    return {
      wiring: this.buildWiring(days, opts?.attemptedByType),
      coverage: {
        retainedEtDays,
        etDaysRetained: retainedEtDays.length,
        etDaysSeen: this.etDayKeysSeen.size,
        etDaysDropped: this.etDaysDropped,
        retainedDayCap: this.dayCap,
        oldestDroppedEtDay: this.oldestDroppedEtDay,
        newestDroppedEtDay: this.newestDroppedEtDay,
        countsSince: new Date(this.countsSince).toISOString(),
        countsSinceBoot: true,
        note:
          'per-ET-day card completeness fold, OUTSIDE the recentCards ring (TRA-4936) — '
          + 'cumulative since boot, zeroed by every deploy/restart. Days are capped at '
          + `${this.dayCap}; the OLDEST ET day is dropped and counted in etDaysDropped, never a `
          + 'row within a day. `sinceBoot` never evicts, so "has a complete card ever been built" '
          + 'survives the cap.',
      },
      days,
      sinceBoot,
    };
  }
}
