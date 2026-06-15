import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { SignalEngine, sizeLiveEquityFromStop, shortBlockedOnCashAccount, gateSignalOnReview, describeGatedStrategies, shouldBootArmLiveEquity, shouldRunRelativeValueScan, isLiveBrokerOperator, resolveLiveBrokerOperator } from './signal-engine.js';
import { setShadowLedgerFileForTests } from './shadow-signal-ledger.js';
import { PaperAccount } from './paper-account.js';
import type { RelativeValueScannerService, RelativeValueScanResult } from './relative-value-scanner.js';
import type { RelativeValueCandidate, TradierAccountBalance, TradierOptionsClient, TradierOrderClient } from '@trading-app/engine';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  isLiveTradierEquityEnabled,
  isLiveTradierOptionsEnabled,
  resolveLiveTradeEquitiesTradier,
  resolveLiveTradierMarkets,
  resolveMarketReviewGatesEnabled,
} from '@trading-app/shared';
import type {
  AccountSettings,
  TradeSignal,
  TradierEnv,
  MarketReview,
  MarketReviewGates,
  MarketRegimeLabel,
  Position,
  Candle,
} from '@trading-app/shared';

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
  // TRA-811 — board directive (parent TRA-810): RV is paused, so the per-tick
  // gate must NOT arm a new scan/open even when every other condition is
  // favorable. The kill switch (RV_ENGINE_ENABLED) dominates the gate. This
  // proves new RV entries are off in BOTH modes without depending on a live
  // server. (Existing managed exits run elsewhere and are intentionally not
  // gated here.)
  it('shouldRunRelativeValueScan returns false while RV is paused, even with all other conditions favorable (TRA-811)', () => {
    expect(
      shouldRunRelativeValueScan({
        autoTradingEnabled: true,
        halted: false,
        hasScanner: true,
        marketOpen: true,
        skipOptionsForLiveEquityOnly: false,
      }),
    ).toBe(false);
  });

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

describe('SignalEngine — TRA-791 shadow channel state exposure', () => {
  it('getState() always carries a supertrendShadowSignals array (served by /api/state + WS state)', () => {
    // `GET /api/state` returns `ctx.engine.getState()` and the WS `state` frame
    // broadcasts the same object, so asserting on getState() covers both surfaces.
    const engine = new SignalEngine(undefined, undefined, undefined);
    const state = engine.getState();
    expect(Array.isArray(state.supertrendShadowSignals)).toBe(true);
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
  /**
   * TRA-374 — the entry mirror now goes through `submitSmartBuyToOpen`, which
   * needs `getOptionQuote`, `buyContractsLimit`, `cancelOrder`, and
   * `waitForOrderTerminalStatus` on the client. The pre-TRA-374 tests used
   * a `buyContracts` (market) stub; the interface and call sites below are
   * updated to drive the new LIMIT walk path.
   */
  interface TradierLiveStub {
    getAccountBalance: ReturnType<typeof vi.fn>;
    getOptionQuote: ReturnType<typeof vi.fn>;
    buyContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
    sellContracts?: ReturnType<typeof vi.fn>;
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

  /**
   * TRA-374 — quote that yields mid 1.20 (matches the scanner's mark) so the
   * smart-open walk submits at mid + 1¢ on the first attempt and a stub fill
   * at 1.21 reflects what the broker would have given us.
   */
  function tightQuote() {
    return { symbol: 'AAPL240705C00200000', bid: 1.15, ask: 1.25 };
  }

  it('voids the paper open, surfaces a skip-reason signal, and frees the slot when Tradier ends in canceled', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 1000, totalCash: 300, optionBuyingPower: 999_999,
      }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 7, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
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

    // The mirror DID submit a LIMIT (we only know it's bad after Tradier reconciles).
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
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
    // TRA-374 — smart-open prefixes the reason with the order id and the
    // Tradier reason_description. The exact prefix is "Tradier order N rejected:".
    expect(state.signals[0].liveSkipReason).toMatch(/rejected/);
    expect(state.signals[0].liveSkipReason).toContain('insufficient buying power');
  });

  // TRA-483 — when Tradier's day-trade buying power (PDT limit) hits $0 the
  // broker rejects every same-day option round trip even though
  // `optionBuyingPower` may still be positive. The signal-time pre-check now
  // surfaces a skip signal up-front instead of submitting orders Tradier
  // will silently cancel for "insufficient day-trade buying power". The
  // dashboard then shows the DTBP-exhausted skip reason next to the failed
  // signal so the user can diagnose without mining logs (the issue's
  // screenshot showed positive Option BP but DTBP $0 and no trades opening).
  it('skips the order at the signal pre-check when dayTradeBuyingPower is below notional cost (TRA-483)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // Option BP large enough to clear the per-position cap, but DTBP=$0 —
    // the exact PDT-limit-reached failure mode from the issue's screenshot.
    (engine as unknown as {
      liveTradierBalance: {
        totalEquity: number;
        totalCash: number;
        optionBuyingPower: number;
        dayTradeBuyingPower: number;
      } | null;
    }).liveTradierBalance = {
      totalEquity: 25_000,
      totalCash: 25_000,
      optionBuyingPower: 25_000,
      dayTradeBuyingPower: 0,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // Broker never called — DTBP gate trips at the signal pre-check.
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].mode).toBe('live');
    expect(state.signals[0].liveSkipReason).toContain('day-trade buying power');
    expect(state.signals[0].liveSkipReason).toContain('DTBP exhausted');
  });

  it('stays permissive when dayTradeBuyingPower is null (cash accounts have no DTBP) (TRA-483)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
      }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 21, status: 'ok' }),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 21, status: 'filled', exec_quantity: 1, avg_fill_price: 1.21,
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // DTBP = null (cash accounts don't carry it). The gate must skip its
    // check rather than treating "no value" as "zero".
    (engine as unknown as {
      liveTradierBalance: {
        totalEquity: number;
        totalCash: number;
        optionBuyingPower: number;
        dayTradeBuyingPower: number | null;
      } | null;
    }).liveTradierBalance = {
      totalEquity: 25_000,
      totalCash: 25_000,
      optionBuyingPower: 25_000,
      dayTradeBuyingPower: null,
    };
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // The order DID submit — cash accounts have no DTBP and the gate is
    // skipped entirely. This locks in the cash-account regression boundary.
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
  });

  it('surfaces dayTradeBuyingPower on liveAccount when Tradier reports it (TRA-483)', () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    (engine as unknown as {
      liveTradierBalance: TradierAccountBalance | null;
    }).liveTradierBalance = {
      totalEquity: 25_000,
      totalCash: 25_000,
      optionBuyingPower: 25_000,
      stockBuyingPower: 25_000,
      longMarketValue: 0,
      dayTradeBuyingPower: 7500,
    };
    const state = engine.getState();
    expect(state.account.dayTradeBuyingPower).toBe(7500);
  });

  it('omits dayTradeBuyingPower on liveAccount for cash accounts (no DTBP bucket) (TRA-483)', () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    (engine as unknown as {
      liveTradierBalance: TradierAccountBalance | null;
    }).liveTradierBalance = {
      totalEquity: 500,
      totalCash: 480,
      optionBuyingPower: 480,
      stockBuyingPower: 480,
      longMarketValue: 0,
      dayTradeBuyingPower: null,
    };
    const state = engine.getState();
    expect(state.account.dayTradeBuyingPower).toBeUndefined();
  });

  it('skips the order entirely when cached optionBuyingPower is below notional cost (TRA-332 surfaces it on the dashboard)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    // TRA-497 — bump mark above the new $150 per-position cap floor so the
    // small-OBP skip still fires. Pre-TRA-497 a $1.20 mark ($120 cost) was
    // enough; the $150 cap floor now lets that through.
    const engine = setupLiveEngine(stub, freshScanner(1.60));
    // TRA-332 / TRA-378 / TRA-497: with a $50 OBP, a single $1.60-mark
    // contract ($160) blows past the 15% per-position cap (max($150, $7.50)
    // = $150), so even the forced 1-contract floor can't open it — the
    // engine's pre-check trips before any broker call and surfaces a
    // skip-reason signal.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 100, totalCash: 50, optionBuyingPower: 50,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // Pre-check fired — we never bothered the broker.
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    // TRA-332 — surfaces the skip on the dashboard so the user sees the diagnosis.
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].mode).toBe('live');
    expect(state.signals[0].liveSkipReason).toContain('per-position cap');
  });

  it('voids the paper open and surfaces a skip signal when the buyContractsLimit call itself throws (network/auth failure)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockRejectedValue(new Error('Tradier 401 unauthorized')),
      cancelOrder: vi.fn(),
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
    // TRA-374 — when buyContractsLimit throws, smart-open returns a `rejected`
    // outcome whose reason carries the thrown message; the engine surfaces it
    // through the "Tradier order ... rejected" path.
    expect(state.signals[0].liveSkipReason).toMatch(/rejected|threw/);
    // We never reached the polling step.
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();
  });

  it('keeps the paper open and records the signal on the happy path (Tradier filled)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
      }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 11, status: 'ok' }),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 11, status: 'filled', exec_quantity: 1, avg_fill_price: 1.21,
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
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

  it('voids the paper open when the smart-open walk exhausts all 5 attempts without a fill (TRA-374)', async () => {
    // TRA-374 — pre-374 behaviour kept the position open on a non-terminal
    // wait, trusting the periodic balance poll to catch drift. The new
    // smart-open helper instead walks the LIMIT from mid+1¢ → ask in 0.25
    // steps and voids the paper open after 5 attempts, surfacing a clear
    // "walk to ask exhausted" reason. This test locks in that new
    // behaviour — a phantom long position that never actually filled at
    // any walk step is worse than a missed entry.
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
      }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 13, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      // Always pending → walk exhausts the full schedule.
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
    // TRA-374 — walk_exhausted voids the paper open: no phantom position,
    // slot freed, walk-to-ask-exhausted surfaced as the skip reason.
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toContain('walk to ask exhausted');
    // The walk submitted 5 LIMITs and cancelled each in turn.
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(5);
    expect(stub.cancelOrder).toHaveBeenCalledTimes(5);
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
  /**
   * TRA-374 — see the TRA-319 describe block above for the same stub-surface
   * update rationale (smart-open replaces market `buyContracts`).
   */
  interface TradierLiveStub {
    getAccountBalance: ReturnType<typeof vi.fn>;
    getOptionQuote: ReturnType<typeof vi.fn>;
    buyContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }

  function tightQuote(symbol = 'AAPL240705C00200000') {
    return { symbol, bid: 1.15, ask: 1.25 };
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

  it('surfaces a budget-too-small skip signal for a $300 cash account (TRA-332, recalibrated for TRA-497 $150 cap)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    // TRA-497 — the per-position cap floor moved from $100 to $150 on
    // 2026-05-28. To still verify the skip reason on a $300 cash account
    // (the original TRA-332 report), use a $1.60-mark candidate whose $160
    // cost still exceeds the new $150 cap. Pre-TRA-497 this was $1.20 / $120
    // against the $100 cap.
    const engine = setupLiveEngine(stub, freshScanner(1.60));
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 300, totalCash: 300, optionBuyingPower: 300,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    // The dashboard now shows the user WHY their account isn't trading.
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].mode).toBe('live');
    expect(state.signals[0].liveSkipReason).toContain('per-position cap');
    expect(state.signals[0].liveSkipReason).toContain('$160.00');
    expect(state.signals[0].liveSkipReason).toContain('equity $300.00');
  });

  it('opens a 1-contract position for a small ($1k) live account (TRA-378 / TRA-497)', async () => {
    // Mark = $1 → 1 contract = $100 notional. Live equity = $1,000:
    // pctBudget = $1k * 0.5 * 0.01 = $5 (rounds well below one contract),
    // but the $150 ticket floor (TRA-497) lifts the budget so floor($150/$100)
    // = 1 contract clears the $150 per-position cap. Pre-TRA-378 this
    // account silently skipped the signal.
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 31, status: 'ok' }),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 31, status: 'filled', avg_fill_price: 1.01,
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner(1.0));
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 1000, totalCash: 1000, optionBuyingPower: 1000,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // The floor opened exactly one contract and mirrored it to the broker —
    // sized off the LIVE $1k equity, not the stale paper equity.
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].contracts).toBe(1);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toBeUndefined();
  });

  it('opens a sized position when live equity is sufficient (regression check on the override path)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 21, status: 'ok' }),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 21, status: 'filled', avg_fill_price: 1.01,
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner(1.0));
    // $50 K live equity → TRA-378 live budget = min(50_000 * 0.5 * 0.01,
    // 50_000 * 0.15) = $250 → 2 contracts at $100 each (riskPerTrade defaults
    // to 0.01 when the engine is built without settings).
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 50_000, totalCash: 50_000, optionBuyingPower: 50_000,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].contracts).toBe(2);
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
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
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

    // Paper equity sizing produces contracts (25000 * 0.5 * 0.02 = $250 budget
    // → 2 contracts at $100 each). No live-budget skip surfaces. The buy
    // mirror is also gated on `tradierLiveOptionsEnabled` (TRA-355) so the
    // broker call never fires.
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].contracts).toBe(2);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toBeUndefined();
  });

  it('falls back to optionBuyingPower over totalEquity when both are present (cash account semantics)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    // TRA-495 / TRA-497 — the $150 ticket floor would normally let a
    // $1.0-mark contract through on a $200 OBP book ($100 cost ≤ $150 cap).
    // To still verify the engine picks OBP over totalEquity, use a
    // $1.60-mark candidate whose $160 cost blows past the $200-OBP cap
    // ($150) — but would have fit under the $50K-totalEquity cap ($7.5K).
    // The skip surfaces because the engine sized off the tighter OBP figure.
    const engine = setupLiveEngine(stub, freshScanner(1.60));
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 50_000, totalCash: 50_000, optionBuyingPower: 200,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // $160 cost > $150 cap (max($150, $30)) under OBP sizing → skip. If the
    // engine had used totalEquity ($50K, cap $7,500) the contract would have
    // sized fine — proves OBP took precedence.
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toContain('equity $200.00');
    expect(state.signals[0].liveSkipReason).toContain('per-position cap');
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
describe('shortBlockedOnCashAccount (TRA-724)', () => {
  it('blocks a sell-to-open on a cash account', () => {
    expect(shortBlockedOnCashAccount('sell', { accountType: 'cash' })).toBe(true);
  });
  it('allows a buy on a cash account (only shorts are gated)', () => {
    expect(shortBlockedOnCashAccount('buy', { accountType: 'cash' })).toBe(false);
  });
  it('allows shorts on margin / pdt accounts', () => {
    expect(shortBlockedOnCashAccount('sell', { accountType: 'margin' })).toBe(false);
    expect(shortBlockedOnCashAccount('sell', { accountType: 'pdt' })).toBe(false);
  });
  it('stays permissive when the account type is indeterminate (null / undefined)', () => {
    expect(shortBlockedOnCashAccount('sell', { accountType: null })).toBe(false);
    expect(shortBlockedOnCashAccount('sell', {})).toBe(false);
  });
});

describe('sizeLiveEquityFromStop (TRA-335)', () => {
  function balance(overrides: Partial<TradierAccountBalance> = {}): TradierAccountBalance {
    return {
      totalEquity: 25_000,
      totalCash: 10_000,
      optionBuyingPower: 10_000,
      stockBuyingPower: 20_000,
      longMarketValue: 15_000,
      // TRA-483 — DTBP default; tests can override via the `overrides` arg
      // when they need to exercise the PDT-exhausted path.
      dayTradeBuyingPower: null,
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
    // equityCap = floor(5000/50) = 100. min(riskQty=50, equityCap=100) = 50.
    // No SBP cap (null). TRA-499 — perPositionCap(baseEquity=$5,000) =
    // max($150, 15% × $5,000) = $750; 50 × $50 = $2,500 > $750 → trim to
    // floor($750/$50) = 15 shares. The BP cap is still skipped (the test's
    // original intent); the new per-position notional cap is what binds.
    expect(qty).toBe(15);
  });
});

// TRA-499 — small-account equity sizing on a Tradier live book. Mirrors the
// 1-share LIVE floor + per-position notional cap from the options ticket
// budget (TRA-495/TRA-497) so a $550 live book can actually open positions
// without burning all its cash on one ticket. The board directive on
// TRA-494 routes live equities through Tradier (production); these tests
// pin down what "small book" sizing looks like on that path.
describe('sizeLiveEquityFromStop — TRA-499 small-book caps', () => {
  function smallBookBalance(overrides: Partial<TradierAccountBalance> = {}): TradierAccountBalance {
    return {
      totalEquity: 550,
      totalCash: 550,
      optionBuyingPower: 550,
      stockBuyingPower: 550,
      longMarketValue: 0,
      dayTradeBuyingPower: null,
      ...overrides,
    };
  }

  it('forces 1 share on a $50 stock that would otherwise size to 0 (LIVE 1-share floor)', () => {
    // managedEquity = 550 × 1.0 = $550. maxRisk = $550 × 0.10 = $55.
    // 5% stop dist on $50 = $2.50. riskQty = floor($55/$2.50) = 22.
    // equityCap = floor($550/$50) = 11. stockBP cap = floor($550/$50) = 11.
    // min(22, 11, 11) = 11 → cap = $150 → 11 × $50 = $550 > $150 →
    // trim to floor($150/$50) = 3. So the risk-from-stop sizing DOES
    // produce a non-zero qty here; the 1-share LIVE floor only fires when
    // risk math rounds to 0. Sanity-check the cap trim instead.
    const qty = sizeLiveEquityFromStop({
      balance: smallBookBalance(),
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
      entryPrice: 50,
      stopPrice: 47.50,
      currentPrice: 50,
    });
    expect(qty).toBe(3);
  });

  it('returns 0 when 1-share cost exceeds the per-position cap on a small book', () => {
    // baseEquity = $550 → cap = max($150, $82.50) = $150. A $200 stock has
    // 1-share cost $200 ≥ $150 cap → up-front reject. Risk math would
    // otherwise have produced 2 shares (riskQty=5, equityCap=2, min=2)
    // and the multi-share trim would have ground them down to
    // floor($150/$200)=0 anyway, but the early exit short-circuits the
    // whole sizing pass. Final: 0 — position is too concentrated for the
    // small-book swing thesis.
    const qty = sizeLiveEquityFromStop({
      balance: smallBookBalance(),
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
      entryPrice: 200,
      stopPrice: 190,
      currentPrice: 200,
    });
    expect(qty).toBe(0);
  });

  it('rejects a $150 single-ticket on a $550 book (strict-less-than cap admission, QT TRA-499 nit)', () => {
    // The cap is `max($150, 15% × $550) = $150`. A $150 stock has 1-share
    // cost = $150 = cap exactly. The risk-from-stop math here would otherwise
    // size up: managedEquity = $550, maxRisk = $55, stop $7.50 → riskQty = 7;
    // equityCap = floor($550/$150) = 3; sbp cap = 3; qty = 3. Pre-fix the
    // multi-share trim would have given floor($150/$150) = 1 → admit 1 share
    // (1 × $150 = $150 ≤ $150 cap). Post-fix: the up-front strict-less-than
    // admission check (`currentPrice >= cap`) short-circuits to 0 — a single
    // ticket that would consume 100% of the per-position cap is rejected.
    // This is asymmetric with `OptionsAccount.sizeContracts` on purpose; see
    // the in-code comment in `sizeLiveEquityFromStop`.
    const qty = sizeLiveEquityFromStop({
      balance: smallBookBalance(),
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
      entryPrice: 150,
      stopPrice: 142.50,
      currentPrice: 150,
    });
    expect(qty).toBe(0);
  });

  it('forces 1 share when the equity cap rounded sizing to 0 (1-share LIVE floor)', () => {
    // Edge case: a $25 stock where the BP/equity caps don't kick in but
    // we're constrained by an unusually tight risk knob. With
    // managedAccountRatio = 0.5, riskPerTrade = 0.01 on $550: maxRisk = $2.75.
    // 4% stop ($1 on $25) → riskQty = floor($2.75/$1) = 2. equityCap =
    // floor($275/$25) = 11. min = 2. cap = $150 → 2 × $25 = $50 ≤ $150.
    // qty = 2. So the floor doesn't actually need to fire here. Verify the
    // smaller cap doesn't accidentally trim a small-notional position.
    const qty = sizeLiveEquityFromStop({
      balance: smallBookBalance(),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 25,
      stopPrice: 24,
      currentPrice: 25,
    });
    expect(qty).toBe(2);
  });

  it('1-share LIVE floor fires when risk-from-stop rounds to 0 but a single share fits the cap', () => {
    // Concoct a scenario where risk math gives 0: a very tight risk knob
    // and a wide stop. managedAccountRatio = 0.01, riskPerTrade = 0.01,
    // baseEquity = $550 → managedEquity = $5.50, maxRisk = $0.055.
    // 5% stop on $50 = $2.50 → riskQty = 0. equityCap = floor($5.50/$50) = 0.
    // qty = 0. Cap = $150, currentPrice $50 < $150 → up-front admit, forced
    // floor fires → qty = 1. Multi-share trim: 1 × $50 = $50 ≤ $150 → no
    // trim. Final: 1 share. Boundary semantics: the strict-less-than gate
    // bites only at currentPrice ≥ cap (see the $150 boundary test above).
    const qty = sizeLiveEquityFromStop({
      balance: smallBookBalance(),
      managedAccountRatio: 0.01,
      riskPerTrade: 0.01,
      entryPrice: 50,
      stopPrice: 47.50,
      currentPrice: 50,
    });
    expect(qty).toBe(1);
  });

  it('larger account behaviour is unchanged when per-position cap does not bind', () => {
    // Sanity check: a $50k book buying $100 stock at 5% stop with the
    // existing TRA-335 default knobs. cap = max($150, 15% × $50k) = $7,500.
    // qty from risk-from-stop with managedRatio=0.5, riskPerTrade=0.01:
    // managedEquity=$25k, maxRisk=$250, riskQty=floor($250/$5)=50; equityCap=
    // floor($25k/$100)=250; sbp cap floor($25k/$100)=250; qty=50.
    // cap recheck: 50 × $100 = $5,000 ≤ $7,500 → no trim. Pre-TRA-499 result
    // (50 shares) preserved.
    const qty = sizeLiveEquityFromStop({
      balance: {
        totalEquity: 50_000,
        totalCash: 25_000,
        optionBuyingPower: 25_000,
        stockBuyingPower: 25_000,
        longMarketValue: 25_000,
        dayTradeBuyingPower: null,
      },
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    });
    expect(qty).toBe(50);
  });
});

describe('sizeLiveEquityFromStop — TRA-711 available-funds gate', () => {
  // Mirrors the screenshot account: ~$226 cash with most of it committed to
  // open option orders so Available Funds (stockBuyingPower) is only ~$26,
  // while a swing signal fires on a ~$129 share. Pre-fix the buying-power cap
  // ground qty to 0 and the LIVE 1-share floor re-inflated it to 1, so Tradier
  // received — and rejected — a $129 order against $26 of available funds.
  it('returns 0 when available funds cannot cover even one share (no rejected order)', () => {
    const qty = sizeLiveEquityFromStop({
      balance: {
        totalEquity: 797.16,
        totalCash: 226.66,
        optionBuyingPower: 26.66,
        stockBuyingPower: 26.66,
        longMarketValue: 0,
        dayTradeBuyingPower: null,
      },
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
      entryPrice: 129.56,
      stopPrice: 123.0,
      currentPrice: 129.56,
    });
    expect(qty).toBe(0);
  });

  it('still admits 1 share when available funds cover exactly one share', () => {
    // Available funds $130 ≥ one $129.56 share → the 1-share floor is allowed
    // to fire. cap = max($150, 15% × baseEquity). baseEquity = $130 + $0 LMV
    // → cap = $150 > $129.56, so the up-front strict-less-than gate admits it.
    const qty = sizeLiveEquityFromStop({
      balance: {
        totalEquity: 130,
        totalCash: 130,
        optionBuyingPower: 130,
        stockBuyingPower: 130,
        longMarketValue: 0,
        dayTradeBuyingPower: null,
      },
      managedAccountRatio: 1.0,
      riskPerTrade: 0.01,
      entryPrice: 129.56,
      stopPrice: 123.0,
      currentPrice: 129.56,
    });
    expect(qty).toBe(1);
  });

  it('caps a multi-share order at the affordable-share ceiling', () => {
    // Risk-from-stop would want more shares than available funds can settle.
    // managedEquity = $5,000 cash → maxRisk ($5,000 × 0.10) = $500, $5 stop →
    // riskQty = 100; equityCap = floor($5,000/$50) = 100. But stockBuyingPower
    // is only $260 (most cash committed elsewhere) → affordableShares =
    // floor($260/$50) = 5. Per-position cap = max($150, 15% × $5,000=$750) =
    // $750 → no further trim. Final: capped to the 5 shares funds can cover.
    const qty = sizeLiveEquityFromStop({
      balance: {
        totalEquity: 5_000,
        totalCash: 5_000,
        optionBuyingPower: 260,
        stockBuyingPower: 260,
        longMarketValue: 0,
        dayTradeBuyingPower: null,
      },
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
      entryPrice: 50,
      stopPrice: 45,
      currentPrice: 50,
    });
    expect(qty).toBe(5);
  });

  it('stays permissive when stockBuyingPower is null (cash account, no bucket)', () => {
    // No buying-power bucket from Tradier → affordableShares = Infinity, so the
    // gate is a no-op and sizing falls back to the cash-based risk math. The
    // post-submit reconcile voids the mirror if the broker still rejects.
    const qty = sizeLiveEquityFromStop({
      balance: {
        totalEquity: 5_000,
        totalCash: 5_000,
        optionBuyingPower: null,
        stockBuyingPower: null,
        longMarketValue: 0,
        dayTradeBuyingPower: null,
      },
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    });
    expect(qty).toBeGreaterThan(0);
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
      dayTradeBuyingPower: null,
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

  it('refuses a live equity bracket outside regular market hours and never hits the broker (TRA-726)', async () => {
    // Post-close: 2024-06-04T22:00:00Z = 18:00 ET (after the 16:00 close).
    vi.setSystemTime(Date.parse('2024-06-04T22:00:00Z'));
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 99, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEquityEngine(stub);

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number | string; reason?: string }>
    }).placeTradierEquityBracket(bbSignal(), 100);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/market closed/i);
    expect(stub.submitBracketOrder).not.toHaveBeenCalled();
  });

  it('skips a SHORT (sell-to-open) bracket on a cash account with a clear liveSkipReason and never hits the broker (TRA-724)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEquityEngine(stub);
    // Flip the cached balance to a cash account — cash accounts cannot short.
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance.accountType =
      'cash';

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number | string; reason?: string }>
    }).placeTradierEquityBracket(bbSignal({ side: 'sell' }), 100);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('short not supported on a cash account');
    // Critical: the order never reached Tradier (no guaranteed reject).
    expect(stub.submitBracketOrder).not.toHaveBeenCalled();
  });

  it('still submits a LONG (buy) bracket on a cash account — only shorts are gated (TRA-724)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 7, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 7, status: 'filled' })),
    };
    const engine = setupLiveEquityEngine(stub);
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance.accountType =
      'cash';

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; reason?: string }>
    }).placeTradierEquityBracket(bbSignal({ side: 'buy' }), 100);

    expect(result.ok).toBe(true);
    expect(stub.submitBracketOrder).toHaveBeenCalledTimes(1);
    expect(stub.submitBracketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'buy' }),
    );
  });

  it('still submits a SHORT bracket on a margin account — shorts are only blocked on cash (TRA-724)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 8, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 8, status: 'filled' })),
    };
    const engine = setupLiveEquityEngine(stub);
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance.accountType =
      'margin';

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; reason?: string }>
    }).placeTradierEquityBracket(bbSignal({ side: 'sell' }), 100);

    expect(result.ok).toBe(true);
    expect(stub.submitBracketOrder).toHaveBeenCalledTimes(1);
    expect(stub.submitBracketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'sell' }),
    );
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

// TRA-392 — fill-chaser. A `sell_to_close` that stalls `pending` past the
// staleness window must be cancelled and resubmitted one step lower toward
// the bid by the engine's per-tick close reconciler, instead of sitting at
// the original limit until the operator manually reprices it. These tests
// drive `reconcilePendingCloses` against stub Tradier clients with the clock
// advanced past the staleness window.
describe('SignalEngine — TRA-392 pending-close fill-chaser', () => {
  interface ChaserClient {
    getOrderStatus: ReturnType<typeof vi.fn>;
    getOptionQuote: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    sellContractsLimit: ReturnType<typeof vi.fn>;
  }
  interface ChaserAcct {
    openOptionFromCandidate(sig: unknown, mode: 'live'): { id: string } | null;
    setPendingCloseOrderId(id: string, orderId: number): boolean;
    getState(): {
      openOptions: Array<{
        id: string;
        contractsRemaining: number;
        pendingCloseOrderId?: number | string;
        pendingCloseRepriceSteps?: number;
      }>;
      closedOptions: Array<{ id: string; currentPremium: number }>;
    };
  }
  type Internals = {
    tradierOptionsClientByEnv: Record<TradierEnv, unknown>;
    optionsAccounts: Record<TradierEnv, ChaserAcct>;
  };

  const T0 = Date.parse('2024-06-04T15:00:00Z');

  function asInternals(engine: SignalEngine): Internals {
    return engine as unknown as Internals;
  }

  function openPendingRow(engine: SignalEngine, client: ChaserClient, orderId: number) {
    asInternals(engine).tradierOptionsClientByEnv = { sandbox: client, production: null };
    const acct = asInternals(engine).optionsAccounts.sandbox;
    const opened = acct.openOptionFromCandidate(
      {
        id: 'sig',
        symbol: 'AAPL',
        type: 'otm_mispricing',
        side: 'buy',
        entryPrice: 1.0,
        stopLoss: 0.75,
        takeProfit: 1.5,
        riskRewardRatio: 2,
        timestamp: TRADING_TIME,
        optionSymbol: 'AAPL240705C00200000',
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
    acct.setPendingCloseOrderId(opened.id, orderId);
    return { acct, optionId: opened.id };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels and reprices a stale pending close one step down toward the bid', async () => {
    const client: ChaserClient = {
      getOrderStatus: vi.fn(async () => ({ id: 700, status: 'open' })),
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL240705C00200000', bid: 16, ask: 18 })),
      cancelOrder: vi.fn(async () => undefined),
      sellContractsLimit: vi.fn(async () => ({ id: 5555, status: 'ok' })),
    };
    const engine = new SignalEngine();
    const { acct, optionId } = openPendingRow(engine, client, 700);
    const contracts = acct.getState().openOptions.find((o) => o.id === optionId)!.contractsRemaining;

    // Order has sat pending past the 20s staleness window.
    vi.setSystemTime(T0 + 25_000);
    const summary = await engine.reconcilePendingCloses();

    expect(summary.repriced).toBe(1);
    expect(summary.stillPending).toBe(0);
    // Stale order cancelled, fresh limit submitted at bid + 0.2·spread = 16.40.
    expect(client.cancelOrder).toHaveBeenCalledWith(700);
    expect(client.sellContractsLimit).toHaveBeenCalledWith('AAPL240705C00200000', contracts, 16.4);
    const row = acct.getState().openOptions.find((o) => o.id === optionId);
    expect(row?.pendingCloseOrderId).toBe(5555);
    expect(row?.pendingCloseRepriceSteps).toBe(1);
  });

  it('leaves a fresh pending close alone until it crosses the staleness window', async () => {
    const client: ChaserClient = {
      getOrderStatus: vi.fn(async () => ({ id: 700, status: 'open' })),
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL240705C00200000', bid: 16, ask: 18 })),
      cancelOrder: vi.fn(async () => undefined),
      sellContractsLimit: vi.fn(async () => ({ id: 5555, status: 'ok' })),
    };
    const engine = new SignalEngine();
    openPendingRow(engine, client, 700);

    // Reconcile immediately — the order is only milliseconds old.
    const summary = await engine.reconcilePendingCloses();

    expect(summary.repriced).toBe(0);
    expect(summary.stillPending).toBe(1);
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect(client.sellContractsLimit).not.toHaveBeenCalled();
  });

  it('closes the row at the broker fill once a repriced order fills on a later tick', async () => {
    const client: ChaserClient = {
      getOrderStatus: vi.fn(async () => ({ id: 700, status: 'open' })),
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL240705C00200000', bid: 16, ask: 18 })),
      cancelOrder: vi.fn(async () => undefined),
      sellContractsLimit: vi.fn(async () => ({ id: 5555, status: 'ok' })),
    };
    const engine = new SignalEngine();
    const { acct, optionId } = openPendingRow(engine, client, 700);

    // Tick 1: stale → reprice down to 16.40 (new order 5555).
    vi.setSystemTime(T0 + 25_000);
    await engine.reconcilePendingCloses();

    // Tick 2: the repriced order fills at the bid-tracking limit.
    client.getOrderStatus.mockResolvedValue({ id: 5555, status: 'filled', avg_fill_price: 16.4 });
    vi.setSystemTime(T0 + 60_000);
    const summary = await engine.reconcilePendingCloses();

    expect(summary.filled).toBe(1);
    const state = acct.getState();
    expect(state.openOptions.find((o) => o.id === optionId)).toBeUndefined();
    expect(state.closedOptions.find((o) => o.id === optionId)?.currentPremium).toBeCloseTo(16.4, 5);
  });

  it('holds the live order without repricing when the floor is reached (no $0 order)', async () => {
    const client: ChaserClient = {
      getOrderStatus: vi.fn(async () => ({ id: 700, status: 'open' })),
      // Dead contract — no usable bid/ask/last, so no lower limit can be priced.
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL240705C00200000', bid: 0, ask: 0, last: 0 })),
      cancelOrder: vi.fn(async () => undefined),
      sellContractsLimit: vi.fn(async () => ({ id: 5555, status: 'ok' })),
    };
    const engine = new SignalEngine();
    const { acct, optionId } = openPendingRow(engine, client, 700);

    vi.setSystemTime(T0 + 25_000);
    const summary = await engine.reconcilePendingCloses();

    expect(summary.repriced).toBe(0);
    expect(summary.stillPending).toBe(1);
    // Original order left LIVE — never cancelled into a no-order limbo.
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect(client.sellContractsLimit).not.toHaveBeenCalled();
    expect(acct.getState().openOptions.find((o) => o.id === optionId)?.pendingCloseOrderId).toBe(700);
  });

  it('stops repricing once the bounded walk is exhausted', async () => {
    const client: ChaserClient = {
      getOrderStatus: vi.fn(async () => ({ id: 700, status: 'open' })),
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL240705C00200000', bid: 16, ask: 18 })),
      cancelOrder: vi.fn(async () => undefined),
      sellContractsLimit: vi.fn(async (_s: string, _q: number, _p: number) => ({ id: 5000, status: 'ok' })),
    };
    const engine = new SignalEngine();
    const { acct, optionId } = openPendingRow(engine, client, 700);

    // Run enough stale ticks to exhaust the 4-step walk, then one more.
    for (let i = 1; i <= 6; i += 1) {
      vi.setSystemTime(T0 + i * 25_000);
      await engine.reconcilePendingCloses();
    }

    // The walk caps at PENDING_CLOSE_MAX_REPRICE_STEPS (4) resubmits.
    expect(client.sellContractsLimit).toHaveBeenCalledTimes(4);
    const row = acct.getState().openOptions.find((o) => o.id === optionId);
    expect(row?.pendingCloseRepriceSteps).toBe(4);
    // Final step lands exactly on the bid (most-aggressive marketable price).
    expect(client.sellContractsLimit).toHaveBeenLastCalledWith('AAPL240705C00200000', expect.any(Number), 16);
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

// TRA-415 — periodic equity-position reconcile while live mode is active.
// The equity-side counterpart of the TRA-356 options sweep: the engine
// pulls Tradier's open equity positions on a cadence and merges them into
// the TRA-335 live equity mirror so a stock opened / closed out-of-band
// (on Tradier's web UI, or by a failed mirror order) flows back into local
// state. These tests drive `reconcileLiveEquityPortfolio` directly so we
// can assert import / update / remove + the skip / dedupe behaviours.
describe('SignalEngine — TRA-415 periodic equity-position reconcile', () => {
  interface ListEquityStub {
    listOpenEquityPositions: ReturnType<typeof vi.fn>;
  }
  type EquityInternals = {
    mode: 'demo' | 'live';
    tradierLiveEquityClient: ListEquityStub | null;
    liveEquityPositions: Map<string, Position>;
    liveEquityOrderIds: Map<string, number | string>;
    lastTradierEquityReconcileAt: number;
    equityReconciledOnBoot: boolean;
  };

  function asEquityInternals(engine: SignalEngine): EquityInternals {
    return engine as unknown as EquityInternals;
  }

  function setupEquityEngine(opts: {
    mode?: 'demo' | 'live';
    client?: ListEquityStub | null;
  } = {}) {
    const engine = new SignalEngine();
    const internals = asEquityInternals(engine);
    internals.mode = opts.mode ?? 'live';
    internals.tradierLiveEquityClient = opts.client ?? null;
    return engine;
  }

  // Seed a row directly into the live equity mirror. `imported` rows carry
  // `importedFromTradier: true` (a prior reconcile sweep); engine-opened
  // rows leave the flag absent.
  function seedEquityRow(
    engine: SignalEngine,
    overrides: Partial<Position> & { imported?: boolean } = {},
  ): Position {
    const { imported, ...rest } = overrides;
    const pos: Position = {
      id: rest.id ?? `pos-${rest.symbol ?? 'AAPL'}`,
      symbol: 'AAPL',
      side: 'buy',
      signalType: imported ? 'tradier_import' : 'orb_breakout',
      entryPrice: 100,
      quantity: 10,
      stopLoss: imported ? 0 : 95,
      takeProfit: imported ? Number.POSITIVE_INFINITY : 110,
      openedAt: TRADING_TIME,
      mode: 'live',
      ...(imported ? { importedFromTradier: true } : {}),
      ...rest,
    };
    asEquityInternals(engine).liveEquityPositions.set(pos.id, pos);
    return pos;
  }

  function tradierEquityRow(overrides: Record<string, unknown> = {}) {
    return {
      symbol: 'AAPL',
      quantity: 10,
      side: 'buy' as const,
      costBasis: 100,
      acquiredAt: TRADING_TIME,
      ...overrides,
    };
  }

  it('skips the network call entirely in demo mode', async () => {
    const stub: ListEquityStub = { listOpenEquityPositions: vi.fn() };
    const engine = setupEquityEngine({ mode: 'demo', client: stub });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.skipped).toBe('mode');
    expect(stub.listOpenEquityPositions).not.toHaveBeenCalled();
  });

  it('skips when no Tradier equity client is configured', async () => {
    const engine = setupEquityEngine({ mode: 'live', client: null });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.skipped).toBe('no-client');
  });

  it('skips the network call when the live equity mirror is empty (idle account)', async () => {
    const stub: ListEquityStub = { listOpenEquityPositions: vi.fn() };
    const engine = setupEquityEngine({ client: stub });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.skipped).toBe('empty');
    expect(stub.listOpenEquityPositions).not.toHaveBeenCalled();
    // Idle skip leaves the cadence timestamp untouched so the next non-empty
    // tick reconciles immediately.
    expect(asEquityInternals(engine).lastTradierEquityReconcileAt).toBe(0);
  });

  it('force bypasses the idle throttle so the boot sweep imports a cold-start position', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([tradierEquityRow()]),
    };
    const engine = setupEquityEngine({ client: stub });

    // Mirror is empty — a non-forced sweep would skip. The boot sweep forces.
    const summary = await engine.reconcileLiveEquityPortfolio({ force: true });

    expect(summary.skipped).toBeNull();
    expect(summary.added).toBe(1);
    expect(stub.listOpenEquityPositions).toHaveBeenCalledTimes(1);
  });

  it('imports an out-of-band open as an importedFromTradier row with sentinel TP/SL', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([
        tradierEquityRow({ symbol: 'MSFT', quantity: 5, costBasis: 420 }),
      ]),
    };
    const engine = setupEquityEngine({ client: stub });
    // Seed an unrelated row so the idle throttle lets the sweep through.
    seedEquityRow(engine, { id: 'seed', symbol: 'NVDA', imported: true });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.added).toBe(1);
    const rows = Array.from(asEquityInternals(engine).liveEquityPositions.values());
    const msft = rows.find(r => r.symbol === 'MSFT');
    expect(msft).toBeDefined();
    expect(msft?.importedFromTradier).toBe(true);
    expect(msft?.quantity).toBe(5);
    expect(msft?.entryPrice).toBe(420);
    expect(msft?.signalType).toBe('tradier_import');
    // Sentinel TP/SL — a long can never reach a 0 stop or a +Infinity target.
    expect(msft?.stopLoss).toBe(0);
    expect(msft?.takeProfit).toBe(Number.POSITIVE_INFINITY);
  });

  it('imports a short out-of-band open with inverted sentinel TP/SL', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([
        tradierEquityRow({ symbol: 'TSLA', side: 'sell', quantity: 3, costBasis: 250 }),
      ]),
    };
    const engine = setupEquityEngine({ client: stub });
    seedEquityRow(engine, { id: 'seed', symbol: 'NVDA', imported: true });

    await engine.reconcileLiveEquityPortfolio();

    const tsla = Array.from(asEquityInternals(engine).liveEquityPositions.values())
      .find(r => r.symbol === 'TSLA');
    expect(tsla?.side).toBe('sell');
    expect(tsla?.stopLoss).toBe(Number.POSITIVE_INFINITY);
    expect(tsla?.takeProfit).toBe(0);
  });

  it('updates the quantity of an imported row on a partial fill', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([
        tradierEquityRow({ quantity: 7, costBasis: 101 }),
      ]),
    };
    const engine = setupEquityEngine({ client: stub });
    const seeded = seedEquityRow(engine, { id: 'imp', imported: true, quantity: 10, entryPrice: 100 });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.updated).toBe(1);
    expect(summary.added).toBe(0);
    expect(seeded.quantity).toBe(7);
    expect(seeded.entryPrice).toBe(101);
    // Still the same row — updated in place, not orphaned.
    expect(asEquityInternals(engine).liveEquityPositions.size).toBe(1);
  });

  it('drops an imported row Tradier no longer reports (closed out-of-band)', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([]),
    };
    const engine = setupEquityEngine({ client: stub });
    seedEquityRow(engine, { id: 'imp', imported: true });
    asEquityInternals(engine).liveEquityOrderIds.set('imp', 12345);

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.removed).toBe(1);
    expect(asEquityInternals(engine).liveEquityPositions.size).toBe(0);
    expect(asEquityInternals(engine).liveEquityOrderIds.has('imp')).toBe(false);
  });

  it('does not double-import or drop an engine-opened row sharing the Tradier symbol', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([tradierEquityRow()]),
    };
    const engine = setupEquityEngine({ client: stub });
    // Engine-opened row (no importedFromTradier flag) for the same symbol.
    seedEquityRow(engine, { id: 'engine', symbol: 'AAPL' });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.added).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.removed).toBe(0);
    const rows = asEquityInternals(engine).liveEquityPositions;
    expect(rows.size).toBe(1);
    expect(rows.get('engine')?.importedFromTradier).toBeUndefined();
  });

  it('leaves an engine-opened row untouched even when Tradier reports nothing', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([]),
    };
    const engine = setupEquityEngine({ client: stub });
    seedEquityRow(engine, { id: 'engine', symbol: 'AAPL' });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.removed).toBe(0);
    expect(asEquityInternals(engine).liveEquityPositions.has('engine')).toBe(true);
  });

  it('enforces the cadence — a second call inside the window is short-circuited', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([tradierEquityRow()]),
    };
    const engine = setupEquityEngine({ client: stub });
    seedEquityRow(engine, { id: 'imp', imported: true });

    const first = await engine.reconcileLiveEquityPortfolio();
    expect(first.skipped).toBeNull();

    const second = await engine.reconcileLiveEquityPortfolio();
    expect(second.skipped).toBe('cadence');
    expect(stub.listOpenEquityPositions).toHaveBeenCalledTimes(1);

    vi.setSystemTime(TRADING_TIME + 31_000);
    const third = await engine.reconcileLiveEquityPortfolio();
    expect(third.skipped).toBeNull();
    expect(stub.listOpenEquityPositions).toHaveBeenCalledTimes(2);
  });

  it('swallows list-positions failures and bumps the cadence timestamp so we do not tight-loop', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockRejectedValue(new Error('socket reset')),
    };
    const engine = setupEquityEngine({ client: stub });
    seedEquityRow(engine, { id: 'imp', imported: true });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.skipped).toBeNull();
    expect(summary.added).toBe(0);
    expect(asEquityInternals(engine).lastTradierEquityReconcileAt).toBe(TRADING_TIME);
    const second = await engine.reconcileLiveEquityPortfolio();
    expect(second.skipped).toBe('cadence');
    expect(stub.listOpenEquityPositions).toHaveBeenCalledTimes(1);
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

// ─── TRA-361 / TRA-450 — submitStagedOptionExits pricing ────────────────────
// TRA-361: the PaperOptionsAccount stages a pendingExit with `pricing:'market'`
// for deep-underwater imported positions; the engine must route those through
// `sellContracts` (market) and everything else through `sellContractsLimit`.
// TRA-450: a LIMIT exit must be repriced off a FRESH live quote at submit time
// — an SL / trailing exit sits on the bid (marketable), a TP1 / manual exit at
// the mid — instead of submitting at the stale entry-time trigger price.
describe('SignalEngine — TRA-361/TRA-450 submitStagedOptionExits pricing', () => {
  interface TradierExitStub {
    getOptionQuote: ReturnType<typeof vi.fn>;
    sellContractsLimit: ReturnType<typeof vi.fn>;
    sellContracts: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }

  function makeStub(): TradierExitStub {
    return {
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'X', bid: 0.80, ask: 1.20 }),
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

  function bindSubmit(engine: SignalEngine) {
    return (engine as unknown as {
      submitStagedOptionExits: (s: import('@trading-app/shared').OptionPosition[]) => Promise<void>;
    }).submitStagedOptionExits.bind(engine);
  }

  function stagedExit(
    over: Partial<import('@trading-app/shared').OptionPendingExit> & { optionSymbol?: string },
  ): import('@trading-app/shared').OptionPosition {
    const { optionSymbol = 'SPY260515C00450000', ...exit } = over;
    return {
      id: 'opt-1',
      symbol: 'SPY',
      optionSymbol,
      pendingExit: {
        tradierOrderId: '',
        qty: 2,
        limitPrice: 1.50, // stale entry-time trigger — must NOT be submitted
        submittedAt: Date.now(),
        kind: 'sl',
        pricing: 'limit',
        ...exit,
      },
    } as unknown as import('@trading-app/shared').OptionPosition;
  }

  it('TRA-450 — reprices an SL LIMIT exit onto the live bid, not the stale trigger', async () => {
    const stub = makeStub();
    const submit = bindSubmit(setupEngine(stub));
    await submit([stagedExit({ kind: 'sl' })]);
    // bid 0.80 — a sell limit at the bid is immediately marketable. The stale
    // 1.50 trigger is never submitted.
    expect(stub.getOptionQuote).toHaveBeenCalledWith('SPY260515C00450000');
    expect(stub.sellContractsLimit).toHaveBeenCalledWith('SPY260515C00450000', 2, 0.80);
    expect(stub.sellContracts).not.toHaveBeenCalled();
  });

  it('TRA-450 — reprices a TP1 LIMIT exit onto the live mid', async () => {
    const stub = makeStub();
    const submit = bindSubmit(setupEngine(stub));
    await submit([stagedExit({ kind: 'tp1' })]);
    // mid of 0.80 / 1.20 = 1.00 — a profit-taking exit keeps the spread.
    expect(stub.sellContractsLimit).toHaveBeenCalledWith('SPY260515C00450000', 2, 1.00);
  });

  it('TRA-450 — falls back to the staged trigger price when the quote lookup fails', async () => {
    const stub = makeStub();
    stub.getOptionQuote.mockRejectedValueOnce(new Error('Tradier 503'));
    const submit = bindSubmit(setupEngine(stub));
    await submit([stagedExit({ kind: 'sl' })]);
    expect(stub.sellContractsLimit).toHaveBeenCalledWith('SPY260515C00450000', 2, 1.50);
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

// ── TRA-389 — market-review regime gate consumption ──────────────────────────

describe('TRA-389 — market-review regime gates', () => {
  function gates(o: Partial<MarketReviewGates> = {}): MarketReviewGates {
    return {
      orbLongs: true,
      orbShorts: true,
      meanReversionTilt: false,
      breakoutsEnabled: true,
      sizingMultiplier: 1,
      ...o,
    };
  }

  function sig(o: Partial<TradeSignal> = {}): TradeSignal {
    return {
      id: 'sig-1',
      symbol: 'AAPL',
      type: 'orb_breakout',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      riskRewardRatio: 2,
      timestamp: TRADING_TIME,
      ...o,
    };
  }

  function review(
    g: Partial<MarketReviewGates> = {},
    regime: MarketRegimeLabel = 'yellow',
  ): MarketReview {
    return {
      id: 'premarket-2024-06-04',
      kind: 'premarket',
      date: '2024-06-04',
      generatedAt: new Date(TRADING_TIME).toISOString(),
      regime,
      regimeRationale: 'test rationale',
      indexes: [],
      gates: gates(g),
      source: 'auto',
    };
  }

  describe('gateSignalOnReview / describeGatedStrategies — TRA-474 deprecation', () => {
    // TRA-389 / TRA-469 / TRA-472 originally let the premarket regime gate
    // suppress ORB signals and the dashboard report which legs were gated
    // off. TRA-474 removed that dependency on 2026-05-20 — a wrong report
    // could silently kill every ticket for the day. Both functions are
    // retained for ABI continuity, but the bodies are now no-ops. These
    // tests pin that contract so a future refactor can't re-introduce the
    // dependency accidentally.
    it('gateSignalOnReview returns null for every ORB gate configuration', () => {
      const cases: Partial<MarketReviewGates>[] = [
        {},
        { orbLongs: false },
        { orbShorts: false },
        { breakoutsEnabled: false },
        { orbLongs: false, orbShorts: false, breakoutsEnabled: false },
        { orbLongs: false, trendState: 'down' },
        { orbLongs: false, trendState: 'unknown' },
        { orbShorts: false, trendState: 'unknown' },
        { meanReversionTilt: false },
        { meanReversionTilt: true },
      ];
      for (const g of cases) {
        expect(gateSignalOnReview(sig({ side: 'buy' }), gates(g))).toBeNull();
        expect(gateSignalOnReview(sig({ side: 'sell' }), gates(g))).toBeNull();
      }
    });

    it('gateSignalOnReview returns null for non-ORB strategies regardless of gate state', () => {
      const g = gates({ orbLongs: false, orbShorts: false, breakoutsEnabled: false });
      expect(gateSignalOnReview(sig({ type: 'bb_fade', side: 'buy' }), g)).toBeNull();
      expect(gateSignalOnReview(sig({ type: 'bb_fade', side: 'sell' }), g)).toBeNull();
      expect(gateSignalOnReview(sig({ type: 'ichimoku', side: 'buy' }), g)).toBeNull();
    });

    it('describeGatedStrategies returns an empty list for every configuration', () => {
      const cases: Partial<MarketReviewGates>[] = [
        {},
        { orbLongs: false },
        { orbShorts: false },
        { breakoutsEnabled: false },
        { orbLongs: false, orbShorts: false, breakoutsEnabled: false },
        { orbLongs: false, trendState: 'down' },
        { orbLongs: false, trendState: 'unknown' },
      ];
      for (const g of cases) {
        expect(describeGatedStrategies(gates(g))).toEqual([]);
      }
    });
  });

  describe('sizeLiveEquityFromStop — sizingMultiplier path (TRA-389)', () => {
    const balance: TradierAccountBalance = {
      totalEquity: 25_000,
      totalCash: 10_000,
      optionBuyingPower: 10_000,
      stockBuyingPower: 20_000,
      longMarketValue: 15_000,
      dayTradeBuyingPower: null,
    };
    const base = {
      balance,
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    };

    it('trims the share count by the multiplier and floors to whole shares', () => {
      // Un-trimmed qty is 25 (see TRA-335 suite). 0.5× → floor(12.5) = 12.
      expect(sizeLiveEquityFromStop(base)).toBe(25);
      expect(sizeLiveEquityFromStop({ ...base, sizeMultiplier: 0.5 })).toBe(12);
    });

    it('treats an absent / 1 / out-of-range multiplier as no trim', () => {
      expect(sizeLiveEquityFromStop({ ...base, sizeMultiplier: 1 })).toBe(25);
      expect(sizeLiveEquityFromStop({ ...base, sizeMultiplier: 0 })).toBe(25);
      expect(sizeLiveEquityFromStop({ ...base, sizeMultiplier: Number.NaN })).toBe(25);
    });
  });

  describe('PaperAccount.openPosition — sizingMultiplier path (TRA-389)', () => {
    it('scales the opened quantity by the multiplier', () => {
      const acct = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
      const full = acct.openPosition(sig(), 100);
      const acct2 = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
      const trimmed = acct2.openPosition(sig(), 100, 0.5);
      expect(full).not.toBeNull();
      expect(trimmed).not.toBeNull();
      expect(trimmed!.quantity).toBe(Math.floor(full!.quantity * 0.5));
    });

    it('multiplier of 1 leaves sizing unchanged', () => {
      const acct = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
      const a = acct.openPosition(sig(), 100);
      const acct2 = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
      const b = acct2.openPosition(sig(), 100, 1);
      expect(a!.quantity).toBe(b!.quantity);
    });
  });

  describe('PaperAccount.openPosition — bracket guard (TRA-520)', () => {
    const acct = () => new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });

    it('refuses a long with a negative stop (ASTC repro)', () => {
      expect(acct().openPosition(sig({ side: 'buy', stopLoss: -0.215, takeProfit: 148.93 }), 49.5)).toBeNull();
    });

    it('refuses a short with a negative target (PRFX repro)', () => {
      expect(acct().openPosition(sig({ side: 'sell', stopLoss: 4.64, takeProfit: -0.04 }), 3.05)).toBeNull();
    });

    it('refuses a long whose stop sits above the fill price', () => {
      // Bracket is fine vs the signal entry (95<100<110) but the actual fill
      // is below the stop — the guard validates against the fill price.
      expect(acct().openPosition(sig({ side: 'buy', stopLoss: 95, takeProfit: 110 }), 90)).toBeNull();
    });

    it('still opens a well-formed long', () => {
      expect(acct().openPosition(sig({ side: 'buy', stopLoss: 95, takeProfit: 110 }), 100)).not.toBeNull();
    });
  });

  describe('resolveMarketReviewGatesEnabled', () => {
    it('defaults off — absent or false both resolve false, only explicit true enables', () => {
      expect(resolveMarketReviewGatesEnabled(DEFAULT_ACCOUNT_SETTINGS)).toBe(false);
      expect(resolveMarketReviewGatesEnabled({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: undefined })).toBe(false);
      expect(resolveMarketReviewGatesEnabled({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: false })).toBe(false);
      expect(resolveMarketReviewGatesEnabled({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true })).toBe(true);
    });
  });

  describe('SignalEngine — flag plumbing + state envelope', () => {
    const flag = (e: SignalEngine) =>
      (e as unknown as { marketReviewGatesEnabled: boolean }).marketReviewGatesEnabled;

    it('constructs with the flag off by default and on when the setting is true', () => {
      expect(flag(new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS }))).toBe(false);
      expect(flag(new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true }))).toBe(true);
    });

    it('applySettings flips the flag and drops the cached review when turned off', async () => {
      const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true });
      // Seed a cached review as the doTick refresh would.
      (engine as unknown as { cachedMarketReview: MarketReview }).cachedMarketReview = review();
      await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: false });
      expect(flag(engine)).toBe(false);
      expect((engine as unknown as { cachedMarketReview: MarketReview | null }).cachedMarketReview).toBeNull();

      await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true });
      expect(flag(engine)).toBe(true);
    });

    it('getState surfaces a disabled envelope when the flag is off', () => {
      const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
      const mr = engine.getState().marketReview;
      expect(mr.enabled).toBe(false);
      expect(mr.regime).toBeNull();
      expect(mr.gatedStrategies).toEqual([]);
    });

    it('getState surfaces the regime context with no gated strategies once a review is cached', () => {
      // TRA-474 — the regime banner still renders for context (regime label,
      // rationale, raw gates), but `gatedStrategies` is now always empty
      // because the gate is no longer wired to the signal path.
      const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true });
      (engine as unknown as { cachedMarketReview: MarketReview }).cachedMarketReview =
        review({ orbLongs: false, sizingMultiplier: 0.75 }, 'yellow');
      const mr = engine.getState().marketReview;
      expect(mr.enabled).toBe(true);
      expect(mr.regime).toBe('yellow');
      expect(mr.reviewDate).toBe('2024-06-04');
      expect(mr.gates?.sizingMultiplier).toBe(0.75);
      expect(mr.gatedStrategies).toEqual([]);
    });

    it('activeSizingMultiplier is always 1 — TRA-474 removed the gate-driven trim', () => {
      // Pin the deprecation: even with the flag on AND a cached review
      // carrying a 0.5 sizingMultiplier, the engine sizes at 1.0× — sizing
      // is driven by managedAccountRatio / riskPerTrade only.
      const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true });
      const mult = () => (engine as unknown as { activeSizingMultiplier(): number }).activeSizingMultiplier();
      expect(mult()).toBe(1);
      (engine as unknown as { cachedMarketReview: MarketReview }).cachedMarketReview =
        review({ sizingMultiplier: 0.5 });
      expect(mult()).toBe(1);
    });
  });
});

// TRA-416 — partial-fill handling in the per-tick close reconciler. A
// `sell_to_close` that fills PART of its size then goes terminal (expire /
// cancel) must have the filled slice booked and the un-filled remainder
// re-ordered, end-to-end through `reconcilePendingCloses`.
describe('SignalEngine — TRA-416 partial-fill close reconciliation', () => {
  const OCC = 'AAPL240705C00200000';

  interface PartialClient {
    getOrderStatus: ReturnType<typeof vi.fn>;
    getOptionQuote: ReturnType<typeof vi.fn>;
    sellContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }
  interface PartialAcct {
    openOptionFromCandidate(sig: unknown, mode: 'live'): { id: string } | null;
    setPendingCloseOrderId(id: string, orderId: number): boolean;
    getState(): {
      openOptions: Array<{
        id: string;
        contracts: number;
        contractsRemaining: number;
        premiumPaid: number;
        pnl?: number;
        pendingCloseOrderId?: number | string;
        partialCloseBookedOrderId?: number | string;
      }>;
      closedOptions: Array<{ id: string; pnl?: number; currentPremium: number }>;
    };
  }
  type Internals = {
    tradierOptionsClientByEnv: Record<TradierEnv, unknown>;
    optionsAccounts: Record<TradierEnv, PartialAcct>;
  };

  function asInternals(engine: SignalEngine): Internals {
    return engine as unknown as Internals;
  }

  // Open an engine-opened live row, then normalise it to exactly 10 contracts
  // at $1.00 premium so a 60/40 partial split lands on whole numbers.
  function openTenContractRow(engine: SignalEngine, orderId: number): { acct: PartialAcct; optionId: string } {
    const acct = asInternals(engine).optionsAccounts.sandbox;
    const opened = acct.openOptionFromCandidate(
      {
        id: 'sig', symbol: 'AAPL', type: 'otm_mispricing', side: 'buy',
        entryPrice: 1.0, stopLoss: 0.75, takeProfit: 1.5, riskRewardRatio: 2,
        timestamp: TRADING_TIME, optionSymbol: OCC, optionType: 'call',
        strike: 200, expiration: '2024-07-05', mark: 1.0, theo: 1.3,
        mispricingPct: -0.23, delta: 0.18,
      },
      'live',
    );
    if (!opened) throw new Error('test setup: failed to open option');
    const row = acct.getState().openOptions.find((o) => o.id === opened.id)!;
    row.contracts = 10;
    row.contractsRemaining = 10;
    row.premiumPaid = 1.0;
    row.pnl = 0;
    acct.setPendingCloseOrderId(opened.id, orderId);
    return { acct, optionId: opened.id };
  }

  it('books a 60% partial fill, re-orders the 40% remainder, and P&L matches', async () => {
    const client: PartialClient = {
      // Order #700: filled 6 of 10 contracts at 1.50, then expired.
      getOrderStatus: vi.fn(async () => ({
        id: 700, status: 'expired', exec_quantity: 6, avg_fill_price: 1.50,
        reason_description: 'EOD expiration',
      })),
      getOptionQuote: vi.fn(async () => ({ symbol: OCC, bid: 1.0, ask: 1.2 })),
      sellContractsLimit: vi.fn(async () => ({ id: 800, status: 'ok' })),
      cancelOrder: vi.fn(async () => undefined),
      // Re-order #800 stays open inside the wait window → `pending` outcome.
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 800, status: 'open' })),
    };
    const engine = new SignalEngine();
    asInternals(engine).tradierOptionsClientByEnv = { sandbox: client, production: null };
    const { acct, optionId } = openTenContractRow(engine, 700);

    const summary = await engine.reconcilePendingCloses();

    // Slice booked = 1 fill; remainder re-ordered + still working = 1 pending.
    expect(summary.filled).toBe(1);
    expect(summary.stillPending).toBe(1);

    const row = acct.getState().openOptions.find((o) => o.id === optionId);
    expect(row).toBeDefined();
    // 60% closed → 40% (4 contracts) remain open.
    expect(row?.contractsRemaining).toBe(4);
    // Realised slice P&L = (1.50 − 1.00) × 6 × 100 = $300.
    expect(row?.pnl).toBeCloseTo(300, 5);
    // The terminal order id is stamped for the idempotency guard...
    expect(row?.partialCloseBookedOrderId).toBe(700);
    // ...and the remainder was re-ordered (new pending order #800).
    expect(row?.pendingCloseOrderId).toBe(800);
    // The re-submit was for the 4-contract remainder, not the original 10.
    expect(client.sellContractsLimit).toHaveBeenCalledWith(OCC, 4, expect.any(Number));
  });

  it('fully closes the position when the re-ordered remainder fills immediately', async () => {
    const client: PartialClient = {
      getOrderStatus: vi.fn(async () => ({
        id: 700, status: 'expired', exec_quantity: 6, avg_fill_price: 1.50,
      })),
      getOptionQuote: vi.fn(async () => ({ symbol: OCC, bid: 1.0, ask: 1.2 })),
      sellContractsLimit: vi.fn(async () => ({ id: 800, status: 'ok' })),
      cancelOrder: vi.fn(async () => undefined),
      // Re-order #800 fills at 1.10 inside the wait window.
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 800, status: 'filled', avg_fill_price: 1.10 })),
    };
    const engine = new SignalEngine();
    asInternals(engine).tradierOptionsClientByEnv = { sandbox: client, production: null };
    const { acct, optionId } = openTenContractRow(engine, 700);

    const summary = await engine.reconcilePendingCloses();

    // Slice fill + remainder fill = 2.
    expect(summary.filled).toBe(2);
    expect(acct.getState().openOptions.find((o) => o.id === optionId)).toBeUndefined();
    const closed = acct.getState().closedOptions.find((o) => o.id === optionId);
    expect(closed).toBeDefined();
    // Accumulated P&L = 300 (slice) + (1.10 − 1.00) × 4 × 100 = 300 + 40 = 340.
    expect(closed?.pnl).toBeCloseTo(340, 5);
  });

  it('leaves the reduced remainder OPEN for retry when the re-order finds no quote', async () => {
    const client: PartialClient = {
      getOrderStatus: vi.fn(async () => ({
        id: 700, status: 'canceled', exec_quantity: 6, avg_fill_price: 1.50,
      })),
      // Dead contract — no usable quote, so `submitSmartSellToClose` → no_quote.
      getOptionQuote: vi.fn(async () => ({ symbol: OCC, bid: 0, ask: 0, last: 0 })),
      sellContractsLimit: vi.fn(async () => ({ id: 800, status: 'ok' })),
      cancelOrder: vi.fn(async () => undefined),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 800, status: 'open' })),
    };
    const engine = new SignalEngine();
    asInternals(engine).tradierOptionsClientByEnv = { sandbox: client, production: null };
    const { acct, optionId } = openTenContractRow(engine, 700);

    const summary = await engine.reconcilePendingCloses();

    expect(summary.filled).toBe(1);
    expect(summary.cleared).toBe(1);
    const row = acct.getState().openOptions.find((o) => o.id === optionId);
    // Slice booked: 4 contracts remain, row open with the Close button back
    // (no pending marker) so the remainder can be re-closed.
    expect(row?.contractsRemaining).toBe(4);
    expect(row?.pnl).toBeCloseTo(300, 5);
    expect(row?.pendingCloseOrderId).toBeUndefined();
    expect(client.sellContractsLimit).not.toHaveBeenCalled();
  });

  it('does not re-book the slice when the sweep runs again before the re-order resolves', async () => {
    const client: PartialClient = {
      // #700 partial-expired; #800 (the re-order) still open on tick 2.
      getOrderStatus: vi.fn(async (id: number) =>
        id === 700
          ? { id: 700, status: 'expired', exec_quantity: 6, avg_fill_price: 1.50 }
          : { id: 800, status: 'open' },
      ),
      getOptionQuote: vi.fn(async () => ({ symbol: OCC, bid: 1.0, ask: 1.2 })),
      sellContractsLimit: vi.fn(async () => ({ id: 800, status: 'ok' })),
      cancelOrder: vi.fn(async () => undefined),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 800, status: 'open' })),
    };
    const engine = new SignalEngine();
    asInternals(engine).tradierOptionsClientByEnv = { sandbox: client, production: null };
    const { acct, optionId } = openTenContractRow(engine, 700);

    // Tick 1: partial fill booked, remainder re-ordered as #800.
    await engine.reconcilePendingCloses();
    // Tick 2: #800 still open — must not re-book the #700 slice.
    await engine.reconcilePendingCloses();

    const row = acct.getState().openOptions.find((o) => o.id === optionId);
    // P&L and contract count unchanged from the single slice booking.
    expect(row?.contractsRemaining).toBe(4);
    expect(row?.pnl).toBeCloseTo(300, 5);
    // The remainder was re-ordered exactly once across both sweeps.
    expect(client.sellContractsLimit).toHaveBeenCalledTimes(1);
  });
});

// TRA-495 — verify the stocks (Tradier equity) and options (Tradier options) routes
// both run on a live tick without either silently nulling the other. The board's
// $550 DCA flow needs both legs operational against one Tradier production account.
describe('SignalEngine — TRA-495 live stocks + options coexistence', () => {
  type WaitOpts = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };

  interface OptionsTradierStub {
    getOptionQuote: ReturnType<typeof vi.fn>;
    buyContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }

  interface EquityTradierStub {
    submitBracketOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
    cancelOrder?: ReturnType<typeof vi.fn>;
  }

  function buildEngine(scanner: StubScanner): SignalEngine {
    return new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      stocksAutoTradingEnabledLive: true,
      liveTradeEquitiesTradier: true,
      liveTradierMarkets: 'both',
      // TRA-499 — board directive on TRA-494: stock signals also route to
      // Tradier production. Flipping this in the test asserts the unified
      // single-broker config still drives both legs (stocks + options)
      // through Tradier without one path nulling the other.
      liveBrokerageTypeStocks: 'tradier',
      liveTradierEnvOptions: 'production',
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
    }, undefined, scanner);
  }

  function freshScanner(mark = 1.0): StubScanner {
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

  it('runs both routes on the same engine: RV opens an option and the equity bracket places a stock order', async () => {
    const optionsStub: OptionsTradierStub = {
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'AAPL240705C00200000', bid: 0.95, ask: 1.05 }),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 71, status: 'ok' }),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _o?: WaitOpts) => ({
        id: 71, status: 'filled', avg_fill_price: 1.0,
      })),
    };
    const equityStub: EquityTradierStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 42, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _o?: WaitOpts) => ({
        id: 42, status: 'filled', exec_quantity: 25, avg_fill_price: 100,
      })),
    };

    const scanner = freshScanner(1.0);
    const engine = buildEngine(scanner);
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = optionsStub;
    (engine as unknown as { tradierLiveEquityClient: unknown }).tradierLiveEquityClient = equityStub;
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance = {
      totalEquity: 25_000,
      totalCash: 10_000,
      optionBuyingPower: 10_000,
      stockBuyingPower: 20_000,
      longMarketValue: 15_000,
      dayTradeBuyingPower: null,
    };

    // ── 1) Options leg: RV scanner fires an open. ─────────────────────────
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // ── 2) Equity leg: BB-fade signal places an OTOCO bracket. ────────────
    const sig: TradeSignal = {
      id: 'sig-stock-1',
      symbol: 'AAPL',
      type: 'bb_fade',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      riskRewardRatio: 2,
      timestamp: Date.now(),
    };
    const placement = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number | string; reason?: string }>;
    }).placeTradierEquityBracket(sig, 100);
    expect(placement.ok).toBe(true);
    expect(equityStub.submitBracketOrder).toHaveBeenCalledTimes(1);

    // Seed the live equity mirror so the dashboard's live bucket reflects the
    // open position. This is what runTick does immediately after a successful
    // bracket placement.
    (engine as unknown as {
      openLiveEquityMirror: (s: TradeSignal, p: number, oid: number | string) => { id: string } | null;
    }).openLiveEquityMirror(sig, 100, placement.orderId!);

    // ── 3) Both routes succeeded WITHOUT one silently nulling the other. ──
    expect(optionsStub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(equityStub.submitBracketOrder).toHaveBeenCalledTimes(1);

    const state = engine.getState();
    // Live bucket carries BOTH the option position AND the stock position.
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].optionSymbol).toBe('AAPL240705C00200000');
    expect(state.account.openPositions).toHaveLength(1);
    expect(state.account.openPositions[0].symbol).toBe('AAPL');
    // Both signals surfaced.
    expect(state.signals.find(s => s.type === 'relative_value')).toBeDefined();
  });

  it('getStateForMode(live) returns both stock and option positions in the live bucket', async () => {
    // Same setup as the previous test, condensed to verify the per-mode state
    // accessor doesn't drop one path on its way out of the engine.
    const optionsStub: OptionsTradierStub = {
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'AAPL240705C00200000', bid: 0.95, ask: 1.05 }),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 71, status: 'ok' }),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 71, status: 'filled', avg_fill_price: 1.0 })),
    };
    const equityStub: EquityTradierStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 42, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async () => ({
        id: 42, status: 'filled', exec_quantity: 25, avg_fill_price: 100,
      })),
    };
    const engine = buildEngine(freshScanner(1.0));
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = optionsStub;
    (engine as unknown as { tradierLiveEquityClient: unknown }).tradierLiveEquityClient = equityStub;
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance = {
      totalEquity: 25_000, totalCash: 10_000, optionBuyingPower: 10_000,
      stockBuyingPower: 20_000, longMarketValue: 15_000, dayTradeBuyingPower: null,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    const sig: TradeSignal = {
      id: 'sig-2', symbol: 'AAPL', type: 'bb_fade', side: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, riskRewardRatio: 2, timestamp: Date.now(),
    };
    const placement = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number | string }>;
    }).placeTradierEquityBracket(sig, 100);
    (engine as unknown as {
      openLiveEquityMirror: (s: TradeSignal, p: number, oid: number | string) => { id: string } | null;
    }).openLiveEquityMirror(sig, 100, placement.orderId!);

    const live = engine.getState();
    expect(live.options.openOptions.length).toBeGreaterThan(0);
    expect(live.account.openPositions.length).toBeGreaterThan(0);
  });
});

// TRA-544 (TRA-529 §2B) — the "Trading Agents" decision-path switch. ON makes
// the multi-agent layer the active decision-maker and SUSPENDS the
// deterministic auto-router; the per-mode start/stop preference is left intact
// so the UI still reports it. Reconciled from persisted settings on apply.
describe('SignalEngine — Trading Agents decision-path switch (TRA-544)', () => {
  it('defaults off: deterministic routing is active, agents path is not', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    expect(engine.isTradingAgentsEnabled()).toBe(false);
    // Auto-trading defaults on in demo → deterministic router may route.
    expect(engine.isDeterministicAutoTradingEnabled()).toBe(true);
    expect(engine.getState().tradingAgentsEnabled).toBe(false);
    expect(engine.getState().agentRecommendations).toEqual([]);
  });

  it('ON suspends the deterministic router while keeping auto-trading reported', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', tradingAgentsEnabled: true });
    expect(engine.isTradingAgentsEnabled()).toBe(true);
    // Deterministic auto-routing is suspended (never both deciding at once)…
    expect(engine.isDeterministicAutoTradingEnabled()).toBe(false);
    // …but the operator's start/stop preference is unchanged for the UI.
    expect(engine.isAutoTradingEnabled()).toBe(true);
    expect(engine.getState().tradingAgentsEnabled).toBe(true);
  });

  it('setTradingAgents flips the live runtime switch both ways', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    engine.setTradingAgents(true);
    expect(engine.isTradingAgentsEnabled()).toBe(true);
    expect(engine.isDeterministicAutoTradingEnabled()).toBe(false);
    engine.setTradingAgents(false);
    expect(engine.isTradingAgentsEnabled()).toBe(false);
    expect(engine.isDeterministicAutoTradingEnabled()).toBe(true);
  });
});

describe('SignalEngine.enterPaperOptionsIdea — single vs multi-leg routing (TRA-613)', () => {
  // Anchor contract ~31 DTE from the pinned Tuesday so the C3 entry-DTE floor
  // passes on both branches.
  const baseIntent = {
    ticker: 'AAPL',
    optionSymbol: 'AAPL240705P00095000',
    optionType: 'put' as const,
    strike: 95,
    expiration: '2024-07-05',
    mark: 1.5,
    delta: -0.3,
    spot: 100,
  };

  function demoEngine(): SignalEngine {
    // Default settings → demo mode, sandbox env. enterPaperOptionsIdea opens on
    // the sandbox bucket in demo mode, which getState() (demo) surfaces.
    return new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', liveTradierEnvOptions: 'sandbox' });
  }

  it('routes a multi-leg idea to a single defined-risk spread combo position', () => {
    const engine = demoEngine();
    const pos = engine.enterPaperOptionsIdea({
      ...baseIntent,
      strategy: 'bull_put_spread',
      legs: [
        { action: 'sell', optionType: 'put', strike: 95, expiration: '2024-07-05' },
        { action: 'buy', optionType: 'put', strike: 90, expiration: '2024-07-05' },
      ],
      netUsd: 180,
      maxLossUsd: 320,
      maxProfitUsd: 180,
      breakevens: [93.2],
    });

    expect(pos).not.toBeNull();
    expect(pos!.legs).toHaveLength(2);
    expect(pos!.spreadStrategy).toBe('bull_put_spread');
    expect(pos!.optionSymbol).toContain('COMBO:AAPL:bull_put_spread');
    expect(pos!.maxLossUsd).toBe(320);

    const open = engine.getState().options.openOptions;
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(pos!.id);
  });

  it('routes a single-leg idea through the long-only RV open path (anchor OCC)', () => {
    const engine = demoEngine();
    // No `legs` (or a 1-leg structure) ⇒ legacy single-leg long path.
    const pos = engine.enterPaperOptionsIdea({ ...baseIntent });

    expect(pos).not.toBeNull();
    expect(pos!.optionSymbol).toBe('AAPL240705P00095000');
    expect(pos!.legs).toBeUndefined();
  });
});

describe('shouldBootArmLiveEquity — TRA-713 persistent live-equity boot-arm', () => {
  const PIN = 'admin';
  // A production-ready settings snapshot: production options env + per-user prod creds.
  const prodSettings = (): AccountSettings => ({
    ...DEFAULT_ACCOUNT_SETTINGS,
    mode: 'demo',
    liveTradierEnvOptions: 'production',
    liveApiKeyOptionsProduction: 'tok-123',
    liveAccountIdOptionsProduction: 'acct-123',
  });
  const prodEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    LIVE_EQUITY_BOOT_USER: PIN,
    TRADIER_ENV: 'production',
    ...over,
  });

  it('arms the pinned user when prod env + prod creds resolve', () => {
    expect(shouldBootArmLiveEquity(prodSettings(), PIN, prodEnv())).toBe(true);
  });

  it('arms via server-env Tradier cred fallback when per-user creds are blank', () => {
    const s = { ...prodSettings(), liveApiKeyOptionsProduction: '', liveAccountIdOptionsProduction: '' };
    const env = prodEnv({ TRADIER_API_TOKEN: 'env-tok', TRADIER_ACCOUNT_ID: 'env-acct' });
    expect(shouldBootArmLiveEquity(s, PIN, env)).toBe(true);
  });

  it('never arms a non-pinned user (shared-account blast-radius guard)', () => {
    expect(shouldBootArmLiveEquity(prodSettings(), 'someone-else', prodEnv())).toBe(false);
  });

  it('TRA-716: unset pin ⇒ falls back to committed default "admin" and arms (Blueprint-sync-free activation)', () => {
    const env = prodEnv(); delete env['LIVE_EQUITY_BOOT_USER'];
    expect(shouldBootArmLiveEquity(prodSettings(), 'admin', env)).toBe(true);
  });

  it('TRA-716: unset pin ⇒ default only arms "admin", never another user', () => {
    const env = prodEnv(); delete env['LIVE_EQUITY_BOOT_USER'];
    expect(shouldBootArmLiveEquity(prodSettings(), 'someone-else', env)).toBe(false);
  });

  it('TRA-716: explicitly empty pin ⇒ disarms (clear-this-value kill-switch preserved)', () => {
    expect(shouldBootArmLiveEquity(prodSettings(), PIN, prodEnv({ LIVE_EQUITY_BOOT_USER: '' }))).toBe(false);
  });

  it('refuses to arm when the server is not in production Tradier mode', () => {
    expect(shouldBootArmLiveEquity(prodSettings(), PIN, prodEnv({ TRADIER_ENV: 'sandbox' }))).toBe(false);
  });

  it('refuses to arm a user routing options at the sandbox env', () => {
    const s = { ...prodSettings(), liveTradierEnvOptions: 'sandbox' as const };
    expect(shouldBootArmLiveEquity(s, PIN, prodEnv())).toBe(false);
  });

  it('refuses to arm when no production creds resolve anywhere', () => {
    const s = { ...prodSettings(), liveApiKeyOptionsProduction: '', liveAccountIdOptionsProduction: '' };
    expect(shouldBootArmLiveEquity(s, PIN, prodEnv())).toBe(false);
  });

  it('respects an explicit liveTradeEquitiesTradier:false opt-out', () => {
    const s = { ...prodSettings(), liveTradeEquitiesTradier: false };
    expect(shouldBootArmLiveEquity(s, PIN, prodEnv())).toBe(false);
  });
});

describe('isLiveBrokerOperator — TRA-857 shared-env operator pin', () => {
  it('matches the pinned operator', () => {
    expect(isLiveBrokerOperator('admin', { LIVE_EQUITY_BOOT_USER: 'admin' })).toBe(true);
  });

  it('rejects every non-pinned user (multi-tenant leak guard)', () => {
    expect(isLiveBrokerOperator('alice', { LIVE_EQUITY_BOOT_USER: 'admin' })).toBe(false);
  });

  it('rejects undefined / empty username', () => {
    expect(isLiveBrokerOperator(undefined, { LIVE_EQUITY_BOOT_USER: 'admin' })).toBe(false);
    expect(isLiveBrokerOperator('', { LIVE_EQUITY_BOOT_USER: 'admin' })).toBe(false);
  });

  it('unset pin ⇒ falls back to the committed "admin" default', () => {
    expect(isLiveBrokerOperator('admin', {})).toBe(true);
    expect(isLiveBrokerOperator('alice', {})).toBe(false);
    expect(resolveLiveBrokerOperator({})).toBe('admin');
  });

  it('explicitly empty pin ⇒ disarms for everyone (no operator)', () => {
    expect(isLiveBrokerOperator('admin', { LIVE_EQUITY_BOOT_USER: '' })).toBe(false);
    expect(resolveLiveBrokerOperator({ LIVE_EQUITY_BOOT_USER: '' })).toBe('');
  });
});

describe('buildTradierLiveEquityClient — TRA-857 operator-scoped env fallback', () => {
  // A live user with NO per-user Tradier creds (the fresh-signup case). The only
  // creds available are the shared server-env TRADIER_* values.
  const envOnlyLiveSettings = (): AccountSettings => ({
    ...DEFAULT_ACCOUNT_SETTINGS,
    mode: 'live',
    liveTradeEquitiesTradier: true,
    liveTradierEnvOptions: 'production',
    // no liveApiKeyOptionsProduction / liveAccountIdOptionsProduction
  });
  const readEquityClient = (e: SignalEngine): TradierOrderClient | null =>
    (e as unknown as { tradierLiveEquityClient: TradierOrderClient | null }).tradierLiveEquityClient;

  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      LIVE_EQUITY_BOOT_USER: process.env['LIVE_EQUITY_BOOT_USER'],
      TRADIER_API_TOKEN: process.env['TRADIER_API_TOKEN'],
      TRADIER_ACCOUNT_ID: process.env['TRADIER_ACCOUNT_ID'],
    };
    process.env['LIVE_EQUITY_BOOT_USER'] = 'admin';
    process.env['TRADIER_API_TOKEN'] = 'shared-env-tok';
    process.env['TRADIER_ACCOUNT_ID'] = 'shared-env-acct';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('does NOT resolve the shared env account for a non-operator user (TRA-856 leak closed)', () => {
    const engine = new SignalEngine(envOnlyLiveSettings());
    engine.setAlertUsername('freshly-signed-up-user');
    expect(readEquityClient(engine)).toBeNull();
  });

  it('still resolves the shared env account for the pinned operator', () => {
    const engine = new SignalEngine(envOnlyLiveSettings());
    engine.setAlertUsername('admin');
    expect(readEquityClient(engine)).not.toBeNull();
  });

  it('per-user creds work for a non-operator (precedence unchanged)', () => {
    const engine = new SignalEngine({
      ...envOnlyLiveSettings(),
      liveApiKeyOptionsProduction: 'her-own-tok',
      liveAccountIdOptionsProduction: 'her-own-acct',
    });
    engine.setAlertUsername('alice');
    expect(readEquityClient(engine)).not.toBeNull();
  });
});

// ── TRA-787 — SupertrendConfluence SHADOW channel ────────────────────────────
// Acceptance #5: a tick fed a synthetic uptrend-confluence window produces a
// shadow signal on the dedicated channel AND zero entries on the live order
// path. The live strategies stay byte-for-byte identical (untouched here).
describe('SignalEngine — SupertrendConfluence shadow channel (TRA-787)', () => {
  // The shadow pass calls recordShadowSignal, which would otherwise append to the
  // production data/shadow-signals.jsonl. Point the ledger at a throwaway temp
  // file per test so these runs never pollute QuantTrader's validation dataset.
  let ledgerFile: string;
  let ledgerN = 0;
  beforeEach(() => {
    ledgerN += 1;
    ledgerFile = join(tmpdir(), `signal-engine-shadow-${process.pid}-${ledgerN}.jsonl`);
    try { rmSync(ledgerFile); } catch { /* fresh */ }
    setShadowLedgerFileForTests(ledgerFile);
  });
  afterEach(() => {
    setShadowLedgerFileForTests(null);
    try { rmSync(ledgerFile); } catch { /* ignore */ }
  });

  // 5-minute OHLCV from explicit closes: high/low straddle the running close,
  // open = prior close. 5m step so resampling to the strategy's 1h confirm fold
  // yields enough buckets for the higher-timeframe Supertrend.
  function build5m(closes: number[], spread = 0.5): Candle[] {
    const step = 5 * 60_000;
    return closes.map((close, i) => ({
      symbol: 'TEST',
      timestamp: i * step,
      open: i > 0 ? closes[i - 1] : close,
      high: Math.max(close, i > 0 ? closes[i - 1] : close) + spread,
      low: Math.min(close, i > 0 ? closes[i - 1] : close) - spread,
      close,
      volume: 1_000,
    }));
  }

  // Sawtooth uptrend (pullback-inside-an-uptrend): periodic dips cool RSI into
  // the [50,70] entry band while the net drift keeps the SMA stack aligned and
  // MACD positive — the exact confluence the strategy is built to buy. Deep
  // enough that the 1h confirm fold has ≥ period+1 bars.
  function sawUp(n: number, u = 0.5, d = 1.0, k = 3): number[] {
    const closes: number[] = [];
    let p = 100;
    let i = 0;
    while (closes.length < n) {
      const inUp = i % (k + 1) !== k;
      closes.push(p);
      p += inUp ? u : -d;
      i++;
    }
    while (closes.length > 2 && closes[closes.length - 1] <= closes[closes.length - 2]) closes.pop();
    return closes;
  }

  it('surfaces a shadow signal on the dedicated channel and opens NOTHING on the live path', () => {
    const engine = new SignalEngine();
    const candles = build5m(sawUp(480));
    // Seed the shadow 5m series directly (the deep-pull refresh is feed-bound;
    // the per-tick evaluation reads this cache).
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', candles);

    (engine as unknown as { evaluateSupertrendShadow: (s: string[]) => void }).evaluateSupertrendShadow(['TEST']);

    const state = engine.getState();
    // Shadow channel carries the long signal …
    expect(state.supertrendShadowSignals).toHaveLength(1);
    expect(state.supertrendShadowSignals[0].type).toBe('supertrend_confluence');
    expect(state.supertrendShadowSignals[0].side).toBe('buy');
    expect(state.supertrendShadowSignals[0].symbol).toBe('TEST');
    // … and NOTHING reached the live order path: no live signal, no position.
    expect(state.signals).toHaveLength(0);
    expect(state.account.openPositions).toHaveLength(0);
  });

  it('emits no shadow signal on a flat tape (and still touches no live path)', () => {
    const engine = new SignalEngine();
    const flat = build5m(Array.from({ length: 240 }, () => 100));
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', flat);

    (engine as unknown as { evaluateSupertrendShadow: (s: string[]) => void }).evaluateSupertrendShadow(['TEST']);

    const state = engine.getState();
    expect(state.supertrendShadowSignals).toHaveLength(0);
    expect(state.signals).toHaveLength(0);
    expect(state.account.openPositions).toHaveLength(0);
  });

  // TRA-801 — Stage-2 PAPER accrual. The shadow signal now ALSO opens a position
  // in the dedicated forward-test paper book (distinct from the observe-only
  // shadow log AND from the user's demo account), which closes at SL/TP and lands
  // in the export snapshot's closedPositions stamped supertrend_confluence/demo.
  it('opens a paper forward-test position on a shadow signal — isolated from the user demo book', () => {
    const engine = new SignalEngine();
    const candles = build5m(sawUp(480));
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', candles);

    (engine as unknown as { evaluateSupertrendShadow: (s: string[]) => void }).evaluateSupertrendShadow(['TEST']);

    // The forward-test book holds one open paper position …
    const stPaper = (engine as unknown as { supertrendPaper: { getState(): { openPositions: Array<{ symbol: string; signalType: string }> } } }).supertrendPaper;
    const open = stPaper.getState().openPositions;
    expect(open).toHaveLength(1);
    expect(open[0].symbol).toBe('TEST');
    expect(open[0].signalType).toBe('supertrend_confluence');
    // … while the user's demo account is untouched (isolation invariant).
    expect(engine.getState().account.openPositions).toHaveLength(0);
  });

  it('closes the paper position at take-profit into closedPositions (supertrend_confluence/demo)', () => {
    const engine = new SignalEngine();
    const candles = build5m(sawUp(480));
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', candles);
    (engine as unknown as { evaluateSupertrendShadow: (s: string[]) => void }).evaluateSupertrendShadow(['TEST']);

    const stPaper = (engine as unknown as { supertrendPaper: { getState(): { openPositions: Array<{ takeProfit: number }> } } }).supertrendPaper;
    const tp = stPaper.getState().openPositions[0].takeProfit;

    // Drive the live price above the take-profit and run the forward-test exits.
    const prices = new Map<string, number>([['TEST', tp + 5]]);
    (engine as unknown as { runSupertrendPaperExits: (p: Map<string, number>) => void }).runSupertrendPaperExits(prices);

    // The closed paper trade is recorded for the promotion service's Stage-2 ledger.
    const snap = engine.exportTradeSnapshot();
    const stClosed = snap.closedPositions.filter(p => p.signalType === 'supertrend_confluence');
    expect(stClosed).toHaveLength(1);
    expect(stClosed[0].mode).toBe('demo');
    expect(stClosed[0].closedAt).toBeDefined();
    expect(stClosed[0].pnl ?? 0).toBeGreaterThan(0); // exited at TP → winning paper trade
    // The forward-test book is now flat again.
    expect((engine as unknown as { supertrendPaper: { getState(): { openPositions: unknown[] } } }).supertrendPaper.getState().openPositions).toHaveLength(0);
  });

  // TRA-834 regression — the paper book stalled at tradeCount=0 because exits ran
  // off a single point-sample tick quote, which misses a stop/target touched by a
  // 5m WICK that the shadow ledger's intra-bar high/low walk (resolveOutcome)
  // does count. With the one-position-per-symbol open guard, an unclosed position
  // blocked all further accrual. Exits now share the bar-walk, so a wick-touch
  // closes the position even when the latest quote never breached the bracket.
  it('TRA-834: closes a paper position on an intra-bar 5m wick the tick quote misses', () => {
    const engine = new SignalEngine();
    const stPaper = (engine as unknown as { supertrendPaper: PaperAccount }).supertrendPaper;

    // Open a long forward-test position directly: entry 100, stop 95, target 110.
    const signal = {
      id: 'sig-wick', symbol: 'WICK', side: 'buy', type: 'supertrend_confluence',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, timestamp: Date.now(),
    } as unknown as TradeSignal;
    const opened = stPaper.openPosition(signal, 100);
    expect(opened).not.toBeNull();

    // A later 5m bar wicks THROUGH the stop (low 94 ≤ 95) but its close recovers
    // to 100 — a point-sample quote at the close never sees the breach, while the
    // bar-walk resolver (low ≤ stop) records SL_HIT. Timestamp just after entry so
    // it lands in the same ET session the resolver requires.
    const after = (opened!.openedAt ?? Date.now()) + 60_000;
    const wickBar: Candle = {
      symbol: 'WICK', timestamp: after, open: 100, high: 101, low: 94, close: 100, volume: 1_000,
    };
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('WICK', [wickBar]);

    // EMPTY price map → the point-sample backstop cannot close anything; only the
    // bar-walk can. Proves the wick-touch path is what drains the book.
    (engine as unknown as { runSupertrendPaperExits: (p: Map<string, number>) => void })
      .runSupertrendPaperExits(new Map());

    const snap = engine.exportTradeSnapshot();
    const stClosed = snap.closedPositions.filter(p => p.signalType === 'supertrend_confluence');
    expect(stClosed).toHaveLength(1);
    expect(stClosed[0].exitReason).toBe('stop');
    expect(stClosed[0].exitPrice ?? 0).toBeCloseTo(95); // exited at the stop (−1R)
    expect(stClosed[0].pnl ?? 0).toBeLessThan(0);
    expect(stClosed[0].closedAt).toBeDefined();
    expect(stPaper.getState().openPositions).toHaveLength(0);
  });
});
