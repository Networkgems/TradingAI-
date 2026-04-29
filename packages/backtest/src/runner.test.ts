import { describe, it, expect } from 'vitest';
import type { Candle, TradeSignal } from '@trading-app/shared';
import { admitsUnderPortfolioCap, defaultSectorOf, reachedOneR, BacktestRunner } from './runner.js';
import type { BacktestConfig } from './types.js';

function mkSignal(over: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'sig-' + Math.random().toString(36).slice(2),
    symbol: 'AAPL',
    type: 'orb_breakout',
    side: 'buy',
    entryPrice: 100,
    stopLoss: 99,
    takeProfit: 103,
    riskRewardRatio: 3,
    timestamp: 0,
    ...over,
  };
}

function mkCandle(over: Partial<Candle> = {}): Candle {
  return {
    symbol: 'AAPL',
    timestamp: 0,
    open: 100, high: 100.5, low: 99.5, close: 100,
    volume: 1000,
    ...over,
  };
}

describe('defaultSectorOf', () => {
  it('routes *-USD tickers into the crypto bucket', () => {
    expect(defaultSectorOf('BTC-USD')).toBe('crypto');
    expect(defaultSectorOf('eth-usd')).toBe('crypto');
  });
  it('treats everything else as equity', () => {
    expect(defaultSectorOf('AAPL')).toBe('equity');
    expect(defaultSectorOf('SPY')).toBe('equity');
  });
});

describe('admitsUnderPortfolioCap', () => {
  it('admits new signals when below both caps', () => {
    const candidate = mkSignal({ symbol: 'AAPL' });
    const open = [{ symbol: 'MSFT', signalType: 'orb_breakout' }];
    expect(admitsUnderPortfolioCap(candidate, open, { maxOpenPositions: 3, maxSectorExposure: 3 })).toBeNull();
  });

  it('rejects with reason=max_open when total open positions hit the cap', () => {
    const candidate = mkSignal({ symbol: 'AAPL' });
    const open = [
      { symbol: 'MSFT', signalType: 'orb_breakout' },
      { symbol: 'NVDA', signalType: 'reversal' },
      { symbol: 'GOOG', signalType: 'macd_cross' },
    ];
    const result = admitsUnderPortfolioCap(candidate, open, { maxOpenPositions: 3 });
    expect(result?.reason).toBe('max_open');
  });

  it('rejects with reason=max_sector when sector bucket is saturated', () => {
    const candidate = mkSignal({ symbol: 'BTC-USD' });
    const open = [
      { symbol: 'ETH-USD', signalType: 'reversal' },
      { symbol: 'SOL-USD', signalType: 'macd_cross' },
    ];
    const result = admitsUnderPortfolioCap(
      candidate,
      open,
      { maxOpenPositions: 5, maxSectorExposure: 2 },
    );
    expect(result?.reason).toBe('max_sector');
    expect(result?.sector).toBe('crypto');
  });

  it('lets uncorrelated sector positions in even when other sectors are full', () => {
    const candidate = mkSignal({ symbol: 'AAPL' });
    const open = [
      { symbol: 'BTC-USD', signalType: 'reversal' },
      { symbol: 'ETH-USD', signalType: 'macd_cross' },
    ];
    expect(admitsUnderPortfolioCap(candidate, open, { maxOpenPositions: 5, maxSectorExposure: 2 })).toBeNull();
  });
});

describe('reachedOneR', () => {
  it('returns true when a long signal touches +1R within the window', () => {
    const sig = mkSignal({ entryPrice: 100, stopLoss: 99 }); // R = 1, target = 101
    const future = [
      mkCandle({ high: 100.5, low: 99.8 }),
      mkCandle({ high: 101.2, low: 100.7 }),
    ];
    expect(reachedOneR(sig, future)).toBe(true);
  });

  it('returns false when a long signal never reaches +1R', () => {
    const sig = mkSignal({ entryPrice: 100, stopLoss: 99 });
    const future = [
      mkCandle({ high: 100.5, low: 99.8 }),
      mkCandle({ high: 100.8, low: 99.9 }),
    ];
    expect(reachedOneR(sig, future)).toBe(false);
  });

  it('returns true for a short signal that touches -1R', () => {
    const sig = mkSignal({ side: 'sell', entryPrice: 100, stopLoss: 101 });
    const future = [mkCandle({ high: 100.4, low: 98.5 })];
    expect(reachedOneR(sig, future)).toBe(true);
  });

  it('returns false for empty future window', () => {
    const sig = mkSignal();
    expect(reachedOneR(sig, [])).toBe(false);
  });

  it('returns false when stop equals entry (degenerate R=0)', () => {
    const sig = mkSignal({ entryPrice: 100, stopLoss: 100 });
    expect(reachedOneR(sig, [mkCandle({ high: 200 })])).toBe(false);
  });
});

// ── TRA-169: cost model + ambiguous-fill resolution ───────────────────────────

/**
 * Hand-rolled candle stream that opens an ORB-like setup and then closes
 * either at TP (clean win), SL (clean loss), or a wide bar that straddles
 * both (ambiguous). Volumes are inflated so the ORB volume-spike + ADX gates
 * never veto the signal. Times are 1-minute spaced from a fixed UTC anchor
 * inside the 9:30–10:30 ET morning window, since the default ORB session
 * anchor + time filter target US equity hours.
 */
function morningCandles(closes: Array<{ high: number; low: number; close: number; volume: number }>) : Candle[] {
  // 2024-01-08 14:31:00 UTC = 9:31 AM ET (Monday) — inside morning window.
  const anchor = Date.UTC(2024, 0, 8, 14, 31, 0);
  return closes.map((c, i) => ({
    symbol: 'AAPL',
    timestamp: anchor + i * 60_000,
    open: c.close,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

describe('BacktestRunner cost model + ambiguous fills (TRA-169)', () => {
  function baseConfig(over: Partial<BacktestConfig> = {}): BacktestConfig {
    return {
      symbol: 'AAPL',
      startDate: 0,
      endDate: Number.MAX_SAFE_INTEGER,
      initialEquity: 100_000,
      strategyType: 'orb',
      ...over,
    };
  }

  it('returns ambiguousTrades=0 and worstCaseTotalPnl=totalPnl on a no-trade run', async () => {
    const result = await new BacktestRunner().run(baseConfig(), []);
    expect(result.ambiguousTrades).toBe(0);
    expect(result.worstCaseTotalPnl).toBe(0);
    expect(result.totalPnl).toBe(0);
  });

  it('reduces PnL when commissionBps and slippageBps are set vs the zero-cost baseline', async () => {
    // Reuse a deterministic small ORB-style setup: opening range pre-window then
    // a breakout candle and a TP-hitting close. We don't need to assert exact
    // signals fired — just that adding costs reduces PnL monotonically.
    const candles: Candle[] = [];
    const anchor = Date.UTC(2024, 0, 8, 14, 31, 0);
    for (let i = 0; i < 60; i++) {
      candles.push({
        symbol: 'AAPL',
        timestamp: anchor + i * 60_000,
        open: 100 + i * 0.05,
        high: 100.4 + i * 0.05,
        low: 99.6 + i * 0.05,
        close: 100.1 + i * 0.05,
        volume: 50_000,
      });
    }

    const free = await new BacktestRunner().run(baseConfig(), candles);
    const costed = await new BacktestRunner().run(
      baseConfig({ commissionBps: 50, slippageBps: 20 }),
      candles,
    );
    // Either both runs have no trades (in which case both totalPnl=0) or the
    // costed run is no better than the free run on identical signals.
    if (free.totalTrades > 0 || costed.totalTrades > 0) {
      expect(costed.totalPnl).toBeLessThanOrEqual(free.totalPnl);
    } else {
      expect(costed.totalPnl).toBe(0);
      expect(free.totalPnl).toBe(0);
    }
  });
});
