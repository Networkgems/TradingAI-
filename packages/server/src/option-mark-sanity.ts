// TRA-2927 — LEG-LEVEL ATTRIBUTION for an out-of-family book give-back peak.
//
// ── WHAT THIS EXISTS TO ANSWER ───────────────────────────────────────────────
// On 2026-08-03 the LIVE book recorded `peakPnl: 138192` (retainedFloor $82,915.20)
// in the 387 seconds between 09:30:16 and 09:36:43 ET. That is ~100x the live
// family (8.83 – 1389.21) and ~53x the whole live account (closing equity $2,603.49
// on 08-04, 12 open live journal rows totalling $2,455.50 at risk). It is not a
// trade. But NOTHING in the stack records WHICH leg carried it, so the number is
// currently unexplained while it is wired into a live halt:
//
//   getOptionMark()  →  refreshOptionMarks()  →  { checkExits, refreshImportedMarks }
//     →  opt.currentPremium  →  unrealizedPnlForMode()  ×100×contracts
//     →  dailyOptionsPnlForMode()  →  computeBookMark()  →  markBook()
//     →  peakOpenGain = Math.max(peakOpenGain, …)   ← MONOTONIC
//
// The only condition anywhere on that chain is `mark > 0` (`refreshOptionMarks`,
// `refreshImportedMarks`). There is no upper bound at any hop, and because
// `peakOpenGain` is a running MAX, a SINGLE bad snapshot latches the phantom peak
// for the whole session — which is exactly the observed shape (5 records, the
// window closing 6m27s after the open when the halt latched).
//
// ── WHY OBSERVE-ONLY, AND WHY THAT IS NOT A HALF-FIX ─────────────────────────
// The obvious remedy is to REJECT a mark that jumps more than Nx in one tick. We
// do not do that yet, on purpose:
//
//   • A bound picked without the leg data is a guess. A 0DTE OTM contract can
//     genuinely multiply in minutes, and `refreshOptionMarks` runs on the doTick
//     cadence (~120–280s, TRA-2171), not per second — so the legitimate per-tick
//     jump distribution is WIDE and is not known here.
//   • Getting it wrong is asymmetric in the DANGEROUS direction. Rejecting a REAL
//     mark UNDERSTATES `peakOpenGain`, which LOWERS `retainedFloor` and DISARMS the
//     give-back cap — the most frequently binding loss control in the book (halt
//     latched on 13 of 22 observed sessions). A phantom peak halts a live arm that
//     should have kept trading; a suppressed peak lets a real give-back run. The
//     second failure is worse, so the threshold must be DERIVED from the live tape
//     rather than picked, per the house rule that a floor is picked from live tape
//     and pre-registered, never re-derived at grading.
//
// So this module measures first. `OBSERVE_JUMP_X` below is deliberately LOW (2x):
// it is a capture threshold for building the distribution, NOT a rejection
// threshold. Enforcement is a follow-up that reads this instrument's tape.
//
// ── THE DISCRIMINATOR ────────────────────────────────────────────────────────
// A quarantine counter that reads `0` is ambiguous between "no bad marks" and "the
// observer never ran" — the recurring failure where an instrument reads identically
// in its pass and fail state. So `observed` (every mark evaluated, jump or not) is
// published NEXT TO `flagged`. `observed === 0` means the observer is DARK and
// `flagged: 0` says nothing; only `observed > 0 && flagged === 0` is a clean read.
//
// Pure accounting. NEVER places an order, mutates a position, or changes a mark —
// `classifyMarkJump` is a pure function and `recordMarkObservation` only appends to
// a bounded in-memory ring. Nothing here can break a trade pass.

/** Capture threshold: record a mark whose jump over its own prior mark exceeds this. */
export const OBSERVE_JUMP_X = 2;

/**
 * Cap on retained samples. The tape is a diagnostic read between reboots (bqb1
 * self-restarts several times a day, TRA-2203/TRA-2261), not a durable ledger, so a
 * small ring is enough to attribute the next occurrence without growing unbounded on
 * a pathological feed. Oldest samples are dropped first; `flagged` counts EVERY
 * flagged mark since boot regardless of how many samples survive, so a dropped
 * sample can never make the count read low.
 */
export const MAX_SAMPLES = 50;

/** One mark that exceeded {@link OBSERVE_JUMP_X} over its own prior mark. */
export interface MarkJumpSample {
  /** Observation time, ms epoch. */
  ts: number;
  /** OCC contract symbol — the leg. */
  optionSymbol: string;
  /** Underlying. */
  symbol: string;
  /** Book the position sits in. */
  mode: 'demo' | 'live';
  /** The mark that was accepted. */
  mark: number;
  /** The mark it replaced (`currentPremium`, seeded to `premiumPaid` on open). */
  priorMark: number;
  /** Entry premium per share — the position's own scale. */
  entryPremium: number;
  /** `mark / priorMark`. */
  jumpX: number;
  /** Open contracts on the leg. */
  contracts: number;
  /**
   * Dollars this single mark moved the book's open MTM by:
   * `(mark − priorMark) × contracts × 100`. This is the term that lands in
   * `peakOpenGain`, so it is directly comparable to the give-back `peakPnl`.
   */
  mtmDeltaUsd: number;
}

/** What {@link classifyMarkJump} decided about one mark. */
export interface MarkJumpDecision {
  /** True ⇒ the jump cleared {@link OBSERVE_JUMP_X} and is worth a sample. */
  flagged: boolean;
  /**
   * `mark / priorMark`, or `null` when the ratio is NOT DEFINED — a non-finite or
   * non-positive prior mark has no scale to compare against. `null`, never 1 or 0:
   * a numeric ratio there would read as "no jump" and quietly launder an
   * unmeasurable mark into the clean bucket (TRA-1707).
   */
  jumpX: number | null;
}

/**
 * Is this mark a large jump over the position's own prior mark?
 *
 * Compared against `priorMark` (the position's `currentPremium`, which the open
 * paths seed to `premiumPaid`) rather than against an absolute dollar ceiling,
 * because the plausible premium range is a property of the CONTRACT, not of the
 * book: $40 is unremarkable on a deep-ITM index contract and absurd on the $0.30
 * OTM contracts this sleeve trades. A ratio is scale-free and therefore the same
 * test for every leg.
 *
 * Pure. Returns `flagged: false` with `jumpX: null` when the ratio is undefined,
 * so an unmeasurable mark is never counted as a clean one.
 */
export function classifyMarkJump(input: {
  mark: number;
  priorMark: number;
}): MarkJumpDecision {
  const { mark, priorMark } = input;
  if (!Number.isFinite(mark) || !Number.isFinite(priorMark) || !(priorMark > 0)) {
    return { flagged: false, jumpX: null };
  }
  const jumpX = mark / priorMark;
  return { flagged: jumpX > OBSERVE_JUMP_X, jumpX };
}

// ── Bounded in-memory tape ───────────────────────────────────────────────────

let observed = 0;
let flagged = 0;
let undefinedRatio = 0;
let maxJumpX: number | null = null;
let maxMtmDeltaUsd: number | null = null;
let samples: MarkJumpSample[] = [];

/** Reset the tape (unit tests only — boot starts empty). */
export function clearMarkSanityTape(): void {
  observed = 0;
  flagged = 0;
  undefinedRatio = 0;
  maxJumpX = null;
  maxMtmDeltaUsd = null;
  samples = [];
}

/**
 * Observe ONE mark on its way to `opt.currentPremium`.
 *
 * Called from the single seam where the tick's mark map is built
 * (`SignalEngine.refreshOptionMarks`), so it covers BOTH consumers of that map —
 * `checkExits` (engine-opened rows) and `refreshImportedMarks` (Tradier-mirrored
 * rows). Wiring it into either consumer alone would scope the instrument to half
 * the book, and the live OTM sleeve's rows are engine-opened, so an imports-only
 * observer would read a clean `0` against the very book this ticket is about.
 *
 * ALWAYS increments `observed` — including when the ratio is undefined — so the
 * denominator counts every mark the instrument actually saw.
 */
export function recordMarkObservation(input: {
  optionSymbol: string;
  symbol: string;
  mode: 'demo' | 'live';
  mark: number;
  priorMark: number;
  entryPremium: number;
  contracts: number;
  now: number;
}): MarkJumpDecision {
  observed += 1;
  const decision = classifyMarkJump({ mark: input.mark, priorMark: input.priorMark });
  if (decision.jumpX == null) {
    undefinedRatio += 1;
    return decision;
  }
  if (maxJumpX == null || decision.jumpX > maxJumpX) maxJumpX = decision.jumpX;
  if (!decision.flagged) return decision;

  flagged += 1;
  const contracts = Number.isFinite(input.contracts) && input.contracts > 0 ? input.contracts : 0;
  const mtmDeltaUsd = (input.mark - input.priorMark) * contracts * 100;
  if (maxMtmDeltaUsd == null || mtmDeltaUsd > maxMtmDeltaUsd) maxMtmDeltaUsd = mtmDeltaUsd;
  samples.push({
    ts: input.now,
    optionSymbol: input.optionSymbol,
    symbol: input.symbol,
    mode: input.mode,
    mark: input.mark,
    priorMark: input.priorMark,
    entryPremium: input.entryPremium,
    jumpX: decision.jumpX,
    contracts,
    mtmDeltaUsd,
  });
  if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
  return decision;
}

/** The published read. */
export interface MarkSanitySummary {
  /**
   * READ THIS FIRST. Every mark the observer evaluated since boot. `0` ⇒ the
   * observer is DARK (no open eligible positions, no scanner, or it is not wired)
   * and `flagged: 0` below is an ABSENCE, not a measurement.
   */
  observed: number;
  /** Marks that jumped more than {@link OBSERVE_JUMP_X} over their own prior mark. */
  flagged: number;
  /** Marks whose ratio was UNDEFINED (prior mark absent / non-positive). Not clean. */
  undefinedRatio: number;
  /** Capture threshold in force — an OBSERVATION threshold, not a rejection one. */
  observeJumpX: number;
  /** Largest ratio seen, or `null` when no ratio was ever defined. */
  maxJumpX: number | null;
  /** Largest single-mark open-MTM move in dollars, or `null` when nothing flagged. */
  maxMtmDeltaUsd: number | null;
  /** Most recent flagged marks, oldest first, capped at {@link MAX_SAMPLES}. */
  samples: MarkJumpSample[];
  /** Human-readable headline that distinguishes DARK from CLEAN. */
  note: string;
}

/** Snapshot the tape for the health route. */
export function summarizeMarkSanity(): MarkSanitySummary {
  return {
    observed,
    flagged,
    undefinedRatio,
    observeJumpX: OBSERVE_JUMP_X,
    maxJumpX,
    maxMtmDeltaUsd,
    samples: [...samples],
    note: markSanityNote(),
  };
}

/**
 * The headline, ordered by what VOIDS what: darkness first (nothing was measured),
 * then the counts. Exported so the regression test can assert the DARK and CLEAN
 * readouts are DISTINGUISHABLE rather than merely asserting the clean one looks
 * clean — a `flagged: 0` that reads identically in both states is the exact defect
 * this instrument was built to avoid inheriting.
 */
export function markSanityNote(): string {
  if (observed === 0) {
    return 'DARK — no option mark has been evaluated since boot, so `flagged: 0` is an ABSENCE, not a clean read. Expect this when no eligible option position is open, when no scanner is wired, or when the observer is not on the mark path at all. Do NOT grade a give-back peak against this payload in this state.';
  }
  if (flagged === 0) {
    return `CLEAN — ${observed} mark(s) evaluated since boot, none jumped more than ${OBSERVE_JUMP_X}x over its own prior mark (largest ${maxJumpX == null ? 'n/a' : `${maxJumpX.toFixed(2)}x`}). ${undefinedRatio} had NO defined ratio (no positive prior mark) and are excluded from that claim rather than counted as clean. This is an OBSERVATION threshold: nothing is rejected, every mark below still reached the give-back peak.`;
  }
  return `FLAGGED — ${flagged}/${observed} mark(s) jumped more than ${OBSERVE_JUMP_X}x over their own prior mark since boot; largest ${maxJumpX == null ? 'n/a' : `${maxJumpX.toFixed(2)}x`}, largest single-mark open-MTM move ${maxMtmDeltaUsd == null ? 'n/a' : `$${maxMtmDeltaUsd.toFixed(2)}`}. Each sample carries the leg, both marks and the contract count, so the dollars it pushed into \`peakOpenGain\` are attributable. NOTHING IS REJECTED — these marks were accepted and DID reach the give-back control (TRA-2927 is observe-only by design; see the module header for why the threshold is not yet an enforcement bound).`;
}
