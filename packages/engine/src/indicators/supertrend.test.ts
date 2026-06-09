import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  supertrend,
  supertrendLatest,
  SUPERTREND_DEFAULT_PERIOD,
  SUPERTREND_DEFAULT_FACTOR,
} from './supertrend.js';

/**
 * Build an OHLCV series from an explicit close array. high/low sit `spread`
 * either side of the running close, open = prior close. Timestamps are `step`
 * ms apart from 0 — deterministic, so these fixtures are golden.
 */
function build(closes: number[], spread = 0.5, step = 60_000): Candle[] {
  return closes.map((close, i) => ({
    symbol: 'TEST',
    timestamp: i * step,
    open: i > 0 ? closes[i - 1] : close,
    high: Math.max(close, i > 0 ? closes[i - 1] : close) + spread,
    low: Math.min(close, i > 0 ? closes[i - 1] : close) - spread,
    close,
    volume: 1_000,
  }));
}

const N = 60;
const upCloses = Array.from({ length: N }, (_, i) => 100 + i * 1.0);
const downCloses = Array.from({ length: N }, (_, i) => 200 - i * 1.0);

describe('supertrend', () => {
  it('returns all-null when there are not enough candles for ATR', () => {
    const series = supertrend(build(upCloses.slice(0, SUPERTREND_DEFAULT_PERIOD)));
    expect(series.every(b => b === null)).toBe(true);
  });

  it('leaves the ATR warm-up window null and fills from index `period`', () => {
    const series = supertrend(build(upCloses), { period: 10, factor: 3 });
    expect(series).toHaveLength(N);
    for (let i = 0; i < 10; i++) expect(series[i]).toBeNull();
    expect(series[10]).not.toBeNull();
    expect(series[N - 1]).not.toBeNull();
  });

  it('reads green (price above the line) on a clean uptrend', () => {
    const last = supertrendLatest(build(upCloses))!;
    expect(last.direction).toBe('green');
    // In an uptrend the active line is the lower band and sits below price.
    expect(last.line).toBe(last.lowerBand);
    expect(last.line).toBeLessThan(upCloses[N - 1]);
  });

  it('reads red (price below the line) on a clean downtrend', () => {
    const last = supertrendLatest(build(downCloses))!;
    expect(last.direction).toBe('red');
    expect(last.line).toBe(last.upperBand);
    expect(last.line).toBeGreaterThan(downCloses[N - 1]);
  });

  it('flips green→red when an uptrend reverses into a downtrend', () => {
    // 40 bars up, then 40 bars down. The flip must register as a red read by
    // the end, and at least one green→red transition must appear in the series.
    const closes = [
      ...Array.from({ length: 40 }, (_, i) => 100 + i * 1.0),
      ...Array.from({ length: 40 }, (_, i) => 139 - i * 1.0),
    ];
    const series = supertrend(build(closes));
    const dirs = series.filter((b): b is NonNullable<typeof b> => b !== null).map(b => b.direction);
    // The seed bar reads red until price first closes above the upper band
    // (standard stop-and-reverse warm-up); the uptrend then turns it green.
    expect(dirs).toContain('green');
    expect(dirs[dirs.length - 1]).toBe('red');
    const flips = dirs.slice(1).filter((d, i) => d !== dirs[i]).length;
    expect(flips).toBeGreaterThanOrEqual(1);
  });

  it('is a golden fixture: exact direction + line on the uptrend tail', () => {
    const series = supertrend(build(upCloses), { period: 10, factor: 3 });
    const last = series[N - 1]!;
    expect(last.direction).toBe('green');
    // Golden value pinned from a hand-verified run; guards against silent math
    // drift in the band-ratchet or ATR reuse.
    expect(last.line).toBeCloseTo(152.5, 6);
  });

  it('honours the factor param: a wider factor places the line further from price', () => {
    const tight = supertrendLatest(build(upCloses), { period: 10, factor: 1 })!;
    const wide = supertrendLatest(build(upCloses), { period: 10, factor: 5 })!;
    // Both green (uptrend); the wider factor's lower-band line sits further below price.
    expect(tight.direction).toBe('green');
    expect(wide.direction).toBe('green');
    expect(wide.line).toBeLessThan(tight.line);
  });

  it('exposes sane defaults', () => {
    expect(SUPERTREND_DEFAULT_PERIOD).toBe(10);
    expect(SUPERTREND_DEFAULT_FACTOR).toBe(3);
  });
});
