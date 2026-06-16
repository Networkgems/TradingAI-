// TRA-528 — live reliability + observability HTTP surface + monitor hook.
//
// The route handlers and the background stale-state probe live here, behind a
// dependency-injected `LiveHealthDeps`, rather than inline in `index.ts`. That
// keeps the wiring in `index.ts` to a single `registerLiveHealthRoutes(...)`
// call + one line in the monitor, and lets the whole surface be unit-tested
// with a fake express app and fake user contexts — no live server required.

import { timingSafeEqual } from 'node:crypto';
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
  /**
   * TRA-901 — the shared secret that grants the unattended TRA-898 daily-watch
   * routine access to the auth-gated `/api/health/demo-book` surface without a
   * (short-lived, per-user, expiring) login JWT. Resolved per-call so it tracks
   * env rotation. Returns undefined/empty to disable internal access entirely
   * (the route then behaves exactly as before — user-JWT only). The watch sends
   * it as the `x-internal-token` request header.
   */
  internalToken?: () => string | undefined;
  /**
   * TRA-901 — enumerate every demo-mode engine's paper book for the internal
   * (token-gated) demo-book read. Unlike the user-JWT path (which is scoped to
   * the caller's own engine via `userCtx`), the watch routine has no engine of
   * its own, so internal access returns the fleet's demo books keyed by user.
   * Only mounted behind a valid internal token, so it never widens the
   * unauthenticated surface.
   */
  demoBooks?: () => Array<{ username: string; state: EngineState; mode: string }>;
  /**
   * TRA-895 — inputs for the UNAUTHENTICATED `GET /api/health/options-pipeline`
   * probe. The 3-day demo test repeatedly reported "no option signals"; the
   * gates that decide whether the RV options scanner can fire (and whether any
   * option signal is on the board) were only visible behind a per-user login or
   * the (often-unset) internal demo-book token, so the failure mode was
   * undiagnosable from outside. This exposes ONLY booleans / counts / timestamps
   * — no balances, symbols, theses, order ids, or PII — so it can back an
   * unauthenticated probe (parity with `/api/health/version` + `/live-equity`).
   * `engines` enumerates the demo-mode fleet. Only mounted when provided.
   */
  optionsPipeline?: () => {
    rvScannerConfigured: boolean;
    rvBreakerOpen: boolean;
    engines: Array<{ state: EngineState; mode: string }>;
  };
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
  /**
   * TRA-715 — fully-redacted view of the SERVICE-level env that gates durable
   * live-equity boot-arming. Booleans ONLY (presence, never values), so the
   * board/ops can confirm — without Render dashboard access — that (a) the
   * `TRADIER_API_TOKEN`/`TRADIER_ACCOUNT_ID` service creds the boot-arm cred
   * fallback needs are actually set, and (b) the `LIVE_EQUITY_BOOT_USER` pin
   * (TRA-713) has been applied to the running container via a Blueprint sync.
   * When `bootArmPinConfigured` is false on bqb1, the env-pin did NOT sync and
   * durable zero-touch arming cannot self-activate.
   */
  serviceEnv: {
    /** `TRADIER_ENV === 'production'` — the boot-arm requires this. */
    tradierEnvProduction: boolean;
    /** `TRADIER_API_TOKEN` is set (service-level prod equity cred fallback). */
    productionTradierTokenPresent: boolean;
    /** `TRADIER_ACCOUNT_ID` is set (service-level prod equity cred fallback). */
    productionTradierAccountPresent: boolean;
    /** `LIVE_EQUITY_BOOT_USER` is set (TRA-713 env-pin synced to runtime). */
    bootArmPinConfigured: boolean;
  };
}

/**
 * TRA-580 — fold per-engine acceptance snapshots into the fleet-wide redacted
 * report served at `GET /api/health/live-equity`. Pure (no I/O beyond the
 * injected clock + build info) so it is unit-testable without a server.
 */
export function aggregateLiveEquityAcceptance(
  snapshots: LiveEquityAcceptance[],
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): LiveEquityAcceptanceReport {
  const present = (key: string): boolean => (env[key] ?? '').trim().length > 0;
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
    serviceEnv: {
      tradierEnvProduction: (env['TRADIER_ENV'] ?? '').trim() === 'production',
      productionTradierTokenPresent: present('TRADIER_API_TOKEN'),
      productionTradierAccountPresent: present('TRADIER_ACCOUNT_ID'),
      bootArmPinConfigured: present('LIVE_EQUITY_BOOT_USER'),
    },
  };
}

/**
 * TRA-898 — auth-gated demo paper-book summary for the TRA-895 3-day
 * Trade-Agents test daily watch. Unlike the unauthenticated
 * `/api/health/live-equity` probe (which deliberately carries NO balances —
 * just booleans/counts proving the first live fill fired), the daily watch
 * needs the actual demo equity / open positions / realized P&L / agent
 * decision activity for ONE account. That is per-user state and includes
 * balances, so this surface is auth-gated (parity with `/api/health/live`)
 * and reports only the calling user's own demo book — never a fleet sum.
 */
export interface DemoBookReport {
  ok: true;
  time: string;
  build: ReturnType<typeof resolveBuildInfo>;
  /** Account mode at read time. The demo book is only meaningful in `demo`. */
  mode: string;
  /** Trading-agents layer + gating posture (TRA-544 / TRA-796). */
  agents: {
    tradingAgentsEnabled: boolean;
    gatingEnabled: boolean;
    liveGatingEnabled: boolean;
    autoTradingEnabled: boolean;
    tradingHalted: boolean;
    haltReason: string | null;
  };
  /** Demo paper-book equity snapshot. */
  equity: {
    totalEquity: number;
    availableCash: number;
    dailyPnl: number;
  };
  /** Currently-open demo paper positions. */
  openPositionCount: number;
  /**
   * Closed demo positions. `recent` covers the engine's last-20 closed buffer
   * for this mode; `last24h` is the subset closed within 24h of the read.
   * `recentCapped` is true when the 20-row buffer may be hiding older closes.
   */
  closed: {
    recentCount: number;
    recentRealizedPnl: number;
    recentCapped: boolean;
    last24hCount: number;
    last24hRealizedPnl: number;
  };
  /**
   * Latest multi-agent decision batch (open/monitor/close intent proxy):
   * BUY/SELL = open intent, HOLD = monitor/stand-down; `routableCount` is how
   * many carry a `proposedSignal` the gating layer could turn into an order.
   */
  agentActivity: {
    recommendationCount: number;
    byAction: { BUY: number; SELL: number; HOLD: number };
    routableCount: number;
  };
}

/**
 * TRA-898 — fold one engine's `getState()` view into the demo-book report.
 * Pure (clock injected) so it is unit-testable without a server. Reads the
 * mode-masked `getState()`, so it must be called on a demo-mode engine to
 * reflect the paper book.
 */
export function summarizeDemoBook(
  state: EngineState,
  mode: string,
  now: number,
): DemoBookReport {
  const closed = state.closedPositions;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const realized = (p: { pnl?: number }): number => (Number.isFinite(p.pnl) ? (p.pnl as number) : 0);
  const last24h = closed.filter(p => typeof p.closedAt === 'number' && p.closedAt >= dayAgo);
  const recs = state.agentRecommendations;
  const byAction = { BUY: 0, SELL: 0, HOLD: 0 };
  let routableCount = 0;
  for (const r of recs) {
    if (r.action === 'BUY' || r.action === 'SELL' || r.action === 'HOLD') byAction[r.action] += 1;
    if (r.proposedSignal !== null) routableCount += 1;
  }
  return {
    ok: true,
    time: new Date(now).toISOString(),
    build: resolveBuildInfo(),
    mode,
    agents: {
      tradingAgentsEnabled: state.tradingAgentsEnabled,
      gatingEnabled: state.tradingAgentsGatingEnabled,
      liveGatingEnabled: state.tradingAgentsLiveGatingEnabled,
      autoTradingEnabled: state.autoTradingEnabled,
      tradingHalted: state.tradingHalted,
      haltReason: state.haltReason,
    },
    equity: {
      totalEquity: state.account.totalEquity,
      availableCash: state.account.availableCash,
      dailyPnl: state.account.dailyPnl,
    },
    openPositionCount: state.account.openPositions.length,
    closed: {
      recentCount: closed.length,
      recentRealizedPnl: closed.reduce((acc, p) => acc + realized(p), 0),
      // getState() caps the closed buffer at the last 20 for this mode.
      recentCapped: closed.length >= 20,
      last24hCount: last24h.length,
      last24hRealizedPnl: last24h.reduce((acc, p) => acc + realized(p), 0),
    },
    agentActivity: {
      recommendationCount: recs.length,
      byAction,
      routableCount,
    },
  };
}

/**
 * TRA-901 — the internal (token-gated) demo-book read returns EVERY demo-mode
 * engine's book keyed by user, because the unattended watch routine has no
 * engine of its own to scope to. For the TRA-895 3-day test this is normally a
 * single $25k account, but enumerating the fleet keeps it correct if more than
 * one demo trader is live.
 */
export interface DemoBookFleetReport {
  ok: true;
  time: string;
  build: ReturnType<typeof resolveBuildInfo>;
  /** Demo-mode engines enumerated this read. */
  demoEngineCount: number;
  books: Array<{ username: string; book: DemoBookReport }>;
}

/** Fold the fleet's demo-mode engines into one internal demo-book report. */
export function summarizeDemoBooks(
  engines: Array<{ username: string; state: EngineState; mode: string }>,
  now: number,
): DemoBookFleetReport {
  return {
    ok: true,
    time: new Date(now).toISOString(),
    build: resolveBuildInfo(),
    demoEngineCount: engines.length,
    books: engines.map(e => ({ username: e.username, book: summarizeDemoBook(e.state, e.mode, now) })),
  };
}

// ── TRA-895 options-signal pipeline probe ─────────────────────────────────────

/**
 * Per demo-engine view of every gate that determines whether OPTION signals can
 * appear. Options come solely from the relative-value scanner (the agent layer
 * proposes EQUITY trades, not options), so this captures the exact conjunction
 * `shouldRunRelativeValueScan` checks plus what is currently on the board.
 * Secrets-free: booleans + counts only.
 */
export interface OptionsPipelineEngineView {
  mode: string;
  /** Master per-mode auto-trade switch. The RV scan is gated on this — the
   *  "🤖 Trading Agents" toggle alone does NOT arm the options scanner. */
  autoTradingEnabled: boolean;
  tradingAgentsEnabled: boolean;
  gatingEnabled: boolean;
  tradingHalted: boolean;
  haltReason: string | null;
  marketOpen: boolean;
  watchlistSymbolCount: number;
  /** Relative-value (the only options strategy) signals currently on the board. */
  optionSignalCount: number;
  totalSignalCount: number;
  openOptionsCount: number;
  /**
   * True iff every gate the per-tick RV options scan needs is satisfied right
   * now (scanner configured + breaker closed + auto-trade on + not halted +
   * market open). When false, `blockedBy` names the first failing gate so the
   * board can see in one read WHY no option signals are being generated.
   */
  rvScanArmed: boolean;
  blockedBy: string | null;
}

export interface OptionsPipelineReport {
  ok: true;
  time: string;
  build: ReturnType<typeof resolveBuildInfo>;
  /** RV scanner has Tradier creds wired (otherwise it can never produce options). */
  rvScannerConfigured: boolean;
  /** RV scanner's Tradier rate-limit breaker is currently tripped open. */
  rvBreakerOpen: boolean;
  demoEngineCount: number;
  engines: OptionsPipelineEngineView[];
}

/** First failing gate in the RV-scan conjunction, or null when fully armed. */
function rvScanBlocker(
  rvScannerConfigured: boolean,
  rvBreakerOpen: boolean,
  state: EngineState,
): string | null {
  if (!rvScannerConfigured) return 'rv_scanner_not_configured';
  if (rvBreakerOpen) return 'rv_breaker_open';
  if (!state.autoTradingEnabled) return 'auto_trading_off';
  if (state.tradingHalted) return 'trading_halted';
  if (!state.marketOpen) return 'market_closed';
  return null;
}

/**
 * TRA-895 — fold the demo-mode fleet + RV scanner status into the secrets-free
 * options-pipeline report backing the unauthenticated probe. Pure (clock
 * injected) so it is unit-testable without a server.
 */
export function summarizeOptionsPipeline(
  input: {
    rvScannerConfigured: boolean;
    rvBreakerOpen: boolean;
    engines: Array<{ state: EngineState; mode: string }>;
  },
  now: number,
): OptionsPipelineReport {
  const engines: OptionsPipelineEngineView[] = input.engines.map(({ state, mode }) => {
    const blockedBy = rvScanBlocker(input.rvScannerConfigured, input.rvBreakerOpen, state);
    return {
      mode,
      autoTradingEnabled: state.autoTradingEnabled,
      tradingAgentsEnabled: state.tradingAgentsEnabled,
      gatingEnabled: state.tradingAgentsGatingEnabled,
      tradingHalted: state.tradingHalted,
      haltReason: state.haltReason,
      marketOpen: state.marketOpen,
      watchlistSymbolCount: state.symbols.length,
      optionSignalCount: state.signals.filter(s => s.type === 'relative_value').length,
      totalSignalCount: state.signals.length,
      openOptionsCount: state.options.openOptions?.length ?? 0,
      rvScanArmed: blockedBy === null,
      blockedBy,
    };
  });
  return {
    ok: true,
    time: new Date(now).toISOString(),
    build: resolveBuildInfo(),
    rvScannerConfigured: input.rvScannerConfigured,
    rvBreakerOpen: input.rvBreakerOpen,
    demoEngineCount: engines.length,
    engines,
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
/**
 * Constant-time secret compare for the TRA-901 internal token. Short-circuits
 * on length mismatch (timingSafeEqual throws on unequal-length buffers); the
 * length of an internal shared secret is not itself sensitive.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerLiveHealthRoutes(app: Express, deps: LiveHealthDeps): void {
  const now = deps.now ?? Date.now;

  // TRA-901 — accept EITHER a user-JWT (via the normal requireAuth) OR the
  // configured internal token (`x-internal-token` header) so the unattended
  // daily-watch routine can read the demo book without a per-user login. The
  // internal path is only taken when a non-empty token is configured AND the
  // header matches it under a constant-time compare; otherwise we fall straight
  // through to requireAuth, so the surface never gets weaker than before.
  const internalOrAuth: RequestHandler = (req, res, next) => {
    const expected = deps.internalToken?.();
    if (expected) {
      const raw = req.headers['x-internal-token'];
      const provided = Array.isArray(raw) ? raw[0] : raw;
      if (provided && tokenMatches(provided, expected)) {
        res.locals['internalDemoAccess'] = true;
        next();
        return;
      }
    }
    deps.requireAuth(req, res, next);
  };

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

  // TRA-898 — demo paper-book summary for the TRA-895 daily watch. Names
  // balances, so it is gated (parity with `/api/health/live`). TRA-901 widens
  // the gate to accept the internal watch token in addition to a user JWT:
  //  - user-JWT caller  → their OWN demo book (caller-scoped, never a sum).
  //  - internal token   → the fleet's demo-mode books keyed by user, since the
  //    unattended routine has no engine of its own to scope to.
  app.get('/api/health/demo-book', internalOrAuth, async (_req, res) => {
    if (res.locals['internalDemoAccess']) {
      res.json(summarizeDemoBooks(deps.demoBooks?.() ?? [], now()));
      return;
    }
    const ctx = await deps.userCtx(res);
    if (res.headersSent) return;
    const settings = deps.getSettings(ctx.username);
    res.json(summarizeDemoBook(ctx.engine.getState(), settings.mode, now()));
  });

  const liveEquityAcceptance = deps.liveEquityAcceptance;
  if (liveEquityAcceptance) {
    app.get('/api/health/live-equity', (_req, res) => {
      res.json(aggregateLiveEquityAcceptance(liveEquityAcceptance(), now()));
    });
  }

  // TRA-895 — unauthenticated, secrets-free options-signal pipeline probe. Makes
  // the recurring "no option signals" report diagnosable from one curl: it names
  // whether the RV scanner is configured/breaker-open and, per demo engine, which
  // gate (auto-trade off / halted / market closed / …) is blocking the scan and
  // how many option signals are on the board. No balances, symbols, or PII.
  const optionsPipeline = deps.optionsPipeline;
  if (optionsPipeline) {
    app.get('/api/health/options-pipeline', (_req, res) => {
      res.json(summarizeOptionsPipeline(optionsPipeline(), now()));
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
