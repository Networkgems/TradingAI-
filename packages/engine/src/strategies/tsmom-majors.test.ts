import { describe, it, expect } from 'vitest';
import { Candle } from '@trading-app/shared';
import {
  trailingTotalReturn,
  tsmomSizingStopFraction,
  tsmomExitToFlat,
  evaluateTsmomMajors,
  resolveTsmomMajorsParams,
  TsmomMajorsStrategy,
  TSMOM_BARS_PER_YEAR,
} from './tsmom-majors.js';

/** Build a daily candle series from a list of closes (OHLC flat to close). */
function series(closes: number[]): Candle[] {
  const DAY = 24 * 60 * 60 * 1000;
  return closes.map((c, i) => ({
    symbol: 'BTC-USD',
    timestamp: Date.UTC(2024, 0, 1) + i * DAY,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

describe('resolveTsmomMajorsParams', () => {
  it('applies the frozen defaults (L=100, bands 0, vol target 60)', () => {
    expect(resolveTsmomMajorsParams()).toEqual({
      lookbackDays: 100,
      entryBandPct: 0,
      exitBandPct: 0,
      volTargetAnnualPct: 60,
    });
  });
});

describe('trailingTotalReturn', () => {
  it('computes close_t / close_{t-L} - 1', () => {
    // L=2: 121 / 100 - 1 = 0.21
    expect(trailingTotalReturn([100, 110, 121], 2)).toBeCloseTo(0.21, 10);
  });

  it('returns null before L+1 closes exist', () => {
    expect(trailingTotalReturn([100, 110], 2)).toBeNull();
  });

  it('returns null on non-positive prices', () => {
    expect(trailingTotalReturn([0, 110, 121], 2)).toBeNull();
  });
});

describe('tsmomSizingStopFraction', () => {
  it('is one daily vol-target sigma: (vt/100)/sqrt(365)', () => {
    expect(tsmomSizingStopFraction(60)).toBeCloseTo(0.6 / Math.sqrt(TSMOM_BARS_PER_YEAR), 12);
  });
});

describe('evaluateTsmomMajors (entry)', () => {
  it('emits a long when r_L >= +entryBandPct and is flat otherwise', () => {
    const up = series([100, 101, 102, 103, 110]); // r_4 = 110/100-1 = +0.10
    const sig = evaluateTsmomMajors('BTC-USD', up, { lookbackDays: 4, entryBandPct: 0 });
    expect(sig).not.toBeNull();
    expect(sig!.side).toBe('buy');
    expect(sig!.type).toBe('tsmom_majors');
    expect(sig!.entryPrice).toBe(110);
    // sizing-only stop one daily vol-target sigma below entry
    expect(sig!.stopLoss).toBeCloseTo(110 * (1 - tsmomSizingStopFraction(60)), 8);
    expect(sig!.stopLoss).toBeLessThan(sig!.entryPrice);
  });

  it('does not fire when r_L is below the entry band', () => {
    const down = series([100, 99, 98, 97, 95]); // r_4 = -0.05
    expect(evaluateTsmomMajors('BTC-USD', down, { lookbackDays: 4, entryBandPct: 0 })).toBeNull();
  });

  it('respects a positive entry band (dead-zone)', () => {
    const mild = series([100, 101, 102, 103, 104]); // r_4 = +0.04 = 4%
    // 4% clears a 3% band but not a 5% band.
    expect(evaluateTsmomMajors('BTC-USD', mild, { lookbackDays: 4, entryBandPct: 3 })).not.toBeNull();
    expect(evaluateTsmomMajors('BTC-USD', mild, { lookbackDays: 4, entryBandPct: 5 })).toBeNull();
  });
});

describe('tsmomExitToFlat (exit)', () => {
  it('exits when r_L <= -exitBandPct', () => {
    const down = series([100, 99, 98, 97, 94]); // r_4 = -0.06
    expect(tsmomExitToFlat(down, { lookbackDays: 4, exitBandPct: 5 })).toBe(true); // -6% <= -5%
    expect(tsmomExitToFlat(down, { lookbackDays: 4, exitBandPct: 7 })).toBe(false); // -6% > -7%
  });

  it('holds (no exit) while r_L is above -exitBandPct', () => {
    const up = series([100, 101, 102, 103, 110]);
    expect(tsmomExitToFlat(up, { lookbackDays: 4, exitBandPct: 0 })).toBe(false);
  });

  it('does not exit before enough history', () => {
    expect(tsmomExitToFlat(series([100, 99]), { lookbackDays: 4 })).toBe(false);
  });
});

describe('TsmomMajorsStrategy wrapper', () => {
  it('delegates entry and exit to the pure helpers', () => {
    const s = new TsmomMajorsStrategy({ lookbackDays: 4, entryBandPct: 0, exitBandPct: 0 });
    expect(s.evaluate('BTC-USD', series([100, 101, 102, 103, 110]))).not.toBeNull();
    expect(s.shouldExitToFlat(series([100, 99, 98, 97, 94]))).toBe(true);
  });
});
