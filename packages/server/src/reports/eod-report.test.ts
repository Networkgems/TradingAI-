import { describe, it, expect } from 'vitest';
import { generateEodReport } from './eod-report.js';
import type { EngineState } from '../signal-engine.js';
import type { OptionPosition, Position } from '@trading-app/shared';
import type { OptionTradeJournalSummary } from '../option-trade-journal.js';

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
    lastScanAt: Date.now(),
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

  // TRA-1633 BUG 1 (AC-1) — the Trade Log Exit column must show the ACTUAL fill
  // (`pos.exitPrice`), not the take-profit / stop TARGET. The SPCE-style case:
  // a long that booked a LOSS must show an exit BELOW entry, and the row must
  // reconcile with its own P&L / R:R.
  it('shows the stored fill as Exit, not the target, for a booked-loss long', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const todayTs = new Date(`${today}T15:00:00`).getTime();

    // SPCE-shaped: long, entry 3.93, take-profit 10.39, but the real fill exited
    // at 2.66 (below entry) for a −$464.59 loss on 367 shares.
    const spce = makePosition({
      id: 'spce', symbol: 'SPCE', side: 'buy',
      entryPrice: 3.93, takeProfit: 10.39, stopLoss: 2.66,
      exitPrice: 2.6537, quantity: 367, pnl: -464.59,
      openedAt: todayTs - 3600_000, closedAt: todayTs,
    });

    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [spce],
      dailySignals: [],
      signalTypeMap: new Map([['spce', 'relative_value' as const]]),
    });

    const row = report.trades.find(t => t.id === 'spce')!;
    expect(row.exitPrice).toBeCloseTo(2.6537, 4);   // the fill, NOT 10.39 target
    expect(row.exitPrice).toBeLessThan(row.entryPrice); // below entry for a loss long
    expect(row.pnl).toBeCloseTo(-464.59, 2);        // row reconciles with its P&L
  });

  // TRA-1633 BUG 1 — legacy fallback: a closed position with no stored fill
  // still falls back to the target so old rows keep rendering.
  it('falls back to the target Exit when no fill was stored (legacy rows)', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const todayTs = new Date(`${today}T15:00:00`).getTime();
    const legacy = makePosition({
      id: 'legacy', side: 'buy', entryPrice: 100, takeProfit: 104, stopLoss: 98,
      quantity: 10, pnl: 40, openedAt: todayTs - 3600_000, closedAt: todayTs,
      // no exitPrice
    });
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [legacy],
      dailySignals: [],
      signalTypeMap: new Map(),
    });
    expect(report.trades.find(t => t.id === 'legacy')!.exitPrice).toBe(104);
  });

  // TRA-1633 FIX 3 — leg-coverage note in the EOD markdown header.
  it('emits the leg-coverage note in the report header', () => {
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
    });
    expect(report.markdown).toContain('Leg coverage (TRA-1633)');
    expect(report.markdown).toContain('PnL tracker `dailyPnl` = stock-only');
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

  /** One closed bull_put winner — the minimum that renders the journal section. */
  const journalSummaryFixture = (): OptionTradeJournalSummary => ({
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
    byDelta: [],
    byDte: [],
    slippage: {
      entrySampled: 0,
      exitSampled: 0,
      roundTripSampled: 0,
      avgEntrySlippageUsd: null,
      avgExitSlippageUsd: null,
      avgEntrySlippageR: null,
      avgExitSlippageR: null,
      avgRoundTripCostR: null,
      totalSlippageUsd: 0,
    },
  });

  // TRA-991 — option-trade journal P&L / learned-weights section.
  it('renders the option-trade journal section when a summary is supplied', () => {
    const report = generateEodReport({
      state: makeEngineState(),
      allClosedPositions: [],
      dailySignals: [],
      signalTypeMap: new Map(),
      optionJournal: journalSummaryFixture(),
    });

    expect(report.markdown).toContain('Option-Trade Journal');
    expect(report.markdown).toContain('Journal P&L by Structure');
    expect(report.markdown).toContain('bull_put');
    expect(report.markdown).toContain('+$320.00');
  });

  // TRA-2214 — the basis the journal blocks were folded on, published beside them.
  //
  // These numbers MOVE with the basis change (`single_leg_otm` baseline expectancy
  // +0.0427R pooled → +0.0167R desk+unattributed; the QA fixtures are large
  // winners). A grader watching the EOD series would otherwise see an unexplained
  // step change with nothing in the payload to attribute it to.
  describe('TRA-2214 journal basis on the EOD report', () => {
    const withBasis = (over: Partial<Parameters<typeof generateEodReport>[0]> = {}) =>
      generateEodReport({
        state: makeEngineState(),
        allClosedPositions: [],
        dailySignals: [],
        signalTypeMap: new Map(),
        optionJournal: journalSummaryFixture(),
        ...over,
      });

    it('carries journalBasis + journalBasisCounts on the wire and in the markdown', () => {
      const report = withBasis({
        journalBasis: 'desk+unattributed',
        journalBasisCounts: { desk: 91, unattributed: 2164, fixtureExcluded: 67 },
      });

      expect(report.journalBasis).toBe('desk+unattributed');
      expect(report.journalBasisCounts).toEqual({
        desk: 91,
        unattributed: 2164,
        fixtureExcluded: 67,
      });
      // `fixtureExcluded` is the self-evidencing field: 67 rows visibly dropped
      // beats inferring the drop from a moved mean.
      expect(report.markdown).toContain('desk+unattributed');
      expect(report.markdown).toContain('**67 QA-fixture rows excluded**');
      expect(report.markdown).toContain('desk 91 + unattributed 2164');
    });

    it('states no basis when the caller did not label one (no fabricated claim)', () => {
      // The negative control. An unlabelled fold is a POOLED fold, and a report
      // that renders the basis line unconditionally would assert de-noise that
      // never ran — worse than saying nothing, because it reads as evidence.
      const report = withBasis();

      expect(report.journalBasis).toBeUndefined();
      expect(report.journalBasisCounts).toBeUndefined();
      expect(report.markdown).toContain('Option-Trade Journal'); // section still renders
      expect(report.markdown).not.toContain('desk+unattributed');
      expect(report.markdown).not.toContain('QA-fixture rows excluded');
    });
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
            // TRA-2215 — cohorts are keyed structure::entryArchetype (a bare
            // structure label is shared by four sleeves), and the calibrated
            // decision boundary rides along so the EOD can show it.
            strategy: 'single_leg_rv::rv_band',
            degrading: true,
            baselineExpectancy: 1.2,
            recentExpectancy: -0.3,
            baselineTrades: 8,
            recentTrades: 6,
            decayThresholdR: -0.0443,
            reason:
              'Edge decaying: recent expectancy -0.3000R over 6 trades is below the 5th-percentile '
              + 'of 2000 resampled 6-trade windows drawn from its own 8-trade history '
              + '(threshold -0.0443R, baseline +1.2000R)',
          },
        ],
        degradingStrategies: ['single_leg_rv::rv_band'],
      },
      autopilotActions: [
        {
          kind: 'throttle',
          trigger: 'edge_decay',
          reason: 'Strategy "single_leg_rv::rv_band" flagged edge-decaying — autopilot throttled risk to 50% and queued for review',
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

/**
 * TRA-2610 — ACCEPTANCE. A symbol that is BOTH rule-suspect AND `'unavailable'` must
 * not be in `top5Movers`.
 *
 * Every number below is the row that actually shipped: `GET /api/reports/2026-07-29`
 * returned `#1 FGMC $8.30 +110.66%`, and `/2026-07-28` returned `#1 FGMC $8.30
 * +69.04%` — a frozen price with a moving session change, i.e. a prev-close
 * denominator re-derived against a different unadjusted reference each pass. On the
 * live tape FGMC was the one and only rule-suspect row (`implausible_move_ratio`,
 * ratio 2.107 vs SUSPECT_MOVE_RATIO 2) and carried `quoteStatus:'unavailable'` after
 * a failed fetch 104 minutes earlier.
 *
 * Before the fix the exclusion read `quoteStatus !== 'suspect'`, and
 * `'unavailable' !== 'suspect'` is `true`, so the row passed the guard written to
 * stop it and won first place by |changePct|. These tests fail on the pre-fix code.
 */
describe('TRA-2610 top movers — a fabricated move cannot be laundered by a failed fetch', () => {
  /** The shipped 07-29 headline row, verbatim. */
  const FGMC = {
    // `change` is DERIVED from the two fields the report actually published
    // (price 8.30, changePct +110.66 => implied prev close 3.94), so the fixture's
    // ratio is the live 2.107 rather than a number I made up beside it.
    symbol: 'FGMC', price: 8.30, volume: 12_000, change: 4.36, changePct: 110.66,
    lastUpdated: Date.now() - 6_241_000, quoteStatus: 'unavailable' as const, moveSuspect: true,
  };
  /** The four genuine movers it outranked, also verbatim from the 07-29 report. */
  const GENUINE = [
    { symbol: 'SOXL', price: 91.99, volume: 5_000_000, change: -17.55, changePct: -16.02, lastUpdated: Date.now(), quoteStatus: 'ok' as const, moveSuspect: false },
    { symbol: 'IREN', price: 29.31, volume: 3_000_000, change: -4.62, changePct: -13.62, lastUpdated: Date.now(), quoteStatus: 'ok' as const, moveSuspect: false },
    { symbol: 'AXTI', price: 36.97, volume: 1_000_000, change: -5.79, changePct: -13.54, lastUpdated: Date.now(), quoteStatus: 'ok' as const, moveSuspect: false },
    { symbol: 'ONDS', price: 6.80, volume: 2_000_000, change: -1.06, changePct: -13.49, lastUpdated: Date.now(), quoteStatus: 'ok' as const, moveSuspect: false },
  ];

  const reportFor = (symbols: EngineState['symbols']) => generateEodReport({
    state: makeEngineState({ symbols }),
    allClosedPositions: [],
    dailySignals: [],
    signalTypeMap: new Map(),
  });

  it('excludes the flagged+unavailable row and promotes the real #1', () => {
    const report = reportFor([FGMC, ...GENUINE]);
    expect(report.top5Movers.map(m => m.symbol)).not.toContain('FGMC');
    expect(report.top5Movers[0].symbol).toBe('SOXL');
    expect(report.markdown).not.toContain('FGMC');
  });

  it('excludes it even with the flag ERASED — the rule is re-executed', () => {
    // The erasure this ticket is about was a LOST STAMP. A consumer that only reads
    // the stamp is one refactor away from shipping the same headline again, so the
    // guard must hold with `moveSuspect` absent entirely.
    const { moveSuspect: _dropped, ...noFlag } = FGMC;
    const report = reportFor([noFlag, ...GENUINE]);
    expect(report.top5Movers.map(m => m.symbol)).not.toContain('FGMC');
    expect(report.top5Movers[0].symbol).toBe('SOXL');
  });

  it('POSITIVE CONTROL — the pre-fix predicate really does admit this row', () => {
    // A test asserting only "FGMC is absent" would also pass against a fix that
    // dropped every row, or against a tape that never contained the condition. Prove
    // the fixture CONTAINS what the instrument detects: the old comparison passes it.
    // The pre-fix guard, spelled out against the row exactly as it shipped. It has
    // to take a WIDENED string because `'suspect'` is no longer a member of the
    // `quoteStatus` union — which is itself the proof the field can no longer be
    // asked to carry two facts at once.
    const preFixWouldRank = (row: { quoteStatus?: string }) => row.quoteStatus !== 'suspect';
    expect(preFixWouldRank(FGMC)).toBe(true);                   // the pre-fix guard's verdict: RANK IT
    expect(Math.abs(FGMC.changePct)).toBeGreaterThan(Math.abs(GENUINE[0].changePct)); // and it wins #1
  });

  it('KNOWN-GOOD control — an unavailable row with a BELIEVABLE move is still ranked', () => {
    // The over-broad fix ("exclude everything unavailable") would pass every
    // assertion above while silently deleting most of the movers table on a
    // 42%-stale tape. Staleness alone must not exclude a row.
    const staleButPlausible = {
      symbol: 'USO', price: 88.12, volume: 900_000, change: 6.01, changePct: 7.32,
      lastUpdated: Date.now() - 6_241_000, quoteStatus: 'unavailable' as const, moveSuspect: false,
    };
    const report = reportFor([staleButPlausible, ...GENUINE]);
    expect(report.top5Movers.map(m => m.symbol)).toContain('USO');
  });

  it('leaves an ordinary board untouched', () => {
    const report = reportFor(GENUINE);
    expect(report.top5Movers.map(m => m.symbol)).toEqual(['SOXL', 'IREN', 'AXTI', 'ONDS']);
  });
});
