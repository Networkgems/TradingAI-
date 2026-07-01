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
import { ATM_SEED_ENABLED_BY_DEFAULT } from '../options-research-input.js';
import {
  isOptionShadowEnabled,
  isOptionPhaseBEnabled,
  OPTION_SHADOW_EMERGENCY_OFF,
} from '../option-shadow-ledger.js';
import {
  isOptionExecEnabled,
  isOptionEmaPullbackEnabled,
  isOptionVolumeBreakoutEnabled,
  isOptionDemoDirectionalEnabled,
  isOptionIvRvScannerEnabled,
} from '../option-exec-flag.js';
import { summarizeIvRvScans } from '../iv-rv-scanner.js';
import { isPerpFundingCarryEnabled } from '../perp-funding-carry-flag.js';
import { summarizeFundingCarryScans } from '../perp-funding-carry-scanner.js';
import { isCryptoRegimeEnabled } from '../crypto-regime-flag.js';
import { summarizeCryptoRegimeScans } from '../crypto-regime-scanner.js';
import { optionsIdeasAutoExecuteHealth } from '../options-ideas-auto-execute.js';
import {
  listOptionTradeJournal,
  summarizeOptionTradeJournal,
  isOptionTradeJournalEnabled,
  type OptionTradeJournalSummary,
} from '../option-trade-journal.js';
import {
  computeOptionLearnedWeights,
  type OptionLearnedWeights,
} from '../learned-option-weights.js';
import { isLearnedShrinkageEnabled } from '../learned-shrinkage-flag.js';
import {
  optionWeightsCache,
  type CachedOptionWeights,
  type WeightsFreshness,
} from '../learned-weights-cache.js';
import { isExternalIntelEnabled } from '../external-intel.js';
import { getColdStartPrefetchStatus } from '../daily-prefetch-flag.js';
import { getWatchdogStatus } from '../event-loop-watchdog.js';
import { isAnalystAgentEnabled, buildAnalystHealth } from '../analyst-agent.js';
import {
  loadSourceQualityWeights,
  type SourceQualityWeights,
} from '../source-quality-scorer.js';
import { buildHypothesisQueueHealth } from '../ratification-bridge.js';
import { ratifyHypothesis } from '../hypothesis-pipeline.js';

/** Minimal shape this module needs from a per-user context. */
export interface HealthEngineLike {
  getState(): EngineState;
  /** TRA-995 — current tighten-only risk multiplier (1 ⇒ full size). */
  getRiskThrottle?(): number;
  /** TRA-995 — the rolling risk-autopilot action log. */
  getAutopilotActions?(): import('../risk-autopilot.js').AutopilotAction[];
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

/**
 * TRA-901 — the NO-AUTH fleet demo-book view for the unattended TRA-898 daily
 * watch. The token-gated `/api/health/demo-book` path is unreachable for an
 * agent on Render (it needs a shared `DEMO_BOOK_INTERNAL_TOKEN` env var, which
 * can only be set via the Render dashboard / API — no agent has that access,
 * and committing a literal secret to this public repo would defeat the gate).
 * The TRA-901 issue itself sanctions this: "expose a no-auth internal summary
 * route". Safe to expose unauthenticated because it carries ONLY demo (paper-
 * money) state — no secrets, no live balances — and usernames are anonymized to
 * stable `demo-N` labels so the public surface leaks no account identity.
 */
export interface DemoBookPublicReport {
  ok: true;
  time: string;
  build: ReturnType<typeof resolveBuildInfo>;
  demoEngineCount: number;
  books: Array<{ label: string; book: DemoBookReport }>;
}

/** Anonymized, no-auth fleet demo-book summary (usernames → `demo-N`). */
export function summarizeDemoBooksPublic(
  engines: Array<{ username: string; state: EngineState; mode: string }>,
  now: number,
): DemoBookPublicReport {
  const fleet = summarizeDemoBooks(engines, now);
  return {
    ok: true,
    time: fleet.time,
    build: fleet.build,
    demoEngineCount: fleet.demoEngineCount,
    books: fleet.books.map((b, i) => ({ label: `demo-${i + 1}`, book: b.book })),
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
  /**
   * TRA-895 — true when the AI Options Ideas generator is un-gated from the
   * mechanical-anomaly scanner: on a calm day (no ≥2σ mispricing) it seeds
   * near-ATM anchors on liquid watchlist names so the research pass can still
   * propose event/IV-driven defined-risk ideas. This is the surface the board
   * un-gated; the dashboard RV signals above stay anomaly-only by design.
   */
  aiIdeasGeneratorUngated: boolean;
  /**
   * TRA-953 — true when the deterministic strategy-selector's per-tick shadow
   * pass is enabled (`ENABLE_OPTION_SHADOW_SELECTOR` on AND the emergency hard-
   * off disengaged). Phase-B routing is subordinate to this: with shadow off,
   * the selector never runs so nothing can route regardless of the Phase-B flag.
   */
  shadowSelectorEnabled: boolean;
  /**
   * TRA-953 — true when selected structures are PROMOTED from observe-only to
   * demo paper execution (`ENABLE_OPTION_PHASE_B_PAPER` on). The acceptance
   * curl reads this with `shadowSelectorEnabled` to confirm calls/puts can fill
   * in the demo book without a per-user login. Routing still needs the RV
   * scanner configured (chains loading) — `rvScannerConfigured` above.
   */
  phaseBPaperExecutionEnabled: boolean;
  /**
   * TRA-1032 (TRA-1029 Step 1) — true when `ENABLE_OPTION_EXEC_SELECTOR` is on,
   * i.e. the disciplined selection-quality / IVR-ceiling / spread-routing /
   * structure-exit logic (TRA-1023/1024/1025) is allowed to influence the
   * EXECUTING options path. This is the flag the forward-validation gate flips on
   * a demo book; surfacing it here is what makes the flip verifiable from the
   * unauthenticated probe (Step 4's "confirm exec selector reflected"). NOTE: the
   * flag is read from `process.env` (process-global) — it cannot be scoped to a
   * single demo engine; on this single-service deploy it arms all demo engines at
   * once. Live-capital promotion stays gated on TRA-382 regardless of this flag.
   * `optionExecEmaPullbackEnabled` / `optionExecVolumeBreakoutEnabled` are the
   * TRA-1028 sub-flags, each effective only when this parent flag is also on.
   */
  optionExecSelectorEnabled: boolean;
  optionExecEmaPullbackEnabled: boolean;
  optionExecVolumeBreakoutEnabled: boolean;
  /**
   * TRA-1114 — true when `ENABLE_OPTION_DEMO_DIRECTIONAL` is on: the demo-only
   * deterministic near-ATM directional call/put entry path. This is the idea
   * source that actually makes calls AND puts fill in the demo paper book when
   * the legacy RV anomaly scanner is empty and the spread selector stands down
   * on a thin IV-rank store. Demo/paper only (no Tradier mirror, no live
   * capital); surfaced here so the board can confirm the flip from the
   * unauthenticated probe alongside `openOptionsCount`.
   */
  optionDemoDirectionalEnabled: boolean;
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
    aiIdeasGeneratorUngated: ATM_SEED_ENABLED_BY_DEFAULT,
    // TRA-953 — surface the shadow + Phase-B promotion gates so acceptance is
    // verifiable from the unauthenticated probe. Shadow is the parent gate
    // (selector pass must run); Phase-B promotes its output to paper fills.
    shadowSelectorEnabled: !OPTION_SHADOW_EMERGENCY_OFF && isOptionShadowEnabled(),
    phaseBPaperExecutionEnabled: isOptionPhaseBEnabled(),
    // TRA-1032 — surface the executing-path selector gate (+ TRA-1028 sub-flags)
    // so the forward-validation flip is verifiable from the unauthenticated probe.
    optionExecSelectorEnabled: isOptionExecEnabled(),
    optionExecEmaPullbackEnabled: isOptionEmaPullbackEnabled(),
    optionExecVolumeBreakoutEnabled: isOptionVolumeBreakoutEnabled(),
    // TRA-1114 — surface the demo-only directional-entry gate so the board can
    // verify the flip drives real demo fills from the unauthenticated probe.
    optionDemoDirectionalEnabled: isOptionDemoDirectionalEnabled(),
    demoEngineCount: engines.length,
    engines,
  };
}

// ── TRA-991 option-trade journal readout ─────────────────────────────────────

/**
 * Shape returned by `GET /api/health/option-journal`. The journal is a
 * process-global, demo-only, observe-only ledger (no per-user balances, no
 * secrets), so the readout is unauthenticated — parity with
 * `/api/health/options-pipeline`. `enabled` mirrors the
 * `ENABLE_OPTION_TRADE_JOURNAL` flag so the board can see at a glance whether
 * accrual is even armed; when off the summary is still served (empty) so the
 * route never 404s mid-rollout. `weights` is the bounded learned multipliers the
 * fold derives — surfaced for visibility only; nothing here feeds a decision.
 */
export interface OptionJournalReport {
  ok: true;
  time: string;
  build: ReturnType<typeof resolveBuildInfo>;
  /** `ENABLE_OPTION_TRADE_JOURNAL` is on (accrual armed). */
  enabled: boolean;
  /**
   * TRA-1056 — `ENABLE_LEARNED_WEIGHT_SHRINKAGE` state. Each stat in `weights`
   * carries multiplierHardGate + multiplierShrunk for the QuantTrader A/B diff;
   * this flag says which one `optionSetupMultiplier` currently reads (default OFF
   * = hard-gate).
   */
  shrinkageEnabled: boolean;
  summary: OptionTradeJournalSummary;
  weights: OptionLearnedWeights;
  /**
   * TRA-1046 (TRA-1041c L1) — freshness of the learned-weights fold. `generation`
   * bumps on each recompute (a close event or TTL lapse), so a probe can confirm
   * the weights refreshed intraday after a demo trade closed rather than only at
   * the EOD snapshot. Present when the report is built through the refresh cache.
   */
  weightsFreshness?: WeightsFreshness;
}

// ── TRA-1000 external-intel source-quality readout ──────────────────────────

/**
 * Shape returned by `GET /api/health/source-quality`. `enabled` mirrors
 * `ENABLE_EXTERNAL_INTEL`; `weights` is the per-source advisory weights folded
 * from the attribution log × hypothesis-queue gate outcomes. Advisory only —
 * nothing here sizes capital or gates promotion (TRA-990 invariants 1 & 2).
 */
export interface SourceQualityReport {
  ok: true;
  time: string;
  build: ReturnType<typeof resolveBuildInfo>;
  /** `ENABLE_EXTERNAL_INTEL` is on (ingestion/extraction armed). */
  enabled: boolean;
  weights: SourceQualityWeights;
}

/** Load both logs and fold them into the readout. Pure beyond the clock + I/O. */
export async function buildSourceQualityReport(
  now: number,
  enabled: boolean,
): Promise<SourceQualityReport> {
  return {
    ok: true,
    time: new Date(now).toISOString(),
    build: resolveBuildInfo(),
    enabled,
    weights: await loadSourceQualityWeights(),
  };
}

/**
 * Fold the journal rows into the readout report. Pure beyond the clock. When the
 * caller passes a `cached` fold (TRA-1046) the weights + freshness come from the
 * intraday refresh cache instead of being recomputed inline, so the readout shows
 * the same weights live selection would read and a `weightsFreshness.generation`
 * a probe can watch tick after a demo close.
 */
export function buildOptionJournalReport(
  rows: Parameters<typeof summarizeOptionTradeJournal>[0],
  now: number,
  enabled: boolean,
  cached?: CachedOptionWeights,
): OptionJournalReport {
  return {
    ok: true,
    time: new Date(now).toISOString(),
    build: resolveBuildInfo(),
    enabled,
    shrinkageEnabled: isLearnedShrinkageEnabled(),
    summary: summarizeOptionTradeJournal(rows),
    weights: cached?.weights ?? computeOptionLearnedWeights(rows),
    ...(cached ? { weightsFreshness: cached.freshness } : {}),
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
    // TRA-995 — surface the risk-autopilot's tighten-only state in live health.
    riskThrottle: ctx.engine.getRiskThrottle?.(),
    autopilotActions: ctx.engine.getAutopilotActions?.(),
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

  // TRA-901 — NO-AUTH anonymized fleet demo-book for the unattended daily watch.
  // The token-gated route above cannot be reached by an agent on Render (env-var
  // only the dashboard can set; a committed secret would be public anyway), so
  // the watch reads this surface instead. Paper-money state only, no secrets,
  // usernames stripped to `demo-N` — see summarizeDemoBooksPublic.
  app.get('/api/health/demo-book-public', (_req, res) => {
    res.json(summarizeDemoBooksPublic(deps.demoBooks?.() ?? [], now()));
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

  // TRA-1156 — unauthenticated, secrets-free IV-vs-realised-vol mispricing
  // readout. The scan is a process-global, demo-only, OBSERVE-ONLY pass (no
  // balances/PII — just contract symbols, IV/RV ratios, and mispricing scores),
  // so this is unauthenticated (parity with /options-pipeline + /option-journal).
  // `enabled` mirrors ENABLE_OPTION_IV_RV_SCANNER so the board can see at a glance
  // whether the scanner is armed; when off the store is empty so the surface is
  // an honest zero rather than a 404. Always read-only: NO order is ever placed
  // off these candidates — routing waits on QuantTrader's threshold sign-off.
  app.get('/api/health/iv-rv', (_req, res) => {
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      enabled: isOptionIvRvScannerEnabled(),
      ...summarizeIvRvScans(now()),
    });
  });

  // TRA-1216 — unauthenticated, secrets-free perp funding-carry readout. The
  // scan is a process-global, OBSERVE-ONLY pass (no balances/PII — just perp
  // product ids, funding rates, and net-APR) so this is unauthenticated (parity
  // with /iv-rv). `enabled` mirrors ENABLE_PERP_FUNDING_CARRY_OBSERVE so the
  // board can see at a glance whether the scanner + funding-history accrual are
  // armed; when off the store is empty so the surface is a fail-closed
  // `enabled:false` with `scans:[]` rather than a 404. Always read-only: NO order
  // is ever placed off these candidates — the short-perp leg carries a
  // liquidation note but is never sized.
  app.get('/api/health/perp-funding-carry', (_req, res) => {
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      enabled: isPerpFundingCarryEnabled(),
      ...summarizeFundingCarryScans(now()),
    });
  });

  // TRA-1220 — unauthenticated, secrets-free crypto regime-overlay readout
  // (parity with /perp-funding-carry). The scan is a process-global, OBSERVE-ONLY
  // pass carrying no balances/PII — just symbols, regime labels, confidence, and
  // the ADX/CHOP/ER values. `enabled` mirrors ENABLE_CRYPTO_REGIME_OVERLAY so the
  // board can see at a glance whether the classifier is armed; when off the store
  // is empty so the surface is a fail-closed `enabled:false` with `scans:[]`
  // rather than a 404. Always read-only: NO order is ever placed off these labels.
  app.get('/api/health/crypto-regime', (_req, res) => {
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      enabled: isCryptoRegimeEnabled(),
      ...summarizeCryptoRegimeScans(now()),
    });
  });

  // TRA-1205 — unauthenticated, secrets-free readout for the AI-Ideas demo
  // auto-executor. The state is process-global, demo-only, and carries no
  // balances/PII — only the flag state, the configured top-N, lifetime submit
  // count, dedup-set size, and the last-run summary — so this is unauthenticated
  // (parity with /iv-rv + /option-journal). `enabled`/`topN` mirror the env so
  // the board can confirm at a glance whether top-3 auto-execution is armed.
  app.get('/api/health/options-ideas-auto-execute', (_req, res) => {
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      ...optionsIdeasAutoExecuteHealth(),
    });
  });

  // TRA-991 — unauthenticated, secrets-free option-trade-journal readout. The
  // journal is a process-global, demo-only setup→outcome ledger, so this carries
  // no balances/PII (parity with /options-pipeline). Surfaces the headline
  // summary + the bounded learned weights so the board can confirm accrual is
  // working after the first closed demo trade without a per-user login.
  app.get('/api/health/option-journal', async (req, res) => {
    const rows = await listOptionTradeJournal();
    // TRA-1046 — serve weights through the intraday refresh cache so the readout
    // shows the same fold live selection reads, plus a freshness generation a
    // probe can watch tick after a demo close.
    const cached = await optionWeightsCache().get();
    const report = buildOptionJournalReport(rows, now(), isOptionTradeJournalEnabled(), cached);
    // TRA-1133 — opt-in row-level dump for the OOS validation harness (TRA-992 Step
    // 1). `?rows=demo` appends the RESOLVED demo rows (setup key + realizedR +
    // outcome) so an offline run can fold the journal leave-one-out. Same demo-only,
    // secrets-free basis the route already documents — rows carry no balances/PII.
    if (req.query['rows'] === 'demo') {
      const demoResolved = rows.filter((r) => r.mode === 'demo' && r.outcome !== 'OPEN');
      res.json({ ...report, rows: demoResolved });
      return;
    }
    res.json(report);
  });

  // TRA-1000 — external-intel source-quality scorer readout. Folds the
  // attribution log against the hypothesis-queue gate outcomes into per-source
  // ADVISORY weights (who to listen to). Like /option-journal it carries no
  // balances/PII — just source keys + gate-pass stats — so it is unauthenticated
  // and is always served (empty when no intel has been ingested). `enabled`
  // mirrors ENABLE_EXTERNAL_INTEL so the board can see whether ingestion is armed.
  // The weights are advisory only: they never size capital or gate promotion.
  app.get('/api/health/source-quality', async (_req, res) => {
    res.json(await buildSourceQualityReport(now(), isExternalIntelEnabled()));
  });

  // TRA-1006 — automated analyst-agent readout. Reports whether the agent is
  // armed and the freshness of its pre-market plan / post-market review plus how
  // many hypotheses it queued today. Reads only the agent's own state file — no
  // balances/PII — so it is unauthenticated and always served (zeros when the
  // agent has never run). `enabled` mirrors ENABLE_ANALYST_AGENT.
  app.get('/api/health/analyst', async (_req, res) => {
    res.json(await buildAnalystHealth(now(), isAnalystAgentEnabled()));
  });

  // TRA-998 — the live cross-producer hypothesis ratification queue + ratified
  // demo overrides (hypothesis-pipeline.ts). Read-only and secrets-free (config
  // paths, numeric metrics, flag names — no balances/PII), so it is served
  // unauthenticated like the other /api/health/* probes. The board-ratification
  // routine reads this to know which items to raise a `request_confirmation` card
  // for on TRA-994 (each item carries its stable card idempotencyKey + demoFlag).
  app.get('/api/health/hypothesis-queue', async (_req, res) => {
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      ...(await buildHypothesisQueueHealth()),
    });
  });

  // TRA-998 — apply a BOARD ratification decision to a staged hypothesis. This is
  // the accept/reject half of the board edge: the routine raises the confirmation
  // card on TRA-994 and, once a human accepts, POSTs the decision here so the
  // change lands in DEMO config behind its OFF-by-default flag (or is closed out
  // on reject). `ratifyHypothesis` enforces invariant 2 — only a still-pending,
  // gate-passing item can be ratified — and there is NO live path: accept only
  // stages a demo override that a human must still flip the flag to activate.
  // Mutating, so it requires the internal token OR a user JWT (internalOrAuth).
  app.post('/api/hypothesis/:id/ratify', internalOrAuth, async (req, res) => {
    const rawId = req.params['id'];
    const id = Array.isArray(rawId) ? rawId[0] ?? '' : rawId;
    const body = (req.body ?? {}) as { decision?: unknown; decidedBy?: unknown };
    const decision = body.decision;
    if (decision !== 'accept' && decision !== 'reject') {
      res.status(400).json({ ok: false, error: 'decision must be "accept" or "reject"' });
      return;
    }
    const decidedBy =
      typeof body.decidedBy === 'string' && body.decidedBy.trim()
        ? body.decidedBy.trim()
        : res.locals['internalDemoAccess']
          ? 'board-ratification-routine'
          : 'board';
    try {
      const result = await ratifyHypothesis({
        hypothesisId: id,
        decision,
        decidedBy,
        decidedAt: now(),
      });
      res.json({ ok: true, decision, item: result.item, override: result.override ?? null });
    } catch (err) {
      // Unknown id or not-pending (already decided / gate-failed) — a conflict,
      // not a server fault. Surface the guard message verbatim for the routine.
      res.status(409).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // TRA-1059 — unauthenticated, secrets-free cold-start daily-prefetch warmer
  // probe. Surfaces the `ENABLE_COLD_START_DAILY_PREFETCH` flag + resolved
  // per-minute budget and the most-recent `CryptoEngine.warmDailyCandlesOnBoot`
  // run ({ warmed, elapsedMs, startedAt, completed }). Lets QuantTrader confirm
  // from one curl that the flag is actually set on the demo book and read the
  // warm result without Render-log access; `lastRun` is null when the warmer
  // never ran this boot (flag OFF or no active symbols). No balances/PII —
  // parity with the other /api/health/* probes.
  app.get('/api/health/cold-start-prefetch', (_req, res) => {
    const status = getColdStartPrefetchStatus();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      ...status,
    });
  });

  // TRA-1080 — unauthenticated, secrets-free event-loop/heap watchdog probe.
  // Surfaces the watchdog config (thresholds, restart-enabled) and the most
  // recent sample (heap %, mean/max event-loop lag, consecutive breach
  // counters). Two purposes: (1) confirm the watchdog is armed on prod from one
  // curl, and (2) give the bqb1 502 monitoring a direct read on how close the
  // box is to the starvation watermark BEFORE it trips a restart. `watchdog` is
  // null when the watchdog is disabled via env (WATCHDOG_ENABLED=false). The
  // fact that THIS route answers <500ms is itself the live "event loop is not
  // starved" signal the ticket's acceptance asks for.
  app.get('/api/health/watchdog', (_req, res) => {
    const watchdog = getWatchdogStatus();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      watchdog,
    });
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
