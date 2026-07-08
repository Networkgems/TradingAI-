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

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  scaleOutLadderDecision,
  type Side,
  type ScaleOutLadderDecision,
} from '@trading-app/engine';
import {
  SCALE_OUT_TAKER_FEE_EQUITY,
  SCALE_OUT_TAKER_FEE_CRYPTO,
} from '@trading-app/shared';
import { logger } from './observability/index.js';
import { timeSyncPhase } from './phase-timing.js';

const log = logger.child({ module: 'scaleout-ladder-ledger' });

export const SCALEOUT_LADDER_LOG_FILENAME = 'scaleout-ladder-trims.jsonl';

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

export function scaleoutLadderLogPath(dir: string): string {
  return join(dir, SCALEOUT_LADDER_LOG_FILENAME);
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
    };
  });
}

// ── Health summary ────────────────────────────────────────────────────────────

export interface ScaleoutLadderSummary {
  /** Total intended trims recorded (all-time; survives restart). */
  trimCount: number;
  /** Trims that were the +100% remainder rung (full exits). */
  fullExitCount: number;
  /** Distinct positions with ≥1 recorded trim. */
  positionCount: number;
  /** ms epoch of the first / last recorded trim. */
  firstTrimAt: number | null;
  lastTrimAt: number | null;
  /** Most-recent trims, oldest→newest (capped tail). */
  recent: ScaleoutTrimRecord[];
}

/**
 * Fold the store into the read-only health diagnostics. Pure — no IO, no realized
 * PnL. The counters are monotonic and rebuilt from the JSONL on boot, so they are
 * the since-deploy forward sample QuantTrader validates.
 */
export function summarizeScaleoutLadder(): ScaleoutLadderSummary {
  return {
    trimCount,
    fullExitCount,
    positionCount: firedRungs.size,
    firstTrimAt,
    lastTrimAt,
    recent: recentTrims.slice(-MAX_RECENT_TRIMS),
  };
}
