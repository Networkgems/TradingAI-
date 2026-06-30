import { describe, it, expect } from 'vitest';
import { generateEodReport } from './eod-report.js';
import type { EngineState } from '../signal-engine.js';
import type { OptionPosition, Position } from '@trading-app/shared';

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
    supertrendShadowSignals: [],
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
    tradingAgentsEnabled: false,
    tradingAgentsGatingEnabled: false,
    tradingAgentsLiveGatingEnabled: false,
    agentRecommendations: [],
    marketOpen: false,
    marketReview: {
      enabled: false,
      reviewDate: null,
      regime: null,
      regimeRationale: null,
      gates: null,
      gatedStrategies: [],
    },
    ...overrides,
  };
}

function makeOption(overrides: Partial<OptionPosition> & { id: string }): OptionPosition {
  return {
    symbol: 'AAPL',
    optionType: 'call',
    contracts: 1,
    contractsRemaining: 0,
    premiumPaid: 1,
    currentPremium: 1,
    tp1Premium: 1.25,
    tp1Hit: false,
    stopLossPremium: 0.75,
    peakPremium: 1,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 100,
    openedAt: Date.now() - 60_000,
    signalId: 'sig',
    signalType: 'relative_value',
    mode: 'demo',
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

// ── TRA-594 — Calendar per-day aggregation ───────────────────────────────────
//
// The Calendar tab reads `report.combinedPnl` per day. These pin the three
// bugs that made it "track nothing right" on the demo account:
//   1. `optionsPnl` was the all-time cumulative options total, booked into
//      every day's cell — now it's only the options that closed that day.
//   2. `combinedPnl` folded in open-position MTM, so a position held open
//      across days re-counted into every cell — now it's realized-only.
//   3. evening-ET closes (next-day in UTC) were bucketed to the wrong day —
//      now both the close and the day key use the US/Eastern calendar.
describe('generateEodReport — TRA-594 calendar aggregation', () => {
  it('combinedPnl = day realized stock + day realized options, excluding open MTM', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const todayTs = new Date(`${today}T15:00:00`).getTime();

    const stockWin = makePosition({
      id: 'stk', pnl: 50, openedAt: todayTs - 3600_000, closedAt: todayTs,
    });
    // Open position with +$40 unrealized MTM (AAPL 100→104, qty 10) — must NOT
    // leak into combinedPnl.
    const openPos = makePosition({ id: 'open', symbol: 'AAPL', entryPrice: 100, quantity: 10 });
    const optClosedToday = makeOption({ id: 'opt-today', pnl: 30, closedAt: todayTs });

    const report = generateEodReport({
      state: makeEngineState({
        account: { totalEquity: 25_000, availableCash: 23_000, openPositions: [openPos], dailyPnl: 0 },
      }),
      allClosedPositions: [stockWin],
      closedOptions: [optClosedToday],
      dailySignals: [],
      signalTypeMap: new Map(),
    });

    expect(report.realizedPnl).toBeCloseTo(50, 2);
    expect(report.optionsPnl).toBeCloseTo(30, 2);
    expect(report.unrealizedPnl).toBeCloseTo(40, 2); // still reported for the detail view
    expect(report.combinedPnl).toBeCloseTo(80, 2);   // 50 + 30, NOT +40 MTM
  });

  it('optionsPnl counts only options closed today, never the cumulative total', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const todayTs = new Date(`${today}T15:00:00`).getTime();
    const yesterday = new Date(Date.now() - 86_400_000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const yesterdayTs = new Date(`${yesterday}T15:00:00`).getTime();

    const report = generateEodReport({
      state: makeEngineState({
        // A large cumulative options total in state must be ignored.
        options: { openOptions: [], closedOptions: [], optionsPnl: 99_999, optionsCash: 25_000, dailyOptionsCount: 0 },
      }),
      allClosedPositions: [],
      closedOptions: [
        makeOption({ id: 'opt-today-a', pnl: 12, closedAt: todayTs }),
        makeOption({ id: 'opt-today-b', pnl: -4, closedAt: todayTs }),
        makeOption({ id: 'opt-prior',   pnl: 500, closedAt: yesterdayTs }),
      ],
      dailySignals: [],
      signalTypeMap: new Map(),
    });

    expect(report.optionsPnl).toBeCloseTo(8, 2);   // 12 − 4, not 99,999 and not +500 prior day
    expect(report.combinedPnl).toBeCloseTo(8, 2);
  });

  it('attributes an evening-ET close (next-day UTC) to the ET trading day', () => {
    // 2026-03-16T01:30:00Z = 2026-03-15 21:30 EDT. The UTC date is the 16th but
    // the ET trading day is the 15th — the day the backfill report is stamped.
    const closeTs = Date.parse('2026-03-16T01:30:00Z');
    const eveningTrade = makePosition({
      id: 'evening', pnl: 25, openedAt: closeTs - 3600_000, closedAt: closeTs,
    });

    const onEt15 = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [eveningTrade],
      dailySignals: [],
      signalTypeMap: new Map(),
    }, '2026-03-15');
    expect(onEt15.totalTrades).toBe(1);
    expect(onEt15.realizedPnl).toBeCloseTo(25, 2);

    // The UTC date (the 16th) must NOT claim the trade.
    const onUtc16 = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [eveningTrade],
      dailySignals: [],
      signalTypeMap: new Map(),
    }, '2026-03-16');
    expect(onUtc16.totalTrades).toBe(0);
    expect(onUtc16.realizedPnl).toBe(0);
  });

  // TRA-991 — option-trade journal P&L / learned-weights section.
  it('renders the option-trade journal section when a summary is supplied', () => {
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
      optionJournal: {
        total: 2,
        open: 1,
        closed: 1,
        win: 1,
        loss: 0,
        scratch: 0,
        winRate: 1,
        realizedPnlUsd: 320,
        avgR: 1,
        byStructure: [
          { structure: 'bull_put', closed: 1, realizedPnlUsd: 320, winRate: 1, avgR: 1 },
        ],
        byArchetype: [],
        byExitReason: [],
      },
    });

    expect(report.markdown).toContain('Option-Trade Journal');
    expect(report.markdown).toContain('Journal P&L by Structure');
    expect(report.markdown).toContain('bull_put');
    expect(report.markdown).toContain('+$320.00');
  });

  it('omits the journal section entirely when no summary is supplied', () => {
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
    });
    expect(report.markdown).not.toContain('Option-Trade Journal');
  });

  // TRA-995 — the self-awareness introspection + risk-autopilot sections.
  it('renders per-strategy attribution, an edge-decay flag, and autopilot actions', () => {
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
      introspection: {
        strategies: [
          {
            strategy: 'bull_put',
            trades: 12,
            realizedPnlUsd: 540,
            winRate: 0.66,
            expectancy: 0.42,
            sharpe: 1.1,
            byRegime: [],
          },
        ],
        edgeDecay: [
          {
            strategy: 'single_leg_rv',
            degrading: true,
            baselineExpectancy: 1.2,
            recentExpectancy: -0.3,
            baselineTrades: 8,
            recentTrades: 6,
            reason: 'Edge turned negative: baseline expectancy +1.20R → recent -0.30R',
          },
        ],
        degradingStrategies: ['single_leg_rv'],
      },
      autopilotActions: [
        {
          kind: 'throttle',
          trigger: 'edge_decay',
          reason: 'Strategy "single_leg_rv" flagged edge-decaying — autopilot throttled risk to 50% and queued for review',
          throttleMultiplier: 0.5,
        },
      ],
    });
    expect(report.markdown).toContain('Per-Strategy Attribution');
    expect(report.markdown).toContain('bull_put');
    expect(report.markdown).toContain('Edge-Decay Detector');
    expect(report.markdown).toContain('⚠️ DECAYING');
    expect(report.markdown).toContain('Risk Autopilot Actions');
    expect(report.markdown).toContain('queued for review');
    // Invariant 4 statement must be present in the readout.
    expect(report.markdown).toContain('requires board ratification');
  });

  it('omits the introspection + autopilot sections when neither is supplied', () => {
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
    });
    expect(report.markdown).not.toContain('Per-Strategy Attribution');
    expect(report.markdown).not.toContain('Risk Autopilot Actions');
  });
});
