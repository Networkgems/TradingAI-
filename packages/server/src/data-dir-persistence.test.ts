import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OptionPosition, Position } from '@trading-app/shared';
import { PnlTracker } from './pnl-tracker.js';
import type { StocksTradeSnapshot, CryptoTradeSnapshot } from './trade-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-522 — restart of the PM2 `trading-server` silently swapped the entire demo
// account (equity $1,000 -> $26,397, positions QBTS/NVAX/GM -> IREN/ASTC, open
// options -> none, closed history -> empty).
//
// Root cause: the persistence root resolved to `<repo>/packages/server/data`
// whenever `DATA_DIR` was unset (the production PM2 launch did not set it). Two
// repos live on the host, so a restart launched from a different repo / cwd /
// ecosystem file loaded a *different* `packages/server/data` — a different book.
//
// These tests pin the two guarantees of the fix:
//   1. `resolveDataDir` is launch-cwd independent and env-pinned (the contract
//      that, combined with ecosystem.config.cjs now setting DATA_DIR, makes the
//      production launch deterministic).
//   2. Restart with a CONSTANT DATA_DIR preserves the full book (equity, open
//      positions, options, closed history); and — demonstrating the original
//      defect — restart against a DIFFERENT DATA_DIR loads a different book.
// ─────────────────────────────────────────────────────────────────────────────

// trade-store captures DATA_DIR at module-evaluation time, so set
// process.env.DATA_DIR BEFORE importing it (same pattern as trade-store.test.ts).
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'tra522-datadir-'));
process.env.DATA_DIR = TMP_ROOT;

type TradeStoreModule = typeof import('./trade-store.js');
let resolveDataDir: TradeStoreModule['resolveDataDir'];
let loadStocksTradeSnapshot: TradeStoreModule['loadStocksTradeSnapshot'];
let saveStocksTradeSnapshot: TradeStoreModule['saveStocksTradeSnapshot'];
let loadCryptoTradeSnapshot: TradeStoreModule['loadCryptoTradeSnapshot'];
let saveCryptoTradeSnapshot: TradeStoreModule['saveCryptoTradeSnapshot'];

beforeAll(async () => {
  const mod = await import('./trade-store.js');
  resolveDataDir = mod.resolveDataDir;
  loadStocksTradeSnapshot = mod.loadStocksTradeSnapshot;
  saveStocksTradeSnapshot = mod.saveStocksTradeSnapshot;
  loadCryptoTradeSnapshot = mod.loadCryptoTradeSnapshot;
  saveCryptoTradeSnapshot = mod.saveCryptoTradeSnapshot;
});

beforeEach(() => {
  rmSync(join(TMP_ROOT, 'users'), { recursive: true, force: true });
  rmSync(join(TMP_ROOT, 'backups'), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const USER = 'demo';

function makeOption(): OptionPosition {
  return {
    id: 'o1',
    symbol: 'SOFI',
    optionType: 'call',
    strike: 8,
    expiration: '2026-06-20',
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 0.45,
    currentPremium: 0.6,
    tp1Premium: 0.56,
    tp1Hit: false,
    stopLossPremium: 0.34,
    peakPremium: 0.62,
    trailingActive: false,
    trailingStopPremium: 0.55,
    underlyingEntryPrice: 7.8,
    openedAt: 1717200000000,
    signalId: 's-opt-1',
    signalType: 'orb_breakout',
  };
}

function makeStocksSnapshot(): StocksTradeSnapshot {
  const open: Position = {
    id: 'p-qbts',
    symbol: 'QBTS',
    side: 'buy',
    signalType: 'orb_breakout',
    entryPrice: 8.2,
    quantity: 50,
    stopLoss: 7.9,
    takeProfit: 9.1,
    openedAt: 1717100000000,
  };
  const closed: Position = {
    id: 'p-gm',
    symbol: 'GM',
    side: 'buy',
    signalType: 'reversal',
    entryPrice: 48,
    quantity: 10,
    stopLoss: 47,
    takeProfit: 51,
    openedAt: 1716900000000,
    closedAt: 1717000000000,
    exitPrice: 50,
    pnl: 20,
  };
  return {
    version: 1,
    savedAt: '',
    openPositions: [open],
    closedPositions: [closed],
    recentSignals: [],
    dailySignals: [],
    positionSignalType: [['p-qbts', 'orb_breakout']],
    options: {
      openOptions: [makeOption()],
      closedOptions: [],
      optionsPnl: 12.5,
      dailyCount: 1,
      currentDayKey: '2026-06-02',
      cash: 400,
      equity: 520,
    },
    account: {
      cash: 590,
      equity: 1000,
      initialEquity: 1000,
      dailyPnl: -7.5,
    },
  };
}

function makeCryptoSnapshot(): CryptoTradeSnapshot {
  const open: Position = {
    id: 'c-btc',
    symbol: 'BTC-USD',
    side: 'buy',
    signalType: 'bb_fade',
    entryPrice: 60000,
    quantity: 0.01,
    stopLoss: 59000,
    takeProfit: 62000,
    openedAt: 1717100000000,
  };
  const closed: Position = {
    id: 'c-sol',
    symbol: 'SOL-USD',
    side: 'buy',
    signalType: 'bb_fade',
    entryPrice: 150,
    quantity: 2,
    stopLoss: 145,
    takeProfit: 160,
    openedAt: 1716900000000,
    closedAt: 1717000000000,
    exitPrice: 158,
    pnl: 16,
  };
  return {
    version: 1,
    savedAt: '',
    openPositions: [open],
    closedPositions: [closed],
    demoClosedPositions: [closed],
    recentSignals: [],
    account: {
      cash: 22000,
      equity: 25000,
      initialEquity: 25000,
      openingEquityToday: 25000,
    },
  };
}

describe('TRA-522 — resolveDataDir is launch-cwd independent and env-pinned', () => {
  it('returns the DATA_DIR env value verbatim when set', () => {
    expect(resolveDataDir({ DATA_DIR: '/srv/tradingai/data' }, '/anything/dist')).toBe(
      '/srv/tradingai/data',
    );
  });

  it('ignores an empty / whitespace DATA_DIR and falls back to the module-anchored path', () => {
    expect(resolveDataDir({ DATA_DIR: '   ' }, join('/opt/app/packages/server/dist'))).toBe(
      join('/opt/app/packages/server/dist', '..', 'data'),
    );
  });

  it('anchors the fallback to the module dir, never to process.cwd()', () => {
    // The fallback path is a pure function of moduleDir; changing the process
    // working directory between calls must NOT change the resolved path. This is
    // the exact property whose absence caused the swap.
    const moduleDir = '/repos/tradingai_repo/packages/server/dist';
    const cwdBefore = process.cwd();
    const a = resolveDataDir({}, moduleDir);
    try {
      process.chdir(tmpdir());
      const b = resolveDataDir({}, moduleDir);
      expect(b).toBe(a);
      expect(b).toBe(join(moduleDir, '..', 'data'));
    } finally {
      process.chdir(cwdBefore);
    }
  });

  it('resolves a DIFFERENT path for a different repo when DATA_DIR is unset (root cause)', () => {
    const repoA = resolveDataDir({}, '/home/u/_default/tradingai_repo/packages/server/dist');
    const repoB = resolveDataDir({}, '/home/u/TradingAI/packages/server/dist');
    expect(repoA).not.toBe(repoB);
    // ...but pointing both at one canonical DATA_DIR collapses them — the fix.
    const canonical = { DATA_DIR: '/srv/tradingai/data' };
    expect(resolveDataDir(canonical, '/home/u/_default/tradingai_repo/packages/server/dist')).toBe(
      resolveDataDir(canonical, '/home/u/TradingAI/packages/server/dist'),
    );
  });
});

describe('TRA-522 — restart preserves the full account book under a constant DATA_DIR', () => {
  it('preserves equity across a simulated restart (same dataDir)', () => {
    const dataDir = join(TMP_ROOT, 'users', USER);
    // First boot: book is worth $1,000.
    const t1 = new PnlTracker(dataDir, 1_000);
    t1.saveEquity(1_000, 12.5);
    expect(t1.hasSavedState()).toBe(false);

    // Restart: a new tracker over the SAME dataDir reloads the saved equity.
    const t2 = new PnlTracker(dataDir, 1_000);
    expect(t2.hasSavedState()).toBe(true);
    expect(t2.getSavedEquity()).toBe(1_000);
    expect(t2.getSavedOptionsPnl()).toBe(12.5);
  });

  it('preserves equity, open positions, options and closed history (stocks + crypto)', async () => {
    const stocks = makeStocksSnapshot();
    const crypto = makeCryptoSnapshot();
    await saveStocksTradeSnapshot(USER, stocks);
    await saveCryptoTradeSnapshot(USER, crypto);

    // Simulated restart: reload from the same DATA_DIR.
    const loadedStocks = await loadStocksTradeSnapshot(USER);
    const loadedCrypto = await loadCryptoTradeSnapshot(USER);

    expect(loadedStocks).not.toBeNull();
    expect(loadedStocks!.account).toEqual(stocks.account);
    expect(loadedStocks!.openPositions).toEqual(stocks.openPositions);
    expect(loadedStocks!.closedPositions).toEqual(stocks.closedPositions);
    expect(loadedStocks!.options.openOptions).toEqual(stocks.options.openOptions);
    expect(loadedStocks!.options.optionsPnl).toBe(stocks.options.optionsPnl);

    expect(loadedCrypto).not.toBeNull();
    expect(loadedCrypto!.account).toEqual(crypto.account);
    expect(loadedCrypto!.openPositions).toEqual(crypto.openPositions);
    expect(loadedCrypto!.demoClosedPositions).toEqual(crypto.demoClosedPositions);
  });

  it('demonstrates the swap: a restart against a DIFFERENT dataDir does NOT see the book', () => {
    const liveDir = join(TMP_ROOT, 'users', USER); // the live $1,000 book
    const t1 = new PnlTracker(liveDir, 1_000);
    t1.saveEquity(1_000, 0);

    // Sibling repo's data dir — what a restart from the wrong cwd/ecosystem loads.
    // Seed it with its own stale book ($26,397) the way a prior sibling run would.
    const siblingDir = join(TMP_ROOT, 'sibling', 'users', USER);
    new PnlTracker(siblingDir, 26_397).saveEquity(26_397, 0);

    // A process booting from the sibling dir sees the stale book, not the live one.
    const t2 = new PnlTracker(siblingDir, 1_000);
    expect(t2.hasSavedState()).toBe(true);
    expect(t2.getSavedEquity()).toBe(26_397); // a different, stale book — the swap
    // The live book is untouched but invisible to the sibling-launched process.
    expect(existsSync(join(liveDir, 'equity-state.json'))).toBe(true);
    expect(existsSync(join(siblingDir, 'equity-state.json'))).toBe(true);
  });
});
