import { afterEach, describe, expect, it } from 'vitest';
import {
  percentile,
  summarizeLatency,
  summarizePartialFills,
  recordCancelReplaceLatency,
  recordOrderFillOutcome,
  snapshotExecutionQuality,
  readStaleQuoteCounts,
  resetExecutionQualityTelemetryForTests,
  type OrderFillOutcomeSample,
} from './execution-quality-telemetry.js';
import {
  recordOrderGuardOutcome,
  resetOrderGuardMetricsForTests,
} from './order-quote-guard.js';

afterEach(() => {
  resetExecutionQualityTelemetryForTests();
  resetOrderGuardMetricsForTests();
});

describe('percentile', () => {
  it('returns null on an empty array', () => {
    expect(percentile([], 50)).toBeNull();
  });

  it('returns the sole value for a single-element array', () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it('computes p50 / p95 by linear interpolation on a sorted array', () => {
    const xs = [10, 20, 30, 40, 50];
    // p50 → rank 2.0 → exact 30.
    expect(percentile(xs, 50)).toBe(30);
    // p95 → rank 0.95×4 = 3.8 → 40 + 0.8×(50-40) = 48.
    expect(percentile(xs, 95)).toBeCloseTo(48, 10);
    // p0 / p100 → the ends.
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile(xs, 100)).toBe(50);
  });

  it('clamps out-of-range p into [0,100]', () => {
    const xs = [1, 2, 3];
    expect(percentile(xs, -20)).toBe(1);
    expect(percentile(xs, 250)).toBe(3);
  });
});

describe('summarizeLatency', () => {
  it('reports null stats on no samples', () => {
    expect(summarizeLatency([])).toEqual({ n: 0, p50: null, p95: null, min: null, max: null, mean: null });
  });

  it('drops non-finite samples before aggregating', () => {
    const stat = summarizeLatency([10, Number.NaN, 30, Infinity]);
    expect(stat.n).toBe(2);
    expect(stat.min).toBe(10);
    expect(stat.max).toBe(30);
    expect(stat.mean).toBe(20);
  });

  it('computes percentiles independent of input order', () => {
    const unsorted = [50, 10, 40, 20, 30];
    const stat = summarizeLatency(unsorted);
    expect(stat.n).toBe(5);
    expect(stat.p50).toBe(30);
    expect(stat.p95).toBeCloseTo(48, 10);
    expect(stat.min).toBe(10);
    expect(stat.max).toBe(50);
    expect(stat.mean).toBe(30);
  });
});

describe('summarizePartialFills', () => {
  const sample = (execQty: number, orderedQty = 10): OrderFillOutcomeSample => ({
    engine: 'options',
    side: 'open',
    orderedQty,
    execQty,
  });

  it('reports empty stats with null rates when no orders', () => {
    expect(summarizePartialFills([])).toEqual({
      orders: 0,
      unfilled: 0,
      partiallyFilled: 0,
      fullyFilled: 0,
      partialFillRate: null,
      avgFilledFraction: null,
    });
  });

  it('classifies unfilled / partial / full and rates partial among filled only', () => {
    // 1 unfilled (0/10), 2 partial (3/10, 7/10), 1 full (10/10).
    const stat = summarizePartialFills([sample(0), sample(3), sample(7), sample(10)]);
    expect(stat.orders).toBe(4);
    expect(stat.unfilled).toBe(1);
    expect(stat.partiallyFilled).toBe(2);
    expect(stat.fullyFilled).toBe(1);
    // partial-fill rate among the 3 orders that got any fill (2 partial / 3).
    expect(stat.partialFillRate).toBeCloseTo(2 / 3, 4);
    // avg filled fraction over the 3 filled orders: (0.3 + 0.7 + 1.0) / 3.
    expect(stat.avgFilledFraction).toBeCloseTo((0.3 + 0.7 + 1.0) / 3, 4);
  });

  it('excludes never-filled attempts from the avg filled fraction denominator', () => {
    // 3 unfilled walk attempts + 1 fill: avg is over the 1 filled order (1.0),
    // NOT dragged toward 0 by the 3 unfilled attempts.
    const stat = summarizePartialFills([sample(0), sample(0), sample(0), sample(10)]);
    expect(stat.avgFilledFraction).toBe(1);
    expect(stat.partialFillRate).toBe(0); // 0 partial among 1 filled
    expect(stat.unfilled).toBe(3);
  });

  it('gives null rates when every order was unfilled', () => {
    const stat = summarizePartialFills([sample(0), sample(0)]);
    expect(stat.partialFillRate).toBeNull();
    expect(stat.avgFilledFraction).toBeNull();
    expect(stat.unfilled).toBe(2);
  });
});

describe('recorders drop unmeasured / bad samples (TRA-1707 no false-zero)', () => {
  it('records only finite non-negative latency', () => {
    recordCancelReplaceLatency({ engine: 'options', side: 'open', kind: 'cancel', latencyMs: 12 });
    recordCancelReplaceLatency({ engine: 'options', side: 'open', kind: 'cancel', latencyMs: Number.NaN });
    recordCancelReplaceLatency({ engine: 'options', side: 'open', kind: 'cancel', latencyMs: -5 });
    const snap = snapshotExecutionQuality();
    expect(snap.cancelReplaceLatencyMs.cancel.n).toBe(1);
    expect(snap.cancelReplaceLatencyMs.cancel.p50).toBe(12);
  });

  it('does not record a fill outcome when orderedQty is not positive', () => {
    recordOrderFillOutcome({ engine: 'options', side: 'open', orderedQty: 0, execQty: 0 });
    recordOrderFillOutcome({ engine: 'options', side: 'open', orderedQty: -3, execQty: 0 });
    expect(snapshotExecutionQuality().partialFills.orders).toBe(0);
  });

  it('does not record a fill outcome when execQty is non-finite (unmeasured, not zero)', () => {
    recordOrderFillOutcome({ engine: 'options', side: 'open', orderedQty: 10, execQty: Number.NaN });
    expect(snapshotExecutionQuality().partialFills.orders).toBe(0);
  });

  it('clamps an over-reported execQty to orderedQty (fraction never exceeds 1)', () => {
    recordOrderFillOutcome({ engine: 'options', side: 'open', orderedQty: 5, execQty: 8 });
    const stat = snapshotExecutionQuality().partialFills;
    expect(stat.fullyFilled).toBe(1);
    expect(stat.avgFilledFraction).toBe(1);
  });
});

describe('cancel vs replace latency are aggregated separately', () => {
  it('folds cancel and replace samples into distinct rollups', () => {
    recordCancelReplaceLatency({ engine: 'options', side: 'open', kind: 'cancel', latencyMs: 100 });
    recordCancelReplaceLatency({ engine: 'options', side: 'close', kind: 'cancel', latencyMs: 200 });
    recordCancelReplaceLatency({ engine: 'options', side: 'open', kind: 'replace', latencyMs: 40 });
    const snap = snapshotExecutionQuality();
    expect(snap.cancelReplaceLatencyMs.cancel.n).toBe(2);
    expect(snap.cancelReplaceLatencyMs.cancel.p50).toBe(150);
    expect(snap.cancelReplaceLatencyMs.replace.n).toBe(1);
    expect(snap.cancelReplaceLatencyMs.replace.p50).toBe(40);
  });
});

describe('readStaleQuoteCounts consumes the TRA-2045 order-guard registry', () => {
  it('sums stale_quote and missing_quote_timestamp across engines/modes', () => {
    recordOrderGuardOutcome('options', 'stale_quote', 'shadow');
    recordOrderGuardOutcome('options', 'stale_quote', 'enforce');
    recordOrderGuardOutcome('equity', 'stale_quote', 'shadow');
    recordOrderGuardOutcome('options', 'missing_quote_timestamp', 'shadow');
    recordOrderGuardOutcome('options', 'passed', 'shadow'); // not a stale reason
    const counts = readStaleQuoteCounts();
    expect(counts.staleQuote).toBe(3);
    expect(counts.missingTimestamp).toBe(1);
    expect(counts.total).toBe(4);
  });

  it('is zero when the guard has recorded nothing', () => {
    expect(readStaleQuoteCounts()).toEqual({ staleQuote: 0, missingTimestamp: 0, total: 0 });
  });

  it('is surfaced in the full snapshot', () => {
    recordOrderGuardOutcome('options', 'stale_quote', 'shadow');
    expect(snapshotExecutionQuality().staleQuotes.total).toBe(1);
  });
});
