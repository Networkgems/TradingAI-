// TRA-528 — live reliability + observability HTTP surface + monitor hook.
//
// The route handlers and the background stale-state probe live here, behind a
// dependency-injected `LiveHealthDeps`, rather than inline in `index.ts`. That
// keeps the wiring in `index.ts` to a single `registerLiveHealthRoutes(...)`
// call + one line in the monitor, and lets the whole surface be unit-tested
// with a fake express app and fake user contexts — no live server required.

import type { Express, Response, RequestHandler } from 'express';
import { findMissingLiveCredentials, type AccountSettings } from '@trading-app/shared';
import type { EngineState } from '../signal-engine.js';
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
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
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
