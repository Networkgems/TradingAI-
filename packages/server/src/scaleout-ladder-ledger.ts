// TRA-1300 (parent TRA-1290, board confirmation `38a50f39`) — durable observe-only
// ledger for the scale-out (take-profit) ladder overlay.
//
// The board GREENLIT an OBSERVE-ONLY scale-out ladder demo overlay (and REJECTED
// the add-down ladder — TRA-1291 NO-GO). QuantTrader will forward-validate signal
// accuracy on the demo capture, which must accrue across the ~daily Render demo-host
// (`tradingai-bqb1`) reboot. So this mirrors the TRA-1278 conviction-DCA ledger /
// TRA-1216 funding-history JSONL + hydrate-on-boot pattern rather than the in-memory
// short-premium store:
//   • one JSONL line per INTENDED trim under DATA_DIR (a write-through of values the
//     pure `scaleOutLadderDecision` already computed — no new decision here);
//   • counters + the per-position fired-rung set rebuilt from the full JSONL on boot
//     so a rung trims once across restarts and the trim counts survive the reboot;
//   • a read-only `GET /api/health/scaleout-ladder` folds the store into
//     enabled / trimCount / fullExitCount / positionCount / recent tail.
//
// ── HARD INVARIANT ──────────────────────────────────────────────────────────
// OBSERVE-ONLY. This module records intended trims; it NEVER places an order or
// mutates any account. The ladder governs the UPSIDE only — the downside is owned
// by the shipped chandelier + give-back cap (TRA-1267/1268), which this does not
// touch. It is NOT rotated: it IS the forward-validation evidence and must stay
// complete; trims are rare enough (≤5 rungs per position) that a full-read hydrate
// is exact and the file stays small.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  scaleOutLadderDecision,
  type Side,
  type ScaleOutLadderDecision,
} from '@trading-app/engine';
import {
  SCALE_OUT_TAKER_FEE_EQUITY,
  SCALE_OUT_TAKER_FEE_CRYPTO,
  SCALE_OUT_LADDER_RUNGS,
  getEasternUtcOffset,
} from '@trading-app/shared';
import { logger } from './observability/index.js';
import { timeSyncPhase } from './phase-timing.js';

const log = logger.child({ module: 'scaleout-ladder-ledger' });

export const SCALEOUT_LADDER_LOG_FILENAME = 'scaleout-ladder-trims.jsonl';

// TRA-1729/TRA-4757 — the observe-pass snapshot. A SEPARATE, single-line file (not
// the append-only trim log): everything in it is a MONOTONE SCALAR, so it is rewritten
// in place and the file can never grow. Rewrite-on-change (rather than one line per
// pass) is what keeps a ~2.2/sec observe pass from growing an unbounded JSONL that the
// boot hydrate would then have to read end-to-end. It now carries two blocks — the
// TRA-1729 high-water at the top level and the TRA-4757 non-blind accumulator under
// `nonBlind` (see {@link ScaleoutObserveSnapshot} for why that nesting is the
// back-compatible shape).
export const SCALEOUT_LADDER_OBSERVE_FILENAME = 'scaleout-ladder-observe.json';

/** The first (lowest) ladder rung — the threshold `maxGainPctObserved` is measured against. */
const FIRST_RUNG_UP = SCALE_OUT_LADDER_RUNGS[0]!.up;

/** Rolling recent-trims retention for the health tail (counts stay complete). */
const MAX_RECENT_TRIMS = 50;

/** Asset class of the trimmed position — picks the taker fee rate. */
export type ScaleoutAssetClass = 'equity' | 'crypto' | 'option';

/** One durable intended-trim event — the forward-validation unit. */
export interface ScaleoutTrimRecord {
  /** Event time, ms epoch. */
  ts: number;
  /** Book mode the ladder observed — demo/paper only (live routing is out of scope). */
  mode: 'demo' | 'live';
  assetClass: ScaleoutAssetClass;
  symbol: string;
  /** Engine position/option id the trim would apply to. */
  positionId: string;
  side: Side;
  /** Average entry the favorable move is measured from. */
  avgEntry: number;
  /** Mark at the trim. */
  markPrice: number;
  /** Favorable excursion from avg entry (0.25 = +25%). */
  gainPct: number;
  /** Rung threshold that fired (0.25 / 0.35 / 0.45 / 0.60 / 1.00). */
  up: number;
  /** Base-size fraction trimmed at this rung. */
  sellPctBase: number;
  /** Original (base) position size. */
  baseQty: number;
  /** Units trimmed = sellPctBase × baseQty. */
  trimQty: number;
  /** Gross proceeds (pre-fee). */
  grossProceeds: number;
  /** Taker fee charged. */
  feeCost: number;
  /** Net proceeds (post-fee). */
  netProceeds: number;
  /** Taker fee rate applied. */
  feeRate: number;
  /** True for the +100% remainder rung (full exit). */
  isFullExit: boolean;
}

// ── In-memory store (backs GET /api/health/scaleout-ladder) ──────────────────
//
// Module-global + observe-only. `dataDir` is set once at boot by
// hydrateScaleoutLadderFromDisk so the deep observe-pass site can append without
// threading a path through the SignalEngine. The `firedRungs` map is the per-position
// "which rungs already trimmed" set, rebuilt from the full JSONL on boot so a rung
// never re-fires after a restart. Counters are monotonic across the process life.

let dataDir: string | null = null;
let trimCount = 0;
let fullExitCount = 0;
let firstTrimAt: number | null = null;
let lastTrimAt: number | null = null;
const firedRungs = new Map<string, Set<number>>();
const recentTrims: ScaleoutTrimRecord[] = [];

// ── TRA-1729 observe-pass instrumentation ────────────────────────────────────
//
// The ladder was ARMED but BLIND: `trimCount:0` + `positionCount:0` (which was just
// `firedRungs.size`, a DUPLICATE of trimCount) read BYTE-IDENTICALLY in the two states
// that matter most to tell apart —
//   (a) observing an empty book every tick, so the gate can NEVER clear, and
//   (b) watching a live long sitting 1% under the +25% rung, about to fire.
// It read (a) for 8 days and looked like (b). These counters make the pass itself
// observable: what it ITERATED, how CLOSE it got, and WHEN it last ran.
//
// Three-valued on purpose. `null` = the pass has not run in this process; `0` = it ran
// and saw NOTHING (the alarm); `>0` = it is genuinely watching something. `0` is never
// the sentinel for "not measured" — a 0 here is a measurement, and a damning one.
//
// SINCE-BOOT vs DURABLE: the per-pass fields describe THIS process's liveness and are
// intentionally NOT persisted (a pass that ran before a reboot says nothing about
// whether the pass runs now). Only the high-water is durable, in the same DATA_DIR the
// trim log lives in — so it carries exactly the same durability as `trimCount`, no
// more (see TRA-1719: an unset DATA_DIR loses both at redeploy).

let lastObservePassAt: number | null = null;
let observePassCount = 0;
let lastPassOpenPositionCount: number | null = null;
let lastPassObservedCount: number | null = null;
let lastPassMaxGainPct: number | null = null;
let maxGainObserved: ScaleoutHighWater | null = null;

// ── TRA-4757 — the DURABLE non-blind observation accumulator ─────────────────
//
// TRA-1729 left one hole open, and TRA-4757 measured it on the live build: every
// field above that could witness a non-empty book is either LAST-PASS-ONLY or
// BLIND-INCLUSIVE, so a position that opened and closed between two reads leaves
// no trace at all.
//   • `observedPositionCount` is the LAST pass only — back to 0 one pass after the
//     book empties (~0.45s on bqb1, measured at ~2.2 passes/sec).
//   • `observePassCount` increments on a BLIND pass too (3275 → 3277 over ~0.6s
//     against an empty book), so it cannot separate "ran and saw a book" from
//     "ran and saw nothing".
//   • `maxGainPctObserved` is a HIGH-WATER: it advances only on a new maximum, so
//     a whole position peaking below the standing high-water (0.15268 today) moves
//     nothing.
// A reader sampling once per day therefore sees an INSTANT CELL, and a zero from a
// genuinely dead book is byte-identical to a zero from a book that was full between
// samples. TRA-1318's bear branch ("five consecutive zeros ⇒ NO-GO") was about to be
// computed on top of exactly that ambiguity.
//
// These five fields are the ACCUMULATOR that closes it: monotone, incremented on the
// observe pass (never on a trim — `trimCount` is the retired gate), and persisted in
// the same proven-durable store as the high-water. One read per day then becomes a
// strict SUPERSET of everything since the previous read.
//
// ── `null` is NOT `0`, and the discriminator is DURABLE ───────────────────────
// A counter that reads `0` because it has never existed and a counter that reads `0`
// because it has honestly counted nothing are the same pass/fail-identical bug one
// level up. `nonBlindArmedAt` is what splits them: it is stamped ONCE, into the
// durable snapshot, the first time a DATA_DIR-backed hydrate finds no accumulator
// block. So:
//   • armed (`nonBlindArmedAt != null`) ⇒ the counts are MEASUREMENTS and `0` means
//     "this store has watched since <armedAt> and never once saw a position";
//   • not armed ⇒ every count reports `null` — a pre-TRA-4757 store, or no DATA_DIR.
// Never `?? 0` any of them at a call site; that re-collapses the two readings.

let nonBlindArmedAt: number | null = null;
let nonBlindPassCount = 0;
let firstNonBlindAt: number | null = null;
let lastNonBlindAt: number | null = null;
let nonBlindEtDaysSeen = 0;
let lastNonBlindEtDay: string | null = null;

/**
 * Throttle for the durable snapshot rewrite. The observe pass runs ~2.2×/sec, so a
 * write per non-blind pass would be ~51k single-line rewrites across one RTH session
 * — pointless IO for a counter nobody reads more than daily.
 *
 * The throttle is SAFE ONLY BECAUSE THE SIGNAL-CARRYING TRANSITIONS BYPASS IT. The
 * first non-blind pass ever, and every ET day rollover, flush IMMEDIATELY (see
 * {@link recordScaleoutObservePass}); only `observedNonBlindPassCount` and
 * `lastObservedNonBlindAt` can lag, and only by ≤ this interval, and only downward.
 * So the durable count is a LOWER BOUND that can never manufacture a false sighting
 * — and the 0 → ≥1 edge, which is the one TRA-1318 hangs on, is never lost to a
 * reboot.
 */
const OBSERVE_SNAPSHOT_FLUSH_MS = 60_000;

/** Since-boot: when the durable snapshot was last actually written (throttle state). */
let lastSnapshotFlushAt: number | null = null;

export function scaleoutLadderLogPath(dir: string): string {
  return join(dir, SCALEOUT_LADDER_LOG_FILENAME);
}

/** Path of the durable observe-pass high-water snapshot (TRA-1729). */
export function scaleoutLadderObservePath(dir: string): string {
  return join(dir, SCALEOUT_LADDER_OBSERVE_FILENAME);
}

/** Test seam — drop every trim + counter and the configured dir. */
export function clearScaleoutLadderLedger(): void {
  dataDir = null;
  trimCount = 0;
  fullExitCount = 0;
  firstTrimAt = null;
  lastTrimAt = null;
  firedRungs.clear();
  recentTrims.length = 0;
  lastObservePassAt = null;
  observePassCount = 0;
  lastPassOpenPositionCount = null;
  lastPassObservedCount = null;
  lastPassMaxGainPct = null;
  maxGainObserved = null;
  nonBlindArmedAt = null;
  nonBlindPassCount = 0;
  firstNonBlindAt = null;
  lastNonBlindAt = null;
  nonBlindEtDaysSeen = 0;
  lastNonBlindEtDay = null;
  lastSnapshotFlushAt = null;
}

/**
 * ET calendar day (`YYYY-MM-DD`) of a ms-epoch instant, DST-aware via the shared
 * Eastern offset. ET and NOT UTC deliberately: the trading day is ET, and a UTC fold
 * splits the 13:30–20:00Z session across two day keys on any late session.
 *
 * Offset arithmetic rather than `new Intl.DateTimeFormat(...)` per call — this sits on
 * a ~2.2/sec pass, and constructing a formatter there is measurable waste. Same helper
 * shape as `learned-weights-history.ts:etDay`.
 */
function etDayOf(utcMs: number): string {
  return new Date(utcMs + getEasternUtcOffset(utcMs) * 3_600_000).toISOString().slice(0, 10);
}

/** The default per-side taker fee rate for an asset class (equity vs crypto). */
export function scaleoutFeeRate(assetClass: ScaleoutAssetClass): number {
  return assetClass === 'crypto' ? SCALE_OUT_TAKER_FEE_CRYPTO : SCALE_OUT_TAKER_FEE_EQUITY;
}

/** Fold one trim into the in-memory counters + fired-rung set + rolling tail (no IO). */
function applyTrim(rec: ScaleoutTrimRecord): void {
  trimCount += 1;
  if (rec.isFullExit) fullExitCount += 1;
  if (firstTrimAt == null || rec.ts < firstTrimAt) firstTrimAt = rec.ts;
  if (lastTrimAt == null || rec.ts > lastTrimAt) lastTrimAt = rec.ts;
  let set = firedRungs.get(rec.positionId);
  if (!set) {
    set = new Set<number>();
    firedRungs.set(rec.positionId, set);
  }
  set.add(rec.up);
  recentTrims.push(rec);
  while (recentTrims.length > MAX_RECENT_TRIMS) recentTrims.shift();
}

/**
 * Persist one intended trim: update the in-memory store AND append one JSONL line
 * under the configured DATA_DIR. Best-effort on IO — a write failure logs and is
 * swallowed so this accounting can never break the trade pass. When no dataDir is
 * configured (unit tests / CLI without boot) the counters still update; only the
 * file write is skipped.
 */
export function recordScaleoutTrim(rec: ScaleoutTrimRecord): void {
  applyTrim(rec);
  if (dataDir == null) return;
  const path = scaleoutLadderLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('scaleout-ladder trim append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── TRA-1729 — the observe pass itself ───────────────────────────────────────

/** One position the observe pass actually evaluated, and how far in its favour it sat. */
export interface ScaleoutObservation {
  positionId: string;
  symbol: string;
  /** Favorable excursion from avg entry (0.25 = +25%). NEGATIVE below the entry. */
  gainPct: number;
}

/** The best favorable excursion ever seen by an observe pass (durable high-water). */
export interface ScaleoutHighWater {
  gainPct: number;
  symbol: string;
  positionId: string;
  /** ms epoch of the pass that set this high-water. */
  ts: number;
}

/** What one observe pass looked at. `observed` ⊆ the book: unpriced/degenerate rows are dropped. */
export interface ScaleoutObservePass {
  /** Open positions in the book the pass walked (BEFORE the unpriced/degenerate drop). */
  openPositionCount: number;
  /** The positions it could actually evaluate the ladder against. */
  observed: readonly ScaleoutObservation[];
}

/**
 * TRA-4757 — the durable non-blind accumulator block, as it sits on disk inside the
 * observe snapshot. Persisted ONLY once `armedAt` is stamped, so a `passCount: 0` read
 * back off disk is always a real measurement over `[armedAt, now]`, never an absence.
 */
export interface ScaleoutNonBlindSnapshot {
  /** ms epoch the accumulator was first armed against this DATA_DIR. */
  armedAt: number;
  /** All-time passes with `observed.length >= 1`. Lower bound — see the throttle note. */
  passCount: number;
  /** ms epoch of the first non-blind pass ever. Flushed immediately; exact. */
  firstAt: number | null;
  /** ms epoch of the most recent non-blind pass. Lags by ≤ the flush throttle. */
  lastAt: number | null;
  /** Distinct ET calendar days with ≥1 non-blind pass. Flushed on rollover; exact. */
  etDaysSeen: number;
  /** Most recent such ET day, `YYYY-MM-DD`. */
  lastEtDay: string | null;
}

/**
 * The on-disk shape of `scaleout-ladder-observe.json`.
 *
 * ⚠️ The TRA-1729 high-water fields stay at the TOP LEVEL, exactly where they were, and
 * the TRA-4757 accumulator hangs off a nested `nonBlind` key. That is deliberate and it
 * is what makes the format compatible in BOTH directions against the live bqb1 store
 * (whose `GEMI` high-water is stamped 2026-07-26 and has survived ~56 days of boots):
 *   • an OLD build reading a NEW file still shape-checks the four top-level fields and
 *     hydrates the high-water — the extra key is ignored, so a rollback loses nothing;
 *   • a NEW build reading an OLD file finds no `nonBlind` block and arms one, rather
 *     than reading a missing counter as `0`.
 */
interface ScaleoutObserveSnapshot extends Partial<ScaleoutHighWater> {
  nonBlind?: ScaleoutNonBlindSnapshot;
}

/**
 * Rewrite the durable observe snapshot (best-effort, single line). The file is a
 * MONOTONE SCALAR SET rewritten in place, never appended to, so it cannot grow.
 *
 * A write failure logs and is swallowed: this is a readout, and it must never be able
 * to break the observe pass it instruments. Callers own the throttle — this always
 * writes when called.
 */
function persistScaleoutObserveSnapshot(now: number): void {
  if (dataDir == null) return;
  const snapshot: ScaleoutObserveSnapshot = {};
  // Spread the high-water at the top level (back-compat) only when we have one; an
  // absent high-water must stay ABSENT rather than land as four nulls that an older
  // build's shape check would reject.
  if (maxGainObserved != null) Object.assign(snapshot, maxGainObserved);
  if (nonBlindArmedAt != null) {
    snapshot.nonBlind = {
      armedAt: nonBlindArmedAt,
      passCount: nonBlindPassCount,
      firstAt: firstNonBlindAt,
      lastAt: lastNonBlindAt,
      etDaysSeen: nonBlindEtDaysSeen,
      lastEtDay: lastNonBlindEtDay,
    };
  }
  if (maxGainObserved == null && snapshot.nonBlind == null) return; // nothing to say yet
  const path = scaleoutLadderObservePath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the write below surfaces the error
  }
  try {
    writeFileSync(path, JSON.stringify(snapshot) + '\n', 'utf8');
    lastSnapshotFlushAt = now;
  } catch (err) {
    log.warn('scaleout-ladder observe snapshot write failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record that one observe pass RAN — the liveness half of this ledger. The caller MUST
 * call this on EVERY pass, including a pass over an empty book: an empty pass is the
 * whole point (it is what `observedPositionCount: 0` reports), and a pass that never
 * calls this is indistinguishable from a flag that is off.
 *
 * Observe-only: it touches no book and places no order. It updates the since-boot pass
 * counters and, when the pass saw a NEW best favorable excursion, advances the durable
 * high-water. A pass that observed nothing sets `maxGainPctLastPass` to `null`, NOT to
 * `0` — an empty pass did not observe a 0% gain, it observed no gain at all.
 *
 * TRA-4757: a pass with `observed.length >= 1` ALSO advances the durable non-blind
 * accumulator. That is the only field family on this route that a position which opens
 * and closes between two reads cannot slip past — see the accumulator comment above.
 */
export function recordScaleoutObservePass(
  pass: ScaleoutObservePass,
  now: number = Date.now(),
): void {
  observePassCount += 1;
  lastObservePassAt = now;
  lastPassOpenPositionCount = pass.openPositionCount;
  lastPassObservedCount = pass.observed.length;

  let best: ScaleoutObservation | null = null;
  for (const o of pass.observed) {
    if (!Number.isFinite(o.gainPct)) continue;
    if (best == null || o.gainPct > best.gainPct) best = o;
  }
  lastPassMaxGainPct = best == null ? null : best.gainPct;

  const advancedHighWater =
    best != null && (maxGainObserved == null || best.gainPct > maxGainObserved.gainPct);
  if (advancedHighWater && best != null) {
    maxGainObserved = {
      gainPct: best.gainPct,
      symbol: best.symbol,
      positionId: best.positionId,
      ts: now,
    };
  }

  // ── TRA-4757 accumulator ───────────────────────────────────────────────────
  // Keyed on `observed.length`, NOT on `best != null`: a position whose gainPct is
  // non-finite is still a position the pass WATCHED, and the question this counter
  // answers is "was the book ever non-empty", not "was it ever priced sanely".
  let mustFlush = advancedHighWater;
  if (pass.observed.length >= 1) {
    nonBlindPassCount += 1;
    lastNonBlindAt = now;
    if (firstNonBlindAt == null) {
      firstNonBlindAt = now;
      mustFlush = true; // the 0 → ≥1 edge: the one transition a reboot must never eat
    }
    const day = etDayOf(now);
    if (day !== lastNonBlindEtDay) {
      lastNonBlindEtDay = day;
      nonBlindEtDaysSeen += 1;
      mustFlush = true; // day rollover — also exact, also never throttled away
    }
    // ⛔ These two `mustFlush = true` are REDUNDANT FOR THE FIRST PASS and neither is
    // dead code. The first non-blind pass ever always changes the ET day too (from
    // `null`), so each branch covers the other there — mutating away either one alone
    // leaves the whole suite green; only removing BOTH goes red. Keep both: they
    // diverge on every LATER day rollover, and TRA-4757 explicitly offers the ET day
    // fields up as droppable, at which point the edge flush is the only guard left.
  }

  if (mustFlush) {
    persistScaleoutObserveSnapshot(now);
  } else if (pass.observed.length >= 1) {
    // Ordinary non-blind pass: rewrite at most once per OBSERVE_SNAPSHOT_FLUSH_MS.
    if (lastSnapshotFlushAt == null || now - lastSnapshotFlushAt >= OBSERVE_SNAPSHOT_FLUSH_MS) {
      persistScaleoutObserveSnapshot(now);
    }
  }
  // A BLIND pass writes nothing at all — there is no state for it to change, and a
  // rewrite per empty tick would be ~190k pointless writes a day on the dead book this
  // instrument exists to detect.
}

/** The open-position shape the observe pass needs (structurally the PaperAccount position). */
export interface ScaleoutOpenPosition {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  quantity: number;
}

/**
 * TRA-1300/TRA-1729 — run ONE observe pass over the open demo-equity book. This is the
 * whole pass, exported so it is unit-testable as the SAME function the SignalEngine
 * calls (the engine method is now a one-line delegation): the empty-book case is the
 * one that has to be proven to fire, and a test that re-implements the loop would prove
 * nothing about the loop that actually runs.
 *
 * OBSERVE-ONLY: reads the positions + the price map, writes only the ledger. Places NO
 * order and mutates NO account.
 *
 * It ALWAYS records the pass — even when every position is skipped, and even when the
 * book is empty. That unconditional record is the fix for TRA-1729: the pass had been
 * iterating an empty array for 8 days and leaving no trace of having done so.
 */
export function runScaleoutLadderObservePass(
  openPositions: readonly ScaleoutOpenPosition[],
  prices: ReadonlyMap<string, number>,
  now: number = Date.now(),
): void {
  const observed: ScaleoutObservation[] = [];

  for (const pos of openPositions) {
    const mark = prices.get(pos.symbol);
    if (mark == null || !(mark > 0)) continue;
    // A degenerate row comes back from the pure decision as `gainPct: 0` — a FALSE ZERO
    // that would read as "sitting exactly at entry". Drop it from the observation set;
    // the `openPositionCount − observedPositionCount` gap is what exposes it instead.
    if (!(pos.entryPrice > 0) || !(pos.quantity > 0)) continue;
    // Base size = current quantity of the (possibly scaled-in) position; the ladder
    // trims a fraction OF this. The observe book never partially closes, so the current
    // qty is the position's size for this forward sample.
    const decision = evaluateAndRecordScaleout(
      {
        positionId: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        avgEntry: pos.entryPrice,
        markPrice: mark,
        baseQty: pos.quantity,
        // -USD pairs are the crypto sleeve; everything else is equity (fee-rate pick).
        assetClass: pos.symbol.toUpperCase().endsWith('-USD') ? 'crypto' : 'equity',
        mode: 'demo',
      },
      now,
    );
    observed.push({ positionId: pos.id, symbol: pos.symbol, gainPct: decision.gainPct });

    for (const trim of decision.triggered) {
      log.info('scale-out ladder intended trim (TRA-1300, observe-only)', {
        symbol: pos.symbol,
        positionId: pos.id,
        gainPct: Number(decision.gainPct.toFixed(4)),
        rungUp: trim.up,
        sellPctBase: trim.sellPctBase,
        trimQty: trim.trimQty,
        netProceeds: Number(trim.netProceeds.toFixed(2)),
        isFullExit: trim.isFullExit,
      });
    }
  }

  // Unconditional — INCLUDING the empty-book / everything-skipped case. The loop above
  // can `continue` past every row and this still fires ⇒ `observedPositionCount: 0`,
  // which is the alarm the ticket is about.
  recordScaleoutObservePass({ openPositionCount: openPositions.length, observed }, now);
}

/** Position snapshot the observe pass feeds the ladder for one open position. */
export interface ScaleoutObserveInput {
  positionId: string;
  symbol: string;
  side: Side;
  avgEntry: number;
  markPrice: number;
  baseQty: number;
  assetClass: ScaleoutAssetClass;
  mode?: 'demo' | 'live';
}

/**
 * Evaluate the scale-out ladder for ONE open position and record any newly-triggered
 * trims (observe-only). Reads the position's already-fired rungs from the in-memory
 * set (hydrated from disk on boot) so each rung logs once, then appends a durable
 * record per new trim. Returns the pure decision for the caller's log line. Places
 * NO order. Below the average entry the ladder stands down (`downsideDeferred`) and
 * nothing is recorded — the downside is the chandelier / give-back cap's job.
 */
export function evaluateAndRecordScaleout(
  input: ScaleoutObserveInput,
  now: number = Date.now(),
): ScaleOutLadderDecision {
  const already = firedRungs.get(input.positionId);
  const feeRate = scaleoutFeeRate(input.assetClass);
  const decision = scaleOutLadderDecision({
    side: input.side,
    avgEntry: input.avgEntry,
    currentPrice: input.markPrice,
    baseQty: input.baseQty,
    feeRate,
    firedRungs: already ? [...already] : [],
  });
  for (const trim of decision.triggered) {
    recordScaleoutTrim({
      ts: now,
      mode: input.mode ?? 'demo',
      assetClass: input.assetClass,
      symbol: input.symbol.trim().toUpperCase(),
      positionId: input.positionId,
      side: input.side,
      avgEntry: input.avgEntry,
      markPrice: input.markPrice,
      gainPct: decision.gainPct,
      up: trim.up,
      sellPctBase: trim.sellPctBase,
      baseQty: input.baseQty,
      trimQty: trim.trimQty,
      grossProceeds: trim.grossProceeds,
      feeCost: trim.feeCost,
      netProceeds: trim.netProceeds,
      feeRate,
      isFullExit: trim.isFullExit,
    });
  }
  return decision;
}

/** What {@link hydrateScaleoutLadderFromDisk} recovered (for the boot log line). */
export interface ScaleoutLadderHydration {
  trimCount: number;
  fullExitCount: number;
  positionCount: number;
  firstTrimAt: number | null;
  lastTrimAt: number | null;
  /** TRA-1729 — the durable observe high-water recovered from disk (null = none yet). */
  maxGainPctObserved: number | null;
  /** TRA-4757 — durable non-blind pass count recovered from disk. `null` = not armed. */
  observedNonBlindPassCount: number | null;
}

/**
 * TRA-1729/TRA-4757 — restore the durable observe snapshot. Best-effort and
 * shape-checked per BLOCK: a missing/corrupt/non-numeric high-water leaves the
 * high-water `null` (honestly "never measured") rather than throwing or, worse,
 * laundering a garbage row into a 0 — and the same, independently, for the non-blind
 * accumulator. The two blocks are validated separately on purpose: a build that
 * rolled back and rewrote the legacy-only shape must not take the high-water down
 * with the missing accumulator, and a corrupt accumulator must not discard a
 * ~56-day-old high-water.
 */
function hydrateScaleoutObserveSnapshot(dir: string): void {
  let raw = '';
  try {
    raw = readFileSync(scaleoutLadderObservePath(dir), 'utf8').trim();
  } catch {
    return; // no snapshot yet — high-water and accumulator stay null
  }
  if (raw === '') return;
  let rec: ScaleoutObserveSnapshot;
  try {
    rec = JSON.parse(raw) as ScaleoutObserveSnapshot;
  } catch {
    log.warn('scaleout-ladder observe snapshot unparseable — ignored');
    return;
  }

  if (
    typeof rec.gainPct === 'number' &&
    Number.isFinite(rec.gainPct) &&
    typeof rec.symbol === 'string' &&
    typeof rec.positionId === 'string' &&
    typeof rec.ts === 'number'
  ) {
    maxGainObserved = {
      gainPct: rec.gainPct,
      symbol: rec.symbol,
      positionId: rec.positionId,
      ts: rec.ts,
    };
  } else {
    // Not necessarily a defect: once the accumulator exists, a snapshot may legitimately
    // carry ONLY the `nonBlind` block (armed, high-water never measured). Only warn when
    // there is a partial high-water to complain about.
    if (rec.gainPct !== undefined || rec.symbol !== undefined || rec.positionId !== undefined) {
      log.warn('scaleout-ladder observe high-water snapshot malformed — ignored');
    }
  }

  const nb = rec.nonBlind;
  if (nb == null) return; // pre-TRA-4757 store — the caller arms it
  if (
    typeof nb.armedAt === 'number' &&
    Number.isFinite(nb.armedAt) &&
    typeof nb.passCount === 'number' &&
    Number.isFinite(nb.passCount) &&
    typeof nb.etDaysSeen === 'number' &&
    Number.isFinite(nb.etDaysSeen)
  ) {
    nonBlindArmedAt = nb.armedAt;
    nonBlindPassCount = nb.passCount;
    nonBlindEtDaysSeen = nb.etDaysSeen;
    firstNonBlindAt = typeof nb.firstAt === 'number' && Number.isFinite(nb.firstAt) ? nb.firstAt : null;
    lastNonBlindAt = typeof nb.lastAt === 'number' && Number.isFinite(nb.lastAt) ? nb.lastAt : null;
    lastNonBlindEtDay = typeof nb.lastEtDay === 'string' && nb.lastEtDay !== '' ? nb.lastEtDay : null;
  } else {
    // Leave it UNARMED. A malformed accumulator must read `null` (= "no durable
    // measurement"), never 0 — the caller then re-arms with a fresh `armedAt`, which
    // truthfully says the counted window starts now.
    log.warn('scaleout-ladder observe non-blind accumulator malformed — ignored');
  }
}

/**
 * Rebuild the in-memory store from disk on boot and remember `dir` for subsequent
 * appends. Idempotent: CLEARS first, so it is safe to call exactly once at startup
 * before any observe pass. Reads the ENTIRE JSONL — each line is one terminal trim,
 * so the counters and the per-position fired-rung set are exact and no snapshot is
 * needed. Best-effort: a missing/corrupt file yields an empty hydration (torn
 * trailing lines are skipped) rather than throwing.
 */
export function hydrateScaleoutLadderFromDisk(
  dir: string,
  now: number = Date.now(),
): ScaleoutLadderHydration {
  clearScaleoutLadderLedger();
  dataDir = dir;

  // TRA-1463 — this synchronous readFileSync + split + per-line JSON.parse is one
  // of the boot-hydrate candidates for the residual ~71s event-loop block; wrap it
  // so a stall here is NAMED in the watchdog trip breadcrumb (`slowPhase`).
  return timeSyncPhase('hydrate.scaleoutLadder', () => {
    hydrateScaleoutObserveSnapshot(dir);

    // TRA-4757 — ARM the non-blind accumulator if this store has never carried one.
    // This is the ONE write that makes a later `observedNonBlindPassCount: 0` readable
    // as a measurement instead of an absence, so it happens at boot (once, on a
    // pre-TRA-4757 or corrupt store) rather than waiting for a non-blind pass that may
    // never come — the dead-book case is exactly the case this instrument is for, and
    // arming lazily would leave it reporting `null` forever in precisely that state.
    if (nonBlindArmedAt == null) {
      nonBlindArmedAt = now;
      persistScaleoutObserveSnapshot(now);
    }

    let raw = '';
    try {
      raw = readFileSync(scaleoutLadderLogPath(dir), 'utf8');
    } catch {
      raw = '';
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const rec = JSON.parse(trimmed) as ScaleoutTrimRecord;
        if (
          typeof rec.ts === 'number' &&
          typeof rec.positionId === 'string' &&
          typeof rec.up === 'number'
        ) {
          applyTrim(rec);
        }
      } catch {
        // skip a torn/partial trailing line rather than abort the hydrate
      }
    }

    return {
      trimCount,
      fullExitCount,
      positionCount: firedRungs.size,
      firstTrimAt,
      lastTrimAt,
      maxGainPctObserved: maxGainObserved?.gainPct ?? null,
      observedNonBlindPassCount: nonBlindArmedAt == null ? null : nonBlindPassCount,
    };
  });
}

// ── Health summary ────────────────────────────────────────────────────────────

/**
 * TRA-1729 — is the pass actually watching anything?
 *   `never_ran`  the observe pass has NOT run in this process (flag off, or not yet
 *                ticked). Says nothing about the book — it is the absence of a reading.
 *   `blind`      it RAN and iterated ZERO positions. THE ALARM: `trimCount` cannot ever
 *                increment, so any accrual gate hanging off it is structurally dead.
 *   `observing`  it ran and evaluated ≥1 position — the counters are a real sample.
 */
export type ScaleoutObserveStatus = 'never_ran' | 'blind' | 'observing';

export interface ScaleoutLadderSummary {
  /** Total intended trims recorded (all-time; survives restart). */
  trimCount: number;
  /** Trims that were the +100% remainder rung (full exits). */
  fullExitCount: number;
  /** Distinct positions with ≥1 recorded trim. NOTE: a re-spelling of trimCount's
   *  support, NOT a count of what is being watched — that is observedPositionCount. */
  positionCount: number;
  /** ms epoch of the first / last recorded trim. */
  firstTrimAt: number | null;
  lastTrimAt: number | null;
  /** Most-recent trims, oldest→newest (capped tail). */
  recent: ScaleoutTrimRecord[];

  // ── TRA-1729 observe-pass instrumentation (all since-boot unless noted) ──────
  /** Positions the LAST pass actually evaluated. `null` = no pass yet; `0` = BLIND. */
  observedPositionCount: number | null;
  /** Open positions the last pass walked before dropping unpriced/degenerate rows. */
  openPositionCount: number | null;
  /** Best favorable excursion the last pass saw (`null` when it saw nothing). */
  maxGainPctLastPass: number | null;
  /** DURABLE high-water (survives restart via DATA_DIR): the closest the ladder has
   *  ever come to a rung. `null` = never measured — NOT the same as 0 (= at entry). */
  maxGainPctObserved: number | null;
  /** Which position/symbol/when set that high-water. */
  maxGainObserved: ScaleoutHighWater | null;
  /** ms epoch of the last observe pass that ran with the flag on. */
  lastObservePassAt: number | null;
  /** Passes run since boot. A monotone tick that PROVES the pass fires at all. */
  observePassCount: number;
  /** never_ran / blind / observing — see {@link ScaleoutObserveStatus}. */
  observeStatus: ScaleoutObserveStatus;
  /** The lowest rung (0.25 = +25%), so a reader can size maxGainPctObserved against it. */
  firstRungUp: number;

  // ── TRA-4757 DURABLE non-blind accumulator (survives restart via DATA_DIR) ───
  // Every field here is `null` when the accumulator is NOT ARMED (pre-TRA-4757 store,
  // corrupt block, or no DATA_DIR). Armed, a `0` is a MEASUREMENT over
  // [observedNonBlindArmedAt, now]. ⛔ Never `?? 0` these.
  /** ms epoch the accumulator was armed against this store — the start of the window
   *  a `0` count covers. A count without this is uninterpretable. */
  observedNonBlindArmedAt: number | null;
  /** All-time passes that saw ≥1 position. The field TRA-1318 samples: it is an
   *  ACCUMULATOR, so one read per day is a strict superset of the previous read.
   *  LOWER BOUND — up to `OBSERVE_SNAPSHOT_FLUSH_MS` of ticks can be lost to a hard
   *  reboot, but never the 0 → ≥1 edge, which flushes immediately. */
  observedNonBlindPassCount: number | null;
  /** ms epoch of the first non-blind pass EVER. Exact (never throttled). */
  firstObservedNonBlindAt: number | null;
  /** ms epoch of the most recent non-blind pass. Lags by ≤ the flush throttle. */
  lastObservedNonBlindAt: number | null;
  /** Distinct ET calendar days with ≥1 non-blind pass. ET, not UTC: a UTC fold splits
   *  the 13:30–20:00Z session. Exact (day rollovers flush immediately). */
  observedEtDaysSeen: number | null;
  /** Most recent ET day with a non-blind pass, `YYYY-MM-DD`. */
  lastObservedEtDay: string | null;
}

/**
 * Fold the store into the read-only health diagnostics. Pure — no IO, no realized
 * PnL. The counters are monotonic and rebuilt from the JSONL on boot, so they are
 * the since-deploy forward sample QuantTrader validates.
 *
 * TRA-1729: it now also reports the OBSERVE PASS, not just its output. `trimCount:0`
 * alone is ambiguous — it is what a healthy, patient ladder reports AND what a ladder
 * iterating an empty array forever reports. `observedPositionCount` splits those.
 */
export function summarizeScaleoutLadder(): ScaleoutLadderSummary {
  const observeStatus: ScaleoutObserveStatus =
    lastObservePassAt == null
      ? 'never_ran'
      : lastPassObservedCount === 0
        ? 'blind'
        : 'observing';

  return {
    trimCount,
    fullExitCount,
    positionCount: firedRungs.size,
    firstTrimAt,
    lastTrimAt,
    recent: recentTrims.slice(-MAX_RECENT_TRIMS),

    observedPositionCount: lastPassObservedCount,
    openPositionCount: lastPassOpenPositionCount,
    maxGainPctLastPass: lastPassMaxGainPct,
    maxGainPctObserved: maxGainObserved?.gainPct ?? null,
    maxGainObserved,
    lastObservePassAt,
    observePassCount,
    observeStatus,
    firstRungUp: FIRST_RUNG_UP,

    // Gated on `nonBlindArmedAt` as ONE unit — reporting a count while the arming
    // stamp is null would be the exact "0 that might mean never" this closes.
    observedNonBlindArmedAt: nonBlindArmedAt,
    observedNonBlindPassCount: nonBlindArmedAt == null ? null : nonBlindPassCount,
    firstObservedNonBlindAt: nonBlindArmedAt == null ? null : firstNonBlindAt,
    lastObservedNonBlindAt: nonBlindArmedAt == null ? null : lastNonBlindAt,
    observedEtDaysSeen: nonBlindArmedAt == null ? null : nonBlindEtDaysSeen,
    lastObservedEtDay: nonBlindArmedAt == null ? null : lastNonBlindEtDay,
  };
}
