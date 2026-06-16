// TRA-528 — health route registrar + stale-state monitor tests.
//
// Exercises the HTTP surface with a fake express app and fake user contexts so
// the wiring is verified without booting the real server.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerLiveHealthRoutes,
  runStaleStateCheck,
  aggregateLiveEquityAcceptance,
  summarizeDemoBook,
  summarizeDemoBooks,
  summarizeOptionsPipeline,
  type HealthUserContext,
} from './health-routes.js';
import { checkStaleState } from './alerts.js';
import { getRecentAlerts, __resetAlertsForTest } from './alerts.js';
import type { EngineState, LiveEquityAcceptance } from '../signal-engine.js';
import type { AccountSettings } from '@trading-app/shared';

const NOW = 2_000_000_000;
const FRESH = NOW - 30_000;
const STALE = NOW - 10 * 60_000;

/** Minimal EngineState for the bits health code reads. */
function engineState(over: Partial<EngineState> = {}): EngineState {
  return {
    symbols: [{ symbol: 'AAPL', price: 1, volume: 1, change: 0, changePct: 0, lastUpdated: FRESH }],
    signals: [],
    lastTick: FRESH,
    tradingHalted: false,
    haltReason: null,
    autoTradingEnabled: true,
    marketOpen: true,
    ...over,
  } as unknown as EngineState;
}

function ctx(username: string, state: EngineState): HealthUserContext {
  return { username, engine: { getState: () => state } };
}

function settings(over: Partial<AccountSettings> = {}): AccountSettings {
  return { mode: 'demo', liveTradierEnvOptions: 'sandbox', ...over } as unknown as AccountSettings;
}

type FakeHandler = (req: unknown, res: unknown, next?: () => void) => unknown;

/** Capture routes registered on a fake express app. */
function fakeApp() {
  const routes = new Map<string, FakeHandler[]>();
  const app = {
    get(path: string, ...handlers: FakeHandler[]) {
      routes.set(path, handlers);
    },
  };
  return { app: app as never, routes };
}

function fakeRes() {
  const res: { statusCode: number; body: unknown; headersSent: boolean; json: (b: unknown) => void } = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    json(b: unknown) {
      this.body = b;
      this.headersSent = true;
    },
  };
  return res;
}

/** Like fakeRes but with a `locals` bag, as express provides to handlers. */
function resWithLocals() {
  const res = fakeRes() as ReturnType<typeof fakeRes> & { locals: Record<string, unknown> };
  res.locals = {};
  return res;
}

describe('registerLiveHealthRoutes', () => {
  it('serves build info on GET /api/health/version (no auth handler)', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/version')!;
    expect(handlers).toHaveLength(1); // version is unauthenticated
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as { commitSource: string; uptimeSec: number };
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('commitSource');
    expect(typeof body.uptimeSec).toBe('number');
  });

  it('serves a live-health verdict (auth-gated) on GET /api/health/live', async () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never,
      userCtx: async () => ctx('admin', engineState({ marketOpen: false })),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/live')!;
    expect(handlers).toHaveLength(2); // requireAuth + handler
    const res = fakeRes();
    await handlers[1]!({}, res);
    const body = res.body as { status: string; build: unknown; feed: { trackedSymbols: number } };
    expect(body.status).toBe('green');
    expect(body.build).toBeDefined();
    expect(body.feed.trackedSymbols).toBe(1);
  });
});

describe('TRA-580 live-equity acceptance probe', () => {
  function snap(over: Partial<LiveEquityAcceptance> = {}): LiveEquityAcceptance {
    return {
      mode: 'live',
      tradierEnv: 'production',
      liveEquityClientConfigured: true,
      liveEquityTradingEnabled: true,
      liveSignalCount: 0,
      liveEquityPositionCount: 0,
      liveEquityBracketsWithBothLegs: 0,
      liveEquityMirrorsWithOrderId: 0,
      liveSkipReasonCount: 0,
      firstLiveEquityFillConfirmed: false,
      lastLiveEquityFillAt: null,
      ...over,
    };
  }

  it('aggregates fleet counts and confirms the first fill when a mirror has both legs + an order id', () => {
    const report = aggregateLiveEquityAcceptance(
      [
        snap({
          liveSignalCount: 2,
          liveEquityPositionCount: 1,
          liveEquityBracketsWithBothLegs: 1,
          liveEquityMirrorsWithOrderId: 1,
          firstLiveEquityFillConfirmed: true,
          lastLiveEquityFillAt: new Date(NOW - 60_000).toISOString(),
        }),
        snap({ mode: 'demo', tradierEnv: 'sandbox', liveSignalCount: 0, liveSkipReasonCount: 1 }),
      ],
      NOW,
    );
    expect(report.ok).toBe(true);
    expect(report.engineCount).toBe(2);
    expect(report.liveEngineCount).toBe(1);
    expect(report.productionEngineCount).toBe(1);
    expect(report.firstLiveEquityFillConfirmed).toBe(true);
    expect(report.totals).toMatchObject({
      liveSignals: 2,
      liveEquityPositions: 1,
      liveEquityBracketsWithBothLegs: 1,
      liveEquityMirrorsWithOrderId: 1,
      liveSkipReasons: 1,
    });
    expect(report.lastLiveEquityFillAt).toBe(new Date(NOW - 60_000).toISOString());
    expect(report.build).toBeDefined();
  });

  it('reports not-yet-confirmed for an armed-but-unfired fleet and never leaks trade specifics', () => {
    const report = aggregateLiveEquityAcceptance([snap()], NOW);
    expect(report.firstLiveEquityFillConfirmed).toBe(false);
    expect(report.lastLiveEquityFillAt).toBeNull();
    // Redaction guard: only the documented redacted keys are present.
    expect(Object.keys(report).sort()).toEqual(
      [
        'build',
        'engineCount',
        'firstLiveEquityFillConfirmed',
        'lastLiveEquityFillAt',
        'liveEngineCount',
        'liveEquityClientConfigured',
        'liveEquityTradingEnabled',
        'ok',
        'productionEngineCount',
        'serviceEnv',
        'time',
        'totals',
      ].sort(),
    );
    // serviceEnv carries booleans only — never a credential value.
    expect(Object.values(report.serviceEnv).every(v => typeof v === 'boolean')).toBe(true);
  });

  it('TRA-715 — serviceEnv reflects injected env presence as booleans only', () => {
    const armed = aggregateLiveEquityAcceptance([snap()], NOW, {
      TRADIER_ENV: 'production',
      TRADIER_API_TOKEN: 'tok-redacted',
      TRADIER_ACCOUNT_ID: 'acct-redacted',
      LIVE_EQUITY_BOOT_USER: 'admin',
    });
    expect(armed.serviceEnv).toEqual({
      tradierEnvProduction: true,
      productionTradierTokenPresent: true,
      productionTradierAccountPresent: true,
      bootArmPinConfigured: true,
    });

    const bare = aggregateLiveEquityAcceptance([snap()], NOW, { TRADIER_ENV: 'sandbox' });
    expect(bare.serviceEnv).toEqual({
      tradierEnvProduction: false,
      productionTradierTokenPresent: false,
      productionTradierAccountPresent: false,
      bootArmPinConfigured: false,
    });
    // No credential VALUE ever surfaces in the redacted report.
    expect(JSON.stringify(armed)).not.toContain('tok-redacted');
    expect(JSON.stringify(armed)).not.toContain('acct-redacted');
  });

  it('mounts GET /api/health/live-equity (unauthenticated) only when the dep is provided', () => {
    const withDep = fakeApp();
    registerLiveHealthRoutes(withDep.app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      liveEquityAcceptance: () => [snap({ firstLiveEquityFillConfirmed: true })],
      now: () => NOW,
    });
    const handlers = withDep.routes.get('/api/health/live-equity')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like /version
    const res = fakeRes();
    handlers[0]!({}, res);
    expect((res.body as { firstLiveEquityFillConfirmed: boolean }).firstLiveEquityFillConfirmed).toBe(true);

    const without = fakeApp();
    registerLiveHealthRoutes(without.app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    expect(without.routes.get('/api/health/live-equity')).toBeUndefined();
  });
});

describe('TRA-898 demo-book summary', () => {
  function demoState(over: Partial<EngineState> = {}): EngineState {
    return engineState({
      account: { totalEquity: 25_500, availableCash: 18_000, dailyPnl: 500, openPositions: [{}, {}] },
      closedPositions: [
        { pnl: 300, closedAt: NOW - 60_000 },
        { pnl: -120, closedAt: NOW - 2 * 24 * 60 * 60 * 1000 }, // older than 24h
      ],
      agentRecommendations: [
        { action: 'BUY', proposedSignal: {} },
        { action: 'HOLD', proposedSignal: null },
        { action: 'SELL', proposedSignal: {} },
      ],
      tradingAgentsEnabled: true,
      tradingAgentsGatingEnabled: true,
      tradingAgentsLiveGatingEnabled: false,
      autoTradingEnabled: false,
      tradingHalted: false,
      haltReason: null,
      ...over,
    } as unknown as EngineState);
  }

  it('summarizes equity, open/closed P&L, and agent decision activity for the caller', () => {
    const report = summarizeDemoBook(demoState(), 'demo', NOW);
    expect(report.mode).toBe('demo');
    expect(report.equity).toEqual({ totalEquity: 25_500, availableCash: 18_000, dailyPnl: 500 });
    expect(report.openPositionCount).toBe(2);
    expect(report.closed.recentCount).toBe(2);
    expect(report.closed.recentRealizedPnl).toBe(180);
    expect(report.closed.recentCapped).toBe(false);
    // Only the close within 24h counts toward the day window.
    expect(report.closed.last24hCount).toBe(1);
    expect(report.closed.last24hRealizedPnl).toBe(300);
    expect(report.agentActivity).toEqual({
      recommendationCount: 3,
      byAction: { BUY: 1, SELL: 1, HOLD: 1 },
      routableCount: 2,
    });
    expect(report.agents).toMatchObject({
      tradingAgentsEnabled: true,
      gatingEnabled: true,
      liveGatingEnabled: false,
    });
  });

  it('flags the closed buffer as capped at the 20-row getState() ceiling', () => {
    const twenty = Array.from({ length: 20 }, () => ({ pnl: 10, closedAt: NOW }));
    const report = summarizeDemoBook(demoState({ closedPositions: twenty as never }), 'demo', NOW);
    expect(report.closed.recentCapped).toBe(true);
    expect(report.closed.last24hCount).toBe(20);
  });

  it('mounts GET /api/health/demo-book auth-gated (requireAuth + handler)', async () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never,
      userCtx: async () => ctx('admin', demoState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/demo-book')!;
    expect(handlers).toHaveLength(2); // gate + handler
    const res = resWithLocals();
    await handlers[1]!({}, res);
    const body = res.body as { ok: boolean; equity: { totalEquity: number }; build: unknown };
    expect(body.ok).toBe(true);
    expect(body.equity.totalEquity).toBe(25_500);
    expect(body.build).toBeDefined();
  });

  it('TRA-901 summarizeDemoBooks keys each demo engine book by user', () => {
    const report = summarizeDemoBooks(
      [{ username: 'demo-trader', state: demoState(), mode: 'demo' }],
      NOW,
    );
    expect(report.ok).toBe(true);
    expect(report.demoEngineCount).toBe(1);
    expect(report.books).toHaveLength(1);
    expect(report.books[0]!.username).toBe('demo-trader');
    expect(report.books[0]!.book.equity.totalEquity).toBe(25_500);
    expect(report.books[0]!.book.openPositionCount).toBe(2);
    expect(report.build).toBeDefined();
  });

  it('TRA-901 internal token unlocks demo-book without a user JWT and returns the fleet books', async () => {
    const { app, routes } = fakeApp();
    let requireAuthCalled = false;
    registerLiveHealthRoutes(app, {
      requireAuth: (() => {
        requireAuthCalled = true;
      }) as never,
      userCtx: async () => {
        throw new Error('userCtx must not run on the internal path');
      },
      getSettings: () => settings(),
      internalToken: () => 'watch-secret',
      demoBooks: () => [{ username: 'demo-trader', state: demoState(), mode: 'demo' }],
      now: () => NOW,
    });
    const [gate, handler] = routes.get('/api/health/demo-book')!;
    // Valid token → gate sets res.locals and calls next(); requireAuth is skipped.
    const res = resWithLocals();
    let nexted = false;
    gate({ headers: { 'x-internal-token': 'watch-secret' } }, res, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(requireAuthCalled).toBe(false);
    expect(res.locals['internalDemoAccess']).toBe(true);
    await handler!({ headers: { 'x-internal-token': 'watch-secret' } }, res);
    const body = res.body as { demoEngineCount: number; books: Array<{ username: string }> };
    expect(body.demoEngineCount).toBe(1);
    expect(body.books[0]!.username).toBe('demo-trader');
  });

  it('TRA-901 a wrong/absent internal token falls through to requireAuth', () => {
    const { app, routes } = fakeApp();
    let requireAuthCalls = 0;
    registerLiveHealthRoutes(app, {
      requireAuth: (() => {
        requireAuthCalls += 1;
      }) as never,
      userCtx: async () => ctx('admin', demoState()),
      getSettings: () => settings(),
      internalToken: () => 'watch-secret',
      demoBooks: () => [],
      now: () => NOW,
    });
    const [gate] = routes.get('/api/health/demo-book')!;
    const res = resWithLocals();
    gate({ headers: { 'x-internal-token': 'WRONG' } }, res, () => undefined); // wrong token
    gate({ headers: {} }, res, () => undefined); // no token
    expect(requireAuthCalls).toBe(2);
    expect(res.locals['internalDemoAccess']).toBeUndefined();
  });

  it('TRA-901 internal access stays disabled when no token is configured', () => {
    const { app, routes } = fakeApp();
    let requireAuthCalls = 0;
    registerLiveHealthRoutes(app, {
      requireAuth: (() => {
        requireAuthCalls += 1;
      }) as never,
      userCtx: async () => ctx('admin', demoState()),
      getSettings: () => settings(),
      internalToken: () => undefined, // disabled
      demoBooks: () => [{ username: 'demo-trader', state: demoState(), mode: 'demo' }],
      now: () => NOW,
    });
    const [gate] = routes.get('/api/health/demo-book')!;
    const res = resWithLocals();
    // Even a header present → ignored, falls through to requireAuth.
    gate({ headers: { 'x-internal-token': 'anything' } }, res, () => undefined);
    expect(requireAuthCalls).toBe(1);
    expect(res.locals['internalDemoAccess']).toBeUndefined();
  });
});

describe('TRA-895 options-pipeline probe', () => {
  function pipeState(over: Partial<EngineState> = {}): EngineState {
    return engineState({
      symbols: [
        { symbol: 'AAPL', price: 1, volume: 1, change: 0, changePct: 0, lastUpdated: FRESH },
        { symbol: 'MSFT', price: 1, volume: 1, change: 0, changePct: 0, lastUpdated: FRESH },
      ],
      signals: [
        { type: 'relative_value', mode: 'demo' },
        { type: 'sma200_pullback', mode: 'demo' },
        { type: 'relative_value', mode: 'demo' },
      ],
      options: { openOptions: [{}, {}, {}] },
      autoTradingEnabled: true,
      tradingAgentsEnabled: true,
      tradingAgentsGatingEnabled: true,
      tradingHalted: false,
      haltReason: null,
      marketOpen: true,
      ...over,
    } as unknown as EngineState);
  }

  it('counts option signals + watchlist and reports the scan as armed when every gate passes', () => {
    const report = summarizeOptionsPipeline(
      { rvScannerConfigured: true, rvBreakerOpen: false, engines: [{ state: pipeState(), mode: 'demo' }] },
      NOW,
    );
    expect(report.ok).toBe(true);
    expect(report.rvScannerConfigured).toBe(true);
    expect(report.demoEngineCount).toBe(1);
    const e = report.engines[0]!;
    expect(e.optionSignalCount).toBe(2);
    expect(e.totalSignalCount).toBe(3);
    expect(e.watchlistSymbolCount).toBe(2);
    expect(e.openOptionsCount).toBe(3);
    expect(e.rvScanArmed).toBe(true);
    expect(e.blockedBy).toBeNull();
    expect(report.build).toBeDefined();
  });

  it('names the first failing gate so "no option signals" is diagnosable', () => {
    // Auto-trade off → the RV options scan can never fire even with agents on.
    const offAuto = summarizeOptionsPipeline(
      { rvScannerConfigured: true, rvBreakerOpen: false, engines: [{ state: pipeState({ autoTradingEnabled: false }), mode: 'demo' }] },
      NOW,
    );
    expect(offAuto.engines[0]!.rvScanArmed).toBe(false);
    expect(offAuto.engines[0]!.blockedBy).toBe('auto_trading_off');

    // Scanner not configured (no Tradier creds) dominates.
    const noScanner = summarizeOptionsPipeline(
      { rvScannerConfigured: false, rvBreakerOpen: false, engines: [{ state: pipeState(), mode: 'demo' }] },
      NOW,
    );
    expect(noScanner.engines[0]!.blockedBy).toBe('rv_scanner_not_configured');

    // Market closed when everything else is green.
    const closed = summarizeOptionsPipeline(
      { rvScannerConfigured: true, rvBreakerOpen: false, engines: [{ state: pipeState({ marketOpen: false }), mode: 'demo' }] },
      NOW,
    );
    expect(closed.engines[0]!.blockedBy).toBe('market_closed');
  });

  it('mounts GET /api/health/options-pipeline unauthenticated when wired', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', pipeState()),
      getSettings: () => settings(),
      optionsPipeline: () => ({
        rvScannerConfigured: true,
        rvBreakerOpen: false,
        engines: [{ state: pipeState(), mode: 'demo' }],
      }),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/options-pipeline')!;
    expect(handlers).toHaveLength(1); // unauthenticated — handler only, no gate
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as { ok: boolean; engines: Array<{ optionSignalCount: number }> };
    expect(body.ok).toBe(true);
    expect(body.engines[0]!.optionSignalCount).toBe(2);
  });

  it('is not mounted when the dep is absent (surface stays unchanged)', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', pipeState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    expect(routes.get('/api/health/options-pipeline')).toBeUndefined();
  });
});

describe('checkStaleState', () => {
  beforeEach(() => __resetAlertsForTest());

  it('fires a critical alert when market open and no fresh quotes', () => {
    const fired = checkStaleState({ marketOpen: true, trackedSymbols: 5, freshSymbols: 0 });
    expect(fired).toBe(true);
    const alerts = getRecentAlerts();
    expect(alerts.at(-1)?.key).toBe('stale-state');
    expect(alerts.at(-1)?.severity).toBe('critical');
  });

  it('does not fire when the market is closed', () => {
    expect(checkStaleState({ marketOpen: false, trackedSymbols: 5, freshSymbols: 0 })).toBe(false);
  });

  it('does not fire when at least one quote is fresh', () => {
    expect(checkStaleState({ marketOpen: true, trackedSymbols: 5, freshSymbols: 1 })).toBe(false);
  });

  it('does not fire when no symbols are tracked', () => {
    expect(checkStaleState({ marketOpen: true, trackedSymbols: 0, freshSymbols: 0 })).toBe(false);
  });

  it('throttles repeat alerts on the same key', () => {
    expect(checkStaleState({ marketOpen: true, trackedSymbols: 3, freshSymbols: 0 })).toBe(true);
    expect(checkStaleState({ marketOpen: true, trackedSymbols: 3, freshSymbols: 0 })).toBe(false);
  });
});

describe('runStaleStateCheck', () => {
  beforeEach(() => __resetAlertsForTest());

  it('raises one alert when a live engine has a stale feed', () => {
    const contexts = [
      ctx('admin', engineState({ symbols: [{ symbol: 'AAPL', price: 1, volume: 0, change: 0, changePct: 0, lastUpdated: STALE }] as never })),
    ];
    const fired = runStaleStateCheck(contexts, () => settings({ mode: 'live' }), NOW);
    expect(fired).toBe(true);
    expect(getRecentAlerts().at(-1)?.key).toBe('stale-state');
  });

  it('stays quiet when every engine has fresh quotes', () => {
    const contexts = [ctx('admin', engineState())];
    expect(runStaleStateCheck(contexts, () => settings({ mode: 'live' }), NOW)).toBe(false);
    expect(getRecentAlerts()).toHaveLength(0);
  });
});
