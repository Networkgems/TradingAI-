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
} from '@trading-app/shared';
import { logger } from './observability/index.js';
import { timeSyncPhase } from './phase-timing.js';

const log = logger.child({ module: 'scaleout-ladder-ledger' });

export const SCALEOUT_LADDER_LOG_FILENAME = 'scaleout-ladder-trims.jsonl';

// TRA-1729 — the observe-pass high-water snapshot. A SEPARATE, single-line file (not
// the append-only trim log): the high-water is a MONOTONE SCALAR, so it is rewritten
// in place on each advance and the file can never grow. Rewrite-on-advance (rather
// than one line per pass) is what keeps a ~1/min observe pass from growing an
// unbounded JSONL that the boot hydrate would then have to read end-to-end.
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
 * Rewrite the durable high-water snapshot (best-effort, single line). Called only when
 * the high-water ADVANCES, which is monotone and therefore rare — the file never grows.
 * A write failure logs and is swallowed: this is a readout, and it must never be able
 * to break the observe pass it instruments.
 */
function persistScaleoutHighWater(): void {
  if (dataDir == null || maxGainObserved == null) return;
  const path = scaleoutLadderObservePath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the write below surfaces the error
  }
  try {
    writeFileSync(path, JSON.stringify(maxGainObserved) + '\n', 'utf8');
  } catch (err) {
    log.warn('scaleout-ladder observe high-water write failed', {
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

  if (best != null && (maxGainObserved == null || best.gainPct > maxGainObserved.gainPct)) {
    maxGainObserved = {
      gainPct: best.gainPct,
      symbol: best.symbol,
      positionId: best.positionId,
      ts: now,
    };
    persistScaleoutHighWater();
  }
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
}

/**
 * TRA-1729 — restore the durable observe-pass high-water. Best-effort and shape-checked:
 * a missing/corrupt/non-numeric snapshot leaves the high-water `null` (honestly "never
 * measured") rather than throwing or, worse, laundering a garbage row into a 0.
 */
function hydrateScaleoutHighWater(dir: string): void {
  let raw = '';
  try {
    raw = readFileSync(scaleoutLadderObservePath(dir), 'utf8').trim();
  } catch {
    return; // no snapshot yet — high-water stays null
  }
  if (raw === '') return;
  try {
    const rec = JSON.parse(raw) as ScaleoutHighWater;
    if (
      typeof rec.gainPct === 'number' &&
      Number.isFinite(rec.gainPct) &&
      typeof rec.symbol === 'string' &&
      typeof rec.positionId === 'string' &&
      typeof rec.ts === 'number'
    ) {
      maxGainObserved = rec;
    } else {
      log.warn('scaleout-ladder observe high-water snapshot malformed — ignored');
    }
  } catch {
    log.warn('scaleout-ladder observe high-water snapshot unparseable — ignored');
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
export function hydrateScaleoutLadderFromDisk(dir: string): ScaleoutLadderHydration {
  clearScaleoutLadderLedger();
  dataDir = dir;

  // TRA-1463 — this synchronous readFileSync + split + per-line JSON.parse is one
  // of the boot-hydrate candidates for the residual ~71s event-loop block; wrap it
  // so a stall here is NAMED in the watchdog trip breadcrumb (`slowPhase`).
  return timeSyncPhase('hydrate.scaleoutLadder', () => {
    hydrateScaleoutHighWater(dir);

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
  };
}
