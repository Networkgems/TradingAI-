import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { CryptoDcaStrategy } from './crypto-dca.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function bar(close: number, ts: number, opts: Partial<Candle> = {}): Candle {
  return {
    symbol: 'BTC-USD',
    timestamp: ts,
    open: opts.open ?? close,
    high: opts.high ?? close * 1.01,
    low: opts.low ?? close * 0.99,
    close,
    volume: opts.volume ?? 1000,
  };
}

/** Build `n` bars with a steady uptrend so price sits above its EMA. */
function uptrendSeries(n: number, start = 100, step = 0.5, spacingMs = DAY): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    out.push(bar(start + i * step, i * spacingMs));
  }
  return out;
}

/** Build `n` bars trending down so price sits below its EMA. */
function downtrendSeries(n: number, start = 300, step = 0.5, spacingMs = DAY): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    out.push(bar(start - i * step, i * spacingMs));
  }
  return out;
}

describe('CryptoDcaStrategy — TRA-693', () => {
  it('returns null with insufficient bars (< trendEmaPeriod + 1)', () => {
    const strat = new CryptoDcaStrategy({ trendEmaPeriod: 50 });
    expect(strat.evaluate('BTC-USD', uptrendSeries(50))).toBeNull();
  });

  it('fires a long-only BUY of type "dca" in an uptrend', () => {
    const strat = new CryptoDcaStrategy({ trendEmaPeriod: 50 });
    const sig = strat.evaluate('BTC-USD', uptrendSeries(120));
    expect(sig).not.toBeNull();
    expect(sig!.type).toBe('dca');
    expect(sig!.side).toBe('buy');
    expect(sig!.entryPrice).toBeGreaterThan(0);
  });

  it('never fires when price is below the trend EMA (downtrend gate)', () => {
    const strat = new CryptoDcaStrategy({ trendEmaPeriod: 50 });
    expect(strat.evaluate('BTC-USD', downtrendSeries(120))).toBeNull();
  });

  it('respects the cadence gate — no second fire inside the cadence window', () => {
    const strat = new CryptoDcaStrategy({ trendEmaPeriod: 50, cadenceMs: 7 * DAY });
    const series = uptrendSeries(120);
    const first = strat.evaluate('BTC-USD', series);
    expect(first).not.toBeNull();
    // Same bar (and any bar inside the 7-day window) must not re-fire.
    expect(strat.evaluate('BTC-USD', series)).toBeNull();
  });

  it('fires again once the cadence window has elapsed', () => {
    const strat = new CryptoDcaStrategy({ trendEmaPeriod: 50, cadenceMs: 2 * DAY });
    const series = uptrendSeries(120);
    expect(strat.evaluate('BTC-USD', series)).not.toBeNull();
    // Append 3 more daily bars (> 2-day cadence) continuing the uptrend.
    const last = series[series.length - 1];
    const extended = [...series];
    for (let i = 1; i <= 3; i++) {
      extended.push(bar(last.close + i * 0.5, last.timestamp + i * DAY));
    }
    expect(strat.evaluate('BTC-USD', extended)).not.toBeNull();
  });

  it('paces each symbol independently', () => {
    const strat = new CryptoDcaStrategy({ trendEmaPeriod: 50 });
    const btc = uptrendSeries(120).map(c => ({ ...c, symbol: 'BTC-USD' }));
    const eth = uptrendSeries(120).map(c => ({ ...c, symbol: 'ETH-USD' }));
    expect(strat.evaluate('BTC-USD', btc)).not.toBeNull();
    // ETH has its own cadence clock — still fires the first time.
    expect(strat.evaluate('ETH-USD', eth)).not.toBeNull();
  });

  it('produces a protective stop below entry and target above it (≥1:2 R:R)', () => {
    const strat = new CryptoDcaStrategy({ trendEmaPeriod: 50, targetRR: 4 });
    const sig = strat.evaluate('BTC-USD', uptrendSeries(120))!;
    expect(sig.stopLoss).toBeLessThan(sig.entryPrice);
    expect(sig.takeProfit).toBeGreaterThan(sig.entryPrice);
    expect(sig.riskRewardRatio).toBeGreaterThanOrEqual(2);
  });

  it('accumulates unconditionally when requireUptrend is false', () => {
    const strat = new CryptoDcaStrategy({ trendEmaPeriod: 50, requireUptrend: false });
    // Even in a downtrend, time-only DCA still fires.
    expect(strat.evaluate('BTC-USD', downtrendSeries(120))).not.toBeNull();
  });
});
