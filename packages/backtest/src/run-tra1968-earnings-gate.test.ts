import { describe, it, expect } from 'vitest';
import {
  buildEarningsIndex,
  earningsInDaysAsOf,
  gatedAtEntry,
  splitByGate,
  toGatedRecords,
  armAtThreshold,
  percentile,
  worstDecileMean,
  stopHitRate,
  summarizeArm,
  SWING_MAX_DAYS,
} from './run-tra1968-earnings-gate.js';
import type { EarningsEvent } from '@trading-app/engine';

const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const ev = (symbol: string, date: string): EarningsEvent => ({ symbol, date, epsEstimate: null, hour: 'amc' });

describe('TRA-1973 earnings-gate OOS harness — point-in-time helpers', () => {
  it('buildEarningsIndex upper-cases, dedups and sorts per symbol', () => {
    const idx = buildEarningsIndex([
      ev('aapl', '2024-02-14'),
      ev('AAPL', '2024-01-15'),
      ev('AAPL', '2024-01-15'), // dup
      ev('MSFT', '2024-01-30'),
      ev('BAD', 'not-a-date'), // wrong shape → dropped
    ]);
    expect(idx.get('AAPL')).toEqual(['2024-01-15', '2024-02-14']);
    expect(idx.get('MSFT')).toEqual(['2024-01-30']);
    expect(idx.get('BAD')).toBeUndefined();
  });

  it('earningsInDaysAsOf reads only the nearest NOT-YET-PAST date (no lookahead)', () => {
    const idx = buildEarningsIndex([ev('AAPL', '2024-01-15'), ev('AAPL', '2024-02-14')]);
    // 5 days before the first event → 5.
    expect(earningsInDaysAsOf(idx, 'AAPL', D(2024, 1, 10))).toBe(5);
    // On the event day → 0 (still counts).
    expect(earningsInDaysAsOf(idx, 'AAPL', D(2024, 1, 15))).toBe(0);
    // The day AFTER the first event the reader must roll to the SECOND event
    // (30 days out), never report the now-past first one as a negative/near hit.
    expect(earningsInDaysAsOf(idx, 'AAPL', D(2024, 1, 16))).toBe(29);
    // After every event → null (uncovered), not a stale past value.
    expect(earningsInDaysAsOf(idx, 'AAPL', D(2024, 3, 1))).toBeNull();
    // Uncovered symbol → null.
    expect(earningsInDaysAsOf(idx, 'TSLA', D(2024, 1, 10))).toBeNull();
  });

  it('gatedAtEntry fires only within the threshold and never on a null read', () => {
    expect(gatedAtEntry(0, SWING_MAX_DAYS)).toBe(true);
    expect(gatedAtEntry(SWING_MAX_DAYS, SWING_MAX_DAYS)).toBe(true);
    expect(gatedAtEntry(SWING_MAX_DAYS + 1, SWING_MAX_DAYS)).toBe(false);
    expect(gatedAtEntry(null, SWING_MAX_DAYS)).toBe(false);
  });

  it('splitByGate removes exactly the entries inside an earnings window, keeping R/pnl aligned', () => {
    const idx = buildEarningsIndex([ev('AAPL', '2024-01-15')]);
    const trades = [
      { openedAt: D(2024, 1, 10), pnl: -100 }, // 5d before earnings → GATED
      { openedAt: D(2023, 12, 1), pnl: 50 }, // 45d before → kept
      { openedAt: D(2024, 1, 14), pnl: -80 }, // 1d before → GATED
    ];
    const rs = [-1.2, 0.5, -1.0];
    const arm = splitByGate('AAPL', trades, rs, idx);
    expect(arm.baseRs).toEqual([-1.2, 0.5, -1.0]);
    expect(arm.gatedRs).toEqual([0.5]);
    expect(arm.gatedPnls).toEqual([50]);
    expect(arm.removedRs).toEqual([-1.2, -1.0]); // both gated-out were losers
  });

  it('an uncovered symbol gates nothing (baseline == gated)', () => {
    const idx = buildEarningsIndex([ev('AAPL', '2024-01-15')]);
    const trades = [{ openedAt: D(2024, 1, 10), pnl: -100 }];
    const arm = splitByGate('MSFT', trades, [-1.2], idx);
    expect(arm.gatedRs).toEqual([-1.2]);
    expect(arm.removedRs).toEqual([]);
  });
});

describe('TRA-1973 earnings-gate OOS harness — threshold sweep + tail stats', () => {
  it('toGatedRecords tags each entry with point-in-time days-to-earnings', () => {
    const idx = buildEarningsIndex([ev('AAPL', '2024-01-15')]);
    const recs = toGatedRecords(
      'AAPL',
      [
        { openedAt: D(2024, 1, 10), pnl: -100 }, // 5d before
        { openedAt: D(2023, 12, 1), pnl: 50 }, // 45d before
      ],
      [-1.2, 0.5],
      idx,
    );
    expect(recs.map((r) => r.eDays)).toEqual([5, 45]);
    expect(recs.map((r) => r.r)).toEqual([-1.2, 0.5]);
  });

  it('armAtThreshold re-splits the same records at any threshold (free sweep)', () => {
    // eDays 5 / 8 / 12 / null → the threshold moves what is suppressed.
    const recs = [
      { eDays: 5, r: -1.2, pnl: -120 },
      { eDays: 8, r: -0.4, pnl: -40 },
      { eDays: 12, r: 0.9, pnl: 90 },
      { eDays: null, r: 0.3, pnl: 30 },
    ];
    // ≤7d → only the 5d entry is removed.
    const t7 = armAtThreshold(recs, 7);
    expect(t7.removedRs).toEqual([-1.2]);
    expect(t7.gatedRs).toEqual([-0.4, 0.9, 0.3]);
    // ≤10d → 5d and 8d removed; 12d and null kept.
    const t10 = armAtThreshold(recs, 10);
    expect(t10.removedRs).toEqual([-1.2, -0.4]);
    expect(t10.gatedRs).toEqual([0.9, 0.3]);
    // ≤14d → 5/8/12 removed; the uncovered (null) entry is NEVER gated.
    const t14 = armAtThreshold(recs, 14);
    expect(t14.removedRs).toEqual([-1.2, -0.4, 0.9]);
    expect(t14.gatedRs).toEqual([0.3]);
  });

  it('percentile interpolates linearly on the ascending series', () => {
    expect(percentile([], 0.1)).toBe(0);
    expect(percentile([2], 0.1)).toBe(2);
    // p10 of 0..10 (11 points) → idx 0.1*10 = 1.0 → the value 1.
    expect(percentile([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1)).toBeCloseTo(1, 10);
    // p50 → the median 5.
    expect(percentile([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBeCloseTo(5, 10);
  });

  it('worstDecileMean averages the bottom 10% (at least one sample)', () => {
    expect(worstDecileMean([])).toBe(0);
    // 20 values 1..20 → bottom decile is {1,2} → mean 1.5.
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(worstDecileMean(xs)).toBeCloseTo(1.5, 10);
    // Fewer than 10 → still takes at least one (the min).
    expect(worstDecileMean([3, -2, 5])).toBe(-2);
  });

  it('stopHitRate is the fraction of full-risk (R ≤ −1) losses', () => {
    expect(stopHitRate([])).toBe(0);
    expect(stopHitRate([-1, -1.5, -0.5, 0.8])).toBeCloseTo(0.5, 10);
  });

  it('summarizeArm surfaces the left-tail fields the D2 grade keys on', () => {
    const rs = [-2, -1, -0.5, 0.5, 1, 2];
    const s = summarizeArm(rs, rs.map((r) => r * 100));
    expect(s.worstR).toBe(-2);
    expect(s.tailLosses).toBe(2); // -2 and -1
    expect(s.stopHitRate).toBeCloseTo(2 / 6, 3); // rounded to 4dp in summarizeArm
    expect(s.p10R).toBeLessThan(0); // left tail is negative
    expect(s.worstDecileMeanR).toBe(-2); // bottom decile of 6 → 1 sample → min
  });
});
