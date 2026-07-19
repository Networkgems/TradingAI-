/**
 * TRA-2046 (parent TRA-2044) — execution-quality telemetry completeness.
 *
 * Closes the slippage proposal's "track partial fills, rejected orders, stale
 * quotes, cancel/replace latency" ask. PURE OBSERVABILITY — nothing here routes,
 * cancels, or re-prices an order; it only folds measurements the order paths
 * already produce. Three gaps the existing ledgers did not cover:
 *
 *  1. Cancel/replace round-trip latency — the maker walk (`submitSmartBuyToOpen`
 *     / `submitSmartSellToClose`) cancels and re-prices each step; the only
 *     latency measured before was end-to-end `timeToFillMs`. This captures the
 *     per-step cancel->ack and replace->ack round-trips and aggregates them to
 *     p50/p95.
 *  2. Partial-fill fraction — `exec_quantity` / `remaining_quantity` were
 *     surfaced per order but never aggregated. This folds them into a
 *     partial-fill rate (among orders that got ANY fill) + average filled
 *     fraction.
 *  3. Stale-quote rejection count — surfaced by consuming the counted reasons
 *     TRA-2045's order-quote guard already emits (`snapshotOrderGuardMetrics`);
 *     no separate counter path, so the two never disagree.
 *
 * ## Design — memory-only, since-boot, always-on
 * Mirrors the TRA-2045 order-guard counter registry: a small in-memory
 * registry, no disk IO, no env flag, no extra broker call. The recorders are
 * pure array pushes on the hot path (timing wraps calls that already happen),
 * so there is ZERO order-behavior change and nothing to gate. Counters simply
 * read empty until live orders flow. The aggregation functions are PURE (they
 * take the raw samples, no clock / IO) so percentiles, the partial-fill
 * fraction, and the count fold are unit-testable deterministically.
 *
 * TRA-1707 discipline: an UNMEASURED datum is never recorded as a false zero.
 * A terminal order whose broker payload omits `exec_quantity` is simply not
 * counted (the caller guards on a finite value) rather than stamped as a 0%
 * fill that would drag the mean down.
 */

import { snapshotOrderGuardMetrics } from './order-quote-guard.js';

/** Which order path produced the sample. Cancel/replace latency is options-only today (the equity bracket submit does not walk), but the label keeps the rollup class-aware for when the equity path gains a walk. */
export type ExecQualityEngine = 'options' | 'equity';

/** Round-trip whose latency we captured. `cancel` = cancel->ack; `replace` = the reprice re-submit->ack. */
export type CancelReplaceKind = 'cancel' | 'replace';

/** One captured cancel-or-replace round-trip. */
export interface CancelReplaceLatencySample {
  engine: ExecQualityEngine;
  /** open leg (buy_to_open walk) or close leg (sell_to_close walk). */
  side: 'open' | 'close';
  kind: CancelReplaceKind;
  /** Wall-clock ms for the round-trip. Non-finite / negative samples are dropped by the recorder. */
  latencyMs: number;
}

/** One terminal order's fill outcome, for the partial-fill fold. */
export interface OrderFillOutcomeSample {
  engine: ExecQualityEngine;
  side: 'open' | 'close';
  /** Contracts/shares the order was submitted for (> 0). */
  orderedQty: number;
  /** Contracts/shares actually filled (0 ≤ execQty ≤ orderedQty). */
  execQty: number;
}

// ── Since-boot registries ────────────────────────────────────────────────────
const latencySamples: CancelReplaceLatencySample[] = [];
const fillOutcomes: OrderFillOutcomeSample[] = [];

/**
 * Record one cancel-or-replace round-trip latency. No-op when `latencyMs` is
 * not a finite, non-negative number (a bad clock reading can never poison the
 * percentile rollup). Only successful (acked) round-trips should be recorded —
 * a throw is not an ack.
 */
export function recordCancelReplaceLatency(sample: CancelReplaceLatencySample): void {
  if (typeof sample.latencyMs !== 'number' || !Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) {
    return;
  }
  latencySamples.push(sample);
}

/**
 * Record one terminal order's fill outcome. No-op unless `orderedQty` is a
 * finite positive number and `execQty` is a finite non-negative number — an
 * order whose broker payload omits the executed quantity is UNMEASURED, not a
 * measured zero (TRA-1707), so the caller passes a finite `execQty` only when
 * the broker actually reported one. `execQty` is clamped to `orderedQty` so a
 * broker over-report can't push a filled fraction above 1.
 */
export function recordOrderFillOutcome(sample: OrderFillOutcomeSample): void {
  if (typeof sample.orderedQty !== 'number' || !Number.isFinite(sample.orderedQty) || sample.orderedQty <= 0) {
    return;
  }
  if (typeof sample.execQty !== 'number' || !Number.isFinite(sample.execQty) || sample.execQty < 0) {
    return;
  }
  fillOutcomes.push({
    engine: sample.engine,
    side: sample.side,
    orderedQty: sample.orderedQty,
    execQty: Math.min(sample.execQty, sample.orderedQty),
  });
}

// ── Pure aggregations ────────────────────────────────────────────────────────

/**
 * Linear-interpolated percentile over an ASCENDING-sorted array (numpy default
 * / "linear" method). `p` is 0..100. Returns null on an empty array. Exported
 * for unit tests.
 */
export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * frac;
}

export interface LatencyStat {
  n: number;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
}

/** Fold a bag of latency ms into count + p50/p95/min/max/mean. Pure. */
export function summarizeLatency(samplesMs: readonly number[]): LatencyStat {
  const finite = samplesMs.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (finite.length === 0) {
    return { n: 0, p50: null, p95: null, min: null, max: null, mean: null };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    min: round(sorted[0]!),
    max: round(sorted[sorted.length - 1]!),
    mean: round(mean),
  };
}

export interface PartialFillStat {
  /** Total orders recorded (filled, partial, and unfilled). */
  orders: number;
  /** Orders with `execQty === 0`. */
  unfilled: number;
  /** Orders with `0 < filledFraction < 1`. */
  partiallyFilled: number;
  /** Orders with `filledFraction >= 1`. */
  fullyFilled: number;
  /**
   * `partiallyFilled ÷ (partiallyFilled + fullyFilled)` — the partial-fill rate
   * AMONG orders that got any fill (the meaningful denominator; the walk's
   * never-filled attempts don't belong in it). null when no order filled.
   */
  partialFillRate: number | null;
  /**
   * Mean `execQty ÷ orderedQty` over orders that got any fill (execQty > 0).
   * null when no order filled. Excludes never-filled attempts so the average
   * answers "when an order fills, how much of it fills" rather than being
   * dragged to 0 by the walk's un-filled steps.
   */
  avgFilledFraction: number | null;
}

/** Fold order fill outcomes into the partial-fill rate + average filled fraction. Pure. */
export function summarizePartialFills(samples: readonly OrderFillOutcomeSample[]): PartialFillStat {
  let unfilled = 0;
  let partiallyFilled = 0;
  let fullyFilled = 0;
  const filledFractions: number[] = [];
  for (const s of samples) {
    if (!(s.orderedQty > 0)) continue;
    const frac = s.execQty / s.orderedQty;
    if (s.execQty <= 0) {
      unfilled += 1;
      continue;
    }
    filledFractions.push(frac);
    if (frac >= 1) fullyFilled += 1;
    else partiallyFilled += 1;
  }
  const filledOrders = partiallyFilled + fullyFilled;
  return {
    orders: unfilled + filledOrders,
    unfilled,
    partiallyFilled,
    fullyFilled,
    partialFillRate: filledOrders > 0 ? round(partiallyFilled / filledOrders) : null,
    avgFilledFraction:
      filledFractions.length > 0
        ? round(filledFractions.reduce((s, v) => s + v, 0) / filledFractions.length)
        : null,
  };
}

/** Counted stale-quote rejections, read straight from the TRA-2045 order-guard registry. */
export interface StaleQuoteCounts {
  /** Quotes rejected for being older than the at-submit freshness ceiling. */
  staleQuote: number;
  /** Quotes rejected for carrying no usable broker timestamp (can't prove freshness). */
  missingTimestamp: number;
  /** `staleQuote + missingTimestamp` — every order the freshness gate flagged. */
  total: number;
}

/**
 * Sum the stale-quote counted reasons out of the order-guard snapshot. The guard
 * keys counters `engine:mode:outcome`; we sum across engines/modes for the two
 * freshness-failure outcomes. Reads the SAME registry the guard writes, so the
 * count here can never drift from `/api/health/order-quote-guard`.
 */
export function readStaleQuoteCounts(): StaleQuoteCounts {
  const { counts } = snapshotOrderGuardMetrics();
  let staleQuote = 0;
  let missingTimestamp = 0;
  for (const [key, value] of Object.entries(counts)) {
    if (key.endsWith(':stale_quote')) staleQuote += value;
    else if (key.endsWith(':missing_quote_timestamp')) missingTimestamp += value;
  }
  return { staleQuote, missingTimestamp, total: staleQuote + missingTimestamp };
}

export interface CancelReplaceLatencyRollup {
  cancel: LatencyStat;
  replace: LatencyStat;
}

export interface ExecutionQualitySnapshot {
  /** Cancel/replace round-trip latency, aggregated across both legs. */
  cancelReplaceLatencyMs: CancelReplaceLatencyRollup;
  /** Partial-fill rate + average filled fraction across recorded terminal orders. */
  partialFills: PartialFillStat;
  /** Stale-quote rejection counts, consumed from the TRA-2045 order-guard registry. */
  staleQuotes: StaleQuoteCounts;
}

/**
 * Fold the since-boot registries into the read-only execution-quality summary.
 * Pure w.r.t. the module state (no IO, no clock). Latency is aggregated by kind
 * across both open/close legs (the board reads "how long does a cancel/replace
 * take", not per-leg — the maker walk shape is the same either side).
 */
export function snapshotExecutionQuality(): ExecutionQualitySnapshot {
  const cancelMs = latencySamples.filter((s) => s.kind === 'cancel').map((s) => s.latencyMs);
  const replaceMs = latencySamples.filter((s) => s.kind === 'replace').map((s) => s.latencyMs);
  return {
    cancelReplaceLatencyMs: {
      cancel: summarizeLatency(cancelMs),
      replace: summarizeLatency(replaceMs),
    },
    partialFills: summarizePartialFills(fillOutcomes),
    staleQuotes: readStaleQuoteCounts(),
  };
}

/** Test seam — drop every since-boot sample. Does NOT touch the order-guard registry. */
export function resetExecutionQualityTelemetryForTests(): void {
  latencySamples.length = 0;
  fillOutcomes.length = 0;
}

function round(n: number | null, dp = 4): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
