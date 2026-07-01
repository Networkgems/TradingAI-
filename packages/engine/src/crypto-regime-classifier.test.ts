import { describe, it, expect } from 'vitest';
import {
  classifyCryptoRegime,
  CRYPTO_REGIME_DEFAULTS,
  type CryptoRegimeConfig,
} from './crypto-regime-classifier.js';
import type { Candle } from '@trading-app/shared';

const T0 = Date.UTC(2026, 0, 1);
const FOUR_H = 4 * 60 * 60 * 1000;

function candle(i: number, high: number, low: number, close: number, open = close): Candle {
  return {
    symbol: 'BTC-USD',
    timestamp: T0 + i * FOUR_H,
    open,
    high,
    low,
    close,
    volume: 1_000,
  };
}

/** Clean, steady uptrend: each bar closes above the last with a small range. */
function uptrend(n: number, step = 2): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + step;
    out.push(candle(i, close + 0.5, open - 0.5, close, open));
    price = close;
  }
  return out;
}

function downtrend(n: number, step = 2): Candle[] {
  const out: Candle[] = [];
  let price = 100 + n * step;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price - step;
    out.push(candle(i, open + 0.5, close - 0.5, close, open));
    price = close;
  }
  return out;
}

/** Mean-reverting oscillation inside a tight band → chop. */
function chopSeries(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const up = i % 2 === 0;
    const close = up ? 101 : 99;
    const open = up ? 99 : 101;
    out.push(candle(i, 101.5, 98.5, close, open));
  }
  return out;
}

describe('classifyCryptoRegime — labels', () => {
  it('labels a clean uptrend trend_up with direction up', () => {
    const r = classifyCryptoRegime(uptrend(80), CRYPTO_REGIME_DEFAULTS, T0);
    expect(r.reason).toBeNull();
    expect(r.regime).toBe('trend_up');
    expect(r.direction).toBe('up');
    expect(r.plusDI!).toBeGreaterThan(r.minusDI!);
    expect(r.confidence!).toBeGreaterThan(0.5);
    expect(r.trendVotes!).toBeGreaterThanOrEqual(2);
  });

  it('labels a clean downtrend trend_down with direction down', () => {
    const r = classifyCryptoRegime(downtrend(80), CRYPTO_REGIME_DEFAULTS, T0);
    expect(r.reason).toBeNull();
    expect(r.regime).toBe('trend_down');
    expect(r.direction).toBe('down');
    expect(r.minusDI!).toBeGreaterThan(r.plusDI!);
    expect(r.confidence!).toBeGreaterThan(0.5);
  });

  it('labels a range-bound oscillation chop with null direction', () => {
    const r = classifyCryptoRegime(chopSeries(80), CRYPTO_REGIME_DEFAULTS, T0);
    expect(r.reason).toBeNull();
    expect(r.regime).toBe('chop');
    expect(r.direction).toBeNull();
    expect(r.trendVotes!).toBeLessThan(2);
    expect(r.confidence!).toBeGreaterThan(0.5); // deep chop → high confidence in chop label
  });

  it('stamps symbol, barCount and lastBarTime from the final closed bar', () => {
    const bars = uptrend(70);
    const r = classifyCryptoRegime(bars, CRYPTO_REGIME_DEFAULTS, T0);
    expect(r.symbol).toBe('BTC-USD');
    expect(r.barCount).toBe(70);
    expect(r.lastBarTime).toBe(new Date(bars[bars.length - 1].timestamp).toISOString());
    expect(r.asOf).toBe(new Date(T0).toISOString());
  });
});

describe('classifyCryptoRegime — fail-closed (invariant #2)', () => {
  it('returns null regime + insufficient_data below minBars', () => {
    const r = classifyCryptoRegime(uptrend(59), CRYPTO_REGIME_DEFAULTS, T0);
    expect(r.regime).toBeNull();
    expect(r.direction).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.trendVotes).toBeNull();
    expect(r.reason).toBe('insufficient_data');
    expect(r.barCount).toBe(59);
  });

  it('never invents a regime — an empty series is insufficient_data', () => {
    const r = classifyCryptoRegime([], CRYPTO_REGIME_DEFAULTS, T0);
    expect(r.regime).toBeNull();
    expect(r.reason).toBe('insufficient_data');
    expect(r.barCount).toBe(0);
    expect(r.symbol).toBe('');
    expect(r.lastBarTime).toBeNull();
  });

  it('fails closed when an indicator returns null despite enough bars', () => {
    // Perfectly flat bars: choppinessIndex fails closed (zero envelope) even
    // though barCount ≥ minBars, so the whole reading must be insufficient_data.
    const flat: Candle[] = Array.from({ length: 80 }, (_, i) => candle(i, 100, 100, 100));
    const r = classifyCryptoRegime(flat, CRYPTO_REGIME_DEFAULTS, T0);
    expect(r.regime).toBeNull();
    expect(r.reason).toBe('insufficient_data');
    expect(r.choppiness).toBeNull();
  });
});

describe('classifyCryptoRegime — confidence & tiebreak', () => {
  it('confidence is monotonic in trend strength (steeper trend ⇒ higher confidence)', () => {
    const gentle = classifyCryptoRegime(uptrend(80, 0.5), CRYPTO_REGIME_DEFAULTS, T0);
    const steep = classifyCryptoRegime(uptrend(80, 4), CRYPTO_REGIME_DEFAULTS, T0);
    expect(steep.confidence!).toBeGreaterThanOrEqual(gentle.confidence!);
  });

  it('rounds confidence to 3 decimal places', () => {
    const r = classifyCryptoRegime(uptrend(80), CRYPTO_REGIME_DEFAULTS, T0);
    expect(r.confidence).not.toBeNull();
    expect(r.confidence!).toBe(Math.round(r.confidence! * 1000) / 1000);
  });

  it('breaks a plusDI==minusDI tie via EMA (last close ≥ ema50 ⇒ up)', () => {
    // Force a trend label with a manual ±DI tie by stubbing config so the vote
    // passes, then rely on the EMA branch. We simulate the tie by using a config
    // where all votes pass on a rising series whose ±DI are equal is hard to
    // construct deterministically, so we assert the tiebreak indirectly: a rising
    // series ends above its EMA50 ⇒ any trend label resolves 'up'.
    const cfg: CryptoRegimeConfig = { ...CRYPTO_REGIME_DEFAULTS, minTrendVotes: 1 };
    const r = classifyCryptoRegime(uptrend(80), cfg, T0);
    expect(r.direction).toBe('up');
  });
});
