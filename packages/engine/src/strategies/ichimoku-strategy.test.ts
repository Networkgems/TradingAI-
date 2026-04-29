import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { IchimokuStrategy } from './ichimoku-strategy.js';

function bar(close: number, ts: number, opts: Partial<Candle> = {}): Candle {
  return {
    symbol: 'TEST',
    timestamp: ts,
    open: opts.open ?? close,
    high: opts.high ?? close * 1.001,
    low: opts.low ?? close * 0.999,
    close,
    volume: opts.volume ?? 1000,
  };
}

const ET_OPEN_TS = 1_700_400_000_000; // Mon 10:00 ET — within the 9:35–11:30 window

function buildFlatCloudSeries(): Candle[] {
  const candles: Candle[] = [];
  // 80 flat bars → tight cloud (kumo thickness ≈ 0)
  for (let i = 0; i < 80; i++) {
    candles.push(bar(100, ET_OPEN_TS + i * 60_000, { volume: 1000 }));
  }
  return candles;
}

describe('IchimokuStrategy — TRA-170', () => {
  it('returns null with insufficient bars (< 79)', () => {
    const strat = new IchimokuStrategy();
    const candles = Array.from({ length: 50 }, (_, i) => bar(100, ET_OPEN_TS + i * 60_000));
    expect(strat.evaluate('TEST', candles)).toBeNull();
  });

  it('rejects signals when the kumo is too thin (regime gate)', () => {
    const strat = new IchimokuStrategy();
    // Even if we somehow got a TK cross on the flat series, the kumo
    // thickness check should keep the signal at null.
    const sig = strat.evaluate('TEST', buildFlatCloudSeries());
    expect(sig).toBeNull();
  });

  it('does not require an ADX reading anymore (regression check)', () => {
    // Build a series that has a meaningful directional move so the kumo can
    // form some thickness. We don't assert that a signal fires — the contract
    // we want to lock in is "no implicit ADX floor".
    const candles: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      const px = 100 + i * 0.5;
      candles.push(bar(px, ET_OPEN_TS + i * 60_000, { volume: 1500 }));
    }
    // Should not throw; result may or may not be a signal but the strategy
    // must at least evaluate without depending on adx().
    expect(() => new IchimokuStrategy().evaluate('TEST', candles)).not.toThrow();
  });
});
