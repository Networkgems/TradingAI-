// TRA-528 — live reliability + observability HTTP surface + monitor hook.
//
// The route handlers and the background stale-state probe live here, behind a
// dependency-injected `LiveHealthDeps`, rather than inline in `index.ts`. That
// keeps the wiring in `index.ts` to a single `registerLiveHealthRoutes(...)`
// call + one line in the monitor, and lets the whole surface be unit-tested
// with a fake express app and fake user contexts — no live server required.

import { timingSafeEqual } from 'node:crypto';
import type { Express, Response, RequestHandler } from 'express';
import { findMissingLiveCredentials, DEFAULT_ACCOUNT_SETTINGS, type AccountSettings } from '@trading-app/shared';
import type { EngineState, LiveEquityAcceptance, LiveSkipCategory } from '../signal-engine.js';
import { LIVE_SKIP_CATEGORIES, emptyLiveSkipBreakdown } from '../signal-engine.js';
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
  isOptionShortPremiumScannerEnabled,
} from '../option-exec-flag.js';
import { summarizeIvRvScans } from '../iv-rv-scanner.js';
import { summarizeShortPremiumScans } from '../short-premium-scanner.js';
import { isPerpFundingCarryEnabled } from '../perp-funding-carry-flag.js';
import { summarizeFundingCarryScans } from '../perp-funding-carry-scanner.js';
import { isCryptoRegimeEnabled } from '../crypto-regime-flag.js';
import { summarizeCryptoRegimeScans } from '../crypto-regime-scanner.js';
import { isRegimeTsmomEnabled, isRegimeTsmomDemoRouteEnabled } from '../crypto-regime-tsmom-flag.js';
import { summarizeRegimeTsmomScans } from '../crypto-regime-tsmom-scanner.js';
import { summarizeRegimeTsmomDemoRoute } from '../crypto-regime-tsmom-demo-route.js';
import { isCryptoIgnitionEnabled, resolveIgnitionWatchlist } from '../crypto-ignition-flag.js';
import { summarizeIgnitionScans } from '../crypto-ignition-scanner.js';
import { summarizeConvictionDca, resolveConvictionDcaDeployAnchor } from '../conviction-dca-ledger.js';
import { summarizeChurnBrake } from '../churn-brake-ledger.js';
import { summarizeDirectionalGate } from '../directional-open-ledger.js';
import { summarizeEntryGreeksGate } from '../entry-greeks-ledger.js';
import { RV_LONG_DELTA_FLOOR } from '@trading-app/engine';
import { summarizeCostAwareGate } from '../cost-aware-gate-ledger.js';
import { evaluateDurability } from '../durability.js'; // TRA-1681
import { getStateDbStatus } from '../sqlite.js'; // TRA-1681
import {
  isOptionCostAwareGateEnabled,
  resolveCostGateConfig,
  admissionBarR,
  OPTION_COST_AWARE_GATE_FLAG,
} from '../option-cost-gate.js';
import { summarizeSpreadCost, SLEEVE_SPREAD_CEILINGS } from '../option-spread-cost.js';
import type { SpreadCostSample } from '../option-spread-cost.js';
import {
  isDirectionalQualityGateEnabled,
  resolveDirectionalQualityThresholds,
  OPTION_DIRECTIONAL_QUALITY_GATE_FLAG,
} from '../ignition-quality-gate.js';
import { etDateString } from '../scheduler.js';
import {
  isChurnLossBrakeEnabled,
  resolveSameSessionOpenCap,
  CHURN_LOSS_BRAKE_FLAG,
} from '../churn-loss-brake-flag.js';
import { isScaleoutLadderEnabled } from '../scaleout-ladder-flag.js';
import { summarizeScaleoutLadder } from '../scaleout-ladder-ledger.js';
import { summarizeEquityEntryFunnel } from '../equity-entry-funnel.js'; // TRA-1768
import { isCorrelatedExposureCapEnabled, CORRELATED_EXPOSURE_CAP_FLAG, isTakeProfitEarlyEnabled, TAKE_PROFIT_EARLY_FLAG, isEntryGreeksGateEnabled, ENTRY_GREEKS_GATE_FLAG, isEntryDeltaCeilingEnabled, resolveEntryDeltaCeiling, resolveEntryDeltaCeilingStructures, resolveEntryDeltaCeilingMap, resolveEntryDeltaCeilingObserveStructures, OPTION_ENTRY_DELTA_CEILING_FLAG } from '../exit-risk-rules-flag.js';
import { summarizeCorrelatedExposureBindings } from '../correlated-exposure-ledger.js';
import { CONVICTION_DCA, CORRELATED_EXPOSURE_CAP_PCT, CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT, TAKE_PROFIT_EARLY_CAPTURE_PCT, ENTRY_SHORT_DELTA_MIN, ENTRY_SHORT_DELTA_MAX, ENTRY_DELTA_THETA_RATIO_FLOOR, resolveEquitySwingModeEnabled, resolveEquitySwingUniverse, EQUITY_SWING_UNIVERSE, EQUITY_SWING_GUARDRAIL } from '@trading-app/shared';
import { resolveDemoFlagEnv } from '../demo-flags.js';
import {
  isSma200DemoForwardTestEnabled,
  SMA200_DEMO_FORWARD_TEST_FLAG,
} from '../sma200-forward-test-flag.js';
import { optionsIdeasAutoExecuteHealth } from '../options-ideas-auto-execute.js';
import {
  listOptionTradeJournal,
  summarizeOptionTradeJournal,
  isOptionTradeJournalEnabled,
  getOptionTradeJournalIntegrity,
  type OptionTradeJournalSummary,
  type OptionTradeJournalIntegrity,
} from '../option-trade-journal.js';
import {
  computeOptionLearnedWeights,
  type OptionLearnedWeights,
} from '../learned-option-weights.js';
import {
  listMakerFillEvents,
  summarizeMakerFills,
  isOptionMakerTelemetryEnabled,
} from '../option-maker-fill-ledger.js';
import {
  listShadowChases,
  summarizeShadowRecovery,
  isOptionMakerShadowEnabled,
  BREAKEVEN_MAKER_RECOVERY,
} from '../option-maker-shadow.js';
import { resolveMakerWalkConfig } from '../option-maker-config.js';
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
  /**
   * TRA-1573 — fleet-summed breakdown of `liveSkipReasons` by fixed category
   * (see {@link LiveSkipCategory}). Distinguishes a benign by-design gate
   * (`display_only_capital_gate` — no strategy in the TRA-817 manifest) from a
   * real wiring gap (`client_not_configured`) on the unauth surface. Redacted:
   * only constant category keys + counts, never a raw reason string.
   */
  liveSkipReasonBreakdown: Record<LiveSkipCategory, number>;
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
  const liveSkipReasonBreakdown = emptyLiveSkipBreakdown();
  for (const s of snapshots) {
    for (const c of LIVE_SKIP_CATEGORIES) {
      liveSkipReasonBreakdown[c] += s.liveSkipReasonCategories?.[c] ?? 0;
    }
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
    liveSkipReasonBreakdown,
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

// ── TRA-1289 sma200_pullback demo forward-test fill evidence ──────────────────

/**
 * Forward evidence the TRA-1242 accrual monitor reads to tell "armed, no swing
 * signal yet" from "a demo forward-test fill landed". The `forwardTestOnly`
 * marker is the UNIQUE fingerprint of this path — only `openSma200Pullback`'s
 * demo-only, flag-gated branch ever stamps it — so counting positions that
 * carry it exactly counts sma200_pullback forward-test fills, with no need to
 * re-thread the signal type. Demo-money only; no secrets, no live capital.
 */
export interface Sma200ForwardTestFillReport {
  /** Open + recent-closed forwardTestOnly fills — `>= 1` ⇒ first fill observed. */
  fillCount: number;
  /** Currently-open forwardTestOnly paper positions (survive reboot via snapshot). */
  openPositions: number;
  /** forwardTestOnly positions in the fleet's recent-closed buffer. */
  closedCount: number;
  /** ISO time of the most-recent forwardTestOnly fill, or null if none yet. */
  lastFillAt: string | null;
  /** Σ realized P&L over the recent-closed forwardTestOnly fills. */
  realizedPnl: number;
}

/**
 * Fold the demo fleet's paper books into the forward-test fill tally. Pure
 * (clock injected) so it is unit-testable without a server. Open positions are
 * rebuilt from the DATA_DIR snapshot on boot, so an open swing hold stays
 * visible across the ~daily bqb1 reboot; the closed buffer is getState()-capped
 * at the last 20 per mode, which is why `fillCount` also folds open positions.
 */
export function summarizeSma200ForwardTestFills(
  engines: Array<{ state: EngineState; mode: string }>,
): Sma200ForwardTestFillReport {
  let openPositions = 0;
  let closedCount = 0;
  let realizedPnl = 0;
  let lastFillTs: number | null = null;
  const considerFill = (openedAt?: number): void => {
    if (typeof openedAt === 'number' && (lastFillTs === null || openedAt > lastFillTs)) {
      lastFillTs = openedAt;
    }
  };
  for (const { state } of engines) {
    for (const p of state.account.openPositions) {
      if ((p as { forwardTestOnly?: boolean }).forwardTestOnly) {
        openPositions += 1;
        considerFill(p.openedAt);
      }
    }
    for (const p of state.closedPositions) {
      if ((p as { forwardTestOnly?: boolean }).forwardTestOnly) {
        closedCount += 1;
        realizedPnl += Number.isFinite(p.pnl) ? (p.pnl as number) : 0;
        considerFill((p as { openedAt?: number }).openedAt);
      }
    }
  }
  return {
    fillCount: openPositions + closedCount,
    openPositions,
    closedCount,
    lastFillAt: lastFillTs === null ? null : new Date(lastFillTs).toISOString(),
    realizedPnl,
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
   * TRA-1405 — of the open options, how many are MULTI-LEG combos (iron condor /
   * vertical). Combos are mark-managed only at close/expiry: `checkExits` skips
   * them so they sit OPEN and never emit a realized CLOSE, whereas single-legs
   * auto-close on SL/trail and DO realize onto the Calendar. A book whose open
   * options are all combos can crater its equity (open MTM) while showing $0
   * realized on the Calendar every day — this count is the discriminator for
   * that failure mode without a per-user login.
   */
  openOptionsComboCount: number;
  /**
   * TRA-1405 — size of the engine's recent-CLOSED options buffer. Non-zero ⇒
   * this book has closed (realized) option trades that flow to the Calendar's
   * per-day options cell. Zero across a trading session ⇒ nothing realized.
   */
  closedOptionsRecentCount: number;
  /**
   * TRA-1405 — the book's today-realized options P&L (`dailyRealizedOptionsPnl`),
   * the EXACT figure the Calendar's per-day options cell sums (eod-report.ts
   * `optionsPnl`). Lets the board confirm, per demo engine and joinable by index
   * to `/api/health/autonomous-demo` usernames, whether a given book (e.g. admin)
   * is realizing option P&L onto its Calendar — the acceptance signal for
   * TRA-1405 — without the admin login the issue was blocked on. `null` when the
   * engine hasn't populated the field yet (pre-first-close / legacy snapshot).
   */
  dailyRealizedOptionsPnl: number | null;
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
      // TRA-1405 — a position with ≥2 legs is a multi-leg combo (checkExits skips
      // it ⇒ never realizes); single-leg (no `legs` / one leg) auto-closes.
      openOptionsComboCount: (state.options.openOptions ?? [])
        .filter(o => (o.legs?.length ?? 0) > 1).length,
      closedOptionsRecentCount: state.options.closedOptions?.length ?? 0,
      dailyRealizedOptionsPnl: state.options.dailyRealizedOptionsPnl ?? null,
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
  /**
   * TRA-1681 — what the last journal load DROPPED (unparseable lines skipped,
   * read errors that forced the empty-book fallback). A grade that passes on
   * "this counter did not grow" cannot tell a clean load from one that silently
   * lost the row it was watching for; this is how such a window VOIDs instead of
   * certifying. `corruptLines: null` = not measured, never `0`.
   */
  integrity: OptionTradeJournalIntegrity;
  weights: OptionLearnedWeights;
  /**
   * TRA-1591 — echoes the `sinceTs` cohort filter (epoch ms) when the caller
   * passed one, so a grading poll can confirm the `summary` was scoped to the
   * post-arm cohort rather than the cumulative pool. Absent on the unfiltered
   * (cumulative) readout.
   */
  sinceTs?: number;
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
 *
 * TRA-1591 — an optional `sinceTs` (epoch ms) restricts the `summary` fold to
 * rows whose ENTRY timestamp (`openTs`) is `>= sinceTs`, so a post-arm cohort can
 * be graded in isolation from the historical pool. Because the OTM entry delta
 * floor (TRA-1407) rejects any entry with `|Δ| < 0.40` at open time, every
 * post-arm `single_leg_otm` fill is floored by construction, so a `sinceTs`
 * cohort == the floored cohort. Absent → identical output to before
 * (regression-safe). `weights`/`weightsFreshness` are deliberately left over the
 * FULL row set: the learned-weights fold and its cache generation are a
 * process-global concern the cohort filter must not perturb.
 */
export function buildOptionJournalReport(
  rows: Parameters<typeof summarizeOptionTradeJournal>[0],
  now: number,
  enabled: boolean,
  cached?: CachedOptionWeights,
  sinceTs?: number,
): OptionJournalReport {
  const summaryRows =
    sinceTs === undefined ? rows : rows.filter((r) => r.openTs >= sinceTs);
  return {
    ok: true,
    time: new Date(now).toISOString(),
    build: resolveBuildInfo(),
    enabled,
    shrinkageEnabled: isLearnedShrinkageEnabled(),
    summary: summarizeOptionTradeJournal(summaryRows),
    integrity: getOptionTradeJournalIntegrity(),
    weights: cached?.weights ?? computeOptionLearnedWeights(rows),
    ...(cached ? { weightsFreshness: cached.freshness } : {}),
    ...(sinceTs === undefined ? {} : { sinceTs }),
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

  // TRA-1292 — unauthenticated, secrets-free defined-risk SHORT-PREMIUM readout
  // (credit spreads / iron condors). Process-global, demo-only, OBSERVE-ONLY (no
  // balances/PII — just structure legs, credit/width/PoP, IV/RV, IV-rank, and
  // scores), so this is unauthenticated (parity with /iv-rv). `enabled` mirrors
  // ENABLE_OPTION_SHORT_PREMIUM_SCANNER so the board can see at a glance whether
  // the theta-positive scanner is armed; when off the store is empty so the
  // surface is an honest zero rather than a 404. Always read-only: NO order is
  // ever placed off these structures — demo routing / graduation is a separate
  // board decision.
  app.get('/api/health/short-premium', (_req, res) => {
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      enabled: isOptionShortPremiumScannerEnabled(),
      ...summarizeShortPremiumScans(now()),
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

  // TRA-1221 — unauthenticated, secrets-free regime-gated TSMOM readout (parity
  // with /crypto-regime). Process-global, OBSERVE-ONLY: carries no balances/PII —
  // just symbols, would-be actions, regime@bar, r_L, and rolling would-be turnover
  // + net-of-taker expectancy R. `enabled` mirrors ENABLE_CRYPTO_REGIME_TSMOM so
  // the board sees at a glance whether the scanner is armed; when off the store is
  // empty ⇒ fail-closed `enabled:false` with `scans:[]`. Always read-only: NO order
  // is placed off these signals — the short_observe leg is never sized.
  app.get('/api/health/crypto-regime-tsmom', (_req, res) => {
    // TRA-1317 — the DEMO paper-route block. `enabled` mirrors the standalone,
    // demo-scoped CRYPTO_REGIME_TSMOM_DEMO_ROUTE_ENABLED resolved through the SAME
    // demo-flags overlay the engine consults (process.env layered with the DATA_DIR
    // demo-flags.json, file wins) so it reflects the EFFECTIVE switch. The route book
    // has no live path (liveCapitalReachable:false) — arming it can never touch real
    // capital. openPositions/fillCount/realizedR are the forward evidence the future
    // live-promotion decision reads; all rebuilt from the snapshot under DATA_DIR on boot.
    const dir = process.env.DATA_DIR;
    const routeEnv = dir ? resolveDemoFlagEnv(dir) : process.env;
    const demo = summarizeRegimeTsmomDemoRoute();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      enabled: isRegimeTsmomEnabled(),
      ...summarizeRegimeTsmomScans(now()),
      demoRoute: {
        enabled: isRegimeTsmomDemoRouteEnabled(routeEnv),
        demoOnly: true,
        liveCapitalReachable: false,
        openPositions: demo.openPositions,
        fillCount: demo.fillCount,
        closeCount: demo.closeCount,
        lastFillAt: demo.lastFillAt,
        realizedR: demo.realizedR,
        realizedPnl: demo.realizedPnl,
        recent: demo.recent,
      },
    });
  });

  // TRA-1271 — unauthenticated, secrets-free crypto ignition readout (parity with
  // /crypto-regime-tsmom). Process-global, OBSERVE-ONLY, ZERO capital: carries no
  // balances/PII — just watchlist size, open/resolved forward-record counts, per-arm
  // net-of-fee expectancy R (maker vs taker), hit%, and the ★ would-a-limit-fill
  // rate that confirms-or-kills the maker-fill edge. `enabled` mirrors
  // ENABLE_CRYPTO_IGNITION_SCANNER so the board sees at a glance whether capture is
  // armed; when off the store is empty ⇒ fail-closed `enabled:false`. Always
  // read-only: NO order is ever placed off these signals (graduation is a separate,
  // board-visible decision — taker-cost CI must clear 0 first).
  app.get('/api/health/crypto-ignition', (_req, res) => {
    const enabled = isCryptoIgnitionEnabled();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      enabled,
      ...summarizeIgnitionScans(now(), enabled ? resolveIgnitionWatchlist().length : 0),
    });
  });

  // TRA-1278 — unauthenticated, secrets-free conviction-DCA add-ledger readout
  // (parity with /demo-book-public + /crypto-ignition). This is the durable data
  // source the TRA-971 weekly forward-evidence gate (TRA-1276) pulls: it exposes
  // the demo/paper scale-in add fills accrued since the a255c2d deploy anchor —
  // addCount, the R-cap breachCount (fills where realizedRiskDollars > R + ε),
  // lastAddAt, and a small recent-fills tail — all rebuilt from the JSONL under
  // DATA_DIR on boot so the counts survive the ~daily demo-host restart instead of
  // reading a structural 0. `enabled` mirrors CONVICTION_DCA.enabled. Carries no
  // balances/PII beyond symbol + per-fill R math. Always read-only: pure accounting,
  // NO entry/exit/scale-in path is touched.
  app.get('/api/health/conviction-dca', (_req, res) => {
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      enabled: CONVICTION_DCA.enabled,
      ...summarizeConvictionDca(resolveConvictionDcaDeployAnchor()),
    });
  });

  // TRA-1481 (parent TRA-1408) — unauthenticated, secrets-free readout of the
  // per-name churn + same-day-loss brake. QuantTrader could previously only INFER
  // the brake state from `/api/reports/desk` churn — two full demo sessions before
  // the "armed-but-inert" finding could be called. This surface makes it
  // deterministic in one read:
  //   • `armed` + `cap` resolved through the SAME effective env the signal-engine
  //     consults (process.env layered with the DATA_DIR demo-flags.json overlay,
  //     file wins) — so this answers "is ENABLE_CHURN_LOSS_BRAKE actually LIVE on
  //     the running process?" directly, not just "is it merged to render.yaml?";
  //   • `openCountsBySymbol` — the per-name NEW-open counters for the current ET
  //     session (mirrors the engine's `churnOpensToday` from the shared chokepoint);
  //   • `opensRejected` — opens the same-session cap actually refused (the direct
  //     enforcement evidence);
  //   • `dcaAddsHalted` — conviction-DCA adds the same-day-loss rule halted, split
  //     equity/option.
  // DEMO-ONLY by construction: the engine record/reject/halt helpers are no-ops on
  // the live path, so every counter reflects the demo book. Counters are in-memory
  // and reset on the ~daily reboot (same contract as `/api/health/live-equity`); a
  // validation run reads them within a session. No balances/PII.
  app.get('/api/health/churn-brake', (_req, res) => {
    const dir = process.env.DATA_DIR;
    const env = dir ? resolveDemoFlagEnv(dir) : process.env;
    const armed = isChurnLossBrakeEnabled(env);
    const cap = resolveSameSessionOpenCap(env);
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      flag: CHURN_LOSS_BRAKE_FLAG,
      armed,
      cap,
      demoOnly: true,
      liveCapitalReachable: false,
      note: armed
        ? `ARMED (demo-only): rejects the ${cap + 1}th same-session open per name and halts a conviction-DCA add into a same-day net-negative name; live path unchanged.`
        : `DISARMED: set ${CHURN_LOSS_BRAKE_FLAG}=1 (render.yaml env or DATA_DIR/demo-flags.json) to arm on the demo book.`,
      ...summarizeChurnBrake(),
    });
  });

  // TRA-1486 (parent TRA-1476) — unauthenticated, secrets-free readout of the demo
  // directional quality/liquidity gate. The TRA-1485 forward grade could only INFER
  // the gate's behaviour from `/api/reports/desk` (and found it leaking); this makes
  // the enforcement deterministic in one read:
  //   • `armed` + `thresholds` resolved through the SAME effective env the engine
  //     consults (process.env layered with the DATA_DIR demo-flags.json overlay, file
  //     wins) — answers "is the gate actually LIVE on the running process?";
  //   • `openCountsBySymbol` — the DURABLE (reboot-survivable), DIRECTIONAL-ONLY
  //     per-name open counts for the CURRENT ET day that the per-name cap consults,
  //     so a grader can verify "≤ cap DIRECTIONAL opens/name/ET-day for every name"
  //     directly (TRA-1486 D2; scoped to the directional sleeve by TRA-1564 B2 — a
  //     count here is no longer inflated by equity-swing / RV / OTM opens on the name);
  //   • `opensRejectedByCode` — DURABLE rejects for the CURRENT ET day split by verdict
  //     code (min_price / insufficient_liquidity_samples / min_dollar_volume /
  //     per_name_cap), the direct evidence each floor is biting (incl. the D1 warmup
  //     fail-closed). TRA-1564 B1 made these JSONL-backed + ET-day-keyed so a
  //     post-close re-grade fire reads the RTH session's rejects after the daily
  //     close reboot (they were in-memory since-boot before, already `{}` by then).
  // DEMO-ONLY by construction: the engine records here only on the demo directional
  // chokepoint. No balances/PII — just flag, thresholds, symbol counts, reject codes.
  app.get('/api/health/directional-quality-gate', (_req, res) => {
    const dir = process.env.DATA_DIR;
    const env = dir ? resolveDemoFlagEnv(dir) : process.env;
    const armed = isDirectionalQualityGateEnabled(env);
    const thresholds = resolveDirectionalQualityThresholds(env);
    const etDay = etDateString(new Date(now()));
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      flag: OPTION_DIRECTIONAL_QUALITY_GATE_FLAG,
      armed,
      demoOnly: true,
      liveCapitalReachable: false,
      etDay,
      thresholds,
      note: armed
        ? `ARMED (demo-only): rejects a demo directional open below $${thresholds.minUnderlyingPrice} spot / $${thresholds.minAvgDollarVolume} avg $-vol, fails-closed under ${thresholds.minDollarVolumeSamples} real $-vol samples (warmup), and caps ${thresholds.maxOpensPerName} DIRECTIONAL opens/name/ET-day (reboot-durable; openCountsBySymbol is directional-only). Live options path unchanged.`
        : `DISARMED: set ${OPTION_DIRECTIONAL_QUALITY_GATE_FLAG}=1 (render.yaml env or DATA_DIR/demo-flags.json) with the directional path enabled to arm on the demo book.`,
      ...summarizeDirectionalGate(etDay),
    });
  });

  // TRA-1602 (TRA-1600C, parent TRA-1599) — unauthenticated, secrets-free readout of
  // the per-candidate COST-AWARE options fire bar, armed on the demo book by board
  // interaction `427b57ee`. A working admission gate's evidence is the trades that
  // DIDN'T happen, so without this a grader can only INFER enforcement from desk
  // churn (the TRA-1476 "armed-but-inert" trap that burned two demo sessions). One
  // read answers:
  //   • `armed` — resolved through the SAME effective env the engine consults
  //     (process.env layered with the DATA_DIR demo-flags.json overlay, file wins),
  //     so it reports whether the flag is LIVE on the running process, not merely
  //     merged to render.yaml (the TRA-1289 blueprint-env-sync gap);
  //   • `bars` — the effective admission bar per structure (cost model + safety
  //     margin, floored), which is env-tunable, so a retune is visible immediately;
  //   • `byStructure` — DURABLE (reboot-survivable, ET-day-keyed) admitted/rejected
  //     counts plus the mean modeled gross R either side of the bar, so QuantTrader
  //     can see whether the bar is biting on scratch-tier ideas or starving the book.
  // DEMO-ONLY by construction: `costAwareGateReject` early-returns on `mode!=='demo'`
  // and on the flag being off, so every counter reflects an armed DEMO book and this
  // surface is structurally incapable of describing a live open. No balances/PII.
  // TRA-1681 — IS ANYTHING ON THIS BOX ACTUALLY DURABLE?
  //
  // The one question every multi-session grade depends on and no existing surface could
  // answer. Each durable store publishes its own local counters, and every one of them
  // reads exactly the same on a box whose DATA_DIR is a directory inside the build
  // bundle: the ledger hydrates (from a file it wrote this uptime), appends succeed (the
  // path really is writable), `etDays[]` fills. Nothing throws. Nothing warns. The data
  // is gone at the next redeploy.
  //
  // `checkDataDirHealth()` has computed the right predicate since TRA-140 — and sent it
  // to `log.warn`. bqb1 exposes no log surface to a grader (no TRADING_ADMIN_*; public
  // `/api/health/*` only), so the one fact that invalidates every durable count on the
  // box was, in practice, unreadable by the person who needed it. This route is that fix:
  // a fact that only reaches a log line does not exist downstream. Put it in the PAYLOAD.
  //
  // Read `ephemeral` FIRST. It is a property of the PATH, so it is decisive on the very
  // first boot, before a single row exists — unlike `hydratedRecords`, which cannot tell
  // a fresh persistent disk from a wiped ephemeral one.
  //
  // `ok` is TRUE only when nothing is broken AND nothing is unmeasured. An unmeasured
  // guarantee is not a satisfied one (`corruptLines: null` means no load has run, never
  // "a clean load"), and treating the two as the same is the exact false-green this whole
  // chain of tickets is made of. No balances/PII — a path, some counters, and a verdict.
  app.get('/api/health/durability', (_req, res) => {
    const dataDir = process.env.DATA_DIR ?? null;
    const etDay = etDateString(new Date(now()));
    const ledger = summarizeCostAwareGate(etDay).durability;
    const report = evaluateDurability({
      // The LEDGER's resolved dir is the truth when it has one: it is the path bytes are
      // actually appended to. `process.env.DATA_DIR` is what the operator *set*, and on a
      // box where it is unset the two disagree in precisely the way that matters — the
      // ledger falls back to a bundle path and writes there happily.
      dataDir: ledger.dataDir ?? dataDir,
      stateDb: getStateDbStatus(),
      journal: getOptionTradeJournalIntegrity(),
      ledger: { appendErrors: ledger.appendErrors },
    });
    res.json({
      ok: report.ok,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      // Spelled out rather than spread: `ephemeral` and `violations` are the two fields a
      // grader acts on, and they belong above the fold, not wherever a spread happens to
      // put them.
      policy: report.policy,
      dataDir: report.dataDir,
      ephemeral: report.ephemeral,
      stateDb: report.stateDb,
      journal: report.journal,
      ledger: report.ledger,
      violations: report.violations,
      unmeasured: report.unmeasured,
      note: report.ok
        ? 'Durable state is intact: DATA_DIR is on a persistent mount, the hot-state store is open, and the journal loaded clean. Counts on this box survive a redeploy.'
        : `NOT DURABLE${report.violations.length > 0 ? ` — broken: ${report.violations.join(', ')}` : ''}${report.unmeasured.length > 0 ? ` — unmeasured (VOIDS a grade, does not stop a boot): ${report.unmeasured.join(', ')}` : ''}. Any multi-session window read off this box is VOID. Policy is '${report.policy}' (set DURABILITY_POLICY=refuse to make a broken guarantee stop the boot).`,
    });
  });

  app.get('/api/health/cost-aware-gate', (_req, res) => {
    const dir = process.env.DATA_DIR;
    const env = dir ? resolveDemoFlagEnv(dir) : process.env;
    const armed = isOptionCostAwareGateEnabled(env);
    const config = resolveCostGateConfig(env);
    const structures = ['single_leg_rv', 'single_leg_otm', 'directional'];
    const bars: Record<string, number> = {};
    for (const s of structures) bars[s] = admissionBarR(s, config);
    const etDay = etDateString(new Date(now()));
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      flag: OPTION_COST_AWARE_GATE_FLAG,
      armed,
      demoOnly: true,
      liveCapitalReachable: false,
      etDay,
      bars,
      config,
      note: armed
        ? `ARMED (demo-only): rejects a demo RV / OTM / directional open whose modeled GROSS R can't clear its structure's cost-aware bar (${structures.map((s) => `${s} ${bars[s]!.toFixed(2)}R`).join(', ')}). rejected>0 is the direct evidence the bar is biting. Live options admission unchanged.`
        : `DISARMED: set ${OPTION_COST_AWARE_GATE_FLAG}=1 (render.yaml env or DATA_DIR/demo-flags.json) to arm on the demo book.`,
      // TRA-1670 — the ceiling half of the entry band, reported on the SAME surface
      // because it exists precisely to make a cut this gate cannot: the bar above is
      // algebraically a delta FLOOR (admit ⟺ |Δ| ≥ (bar+1)/(mult·(rewardR+1)) =
      // 0.495 at the shipped default), so it can never reject the top of the delta
      // range. It is a SEPARATE flag with its own arm state — read both.
      deltaCeiling: (() => {
        const ceilingArmed = isEntryDeltaCeilingEnabled(env);
        const ceilingStructures = resolveEntryDeltaCeilingStructures(env);
        const ceiling = resolveEntryDeltaCeiling(env);
        // TRA-1689 — report the EFFECTIVE ceiling PER STRUCTURE and which of them merely
        // OBSERVE. `ceiling` below is only the global default a bare structure inherits;
        // publishing that alone is how an impossible gate hides (TRA-1682: the probe
        // advertised the library default while the engine passed something else). A
        // reader must be able to see, per sleeve, the number that actually applies and
        // whether a breach of it stops a trade or merely counts one.
        const effective = resolveEntryDeltaCeilingMap(env);
        const observeOnly = resolveEntryDeltaCeilingObserveStructures(env)
          .filter((s) => effective.has(s));
        const perStructure = [...effective.entries()].map(([structure, value]) => ({
          structure,
          ceiling: value,
          mode: observeOnly.includes(structure) ? ('observe' as const) : ('enforce' as const),
        }));
        const enforcing = perStructure.filter((s) => s.mode === 'enforce');
        const describe = (s: { structure: string; ceiling: number }): string =>
          `${s.structure} |Δ|>${s.ceiling.toFixed(2)}`;
        return {
          flag: OPTION_ENTRY_DELTA_CEILING_FLAG,
          armed: ceilingArmed,
          /** The GLOBAL default a bare structure inherits — NOT necessarily what any sleeve uses. */
          ceiling,
          structures: ceilingStructures,
          /** The effective ceiling + enforce/observe mode per structure. This is the truth. */
          perStructure,
          observeOnly,
          note: ceilingArmed
            ? `ARMED (demo-only). ENFORCING (rejects the open): ${enforcing.length > 0 ? enforcing.map(describe).join(', ') : 'none'}. OBSERVE-ONLY (counts the breach, ADMITS the open — TRA-1689): ${observeOnly.length > 0 ? perStructure.filter((s) => s.mode === 'observe').map(describe).join(', ') : 'none'}. deltaCeilingRejected>0 per structure is the evidence an ENFORCING ceiling is biting; deltaCeilingObserved>0 is a tail being MEASURED while it still trades. The two are never summed. READ THESE OFF \`retained\`, NOT off \`byStructure\` (TRA-1703): byStructure is scoped to ONE ET day, so a ceiling reject on day 3 of an observe window reads 0 from day 4 on — the tripwire self-clears at midnight. \`retained\` folds every retained ET day (horizon: retained.retentionDays). Ceilings are measured PER SLEEVE (OTM 0.55: n=14 tail, NET −1.813R) — do not extrapolate one sleeve's number onto another; give it its own via the name:value form.`
            : `DISARMED: set ${OPTION_ENTRY_DELTA_CEILING_FLAG}=1 (DATA_DIR/demo-flags.json) to arm on the demo book.`,
        };
      })(),
      ...summarizeCostAwareGate(etDay),
    });
  });

  // TRA-1656 (TRA-1602B) — unauthenticated, secrets-free MEASURED option spread
  // cross, in R units. This probe was built to CHECK the cost-aware bar's spread
  // input, which was a modeled 1.00R the gate's own source comment conceded was
  // "INTERIM (modeled, not measured)" — the DOMINANT term in the then-shipped
  // 1.25R bar, so TRA-1647's "the book cannot cover its cost" was an artifact of
  // it. The check failed the input (measured 0.235R OTM / 0.160R RV, and 1.00R is
  // above both structural ceilings below), and TRA-1661 landed the measurement AS
  // the shipped default. The probe now serves the ongoing job: keep the gate's
  // input honest against the accruing measurement, and re-falsify it if it drifts.
  //
  // Three independent readings, deliberately kept separate:
  //
  //  1. `measured` — the per-fill rollup over journal rows that retain a fill-time
  //     quote. This is the number the ticket asks for. It reads 0 until TRA-1656
  //     rows accrue (see `retention`), and it says so rather than reporting a
  //     falsely-cheap cross computed over rows that never had a quote.
  //  2. `retention` — the honest data statement. Pre-TRA-1656 opens dropped the
  //     scanner's bid/ask AND carried no `optionSymbol`, so the 2,153 historical
  //     closed trades can be neither measured nor joined back to a chain snapshot.
  //     That gap is itself a finding and is reported, not hidden.
  //  3. `ceilings` — the SELECTION-INDEPENDENT bound. The scanners hard-reject any
  //     contract with `spreadPct > maxSpreadPct` (OTM 0.20, RV 0.10) before it can
  //     be picked, and `spreadCrossR = 4 · spreadPct`, so no contract either sleeve
  //     can possibly buy crosses above 0.80R / 0.40R. This holds with ZERO fills and
  //     no distributional assumption — it is what falsified the old 1.00R input at
  //     n=0, and it is the cheapest check on any future retune: a cost input above a
  //     sleeve's ceiling is infeasible by construction, no data required.
  //
  // Observe-only: reading this never routes an order or moves a bar.
  app.get('/api/health/option-spread-cost', async (_req, res) => {
    const dir = process.env.DATA_DIR;
    const env = dir ? resolveDemoFlagEnv(dir) : process.env;
    const config = resolveCostGateConfig(env);

    const rows = await listOptionTradeJournal({ mode: 'demo' });
    const samples: SpreadCostSample[] = [];
    for (const r of rows) {
      if (
        typeof r.entryBid !== 'number'
        || typeof r.entryAsk !== 'number'
        || typeof r.entryMarkUsd !== 'number'
      ) continue;
      samples.push({
        structure: r.structure,
        quote: { bid: r.entryBid, ask: r.entryAsk, mark: r.entryMarkUsd },
        ...(typeof r.contracts === 'number' ? { contracts: r.contracts } : {}),
      });
    }

    const byStructure = summarizeSpreadCost(samples, { safetyMarginR: config.safetyMarginR });
    const rowsWithQuote = samples.length;
    const rowsTotal = rows.length;
    const ACCEPTANCE_N = 50;
    const shortfall = byStructure.filter((s) => s.n < ACCEPTANCE_N).map((s) => s.structure);

    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      demoOnly: true,
      liveCapitalReachable: false,

      // The gate input this probe exists to check. Key kept as `modeledInput` for
      // consumer stability; `source` states its real provenance, which as of
      // TRA-1661 is the measurement below rather than the refuted 1.00R model.
      modeledInput: {
        makerAdjustedSpreadCrossR: config.optionsCost.makerAdjustedSpreadCrossR,
        commissionR: config.optionsCost.commissionR,
        safetyMarginR: config.safetyMarginR,
        barR: admissionBarR('single_leg_otm', config),
        source:
          'MEASURED (TRA-1656 → TRA-1661): shipped default 0.235R = the OTM-sleeve mean cross, applied blended across sleeves (conservative: it overcharges RV by ~0.075R). Overridable via OPTION_COST_GATE_SPREAD_CROSS_R.',
      },

      // (1) The measurement.
      n: rowsWithQuote,
      byStructure,

      // (2) The retention statement — the finding when n is short.
      retention: {
        rowsTotal,
        rowsWithFillTimeQuote: rowsWithQuote,
        rowsWithoutFillTimeQuote: rowsTotal - rowsWithQuote,
        acceptanceN: ACCEPTANCE_N,
        structuresBelowAcceptanceN: shortfall,
        statement:
          rowsWithQuote === 0
            ? 'FILL-TIME QUOTE DATA WAS NOT RETAINED for any existing row. Pre-TRA-1656 opens recorded only `mark` (the scanners computed bid/ask, derived mark = (bid+ask)/2, and dropped the quote), and carried no `optionSymbol` — so historical fills can be neither measured directly nor joined back to a recorded chain snapshot to recover their quotes. TRA-1656 ships the capture; `n` accrues from the first fill after deploy. Until then the SELECTION-INDEPENDENT `ceilings` below are the load-bearing evidence, and they already refute the 1.00R input.'
            : `Measured over ${rowsWithQuote} of ${rowsTotal} demo journal rows that retain a fill-time quote. Rows without a quote DROP OUT (never counted as zero-cost fills), so this mean is not biased toward cheap.`,
      },

      // (3) The selection-independent bound — valid at n = 0.
      ceilings: {
        ...SLEEVE_SPREAD_CEILINGS,
        note:
          'spreadCrossR = (ask − bid) / (0.25 · mark) = 4 · spreadPct, and the scanners reject spreadPct > maxSpreadPct BEFORE selection. So no contract these sleeves can buy crosses above its ceiling — independent of which contracts get picked. The gate charges 1.00R, which is ABOVE both ceilings: it bills every candidate more than the worst contract the scanner is even allowed to admit.',
      },

      // (4) Why deliverable D's slippage ledger could never have supplied the number.
      // `option-cost-gate.ts` names the D ledger as "the real source" for the spread
      // cross — but the demo book prices fills at `mark × (1 + demoSlippagePct)` and
      // `demoSlippagePct` DEFAULTS TO 0, so `entrySlippageUsd = (premiumPaid − mark)`
      // is identically 0 on every demo fill. The ledger is structurally incapable of
      // measuring a non-zero cost under the shipped defaults, which is precisely why
      // the cross was still unmeasured when it became load-bearing. It also means the
      // demo book's realized R is a MID-TO-MID number that pays no spread at all.
      demoCostModel: {
        demoSlippagePct: DEFAULT_ACCOUNT_SETTINGS.demoSlippagePct ?? 0,
        demoFeePerContract: DEFAULT_ACCOUNT_SETTINGS.demoFeePerContract ?? 0,
        slippageLedgerCanMeasureSpread: (DEFAULT_ACCOUNT_SETTINGS.demoSlippagePct ?? 0) > 0,
        note:
          'Demo fills book at mark × (1 + demoSlippagePct); the default is 0, so demo pays NO spread and NO commission. TRA-1600 deliverable D\'s entrySlippageUsd is therefore identically 0 on demo rows — it cannot supply the measured cross the cost gate defers to. Measuring the QUOTE (this probe) is the only route. Corollary: demo realized R is gross of spread, so any bar forward-validated on demo P&L (TRA-1647) is validated on a book that incurs no cost.',
      },

      rBasis:
        'R = entryMark − stopPrice = 0.25 · entryMark (both option sites stop at mark·0.75). NOTE the journal\'s own `realizedR` divides by `atRiskUsd` = the FULL premium, a 4× different unit — `avgSpreadCrossRPremiumBasis` is given per structure so the two are never silently mixed.',
    });
  });

  // TRA-1768 (parent TRA-1318, surfaced by TRA-1729) — unauthenticated, secrets-free
  // EQUITY ENTRY FUNNEL readout. EQUITY_SWING_MODE reports ACTIVE while the demo equity
  // book has held ZERO positions — open or closed — for 8+ days, against 2,192 option
  // rows. Nothing counted the rejections, so `no positions` could not be told apart from
  // `no candidates`. This route splits them:
  //
  //   candidatesEvaluated: 0             ⇒ the signal side is DRY   (a STRATEGY problem)
  //   candidatesEvaluated: N, admitted:0 ⇒ a guardrail ate them all (a CALIBRATION problem)
  //                                        — and `rejectedByReason` names which one.
  //
  // Three-valued, same discipline as TRA-1729: `null` = NO READING, `0` = the pass ran
  // and saw nothing, `>0` = real. A pass held at the four-way pass gate (market closed,
  // halted, auto-trading off, strategies inactive) reports candidatesEvaluated: null and
  // `passGateBlockedReason` — NOT `0`, which would libel the strategy for a shut market.
  //
  // demo and live are reported SEPARATELY and never pooled: the swing sleeve went live on
  // TRA-955/1306 running the SAME entry logic, so `live.funnelStatus` is the one field
  // that can tell a live sleeve holding NO RISK from a healthy sleeve that happens to be
  // flat — states that are otherwise byte-identical on the wire.
  //
  // Pure readout. This ticket added NO book mutation, NO order path, and loosened NO
  // guardrail — counting the rejections is the whole job.
  app.get('/api/health/equity-entry-funnel', (_req, res) => {
    const funnel = summarizeEquityEntryFunnel();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      swingModeEnabled: resolveEquitySwingModeEnabled(process.env),
      demo: funnel.demo,
      live: funnel.live,
      // Load-bearing context for reading `candidatesBySource`: swing mode HARD-NULLS the
      // two intraday churners, so a dry `deterministic` bucket is Ichimoku alone being
      // quiet — not a broken scan.
      intradayChurnersDisabled: resolveEquitySwingModeEnabled(process.env) ? ['orb', 'bbFade_1h'] : [],
      // TRA-1793 — the read rule ABOVE `candidatesEvaluated`. `no_candidates` is itself two
      // states, and they emit the same byte without this: symbolsEvaluated: 0 on an iterated
      // pass means no strategy was EVER RUN (a DATA problem — cold cache, dead feed, empty
      // universe), so the strategy cannot be indicted. Read symbolsEvaluated FIRST.
      symbolReadRule: 'Read symbolsEvaluated BEFORE candidatesEvaluated. symbolsEvaluated > 0 with candidatesEvaluated = 0 ⇒ strategies RAN and were dry (a STRATEGY verdict). symbolsEvaluated = 0 on an ITERATED pass ⇒ NO strategy ever ran — candidatesEvaluated: 0 is then a DATA verdict, not a strategy one, and symbolsSkippedByReason names the cause (insufficient_candles = cold candle cache, stale_feed = TRA-418 dead equity feed during RTH, off_swing_universe = TRA-952, EXPECTED to be large and benign under swing mode: the universe is 21 of N watchlist names). symbolsEvaluated is null — never 0 — on a GATED pass, for the same reason candidatesEvaluated is.',
      note: 'candidatesEvaluated is three-valued: null = no ITERATED pass since boot (says nothing about the signal side), 0 = a pass ran and generated NO candidates (THE ALARM — the strategy is dry, no guardrail can be blamed), >0 = ideas exist. If candidatesEvaluated > 0 and admitted = 0, rejectedByReason names the guardrail eating them. passGateBlockedReason is set when the pass FIRED but never iterated (market closed / halted / auto-trading off) — that is NOT a strategy verdict and candidatesEvaluated stays null. Counters are SINCE-BOOT and in-memory by design: DATA_DIR is ephemeral (TRA-1719), so a durable counter here would be pinned at 0 forever; this instrument needs n=1 and reads correctly on the FIRST tick after a deploy. There is deliberately NO min_holding_days bucket — that guardrail gates discretionary CLOSES, never entries, so the bucket could never increment.',
    });
  });

  // TRA-1300 (parent TRA-1290, board confirmation `38a50f39`) — unauthenticated,
  // secrets-free scale-out (take-profit) ladder readout (parity with /conviction-dca).
  // The overlay is process-global, demo-only, OBSERVE-ONLY (no balances/PII — just
  // the intended-trim rung / fee-aware net proceeds / gainPct per position), so this
  // is unauthenticated. `enabled` mirrors ENABLE_SCALEOUT_LADDER so QuantTrader can
  // see at a glance whether the forward capture is armed; when off the ledger is
  // empty ⇒ an honest zero rather than a 404. Counts are rebuilt from the JSONL under
  // DATA_DIR on boot so trimCount/fullExitCount/positionCount survive the ~daily demo
  // reboot. Always read-only: NO order is ever placed off these trims — the board
  // REJECTED the add-down ladder, and demo→routing graduation is a separate decision.
  //
  // TRA-1729 — it also reports THE OBSERVE PASS, not just the pass's output. `trimCount:0`
  // on its own is what a patient ladder reports AND what a ladder iterating an empty book
  // forever reports; it read the latter for 8 days while the TRA-1318 accrual gate waited
  // on it. `observedPositionCount` / `observeStatus` / `lastObservePassAt` split the two.
  // Still a pure readout — this ticket added NO book mutation and NO order path.
  app.get('/api/health/scaleout-ladder', (_req, res) => {
    const summary = summarizeScaleoutLadder();
    const enabled = isScaleoutLadderEnabled();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      enabled,
      ...summary,
      // The alarm, spelled out so a poller does not have to re-derive it: armed, the
      // pass is running, and it is watching NOTHING ⇒ trimCount can never increment and
      // any accrual gate hanging off it is structurally dead, not "still accruing".
      blind: enabled && summary.observeStatus === 'blind',
      observeNote:
        'observedPositionCount is what the LAST pass actually iterated: null = no pass since boot (says nothing about the book), 0 = it ran and saw an EMPTY book (the alarm — trimCount can never increment), >0 = genuinely watching. maxGainPctObserved is the durable all-time high-water of the favorable excursion (null = never measured, NOT 0); size it against firstRungUp to see how close the ladder has come to firing. The ladder observes the demo EQUITY book only (PaperAccount.openPositions) — it does NOT read the options book, deliberately (TRA-1729: the rungs are underlying-price moves; option premium clears +25% routinely and TRA-1294 already banks profit on that book).',
    });
  });

  // TRA-1294 (parent TRA-1290, board confirmation `73ef18b0`) — unauthenticated,
  // secrets-free readout of whether the take-profit-early auto-close (the PROFIT-
  // side mirror of the give-back cap) is ARMED in this running process. STANDALONE
  // + DEMO-ONLY: decoupled from EXIT_RISK_RULES_ENABLED, and the signal-engine only
  // attaches its capture-fraction on the `mode === 'demo'` options exit branch — so
  // an `enabled:true` here NEVER changes the live options path (bqb1 is the single
  // production instance). We resolve the flag through the SAME path the engine
  // consults (process.env layered with the DATA_DIR demo-flags.json overlay, file
  // wins) so `enabled` reflects the EFFECTIVE switch. No balances/PII — just the
  // flag + capture threshold — parity with the other /api/health/* rule readouts.
  app.get('/api/health/take-profit-early', (_req, res) => {
    const dir = process.env.DATA_DIR;
    const env = dir ? resolveDemoFlagEnv(dir) : process.env;
    const enabled = isTakeProfitEarlyEnabled(env);
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      flag: TAKE_PROFIT_EARLY_FLAG,
      enabled,
      demoOnly: true,
      liveCapitalReachable: false,
      config: { captureFrac: TAKE_PROFIT_EARLY_CAPTURE_PCT },
      note: enabled
        ? 'ARMED (demo-only): banks a demo option position once it captures 60% of available profit / max credit; live options path unchanged.'
        : 'DISARMED: set TAKE_PROFIT_EARLY_ENABLED=true (render.yaml env or DATA_DIR/demo-flags.json) to arm on the demo book.',
    });
  });

  // TRA-1293 (parent TRA-1290, board confirmation `99fbaa0d` = accepted) —
  // unauthenticated, secrets-free readout of whether the PoP / delta entry gate
  // (short-strike |Δ| PoP band + |Δ|/|θ_per_day| ratio floor) is ARMED in this
  // running process. DEMO-ONLY: the signal-engine only consults the gate on the
  // `mode === 'demo'` RV-long entry branch, so an `enabled:true` here can NEVER
  // reject a live option open regardless of the service-wide EXIT_RISK_RULES
  // master — the same containment take-profit-early uses. We resolve the flag
  // through the SAME path the engine consults (process.env layered with the
  // DATA_DIR demo-flags.json overlay, file wins) so `enabled` reflects the
  // EFFECTIVE switch. No balances/PII — just the flag + band/ratio thresholds.
  // TRA-1682 — the readout now also reports what the gate DID (durable per-ET-day
  // admit + reject-by-reason counts), not merely that it is armed. TRA-1677 is the
  // reason: this gate was armed with an ALGEBRAICALLY EMPTY admissible set for a week
  // — it rejected 100% of RV longs — and was invisible, because "gate rejects
  // everything" and "tape offers nothing" produce the same observable (no fills) when
  // nothing counts the admit rate. `starving` (evaluated ≥ 1, admitted 0) is that
  // missing signal, stated out loud. It also makes TRA-1293's own forward-sample of
  // gate 2's rejection rate — the stated pre-live-promotion bar — takeable at last.
  app.get('/api/health/entry-greeks-gate', (_req, res) => {
    const dir = process.env.DATA_DIR;
    const env = dir ? resolveDemoFlagEnv(dir) : process.env;
    const enabled = isEntryGreeksGateEnabled(env);
    const etDay = etDateString(new Date(now()));
    const counts = summarizeEntryGreeksGate(etDay);
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      flag: ENTRY_GREEKS_GATE_FLAG,
      enabled,
      demoOnly: true,
      liveCapitalReachable: false,
      etDay,
      config: {
        // TRA-1677 / TRA-1682 — the band the gate ACTUALLY enforces on the RV long is
        // the selector's own floor ([RV_LONG_DELTA_FLOOR, 1]), passed explicitly at the
        // gate site since `07ea3b1`. This surface used to advertise the library DEFAULT
        // (`ENTRY_SHORT_DELTA_MIN/MAX` = the 0.30–0.40 SHORT-premium PoP band), which
        // after that fix is no longer what runs — an observability endpoint reporting a
        // band the engine does not apply is precisely how the impossible gate stayed
        // hidden. Report the effective one, and keep the short band visible separately
        // as the library default it is.
        deltaBand: [RV_LONG_DELTA_FLOOR, 1],
        deltaThetaRatioFloor: ENTRY_DELTA_THETA_RATIO_FLOOR,
        shortPremiumDefaultBand: [ENTRY_SHORT_DELTA_MIN, ENTRY_SHORT_DELTA_MAX],
      },
      note: enabled
        ? `ARMED (demo-only): rejects a demo RV-long entry whose |Δ| is below the ${RV_LONG_DELTA_FLOOR} selector floor or whose |Δ|/|θ_per_day| is below the ${ENTRY_DELTA_THETA_RATIO_FLOOR} floor (provisional); live options path unchanged.`
        : `DISARMED: set ${ENTRY_GREEKS_GATE_FLAG}=1 (render.yaml env or DATA_DIR/demo-flags.json — allowlisted since TRA-1682) AND the EXIT_RISK_RULES_ENABLED master to arm on the demo book.`,
      ...counts,
      // The loud part. An armed gate that admitted nothing all session is a SUSPECT
      // GATE, not a quiet tape — do not grade the sleeve until this is explained.
      ...(counts.starving
        ? {
            warning: `entry-greeks gate admitted 0 of ${counts.evaluated} candidates on ${etDay} — suspect the GATE, not the tape (TRA-1677: an impossible band reads exactly like no candidates).`,
          }
        : {}),
    });
  });

  // TRA-1301 (parent TRA-1295, Rule 5) — unauthenticated, secrets-free readout of
  // the correlated-exposure cap ("7%" leg of the 3-5-7 governor): the config it
  // enforces (cap %, min-trade-risk floor) + a session-scoped rollup of how often
  // it bound (scaled) or rejected an entry, and which grain bound it. `enabled`
  // mirrors CORRELATED_EXPOSURE_CAP_ENABLED (under EXIT_RISK_RULES_ENABLED) so an
  // operator can see whether the cap is armed before / after the board flip.
  // OBSERVE-ONLY: the ledger is an in-memory diagnostic (session-scoped, reset on
  // reboot); the cap itself scales/rejects at each entry chokepoint. No PII / no
  // balances — just thresholds + binding counts — so this is unauthenticated,
  // parity with the other /api/health/* rule readouts.
  app.get('/api/health/correlated-exposure-cap', (_req, res) => {
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      flag: CORRELATED_EXPOSURE_CAP_FLAG,
      enabled: isCorrelatedExposureCapEnabled(),
      config: {
        capPct: CORRELATED_EXPOSURE_CAP_PCT,
        minTradeRiskPct: CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT,
      },
      ...summarizeCorrelatedExposureBindings(),
    });
  });

  // TRA-1306 (parent TRA-952, sign-off TRA-955) — unauthenticated, secrets-free
  // readout proving the equity swing-trade conversion is EFFECTIVE on this
  // running process. The swing master switch is opt-OUT (default ON) and read
  // only from `process.env.EQUITY_SWING_MODE`; a board GO-LIVE flip means "do NOT
  // set that env to off". But the IaC declaring the default is distinct from the
  // running process's effective value (an out-of-band dashboard `EQUITY_SWING_MODE=off`
  // would silently revert to legacy day-trading), so — mirroring the TRA-1289
  // pattern — this resolves the flag through the SAME helper the router consults
  // (`resolveEquitySwingModeEnabled`) and echoes the RESOLVED universe + guardrail
  // floor. Read-only, no order path, no balances/PII (parity with the other
  // /api/health/* rule readouts). For a REAL-capital flip this is the durable,
  // dashboard-independent proof QuantTrader/the board can re-check any time.
  app.get('/api/health/equity-swing', (_req, res) => {
    const enabled = resolveEquitySwingModeEnabled(process.env);
    const universe = resolveEquitySwingUniverse();
    const universeOverridden =
      universe.length !== EQUITY_SWING_UNIVERSE.length ||
      universe.some((s, i) => s !== EQUITY_SWING_UNIVERSE[i]);
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      flag: 'EQUITY_SWING_MODE',
      // `enabled` reflects the EFFECTIVE opt-out switch, not just the IaC default.
      enabled,
      // The curated liquid universe entries are restricted to when swing mode is
      // on (off-universe thin small-caps are skipped before strategy evaluation).
      universe,
      universeCount: universe.length,
      // false ⇒ the locked TRA-955 default list is in force with no runtime
      // `EQUITY_SWING_UNIVERSE` override — the state the owner signed off.
      universeOverridden,
      // The holding-period guardrail enforced on discretionary equity closes.
      // Risk-driven exits (SL/TP/trailing) bypass this floor and always fire.
      guardrail: {
        blockSameSessionRoundTrip: EQUITY_SWING_GUARDRAIL.blockSameSessionRoundTrip,
        minHoldingTradingDays: EQUITY_SWING_GUARDRAIL.minHoldingTradingDays,
        intradayChurnersDisabled: enabled ? ['orb', 'bbFade_1h'] : [],
      },
      note: enabled
        ? 'ACTIVE: equity entries restricted to the curated liquid swing universe; intraday churners (ORB + 1h BbFade) disabled; discretionary closes honor the ≥2-trading-day floor (hard stops bypass).'
        : 'OPTED OUT: EQUITY_SWING_MODE is off — legacy intraday day-trading behavior is in force. Unset the env (or set true) to restore the swing conversion.',
    });
  });

  // TRA-1289 (parent TRA-1288 → TRA-955/1242) — unauthenticated, secrets-free
  // readout of whether the demo-only, manifest-exempt `sma200_pullback`
  // forward-test fill path is ARMED in this running process. The arm commit set
  // ENABLE_SMA200_DEMO_FORWARD_TEST=true via render.yaml (env), but a Render
  // blueprint env sync is distinct from a code autoDeploy — so without this
  // surface the TRA-1242 accrual monitor (routine c60c98a2) cannot tell "armed,
  // no swing signal yet" from "never armed". We resolve the flag through the
  // SAME path the router consults (process.env layered with the DATA_DIR
  // demo-flags.json overlay, file wins) so `enabled` reflects the EFFECTIVE
  // switch, not just the raw env. Read-only, no order path, demo-only flag —
  // structurally incapable of touching live capital (the live branch stays
  // hard-gated by the empty TRA-817 manifest regardless of this flag).
  app.get('/api/health/sma200-forward-test', (_req, res) => {
    const dir = process.env.DATA_DIR;
    const env = dir ? resolveDemoFlagEnv(dir) : process.env;
    const enabled = isSma200DemoForwardTestEnabled(env);
    // TRA-1289 — fill evidence for the TRA-1242 accrual monitor. Without a
    // countable signal, "armed, no swing yet" is indistinguishable from "a fill
    // landed", so the monitor could never close on first fill. Sourced from the
    // demo fleet's paper books (forwardTestOnly marker = this path's unique
    // fingerprint); demo-money only, no secrets, no live capital.
    const fills = summarizeSma200ForwardTestFills(deps.demoBooks?.() ?? []);
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      flag: SMA200_DEMO_FORWARD_TEST_FLAG,
      enabled,
      // Demo forward-test validates SIGNAL ACCURACY ONLY. Live promotion still
      // requires clearing the OOS keeper gate (TRA-455/817); this flag can never
      // open real capital.
      liveCapitalReachable: false,
      fillCount: fills.fillCount,
      openPositions: fills.openPositions,
      closedCount: fills.closedCount,
      lastFillAt: fills.lastFillAt,
      realizedPnl: fills.realizedPnl,
      note: enabled
        ? 'ARMED: sma200_pullback opens demo-only forward-test (forwardTestOnly) paper fills; live stays hard-gated.'
        : 'DISARMED: sma200_pullback stays display-only in demo. Set ENABLE_SMA200_DEMO_FORWARD_TEST=true (render.yaml env or DATA_DIR/demo-flags.json) to arm.',
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
    // TRA-1591 — optional `?sinceTs=<epoch ms>` scopes the summary fold to the
    // post-arm cohort (entry `openTs >= sinceTs`) so QT can grade the OTM entry
    // delta floor (TRA-1407) in isolation from the historical low-delta bleed.
    // A malformed / non-finite value is ignored → cumulative (unfiltered) output.
    const sinceTsRaw = req.query['sinceTs'];
    const sinceTsParsed = typeof sinceTsRaw === 'string' ? Number(sinceTsRaw) : NaN;
    const sinceTs = Number.isFinite(sinceTsParsed) ? sinceTsParsed : undefined;
    const report = buildOptionJournalReport(
      rows,
      now(),
      isOptionTradeJournalEnabled(),
      cached,
      sinceTs,
    );
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

  // TRA-1601 (TRA-1600 A/telemetry) — maker-fill routing readout. Surfaces the
  // resolved chase ladder (steps / per-step wait / max cross ticks) plus the
  // per-side fill-rate, avg realised-vs-mid, and time-to-fill rollup from the
  // maker-fill ledger. Like /option-journal the ledger carries no balances/PII
  // (just OCC symbols + fill geometry), so this is unauthenticated. `enabled`
  // mirrors ENABLE_OPTION_MAKER_TELEMETRY so the board can see whether capture
  // is armed; served empty (honest zero) when off. Optional `?mode=demo|live`
  // and `?sinceTs=<epoch ms>` scope the fold to a post-arm / per-book cohort.
  app.get('/api/health/option-maker-fills', async (req, res) => {
    const modeRaw = req.query['mode'];
    const mode = modeRaw === 'demo' || modeRaw === 'live' ? modeRaw : undefined;
    const sinceRaw = req.query['sinceTs'];
    const sinceParsed = typeof sinceRaw === 'string' ? Number(sinceRaw) : NaN;
    const sinceTs = Number.isFinite(sinceParsed) ? sinceParsed : undefined;
    const events = await listMakerFillEvents({ mode, sinceTs });
    const enabled = isOptionMakerTelemetryEnabled();
    const ladder = resolveMakerWalkConfig();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      enabled,
      ladder: {
        walkSteps: ladder.fractions,
        stepWaitMs: ladder.stepWaitMs,
        maxCrossTicks: ladder.maxCrossTicks,
        tickSize: ladder.tickSize,
      },
      ...(mode ? { mode } : {}),
      ...(sinceTs !== undefined ? { sinceTs } : {}),
      summary: summarizeMakerFills(events, enabled),
    });
  });

  // TRA-1662 (TRA-1600 A2) — the maker-fill RECOVERY readout. THE number that
  // decides whether the options book is viable: what fraction of the spread a
  // maker chase actually recovers, measured against every attempt rather than
  // only the ones that filled.
  //
  // Carries no balances/PII (OCC symbols + fill geometry), so unauthenticated —
  // same posture as /option-journal and /option-maker-fills. `enabled` mirrors
  // ENABLE_OPTION_MAKER_SHADOW so a reader can see whether capture is armed;
  // served empty (honest zero) when off.
  app.get('/api/health/option-maker-recovery', async (req, res) => {
    const modeRaw = req.query['mode'];
    const mode = modeRaw === 'demo' || modeRaw === 'live' ? modeRaw : undefined;
    const sinceRaw = req.query['sinceTs'];
    const sinceParsed = typeof sinceRaw === 'string' ? Number(sinceRaw) : NaN;
    const sinceTs = Number.isFinite(sinceParsed) ? sinceParsed : undefined;

    const events = await listShadowChases({ mode, sinceTs });
    const stats = summarizeShadowRecovery(events);
    const ladder = resolveMakerWalkConfig();

    // Grade each sleeve against the recovery it must clear to cover its own
    // MEASURED taker cross (TRA-1656). `null` until the sleeve has attempts.
    const verdicts = stats
      .filter((s) => s.side === 'open' && BREAKEVEN_MAKER_RECOVERY[s.structure] !== undefined)
      .map((s) => {
        const breakeven = BREAKEVEN_MAKER_RECOVERY[s.structure] as number;
        const measured = s.avgRecoveryPctAllAttempts;
        return {
          structure: s.structure,
          attempts: s.attempts,
          breakevenRecoveryPct: breakeven,
          // ★ tail-aware expectancy — NOT the fills-only mean.
          measuredRecoveryPctAllAttempts: measured,
          coversItsOwnSpread: measured === null ? null : measured >= breakeven,
        };
      });

    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      enabled: isOptionMakerShadowEnabled(),
      ladder: {
        walkSteps: ladder.fractions,
        stepWaitMs: ladder.stepWaitMs,
        maxCrossTicks: ladder.maxCrossTicks,
        tickSize: ladder.tickSize,
      },
      ...(mode ? { mode } : {}),
      ...(sinceTs !== undefined ? { sinceTs } : {}),
      note:
        'Observe-only shadow of the maker chase each DEMO open did NOT route (demo fills at the mark, paying no spread). ' +
        'recoveryPct = 1 − realizedCross/rawCross vs the decision-time mid. ' +
        'avgRecoveryPctOnFills is SURVIVORSHIP-BIASED (filled chases only) and is NOT the decision number; ' +
        'avgRecoveryPctAllAttempts prices the chase-to-taker tail across every attempt and IS. ' +
        'Fills are counted only when the opposing touch reaches our resting limit, so the fill rate is a LOWER bound.',
      verdicts,
      byStructure: stats,
    });
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
