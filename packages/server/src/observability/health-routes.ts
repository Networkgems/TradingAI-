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
  // TRA-3831 — the MODE-PINNED composition. `applyModelFacingBasis` is
  // deliberately NOT imported here: it carries the account-class axis only, and
  // this module holds its own POOLED `listOptionTradeJournal()` rows.
  applyModelFacingFoldBasis,
  MODEL_FACING_JOURNAL_BASIS,
} from '../model-facing-journal.js'; // TRA-2214, TRA-3831
import { resolveBuildInfo } from './build-info.js';
import { resolveBuildStaleness } from './build-staleness.js';
import { computeValidationProgress } from '../validation-progress.js';
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
// TRA-3926 — the detector for the condition that has ALREADY fired on real
// money: an engine `sell_to_close` for more contracts than the engine's own
// opens covered. Independent of the exit-path bound by design.
import { detectOversoldEngineCloses } from '../tra3926-oversold-close-detector.js';
// TRA-3926 (2026-09-04) — capture served judgements durably: the tape that
// feeds the detector retains 30 days, so every finding it can serve is on a
// countdown, and the fired 2026-08-21 event's evidence ages out ~2026-09-19.
import {
  captureJudgedOversoldCloses,
  summarizeJudgedOversoldCloses,
} from '../tra3926-judged-oversold-store.js';
import { summarizeStoredProvenance } from '../tra3932-open-leg-provenance.js';
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
  isOptionLiveDirectionalEnabled, // TRA-4288
  isOptionLiveDirectionalArmed, // TRA-4288
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
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION, // TRA-3674
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION_CEILING,
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR,
  resolveLiveOptionTestFleetRiskFraction,
  LIVE_OPTION_TEST_FLEET_CAPITAL_BASIS_USD, // TRA-3723
  gradeLiveOtmFleetBound,
  isOptionCostGateLiveEnforceEnabled,
  isOptionLiquidityLiveEnforceEnabled,
  OPTION_COST_GATE_LIVE_ENFORCE_FLAG,
  OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG,
  isOptionOtmDeltaFloorLiveEnforceEnabled, // TRA-2763
  resolveOptionOtmDeltaFloorLive,
  OPTION_OTM_DELTA_FLOOR_LIVE_FLAG,
  OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR,
} from '../option-exec-flag.js';
// TRA-3401 — the one-shot cost-bar grant's health block (card `6b82a9e7`).
import { getLiveOtmOneShotGrantState } from '../live-otm-oneshot-grant.js';
import {
  summarizeLiveOptionsFeeSlippage, // TRA-1929
  summarizeLiveOptionAdmissionStamps, // TRA-3997
  phantomOpenEpisodeCensus, // TRA-3976
  liveOptionFillRecords, // TRA-4144
} from '../live-options-fee-slippage-ledger.js';
import { getLiveOptionsFeeReconcileState } from '../live-options-fee-reconcile.js'; // TRA-2810
import { getZombieOpenSweepState } from '../zombie-open-journal-sweep.js'; // TRA-3547
import { getExpiredDemoOrphanSweepState } from '../expired-demo-orphan-sweep.js'; // TRA-4711
import { getOpenBasisRegradeState } from '../tra4453-open-basis-regrade.js'; // TRA-4453
import {
  summarizeEngineActionOnAdoptedRows, // TRA-4505
  type AdoptedHandoverCensusRow,
} from '../tra4505-adopted-arm-health.js';
import { getCloseBasisSweepState } from '../tra3730-close-basis-sweep.js'; // TRA-3730
import { summarizeIvRvScans } from '../iv-rv-scanner.js';
import { summarizeTermStructureShadow } from '../term-structure-shadow.js'; // TRA-4413 item 4
import {
  summarizeRvScanPath,
  RV_SCAN_PATH_STRUCTURE_LABEL,
  type RvScanAdmissibilityLedgerRead, // TRA-4255
} from '../rv-scan-telemetry.js'; // TRA-2193 / TRA-2245
import { summarizeShortPremiumScans } from '../short-premium-scanner.js';
import { buildWheelPromotionGateSummary } from '../wheel-promotion-gate-store.js'; // TRA-2028
import {
  summarizeConvictionDca,
  summarizeConvictionDcaGuard,
  resolveConvictionDcaDeployAnchor,
  parseConvictionDcaPaging,
} from '../conviction-dca-ledger.js';
import { summarizeChurnBrake, summarizeChurnBrakeGuard } from '../churn-brake-ledger.js';
import { summarizeDirectionalGate, summarizeDirectionalArm } from '../directional-open-ledger.js';
import { summarizeRvScanCensus } from '../rv-scan-census-ledger.js'; // TRA-4350
import { summarizeEntryGreeksGate } from '../entry-greeks-ledger.js';
import { RV_LONG_DELTA_FLOOR } from '@trading-app/engine';
import { summarizeCostAwareGate } from '../cost-aware-gate-ledger.js';
// TRA-4378 — the bounded exploration allowance's own state (pre-registered
// control 2). Published on the same route as the gate it exempts so "armed and
// quiet" and "never armed" can never render identically.
import { summarizeExplorationAllowance } from '../directional-exploration-allowance.js';
import { summarizeLiveEnforceGate } from '../live-enforce-gate-ledger.js'; // TRA-2048
// TRA-4628 — the OTM candidate-admission tape (admitted AND refused scanner
// candidates), the real denominator for the TRA-4623 pre-registered minMark rule.
import { readOtmAdmissionTapeRows, summarizeOtmAdmissionTape } from '../otm-admission-tape.js';
import { gradeCanaryCeilingHealth } from '../canary-ceiling.js'; // TRA-3836
// TRA-3979 — fleet concentration. ADVISORY: no order site consults it.
import { gradeFleetConcentration, type FleetConcentrationBookRow } from '../fleet-concentration.js';
// TRA-4144 — the underlying ASSET CLASS census (axis 4): classifier + open-row
// and retained-tape folds + the entry-site evaluation census + the
// `entryPathBehavior` publication for the flag-gated (default-OFF) refusal.
import { gradeUnderlyingAssetClassHealth } from '../underlying-asset-class.js';
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
import { summarizeEnvIntent } from '../env-intent.js'; // TRA-4474
import { getDiskWatermark, diskReadingAgeSec } from './disk-watermark.js'; // TRA-3011
import { getStateDbStatus } from '../sqlite.js'; // TRA-1681
import {
  isOptionCostAwareGateEnabled,
  resolveCostGateConfig,
  admissionBarR,
  describeCostGateBar, // TRA-3216 — the CONSTANT half of "why did the bar block"
  isEquityStructure, // TRA-4749 — the ONLY predicate `admissionBarR` branches on
  OPTION_COST_AWARE_GATE_FLAG,
  OPTION_COST_GATE_SAFETY_MARGIN_R_VAR, // TRA-4258 — named in the ratification clause
} from '../option-cost-gate.js';
// TRA-3272 — the NET-EDGE cost-bar form's arm description.
import { describeNetEdgeBar } from '../option-net-edge-bar.js';
// TRA-3391 (TRA-3388 Ruling 2) — the tape-calibrated expectancy table that
// REPLACED the delta-proxy estimator, published per cell so the admission
// decision is readable off deployed state instead of re-derived by hand.
import { tapeExpectancyCache } from '../option-tape-expectancy-cache.js';
import {
  DECLINE_REASON_TAXONOMY,
  TAPE_EXPECTANCY_MIN_CELL_N,
  summarizeTapeInputStaleness,
} from '../option-tape-expectancy.js';
// TRA-4749 (parent TRA-4622 §4) — the bar for EVERY structure the gate is
// observed to charge, not just the one `bar` was hard-coded to.
import {
  resolveGatedStructureBars,
  COST_BAR_PUBLISHED_STRUCTURE,
  COST_BAR_GATE,
} from '../live-enforce-gate-bars.js';
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
  // TRA-4416 — the board override, the live-band containment check and the
  // reopening-cohort disjointness proof. All PURE; the route supplies the live read.
  assessMandateBandContainment,
  assessMandateCohortDisjointness,
  deltaInterval,
  intersectDeltaIntervals,
  mandateBoardOverridesFor,
} from '../otm-sleeve-mandate.js';
// TRA-4416 — the contract floor's |delta| band is the other half of the LIVE
// admitted set, and its top edge is INCLUSIVE where the selector's is not.
import {
  OTM_CONTRACT_FLOOR_DELTA_MAX_VAR,
  OTM_CONTRACT_FLOOR_DELTA_MIN_VAR,
  resolveOtmContractFloor,
} from '../otm-contract-floor.js';
// TRA-4422 (parent TRA-4421) — the setup-taxonomy instrument's LIVE read.
// ⛔ `setupTaxonomyHealth` is passed the live env explicitly; the compiled
// default is never the answer to "what is the box doing".
import {
  setupTaxonomyHealth,
  // TRA-4423 — the observe-mode counterfactual fold (would-block by reason
  // code, live book, since boot). The ledger's own histogram cannot carry it:
  // it retains reason codes on BLOCKS only, and observe never blocks.
  readOtmSetupGateCounterfactual,
  SETUP_CONFIRMATION_GATE,
  SETUP_CONFIRMATION_SIBLING_GATE,
  SETUP_CONFIRMATION_EXPECT_ROWS_AFTER_OPEN_MS,
  scanWindowOpenMsSince,
  OTM_SETUP_TAXONOMY_MODE_ENV,
  OTM_SETUP_TAXONOMY_MODE_DEFAULT,
  OTM_SETUP_TAXONOMY_SETUPS_ENV,
} from '../otm-setup-gate.js';
// TRA-4424 (parent TRA-4421, off TRA-4422 Finding 1) — the DAILY-BAR source the
// seam above reads. Its counters are what keep "the daily feed is dead" from
// publishing the same histogram as "the market was quiet".
import { otmDailySeriesHealth } from '../otm-daily-series.js';
// TRA-4639 (parent TRA-4413 item A) — the underlying-confirmation shadow's
// LIVE read (same explicit-env rule as `setupTaxonomyHealth` above).
import { otmUnderlyingConfirmHealth } from '../otm-underlying-confirm.js';
// TRA-4720 (parent TRA-4413 item 5) — the relative-strength shadow's counters.
import { otmRelativeStrengthHealth } from '../otm-relative-strength.js';
// TRA-4642 (parent TRA-4413 item 1) — the EARNINGS_IV_CRUSH_RISK demoter
// shadow's LIVE read, plus the earnings-store status behind its codes.
import { otmIvCrushDemoterHealth } from '../otm-iv-crush-demoter.js';
import { earningsStoreStatusSync } from '../earnings-store.js';
import { SETUP_TAXONOMY_REASON_CODES } from '@trading-app/engine';
import {
  ENTRY_DELTA_CEILING_GATE,
  ENTRY_DELTA_CEILING_REASON_CODE,
  ENTRY_DELTA_CEILING_SHADOW_GATE,
  OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG,
  OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG,
  OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR,
  resolveEntryDeltaCeilingLive,
  // TRA-4416 AC3 — can the armed ceiling reach the population it is armed over?
  entryDeltaCeilingCoverage,
} from '../option-entry-delta-ceiling-live.js';
// TRA-3216 (parent TRA-2760) — the LIVE OTM underlying allowlist.
import {
  resolveLiveOtmUniverse,
  OPTION_LIVE_OTM_UNIVERSE_VAR,
  OPTION_LIVE_OTM_UNIVERSE_UNRESTRICTED,
} from '../otm-live-universe-flag.js';
// TRA-3694 (parent TRA-3661) — the RATIFICATION stamp. A ratified widening and an
// unratified one used to render byte-identically on `arm.universe`; the route now
// computes the comparison and publishes the VERDICT, because the failure being
// fixed is precisely a comparison nobody performs.
import {
  resolveLiveOtmUniverseRatification,
  resolveNumericRatification,
  foldRatificationVerdicts,
  LIVE_OPTION_TEST_NOTIONAL_CAP_RATIFIED_VAR,
  LIVE_OPTION_TEST_AGGREGATE_CAP_RATIFIED_VAR,
  LIVE_OPTION_TEST_CAPS_RATIFIED_BY_VAR,
  OPTION_COST_GATE_SAFETY_MARGIN_R_RATIFIED_VAR,
  OPTION_COST_GATE_SAFETY_MARGIN_R_RATIFIED_BY_VAR,
} from '../ratification-stamp.js';
import {
  summarizeSpreadCost,
  summarizeSpreadCeilingCompliance, // TRA-2316
  SPREAD_CEILING_ACCOUNT_CLASSES, // TRA-2316
  SLEEVE_SPREAD_CEILINGS,
  isSpreadCeilingEnforceEnabled,
  OPTION_SPREAD_CEILING_ENFORCE_FLAG,
  classifySpreadCeilingAccount, // TRA-2355 — the SINGLE partition rule, shared with the gate ledger
  STOP_DISTANCE_FRACTION_OF_MARK, // TRA-2590 — premium R → gate R is 1/this
  SPREAD_COST_ACCEPTANCE_N, // TRA-4291 — shared probe acceptance bar
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
// TRA-4478 — the exchange calendar, read from the RUNNING build (see the
// /api/health/exchange-calendar route for why the repo check is not enough).
import {
  calendarCoverage,
  calendarEntryGate,
  calendarFallbackCount,
  calendarFallbackDates,
  calendarFreshness,
  earlyCloseName,
  exchangeClosureName,
  resolveSessionDate,
  sessionCloseEtMinute,
} from '../market-calendar.js';
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
import { isCorrelatedExposureCapEnabled, CORRELATED_EXPOSURE_CAP_FLAG, isTakeProfitEarlyEnabled, TAKE_PROFIT_EARLY_FLAG, isEntryGreeksGateEnabled, ENTRY_GREEKS_GATE_FLAG, isEntryDeltaCeilingEnabled, resolveEntryDeltaCeiling, resolveEntryDeltaCeilingStructures, resolveEntryDeltaCeilingMap, resolveEntryDeltaCeilingObserveStructures, OPTION_ENTRY_DELTA_CEILING_FLAG, isExitRiskRulesEnabled, EXIT_RISK_RULES_FLAG, isBookGiveBackArmFloorEnabled, BOOK_GIVEBACK_ARM_FLOOR_FLAG, isRvExitRetuneLiveEnabled, RV_EXIT_RETUNE_LIVE_FLAG, RV_EXIT_RETUNE_LIVE_CONFIRM_BARS, RV_EXIT_RETUNE_LIVE_FLIP_MIN_LOSS_PCT, isRvExitRetuneEnabled, RV_EXIT_RETUNE_FLAG, isTakeProfitEarlyLiveEnabled, TAKE_PROFIT_EARLY_LIVE_FLAG, resolveSwingTimeStopTradingDays, OPTION_SWING_TIME_STOP_TRADING_DAYS_VALUE, OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT, resolveOptionsHaltScope, OPTIONS_HALT_SCOPE_VAR, isOtmTp1FullExit1LotEnabled, OTM_TP1_FULL_EXIT_1LOT_FLAG, isProfitFloorTrailEnabled, PROFIT_FLOOR_TRAIL_FLAG, type OptionsHaltScopeResolution } from '../exit-risk-rules-flag.js';
// TRA-4244 — the env-resolved OTM profit-side schedule, surfaced beside barR.
import { describeOtmProfitSchedule } from '../otm-profit-schedule.js';
import { summarizeOptionsBreakerLedger } from '../options-breaker-ledger.js'; // TRA-3218
import { summarizeCorrelatedExposureBindings } from '../correlated-exposure-ledger.js';
import { CONVICTION_DCA, CORRELATED_EXPOSURE_CAP_PCT, CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT, TAKE_PROFIT_EARLY_CAPTURE_PCT, ENTRY_SHORT_DELTA_MIN, ENTRY_SHORT_DELTA_MAX, ENTRY_DELTA_THETA_RATIO_FLOOR, resolveEquitySwingModeEnabled, resolveEquitySwingUniverse, EQUITY_SWING_UNIVERSE, EQUITY_SWING_GUARDRAIL } from '@trading-app/shared';
import { resolveDemoFlagEnv, DEMO_FLAG_ALLOWLIST } from '../demo-flags.js';
// TRA-4436 — demo-effective ma20 confirm bars, derived from the shipped
// `buildRvExitParams` so the option-swing-exits readout cannot drift from it.
import { demoEffectiveMa20ConfirmBars } from '../rv-exit-params.js';
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
  getOptionTradeVoids, // TRA-3472 — the acceptance witness for the never-filled retraction
  getOptionTradeCloseBasisAmends, // TRA-2819 — the acceptance witness for the broker-basis restatement
  getOptionTradeCloseSupersedes, // TRA-4004 — the acceptance witness for a real close landing on an already-closed row
  getOptionTradeOpenBasisAmends, // TRA-4028 — the acceptance witness for an entry-basis restatement (blend → own fill)
  getOptionTradeConvictionAdds, // TRA-4609 — the acceptance witness for a conviction-DCA add growing an OPEN row's basis
  GATE_R_BASIS_STRUCTURES, // TRA-2590 — which structures have a valid premium→gate R conversion
  type OptionTradeJournalSummary,
  type OptionTradeJournalIntegrity,
  type OptionTradeJournalRecord,
  type OptionTradeJournalExitReasonStat,
} from '../option-trade-journal.js';
// TRA-4674 — per-row crossed (ask→bid) re-pricing for the `?rows=` dump. Pure,
// read-time-only, computed from quotes the row already carries.
import { priceCrossedRow, type CrossedRowPricing } from '../option-crossed-pnl.js';
// TRA-3715 — the accountClass × structure × entryArchetype grading surface, its
// strategy-vs-harness exit table, and the ET-session close window. See
// `option-journal-sleeve-cells.ts` for why none of that could be read off the
// marginals this route already published.
import {
  foldOptionSleeveCells,
  parseEtDayCloseWindow,
  rowCloseEtDay,
  type OptionSleeveCellGrid,
  type EtDayCloseWindow,
} from '../option-journal-sleeve-cells.js';
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
  buildRecoveryVerdicts,
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
import { getLoopYieldGateSnapshot } from '../cooperative-yield.js';
import { getHeapCensusStatus } from '../heap-census-sampler.js';
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
  /**
   * TRA-4281 — the book's live stop-actionability fold (the TRA-3839 join).
   * Optional on the TYPE for test doubles, but a live book without it reads as
   * `instrumentBlind`, not as green — see `summarizeForContext`.
   */
  getLiveStopActionability?(now?: number): import('../options-account.js').LiveStopActionabilityQualified;
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
  /**
   * TRA-3979 — per-book OPEN LIVE ROWS, for the fleet CONCENTRATION fold
   * published as `fleetConcentration` on this route.
   *
   * Wire it to `getAllUserContexts().map(ctx => ctx.engine.getFleetConcentrationBook())`
   * — the WHOLE fleet again, for the same reason as the row above: the
   * `liveEntryGateOpen` population gate is applied inside the grader and
   * NAMED in its output, so narrowing here would move the denominator out of
   * the payload that reports it. Optional: absent ⇒ `status: 'unwired'`, which
   * is emphatically NOT a reading of zero concentration.
   */
  liveOtmConcentration?: () => Array<FleetConcentrationBookRow>;
  /**
   * TRA-3976 — every OCC symbol on the fleet's LIVE open book right now,
   * backing the `phantomOpenEpisodes` census on
   * `GET /api/health/live-options-fee-slippage`. Wire it to the union of every
   * engine's live `openOptions[].optionSymbol` (imported rows INCLUDED — an
   * adopted broker row is a contract we hold).
   *
   * Optional: absent ⇒ the census serves `verdict: 'blind'` / `rows: null`,
   * which says "not wired", NEVER `clean` ("no phantoms"). A census whose
   * unwired state read as healthy would be the defect it is looking for.
   */
  liveOpenOptionSymbols?: () => string[];
  /**
   * TRA-4505 (parent TRA-4206) — every open option row the fleet holds, narrowed
   * to the four fields `engineMayActOnAdoptedRow` reads, backing the
   * `engineActionOnAdoptedRows` census on
   * `GET /api/health/live-options-fee-slippage`. Wire it to the WHOLE fleet,
   * both modes, no filter — the census partitions on `importedFromTradier` +
   * `tradierEnv` itself (never `mode`, TRA-3112 item 3), and a filter applied in
   * the caller would narrow the denominator where no unit test can see it.
   *
   * Optional: absent ⇒ the block serves `rows: null` — "not wired", NEVER
   * "no adopted rows".
   */
  adoptedHandoverRows?: () => AdoptedHandoverCensusRow[];
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
  /**
   * TRA-3674 — THIS BOOK'S resolved budget `B_i = min(φ · availableCashUsd,
   * fleetCapUsd)`, USD. Was a uniform process scalar (all 67 rows read `750`),
   * which made the route structurally unable to tell the two armed books apart —
   * the exact read TRA-3674 is graded on. `0` ⇒ fail-closed: no usable balance
   * snapshot, so this book may take nothing.
   */
  capUsd: number;
  /** `A` — the fleet authorization every per-book budget is clamped to, USD. */
  fleetCapUsd: number;
  /** φ as resolved from env (compiled default when unset/malformed). */
  fleetRiskFraction: number;
  /**
   * `min(optionBuyingPower, totalCash, totalEquity)` — the SIZING BASIS, not the
   * book's paper equity. `null` ⇒ no usable live balance snapshot, which is why
   * `capUsd` is 0; publishing the basis is what separates "this book is full"
   * from "this book's balance went dark" from "φ mis-resolved".
   */
  availableCashUsd: number | null;
  /**
   * ⭐ TRA-3964 (AC2) — THE AGE OF THE CASH HALF OF `E_i`, in ms.
   *
   * ⚠ OPTIONAL, and for the usual reason: ABSENCE IS A REAL READING. A row
   * without it came from a build where the cash half was an UNCORRECTED
   * snapshot up to 120s old, so `capUsd` / `headroomSignedUsd` /
   * `admissibleEntryUsd` on that row may be inflated by `φ_eff ×` any premium
   * filled in that window. Declaring it required would assert at the type level
   * the very thing the wire does not guarantee.
   *
   * `null` ⇒ no successful balance fetch has ever landed on this engine.
   */
  balanceAgeMs?: number | null;
  /** TRA-3964 — the snapshot's as-of stamp, epoch ms. `null` ⇒ never fetched. */
  balanceAsOfMs?: number | null;
  /**
   * TRA-3970 — balances envelopes refused as the broker's weekend/maintenance
   * ALL-ZEROS artifact (triple numeric zero on `total_cash`/`total_equity`/
   * `market_value`). Accepting one collapsed `capUsd` to φ·atRisk and fired the
   * TRA-3897 over-cap tripwire (`headroomSignedUsd: −140.38`) on a book that
   * was not over cap. OPTIONAL for the usual reason: a row from a pre-TRA-3970
   * build genuinely does not carry it, and `null` means the counter itself was
   * unreadable — neither may be read as 0.
   */
  balanceZeroArtifactSuppressions?: number | null;
  /** TRA-3970 — when the most recent artifact envelope was refused. */
  balanceZeroArtifactLastAtMs?: number | null;
  /** TRA-3964 — the broker's raw `min(...)` BEFORE the unsettled-premium correction. */
  brokerCashUsd?: number | null;
  /**
   * TRA-3964 — premium filled since the snapshot was taken: the dollars the
   * cached cash figure still holds and `openPremiumAtRiskUsd` holds too.
   * `brokerCashUsd − availableCashUsd` by construction.
   */
  unsettledLivePremiumUsd?: number;
  /** TRA-3964 — how many fills that covers. */
  unsettledLivePremiumFills?: number;
  /** TRA-3964 — of those, how many had an unreadable premium ⇒ the correction UNDERSTATES. */
  unsettledLivePremiumBlindFills?: number;
  openPremiumAtRiskUsd: number;
  openRows: number;
  /** > 0 ⇒ the enforced figure is known to UNDERSTATE exposure (see `foldOpenPremiumAtRisk`). */
  unpricedOpenRows: number;
  /**
   * ⚠ OPTIONAL, and that is the point. This route is a PASS-THROUGH — it does
   * not read these three — and a row served by a build older than TRA-3913
   * genuinely does not carry them. That ABSENCE is the deployed-bytes signal
   * AC5 grades (`scripts/tra3913-adopted-attribution-live.mjs` G1: 0/67 rows
   * pre-fix), so declaring them required would assert at the type level exactly
   * the thing the wire does not guarantee. Same reason TRA-3911's
   * `admissibleEntryUsd` is served here without being declared at all.
   *
   * TRA-3913 — the DESK's share of `openPremiumAtRiskUsd`: premium in contracts
   * this engine's own `buy_to_open` records do not account for, which the broker
   * reconcile blended onto an engine row.
   *
   * ⚠ INSIDE `openPremiumAtRiskUsd`, not beside it. The order path gates on the
   * total (TRA-3911's `Σ_j atRisk_j`), so this is how much of the board's
   * authorization a party outside the engine is spending. The
   * engine-attributable figure is `openPremiumAtRiskUsd − adoptedPremiumAtRiskUsd`.
   * Measured $85.00 on bqb1's live XLF row, 2026-08-21.
   */
  adoptedPremiumAtRiskUsd?: number;
  /** TRA-3913 — rows holding ANY of the above. A row can be partly ours, partly the desk's. */
  adoptedOpenRows?: number;
  /**
   * TRA-3913 — of `adoptedOpenRows`, how many the fill oracle REFUSED rather
   * than ANSWERED. Non-zero ⇒ the adopted figure is an upper bound on desk money
   * (and the engine figure a lower bound on ours); do not publish it as a desk
   * measurement. Zero is scoped to what the oracle could see, as ever.
   */
  adoptedAttributionBlindRows?: number;
  /**
   * TRA-3958 — of `openPremiumAtRiskUsd`, the dollars resting on an OPERATOR's
   * pinned basis rather than a machine oracle's.
   *
   * ⚠ AN OVERLAY, NOT A PARTITION: inside `openPremiumAtRiskUsd` and freely
   * overlapping `adoptedPremiumAtRiskUsd`. The live BAC row is both at once.
   *
   * Read it whenever you are about to act on `admissibleEntryUsd`. Non-zero
   * means part of the basis under that admission is a human's figure with a
   * citation — recoverable in full from
   * `/api/options/basis-restatements` → `durable.restatements[]`, which carries
   * the before/after and the provenance string verbatim.
   */
  operatorPinnedAtRiskUsd?: number;
  /** TRA-3958 — rows carrying the above. */
  operatorPinnedOpenRows?: number;
  /**
   * TRA-3965 — of `openPremiumAtRiskUsd`, the dollars added because the BROKER
   * charged more for this engine's own entry than the row's basis books.
   *
   * The premium half of TRA-3964's skew. `premiumPaid` on an engine-opened row
   * is the scanner's pre-trade mid until `restateEngineOpenedBasis` moves it to
   * broker truth on a later reconcile (measured live at 23.1 s and 72.3 s), and
   * on a `quantity_mismatch` / `multi_leg` / `covered_write` row that sweep is
   * skipped by design and the window never closes.
   *
   * ⚠ AN OVERLAY, NOT A PARTITION — inside `openPremiumAtRiskUsd`. Zero is the
   * healthy steady state (re-stamp landed, or the fill was at the mark). A
   * figure that STAYS non-zero names a row the reconcile is refusing to
   * re-stamp; cross-read the skip census on `/api/options/basis-restatements`.
   *
   * OPTIONAL on the contract: absence is the deployed-bytes signal — a build
   * without TRA-3965 omits the key entirely, which a grader must not read as
   * `0`. (TRA-3964 drew the same line for `unsettledLivePremiumUsd`.)
   */
  unbookedEntryPremiumUsd?: number;
  /** TRA-3965 — rows carrying the above. */
  unbookedEntryPremiumRows?: number;
  /**
   * TRA-3965 — dollars a LIVE operator pin (TRA-3958) held OFF the correction,
   * because a pin is a standing instruction about the basis and outranks it.
   *
   * Published because a refusal must never share a column with a finding:
   * "nothing to add" and "something to add, and the pin refused it" are the
   * identical `unbookedEntryPremiumUsd: 0`, and only one is a fact about the
   * book. The live BAC row is pinned at 1.17 and carries a 1.65 engine fill, so
   * this is the state, not a hypothetical.
   */
  unbookedEntryPremiumSuppressedUsd?: number;
  /**
   * `capUsd − openPremiumAtRiskUsd`, floored at 0; `null` when unreadable.
   *
   * ⚠ THE FLOOR IS LOSSY. A book over its cap publishes `0` here, which is
   * byte-identical to a book exactly at it — read {@link headroomSignedUsd}
   * instead when you need to tell those apart (TRA-3897 AC2).
   */
  headroomUsd: number | null;
  /**
   * TRA-3897 (AC2) — the same figure UNCLAMPED. **Negative ⇒ this book is over
   * its own published cap.** `null` on exactly the same unreadable inputs as
   * `headroomUsd`; the two never disagree about whether a reading exists.
   */
  headroomSignedUsd: number | null;
  /**
   * TRA-3897 — `E_i`, the basis `capUsd` was sized on:
   * `availableCashUsd + openPremiumAtRiskUsd`. Published so the basis is
   * auditable directly instead of back-derived from `capUsd / φ_eff`.
   * `null` on the same fail-closed branch that zeroes `capUsd`.
   */
  sizingBasisUsd: number | null;
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

// ── TRA-4457 sma200 sweep census (fleet fold) ────────────────────────────────

/**
 * TRA-4457 — the fleet answer to "does an empty sma200 signal feed mean a quiet
 * market, or a scan that could not look?".
 *
 * `21b15106` put the census on `EngineState.sma200ScanStats` and the grade on
 * `EngineState.sma200SweepVerdict`, and that was as far as it got: the only
 * health route that is handed an `EngineState` (`/options-pipeline`) projects
 * it down to a fixed whitelist, so neither field reaches any unauthenticated
 * surface. Measured against live bqb1 on 2026-09-16 (`f3ce18b6`, pid 77): 65
 * engines served, **0** exposing either key. That is this ticket's own defect
 * one layer out — a grader that is correct and published by nobody — so the
 * fold lives here, on the sma200 route, where the monitor already reads.
 *
 * ⚠️ WHOLE FLEET, BOTH MODES. `runSma200Scan` is driven from `doTick` behind an
 * interval + the process-wide scan slot, with no mode predicate, so a
 * `.filter(mode === 'demo')` here would silently drop engines that really do
 * sweep — the TRA-2650 / TRA-3445 lesson, in the caller where no unit test can
 * see it. The per-mode split is published instead so a reader narrows it
 * themselves.
 */
export interface Sma200SweepCensusReport {
  /** Engines folded (whole fleet, both modes). */
  engines: number;
  /** …of which `mode === 'live'`. The rest are demo. */
  liveEngines: number;
  /**
   * Engines that have completed at least one sweep since boot, i.e. carry a
   * non-null census. This is the DENOMINATOR of every verdict below.
   */
  graded: number;
  /**
   * Engines whose census is still `null` — no sweep has finished on them yet
   * (a fresh boot; the interval is minutes). Explicitly NOT folded into
   * `BLIND`: "has not looked yet" and "looked and saw nothing" are different
   * facts, and collapsing them re-creates the defect this ticket is about.
   */
  neverSwept: number;
  /**
   * Engines served by a build that does not carry the census at all (neither
   * key present on the state object). Non-zero ⇒ `21b15106` is not live here
   * and NO reading below is evidence about the feed. ABSENT ≠ AGREE.
   */
  unpublished: number;
  /** Per-verdict engine counts over the `graded` denominator. */
  byVerdict: { SWEPT: number; BLIND: number; NO_UNIVERSE: number };
  /**
   * The fleet fold.
   *
   * - `NO_SWEEP_YET`  — nothing graded yet. Not a reading.
   * - `NO_UNIVERSE`   — every graded engine was handed zero symbols (upstream
   *                     watchlist fault, not a starved feed).
   * - `BLIND`         — at least one engine graded and NONE scored a symbol.
   *                     An empty feed here says nothing about the market.
   * - `PARTIAL_BLIND` — some engines scored, some could not look. The feed is
   *                     a lower bound, never a "quiet day".
   * - `SWEPT`         — at least one engine scored and none went blind. Only
   *                     here may an empty feed be reported as "no setup fired".
   */
  verdict: 'NO_SWEEP_YET' | 'NO_UNIVERSE' | 'BLIND' | 'PARTIAL_BLIND' | 'SWEPT';
  /** Σ over graded engines' most-recent sweeps. Counters only, no symbols. */
  totals: {
    considered: number;
    evaluated: number;
    starvedBreakerOpen: number;
    starvedShortHistory: number;
    fetchFailed: number;
    fired: number;
    voided: number;
  };
  /** ISO time the most-recent sweep in the fleet finished, or null. */
  newestSweepAt: string | null;
  /** Age of `newestSweepAt` in ms at read time — a stale census is not a live one. */
  newestSweepAgeMs: number | null;
}

/**
 * Fold the fleet's sweep censuses. Pure (clock injected) so the five verdict
 * arms are unit-gradeable without a server.
 *
 * The load-bearing arm is the one that looks like nothing: a fleet that scored
 * symbols and fired zero reads `SWEPT`. Folding on `fired` instead of
 * `evaluated` would collapse quiet and starved into one verdict — the exact
 * defect TRA-4457 was filed for, one layer above where `sma200SweepVerdict`
 * already refuses it.
 */
export function summarizeSma200Sweeps(
  engines: Array<{ state: EngineState; mode: string }>,
  now: number,
): Sma200SweepCensusReport {
  const byVerdict = { SWEPT: 0, BLIND: 0, NO_UNIVERSE: 0 };
  const totals = {
    considered: 0, evaluated: 0, starvedBreakerOpen: 0,
    starvedShortHistory: 0, fetchFailed: 0, fired: 0, voided: 0,
  };
  let graded = 0;
  let neverSwept = 0;
  let unpublished = 0;
  let liveEngines = 0;
  let newestFinishedAt: number | null = null;

  for (const { state, mode } of engines) {
    if (mode === 'live') liveEngines++;
    // A build without the census carries NEITHER key. A build WITH it carries
    // both, holding `null` until the first sweep lands. Keying on the key's
    // presence (not its value) is what keeps "old build" out of "quiet fleet".
    if (!('sma200ScanStats' in state) && !('sma200SweepVerdict' in state)) {
      unpublished++;
      continue;
    }
    const stats = state.sma200ScanStats ?? null;
    const verdict = state.sma200SweepVerdict ?? null;
    if (stats === null || verdict === null) {
      neverSwept++;
      continue;
    }
    graded++;
    byVerdict[verdict]++;
    totals.considered += stats.considered;
    totals.evaluated += stats.evaluated;
    totals.starvedBreakerOpen += stats.starvedBreakerOpen;
    totals.starvedShortHistory += stats.starvedShortHistory;
    totals.fetchFailed += stats.fetchFailed;
    totals.fired += stats.fired;
    totals.voided += stats.voided;
    if (newestFinishedAt === null || stats.finishedAt > newestFinishedAt) {
      newestFinishedAt = stats.finishedAt;
    }
  }

  let verdict: Sma200SweepCensusReport['verdict'];
  if (graded === 0) verdict = 'NO_SWEEP_YET';
  else if (byVerdict.NO_UNIVERSE === graded) verdict = 'NO_UNIVERSE';
  else if (byVerdict.SWEPT > 0 && byVerdict.BLIND > 0) verdict = 'PARTIAL_BLIND';
  else if (byVerdict.SWEPT > 0) verdict = 'SWEPT';
  else verdict = 'BLIND';

  return {
    engines: engines.length,
    liveEngines,
    graded,
    neverSwept,
    unpublished,
    byVerdict,
    verdict,
    totals,
    newestSweepAt: newestFinishedAt === null ? null : new Date(newestFinishedAt).toISOString(),
    newestSweepAgeMs: newestFinishedAt === null ? null : now - newestFinishedAt,
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
/**
 * TRA-3715 item 2 (the minimum-viable half) — a `?rows=` element with its
 * account class STAMPED ON IT.
 *
 * The dump used to serve bare `OptionTradeJournalRecord`s. A row carries
 * `account` (a free-form username) but not its CLASS, and the classification
 * rule lives in this repo, not in the payload — so every hand-fold over `rows[]`
 * either re-implemented `classifySpreadCeilingAccount` or, in practice, skipped
 * it and pooled 92.8% QA fixture books into a desk number. Both TRA-3682 and
 * TRA-3709 took the second path. The class is computed by the SAME classifier
 * `summary.byAccountClass` uses, so a hand-fold and the published partition
 * cannot disagree.
 *
 * `closeEtDay` is stamped for the same reason: the windows people grade are ET
 * session days, and deriving one from `closeTs` at the call site is another
 * place to get DST wrong. `null` while the row is still open.
 */
export type OptionJournalDumpRow = OptionTradeJournalRecord & {
  accountClass: SpreadCeilingAccountClass;
  closeEtDay: string | null;
} & CrossedRowPricing; // TRA-4674 — crossedPnlUsd / crossedR / crossedUnpriced, null-not-0

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
  /**
   * TRA-3715 — the `accountClass × structure × entryArchetype` grid, each cell
   * split into strategy-owned vs harness/manual exits and labelled
   * `UNDERPOWERED` below n = 20.
   *
   * THIS is the surface a sleeve grade may be read from. `summary.byAccountClass
   * .*.byStructure` and `.byArchetype` are separate MARGINALS — the axis
   * TRA-3682/TRA-3709 explicitly forbid grading on — and every figure in them
   * pools QA hand-closes with strategy exits. Two tickets in a row hand-folded
   * `rows[]` instead and published a fabricated positive baseline because
   * `rows[]` carried no `accountClass`. Sits at the TOP LEVEL, deliberately not
   * under `summary`, whose own note says never to grade it.
   */
  sleeveCells: OptionSleeveCellGrid;
  /**
   * TRA-3715 — the window that actually served this response, resolved and
   * echoed so a grader asserts what it got rather than assuming its params took
   * effect. `axis` names the timestamp compared against; `fromMs`/`toMs` are
   * both INCLUSIVE and `null` where that side is unbounded (a lifetime fold
   * reads `fromMs: null, toMs: null`).
   */
  window: {
    axis: 'openTs' | 'closeTs';
    fromMs: number | null;
    toMs: number | null;
    fromInclusive: true;
    toInclusive: true;
    /** Present only when the ET-session-day params resolved this window. */
    etDay: EtDayCloseWindow | null;
    note: string;
  };
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
  rows?: OptionJournalDumpRow[];
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
   * TRA-4462 AC2 — **the dump's own denominator, stated on the wire.**
   *
   * `summary` folds the whole filtered set; `rows` is a SUBSET selected by
   * `rowsMode`. The two are documented as different populations in this file, but
   * nothing in the payload said so, and nothing said BY HOW MANY — so a reader who
   * folds `rows[]` and compares it to `summary.total` gets a mismatch with no way
   * to tell a scoping rule from a lost row. On 2026-09-09 that read as a 67-row
   * integrity gap on a `?rows=demo` fetch (3,491 vs 3,558) and was filed as a
   * defect; it is exactly `notDemoMode: 32` + `stillOpen: 35`, i.e. the two
   * documented exclusions, and `?rows=all` returns 3,558 === 3,558.
   *
   * INVARIANT, and the reason this is emitted rather than left to arithmetic:
   *   `rowsDumped + Σ rowsExcludedFromDump[*] === summary.total`, in EVERY mode.
   * Each mode states its own exclusions; a cell that cannot apply reads `0`, never
   * an omitted key — an absent key is how a partially-populated payload reads as a
   * fully-reconciled one.
   */
  rowsDumped?: number;
  rowsExcludedFromDump?: OptionJournalDumpExclusions;
  /** TRA-4462 AC2 — how to read the two counts above. */
  rowsDumpNote?: string;
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
  /**
   * premium→GATE R factor (4) where valid; `null` where no conversion exists.
   *
   * ⛔ TRA-4246 (AC3) — the gate's R is its MODEL of a stop (`mark × 0.75`),
   * not the sleeve's armed stop. `single_leg_otm` stops at 0.20 (a 5×), so
   * this constant converts premium R to GATE R and must never be used to
   * convert it to STOP-BASIS R — doing so understates that sleeve by 20%.
   * The stop-basis divisor is per-row (`stopBasisRPerPremiumR` on the journal
   * close row) and folded per cell on the sleeve grid.
   */
  gateRPerPremiumR: number | null;
  /**
   * TRA-4246 (AC3) — closed rows in this cell carrying a per-row stop-basis
   * divisor, and the distinct values they carry, ascending. `n: 0` with `[]`
   * ⇒ no row here can be converted to stop basis at all (pre-stamp closes, or
   * every row closed with an unarmed stop) — which is a fact to publish, not a
   * gap to fill with the gate constant. More than one value ⇒ the cell spans
   * different stop rules and NO single divisor describes it.
   */
  stopRPerPremiumRObserved: { n: number; values: number[] };
  /**
   * TRA-4246 (AC1, the grader's read) — the cell's rows' OWN stop-basis R.
   *
   * The per-row value lives on the journal close row, and the only route that
   * served it was `/api/trades/export` — which is scoped to the CALLER's book.
   * A desk close on any other book therefore had no read path at all: measured
   * 2026-09-10, 4 post-boot desk closes all carried the divisor on this surface
   * while the admin export's newest row was 09-02. `n` counts finite values;
   * `nullReasons` counts STAMPED nulls by their reason; `unstamped` counts
   * pre-stamp closes (key absent). Forward-only — ⛔ an unstamped row is never
   * filled in from `realizedR × divisor`.
   */
  stopBasisR: {
    n: number;
    avg: number | null;
    min: number | null;
    max: number | null;
    nullReasons: Record<string, number>;
    unstamped: number;
  };
  /**
   * TRA-4246 (AC2, the grader's read) — one entry per trail-family close
   * (`profit_lock` / `profit_floor`) or any close carrying a `profitLockFire`
   * stamp, newest first, capped at {@link RELEASE_FORENSICS_CAP}. Before this
   * the stamp was written to the journal and served by NO route, so
   * level-vs-fill slip was a read only for someone holding the host's disk.
   * `stamped: false` on a trail-family row is a RELABEL (see
   * `OptionTradeJournalRecord.profitLockFire`), not a fire that went unrecorded.
   */
  releaseForensics: OptionJournalReleaseForensic[];
  /** Trail-family rows beyond the cap — counted, never silently dropped. */
  releaseForensicsTruncated: number;
  /**
   * TRA-4246 (AC6, CFO) — the cell's TRA-450 breaker exposure, so the latch
   * artifact is a cell-level read and not one that only shows up on the capped
   * `releaseForensics` list.
   *
   * `stamped` counts rows carrying the AC6 keys at all (forward-only: a
   * pre-stamp close is in `closed` and not here, and ⛔ is never assumed
   * clean). `withRejects` counts rows whose LIFETIME accrual is > 0.
   * `breakerTripped` counts rows the breaker latched — on a trail-family cell
   * those rows' `profit_lock` labels were not written by `profitLockDecision`,
   * which never sees a latched row.
   */
  closeRejectBreaker: { stamped: number; withRejects: number; breakerTripped: number };
  /**
   * TRA-4291 — the MODELED net-of-cross companion to `avgR`, with its own
   * provenance. `avgR` stays gross and byte-identical; this is the join that
   * stops a demo cell paying no spread from reading `scratch` (the TRA-4230
   * −17.76R block read +0.016 gross for months).
   */
  modeledCross: OptionJournalModeledCross;
}

/**
 * TRA-4291 — modeled net-of-cross beside the gross `avgR`, per cell.
 *
 * Demo rows book NO spread cost (`demoSlippagePct: 0`, `demoFeePerContract: 0`),
 * so their `realizedR` is GROSS of the bid/ask cross; this object charges each
 * DEMO close the structure's MEASURED mean cross
 * (`option-spread-cost.byStructure[].avgSpreadCrossRPremiumBasis`, already in
 * the journal's premium R — no 4× conversion is applied or needed) and restates
 * the cell mean. It is a MODEL, not a booked cost: the field names say so, and
 * nothing here touches `realizedR` / `avgR` / `realizedPnlUsd`.
 *
 * LIVE rows already pay the cross in their booked fills, so they are NEVER
 * charged again — they contribute their `realizedR` unchanged to both nets
 * (`liveClosedUncharged` counts them). One cross (entry only) is the
 * conservative floor; two crosses (entry + exit) is the realistic round trip.
 *
 * ⚠ TRA-2319 — `null` is NOT a pass. Both `avgRNetOfModeledCross*` fields are
 * `number | null`, and `null <= x` is `true` in JavaScript: gate on
 * `!== null` before comparing, never on a bare `<=`. When they are null,
 * `reason` says why (no probe row for the structure, or probe `n` below
 * `acceptanceN`) — a missing measurement is stated, never fabricated as 0.
 */
export interface OptionJournalModeledCross {
  /** `avgR` − 1 modeled cross per DEMO close (entry only — the conservative floor). */
  avgRNetOfModeledCross1x: number | null;
  /** `avgR` − 2 modeled crosses per DEMO close (entry + exit — the realistic round trip). */
  avgRNetOfModeledCross2x: number | null;
  /** The cross charged per demo close, in PREMIUM R — `option-spread-cost.byStructure[].avgSpreadCrossRPremiumBasis` verbatim. */
  modeledCrossRPremiumBasis: number | null;
  /** Same unit as `avgR` and `realizedR` — no `gateRPerPremiumR` conversion applied. */
  basis: 'premium';
  /** Measured fills behind the cross — `option-spread-cost.byStructure[].n`. `null` = no probe row. */
  probeN: number | null;
  /** The probe acceptance bar; `probeN` below it ⇒ nulls with `reason`, never 0. */
  acceptanceN: number;
  /** DEMO closes in this cell, each charged (their realizedR is gross of spread). */
  demoClosedCharged: number;
  /** LIVE closes in this cell, NOT charged (their realizedR already books the cost). */
  liveClosedUncharged: number;
  /** Non-null exactly when the `avgRNetOfModeledCross*` fields are null: why nothing was modeled. */
  reason: string | null;
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
  /** TRA-4291 — how to read `cells[].modeledCross`. Additive; `note` above is byte-unchanged. */
  modeledCrossNote: string;
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
 * TRA-4246 (AC2) — the exit reasons a give-back decision closes under: the base
 * lock and the TRA-4020 ladder floor. Membership is by LABEL, not by stamp, so a
 * trail-family close that carries no `profitLockFire` still lands on the list —
 * that absence is the relabel evidence the list exists to publish.
 *
 * TRA-4759 item 3 — `take_profit_early` joined the family when the live flag
 * armed (2026-09-20T13:47:23.779Z): the engine now chooses this exit on real
 * money, and it releases at a level exactly like the lock does. Its rows carry
 * a `takeProfitEarlyFire` stamp on post-TRA-4759 builds; a pre-stamp close
 * lands with `stamped: false`, which is the correct and intended reading.
 */
const TRAIL_FAMILY_EXIT_REASONS: ReadonlySet<string> = new Set([
  'profit_lock',
  'profit_floor',
  'take_profit_early',
]);
/** TRA-4246 (AC2) — per-cell cap on `releaseForensics`; the remainder is counted. */
export const RELEASE_FORENSICS_CAP = 25;

/**
 * TRA-4246 (AC2) — one trail-family close's release forensics, as a READ.
 * Every operand is the row's own stamp; nothing is re-derived from a constant.
 * `null` = not measured on this row, never a stand-in.
 */
export interface OptionJournalReleaseForensic {
  optionSymbol: string | null;
  closeTs: number | null;
  exitReason: string;
  /**
   * `false` ⇒ no fire stamp on the row (`profitLockFire`, or TRA-4759's
   * `takeProfitEarlyFire` for a `take_profit_early` close): a relabel, or a
   * pre-stamp close.
   */
  stamped: boolean;
  armed: boolean | null;
  /** The peak the rule CONSUMED (executable basis when `execBidAtFire` is non-null). */
  peakPremiumAtFire: number | null;
  peakR: number | null;
  giveBackR: number | null;
  levelR: number | null;
  levelPremium: number | null;
  stopBasisPremium: number | null;
  markAtFire: number | null;
  execBidAtFire: number | null;
  /** Broker exit fill — TRA-2819 restated rows only. ⛔ Never the mark standing in. */
  exitFillPremium: number | null;
  /** `exitFillPremium − levelPremium`: the execution slip. Null unless both are measured. */
  fillVsLevelPremium: number | null;
  /** The same slip in stop-basis R (÷ `stopBasisPremium`). */
  fillVsLevelR: number | null;
  /** `markAtFire − levelPremium`: the tick-granularity half of the gap. */
  markVsLevelPremium: number | null;
  pnlRStopBasis: number | null;
  /**
   * TRA-4246 (AC6) — the row's LIFETIME close-reject accrual, and whether the
   * TRA-450 breaker ever tripped on it. `null` ⇒ a pre-stamp close, never `0`.
   *
   * `closeRejectBreakerTripped: true` on a trail-family row is the LATCH
   * ARTIFACT reading: a latched row is never handed to `profitLockDecision`, so
   * its `profit_lock` label was written by something else. Read it before
   * folding this row's slip into a give-back verdict.
   */
  closeRejectCount: number | null;
  closeRejectBreakerTripped: boolean | null;
}

/** TRA-4291 — one structure's measured cross + probe n, keyed for the cell join. */
interface ModeledCrossProbe {
  crossRPremiumBasis: number;
  probeN: number;
}
type ModeledCrossByStructure = ReadonlyMap<string, ModeledCrossProbe>;

/**
 * TRA-4291 — fold the demo journal's fill-time quotes into the per-structure
 * modeled-cross inputs, via the SAME `summarizeSpreadCost` fold
 * `/api/health/option-spread-cost` publishes — same sample admission (demo rows
 * carrying `entryBid`/`entryAsk`/`entryMarkUsd`, unusable quotes dropped, never
 * zero-filled), so `crossRPremiumBasis` and `probeN` here are that route's
 * `byStructure[].avgSpreadCrossRPremiumBasis` and `.n` verbatim and a reader
 * can cross-check without a unit conversion.
 *
 * Fed the FULL journal (this helper pins `mode === 'demo'` itself), NOT the
 * report's cohort-filtered rows — deliberately. The cross is a property of the
 * structure's market, not of the graded cohort, and letting a narrow
 * `?sinceTs=` window shrink the probe below `acceptanceN` would null exactly
 * the cells the window exists to grade.
 */
function modeledCrossByStructure(rows: OptionTradeJournalRecord[]): ModeledCrossByStructure {
  const samples: SpreadCostSample[] = [];
  for (const r of rows) {
    if (r.mode !== 'demo') continue;
    if (
      typeof r.entryBid !== 'number'
      || typeof r.entryAsk !== 'number'
      || typeof r.entryMarkUsd !== 'number'
    ) {
      continue;
    }
    samples.push({
      structure: r.structure,
      quote: { bid: r.entryBid, ask: r.entryAsk, mark: r.entryMarkUsd },
    });
  }
  return new Map(
    summarizeSpreadCost(samples).map((s) => [
      s.structure,
      { crossRPremiumBasis: s.avgSpreadCrossRPremiumBasis, probeN: s.n },
    ]),
  );
}

/**
 * TRA-4291 — the per-cell join. Pure arithmetic over numbers the cell fold
 * already has: `netKx = avgR − k · cross · demoClosed / closed` — i.e. each
 * DEMO close is charged `k` crosses and each LIVE close is charged nothing
 * (its booked `realizedR` already paid the real one; charging it again would
 * double-bill exactly the rows whose cost is not modeled). Uses the same
 * `?? 0` missing-R convention as `avgR` so the two columns stay comparable.
 */
function modeledCrossForCell(
  structure: string,
  list: OptionTradeJournalRecord[],
  avgR: number | null,
  probe: ModeledCrossProbe | undefined,
): OptionJournalModeledCross {
  const demoClosedCharged = list.filter((r) => r.mode === 'demo').length;
  const liveClosedUncharged = list.length - demoClosedCharged;
  const base = {
    basis: 'premium' as const,
    acceptanceN: SPREAD_COST_ACCEPTANCE_N,
    demoClosedCharged,
    liveClosedUncharged,
  };
  if (probe === undefined) {
    return {
      ...base,
      avgRNetOfModeledCross1x: null,
      avgRNetOfModeledCross2x: null,
      modeledCrossRPremiumBasis: null,
      probeN: null,
      reason:
        `no spread-cost probe row for structure '${structure}' — no demo fill retaining a `
        + 'fill-time quote has measured its cross, so there is nothing to charge. null, '
        + 'never 0: an unmeasured cost is not a zero cost (TRA-2319).',
    };
  }
  if (probe.probeN < SPREAD_COST_ACCEPTANCE_N) {
    return {
      ...base,
      avgRNetOfModeledCross1x: null,
      avgRNetOfModeledCross2x: null,
      modeledCrossRPremiumBasis: probe.crossRPremiumBasis,
      probeN: probe.probeN,
      reason:
        `spread-cost probe n=${probe.probeN} for '${structure}' is below acceptanceN=`
        + `${SPREAD_COST_ACCEPTANCE_N} — too few measured fills to trust the mean cross as a `
        + 'grading input, so no net is modeled. null, never 0 (TRA-2319).',
    };
  }
  if (avgR === null) {
    // Unreachable in practice — a cell exists only because rows folded into it,
    // and `rollupResolvedForCell` returns null avgR only at closed === 0 — but
    // stated rather than coerced: a cell with no gross mean has no net mean.
    return {
      ...base,
      avgRNetOfModeledCross1x: null,
      avgRNetOfModeledCross2x: null,
      modeledCrossRPremiumBasis: probe.crossRPremiumBasis,
      probeN: probe.probeN,
      reason: 'cell has no gross avgR (0 closed rows), so there is no mean to restate.',
    };
  }
  const chargePerCross = (probe.crossRPremiumBasis * demoClosedCharged) / list.length;
  return {
    ...base,
    avgRNetOfModeledCross1x: avgR - chargePerCross,
    avgRNetOfModeledCross2x: avgR - 2 * chargePerCross,
    modeledCrossRPremiumBasis: probe.crossRPremiumBasis,
    probeN: probe.probeN,
    reason: null,
  };
}

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
  crossModel: ModeledCrossByStructure,
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
      const rollup = rollupResolvedForCell(list);
      return {
        structure,
        exitReason,
        ...rollup,
        // TRA-4291 — the modeled net-of-cross companion to the gross avgR just
        // spread in. Additive: every pre-existing field is byte-identical.
        modeledCross: modeledCrossForCell(structure, list, rollup.avgR, crossModel.get(structure)),
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
        // TRA-4246 (AC3) — and what this cell's OWN rows measured. Distinct,
        // rounded to 4dp so float hair on one row cannot manufacture a second
        // "sleeve"; ascending, so a reader sees the spread at a glance.
        stopRPerPremiumRObserved: (() => {
          const seen = new Set<number>();
          let n = 0;
          for (const r of list) {
            const v = r.stopBasisRPerPremiumR;
            if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) continue;
            n += 1;
            seen.add(Math.round(v * 10000) / 10000);
          }
          return { n, values: [...seen].sort((a, b) => a - b) };
        })(),
        // TRA-4246 (AC1) — the rows' OWN stop-basis R. The export that also
        // carries it is scoped to the caller's book, so without this a desk
        // close on any other book is stamped and unreadable.
        stopBasisR: (() => {
          const values: number[] = [];
          const nullReasons: Record<string, number> = {};
          let unstamped = 0;
          for (const r of list) {
            // Key absent ⇒ a pre-stamp close; key present and null ⇒ a stamped
            // verdict, counted under its reason. The two are different facts.
            if (!('pnlRStopBasis' in r) || r.pnlRStopBasis === undefined) {
              unstamped += 1;
              continue;
            }
            const v = r.pnlRStopBasis;
            if (typeof v === 'number' && Number.isFinite(v)) {
              values.push(v);
              continue;
            }
            const reason = r.pnlRStopBasisReason ?? 'unreasoned';
            nullReasons[reason] = (nullReasons[reason] ?? 0) + 1;
          }
          return {
            n: values.length,
            avg: values.length > 0 ? values.reduce((a, v) => a + v, 0) / values.length : null,
            min: values.length > 0 ? Math.min(...values) : null,
            max: values.length > 0 ? Math.max(...values) : null,
            nullReasons,
            unstamped,
          };
        })(),
        // TRA-4246 (AC2) — the give-back stamp, served. Level-vs-fill slip is a
        // subtraction of two stamped operands, never a derivation off a constant.
        ...(() => {
          const num = (v: unknown): number | null =>
            typeof v === 'number' && Number.isFinite(v) ? v : null;
          const trail = list
            .filter((r) =>
              r.profitLockFire !== undefined
              || r.takeProfitEarlyFire !== undefined
              || TRAIL_FAMILY_EXIT_REASONS.has(exitReason))
            .sort((a, b) => (b.closeTs ?? 0) - (a.closeTs ?? 0));
          const releaseForensics: OptionJournalReleaseForensic[] = trail
            .slice(0, RELEASE_FORENSICS_CAP)
            .map((r) => {
              // TRA-4759 item 3 — a `take_profit_early` close is stamped by its
              // OWN record. Its release level is the capture level the rule
              // fired at (`entry + captureFrac × availableProfit`, both off the
              // stamp — entry recovered as `tp1Premium − availableProfit`), so
              // level-vs-fill slip reads the same way it does for the lock. The
              // displaced family's level rides the row's `takeProfitEarlyFire.
              // profitLock` and the AC4 shadow record, not this list. When a
              // row somehow carries both stamps, the one matching the cell's
              // own exitReason wins.
              const tpf = r.takeProfitEarlyFire;
              const useTpf =
                tpf !== undefined
                && (exitReason === 'take_profit_early' || r.profitLockFire === undefined);
              if (useTpf && tpf !== undefined) {
                const availableProfit = num(tpf.availableProfit);
                const captureFrac = num(tpf.captureFrac);
                const tp1 = num(tpf.tp1Premium);
                const entry =
                  tp1 !== null && availableProfit !== null ? tp1 - availableProfit : null;
                const levelPremium =
                  entry !== null && captureFrac !== null && availableProfit !== null
                    ? entry + captureFrac * availableProfit
                    : null;
                const stopBasisPremium = num(tpf.profitLock?.stopBasisPremium);
                const markAtFire = num(tpf.markAtFire);
                const exitFillPremium =
                  r.pnlBasis === 'broker-fill' ? num(r.exitFillPremium) : null;
                const fillVsLevelPremium =
                  exitFillPremium !== null && levelPremium !== null
                    ? exitFillPremium - levelPremium
                    : null;
                return {
                  optionSymbol: r.optionSymbol ?? null,
                  closeTs: num(r.closeTs),
                  exitReason,
                  stamped: true,
                  // A level trigger that fired IS armed by construction; the
                  // relabel discrimination stays `stamped: false`.
                  armed: true,
                  peakPremiumAtFire: num(tpf.profitLock?.peakPremiumConsumed),
                  peakR: num(tpf.profitLock?.peakR),
                  giveBackR: num(tpf.profitLock?.giveBackR),
                  levelR:
                    levelPremium !== null && entry !== null
                      && stopBasisPremium !== null && stopBasisPremium > 0
                      ? (levelPremium - entry) / stopBasisPremium
                      : null,
                  levelPremium,
                  stopBasisPremium,
                  markAtFire,
                  execBidAtFire: num(tpf.execBidAtFire),
                  exitFillPremium,
                  fillVsLevelPremium,
                  fillVsLevelR:
                    fillVsLevelPremium !== null && stopBasisPremium !== null && stopBasisPremium > 0
                      ? fillVsLevelPremium / stopBasisPremium
                      : null,
                  markVsLevelPremium:
                    markAtFire !== null && levelPremium !== null ? markAtFire - levelPremium : null,
                  pnlRStopBasis: num(r.pnlRStopBasis),
                  // TRA-4246 (AC6) — key-present, so a pre-stamp close reads
                  // `null` and a clean row reads `0`/`false`.
                  closeRejectCount: num(r.closeRejectCount),
                  closeRejectBreakerTripped:
                    typeof r.closeRejectBreakerTripped === 'boolean'
                      ? r.closeRejectBreakerTripped
                      : null,
                };
              }
              const f = r.profitLockFire;
              const levelPremium = num(f?.levelPremium);
              const stopBasisPremium = num(f?.stopBasisPremium);
              const markAtFire = num(f?.markAtFire);
              // Same rule as the export's `exit_price`: only a restated row has
              // a measured fill. A mark is not a fill and is never used as one.
              const exitFillPremium = r.pnlBasis === 'broker-fill' ? num(r.exitFillPremium) : null;
              const fillVsLevelPremium =
                exitFillPremium !== null && levelPremium !== null ? exitFillPremium - levelPremium : null;
              return {
                optionSymbol: r.optionSymbol ?? null,
                closeTs: num(r.closeTs),
                exitReason,
                stamped: f !== undefined,
                armed: typeof f?.armed === 'boolean' ? f.armed : null,
                peakPremiumAtFire: num(f?.peakPremiumAtFire),
                peakR: num(f?.peakR),
                giveBackR: num(f?.giveBackR),
                levelR: num(f?.levelR),
                levelPremium,
                stopBasisPremium,
                markAtFire,
                execBidAtFire: num(f?.execBidAtFire),
                exitFillPremium,
                fillVsLevelPremium,
                fillVsLevelR:
                  fillVsLevelPremium !== null && stopBasisPremium !== null && stopBasisPremium > 0
                    ? fillVsLevelPremium / stopBasisPremium
                    : null,
                markVsLevelPremium:
                  markAtFire !== null && levelPremium !== null ? markAtFire - levelPremium : null,
                pnlRStopBasis: num(r.pnlRStopBasis),
                // TRA-4246 (AC6) — see the type. `true` here says the row was
                // latched, which means `profitLockDecision` never ran on it and
                // the label above is a relabel rather than a release.
                closeRejectCount: num(r.closeRejectCount),
                closeRejectBreakerTripped:
                  typeof r.closeRejectBreakerTripped === 'boolean'
                    ? r.closeRejectBreakerTripped
                    : null,
              };
            });
          return { releaseForensics, releaseForensicsTruncated: trail.length - releaseForensics.length };
        })(),
        // TRA-4246 (AC6) — the breaker fold over EVERY row in the cell, not
        // just the ones that fit under the forensics cap.
        closeRejectBreaker: (() => {
          let stamped = 0;
          let withRejects = 0;
          let breakerTripped = 0;
          for (const r of list) {
            const c = r.closeRejectCount;
            const t = r.closeRejectBreakerTripped;
            if (typeof c !== 'number' || !Number.isFinite(c)) continue;
            stamped += 1;
            if (c > 0) withRejects += 1;
            if (t === true) breakerTripped += 1;
          }
          return { stamped, withRejects, breakerTripped };
        })(),
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
      + '(realizedPnlUsd / atRiskUsd, atRisk = full premium) — the cost-aware gate\'s R is its '
      + 'MODELLED stop distance = 0.25 × premium, so gateR = 4 × the numbers here wherever '
      + 'gateRPerPremiumR is non-null. TRA-4246: that is the GATE\'s basis and NOT the sleeve\'s '
      + 'armed stop — single_leg_otm stops at OTM_OPTIONS_SL_PCT 0.20 (a 5×), so 4× converts to '
      + 'GATE R and NEVER to STOP-BASIS R (doing so understates that sleeve by 20%). '
      + 'stopRPerPremiumRObserved is the divisor this cell\'s own rows measured; more than one '
      + 'value means no single divisor describes the cell. Histogram edges sit EXACTLY on -1.00R and -0.50R; '
      + 'closesBelowMinus050R / closesBelowMinus100R are STRICT (< edge), so a close landing ON '
      + '-0.50R is NOT a violation of TRA-2202\'s "zero closes below -0.50R". minR >= -0.50 '
      + 'settles the criterion for this cell with no float-epsilon question at all.',
    modeledCrossNote:
      'TRA-4291 — cells[].modeledCross puts a MODELED net-of-cross avgR beside the gross one, '
      + 'because 3524/3555 journal rows are demo and demo realizedR books NO spread '
      + '(demoSlippagePct 0, demoFeePerContract 0) — a cell can read scratch while being a '
      + 'repeated unbooked payment of the bid/ask (TRA-4230: gross +0.016 avgR, -17.76R once '
      + 'one mean cross is charged). Each DEMO close is charged the structure\'s MEASURED mean '
      + 'cross, /api/health/option-spread-cost byStructure[].avgSpreadCrossRPremiumBasis — '
      + 'already premium R, same unit as avgR, NO gateRPerPremiumR conversion — over the '
      + 'CUMULATIVE demo probe pool (deliberately not scoped by this response\'s cohort '
      + 'window: the cross is a property of the structure\'s market, and a narrow window '
      + 'shrinking the probe under acceptanceN would null exactly the cells the window '
      + 'grades; probeN and modeledCrossRPremiumBasis on the cell are that route\'s n and '
      + 'cross verbatim). LIVE closes are NEVER charged — their booked realizedR already '
      + 'paid the real cross (liveClosedUncharged counts them). 1x = entry cross only, the '
      + 'conservative floor; 2x = entry + exit, the realistic round trip — both are emitted, '
      + 'neither is silently picked. netKx = avgR - k*cross*demoClosedCharged/closed, same '
      + '?? 0 missing-R convention as avgR so the columns stay comparable. It is a MODEL, '
      + 'not a booked cost: realizedR/avgR/realizedPnlUsd are untouched and stay gross. '
      + '⚠ TRA-2319 — null is NOT a pass: no probe row or probeN < acceptanceN emits null '
      + 'with a reason, never 0, and null <= x is true in JavaScript — gate on !== null '
      + 'before any comparison.',
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

/** TRA-2193 — the same fold, run separately over each account class.
 *  TRA-4291 — `crossModel` is the per-structure modeled-cross input for the
 *  cells' `modeledCross` join, computed ONCE by the caller over the FULL demo
 *  journal (see {@link modeledCrossByStructure} for why it is not
 *  cohort-scoped) and shared by all three class folds. */
function partitionByAccountClass(
  rows: OptionTradeJournalRecord[],
  crossModel: ModeledCrossByStructure,
): {
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
      fixture: { ...summarizeOptionTradeJournal(p.fixture), byStructureExit: crossTabStructureExit(p.fixture, crossModel) },
      desk: { ...summarizeOptionTradeJournal(p.desk), byStructureExit: crossTabStructureExit(p.desk, crossModel) },
      unattributed: {
        ...summarizeOptionTradeJournal(p.unattributed),
        byStructureExit: crossTabStructureExit(p.unattributed, crossModel),
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

/**
 * TRA-4462 AC2 — why each row in the filtered set is NOT in `rows`. Every cell is
 * always present, including the ones the active `rowsMode` cannot produce: a stated
 * `0` and an omitted key are the same bytes to a reader that tests for the key, and
 * the whole point here is that the payload account for the gap by itself.
 */
export interface OptionJournalDumpExclusions {
  /** Dropped for `mode !== 'demo'` (live rows). Only `rowsMode: 'demo'` drops these. */
  notDemoMode: number;
  /** Dropped for `outcome === 'OPEN'`. Only `rowsMode: 'demo'` drops these. */
  stillOpen: number;
  /** Dropped for being already resolved. Only `rowsMode: 'open'` drops these. */
  alreadyClosed: number;
  /**
   * The `?rows=` value was not recognised, so an EMPTY dump was served deliberately
   * (TRA-2082) and the whole filtered set sits here. Its own cell rather than one of
   * the scoping cells above — reporting these as mode/outcome exclusions would name
   * a filter that never ran.
   */
  unrecognisedMode: number;
}

/**
 * TRA-4462 AC2 — count the rows `rowsMode` excluded from the dump, off the SAME
 * filtered set the summary folds. Every cell is always stated, including the ones a
 * given mode cannot drop (they read `0`), so a reader never has to know which mode
 * omits which key to check the invariant in {@link OptionJournalReport.rowsDumped}.
 */
function dumpExclusions(
  summaryRows: readonly OptionTradeJournalRecord[],
  rowsMode: 'demo' | 'open' | 'all' | null | undefined,
): OptionJournalDumpExclusions {
  const zero = { notDemoMode: 0, stillOpen: 0, alreadyClosed: 0, unrecognisedMode: 0 };
  if (rowsMode === 'all') return zero;
  if (rowsMode === 'demo') {
    let notDemoMode = 0;
    let stillOpen = 0;
    for (const r of summaryRows) {
      // Order matters and mirrors the dump predicate exactly: a LIVE row that is
      // also OPEN is dropped by the mode test first, so counting it in both cells
      // would over-explain the gap and break the sum.
      if (r.mode !== 'demo') notDemoMode += 1;
      else if (r.outcome === 'OPEN') stillOpen += 1;
    }
    return { ...zero, notDemoMode, stillOpen };
  }
  if (rowsMode === 'open') {
    let alreadyClosed = 0;
    for (const r of summaryRows) if (r.outcome !== 'OPEN') alreadyClosed += 1;
    return { ...zero, alreadyClosed };
  }
  // `null` — an unrecognised `?rows=` value serves a deliberately EMPTY dump. Its
  // own cell, not one of the scoping cells: attributing these rows to `notDemoMode`
  // would report a filter that was never applied, and the whole point of the null
  // mode is that NO population was selected.
  return { ...zero, unrecognisedMode: summaryRows.length };
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
  // TRA-3715 — the UPPER bounds, and the ET-session-day window that resolves to
  // one. Collected into an options object rather than positions 9/10/11: this
  // signature is already seven deep and a caller counting `undefined`s is how a
  // filter silently lands on the wrong axis. Every existing caller omits it and
  // is byte-unchanged.
  bounds: {
    /** ENTRY-axis upper bound, epoch ms, INCLUSIVE. Pairs with `sinceTs`. */
    untilTs?: number;
    /** EXIT-axis upper bound, epoch ms, INCLUSIVE. Pairs with `closedSinceTs`. */
    closedUntilTs?: number;
    /** ET session-day window on `closeTs`; when set it OWNS the exit axis. */
    etDayWindow?: EtDayCloseWindow | null;
  } = {},
): OptionJournalReport {
  const { untilTs, closedUntilTs, etDayWindow } = bounds;
  // TRA-3380 — ONE axis serves a response; the route rejects both params at
  // once, so `filterAxis` is never ambiguous about what it is reporting.
  // TRA-3715 — the ET-day window is an EXIT-axis filter too, so it joins the
  // same axis rather than adding a third.
  const closeAxis =
    closedSinceTs !== undefined || closedUntilTs !== undefined || !!etDayWindow;
  // The resolved bounds, in one place, so the filter below and the `window`
  // echo on the wire can never describe different windows.
  const fromMs = etDayWindow
    ? etDayWindow.fromMs
    : closeAxis
      ? (closedSinceTs ?? null)
      : (sinceTs ?? null);
  const toMs = etDayWindow ? etDayWindow.toMs : closeAxis ? (closedUntilTs ?? null) : (untilTs ?? null);
  const summaryRows = closeAxis
    ? // An OPEN row has no `closeTs`, so it cannot satisfy "closed in [from,to]"
      // and is excluded. That is the point of the axis: an exit-scoped
      // criterion's population is the rows that actually CLOSED in the window.
      rows.filter((r) => {
        const closeTs = (r as OptionTradeJournalRecord).closeTs;
        if (typeof closeTs !== 'number' || !Number.isFinite(closeTs)) return false;
        return (fromMs === null || closeTs >= fromMs) && (toMs === null || closeTs <= toMs);
      })
    : rows.filter(
        (r) => (fromMs === null || r.openTs >= fromMs) && (toMs === null || r.openTs <= toMs),
      );
  const rowsMode: 'demo' | 'open' | 'all' | null | undefined =
    rowsRequest === false ? undefined
      : rowsRequest === true || rowsRequest === 'demo' ? 'demo'
        : rowsRequest === 'open' ? 'open'
          : rowsRequest === 'all' ? 'all'
            // An unrecognised `?rows=` value. Emit an EMPTY dump with a null mode
            // rather than falling back to `demo`: silently serving a different
            // population than the one asked for is the TRA-2082 failure shape.
            : null;
  const dumpSource: OptionTradeJournalRecord[] | undefined =
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
  // TRA-3715 — stamp the class and the ET close day ONTO each dumped row. A
  // hand-fold over this array is exactly what produced TRA-3682's and
  // TRA-3709's fabricated baselines, and it did so because the array carried no
  // axis to fold on. Same classifier as `byAccountClass`, so the two cannot
  // disagree. See {@link OptionJournalDumpRow}.
  const dumpRows: OptionJournalDumpRow[] | undefined = dumpSource?.map((r) => ({
    ...r,
    accountClass: classifySpreadCeilingAccount(r.account),
    closeEtDay: rowCloseEtDay(r),
    // TRA-4674 — the row at the cross (pay the ask, sell the bid), beside its
    // booked realizedPnlUsd. `null` + a named reason when unpriceable — never 0.
    ...priceCrossedRow(r),
  }));
  return {
    ok: true,
    time: new Date(now).toISOString(),
    build: resolveBuildInfo(),
    enabled,
    shrinkageEnabled: isLearnedShrinkageEnabled(),
    summary: {
      ...summarizeOptionTradeJournal(summaryRows),
      // TRA-4291 — the modeled-cross inputs are folded from the FULL journal
      // passed in (`rows`, mode-pinned to demo inside the helper), not the
      // cohort-filtered `summaryRows`, so the per-cell probe matches
      // /api/health/option-spread-cost's cumulative byStructure verbatim.
      ...partitionByAccountClass(
        summaryRows as OptionTradeJournalRecord[],
        modeledCrossByStructure(rows as OptionTradeJournalRecord[]),
      ),
      // TRA-3381 — the mode partition folds the SAME sinceTs-filtered set as the
      // summary and the class partition; three folds over two populations in one
      // 200 is the TRA-2082 shape.
      ...partitionByMode(summaryRows as OptionTradeJournalRecord[]),
    },
    // TRA-2193 — hoisted to the top level so a consumer that reads nothing else
    // still cannot miss that fixture rows are in the pool.
    ...accountClassRowCounts(summaryRows as OptionTradeJournalRecord[]),
    integrity: getOptionTradeJournalIntegrity(),
    // TRA-3715 — folded off the SAME filtered set as `summary` and the two
    // partitions. Four folds over one population; a second population in one
    // 200 is the TRA-2082 shape.
    sleeveCells: foldOptionSleeveCells(summaryRows as OptionTradeJournalRecord[]),
    window: {
      axis: closeAxis ? 'closeTs' : 'openTs',
      fromMs,
      toMs,
      fromInclusive: true as const,
      toInclusive: true as const,
      etDay: etDayWindow ?? null,
      note:
        'The window that served this response. `axis` names the timestamp compared against; '
        + 'both bounds are INCLUSIVE and `null` means unbounded on that side, so a LIFETIME '
        + 'fold reads fromMs:null,toMs:null. Entry axis: ?sinceTs=/&untilTs= (epoch ms on '
        + 'openTs). Exit axis: ?closedSinceTs=/&closedUntilTs= (epoch ms on closeTs) or '
        + '?sinceEtDay=/&untilEtDay= (YYYY-MM-DD ET SESSION DAYS on closeTs, both inclusive, '
        + 'DST resolved per-instant) — the exit axis is the one a sleeve grade wants. The two '
        + 'axes cannot be mixed in one request; on the exit axis rows still OPEN are excluded '
        + 'by construction. TRA-3715.',
    },
    // TRA-2214 / TRA-3831 — BOTH branches must fold on the same basis, and the
    // basis has TWO axes: account class AND mode. The enforced invariant is that
    // whichever branch runs, the rows folded here have passed the demo `mode` pin
    // and then the desk+unattributed account-class predicate.
    //
    //   • cached branch — `OptionWeightsCache`, whose default load is
    //     `loadModelFacingJournalRows()`. The mode pin is the STORE filter inside
    //     `loadModelFacingJournal` (`model-facing-journal.ts`), one layer ABOVE
    //     `applyModelFacingBasis`.
    //   • fallback branch — `rows` is the route's own POOLED
    //     `listOptionTradeJournal()` read, so it never reaches that layer. It is
    //     routed through `applyModelFacingFoldBasis`, which composes the SAME mode
    //     literal (`MODEL_FACING_JOURNAL_MODE`) with the same account predicate.
    //
    // `applyModelFacingBasis` ALONE is not sufficient and was what used to be here:
    // it calls `excludeTestAccountRows` and never looks at `mode`, so the fallback
    // folded a pooled population — including live rows — under one field name and
    // the `weightsBasis: 'desk+unattributed'` label, which is a statement about
    // account class only. One field, two bases, switching on cache warmth, with no
    // tell in the payload. (Dead today: the only production caller always supplies
    // `cached`. The defence was one call site, not an invariant.)
    //
    // `summary` above stays deliberately POOLED — it is the readout that publishes
    // the TRA-2193 account-class census and the TRA-3381 mode partition — which is
    // why `weightsBasis` is stated separately rather than assumed to cover both.
    weights: cached?.weights ?? computeOptionLearnedWeights(applyModelFacingFoldBasis(rows).rows),
    weightsBasis: MODEL_FACING_JOURNAL_BASIS,
    ...(cached ? { weightsFreshness: cached.freshness } : {}),
    ...(sinceTs === undefined ? {} : { sinceTs }),
    appliedSinceTs: sinceTs ?? null,
    // TRA-3380 — `openTs` remains the value on the cumulative and `sinceTs`
    // readouts, so those payloads are byte-unchanged. The new keys below appear
    // ONLY under the exit axis.
    filterAxis: closeAxis ? 'closeTs' : 'openTs',
    // TRA-3715 — `closeAxis` can now be entered by `closedUntilTs` or by the
    // ET-day window alone, so the two legacy echo keys are emitted only when
    // their own param was actually supplied. Emitting `closedSinceTs:
    // undefined` would put a key on the wire that says "no lower bound" and
    // reads, to a `'closedSinceTs' in body` check, as if one had been applied.
    ...(closeAxis ? { closeAxisExcludesOpenRows: true as const } : {}),
    ...(closedSinceTs === undefined
      ? {}
      : { closedSinceTs, appliedClosedSinceTs: closedSinceTs }),
    ...(dumpRows === undefined
      ? {}
      : {
          rows: dumpRows,
          rowsFiltered: sinceTs !== undefined || closeAxis,
          rowsMode,
          // Journal rows are entry economics; they hold no live mark. Say so
          // rather than letting a consumer read a missing field as $0 unrealized.
          rowsCarryMarks: false as const,
          // TRA-4462 AC2 — the dump's denominator, counted off the SAME `summaryRows`
          // set the summary folds, so the invariant below is arithmetic rather than a
          // claim. Re-deriving either side from `rows` would make them agree with
          // themselves and prove nothing.
          rowsDumped: dumpRows.length,
          rowsExcludedFromDump: dumpExclusions(
            summaryRows as OptionTradeJournalRecord[],
            rowsMode,
          ),
          rowsDumpNote:
            'TRA-4462 — `rows` is a SUBSET of the population `summary` folds, selected by '
            + '`rowsMode`; do NOT compare rows.length against summary.total. '
            + 'rowsDumped + the SUM of every cell in rowsExcludedFromDump === summary.total, '
            + 'always, in every mode. rowsMode=demo drops live rows AND still-OPEN rows '
            + '(it is the resolved-demo cohort); rowsMode=open keeps only OPEN rows, both '
            + 'modes; rowsMode=all drops nothing. Use ?rows=all for a row-level expansion of '
            + '`summary`.',
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
    // TRA-4281 — the exit dimension, read from the fold that already exists
    // (`getLiveStopActionability`, the TRA-3839 join), never re-derived here.
    // A throw — or an engine that does not expose the fold — publishes
    // `instrumentBlind: true`, which the summarizer refuses to read as green on
    // a live book: blind and clean must not share a status.
    liveStopActionability: (() => {
      try {
        const read = ctx.engine.getLiveStopActionability?.(now);
        return read !== undefined
          ? { instrumentBlind: false as const, ...read }
          : {
              instrumentBlind: true as const,
              blindReason: 'engine does not expose getLiveStopActionability',
            };
      } catch (err) {
        return {
          instrumentBlind: true as const,
          blindReason: err instanceof Error ? err.message : String(err),
        };
      }
    })(),
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
  /**
   * TRA-3464 — the interlock-region accumulator, DEMOTED to where it belongs.
   *
   * These are the exact numbers that used to be published as
   * `books.<book>.tickExitRegionMs` (and, until TRA-3464 Step 4 deleted the
   * unscoped spelling, fleet-summed at the top level): every
   * closed region since boot, no market-hours predicate, no boot guard. They are
   * the right population for "is the interlock being held at all" and the WRONG
   * one for TRA-2268's narrowing decision. Same demotion, same reason, as the
   * interval terms beside them.
   */
  tickExitRegionMs: ExitCadenceTickRegionTerms;
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
 * TRA-3464 — TRA-2257's suppression window, RTH-SCOPED AND BOOT-GUARDED, per
 * book. This is the spelling TRA-2268's narrowing decision and TRA-2305's
 * measurement should read.
 *
 * WHAT THIS REPLACES. `books.<book>.tickExitRegionMs` used to be
 * `sumTickExitRegion(engines)` — the same unfiltered lifetime-since-boot
 * accumulator the top level published, copied one level down and emitted as a
 * sibling of the RTH-only terms (`samples`, `atOrAbove30s`, `p99Under30s`,
 * `intervalHistogram`), while `books.<book>.lifetime` carried no region terms at
 * all. A PER-BOOK COPY OF A FLEET FIELD IS NOT A PARTITION: it mislabels the
 * accumulator BY POSITION, and position is the only label most readers ever
 * read. Measured on bqb1 `10e68acf9c2e`, 2026-08-13:
 *
 *     books.demo.samples                  = 0     <- RTH intervals: NONE
 *     books.demo.verdict                  = "armed_but_no_rth_interval"
 *     books.demo.lifetime.samples         = 6748
 *     books.demo.tickExitRegionMs.samples = 6810  <- at the RTH level, IS lifetime
 *     $.window                            = "rth"
 *
 * The lifetime numbers are not deleted, they are DEMOTED to
 * `lifetime.tickExitRegionMs`, unchanged.
 */
export interface ExitCadenceTickRegionRthTerms {
  /** Literal, so a reader cannot mistake the scope by position. */
  window: 'rth';
  /** Regions with BOTH endpoints inside 09:30-16:00 ET, cold-boot region excluded. */
  samples: number;
  sumMs: number;
  maxMs: number | null;
  atOrAbove20s: number;
  atOrAbove30s: number;
  /** TRA-3444's split over THIS population. Null until an RTH region commits — never zero-filled. */
  exitWorkMs: ExitCadenceExitWorkTerms | null;
  /** Regions with one endpoint each side of the open or the close. */
  boundaryRegions: number;
  /** Regions with both endpoints outside RTH. */
  closedRegions: number;
  /** Did the cold-boot guard fire on ANY engine in this book. */
  bootRegionExcluded: boolean;
  /**
   * HOW MANY engines dropped a cold-boot region — one per engine, so this is the
   * term the book-level partition needs. The per-engine boolean cannot be summed
   * and a book has up to 57 engines in it.
   */
  bootRegionsExcluded: number;
  /**
   * The LARGEST cold-boot region dropped in this book, and their total. Null when
   * the guard has not fired.
   *
   * Deliberately NOT spelled `bootRegionMs`. At ENGINE level that name denotes
   * exactly one region and is unambiguous (and `engines[].tickExitRegionMs.rth`
   * publishes it under that name); at BOOK level it would be an aggregate over N
   * engines wearing an unscoped scalar name, which is the defect this whole
   * ticket exists to remove.
   */
  bootRegionMaxMs: number | null;
  bootRegionSumMs: number | null;
  /**
   * `lifetime.tickExitRegionMs.samples === samples + boundaryRegions +
   *  closedRegions + bootRegionsExcluded`, AND every engine's own copy of that
   *  identity holds.
   *
   * Both arms, because the summed identity alone can be satisfied by two engines
   * whose errors cancel. Excluded regions are COUNTED, NOT DROPPED: a silently
   * shrunken denominator is the failure this route was rebuilt to prevent, and
   * this is how a reader would find out the classifier was wrong.
   */
  partitionHolds: boolean;
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
  /**
   * TRA-3464 — GRADED (RTH-only, boot-guarded) region terms. Was the fleet-summed
   * lifetime accumulator; those numbers moved to `lifetime.tickExitRegionMs`
   * unchanged.
   */
  tickExitRegionMs: ExitCadenceTickRegionRthTerms | null;
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
  /*
   * TRA-3464 Step 4 — the top-level `tickExitRegionMs` is GONE, completing
   * TRA-2698's ADD-then-verify-then-migrate-then-REMOVE order. It was
   * fleet-summed with no RTH predicate and no boot guard, so its `maxMs` was
   * whichever book's LIFETIME max wearing an unscoped name. The replacements
   * are `books.<book>.tickExitRegionMs` (RTH-scoped, boot-guarded) and
   * `books.<book>.lifetime.tickExitRegionMs` (the old numbers, per book).
   * Its ABSENCE at the top level is the acceptance read; do not re-add it.
   */
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
function sumTickExitWork(
  engines: ExitCadenceHealth[],
  pick: (e: ExitCadenceHealth) => ExitCadenceExitWorkTerms | null,
): ExitCadenceExitWorkTerms | null {
  const terms = engines.map(pick).filter((w): w is ExitCadenceExitWorkTerms => w != null);
  if (terms.length === 0) return null;
  return {
    samples: terms.reduce((n, w) => n + w.samples, 0),
    sumMs: terms.reduce((n, w) => n + w.sumMs, 0),
    maxMs: terms.reduce((m, w) => (w.maxMs > m ? w.maxMs : m), 0),
  };
}

const maxOverEngines = (
  engines: ExitCadenceHealth[],
  pick: (e: ExitCadenceHealth) => number | null,
) =>
  engines.reduce<number | null>((acc, e) => {
    const v = pick(e);
    return v != null && (acc == null || v > acc) ? v : acc;
  }, null);

/**
 * TRA-3464 — sum the RTH-SCOPED, BOOT-GUARDED region terms over a book.
 *
 * Every engine classified its own regions with its own `isStockMarketOpen`
 * reads, so this is a sum of per-engine partitions and NOT a re-classification —
 * there is no second RTH test anywhere in this file.
 *
 * `partitionHolds` is computed BOTH ways deliberately. The summed identity is
 * the one a reader can verify from the published numbers; the per-engine `every`
 * is what stops two engines with cancelling errors from summing to a true. An
 * aggregate invariant that a mixed population can satisfy while no member does
 * is not an invariant.
 */
function sumTickExitRegionRth(engines: ExitCadenceHealth[]): ExitCadenceTickRegionRthTerms {
  const rth = engines.map((e) => e.tickExitRegionMs.rth);
  const bootRegions = rth.map((r) => r.bootRegionMs).filter((m): m is number => m != null);
  const samples = rth.reduce((n, r) => n + r.samples, 0);
  const boundaryRegions = rth.reduce((n, r) => n + r.boundaryRegions, 0);
  const closedRegions = rth.reduce((n, r) => n + r.closedRegions, 0);
  const bootRegionsExcluded = bootRegions.length;
  const lifetimeSamples = engines.reduce((n, e) => n + e.tickExitRegionMs.samples, 0);
  return {
    window: 'rth',
    samples,
    sumMs: rth.reduce((n, r) => n + r.sumMs, 0),
    maxMs: maxOverEngines(engines, (e) => e.tickExitRegionMs.rth.maxMs),
    atOrAbove20s: rth.reduce((n, r) => n + r.atOrAbove20s, 0),
    atOrAbove30s: rth.reduce((n, r) => n + r.atOrAbove30s, 0),
    exitWorkMs: sumTickExitWork(engines, (e) => e.tickExitRegionMs.rth.exitWorkMs),
    boundaryRegions,
    closedRegions,
    bootRegionExcluded: bootRegionsExcluded > 0,
    bootRegionsExcluded,
    bootRegionMaxMs: bootRegions.length > 0 ? Math.max(...bootRegions) : null,
    bootRegionSumMs: bootRegions.length > 0 ? bootRegions.reduce((n, m) => n + m, 0) : null,
    partitionHolds:
      rth.every((r) => r.partitionHolds)
      && lifetimeSamples === samples + boundaryRegions + closedRegions + bootRegionsExcluded,
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
    exitWorkMs: sumTickExitWork(engines, (e) => e.tickExitRegionMs.exitWorkMs),
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
      // TRA-3464 — the region accumulator, byte-for-byte what
      // `books.<book>.tickExitRegionMs` used to carry, moved to the scope it was
      // always computed over. A reader diffing the two builds sees these numbers
      // stand still and the RTH ones appear; nothing was silently recomputed.
      tickExitRegionMs: sumTickExitRegion(engines),
    },
    decoupledPassCount,
    tickPassCount,
    decoupledFireCount,
    decoupledSkips,
    // TRA-3464 — GRADED SCOPE. RTH-only, boot-guarded, exclusions counted.
    tickExitRegionMs: sumTickExitRegionRth(engines),
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
      + 'sub-window. '
      + 'TRA-3464: `books.<book>.tickExitRegionMs` is the SUPPRESSION WINDOW doTick holds the exit '
      + 'interlock for (news + social + market-review + journal + tradier-balance + the 568-symbol '
      + 'quote-batch + 3 reconciles + shadow-chases), and it is now RTH-SCOPED AND BOOT-GUARDED like '
      + 'everything beside it: it carries `window: "rth"` as a literal and counts ONLY regions with '
      + 'BOTH endpoints inside 09:30-16:00 ET, classified by the SAME `isStockMarketOpen` the '
      + 'decoupled gate itself refuses on. Worst-case exit interval is bounded by THAT plus the timer '
      + 'period, never by the timer period alone, so a region at or above 30s makes `p99Under30s` '
      + 'unreachable however well the timer behaves — which is why it has to be measured over the '
      + 'window it is a claim about. Excluded regions are COUNTED, NOT DROPPED: '
      + '`lifetime.tickExitRegionMs.samples === tickExitRegionMs.samples + boundaryRegions + '
      + 'closedRegions + bootRegionsExcluded` (`partitionHolds`, which additionally requires every '
      + 'engine\'s own copy of that identity to hold, so two engines with cancelling errors cannot '
      + 'sum to a true). The COLD-BOOT region — the first region each engine closes, carrying '
      + 'cold-start work no steady-state region carries and therefore a plausible candidate for the '
      + 'published `maxMs` — is excluded ahead of the RTH test and PUBLISHED as `bootRegionMaxMs` / '
      + '`bootRegionSumMs` rather than dropped: a guard whose effect is unobservable cannot be told '
      + 'apart from a guard that never fired. The pre-TRA-3464 lifetime numbers are not gone, they '
      + 'are DEMOTED unchanged to `books.<book>.lifetime.tickExitRegionMs`. The TOP-LEVEL '
      + '`tickExitRegionMs` is DELETED as of TRA-3464 Step 4: it was fleet-summed with no RTH '
      + 'predicate and no boot guard, so on 2026-08-13 its `samples 7143` was `books.live 333` + '
      + '`books.demo 6810` and its `maxMs 14121` was the LIVE book\'s max wearing an unscoped name. '
      + 'A payload that still carries a top-level `tickExitRegionMs` is a pre-Step-4 build. Read '
      + '`books.<book>.tickExitRegionMs`. A payload whose `books.<book>.tickExitRegionMs` carries NO `window` key '
      + 'is a pre-TRA-3464 build where that field is the LIFETIME accumulator sitting among '
      + 'RTH-scoped siblings — FAIL CLOSED on its absence, do not read it as the graded scope.',
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
    // TRA-4851 — the SHA alone reads identically 600 commits behind and at the
    // tip (the TRA-4849 boot-resurrect incident), so the running commit's AGE
    // at boot is published beside it as a keyable staleness verdict.
    const build = resolveBuildInfo();
    res.json({
      ...build,
      staleness: resolveBuildStaleness({ commit: build.commit, bootMs: Date.parse(build.startedAt) }),
    });
  });

  /**
   * TRA-4478 — the exchange calendar this build is running, and whether it
   * still covers today.
   *
   * ⛔ WHY THIS IS A ROUTE AND NOT JUST A REPO CHECK. `pnpm
   * check:calendar-coverage` grades the CHECKOUT; the local checkout is a fork
   * of whatever the money host is serving, and a host eleven commits behind
   * reports its SHA with exactly as much confidence as one at the tip. The
   * calendar that matters is the one in the running build, so it has to be
   * readable FROM the running build.
   *
   * Unauthenticated and names no balances, symbols or usernames — it publishes
   * a version string, a date window and a day count.
   *
   * `fallbackDates` is the discriminator, and it must never be read as "absent
   * ⇒ zero": it is present and `[]` on a healthy host. A non-empty list means
   * this process has already served a session verdict it GUESSED from the day
   * of week, and names exactly which dates — the mis-dating is otherwise
   * invisible in every downstream fold.
   */
  app.get('/api/health/exchange-calendar', (_req, res) => {
    const today = etDateString(new Date(now()));
    const freshness = calendarFreshness(today);
    res.json({
      issue: 'TRA-4478',
      etDate: today,
      calendar: calendarCoverage(),
      freshness,
      /** Entry posture for each asset class, as the risk governor sees it. */
      entry: {
        equities: calendarEntryGate(today, 'equities'),
        options: calendarEntryGate(today, 'options'),
        crypto: calendarEntryGate(today, 'crypto'),
      },
      session: {
        resolution: resolveSessionDate(today, 'equities'),
        closureName: exchangeClosureName(today),
        earlyCloseName: earlyCloseName(today),
        /** Minutes past ET midnight; 780 on a 13:00 half day, 960 normally, null off-session. */
        closeEtMinute: sessionCloseEtMinute(today, 'equities'),
      },
      fallback: {
        distinctUncoveredDates: calendarFallbackCount(),
        dates: calendarFallbackDates(),
      },
      note:
        'The exchange calendar keys the session gate AND every per-ET-day fold (EOD, risk-day, promotion ' +
        'evidence), so a wrong session boundary mis-dates rows rather than announcing itself. `freshness.status` ' +
        'is four-valued: fresh | expiring (covered, cliff inside 180d) | stale (⛔ today is UNCOVERED — entries ' +
        'are failing closed) | unreadable (⛔ could not check; never conflate with fresh). Exits are NEVER gated ' +
        'by this — a stale calendar that trapped a position would be worse than the bug. Crypto is exempt: it ' +
        'has no exchange calendar, so it cannot have a stale one. `fallback.dates` non-empty ⇒ this process has ' +
        'already emitted session verdicts guessed from the day of week; treat every fold keyed on those dates ' +
        'as unverified. Remedy for stale/expiring: raise COVERAGE_END_YEAR in scripts/gen-nyse-calendar.mjs, ' +
        're-run it, ship.',
    });
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

  // TRA-4413 item 4 — unauthenticated, secrets-free cross-expiration
  // TERM-STRUCTURE SHADOW readout (parity with /iv-rv: counters and structure
  // only, no balances/PII). `enabled` mirrors ENABLE_TERM_STRUCTURE_SHADOW —
  // default OFF, so until the board arms it this surface is an honest zero
  // rather than a 404. The `markCalendarViolations` / `invalidatedScans` pair
  // is the negative control: any non-zero there says the detector's own inputs
  // went incoherent, and its findings for those scans were discarded, not
  // published. Read-only: routes no order.
  app.get('/api/health/term-structure-shadow', (_req, res) => {
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      ...summarizeTermStructureShadow(),
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
      // TRA-4335 — the DURABLE per-ET-day guard fold. Everything above this line is
      // since-boot and zeroes on every deploy; `retained` survives the reboot and
      // carries the presented/evaluated/rejected denominator, so a post-boot read
      // can tell an enforcing-and-quiet cap from a dark one (state: live_clean vs
      // dark) instead of inferring it from the journal's open distribution.
      retained: summarizeChurnBrakeGuard(),
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

  /**
   * TRA-4607 — progress toward the net-of-fee forward-validation bar, measured
   * off the LIVE fee/slippage ledger rather than read from a stale report.
   *
   * Read-only. No order path, no balances, no PII — round-trip counts, σ, and
   * the required-N those imply.
   *
   * ⛔ `unmeasured: true` is NOT a failing grade. It means no graded sleeve has a
   * priced round-trip yet, which is a different fact from "the sleeves lost
   * money", and `excluded` says where the rows went.
   */
  app.get('/api/health/validation-progress', (_req, res) => {
    const report = computeValidationProgress();
    res.json({
      ok: true,
      issue: 'TRA-4607',
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      ...report,
    });
  });

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
      // TRA-4474 — the INTENDED value of every production env lever, beside the
      // effective one. `policy` above is what the process resolved; for ~50 days
      // that was `observe` on a box the record says was armed `refuse`, and this
      // route could not disagree with itself because it published no second term.
      // The intent is compiled in from `env-intent.ts` (the env is the thing that
      // can vanish, so the intent must not live there). `envIntent.ok` is
      // tri-state: `null` off-production is UNGRADED, never a pass — see
      // `pnpm check:env-intent`, which fails closed on it.
      envIntent: summarizeEnvIntent(process.env),
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
    // TRA-3926 — derive ONCE and serve the same snapshot (TRA-3723's read-once
    // rule); capture BEFORE summarizing the durable store so a judgement served
    // on this response is never transiently absent from its own carrier.
    const oversoldCloseCensus = detectOversoldEngineCloses(summary.records);
    const judgedOversoldCapture = captureJudgedOversoldCloses(oversoldCloseCensus);
    const testUntil = parseOptionLiveTestUntil(liveEnv);
    // TRA-3694 — the same principle as `arm.universe.ratification`, applied to the
    // resolved caps. `notionalCapUsd: 350` reads IDENTICALLY whether the board
    // authorised 350 or 250; the resolved value proves what the order site uses
    // and says nothing about what it was allowed to use.
    const notionalCapLive = resolveLiveOptionTestNotionalCapUsd(liveEnv);
    const aggregateCapLive = resolveLiveOptionTestAggregateCapUsd(liveEnv);
    const capRatification = {
      notionalCap: resolveNumericRatification(
        LIVE_OPTION_TEST_NOTIONAL_CAP_RATIFIED_VAR,
        LIVE_OPTION_TEST_CAPS_RATIFIED_BY_VAR,
        'per-entry notional cap (USD)',
        notionalCapLive,
        liveEnv,
      ),
      aggregateCap: resolveNumericRatification(
        LIVE_OPTION_TEST_AGGREGATE_CAP_RATIFIED_VAR,
        LIVE_OPTION_TEST_CAPS_RATIFIED_BY_VAR,
        'fleet aggregate cap (USD)',
        aggregateCapLive,
        liveEnv,
      ),
    };
    // TRA-3723 — read ONCE. The published rows and the fleet grade below must be
    // the same snapshot: two calls walk every engine twice and could serve a sum
    // that no row set on this response supports.
    const aggregateExposureRows = deps.liveOtmAggregateExposure?.() ?? null;
    // TRA-3976 — `?? null` and NOT `?? []`: an unwired provider must reach the
    // census as "cannot say", not as "the fleet holds nothing", which would
    // grade every open ledger episode a phantom.
    const heldLiveOptionSymbols = deps.liveOpenOptionSymbols?.() ?? null;
    // TRA-4144 — read ONCE, for the same reason as `aggregateExposureRows`
    // above (TRA-3723): `fleetConcentration` and `underlyingAssetClass` below
    // must grade the SAME fleet snapshot, and two provider calls walk every
    // engine twice and could disagree on this one response.
    const concentrationBooks = deps.liveOtmConcentration?.() ?? null;
    // TRA-3977 (2026-08-27) — the books this process is SERVING live, from the
    // same fleet snapshot the rows above were taken from, so the registry the
    // scoping gate reads can be graded against it on every beat. `null` when
    // the provider is unwired: "cannot say", never "serving nothing".
    const liveBooksServed: string[] | null =
      aggregateExposureRows === null
        ? null
        : [
            ...new Set(
              aggregateExposureRows
                .filter((r) => r.mode === 'live')
                .map((r) => r.book)
                .filter((b): b is string => typeof b === 'string' && b.length > 0),
            ),
          ].sort();
    res.json({
      ok: true,
      time: new Date(nowMs).toISOString(),
      build: resolveBuildInfo(),
      /**
       * ⭐ TRA-3976 — episodes this ledger reports OPEN that no book holds.
       *
       * A close the fill ledger never saw (the broker closes a position out of
       * band; the reconcile drops our row) used to leave the episode readable as
       * OPEN for the whole 30-day retention window — and three oracles read that
       * phantom: the at-risk fold credited the engine with contracts it does not
       * hold, `ledgerOpenProvenance` stamped a returning contract
       * `engine_origin`, and the exit bound would have SOLD it.
       *
       * `verdict: 'phantom'` is the defect and the only value that should page.
       * `blind` means the held-symbol provider is unwired — read `wired` first;
       * it never folds to `clean`. `terminalMarkers` / `terminatedEpisodes` are
       * the REMEDIATED population (the reconcile recorded the drop), and
       * `durability.ephemeral: true` means those markers die at the next
       * redeploy and every terminated episode silently reverts to its phantom.
       */
      phantomOpenEpisodes: phantomOpenEpisodeCensus(heldLiveOptionSymbols),
      /**
       * ⭐ TRA-3977 (AC5) — CAN `records[]` BE PARTITIONED BY BOOK AT ALL, and
       * is any OCC open on two live books right now?
       *
       * The fill ledger is a PROCESS-GLOBAL array and this box serves two live
       * books. Until TRA-3977 nothing on a row said which one placed it, so the
       * exit bound's two oracles — keyed on the OCC alone — could size `admin`'s
       * `sell_to_close` off a fill placed on `v0nni`, against a different broker
       * account, and report it `bounded: false` / `blind: false`: a row the exit
       * census recorded as CHECKED AND CLEAN.
       *
       * ⚠ READ `verdict` AND `unattributedRows`, IN THAT ORDER. `clean` means
       * MEASURED-and-no-overlap; `overlap` means the permissive branch is
       * reachable TODAY (not itself a defect — the scoping is what makes it
       * safe — but it is the number that says the fix is load-bearing rather
       * than argued); `unattributed` means the tape carries rows with no book
       * and the overlap question CANNOT BE ANSWERED for those symbols. A quiet
       * tape and a tape nobody can read must not share a byte.
       *
       * ⚠ `scopingReachable: false` ⇒ at most one book is known to this store,
       * every oracle answers exactly as it did pre-TRA-3977, and this whole
       * block is a no-op by construction. The PRESENCE of this key is the
       * deployed-bytes proof (a build without it lacks the key entirely).
       *
       * ⚠ READ `unregisteredLiveBooks` BEFORE `scopingReachable` (2026-08-27).
       * `booksServedLive` is what the fleet walk says this process is serving
       * in `mode: 'live'` RIGHT NOW; `books` is what the ledger's registry
       * knows. On bqb1 `56804e1a` the boot hydrate wiped the registry after
       * the engines had declared themselves, so this route served TWO live
       * books beside `books: ["admin"]` and `scopingReachable: false` — the
       * scoping was a no-op on the box it was written for and nothing on the
       * wire said so. A non-empty `unregisteredLiveBooks` is that defect,
       * named; `null` means the fleet walk is unwired and it cannot be graded.
       */
      crossBookEpisodes: {
        ...summary.crossBook,
        booksServedLive: liveBooksServed,
        unregisteredLiveBooks:
          liveBooksServed === null
            ? null
            : liveBooksServed.filter((b) => !summary.crossBook.books.includes(b)),
      },
      otmFlag: 'ENABLE_OPTION_LIVE_OTM',
      rvFlag: 'ENABLE_OPTION_LIVE_RV_LONG',
      windowVar: 'OPTION_LIVE_TEST_UNTIL',
      // TRA-2536 — the RESOLVED per-entry size the order site will actually use, not
      // the compiled default. Reporting the constant here would read identically on a
      // box running a different cap/size, which is the whole failure class: a size
      // parameter with no read path cannot be verified after arming.
      notionalCapUsd: notionalCapLive,
      notionalCapDefaultUsd: LIVE_OPTION_TEST_NOTIONAL_CAP_USD,
      notionalCapCeilingUsd: LIVE_OPTION_TEST_NOTIONAL_CEILING_USD,
      notionalCapVar: LIVE_OPTION_TEST_NOTIONAL_CAP_VAR,
      maxContracts: resolveLiveOptionTestMaxContracts(liveEnv),
      maxContractsVar: LIVE_OPTION_TEST_MAX_CONTRACTS_VAR,
      maxContractsHardMax: LIVE_OPTION_TEST_CONTRACTS_HARD_MAX,
      // TRA-3445 — the board's THIRD clause ("max $750 total"), which had no
      // enforcement path until now. Same publication contract as the per-entry
      // pair above: the RESOLVED value, not the constant.
      aggregateCapUsd: aggregateCapLive,
      aggregateCapDefaultUsd: LIVE_OPTION_TEST_AGGREGATE_CAP_USD,
      aggregateCapCeilingUsd: LIVE_OPTION_TEST_AGGREGATE_CEILING_USD,
      aggregateCapVar: LIVE_OPTION_TEST_AGGREGATE_CAP_VAR,
      /**
       * ⭐ TRA-3694 — the AUTHORIZATION behind the two resolved caps above.
       * Every `*CapUsd` here proves what the order site USES and is silent on
       * what it was ALLOWED to use, so an unratified cap and a ratified one read
       * byte-identically — the same defect this ticket fixed on `arm.universe`.
       *
       * READ `.matchesLive` on each, and `ratificationMatchesLive` for the fold.
       * `true | false | null`; an unset stamp is `null` — UNKNOWN — and NEVER
       * `true`. It is FALSY on purpose (TRA-4619), so `if (matchesLive)` fails
       * closed rather than authorizing an unstamped cap; `reason: 'unstamped'`
       * names the state. The fold is FAIL-LOUD: any `false` ⇒ `false`, else any
       * `null` ⇒ `null`. READ-ONLY — a mismatch blocks no order.
       *
       * ⚠️ The per-entry/aggregate UNIT confusion is the live trap here (a
       * "$750 total" authorization once shipped as $750 PER BOOK): the two
       * stamps are separate vars precisely so one cannot silently grade the
       * other.
       */
      capRatification,
      ratificationMatchesLive: foldRatificationVerdicts([
        capRatification.notionalCap.matchesLive,
        capRatification.aggregateCap.matchesLive,
      ]),
      /**
       * TRA-4505 (parent TRA-4206, off TRA-3829) — the engine-act-on-adopted-rows
       * master arm, finally on a plain GET. Until this key existed the only read
       * path was an authenticated POST to a real-money write route with a
       * fabricated id (409 = disarmed / 404 = armed), so the arm got cited from
       * recall instead of measured (TRA-3829 §0828).
       *
       * `armed` resolves through the SAME `isEngineActionOnAdoptedRowsArmed()`
       * the exit path and the hand-over route guard call, against the same env
       * every other live-arm read on this route uses — it must agree with the
       * 409/404 probe on the same build/pid. READ `rows` for ruling B's per-row
       * half: `null` ⇒ the fleet provider is unwired, never "no adopted rows",
       * and a non-zero `adoptedRowsAwaitingHandover` beside `armed: true` is the
       * ruled posture (two keys), not a defect.
       */
      engineActionOnAdoptedRows: summarizeEngineActionOnAdoptedRows(
        deps.adoptedHandoverRows?.() ?? null,
        liveEnv,
      ),
      // TRA-3674 — φ, the scalar that turns the fleet-absolute authorization
      // above into an enforceable PER-BOOK budget `B_i = min(φ·E_i, A)`. Same
      // publication contract as every knob on this route: the RESOLVED value
      // beside its default/ceiling/var name, because a compiled constant reads
      // identically on a box running a different φ. Read this WITH the per-book
      // `capUsd` in `aggregateExposure` — φ alone does not say what any book
      // was actually allowed, and `capUsd` alone cannot distinguish a small
      // budget caused by a small balance from one caused by a mis-set φ.
      fleetRiskFraction: resolveLiveOptionTestFleetRiskFraction(liveEnv),
      fleetRiskFractionDefault: LIVE_OPTION_TEST_FLEET_RISK_FRACTION,
      fleetRiskFractionCeiling: LIVE_OPTION_TEST_FLEET_RISK_FRACTION_CEILING,
      fleetRiskFractionVar: LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR,
      // TRA-3723 — the capital the COMPILED φ was fitted to, published because
      // the scheme's correctness depends on it and nothing enforced it. Compare
      // against `aggregateFleetBound.fleetCapitalUsd` below: once live fleet
      // capital passes this figure, `Σ B_i` passes the authorization.
      fleetCapitalBasisUsd: LIVE_OPTION_TEST_FLEET_CAPITAL_BASIS_USD,
      // ⭐ READ THIS, NOT THE CAP ALONE. A cap value reads IDENTICALLY at
      // headroom $600 and headroom $0, and those two states are the entire
      // point of the instrument. One row per engine, computed by the same fold
      // the order site enforces on. `null` ⇒ the provider is not wired (this
      // build serves the cap without a utilization read) — never `[]`, which
      // would claim "no books" against an unwired route.
      //
      // SCOPE IS PER BOOK (TRA-3445 item 3): each engine sizes against its own
      // Tradier balance and there is no fleet accumulator. TRA-3674 made each
      // row's `capUsd` `min(φ · availableCashUsd, fleetCapUsd)`.
      //
      // TRA-3879 — each row now also carries `fleetRiskFractionEffective`,
      // `fleetCapitalUsd`, `fleetCapitalBooks` and `fleetSizingReason`. There is
      // still no accumulator: `φ_eff = min(φ, A / Σ E_i)` is a READ of the other
      // books' balances, and `capUsd` here resolves through the SAME read the
      // order site sizes on, so this column cannot publish a budget the order
      // site would not honour. ⭐ Read `fleetSizingReason`, not the φ alone:
      // `fleet_capital_unreadable` is the one value under which `Σ B_i` is
      // unbounded again, and a budget resolved that way looks entirely normal.
      //
      // ⚠⚠ TRA-3723 — this note used to continue "so `Σ B_i ≤ φ · Σ E_i ≡ A` —
      // the fleet bound falls out of the arithmetic and no cross-engine state is
      // needed to hold it." THAT WAS FALSE and it is deleted rather than
      // softened, because a comment that tells the reader the bound is
      // structural retires the question. `min(…, A)` is a PER-BOOK clamp; it
      // cannot bound a sum. The fleet bound holds only while
      // `Σ E_i ≤ A/φ = $1,543.85` — the capital φ was FITTED to on the night it
      // shipped ($1,543.96), less the 11¢ that rounding φ up at the 4th place
      // costs — and the thing that violates it is a DEPOSIT, not an edit.
      // Grade it, do not assume it: `aggregateFleetBound` below.
      //
      // ⚠ The fleet figure is a sum over the `liveEntryGateOpen` rows and NOT
      // the `mode: 'live'` ones (bqb1 carries three of the latter, two of the
      // former) — and it is a sum of the rows' own `capUsd`, NEVER
      // `cap × books`. That multiplication assumes the cap binds; before
      // TRA-3674 it read $1,400 against a true worst case of $1,150, because
      // v0nni bound on its own $400 of cash and the cap never bit. Run the
      // admit loop, or sum this column.
      aggregateExposure: aggregateExposureRows,
      // TRA-3723 — the sum taken FOR the reader, and graded. `aggregateExposure`
      // above published every term needed to catch the fail-open and nobody
      // took the sum, which is the whole reason it shipped believed-safe. This
      // is a DETECTOR, not a bound: no order site consults THIS OBJECT, so a
      // `breach` means money is already authorized past the board's figure — it
      // does not mean anything stopped. `blind` ⇒ could not grade; never read it
      // as fine.
      //
      // ⭐ TRA-3879 — the order site now bounds the sum itself
      // (`φ_eff = min(φ, A / Σ E_i)`), so this SHOULD read `within`. It is kept,
      // and kept independent, for three states it still owns: the bound is only
      // as fresh as the last balance read; `fleetSizingReason:
      // 'fleet_capital_unreadable'` on the rows above means the fleet read was
      // unusable and the sum is unbounded again; and a future regression at the
      // order site is invisible to every test that trusts the order site. A fix
      // that also retired its own detector would have removed the evidence too.
      aggregateFleetBound: gradeLiveOtmFleetBound(
        aggregateExposureRows,
        aggregateCapLive, // the SAME resolved A the route publishes above
        resolveLiveOptionTestFleetRiskFraction(liveEnv),
      ),
      // TRA-3836 (parent TRA-3827) — the board's <=$100 attended-canary
      // ceiling, from the SAME exposure snapshot as the two graders above.
      // ⭐ The PRESENCE of this key is the deployed-bytes proof the control
      // shipped (assert with `hasOwnProperty`; a build without the module
      // lacks the key entirely). Read `verdict` and the per-book SIGNED
      // `signedResidualUsd` — negative = dollars OVER the ceiling. The floored
      // `headroomUsd` on `aggregateExposure` rows cannot express a breach
      // (Math.max(0, …) is why 08-17's 6.91x published as "within"); this
      // block exists so that state has a byte that differs.
      canaryCeiling: gradeCanaryCeilingHealth(aggregateExposureRows, liveEnv),
      /**
       * ⭐ TRA-3979 — THE SAME DOLLARS `aggregateFleetBound` COUNTS, SLICED BY
       * CONTRACT AND BY UNDERLYING INSTEAD OF BY BOOK.
       *
       * On 2026-08-24 both gate-open books bought `NVTS261002C00012500` 19
       * minutes apart — $305, 68.7% of the $444 fleet at-risk, in ONE strike on
       * ONE expiry — and every gate above passed, correctly. The bound cannot
       * tell that apart from $305 spread across three names, because it only
       * ever counts dollars. A DOLLAR CEILING IS NOT A RISK CEILING ONCE MORE
       * THAN ONE BOOK SHARES A SIGNAL GENERATOR.
       *
       * ⛔ ADVISORY — `entryPathBehavior: 'advisory_no_refusal'`, `refuses:
       * false`. NO ORDER SITE CONSULTS THIS OBJECT. A refusal here is a
       * board-facing change to a ratified arm and needs a ceiling the board
       * set; this is the measurement they set it against (back to TRA-3703).
       *
       * ⭐ The PRESENCE of this key is the deployed-bytes proof (assert with
       * `hasOwnProperty`; a build without the module lacks the key entirely).
       * Read `status` FIRST — `unwired` ≠ `empty` ≠ `measured`, and only the
       * last is a reading. Then `maxContract` / `multiBookContracts` (the
       * hazard: one OCC, more than one gate-open book) and `maxUnderlying` /
       * `multiBookUnderlyings` (two strikes on one name are the same hazard
       * wearing a different key). `concentrationIsLowerBound: true` ⇒ every
       * share below is soft in the PERMISSIVE direction.
       *
       * `fleetAtRiskUsd` here is folded from the same per-row primitive as
       * `openPremiumAtRiskUsd`, so it must equal
       * `aggregateFleetBound.fleetAtRiskUsd`. If it ever does not, one of the
       * two is reading a population the other is not — grade that, do not
       * average it.
       */
      fleetConcentration: gradeFleetConcentration(concentrationBooks),
      /**
       * ⭐ TRA-4144 (parent TRA-3703, axis 4) — the UNDERLYING ASSET CLASS of
       * every open live row, of the retained tape, and of every candidate the
       * entry site has evaluated since boot.
       *
       * On 2026-08-25 the OTM sleeve opened a $128 call on `ETHA` — a
       * spot-ether ETF — in the production `admin` book, against a ratified
       * "Options + Stock, crypto OFF" posture, and NOTHING BREACHED: every
       * crypto control is scoped on the crypto MODULE, and the exposure
       * arrived as an equity option on a wrapper. A CONTROL SCOPED ON A VENUE
       * IS BLIND TO THE SAME EXPOSURE ARRIVING THROUGH A WRAPPER.
       *
       * ⛔ Read `entryPathBehavior` FIRST — `advisory_no_refusal` is the
       * shipped default: the classifier runs at the entry site and REFUSES
       * NOTHING until the board answers TRA-3703 Q5 and someone arms
       * `ENABLE_OPTION_ENTRY_ASSET_CLASS_REFUSAL`. A row that cannot be
       * classified publishes `unknown`, NEVER `equity`
       * (`unknownNeverReadsAsEquity`), and any `unknown`/blind book makes the
       * census a LOWER bound (`censusIsLowerBound`) — say so when citing it.
       *
       * ⭐ The PRESENCE of this key is the deployed-bytes proof (AC5; assert
       * with `hasOwnProperty` against a pinned `build.pid` + `startedAt`).
       * The entry-site half also appears as gate `underlying_asset_class` on
       * /api/health/live-enforce-gates, which is the DURABLE twin of the
       * ephemeral since-boot census here.
       */
      underlyingAssetClass: gradeUnderlyingAssetClassHealth(
        concentrationBooks,
        liveOptionFillRecords(),
        liveEnv,
        // TRA-4343 — hand it the boot stamp so `entrySite.sessionCoverage` can
        // say whether the since-boot counters cover the session being graded.
        // Without this a post-close redeploy renders `evaluated: 0` and a
        // reader calls it a quiet day (2026-09-03, 21:11 ET restart).
        { bootedAt: resolveBuildInfo().startedAt, now: nowMs },
      ),
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
        // TRA-4288 — the directional sleeve was the one live arm consumed as a
        // raw flag with no OPTION_LIVE_TEST_UNTIL conjunct (it would never have
        // expired). Publish the same decision the order sites now consult —
        // the pure function, not a re-derived conjunct (TRA-3689 pattern).
        directionalFlagOn: isOptionLiveDirectionalEnabled(liveEnv),
        directionalArmed: isOptionLiveDirectionalArmed(liveEnv, nowMs),
      },
      // TRA-3401 — the board's one-shot cost-bar bypass (card `6b82a9e7`,
      // fa390549 scope). Published beside `arm` so the whole grant lifecycle —
      // armed/window/committed-per-book/refusal tallies — reads off deployed
      // state instead of logs. `armed:false` with the env unset is the shipped
      // default; `stateUnreadable:true` means every consult is refusing
      // (fail closed) and an operator must inspect the commit file.
      oneShotCostBarGrant: getLiveOtmOneShotGrantState(liveEnv, nowMs),
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
      // TRA-3997 — is the ADMISSION stamp on `buy_to_open` rows being exercised,
      // and does `admissibleBoundBy` discriminate (AC4)? Each `records[]` entry
      // carries `admission` / `admissionReason` verbatim; this is the fold.
      // ⭐ The PRESENCE of this key is the deployed-bytes proof the stamp
      // shipped (a build without it lacks the key). `stamped: 0` with
      // `rows > 0` after a live open on this build is a regression, not quiet.
      // `absent.unstamped` counts pre-cut rows — BLIND, never compliant (AC5).
      admissionStamp: summarizeLiveOptionAdmissionStamps(summary.records),
      // TRA-2810 — provenance of the AUTOMATIC fee back-fill (boot kick + hourly
      // tick). `ticks: 0` ⇒ the pass never ran on this boot — the one state the
      // TRA-1954 admin-POST era could not distinguish from healthy-quiescent.
      // TRA-2850 — `stalled: true` is the NON-GREEN state: repeated no-match with
      // nothing ever written; do not read `lastError: null` as health.
      autoReconcile: getLiveOptionsFeeReconcileState(),
      // TRA-3926 (AC5) — DID THE ENGINE SELL MORE THAN IT BOUGHT?
      //
      // It did, once, on real money: 2026-08-21T13:48:04Z, order 142806015,
      // `XLF260925C00057500` sold 2 having bought 1. Nothing alarmed. The only
      // trace was `autoReconcile.lastGainLossRejections` carrying a `no-lot`
      // entry, which reads as a data-freshness complaint about the P&L
      // reconciler rather than as the engine disposing of the desk's contract.
      //
      // ⭐ The PRESENCE of this key is the deployed-bytes proof the detector
      // shipped (assert with `hasOwnProperty`; a build without the module lacks
      // the key entirely). Read `status` FIRST and read all three values:
      //   • `oversold` — findings[]. THE ALARM. Each names its OCC, order id and
      //     `excessContracts`, and `importedOpenContracts` says where the excess
      //     came from.
      //   • `clean`    — judged at least one engine close and every one was
      //     covered by our own opens.
      //   • `vacuous`  — NOTHING was judgeable (`judgedCloses: 0`). NOT a pass.
      //     A detector whose denominator is empty has proved nothing, and on a
      //     30-day-retention ledger this is what an old event decays into.
      // `blindCloses` is the third value kept out of both verdicts: a close
      // whose opens aged out looks identical to a close of contracts we never
      // bought, and folding it either way would be a guess.
      //
      // Counts + OCC symbols only — no user identifiers (TRA-2163); the symbols
      // are already published on `records[]` immediately below.
      oversoldCloses: oversoldCloseCensus,
      // TRA-3926 (2026-09-04) — the DURABLE CARRIER for the judgements above.
      // `oversoldCloses` is re-derived from a 30-day tape on every read, so its
      // findings evaporate with their evidence (the fired 2026-08-21 XLF event
      // ages out ~2026-09-19; QQQ already did on 2026-09-03). Every finding and
      // granted close served here is captured, idempotently, into an append-only
      // store the archive tick / restart / retention horizon cannot reach.
      //
      // Read `rows[].onLiveTape`: `true` = the live census still corroborates
      // this judgement; `false` = the evidence has aged out and this block is
      // the ONLY remaining testimony — preserved judgement, not a live
      // re-derivation. `attempts > 1` means the judgement CHANGED (RIG
      // 143384264 went finding → granted when the anchor partition landed).
      // `capture.appendErrors > 0` or `ephemeral: true` means the carrier is
      // NOT doing its job — read those before trusting a quiet tape.
      judgedOversoldDurable: {
        ...summarizeJudgedOversoldCloses(oversoldCloseCensus),
        capture: judgedOversoldCapture,
      },
      // TRA-3932 — WHO OPENED the contracts `oversoldCloses` could not attribute.
      //
      // This is the DURABLE STORE, not a re-derivation: it reports what the
      // resolver concluded when it was last run against the broker's order list,
      // because that evidence expires (see `tra3932-open-leg-provenance.ts`). A
      // subject with `terminal: true` is ANSWERED and will never be re-graded; a
      // subject sitting on a blind carries `attempts` + `detail` naming exactly
      // which limb refused, so a permanent blind reads as a measured finding
      // rather than as work nobody did.
      //
      // `subjects: 0` means the resolver has never been run on this box — NOT
      // that there is nothing to answer for. Read `oversoldCloses.blindCloses`
      // above for the population. The resolver is triggered explicitly at
      // POST /api/health/live-options-fee-slippage/open-leg-provenance (admin);
      // it is not on a tick, because it reaches the broker and the subject set
      // is a fixed historical population, not a stream.
      openLegProvenance: summarizeStoredProvenance(),
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
  //  5. TRA-4578 — `cells[].provenance` BEFORE you trust step 4. `lowerCI95` is
  //     byte-identical whether the cell is desk real-money closes or demo rows
  //     booked at mid, and demo rows cannot pay the cost the bar prices
  //     (`demoSlippagePct: 0`; demo realized R is gross of spread). Read
  //     `provenance.byMode` / `.byAccountClass` — `unattributed` is NOT desk, it
  //     is a row written before TRA-1475 added `account` — and
  //     `provenance.fromTs`/`toTs`, which separate populations a single cell can
  //     span. Then read `cells[].lowerCI95_netOfModelledCross` and
  //     `netOfModelledCross.wouldAdmit`: the same cell with its own measured
  //     round-trip cost charged to its demo rows. Those are COMPANIONS — `admits`
  //     is still decided by `lowerCI95` alone and TRA-4578 changed no verdict. A
  //     null companion means no measured cost for that cell, NOT a zero cost;
  //     `netOfModelledCross.unavailableReason` says which case.
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

    // ── TRA-4416 — THE LIVE ADMITTED |Δ| BAND ──────────────────────────────
    //
    // ⛔ EVERY TERM HERE IS A LIVE READ OFF `liveEnv`. Not a compiled default,
    // not `OTM_CONTRACT_FLOOR_DEFAULTS`, not `OTM_ADMISSIBLE_DELTA_*_DEFAULT`.
    // Both bands are env-overridable and BOTH ARE OVERRIDDEN ON bqb1 (the floor
    // read `source: 'env'` on 2026-09-22), so a compiled read here would publish
    // a coherence verdict about a box that does not exist — the identical
    // mistake the `setupTaxonomy` block below was written to stop.
    //
    // The admitted set is the INTERSECTION of the two live filters, and their
    // top edges have DIFFERENT strictness (floor `<=`, selector `<`), so the
    // intersection is computed with the edge carried rather than assumed.
    //
    // The selector only constrains when it is ARMED: unarmed, the floor alone
    // decides, and saying otherwise would publish a narrower admitted band than
    // the box actually has — an error in the dangerous direction.
    const liveAdmitted = (() => {
      try {
        const floor = resolveOtmContractFloor(liveEnv);
        const floorBand = deltaInterval(floor.deltaMin, floor.deltaMax, true);
        const selectorArmed = isOtmAdmissibleStrikeEnabled(liveEnv);
        const sel = resolveAdmissibleBand(liveEnv);
        const selectorBand = deltaInterval(sel.min, sel.max, false);
        const band = selectorArmed ? intersectDeltaIntervals(floorBand, selectorBand) : floorBand;
        return {
          band,
          floorBand,
          selectorBand,
          selectorArmed,
          floorSource: floor.source,
          floorInvalidKeys: floor.invalidKeys,
        };
      } catch {
        // ⛔ Blind ⇒ `null`, which every consumer below renders as `unmeasured`.
        // NEVER a default band: a guess here is a false coherence verdict.
        return null;
      }
    })();
    const admittedBand = liveAdmitted?.band ?? null;
    const containment = assessMandateBandContainment(structure, admittedBand);
    const coverage = entryDeltaCeilingCoverage(ceiling, admittedBand);
    const cohortDisjointness = assessMandateCohortDisjointness(structure);

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
          note: 'Half-open [from, to). BOUNDED ON BOTH SIDES — that is the point of the ticket. '
            + '⛔ TRA-4416: this is the RATIFIED band, NOT what the sleeve admits. Read '
            + '`bandCoherence` before treating it as a description of the live box.',
        },
      },
      /**
       * ⛔⛔ TRA-4416 — THE RATIFIED BAND AND THE LIVE BAND DISAGREE, AND UNTIL
       * THIS BLOCK EXISTED NOTHING SAID SO.
       *
       * Board card `439c4e46` answered `widen_live_anyway` on 2026-09-09,
       * directing the live selector at |Δ| ∈ [0.25, 0.40] — a band the table
       * above classes `insufficient_evidence` (n=216). That decision is
       * ACCEPTED and is not re-litigated here. What was broken is that
       * `sleeve.authorizedBand` said [0.495, 0.55) while the box traded
       * [0.25, 0.40] and no field anywhere carried the contradiction, so
       * every reader of this route inherited the wrong band silently.
       *
       * READ ORDER: `status` → `liveBandWithinAuthorized` → `boardOverrides`.
       *
       * ⛔ `liveBandWithinAuthorized` IS THREE-VALUED. `null` means the live
       * band could not be read and is NOT a pass — `?? true` and `!== false`
       * on this field are both bugs. `status: 'empty'` is its own state: an
       * empty admitted set is vacuously a subset of anything, and folding it
       * into `within` is how a non-intersecting band pair reads as healthy.
       *
       * ⛔ `status: 'outside'` WITH a board override present is the EXPECTED,
       * ACCOUNTED-FOR state — it is the disagreement being reported, not an
       * incident. `outside` with `boardOverrides: []` is the incident.
       */
      bandCoherence: {
        issue: 'TRA-4416',
        authorization: 'board card `439c4e46` (`widen_live_anyway`, 2026-09-09) on TRA-3392',
        status: containment.status,
        liveBandWithinAuthorized: containment.liveBandWithinAuthorized,
        admittedBand: containment.admittedBand,
        authorizedBand: containment.authorizedBand,
        admittedBandAuthorizations: containment.admittedBandAuthorizations,
        /** AC1(b) — the override ON RECORD, machine-readable, naming its card. */
        boardOverrides: mandateBoardOverridesFor(structure),
        /**
         * How the admitted band was derived, so the verdict is checkable rather
         * than merely stated. ⛔ The two top edges differ in strictness — floor
         * `|Δ| <= deltaMax` (`otm-contract-floor.ts:294`), selector
         * `|Δ| < max` (`otm-admissible-strike.ts:306`) — so a contract at
         * exactly the shared top edge is admitted by one and refused by the
         * other, and `upperInclusive` is what records which one won.
         */
        derivation: {
          floorBand: liveAdmitted?.floorBand ?? null,
          selectorBand: liveAdmitted?.selectorBand ?? null,
          selectorArmed: liveAdmitted?.selectorArmed ?? null,
          floorSource: liveAdmitted?.floorSource ?? null,
          floorInvalidKeys: liveAdmitted?.floorInvalidKeys ?? null,
          envVars: {
            floorMin: OTM_CONTRACT_FLOOR_DELTA_MIN_VAR,
            floorMax: OTM_CONTRACT_FLOOR_DELTA_MAX_VAR,
            selectorMin: OTM_ADMISSIBLE_DELTA_MIN_VAR,
            selectorMax: OTM_ADMISSIBLE_DELTA_MAX_VAR,
            selectorFlag: OTM_ADMISSIBLE_STRIKE_FLAG,
          },
          note:
            'LIVE READ off this process\'s env — never the compiled defaults '
            + '(OTM_CONTRACT_FLOOR_DEFAULTS / OTM_ADMISSIBLE_DELTA_*_DEFAULT). Both bands are '
            + 'env-overridable and both ARE overridden on bqb1, so a compiled read here would '
            + 'describe a box that does not exist. `selectorArmed: false` means the floor alone '
            + 'decides and the selector band is echoed for reference only.',
        },
        /**
         * AC4 — TRA-4053's reopening cohort vs the new live population.
         * ⛔ READ `bandsOverlap` BEFORE `disjointFromLivePopulation`: the bands
         * DO overlap ([0.25,0.40] sits inside [0.20,0.45)), so band alone does
         * NOT separate them and a cohort query keyed on the band would pool
         * real-money fills into a demo-only acceptance test. They are disjoint
         * only because membership requires `mode === 'demo'`.
         */
        reopeningCohort: cohortDisjointness,
        reason: containment.reason,
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
        /**
         * ⛔⛔ TRA-4416 AC3 — READ THIS BEFORE `mode`. AN ARMED CEILING IS NOT
         * NECESSARILY A CEILING THAT CAN BITE.
         *
         * This gate's only reason code is `above_mandate_ceiling` and it fires
         * on `|Δ| >= inForce`. When the whole admitted band lies below
         * `inForce`, NO admissible contract can reach it: the gate is armed
         * over a population it is structurally incapable of refusing, and its
         * `evaluated > 0, blocked = 0` read — which this route's own note calls
         * "the expected healthy read" — is byte-identical to the read a gate
         * genuinely guarding a quiet tail produces. A counter cannot tell them
         * apart, because the counter is the part that looks healthy. Only this
         * structural comparison can.
         *
         * ⛔ `coversAdmittedBand` IS THREE-VALUED. `false` = armed and blind.
         * `null` = the admitted band was unreadable, which is NOT coverage.
         * ⛔ `armedButBlind: true` means `mode: 'enforce'` MUST NOT be read as
         * protection. That was the live state on bqb1 `08f78eb46caa`
         * (2026-09-22T22:30Z): enforce at 0.55 over an admitted band of
         * [0.25, 0.40) — 100% blind, and every surface read green.
         */
        coverage,
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
       * TRA-4422 (parent TRA-4421) — THE SETUP-TAXONOMY INSTRUMENT.
       *
       * ⛔ EVERY FIELD HERE IS A LIVE READ. `setupTaxonomyHealth` is handed
       * `liveEnv`, never a compiled constant, because this desk has shipped a
       * false green off a compiled default twice in the week before this
       * landed (`otm-contract-floor.ts`'s band, and the swing time stop that
       * compiles to 4 and runs at 10). `modeSource` says WHERE the live value
       * came from, and `env_invalid` is its own value — an unparseable flag
       * resolves to `observe` (the safe direction) but must never read back as
       * though nobody set it. UNKNOWN IS NOT OFF.
       */
      setupTaxonomy: (() => {
        const health = setupTaxonomyHealth(liveEnv);
        const today = gateToday(SETUP_CONFIRMATION_GATE);
        const retained = gateRetained(SETUP_CONFIRMATION_GATE);
        // ⛔ DENSE OVER THE VOCABULARY, and an ARRAY. Two separate traps:
        //  - Absent is not zero. The ledger's `byReason` only carries codes
        //    that actually blocked, so a missing row would render as "no data"
        //    when it means "this reason never fired". Every code gets a row.
        //  - `.find(x => x.code === ...)`, never an index. The sibling
        //    `retained.byGate` is an array and indexing it yields `undefined`,
        //    which renders as accrual death (the TRA-4154 trap).
        const denseByReasonCode = (rows: readonly { reasonCode: string; blocked: number; share: number | null }[] | undefined) =>
          SETUP_TAXONOMY_REASON_CODES.map((code) => {
            const hit = rows?.find((r) => r.reasonCode === code) ?? null;
            return { code, blocked: hit?.blocked ?? 0, share: hit?.share ?? null };
          });
        const evaluated = retained?.evaluated ?? 0;
        const blocked = retained?.blocked ?? 0;
        // TRA-4422 Finding 2 — THE CROSS-CHECK, PUBLISHED WITH ITS PRECONDITION.
        //
        // See `SETUP_CONFIRMATION_SIBLING_GATE`'s doc block for the measurement.
        // Short form: both folds are ET-DAY scoped and both are hydrated from
        // disk at boot, so across a deploy the OLD build's `entry_window` rows
        // sit beside the NEW build's zero `setup_confirmation` and the equality
        // is violated by BOOKKEEPING, not by a broken recorder. `comparable` is
        // the discriminator and it is a MEASUREMENT, not an assumption: the
        // ledger's own `lastDecisionAt` must fall at or after this process
        // started. Until it does, NOTHING has been recorded by anything, the
        // comparison has no subject, and the note below must not accuse.
        //
        // ⛔ `comparable: false` is not a pass either — but it is NOT an alarm on
        // its own, and the FIRST out-of-hours read proved that (Finding 3, see
        // `scanWindowOpenMsSince`). The scan is gated on `isStockMarketOpen()`,
        // so outside 09:30-16:00 ET `comparable` cannot become true however long
        // the box is up. The escalation term is therefore `scanWindow.expectRows`
        // — IN-WINDOW time since boot — never wall-clock `sinceProcessStartMs`,
        // which is published only as the raw reading behind it.
        const setupBuild = resolveBuildInfo();
        const processStartMs = Date.parse(setupBuild.startedAt);
        const siblingToday = gateToday(SETUP_CONFIRMATION_SIBLING_GATE);
        const comparable = Number.isFinite(processStartMs)
          && typeof summary.lastDecisionAt === 'number'
          && summary.lastDecisionAt >= processStartMs;
        const scanWindow = scanWindowOpenMsSince(processStartMs, nowMs);
        const crossCheck = {
          sibling: SETUP_CONFIRMATION_SIBLING_GATE,
          /** Both are the `today` (ET-day) folds — the same scope, or the comparison is meaningless. */
          siblingEvaluatedToday: siblingToday?.evaluated ?? 0,
          selfEvaluatedToday: today?.evaluated ?? 0,
          /** MEASURED: has THIS process written a single ledger row yet? */
          comparable,
          ledgerLastDecisionAt: typeof summary.lastDecisionAt === 'number'
            ? new Date(summary.lastDecisionAt).toISOString()
            : null,
          processStartedAt: setupBuild.startedAt,
          sinceProcessStartMs: Number.isFinite(processStartMs) ? Math.max(0, nowMs - processStartMs) : null,
          /**
           * TRA-4422 Finding 3 — the OPPORTUNITY the ledger has actually had.
           * `marketOpenNow` is the scan's own gating predicate; `openMsSinceStart`
           * integrates it from boot to now; `expectRows` is the only term that
           * may be read as escalation. ⛔ `expectRows: false` beside
           * `comparable: false` is NOT RUN (out of window), not a quiet box.
           */
          scanWindow: {
            marketOpenNow: scanWindow.marketOpenNow,
            openMsSinceStart: scanWindow.openMsSinceStart,
            openMsTruncated: scanWindow.truncated,
            expectRows: scanWindow.expectRows,
            thresholdMs: SETUP_CONFIRMATION_EXPECT_ROWS_AFTER_OPEN_MS,
            gatedOn: 'shouldRunOtmScan({ marketOpen: isStockMarketOpen() }) — signal-engine.ts',
          },
          /** Only meaningful when `comparable`; `null` says so rather than forging a verdict. */
          holds: comparable ? (today?.evaluated ?? 0) === (siblingToday?.evaluated ?? 0) : null,
          /**
           * ⛔ THE ESCALATION FLAG, and the only field here that should page.
           * True ONLY when the box has had real in-window time and still wrote
           * nothing — that is a sleeve that is not scanning during the session.
           */
          notScanning: !comparable && scanWindow.expectRows,
          reason: comparable
            ? 'this process has written ledger rows, so the ET-day folds are its own and the equality binds'
            : scanWindow.expectRows
              ? 'NOT COMPARABLE AND OVERDUE — this process has had '
                + `${Math.round(scanWindow.openMsSinceStart / 60_000)} minutes of market-open time since boot `
                + 'and has still written no ledger row. The out-of-window explanation does NOT apply. '
                + 'Treat as a sleeve that is not scanning during the session and investigate '
                + '`shouldRunOtmScan`\'s other terms (autoTradingEnabled, halted, hasScanner, '
                + 'skipOptionsForLiveEquityOnly).'
              : 'NOT RUN (out of window) — the ledger has recorded nothing since this process started, so '
                + 'every row in both `today` folds was hydrated from disk and written by a PREVIOUS build. '
                + 'A non-zero sibling beside a zero here proves NOTHING about the recorder (measured '
                + '2026-09-09, the 21:08:11Z swap onto 8e51be03). The scan is gated on isStockMarketOpen(), '
                + `and only ${Math.round(scanWindow.openMsSinceStart / 60_000)} minutes of market-open time `
                + 'have elapsed since boot, so this zero is STRUCTURALLY GUARANTEED and carries no '
                + 'information either way. Re-read inside 09:30-16:00 ET.',
        };
        // ⛔ `evaluated: 0` IS `unmeasured`, NEVER `pass`. A gate that never ran
        // is not a gate that never bit, and the two are what this whole item
        // exists to keep apart. `observing` is likewise distinct from any pass
        // state: in observe the gate CANNOT block, so `blocked: 0` there is a
        // property of the mode and carries no information about the taxonomy.
        const status = evaluated === 0
          ? 'unmeasured'
          : health.mode === 'observe'
            ? 'observing'
            : blocked > 0 ? 'enforcing_biting' : 'enforcing_never_bit';
        return {
          issue: 'TRA-4422',
          authorization: 'TRA-4421 §10 item 0; board comment adaebaa2 on TRA-4412 (2026-09-09)',
          gate: SETUP_CONFIRMATION_GATE,
          /** The LIVE mode, and where it came from. */
          mode: health.mode,
          modeSource: health.modeSource,
          modeRaw: health.modeRaw,
          source: `${OTM_SETUP_TAXONOMY_MODE_ENV} on this process (live read, not the compiled default `
            + `'${OTM_SETUP_TAXONOMY_MODE_DEFAULT}')`,
          flags: {
            mode: OTM_SETUP_TAXONOMY_MODE_ENV,
            setups: OTM_SETUP_TAXONOMY_SETUPS_ENV,
          },
          /** Armed setups. EMPTY is the shipped day-1 state, not a fault. */
          setupsEnabled: health.setupsEnabled,
          /** Names in the enable list matching no registered setup — reported, never dropped. */
          setupsUnknown: health.setupsUnknown,
          /** Every setup compiled into THIS build. The deployed-bytes read. */
          setupsRegistered: health.setupsRegistered,
          reasonCodeVocabulary: SETUP_TAXONOMY_REASON_CODES,
          status,
          evaluated,
          blocked,
          blockRate: retained?.blockRate ?? null,
          byReasonCode: denseByReasonCode(retained?.byReason),
          /** Blocks carrying no reason code — `byReasonCode`'s missing denominator. */
          blockedUnclassified: retained?.blockedUnclassified ?? 0,
          today: {
            evaluated: today?.evaluated ?? 0,
            blocked: today?.blocked ?? 0,
            blockRate: today?.blockRate ?? null,
            byReasonCode: denseByReasonCode(today?.byReason),
            blockedUnclassified: today?.blockedUnclassified ?? 0,
          },
          /**
           * TRA-4423 — the observe-mode counterfactual, on a DURABLE surface.
           * `byReasonCode` above folds BLOCKS, which in observe is zero by
           * construction — so without this block the route reads identically
           * whether the enabled setups would refuse every open or none of
           * them, and the enforce proposal (card `70e36987`) has nothing to be
           * argued from except rotating logs.
           */
          observeCounterfactual: (() => {
            const cf = readOtmSetupGateCounterfactual();
            return {
              issue: 'TRA-4423',
              scope: 'live book only, since boot — in-memory, NOT hydrated across deploys '
                + '(unlike the ET-day folds above), so a fresh boot legitimately reads zero '
                + 'here beside a non-zero hydrated `today`',
              since: new Date(cf.since).toISOString(),
              evaluated: cf.evaluated,
              confirmed: cf.confirmed,
              wouldBlock: cf.wouldBlock,
              /** null (never 0) at evaluated 0 — 0/0 is not a rate. */
              wouldBlockRate: cf.evaluated > 0 ? cf.wouldBlock / cf.evaluated : null,
              /** Dense over the vocabulary: a 0 is a real "never occurred since boot". */
              wouldBlockByReasonCode: cf.wouldBlockByReasonCode,
              /** Which setup admitted / conflicted. Dense over the registry. */
              confirmedBySetup: cf.confirmedBySetup,
              conflictBySetup: cf.conflictBySetup,
              note: cf.evaluated === 0
                ? 'UNMEASURED — zero verdicts folded since this process booted. NOT a pass and '
                  + 'NOT a quiet market; read `crossCheck.scanWindow` above for whether the box '
                  + 'has had in-window time to record at all.'
                : 'What an ENFORCING gate would have refused, folded by reason code over the '
                  + 'live book since `since`. `wouldBlockRate` near 1.0 with `setupsEnabled` '
                  + 'non-empty means the enabled setups would refuse nearly every open this '
                  + 'sleeve places; near 0.0 means they change little. ⛔ Grade the enforce '
                  + 'flip on the ADMIT-SET COUNTERFACTUAL (what did the trades E would have '
                  + 'blocked go on to do), never on a standalone breakout backtest — TRA-816 '
                  + 'already answered that different question No.',
            };
          })(),
          crossCheck,
          note:
            status === 'unmeasured'
              ? 'UNMEASURED — the gate recorded NOTHING. This is NOT a pass. Either the seam is not '
                + 'deployed on this build (`setupsRegistered` above is the deployed-bytes read; check '
                + '`build` against the commit that shipped `otm-setup-gate.ts`), or no OTM nominee '
                + 'reached it. The seam is ordered immediately ABOVE `entry_window` and below the '
                + 'nominator, so over one process\'s own rows `setup_confirmation.evaluated` must EQUAL '
                + '`entry_window.evaluated`. ⛔ READ `crossCheck.comparable` BEFORE APPLYING THAT: both '
                + 'counters are ET-day folds hydrated from disk at boot, so across a deploy the previous '
                + 'build\'s sibling rows sit beside this build\'s zero and the equality fails for '
                + 'bookkeeping reasons. '
                + (crossCheck.comparable
                  ? (crossCheck.holds
                    ? 'comparable=true and the equality HOLDS — this zero is the sleeve\'s own.'
                    : 'comparable=true and the equality is VIOLATED — the recorder is broken, not the '
                      + 'sleeve idle. This is the alarm.')
                  : crossCheck.notScanning
                    ? 'comparable=false, and ⛔ `crossCheck.notScanning` is TRUE — the box has had '
                      + `${Math.round(crossCheck.scanWindow.openMsSinceStart / 60_000)} minutes of `
                      + 'market-open time since boot and wrote no ledger row at all. This is the alarm: '
                      + 'the sleeve is not scanning during the session.'
                    : 'comparable=false and `crossCheck.scanWindow.expectRows` is FALSE — the OTM scan is '
                      + 'gated on isStockMarketOpen() and has had '
                      + `${Math.round(crossCheck.scanWindow.openMsSinceStart / 60_000)} minutes of `
                      + 'market-open time since boot, so this zero is NOT RUN (out of window). It is '
                      + 'structurally guaranteed, it is not an alarm, and it is not a pass. Re-read '
                      + 'inside 09:30-16:00 ET.')
              : health.mode === 'observe'
                ? 'OBSERVE — the gate scores every nominee and REFUSES NOTHING, so `blocked: 0` here is a '
                  + 'property of the mode and says nothing about the taxonomy. The counterfactual '
                  + '("what would this have refused") is `observeCounterfactual` above (TRA-4423), '
                  + 'with the per-verdict `TRA-4422, observe-safe` log line beside it. ⛔ READ `setupsRegistered` BEFORE '
                  + '`no_setup_matched`: an EMPTY list means nothing was ever scored, so every row is '
                  + 'UNMEASURED at `setupsScored: 0` and NOT "the taxonomy looked and found nothing". '
                  + 'Since TRA-4423 A-E are implemented, so a NON-EMPTY list makes `no_setup_matched` a '
                  + 'REAL negative — but only for the ids actually listed: landing a setup does not arm '
                  + 'it, `OTM_SETUP_TAXONOMY_SETUPS` does, and an absent env list still enables nothing. '
                  + 'The enforce flip is a separate board act (card `70e36987`) and '
                  + 'must relocate the refusal BELOW `entry_window` first.'
                : 'ENFORCE — the gate is refusing. ⚠️ In this position (above `entry_window`) an '
                  + 'enforcing gate SHRINKS that sibling\'s `evaluated`; the relocation owed at the '
                  + 'enforce flip has not happened if you are reading this.',
        };
      })(),
      /**
       * TRA-4639 (parent TRA-4413 item A) — the underlying-confirmation SHADOW.
       * The two TRA-1028 archetypes (EMA pullback, volume-confirmed breakout)
       * scored on the SAME nominee population as `setupTaxonomy` above — the
       * call site is inside the same seam, so `books.live.evaluated` tracks
       * `setup_confirmation.evaluated` call-for-call over this process's own
       * rows (⚠️ these counters are SINCE-BOOT and the ledger is disk-hydrated;
       * compare only when `crossCheck.comparable` above is true). Observe-only:
       * refuses nothing in any mode. Flag default OFF.
       */
      underlyingConfirm: otmUnderlyingConfirmHealth(liveEnv),
      /**
       * TRA-4720 (parent TRA-4413 item 5) — relative strength vs SPY / QQQ /
       * sector ETF, SHADOW. Per-leg reason-code histograms on the nominee seam
       * (`nomination`, per book) and on the demo swing pass (`scanner`, with
       * `supplied` vs `withheld`). Measures and publishes; gates nothing.
       * Flag default OFF. ⚠️ SINCE-BOOT.
       */
      relativeStrength: otmRelativeStrengthHealth(liveEnv),
      /**
       * TRA-4642 (parent TRA-4413 item 1) — the news-catalyst
       * EARNINGS_IV_CRUSH_RISK demoter, CONSULTED (not re-implemented) on the
       * OTM CHAIN population — beside the contract floor, BEFORE the selector
       * ranks. `books.*.evaluated` tracks the contract-floor chain-survey
       * population call-for-call by construction (⚠️ SINCE-BOOT; the census
       * cross-check identity is in the module header). Observe-only: refuses
       * nothing in any mode; no enforce arm exists in the module. Flag
       * default OFF. `ivcrush_calendar_unreadable` is the earnings FEED's
       * defect and is never pooled with `ivcrush_no_earnings_scheduled` —
       * the `calendar` sub-block here says which world produced a spike.
       */
      ivCrushDemoter: otmIvCrushDemoterHealth(earningsStoreStatusSync(), liveEnv),
      /**
       * TRA-4424 (parent TRA-4421, off TRA-4422 Finding 1) — THE DAILY-BAR
       * SOURCE feeding the seam above.
       *
       * ⛔ WHY THIS BLOCK EXISTS AT ALL. A daily fetch that starts failing
       * degrades into "every nominee scores `series_unreadable`" — and on every
       * other number this sleeve publishes that is INDISTINGUISHABLE from a
       * quiet market. `counters.fetchFailed` / `consecutiveFetchFailures` are
       * the discriminator, and `status: 'unmeasured'` is its own value because
       * an all-zero counter record is what a box that never ran the refresh
       * produces, byte-for-byte identical to one where it ran and nothing
       * failed.
       *
       * ⛔ `verdicts.spanMsMin` IS THE ACCEPTANCE CRITERION OF TRA-4424, and it
       * is the span the TAXONOMY computed, not one this route re-derived: 60
       * five-minute bars and 60 daily bars are the same bar COUNT and a
       * different question, so "the seam reads daily bars now" is only
       * checkable as a measured span.
       *
       * ⛔⛔ GRADE IT AGAINST `verdicts.minThesisSpanMs` (30 days), NEVER
       * AGAINST ONE DAY. The series this ticket replaced is ~480 five-minute
       * bars spanning ~8.6 CALENDAR days — a "multi-day" test passes on the
       * broken build. `verdicts.allReadableSpansSwingHorizon` is the boolean
       * that discriminates, and it is `null` (never `false`) when no row in the
       * window was readable, because a cold cache is the refresh's defect and a
       * short span is the seam's.
       */
      dailySeries: (() => {
        const health = otmDailySeriesHealth(nowMs);
        return {
          issue: 'TRA-4424',
          authorization: 'TRA-4421 §10; blocks TRA-4423 (setup E)',
          status: health.status,
          /** ⚠️ SINCE-BOOT. A restart zeroes every total here — see `counters.since`. */
          counters: health.counters,
          config: health.config,
          verdicts: health.verdicts,
          note: health.note,
        };
      })(),
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
          : coverage.coversAdmittedBand === false
            ? `⛔ CEILING ${ceiling.mode.toUpperCase()} AND STRUCTURALLY BLIND (TRA-4416 AC3). `
              + `${coverage.reason} `
              + 'DO NOT READ THE COUNTERS BELOW AS EVIDENCE OF ANYTHING: `blocked: 0` on this gate is '
              + 'forced by the band arithmetic, not measured against the tape, and it is byte-identical '
              + 'to the number a gate that is genuinely guarding a quiet tail produces. The containment '
              + 'that matters for the admitted population is upstream — `contract_floor` and `cost_bar` '
              + 'on /api/health/live-enforce-gates — not this flag. Read `bandCoherence` for why the '
              + 'admitted band sits where it does (board card `439c4e46`).'
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
      // TRA-4378 — the bounded exploration allowance for `directional`
      // (board-approved carve-out, TRA-4053). Resolved off the SAME demo-flag
      // env the gate itself consults, so the arm bit here is the arm bit the
      // trade pass reads. Counters are `null` (never 0) when the durable state
      // is unreadable — absent ⇒ UNREAD.
      explorationAllowance: summarizeExplorationAllowance(env, etDay),
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
    // TRA-3694 — the AUTHORIZATION of that resolved universe. Computed here so it
    // can enter the `note` sentence as well as `arm.universe.ratification`: the
    // prose is what a reader who is not looking for this field still sees, and
    // "ENFORCING (live): universe=RESTRICTED to [...]" reads identically whether
    // that list was ratified or not, which is the whole defect.
    const universeRatification = resolveLiveOtmUniverseRatification(universe, liveEnv);
    const universeRatificationClause =
      universeRatification.matchesLive === true
        ? 'RATIFIED'
        : universeRatification.matchesLive === null
          ? `RATIFICATION UNSTAMPED (${universeRatification.var} unset — UNKNOWN, not OK)`
          : `⚠️ RATIFICATION MISMATCH${universeRatification.onlyLive.length > 0 ? ` — UNRATIFIED WIDENING onto [${universeRatification.onlyLive.join(',')}]` : ''}`;
    // TRA-3216 — the bar's COMPOSITION, published once. It is identical on every
    // blocked row, so it cannot live in the per-decision `byReason` fold; without
    // it, `byReason`'s shortfall buckets have no scale to be read against.
    const costConfig = resolveCostGateConfig(liveEnv);
    const otmBar = describeCostGateBar(COST_BAR_PUBLISHED_STRUCTURE, costConfig);
    // TRA-4258 — the AUTHORIZATION behind that bar, which every field on `bar` is
    // silent about. Graded on the RESOLVED `safetyMarginR` (what the live order
    // site actually adds), never on the raw env string: a malformed
    // OPTION_COST_GATE_SAFETY_MARGIN_R falls back to the shipped default, and
    // grading the raw would compare the stamp against a value nothing obeys.
    // Tolerance is 1e-9 because the stamp arrives as a decimal STRING and the
    // live side as a config float — see `resolveNumericRatification`.
    const costBarRatification = resolveNumericRatification(
      OPTION_COST_GATE_SAFETY_MARGIN_R_RATIFIED_VAR,
      OPTION_COST_GATE_SAFETY_MARGIN_R_RATIFIED_BY_VAR,
      'single_leg_otm cost-gate safety margin (R)',
      otmBar.safetyMarginR,
      liveEnv,
      // `floor`, NOT the default `cap`: the margin is a MINIMUM added to the
      // cost model, so a live value BELOW the ratified one is the LOOSER,
      // real-money direction — the exact inverse of the notional caps.
      { toleranceAbs: 1e-9, polarity: 'floor' },
    );
    const costBarRatificationClause =
      costBarRatification.matchesLive === true
        ? `ratified (${costBarRatification.ratifiedBy ?? 'no provenance recorded'})`
        : costBarRatification.matchesLive === null
          ? `RATIFICATION UNSTAMPED (${costBarRatification.var} unset — UNKNOWN, not OK)`
          : `⚠️ RATIFICATION ${costBarRatification.reason === 'unparseable' ? 'STAMP UNPARSEABLE' : `MISMATCH — live margin ${otmBar.safetyMarginR} vs ratified ${costBarRatification.ratifiedValue}`}`;
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
      // TRA-4745 (follow-up) — the flat bar as resolved from the SAME `liveEnv`
      // the order site reads, handed in purely so `barRImplied` can grade itself
      // against it. The whole point of that field is to establish whether this
      // number is the one the recorded rows actually faced, so it is the SUBJECT
      // of the grade and never an input to the recovery.
      flatFormBarR: otmBar.barR,
    });
    // ── TRA-4749 (parent TRA-4622 §4) — EVERY bar and EVERY edge cell ─────────
    // `bar` and `edge.otmCells` above are both scoped to `single_leg_otm` by a
    // literal, and nothing said so. The retained ledger simultaneously recorded
    // `single_leg_rv` at 633 evaluated / 633 blocked against a bar published
    // nowhere, so a reader could not tell a legitimate refusal (the RV cell's
    // edge bound is NEGATIVE) from an OTM-shaped cost charged to a cheaper
    // sleeve. Both surfaces below are derived from LIVE RECORDED STATE — the
    // ledger's own scopes and the fold's own cells — because a hard-coded sleeve
    // roster is exactly what hid RV in the first place.
    //
    // ⛔ ADDITIVE. `bar` and `edge.otmCells` are untouched and byte-identical:
    // TRA-4622's reader, the TRA-4258 ratification grade and every saved probe
    // still read what they read before.
    const tapeCells = tapeExpectancyCache().peek()?.cells ?? [];
    // ⚠️ `cost_bar` ONLY. `scope` is NOT one axis across this ledger: `cost_bar`
    // scopes by STRUCTURE, `universe` scopes by SYMBOL. Folding every gate's
    // scopes in published a "bar" for AAL, AAPL, ABBV … — several hundred rows
    // of the conservative "an unrecognised structure gets the options bar"
    // fallback rendered as if a ticker were a sleeve. Caught on the first live
    // read after deploy; the gate that APPLIES this bar is the only one whose
    // scopes can name a structure it charges.
    const ledgerScopes = [...summary.byGate, ...summary.retained.byGate]
      .filter((g) => g.gate === COST_BAR_GATE)
      .flatMap((g) => (g.byScope ?? []).map((s) => s.scope));
    const barsByStructure = resolveGatedStructureBars({
      scopeLabels: ledgerScopes,
      cellStructures: tapeCells.map((c) => c.structure),
      config: costConfig,
    });
    /**
     * The `edge.otmCells` projection, lifted verbatim so the per-structure cells
     * below cannot drift from the OTM ones they are supposed to match (AC2 is
     * "the same shape", and two hand-maintained mappers are how that stops being
     * true). `otmCells` is rendered through this same function.
     */
    // TRA-4753 — ONE clock for every cell's `tapeAgeMs`, read before the map so
    // eight cells on one payload cannot publish eight different "now"s.
    const edgeReadAt = Date.now();
    const projectEdgeCell = (c: (typeof tapeCells)[number]) => ({
      bucket: c.bucket,
      n: c.n,
      meanR_gate: c.meanR_gate,
      seR_gate: c.seR_gate,
      lowerCI95: c.lowerCI95,
      barR: c.barR,
      admits: c.admits,
      /**
       * TRA-4578 — WHO is in this cell. `admits` above is decided by
       * `lowerCI95` alone, and `lowerCI95` reads identically whether the
       * cell is desk real-money closes or demo rows booked at mid
       * (`demoSlippagePct: 0` — demo realized R is gross of spread). This
       * block is the discriminator; it decides nothing.
       */
      provenance: c.provenance,
      /**
       * ⭐ TRA-4753 item 3 — HOW OLD THE TAPE IS, as its own field.
       *
       * `edge.freshness.ageMs` beside this block times the RECOMPUTE, not the
       * TAPE. The fold re-runs on a 60s TTL and on every option close, so a cell
       * whose population stopped growing seven weeks ago publishes `dirty:
       * false, ageMs 242366` — byte-identical to a healthy one. On 2026-09-20
       * the two cells enforcing the live OTM refusal held windows ending
       * 2026-08-04 and 2026-08-03, and the ONLY surface that would have caught it
       * was manual timestamp arithmetic on `provenance.toTs`.
       *
       * That staleness is structural rather than incidental, which is why it
       * gets a field: this tape grows only on a CLOSED FILL, and the gate these
       * cells feed refuses every candidate that could produce one. A cell whose
       * `ageDays` keeps climbing while its `n` holds still IS the closed loop.
       *
       * Derived, read-only, decides nothing. Null `toTs` ⇒ no row in the cell
       * carried a finite `closeTs`, and the ages are null rather than 0.
       */
      tapeWindow: {
        fromTs: c.provenance.fromTs,
        toTs: c.provenance.toTs,
        fromIso: c.provenance.fromTs === null ? null : new Date(c.provenance.fromTs).toISOString(),
        toIso: c.provenance.toTs === null ? null : new Date(c.provenance.toTs).toISOString(),
        /** `now − toTs`. The counterpart of, and NOT interchangeable with, `freshness.ageMs`. */
        tapeAgeMs: c.provenance.toTs === null ? null : edgeReadAt - c.provenance.toTs,
        tapeAgeDays:
          c.provenance.toTs === null
            ? null
            : Math.round(((edgeReadAt - c.provenance.toTs) / 86_400_000) * 10) / 10,
        /** Stamped so a saved probe can tell a stale tape from a stale PROBE. */
        asOf: new Date(edgeReadAt).toISOString(),
      },
      /**
       * TRA-4578 — the same cell with its own measured round-trip cost
       * charged to its demo rows. BESIDE the governing number, never
       * instead of it: `admits` is unchanged, `netOfModelledCross.
       * wouldAdmit` is the counterfactual. Null ⇒ no measured cost for
       * this cell (`unavailableReason` says which case) — never zero.
       */
      meanR_gate_netOfModelledCross: c.meanR_gate_netOfModelledCross,
      lowerCI95_netOfModelledCross: c.lowerCI95_netOfModelledCross,
      netOfModelledCross: c.netOfModelledCross,
    });
    const cellsByStructure = barsByStructure.map((b) => {
      const cells = tapeCells.filter((c) => c.structure === b.structure);
      return {
        structure: b.structure,
        /** The bar these cells' `lowerCI95` is compared against. Same number as `barsByStructure[].barR`. */
        barR: b.barR,
        /**
         * TRUE ⇒ at least one cell here clears the bar. FALSE with cells
         * present is a sleeve that is measured and refused; FALSE with
         * `cells: []` is a sleeve that is UNMEASURED — every candidate
         * declines `insufficient_evidence` and no bar was ever weighed. The
         * two want different responses and read identically off a block rate.
         */
        anyCellAdmits: cells.some((c) => c.admits),
        /**
         * ⭐ The discriminator TRA-4622 could not make. `optionsMinGrossR` is a
         * HARD FLOOR under every options bar, so a cell whose `lowerCI95` sits
         * below it is refused under EVERY reachable cost config — zero
         * commission, zero spread cross, zero safety margin included. TRUE here
         * means no cost retune can admit this cell and the refusal is an EDGE
         * fact, not a cost fact. Null for equity structures, which have no floor.
         */
        allCellsBelowFloorFloor: isEquityStructure(b.structure)
          ? null
          : cells.length > 0
            && cells.every((c) => c.lowerCI95 === null || c.lowerCI95 < costConfig.optionsMinGrossR),
        cells: cells.map(projectEdgeCell),
      };
    });
    // TRA-4748 (parent TRA-4746) — the session-coverage verdict rendered into the
    // `note` as well as into `retained.sessionCoverage`. Same reason the universe
    // ratification is in the prose: `retained.etDays` is what a reader actually
    // looks at, and an ABSENT day there reads as ordinary whether the market was
    // shut or the recorder was dead. A reader not looking for the field still
    // sees this sentence.
    const coverage = summary.retained.sessionCoverage;
    // rev2 — the MISS direction. A session is always a weekday, so the clause
    // above exempts every market HOLIDAY: a dead Thanksgiving reads identically
    // to a healthy one. `darkWeekdayHolidays` is the second alarm and it has to
    // reach the prose too, or it is as invisible as the hole it closes.
    const coverageClause =
      coverage.missingSessions.length > 0
        ? `⚠️ MISSING SESSION(S) — the ledger has NO row for [${coverage.missingSessions.join(', ')}], which the ${coverage.calendarVersion} calendar calls trading sessions`
        : coverage.darkWeekdayHolidays.length > 0
          ? `⚠️ DARK WEEKDAY HOLIDAY(S) — [${coverage.darkWeekdayHolidays.join(', ')}] carry NO row. The ${coverage.calendarVersion} calendar calls them non-sessions, so \`missingSessions\` is SILENT on them by design — but this recorder's MEASURED cadence is weekday-driven (it recorded on [${coverage.cadenceEvidence.nonSessionWeekdaysPresent.join(', ')}], holidays that same calendar also calls non-sessions), so those are working days for it and it wrote nothing`
          : `no expected session is absent through ${coverage.lastSessionEtDay ?? 'n/a (date outside the calendar bundle)'}, and ${coverage.weekdayDaysPresent}/${coverage.weekdayDaysExpected} Mon-Fri days in the window carry rows`;
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
           * ⭐ TRA-4749 — the bar for EVERY structure this gate is OBSERVED to
           * charge, `bar` above included. `bar` is `single_leg_otm` by a
           * hard-coded literal and always was; the retained ledger was
           * simultaneously recording `single_leg_rv` at a 100% block rate
           * against a bar that appeared on no surface.
           *
           * READ `barIdenticalToOtm` FIRST. `admissionBarR` branches on exactly
           * one predicate — `isEquityStructure` — so every options sleeve
           * (`single_leg_otm`, `single_leg_rv`, `single_leg_directional`, and
           * anything unrecognised) is charged `optionsCost` and gets the SAME
           * number. RV is not charged "a bar like OTM's"; it is charged OTM's,
           * because there is only one. `costInputs` names which of the two
           * input sets fed the entry, and `sources`/`scopeLabels` say where the
           * structure was observed, so nothing here is a hypothetical sleeve.
           *
           * ⚠️ That blend is DELIBERATE, not a defect discovered here:
           * `makerAdjustedSpreadCrossR` is one knob across every options sleeve
           * and TRA-1661 set it to the OTM (worse) measurement on purpose, which
           * `DEFAULT_COST_GATE_CONFIG`'s docstring records as overcharging RV by
           * ~0.075R. What was broken is that it was UNREADABLE here. Retuning it
           * is a nomination decision and is NOT this surface's to make.
           */
          barsByStructure,
          /**
           * TRA-4258 — the AUTHORIZATION behind `bar.safetyMarginR`, mirroring
           * `arm.universe.ratification` (TRA-3694). Every other field on `bar`
           * publishes what the live order site USES and nothing about what it
           * was ALLOWED to use, so a board-ratified margin and a quietly-cut one
           * render BYTE-IDENTICALLY — that gap alone produced a CRITICAL
           * live-risk escalation (TRA-4256) that was wrong and fully retracted.
           *
           * READ `.matchesLive`, not the two numbers. It is
           * `true | false | null`: an UNSET stamp is `null` — UNKNOWN — and
           * NEVER `true`, because a stamp defaulting to OK reproduces the very
           * defect it exists to detect; a SET-but-unparseable stamp reads
           * `false`, since somebody wrote a value and believes it is in force.
           * `null` is FALSY on purpose (TRA-4619): it used to render as the
           * string `'unstamped'`, which is truthy, so `if (r.matchesLive)`
           * PASSED on an unstamped bar. Read `reason` for which state you are
           * in — `'unstamped'` vs `'mismatch'` vs `'unparseable'`.
           *
           * ⚠️ READ-ONLY. Nothing on the admission path consults this — a
           * mismatch is REPORTED, never ENFORCED. Letting a stale or missing env
           * var dark a real-money sleeve is strictly worse than the problem
           * being solved.
           */
          ratification: costBarRatification,
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
            /**
             * ⭐ TRA-4783 — the cache fields here time the RECOMPUTE; the
             * `input*` fields merged beside them time the INPUTS, and they
             * are the discriminator. On 2026-09-22 this object read `dirty:
             * false, ageMs 26943` — the sanctioned degradation check — while
             * every cell below held a tape frozen 20–76 days, so the margin
             * `(lowerCI95 − barR)` was structurally unable to move and
             * nothing on this route said so. The fold runs over the SAME
             * cells `otmCells` renders, on the same `edgeReadAt` clock their
             * `tapeWindow` blocks are stamped with. `inputStale` is
             * three-valued: `null` is NOT COMPUTABLE and must never be read
             * as false (`?? false` reproduces the bug one layer up).
             * Read-only — no admission path, arm or disarm consults it.
             */
            freshness: {
              ...tapeExpectancyCache().freshness(),
              ...summarizeTapeInputStaleness(
                tapeCells.filter((c) => c.structure === COST_BAR_PUBLISHED_STRUCTURE),
                edgeReadAt,
              ),
            },
            otmCells: tapeCells
              .filter((c) => c.structure === COST_BAR_PUBLISHED_STRUCTURE)
              .map(projectEdgeCell),
            /**
             * ⭐ TRA-4749 — the SAME cells for every structure `barsByStructure`
             * covers, `single_leg_otm` included. `otmCells` above is retained
             * byte-identical (it is rendered through this block's own projector,
             * so the two can never drift) because TRA-4622's reader and every
             * saved probe address it by name; this is the unscoped view beside
             * it, not a replacement.
             *
             * An entry with `cells: []` is a sleeve the fold has NEVER measured:
             * its candidates decline `insufficient_evidence` and no bar was
             * weighed, which reads identically to "the bar refused it" off a
             * block rate alone.
             *
             * ⭐ `allCellsBelowFloorFloor` is the question TRA-4622 opened and
             * could not close: TRUE means every cell of that sleeve sits below
             * `optionsMinGrossR`, the HARD FLOOR under every options bar, and is
             * therefore refused under every reachable cost config — including
             * commission, spread cross and safety margin all set to ZERO. A TRUE
             * there says the refusal is an EDGE fact and no cost retune reaches
             * it.
             */
            cellsByStructure,
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
          /**
           * ⭐ TRA-3694 — the AUTHORIZATION, which everything above is silent on.
           * `source: 'env'` says an operator set this; it does NOT say the board
           * ratified it, and a RATIFIED widening and an UNRATIFIED one rendered
           * byte-identically here. The same field was consequently flagged twice
           * in 26 hours by two independent readers off exactly this absence.
           *
           * READ `ratification.matchesLive`, not the two strings. It is
           * `true | false | null` and an UNSET stamp is `null` — UNKNOWN —
           * NEVER `true`: a stamp that defaults to OK would reproduce the very
           * defect it fixes, one layer up. A set-but-unparseable stamp reads
           * `false` (somebody wrote a value and believes it is in force).
           * `null` is FALSY on purpose (TRA-4619): it used to render as the
           * truthy string `'unstamped'`, so `if (r.matchesLive)` PASSED on an
           * unstamped universe. `reason: 'unstamped'` names the state.
           *
           * `onlyLive` is the direction that matters: names real money can open
           * that the ratification does not cover. This is a READ-ONLY instrument
           * — a mismatch blocks nothing.
           */
          ratification: universeRatification,
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
        /**
         * TRA-4244 (parent TRA-4238) — the PROFIT side of the same sleeve. Every
         * other block here is an ADMISSION gate; this one is the exit schedule
         * the admitted row is then managed under, and it was the half nothing
         * published. TRA-4238 measured the consequence: with the compiled TP1 at
         * +50% and the profit lock arming at 0.75R, the two rules that are
         * supposed to monetize a winner never fired on the live sleeve, and no
         * surface said which numbers were in force.
         *
         * Same contract as `costBar.bar` (TRA-3515's `barR`): the RESOLVED value
         * beside its SOURCE, so an override that silently failed to parse reads
         * as `source: 'compiled'` with a named rejection instead of a deliberate
         * default. ⭐ The four knobs fail closed as a SET — `rejected` non-empty
         * means every override was discarded, not just the offending one.
         *
         * ⚠️ Resolved from `process.env` AT REQUEST TIME; the account resolved
         * its copy AT BOOT. An env write that has not been applied by a redeploy
         * (TRA-3724) therefore shows up HERE before it is in force in the engine.
         * That is deliberate — it is the only way to see a pending re-cut — but
         * it means this block answers "what would a restart run", and the live
         * build's SHA (`build` above) is what says whether it already does.
         */
        profitSchedule: {
          ...describeOtmProfitSchedule(liveEnv),
          /**
           * TRA-4244 (b) — without this, TP1 is dead on the live sleeve at ANY
           * threshold: the partial branch is gated on `contractsRemaining > 1`
           * and every live OTM row is a 1-lot. So `effective.tp1Pct` above is
           * only a REACHABLE number while this reads `armed: true`.
           */
          tp1FullExit1Lot: {
            flag: OTM_TP1_FULL_EXIT_1LOT_FLAG,
            armed: isOtmTp1FullExit1LotEnabled(liveEnv),
          },
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
      // even before TRA-3856 gave it an abstaining branch: it changes WHICH
      // contract is nominated (and may now nominate none at all), so the claim
      // has to answer to the selector as well as to the gates.
      note:
        !anyArmed && !universe.restricted && !admissibleStrikeArmed
          ? `SHADOW-ONLY: all live enforcement flags OFF and the live OTM universe is UNRESTRICTED (${OPTION_LIVE_OTM_UNIVERSE_VAR}=${universe.raw ?? ''}) — the live options path is byte-for-byte the pre-TRA-2048/pre-TRA-2763 behaviour (no rejection) AND real money can open on any of the ~614 watchlist names, which is the TRA-3216 defect. Arm as an ops action: ${OPTION_COST_GATE_LIVE_ENFORCE_FLAG}=1, ${OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG}=1 and/or ${OPTION_OTM_DELTA_FLOOR_LIVE_FLAG}=1 (+ ${OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR}=<floor>) on bqb1 (process env, never demo-flags); unset ${OPTION_LIVE_OTM_UNIVERSE_VAR} to restore the allowlist. Ratification: ${universeRatificationClause} (TRA-3694 — arm.universe.ratification); cost-bar safety margin: ${costBarRatificationClause} (TRA-4258 — arm.costBar.ratification).`
          : `ENFORCING (live): universe=${universe.restricted ? `RESTRICTED to [${universe.symbols.join(',')}] (${universe.source}; ${universeRatificationClause})` : `UNRESTRICTED — all ~614 watchlist names tradeable with real money (${OPTION_LIVE_OTM_UNIVERSE_VAR}=${OPTION_LIVE_OTM_UNIVERSE_UNRESTRICTED})`}, cost_bar=${costArmed ? (netEdgeGovernsOtm ? `ARMED in NET_EDGE form (TRA-3272: block when cost > k=${netEdge.k} × modeled edge; fees $${netEdge.feesPerContractRoundTrip}/contract RT; abs ceiling ${(netEdge.absCostFracCeiling * 100).toFixed(0)}% of premium — arm.costBar.bar is NOT what the OTM open faces)` : `ARMED at ${otmBar.barR.toFixed(3)}R${otmBar.barPinnedByFloor ? ' (PINNED BY THE MIN_GROSS FLOOR — retuning commission/spread alone is a no-op)' : ` (dominant term ${otmBar.dominantTerm})`}`) : 'off'}, spread=${spreadArmed ? 'ARMED' : 'off'}, otm_delta_floor=${otmFloorArmed ? `ARMED at |delta| >= ${resolveOptionOtmDeltaFloorLive(liveEnv)}` : 'off'}, otm_nominator=${admissibleStrikeArmed ? `ARMED into |delta| [${admissibleStrikeBand.min}, ${admissibleStrikeBand.max}) (TRA-3401 — a SELECTOR upstream of every gate here: it makes no verdict of its own, so it is not a row in byGate; since TRA-3510 it is instead an AXIS ON every gate, \`bySelection\` — see the paragraph at the end. TRA-3856: band-FIRST with tiers \`cheap\` then \`fair\` (\`in_band_fair\`), and it ABSTAINS when the band holds nothing nominable — an abstained scan reaches no gate, so it appears ONLY in the scan-run reject bucket \`no_in_band_strike\`, never here; the old far-OTM fallback nomination is gone)` : 'off (legacy top-|mispricingPct| nominee, delta-blind)'}. Per gate, blocked>0 is the direct evidence it is biting; evaluated>0 with blocked=0 is an armed gate passing every candidate it saw. On the universe axis ONLY, evaluated=0 is ambiguous unless read with arm.universe.restricted — an unrestricted universe records no verdict at all. byReason splits the BLOCKS (cost_bar buckets the shortfall below arm.costBar.bar.barR, so "how much would I have to move the bar" is answered off recorded data); byBook names the live books each gate actually governed, so a fleet claim is checkable rather than assumed from a process-level flag. ⚠️ The universe cut runs BEFORE the cost bar, so cost_bar's denominator STEPS DOWN when the allowlist first takes effect — do not compare a post-TRA-3216 block rate to a pre one. Read retained for the multi-day fold (a one-day counter self-clears at ET midnight) and durability.ephemeral before trusting any count. ⚠️ TRA-3391 changed what cost_bar's edge IS: it is now the LOWER 95% CI bound of the candidate's measured tape cell (arm.costBar.edge), not \`3·|delta| − 1\`. Two consequences for this payload — (1) \`byReason\` now carries \`insufficient_evidence\`, which means WE NEVER MEASURED THAT CELL and is NOT \`gross_negative\` (a measured loser). ⚠️ TRA-3401 — do NOT scope that by symbol: the cell key is \`structure × |delta| bucket\` with NO symbol axis, so the universe restriction does not scope the fold. "On the restricted live universe the tape holds 471 rows, ALL |Δ| < 0.20" describes where the live sleeve has historically NOMINATED, NOT the evidence a candidate in the admitted band is decided under — that band is pooled across every symbol and mode, and it ADMITS. Reading the 471 the other way reported an evidence deadlock that does not exist. (2) \`byCell\` names the cell each verdict was decided under, admits included — cross-read it against /api/health/option-expectancy-table, which publishes n / mean / SE / lowerCI95 / admits per cell. ⚠️ TRA-3483 — \`byGate[cost_bar]\` now also carries \`costRQuantiles\` and \`netEdgeShadow\`, and BOTH ARE RECORDERS: \`${netEdge.flag}\` is ${netEdge.enabled ? 'ARMED' : '`false`'} and nothing in either block feeds a verdict. They exist because \`k\` is a RATIO — \`admit ⟺ costR ≤ k · modeledGrossR\` — and the deployed surface published the DENOMINATOR only (the expectancy table's per-cell lowerCI95), while every row inside a cell shares that same denominator. \`costR\` is therefore the ONLY axis \`k\` can discriminate on, and it is now emitted per decision, admits included, in the same \`R_gate\` unit as \`barR\`, split into \`spreadR\` (the candidate's own quote cross) and \`feeR\` (the $${netEdge.feesPerContractRoundTrip}/contract RT floor). \`netEdgeShadow.sweep\` replays the net-edge admit rule at 8 candidate \`k\` on those recorded rows and reports \`medianNetR_admitted\` = median(modeledGrossR − costR) over what each \`k\` would admit, against \`flatFormAdmits\` — the DEPLOYED form's admits on the IDENTICAL row set, so the comparison is paired. Read \`rowsEvaluated\` vs \`rowsRecorded\` / \`rowsMissingCostR\` FIRST: a row whose quote was unusable produces no cost sample and is excluded from the sweep denominator (under the real form it would be a \`net_edge_quote_unusable\` block at every k), and \`samplesDropped > 0\` means the quantiles are over a truncated head. \`rowsMissingGrossR\` counts evaluated rows whose edge was unknown — those fail closed at every \`k\` and are IN the denominator, because an unknown edge is a real block, not missing cost data. ⚠️ TRA-3483 (D2) — each gate also publishes \`blockedUnclassified\`: BLOCKED rows carrying no \`reasonCode\`, which \`byReason\` cannot see. Every \`byReason.share\` is of \`blocked\`, which INCLUDES those rows, so when \`blockedUnclassified > 0\` the rows DO NOT sum to 1 and the gap is COVERAGE, not a residual bucket. On the retained fold this is the pre-stamping backlog that made \`gross_negative\`'s share read as a rate. ⚠️ TRA-3510 — every gate now also carries \`bySelection\`: which TRA-3401 NOMINATOR BRANCH produced the candidate each verdict ruled on (\`in_band\` | \`in_band_fair\` | \`fallback_top_mispricing\` — persisted pre-TRA-3856 rows only | \`legacy\`), admits included, with \`meanCheapConsidered\` / \`meanCheapInBand\` over their own \`rowsWithChainShape\` denominator. READ THIS BEFORE QUOTING ANY ZERO ON A DELTA GATE. The selector runs upstream of every gate here, and on its \`in_band\` branch the nominee's |Δ| is inside [${admissibleStrikeBand.min}, ${admissibleStrikeBand.max}) BY CONSTRUCTION — so it cannot breach a ceiling at the band's own max, and it cannot breach a floor at or below the band's min. \`entry_delta_ceiling_shadow.blocked === 0\` and \`otm_delta_floor.blocked === 0\` therefore have two byte-identical causes — "the selector clamped every row into the band" (a vacuous zero, arithmetic) and "the far tail was nominated and genuinely did not breach" (a measurement) — and \`bySelection\` is the ONLY axis on this payload that separates them. Rows concentrated on \`in_band\` ⇒ do not publish that zero as a tail estimate. An EMPTY \`bySelection\` on a gate with \`evaluated > 0\` means those rows predate this axis or came from a non-OTM path (RV / directional cost_bar rows carry no nominator); it never means one branch produced them all. ⚠️ TRA-3510 also HOISTED \`otm_delta_floor\` above the cost bar, joining the ceiling TRA-3504 hoisted: both edges of the ratified band are now on the same side of it. Consequence for this payload — when the floor is armed, a sub-floor candidate attributes to \`otm_delta_floor\` instead of \`cost_bar\`/\`gross_negative\`, and \`cost_bar\`'s denominator steps DOWN by exactly the floor's blocked count. That is correct attribution, not a regression; do not compare a post-arm cost_bar rate to a pre-arm one. ⚠️ TRA-3694 — \`arm.universe.ratification\` publishes the AUTHORIZATION, which every other field on \`arm.universe\` is silent about. \`source: 'env'\` says an operator set the value; it does NOT say the board ratified it, and before this ticket a ratified widening and an unratified one rendered BYTE-IDENTICALLY here — the same field was flagged twice in 26 hours by two independent readers (CFO interaction \`8e303cd7\`, then TRA-3661) because each had to re-derive the answer from board records that sit nowhere near this route. READ \`ratification.matchesLive\`, not the two strings: the failure being fixed is precisely a comparison nobody performs, so the route computes it. It is \`true | false | null\` — an UNSET stamp is \`null\` (UNKNOWN) and NEVER \`true\`, because a stamp defaulting to OK reproduces the original defect one layer up; a SET-but-unparseable stamp reads \`false\`, not \`null\`, since somebody wrote a value and believes it is in force. ⚠️ TRA-4619 — that UNKNOWN state USED TO render as the string \`'unstamped'\`, which is NON-EMPTY and therefore TRUTHY: \`if (ratification.matchesLive)\` PASSED on an unstamped universe, and \`if (!ratification.matchesLive)\` silently SKIPPED it, while the \`note\` said "This is NOT a pass" in English. It is now \`null\`, which is falsy, so both of those idioms fail safe; \`=== true\` / \`=== false\` readers are unchanged. The state's NAME moved to \`ratification.reason\`, which reads \`'unstamped'\` on exactly the branches where \`matchesLive\` is \`null\`. Do NOT test this field against the string \`'unstamped'\` — the payload no longer emits it anywhere. The comparison is on the RESOLVED symbol SET under the enforcement path's own parse, so whitespace and ordering cannot manufacture a false alarm, while \`ratification.onlyLive\` names the live symbols the ratification does NOT cover — the unratified-widening direction, which is the one that spends real money. This is a READ-ONLY instrument: a mismatch here blocks no order, because a missing env var halting a real-money sleeve would be strictly worse than the defect it fixes. ⚠️ TRA-4154 — every gate now carries \`byEtDay\`, the PER-ET-DAY roll, and on \`retained\` it is the only axis on this payload that can answer WHEN. Read it before concluding a gate saw a quiet market. \`retained.byGate[]\` is a ${summary.retained.retentionDays}-day fold and the top-level since-boot \`byGate[]\` is zeroed by every redeploy, so between them a SELF-DISARMED sleeve and a genuinely quiet one rendered IDENTICALLY on any single day: a cell that admitted for most of the fold and has refused everything since pools to a mid-range \`blockRate\` describing neither state. That is not hypothetical — on 2026-08-26T13:52:06Z \`arm.costBar.edge.otmCells\` went to zero of eight cells admitting, by arithmetic, with \`arm.costBar.armed\` still \`true\` and nothing flipped by a human, while the pooled \`byCell[single_leg_otm::0.50-0.55]\` went on reading \`blockRate 0.3112\`. TRA-2879's disarm criterion is \`avgR < 0 over >= 20 closes\`, and a sleeve admitting nothing produces no closes, so the watch was structurally blind to its own subject. Each row carries the day's \`evaluated\`/\`blocked\`/\`blockRate\` plus the \`byCell\` / \`bySelection\` / \`byReason\` splits and \`blockedUnclassified\`. Three reading rules: (1) a day this gate recorded nothing on is a PRESENT row at \`evaluated: 0, blockRate: null\`, never an absent one — the roll's length is \`retained.etDays\`' length on every gate; (2) \`Σ byEtDay[].evaluated\` equals the gate's \`evaluated\` exactly, because both are folded from the same per-day tallies rather than counted twice; (3) \`byCell\` and \`bySelection\` are PARTIAL axes (a row stamps at most one key, and only since the deploy that added the field), so each day publishes \`cellUnstamped\` / \`selectionUnstamped\` — the rows that axis cannot see — alongside \`blockedUnclassified\`. Do NOT read \`Σ byCell[].blocked\` as the day's blocks without them. There is deliberately no per-day \`byScope\`: on \`spread\`/\`universe\` the scope key is the underlying symbol (178 of them on the live \`universe\` fold), and crossing that with the retained days is a quarter-megabyte for a split nothing asks for per-day — the pooled \`byScope\` on the gate is unchanged. Durability is inherited, not separate: the roll is folded from the same on-disk store the pooled totals are, so \`durability.ephemeral\` governs both. ⚠️ TRA-4258 — \`arm.costBar.ratification\` is the TRA-3694 stamp applied to \`bar.safetyMarginR\`, and it reads ${costBarRatificationClause}. Every other field on \`arm.costBar.bar\` publishes what the live order site USES and nothing about what it was AUTHORIZED to use, so a board-ratified margin and a quietly-cut one render BYTE-IDENTICALLY here — on 2026-09-01 that gap alone produced a CRITICAL live-risk escalation (TRA-4256) claiming the live margin had drifted 0.05R below its ratified value, which was WRONG and fully retracted: the 0.10 was ratified on card \`10fd2af1\` and executed on TRA-4168. Answering it took two tickets, thirty comments and six interaction cards; it is now this field. Read \`.matchesLive\` and not the two numbers — it is \`true | false | null\`, an UNSET stamp is \`null\` (UNKNOWN) and NEVER \`true\` (a stamp defaulting to OK reproduces the defect it detects), and a SET-but-unparseable one reads \`false\` because somebody wrote a value and believes it is in force. ⚠️ TRA-4619 — this field used to render UNKNOWN as the TRUTHY string \`'unstamped'\`, so \`if (r.matchesLive)\` authorized on an unstamped bar; \`null\` is falsy and fails closed there. \`reason\` carries the state name (\`'unstamped'\`), and \`ratificationMatchesLive\`-style folds keep their precedence: any \`false\` ⇒ \`false\`, else any \`null\` ⇒ \`null\`. The compare is on the RESOLVED margin the order site adds, not the raw env — a malformed \`${OPTION_COST_GATE_SAFETY_MARGIN_R_VAR}\` enforces the shipped default, and grading the raw would compare the stamp against a value nothing obeys — with a 1e-9 tolerance so a string-vs-float last-bit difference cannot manufacture an alarm. ⚠️ It is READ-ONLY, exactly like the universe stamp: NO admission path, arm/disarm or block reason consults it, because a stale or missing env var darking a real-money sleeve is strictly worse than the problem it solves. ⚠️ And it is an ATTESTATION, not a licence to retune: 0.10R is the board-ratified margin and TRA-4168's closing comment declares it the FLOOR. ⚠️ TRA-4745 — \`byGate[cost_bar]\` now also carries \`grossRQuantiles\`, \`rowsCompared\` / \`rowsShortCircuited\` / \`predicateUnstamped\`, \`costBySymbol\` / \`costRowsMissingSymbol\`, and per cell \`grossRQuantiles\` + \`predicateSamples\`. **READ THEM BEFORE INFERRING A BLOCK RATE FROM \`costRQuantiles\` AND \`arm.costBar.bar.barR\`.** That inference is WRONG and this payload used to invite it: the two numbers it published were the bar and the one quantity the DEPLOYED flat form never compares the bar to. The deployed comparison is \`admit ⟺ grossR ≥ barR\`, where \`grossR\` is the candidate cell's LOWER 95% CI bound (\`tapeEdgeR\`) — \`costR\` is a TRA-3483 RECORDER and nothing on the flat branch consults it. Measured on the live retained fold 2026-09-20 (TRA-4741, witness comment \`47a32c11\`), the costR-vs-bar prediction held to −1.7pp on \`single_leg_otm::0.50-0.55\` and missed by **+39.1pp**, **+56.1pp** and **+98.0pp** on the other three cells; \`single_leg_rv::0.55-1.00\` refused 633 of 633 at a median \`costR\` of 0.1645 — 57% BELOW the bar. Three reading rules. (1) Every row inside a cell shares the SAME \`grossR\` (it is a property of the CELL, not of the candidate), so on one day a cell's flat predicate is CONSTANT and its block rate is 0% or 100% — a 100.0% cell is the EXPECTED shape of a cell whose bound sits under the bar, not evidence of a mis-attributed refusal; a pooled cell spreads only because the tape re-folds between days. (2) \`predicateSamples\` publishes ONE sampled BLOCKED row per cell per ET day with the realised comparison — left side, operator, right side, outcome — which is what answers “\`shortfall_lt_0.10\` / \`shortfall_0.25_0.50\` / \`shortfall_gte_0.50\` is a shortfall of WHAT against WHAT”: it is \`barR − grossR\`, in \`R_gate\`, and \`grossRQuantiles.shortfallR\` is its distribution. (3) **\`compared: false\` is the third answer.** Three flat-form branches refuse BEFORE any inequality runs — \`insufficient_evidence\` (cell holds n < minCellN), \`band_deauthorized\` (the TRA-3394 ratified mandate) and \`gross_unknown\` (no usable delta). Those rows are stamped \`cost_bar\` and land in \`byReason\`, but no bar and no cost was weighed, so a cell at \`blocked === evaluated\` with \`rowsCompared: 0\` is NEITHER “the cost is too high” NOR “the edge collapsed” — it is “we never measured this cell”, and no bar move and no \`k\` can reach it. ⚠️ \`costBySymbol\` is NOT \`bySymbol\`: that key is the TRA-4269 ratified-set counterfactual (its rows carry \`inRatifiedSet\`, which only \`universe\` computes) and it stays \`null\` on \`cost_bar\` deliberately rather than carrying a second meaning under one name. **Read \`costRowsMissingSymbol\` FIRST** — \`cost_bar\` recorded no underlying at all before this ticket (its \`scope\` key is the STRUCTURE), so every row hydrated from a pre-deploy JSONL line is in that counter and contributes no \`costBySymbol\` row: a short or empty axis over the 30-day retained fold is COVERAGE, not a quiet universe. Same for \`predicateUnstamped\` against \`predicateSamples\`. ⚠️ TRA-4745 (2026-09-20 follow-up) — **\`barRImplied\` is the field to read while \`rowsCompared\` is 0.** The per-row \`predicate\` stamp above is the right instrument and it is EMPTY on any row written before its own deploy — 9558 of 9558 on the fold it shipped onto, and the first stamped row cannot arrive before the next RTH nomination. So the bar is ALSO recovered from rows the ledger has held since TRA-3483, by inverting \`reasonCode\`: the \`shortfall_*\` buckets are a bounded function of \`barR − grossR\` and \`grossR\` is recorded on the same row, so one blocked row bounds the bar two-sidedly (\`shortfall_0.25_0.50\` at \`grossR −0.051\` ⇒ \`barR ∈ [0.199, 0.449)\`) and every ADMITTED row proves \`barR ≤ grossR\` for free. It is published per cell AND per \`byEtDay[].byCell[]\`, with \`publishedBarR\` echoed and \`excludesPublishedBarR\` graded in place so no reader has to join today's scalar onto a 30-day fold — which is the mistake this whole ticket is about. **Read \`consistent\` FIRST: \`false\` is a RESULT, not a defect** — it says the group's own rows cannot all have faced ONE bar, i.e. the bar moved while they accumulated, and \`excludesPublishedBarR\` then abstains to \`null\` because an empty interval excludes everything. \`rowsUnusable\` counts rows that constrain nothing (no recorded \`grossR\`, or a pre-comparison refusal that never met a bar); a group at zero usable rows publishes \`null\`, never a default. ⚠️ **\`byEtDay[].byCell[].grossR\` is the provenance answer**, and it is evidence rather than an assertion: a distribution BACK-FILLED from the current estimator is constant across every day by construction, so a bound that MOVES day to day can only have been written at the decision. Its \`distinct\` counts raw recorded doubles within one cell-day — \`1\` means the bound held still and the day's block rate must be 0% or 100% on the bar alone; \`> 1\` means one side re-resolved mid-session, which is the ONLY way a single cell-day lands strictly between. ⚠️ **Do NOT read a POOLED cell's \`blockRate\` as a per-candidate spread.** \`single_leg_otm::0.50-0.55\` pools to 39.12% (1627/4159) and that is a TIME AVERAGE, not a distribution: its own \`byEtDay\` roll is 0% on 08-21/24/25, **100% on 08-26 and 08-27**, 43.4% on 08-28 (168/387, the mid-session flip) and 0% again on 08-31/09-01. ⚠️ There is no separate \`single_leg_rv\` bar to publish: \`admissionBarR\` keys on structure only through the equity/option split, so the rv rows are charged the SAME bar, and their recovered interval contains it. ⚠️ TRA-4745 (2026-09-22 follow-up) — **\`predicateSamples[].statement\` now renders the comparison's TRUTH VALUE**, and the gate and each cell carry **\`rowsPredicateInconsistent\`**. The stamp populated on the first post-deploy RTH nominations (09-21 and 09-22) and read \`grossR -0.2154 >= barR 0.3850 ⇒ BLOCK\` — an inequality and a refusal, with nothing saying the inequality was FALSE. Scanned at a glance that is an assertion followed by a block, i.e. it LOOKS like "a non-cost refusal stamped \`cost_bar\`" — the exact mis-reading this ticket exists to kill, reproduced one layer down inside its own fix. It now reads \`… → FALSE ⇒ BLOCK\`. \`holds\` is that truth value re-evaluated from the three PUBLISHED numbers (never read off \`admit\`), and \`outcomeConsistent\` is \`holds === !blocked\` — on the flat form an INVARIANT, so \`false\` means the displayed comparison did not decide that row and the remedy is in the gate's ATTRIBUTION, not the bar and not the edge estimator. Such a row additionally renders a loud \`⚠️ INCONSISTENT\` tail. **\`rowsPredicateInconsistent\` is that test as a CENSUS over every compared row**, because \`predicateSamples\` shows one row per cell per ET day and a sample can witness an inconsistency but never bound it. ⛔ **Read it as a fraction of \`rowsCompared\`**: zero against \`rowsCompared: 0\` is SILENCE, not an all-clear, and a short-circuited row scores \`null\` on both fields rather than being counted either way — it ran no inequality to be consistent with. Live on pin \`edafd70cd68d\` 2026-09-22, 3207 of 11203 rows stamped: every one sits in a cell whose \`grossR\` is degenerate and strictly below the 0.385 \`barR\` with \`blocked === evaluated\`, so reading (A) is refuted on the whole stamped census BY DERIVATION — this field publishes that directly instead of leaving it to be re-derived. ⚠️ STRICTLY ADDITIVE TELEMETRY — TRA-4745 changed no gate behaviour: every field here is folded from rows the ledger already recorded plus two new stamps, and nothing on the admission path reads any of it. ⚠️ TRA-4748 — \`retained.sessionCoverage\` reads \`retained.etDays\` against the NYSE calendar, and right now it says ${coverageClause}. It exists because an ABSENT day in \`etDays\` had TWO causes that rendered identically: (a) there was no session (weekend or closure) and (b) the decision-recording path was dead — which have completely different remedies. TRA-4746 asked the (b) question about 2026-09-19, and answering it took a hand-diff of \`etDays\` against a mental calendar AFTER the question had already reached a board escalation; the answer was (a), a Saturday. **\`missingSessions\` non-empty is the alarm and is the only field here that means something is broken.** ⛔ **THE COMPARISON IS ONE-DIRECTIONAL BY DESIGN.** Expected-but-absent is red; PRESENT-but-not-expected is NOT, and must never be made so — the entry-evaluation site does not honour this calendar and never claimed to: **2026-09-07 is Labor Day** (\`non_session\`) and the retained ledger holds **736 \`entry_window\` evaluations for it**. A symmetric diff alarms on every market holiday, i.e. it is wrong in both directions at once. \`lastSessionEtDay\` is the last session STRICTLY BEFORE today, so a session still in progress is never called missing — the cost is that a dead Monday raises on Tuesday, and the alternative is an alarm that fires every morning and is read by nobody. \`sessionsSinceLastDecision\` counts SESSIONS, not calendar days, so an ordinary weekend reads \`0\`; it is anchored on the last day that recorded a NON-SHADOW evaluation, so a day carrying only \`entry_delta_ceiling_shadow\` rows cannot mask a stall, and it is \`null\` (never \`0\`) when no retained day decided anything. \`zeroEvaluatedSessions\` is the present-but-idle bucket, which separates cause (a) from cause (b) on the day it happens — and it is a DIFFERENT question from \`evaluated: 0\` on ONE gate, which is ordinary (\`cost_bar\` evaluated 0 across 2026-09-02..08 while \`entry_window\` evaluated 607/671/692/736/1222). Empty \`etDays\` claims no holes at all: with no retained day there is no window to claim one inside, and inventing one from the calendar would page on every cold boot. ⚠️ STRICTLY DERIVED, STRICTLY READ-ONLY — folded from \`etDays\` + the retained per-gate roll + the shipped calendar bundle; no gate behaviour changed and nothing on the admission path reads any of it. ⚠️ TRA-4748 rev2 — review (CFO comment \`9f20ec40\`, QuantTrader comment \`63de41b4\`) caught that the one-directional rule, while correct, leaves a hole in the OTHER direction: a session is ALWAYS a weekday, so \`missingSessions\` exempts EVERY market holiday, and a Thanksgiving on which the recorder was dead reads BYTE-IDENTICALLY to a healthy one. That is live here rather than theoretical, because this recorder is WEEKDAY-cadenced — Labor Day proves both halves at once. So the enumeration now runs over the Mon-Fri set (which strictly CONTAINS the session set, and therefore loses nothing) and the calendar ANNOTATES each absence instead of gating the alarm. Read \`darkWeekdayHolidays\` as the SECOND alarm: weekday holidays carrying no row, landing after the most recent holiday that DID record. ⛔ This is NOT the rejected pure-weekday arithmetic re-proposed. That was rejected for being right by COINCIDENCE — because holidays happen to append rows here — and \`recorderCadence\` MEASURES that coincidence off this very payload (\`weekday\` | \`session\` | \`indeterminate\`, with the days it ruled on published in \`cadenceEvidence\`), so the alarm goes silent BY CONSTRUCTION the moment it stops holding. Most 30-day windows contain no holiday at all and read \`indeterminate\`; that is the normal reading, not a fault, and this field is evidence ABOUT the recorder rather than a verdict on it. \`weekdayDaysExpected\` vs \`weekdayDaysPresent\` turns "is the ledger continuous?" into a subtraction, and \`absentWeekdays\` carries every absent Mon-Fri day with its reason (\`no_records\` = red, and identical by construction to \`missingSessions\`; \`non_session\` = a closure). ⚠️ \`gateRosterBoundaries\` answers a SEPARATE finding and you should read it before quoting ANY cross-day trend off this funnel: the set of gates that record anything is NOT fixed across the retained window — measured on live bytes 2026-09-20 it changes 7 times in 21 days — so "gate X evaluated 0" is not a stable predicate over it. On 2026-08-21 \`contract_floor\` and \`entry_window\` both evaluate 0 while \`cost_bar\` evaluates 1,562, because that day PREDATES the wiring of the upstream gates; a site-dark test keyed on the largest-denominator gate calls that an outage when it is a schema change. A boundary asserts NON-COMPARABILITY and is not a defect claim — a genuinely low-volume gate that saw no candidate flips the set too (\`canary_ceiling\` evaluated 5 on that same day), which is why \`added\`/\`removed\` are published rather than a bare flag. Still strictly derived and strictly read-only: nothing on the admission path reads any of it. ⚠️ TRA-4753 — **\`grossRProvenance\` is the NUMERATOR's stamp, the counterpart of \`barRImplied\` (which recovers the DENOMINATOR).** It is published per cell and gate-wide on \`cost_bar\`, and \`arm.costBar.edge.otmCells[].tapeWindow\` is its read-side twin. It exists because the previous build could show that all 2627 rows of \`single_leg_otm::0.30-0.40\` shared one \`grossR\` equal to that cell's \`lowerCI95\` to 15 significant figures, and could NOT say whether the gate READ the estimator or merely agreed with it — \`rowsCompared 0\`, \`predicateSamples []\`. **CONFIRMED IN CODE:** the deployed flat form is \`tapeExpectancyVerdict\`, the compared value is \`tapeEdgeR(verdict) = verdict.lowerCI95 = cell.lowerCI95\`, and the candidate contributes only \`structure\` and \`delta\` — which SELECT the cell and do not enter the number. So \`grossR\` is a **PER-CELL CONSTANT**, on the net-edge branch too (\`netEdgeBarVerdict\` is handed \`modeledGrossR: tapeEdgeR(tape)\`, deliberately, TRA-3391 Ruling 2.8). There is no per-candidate modelled edge anywhere on this gate. **Read \`constantAcrossRows\` FIRST:** \`true\` means every stamped decision in the group was compared against ONE number, so the refusal COUNT carries no more evidence than its first row does, and \`blocked === evaluated\` is the EXPECTED shape rather than N independent findings. \`generations[]\` is the fold-by-fold breakdown — \`rows\` is how many decisions one fold was replayed across, while \`n\` and \`byMode\` describe THE CELL and must never be multiplied by \`rows\`. **Dispersion inside a pooled cell is a TIME axis, never a candidate axis:** \`0.50-0.55\` spread because its tape re-folded between days, and the other three were pinned because their tape STOPPED GROWING. ⚠️ **\`tapeAgeMsAtLastDecision\` — and \`arm.costBar.edge.otmCells[].tapeWindow.tapeAgeMs\` — are NOT \`edge.freshness.ageMs\`.** \`freshness\` times the RECOMPUTE, which re-runs on a 60s TTL and on every option close; the TAPE behind those two enforcing cells ends 2026-08-04 and 2026-08-03, and on 2026-09-20 \`freshness\` read \`dirty: false, ageMs 242366\` regardless. Manual timestamp arithmetic on \`provenance.toTs\` was the only surface that would have caught it; it is now a field. ⚠️ That staleness is STRUCTURAL: this tape grows only on a CLOSED FILL and the gate refuses every candidate that could produce one, so a cell whose \`tapeAgeDays\` climbs while its \`n\` holds still is a closed loop — a STRATEGY question for the board, not a defect in this gate, which is behaving exactly as specified. ⚠️ \`rowsUnstamped\` is the coverage denominator, same contract as \`predicateUnstamped\`: every row written before this deploy is in it, so a short \`generations\` list over the 30-day retained fold is COVERAGE, not a quiet gate. ⚠️ **\`grossRProvenance.recovered\` IS THE FIELD TO READ WHILE \`rowsStamped\` IS 0**, and it is the same move \`barRImplied\` made: \`grossR\` itself has been recorded per row since TRA-3483, so pooling a cell over its own days and counting DISTINCT recorded doubles answers the replay question on the whole retained census on boot, with no stamp. \`heldConstantAcrossDays: true\` = ONE value, 2+ rows, 2+ ET days ⇒ the gate compared every one of those candidates against the same number on every one of those sessions. It keys on the RAW double — no rounding, because a bound that re-resolved by a last bit is a bound that re-resolved. ⚠️ It is EVIDENCE, not an assertion, and it CARRIES ITS OWN CONTROL: a distribution back-filled from the current estimator would be constant everywhere BY CONSTRUCTION, so the fact that \`single_leg_otm::0.50-0.55\` reads \`false\` (7 distinct bounds over 8 days, 5 of them inside 2026-08-21 alone) on the SAME field, folded by the SAME code, is what proves the others' values were written at the decision. Never quote a \`true\` without checking a sibling reads \`false\`. ⚠️ To close the loop, join the cell's tape age under its OWN key — \`cellKey\` is exactly \`structure::bucket\`, so \`arm.costBar.edge.cellsByStructure[].cells[].tapeWindow\` is a direct lookup. A bound that held still for weeks over a tape that has not grown for weeks is the self-sealing loop; a bound that held still over a tape still accruing is an ordinary quiet cell. Measured 2026-09-20: the three cells reading \`true\` sit on tapes 46.8 / 48.0 / 57.8 days old, and the ONE reading \`false\` is the ONE whose tape is still growing (17.7 days). ⚠️ STRICTLY ADDITIVE TELEMETRY — TRA-4753 changed no parameter, no arm and no behaviour; nothing on the admission path reads any of it.`,
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
    // TRA-4001 — the read instant is passed in so "is today's row due yet" is decided
    // against the same clock the response is stamped with.
    const summary = summarizeLiveNavTripwire(45, undefined, nowMs);
    // TRA-4001 — the observation-window suffix every coverage-bearing note carries, so a
    // reader can see the denominator's edges without opening `coverage`.
    const windowSuffix = `Observing since ${summary.observation?.startEtDay ?? 'UNKNOWN'} (${summary.observation?.source ?? 'no marker'}); ${summary.coverage.marketDaysPending.length} pending (not yet due), ${summary.coverage.marketDaysNotMeasured.length} NOT MEASURED (pre-observation) of ${summary.coverage.marketDaysInWindow} calendar session(s).`;
    res.json({
      ok: true,
      time: new Date(nowMs).toISOString(),
      build: resolveBuildInfo(),
      etDay: etDateString(new Date(nowMs)),
      ...summary,
      note:
        summary.driver?.reason === 'no_observation_start'
          ? `NOT MEASURED — no observation-start marker and no row: the ledger has no denominator, so coverage cannot be reported. Not a clean bill of health. ${windowSuffix} See TRA-4001.`
          : summary.verdict === null
            ? summary.coverage.marketDaysInWindow === 0
              ? 'BLIND — no NYSE session in the window. Not a clean bill of health.'
              : `NOT MEASURED — no session has fallen DUE since observation started. Not a clean bill of health and not a failure. ${windowSuffix} See TRA-4001.`
            : summary.verdict === 'fail'
              ? `FAIL — live-money NAV tripwire fired. Last fail ${summary.lastFailDay}. See byDay[].axes and lagBooks.`
              : summary.consecutiveMissingSessions > 0
                ? `WRITER DOWN — ${summary.consecutiveMissingSessions} consecutive DUE session(s) with no assertion row. Realized coverage ${summary.coverage.marketDaysRecorded}/${summary.coverage.marketDaysExpected} over due sessions since observation start. This is the TRA-3449 failure mode itself, one layer down. ${windowSuffix}`
                : summary.verdict === 'blind'
                  ? `BLIND — graded, not clean. ${summary.coverage.marketDaysMissing.length} missing DUE session(s); latest ungraded books: ${
                      (summary.latest?.ungradedBooks ?? []).map((b) => `${b.username}=${b.reason}`).join(', ') || 'none'
                    }. ${windowSuffix}`
                  : summary.verdict === 'vacuous'
                    ? `VACUOUS — the tripwire RAN and had NOTHING to grade. ${summary.vacuity.consecutiveVacuousSessions} consecutive graded session(s) with a ZERO post-onset trip-capable denominator; ${summary.vacuity.sessionsWithTripCapableEvidence}/${summary.coverage.marketDaysRecorded} recorded session(s) carried any evidence. Books at zero: ${
                        summary.vacuity.vacuousBooks.map((b) => `${b.username}=${b.reason}`).join(', ') || 'none'
                      }. This is NOT a pass — see TRA-3450. ${windowSuffix}`
                    : `CLEAN — every DUE NYSE session since observation start has a graded, passing row over a NON-EMPTY post-onset trip-capable denominator (${summary.coverage.marketDaysRecorded}/${summary.coverage.marketDaysExpected}). ${windowSuffix}${
                      // TRA-3952 — a clean that was graded over a SCOPED cohort says so, by name.
                      (summary.vacuity.latestScope?.excludedNoOnset.length ?? 0) > 0
                        ? ` Outside the lagDenominator gate (no live-options onset, no options P&L): ${summary.vacuity.latestScope!.excludedNoOnset.join(', ')} — see vacuity.latestScope (TRA-3952).`
                        : ''
                    }`,
      /**
       * TRA-3711 — `note` narrates the VERDICT lattice, which is dominated by the WORST
       * axis. `signalNote` narrates the two CHANNELS, which is the reading a consumer
       * actually has to make: `alarm` means an assertion TRIPPED, `degraded` means we could
       * not grade. Both are published because the verdict alone cannot say which of the two
       * it means — and a `blind` verdict off a structurally ungradeable live book (`v0nni`,
       * `no_eligible_dates`, no live-options onset) was pinning the trip signal ON for every
       * session, on an endpoint where every assertion axis was passing.
       */
      signalNote: summary.alarm
        ? `TRIP — an assertion FAILED (driver ${summary.driver?.axis}=${summary.driver?.status}, ${summary.driver?.reason ?? 'no reason'}). ${summary.signalClasses.sessionsTrip}/${summary.coverage.marketDaysExpected} session(s) tripped. This is the real-money signal; act on it.`
        : summary.degraded
          ? `DEGRADED, NOT TRIPPED — 0/${summary.coverage.marketDaysExpected} session(s) tripped an assertion; ${summary.signalClasses.sessionsDegradedOnly} could not be graded (driver ${summary.driver?.axis}=${summary.driver?.status}, ${summary.driver?.reason ?? 'no reason'}). alarm=false is CORRECT here and is NOT an all-clear: the instrument has a hole, nothing has fired. Bind a coverage monitor to \`degraded\`/\`attention\`, never to \`alarm\`. See TRA-3711.`
          : `OK — 0 trips and 0 degraded sessions across ${summary.coverage.marketDaysExpected} session(s).`,
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
  //     `vacuous` = empty live cohort that day. `in_flight` = the day is NOT
  //     SETTLED, which is NOT a failure and has two causes that `inFlightReason`
  //     names: the session is open (the CURRENT day always reads that way at the
  //     21:15 ET fire, because the ~23:45 ET EOD drain has not landed and the day
  //     is graded against an RTH window it has not lived through yet), or the day
  //     has not started at all (pre-open there is no file to read, and calling
  //     that `vacuous` asserted "no tape was written for this market day" about a
  //     session hours before its bell).
  //     `barDaysWithLiveAbsence > 0` does not stop the count but does block
  //     promotion until the absence is explained. It counts SETTLED days only —
  //     pre-open every live book is trivially absent. Those are published
  //     separately as `barDaysWithLiveAbsenceInFlight` (deferred, not dropped).
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
              : `${summary.sessionsTowardBar}/${summary.barTarget} toward the bar, UNIT = ${summary.barUnit} (TRA-3494: distinct ET market days on the LIVE-MONEY books, NOT book-days — the pooled book-day count is ${summary.completeBookSessions} and gates nothing). DAY LEDGER: ${summary.sessionsTowardBar} counted / ${summary.barDaysFailed} failed / ${summary.barDaysVacuous} vacuous (empty live cohort — neither a credit nor a failure) / ${summary.barDaysInFlight} in-flight (session still OPEN, no EOD drain yet — NOT a failure; the current day reads this way at every 21:15 ET fire by construction)${summary.barDaysWithLiveAbsence > 0 ? `; ${summary.barDaysWithLiveAbsence} SETTLED day(s) with a live book ABSENT — these do NOT reduce the count but DO block promotion until explained` : ''}${summary.barDaysWithLiveAbsenceInFlight > 0 ? `; ${summary.barDaysWithLiveAbsenceInFlight} further day(s) hold a live absence that is NOT YET REAL (the day has not settled — pre-open every book is trivially "absent"), DEFERRED to tomorrow's read rather than dropped` : ''}${summary.unclassifiedModes.length > 0 ? `; ⚠ UNCLASSIFIED MODE(S) ${summary.unclassifiedModes.join(', ')} — the live cohort may be under-read` : ''}. Rejected quorums, published so this cannot be cherry-picked: any-book ${summary.barDaysAnyBook}, all-books ${summary.barDaysAllBooks}. TRIPLE: ${summary.complete} complete / ${summary.partial} partial / ${summary.absent} absent BOOK-DAY sessions. A session counts ONLY with coverageComplete && !saturated && truncatedForSize===0 && droppedOnMerge===0; rows.length===0 under complete coverage COUNTS. Partial sessions are retained and annotated, never excluded.`,
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

  // TRA-4628 (parent TRA-4621, ruling TRA-4623) — the OTM candidate-ADMISSION
  // tape: admitted AND refused `single_leg_otm` scanner candidates with the
  // FIRST binding gate (`min_mark` / `max_spread_pct` / `min_open_interest` /
  // `min_abs_delta` / …/ `none`), split by accountClass (classes NEVER pooled —
  // TRA-3715/TRA-3682/TRA-3709). This is the denominator the pre-registered
  // minMark rule actually names; the journal population downstream of the
  // ranker + capital gate is a survivorship statistic (the TRA-4623 ruling).
  //
  // `mark`/`spreadPct` on every row use the scanner's (bid+ask)/2 mid — the
  // TRA-1656 entry-stamp convention — so the tape's axes match the journal's.
  //
  // Query: `?day=YYYY-MM-DD&class=desk&rows=5000` streams raw rows (capped);
  // omit `rows` for the summary alone. Row fields are OPTIONAL on the read
  // side: a row written by an older build genuinely lacks newer fields.
  //
  // Observe-only: the trading path never reads this tape, and serving it never
  // routes an order or moves a parameter.
  app.get('/api/health/otm-admission-tape', async (req, res) => {
    const nowMs = now();
    try {
      const summary = summarizeOtmAdmissionTape();
      const wantRows = typeof req.query.rows === 'string' && req.query.rows !== '';
      let rows: Awaited<ReturnType<typeof readOtmAdmissionTapeRows>> | undefined;
      if (wantRows) {
        const limitRaw = Number(req.query.rows);
        rows = await readOtmAdmissionTapeRows({
          ...(typeof req.query.day === 'string' && req.query.day !== '' ? { etDay: req.query.day } : {}),
          ...(typeof req.query.class === 'string' && req.query.class !== ''
            ? { accountClass: req.query.class }
            : {}),
          ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
        });
      }
      res.json({
        ok: true,
        issue: 'TRA-4628',
        time: new Date(nowMs).toISOString(),
        build: resolveBuildInfo(),
        etDay: etDateString(new Date(nowMs)),
        ...summary,
        ...(rows !== undefined ? { rows: rows.rows, rowsTruncated: rows.truncated } : {}),
        note: `${summary.deskSessionsWithAdmissions}/20 desk-class ET sessions with >=1 ADMITTED candidate toward the TRA-4623 AC4 re-run bar. bindingReason = FIRST binding gate in engine evaluation order ('none' = admitted). Only sampling-policy-v2 days count; v1 rows (no samplingPolicy, 2026-09-17..18) exhausted a first-come daily budget in the opening minutes and are open-biased (legacySessions/legacyRows) - exclude them from any readout. v2 sampling is pass-level and independent of mark, spreadPct and time-of-day by construction (see policy); days[].rowsBySlotEt is the time-coverage check. An evidence archive has no backfill: the tape starts at the deploy that armed it. durability.appendErrors > 0 means rows were counted in memory that never reached disk — treat the on-disk export as an undercount, not the counters as an overcount.`,
      });
    } catch (err: unknown) {
      // An instrument may not take the box down, and it may not report a read
      // failure as an absence of findings either.
      res.status(200).json({
        ok: false,
        issue: 'TRA-4628',
        time: new Date(nowMs).toISOString(),
        verdict: null,
        blindReason: err instanceof Error ? err.message : String(err),
        note: 'BLIND — the admission-tape summary could not be read. This is NOT a clean bill of health.',
      });
    }
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
    // TRA-4291 — shared with the option-journal modeled net-of-cross join, so
    // the two surfaces cannot disagree on where the bar sits. Same value (50)
    // this route has always emitted.
    const ACCEPTANCE_N = SPREAD_COST_ACCEPTANCE_N;
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
            'relative-value.ts:396, inside the RV scanner chain filter. Runs only when the RV_ENGINE_ENABLED env flag is armed (env-resolved since TRA-4385; compile-time false TRA-1207→TRA-4385) — see /api/health/rv-scan paths[path=rv_scan].enabled for the live answer. Even armed, the flip is demo evidence accrual only: the live entry stays dark behind ENABLE_OPTION_LIVE_RV_LONG, so no live sleeve is gated by this entry.',
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
      // TRA-4757 — the DURABLE half, spelled out because the fields above are all
      // instant cells or blind-inclusive and a once-a-day poller cannot tell that from
      // reading them. `observedNonBlindPassCount` is the only field here that a
      // position which opened and closed between two reads cannot slip past.
      observeDurabilityNote:
        'DURABILITY: observedPositionCount / openPositionCount / maxGainPctLastPass are LAST-PASS-ONLY instant cells (the pass runs ~2.2x/sec, so a position is invisible ~0.45s after it closes), and observePassCount increments on a BLIND pass too — none of the three can answer "was the book ever non-empty since I last looked". observedNonBlindPassCount is the DURABLE, monotonic all-time count of passes that saw >=1 position: it survives reboot via DATA_DIR alongside maxGainPctObserved, so one read per day is a strict SUPERSET of everything since your previous read and a sampling gap stops mattering. null on EVERY observedNonBlind*/observedEtDays* field means NOT ARMED (pre-TRA-4757 store, corrupt block, or no DATA_DIR) — do NOT read it as 0 and do NOT default it to 0. Armed, observedNonBlindArmedAt is stamped and a 0 is then a real measurement over [observedNonBlindArmedAt, now]: the book was genuinely never non-empty in that window. observedNonBlindPassCount and lastObservedNonBlindAt are LOWER BOUNDS (the durable rewrite is throttled to one per 60s, so a hard reboot can drop up to 60s of ticks) — but firstObservedNonBlindAt and the ET day fields flush immediately, so the 0 -> >=1 edge and every day rollover are exact and can never be lost. Day fields are ET (America/New_York), not UTC: the RTH session is 13:30-20:00Z and a UTC fold would split a late session across two day keys.',
      observeNote:
        'observedPositionCount is what the LAST pass actually iterated: null = no pass since boot (says nothing about the book), 0 = it ran and saw an EMPTY book (the alarm — trimCount can never increment), >0 = genuinely watching. maxGainPctObserved is the durable all-time high-water of the favorable excursion (null = never measured, NOT 0); size it against firstRungUp to see how close the ladder has come to firing. The ladder observes the demo EQUITY book only (PaperAccount.openPositions) — it does NOT read the options book, deliberately (TRA-1729: the rungs are underlying-price moves; option premium clears +25% routinely and TRA-1294 already banks profit on that book).',
    });
  });

  // TRA-1294 (parent TRA-1290, board confirmation `73ef18b0`) — unauthenticated,
  // secrets-free readout of whether the take-profit-early auto-close (the PROFIT-
  // side mirror of the give-back cap) is ARMED in this running process. We resolve
  // the demo flag through the SAME path the engine consults (process.env layered
  // with the DATA_DIR demo-flags.json overlay, file wins) so `enabled` reflects
  // the EFFECTIVE switch. No balances/PII — just the flags + capture threshold —
  // parity with the other /api/health/* rule readouts.
  //
  // TRA-4759 — `demoOnly`/`liveCapitalReachable` were HARDCODED `true`/`false`
  // here, which was the configuration's intent circa TRA-1294, not this process's
  // state: from 2026-09-20T13:47:23.779Z bqb1 runs with TAKE_PROFIT_EARLY_LIVE_
  // ENABLED=1 (TRA-2949 arm, board ruling TRA-4293) and the ENGINE chooses this
  // exit on real money — while this route kept saying "live options path
  // unchanged". Both fields are now COMPUTED off the same resolver the live exit
  // branch reads (`isTakeProfitEarlyLiveEnabled(process.env)` — live never reads
  // the demo-flags.json overlay, and the live flag alone arms the exit-risk
  // input: signal-engine `optionExitRisk = master || takeProfitEarlyArmed`).
  app.get('/api/health/take-profit-early', (_req, res) => {
    const dir = process.env.DATA_DIR;
    const env = dir ? resolveDemoFlagEnv(dir) : process.env;
    const enabled = isTakeProfitEarlyEnabled(env);
    const liveEnabled = isTakeProfitEarlyLiveEnabled(process.env);
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      flag: TAKE_PROFIT_EARLY_FLAG,
      enabled,
      liveFlag: TAKE_PROFIT_EARLY_LIVE_FLAG,
      liveEnabled,
      demoOnly: !liveEnabled,
      liveCapitalReachable: liveEnabled,
      config: { captureFrac: TAKE_PROFIT_EARLY_CAPTURE_PCT },
      note: liveEnabled
        ? 'ARMED (LIVE + demo): the engine banks an option position once it captures 60% of available profit — INCLUDING on the live book (TAKE_PROFIT_EARLY_LIVE_ENABLED, TRA-2949/TRA-4293). Fire forensics: takeProfitEarlyFire stamp + releaseForensics + strategyExits (TRA-4759).'
        : enabled
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
      // TRA-3682 — the OTHER half of that ambiguity, and the one that actually bit.
      // `evaluated: 0` is silent on this surface: `starving` is false, `admitRate` is
      // null, no warning fires, and the payload reads as an ordinary quiet session —
      // which is how `single_leg_rv` went 14 sessions with a dead upstream while this
      // route reported healthy. An UNFED gate is a finding about the PRODUCER, so say
      // so here and point the reader upstream rather than at the thresholds above.
      ...(enabled && counts.state === 'no_candidates'
        ? {
            warning: `entry-greeks gate evaluated 0 candidates on ${etDay} — it is UNFED, not passing. This says NOTHING about the band/ratio config above; the producer upstream of the gate is what to check (TRA-3682). Confirm the sleeve's scan path is armed at /api/health/rv-scan before grading it.`,
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
    // The demo book's env view — the same `dir ? resolveDemoFlagEnv(dir) :
    // process.env` the engine's private `resolveDemoFlagEnv()` returns.
    // TRA-4606 — `dir`, not `dataDir`. The TRA-4440 exemption in
    // scripts/check-data-dir.mjs covers exactly the `dir` report-read idiom at
    // count 11, and the rename to `dataDir` both dropped that count to 10
    // (STALE_EXEMPTION) and presented as an eleventh, UNEXEMPTED copy (NEW_COPY).
    // Same read, same blank-value behaviour; only the identifier moved.
    // ⛔ Do not spell the exempted line out in prose here — the scanner matches on
    // text, so quoting it verbatim in a comment counts as another copy.
    const dir = process.env.DATA_DIR;
    const demoEnv = dir ? resolveDemoFlagEnv(dir) : process.env;
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
      // TRA-4436 (parent TRA-4053) — the DEMO book's effective ma20 confirm
      // gate, beside the live one. This route used to publish `confirmBars: 2`
      // for the (dark) live arm and NOTHING for the demo path, which is where
      // 100% of evidence accrual happens — the demo book running an unguarded
      // single-bar ma20_close_through (32 of 77 directional ma20 exits closed
      // in <1 min, 23 at exactly R=0) was unreadable from any surface.
      // `ma20ConfirmBars` is derived from the SAME `buildRvExitParams` the
      // engine calls, over the same env view (process.env + demo-flags.json
      // overlay, file wins), so this readout cannot drift from the decision
      // site: 1 here IS the defect state, 2 is the guarded state.
      rvExitRetuneDemo: {
        flag: RV_EXIT_RETUNE_FLAG,
        enabled: isRvExitRetuneEnabled(demoEnv),
        ma20ConfirmBars: demoEffectiveMa20ConfirmBars(demoEnv),
      },
      // LIVE arm of the take-profit-early capture exit (demo cohort: 43/43
      // wins, avgR +1.03). Ships dark; the board arms it by env flip.
      takeProfitEarlyLive: {
        flag: TAKE_PROFIT_EARLY_LIVE_FLAG,
        enabled: tpEarlyLive,
      },
      // TRA-4510 (parent TRA-4293) — the TRA-4020 profit-floor ladder arm on
      // BOTH books. No route published it, so the TRA-4278 capability matrix
      // filed the ladder "demo-only" when signal-engine.ts resolves it on the
      // live book too (process.env) and TRA-4029's grade had to read the Render
      // env list to prove it absent on live. Each value is the engine's own
      // `isProfitFloorTrailEnabled` call over the engine's own env view (live =
      // process.env, demo = demo-flags overlay), so it cannot drift from the
      // decision site. `exitRiskMaster` says WHY an `enabled: false` is false —
      // the flag alone is inert while the master is off.
      profitFloorTrail: {
        flag: PROFIT_FLOOR_TRAIL_FLAG,
        requiresMaster: EXIT_RISK_RULES_FLAG,
        live: {
          enabled: isProfitFloorTrailEnabled(process.env),
          exitRiskMaster: isExitRiskRulesEnabled(process.env),
        },
        demo: {
          enabled: isProfitFloorTrailEnabled(demoEnv),
          exitRiskMaster: isExitRiskRulesEnabled(demoEnv),
        },
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
    const fleet = deps.fleetBooks?.() ?? [];
    const fills = summarizeSma200ForwardTestFills(demoModeBooks(fleet));
    // TRA-4457 — the sweep census, WHOLE FLEET (see `summarizeSma200Sweeps`).
    // `fills` above is demo-only because a forward-test fill is demo-only by
    // construction; a SWEEP is not, so the two folds take different populations
    // off the same `fleet` read deliberately.
    const sweep = summarizeSma200Sweeps(fleet, now());
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
      /**
       * TRA-4457 — read `sweep.verdict` BEFORE reading `fillCount: 0` or an
       * empty signal feed as a quiet market. `BLIND` / `PARTIAL_BLIND` /
       * `NO_SWEEP_YET` mean the scan could not look, and a zero under any of
       * them is not evidence about the market. `unpublished > 0` means this
       * build predates the census and nothing here is a reading at all.
       */
      sweep,
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

    // TRA-3715 — the UPPER bounds. Same fail-closed epoch-ms contract as their
    // lower-bound siblings: a window that cannot be applied must never return a
    // body indistinguishable from one that selects everything.
    const untilParse = parseCohortTsParam(req.query['untilTs'], 'untilTs');
    const closedUntilRaw = req.query['closedUntilTs'] ?? req.query['closeUntilTs'];
    const closedUntilName =
      req.query['closedUntilTs'] !== undefined ? 'closedUntilTs' : 'closeUntilTs';
    const closedUntilParse = parseCohortTsParam(closedUntilRaw, closedUntilName);
    // TRA-3715 — the ET SESSION DAY window, which is how every grade this
    // journal is asked for is actually written. Resolves onto the exit axis.
    const etDayParse = parseEtDayCloseWindow(req.query['sinceEtDay'], req.query['untilEtDay']);
    for (const parse of [untilParse, closedUntilParse, etDayParse] as const) {
      if (parse.ok) continue;
      res.status(400).json({
        ok: false,
        error: parse.error,
        detail: parse.detail,
        filterApplied: false,
        note:
          'The cohort filter could not be applied, so no body is served. A filter that '
          + 'cannot be applied must not return a payload indistinguishable from one that '
          + 'selects everything (TRA-3380).',
      });
      return;
    }
    const untilTs = untilParse.ok ? untilParse.value : undefined;
    const closedUntilTs = closedUntilParse.ok ? closedUntilParse.value : undefined;
    const etDayWindow = etDayParse.ok ? etDayParse.window : null;

    // One axis per response. Serving both would make `filterAxis` — the field a
    // consumer reads to learn WHICH population it got — unable to answer.
    // TRA-3715 — the ET-day window and `closedUntilTs` are EXIT-axis members
    // too, so they conflict with the entry axis on the same rule.
    const entryAxisUsed = sinceTs !== undefined || untilTs !== undefined;
    const exitAxisUsed =
      closedSinceTs !== undefined || closedUntilTs !== undefined || etDayWindow !== null;
    if (entryAxisUsed && exitAxisUsed) {
      res.status(400).json({
        ok: false,
        error: 'cohort_axis_conflict',
        detail:
          'Pass EITHER the ENTRY axis (`sinceTs` / `untilTs`, on openTs) OR the EXIT axis '
          + '(`closedSinceTs`/`closeTs`, `closedUntilTs`/`closeUntilTs`, `sinceEtDay` + '
          + '`untilEtDay`, on closeTs) — not both. `filterAxis` and `window.axis` name the '
          + 'single axis that served the response.',
        filterApplied: false,
      });
      return;
    }
    // Two spellings of the same exit bound would leave `window.fromMs`/`toMs`
    // reporting one of them with nothing on the wire saying which lost.
    if (etDayWindow !== null && (closedSinceTs !== undefined || closedUntilTs !== undefined)) {
      res.status(400).json({
        ok: false,
        error: 'cohort_window_conflict',
        detail:
          'Pass EITHER the ET session-day window (`sinceEtDay` + `untilEtDay`) OR the epoch-ms '
          + 'exit bounds (`closedSinceTs` / `closedUntilTs`) — not both. They are two spellings '
          + 'of the same axis and only one can be reported in `window`.',
        filterApplied: false,
      });
      return;
    }
    if (
      sinceTs !== undefined
      && untilTs !== undefined
      && untilTs < sinceTs
    ) {
      res.status(400).json({
        ok: false,
        error: 'cohort_window_inverted',
        detail: `\`untilTs\` (${untilTs}) is before \`sinceTs\` (${sinceTs}).`,
        filterApplied: false,
      });
      return;
    }
    if (
      closedSinceTs !== undefined
      && closedUntilTs !== undefined
      && closedUntilTs < closedSinceTs
    ) {
      res.status(400).json({
        ok: false,
        error: 'cohort_window_inverted',
        detail: `\`closedUntilTs\` (${closedUntilTs}) is before \`closedSinceTs\` (${closedSinceTs}).`,
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
    // TRA-3472 — `voids` is NOT part of the report fold and must not be: the
    // report is a fold over SURVIVING rows, and a retracted row is by
    // construction absent from it. Reading the witness off the journal module
    // directly is the only way to see the retractions at all. It is deliberately
    // OUTSIDE the `?sinceTs` cohort filter too — the filter selects rows, and
    // these are the rows that no longer exist.
    const voids = getOptionTradeVoids();
    // TRA-2819 — outside the `?sinceTs` cohort filter for the same reason
    // `voids` is: the filter selects rows, and this describes CORRECTIONS made
    // to rows. Read `closeBasisAmends.netDeltaUsd` — a restatement moves a
    // number in place, so the journal after a successful pass and the journal
    // after a pass that never ran hold the same rows and the same row count.
    // This is the only field that tells them apart, and `applied` vs `refused`
    // is what says whether the fold accepted them.
    const closeBasisAmends = getOptionTradeCloseBasisAmends();
    res.json({
      ...buildOptionJournalReport(
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
        // TRA-3715 — the upper bounds + the ET session-day window.
        { untilTs, closedUntilTs, etDayWindow },
      ),
      voids,
      closeBasisAmends,
      // TRA-4004 — the third correction witness. A row's CLOSE was replaced
      // because the position it describes closed for real AFTER a
      // reconstruction had already closed the row with another lot's exit
      // (the 2026-08-24 BAC −$3.00 that vanished at the archive edge). Read
      // `applied` for supersessions that landed; `refused` with
      // `refusal: 'same_close'` is the duplicate close event the guard drops
      // and is the healthy quiet state; `refusal: 'row_open'` is a finding.
      closeSupersedes: getOptionTradeCloseSupersedes(),
      // TRA-4028 — the fourth correction witness: a row's ENTRY BASIS was
      // restated from the broker blend a reconcile import copied to the lot's
      // own ledger fill (the 08-21 BAC `6bbc5d17`, $141 → $117). Read
      // `applied`; a `refused: unchanged` is an idempotent re-POST, and a
      // `refused: unknown_row` is a finding. Per-row, `rows[].atRiskBasis`
      // says which instrument priced every import row minted since this cut.
      openBasisAmends: getOptionTradeOpenBasisAmends(),
      // TRA-4609 — the fifth correction witness, and the only ENGINE-written
      // one: a conviction-DCA (TRA-964) scale-in GREW an OPEN row's
      // `contracts`/`atRiskUsd` so its eventual R divides an all-lots P&L by
      // all-lots capital. Before this the add moved the book and nothing else,
      // and premium R came out overstated by `totalContracts / mintContracts`
      // (measured 8/12 closed rows, 2x on seven, pin `f8f7b1855da0`).
      //
      // ⚠️ Read `refused`: every refusal is a row still publishing the frozen
      // minted basis, and the row itself cannot say so. Per-row, the durable
      // statement is `rows[].convictionAdds` (absent = no add was folded) and
      // `rows[].contractsAtClose`. ⛔ Neither is backfilled, so absence on a
      // row closed before this cut is UNKNOWN, not "never added".
      convictionAdds: getOptionTradeConvictionAdds(),
      // TRA-4453 — the self-driving re-grade of `atRiskBasis: 'mark'` import
      // rows against the ledger AFTER each `history_import` backfill. Read
      // `lastRows[].verdict`: `promote` is applied as a LABEL-only amend (see
      // `openBasisAmends.recent[].labelOnly`), `disagree` is a finding left for
      // a witness, `ticks: 0` means the pass never ran.
      openBasisRegrade: getOpenBasisRegradeState(),
      // TRA-3547 — the zombie alarm, unauthenticated like the rest of this
      // route. A live `OPEN` row the broker tape says is NOT open sat silently
      // for 10 days because nothing published the contradiction; `summary` alone
      // cannot show it, since the journal is internally consistent — the defect
      // is only visible AGAINST the fill ledger.
      //
      // Read `zombieOpenRows.count`: `null` = never checked (the pass has not
      // ticked, or the journal flag is off), `0` = checked and clean. Those are
      // different facts and this shape refuses to collapse them.
      zombieSweep: getZombieOpenSweepState(),
      expiredDemoOrphanSweep: getExpiredDemoOrphanSweepState(),
      // TRA-3730 — the SELF-DRIVING half of the close-basis restatement, and the
      // only thing that separates "the journal agrees with the broker" from "the
      // pass that would have checked never ran". `closeBasisAmends` above is a
      // witness to WRITES; it reads identically on a healthy book and on a box
      // where the sweep is not wired, because both wrote nothing.
      //
      // Read `restatableRows.count`: `null` = never checked (no tick yet, or the
      // journal flag is off), `0` = checked and every closed live row is on
      // broker truth. `feesPendingRows.count` is the backlog waiting on
      // settlement — a NON-zero there is the correct quiet state, not a fault:
      // `fees: null` means UNMEASURED, not free (TRA-1707), so the pass skips
      // those rows and picks them up on a later tick rather than publishing a
      // gross number wearing a broker-settled label.
      closeBasisSweep: getCloseBasisSweepState(),
    });
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
    // MEASURED taker cross (TRA-1656). Union-not-intersection, and every
    // failure-to-grade mode is named rather than filtered away — see
    // `buildRecoveryVerdicts`, which owns the rule and carries the control.
    const verdicts = buildRecoveryVerdicts(stats);

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

    // TRA-4255 — the DURABLE cost-aware bar ledger, folded across its whole
    // retained window, so each path can publish whether its candidates can reach
    // an open AT ALL. `scanning` is a statement about the loop turning and sits
    // upstream of every admission gate: the directional sleeve published
    // `scanning` + a full universe sweep for 19 days while clearing 0 of 17,727
    // candidates at the bar. This read is what makes that legible HERE, on the
    // liveness route someone actually opens, instead of only on
    // /api/health/cost-aware-gate where you have to already suspect it.
    //
    // Retained (not since-boot) on purpose: this box reboots daily and the
    // sleeve's silence is 19 days long, so a since-boot fold could not see it.
    // Wrapped because an unreadable ledger must yield `unmeasured`, never a
    // fabricated zero that would read as a confident accusation.
    let costAwareLedger: RvScanAdmissibilityLedgerRead | null = null;
    try {
      const retained = summarizeCostAwareGate(etDateString(new Date(now()))).retained;
      costAwareLedger = { etDays: retained.etDays, byStructure: retained.byStructure };
    } catch {
      costAwareLedger = null;
    }

    const paths = [
      // Instrumented: the demo directional pass. This is the one that actually
      // fed what WAS the `single_leg_rv` bucket (now `single_leg_directional` since
      // TRA-2245), so it is the one whose silence had to become readable.
      summarizeRvScanPath('directional', {
        enabled: directionalEnabled,
        instrumented: true,
        costAwareLedger,
      }),
      // Instrumented. Held shut by the compile-time TRA-1207 kill switch until
      // TRA-4385 env-resolved it (RV_ENGINE_ENABLED, default OFF) — wired so
      // that re-arming it is self-evidencing on the first tick.
      summarizeRvScanPath('rv_scan', {
        enabled: isRvEngineEnabled(),
        instrumented: true,
        costAwareLedger,
      }),
      // TRA-3557 — the OTM sleeve, and the one that needed this most: it is the path
      // under live-money acceptance and was the only option entry path with no scan
      // run at all. Its `continue` on an empty/failed chain sits UPSTREAM of the
      // nominator, of `recordLiveEnforceDecision` and of the universe gate, so a
      // starve there produced `cost_bar.evaluated: 0` — bit-identical to "pre-open"
      // and to "scanned all names, found nothing".
      //
      // `enabled`: this path carries NO feature flag. It runs in both demo and live
      // whenever the chain scanner is wired, so the one thing that can disarm it is
      // `runOtmScan`'s own first line (`if (!this.rvScanner) return null`), which is
      // exactly what `rvScannerConfigured` reports — resolve it from there and
      // nowhere else. A null (pipeline dep absent from this process) is NOT read as
      // disarmed: "we cannot see it from here" is not "it is off", and `lastScanAt`
      // carries the real answer either way.
      //
      // ⚠️ This path being armed by default MOVES the roll-up below: on a box with
      // `directional` and `rv_scan` both disarmed, top-level `enabled` goes false →
      // true and `verdict` goes `disarmed` → `scanning`. That is a CORRECTION, not a
      // regression — the OTM pass has been running every tick the whole time and the
      // roll-up simply could not see it. Grade per-path, not on the roll-up.
      summarizeRvScanPath('otm', {
        enabled: chainConfigured !== false,
        instrumented: true,
        costAwareLedger,
      }),
      // NOT instrumented this iteration. Reports null counters rather than zeros —
      // see the null discipline above.
      summarizeRvScanPath('iv_rv_buy_premium', {
        enabled: ivRvRoutingEnabled,
        instrumented: false,
        costAwareLedger,
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
    //
    // ⚠️ TRA-3557 — READ THE PER-PATH `verdict`, NOT THIS ONE. This roll-up is an
    // ANY/ALL fold, so `disarmed` requires EVERY instrumented path to be off. Since
    // `otm` joined the set that can no longer happen on a box with a wired chain
    // scanner — the OTM sleeve carries no feature flag — so the aggregate is
    // structurally incapable of reporting `disarmed` and cannot testify about the
    // 2026-07-22 wiped-flag state it was built for. It is retained because it is
    // still TRUE (some path is armed), but the discriminator now lives on
    // `paths[].verdict`, where a disarmed `directional` still reads `disarmed`
    // regardless of what the OTM sleeve is doing.
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
      //
      // ⚠️ TRA-4359 — SCOPE. Every one of these words is about the DIRECTIONAL pass
      // and only it. `recordDirectionalArm` has exactly ONE call site — the
      // `directionalDemoOn || directionalLiveOn` gate in signal-engine — so the live
      // OTM sleeve, which has its OWN arm (`isOptionLiveOtmArmed`) checked at its own
      // order site, writes NO cell here and is invisible on this axis. `reachable`
      // therefore answers "could the DIRECTIONAL pass reach this book", NOT "could
      // this book open a position". Do not read a `live_arm_off` desk cell as the
      // live entry path being shut: see `armNote`.
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
        + 'on those, never on an exact tick count. '
        // TRA-4359 — QuantTrader read "could the pass REACH this book" as "could this
        // book open a position", cited an 18/18 `live_arm_off` desk run as proof the
        // live entry path was structurally unreachable, and was about to re-point an
        // acceptance cohort on it. 14 live OTM opens had landed inside that same run.
        // The note has to carry its own scope or the next reader repeats it.
        + '⚠️ SCOPE — this axis is DIRECTIONAL-ONLY. `recordDirectionalArm` has exactly '
        + 'ONE call site (the `directional` entry gate in signal-engine), so `reachable` '
        + 'means "could the DIRECTIONAL pass reach this book", NOT "could this book open '
        + 'a position". The live OTM sleeve is a SEPARATE entry path with a SEPARATE arm '
        + '(`isOptionLiveOtmArmed` = ENABLE_OPTION_LIVE_OTM AND the OPTION_LIVE_TEST_UNTIL '
        + 'window) and writes NO cell here. A `desk`/`live` cell reading `live_arm_off` / '
        + '`reachable: false` is therefore FULLY CONSISTENT with live option opens on that '
        + 'same ET day, and 14 of them landed on days that read exactly that (2026-08-17 '
        + 'through 2026-08-28). Never cite this axis for whether real money could enter. '
        + 'For that read `arm.otmArmed` / `arm.directionalArmed` on '
        + '/api/health/options-live (point-in-time, both sleeves), and gate `entry_window` '
        + 'under `retained.byGate[].byEtDay[]` on /api/health/live-enforce-gates, which is '
        + 'the per-ET-day (30d, on-disk) record of whether the live OTM entry gate ADMITTED '
        + 'anything — `blockRate` 0.5733 on 2026-08-28 (390 admitted) vs 1 on 2026-09-03 '
        + '(none), the discrimination this axis cannot make.',
      armRetentionDays: 30,

      // ── TRA-4350 — the RETAINED per-ET-day scan census ────────────────────
      //
      // `armByEtDay` above answers "could the DIRECTIONAL pass REACH this book"
      // (TRA-4359 — that scope qualifier is load-bearing). This answers
      // the next question down, which nothing on the box could answer before:
      // "and what did it DECIDE". The option journal held zero opens in either
      // book from 2026-09-01T19:08:14Z to the 09-04 filing, and all three causes
      // rendered as that same zero — ran-and-declined, never-ran, and
      // passed-but-never-journalled. `paths[].lastScan` carries exactly the right
      // columns but holds ONE cycle, and `scanCountSinceBoot` is a since-boot
      // latch on a box the watchdog self-restarts 6–12 times a session
      // (TRA-4158), so by the time anyone reads this route the evidence is gone.
      //
      // Reading it: `state` is the discriminator. `ran_and_declined` +
      // `rejectionsByGate` names the gate that consumed the candidates;
      // `passed_but_no_open` is the journal-side failure and must never be pooled
      // with a drought; `ran_unfed` means the loop turned over an empty universe,
      // so the cause is upstream of every gate on this path. An ABSENT cell is
      // the absence of a reading — not a zero, and not `ran_unfed`.
      censusByEtDay: summarizeRvScanCensus(),
      censusNote:
        'TRA-4350. The retained twin of `paths[].lastScan`, which holds ONE cycle and is '
        + 'wiped by every restart. Keyed by (ET day × path × accountClass × mode), summed '
        + 'across boots, retained on disk 30d. `state` separates the three readings that '
        + 'were previously the same zero: `ran_and_declined` (a drought — '
        + '`rejectionsByGate` names which gate), `passed_but_no_open` (candidates cleared '
        + 'and no open reached the journal — a WRITER fault, never a drought), `ran_unfed` '
        + '(the loop turned over an empty universe, so look upstream of this path) and '
        + '`ran_and_opened`. An ABSENT (etDay, path, accountClass) cell means no book of '
        + 'that class completed a pass — that is the absence of a reading, NOT a zero; '
        + 'read it against `armByEtDay` to tell an unreachable pass from an idle one. '
        + '`scans`/`candidatesEvaluated` are LOWER BOUNDS (5-min flush throttle, and the '
        + 'watchdog kills this process mid-otm-scan routinely); `opensPlaced` is flushed '
        + 'on sight precisely so a session that TRADED can never read back as a drought. '
        + 'Books are attributed by class because ~63 QA fixture books share this process '
        + 'with the desk (TRA-2355) — a non-zero `fixture` cell says nothing about `desk`. '
        + 'TRA-4357: `blindScans` counts the passes that rejected their ENTIRE non-empty '
        + 'universe on a SINGLE gate, and `universeSum` retains what the sweeps were '
        + 'HANDED (divide by `scans` for the mean). Read `blindScans` as a RATIO against '
        + '`scans` — it is the blind-vs-declining discriminator, and it is the only field '
        + 'here that survives the daily summing that pools those two: a day of blind '
        + 'cycles and a day of mixed strategy declines can carry the SAME dominant gate in '
        + '`rejectionsByGate`. `blindScans === scans` is the TRA-4357 condition itself. '
        + '⚠️ `blindScans`/`universeSum` are 0 on lines written before 2026-09-08, which '
        + 'means NOT MEASURED rather than "none" — check `etDay` before reading a zero as '
        + 'evidence. The counter is gate-AGNOSTIC on purpose: hard-coding `scan:no_spot` '
        + 'would make it blind to the next gate that saturates. '
        + 'TRA-4357 AC4: because it is gate-agnostic, `blindScans` pools a feed blackout '
        + '(`scan:no_spot` took the whole pass) with a policy refusal (`entry_window_closed` '
        + 'took it) — read `blindScansByGate` for which gate blinded each pass. '
        + '`blindRejectionsByGate` is the share of `rejectionsByGate` that came from blind '
        + 'passes; `rejectionsByGate[g] - blindRejectionsByGate[g]` is the ledger of the '
        + 'passes that actually ruled. Both maps are empty on lines written before '
        + '2026-09-10 (NOT MEASURED): if `sum(blindScansByGate) < blindScans` a contributing '
        + 'boot predates them and the subtraction is incomplete.',
      censusRetentionDays: 30,
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
      // TRA-4524 — process-wide yield gate counters (deferrals = resumes held
      // behind a spent run; maxHeldTurns = the round-robin wait, AC3).
      loopYieldGate: getLoopYieldGateSnapshot(),
    });
  });

  // TRA-4158 — WHICH container retains the RTH heap. `/api/health/watchdog`
  // above reports the level (`heapUsedMB 1605 / 1812` at the 2026-08-27 trip);
  // this reports the population, and the tape reports the population's SHAPE
  // across the session, which is the only read that separates "big" from
  // "growing and never released".
  //
  // Unauthenticated and secrets-free by the same rule as the watchdog probe:
  // the payload is container NAMES and integer COUNTS. Per-user identity is
  // deliberately NOT carried — 67 usernames on an open route is a tenant
  // disclosure and buys the measurement nothing, so the fold reports `owners`
  // and `maxEntries` instead (see `CensusSubject.klass`).
  //
  // `?deep=1` adds the O(entries) nested sum, which is what separates a
  // `Map<string, Candle[]>` gaining KEYS (universe drift) from the same map's
  // arrays getting longer (an append with no trim). It is off by default and
  // must stay off on any RTH poll: the sampled path has to remain cheap enough
  // to run on a live money-adjacent host mid-session.
  app.get('/api/health/heap-census', (req, res) => {
    const deep = req.query.deep === '1' || req.query.deep === 'true';
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      time: new Date(now()).toISOString(),
      build: resolveBuildInfo(),
      process: {
        heapUsedMB: Math.round((mem.heapUsed / 1048576) * 10) / 10,
        heapTotalMB: Math.round((mem.heapTotal / 1048576) * 10) / 10,
        rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
        externalMB: Math.round((mem.external / 1048576) * 10) / 10,
        arrayBuffersMB: Math.round((mem.arrayBuffers / 1048576) * 10) / 10,
      },
      census: getHeapCensusStatus({ deep }),
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
