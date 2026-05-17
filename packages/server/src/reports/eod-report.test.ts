import { describe, it, expect } from 'vitest';
import { generateEodReport } from './eod-report.js';
import type { EngineState } from '../signal-engine.js';
import type { Position } from '@trading-app/shared';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePosition(overrides: Partial<Position> & { id: string }): Position {
  return {
    symbol: 'AAPL',
    side: 'buy',
    signalType: 'orb_breakout',
    entryPrice: 100,
    quantity: 10,
    stopLoss: 98,
    takeProfit: 104,
    openedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function makeEngineState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    symbols: [
      { symbol: 'AAPL', price: 104, volume: 1_000_000, change: 4, changePct: 4.0, lastUpdated: Date.now() },
      { symbol: 'MSFT', price: 200, volume: 500_000, change: -10, changePct: -4.76, lastUpdated: Date.now() },
      { symbol: 'NVDA', price: 800, volume: 2_000_000, change: 50, changePct: 6.67, lastUpdated: Date.now() },
      { symbol: 'GOOGL', price: 150, volume: 700_000, change: -5, changePct: -3.23, lastUpdated: Date.now() },
      { symbol: 'TSLA', price: 180, volume: 1_500_000, change: 12, changePct: 7.14, lastUpdated: Date.now() },
      { symbol: 'AMD', price: 90, volume: 1_000_000, change: -2, changePct: -2.17, lastUpdated: Date.now() },
    ],
    signals: [],
    account: {
      totalEquity: 25_000,
      availableCash: 24_000,
      openPositions: [],
      dailyPnl: 0,
    },
    closedPositions: [],
    options: {
      openOptions: [],
      closedOptions: [],
      optionsPnl: 0,
      optionsCash: 25_000,
      dailyOptionsCount: 0,
    },
    lastTick: Date.now(),
    tradingHalted: false,
    haltReason: null,
    autoTradingEnabled: true,
    marketOpen: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateEodReport', () => {
  it('produces a report with zero trades when no positions closed today', () => {
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
    });

    expect(report.trades).toHaveLength(0);
    expect(report.totalTrades).toBe(0);
    expect(report.realizedPnl).toBe(0);
    expect(report.winRate).toBe(0);
    // TRA-208: backtest-parity metrics — all zero when no trades closed.
    expect(report.expectancy).toBe(0);
    expect(report.maxDrawdown).toBe(0);
    expect(report.sharpeRatio).toBe(0);
    expect(typeof report.markdown).toBe('string');
    expect(report.markdown).toContain('# Daily EOD Report');
  });

  it('aggregates P&L for two closed positions', () => {
    const now = Date.now();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const todayTs = new Date(`${today}T15:00:00`).getTime();

    const winPos = makePosition({
      id: 'pos-win',
      symbol: 'AAPL',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 98,
      takeProfit: 104,
      quantity: 10,
      pnl: 40,
      openedAt: todayTs - 3600_000,
      closedAt: todayTs,
    });

    const lossPos = makePosition({
      id: 'pos-loss',
      symbol: 'MSFT',
      side: 'buy',
      entryPrice: 200,
      stopLoss: 196,
      takeProfit: 208,
      quantity: 5,
      pnl: -20,
      openedAt: todayTs - 2400_000,
      closedAt: todayTs + 60_000,
    });

    const signalTypeMap = new Map([
      ['pos-win', 'orb_breakout' as const],
      ['pos-loss', 'reversal' as const],
    ]);

    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [winPos, lossPos],
      dailySignals: [],
      signalTypeMap,
    });

    expect(report.totalTrades).toBe(2);
    expect(report.winners).toBe(1);
    expect(report.losers).toBe(1);
    expect(report.realizedPnl).toBeCloseTo(20, 2);
    expect(report.winRate).toBeCloseTo(0.5, 2);

    const orbTrade = report.trades.find(t => t.strategy === 'ORB');
    const revTrade = report.trades.find(t => t.strategy === 'Reversal');
    expect(orbTrade).toBeDefined();
    expect(revTrade).toBeDefined();
    expect(orbTrade?.pnl).toBe(40);
    expect(revTrade?.pnl).toBe(-20);
  });

  // TRA-388 — `asOfDate` backfill: stamp a report for a past trading day
  // whose 21:00 ET archive tick was missed, selecting that day's closed
  // trades from still-retained engine state.
  it('backfills a past day with asOfDate, selecting only that day\'s closed trades', () => {
    const may14 = Date.parse('2026-05-14T18:00:00Z'); // closes mid-session 5/14 UTC
    const may15 = Date.parse('2026-05-15T18:00:00Z');

    const tradeOn14 = makePosition({
      id: 'pos-14', symbol: 'AAPL', pnl: 75,
      openedAt: may14 - 3600_000, closedAt: may14,
    });
    const tradeOn15 = makePosition({
      id: 'pos-15', symbol: 'MSFT', pnl: -30,
      openedAt: may15 - 3600_000, closedAt: may15,
    });

    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [tradeOn14, tradeOn15],
      dailySignals: [],
      signalTypeMap: new Map(),
    }, '2026-05-14');

    expect(report.date).toBe('2026-05-14');
    expect(report.totalTrades).toBe(1);
    expect(report.trades[0].id).toBe('pos-14');
    expect(report.realizedPnl).toBeCloseTo(75, 2);
    expect(report.markdown).toContain('# Daily EOD Report — 2026-05-14');
  });

  it('without asOfDate, stamps the current ET day', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
    });
    expect(report.date).toBe(today);
  });

  it('computes top 5 movers sorted by absolute % change', () => {
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
    });

    expect(report.top5Movers).toHaveLength(5);
    // TSLA +7.14% should be first
    expect(report.top5Movers[0].symbol).toBe('TSLA');
    // NVDA +6.67%
    expect(report.top5Movers[1].symbol).toBe('NVDA');
  });

  it('computes signal accuracy from daily signal records', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const todayTs = new Date(`${today}T10:00:00`).getTime();

    const dailySignals = [
      { id: 's1', symbol: 'AAPL', type: 'orb_breakout' as const, firedAt: todayTs, outcome: 'win' as const, rr: 2 },
      { id: 's2', symbol: 'MSFT', type: 'reversal' as const, firedAt: todayTs + 1000, outcome: 'loss' as const, rr: 0.5 },
      { id: 's3', symbol: 'NVDA', type: 'orb_breakout' as const, firedAt: todayTs + 2000, outcome: 'win' as const, rr: 1.8 },
    ];

    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals,
      signalTypeMap: new Map(),
    });

    expect(report.signalAccuracy.totalSignals).toBe(3);
    expect(report.signalAccuracy.winningSignals).toBe(2);
    expect(report.signalAccuracy.winRate).toBeCloseTo(2 / 3, 3);
  });

  it('generates valid markdown containing all report sections', () => {
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
    });

    expect(report.markdown).toContain('## P&L Summary');
    expect(report.markdown).toContain('## Performance');
    expect(report.markdown).toContain('## Trade Log');
    expect(report.markdown).toContain('## Top 5 Movers');
    expect(report.markdown).toContain('## Signal Accuracy');
  });

  it('excludes positions closed on previous days', () => {
    const yesterday = new Date(Date.now() - 86_400_000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const yesterdayTs = new Date(`${yesterday}T15:00:00`).getTime();

    const oldPos = makePosition({
      id: 'old-pos',
      pnl: 100,
      openedAt: yesterdayTs - 3600_000,
      closedAt: yesterdayTs,
    });

    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [oldPos],
      dailySignals: [],
      signalTypeMap: new Map(),
    });

    expect(report.trades).toHaveLength(0);
    expect(report.realizedPnl).toBe(0);
  });

  it('omits never-fetched symbols (lastUpdated=0) from top movers (TRA-136)', () => {
    const stateNoQuotes = makeEngineState({
      symbols: [
        { symbol: 'AAPL',  price: 0, volume: 0, change: 0, changePct: 0, lastUpdated: 0 },
        { symbol: 'MSFT',  price: 0, volume: 0, change: 0, changePct: 0, lastUpdated: 0 },
        { symbol: 'NVDA',  price: 0, volume: 0, change: 0, changePct: 0, lastUpdated: 0 },
        { symbol: 'GOOGL', price: 0, volume: 0, change: 0, changePct: 0, lastUpdated: 0 },
        { symbol: 'AMZN',  price: 0, volume: 0, change: 0, changePct: 0, lastUpdated: 0 },
      ],
    });
    const report = generateEodReport({
      state: stateNoQuotes,
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
    });

    expect(report.top5Movers).toHaveLength(0);
    expect(report.markdown).toContain('_No data._');
  });

  it('reports TRA-208 backtest-parity metrics (expectancy, max drawdown, Sharpe)', () => {
    // Three trades: one +1R, one −1R, one +2R. Expectancy = (+1 −1 +2) / 3
    // = 0.667R. Per-trade Sharpe = mean(R) / stdev(R) = 0.667 / 1.528 ≈ 0.436.
    // Max drawdown = the −1R loss against the running peak after trade #1.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const todayTs = new Date(`${today}T15:00:00`).getTime();
    // Hand-pick risk geometry so each trade's R is exactly the integer above.
    // R = pnl / (|entry−stop| × qty). With entry=100, stop=98, qty=10 → risk=20,
    // so pnl=+20 → +1R, pnl=−20 → −1R, pnl=+40 → +2R.
    const trades = [
      makePosition({
        id: 't1', pnl: 20, entryPrice: 100, stopLoss: 98, quantity: 10,
        openedAt: todayTs - 3600_000, closedAt: todayTs,
      }),
      makePosition({
        id: 't2', pnl: -20, entryPrice: 100, stopLoss: 98, quantity: 10,
        openedAt: todayTs - 2400_000, closedAt: todayTs + 60_000,
      }),
      makePosition({
        id: 't3', pnl: 40, entryPrice: 100, stopLoss: 98, quantity: 10,
        openedAt: todayTs - 1200_000, closedAt: todayTs + 120_000,
      }),
    ];
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: trades,
      dailySignals: [],
      signalTypeMap: new Map(),
    });

    expect(report.expectancy).toBeCloseTo(2 / 3, 3);
    // Sample stdev of [1,−1,2] = sqrt(((1−2/3)² + (−1−2/3)² + (2−2/3)²)/2)
    // = sqrt((1/9 + 25/9 + 16/9) / 2) = sqrt(42/18) = sqrt(7/3) ≈ 1.528.
    // Sharpe = (2/3) / 1.528 ≈ 0.4364.
    expect(report.sharpeRatio).toBeCloseTo(0.4364, 3);
    // Equity curve (anchored at session-open equity = 25,000 − 40 = 24,960):
    //   start = 24,960
    //   after t1 (+20)  = 24,980 (peak)
    //   after t2 (−20)  = 24,960 (drawdown 20 / 24,980 ≈ 0.0008)
    //   after t3 (+40)  = 25,000 (new peak)
    // Max DD ≈ 20 / 24,980 ≈ 8e-4.
    expect(report.maxDrawdown).toBeCloseTo(20 / 24_980, 5);
    expect(report.markdown).toContain('Expectancy');
    expect(report.markdown).toContain('Max Drawdown');
    expect(report.markdown).toContain('Sharpe');
  });

  it('calculates unrealized P&L from open positions vs current prices', () => {
    const openPos = makePosition({
      id: 'open-pos',
      symbol: 'AAPL',
      side: 'buy',
      entryPrice: 100,
      quantity: 10,
    });

    const state = makeEngineState({
      account: {
        totalEquity: 25_000,
        availableCash: 23_000,
        openPositions: [openPos],
        dailyPnl: 0,
      },
    });

    // AAPL current price is 104, entry was 100 → +$4 × 10 = +$40 unrealized
    const report = generateEodReport({
      state,
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
    });

    expect(report.unrealizedPnl).toBeCloseTo(40, 1);
    expect(report.openPositionCount).toBe(1);
  });
});
