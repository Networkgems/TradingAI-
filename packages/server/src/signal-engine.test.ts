import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import type { RelativeValueScannerService, RelativeValueScanResult } from './relative-value-scanner.js';
import type { RelativeValueCandidate, TradierOptionsClient } from '@trading-app/engine';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { TradierEnv } from '@trading-app/shared';

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
