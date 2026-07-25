// TRA-528 — health route registrar + stale-state monitor tests.
//
// Exercises the HTTP surface with a fake express app and fake user contexts so
// the wiring is verified without booting the real server.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
  rollUpExitCadence,
  RTH_DECOUPLED_SHARE_FLOOR,
  type HealthUserContext,
} from './health-routes.js';
import type { OptionTradeJournalRecord, OptionTradeJournalOpen } from '../option-trade-journal.js';
import {
  OPTION_TRADE_JOURNAL_FLAG,
  recordOptionTradeOpen,
  setOptionTradeJournalFileForTests,
} from '../option-trade-journal.js';
import {
  clearChurnBrakeLedger,
  recordChurnBrakeOpen,
  recordChurnBrakeOpenRejected,
  recordChurnBrakeDcaHalt,
} from '../churn-brake-ledger.js';
import { clearCostAwareGateLedger, recordCostAwareGateDecision } from '../cost-aware-gate-ledger.js';
import { SCALEOUT_LADDER_FLAG } from '../scaleout-ladder-flag.js';
import {
  clearScaleoutLadderLedger,
  runScaleoutLadderObservePass,
} from '../scaleout-ladder-ledger.js';
import { clearEntryGreeksLedger, recordEntryGreeksVerdict } from '../entry-greeks-ledger.js';
import {
  clearGiveBackArmFloorLedger,
  recordGiveBackState,
} from '../giveback-arm-floor-ledger.js'; // TRA-2220
import {
  beginEquityEntryPass,
  recordEquityEntryPassGated,
  recordEquityCandidate,
  recordEquityEntryRejected,
  recordEquitySymbolEvaluated,
  recordEquitySymbolSkipped,
  __resetEquityEntryFunnelForTests,
  type EquityEntryFunnelBlock,
} from '../equity-entry-funnel.js';
import { beginRvScan, __resetRvScanTelemetry } from '../rv-scan-telemetry.js'; // TRA-2193
import { etDateString } from '../scheduler.js';
import { checkStaleState } from './alerts.js';
import { getRecentAlerts, __resetAlertsForTest } from './alerts.js';
import type { EngineState, ExitCadenceHealth, ExitIntervalBucket, LiveEquityAcceptance } from '../signal-engine.js';
import { categorizeLiveSkipReason, emptyLiveSkipBreakdown, emptyDecoupledExitSkips, emptyExitIntervalHistogram } from '../signal-engine.js';
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

  // TRA-2209 — the env-drift route must be mounted UNCONDITIONALLY and UNGATED.
  // bqb1's admin auth is dead (401), so an auth-gated drift check would be exactly
  // as unreachable as the wipe it exists to catch, and an optionally-mounted one
  // would 404 on precisely the box that needs it. Both are asserted here.
  it('serves env drift on GET /api/health/env-drift (no auth handler, always mounted)', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never, // would BLOCK if the route were gated
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
      // no `effectiveEnv` dep — the route must still mount and fall back
    });

    const handlers = routes.get('/api/health/env-drift')!;
    expect(handlers).toBeDefined();
    expect(handlers).toHaveLength(1); // unauthenticated

    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      parserOk: boolean;
      declaredKeysParsed: number;
      declaredValuesParsed: number;
      driftCount: number;
      blueprintFound: boolean;
    };

    // It must actually read the committed render.yaml from the running module
    // path — a route that reports `blueprintFound:false` in prod is a dead
    // instrument that still returns 200.
    expect(body.blueprintFound).toBe(true);
    expect(body.parserOk).toBe(true);
    expect(body.declaredKeysParsed).toBeGreaterThan(0);
    // The count that separates a broken parse from a clean box (TRA-2075) — the
    // original bug read 78 keys and 0 values and printed "all clear".
    expect(body.declaredValuesParsed).toBeGreaterThan(0);
    expect(typeof body.driftCount).toBe('number');
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
      hiddenTestBookCount: number;
      testBookNote: string | null;
      books: Array<{ label: string; role: string; book: { equity: { totalEquity: number } } }>;
    };
    expect(body.ok).toBe(true);
    expect(body.demoEngineCount).toBe(1);
    expect(body.books[0]!.label).toBe('demo-1');
    expect(body.books[0]!.role).toBe('demo');
    expect(body.books[0]!.book.equity.totalEquity).toBe(25_500);
    // TRA-1949 — no test books here, so nothing hidden and no note.
    expect(body.hiddenTestBookCount).toBe(0);
    expect(body.testBookNote).toBeNull();
  });

  it('TRA-1949 hides QA/test books by default with a note; ?includeTest=1 restores them', async () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never,
      userCtx: async () => {
        throw new Error('userCtx must not run on the public path');
      },
      getSettings: () => settings(),
      demoBooks: () => [
        { username: 'richard', state: demoState(), mode: 'demo' },
        { username: 'qa_reg_1', state: demoState(), mode: 'demo' },
        { username: 'qa_mirror_2', state: demoState(), mode: 'demo' },
      ],
      now: () => NOW,
    });
    const handler = routes.get('/api/health/demo-book-public')![0]!;

    // Default — the two QA books are hidden, Richard remains.
    const resDefault = resWithLocals();
    await handler({ query: {} }, resDefault);
    const bodyDefault = resDefault.body as {
      demoEngineCount: number;
      hiddenTestBookCount: number;
      testBookNote: string | null;
      books: Array<{ label: string; role: string }>;
    };
    expect(bodyDefault.demoEngineCount).toBe(1);
    expect(bodyDefault.hiddenTestBookCount).toBe(2);
    expect(bodyDefault.testBookNote).toContain('2 QA/test books hidden');
    expect(bodyDefault.books.map(b => b.role)).toEqual(['demo']);

    // ?includeTest=1 — every book returns, QA books tagged role 'test'.
    const resAll = resWithLocals();
    await handler({ query: { includeTest: '1' } }, resAll);
    const bodyAll = resAll.body as {
      demoEngineCount: number;
      hiddenTestBookCount: number;
      testBookNote: string | null;
      books: Array<{ label: string; role: string }>;
    };
    expect(bodyAll.demoEngineCount).toBe(3);
    expect(bodyAll.hiddenTestBookCount).toBe(0);
    expect(bodyAll.testBookNote).toBeNull();
    expect(bodyAll.books.filter(b => b.role === 'test')).toHaveLength(2);
  });

  it('TRA-1949 labels the LIVE_EQUITY_BOOT_USER operator book distinctly and never hides it', async () => {
    const { app, routes } = fakeApp();
    const prev = process.env['LIVE_EQUITY_BOOT_USER'];
    process.env['LIVE_EQUITY_BOOT_USER'] = 'admin';
    try {
      registerLiveHealthRoutes(app, {
        requireAuth: (() => undefined) as never,
        userCtx: async () => {
          throw new Error('userCtx must not run on the public path');
        },
        getSettings: () => settings(),
        demoBooks: () => [
          { username: 'admin', state: demoState(), mode: 'demo' },
          { username: 'richard', state: demoState(), mode: 'demo' },
          { username: 'qa_reg_1', state: demoState(), mode: 'demo' },
        ],
        now: () => NOW,
      });
      const handler = routes.get('/api/health/demo-book-public')![0]!;
      const res = resWithLocals();
      await handler({ query: {} }, res);
      const body = res.body as {
        demoEngineCount: number;
        hiddenTestBookCount: number;
        books: Array<{ label: string; role: string }>;
      };
      // admin → operator (kept, labelled), richard → demo, qa_reg_1 → hidden.
      expect(body.demoEngineCount).toBe(2);
      expect(body.hiddenTestBookCount).toBe(1);
      const operator = body.books.find(b => b.role === 'operator');
      expect(operator?.label).toBe('operator (live)');
      expect(body.books.map(b => b.role).sort()).toEqual(['demo', 'operator']);
    } finally {
      if (prev === undefined) delete process.env['LIVE_EQUITY_BOOT_USER'];
      else process.env['LIVE_EQUITY_BOOT_USER'] = prev;
    }
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

// TRA-1682 (parent TRA-1680 → TRA-1677) — the entry-greeks gate readout used to report
// `enabled` + thresholds and NOTHING about what the gate did, which is how an
// ALGEBRAICALLY IMPOSSIBLE gate (a [0.30,0.40] short-premium band applied to a sleeve
// whose selector cannot emit |Δ| < 0.45 ⇒ 100% reject) stayed invisible for a week: a
// gate rejecting everything and a tape offering nothing look identical when nothing
// counts. These tests pin the counts, and the `starving` alarm that names the difference.
describe('TRA-1682 entry-greeks-gate health route — admit/reject counts', () => {
  const etDay = etDateString(new Date(NOW));
  beforeEach(() => clearEntryGreeksLedger());
  afterEach(() => clearEntryGreeksLedger());

  function serve() {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/entry-greeks-gate')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    return res.body as {
      ok: boolean;
      flag: string;
      enabled: boolean;
      demoOnly: boolean;
      liveCapitalReachable: boolean;
      etDay: string;
      config: { deltaBand: [number, number]; deltaThetaRatioFloor: number };
      admitted: number;
      rejectedByReason: Record<string, number>;
      rejectedTotal: number;
      evaluated: number;
      admitRate: number | null;
      starving: boolean;
      warning?: string;
    };
  }

  it('reports the EFFECTIVE delta band (the 0.45 selector floor), not the short-premium default', () => {
    // The band the engine actually passes since `07ea3b1` is [RV_LONG_DELTA_FLOOR, 1].
    // This surface used to advertise the library default [0.30,0.40] — an observability
    // endpoint reporting a band the engine does not apply is how the bug hid.
    const body = serve();
    expect(body.ok).toBe(true);
    expect(body.flag).toBe('ENTRY_GREEKS_GATE_ENABLED');
    expect(body.demoOnly).toBe(true);
    expect(body.liveCapitalReachable).toBe(false);
    expect(body.etDay).toBe(etDay);
    expect(body.config.deltaBand).toEqual([0.45, 1]);
  });

  it('an un-run gate reports evaluated 0 with admitRate NULL (not 0) and no warning', () => {
    // "Nothing reached the gate" must never read the same as "the gate refused
    // everything" — that ambiguity IS the TRA-1677 defect.
    const body = serve();
    expect(body.evaluated).toBe(0);
    expect(body.admitted).toBe(0);
    expect(body.admitRate).toBeNull();
    expect(body.starving).toBe(false);
    expect(body.warning).toBeUndefined();
  });

  it('folds the durable per-reason reject counts + the admit count for the ET day', () => {
    recordEntryGreeksVerdict(true, null, etDay, 'rv-long', NOW);
    recordEntryGreeksVerdict(true, null, etDay, 'rv-long', NOW);
    recordEntryGreeksVerdict(true, null, etDay, 'rv-long', NOW);
    recordEntryGreeksVerdict(false, 'delta_out_of_band', etDay, 'rv-long', NOW);
    recordEntryGreeksVerdict(false, 'delta_theta_ratio_too_low', etDay, 'rv-long', NOW);
    recordEntryGreeksVerdict(false, 'non_finite_greeks', etDay, 'rv-long', NOW);

    const body = serve();
    expect(body.admitted).toBe(3);
    expect(body.rejectedByReason).toEqual({
      delta_out_of_band: 1,
      delta_theta_ratio_too_low: 1,
      non_finite_greeks: 1,
    });
    expect(body.rejectedTotal).toBe(3);
    expect(body.evaluated).toBe(6);
    expect(body.admitRate).toBe(0.5);
    expect(body.starving).toBe(false);
    expect(body.warning).toBeUndefined();
  });

  it('an ALL-REJECT session is LOUD — starving + a warning naming the gate as suspect', () => {
    // The exact TRA-1677 shape. This is the read that would have caught it on day one.
    for (let i = 0; i < 25; i++) recordEntryGreeksVerdict(false, 'delta_out_of_band', etDay, 'rv-long', NOW);

    const body = serve();
    expect(body.evaluated).toBe(25);
    expect(body.admitted).toBe(0);
    expect(body.admitRate).toBe(0);
    expect(body.starving).toBe(true);
    expect(body.warning).toContain('admitted 0 of 25');
    expect(body.warning).toContain('suspect the GATE');
  });
});

describe('TRA-1602 cost-aware fire-bar health route', () => {
  beforeEach(() => clearCostAwareGateLedger());
  afterEach(() => clearCostAwareGateLedger());

  it('serves GET /api/health/cost-aware-gate unauthenticated, DARK + demo-only by default', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/cost-aware-gate')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      flag: string;
      armed: boolean;
      demoOnly: boolean;
      liveCapitalReachable: boolean;
      bars: Record<string, number>;
      admittedTotal: number;
      rejectedTotal: number;
    };
    expect(body.ok).toBe(true);
    expect(body.flag).toBe('ENABLE_OPTION_COST_AWARE_GATE');
    expect(body.armed).toBe(false); // no env flag set in the test process
    expect(body.demoOnly).toBe(true);
    expect(body.liveCapitalReachable).toBe(false);
    // TRA-1661 — the options bar off the MEASURED spread cross: commission 0.05 +
    // spread 0.235 (TRA-1656) + margin 0.20 = 0.485R, clear of the 0.30 floor.
    // Was 1.25R against the refuted 1.00R modeled cross.
    expect(body.bars['single_leg_rv']).toBeCloseTo(0.485, 3);
    expect(body.bars['single_leg_otm']).toBeCloseTo(0.485, 3);
    expect(body.admittedTotal).toBe(0);
    expect(body.rejectedTotal).toBe(0);
  });

  it('reports armed from env and folds the durable admit/reject tallies', () => {
    process.env.ENABLE_OPTION_COST_AWARE_GATE = '1';
    const etDay = etDateString(new Date(NOW));
    recordCostAwareGateDecision('single_leg_rv', true, 1.9, 1.25, etDay, NOW);
    recordCostAwareGateDecision('single_leg_rv', false, 0.2, 1.25, etDay, NOW);
    try {
      const { app, routes } = fakeApp();
      registerLiveHealthRoutes(app, {
        requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
        userCtx: async () => ctx('admin', engineState()),
        getSettings: () => settings(),
        now: () => NOW,
      });
      const res = fakeRes();
      routes.get('/api/health/cost-aware-gate')![0]!({}, res);
      const body = res.body as {
        armed: boolean;
        admittedTotal: number;
        rejectedTotal: number;
        byStructure: { structure: string; admitted: number; rejected: number; avgRejectedGrossR: number | null }[];
      };
      expect(body.armed).toBe(true);
      expect(body.admittedTotal).toBe(1);
      expect(body.rejectedTotal).toBe(1); // the direct evidence the bar is biting
      expect(body.byStructure[0]).toMatchObject({
        structure: 'single_leg_rv',
        admitted: 1,
        rejected: 1,
        avgRejectedGrossR: 0.2,
      });
    } finally {
      delete process.env.ENABLE_OPTION_COST_AWARE_GATE;
    }
  });
});

// TRA-2311 (parent TRA-2295) — the spread ceiling's ARM BIT.
//
// `spreadCeilingEvaluated: 0` has two causes — ARMED-but-no-entry-reached-the-gate
// (verdict VOID) and DISARMED (verdict MEANINGLESS) — and before this block they
// were indistinguishable on the wire. A field that reads `true` in both states is
// not a fix, so every case below MUTATES the switch and asserts the bit MOVES.
describe('TRA-2311 spreadCeiling arm bit on /api/health/cost-aware-gate', () => {
  interface SpreadCeilingBlock {
    flag: string;
    armed: boolean;
    defaultOn: boolean;
    flagValue: string | null;
    overlayCapable: boolean;
    minBidUsdOverride: number | null;
    structures: string[];
    perStructure: { structure: string; maxSpreadPct: number; minBidUsd: number }[];
    note: string;
  }

  const serveCostGate = (): { spreadCeiling: SpreadCeilingBlock; armed: boolean } => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const res = fakeRes();
    routes.get('/api/health/cost-aware-gate')![0]!({}, res);
    return res.body as { spreadCeiling: SpreadCeilingBlock; armed: boolean };
  };

  const FLAG = 'OPTION_SPREAD_CEILING_ENFORCE';
  const MIN_BID = 'OPTION_SPREAD_CEILING_MIN_BID_USD';
  let tmp: string | null = null;

  beforeEach(() => {
    clearCostAwareGateLedger();
    delete process.env[FLAG];
    delete process.env[MIN_BID];
  });
  afterEach(() => {
    clearCostAwareGateLedger();
    delete process.env[FLAG];
    delete process.env[MIN_BID];
    delete process.env.DATA_DIR;
    delete process.env.ENABLE_OPTION_COST_AWARE_GATE;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('ABSENT flag ⇒ armed TRUE — the opt-OUT default, opposite polarity to deltaCeiling', () => {
    const { spreadCeiling } = serveCostGate();
    expect(spreadCeiling.flag).toBe(FLAG);
    expect(spreadCeiling.armed).toBe(true); // AC3: the default-ON half
    expect(spreadCeiling.defaultOn).toBe(true);
    expect(spreadCeiling.flagValue).toBeNull();
    expect(spreadCeiling.structures).toContain('single_leg_directional');
    // AC4 — the polarity has to be stated, not merely implemented: a reader who
    // pattern-matches this block onto deltaCeiling's opt-IN wording concludes the
    // exact opposite of the truth.
    expect(spreadCeiling.note).toContain('opt-OUT');
    expect(spreadCeiling.note).toMatch(/ABSENT .* is ARMED/);
    expect(spreadCeiling.note).toContain('ARMED');
  });

  it('OPTION_SPREAD_CEILING_ENFORCE=0 ⇒ armed FALSE — the bit MOVES (prove-it-fires)', () => {
    process.env[FLAG] = '0';
    const { spreadCeiling } = serveCostGate();
    expect(spreadCeiling.armed).toBe(false); // AC3: the disarmed half
    expect(spreadCeiling.flagValue).toBe('0');
    // The note must tell the Monday grader the verdict is void, not a pass.
    expect(spreadCeiling.note).toContain('DISARMED');
    expect(spreadCeiling.note).toContain('MEANINGLESS');
  });

  it.each(['false', 'no', 'off', 'OFF'])('an explicit %s also disarms', (value) => {
    process.env[FLAG] = value;
    expect(serveCostGate().spreadCeiling.armed).toBe(false);
  });

  it('a TYPO does NOT silently disarm — only an explicit off value does', () => {
    process.env[FLAG] = 'flase';
    expect(serveCostGate().spreadCeiling.armed).toBe(true);
  });

  it('resolves through resolveDemoFlagEnv (the engine path), NOT process.env directly', () => {
    // Positive control FIRST: without it, a `spreadCeiling.armed` that ignores the
    // overlay is indistinguishable from a route that never opened the file at all.
    // ENABLE_OPTION_COST_AWARE_GATE *is* allowlisted, so if the top-level `armed`
    // flips from the file, the route demonstrably read the overlay on this call.
    tmp = mkdtempSync(join(tmpdir(), 'tra2311-'));
    writeFileSync(
      join(tmp, 'demo-flags.json'),
      JSON.stringify({ ENABLE_OPTION_COST_AWARE_GATE: '1', [FLAG]: '0' }),
      'utf8',
    );
    process.env.DATA_DIR = tmp;

    const { armed, spreadCeiling } = serveCostGate();
    expect(armed).toBe(true); // control: the overlay WAS read on this request

    // ...and now the finding this test exists to pin. The kill switch documented as
    // "demo-flags file in demo" is NOT on DEMO_FLAG_ALLOWLIST, so `loadDemoFlagFile`
    // drops it and the overlay resolves it straight through to process.env. The
    // route reports that rather than implying a file channel that does not exist —
    // an operator who "disarmed" via the file would otherwise be reading a lie.
    expect(spreadCeiling.overlayCapable).toBe(false);
    expect(spreadCeiling.armed).toBe(true);
    expect(spreadCeiling.note).toContain('NOT on DEMO_FLAG_ALLOWLIST');
    expect(spreadCeiling.note).toContain('PROCESS env');

    // The process env IS the live channel — same request shape, flag moved there.
    process.env[FLAG] = '0';
    expect(serveCostGate().spreadCeiling.armed).toBe(false);
  });

  it('reports the effective min-bid floor the engine applies, including the ""⇒0 edge', () => {
    expect(serveCostGate().spreadCeiling.minBidUsdOverride).toBeNull();
    const base = serveCostGate().spreadCeiling.perStructure.find(
      (s) => s.structure === 'single_leg_directional',
    )!;
    expect(base.minBidUsd).toBeCloseTo(0.1, 6);

    process.env[MIN_BID] = '0.25';
    const tuned = serveCostGate().spreadCeiling;
    expect(tuned.minBidUsdOverride).toBeCloseTo(0.25, 6);
    expect(
      tuned.perStructure.find((s) => s.structure === 'single_leg_directional')!.minBidUsd,
    ).toBeCloseTo(0.25, 6);

    // `Number('')` is 0 — finite and >= 0 — so an EMPTY value removes the floor in
    // the engine. Mirrored here on purpose: telemetry that hid it would report a
    // floor the entry path is not applying.
    process.env[MIN_BID] = '';
    expect(serveCostGate().spreadCeiling.minBidUsdOverride).toBe(0);
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

  // TRA-1661 (TRA-1647A) — the byDelta rollup must reach the WIRE, per structure and
  // in both R bases. Without it QuantTrader cannot set the win-probability knob and
  // the cost-aware gate cannot be validated at all, so this is the load-bearing
  // contract of the ticket, not a nice-to-have.
  it('serves a per-structure byDelta block with dispersion and both R bases', () => {
    const rv = (id: string, delta: number, r: number): OptionTradeJournalRecord => ({
      ...closedRow,
      id,
      structure: 'single_leg_rv',
      entryDelta: delta,
      realizedR: r,
      realizedPnlUsd: r * 320,
    });
    const report = buildOptionJournalReport(
      [rv('a', 0.32, 0.1), rv('b', 0.34, 0.2), { ...closedRow, id: 'c' }],
      NOW,
      true,
    );

    // Sleeves are split, never pooled — they are the confound.
    const sleeves = report.summary.byDelta.map((s) => s.structure).sort();
    expect(sleeves).toEqual(['bull_put', 'single_leg_rv']);

    const rvSleeve = report.summary.byDelta.find((s) => s.structure === 'single_leg_rv')!;
    expect(rvSleeve.gateBasisValid).toBe(true);
    const band = rvSleeve.buckets.find((b) => b.bucket === '0.30-0.35')!;
    expect(band.closed).toBe(2);
    expect(band.avgRealizedR_premiumBasis).toBeCloseTo(0.15, 10);
    expect(band.avgRealizedR_gateBasis).toBeCloseTo(0.6, 10); // gate R = 4 x premium R
    expect(band.sdRealizedR_premiumBasis).not.toBeNull(); // the CI input — not optional
    expect(band.seRealizedR_premiumBasis).not.toBeNull();

    // A credit spread has no valid premium->gate conversion; it must say so rather
    // than publish a number scaled by a factor that does not apply to it.
    const spread = report.summary.byDelta.find((s) => s.structure === 'bull_put')!;
    expect(spread.gateBasisValid).toBe(false);
    expect(spread.buckets[0]!.avgRealizedR_gateBasis).toBeNull();
  });

  // TRA-1691 — the byDelta rows must reach the wire keyed on the SLEEVE
  // (`structure × entryArchetype`), not just the structure. This is the contract
  // TRA-1690's |Δ| > 0.65 ceiling verdict is graded off: on the live book that tail is
  // n=94, of which 37 are `iv-rv-buy-premium` wearing the `single_leg_rv` label. Without
  // the archetype axis on the wire, the RV long's verdict silently eats another
  // scanner's rows and QuantTrader cannot tell.
  it('serves byDelta keyed on structure x entryArchetype, scopable by sinceTs', () => {
    const tagTs = NOW - 3_600_000; // the tagging deploy boundary
    const row = (
      id: string,
      openTs: number,
      archetype: string | undefined,
      r: number,
    ): OptionTradeJournalRecord => ({
      ...closedRow,
      id,
      openTs,
      structure: 'single_leg_rv',
      entryDelta: 0.66,
      realizedR: r,
      realizedPnlUsd: r * 320,
      ...(archetype ? { entryArchetype: archetype } : {}),
    });
    const rows = [
      row('legacy', tagTs - 1000, undefined, -0.5), // pre-tagging blend
      row('rv1', tagTs + 1000, 'rv-long', -0.2),
      row('rv2', tagTs + 2000, 'rv-long', -0.4),
      row('ivrv', tagTs + 3000, 'iv-rv-buy-premium', 0.9), // a DIFFERENT sleeve, same structure
    ];

    const cumulative = buildOptionJournalReport(rows, NOW, true);
    expect(cumulative.summary.byDelta.map((c) => c.cohort).sort()).toEqual([
      'single_leg_rv::iv-rv-buy-premium',
      'single_leg_rv::rv-long',
      'single_leg_rv::unspecified',
    ]);

    // Scoped to the post-tagging cohort, `unspecified` is GONE — that is the check that
    // tagging actually took effect on the running box, and the precondition for grading
    // the tail at all (a growing `unspecified` post-deploy means tagging is broken).
    const scoped = buildOptionJournalReport(rows, NOW, true, undefined, tagTs);
    expect(scoped.sinceTs).toBe(tagTs);
    expect(scoped.summary.byDelta.map((c) => c.cohort).sort()).toEqual([
      'single_leg_rv::iv-rv-buy-premium',
      'single_leg_rv::rv-long',
    ]);

    // And the RV long's tail is ITS OWN: −0.30R premium / −1.20R gate basis. Pooled with
    // the premium buyer the same band reads +0.10R — the ceiling verdict flips sign.
    const rvLong = scoped.summary.byDelta.find((c) => c.entryArchetype === 'rv-long')!;
    const tail = rvLong.buckets.find((b) => b.bucket === '0.65-0.70')!;
    expect(tail.closed).toBe(2);
    expect(tail.avgRealizedR_premiumBasis).toBeCloseTo(-0.3, 10);
    expect(tail.avgRealizedR_gateBasis).toBeCloseTo(-1.2, 10);
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

  // TRA-2082 — `sinceTs` scoped `summary` but NOT the `?rows=demo` dump, so one 200
  // carried two populations with nothing on the wire marking the difference. That is
  // the false-PASS shape: a TRA-1585 delta-floor grade counting `rows` under a
  // `sinceTs` reads n=1035/+0.0173R (PASS, auto-unblocks TRA-1407) where the truthful
  // cohort is n=10.
  //
  // Per TRA-2076 the assertion is on the COVERAGE COUNTS, not the verdict: a fixture
  // with zero rows outside the boundary passes a naive version of this test in BOTH
  // the fixed and broken states, so the fixture below is asserted to straddle it.
  describe('sinceTs applies to the rows dump, not just the summary (TRA-2082)', () => {
    const armTs = NOW - 3_600_000;
    const otm = (id: string, openTs: number, r: number): OptionTradeJournalRecord => ({
      ...closedRow,
      id,
      openTs,
      structure: 'single_leg_otm',
      outcome: r > 0 ? 'WIN' : 'LOSS',
      realizedR: r,
      realizedPnlUsd: r * 320,
    });
    // 3 pre-arm, 2 post-arm. The pre-arm side is deliberately the LARGER and the
    // opposite-signed one, so the broken (unfiltered-rows) build reads a different
    // count AND a different avgR — the two states cannot look alike.
    const rows = [
      otm('pre1', armTs - 86_400_000, -1),
      otm('pre2', armTs - 72_000_000, -1),
      otm('pre3', armTs - 60_000_000, -1),
      otm('post1', armTs + 60_000, 1),
      otm('post2', armTs + 120_000, 1),
    ];
    // An OPEN row and a live-mode row: the dump's own filters must survive the change.
    const excluded = [
      { ...otm('open', armTs + 90_000, 0), outcome: 'OPEN' as const },
      { ...otm('live', armTs + 95_000, 1), mode: 'live' as const },
    ];

    it('fixture straddles the boundary (guards the test itself)', () => {
      expect(rows.filter((r) => r.openTs < armTs)).toHaveLength(3);
      expect(rows.filter((r) => r.openTs >= armTs)).toHaveLength(2);
    });

    it('rows and summary.closed describe the SAME population under sinceTs', () => {
      const report = buildOptionJournalReport(rows, NOW, true, undefined, armTs, true);
      const otmSummary = report.summary.byStructure.find(
        (s) => s.structure === 'single_leg_otm',
      );

      // The load-bearing assertion: the two halves agree on n.
      expect(report.rows).toHaveLength(2);
      expect(otmSummary?.closed).toBe(2);
      expect(report.rows).toHaveLength(otmSummary!.closed);

      // ...and on the number a gate would actually read. Broken build: n=5, avgR −0.2.
      expect(otmSummary?.avgR).toBe(1);
      expect(report.rows!.map((r) => r.id).sort()).toEqual(['post1', 'post2']);

      // The applied filter is on the wire, so a consumer asserts instead of assuming.
      expect(report.appliedSinceTs).toBe(armTs);
      expect(report.filterAxis).toBe('openTs');
      expect(report.rowsFiltered).toBe(true);
      expect(report.rowsMode).toBe('demo');
    });

    it('without sinceTs the dump is the cumulative pool and says so', () => {
      const report = buildOptionJournalReport(rows, NOW, true, undefined, undefined, true);
      const otmSummary = report.summary.byStructure.find(
        (s) => s.structure === 'single_leg_otm',
      );
      expect(report.rows).toHaveLength(5);
      expect(report.rows).toHaveLength(otmSummary!.closed);
      // `null`, not `0` — `0` is a real epoch and would read as a filter that applied.
      expect(report.appliedSinceTs).toBeNull();
      expect(report.rowsFiltered).toBe(false);
    });

    // The SECOND population axis, found while writing the test above. `rows` is
    // demo-and-resolved; `summary` folds BOTH modes. So the two halves agree on the
    // sinceTs cohort but NOT on mode, and `rows.length === summary.closed` is a
    // coincidence of an all-demo book, not a contract. `rowsMode` says so on the wire
    // rather than leaving the next consumer to rediscover it the hard way.
    it('rows stays demo-and-resolved while summary spans both modes — stated, not hidden', () => {
      const report = buildOptionJournalReport(
        [...rows, ...excluded],
        NOW,
        true,
        undefined,
        armTs,
        true,
      );
      const otmSummary = report.summary.byStructure.find(
        (s) => s.structure === 'single_leg_otm',
      );

      // Both post-arm exclusions are inside the sinceTs cohort, so this gap is the
      // MODE/OPEN axis alone — not a filter leak.
      expect(report.rows!.map((r) => r.id).sort()).toEqual(['post1', 'post2']);
      expect(report.rows!.every((r) => r.mode === 'demo' && r.outcome !== 'OPEN')).toBe(true);
      // summary counts the live close too: 2 demo + 1 live = 3, vs 2 rows.
      expect(otmSummary?.closed).toBe(3);
      expect(report.rows).toHaveLength(2);
      expect(report.rowsMode).toBe('demo');
    });

    it('omits rows entirely when the dump was not requested', () => {
      const report = buildOptionJournalReport(rows, NOW, true, undefined, armTs);
      expect(report.rows).toBeUndefined();
      // `rowsFiltered` is absent WITH `rows` — the pair can never be read apart.
      expect(report.rowsFiltered).toBeUndefined();
      expect(report.appliedSinceTs).toBe(armTs);
    });
  });
});

// TRA-1656 (TRA-1602B) — the MEASURED option spread cross probe. Drives the real
// registered route against a real (temp-file) journal so the whole path is
// exercised: quote retention -> per-structure rollup -> retention statement.
describe('GET /api/health/option-spread-cost (TRA-1656)', () => {
  const JOURNAL = join(tmpdir(), `tra1656-spread-${Date.now()}.jsonl`);

  beforeEach(() => {
    process.env[OPTION_TRADE_JOURNAL_FLAG] = '1';
    setOptionTradeJournalFileForTests(JOURNAL);
  });
  afterEach(async () => {
    delete process.env[OPTION_TRADE_JOURNAL_FLAG];
    setOptionTradeJournalFileForTests(null);
    await rm(JOURNAL, { force: true });
  });

  function probe() {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    return routes.get('/api/health/option-spread-cost')!;
  }

  const openRow = (
    id: string,
    structure: string,
    quote: { entryBid: number; entryAsk: number; entryMarkUsd: number } | null,
  ): OptionTradeJournalOpen => ({
    id,
    openTs: NOW,
    symbol: 'AAPL',
    structure,
    mode: 'demo',
    ivRank: 50,
    trend: 'up',
    sentiment: null,
    sentimentIcBand: null,
    entryDelta: 0.4,
    entryDte: 30,
    atRiskUsd: 200,
    contracts: 1,
    optionSymbol: 'AAPL260529C00200000',
    ...(quote ?? {}),
  });

  it('is unauthenticated (secrets-free probe, one handler)', () => {
    expect(probe()).toHaveLength(1);
  });

  it('states the RETENTION GAP explicitly when no row carries a fill-time quote', async () => {
    // Pre-TRA-1656 rows: mark only, no bid/ask. This is the 2,153-trade history.
    await recordOptionTradeOpen(openRow('legacy-1', 'single_leg_rv', null));
    await recordOptionTradeOpen(openRow('legacy-2', 'single_leg_otm', null));

    const res = fakeRes();
    await probe()[0]!({}, res);
    const body = res.body as {
      n: number;
      byStructure: unknown[];
      retention: { rowsTotal: number; rowsWithFillTimeQuote: number; statement: string };
    };

    // The acceptance bar's escape hatch: say so, rather than report a fake number.
    expect(body.n).toBe(0);
    expect(body.byStructure).toEqual([]);
    expect(body.retention.rowsTotal).toBe(2);
    expect(body.retention.rowsWithFillTimeQuote).toBe(0);
    expect(body.retention.statement).toContain('NOT RETAINED');
  });

  it('MEASURES avgSpreadCrossR per structure once rows retain a fill-time quote', async () => {
    // RV: $2.00 mark, $0.12 spread => spreadPct 6% => crossR = 4 × 0.06 = 0.24R.
    await recordOptionTradeOpen(
      openRow('rv-1', 'single_leg_rv', { entryBid: 1.94, entryAsk: 2.06, entryMarkUsd: 2.0 }),
    );
    // OTM: $1.00 mark, $0.10 spread => spreadPct 10% => crossR = 0.40R.
    await recordOptionTradeOpen(
      openRow('otm-1', 'single_leg_otm', { entryBid: 0.95, entryAsk: 1.05, entryMarkUsd: 1.0 }),
    );
    // A legacy row with no quote must DROP OUT, not dilute the mean toward zero.
    await recordOptionTradeOpen(openRow('legacy-3', 'single_leg_rv', null));

    const res = fakeRes();
    await probe()[0]!({}, res);
    const body = res.body as {
      n: number;
      byStructure: Array<{
        structure: string;
        n: number;
        avgSpreadCrossR: number;
        avgCommissionR: number | null;
        impliedBarR: number;
      }>;
      modeledInput: { makerAdjustedSpreadCrossR: number; barR: number };
      retention: { rowsTotal: number; rowsWithFillTimeQuote: number };
    };

    expect(body.n).toBe(2);
    expect(body.retention.rowsTotal).toBe(3); // the legacy row is counted but not measured
    expect(body.retention.rowsWithFillTimeQuote).toBe(2);

    const rv = body.byStructure.find((s) => s.structure === 'single_leg_rv')!;
    const otm = body.byStructure.find((s) => s.structure === 'single_leg_otm')!;
    expect(rv.n).toBe(1); // NOT 2 — the quote-less row dropped out
    expect(rv.avgSpreadCrossR).toBeCloseTo(0.24, 6);
    expect(otm.avgSpreadCrossR).toBeCloseTo(0.4, 6);

    // TRA-1661 — the gate now ships the MEASURED cross (0.235R, TRA-1656) rather
    // than the refuted 1.00R model, so the probe's headline comparison is no longer
    // "measurement vs phantom" but "measurement vs the input it produced". Pinning
    // the shipped input here is what makes a silent revert to 1.00R fail a test.
    expect(body.modeledInput.makerAdjustedSpreadCrossR).toBe(0.235);
    expect(body.modeledInput.barR).toBeCloseTo(0.485, 3);
    // impliedBarR is re-derived from the MEASUREMENT (measured commission + measured
    // cross + margin), not from the config's cost inputs — that independence is the
    // whole point of the probe, and is what lets it re-falsify the gate if the two
    // ever drift apart.
    expect(rv.impliedBarR).toBeCloseTo((rv.avgCommissionR ?? 0.05) + rv.avgSpreadCrossR + 0.2, 6);
  });

  it('publishes the selection-independent ceilings, and the shipped input now sits under them', async () => {
    const res = fakeRes();
    await probe()[0]!({}, res);
    const body = res.body as {
      modeledInput: { makerAdjustedSpreadCrossR: number };
      ceilings: Record<string, { maxSpreadCrossR?: number }>;
    };
    // The bound holds with no fills at all — it is what refuted the old 1.00R input
    // at n=0. TRA-1661's replacement (0.235R) sits under BOTH ceilings, i.e. it is
    // feasible: it never charges more than the worst contract the scanner can pick.
    expect(body.ceilings['single_leg_otm']!.maxSpreadCrossR).toBe(0.8);
    expect(body.ceilings['single_leg_rv']!.maxSpreadCrossR).toBe(0.4);
    expect(body.modeledInput.makerAdjustedSpreadCrossR).toBeLessThan(0.4);
  });
});

// TRA-1729 — GET /api/health/scaleout-ladder must SERVE the observe-pass fields.
//
// This drives the real registrar and reads the response body, deliberately: the new
// keys reach the payload through a `...summarizeScaleoutLadder()` SPREAD, so grepping
// the route file for `observedPositionCount` finds nothing and would "prove" the key is
// absent on a build that serves it perfectly. Only reading the served body settles it.
describe('GET /api/health/scaleout-ladder — TRA-1729 observe-pass readout', () => {
  const prior = process.env[SCALEOUT_LADDER_FLAG];

  beforeEach(() => {
    process.env[SCALEOUT_LADDER_FLAG] = '1'; // armed
    clearScaleoutLadderLedger();
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[SCALEOUT_LADDER_FLAG];
    else process.env[SCALEOUT_LADDER_FLAG] = prior;
    clearScaleoutLadderLedger();
  });

  function ladderBody() {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/scaleout-ladder')!;
    const res = fakeRes();
    handlers[0]!({}, res);
    return res.body as {
      enabled: boolean;
      trimCount: number;
      observedPositionCount: number | null;
      openPositionCount: number | null;
      maxGainPctObserved: number | null;
      maxGainPctLastPass: number | null;
      lastObservePassAt: number | null;
      observePassCount: number;
      observeStatus: string;
      firstRungUp: number;
      blind: boolean;
    };
  }

  it('ARMED + EMPTY BOOK serves the ALARM, not a byte-identical "still accruing"', () => {
    runScaleoutLadderObservePass([], new Map(), 1_700_000_000_000);
    const body = ladderBody();

    expect(body.enabled).toBe(true);
    expect(body.trimCount).toBe(0); // …exactly what a healthy patient ladder shows
    expect(body.observedPositionCount).toBe(0); // …and THIS is what says it is blind
    expect(body.observeStatus).toBe('blind');
    expect(body.blind).toBe(true);
    expect(body.lastObservePassAt).toBe(1_700_000_000_000);
    expect(body.observePassCount).toBe(1);
    expect(body.maxGainPctObserved).toBeNull(); // null = never measured, NOT 0
  });

  it('ARMED + a long UNDER the first rung serves the close-but-not-firing state', () => {
    runScaleoutLadderObservePass(
      [{ id: 'p1', symbol: 'AAPL', side: 'buy', entryPrice: 100, quantity: 100 }],
      new Map([['AAPL', 124]]), // +24%, 1pp under the +25% rung
      1_700_000_000_000,
    );
    const body = ladderBody();

    expect(body.trimCount).toBe(0); // SAME trimCount as the blind case above…
    expect(body.observedPositionCount).toBe(1); // …but it is demonstrably WATCHING
    expect(body.openPositionCount).toBe(1);
    expect(body.observeStatus).toBe('observing');
    expect(body.blind).toBe(false);
    expect(body.maxGainPctObserved).toBeCloseTo(0.24, 10);
    expect(body.maxGainPctLastPass).toBeCloseTo(0.24, 10);
    expect(body.firstRungUp).toBe(0.25); // 0.24 vs 0.25 — how close it got
  });

  it('DISARMED reads never_ran and is not reported as blind', () => {
    process.env[SCALEOUT_LADDER_FLAG] = '0';
    const body = ladderBody();
    expect(body.enabled).toBe(false);
    expect(body.observeStatus).toBe('never_ran');
    expect(body.observedPositionCount).toBeNull(); // no reading ≠ read an empty book
    expect(body.blind).toBe(false); // a flag that is OFF is not an alarm
  });
});

// TRA-1768 — the equity entry funnel route.
//
// Acceptance #3 is explicit: read the SERVED RESPONSE BODY, not the route file. A
// literal-key grep over the source reads `0` even on a build that serves the key
// (keys can arrive via a spread), so the only assertion worth anything is one that
// invokes the registered handler and inspects what it actually emitted.
interface FunnelResponse {
  ok: boolean;
  // TRA-1834 — per-engine blocks, never a single pooled row. Empty list = fleet never_ran.
  demo: EquityEntryFunnelBlock[];
  live: EquityEntryFunnelBlock[];
  intradayChurnersDisabled: string[];
  symbolReadRule: string;
  bucketOrderNote: string; // TRA-1835
  symbolNamesNote: string; // TRA-1835
}

/** TRA-1834 — a stable engineId for these direct-call route tests (one engine per test). */
const FE = 'engine-route-test';

function funnelBody(): FunnelResponse {
  const { app, routes } = fakeApp();
  registerLiveHealthRoutes(app, {
    requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
    userCtx: async () => ctx('admin', engineState()),
    getSettings: () => settings(),
    now: () => NOW,
  });
  const handlers = routes.get('/api/health/equity-entry-funnel')!;
  const res = fakeRes();
  handlers[0]!({}, res);
  return res.body as FunnelResponse;
}

describe('GET /api/health/equity-entry-funnel (TRA-1768)', () => {
  beforeEach(() => {
    __resetEquityEntryFunnelForTests();
  });

  afterEach(() => {
    __resetEquityEntryFunnelForTests();
  });

  it('serves demo and live SEPARATELY, three-valued, with no pass since boot', () => {
    const body = funnelBody();

    expect(body.ok).toBe(true);
    // No reading ≠ a dry signal side. TRA-1834 — with no engine ticked, each list is EMPTY
    // (fleet-level never_ran): nothing to report, not a zero row.
    expect(body.demo).toEqual([]);
    expect(body.live).toEqual([]);
  });

  it('THE ALARM: a pass that ran and generated nothing serves candidatesEvaluated 0 / no_candidates', () => {
    beginEquityEntryPass('demo', FE, { symbolsConsidered: 21, at: NOW });
    const body = funnelBody();

    expect(body.demo[0].label).toBe('demo-1');
    expect(body.demo[0].lastPass.candidatesEvaluated).toBe(0);
    expect(body.demo[0].funnelStatus).toBe('no_candidates');
    expect(body.demo[0].passGateBlockedReason).toBeNull(); // it RAN — no gate to blame
    expect(body.demo[0].lastPassAt).not.toBeNull();
    // The live book is untouched and must NOT inherit demo's reading.
    expect(body.live).toEqual([]);
  });

  it('a gated pass serves the GATE, not a false zero', () => {
    recordEquityEntryPassGated('demo', FE, 'market_closed', NOW);
    const body = funnelBody();

    expect(body.demo[0].funnelStatus).toBe('gated');
    expect(body.demo[0].passGateBlockedReason).toBe('market_closed');
    expect(body.demo[0].cumulative.candidatesEvaluated).toBeNull(); // NOT 0
    expect(body.demo[0].passCount).toBe(1); // the tick fired; gated ≠ never_ran
  });

  it('a candidate eaten by a guardrail serves the EATER by name', () => {
    beginEquityEntryPass('demo', FE, { symbolsConsidered: 21, at: NOW });
    recordEquityCandidate('demo', FE, 'deterministic');
    recordEquityEntryRejected('demo', FE, 'churn_brake');
    const body = funnelBody();

    expect(body.demo[0].funnelStatus).toBe('all_rejected');
    expect(body.demo[0].cumulative.candidatesEvaluated).toBe(1);
    expect(body.demo[0].cumulative.admitted).toBe(0);
    expect(body.demo[0].cumulative.rejectedByReason).toEqual({ churn_brake: 1 });
    expect(body.demo[0].cumulative.candidatesBySource).toEqual({ deterministic: 1 });
  });

  it('surfaces that swing mode hard-nulls the intraday churners (context for a dry deterministic bucket)', () => {
    const prior = process.env.EQUITY_SWING_MODE;
    process.env.EQUITY_SWING_MODE = 'true';
    try {
      expect(funnelBody().intradayChurnersDisabled).toEqual(['orb', 'bbFade_1h']);
    } finally {
      if (prior === undefined) delete process.env.EQUITY_SWING_MODE;
      else process.env.EQUITY_SWING_MODE = prior;
    }
  });
});

// TRA-1793 — the SYMBOL layer, on the wire.
//
// The unit tests prove the counters are right in memory. These prove they SURVIVE THE
// ROUTE — because the whole point of this ticket is that `symbolsWithData` was correct
// in memory too, and reached nothing but a `log.warn`. A fact that does not reach the
// PAYLOAD does not exist downstream. So: invoke the handler, read the served body, and
// then round-trip it through JSON, because the reader on the other end is `curl`.
describe('GET /api/health/equity-entry-funnel — symbol layer (TRA-1793)', () => {
  beforeEach(() => {
    __resetEquityEntryFunnelForTests();
  });

  afterEach(() => {
    __resetEquityEntryFunnelForTests();
  });

  /** What QuantTrader actually reads: the body as it comes back off the wire. */
  const overTheWire = (): FunnelResponse => JSON.parse(JSON.stringify(funnelBody())) as FunnelResponse;

  it('serves symbolsConsidered / symbolsEvaluated / symbolsSkippedByReason — per-pass AND cumulative', () => {
    beginEquityEntryPass('demo', FE, { symbolsConsidered: 3, at: NOW });
    recordEquitySymbolSkipped('demo', FE, 'stale_feed');
    recordEquitySymbolSkipped('demo', FE, 'stale_feed');
    recordEquitySymbolEvaluated('demo', FE);

    const body = overTheWire();

    expect(body.demo[0].lastPass.symbolsConsidered).toBe(3);
    expect(body.demo[0].lastPass.symbolsEvaluated).toBe(1);
    expect(body.demo[0].lastPass.symbolsSkippedByReason).toEqual({ stale_feed: 2 });
    expect(body.demo[0].cumulative.symbolsConsidered).toBe(3);
    expect(body.demo[0].cumulative.symbolsEvaluated).toBe(1);
    expect(body.demo[0].cumulative.symbolsSkippedByReason).toEqual({ stale_feed: 2 });
    // …and the live book, which swept nothing, is NOT pooled with it.
    expect(body.live).toEqual([]);
  });

  it('THE ALARM on the wire: an iterated pass where every symbol was stale serves symbolsEvaluated 0 next to candidatesEvaluated 0', () => {
    beginEquityEntryPass('demo', FE, { symbolsConsidered: 21, at: NOW });
    for (let i = 0; i < 21; i++) recordEquitySymbolSkipped('demo', FE, 'stale_feed');

    const body = overTheWire();

    // Identical to a dry Ichimoku by TRA-1768's fields alone…
    expect(body.demo[0].funnelStatus).toBe('no_candidates');
    expect(body.demo[0].lastPass.candidatesEvaluated).toBe(0);
    // …and separated from it by exactly one number, which is now on the wire.
    expect(body.demo[0].lastPass.symbolsEvaluated).toBe(0);
    expect(body.demo[0].lastPass.symbolsSkippedByReason).toEqual({ stale_feed: 21 });
    // The rule that tells the reader which of the two it is ships WITH the reading —
    // a read rule that lives only in a ticket is not held by whoever curls the route.
    expect(body.symbolReadRule).toContain('Read symbolsEvaluated BEFORE candidatesEvaluated');
  });

  it('the nulls survive JSON serialization as PRESENT KEYS — an absent key is not a null, it is a void', () => {
    recordEquityEntryPassGated('demo', FE, 'market_closed', NOW);

    const raw = JSON.stringify(funnelBody());
    const body = JSON.parse(raw) as FunnelResponse;

    // `JSON.stringify` drops `undefined` silently. If any of these were ever produced as
    // `undefined` rather than `null`, the key would VANISH from the body and a reader
    // doing `body.demo[0].lastPass.symbolsEvaluated ?? 0` would book a false zero on a GATED
    // pass — the exact bug, re-minted in the field built to kill it. So assert PRESENCE
    // first, and value second.
    for (const key of ['symbolsConsidered', 'symbolsEvaluated', 'symbolsSkippedByReason'] as const) {
      expect(Object.hasOwn(body.demo[0].lastPass, key)).toBe(true);
      expect(Object.hasOwn(body.demo[0].cumulative, key)).toBe(true);
      expect(body.demo[0].lastPass[key]).toBeNull();
      expect(body.demo[0].cumulative[key]).toBeNull();
    }
    expect(body.demo[0].funnelStatus).toBe('gated'); // …and it is a GATE, not a verdict
    expect(raw).toContain('"symbolsEvaluated":null'); // literally, on the wire

    // TRA-1835 — the NAME fields obey the same three-valued discipline: null on a gate,
    // as PRESENT keys, never absent (an absent key reads as a void, not a null).
    expect(Object.hasOwn(body.demo[0].lastPass, 'symbolsSkippedSymbols')).toBe(true);
    expect(body.demo[0].lastPass.symbolsSkippedSymbols).toBeNull();
    expect(Object.hasOwn(body.demo[0].cumulative, 'symbolsSkippedByName')).toBe(true);
    expect(body.demo[0].cumulative.symbolsSkippedByName).toBeNull();
  });

  // TRA-1835 — the whole point of the ticket, served over the wire: a `stale_feed: N` that
  // does not NAME its N reads identically whether the dark names are the tail or the head.
  it('names the dark in-universe symbols on the wire, and flags truncation rather than cutting silently', () => {
    beginEquityEntryPass('demo', FE, { symbolsConsidered: 21, at: NOW });
    // Two curated names dark, one off-universe skip that must be COUNTED but never NAMED.
    recordEquitySymbolSkipped('demo', FE, 'stale_feed', { symbol: 'NVDA', inUniverse: true });
    recordEquitySymbolSkipped('demo', FE, 'stale_feed', { symbol: 'COIN', inUniverse: true });
    recordEquitySymbolSkipped('demo', FE, 'off_swing_universe', { symbol: 'ZZZZ', inUniverse: false });

    const body = overTheWire();

    // The count still closes; the NAMES ride alongside it. off_swing_universe is unnamed.
    expect(body.demo[0].lastPass.symbolsSkippedByReason).toEqual({ stale_feed: 2, off_swing_universe: 1 });
    expect(body.demo[0].lastPass.symbolsSkippedSymbols).toEqual({ stale_feed: ['NVDA', 'COIN'] });
    expect(body.demo[0].lastPass.symbolsSkippedSymbolsTruncated).toBe(false);
    expect(body.demo[0].cumulative.symbolsSkippedByName).toEqual({ stale_feed: { NVDA: 1, COIN: 1 } });
    // The read guidance the ticket asked for ships WITH the reading, not only in the ticket.
    expect(body.bucketOrderNote).toContain('first-match-wins');
    expect(body.symbolNamesNote).toContain('symbolsSkippedSymbols');
  });
});

// TRA-2193 — GET /api/health/rv-scan.
//
// The acceptance criterion is not "the route exists" but "the route can tell an
// outage from a drought", so these assert the SEPARATION, not the shape.
describe('TRA-2193 GET /api/health/rv-scan', () => {
  function mountRvScan(env: Record<string, string | undefined> = {}) {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/rv-scan')!;
    const res = fakeRes();
    handlers[0]!({}, res);
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    return { handlers, body: res.body as Record<string, never> };
  }

  beforeEach(() => {
    __resetRvScanTelemetry();
  });

  it('is unauthenticated, matching the rest of the public /api/health/* posture', () => {
    const { handlers } = mountRvScan();
    expect(handlers).toHaveLength(1);
  });

  it('reports the DISARMED state as its own verdict — silence is correct, not a fault', () => {
    // This is the 2026-07-22 state: the flag was wiped, so the loop never ran.
    // Before this route there was no name for it.
    const { body } = mountRvScan({ ENABLE_OPTION_DEMO_DIRECTIONAL: undefined });
    expect(body.verdict).toBe('disarmed');
    expect(body.enabled).toBe(false);
    // NULL, not 0. A 0 here is a valid epoch and would survive a finite-check on
    // the consumer side while asserting a scan that never happened.
    expect(body.lastScanAt).toBeNull();
    const dir = (body.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'directional')!;
    expect(dir.enabled).toBe(false);
    expect(dir.lastScan).toBeNull();
  });

  it('PROOF OF FIRE: after one real scan the route reports a non-null lastScanAt and non-zero candidatesEvaluated', () => {
    const run = beginRvScan('directional', 3, () => NOW);
    run.enterSymbol(); run.reject('no_trend_confluence');
    run.enterSymbol(); run.pass(); run.opened();
    run.enterSymbol(); run.reject('churn_brake');
    run.fetchOk();
    run.finish();

    const { body } = mountRvScan({ ENABLE_OPTION_DEMO_DIRECTIONAL: '1' });
    expect(body.verdict).toBe('scanning');
    expect(body.enabled).toBe(true);
    expect(body.lastScanAt).toBe(NOW);
    expect(body.scanCountSinceBoot).toBe(1);

    const dir = (body.paths as unknown as Array<Record<string, never>>)
      .find((p) => (p as Record<string, unknown>).path === 'directional')!;
    const last = dir.lastScan as unknown as Record<string, number>;
    expect(last.candidatesEvaluated).toBe(3);
    expect(last.opensPlaced).toBe(1);
    // The invariant, asserted on the wire and not only in the store.
    expect(
      Object.values(last.rejectionsByGate as unknown as Record<string, number>)
        .reduce((a, b) => a + b, 0),
    ).toBe(last.candidatesEvaluated - last.candidatesPassed);
    expect(dir.lastScan!['bucketsBalance']).toBe(true);
    expect((body.dataSource as unknown as Record<string, unknown>).lastFetchOkAt).toBe(NOW);
  });

  it('separates ARMED-BUT-NEVER-RAN from DISARMED — the two an operator must not confuse', () => {
    const armed = mountRvScan({ ENABLE_OPTION_DEMO_DIRECTIONAL: '1' }).body;
    const disarmed = mountRvScan({ ENABLE_OPTION_DEMO_DIRECTIONAL: undefined }).body;

    // Both have zero opens and a null lastScanAt. Only `verdict` tells them apart,
    // and they demand opposite remedies: restore a wiped env var vs. investigate a
    // scanner that is armed and not ticking.
    expect(armed.lastScanAt).toBeNull();
    expect(disarmed.lastScanAt).toBeNull();
    expect(armed.verdict).toBe('armed_but_never_ran');
    expect(disarmed.verdict).toBe('disarmed');
  });

  it('reports the UN-INSTRUMENTED iv-rv path with null counters, never zeros', () => {
    const { body } = mountRvScan();
    const ivrv = (body.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'iv_rv_buy_premium')!;
    expect(ivrv.instrumented).toBe(false);
    // 0 would claim a measurement this iteration does not take.
    expect(ivrv.scanCountSinceBoot).toBeNull();
    expect(ivrv.lastScanAt).toBeNull();
  });

  it('carries the structure-vs-sleeve warning in the PAYLOAD, not only in the ticket', () => {
    const { body } = mountRvScan();
    // TRA-2245 — per-path structure labels: only rv_scan keeps `single_leg_rv`; the
    // directional producers journal `single_leg_directional`. A reader who does not
    // know that grades the wrong population, and a fact that only reaches a ticket
    // does not exist downstream.
    expect(body.structureLabels).toEqual({
      rv_scan: 'single_leg_rv',
      directional: 'single_leg_directional',
      iv_rv_buy_premium: 'single_leg_directional',
    });
    // Each path also carries its own structureLabel inline.
    const paths = body.paths as unknown as Array<Record<string, unknown>>;
    expect(paths.find((p) => p.path === 'directional')!.structureLabel).toBe('single_leg_directional');
    expect(paths.find((p) => p.path === 'rv_scan')!.structureLabel).toBe('single_leg_rv');
    expect(String(body.note)).toContain('entryArchetype');
    expect(String(body.note)).toContain('not a sleeve');
    // All three producer paths are enumerated, so none can go quiet unnoticed.
    expect(paths.length).toBe(3);
  });
});

// TRA-2193 item 3 — fixture-vs-desk partition on the option-journal summary.
//
// Reproduces the 2026-07-22 session exactly: one real desk trade plus the SAME
// SMCI trail exit mirrored into three QA fixture books. The mirrored rows carry
// DISTINCT ids, so id-dedupe finds nothing and the pooled number reads as clean.
describe('TRA-2193 option-journal fixture-vs-desk partition', () => {
  function row(
    id: string,
    account: string | undefined,
    pnl: number,
    r: number,
  ): OptionTradeJournalRecord {
    return {
      id,
      openTs: NOW - 3_600_000,
      symbol: 'SMCI',
      structure: 'single_leg_otm',
      mode: 'demo',
      ivRank: null,
      trend: 'up',
      sentiment: null,
      entryDelta: 0.5,
      entryDte: 20,
      atRiskUsd: 181.9999999999999,
      agentConviction: null,
      outcome: 'WIN',
      closeTs: NOW,
      realizedPnlUsd: pnl,
      realizedR: r,
      exitReason: 'trail',
      holdDays: 1,
      ...(account === undefined ? {} : { account }),
    } as OptionTradeJournalRecord;
  }

  // Bit-identical economics, three different fixture books, three different ids.
  const mirrored = [
    row('m1', 'qa_mirror_1578_38096', 1600, 8.791),
    row('m2', 'qa_tra1475_1783821169', 1600, 8.791),
    row('m3', 'qa_reg_0710202220', 1600, 8.791),
  ];
  const desk = row('d1', 'admin', 119.5, 0.1079);
  const legacy = row('old1', undefined, 50, 0.25); // pre-TRA-1475, no `account`

  it('separates the 41x fixture inflation the pooled summary hides', () => {
    const report = buildOptionJournalReport([...mirrored, desk], NOW, true);

    // The pooled number — unchanged, still wrong to grade on, and still published
    // so no existing consumer's number moves under it (TRA-2079).
    expect(report.summary.realizedPnlUsd).toBe(4919.5);

    // The number that is actually true of the desk.
    expect(report.summary.byAccountClass.desk.realizedPnlUsd).toBe(119.5);
    expect(report.summary.byAccountClass.desk.closed).toBe(1);
    expect(report.summary.byAccountClass.fixture.realizedPnlUsd).toBe(4800);
    expect(report.summary.byAccountClass.fixture.closed).toBe(3);

    // ~41x on realized $, which is the whole reason this partition exists.
    expect(
      report.summary.realizedPnlUsd / report.summary.byAccountClass.desk.realizedPnlUsd,
    ).toBeGreaterThan(40);

    expect(report.fixtureRowCount).toBe(3);
    expect(report.deskRowCount).toBe(1);
  });

  it('id-dedupe CANNOT find these — the ids are distinct; only `account` separates them', () => {
    // Stated as a test because it is the trap: a consumer that de-duplicates on
    // `id` gets 0 duplicates back and concludes the pool is clean.
    const ids = new Set(mirrored.map((m) => m.id));
    expect(ids.size).toBe(3);
    const economics = new Set(mirrored.map((m) => `${m.realizedPnlUsd}:${m.realizedR}`));
    expect(economics.size).toBe(1);
  });

  it('rows with NO account are `unattributed`, never folded into desk', () => {
    const report = buildOptionJournalReport([desk, legacy], NOW, true);

    // Folding pre-TRA-1475 rows into `desk` would re-commit the pooling bug for
    // exactly the historical rows a long-window grade leans on hardest.
    expect(report.unattributedRowCount).toBe(1);
    expect(report.deskRowCount).toBe(1);
    expect(report.summary.byAccountClass.desk.realizedPnlUsd).toBe(119.5);
    expect(report.summary.byAccountClass.unattributed.realizedPnlUsd).toBe(50);
  });

  it('the three classes SUM to the row count — a partition that is not a partition is a new bug', () => {
    const rows = [...mirrored, desk, legacy];
    const report = buildOptionJournalReport(rows, NOW, true);

    expect(report.fixtureRowCount + report.deskRowCount + report.unattributedRowCount)
      .toBe(rows.length);
    expect(report.summary.accountClassCountsSumToRows).toBe(true);
  });

  it('respects the sinceTs cohort filter — the partition folds the SAME rows as the summary', () => {
    const old = { ...desk, id: 'old-desk', openTs: NOW - 90_000_000 };
    const report = buildOptionJournalReport(
      [old, desk, ...mirrored],
      NOW,
      true,
      undefined,
      NOW - 7_200_000,
    );
    // `old` is outside the cohort, so it must be absent from BOTH folds. Summary
    // and partition describing different populations in one 200 is the TRA-2082
    // false-PASS shape.
    expect(report.deskRowCount).toBe(1);
    expect(report.summary.closed).toBe(4);
    expect(report.summary.accountClassCountsSumToRows).toBe(true);
  });

  it('names the desk field to grade on, in the payload rather than only in the ticket', () => {
    const report = buildOptionJournalReport([desk], NOW, true);
    expect(report.summary.accountClassNote).toContain('byAccountClass.desk');
    expect(report.summary.accountClassNote).toContain('id-dedupe');
  });
});

// TRA-2193 item 4 — enumerate open positions.
//
// `summary.open` reported a count (37 on bqb1) that no `rows` mode could expand,
// so unrealized MTM was unobservable and the mid-vs-bid mark parity work on
// TRA-2174 / TRA-2131 had nothing to reconcile against.
describe('TRA-2193 option-journal rows=open / rows=all', () => {
  const base = {
    openTs: NOW - 3_600_000,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 20,
    atRiskUsd: 100,
    agentConviction: null,
  };
  const openDemo = { ...base, id: 'o1', mode: 'demo', outcome: 'OPEN' } as OptionTradeJournalRecord;
  const openLive = { ...base, id: 'o2', mode: 'live', outcome: 'OPEN' } as OptionTradeJournalRecord;
  const closedDemo = {
    ...base, id: 'c1', mode: 'demo', outcome: 'WIN',
    closeTs: NOW, realizedPnlUsd: 10, realizedR: 0.5, exitReason: 'trail', holdDays: 1,
  } as OptionTradeJournalRecord;
  const all = [openDemo, openLive, closedDemo];

  it('rows=open enumerates exactly what summary.open counts', () => {
    const report = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'open');
    expect(report.rowsMode).toBe('open');
    // The count and the enumeration must agree, or one of them is lying.
    expect(report.rows).toHaveLength(report.summary.open);
    expect(report.rows?.map((r) => r.id).sort()).toEqual(['o1', 'o2']);
  });

  it('rows=all returns both modes and both outcomes', () => {
    const report = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'all');
    expect(report.rowsMode).toBe('all');
    expect(report.rows).toHaveLength(3);
  });

  it('rows=demo is byte-for-byte unchanged — demo AND resolved only', () => {
    const viaString = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'demo');
    const viaLegacyBool = buildOptionJournalReport(all, NOW, true, undefined, undefined, true);
    expect(viaString.rows?.map((r) => r.id)).toEqual(['c1']);
    // The old boolean call signature still means `demo`, so no existing caller moves.
    expect(viaLegacyBool.rows).toEqual(viaString.rows);
    expect(viaLegacyBool.rowsMode).toBe('demo');
  });

  it('an UNKNOWN rows value yields an empty dump and a NULL mode, not a silent demo fallback', () => {
    const report = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'unknown');
    // Serving a different population than the one asked for, under a 200, is the
    // exact failure shape TRA-2082 closed. `rowsMode: null` says "I did not
    // recognise that" instead of quietly answering a different question.
    expect(report.rowsMode).toBeNull();
    expect(report.rows).toEqual([]);
  });

  it('states that journal rows carry NO marks, so a missing P&L is not a zero', () => {
    const report = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'open');
    // Enumeration answers WHICH contracts are open; it cannot price them. Unrealized
    // MTM still needs a mark source (TRA-2174 / TRA-2131).
    expect(report.rowsCarryMarks).toBe(false);
  });

  it('omits the rows fields entirely when no dump was requested', () => {
    const report = buildOptionJournalReport(all, NOW, true);
    expect(report.rows).toBeUndefined();
    expect(report.rowsMode).toBeUndefined();
  });

  it('rows=open still honours the sinceTs cohort filter', () => {
    const stale = { ...openDemo, id: 'o0', openTs: NOW - 90_000_000 };
    const report = buildOptionJournalReport(
      [stale, ...all], NOW, true, undefined, NOW - 7_200_000, 'open',
    );
    expect(report.rows?.map((r) => r.id).sort()).toEqual(['o1', 'o2']);
    expect(report.rowsFiltered).toBe(true);
  });
});

// TRA-2220 (parent TRA-2195 → TRA-2193) — the give-back arm-floor route could not report
// its OWN blindness. `recordGiveBackState` is called from inside the
// `EXIT_RISK_RULES_ENABLED` master gate, so the master going down does not zero the
// counters — it FREEZES them, and a frozen `giveback_halt_sub_floor: 0` is byte-identical
// to "22 sessions observed, none breached the floor". bqb1 served exactly that, with
// `ok: true`, across 2026-07-22 and 07-23 while TRA-1592's recorded reopen tripwire
// ("giveback_halt_sub_floor > 0") sat structurally unable to fire.
//
// These pin the HTTP surface, not just the fold: what a grader actually curls.
describe('TRA-2220 giveback-arm-floor route — darkness is a first-class verdict', () => {
  // 2026-07-24T00:55Z = Thu 2026-07-23 20:55 ET, after the cash close. The exact wall
  // clock of the live observation in the ticket.
  const GB_NOW = Date.UTC(2026, 6, 24, 0, 55);

  /** Serve the route with the clock pinned to the observation, and return the body. */
  function readRoute(): Record<string, unknown> {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => GB_NOW,
    });
    const handlers = routes.get('/api/health/giveback-arm-floor')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    return res.body as Record<string, unknown>;
  }

  /** The live bqb1 shape: a clean run through Tue 07-21, then two empty trading days. */
  beforeEach(() => {
    clearGiveBackArmFloorLedger();
    delete process.env.EXIT_RISK_RULES_ENABLED;
    const s = {
      peakPnl: 100,
      currentPnl: 90,
      retainedFloor: 60,
      giveBackArmFloor: 25,
      giveBackCapPct: 0.4,
      armFloorCleared: true,
      haltLatched: false,
      haltReason: null,
    } as const;
    recordGiveBackState('demo', 'engine-1', '2026-07-20', s, 1_001);
    recordGiveBackState('demo', 'engine-1', '2026-07-21', s, 1_002);
  });

  afterEach(() => {
    clearGiveBackArmFloorLedger();
    delete process.env.EXIT_RISK_RULES_ENABLED;
  });

  it('reports ok:FALSE and a null tripwire while the recorder is dark', () => {
    const body = readRoute(); // no EXIT_RISK_RULES_ENABLED in the env ⇒ the writer is gated off
    expect(body.ok).toBe(false); // was unconditionally `true` — the bug
    const rec = body.recorder as Record<string, unknown>;
    expect(rec.state).toBe('dark');
    expect(rec.armed).toBe(false);
    expect(rec.lastRecordedSessionDate).toBe('2026-07-21');
    expect(rec.missingTradingDays).toEqual(['2026-07-22', '2026-07-23']);

    // `0` is never "not measured" (TRA-1707). The raw count survives alongside it, so
    // the nulling costs no information — only the authority to read it as a measurement.
    expect(body.invalidations).toBeNull();
    expect((body.verdictCounts as Record<string, unknown>).giveback_halt_sub_floor).toBeNull();
    expect(body.invalidationsRecorded).toBe(0);
    expect(body.verdictCountsTotal).toBe(2);
    expect(String(body.note)).toContain('DARK');
  });

  it('THE DISCRIMINATOR — dark and armed readouts of the SAME rows differ', () => {
    const dark = readRoute();
    process.env.EXIT_RISK_RULES_ENABLED = '1';
    const armed = readRoute();

    // Identical underlying fold...
    expect(armed.sessionsObserved).toBe(dark.sessionsObserved);
    expect(armed.sessions).toEqual(dark.sessions);
    // ...and yet a grader can tell them apart. If these ever serialize the same, the
    // route is blind again and this test is the thing that says so.
    expect(JSON.stringify(armed)).not.toBe(JSON.stringify(dark));
    expect((armed.recorder as Record<string, unknown>).state).toBe('armed_but_stale');
    expect(armed.invalidations).toBe(0); // a real measurement now, not a frozen artifact
    expect(dark.invalidations).toBeNull();
  });

  it('stays ok:FALSE when armed but frozen — a ceiling-only check would pass here', () => {
    process.env.EXIT_RISK_RULES_ENABLED = '1';
    const body = readRoute();
    // `invalidations <= 0` holds, every bucket looks healthy, n is unchanged... and the
    // recorder has written nothing for two completed trading days. THAT is the signal.
    expect(body.invalidations).toBe(0);
    expect(body.ok).toBe(false);
    expect((body.recorder as Record<string, unknown>).staleTradingDays).toBe(2);
    expect(String(body.note)).toContain('STALE');
  });
});

describe('TRA-2269 — the exit-cadence grade is scoped to its subject (rollUpExitCadence)', () => {
  /**
   * `bucketExitInterval(29_999) === 'lt30s'` and `bucketExitInterval(30_000) === 'lt60s'`
   * — the 30s bar sits on a bucket EDGE, so `lt60s` is the first bucket AT the bar.
   */
  function exitHistogram(under30s: number, atOrAbove30s: number): Record<ExitIntervalBucket, number> {
    const h = emptyExitIntervalHistogram();
    h.lt15s = under30s;
    h.lt60s = atOrAbove30s;
    return h;
  }

  function exitEngine(o: {
    engine?: string;
    timerArmed?: boolean;
    lifetime: { under: number; over: number };
    rth: { under: number; over: number };
    rthDecoupled?: number;
    rthTick?: number;
    boundaryIntervals?: number;
    closedIntervals?: number;
  }): ExitCadenceHealth {
    return {
      enabled: true,
      timerArmed: o.timerArmed ?? true,
      intervalMs: 10_000,
      minGapMs: 3_000,
      mode: 'demo',
      engine: o.engine ?? 'admin',
      lastExitPassAt: NOW,
      exitPassCount: o.lifetime.under + o.lifetime.over + 1,
      lastExitIntervalMs: 10_000,
      maxExitIntervalMs: 30_001,
      intervalHistogram: exitHistogram(o.lifetime.under, o.lifetime.over),
      decoupledExitSkippedStalePrices: 0,
      decoupledPassCount: o.rthDecoupled ?? 1,
      tickPassCount: o.rthTick ?? 0,
      decoupledSkips: emptyDecoupledExitSkips(),
      decoupledFireCount: 0,
      tickExitRegionMs: { lastMs: null, maxMs: null, samples: 0, atOrAbove20s: 0, atOrAbove30s: 0 },
      rth: {
        intervalHistogram: exitHistogram(o.rth.under, o.rth.over),
        decoupledPassCount: o.rthDecoupled ?? 1,
        tickPassCount: o.rthTick ?? 0,
        boundaryIntervals: o.boundaryIntervals ?? 0,
        closedIntervals: o.closedIntervals ?? 0,
      },
    };
  }

  // The exact scenario from the TRA-2269 filing, in the ticket's own numbers: a
  // PERFECT 6.5h RTH (6.5h / 10s x 10 engines = 23,400 intervals, NONE at or
  // above the bar) plus 22 minutes of closed-market uptime accruing at the
  // rates measured post-close on 2026-07-24 (0.3216 intervals/s, of which
  // 0.1833/s land at or above 30s) => 425 intervals, 242 of them over the bar.
  const PERFECT_RTH_INTERVALS = 23_400;
  const CONTAMINATION_SAMPLES = 425;
  const CONTAMINATION_OVER = 242;
  const contaminatedFleet = () => [exitEngine({
    lifetime: {
      under: PERFECT_RTH_INTERVALS + (CONTAMINATION_SAMPLES - CONTAMINATION_OVER),
      over: CONTAMINATION_OVER,
    },
    rth: { under: PERFECT_RTH_INTERVALS, over: 0 },
    rthDecoupled: 23_000,
    rthTick: 400,
    closedIntervals: CONTAMINATION_SAMPLES,
  })];

  it('REPRODUCES THE BUG, THEN KILLS IT: 22 min of closed-market uptime forces the LIFETIME ratio FALSE on a PERFECT RTH — and the graded ratio is TRUE', () => {
    const body = rollUpExitCadence(contaminatedFleet());

    // The old, lifetime-scoped number — the one this route used to publish
    // under the name `p99Under30s`. 242 / 23,825 = 1.016% >= 1% => a confident
    // RED on a session in which the hoist did not miss a single interval.
    const lifetime = body.lifetime as Record<string, unknown>;
    expect(lifetime.samples).toBe(23_825);
    expect(lifetime.atOrAbove30s).toBe(CONTAMINATION_OVER);
    expect(lifetime.p99Under30s).toBe(false);

    // The graded number, scoped to the window it is a statement about.
    expect(body.samples).toBe(PERFECT_RTH_INTERVALS);
    expect(body.atOrAbove30s).toBe(0);
    expect(body.p99Under30s).toBe(true);
    expect(body.verdict).toBe('bounded');
    expect(body.gradeable).toBe(true);
    expect(body.notGradeableReason).toBeNull();
  });

  it('PARTITIONS rather than filters — every lifetime interval is still accounted for', () => {
    const body = rollUpExitCadence(contaminatedFleet());
    const lifetime = body.lifetime as Record<string, unknown>;
    expect(body.rthClosedIntervals).toBe(CONTAMINATION_SAMPLES);
    expect(body.rthBoundaryIntervals).toBe(0);
    expect(lifetime.samples).toBe(
      (body.samples as number) + (body.rthBoundaryIntervals as number) + (body.rthClosedIntervals as number),
    );
    expect(body.partitionHolds).toBe(true);
  });

  it('POSITIVE CONTROL — it can still emit a RED. A genuinely bad RTH window grades over_bar, gradeable', () => {
    // Without this the fix would be a whitewash: an instrument that can only
    // ever say PASS is not an instrument. 300 / 23,400 = 1.28% >= 1%, and
    // every one of those intervals has BOTH endpoints inside RTH.
    const body = rollUpExitCadence([exitEngine({
      lifetime: { under: PERFECT_RTH_INTERVALS - 300, over: 300 },
      rth: { under: PERFECT_RTH_INTERVALS - 300, over: 300 },
      rthDecoupled: 23_000,
      rthTick: 400,
    })]);
    expect(body.p99Under30s).toBe(false);
    expect(body.verdict).toBe('over_bar');
    expect(body.gradeable).toBe(true);
    expect(body.notGradeableReason).toBeNull();
  });

  it('REFUSES the pure post-close read — the live 2026-07-24 state — and names the lifetime count it declined to grade', () => {
    // 293 samples, 167 at or above the bar, ZERO with both endpoints in RTH.
    // The pre-TRA-2269 route published 57% over the bar as a graded ratio.
    const body = rollUpExitCadence([exitEngine({
      lifetime: { under: 126, over: 167 },
      rth: { under: 0, over: 0 },
      rthDecoupled: 0,
      rthTick: 0,
      closedIntervals: 293,
    })]);
    expect(body.samples).toBe(0);
    expect(body.p99Under30s).toBeNull();
    expect(body.verdict).toBe('armed_but_no_rth_interval');
    expect(body.gradeable).toBe(false);
    expect(String(body.notGradeableReason)).toContain('293');
    // And the lifetime figure is still published — it is a real fact about the
    // exit path, just not a verdict on the hoist.
    expect((body.lifetime as Record<string, unknown>).p99Under30s).toBe(false);
  });

  it('keeps armed_but_no_interval_measured for the genuinely empty case — "nothing measured" and "nothing IN WINDOW" are different facts', () => {
    const body = rollUpExitCadence([exitEngine({
      lifetime: { under: 0, over: 0 },
      rth: { under: 0, over: 0 },
      rthDecoupled: 0,
    })]);
    expect(body.verdict).toBe('armed_but_no_interval_measured');
    expect(body.gradeable).toBe(false);
    expect(String(body.notGradeableReason)).toBe('no exit interval measured yet');
  });

  it('DENOMINATOR PURITY: RTH intervals that doTick closed do not grade the hoist', () => {
    // TRA-2257 gated on "did the subject run at all" — one decoupled pass
    // anywhere flipped `gradeable` true. Here the timer ran 100 times and
    // doTick closed 900 of the 1,000 graded intervals: nominally in-window,
    // but the cadence on show is doTick's.
    const body = rollUpExitCadence([exitEngine({
      lifetime: { under: 1_000, over: 0 },
      rth: { under: 1_000, over: 0 },
      rthDecoupled: 100,
      rthTick: 900,
    })]);
    expect(body.rthDecoupledShare).toBeCloseTo(0.1, 10);
    expect(body.verdict).toBe('tick_dominated_window');
    expect(body.gradeable).toBe(false);
    expect(String(body.notGradeableReason)).toContain('100/1000');
    // ...and it does NOT trip on a healthy armed session, where the 10s timer
    // outruns doTick's 120-280s wall-clock by an order of magnitude.
    const healthy = rollUpExitCadence(contaminatedFleet());
    expect(healthy.rthDecoupledShare as number).toBeGreaterThan(RTH_DECOUPLED_SHARE_FLOOR);
    expect(healthy.gradeable).toBe(true);
  });

  it('disarmed still outranks everything — a fleet with no timer grades nothing', () => {
    const body = rollUpExitCadence([exitEngine({
      timerArmed: false,
      lifetime: { under: 1_000, over: 0 },
      rth: { under: 1_000, over: 0 },
      rthDecoupled: 900,
    })]);
    expect(body.verdict).toBe('disarmed');
    expect(body.gradeable).toBe(false);
    expect(body.enabled).toBe(false);
  });

  it('sums the RTH histogram across engines — one sick engine is not averaged away', () => {
    const body = rollUpExitCadence([
      exitEngine({ engine: 'a', lifetime: { under: 500, over: 0 }, rth: { under: 500, over: 0 }, rthDecoupled: 500 }),
      exitEngine({ engine: 'b', lifetime: { under: 480, over: 20 }, rth: { under: 480, over: 20 }, rthDecoupled: 500 }),
    ]);
    expect(body.samples).toBe(1_000);
    expect(body.atOrAbove30s).toBe(20);
    // 20 / 1,000 = 2% — the healthy engine does not rescue the sick one.
    expect(body.p99Under30s).toBe(false);
    expect(body.verdict).toBe('over_bar');
  });

  it('publishes `window: "rth"` so a reader can FAIL CLOSED on a pre-TRA-2269 build', () => {
    // The route is unauthenticated and read by scripts that cannot see which
    // bytes answered them. Absence of this marker means the `p99Under30s` in
    // hand is the contaminated lifetime ratio.
    const body = rollUpExitCadence(contaminatedFleet());
    expect(body.window).toBe('rth');
    expect(String(body.note)).toContain('window');
  });

  it('the mounted route carries the graded fields and the marker through to the payload', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
      exitCadence: () => contaminatedFleet(),
    });
    const handlers = routes.get('/api/health/exit-cadence')!;
    expect(handlers).toHaveLength(1);  // unauthenticated, like the rest of /api/health/*
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.window).toBe('rth');
    expect(body.p99Under30s).toBe(true);
    expect((body.lifetime as Record<string, unknown>).p99Under30s).toBe(false);
    expect((body.engines as unknown[]).length).toBe(1);
  });
});
