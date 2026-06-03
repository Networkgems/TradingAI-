import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  composeTechnicalSnapshot,
  composeTimeframeSignal,
  resampleCandles,
  mtfBiasOf,
} from './mtf.js';

const MIN = 60_000;
const DAY = 86_400_000;
const N = 260; // enough bars for SMA200 + its 20-bar slope (needs 220)

/**
 * Build an OHLCV series from an explicit close array. high/low sit `spread`
 * either side of the close, open = prior close, volume constant. Timestamps are
 * `step` ms apart starting at 0 — deterministic, so the fixtures are golden.
 */
function build(closes: number[], step: number, spread = 0.5): Candle[] {
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

/** Deterministic PRNG (mulberry32) so the chop fixture is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convex (accelerating) trends — a *linear* ramp drives MACD to ~0, so curvature
// keeps the histogram genuinely signed.
const upCloses = Array.from({ length: N }, (_, i) => 100 + i * 0.4 + i * i * 0.002);
const downCloses = Array.from({ length: N }, (_, i) => 400 - (i * 0.4 + i * i * 0.002));
// IID noise around 100 (seed 16): no directional persistence ⇒ ADX≈7, RSI≈50.
const chopCloses = (() => {
  const rnd = mulberry32(16);
  return Array.from({ length: N }, () => 100 + (rnd() - 0.5) * 1.0);
})();

describe('composeTimeframeSignal', () => {
  it('returns null on empty candles', () => {
    expect(composeTimeframeSignal([], '1d')).toBeNull();
  });

  it('scores a clean uptrend strongly positive on every sub-score', () => {
    const sig = composeTimeframeSignal(build(upCloses, DAY), '1d')!;
    expect(sig.trend).toBe(1);
    expect(sig.momentum).toBe(1);
    expect(sig.location).toBeGreaterThan(0);
    expect(sig.tfScore).toBeCloseTo(0.9661605760570167, 6); // golden
    expect(sig.indicators.rsi).toBeGreaterThan(55);
    expect(sig.indicators.adx).toBeGreaterThan(15);
    expect(sig.indicators.macdHist).toBeGreaterThan(0);
    // VWAP is a daily no-op.
    expect(sig.indicators.vwapDist).toBeUndefined();
  });

  it('scores a clean downtrend strongly negative', () => {
    const sig = composeTimeframeSignal(build(downCloses, DAY), '1d')!;
    expect(sig.trend).toBe(-1);
    expect(sig.momentum).toBe(-1);
    expect(sig.tfScore).toBeCloseTo(-0.9661605760570167, 6); // golden mirror
  });

  it('folds a VWAP-side vote into intraday location', () => {
    const sig = composeTimeframeSignal(build(upCloses, 60 * MIN), '1h')!;
    expect(sig.indicators.vwapDist).toBeGreaterThan(0);
  });

  it('keeps a low-ADX chop fixture inside the neutral band', () => {
    const sig = composeTimeframeSignal(build(chopCloses, DAY), '1d')!;
    expect(sig.indicators.adx).toBeLessThan(15);
    expect(sig.indicators.rsi).toBeGreaterThan(45);
    expect(sig.indicators.rsi).toBeLessThan(55);
    expect(sig.tfScore).toBeGreaterThan(-0.2);
    expect(sig.tfScore).toBeLessThan(0.2);
  });
});

describe('composeTechnicalSnapshot (golden)', () => {
  it('uptrend across all TFs ⇒ strong_bull, alignment 1.0', () => {
    const snap = composeTechnicalSnapshot('AAPL', '2026-06-03T00:00:00.000Z', {
      '15m': build(upCloses, 15 * MIN),
      '1h': build(upCloses, 60 * MIN),
      '1d': build(upCloses, DAY),
    });
    expect(snap.mtfScore).toBeCloseTo(0.9746204320427625, 6); // golden
    expect(snap.mtfBias).toBe('strong_bull');
    expect(snap.mtfAlignment).toBe(1);
    expect(snap.timeframes['15m']!.tfScore).toBeGreaterThan(0);
    expect(snap.timeframes['1h']!.tfScore).toBeGreaterThan(0);
    expect(snap.timeframes['1d']!.tfScore).toBeGreaterThan(0);
  });

  it('downtrend across all TFs ⇒ strong_bear, alignment 1.0', () => {
    const snap = composeTechnicalSnapshot('AAPL', '2026-06-03T00:00:00.000Z', {
      '15m': build(downCloses, 15 * MIN),
      '1h': build(downCloses, 60 * MIN),
      '1d': build(downCloses, DAY),
    });
    expect(snap.mtfScore).toBeCloseTo(-0.9746204320427625, 6); // golden mirror
    expect(snap.mtfBias).toBe('strong_bear');
    expect(snap.mtfAlignment).toBe(1);
  });

  it('chop across all TFs ⇒ neutral bias', () => {
    const snap = composeTechnicalSnapshot('AAPL', '2026-06-03T00:00:00.000Z', {
      '15m': build(chopCloses, 15 * MIN),
      '1h': build(chopCloses, 60 * MIN),
      '1d': build(chopCloses, DAY),
    });
    expect(snap.mtfBias).toBe('neutral');
  });

  it('renormalizes fusion weights over present TFs and omits missing ones', () => {
    const snap = composeTechnicalSnapshot('AAPL', '2026-06-03T00:00:00.000Z', {
      '1d': build(upCloses, DAY),
    });
    // Only 1d present ⇒ mtfScore == its tfScore, alignment 1.0.
    expect(snap.timeframes['15m']).toBeUndefined();
    expect(snap.timeframes['1h']).toBeUndefined();
    expect(snap.mtfScore).toBeCloseTo(snap.timeframes['1d']!.tfScore, 10);
    expect(snap.mtfAlignment).toBe(1);
  });

  it('no data ⇒ neutral, empty timeframes, alignment 0', () => {
    const snap = composeTechnicalSnapshot('AAPL', '2026-06-03T00:00:00.000Z', {});
    expect(snap.timeframes).toEqual({});
    expect(snap.mtfScore).toBe(0);
    expect(snap.mtfBias).toBe('neutral');
    expect(snap.mtfAlignment).toBe(0);
  });
});

describe('mtfBiasOf thresholds', () => {
  it('buckets at ±0.2 / ±0.5', () => {
    expect(mtfBiasOf(0.6)).toBe('strong_bull');
    expect(mtfBiasOf(0.5)).toBe('strong_bull');
    expect(mtfBiasOf(0.3)).toBe('bull');
    expect(mtfBiasOf(0.2)).toBe('bull');
    expect(mtfBiasOf(0.1)).toBe('neutral');
    expect(mtfBiasOf(0)).toBe('neutral');
    expect(mtfBiasOf(-0.1)).toBe('neutral');
    expect(mtfBiasOf(-0.2)).toBe('bear');
    expect(mtfBiasOf(-0.4)).toBe('bear');
    expect(mtfBiasOf(-0.5)).toBe('strong_bear');
    expect(mtfBiasOf(-0.8)).toBe('strong_bear');
  });
});

describe('resampleCandles', () => {
  it('aggregates 60 one-minute bars into four 15m buckets', () => {
    const minutes = build(
      Array.from({ length: 60 }, (_, i) => 100 + i),
      MIN,
    );
    const fifteens = resampleCandles(minutes, 15 * MIN);
    expect(fifteens).toHaveLength(4);
    // First bucket: bars 0..14.
    expect(fifteens[0].open).toBe(minutes[0].open);
    expect(fifteens[0].close).toBe(minutes[14].close);
    expect(fifteens[0].high).toBe(Math.max(...minutes.slice(0, 15).map(c => c.high)));
    expect(fifteens[0].low).toBe(Math.min(...minutes.slice(0, 15).map(c => c.low)));
    expect(fifteens[0].volume).toBe(15 * 1_000);
    // Last bucket: bars 45..59.
    expect(fifteens[3].close).toBe(minutes[59].close);
  });

  it('returns [] on empty input', () => {
    expect(resampleCandles([], 15 * MIN)).toEqual([]);
  });
});
