import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalEngine, sizeLiveEquityFromStop } from './signal-engine.js';
import type { RelativeValueScannerService, RelativeValueScanResult } from './relative-value-scanner.js';
import type { RelativeValueCandidate, TradierAccountBalance, TradierOptionsClient, TradierOrderClient } from '@trading-app/engine';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  isLiveTradierEquityEnabled,
  isLiveTradierOptionsEnabled,
  resolveLiveTradeEquitiesTradier,
  resolveLiveTradierMarkets,
} from '@trading-app/shared';
import type { AccountSettings, TradeSignal, TradierEnv } from '@trading-app/shared';

// Inside an ET trading window: 10:00 AM ET on a Tuesday → 14:00 UTC during EDT.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function makeCandidate(overrides: Partial<RelativeValueCandidate> = {}): RelativeValueCandidate {
  return {
    optionSymbol: 'AAPL240705C00200000',
    underlying: 'AAPL',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    daysToExpiration: 31,
    mark: 1.20,
    bid: 1.18,
    ask: 1.22,
    spreadPct: 0.033,
    volume: 200,
    openInterest: 800,
    ivUsed: 0.22,
    ivFitted: 0.30,
    ivResidual: -0.08,
    zScore: -2.4,
    fairPrice: 1.55,
    mispricingPct: -0.226,
    delta: 0.18,
    classification: 'cheap',
    score: 5.6,
    reason: 'IV residual 2.40σ below fitted skew',
    ...overrides,
  };
}

class StubScanner implements RelativeValueScannerService {
  scan = vi.fn<(symbol: string) => Promise<RelativeValueScanResult>>();
  getOptionMark = vi.fn<(symbol: string, expiration: string, optionSymbol: string) => Promise<number | null>>();
  diagnostics = vi.fn(() => ({
    configured: true,
    breakerOpen: false,
    breakerOpenedAtMs: null,
    cacheSize: 0,
    expirationsCacheSize: 0,
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SignalEngine — relative-value scanner bridge', () => {
  it('runRelativeValueScan opens an RV position from a `cheap` candidate and records a signal', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate()],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    const opened = state.options.openOptions[0];
    expect(opened.optionSymbol).toBe('AAPL240705C00200000');
    expect(opened.signalType).toBe('relative_value');
    expect(opened.premiumPaid).toBe(1.20);

    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].type).toBe('relative_value');
    expect(state.signals[0].symbol).toBe('AAPL');
  });

  it('also opens RV positions on below-intrinsic no-arb violations (a long-only signal)', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate({ classification: 'below_intrinsic', reason: 'mark below discounted intrinsic' })],
      reason: 'ok',
    });
    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().options.openOptions).toHaveLength(1);
  });

  it('skips when the scanner returns no cheap or below-intrinsic candidates', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate({ classification: 'expensive', mispricingPct: 0.30, zScore: 2.6 })],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(engine.getState().options.openOptions).toHaveLength(0);
    expect(engine.getState().signals).toHaveLength(0);
  });

  it('refreshOptionMarks pulls live marks for open RV positions', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate({ mark: 1.20 })],
      reason: 'ok',
    });
    scanner.getOptionMark.mockResolvedValue(0.85);

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().options.openOptions).toHaveLength(1);

    const marks = await (engine as unknown as { refreshOptionMarks: () => Promise<Map<string, number>> }).refreshOptionMarks();
    expect(marks.get('AAPL240705C00200000')).toBe(0.85);
    expect(scanner.getOptionMark).toHaveBeenCalledWith('AAPL', '2024-07-05', 'AAPL240705C00200000');
  });

  it('dedups subsequent scans on the same OCC within the 1h dedup window', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate()],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().signals).toHaveLength(1);

    vi.setSystemTime(TRADING_TIME + 10 * 60_000);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().signals).toHaveLength(1);
    expect(engine.getState().options.openOptions).toHaveLength(1);
  });
});

describe('SignalEngine — Tradier live balance surfacing (TRA-226)', () => {
  it('surfaces total_equity / total_cash from the cached Tradier balance in live mode', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    // Stub out the Tradier client and prime the cache so applySettings doesn't
    // need a real fetch. The internal field naming matches the source.
    const fakeClient = {
      getAccountBalance: vi.fn().mockResolvedValue({ totalEquity: 1234.56, totalCash: 200 }),
    } as unknown as TradierOptionsClient;
    (engine as unknown as { tradierLiveClient: TradierOptionsClient | null }).tradierLiveClient = fakeClient;
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    await (engine as unknown as { refreshTradierBalance: () => Promise<void> }).refreshTradierBalance();

    const state = engine.getState();
    expect(state.account.totalEquity).toBeCloseTo(1234.56);
    expect(state.account.availableCash).toBe(200);
    expect(state.account.openPositions).toEqual([]);
  });

  it('falls back to 0 in live mode when no Tradier balance has been fetched', () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';

    const state = engine.getState();
    expect(state.account.totalEquity).toBe(0);
    expect(state.account.availableCash).toBe(0);
  });

  it('clears the cached balance when leaving live mode', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number } | null }).liveTradierBalance = {
      totalEquity: 999,
      totalCash: 100,
    };

    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const internal = engine as unknown as { liveTradierBalance: unknown };
    expect(internal.liveTradierBalance).toBeNull();
  });
});

describe('SignalEngine — mode-scoped dashboard state (TRA-231)', () => {
  it('hides demo-mode options from the live dashboard view and vice versa', () => {
    const engine = new SignalEngine(
      { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', liveTradierEnvOptions: 'sandbox' },
    );
    const accounts = (engine as unknown as {
      optionsAccounts: Record<TradierEnv, {
        getState: () => { openOptions: Array<{ mode?: string }> };
        getStateForMode: (m: 'demo' | 'live') => { openOptions: Array<{ mode?: string }>; closedOptions: Array<{ mode?: string }> };
      }>;
    }).optionsAccounts;

    // Pre-seed both demo and live opens in the SAME (sandbox) bucket — this
    // is the exact leak path TRA-231 fixes: a single env bucket holding both
    // mode's positions before the `mode` stamp existed.
    const demoOpt: { id: string; symbol: string; optionType: 'call'; contracts: number; contractsRemaining: number; premiumPaid: number; currentPremium: number; tp1Premium: number; tp1Hit: boolean; stopLossPremium: number; peakPremium: number; trailingActive: boolean; trailingStopPremium: number; underlyingEntryPrice: number; openedAt: number; signalId: string; signalType: 'relative_value'; mode: 'demo' | 'live' } = {
      id: 'demo-1', symbol: 'AAPL', optionType: 'call', contracts: 1, contractsRemaining: 1,
      premiumPaid: 1, currentPremium: 1, tp1Premium: 1.25, tp1Hit: false, stopLossPremium: 0.75,
      peakPremium: 1, trailingActive: false, trailingStopPremium: 1.2, underlyingEntryPrice: 195,
      openedAt: Date.now(), signalId: 'sig-d', signalType: 'relative_value', mode: 'demo',
    };
    const liveOpt: typeof demoOpt = { ...demoOpt, id: 'live-1', signalId: 'sig-l', mode: 'live' };
    const sandboxState = (accounts.sandbox as unknown as { openOptions: Map<string, typeof demoOpt> });
    sandboxState.openOptions.set('demo-1', demoOpt);
    sandboxState.openOptions.set('live-1', liveOpt);

    // In demo mode, only the demo-stamped option surfaces.
    const demoState = engine.getState();
    expect(demoState.options.openOptions.map(o => o.id)).toEqual(['demo-1']);

    // Flip into live; only the live-stamped option surfaces.
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    const liveState = engine.getState();
    expect(liveState.options.openOptions.map(o => o.id)).toEqual(['live-1']);
  });

  it('scopes recentSignals to the active mode so a flip back to demo hides live signals', () => {
    const engine = new SignalEngine(
      { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' },
    );
    // Reach into the engine to seed both demo and live signals — exercising
    // the read path is sufficient; the doTick-time stamp is covered by the
    // RV scanner test below it.
    const internal = engine as unknown as { recentSignals: Array<{ id: string; mode?: 'demo' | 'live'; symbol: string; type: string; side: string; entryPrice: number; stopLoss: number; takeProfit: number; riskRewardRatio: number; timestamp: number }> };
    internal.recentSignals = [
      { id: 's-d', mode: 'demo', symbol: 'AAPL', type: 'orb', side: 'buy', entryPrice: 195, stopLoss: 190, takeProfit: 205, riskRewardRatio: 2, timestamp: Date.now() },
      { id: 's-l', mode: 'live', symbol: 'AAPL', type: 'relative_value', side: 'buy', entryPrice: 1.2, stopLoss: 0.9, takeProfit: 1.8, riskRewardRatio: 2, timestamp: Date.now() },
      { id: 's-legacy', symbol: 'AAPL', type: 'orb', side: 'buy', entryPrice: 195, stopLoss: 190, takeProfit: 205, riskRewardRatio: 2, timestamp: Date.now() },
    ];

    expect(engine.getState().signals.map(s => s.id).sort()).toEqual(['s-d', 's-legacy']);

    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    expect(engine.getState().signals.map(s => s.id)).toEqual(['s-l']);
  });
});

describe('SignalEngine — legacy options snapshot routing (TRA-237)', () => {
  it('legacy single-bucket options without a tradierEnv stamp restore into sandbox, not the engine\'s active env', () => {
    // Engine created with the user already on production env (the broken
    // pre-fix path attributed any pre-TRA-233 paper trades into the production
    // bucket, surfacing demo P&L in the Live Production header even when no
    // production order had ever been placed).
    const engine = new SignalEngine(
      { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live', liveTradierEnvOptions: 'production' },
    );
    expect((engine as unknown as { tradierEnv: TradierEnv }).tradierEnv).toBe('production');

    engine.importTradeSnapshot({
      closedPositions: [],
      recentSignals: [],
      dailySignals: [],
      positionSignalType: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0, openPositions: [] },
      // Legacy snapshot — no tradierEnv stamp, no optionsByEnv. These were the
      // sandbox-era trades from TRA-220.
      options: {
        openOptions: [],
        closedOptions: [],
        optionsPnl: 524.50,
        dailyCount: 10,
        currentDayKey: '2026-05-02',
        cash: 25_000,
        equity: 25_524.50,
      },
    });

    const accounts = (engine as unknown as { optionsAccounts: Record<TradierEnv, { getState: () => { optionsPnl: number; dailyOptionsCount: number } }> }).optionsAccounts;
    expect(accounts.sandbox.getState().optionsPnl).toBe(524.50);
    expect(accounts.sandbox.getState().dailyOptionsCount).toBe(10);
    expect(accounts.production.getState().optionsPnl).toBe(0);
    expect(accounts.production.getState().dailyOptionsCount).toBe(0);

    // The Live Production header reads the active env's bucket — it should
    // see the empty production bucket, not the legacy sandbox P&L.
    const state = engine.getState();
    expect(state.options.optionsPnl).toBe(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    expect(state.options.openOptions).toEqual([]);
  });

  it('legacy snapshot WITH a tradierEnv stamp still routes to that env', () => {
    const engine = new SignalEngine(
      { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live', liveTradierEnvOptions: 'sandbox' },
    );

    engine.importTradeSnapshot({
      closedPositions: [],
      recentSignals: [],
      dailySignals: [],
      positionSignalType: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0, openPositions: [] },
      options: {
        openOptions: [],
        closedOptions: [],
        optionsPnl: 100,
        dailyCount: 1,
        currentDayKey: '2026-05-02',
        cash: 25_000,
        equity: 25_100,
        // Stamp present — TRA-233 single-bucket persisted under the active env.
        tradierEnv: 'production',
      } as unknown as Parameters<typeof engine.importTradeSnapshot>[0]['options'],
    });

    const accounts = (engine as unknown as { optionsAccounts: Record<TradierEnv, { getState: () => { optionsPnl: number } }> }).optionsAccounts;
    expect(accounts.production.getState().optionsPnl).toBe(100);
    expect(accounts.sandbox.getState().optionsPnl).toBe(0);
  });
});

// ─── TRA-319 — live RV mirror reconciles Tradier rejections ─────────────────
// The unit tests cover voidOpenOption / waitForOrderTerminalStatus / the new
// optionBuyingPower extraction in isolation. These tests close the loop on
// the signal-engine wiring itself: when Tradier rejects the mirrored order,
// the dashboard must NOT show a phantom open and the daily slot must NOT be
// consumed. This is the integration substitute for the Tradier sandbox
// verification on a low-buying-power account.
describe('SignalEngine — TRA-319 live RV mirror reconciliation', () => {
  type WaitOpts = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
  interface TradierLiveStub {
    getAccountBalance: ReturnType<typeof vi.fn>;
    buyContracts: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
    sellContracts?: ReturnType<typeof vi.fn>;
  }

  function setupLiveEngine(stub: TradierLiveStub, scanner: StubScanner) {
    const engine = new SignalEngine(undefined, undefined, scanner);
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    return engine;
  }

  function freshScanner(): StubScanner {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate({ mark: 1.20 })],
      reason: 'ok',
    });
    return scanner;
  }

  it('voids the paper open, surfaces a skip-reason signal, and frees the slot when Tradier ends in canceled', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 1000, totalCash: 300, optionBuyingPower: 999_999,
      }),
      buyContracts: vi.fn().mockResolvedValue({ id: 7, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 7, status: 'canceled', reason_description: 'insufficient buying power',
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // Prime a balance so live-mode sizing has equity to work with. OBP is
    // intentionally inflated so the pre-checks pass and the test exercises
    // the post-submit reconciliation path.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 1000, totalCash: 300, optionBuyingPower: 999_999,
    };
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // The mirror DID submit (we only know it's bad after Tradier reconciles).
    expect(stub.buyContracts).toHaveBeenCalledTimes(1);
    expect(stub.waitForOrderTerminalStatus).toHaveBeenCalledTimes(1);

    const state = engine.getState();
    // No phantom row in the live-mode dashboard.
    expect(state.options.openOptions).toHaveLength(0);
    // Slot was reverted (this is the user-visible bug — losing daily slots
    // to trades the broker never accepted).
    expect(state.options.dailyOptionsCount).toBe(0);
    // No closed-options leak — voidOpenOption is NOT closeOption.
    expect(state.options.closedOptions).toHaveLength(0);
    expect(state.options.optionsPnl).toBe(0);
    // TRA-332 — the Signals panel now surfaces the rejected signal with a
    // liveSkipReason so the user can see the diagnosis instead of mining logs.
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toContain('canceled');
    expect(state.signals[0].liveSkipReason).toContain('insufficient buying power');
  });

  it('skips the order entirely when cached optionBuyingPower is below notional cost (TRA-332 surfaces it on the dashboard)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      buyContracts: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // TRA-332: with a $50 OBP and the default RV budget ratio, the engine's
    // own pre-check (live budget < cost-per-contract) trips before any broker
    // call. Surfaces a skip-reason signal so the user sees what happened.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 100, totalCash: 50, optionBuyingPower: 50,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // Pre-check fired — we never bothered the broker.
    expect(stub.buyContracts).not.toHaveBeenCalled();
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    // TRA-332 — surfaces the skip on the dashboard so the user sees the diagnosis.
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].mode).toBe('live');
    expect(state.signals[0].liveSkipReason).toContain('budget');
  });

  it('voids the paper open and surfaces a skip signal when the buyContracts call itself throws (network/auth failure)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      buyContracts: vi.fn().mockRejectedValue(new Error('Tradier 401 unauthorized')),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // Prime a balance with enough OBP to clear the pre-checks so this test
    // exercises the catch-block void path.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    // TRA-332 — surface the broker-throw reason on the dashboard.
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toContain('Tradier live buy threw');
    // We never reached the polling step.
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();
  });

  it('keeps the paper open and records the signal on the happy path (Tradier filled)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
      }),
      buyContracts: vi.fn().mockResolvedValue({ id: 11, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 11, status: 'filled', exec_quantity: 1, avg_fill_price: 1.20,
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(stub.buyContracts).toHaveBeenCalledTimes(1);
    expect(stub.waitForOrderTerminalStatus).toHaveBeenCalledTimes(1);

    const state = engine.getState();
    // No-regression check on the happy path: the position survives, the
    // daily slot is consumed, and the Signals panel surfaces the entry.
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].optionSymbol).toBe('AAPL240705C00200000');
    expect(state.options.dailyOptionsCount).toBe(1);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].type).toBe('relative_value');
  });

  it('keeps the paper open when Tradier never reaches a terminal state within the wait window (treats as live, lets the periodic balance poll catch any drift)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
      }),
      buyContracts: vi.fn().mockResolvedValue({ id: 13, status: 'ok' }),
      // Returns a non-terminal final detail (waitFor… exhausted its window).
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 13, status: 'pending',
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // Prime balance so the new TRA-332 pre-checks pass.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
    };
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    const state = engine.getState();
    // Pending is NOT in the rejected set — we conservatively keep the paper
    // open and let the next periodic Tradier balance poll surface drift.
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.dailyOptionsCount).toBe(1);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toBeUndefined();
  });
});

// ─── TRA-332 — live sizing reads the user's REAL Tradier equity ────────────
// Bug: PaperOptionsAccount is seeded from demo equity ($25 K default) and
// never rebased on a live flip. Sizing produced contracts a $300 cash account
// could never afford, TRA-319's pre-check voided every signal, and the user
// saw nothing on the dashboard. These tests lock in the fix:
//   • position size in live mode comes from `liveTradierBalance.optionBuyingPower`
//     / `totalEquity`, not the stale paper equity
//   • when even one contract won't fit, surface a clear `liveSkipReason` on
//     the dashboard so the user can self-diagnose
describe('SignalEngine — TRA-332 live sizing uses real Tradier equity', () => {
  type WaitOpts = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
  interface TradierLiveStub {
    getAccountBalance: ReturnType<typeof vi.fn>;
    buyContracts: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }

  function setupLiveEngine(stub: TradierLiveStub, scanner: StubScanner) {
    const engine = new SignalEngine(undefined, undefined, scanner);
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    return engine;
  }

  function freshScanner(mark = 1.20): StubScanner {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate({ mark })],
      reason: 'ok',
    });
    return scanner;
  }

  it('surfaces a budget-too-small skip signal for a $300 cash account (the original TRA-332 report)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      buyContracts: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEngine(stub, freshScanner(1.20));
    // The exact balance the user reported on TRA-332 — a Tradier cash account
    // with $300 available. Default RV budget = 300 * 0.5 * 0.03 = $4.50,
    // far below the $120 cost-per-contract; engine must skip with a reason.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 300, totalCash: 300, optionBuyingPower: 300,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(stub.buyContracts).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    // The dashboard now shows the user WHY their account isn't trading.
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].mode).toBe('live');
    expect(state.signals[0].liveSkipReason).toContain('budget $4.50');
    expect(state.signals[0].liveSkipReason).toContain('$120.00/contract');
  });

  it('sizes positions off live Tradier equity, not the stale paper equity', async () => {
    // Mark = $1 → 1 contract = $100 notional.
    // Live equity = $1,000 → live RV budget = 1000 * 0.5 * 0.03 = $15 (still
    // too small for 1 contract). Without the live override, paper equity
    // ($25 K demo default) would size 3 contracts and TRA-319 would void
    // them silently — the regression we're fixing.
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      buyContracts: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEngine(stub, freshScanner(1.0));
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 1000, totalCash: 1000, optionBuyingPower: 1000,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // No order submitted — pre-check tripped on the LIVE budget, not the
    // paper-account budget. This is the lock-in: if the engine reverted to
    // paper-equity sizing the pre-check would pass and buyContracts would
    // fire, repeating the original silent-void bug.
    expect(stub.buyContracts).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toContain('budget');
  });

  it('opens a sized position when live equity is sufficient (regression check on the override path)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      buyContracts: vi.fn().mockResolvedValue({ id: 21, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 21, status: 'filled',
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner(1.0));
    // $50 K live equity → RV budget = $750 → 7 contracts at $100 each.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 50_000, totalCash: 50_000, optionBuyingPower: 50_000,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(stub.buyContracts).toHaveBeenCalledTimes(1);
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].contracts).toBe(7);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toBeUndefined();
  });

  it('falls back to paper equity when tradierLiveOptionsEnabled is false (TRA-357 defense-in-depth gate)', async () => {
    // Equity-only mode (liveTradierMarkets: 'equity'). The scan-level skip at
    // line ~887 normally prevents the RV path from running; this test pokes
    // `runRelativeValueScan` directly to lock in that the sizing path also
    // ignores the live balance when options routing is disabled. Without the
    // gate the engine would surface a budget-too-small skip for a $300
    // balance even though the user opted out of options routing entirely.
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      buyContracts: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEngine(stub, freshScanner(1.0));
    (engine as unknown as { tradierLiveOptionsEnabled: boolean }).tradierLiveOptionsEnabled = false;
    // Tiny live balance that WOULD trip the live-budget skip if honored.
    // With the gate, sizing falls back to the $25 K paper equity instead.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 300, totalCash: 300, optionBuyingPower: 300,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // Paper equity sizing produces contracts (25000 * 0.5 * 0.03 = $375 budget
    // → 3 contracts at $100 each). No live-budget skip surfaces. The buy
    // mirror is also gated on `tradierLiveOptionsEnabled` (TRA-355) so the
    // broker call never fires.
    expect(stub.buyContracts).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].contracts).toBe(3);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toBeUndefined();
  });

  it('falls back to optionBuyingPower over totalEquity when both are present (cash account semantics)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      buyContracts: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEngine(stub, freshScanner(1.0));
    // Owned positions could push totalEquity above optionBuyingPower (e.g.,
    // unsettled cash). Sizing must respect the tighter constraint (OBP) so
    // we don't submit an order Tradier will cancel for unsettled funds.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 50_000, totalCash: 50_000, optionBuyingPower: 200,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // OBP = $200 → budget $3 → 0 contracts. Without the OBP preference this
    // would size off totalEquity ($50 K) and submit a doomed order.
    expect(stub.buyContracts).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toContain('equity $200.00');
  });
});

// TRA-336 / TRA-370 — `liveTradierMarkets` is the user-facing tri-state for
// "what should Tradier Live trade" (Options / Positions / Both). TRA-370
// flipped the absent-field default from 'options' to 'both' so a Live account
// mirrors Demo's signal flow (equity + options) out of the box. Users can
// still pick 'options' or 'equity' explicitly in Settings to narrow routing.
describe('shared/AccountSettings — TRA-336 liveTradierMarkets resolvers', () => {
  function withMarkets(markets: AccountSettings['liveTradierMarkets']): AccountSettings {
    return { ...DEFAULT_ACCOUNT_SETTINGS, liveTradierMarkets: markets };
  }

  it("defaults to 'both' (TRA-370) so absent saved settings mirror Demo's signal flow", () => {
    const s: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS };
    delete s.liveTradierMarkets;
    expect(resolveLiveTradierMarkets(s)).toBe('both');
    expect(isLiveTradierOptionsEnabled(s)).toBe(true);
    expect(isLiveTradierEquityEnabled(s)).toBe(true);
  });

  it("'options' enables only the options mirror", () => {
    const s = withMarkets('options');
    expect(isLiveTradierOptionsEnabled(s)).toBe(true);
    expect(isLiveTradierEquityEnabled(s)).toBe(false);
  });

  it("'equity' enables only the equity path (suppresses options mirror)", () => {
    const s = withMarkets('equity');
    expect(isLiveTradierOptionsEnabled(s)).toBe(false);
    expect(isLiveTradierEquityEnabled(s)).toBe(true);
  });

  it("'both' enables options mirror AND equity path", () => {
    const s = withMarkets('both');
    expect(isLiveTradierOptionsEnabled(s)).toBe(true);
    expect(isLiveTradierEquityEnabled(s)).toBe(true);
  });
});

// TRA-370 — Demo and Live (production) should fire the same signals and trade
// both equity positions AND options out of the box. The defaults + resolver
// fallbacks below are the wire-level contract that makes that true; pin them
// so a future change to TRA-336 routing doesn't silently regress a Live
// account back to options-only or equity-only behaviour.
describe('shared/AccountSettings — TRA-370 Live/Demo parity defaults', () => {
  it("DEFAULT_ACCOUNT_SETTINGS routes Live to BOTH equity + options", () => {
    expect(DEFAULT_ACCOUNT_SETTINGS.liveTradierMarkets).toBe('both');
    expect(DEFAULT_ACCOUNT_SETTINGS.liveTradeEquitiesTradier).toBe(true);
  });

  it("absent liveTradierMarkets resolves to 'both' so Live mirrors Demo's signal flow", () => {
    const s: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS };
    delete s.liveTradierMarkets;
    expect(resolveLiveTradierMarkets(s)).toBe('both');
    expect(isLiveTradierOptionsEnabled(s)).toBe(true);
    expect(isLiveTradierEquityEnabled(s)).toBe(true);
  });

  it("absent liveTradeEquitiesTradier resolves to true so Live opens equity brackets out of the box", () => {
    const s: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS };
    delete s.liveTradeEquitiesTradier;
    expect(resolveLiveTradeEquitiesTradier(s)).toBe(true);
  });

  it("explicit liveTradeEquitiesTradier === false still opts out (user-facing override survives)", () => {
    const s: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS, liveTradeEquitiesTradier: false };
    expect(resolveLiveTradeEquitiesTradier(s)).toBe(false);
  });
});

describe('SignalEngine — TRA-336 markets-selector gate', () => {
  // The flag the doTick gate consults. Confirms the engine reflects the
  // user's selection at construction and after applySettings — flipping
  // the tri-state must take effect on the next tick without a restart.
  it("constructs with tradierLiveOptionsEnabled === true under the default ('both', TRA-370)", () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' });
    expect(
      (engine as unknown as { tradierLiveOptionsEnabled: boolean }).tradierLiveOptionsEnabled,
    ).toBe(true);
  });

  it("constructs with tradierLiveOptionsEnabled === false under 'equity'", () => {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradierMarkets: 'equity',
    });
    expect(
      (engine as unknown as { tradierLiveOptionsEnabled: boolean }).tradierLiveOptionsEnabled,
    ).toBe(false);
  });

  it("applySettings flips tradierLiveOptionsEnabled when the user changes 'options' → 'equity' → 'both'", async () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' });
    const flag = () =>
      (engine as unknown as { tradierLiveOptionsEnabled: boolean }).tradierLiveOptionsEnabled;
    expect(flag()).toBe(true);

    await engine.applySettings({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradierMarkets: 'equity',
    });
    expect(flag()).toBe(false);

    await engine.applySettings({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradierMarkets: 'both',
    });
    expect(flag()).toBe(true);
  });

  // The actual doTick gate skips the RV scan in live mode when the markets
  // selector excludes options. We exercise the same condition the gate
  // checks rather than spinning up the full doTick (which needs Yahoo
  // fetchQuotes / news mocks to run).
  it('the live equity-only condition (mode=live ∧ !optionsEnabled) is true under equity-only and false otherwise', () => {
    const settings = (markets: AccountSettings['liveTradierMarkets']): AccountSettings => ({
      ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live', liveTradierMarkets: markets,
    });
    const skip = (s: AccountSettings) => s.mode === 'live' && !isLiveTradierOptionsEnabled(s);

    expect(skip(settings('options'))).toBe(false);
    expect(skip(settings('equity'))).toBe(true);
    expect(skip(settings('both'))).toBe(false);

    // Demo mode is unaffected — `liveTradierMarkets` is a live-only switch.
    const demoEquityOnly: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      liveTradierMarkets: 'equity',
    };
    expect(skip(demoEquityOnly)).toBe(false);
  });
});

// ─── TRA-335 — Tradier Live equity bracket trading ─────────────────────────
// Reverses TRA-220 for equities: when liveTradeEquitiesTradier is on AND
// Tradier creds are saved AND mode === 'live', BB-fade / ORB / Ichimoku
// entries fire as Tradier OTOCO bracket orders against the same Tradier
// account that powers options. These tests cover the placement + sizing +
// manual-close paths in isolation; the runTick wiring is exercised
// indirectly via the live equity gate in the open-loop dedup test.
describe('sizeLiveEquityFromStop (TRA-335)', () => {
  function balance(overrides: Partial<TradierAccountBalance> = {}): TradierAccountBalance {
    return {
      totalEquity: 25_000,
      totalCash: 10_000,
      optionBuyingPower: 10_000,
      stockBuyingPower: 20_000,
      longMarketValue: 15_000,
      ...overrides,
    };
  }

  it('sizes off (cash + LMV) × ratio × risk and floors to whole shares', () => {
    const qty = sizeLiveEquityFromStop({
      balance: balance(),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    });
    // managedEquity = 25000 * 0.5 = 12500. maxRisk = 12500 * 0.01 = 125.
    // dist = 5 → riskQty = floor(125/5) = 25.
    // equityCap = floor(12500/100) = 125. stockBP cap = floor(20000/100) = 200.
    // min(25, 125, 200) = 25.
    expect(qty).toBe(25);
  });

  it('caps qty by stockBuyingPower when cash + LMV would otherwise allow more', () => {
    const qty = sizeLiveEquityFromStop({
      balance: balance({ stockBuyingPower: 500 }),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.10,
      entryPrice: 50,
      stopPrice: 49,
      currentPrice: 50,
    });
    // managedEquity = 12500. maxRisk = 1250. dist = 1 → riskQty = 1250.
    // equityCap = 250. stockBP cap = floor(500/50) = 10. min = 10.
    expect(qty).toBe(10);
  });

  it('returns 0 when stop equals entry (zero risk distance)', () => {
    expect(sizeLiveEquityFromStop({
      balance: balance(),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 100,
      currentPrice: 100,
    })).toBe(0);
  });

  it('returns 0 when totalCash + LMV is non-positive', () => {
    expect(sizeLiveEquityFromStop({
      balance: balance({ totalCash: 0, longMarketValue: 0 }),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    })).toBe(0);
  });

  it('falls back to totalCash alone when longMarketValue is null', () => {
    const qty = sizeLiveEquityFromStop({
      balance: balance({ longMarketValue: null }),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    });
    // managedEquity = 10000 * 0.5 = 5000. maxRisk = 50. riskQty = floor(50/5) = 10.
    expect(qty).toBe(10);
  });

  it('skips the buying-power cap when stockBuyingPower is null (cash account fallback)', () => {
    const qty = sizeLiveEquityFromStop({
      balance: balance({ stockBuyingPower: null, totalCash: 5_000, longMarketValue: 0 }),
      managedAccountRatio: 1.0,
      riskPerTrade: 0.05,
      entryPrice: 50,
      stopPrice: 45,
      currentPrice: 50,
    });
    // managedEquity = 5000. maxRisk = 250. riskQty = floor(250/5) = 50.
    // equityCap = floor(5000/50) = 100. min = 50. No SBP cap applied.
    expect(qty).toBe(50);
  });
});

describe('SignalEngine — TRA-335 live equity bracket placement', () => {
  type WaitOpts = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
  interface TradierEquityStub {
    submitBracketOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
    cancelOrder?: ReturnType<typeof vi.fn>;
  }

  function bbSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
    return {
      id: 'sig-1',
      symbol: 'AAPL',
      type: 'bb_fade',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      riskRewardRatio: 2,
      timestamp: Date.now(),
      ...overrides,
    };
  }

  function setupLiveEquityEngine(stub: TradierEquityStub) {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradeEquitiesTradier: true,
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
    });
    (engine as unknown as { tradierLiveEquityClient: unknown }).tradierLiveEquityClient = stub;
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance = {
      totalEquity: 25_000,
      totalCash: 10_000,
      optionBuyingPower: 10_000,
      stockBuyingPower: 20_000,
      longMarketValue: 15_000,
    };
    return engine;
  }

  it('placeTradierEquityBracket submits an OTOCO with the sized qty + entry/TP/SL legs and returns ok on a non-rejected Tradier response', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 42, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _o?: WaitOpts) => ({
        id: 42, status: 'filled', exec_quantity: 25, avg_fill_price: 100,
      })),
    };
    const engine = setupLiveEquityEngine(stub);

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number | string; reason?: string }>
    }).placeTradierEquityBracket(bbSignal(), 100);

    expect(result.ok).toBe(true);
    expect(result.orderId).toBe(42);
    expect(stub.submitBracketOrder).toHaveBeenCalledTimes(1);
    expect(stub.submitBracketOrder).toHaveBeenCalledWith({
      symbol: 'AAPL', qty: 25, side: 'buy',
      limitPrice: 100, takeProfitPrice: 110, stopLossPrice: 95,
    });
  });

  it('returns ok:false with a reason when Tradier ends in canceled (e.g. insufficient buying power)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 99, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async () => ({
        id: 99, status: 'canceled', reason_description: 'insufficient buying power',
      })),
    };
    const engine = setupLiveEquityEngine(stub);

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number; reason?: string }>
    }).placeTradierEquityBracket(bbSignal(), 100);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('canceled');
    expect(result.reason).toContain('insufficient buying power');
  });

  it('returns ok:false when the broker call throws (network/auth failure) — never opens a phantom position', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockRejectedValue(new Error('Tradier 401 unauthorized')),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEquityEngine(stub);

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; reason?: string }>
    }).placeTradierEquityBracket(bbSignal(), 100);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Tradier 401 unauthorized');
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();
  });

  it('returns ok:false when the cached Tradier balance is missing (engine refuses to size against an unknown balance)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEquityEngine(stub);
    (engine as unknown as { liveTradierBalance: TradierAccountBalance | null }).liveTradierBalance = null;

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; reason?: string }>
    }).placeTradierEquityBracket(bbSignal(), 100);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('balance');
    expect(stub.submitBracketOrder).not.toHaveBeenCalled();
  });

  it('manualClosePosition on a live equity position drops the position locally, marks pnl, and kicks off the Tradier OCO cancel for the entry order', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
    };
    const engine = setupLiveEquityEngine(stub);

    // Seed a live equity open by calling the mirror helper.
    const sig = bbSignal();
    const pos = (engine as unknown as {
      openLiveEquityMirror: (s: TradeSignal, p: number, oid: number | string) => { id: string } | null;
    }).openLiveEquityMirror(sig, 100, 42);
    expect(pos).not.toBeNull();
    expect(engine.getState().account.openPositions).toHaveLength(1);

    const closed = engine.manualClosePosition(pos!.id, 105);
    expect(closed).not.toBeNull();
    expect(closed!.exitPrice).toBe(105);
    // pnl = (105 - 100) × 25 × 1 = 125 for a 25-share BUY.
    expect(closed!.pnl).toBe(125);
    // The live store no longer holds the position even before the
    // fire-and-forget broker close completes — the dashboard reflects
    // the close immediately.
    expect(engine.getState().account.openPositions).toHaveLength(0);

    // Flush microtasks queued by the fire-and-forget close path
    // (closeTradierEquityPosition awaits cancelOrder before issuing the
    // market-sell HTTP call). Awaiting a Promise.resolve cycle lets
    // cancelOrder's mock be invoked before the assertion below.
    await Promise.resolve();
    await Promise.resolve();
    expect(stub.cancelOrder).toHaveBeenCalledWith(42);
  });
});

describe('buildTradierLiveEquityClient gating (TRA-335)', () => {
  it('returns null when liveTradeEquitiesTradier is false even with full live creds', () => {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradeEquitiesTradier: false,
      liveApiKeyOptionsSandbox: 'tok',
      liveAccountIdOptionsSandbox: 'A1',
      liveTradierEnvOptions: 'sandbox',
    });
    const client = (engine as unknown as { tradierLiveEquityClient: TradierOrderClient | null }).tradierLiveEquityClient;
    expect(client).toBeNull();
  });

  it('returns a client when toggle is on AND creds are saved', () => {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradeEquitiesTradier: true,
      liveApiKeyOptionsSandbox: 'tok',
      liveAccountIdOptionsSandbox: 'A1',
      liveTradierEnvOptions: 'sandbox',
    });
    const client = (engine as unknown as { tradierLiveEquityClient: TradierOrderClient | null }).tradierLiveEquityClient;
    expect(client).not.toBeNull();
  });

  it('returns null in demo mode regardless of toggle', () => {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      liveTradeEquitiesTradier: true,
      liveApiKeyOptionsSandbox: 'tok',
      liveAccountIdOptionsSandbox: 'A1',
    });
    const client = (engine as unknown as { tradierLiveEquityClient: TradierOrderClient | null }).tradierLiveEquityClient;
    expect(client).toBeNull();
  });
});

// TRA-352 follow-up — end-to-end test of the pending-close reconciler the
// board asked us to add. Drives the engine's `reconcilePendingCloses` against
// stub Tradier clients for each env and asserts that the matching open row
// is filled / cleared / left pending based on the broker's status.
describe('SignalEngine — TRA-352 pending-close reconciler', () => {
  interface OrderStatusStub {
    getOrderStatus: ReturnType<typeof vi.fn>;
  }
  interface OptionsAcctStub {
    openOptionFromCandidate(sig: unknown, mode: 'live'): { id: string } | null;
    setPendingCloseOrderId(id: string, orderId: number): boolean;
    getState(): {
      openOptions: Array<{ id: string; pendingCloseOrderId?: number | string }>;
      closedOptions: Array<{ id: string; currentPremium: number; pnl?: number }>;
    };
  }
  type EngineInternals = {
    tradierOptionsClientByEnv: Record<TradierEnv, unknown>;
    optionsAccounts: Record<TradierEnv, OptionsAcctStub>;
  };

  function asInternals(engine: SignalEngine): EngineInternals {
    return engine as unknown as EngineInternals;
  }

  function setupEngine(stubs: { sandbox?: OrderStatusStub; production?: OrderStatusStub }) {
    const engine = new SignalEngine();
    asInternals(engine).tradierOptionsClientByEnv = {
      sandbox: stubs.sandbox ?? null,
      production: stubs.production ?? null,
    };
    return engine;
  }

  function openLiveEngineRow(
    engine: SignalEngine,
    env: TradierEnv,
    overrides: { symbol?: string; optionSymbol?: string } = {},
  ): { optionId: string; orderId: number } {
    const acct = asInternals(engine).optionsAccounts[env];
    const opened = acct.openOptionFromCandidate(
      {
        id: 'sig',
        symbol: overrides.symbol ?? 'AAPL',
        type: 'otm_mispricing',
        side: 'buy',
        entryPrice: 1.0,
        stopLoss: 0.75,
        takeProfit: 1.5,
        riskRewardRatio: 2,
        timestamp: TRADING_TIME,
        optionSymbol: overrides.optionSymbol ?? 'AAPL240705C00200000',
        optionType: 'call',
        strike: 200,
        expiration: '2024-07-05',
        mark: 1.0,
        theo: 1.3,
        mispricingPct: -0.23,
        delta: 0.18,
      },
      'live',
    );
    if (!opened) throw new Error('test setup: failed to open option');
    const orderId = Math.floor(Math.random() * 1_000_000) + 1;
    acct.setPendingCloseOrderId(opened.id, orderId);
    return { optionId: opened.id, orderId };
  }

  it('closes the engine-opened local row at the broker avg_fill_price when Tradier reports filled', async () => {
    const stub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({ id: 1, status: 'filled', avg_fill_price: 1.45 })),
    };
    const engine = setupEngine({ sandbox: stub });
    const { optionId } = openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcilePendingCloses();

    expect(summary.filled).toBe(1);
    expect(summary.cleared).toBe(0);
    // Read directly off the per-env account so the live-vs-demo getState mode
    // scoping doesn't hide the closed row. We're testing the reconciler's
    // mutation, not the public dashboard mask.
    const sandboxState = asInternals(engine).optionsAccounts.sandbox.getState();
    expect(sandboxState.openOptions.find(o => o.id === optionId)).toBeUndefined();
    const closed = sandboxState.closedOptions.find(o => o.id === optionId);
    expect(closed).toBeDefined();
    // Closed at the broker avg fill price, NOT the local mark.
    expect(closed?.currentPremium).toBeCloseTo(1.45, 5);
  });

  it('clears pendingCloseOrderId on a terminal non-fill so the user can re-click Close', async () => {
    const stub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({
        id: 1,
        status: 'canceled',
        reason_description: 'user cancelled on Tradier',
      })),
    };
    const engine = setupEngine({ sandbox: stub });
    const { optionId } = openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcilePendingCloses();

    expect(summary.cleared).toBe(1);
    expect(summary.filled).toBe(0);
    const stillOpen = asInternals(engine).optionsAccounts.sandbox
      .getState()
      .openOptions.find(o => o.id === optionId);
    expect(stillOpen).toBeDefined();
    expect(stillOpen?.pendingCloseOrderId).toBeUndefined();
  });

  it('leaves rows pending when the broker still reports open / pending', async () => {
    const stub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({ id: 1, status: 'open' })),
    };
    const engine = setupEngine({ sandbox: stub });
    const { optionId, orderId } = openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcilePendingCloses();

    expect(summary.stillPending).toBe(1);
    const stillOpen = asInternals(engine).optionsAccounts.sandbox
      .getState()
      .openOptions.find(o => o.id === optionId);
    // pendingCloseOrderId survives so the dashboard still shows "Pending #N".
    expect(stillOpen?.pendingCloseOrderId).toBe(orderId);
  });

  it('skips reconciliation for an env that has no Tradier client configured', async () => {
    const sandboxStub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({ id: 1, status: 'filled', avg_fill_price: 1.20 })),
    };
    // No production client — only sandbox creds saved.
    const engine = setupEngine({ sandbox: sandboxStub });
    const { optionId: sandboxId } = openLiveEngineRow(engine, 'sandbox');
    const { optionId: prodId } = openLiveEngineRow(engine, 'production', {
      optionSymbol: 'MSFT240705C00400000',
    });

    const summary = await engine.reconcilePendingCloses();

    expect(summary.filled).toBe(1);
    expect(summary.noClient).toBe(1);
    const states = asInternals(engine).optionsAccounts;
    // Sandbox row filled, production row still pending until creds are saved.
    expect(states.sandbox.getState().openOptions.find(o => o.id === sandboxId)).toBeUndefined();
    const prodRow = states.production.getState().openOptions.find(o => o.id === prodId);
    expect(prodRow?.pendingCloseOrderId).toBeDefined();
  });

  it('reconciles BOTH envs in a single sweep so cross-env pending closes resolve together', async () => {
    const sandboxStub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({ id: 1, status: 'filled', avg_fill_price: 1.30 })),
    };
    const prodStub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({
        id: 2,
        status: 'expired',
        reason_description: 'EOD expiration',
      })),
    };
    const engine = setupEngine({ sandbox: sandboxStub, production: prodStub });
    const { optionId: sandboxId } = openLiveEngineRow(engine, 'sandbox');
    const { optionId: prodId } = openLiveEngineRow(engine, 'production', {
      optionSymbol: 'MSFT240705C00400000',
    });

    const summary = await engine.reconcilePendingCloses();

    expect(summary.filled).toBe(1);
    expect(summary.cleared).toBe(1);
    // Sandbox closed via fill, production re-opened with cleared pending tag.
    const states = asInternals(engine).optionsAccounts;
    expect(states.sandbox.getState().openOptions.find(o => o.id === sandboxId)).toBeUndefined();
    const prodRow = states.production.getState().openOptions.find(o => o.id === prodId);
    expect(prodRow).toBeDefined();
    expect(prodRow?.pendingCloseOrderId).toBeUndefined();
  });

  it('survives a getOrderStatus throw without aborting the rest of the sweep', async () => {
    const sandboxStub: OrderStatusStub = {
      // Throws on first call, succeeds on second — the helper swallows the
      // throw into an `unknown` outcome so the second row still reconciles.
      getOrderStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error('socket reset'))
        .mockResolvedValueOnce({ id: 99, status: 'filled', avg_fill_price: 1.10 }),
    };
    const engine = setupEngine({ sandbox: sandboxStub });
    openLiveEngineRow(engine, 'sandbox');
    const { optionId: secondId } = openLiveEngineRow(engine, 'sandbox', {
      optionSymbol: 'AAPL240705C00250000',
    });

    const summary = await engine.reconcilePendingCloses();

    // First row: unknown → stillPending. Second row: filled.
    expect(summary.filled).toBe(1);
    expect(summary.stillPending).toBe(1);
    expect(
      asInternals(engine).optionsAccounts.sandbox.getState().openOptions.find(o => o.id === secondId),
    ).toBeUndefined();
  });
});

// TRA-356 — periodic portfolio reconcile while live mode is active. The
// engine pulls Tradier's open positions on a cadence and feeds them
// through the existing `reconcileTradierPositions` rules so manual
// Tradier-side actions flow back into local state without a button press.
// These tests drive `reconcileLivePortfolio` directly so we can assert
// the skip / fetch / dedupe behaviours without standing up a full tick.
describe('SignalEngine — TRA-356 periodic portfolio reconcile', () => {
  interface ListPositionsStub {
    listOpenOptionPositions: ReturnType<typeof vi.fn>;
  }
  type EngineInternals = {
    tradierOptionsClientByEnv: Record<TradierEnv, unknown>;
    optionsAccounts: Record<TradierEnv, {
      openOptionFromCandidate(sig: unknown, mode: 'live'): { id: string } | null;
      getStateForMode(mode: 'demo' | 'live'): { openOptions: Array<{ id: string }> };
    }>;
    mode: 'demo' | 'live';
    tradierEnv: TradierEnv;
    lastTradierPortfolioReconcileAt: number;
  };

  function asInternals(engine: SignalEngine): EngineInternals {
    return engine as unknown as EngineInternals;
  }

  function setupEngine(opts: {
    mode?: 'demo' | 'live';
    env?: TradierEnv;
    client?: ListPositionsStub | null;
  } = {}) {
    const engine = new SignalEngine();
    const internals = asInternals(engine);
    internals.mode = opts.mode ?? 'live';
    const env = opts.env ?? 'sandbox';
    internals.tradierEnv = env;
    internals.tradierOptionsClientByEnv = {
      sandbox: env === 'sandbox' ? (opts.client ?? null) : null,
      production: env === 'production' ? (opts.client ?? null) : null,
    };
    return engine;
  }

  function openLiveEngineRow(
    engine: SignalEngine,
    env: TradierEnv,
    overrides: { symbol?: string; optionSymbol?: string } = {},
  ): { optionId: string } {
    const acct = asInternals(engine).optionsAccounts[env];
    const opened = acct.openOptionFromCandidate(
      {
        id: 'sig',
        symbol: overrides.symbol ?? 'AAPL',
        type: 'otm_mispricing',
        side: 'buy',
        entryPrice: 1.0,
        stopLoss: 0.75,
        takeProfit: 1.5,
        riskRewardRatio: 2,
        timestamp: TRADING_TIME,
        optionSymbol: overrides.optionSymbol ?? 'AAPL240705C00200000',
        optionType: 'call',
        strike: 200,
        expiration: '2024-07-05',
        mark: 1.0,
        theo: 1.3,
        mispricingPct: -0.23,
        delta: 0.18,
      },
      'live',
    );
    if (!opened) throw new Error('test setup: failed to open option');
    return { optionId: opened.id };
  }

  it('skips the network call entirely in demo mode', async () => {
    const stub: ListPositionsStub = { listOpenOptionPositions: vi.fn() };
    const engine = setupEngine({ mode: 'demo', client: stub });

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.skipped).toBe('mode');
    expect(stub.listOpenOptionPositions).not.toHaveBeenCalled();
  });

  it('skips when no Tradier client is configured for the active env', async () => {
    const engine = setupEngine({ mode: 'live', env: 'sandbox', client: null });

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.skipped).toBe('no-client');
  });

  it('skips when the active env has no open rows, no pending exits, and no pending closes', async () => {
    const stub: ListPositionsStub = { listOpenOptionPositions: vi.fn() };
    const engine = setupEngine({ client: stub });

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.skipped).toBe('empty');
    expect(stub.listOpenOptionPositions).not.toHaveBeenCalled();
  });

  it('fetches Tradier positions and imports a new external open into the active env', async () => {
    // Pre-seed an open row so the throttle gate lets us through, but use a
    // different OCC symbol than the Tradier response so the import path
    // adds the second row instead of just updating the seed.
    const stub: ListPositionsStub = {
      listOpenOptionPositions: vi.fn().mockResolvedValue([
        {
          optionSymbol: 'MSFT240705C00400000',
          underlying: 'MSFT',
          optionType: 'call',
          strike: 400,
          expiration: '2024-07-05',
          contracts: 2,
          premiumPaid: 1.10,
          acquiredAt: TRADING_TIME,
        },
      ]),
    };
    const engine = setupEngine({ client: stub });
    openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.skipped).toBeNull();
    expect(summary.added).toBe(1);
    expect(stub.listOpenOptionPositions).toHaveBeenCalledTimes(1);
    const liveRows = asInternals(engine).optionsAccounts.sandbox.getStateForMode('live').openOptions;
    expect(liveRows.map(r => (r as unknown as { optionSymbol?: string }).optionSymbol).sort()).toEqual([
      'AAPL240705C00200000',
      'MSFT240705C00400000',
    ]);
  });

  it('does not double-import an engine-opened row sharing the OCC symbol Tradier reports', async () => {
    // Engine-opened (importedFromTradier=false) row with the same OCC symbol
    // Tradier surfaces. Reconcile must skip it rather than mint a second copy.
    const stub: ListPositionsStub = {
      listOpenOptionPositions: vi.fn().mockResolvedValue([
        {
          optionSymbol: 'AAPL240705C00200000',
          underlying: 'AAPL',
          optionType: 'call',
          strike: 200,
          expiration: '2024-07-05',
          contracts: 1,
          premiumPaid: 1.0,
          acquiredAt: TRADING_TIME,
        },
      ]),
    };
    const engine = setupEngine({ client: stub });
    openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.added).toBe(0);
    expect(summary.updated).toBe(0);
    const liveRows = asInternals(engine).optionsAccounts.sandbox.getStateForMode('live').openOptions;
    expect(liveRows).toHaveLength(1);
  });

  it('enforces the cadence — a second call inside the window is short-circuited', async () => {
    const stub: ListPositionsStub = {
      listOpenOptionPositions: vi.fn().mockResolvedValue([]),
    };
    const engine = setupEngine({ client: stub });
    openLiveEngineRow(engine, 'sandbox');

    const first = await engine.reconcileLivePortfolio();
    expect(first.skipped).toBeNull();

    // Same fake-clock instant — second call must hit the cadence guard
    // without listing positions again.
    const second = await engine.reconcileLivePortfolio();
    expect(second.skipped).toBe('cadence');
    expect(stub.listOpenOptionPositions).toHaveBeenCalledTimes(1);

    // Advance past the cadence window and the next call goes out again.
    vi.setSystemTime(TRADING_TIME + 31_000);
    const third = await engine.reconcileLivePortfolio();
    expect(third.skipped).toBeNull();
    expect(stub.listOpenOptionPositions).toHaveBeenCalledTimes(2);
  });

  it('keeps the cadence timestamp unchanged when the gate skips so the next non-empty tick reconciles immediately', async () => {
    const stub: ListPositionsStub = {
      listOpenOptionPositions: vi.fn().mockResolvedValue([]),
    };
    const engine = setupEngine({ client: stub });

    const empty = await engine.reconcileLivePortfolio();
    expect(empty.skipped).toBe('empty');
    expect(asInternals(engine).lastTradierPortfolioReconcileAt).toBe(0);

    // Now open a row; the very next call (no clock advance) should reconcile.
    openLiveEngineRow(engine, 'sandbox');
    const summary = await engine.reconcileLivePortfolio();
    expect(summary.skipped).toBeNull();
    expect(stub.listOpenOptionPositions).toHaveBeenCalledTimes(1);
  });

  it('swallows list-positions failures and bumps the cadence timestamp so we do not tight-loop on a Tradier outage', async () => {
    const stub: ListPositionsStub = {
      listOpenOptionPositions: vi.fn().mockRejectedValue(new Error('socket reset')),
    };
    const engine = setupEngine({ client: stub });
    openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.skipped).toBeNull();
    expect(summary.added).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.removed).toBe(0);
    // Timestamp advanced so the next same-instant call hits the cadence
    // guard instead of retrying the failed list call in a tight loop.
    expect(asInternals(engine).lastTradierPortfolioReconcileAt).toBe(TRADING_TIME);
    const second = await engine.reconcileLivePortfolio();
    expect(second.skipped).toBe('cadence');
    expect(stub.listOpenOptionPositions).toHaveBeenCalledTimes(1);
  });
});

// TRA-349 — regression-lock the (mode × dashboard) sub-account wiring shipped
// in TRA-346. SignalEngine owns three stocks-side sub-accounts plus an
// engine-level pair of fields:
//
//   * `account` (PaperAccount, demo paper)         → (demo, stocks)
//   * `optionsAccounts.sandbox` (PaperOptionsAccount, demo paper) → (demo, stocks)
//   * `optionsAccounts.production` (PaperOptionsAccount, live)    → (live, stocks)
//   * `managedAccountRatio` / `riskPerTrade` (drive Tradier live equity sizing
//     via TRA-335)                                  → (live, stocks)
//
// These tests fail if any wire is rewired to read from the legacy un-suffixed
// `managedAccountRatio` / `riskPerTrade` field, the wrong dashboard bucket, or
// the wrong mode bucket. We use four distinct values across the four scoped
// buckets so a swap never accidentally type-checks.

interface PaperAccountInternals {
  managedAccountRatio: number;
  riskPerTrade: number;
}
interface OptionsAccountInternals {
  managedAccountRatio: number;
}
interface SignalEngineInternals {
  account: PaperAccountInternals;
  optionsAccounts: { sandbox: OptionsAccountInternals; production: OptionsAccountInternals };
  managedAccountRatio: number;
  riskPerTrade: number;
}

function fourBucketSettings(overrides: Partial<AccountSettings> = {}): AccountSettings {
  return {
    ...DEFAULT_ACCOUNT_SETTINGS,
    // Distinct values per (mode × market) so a wiring swap surfaces as a
    // numerical mismatch instead of silently coinciding with another bucket.
    managedAccountRatioDemoStocks: 0.10,
    managedAccountRatioLiveStocks: 0.20,
    managedAccountRatioDemoCrypto: 0.30,
    managedAccountRatioLiveCrypto: 0.40,
    riskPerTradeDemoStocks: 0.001,
    riskPerTradeLiveStocks: 0.002,
    riskPerTradeDemoCrypto: 0.005,
    riskPerTradeLiveCrypto: 0.01,
    // Sentinel values on the legacy un-suffixed fields — if any sub-account
    // reads from these instead of its scoped bucket, the test fails because
    // 0.99 / 0.49 don't match any scoped bucket above.
    managedAccountRatio: 0.99,
    riskPerTrade: 0.49,
    ...overrides,
  };
}

describe('SignalEngine — TRA-346 four-bucket sub-account wiring (TRA-349)', () => {
  it('constructor wires each stocks sub-account to its mode-locked bucket', () => {
    const engine = new SignalEngine(fourBucketSettings({ mode: 'demo' })) as unknown as SignalEngineInternals;
    // Demo paper account → (demo, stocks).
    expect(engine.account.managedAccountRatio).toBe(0.10);
    expect(engine.account.riskPerTrade).toBe(0.001);
    // Sandbox options account is paper-only → (demo, stocks).
    expect(engine.optionsAccounts.sandbox.managedAccountRatio).toBe(0.10);
    // Production options account is the live trading bucket → (live, stocks).
    expect(engine.optionsAccounts.production.managedAccountRatio).toBe(0.20);
    // Engine-level fields drive Tradier live equity sizing (TRA-335) →
    // (live, stocks). Pinning here ensures Tradier orders honour the
    // user's Live Risk slider regardless of which mode they're viewing.
    expect(engine.managedAccountRatio).toBe(0.20);
    expect(engine.riskPerTrade).toBe(0.002);
  });

  it('constructor still pins the live-side bucket to (live, stocks) when settings.mode is live', () => {
    // The wiring is mode-locked, not mode-active: switching settings.mode to
    // 'live' must NOT pull the demo paper account's ratio along — that
    // regression is exactly the original TRA-346 bug.
    const engine = new SignalEngine(fourBucketSettings({ mode: 'live' })) as unknown as SignalEngineInternals;
    expect(engine.account.managedAccountRatio).toBe(0.10);
    expect(engine.account.riskPerTrade).toBe(0.001);
    expect(engine.optionsAccounts.sandbox.managedAccountRatio).toBe(0.10);
    expect(engine.optionsAccounts.production.managedAccountRatio).toBe(0.20);
    expect(engine.managedAccountRatio).toBe(0.20);
    expect(engine.riskPerTrade).toBe(0.002);
  });

  it('applySettings re-pins each sub-account to its mode-locked bucket on every save', async () => {
    // Start from defaults so the first applySettings exercises the fresh
    // wiring path (no carryover from a previous settings snapshot).
    const engine = new SignalEngine() as unknown as SignalEngineInternals & {
      applySettings: (s: AccountSettings) => Promise<void>;
    };
    await engine.applySettings(fourBucketSettings({ mode: 'demo' }));

    expect(engine.account.managedAccountRatio).toBe(0.10);
    expect(engine.account.riskPerTrade).toBe(0.001);
    expect(engine.optionsAccounts.sandbox.managedAccountRatio).toBe(0.10);
    expect(engine.optionsAccounts.production.managedAccountRatio).toBe(0.20);
    expect(engine.managedAccountRatio).toBe(0.20);
    expect(engine.riskPerTrade).toBe(0.002);
  });

  it('applySettings: a Demo edit on stocks does NOT bleed into the production options bucket', async () => {
    // Headline TRA-346 invariant. Start with a saved snapshot scoping all four
    // stocks buckets, then save again with a Demo-only edit; the production
    // bucket must keep its original (live, stocks) value.
    const engine = new SignalEngine() as unknown as SignalEngineInternals & {
      applySettings: (s: AccountSettings) => Promise<void>;
    };
    await engine.applySettings(fourBucketSettings({ mode: 'demo' }));
    await engine.applySettings(fourBucketSettings({
      mode: 'demo',
      managedAccountRatioDemoStocks: 0.11,
      riskPerTradeDemoStocks: 0.0011,
    }));

    expect(engine.account.managedAccountRatio).toBe(0.11);
    expect(engine.account.riskPerTrade).toBe(0.0011);
    expect(engine.optionsAccounts.sandbox.managedAccountRatio).toBe(0.11);
    // Production stays put — the Demo edit must not pull live-mode sizing.
    expect(engine.optionsAccounts.production.managedAccountRatio).toBe(0.20);
    expect(engine.managedAccountRatio).toBe(0.20);
    expect(engine.riskPerTrade).toBe(0.002);
  });

  it('falls back to the legacy un-suffixed managedAccountRatio when scoped buckets are absent', async () => {
    // Saved-before-TRA-346 snapshot: only `managedAccountRatio`/`riskPerTrade`
    // are set, all eight scoped fields undefined. Each sub-account must
    // surface the legacy value via the resolver fallback chain.
    const engine = new SignalEngine() as unknown as SignalEngineInternals & {
      applySettings: (s: AccountSettings) => Promise<void>;
    };
    await engine.applySettings({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      managedAccountRatio: 0.42,
      riskPerTrade: 0.013,
    });

    expect(engine.account.managedAccountRatio).toBe(0.42);
    expect(engine.account.riskPerTrade).toBe(0.013);
    expect(engine.optionsAccounts.sandbox.managedAccountRatio).toBe(0.42);
    expect(engine.optionsAccounts.production.managedAccountRatio).toBe(0.42);
    expect(engine.managedAccountRatio).toBe(0.42);
    expect(engine.riskPerTrade).toBe(0.013);
  });
});

// ─── TRA-361 — submitStagedOptionExits honors MARKET vs LIMIT pricing ───────
// The PaperOptionsAccount stages a pendingExit with `pricing: 'market'` for
// deep-underwater imported positions (the LIMIT at the SL would never fill).
// The engine's submit path must call `sellContracts` (market) for those and
// `sellContractsLimit` (the TRA-354 default) for everything else.
describe('SignalEngine — TRA-361 submitStagedOptionExits pricing', () => {
  interface TradierExitStub {
    sellContractsLimit: ReturnType<typeof vi.fn>;
    sellContracts: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }

  function makeStub(): TradierExitStub {
    return {
      sellContractsLimit: vi.fn().mockResolvedValue({ id: 901, status: 'pending' }),
      sellContracts: vi.fn().mockResolvedValue({ id: 902, status: 'pending' }),
      // No terminal status — keep the pendingExit and let the next tick poll.
      waitForOrderTerminalStatus: vi.fn().mockResolvedValue(null),
    };
  }

  function setupEngine(stub: TradierExitStub) {
    const engine = new SignalEngine();
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    return engine;
  }

  it('routes a LIMIT-pricing intent through sellContractsLimit', async () => {
    const stub = makeStub();
    const engine = setupEngine(stub);
    const submit = (engine as unknown as {
      submitStagedOptionExits: (s: import('@trading-app/shared').OptionPosition[]) => Promise<void>;
    }).submitStagedOptionExits.bind(engine);

    const snapshot = {
      id: 'opt-1',
      symbol: 'SPY',
      optionSymbol: 'SPY260515C00450000',
      pendingExit: {
        tradierOrderId: '',
        qty: 2,
        limitPrice: 1.50,
        submittedAt: Date.now(),
        kind: 'sl',
        pricing: 'limit',
      },
    } as unknown as import('@trading-app/shared').OptionPosition;
    await submit([snapshot]);

    expect(stub.sellContractsLimit).toHaveBeenCalledWith('SPY260515C00450000', 2, 1.50);
    expect(stub.sellContracts).not.toHaveBeenCalled();
  });

  it('escalates a MARKET-pricing intent through sellContracts (deep-underwater fallback)', async () => {
    const stub = makeStub();
    const engine = setupEngine(stub);
    const submit = (engine as unknown as {
      submitStagedOptionExits: (s: import('@trading-app/shared').OptionPosition[]) => Promise<void>;
    }).submitStagedOptionExits.bind(engine);

    const snapshot = {
      id: 'opt-2',
      symbol: 'NFLX',
      optionSymbol: 'NFLX260515P00400000',
      importedFromTradier: true,
      pendingExit: {
        tradierOrderId: '',
        qty: 1,
        limitPrice: 7.50, // SL trigger price, ignored because pricing='market'
        submittedAt: Date.now(),
        kind: 'sl',
        pricing: 'market',
      },
    } as unknown as import('@trading-app/shared').OptionPosition;
    await submit([snapshot]);

    expect(stub.sellContracts).toHaveBeenCalledWith('NFLX260515P00400000', 1);
    expect(stub.sellContractsLimit).not.toHaveBeenCalled();
  });
});
