// TRA-528 — live reliability + observability HTTP surface + monitor hook.
//
// The route handlers and the background stale-state probe live here, behind a
// dependency-injected `LiveHealthDeps`, rather than inline in `index.ts`. That
// keeps the wiring in `index.ts` to a single `registerLiveHealthRoutes(...)`
// call + one line in the monitor, and lets the whole surface be unit-tested
// with a fake express app and fake user contexts — no live server required.

import type { Express, Response, RequestHandler } from 'express';
import { findMissingLiveCredentials, type AccountSettings } from '@trading-app/shared';
import type { EngineState, LiveEquityAcceptance } from '../signal-engine.js';
import { resolveBuildInfo } from './build-info.js';
import { summarizeLiveHealth, summarizeFeed } from './live-health.js';
import { checkStaleState } from './alerts.js';

/** Minimal shape this module needs from a per-user context. */
export interface HealthEngineLike {
  getState(): EngineState;
}
export interface HealthUserContext {
  username: string;
  engine: HealthEngineLike;
}

export interface LiveHealthDeps {
  requireAuth: RequestHandler;
  /** Resolve the authenticated request's user context (mirror of index.ts). */
  userCtx: (res: Response) => Promise<HealthUserContext>;
  /** Cache-first settings read for a username. */
  getSettings: (username: string) => AccountSettings;
  /**
   * TRA-580 — enumerate the redacted live-equity acceptance snapshot for
   * every engine in the fleet (one per `getAllUserContexts()`), backing the
   * unauthenticated `GET /api/health/live-equity` probe. Optional so the
   * existing callers (and tests) that only register `version` + `live` keep
   * working; the route is only mounted when this is provided.
   */
  liveEquityAcceptance?: () => LiveEquityAcceptance[];
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/** Shape returned by `GET /api/health/live-equity` — fully redacted. */
export interface LiveEquityAcceptanceReport {
  ok: true;
  time: string;
  build: ReturnType<typeof resolveBuildInfo>;
  /** Engines enumerated this read. */
  engineCount: number;
  /** Engines whose active mode is `live`. */
  liveEngineCount: number;
  /** Engines configured against Tradier `production`. */
  productionEngineCount: number;
  /** Any engine has a live Tradier equity client wired. */
  liveEquityClientConfigured: boolean;
  /** Any engine opted into live equity mirroring. */
  liveEquityTradingEnabled: boolean;
  /**
   * The headline acceptance bit: at least one engine has mirrored a live
   * equity bracket with BOTH OCO legs AND a captured Tradier order id.
   */
  firstLiveEquityFillConfirmed: boolean;
  /** Fleet-summed acceptance counters (TRA-580 lines 1-4). */
  totals: {
    liveSignals: number;
    liveEquityPositions: number;
    liveEquityBracketsWithBothLegs: number;
    liveEquityMirrorsWithOrderId: number;
    liveSkipReasons: number;
  };
  /** Most recent live-equity mirror open across the fleet (ISO), or null. */
  lastLiveEquityFillAt: string | null;
}

/**
 * TRA-580 — fold per-engine acceptance snapshots into the fleet-wide redacted
 * report served at `GET /api/health/live-equity`. Pure (no I/O beyond the
 * injected clock + build info) so it is unit-testable without a server.
 */
export function aggregateLiveEquityAcceptance(
  snapshots: LiveEquityAcceptance[],
  now: number,
): LiveEquityAcceptanceReport {
  const sum = (pick: (s: LiveEquityAcceptance) => number): number =>
    snapshots.reduce((acc, s) => acc + pick(s), 0);
  let lastFillMs = 0;
  for (const s of snapshots) {
    if (!s.lastLiveEquityFillAt) continue;
    const ms = Date.parse(s.lastLiveEquityFillAt);
    if (Number.isFinite(ms) && ms > lastFillMs) lastFillMs = ms;
  }
  return {
    ok: true,
    time: new Date(now).toISOString(),
    build: resolveBuildInfo(),
    engineCount: snapshots.length,
    liveEngineCount: snapshots.filter(s => s.mode === 'live').length,
    productionEngineCount: snapshots.filter(s => s.tradierEnv === 'production').length,
    liveEquityClientConfigured: snapshots.some(s => s.liveEquityClientConfigured),
    liveEquityTradingEnabled: snapshots.some(s => s.liveEquityTradingEnabled),
    firstLiveEquityFillConfirmed: snapshots.some(s => s.firstLiveEquityFillConfirmed),
    totals: {
      liveSignals: sum(s => s.liveSignalCount),
      liveEquityPositions: sum(s => s.liveEquityPositionCount),
      liveEquityBracketsWithBothLegs: sum(s => s.liveEquityBracketsWithBothLegs),
      liveEquityMirrorsWithOrderId: sum(s => s.liveEquityMirrorsWithOrderId),
      liveSkipReasons: sum(s => s.liveSkipReasonCount),
    },
    lastLiveEquityFillAt: lastFillMs > 0 ? new Date(lastFillMs).toISOString() : null,
  };
}

/** Build the consolidated live-health summary for one user context. */
function summarizeForContext(
  ctx: HealthUserContext,
  settings: AccountSettings,
  now: number,
): ReturnType<typeof summarizeLiveHealth> {
  const state = ctx.engine.getState();
  return summarizeLiveHealth({
    mode: settings.mode,
    tradierEnv: settings.liveTradierEnvOptions ?? 'sandbox',
    missingCredentials: findMissingLiveCredentials(settings),
    autoTradingEnabled: state.autoTradingEnabled,
    tradingHalted: state.tradingHalted,
    haltReason: state.haltReason,
    marketOpen: state.marketOpen,
    symbols: state.symbols,
    lastTick: state.lastTick,
    now,
  });
}

/**
 * Mount the TRA-528 health endpoints:
 *
 *  - `GET /api/health/version` — deploy-version pinning. Unauthenticated and
 *    lightweight so an operator or an uptime probe can confirm WHICH commit the
 *    running process is on without logging in. Build info carries no secrets.
 *  - `GET /api/health/live` — consolidated GREEN/YELLOW/RED reliability verdict
 *    for the authenticated user's engine (mode, broker auth gaps, feed
 *    freshness, halt/kill-switch, build). Auth-gated: it names which broker
 *    credentials are missing.
 *  - `GET /api/health/live-equity` — TRA-580 redacted acceptance probe.
 *    Unauthenticated and read-only (parity with `/api/health/version`):
 *    returns ONLY booleans / counts / timestamps proving the first organic
 *    production Tradier equity OTOCO bracket fired with TP+SL legs and
 *    mirrored as `mode:live`, plus the broker-reject skip count. Carries no
 *    symbol, qty, price, order id, account id, or balance. Mounted only when
 *    `deps.liveEquityAcceptance` is provided.
 */
export function registerLiveHealthRoutes(app: Express, deps: LiveHealthDeps): void {
  const now = deps.now ?? Date.now;

  app.get('/api/health/version', (_req, res) => {
    res.json(resolveBuildInfo());
  });

  app.get('/api/health/live', deps.requireAuth, async (_req, res) => {
    const ctx = await deps.userCtx(res);
    if (res.headersSent) return;
    const settings = deps.getSettings(ctx.username);
    const summary = summarizeForContext(ctx, settings, now());
    res.json({ ...summary, build: resolveBuildInfo(), time: new Date(now()).toISOString() });
  });

  const liveEquityAcceptance = deps.liveEquityAcceptance;
  if (liveEquityAcceptance) {
    app.get('/api/health/live-equity', (_req, res) => {
      res.json(aggregateLiveEquityAcceptance(liveEquityAcceptance(), now()));
    });
  }
}

/**
 * Background stale-state probe — call from the 60s observability monitor.
 *
 * Walks the live user contexts and raises the `stale-state` alert if any engine
 * has gone quote-stale while the market is open. The alert key is globally
 * throttled, so one stale engine fires one alert per window even across many
 * contexts; we stop at the first firing to avoid redundant work.
 */
export function runStaleStateCheck(
  contexts: HealthUserContext[],
  getSettings: (username: string) => AccountSettings,
  now: number,
): boolean {
  for (const ctx of contexts) {
    const state = ctx.engine.getState();
    const feed = summarizeFeed(state.symbols, now, undefined, state.lastTick);
    const settings = getSettings(ctx.username);
    const fired = checkStaleState({
      marketOpen: state.marketOpen,
      trackedSymbols: feed.trackedSymbols,
      freshSymbols: feed.freshSymbols,
      mode: settings.mode,
      lastTickAgeSec: feed.lastTickAgeSec,
    });
    if (fired) return true;
  }
  return false;
}
