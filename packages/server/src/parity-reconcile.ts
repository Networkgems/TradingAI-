// TRA-2237 (parent TRA-2234 → grandparent TRA-2174, board `de2afcbd`) — the
// parity-reconcile monitor.
//
// ── WHAT THIS IS ─────────────────────────────────────────────────────────────
// A pure summarizer + durable daily series + no-auth health route that turns each
// SANDBOX round-trip's OWN mid-vs-fill into a per-strategy demo-mark-vs-sandbox-fill
// P&L-gap / half-spread observable. Everything needed is already on the
// `SandboxStrategyRecord` legs (TRA-2134): `requestedPx` = the decision mid = what the
// demo book marks at, `fillPx` = the real sandbox fill. There is NO new order stream
// and NO cross-account matching — the "demo" side is a labelled COUNTERFACTUAL
// mid-mark of the very same sandbox round-trip, not the demo `option-trade-journal`.
//
// ── WHY IT CANNOT GATE ANYTHING ──────────────────────────────────────────────
// Sandbox fills are broker-SIMULATED (`fillRealism:'SANDBOX_SIMULATED'`): they model
// no real queue position, slippage, or partial-fill-under-load. So this gap is a
// data-quality observable ONLY. It sits under the TRA-1897 hold — nothing here gates,
// arms, or graduates. The `fillRealism` tag rides on the payload precisely so no
// downstream reader mistakes it for a live-execution number.
//
// ── THE IDENTITY THAT MAKES IT COMPUTABLE FROM ONE ACCOUNT ───────────────────
// Per leg, the signed cost of crossing the spread AWAY from the decision mid is
//   signedCostPerContract = side === 'buy' ? (fillPx − requestedPx)   // paid up to buy
//                                          : (requestedPx − fillPx)   // gave up to sell
// A round-trip's demo-mark cashflow marks every leg at `requestedPx`; its real cashflow
// marks at `fillPx`. Summing signed leg cashflows,
//   parityGapUsd(rt) = Σ_legs signedCostPerContract × 100  ==  demoMarkPnl − sandboxFillPnl
// i.e. the half-spread the demo book's mid-mark silently omits vs. the real fill. Both
// P&Ls here EXCLUDE modeled commission by construction (they differ only in px), so the
// gap isolates the fill-vs-mid spread cost, not fees. (Contract multiplier 100, qty
// assumed 1 — TRA-2134 round-trips are single-contract; tagged `qtyAssumed:1`.)
//
// ── NULL DISCIPLINE (the recurring false-zero trap) ──────────────────────────
// A leg with `requestedPx == null` (one-sided decision quote) OR `fillPx == null`
// (never filled) makes the WHOLE round-trip uncomputable: it is EXCLUDED and an
// `uncomputable` counter is incremented. A null is NEVER folded as 0 — a 0-gap and an
// unprovable gap must not read alike. Likewise `gapPct` is 3-valued: null when the
// demo-mark denominator is ≈0, never a fabricated 0.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import { etDateString } from './scheduler.js';
import { FILL_REALISM, FILL_REALISM_NOTE } from './tradier-sandbox-options-smoke.js';
import type { SandboxStrategyRecord } from './sandbox-strategy-journal.js';

const log = logger.child({ module: 'parity-reconcile' });

export const PARITY_RECONCILE_LOG_FILENAME = 'parity-reconcile.jsonl';

/** Retain this many ms of daily snapshots on disk (compacted on boot). 60 days — same
 *  standing-program horizon as the sandbox journal this folds from. */
const RETAIN_MS = 60 * 24 * 60 * 60 * 1000;

/** Option contract multiplier. qty is assumed 1 (single-contract round-trips). */
const CONTRACT_MULTIPLIER = 100;

/** |denominator| below this is treated as zero for `gapPct` (⇒ null, never a fake 0). */
const DENOM_EPS = 1e-9;

export const PARITY_SCOPE =
  'SANDBOX ONLY (acct VA20296703), $0 real notional. Demo side is a COUNTERFACTUAL '
  + 'mid-mark of the sandbox round-trip itself — NEVER pooled with demo option-trade-journal '
  + 'rows. Read-only observable under the TRA-1897 hold; gates/arms/graduates nothing.';

// ── per-round-trip fold (pure) ───────────────────────────────────────────────

/** The computable parity of one round-trip, or `null` when any leg is unprovable. */
export interface RoundTripParity {
  demoMarkPnlUsd: number;
  sandboxFillPnlUsd: number;
  /** `demoMarkPnl − sandboxFillPnl` = Σ_legs signedCostPerContract × 100. */
  parityGapUsd: number;
  /** Per-leg `signedCostPerContract / requestedPx × 1e4`; only finite entries. */
  legHalfSpreadBps: number[];
}

/**
 * Fold one round-trip into its parity contribution. Returns `null` when ANY leg has a
 * null `requestedPx` or `fillPx` (⇒ the caller counts it `uncomputable` and drops it) —
 * a missing price is NEVER coerced to 0. A round-trip with zero legs is also
 * uncomputable (nothing to mark).
 */
export function parityForRoundTrip(rec: SandboxStrategyRecord): RoundTripParity | null {
  if (rec.legs.length === 0) return null;
  let demoMarkPnlUsd = 0;
  let sandboxFillPnlUsd = 0;
  let parityGapUsd = 0;
  const legHalfSpreadBps: number[] = [];
  for (const leg of rec.legs) {
    const { requestedPx, fillPx, side } = leg;
    if (requestedPx == null || fillPx == null) return null; // uncomputable — never fold as 0
    // A sell leg is a cash inflow (+px), a buy leg an outflow (−px). Marking every leg
    // at its mid gives the demo book's P&L; at its fill, the real sandbox P&L.
    const sign = side === 'sell' ? 1 : -1;
    demoMarkPnlUsd += sign * requestedPx * CONTRACT_MULTIPLIER;
    sandboxFillPnlUsd += sign * fillPx * CONTRACT_MULTIPLIER;
    const signedCostPerContract = side === 'buy' ? fillPx - requestedPx : requestedPx - fillPx;
    parityGapUsd += signedCostPerContract * CONTRACT_MULTIPLIER;
    if (requestedPx !== 0 && Number.isFinite(requestedPx)) {
      const bps = (signedCostPerContract / requestedPx) * 1e4;
      if (Number.isFinite(bps)) legHalfSpreadBps.push(bps);
    }
  }
  return { demoMarkPnlUsd, sandboxFillPnlUsd, parityGapUsd, legHalfSpreadBps };
}

// ── per-strategy aggregate (pure) ────────────────────────────────────────────

export interface ParityBucket {
  /** Computable (fully-priced) round-trips in this bucket. */
  n: number;
  /** Round-trips excluded because a leg had a null requested/fill price. NOT a 0-gap. */
  uncomputable: number;
  demoMarkPnlUsd: number;
  sandboxFillPnlUsd: number;
  parityGapUsd: { sum: number; mean: number | null };
  /** `parityGapUsd.sum / |demoMarkPnlUsd|`; null when |denom| ≈ 0 (3-valued, never 0). */
  gapPct: number | null;
  halfSpreadBps: { mean: number | null; median: number | null; p90: number | null };
}

export interface ParityStrategyEntry {
  /** Metrics restricted to the reference ET day (`etDay` at the payload root). */
  etDay: ParityBucket;
  /** Metrics over every retained round-trip for this strategy. */
  cumulative: ParityBucket;
  fillRealism: typeof FILL_REALISM;
  qtyAssumed: 1;
}

export interface ParityReconcileSummary {
  /** The reference ET calendar day the `etDay` bucket is scoped to (from `now`). */
  etDay: string;
  totalRecords: number;
  strategies: Record<string, ParityStrategyEntry>;
  retentionDays: number;
  fillRealism: typeof FILL_REALISM;
  fillRealismNote: string;
  qtyAssumed: 1;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Percentile by linear interpolation on the sorted sample; `null` on an empty sample.
 *  p=0.5 ⇒ median, p=0.9 ⇒ p90. n=1 returns that single value for any p. */
function percentile(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

/** Aggregate a set of round-trips into one bucket. Pure. */
function foldBucket(recs: readonly SandboxStrategyRecord[]): ParityBucket {
  let n = 0;
  let uncomputable = 0;
  let demoMarkPnlUsd = 0;
  let sandboxFillPnlUsd = 0;
  let gapSum = 0;
  const halfSpreads: number[] = [];
  for (const rec of recs) {
    const p = parityForRoundTrip(rec);
    if (p == null) {
      uncomputable += 1;
      continue;
    }
    n += 1;
    demoMarkPnlUsd += p.demoMarkPnlUsd;
    sandboxFillPnlUsd += p.sandboxFillPnlUsd;
    gapSum += p.parityGapUsd;
    for (const bps of p.legHalfSpreadBps) halfSpreads.push(bps);
  }
  const denom = Math.abs(demoMarkPnlUsd);
  const sorted = halfSpreads.slice().sort((a, b) => a - b);
  const hsMean = halfSpreads.length > 0 ? halfSpreads.reduce((a, b) => a + b, 0) / halfSpreads.length : null;
  return {
    n,
    uncomputable,
    demoMarkPnlUsd: round2(demoMarkPnlUsd),
    sandboxFillPnlUsd: round2(sandboxFillPnlUsd),
    parityGapUsd: { sum: round2(gapSum), mean: n > 0 ? round2(gapSum / n) : null },
    gapPct: denom > DENOM_EPS ? round2(gapSum / denom) : null,
    halfSpreadBps: {
      mean: hsMean != null ? round2(hsMean) : null,
      median: (() => { const m = percentile(sorted, 0.5); return m != null ? round2(m) : null; })(),
      p90: (() => { const m = percentile(sorted, 0.9); return m != null ? round2(m) : null; })(),
    },
  };
}

/**
 * Fold the sandbox journal records into the per-strategy parity summary. Pure — no IO.
 * `now` fixes the reference ET day the `etDay` bucket is scoped to; `cumulative` spans
 * every retained record for the strategy. A strategy present with `n:0` but
 * `uncomputable>0` is the tell that it ran but every round-trip was unpriced — do NOT
 * read that as a 0 gap.
 */
export function summarizeParityReconcile(
  records: readonly SandboxStrategyRecord[],
  now: number = Date.now(),
): ParityReconcileSummary {
  const refEtDay = etDateString(new Date(now));
  const byStrategy = new Map<string, SandboxStrategyRecord[]>();
  for (const rec of records) {
    const list = byStrategy.get(rec.strategy) ?? [];
    list.push(rec);
    byStrategy.set(rec.strategy, list);
  }
  const strategies: Record<string, ParityStrategyEntry> = {};
  for (const [strategy, list] of byStrategy.entries()) {
    const today = list.filter((r) => r.etDay === refEtDay);
    strategies[strategy] = {
      etDay: foldBucket(today),
      cumulative: foldBucket(list),
      fillRealism: FILL_REALISM,
      qtyAssumed: 1,
    };
  }
  return {
    etDay: refEtDay,
    totalRecords: records.length,
    strategies,
    retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
    fillRealism: FILL_REALISM,
    fillRealismNote: FILL_REALISM_NOTE,
    qtyAssumed: 1,
  };
}

// ── durable daily series ─────────────────────────────────────────────────────

/** One compact per-strategy point in a daily snapshot. */
export interface ParitySnapshotStrategy {
  parityGapUsd: number;
  meanHalfSpreadBps: number | null;
  n: number;
}

/** One appended snapshot: the etDay bucket, per strategy, for a single ET calendar day. */
export interface ParityDailySnapshot {
  etDay: string;
  /** ms epoch the snapshot was appended (retention/compaction key). */
  ts: number;
  perStrategy: Record<string, ParitySnapshotStrategy>;
}

let dataDir: string | null = null;
const series: ParityDailySnapshot[] = [];
let appendErrors = 0;
let lastAppendError: string | null = null;
let hydratedSnapshots = 0;

export function parityReconcileLogPath(dir: string): string {
  return join(dir, PARITY_RECONCILE_LOG_FILENAME);
}

/** Test seam — drop every counter, the series, and the configured dir. */
export function clearParityReconcile(): void {
  dataDir = null;
  series.length = 0;
  appendErrors = 0;
  lastAppendError = null;
  hydratedSnapshots = 0;
}

/** Read-only view of the durable daily series (chronological). */
export function getParityReconcileSeries(): readonly ParityDailySnapshot[] {
  return series;
}

function isValidSnapshot(snap: unknown): snap is ParityDailySnapshot {
  if (snap == null || typeof snap !== 'object') return false;
  const s = snap as Record<string, unknown>;
  return (
    typeof s.etDay === 'string' &&
    s.etDay !== '' &&
    typeof s.ts === 'number' &&
    Number.isFinite(s.ts) &&
    s.perStrategy != null &&
    typeof s.perStrategy === 'object'
  );
}

/**
 * Rebuild the daily series from disk on boot and remember `dir` for subsequent appends.
 * Idempotent: CLEARS first. Only snapshots within {@link RETAIN_MS} of `now` are kept,
 * and the file is COMPACTED to exactly those lines. Best-effort: a missing/corrupt file
 * yields an empty series; a torn trailing line is skipped.
 */
export function hydrateParityReconcileFromDisk(
  dir: string,
  now: number = Date.now(),
): { snapshots: number; days: number } {
  clearParityReconcile();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(parityReconcileLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  const days = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let snap: unknown;
    try {
      snap = JSON.parse(trimmed);
    } catch {
      continue; // torn/partial line
    }
    if (!isValidSnapshot(snap)) continue;
    if (snap.ts < cutoff) continue;
    series.push(snap);
    days.add(snap.etDay);
    kept.push(JSON.stringify(snap));
  }
  hydratedSnapshots = series.length;

  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = parityReconcileLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('parity-reconcile series compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { snapshots: hydratedSnapshots, days: days.size };
}

/** True ⇔ the series already carries a snapshot for `etDay`. */
function hasSnapshotFor(etDay: string): boolean {
  return series.some((s) => s.etDay === etDay);
}

/**
 * Self-accrual: append TODAY's etDay-bucket snapshot the FIRST time this runs for a new
 * ET day, so the series grows on the runner routine's existing weekday read (no new
 * cron). Idempotent — a second call the same day is a no-op. Best-effort on IO: a write
 * failure is counted + logged, never thrown (a monitor must never break its own read).
 * A day with no computable round-trips for any strategy is NOT snapshotted (nothing to
 * record yet); the snapshot lands once real parity exists.
 */
export function appendParitySnapshotForDay(
  records: readonly SandboxStrategyRecord[],
  now: number = Date.now(),
): ParityDailySnapshot | null {
  const etDay = etDateString(new Date(now));
  if (hasSnapshotFor(etDay)) return null;

  const summary = summarizeParityReconcile(records, now);
  const perStrategy: Record<string, ParitySnapshotStrategy> = {};
  for (const [strategy, entry] of Object.entries(summary.strategies)) {
    if (entry.etDay.n === 0) continue; // no computable round-trip for this strategy today
    perStrategy[strategy] = {
      parityGapUsd: entry.etDay.parityGapUsd.sum,
      meanHalfSpreadBps: entry.etDay.halfSpreadBps.mean,
      n: entry.etDay.n,
    };
  }
  if (Object.keys(perStrategy).length === 0) return null; // nothing to accrue yet today

  const snapshot: ParityDailySnapshot = { etDay, ts: now, perStrategy };
  series.push(snapshot);
  if (dataDir != null) {
    const path = parityReconcileLogPath(dataDir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(snapshot) + '\n', 'utf8');
    } catch (err) {
      appendErrors += 1;
      lastAppendError = err instanceof Error ? err.message : String(err);
      log.warn('parity-reconcile snapshot append failed', { reason: lastAppendError });
    }
  }
  return snapshot;
}

export interface ParityReconcileDurability {
  dataDir: string | null;
  ephemeral: boolean;
  hydratedSnapshots: number;
  appendErrors: number;
  lastAppendError: string | null;
}

export function parityReconcileDurability(): ParityReconcileDurability {
  return {
    dataDir,
    ephemeral: isEphemeralDataDir(dataDir),
    hydratedSnapshots,
    appendErrors,
    lastAppendError,
  };
}
