import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import type { AccountSettings, Position } from '@trading-app/shared';
import type { BacktestResult } from '@trading-app/backtest';

// DATA_DIR is read at module-eval time inside trade-store / promotion-store, so
// it must be set BEFORE those modules load. We therefore set it here and pull
// the units in via dynamic import() inside beforeAll (after the env is set).
const DATA_DIR = mkdtempSync(join(tmpdir(), 'promo-svc-'));
process.env['DATA_DIR'] = DATA_DIR;

const USER = 'alice';

let svc: typeof import('./promotion-service.js');
let store: typeof import('./promotion-store.js');
let tradeStore: typeof import('./trade-store.js');

const DAY_MS = 24 * 60 * 60 * 1000;

function paperTrade(pnl: number, i: number): Position {
  // Space trades one per day so the ledger spans ~weeks — long enough for the
  // gate to annualize the paper Sharpe (TRA-538); a near-zero span would mark
  // the Sharpe unverified and fail Stage 2.
  return {
    id: `t${i}`,
    symbol: 'BTC-USD',
    side: 'buy',
    signalType: 'bb_fade',
    entryPrice: 100,
    quantity: 1,
    stopLoss: 99, // risk distance 1 → R == pnl
    takeProfit: 103,
    openedAt: i * DAY_MS,
    closedAt: i * DAY_MS + 3_600_000,
    pnl,
    mode: 'demo',
  };
}

function passingReport(): BacktestResult {
  return {
    sharpeRatio: 1.3,
    expectancy: 0.2,
    profitFactor: 1.6,
    maxDrawdown: 0.12,
    totalTrades: 130,
  } as BacktestResult;
}

// Settings whose RESULT runs live crypto auto-trading on a bb_fade-only preset.
const liveSettings = {
  mode: 'live',
  cryptoAutoTradingEnabledLive: true,
  activeStrategyPreset: 'bb_fade_sol_doge', // enabledStrategies: ['bb_fade']
} as AccountSettings;

beforeAll(async () => {
  svc = await import('./promotion-service.js');
  store = await import('./promotion-store.js');
  tradeStore = await import('./trade-store.js');

  // Seed 60 monitored bb_fade paper trades (50 winners +1.5R, 10 losers -0.5R).
  const closed = Array.from({ length: 60 }, (_, i) => paperTrade(i % 6 === 0 ? -0.5 : 1.5, i));
  await tradeStore.saveCryptoTradeSnapshot(USER, {
    version: 1,
    savedAt: new Date().toISOString(),
    openPositions: [],
    closedPositions: closed,
    demoClosedPositions: closed,
    recentSignals: [],
    account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, openingEquityToday: 25_000 },
  });
});

describe('TRA-532 promotion gate — end-to-end enforcement', () => {
  it('blocks the live transition when no strategy is promoted (all three stages fail)', async () => {
    const gate = await svc.evaluateLiveTransitionGate(USER, liveSettings);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked[0]?.strategyId).toBe('bb_fade');
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/Stage 1/);
  });

  it('still blocks after only the backtest is registered (paper + sign-off missing)', async () => {
    await store.registerBacktestReport({
      strategyId: 'bb_fade',
      report: passingReport(),
      reportId: 'TRA-405',
      registeredBy: 'qt',
    });
    const status = await svc.buildPromotionStatus(USER, 'bb_fade');
    expect(status.backtest.state).toBe('pass');
    // Paper passes from the seeded ledger, but sign-off is still absent.
    expect(status.paper.state).toBe('pass');
    expect(status.signoff).toBe('absent');
    expect(status.canGoLive).toBe(false);

    const gate = await svc.evaluateLiveTransitionGate(USER, liveSettings);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/sign-off/i);
  });

  it('allows the live transition once backtest + paper pass AND a sign-off is recorded', async () => {
    await store.recordSignoff({
      strategyId: 'bb_fade',
      reviewer: 'QuantTrader',
      backtestMetrics: store.deriveBacktestGateMetrics(passingReport()),
      paperMetrics: await svc.snapshotPaperMetrics(USER, 'bb_fade'),
    });
    const status = await svc.buildPromotionStatus(USER, 'bb_fade');
    expect(status.canGoLive).toBe(true);
    expect(status.blockedReasons).toHaveLength(0);

    const gate = await svc.evaluateLiveTransitionGate(USER, liveSettings);
    expect(gate.allowed).toBe(true);
  });

  it('never blocks a settings change that turns live OFF (Demo edits are unrestricted)', async () => {
    const demoSettings = { ...liveSettings, mode: 'demo' } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate('bob-unpromoted', demoSettings);
    expect(gate.allowed).toBe(true);
  });

  it('computed paper metrics reflect the ledger (count and positive expectancy)', async () => {
    const m = await svc.snapshotPaperMetrics(USER, 'bb_fade');
    expect(m?.tradeCount).toBe(60);
    expect(m?.expectancy).toBeGreaterThan(0.5);
  });
});
