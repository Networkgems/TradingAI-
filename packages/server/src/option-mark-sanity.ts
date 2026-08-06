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

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import { etDateString } from './scheduler.js';

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

// ── TRA-2945 — WHY A SINCE-BOOT MAX IS NOT A DISTRIBUTION ────────────────────
//
// TRA-2945 asks for the enforcement bound to be DERIVED from this tape: the
// per-tick jump distribution across BOTH books over at least 5 RTH sessions,
// pre-registered before grading. The v1 tape above cannot produce that answer,
// for three separate reasons — each of which reads IDENTICALLY to a healthy
// instrument, which is the whole reason they are called out here:
//
//   1. IT DIES AT EVERY REBOOT. `observed`/`maxJumpX` are module globals and
//      nothing writes them to disk, while bqb1 self-restarts several times a day
//      (TRA-2203/TRA-2261) and every deploy boots it too. A read taken after a
//      restart starts the count from zero, so "5 RTH sessions" can NEVER
//      accumulate — the tape's own ceiling is ONE boot. The give-back `sessions`
//      ledger sitting next to it on the same payload is durable (hydrates from
//      /data); this was not, and the difference is invisible in the read.
//   2. IT CANNOT NAME ITS BOOK. `mode` is captured on a flagged SAMPLE, but the
//      aggregate is mode-blind — and when nothing is flagged, `samples` is empty,
//      so a clean read carries ZERO evidence about which book it covered. A bound
//      derived from a tape that happened to be demo-only would be enforced against
//      the LIVE book that produced the 2026-08-03 phantom. `observed: 1174,
//      flagged: 0` looks the same whether the live book contributed 1174 marks or
//      none at all.
//   3. IT KEEPS NO DISTRIBUTION. Only a running MAX survives, plus a count of
//      marks over the 2x capture threshold. Everything between 1.0x and 2.0x is
//      discarded. A max is not a distribution: you cannot read a percentile off
//      it, so "bias the bound LOOSE" has nothing to be loose RELATIVE TO.
//
// So the tape below is durable per (ET day × book), keeps a fixed-edge HISTOGRAM
// of every ratio it ever saw, and counts its sessions per book. The since-boot
// counters above are retained UNCHANGED next to it, because they answer a
// different question ("is the observer running right now") and callers already
// read them.
//
// Still observe-only. Nothing here rejects a mark; see the module header for why
// the error directions are asymmetric and why the loose direction is the safe one.

/**
 * Upper edges of the jump-ratio histogram, ascending. Bucket `i` counts ratios
 * `<= JUMP_BUCKET_EDGES[i]` that did not land in an earlier bucket; the final
 * bucket (length `JUMP_BUCKET_EDGES.length`) counts everything ABOVE the last
 * edge and is therefore unbounded — a 100x phantom lands there and cannot be
 * mistaken for a clean read.
 *
 * The first edge is exactly `1` ON PURPOSE: a ratio at-or-below 1 is a mark that
 * fell or held, not an up-move at all, and folding those in with real up-moves
 * would let a book that mostly decays read as a book with a tight up-tail.
 */
export const JUMP_BUCKET_EDGES = [1, 1.05, 1.1, 1.25, 1.5, 2, 3, 5, 10, 25, 50, 100] as const;

/** Number of histogram buckets — one per edge, plus the unbounded overflow. */
export const JUMP_BUCKET_COUNT = JUMP_BUCKET_EDGES.length + 1;

/** Sessions of tape TRA-2945 requires per book before a bound may be pre-registered. */
export const BOUND_SESSIONS_REQUIRED = 5;

/** Durable file, alongside `giveback-arm-floor.jsonl` — the row it explains. */
export const MARK_SANITY_LOG_FILENAME = 'option-mark-sanity.jsonl';

/** Retention for the durable fold. Matches the give-back ledger's 30 days. */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

// NO APPEND THROTTLE, DELIBERATELY.
//
// The give-back ledger next door throttles its writes on a change signature, and
// the obvious move was to copy that. It is wrong here, because the two ledgers
// publish different things: that one publishes a STATE (the current peak, which a
// throttled write reproduces exactly), while this one publishes a COUNT and a
// HISTOGRAM. Under a throttle the in-memory totals on the health payload would run
// AHEAD of what is on disk, so `byMode.live.observed` would report coverage that a
// reboot then silently discards — an instrument overstating its own durability,
// which is the exact defect class this ticket exists to remove.
//
// The cost of writing every mark is nil: `refreshOptionMarks` runs on the doTick
// cadence (~120–280s, TRA-2171), and the live fleet produced 1,174 marks in a 6.75h
// boot on 2026-08-06 — about one append every 20 seconds, fleet-wide. This is not a
// hot path. Each line is a full cumulative row and the boot hydrate COMPACTS the
// file to one line per book-day, so growth is bounded to a single day's marks.

/** One book's cumulative tape for one ET day. Survives reboots via {@link MARK_SANITY_LOG_FILENAME}. */
export interface MarkDayBook {
  /** ET session date, `YYYY-MM-DD`. */
  etDay: string;
  /** Which book. The v1 aggregate could not answer this. */
  mode: 'demo' | 'live';
  /** Every mark evaluated for this book on this day. THE DENOMINATOR — `0` ⇒ dark. */
  observed: number;
  /** Marks over {@link OBSERVE_JUMP_X}. Still observe-only; none were rejected. */
  flagged: number;
  /** Marks with no defined ratio. Excluded from the clean claim, never laundered into it. */
  undefinedRatio: number;
  /** Largest ratio this book saw on this day, or `null` if no ratio was ever defined. */
  maxJumpX: number | null;
  /** Largest single-mark open-MTM move in dollars among FLAGGED marks. */
  maxMtmDeltaUsd: number | null;
  /** Counts per {@link JUMP_BUCKET_EDGES}; length {@link JUMP_BUCKET_COUNT}. */
  histogram: number[];
}

// ── Bounded in-memory tape ───────────────────────────────────────────────────

let observed = 0;
let flagged = 0;
let undefinedRatio = 0;
let maxJumpX: number | null = null;
let maxMtmDeltaUsd: number | null = null;
let samples: MarkJumpSample[] = [];

/** `${etDay}::${mode}` -> cumulative book-day. Fed by BOTH the boot hydrate and the live pass. */
const byDayBook = new Map<string, MarkDayBook>();
/** Configured append target, set once by {@link hydrateMarkSanityFromDisk}. `null` ⇒ nothing is durable. */
let dataDir: string | null = null;
/** Book-days recovered FROM DISK at boot (0 after a reboot on an ephemeral mount). */
let hydratedBookDays = 0;
/** `observed` at the last durable write, per book-day — drives {@link WRITE_EVERY}. */
const lastWrittenObserved = new Map<string, number>();
/** Appends that threw and were swallowed. `> 0` ⇒ what is shown is NOT all on disk. */
let appendErrors = 0;
let lastAppendError: string | null = null;

function dayBookKey(etDay: string, mode: 'demo' | 'live'): string {
  return `${etDay}::${mode}`;
}

/** Which bucket does this ratio fall in? Pure; total over the edges, so no ratio is dropped. */
export function jumpBucketIndex(jumpX: number): number {
  for (let i = 0; i < JUMP_BUCKET_EDGES.length; i += 1) {
    if (jumpX <= JUMP_BUCKET_EDGES[i]) return i;
  }
  return JUMP_BUCKET_EDGES.length;
}

/** Reset the tape (unit tests only — boot starts empty). */
export function clearMarkSanityTape(): void {
  observed = 0;
  flagged = 0;
  undefinedRatio = 0;
  maxJumpX = null;
  maxMtmDeltaUsd = null;
  samples = [];
  byDayBook.clear();
  lastWrittenObserved.clear();
  dataDir = null;
  hydratedBookDays = 0;
  appendErrors = 0;
  lastAppendError = null;
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
  // TRA-2945 — the DURABLE per-book fold runs on the same pass and is credited
  // for EVERY mark, including an undefined ratio, so `book.observed` is a true
  // denominator for its own book rather than a count of the marks that happened
  // to be measurable.
  const book = ensureDayBook(input.now, input.mode);
  book.observed += 1;

  const decision = classifyMarkJump({ mark: input.mark, priorMark: input.priorMark });
  if (decision.jumpX == null) {
    undefinedRatio += 1;
    book.undefinedRatio += 1;
    persistDayBook(book);
    return decision;
  }
  if (maxJumpX == null || decision.jumpX > maxJumpX) maxJumpX = decision.jumpX;
  if (book.maxJumpX == null || decision.jumpX > book.maxJumpX) book.maxJumpX = decision.jumpX;
  book.histogram[jumpBucketIndex(decision.jumpX)] += 1;
  if (!decision.flagged) {
    persistDayBook(book);
    return decision;
  }

  flagged += 1;
  book.flagged += 1;
  const contracts = Number.isFinite(input.contracts) && input.contracts > 0 ? input.contracts : 0;
  const mtmDeltaUsd = (input.mark - input.priorMark) * contracts * 100;
  if (maxMtmDeltaUsd == null || mtmDeltaUsd > maxMtmDeltaUsd) maxMtmDeltaUsd = mtmDeltaUsd;
  if (book.maxMtmDeltaUsd == null || mtmDeltaUsd > book.maxMtmDeltaUsd) book.maxMtmDeltaUsd = mtmDeltaUsd;
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
  // A flagged mark is the one record that must not be lost to the write throttle:
  // it is the leg-level attribution this whole instrument exists to capture.
  persistDayBook(book);
  return decision;
}

/** Find or open this book's cumulative row for the ET day `now` falls in. */
function ensureDayBook(now: number, mode: 'demo' | 'live'): MarkDayBook {
  const etDay = etDateString(new Date(now));
  const key = dayBookKey(etDay, mode);
  let book = byDayBook.get(key);
  if (!book) {
    book = {
      etDay,
      mode,
      observed: 0,
      flagged: 0,
      undefinedRatio: 0,
      maxJumpX: null,
      maxMtmDeltaUsd: null,
      histogram: new Array<number>(JUMP_BUCKET_COUNT).fill(0),
    };
    byDayBook.set(key, book);
  }
  return book;
}

/**
 * Write this book-day's CUMULATIVE row.
 *
 * The line carries the running total rather than a delta, and the hydrate below
 * loads it back into the SAME row before this boot starts adding to it. That is
 * what makes the counts survive a restart: after a reboot the fold resumes from
 * the disk total instead of from zero, so the LAST line written for a book-day is
 * always that day's true total. A delta-per-line scheme would accumulate the same
 * way, but a cumulative one cannot be double-counted when a torn line is skipped.
 *
 * Best-effort and swallowed — accounting must never break a trade pass — but
 * COUNTED in `appendErrors`, so the swallow is not silent.
 */
function persistDayBook(book: MarkDayBook): void {
  if (dataDir == null) return;
  lastWrittenObserved.set(dayBookKey(book.etDay, book.mode), book.observed);

  const path = markSanityLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(book) + '\n', 'utf8');
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    logger.warn('option-mark-sanity append failed', { reason: lastAppendError });
  }
}

export function markSanityLogPath(dir: string): string {
  return join(dir, MARK_SANITY_LOG_FILENAME);
}

/** What {@link hydrateMarkSanityFromDisk} recovered (for the boot log line). */
export interface MarkSanityHydration {
  /** Distinct (ET day × book) rows recovered. */
  bookDays: number;
  /** Total observations recovered across those rows. */
  observed: number;
  /** Distinct ET days recovered. */
  days: number;
}

/**
 * Rebuild the durable fold from disk and remember `dir` for subsequent appends.
 *
 * Idempotent — CLEARS first — so it is safe to call exactly once at startup before
 * any live pass. Only rows within {@link RETAIN_MS} of `now` are kept, and the file
 * is COMPACTED to one line per surviving book-day, which bounds growth (the append
 * path rewrites a cumulative row many times per session).
 *
 * Because each line is a CUMULATIVE total, the LAST line for a given book-day wins.
 * Best-effort: a missing/corrupt file yields an empty hydration and a torn trailing
 * line is skipped rather than throwing — a tape that fails to load must not take the
 * process down, it must read as having recovered nothing.
 */
export function hydrateMarkSanityFromDisk(dir: string, now: number = Date.now()): MarkSanityHydration {
  clearMarkSanityTape();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(markSanityLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoffDay = etDateString(new Date(now - RETAIN_MS));
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // torn/partial line — skip it rather than abort the hydrate
    }
    const book = coerceDayBook(rec);
    if (book == null) continue;
    if (book.etDay < cutoffDay) continue;
    byDayBook.set(dayBookKey(book.etDay, book.mode), book);
  }

  let observedTotal = 0;
  const days = new Set<string>();
  for (const [key, book] of byDayBook) {
    observedTotal += book.observed;
    days.add(book.etDay);
    // Seed the throttle at what is already on disk: this boot should not rewrite a
    // hydrated row until it has actually added WRITE_EVERY new observations to it.
    lastWrittenObserved.set(key, book.observed);
  }
  hydratedBookDays = byDayBook.size;

  // Compact to exactly the surviving rows, one line each.
  try {
    const path = markSanityLogPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [...byDayBook.values()].map((b) => JSON.stringify(b)).join('\n') + (byDayBook.size > 0 ? '\n' : ''), 'utf8');
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
  }

  return { bookDays: hydratedBookDays, observed: observedTotal, days: days.size };
}

/** Validate one persisted row. Returns `null` for anything that is not a usable book-day. */
function coerceDayBook(rec: unknown): MarkDayBook | null {
  if (rec == null || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (typeof r.etDay !== 'string' || r.etDay === '') return null;
  if (r.mode !== 'demo' && r.mode !== 'live') return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const nullableNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const histogram = new Array<number>(JUMP_BUCKET_COUNT).fill(0);
  if (Array.isArray(r.histogram)) {
    // Length-tolerant: a row written by an older/newer edge table is folded as far
    // as the two agree rather than discarded, and never overruns this boot's array.
    for (let i = 0; i < Math.min(r.histogram.length, JUMP_BUCKET_COUNT); i += 1) {
      histogram[i] = num(r.histogram[i]);
    }
  }
  return {
    etDay: r.etDay,
    mode: r.mode,
    observed: num(r.observed),
    flagged: num(r.flagged),
    undefinedRatio: num(r.undefinedRatio),
    maxJumpX: nullableNum(r.maxJumpX),
    maxMtmDeltaUsd: nullableNum(r.maxMtmDeltaUsd),
    histogram,
  };
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
  /** TRA-2945 — is anything below actually ON DISK? Read `ephemeral` FIRST. */
  durability: MarkSanityDurability;
  /** TRA-2945 — DURABLE cumulative totals per book. `live.observed: 0` ⇒ the live claim is DARK. */
  byMode: Record<'demo' | 'live', MarkModeTotals>;
  /** TRA-2945 — every retained (ET day × book) row, newest day first. */
  days: MarkDayBook[];
  /** TRA-2945 — can a bound be pre-registered yet, and from what. */
  boundReadiness: MarkBoundReadiness;
}

/** Where the durable fold lives, and whether it will survive the next reboot. */
export interface MarkSanityDurability {
  /** Resolved append target. `null` ⇒ memory-only: no boot hydrate ran, NOTHING is durable. */
  dataDir: string | null;
  /**
   * `true` ⇒ the rows below are wiped at the next reboot exactly like the
   * since-boot counters this fold exists to outlast, so `sessions` can never reach
   * {@link BOUND_SESSIONS_REQUIRED} no matter how long you wait. A property of the
   * PATH, so it is answerable even when the fold is empty — unlike `hydratedBookDays`,
   * which cannot tell a fresh persistent disk from a wiped ephemeral one.
   */
  ephemeral: boolean;
  /** Book-days recovered FROM DISK at boot. `0` after a reboot on an ephemeral mount. */
  hydratedBookDays: number;
  /** Appends that threw and were swallowed. `> 0` ⇒ what is shown is NOT all on disk. */
  appendErrors: number;
  lastAppendError: string | null;
}

/** One book's totals across every retained day. */
export interface MarkModeTotals {
  /** THE DENOMINATOR FOR THIS BOOK. `0` ⇒ dark for this book, whatever the global says. */
  observed: number;
  flagged: number;
  undefinedRatio: number;
  maxJumpX: number | null;
  maxMtmDeltaUsd: number | null;
  /** Distinct ET days on which this book was observed at all. */
  sessions: number;
  /** Summed histogram over those days; length {@link JUMP_BUCKET_COUNT}. */
  histogram: number[];
}

/** Whether the tape can yet support pre-registering an enforcement bound. */
export interface MarkBoundReadiness {
  sessionsRequired: number;
  demoSessions: number;
  liveSessions: number;
  /** BOTH books must clear the bar — a demo-only tape cannot bound the live book. */
  ready: boolean;
  note: string;
}

function emptyTotals(): MarkModeTotals {
  return {
    observed: 0,
    flagged: 0,
    undefinedRatio: 0,
    maxJumpX: null,
    maxMtmDeltaUsd: null,
    sessions: 0,
    histogram: new Array<number>(JUMP_BUCKET_COUNT).fill(0),
  };
}

/** Fold the retained book-days into per-book totals. */
export function markSanityTotals(): Record<'demo' | 'live', MarkModeTotals> {
  const out = { demo: emptyTotals(), live: emptyTotals() };
  for (const book of byDayBook.values()) {
    const t = out[book.mode];
    t.observed += book.observed;
    t.flagged += book.flagged;
    t.undefinedRatio += book.undefinedRatio;
    if (book.maxJumpX != null && (t.maxJumpX == null || book.maxJumpX > t.maxJumpX)) t.maxJumpX = book.maxJumpX;
    if (book.maxMtmDeltaUsd != null && (t.maxMtmDeltaUsd == null || book.maxMtmDeltaUsd > t.maxMtmDeltaUsd)) {
      t.maxMtmDeltaUsd = book.maxMtmDeltaUsd;
    }
    // A day with zero observations is not a session — it is a row that exists
    // because the other book traded. Counting it would let an empty tape claim
    // coverage it does not have.
    if (book.observed > 0) t.sessions += 1;
    for (let i = 0; i < JUMP_BUCKET_COUNT; i += 1) t.histogram[i] += book.histogram[i] ?? 0;
  }
  return out;
}

/** Snapshot the tape for the health route. */
export function summarizeMarkSanity(): MarkSanitySummary {
  const byMode = markSanityTotals();
  const days = [...byDayBook.values()].sort((a, b) =>
    a.etDay === b.etDay ? a.mode.localeCompare(b.mode) : b.etDay.localeCompare(a.etDay),
  );
  return {
    observed,
    flagged,
    undefinedRatio,
    observeJumpX: OBSERVE_JUMP_X,
    maxJumpX,
    maxMtmDeltaUsd,
    samples: [...samples],
    note: markSanityNote(),
    durability: {
      dataDir,
      ephemeral: dataDir == null ? true : isEphemeralDataDir(dataDir),
      hydratedBookDays,
      appendErrors,
      lastAppendError,
    },
    byMode,
    days,
    boundReadiness: boundReadiness(byMode),
  };
}

/**
 * TRA-2945 §3 gate. BOTH books must have {@link BOUND_SESSIONS_REQUIRED} observed
 * sessions before a bound is pre-registered, because the enforcement bound applies
 * to both and a tape that covered only the demo book says nothing about the live
 * one — which is the book that produced the 2026-08-03 phantom.
 */
export function boundReadiness(byMode: Record<'demo' | 'live', MarkModeTotals>): MarkBoundReadiness {
  const demoSessions = byMode.demo.sessions;
  const liveSessions = byMode.live.sessions;
  const ready = demoSessions >= BOUND_SESSIONS_REQUIRED && liveSessions >= BOUND_SESSIONS_REQUIRED;
  const short: string[] = [];
  if (demoSessions < BOUND_SESSIONS_REQUIRED) short.push(`demo ${demoSessions}/${BOUND_SESSIONS_REQUIRED}`);
  if (liveSessions < BOUND_SESSIONS_REQUIRED) short.push(`live ${liveSessions}/${BOUND_SESSIONS_REQUIRED}`);
  return {
    sessionsRequired: BOUND_SESSIONS_REQUIRED,
    demoSessions,
    liveSessions,
    ready,
    note: ready
      ? `READY — ${demoSessions} demo and ${liveSessions} live session(s) of durable tape. The jump distribution in \`byMode.*.histogram\` is the basis for the bound; pre-register it BEFORE grading, and bias it LOOSE (rejecting a REAL mark understates peakOpenGain, which LOWERS retainedFloor and DISARMS the give-back cap — the worse direction).`
      : `NOT READY — ${short.join(', ')}. Do NOT pre-register a bound from this tape yet: a bound derived from one book does not transfer to the other, and TRA-2945 §3 requires ${BOUND_SESSIONS_REQUIRED} sessions per book.`,
  };
}

/**
 * The headline, ordered by what VOIDS what: darkness first (nothing was measured),
 * then the counts. Exported so the regression test can assert the DARK and CLEAN
 * readouts are DISTINGUISHABLE rather than merely asserting the clean one looks
 * clean — a `flagged: 0` that reads identically in both states is the exact defect
 * this instrument was built to avoid inheriting.
 */
/**
 * TRA-2945 — the per-book half of the DARK/CLEAN discriminator.
 *
 * The since-boot `observed` is a single number across both books, so a clean read
 * on a tape that only ever saw the DEMO book is indistinguishable from one that
 * covered the live book too — and it is the live book that produced the
 * 2026-08-03 phantom. This appends that missing state to the headline instead of
 * leaving it to be inferred from `byMode`, which a reader grading the give-back
 * row will not necessarily open.
 */
function perBookCaveat(): string {
  const t = markSanityTotals();
  const dark: string[] = [];
  if (t.live.observed === 0) dark.push('LIVE');
  if (t.demo.observed === 0) dark.push('DEMO');
  if (dark.length === 0) {
    return ` Per book (durable): demo ${t.demo.observed} over ${t.demo.sessions} session(s), live ${t.live.observed} over ${t.live.sessions} session(s).`;
  }
  return ` ⚠ ${dark.join(' and ')} DARK across the whole durable tape (demo ${t.demo.observed}, live ${t.live.observed}) — the clean claim above does NOT cover ${dark.length === 2 ? 'either book' : `the ${dark[0].toLowerCase()} book`}, and no bound may be derived for a book with no observations.`;
}

export function markSanityNote(): string {
  if (observed === 0) {
    return 'DARK — no option mark has been evaluated since boot, so `flagged: 0` is an ABSENCE, not a clean read. Expect this when no eligible option position is open, when no scanner is wired, or when the observer is not on the mark path at all. Do NOT grade a give-back peak against this payload in this state.';
  }
  if (flagged === 0) {
    return `CLEAN — ${observed} mark(s) evaluated since boot, none jumped more than ${OBSERVE_JUMP_X}x over its own prior mark (largest ${maxJumpX == null ? 'n/a' : `${maxJumpX.toFixed(2)}x`}). ${undefinedRatio} had NO defined ratio (no positive prior mark) and are excluded from that claim rather than counted as clean. This is an OBSERVATION threshold: nothing is rejected, every mark below still reached the give-back peak.${perBookCaveat()}`;
  }
  return `FLAGGED — ${flagged}/${observed} mark(s) jumped more than ${OBSERVE_JUMP_X}x over their own prior mark since boot; largest ${maxJumpX == null ? 'n/a' : `${maxJumpX.toFixed(2)}x`}, largest single-mark open-MTM move ${maxMtmDeltaUsd == null ? 'n/a' : `$${maxMtmDeltaUsd.toFixed(2)}`}. Each sample carries the leg, both marks and the contract count, so the dollars it pushed into \`peakOpenGain\` are attributable. NOTHING IS REJECTED — these marks were accepted and DID reach the give-back control (TRA-2927 is observe-only by design; see the module header for why the threshold is not yet an enforcement bound).`;
}
