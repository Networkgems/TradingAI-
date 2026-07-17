import { describe, it, expect } from 'vitest';
import {
  buildEarningsIndex,
  earningsInDaysAsOf,
  gatedAtEntry,
  splitByGate,
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
