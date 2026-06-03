// TRA-528 — health route registrar + stale-state monitor tests.
//
// Exercises the HTTP surface with a fake express app and fake user contexts so
// the wiring is verified without booting the real server.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerLiveHealthRoutes,
  runStaleStateCheck,
  type HealthUserContext,
} from './health-routes.js';
import { checkStaleState } from './alerts.js';
import { getRecentAlerts, __resetAlertsForTest } from './alerts.js';
import type { EngineState } from '../signal-engine.js';
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
