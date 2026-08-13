// TRA-528 — live reliability + observability HTTP surface + monitor hook.
//
// The route handlers and the background stale-state probe live here, behind a
// dependency-injected `LiveHealthDeps`, rather than inline in `index.ts`. That
// keeps the wiring in `index.ts` to a single `registerLiveHealthRoutes(...)`
// call + one line in the monitor, and lets the whole surface be unit-tested
// with a fake express app and fake user contexts — no live server required.

import { timingSafeEqual } from 'node:crypto';
import type { Express, Response, RequestHandler } from 'express';
import { findMissingLiveCredentials, isStockMarketOpen, DEFAULT_ACCOUNT_SETTINGS, type AccountSettings } from '@trading-app/shared';
import type { DecoupledExitSkipReason, EngineState, ExitCadenceHealth, ExitIntervalBucket, LiveEquityAcceptance, LiveSkipCategory } from '../signal-engine.js';
import { DECOUPLED_EXIT_SKIP_REASONS, EXIT_INTERVAL_BUCKETS, LIVE_SKIP_CATEGORIES, emptyDecoupledExitSkips, emptyExitIntervalHistogram, emptyLiveSkipBreakdown, isLiveBrokerOperator, resolveLiveBrokerOperator, isRvEngineEnabled } from '../signal-engine.js';
import {
  isTestAccount,
  unrecognisedDeskBooks,
  KNOWN_DESK_BOOKS,
  testAccountClassifierIdentity, // TRA-2948 — every class-partitioned figure names its classifier
  type TestAccountClassifierIdentity,
} from '../test-accounts.js'; // TRA-1949, TRA-2524, TRA-2660
import {
  applyModelFacingBasis,
  MODEL_FACING_JOURNAL_BASIS,
} from '../model-facing-journal.js'; // TRA-2214
import { resolveBuildInfo } from './build-info.js';
import { summarizeLiveHealth, summarizeFeed } from './live-health.js';
import { evaluateEnvDrift, loadRenderBlueprint } from './env-drift.js'; // TRA-2209
import { getSeededEnvKeys } from '../demo-flags.js'; // TRA-2209
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
  isOptionIvRvRoutingEnabled, // TRA-2193
  isOptionIvRvScannerEnabled,
  isOptionShortPremiumScannerEnabled,
  isWheelIvEntryFilterEnabled,
  isOptionLiveOtmEnabled,
  isOptionLiveRvLongEnabled,
  isOptionLiveTestWindowOpen,
  isOptionLiveOtmArmed,
  isOptionLiveRvLongArmed,
  parseOptionLiveTestUntil,
  LIVE_OPTION_TEST_NOTIONAL_CAP_USD,
  LIVE_OPTION_TEST_NOTIONAL_CEILING_USD,
  LIVE_OPTION_TEST_NOTIONAL_CAP_VAR,
  LIVE_OPTION_TEST_MAX_CONTRACTS_VAR,
  LIVE_OPTION_TEST_CONTRACTS_HARD_MAX,
  resolveLiveOptionTestNotionalCapUsd,
  resolveLiveOptionTestMaxContracts,
  LIVE_OPTION_TEST_AGGREGATE_CAP_USD, // TRA-3445
  LIVE_OPTION_TEST_AGGREGATE_CEILING_USD,
  LIVE_OPTION_TEST_AGGREGATE_CAP_VAR,
  resolveLiveOptionTestAggregateCapUsd,
  isOptionCostGateLiveEnforceEnabled,
  isOptionLiquidityLiveEnforceEnabled,
  OPTION_COST_GATE_LIVE_ENFORCE_FLAG,
  OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG,
  isOptionOtmDeltaFloorLiveEnforceEnabled, // TRA-2763
  resolveOptionOtmDeltaFloorLive,
  OPTION_OTM_DELTA_FLOOR_LIVE_FLAG,
  OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR,
} from '../option-exec-flag.js';
import { summarizeLiveOptionsFeeSlippage } from '../live-options-fee-slippage-ledger.js'; // TRA-1929
import { getLiveOptionsFeeReconcileState } from '../live-options-fee-reconcile.js'; // TRA-2810
import { summarizeIvRvScans } from '../iv-rv-scanner.js';
import { summarizeRvScanPath, RV_SCAN_PATH_STRUCTURE_LABEL } from '../rv-scan-telemetry.js'; // TRA-2193 / TRA-2245
import { summarizeShortPremiumScans } from '../short-premium-scanner.js';
import { buildWheelPromotionGateSummary } from '../wheel-promotion-gate-store.js'; // TRA-2028
import { isPerpFundingCarryEnabled } from '../perp-funding-carry-flag.js';
import { summarizeFundingCarryScans } from '../perp-funding-carry-scanner.js';
import { isCryptoRegimeEnabled } from '../crypto-regime-flag.js';
import { summarizeCryptoRegimeScans } from '../crypto-regime-scanner.js';
import {
  isRegimeTsmomEnabled,
  isRegimeTsmomDemoRouteEnabled,
  REGIME_TSMOM_OBSERVE_KILLED,
  REGIME_TSMOM_OBSERVE_KILLED_REASON,
} from '../crypto-regime-tsmom-flag.js';
import { summarizeRegimeTsmomScans } from '../crypto-regime-tsmom-scanner.js';
import { summarizeRegimeTsmomDemoRoute } from '../crypto-regime-tsmom-demo-route.js';
import { isCryptoIgnitionEnabled, resolveIgnitionWatchlist } from '../crypto-ignition-flag.js';
import { summarizeIgnitionScans } from '../crypto-ignition-scanner.js';
import {
  summarizeConvictionDca,
  summarizeConvictionDcaGuard,
  resolveConvictionDcaDeployAnchor,
  parseConvictionDcaPaging,
} from '../conviction-dca-ledger.js';
import { summarizeChurnBrake } from '../churn-brake-ledger.js';
import { summarizeDirectionalGate, summarizeDirectionalArm } from '../directional-open-ledger.js';
import { summarizeEntryGreeksGate } from '../entry-greeks-ledger.js';
import { RV_LONG_DELTA_FLOOR } from '@trading-app/engine';
import { summarizeCostAwareGate } from '../cost-aware-gate-ledger.js';
import { summarizeLiveEnforceGate } from '../live-enforce-gate-ledger.js'; // TRA-2048
import {
  summarizeEodArchiveParticipation,
  type EodParticipationSessionAnomaly,
} from '../eod-archive-participation.js'; // TRA-2930 / TRA-3284
import { summarizeLiveNavTripwire } from '../live-nav-tripwire-ledger.js'; // TRA-3449
import type { TapeSummary } from '../denominator-flip-tape-summary.js'; // TRA-3116
import {
  summarizeGiveBackArmFloor,
  type GiveBackArmFloorSummary,
} from '../giveback-arm-floor-ledger.js'; // TRA-1892 / TRA-2220
import { summarizeMarkSanity } from '../option-mark-sanity.js'; // TRA-2927
import { evaluateDurability, type DurabilityReport } from '../durability.js'; // TRA-1681
import { getDiskWatermark, diskReadingAgeSec } from './disk-watermark.js'; // TRA-3011
import { getStateDbStatus } from '../sqlite.js'; // TRA-1681
import {
  isOptionCostAwareGateEnabled,
  resolveCostGateConfig,
  admissionBarR,
  describeCostGateBar, // TRA-3216 — the CONSTANT half of "why did the bar block"
  OPTION_COST_AWARE_GATE_FLAG,
} from '../option-cost-gate.js';
// TRA-3272 — the NET-EDGE cost-bar form's arm description.
import { describeNetEdgeBar } from '../option-net-edge-bar.js';
// TRA-3391 (TRA-3388 Ruling 2) — the tape-calibrated expectancy table that
// REPLACED the delta-proxy estimator, published per cell so the admission
// decision is readable off deployed state instead of re-derived by hand.
import { tapeExpectancyCache } from '../option-tape-expectancy-cache.js';
import { DECLINE_REASON_TAXONOMY, TAPE_EXPECTANCY_MIN_CELL_N } from '../option-tape-expectancy.js';
import {
  isOtmAdmissibleStrikeEnabled,
  resolveAdmissibleBand,
  OTM_ADMISSIBLE_STRIKE_FLAG,
  OTM_ADMISSIBLE_DELTA_MIN_VAR,
  OTM_ADMISSIBLE_DELTA_MAX_VAR,
} from '../otm-admissible-strike.js';
// TRA-3394 (authorization TRA-3392) — the ratified band table and the live arm of
// its UPPER edge. The cost bar is algebraically a floor, so without the ceiling the
// live admitted set exceeds the mandate at the top end.
import {
  mandateCeilingFor,
  mandateFloorFor,
  OTM_SLEEVE_MANDATE_BANDS,
  OTM_SLEEVE_MANDATE_ISSUE,
  OTM_SLEEVE_MANDATE_LABEL,
  OTM_SLEEVE_MANDATE_PROVENANCE,
  OTM_SLEEVE_MANDATE_STRUCTURE,
} from '../otm-sleeve-mandate.js';
import {
  ENTRY_DELTA_CEILING_GATE,
  ENTRY_DELTA_CEILING_REASON_CODE,
  ENTRY_DELTA_CEILING_SHADOW_GATE,
  OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG,
  OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG,
  OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR,
  resolveEntryDeltaCeilingLive,
} from '../option-entry-delta-ceiling-live.js';
// TRA-3216 (parent TRA-2760) — the LIVE OTM underlying allowlist.
import {
  resolveLiveOtmUniverse,
  OPTION_LIVE_OTM_UNIVERSE_VAR,
  OPTION_LIVE_OTM_UNIVERSE_UNRESTRICTED,
} from '../otm-live-universe-flag.js';
import {
  summarizeSpreadCost,
  summarizeSpreadCeilingCompliance, // TRA-2316
  SPREAD_CEILING_ACCOUNT_CLASSES, // TRA-2316
  SLEEVE_SPREAD_CEILINGS,
  isSpreadCeilingEnforceEnabled,
  OPTION_SPREAD_CEILING_ENFORCE_FLAG,
  classifySpreadCeilingAccount, // TRA-2355 — the SINGLE partition rule, shared with the gate ledger
  STOP_DISTANCE_FRACTION_OF_MARK, // TRA-2590 — premium R → gate R is 1/this
} from '../option-spread-cost.js';
import type {
  SpreadCostSample,
  SpreadCeilingSample, // TRA-2316
  SpreadCeilingStat, // TRA-2316
  SpreadCeilingAccountClass, // TRA-2316
} from '../option-spread-cost.js';
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
import {
  isSessionEdgeBlackoutEnabled,
  resolveSessionEdgeBlackoutMinutes,
  SESSION_EDGE_BLACKOUT_FLAG,
} from '../session-edge-blackout-flag.js'; // TRA-2049
// TRA-1001 — since-boot counters for the risk-throttle sizing consumer.
import { snapshotRiskThrottleSizing } from '../risk-throttle-sizing.js';
import { isCorrelatedExposureCapEnabled, CORRELATED_EXPOSURE_CAP_FLAG, isTakeProfitEarlyEnabled, TAKE_PROFIT_EARLY_FLAG, isEntryGreeksGateEnabled, ENTRY_GREEKS_GATE_FLAG, isEntryDeltaCeilingEnabled, resolveEntryDeltaCeiling, resolveEntryDeltaCeilingStructures, resolveEntryDeltaCeilingMap, resolveEntryDeltaCeilingObserveStructures, OPTION_ENTRY_DELTA_CEILING_FLAG, isExitRiskRulesEnabled, EXIT_RISK_RULES_FLAG, isBookGiveBackArmFloorEnabled, BOOK_GIVEBACK_ARM_FLOOR_FLAG, isRvExitRetuneLiveEnabled, RV_EXIT_RETUNE_LIVE_FLAG, RV_EXIT_RETUNE_LIVE_CONFIRM_BARS, RV_EXIT_RETUNE_LIVE_FLIP_MIN_LOSS_PCT, isTakeProfitEarlyLiveEnabled, TAKE_PROFIT_EARLY_LIVE_FLAG, resolveSwingTimeStopTradingDays, OPTION_SWING_TIME_STOP_TRADING_DAYS_VALUE, OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT, resolveOptionsHaltScope, OPTIONS_HALT_SCOPE_VAR, type OptionsHaltScopeResolution } from '../exit-risk-rules-flag.js';
import { summarizeOptionsBreakerLedger } from '../options-breaker-ledger.js'; // TRA-3218
import { summarizeCorrelatedExposureBindings } from '../correlated-exposure-ledger.js';
import { CONVICTION_DCA, CORRELATED_EXPOSURE_CAP_PCT, CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT, TAKE_PROFIT_EARLY_CAPTURE_PCT, ENTRY_SHORT_DELTA_MIN, ENTRY_SHORT_DELTA_MAX, ENTRY_DELTA_THETA_RATIO_FLOOR, resolveEquitySwingModeEnabled, resolveEquitySwingUniverse, EQUITY_SWING_UNIVERSE, EQUITY_SWING_GUARDRAIL } from '@trading-app/shared';
import { resolveDemoFlagEnv, DEMO_FLAG_ALLOWLIST } from '../demo-flags.js';
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
  GATE_R_BASIS_STRUCTURES, // TRA-2590 — which structures have a valid premium→gate R conversion
  type OptionTradeJournalSummary,
  type OptionTradeJournalIntegrity,
  type OptionTradeJournalRecord,
  type OptionTradeJournalExitReasonStat,
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
   * TRA-2200 (parent TRA-2171) — per-engine exit-cadence readout backing the
   * unauthenticated `GET /api/health/exit-cadence`. Secrets-free (flags, counts,
   * intervals). Optional so existing callers/tests keep working; the route is
   * only mounted when this is provided.
   */
  exitCadence?: () => ExitCadenceHealth[];
  /**
   * TRA-3116 — grade every book's `tape/<date>.json` against the pre-registered
   * >=10-RTH-session promotion bar, backing `GET
   * /api/health/denominator-flip-tape`. Injected rather than imported so this
   * module keeps its hands off `getAllUserContexts` / the reports layout.
   * Optional: the route is only mounted when supplied.
   */
  denominatorFlipTape?: () => Promise<TapeSummary>;
  /**
   * TRA-2209 — the engine's EFFECTIVE env view (process.env with the
   * `<DATA_DIR>/demo-flags.json` overlay on top), backing the unauthenticated
   * `GET /api/health/env-drift` comparison. Must be the same view the engine
   * consults, or the check would report an operator's daemon-free flag flip as
   * drift. Resolved per-call so a file flip is picked up on the next probe.
   * Optional: falls back to raw `process.env`, which is correct off Render where
   * no overlay is in play. Values are read for comparison ONLY and never
   * emitted — see the route's redaction note.
   */
  effectiveEnv?: () => NodeJS.ProcessEnv;
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
  /**
   * ⚠ TRA-2650 — RENAMED FROM `demoBooks`, AND THE FILTER MOVED IN HERE.
   *
   * This provider MUST return EVERY engine in the fleet, in EVERY mode, with
   * `email` populated. It used to be `demoBooks`, and the caller in `index.ts`
   * applied `.filter(b => b.mode === 'demo')` and mapped only
   * `{username, state, mode}`. Two live defects fell out of that:
   *
   *  1. the moment the operator armed to `mode:'live'` it was dropped upstream,
   *     so {@link summarizeDemoBooksPublic}'s `role:'operator'` branch became
   *     dead code and the route could not answer "did the operator book
   *     survive?" — while its own doc claimed the operator is never hidden;
   *  2. `email` was never populated, so `isTestAccount(username, env, email)`'s
   *     email branch was dead in production and the documented desk-fold
   *     mechanism (`PATCH /api/admin/users/:username {email}`) moved nothing.
   *
   * Each consumer below narrows to what it actually wants — see
   * {@link demoModeBooks}. Build it with {@link projectFleetBooks} so the
   * production wiring and the regression test share one implementation.
   */
  fleetBooks?: () => Array<{ username: string; state: EngineState; mode: string; email?: string }>;
  /**
   * TRA-2660 — the JOURNAL-ACCOUNT domain: every Option-Trade-Journal row,
   * UNFILTERED BY MODE, so the desk-roster observer reads the population the
   * fold actually partitions instead of the resident in-memory engine map.
   *
   * ⚠ Wire it to a bare `listOptionTradeJournal()`. Adding `{ mode: 'demo' }`
   * here re-creates the narrowing this ticket removed, and would do it
   * invisibly — every unit test below passes either way, because the defect
   * would be in the caller.
   *
   * Optional: when absent both new fields report the `null` sentinel and say so
   * in `deskAccountRosterNote`. They never report `0`.
   */
  journalAccountRows?: () => Promise<
    ReadonlyArray<{ account?: string; openTs?: number; mode?: string }>
  >;
  /**
   * TRA-2660 — admin gate for `GET /api/admin/desk-roster`, which is the only
   * surface that names the unrecognised accounts. Optional; the route is only
   * mounted when this is provided, so no caller gains an unauthenticated
   * identity leak by upgrading.
   */
  requireAdmin?: RequestHandler;
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
  /**
   * TRA-3218 (parent TRA-2760) — inputs for the UNAUTHENTICATED
   * `GET /api/health/options-halt` probe: each engine's
   * `getOptionsHaltState()` snapshot. Exists because a halted day and a quiet
   * day were pixel-identical from outside — the book session-stop latch, its
   * time, the sleeve breaker's state, and the halt SCOPE the option entry
   * gates consult were all readable only from source + env. Booleans / counts /
   * timestamps / book-level P&L marks only — no symbols, order ids, or PII.
   * Enumerates the WHOLE fleet (every engine, both modes), which is what makes
   * "what does a second live book inherit" measurable rather than inferred.
   * Only mounted when provided.
   */
  optionsHalt?: () => Array<OptionsHaltEngineState>;
  /**
   * TRA-3445 — per-book AGGREGATE live-OTM exposure against the board's "$750
   * total" bound, backing the `aggregateExposure` block on
   * `GET /api/health/live-options-fee-slippage`. Wire it to
   * `getAllUserContexts().map(ctx => ctx.engine.getLiveOtmAggregateExposure())`
   * — the WHOLE fleet, both modes, because the per-book scope of the cap means
   * the fleet total is a SUM the reader has to be able to take. Filtering to
   * live here would make a demoted book vanish instead of reading `mode:
   * 'demo'`, and would hide the very rows that make the fleet figure checkable.
   * Optional: absent ⇒ the route serves `aggregateExposure: null`, which says
   * "not wired", never `[]` ("no books").
   */
  liveOtmAggregateExposure?: () => Array<LiveOtmAggregateExposure>;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/** TRA-3445 — one engine's aggregate live-OTM exposure readout. */
export interface LiveOtmAggregateExposure {
  /** `alertUsername`, joining to the journal `account` and the TRA-3117 census. */
  book: string | null;
  /** ENGINE mode. ⚠ NOT the arm — see `liveEntryGateOpen`. */
  mode: 'demo' | 'live';
  /**
   * Can this book actually place a live options order? SUM THE FLEET ON THIS.
   * bqb1 carries three `mode: 'live'` books and only two armed ones, so a
   * `mode`-based sum overstates the fleet worst case by a whole cap.
   */
  liveEntryGateOpen: boolean;
  capUsd: number;
  openPremiumAtRiskUsd: number;
  openRows: number;
  /** > 0 ⇒ the enforced figure is known to UNDERSTATE exposure (see `foldOpenPremiumAtRisk`). */
  unpricedOpenRows: number;
  /** `capUsd − openPremiumAtRiskUsd`, floored at 0; `null` when unreadable. */
  headroomUsd: number | null;
}

/** TRA-3218 — one engine's options-halt readout (see `SignalEngine.getOptionsHaltState`). */
export interface OptionsHaltEngineState {
  engineId: string;
  mode: 'demo' | 'live';
  scope: OptionsHaltScopeResolution;
  exitRiskRulesEnabled: boolean;
  optionExecEnabled: boolean;
  entriesHalted: boolean;
  book: {
    halted: boolean;
    reason: string | null;
    reasonCode: 'giveback_cap' | 'session_net_negative' | null;
    haltAt: number | null;
    peakOpenGain: number;
    retainedFloor: number;
  };
  sleeve: {
    halted: boolean;
    reason: string | null;
    cumulativeR: number;
    dailyPnl: number;
    closes: number;
    day: string;
    haltAt: number | null;
    haltsToday: number;
    releasesToday: number;
    cooldown: {
      minutes: number;
      reArmStepR: number;
      reTripFloorR: number | null;
      reTripFloorPnl: number | null;
    };
  };
  bookHaltGate: { day: string; blocked: number; bypassed: number };
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
  /**
   * TRA-2301 — the cash/equity reconciliation the short-open cash bug broke.
   * `expectedCash` is `totalEquity − Σ(signed cost basis of the open book)`;
   * `gap` is the unexplained residue, which has no legitimate source and must
   * be 0. Reported ALONGSIDE the `repaired` provenance on purpose: a book the
   * one-shot repair fixed and a book that never drifted both show `gap: 0`, so
   * the gap alone cannot tell them apart. `repaired` is null on a book that was
   * never touched.
   *
   * TRA-2671 — that last paragraph described the defect correctly and then left
   * `ok` a flat boolean, so the disclosure was never consumed by the verdict.
   * The two operands of this comparison are JOINED by a repair writer:
   * `PaperAccount.repairDriftedCash()` runs on every restore and executes
   * `this.cash = this.expectedCash()`, which is byte-for-byte the right-hand
   * side of the `gap` this gate grades. After it fires, `gap` is 0 BY
   * CONSTRUCTION for everything up to `repaired.appliedAt` — one operand is a
   * copy of the other.
   *
   * Measured live on bqb1 2026-08-05T10:48Z, build 9fbc9077, book `demo-1`:
   *
   *     cashInvariant.ok        true
   *     cashInvariant.gap       -9.09e-13      ← float residue of an ASSIGNMENT
   *     cashInvariant.repaired  { delta: 3243.54, from: 207.14, to: 3450.67 }
   *
   * A green verdict sitting beside a record that the invariant was off by
   * $3,243.54 and was snapped shut. `gap: -9e-13` is not "this book is
   * consistent", it is the floating-point signature of `cash := expectedCash`.
   *
   * `ok` is therefore TRI-STATE, folded RED > NOT MEASURED > GREEN:
   *
   *   `false` — |gap| over tolerance. New drift accumulated SINCE the repair is
   *             still fully visible, and this red is never masked by the
   *             `null` branch below.
   *   `null`  — NOT MEASURED. A `repaired` record stands, so the writer joined
   *             the operands at `repairedAt` and every disagreement older than
   *             that instant was absorbed rather than reported.
   *   `true`  — genuinely falsifiable: no repair has ever touched this book and
   *             the two independently-maintained ledgers agree.
   *
   * `repairSlaved` is the published denominator — the field an acceptance
   * criterion must read before it consumes a green. Never read a `null` here as
   * a pass.
   */
  cashInvariant: {
    expectedCash: number;
    gap: number;
    ok: boolean | null;
    /**
     * TRA-2671 — true when `repairDriftedCash()` has assigned this book's cash
     * FROM its equity, which is what makes `gap` unfalsifiable for the window
     * ending at `repaired.appliedAt`. This is the denominator for `ok`: a
     * `null` verdict with `repairSlaved: true` means NOT MEASURED, not passed.
     */
    repairSlaved: boolean;
    repaired: { appliedAt: number; delta: number; from: number; to: number } | null;
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
  // TRA-2301 — recompute the cash/equity bridge here rather than trusting a
  // self-reported flag: a long has SPENT its cost basis, a short has RECEIVED
  // it, and demo equity is not marked to market, so this is exact.
  const committedCapital = state.account.openPositions.reduce(
    (sum, p) => sum + (p.side === 'buy' ? 1 : -1) * p.entryPrice * p.quantity,
    0,
  );
  const expectedCash = state.account.totalEquity - committedCapital;
  const cashGap = state.account.availableCash - expectedCash;
  // TRA-2671 — the operands are JOINED once `repairDriftedCash()` has fired:
  // that writer sets `cash = expectedCash()`, which is the same quantity
  // `expectedCash` above recomputes, so `cashGap` is 0 by construction for
  // every event at or before `appliedAt`. Presence of the record — not its
  // sign, not its magnitude — is what destroys the measurement, so any record
  // slaves the gate. `cashRepair` is persisted in the snapshot and restored
  // (`PaperAccount.restore`), so this survives a reboot exactly as the joined
  // cash figure does.
  const cashRepairSlaved = (state.account.cashRepair ?? null) !== null;
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
    cashInvariant: {
      expectedCash,
      gap: cashGap,
      // TRA-2671 — RED outranks NOT MEASURED outranks GREEN. The `false` branch
      // is evaluated FIRST and is deliberately blind to `repairSlaved`: drift
      // that re-opened after the repair means the underlying bug is still
      // writing, and that is the one signal this gate must never swallow.
      ok: Math.abs(cashGap) >= 0.01 ? false : cashRepairSlaved ? null : true,
      repairSlaved: cashRepairSlaved,
      repaired: state.account.cashRepair ?? null,
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

/** TRA-2650 — one fleet book as the health routes consume it. */
export interface FleetBookInput {
  username: string;
  state: EngineState;
  mode: string;
  email?: string;
}

/**
 * TRA-2650 — THE production projection from user contexts to {@link FleetBookInput}.
 *
 * This exists so the wiring in `index.ts` is a single call with no logic of its
 * own, and so the regression test exercises the SAME code the server runs. The
 * defect this closes lived entirely in the caller: a unit test that called
 * {@link summarizeDemoBooksPublic} with a hand-built armed-operator fleet
 * passed while production was broken, because production never handed it one.
 *
 * Two invariants, both load-bearing:
 *  - NO mode filter. Every engine crosses this seam. Consumers narrow.
 *  - `email` IS populated. `isTestAccount`'s email branch is only reachable
 *    from here, and the desk fold is documented as an email move.
 */
export function projectFleetBooks<C extends { username: string; engine: { getState(): EngineState } }>(
  contexts: readonly C[],
  getMode: (username: string) => string,
  getEmail: (username: string) => string | undefined,
): FleetBookInput[] {
  return contexts.map(ctx => {
    const email = getEmail(ctx.username);
    return {
      username: ctx.username,
      state: ctx.engine.getState(),
      mode: getMode(ctx.username),
      // Omit rather than carry `undefined`: `'email' in book` then means what it
      // says on a serialized row (see the `optional?`-field trap, TRA-2598).
      ...(email ? { email } : {}),
    };
  });
}

/**
 * TRA-2650 — narrow the fleet to demo-mode books. The two consumers that are
 * genuinely demo-only ({@link summarizeDemoBooks}'s token-gated fleet read and
 * the sma200 forward-test fill count) call this EXPLICITLY, at the point where
 * the restriction is meaningful, instead of inheriting it invisibly from a
 * provider three files away.
 */
export function demoModeBooks<T extends { mode: string }>(books: readonly T[]): T[] {
  return books.filter(b => b.mode === 'demo');
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
  /** Count of the books actually shown in `books` (visible after the test gate). */
  demoEngineCount: number;
  /**
   * TRA-1949 — QA/test books excluded from the board-facing list this read (0
   * when `?includeTest=1`). NEVER a silent drop: `testBookNote` carries the
   * human-readable "N test books hidden" line whenever this is > 0.
   */
  hiddenTestBookCount: number;
  /** Human note when test books were hidden, else null. */
  testBookNote: string | null;
  /**
   * TRA-2524 — books sitting in the board-facing DESK fold that are neither
   * classified test books nor on `KNOWN_DESK_BOOKS`. THE POINT of this field is
   * that `BUILTIN_TEST_PATTERNS` is a denylist: an unrecognised fixture book
   * contributes P&L that reads as ordinary desk P&L, and until now nothing
   * anywhere said "a book you have never vouched for joined the fold". 0 is the
   * healthy state. Non-zero ⇒ classify it (add a pattern, or add it to the
   * roster) — do not let it accrue into a board number first.
   *
   * Count only, never names: this route is NO-AUTH and anonymizes identity by
   * design (see the TRA-901 note above). The count is the alarm; the names come
   * from the admin surface once you go looking.
   */
  unrecognisedDeskBookCount: number;
  /** Human note when `unrecognisedDeskBookCount > 0`, else null. */
  deskRosterNote: string | null;
  /**
   * TRA-2660 — THE SAME QUESTION OVER THE POPULATION THAT ACTUALLY GETS FOLDED.
   *
   * `unrecognisedDeskBookCount` above is computed over `getAllUserContexts()` —
   * RESIDENT user contexts, an in-memory map wiped on every boot (bqb1 reboots
   * several times a day), narrowed again to `mode === 'demo'`. Live on
   * 2026-07-30 that population held exactly 2 usernames against a journal
   * carrying 2445 rows. The desk fold does not partition user contexts; it
   * partitions journal-row `account` (`health-routes.ts` fixture/desk split,
   * `excludeTestAccountRows`, `option-spread-cost.ts`) — a DURABLE cumulative
   * domain containing every account that ever traded, resident or not,
   * demo-mode or not. So the resident reading was byte-identical in pass and
   * fail state: a throwaway book whose engine is no longer resident scores 0.
   *
   * This field is that count over the journal-account domain. Both fields ship
   * side by side ON PURPOSE — `unrecognisedDeskBookCount` keeps its original
   * meaning (a field whose meaning changes under a stable name is worse than a
   * new field), and the two populations stay visibly different rather than
   * conflated.
   *
   * `null` is the SENTINEL for "the journal could not be read" (provider absent
   * or threw) and is deliberately distinguishable from a genuine `0` — a read
   * failure that reported 0 would be the same silent-healthy defect again.
   * Always projected, never `optional?`: an `undefined` field is dropped by
   * `JSON.stringify`, which reads a fully-patched route as unpatched (TRA-2598).
   *
   * Count only, never names — this route is NO-AUTH. The names live behind
   * `GET /api/admin/desk-roster` (admin auth, GET only).
   */
  unrecognisedDeskAccountCount: number | null;
  /**
   * TRA-2660 — distinct non-blank `account` values in the whole journal domain,
   * the denominator that makes the two populations comparable at a glance
   * (`demoEngineCount` vs this). `null` when the journal could not be read.
   */
  journalAccountCount: number | null;
  /**
   * TRA-2660 — THE COVERAGE OF THE READING ABOVE, on the wire next to it.
   *
   * Measured live 2026-08-05 on `3466624`: **2192 of 2510** journal rows carry
   * NO `account` at all (pre-TRA-1475 / un-owned opens — `account` and the
   * fill-time quote were stamped from the same schema change, and every row
   * since carries both). Those rows cannot be classified by ANY roster, so
   * `unrecognisedDeskAccountCount: 0` is a statement about the 318 rows that
   * CAN be classified and says nothing at all about the other 87%.
   *
   * Publishing the count without its coverage would re-create this ticket's own
   * defect one layer up: a clean-looking 0 whose population is not the
   * population it appears to describe. `null` when the journal is unreadable.
   */
  journalRowsScanned: number | null;
  journalRowsWithoutAccount: number | null;
  /**
   * Human note when `unrecognisedDeskAccountCount > 0`, when the journal is
   * unreadable, OR when unclassifiable rows dominate the domain — the last one
   * is why a green 0 here is not a licence to invert the fold (TRA-2554).
   */
  deskAccountRosterNote: string | null;
  /**
   * TRA-2650 — the MODE-BLIND operator-survival probe.
   *
   * `books[]` below is, and stays, DEMO-ONLY: this route is NO-AUTH, and a book
   * entry carries real equity/cash figures, so the moment the operator arms to
   * `mode:'live'` its book contents must NOT appear here. That is a deliberate
   * bound, not an oversight — but it used to make the operator INVISIBLE rather
   * than REDACTED, and `operator = 0` then read identically for "the armed
   * operator is healthy" and "the operator book is gone". Routine `e8938953`
   * had `operator = 0` wired as a ROLL BACK / file-`critical` trigger, so a
   * healthy armed box scored RED.
   *
   * This block answers "did the operator book survive?" for ANY mode, using
   * counts and mode labels only — never balances.
   */
  operator: {
    /**
     * The ENABLING PRECONDITION, on the wire next to the reading it governs.
     * `resolveLiveBrokerOperator(env)` is non-empty — i.e. some username CAN be
     * the operator. When this is `false` the pin is explicitly cleared (the
     * documented kill-switch) and `engineCount: 0` is a TAUTOLOGY, not a
     * finding: no user can match, so no alarm may be raised off it.
     */
    pinConfigured: boolean;
    /**
     * Operator engines seen in the WHOLE fleet, regardless of mode. This is the
     * survival signal: `pinConfigured && engineCount === 0` is the real
     * "the operator book is gone" state and the only one worth a rollback.
     */
    engineCount: number;
    /**
     * Modes of those engines (e.g. `['live']` for the board-ratified boot-arm,
     * `['demo']` before it arms). Sorted + de-duplicated. Never balances.
     */
    modes: string[];
    /**
     * True when the operator book is also present in `books[]` — i.e. it is in
     * `demo` mode, so publishing its paper figures is safe. False for an armed
     * live operator: present in the fleet, redacted from the list.
     */
    inBooks: boolean;
    /** Human note when the operator is present but redacted, or missing. Else null. */
    note: string | null;
  };
  /**
   * Each book carries a `role` so the board can tell the live/broker operator
   * book (`admin`, `LIVE_EQUITY_BOOT_USER`) apart from true demo peers, and —
   * when `?includeTest=1` — from QA/test books. Labels stay anonymized.
   *
   * DEMO-MODE ONLY (TRA-2650). A live-armed operator is reported in `operator`
   * above, not here; read `operator.inBooks` before concluding anything from
   * the absence of a `role:'operator'` entry.
   */
  books: Array<{ label: string; role: 'demo' | 'operator' | 'test'; book: DemoBookReport }>;
}

/**
 * Anonymized, no-auth fleet demo-book summary. TRA-1949 — the board-facing view
 * must be READABLE, so by default QA/test books (`qa_*` username or `@qa.test`
 * email — see {@link isTestAccount}) are excluded and the operator/live book is
 * labelled distinctly from demo peers (mirrors the desk-calendar `?includeTest`
 * gate). Pass `includeTest: true` to keep every book (test books surface with
 * `role: 'test'`). Usernames stay anonymized to `demo-N` / `operator (live)` /
 * `test-N`; identity is never leaked.
 *
 * ⚠ TRA-2650 — THE CALLER USED TO BREAK THIS FUNCTION'S CONTRACT. This doc
 * previously claimed "the operator book is NEVER hidden — only re-labelled".
 * That was false in the deployed system: `index.ts`'s provider filtered to
 * `mode === 'demo'` BEFORE calling here, so the moment the operator armed to
 * `mode:'live'` the `role:'operator'` branch below became dead code and the
 * book vanished from the route entirely. Every unit test that called this
 * function directly still passed, because the defect was upstream of it.
 *
 * The contract now: `engines` is the WHOLE fleet (every mode, `email`
 * populated). This function owns the demo filter. `books[]` stays demo-only —
 * the route is NO-AUTH and a book carries real equity, which must not leak for
 * a live-armed operator — but {@link DemoBookPublicReport.operator} reports the
 * operator's survival MODE-BLIND, in counts and mode labels only. "Operator
 * absent" and "operator armed live" are now distinct readings.
 */
/**
 * TRA-2660 — one unrecognised journal account, NAMED. Admin surface only; the
 * no-auth route publishes counts off {@link DeskAccountRosterFold} and nothing
 * from here.
 *
 * `rowCount` + `firstOpenTs`/`lastOpenTs` are the fields that tell a live desk
 * book from a fixture that traded three weeks ago and went away — which is the
 * judgement `KNOWN_DESK_BOOKS` has to be designed on (TRA-2554). A bare list of
 * names cannot support it.
 */
export interface JournalAccountStat {
  /** As first seen in the journal (original case preserved). */
  account: string;
  rowCount: number;
  /** ms-epoch of the earliest/latest `openTs` for this account; null if none parsed. */
  firstOpenTs: number | null;
  lastOpenTs: number | null;
  /** Journal `mode` values seen for this account, sorted + de-duplicated. */
  modes: string[];
}

/** TRA-2660 — the journal-account-domain reading behind both new surfaces. */
export interface DeskAccountRosterFold {
  /** Journal rows scanned (the whole domain — never mode-filtered, see below). */
  rowsScanned: number;
  /** Rows carrying no usable `account` (pre-TRA-1475 / un-owned opens). */
  rowsWithoutAccount: number;
  /** Distinct non-blank `account` values, case-insensitively de-duplicated. */
  journalAccountCount: number;
  /** Of those, the ones neither `isTestAccount(...)` nor on `KNOWN_DESK_BOOKS`. */
  unrecognised: JournalAccountStat[];
  /**
   * TRA-2660 — the VOUCHED half, named: accounts on `KNOWN_DESK_BOOKS` that
   * actually carry journal rows. `unrecognised: []` alone cannot tell TRA-2554
   * "the roster is complete" from "the roster names books that never traded",
   * and the roster it has to design is a statement about BOTH halves.
   */
  roster: JournalAccountStat[];
  /**
   * Accounts that are neither on the roster nor unrecognised — i.e. the ones
   * the test patterns claimed. Reported as a COUNT (they are the noise), but it
   * is here so the three classes can be asserted to PARTITION the domain:
   * `roster.length + unrecognised.length + testAccountCount === journalAccountCount`.
   * A silent gap between them would mean an account fell out of the census.
   */
  testAccountCount: number;
}

/**
 * TRA-2660 — the reading, or the reason there isn't one. A failed journal read
 * must NOT collapse to `0`; the whole ticket exists because a zero that means
 * "nothing to see" and a zero that means "I looked at the wrong thing" were
 * indistinguishable on the wire.
 */
export type DeskAccountRosterReading =
  | { ok: true; fold: DeskAccountRosterFold }
  | { ok: false; reason: string };

/**
 * TRA-2660 — fold the JOURNAL-ACCOUNT domain into the desk-roster reading.
 *
 * OBSERVE-ONLY, by explicit ticket boundary: this changes no predicate. It
 * reuses {@link unrecognisedDeskBooks} verbatim (`BUILTIN_TEST_PATTERNS` and
 * `KNOWN_DESK_BOOKS` are untouched), so this is a POPULATION change, not a
 * logic change, and no board-facing number moves in either direction.
 *
 * ⚠ Feed this `listOptionTradeJournal()` UNFILTERED BY MODE — it is the superset
 * of every fold above it. A `{ mode: 'demo' }` read here would re-create the
 * exact narrowing this ticket was filed to remove.
 *
 * Accounts are de-duplicated case-insensitively (matching `unrecognisedDeskBooks`,
 * which compares trimmed + lowercased) but reported in first-seen case.
 */
export function foldDeskAccountRoster(
  rows: ReadonlyArray<{ account?: string; openTs?: number; mode?: string }>,
  env: NodeJS.ProcessEnv = process.env,
): DeskAccountRosterFold {
  const byKey = new Map<string, JournalAccountStat>();
  let rowsWithoutAccount = 0;
  for (const row of rows) {
    const raw = typeof row.account === 'string' ? row.account.trim() : '';
    if (raw.length === 0) {
      rowsWithoutAccount += 1;
      continue;
    }
    const key = raw.toLowerCase();
    let entry = byKey.get(key);
    if (!entry) {
      entry = { account: raw, rowCount: 0, firstOpenTs: null, lastOpenTs: null, modes: [] };
      byKey.set(key, entry);
    }
    entry.rowCount += 1;
    if (typeof row.openTs === 'number' && Number.isFinite(row.openTs)) {
      entry.firstOpenTs = entry.firstOpenTs === null
        ? row.openTs
        : Math.min(entry.firstOpenTs, row.openTs);
      entry.lastOpenTs = entry.lastOpenTs === null
        ? row.openTs
        : Math.max(entry.lastOpenTs, row.openTs);
    }
    if (typeof row.mode === 'string' && row.mode.length > 0 && !entry.modes.includes(row.mode)) {
      entry.modes.push(row.mode);
      entry.modes.sort();
    }
  }
  // THE predicate, reused unchanged — same denylist, same roster allowlist.
  const unrecognisedNames = new Set(
    unrecognisedDeskBooks([...byKey.values()].map(a => a.account), env).map(n => n.toLowerCase()),
  );
  const rosterNames = new Set(KNOWN_DESK_BOOKS.map(n => n.trim().toLowerCase()));
  const byRows = (a: JournalAccountStat, b: JournalAccountStat) =>
    b.rowCount - a.rowCount || a.account.localeCompare(b.account);
  const all = [...byKey.values()];
  const unrecognised = all.filter(a => unrecognisedNames.has(a.account.toLowerCase()));
  const roster = all.filter(a => rosterNames.has(a.account.toLowerCase()));
  return {
    rowsScanned: rows.length,
    rowsWithoutAccount,
    journalAccountCount: byKey.size,
    unrecognised: [...unrecognised].sort(byRows),
    roster: [...roster].sort(byRows),
    // The residual, by construction — so the three classes partition the domain
    // exactly and an account can never fall out of the census unseen.
    testAccountCount: byKey.size - unrecognised.length - roster.length,
  };
}

export function summarizeDemoBooksPublic(
  engines: Array<{ username: string; state: EngineState; mode: string; email?: string }>,
  now: number,
  opts: {
    includeTest?: boolean;
    env?: NodeJS.ProcessEnv;
    /**
     * TRA-2660 — the journal-account-domain reading. Absent is treated as "not
     * wired on this deployment" and reports the `null` sentinel, NOT `0`.
     */
    deskAccounts?: DeskAccountRosterReading;
  } = {},
): DemoBookPublicReport {
  const env = opts.env ?? process.env;
  const includeTest = opts.includeTest === true;
  // TRA-2650 — the operator survival read runs over the FULL fleet, before the
  // demo filter, so arming the operator to `live` cannot zero it.
  const operatorEngines = engines.filter(e => isLiveBrokerOperator(e.username, env));
  const operatorModes = [...new Set(operatorEngines.map(e => e.mode))].sort();
  const operatorPinConfigured = resolveLiveBrokerOperator(env).length > 0;
  const operatorInBooks = operatorEngines.some(e => e.mode === 'demo');
  // Everything below is the board-facing DEMO view. A live book never enters it.
  const demoEngines = engines.filter(e => e.mode === 'demo');
  // Classify BEFORE anonymization — the operator flag and test flag both need
  // the real username/email, which the public shape strips.
  const classified = demoEngines.map(e => ({
    e,
    operator: isLiveBrokerOperator(e.username, env),
    // An operator book is never a "test" book even if its name matched a
    // pattern — the operator wins so it is never hidden.
    test: !isLiveBrokerOperator(e.username, env) && isTestAccount(e.username, env, e.email),
  }));
  const hiddenCount = includeTest ? 0 : classified.filter(c => c.test).length;
  // TRA-2524 — computed over the SAME classification, and independently of
  // `includeTest`: the question "which books are in the desk fold?" has one
  // answer, and a debugging query string must not be able to change it.
  // The operator book is exempt — it is named by `LIVE_EQUITY_BOOT_USER`, i.e.
  // vouched for by an explicit deliberate config act, which is the opposite of
  // the silent drift this counts.
  const unrecognisedDesk = unrecognisedDeskBooks(
    classified.filter(c => !c.operator && !c.test).map(c => c.e.username),
    env,
  );
  // TRA-2660 — the journal-account-domain reading, computed from the SAME
  // predicate and, like the resident one above, entirely independent of
  // `includeTest`: a debugging query string must not change the answer to
  // "which accounts are in the fold?".
  const deskAccounts: DeskAccountRosterReading = opts.deskAccounts ?? {
    ok: false,
    reason: 'no journal-account provider is wired on this deployment',
  };
  const deskAccountFold = deskAccounts.ok ? deskAccounts.fold : null;
  const unrecognisedAccountCount = deskAccountFold ? deskAccountFold.unrecognised.length : null;
  const visible = includeTest ? classified : classified.filter(c => !c.test);
  let demoIdx = 0;
  let opIdx = 0;
  let testIdx = 0;
  const books = visible.map(c => {
    const book = summarizeDemoBook(c.e.state, c.e.mode, now);
    if (c.operator) {
      opIdx += 1;
      return {
        label: opIdx === 1 ? 'operator (live)' : `operator-${opIdx}`,
        role: 'operator' as const,
        book,
      };
    }
    if (c.test) {
      testIdx += 1;
      return { label: `test-${testIdx}`, role: 'test' as const, book };
    }
    demoIdx += 1;
    return { label: `demo-${demoIdx}`, role: 'demo' as const, book };
  });
  return {
    ok: true,
    time: new Date(now).toISOString(),
    build: resolveBuildInfo(),
    demoEngineCount: books.length,
    hiddenTestBookCount: hiddenCount,
    testBookNote: hiddenCount > 0
      ? `${hiddenCount} QA/test book${hiddenCount === 1 ? '' : 's'} hidden `
        + `(pass ?includeTest=1 to show)`
      : null,
    unrecognisedDeskBookCount: unrecognisedDesk.length,
    deskRosterNote: unrecognisedDesk.length > 0
      ? `${unrecognisedDesk.length} book${unrecognisedDesk.length === 1 ? '' : 's'} in the `
        + `board-facing DESK fold ${unrecognisedDesk.length === 1 ? 'is' : 'are'} on neither the `
        + `test-account patterns nor KNOWN_DESK_BOOKS — ${unrecognisedDesk.length === 1 ? 'its' : 'their'} `
        + `P&L is being counted as desk P&L unvouched (TRA-2524)`
      : null,
    // TRA-2660 — projected UNCONDITIONALLY (never `optional?`): `0` must reach
    // the wire as `0`, and an unreadable journal as `null`, never as a missing
    // key that a reader cannot tell from an unpatched build (TRA-2598).
    unrecognisedDeskAccountCount: unrecognisedAccountCount,
    journalAccountCount: deskAccountFold ? deskAccountFold.journalAccountCount : null,
    journalRowsScanned: deskAccountFold ? deskAccountFold.rowsScanned : null,
    journalRowsWithoutAccount: deskAccountFold ? deskAccountFold.rowsWithoutAccount : null,
    deskAccountRosterNote: !deskAccounts.ok
      ? `journal-account desk roster UNREAD (${deskAccounts.reason}) — `
        + `unrecognisedDeskAccountCount is null, NOT 0: nothing was measured (TRA-2660)`
      : unrecognisedAccountCount && unrecognisedAccountCount > 0
        ? `${unrecognisedAccountCount} of ${deskAccountFold?.journalAccountCount ?? 0} distinct `
          + `journal-row account${unrecognisedAccountCount === 1 ? '' : 's'} `
          + `${unrecognisedAccountCount === 1 ? 'is' : 'are'} on neither the test-account `
          + `patterns nor KNOWN_DESK_BOOKS — names are behind GET /api/admin/desk-roster `
          + `(this route is NO-AUTH and never carries identity) (TRA-2660)`
        // A clean 0 over a domain that cannot classify most of its own rows is
        // not a clean bill of health, and must not read as one.
        : deskAccountFold && deskAccountFold.rowsWithoutAccount > deskAccountFold.rowsScanned / 2
          ? `0 unrecognised, but ${deskAccountFold.rowsWithoutAccount} of `
            + `${deskAccountFold.rowsScanned} journal rows carry NO account and are `
            + `UNCLASSIFIABLE by any roster — this 0 describes only the `
            + `${deskAccountFold.rowsScanned - deskAccountFold.rowsWithoutAccount} rows that `
            + `can be classified, and is NOT evidence the fold may be inverted to an `
            + `allowlist (TRA-2660/TRA-2554)`
          : null,
    operator: {
      pinConfigured: operatorPinConfigured,
      engineCount: operatorEngines.length,
      modes: operatorModes,
      inBooks: operatorInBooks,
      note: !operatorPinConfigured
        ? 'LIVE_EQUITY_BOOT_USER resolves empty — the operator pin is cleared, so no user '
          + 'can be the operator and engineCount:0 is a tautology, not a finding (TRA-2650)'
        : operatorEngines.length === 0
          ? 'operator pin is set but NO engine matches it — the operator book is genuinely '
            + 'absent from the fleet (TRA-2650)'
          : !operatorInBooks
            ? `operator book present (mode ${operatorModes.join('/')}) but redacted from `
              + `books[] — this route is NO-AUTH and only demo/paper figures may appear `
              + `here (TRA-2650)`
            : null,
    },
    books,
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
  /**
   * TRA-2193 — the pooled fold, UNCHANGED for back-compat, now carrying a
   * `byAccountClass` partition beside it. The pooled numbers include QA fixture
   * books, which mirror one economic trade into several accounts under distinct
   * `id`s: grade `summary.byAccountClass.desk`, not this. See
   * {@link partitionByAccountClass}.
   */
  summary: OptionTradeJournalSummary & {
    /**
     * TRA-2590 — each class now also carries `byStructureExit`, the
     * (structure × exitReason) cross-tab with a left-tail R histogram whose edges
     * sit exactly on −1.0R and −0.50R. `byStructure` and `byExitReason` are
     * MARGINALS and cannot answer a cell-scoped criterion; `avgR` is a mean and
     * cannot answer a tail COUNT. See {@link OptionJournalStructureExitCrossTab}.
     */
    byAccountClass: {
      fixture: OptionTradeJournalSummary & { byStructureExit: OptionJournalStructureExitCrossTab };
      desk: OptionTradeJournalSummary & { byStructureExit: OptionJournalStructureExitCrossTab };
      unattributed: OptionTradeJournalSummary & {
        byStructureExit: OptionJournalStructureExitCrossTab;
      };
    };
    accountClassCountsSumToRows: boolean;
    accountClassNote: string;
    /**
     * TRA-3381 (TRA-2946) — the MODE partition. `mode` is an execution axis
     * (`live` = real broker fills, `demo` = paper), ORTHOGONAL to
     * `byAccountClass` (which classes the BOOK the row was written from). The
     * board-ratified live swing-exit policy (TRA-2949) carries a pre-registered
     * 30-close grade on TRA-2946 whose cohort is exactly `mode:live` closed
     * rows, and until this partition existed those rows were pooled invisibly —
     * 19 live rows all-time inside a 2700-row demo pool, with no open-endpoint
     * way to read their realized R. See {@link partitionByMode} for why this is
     * a bounded projection rather than a third full summary.
     */
    byMode: {
      live: OptionJournalModeStat;
      demo: OptionJournalModeStat;
    };
    /** The two modes must account for every row — same invariant as the class partition. */
    modeCountsSumToRows: boolean;
    modeNote: string;
    /** TRA-2590 — why the cross-tab is per-class and not on the pooled fold. */
    structureExitNote: string;
    /**
     * TRA-2650 — the partition's BASIS. The `account` string is frozen at write
     * time but its CLASS is recomputed at read time, so a BOOK-level fold moves
     * no row (delta zero by construction ⇒ do not grade a fold on it) while a
     * CLASSIFIER change moves rows retroactively (delta is a real measurement).
     * See {@link partitionByAccountClass}.
     */
    accountAttribution: {
      basis: 'account-string-frozen-at-write, class-recomputed-at-read';
      emailAware: false;
      bookFoldRestatesRows: false;
      classifierChangeRestatesRows: true;
      /**
       * TRA-2948 — the classifier every class-partitioned figure in this payload
       * was computed under. Because `classifierChangeRestatesRows` is true, two
       * reads of this route are comparable ONLY under equal `classifier.hash` —
       * this field makes that checkable at the point of comparison instead of
       * requiring an archaeology of pattern-set commits.
       */
      classifier: TestAccountClassifierIdentity;
      note: string;
    };
  };
  /**
   * TRA-2193 — row counts per account class, hoisted so a consumer reading
   * nothing else still cannot miss that fixture rows are in the pool. The three
   * sum to the filtered row count (asserted via `accountClassCountsSumToRows`).
   * `unattributed` = pre-TRA-1475 rows with no `account`; it is NOT desk.
   */
  fixtureRowCount: number;
  deskRowCount: number;
  unattributedRowCount: number;
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
   * TRA-2214 — the account-class basis `weights` was folded on, stated because it
   * DIFFERS from `summary`'s. `summary` stays pooled (that is the point of this
   * readout — it publishes the TRA-2193 class census over the whole pool), while
   * `weights` is the fold the model actually trains on and is therefore
   * desk+unattributed. Two differently-based numbers in one payload is fine; two
   * differently-based numbers in one payload with only ONE of them labelled is
   * how a grader compares the wrong pair.
   */
  weightsBasis: 'desk+unattributed';
  /**
   * TRA-1591 — echoes the `sinceTs` cohort filter (epoch ms) when the caller
   * passed one, so a grading poll can confirm the `summary` was scoped to the
   * post-arm cohort rather than the cumulative pool. Absent on the unfiltered
   * (cumulative) readout.
   *
   * TRA-3380 — an unparseable value is now a **400**, never a 200. Before this
   * fix `Number('2026-07-24T12:39:00Z')` was `NaN` → the filter was dropped and
   * the route served the FULL pool behind a 200 whose population was identical
   * to the unfiltered one, so *"was my filter applied?"* had no answer on the
   * wire. See {@link parseCohortTsParam}.
   */
  sinceTs?: number;
  /**
   * TRA-2082 — the cohort filter ACTUALLY applied, always present so a consumer
   * asserts what it got instead of assuming its query param took effect.
   * `null` = no filter (cumulative pool); never `0`, which is a real epoch.
   * `filterAxis` names the timestamp the filter compares against — it defaults
   * to `openTs` (ENTRY), and the two axes give different counts on the same book.
   */
  appliedSinceTs: number | null;
  /**
   * TRA-3380 — which timestamp actually served this response.
   *
   * `openTs` is the default and is what an unfiltered readout reports, so the
   * cumulative payload is BYTE-UNCHANGED for every existing consumer. It reads
   * `closeTs` only when the caller passed the EXIT-axis param, and in that case
   * `closedSinceTs`/`appliedClosedSinceTs` are present beside it.
   *
   * WHY THE SECOND AXIS EXISTS. An entry-axis filter cannot scope an
   * exit-scoped criterion: TRA-2213 leg 2 grades closes that ran under the
   * TRA-2200 checkExits hoist, and all four of its `single_leg_otm × sl` closes
   * were OPENED pre-arm and CLOSED post-arm. At `sinceTs=<arm>` the cell is
   * absent entirely (desk cells 14 → 10) — the criterion's own population is
   * empty by construction — while grading the unfiltered cell instead mixes
   * pre-hoist exits into a post-hoist criterion. Both readings are wrong in
   * opposite directions; neither is detectable from the payload.
   */
  filterAxis: 'openTs' | 'closeTs';
  /**
   * TRA-3380 — echo of the EXIT-axis cohort filter (epoch ms). Present only
   * when the caller passed it, so the cumulative and `sinceTs` payloads keep
   * their exact existing shape.
   */
  closedSinceTs?: number;
  /**
   * TRA-3380 — the exit-axis filter actually applied, present only under that
   * axis (same reason as `closedSinceTs`). Rows still OPEN carry no `closeTs`
   * and are therefore EXCLUDED by this axis; `closeAxisExcludesOpenRows` states
   * that on the wire rather than leaving a consumer to infer it from a count.
   */
  appliedClosedSinceTs?: number;
  closeAxisExcludesOpenRows?: true;
  /**
   * TRA-2082 — the `?rows=demo` dump. Present only when rows were requested, and
   * ALWAYS paired with `rowsFiltered` so the two can never be read apart: before
   * this fix `sinceTs` scoped `summary` but not `rows`, so one 200 carried two
   * populations with nothing on the wire marking the difference. Both halves now
   * derive from the same filtered set; `rowsFiltered` states it on the wire.
   */
  rows?: OptionTradeJournalRecord[];
  rowsFiltered?: boolean;
  /**
   * TRA-2082 — the SECOND population axis, surfaced for the same reason as the
   * first. `rows` is demo-and-resolved only; `summary` folds BOTH modes and is
   * not restricted to `mode: 'demo'`. So `rows.length === summary.closed` holds
   * only while the book carries no live/OPEN rows, and a consumer that treats
   * the dump as a row-level expansion of the summary will silently undercount
   * the moment it does. This states the dump's own scope on the wire.
   */
  /**
   * TRA-2193 — the dump's scope, now three-valued.
   *   `demo` — demo + RESOLVED only (the original TRA-1133 dump, unchanged).
   *   `open` — the still-OPEN rows. `summary.open` reported a count with no way
   *            to enumerate what it counted, which left unrealized MTM
   *            unobservable and blocked the mid-vs-bid mark parity work
   *            (TRA-2174 / TRA-2131).
   *   `all`  — every row in the filtered set, open and closed, both modes.
   * `null` when a `rows` value was supplied but not recognised — an unknown mode
   * must not silently degrade to a populated dump of some OTHER population.
   */
  rowsMode?: 'demo' | 'open' | 'all' | null;
  /**
   * TRA-2193 — journal rows carry entry economics, NOT live marks. So `rows=open`
   * enumerates WHICH contracts are open (the thing that was missing) but cannot
   * price them; unrealized MTM still needs a mark source. Stated on the wire so a
   * consumer does not read the absence of a P&L field as a zero.
   */
  rowsCarryMarks?: false;
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
 *
 * TRA-2082 — `includeDemoRows` serves the `?rows=demo` dump from the SAME
 * `sinceTs`-filtered set the summary folds. Previously the route filtered the
 * rows itself and skipped `sinceTs`, so `summary` and `rows` described two
 * different populations in one 200 with nothing distinguishing them — the
 * false-PASS shape (n=1035 all-time reads as the n=10 post-arm cohort). Deriving
 * both from `summaryRows` makes the divergence unrepresentable rather than
 * merely fixed, and `appliedSinceTs`/`filterAxis`/`rowsFiltered` put the applied
 * filter on the wire so a consumer can assert it.
 */
/**
 * TRA-2193 — split journal rows into QA-fixture books, real desk books, and rows
 * that predate account attribution.
 *
 * WHY. The 2026-07-22 session read **+$4,919.50 / avgR +2.7129 / WR 90%** at the
 * top level. Three of those rows — `qa_mirror_1578_38096`, `qa_tra1475_1783821169`,
 * `qa_reg_0710202220` — are the SAME SMCI trail exit mirrored into three fixture
 * books, bit-identical at +$1,600.00 / +8.791R / atRisk $181.9999999999999. Strip
 * the fixtures and the session is **+$119.50 / avgR +0.1079**: a 41× overstatement
 * of realized $ and 25× of avgR, on a number that would clear any forward-validation
 * gate.
 *
 * The rows carry DISTINCT `id`s, so identity de-duplication finds zero duplicates
 * and reports the pool as clean. `account` is the axis that separates them, and it
 * is the only one that does.
 *
 * THREE buckets, not two. Rows written before TRA-1475 carry no `account` at all,
 * and folding those into `desk` would silently re-commit the pooling bug for
 * exactly the historical rows a long-window grade leans on hardest. Unattributable
 * is its own answer — it is not the same claim as "desk".
 *
 * ADDITIVE, not a redefinition of `summary`. Defaulting the top-level fold to
 * desk-only would move a published number under every consumer mid-flight, and a
 * grader watching for drift would read the CORRECTION as a new defect (TRA-2079).
 * The pooled fold stays exactly where it was; the partition sits beside it.
 */
function partitionRowsByAccountClass(rows: OptionTradeJournalRecord[]): {
  fixture: OptionTradeJournalRecord[];
  desk: OptionTradeJournalRecord[];
  unattributed: OptionTradeJournalRecord[];
} {
  const fixture: OptionTradeJournalRecord[] = [];
  const desk: OptionTradeJournalRecord[] = [];
  const unattributed: OptionTradeJournalRecord[] = [];
  for (const r of rows) {
    // TRA-2355 — routed through the SHARED predicate, which is now also what the gate
    // ledger stamps at decision time. This block used to inline the three-way rule, and
    // a second copy of it is precisely what would make this route and
    // `/api/health/cost-aware-gate` — published as independent cross-checks of the same
    // ceiling — disagree for a reason that is not a defect.
    const klass = classifySpreadCeilingAccount(r.account);
    if (klass === 'unattributed') unattributed.push(r);
    else if (klass === 'fixture') fixture.push(r);
    else desk.push(r);
  }
  return { fixture, desk, unattributed };
}

// ── TRA-2590 — the (structure × exitReason) cross-tab with a left-tail R histogram ──
//
// WHY A MARGINAL IS NOT ENOUGH. `byStructure` and `byExitReason` are SEPARATE
// marginals. TRA-2202's invalidation criterion is about a CELL — "`single_leg_otm`
// `sl` exits show zero closes below −0.50R across ≥117 stop exits" — and there is
// no way back to a cell from two marginals. Multiplying them
// (`578 × 1101/2411 ≈ 264` on the 2026-07-30 pool) is an ESTIMATE under an
// independence assumption nobody has tested, and an estimate cannot carry a
// certification. The number was not small, it was UNOBTAINABLE.
//
// WHY A MEAN IS NOT ENOUGH. "Zero closes below −0.50R" is a COUNT IN THE LEFT
// TAIL, and `avgR` cannot answer it at any sample size. The desk `sl` cell read
// `avgR = −0.4991` over n=5 on 2026-07-30 — sitting essentially exactly on the
// threshold, which is precisely the region where the mean is least informative:
// it is equally consistent with "every close at −0.50R" (zero violations) and
// with "half at 0R, half at −1.0R" (many). So the histogram, not another mean.
//
// WHY THE EDGES SIT ON THE THRESHOLDS. Bucket boundaries land EXACTLY on −0.50R
// and −1.0R, the two constants this criterion and TRA-2202 §2's confound test are
// written against, so the counts are exact and need no interpolation — the same
// design that made TRA-2269's `atOrAbove30s` bar readable. `−1.0R` is the
// discriminator TRA-2202 §2 could not run: with the checkExits hoist certified at
// a ≤60s RTH worst case (TRA-2213 leg 1), a post-arm overshoot below −1.0R that
// PERSISTS is a GAP in a thin name, not exit latency — a stop-placement /
// spread-guard problem, and a DIFFERENT fix from TRA-2200.
//
// ⚠ ONE BASIS, STATED ON THE WIRE. These edges are in the journal's own
// PREMIUM R (`realizedPnlUsd / atRiskUsd`, atRisk = full premium). The cost-aware
// gate's R is the STOP DISTANCE = 0.25 × premium, so the two differ by 4×
// (TRA-1656 finding #5). At premium basis −0.50R is TWICE the modeled stop
// distance and −1.0R is a total premium wipeout; read on the gate's basis the
// same edges would mean "half a stop", which is a nonsense invalidation bar. The
// container states `rBasis` and each cell carries `gateRPerPremiumR` (null where
// the structure has no valid conversion — credit spreads and condors do not use
// the `mark·0.75` stop), so nobody can compare the wrong pair.

/** TRA-2590 — one bucket of the left-tail R histogram. Half-open `[fromR, toR)`. */
export interface OptionJournalRBucket {
  /** Printable interval, e.g. `[-1.00,-0.50)`. The label IS the edge convention. */
  label: string;
  /** INCLUSIVE lower edge in premium R; `null` = unbounded below. */
  fromR: number | null;
  /** EXCLUSIVE upper edge in premium R; `null` = unbounded above. */
  toR: number | null;
  count: number;
}

/**
 * TRA-2590 — one (structure × exitReason) cell over RESOLVED rows.
 *
 * `closesBelowMinus050R` is the TRA-2202 criterion's own number: closes with
 * `realizedR < −0.50` (STRICT — a close landing exactly ON −0.50R is compliant,
 * because the criterion says *below*). `closesBelowMinus100R` is likewise strict
 * and is the §2 gap-vs-latency discriminator.
 *
 * `minR` and `leftTailR` exist so the count is AUDITABLE rather than asserted.
 * A stop that fills exactly at its stop price lands on −0.50R to within IEEE
 * rounding, so a reader who cares whether a "violation" is a real overshoot or a
 * float hair can settle it FROM THIS PAYLOAD instead of asking for another
 * deploy. When `minR >= −0.50` the criterion is satisfied with no epsilon
 * question at all — that is the cheapest certification handle here, and it is why
 * `minR` is published even though it is derivable from `leftTailR`.
 *
 * `rUnknown` counts closes carrying NO finite `realizedR`. They are COUNTED, NOT
 * DROPPED (the TRA-2269 `partitionHolds` pattern) and they are deliberately NOT
 * coerced to 0 — the surrounding `avgR` folds do `?? 0`, which would silently
 * file an unmeasured close in the `[0,+inf)` bucket, i.e. as a NON-violation. A
 * left-tail count that quietly rounds unknowns toward "fine" is the exact
 * fail-open this cell exists to close.
 */
export interface OptionJournalStructureExitCell {
  structure: string;
  exitReason: string;
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  scratchRate: number | null;
  winRate: number | null;
  avgR: number | null;
  realizedPnlUsd: number;
  /** Buckets in ascending R order; edges exactly on −1.0 and −0.50. */
  rHistogram: OptionJournalRBucket[];
  /** Closes with `realizedR < −0.50` (strict). The TRA-2202 criterion's count. */
  closesBelowMinus050R: number;
  /** Closes with `realizedR < −1.0` (strict). The TRA-2202 §2 discriminator. */
  closesBelowMinus100R: number;
  /** Closes with no finite `realizedR` — counted, never dropped, never zeroed. */
  rUnknown: number;
  /** `Σ rHistogram.count + rUnknown === closed`. False ⇒ the fold lost a row. */
  histogramSumsToClosed: boolean;
  /** Most negative finite `realizedR` in the cell; null when none measurable. */
  minR: number | null;
  /** Up to 12 most-negative finite `realizedR` values (< 0), ascending. */
  leftTailR: number[];
  /** premium→gate R factor (4) where valid; `null` where no conversion exists. */
  gateRPerPremiumR: number | null;
}

/** TRA-2590 — the cross-tab plus its own residual check. */
export interface OptionJournalStructureExitCrossTab {
  /** Non-empty cells, descending by closed count then |P&L|. */
  cells: OptionJournalStructureExitCell[];
  /** The group's RESOLVED row count, restated so the check is self-contained. */
  closed: number;
  cellsSumToClosed: boolean;
  /** `closed − Σ cells.closed`. Published, not asserted away: a nonzero residual
   *  tells a reader a FILTER dropped rows rather than leaving them to guess
   *  whether they are looking at a filter or a bug. */
  residual: number;
  /** Every cell whose `histogramSumsToClosed` is false, by `structure|exitReason`. */
  histogramMismatchCells: string[];
  rBasis: 'premium';
  note: string;
}

/** Bucket edges in premium R. `null` = unbounded. Ascending, contiguous, total. */
const R_TAIL_BUCKET_EDGES: ReadonlyArray<{ label: string; fromR: number | null; toR: number | null }> = [
  { label: '(-inf,-1.00)', fromR: null, toR: -1.0 },
  { label: '[-1.00,-0.50)', fromR: -1.0, toR: -0.5 },
  { label: '[-0.50,0.00)', fromR: -0.5, toR: 0 },
  { label: '[0.00,+inf)', fromR: 0, toR: null },
];

const LEFT_TAIL_SAMPLE_CAP = 12;

/**
 * TRA-2590 — fold RESOLVED rows into the (structure × exitReason) cross-tab.
 *
 * Keyed the same way the marginals are, so the cells reconcile to them by
 * construction: `structure` verbatim, `exitReason ?? 'unknown'` (an unlabelled
 * close folds under `unknown` rather than being dropped — same rule
 * `byExitReason` already uses, which is what makes the residual meaningful).
 */
function crossTabStructureExit(
  rows: OptionTradeJournalRecord[],
): OptionJournalStructureExitCrossTab {
  const closedRows = rows.filter((r) => r.outcome !== 'OPEN');
  // The two key parts are carried BESIDE the rows, never parsed back out of a
  // joined string. A label containing the separator would otherwise re-split into
  // the wrong pair and silently RELABEL a cell — and a mislabelled cell is the one
  // error this whole cross-tab exists to make impossible.
  const byCell = new Map<
    string,
    { structure: string; exitReason: string; rows: OptionTradeJournalRecord[] }
  >();
  for (const r of closedRows) {
    const structure = r.structure;
    const exitReason = r.exitReason ?? 'unknown';
    const key = JSON.stringify([structure, exitReason]);
    const cell = byCell.get(key) ?? { structure, exitReason, rows: [] };
    cell.rows.push(r);
    byCell.set(key, cell);
  }

  const cells: OptionJournalStructureExitCell[] = [...byCell.values()]
    .map(({ structure, exitReason, rows: list }) => {
      const finiteR = list
        .map((r) => r.realizedR)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const rUnknown = list.length - finiteR.length;
      const rHistogram: OptionJournalRBucket[] = R_TAIL_BUCKET_EDGES.map((b) => ({
        label: b.label,
        fromR: b.fromR,
        toR: b.toR,
        count: finiteR.filter((v) => (b.fromR === null || v >= b.fromR) && (b.toR === null || v < b.toR)).length,
      }));
      const bucketed = rHistogram.reduce((a, b) => a + b.count, 0);
      const ascending = [...finiteR].sort((a, b) => a - b);
      return {
        structure,
        exitReason,
        ...rollupResolvedForCell(list),
        rHistogram,
        // Derived from the SAME finite set the buckets are, so the headline
        // counts and the histogram can never disagree.
        closesBelowMinus050R: finiteR.filter((v) => v < -0.5).length,
        closesBelowMinus100R: finiteR.filter((v) => v < -1.0).length,
        rUnknown,
        histogramSumsToClosed: bucketed + rUnknown === list.length,
        minR: ascending.length > 0 ? (ascending[0] as number) : null,
        leftTailR: ascending.filter((v) => v < 0).slice(0, LEFT_TAIL_SAMPLE_CAP),
        gateRPerPremiumR: GATE_R_BASIS_STRUCTURES.has(structure)
          ? 1 / STOP_DISTANCE_FRACTION_OF_MARK
          : null,
      };
    })
    .sort((a, b) => b.closed - a.closed || Math.abs(b.realizedPnlUsd) - Math.abs(a.realizedPnlUsd));

  const summed = cells.reduce((a, c) => a + c.closed, 0);
  return {
    cells,
    closed: closedRows.length,
    cellsSumToClosed: summed === closedRows.length,
    residual: closedRows.length - summed,
    histogramMismatchCells: cells
      .filter((c) => !c.histogramSumsToClosed)
      .map((c) => `${c.structure}|${c.exitReason}`),
    rBasis: 'premium',
    note:
      'Cells are (structure × exitReason) over RESOLVED rows. R is PREMIUM R '
      + '(realizedPnlUsd / atRiskUsd, atRisk = full premium) — the cost-aware gate\'s R is the '
      + 'STOP DISTANCE = 0.25 × premium, so gateR = 4 × the numbers here wherever '
      + 'gateRPerPremiumR is non-null. Histogram edges sit EXACTLY on -1.00R and -0.50R; '
      + 'closesBelowMinus050R / closesBelowMinus100R are STRICT (< edge), so a close landing ON '
      + '-0.50R is NOT a violation of TRA-2202\'s "zero closes below -0.50R". minR >= -0.50 '
      + 'settles the criterion for this cell with no float-epsilon question at all.',
  };
}

/** TRA-2590 — the WIN/LOSS/SCRATCH/avgR/P&L columns for one cross-tab cell.
 *  Deliberately mirrors `rollupResolved` in option-trade-journal.ts rather than
 *  re-deriving them, so a cell and its marginals cannot drift on how a scratch
 *  rate or an avg-R is computed. `avgR` keeps the surrounding folds' `?? 0`
 *  treatment of a missing R **on purpose** — this column has to stay comparable
 *  to `byExitReason.avgR`; the histogram is where unknowns are handled honestly,
 *  via `rUnknown`. */
function rollupResolvedForCell(resolved: OptionTradeJournalRecord[]): {
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  scratchRate: number | null;
  winRate: number | null;
  avgR: number | null;
  realizedPnlUsd: number;
} {
  const c = resolved.length;
  const win = resolved.filter((r) => r.outcome === 'WIN').length;
  const loss = resolved.filter((r) => r.outcome === 'LOSS').length;
  const scratch = resolved.filter((r) => r.outcome === 'SCRATCH').length;
  return {
    closed: c,
    win,
    loss,
    scratch,
    scratchRate: c > 0 ? scratch / c : null,
    winRate: c > 0 ? win / c : null,
    avgR: c > 0 ? resolved.reduce((a, r) => a + (r.realizedR ?? 0), 0) / c : null,
    realizedPnlUsd: resolved.reduce((a, r) => a + (r.realizedPnlUsd ?? 0), 0),
  };
}

/** TRA-2193 — top-level row counts per account class, plus the sum check. */
function accountClassRowCounts(rows: OptionTradeJournalRecord[]): {
  fixtureRowCount: number;
  deskRowCount: number;
  unattributedRowCount: number;
} {
  const p = partitionRowsByAccountClass(rows);
  return {
    fixtureRowCount: p.fixture.length,
    deskRowCount: p.desk.length,
    unattributedRowCount: p.unattributed.length,
  };
}

/** TRA-2193 — the same fold, run separately over each account class. */
function partitionByAccountClass(rows: OptionTradeJournalRecord[]): {
  byAccountClass: {
    fixture: ReturnType<typeof summarizeOptionTradeJournal> & {
      byStructureExit: OptionJournalStructureExitCrossTab;
    };
    desk: ReturnType<typeof summarizeOptionTradeJournal> & {
      byStructureExit: OptionJournalStructureExitCrossTab;
    };
    unattributed: ReturnType<typeof summarizeOptionTradeJournal> & {
      byStructureExit: OptionJournalStructureExitCrossTab;
    };
  };
  /**
   * The buckets must account for every row. Overshoot means a row landed in two
   * classes, undershoot means one was dropped — either way the partition is not a
   * partition, and publishing it unchecked would just relocate the original bug.
   */
  accountClassCountsSumToRows: boolean;
  accountClassNote: string;
  /**
   * TRA-2590 — states on the wire that the (structure × exitReason) cross-tab is
   * emitted PER ACCOUNT CLASS and deliberately NOT on the pooled `summary`. That
   * is a scoping decision, not an omission: the pooled fold is the one this
   * route's own `accountClassNote` says never to grade, and a fourth copy over
   * the largest population would add the most bytes for the least usable number.
   * Said out loud so a reader can tell a bounded emission from a missing field.
   */
  structureExitNote: string;
  /**
   * TRA-2650 — THE BASIS OF THE PARTITION. TWO AXES, AND THEY BEHAVE OPPOSITELY.
   *
   * A row's `account` STRING is frozen at write time, but its CLASS is computed
   * at READ time by `classifySpreadCeilingAccount(r.account)` → `isTestAccount`
   * (username patterns only — no email argument). Whether a "fold" moves a row
   * therefore depends entirely on WHICH fold you mean, and conflating the two
   * is how TRA-2650 was filed against a working instrument:
   *
   *  - A **BOOK-LEVEL FOLD** — editing the USER RECORD (username roster, or the
   *    documented `PATCH /api/admin/users/:username {email}`) — moves NOTHING
   *    here. The row keeps its frozen string, and the classifier never sees an
   *    email. `Δ` across such a fold IS zero by construction, on a fold that
   *    worked and one that did nothing alike. Grade a book-level fold on the
   *    BOOK axis (`/api/health/demo-book-public`), never on a dollar delta here.
   *
   *  - A **CLASSIFIER CHANGE** — editing `BUILTIN_TEST_PATTERNS` or
   *    `TEST_ACCOUNT_PREFIXES` — DOES move already-written rows, retroactively,
   *    because the same frozen string classifies differently on the new build.
   *    This axis has a real pass AND a real fail state, so a zero delta across
   *    it IS a measurement.
   *
   * WORKED EXAMPLE, and the reason both bullets are spelled out. TRA-2524's
   * `e74b4cf` was a CLASSIFIER change: it added `/^tra\d/i`,
   * `/^(ceo|cto|cfo|qt|leaddev)\d/i` and `/^qtprobe/i`, under which
   * `ceo2251v130001`, `qtprobe3` and `tra2339v66f17374` all move desk→fixture.
   * The paired live read across it (`9e1b1123` pre → `1b803bd8` post, ancestry
   * verified both ways) came back byte-identical — desk 133/128/5,
   * `realizedPnlUsd` 1403.3888175569411, fixture 120/119. Read as axis 1 that
   * looks like a dead instrument; read correctly as axis 2 it is a FINDING:
   * those three books wrote ZERO rows into this journal, so the historical
   * desk-dollar contamination from them is genuinely $0.00.
   *
   * ⚠ The retroactivity in axis 2 cuts both ways: adding a pattern SILENTLY
   * RESTATES every previously published desk number. That is why
   * `test-accounts.test.ts` pins the migration with a positive control — an
   * instrument nobody has seen move is not one you may read a zero off.
   */
  accountAttribution: {
    /** The string is frozen; the CLASS is recomputed per build from it. */
    basis: 'account-string-frozen-at-write, class-recomputed-at-read';
    /** `classifySpreadCeilingAccount` takes no email ⇒ an email fold is invisible here. */
    emailAware: false;
    /** Editing the user record does NOT restate historical rows. */
    bookFoldRestatesRows: false;
    /** Editing the test-account patterns DOES restate them, retroactively. */
    classifierChangeRestatesRows: true;
    /** TRA-2948 — the classifier this partition was computed under. See the interface doc. */
    classifier: TestAccountClassifierIdentity;
    note: string;
  };
} {
  const p = partitionRowsByAccountClass(rows);
  return {
    byAccountClass: {
      // TRA-2590 — the cross-tab is folded PER CLASS off the same row list its
      // marginals are, so `byAccountClass.desk.byStructureExit` is scoped to the
      // population the route's own note says to grade. Folding it once over the
      // pool and slicing later is what produced the marginals problem in the
      // first place.
      fixture: { ...summarizeOptionTradeJournal(p.fixture), byStructureExit: crossTabStructureExit(p.fixture) },
      desk: { ...summarizeOptionTradeJournal(p.desk), byStructureExit: crossTabStructureExit(p.desk) },
      unattributed: {
        ...summarizeOptionTradeJournal(p.unattributed),
        byStructureExit: crossTabStructureExit(p.unattributed),
      },
    },
    accountClassCountsSumToRows:
      p.fixture.length + p.desk.length + p.unattributed.length === rows.length,
    accountClassNote:
      'Top-level `summary` POOLS all three classes and is unchanged for back-compat. '
      + 'Grade on `byAccountClass.desk`. QA fixture books mirror one economic trade into '
      + 'several accounts with DISTINCT ids, so id-dedupe reports 0 duplicates while the '
      + 'pooled realized $ and avgR are inflated (2026-07-22: pooled +$4,919.50/+2.7129R '
      + 'vs desk +$119.50/+0.1079R). `unattributed` = rows written before TRA-1475 added '
      + '`account`; it is NOT desk.',
    structureExitNote:
      'byStructureExit (the structure × exitReason cross-tab + left-tail R histogram, TRA-2590) '
      + 'is emitted under byAccountClass.{fixture,desk,unattributed} and NOT on the pooled '
      + 'summary — by design, because the pooled fold is the one accountClassNote says not to '
      + 'grade. For TRA-2202 read byAccountClass.desk.byStructureExit and find the cell with '
      + 'structure=single_leg_otm, exitReason=sl.',
    accountAttribution: {
      basis: 'account-string-frozen-at-write, class-recomputed-at-read',
      emailAware: false,
      bookFoldRestatesRows: false,
      classifierChangeRestatesRows: true,
      classifier: testAccountClassifierIdentity(),
      note:
        'A row\'s `account` string is frozen at WRITE time; its CLASS is recomputed at READ '
        + 'time by classifySpreadCeilingAccount -> isTestAccount (username patterns only, no '
        + 'email). So TWO different "folds" behave OPPOSITELY here, and conflating them is a '
        + 'known trap (TRA-2650). (1) A BOOK-LEVEL fold — editing the user record, i.e. a '
        + 'username-roster change or PATCH /api/admin/users/:username {email} — moves NO row: '
        + 'delta is zero by construction, on a fold that worked and one that did nothing '
        + 'alike, so grade it on the BOOK axis (/api/health/demo-book-public), never on a '
        + 'dollar delta here. (2) A CLASSIFIER change — editing BUILTIN_TEST_PATTERNS or '
        + 'TEST_ACCOUNT_PREFIXES — DOES move already-written rows RETROACTIVELY, because the '
        + 'same frozen string classifies differently on the new build; that axis has a real '
        + 'pass and fail state and a zero across it IS a measurement. Worked example: '
        + 'TRA-2524\'s e74b4cf was axis (2) and the paired read 9e1b1123 -> 1b803bd8 came '
        + 'back byte-identical, which means the three fixture books wrote ZERO rows here and '
        + 'their desk-dollar contamination is genuinely $0.00. NOTE the retroactivity: '
        + 'adding a pattern silently restates every previously published desk number. '
        + 'TRA-2948 — `classifier` names the pattern set THIS partition was computed under: '
        + 'two desk figures are comparable only under equal classifier.hash, and the '
        + 'decision-time twin of this hash is stamped on every spread decision in '
        + '/api/health/cost-aware-gate (read its classifierProvenance.divergenceDiscriminator '
        + 'to attribute a split between the two ceiling surfaces to a classifier change vs an '
        + 'enforcement failure).',
    },
  };
}

/**
 * TRA-3381 (TRA-2946) — the per-mode grading columns. A bounded PROJECTION of
 * {@link OptionTradeJournalSummary}, not a third full copy: the TRA-2946 grade
 * needs the headline resolved-row columns plus the exit-reason attribution
 * (which exit closed each live trade is the thing the swing-exit policy is
 * being graded ON), while `byStructure`/`byDelta`/`slippage` over n=19 live
 * rows would add the most bytes for the least usable number — the same
 * bounded-emission reasoning as `structureExitNote`. The columns are folded by
 * `summarizeOptionTradeJournal` itself, so a mode cell and the pooled summary
 * can never drift on how a winRate or avgR is computed.
 */
export interface OptionJournalModeStat {
  total: number;
  open: number;
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  winRate: number | null;
  realizedPnlUsd: number;
  avgR: number | null;
  byExitReason: OptionTradeJournalExitReasonStat[];
}

/** TRA-3381 — project the shared fold down to the per-mode grading columns. */
function modeStat(rows: OptionTradeJournalRecord[]): OptionJournalModeStat {
  const s = summarizeOptionTradeJournal(rows);
  return {
    total: s.total,
    open: s.open,
    closed: s.closed,
    win: s.win,
    loss: s.loss,
    scratch: s.scratch,
    winRate: s.winRate,
    realizedPnlUsd: s.realizedPnlUsd,
    avgR: s.avgR,
    byExitReason: s.byExitReason,
  };
}

/**
 * TRA-3381 (TRA-2946) — split the summary fold on the `mode` axis. `mode` is a
 * required `'demo' | 'live'` on every OPEN line, so unlike the account-class
 * partition there is no third "unattributed" bucket — but the sum check is
 * still published because the journal is folded from an append-only JSONL file
 * whose rows are whatever parsed, and a partition that silently drops rows is
 * the TRA-2193 bug relocated, not fixed.
 */
function partitionByMode(rows: OptionTradeJournalRecord[]): {
  byMode: { live: OptionJournalModeStat; demo: OptionJournalModeStat };
  modeCountsSumToRows: boolean;
  modeNote: string;
} {
  const live = rows.filter((r) => r.mode === 'live');
  const demo = rows.filter((r) => r.mode === 'demo');
  return {
    byMode: { live: modeStat(live), demo: modeStat(demo) },
    modeCountsSumToRows: live.length + demo.length === rows.length,
    modeNote:
      'byMode partitions on the EXECUTION mode (live = real broker fills, demo = paper) — '
      + 'orthogonal to byAccountClass, which classes the writing BOOK. The TRA-2946 grade of '
      + 'the live swing-exit policy (TRA-2949) reads byMode.live: closed/avgR/realizedPnlUsd '
      + 'over mode:live resolved rows, with byExitReason attributing each close to the exit '
      + 'that fired. Top-level summary stays POOLED across modes (back-compat, same contract '
      + 'as accountClassNote). Per-trade close economics (closeTs/realizedR/exitReason) are on '
      + 'the ?rows= dump, which serves full journal records for closed rows.',
  };
}

/**
 * TRA-3380 — the epoch-ms window a cohort filter must land in to be believed.
 *
 * FLOOR is what kills the nastier of the two fail-opens. `?sinceTs=1784896740`
 * (epoch SECONDS) is a finite number, so the old `Number.isFinite` check passed
 * it straight through; the filter then resolved to **1970-01-21** and selected
 * every row, while `appliedSinceTs` echoed back a healthy-looking non-null
 * value. The obvious *"did my filter apply?"* assertion therefore PASSED on a
 * completely unfiltered payload — a false green that no amount of care at the
 * call site can detect. Any epoch-ms instant this journal could hold is ≥ 1e12
 * (2001-09-09), and every epoch-SECONDS value for a date this side of 5138 AD
 * is below it, so the two magnitudes cannot overlap.
 */
export const OPTION_JOURNAL_COHORT_TS_MIN_MS = 1_000_000_000_000; // 2001-09-09T01:46:40Z
/** 2100-01-01 — above this the value is not a millisecond instant anyone means. */
export const OPTION_JOURNAL_COHORT_TS_MAX_MS = 4_102_444_800_000;

export type CohortTsParse =
  | { ok: true; value: number | undefined }
  | { ok: false; error: string; detail: string };

/**
 * TRA-3380 — parse a cohort-filter query param, FAILING CLOSED.
 *
 * The rule this encodes: **a filter that cannot be applied must not return a
 * body indistinguishable from one that selects everything.** Before this, three
 * separate classes of bad input (ISO-8601, garbage, epoch-seconds) all produced
 * HTTP 200 with a payload byte-identical in population to the unfiltered one.
 * Two of them echoed `appliedSinceTs: null`, which at least a careful consumer
 * could catch; the third echoed a non-null value and was undetectable.
 *
 * ISO-8601 is rejected rather than parsed on purpose. Accepting it would widen
 * the contract mid-flight, and `Date.parse` is lenient in ways that reintroduce
 * the same silent-wrong-cohort risk (`'2026-07-24'` is UTC midnight but
 * `'2026-07-24T12:39:00'` is LOCAL time — a same-shaped string that silently
 * shifts the cohort by the host's offset). The param stays epoch-ms only; it
 * now just says so instead of pretending it filtered.
 *
 * The error names the legal window and what it thinks you sent, because a 400
 * that self-documents costs the caller one read instead of a probe ladder.
 */
export function parseCohortTsParam(raw: unknown, param: string): CohortTsParse {
  if (raw === undefined) return { ok: true, value: undefined };
  // `?sinceTs=1&sinceTs=2` arrives as an ARRAY. The old `typeof === 'string'`
  // test sent it to NaN → dropped filter → full payload, i.e. the same fail-open
  // wearing a different input shape.
  if (Array.isArray(raw)) {
    return {
      ok: false,
      error: `${param}_repeated`,
      detail: `\`${param}\` was supplied ${raw.length} times. Send it exactly once.`,
    };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: `${param}_invalid`, detail: `\`${param}\` must be a scalar query value.` };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return {
      ok: false,
      error: `${param}_empty`,
      detail: `\`${param}=\` was sent with an empty value. Omit the param entirely for the cumulative (unfiltered) pool.`,
    };
  }
  if (!/^\d+$/.test(trimmed)) {
    const looksIso = /^\d{4}-\d{2}-\d{2}/.test(trimmed);
    return {
      ok: false,
      error: `${param}_not_epoch_ms`,
      detail:
        (looksIso
          ? `\`${param}\` is epoch MILLISECONDS, not ISO-8601. Convert first: Date.parse('${trimmed}') = ${
              Number.isFinite(Date.parse(trimmed)) ? Date.parse(trimmed) : 'unparseable'
            }.`
          : `\`${param}\` must be an integer number of epoch milliseconds.`)
        + ` Received ${JSON.stringify(trimmed)}.`,
    };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    return {
      ok: false,
      error: `${param}_not_epoch_ms`,
      detail: `\`${param}\` exceeds the safe integer range. Received ${JSON.stringify(trimmed)}.`,
    };
  }
  if (value < OPTION_JOURNAL_COHORT_TS_MIN_MS) {
    // The epoch-SECONDS case gets its own sentence with the corrected value,
    // because it is the one that used to succeed and silently select everything.
    const asSeconds = value * 1000;
    const secondsHint =
      asSeconds >= OPTION_JOURNAL_COHORT_TS_MIN_MS && asSeconds <= OPTION_JOURNAL_COHORT_TS_MAX_MS
        ? ` This looks like epoch SECONDS — in milliseconds it is ${asSeconds} (${new Date(asSeconds).toISOString()}). As sent it resolves to ${new Date(value).toISOString()}, which selects the ENTIRE pool.`
        : '';
    return {
      ok: false,
      error: `${param}_below_min`,
      detail: `\`${param}\` must be epoch milliseconds >= ${OPTION_JOURNAL_COHORT_TS_MIN_MS}.${secondsHint}`,
    };
  }
  if (value > OPTION_JOURNAL_COHORT_TS_MAX_MS) {
    return {
      ok: false,
      error: `${param}_above_max`,
      detail: `\`${param}\` must be epoch milliseconds <= ${OPTION_JOURNAL_COHORT_TS_MAX_MS} (2100-01-01).`,
    };
  }
  return { ok: true, value };
}

export function buildOptionJournalReport(
  rows: Parameters<typeof summarizeOptionTradeJournal>[0],
  now: number,
  enabled: boolean,
  cached?: CachedOptionWeights,
  sinceTs?: number,
  // TRA-2193 — widened from the original `includeDemoRows: boolean`. `true` is
  // still accepted and still means `demo`, so every existing caller and test is
  // unchanged; the new modes are additive.
  rowsRequest: boolean | 'demo' | 'open' | 'all' | 'unknown' = false,
  // TRA-3380 — the EXIT-axis cohort filter, added as a SEVENTH positional param
  // so every existing call site keeps its exact meaning. When it is `undefined`
  // (the only thing any pre-existing caller can pass) the fold, the axis label
  // and the payload keys below are all byte-identical to before.
  closedSinceTs?: number,
): OptionJournalReport {
  // TRA-3380 — ONE axis serves a response; the route rejects both params at
  // once, so `filterAxis` is never ambiguous about what it is reporting.
  const closeAxis = closedSinceTs !== undefined;
  const summaryRows = closeAxis
    ? // An OPEN row has no `closeTs`, so it cannot satisfy "closed since T" and
      // is excluded. That is the point of the axis: an exit-scoped criterion's
      // population is the rows that actually CLOSED in the window.
      rows.filter((r) => {
        const closeTs = (r as OptionTradeJournalRecord).closeTs;
        return typeof closeTs === 'number' && closeTs >= closedSinceTs;
      })
    : sinceTs === undefined
      ? rows
      : rows.filter((r) => r.openTs >= sinceTs);
  const rowsMode: 'demo' | 'open' | 'all' | null | undefined =
    rowsRequest === false ? undefined
      : rowsRequest === true || rowsRequest === 'demo' ? 'demo'
        : rowsRequest === 'open' ? 'open'
          : rowsRequest === 'all' ? 'all'
            // An unrecognised `?rows=` value. Emit an EMPTY dump with a null mode
            // rather than falling back to `demo`: silently serving a different
            // population than the one asked for is the TRA-2082 failure shape.
            : null;
  const dumpRows: OptionTradeJournalRecord[] | undefined =
    rowsMode === undefined
      ? undefined
      : rowsMode === 'demo'
        ? (summaryRows as OptionTradeJournalRecord[]).filter(
            (r) => r.mode === 'demo' && r.outcome !== 'OPEN',
          )
        : rowsMode === 'open'
          ? (summaryRows as OptionTradeJournalRecord[]).filter((r) => r.outcome === 'OPEN')
          : rowsMode === 'all'
            ? (summaryRows as OptionTradeJournalRecord[])
            : [];
  return {
    ok: true,
    time: new Date(now).toISOString(),
    build: resolveBuildInfo(),
    enabled,
    shrinkageEnabled: isLearnedShrinkageEnabled(),
    summary: {
      ...summarizeOptionTradeJournal(summaryRows),
      ...partitionByAccountClass(summaryRows as OptionTradeJournalRecord[]),
      // TRA-3381 — the mode partition folds the SAME sinceTs-filtered set as the
      // summary and the class partition; three folds over two populations in one
      // 200 is the TRA-2082 shape.
      ...partitionByMode(summaryRows as OptionTradeJournalRecord[]),
    },
    // TRA-2193 — hoisted to the top level so a consumer that reads nothing else
    // still cannot miss that fixture rows are in the pool.
    ...accountClassRowCounts(summaryRows as OptionTradeJournalRecord[]),
    integrity: getOptionTradeJournalIntegrity(),
    // TRA-2214 — BOTH branches must fold on the same basis. The cached branch is
    // the `OptionWeightsCache`, which is now desk+unattributed; a cold cache used
    // to fall through to a POOLED refold of the same field. One field, two bases,
    // switching on cache warmth, with no tell in the payload — so the fallback is
    // routed through the same predicate. `summary` above stays deliberately POOLED
    // (this is the readout that publishes the TRA-2193 account-class census), which
    // is why `weightsBasis` is stated separately rather than assumed to cover both.
    weights: cached?.weights ?? computeOptionLearnedWeights(applyModelFacingBasis(rows).rows),
    weightsBasis: MODEL_FACING_JOURNAL_BASIS,
    ...(cached ? { weightsFreshness: cached.freshness } : {}),
    ...(sinceTs === undefined ? {} : { sinceTs }),
    appliedSinceTs: sinceTs ?? null,
    // TRA-3380 — `openTs` remains the value on the cumulative and `sinceTs`
    // readouts, so those payloads are byte-unchanged. The new keys below appear
    // ONLY under the exit axis.
    filterAxis: closeAxis ? 'closeTs' : 'openTs',
    ...(closeAxis
      ? {
          closedSinceTs,
          appliedClosedSinceTs: closedSinceTs,
          closeAxisExcludesOpenRows: true as const,
        }
      : {}),
    ...(dumpRows === undefined
      ? {}
      : {
          rows: dumpRows,
          rowsFiltered: sinceTs !== undefined || closeAxis,
          rowsMode,
          // Journal rows are entry economics; they hold no live mark. Say so
          // rather than letting a consumer read a missing field as $0 unrealized.
          rowsCarryMarks: false as const,
        }),
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
    // TRA-1001 — and whether per-trade sizing actually CONSUMES that throttle,
    // with since-boot trim counts so "armed" and "ever ran" stay separable.
    throttleSizing: snapshotRiskThrottleSizing(),
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

/**
 * TRA-2220 — the human-readable headline for `/api/health/giveback-arm-floor`.
 *
 * Ordered by what VOIDS what: recorder darkness first (no measurement is happening at
 * all), then ledger ephemerality (the measurement happens but does not survive a reboot),
 * then the actual counts. A note that leads with "RECOVERABLE: 22 session(s)" while the
 * writer has been gated off for two days is precisely the failure this ticket is about.
 *
 * Exported so the regression test can assert the DARK and CLEAN readouts are
 * distinguishable rather than merely asserting the clean one looks clean.
 */
export function givebackArmFloorNote(summary: GiveBackArmFloorSummary): string {
  const r = summary.recorder;
  if (r.state === 'dark') {
    return `DARK — the give-back recorder is NOT RUNNING. ${r.masterFlag} is off for BOTH books (demo=${r.armedByBook.demo}, live=${r.armedByBook.live}), and the writer sits inside that gate, so NO snapshot has reached this ledger since ${r.lastRecordedSessionDate ?? 'never'}. The ${summary.sessionsObserved} session(s) and every count below are a FROZEN historical artifact, not a current measurement — that is why invalidations serializes as null, not 0. TRA-1592's reopen tripwire ("giveback_halt_sub_floor > 0") CANNOT FIRE in this state: with the floor disarmed no halt can be classified sub-floor. Missing completed trading days since ${r.firstRecordedSessionDate ?? 'n/a'}: ${r.missingTradingDays.length > 0 ? r.missingTradingDays.join(', ') : 'none'}. Fix = restore ${r.masterFlag} on the service (TRA-2195/TRA-2198), then re-grade forward from the first recorded session AFTER the restore.`;
  }
  if (r.state === 'armed_but_stale') {
    return `STALE — ${r.masterFlag} is ON (demo=${r.armedByBook.demo}, live=${r.armedByBook.live}) but the last ${r.staleTradingDays} completed trading day(s) recorded NOTHING (last row: ${r.lastRecordedSessionDate ?? 'never'}). Missing: ${r.missingTradingDays.join(', ')}. This is a suspicion, not a proof — a book that never went green and never halted writes no row by design — but ${r.staleTradingDays} consecutive empty completed session(s) is the frozen-counter signature and must be reconciled against the calendar before any count below is graded.`;
  }
  if (summary.durability.ephemeral) {
    return `NOT RECOVERABLE — DATA_DIR is ephemeral (${summary.durability.dataDir ?? 'memory-only'}), so these ${summary.sessionsObserved} session(s) die at the next reboot just like the in-memory book state. The ≥5-session gate cannot rely on this until DATA_DIR points at a persistent mount (DATA_DIR=/data on bqb1, TRA-1719). Read durability.ephemeral before trusting any count here.`;
  }
  return `RECOVERABLE: ${summary.sessionsObserved} session(s) durable on ${summary.durability.dataDir}, recorder ${r.state} through ${r.lastRecordedSessionDate ?? 'n/a'}. invalidations=${summary.invalidations} (sub-floor-peak give-back halts — a PRIMARY-AC breach if > 0), buckets total ${summary.verdictCountsTotal}/${summary.sessionsObserved}. A missed 21:40Z grade fire is recoverable by re-reading this route any time within ${summary.retentionDays} days.`;
}

/**
 * TRA-3011 — the `/api/health/durability` prose, extracted so the RECOVERED
 * branch can exist at all.
 *
 * The old note had two states, `ok` and not-`ok`. That is one short of what the
 * 2026-07-30 outage needs: a box that filled and was then pruned back is `ok`
 * again, and on every instantaneous field it is byte-identical to a box that was
 * never full. `belowThresholdSeen` is the discriminator, so when it is true and
 * the current reading is clean the note SAYS SO rather than serving the
 * unqualified all-clear — the exact sentence this route published for six days
 * while nothing on the box could write.
 */
export function durabilityNote(report: DurabilityReport): string {
  if (!report.ok) {
    return `NOT DURABLE${report.violations.length > 0 ? ` — broken: ${report.violations.join(', ')}` : ''}${report.unmeasured.length > 0 ? ` — unmeasured (VOIDS a grade, does not stop a boot): ${report.unmeasured.join(', ')}` : ''}. Any multi-session window read off this box is VOID. Policy is '${report.policy}' (set DURABILITY_POLICY=refuse to make a broken guarantee stop the boot).`;
  }
  const d = report.disk;
  if (d && d.belowThresholdSeen) {
    return `DURABLE NOW, BUT ${d.exhaustedSeen ?? 'the disk'} WENT BELOW THE FREE-SPACE THRESHOLD SINCE THIS BOOT (${d.firstBelowAt} → ${d.lastBelowAt}, boot ${d.bootedAt}). Writes in that window may have failed with ENOSPC and been swallowed by their callers' own try/catch, so any ledger, partition or report artifact dated inside it is SUSPECT even though every count now reads clean. Check /api/health/storage/detail for the byte and inode figures.`;
  }
  return 'Durable state is intact: DATA_DIR is on a persistent mount, the hot-state store is open, the journal loaded clean, and the volume has stayed above the free-space threshold on both blocks and inodes for every reading since boot. Counts on this box survive a redeploy.';
}

/**
 * TRA-2269 — the floor on the decoupled timer's share of the GRADED window.
 *
 * `gradeable` used to assert only that the subject RAN (TRA-2257:
 * `decoupledPassCount > 0`). One pass anywhere in the process lifetime flipped
 * it true. This asserts the complementary half — that the subject is what the
 * denominator is MADE OF — so a window whose intervals were mostly closed by
 * doTick cannot be published as a verdict on the hoist.
 *
 * Sized against the floor set by what is NOT being bounded, not picked for
 * roundness: in a healthy armed RTH the timer fires every EXIT_REFRESH_MS (10s)
 * while doTick completes on the order of once per 120-280s (TRA-2171), so the
 * real share sits near 0.95+. A simple majority therefore has ~9x of headroom
 * and only trips when doTick's inline pass has genuinely taken the cadence back
 * — which is the case that must not be graded as the hoist.
 */
export const RTH_DECOUPLED_SHARE_FLOOR = 0.5;

/** TRA-2645 — the two books `/api/health/exit-cadence` grades SEPARATELY. */
export type ExitCadenceBook = 'live' | 'demo';

/**
 * TRA-2645 — one book's verdict.
 *
 * The first three are BLIND states, and blind is NEVER a pass: they say "this
 * payload cannot answer the question for this book", which is a different fact
 * from every verdict below them. `no_engine_in_book` is the load-bearing one —
 * an assertion about the live book is satisfied FOR FREE by a fleet that
 * contains no live book, and that free pass is exactly the defect TRA-2607 was
 * filed on.
 */
export type ExitCadenceBookVerdict =
  | 'no_engine_in_book'
  | 'unreadable_partition'
  | 'unreadable_arm_state'
  | 'disarmed'
  | 'armed_but_no_interval_measured'
  | 'armed_but_no_rth_interval'
  | 'armed_but_no_decoupled_pass'
  | 'tick_dominated_window'
  | 'bounded'
  | 'over_bar';

/** TRA-2269's histogram terms, per book. */
export interface ExitCadenceLifetimeTerms {
  samples: number;
  atOrAbove30s: number;
  p99Under30s: boolean | null;
  intervalHistogram: Record<ExitIntervalBucket, number>;
}

/**
 * TRA-3444 — the EXIT-CRITICAL half of the interlock region: `runEquityExitPass`
 * + `runOptionsExitPass`, bracketed directly with `Date.now()` reads, which is
 * exactly the set of containers the decoupled `refreshExitsOnly` pass re-runs.
 *
 * This is NOT derived from the `signal.doTick` phase tape, and cannot be:
 * `recordPhaseDuration` is a no-op below PHASE_TIMING_SLOW_MS, so that tape is
 * LEFT-CENSORED and an ABSENT phase is byte-identical to a phase that ran on
 * every tick at 999ms. On the 2026-08-12 RTH tape that censoring bounded the
 * PREFIX/RESIDUAL split only to within a factor of 15.6 — no share was
 * publishable in either direction.
 */
export interface ExitCadenceExitWorkTerms {
  /** Regions that committed a measurement. 1:1 with `ExitCadenceTickRegionTerms.samples` on any build carrying this field. */
  samples: number;
  /** Total exit-critical work. Monotonic ⇒ differenceable across a T0/T1 pair. */
  sumMs: number;
  /** Worst single region's exit-critical work. A running MAXIMUM ⇒ NOT differenceable. */
  maxMs: number;
}

/** TRA-2257's suppression-window terms, per book (and fleet-summed at the top level). */
export interface ExitCadenceTickRegionTerms {
  samples: number;
  /**
   * TRA-3444 — total region time over `samples` regions. The DENOMINATOR the
   * split needs: PREFIX (the part a narrowed region would hoist out) is
   * `sumMs - exitWorkMs.sumMs`, exactly, with no threshold anywhere in it.
   */
  sumMs: number;
  maxMs: number | null;
  atOrAbove20s: number;
  atOrAbove30s: number;
  /**
   * TRA-3444 — NULL until at least one engine in this population has closed a
   * region. Never a zero-filled object: a zero would be a claim about a
   * measurement not taken, and telling "absent" from "zero" is this field's
   * entire purpose (TRA-1707 null discipline).
   */
  exitWorkMs: ExitCadenceExitWorkTerms | null;
}

/**
 * TRA-2645 — ONE BOOK's exit-cadence rollup. This is the unit that can be
 * graded: `mode=live` engines share a broker, capital and flag source with each
 * other and with NOTHING in the demo fleet (`signal-engine.ts` resolves
 * `ENABLE_DECOUPLED_EXIT_CADENCE` through a deliberate per-book split), so a
 * ratio pooled across the two is a statement about no population that exists.
 *
 * Every graded field is nullable and is NULL exactly when `blind` is true. A
 * blind book publishes counts it can still stand behind and nulls the rest —
 * it never publishes a zero that reads like a measurement.
 */
export interface ExitCadenceBookRollup {
  book: ExitCadenceBook;
  /** TRUE when this payload cannot answer the question for this book. Never a pass. */
  blind: boolean;
  /** Why, when blind. Null otherwise. */
  blindReason: string | null;
  /** At least one engine IN THIS BOOK has a live exit timer. NULL when blind. */
  enabled: boolean | null;
  engineCount: number;
  armedEngineCount: number | null;
  verdict: ExitCadenceBookVerdict;
  gradeable: boolean;
  notGradeableReason: string | null;
  /** GRADED (RTH-only) terms — TRA-2200's invalidation criterion, scoped to THIS book. */
  samples: number | null;
  atOrAbove30s: number | null;
  p99Under30s: boolean | null;
  intervalHistogram: Record<ExitIntervalBucket, number> | null;
  rthDecoupledPassCount: number | null;
  rthTickPassCount: number | null;
  rthDecoupledShare: number | null;
  rthBoundaryIntervals: number | null;
  rthClosedIntervals: number | null;
  partitionHolds: boolean | null;
  maxExitIntervalMs: number | null;
  lifetime: ExitCadenceLifetimeTerms | null;
  decoupledPassCount: number | null;
  tickPassCount: number | null;
  decoupledFireCount: number | null;
  decoupledSkips: Record<DecoupledExitSkipReason, number> | null;
  tickExitRegionMs: ExitCadenceTickRegionTerms | null;
}

/**
 * TRA-2645 — the payload `GET /api/health/exit-cadence` publishes above the
 * per-engine `engines` array.
 *
 * A CONCRETE type on purpose. This used to be `Record<string, unknown>`, which
 * is why removing `enabled` could not be checked: `tsc` enumerates the
 * consumers of a named field and enumerates nothing at all on an index
 * signature.
 */
export interface ExitCadenceRollup {
  /** TRA-2269 — which WINDOW the graded fields are computed over. */
  window: 'rth';
  /**
   * TRA-2645 — which AXIS the population is partitioned on. Absent on any build
   * before TRA-2645, where every graded field was pooled across books; a reader
   * that wants a per-book number must FAIL CLOSED on its absence rather than
   * read the pooled one.
   */
  partitionedBy: 'mode';
  books: Record<ExitCadenceBook, ExitCadenceBookRollup>;
  /**
   * TRA-2645 — what used to be the bare `enabled`, split and SCOPED. The old
   * field was `armed.length > 0` over every engine, so 57 armed demo engines
   * published `enabled: true` over an unhoisted live book. There is no
   * unscoped spelling any more, deliberately: the name now carries the
   * population, so a reader who greps one cannot get the other's answer.
   * NULL when that book is blind — absent an answer, not a false one.
   */
  liveEnabled: boolean | null;
  demoEnabled: boolean | null;
  liveArmedEngineCount: number | null;
  demoArmedEngineCount: number | null;
  engineCount: number;
  liveEngineCount: number;
  demoEngineCount: number;
  /**
   * Engines whose `mode` is not a usable string. NOT filed as demo: an engine
   * of unknown book might BE the live one, so a non-zero count here blinds
   * BOTH books rather than silently shrinking either population.
   */
  unknownModeEngineCount: number;
  /**
   * TRA-2645 — the AGGREGATE REFUSES. There is no fleet-wide grade because
   * there is no fleet-wide population: `p99Under30s` is TRA-2200's REAL-MONEY
   * invalidation criterion and a demo engine cannot contribute evidence to it.
   * Constant by construction so it cannot drift into looking like a verdict.
   */
  verdict: 'partitioned_by_book';
  gradeable: false;
  notGradeableReason: string;
  /** Fleet high-water mark. A max is not a ratio and does not dilute; per-book copies sit in `books`. */
  maxExitIntervalMs: number | null;
  /**
   * TRA-2257 — LIFETIME cadence counters, fleet-summed. Descriptive totals, not
   * a graded ratio: they answer "is the exit path evaluating at all". The
   * per-book copies in `books` are the ones to quote about a book.
   */
  decoupledPassCount: number;
  tickPassCount: number;
  decoupledFireCount: number;
  decoupledSkips: Record<DecoupledExitSkipReason, number>;
  /**
   * doTick's exit-interlock suppression window, FLEET-SUMMED over every engine
   * with no RTH predicate and no boot guard. Left fleet-scoped deliberately —
   * TRA-2305/TRA-2268 grade this exact accumulator and moving it would silently
   * change someone else's subject. Per-book copies are in `books`.
   */
  tickExitRegionMs: ExitCadenceTickRegionTerms;
  rthDecoupledShareFloor: number;
  note: string;
}

/**
 * Read an engine's book DEFENSIVELY. `ExitCadenceHealth['mode']` is typed
 * `'demo' | 'live'`, but this route is unauthenticated and read by scripts that
 * cannot see which bytes answered them, and the value crosses a JSON boundary
 * on the way out. `'mode' in e` passes on an explicit `null`, so a presence
 * check would file an engine of UNKNOWN book as demo — this ticket's own defect
 * re-entered one field down. Demand a non-empty STRING; anything else is `null`
 * and blinds both books.
 */
function bookOf(e: ExitCadenceHealth): ExitCadenceBook | null {
  const mode: unknown = (e as { mode?: unknown }).mode;
  if (mode === 'live') return 'live';
  return typeof mode === 'string' && mode.length > 0 ? 'demo' : null;
}

/** Likewise: a null/absent `timerArmed` is "I cannot see it", never "not armed". */
function armedOf(e: ExitCadenceHealth): boolean | null {
  const armed: unknown = (e as { timerArmed?: unknown }).timerArmed;
  return typeof armed === 'boolean' ? armed : null;
}

const sumExitHistogram = (
  engines: ExitCadenceHealth[],
  pick: (e: ExitCadenceHealth) => Record<ExitIntervalBucket, number>,
) =>
  engines.reduce<Record<ExitIntervalBucket, number>>((acc, e) => {
    const h = pick(e);
    for (const b of EXIT_INTERVAL_BUCKETS) acc[b] += h[b];
    return acc;
  }, emptyExitIntervalHistogram());

const totalOfExitHistogram = (h: Record<ExitIntervalBucket, number>) =>
  EXIT_INTERVAL_BUCKETS.reduce((n, b) => n + h[b], 0);

// The 30s bar sits on a bucket EDGE (`bucketExitInterval(30_000) === 'lt60s'`),
// so summing the four buckets at or past it IS the at-or-above-30s count.
const atOrAbove30sOfExitHistogram = (h: Record<ExitIntervalBucket, number>) =>
  h.lt60s + h.lt120s + h.lt300s + h.gte300s;

/**
 * TRA-3444 — sum the exit-critical terms over a population, preserving the
 * absent/zero distinction.
 *
 * Engines that have not closed a region yet publish `null` and are DROPPED from
 * the sum rather than folded in as zeroes: a fleet where one engine has taken
 * 900 regions and the rest booted a second ago must not read as "the other 57
 * did no exit work". If NO engine can answer, the population cannot answer, and
 * the result is `null` — never a zero-filled object.
 */
function sumTickExitWork(engines: ExitCadenceHealth[]): ExitCadenceExitWorkTerms | null {
  const terms = engines
    .map((e) => e.tickExitRegionMs.exitWorkMs)
    .filter((w): w is ExitCadenceExitWorkTerms => w != null);
  if (terms.length === 0) return null;
  return {
    samples: terms.reduce((n, w) => n + w.samples, 0),
    sumMs: terms.reduce((n, w) => n + w.sumMs, 0),
    maxMs: terms.reduce((m, w) => (w.maxMs > m ? w.maxMs : m), 0),
  };
}

function sumTickExitRegion(engines: ExitCadenceHealth[]): ExitCadenceTickRegionTerms {
  return {
    samples: engines.reduce((n, e) => n + e.tickExitRegionMs.samples, 0),
    sumMs: engines.reduce((n, e) => n + e.tickExitRegionMs.sumMs, 0),
    maxMs: engines.reduce<number | null>(
      (acc, e) => (e.tickExitRegionMs.maxMs != null && (acc == null || e.tickExitRegionMs.maxMs > acc)
        ? e.tickExitRegionMs.maxMs
        : acc),
      null,
    ),
    atOrAbove20s: engines.reduce((n, e) => n + e.tickExitRegionMs.atOrAbove20s, 0),
    atOrAbove30s: engines.reduce((n, e) => n + e.tickExitRegionMs.atOrAbove30s, 0),
    exitWorkMs: sumTickExitWork(engines),
  };
}

/** A book that cannot be graded. Every graded term is NULL, never 0 — a zero reads like a measurement. */
function blindBook(
  book: ExitCadenceBook,
  engineCount: number,
  verdict: 'no_engine_in_book' | 'unreadable_partition' | 'unreadable_arm_state',
  reason: string,
): ExitCadenceBookRollup {
  return {
    book,
    blind: true,
    blindReason: reason,
    enabled: null,
    engineCount,
    armedEngineCount: null,
    verdict,
    gradeable: false,
    notGradeableReason: reason,
    samples: null,
    atOrAbove30s: null,
    p99Under30s: null,
    intervalHistogram: null,
    rthDecoupledPassCount: null,
    rthTickPassCount: null,
    rthDecoupledShare: null,
    rthBoundaryIntervals: null,
    rthClosedIntervals: null,
    partitionHolds: null,
    maxExitIntervalMs: null,
    lifetime: null,
    decoupledPassCount: null,
    tickPassCount: null,
    decoupledFireCount: null,
    decoupledSkips: null,
    tickExitRegionMs: null,
  };
}

/**
 * TRA-2269 + TRA-2645 — grade ONE book.
 *
 * TRA-2269 scoped `samples` / `atOrAbove30s` / `p99Under30s` / `verdict` to the
 * RTH WINDOW: they used to be computed over the whole process lifetime, which
 * on any normal Monday mixes in hours of closed-market intervals that sit dead
 * on the 30s bar — ~21.7 min of closed-market uptime was enough to force a
 * FALSE however well the hoist performed. The lifetime numbers are still
 * published, under `lifetime`, because they are the right population for "is
 * the exit path evaluating at all" — just not for grading the hoist.
 *
 * TRA-2645 scopes the same terms to the BOOK, which is the other axis the
 * denominator was wrong on. Both are the same defect: an instrument that cannot
 * say "that was not my subject" hands out confident answers to questions it
 * never asked.
 */
export function gradeExitCadenceBook(
  book: ExitCadenceBook,
  engines: ExitCadenceHealth[],
  unknownModeEngineCount = 0,
): ExitCadenceBookRollup {
  // Blind ladder, most-general first. An unreadable partition is a fact about
  // the WHOLE payload, so it outranks anything about this book's members.
  if (unknownModeEngineCount > 0) {
    return blindBook(
      book,
      engines.length,
      'unreadable_partition',
      `${unknownModeEngineCount} engine(s) carry no usable \`mode\` string, so the fleet cannot be `
      + 'partitioned by book. An engine of unknown book might BE the live one, and filing it as demo '
      + 'would silently shrink the graded population — refusing to grade a partition I cannot compute.',
    );
  }
  if (engines.length === 0) {
    return blindBook(
      book,
      0,
      'no_engine_in_book',
      `no \`mode=${book}\` engine is resident, so this book has nothing to grade. An assertion about `
      + `the ${book} book is satisfied FOR FREE by a fleet that contains no ${book} book, and that free `
      + 'pass is the exact defect TRA-2607 was filed on. HELD, never a pass. If the '
      + `${book} engine is EXPECTED to be absent, that is a finding about the box, not a grade.`,
    );
  }
  const unreadableArm = engines.filter((e) => armedOf(e) === null).length;
  if (unreadableArm > 0) {
    return blindBook(
      book,
      engines.length,
      'unreadable_arm_state',
      `${unreadableArm} of ${engines.length} \`mode=${book}\` engine(s) carry no boolean \`timerArmed\`. `
      + '"I cannot see the arm state" must never be published as "the hoist is disarmed" — right '
      + 'verdict, wrong cause. Note `enabled` is NOT a substitute: the flag is resolved ONCE at '
      + 'start(), so a mid-session flip reads `enabled` without a timer existing.',
    );
  }

  const armedEngineCount = engines.filter((e) => armedOf(e) === true).length;

  // Book histograms. Summed across the book's engines because the criterion is
  // about that book's exit path as a whole; per-engine rows are published
  // alongside so a single sick engine stays visible instead of being averaged
  // away.
  const lifetimeHistogram = sumExitHistogram(engines, (e) => e.intervalHistogram);
  const lifetimeSamples = totalOfExitHistogram(lifetimeHistogram);
  const lifetimeAtOrAbove30s = atOrAbove30sOfExitHistogram(lifetimeHistogram);

  const histogram = sumExitHistogram(engines, (e) => e.rth.intervalHistogram);
  const samples = totalOfExitHistogram(histogram);
  const atOrAbove30s = atOrAbove30sOfExitHistogram(histogram);
  // Null, not 0 or false, until there is a sample to judge. "No measurement
  // yet" and "measured, and it passes" are different facts, and only the
  // second one clears the gate.
  const p99Under30s = samples > 0 ? atOrAbove30s / samples < 0.01 : null;

  const maxExitIntervalMs = engines.reduce<number | null>(
    (acc, e) => (e.maxExitIntervalMs != null && (acc == null || e.maxExitIntervalMs > acc) ? e.maxExitIntervalMs : acc),
    null,
  );
  // TRA-2257 — roll-up of WHICH CADENCE stamped the intervals above, and of why
  // the decoupled timer declined to. Without this split the histogram is
  // ambiguous: a run in which the timer never once did work publishes the same
  // shape as a run in which it worked and lost to contention. These stay
  // LIFETIME-scoped: they are the terms of the `decoupledFireCount` invariant,
  // which is a statement about every fire since boot.
  const decoupledPassCount = engines.reduce((n, e) => n + e.decoupledPassCount, 0);
  const tickPassCount = engines.reduce((n, e) => n + e.tickPassCount, 0);
  const decoupledFireCount = engines.reduce((n, e) => n + e.decoupledFireCount, 0);
  const decoupledSkips = engines.reduce<Record<DecoupledExitSkipReason, number>>((acc, e) => {
    for (const r of DECOUPLED_EXIT_SKIP_REASONS) acc[r] += e.decoupledSkips[r];
    return acc;
  }, emptyDecoupledExitSkips());

  // TRA-2269 — the same split, restricted to the graded window: which cadence
  // closed each RTH interval, and where the excluded lifetime intervals went.
  const rthDecoupledPassCount = engines.reduce((n, e) => n + e.rth.decoupledPassCount, 0);
  const rthTickPassCount = engines.reduce((n, e) => n + e.rth.tickPassCount, 0);
  const rthBoundaryIntervals = engines.reduce((n, e) => n + e.rth.boundaryIntervals, 0);
  const rthClosedIntervals = engines.reduce((n, e) => n + e.rth.closedIntervals, 0);
  const gradedPasses = rthDecoupledPassCount + rthTickPassCount;
  const rthDecoupledShare = gradedPasses > 0 ? rthDecoupledPassCount / gradedPasses : null;
  // Every lifetime interval lands in exactly one of the three bins. Published so
  // a reader can check it rather than trust it — same contract as
  // `decoupledFireCount === sum(decoupledSkips) + decoupledPassCount`.
  const partitionHolds = lifetimeSamples === samples + rthBoundaryIntervals + rthClosedIntervals;

  // TRA-2257/TRA-2269 — THE GATE ON THE GRADE, in two parts. `p99Under30s` is a
  // statement about the hoist only if (a) the hoist ran during the window AND
  // (b) the window is made of the hoist. TRA-2257 shipped (a): on 2026-07-24
  // every fire refused on `marketClosed` post-16:00 ET and the resulting RED was
  // read as a verdict on the fix. (b) is the same defect one level down — SOME
  // decoupled passes flipped `gradeable` true while the denominator still
  // carried hours of closed-market intervals.
  const gradeable = armedEngineCount > 0
    && samples > 0
    && rthDecoupledPassCount > 0
    && rthDecoupledShare != null && rthDecoupledShare > RTH_DECOUPLED_SHARE_FLOOR;
  const notGradeableReason = armedEngineCount === 0
    ? `no \`mode=${book}\` engine has an exit timer — the hoist is disarmed on this book, nothing here `
      + 'grades it'
    : samples === 0
      ? (lifetimeSamples === 0
        ? 'no exit interval measured yet'
        : `${lifetimeSamples} exit interval(s) measured, but NONE with both endpoints inside `
          + '09:30-16:00 ET, so none of them grades the hoist (the decoupled gate is RTH-only BY '
          + 'DESIGN and refuses on `marketClosed` outside it). Read `lifetime` for what was '
          + 'measured and `decoupledSkips` for the branch every timer fire refused on.')
      : rthDecoupledPassCount === 0
        ? 'ZERO decoupled passes closed an RTH interval in this window, so every graded interval '
          + 'is doTick\'s own cadence and NONE of it grades the hoist. Read `decoupledSkips` for '
          + 'the branch that refused: `tickExitRegion` means doTick\'s interlock held for the '
          + 'whole window.'
        : rthDecoupledShare != null && rthDecoupledShare <= RTH_DECOUPLED_SHARE_FLOOR
          ? `the decoupled timer closed only ${rthDecoupledPassCount}/${gradedPasses} `
            + `(${(rthDecoupledShare * 100).toFixed(1)}%) of the graded RTH intervals — at or below `
            + `the ${RTH_DECOUPLED_SHARE_FLOOR * 100}% floor. doTick's inline pass, not the hoist, is `
            + 'setting this cadence, so the ratio is not a verdict on the hoist.'
          : null;

  return {
    book,
    blind: false,
    blindReason: null,
    // Is the hoist actually running anywhere IN THIS BOOK.
    enabled: armedEngineCount > 0,
    engineCount: engines.length,
    armedEngineCount,
    verdict:
      armedEngineCount === 0
        ? 'disarmed'
        : samples === 0
          // Distinguished on purpose: "nothing measured at all" and "measured,
          // but all of it outside the window this grades" are different facts,
          // and the second one is the normal state of a post-close read.
          ? (lifetimeSamples === 0 ? 'armed_but_no_interval_measured' : 'armed_but_no_rth_interval')
          // TRA-2257 — an armed timer that never ran is its own verdict, and it
          // is NOT `over_bar`. Ranking it ahead of the p99 comparison is the
          // whole point: `over_bar` invites a RED grade, and a RED grade on a
          // window the hoist sat out is worse than no grade at all.
          : rthDecoupledPassCount === 0
            ? 'armed_but_no_decoupled_pass'
            : rthDecoupledShare != null && rthDecoupledShare <= RTH_DECOUPLED_SHARE_FLOOR
              ? 'tick_dominated_window'
              : p99Under30s
                ? 'bounded'
                : 'over_bar',
    gradeable,
    notGradeableReason,
    // GRADED (RTH-only) terms.
    samples,
    atOrAbove30s,
    p99Under30s,
    intervalHistogram: histogram,
    rthDecoupledPassCount,
    rthTickPassCount,
    rthDecoupledShare,
    rthBoundaryIntervals,
    rthClosedIntervals,
    partitionHolds,
    // LIFETIME terms — unchanged semantics, kept for continuity and because
    // "is the exit path evaluating at all" is a real question with a real
    // answer. `maxExitIntervalMs` stays here: a high-water mark is not a ratio
    // and does not dilute.
    maxExitIntervalMs,
    lifetime: {
      samples: lifetimeSamples,
      atOrAbove30s: lifetimeAtOrAbove30s,
      p99Under30s: lifetimeSamples > 0 ? lifetimeAtOrAbove30s / lifetimeSamples < 0.01 : null,
      intervalHistogram: lifetimeHistogram,
    },
    decoupledPassCount,
    tickPassCount,
    decoupledFireCount,
    decoupledSkips,
    tickExitRegionMs: sumTickExitRegion(engines),
  };
}

/**
 * TRA-2269/TRA-2645 — the roll-up behind `GET /api/health/exit-cadence`,
 * extracted from the route handler so the grade can be controlled in BOTH
 * directions (it must be able to emit a PASS, a RED, and a refusal on demand)
 * without standing up an Express app or waiting on a live tape.
 *
 * TRA-2645 — THE HEADLINE CHANGE: THIS NO LONGER ROLLS A MIXED-MODE FLEET INTO
 * ONE ANSWER.
 *
 * It used to publish `enabled: armed.length > 0` over EVERY engine. bqb1 runs
 * 57 demo engines plus the one `mode=live` book routed to production Tradier
 * ***0154, so on 2026-07-30T04:19:56Z this route said `enabled: true,
 * armedEngineCount: 57, engineCount: 58` while the only engine that carries
 * money read `mode=live, enabled=false, timerArmed=false`. Three things
 * followed, and all three are fixed here:
 *
 *  1. `enabled: true` published over an unhoisted live book. There is no
 *     unscoped `enabled` any more — `liveEnabled` / `demoEnabled` /
 *     `books.{live,demo}.enabled` are the only spellings, so the name carries
 *     the population and a reader cannot get the other book's answer.
 *  2. The `disarmed` verdict was STRUCTURALLY UNREACHABLE: while any demo
 *     engine was armed, `armed.length === 0` could not hold — including in the
 *     world where every live engine is disarmed, which was the world we were
 *     in. `books.live.verdict` reaches `disarmed` on exactly that world.
 *  3. The graded ratio pooled the books. `samples` / `atOrAbove30s` /
 *     `p99Under30s` / `intervalHistogram` were summed across all 58 engines and
 *     then read against TRA-2200's REAL-MONEY invalidation criterion, diluting
 *     the live engine 1-in-58 with a fleet that shares no broker, no capital
 *     and no flag source (`signal-engine.ts` splits the env per book on
 *     purpose). Those terms now exist ONLY per book, and the aggregate REFUSES:
 *     top-level `verdict` is the constant `partitioned_by_book` and `gradeable`
 *     is the constant `false`.
 *
 *     A REMEDY SCOPED TO THE DEMO BOOK PASSES AN INSTRUMENT SCOPED TO THE DEMO
 *     BOOK — AND THE AGGREGATE IS WHAT MAKES IT INVISIBLE. `58/58` and `57/58`
 *     both read as coverage, because nobody reads a denominator.
 *
 * `window: 'rth'` (TRA-2269) and `partitionedBy: 'mode'` (TRA-2645) are
 * first-class markers so a reader can FAIL CLOSED on an old build: a payload
 * without `window` is a lifetime-scoped grade, and one without `partitionedBy`
 * is a book-pooled grade. Neither may be read as TRA-2200's criterion.
 */
export function rollUpExitCadence(engines: ExitCadenceHealth[]): ExitCadenceRollup {
  const liveEngines = engines.filter((e) => bookOf(e) === 'live');
  const demoEngines = engines.filter((e) => bookOf(e) === 'demo');
  // NOT filed as demo. An engine of unknown book might BE the live one; filing
  // it as demo would shrink the graded live population in silence, which is
  // this ticket's own defect one field down.
  const unknownModeEngineCount = engines.length - liveEngines.length - demoEngines.length;

  const live = gradeExitCadenceBook('live', liveEngines, unknownModeEngineCount);
  const demo = gradeExitCadenceBook('demo', demoEngines, unknownModeEngineCount);

  const maxExitIntervalMs = engines.reduce<number | null>(
    (acc, e) => (e.maxExitIntervalMs != null && (acc == null || e.maxExitIntervalMs > acc) ? e.maxExitIntervalMs : acc),
    null,
  );

  return {
    window: 'rth',
    partitionedBy: 'mode',
    books: { live, demo },
    liveEnabled: live.enabled,
    demoEnabled: demo.enabled,
    liveArmedEngineCount: live.armedEngineCount,
    demoArmedEngineCount: demo.armedEngineCount,
    engineCount: engines.length,
    liveEngineCount: liveEngines.length,
    demoEngineCount: demoEngines.length,
    unknownModeEngineCount,
    verdict: 'partitioned_by_book',
    gradeable: false,
    notGradeableReason:
      'THE AGGREGATE DOES NOT GRADE, BY CONSTRUCTION (TRA-2645). `p99Under30s` is TRA-2200\'s '
      + 'REAL-MONEY invalidation criterion and a demo engine cannot contribute evidence to it, so '
      + 'there is no fleet-wide population to compute it over. Read `books.live` for the money book '
      + 'and `books.demo` for the paper fleet; each carries its own `enabled`, `armedEngineCount`, '
      + '`engineCount`, `samples`, `atOrAbove30s`, `p99Under30s`, `intervalHistogram`, `verdict`, '
      + '`gradeable` and `notGradeableReason`. A book with NO engine in it is `blind` with verdict '
      + '`no_engine_in_book` and every graded term NULL — it is never a pass.',
    maxExitIntervalMs,
    decoupledPassCount: engines.reduce((n, e) => n + e.decoupledPassCount, 0),
    tickPassCount: engines.reduce((n, e) => n + e.tickPassCount, 0),
    decoupledFireCount: engines.reduce((n, e) => n + e.decoupledFireCount, 0),
    decoupledSkips: engines.reduce<Record<DecoupledExitSkipReason, number>>((acc, e) => {
      for (const r of DECOUPLED_EXIT_SKIP_REASONS) acc[r] += e.decoupledSkips[r];
      return acc;
    }, emptyDecoupledExitSkips()),
    tickExitRegionMs: sumTickExitRegion(engines),
    rthDecoupledShareFloor: RTH_DECOUPLED_SHARE_FLOOR,
    note:
      'TRA-2645: THERE IS NO FLEET-WIDE GRADE HERE. `partitionedBy: "mode"` marks that the graded '
      + 'terms live per book under `books.live` / `books.demo`; a payload WITHOUT that marker is a '
      + 'pre-TRA-2645 build whose `enabled` is an OR and whose `p99Under30s` is a sum over both '
      + 'books, and must not be read as either book\'s answer. Grade `books.<book>.p99Under30s` '
      + '(TRA-2200 invalidation criterion) — but ONLY when that book\'s `gradeable` is true, and '
      + 'only ever quote `books.live` about real money. A book with `blind: true` cannot answer: '
      + '`no_engine_in_book` means that book is not resident (HELD, never a pass — an assertion '
      + 'about a book no engine belongs to is satisfied for free), `unreadable_partition` means '
      + 'some engine carries no usable `mode` string so it could be EITHER book, and '
      + '`unreadable_arm_state` means `timerArmed` was not a boolean. '
      + 'TRA-2269: `window` names the window, and the graded fields (`samples`, `atOrAbove30s`, '
      + '`p99Under30s`, `intervalHistogram`) count ONLY intervals with BOTH endpoints inside '
      + '09:30-16:00 ET. They used to be lifetime accumulators since boot, which mixed in '
      + 'closed-market intervals that sit dead on the 30s bar: ~21.7 min of closed-market uptime '
      + 'was enough to force `p99Under30s` FALSE however well the hoist performed. Those numbers '
      + 'live under each book\'s `lifetime` and must NOT be read as the criterion. Buckets put the '
      + '30s bar on an edge, so `atOrAbove30s / samples < 0.01` IS p99 < 30s. `samples` counts '
      + 'INTERVALS, which is one fewer than passes per engine — the first pass after boot has no '
      + 'predecessor to measure against. Excluded intervals are counted, not dropped: '
      + '`lifetime.samples === samples + rthBoundaryIntervals + rthClosedIntervals` '
      + '(`partitionHolds`), where boundary = one endpoint each side of the open/close. '
      + 'TRA-2257: `decoupledPassCount` vs `tickPassCount` (LIFETIME) says which cadence '
      + 'produced intervals, and `decoupledSkips` names the branch every non-working timer '
      + 'fire refused on (they sum to `decoupledFireCount`, so a zero is a measurement, not '
      + 'a dark branch). `rthDecoupledShare` is the same split INSIDE the graded window and '
      + 'is the denominator-purity gate: at or below `rthDecoupledShareFloor` the verdict is '
      + '`tick_dominated_window` and refuses rather than grading doTick as the hoist. All '
      + 'counters are strictly monotonic within a process, so two same-process snapshots '
      + '(assert identical `build.startedAt` AND `build.pid`) difference cleanly into any '
      + 'sub-window. The TOP-LEVEL `tickExitRegionMs` is FLEET-SUMMED with no RTH predicate and '
      + 'no boot guard (TRA-2305/TRA-2268 grade that exact accumulator, so it is deliberately '
      + 'left fleet-scoped; per-book copies are in `books`). It is the suppression window doTick '
      + 'holds the exit interlock for (news + social + market-review + journal + '
      + 'tradier-balance + the 568-symbol quote-batch + 3 reconciles + '
      + 'shadow-chases): worst-case exit interval is bounded by THAT plus the '
      + 'timer period, never by the timer period alone, so a region at or above '
      + '30s makes `p99Under30s` unreachable however well the timer behaves.',
  };
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
      // TRA-2650 — demo-only, stated HERE: this route names usernames AND
      // balances, so a live book must never enter it.
      res.json(summarizeDemoBooks(demoModeBooks(deps.fleetBooks?.() ?? []), now()));
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
  // TRA-1949 — de-noise the board-facing view: QA/test books hidden by default
  // (with a "N hidden" note, never a silent drop), operator/live book labelled;
  // `?includeTest=1` restores the full fleet, mirroring the desk-calendar gate.
  // TRA-2660 — read the journal-account domain, or say WHY there is no reading.
  // Shared by the no-auth count surface and the admin names surface so the two
  // can never disagree about the population.
  const readDeskAccountRoster = async (): Promise<DeskAccountRosterReading> => {
    const provider = deps.journalAccountRows;
    if (!provider) {
      return { ok: false, reason: 'no journal-account provider is wired on this deployment' };
    }
    try {
      return { ok: true, fold: foldDeskAccountRoster(await provider()) };
    } catch (err) {
      return {
        ok: false,
        reason: `journal read failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  app.get('/api/health/demo-book-public', async (req, res) => {
    const includeTest =
      (req as { query?: Record<string, unknown> }).query?.['includeTest'] === '1';
    // TRA-2650 — the WHOLE fleet crosses here on purpose; the demo filter and
    // the operator-survival read both live inside the summarizer now.
    // TRA-2660 — `deskAccounts` is the durable journal-account domain, read
    // independently of `includeTest`.
    const deskAccounts = await readDeskAccountRoster();
    res.json(
      summarizeDemoBooksPublic(deps.fleetBooks?.() ?? [], now(), { includeTest, deskAccounts }),
    );
  });

  // TRA-2660 — the NAMES, behind admin auth. The no-auth route above can only
  // ever publish a count (it anonymizes identity by design), and a roster
  // cannot be designed from a count: TRA-2554 needs to know WHICH accounts are
  // unvouched, how many rows each owns, and whether the last one landed
  // yesterday or three weeks ago.
  //
  // GET ONLY, deliberately. A WRITE against the admin surface on bqb1 fires a
  // `trigger: service_updated` redeploy despite `autoDeploy=no` (TRA-2186), so
  // this diagnostic must never gain a mutating verb.
  //
  // OBSERVE-ONLY: nothing here gates a fold. `KNOWN_DESK_BOOKS` is echoed so the
  // reader can see the allowlist the answer was computed against, not to
  // suggest the list is being applied to any board number.
  const requireAdmin = deps.requireAdmin;
  if (requireAdmin) {
    app.get('/api/admin/desk-roster', deps.requireAuth, requireAdmin, async (_req, res) => {
      const reading = await readDeskAccountRoster();
      if (!reading.ok) {
        // 503, not an empty 200: "could not read" must never be served as "clean".
        res.status(503).json({ ok: false, time: new Date(now()).toISOString(), reason: reading.reason });
        return;
      }
      const { fold } = reading;
      const withDates = (a: JournalAccountStat) => ({
        ...a,
        firstOpen: a.firstOpenTs === null ? null : new Date(a.firstOpenTs).toISOString(),
        lastOpen: a.lastOpenTs === null ? null : new Date(a.lastOpenTs).toISOString(),
      });
      res.json({
        ok: true,
        time: new Date(now()).toISOString(),
        rowsScanned: fold.rowsScanned,
        rowsWithoutAccount: fold.rowsWithoutAccount,
        journalAccountCount: fold.journalAccountCount,
        knownDeskBooks: [...KNOWN_DESK_BOOKS],
        unrecognisedDeskAccountCount: fold.unrecognised.length,
        unrecognisedDeskAccounts: fold.unrecognised.map(withDates),
        // The vouched half + the test residual. The three classes partition the
        // domain; `partitions` says so on the wire, so a census that silently
        // dropped an account cannot read as a clean roster.
        rosterDeskAccounts: fold.roster.map(withDates),
        testAccountCount: fold.testAccountCount,
        partitions:
          fold.roster.length + fold.unrecognised.length + fold.testAccountCount ===
          fold.journalAccountCount,
      });
    });
  }

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

  // TRA-3218 (parent TRA-2760) — unauthenticated, secrets-free options-halt
  // probe. The book session-stop halt ran for a week unobserved because a halted
  // day and a quiet day read identically from outside; this names, per engine:
  // the halt SCOPE its option entry gates consult (book = legacy coupling to the
  // equity governor, sleeve = the TRA-3218 decoupling), what each halt authority
  // currently says (with latch TIMES + the peak/retained floor), the headline
  // `entriesHalted` bit, the per-day count of scans the book halt blocked or —
  // under sleeve scope — would have blocked (the counterfactual the board reads
  // BEFORE flipping), and the durable ledger's halted-session count. The
  // per-engine enumeration is the fleet answer: the scope/rules flags are
  // PER-PROCESS (`processScope` / `exitRiskRulesFlagLive`), the governors and
  // breakers are PER-ENGINE, so a second live book shares the flags and gets its
  // own latches — visible here per row rather than inferred from source.
  const optionsHalt = deps.optionsHalt;
  if (optionsHalt) {
    app.get('/api/health/options-halt', (_req, res) => {
      const engines = optionsHalt();
      const nowMs = now();
      res.json({
        ok: true,
        time: new Date(nowMs).toISOString(),
        build: resolveBuildInfo(),
        etDay: etDateString(new Date(nowMs)),
        /** The scope var + its PROCESS-env resolution (what any LIVE book reads). */
        scopeVar: OPTIONS_HALT_SCOPE_VAR,
        processScope: resolveOptionsHaltScope(process.env),
        exitRiskRulesFlag: EXIT_RISK_RULES_FLAG,
        exitRiskRulesFlagLive: isExitRiskRulesEnabled(process.env),
        engineCount: engines.length,
        liveEngineCount: engines.filter((e) => e.mode === 'live').length,
        entriesHaltedCount: engines.filter((e) => e.entriesHalted).length,
        engines,
        /** Durable per-session sleeve-breaker record — read `durability.ephemeral` FIRST. */
        ledger: summarizeOptionsBreakerLedger(),
      });
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

  // TRA-2028 — unauthenticated, secrets-free WHEEL PROMOTION GATE readout. Folds
  // three observe-only pieces: the IV-percentile entry-filter ledger
  // (entered-vs-skipped by IVP decile, Part A), the vol-spike stress suite
  // re-priced over the current demo wheel book (Part B), and the combined
  // promotion-gate rule (pass/fail/pending per criterion). Carries only the demo
  // book's own defined-risk figures — no balances/PII — so it is unauthenticated
  // (parity with /short-premium). `enabled` mirrors the EFFECTIVE
  // ENABLE_WHEEL_IV_ENTRY_FILTER through the demo-flags overlay (file over env, so
  // it reflects a daemon-free arm). OFF ⇒ the filter is observe-only and the gate
  // reads mostly `pending` on a calm/empty forward book — an honest not-yet, never
  // a silent pass. Read-only: routes no order. Live stays gated on TRA-382.
  app.get('/api/health/wheel-promotion-gate', (_req, res) => {
    const dir = process.env.DATA_DIR;
    const env = dir ? resolveDemoFlagEnv(dir) : process.env;
    const ivFilterEnabled = isWheelIvEntryFilterEnabled(env);
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      enabled: ivFilterEnabled,
      liveCapitalReachable: false,
      ...buildWheelPromotionGateSummary({ now: now(), ivFilterEnabled }),
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
      // TRA-1734 — an explicit retire marker. A killed strategy MUST NOT read
      // identically to one that was simply never switched on: a future reader
      // hitting a silent `enabled:false` cannot tell "retired after a NO-GO at
      // n=18" from "flag never set", and that ambiguity is how a dead strategy
      // gets revived by accident. `killed:true` + `killedReason` name the verdict.
      killed: REGIME_TSMOM_OBSERVE_KILLED,
      killedReason: REGIME_TSMOM_OBSERVE_KILLED ? REGIME_TSMOM_OBSERVE_KILLED_REASON : null,
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
  //
  // TRA-2265 — the spread now also carries `byClass` (equity/option/unknown) and
  // `byMode` (demo/live/unknown), the SAME counts partitioned and hydrated from the
  // full JSONL. Grade the equity promotion gate off `byClass.equity`, NEVER the
  // pooled pair: the equity and option add legs are checked by different rules
  // (equity `(blended−stop)·qty ≤ R` vs option `Σ premium ≤ R`), so a pooled
  // `breachCount: 0` reads byte-identical whether the equity cap held or the equity
  // add path never executed. As of the TRA-2263 fire, 100/100 retained fills are
  // `assetClass:"option"` — so `byClass.equity.addCount` is the count that separates.
  //
  // TRA-2303 — `countsBasis` / `countsExact` say where the counts came from. Setting
  // CONVICTION_DCA_DEPLOY_ANCHOR used to flip every count onto the 50-fill display
  // tail, silently zeroing `byClass.equity` (all 3 equity fills are on the ledger's
  // first day, ~18 days behind the tail). Both branches are exact over the full
  // ledger now. `recent` is a DISPLAY tail — never grade a count off it, and treat
  // `countsExact: false` as un-gradeable rather than as a zero.
  //
  // TRA-2598 — three additions, all read-only:
  //   • `byAccount` / `bySession[].accounts` — the OWNING BOOK. The demo journal is one
  //     firm-wide union including the QA probe books, so a POOLED read of "did this add
  //     land on a name already net-negative today?" is wrong in both directions. It
  //     manufactured a false `high` regression against a WORKING brake on 2026-07-28
  //     (three books traded FIRY; the −$47.00 loss was a THIRD book's).
  //   • `guard` — the brake's own denominator (`addsPresented`/`addsEvaluated`/
  //     `addsHalted` + a named `state`). `breachCount: 0` alone has no failing state,
  //     and it is a DIFFERENT invariant besides: it counts R-cap breaches, while a
  //     same-day-loss halt happens BEFORE any fill exists and so can never appear in
  //     the fill ledger at all. Read `guard.state`, not the zero.
  //   • `?limit=` / `?offset=` — `recent` was a fixed 50 against 658 adds (7.6%, 3 of
  //     15 post-arm sessions). `recentWindow` states what the page covers; `bySession`
  //     is the whole-corpus surface.
  app.get('/api/health/conviction-dca', (req, res) => {
    const anchor = resolveConvictionDcaDeployAnchor();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      enabled: CONVICTION_DCA.enabled,
      ...summarizeConvictionDca(
        anchor,
        parseConvictionDcaPaging(req.query as Record<string, unknown> | undefined),
      ),
      // Both halves take the SAME anchor, so the fill counts and the guard denominator
      // always describe one window. An anchor applied to only one of them would make
      // `addsEvaluated` look short against `addCount` for purely windowing reasons.
      guard: summarizeConvictionDcaGuard(anchor),
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
    const build = resolveBuildInfo();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build,
      flag: CHURN_LOSS_BRAKE_FLAG,
      armed,
      cap,
      demoOnly: true,
      liveCapitalReachable: false,
      // TRA-2813 — every counter below is in-memory and resets to ZERO at
      // `countersSince` (each reboot/deploy), while the /api/health/conviction-dca
      // guard counters are DURABLE across reboots. Cross-checking the two is only
      // valid for halts at/after `countersSince`; across a reboot the durable side
      // retains halts these counters have dropped — and one leg can still match
      // exactly by composition (all of that leg's halts post-boot) while the other
      // diverges, so a partial match is not evidence of a shared window.
      counterWindow: 'since_boot',
      countersSince: build.startedAt,
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
  //
  // TRA-3011 — and it now grades WHETHER THE BYTES GO, not just where. Through the
  // 2026-07-30 → 08-04 `ENOSPC` outage this route served `ok: true` with an empty
  // `violations` and the note "Durable state is intact"; every field it graded was
  // genuinely true while nothing on the box could write. The `disk` block below is
  // the sixth fail-open, plus the one thing no instantaneous field can give you:
  // `disk.belowThresholdSeen` is a SINCE-BOOT memory, so a box that was full an
  // hour ago and has since been pruned no longer reads identically to one that was
  // never full. Booleans and ages only — the byte and inode figures stay behind
  // admin auth on `/api/health/storage/detail` (TRA-2599) and this route is open.
  app.get('/api/health/durability', (_req, res) => {
    const dataDir = process.env.DATA_DIR ?? null;
    const etDay = etDateString(new Date(now()));
    const ledger = summarizeCostAwareGate(etDay).durability;
    // TRA-3011 — read the watermark rather than calling `statfs` here. Two reasons:
    // the verdict stays PURE and synchronous (an open route must not fire IO per
    // request), and the reading it grades is the one the 60s monitor took — so a
    // STOPPED monitor surfaces as `disk_headroom` UNMEASURED instead of this route
    // quietly re-measuring a disk nobody is alerting on.
    const watermark = getDiskWatermark();
    const report = evaluateDurability({
      // The LEDGER's resolved dir is the truth when it has one: it is the path bytes are
      // actually appended to. `process.env.DATA_DIR` is what the operator *set*, and on a
      // box where it is unset the two disagree in precisely the way that matters — the
      // ledger falls back to a bundle path and writes there happily.
      dataDir: ledger.dataDir ?? dataDir,
      stateDb: getStateDbStatus(),
      journal: getOptionTradeJournalIntegrity(),
      ledger: { appendErrors: ledger.appendErrors },
      disk: {
        belowThreshold: watermark.lastBelowThreshold,
        exhausted: watermark.lastExhausted,
        ageSec: diskReadingAgeSec(watermark, now()),
        belowThresholdSeen: watermark.belowThresholdSeen,
        exhaustedSeen: watermark.exhaustedSeen,
        readings: watermark.readings,
        firstBelowAt: watermark.firstBelowAt,
        lastBelowAt: watermark.lastBelowAt,
        bootedAt: watermark.bootedAt,
      },
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
      disk: report.disk,
      violations: report.violations,
      unmeasured: report.unmeasured,
      note: durabilityNote(report),
    });
  });

  // TRA-1892 (parent TRA-1592 → TRA-1435) — DURABLE give-back arm-floor forward-test
  // readout. The ≥5-session validation for the give-back cap's minimum arm floor
  // (TRA-1435, armed demo+live) could not accrue: the give-back state is in-memory and
  // wiped by bqb1's ~04:30Z reboot, and the local grade fire missed two weekday windows,
  // so a missed 21:40Z fire was a permanently lost session. This route folds the durable
  // per-(mode, engineId, ET-day) outcome ledger so a CATCH-UP read recovers the whole
  // window after a reboot — PROVIDED the ledger is on a persistent mount. Read
  // `durability.ephemeral` FIRST: true ⇒ the outcomes below die at the next redeploy and
  // recoverability is VOID (fix = DATA_DIR=/data on bqb1, TRA-1719). `invalidations > 0`
  // is the PRIMARY-AC breach: a sub-floor-peak day that give-back halted.
  //
  // TRA-2220 — and read `recorder.state` BEFORE EVEN THAT. The writer sits inside the
  // `EXIT_RISK_RULES_ENABLED` master gate, so a wiped master does not zero these counters,
  // it FREEZES them — and a frozen `invalidations: 0` is byte-identical to 22 clean
  // sessions. That is what this route served on 2026-07-22/23 with `ok: true` while
  // TRA-1592's reopen tripwire sat structurally unable to fire. `ok` is now FALSE
  // whenever the recorder is dark or stale, and `invalidations` serializes as `null`
  // rather than `0` while dark (TRA-1707: `0` is never "not measured").
  app.get('/api/health/giveback-arm-floor', (_req, res) => {
    const dir = process.env.DATA_DIR;
    // The live book reads process.env; the demo book overlays demo-flags.json — mirror
    // the engine's `bookMarkEnv` resolution so `armed` reflects what each book sees.
    const liveEnv = process.env;
    const demoEnv = dir ? resolveDemoFlagEnv(dir) : process.env;
    const summary = summarizeGiveBackArmFloor({ now: now() });
    const rec = summary.recorder;
    // Darkness and staleness are BOTH failures of the instrument, not of the book: a
    // ceiling-only check (`invalidations <= 0`) passes forever against a dead recorder,
    // so liveness gets its own floor assertion here (TRA-2220 ask #2).
    const healthy = rec.state === 'armed_and_recording' || rec.state === 'never_recorded';
    res.json({
      ok: healthy,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      masterFlag: EXIT_RISK_RULES_FLAG,
      armFloorFlag: BOOK_GIVEBACK_ARM_FLOOR_FLAG,
      // Both books run under the SAME service env var; report each book's resolved arm
      // state so a grader knows the floor was live for the sessions below.
      //
      // NOTE the predicate difference from `recorder.armedByBook`: this is master AND
      // arm-floor (is the CONTROL armed?); the recorder is gated on the master ALONE (is
      // the MEASUREMENT running?). Floor off + master on ⇒ rows still accrue, all with
      // `giveBackArmFloor: 0`. Master off ⇒ no rows at all.
      armed: {
        demo: isExitRiskRulesEnabled(demoEnv) && isBookGiveBackArmFloorEnabled(demoEnv),
        live: isExitRiskRulesEnabled(liveEnv) && isBookGiveBackArmFloorEnabled(liveEnv),
      },
      // TRA-2220 — READ FIRST. `state: 'dark'` ⇒ nothing below is a live measurement.
      recorder: rec,
      sessionsObserved: summary.sessionsObserved,
      /** `null` while dark — see `recorder.state`. `invalidationsRecorded` is the raw count. */
      invalidations: summary.invalidations,
      invalidationsRecorded: summary.invalidationsRecorded,
      verdictCounts: summary.verdictCounts,
      verdictCountsTotal: summary.verdictCountsTotal,
      retentionDays: summary.retentionDays,
      // TRA-1681 — `ephemeral: true` ⇒ the sessions below are wiped at
      // the next reboot exactly like the in-memory state this ledger exists to outlast.
      durability: summary.durability,
      sessions: summary.sessions,
      lastRecordAt: summary.lastRecordAt,
      note: givebackArmFloorNote(summary),
      // TRA-2927 — leg-level attribution for an out-of-family `peakPnl`, co-located
      // with the sessions above ON PURPOSE: the row that shows the phantom peak and
      // the marks that could have produced it must be readable in ONE payload, or
      // the next occurrence gets triaged from the fold alone again. Read
      // `markSanity.observed` FIRST — `flagged: 0` on `observed: 0` is an ABSENCE.
      // Observe-only: nothing below was rejected, every one of these marks reached
      // `peakOpenGain`.
      //
      // TRA-2945 — the top-level counters (`observed`/`flagged`/`maxJumpX`/`samples`)
      // are SINCE-BOOT and answer "is the observer running right now". The bound in
      // TRA-2945 §3 must instead be derived from `byMode` / `days` / `boundReadiness`,
      // which are DURABLE (hydrated from /data like `sessions`) and split PER BOOK.
      // A since-boot read can never accumulate the required 5 sessions because bqb1
      // restarts several times a day, and a combined read cannot tell a tape that
      // covered the live book from one that only ever saw demo — check
      // `durability.ephemeral` and `byMode.live.observed` before trusting either.
      markSanity: summarizeMarkSanity(),
    });
  });

  // TRA-1929 (parent TRA-1916) — read the live real-money options per-trade fee +
  // slippage calibration, plus the CURRENT live arm state (both sleeves + the dated
  // window). The board authorized this to harvest live fee/slippage before the
  // August go-live gate; this route is how the board and LeadDev read that data
  // WITHOUT shell access to bqb1.
  //
  // ⭐ TRA-2914 — `arm.testUntilIso` HERE is the only authoritative horizon for the
  // live options arm. Source comments and ticket titles have described it as a
  // short bounded test long after the board made it a standing arm (TRA-2877);
  // TRA-2693 was filed and sized against a horizon that had already moved. If you
  // are about to state how long real money is armed for, read this field.
  //
  // Read `durability.ephemeral`
  // FIRST: true ⇒ the records below die on the next redeploy and the calibration is
  // NOT durably captured (fix = DATA_DIR=/data, TRA-1719). `feesMeasured < n` ⇒
  // commission is not yet back-filled (fill-time payload carries none — a follow-up
  // reconcile from the account-history endpoint), so `totalFees` is incomplete.
  app.get('/api/health/live-options-fee-slippage', (_req, res) => {
    // Live-order flags are read from the process env ONLY (secret-adjacent — never the
    // demo-flags file), so `armed` reflects exactly what the live book's order sites see.
    const liveEnv = process.env;
    const nowMs = now();
    const summary = summarizeLiveOptionsFeeSlippage();
    const testUntil = parseOptionLiveTestUntil(liveEnv);
    res.json({
      ok: true,
      time: new Date(nowMs).toISOString(),
      build: resolveBuildInfo(),
      otmFlag: 'ENABLE_OPTION_LIVE_OTM',
      rvFlag: 'ENABLE_OPTION_LIVE_RV_LONG',
      windowVar: 'OPTION_LIVE_TEST_UNTIL',
      // TRA-2536 — the RESOLVED per-entry size the order site will actually use, not
      // the compiled default. Reporting the constant here would read identically on a
      // box running a different cap/size, which is the whole failure class: a size
      // parameter with no read path cannot be verified after arming.
      notionalCapUsd: resolveLiveOptionTestNotionalCapUsd(liveEnv),
      notionalCapDefaultUsd: LIVE_OPTION_TEST_NOTIONAL_CAP_USD,
      notionalCapCeilingUsd: LIVE_OPTION_TEST_NOTIONAL_CEILING_USD,
      notionalCapVar: LIVE_OPTION_TEST_NOTIONAL_CAP_VAR,
      maxContracts: resolveLiveOptionTestMaxContracts(liveEnv),
      maxContractsVar: LIVE_OPTION_TEST_MAX_CONTRACTS_VAR,
      maxContractsHardMax: LIVE_OPTION_TEST_CONTRACTS_HARD_MAX,
      // TRA-3445 — the board's THIRD clause ("max $750 total"), which had no
      // enforcement path until now. Same publication contract as the per-entry
      // pair above: the RESOLVED value, not the constant.
      aggregateCapUsd: resolveLiveOptionTestAggregateCapUsd(liveEnv),
      aggregateCapDefaultUsd: LIVE_OPTION_TEST_AGGREGATE_CAP_USD,
      aggregateCapCeilingUsd: LIVE_OPTION_TEST_AGGREGATE_CEILING_USD,
      aggregateCapVar: LIVE_OPTION_TEST_AGGREGATE_CAP_VAR,
      // ⭐ READ THIS, NOT THE CAP ALONE. A cap value reads IDENTICALLY at
      // headroom $600 and headroom $0, and those two states are the entire
      // point of the instrument. One row per engine, computed by the same fold
      // the order site enforces on. `null` ⇒ the provider is not wired (this
      // build serves the cap without a utilization read) — never `[]`, which
      // would claim "no books" against an unwired route.
      //
      // SCOPE IS PER BOOK (TRA-3445 item 3): each engine sizes against its own
      // Tradier balance and there is no fleet accumulator, so N armed live
      // books admit N × the cap. The fleet figure is a sum the reader takes —
      // it is not bounded here — and it must be taken over the
      // `liveEntryGateOpen` rows, NOT the `mode: 'live'` ones. bqb1 carries
      // three of the latter and two of the former.
      aggregateExposure: deps.liveOtmAggregateExposure?.() ?? null,
      // The ACTUAL arm each order site consults: raw flag AND the window. `windowOpen`
      // false ⇒ both sleeves read OFF regardless of their booleans (fail-closed).
      arm: {
        otmFlagOn: isOptionLiveOtmEnabled(liveEnv),
        rvFlagOn: isOptionLiveRvLongEnabled(liveEnv),
        windowOpen: isOptionLiveTestWindowOpen(liveEnv, nowMs),
        testUntilEpochMs: testUntil,
        testUntilIso: testUntil !== null ? new Date(testUntil).toISOString() : null,
        otmArmed: isOptionLiveOtmArmed(liveEnv, nowMs),
        rvArmed: isOptionLiveRvLongArmed(liveEnv, nowMs),
      },
      n: summary.n,
      opens: summary.opens,
      closes: summary.closes,
      slippage: summary.slippage,
      totalFees: summary.totalFees,
      feesMeasured: summary.feesMeasured,
      // TRA-2850 — who measured each counted fee (history commission join vs
      // gainloss derivation). Sums to feesMeasured; a fee with no provenance no
      // longer counts (the pre-2850 `fees: 0` poison reads unmeasured again).
      feesBySource: summary.feesBySource,
      retentionDays: summary.retentionDays,
      durability: summary.durability,
      lastRecordAt: summary.lastRecordAt,
      records: summary.records,
      // TRA-2810 — provenance of the AUTOMATIC fee back-fill (boot kick + hourly
      // tick). `ticks: 0` ⇒ the pass never ran on this boot — the one state the
      // TRA-1954 admin-POST era could not distinguish from healthy-quiescent.
      // TRA-2850 — `stalled: true` is the NON-GREEN state: repeated no-match with
      // nothing ever written; do not read `lastError: null` as health.
      autoReconcile: getLiveOptionsFeeReconcileState(),
      note: summary.durability.ephemeral
        ? `NOT DURABLE — DATA_DIR is ephemeral (${summary.durability.dataDir ?? 'memory-only'}); these ${summary.n} fill(s) die at the next reboot and the calibration is not captured. Fix = DATA_DIR=/data on bqb1 (TRA-1719). Read durability.ephemeral before trusting any count.`
        : `DURABLE: ${summary.n} fill(s) on ${summary.durability.dataDir}. fees auto-back-fill on the boot kick + ET hourly tick (TRA-2810/TRA-2850; ${summary.feesMeasured}/${summary.n} measured — see autoReconcile.unmeasured* for the pending/awaiting-close/aged split, and autoReconcile.stalled for the non-green state): real production fees derive from settled /gainloss cost/proceeds (history commission is 0 on every production row and only joins when positive). TRA-2959: slippage.nMeasured states its denominator (${summary.slippage.nMeasured}/${summary.slippage.nTotal}; ${summary.slippage.excludedNoAskQuote} excluded by name: no submit-time ask — market/emergency exits + history imports), and autoReconcile.coverage cross-checks the ledger against broker account-history — missingContracts > 0 means fills NO code path recorded (the 2026-08-04 silence appendErrors cannot see); the same pass imports them as origin:'history_import' rows.`,
    });
  });

  // TRA-3391 (TRA-3388 Ruling 2, acceptance item 6) — the TAPE-CALIBRATED
  // EXPECTANCY TABLE, per cell, as the gate itself sees it.
  //
  // The admission decision is no longer a formula a reader can recompute from the
  // arm block: it is a lookup into a measured table. Publishing the table is what
  // makes the decision gradeable off deployed state — `admits` here IS the
  // decision the live gate makes for a candidate in that cell, computed by the
  // same pure function, not a re-derivation.
  //
  // Read in this order:
  //  1. `basis` — desk + unattributed, QA fixtures EXCLUDED. Load-bearing: 110 of
  //     the 116 fixture OTM rows sit in 0.45–0.55, i.e. exactly the decision band,
  //     so a fixture-inclusive fold manufactures the admission (Ruling 2.1).
  //  2. `freshness.generation` — 0 / `computedAt: 0` means NOTHING HAS BEEN FOLDED
  //     and every candidate is currently declining `insufficient_evidence`. That
  //     is fail-closed, not clean.
  //  3. `cells[].n` against `minCellN` — a cell under it DECLINES with
  //     `insufficient_evidence` no matter how good its mean looks.
  //  4. `cells[].lowerCI95` against `cells[].barR` — the decision rule is the
  //     LOWER BOUND, not the mean (Ruling 2.4).
  //
  // Observe-only, secrets-free (structure / bucket / counts / R-multiples only),
  // unauthenticated for parity with /option-journal and /live-enforce-gates.
  app.get('/api/health/option-expectancy-table', async (_req, res) => {
    const nowMs = now();
    const cache = tapeExpectancyCache();
    const cached = await cache.get();
    const admitted = cached?.table.cells.filter((c) => c.admits) ?? [];
    const underpowered = cached?.table.cells.filter((c) => c.n < (cached.table.minCellN)) ?? [];
    res.json({
      ok: true,
      issue: 'TRA-3391',
      time: new Date(nowMs).toISOString(),
      build: resolveBuildInfo(),
      etDay: etDateString(new Date(nowMs)),
      /** The decision rule, published as text so a grader never has to infer it. */
      rule: 'admit iff mean(R_gate) - 1.96*SE >= admissionBarR AND n >= minCellN; otherwise BLOCK (insufficient_evidence when n < minCellN)',
      unit: 'R_gate = realizedR / 0.25 — the same currency as admissionBarR',
      minCellN: TAPE_EXPECTANCY_MIN_CELL_N,
      freshness: cache.freshness(),
      basis: cached?.census ?? null,
      table: cached?.table ?? null,
      admittedCells: admitted.map((c) => c.cellKey),
      underpoweredCells: underpowered.map((c) => ({ cell: c.cellKey, n: c.n })),
      note:
        cached === null
          ? 'BLIND — the expectancy tape has never been folded in this process. This is NOT a clean bill: every candidate is currently DECLINED with `insufficient_evidence` (fail-closed). Check freshness.lastError.'
          : `Folded ${cached.table.rowsUsed} closed rows into ${cached.table.cells.length} cells over a ${cached.table.windowDays ?? 'unbounded'}-day rolling window. ${admitted.length} cell(s) ADMIT: ${admitted.length > 0 ? admitted.map((c) => `${c.cellKey} (n=${c.n}, mean ${c.meanR_gate.toFixed(3)}, lower95 ${(c.lowerCI95 ?? 0).toFixed(3)} >= bar ${c.barR.toFixed(3)})`).join('; ') : 'NONE — every cell either measures below its bar or holds too few rows'}. ${underpowered.length} cell(s) hold n < ${cached.table.minCellN} and DECLINE under \`insufficient_evidence\`, which is distinct from \`gross_negative\`: it means we never measured, not that we measured a loser (TRA-3388 Ruling 2.5). Cross-read against /api/health/live-enforce-gates → byGate[cost_bar].byCell to see which cells the LIVE gate actually decided under.`,
    });
  });

  // TRA-3394 (authorization TRA-3392) — the RATIFIED BAND TABLE, the three
  // decline reason codes, and the ceiling gate's own counters, on one read.
  //
  // This endpoint answers the question the board could not previously ask: the
  // sleeve declines almost everything, and until now every decline looked the
  // same. Three of them are now distinguishable, and they want three DIFFERENT
  // responses (`declineReasonCodes` states which):
  //
  //   band_deauthorized      we measured it and the mandate forbids it  → do nothing
  //   insufficient_evidence  we never measured it                        → accrue
  //   gross_negative         we measured a loser                         → bar working
  //
  // It also carries the CEILING, which is the item with live money behind it: the
  // cost bar is algebraically a FLOOR, so the live admitted set was `[0.495, ∞)`
  // against an authorization of `[0.495, 0.55)`. Read `ceiling.mode` FIRST —
  // `off` means the gap is still open and the counters below are structurally
  // zero, which is NOT the same as a gate that ran and passed everything.
  //
  // Observe-only, secrets-free, unauthenticated for parity with the other gate
  // reads.
  app.get('/api/health/otm-sleeve-mandate', (_req, res) => {
    const nowMs = now();
    const etDay = etDateString(new Date(nowMs));
    const liveEnv = process.env;
    const structure = OTM_SLEEVE_MANDATE_STRUCTURE;
    const ceiling = resolveEntryDeltaCeilingLive(structure, liveEnv);
    const summary = summarizeLiveEnforceGate(etDay);
    const gateToday = (g: string) => summary.byGate.find((x) => x.gate === g) ?? null;
    const gateRetained = (g: string) => summary.retained.byGate.find((x) => x.gate === g) ?? null;

    res.json({
      ok: true,
      issue: 'TRA-3394',
      authorization: OTM_SLEEVE_MANDATE_ISSUE,
      time: new Date(nowMs).toISOString(),
      etDay,
      build: resolveBuildInfo(),
      sleeve: {
        /** §7 — the label changed; the KEY is frozen and joins every published number. */
        label: OTM_SLEEVE_MANDATE_LABEL,
        structureKey: structure,
        keyFrozenBecause:
          'TRA-3392 §7 — `single_leg_otm` is the join column of the journal tape, of '
          + 'OPTIONS_PRODUCTION_STRATEGIES and of this ledger\'s byScope. Renaming it would silently '
          + 'restate every published per-structure number (the read-time-reclassification failure '
          + 'test-accounts.ts / TRA-2948 documents). New label over the old key, in strings only.',
        authorizedBand: {
          from: mandateFloorFor(structure),
          to: mandateCeilingFor(structure),
          note: 'Half-open [from, to). BOUNDED ON BOTH SIDES — that is the point of the ticket.',
        },
      },
      /** (a) The ratified band table, with n / SE / lo95 per measured cell. */
      bands: OTM_SLEEVE_MANDATE_BANDS,
      bandsProvenance: OTM_SLEEVE_MANDATE_PROVENANCE,
      /** (b) The three decline reason codes, with the response each one calls for. */
      declineReasonCodes: DECLINE_REASON_TAXONOMY,
      /** (c) The ceiling gate: arm state, then its OWN evaluated/blocked counters. */
      ceiling: {
        mode: ceiling.mode,
        inForce: ceiling.ceiling,
        mandateCeiling: ceiling.mandateCeiling,
        rawOverride: ceiling.rawOverride,
        overrideRejectedReason: ceiling.overrideRejectedReason,
        flags: {
          enforce: OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG,
          observe: OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG,
          value: OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR,
        },
        reasonCode: ENTRY_DELTA_CEILING_REASON_CODE,
        counters: {
          enforcing: {
            gate: ENTRY_DELTA_CEILING_GATE,
            today: gateToday(ENTRY_DELTA_CEILING_GATE),
            retained: gateRetained(ENTRY_DELTA_CEILING_GATE),
          },
          shadow: {
            gate: ENTRY_DELTA_CEILING_SHADOW_GATE,
            today: gateToday(ENTRY_DELTA_CEILING_SHADOW_GATE),
            retained: gateRetained(ENTRY_DELTA_CEILING_SHADOW_GATE),
            meaning:
              '`blocked` on the SHADOW gate means WOULD HAVE BLOCKED. No live open was stopped by it. '
              + 'It is a separate gate from the enforcing one so a shadow count can never be read as '
              + 'a trade that was prevented (TRA-1682).',
          },
        },
        durability: summary.durability,
      },
      /**
       * How to read the counters, spelled out because the healthy read is a ZERO
       * and a zero is exactly what an inert gate produces.
       */
      note:
        ceiling.mode === 'off'
          ? `CEILING DARK: neither ${OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG} nor `
            + `${OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG} is set, so NO verdict is recorded and the `
            + `live admitted set is still [${mandateFloorFor(structure)}, inf) against an authorization of `
            + `[${mandateFloorFor(structure)}, ${mandateCeilingFor(structure)}). The counters below are `
            + 'structurally zero — this is the shipped-but-unarmed state TRA-3394 requires, not a clean bill. '
            + `Next step is the SHADOW arm (${OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG}=1), which records `
            + 'verdicts and blocks nothing; the enforcing arm is a separate CTO authorization. '
            + 'Item 2 (band_deauthorized) is ACTIVE regardless of these flags — it is a decline reason on the '
            + 'admission table, not a gate, and it needs no arm.'
          : `CEILING ${ceiling.mode.toUpperCase()} at |delta| < ${ceiling.ceiling} on ${structure}. `
            + 'Expected healthy read is `evaluated > 0, blocked = 0`: the whole 1073-row tape holds n=20 above '
            + '0.55, so this gate is designed to bite RARELY. `evaluated = 0` means no live OTM candidate '
            + 'reached the gate at all (check the universe and floor axes upstream on '
            + '/api/health/live-enforce-gates), NOT that the ceiling passed everything. Use `byCell` on each '
            + 'gate to see which mandate band the evaluated candidates fell in — that is what makes a zero '
            + 'blocked count checkable rather than merely reassuring.',
      crossReads: {
        gates: '/api/health/live-enforce-gates — byGate[entry_delta_ceiling{,_shadow}], byCell, byReason',
        expectancy: '/api/health/option-expectancy-table — the measured cell table the bar decides on',
        journal: '/api/health/option-journal?rows=all — the tape the bands were measured from',
      },
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
      // TRA-2311 — the ARM BIT for the TRA-2295 entry spread ceiling. Without it
      // `spreadCeilingEvaluatedTotal: 0` has two causes that read IDENTICALLY:
      //   (a) ARMED but no entry reached the gate  ⇒ the grade is VOID, retry later;
      //   (b) DISARMED via OPTION_SPREAD_CEILING_ENFORCE=0 ⇒ the ceiling is not in
      //       force at all and TRA-2295 is unfixed in practice.
      // A grader that reads (b) as "0 entries over the ceiling — PASS" is satisfied
      // by ZERO ENTRIES, which is precisely the failure TRA-2295 exists to remove.
      // Resolved through the SAME expression the entry path uses
      // (`signal-engine.ts:spreadCeilingRejectReason` → `resolveDemoFlagEnv()` on the
      // demo branch), never `process.env` directly — a bit computed off a different
      // resolution path than the gate would be a second false instrument.
      spreadCeiling: (() => {
        const ceilingArmed = isSpreadCeilingEnforceEnabled(env);
        // Mirror the engine's coercion EXACTLY (signal-engine.ts:5535) so the
        // reported floor is the one actually applied — including the sharp edge
        // that `''` coerces to 0 and thereby REMOVES the quotability floor.
        const rawMinBid = env.OPTION_SPREAD_CEILING_MIN_BID_USD;
        const minBid = Number(rawMinBid);
        const minBidUsdOverride =
          rawMinBid !== undefined && Number.isFinite(minBid) && minBid >= 0 ? minBid : null;
        const structures = Object.keys(SLEEVE_SPREAD_CEILINGS);
        const perStructure = structures.map((structure) => {
          const base = SLEEVE_SPREAD_CEILINGS[structure]!;
          return {
            structure,
            maxSpreadPct: base.maxSpreadPct,
            maxSpreadCrossR: base.maxSpreadCrossR,
            minBidUsd: minBidUsdOverride ?? base.minBidUsd,
          };
        });
        // The kill switch is NOT on DEMO_FLAG_ALLOWLIST, so `demo-flags.json`
        // CANNOT carry it (`loadDemoFlagFile` copies allowlisted keys only) — the
        // overlay resolves it straight through to process.env. Reported rather
        // than assumed: "which env can answer this flag" is exactly the question
        // that made the arm state unobservable in the first place.
        const overlayCapable = (DEMO_FLAG_ALLOWLIST as readonly string[]).includes(
          OPTION_SPREAD_CEILING_ENFORCE_FLAG,
        );
        return {
          flag: OPTION_SPREAD_CEILING_ENFORCE_FLAG,
          armed: ceilingArmed,
          /** OPPOSITE POLARITY to every other gate on this route: absent ⇒ ARMED. */
          defaultOn: true,
          /** The raw effective string, so a typo'd value is visible and not inferred. */
          flagValue: env[OPTION_SPREAD_CEILING_ENFORCE_FLAG] ?? null,
          /** false ⇒ demo-flags.json cannot set this key; process env is the ONLY channel. */
          overlayCapable,
          minBidUsdOverride,
          structures,
          perStructure,
          note: ceilingArmed
            ? `ARMED (default-ON, opt-OUT polarity — an ABSENT ${OPTION_SPREAD_CEILING_ENFORCE_FLAG} is ARMED, unlike every other gate on this route). The entry path rejects an option open whose (ask − bid)/mark exceeds its sleeve ceiling, or whose bid is under the quotability floor: ${perStructure.map((s) => `${s.structure} ≤${(s.maxSpreadPct * 100).toFixed(0)}% / bid ≥$${s.minBidUsd.toFixed(2)}`).join(', ')}. READ THIS BIT BEFORE GRADING spreadCeilingEvaluated: armed + evaluated=0 means NO ENTRY REACHED THE GATE (verdict VOID — do NOT read it as a pass); armed + evaluated>0 with maxAdmittedSpreadPct a NUMBER at or under the sleeve ceiling is the actual pass; armed + evaluated>0 with maxAdmittedSpreadPct null means the gate RAN and ADMITTED NOTHING — ALSO VOID, not a pass. ⚠ TRA-2319 — DO NOT REACH THAT THIRD BRANCH WITH A BARE '<=': maxAdmittedSpreadPct is number|null and null <= 0.10 is TRUE in JavaScript (null coerces to 0 under relational comparison; undefined <= 0.10 is false, so the two absent-ish values do NOT behave alike). A consumer that writes maxAdmittedSpreadPct <= ceiling reads PASS on a gate that admitted nothing. Test maxAdmittedSpreadPct !== null FIRST, then compare. Only an EXPLICIT 0|false|no|off disarms, so a typo keeps the ceiling on.${overlayCapable ? '' : ` This flag is NOT on DEMO_FLAG_ALLOWLIST, so demo-flags.json cannot carry it — the only place a disarm can live is the PROCESS env (Render env var).`}`
            : `DISARMED — ${OPTION_SPREAD_CEILING_ENFORCE_FLAG} is explicitly set to '${env[OPTION_SPREAD_CEILING_ENFORCE_FLAG] ?? ''}' (0|false|no|off). The TRA-2295 entry ceiling is NOT in force: no open is being rejected for spread, and spreadCeilingEvaluated stays 0 no matter how many entries fire. Any TRA-2295 verification computed in this state is MEANINGLESS — do not grade it, re-arm first by REMOVING the flag (absent ⇒ armed).`,
        };
      })(),
      ...summarizeCostAwareGate(etDay),
    });
  });

  // TRA-2048 (parent TRA-2044) — read the LIVE enforcement state of the two gates
  // promoted from shadow to enforcing: the cost-vs-edge bar and the liquidity/spread
  // veto. Unauthenticated + secrets-free (mirrors the other health probes). This is
  // the counter the CTO required ("do not silently enforce with no counter"): it
  // reports, per gate, the CURRENT arm state each live order site reads AND how many
  // armed live evaluations were allowed vs BLOCKED. `armed:false` ⇒ shadow-only (the
  // live path is unchanged); `armed:true` with `evaluated>0, blocked:0` is an armed
  // gate passing everything; `blocked>0` is the direct proof it is biting. Read
  // `durability.ephemeral` FIRST — true ⇒ these counts die on the next redeploy
  // (fix = DATA_DIR=/data, TRA-1719). Live-order flags are read from the PROCESS env
  // only (secret-adjacent — never the demo-flags file).
  app.get('/api/health/live-enforce-gates', (_req, res) => {
    const liveEnv = process.env;
    const nowMs = now();
    const etDay = etDateString(new Date(nowMs));
    const costArmed = isOptionCostGateLiveEnforceEnabled(liveEnv);
    const spreadArmed = isOptionLiquidityLiveEnforceEnabled(liveEnv);
    // TRA-2763 — the LIVE arm of the TRA-1407 OTM entry |delta| floor (gate key
    // `otm_delta_floor`). Same tightening-only / process-env-only contract.
    const otmFloorArmed = isOptionOtmDeltaFloorLiveEnforceEnabled(liveEnv);
    // TRA-3216 — the universe restriction is NOT flag-armed like the three above:
    // it is ON by default and only an explicit `*` turns it off, so its state
    // field is `restricted`, not `armed`. Resolving it here (rather than reporting
    // the raw env var) is what makes a typo'd override visible as
    // `source:'env_invalid'` instead of reading as a deliberate five-name default.
    const universe = resolveLiveOtmUniverse(liveEnv);
    // TRA-3216 — the bar's COMPOSITION, published once. It is identical on every
    // blocked row, so it cannot live in the per-decision `byReason` fold; without
    // it, `byReason`'s shortfall buckets have no scale to be read against.
    const otmBar = describeCostGateBar('single_leg_otm', resolveCostGateConfig(liveEnv));
    // TRA-3272 — the NET-EDGE bar form (per-candidate quote + fees vs k× modeled
    // edge). When armed for `single_leg_otm` it REPLACES the flat bar above for
    // that structure, so `form` says which one the live OTM open actually faces.
    const netEdge = describeNetEdgeBar(liveEnv);
    const netEdgeGovernsOtm = netEdge.enabled && netEdge.structures.includes('single_leg_otm');
    // TRA-3483 — the counterfactual k-sweep replays the k-INDEPENDENT absolute
    // ceiling from the RESOLVED config, not from a literal: a sweep computed
    // against a ceiling nobody could arm would be a counterfactual for a form
    // that does not exist. `netEdge.enabled` is irrelevant here — the recorder
    // publishes regardless, and that is exactly what keeps the flag OFF.
    const summary = summarizeLiveEnforceGate(etDay, {
      absCostFracCeiling: netEdge.absCostFracCeiling,
    });
    // TRA-3401 — the nominator's live arm state. Read from `liveEnv` (process
    // env), the same source the live scan consults; the demo-flag store governs
    // demo only and must never be what a real-money arm is read off.
    const admissibleStrikeArmed = isOtmAdmissibleStrikeEnabled(liveEnv);
    const admissibleStrikeBand = resolveAdmissibleBand(liveEnv);
    const anyArmed = costArmed || spreadArmed || otmFloorArmed;
    res.json({
      ok: true,
      time: new Date(nowMs).toISOString(),
      build: resolveBuildInfo(),
      etDay,
      // The arm each live order site actually consults, plus its flag name for ops.
      arm: {
        costBar: {
          flag: OPTION_COST_GATE_LIVE_ENFORCE_FLAG,
          armed: costArmed,
          /**
           * TRA-3216 — the resolved `single_leg_otm` bar and where it comes from.
           * `barPinnedByFloor:true` means OPTION_COST_GATE_MIN_GROSS_R is holding
           * the bar and retuning COMMISSION_R / SPREAD_CROSS_R alone is a NO-OP —
           * the single most common way a "retune" ships and changes nothing.
           */
          bar: otmBar,
          /**
           * TRA-3272 — which FORM the live `single_leg_otm` cost bar runs:
           * `flat` (the constant `bar.barR` above) or `net_edge` (per-candidate
           * quote + fees vs k× modeled edge; `bar` above is then NOT what the
           * OTM open faces). Structures outside `netEdge.structures` keep the
           * flat form regardless of the flag.
           */
          form: netEdgeGovernsOtm ? 'net_edge' : 'flat',
          netEdge,
          /**
           * TRA-3391 — the EDGE side of the bar. It is no longer
           * `3·|delta| − 1`; it is the lower 95% CI bound of the candidate's
           * measured `structure × |delta| bucket` cell. Published here so the
           * arm block says which estimator is in force, with the OTM cells and
           * the fold's freshness inline — `generation: 0` means nothing has been
           * folded and every candidate is declining `insufficient_evidence`.
           * The full table is `/api/health/option-expectancy-table`.
           */
          edge: {
            estimator: 'tape_expectancy_lower_ci95',
            issue: 'TRA-3391',
            minCellN: TAPE_EXPECTANCY_MIN_CELL_N,
            freshness: tapeExpectancyCache().freshness(),
            otmCells: (tapeExpectancyCache().peek()?.cells ?? [])
              .filter((c) => c.structure === 'single_leg_otm')
              .map((c) => ({
                bucket: c.bucket,
                n: c.n,
                meanR_gate: c.meanR_gate,
                seR_gate: c.seR_gate,
                lowerCI95: c.lowerCI95,
                barR: c.barR,
                admits: c.admits,
              })),
          },
        },
        /**
         * TRA-3394 item 1 — the CEILING, the upper edge of the TRA-3392 band.
         * `mode: 'off'` means the live admitted set is still [0.495, inf) while
         * the authorization is [0.495, 0.55) — the gate is shipped and dark, by
         * design, pending a CTO arm. Full band table and per-band counters at
         * /api/health/otm-sleeve-mandate.
         */
        entryDeltaCeiling: {
          issue: 'TRA-3394',
          authorization: OTM_SLEEVE_MANDATE_ISSUE,
          flag: OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG,
          observeFlag: OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG,
          ...resolveEntryDeltaCeilingLive(OTM_SLEEVE_MANDATE_STRUCTURE, liveEnv),
          reasonCode: ENTRY_DELTA_CEILING_REASON_CODE,
          gates: [ENTRY_DELTA_CEILING_GATE, ENTRY_DELTA_CEILING_SHADOW_GATE],
        },
        spread: { flag: OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG, armed: spreadArmed },
        universe: {
          var: OPTION_LIVE_OTM_UNIVERSE_VAR,
          /** FALSE only under an explicit `*` / `ALL`; every other outcome restricts. */
          restricted: universe.restricted,
          /** The list the live scan actually enforces (resolver output). Empty ⇒ unrestricted. */
          symbols: universe.symbols,
          /** `default` | `env` | `env_unrestricted` | `env_invalid` — `env_invalid` means someone set a value that did not parse and believes something else is in force. */
          source: universe.source,
          /** RAW env value, so a fallback is visible rather than inferred. */
          raw: universe.raw,
        },
        /**
         * TRA-3401 — the OTM strike NOMINATOR, which is upstream of every gate
         * below and was the actual suppressor: the legacy `find` returned the
         * top-|mispricingPct| contract with no reference to delta, so the cost
         * bar rejected a structurally inadmissible nominee and the `continue`
         * discarded the whole symbol for that scan.
         *
         * This is a SELECTOR, not a gate — it records no live-enforce verdict, so
         * `byGate` below can never show it and "armed but nothing in band" would
         * otherwise read EXACTLY like "never armed". That is why the arm state is
         * published here: an armed real-money selector with no readable arm
         * surface is the same instrument failure this route exists to prevent.
         *
         * `band` is the RESOLVED band (env override or the TRA-3392 ratified
         * default), and the raw env values sit beside it so a malformed knob —
         * which silently falls back — is visible rather than inferred.
         */
        admissibleStrike: {
          issue: 'TRA-3401',
          authorization: OTM_SLEEVE_MANDATE_ISSUE,
          flag: OTM_ADMISSIBLE_STRIKE_FLAG,
          armed: admissibleStrikeArmed,
          band: admissibleStrikeBand,
          minValueRaw: liveEnv[OTM_ADMISSIBLE_DELTA_MIN_VAR] ?? null,
          maxValueRaw: liveEnv[OTM_ADMISSIBLE_DELTA_MAX_VAR] ?? null,
        },
        otmDeltaFloor: {
          flag: OPTION_OTM_DELTA_FLOOR_LIVE_FLAG,
          armed: otmFloorArmed,
          /** The |delta| floor the armed gate enforces (resolver output — what the engine actually uses). */
          floor: resolveOptionOtmDeltaFloorLive(liveEnv),
          /** The RAW env value, so a typo'd `OPTION_OTM_DELTA_FLOOR_LIVE` (which falls back to the default) is visible, not inferred. */
          floorValueRaw: liveEnv[OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR] ?? null,
        },
      },
      tighteningOnly: true,
      // Every gate here can ONLY add rejections (TRA-1897-HOLD-safe); none loosens.
      ...summary,
      // TRA-3216 — the universe restriction is a live rejection path that is ON by
      // DEFAULT, so it has to enter this sentence. Before this ticket the
      // `!anyArmed` branch asserted the live path was "byte-for-byte ... no
      // rejection", which would now be FALSE while reading exactly as before —
      // the precise instrument failure this route exists to prevent.
      // TRA-3401 — the SHADOW-ONLY branch asserts the live path is "byte-for-byte
      // the pre-TRA-2048 behaviour". An ARMED nominator falsifies that sentence
      // even though it adds no rejection: it changes WHICH contract is nominated,
      // so the claim has to answer to the selector as well as to the gates.
      note:
        !anyArmed && !universe.restricted && !admissibleStrikeArmed
          ? `SHADOW-ONLY: all live enforcement flags OFF and the live OTM universe is UNRESTRICTED (${OPTION_LIVE_OTM_UNIVERSE_VAR}=${universe.raw ?? ''}) — the live options path is byte-for-byte the pre-TRA-2048/pre-TRA-2763 behaviour (no rejection) AND real money can open on any of the ~614 watchlist names, which is the TRA-3216 defect. Arm as an ops action: ${OPTION_COST_GATE_LIVE_ENFORCE_FLAG}=1, ${OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG}=1 and/or ${OPTION_OTM_DELTA_FLOOR_LIVE_FLAG}=1 (+ ${OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR}=<floor>) on bqb1 (process env, never demo-flags); unset ${OPTION_LIVE_OTM_UNIVERSE_VAR} to restore the allowlist.`
          : `ENFORCING (live): universe=${universe.restricted ? `RESTRICTED to [${universe.symbols.join(',')}] (${universe.source})` : `UNRESTRICTED — all ~614 watchlist names tradeable with real money (${OPTION_LIVE_OTM_UNIVERSE_VAR}=${OPTION_LIVE_OTM_UNIVERSE_UNRESTRICTED})`}, cost_bar=${costArmed ? (netEdgeGovernsOtm ? `ARMED in NET_EDGE form (TRA-3272: block when cost > k=${netEdge.k} × modeled edge; fees $${netEdge.feesPerContractRoundTrip}/contract RT; abs ceiling ${(netEdge.absCostFracCeiling * 100).toFixed(0)}% of premium — arm.costBar.bar is NOT what the OTM open faces)` : `ARMED at ${otmBar.barR.toFixed(3)}R${otmBar.barPinnedByFloor ? ' (PINNED BY THE MIN_GROSS FLOOR — retuning commission/spread alone is a no-op)' : ` (dominant term ${otmBar.dominantTerm})`}`) : 'off'}, spread=${spreadArmed ? 'ARMED' : 'off'}, otm_delta_floor=${otmFloorArmed ? `ARMED at |delta| >= ${resolveOptionOtmDeltaFloorLive(liveEnv)}` : 'off'}, otm_nominator=${admissibleStrikeArmed ? `ARMED into |delta| [${admissibleStrikeBand.min}, ${admissibleStrikeBand.max}) (TRA-3401 — a SELECTOR upstream of every gate here: it makes no verdict of its own, so it is not a row in byGate; since TRA-3510 it is instead an AXIS ON every gate, \`bySelection\` — see the paragraph at the end)` : 'off (legacy top-|mispricingPct| nominee, delta-blind)'}. Per gate, blocked>0 is the direct evidence it is biting; evaluated>0 with blocked=0 is an armed gate passing every candidate it saw. On the universe axis ONLY, evaluated=0 is ambiguous unless read with arm.universe.restricted — an unrestricted universe records no verdict at all. byReason splits the BLOCKS (cost_bar buckets the shortfall below arm.costBar.bar.barR, so "how much would I have to move the bar" is answered off recorded data); byBook names the live books each gate actually governed, so a fleet claim is checkable rather than assumed from a process-level flag. ⚠️ The universe cut runs BEFORE the cost bar, so cost_bar's denominator STEPS DOWN when the allowlist first takes effect — do not compare a post-TRA-3216 block rate to a pre one. Read retained for the multi-day fold (a one-day counter self-clears at ET midnight) and durability.ephemeral before trusting any count. ⚠️ TRA-3391 changed what cost_bar's edge IS: it is now the LOWER 95% CI bound of the candidate's measured tape cell (arm.costBar.edge), not \`3·|delta| − 1\`. Two consequences for this payload — (1) \`byReason\` now carries \`insufficient_evidence\`, which means WE NEVER MEASURED THAT CELL and is NOT \`gross_negative\` (a measured loser). ⚠️ TRA-3401 — do NOT scope that by symbol: the cell key is \`structure × |delta| bucket\` with NO symbol axis, so the universe restriction does not scope the fold. "On the restricted live universe the tape holds 471 rows, ALL |Δ| < 0.20" describes where the live sleeve has historically NOMINATED, NOT the evidence a candidate in the admitted band is decided under — that band is pooled across every symbol and mode, and it ADMITS. Reading the 471 the other way reported an evidence deadlock that does not exist. (2) \`byCell\` names the cell each verdict was decided under, admits included — cross-read it against /api/health/option-expectancy-table, which publishes n / mean / SE / lowerCI95 / admits per cell. ⚠️ TRA-3483 — \`byGate[cost_bar]\` now also carries \`costRQuantiles\` and \`netEdgeShadow\`, and BOTH ARE RECORDERS: \`${netEdge.flag}\` is ${netEdge.enabled ? 'ARMED' : '\`false\`'} and nothing in either block feeds a verdict. They exist because \`k\` is a RATIO — \`admit ⟺ costR ≤ k · modeledGrossR\` — and the deployed surface published the DENOMINATOR only (the expectancy table's per-cell lowerCI95), while every row inside a cell shares that same denominator. \`costR\` is therefore the ONLY axis \`k\` can discriminate on, and it is now emitted per decision, admits included, in the same \`R_gate\` unit as \`barR\`, split into \`spreadR\` (the candidate's own quote cross) and \`feeR\` (the $${netEdge.feesPerContractRoundTrip}/contract RT floor). \`netEdgeShadow.sweep\` replays the net-edge admit rule at 8 candidate \`k\` on those recorded rows and reports \`medianNetR_admitted\` = median(modeledGrossR − costR) over what each \`k\` would admit, against \`flatFormAdmits\` — the DEPLOYED form's admits on the IDENTICAL row set, so the comparison is paired. Read \`rowsEvaluated\` vs \`rowsRecorded\` / \`rowsMissingCostR\` FIRST: a row whose quote was unusable produces no cost sample and is excluded from the sweep denominator (under the real form it would be a \`net_edge_quote_unusable\` block at every k), and \`samplesDropped > 0\` means the quantiles are over a truncated head. \`rowsMissingGrossR\` counts evaluated rows whose edge was unknown — those fail closed at every \`k\` and are IN the denominator, because an unknown edge is a real block, not missing cost data. ⚠️ TRA-3483 (D2) — each gate also publishes \`blockedUnclassified\`: BLOCKED rows carrying no \`reasonCode\`, which \`byReason\` cannot see. Every \`byReason.share\` is of \`blocked\`, which INCLUDES those rows, so when \`blockedUnclassified > 0\` the rows DO NOT sum to 1 and the gap is COVERAGE, not a residual bucket. On the retained fold this is the pre-stamping backlog that made \`gross_negative\`'s share read as a rate. ⚠️ TRA-3510 — every gate now also carries \`bySelection\`: which TRA-3401 NOMINATOR BRANCH produced the candidate each verdict ruled on (\`in_band\` | \`fallback_top_mispricing\` | \`legacy\`), admits included, with \`meanCheapConsidered\` / \`meanCheapInBand\` over their own \`rowsWithChainShape\` denominator. READ THIS BEFORE QUOTING ANY ZERO ON A DELTA GATE. The selector runs upstream of every gate here, and on its \`in_band\` branch the nominee's |Δ| is inside [${admissibleStrikeBand.min}, ${admissibleStrikeBand.max}) BY CONSTRUCTION — so it cannot breach a ceiling at the band's own max, and it cannot breach a floor at or below the band's min. \`entry_delta_ceiling_shadow.blocked === 0\` and \`otm_delta_floor.blocked === 0\` therefore have two byte-identical causes — "the selector clamped every row into the band" (a vacuous zero, arithmetic) and "the far tail was nominated and genuinely did not breach" (a measurement) — and \`bySelection\` is the ONLY axis on this payload that separates them. Rows concentrated on \`in_band\` ⇒ do not publish that zero as a tail estimate. An EMPTY \`bySelection\` on a gate with \`evaluated > 0\` means those rows predate this axis or came from a non-OTM path (RV / directional cost_bar rows carry no nominator); it never means one branch produced them all. ⚠️ TRA-3510 also HOISTED \`otm_delta_floor\` above the cost bar, joining the ceiling TRA-3504 hoisted: both edges of the ratified band are now on the same side of it. Consequence for this payload — when the floor is armed, a sub-floor candidate attributes to \`otm_delta_floor\` instead of \`cost_bar\`/\`gross_negative\`, and \`cost_bar\`'s denominator steps DOWN by exactly the floor's blocked count. That is correct attribution, not a regression; do not compare a post-arm cost_bar rate to a pre-arm one.`,
    });
  });

  // TRA-2930 (from the TRA-2928 ruling, D1) — DURABLE per-book EOD
  // archive-participation record. Unauthenticated + secrets-free (usernames only, no
  // balances, same basis as the other health probes).
  //
  // The question this answers, which nothing else could: when a book has no EOD ledger
  // row for a session, WHY. TRA-2903 found `enock` missing 28 consecutive sessions and
  // the cause could not be recovered, because the two candidates are swallowed and
  // leave an identical signature — a boot-time `initUserContext` throw that drops the
  // book out of `getAllUserContexts()` for the life of the process (candidate a), and
  // `generateAndSaveReport` throwing inside the archive loop (candidate b). Render log
  // retention did not reach the onset. This route makes the next one attributable at
  // the moment it happens:
  //
  //   `absent_from_context_map` -> candidate (a). The book is in users.json but the
  //                                archive loop never reached it. Look at boot.
  //   `report_threw`            -> candidate (b), with the message. Look at the report.
  //   `archive_threw`           -> the per-book body died before the report was reached.
  //   `participated`            -> the row was written. Not a miss.
  //   `skipped_not_market_day`  -> weekend/holiday, no stock row expected. Not a miss,
  //                                and excluded from the participation denominator.
  //
  // Read in this order:
  //  1. `durability.ephemeral` — TRUE ⇒ every row dies on the next redeploy and this
  //     is a since-boot counter wearing a ledger's clothes (fix = DATA_DIR=/data).
  //  2. `verdict` — `null` is BLIND, not clean: a recorder that has never seen an
  //     archive pass and a perfect record are the same reading on every count in this
  //     payload, so they are given different values. `blindReason` says which.
  //     `session_anomalies` means the archive's own `marketDay` flag disagrees with
  //     the independent calendar (TRA-3284) — the denominator itself is untrusted, so
  //     it dominates `misses` and makes `clean` unreachable.
  //  3. `marketDayRuns` vs `calendarSessionRuns` — the recorded denominator next to
  //     the calendar-derived one. Equal counts do NOT imply agreement (08-05..08-10
  //     read 4 vs 4 with different member days); `anomalies` names the disagreements.
  //  4. `anomalies` — session-calendar disagreements first (lost/phantom sessions),
  //     then books with at least one miss, worst first.
  //     `consecutiveMisses` is the TRA-2903 shape; it read 28 there.
  //
  // Per-book `participationRate` is `null` on an empty cohort, never 0 and never 1 — a
  // book observed on no market day must not read like one that participated in all.
  // Observe-only: reading this never routes an order or changes an archive.
  // TRA-3449 — the durable, queryable record of the LIVE-MONEY NAV tripwire.
  //
  // Read this to answer "did the check run, and what did it say?" for any day in the
  // window. The two questions the routine-only mechanism could not answer:
  //
  //  - `coverage.marketDaysMissing` — sessions with NO row at all. The instrument this
  //    replaces had `status: active` and `enabled: true` through three consecutive lost
  //    fires; the arming fields read IDENTICALLY in the covered and uncovered state. Here
  //    a non-run is a first-class `missing` day, derived from the EXCHANGE CALENDAR rather
  //    than from the rows — a denominator taken from the rows would have reported 100%
  //    coverage over the exact week that had 0%.
  //  - `byDay[].verdict` — `fail` (a live book overstated NAV / lost an EOD row / went
  //    tail-stale), `blind` (not graded — includes an ungraded live book), `vacuous`,
  //    `clean`, or `missing`. `blind` is deliberately NOT folded into `fail`: `v0nni` is live with
  //    $25,000 and has not filled yet, so it is ungraded every day until TRA-3417 lands,
  //    and a gate that published a red for that would be switched off inside a week.
  //    `blind` is still `alarm: true` and still not clean — the book is NAMED with the
  //    reason it could not be graded, so it is not silent either.
  //  - `vacuity` (TRA-3450) — the tripwire RAN and had NOTHING to grade. `livePriorOptionsLagOk`
  //    is `true` today over an EMPTY pair set: `admin`'s last non-zero `stockDaily` is
  //    2026-07-29, one session BEFORE its own 07-30 live-options onset, so its post-onset
  //    trip-capable denominator is 0 and `v0nni` has never traded. A gate keyed on the scalar
  //    alone would read green forever. `vacuous` is its own persisted verdict, never folded
  //    into `clean` and never into `blind` — read `vacuity.sessionsWithTripCapableEvidence`
  //    before quoting this instrument as evidence that anything is being watched.
  //
  // Nothing here keys on `ok`, `drift`, `maxDriftUsd`, or `eodInteriorAbsentOk` — the
  // endpoint's own `ungradeableFields` (TRA-2630 Defect A). If the served list ever grows
  // to cover an operand this gate DOES use, that axis grades `blind`, not green.
  // Observe-only: reading this never routes an order.
  app.get('/api/health/live-nav-tripwire', (_req, res) => {
    const nowMs = now();
    const summary = summarizeLiveNavTripwire();
    res.json({
      ok: true,
      time: new Date(nowMs).toISOString(),
      build: resolveBuildInfo(),
      etDay: etDateString(new Date(nowMs)),
      ...summary,
      note:
        summary.verdict === null
          ? 'BLIND — no NYSE session in the window. Not a clean bill of health.'
          : summary.verdict === 'fail'
            ? `FAIL — live-money NAV tripwire fired. Last fail ${summary.lastFailDay}. See byDay[].axes and lagBooks.`
            : summary.consecutiveMissingSessions > 0
              ? `WRITER DOWN — ${summary.consecutiveMissingSessions} consecutive session(s) with no assertion row. Realized coverage ${summary.coverage.marketDaysRecorded}/${summary.coverage.marketDaysExpected}. This is the TRA-3449 failure mode itself, one layer down.`
              : summary.verdict === 'blind'
                ? `BLIND — graded, not clean. ${summary.coverage.marketDaysMissing.length} missing session(s); latest ungraded books: ${
                    (summary.latest?.ungradedBooks ?? []).map((b) => `${b.username}=${b.reason}`).join(', ') || 'none'
                  }.`
                : summary.verdict === 'vacuous'
                  ? `VACUOUS — the tripwire RAN and had NOTHING to grade. ${summary.vacuity.consecutiveVacuousSessions} consecutive graded session(s) with a ZERO post-onset trip-capable denominator; ${summary.vacuity.sessionsWithTripCapableEvidence}/${summary.coverage.marketDaysRecorded} recorded session(s) carried any evidence. Books at zero: ${
                      summary.vacuity.vacuousBooks.map((b) => `${b.username}=${b.reason}`).join(', ') || 'none'
                    }. This is NOT a pass — see TRA-3450.`
                  : `CLEAN — every NYSE session in the window has a graded, passing row over a NON-EMPTY post-onset trip-capable denominator (${summary.coverage.marketDaysRecorded}/${summary.coverage.marketDaysExpected}).`,
      /**
       * RECORDED, NOT GRADED. `liveEodInteriorAbsentBooks` is the TRA-2943 discriminator
       * of record, and it is non-empty today on both live books (2026-08-07, a date NOT in
       * the TRA-2886 documented permanent gap). Gating on it would ship a born-red gate.
       * Diff this across consecutive `byDay` rows to detect a NEW interior absence.
       */
      interiorAbsentNote:
        'liveEodInteriorAbsentBooks is recorded on every row but NOT graded — see TRA-3449. Promoting it needs a pinned known-hole baseline first.',
    });
  });

  app.get('/api/health/eod-archive-participation', (_req, res) => {
    const nowMs = now();
    const summary = summarizeEodArchiveParticipation();
    const sessionAnoms = summary.anomalies.filter(
      (a): a is EodParticipationSessionAnomaly => a.kind !== 'book',
    );
    const bookAnoms = summary.anomalies.filter((a) => a.kind === 'book');
    res.json({
      ok: true,
      time: new Date(nowMs).toISOString(),
      build: resolveBuildInfo(),
      etDay: etDateString(new Date(nowMs)),
      ...summary,
      note:
        summary.verdict === null
          ? `BLIND — no gradeable archive pass on record. ${summary.blindReason ?? ''} This is NOT a clean bill of health.`
          : summary.verdict === 'session_anomalies'
            ? `SESSION-CALENDAR DISAGREEMENT on ${sessionAnoms.length} day(s): ${sessionAnoms
                .map((a) => `${a.etDay}=${a.kind}`)
                .join(
                  ', ',
                )}. The archive's recorded marketDay contradicts the independent NYSE calendar, so the participation denominator (marketDayRuns=${summary.marketDayRuns} vs calendarSessionRuns=${summary.calendarSessionRuns}) cannot be trusted and NO clean bill is possible — a lost session is a fleet-wide miss reclassified as "never owed", a phantom session is fabricated evidence of health (TRA-3267/TRA-3284).${bookAnoms.length > 0 ? ` Additionally ${bookAnoms.length} book(s) carry ordinary misses — read their lastOutcome.` : ''}`
            : summary.verdict === 'clean'
              ? `CLEAN over ${summary.marketDayRuns} market-day archive pass(es) (${summary.firstDay ?? '-'}..${summary.lastDay ?? '-'}), calendar-confirmed (calendarSessionRuns=${summary.calendarSessionRuns}, zero disagreements): every roster book produced an EOD row on every one. Both denominators are published because "clean" and "never observed" are otherwise the same reading.`
              : `MISSES: ${bookAnoms.length} book(s) missed at least one market-day archive pass over ${summary.marketDayRuns} pass(es). Read each anomaly's lastOutcome — absent_from_context_map is a BOOT failure (candidate a, look at initUserContext / initAllUserContexts), report_threw is a REPORT failure (candidate b, lastReason carries the message). That discrimination is the whole reason this record exists (TRA-2930).`,
    });
  });

  // TRA-3116 — the READ side of the TRA-2689 denominator-flip tape.
  //
  // Parts 1-3 of the ruling made the tape survive a restart and stamp its own
  // coverage. This is what makes those fields gradeable from outside the box:
  // the part-5 promotion bar is defined entirely over `coverageComplete`,
  // `saturated`, `truncatedForSize` and `droppedOnMerge`, and until this route
  // existed nothing could read any of them, so the bar was unreachable for the
  // second time on the same ticket.
  //
  // Read in this order:
  //  1. `verdict` — TRI-STATE. `null` is BLIND, not clean: no tape written yet
  //     and a perfect record must not be the same reading. `blindReason` says so.
  //  2. The triple `complete` / `partial` / `absent`. Never quote `complete`
  //     alone — a bar reporting "8 of 10 clean" over a silently shrunken
  //     denominator is the exact failure TRA-3116 exists to close, so partial
  //     sessions are retained and annotated and absent MARKET days are counted.
  //  3. `sessions[].disqualifiers` — why a session did not count, by name.
  //     `coverageComplete:absent` means a pre-fix file, which is NOT a pass.
  //  4. `rowsLostToRestart` is tri-state and never a positive integer: `0` only
  //     under proven full coverage, `null` when rows died with their process.
  //  5. TRA-3494 — `sessionsTowardBar` is a count of ET MARKET DAYS on the
  //     LIVE-MONEY cohort, NOT of book-days. Do not compare it to `complete`:
  //     `complete` pools 66 books and read 64/10 on night one. The pooled number
  //     is still here as `completeBookSessions`, it just gates nothing. Read
  //     `barDays[]` beside it — `live` is tri-state (`counted`/`failed`/
  //     `vacuous`/`in_flight`), and NONE of those is a soft version of another.
  //     `vacuous` = empty live cohort that day. `in_flight` = the session is
  //     still open; the CURRENT day always reads that way at the 21:15 ET fire,
  //     because the ~23:45 ET EOD drain has not landed and the day is graded
  //     against an RTH window it has not lived through yet. It is NOT a failure.
  //     `barDaysWithLiveAbsence > 0` does not stop the count but does block
  //     promotion until the absence is explained.
  //
  // Observe-only: the trading path never reads the tape, and nothing here feeds
  // a decision inside the process. Boundary unchanged.
  if (deps.denominatorFlipTape) {
    const tape = deps.denominatorFlipTape;
    app.get('/api/health/denominator-flip-tape', async (_req, res) => {
      const nowMs = now();
      try {
        const summary = await tape();
        res.json({
          ok: true,
          issue: 'TRA-3116',
          time: new Date(nowMs).toISOString(),
          build: resolveBuildInfo(),
          etDay: etDateString(new Date(nowMs)),
          ...summary,
          note:
            summary.verdict === null
              ? `BLIND — ${summary.blindReason ?? 'no tape on record'}. This is NOT a clean bill of health.`
              : `${summary.sessionsTowardBar}/${summary.barTarget} toward the bar, UNIT = ${summary.barUnit} (TRA-3494: distinct ET market days on the LIVE-MONEY books, NOT book-days — the pooled book-day count is ${summary.completeBookSessions} and gates nothing). DAY LEDGER: ${summary.sessionsTowardBar} counted / ${summary.barDaysFailed} failed / ${summary.barDaysVacuous} vacuous (empty live cohort — neither a credit nor a failure) / ${summary.barDaysInFlight} in-flight (session still OPEN, no EOD drain yet — NOT a failure; the current day reads this way at every 21:15 ET fire by construction)${summary.barDaysWithLiveAbsence > 0 ? `; ${summary.barDaysWithLiveAbsence} day(s) with a live book ABSENT — these do NOT reduce the count but DO block promotion until explained` : ''}${summary.unclassifiedModes.length > 0 ? `; ⚠ UNCLASSIFIED MODE(S) ${summary.unclassifiedModes.join(', ')} — the live cohort may be under-read` : ''}. Rejected quorums, published so this cannot be cherry-picked: any-book ${summary.barDaysAnyBook}, all-books ${summary.barDaysAllBooks}. TRIPLE: ${summary.complete} complete / ${summary.partial} partial / ${summary.absent} absent BOOK-DAY sessions. A session counts ONLY with coverageComplete && !saturated && truncatedForSize===0 && droppedOnMerge===0; rows.length===0 under complete coverage COUNTS. Partial sessions are retained and annotated, never excluded.`,
        });
      } catch (err: unknown) {
        // An instrument may not take the box down, and it may not report a read
        // failure as an absence of findings either.
        res.status(200).json({
          ok: false,
          issue: 'TRA-3116',
          time: new Date(nowMs).toISOString(),
          verdict: null,
          blindReason: err instanceof Error ? err.message : String(err),
          note: 'BLIND — the tape summary could not be read. This is NOT a clean bill of health.',
        });
      }
    });
  }

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
  app.get('/api/health/option-spread-cost', async (req, res) => {
    const dir = process.env.DATA_DIR;
    const env = dir ? resolveDemoFlagEnv(dir) : process.env;
    const config = resolveCostGateConfig(env);

    // TRA-2316 — optional `?sinceTs=` (epoch ms) cohort filter on the ENTRY
    // timestamp, so the TRA-2306 read can be scoped to rows opened FORWARD of the
    // TRA-2295 deploy rather than to the cumulative pool that contains the 59
    // pre-fix breaches. Applied ONCE, above every block below, so the payload can
    // never carry two differently-scoped populations under one 200 (TRA-2082).
    // Absent or unparseable ⇒ no filter, byte-identical to the previous readout.
    const rawSince = (req.query as Record<string, unknown> | undefined)?.sinceTs;
    const parsedSince = typeof rawSince === 'string' ? Number(rawSince) : Number.NaN;
    const sinceTs = Number.isFinite(parsedSince) ? parsedSince : undefined;

    const allRows = await listOptionTradeJournal({ mode: 'demo' });
    const rows = sinceTs === undefined ? allRows : allRows.filter((r) => r.openTs >= sinceTs);
    const samples: SpreadCostSample[] = [];
    // TRA-2316 — the compliance fold sees EVERY row, including the ones with no
    // fill-time quote (passed as `quote: null`), so it can report how many it had
    // to discard. Pre-filtering here would hide the denominator.
    const ceilingSamples: SpreadCeilingSample[] = [];
    for (const r of rows) {
      const accountClass: SpreadCeilingAccountClass =
        typeof r.account !== 'string' || r.account.trim().length === 0
          ? 'unattributed'
          : isTestAccount(r.account)
            ? 'fixture'
            : 'desk';
      // TRA-2350 — the archetype axis. `single_leg_directional` is written by THREE
      // sleeves and only one of them evaluates the ceiling, so the structure key
      // alone cannot name the gated cohort. Absent ⇒ `null`, which the fold buckets
      // as `unspecified` and treats as UNGATED (the AI-Options-Ideas single-leg open
      // in `signal-engine.ts` stamps no archetype and is not gated).
      const entryArchetype =
        typeof r.entryArchetype === 'string' && r.entryArchetype.trim().length > 0
          ? r.entryArchetype
          : null;
      if (
        typeof r.entryBid !== 'number'
        || typeof r.entryAsk !== 'number'
        || typeof r.entryMarkUsd !== 'number'
      ) {
        ceilingSamples.push({ structure: r.structure, accountClass, entryArchetype, quote: null });
        continue;
      }
      const quote = { bid: r.entryBid, ask: r.entryAsk, mark: r.entryMarkUsd };
      ceilingSamples.push({ structure: r.structure, accountClass, entryArchetype, quote });
      samples.push({
        structure: r.structure,
        quote,
        ...(typeof r.contracts === 'number' ? { contracts: r.contracts } : {}),
      });
    }

    // TRA-2316 — the independent read. Grouped by account class so the desk answer
    // is reachable in ONE hop and can never be read off the fixture-polluted pool.
    const ceilingGrid = summarizeSpreadCeilingCompliance(ceilingSamples);
    const ceilingByAccountClass = Object.fromEntries(
      SPREAD_CEILING_ACCOUNT_CLASSES.map((c) => [c, ceilingGrid.filter((s) => s.accountClass === c)]),
    ) as Record<SpreadCeilingAccountClass, SpreadCeilingStat[]>;

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

      // TRA-2316 — the cohort filter ACTUALLY applied, always present so a consumer
      // asserts what it got instead of assuming its query param took effect. `null`
      // = no filter (cumulative pool); never `0`, which is a real epoch. `filterAxis`
      // names the timestamp compared against — `openTs` (ENTRY), not `closeTs`. Every
      // block in this payload is scoped by it, including `byStructure`/`retention`.
      appliedSinceTs: sinceTs ?? null,
      filterAxis: 'openTs' as const,

      // The gate input this probe exists to check. Key kept as `modeledInput` for
      // consumer stability; `source` states its real provenance, which as of
      // TRA-1661 is the measurement below rather than the refuted 1.00R model.
      modeledInput: {
        makerAdjustedSpreadCrossR: config.optionsCost.makerAdjustedSpreadCrossR,
        commissionR: config.optionsCost.commissionR,
        safetyMarginR: config.safetyMarginR,
        barR: admissionBarR('single_leg_otm', config),
        source:
          'MEASURED (TRA-1656 → TRA-1661): shipped default 0.235R = the OTM-sleeve mean cross, applied blended across sleeves. Overridable via OPTION_COST_GATE_SPREAD_CROSS_R. ⚠ TRA-2295 RETRACTS the "conservative — it overcharges RV by ~0.075R" rider that used to end this sentence: that rested on the 0.10 ceiling binding, and it did not bind on the directional sleeve. Pre-TRA-2295 directional fills reached spreadPct 1.933 = 7.73R of true cross, so this input UNDER-billed the worst of them ~33× and the 1.00R predecessor ~7.7×. The rider is expected to hold again forward of the TRA-2295 gate; re-measure `byStructure` on post-fix rows before restating it.',
      },

      // (1) The measurement.
      n: rowsWithQuote,
      byStructure,

      // (1b) TRA-2316 — THE INDEPENDENT CEILING-COMPLIANCE READ (TRA-2306 read #2).
      //
      // `byStructure` above publishes avg/median/p90 over a POOLED set, and until
      // TRA-2382 nothing there was a max at all (`maxSpreadCrossR` was the CONFIGURED
      // ceiling echoed under a measured-sounding name — 0.400 next to a p90 of 3.15).
      // Even with the real `observedMaxSpreadCrossR` TRA-2382 added, that rollup still
      // cannot answer "0 rows above the ceiling": it carries the `qa_*` / `ctoverify*`
      // fixture mirror that inflates `n` and drags the distribution (TRA-2100), it
      // pools gated and ungated archetypes (TRA-2350), and a max alone is not a breach
      // COUNT. This block is the one to grade — a true max AND a strict breach count,
      // partitioned on `account` and on whether the row's entry path ran the gate.
      //
      // Independence is the point. `/api/health/cost-aware-gate` →
      // `maxAdmittedSpreadPct` is the only other true max in the system, and it is
      // written BY THE GATE, from the gate's own view of what it admitted. A gate
      // that records its own admissions cannot falsify itself. This number is
      // re-derived from the journal's `entryBid`/`entryAsk`/`entryMarkUsd` — the
      // quote that SET THE FILL — with no reference to any counter the gate wrote,
      // so the two can be compared and a disagreement means something.
      //
      // READ IT LIKE THIS. For the TRA-2306 grade, the single cell that matters is
      // `byAccountClass.desk` where `structure === 'single_leg_directional'` — and
      // WITHIN that cell, the `gated` sub-object, NOT the pooled top level:
      //   gated.n: 0 (all null)            ⇒ NO READING. Not a pass. The desk book
      //                                      opened no GATED directional entries in
      //                                      scope; check `rowsDroppedNoQuote` before
      //                                      concluding it was quiet rather than
      //                                      unmeasurable.
      //   gated.n > 0, countAboveCeiling 0 ⇒ the check RAN over n real rows and found
      //                                      none over 0.10. That is the PASS.
      //   gated.countAboveCeiling > 0      ⇒ falsification. The gate is not holding,
      //                                      and `gated.maxSpreadPct` says by how much.
      // Scope it to post-deploy entries with `?sinceTs=` — the cumulative pool still
      // contains the 59 pre-TRA-2295 breaches and will never read 0.
      //
      // ⚠ TRA-2350 — WHY `gated`, AND NOT THE POOLED CELL. This block used to say the
      // three lines above about the cell's TOP-LEVEL numbers, and that instruction was
      // wrong in the direction that costs the most: it assumed
      // `single_leg_directional` == the gated sleeve. It does not. THREE call sites in
      // `signal-engine.ts` stamp that structure label — the directional sleeve
      // (`entryArchetype: 'directional'`, the only one TRA-2295 gates), the iv-rv
      // mispricing open, and the AI-Options-Ideas single-leg open (which stamps no
      // archetype at all) — while `spreadCeilingRejectReason` has exactly ONE call
      // site. That census is asserted against the source, with a demonstrated failing
      // state, by the TRA-2306 writer-census test in `option-spread-cost.test.ts`; the
      // `file:line` form it used to be written in had drifted 47–56 lines and one of
      // the citations had come to resolve onto a DIFFERENT gate carrying the same
      // literal — a wrong citation that confirms itself. Grep the SYMBOL. So a
      // wide-spread fill from either ungated sleeve landed in this cell and read as
      // "TRA-2295 enforcement falsified", and the paragraph above told the grader to
      // re-open a correct ticket. A FALSE FAIL, manufactured by the instrument.
      //
      // Note the asymmetry that kept it quiet: the TELEMETRY side
      // (`/api/health/cost-aware-gate` → `spreadCeilingEvaluated`) is written only by
      // `recordSpreadCeilingDecision` from that single gated site, so on the SLEEVE axis
      // it counts the directional sleeve alone and is clean. Only THIS journal-derived
      // side pooled sleeves. The two are published as independent confirmations of each
      // other, which means that before the split a disagreement between them had two
      // indistinguishable causes — a real enforcement failure, or an ungated sleeve
      // trading wide. `gated`/`ungated`/`byArchetype` separate them; `gatedArchetypes`
      // states the partition rule in the payload so a consumer asserts it instead of
      // assuming it.
      //
      // ⚠ TRA-2355 — "CLEAN ON THE SLEEVE AXIS" IS NOT "CLEAN". The sentence above was
      // read as a general endorsement of the telemetry arm, and on the ACCOUNT axis the
      // arm was blind: the ledger is module-global while `SignalEngine` is constructed
      // per username, so ~51 QA fixture books tallied into the same counters as the desk
      // and `spreadCeilingEvaluated > 0` never meant the DESK's gate ran. Same pooling
      // defect as this route's, one axis over, discovered one ticket later.
      // `spreadCeilingByAccountClass.desk` on that route is the fixed read, and it is the
      // cross-check partner of `byAccountClass.desk[...].gated` here — compare LIKE
      // COHORTS or the comparison manufactures its own disagreement.
      //
      // Empirically the pooling had not bitten as of 2026-07-26 (iv-rv last fired
      // 2026-07-02T16:37Z; AI-ideas has produced 0 rows under the label) — but that is
      // an EMPIRICAL zero and it expires. The partition is the structural one.
      ceilingCompliance: {
        byAccountClass: ceilingByAccountClass,
        // TRA-2948 — the classifier this payload's account classes were computed
        // under, on THIS read. This surface reclassifies the frozen `account`
        // string per request, so a pattern-set edit restates it retroactively —
        // while /api/health/cost-aware-gate froze each decision's class (and
        // stamped this same hash) at decision time. Equal hashes on the two
        // surfaces + `classifier-consistent` on that route's classifierProvenance
        // rules a classifier change OUT of any disagreement between them.
        classifier: testAccountClassifierIdentity(),
        classifierBasis: 'class-recomputed-at-read' as const,
        note:
          'TRA-2316, re-keyed by TRA-2350. TRUE max + strict breach count per (structure × account class × entryArchetype), re-derived from the journal fill-time quote independently of the gate\'s own counters. GRADE `byAccountClass.desk[...].gated` — NOT the pooled top-level numbers on the cell: a structure key is not a sleeve, and `single_leg_directional` is written by three sleeves of which only `entryArchetype: \'directional\'` evaluates the ceiling (`gatedArchetypes` names the set; `ungated` holds the rest; `byArchetype` is the detail). A breach in `ungated` falsifies NOTHING about TRA-2295 — it is a separate question about a sleeve that was never gated. `fixture` is the qa_*/ctoverify* mirror (TRA-2100) and `unattributed` is pre-TRA-1475 rows with no `account` — it is NOT desk. Rows with no measurable two-sided quote DROP OUT of `n` and are counted in `rowsDroppedNoQuote`; they are never counted as zero-spread fills. `null` means NO ROWS TO CHECK and is NOT a pass — only `countAboveCeiling: 0` WITH `n > 0` is. ⚠ TRA-2319 — GATE ON `gated.n > 0`, NEVER on a bare `maxSpreadPct <= ceiling`: this field is `number | null` and `null <= 0.10` is TRUE in JavaScript, so the empty-partition sentinel is SWALLOWED by the obvious predicate and an empty cell reads as a clean pass. `countAboveCeiling` has the same shape (`null` when there was nothing to count) and `null === 0` is false but `null <= 0` is true — compare it with `===`, never with `<=`. Full grid: every sleeve × all three classes is emitted even at n=0, and every DECLARED gated archetype gets a `byArchetype` row even at n=0, because an absent cell reads exactly like a passing one. `gated.n + ungated.n === n` holds by construction; assert it to catch a partition that dropped rows.',
        comparisonBasis:
          'Cross-check against /api/health/cost-aware-gate: `retained.byStructure[...].maxAdmittedSpreadPct` vs `desk[...].gated.maxSpreadPct`. ⚠ TRA-2306 — READ THE QUALIFIER: that payload carries TWO objects named `byStructure`. The top-level one is `byDay.get(etDay)`, the CURRENT ET DAY ONLY, and it is `[]` on a quiet day; `retained.byStructure` folds every retained day including the in-flight one. Cross-checking against the bare name silently compares against an empty day view. ⚠ TRA-2306 — AND THEY DO NOT TRACK EACH OTHER ON THIS BUILD, SO A DIVERGENCE IS NOT A FINDING. TRA-2350 fixed the ARCHETYPE half of this comparison (the gate counter only ever saw the gated cohort, so compare it against `.gated`, not the pooled cell) and left the ACCOUNT half: the gate tally is ONE MODULE-LEVEL COUNTER PER PROCESS keyed (etDay, structure) with NO account axis, so it pools every book the process runs — the whole demo fleet plus the qa_*/ctoverify* mirrors — while `desk[...].gated` is desk-only. Pooled vs desk-only is two populations, and the pooled side is strictly the larger, so `maxAdmittedSpreadPct >= desk gated max` is the EXPECTED relation, not a defect. Until TRA-2355 lands the account axis on the gate counters there is no like-for-like partner here: a non-zero `spreadCeilingEvaluated` does NOT establish that the DESK sleeve ran, and this comparison can neither confirm nor refute that it did. ⚠ TRA-2306 — DO NOT RESOLVE A DISAGREEMENT AS A BOOKKEEPING ARTIFACT. An earlier version of this note pre-attributed any mismatch to a dropped gate counter rather than to a missing fill, on the premise that these tallies are volatile and single-day. That premise is FALSE on this host and is RETIRED — do not reinstate it: `durability.ephemeral` is false, `applyAndAppend` appends every decision to DATA_DIR synchronously, and `hydrateCostAwareGateFromDisk` re-applies each record inside the 7-day retention back into the same `byDay` map with NO exclude-today filter, so a boot REBUILDS the current day and these counters survive a restart exactly as this read does. A lost FILL is the falsification TRA-2306 exists to catch, and a note that pre-attributes disagreement to bookkeeping talks the grader out of the one reading that can fail the grade. The journal is still the tiebreak — because it is account-scoped and durable, NOT because the other side is volatile. ⚠ TRA-2948 — ONE MORE CAUSE OF DISAGREEMENT, NOW SEPARABLE: this side recomputes account class at READ time while the gate froze it at DECISION time, so a BUILTIN_TEST_PATTERNS / TEST_ACCOUNT_PREFIXES edit restates this side\'s history and not the gate\'s — the two then split with no enforcement defect anywhere. Before attributing a mismatch, compare `ceilingCompliance.classifier.hash` here with that route\'s `classifierProvenance`: `classifier-change-in-window` names the edit as a cause and bounds the affected decisions; `classifier-consistent` rules it out.',
      },

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

      // (3) The ceiling — and, since TRA-2295, WHERE IT IS ACTUALLY ENFORCED.
      //
      // ⚠ This block used to publish: "the scanners reject spreadPct > maxSpreadPct
      // BEFORE selection. So no contract these sleeves can buy crosses above its
      // ceiling — independent of which contracts get picked." That sentence was
      // false against the live journal at a 71% rate, and it was load-bearing for
      // TRA-1647's claim that the gate's 1.00R charge is conservative. On the worst
      // admitted contract (spreadPct 1.933) the true cross was 4 · 1.933 = 7.73R, so
      // the gate UNDER-billed it ~7.7× — the opposite direction from the claim.
      //
      // A ceiling is a property of the ENTRY PATH, not of this table, so the table
      // alone can no longer be read as evidence. `enforcedAt` says which paths apply
      // it, and `/api/health/cost-aware-gate` → `byStructure[].spreadCeilingEvaluated`
      // is the live proof for a given sleeve on a given day: 0 means the gate did not
      // run, and `maxAdmittedSpreadPct` above a sleeve's `maxSpreadPct` is a
      // falsification of enforcement that needs no journal query at all.
      ceilings: {
        ...SLEEVE_SPREAD_CEILINGS,
        enforcedAt: {
          single_leg_otm:
            'otm-mispricing.ts:185, inside the OTM scanner chain filter. RUNS. Positive control: live desk journal max spreadPct 0.196 vs the 0.20 ceiling, 0/27 over.',
          single_leg_rv:
            'relative-value.ts:396, inside the RV scanner chain filter — which NEVER RUNS (RV_ENGINE_ENABLED is a compile-time false since TRA-1207/2026-06-30). No live sleeve is gated by this entry.',
          single_leg_directional:
            'signal-engine.ts `spreadCeilingRejectReason`, on the entry path itself, from TRA-2295. Applied to the same quote journaled as entryBid/entryAsk. Before TRA-2295 this sleeve ran NO spread gate: it read raw getSelectorChain rows and 59 of 83 desk entries crossed the 0.10 ceiling, worst 1.933 (19×).',
        },
        note:
          'spreadCrossR = (ask − bid) / (0.25 · mark) = 4 · spreadPct. A ceiling BOUNDS the cross only for a sleeve whose ENTRY PATH evaluates it — see `enforcedAt`, and verify per-day via /api/health/cost-aware-gate (spreadCeilingEvaluated > 0, AND maxAdmittedSpreadPct !== null, AND maxAdmittedSpreadPct <= maxSpreadPct — all three; the null test is not optional, because `null <= 0.10` is TRUE in JS and would read PASS on a gate that admitted nothing, TRA-2319). Do NOT infer a bound from this table alone; that inference is exactly what TRA-2295 falsified.',
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
    // TRA-2049 — arm/config readout of the edge-of-session entry blackout, resolved
    // through the SAME effective env the engine consults (process.env layered with
    // the DATA_DIR demo-flags.json overlay, file wins), so a reader can tell whether
    // a `session_edge_blackout` bucket of 0 is "armed but no entries hit an edge" vs
    // "disarmed, could never increment". DARK by default; tightening-only.
    const sebDir = process.env.DATA_DIR;
    const sebEnv = sebDir ? resolveDemoFlagEnv(sebDir) : process.env;
    const sebArmed = isSessionEdgeBlackoutEnabled(sebEnv);
    const sebMinutes = resolveSessionEdgeBlackoutMinutes(sebEnv);
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      swingModeEnabled: resolveEquitySwingModeEnabled(process.env),
      // TRA-2049 — entries-only edge-of-session blackout arm state. Exits/management
      // are never gated by it. `armed:false` ⇒ the session_edge_blackout reject bucket
      // is structurally 0 (not a dead instrument — it counts the moment it is armed).
      sessionEdgeBlackout: {
        flag: SESSION_EDGE_BLACKOUT_FLAG,
        armed: sebArmed,
        openMinutes: sebMinutes.openMinutes,
        closeMinutes: sebMinutes.closeMinutes,
        entriesOnly: true,
        note: sebArmed
          ? `ARMED: new equity entries suppressed in the first ${sebMinutes.openMinutes} min and last ${sebMinutes.closeMinutes} min of RTH (0 = that edge off); counted under rejectedByReason.session_edge_blackout. Exits/management unaffected.`
          : `DISARMED: set ${SESSION_EDGE_BLACKOUT_FLAG}=1 (render.yaml env or DATA_DIR/demo-flags.json) to arm; tune SESSION_EDGE_BLACKOUT_OPEN_MINUTES / _CLOSE_MINUTES (default 3 each). Tightening-only — never re-enables trading.`,
      },
      // TRA-1834 — demo and live are each a LIST of per-engine blocks, never a single
      // pooled row: the fleet runs >1 demo engine and a halted book must never sum into an
      // active one. Each block carries its own `engineId` + `label` (demo-1, demo-2, …). An
      // EMPTY list is the fleet-level `never_ran` — no engine of that mode has ticked yet.
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
      // TRA-1835 — the bucket ORDER is FIRST-MATCH-WINS (insufficient_candles → off_swing_universe
      // → stale_feed) and that is CORRECT — do not "fix" it. It is what lets a reader derive
      // `stale_feed + symbolsEvaluated = in-universe survivors` and prove the candle cache warmed
      // for the whole universe. The consequence: a `0` in a LATER bucket does NOT mean that gate
      // is idle — it means an EARLIER gate ate the symbol first. Treat the buckets as an ordered
      // sieve, never as independent tallies.
      bucketOrderNote: 'symbolsSkippedByReason buckets are ORDERED, first-match-wins: insufficient_candles → off_swing_universe → stale_feed. A 0 in a later bucket means an EARLIER gate consumed the symbol, NOT that the later gate is idle. This ordering is deliberate and correct — keep it.',
      // TRA-1835 — the count `stale_feed: 4` reads IDENTICALLY whether the 4 dark names are the
      // benign tail (DIA/IWM/XLF) or the high-signal head (NVDA/TSLA/COIN/MSTR). symbolsSkippedSymbols
      // NAMES them so a "the strategy is dry" verdict is not measuring a universe with its best names
      // amputated. IN-UNIVERSE only — off_swing_universe is counted in symbolsSkippedByReason but NOT
      // named (its ~134 skips are the expected off-universe cut). {} = an iterated pass with no
      // in-universe drop (all curated names clean); null = no iterated pass since boot. If a per-reason
      // list is ever capped, symbolsSkippedSymbolsTruncated goes true rather than the list being cut
      // silently. cumulative.symbolsSkippedByName (reason → symbol → n) splits a name dark EVERY pass
      // (dead subscription) from one dark occasionally (jitter) — read each against iteratedPassCount.
      symbolNamesNote: 'lastPass.symbolsSkippedSymbols names the ACTUAL in-universe tickers skipped last pass (reason → string[]); off_swing_universe is intentionally NOT named. {} = iterated pass, no in-universe drop; null = no iterated pass since boot. symbolsSkippedSymbolsTruncated flags a capped list (never silently cut). cumulative.symbolsSkippedByName (reason → symbol → count) is the since-boot per-symbol tally: divide by iteratedPassCount for the dark-rate — 100% ⇒ a broken feed subscription, low ⇒ normal jitter.',
      note: 'candidatesEvaluated is three-valued: null = no ITERATED pass since boot (says nothing about the signal side), 0 = a pass ran and generated NO candidates (THE ALARM — the strategy is dry, no guardrail can be blamed), >0 = ideas exist. If candidatesEvaluated > 0 and admitted = 0, rejectedByReason names the guardrail eating them. passGateBlockedReason is set when the pass FIRED but never iterated (market closed / halted / auto-trading off) — that is NOT a strategy verdict and candidatesEvaluated stays null. Counters are SINCE-BOOT and in-memory by design: DATA_DIR is ephemeral (TRA-1719), so a durable counter here would be pinned at 0 forever; this instrument needs n=1 and reads correctly on the FIRST tick after a deploy. There is deliberately NO min_holding_days bucket — that guardrail gates discretionary CLOSES, never entries, so the bucket could never increment. TRA-1834 — demo/live are LISTS of per-engine blocks (each with engineId + label), never pooled: two demo engines shared one ledger before, and a gated tick on one nulled the other pass mid-sweep, silently DROPPING symbolsEvaluated/symbolsSkippedByReason. passesTruncated is the sentinel — it MUST be 0; a non-zero value means an engineId collision and those two symbol counters are lower bounds, not real counts.',
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

  // TRA-2949 (parent TRA-2946) — unauthenticated, secrets-free readout of the
  // direction-aware swing-exit arms for LIVE options, so an env flip on bqb1 is
  // verifiable without dashboard access. Both live flags resolve from
  // process.env ONLY (live containment — a demo-flags.json write can never arm
  // them); the trading-day time stop itself is baseline engine behaviour for
  // swing-held rows and is published here with its effective override.
  // Read-only, no order path, no balances/PII.
  app.get('/api/health/option-swing-exits', (_req, res) => {
    const rvRetuneLive = isRvExitRetuneLiveEnabled(process.env);
    const tpEarlyLive = isTakeProfitEarlyLiveEnabled(process.env);
    const swingTimeStopTradingDays = resolveSwingTimeStopTradingDays(process.env);
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      // Trading-day time stop for swing-held rows (live PDT-held rows; demo
      // rows under swingHoldOptions). Always on; fires only with no
      // follow-through AND a confirmed trend-against read. 0 = disabled.
      swingTimeStop: {
        env: OPTION_SWING_TIME_STOP_TRADING_DAYS_VALUE,
        tradingDays: swingTimeStopTradingDays,
        default: OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT,
        overridden: swingTimeStopTradingDays !== OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT,
      },
      // LIVE port of the RV exit re-tune: confirmed 2-bar Supertrend flip that
      // only closes a position down ≥20% (winners ride to trail/give-back/TP),
      // plus the same confirm-bars gate on ma20_close_through.
      rvExitRetuneLive: {
        flag: RV_EXIT_RETUNE_LIVE_FLAG,
        enabled: rvRetuneLive,
        confirmBars: RV_EXIT_RETUNE_LIVE_CONFIRM_BARS,
        flipMinLossPctToExit: RV_EXIT_RETUNE_LIVE_FLIP_MIN_LOSS_PCT,
      },
      // LIVE arm of the take-profit-early capture exit (demo cohort: 43/43
      // wins, avgR +1.03). Ships dark; the board arms it by env flip.
      takeProfitEarlyLive: {
        flag: TAKE_PROFIT_EARLY_LIVE_FLAG,
        enabled: tpEarlyLive,
      },
      note: 'Hard exits (premium stop, trail, give-back cap, session stop, take-profit) are unaffected by all of the above and keep firing through the swing hold.',
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
    const fills = summarizeSma200ForwardTestFills(demoModeBooks(deps.fleetBooks?.() ?? []));
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
    // TRA-1591 — optional `?sinceTs=<epoch ms>` scopes the summary fold to the
    // post-arm cohort (entry `openTs >= sinceTs`) so QT can grade the OTM entry
    // delta floor (TRA-1407) in isolation from the historical low-delta bleed.
    //
    // TRA-3380 — a malformed value is now a 400. It used to be IGNORED, which
    // served the cumulative pool behind a 200 whose population was identical to
    // the unfiltered one. `?closedSinceTs=` (alias `?closeTs=`) is the EXIT-axis
    // sibling: same epoch-ms contract, filtering on `closeTs` instead, so an
    // exit-scoped criterion can select its own population.
    const sinceParse = parseCohortTsParam(req.query['sinceTs'], 'sinceTs');
    if (!sinceParse.ok) {
      res.status(400).json({
        ok: false,
        error: sinceParse.error,
        detail: sinceParse.detail,
        filterApplied: false,
        note:
          'The cohort filter could not be applied, so no body is served. A filter that '
          + 'cannot be applied must not return a payload indistinguishable from one that '
          + 'selects everything (TRA-3380).',
      });
      return;
    }
    const sinceTs = sinceParse.value;

    // The exit axis accepts two spellings so the obvious guess is not silently
    // ignored — being quietly dropped is the very defect this ticket fixes.
    const closeRaw = req.query['closedSinceTs'] ?? req.query['closeTs'];
    const closeParamName = req.query['closedSinceTs'] !== undefined ? 'closedSinceTs' : 'closeTs';
    const closeParse = parseCohortTsParam(closeRaw, closeParamName);
    if (!closeParse.ok) {
      res.status(400).json({
        ok: false,
        error: closeParse.error,
        detail: closeParse.detail,
        filterApplied: false,
        note:
          'The cohort filter could not be applied, so no body is served. A filter that '
          + 'cannot be applied must not return a payload indistinguishable from one that '
          + 'selects everything (TRA-3380).',
      });
      return;
    }
    const closedSinceTs = closeParse.value;

    // One axis per response. Serving both would make `filterAxis` — the field a
    // consumer reads to learn WHICH population it got — unable to answer.
    if (sinceTs !== undefined && closedSinceTs !== undefined) {
      res.status(400).json({
        ok: false,
        error: 'cohort_axis_conflict',
        detail:
          'Pass either `sinceTs` (ENTRY axis, openTs) or `closedSinceTs`/`closeTs` (EXIT axis, '
          + 'closeTs) — not both. `filterAxis` names the single axis that served the response.',
        filterApplied: false,
      });
      return;
    }

    // Both cohort params are valid past this point, so the journal load and the
    // weights fold run only for a request that will actually be served.
    const rows = await listOptionTradeJournal();
    // TRA-1046 — serve weights through the intraday refresh cache so the readout
    // shows the same fold live selection reads, plus a freshness generation a
    // probe can watch tick after a demo close.
    const cached = await optionWeightsCache().get();

    // TRA-1133 — opt-in row-level dump for the OOS validation harness (TRA-992 Step
    // 1). `?rows=demo` appends the RESOLVED demo rows (setup key + realizedR +
    // outcome) so an offline run can fold the journal leave-one-out. Same demo-only,
    // secrets-free basis the route already documents — rows carry no balances/PII.
    // TRA-2082 — the dump is built INSIDE the report off the same `sinceTs`-filtered
    // set as the summary; the route must not re-derive it from the unfiltered `rows`.
    res.json(
      buildOptionJournalReport(
        rows,
        now(),
        isOptionTradeJournalEnabled(),
        cached,
        sinceTs,
        // TRA-2193 — `demo` (unchanged) plus `open` / `all`. `summary.open`
        // reported a count of positions that could not be enumerated, so
        // unrealized MTM was unobservable and the mid-vs-bid mark parity work
        // (TRA-2174 / TRA-2131) had nothing to reconcile against. Anything else
        // is passed through as `unknown` → empty dump + `rowsMode: null`, so a
        // typo'd param cannot quietly return a different population.
        typeof req.query['rows'] === 'string'
          ? (['demo', 'open', 'all'].includes(req.query['rows'] as string)
              ? (req.query['rows'] as 'demo' | 'open' | 'all')
              : 'unknown')
          : false,
        closedSinceTs,
      ),
    );
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
  // TRA-2193 — unauthenticated, secrets-free liveness readout for the option
  // single-leg entry paths.
  //
  // WHY THIS EXISTS. On 2026-07-22 and 07-23 the book produced zero single-leg
  // opens after five sessions of 18–38, and nothing in the process could say
  // whether the scanner had run and found nothing or had never run at all. Both
  // states rendered as the same thing: no rows. The cause was a wiped
  // `ENABLE_OPTION_DEMO_DIRECTIONAL` (TRA-2136's bulk env PUT) — the loop executed
  // zero iterations — but a genuine drought would have looked identical from
  // outside. That ambiguity, not the outage, was the defect.
  //
  // WHY IT REPORTS PATHS AND NOT "THE RV SCANNER". The single-leg structure label
  // is not a sleeve: `openOptionFromRvCandidate` used to stamp `single_leg_rv` for
  // every caller (TRA-1682), and the gated RV scan is only one of them — and has
  // been compile-time OFF since TRA-1207 on 2026-06-30. A route that described only
  // `runRelativeValueScan` would answer "disarmed, never ran": true, and useless,
  // because it would say nothing about the path that actually produced those 18–38
  // opens/session. So each producer reports separately and the caller can see WHICH
  // one went quiet. `entryArchetype` on the journal row is the matching axis for
  // grading (TRA-1691). TRA-2245 — those producers now stamp DISTINCT structure
  // labels: `directional` + `iv_rv_buy_premium` journal `single_leg_directional`;
  // only `rv_scan` journals `single_leg_rv`. Each path carries its own
  // `structureLabel` so the readout names the right bucket per path.
  //
  // The null discipline is the whole point and is load-bearing in three places:
  //   • `lastScanAt` / `lastFetchOkAt` are null when unmeasured, NEVER 0 — a 0
  //     epoch is a timestamp, and publishing one re-creates the exact false zero
  //     this route exists to kill (TRA-1707).
  //   • `universeSize: 0` (ran, empty universe) stays distinguishable from never
  //     having run, because in the never-ran case `lastScan` is null OUTRIGHT
  //     rather than an object full of zeros.
  //   • a path we do not instrument reports `scanCountSinceBoot: null`, not 0.
  //     Zero is a claim about a measurement we did not take.
  //
  // `scanCountSinceBoot`, never a lifetime count: a lifetime counter that survives
  // a reboot cannot prove the scanner ran TODAY, which is the only question worth
  // asking after an unexplained flat session.
  app.get('/api/health/rv-scan', (_req, res) => {
    // The engine resolves the directional arm via `isOptionDemoDirectionalEnabled()`
    // with NO argument — i.e. `process.env` ONLY, deliberately bypassing the
    // DATA_DIR/demo-flags.json overlay that most other option flags honour
    // (`option-exec-flag.ts`, and the call site in `evaluateDemoDirectional`).
    // This route MUST resolve it the same way. Reading the overlay here would let
    // the route report `enabled: true` off demo-flags.json while the engine reads
    // `false` off process.env — a liveness surface that lies in precisely the
    // situation it was built for. Do not "fix" this to use resolveDemoFlagEnv.
    const directionalEnabled = isOptionDemoDirectionalEnabled(process.env);
    const ivRvRoutingEnabled = isOptionIvRvRoutingEnabled(process.env);

    // TRA-3080 — the retained, per-ET-day, account-class-attributed ARM view.
    //
    // `enabled` above is a PROCESS-WIDE flag read. It is fleet-blind: it says nothing
    // about whether any resident book's MODE lets it reach the pass, so it reported
    // `true` throughout the desk's 2026-07-30 → 08-05 directional drought while the
    // `admin` book — moved to `settings.mode: 'live'` for the live-OTM window — could
    // not reach `evaluateDemoDirectional` at all (live needs
    // `ENABLE_OPTION_LIVE_DIRECTIONAL`, unset by design). `scanCountSinceBoot` could
    // not testify either: it is a since-boot latch on a box that reboots daily.
    // This block is the axis that separates "scanned and rejected" from "never
    // scanned, and here is why", for a PAST ET day.
    const armByEtDay = summarizeDirectionalArm();

    // Chain provider wiring. Null — not false — when the pipeline dep is absent,
    // because "we cannot see it from here" is not the same fact as "it is missing".
    const chainConfigured: boolean | null = deps.optionsPipeline
      ? summarizeOptionsPipeline(deps.optionsPipeline(), now()).rvScannerConfigured
      : null;

    const paths = [
      // Instrumented: the demo directional pass. This is the one that actually
      // fed what WAS the `single_leg_rv` bucket (now `single_leg_directional` since
      // TRA-2245), so it is the one whose silence had to become readable.
      summarizeRvScanPath('directional', {
        enabled: directionalEnabled,
        instrumented: true,
      }),
      // Instrumented, but held shut by the compile-time TRA-1207 kill switch.
      // Wired now so that re-arming it is self-evidencing on the first tick.
      summarizeRvScanPath('rv_scan', {
        enabled: isRvEngineEnabled(),
        instrumented: true,
      }),
      // NOT instrumented this iteration. Reports null counters rather than zeros —
      // see the null discipline above.
      summarizeRvScanPath('iv_rv_buy_premium', {
        enabled: ivRvRoutingEnabled,
        instrumented: false,
      }),
    ];

    // Roll-up over the INSTRUMENTED paths only. An un-instrumented path must not
    // be able to drag the aggregate toward a confident zero.
    const watched = paths.filter((p) => p.instrumented);
    const armed = watched.filter((p) => p.enabled);
    const scanned = watched.filter((p) => (p.scanCountSinceBoot ?? 0) > 0);
    const lastScanAt = watched.reduce<number | null>(
      (acc, p) => (p.lastScanAt != null && (acc == null || p.lastScanAt > acc) ? p.lastScanAt : acc),
      null,
    );

    // The verdict the issue actually asked for, stated rather than left to be
    // inferred. `disarmed` is the state that had no name before this route: the
    // path is off, so silence is CORRECT and no amount of staring at the journal
    // would ever have revealed it.
    const verdict =
      armed.length === 0
        ? 'disarmed'
        : scanned.length === 0
          ? 'armed_but_never_ran'
          : 'scanning';

    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      // Top-level `enabled` = is ANY instrumented single-leg entry path armed.
      // ⚠️ PROCESS-WIDE FLAG STATE ONLY — see `armByEtDay` for whether any book could
      // actually reach the pass (TRA-3080). The two disagree whenever a book is in a
      // mode whose arm flag is off, which is the desk's state since 2026-07-30.
      enabled: armed.length > 0,
      verdict,
      lastScanAt,
      scanCountSinceBoot: watched.reduce((n, p) => n + (p.scanCountSinceBoot ?? 0), 0),
      // TRA-2245 — per-path structure labels. `single_leg_rv` is now reserved for the
      // (compile-time-OFF) rv_scan path; the directional producers journal
      // `single_leg_directional`. Each path in `paths[]` also carries its own
      // `structureLabel`; this map is the at-a-glance summary.
      structureLabels: RV_SCAN_PATH_STRUCTURE_LABEL,
      // Stated inline because every reader of this route has, historically, been
      // one step away from grading the wrong population (TRA-1682 / TRA-1691).
      note:
        'Structure label is not a sleeve. Since TRA-2245 the directional producers '
        + 'journal `single_leg_directional` and only rv_scan journals `single_leg_rv`, '
        + 'but PRE-2245 rows still share `single_leg_rv` (forward-only). Group journal '
        + 'rows by `structure × entryArchetype` before grading; '
        + '`single_leg_rv × unspecified` is pre-tagging history, not a gradeable sleeve.',
      dataSource: {
        provider: 'tradier-chain',
        // Whether the chain client is wired at all. Null = unobservable here.
        keyPresent: chainConfigured,
        // Measured, not inferred: stamped when a scan actually received a usable
        // chain, and cleared to null until one does.
        lastFetchOkAt: watched.reduce<number | null>(
          (acc, p) => (p.lastFetchOkAt != null && (acc == null || p.lastFetchOkAt > acc) ? p.lastFetchOkAt : acc),
          null,
        ),
        lastFetchError: watched.find((p) => p.lastFetchError != null)?.lastFetchError ?? null,
      },
      paths,
      // TRA-3080 — RETAINED (30-day, hydrated across reboots), per-ET-day,
      // account-class-attributed arm disposition of the `directional` pass. Unlike
      // every other field on this route it can answer a question about LAST WEEK.
      //
      // Reading it: a cell with `reachable: false` means the books in that class
      // never reached the scan, and `disposition` names why — `live_arm_off` is a
      // book in live mode with `ENABLE_OPTION_LIVE_DIRECTIONAL` unset. A cell with
      // `reachable: true` means they DID scan, so silence there is a reject question.
      // NO cell for a class on a day is a THIRD state: no engine of that class ticked
      // during RTH, and it must not be read as either of the other two.
      armByEtDay,
      armNote:
        'TRA-3080. `enabled` above is process-wide flag state and is FLEET-BLIND — it '
        + 'reads true even when no resident book can reach the pass. `armByEtDay` is the '
        + 'per-book axis: it is retained on disk (30d) and survives the daily reboot, so '
        + 'it is the ONLY field here that can testify about a past ET day. An absent '
        + '(etDay, accountClass) cell means no engine of that class ticked in RTH — it is '
        + 'not evidence the pass was off. `ticks` is a LOWER BOUND (persistence is '
        + 'throttled to 5 min, so a died-boot tail is missing); `disposition`, '
        + '`reachable`, `accountClass` and `books` are exact from the first tick — grade '
        + 'on those, never on an exact tick count.',
      armRetentionDays: 30,
    });
  });

  // TRA-2200 (parent TRA-2171) — unauthenticated, secrets-free readout of the
  // decoupled exit-evaluation cadence.
  //
  // WHY THIS EXISTS. The TRA-2200 invalidation criterion is written against a
  // quantity nothing in the shipped build measured: "if a post-fix RTH session
  // shows p99 exit-evaluation INTERVAL > 30s, the bound chosen was the wrong one."
  // Before this fix that interval was inferable from `signal.doTick` async
  // wall-clock, because exits rode inside the tick. Hoisting them off the tick is
  // exactly what severs that proxy from its subject — so shipping the hoist
  // without this route would ship a change whose own success criterion had become
  // unmeasurable. Grade the quantity the criterion names, not its former proxy.
  //
  // The histogram is bucketed with the 30s bar on a BUCKET EDGE, so the grade
  // reads off it directly — `(lt60s + lt120s + lt300s + gte300s) / total < 1%` IS
  // "p99 under 30s", with no interpolation across a straddling bucket.
  //
  // `enabled` vs `timerArmed` are reported separately and the roll-up keys the
  // verdict on `timerArmed`. The flag can read true off a mid-session
  // demo-flags.json flip while no timer exists (arming needs a restart), and a
  // route that published only `enabled` would claim the hoist was live when it was
  // not — the same class of confident falsehood `/api/health/rv-scan` was built to
  // kill, and the same one the 16-slot `recentSlowPhases` ring produced on
  // 2026-07-23 (a post-close read that reported "sub-labels missing" when they had
  // been emitting all session).
  const exitCadence = deps.exitCadence;
  if (exitCadence) {
    app.get('/api/health/exit-cadence', (_req, res) => {
      const engines = exitCadence();
      res.json({
        ok: true,
        time: new Date(now()).toISOString(),
        build: resolveBuildInfo(),
        marketOpen: isStockMarketOpen(now()),
        ...rollUpExitCadence(engines),
        engines,
      });
    });
  }

  app.get('/api/health/watchdog', (_req, res) => {
    const watchdog = getWatchdogStatus();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      watchdog,
    });
  });

  // TRA-2209 (spun out of TRA-2198) — NO-AUTH declared-vs-running env drift.
  //
  // The TRA-2136 env wipe ran SIX DAYS undetected because every health surface
  // reads the flags the process HOLDS, and none of them had anything to compare
  // that against. This is the only route that reads render.yaml — the declared
  // intent — and reports the divergence.
  //
  // No-auth by design and by necessity: bqb1's admin auth is dead (401), so a
  // gated drift check would be exactly as unreachable as the wipe it is meant to
  // catch. Safe to expose because the payload is KEY NAMES AND STATE LABELS ONLY
  // — `EnvDriftEntry` has no field that can carry a value, so no amount of drift
  // can leak one (these keys share a store with TRADIER_API_TOKEN / AUTH_SECRET;
  // TRA-2163).
  //
  // `ok:false` covers BOTH a real divergence AND a broken parse; read `parserOk`
  // to tell them apart. `declaredKeysParsed`/`declaredValuesParsed` are INPUT-side
  // counts — `driftCount:0` with `declaredValuesParsed:0` is a BROKEN CHECK, not a
  // clean box, and is the specific false-green this route was built around.
  app.get('/api/health/env-drift', (_req, res) => {
    const report = evaluateEnvDrift({
      blueprint: loadRenderBlueprint(),
      // The engine's own effective view: process.env with the demo-flags.json
      // overlay on top, so an operator's daemon-free flip reads as the running
      // state rather than as phantom drift. Falls back to raw process.env.
      runningEnv: deps.effectiveEnv?.() ?? process.env,
      seededKeys: getSeededEnvKeys(),
      now,
    });
    res.json({ ...report, build: resolveBuildInfo() });
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
