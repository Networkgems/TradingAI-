import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// trade-store + user-context capture DATA_DIR at module evaluation time, so
// process.env.DATA_DIR must be set BEFORE either module is imported.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'user-context-test-'));
process.env.DATA_DIR = TMP_ROOT;

type TradeStoreModule = typeof import('./trade-store.js');
type UserContextModule = typeof import('./user-context.js');
type UsersModule = typeof import('./users.js');

let saveStocksTradeSnapshot: TradeStoreModule['saveStocksTradeSnapshot'];
let loadStocksTradeSnapshot: TradeStoreModule['loadStocksTradeSnapshot'];
let saveCryptoTradeSnapshot: TradeStoreModule['saveCryptoTradeSnapshot'];
let loadCryptoTradeSnapshot: TradeStoreModule['loadCryptoTradeSnapshot'];
let runTra237OptionsReset: UserContextModule['runTra237OptionsReset'];
let runTra301DemoFreshStart: UserContextModule['runTra301DemoFreshStart'];
let runTra338MegaUsdCleanup: UserContextModule['runTra338MegaUsdCleanup'];
let stockModeKey: UserContextModule['stockModeKey'];
let cryptoModeKey: UserContextModule['cryptoModeKey'];

beforeAll(async () => {
  // Seed a users.json so getAllUsers() returns the test user. users.ts reads a
  // plain array; only `username` is required by the migration's read path.
  writeFileSync(
    join(TMP_ROOT, 'users.json'),
    JSON.stringify([
      { username: 'alice', email: '', passwordHash: 'x', role: 'user', createdAt: '2026-05-02T00:00:00.000Z' },
    ]),
    'utf-8',
  );
  const tradeStore = await import('./trade-store.js');
  saveStocksTradeSnapshot = tradeStore.saveStocksTradeSnapshot;
  loadStocksTradeSnapshot = tradeStore.loadStocksTradeSnapshot;
  saveCryptoTradeSnapshot = tradeStore.saveCryptoTradeSnapshot;
  loadCryptoTradeSnapshot = tradeStore.loadCryptoTradeSnapshot;
  const userCtx = await import('./user-context.js');
  runTra237OptionsReset = userCtx.runTra237OptionsReset;
  runTra301DemoFreshStart = userCtx.runTra301DemoFreshStart;
  runTra338MegaUsdCleanup = userCtx.runTra338MegaUsdCleanup;
  stockModeKey = userCtx.stockModeKey;
  cryptoModeKey = userCtx.cryptoModeKey;
  // Populate the in-memory users cache from the seeded users.json.
  const users = (await import('./users.js')) as UsersModule;
  await users.loadUsers();
});

beforeEach(() => {
  // Wipe the marker file + any lingering user trade snapshots between tests so
  // each test runs against a deterministic starting state.
  rmSync(join(TMP_ROOT, '.tra-237-options-reset'), { force: true });
  rmSync(join(TMP_ROOT, '.tra-301-demo-fresh-start'), { force: true });
  rmSync(join(TMP_ROOT, '.tra-338-mega-usd-cleanup'), { force: true });
  rmSync(join(TMP_ROOT, 'users', 'alice'), { recursive: true, force: true });
  mkdirSync(join(TMP_ROOT, 'users', 'alice'), { recursive: true });
});

function makeCorruptedSnapshot() {
  // Mimic the bug shape the user reported: production bucket holds non-zero
  // OPTS P&L and 10 open contracts that should have lived in sandbox.
  return {
    version: 1 as const,
    savedAt: '',
    openPositions: [],
    closedPositions: [],
    recentSignals: [],
    dailySignals: [],
    positionSignalType: [] as Array<[string, 'orb_breakout']>,
    options: {
      openOptions: [],
      closedOptions: [],
      optionsPnl: 524.50,
      dailyCount: 10,
      currentDayKey: '2026-04-28',
      cash: 100,
      equity: 624.50,
    },
    optionsByEnv: {
      sandbox: {
        openOptions: [],
        closedOptions: [],
        optionsPnl: 0,
        dailyCount: 0,
        currentDayKey: '2026-04-28',
        cash: 300,
        equity: 300,
        tradierEnv: 'sandbox' as const,
      },
      production: {
        openOptions: [
          // Stand-in for the 10 leaked positions — only count is asserted.
          {
            id: 'leak-1',
            symbol: 'AAPL',
            optionType: 'call' as const,
            contracts: 1,
            contractsRemaining: 1,
            premiumPaid: 1.0,
            currentPremium: 1.0,
            tp1Premium: 1.25,
            tp1Hit: false,
            stopLossPremium: 0.75,
            peakPremium: 1.0,
            trailingActive: false,
            trailingStopPremium: 1.2,
            underlyingEntryPrice: 180,
            openedAt: 1700000000000,
            signalId: 's-1',
            signalType: 'relative_value' as const,
          },
        ],
        closedOptions: [],
        optionsPnl: 524.50,
        dailyCount: 10,
        currentDayKey: '2026-04-28',
        cash: 100,
        equity: 624.50,
        tradierEnv: 'production' as const,
      },
    },
    account: {
      cash: 300,
      equity: 300,
      initialEquity: 25_000,
      dailyPnl: 0,
    },
  };
}

describe('runTra237OptionsReset — one-shot options bucket cleanup', () => {
  it('clears optionsByEnv (both buckets) and resets the legacy options blob', async () => {
    await saveStocksTradeSnapshot('alice', makeCorruptedSnapshot());

    await runTra237OptionsReset();

    const after = await loadStocksTradeSnapshot('alice');
    expect(after).not.toBeNull();
    expect(after!.optionsByEnv).toBeDefined();
    expect(after!.optionsByEnv!.sandbox.openOptions).toEqual([]);
    expect(after!.optionsByEnv!.sandbox.optionsPnl).toBe(0);
    expect(after!.optionsByEnv!.sandbox.dailyCount).toBe(0);
    expect(after!.optionsByEnv!.production.openOptions).toEqual([]);
    expect(after!.optionsByEnv!.production.optionsPnl).toBe(0);
    expect(after!.optionsByEnv!.production.dailyCount).toBe(0);
    expect(after!.options.optionsPnl).toBe(0);
    expect(after!.options.openOptions).toEqual([]);
    // Account equity / cash must NOT be touched — only the options state is reset.
    expect(after!.account.equity).toBe(300);
    expect(after!.account.cash).toBe(300);
    // Marker is written so the migration is idempotent.
    expect(existsSync(join(TMP_ROOT, '.tra-237-options-reset'))).toBe(true);
  });

  it('is idempotent — second run is a no-op once the marker exists', async () => {
    await saveStocksTradeSnapshot('alice', makeCorruptedSnapshot());
    await runTra237OptionsReset();
    // Re-introduce dirty state and confirm a second run does NOT touch it
    // (marker short-circuits the migration).
    await saveStocksTradeSnapshot('alice', makeCorruptedSnapshot());
    await runTra237OptionsReset();
    const after = await loadStocksTradeSnapshot('alice');
    expect(after!.optionsByEnv!.production.optionsPnl).toBe(524.50);
    expect(after!.optionsByEnv!.production.openOptions).toHaveLength(1);
  });

  it('handles users with no trade snapshot gracefully (no throw, marker still written)', async () => {
    expect(existsSync(join(TMP_ROOT, '.tra-237-options-reset'))).toBe(false);
    await runTra237OptionsReset();
    expect(existsSync(join(TMP_ROOT, '.tra-237-options-reset'))).toBe(true);
  });
});

// TRA-244 — per-account calendar bucket helpers.
// `mode === 'demo'` always picks the demo bucket regardless of any leftover
// Tradier env. `mode === 'live'` flips to sandbox/live based on
// `liveTradierEnvOptions` so demo / sandbox / production each keep their own
// calendar history.
describe('stockModeKey / cryptoModeKey — TRA-244 per-account calendar buckets', () => {
  type Settings = Parameters<typeof stockModeKey>[0];
  function settings(overrides: Partial<Settings> = {}): Settings {
    return { mode: 'demo', ...overrides } as Settings;
  }

  it('demo mode always returns "demo" regardless of liveTradierEnvOptions', () => {
    expect(stockModeKey(settings({ mode: 'demo', liveTradierEnvOptions: 'production' })))
      .toBe('demo');
    expect(stockModeKey(settings({ mode: 'demo', liveTradierEnvOptions: 'sandbox' })))
      .toBe('demo');
    expect(cryptoModeKey(settings({ mode: 'demo' }))).toBe('demo');
  });

  it('live + production Tradier env returns "live"', () => {
    expect(stockModeKey(settings({ mode: 'live', liveTradierEnvOptions: 'production' })))
      .toBe('live');
  });

  it('live + sandbox Tradier env returns "sandbox"', () => {
    expect(stockModeKey(settings({ mode: 'live', liveTradierEnvOptions: 'sandbox' })))
      .toBe('sandbox');
  });

  it('live with missing liveTradierEnvOptions defaults to "sandbox" (matches resolveTradierOptionsCreds)', () => {
    expect(stockModeKey(settings({ mode: 'live' }))).toBe('sandbox');
  });

  it('cryptoModeKey is binary: live → live, anything else → demo', () => {
    expect(cryptoModeKey(settings({ mode: 'live' }))).toBe('live');
    expect(cryptoModeKey(settings({ mode: 'demo' }))).toBe('demo');
  });
});

describe('runTra301DemoFreshStart — full demo fresh-start wipe', () => {
  function seedAliceData(): {
    files: string[];
    reportSubdirFiles: string[];
  } {
    const userDir = join(TMP_ROOT, 'users', 'alice');
    const cryptoDir = join(userDir, 'crypto');
    mkdirSync(cryptoDir, { recursive: true });
    const files = [
      join(userDir, 'daily-snapshots.json'),
      join(userDir, 'equity-state.json'),
      join(userDir, 'trades-stocks.json'),
      join(userDir, 'trades-crypto.json'),
      join(cryptoDir, 'daily-snapshots.json'),
      join(cryptoDir, 'equity-state.json'),
    ];
    for (const f of files) writeFileSync(f, '{}', 'utf-8');
    // Drop both legacy unscoped files and TRA-244 per-mode subdir files so
    // the recursive cleanup is exercised end-to-end.
    const reportsDemo = join(userDir, 'reports', 'demo');
    const reportsLive = join(userDir, 'reports', 'live');
    const cryptoReportsDemo = join(userDir, 'crypto-reports', 'demo');
    mkdirSync(reportsDemo, { recursive: true });
    mkdirSync(reportsLive, { recursive: true });
    mkdirSync(cryptoReportsDemo, { recursive: true });
    const reportSubdirFiles = [
      join(userDir, 'reports', 'legacy.json'),
      join(reportsDemo, '2026-04-30.json'),
      join(reportsDemo, '2026-04-30.md'),
      join(reportsLive, '2026-04-30.json'),
      join(cryptoReportsDemo, '2026-05-01.json'),
    ];
    for (const f of reportSubdirFiles) writeFileSync(f, 'placeholder', 'utf-8');
    // A non-{json,md} file must be left alone — the cleanup is conservative
    // about what it deletes, mirroring TRA-241's `clearReportsDir` policy.
    const keepFile = join(reportsDemo, 'README.txt');
    writeFileSync(keepFile, 'keep me', 'utf-8');
    return {
      files,
      reportSubdirFiles: [...reportSubdirFiles, keepFile],
    };
  }

  it('wipes daily-snapshots, equity-state, trade history, and reports trees', async () => {
    const { files, reportSubdirFiles } = seedAliceData();

    await runTra301DemoFreshStart();

    for (const f of files) {
      expect(existsSync(f)).toBe(false);
    }
    // All report-tree json/md files removed; non-json file preserved.
    for (const f of reportSubdirFiles) {
      const isReportData = f.endsWith('.json') || f.endsWith('.md');
      expect(existsSync(f)).toBe(!isReportData);
    }
    expect(existsSync(join(TMP_ROOT, '.tra-301-demo-fresh-start'))).toBe(true);
  });

  it('is idempotent — second run is a no-op once the marker exists', async () => {
    seedAliceData();
    await runTra301DemoFreshStart();

    // Re-seed and confirm the marker prevents a second wipe.
    const dailySnap = join(TMP_ROOT, 'users', 'alice', 'daily-snapshots.json');
    writeFileSync(dailySnap, '{}', 'utf-8');
    await runTra301DemoFreshStart();
    expect(existsSync(dailySnap)).toBe(true);
  });

  it('handles users with no demo data gracefully (no throw, marker still written)', async () => {
    // alice's user dir is recreated empty in beforeEach.
    expect(existsSync(join(TMP_ROOT, '.tra-301-demo-fresh-start'))).toBe(false);
    await runTra301DemoFreshStart();
    expect(existsSync(join(TMP_ROOT, '.tra-301-demo-fresh-start'))).toBe(true);
  });
});

describe('runTra338MegaUsdCleanup — phantom MEGA-USD position cleanup', () => {
  function makeCryptoSnapWithGhost() {
    return {
      version: 1 as const,
      savedAt: '',
      openPositions: [
        // The phantom: Yahoo's frozen $4.04945 quote × 26.1 ≈ $105.71 cost
        // basis from TRA-337. Refund to cash on cleanup.
        {
          id: 'mega-1',
          symbol: 'MEGA-USD',
          side: 'buy' as const,
          signalType: 'bb_fade' as const,
          entryPrice: 4.04945,
          quantity: 26.1,
          stopLoss: 3.5,
          takeProfit: 5,
          openedAt: 1700000000000,
        },
        // Unrelated open position — must survive the cleanup untouched.
        {
          id: 'btc-1',
          symbol: 'BTC-USD',
          side: 'buy' as const,
          signalType: 'macd_trend' as const,
          entryPrice: 60_000,
          quantity: 0.05,
          stopLoss: 59_000,
          takeProfit: 62_000,
          openedAt: 1700000000000,
        },
      ],
      closedPositions: [],
      recentSignals: [],
      account: {
        cash: 18_000,
        equity: 25_000,
        initialEquity: 25_000,
        openingEquityToday: 25_000,
      },
    };
  }

  it('expunges open MEGA-USD positions and refunds cost basis to cash', async () => {
    await saveCryptoTradeSnapshot('alice', makeCryptoSnapWithGhost());

    await runTra338MegaUsdCleanup();

    const after = await loadCryptoTradeSnapshot('alice');
    expect(after).not.toBeNull();
    // Phantom is gone, the unrelated BTC-USD position survives.
    expect(after!.openPositions.find(p => p.symbol === 'MEGA-USD')).toBeUndefined();
    expect(after!.openPositions.find(p => p.symbol === 'BTC-USD')).toBeDefined();
    // Cash refunded by entryPrice × quantity (4.04945 × 26.1 ≈ 105.6907).
    expect(after!.account.cash).toBeCloseTo(18_000 + 4.04945 * 26.1, 4);
    // Equity not touched — engine reconciles equity from cash + MTM on next tick.
    expect(after!.account.equity).toBe(25_000);
    expect(existsSync(join(TMP_ROOT, '.tra-338-mega-usd-cleanup'))).toBe(true);
  });

  it('is idempotent — second run is a no-op once the marker exists', async () => {
    await saveCryptoTradeSnapshot('alice', makeCryptoSnapWithGhost());
    await runTra338MegaUsdCleanup();
    // Re-introduce a phantom and confirm a second run does not touch it.
    await saveCryptoTradeSnapshot('alice', makeCryptoSnapWithGhost());
    await runTra338MegaUsdCleanup();
    const after = await loadCryptoTradeSnapshot('alice');
    expect(after!.openPositions.find(p => p.symbol === 'MEGA-USD')).toBeDefined();
  });

  it('handles users without a crypto snapshot gracefully (no throw, marker still written)', async () => {
    expect(existsSync(join(TMP_ROOT, '.tra-338-mega-usd-cleanup'))).toBe(false);
    await runTra338MegaUsdCleanup();
    expect(existsSync(join(TMP_ROOT, '.tra-338-mega-usd-cleanup'))).toBe(true);
  });

  it('does nothing when the snapshot has no MEGA-USD position', async () => {
    const clean = makeCryptoSnapWithGhost();
    clean.openPositions = clean.openPositions.filter(p => p.symbol !== 'MEGA-USD');
    await saveCryptoTradeSnapshot('alice', clean);

    await runTra338MegaUsdCleanup();

    const after = await loadCryptoTradeSnapshot('alice');
    expect(after!.account.cash).toBe(18_000);
    expect(after!.openPositions).toHaveLength(1);
  });
});
