// TRA-528 — health route registrar + stale-state monitor tests.
//
// Exercises the HTTP surface with a fake express app and fake user contexts so
// the wiring is verified without booting the real server.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  makeHypothesis,
  runHypothesis,
  setHypothesisQueueFileForTests,
} from '../hypothesis-pipeline.js';
import {
  registerLiveHealthRoutes,
  runStaleStateCheck,
  aggregateLiveEquityAcceptance,
  summarizeDemoBook,
  summarizeDemoBooks,
  summarizeDemoBooksPublic,
  summarizeSma200ForwardTestFills,
  summarizeOptionsPipeline,
  buildOptionJournalReport,
  type HealthUserContext,
} from './health-routes.js';
import type { OptionTradeJournalRecord } from '../option-trade-journal.js';
import {
  clearChurnBrakeLedger,
  recordChurnBrakeOpen,
  recordChurnBrakeOpenRejected,
  recordChurnBrakeDcaHalt,
} from '../churn-brake-ledger.js';
import { checkStaleState } from './alerts.js';
import { getRecentAlerts, __resetAlertsForTest } from './alerts.js';
import type { EngineState, LiveEquityAcceptance } from '../signal-engine.js';
import { categorizeLiveSkipReason, emptyLiveSkipBreakdown } from '../signal-engine.js';
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
  const postRoutes = new Map<string, FakeHandler[]>();
  const app = {
    get(path: string, ...handlers: FakeHandler[]) {
      routes.set(path, handlers);
    },
    post(path: string, ...handlers: FakeHandler[]) {
      postRoutes.set(path, handlers);
    },
  };
  return { app: app as never, routes, postRoutes };
}

function fakeRes() {
  const res: {
    statusCode: number;
    body: unknown;
    headersSent: boolean;
    json: (b: unknown) => void;
    status: (code: number) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    json(b: unknown) {
      this.body = b;
      this.headersSent = true;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
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
      liveSkipReasonCategories: emptyLiveSkipBreakdown(),
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
        'liveSkipReasonBreakdown',
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

  it('TRA-1573 — maps raw skip reasons to a fixed, leak-free category vocabulary', () => {
    expect(
      categorizeLiveSkipReason(
        'display-only: sma200_pullback is not registered in the TRA-817 capital-gate manifest (no out-of-sample pass)',
      ),
    ).toBe('display_only_capital_gate');
    expect(categorizeLiveSkipReason('Tradier equity client not configured')).toBe('client_not_configured');
    expect(
      categorizeLiveSkipReason('agent gating: live routing disabled until board+CTO go-live gate is cleared'),
    ).toBe('live_routing_gated');
    expect(categorizeLiveSkipReason('daily equity limit reached (3/3)')).toBe('daily_limit_reached');
    expect(categorizeLiveSkipReason('OTM live broker mirror not wired (demo/paper only)')).toBe('otm_mirror_not_wired');
    expect(categorizeLiveSkipReason('AAPL not opened (no quote / dedup / risk gate)')).toBe('risk_or_quote_gate');
    expect(categorizeLiveSkipReason('Tradier rejected the bracket order')).toBe('broker_reject');
    expect(categorizeLiveSkipReason('some unrecognized future reason')).toBe('other');
  });

  it('TRA-1573 — fleet breakdown sums per-engine skip categories and stays redacted', () => {
    const report = aggregateLiveEquityAcceptance(
      [
        snap({
          liveSignalCount: 30,
          liveSkipReasonCount: 30,
          liveSkipReasonCategories: { ...emptyLiveSkipBreakdown(), display_only_capital_gate: 30 },
        }),
        snap({
          liveSignalCount: 9,
          liveSkipReasonCount: 9,
          liveSkipReasonCategories: {
            ...emptyLiveSkipBreakdown(),
            display_only_capital_gate: 8,
            risk_or_quote_gate: 1,
          },
        }),
      ],
      NOW,
    );
    // The by-design capital gate dominates — the 0-fills is NOT a wiring gap.
    expect(report.liveSkipReasonBreakdown.display_only_capital_gate).toBe(38);
    expect(report.liveSkipReasonBreakdown.risk_or_quote_gate).toBe(1);
    expect(report.liveSkipReasonBreakdown.client_not_configured).toBe(0);
    // Sum of the breakdown equals the flat skip count — no signals lost.
    const total = Object.values(report.liveSkipReasonBreakdown).reduce((a, b) => a + b, 0);
    expect(total).toBe(report.totals.liveSkipReasons);
    // Redaction: every key is a constant category label, every value a number.
    expect(Object.values(report.liveSkipReasonBreakdown).every(v => typeof v === 'number')).toBe(true);
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

describe('TRA-1289 sma200 forward-test fill evidence', () => {
  function fleetState(
    open: Array<Record<string, unknown>>,
    closed: Array<Record<string, unknown>>,
  ): { state: EngineState; mode: string } {
    return {
      mode: 'demo',
      state: engineState({
        account: { totalEquity: 25_000, availableCash: 25_000, dailyPnl: 0, openPositions: open },
        closedPositions: closed,
      } as unknown as Partial<EngineState>),
    };
  }

  it('reports zero fills when no position carries the forwardTestOnly marker', () => {
    const report = summarizeSma200ForwardTestFills([
      fleetState([{ id: 'a', openedAt: NOW }], [{ pnl: 50, openedAt: NOW - 1000, closedAt: NOW }]),
    ]);
    expect(report.fillCount).toBe(0);
    expect(report.openPositions).toBe(0);
    expect(report.closedCount).toBe(0);
    expect(report.lastFillAt).toBeNull();
    expect(report.realizedPnl).toBe(0);
  });

  it('counts open + closed forwardTestOnly fills and folds realized P&L / last-fill time', () => {
    const report = summarizeSma200ForwardTestFills([
      fleetState(
        [
          { id: 'ft-open', openedAt: NOW - 5_000, forwardTestOnly: true },
          { id: 'normal-open', openedAt: NOW }, // not forward-test → ignored
        ],
        [
          { pnl: 120, openedAt: NOW - 20_000, closedAt: NOW - 1_000, forwardTestOnly: true },
          { pnl: -40, openedAt: NOW - 10_000, closedAt: NOW, forwardTestOnly: true },
          { pnl: 999, openedAt: NOW, closedAt: NOW }, // not forward-test → ignored
        ],
      ),
    ]);
    expect(report.openPositions).toBe(1);
    expect(report.closedCount).toBe(2);
    expect(report.fillCount).toBe(3); // >= 1 ⇒ monitor closes done
    expect(report.realizedPnl).toBe(80); // 120 - 40, excludes the non-FT 999
    // Most-recent forwardTestOnly open time (the open fill at NOW - 5_000).
    expect(report.lastFillAt).toBe(new Date(NOW - 5_000).toISOString());
  });

  it('aggregates forwardTestOnly fills across every demo engine in the fleet', () => {
    const report = summarizeSma200ForwardTestFills([
      fleetState([{ id: 'e1', openedAt: NOW, forwardTestOnly: true }], []),
      fleetState([], [{ pnl: 10, openedAt: NOW - 1, closedAt: NOW, forwardTestOnly: true }]),
    ]);
    expect(report.fillCount).toBe(2);
    expect(report.openPositions).toBe(1);
    expect(report.closedCount).toBe(1);
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

  it('TRA-901 summarizeDemoBooksPublic anonymizes usernames to demo-N labels', () => {
    const report = summarizeDemoBooksPublic(
      [
        { username: 'demo-trader', state: demoState(), mode: 'demo' },
        { username: 'second-trader', state: demoState(), mode: 'demo' },
      ],
      NOW,
    );
    expect(report.ok).toBe(true);
    expect(report.demoEngineCount).toBe(2);
    expect(report.books.map(b => b.label)).toEqual(['demo-1', 'demo-2']);
    // No username field leaks onto the public surface.
    expect(report.books.every(b => !('username' in b))).toBe(true);
    // Paper P&L / activity is preserved for the watch.
    expect(report.books[0]!.book.equity.totalEquity).toBe(25_500);
    expect(report.books[0]!.book.openPositionCount).toBe(2);
  });

  it('TRA-901 mounts GET /api/health/demo-book-public NO-AUTH (single handler)', async () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => {
        throw new Error('requireAuth must not run on the public path');
      }) as never,
      userCtx: async () => {
        throw new Error('userCtx must not run on the public path');
      },
      getSettings: () => settings(),
      demoBooks: () => [{ username: 'demo-trader', state: demoState(), mode: 'demo' }],
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/demo-book-public')!;
    expect(handlers).toHaveLength(1); // no gate — public
    const res = resWithLocals();
    await handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      demoEngineCount: number;
      books: Array<{ label: string; book: { equity: { totalEquity: number } } }>;
    };
    expect(body.ok).toBe(true);
    expect(body.demoEngineCount).toBe(1);
    expect(body.books[0]!.label).toBe('demo-1');
    expect(body.books[0]!.book.equity.totalEquity).toBe(25_500);
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
    // TRA-1405 — the bare open-option fixtures carry no `legs` and no closed
    // buffer / realized field, so the discriminators default cleanly.
    expect(e.openOptionsComboCount).toBe(0);
    expect(e.closedOptionsRecentCount).toBe(0);
    expect(e.dailyRealizedOptionsPnl).toBeNull();
    expect(e.rvScanArmed).toBe(true);
    expect(e.blockedBy).toBeNull();
    expect(report.build).toBeDefined();
    // TRA-895 — AI Options Ideas generator is un-gated (seeds near-ATM anchors
    // on calm days) so the demo watcher can confirm the ungated build is live.
    expect(report.aiIdeasGeneratorUngated).toBe(true);
    // TRA-1032 — exec-selector gate (+ TRA-1028 sub-flags) is surfaced so the
    // forward-validation flip is verifiable from the probe. Off by default in the
    // unit env, mirroring prod until the flag is set on the demo deploy.
    expect(report.optionExecSelectorEnabled).toBe(false);
    expect(report.optionExecEmaPullbackEnabled).toBe(false);
    expect(report.optionExecVolumeBreakoutEnabled).toBe(false);
    // TRA-1114 — demo-only directional-entry gate is surfaced so the board can
    // verify the flip drives real demo fills from the probe. Off by default.
    expect(report.optionDemoDirectionalEnabled).toBe(false);
  });

  it('TRA-1405 — surfaces per-engine option-book composition (combos vs closed vs realized) so a $0-Calendar book is diagnosable without a login', () => {
    // A book holding two multi-leg combos (never realize) + one single-leg, with
    // a non-empty recent-closed buffer and a today-realized figure — the exact
    // shape needed to tell "empty book" from "stuck-open combos" from "realizing
    // normally" for e.g. admin vs Richard, joinable by index to /autonomous-demo.
    const report = summarizeOptionsPipeline(
      {
        rvScannerConfigured: true,
        rvBreakerOpen: false,
        engines: [{
          state: pipeState({
            options: {
              openOptions: [
                { legs: [{}, {}] },      // iron condor / vertical → combo
                { legs: [{}, {}, {}, {}] }, // 4-leg combo
                { optionType: 'call' },  // single-leg (no legs)
              ],
              closedOptions: [{ pnl: 12 }, { pnl: -5 }],
              dailyRealizedOptionsPnl: 7,
            },
          } as unknown as Partial<EngineState>),
          mode: 'demo',
        }],
      },
      NOW,
    );
    const e = report.engines[0]!;
    expect(e.openOptionsCount).toBe(3);
    expect(e.openOptionsComboCount).toBe(2);
    expect(e.closedOptionsRecentCount).toBe(2);
    expect(e.dailyRealizedOptionsPnl).toBe(7);
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

describe('TRA-998 hypothesis ratification routes', () => {
  const tmpFile = join(tmpdir(), `health-ratify-${process.pid}.jsonl`);

  function register(internalToken?: string) {
    const fa = fakeApp();
    registerLiveHealthRoutes(fa.app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
      ...(internalToken ? { internalToken: () => internalToken } : {}),
    });
    return fa;
  }

  beforeEach(() => setHypothesisQueueFileForTests(tmpFile));
  afterEach(async () => {
    setHypothesisQueueFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  async function seedPending(): Promise<string> {
    const h = makeHypothesis({
      target: { kind: 'gate', path: 'RV_GATE.minTrendConfluence' },
      proposedDelta: { op: 'set', value: 0.6 },
      rationale: 'reflect routine flagged weak trend confluence',
      source: 'reflection',
      createdAt: 1_700_000_000_000,
    });
    await runHypothesis(
      h,
      {
        baseConfig: { RV_GATE: { minTrendConfluence: 0.55 } },
        runBacktest: async () => ({
          sharpe: 1.4,
          expectancy: 0.22,
          profitFactor: 1.6,
          maxDrawdown: 0.12,
          tradeCount: 180,
        }),
      },
      1_700_000_100_000,
    );
    return h.id;
  }

  it('GET /api/health/hypothesis-queue lists the live queue (unauthenticated)', async () => {
    const id = await seedPending();
    const { routes } = register();
    const handlers = routes.get('/api/health/hypothesis-queue')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other probes
    const res = fakeRes();
    await handlers[0]!({}, res);
    const body = res.body as { ok: boolean; counts: { pending: number }; pendingRatification: { id: string }[] };
    expect(body.ok).toBe(true);
    expect(body.counts.pending).toBe(1);
    expect(body.pendingRatification[0].id).toBe(id);
  });

  it('POST /api/hypothesis/:id/ratify (accept) lands a demo override behind a flag', async () => {
    const id = await seedPending();
    const { postRoutes } = register('sekret');
    const handlers = postRoutes.get('/api/hypothesis/:id/ratify')!;
    expect(handlers).toHaveLength(2); // internalOrAuth gate + handler
    const res = resWithLocals();
    res.locals['internalDemoAccess'] = true;
    await handlers[1]!({ params: { id }, body: { decision: 'accept' } }, res);
    const body = res.body as { ok: boolean; override: { flag: string; mode: string } | null };
    expect(body.ok).toBe(true);
    expect(body.override?.mode).toBe('demo');
    expect(body.override?.flag).toMatch(/^ENABLE_HYP_/);
  });

  it('POST ratify rejects a bad decision with 400', async () => {
    const id = await seedPending();
    const { postRoutes } = register('sekret');
    const handler = postRoutes.get('/api/hypothesis/:id/ratify')![1]!;
    const res = resWithLocals();
    await handler({ params: { id }, body: { decision: 'maybe' } }, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { ok: boolean }).ok).toBe(false);
  });

  it('POST ratify returns 409 for an unknown / non-pending id', async () => {
    const { postRoutes } = register('sekret');
    const handler = postRoutes.get('/api/hypothesis/:id/ratify')![1]!;
    const res = resWithLocals();
    await handler({ params: { id: 'hyp-deadbeef' }, body: { decision: 'accept' } }, res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/unknown hypothesis/);
  });
});

describe('TRA-1301 correlated-exposure cap health route', () => {
  it('serves GET /api/health/correlated-exposure-cap unauthenticated with config + counts', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/correlated-exposure-cap')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      flag: string;
      enabled: boolean;
      config: { capPct: number; minTradeRiskPct: number };
      bindingCount: number;
    };
    expect(body.ok).toBe(true);
    expect(body.flag).toBe('CORRELATED_EXPOSURE_CAP_ENABLED');
    // DARK by default (no env flags set in the test process).
    expect(body.enabled).toBe(false);
    expect(body.config.capPct).toBeCloseTo(0.07, 9);
    expect(body.config.minTradeRiskPct).toBeCloseTo(0.0025, 9);
    expect(typeof body.bindingCount).toBe('number');
  });

  it('serves GET /api/health/take-profit-early unauthenticated, DARK + demo-only by default (TRA-1294)', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/take-profit-early')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      flag: string;
      enabled: boolean;
      demoOnly: boolean;
      liveCapitalReachable: boolean;
      config: { captureFrac: number };
    };
    expect(body.ok).toBe(true);
    expect(body.flag).toBe('TAKE_PROFIT_EARLY_ENABLED');
    // DARK by default (no env flag set in the test process).
    expect(body.enabled).toBe(false);
    expect(body.demoOnly).toBe(true);
    expect(body.liveCapitalReachable).toBe(false);
    expect(body.config.captureFrac).toBeCloseTo(0.6, 9);
  });
});

describe('TRA-1481 churn-brake health route', () => {
  beforeEach(() => clearChurnBrakeLedger());

  it('serves GET /api/health/churn-brake unauthenticated, DARK + demo-only by default', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/churn-brake')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      flag: string;
      armed: boolean;
      cap: number;
      demoOnly: boolean;
      liveCapitalReachable: boolean;
      opensRejected: number;
      dcaAddsHalted: number;
    };
    expect(body.ok).toBe(true);
    expect(body.flag).toBe('ENABLE_CHURN_LOSS_BRAKE');
    expect(body.armed).toBe(false); // no env flag set in the test process
    expect(body.cap).toBe(3); // default cap
    expect(body.demoOnly).toBe(true);
    expect(body.liveCapitalReachable).toBe(false);
    expect(body.opensRejected).toBe(0);
    expect(body.dcaAddsHalted).toBe(0);
  });

  it('reports armed + cap from env and folds the ledger counters', () => {
    process.env.ENABLE_CHURN_LOSS_BRAKE = '1';
    process.env.CHURN_SAME_SESSION_OPEN_CAP = '3';
    recordChurnBrakeOpen('AMPG', '2026-07-08');
    recordChurnBrakeOpenRejected('AMPG', 3, 3, NOW);
    recordChurnBrakeDcaHalt('RIVN', 'equity', -120, NOW);
    try {
      const { app, routes } = fakeApp();
      registerLiveHealthRoutes(app, {
        requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
        userCtx: async () => ctx('admin', engineState()),
        getSettings: () => settings(),
        now: () => NOW,
      });
      const res = fakeRes();
      routes.get('/api/health/churn-brake')![0]!({}, res);
      const body = res.body as {
        armed: boolean;
        cap: number;
        opensRejected: number;
        dcaAddsHalted: number;
        openCountsBySymbol: { symbol: string; count: number }[];
      };
      expect(body.armed).toBe(true);
      expect(body.cap).toBe(3);
      expect(body.opensRejected).toBe(1);
      expect(body.dcaAddsHalted).toBe(1);
      expect(body.openCountsBySymbol[0]).toMatchObject({ symbol: 'AMPG', count: 1 });
    } finally {
      delete process.env.ENABLE_CHURN_LOSS_BRAKE;
      delete process.env.CHURN_SAME_SESSION_OPEN_CAP;
    }
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

// TRA-991 — option-trade journal readout builder.
describe('buildOptionJournalReport', () => {
  const closedRow: OptionTradeJournalRecord = {
    id: 'p1',
    openTs: NOW - 86_400_000,
    symbol: 'AAPL',
    structure: 'bull_put',
    mode: 'demo',
    ivRank: 60,
    trend: 'up',
    sentiment: 0.2,
    entryDelta: 0.2,
    entryDte: 35,
    atRiskUsd: 320,
    agentConviction: 0.7,
    outcome: 'WIN',
    closeTs: NOW,
    realizedPnlUsd: 320,
    realizedR: 1,
    exitReason: 'manual',
    holdDays: 1,
  };

  it('folds rows into the summary + learned weights and reflects the flag', () => {
    const report = buildOptionJournalReport([closedRow], NOW, true);
    expect(report.ok).toBe(true);
    expect(report.enabled).toBe(true);
    expect(report.summary.total).toBe(1);
    expect(report.summary.closed).toBe(1);
    expect(report.summary.win).toBe(1);
    expect(report.summary.realizedPnlUsd).toBe(320);
    expect(report.summary.byStructure[0]?.structure).toBe('bull_put');
    // Learned weights present (neutral until min-sample, but the digest exists).
    expect(report.weights.generatedFrom.rows).toBe(1);
    expect(report.weights.generatedFrom.resolved).toBe(1);
  });

  it('serves an empty (disabled) readout without rows', () => {
    const report = buildOptionJournalReport([], NOW, false);
    expect(report.enabled).toBe(false);
    expect(report.summary.total).toBe(0);
    expect(report.summary.byStructure).toHaveLength(0);
  });

  // TRA-1591 — post-arm cohort filter for grading the OTM entry delta floor.
  describe('sinceTs cohort filter', () => {
    const armTs = NOW - 3_600_000; // arm boundary 1h ago
    // pre-arm low-delta bleed loser (entryDelta 0.2, well before the floor)
    const preArm: OptionTradeJournalRecord = {
      ...closedRow,
      id: 'pre',
      structure: 'single_leg_otm',
      openTs: armTs - 86_400_000,
      entryDelta: 0.2,
      outcome: 'LOSS',
      realizedPnlUsd: -100,
      realizedR: -1,
    };
    // post-arm floored winner (entryDelta 0.45 >= 0.40 by construction)
    const postArm: OptionTradeJournalRecord = {
      ...closedRow,
      id: 'post',
      structure: 'single_leg_otm',
      openTs: armTs + 60_000,
      entryDelta: 0.45,
      outcome: 'WIN',
      realizedPnlUsd: 200,
      realizedR: 1,
    };

    it('absent sinceTs → cumulative pool (regression-safe)', () => {
      const cumulative = buildOptionJournalReport([preArm, postArm], NOW, true);
      const otm = cumulative.summary.byStructure.find((s) => s.structure === 'single_leg_otm');
      expect(otm?.closed).toBe(2);
      expect(otm?.realizedPnlUsd).toBe(100); // -100 + 200
      expect(cumulative.sinceTs).toBeUndefined();
    });

    it('scopes summary.byStructure to entry openTs >= sinceTs', () => {
      const cohort = buildOptionJournalReport([preArm, postArm], NOW, true, undefined, armTs);
      const otm = cohort.summary.byStructure.find((s) => s.structure === 'single_leg_otm');
      expect(otm?.closed).toBe(1); // only the post-arm floored fill
      expect(otm?.avgR).toBe(1);
      expect(otm?.winRate).toBe(1);
      expect(otm?.realizedPnlUsd).toBe(200);
      expect(cohort.sinceTs).toBe(armTs);
      // Learned weights stay over the FULL row set — cohort filter must not perturb them.
      expect(cohort.weights.generatedFrom.rows).toBe(2);
    });
  });
});
