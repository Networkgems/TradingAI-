// TRA-138 verification: switching demo → live → demo must preserve demo equity,
// positions, signals, and watchlist quotes. Demo equity must NOT reset to 25K
// after a live round-trip.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SignalEngine } from '../src/signal-engine.js';
import { CryptoSignalEngine } from '../src/crypto-engine.js';
import { PnlTracker } from '../src/pnl-tracker.js';
import type { AccountSettings, TradeSignal } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

let failures = 0;
function check(name: string, cond: boolean, info?: unknown) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.log(`✗ ${name}`, info ?? '');
  }
}

function makeSettings(overrides: Partial<AccountSettings> = {}): AccountSettings {
  return { ...DEFAULT_ACCOUNT_SETTINGS, ...overrides };
}

function fakeSignal(symbol: string, type: TradeSignal['type'], side: TradeSignal['side']): TradeSignal {
  return {
    id: `${symbol}-${type}-${Date.now()}-${Math.random()}`,
    symbol,
    type,
    side,
    entryPrice: 100,
    stopLoss: side === 'buy' ? 95 : 105,
    takeProfit: side === 'buy' ? 110 : 90,
    timestamp: Date.now(),
    rationale: 'test',
    timeframe: '5m',
  } as TradeSignal;
}

function runStocksScenario() {
  console.log('\n── Stocks: demo($25K start, +$25K profits) → live → demo round-trip ──');
  const dataDir = mkdtempSync(join(tmpdir(), 'tra138-stocks-'));
  try {
    const settings = makeSettings({ mode: 'demo', demoEquityStocks: 25_000, demoEquityCrypto: 25_000 });
    const tracker = new PnlTracker(dataDir, 25_000);
    const engine = new SignalEngine(settings, tracker);

    // Simulate $25K of realized profits: open + close a winning position.
    const sig = fakeSignal('AAPL', 'reversal', 'buy');
    // @ts-expect-error reach internal account for the test fixture.
    const account = engine.account as InstanceType<typeof import('../src/paper-account.js').PaperAccount>;
    const opened = account.openPosition(sig, 100);
    if (!opened) throw new Error('failed to open paper position for fixture');
    // Force-close via priced exit at $200 to realize a $25K-ish gain.
    account.closePosition(opened.id, 200);
    tracker.saveEquity(account.getState().totalEquity, 0);
    tracker.syncOpeningEquity(account.getState().totalEquity, account.getState().dailyPnl);

    // Reopen a fresh position so we have something to preserve across the round-trip.
    const sig2 = fakeSignal('MSFT', 'reversal', 'buy');
    const live = account.openPosition(sig2, 100);
    if (!live) throw new Error('failed to open second paper position');

    // Push a synthetic signal record so we can check signal preservation.
    // @ts-expect-error reach internal recentSignals for the test fixture.
    engine.recentSignals.unshift(fakeSignal('NVDA', 'macd-bollinger', 'sell'));
    // Push a watchlist quote so we can verify it persists.
    // @ts-expect-error reach internal symbolState for the test fixture.
    engine.symbolState.set('AAPL', { symbol: 'AAPL', price: 200, volume: 1000, change: 5, changePct: 2.5, lastUpdated: Date.now() });

    const baselineEquity = account.getState().totalEquity;
    const baselinePositions = account.getState().openPositions.length;
    const baselineSignals = engine.getState().signals.length;
    const baselineSymbols = engine.getState().symbols.length;
    console.log(`  baseline demo: equity=${baselineEquity}, positions=${baselinePositions}, signals=${baselineSignals}, symbols=${baselineSymbols}`);

    // Sanity: baseline must reflect realized profits.
    check('baseline equity reflects $25K profit (>$25K)', baselineEquity > 25_000, baselineEquity);

    // Switch to LIVE.
    engine.applySettings(makeSettings({ mode: 'live', demoEquityStocks: 25_000 }));
    const liveState = engine.getState();
    check('live mode shows 0 equity', liveState.account.totalEquity === 0, liveState.account.totalEquity);
    check('live mode shows 0 cash', liveState.account.availableCash === 0, liveState.account.availableCash);
    check('live mode shows no positions', liveState.account.openPositions.length === 0, liveState.account.openPositions.length);
    check('live mode shows 0 dailyPnl', liveState.account.dailyPnl === 0, liveState.account.dailyPnl);
    check('live mode keeps watchlist visible', liveState.symbols.length === baselineSymbols, liveState.symbols.length);
    check('live mode keeps signals visible', liveState.signals.length === baselineSignals, liveState.signals.length);

    // Switch back to DEMO with default $25K demoEquityStocks.
    engine.applySettings(makeSettings({ mode: 'demo', demoEquityStocks: 25_000 }));
    const restored = engine.getState();
    console.log(`  restored demo: equity=${restored.account.totalEquity}, positions=${restored.account.openPositions.length}, signals=${restored.signals.length}, symbols=${restored.symbols.length}`);

    check('demo equity preserved (>$25K, not reset to default)', restored.account.totalEquity > 25_000, restored.account.totalEquity);
    check('demo equity matches baseline', restored.account.totalEquity === baselineEquity, { restored: restored.account.totalEquity, baseline: baselineEquity });
    check('positions preserved', restored.account.openPositions.length === baselinePositions, restored.account.openPositions.length);
    check('signals preserved', restored.signals.length === baselineSignals, restored.signals.length);
    check('watchlist quotes preserved', restored.symbols.length === baselineSymbols, restored.symbols.length);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function runStocksEquityChange() {
  console.log('\n── Stocks: changing demoEquityStocks 25K→50K preserves positions/signals ──');
  const dataDir = mkdtempSync(join(tmpdir(), 'tra138-stocks-eq-'));
  try {
    const settings = makeSettings({ mode: 'demo', demoEquityStocks: 25_000 });
    const tracker = new PnlTracker(dataDir, 25_000);
    const engine = new SignalEngine(settings, tracker);

    // @ts-expect-error reach internal account for the test fixture.
    const account = engine.account as InstanceType<typeof import('../src/paper-account.js').PaperAccount>;
    const sig = fakeSignal('AAPL', 'reversal', 'buy');
    const pos = account.openPosition(sig, 100);
    if (!pos) throw new Error('failed to open paper position');
    // @ts-expect-error reach internal recentSignals for the test fixture.
    engine.recentSignals.unshift(fakeSignal('NVDA', 'macd-bollinger', 'sell'));
    // @ts-expect-error reach internal symbolState for the test fixture.
    engine.symbolState.set('AAPL', { symbol: 'AAPL', price: 100, volume: 1000, change: 0, changePct: 0, lastUpdated: Date.now() });

    const beforeEquity = account.getState().totalEquity;
    const beforePositions = account.getState().openPositions.length;

    // Bump demoEquityStocks to 50K.
    engine.applySettings(makeSettings({ mode: 'demo', demoEquityStocks: 50_000 }));
    const after = engine.getState();
    console.log(`  before: equity=${beforeEquity}, positions=${beforePositions}; after: equity=${after.account.totalEquity}, positions=${after.account.openPositions.length}`);

    check('equity rebased by +25K delta', after.account.totalEquity === beforeEquity + 25_000, { before: beforeEquity, after: after.account.totalEquity });
    check('positions preserved across equity change', after.account.openPositions.length === beforePositions, after.account.openPositions.length);
    check('signals preserved across equity change', after.signals.length === 1, after.signals.length);
    check('watchlist preserved across equity change', after.symbols.length === 1, after.symbols.length);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function runCryptoScenario() {
  console.log('\n── Crypto: demo → live → demo preserves equity/positions/signals/symbols ──');
  const dataDir = mkdtempSync(join(tmpdir(), 'tra138-crypto-'));
  try {
    const settings = makeSettings({ mode: 'demo', demoEquityCrypto: 25_000 });
    const tracker = new PnlTracker(dataDir, 25_000);
    const engine = new CryptoSignalEngine(tracker, settings);

    // Simulate realized profits by manipulating the internal account.
    // @ts-expect-error reach internal account for the test fixture.
    const account = engine.account as InstanceType<typeof import('../src/crypto-account.js').CryptoPaperAccount>;
    const sig = fakeSignal('BTC-USD', 'reversal', 'buy');
    const pos = account.openPosition(sig, 100);
    if (!pos) throw new Error('failed to open crypto paper position');
    account.closePosition(pos.id, 200);
    tracker.saveEquity(account.getEquity(), 0);
    tracker.syncOpeningEquity(account.getState().totalEquity, account.getState().dailyPnl);

    const sig2 = fakeSignal('ETH-USD', 'reversal', 'buy');
    const open2 = account.openPosition(sig2, 100);
    if (!open2) throw new Error('failed to open second crypto position');
    // @ts-expect-error reach internal recentSignals for the test fixture.
    engine.recentSignals.unshift(fakeSignal('SOL-USD', 'macd-bollinger', 'sell'));
    // @ts-expect-error reach internal symbolState for the test fixture.
    engine.symbolState.set('BTC-USD', { symbol: 'BTC-USD', price: 60000, volume: 1, change: 100, changePct: 0.1, lastUpdated: Date.now() });

    const baselineEquity = account.getState().totalEquity;
    const baselinePositions = account.getState().openPositions.length;
    const baselineSignals = engine.getState().signals.length;
    const baselineSymbols = engine.getState().symbols.length;
    console.log(`  baseline demo: equity=${baselineEquity}, positions=${baselinePositions}, signals=${baselineSignals}, symbols=${baselineSymbols}`);

    check('crypto baseline equity reflects gain (>$25K)', baselineEquity > 25_000, baselineEquity);

    engine.applySettings(makeSettings({ mode: 'live', demoEquityCrypto: 25_000 }));
    const live = engine.getState();
    check('crypto live mode shows 0 equity', live.account.totalEquity === 0, live.account.totalEquity);
    check('crypto live mode shows no positions', live.account.openPositions.length === 0, live.account.openPositions.length);
    check('crypto live mode keeps watchlist visible', live.symbols.length === baselineSymbols);
    check('crypto live mode keeps signals visible', live.signals.length === baselineSignals);

    engine.applySettings(makeSettings({ mode: 'demo', demoEquityCrypto: 25_000 }));
    const restored = engine.getState();
    console.log(`  restored demo: equity=${restored.account.totalEquity}, positions=${restored.account.openPositions.length}, signals=${restored.signals.length}, symbols=${restored.symbols.length}`);

    check('crypto demo equity preserved (>$25K)', restored.account.totalEquity > 25_000, restored.account.totalEquity);
    check('crypto demo equity matches baseline', restored.account.totalEquity === baselineEquity);
    check('crypto positions preserved', restored.account.openPositions.length === baselinePositions);
    check('crypto signals preserved', restored.signals.length === baselineSignals);
    check('crypto watchlist preserved', restored.symbols.length === baselineSymbols);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function runStocksRestartInLiveMode() {
  console.log('\n── Stocks: server restart in live mode → switch to demo restores demo equity ──');
  const dataDir = mkdtempSync(join(tmpdir(), 'tra138-stocks-restart-'));
  try {
    // First boot: demo, earn profits, then save with mode='live'.
    {
      const settings = makeSettings({ mode: 'demo', demoEquityStocks: 25_000 });
      const tracker = new PnlTracker(dataDir, 25_000);
      const engine = new SignalEngine(settings, tracker);
      // @ts-expect-error reach internal account.
      const account = engine.account as InstanceType<typeof import('../src/paper-account.js').PaperAccount>;
      const sig = fakeSignal('AAPL', 'reversal', 'buy');
      const pos = account.openPosition(sig, 100);
      if (!pos) throw new Error('failed open');
      account.closePosition(pos.id, 200);
      tracker.saveEquity(account.getState().totalEquity, 0);
      tracker.syncOpeningEquity(account.getState().totalEquity, account.getState().dailyPnl);
      // Switch to live and persist tracker state should remain intact.
      engine.applySettings(makeSettings({ mode: 'live', demoEquityStocks: 25_000 }));
    }

    // Simulate server restart in live mode.
    {
      const settings = makeSettings({ mode: 'live', demoEquityStocks: 25_000 });
      const tracker = new PnlTracker(dataDir, 25_000);
      const engine = new SignalEngine(settings, tracker);
      const liveState = engine.getState();
      check('post-restart live: account shown as 0', liveState.account.totalEquity === 0, liveState.account.totalEquity);

      engine.applySettings(makeSettings({ mode: 'demo', demoEquityStocks: 25_000 }));
      const demoState = engine.getState();
      console.log(`  post-restart demo: equity=${demoState.account.totalEquity}`);
      check('post-restart demo: equity preserved (>$25K)', demoState.account.totalEquity > 25_000, demoState.account.totalEquity);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

runStocksScenario();
runStocksEquityChange();
runCryptoScenario();
runStocksRestartInLiveMode();

if (failures > 0) {
  console.error(`\n❌ ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('\n✅ All checks passed');
}
