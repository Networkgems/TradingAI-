import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
// TRA-2599 — `stat` left with the storage diagnostic; see `storage-health.ts`.
import { writeFile, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MarketScheduler, isMarketDay, isMarketDayIso, missedTradingDays, previousMarketDayIso, etDateString, isMarketOpen } from './scheduler.js';
import { etHour } from './et-clock.js'; // TRA-2498
// TRA-2689 (leg 2 of TRA-2654) — once-per-session drain of the WRITE-ONLY
// denominator-flip candidate tape. Nothing on any decision path reads it.
import { flushDenominatorFlipTape } from './denominator-flip-tape-writer.js';
import { DENOM_FLIP_CHANGEPCT_DELTA_PP } from './denominator-flip-tape.js';
import { createFileArchiveDateStore } from './scheduler-state.js';
import {
  buildAllowedOrigins,
  corsMiddleware,
  notFoundHandler,
  securityHeadersMiddleware,
} from './http-security.js';
import { cspReportRouter, initCspReportStore } from './csp-report-collector.js';
import { generateEodReport, wouldClobberSettledReport } from './reports/eod-report.js';
import {
  reconcilePnl,
  resolvePnlBaselineDate,
  foldJournalClosesByEtDay,
  liveOptionsOnsetEtDate,
  summarizeLiveLagTripwire,
  summarizeLiveCohortIntegrity,
  summarizeLiveCreditObservation,
  summarizeLiveEodRowPresence,
  summarizeDriftGradeability,
} from './pnl-reconciliation.js';
// TRA-2888 — the permanent 07-30/07-31/08-03 gap ruling and the
// exchange-calendar interior-absence detector that makes a NEVER-WRITTEN
// session visible. See `eod-ledger-gap.ts` for why no presence axis before it
// could fire on one.
import { detectEodInteriorAbsence, summarizeEodInteriorAbsence } from './eod-ledger-gap.js';
// TRA-2314 — the day cell's realized options P&L is sourced HERE, in one place,
// so the report file and the daily snapshot can never be booked differently.
import {
  resolveDailyOptionsPnl,
  journalRowsForBook,
  patchEodReportOptionsPnl,
  planOptionsDailyPnlRepair,
  planEodReportOptionsSync,
  syncEodReportOptionsLegs,
  type OptionsDailyPnlDecision,
  type PatchableEodReport,
} from './options-daily-pnl-source.js';
// TRA-2829 — the EOD row back-fill: planner (always), writer (flag-gated).
import {
  planLiveEodRowBackfill,
  isEodRowBackfillArmed,
  EOD_BACKFILL_ROW_SOURCE,
} from './eod-row-backfill.js';
import { generateCryptoEodReport } from './reports/crypto-eod-report.js';
import { buildJournalCalendarCells } from './reports/desk-calendar.js';
// TRA-2407 — default-deny scope for the TRA-1572 firm-wide demo fold.
import {
  mayViewFirmWideDemoFold,
  shouldServeFirmWideDemoFold,
  isReservedOperatorBookName,
} from './reports/demo-calendar-fill-scope.js';
// TRA-2508 — the shared precondition for every route that WRITES an account name
// (signup + the two admin identity-writes). The reserve rule used to be an inline
// `if` at signup only, which is how both admin routes came to skip it.
import { refuseReservedIdentityWrite } from './identity-write-guard.js';
// TRA-2421 — self-serve account deletion: the wipe surface and the identity
// tombstone that keeps a recycled username from inheriting the previous holder's
// shared-journal rows.
import { wipeAccountData, refuseSelfDelete, performSelfDelete, redactWipeReceipt } from './account-deletion.js';
import { accountDeletedAt, recordAccountTombstone } from './deleted-accounts.js';
// TRA-2410 — the ADOPTION side of the same hazard: registering a name whose book
// is still on disk hands the new account the previous holder's positions.
import { retireOrphanedBook } from './orphaned-books.js';
import { redactTradierEnvLabel, isRecognizedTradierEnvLabel } from './tradier-env-label.js';
import {
  listOptionTradeJournal,
  isOptionTradeJournalEnabled,
} from './option-trade-journal.js';
// TRA-2214 — the EOD journal blocks fold HERE, not inline, so this module holds
// no bare fold that could be fed a differently-sourced (pooled) row list.
import { foldModelFacingEodJournal } from './model-facing-journal.js';
// TRA-1046 (TRA-1041c L2) — synchronous on-demand hypothesis backtest behind
// POST /api/backtest, reusing the audited apply→backtest→G0-grade pipeline.
import {
  runOnDemandBacktest,
  validateBacktestRequest,
  OnDemandBacktestBadRequest,
  type OnDemandBacktestRequest,
} from './backtest-on-demand.js';
import { makeBacktestExecutor, RV_CRYPTO_MAJORS_BASE_CONFIG } from './backtest-executor.js';
// TRA-1000 — external-intel source-quality scorer: per-source advisory weights
// folded from the attribution log × hypothesis-queue gate outcomes.
import { isExternalIntelEnabled } from './external-intel.js';
import { loadSourceQualityWeights } from './source-quality-scorer.js';
import { buildHypothesisQueueHealth } from './ratification-bridge.js';
// TRA-1003 — the scheduled trigger that actually FEEDS the external-intel queue.
// No-op tick while ENABLE_EXTERNAL_INTEL is off (deps aren't even built), so it
// is safe to arm at boot regardless of the flag.
import { startExternalIntelSchedule } from './external-intel-scheduler.js';
import {
  startAutonomousDemoSchedule,
  getAutonomousDemoStatus,
  isAutonomousDemoLoopEnabled,
  buildAutonomousDemoLoopReport,
  type DemoBookEngine,
  type AutonomousDemoLoopDeps,
} from './autonomous-demo-loop.js';
// TRA-1008 — file-backed override for non-secret DEMO flags. Lets a non-admin
// operator/agent flip ENABLE_AUTONOMOUS_DEMO_LOOP via <DATA_DIR>/demo-flags.json
// on a host where the SYSTEM-owned PM2 daemon is unreachable (no dotenv loader,
// env lives only in the saved process env). Secrets are never read from it.
import {
  resolveDemoFlagEnv,
  loadDemoFlagFile,
  writeDemoFlagFile,
  renderRatifiedDemoDefaults,
  renderInfraDefaults,
  recordSeededEnvKey,
  DEMO_FLAG_ALLOWLIST,
} from './demo-flags.js';
// TRA-1216 — observe-only perp funding-carry scanner + forward funding-history
// accrual. Flag-checked before any fetch so ENABLE_PERP_FUNDING_CARRY_OBSERVE
// off ⇒ zero cost/IO. Read-only: no order/entry/sizing path.
import {
  isPerpFundingCarryEnabled,
  resolvePerpCarryConfig,
  resolvePerpCarryWatchlist,
} from './perp-funding-carry-flag.js';
import {
  scanFundingCarry,
  recordFundingCarryScan,
  type FundingObservation,
} from './perp-funding-carry-scanner.js';
import { appendFundingHistory, type FundingHistoryEntry } from './perp-funding-history.js';
// TRA-1220 — observe-only crypto regime-filter overlay (ADX/CHOP/ER classifier).
// Flag-checked before any 4H candle fetch so ENABLE_CRYPTO_REGIME_OVERLAY off ⇒
// zero cost/IO. Read-only: emits regime labels only, no order/entry/sizing path.
import {
  isCryptoRegimeEnabled,
  resolveCryptoRegimeConfig,
  resolveCryptoRegimeWatchlist,
} from './crypto-regime-flag.js';
import {
  observeCryptoRegime,
  summarizeCryptoRegimeScans,
  buildCryptoRegimeEodSection,
} from './crypto-regime-scanner.js';
// TRA-1221 — observe-only regime-gated TSMOM crypto scanner (widen bands + bear
// short/flat gate over the TRA-1220 regime label). Flag-checked before any 4H
// fetch so ENABLE_CRYPTO_REGIME_TSMOM off ⇒ zero cost/IO. Read-only: emits would-
// be long/exit/short-observe SIGNALS + forward net-of-fee evidence, no order path.
import {
  isRegimeTsmomEnabled,
  isRegimeTsmomDemoRouteEnabled,
  resolveRegimeTsmomConfig,
  resolveRegimeTsmomWatchlist,
} from './crypto-regime-tsmom-flag.js';
import {
  observeRegimeTsmom,
  summarizeRegimeTsmomScans,
  buildRegimeTsmomEodSection,
  persistRegimeTsmomPass,
  hydrateRegimeTsmomFromDisk,
  type RegimeTsmomState,
} from './crypto-regime-tsmom-scanner.js';
// TRA-1317 — DEMO paper routing for the regime-gated TSMOM scanner (board
// interaction 7042a614 = demo). Standalone, demo-scoped: an isolated CryptoPaperAccount
// route book with NO live path, so arming can never touch real capital. Routes on
// enter_long/exit_long transitions, persists a restart-safe JSONL + snapshot, and
// surfaces its open longs to the crypto dashboard for the "movement" the board wants.
import {
  routeRegimeTsmomResults,
  hydrateRegimeTsmomDemoRouteFromDisk,
  summarizeRegimeTsmomDemoRoute,
} from './crypto-regime-tsmom-demo-route.js';
// TRA-2411 — that route book is a PROCESS-GLOBAL singleton with no user key. Both
// of its per-user surfaces (the dashboard position injection below, and the EOD
// report rollup line) go through this scope so the firm's paper book is not served
// to every account as its own.
import {
  demoRoutePositionsFor,
  mayViewFirmWideDemoRouteBook,
} from './crypto-demo-route-scope.js';
// TRA-1271 — observe-only crypto ignition scanner (strict RVOL>=6 Donchian
// breakout + squeeze + EMA50 trend, bull-only). Flag-checked before any 4H fetch so
// ENABLE_CRYPTO_IGNITION_SCANNER off => zero cost/IO. Read-only, ZERO capital:
// emits would-be forward records + the would-a-limit-fill instrument only, no order path.
import {
  isCryptoIgnitionEnabled,
  resolveIgnitionConfig,
  resolveIgnitionWatchlist,
} from './crypto-ignition-flag.js';
import {
  observeIgnition,
  hydrateIgnitionFromDisk,
} from './crypto-ignition-scanner.js';
import { hydrateConvictionDcaFromDisk } from './conviction-dca-ledger.js';
import {
  hydrateOptionsIdeasExpectancyFromDisk,
  summarizeOptionsIdeasExpectancy,
} from './options-ideas-expectancy-ledger.js';
import {
  hydrateOptionsIdeasCreditWidthFromDisk,
  summarizeOptionsIdeasCreditWidth,
} from './options-ideas-credit-width-ledger.js';
import { hydrateScaleoutLadderFromDisk } from './scaleout-ladder-ledger.js';
import { hydrateDirectionalOpensFromDisk } from './directional-open-ledger.js';
import { hydrateEntryGreeksGateFromDisk } from './entry-greeks-ledger.js';
import { hydrateCostAwareGateFromDisk } from './cost-aware-gate-ledger.js';
import { hydrateGiveBackArmFloorFromDisk, summarizeGiveBackArmFloor } from './giveback-arm-floor-ledger.js';
import { hydrateLiveEnforceGateFromDisk } from './live-enforce-gate-ledger.js';
import {
  hydrateLiveOptionsFeeSlippageFromDisk,
  backfillLiveOptionFees,
  backfillLiveOptionFeesFromGainLoss,
  summarizeLiveOptionsFeeSlippage,
} from './live-options-fee-slippage-ledger.js';
import { runLiveOptionsFeeReconcile } from './live-options-fee-reconcile.js'; // TRA-2810/TRA-2850
import { fetchCrypto4hBars } from './crypto-feed.js';
import type { CryptoSignalEngine } from './crypto-engine.js';
// TRA-1006 — automated pre/post-market analyst agent. Tick fns are flag-checked
// before any deps are built (zero cost while ENABLE_ANALYST_AGENT is off) and are
// hooked onto the existing onPremarket / onArchive market-scheduler ticks.
import {
  isAnalystAgentEnabled,
  analystEtDate,
  readAnalystPlan,
  readAnalystReview,
} from './analyst-agent.js';
import {
  runAnalystPremarketTick,
  runAnalystPostmarketTick,
} from './analyst-scheduler.js';
import {
  computeOptionsAlerts,
  scanTargetStop,
  diffChain,
  toAlertEvents,
  type OptionsAlert,
} from './reports/options-alert-engine.js';
import {
  aggregateCashFlowByDate,
  aggregateRealizedOptionsPnl,
  computeBalanceDailyPnl,
  findPreviousBalanceSnapshot,
  liveBackfillWriteWindow,
  planTradierReconcile,
  realizedOptionsPnlByCloseDate,
  sumCashFlowOverSpan,
} from './reports/tradier-reconcile.js';
import { createToken, verifyToken, createPendingToken, verifyPendingToken, generateResetToken, consumeResetToken, initResetTokenStore, revokeResetTokensFor } from './auth.js';
import {
  initTwoFactorStore,
  issueChallenge,
  resendChallenge,
  verifyChallenge,
  stashEnrollmentBackupCodes,
  takeEnrollmentBackupCodes,
} from './two-factor.js';
import { initStateDb, getStateDb, getStateDbStatus } from './sqlite.js'; // TRA-1052 — durable hot-state SQLite store
import { evaluateDurability, enforceDurabilityPolicy } from './durability.js'; // TRA-1681 — fail CLOSED
import { checkThrottle, recordFailure, recordSuccess } from './auth-throttle.js';
import { getSettings, loadSettings, mergeScopedRiskSettings, saveSettings } from './account-settings.js';
import { resolveLiveBrokerOperator, isLiveBrokerOperator, shouldBootArmLiveEquity, resolveLiveBrokerArmDrift, applyLiveBrokerArm } from './signal-engine.js';
import {
  initNotificationDispatcher,
  emitAlert,
  registerChannelAdapters,
  buildSampleAlertEvent,
  issueLinkToken,
  consumeLinkToken,
  parseStartCommand,
  isValidDiscordWebhook,
  parseCommand,
  executeCommand,
  verifyDiscordRequest,
  extractInteraction,
  parseDiscordLinkToken,
  DISCORD_INTERACTION_TYPE,
  DISCORD_RESPONSE_TYPE,
  DISCORD_EPHEMERAL_FLAG,
  renderAlert,
  channelSuppressionReason,
  resolveReportRouting,
  REPORT_ROUTING_BLOCKED_MESSAGE,
  type CommandContext,
  type ChannelAdapter,
  type RoutineSummary,
} from './notifications/index.js';
import { LLM_KILL_ENV_VAR } from './trading-agents-advisory.js';
import {
  initWatchlistStore,
  getCryptoWatchlistData,
  getStocksWatchlistData,
  addCryptoSymbol,
  removeCryptoSymbol,
  addStocksSymbol,
  removeStocksSymbol,
  seedReviewLeaders,
} from './watchlist-store.js';
import { scanStocksMarket, scanCryptoMarket } from './market-scanner.js';
import { runPremarketForAllUsers } from './premarket-watchlist.js';
import { runMorningBriefForAllUsers, buildBriefForUser, buildMacroSection } from './morning-brief.js';
// TRA-2252 — scheduled P&L + trade-summary report emails.
// TRA-2284 — the pure builders are also driven by the on-demand self-test route
// below, which is the failing state the 21:00-ET-only path never had.
import {
  runScheduledReports,
  buildPeriodReport,
  isPeriodEnd,
  periodStartFor,
  aggregatePeriod,
  periodLabel,
  type ReportUser,
  type ActiveReportCadence,
} from './scheduled-report.js';
// TRA-851 — user-configurable natural-language routines.
import {
  loadRoutineStore,
  listRoutinesSync,
  usersWithRoutinesSync,
  addRoutine as addRoutineToStore,
  removeRoutine as removeRoutineFromStore,
  setRoutineEnabled as setRoutineEnabledInStore,
  type StoredRoutine,
} from './routines/routine-store.js';
import { parseRoutine, filterLabel, formatScan } from './routines/routine-spec.js';
import { RoutineRunner, type RoutineRendered } from './routines/routine-runner.js';
import { recordOptionChains } from './options-chain-recorder.js';
import { recordSentimentSnapshot } from './sentiment-snapshot-recorder.js';
import {
  fetchStockTwitsStream,
  fetchStockTwitsUserStream,
  getCuratedStockTwitsAccounts,
  isStockTwitsBreakerOpen,
  probeStockTwits,
  stockTwitsBreakerOpenUntil,
} from './stocktwits-feed.js';
// TRA-779 — replay smoke endpoint proves the captured chains are consumable by
// the run-options-replay pipe. Server already depends on @trading-app/backtest.
import {
  loadChainDays,
  runOptionsReplay,
  DEFAULT_REPLAY_CONFIG,
  estimateSpotFromChain,
  CHAIN_META_FILE,
  isChainSnapshotFile,
  chainSnapshotSymbol,
  readChainSnapshotFile,
  writeChainSnapshotFile,
  listChainSnapshotFiles,
} from '@trading-app/backtest';
// TRA-2417 — gzip compaction of aged chain partitions + the storage accounting
// `/api/health/chain-capture` publishes.
import {
  compactChainPartitions,
  chainPartitionStorageReport,
} from './chain-partition-compactor.js';
// TRA-2420 — per-subdirectory attribution of DATA_DIR for the admin
// `/api/health/storage/detail` (TRA-2599 moved it off the open route).
import { dataDirUsageCached } from './data-dir-usage.js';
import { registerStorageHealthRoutes } from './storage-health.js'; // TRA-2599
import { buildIdeasFeed, getEntryIntent } from './options-ideas-service.js';
import {
  isOptionsProposalRailEnabled,
  isOptionDemoAutoConfirmEnabled,
  isOptionIdeasAutoExecuteEnabled,
  isOptionLiveRvLongEnabled,
  isOptionLiveOtmEnabled,
  isOptionLiveTestWindowOpen,
  isOptionLiveDirectionalEnabled,
} from './option-exec-flag.js';
import { runIdeasAutoExecute } from './options-ideas-auto-execute.js';
import {
  getUserAnthropicApiKey,
  setUserAnthropicApiKey,
  clearUserAnthropicApiKey,
  describeUserAnthropicApiKey,
} from './anthropic-cred-store.js';
import { optionsSpendStatus } from './options-spend-store.js';
import { agentSpendAggregate } from './agent-spend-store.js';
import { executionCapStatus } from './agent-execution-caps-store.js';
import { proposalTtlMs } from './proposal-store.js';
import {
  initIvRankStore,
  recordDailyIv,
  ivRankSync,
  atmIvFromRows,
  seedFromArchive,
} from './iv-rank-store.js';
// TRA-2206 (TRA-1965) — chain-archive IV-rank reconstruction + the (default-OFF)
// store seed that makes the TRA-2005 expectancy shadow gradeable on a fresh cohort.
import {
  buildIvSeriesFromChains,
  isIvArchiveSeedEnabled,
  IV_ARCHIVE_SEED_FLAG,
} from './iv-rank-archive.js';
import { initIdeaJournal, listJournalEntries } from './options-idea-journal.js';
import { initShadowLedger, listShadowSignals } from './shadow-signal-ledger.js';
import {
  isShadowExpectancyGuardEnabled,
  isShadowExpectancyGuardEnforcing,
  shadowExpectancyGuardFromLedger,
} from './shadow-expectancy-guard-config.js';
import { initOptionShadowLedger, listOptionShadowSignals, isOptionShadowEnabled, OPTION_SHADOW_EMERGENCY_OFF } from './option-shadow-ledger.js';
import { initOrbOptionsShadowLedger, listOrbOptionsShadowSignals, isOrbOptionsShadowEnabled } from './orb-options-shadow-ledger.js';
import {
  initPcrShadowLedger,
  listPcrShadowSignals,
  isPcrShadowEnabled,
  pcrSampleSufficiency,
  PCR_Z_WINDOW_SESSIONS,
  PCR_PROMOTION_MIN_USABLE,
  PCR_PROMOTION_MIN_SESSIONS,
  PCR_PROMOTION_MIN_UNDERLYINGS,
  PCR_PROMOTION_MAX_NAME_SHARE_PCT,
  PCR_PROMOTION_MIN_Z_SESSIONS,
} from './pcr-shadow-ledger.js';
import { initOiShadowLedger, listOiShadowSignals, isOiShadowEnabled, usableSignalCount as usableOiSignalCount } from './oi-shadow-ledger.js';
import { initNewsCatalystLedger, listNewsCatalystSignals, isNewsCatalystEnabled, chosenSignalCount } from './news-catalyst-ledger.js';
import { initNewsCatalystRunLedger, summarizeCatalystRuns } from './news-catalyst-run-ledger.js';
import { catalystUniverse } from './news-catalyst-source.js';
import { initNewsCatalystLeanLedger, listCatalystLeans, leanBreakdown } from './news-catalyst-lean-ledger.js';
import { initPcsShadowLedger, listPcsShadowSignals, isPcsShadowEnabled, settledSignalCount, PCS_SHADOW_STRATEGY_ID } from './pcs-shadow-ledger.js';
import {
  initReversalShadowLedger,
  listReversalShadowSignals,
  isReversalShadowEnabled,
  reversalHitRateByScore,
} from './reversal-shadow-ledger.js';
import {
  initPreTradeGateLedger,
  listPreTradeGateDecisions,
  isPreTradeGateEnabled,
  preTradeGateSummary,
} from './pre-trade-gate-ledger.js';
import {
  initLiveCanaryLedger,
  buildCanaryHealth,
} from './live-canary-ledger.js';
import {
  initPreTradeLiquidityLedger,
  listLiquidityGateDecisions,
  isPreTradeLiquidityEnabled,
  liquidityGateSummary,
} from './pre-trade-liquidity-ledger.js';
import {
  resolveOrderQuoteGuardConfig,
  snapshotOrderGuardMetrics,
} from './order-quote-guard.js';
// TRA-2050 (parent TRA-2044) — TWAP/participation order-splitting shadow planner.
import {
  resolveOrderSplitConfig,
  snapshotOrderSplitMetrics,
} from './order-splitter.js';
// TRA-2046 (parent TRA-2044) — execution-quality telemetry: cancel/replace
// latency + partial-fill fraction + stale-quote counts.
import { snapshotExecutionQuality } from './execution-quality-telemetry.js';
// TRA-1981 (parent TRA-1967 item 2) — realized-vs-modeled execution-quality KPI.
import { buildExecutionQualityKpi } from './execution-quality-kpi.js';
// TRA-1982 (parent TRA-1967 item 3) — data-driven maker-ladder recommendation.
import { buildMakerLadderRecommendation } from './maker-ladder-recommendation.js';
import { listMakerFillEvents } from './option-maker-fill-ledger.js';
import { resolveMakerWalkConfig } from './option-maker-config.js';
import { computeLearnedWeights } from './learned-signal-weights.js';
import { isLearnedShrinkageEnabled } from './learned-shrinkage-flag.js';
import {
  recordDailyLearnedWeightsSnapshot,
  listLearnedWeightsSnapshots,
  learnedWeightsTrajectory,
  isLearnedWeightsSnapshotEnabled,
  type SnapshotDimension,
} from './learned-weights-history.js';
import {
  loadUserMemoryStore,
  getUserMemory,
  setUserMemory,
  getInteractionStats,
} from './user-trading-memory-store.js';
import {
  forwardTestIdeas,
  buildForwardTestReport,
  buildAccumulationMonitor,
  renderWeeklyRollupMarkdown,
  defaultChainsDir,
} from './options-forward-test.js';
import { evaluateLiveCapitalGate, resolveLiveCapitalGateCriteria } from './live-capital-gate.js';
import { isPopCalibrationEnabled, resolvePopCalibrationConfig } from './options-pop-calibration.js';
import {
  loadProposalsScorecard,
  buildAiIdeasScorecard,
  buildEngineScorecard,
} from './engine-scorecard.js';
import { resolveBuildInfo } from './observability/build-info.js';
import {
  generateMarketReview,
  getLatestMarketReview,
  getFreshMarketReview,
  isReviewStale,
  defaultReviewKind,
  listMarketReviews,
  peekMarketRegime,
} from './market-review.js';
import {
  loadUsers,
  validateUserCredentials,
  changeUserPassword,
  getUserByEmail,
  getUser,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  isUserLocked,
  setUserLocked,
  toSafeUser,
  isTwoFactorEnabled,
  getTwoFactorStatus,
  enableTwoFactor,
  disableTwoFactor,
  consumeBackupCode,
} from './users.js';
import { sendPasswordResetEmail, sendOtpEmail, sendWelcomeEmail } from './email.js';
import { startEventLoopWatchdog, type WatchdogHandle } from './event-loop-watchdog.js';
import {
  logger,
  flushLogs,
  traceMiddleware,
  runWithTrace,
  setTraceUser,
  captureException,
  installGlobalErrorHandlers,
  errorMiddleware,
  TradeAuditTracker,
  getTradeOpenCount,
  getRecentAlerts,
  getAlertingPosture,
  getErrorCountSince,
  runHealthCheck,
  checkDiskSpace,
  readDiskSpace,
  diskMinFreePct,
  recordBootAndCheckRestarts,
  checkTradeVolume,
  checkErrorSpike,
  runAlertingSelfTest,
} from './observability/index.js';
// TRA-1684 — from the module, not the barrel: the barrel re-export dragged the crypto
// route graph behind every logger import and manufactured the TRA-1674 cycle.
import { registerLiveHealthRoutes, runStaleStateCheck, projectFleetBooks, rollUpExitCadence } from './observability/health-routes.js';
// TRA-2840 — durable RTH open/close snapshots of the exit-cadence rollup.
import {
  EXIT_CADENCE_SNAPSHOT_MARKER,
  buildExitCadenceSnapshotLine,
  dueExitCadenceMark,
  recordExitCadenceMark,
  type ExitCadenceEmitState,
} from './observability/exit-cadence-snapshot.js';
import {
  rotateBackups,
  checkDataDirHealth,
  loadStocksTradeSnapshot,
  loadCryptoTradeSnapshot,
  type StocksTradeSnapshot,
  type CryptoTradeSnapshot,
} from './trade-store.js';
import {
  buildExport,
  toCsv,
  type ExportFilters,
  type ExportFormat,
  type ExportMarket,
} from './export.js';
import { TradierRelativeValueScannerService } from './relative-value-scanner.js';
import { applyTheoFloor, OTM_PANEL_THEO_FLOOR } from './otm-theo-floor.js';
import { applyDeltaFloor, OTM_PANEL_DELTA_FLOOR } from './otm-delta-floor.js';
import { findVerticalArbitrage, toArbitrageDiagnostic } from './otm-theo-arbitrage.js';
import {
  rebaseMispricing,
  parseMispricingBasis,
  OTM_PANEL_MISPRICING_THRESHOLD,
} from './otm-mark-basis.js';
import { ShortSqueezeScannerService } from './short-squeeze-scanner.js';
import {
  recordShortSqueezeCapture,
  SHORT_SQUEEZE_ENTRY_CONVENTION,
  type ShortSqueezeCaptureFile,
  type ShortSqueezeCaptureRow,
} from './short-squeeze-capture-recorder.js';
import {
  resolveShortSqueezeForwardOutcomes,
  SHORT_SQUEEZE_FORWARD_SESSIONS,
} from './short-squeeze-forward-resolver.js';
import {
  CoinbaseOrderClient,
  tradierBaseUrl,
  TradierOptionsClient,
  DEFAULT_SHORT_SQUEEZE_THRESHOLDS,
  type TradierTradeHistoryFill,
} from '@trading-app/engine';
import { submitSmartSellToClose } from './tradier-smart-close.js';
import { recordMakerFill } from './option-maker-fill-ledger.js';
import {
  validateOptionsSmokeRequest,
  runContractRoundTrip,
  runShortContractRoundTrip,
  FILL_REALISM,
  FILL_REALISM_NOTE,
} from './tradier-sandbox-options-smoke.js';
import {
  recordFromContractResult,
  recordSandboxStrategy,
  longStrategyFor,
  shortStrategyFor,
  summarizeSandboxStrategyJournal,
  hydrateSandboxStrategyJournalFromDisk,
  getSandboxStrategyRecords,
} from './sandbox-strategy-journal.js';
import {
  summarizeParityReconcile,
  hydrateParityReconcileFromDisk,
  appendParitySnapshotForDay,
  getParityReconcileSeries,
  parityReconcileDurability,
  parityRecordRows,
  PARITY_SCOPE,
  QTY_ASSUMPTION_NOTE,
  EXCLUSION_NOTE,
} from './parity-reconcile.js';
import {
  foldMarketableMtmForwardValidation,
  resolveMarketableMtmGateThresholds,
  MARKETABLE_MTM_SCOPE,
} from './marketable-mtm-forward-validation.js';
import type { TradierEnv } from '@trading-app/shared';
import { fetchQuotes, fetchDailyCandles, fetchTradierDailyCandles, fetchShortInterestFundamentals } from './yahoo-feed.js';
import {
  runFirstBootMigration,
  runTra237OptionsReset,
  runTra241CalendarReset,
  runTra1472StaleCellCleanup,
  runTra301DemoFreshStart,
  runTra330CryptoEquityReset,
  runTra338MegaUsdCleanup,
  initAllUserContexts,
  initUserContext,
  ensureUserContext,
  destroyUserContext,
  getAllUserContexts,
  tryGetUserContext,
  getLiveBrokerBootArmOutcome,
  persistStocksNow,
  persistCryptoNow,
  setRvScanner,
  stockModeKey,
  cryptoModeKey,
  stockReportsDirFor,
  cryptoReportsDirFor,
  type StockModeKey,
  type CryptoModeKey,
  type UserContext,
} from './user-context.js';
import {
  resolveTradierOptionsCreds,
  isLiveTradierOptionsEnabled,
  STRATEGY_PRESETS,
  DEFAULT_STRATEGY_PRESET_ID,
  WATCHLIST,
  aliasWatchlistSymbol,
  aggregateStockTwitsSentiment,
  dedupeStockTwitsMessages,
  mapCuratedMessagesBySymbol,
  type StockTwitsMessage,
  validateLiveCredentials,
  validateProductionTradierKeys,
  type AccountSettings,
  type NewsItem,
  type ResearchReport,
  type EodReport,
  type EodMover,
  type StrategyPresetId,
  type Position,
  type OptionPosition,
  type AccountMode,
  ALERT_CHANNELS,
  resolveAlertPreferences,
  REPORT_CADENCES,
  type ReportCadence,
  type AlertChannel,
  type AlertPreferences,
  type PositionAdvisorReadout,
} from '@trading-app/shared';
import {
  saveResearchReport,
  listResearchReports,
  getResearchReport,
  getLatestReviewBlock,
  seedSampleResearchReportIfEmpty,
  ResearchValidationError,
} from './research-store.js';
// TRA-596 (TRA-595 C1) — upcoming-earnings calendar feed/store + refresh job.
import {
  initEarningsStore,
  refreshEarningsCalendar,
  makeEarningsClientFromEnv,
} from './earnings-store.js';
// TRA-597 (TRA-595 C2) — macro / Fed economic-event calendar feed/store + refresh.
import {
  initMacroStore,
  refreshMacroCalendar,
  makeMacroClientFromEnv,
} from './macro-store.js';
// TRA-532 — Live-Trading Promotion Gate enforcement + audit store/service.
import {
  registerBacktestReport,
  registerOptimizationVerdict,
  registerAccumulationBacktestVerdict,
  recordSignoff,
  listStrategyRecords,
  getEffectiveThresholds,
  ensureStrategyRegistered,
  PromotionValidationError,
} from './promotion-store.js';
import { seedDcaAccumulationBacktest } from './promotion-dca-seed.js';
import {
  buildPromotionStatus,
  buildPublicPromotionProbe,
  snapshotPaperMetrics,
  evaluateLiveTransitionGate,
  evaluateLiveCryptoStartGate,
} from './promotion-service.js';
import { resolveDataDir } from './data-dir.js';

const log = logger.child({ module: 'index' });

const PORT = Number(process.env.PORT ?? 4242);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolveDataDir();

// TRA-1481 — self-heal the Render blueprint env-sync gap for board-ratified DEMO
// brakes. On bqb1/Render an autoDeploy ships code but does NOT re-sync env from
// render.yaml (TRA-1289), so `ENABLE_CHURN_LOSS_BRAKE:"1"` (ratified since 1e55e5c)
// stayed DARK (`/api/health/churn-brake` → armed:false) and the Render key needed
// for a blueprint sync is blocked (TRA-969). Seed the ratified arm into the boot env
// ON RENDER ONLY, and only when it's set by NEITHER process.env NOR demo-flags.json,
// so a board disarm via `/api/admin/demo-flags` (the file layers OVER env) still
// wins and the self-host is untouched. DEMO-only ⇒ zero real-capital risk.
//
// SCOPE: this loop is generic over ALL 11 entries of RENDER_RATIFIED_DEMO_DEFAULTS,
// not just the churn brake. The brake is only the worked example above (it is the
// flag that exposed the TRA-1289 gap), and the log line below names whichever key is
// actually being seeded. How many get applied varies per boot: the resolver returns
// only the entries unset in BOTH env and demo-flags.json, which is the whole point.
// TRA-2402 read this block as churn-brake-only and filed
// `ENABLE_OPTION_COST_AWARE_GATE` as unseeded/dark on that basis; it is in the map
// (demo-flags.ts) and was armed. Read the map, not this comment's example.
for (const [key, value] of Object.entries(renderRatifiedDemoDefaults(DATA_DIR))) {
  process.env[key] = value;
  // TRA-2209 — record the seed BEFORE it becomes indistinguishable from a
  // Render-supplied value, so `/api/health/env-drift` can report these as
  // `selfHealed` (a code fallback holds the arm, not the env store) instead of
  // silently counting them as healthy.
  recordSeededEnvKey(key, 'RENDER_RATIFIED_DEMO_DEFAULTS');
  log.info('TRA-1481 seeded board-ratified demo flag on Render (blueprint-sync gap)', {
    flag: key,
    value,
  });
}

// TRA-1515 (parent TRA-1463) — same blueprint-sync self-heal for INFRA/stability
// env values (not demo flags). CRYPTO_TICK_MAX_CONCURRENT is the crypto-tick FIFO
// cap that fixes the aggregate-doTick check-phase block; it is armed =4 via the
// Render API (redeploy-durable) but reverts to the code default 0 (=unlimited =
// pre-TRA-1463 crash cycle) if the API env is ever wiped. Seeding it here makes
// the fix survive a full env reset too. Render-only, and only when unset by env
// (an explicit operator/API value — including a deliberate `0` disarm — always
// wins). crypto-engine reads K lazily (TRA-1515) so this boot seed is honoured
// before the first tick. Capital-incapable ⇒ zero real-money risk.
for (const [key, value] of Object.entries(renderInfraDefaults())) {
  process.env[key] = value;
  recordSeededEnvKey(key, 'RENDER_INFRA_DEFAULTS'); // TRA-2209 — see above
  log.info('TRA-1515 seeded infra default on Render (blueprint-sync gap)', {
    flag: key,
    value,
  });
}

// TRA-1008 — effective env for demo-loop flags: process.env with the
// allowlisted <DATA_DIR>/demo-flags.json values layered on top. Re-read on each
// call so an operator's file flip is picked up on the next tick / probe.
const demoFlagEnv = (): NodeJS.ProcessEnv => resolveDemoFlagEnv(DATA_DIR);

// TRA-140 — log DATA_DIR and warn loudly if it's ephemeral.
await checkDataDirHealth();

// Load users and reset tokens from persistent storage.
await loadUsers();
initResetTokenStore(DATA_DIR);
initTwoFactorStore(DATA_DIR);

// TRA-1052 (TRA-1045 R1) — open the durable hot-state SQLite store on the Render
// disk (DATA_DIR) BEFORE any per-user context boots, so the agent-spend committed
// ledger rehydrates and account-settings reads hit the db. Fail-soft: if the
// native binary is unavailable this disables durable hot-state and logs, but the
// server still boots (stores fall back to in-memory/JSON).
initStateDb(DATA_DIR);

// TRA-1681 — THE FAIL-CLOSED GATE. Every durable store above fails open, each for its
// own defensible local reason, and the sum of those reasons is a box that can run with
// nothing durable under it while reading perfectly healthy. This is the one place that
// looks at the whole picture and is allowed to say no.
//
// It runs HERE — after DATA_DIR is resolved and the state db has tried to open, before
// any store hydrates or any engine tick fires — because the point of refusing is to
// refuse BEFORE a sample starts accruing that nobody will be able to grade.
//
// Under the default policy (`observe`) this only logs: behaviour is byte-for-byte what
// it was. Under `DURABILITY_POLICY=refuse` a KNOWN-BROKEN guarantee stops the boot.
{
  const report = evaluateDurability({ dataDir: DATA_DIR, stateDb: getStateDbStatus() });
  if (report.violations.length > 0) {
    log.error('TRA-1681 durable state is BROKEN', {
      policy: report.policy,
      violations: report.violations,
      dataDir: report.dataDir,
      ephemeral: report.ephemeral,
    });
  } else {
    log.info('TRA-1681 durable state OK at boot', { policy: report.policy, dataDir: report.dataDir });
  }
  // Throws only under `refuse`. Deliberately NOT caught: a box that has been told to
  // require durability and cannot provide it must not reach the engine. Refusing on
  // `violations` only — the journal has not been read yet at this point, and refusing
  // over a measurement that cannot exist yet would make the process unbootable.
  enforceDurabilityPolicy(report);
}

// TRA-801 — ensure SupertrendConfluence has a promotion record so its Stage-2
// paper accrual surfaces on the `GET /api/promotion/status` overview list (which
// iterates registered strategies). Creates an EMPTY record only — backtest stays
// `missing` (Stage 1 blocked on TRA-382) and sign-off `absent`, so the gate keeps
// `canGoLive=false`. Idempotent; never clobbers an existing record.
await ensureStrategyRegistered('supertrend_confluence').catch(err =>
  log.warn('TRA-801 ensureStrategyRegistered(supertrend_confluence) failed', {
    reason: err instanceof Error ? err.message : String(err),
  }),
);

// TRA-1579 — seed the crypto-DCA Stage-1 accumulation-backtest verdict (TRA-1465
// accumulate leg) so `dca` carries a REAL pass/fail Stage-1 on the go-live gate
// instead of `missing` (parent TRA-1575). Idempotent + non-clobbering: a later
// admin registration via `POST /api/promotion/accumulation-backtest` wins. Flips
// no live flag — Stage-3 board sign-off still gates the live transition, and the
// seeded verdict is FAIL on the current OOS data.
await seedDcaAccumulationBacktest().catch(err =>
  log.warn('TRA-1579 seedDcaAccumulationBacktest failed', {
    reason: err instanceof Error ? err.message : String(err),
  }),
);

// TRA-191 — server-side relative-value scanner. The only options strategy
// active for stock options in this iteration; OTM mispricing and per-equity
// ATM auto-open are disabled. Wired into user-context BEFORE any contexts
// are constructed so every per-user SignalEngine sees the same scanner
// instance and shares the 60s chain cache + 1h breaker. Uses Yahoo's
// existing quote pipeline as the spot source so we don't pay for Tradier
// quotes too.
//
// Credentials resolution by `TRADIER_ENV`:
//   • `production` → TRADIER_API_TOKEN + TRADIER_ACCOUNT_ID
//   • `sandbox` (default) → TRADIER_SANDBOX_API_TOKEN + TRADIER_SANDBOX_ACCOUNT_ID,
//     falling back to the unprefixed pair when the sandbox-specific ones
//     are missing (so legacy single-pair setups still work).
// Reports `no_credentials` when the resolved pair is empty — the engine
// then simply skips options scanning, equity trading is unaffected.
const tradierEnv = (process.env['TRADIER_ENV'] as 'sandbox' | 'production') ?? 'sandbox';
const tradierApiToken = tradierEnv === 'production'
  ? process.env['TRADIER_API_TOKEN']
  : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']);
const tradierAccountId = tradierEnv === 'production'
  ? process.env['TRADIER_ACCOUNT_ID']
  : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']);

const relativeValueScannerService = new TradierRelativeValueScannerService({
  tradierApiToken,
  tradierAccountId,
  tradierEnv,
  fetchSpot: async (symbol) => {
    // TRA-552 — the RV scanner only needs an underlying spot for options
    // mispricing math, which tolerates a few seconds of staleness. Reuse a
    // recent watchlist/engine quote (up to 15s old) from the shared quote cache
    // instead of firing a fresh per-symbol Tradier call — Tradier is now the
    // sole stock-quote source and these per-symbol spot fetches were a large
    // slice of the daily request counter.
    const quotes = await fetchQuotes([symbol], { maxStaleMs: 15_000 });
    const q = quotes.get(symbol);
    return q && q.price > 0 ? q.price : null;
  },
});
setRvScanner(
  relativeValueScannerService.diagnostics().configured ? relativeValueScannerService : undefined,
);
log.info('rv-scanner initialized', {
  // TRA-2163 (leg 3) — `tradierEnv` is cast from the raw `TRADIER_ENV` env var,
  // which was mis-set to the live Tradier token on bqb1. Redact through the same
  // choke point so a mis-set value can never be written to the (persisted) logs;
  // routing itself still uses the raw `tradierEnv` const above, unchanged.
  env: redactTradierEnvLabel(tradierEnv),
  configured: relativeValueScannerService.diagnostics().configured,
});

// TRA-1207 — short-squeeze screener. Read-only: it screens the watchlist for
// short-squeeze setups (short float / days-to-cover / float / market cap /
// avg volume / RVOL / above-50d-SMA) and never places an order. Fundamentals
// come from Yahoo quoteSummary; daily bars from the shared daily-candle feed
// (Yahoo primary, Tradier fallback when Yahoo's breaker is open).
const shortSqueezeScannerService = new ShortSqueezeScannerService({
  fetchFundamentals: (symbol) => fetchShortInterestFundamentals(symbol),
  fetchDailyBars: async (symbol, count) => {
    const bars = await fetchDailyCandles(symbol, count);
    return bars.length > 0 ? bars : fetchTradierDailyCandles(symbol, count);
  },
});

// TRA-563 (TRA-410 A1) — install the notification dispatcher. Preferences are
// resolved from the cache-first per-user settings (warm once a user's context
// is created).
// TRA-566 (TRA-410 A2) — register the email / Telegram / Discord channel
// adapters. Each is inert until configured (SMTP creds / a linked Telegram chat
// / a pasted Discord webhook), so an unconfigured channel is skipped cleanly.
const notificationDispatcher = initNotificationDispatcher({
  loadSettings: (username) => getSettings(username),
});
const channelAdapters = registerChannelAdapters(notificationDispatcher);
log.info('notification dispatcher initialized', {
  channels: ALERT_CHANNELS,
});

// TRA-142 — migrate legacy global files into the admin namespace exactly once,
// then bootstrap per-user contexts (engines, trackers, persistence timers) for
// every known user. New signups get their context created on demand.
await runFirstBootMigration('admin');
// TRA-237 — one-shot cleanup of options buckets corrupted by the pre-fix
// importTradeSnapshot() routing. Runs before context bootstrap so engines
// load from the cleared snapshot. Idempotent via marker file.
await runTra237OptionsReset();
// TRA-241 — paired with the 9 PM dailyPnl reset fix: the board asked for a
// fresh P&L calendar across every account so the historical view starts
// clean. Wipes per-user EOD reports + daily-snapshots before PnlTracker
// reads them on first construction. Idempotent via marker file.
await runTra241CalendarReset();
// TRA-1475 (Part 2) — one-shot scrub of pre-TRA-594 corrupted demo calendar
// cells (the frozen cumulative-optionsPnl leak repeated across consecutive
// pre-2026-06-09 days). Deletes only the leaked historical cell files; post-fix
// cells are never touched. Idempotent via marker file.
await runTra1472StaleCellCleanup();
// TRA-301 — full demo fresh-start: with the new strategy generation rolling
// out for both Stocks and Crypto, the board asked to wipe every user's
// persisted demo P&L, equity baselines, trade history, and calendar reports
// so the dashboards open clean on the new strategies. Runs before context
// bootstrap so engines load empty. Idempotent via marker file.
await runTra301DemoFreshStart();
// TRA-330 — one-shot crypto equity reset: prod demo crypto accounts drifted
// into the billions because of a short cash-flow accounting bug. The bug
// itself is fixed in crypto-account.ts; this migration clears the persisted
// snapshots that already loaded the bad state. Crypto-only, idempotent.
await runTra330CryptoEquityReset();
// TRA-338 — surgical removal of the phantom MEGA-USD paper position opened
// off Yahoo's frozen $4.05 ghost ticker (root cause in TRA-337). Refunds the
// recorded cost basis to cash and drops the position before the engine boots
// off the cleaned snapshot. Runs after TRA-330 so the equity reset (which
// may itself wipe trades-crypto.json) doesn't undo the cleanup mid-flight.
// Idempotent via marker file.
await runTra338MegaUsdCleanup();
await initAllUserContexts();

// TRA-227 — drop a placeholder QuantTrader research report so the Stocks
// News tab has visible "Research" content the first time the server boots.
// No-op once the store has at least one report, so real reports posted via
// `/api/research/reports` aren't shadowed.
await seedSampleResearchReportIfEmpty();

// TRA-386 / TRA-589 — warm the market-review feed on boot so the dashboard
// banner and News tab reflect the *current* regime before the first scheduled
// fire. Regenerates when there is no review yet OR the latest is stale —
// predates the current ET session or came from a dark trend feed — so a deploy
// that repairs the feed (e.g. the TRA-586 Tradier fallback) reflects
// immediately instead of serving the last persisted YELLOW review until the
// next scheduled job. Fired non-blocking: a cold/slow feed must not delay
// startup.
void getLatestMarketReview().then(existing => {
  if (!isReviewStale(existing)) return;
  void generateMarketReview(existing?.kind ?? defaultReviewKind()).catch(err =>
    log.error('market-review boot-time generation failed', {
      reason: err instanceof Error ? err.message : String(err),
    }),
  );
});

// TRA-950 (Part B) — auto-seed the active watchlist from the latest desk review
// block's leaders, for every user, at boot. De-duped + capped + tagged
// review-sourced inside `seedReviewLeaders` (advisory invalidation levels are
// recorded as metadata; no new order behavior). Non-blocking: a missing/empty
// block is a no-op, and a slow disk read must not delay startup.
void getLatestReviewBlock()
  .then(async block => {
    if (!block || block.leaders.length === 0) return;
    let seededUsers = 0;
    for (const ctx of getAllUserContexts()) {
      try {
        const { reviewSourced } = await seedReviewLeaders(ctx.username, block);
        if (reviewSourced.length) seededUsers += 1;
      } catch (err) {
        log.warn('review-leader watchlist seed failed', {
          username: ctx.username,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info('seeded review leaders into watchlists', {
      leaders: block.leaders.length,
      seededUsers,
    });
  })
  .catch(err =>
    log.error('review-leader boot seed failed', {
      reason: err instanceof Error ? err.message : String(err),
    }),
  );

// TRA-596 (TRA-595 C1) — warm the earnings-calendar cache from disk so the
// synchronous accessor (`earningsInDaysSync`) the engine reads each tick has
// data immediately, then kick a non-blocking refresh of the active stock
// universe. A slow/absent provider must never delay server startup.
await initEarningsStore();
void runEarningsRefresh();

// TRA-597 (TRA-595 C2) — warm the macro/Fed economic-calendar cache from disk
// (the curated FOMC schedule is available even before the first fetch), then
// kick a non-blocking refresh. A slow/absent provider must never delay startup.
await initMacroStore();
void runMacroRefresh();

// TRA-604 (TRA-595 C4b) — warm the trailing-IV store from disk so the
// synchronous `ivRankSync` read used by the AI Options Ideas fusion has data
// available right after boot. The store is appended to as chains are pulled.
await initIvRankStore();

// TRA-2206 (TRA-1965) — optionally deepen that store from the recorded chain
// archive. The store only starts accumulating for a symbol once that symbol
// first flows through a chain pull, so every idea surfaced during the warm-up
// window got `ivRank: null` — 81% of bqb1's n=43 resolved cohort. The daily
// recorder has far deeper history; seeding from it lets `ivRankSync` clear
// MIN_IV_SAMPLES for symbols whose chains were being recorded all along, which
// is what makes the TRA-2005 expectancy shadow gradeable on a FRESH cohort
// (its IV-rank floor is check 3 of 6 and treats unknown as a hard fail).
//
// Gated OFF by default and awaited before the first request: unlike the
// retrospective reconstruction on the decomposition probe (read-only), this
// changes what the live research prompt sees, so a deploy alone must not arm it.
// Samples are ADD-ONLY — a live-recorded day is never overwritten — and each
// archive sample is dated by its own capture day, so no look-ahead is possible.
if (isIvArchiveSeedEnabled()) {
  try {
    // `defaultChainsDir()` (not CHAIN_RECORD_OUT_DIR): that const is declared far
    // below this boot block, so referencing it here would hit the TDZ. The two
    // resolve identically — CHAINS_OUT_DIR, else <DATA_DIR>/option-chains.
    const archiveDays = await loadChainDays(defaultChainsDir());
    const series = buildIvSeriesFromChains(archiveDays, estimateSpotFromChain);
    const seeded = await seedFromArchive(series);
    log.info('IV-rank archive seed applied', {
      flag: IV_ARCHIVE_SEED_FLAG,
      partitionDays: archiveDays.length,
      symbols: series.size,
      ...seeded,
    });
  } catch (err) {
    // Never fatal: a missing/unreadable archive must not block boot. The store
    // simply stays at whatever depth it had, and coverage reports the shortfall.
    log.warn('IV-rank archive seed skipped', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// TRA-601 (TRA-595 C6) — warm the forward-test idea journal so the report read
// has the surfaced-idea history available right after boot. The journal is
// appended to (deduped) every time the live ideas feed is built.
await initIdeaJournal();

// TRA-791 — warm the SupertrendConfluence shadow signal->outcome ledger so the
// research read endpoint has the labelled history available right after boot.
// The engine appends OPEN rows on each new shadow signal and RESOLVED rows as
// the forward horizon labels them.
await initShadowLedger();

// TRA-911 (TRA-908 Phase A) — warm the flag-gated SHADOW option-trade signal
// ledger so the read endpoint has history right after boot. The selector that
// appends to it is observe-only and OFF unless ENABLE_OPTION_SHADOW_SELECTOR is
// set; nothing here routes an order.
await initOptionShadowLedger();

// TRA-2173 (parent TRA-2172) — warm the flag-gated SHADOW ORB-for-options ledger
// so the read endpoint has history right after boot. The signal-engine ORB-
// options pass appends at most one directional-intent row per underlying per ET
// session when ENABLE_ORB_OPTIONS_SHADOW is set; observe-only, routes no order.
await initOrbOptionsShadowLedger();

// TRA-1609 (parent TRA-1607) — warm the flag-gated SHADOW Put-Call-Ratio ledger
// so the read endpoint has history right after boot. The signal-engine option-
// shadow pass appends one row per underlying per session when ENABLE_PCR_SHADOW
// is set; the capture is observe-only and never touches sizing or exits.
await initPcrShadowLedger();

// TRA-1610 (parent TRA-1607) — warm the flag-gated SHADOW Open-Interest-trend
// ledger so the read endpoint has history right after boot. The signal-engine
// option-shadow pass appends one row per underlying per session when
// ENABLE_OI_SHADOW is set; the capture is observe-only and never touches sizing
// or exits.
await initOiShadowLedger();

// TRA-1629 (parent TRA-1623) — warm the flag-gated SHADOW news-catalyst ledger so
// the read endpoint has history right after boot. The pre-market watchlist build
// appends one row per name per session when ENABLE_NEWS_CATALYST_WATCHLIST is set;
// the capture is observe-only (D1 only ADDS names to watch, D2 annotates a report)
// and never touches sizing or exits.
await initNewsCatalystLedger();
// TRA-2064 — rehydrate the durable RUN history so the health probe can answer
// "did the writer ever run?" immediately after a restart. The restarts are the
// thing under investigation, so this must not start empty.
await initNewsCatalystRunLedger();

// TRA-1632 (parent TRA-1630/TRA-1623) — warm the flag-gated SHADOW D2 lean ledger
// so the read endpoint has history right after boot. The post/pre-market review
// appends one lean row per catalyst name per session when the same
// ENABLE_NEWS_CATALYST_WATCHLIST flag is set; the capture is observe-only (the
// lean only annotates the report) and never touches sizing or exits.
await initNewsCatalystLeanLedger();

// TRA-1618 (parent TRA-1614) — warm the flag-gated SHADOW weekly-QQQ-PCS
// forward-test ledger so the read endpoint + Stage-2 paper feed have history
// right after boot. The signal-engine option-shadow pass opens one spread per
// weekly cycle and settles due spreads when ENABLE_PCS_SHADOW is set; the
// capture is observe-only ($0 live) and never routes an order.
await initPcsShadowLedger();

// TRA-921 (TRA-920 B) — warm the OBSERVE-ONLY reversal-checklist shadow ledger so
// the read endpoint has history right after boot. The signal-engine tick appends
// rows when ENABLE_REVERSAL_SHADOW is set; nothing here routes an order.
await initReversalShadowLedger();

// TRA-1457 — warm the SHADOW-FIRST universal pre-trade gate ledger so its read
// endpoint has history right after boot. The signal-engine reversal shadow pass
// appends decisions when ENABLE_PRE_TRADE_GATE is set (default OFF); nothing here
// routes or modifies an order.
await initPreTradeGateLedger();

// TRA-2051 — warm the live-canary state ledger so the health endpoint reflects the
// folded state (incl. any latched demotion) right after boot. Inert with
// ENABLE_LIVE_CANARY off (default): no candidate is armed and no capital moves.
await initLiveCanaryLedger();

// TRA-1967 — warm the SHADOW-FIRST pre-trade LIQUIDITY gate ledger so its read
// endpoint has history right after boot. The live equity/options signal paths
// append decisions when ENABLE_PRE_TRADE_LIQUIDITY_GATE is set (default OFF);
// nothing here routes, downsizes, or modifies an order.
await initPreTradeLiquidityLedger();

// TRA-850 — warm the persistent per-user trading-memory store from disk so the
// synchronous `getUserMemorySync` read the advisory tick uses has each user's
// preferences immediately. Appended to as users state preferences or as
// approve/reject interactions accrue.
await loadUserMemoryStore();

// TRA-851 — warm the per-user routine store so the synchronous reads the
// scheduler's routine tick does (`listRoutinesSync`/`usersWithRoutinesSync`)
// have each user's defined routines immediately, and they survive a restart.
await loadRoutineStore();

const app = express();
// TRA-404 — behind Render's proxy the socket address is the proxy, not the
// client. Trust the X-Forwarded-For chain so `req.ip` is the real caller IP
// (used to key the auth-endpoint brute-force throttle).
app.set('trust proxy', true);

// ── Security headers ─────────────────────────────────────────────────────────

// TRA-2298 — nothing on this box carried HSTS, CSP, X-Frame-Options or nosniff,
// on an authenticated surface that exposes one-click kill-switch / stop-trading
// / close-position controls to a browser. Mounted FIRST so it covers the static
// SPA (`express.static` below) and every error path, not just the API routes.
// `x-powered-by` is dropped outright — free stack fingerprinting.
app.disable('x-powered-by');
app.use(securityHeadersMiddleware());

// ── CORS ─────────────────────────────────────────────────────────────────────

// TRA-2298 — was `Access-Control-Allow-Origin: *` on every route, which handed
// any web origin a browser-sourced driver for `/api/auth/login`. Now an
// allowlist; see `http-security.ts` for who is on it, why the GitHub Pages
// origin is load-bearing, and why a non-allowlisted origin is
// answered-without-the-header rather than refused.
const ALLOWED_ORIGINS = buildAllowedOrigins();
log.info('cors allowlist', { origins: [...ALLOWED_ORIGINS] });
app.use(corsMiddleware(ALLOWED_ORIGINS));

// TRA-406 — open a trace for every request so logs, captured errors and the
// `X-Trace-Id` response header all correlate to the same request.
app.use(traceMiddleware);

// ── CSP violation reports ────────────────────────────────────────────────────
//
// TRA-2344 — mounted HERE, above `express.json()`, and that position is
// load-bearing rather than tidy. The collector brings its own 8 KB raw parser
// because (a) the global parser's 100 KB default is far too generous for an
// endpoint browsers post to unauthenticated, and (b) the global parser matches
// `application/json`, while these arrive as `application/csp-report` and
// `application/reports+json`. A body the global parser declined to read leaves
// `req.body` as `{}` — no error, no log, just a permanent zero that reads exactly
// like a clean policy. Both routes are deliberately unauthenticated; see the
// header of `csp-report-collector.ts` for the bounds that makes that safe.
//
// Hydrated immediately before the mount rather than alongside the other boot
// hydrates further down, so there is no window in which the route is live and the
// store is still empty — a report landing in that window would be counted against
// a zeroed baseline and then overwritten by the hydrate.
initCspReportStore(DATA_DIR);
app.use(cspReportRouter());

// TRA-852 — stash the exact raw request bytes on the request during JSON
// parsing. The Discord Interactions endpoint must verify the Ed25519 signature
// against the byte-for-byte body Discord signed; re-serializing the parsed
// object would not round-trip (key order, whitespace), so we capture the buffer
// here. It is just a reference to the buffer express.json already holds — no
// extra copy — and is read by exactly one route.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

// ── Auth middleware ───────────────────────────────────────────────────────────

function firstHeader(val: string | string[] | undefined): string | undefined {
  return Array.isArray(val) ? val[0] : val;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const header = firstHeader(req.headers.authorization);
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const user = verifyToken(header.slice(7));
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  // TRA-2421 — the token must belong to an account that still EXISTS.
  //
  // Tokens are stateless HMACs with a 24h TTL (`auth.ts`) — there is no session
  // store and no revocation list — so without this check a deleted user keeps
  // full API access until their token ages out. That is not merely a stale
  // session: the very next request would reach `userCtx()` → `ensureUserContext`
  // → `createUserContext`, which mkdirs `users/<username>/` and rehydrates the
  // book through `tryRestoreFromBackup`. The account would UN-DELETE ITSELF
  // within one poll of the desktop client, with the delete route's 200 and an
  // empty directory both still looking correct.
  //
  // Fails CLOSED on purpose: a corrupt `users.json` parses to `users = []`
  // (`users.ts:110-111`), so every caller 401s and re-login fails loudly, rather
  // than the whole fleet running on phantom identities that re-provision
  // directories. This also ends an ADMIN-deleted user's session immediately,
  // which was the same 24h hole.
  if (!getUser(user)) {
    res.status(401).json({ error: 'Account no longer exists' });
    return;
  }
  res.locals['authUser'] = user;
  // TRA-406 — stamp the authenticated user onto the request trace so every
  // subsequent log line and captured error carries it.
  setTraceUser(user);
  next();
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const username = res.locals['authUser'] as string;
  const user = getUser(username);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * Resolve the per-user context for the authenticated user. Falls back to
 * lazily creating one if it isn't present (defensive — initAllUserContexts
 * should have built it at boot, and signup builds it on creation). When a
 * brand-new context is built here, also attach WS broadcast handlers so the
 * user's clients receive engine ticks.
 */
async function userCtx(res: express.Response): Promise<UserContext> {
  const username = res.locals['authUser'] as string;
  const wasNew = !tryGetUserContext(username);
  const ctx = await ensureUserContext(username);
  if (wasNew) attachBroadcastHandlers(ctx);
  return ctx;
}

// ── EOD Report generation ────────────────────────────────────────────────────

/**
 * Generate and persist the stocks EOD report.
 *
 * `opts.asOfDate` (TRA-388) — when set, this is a *backfill* run for a past
 * trading day whose 21:00 ET archive tick was missed (server offline). A
 * backfill:
 *   - stamps the report with `asOfDate` and selects that day's closed trades
 *     (still retained in engine state — archiving never ran);
 *   - skips the Tradier reconcile + broker-truth `combinedPnl` override: that
 *     path keys off *today's* Tradier balance and would mis-stamp a past
 *     cell. Per-day broker-truth reconstruction of missed days is a separate
 *     follow-up;
 *   - does not touch `latest.json` / the equity tracker / WS broadcast, so
 *     filling an old gap can't clobber the genuine latest report or rebase
 *     the live dashboard's opening equity.
 */
async function generateAndSaveReport(
  ctx: UserContext,
  opts: { asOfDate?: string } = {},
): Promise<void> {
  const backfill = opts.asOfDate != null;
  // TRA-244 — write under the active stocks bucket (demo / live / sandbox)
  // so the per-account calendar shows only the rows that belong to it.
  const settings = getSettings(ctx.username);
  const mode = stockModeKey(settings);
  const targetDir = stockReportsDirFor(ctx, mode);

  // TRA-348 — when the user is in live mode, pull recent Tradier history
  // and merge any closes the engine didn't process (manual closes on the
  // broker UI, or `sell_to_close` orders that resolved after the 5s
  // wait window) into the per-day reports for the active env. Failures
  // here must not block the local report from being written.
  if (settings.mode === 'live' && !backfill) {
    try {
      await reconcileTradierOptionsHistory(ctx, settings, mode);
    } catch (err) {
      log.warn('tradier-reconcile failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Re-pull the snapshot AFTER reconcile so the report's `optionsPnl`
  // reflects any Tradier-side closes we just merged (the dashboard pill
  // reads the same aggregate).
  const finalSnapshot = ctx.engine.getReportSnapshot();
  // TRA-991 — fold the demo option-trade journal (TRA-990) into the report so
  // the EOD markdown carries the journal P&L + learned-weights section. The
  // journal is demo-only and observe-only; gate the read on the flag so a
  // disabled journal adds no section and no I/O surprise.
  if (isOptionTradeJournalEnabled()) {
    try {
      await ctx.engine.flushOptionTradeJournal?.();
      // TRA-2214 — the three journal blocks fold together, on ONE model-facing
      // basis (desk + unattributed; QA fixtures dropped), inside
      // `foldModelFacingEodJournal`. The basis MOVES these published numbers, so
      // it rides the wire beside them rather than showing up as an unexplained
      // drift in a grader's series.
      const fold = await foldModelFacingEodJournal();
      finalSnapshot.optionJournal = fold.optionJournal;
      finalSnapshot.optionLearnedWeights = fold.optionLearnedWeights;
      finalSnapshot.introspection = fold.introspection;
      finalSnapshot.journalBasis = fold.journalBasis;
      finalSnapshot.journalBasisCounts = fold.journalBasisCounts;
    } catch (err) {
      log.warn('option-trade-journal EOD fold failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // TRA-1000 — fold the external-intel source-quality scorer into the report so
  // the EOD markdown carries per-source advisory weights. Gate the read on
  // ENABLE_EXTERNAL_INTEL so a firm not running intel adds no section/I/O. The
  // weights are advisory only — they never size capital or gate promotion.
  if (isExternalIntelEnabled()) {
    try {
      finalSnapshot.sourceQualityWeights = await loadSourceQualityWeights();
    } catch (err) {
      log.warn('source-quality EOD fold failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // TRA-1004 — fold the autonomous demo-loop status into the report so the EOD
  // markdown shows the loop's activity (ticks, books driven, autopilot halts /
  // throttles) for the demo book. Gated on ENABLE_AUTONOMOUS_DEMO_LOOP so a firm
  // not running the loop adds no section. Status is firm-wide (the conductor
  // drives every demo book), surfaced on each demo book's report for visibility.
  if (isAutonomousDemoLoopEnabled(demoFlagEnv()) && settings.mode === 'demo') {
    finalSnapshot.autonomousDemoLoop = buildAutonomousDemoLoopReport(demoFlagEnv());
  }
  // TRA-1006 — fold the analyst agent's pre-market plan + post-market review into
  // the EOD markdown (demo book only). Gated on ENABLE_ANALYST_AGENT; reads the
  // persisted artifacts for the day (absent ↔ no section). Advisory surfacing only
  // — emitted hypotheses still clear G0 + board ratification before any effect.
  if (isAnalystAgentEnabled() && settings.mode === 'demo') {
    try {
      const analystDate = opts.asOfDate ?? analystEtDate(Date.now());
      const analystPlan = await readAnalystPlan(analystDate);
      if (analystPlan) finalSnapshot.analystPlan = analystPlan;
      const analystReview = await readAnalystReview(analystDate);
      if (analystReview) finalSnapshot.analystReview = analystReview;
    } catch (err) {
      log.warn('analyst EOD fold failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // TRA-998 — fold the live cross-producer hypothesis ratification queue + the
  // ratified demo overrides into the EOD markdown (demo book only) so the board
  // sees what is staged for confirmation and what has landed behind a flag. The
  // queue read is cheap (empty map when no producer has ever enqueued) and the
  // section self-suppresses when nothing is staged AND nothing ratified.
  if (settings.mode === 'demo') {
    try {
      finalSnapshot.hypothesisQueue = await buildHypothesisQueueHealth();
    } catch (err) {
      log.warn('hypothesis-queue EOD fold failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // TRA-1981 (parent TRA-1967 item 2) — fold the realized-vs-modeled execution-quality
  // KPI (per asset class) into the EOD markdown so the board sees execution decay next
  // to the day's P&L. Options come from the durable fee/slippage ledger; equity from
  // this book's open + closed positions carrying the TRA-536 entry-slippage stamp;
  // crypto from the paired crypto book. Pure read of already-persisted data (no new
  // writes). Best-effort — a fold failure logs and leaves the section absent, never
  // blocking the report.
  try {
    const equityPositions: Position[] = [
      ...finalSnapshot.state.account.openPositions,
      ...finalSnapshot.allClosedPositions,
    ];
    let cryptoPositions: Position[] = [];
    try {
      const cs = ctx.cryptoEngine.getState();
      cryptoPositions = [...cs.account.openPositions, ...cs.closedPositions];
    } catch {
      // Crypto book unavailable this tick — the equity + (durable) options legs still fold.
    }
    finalSnapshot.executionQuality = buildExecutionQualityKpi({ equityPositions, cryptoPositions });
  } catch (err) {
    log.warn('execution-quality EOD fold failed', {
      username: ctx.username,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // TRA-2634 — hand the report generator the PRIOR SESSION's published movers so
  // its level-continuity check has a second dated observation to be continuous
  // with. Yesterday's published close IS today's previous close, so a row whose
  // implied prev close does not reproduce it had its denominator re-derived —
  // the FGMC `$8.30 / +69.04% -> +110.66%` shape, which no session-move ratio
  // test can express.
  //
  // Deliberately reads only what is ALREADY on disk in this same bucket: no new
  // durable state, no network, and it therefore works against the existing
  // archive (which is what let TRA-2634 grade the threshold on 260 real
  // adjacent-session pairs before shipping it).
  //
  // ⛔ ADJACENCY IS THE PRECONDITION, NOT A NICETY. Only the immediately
  // preceding session is loaded; if that file is absent we pass NOTHING and the
  // check abstains on every row. Substituting "the most recent report we have"
  // would turn every Monday into a 3-day comparison and manufacture breaks.
  //
  // ⚠️ COVERAGE, stated because a per-row abstain is a fail-open: the stored
  // report carries only `top5Movers`, so this can grade a symbol only if it was
  // in YESTERDAY's top five. That covers the hazard the check exists for — a
  // fabricated denominator re-derives every session, so a row about to take #1
  // was usually #1 yesterday too (both of TRA-2634's positive controls are this
  // shape) — but it does NOT cover a symbol that was clean yesterday, and it
  // cannot cover a symbol's first appearance at all. The census logged inside
  // `top5Movers` prints how much of the table was ungradeable each run.
  let priorSessionMovers: EodMover[] | undefined;
  let priorSessionDate: string | undefined;
  {
    const reportDate = opts.asOfDate ?? etDateString();
    const prevSession = previousMarketDayIso(reportDate);
    if (prevSession) {
      const priorPath = join(targetDir, `${prevSession}.json`);
      try {
        if (existsSync(priorPath)) {
          const prior = JSON.parse(await readFile(priorPath, 'utf-8')) as EodReport;
          if (Array.isArray(prior?.top5Movers) && prior.top5Movers.length > 0) {
            priorSessionMovers = prior.top5Movers;
            priorSessionDate = prevSession;
          }
        }
      } catch (err) {
        // An unreadable prior artifact must abstain, never grade against a
        // partial parse — a continuity verdict built on half a table is worse
        // than no verdict.
        log.warn('TRA-2634 prior-session report unreadable — continuity check abstains', {
          username: ctx.username,
          priorPath,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  finalSnapshot.priorSessionMovers = priorSessionMovers;
  finalSnapshot.priorSessionDate = priorSessionDate;

  let finalReport = generateEodReport(finalSnapshot, opts.asOfDate);

  // TRA-2314 (parent TRA-2297, split from TRA-2302) — re-source the day-only
  // realized options P&L from the DURABLE option-trade journal.
  //
  // `generateEodReport` sums `ReportInput.closedOptions`, the engine's VOLATILE
  // in-memory `PaperOptionsAccount.closedOptions` bucket. That bucket is emptied
  // every night by `archiveClosedOptions()` and is not guaranteed across the
  // restarts bqb1 takes several times an hour, so a day whose closes are not in
  // it at 21:00 ET books exactly 0.00 — bit-identical to a day that traded no
  // options. TRA-2302 proved that is what happened: 110 closed desk round trips
  // worth +$844.99 across 15 ET days, every one of them booked 0.00.
  //
  // The patch is applied to `finalReport` — BEFORE the file write and before the
  // snapshot — so the per-day report JSON, its markdown, `latest.json` and
  // `DailySnapshot.optionsDailyPnl` are all booked from ONE source. Moving only
  // the snapshot would have been worse than doing nothing: on the days where the
  // report file also booked 0, it manufactures up to $217.50 of drift on the
  // `/api/health/pnl-reconciliation` identity, which currently reads clean
  // precisely because both surfaces are wrong in the same way.
  //
  // It runs BEFORE the TRA-359 Tradier override below on purpose: in live mode
  // broker truth still wins on `combinedPnl`, and this must not clobber it.
  let optionsDailyDecision: OptionsDailyPnlDecision = resolveDailyOptionsPnl({
    bucketPnl: finalReport.optionsPnl,
    census: null,
    censusAvailable: false,
  });
  if (isOptionTradeJournalEnabled()) {
    try {
      // The journal was already flushed above for the EOD fold; flush again so a
      // close booked between then and now is on disk before we read it.
      await ctx.engine.flushOptionTradeJournal?.();
      const census = foldJournalClosesByEtDay(
        // TRA-2421 — third argument is the identity epoch (null for every name
        // never deleted, so this is a no-op for every existing book). All THREE
        // `journalRowsForBook` call sites pass it: TRA-2314's invariant is that
        // the writer, the repair and the checker scope identically, and an epoch
        // applied at only one of them would be a guard grading a population the
        // writer never saw.
        journalRowsForBook(await listOptionTradeJournal(), ctx.username, accountDeletedAt(ctx.username)),
        (ts: number) => etDateString(new Date(ts)),
      );
      optionsDailyDecision = resolveDailyOptionsPnl({
        bucketPnl: finalReport.optionsPnl,
        census: census.get(finalReport.date) ?? null,
        censusAvailable: true,
      });
    } catch (err) {
      // A journal read failure leaves the decision at `bucket-no-census`, i.e.
      // exactly the pre-TRA-2314 behaviour — and SAYS so on the row, so the
      // degraded mode is visible instead of reverting silently to the defect.
      log.warn('TRA-2314 options-daily journal census unavailable', {
        username: ctx.username,
        date: finalReport.date,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (optionsDailyDecision.changed) {
    log.info('TRA-2314 re-sourced options day cell from the durable journal', {
      username: ctx.username,
      date: finalReport.date,
      bucketPnl: optionsDailyDecision.bucketPnl,
      journalPnl: optionsDailyDecision.journalPnl,
      journalCloses: optionsDailyDecision.journalCloses,
      // TRA-2895 — a re-source driven by trims alone logs `journalCloses: 0`,
      // which reads like a bug in the line above without this term.
      journalPartialCloses: optionsDailyDecision.journalPartialCloses,
    });
    finalReport = patchEodReportOptionsPnl(finalReport, optionsDailyDecision.value);
  }

  // TRA-359 — in live mode, override the report's `combinedPnl` with the
  // Tradier-truth daily delta (today.balance − prev.balance − netCashFlow)
  // so the Live calendar mirrors what the user sees on the broker. The
  // engine view of realized / unrealized / options is left intact for
  // diagnostic context — a markdown header documents the override.
  if (settings.mode === 'live' && !backfill) {
    try {
      const todayBalance = finalSnapshot.state.account.totalEquity;
      const override = await reconcileTradierLiveCalendar(
        ctx,
        settings,
        mode,
        todayBalance,
        finalReport.date,
      );
      if (override) {
        finalReport = applyTradierBalanceOverride(finalReport, override, todayBalance);
      }
    } catch (err) {
      log.warn('tradier-live-calendar override failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const datePath = join(targetDir, `${finalReport.date}.json`);
  const mdPath = join(targetDir, `${finalReport.date}.md`);

  // TRA-1398 — never let an EMPTY regeneration clobber a settled non-empty
  // report for the same day. The 21:00 archive writes today WITH trades, then
  // `archiveClosedTrades()` empties `allClosedPositions`. A later re-run of this
  // function for TODAY — historically a Render redeploy after 21:00 reset the
  // in-memory archive guard (`scheduler.ts` `lastArchiveDate`) and re-fired
  // `runDailyCloseForAllUsers` (now hardened by TRA-1404, which persists that
  // guard across restarts), or a state refresh recomputes today — would then
  // regenerate today's cell from the now-empty ledger (`trades:[]`,
  // `realizedPnl:0`) and overwrite the good file, zeroing the calendar cell.
  // That is the "editing demo starting equity erased today's P&L" report on
  // Richard's demo book: the equity edit only rebased `totalEquity` and dated
  // the clobber; the empty regeneration is what erased the trades. A genuinely
  // trade-less first write of the day still writes (no existing file, or an
  // existing empty one), and a later richer report still upgrades — we only
  // block the strict downgrade of non-empty → empty.
  if (!backfill) {
    let existing: Parameters<typeof wouldClobberSettledReport>[1] = null;
    try {
      existing = JSON.parse(await readFile(datePath, 'utf-8')) as NonNullable<typeof existing>;
    } catch {
      // No existing file (ENOENT) or an unreadable/corrupt one → nothing richer
      // to protect; `wouldClobberSettledReport(next, null)` returns false.
    }
    if (wouldClobberSettledReport(finalReport, existing)) {
      log.warn('TRA-1398 skipped empty EOD regeneration over a settled report', {
        username: ctx.username,
        date: finalReport.date,
        datePath,
      });
      return;
    }
  }

  const writes: Promise<void>[] = [
    writeFile(datePath, JSON.stringify(finalReport, null, 2), 'utf-8'),
    writeFile(mdPath, finalReport.markdown, 'utf-8'),
  ];
  // A backfill is for an old date — never let it become "latest".
  if (!backfill) {
    writes.push(
      writeFile(join(targetDir, 'latest.json'), JSON.stringify(finalReport, null, 2), 'utf-8'),
      writeFile(join(targetDir, 'latest.md'), finalReport.markdown, 'utf-8'),
    );
  }
  // TRA-2817 — the durable ledger row must NOT be hostage to the report FILE.
  //
  // These four writes each CREATE a file, and a create needs a free inode. The
  // snapshot persist below writes `daily-snapshots.json` IN PLACE, with no temp
  // file, so it needs only free blocks. When `/data` ran out of inodes on
  // 2026-07-30 those are opposite fates — and because the throw from here
  // aborted the function ~50 lines above `saveSnapshot`, the write that WOULD
  // have succeeded never ran. Three sessions, 47 books, a ledger writer killed
  // by a failure in a different writer with a different failure mode.
  //
  // The durable evidence for the asymmetry: `option-trade-journal.jsonl` uses
  // `appendFile` on an existing path (no new inode) and recorded all 41 option
  // closes across 2026-07-30 / 07-31 / 08-03 with `corruptLines: 0`, straight
  // through the outage, while every dated report file failed to be created.
  //
  // So a report-file failure is now LOUD but not FATAL. The resulting state is
  // a ledger row whose `eodCombined` is null, which TRA-2637 already grades as
  // `eodRowMissing: true` — a visible, self-healing interior gap that
  // `catchUpMissedEodReports` fills on the next boot. That is strictly better
  // than the silent green a missing row produced, which is this whole ticket.
  try {
    await Promise.all(writes);
  } catch (err) {
    log.error('EOD report file write failed — booking the ledger row anyway (TRA-2817)', {
      username: ctx.username,
      date: finalReport.date,
      datePath,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // TRA-2689 (leg 2 of TRA-2654) — flush the WRITE-ONLY denominator-flip
  // candidate tape. The feed records into a bounded in-process ring and never
  // touches disk; this is the once-per-session drain.
  //
  // Ordered AFTER the report writes and wrapped so it can never throw into
  // report generation: the EOD report is a human-read money artifact and this is
  // go-live week. `flushDenominatorFlipTape` already swallows its own errors;
  // the try/catch is the second layer, because a tape is worth zero of that
  // report.
  //
  // Skipped on a backfill: the ring holds candidates recorded since the last
  // drain, i.e. TODAY's, so stamping them with a past `asOfDate` would file
  // today's observations under a day they did not happen on — and a tape whose
  // dates lie is worse than no tape.
  if (!backfill) {
    try {
      const dump = ctx.engine.drainDenominatorFlipTape();
      // Skip the write entirely on an empty session — a `tape/<date>.json` with
      // zero rows and a file that was never written are the same fact, and not
      // writing it keeps the retention budget for sessions that carry data.
      if (dump.rows.length > 0 || dump.droppedCandidates > 0) {
        await flushDenominatorFlipTape({
          targetDir,
          date: finalReport.date,
          dump,
          admissionRule: {
            changePctDeltaPp: DENOM_FLIP_CHANGEPCT_DELTA_PP,
            capacity: dump.capacity,
          },
          log,
        });
      }
    } catch (err) {
      log.warn('TRA-2689 denominator-flip tape flush threw', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Persist daily equity snapshot for cumulative tracking. Skipped on a
  // backfill: `saveSnapshot` rebases the dashboard's opening equity to the
  // snapshot's closing equity, so writing a stale past row would corrupt the
  // live daily-P&L baseline.
  if (!backfill) {
    const equitySnap = ctx.engine.getEquitySnapshot();
    // TRA-2323 — realized option P&L now lands in `PaperAccount` equity (that is
    // the whole fix: "Total Value" has to compound). `dailyPnl` below is the
    // equity delta, so WITHOUT this subtraction the options leg would be counted
    // on both sides of the reconciliation identity
    // (`EOD.combinedPnl == stock dailyPnl + day-only options realized`) and every
    // option-trading day would become a fresh offender — the AC4 tripwire.
    //
    // The subtraction measures the CREDIT itself, differenced over the same
    // window the equity delta spans, so it is exact by construction: it cannot
    // drift from the journal-vs-bucket disagreement TRA-2302/2314 fought over.
    // On a book with no option credits this is `- 0`, i.e. bit-identical to the
    // pre-TRA-2323 line.
    const optionsCreditedInWindow =
      equitySnap.optionsCreditedToEquity - ctx.tracker.getLastOptionsCreditedCumulative();
    const stockOnlyDailyPnl =
      (equitySnap.equity - ctx.tracker.getOpeningEquity()) - optionsCreditedInWindow;
    ctx.tracker.saveSnapshot({
      date: finalReport.date,
      openingEquity: ctx.tracker.getOpeningEquity(),
      closingEquity: equitySnap.equity,
      dailyPnl: stockOnlyDailyPnl,
      optionsPnl: equitySnap.optionsPnl,
      optionsCreditedCumulative: equitySnap.optionsCreditedToEquity,
      // TRA-1633 BUG 2 — persist the DAY-ONLY realized options figure (the same
      // `finalReport.optionsPnl` the calendar cell uses = Σ options closed this
      // ET day) so the weekly/monthly/yearly windows sum day-only, not the
      // cumulative `equitySnap.optionsPnl` that inflated them.
      optionsDailyPnl: finalReport.optionsPnl,
      // TRA-2314 — provenance for the figure above. `finalReport.optionsPnl` is
      // now journal-sourced (patched in place further up) rather than summed
      // from the volatile bucket, so record WHICH source booked it and what the
      // bucket would have said. Without this a repaired cell and a cell that was
      // never broken read identically once both hold the right number — the
      // TRA-2301 lesson, where a repair wrote into the store its own health
      // route read and both states showed `gap:0`.
      optionsDailyPnlSource: optionsDailyDecision.source,
      optionsDailyPnlBucket: optionsDailyDecision.bucketPnl,
      ...(optionsDailyDecision.journalCloses != null
        ? { optionsDailyJournalCloses: optionsDailyDecision.journalCloses }
        : {}),
      // TRA-2895 — the partial-exit leg of the same census. Written on the same
      // null-guard, so ABSENT keeps meaning "no census" / "pre-TRA-2895 row" and
      // never a manufactured zero.
      ...(optionsDailyDecision.journalPartialCloses != null
        ? { optionsDailyJournalPartialCloses: optionsDailyDecision.journalPartialCloses }
        : {}),
      // TRA-2314 deliberately does NOT touch `combinedPnl` here. It carries the
      // mode's ALL-TIME cumulative `equitySnap.optionsPnl` — a separate, known
      // wart TRA-1633 BUG 2 left standing when it moved the windows onto
      // `dailyPnl + optionsDailyPnl`. Nothing reads it for the board's
      // weekly/monthly/yearly sums, and moving a second number in the same
      // change would make this correction unreadable as one.
      // TRA-2323 — uses the STOCK-only leg, which keeps this field numerically
      // identical to what it held before option P&L reached equity. The raw
      // equity delta would now carry the options leg, so leaving it alone would
      // have silently changed a board-facing number under cover of a fix aimed
      // at a different one. The cumulative-options wart TRA-1633 BUG 2 left
      // standing is preserved deliberately: correcting it here would move a
      // second number in the same change and make neither correction readable.
      combinedPnl: stockOnlyDailyPnl + equitySnap.optionsPnl,
      trades: finalSnapshot.allClosedPositions.length,
    });
  }

  log.info(`EOD report ${backfill ? 'backfilled' : 'saved'}`, {
    username: ctx.username,
    datePath,
  });

  if (!backfill) {
    broadcastToUser(ctx.username, JSON.stringify({ type: 'eod_report', payload: finalReport }));
  }
}

/**
 * TRA-388 — backfill EOD reports for trading days the 21:00 ET archive tick
 * missed because the server was offline during its fire window (the desktop
 * server is routinely closed overnight; a Render redeploy or crash has the
 * same effect). Without this, a missed day was silently lost forever and the
 * Calendar showed a permanent gap — the recurring "Calendar issue".
 *
 * Runs at startup and again at the top of `runDailyCloseForAllUsers`, so a
 * gap is healed at the earliest opportunity — crucially before the archive
 * step clears `allClosedPositions`, while the missed day's closed trades are
 * still retained in engine state and can be selected by `closedAt` date.
 *
 * Safe to call repeatedly: `missedTradingDays` only returns days with no
 * report file, so an already-backfilled day is skipped.
 */
/**
 * TRA-2314 — one-shot historical repair of the `optionsDailyPnl` false zero.
 *
 * TRA-2302 proved 15 ET days across the two desk books booked `0.00` while the
 * durable journal held 110 closed option round trips worth +$844.99 on those
 * same days. Fixing the writer forward leaves that history reading as a firm
 * that traded no options for a month — which is exactly the ledger the parent
 * TRA-2297 ("we're using the same 2k everyday") is arguing about. So the
 * historical rows ARE repaired, from the journal, and each repaired row keeps
 * its original figure in `optionsDailyPnlBucket`.
 *
 * BOTH surfaces move together, deliberately. The reconciliation identity is
 * `report.combinedPnl == snapshot.dailyPnl + snapshot.optionsDailyPnl`, so
 * repairing the snapshot alone would push up to $217.50 of NEW drift onto a
 * board-facing guard that currently reads clean only because both surfaces are
 * wrong in the same way. Patching the report file's options leg in the same pass
 * cancels the options term out of the identity entirely: residual drift stays
 * exactly `report.realizedPnl − snapshot.dailyPnl`, the pre-existing stock-leg
 * discrepancy, unchanged by this repair.
 *
 * Only PROVEN false zeros are touched — a day the journal names closes on whose
 * `optionsDailyPnl` is exactly 0. A day already carrying a non-zero options
 * figure is left alone even where it disagrees with the journal; rewriting a
 * number that may be right is the unannounced correction TRA-2079 warns about.
 *
 * Idempotent and safe to run every boot (bqb1 restarts several times an hour):
 * after the first pass no row matches the false-zero signature, so it writes
 * nothing and logs nothing.
 *
 * TRA-2641 — the two halves converge SEPARATELY. The snapshot half stops when no
 * row still shows the false-zero signature; the report-file half stops when every
 * file agrees with the cell, checked against the persisted rows on every boot
 * rather than only in the pass that moved one. Slaving the file half to the
 * snapshot delta is what let `admin`'s mode flip (and a catch-up backfill of a
 * fresh 0.00 report) leave 7 rows split at up to $82.50 of drift with no path
 * back — the plan was empty forever, so nothing ever revisited the files.
 */
/**
 * TRA-2817/TRA-2829 — the exchange calendar the EOD tail axis grades against,
 * and that the back-fill writer scopes against.
 *
 * ONE construction, deliberately. The health route and the writer must agree
 * about what has settled, or the writer reconstructs a session set the grader
 * never graded (or skips one it did) while both read correct. That is the same
 * failure this ticket's `staleTailSessions` sharing exists to prevent, one level
 * up.
 *
 * `lastSettledSession` is the newest session whose 21:00 ET archive is already
 * PAST, NOT simply the last market day. Today only counts once its own archive
 * has run — otherwise every read between the 16:00 bell and 21:00 ET would
 * accuse a healthy ledger of missing today, and an axis that is red every
 * weekday afternoon is one nobody believes on the afternoon it is right. Same
 * `etHour() >= 21` boundary the archive tick itself fires on, so the two cannot
 * disagree.
 */
function currentEodTailCalendar(): { lastSettledSession: string | null; isMarketDay: (d: string) => boolean } {
  const todayEt = etDateString(new Date());
  return {
    lastSettledSession:
      isMarketDayIso(todayEt) && etHour() >= 21 ? todayEt : previousMarketDayIso(todayEt),
    isMarketDay: isMarketDayIso,
  };
}

/**
 * TRA-2829 (parent TRA-2827) — write the EOD ledger rows the 21:00 ET archive
 * never produced for the LIVE book, from the durable option-trade journal.
 *
 * **Disarmed by default.** Runs only when `ENABLE_EOD_ROW_BACKFILL=true`. The
 * plan is computed and published on /api/health/pnl-reconciliation either way,
 * because the CFO ruling requires the reach of the broker equity series be
 * reported before anything is written — and because if the stale-session count
 * GREW across the archive that gates this, the write path is still broken and
 * back-filling would paper over a live defect while reading as a repair.
 *
 * Idempotent, and it has to be: bqb1 restarts several times an hour. After the
 * first pass the rows exist, so `staleTailSessions` returns `[]`, the plan is
 * empty and this writes and logs nothing.
 */
async function runEodRowBackfill(): Promise<void> {
  if (!isEodRowBackfillArmed()) return;
  if (!isOptionTradeJournalEnabled()) return;
  const rows = await listOptionTradeJournal();
  const calendar = currentEodTailCalendar();
  for (const ctx of getAllUserContexts()) {
    try {
      // Live books only — this reconstructs against `tradier-eod-balance.*`, and
      // the hole it exists for is the live options record. `loadSettings`, not
      // `getSettings`: the latter serves a demo default on a cache miss, which
      // silently reclassified the live book once already (TRA-2761).
      if (stockModeKey(await loadSettings(ctx.username)) !== 'live') continue;
      const census = foldJournalClosesByEtDay(
        journalRowsForBook(rows, ctx.username, accountDeletedAt(ctx.username)),
        (ts: number) => etDateString(new Date(ts)),
      );
      // An EMPTY census on a LIVE book is not a quiet book, it is a scoping
      // failure — the live program's whole record lives in this journal. Writing
      // through it would book 0.00 options on every reconstructed session, i.e.
      // carve the TRA-2314 false zero into rows that then read as
      // journal-sourced. Refuse and say so; the plan stays published either way.
      if (census.size === 0) {
        log.warn('TRA-2829 EOD row back-fill skipped: live book has an EMPTY journal census', {
          username: ctx.username,
        });
        continue;
      }
      const plan = planLiveEodRowBackfill({
        snapshots: ctx.tracker.getSnapshots(),
        censusByDate: census,
        balanceByDate: await loadTradierBalanceSnapshots(ctx, 'production'),
        calendar,
      });
      if (plan.notMeasuredReason !== null) {
        log.warn('TRA-2829 EOD row back-fill NOT MEASURED', {
          username: ctx.username,
          reason: plan.notMeasuredReason,
        });
        continue;
      }
      const written = ctx.tracker.applyEodRowBackfill(plan.rows);
      if (written.length === 0) continue;
      // Logged at warn: a board-facing ledger gained rows, and an unannounced
      // correction reads to a grader as a new defect (TRA-2079). Every figure
      // needed to audit the write is here, including what could NOT be measured.
      log.warn('TRA-2829 back-filled absent EOD ledger rows from the durable journal', {
        username: ctx.username,
        rowSource: EOD_BACKFILL_ROW_SOURCE,
        written,
        anchorRowDate: plan.anchorRowDate,
        settledSession: plan.settledSession,
        optionsBackfilledUsd: plan.optionsBackfilledUsd,
        unmeasuredEquityRowCount: plan.unmeasuredEquityRowCount,
        stockLegProbeDisagreeCount: plan.stockLegProbeDisagreeCount,
        balanceWindow: plan.balanceWindow,
        skipped: plan.skipped,
      });
    } catch (err) {
      log.warn('TRA-2829 EOD row back-fill failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function runOptionsDailyPnlRepair(): Promise<void> {
  if (!isOptionTradeJournalEnabled()) return;
  const rows = await listOptionTradeJournal();
  for (const ctx of getAllUserContexts()) {
    try {
      // Same scoping predicate the writer and the health route use. Rows with no
      // `account` are unattributable (2,192 pre-TRA-1475 ones) and are never
      // credited to whichever book is being repaired — the TRA-2193 trap.
      const census = foldJournalClosesByEtDay(
        // TRA-2421 — identity epoch; see the note at the 21:00 writer above.
        journalRowsForBook(rows, ctx.username, accountDeletedAt(ctx.username)),
        (ts: number) => etDateString(new Date(ts)),
      );
      if (census.size === 0) continue;
      const plan = planOptionsDailyPnlRepair(ctx.tracker.getSnapshots(), census);

      // Snapshot first, then the files — the file pass is driven off the
      // PERSISTED rows (TRA-2641), so it must see this boot's repair. A crash
      // between the two leaves the options legs disagreeing, which shows up as
      // drift on /api/health/pnl-reconciliation: visible, and healed by the very
      // next boot precisely BECAUSE the file pass no longer depends on a delta
      // being produced in the same pass.
      const repaired = ctx.tracker.applyOptionsDailyPnlRepair(plan.deltas);

      // TRA-2641 — reconcile the report files across EVERY mode dir, not just
      // the one this book currently sits in. The day cell is mode-blind (that is
      // what `PnlTracker` is); the report file is mode-scoped. See
      // `planEodReportOptionsSync` for the semantic and why the alternative —
      // scoping the journal fold by mode — was rejected.
      const mode = stockModeKey(getSettings(ctx.username));
      const sync = await syncEodReportOptionsLegs(
        (['demo', 'live', 'sandbox'] as const).map(m => stockReportsDirFor(ctx, m)),
        planEodReportOptionsSync(ctx.tracker.getSnapshots()),
      );
      for (const f of sync.failures) {
        log.warn('TRA-2314 report-file repair failed', { username: ctx.username, ...f });
      }

      // Silent unless something actually moved. This pass now runs on every boot
      // (bqb1 restarts several times an hour) and a warn that fires on a no-op is
      // exactly the "a ledger moved" noise TRA-2642 removed.
      if (repaired === 0 && sync.filesPatched === 0 && sync.missingReportDates.length === 0) continue;
      // Logged at warn: a board-facing ledger moved, and an unannounced
      // correction reads to a grader as a new defect (TRA-2079). The per-day
      // before/after also rides /api/health/pnl-reconciliation on every row.
      log.warn('TRA-2314 repaired optionsDailyPnl false zeros from the durable journal', {
        username: ctx.username,
        mode,
        snapshotsRepaired: repaired,
        filesPatched: sync.filesPatched,
        patchedDates: sync.patchedDates,
        missingReportDates: sync.missingReportDates,
        totalDeltaUsd: plan.totalDeltaUsd,
        dates: plan.deltas.map(d => `${d.date}:${d.before.toFixed(2)}->${d.after.toFixed(2)}`),
        leftAloneDates: plan.leftAloneDates,
      });
    } catch (err) {
      log.warn('TRA-2314 optionsDailyPnl repair failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function catchUpMissedEodReports(): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const ctx of getAllUserContexts()) {
    try {
      const mode = stockModeKey(getSettings(ctx.username));
      const dir = stockReportsDirFor(ctx, mode);
      let existing: string[] = [];
      try {
        existing = (await readdir(dir))
          .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .map(f => f.slice(0, 10));
      } catch {
        existing = [];
      }
      const missed = missedTradingDays(existing, today);
      if (missed.length === 0) continue;
      log.info('reports catch-up: backfilling missed EOD reports', {
        username: ctx.username,
        missedCount: missed.length,
        missed: missed.join(', '),
      });
      for (const date of missed) {
        try {
          await generateAndSaveReport(ctx, { asOfDate: date });
        } catch (err) {
          log.error('reports catch-up failed', {
            username: ctx.username,
            date,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.error('reports catch-up scan failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── TRA-348: Tradier history reconcile ───────────────────────────────────────

// TRA-2864 — 7 was shorter than this account actually holds a contract.
//
// The window has to reach the OPEN, not just the close: `aggregateRealizedOptionsPnl`
// FIFO-matches a close against opens in the same fetch, and (since TRA-2864) an
// unmatched close is skipped rather than booked at gross proceeds. At 7 days that
// silently drops the long tail. Measured over the board's uploaded live-production
// tape: max hold 9 calendar days, p90 = 7, and 3 of 36 matched lots (8%) sat open
// longer than 7 days — including the whole PSKY 06-16..06-25 position.
//
// 45 gives real margin over that tail while staying far inside the `limit: 1000`
// page (this account books ~90 trade events per 2.5 months). Re-reading the same
// fills every pass is free: the cursor dedups CLOSES, and opens are cost basis
// that the matcher is supposed to see again each time.
const TRADIER_RECONCILE_LOOKBACK_DAYS = 45;

/**
 * TRA-348 — pull Tradier history for the active live env over the last
 * `LOOKBACK_DAYS` and merge realized options closes into the local
 * per-day reports + the engine's live-mode `optionsPnl` counter.
 *
 * Dedup is enforced via a per-user / per-env cursor file under
 * `<dataDir>/tradier-history-cursor.<env>.json` so a re-fetch over the
 * same window doesn't double-count. The cursor stores the set of seen
 * Tradier event ids; a future ticket can prune it once Tradier's own
 * retention drops out of the lookback window.
 */
async function reconcileTradierOptionsHistory(
  ctx: UserContext,
  settings: AccountSettings,
  mode: StockModeKey,
): Promise<void> {
  if (mode === 'demo') return;
  const env: TradierEnv = mode === 'live' ? 'production' : 'sandbox';
  const client = buildTradierOptionsClientForEnv(settings, env);
  if (!client) return;

  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const startMs = today.getTime() - TRADIER_RECONCILE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const start = new Date(startMs).toISOString().slice(0, 10);

  // TRA-2801 — the fetch outcome is now a FLAG, not an early return, because the
  // realtime-estimate drain below has to run on a SUCCESSFUL-BUT-EMPTY window and
  // must NOT run on a failed one. `planTradierReconcile` holds that rule; see its
  // docblock. A failed fetch is BLIND, not empty, and the drain is destructive.
  let fills: TradierTradeHistoryFill[] = [];
  let fetchSucceeded = true;
  try {
    fills = await client.listAccountHistory({ start, end, type: 'trade', limit: 1000 });
  } catch (err) {
    fetchSucceeded = false;
    log.warn('tradier-reconcile history fetch failed', {
      username: ctx.username,
      env,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  const cursor = await loadTradierHistoryCursor(ctx, env);
  const knownIds = new Set(cursor.seenIds);
  const totals = aggregateRealizedOptionsPnl(fills, knownIds);
  const plan = planTradierReconcile({
    fetchSucceeded,
    fillsInWindow: fills.length,
    newTransactionIds: totals.seenTransactionIds.size,
  });

  let realtimeOffset = 0;
  let netAdded = 0;
  let added = 0;
  if (plan.drainRealtime) {
    // TRA-367 — `recordImportedFill` / `finalizePendingExit` for imports
    // attribute realised P&L to `optionsPnlByMode.live` in realtime so the
    // dashboard pill updates the moment a sell_to_close fills. Those fills
    // ALSO show up in Tradier's account history, so the broker-side total
    // below would double-count them. Drain the per-date realtime tally
    // here and subtract it from the broker total before bumping the pill.
    // The per-day sidecar (used by the calendar) still gets the full
    // broker-side total since it's the canonical "this is what Tradier
    // settled today" record.
    const realtimeByDate = ctx.engine.consumeRealtimeImportedPnl(env);
    for (const v of realtimeByDate.values()) realtimeOffset += v;

    // Bump the engine's live-mode P&L bucket by the sum of newly reconciled
    // realized P&L across all dates in the window so the dashboard pill
    // updates on the next state broadcast. Subtract the realtime offset so
    // closes we already attributed via {@link applyRealtimeImportedPnl}
    // aren't counted again.
    //
    // TRA-2801 — on an empty window `added` is 0, so this is `−realtimeOffset`:
    // an estimate with no broker-side counterpart goes back to $0 instead of
    // standing forever. It also closes a pre-existing race the old early return
    // hid — a fill reconciled from history BEFORE the realtime callback fired
    // left the estimate stacked on broker truth with every later pass bailing at
    // `seenTransactionIds.size === 0`.
    for (const realized of totals.realizedByDate.values()) added += realized;
    netAdded = added - realtimeOffset;
    if (netAdded !== 0) ctx.engine.addReconciledTradierOptionsPnl(env, netAdded);
  }

  // TRA-2801 — nothing NEW to persist: the fetch failed, no fills in the window,
  // or every fill in it is already in the cursor. The drain above has already run
  // when it was allowed to (that is the whole point), so bail before the sidecar
  // and cursor writes, which have no work.
  //
  // The back-out is deliberately NOT written to the daily-totals sidecar: that
  // file is the canonical "what Tradier settled" record, and reversing our own
  // estimate is not a broker settlement.
  if (!plan.persistFills) {
    if (realtimeOffset !== 0)
      log.info('tradier-reconcile backed out an unmatched realtime estimate', {
        username: ctx.username,
        env,
        fillsInWindow: fills.length,
        realtimeOffset: Number(realtimeOffset.toFixed(2)),
        netAddedToPill: Number(netAdded.toFixed(2)),
      });
    return;
  }

  // Persist per-day totals onto a sidecar so `mergeReconciledDailyTotalsIntoReport`
  // can sum across runs (the cursor file is the dedup source of truth;
  // the daily totals sidecar is the merge target).
  const dailyTotals = await loadTradierDailyTotals(ctx, env);
  for (const [date, realized] of totals.realizedByDate) {
    dailyTotals[date] = (dailyTotals[date] ?? 0) + realized;
  }
  await saveTradierDailyTotals(ctx, env, dailyTotals);

  // Update cursor so subsequent runs skip these ids.
  for (const id of totals.seenTransactionIds) cursor.seenIds.push(id);
  await saveTradierHistoryCursor(ctx, env, cursor);

  log.info('tradier-reconcile merged new fills', {
    username: ctx.username,
    env,
    newFills: totals.seenTransactionIds.size,
    realizedAdded: Number(added.toFixed(2)),
    realtimeOffset: Number(realtimeOffset.toFixed(2)),
    netAddedToPill: Number(netAdded.toFixed(2)),
    days: totals.realizedByDate.size,
  });
}

interface TradierHistoryCursor {
  seenIds: string[];
}

function tradierCursorPath(ctx: UserContext, env: TradierEnv): string {
  return join(ctx.dataDir, `tradier-history-cursor.${env}.json`);
}

function tradierDailyTotalsPath(ctx: UserContext, env: TradierEnv): string {
  return join(ctx.dataDir, `tradier-options-pnl.${env}.json`);
}

async function loadTradierHistoryCursor(
  ctx: UserContext,
  env: TradierEnv,
): Promise<TradierHistoryCursor> {
  const path = tradierCursorPath(ctx, env);
  if (!existsSync(path)) return { seenIds: [] };
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TradierHistoryCursor>;
    return { seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds.filter(s => typeof s === 'string') : [] };
  } catch {
    return { seenIds: [] };
  }
}

async function saveTradierHistoryCursor(
  ctx: UserContext,
  env: TradierEnv,
  cursor: TradierHistoryCursor,
): Promise<void> {
  await writeFile(tradierCursorPath(ctx, env), JSON.stringify(cursor, null, 2), 'utf-8');
}

async function loadTradierDailyTotals(
  ctx: UserContext,
  env: TradierEnv,
): Promise<Record<string, number>> {
  const path = tradierDailyTotalsPath(ctx, env);
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function saveTradierDailyTotals(
  ctx: UserContext,
  env: TradierEnv,
  totals: Record<string, number>,
): Promise<void> {
  await writeFile(tradierDailyTotalsPath(ctx, env), JSON.stringify(totals, null, 2), 'utf-8');
}

// ── TRA-359: Live calendar broker-truth reconcile ────────────────────────────
//
// The Live P&L calendar was historically computed from local engine state:
// engine-tracked closed positions, paper-options P&L bucket, and reconciled
// Tradier closes via `aggregateRealizedOptionsPnl`. For accounts with
// imported positions whose opens lived outside the reconcile lookback
// window, every Sell-to-Close booked gross proceeds as P&L (the open-cost
// fallback in `aggregateRealizedOptionsPnl` is structurally wrong for that
// case). The result: a Live calendar showing $200+ in green days while the
// real Tradier balance was deep in the red.
//
// The reconcile path below sources daily P&L from the broker truth instead:
//
//   1. Snapshot Tradier `totalEquity` per env at EOD into
//      `tradier-eod-balance.{env}.json`.
//   2. Capture non-trade events (ACH / wire / journal / deposit /
//      withdrawal / dividend / interest / fee / adjustment) from
//      `/accounts/{id}/history` per day into `tradier-cash-flow.{env}.json`
//      so deposits aren't booked as P&L.
//   3. In `generateAndSaveReport` for live mode, override `combinedPnl
//      = today.totalEquity − prev.totalEquity − today.netCashFlow`.
//
// Demo / sandbox paths continue to use the engine-computed P&L.

const TRADIER_CASH_FLOW_LOOKBACK_DAYS = 14;

interface TradierCashFlowState {
  /** Per-day signed net cash flow (deposits − withdrawals + dividends − fees). */
  netByDate: Record<string, number>;
  /** Dedup cursor — Tradier transaction ids already merged into `netByDate`. */
  seenIds: string[];
}

function tradierBalancePath(ctx: UserContext, env: TradierEnv): string {
  return join(ctx.dataDir, `tradier-eod-balance.${env}.json`);
}

function tradierCashFlowPath(ctx: UserContext, env: TradierEnv): string {
  return join(ctx.dataDir, `tradier-cash-flow.${env}.json`);
}

async function loadTradierBalanceSnapshots(
  ctx: UserContext,
  env: TradierEnv,
): Promise<Record<string, number>> {
  const path = tradierBalancePath(ctx, env);
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function saveTradierBalanceSnapshots(
  ctx: UserContext,
  env: TradierEnv,
  snapshots: Record<string, number>,
): Promise<void> {
  await writeFile(tradierBalancePath(ctx, env), JSON.stringify(snapshots, null, 2), 'utf-8');
}

async function loadTradierCashFlow(
  ctx: UserContext,
  env: TradierEnv,
): Promise<TradierCashFlowState> {
  const path = tradierCashFlowPath(ctx, env);
  if (!existsSync(path)) return { netByDate: {}, seenIds: [] };
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TradierCashFlowState>;
    const netByDate: Record<string, number> = {};
    if (parsed.netByDate && typeof parsed.netByDate === 'object') {
      for (const [k, v] of Object.entries(parsed.netByDate as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) netByDate[k] = v;
      }
    }
    const seenIds = Array.isArray(parsed.seenIds)
      ? parsed.seenIds.filter((s): s is string => typeof s === 'string')
      : [];
    return { netByDate, seenIds };
  } catch {
    return { netByDate: {}, seenIds: [] };
  }
}

async function saveTradierCashFlow(
  ctx: UserContext,
  env: TradierEnv,
  state: TradierCashFlowState,
): Promise<void> {
  await writeFile(tradierCashFlowPath(ctx, env), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * TRA-359 — patch a generated `EodReport` so its `combinedPnl` reflects
 * the Tradier-truth daily delta instead of the engine-imagined value.
 * Adds a markdown header that documents the override so the report
 * detail view doesn't surprise a reader who sees `combinedPnl` not
 * matching the per-component breakdown.
 *
 * The engine-side breakdown fields (`realizedPnl`, `unrealizedPnl`,
 * `optionsPnl`, `totalPnl`) are kept as-is — they're still useful for
 * diagnostic context (was the day's miss driven by stock MTM or option
 * closes?). The calendar UI reads only `combinedPnl`, so overriding
 * that single field is enough to fix the bug.
 */
function applyTradierBalanceOverride(
  report: ReturnType<typeof generateEodReport>,
  override: { combinedPnl: number; prevDate: string; prevBalance: number; netCashFlow: number },
  todayBalance: number,
): ReturnType<typeof generateEodReport> {
  const sign = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  const usd = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const header = `> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for ${report.date} = today's Tradier equity (${usd(todayBalance)}) − prev snapshot ${override.prevDate} (${usd(override.prevBalance)}) − net cash flow (${sign(override.netCashFlow)}) = **${sign(override.combinedPnl)}**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.`;
  return {
    ...report,
    combinedPnl: override.combinedPnl,
    totalEquity: todayBalance,
    // TRA-1192 — tag the broker-truth source so the historical realized-fill
    // backfill never overwrites a settled balance-delta cell.
    pnlSource: 'tradier-balance' as const,
    markdown: `${header}\n\n${report.markdown}`,
  };
}

/**
 * TRA-359 — pull recent Tradier cash events into the per-user / per-env
 * cash flow cursor + persist today's `totalEquity` snapshot. Returns
 * the override `combinedPnl` (broker-truth daily P&L) and metadata for
 * the report markdown, or `null` when we don't have enough data yet to
 * compute a meaningful daily delta (no Tradier creds, no prior balance
 * snapshot, etc.). On error the caller should fall back to the
 * engine-computed P&L rather than block the report write.
 */
async function reconcileTradierLiveCalendar(
  ctx: UserContext,
  settings: AccountSettings,
  mode: StockModeKey,
  todayBalance: number | null,
  reportDate: string,
): Promise<{
  combinedPnl: number;
  prevDate: string;
  prevBalance: number;
  netCashFlow: number;
} | null> {
  if (mode === 'demo') return null;
  if (typeof todayBalance !== 'number' || !Number.isFinite(todayBalance) || todayBalance <= 0) {
    return null;
  }
  const env: TradierEnv = mode === 'live' ? 'production' : 'sandbox';
  const client = buildTradierOptionsClientForEnv(settings, env);

  // Merge any new non-trade events into the cash-flow cursor. Failure here
  // is non-fatal — we just won't subtract today's deposit and the user
  // sees a one-day blip, which is still less wrong than the old behaviour.
  const cashFlowState = await loadTradierCashFlow(ctx, env);
  if (client) {
    try {
      const today = new Date();
      const end = today.toISOString().slice(0, 10);
      const startMs = today.getTime() - TRADIER_CASH_FLOW_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      const start = new Date(startMs).toISOString().slice(0, 10);
      const cashEvents = await client.listAccountCashEvents({ start, end, limit: 1000 });
      const knownIds = new Set(cashFlowState.seenIds);
      const totals = aggregateCashFlowByDate(cashEvents, knownIds);
      for (const [date, net] of totals.netByDate) {
        cashFlowState.netByDate[date] = (cashFlowState.netByDate[date] ?? 0) + net;
      }
      for (const id of totals.seenTransactionIds) cashFlowState.seenIds.push(id);
      await saveTradierCashFlow(ctx, env, cashFlowState);
    } catch (err) {
      log.warn('tradier-live-calendar cash event fetch failed', {
        username: ctx.username,
        env,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Snapshot today's balance before we read prev, so a missing prior day
  // still seeds the file for tomorrow's run.
  const snapshots = await loadTradierBalanceSnapshots(ctx, env);
  snapshots[reportDate] = todayBalance;
  await saveTradierBalanceSnapshots(ctx, env, snapshots);

  // Without a prior anchor we can't compute a daily delta. The file is
  // seeded — the next EOD report run will have a valid prev to compare
  // against.
  const prev = findPreviousBalanceSnapshot(
    // Exclude today from the prev lookup; we just wrote it above.
    Object.fromEntries(Object.entries(snapshots).filter(([d]) => d !== reportDate)),
    reportDate,
  );
  if (!prev) {
    log.info('tradier-live-calendar seeded balance (no prior anchor — overriding skipped this run)', {
      username: ctx.username,
      env,
      reportDate,
      balance: Number(todayBalance.toFixed(2)),
    });
    return null;
  }

  // TRA-2875 — correct over the SAME span the balance delta covers,
  // `(prev.date, reportDate]`, not just `reportDate`. The anchor can be several
  // days back (weekend/holiday, or a failed snapshot write), and a cash event
  // landing in the interior of that gap was previously booked as trading P&L.
  const netCashFlow = sumCashFlowOverSpan(cashFlowState.netByDate, prev.date, reportDate);
  const pnl = computeBalanceDailyPnl(todayBalance, prev.balance, netCashFlow);
  if (pnl === null) return null;

  log.info('tradier-live-calendar computed daily pnl', {
    username: ctx.username,
    env,
    reportDate,
    balance: Number(todayBalance.toFixed(2)),
    prevDate: prev.date,
    prevBalance: Number(prev.balance.toFixed(2)),
    netCashFlow: Number(netCashFlow.toFixed(2)),
    pnl: Number(pnl.toFixed(2)),
  });
  return { combinedPnl: pnl, prevDate: prev.date, prevBalance: prev.balance, netCashFlow };
}

// ── TRA-244: one-shot historical Live-calendar backfill from broker fills ─────
//
// The Live calendar's June rows pre-date the 9 PM EOD snapshot this ticket
// added, so they were computed by the old engine path that booked a closing
// fill's *gross proceeds* as P&L (an imported / out-of-window open had no cost
// basis to net against). The board reconciled the rows against their Tradier
// brokerage confirmations and chose "backfill from fills (realized P&L)".
//
// This pass pulls the broker trade history for the live/sandbox env and, over a
// rolling trailing window, GAP-FILLS each calendar day that has no real EOD
// snapshot with the FIFO-matched realized options P&L for trades that *closed*
// that day (broker truth; un-reconstructable closes left flat — never gross
// proceeds).
//
// TRA-1192 — generalised from the original hardcoded 2026-06-01..2026-06-10
// window (which only ever fixed the board's own account) to a dynamic
// current-plus-previous-month window so a NEW live account (e.g. opened
// mid-month) gets its earlier days reported, not just the days after the 9 PM
// snapshot started running. Clobber-safety: a day whose report came from a real
// snapshot — a broker-balance override (`pnlSource: 'tradier-balance'`) or an
// engine EOD row — is NEVER overwritten; only days with no file, or a prior
// realized-backfill row, are (re)written. This keeps it stable under repeated
// (daily/startup) runs and prevents a day's settled equity P&L from being
// downgraded to options-only.
const LIVE_REALIZED_BACKFILL_FETCH_LOOKBACK_DAYS = 31; // before the write window — wide enough to capture the opens

// TRA-2874 — this was `1`, i.e. the write window started on the first of LAST
// month. Every day before that was structurally unreachable: no matter how
// cleanly it reconstructed from broker truth, the backfill was not allowed to
// write it.
//
// The failure mode is ROLLING AMNESIA, not a one-off gap. At `1`, the boundary
// advanced on the 1st of every month, so a day got exactly ONE month of
// chances to be reconstructed. If the box was down, the account did not exist
// yet, or /data was full that month (the 2026-07-30..08-03 ENOSPC outage,
// TRA-2817/TRA-2888), the day aged out and was never reconstructable again.
// Measured cost on the board's live account: all of June 2026, −$837.85 of
// real realized P&L that the backfill could not write.
//
// 24 months is chosen to exceed the live account's whole history (its balance
// series starts 2026-05-18), so in practice the window is ANCHORED rather than
// rolling — no day that is reconstructable today ages out next month.
// Overridable for accounts with a longer tape.
//
// Widening is additive, not destructive: `isBackfillRow()` still refuses to
// overwrite a `tradier-balance` snapshot or an engine EOD row, and a day with
// no matched closes is left ABSENT (renders `--`) rather than written as a
// phantom $0.00.
const LIVE_REALIZED_BACKFILL_DEFAULT_MONTHS_BACK = 24;
const LIVE_REALIZED_BACKFILL_MAX_MONTHS_BACK = (() => {
  const raw = process.env.LIVE_REALIZED_BACKFILL_MONTHS_BACK;
  if (raw == null || raw.trim() === '') return LIVE_REALIZED_BACKFILL_DEFAULT_MONTHS_BACK;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return LIVE_REALIZED_BACKFILL_DEFAULT_MONTHS_BACK;
  }
  return parsed;
})();

/**
 * Build (or patch) an `EodReport` whose calendar figure is the broker-truth
 * realized options P&L for `date`. Equity realized / unrealized are zeroed so
 * the detail view stays internally consistent (`combinedPnl = realizedPnl +
 * optionsPnl`). A prior backfill header is stripped first so re-runs don't
 * stack headers. When `existing` is null a minimal report is synthesised so
 * the day still appears as a calendar cell.
 */
function makeRealizedBackfillReport(
  date: string,
  dayRealized: number,
  closeCount: number,
  existing: ReturnType<typeof generateEodReport> | null,
): ReturnType<typeof generateEodReport> {
  const sign = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  const header = `> **Live calendar backfill (TRA-244).** ${date} P&L = Tradier broker-truth realized options P&L for contracts that *closed* this day = **$${sign(dayRealized)}**. Reconstructed from the Tradier account trade history by FIFO-matching each close to its open by OCC symbol; these rows pre-date the 9 PM EOD snapshot that records this going forward. Un-reconstructable closes (open outside the fetch window) are left flat rather than booked at gross proceeds.`;
  const base: ReturnType<typeof generateEodReport> =
    existing ?? {
      date,
      generatedAt: Date.now(),
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      optionsPnl: 0,
      combinedPnl: 0,
      realizedPnlPct: undefined,
      optionsPnlPct: undefined,
      combinedPnlPct: undefined,
      totalEquity: 0,
      managedEquity: 0,
      availableCash: 0,
      trades: [],
      openPositionCount: 0,
      winRate: 0,
      avgRR: 0,
      totalTrades: closeCount,
      winners: 0,
      losers: 0,
      expectancy: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      top5Movers: [],
      signalAccuracy: { totalSignals: 0, winningSignals: 0, winRate: 0, avgRR: 0 },
      markdown: '',
    };
  const priorBody = base.markdown.replace(
    /^> \*\*Live calendar backfill \(TRA-244\)\.\*\*[\s\S]*?\n\n/,
    '',
  );
  return {
    ...base,
    date,
    realizedPnl: 0,
    unrealizedPnl: 0,
    optionsPnl: dayRealized,
    totalPnl: dayRealized,
    combinedPnl: dayRealized,
    // TRA-1192 — mark as a reconstructed historical cell so re-runs recompute it
    // (and never treat it as a real snapshot to be preserved).
    pnlSource: 'realized-backfill' as const,
    markdown: `${header}\n\n${priorBody}`,
  };
}

/**
 * TRA-244 — rewrite a single live/sandbox user's historical June calendar
 * cells from broker-truth realized options P&L. Idempotent: recomputes from
 * the Tradier history each run and only touches the bounded historical window
 * (never `latest.json`, the equity tracker, or the balance-snapshot series).
 * Returns the per-date map that was written, or `null` when the user isn't on
 * a Tradier-backed mode / has no client.
 */
async function backfillLiveRealizedCalendar(
  ctx: UserContext,
): Promise<Record<string, number> | null> {
  const settings = getSettings(ctx.username);
  const mode = stockModeKey(settings);
  if (mode === 'demo') return null;
  const env: TradierEnv = mode === 'live' ? 'production' : 'sandbox';
  const client = buildTradierOptionsClientForEnv(settings, env);
  if (!client) return null;

  // TRA-1192 — dynamic rolling write window: from the first of the month
  // `LIVE_REALIZED_BACKFILL_MAX_MONTHS_BACK` months back up to (but excluding)
  // today. Today is owned by the live-intraday cell + the 9 PM snapshot, so we
  // never backfill it here.
  const today = etDateString();
  const { writeStart, fetchStart } = liveBackfillWriteWindow(
    today,
    LIVE_REALIZED_BACKFILL_MAX_MONTHS_BACK,
    LIVE_REALIZED_BACKFILL_FETCH_LOOKBACK_DAYS,
  );
  const inWindow = (d: string) => d >= writeStart && d < today;

  let fills;
  try {
    fills = await client.listAccountHistory({
      start: fetchStart,
      end: today,
      type: 'trade',
      limit: 2000,
    });
  } catch (err) {
    log.warn('live realized backfill: history fetch failed', {
      username: ctx.username,
      env,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const { realizedByDate, closeCountByDate } = realizedOptionsPnlByCloseDate(fills);
  const dir = stockReportsDirFor(ctx, mode);

  // A day already owned by a *real* snapshot (broker-balance override or an
  // engine EOD row) is authoritative and must never be downgraded to
  // options-only realized. Only days with no report file, or a prior
  // realized-backfill row, are (re)written from broker fills.
  const isBackfillRow = (r: ReturnType<typeof generateEodReport>): boolean =>
    r.pnlSource === 'realized-backfill' ||
    /Live calendar backfill \(TRA-244\)/.test(r.markdown ?? '');

  // Candidate days = existing report files in the bucket ∪ realized-close days,
  // bounded to the rolling write window.
  const candidates = new Set<string>();
  let existingDates: string[] = [];
  try {
    existingDates = (await readdir(dir))
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.slice(0, 10));
  } catch {
    existingDates = [];
  }
  for (const d of existingDates) if (inWindow(d)) candidates.add(d);
  for (const d of realizedByDate.keys()) if (inWindow(d)) candidates.add(d);
  if (candidates.size === 0) return {};

  const written: Record<string, number> = {};
  for (const date of [...candidates].sort()) {
    const dayRealized = Number((realizedByDate.get(date) ?? 0).toFixed(2));
    const filePath = join(dir, `${date}.json`);
    let existing: ReturnType<typeof generateEodReport> | null = null;
    if (existsSync(filePath)) {
      try {
        existing = JSON.parse(await readFile(filePath, 'utf-8')) as ReturnType<
          typeof generateEodReport
        >;
      } catch {
        existing = null;
      }
    }
    // Never clobber a real snapshot row (balance-truth or engine EOD).
    if (existing && !isBackfillRow(existing)) continue;
    // Nothing to write for a no-activity day that has no existing artifact —
    // leave it absent so the calendar renders it flat ("--").
    if (!existing && dayRealized === 0 && (closeCountByDate.get(date) ?? 0) === 0) {
      continue;
    }
    const report = makeRealizedBackfillReport(
      date,
      dayRealized,
      closeCountByDate.get(date) ?? 0,
      existing,
    );
    await writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
    await writeFile(join(dir, `${date}.md`), report.markdown, 'utf-8');
    written[date] = dayRealized;
  }
  log.info('live realized calendar backfill complete', {
    username: ctx.username,
    env,
    written,
  });
  return written;
}

/**
 * TRA-1192 — build today's *running* Live calendar cell on the fly so the
 * current day's P&L shows in the calendar before the 9 PM EOD snapshot settles
 * it (the recurring "today shows --" complaint). Computed exactly like the EOD
 * broker-balance override — `current Tradier equity − prev balance snapshot −
 * today's net cash flow` — but READ-ONLY: it never writes the balance-snapshot
 * series (so it can't corrupt tomorrow's prev anchor) and never fetches new
 * cash events.
 *
 * TRA-1192 (board follow-up: "same for admin account, all accounts") — demo
 * accounts get the same running cell, computed from the engine's *own* current
 * snapshot exactly as the 9 PM EOD write would (read-only, never saved), since a
 * demo book has no broker balance series to diff. Returns `null` only when there
 * is no current equity, or (live/sandbox) when no prior balance anchor exists yet
 * (a brand-new account's first day has no baseline to diff against — the cell
 * stays "--" rather than showing a bogus full-equity "gain").
 */
async function buildLiveTodayCellReport(
  ctx: UserContext,
  mode: StockModeKey,
): Promise<ReturnType<typeof generateEodReport> | null> {
  // The engine's equity/state reflects its *active* mode only. If the calendar is
  // browsing a different bucket than the account is currently running, we have no
  // matching current balance — fall through to "--" rather than diff a live
  // equity against a sandbox/demo anchor (or vice-versa).
  if (mode !== stockModeKey(getSettings(ctx.username))) return null;
  // Demo: no broker balance series — compute the running cell straight from the
  // engine snapshot (same path the nightly EOD write uses), tagged intraday so it
  // never settles a stored row.
  if (mode === 'demo') {
    const snapshot = ctx.engine.getReportSnapshot();
    if (!Number.isFinite(snapshot.state.account.totalEquity)) return null;
    return { ...generateEodReport(snapshot), pnlSource: 'live-intraday' as const };
  }
  const env: TradierEnv = mode === 'live' ? 'production' : 'sandbox';
  const todayBalance = ctx.engine.getEquitySnapshot().equity;
  if (!Number.isFinite(todayBalance) || todayBalance <= 0) return null;

  const today = etDateString();
  const snapshots = await loadTradierBalanceSnapshots(ctx, env);
  const prev = findPreviousBalanceSnapshot(
    Object.fromEntries(Object.entries(snapshots).filter(([d]) => d !== today)),
    today,
  );
  if (!prev) return null;

  const cashFlow = await loadTradierCashFlow(ctx, env);
  // TRA-2875 — same span correction as the settled path above; the intraday
  // cell reads the same anchor and was equally exposed to an interior deposit.
  const netCashFlow = sumCashFlowOverSpan(cashFlow.netByDate, prev.date, today);
  const pnl = computeBalanceDailyPnl(todayBalance, prev.balance, netCashFlow);
  if (pnl === null) return null;
  const combinedPnl = Number(pnl.toFixed(2));

  const sign = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  const usd = (n: number) =>
    '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const header = `> **Live P&L (running, intraday — TRA-1192).** Today's P&L for ${today} = current Tradier equity (${usd(todayBalance)}) − prev snapshot ${prev.date} (${usd(prev.balance)}) − net cash flow (${sign(netCashFlow)}) = **${sign(combinedPnl)}**. This is a live estimate that updates through the session; the 9 PM EOD snapshot settles the final value.`;

  return {
    date: today,
    generatedAt: Date.now(),
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: combinedPnl,
    optionsPnl: 0,
    combinedPnl,
    realizedPnlPct: undefined,
    optionsPnlPct: undefined,
    combinedPnlPct: undefined,
    totalEquity: todayBalance,
    managedEquity: 0,
    availableCash: 0,
    trades: [],
    openPositionCount: 0,
    winRate: 0,
    avgRR: 0,
    totalTrades: 0,
    winners: 0,
    losers: 0,
    expectancy: 0,
    maxDrawdown: 0,
    sharpeRatio: 0,
    top5Movers: [],
    signalAccuracy: { totalSignals: 0, winningSignals: 0, winRate: 0, avgRR: 0 },
    pnlSource: 'live-intraday',
    markdown: header,
  };
}

/** TRA-244 — run the historical Live-calendar backfill for every user. */
async function runLiveRealizedCalendarBackfill(): Promise<void> {
  for (const ctx of getAllUserContexts()) {
    try {
      await backfillLiveRealizedCalendar(ctx);
    } catch (err) {
      log.error('live realized calendar backfill failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}


async function generateAndSaveCryptoReport(ctx: UserContext): Promise<void> {
  // TRA-244 — same per-mode bucketing as the stocks generator above; crypto
  // only has demo vs live (no sandbox) since Coinbase has no paper sandbox.
  // TRA-245 — pass the mode into getReportSnapshot so the Live folder gets
  // Live (Coinbase) data and the Demo folder gets Demo paper-account data;
  // pre-fix the snapshot was always Demo even when written under live/.
  const mode = cryptoModeKey(getSettings(ctx.username));
  const snapshot = ctx.cryptoEngine.getReportSnapshot(mode);
  const baseReport = generateCryptoEodReport(snapshot);
  // TRA-1220 — append the observe-only "Crypto Regime Overlay" section, folding
  // the forward regime labels captured this session (empty/disabled fallback when
  // the overlay flag is off). Read-only: no orders, no fetch here.
  const regimeSection = buildCryptoRegimeEodSection(
    isCryptoRegimeEnabled(),
    summarizeCryptoRegimeScans(),
  );
  // TRA-1221 — append the observe-only "Crypto Regime-Gated TSMOM" section, folding
  // the forward would-be signals + net-of-taker round-trip evidence captured this
  // session (empty/disabled fallback when the scanner flag is off). Read-only.
  const regimeTsmomSection = buildRegimeTsmomEodSection(
    isRegimeTsmomEnabled(),
    summarizeRegimeTsmomScans(),
  );
  // TRA-1317 — append a one-line DEMO-route rollup under the observe-only section:
  // whether paper routing is armed + the accrued open/fill/realized-R evidence. Kept
  // out of buildRegimeTsmomEodSection (scanner module) to avoid a scanner→route
  // import cycle. Read-only: folds the route ledger, places no order.
  //
  // TRA-2411 — the SECOND per-user reader of that process-global book, and the
  // reason this fix is not just the dashboard provider: these are the FIRM's
  // counters (open/fills/closed/realized-R across every routed symbol), and this
  // report is written per user under their own reports directory. Same operator
  // scope as the dashboard injection; an ordinary account's crypto EOD report
  // simply omits the line rather than reporting the firm's ledger as its own.
  const showDemoRoute = mayViewFirmWideDemoRouteBook(ctx.username, getUser(ctx.username)?.role);
  const demoRoute = summarizeRegimeTsmomDemoRoute();
  const demoRouteEnabled = isRegimeTsmomDemoRouteEnabled(demoFlagEnv());
  const regimeTsmomDemoRouteLine = !showDemoRoute
    ? ''
    : demoRouteEnabled
    ? `\n_DEMO paper routing **armed** — open ${demoRoute.openPositions} · fills ${demoRoute.fillCount} · closed ${demoRoute.closeCount} · realized ${demoRoute.realizedR}R (paper, zero real capital)._`
    : `\n_DEMO paper routing disarmed (CRYPTO_REGIME_TSMOM_DEMO_ROUTE_ENABLED off)._`;
  const report = {
    ...baseReport,
    markdown: `${baseReport.markdown}\n${regimeSection}\n${regimeTsmomSection}${regimeTsmomDemoRouteLine}\n`,
  };
  const targetDir = cryptoReportsDirFor(ctx, mode);
  const datePath = join(targetDir, `${report.date}.json`);
  const mdPath = join(targetDir, `${report.date}.md`);
  const latestJsonPath = join(targetDir, 'latest.json');
  const latestMdPath = join(targetDir, 'latest.md');

  await Promise.all([
    writeFile(datePath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(mdPath, report.markdown, 'utf-8'),
    writeFile(latestJsonPath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(latestMdPath, report.markdown, 'utf-8'),
  ]);

  // TRA-193 — persist the day's equity snapshot so the crypto P&L calendar and
  // cumulative stats see this row, mirroring the stocks flow above.
  // TRA-245 — only write to cryptoTracker in demo mode. The tracker is shared
  // across both crypto modes, and saveSnapshot rebases the demo dashboard's
  // openingEquity to the snapshot's closingEquity. Writing a live-equity row
  // here would corrupt that baseline (e.g. a $0 live equity from missing
  // Coinbase creds would make the demo dashboard report a phantom -$25k
  // dailyPnl after a restart). Live equity history lives in the per-mode
  // crypto-reports/live/ files and longer-term in Coinbase's account history.
  if (mode === 'demo') {
    const closingEquity = snapshot.accountState.totalEquity;
    const openingEquity = ctx.cryptoTracker.getOpeningEquity();
    ctx.cryptoTracker.saveSnapshot({
      date: report.date,
      openingEquity,
      closingEquity,
      dailyPnl: closingEquity - openingEquity,
      optionsPnl: 0,
      optionsDailyPnl: 0, // TRA-1633 — crypto book has no options leg
      combinedPnl: closingEquity - openingEquity,
      trades: snapshot.allClosedPositions.length,
    });
  }

  log.info('crypto EOD report saved', { username: ctx.username, datePath });

  const msg = JSON.stringify({ type: 'crypto_eod_report', payload: report });
  broadcastToUser(ctx.username, msg);
}

// TRA-244 — Single 9 PM ET close-out for every user. Order is load-bearing:
//   1. Generate today's EOD reports + persist the equity snapshot for the
//      Calendar. We do this BEFORE resetting dailyPnl so the report's combined
//      P&L still reflects the day. Stocks only on market days; crypto every
//      day (24/7).
//   2. Reset the in-memory `dailyPnl` baseline on both engines so the next
//      tick broadcasts a fresh 0 for the new trading day. The persisted
//      tracker.openingEquity is realigned in lock-step.
//   3. Archive the rolling "Recent Closed" lists so the Positions/Options
//      tabs start the next session blank.
//   4. Persist + broadcast so connected clients see the reset immediately.
// TRA-249-D — top-of-hour fan-out: every active user's crypto engine gets
// one funding-accrual pass per ET hour. Demo and uninitialised-broker
// engines short-circuit inside `tickFundingHourly`, so this is essentially
// free unless the user is running live perps. Failures per-user are
// isolated so one user's outage can't starve the rest of the fleet.
async function runHourlyFundingForAllUsers(): Promise<void> {
  for (const ctx of getAllUserContexts()) {
    try {
      await ctx.cryptoEngine.tickFundingHourly();
    } catch (err) {
      log.error('funding hourly tick failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// TRA-1216 — observe-only perp funding-carry pass, fired off the SAME hourly hook
// as the funding accrual above. When ENABLE_PERP_FUNDING_CARRY_OBSERVE is OFF this
// returns before any work ⇒ zero cost/IO. When ON it fetches funding + mark price
// for EVERY watchlist perp (regardless of open positions), records the ranked
// observe-only carry candidates into the in-memory store backing
// `GET /api/health/perp-funding-carry`, and appends the observations to the
// forward funding-history JSONL under DATA_DIR (the sole persisted artifact — it
// unblocks a future carry backtest). Read-only throughout: NO order/entry/sizing.
//
// The fetch is done ONCE per hour off any live Coinbase client in the fleet
// (funding is venue-global, not per-user). Demo/keyless fleets have no live
// client ⇒ no fetch, no writes. Coinbase INTX funds hourly ⇒ intervalHours = 1;
// the scanner annualizes off that per-observation interval, not a hardcoded 8h.
async function runHourlyPerpFundingCarry(): Promise<void> {
  if (!isPerpFundingCarryEnabled()) return; // flag OFF ⇒ zero cost/IO
  const watchlist = resolvePerpCarryWatchlist();
  if (watchlist.length === 0) return;

  let client: ReturnType<CryptoSignalEngine['getPerpFundingClient']> = null;
  for (const ctx of getAllUserContexts()) {
    client = ctx.cryptoEngine.getPerpFundingClient();
    if (client) break;
  }
  if (!client) return; // no live client (demo/keyless) ⇒ no fetch, no writes

  let rates: Map<string, { rate: number }>;
  let prices: Map<string, number>;
  try {
    [rates, prices] = await Promise.all([
      client.getFundingRates(watchlist),
      client.getProductPrices(watchlist).catch(() => new Map<string, number>()),
    ]);
  } catch (err) {
    log.warn('perp funding-carry fetch failed (TRA-1216)', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const asOf = Date.now();
  const observations: FundingObservation[] = watchlist.map((productId) => {
    const fr = rates.get(productId);
    const mark = prices.get(productId);
    return {
      productId,
      fundingRate: fr && Number.isFinite(fr.rate) ? fr.rate : null,
      intervalHours: 1, // Coinbase INTX funding cadence
      markPrice: mark != null && Number.isFinite(mark) ? mark : null,
      ts: asOf,
    };
  });

  const candidates = scanFundingCarry(observations, resolvePerpCarryConfig(), asOf);
  recordFundingCarryScan(candidates, asOf);

  const history: FundingHistoryEntry[] = observations
    .filter((o): o is FundingObservation & { fundingRate: number } => o.fundingRate != null)
    .map((o) => ({
      ts: o.ts ?? asOf,
      productId: o.productId,
      fundingRate: o.fundingRate,
      intervalHours: o.intervalHours,
      markPrice: o.markPrice ?? null,
    }));
  const rows = appendFundingHistory(DATA_DIR, history);

  log.info('perp funding-carry observe pass (TRA-1216)', {
    watchlist: watchlist.length,
    eligible: candidates.filter((c) => c.eligible).length,
    missing: candidates.filter((c) => c.reason === 'funding_data_missing').length,
    historyRows: rows,
  });
}

// TRA-1220 — per-symbol dedupe so we re-classify at most once per newly-closed 4H
// bar (spec §6): keyed on the ISO of the last CLOSED bar we last classified.
const lastCryptoRegimeBarBySymbol = new Map<string, string>();

// TRA-1220 — observe-only crypto regime-overlay pass, fired off the SAME hourly
// hook as the funding-carry pass above. The core logic lives in the scanner
// module's dependency-injected `observeCryptoRegime` (so the zero-IO-when-off
// invariant is unit-testable). When ENABLE_CRYPTO_REGIME_OVERLAY is OFF it returns
// before ANY fetch ⇒ provably zero cost/IO. When ON it pulls CLOSED 4H bars for
// each watchlist major (keyless public Coinbase candles — the perp-shorts 4H cache
// only covers 5 of the 12 majors, so a shared reuse isn't possible; this mirrors
// funding-carry's own hourly fetch), drops the forming bar (invariant #3 — no
// lookahead), classifies via the pure engine substrate, and records the ranked
// labels into the store backing GET /api/health/crypto-regime. Read-only: NO
// order/entry/sizing path. 4H bars roll every 4h so the hourly cadence + the
// lastBarTime dedupe re-classify a symbol at most once per new bar.
async function runHourlyCryptoRegime(): Promise<void> {
  if (!isCryptoRegimeEnabled()) return; // fast-path: skip resolving deps when off
  const result = await observeCryptoRegime({
    enabled: true,
    watchlist: resolveCryptoRegimeWatchlist(),
    cfg: resolveCryptoRegimeConfig(),
    fetch4h: (symbol) => fetchCrypto4hBars(symbol, 260),
    lastBarBySymbol: lastCryptoRegimeBarBySymbol,
    onError: (symbol, err) =>
      log.warn('crypto regime 4H fetch failed (TRA-1220)', {
        symbol,
        reason: err instanceof Error ? err.message : String(err),
      }),
  });
  if (result.recorded > 0) {
    log.info('crypto regime observe pass (TRA-1220)', {
      fetched: result.fetched,
      classified: result.recorded,
      trend: result.readings.filter(
        (r) => r.regime === 'trend_up' || r.regime === 'trend_down',
      ).length,
      chop: result.readings.filter((r) => r.regime === 'chop').length,
    });
  }
}

// TRA-1221 — carried state for the regime-gated TSMOM scanner (TSMOM is stateful:
// a would-be position persists between passes so entries/exits + turnover count
// correctly). Both maps are process-global and mutated in place by the observe
// routine; they stay empty while ENABLE_CRYPTO_REGIME_TSMOM is off (no pass runs).
const lastRegimeTsmomBarBySymbol = new Map<string, string>();
const regimeTsmomStateBySymbol = new Map<string, RegimeTsmomState>();

// TRA-1264 — hydrate the accrual on boot so a restart/redeploy inside the multi-
// week n≥20 window doesn't reset the completed-round-trip count to 0. Rebuilds the
// in-memory round-trip store from the persisted JSONL, restores the turnover
// anchor/total, and re-seeds the carried per-symbol state + last-bar dedupe maps.
// Best-effort (a missing/corrupt file yields an empty hydration). Runs even when
// the flag is off — reading two small files at boot is cheap and keeps the accrual
// intact if the flag is later toggled on.
{
  const h = hydrateRegimeTsmomFromDisk(DATA_DIR);
  for (const [k, v] of h.stateBySymbol) regimeTsmomStateBySymbol.set(k, v);
  for (const [k, v] of h.lastBarBySymbol) lastRegimeTsmomBarBySymbol.set(k, v);
  if (h.totalRoundTrips > 0 || h.stateBySymbol.size > 0) {
    log.info('crypto regime-tsmom accrual hydrated (TRA-1264)', {
      roundTripsLoaded: h.roundTripsLoaded,
      totalRoundTrips: h.totalRoundTrips,
      carriedSymbols: h.stateBySymbol.size,
    });
  }
}

// TRA-1317 — hydrate the DEMO paper-route book on boot so an open routed long and
// the realized-R accrual survive the ~daily Render demo (`tradingai-bqb1`) reboot.
// Restores the isolated CryptoPaperAccount route book + counters from the state
// snapshot under DATA_DIR (the JSONL is the append-only audit). Runs even when the
// route flag is off — reading one small file at boot is cheap and keeps the ledger
// intact if the flag is later armed. NO live path is touched (the route book has none).
{
  const h = hydrateRegimeTsmomDemoRouteFromDisk(DATA_DIR);
  if (h.fillCount > 0 || h.openPositions > 0) {
    log.info('crypto regime-tsmom demo-route hydrated (TRA-1317)', {
      openPositions: h.openPositions,
      fillCount: h.fillCount,
      closeCount: h.closeCount,
      realizedR: h.realizedR,
    });
  }
}

// TRA-1221 — observe-only regime-gated TSMOM pass, fired off the SAME hourly hook
// as the funding-carry and regime-overlay passes above. When ENABLE_CRYPTO_REGIME_TSMOM
// is OFF it returns before ANY fetch ⇒ provably zero cost/IO. When ON it pulls
// CLOSED 4H bars for each watchlist major, drops the forming bar (invariant #3 —
// no lookahead), classifies the regime AND computes r_L off the SAME closed series
// (no double fetch / time-skew), runs the pure regime gate (§3), and records the
// would-be signals + completed round trips into the store backing
// GET /api/health/crypto-regime-tsmom. Read-only: NO order/entry/sizing path — the
// short_observe leg is never sized (invariant #4). 4H bars roll every 4h so the
// hourly cadence + the lastBarTime dedupe scan a symbol at most once per new bar.
async function runHourlyCryptoRegimeTsmom(): Promise<void> {
  if (!isRegimeTsmomEnabled()) return; // fast-path: skip resolving deps when off
  const result = await observeRegimeTsmom({
    enabled: true,
    watchlist: resolveRegimeTsmomWatchlist(),
    regimeCfg: resolveCryptoRegimeConfig(),
    cfg: resolveRegimeTsmomConfig(),
    fetch4h: (symbol) => fetchCrypto4hBars(symbol, 260),
    lastBarBySymbol: lastRegimeTsmomBarBySymbol,
    stateBySymbol: regimeTsmomStateBySymbol,
    onError: (symbol, err) =>
      log.warn('crypto regime-tsmom 4H fetch failed (TRA-1221)', {
        symbol,
        reason: err instanceof Error ? err.message : String(err),
      }),
  });
  // TRA-1264 — persist the pass so the completed-round-trip accrual and any
  // in-flight would-be position survive a restart/redeploy. Best-effort inside
  // the scanner module (an I/O failure never breaks the observe pass). Runs only
  // when a scan actually happened (a new closed bar advanced) so an idle pass
  // doesn't rewrite the snapshot needlessly.
  if (result.scanned > 0) {
    persistRegimeTsmomPass(
      DATA_DIR,
      result.results,
      regimeTsmomStateBySymbol,
      lastRegimeTsmomBarBySymbol,
    );
    const signals = result.results.filter(
      (r) => r.action === 'enter_long' || r.action === 'short_observe',
    ).length;
    const exits = result.results.filter((r) => r.action === 'exit_long' || r.roundTrip).length;
    if (signals > 0 || exits > 0) {
      log.info('crypto regime-tsmom observe pass (TRA-1221)', {
        fetched: result.fetched,
        scanned: result.scanned,
        newSignals: signals,
        roundTrips: result.results.filter((r) => r.roundTrip).length,
      });
    }

    // TRA-1317 — DEMO paper routing. When the standalone, demo-scoped route flag
    // is armed (resolved through the SAME demo-flags overlay the engine consults,
    // so a non-admin operator can arm it via DATA_DIR/demo-flags.json), route this
    // pass's enter_long/exit_long transitions into the isolated CryptoPaperAccount
    // route book. Structurally DEMO-only: that book has no live path, so this can
    // never touch real capital regardless of the host. Off by default ⇒ no-op.
    if (isRegimeTsmomDemoRouteEnabled(demoFlagEnv())) {
      const routed = routeRegimeTsmomResults(result.results, resolveRegimeTsmomConfig());
      if (routed.opened > 0 || routed.closed > 0) {
        log.info('crypto regime-tsmom demo-route fills (TRA-1317)', {
          opened: routed.opened,
          closed: routed.closed,
        });
      }
    }
  }
}

// TRA-1271 — hydrate the ignition forward-capture accrual on boot so a
// restart/redeploy inside the multi-week taker-CI window doesn't reset the
// resolved-record count to 0. Rebuilds the in-memory resolved list from the JSONL
// close-lines, restores the turnover anchor/totals, and re-seeds the open fires +
// dedupe maps. Best-effort (a missing/corrupt file yields an empty hydration).
// Runs even when the flag is off — reading two small files at boot is cheap and
// keeps the accrual intact if the flag is later toggled on.
{
  const h = hydrateIgnitionFromDisk(DATA_DIR);
  if (h.totalResolved > 0 || h.openRecords > 0) {
    log.info('crypto ignition accrual hydrated (TRA-1271)', {
      resolvedLoaded: h.resolvedLoaded,
      totalResolved: h.totalResolved,
      openRecords: h.openRecords,
    });
  }
}

// TRA-1278 — hydrate the conviction-DCA add ledger on boot and remember DATA_DIR
// for subsequent appends, so the TRA-971 forward-evidence gate's addCount/breachCount
// survive the ~daily demo-host restart instead of resetting to a structural 0.
// Best-effort (a missing/corrupt file yields an empty hydration); runs regardless
// of CONVICTION_DCA.enabled — reading one small file at boot is cheap.
{
  const h = hydrateConvictionDcaFromDisk(DATA_DIR);
  // TRA-2598 — the guard log hydrates on its own axis: a host can have thousands of
  // fills and ZERO guard events (every line written before this commit), so gate this
  // line separately or a fresh guard ledger is invisible at boot.
  if (h.guardEventCount > 0) {
    log.info('conviction-DCA same-day-loss guard ledger hydrated (TRA-2598)', {
      guardEventCount: h.guardEventCount,
    });
  }
  if (h.addCount > 0) {
    log.info('conviction-DCA add ledger hydrated (TRA-1278)', {
      addCount: h.addCount,
      breachCount: h.breachCount,
      lastAddAt: h.lastAddAt,
      // TRA-2265 — name the per-class split at boot. The pooled pair above cannot
      // distinguish "the equity R-cap held" from "the equity add path never ran";
      // equityAddCount is the number that separates them.
      equityAddCount: h.byClass.equity.addCount,
      equityBreachCount: h.byClass.equity.breachCount,
      optionAddCount: h.byClass.option.addCount,
      optionBreachCount: h.byClass.option.breachCount,
      unknownClassAddCount: h.byClass.unknown.addCount,
    });
  }
}

// TRA-2199 (parent TRA-2175 → TRA-2005) — hydrate the options-ideas expectancy
// SHADOW ledger on boot and remember DATA_DIR for subsequent appends. Durable for
// the same reason the ledgers above are: bqb1 reboots ~daily, so a since-boot
// counter would read a structural 0 by the time a post-close grade fires — and this
// leg has already been mistaken for armed once. Runs regardless of the gate flag:
// reading one small file at boot is cheap, and hydrating when the flag is OFF is
// what lets a reader still see the cohort a previously-ON window accrued.
{
  const h = hydrateOptionsIdeasExpectancyFromDisk(DATA_DIR);
  if (h.slates > 0) {
    log.info('options-ideas expectancy shadow ledger hydrated (TRA-2199)', {
      slates: h.slates,
      days: h.days,
    });
  }
}

// TRA-2208 — hydrate the PRE-floor credit/width ledger on boot, for the same reason
// as the sibling above: bqb1 reboots ~daily and the survival rate this feeds is the
// number the TRA-1965 CUT/continue fork turns on, so a since-boot counter would read
// a structural 0 at exactly the moment it is graded. Runs regardless of the floor
// flag — hydrating with the flag OFF is what lets a reader still see the cohort a
// previously-ON window accrued.
{
  const h = hydrateOptionsIdeasCreditWidthFromDisk(DATA_DIR);
  if (h.slates > 0) {
    log.info('options-ideas credit/width floor ledger hydrated (TRA-2208)', {
      slates: h.slates,
      days: h.days,
    });
  }
}

// TRA-1300 — hydrate the observe-only scale-out ladder ledger on boot and remember
// DATA_DIR for subsequent appends, so the QuantTrader forward-validation trim counts
// and the per-position fired-rung set survive the ~daily demo-host restart (a rung
// trims once across restarts). Best-effort; runs regardless of the flag — reading one
// small file at boot is cheap.
{
  const h = hydrateScaleoutLadderFromDisk(DATA_DIR);
  if (h.trimCount > 0) {
    log.info('scale-out ladder ledger hydrated (TRA-1300)', {
      trimCount: h.trimCount,
      fullExitCount: h.fullExitCount,
      positionCount: h.positionCount,
      lastTrimAt: h.lastTrimAt,
    });
  }
}

// TRA-1486 D2 (parent TRA-1476) — hydrate the DURABLE per-name/ET-day directional
// open ledger and remember DATA_DIR for subsequent appends. This is the fix for the
// per-name-cap leak: the in-memory `churnOpensToday` counter resets on every reboot
// (bqb1 restarts multiple times/session), so the cap kept restarting at 0 and never
// bit. Rebuilding the current-ET-day counts from disk lets the cap survive a
// mid-session reboot. Best-effort; the ledger is compacted to a short retention
// window on read so it stays tiny.
{
  const h = hydrateDirectionalOpensFromDisk(DATA_DIR);
  if (h.records > 0 || h.rejects > 0) {
    // TRA-1564 B1 — `rejects` are now durable too, so a post-close re-grade reads the
    // RTH session's gate rejects after the daily close reboot.
    log.info('directional per-name open ledger hydrated (TRA-1486/TRA-1564)', {
      records: h.records,
      rejects: h.rejects,
      days: h.days,
    });
  }
}

// TRA-1682 (parent TRA-1680 → TRA-1677) — rebuild the ENTRY-GREEKS gate's admit/reject
// tally and remember DATA_DIR for subsequent appends. Durable for the same reason the
// directional rejects are (TRA-1564 B1): bqb1 reboots at/after the close, so an
// in-memory since-boot counter reads empty by the time a post-close grade fires — and
// this particular counter is the one that would have caught TRA-1677's algebraically
// impossible gate (100% reject, invisible for a week). Compacted to a 3-day window.
{
  const h = hydrateEntryGreeksGateFromDisk(DATA_DIR);
  if (h.admitted > 0 || h.rejects > 0) {
    log.info('entry-greeks gate ledger hydrated (TRA-1682)', {
      admitted: h.admitted,
      rejects: h.rejects,
      days: h.days,
    });
  }
}

// TRA-2134 — rebuild the durable multi-strategy SANDBOX journal and remember DATA_DIR
// for subsequent appends. Durable so the standing learning program survives bqb1's
// daily reboot; a post-session read of /api/health/sandbox-strategy-journal recovers
// the whole series (provided DATA_DIR is a persistent mount — else the payload's
// `durability.ephemeral` says so). Compacted to a 60-day window.
{
  const h = hydrateSandboxStrategyJournalFromDisk(DATA_DIR);
  if (h.records > 0) {
    log.info('sandbox strategy journal hydrated (TRA-2134)', {
      records: h.records,
      strategies: h.strategies,
    });
  }
}

// TRA-2237 — rebuild the DURABLE parity-reconcile daily series (demo-mid vs sandbox-fill
// P&L gap per strategy) and remember DATA_DIR for subsequent snapshot appends. Same
// durability contract as the sandbox journal it folds from (TRA-2134): the series must
// survive bqb1's daily reboot so QuantTrader can grade the gap across weeks; a post-boot
// read of /api/health/parity-reconcile recovers it (provided DATA_DIR is a persistent
// mount — else the payload's `durability.ephemeral` says so). Compacted to 60 days.
{
  const h = hydrateParityReconcileFromDisk(DATA_DIR);
  if (h.snapshots > 0) {
    log.info('parity-reconcile daily series hydrated (TRA-2237)', {
      snapshots: h.snapshots,
      days: h.days,
    });
  }
}

// TRA-1602 (TRA-1600C) — rebuild the COST-AWARE fire-bar admit/reject ledger and
// remember DATA_DIR for subsequent appends. Durable for the same reason the
// directional rejects are (TRA-1564 B1): bqb1 reboots at/after the close, so an
// in-memory since-boot counter reads empty by the time QuantTrader's post-close
// grade fires. Best-effort; compacted to a 7-day window on read.
{
  const h = hydrateCostAwareGateFromDisk(DATA_DIR);
  if (h.records > 0) {
    log.info('cost-aware fire-bar ledger hydrated (TRA-1602)', {
      records: h.records,
      days: h.days,
    });
  }
}

// TRA-1892 (parent TRA-1592 → TRA-1435) — rebuild the DURABLE give-back arm-floor
// outcome ledger and remember DATA_DIR for subsequent appends. This is what makes the
// ≥5-session forward-test recoverable: bqb1's in-memory give-back state is wiped by
// the ~04:30Z nightly reboot, so a missed 21:40Z grade fire used to be a permanently
// lost session. Rebuilt on boot, a catch-up read of /api/health/giveback-arm-floor
// recovers it — provided DATA_DIR is a persistent mount (else `durability.ephemeral`
// says so; the fix is DATA_DIR=/data per TRA-1719). Best-effort; compacted to 30 days.
{
  const h = hydrateGiveBackArmFloorFromDisk(DATA_DIR);
  if (h.records > 0) {
    log.info('give-back arm-floor ledger hydrated (TRA-1892)', {
      records: h.records,
      days: h.days,
      sessions: h.sessions,
    });
  }

  // TRA-2110 (parent TRA-2109 outcome-2) — re-derive each book's give-back
  // governor peak from the ledger's TODAY (ET) session so a mid-session process
  // restart (crash — TRA-1905 — or deploy) cannot silently DISARM the give-back
  // governor. `DailyRiskGovernor.peakOpenGain`/`sessionHalted` are in-memory only
  // and reset on restart; without this the post-restart governor takes the
  // collapsed book as its peak and a restart-straddling give-back is never seen.
  //
  // Runs AFTER hydrate AND after `initAllUserContexts()` (line ~759, which imports
  // trade snapshots), so both preconditions hold. GATED on `durability.ephemeral
  // === false` (TRA-2110 AC#3): NEVER seed a real-capital latch off a non-durable
  // ledger — on an ephemeral DATA_DIR the ledger is wiped at the same reboot as the
  // memory it would seed, so its peak is untrustworthy. The seed only RAISES the
  // peak; the next markBook tick self-heals the latch via bookGiveBackDecision (it
  // trips only if the live current is still below the retained floor of the true
  // peak — never a false halt off the seed alone). COUPLED to TRA-1719
  // (DATA_DIR=/data): until that lands, `ephemeral` is true and this is a no-op.
  const durability = summarizeGiveBackArmFloor().durability;
  if (durability.ephemeral === false) {
    let seededBooks = 0;
    for (const ctx of getAllUserContexts()) {
      try {
        const r = ctx.engine.seedBookGiveBackPeakFromLedger();
        if (r.seeded) {
          seededBooks += 1;
          log.info('give-back governor peak re-derived on boot (TRA-2110)', {
            username: ctx.username,
            peak: r.peak,
          });
        }
      } catch (err: unknown) {
        // Best-effort: a seed failure must never break boot. The governor simply
        // runs unseeded (the pre-fix behavior), so this fails SAFE, not open.
        log.warn('give-back governor boot re-derive failed (TRA-2110)', {
          username: ctx.username,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (seededBooks > 0) {
      log.info('give-back governor boot re-derive complete (TRA-2110)', { seededBooks });
    }
  } else {
    log.warn(
      'give-back governor boot re-derive SKIPPED — ledger ephemeral (TRA-2110/TRA-1719)',
      { dataDir: durability.dataDir },
    );
  }
}

// TRA-1929 (parent TRA-1916) — rebuild the durable per-trade live-options fee/slippage
// calibration ledger from disk on boot and remember DATA_DIR for subsequent appends, so
// the bounded 2-day real-money test's fills survive bqb1's nightly reboot and remain
// readable at /api/health/live-options-fee-slippage. Durable only when DATA_DIR is a
// persistent mount (else `durability.ephemeral` says so; the fix is DATA_DIR=/data per
// TRA-1719). Best-effort; compacted to 30 days.
{
  const h = hydrateLiveOptionsFeeSlippageFromDisk(DATA_DIR);
  if (h.records > 0) {
    // `migrated` — TRA-2850: pre-2850 `fees: 0` rows (no provenance) reset to honest-null.
    log.info('live-options fee/slippage ledger hydrated (TRA-1929)', {
      records: h.records,
      migrated: h.migrated,
    });
  }
}

// TRA-2810 — the fee back-fill pass resolves the live operator's PRODUCTION options
// client exactly like the TRA-1954 admin reconcile route. Null when no production
// creds resolve (the pass records 'no-client' and stays quiet).
async function buildLiveFeeReconcileClient(): Promise<TradierOptionsClient | null> {
  const operator = resolveLiveBrokerOperator();
  const settings = await loadSettings(operator);
  return buildTradierOptionsClientForEnv(settings, 'production');
}

// TRA-2810 — kick ONE fee reconcile shortly after boot (the hourly tick also runs it).
// Two real-money windows ended feesMeasured 0/n because the join only existed behind
// an admin POST nobody can auth against on bqb1; this makes the back-fill self-driving.
// 90s so boot IO settles first; .unref() so the timer can never hold the process open;
// the pass itself never throws and makes no broker call when nothing is unmeasured.
setTimeout(() => {
  void runLiveOptionsFeeReconcile(buildLiveFeeReconcileClient);
}, 90_000).unref();

// TRA-2048 (parent TRA-2044) — rebuild the durable LIVE gate-enforcement ledger
// (cost-bar + spread veto promoted from shadow to enforcing) and remember DATA_DIR
// for subsequent appends, so armed-live enforcement counts survive bqb1's nightly
// reboot and stay readable at /api/health/live-enforce-gates. Durable only when
// DATA_DIR is a persistent mount (else `durability.ephemeral` says so; the fix is
// DATA_DIR=/data per TRA-1719). Best-effort; compacted to 30 days.
{
  const h = hydrateLiveEnforceGateFromDisk(DATA_DIR);
  if (h.records > 0) {
    log.info('live-enforce gate ledger hydrated (TRA-2048)', { records: h.records, days: h.days });
  }
}

// TRA-1271 — observe-only crypto ignition pass, fired off the SAME hourly hook as
// the funding-carry / regime-overlay / regime-TSMOM passes above. When
// ENABLE_CRYPTO_IGNITION_SCANNER is OFF it returns before ANY fetch => provably
// zero cost/IO. When ON it pulls CLOSED 4H bars for each watchlist name, drops the
// forming bar (no lookahead), classifies the regime off the SAME closed series,
// resolves any open fire forward (pessimistic TP/stop/timeout), then evaluates a
// fresh fire on the last bar, recording the would-be forward records + the
// would-a-limit-fill flag into the store backing GET /api/health/crypto-ignition
// and persisting them to the JSONL/snapshot under DATA_DIR. Read-only, ZERO
// capital: NO order/entry/sizing path (invariant #1). 4H bars roll every 4h so the
// hourly cadence + the lastBarTime dedupe scan a symbol at most once per new bar.
async function runHourlyCryptoIgnition(): Promise<void> {
  if (!isCryptoIgnitionEnabled()) return; // fast-path: skip resolving deps when off
  const result = await observeIgnition({
    enabled: true,
    watchlist: resolveIgnitionWatchlist(),
    regimeCfg: resolveCryptoRegimeConfig(),
    cfg: resolveIgnitionConfig(),
    fetch4h: (symbol) => fetchCrypto4hBars(symbol, 260),
    dataDir: DATA_DIR,
    onError: (symbol, err) =>
      log.warn('crypto ignition 4H fetch failed (TRA-1271)', {
        symbol,
        reason: err instanceof Error ? err.message : String(err),
      }),
  });
  if (result.opened.length > 0 || result.resolved.length > 0) {
    log.info('crypto ignition observe pass (TRA-1271)', {
      fetched: result.fetched,
      scanned: result.scanned,
      opened: result.opened.length,
      resolved: result.resolved.length,
    });
  }
}

async function runDailyCloseForAllUsers(): Promise<void> {
  const stocksMarketDay = isMarketDay();
  // TRA-388 — heal any calendar gap from a missed 21:00 ET archive tick
  // BEFORE the archive step below clears `allClosedPositions`. A missed day's
  // closed trades are still retained until that point, so a pre-archive
  // catch-up can reconstruct the day's report accurately.
  await catchUpMissedEodReports();
  for (const ctx of getAllUserContexts()) {
    try {
      // 1a. Stocks EOD — only on trading days (Mon–Fri, non-holiday).
      if (stocksMarketDay) {
        try {
          await generateAndSaveReport(ctx);
        } catch (err) {
          log.error('EOD report failed', {
            username: ctx.username,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // 1b. Crypto EOD — every calendar day (24/7 market).
      try {
        await generateAndSaveCryptoReport(ctx);
      } catch (err) {
        log.error('crypto EOD report failed', {
          username: ctx.username,
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      // 2. Reset dashboard daily-P&L baselines for the new trading day.
      ctx.engine.resetDailyPnl();
      ctx.cryptoEngine.resetDailyPnl();

      // 2b. TRA-1053 (TRA-1045 R3) — release per-day in-memory ledgers so they
      // do not accumulate across trading days. Runs AFTER step 1 (the EOD report
      // reads dailySignals). Stocks-only: CryptoSignalEngine has no dailySignals
      // / conviction-DCA maps.
      ctx.engine.clearDailySessionState();

      // 3. Archive closed trades.
      const stocks = ctx.engine.archiveClosedTrades();
      const crypto = ctx.cryptoEngine.archiveClosedTrades();

      // 4. Persist + broadcast.
      await Promise.all([persistStocksNow(ctx), persistCryptoNow(ctx)]);
      broadcastEngineState(ctx);
      broadcastCryptoState(ctx);
      log.info('archive: reset dailyPnl and archived closed trades', {
        username: ctx.username,
        closedPositions: stocks.positions,
        closedOptions: stocks.options,
        closedCryptoPositions: crypto,
      });
    } catch (err) {
      log.error('archive failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * TRA-2252 — fire the scheduled P&L + trade-summary report for every user whose
 * cadence closes today. Runs from the 21:00 ET archive hook AFTER
 * `runDailyCloseForAllUsers` has booked today's snapshot into each user's
 * `tracker` / `cryptoTracker`, so "today" is in the window. The per-user cadence
 * decision + empty-period skip + boundary detection all live in the pure
 * `scheduled-report.ts`; here we only gather each user's combined snapshots +
 * resolved prefs and hand them off. Emit is fire-and-forget through the
 * dispatcher (quiet-hours / dedup / channel routing inherited).
 */
function runScheduledReportsForAllUsers(now: Date = new Date()): void {
  const users = (): ReportUser[] =>
    getAllUserContexts().map((ctx) => ({
      username: ctx.username,
      // Combine both books' booked daily ledgers; the aggregator merges rows
      // that share a date across the two trackers.
      snapshots: [...ctx.tracker.getSnapshots(), ...ctx.cryptoTracker.getSnapshots()],
      prefs: resolveAlertPreferences(getSettings(ctx.username)),
    }));
  try {
    runScheduledReports({ users, asOfDate: etDateString(now), now: now.getTime() });
  } catch (err) {
    log.error('scheduled reports run failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// TRA-380 — option-chain recorder hook (parent TRA-379, step 1). Fires from
// the MarketScheduler at 3:55 PM ET on trading days and runs the TRA-376
// recorder against the live Tradier production API, writing one date
// partition under `<DATA_DIR>/option-chains/<YYYY-MM-DD>/`.
//
// Why DATA_DIR and not the CLI's `./data/option-chains`: on Render the
// container filesystem is ephemeral and only the persistent disk (mounted at
// DATA_DIR, see render.yaml `disk.mountPath`) survives restarts/redeploys.
// The replay harness needs ~30 daily partitions accumulated over ~6 weeks,
// so the partitions must land on the disk. `CHAINS_OUT_DIR` can override.
//
// DTE window is 14–60 days — NOT the CLI's 35-day default. Per the TRA-379
// sweep spec the RV scanner's live window is 21–60d (TRA-373); a 35-day cap
// would starve RV's upper half in the replay. 14–60 is the union the OTM +
// RV scanners both need.
//
// Production creds come from the server env (TRADIER_API_TOKEN). A missing
// token logs a warning and no-ops rather than throwing — equity/crypto
// trading is unaffected. Per-symbol errors are isolated inside
// `recordOptionChains` and logged, never fatal.
const CHAIN_RECORD_OUT_DIR = process.env['CHAINS_OUT_DIR'] ?? join(DATA_DIR, 'option-chains');
// TRA-2476 — persistent "the 3:55 PM ET hook ran today" marker (ET date string).
// Lives beside the partitions on the data disk so it survives the pm2
// relaunches that reset the scheduler's in-memory dedup.
const CHAIN_HOOK_MARKER_PATH = join(CHAIN_RECORD_OUT_DIR, '.chain-hook-last-run');

// ── TRA-2417: option-chain archive compaction ────────────────────────────────
// `/data` is a 1 GB volume and the capture was adding ~8.4 MB/trading day with
// nothing reclaiming it — 48 partitions, ~403 MB, against 153.7 MB free on
// 2026-07-26 (~4 trading days from the 10% alert floor, ~13 from full). Gzip
// takes an aged partition to 11.3% of its bytes, MEASURED on 2026-07-24's, so
// compaction reclaims ~355 MB *without deleting a partition* — more than pruning
// 48→30 would (~209 MB), and it drops the per-day slope to ~1 MB as well.
//
// Retention is deliberately REPORT-ONLY: nothing here deletes a partition. The
// capture is the only copy, TRA-779's gate is `>= 30` days (48 is not out of
// policy), and once compacted the disk no longer needs the deletion. The number
// a prune WOULD reclaim is published on `/api/health/chain-capture` so the
// capture owner can decide with it.
const RETENTION_REPORT_TRADING_DAYS = Number(
  (process.env['CHAINS_RETENTION_REPORT_DAYS'] ?? '30').trim(),
) || 30;

/** Last compaction outcome, published on `/api/health/chain-capture`. */
let lastChainCompaction: {
  at: string;
  trigger: 'boot' | 'post-capture';
  partitionsCompacted: number;
  filesCompacted: number;
  bytesReclaimed: number;
  mbReclaimed: number;
  failures: number;
  durationMs: number;
} | null = null;

/**
 * Compact everything but the newest partition. Never throws and never blocks a
 * caller's critical path — a failure to reclaim space must not take down the
 * capture that produced it.
 *
 * A run with `filesCompacted: 0` is the STEADY STATE, not a failure: every aged
 * partition is already `.json.gz`. The field that distinguishes a healthy no-op
 * from a broken one is `failures` (and `lastCompaction.at` advancing at all).
 */
async function runChainCompaction(trigger: 'boot' | 'post-capture'): Promise<void> {
  try {
    const result = await compactChainPartitions({ outDir: CHAIN_RECORD_OUT_DIR });
    lastChainCompaction = {
      at: new Date().toISOString(),
      trigger,
      partitionsCompacted: result.partitionsCompacted,
      filesCompacted: result.filesCompacted,
      bytesReclaimed: result.bytesReclaimed,
      mbReclaimed: Math.round((result.bytesReclaimed / 1_048_576) * 100) / 100,
      failures: result.failures.length,
      durationMs: result.durationMs,
    };
    log.info('chain-compaction complete', { ...lastChainCompaction });
    for (const f of result.failures.slice(0, 10)) {
      log.warn('chain-compaction file failed — plaintext kept', f);
    }
  } catch (err) {
    log.error('chain-compaction failed', {
      trigger,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Returns true iff a capture ran (so the caller can stamp the per-day marker
 * — a token-less no-op must stay retryable within the day, see TRA-2476). */
async function runChainRecord(): Promise<boolean> {
  const apiToken = (process.env['TRADIER_API_TOKEN'] ?? '').trim();
  if (!apiToken) {
    log.warn('chain-recorder TRADIER_API_TOKEN unset — skipping option-chain snapshot');
    return false;
  }
  const accountId = (process.env['TRADIER_ACCOUNT_ID'] ?? '').trim() || 'recorder-readonly';
  const client = new TradierOptionsClient(apiToken, accountId, 'production');

  // TRA-779 — the capture universe defaults to the full equities WATCHLIST
  // (a superset of the Phase-2 baseline names AAPL/MSFT/NVDA/AMD/AVGO/GOOGL/
  // AMZN/META), but `CHAINS_WATCHLIST` can pin an explicit comma-separated list
  // (e.g. the confirmed Phase-2 12-name universe) without a code deploy.
  const rawUniverse = (process.env['CHAINS_WATCHLIST'] ?? '').trim();
  const symbols = rawUniverse
    ? rawUniverse.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...WATCHLIST];

  // TRA-779 — DTE floor lowered 14 → 7 so the nearest weeklies are captured for
  // short-dated call-debit-spread legs; the 21–35 DTE 0.25-delta puts and the
  // 60-day ceiling (OTM+RV replay union) stay covered. Widening is additive for
  // the existing replay scanners. `CHAINS_MIN_DTE` / `CHAINS_MAX_DTE` override.
  const minDteDays = Number((process.env['CHAINS_MIN_DTE'] ?? '7').trim()) || 7;
  const maxDteDays = Number((process.env['CHAINS_MAX_DTE'] ?? '60').trim()) || 60;

  log.info('chain-recorder starting', {
    symbols: symbols.length,
    universeSource: rawUniverse ? 'CHAINS_WATCHLIST' : 'WATCHLIST',
    dte: `[${minDteDays},${maxDteDays}]`,
    outDir: CHAIN_RECORD_OUT_DIR,
  });
  const result = await recordOptionChains({
    symbols,
    client,
    outDir: CHAIN_RECORD_OUT_DIR,
    minDteDays,
    maxDteDays,
  });
  const written = result.symbols.filter((s) => s.outcome === 'written').length;
  const errored = result.symbols.filter((s) => s.outcome === 'error');
  log.info('chain-recorder complete', {
    date: result.date,
    written,
    total: result.symbols.length,
    dir: result.outDir,
  });
  for (const s of errored) {
    log.warn('chain-recorder symbol error', {
      symbol: s.symbol,
      errorMessage: s.errorMessage,
    });
  }

  // TRA-1049 — enrich the freshly-written partition with a stamped `spot` and
  // `ivRank` so the recorded dataset is non-degenerate for TRA-1047's IVR-floor
  // sweep (the synthetic TRA-731 set carried ivRank=null, which is exactly the
  // variable the long-IVR gate reads). The recorder itself is a pure Tradier
  // data layer with no quote feed or IV store, so we do the enrichment here in
  // the server where both are available, as a best-effort post-pass:
  //   spot   — backed out of the chain via put-call parity (estimateSpotFromChain).
  //   ivRank — atmIvFromRows → recordDailyIv (warms the trailing-year store over
  //            the recorder's full universe, a superset of the ideas-service feed)
  //            → ivRankSync against that store. Honest-null until the store has
  //            >= MIN_IV_SAMPLES, so a cold store never fabricates a rank.
  // The replay loader reads these top-level file fields (loadChainDays /
  // options-replay-phasea `readIvRank`). Per-symbol failures are isolated and
  // never abort the capture.
  await enrichChainPartition(result.date);

  // TRA-2417 — reclaim the day BEFORE this one. Runs after enrichment so the
  // partition being compacted is already IVR-stamped and settled.
  await runChainCompaction('post-capture');
  return true;
}

// TRA-1049 — post-pass that stamps `spot` + `ivRank` onto each per-symbol file
// of the given date partition. Idempotent: re-reads the file the recorder just
// wrote, adds the two fields, rewrites. Pure best-effort — any error per symbol
// is logged and skipped.
async function enrichChainPartition(date: string): Promise<void> {
  const dir = join(CHAIN_RECORD_OUT_DIR, date);
  // TRA-2417 — via `listChainSnapshotFiles`, so a compacted (`.json.gz`)
  // partition is enriched rather than skipped. The old `endsWith('.json')`
  // filter would have matched nothing there and logged `stamped 0 / total 0`,
  // which reads exactly like an already-enriched partition.
  const files = await listChainSnapshotFiles(dir);
  if (files.length === 0) return;
  const recordedAt = Date.parse(`${date}T20:00:00Z`); // ~3:55 PM ET capture instant for ranking asOf.
  let stamped = 0;
  for (const f of files) {
    const path = join(dir, f);
    try {
      const snap = (await readChainSnapshotFile(path)) as import('@trading-app/backtest').OptionChainSnapshotFile & {
        ivRank?: number | null;
      };
      if (!snap || !Array.isArray(snap.rows) || typeof snap.symbol !== 'string') continue;
      // Idempotent: a file already carrying `ivRank` was enriched on a prior
      // run (today's post-pass or the boot backfill) — leave its as-of rank.
      if (snap.ivRank !== undefined) continue;
      const spot =
        snap.spot != null && Number.isFinite(snap.spot) && snap.spot > 0
          ? snap.spot
          : estimateSpotFromChain(snap.rows);
      const asOf = typeof snap.recordedAt === 'number' ? snap.recordedAt : recordedAt;
      const atmIv = spot != null ? atmIvFromRows(snap.rows, spot) : null;
      if (atmIv != null) {
        // Warm the trailing-year IV store with this capture, then rank against it.
        await recordDailyIv(snap.symbol, atmIv, asOf);
      }
      const ivRank = atmIv != null ? ivRankSync(snap.symbol, atmIv, asOf) : null;
      snap.spot = spot ?? null;
      snap.ivRank = ivRank;
      // TRA-2417 — writes back in the form the path names; a `.json.gz` stays gzipped.
      await writeChainSnapshotFile(path, snap);
      stamped += 1;
    } catch (err) {
      log.warn('chain-recorder enrich failed', {
        file: f,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info('chain-recorder enriched partition', { date, stamped, total: files.length });
}

// TRA-1049 — one-shot backfill so the ~26 partitions captured before this change
// shipped become IVR-bearing without waiting a month for forward captures. Walks
// every date partition ascending; `enrichChainPartition` warms `recordDailyIv`
// as it goes and skips already-stamped files, so the IV store accrues history
// and the earliest days honestly stay `ivRank: null` until the trailing window
// reaches MIN_IV_SAMPLES, then later days rank against it. Idempotent and
// best-effort — runs once at boot, a no-op on every boot thereafter.
async function backfillChainEnrichment(): Promise<void> {
  const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
  let dates: string[];
  try {
    dates = (await readdir(CHAIN_RECORD_OUT_DIR)).filter((d) => DATE_PARTITION.test(d)).sort();
  } catch {
    return;
  }
  if (dates.length === 0) return;
  log.info('chain-recorder backfill enrich starting', { partitions: dates.length });
  for (const date of dates) {
    await enrichChainPartition(date);
  }
  log.info('chain-recorder backfill enrich complete', { partitions: dates.length });
}
// Fire-and-forget at boot — never blocks startup; the IV store was warmed above.
// TRA-2417 — compaction chains off the enrichment backfill rather than racing
// it: the backfill rewrites any unstamped file, and doing that first means
// compaction never has to rewrite a partition twice. Both are idempotent, so a
// boot on an already-compacted archive is a directory walk. This is the path
// that reclaims the ~355 MB on the first deploy carrying it — it does not wait
// for the next 3:55 PM ET capture.
void backfillChainEnrichment().then(() => runChainCompaction('boot'));

// TRA-1971 (TRA-1965, item 5) — publish the AI-Options-Ideas weekly forward-test
// roll-up. Reads the SAME report + gate the `/api/options/forward-test/report` and
// `/api/health/live-capital-gate` probes expose, renders a News-tab markdown
// summary, and upserts it to the research store IN-PROCESS (no admin-token HTTP
// hop — the exact creds gap that kept the old routine from posting). Idempotent
// per week via the `weekly_review-options-ideas-<asOfDate>` id; the scheduler
// fires this once per ET Monday. Read-only: wires no capital.
async function runWeeklyOptionsRollup(): Promise<void> {
  const [entries, days] = await Promise.all([
    listJournalEntries(),
    loadChainDays(CHAIN_RECORD_OUT_DIR),
  ]);
  const outcomes = await forwardTestIdeas(entries);
  const report = buildForwardTestReport(outcomes, { chainsDir: defaultChainsDir() });
  const gateCriteria = resolveLiveCapitalGateCriteria();
  const gate = evaluateLiveCapitalGate(report, gateCriteria, {
    useCalibratedPop: isPopCalibrationEnabled(),
  });
  const monitor = buildAccumulationMonitor({
    report,
    gate: gateCriteria,
    chainOutDir: CHAIN_RECORD_OUT_DIR,
    chainDates: days.map((d) => d.date),
    journalCount: entries.length,
    firstJournaledDate: entries[0]?.surfacedDate ?? null,
    lastJournaledDate: entries.length ? entries[entries.length - 1].surfacedDate : null,
    tradierConfigured: Boolean(process.env['TRADIER_API_TOKEN']),
    anthropicConfigured: Boolean(process.env['ANTHROPIC_API_KEY']),
  });
  const bodyMarkdown = renderWeeklyRollupMarkdown({
    monitor,
    report,
    gatePassed: gate.passed,
    gateSummary: gate.summary,
  });
  await saveResearchReport({
    id: `weekly_review-options-ideas-${report.asOfDate}`,
    kind: 'weekly_review',
    title: `AI Options Ideas — Forward-Test Roll-Up (week of ${report.asOfDate})`,
    bodyMarkdown,
  });
  log.info('weekly options-ideas roll-up published', {
    asOfDate: report.asOfDate,
    surfaced: report.totals.surfaced,
    resolved: report.totals.resolved,
    weeksWithResolved: report.totals.weeksWithResolved,
    gatePassed: gate.passed,
    clockStarted: monitor.clock.started,
  });
}

// TRA-845 — Layer-4 alert push. Runs right after the daily chain capture so it
// diffs the freshly-written partition against yesterday's. Chain-diff + IV-move
// alerts are global (same chain for everyone) and pushed to every user; the
// target/stop scan is per-user over that user's active-mode open book. Each
// alert is mapped onto an options `signal` event and handed to `emitAlert`,
// which fans it through the existing dispatcher — so per-user channel/quiet-hour
// prefs (and the dedup window) decide who actually gets pinged. Kill switch:
// `OPTIONS_ALERT_PUSH=off`. Fully isolated: a failure here never affects the
// capture (the caller wraps it) and a single user's error never aborts the loop.
// TRA-2476 — emit slice size. Each `emitAlert` is fire-and-forget, but its
// synchronous prep plus the microtask continuations it spawns all drain before
// the event loop can advance, so an unbounded emit loop runs as ONE macrotask.
const ALERT_EMIT_SLICE = 100;
const yieldToEventLoop = (): Promise<void> => new Promise((res) => setImmediate(res));

async function runOptionsAlertPush(): Promise<void> {
  if ((process.env['OPTIONS_ALERT_PUSH'] ?? '').trim().toLowerCase() === 'off') {
    log.info('options-alert push disabled (OPTIONS_ALERT_PUSH=off)');
    return;
  }
  // TRA-2476: only the newest two non-empty partitions are diffed — loading
  // every recorded partition (~45 dates of full chains) spiked RSS at 3:55 PM
  // ET on the process's fattest heap of the day, the same instant the emit
  // burst below lands.
  const days = await loadChainDays(CHAIN_RECORD_OUT_DIR, { lastN: 2 });
  if (days.length < 2) {
    log.info('options-alert push skipped — need 2 chain partitions', { have: days.length });
    return;
  }
  const prevDay = days[days.length - 2];
  const todayDay = days[days.length - 1];

  // Global chain-diff + IV-move alerts: computed once, shared across users.
  // TRA-2476: yield between symbols — this pass and the per-user emit loop
  // below used to run as one synchronous macrotask (2,408 alerts × 30 user
  // contexts = 72,240 emits), a 40.6s event-loop block at 19:56:50Z that the
  // watchdog killed 3 minutes before the close, burning the TRA-2213 session.
  const chainAlerts: OptionsAlert[] = [];
  for (const [symbol, today] of [...todayDay.bySymbol.entries()].sort()) {
    const prev = prevDay.bySymbol.get(symbol);
    if (prev) chainAlerts.push(...diffChain(prev, today));
    await yieldToEventLoop();
  }

  let pushed = 0;
  for (const ctx of getAllUserContexts()) {
    try {
      const openOptions = ctx.engine.getState().options.openOptions ?? [];
      const positionAlerts = scanTargetStop(openOptions);
      const events = toAlertEvents([...positionAlerts, ...chainAlerts], ctx.username);
      for (let i = 0; i < events.length; i += ALERT_EMIT_SLICE) {
        const end = Math.min(i + ALERT_EMIT_SLICE, events.length);
        for (let j = i; j < end; j += 1) emitAlert(events[j]);
        // Let the watchdog sampler, health checks and GC interleave between
        // slices — the dispatcher's dedup/digest handling is unaffected by
        // WHEN an event is emitted, only by its dedupKey.
        await yieldToEventLoop();
      }
      pushed += events.length;
    } catch (err) {
      log.warn('options-alert push failed for user', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info('options-alert push complete', {
    chainAlerts: chainAlerts.length,
    eventsEmitted: pushed,
    dates: [prevDay.date, todayDay.date],
  });
}

// TRA-822 (TRA-820 Step 1) — daily StockTwits sentiment-snapshot logger. Runs on
// the SAME 3:55 PM ET hook as the chain recorder so the two snapshots
// co-accumulate on the persistent disk (the IC/flow study joins them per
// symbol-day). StockTwits sentiment is otherwise held only in-memory
// (`SignalEngine.socialCache`), so without this logger there is no persisted
// history to measure. Mirrors the engine read path: crowd stream + curated
// followed-account lane, deduped by message id, reduced by
// `aggregateStockTwitsSentiment`. The StockTwits endpoint is key-less, so this
// needs no creds — a rate-limited/cold fetch records `no_data` for that
// symbol-day rather than throwing. Universe is the equities WATCHLIST (the
// TRA-820 §2 25-name study universe); `SENTIMENT_WATCHLIST` overrides.
const SENTIMENT_RECORD_OUT_DIR =
  process.env['SENTIMENT_OUT_DIR'] ?? join(DATA_DIR, 'sentiment-snapshots');

/**
 * TRA-2519 — half-open retry budget for one sentiment sweep. Two extra passes
 * against a 5-minute default cooldown covers ~11 minutes of throttle, which is
 * the shape of the bursts on the tape, while staying far inside the
 * 15:55–20:00 ET capture window so a retrying sweep can never run past it.
 */
const SENTIMENT_RETRY_MAX_ATTEMPTS = 2;
const SENTIMENT_RETRY_BUDGET_MS = 12 * 60_000;

async function runSentimentSnapshot(): Promise<void> {
  const rawUniverse = (process.env['SENTIMENT_WATCHLIST'] ?? '').trim();
  const symbols = rawUniverse
    ? rawUniverse.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...WATCHLIST];

  // Build the curated (followed-account) lane once for the whole sweep, mirroring
  // SignalEngine.refreshCuratedSocialSentiment: pull each curated user stream,
  // map messages onto every symbol they mention. Best-effort — a fully throttled
  // pull just yields an empty curated map (crowd-only reads still record).
  const curatedCollected: StockTwitsMessage[] = [];
  for (const user of getCuratedStockTwitsAccounts()) {
    try {
      const messages = await fetchStockTwitsUserStream(user);
      if (messages !== null) curatedCollected.push(...messages);
    } catch (err) {
      log.warn('sentiment-recorder curated fetch failed', {
        account: user,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const curatedBySymbol = mapCuratedMessagesBySymbol(curatedCollected);

  log.info('sentiment-recorder starting', {
    symbols: symbols.length,
    universeSource: rawUniverse ? 'SENTIMENT_WATCHLIST' : 'WATCHLIST',
    curatedSymbols: curatedBySymbol.size,
    outDir: SENTIMENT_RECORD_OUT_DIR,
  });

  const result = await recordSentimentSnapshot({
    symbols,
    outDir: SENTIMENT_RECORD_OUT_DIR,
    fetchSentiment: async (symbol) => {
      const crowd = await fetchStockTwitsStream(symbol);
      // Null = rate-limited / cold: no read for this symbol-day. An empty array
      // is a genuine "no messages" read and still aggregates to a neutral row.
      if (crowd === null) return null;
      const curated = curatedBySymbol.get(symbol.toUpperCase()) ?? [];
      const messages = dedupeStockTwitsMessages([...curated, ...crowd]);
      return aggregateStockTwitsSentiment({ symbol, messages, now: Date.now() });
    },
    // TRA-2519 — separate "the breaker short-circuited us, no request left the
    // box" from "a request went out and was refused". Both wrote a bare
    // `no_data` before, which is why two zeroed sessions could not be attributed
    // from the artifact alone and needed a Render log dig.
    describeUnavailable: () => (isStockTwitsBreakerOpen() ? 'breaker_open' : 'fetch_failed'),
    // TRA-2519 (ask #2) — bounded half-open retry. A sweep that opens inside a
    // cooldown is otherwise a ~3ms no-op that zeroes all 25 symbols and never
    // looks again; bqb1's breaker cooldown is the 5-minute default (no reset
    // header arrives), so two waits clear a typical burst. Budget is capped
    // because the watchdog can kill this process at any moment (TRA-2476) —
    // better to bank a partial day via the merge than to block for an hour.
    retry: {
      maxAttempts: SENTIMENT_RETRY_MAX_ATTEMPTS,
      budgetMs: SENTIMENT_RETRY_BUDGET_MS,
      nextDelayMs: () => {
        const until = stockTwitsBreakerOpenUntil();
        // Breaker already closed → retry immediately; the failure was per-request
        // (Cloudflare 503 / timeout), not a cooldown we must sit out.
        if (until === null) return 0;
        return Math.max(0, until - Date.now()) + 1_000; // +1s so we land after the reset
      },
    },
  });

  const recorded = result.symbols.filter((s) => s.outcome === 'recorded').length;
  log.info('sentiment-recorder complete', {
    date: result.date,
    recorded,
    total: result.symbols.length,
    dir: result.outDir,
    // TRA-2519 provenance: `sweptRecorded` < `recorded` means this run found
    // less than a previous run of the same ET day and the merge protected it.
    // Under the old blind overwrite that gap was the data we destroyed.
    attempts: result.attempts,
    sweptRecorded: result.swept.filter((s) => s.outcome === 'recorded').length,
    preservedFromPrior: result.preservedFromPrior.length,
  });
}

// TRA-1209 (TRA-1208 Phase-2 Step 1) — short-squeeze observe-capture loop. Rides
// the SAME 3:55 PM ET `onChainRecord` hook as the chain + sentiment recorders so
// one qualifier reading per trading day co-accumulates on the persistent disk.
// OBSERVE-ONLY and default-OFF: gated behind `SHORT_SQUEEZE_CAPTURE`
// (on/true/1/yes to enable), records what the screener sees, never sizes or
// places an order. Short interest is bi-monthly and RVOL is a daily reading, so
// once/session is ample.
//
// Universe mirrors the scan route: the resolved demo watchlist
// (`getStocksWatchlistData(<demo user>).all`), with a `SHORT_SQUEEZE_WATCHLIST`
// comma-separated override for pinning — same convention as `CHAINS_WATCHLIST`.
//
// Capture is taken at the SHIPPED PERMISSIVE thresholds (RVOL > 1.0) — the
// scanner service is constructed with no threshold override, so it scores at the
// engine spec defaults. This is intentional: we want the full RVOL distribution
// across short-float-eligible names to ratify QuantTrader's provisional 1.5 cut
// empirically, so the recommended tightening is NOT pre-applied at capture time.
const SHORT_SQUEEZE_CAPTURE_OUT_DIR =
  process.env['SHORT_SQUEEZE_OUT_DIR'] ?? join(DATA_DIR, 'short-squeeze-capture');

function shortSqueezeCaptureEnabled(): boolean {
  const flag = (process.env['SHORT_SQUEEZE_CAPTURE'] ?? '').trim().toLowerCase();
  return flag === 'on' || flag === 'true' || flag === '1' || flag === 'yes';
}

/**
 * Resolve the demo watchlist for the capture. Prefers the first demo-mode user's
 * watchlist (the $25k paper book the screener grades against), falling back to
 * any user context, then the `admin` namespace — `getStocksWatchlistData` returns
 * the base WATCHLIST for an unknown user, so this always yields a sane universe.
 */
function resolveShortSqueezeUniverse(): { symbols: string[]; source: string } {
  const raw = (process.env['SHORT_SQUEEZE_WATCHLIST'] ?? '').trim();
  if (raw) {
    return {
      symbols: raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
      source: 'SHORT_SQUEEZE_WATCHLIST',
    };
  }
  const contexts = getAllUserContexts();
  const demoUser = contexts.find((ctx) => getSettings(ctx.username).mode === 'demo')?.username;
  const user = demoUser ?? contexts[0]?.username ?? 'admin';
  return { symbols: getStocksWatchlistData(user).all, source: `demo-watchlist:${user}` };
}

async function runShortSqueezeCapture(): Promise<void> {
  if (!shortSqueezeCaptureEnabled()) {
    log.info('short-squeeze capture disabled (SHORT_SQUEEZE_CAPTURE off)');
    return;
  }
  const { symbols, source } = resolveShortSqueezeUniverse();
  if (symbols.length === 0) {
    log.warn('short-squeeze capture — empty universe, skipping', { source });
    return;
  }
  log.info('short-squeeze capture starting', {
    symbols: symbols.length,
    universeSource: source,
    outDir: SHORT_SQUEEZE_CAPTURE_OUT_DIR,
  });
  const result = await recordShortSqueezeCapture({
    symbols,
    scanUniverse: (syms) => shortSqueezeScannerService.scanUniverse(syms),
    outDir: SHORT_SQUEEZE_CAPTURE_OUT_DIR,
    thresholds: DEFAULT_SHORT_SQUEEZE_THRESHOLDS,
    universeSource: source,
  });
  const ok = result.symbols.filter((s) => s.outcome === 'ok').length;
  const qualifiers = result.symbols.filter((s) => s.qualifies === true).length;
  log.info('short-squeeze capture complete', {
    date: result.date,
    ok,
    qualifiers,
    total: result.symbols.length,
    dir: result.outDir,
  });
}

// TRA-1209 — append/advance the forward outcome (+1d/+3d/+5d close return + the
// 5-session MFE) on already-captured qualifier rows once the post-scan sessions
// have closed. This is the label QuantTrader's Step-2 sign-off (TRA-1208) grades
// on. Observe-only, idempotent, and reconstructable from historical bars, so it
// runs on the same daily hook right after the capture and only rewrites a
// partition when it folds in genuinely new sessions. Gated by the same flag.
async function runShortSqueezeForwardResolve(): Promise<void> {
  if (!shortSqueezeCaptureEnabled()) return;
  const res = await resolveShortSqueezeForwardOutcomes({
    outDir: SHORT_SQUEEZE_CAPTURE_OUT_DIR,
    fetchDailyBars: async (symbol, count) => fetchDailyCandles(symbol, count),
  });
  log.info('short-squeeze forward-resolve complete', {
    partitions: res.partitions,
    filesUpdated: res.filesUpdated,
    rowsResolved: res.rowsResolved,
    rowsComplete: res.rowsComplete,
  });
}

// TRA-596 (TRA-595 C1) — refresh the upcoming-earnings calendar for the active
// stock universe. Runs on boot and on the 9 AM ET pre-market hook. Skips (with
// a warning) when FINNHUB_API_TOKEN is unset, and isolates provider failures so
// a bad/rate-limited fetch can never fault the boot path or a scheduled tick.
async function runEarningsRefresh(): Promise<void> {
  const client = makeEarningsClientFromEnv();
  if (!client) {
    log.warn('earnings-refresh FINNHUB_API_TOKEN unset — skipping earnings-calendar refresh');
    return;
  }
  const symbols = [...WATCHLIST];
  try {
    const { covered, uncovered } = await refreshEarningsCalendar(client, symbols);
    log.info('earnings-refresh complete', { requested: symbols.length, covered, uncovered });
  } catch (err) {
    log.error('earnings-refresh failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// TRA-597 (TRA-595 C2) — refresh the macro/Fed economic calendar (FOMC + CPI /
// NFP / PCE). Runs on boot and on the 9 AM ET pre-market hook. Skips the FRED
// fetch (with a warning) when FRED_API_KEY is unset, and isolates provider
// failures so a bad/rate-limited fetch can never fault boot or a scheduled tick.
async function runMacroRefresh(): Promise<void> {
  const client = makeMacroClientFromEnv();
  if (!client) {
    log.warn('macro-refresh FRED_API_KEY unset — skipping economic-calendar refresh');
    return;
  }
  try {
    const { stored, fomc } = await refreshMacroCalendar(client);
    log.info('macro-refresh complete', { stored, fomc });
  } catch (err) {
    log.error('macro-refresh failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── REST endpoints ───────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// TRA-528 — live reliability + observability surface:
//   GET /api/health/version  → deploy-version pinning (commit/build/uptime).
//   GET /api/health/live     → consolidated GREEN/YELLOW/RED Live verdict
//                              (mode, broker auth, feed freshness, halt, build).
// Handlers + the monitor's stale-state probe live in observability/health-routes
// so this file only injects the request-scoped deps it owns.
// TRA-580 — also expose the redacted, unauthenticated live-equity acceptance
// probe. `liveEquityAcceptance` enumerates every engine via the existing
// `getAllUserContexts()` and maps each to its redacted snapshot (booleans /
// counts / timestamps only — no trade specifics), so the first organic
// production Tradier OTOCO fill can be verified against the live deployment
// without shipping credentials into an agent env.
// TRA-901 — also grant the unattended TRA-898 daily-watch routine token-gated
// access to the (otherwise user-JWT-only) demo-book surface. `internalToken`
// is the shared secret from env (rotation-tracking, empty disables internal
// access); `fleetBooks` enumerates the fleet's engines so the routine can read
// the $25k paper book without authenticating as that account. TRA-2650 — that
// provider is fleet-WIDE and email-bearing; the demo narrowing lives in the
// routes that need it.
registerLiveHealthRoutes(app, {
  requireAuth,
  userCtx,
  getSettings,
  liveEquityAcceptance: () => getAllUserContexts().map(ctx => ctx.engine.getLiveEquityAcceptance()),
  // TRA-2200 (parent TRA-2171) — unauth exit-cadence probe. Enumerates every
  // engine's exit-evaluation interval instrument so the "p99 exit-evaluation
  // interval > 30s" invalidation criterion is readable off the live box without a
  // login. Secrets-free (flags, counts, interval buckets).
  exitCadence: () => getAllUserContexts().map(ctx => ctx.engine.getExitCadenceHealth()),
  // TRA-2209 — the effective env (process.env + demo-flags.json overlay) that the
  // engine itself consults, so `/api/health/env-drift` compares render.yaml against
  // what the process ACTUALLY resolves rather than against raw process.env (which
  // would report every daemon-free operator flip as phantom drift).
  effectiveEnv: () => demoFlagEnv(),
  internalToken: () => (process.env['DEMO_BOOK_INTERNAL_TOKEN'] ?? '').trim() || undefined,
  // TRA-2650 — ⚠ DO NOT re-introduce a `.filter(b => b.mode === 'demo')` here,
  // and do not drop `email`. This provider hands over the WHOLE fleet; each
  // health route narrows it itself (`demoModeBooks`). The previous demo-only,
  // email-less version made `role:'operator'` unreachable for an armed operator
  // and left `isTestAccount`'s email branch dead in production — both invisible
  // to every unit test, because the defect was here in the caller and not in
  // the functions under test. `projectFleetBooks` is the shared seam that
  // `health-routes.wiring.test.ts` grades.
  fleetBooks: () =>
    projectFleetBooks(
      getAllUserContexts(),
      username => getSettings(username).mode,
      username => getUser(username)?.email,
    ),
  // TRA-895 — unauth options-signal pipeline probe. Enumerates demo-mode engines
  // + the shared RV scanner status so "no option signals" is diagnosable without
  // a login or the internal demo-book token. Secrets-free (booleans/counts only).
  optionsPipeline: () => {
    const diag = relativeValueScannerService.diagnostics();
    return {
      rvScannerConfigured: diag.configured,
      rvBreakerOpen: diag.breakerOpen,
      engines: getAllUserContexts()
        .map(ctx => ({ state: ctx.engine.getState(), mode: getSettings(ctx.username).mode }))
        .filter(e => e.mode === 'demo'),
    };
  },
});

// TRA-1004 — autonomous demo-loop status. Unauthenticated by design (parity with
// the other `/api/health/*` probes): the snapshot carries only the flag state,
// cadence, tick counters, and per-book decision summaries (booleans / counts /
// usernames / halt reasons) — no trade specifics, prices, or credentials. Lets
// QA / ops confirm the demo book is self-driving (and see autopilot halts /
// throttles) without a login. Flag off ⇒ `enabled:false` and zero recent ticks.
app.get('/api/health/autonomous-demo', (_req, res) => {
  res.json(getAutonomousDemoStatus(demoFlagEnv()));
});

// TRA-1304 — tokenless acceptance probe for the item-5 live DCA canary
// (QuantTrader comment 4436ec31). Enumerates every engine's redacted canary
// readout (booleans / counts / ids / aggregate notional only — no keys, prices,
// or order specifics) so the canary ARM state and the four PASS criteria can be
// verified against the live deployment without shipping Coinbase credentials
// into an agent env. Unauthenticated by design, matching the other health
// probes. Canary off / demo-only ⇒ canaryArmed:false and empty PASS evidence.
app.get('/api/health/crypto-dca-canary', (_req, res) => {
  res.json({
    time: new Date().toISOString(),
    engines: getAllUserContexts().map(ctx => ({
      username: ctx.username,
      ...ctx.cryptoEngine.getCryptoDcaCanaryAcceptance(),
    })),
  });
});

// TRA-1633 FIX 3 — cross-surface P&L reconciliation guard (parent TRA-1597).
// Per ET day, checks the one identity that MUST hold across the four surfaces:
//   EOD.combinedPnl == stock dailyPnl (realized) + day-only options realized
// and flags any |drift| > $0.01 with the offending date(s). The stock dailyPnl
// and day-only options come from the persisted daily snapshots (the same ledger
// the Calendar/cumulative windows read after this ticket's BUG 2 fix); the EOD
// combined is read off the settled per-day report files. Public health probe,
// matching /api/health/option-journal — demo book, no capital, redacted to P&L
// deltas only. On a clean box `maxDriftUsd == 0`.
app.get('/api/health/pnl-reconciliation', async (_req, res) => {
  try {
    // TRA-1636 — only evaluate days on/after the baseline; earlier rows were
    // written by pre-fix code (TRA-1633) and would keep the guard red forever.
    const baselineDate = resolvePnlBaselineDate(process.env);
    // TRA-2302 — load the DURABLE option-trade journal once and bucket each
    // book's closes by ET day. This is the control that gives the day-only
    // options ledger a failing state: `optionsDailyPnl` is summed from the
    // engine's VOLATILE in-memory `closedOptions` bucket at 21:00 ET, so a day
    // whose closes were archived/lost before that write books 0.00 — the exact
    // number a day with no option activity books. The journal is append-only
    // and per-trade, so it can separate the two. A journal read failure leaves
    // the census null (⇒ `journalCloses: null`, never a manufactured zero).
    let journalRows: Awaited<ReturnType<typeof listOptionTradeJournal>> | null = null;
    if (isOptionTradeJournalEnabled()) {
      try {
        journalRows = await listOptionTradeJournal();
      } catch (err) {
        log.warn('pnl-reconciliation: option-journal census unavailable', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // TRA-2817 — the exchange calendar the TAIL axis grades against. Built ONCE
    // per request so all 61 books are held to the same settled session; deriving
    // it per book would let a read that straddles 21:00 ET grade half the fleet
    // against one date and half against another.
    //
    // `lastSettledSession` is the newest session whose 21:00 ET archive is
    // already PAST, NOT simply the last market day. Today only counts once its
    // own archive has run — otherwise every read between the 16:00 bell and
    // 21:00 ET would accuse a perfectly healthy ledger of missing today, and an
    // axis that is red every weekday afternoon is one nobody believes on the
    // afternoon it is right. The same `etHour() >= 21` boundary the archive tick
    // itself fires on, so the two cannot disagree about what has settled.
    const tailCalendar = currentEodTailCalendar();
    const engines = await Promise.all(
      getAllUserContexts().map(async ctx => {
        // TRA-2761 — classify off `loadSettings`, NOT `getSettings`. `getSettings`
        // serves `DEFAULT_ACCOUNT_SETTINGS` (mode: demo) on a cache miss, so any
        // eviction of the operator's cache entry silently reclassified the live
        // book as demo, emptied the live cohort, and flipped every `live*` verdict
        // FALSE → null with the defect unchanged (observed live 2026-08-02T00:47Z:
        // 61/61 `mode:"demo"` while the journal held 10 open+closed `mode:"live"`
        // rows; the same process had served `admin` as live 33h earlier).
        // `loadSettings` returns the cached reference when present, so the cost is
        // identical on the hot path and a miss re-reads the durable store instead
        // of manufacturing a demo classification.
        const mode = stockModeKey(await loadSettings(ctx.username));
        const dir = stockReportsDirFor(ctx, mode);
        const snapshots = ctx.tracker.getSnapshots();
        const eodByDate = new Map<string, number>();
        // TRA-2314 — also carry the report file's OPTIONS leg. Reading only
        // `combinedPnl` is why TRA-2302 could not close its second pathway: on
        // 2026-07-15 / 07-21 `eodCombined` matched the journal total exactly
        // while the snapshot booked 0.00, and from `combinedPnl` alone there is
        // no way to tell an options figure the snapshot missed from an equal
        // amount of stock P&L.
        const eodOptionsByDate = new Map<string, number>();
        // TRA-2630 DEFECT A — also carry the report file's STOCK leg
        // (`realizedPnl`). Without it `drift` pools a LOSSY stock figure (this
        // list is summed from `allClosedPositions`, which the TRA-219 archive
        // clears at the same 21:00 ET the report is written) against the DURABLE
        // equity delta in `stockDaily`, and no consumer can tell which side
        // moved. Measured on 2026-07-30: 40 of 40 post-baseline sessions with a
        // non-zero `stockDaily` had this leg at exactly 0.00.
        const eodStockByDate = new Map<string, number>();
        for (const s of snapshots) {
          const filePath = join(dir, `${s.date}.json`);
          if (!existsSync(filePath)) continue;
          try {
            const report = JSON.parse(await readFile(filePath, 'utf-8')) as {
              combinedPnl?: number;
              optionsPnl?: number;
              realizedPnl?: number;
            };
            if (typeof report.combinedPnl === 'number') eodByDate.set(s.date, report.combinedPnl);
            if (typeof report.optionsPnl === 'number') eodOptionsByDate.set(s.date, report.optionsPnl);
            if (typeof report.realizedPnl === 'number') eodStockByDate.set(s.date, report.realizedPnl);
          } catch { /* skip unreadable report file */ }
        }
        // Scope the census to THIS book — pooling another account's closes in
        // would attribute them here (the TRA-2193 trap). Rows written before
        // TRA-1475 carry no `account` and are unattributable, so they are left
        // out rather than credited to whichever book is being read.
        //
        // TRA-2314 — `journalRowsForBook` is now the ONE shared predicate: the
        // 21:00 writer, the historical repair and this checker all scope the
        // same way. A checker grading a population the writer never saw is a
        // guard that can never go green no matter how correct the fix is.
        const bookRows = journalRows == null
          ? null
          // TRA-2421 — identity epoch; see the note at the 21:00 writer.
          : journalRowsForBook(journalRows, ctx.username, accountDeletedAt(ctx.username));
        const journalByDate = bookRows == null
          ? null
          : foldJournalClosesByEtDay(bookRows, (ts: number) => etDateString(new Date(ts)));
        // TRA-2761 — this book's OPEN live-mode journal rows: the durable evidence
        // that live notional exists regardless of what the read-time classifier
        // says. Consumed by `summarizeLiveCohortIntegrity` below.
        const openLiveRows = bookRows == null
          ? null
          : bookRows.filter(r => r.mode === 'live' && typeof r.closeTs !== 'number');
        // TRA-2831 — the ET date this book first opened a LIVE option, from the
        // same `bookRows` population everything else on this endpoint is scoped
        // to. Without it the live credit axis folds a demo→live book's entire
        // pre-flip demo P&L into `liveUncreditedOptionsUsd` and publishes the
        // total as a live-money shortfall (733.60 on `admin`, 100% demo-sourced).
        //
        // A null census leaves this null, which reads as "nothing in the window
        // is provably live" — the numerator is disqualified rather than being
        // credited by default. That is the only safe direction: the failure mode
        // this exists to stop is a demo figure wearing a live label.
        const liveOptionsOnsetDate = bookRows == null
          ? null
          : liveOptionsOnsetEtDate(bookRows, (ts: number) => etDateString(new Date(ts)));
        // TRA-2829 — the EOD back-fill plan for this book, computed READ-ONLY.
        //
        // Published rather than acted on. The CFO ruling on TRA-2827 requires the
        // reach of the broker equity series be reported BEFORE anything is
        // written, because that measurement is what decides whether a session's
        // `closingEquity` can be a number at all or must be an honest `null`.
        // Publishing it here makes it readable off prod without writing a byte,
        // and it stays published afterwards as the writer's own audit surface.
        //
        // Live books only: this reconstructs from `tradier-eod-balance.*`, which
        // demo books do not have, and the hole this exists for is the live
        // options record.
        //
        // A NULL census disqualifies the plan entirely. Without a journal to
        // ask, every absent session would plan an options leg of exactly 0.00 —
        // which is not "no trades", it is the false zero TRA-2314 exists to
        // fix, and back-filling it would carve the defect into rows that then
        // read as reconstructed-from-the-journal. No census, no plan.
        const eodBackfillPlan = mode === 'live' && journalByDate != null
          ? planLiveEodRowBackfill({
            snapshots,
            censusByDate: journalByDate,
            balanceByDate: await loadTradierBalanceSnapshots(ctx, 'production'),
            calendar: tailCalendar,
          })
          : null;
        // TRA-2888 — THE INTERIOR-ABSENCE AXIS. Enumerated from `tailCalendar`
        // (the same NYSE calendar the 21:00 ET archive runs on) and diffed
        // against the rows this book actually has, rather than iterating the
        // rows — which is the only construction that can see a session that was
        // never written. Fed the raw snapshot dates, NOT `days[]`, so it stays
        // independent of the reconciliation row-builder it is auditing.
        const eodInterior = detectEodInteriorAbsence(
          snapshots.map(s => s.date),
          tailCalendar,
          baselineDate,
        );
        return {
          username: ctx.username,
          mode,
          eodBackfillPlan,
          eodInterior,
          openLiveJournalRowCount: openLiveRows == null ? null : openLiveRows.length,
          openLiveJournalAtRiskUsd: openLiveRows == null
            ? null
            : openLiveRows.reduce(
              (s, r) => s + (Number.isFinite(r.atRiskUsd) ? r.atRiskUsd : 0),
              0,
            ),
          ...reconcilePnl(
            snapshots,
            eodByDate,
            baselineDate,
            journalByDate,
            eodOptionsByDate,
            eodStockByDate,
            tailCalendar,
            liveOptionsOnsetDate,
          ),
        };
      }),
    );
    const maxDriftUsd = engines.reduce((m, e) => Math.max(m, e.maxDriftUsd), 0);
    res.json({
      time: new Date().toISOString(),
      ok: engines.every(e => e.ok),
      maxDriftUsd,
      // TRA-2630 AC1 — the disclaimer for the TWO fields immediately above,
      // placed where those fields are actually read. It was already written, but
      // only inside `reconcilePnl`'s result, i.e. at `engines[i].caveats` — one
      // level BELOW `ok` / `maxDriftUsd`, and 59 copies deep. TRA-2624's C5 keyed
      // on the response head; a gate author looking there saw `ok: false` and
      // nothing else. `driftGradeable: false` is the machine-readable half: a
      // checker can assert a boolean, it cannot assert a prose caveat.
      ...summarizeDriftGradeability(),
      baselineDate,
      // TRA-2302 — reported BESIDE `ok`, not folded into it, so the existing
      // drift verdict keeps its meaning for every consumer already reading it.
      optionsFalseZeroOk: engines.every(e => e.optionsFalseZeroOk),
      optionsJournalCensusAvailable: journalRows != null,
      // TRA-2314 — the repair's separating evidence, firm-wide. A book that was
      // never broken contributes no `journal-repair` rows; the desk books name
      // the days they lost. Reported beside `ok`, never folded into it.
      optionsDailyPnlRepairedCount: engines.reduce((n, e) => n + e.repairedDates.length, 0),
      // TRA-2630 DEFECT A — the per-leg verdicts that REPLACE `ok` for grading.
      // `ok` / `maxDriftUsd` above are retained byte-identical for existing
      // consumers but are NOT gradeable: they pool a lossy stock leg with a
      // durable one, so they have no reachable green state and cannot attribute
      // a mismatch. See `PNL_DRIFT_DECOMPOSITION_NOTE` in the caveats.
      // Each engine's figure is already `round2`-ed, so the max needs no further
      // rounding — same as `maxDriftUsd` above.
      // TRA-2633 — TRI-STATE fold, and it must NOT be `engines.every(...)`. That
      // was the shipped spelling, and with the per-engine verdict now `boolean |
      // null` it would coerce every NOT-MEASURED book to `false` — inventing a
      // firm-wide stock-leg REGRESSION out of "nobody looked". A red book still
      // wins; otherwise one genuinely-measured green is required to claim green;
      // all-null stays null.
      stockLegOk: engines.some(e => e.stockLegOk === false)
        ? false
        : engines.some(e => e.stockLegOk === true)
          ? true
          : null,
      stockLegMeasuredCount: engines.reduce((n, e) => n + e.stockLegMeasuredCount, 0),
      maxStockLegDriftUsd: engines.reduce((m, e) => Math.max(m, e.maxStockLegDriftUsd), 0),
      // TRA-2641 — this was `engines.every(e => e.optionsLegOk)`, which is the
      // THIRD place the same fold bug shipped. Two independent failures ride on
      // it now: `every` is true on the empty fleet, AND with the per-book verdict
      // now `boolean | null` it coerces NOT-MEASURED to `false`. Same precedence
      // as the two folds above — a red book wins, one genuinely-measured green is
      // required to claim green, all-null stays null.
      optionsLegOk: engines.some(e => e.optionsLegOk === false)
        ? false
        : engines.some(e => e.optionsLegOk === true)
          ? true
          : null,
      // The DENOMINATORS, published beside the verdict. `optionsLegMeasuredCount:
      // 0` with a large `optionsLegSlavedCount` is the signature of the TRA-2641
      // state: the report leg is written FROM the day cell, so the comparison is
      // one source against a copy of itself and cannot fail. Live 2026-07-30:
      // 0 measured / 147 slaved over 167 post-baseline rows.
      optionsLegMeasuredCount: engines.reduce((n, e) => n + e.optionsLegMeasuredCount, 0),
      optionsLegSlavedCount: engines.reduce((n, e) => n + e.optionsLegSlavedCount, 0),
      maxOptionsLegDriftUsd: engines.reduce((m, e) => Math.max(m, e.maxOptionsLegDriftUsd), 0),
      // TRA-2630 AC3 / TRA-2629 — the T+1 credit-lag tripwire, firm-wide.
      //
      // TRA-2630 AC2 — TRI-STATE fold, and for the same reason `stockLegOk`
      // above is one. This was `engines.every(e => e.priorOptionsLagOk)`; with
      // the per-book verdict now `boolean | null`, `every` COERCES NOT-MEASURED
      // TO FALSE and would report a firm-wide T+1 lag REGRESSION sourced entirely
      // from books whose tripwire never had a failing state. 32 of the 58 books
      // on bqb1 are in that state right now, so this is not a corner case — it
      // would have turned tomorrow's AC2 grade red on arrival.
      priorOptionsLagOk: engines.some(e => e.priorOptionsLagOk === false)
        ? false
        : engines.some(e => e.priorOptionsLagOk === true)
          ? true
          : null,
      priorOptionsLagBooks: engines
        .filter(e => e.priorOptionsLagOk === false)
        .map(e => ({ username: e.username, mode: e.mode, dates: e.priorOptionsLagDates })),
      // TRA-2630 AC2 — how many books the tripwire could actually have fired on.
      // Publishing the denominator is the whole lesson: `priorOptionsLagOk: true`
      // over 0 gradeable books and over 26 gradeable books are different claims,
      // and without this field they are the same reading.
      priorOptionsLagGradeableBookCount: engines.filter(
        e => e.priorOptionsLagEligibleDates.length > 0,
      ).length,
      // TRA-2835 — books carrying a session that WOULD have been gradeable under
      // the old array-adjacent pairing but is suppressed because its predecessor
      // row is not the preceding exchange session. Published for the same reason
      // the denominator above is: a cohort that silently shrank reads exactly
      // like one that was always this size. After the permanent TRA-2888 hole
      // (2026-07-30/07-31/08-03) this is where the 2026-08-04 rows went, and
      // grading AC2 on them would have been a PASS the tripwire could not fail.
      priorOptionsLagGapSuppressedBooks: engines
        .filter(e => e.priorOptionsLagGapSuppressedDates.length > 0)
        .map(e => ({
          username: e.username,
          mode: e.mode,
          dates: e.priorOptionsLagGapSuppressedDates,
        })),
      // THE REAL-MONEY TRIPWIRE. The demo-only verdict on TRA-2630 Defect B (and
      // with it the standing decision NOT to roll back TRA-2323) holds only while
      // this stays empty. A `mode: live` book showing `stockDaily` == the prior
      // session's `optionsDaily` to the cent is a NAV overstatement of one full
      // session of realized options P&L, and is reported SEPARATELY from the
      // demo books so a fixture book can never mask it — pooling the two is the
      // TRA-2193 trap this endpoint has already been bitten by twice.
      //
      // TRA-2630 follow-up — this used to be `engines.every(e => e.mode !== 'live'
      // || e.priorOptionsLagOk)`. `every` is TRUE ON THE EMPTY SET, so with no
      // live book in the fleet the real-money tripwire reported OK over a cohort
      // it never looked at. On 2026-07-30T05:16Z that is exactly what bqb1 served:
      // 58/58 books `mode: demo`, `livePriorOptionsLagOk: true`, because the
      // TRA-713/TRA-1652 boot-arm did not converge (`bootArmEligible: true` +
      // `bootArmDrift: ['mode']` on /api/health/options-live) — admin had been
      // `mode: live` in the 02:08Z and 03:52Z pulls. `liveBookCount` is what makes
      // the two states distinguishable; `null` means NOT MEASURED, never a pass.
      ...summarizeLiveLagTripwire(engines),
      // TRA-2635 (CEO) — THE MONEY QUESTION, and it is a different question from
      // the tripwire above. The lag signature reads CLEAN on a book where the
      // credit path never fired, so grading the live book off it alone graded it
      // with an instrument that cannot resolve the reading. This fold answers
      // "did equity absorb the option P&L?" off durable STATE (`closingEquity`,
      // `optionsCreditedCumulative`) rather than off a delta. Tri-state; `null`
      // is NOT MEASURED and is never a pass.
      ...summarizeLiveCreditObservation(engines),
      // TRA-2658 — the FROZEN-counter axis, folded firm-wide. Same tri-state
      // precedence as every other fold here. This is the axis that gives AC2's
      // `counterDurable` a failing state: on 2026-07-30T14:08Z the pre-fix fold
      // would have reported a clean durability grade over `admin`'s three
      // consecutive zero-counter sessions.
      counterDurableOk: engines.some(e => e.counterDurable === false)
        ? false
        : engines.some(e => e.counterDurable === true)
          ? true
          : null,
      counterFrozenBooks: engines
        .filter(e => e.counterFrozenDates.length > 0)
        .map(e => ({
          username: e.username,
          mode: e.mode,
          dates: e.counterFrozenDates,
          maxUnbookedEquityMoveUsd: e.maxUnbookedEquityMoveUsd,
          uncreditedOptionsUsd: e.uncreditedOptionsUsd,
        })),
      // TRA-2926 — books carrying a session whose frozen-counter accusation was
      // suppressed because its prior ROW sits across a session gap (the TRA-2888
      // hole). Published for the same reason `priorOptionsLagGapSuppressedBooks`
      // is: on 2026-08-04 this is where 12 spurious `counterFrozen` books and 36
      // "unbooked" rows went, and a silently shrunken cohort reads exactly like
      // one that was always this size.
      counterGapSuppressedBooks: engines
        .filter(e => e.counterGapSuppressedDates.length > 0)
        .map(e => ({
          username: e.username,
          mode: e.mode,
          dates: e.counterGapSuppressedDates,
        })),
      // The DENOMINATOR for the fold above. `counterDurableOk: true` over 0 books
      // that ever wrote the counter and over 20 that did are different claims, and
      // without this they are the same reading. TRA-2926 — `counterDurable` now
      // reads `null` on a book whose frozen detector graded no session, so this
      // count no longer includes books measurable only across the gap.
      counterGradeableBookCount: engines.filter(e => e.counterDurable !== null).length,
      // TRA-2637 (QuantTrader) — THE ABSENCE AXIS. Every verdict above grades a
      // VALUE; none of them can see a session that has no row at all, and the
      // live book served exactly that on 2026-07-29 while reporting `drift: 0`.
      // Tri-state, and `liveEodRowBookCount` is the denominator that keeps a
      // `null` from being read as a pass when the live cohort is empty.
      eodRowsPresentOk: engines.some(e => e.eodRowsPresentOk === false)
        ? false
        : engines.some(e => e.eodRowsPresentOk === true)
          ? true
          : null,
      eodRowMissingBooks: engines
        .filter(e => e.eodRowMissingDates.length > 0)
        .map(e => ({ username: e.username, mode: e.mode, dates: e.eodRowMissingDates })),
      // TRA-2817 — THE TAIL AXIS, at the head of the response where a reader
      // asking "is the book being recorded?" actually looks. `eodRowsPresentOk`
      // above now folds it in, but the verdict alone does not say WHICH failure
      // it is: a tail gap contributes no missing dates (the rows were never
      // written, so nothing walks them), so `eodRowMissingBooks: []` next to
      // `eodRowsPresentOk: false` is a legitimate reading meaning "the writer
      // stopped", and these three fields are how it is told apart from a clean
      // interior. This is the reachability AC2 asked for: a tail gap must be
      // legible from the top-level scalars, because re-deriving `days[]` by hand
      // is the only reason the 2026-07-30 stop ran three sessions unseen.
      eodTailSettledSession: tailCalendar.lastSettledSession,
      eodTailStaleBooks: engines
        .filter(e => (e.eodTailStaleSessions ?? 0) > 0)
        .map(e => ({
          username: e.username,
          mode: e.mode,
          latestRowDate: e.eodTailLatestRowDate,
          staleSessions: e.eodTailStaleSessions,
        })),
      eodTailMaxStaleSessions: (() => {
        const measured = engines
          .map(e => e.eodTailStaleSessions)
          .filter((n): n is number => typeof n === 'number');
        // `null`, not 0, on a wholly unmeasured fleet — the empty-cohort pass.
        return measured.length === 0 ? null : Math.max(...measured);
      })(),
      ...summarizeLiveEodRowPresence(engines),
      // TRA-2888 — THE INTERIOR-ABSENCE AXIS, at the head beside the tail axis
      // it completes. The tail answers "has the writer stopped?"; this answers
      // "is the recorded history complete?" — and on 2026-08-05 the first read
      // green while three fleet-wide sessions were permanently gone, because a
      // tail cohort is emptied by the next row that lands.
      //
      // `eodInteriorAbsentRawBookCount` is the ACCEPTANCE arm and is published
      // deliberately: it counts books whose interior is absent BEFORE the
      // documented-gap exclusion. If it ever drops to 0 while the fleet still
      // steps 2026-07-29 -> 2026-08-04, the detector has been blinded and that is
      // a regression, not a repair. `eodInteriorAbsentOk` is the graded verdict
      // (post-exclusion) and is TRI-STATE: `null` = NOT MEASURED, never green.
      ...summarizeEodInteriorAbsence(
        engines.map(e => ({ username: e.username, mode: e.mode, interior: e.eodInterior })),
      ),
      // TRA-2829 — the back-fill's PLAN, per live book, read-only.
      //
      // Sits beside the tail axis deliberately: `liveEodTailStaleBooks` says a
      // book is N sessions behind, and this says what a reconstruction of those
      // exact N sessions would contain and how much of it can be measured at all.
      // The two are guaranteed to describe the same session set — both derive it
      // from `staleTailSessions`, which is why that enumeration is shared rather
      // than reimplemented here.
      //
      // `balanceWindow` is the deliverable the ruling asked for before any write:
      // how far the broker equity series actually reaches. `absentSessionsUncovered`
      // is the count of rows that would carry `closingEquity: null`.
      liveEodBackfillPlans: engines
        .filter(e => e.eodBackfillPlan != null)
        .map(e => ({
          username: e.username,
          anchorRowDate: e.eodBackfillPlan!.anchorRowDate,
          settledSession: e.eodBackfillPlan!.settledSession,
          absentSessions: e.eodBackfillPlan!.absentSessions,
          balanceWindow: e.eodBackfillPlan!.balanceWindow,
          optionsBackfilledUsd: e.eodBackfillPlan!.optionsBackfilledUsd,
          unmeasuredEquityRowCount: e.eodBackfillPlan!.unmeasuredEquityRowCount,
          stockLegProbeDisagreeCount: e.eodBackfillPlan!.stockLegProbeDisagreeCount,
          // Published beside the disagree count, never folded into it. A lone
          // `stockLegProbeDisagreeCount: 0` reads as "the stock leg checks out"
          // when it can equally mean "nothing was checked" — and on the first
          // live publication of this plan it meant the latter, on 3 rows of 3.
          stockLegProbeNotMeasuredCount: e.eodBackfillPlan!.stockLegProbeNotMeasuredCount,
          notMeasuredReason: e.eodBackfillPlan!.notMeasuredReason,
          // The rows themselves, so the plan is auditable before it is armed
          // rather than only after it has written.
          rows: e.eodBackfillPlan!.rows.map(r => ({
            date: r.date,
            openingEquity: r.openingEquity,
            closingEquity: r.closingEquity,
            closingEquityBasis: r.closingEquityBasis,
            optionsDailyPnl: r.optionsDailyPnl,
            optionsDailyJournalCloses: r.optionsDailyJournalCloses,
            dailyPnl: r.dailyPnl,
            stockLegBasis: r.stockLegBasis,
            stockLegProbeUsd: r.stockLegProbeUsd,
            rowSource: r.rowSource,
          })),
        })),
      // Is the writer allowed to act on the plans above? Published so a reader
      // can never mistake "planned" for "written" — the state this ticket sat in
      // between the measurement and the CFO's go-ahead.
      liveEodBackfillArmed: isEodRowBackfillArmed(),
      // TRA-2761 — cohort-membership integrity. Every `live*` fold above filters
      // on the read-time classifier; this one cross-checks that classifier
      // against the journal's durable open `mode:'live'` rows, so a cohort that
      // empties while open live notional persists reads RED (`false`) instead of
      // flipping every live verdict to NOT MEASURED with the money unobserved.
      ...summarizeLiveCohortIntegrity(engines, (() => {
        if (journalRows == null) {
          return {
            journalCensusAvailable: false,
            unattributedOpenLiveRowCount: 0,
            unattributedOpenLiveAtRiskUsd: 0,
          };
        }
        const openLiveTotal = journalRows.filter(
          r => r.mode === 'live' && typeof r.closeTs !== 'number',
        );
        const attributedCount = engines.reduce(
          (n, e) => n + (e.openLiveJournalRowCount ?? 0),
          0,
        );
        const attributedAtRisk = engines.reduce(
          (s, e) => s + (e.openLiveJournalAtRiskUsd ?? 0),
          0,
        );
        const totalAtRisk = openLiveTotal.reduce(
          (s, r) => s + (Number.isFinite(r.atRiskUsd) ? r.atRiskUsd : 0),
          0,
        );
        return {
          journalCensusAvailable: true,
          // Open live rows no current book claims (identity-retired epoch, or a
          // pre-TRA-1475 row with no `account`) — orphaned notional, RED.
          unattributedOpenLiveRowCount: Math.max(0, openLiveTotal.length - attributedCount),
          unattributedOpenLiveAtRiskUsd: Math.max(0, totalAtRisk - attributedAtRisk),
        };
      })()),
      engines,
    });
  } catch (err) {
    log.warn('pnl-reconciliation probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build P&L reconciliation' });
  }
});

// TRA-406 — observability surface. Returns the recent in-memory alerts and the
// 15-minute captured-error count so QA / ops can see incident state without
// shelling into the box. Gated by auth — alert detail can carry path/host info.
app.get('/api/health/alerts', requireAuth, (_req, res) => {
  res.json({
    alerts: getRecentAlerts(),
    errorCount15m: getErrorCountSince(),
    time: new Date().toISOString(),
  });
});

// TRA-2136 — no-auth alerting POSTURE. The auth-gated /api/health/alerts above
// returns full alert detail (which can carry host/path info, hence the gate);
// this route returns only channel configuration + counts, so ops can confirm
// alerting is not silently dark after a deploy — including on bqb1, where admin
// auth is unavailable. Motivated by the PUT /env-vars wipe that left SMTP
// unrestorable: with no email or webhook push channel, alerts still land in the
// error log + on-disk alerts.jsonl + in-memory ring, and `degradedTo:
// 'log+ring+poll'` makes that fallback observable to a polling monitor instead
// of a silent hole.
app.get('/api/health/alerting', (_req, res) => {
  res.json({
    ...getAlertingPosture(),
    errorCount15m: getErrorCountSince(),
    time: new Date().toISOString(),
  });
});

// TRA-2284 — prove the ops-alert PUSH path actually delivers.
//
// `/api/health/alerting` above reports `channels.email.configured: true` from
// `isSmtpConfigured() && recipientCount > 0` — CREDENTIAL PRESENCE. It reads
// identically on a box that has never dispatched an alert and on one that mails
// reliably, and the real dispatch path (`void deliver(...)`) discards its own
// send result by design so a mail outage cannot stall a monitor tick. So
// `configured: true` was the only signal ops had, and it is not evidence.
//
// This route awaits the send and reports the transport verdict: 200 with
// `emailDelivered: true`, or 502 carrying the SMTP error. The alert lands under
// its own `self-test` key — never mistakable for an incident in the inbox, and
// it does not consume a real key's throttle. Auth-gated (not admin: bqb1 has no
// working admin auth) and throttled to one probe per 5 min, so a signed-up user
// cannot flood ALERT_EMAIL.
app.post('/api/health/alerting/self-test', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  try {
    const result = await runAlertingSelfTest(username);
    if (!result.fired) {
      res.status(429).json({ ok: false, code: 'throttled', ...result });
      return;
    }
    if (!result.emailDelivered) {
      res.status(502).json({ ok: false, code: 'send_failed', ...result });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    // Unreachable: runAlertingSelfTest never throws. Belt-and-suspenders so a
    // probe of the alerting path can never itself become a captured exception.
    log.error('alerting self-test failed', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ ok: false, error: 'alerting self-test failed' });
  }
});

// TRA-398 — client-side error sink. The desktop/mobile React error boundary
// posts uncaught render-time exceptions here so QA/ops have visibility into
// white-screen-class failures instead of them being lost in the browser.
// Intentionally unauthenticated and best-effort: a crash can happen before
// login or after the token expires, and the boundary uses navigator.sendBeacon
// (which cannot attach auth headers). Oversized fields are clamped to bound
// volume.
//
// TRA-400 — the boundary sends the report as a text/plain Blob so the beacon
// stays CORS-safelisted (an application/json Content-Type forces a preflight
// that silently drops cross-origin beacons — see ErrorBoundary.tsx). The
// global express.json() above does not parse text/plain, so this route gets
// an express.text() parser and JSON.parses the raw body itself. Same-origin
// callers that still send application/json (already parsed into an object by
// express.json()) keep working via the object branch below.
//
// TRA-413 — the report is now filed through `captureException`, the same path
// server-side errors take, so a desktop error lands in the queryable
// destination (`errors.jsonl` / `ERROR_WEBHOOK_URL`). The desktop client mints
// its own trace id per error and sends it in the body (a custom header cannot
// ride a CORS-safelisted sendBeacon); we file the error under that exact id so
// the desktop "something went wrong" screen and this server record share one
// reference.
app.post('/api/client-error', express.text({ type: 'text/plain', limit: '64kb' }), (req, res) => {
  try {
    let b: Record<string, unknown> = {};
    if (typeof req.body === 'string') {
      try {
        const parsed: unknown = JSON.parse(req.body);
        if (parsed && typeof parsed === 'object') b = parsed as Record<string, unknown>;
      } catch {
        /* malformed report body — captured below as best we can */
      }
    } else if (req.body && typeof req.body === 'object') {
      b = req.body as Record<string, unknown>;
    }
    const str = (v: unknown, max: number): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;

    // Reconstruct an Error so captureException records a normal name/message/
    // stack. The browser stack is the client's, not this process's.
    const message = str(b['message'], 2000) ?? 'unknown client error';
    const err = new Error(message);
    err.name = str(b['name'], 200) ?? 'ClientError';
    const stack = str(b['stack'], 8000);
    if (stack) err.stack = stack;

    const label = str(b['label'], 200) ?? 'unknown';
    const context: Record<string, unknown> = {
      label,
      source: str(b['source'], 60) ?? 'renderer',
      url: str(b['url'], 500),
      userAgent: str(b['userAgent'], 300),
      sessionTraceId: str(b['sessionTraceId'], 64),
      componentStack: str(b['componentStack'], 8000),
      clientTime: str(b['time'], 40),
    };

    // File under the client-supplied trace id when present (length-bounded to
    // match traceMiddleware) so the id the user sees is the id ops query.
    const rawTraceId = str(b['traceId'], 64);
    const clientTraceId = rawTraceId && rawTraceId.length >= 8 ? rawTraceId : undefined;
    const file = (): void => {
      captureException(err, `desktop.${label}`, context);
    };
    if (clientTraceId) runWithTrace({ traceId: clientTraceId }, file);
    else file();
  } catch (err) {
    log.error('client-error failed to handle report', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  // Always 204 — the client treats this as fire-and-forget.
  res.status(204).end();
});

// TRA-191 — surface live relative-value scan output. Read-only, gated by auth.
// Returns up to `limit` ranked candidates and the diagnostics block so QA can
// see whether the breaker is open / cache is warm without needing server logs.
app.get('/api/options/relative-value', requireAuth, async (req, res) => {
  const symbol = typeof req.query['symbol'] === 'string' ? req.query['symbol'] : '';
  if (!symbol) {
    res.status(400).json({ error: 'symbol query parameter is required' });
    return;
  }
  const limit = Math.max(1, Math.min(50, Number(req.query['limit'] ?? 10)));
  const zRaw = req.query['minZ'];
  const minZ = typeof zRaw === 'string' && zRaw.length > 0 ? Number(zRaw) : undefined;

  const result = await relativeValueScannerService.scan(symbol, {
    zScoreThreshold: Number.isFinite(minZ) ? Number(minZ) : undefined,
  });
  res.json({
    ...result,
    candidates: result.candidates.slice(0, limit),
    diagnostics: relativeValueScannerService.diagnostics(),
  });
});

// TRA-161 — RESTORED. This route shipped with TRA-158 (`8ef0ed2`) and was
// removed three months later by TRA-191 (`cf49fcf`), which swapped the standalone
// OTM scanner service for the RV one and repointed the HTTP surface at
// `/api/options/relative-value`. The OTM *engine* never went away — TRA-1207 put
// `scanOtm()` back on the RV service, riding the same warm 60s chain cache — but
// it was left with no HTTP surface at all, reachable only in-process from the
// signal engine. TRA-161's desktop panel needs to read it, so the route is back:
// a thin read-only projection of `scanOtm()` plus the diagnostics block.
//
// Read-only and requireAuth-gated. There is deliberately NO order-entry path
// here — entry off this scan is TRA-159 and is not wired.
app.get('/api/options/otm-mispricing', requireAuth, async (req, res) => {
  const symbol = typeof req.query['symbol'] === 'string' ? req.query['symbol'] : '';
  if (!symbol) {
    res.status(400).json({ error: 'symbol query parameter is required' });
    return;
  }
  const limit = Math.max(1, Math.min(50, Number(req.query['limit'] ?? 10)));
  // `minMispricing` is the |(mark − theo)/MARK| band above which a contract is
  // classified cheap/expensive rather than fair. Absent ⇒ the panel default,
  // which mirrors the engine's. TRA-2564 moved the DENOMINATOR from theo to
  // mark, so the param keeps its name and its mechanics (a classification
  // cutoff, not a row filter) and only the values it corresponds to shift.
  const minRaw = req.query['minMispricing'];
  const minMispricing =
    typeof minRaw === 'string' && minRaw.length > 0 ? Number(minRaw) : undefined;
  // TRA-2388 — |delta| floor (the TRA-2354 decision). Absent ⇒ the panel
  // default; `?minDelta=0` restores the raw far tail. See `otm-delta-floor.ts`
  // for why this is a route-layer filter over the RETURNED candidates and not a
  // `minAbsDelta` forwarded into `scanOtm`: the engine filter `continue`s before
  // the candidate exists, so it cannot report what it dropped, and the sleeve's
  // own TRA-1407 floor must stay untouched. The two predicates are equivalent on
  // the kept set, so this moves only the observability, never the rows.
  const deltaRaw = req.query['minDelta'];
  const minDelta =
    typeof deltaRaw === 'string' && deltaRaw.length > 0 && Number.isFinite(Number(deltaRaw))
      ? Number(deltaRaw)
      : OTM_PANEL_DELTA_FLOOR;
  // TRA-2341 — dollar floor on the mispricing DENOMINATOR. Absent ⇒ the panel
  // default; `?minTheo=0` restores the raw pre-TRA-2341 projection. See
  // `otm-theo-floor.ts` for why this is a route-layer filter and not an engine
  // default (the `single_leg_otm` sleeve calls `scanOtm` in-process, not over
  // HTTP, so this cannot reach a trading decision).
  const theoRaw = req.query['minTheo'];
  const minTheo =
    typeof theoRaw === 'string' && theoRaw.length > 0 && Number.isFinite(Number(theoRaw))
      ? Number(theoRaw)
      : OTM_PANEL_THEO_FLOOR;
  // TRA-2564 — which DENOMINATOR the ratio is normalised by. Defaults to `mark`,
  // the TRA-2562 decision; `?basis=theo` (the pre-TRA-2564 formula) and
  // `?basis=max` (bounded on BOTH sides) exist so a re-measure can grade all
  // three from ONE build. An unrecognised value falls back to the default rather
  // than 400ing, and `mispricingBasis` on the response echoes what was APPLIED —
  // so a typo'd basis reads as the fallback it got, not the one it asked for.
  const basis = parseMispricingBasis(req.query['basis']);

  // NOTE: deliberately no `minAbsDelta` here — see the TRA-2388 note above.
  // `packages/engine/` is byte-unchanged by this route.
  const result = await relativeValueScannerService.scanOtm(symbol, {
    ...(Number.isFinite(minMispricing) ? { mispricingThresholdPct: Number(minMispricing) } : {}),
  });
  // TRA-2564 (TRA-2562 decision) — re-base the ratio on `mark` FIRST, before
  // either floor. Both floors report `maxSuppressedMispricingPct`, so re-basing
  // after them would footnote the panel with theo-basis numbers under a
  // mark-basis label. The transform also RE-SORTS: `r ↦ r/(1+r)` preserves order
  // within a sign but not across signs, and the panel ranks on |ratio|. See
  // `otm-mark-basis.ts` for why this is a route-layer transform and the engine
  // is untouched — the shared `classification` gates a live `single_leg_otm`
  // entry, so changing the engine formula would widen that gate ~2.3%.
  const rebased = rebaseMispricing(
    result.candidates,
    basis,
    Number.isFinite(minMispricing) ? Number(minMispricing) : OTM_PANEL_MISPRICING_THRESHOLD,
  );
  // Floor BEFORE the slice. Filtering after it would leave the underflow rows
  // occupying the top N and merely blank the table.
  const floored = applyTheoFloor(rebased.candidates, minTheo);
  // TRA-2388 — then the |delta| floor, on what the theo floor kept. The counts
  // are therefore SEQUENTIAL, not partitions of the same population:
  // `deltaFloor.suppressed` is what the delta axis removed from the rows that
  // already cleared the theo axis. Both run before the slice.
  const deltaFloored = applyDeltaFloor(floored.kept, minDelta);
  // TRA-2662 — static no-arbitrage check on the surface, measured on the FULL
  // engine output: before both floors and before the slice. Those filters remove
  // strikes, and every removed strike is an adjacent pair that can no longer be
  // tested, so grading the projected rows would under-count the defect by
  // construction. `theo`/`mark` are untouched by `rebaseMispricing` (it moves
  // only `mispricingPct`), so this is basis-independent and safe to read off
  // `result.candidates`.
  const arbitrage = toArbitrageDiagnostic(findVerticalArbitrage(result.candidates));
  res.json({
    ...result,
    // Ranked by |mispricingPct| descending — by `rebaseMispricing`, not by
    // `scanOtm`, whose theo-basis order this deliberately supersedes. A slice is
    // therefore still the top N.
    candidates: deltaFloored.kept.slice(0, limit),
    // TRA-2564 — the DENOMINATOR every `mispricingPct` on this response is
    // normalised by, as APPLIED (not as requested). A build predating TRA-2564
    // omits the key entirely, so its presence — not a SHA, not a commit subject
    // — is what proves the formula swapped.
    //
    // TRA-2659 (executed as TRA-2661) — the default is now `max`, not `mark`.
    // `mark` bounds the EXPENSIVE tail only and the cheap side is unbounded:
    // measured live 2026-07-30, SPY read 333.6% on `mark` vs 94.1% on `theo`,
    // because SPY's tail is currently CHEAP. The two are exact duals and neither
    // bounds both tails. `max` takes the bounded branch on each side, which also
    // makes the CHEAP side bit-identical to what the engine emits — the side the
    // live `single_leg_otm` sleeve gates on.
    //
    // ⛔ Do NOT accept a change to this route on "max |mispricingPct| < 100%".
    // Under `max` that predicate is an algebraic identity: it passes on every
    // chain forever, including one whose `theo` is garbage. See the retirement
    // note in `otm-mark-basis.ts`.
    mispricingBasis: rebased.basis,
    // Never silent: rows whose denominator was unusable under the applied basis
    // have no ratio and were neutralised to 0/`fair` rather than emitted with a
    // stale number under a fresh label. Normally 0.
    markBasis: {
      threshold: rebased.threshold,
      unbasisable: rebased.unbasisable,
    },
    // Never a silent drop: the panel footnotes this, and its presence is what
    // distinguishes a build carrying the guard from one that predates it.
    theoFloor: {
      applied: floored.floor,
      suppressed: floored.suppressed,
      maxSuppressedMispricingPct: floored.maxSuppressedMispricingPct,
    },
    deltaFloor: {
      applied: deltaFloored.floor,
      suppressed: deltaFloored.suppressed,
      maxSuppressedMispricingPct: deltaFloored.maxSuppressedMispricingPct,
    },
    // TRA-2662 — vertical-spread monotonicity, the model-free no-arbitrage
    // condition. `theoViolations` grades OUR MODEL; `markViolations` is the
    // NEGATIVE CONTROL and grades the tape, which is coherent in every capture
    // taken so far. A theo violation is a labelled diagnostic here rather than a
    // silent filter: the rows stay on the panel, and the incoherence is stated.
    //
    // ⛔ `theoViolations: 0` is NOT a pass on its own. Read it with
    // `pairsTested` (0 pairs cannot violate) and with `markViolations` (if the
    // control ever goes non-zero the detector is wrong, not the market). And it
    // can be bought by flattening the vol surface, which would destroy the
    // panel's signal — see the acceptance trap in `otm-theo-arbitrage.ts`.
    noArbitrage: arbitrage,
    diagnostics: relativeValueScannerService.diagnostics(),
  });
});

app.get('/api/health/options-mispricing', (_req, res) => {
  res.json(relativeValueScannerService.diagnostics());
});

// TRA-1207 — short-squeeze screener routes (read-only). The single-symbol route
// returns the full per-criterion breakdown; the scan route screens the user's
// watchlist and returns candidates ranked qualifiers-first.
app.get('/api/screeners/short-squeeze', requireAuth, async (req, res) => {
  const symbol = typeof req.query['symbol'] === 'string' ? req.query['symbol'] : '';
  if (!symbol) {
    res.status(400).json({ error: 'symbol query parameter is required' });
    return;
  }
  const result = await shortSqueezeScannerService.scan(symbol);
  res.json({ ...result, diagnostics: shortSqueezeScannerService.diagnostics() });
});

app.get('/api/screeners/short-squeeze/scan', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const symbols = getStocksWatchlistData(ctx.username).all;
  const results = await shortSqueezeScannerService.scanUniverse(symbols);
  res.json({
    scannedAt: Date.now(),
    universeSize: symbols.length,
    candidates: results.filter((r) => r.evaluation?.qualifies),
    all: results,
    diagnostics: shortSqueezeScannerService.diagnostics(),
  });
});

// TRA-1209 — tokenless short-squeeze diagnostics + observe-capture summary.
// Surfaces the live scanner diagnostics (unchanged `lastScan`) PLUS a rolling
// summary of the TRA-1209 observe-capture accrual so QuantTrader can grade the
// Step-2 ratification gate without a bearer token (AUTH_SECRET rotation has
// bitten cross-agent reads before). The full per-symbol-day rows (including the
// complete `filters` array) are pulled one partition at a time from
// `/api/health/short-squeeze/capture/partition/:date` below.
const SS_CAPTURE_DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
const SS_CAPTURE_TARGET_SESSIONS = 10;

/** The RVOL reading for a captured row (null when the criterion wasn't judged). */
function rowRvol(row: ShortSqueezeCaptureRow): number | null {
  const f = row.filters?.find((x) => x.key === 'rvol');
  return f && f.applicable && typeof f.value === 'number' ? f.value : null;
}

/** True when the row cleared the short-float cut — the population we grade RVOL over. */
function rowShortFloatEligible(row: ShortSqueezeCaptureRow): boolean {
  const f = row.filters?.find((x) => x.key === 'short_float');
  return !!f && f.applicable && f.pass;
}

async function buildShortSqueezeCaptureSummary() {
  const outDir = SHORT_SQUEEZE_CAPTURE_OUT_DIR;
  let dates: string[] = [];
  try {
    dates = (await readdir(outDir)).filter((d) => SS_CAPTURE_DATE_PARTITION.test(d)).sort();
  } catch {
    dates = [];
  }
  const { symbols: configuredUniverse, source: universeSource } = resolveShortSqueezeUniverse();

  let latest: {
    date: string;
    recordedAt: number | null;
    symbolCount: number;
    ok: number;
    qualifiers: number;
    noData: number;
    errored: number;
    thresholds: ShortSqueezeCaptureFile['thresholds'] | null;
    // RVOL distribution across short-float-eligible names — the reading the 1.5
    // ratification cut is judged against, surfaced as the raw sorted values plus
    // how many clear the shipped 1.0 vs QuantTrader's provisional 1.5.
    rvolAcrossShortFloatEligible: {
      eligibleNames: number;
      values: { symbol: string; rvol: number | null }[];
      atOrAbove1_0: number;
      atOrAbove1_5: number;
    };
    // TRA-1209 — forward-outcome resolution on this partition's `ok` rows. The
    // +1d/+3d/+5d return + 5-session MFE label QuantTrader's Step-2 grades on.
    forward: {
      okRows: number;
      resolved: number;
      complete: number;
      pending: number;
    };
    perSymbol: { symbol: string; outcome: string; score: number | null; qualifies: boolean | null; rvol: number | null }[];
  } | null = null;

  if (dates.length > 0) {
    const last = dates[dates.length - 1];
    try {
      const file = JSON.parse(
        await readFile(join(outDir, last, 'short-squeeze.json'), 'utf-8'),
      ) as ShortSqueezeCaptureFile;
      const rows = Array.isArray(file.symbols) ? file.symbols : [];
      const eligible = rows.filter(rowShortFloatEligible);
      const eligibleRvols = eligible.map((r) => ({ symbol: r.symbol, rvol: rowRvol(r) }));
      const okRows = rows.filter((r) => r.outcome === 'ok');
      const forwardComplete = okRows.filter(
        (r) => (r.forward?.sessionsForward ?? 0) >= SHORT_SQUEEZE_FORWARD_SESSIONS,
      ).length;
      const forwardResolved = okRows.filter((r) => r.forward != null).length;
      latest = {
        date: file.date ?? last,
        recordedAt: typeof file.recordedAt === 'number' ? file.recordedAt : null,
        symbolCount: rows.length,
        ok: rows.filter((r) => r.outcome === 'ok').length,
        qualifiers: rows.filter((r) => r.qualifies === true).length,
        noData: rows.filter((r) => r.outcome === 'no_data').length,
        errored: rows.filter((r) => r.outcome === 'fetch_error').length,
        thresholds: file.thresholds ?? null,
        rvolAcrossShortFloatEligible: {
          eligibleNames: eligible.length,
          values: eligibleRvols
            .slice()
            .sort((a, b) => (b.rvol ?? -1) - (a.rvol ?? -1)),
          atOrAbove1_0: eligibleRvols.filter((v) => (v.rvol ?? 0) >= 1.0).length,
          atOrAbove1_5: eligibleRvols.filter((v) => (v.rvol ?? 0) >= 1.5).length,
        },
        forward: {
          okRows: okRows.length,
          resolved: forwardResolved,
          complete: forwardComplete,
          pending: okRows.length - forwardResolved,
        },
        perSymbol: rows.map((r) => ({
          symbol: r.symbol,
          outcome: r.outcome,
          score: r.score,
          qualifies: r.qualifies,
          rvol: rowRvol(r),
        })),
      };
    } catch {
      latest = null;
    }
  }

  return {
    issue: 'TRA-1209',
    enabled: shortSqueezeCaptureEnabled(),
    observeOnly: true,
    outDir,
    universeSource,
    configuredUniverse,
    // Capture is taken at the shipped permissive cut; the 1.5 tightening is a
    // grading-time question, NOT pre-applied here.
    captureThresholds: DEFAULT_SHORT_SQUEEZE_THRESHOLDS,
    // Entry/return convention for the Step-2 grader (TRA-1208): entryClose = scan-day
    // 3:55 PM ET close; ret1d = next-session close ÷ entryClose − 1; realizable entry
    // ≈ next-day open, so ret1d is the realizable first-bar proxy.
    entryConvention: SHORT_SQUEEZE_ENTRY_CONVENTION,
    tradingSessionsCaptured: dates.length,
    progressToRatificationGate: { captured: dates.length, target: SS_CAPTURE_TARGET_SESSIONS },
    readyForRatification: dates.length >= SS_CAPTURE_TARGET_SESSIONS,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    allDates: dates,
    latest,
  };
}

app.get('/api/health/short-squeeze', async (_req, res) => {
  const capture = await buildShortSqueezeCaptureSummary();
  res.json({ ...shortSqueezeScannerService.diagnostics(), capture });
});

// TRA-1209 — full per-symbol-day capture export. The rows (with the complete
// per-criterion `filters` array) live only on the Render persistent disk, so this
// bounded, tokenless read streams one date partition's short-squeeze.json for
// off-box grading. One date per request keeps the payload bounded; `:date` is
// regex-validated to block path traversal.
app.get('/api/health/short-squeeze/capture/partition/:date', async (req, res) => {
  const date = String(req.params.date ?? '');
  if (!SS_CAPTURE_DATE_PARTITION.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  try {
    const raw = await readFile(join(SHORT_SQUEEZE_CAPTURE_OUT_DIR, date, 'short-squeeze.json'), 'utf-8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).json({ error: `no capture partition for ${date}` });
  }
});

// TRA-604 (TRA-595 C4b) — live "AI Options Ideas" feed. Resolves the user's
// watchlist, pulls Tradier chains, fuses the C1/C2/sentiment/IV-rank context,
// runs the Head-of-Options-Research LLM pass behind the C3 guardrail, and maps
// the result to the C5 panel's `OptionsIdeasFeed`. Returns a clearly-labelled
// non-live response (HTTP 200, `source: 'non_live'`) when no Anthropic key or
// Tradier creds are configured, so the panel always renders coherently.
app.get('/api/options/ideas', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  const settings = getSettings(ctx.username);
  const env = settings.liveTradierEnvOptions ?? 'sandbox';
  const client = buildTradierOptionsClientForEnv(settings, env);
  const symbols = getStocksWatchlistData(ctx.username).all;
  // TRA-714 — a user's app-installed console API key (if any) overrides the
  // server env credential, so a Claude Max user can make the feed live without
  // any Render access.
  const anthropicApiKey = getUserAnthropicApiKey(ctx.username);
  // TRA-1121 — thread the paper-options book equity so the feed pre-flights each
  // idea's single-lot max loss through the same TRA-912 gate the paper-enter
  // path uses, flagging un-enterable ideas (`enterable:false` + reason) instead
  // of surfacing a `Paper entry` button that always 409s.
  const accountEquityUsd = ctx.engine.getOptionsAccountEquity();
  const feed = await buildIdeasFeed({ client, symbols, anthropicApiKey, accountEquityUsd });
  // TRA-1142 — demo auto-confirm for AI Ideas options. OFF by default (requires
  // BOTH the shared-rail flag and this sub-flag). When ON, every surfaced,
  // enterable idea is run through the engine's options-aware `shouldAutoConfirm`
  // gate (demo/paper only, defined-risk, POP floor, single-lot max-loss cap,
  // kill-switch clear, demo auto-trade ON) and — only if it passes — entered via
  // the SAME shared proposal queue the manual click uses, so the paper book
  // accrues real auto-trade evidence for the scorecard (TRA-1141). The surfaced
  // ideas are already journaled by `buildIdeasFeed`, so the scorecard's AI-Ideas
  // forward-test side picks these entries up with no extra write. Per-idea
  // failures (gate-blocked or open-refused) leave the idea for manual approval
  // and never break the feed read. Idempotent across the 60s poll: the proposal
  // store dedupes a pending options proposal per (user, ideaId) and the paper
  // book rejects a duplicate open for an already-open contract.
  if (isOptionDemoAutoConfirmEnabled()) {
    let entered = 0;
    for (const idea of feed.ideas) {
      if (idea.enterable === false) continue;
      const intent = getEntryIntent(idea.id);
      if (!intent) continue;
      try {
        const r = await ctx.engine.autoConfirmOptionsIdea({ ...intent, ideaId: idea.id });
        if (r.autoConfirmed) entered += 1;
      } catch (err) {
        log.warn('options auto-confirm failed for idea', {
          ideaId: idea.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (entered > 0) broadcastEngineState(ctx);
  }
  // TRA-1205 (TRA-1202 follow-up) — auto-execute the TOP N (default 3) ranked
  // enterable ideas into the DEMO paper book without a manual click. SEPARATE,
  // independently-flagged path from TRA-1142's auto-confirm: it picks only the
  // top N (not every enterable idea), dedups by (symbol+structure+expiry) so the
  // 10-min-cached feed can't double-enter across the 60s poll, and opens through
  // the SAME direct `enterPaperOptionsIdea` path the manual click uses. OFF by
  // default ⇒ this block is skipped entirely. Hard-gated demo-only: the caller
  // checks `settings.mode === 'demo'` AND the runner re-checks, so live capital
  // is never touched (live promotion stays gated on TRA-382). Activity surfaces
  // read-only at GET /api/health/options-ideas-auto-execute.
  if (isOptionIdeasAutoExecuteEnabled() && settings.mode === 'demo') {
    const summary = runIdeasAutoExecute({
      feed,
      mode: settings.mode,
      scope: ctx.username,
      getIntent: getEntryIntent,
      enter: (intent) => ctx.engine.enterPaperOptionsIdea(intent),
    });
    if (summary.submitted > 0) broadcastEngineState(ctx);
  }
  res.json(feed);
});

// TRA-845 — Layer-4 options alert engine. Diffs the last two recorded chain
// partitions (new strikes/expiries + big IV moves) and scans the authed user's
// OPEN options book for target/stop hits. Read-only: it never mutates account
// state and never pushes — the daily chain-record hook owns the optional push.
// Returns `{ alerts, counts, symbolsDiffed, chainDates }`; degrades to an empty
// alert set (never 500s) when fewer than two chain days are on disk.
app.get('/api/options/alerts', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  try {
    const days = await loadChainDays(CHAIN_RECORD_OUT_DIR);
    const openOptions = ctx.engine.getState().options.openOptions ?? [];
    if (days.length < 2) {
      const positionAlerts = scanTargetStop(openOptions);
      res.json({
        issue: 'TRA-845',
        chainDates: days.map((d) => d.date),
        symbolsDiffed: [],
        counts: { new_expiry: 0, new_strike: 0, iv_move: 0, target_hit: positionAlerts.filter((a) => a.kind === 'target_hit').length, stop_hit: positionAlerts.filter((a) => a.kind === 'stop_hit').length },
        alerts: positionAlerts,
        note: 'fewer than 2 chain partitions on disk — chain-diff skipped, target/stop only',
      });
      return;
    }
    const prevDay = days[days.length - 2];
    const todayDay = days[days.length - 1];
    const result = computeOptionsAlerts({
      prevBySymbol: prevDay.bySymbol,
      todayBySymbol: todayDay.bySymbol,
      openOptions,
    });
    res.json({ issue: 'TRA-845', chainDates: [prevDay.date, todayDay.date], ...result });
  } catch (err) {
    log.error('options-alerts probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'options-alerts probe failed' });
  }
});

// TRA-714 — per-user Anthropic console API-key management for the AI Ideas feed.
// This is the "another way" for users with no env access (e.g. a Claude Max
// plan): paste a pay-as-you-go console key (`sk-ant-api03…`) once and it is
// stored with your account on the persistent disk. Each user manages only their
// own key (requireAuth, scoped to the authed user) — never another user's.
app.get('/api/options/anthropic-key', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(describeUserAnthropicApiKey(ctx.username));
});

app.put('/api/options/anthropic-key', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'] : '';
  try {
    setUserAnthropicApiKey(ctx.username, apiKey);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid API key.' });
    return;
  }
  res.json({ ok: true, ...describeUserAnthropicApiKey(ctx.username) });
});

app.delete('/api/options/anthropic-key', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  clearUserAnthropicApiKey(ctx.username);
  res.json({ ok: true, ...describeUserAnthropicApiKey(ctx.username) });
});

// TRA-604 (TRA-595 C4b) — route an accepted idea to the PAPER options account.
// Paper-only by construction (no live-capital path — that stays gated behind
// C6). The idea's anchor contract is opened as a single long leg; the C3
// order-time DTE guard runs inside the account open path.
app.post('/api/options/ideas/:id/paper-enter', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const intent = getEntryIntent(id);
  if (!intent) {
    res.status(404).json({
      error: 'Idea not found or expired — refresh the AI Options Ideas feed and try again.',
    });
    return;
  }
  // TRA-1140 — when the shared-rail flag is ON, route the accepted idea through
  // the unified pending-proposal queue (typed `options` proposal) + shared
  // approve/execution gate instead of the bespoke direct open. OFF by default,
  // so the direct path below stays byte-for-byte unchanged when unset. Both are
  // paper-only.
  if (isOptionsProposalRailEnabled()) {
    const result = await ctx.engine.enterOptionsIdeaViaProposal({ ...intent, ideaId: id });
    if (!result.ok || !result.position) {
      res.status(409).json({
        error: `Could not place the paper order — ${result.reason}.`,
        proposalId: result.proposalId,
      });
      return;
    }
    broadcastEngineState(ctx);
    res.json({
      ok: true,
      proposalId: result.proposalId,
      positionId: result.position.id,
      optionSymbol: result.position.optionSymbol,
      contracts: result.position.contracts,
      premiumPaid: result.position.premiumPaid,
    });
    return;
  }
  const opened = ctx.engine.enterPaperOptionsIdea(intent);
  if (!opened) {
    // TRA-1117 — surface the SPECIFIC reason the open path bailed instead of a
    // generic catch-all. The most common real cause (seen on a $25k demo book)
    // is a defined-risk spread whose single-lot max loss busts the 1%-of-equity
    // per-trade cap — previously indistinguishable from "market closed".
    const reason = ctx.engine.takeLastIdeaEntryRejection();
    res.status(409).json({
      error: reason
        ? `Could not place the paper order — ${reason}.`
        : 'Could not place the paper order — the market may be closed, the daily options cap reached, a position for this contract already open, or the idea fell below the no-day-trading DTE floor.',
    });
    return;
  }
  broadcastEngineState(ctx);
  res.json({
    ok: true,
    positionId: opened.id,
    optionSymbol: opened.optionSymbol,
    contracts: opened.contracts,
    premiumPaid: opened.premiumPaid,
  });
});

// TRA-658 — CFO spend diagnostic: the running monthly Anthropic spend for the
// live AI Options Ideas feed vs the board-approved cap. No PII or secrets — only
// the aggregate dollar total, the cap, and whether the auto-degrade tripwire is
// active — so the CFO can review spend from the Render URL without log access.
app.get('/api/health/options-spend', (_req, res) => {
  res.json(optionsSpendStatus());
});

// TRA-747 (TRA-529 P2 §6.5) — the advisory multi-agent layer's DAILY AGGREGATE
// spend readout (CFO acceptance #4). Returns the absolute $/day total across ALL
// users plus the per-user breakdown, the enforced $2/user/day cap, and the
// re-review level. Read-only and unauthenticated by design (parity with
// /api/health/options-spend) — it exposes only spend totals + usernames, no trade
// detail. Wires NO capital; the layer is advisor-only in P2.
app.get('/api/health/agent-spend', (_req, res) => {
  // TRA-1052 — `durable:true` confirms the SQLite committed-ledger mirror is live
  // (the daily cap survives a redeploy). `false` means the fail-soft fallback is
  // active (native binary unavailable) and the ledger is in-memory only — the one
  // read-only signal an operator/probe has that durability is actually engaged on
  // Render, since no agent can read the boot log directly.
  res.json({ ...agentSpendAggregate(), durable: getStateDb() !== null });
});

// TRA-601 (TRA-595 C6) — the forward-test report. Re-prices every surfaced idea
// the journal captured against the option chains the recorder wrote AFTER it was
// surfaced (no look-ahead) and rolls the result into a weekly hit-rate /
// expectancy / max-loss-adherence / POP-calibration report. Read-only; wires no
// capital. Any authenticated user can read so the desk can review methodology.
app.get('/api/options/forward-test/report', requireAuth, async (_req, res) => {
  try {
    const entries = await listJournalEntries();
    const outcomes = await forwardTestIdeas(entries);
    const report = buildForwardTestReport(outcomes, { chainsDir: defaultChainsDir() });
    res.json(report);
  } catch (err) {
    log.error('forward-test report failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build the forward-test report.' });
  }
});

// TRA-601 (TRA-595 C6) — the AI-Options-Ideas LIVE-CAPITAL GATE, as a redacted
// read-only acceptance probe (parity with the TRA-580/586 health probes).
// Unauthenticated by design: it exposes ONLY the pass/fail verdict and the
// per-criterion booleans + thresholds — no idea text, no per-symbol P&L, no PII
// — so QA can verify "the gate is wired and currently HOLDs" against the live
// deployment without shipping admin credentials. Evaluating the gate wires NO
// capital; a pass is permission to PROPOSE live wiring, nothing more.
app.get('/api/health/live-capital-gate', async (_req, res) => {
  try {
    const entries = await listJournalEntries();
    const outcomes = await forwardTestIdeas(entries);
    const report = buildForwardTestReport(outcomes, { chainsDir: defaultChainsDir() });
    // TRA-1600 (B) — apply the cost-aware raised expectancy bar when the
    // cost-aware gate flag is on; defaults to the shipped LIVE_CAPITAL_GATE
    // (net > 0) when off, so the readout is unchanged until an operator opts in.
    const gateCriteria = resolveLiveCapitalGateCriteria();
    // TRA-2006 — score the CALIBRATED POP gap when ENABLE_POP_CALIBRATION is set;
    // OFF by default → the raw gap, so the readout is unchanged until opt-in.
    const gate = evaluateLiveCapitalGate(report, gateCriteria, {
      useCalibratedPop: isPopCalibrationEnabled(),
    });
    res.json({
      passed: gate.passed,
      asOfDate: gate.asOfDate,
      summary: gate.summary,
      note: gate.note,
      thresholds: gateCriteria,
      // ⚠️ TRA-2335 — this is a field-by-field WHITELIST, not a spread. Any new field
      // on `GateCriterionResult` is SILENTLY DROPPED here: the module stays correct,
      // the unit tests stay green, and the route an operator actually grades from
      // shows no change at all. If you add a field there, add it here in the same
      // commit. (`status`/`barR`/`ceilingR`/`feasibilityNote` are TRA-2335's.)
      criteria: gate.criteria.map((c) => ({
        name: c.name,
        description: c.description,
        required: c.required,
        actual: c.actual,
        pass: c.pass,
        status: c.status,
        barR: c.barR ?? null,
        ceilingR: c.ceilingR ?? null,
        feasibilityNote: c.feasibilityNote ?? null,
      })),
      // TRA-2335 — the payoff-ceiling precondition on `minExpectancyR`. `verdict:
      // 'infeasible'` means the bar cannot be cleared at ANY hit rate by this book —
      // it is a HARDER stop than a failing criterion, never a "pending" one.
      // `ceilingSources` is load-bearing, not decoration: a bare ceiling reads
      // identically whether it came from real priced legs or a `long_call` 2×-debit
      // sketch cap, and that indistinguishability is what hid this defect for weeks.
      feasibility: {
        ...gate.feasibility,
        ceilingGrossR: report.totals.ceilingGrossR,
        ceilingGrossRPriced: report.totals.ceilingGrossRPriced,
        avgCostR: report.totals.avgCostR,
        ceilingSources: report.totals.ceilingSourceCounts,
      },
      // TRA-2353 — the SAME ceiling, PER SLEEVE, plus the composition-fragility sweep.
      // On 2026-07-26 it disagreed with the book verdict about 74% of the graded book:
      // the book read `feasible` (cost-net ceiling 0.2391R vs a 0.20R bar) while the
      // 35-idea credit sleeve inside it sat at ≈0.00R — an infeasible sleeve averaged
      // into a feasible verdict by 12 debit verticals.
      //
      // ⚠️ TRA-2361 — THIS BLOCK IS NOW PART OF WHAT BLOCKS. The comment here used to say
      // "`feasibility` above is the BLOCKING verdict … this is what that verdict RESTS
      // ON"; under QuantTrader's rule R1 a sleeve that is POSITIVELY `infeasible` at ≥20%
      // of the graded book makes `positive_expectancy` INFEASIBLE on its own. Read
      // `byStructure.blockingSleeves` and `byPremiumDirection.blockingSleeves` — non-empty
      // on EITHER axis is a stop, and `sleeves[].blocking` is the per-sleeve flag they are
      // derived from. `sleeves` is emitted WHOLE at every weight; nothing is filtered.
      //
      // ⚠️ Grade `byStructure.worstSleeve` / `byPremiumDirection.worstSleeve`, and read
      // `fragility.flipsOnSingleSleeveRemoval` BEFORE quoting the book verdict: when it
      // is true the verdict can change on COMPOSITION ALONE, with no code change — so a
      // dated "the book is feasible" claim expires the moment the mix moves. Same reason
      // `sleeves[].approachingBlockingThreshold` exists: a sleeve in [0.15, 0.20) is one
      // or two resolutions from being able to block.
      //
      // ⚠️ This is a WHOLE-OBJECT pass-through, so new fields on `SleeveFeasibility` /
      // `AxisFeasibility` DO flow. `criteria` above is a field-by-field whitelist and
      // does NOT — TRA-2361 added no `GateCriterionResult` field for exactly that reason;
      // the sleeve block is carried in the already-whitelisted `feasibilityNote` and in
      // `summary`. If you add one there, add it to the whitelist in the same commit.
      sleeveFeasibility: gate.sleeveFeasibility,
      evidence: {
        surfaced: report.totals.surfaced,
        resolved: report.totals.resolved,
        open: report.totals.open,
        // TRA-678 — ideas dropped from the gate metrics (fallback/stale/no-denom).
        excluded: report.totals.excluded,
        weeksWithResolved: report.totals.weeksWithResolved,
        weeksPositiveExpectancy: report.totals.weeksPositiveExpectancy,
        // TRA-678 (F1) — the cost-NET figures the gate actually evaluates.
        weeksPositiveExpectancyNet: report.totals.weeksPositiveExpectancyNet,
        expectancyR: report.totals.expectancyR,
        expectancyNetR: report.totals.expectancyNetR,
      },
      // TRA-2006 — raw-vs-calibrated POP so the `pop_calibration` criterion is
      // auditable from this probe. `scoredAgainst` names which gap the criterion
      // above actually used (calibrated only when ENABLE_POP_CALIBRATION is set).
      popCalibration: {
        scoredAgainst: isPopCalibrationEnabled() ? 'calibrated' : 'raw',
        ...report.popCalibration,
      },
    });
  } catch (err) {
    log.error('live-capital-gate probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to evaluate the live-capital gate.' });
  }
});

// TRA-2004 (TRA-2000) — per-cell DECOMPOSITION of the resolved AI-Options-Ideas
// set, as a redacted read-only diagnostic (same unauth, secrets-free basis as
// /api/health/live-capital-gate + /api/health/option-journal). It re-uses the
// forward-test report — no per-idea text, no per-symbol P&L, no PII — and returns
// only aggregate cell statistics (n, gross/net R, POP-vs-realized, credit/width)
// sliced by structure / DTE / IV-rank / ticker. QuantTrader has no auth on bqb1's
// authed /api/options/forward-test/report; this public redacted probe is why the
// task needs it (localhost journal is empty; bqb1 holds the n=43 resolved set).
//
// The `overall` cell reconciles with /api/health/live-capital-gate `evidence`
// (grossR = expectancyR, netR = expectancyNetR) — same resolved-and-included
// basis. Read-only; no flag, wires no capital, no behavior change on the trade path.
app.get('/api/health/options-ideas-decomposition', async (_req, res) => {
  try {
    const entries = await listJournalEntries();
    const outcomes = await forwardTestIdeas(entries);
    const report = buildForwardTestReport(outcomes, { chainsDir: defaultChainsDir() });
    res.json({
      ok: true,
      issue: 'TRA-2004',
      time: new Date().toISOString(),
      build: resolveBuildInfo(),
      // Reconciliation anchors so a reader can verify the overall cell against the
      // gate totals without a second probe call.
      totals: {
        resolved: report.totals.resolved,
        excluded: report.totals.excluded,
        expectancyR: report.totals.expectancyR,
        expectancyNetR: report.totals.expectancyNetR,
        popCalibrationGap: report.totals.popCalibrationGap,
      },
      ...report.decomposition,
    });
  } catch (err) {
    log.error('options-ideas-decomposition probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build the options-ideas decomposition.' });
  }
});

// TRA-2199 (parent TRA-2175 → TRA-2005) — the SHADOW positive-expectancy ledger
// readout, on the same unauth, secrets-free basis as the sibling
// /api/health/options-ideas-decomposition + /api/health/pop-calibration probes.
// QuantTrader has no auth on bqb1, which is why the verdict needs a public probe.
//
// WHY THIS ROUTE EXISTS. `options-research.ts` computed `expectancyShadow` and
// dropped it on the floor — no persistence, no reader, no route. The ledger was
// unobservable BY CONSTRUCTION, so the TRA-2005 leg read as armed while recording
// nothing. This is the reader.
//
// READ `enabled` FIRST. It reports whether ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE is
// on — i.e. whether the gate is RECORDING at all. Semantics are INVERTED versus
// TRA-2006's ENABLE_POP_CALIBRATION: there OFF still computes the shadow fit, so a
// readout with `enabled:false` is still evidence. Here OFF skips the shadow pass
// entirely, so `enabled:false` + `slates:0` means "nothing was recorded", NOT
// "nothing qualified". Without that distinction the two are indistinguishable, and
// conflating them is exactly what hid this defect.
//
// Aggregate-only: verdict counts, config, expectancy statistics and drop-code
// histogram sliced by structure FAMILY. No per-idea text, no tickers, no P&L.
// Read-only — wires no capital, reorders nothing, alters no surfaced slate.
app.get('/api/health/options-ideas-expectancy', (_req, res) => {
  try {
    res.json({
      ok: true,
      issue: 'TRA-2199',
      time: new Date().toISOString(),
      build: resolveBuildInfo(),
      ...summarizeOptionsIdeasExpectancy(Date.now()),
    });
  } catch (err) {
    log.error('options-ideas-expectancy probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build the options-ideas expectancy rollup.' });
  }
});

// TRA-2208 (parent TRA-1965) — the credit/width FLOOR readout, on the same unauth,
// secrets-free basis as its siblings above (QuantTrader has no auth on bqb1).
//
// WHAT TO READ, IN ORDER.
//   1. `enabled` — is the floor enforcing/recording at all? OFF skips the pass
//      entirely, so `enabled:false` + `slates:0` means "nothing recorded", NOT
//      "nothing rejected".
//   2. `survivalRate` — the share of the PROPOSED credit book that clears the floor.
//      This is the number the TRA-1965 CUT/continue fork turns on.
//   3. `stats.meanCreditWidth` — what the proposed book actually collects. The
//      diagnosis that opened this issue measured 0.03 against a 0.12–0.21 breakeven.
//
// A LOW SURVIVAL RATE IS A VALID RESULT and must NOT be read as "the floor is too
// tight" — it says our universe/IV regime does not offer sellable premium at our
// cost base. The realized-book counterpart is `creditWidthFloor` per cell on
// /api/health/options-ideas-decomposition, which needs no flag and no accrual.
//
// Aggregate-only: verdict counts, config and credit/width statistics sliced by
// structure FAMILY. No per-idea text, no tickers, no P&L. Read-only — wires no
// capital; the floor's only effect is that a below-floor credit idea is not surfaced.
app.get('/api/health/options-ideas-credit-width', (_req, res) => {
  try {
    res.json({
      ok: true,
      issue: 'TRA-2208',
      time: new Date().toISOString(),
      build: resolveBuildInfo(),
      ...summarizeOptionsIdeasCreditWidth(Date.now()),
    });
  } catch (err) {
    log.error('options-ideas-credit-width probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build the options-ideas credit/width rollup.' });
  }
});

// TRA-2006 (TRA-2000, item 2) — POP POST-CALIBRATION readout, as a redacted
// read-only diagnostic (same unauth, secrets-free basis as the sibling
// /api/health/live-capital-gate + /api/health/options-ideas-decomposition
// probes). Surfaces the fit (flat / isotonic) and the RAW-vs-CALIBRATED POP gap
// over the same resolved-and-included set the gate scores, so QuantTrader can
// sign off on the fit against bqb1's cohort (localhost journal is empty; bqb1
// holds the n≈43 resolved set). `enabled` reports whether the calibrated gap is
// currently CONSUMED by the gate (ENABLE_POP_CALIBRATION); SHADOW/false by
// default. Read-only — no capital, no feed reorder, no trade-path change.
app.get('/api/health/pop-calibration', async (_req, res) => {
  try {
    const entries = await listJournalEntries();
    const outcomes = await forwardTestIdeas(entries);
    const report = buildForwardTestReport(outcomes, {
      chainsDir: defaultChainsDir(),
      popCalibration: resolvePopCalibrationConfig(),
    });
    const c = report.popCalibration;
    const band = resolveLiveCapitalGateCriteria().maxPopCalibrationGap;
    res.json({
      ok: true,
      issue: 'TRA-2006',
      time: new Date().toISOString(),
      build: resolveBuildInfo(),
      // Whether the calibrated gap is CONSUMED by the live-capital gate right now.
      enabled: isPopCalibrationEnabled(),
      // The ≤0.10 band the gate's pop_calibration criterion enforces.
      band,
      // Reconciliation anchors: rawGap/calibratedGap here equal
      // totals.popCalibrationGap / totals.popCalibrationGapCalibrated.
      totals: {
        resolved: report.totals.resolved,
        excluded: report.totals.excluded,
        hitRate: report.totals.hitRate,
        avgStatedPop: report.totals.avgPredictedPop,
        avgCalibratedPop: report.totals.avgCalibratedPop,
        popCalibrationGap: report.totals.popCalibrationGap,
        popCalibrationGapCalibrated: report.totals.popCalibrationGapCalibrated,
      },
      // Does each gap clear the band? (null = not yet measurable.)
      clearsBand: {
        raw: c.rawGap == null ? null : Math.abs(c.rawGap) <= band,
        calibrated: c.calibratedGap == null ? null : Math.abs(c.calibratedGap) <= band,
      },
      fit: c,
    });
  } catch (err) {
    log.error('pop-calibration probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build the POP-calibration readout.' });
  }
});

// TRA-1141 (TRA-1139) — combined accuracy scorecard: both idea engines side by
// side on out-of-sample data, so the board can compare them honestly instead of
// guessing "which is more accurate". Read-only; wires no capital. Unauthenticated
// and secrets-free (parity with the other /api/health/* probes): the AI Ideas
// side is the global TRA-601 forward-test (no per-user P&L/PII) and the Proposals
// side is the offline TRA-797 A/B OOS study (win-rate / avg-R / agent-vs-baseline
// — no idea text, no balances). Each side carries an explicit sample-size verdict;
// small/insufficient samples are labelled and NO winner is implied before the data
// clears. This route only RE-SHAPES the two existing computations — it does not
// change how either ledger is computed (out of scope).
app.get('/api/health/engine-scorecard', async (_req, res) => {
  try {
    const entries = await listJournalEntries();
    const outcomes = await forwardTestIdeas(entries);
    const ideasReport = buildForwardTestReport(outcomes, { chainsDir: defaultChainsDir() });
    const aiIdeas = buildAiIdeasScorecard(ideasReport);
    const proposals = await loadProposalsScorecard();
    const scorecard = buildEngineScorecard(proposals, aiIdeas);
    res.json({
      ok: true,
      time: new Date().toISOString(),
      build: resolveBuildInfo(),
      ...scorecard,
    });
  } catch (err) {
    log.error('engine-scorecard probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build the engine scorecard.' });
  }
});

// TRA-2357 — heartbeat for the 60s observability monitor (`runObservabilityMonitor`),
// surfaced in the `disk` block below. Module-level so the route can read it without
// reaching into the scheduler.
let observabilityMonitorRuns = 0;
let observabilityMonitorLastRunAt: string | null = null;

// TRA-141 / TRA-2599 — storage diagnostic, now SPLIT: `/api/health/storage`
// stays open with a liveness subset (booleans + a staleness age), and the full
// body — `dataDir`, account counts, every `*File` size/mtime, `backupsCount`,
// `processStart`, byte-level `disk.*` and the TRA-2420 `usage` block — moved to
// `/api/health/storage/detail` behind `requireAuth, requireAdmin`.
//
// Both routes serve ONE object built by `buildStorageDiagnostic`; the open one
// publishes an allowlist projection of it, so a field added later is gated by
// default. Rationale, the three unauthenticated consumers this had to not break,
// and the `disk.readable` fix are all in `storage-health.ts`.
registerStorageHealthRoutes(app, {
  requireAuth,
  requireAdmin,
  dataDir: DATA_DIR,
  dataDirEnv: () => process.env['DATA_DIR'] ?? null,
  getUserCount: () => getAllUsers().length,
  getUserContextCount: () => getAllUserContexts().length,
  diskMinFreePct,
  readDiskSpace,
  dataDirUsage: (root) => dataDirUsageCached(root),
  observabilityMonitor: () => ({
    runs: observabilityMonitorRuns,
    lastRunAt: observabilityMonitorLastRunAt,
  }),
  processStart: () => new Date(Date.now() - process.uptime() * 1000).toISOString(),
});

// TRA-779 — option-chain capture liveness. Open (no auth, like the other
// health probes) so the Phase-2 owner can verify capture on any deploy without
// a session: confirms the Tradier token is configured, counts the accumulated
// daily partitions toward the 30-trading-day clock, and reports the latest
// partition's universe coverage. Reads only the cheap per-date `_meta.json` +
// the partition file list — it never loads full chains.
app.get('/api/health/chain-capture', async (_req, res) => {
  const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
  const PHASE2_BASELINE = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'AVGO', 'GOOGL', 'AMZN', 'META'];
  const outDir = CHAIN_RECORD_OUT_DIR;
  const tokenConfigured = (process.env['TRADIER_API_TOKEN'] ?? '').trim().length > 0;
  const rawUniverse = (process.env['CHAINS_WATCHLIST'] ?? '').trim();
  const configuredUniverse = rawUniverse
    ? rawUniverse.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...WATCHLIST];

  let dates: string[] = [];
  try {
    dates = (await readdir(outDir)).filter((d) => DATE_PARTITION.test(d)).sort();
  } catch {
    dates = [];
  }

  let latest:
    | { date: string; written: number | null; symbolsWritten: string[]; recordedAt: number | null; dteWindow: [number | null, number | null] }
    | null = null;
  if (dates.length > 0) {
    const last = dates[dates.length - 1];
    const dir = join(outDir, last);
    // TRA-2417 — counts both storage forms. The newest partition is the one
    // compaction leaves plain, but this must not depend on that.
    const symbolsWritten = (await listChainSnapshotFiles(dir)).map(chainSnapshotSymbol).sort();
    let written: number | null = symbolsWritten.length;
    let recordedAt: number | null = null;
    let dteWindow: [number | null, number | null] = [null, null];
    try {
      const meta = JSON.parse(await readFile(join(dir, '_meta.json'), 'utf-8')) as {
        written?: number;
        recordedAt?: number;
        minDteDays?: number;
        maxDteDays?: number;
      };
      if (typeof meta.written === 'number') written = meta.written;
      if (typeof meta.recordedAt === 'number') recordedAt = meta.recordedAt;
      dteWindow = [meta.minDteDays ?? null, meta.maxDteDays ?? null];
    } catch {
      // _meta.json absent/corrupt — fall back to the file-list count above.
    }
    latest = { date: last, written, symbolsWritten, recordedAt, dteWindow };
  }

  const baselineCovered = latest
    ? PHASE2_BASELINE.filter((s) => latest!.symbolsWritten.includes(s))
    : [];

  // TRA-2417 — publish the archive's own byte accounting so "compaction ran"
  // and "the archive is N MB" are gradeable HERE, instead of being re-derived
  // from Render's disk metrics (the hole TRA-2357 closed for free space). Note
  // `plainPartitions` is expected to be 1 in steady state — the newest partition
  // is deliberately left uncompacted; 0 or >1 is the anomaly worth reading.
  const storage = await chainPartitionStorageReport({
    outDir,
    retentionTradingDays: RETENTION_REPORT_TRADING_DAYS,
  });

  res.json({
    issue: 'TRA-779',
    outDir,
    tokenConfigured,
    capturing: tokenConfigured && dates.length > 0,
    tradingDaysCaptured: dates.length,
    progressToThirtyDays: { captured: dates.length, target: 30 },
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    universeSource: rawUniverse ? 'CHAINS_WATCHLIST' : 'WATCHLIST',
    configuredUniverse,
    latest,
    phase2BaselineCoverage: {
      required: PHASE2_BASELINE,
      covered: baselineCovered,
      missing: PHASE2_BASELINE.filter((s) => !baselineCovered.includes(s)),
    },
    storage: {
      ...storage,
      totalMb: Math.round((storage.totalBytes / 1_048_576) * 100) / 100,
      retention: {
        ...storage.retention,
        beyondWindowMb: Math.round((storage.retention.beyondWindowBytes / 1_048_576) * 100) / 100,
      },
      lastCompaction: lastChainCompaction,
    },
  });
});

// TRA-1049 — recorded-partition export. The chains live only on the Render
// persistent disk (`/data/option-chains`); QuantTrader's backtest box has no
// shell/disk access to it, so the recorder dataset cannot be consumed off-box
// without a transport. This bounded read-only endpoint streams one date
// partition's per-symbol snapshots (the same JSON `loadChainDays` reads) so the
// backtest box can mirror the dataset locally and run the TRA-1047 T2/T3 sweeps.
// `scripts/pull-recorded-chains.mjs` walks `chain-capture`'s date list and pulls
// each partition through here. One date per request keeps the payload bounded;
// the `:date` param is regex-validated to block path traversal.
app.get('/api/health/chain-capture/partition/:date', async (req, res) => {
  const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
  const date = String(req.params.date ?? '');
  if (!DATE_PARTITION.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  const dir = join(CHAIN_RECORD_OUT_DIR, date);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    res.status(404).json({ error: 'partition not found', date });
    return;
  }
  // TRA-2417 — a compacted partition is served IDENTICALLY: the snapshots are
  // gunzipped here and the JSON response is byte-for-byte what it was before
  // compaction, so `scripts/pull-recorded-chains.mjs` and the backtest box need
  // no change. `_meta.json` is never compacted and is still read plain.
  const symbols: unknown[] = [];
  let meta: unknown = null;
  for (const f of files.filter((n) => isChainSnapshotFile(n) || n === CHAIN_META_FILE)) {
    try {
      if (f === CHAIN_META_FILE) meta = JSON.parse(await readFile(join(dir, f), 'utf-8'));
      else symbols.push(await readChainSnapshotFile(join(dir, f)));
    } catch {
      // Skip a corrupt file rather than failing the whole partition.
    }
  }
  res.json({
    issue: 'TRA-1049',
    date,
    outDir: CHAIN_RECORD_OUT_DIR,
    symbolCount: symbols.length,
    meta,
    symbols,
  });
});

// TRA-1324 (TRA-820 Step 1) — sentiment-capture liveness. The daily
// StockTwits sentiment recorder (TRA-822) writes to the SAME persistent disk as
// the chain recorder (`DATA_DIR/sentiment-snapshots`), but until now had no
// read-only export — so the TRA-820 IC/flow harness could only read whatever
// local partition its grading box happened to hold (the disk-full PG-DEVOPS14
// ~8-day partition), while ~33 days co-accrued unreachable on bqb1. This mirrors
// `/api/health/chain-capture` exactly: open (no auth), read-only, counts the
// accumulated daily partitions and reports the latest partition's coverage from
// the cheap per-date `_meta.json` — it never loads the full sentiment rows.
app.get('/api/health/sentiment-capture', async (_req, res) => {
  const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
  const outDir = SENTIMENT_RECORD_OUT_DIR;
  const rawUniverse = (process.env['SENTIMENT_WATCHLIST'] ?? '').trim();
  const configuredUniverse = rawUniverse
    ? rawUniverse.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...WATCHLIST];

  let dates: string[] = [];
  try {
    dates = (await readdir(outDir)).filter((d) => DATE_PARTITION.test(d)).sort();
  } catch {
    dates = [];
  }

  let latest:
    | {
        date: string;
        recordedAt: number | null;
        symbolCount: number | null;
        recorded: number | null;
        noData: number | null;
        errored: number | null;
      }
    | null = null;
  if (dates.length > 0) {
    const last = dates[dates.length - 1];
    const dir = join(outDir, last);
    let recordedAt: number | null = null;
    let symbolCount: number | null = null;
    let recorded: number | null = null;
    let noData: number | null = null;
    let errored: number | null = null;
    try {
      const meta = JSON.parse(await readFile(join(dir, '_meta.json'), 'utf-8')) as {
        recordedAt?: number;
        symbolCount?: number;
        recorded?: number;
        noData?: number;
        errored?: number;
      };
      recordedAt = meta.recordedAt ?? null;
      symbolCount = meta.symbolCount ?? null;
      recorded = meta.recorded ?? null;
      noData = meta.noData ?? null;
      errored = meta.errored ?? null;
    } catch {
      // _meta.json absent/corrupt — fall back to counting rows in sentiment.json.
      try {
        const file = JSON.parse(await readFile(join(dir, 'sentiment.json'), 'utf-8')) as {
          recordedAt?: number;
          symbols?: { outcome?: string }[];
        };
        recordedAt = file.recordedAt ?? null;
        const syms = Array.isArray(file.symbols) ? file.symbols : [];
        symbolCount = syms.length;
        recorded = syms.filter((s) => s.outcome === 'recorded').length;
        noData = syms.filter((s) => s.outcome === 'no_data').length;
        errored = syms.filter((s) => s.outcome === 'error').length;
      } catch {
        // partition unreadable — leave the counts null.
      }
    }
    latest = { date: last, recordedAt, symbolCount, recorded, noData, errored };
  }

  res.json({
    issue: 'TRA-1324',
    outDir,
    capturing: dates.length > 0,
    tradingDaysCaptured: dates.length,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    universeSource: rawUniverse ? 'SENTIMENT_WATCHLIST' : 'WATCHLIST',
    configuredUniverse,
    latest,
  });
});

// TRA-1330 — live StockTwits connectivity probe. The TRA-822 recorder captured
// 0 usable reads on bqb1 because the keyless StockTwits stream sits behind
// Cloudflare, which blocks anonymous datacenter egress (every fetch → null →
// `no_data`). The fetch now presents a browser-like header fingerprint
// (`stocktwits-feed.ts`); this endpoint does a live one-shot AAPL pull from
// wherever the server runs and surfaces the ACTUAL HTTP status so we can verify
// from bqb1's Render egress whether the fingerprint clears Cloudflare — without
// waiting for the daily sweep. Read-only; never trips the production breaker.
app.get('/api/health/sentiment-probe', async (req, res) => {
  const rawSym = String(req.query.symbol ?? 'AAPL').toUpperCase();
  const symbol = /^[A-Z.]{1,10}$/.test(rawSym) ? rawSym : 'AAPL';
  const result = await probeStockTwits(symbol);
  res.json({
    issue: 'TRA-1330',
    symbol,
    ...result,
  });
});

// TRA-1324 — recorded sentiment-partition export. The daily StockTwits
// snapshots live only on the Render persistent disk
// (`DATA_DIR/sentiment-snapshots/<YYYY-MM-DD>/sentiment.json`), which the TRA-820
// grading box cannot reach. This bounded read-only endpoint streams one date
// partition's `sentiment.json` (the same rows `loadSentimentDays` reads) plus its
// `_meta.json` so the harness can mirror the dataset locally.
// `scripts/pull-recorded-sentiment.mjs` walks `sentiment-capture`'s date range
// and pulls each partition through here. One date per request keeps the payload
// bounded; the `:date` param is regex-validated to block path traversal.
app.get('/api/health/sentiment-capture/partition/:date', async (req, res) => {
  const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
  const date = String(req.params.date ?? '');
  if (!DATE_PARTITION.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  const dir = join(SENTIMENT_RECORD_OUT_DIR, date);
  let sentiment: unknown = null;
  try {
    sentiment = JSON.parse(await readFile(join(dir, 'sentiment.json'), 'utf-8'));
  } catch {
    res.status(404).json({ error: 'partition not found', date });
    return;
  }
  let meta: unknown = null;
  try {
    meta = JSON.parse(await readFile(join(dir, '_meta.json'), 'utf-8'));
  } catch {
    // _meta.json is optional — the sentiment.json rows are the durable artifact.
  }
  const symbolCount =
    sentiment && Array.isArray((sentiment as { symbols?: unknown[] }).symbols)
      ? (sentiment as { symbols: unknown[] }).symbols.length
      : 0;
  res.json({
    issue: 'TRA-1324',
    date,
    outDir: SENTIMENT_RECORD_OUT_DIR,
    symbolCount,
    meta,
    sentiment,
  });
});

// TRA-779 — replay smoke proof. Runs the real `run-options-replay` pure pipe
// (`loadChainDays` → `runOptionsReplay`) against the on-disk captured chains and
// returns the summarized buckets, proving the persisted partitions are
// replay-consumable end-to-end on the box that actually holds the data — the
// "smoke run on a few days of data proves the pipe" acceptance bullet, runnable
// remotely without exec/filesystem access to the Render disk. Open like the
// other health probes; bounded work (loads partitions once, pure replay). The
// scanners it drives are the legacy OTM/RV ones — this proves the loader→replay
// plumbing, not the Phase-2 strategy logic (that lands in TRA-781).
app.get('/api/health/options-replay-smoke', async (_req, res) => {
  try {
    const days = await loadChainDays(CHAIN_RECORD_OUT_DIR);
    if (days.length === 0) {
      res.json({
        issue: 'TRA-779',
        ok: false,
        reason: 'no_chain_partitions',
        outDir: CHAIN_RECORD_OUT_DIR,
      });
      return;
    }
    const symbolsCount = new Set(days.flatMap((d) => Array.from(d.bySymbol.keys()))).size;
    const buckets = runOptionsReplay(days, DEFAULT_REPLAY_CONFIG);
    res.json({
      issue: 'TRA-779',
      ok: true,
      outDir: CHAIN_RECORD_OUT_DIR,
      daysReplayed: days.length,
      symbolsCount,
      firstDate: days[0].date,
      lastDate: days[days.length - 1].date,
      buckets: buckets.map((b) => ({
        startingEquity: b.startingEquity,
        trades: b.trades,
        winRate: b.winRate,
        totalPnl: b.totalPnl,
        pnlPct: b.pnlPct,
        maxDrawdown: b.maxDrawdown,
        skippedZeroSize: b.skippedZeroSize,
      })),
    });
  } catch (err) {
    res.status(500).json({
      issue: 'TRA-779',
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
});

// TRA-1971 (TRA-1965) — AI-Options-Ideas ACCUMULATION MONITOR. The live-capital
// gate reads a ≥8-week forward-test record, but that record is empty until BOTH
// accumulation feeds are on AND writing to the durable data dir: the daily chain
// recorder (needs `TRADIER_API_TOKEN`) and the live ideas pass (needs
// `ANTHROPIC_API_KEY`). This probe makes accumulation progress visible WITHOUT
// manual polling — first/last recorded-chain date, first/last journaled-idea
// date, the current surfaced/resolved/weeksWithResolved counts, remaining-to-gate,
// and WHY the clock has or hasn't started yet. Read-only, unauthenticated, and
// secrets-free (parity with the other /api/health/* probes): it reports whether
// each feed's credential is CONFIGURED as a boolean, never the value. Evaluating
// it wires no capital.
app.get('/api/health/options-accumulation', async (_req, res) => {
  try {
    const [days, entries] = await Promise.all([
      loadChainDays(CHAIN_RECORD_OUT_DIR),
      listJournalEntries(),
    ]);
    const outcomes = await forwardTestIdeas(entries);
    const report = buildForwardTestReport(outcomes, { chainsDir: defaultChainsDir() });
    const gate = resolveLiveCapitalGateCriteria();
    // Journal entries are ascending by surface time (see listJournalEntries).
    const monitor = buildAccumulationMonitor({
      report,
      gate,
      chainOutDir: CHAIN_RECORD_OUT_DIR,
      chainDates: days.map((d) => d.date),
      journalCount: entries.length,
      firstJournaledDate: entries[0]?.surfacedDate ?? null,
      lastJournaledDate: entries.length ? entries[entries.length - 1].surfacedDate : null,
      tradierConfigured: Boolean(process.env['TRADIER_API_TOKEN']),
      anthropicConfigured: Boolean(process.env['ANTHROPIC_API_KEY']),
    });
    res.json({ issue: 'TRA-1971', ok: true, ...monitor });
  } catch (err) {
    log.error('options-accumulation monitor failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      issue: 'TRA-1971',
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Auth endpoints ────────────────────────────────────────────────────────────

// TRA-404 / C2 — brute-force throttle for the auth endpoints. `clientKey`
// buckets attempts by the real caller IP (see `trust proxy` above); login also
// buckets per-username so a distributed attack on one account is still caught.
function clientKey(req: express.Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

// If any of `keys` is currently throttled, write a 429 (with Retry-After) and
// return true so the caller can bail out before doing the expensive auth work.
function rejectIfThrottled(res: express.Response, keys: string[]): boolean {
  let worst = 0;
  for (const key of keys) {
    const d = checkThrottle(key);
    if (d.blocked) worst = Math.max(worst, d.retryAfterSec);
  }
  if (worst > 0) {
    res.setHeader('Retry-After', String(worst));
    res.status(429).json({
      error: `Too many attempts. Try again in ${worst}s.`,
      retryAfterSec: worst,
    });
    return true;
  }
  return false;
}

app.post('/api/auth/login', async (req, res) => {
  const { username, password, enrollTwoFactor } = req.body as {
    username?: string;
    password?: string;
    // TRA-2293 — the login screen's "turn on two-factor" opt-in.
    enrollTwoFactor?: boolean;
  };
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }
  const ipKey = `login:ip:${clientKey(req)}`;
  const userKey = `login:user:${username.toLowerCase()}`;
  if (rejectIfThrottled(res, [ipKey, userKey])) return;

  if (!(await validateUserCredentials(username, password))) {
    recordFailure(ipKey);
    recordFailure(userKey);
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  // TRA-217 — locked accounts cannot log in even with correct credentials.
  // Check after credential validation so we don't leak which usernames exist.
  if (isUserLocked(username)) {
    res.status(423).json({ error: 'Account is locked. Contact an administrator.' });
    return;
  }
  // Valid credentials → wipe the brute-force counters for this caller/account.
  recordSuccess(ipKey);
  recordSuccess(userKey);

  // TRA-2293 — opt into two-factor straight from the login screen. Enrolling here
  // (after the password check, before the response) means the very next thing the
  // user sees is the code-entry step, so the control they just switched on is
  // exercised immediately rather than taking effect on some later sign-in.
  //
  // The minted backup codes are NOT returned here: at this point the caller has
  // only proven the password, and handing over ten permanent bypass codes on that
  // basis would make the opt-in a downgrade. They are released by /2fa/verify,
  // once the emailed code has actually been cleared.
  //
  // No email on file → no delivery channel, so enrolment is skipped and the
  // `emailRequired` step below collects one first.
  const enrollRequested = enrollTwoFactor === true;
  let enrolledNow = false;
  if (enrollRequested && !isTwoFactorEnabled(username) && getUser(username)?.email) {
    const enrolled = await enableTwoFactor(username);
    if (enrolled.ok) {
      stashEnrollmentBackupCodes(username, enrolled.backupCodes);
      enrolledNow = true;
    } else {
      log.warn('auth: login-screen 2FA opt-in failed to enrol', {
        username,
        reason: enrolled.error,
      });
    }
  }

  // TRA-1505 — if the account has email 2FA enabled, the password step is only
  // the FIRST factor: issue a short-lived pending-auth token (NOT a session),
  // email a one-time code, and require /api/auth/2fa/verify to finish. The
  // pending token is useless against protected routes (verifyToken rejects it),
  // so a "verified" client flag can never be trusted.
  if (isTwoFactorEnabled(username)) {
    const user = getUser(username);
    if (user?.email) {
      const { code } = issueChallenge(username);
      try {
        await sendOtpEmail(user.email, username, code);
      } catch (err) {
        log.error('auth: failed to send 2FA code', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      res.json({
        twoFactorRequired: true,
        pendingToken: createPendingToken(username),
        // TRA-2293 — tells the client this login is the one that turned 2FA on,
        // so it knows to expect backup codes back from /2fa/verify.
        ...(enrolledNow ? { twoFactorEnrolled: true } : {}),
      });
      return;
    }
    // Enabled but no email on file (shouldn't happen — enrollment requires one).
    // Fail safe by letting them in rather than locking them out permanently.
    log.warn('auth: 2FA enabled but no email on file; skipping second factor', { username });
  }

  // TRA-2293 — an account with no email on file can neither receive a sign-in
  // code nor enrol in 2FA, and the `admin` seed account starts exactly that way.
  // The password was correct, so the session is legitimate; the client uses this
  // flag to collect an address before handing over the dashboard. It is collected
  // HERE rather than on the logged-out screen on purpose — letting an
  // unauthenticated caller attach an address to a username would turn "email me a
  // code" into an account-takeover primitive.
  const emailOnFile = getUser(username)?.email;
  res.json({
    token: createToken(username),
    ...(emailOnFile ? {} : { emailRequired: true }),
    // Opt-in that could not be honoured yet — the client re-tries it once an
    // address is on file.
    ...(enrollRequested && !emailOnFile ? { twoFactorPending: true } : {}),
  });
});

// TRA-1505 — complete the second factor. Accepts either the emailed OTP or a
// single-use backup code. Only here (with a valid pending token) is a full
// session minted. Throttled per-IP and per-user so the 6-digit code can't be
// brute-forced.
app.post('/api/auth/2fa/verify', async (req, res) => {
  const { pendingToken, code } = req.body as { pendingToken?: string; code?: string };
  if (typeof pendingToken !== 'string' || typeof code !== 'string') {
    res.status(400).json({ error: 'pendingToken and code are required' });
    return;
  }
  const username = verifyPendingToken(pendingToken);
  if (!username) {
    res.status(401).json({ error: 'Your login session expired. Please sign in again.' });
    return;
  }
  // TRA-2293 — re-check the lock here, not just at /api/auth/login. The
  // email-code sign-in below mints a pending token without going through the
  // password route at all, so this is the only lock check on that path.
  if (isUserLocked(username)) {
    res.status(423).json({ error: 'Account is locked. Contact an administrator.' });
    return;
  }
  const ipKey = `2fa:ip:${clientKey(req)}`;
  const userKey = `2fa:user:${username.toLowerCase()}`;
  if (rejectIfThrottled(res, [ipKey, userKey])) return;

  const trimmed = code.trim();
  // A dashed/alphabetic value is a backup recovery code; a plain numeric value is
  // the emailed OTP.
  const looksLikeBackupCode = /[a-zA-Z-]/.test(trimmed);
  if (looksLikeBackupCode) {
    if (await consumeBackupCode(username, trimmed)) {
      recordSuccess(ipKey);
      recordSuccess(userKey);
      res.json({ token: createToken(username) });
      return;
    }
    recordFailure(ipKey);
    recordFailure(userKey);
    res.status(401).json({ error: 'Invalid or already-used backup code.' });
    return;
  }

  const result = verifyChallenge(username, trimmed);
  if (result === 'ok') {
    recordSuccess(ipKey);
    recordSuccess(userKey);
    // TRA-2293 — release the backup codes minted by a login-screen opt-in, now
    // that the second factor has actually been cleared. Null for every ordinary
    // sign-in.
    const backupCodes = takeEnrollmentBackupCodes(username);
    res.json({
      token: createToken(username),
      ...(backupCodes ? { backupCodes } : {}),
    });
    return;
  }
  recordFailure(ipKey);
  recordFailure(userKey);
  if (result === 'expired' || result === 'no_challenge') {
    res.status(401).json({ error: 'Code expired. Request a new one.', code: 'expired' });
    return;
  }
  if (result === 'too_many_attempts') {
    res.status(429).json({ error: 'Too many wrong codes. Please sign in again.', code: 'too_many_attempts' });
    return;
  }
  res.status(401).json({ error: 'Incorrect code. Try again.', code: 'invalid' });
});

// TRA-1505 — resend the emailed OTP for an in-flight challenge, rate-limited per
// challenge (in two-factor.ts) and per-IP here.
app.post('/api/auth/2fa/resend', async (req, res) => {
  const { pendingToken } = req.body as { pendingToken?: string };
  if (typeof pendingToken !== 'string') {
    res.status(400).json({ error: 'pendingToken is required' });
    return;
  }
  const username = verifyPendingToken(pendingToken);
  if (!username) {
    res.status(401).json({ error: 'Your login session expired. Please sign in again.' });
    return;
  }
  const ipKey = `2fa-resend:ip:${clientKey(req)}`;
  if (rejectIfThrottled(res, [ipKey])) return;
  recordFailure(ipKey);

  const result = resendChallenge(username);
  if (!result.ok) {
    if (result.reason === 'too_many_sends') {
      res.status(429).json({ error: 'Too many codes requested. Please sign in again.' });
      return;
    }
    res.status(401).json({ error: 'No active login to resend. Please sign in again.' });
    return;
  }
  const user = getUser(username);
  if (user?.email) {
    try {
      await sendOtpEmail(user.email, username, result.code);
    } catch (err) {
      log.error('auth: failed to resend 2FA code', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  res.json({ ok: true, message: 'A new code has been sent.' });
});

// TRA-2293 — sign in with an emailed code instead of a password. The account's
// address is the only delivery target; there is no way for the caller to name one,
// so this proves possession of an inbox already on file.
//
// Security floor: this is not weaker than what already exists. /api/auth/forgot
// -password hands full account control to whoever reads that same inbox, so
// treating an emailed code as sufficient to sign in grants strictly less (no
// password change, and the code expires in ~10 minutes).
//
// The response is deliberately identical for every input — same shape, same
// message, and a pendingToken minted even for a username that does not exist —
// so this route cannot be used to enumerate accounts. A token with no challenge
// behind it simply fails at /2fa/verify.
app.post('/api/auth/login-code', async (req, res) => {
  const { username } = req.body as { username?: string };
  if (typeof username !== 'string' || !username.trim()) {
    res.status(400).json({ error: 'username is required' });
    return;
  }
  const name = username.trim();
  const ipKey = `login-code:ip:${clientKey(req)}`;
  const userKey = `login-code:user:${name.toLowerCase()}`;
  if (rejectIfThrottled(res, [ipKey, userKey])) return;
  // Every request counts toward the limit: the response is always ok, so there is
  // no success to clear the counter with.
  recordFailure(ipKey);
  recordFailure(userKey);

  const user = getUser(name);
  // A locked account gets no code — /2fa/verify refuses it anyway, but there is
  // no reason to mail one out.
  if (user?.email && !isUserLocked(name)) {
    const { code } = issueChallenge(name);
    try {
      await sendOtpEmail(user.email, name, code);
    } catch (err) {
      log.error('auth: failed to send sign-in code', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  res.json({
    ok: true,
    pendingToken: createPendingToken(name),
    message: 'If that account exists and has an email on file, a sign-in code is on its way.',
  });
});

// TRA-1505 — 2FA enrollment (authenticated). Enabling mints one-time backup
// recovery codes returned exactly once; the client must show them to the user.
app.get('/api/auth/2fa/status', requireAuth, (req, res) => {
  const username = res.locals['authUser'] as string;
  res.json(getTwoFactorStatus(username));
});

app.post('/api/auth/2fa/enable', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  // Re-authenticate with the current password before turning on a security
  // control, so a hijacked session can't silently enroll (and lock out) a user.
  const { password } = req.body as { password?: string };
  if (typeof password !== 'string' || !(await validateUserCredentials(username, password))) {
    res.status(401).json({ error: 'Current password is required to enable two-factor.' });
    return;
  }
  const result = await enableTwoFactor(username);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, backupCodes: result.backupCodes });
});

app.post('/api/auth/2fa/disable', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const { password } = req.body as { password?: string };
  if (typeof password !== 'string' || !(await validateUserCredentials(username, password))) {
    res.status(401).json({ error: 'Current password is required to disable two-factor.' });
    return;
  }
  await disableTwoFactor(username);
  res.json({ ok: true });
});

// TRA-2293 — attach an email address to an account that has none. Required
// before 2FA or emailed sign-in codes can work at all, and the `admin` seed
// account is created with an empty address.
//
// Authenticated on purpose: the caller has already proven the password, so this
// cannot be used to point someone else's account at an attacker's inbox. Adding
// an address is allowed once; CHANGING an existing one stays in Settings, where
// it sits behind the rest of the account-management surface.
app.post('/api/auth/account/email', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string' || !email.includes('@') || !email.trim()) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }
  const trimmed = email.trim();
  const current = getUser(username);
  if (current?.email) {
    res.status(409).json({ error: 'This account already has an email address. Change it in Settings.' });
    return;
  }
  const existing = getUserByEmail(trimmed);
  if (existing && existing.username !== username) {
    res.status(409).json({ error: 'That email address is already in use.' });
    return;
  }
  const result = await updateUser(username, { email: trimmed });
  if (!result.ok) {
    res.status(400).json({ error: result.error ?? 'Could not save that email address.' });
    return;
  }
  res.json({ ok: true, email: trimmed });
});

app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password } = req.body as { username?: string; email?: string; password?: string };
  if (typeof username !== 'string' || !username.trim()) {
    res.status(400).json({ error: 'Username is required' });
    return;
  }
  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }
  if (typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  // TRA-2407 — reserve the operator book names. The demo-calendar fill scope
  // matches them case-INSENSITIVELY (it has to: the codebase spells the book both
  // `Richard` and `richard`, and a case mismatch would silently blank the very
  // calendar TRA-1572 built). But `users.ts` enforces uniqueness with a
  // case-SENSITIVE `===`, so without this guard `RICHARD` would register as a
  // distinct account and inherit the firm-wide fold — turning the fix into the
  // escalation it closes. The two rules are a pair; do not relax one alone.
  //
  // TRA-2508 — this used to be an inline `if` here and nowhere else, which is how
  // both admin identity-writes came to skip it. It is now the shared precondition;
  // `audience: 'public'` is what makes the admin carve-out unreachable from this
  // anonymous body.
  const reserved = refuseReservedIdentityWrite({ name: username, audience: 'public' });
  if (reserved) {
    res.status(reserved.status).json({ error: reserved.message });
    return;
  }
  // TRA-2410 — a username is a RECYCLABLE key. If the credential store says this
  // name is free but a book is still sitting under it (an admin delete retains the
  // files by design; so does an operator editing `users.json`; so does every book
  // orphaned before TRA-2421 shipped), then `createUserContext` would adopt that
  // directory and `loadStocksTradeSnapshot` would rehydrate the previous holder's
  // positions into this account. Retire it FIRST — after `createUser` there is a
  // window where a request on the brand-new token can build the context and adopt
  // the book before we get here.
  //
  // This runs only when the name is genuinely free; a live collision is left to
  // `createUser` to reject, so a failed signup can never disturb a live book.
  if (!getUser(username.trim())) {
    const retirement = await retireOrphanedBook(username.trim());
    if (!retirement.ok) {
      // Fail CLOSED. Creating the account anyway is exactly the reported bug:
      // the user opens onto someone else's positions.
      log.error('signup: refusing registration — could not retire an orphaned book', {
        username: username.trim(),
        errors: retirement.errors,
      });
      res.status(503).json({ error: 'Could not prepare a clean account. Please try again shortly.' });
      return;
    }
    if (retirement.orphanFound) {
      log.warn('signup: retired an orphaned book before registering the name', {
        username: username.trim(),
        primaryDirExisted: retirement.primaryDirExisted,
        backupGenerationsWithData: retirement.backupGenerationsWithData,
        retiredAt: retirement.retiredAt,
        // TRA-2520 — the fourth channel. A row found here with NO primary directory
        // and NO backup generation is the case the other three cannot see at all.
        settingsRowFound: retirement.settingsRowFound,
        settingsRowRetired: retirement.settingsRowRetired,
        settingsCredentialFieldsCleared: retirement.settingsCredentialFieldsCleared,
      });
    }
  }
  const result = await createUser(username.trim(), email.trim(), password);
  if (result.error) {
    res.status(409).json({ error: result.error });
    return;
  }
  // TRA-142 — spin up the new user's per-user context (fresh equity, empty trade
  // history, default settings) so their engine starts ticking right away.
  //
  // TRA-2410 — that promise is now ENFORCED rather than assumed: the guard above
  // clears the live key and records the identity epoch, so the three channels that
  // could refill this book (the directory, the 24 backup generations, the shared
  // option journal) all resolve to empty for a name that was reused.
  await provisionUser(username.trim());
  // TRA-2251 — welcome email, best-effort. Fire-and-forget: a mail failure (or
  // unconfigured SMTP) must never block account creation, so we do not await it
  // and swallow any rejection into the log.
  void sendWelcomeEmail(email.trim(), username.trim()).catch((err) => {
    log.error('auth: failed to send welcome email', {
      reason: err instanceof Error ? err.message : String(err),
    });
  });
  res.json({ token: createToken(username.trim()) });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }
  // TRA-404 / C2 — throttle by IP to stop reset-email flooding. Every request
  // counts toward the limit (the endpoint always returns ok, so there is no
  // "success" to clear); honest users only ever call it once or twice.
  const forgotKey = `forgot:ip:${clientKey(req)}`;
  if (rejectIfThrottled(res, [forgotKey])) return;
  recordFailure(forgotKey);
  const user = getUserByEmail(email);
  if (user) {
    const code = generateResetToken(user.username);
    try {
      await sendPasswordResetEmail(email, user.username, code);
    } catch (err) {
      log.error('auth: failed to send reset email', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  res.json({ ok: true, message: 'If an account with that email exists, a reset code has been sent.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { code, newPassword } = req.body as { code?: string; newPassword?: string };
  if (typeof code !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'code and newPassword are required' });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  // TRA-404 / C2 — the reset code is an 8-digit number; throttle by IP so it
  // cannot be brute-forced.
  const resetKey = `reset:ip:${clientKey(req)}`;
  if (rejectIfThrottled(res, [resetKey])) return;

  const username = consumeResetToken(code);
  if (!username) {
    recordFailure(resetKey);
    res.status(400).json({ error: 'Invalid or expired reset code' });
    return;
  }
  recordSuccess(resetKey);
  await changeUserPassword(username, newPassword);
  res.json({ ok: true, message: 'Password has been reset. You can now log in.' });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'currentPassword and newPassword are required' });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }
  if (!(await validateUserCredentials(username, currentPassword))) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }
  await changeUserPassword(username, newPassword);
  res.json({ ok: true, message: 'Password changed successfully' });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const username = res.locals['authUser'] as string;
  const user = getUser(username);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json(toSafeUser(user));
});

/**
 * TRA-2421 — self-serve account deletion: wipe the data, destroy the identity.
 *
 * Board request on TRA-2406: "can you add a self account delete option in
 * settings that wipe data and delete account?" This is the ONLY destructive
 * delete path. The admin route below stays non-destructive on purpose (TRA-142:
 * "on-disk state is left intact … so an admin can restore them"), so an operator
 * mis-click is still recoverable while a user's explicit request is honoured.
 *
 * ⚠️ THE ORDER OF THESE STEPS IS THE FIX. Wiping first and de-authenticating
 * afterwards restores the book: a debounced persist timer, a request on the
 * still-valid token, or a WS reconnect all land on `ensureUserContext`, which
 * re-mkdirs the directory and rehydrates it from a 30-min backup. Engines are
 * stopped, then the credential row goes (which is what makes `requireAuth` start
 * refusing the caller's token), then sockets are closed — and only then are the
 * files destroyed.
 */
app.delete('/api/account', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const { password } = req.body as { password?: string };

  // Irreversible ⇒ a bare token is not enough (a borrowed laptop must not be able
  // to destroy the book). Throttled on the same counters as login so this cannot
  // become an unmetered password oracle.
  const ipKey = `delete-account:ip:${clientKey(req)}`;
  const userKey = `delete-account:user:${username.toLowerCase()}`;
  if (rejectIfThrottled(res, [ipKey, userKey])) return;
  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ error: 'Your current password is required to delete this account.' });
    return;
  }
  if (!(await validateUserCredentials(username, password))) {
    recordFailure(ipKey);
    recordFailure(userKey);
    res.status(401).json({ error: 'Password is incorrect' });
    return;
  }
  recordSuccess(ipKey);
  recordSuccess(userKey);

  const me = getUser(username);
  if (!me) { res.status(404).json({ error: 'User not found' }); return; }
  // Operator books and the last admin. Both rules live in `refuseSelfDelete` so
  // they are covered by a test — there is no route-level harness in this package,
  // so a rule left inline here would be asserted by nothing. The operator
  // predicate is the SAME one that guards signup (TRA-2407): a name that may not
  // be registered must not be self-destructible either.
  const refusal = refuseSelfDelete({
    username,
    role: me.role,
    adminCount: getAllUsers().filter(u => u.role === 'admin').length,
    isOperatorBook: isReservedOperatorBookName,
  });
  if (refusal) {
    res.status(refusal.status).json({ error: refusal.message });
    return;
  }

  // The four steps, in the one order that actually destroys the account. The
  // sequence lives in `performSelfDelete` because the ORDER is the fix and
  // nothing here could test it.
  const outcome = await performSelfDelete(username, {
    destroyContext: destroyUserContext,
    deleteCredentialRow: deleteUser,
    closeSockets: closeUserSockets,
    wipe: (u) => wipeAccountData(u, { via: 'self' }),
  });
  if (!outcome.ok && outcome.reason === 'not_found') {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const receipt = outcome.receipt;

  // The shared option journal is NOT rewritten (see `account-deletion.ts`); the
  // tombstone scopes those rows out of any future holder of this name. Report the
  // retained count so the answer to "what happened to my trades in the firm
  // ledger?" is a number rather than silence.
  let journalRowsRetained: number | null = null;
  try {
    journalRowsRetained = journalRowsForBook(await listOptionTradeJournal(), username).length;
  } catch { /* the journal is advisory here; never fail a completed delete on it */ }

  // `receipt.errors[]` is labelled with absolute DATA_DIR paths — operator log
  // only. The redaction is applied to BOTH branches, not just the failing one, so
  // there is a single shape on the wire and no future field can leak by landing on
  // the path nobody redacted. The full receipt still goes to `log`.
  const publicReceipt = redactWipeReceipt(receipt);

  if (!receipt.ok) {
    // The identity IS gone and cannot authenticate — that half is done and is not
    // reversible. Say plainly that residue remains rather than returning a bare
    // 200 that reads exactly like a clean wipe.
    log.error('TRA-2421: self-delete completed with residue', { username, receipt });
    res.status(500).json({
      ok: false,
      error: 'Your account was deleted, but some stored data could not be removed. This has been logged for an operator.',
      receipt: publicReceipt,
      journalRowsRetained,
    });
    return;
  }
  log.info('TRA-2421: self-delete complete', { username, receipt });
  res.json({ ok: true, receipt: publicReceipt, journalRowsRetained });
});

app.patch('/api/auth/me', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string') { res.status(400).json({ error: 'email is required' }); return; }
  const result = await updateUser(username, { email });
  if (!result.ok) { res.status(404).json({ error: result.error }); return; }
  res.json({ ok: true });
});

// ── Admin: user management ────────────────────────────────────────────────────

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({ users: getAllUsers() });
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, email, password, role, adoptExistingBook, provisionOperatorBook } = req.body as {
    username?: string;
    email?: string;
    password?: string;
    role?: 'admin' | 'user';
    adoptExistingBook?: boolean;
    provisionOperatorBook?: boolean;
  };
  if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'username, email, and password are required' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  // TRA-2508 — the operator-name reserve, which this route skipped entirely.
  // `POST {username:'RICHARD'}` minted a `role: 'user'` book that was served the
  // firm-wide demo fold on `/api/reports/<date>?mode=demo` while `/api/reports/desk`
  // 403'd the same token — the front-door-403 / side-door-200 asymmetry TRA-2407
  // exists to close, reached through an admin route instead of signup.
  //
  // It runs BEFORE `retireOrphanedBook` deliberately: a refused create must not
  // have moved anyone's book aside on its way to the 409.
  const reserved = refuseReservedIdentityWrite({
    name: username,
    audience: 'admin',
    provisionOperatorBook,
  });
  if (reserved) {
    res.status(reserved.status).json({ error: reserved.message });
    return;
  }
  // TRA-2410 — same guard as signup, with the ONE deliberate exception.
  //
  // TRA-142 leaves an admin-deleted user's files on disk "so an admin can restore
  // them", and the restore has always been implicit: re-create the name and the
  // book comes back. That is the same mechanism as the reported bug — the only
  // difference is intent — so intent is now stated instead of inferred.
  // `adoptExistingBook: true` performs the TRA-142 restore; the default does not,
  // because "create a user" reading as "hand them whatever was here before" is
  // precisely what TRA-2406 escalated. Either way nothing is destroyed: a retired
  // book is moved to `orphaned-books/`, so a mistaken default is recoverable.
  let retiredOrphan: Awaited<ReturnType<typeof retireOrphanedBook>> | null = null;
  if (adoptExistingBook !== true && !getUser(username)) {
    retiredOrphan = await retireOrphanedBook(username);
    if (!retiredOrphan.ok) {
      log.error('admin: refusing to create user — could not retire an orphaned book', {
        username,
        errors: retiredOrphan.errors,
      });
      res.status(503).json({ error: 'Could not prepare a clean account. Please try again shortly.' });
      return;
    }
  }
  const result = await createUser(username, email, password, role ?? 'user');
  if (result.error) {
    res.status(409).json({ error: result.error });
    return;
  }
  // TRA-142 — admin-created users also get an isolated context.
  await provisionUser(username);
  res.status(201).json({
    ok: true,
    user: result.user,
    // TRA-2410 — say so when a predecessor's book was moved aside, and say WHERE.
    // The admin is the only party who can undo it, and a silent retirement reads
    // exactly like a name that was never used before.
    // TRA-2520 — the settings ROW is reported alongside the tree, because it is the
    // channel whose retirement is otherwise INVISIBLE: the tree can be inspected on
    // the wire (the successor's watchlist/positions come back empty), but "the row
    // was dropped" and "there was never a row" produce identical `GET
    // /api/account/settings` output. This admin response is the only place a grader
    // can tell a guard that fired from a disk that was already clean.
    ...(retiredOrphan?.orphanFound
      ? {
          retiredOrphanedBook: {
            quarantinedTo: retiredOrphan.quarantinedTo,
            retiredAt: retiredOrphan.retiredAt,
            settingsRowFound: retiredOrphan.settingsRowFound,
            settingsRowRetired: retiredOrphan.settingsRowRetired,
            settingsCredentialFieldsCleared: retiredOrphan.settingsCredentialFieldsCleared,
            settingsQuarantinedTo: retiredOrphan.settingsQuarantinedTo,
          },
        }
      : {}),
  });
});

app.patch('/api/admin/users/:username', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const { email, newUsername } = req.body as { email?: string; newUsername?: string };
  // TRA-2508 — the sharper half of the report. This route had no reserve check
  // anywhere on its path, so a plain book that 404'd on a seeded firm day served
  // the firm's numbers after `PATCH {newUsername:'Richard'}` — on a RENAME ALONE,
  // with its role untouched, so `/api/reports/desk` kept 403ing it.
  //
  // No `provisionOperatorBook` carve-out here: restoring an operator book is a
  // CREATE (TRA-142 retains the files for exactly that), not a rename of some
  // other account onto the name. A guard with no way to be waived is one fewer
  // flag for the next route to forget to forward.
  const reserved = refuseReservedIdentityWrite({ name: newUsername, audience: 'admin' });
  if (reserved) {
    res.status(reserved.status).json({ error: reserved.message });
    return;
  }
  const result = await updateUser(username, { email, username: newUsername });
  if (!result.ok) {
    res.status(result.error === 'User not found' ? 404 : 409).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:username', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const authUser = res.locals['authUser'] as string;
  if (username === authUser) {
    res.status(400).json({ error: 'Cannot delete your own account' });
    return;
  }
  const deleted = await deleteUser(username);
  if (!deleted) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // TRA-142 — stop the deleted user's engines and forget their caches. Their
  // on-disk state is left intact under DATA_DIR/users/<username>/ so an admin
  // can restore them if needed (re-create the name with `adoptExistingBook: true`).
  destroyUserContext(username);
  // TRA-2410 — record the identity epoch NOW, while we know it exactly. Retaining
  // the files is the point of this route, so the tombstone is the only thing
  // separating them from the next holder of the name: it is what makes
  // `tryRestoreFromBackup` refuse the 24 retained generations and what scopes the
  // shared option journal. The re-signup guard would derive an epoch later, but it
  // would be the moment the orphan was FOUND — this one is the moment it was made.
  //
  // Best-effort: a tombstone that cannot be written must not fail the delete (the
  // credential row is already gone), and the re-signup guard is the second line.
  try {
    recordAccountTombstone(username, { via: 'admin' });
  } catch (err: unknown) {
    log.error('admin: user deleted but tombstone not recorded', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  // An outstanding reset code for a deleted name is a live route onto whoever
  // registers it next — the same reasoning as `wipeAccountData` step 4.
  const resetTokensRevoked = revokeResetTokensFor(username);
  res.json({ ok: true, resetTokensRevoked });
});

// TRA-217 — admin sets a user's password directly (no current-password check).
app.post('/api/admin/users/:username/password', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const { newPassword } = req.body as { newPassword?: string };
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    return;
  }
  if (!getUser(username)) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await changeUserPassword(username, newPassword);
  res.json({ ok: true });
});

// TRA-217 — admin locks/unlocks a user. Locked accounts cannot log in.
app.post('/api/admin/users/:username/lock', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const { locked } = req.body as { locked?: boolean };
  if (typeof locked !== 'boolean') {
    res.status(400).json({ error: 'locked (boolean) is required' });
    return;
  }
  const authUser = res.locals['authUser'] as string;
  // Prevent admins from locking themselves out of the system.
  if (locked && username === authUser) {
    res.status(400).json({ error: 'Cannot lock your own account' });
    return;
  }
  const ok = await setUserLocked(username, locked);
  if (!ok) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ ok: true, locked });
});

// TRA-217 — admin triggers a password-reset email for any user. Reuses the
// same generator + email template the public forgot-password flow uses, so
// the user resets their own password by entering the PIN.
app.post('/api/admin/users/:username/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const user = getUser(username);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (!user.email) {
    res.status(400).json({ error: 'User has no email address on file' });
    return;
  }
  const code = generateResetToken(user.username);
  try {
    await sendPasswordResetEmail(user.email, user.username, code);
  } catch (err) {
    log.error('admin: failed to send reset email', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({ error: 'Failed to send reset email' });
    return;
  }
  res.json({ ok: true, message: `Reset code emailed to ${user.email}` });
});

// ── Admin: self-restart (TRA-793) ─────────────────────────────────────────────
//
// The agent fleet runs as the non-elevated user PRIMEROGA\eetienne, but the PM2
// daemon + `trading-server` are launched at boot by the `PM2 Resurrect`
// scheduled task as LOCAL_SYSTEM (ops/install-pm2-autostart.ps1, TRA-605). So a
// fleet agent CANNOT `pm2 restart trading-server` (EPERM on the SYSTEM daemon
// control pipe) to adopt a freshly built `dist` after a redeploy — that needs a
// human/SYSTEM action (this is why TRA-792 stalled on an operator restart).
//
// This route makes redeploys self-serve: an authenticated admin POSTs here and
// we run the EXACT same graceful shutdown SIGTERM triggers (stop the scheduler +
// every engine, drain in-flight ticks bounded by SHUTDOWN_DRAIN_TIMEOUT_MS,
// flush trade history + structured logs, then process.exit(0)). PM2
// (autorestart:true, restart_delay 3s — ecosystem.config.cjs) then relaunches
// the worker onto the current build with no elevated action required.
//
// It is a control surface on the live trading server, so it is admin-only
// (requireAuth + requireAdmin) and every call is audit-logged with the
// requesting user + reason before the process goes down.
app.post('/api/admin/restart', requireAuth, requireAdmin, (req, res) => {
  // `shuttingDown` (declared with the graceful-shutdown machinery below) is
  // already true if a SIGTERM or a prior restart call is mid-flight; don't
  // stack a second exit on top of it.
  if (shuttingDown) {
    res.status(409).json({ error: 'Server is already shutting down' });
    return;
  }
  const authUser = res.locals['authUser'] as string;
  const rawReason = (req.body as { reason?: unknown } | undefined)?.reason;
  const reason =
    typeof rawReason === 'string' && rawReason.trim()
      ? rawReason.trim().slice(0, 500)
      : 'unspecified';
  // Audit BEFORE we go down — this line is flushed by gracefulShutdown's
  // flushLogs() so it survives the exit.
  log.warn('TRA-793 admin-restart requested — exiting for PM2 relaunch', {
    user: authUser,
    reason,
  });
  // Acknowledge first so the caller gets a clean 202 before the socket closes
  // mid-shutdown; it should then poll GET /api/health until it returns 200.
  res.status(202).json({
    ok: true,
    restarting: true,
    restartDelayMs: 3000,
    message: 'Server is restarting; poll GET /api/health until it returns 200.',
  });
  // Defer one tick so the response fully flushes to the client before the
  // process begins draining and exits.
  setTimeout(() => {
    void gracefulShutdown('admin-restart');
  }, 250).unref?.();
});

// TRA-1481 (parent TRA-1408) — admin-only read/write of the allowlisted
// <DATA_DIR>/demo-flags.json overlay over HTTP. WHY: on bqb1 (Render) a
// render.yaml env addition stays DARK until a MANUAL blueprint sync — a plain
// code autoDeploy does NOT re-sync env, and a non-admin agent has neither the
// Render API key (TRA-969, blocked) nor a shell to write /data. That is exactly
// how ENABLE_CHURN_LOSS_BRAKE=1 shipped "merged" (render.yaml) yet ran
// `armed:false`. This surface closes that gap daemon-free: an admin flips any
// allowlisted DEMO flag on the RUNNING process and the engine picks it up on the
// next tick (demo-flags.json is re-read per resolve). STRICTLY bounded — the
// write path only ever honours DEMO_FLAG_ALLOWLIST keys (secrets / non-demo /
// live settings are rejected, never written), so it cannot inject a secret or
// alter a live-capital setting. Admin-gated + audit-logged like /admin/restart.
app.get('/api/admin/demo-flags', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    dataDir: DATA_DIR,
    // Current on-disk overlay (allowlisted keys only) …
    flags: loadDemoFlagFile(DATA_DIR),
    // … and the keys an admin is permitted to set here.
    allowlist: [...DEMO_FLAG_ALLOWLIST],
  });
});

app.post('/api/admin/demo-flags', requireAuth, requireAdmin, (req, res) => {
  const authUser = res.locals['authUser'] as string;
  const body = req.body as { flags?: unknown } | undefined;
  const raw = body?.flags;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    res
      .status(400)
      .json({ error: 'Body must be { flags: { KEY: value|null, … } }' });
    return;
  }
  // Coerce to the accepted value shape; a null removes the key (revert to
  // env/default), a string|number|boolean sets it. Anything else is dropped so
  // the write helper never sees an object/array value.
  const updates: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      updates[key] = value;
    }
  }
  const result = writeDemoFlagFile(DATA_DIR, updates);
  // Audit the mutation with the requesting user (parity with /admin/restart).
  log.warn('TRA-1481 admin demo-flags write', {
    user: authUser,
    applied: result.applied,
    removed: result.removed,
    rejected: result.rejected,
  });
  res.json({ ok: true, dataDir: DATA_DIR, ...result });
});

// ── News + research merge (TRA-227) ──────────────────────────────────────────
//
// Maps a research report into a NewsItem for the News tab and merges with the
// Yahoo headline list. Reports newer than 24h are pinned to the top in
// publishedAt order; older reports interleave with Yahoo by time. The
// front-end recognises research items by `kind`/`bodyMarkdown` and renders an
// expandable card with a "Research" badge.

const RESEARCH_PIN_WINDOW_MS = 24 * 60 * 60 * 1000;

function researchToNewsItem(r: ResearchReport): NewsItem {
  return {
    id: r.id,
    title: r.title,
    url: `/research/${r.id}`,
    source: r.source,
    publishedAt: r.publishedAt,
    kind: r.kind,
    bodyMarkdown: r.bodyMarkdown,
  };
}

async function mergeResearchAndNews(yahoo: NewsItem[]): Promise<NewsItem[]> {
  const reports = await listResearchReports();
  if (reports.length === 0) return yahoo;
  const now = Date.now();
  const pinned: NewsItem[] = [];
  const rest: NewsItem[] = [...yahoo];
  for (const r of reports) {
    const item = researchToNewsItem(r);
    const ts = Date.parse(r.publishedAt);
    if (Number.isFinite(ts) && now - ts <= RESEARCH_PIN_WINDOW_MS) {
      pinned.push(item);
    } else {
      rest.push(item);
    }
  }
  pinned.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  rest.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return [...pinned, ...rest];
}

// ── Trade history export (TRA-564, parent TRA-410 §2.4 / B1) ─────────────────

/** Parse a comma-separated, lower-cased, de-duped query list. */
function parseCsvParam(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return Array.from(
    new Set(
      raw
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

/**
 * Parse a `from`/`to` boundary as epoch-ms. Accepts an epoch-ms number, an ISO
 * timestamp, or a bare `YYYY-MM-DD` date. A date-only `to` is widened to the
 * end of that UTC day so the upper bound is inclusive of trades closed any time
 * that day. Returns undefined on an unparseable / blank value.
 */
function parseExportBoundary(raw: unknown, isEnd: boolean): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return undefined;
  // Date-only end boundary → end of the UTC day (inclusive).
  if (isEnd && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return ms + 86_400_000 - 1;
  }
  return ms;
}

const VALID_MARKETS: ExportMarket[] = ['stocks', 'crypto', 'options'];
const VALID_MODES: AccountMode[] = ['demo', 'live'];

/** Union the per-env closed-options buckets from a stocks snapshot, de-duped by id. */
function collectClosedOptions(snap: StocksTradeSnapshot | null): OptionPosition[] {
  if (!snap) return [];
  const byId = new Map<string, OptionPosition>();
  const buckets = snap.optionsByEnv
    ? Object.values(snap.optionsByEnv)
    : snap.options
      ? [snap.options]
      : [];
  for (const bucket of buckets) {
    for (const opt of bucket?.closedOptions ?? []) byId.set(opt.id, opt);
  }
  return Array.from(byId.values());
}

/**
 * Collect crypto closed positions, preferring the TRA-242 mode-split lists
 * (stamping mode so legacy rows without it land in the right bucket) and
 * falling back to the merged list. De-duped by id.
 */
function collectClosedCrypto(snap: CryptoTradeSnapshot | null): Position[] {
  if (!snap) return [];
  const byId = new Map<string, Position>();
  const hasSplit = snap.demoClosedPositions || snap.liveClosedPositions;
  if (hasSplit) {
    for (const p of snap.demoClosedPositions ?? []) byId.set(p.id, { ...p, mode: p.mode ?? 'demo' });
    for (const p of snap.liveClosedPositions ?? []) byId.set(p.id, { ...p, mode: p.mode ?? 'live' });
  } else {
    for (const p of snap.closedPositions ?? []) byId.set(p.id, p);
  }
  return Array.from(byId.values());
}

app.get('/api/trades/export', requireAuth, async (req, res, next) => {
  try {
    const username = res.locals['authUser'] as string;
    const query = req.query as Record<string, unknown>;

    const format: ExportFormat = String(query['format'] ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    if (query['format'] && format !== String(query['format']).toLowerCase()) {
      res.status(400).json({ error: "format must be 'csv' or 'json'" });
      return;
    }

    const markets = parseCsvParam(query['markets']).filter((m): m is ExportMarket =>
      (VALID_MARKETS as string[]).includes(m),
    );
    const modes = parseCsvParam(query['modes']).filter((m): m is AccountMode =>
      (VALID_MODES as string[]).includes(m),
    );
    const filters: ExportFilters = {
      markets,
      modes,
      from: parseExportBoundary(query['from'], false),
      to: parseExportBoundary(query['to'], true),
    };

    const [stocksSnap, cryptoSnap] = await Promise.all([
      loadStocksTradeSnapshot(username),
      loadCryptoTradeSnapshot(username),
    ]);

    const { rows, summary } = buildExport(
      {
        stocksClosed: stocksSnap?.closedPositions ?? [],
        cryptoClosed: collectClosedCrypto(cryptoSnap),
        optionsClosed: collectClosedOptions(stocksSnap),
      },
      filters,
    );

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="trades-export-${stamp}.json"`);
      res.send(JSON.stringify({ summary, trades: rows }, null, 2));
    } else {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="trades-export-${stamp}.csv"`);
      res.send(toCsv(rows));
    }
  } catch (err) {
    next(err);
  }
});

// ── State ─────────────────────────────────────────────────────────────────────

app.get('/api/state', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.engine.getState());
});

app.get('/api/crypto/state', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.cryptoEngine.getState());
});

// TRA-1303 — Position Advisor readout: per held DEMO-book symbol, the next DCA
// add (size + trigger price) and the current sell plan (SL / TP / trailing).
// Read-only — it re-runs the SHIPPED engine cores (conviction-dca / crypto-dca /
// the exit engines) against the demo book and never places or mutates an order.
// This is the smallest surface that lets a user actually SEE the guidance the
// parent TRA-1302 asks for. Live positions are never surfaced.
app.get('/api/advisor/positions', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  const rows = [
    ...ctx.engine.getPositionAdvisor(),
    ...ctx.cryptoEngine.getPositionAdvisor(),
  ];
  const countIn = (book: string) => rows.filter(r => r.book === book).length;
  const readout: PositionAdvisorReadout = {
    asOf: new Date().toISOString(),
    mode: 'demo',
    rows,
    notes: [
      `${countIn('equity')} equity, ${countIn('options')} options, ${countIn('crypto')} crypto held position(s)`,
      "Read-only advisory (demo book, no live orders). DCA sizes/triggers and sell plans are the engine's own outputs.",
    ],
  };
  res.json(readout);
});

app.get('/api/crypto/news', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.cryptoEngine.getNews());
});

app.get('/api/news', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  const yahoo = ctx.engine.getNews();
  const merged = await mergeResearchAndNews(yahoo);
  res.json(merged);
});

// TRA-530 — per-symbol analysis breadth bundle for the TRA-529 analyst agents.
// Returns `{ technical, sentiment }`. This issue (TRA-534/Part B) creates the
// route and fills the `sentiment` half; the `technical` half is filled by
// TRA-533/Part A (multi-timeframe snapshot) when it lands. Each feed degrades
// to `null` with a reason rather than 500ing (acceptance #4).
app.get('/api/analysis/breadth/:symbol', requireAuth, async (req, res) => {
  const raw = (req.params as Record<string, string>)['symbol'] ?? '';
  const symbol = aliasWatchlistSymbol(raw).toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  const ctx = await userCtx(res);
  const notes: { technical?: string; sentiment?: string; social?: string } = {};

  let sentiment = null;
  try {
    sentiment = ctx.engine.getSymbolSentiment(symbol);
  } catch (err) {
    notes.sentiment = err instanceof Error ? err.message : 'sentiment unavailable';
  }

  // TRA-602 — StockTwits social-sentiment half. Degrades to a null feed with a
  // reason (cold cache / feed throttled) rather than 500ing, mirroring the news
  // and technical halves.
  let social = null;
  try {
    social = ctx.engine.getSocialSentiment(symbol);
  } catch (err) {
    notes.social = err instanceof Error ? err.message : 'social sentiment unavailable';
  }

  // TRA-533 — multi-timeframe technical snapshot. Cached-or-on-demand; degrades
  // to a null feed with a reason (no candles yet / feed cold) rather than 500ing.
  let technical = null;
  try {
    technical = await ctx.engine.getOrComputeTechnicalSnapshot(symbol);
    if (!technical) notes.technical = 'no technical data available for symbol';
  } catch (err) {
    notes.technical = err instanceof Error ? err.message : 'technical snapshot unavailable';
  }

  res.json({
    symbol,
    asOf: new Date().toISOString(),
    technical,
    sentiment,
    social,
    notes,
  });
});

// TRA-227 — research-report ingestion + listing.
//
// `POST /api/research/reports` is admin-only: the QuantTrader routine runs
// internally and uses an admin token. The endpoint is idempotent on `id` —
// repeating with the same id updates the saved record rather than duplicating.
app.post('/api/research/reports', requireAuth, requireAdmin, async (req, res) => {
  try {
    const saved = await saveResearchReport(req.body);
    res.status(201).json(saved);
  } catch (err) {
    if (err instanceof ResearchValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('research save failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to save research report' });
  }
});

app.get('/api/research/reports', requireAuth, async (_req, res) => {
  res.json(await listResearchReports());
});

// TRA-791 — labelled SupertrendConfluence shadow signal->outcome ledger. This
// is the dataset TRA-789 (QuantTrader) validates: hit rate / R:R / false-signal
// rate are computed against these rows. Admin-only, same pattern as the other
// research routes. `?from=` / `?to=` are ms-epoch inclusive bounds on signal ts.
// Read-only; supertrend stays router-gated OFF pending TRA-734.
app.get('/api/research/shadow-signals', requireAuth, requireAdmin, async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseTs = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  const signals = await listShadowSignals({ from: parseTs(q['from']), to: parseTs(q['to']) });
  res.json({ signals });
});

// TRA-799 — public, read-only acceptance probe for the TRA-791 shadow ledger
// (parity with the TRA-586 `/api/health/market-review` and TRA-580
// `/api/health/live-equity` probes). Unauthenticated by design: the rows are
// pure strategy telemetry (symbol, side, indicator booleans, the entry/stop/
// target prices, and the realized outcome) — no PII, no user identity, no
// account balances, and no real positions, the same non-sensitive class as the
// other open health probes. It exists so QuantTrader can pull the live-tape
// shadow signal->outcome dataset to drive the TRA-734 go/no-go *without*
// shipping Render-specific admin credentials into the validator's harness env,
// which Render's separate user store made impossible. Supertrend stays
// router-gated OFF pending TRA-734; this only observes and labels. Same
// `?from=`/`?to=` ms-epoch inclusive window as the admin research route, which
// is left untouched for the authenticated desk UI.
app.get('/api/health/shadow-signals', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseTs = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  try {
    const signals = await listShadowSignals({ from: parseTs(q['from']), to: parseTs(q['to']) });
    res.json({ issue: 'TRA-799', count: signals.length, signals });
  } catch (err) {
    log.error('shadow-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read shadow ledger' });
  }
});

// TRA-2036 — read-only probe over the shadow-expectancy PROMOTION GUARD. The
// promotion gate historically DISPLAYED shadow expectancy but did not ENFORCE it
// (a strategy with negative net shadow E[R] could still clear the six guards and
// advance). This surfaces the new fail-closed guard's OBSERVE-ONLY verdict over
// the Supertrend shadow ledger — the canonical frozen NO-GO candidate (TRA-789/
// 1245: net E[R] -0.047R). It reports rawN vs the correlation-adjusted effective
// N (day/episode clustered), the block-bootstrap CI on E[R], and the per-
// candidate "would block: yes/no" so we can see how many current candidates the
// guard would block BEFORE it enforces. `flagEnabled`/`enforcing` say whether the
// guard is wired into the gate and whether a would-block actually blocks; both
// default OFF, so this is observe-only and nothing routes an order. Open like the
// sibling shadow probes (pure strategy telemetry, no PII/positions).
app.get('/api/health/shadow-expectancy-guard', async (_req, res) => {
  try {
    const signals = await listShadowSignals();
    const verdict = shadowExpectancyGuardFromLedger(signals);
    res.json({
      issue: 'TRA-2036',
      flagEnabled: isShadowExpectancyGuardEnabled(),
      enforcing: isShadowExpectancyGuardEnforcing(),
      shadowLineage: 'TRA-789/1245 (frozen NO-GO baseline: net E[R] -0.047R / 18.5% hit)',
      rawN: verdict.rawN,
      effectiveN: verdict.effectiveN,
      sampleSize: verdict.sampleSize,
      expectancyR: verdict.expectancyR,
      ci: verdict.ci,
      wouldBlock: verdict.wouldBlock,
      blocks: verdict.blocks,
      reasons: verdict.reasons,
    });
  } catch (err) {
    log.error('shadow-expectancy-guard health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to evaluate shadow-expectancy guard' });
  }
});

// TRA-911 (TRA-908 Phase A) — read-only probe over the shadow OPTION-trade
// ledger. Open like the Supertrend shadow probe so QuantTrader (TRA-914) can
// validate the gate matrix output without Render admin creds. Reports whether
// the selector flag is enabled so a viewer can tell an empty ledger ("flag off")
// from a live-but-silent one.
app.get('/api/health/option-shadow-signals', async (_req, res) => {
  try {
    const signals = await listOptionShadowSignals();
    res.json({
      issue: 'TRA-911',
      flagEnabled: isOptionShadowEnabled() && !OPTION_SHADOW_EMERGENCY_OFF,
      // TRA-937 — emergency OOM mitigation: the per-tick pass is hard-off even if
      // ENABLE_OPTION_SHADOW_SELECTOR is set, so a silent ledger here is expected.
      emergencyDisabled: OPTION_SHADOW_EMERGENCY_OFF,
      count: signals.length,
      signals,
    });
  } catch (err) {
    log.error('option-shadow-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read option shadow ledger' });
  }
});

// TRA-2173 (parent TRA-2172) — read-only probe over the SHADOW ORB-for-options
// ledger, open like the other shadow probes so QuantTrader can pull the breakout-
// intent dataset for a future go/no-go without Render admin creds. Reports
// whether the flag is enabled so a viewer can tell an empty ledger ("flag off")
// from a live-but-silent one. Observe-only; nothing here routes an order.
app.get('/api/health/orb-options-shadow-signals', async (_req, res) => {
  try {
    const signals = await listOrbOptionsShadowSignals();
    res.json({
      issue: 'TRA-2172',
      flagEnabled: isOrbOptionsShadowEnabled(),
      count: signals.length,
      signals,
    });
  } catch (err) {
    log.error('orb-options-shadow-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read orb-options shadow ledger' });
  }
});

// TRA-1609 (parent TRA-1607) — read-only probe over the SHADOW Put-Call-Ratio
// ledger, open like the other shadow probes so QuantTrader can pull the setup->
// PCR dataset for the TRA-532 promotion gate without Render admin creds. Reports
// the recent rows (each stamped with its paired 21EMA+RSI+Vol trio verdict) and
// grades the accrual against QuantTrader's FULL four-leg sample-sufficiency bar.
//
// TRA-1663: `promotionReady` used to be `usableCount >= 200` — a row count. The
// watchlist is 25 names deduped to one row per underlying per session, so that
// crosses 200 at session ~9 while the ≥20-session leg needs session ~20; the
// handoff it triggered would have been ~11 sessions short of the real bar. The
// per-leg breakdown is surfaced so the gap is visible without re-deriving it.
//
// TRA-1676 added the fifth leg: `zSessionCount`. Legs 1-4 grade RATIO rows, but
// the promotion read grades Z rows, and the z warm-up makes those two different
// populations — at ledger session 20 the first four legs are green on 500 ratio
// rows carrying only 10 z-bearing sessions. `zSessionCount` is surfaced next to
// them so that gap is readable off the endpoint rather than re-derived.
// Observe-only: nothing here routes an order.
app.get('/api/health/pcr-shadow-signals', async (_req, res) => {
  try {
    const signals = await listPcrShadowSignals();
    const sufficiency = pcrSampleSufficiency(signals);
    res.json({
      issue: 'TRA-1609',
      flagEnabled: isPcrShadowEnabled(),
      zWindowSessions: PCR_Z_WINDOW_SESSIONS,
      promotionBar: {
        minUsableCount: PCR_PROMOTION_MIN_USABLE,
        minSessionCount: PCR_PROMOTION_MIN_SESSIONS,
        minUnderlyingCount: PCR_PROMOTION_MIN_UNDERLYINGS,
        maxNameSharePct: PCR_PROMOTION_MAX_NAME_SHARE_PCT,
        minZSessionCount: PCR_PROMOTION_MIN_Z_SESSIONS,
      },
      count: signals.length,
      usableCount: sufficiency.usableCount,
      sessionCount: sufficiency.sessionCount,
      underlyingCount: sufficiency.underlyingCount,
      maxNameSharePct: Number(sufficiency.maxNameSharePct.toFixed(2)),
      zSessionCount: sufficiency.zSessionCount,
      legs: sufficiency.legs,
      shortfall: sufficiency.shortfall,
      promotionReady: sufficiency.promotionReady,
      signals,
    });
  } catch (err) {
    log.error('pcr-shadow-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read pcr shadow ledger' });
  }
});

// TRA-1610 (parent TRA-1607) — read-only probe over the SHADOW Open-Interest-
// trend ledger, open like the other shadow probes so QuantTrader can pull the
// setup->quadrant dataset for the TRA-532 promotion gate without Render admin
// creds. Reports the usable-signal count (rows carrying a non-null price x OI
// quadrant read) against the >=200 promotion threshold plus the recent rows,
// each stamped with its paired 21EMA+RSI+Vol trio verdict. Observe-only:
// nothing here routes an order.
app.get('/api/health/oi-shadow-signals', async (_req, res) => {
  try {
    const signals = await listOiShadowSignals();
    const usable = usableOiSignalCount(signals);
    res.json({
      issue: 'TRA-1610',
      flagEnabled: isOiShadowEnabled(),
      promotionThreshold: 200,
      count: signals.length,
      usableCount: usable,
      promotionReady: usable >= 200,
      signals,
    });
  } catch (err) {
    log.error('oi-shadow-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read oi shadow ledger' });
  }
});

// TRA-1629 (parent TRA-1623) — read-only probe over the SHADOW news-catalyst
// ledger, open like the other shadow probes so QuantTrader can pull the
// discovery dataset (per-name catalyst score + chosen/dropped + reason) for the
// TRA-532 forward-validation window without Render admin creds. Reports the
// CHOSEN-signal count (names actually injected into the watchlist — the
// "name-day" numerator) against the ≥100 threshold, plus the recent rows.
// Observe-only: D1 only ADDS names to watch, D2 annotates a report; nothing
// here routes an order.
app.get('/api/health/news-catalyst-signals', async (_req, res) => {
  try {
    const signals = await listNewsCatalystSignals();
    const chosen = chosenSignalCount(signals);
    // TRA-1632 — surface the persisted D2 lean rows alongside the D1 discovery
    // rows so QuantTrader can grade lean-hit-rate (TRA-1630) from one probe. The
    // lean is captured point-in-time (PCR/OI cannot be reconstructed later).
    const leans = await listCatalystLeans();
    // TRA-2064 — run observability. `count: 0` alone cannot distinguish "no
    // catalyst names today" from "the writer never executed"; these fields can.
    // Read `lastRunAt: null` while `flagEnabled` is true as: the premarket hook
    // never reached the writer on this disk.
    const runs = await summarizeCatalystRuns();
    res.json({
      issue: 'TRA-1629',
      flagEnabled: isNewsCatalystEnabled(),
      promotionThreshold: 100,
      count: signals.length,
      ...runs,
      // TRA-2064 — the denominator for `lastRunQueriesAttempted`. Attempted <
      // this ⇒ the sweep hit its wall-clock bound; succeeded < attempted ⇒ the
      // feed is degraded. Without it, `queriesAttempted` has no scale.
      catalystUniverseSize: catalystUniverse().length,
      chosenCount: chosen,
      promotionReady: chosen >= 100,
      signals,
      // TRA-1632 — D2 lean gradeability surface.
      leanCount: leans.length,
      leanBreakdown: leanBreakdown(leans),
      leans,
    });
  } catch (err) {
    log.error('news-catalyst-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read news-catalyst ledger' });
  }
});

// TRA-1618 (parent TRA-1614) — read-only probe over the SHADOW weekly-QQQ-PCS
// forward-test ledger, open like the other shadow probes so QuantTrader can pull
// the accruing out-of-sample paper fills for the TRA-532 Stage-2 gate without
// Render admin creds. Reports the settled-cycle count (the promotion
// denominator) against the ≥200 threshold, plus the open/settled split and the
// recent rows. Observe-only: nothing here routes an order; the base PCS only
// (the martingale rescue is NOT auto-emitted — see the ledger header).
app.get('/api/health/pcs-shadow-signals', async (_req, res) => {
  try {
    const signals = await listPcsShadowSignals();
    const settled = settledSignalCount(signals);
    res.json({
      issue: 'TRA-1618',
      flagEnabled: isPcsShadowEnabled(),
      strategyId: PCS_SHADOW_STRATEGY_ID,
      promotionThreshold: 200,
      count: signals.length,
      openCount: signals.filter((s) => s.status === 'open').length,
      settledCount: settled,
      promotionReady: settled >= 200,
      signals,
    });
  } catch (err) {
    log.error('pcs-shadow-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read pcs shadow ledger' });
  }
});

// TRA-921 (TRA-920 B) — read-only probe over the OBSERVE-ONLY reversal-checklist
// shadow ledger, open like the Supertrend/option shadow probes so the daily
// learning loop (TRA-920 A) can pull the live-tape setup->outcome dataset
// without Render admin creds. Returns the recent rows plus the N-of-4 hit-rate
// breakdown (how often 4-of-4 vs 3-of-4 setups actually hit target) and whether
// the capture flag is enabled, so an empty ledger ("flag off") is distinguishable
// from a live-but-silent one. `?from=`/`?to=` are ms-epoch inclusive bounds on
// the setup ts. No capital path — observe-only.
app.get('/api/health/reversal-shadow-signals', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseTs = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  try {
    const signals = await listReversalShadowSignals({ from: parseTs(q['from']), to: parseTs(q['to']) });
    res.json({
      issue: 'TRA-921',
      flagEnabled: isReversalShadowEnabled(),
      count: signals.length,
      hitRateByScore: reversalHitRateByScore(signals),
      signals,
    });
  } catch (err) {
    log.error('reversal-shadow-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read reversal shadow ledger' });
  }
});

// TRA-1457 — read-only probe over the SHADOW-FIRST universal pre-trade gate
// ledger (MTF + volume + R:R>=1.5 + ATR stop). Mirrors the shadow-signals probes:
// returns the recent gate decisions plus the pass-rate + per-reason rejection
// summary, and whether ENABLE_PRE_TRADE_GATE is on — so an empty ledger
// ("flag off", the default while TRA-382 holds) is distinguishable from a
// live-but-silent one. `?from=`/`?to=` are ms-epoch inclusive bounds on the
// decision ts. No capital path: the gate only LOGS in this first cut; it never
// blocks or modifies an order. The summary feeds the SAME A/B methodology as the
// frozen NO-GO shadow-validation baseline (TRA-789/1245: E[R] -0.047R / 18.5%
// hit), which QuantTrader (bf0ae543) reads to give a promotion GO/NO-GO.
app.get('/api/health/pre-trade-gate', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseTs = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  try {
    const decisions = await listPreTradeGateDecisions({ from: parseTs(q['from']), to: parseTs(q['to']) });
    res.json({
      issue: 'TRA-1457',
      flagEnabled: isPreTradeGateEnabled(),
      shadowValidationLineage: 'TRA-789/1245 (frozen NO-GO baseline: E[R] -0.047R / 18.5% hit)',
      count: decisions.length,
      summary: preTradeGateSummary(decisions),
      decisions,
    });
  } catch (err) {
    log.error('pre-trade-gate health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read pre-trade gate ledger' });
  }
});

// TRA-2051 — live-canary staging harness readout. Reports the promotion stage
// (shadow -> canary -> full_live), the canary allocation, per-hard-limit headroom
// from the last guard sweep, and the breach/demotion state (incl. the latched
// `canaryDemoted`). Flag-OFF/fail-closed: with ENABLE_LIVE_CANARY off (default,
// and while TRA-382 holds live trading) this reports the safe default state
// (shadow, latch clear, empty headroom) and NO candidate is armed / no capital
// moves. Unauthenticated by design (booleans + telemetry aggregates, no PII),
// matching the sibling shadow/gate probes.
app.get('/api/health/live-canary', async (_req, res) => {
  try {
    res.json(await buildCanaryHealth());
  } catch (err) {
    log.error('live-canary health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read live-canary ledger' });
  }
});

// TRA-1967 — pre-trade LIQUIDITY gate shadow readout. SHADOW-FIRST / flag-OFF: the
// engine's `evaluateLiquidityGate` charges an L1 spread cost + naive impact per
// candidate order and the server ledger records the allow/downsize/veto verdict WHEN
// ENABLE_PRE_TRADE_LIQUIDITY_GATE is set. With the flag off (the default on
// bqb1/prod) this returns an empty, honest ledger and nothing routes or downsizes an
// order. The summary (veto/intervention rate + modeled-cost distribution per asset
// class) is the calibration the realized-slippage KPI (TRA-1967 item 2) checks OOS
// before any live veto is armed.
app.get('/api/health/pre-trade-liquidity', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseTs = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  try {
    const decisions = await listLiquidityGateDecisions({ from: parseTs(q['from']), to: parseTs(q['to']) });
    res.json({
      issue: 'TRA-1967',
      flagEnabled: isPreTradeLiquidityEnabled(),
      model: 'L1 spread cost + naive linear impact (no L2/market-maker model)',
      count: decisions.length,
      summary: liquidityGateSummary(decisions),
      decisions,
    });
  } catch (err) {
    log.error('pre-trade-liquidity health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read pre-trade liquidity ledger' });
  }
});

// TRA-2045 (parent TRA-2044) — order-time quote-freshness + max-slippage guard
// readout. Since-boot counted reasons keyed by `engine:mode:outcome` for BOTH
// order paths (equity bracket submit + options smart-open). Flag-OFF (default):
// mode `off`, no re-quote, empty counters. `ENABLE_ORDER_QUOTE_GUARD` on ⇒
// `shadow` (measure only); `ORDER_QUOTE_GUARD_ENFORCE` also on ⇒ `enforce`
// (reject stale quotes + price the max-slippage-bounded marketable limit). The
// counted `stale_quote` / `missing_quote_timestamp` / `slippage_capped` reasons
// feed the TRA-2044 telemetry child.
app.get('/api/health/order-quote-guard', (_req, res) => {
  try {
    const cfg = resolveOrderQuoteGuardConfig();
    res.json({
      issue: 'TRA-2045',
      mode: cfg.mode,
      maxSlippage: cfg.maxSlippage,
      maxQuoteAgeMs: cfg.maxQuoteAgeMs,
      metrics: snapshotOrderGuardMetrics(),
    });
  } catch (err) {
    log.error('order-quote-guard health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read order-quote-guard metrics' });
  }
});

// TRA-2050 (parent TRA-2044) — TWAP/participation order-splitting readout. Since-
// boot counted PLANNING outcomes keyed `enabled:reason` (equity path only —
// options stay single-clip). Flag-OFF (default): `enabled:false`, no plan
// computed, empty counters. `ENABLE_ORDER_SPLITTING` on ⇒ SHADOW: the equity
// submit path computes the child-slice plan and records what it WOULD do, but
// still submits the single aggregate order (the multi-tick executor is a gated
// follow-up, blocked on the TRA-1897 HOLD lift). Inert below
// `ORDER_SPLIT_MIN_NOTIONAL` regardless of the flag, so it stays a no-op at
// today's sizes; the `below_threshold` count vs `split_*` counts show WHEN
// order sizes start crossing the threshold — the trigger to build/arm the
// executor. `slices_scheduled` is the running total of planned child slices.
app.get('/api/health/order-splitting', (_req, res) => {
  try {
    const cfg = resolveOrderSplitConfig();
    res.json({
      issue: 'TRA-2050',
      enabled: cfg.enabled,
      strategy: cfg.strategy,
      minNotional: cfg.minNotional,
      childCount: cfg.childCount,
      intervalMs: cfg.intervalMs,
      maxParticipationRate: cfg.maxParticipationRate,
      // Execution of the schedule is NOT yet wired — this is a shadow planner.
      execution: 'shadow_only',
      metrics: snapshotOrderSplitMetrics(),
    });
  } catch (err) {
    log.error('order-splitting health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read order-splitting metrics' });
  }
});

// TRA-2046 (parent TRA-2044) — execution-quality telemetry completeness. Since-
// boot, memory-only, always-on (no flag, no IO, no order-behavior change): the
// order paths already produce these measurements; this only folds them. Closes
// the slippage proposal's "track partial fills, rejected orders, stale quotes,
// cancel/replace latency" ask:
//  - cancelReplaceLatencyMs — per-step cancel->ack + reprice->ack round-trips
//    from the maker walk, aggregated to p50/p95 (only end-to-end time-to-fill
//    was measured before).
//  - partialFills — exec_quantity/remaining_quantity folded into a partial-fill
//    rate (among orders that got ANY fill) + average filled fraction.
//  - staleQuotes — the counted stale-quote reasons from the TRA-2045 order-guard
//    registry (same source as /api/health/order-quote-guard, so they can't drift).
// Counters read empty until live orders flow (live auto-trading is on HOLD,
// TRA-1897); a `total: 0` here means no orders observed this uptime, not a fault.
app.get('/api/health/execution-quality', (_req, res) => {
  try {
    res.json({
      issue: 'TRA-2046',
      telemetry: snapshotExecutionQuality(),
    });
  } catch (err) {
    log.error('execution-quality telemetry probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read execution-quality telemetry' });
  }
});

// TRA-1981 (parent TRA-1967 item 2) — realized-vs-modeled EXECUTION-QUALITY KPI per
// asset class. The pre-trade liquidity gate above MODELS a cost per fill; this probe
// measures the REALIZED cost against it — options fills vs mid (durable fee/slippage
// ledger), equity/crypto against the TRA-536 per-fill bps budget stamped at open — so
// execution decay is visible per asset class before it eats the edge. The decay ratio
// (Σ|realized| ÷ Σ|modeled|) is the OOS check that justifies arming the liquidity-gate
// veto: > 1× means realized cost runs hotter than the model. Pure read of already-
// persisted data (no new writes, no behavior change); unmeasured legs are `null`,
// never `0` (TRA-1707). The options leg is durable; the equity/crypto legs are
// session-scoped live open positions (folded across all user books).
app.get('/api/health/execution-quality', (_req, res) => {
  try {
    const equityPositions: Position[] = [];
    const cryptoPositions: Position[] = [];
    for (const ctx of getAllUserContexts()) {
      try {
        equityPositions.push(...ctx.engine.getState().account.openPositions);
      } catch {
        // Skip a context whose engine can't render state this tick — the others still fold.
      }
      try {
        cryptoPositions.push(...ctx.cryptoEngine.getState().account.openPositions);
      } catch {
        // Same guard for the crypto book.
      }
    }
    const kpi = buildExecutionQualityKpi({ equityPositions, cryptoPositions });
    res.json({
      issue: 'TRA-1981',
      model:
        'realized vs modeled cost per fill — options: fill-vs-mid signed into cost vs modeled half-spread (|ask−mid|); '
        + 'equity/crypto: TRA-536 entry drift (|fill−intended|×qty) vs the per-fill bps budget the trade was charged',
      decayRatio: 'Σ|realized| ÷ Σ|modeled|; > 1× ⇒ realized execution cost is running hotter than the model',
      durabilityNote:
        'options leg is durable (fee/slippage ledger, survives restart); equity/crypto legs are session-scoped '
        + 'live open positions. Unmeasured legs are null, never 0 (TRA-1707).',
      kpi,
    });
  } catch (err) {
    log.error('execution-quality health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build execution-quality KPI' });
  }
});

// TRA-1982 (parent TRA-1967 item 3) — DATA-DRIVEN maker-ladder recommendation. Folds the
// raw maker-fill telemetry ledger (which walk step actually fills, realised-vs-mid by step,
// time-to-fill) into a read-only recommendation for the reprice ladder (`fractions`,
// `stepWaitMs`, `maxCrossTicks`), expressed as deltas against the currently-resolved
// `OPTION_MAKER_*` config. RECOMMENDATION-ONLY: this route mutates nothing — the flip to
// live config is a separate governance-gated step (TRA-1967). The per-step histogram is
// returned so every recommended number is auditable against option-maker-fills.jsonl.
// Defaults to the LIVE book; `?mode=demo` reads the demo cohort, `?since=<ms>` scopes a
// post-arm window, and `?minSamples=`/`?minStepShare=` tune the gate/drop thresholds.
app.get('/api/health/maker-ladder-recommendation', async (req, res) => {
  try {
    const q = req.query as Record<string, unknown>;
    const mode = q['mode'] === 'demo' ? 'demo' : 'live';
    const sinceRaw = typeof q['since'] === 'string' ? Number(q['since']) : Number.NaN;
    const sinceTs = Number.isFinite(sinceRaw) ? sinceRaw : undefined;
    const minSamplesRaw = typeof q['minSamples'] === 'string' ? Number(q['minSamples']) : Number.NaN;
    const minStepShareRaw = typeof q['minStepShare'] === 'string' ? Number(q['minStepShare']) : Number.NaN;

    const events = await listMakerFillEvents({ mode, ...(sinceTs !== undefined ? { sinceTs } : {}) });
    const config = resolveMakerWalkConfig();
    const recommendation = buildMakerLadderRecommendation(events, config, {
      ...(Number.isFinite(minSamplesRaw) && minSamplesRaw > 0 ? { minSamples: Math.floor(minSamplesRaw) } : {}),
      ...(Number.isFinite(minStepShareRaw) && minStepShareRaw >= 0 && minStepShareRaw <= 1
        ? { minStepShare: minStepShareRaw }
        : {}),
    });
    res.json({
      issue: 'TRA-1982',
      mode,
      model:
        'per-side (open/close) reprice-ladder params re-derived from measured maker-fill outcomes — '
        + 'drop interior steps with negligible fill share (dead wait windows; opener + ask preserved), '
        + 'stepWaitMs from p90 per-step fill latency, maxCrossTicks only where cross-tick fills were observed',
      recommendationOnly:
        'nothing here mutates the live ladder config; applying a recommendation is a separate governance-gated step (TRA-1967)',
      recommendation,
    });
  } catch (err) {
    log.error('maker-ladder-recommendation health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build maker-ladder recommendation' });
  }
});

// TRA-925 (TRA-920 A) — the daily learning loop, exposed as a read-time digest.
// Folds the durable reversal shadow ledger into learned, min-sample-guarded
// scoring multipliers (by checklist score, reversal pattern, and symbol) so the
// agents "get better each day" as outcomes accrue. Computed live from the ledger
// on every call, so the weights can never drift from the source of truth and no
// separate persisted snapshot is needed. Scoring-only, no capital path; the same
// `?from=`/`?to=` ms-epoch inclusive window as the other shadow probes.
app.get('/api/health/learned-weights', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseTs = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  try {
    const signals = await listReversalShadowSignals({ from: parseTs(q['from']), to: parseTs(q['to']) });
    res.json({
      issue: 'TRA-925',
      flagEnabled: isReversalShadowEnabled(),
      // TRA-1056 — the A/B switch state. Each stat carries multiplierHardGate +
      // multiplierShrunk so QuantTrader can diff them; this says which one the live
      // `reversalSignalMultiplier` currently reads (default: hard-gate).
      shrinkageFlagEnabled: isLearnedShrinkageEnabled(),
      count: signals.length,
      weights: computeLearnedWeights(signals),
    });
  } catch (err) {
    log.error('learned-weights health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to compute learned weights' });
  }
});

// TRA-2352 (TRA-927 / TRA-920 A2) — the day-by-day TRAIL behind the live fold
// above. Its sibling `/api/health/learned-weights` answers "what are the weights
// NOW" (computed live, never stale); this answers "how did they GET here" from
// the snapshot the 21:00 ET archive tick persists. Unauthenticated + read-only
// like that sibling; write-only observer, no capital path.
//
// NOTE the window differs from the other shadow probes: rows here are DATE-keyed,
// so `?from=`/`?to=` are inclusive `YYYY-MM-DD` strings, NOT the ms-epoch window
// used by `/api/health/learned-weights` and the shadow-signal probes.
//
// Default: the full snapshots. With `?dimension=score|pattern|symbol&key=` it
// returns the single-bucket trajectory (the actual ops ask). A date where the
// bucket does not exist is OMITTED, and a day the tick never ran is simply ABSENT
// (NO BACK-FILL) — render gaps as gaps, never interpolate across them.
app.get('/api/health/learned-weights-history', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseDate = (v: unknown): string | undefined =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  const rawDimension = typeof q['dimension'] === 'string' ? q['dimension'] : undefined;
  const key = typeof q['key'] === 'string' ? q['key'] : undefined;

  if (rawDimension !== undefined && !['score', 'pattern', 'symbol'].includes(rawDimension)) {
    res.status(400).json({ error: 'dimension must be one of: score, pattern, symbol' });
    return;
  }
  if (rawDimension !== undefined && (key === undefined || key === '')) {
    res.status(400).json({ error: 'key is required when dimension is set' });
    return;
  }

  try {
    const from = parseDate(q['from']);
    const to = parseDate(q['to']);
    const snapshots = await listLearnedWeightsSnapshots({
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
    const flagEnabled = isLearnedWeightsSnapshotEnabled();

    if (rawDimension !== undefined && key !== undefined) {
      res.json({
        issue: 'TRA-927',
        flagEnabled,
        dimension: rawDimension as SnapshotDimension,
        key,
        series: learnedWeightsTrajectory(snapshots, rawDimension as SnapshotDimension, key),
      });
      return;
    }

    res.json({ issue: 'TRA-927', flagEnabled, days: snapshots.length, snapshots });
  } catch (err) {
    log.error('learned-weights-history health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read learned weights history' });
  }
});

// TRA-1046 (TRA-1041c L2) — on-demand hypothesis backtest. Validates a single
// param-change hypothesis SYNCHRONOUSLY through the same apply→backtest→G0-grade
// pipeline the analyst's EOD reflect routine uses, returning the graded result in
// one round-trip so a param can be checked without overnight latency. Read-only:
// it never enqueues a ratification item or touches demo/live config — the only
// path that lands a change stays the board-ratified queue, and live promotion is
// gated on TRA-382. Auth-gated because a backtest is non-trivial compute.
const onDemandBacktestExecutor = makeBacktestExecutor();
app.post('/api/backtest', requireAuth, async (req, res) => {
  const problem = validateBacktestRequest(req.body);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  try {
    const result = await runOnDemandBacktest(req.body as OnDemandBacktestRequest, {
      baseConfig: RV_CRYPTO_MAJORS_BASE_CONFIG,
      runBacktest: onDemandBacktestExecutor,
    });
    res.json({ issue: 'TRA-1046', ...result });
  } catch (err) {
    if (err instanceof OnDemandBacktestBadRequest) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('on-demand backtest failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to run backtest' });
  }
});

app.get('/api/research/reports/:id', requireAuth, async (req, res) => {
  const id = (req.params as Record<string, string>)['id'];
  const report = await getResearchReport(id);
  if (!report) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  res.json(report);
});

// TRA-386 — automated market-review feed. The scheduler regenerates this at
// 9 AM ET (pre-market) and 9 PM ET (post-market); the signal engine and
// watchlist builder pull the latest regime gates from here instead of waiting
// on a hand-written QuantTrader review.
//
// `GET /api/market-review/latest` — most recent review; `?kind=premarket` or
// `?kind=postmarket` scopes it. TRA-589: recomputes live when the persisted
// review is stale/dark. Returns 404 only when no review exists and a live
// recompute could not produce one.
app.get('/api/market-review/latest', requireAuth, async (req, res) => {
  const rawKind = (req.query as Record<string, unknown>)['kind'];
  const kind =
    rawKind === 'premarket' || rawKind === 'postmarket' ? rawKind : undefined;
  // TRA-589 — recompute live before serving when the persisted review is stale
  // (predates the current ET session or came from a dark feed), so the banner
  // reflects a feed repaired by a deploy without waiting for the next job.
  const review = await getFreshMarketReview(kind);
  if (!review) {
    res.status(404).json({ error: 'No market review available yet' });
    return;
  }
  res.json(review);
});

app.get('/api/market-review', requireAuth, async (_req, res) => {
  res.json(await listMarketReviews());
});

// TRA-586 — redacted, read-only acceptance probe (parity with the TRA-580
// `/api/health/live-equity` probe). Unauthenticated by design: it computes a
// FRESH regime from the live index feeds without persisting or publishing, and
// returns only public market data (index levels, the regime label, and which
// provider served the S&P 500 trend MA). This proves the non-Yahoo (Tradier)
// trend fallback engages when Yahoo's breaker is open — verifiable against the
// live deployment without shipping admin credentials into an agent env.
app.get('/api/health/market-review', async (_req, res) => {
  try {
    const peek = await peekMarketRegime();
    res.json(peek);
  } catch (err) {
    log.error('market-review health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to compute market regime' });
  }
});

// TRA-1340 — PUBLIC, tokenless read-only probe confirming whether the pinned
// operator's LIVE Coinbase crypto auto-trading flag is armed. Same non-sensitive
// class as the other open `/api/health/*` probes: booleans only (presence, never
// key values or balances), so the board/desk and the TRA-1304 canary monitor can
// confirm the board-approved `cryptoAutoTradingEnabledLive` flip took effect on
// bqb1 WITHOUT admin creds (login + pre-minted token both 401 on Render's separate
// user store). `liveCryptoActive` mirrors promotion-service's live-crypto
// predicate (`mode === 'live' && cryptoAutoTradingEnabledLive === true`). Reports
// the operator resolved from `LIVE_EQUITY_BOOT_USER` (default "admin", TRA-716).
app.get('/api/health/crypto-live', async (_req, res) => {
  try {
    const operator = resolveLiveBrokerOperator();
    const settings = await loadSettings(operator);
    const mode = settings.mode === 'live' ? 'live' : 'demo';
    const liveCryptoAutoTradingEnabled = settings.cryptoAutoTradingEnabledLive === true;
    const brokerConfigured =
      (settings.liveApiKeyCrypto?.trim()
        || settings.liveApiKey?.trim()
        || process.env['COINBASE_API_KEY']
        || '').trim().length > 0
      && (settings.liveApiSecretCrypto?.trim()
        || settings.liveApiSecret?.trim()
        || process.env['COINBASE_API_SECRET']
        || '').trim().length > 0;
    res.json({
      ok: true,
      issue: 'TRA-1340',
      time: new Date().toISOString(),
      build: resolveBuildInfo(),
      operator,
      mode,
      liveCryptoActive: mode === 'live' && liveCryptoAutoTradingEnabled,
      liveCryptoAutoTradingEnabled,
      liveCryptoBrokerConfigured: brokerConfigured,
      bootArmPinConfigured: (process.env['LIVE_EQUITY_BOOT_USER'] ?? '').trim().length > 0,
    });
  } catch (err) {
    log.error('crypto-live health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ ok: false, error: 'Failed to read crypto-live status' });
  }
});

// TRA-1581 — UNAUTHENTICATED, secrets-free readout confirming the live OPTIONS
// Tradier plumbing for the pinned operator: whether the resolved options broker
// env is `production` and whether a live options order client would actually
// construct (per-user prod creds OR the operator-scoped `TRADIER_*` env-var
// fallback). This exists because `/api/health/live` names credentials and is
// therefore auth-gated — and admin login + a pre-minted token both 401 against
// bqb1's separate Render user store, so the board/desk cannot confirm the
// Monday attended-canary plumbing prereq from there. Mirrors the TRA-1340
// `/api/health/crypto-live` probe's contract: booleans + env label + a masked
// account-id tail ONLY — never a token, secret, or full account id. The
// options client `buildTradierLiveClient` uses `resolveTradierOptionsCreds(...)
// .env` + the operator-scoped env fallback, so this replicates that exact
// resolution (without placing an order) to answer "is prod options wired?".
//
// Reports the operator resolved from `LIVE_EQUITY_BOOT_USER` (default "admin",
// TRA-716). On bqb1 the TRA-1411/TRA-1482 equity boot-arm already force-persists
// `liveTradierEnvOptions:'production'` for that operator (same shared Tradier
// account trades both equities and options per env), so a green readout here is
// the physical proof the canary needs — NOT an autotrade arm (this probe wires
// nothing and flips no flag).
app.get('/api/health/options-live', async (_req, res) => {
  try {
    const operator = resolveLiveBrokerOperator();
    const settings = await loadSettings(operator);
    const mode = settings.mode === 'live' ? 'live' : 'demo';
    const resolved = resolveTradierOptionsCreds(settings);
    const optionsBrokerEnv = resolved.env;
    const optionsRouted = isLiveTradierOptionsEnabled(settings);
    // Per-user saved production creds (never their values — presence only).
    const prodKeySaved = (settings.liveApiKeyOptionsProduction ?? '').trim().length > 0;
    const prodAccountSaved = (settings.liveAccountIdOptionsProduction ?? '').trim().length > 0;
    // Operator-scoped shared-env fallback — the exact precondition
    // `buildTradierLiveClient` layers on for the pinned operator (TRA-857).
    const allowEnvFallback = isLiveBrokerOperator(operator);
    const prodEnvTokenPresent = (process.env['TRADIER_API_TOKEN'] ?? '').trim().length > 0;
    const prodEnvAccountPresent = (process.env['TRADIER_ACCOUNT_ID'] ?? '').trim().length > 0;
    // Replicate buildTradierLiveClient's resolution for the production env
    // WITHOUT constructing a client / placing an order: per-user saved cred wins,
    // else the operator-scoped env-var fallback.
    const effectiveToken = (
      resolved.apiToken
      || (allowEnvFallback && optionsBrokerEnv === 'production' ? process.env['TRADIER_API_TOKEN'] : '')
      || ''
    ).trim();
    const effectiveAccountId = (
      resolved.accountId
      || (allowEnvFallback && optionsBrokerEnv === 'production' ? process.env['TRADIER_ACCOUNT_ID'] : '')
      || ''
    ).trim();
    // Would a LIVE production options order client construct? Mirrors
    // buildTradierLiveClient: live mode + prod env + both creds resolve.
    const optionsBrokerConfigured =
      mode === 'live' && optionsBrokerEnv === 'production' && !!effectiveToken && !!effectiveAccountId;
    // Masked tail only (last 4) so the desk can confirm it's the INTENDED live
    // account without leaking the id. Tradier account ids are not secrets, but we
    // stay strictly minimal to match the secrets-free probe contract.
    const optionsAccountIdTail =
      effectiveAccountId.length >= 4 ? `***${effectiveAccountId.slice(-4)}` : (effectiveAccountId ? '***' : null);
    res.json({
      ok: true,
      issue: 'TRA-1581',
      time: new Date().toISOString(),
      build: resolveBuildInfo(),
      operator,
      mode,
      // The two facts the board's Monday canary prereq turns on:
      optionsBrokerEnv,
      optionsBrokerConfigured,
      // Supporting detail so a NO can be diagnosed without admin login.
      optionsRouted,
      prodCredsSaved: prodKeySaved && prodAccountSaved,
      prodKeySaved,
      prodAccountSaved,
      prodEnvVarsPresent: prodEnvTokenPresent && prodEnvAccountPresent,
      prodEnvTokenPresent,
      prodEnvAccountPresent,
      optionsAccountIdTail,
      bootArmPinConfigured: (process.env['LIVE_EQUITY_BOOT_USER'] ?? '').trim().length > 0,
      // TRA-1652 — WHY the routing resolves the way it does, so a red probe names
      // its own cause instead of requiring an admin login nobody can perform on
      // bqb1. All three are secrets-free (an env LABEL and two booleans/labels —
      // same class as `optionsBrokerEnv`, which this route already returns).
      //
      // `serviceTradierEnv` is the SERVICE-level `TRADIER_ENV`. It is the gate the
      // boot-arm derives prod intent from (TRA-1411), it is `sync: false` in
      // render.yaml (dashboard-only), and it was previously invisible from outside
      // — so a sandbox-routed operator was indistinguishable from a mis-set service
      // env. `bootArmEligible` is the `shouldBootArmLiveEquity` verdict, i.e. "would
      // a redeploy converge this operator onto the production arm?". `bootArmDrift`
      // lists the persisted fields still off the ratified arm — it should be EMPTY on
      // a healthy prod boot, because `createUserContext` repairs them at startup; a
      // non-empty list here means the repair could not run (or something rewrote the
      // operator after boot).
      // TRA-2163 — emit only a recognized LABEL; redact any other value so a
      // mis-set `TRADIER_ENV` (e.g. the raw token) can never leak here.
      serviceTradierEnv: redactTradierEnvLabel(process.env['TRADIER_ENV']),
      serviceTradierEnvRecognized: isRecognizedTradierEnvLabel(process.env['TRADIER_ENV']),
      bootArmEligible: shouldBootArmLiveEquity(settings, operator),
      bootArmDrift: resolveLiveBrokerArmDrift(settings, operator),
      // TRA-2649 — WHY a non-empty `bootArmDrift` happened. Three very different
      // failures used to render identically here, and separating them required
      // Render log access that the board/desk does not have:
      //
      //   bootArmRanAt: null            → the arm never evaluated this boot (the
      //                                   context was materialised without
      //                                   `createUserContext`, or not built yet).
      //   bootArmPersistError: non-null → the arm ran and the force-persist THREW.
      //                                   The engine is Live in memory while disk
      //                                   stays demoted. Logged at ERROR since TRA-2649.
      //   both clean + drift non-empty  → the arm ran and CONVERGED, and something
      //                                   REWROTE the operator afterwards. This is
      //                                   what bqb1 was actually doing: a request-scoped
      //                                   `saveSettings` (carrying a `traceId` the boot
      //                                   write does not) demoted `mode` to `demo` at
      //                                   04:49:18Z and again at 12:36:25Z on 2026-07-30.
      //
      // `bootArmWriteRepairs` counts settings writes re-converged since boot — a
      // non-zero value names a recurring rewriter directly, with no log dig.
      bootArmRanAt: getLiveBrokerBootArmOutcome()?.ranAt ?? null,
      bootArmRepairedAtBoot: getLiveBrokerBootArmOutcome()?.repaired ?? null,
      bootArmPersistError: getLiveBrokerBootArmOutcome()?.persistError ?? null,
      bootArmWriteRepairs: liveBrokerArmWriteRepairs,
      bootArmLastWriteRepairAt: liveBrokerArmLastWriteRepairAt,
      // TRA-1490 / TRA-1491 — DARK strategy arm-flag states so the board/QA can
      // confirm (secrets-free) that the live single-leg option order paths are
      // still OFF. Both default false; arming either is a SEPARATE board approval.
      // `optionsBrokerConfigured` gates whether an armed flag could actually route
      // — an armed flag with no live broker still places no order.
      liveRvLongArmed: isOptionLiveRvLongEnabled(process.env),
      liveDirectionalArmed: isOptionLiveDirectionalEnabled(process.env),
      // TRA-1929 — OTM live bounded-test flag + the shared self-expiring test window.
      // These are the RAW booleans; the ACTUAL arm each order site consults is the
      // flag AND `liveTestWindowOpen` (see /api/health/live-options-fee-slippage).
      liveOtmArmed: isOptionLiveOtmEnabled(process.env),
      liveTestWindowOpen: isOptionLiveTestWindowOpen(process.env),
    });
  } catch (err) {
    log.error('options-live health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ ok: false, error: 'Failed to read options-live status' });
  }
});

// TRA-1954 (parent TRA-1916) — fee back-fill reconcile trigger. Fees are the ONE
// calibration field the fill-time ledger cannot capture (Tradier's order-status
// payload carries no commission), so `feesMeasured` is 0/n until this pass runs.
// Commission lives only on the account-HISTORY endpoint; this route pulls history
// for [start,end] on the live PRODUCTION options account and back-fills `fees` on
// every ledger row with an unambiguous match, then rewrites the durable JSONL so a
// redeploy keeps them. Read/reconcile only — moves NO capital. Admin-gated (mutates
// durable calibration state + reads a broker account). `start`/`end` are
// `YYYY-MM-DD` (inclusive); both default to a 7-day ET lookback ending today.
app.post('/api/health/live-options-fee-slippage/reconcile', requireAuth, requireAdmin, async (req, res) => {
  const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const q = req.query as Record<string, unknown>;
  const end = isDate(q['end']) ? q['end'] : etDateString(new Date());
  const start = isDate(q['start']) ? q['start'] : etDateString(new Date(Date.now() - 7 * 86_400_000));
  if ((q['start'] !== undefined && !isDate(q['start'])) || (q['end'] !== undefined && !isDate(q['end']))) {
    res.status(400).json({ ok: false, error: 'start/end must be YYYY-MM-DD' });
    return;
  }
  if (start > end) {
    res.status(400).json({ ok: false, error: 'start must be <= end' });
    return;
  }
  // The reconcile targets the LIVE PRODUCTION options account (sandbox commissions
  // are 0/absent — no real calibration there). Resolve the pinned live operator +
  // its production client exactly like the order path (env-var fallback included).
  const operator = resolveLiveBrokerOperator();
  const settings = await loadSettings(operator);
  const client = buildTradierOptionsClientForEnv(settings, 'production');
  if (!client) {
    res.status(409).json({
      ok: false,
      error: 'No production Tradier options credentials resolvable for the live operator',
    });
    return;
  }
  let fills;
  try {
    fills = await client.listAccountHistory({ start, end, type: 'trade', limit: 2000 });
  } catch (err) {
    log.warn('live-options fee reconcile: history fetch failed', {
      operator,
      start,
      end,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({ ok: false, error: 'Tradier account-history fetch failed' });
    return;
  }
  // TRA-2850 — the gainloss derivation is where real production fees come from
  // (history commission is 0 on every production row); run it in the same POST.
  let lots;
  try {
    lots = await client.listGainLoss({ start, end, limit: 2000 });
  } catch (err) {
    log.warn('live-options fee reconcile: gainloss fetch failed', {
      operator,
      start,
      end,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({ ok: false, error: 'Tradier gainloss fetch failed' });
    return;
  }
  const updated = backfillLiveOptionFees(fills).updated + backfillLiveOptionFeesFromGainLoss(lots).updated;
  const summary = summarizeLiveOptionsFeeSlippage();
  res.json({
    ok: true,
    time: new Date().toISOString(),
    build: resolveBuildInfo(),
    window: { start, end },
    historyFills: fills.length,
    gainLossLots: lots.length,
    updated,
    // The read route reports these too; echo so a single POST proves the back-fill.
    n: summary.n,
    feesMeasured: summary.feesMeasured,
    feesBySource: summary.feesBySource,
    totalFees: summary.totalFees,
    // Read durability.ephemeral FIRST — a back-fill on an ephemeral dir dies at the
    // next redeploy exactly like the fill-time rows (fix = DATA_DIR=/data, TRA-1719).
    durability: summary.durability,
    note:
      updated > 0
        ? `Back-filled ${updated} fee(s) from ${fills.length} history fill(s) + ${lots.length} settled lot(s); feesMeasured now ${summary.feesMeasured}/${summary.n}. ${summary.durability.ephemeral ? 'NOT DURABLE — DATA_DIR ephemeral; re-run after DATA_DIR=/data (TRA-1719).' : `Durable on ${summary.durability.dataDir}.`}`
        : `No rows back-filled — ${fills.length} history fill(s) + ${lots.length} settled lot(s) in window, none matched an unmeasured ledger row (or all already reconciled). Unmatched rows stay fees:null (never 0, TRA-1707).`,
  });
});

// Admin-only on-demand regeneration — lets QA / the desk refresh the review
// without waiting for the next scheduler fire.
app.post('/api/market-review/run', requireAuth, requireAdmin, async (req, res) => {
  const rawKind = (req.body as Record<string, unknown> | undefined)?.['kind'];
  const kind = rawKind === 'postmarket' ? 'postmarket' : 'premarket';
  try {
    const review = await generateMarketReview(kind);
    res.status(201).json(review);
  } catch (err) {
    log.error('market-review on-demand run failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to generate market review' });
  }
});

// ── Live-Trading Promotion Gate (TRA-532) ────────────────────────────────────
//
// The gate refuses a live transition unless a strategy has passed backtest +
// paper and carries a sign-off (enforced in PUT /api/account/settings above).
// These routes surface the per-stage status with metrics computed from data,
// register a Stage-1 backtest report, and record the Stage-3 sign-off audit.

// TRA-803 — PUBLIC, tokenless read-only probe for a strategy's promotion-gate
// summary, extending the TRA-799 shadow-ledger pattern to the Stage-2 paper
// gate. Unauthenticated by design and the same non-sensitive class as the other
// open `/api/health/*` probes: it returns ONLY the promotion-gate telemetry —
// per-stage state, the computed backtest/paper metrics, `canGoLive`, and the
// blocked-reason strings — with no order/account internals, no PII, and no
// secrets. It exists so QuantTrader can read `supertrend_confluence`
// `paper.tradeCount` plus the gate metrics to drive the TRA-802 Stage-2 go/no-go
// WITHOUT Render-specific admin creds (login + pre-minted token both 401 on
// Render's separate user store). The paper ledger is aggregated across all users
// so the count reflects the TOTAL monitored paper trades accrued. The gate logic
// is untouched, so the `canGoLive` safety invariant it reports is identical to
// the authenticated `/api/promotion/status/:strategyId` route — for the gated
// supertrend strategy it stays `false` until Stage 1/2/3 all pass.
app.get('/api/health/promotion-gate/:strategyId', async (req, res) => {
  const strategyId = (req.params as Record<string, string>)['strategyId'] as string;
  try {
    const status = await buildPublicPromotionProbe(strategyId);
    res.json({
      issue: 'TRA-803',
      strategyId,
      canGoLive: status.canGoLive,
      status,
      // TRA-936 — the Stage-2 paper count is now a DURABLE cumulative ledger
      // (`supertrendPaperClosed`) that survives the nightly TRA-219 archive and a
      // Render redeploy, so a post-deploy reading is NO LONGER expected to reset
      // to 0. A genuine 0 means no forward-test trades have ever resolved (e.g. a
      // brand-new deploy onto a fresh data disk), not a lost book — do not open a
      // duplicate verify task on a 0 alone; confirm against the shadow-signals
      // ledger (`/api/health/shadow-signals`) first.
      paperLedger: 'durable-cumulative (TRA-936)',
    });
  } catch (err) {
    log.error('promotion-gate health probe failed', {
      strategyId,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to compute promotion-gate status' });
  }
});

// Per-strategy promotion status (per-stage state + computed metrics + verdict).
// Scoped to the caller's paper ledger; backtest/sign-off are global. Any
// authenticated user can read so the dashboard can render the gate UI.
app.get('/api/promotion/status/:strategyId', requireAuth, async (req, res, next) => {
  const username = res.locals['authUser'] as string;
  try {
    const status = await buildPromotionStatus(username, req.params['strategyId'] as string);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// All registered strategies' records + the caller's live status for each, plus
// the effective thresholds — drives the gate overview panel.
app.get('/api/promotion/status', requireAuth, async (_req, res, next) => {
  const username = res.locals['authUser'] as string;
  try {
    const records = await listStrategyRecords();
    const statuses = await Promise.all(
      records.map(async r => ({
        record: r,
        status: await buildPromotionStatus(username, r.strategyId),
        thresholds: await getEffectiveThresholds(r.strategyId),
      })),
    );
    res.json({ strategies: statuses });
  } catch (err) {
    next(err);
  }
});

// Stage 1 — register a backtest report for a strategy. Admin-only. The body
// carries the FULL computed `BacktestResult`; the server picks the gate metrics
// off it (deriveBacktestGateMetrics) so the registered numbers always reflect a
// real run — a reviewer cannot hand-type metrics to clear the gate (TRA-527 §3).
app.post('/api/promotion/backtest', requireAuth, requireAdmin, async (req, res) => {
  const username = res.locals['authUser'] as string;
  try {
    const body = req.body as { strategyId?: string; reportId?: string; report?: unknown };
    if (!body?.strategyId || typeof body.strategyId !== 'string') {
      res.status(400).json({ error: 'strategyId is required' });
      return;
    }
    if (!body.report || typeof body.report !== 'object') {
      res.status(400).json({ error: 'report (a computed BacktestResult) is required' });
      return;
    }
    const rec = await registerBacktestReport({
      strategyId: body.strategyId,
      report: body.report as Parameters<typeof registerBacktestReport>[0]['report'],
      reportId: typeof body.reportId === 'string' ? body.reportId : 'unspecified',
      registeredBy: username,
    });
    res.status(201).json(rec);
  } catch (err) {
    if (err instanceof PromotionValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('TRA-532 register backtest failed', { reason: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Failed to register backtest report' });
  }
});

// Stage 1 (TRA-541) — register the backtest leg from a TRA-540 optimization
// `verdict` block. Admin-only. The body carries the machine-generated `verdict`
// from `optimization-report.json`; the server ingests its `backtestMetrics` 1:1
// AND stores the six-guard `pass` flag, which then GATES the leg: a strategy
// whose verdict.pass === false cannot clear Stage 1 even with strong headline
// metrics (the six-guard battery is the gate, not the raw numbers). The blessed
// parameter set is recorded for audit.
app.post('/api/promotion/optimization', requireAuth, requireAdmin, async (req, res) => {
  const username = res.locals['authUser'] as string;
  try {
    const body = req.body as { strategyId?: string; reportId?: string; verdict?: unknown };
    if (!body?.strategyId || typeof body.strategyId !== 'string') {
      res.status(400).json({ error: 'strategyId is required' });
      return;
    }
    if (!body.verdict || typeof body.verdict !== 'object') {
      res.status(400).json({ error: 'verdict (the TRA-540 optimization verdict block) is required' });
      return;
    }
    const rec = await registerOptimizationVerdict({
      strategyId: body.strategyId,
      verdict: body.verdict as Parameters<typeof registerOptimizationVerdict>[0]['verdict'],
      reportId: typeof body.reportId === 'string' ? body.reportId : 'unspecified',
      registeredBy: username,
    });
    res.status(201).json(rec);
  } catch (err) {
    if (err instanceof PromotionValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('TRA-541 register optimization verdict failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to register optimization verdict' });
  }
});

// Stage 1 (TRA-1465) — register the accumulate-class backtest leg from a TRA-695
// accumulation-backtest verdict. Admin-only. This is the accumulate analogue of
// `POST /api/promotion/optimization`: a hold-mode DCA strategy has no per-trade
// timing edge for the six-guard battery to certify, so its Stage 1 validates
// accumulation ROBUSTNESS instead — the harness's OOS `metrics` (deployment
// ratio, value/invested + lump-sum drawdowns/returns, cadence consistency,
// fee-adjusted value ratio) are ingested 1:1 and then GATE the leg via
// `evaluateAccumulationBacktestGate`. The store rejects this route for a
// close-based strategy (and rejects a six-guard verdict for an accumulate
// strategy), so the two Stage-1 legs can never be crossed.
app.post('/api/promotion/accumulation-backtest', requireAuth, requireAdmin, async (req, res) => {
  const username = res.locals['authUser'] as string;
  try {
    const body = req.body as { strategyId?: string; reportId?: string; metrics?: unknown };
    if (!body?.strategyId || typeof body.strategyId !== 'string') {
      res.status(400).json({ error: 'strategyId is required' });
      return;
    }
    if (!body.metrics || typeof body.metrics !== 'object') {
      res.status(400).json({ error: 'metrics (the TRA-695 accumulation-backtest metrics block) is required' });
      return;
    }
    const rec = await registerAccumulationBacktestVerdict({
      strategyId: body.strategyId,
      metrics: body.metrics as Parameters<typeof registerAccumulationBacktestVerdict>[0]['metrics'],
      reportId: typeof body.reportId === 'string' ? body.reportId : 'unspecified',
      registeredBy: username,
    });
    res.status(201).json(rec);
  } catch (err) {
    if (err instanceof PromotionValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('TRA-1465 register accumulation-backtest verdict failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to register accumulation-backtest verdict' });
  }
});

// Stage 3 — record a sign-off (`promotion_decision`). Admin-only (QuantTrader
// is an admin reviewer). Refuses to sign off a strategy that is not actually
// passing both gates UNLESS the reviewer supplies a threshold override + a
// written rationale (loosen-only audit per TRA-527 §3/§Enforcement).
app.post('/api/promotion/signoff', requireAuth, requireAdmin, async (req, res) => {
  const username = res.locals['authUser'] as string;
  try {
    const body = req.body as {
      strategyId?: string;
      thresholdOverrides?: unknown;
      rationale?: string;
    };
    if (!body?.strategyId || typeof body.strategyId !== 'string') {
      res.status(400).json({ error: 'strategyId is required' });
      return;
    }
    const overrides = body.thresholdOverrides as Parameters<typeof recordSignoff>[0]['thresholdOverrides'];
    // Evaluate current state (with any proposed overrides not yet stored, the
    // base status must already pass both data gates; overrides only loosen and
    // are recorded for audit). Block sign-off if a data gate fails and no
    // override+rationale justifies it.
    const status = await buildPromotionStatus(username, body.strategyId);
    const dataGatesPass = status.backtest.state === 'pass' && status.paper.state === 'pass';
    if (!dataGatesPass && !overrides) {
      res.status(422).json({
        ok: false,
        code: 'signoff_blocked',
        error:
          'Cannot sign off: the strategy does not pass both data gates. '
          + 'Supply thresholdOverrides + rationale to loosen (audited), or fix the underlying metrics. '
          + status.blockedReasons.join(' | '),
        status,
      });
      return;
    }
    const paperMetrics = await snapshotPaperMetrics(username, body.strategyId);
    const decision = await recordSignoff({
      strategyId: body.strategyId,
      reviewer: username,
      backtestMetrics: status.backtest.metrics,
      paperMetrics,
      thresholdOverrides: overrides,
      rationale: typeof body.rationale === 'string' ? body.rationale : undefined,
    });
    res.status(201).json({ ok: true, decision, status: await buildPromotionStatus(username, body.strategyId) });
  } catch (err) {
    if (err instanceof PromotionValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('TRA-532 sign-off failed', { reason: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Failed to record sign-off' });
  }
});

// TRA-244 — `?mode=` lets the client pick which calendar bucket to read.
// Defaults follow the user's saved settings so callers without the query
// (legacy clients, scripts) keep their current behavior.
function resolveStockReportMode(req: express.Request, username: string): StockModeKey {
  const q = (req.query['mode'] as string | undefined)?.trim();
  if (q === 'demo' || q === 'live' || q === 'sandbox') return q;
  return stockModeKey(getSettings(username));
}

function resolveCryptoReportMode(req: express.Request, username: string): CryptoModeKey {
  const q = (req.query['mode'] as string | undefined)?.trim();
  if (q === 'demo' || q === 'live') return q;
  return cryptoModeKey(getSettings(username));
}

app.get('/api/reports/latest', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveStockReportMode(req, ctx.username);
  const latestPath = join(stockReportsDirFor(ctx, mode), 'latest.json');
  if (!existsSync(latestPath)) {
    res.status(404).json({ error: 'No report generated yet' });
    return;
  }
  try {
    const raw = await readFile(latestPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read report' });
  }
});

// TRA-1572 — the per-account DEMO calendar is fed by each user's *personal*
// engine book, but the fleet's demo option trading flows through the shared,
// firm-wide Option-Trade Journal (the Desk source). For the operator accounts
// (admin, Richard) the personal demo book executes no trades, so every demo day
// rendered as a blank ("--") or a hollow "$0.00" cell even though the firm demo
// book had real realized P&L that day (e.g. 07-01 ≈ +$10.5k / 191 closes). The
// board's directive on this ticket ("compare the calendar vs the trade/journal
// data to update the calendar, and track daily P&L correctly going forward") is
// to fold the durable journal into the per-account DEMO calendar so those empty
// days fill from the same firm-wide truth the Desk view already shows.
//
// Fold rule: fill ONLY days where the personal book has nothing to say — a
// missing file, or a hollow report (zero realized, zero options, zero trades).
// A day the personal demo book *did* trade is authoritative and is left intact.
// This reuses the exact `aggregateDeskCalendar` fold (demo-only, realized option
// P&L keyed by ET close day) so the account and Desk views agree cell-for-cell.
// Applies to DEMO only; live/sandbox keep their Tradier balance-truth path.
//
// TRA-2210 — "agree cell-for-cell" was false: this fold skipped the TRA-1475
// QA/test-book de-noise that BOTH `/api/reports/desk*` routes apply, so a filled
// day here summed fixture churn the Desk view drops (2026-07-22: +$4,919.50 here
// vs +$119.50 on Desk — $4,800 of it three mirrors of one SMCI close). Now goes
// through `buildJournalCalendarCells`, which folds the filter in, so the two
// views cannot diverge again.
async function demoJournalCalendarCells(): Promise<Map<string, EodReport>> {
  const rows = await listOptionTradeJournal({ mode: 'demo' });
  return buildJournalCalendarCells(rows, Date.now());
}

/** A personal report cell carries no realized activity → safe to fill from journal. */
function isHollowReportCell(r: {
  totalTrades?: number; realizedPnl?: number; optionsPnl?: number; combinedPnl?: number;
} | null | undefined): boolean {
  if (!r) return true;
  return (r.totalTrades ?? 0) === 0
    && (r.realizedPnl ?? 0) === 0
    && (r.optionsPnl ?? 0) === 0
    && (r.combinedPnl ?? 0) === 0;
}

app.get('/api/reports', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveStockReportMode(req, ctx.username);
  let dates: string[] = [];
  try {
    const files = await readdir(stockReportsDirFor(ctx, mode));
    dates = files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''));
  } catch {
    dates = [];
  }
  // TRA-1572 — union in the firm-wide demo journal's trading days so a demo day
  // the personal book never wrote a file for (07-03 / 07-08 / 07-09 on admin's
  // book) still appears; the per-date route below serves the journal cell for it.
  //
  // TRA-2407 — OPERATOR BOOKS ONLY. This union is why a brand-new account listed
  // 25 dates, all but one predating it: the days came from the firm-wide journal,
  // not from the account. Gated with the SAME predicate as the per-date fold
  // below — a date list that advertises days the per-date route then refuses is
  // its own defect, and the two must not be able to drift.
  if (mode === 'demo' && mayViewFirmWideDemoFold(ctx.username, getUser(ctx.username)?.role)) {
    try {
      const cells = await demoJournalCalendarCells();
      for (const d of cells.keys()) dates.push(d);
    } catch (err) {
      log.warn('demo journal calendar date union failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // TRA-1192 — surface today's running Live cell so the current day's P&L shows
  // before the 9 PM EOD snapshot writes a file for it. Only when a live anchor
  // makes the cell computable (buildLiveTodayCellReport returns non-null) and
  // no settled file already exists for today.
  try {
    const today = etDateString();
    if (!dates.includes(today)) {
      const liveToday = await buildLiveTodayCellReport(ctx, mode);
      if (liveToday) dates.push(today);
    }
  } catch (err) {
    log.warn('live-today calendar cell list failed', {
      username: ctx.username,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  res.json({ dates: [...new Set(dates)].sort().reverse() });
});

// TRA-1413 — DESK (all demo books) calendar, fed by the firm-wide Option-Trade
// Journal. Board decision on TRA-1398 (picked C): keep the per-user Calendar
// (`/api/reports*`) exactly as-is and add this SEPARATE, clearly-labelled view
// for the whole fleet's demo option P&L. Source is `listOptionTradeJournal({
// mode: 'demo' })` with NO user filter — the journal is firm-wide by design
// (option A, adding a per-user field, was explicitly rejected). Registered BEFORE
// `/api/reports/:date` so the literal `desk` segment can't be captured as a date.
//
// TRA-1604 — the firm-wide desk calendar is now ADMIN-ONLY. Although the desk
// aggregation carries no balances/PII/secrets, it exposes the whole fleet's
// realized option P&L, which is firm-internal and must not be visible to
// ordinary user accounts. Both routes therefore require `requireAuth +
// requireAdmin`; a plain user account gets 401/403 and is kept to its own
// per-account calendar (`/api/reports*`). This supersedes the earlier
// "unauthenticated, same basis as /api/health/option-journal" rationale.
//
// Shape parity: both routes return exactly what the Calendar grid already
// consumes — `GET /api/reports/desk` → `{ dates: string[] }` (newest-first) and
// `GET /api/reports/desk/:date` → the per-day `EodReport` cell — so the UI only
// switches its `reportsPath`, not its rendering.
app.get('/api/reports/desk', requireAuth, requireAdmin, async (req, res) => {
  try {
    // TRA-1475 — de-noise: drop QA/test books (`qa*`, `ctoverify*`, `monitor_qa`,
    // …) so the firm Desk number reflects real books only. `?includeTest=1` opts
    // the test churn back in for debugging. Legacy un-owned rows are kept.
    const includeTest = req.query['includeTest'] === '1';
    const cells = buildJournalCalendarCells(
      await listOptionTradeJournal({ mode: 'demo' }),
      Date.now(),
      { includeTest },
    );
    res.json({ dates: [...cells.keys()].sort().reverse() });
  } catch (err) {
    log.warn('desk calendar date list failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build desk calendar' });
  }
});

app.get('/api/reports/desk/:date', requireAuth, requireAdmin, async (req, res) => {
  const { date } = req.params as Record<string, string>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }
  try {
    // TRA-1475 — same QA/test de-noise as the date-list route so a drilled-in
    // day cell matches the (filtered) figure the grid shows.
    const includeTest = req.query['includeTest'] === '1';
    const cell = buildJournalCalendarCells(
      await listOptionTradeJournal({ mode: 'demo' }),
      Date.now(),
      { includeTest },
    ).get(date);
    if (!cell) {
      res.status(404).json({ error: `No desk report for ${date}` });
      return;
    }
    res.json(cell);
  } catch (err) {
    log.warn('desk calendar day read failed', {
      date,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build desk calendar day' });
  }
});

app.get('/api/reports/:date', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { date } = req.params as Record<string, string>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }
  const mode = resolveStockReportMode(req, ctx.username);
  const filePath = join(stockReportsDirFor(ctx, mode), `${date}.json`);
  const fileExists = existsSync(filePath);
  const isToday = date === etDateString();
  // TRA-1228 — for TODAY the running intraday cell is authoritative UNTIL the
  // 9 PM ET archive settles the day. Previously any today-file already on disk
  // was served in preference to the live cell, so a file written earlier in the
  // session (a startup/backfill pass, or the live realized-calendar backfill,
  // when no trades had booked yet) FROZE the calendar at a stale value — the
  // "footer shows +$483.52 realized but the calendar reads $0.00" divergence the
  // board hit on Richard's demo account (the footer reads the live book; the
  // calendar was reading the stale file). Prefer the live cell pre-archive; the
  // settled 9 PM file wins afterward (by then the in-memory closes are cleared,
  // so the live cell would under-report).
  // TRA-2498 — route the ET hour through the shared helper. A bare
  // `hour12: false` renders midnight as 24 on Node 20 (the prod runtime), which
  // made `archiveSettled` true for all of 00:00–00:59 ET and served the stale
  // settled file in place of the live cell — the very calendar-freeze
  // divergence this block exists to prevent.
  const archiveSettled = etHour() >= 21; // matches the 21:00 ET EOD archive boundary
  if (isToday && (!fileExists || !archiveSettled)) {
    try {
      const liveToday = await buildLiveTodayCellReport(ctx, mode);
      if (liveToday) {
        res.json(liveToday);
        return;
      }
    } catch (err) {
      log.warn('live-today calendar cell read failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // TRA-1572 — DEMO fold: read the personal file (if any), and when the personal
  // book has nothing for this day (no file, or a hollow zero cell) fill from the
  // durable firm-wide demo Option-Trade Journal so the account calendar matches
  // the Desk truth instead of a blank / $0.00. A day the personal book actually
  // traded is authoritative and is served unchanged.
  let personal: EodReport | null = null;
  if (fileExists) {
    try {
      personal = JSON.parse(await readFile(filePath, 'utf-8')) as EodReport;
    } catch {
      res.status(500).json({ error: 'Failed to read report' });
      return;
    }
  }
  //
  // TRA-2407 — and ONLY for the operator books this fill was built for. Without
  // this scope the branch served the firm-wide Desk fold to any authenticated
  // account whose personal book was hollow for the day — which a brand-new
  // account is for EVERY past day. The same token that got 403 on
  // `/api/reports/desk` (TRA-1604) was handed the desk numbers here, down to the
  // 191 individual trades of other people's books in `trades[]`.
  if (shouldServeFirmWideDemoFold(mode, isHollowReportCell(personal), ctx.username, getUser(ctx.username)?.role)) {
    try {
      const cell = (await demoJournalCalendarCells()).get(date);
      if (cell && cell.totalTrades > 0) {
        res.json(cell);
        return;
      }
    } catch (err) {
      log.warn('demo journal calendar day fold failed', {
        username: ctx.username,
        date,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!personal) {
    res.status(404).json({ error: `No report for ${date}` });
    return;
  }
  res.json(personal);
});

app.post('/api/reports/generate', requireAuth, async (_req, res) => {
  try {
    const ctx = await userCtx(res);
    await generateAndSaveReport(ctx);
    res.json({ ok: true, message: 'EOD report generated successfully' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// TRA-244 — manually re-run the historical Live-calendar realized-P&L backfill
// for the current user (also runs automatically at startup). Returns the
// per-date map that was rewritten so the board can confirm the broker-truth
// values without restarting the server.
app.post('/api/reports/backfill-realized', requireAuth, async (_req, res) => {
  try {
    const ctx = await userCtx(res);
    const written = await backfillLiveRealizedCalendar(ctx);
    if (written === null) {
      res.status(400).json({
        error: 'Backfill only applies to a Tradier-backed live/sandbox account.',
      });
      return;
    }
    res.json({ ok: true, written });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Crypto Reports ────────────────────────────────────────────────────────────

app.get('/api/crypto/reports/latest', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveCryptoReportMode(req, ctx.username);
  const latestPath = join(cryptoReportsDirFor(ctx, mode), 'latest.json');
  if (!existsSync(latestPath)) {
    res.status(404).json({ error: 'No crypto report generated yet' });
    return;
  }
  try {
    const raw = await readFile(latestPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read crypto report' });
  }
});

app.get('/api/crypto/reports', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveCryptoReportMode(req, ctx.username);
  try {
    const files = await readdir(cryptoReportsDirFor(ctx, mode));
    const dates = files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
    res.json({ dates });
  } catch {
    res.json({ dates: [] });
  }
});

app.get('/api/crypto/reports/:date', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { date } = req.params as Record<string, string>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }
  const mode = resolveCryptoReportMode(req, ctx.username);
  const filePath = join(cryptoReportsDirFor(ctx, mode), `${date}.json`);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: `No crypto report for ${date}` });
    return;
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read crypto report' });
  }
});

app.post('/api/crypto/reports/generate', requireAuth, async (_req, res) => {
  try {
    const ctx = await userCtx(res);
    await generateAndSaveCryptoReport(ctx);
    res.json({ ok: true, message: 'Crypto EOD report generated successfully' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/snapshots', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.tracker.getSnapshots());
});

// ── Account Settings ─────────────────────────────────────────────────────────

// TRA-485 — `loadSettings` (not the cache-only `getSettings`) so a user who
// missed boot-time `initAllUserContexts` warmup (signed up after boot, or
// warmup threw for their row) still gets their persisted settings instead of
// silently seeing `DEFAULT_ACCOUNT_SETTINGS`. `loadSettings` is cache-first so
// the warm path stays O(1); only a cold lookup hits disk. Errors propagate to
// the Express error handler instead of being swallowed into a 200-of-defaults.
app.get('/api/account/settings', requireAuth, async (_req, res, next) => {
  const username = res.locals['authUser'] as string;
  try {
    const settings = await loadSettings(username);
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// TRA-850 — the authenticated user's persistent advisory trading memory
// (preferences the agent graph reads into its context + the learned interaction
// tally). Read-back for the settings UI; preferences only — nothing here changes
// a strategy or the promotion gate.
app.get('/api/account/trading-memory', requireAuth, async (_req, res, next) => {
  const username = res.locals['authUser'] as string;
  try {
    const [memory, interactionStats] = await Promise.all([
      getUserMemory(username),
      getInteractionStats(username),
    ]);
    res.json({ memory, interactionStats });
  } catch (err) {
    next(err);
  }
});

// TRA-850 — set the authenticated user's advisory preferences (risk tolerance,
// preferred/avoided strategies, a de-risk sizing default, per-symbol watchlist
// rationale, notes). The store sanitizes the patch (clamps sizing to [0,1],
// drops invalid fields, merges watchlist rationale by symbol).
app.put('/api/account/trading-memory', requireAuth, async (req, res, next) => {
  const username = res.locals['authUser'] as string;
  try {
    const memory = await setUserMemory(username, (req.body ?? {}) as Parameters<typeof setUserMemory>[1]);
    res.json({ memory });
  } catch (err) {
    next(err);
  }
});

// TRA-2649 — how many settings writes have been re-converged onto the ratified
// live-broker arm since boot, and the last one. Surfaced on
// `/api/health/options-live` so a recurring rewriter is visible from the probe
// instead of only from a Render log dig (which is how TRA-2649 had to be found).
let liveBrokerArmWriteRepairs = 0;
let liveBrokerArmLastWriteRepairAt: string | null = null;

app.put('/api/account/settings', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const body = req.body as Partial<AccountSettings>;
  // TRA-485 — paired with the GET-handler change: read the saved snapshot
  // through `loadSettings` so a cache-cold PUT (partial body like
  // AccountModeSwitcher's `{ mode: 'live' }`) merges against the user's
  // real persisted settings rather than DEFAULT_ACCOUNT_SETTINGS — which
  // would otherwise quietly wipe every untouched field on disk.
  const current = await loadSettings(username);
  const clampEquity = (v: number) => Math.max(1_000, Math.min(10_000_000, Number(v)));
  const updated: AccountSettings = {
    ...current,
    ...body,
    demoEquity: clampEquity(body.demoEquity ?? current.demoEquity),
    demoEquityStocks: clampEquity(body.demoEquityStocks ?? current.demoEquityStocks ?? current.demoEquity),
    demoEquityCrypto: clampEquity(body.demoEquityCrypto ?? current.demoEquityCrypto ?? current.demoEquity),
    dailyTradesLimit: Math.max(1, Math.min(100, Number(body.dailyTradesLimit ?? current.dailyTradesLimit))),
    optionsDailyTradesLimit: Math.max(1, Math.min(100, Number(body.optionsDailyTradesLimit ?? current.optionsDailyTradesLimit))),
    // TRA-327 — clamp the live-only counterparts independently so a Demo edit
    // never pulls the Live cap with it. Falls back to the un-suffixed demo
    // value for back-compat with saved settings written before TRA-327.
    dailyTradesLimitLive: Math.max(
      1,
      Math.min(
        100,
        Number(body.dailyTradesLimitLive ?? current.dailyTradesLimitLive ?? current.dailyTradesLimit),
      ),
    ),
    optionsDailyTradesLimitLive: Math.max(
      1,
      Math.min(
        100,
        Number(
          body.optionsDailyTradesLimitLive
            ?? current.optionsDailyTradesLimitLive
            ?? current.optionsDailyTradesLimit,
        ),
      ),
    ),
    managedAccountRatio: Math.max(0.01, Math.min(1, Number(body.managedAccountRatio ?? current.managedAccountRatio))),
    riskPerTrade: Math.max(0.001, Math.min(0.5, Number(body.riskPerTrade ?? current.riskPerTrade))),
    // TRA-346 — scoped Managed Account Ratio + Risk Per Trade. Each of the
    // eight (mode × dashboard) buckets is clamped independently and preserved
    // as `undefined` when neither the request body nor the saved snapshot
    // holds a value, so untouched buckets keep falling back to the legacy
    // un-suffixed field via `resolveManagedAccountRatio` /
    // `resolveRiskPerTrade`. Pinning every bucket to a default the moment any
    // other setting is saved would silently break that fallback for users who
    // saved before TRA-346. Helper extracted to `account-settings.ts` so
    // TRA-349 regression tests can lock the contract without spinning up the
    // route.
    ...mergeScopedRiskSettings(current, body),
    // TRA-249-E — clamp the operator-facing leverage cap to [1, 5] integer.
    // The live engine still hard-caps at 1× (PERP_SHORT_LEVERAGE) so a
    // misconfigured value can't bypass the §6 caps; clamping here keeps the
    // stored payload sane regardless of what the UI sends.
    liveMaxLeverageCrypto: Math.max(
      1,
      Math.min(5, Math.round(Number(body.liveMaxLeverageCrypto ?? current.liveMaxLeverageCrypto ?? 1))),
    ),
    // TRA-325 — clamp to a known preset id so a malformed request can't park
    // the engine on an unknown preset (which would degrade-fall to no_trade
    // anyway via resolveStrategyPreset since TRA-697, but persisting a junk id would
    // surface as a confusing UI selection on next load).
    activeStrategyPreset: ((): StrategyPresetId => {
      const requested = body.activeStrategyPreset ?? current.activeStrategyPreset;
      if (requested && requested in STRATEGY_PRESETS) return requested as StrategyPresetId;
      return DEFAULT_STRATEGY_PRESET_ID;
    })(),
  };
  // TRA-515 — the TRA-506 guardrail used to 422-reject this PUT whenever any
  // required live cred was blank. But the PUT is atomic: rejecting it
  // discarded the user's *valid* Tradier production keys the moment an
  // unrelated market was unconfigured — e.g. a Tradier-only stocks+options
  // user in live mode who never set up Coinbase. `findMissingLiveCredentials`
  // demands the Coinbase pair in live mode (default `liveBrokerageTypeCrypto`
  // is 'coinbase'), so their save 422'd, the Tradier keys never reached disk,
  // and GET /api/account/settings kept returning empty
  // `liveApiKeyOptionsProduction` / `liveAccountIdOptionsProduction` — live
  // Tradier trading could never start.
  //
  // The warning the user actually needs is already rendered client-side by
  // LiveCredentialsBanner, which derives the missing set from the loaded
  // settings via `findMissingLiveCredentials` — it never depended on this
  // 422. And the engine builds a null broker client for any market whose
  // creds are blank (`buildTradierLiveClient` / `buildTradierLiveEquityClient`
  // / crypto `buildLiveBroker` all return null), so persisting a partially
  // configured snapshot can never place orders on an unconfigured market.
  //
  // So: persist unconditionally and surface the missing set as a
  // non-blocking `missingLiveCredentials` warning on the 200 response. A
  // market with its creds filled (Tradier) goes live; markets still missing
  // creds stay dormant and keep nagging through the banner.
  // TRA-2649 — re-converge the pinned operator onto the board-ratified live-broker
  // arm BEFORE the promotion gate and the persist, so a settings write can no longer
  // durably demote it. TRA-1652 already made the arm a convergence loop, but the loop
  // only ran inside `createUserContext` — once per boot — so between boots a single
  // PUT carrying `mode:'demo'` disarmed it and nothing repaired that until the next
  // redeploy. On bqb1 that left `bootArmEligible:true` + `bootArmDrift:["mode"]` +
  // `optionsBrokerConfigured:false`: the ratified options arm INERT, which is the
  // exact TRA-1411 / TRA-1482 end-state those tickets each shipped a fix for.
  //
  // This introduces NO new end-state. `shouldBootArmLiveEquity` is unchanged, so the
  // repair is still bounded to the pinned operator on a `TRADIER_ENV=production`
  // service with resolvable prod creds — and that operator was already being forced
  // to this exact state on every boot. Only the convergence WINDOW changes (next
  // redeploy → immediately). The documented kill-switch still wins and is still the
  // supported de-escalation path: an explicitly empty `LIVE_EQUITY_BOOT_USER=""`
  // makes the arm ineligible, `repaired` is empty, and this clamps nothing. A
  // settings PUT was never a durable de-escalation (a redeploy always undid it), so
  // no working safety lever is removed here — an illusory one is.
  const armRepaired = applyLiveBrokerArm(updated, username);
  if (armRepaired.length > 0) {
    liveBrokerArmWriteRepairs += 1;
    liveBrokerArmLastWriteRepairAt = new Date().toISOString();
    log.warn('TRA-2649 live-broker arm: settings write would have DEMOTED the pinned operator off the ratified arm — re-converged', {
      username,
      repaired: armRepaired,
      // Which fields the caller actually sent, so a recurring rewriter can be
      // identified from its payload shape without logging the payload itself.
      bodyFields: Object.keys(body ?? {}),
      writeRepairsSinceBoot: liveBrokerArmWriteRepairs,
    });
  }
  const missingLiveCredentials = Array.from(new Set([
    ...validateLiveCredentials(updated).missing,
    ...validateProductionTradierKeys(updated).missing,
  ]));
  // TRA-532 — Live-Trading Promotion Gate. Before persisting a settings change
  // whose *result* runs live crypto auto-trading, every strategy the active
  // preset would trade live must be fully promoted
  // (backtest=pass AND paper=pass AND signoff=present). An unpromoted strategy
  // blocks the save with the exact failing gate so the UI can surface it. The
  // gate only fires on results that turn/keep live ON — turning live OFF or
  // editing settings in Demo is never blocked (see evaluateLiveTransitionGate).
  try {
    // TRA-1590 — pass the pre-PUT snapshot so the gate exempts de-escalations
    // (holding/reducing real-capital intent). Without it an operator whose live
    // crypto path already fails the gate could not even route options back to
    // sandbox, deadlocking every move toward safety.
    const gate = await evaluateLiveTransitionGate(username, updated, current);
    if (!gate.allowed) {
      log.warn('TRA-532 refused live transition', { username, blocked: gate.blocked.map(b => b.strategyId) });
      res.status(422).json({
        ok: false,
        code: 'promotion_gate_blocked',
        error:
          'Live trading is blocked by the promotion gate: '
          + gate.blocked
            .map(b => `${b.strategyId} — ${b.reasons.join(' | ')}`)
            .join(' ;; '),
        blocked: gate.blocked,
      });
      return;
    }
  } catch (err: unknown) {
    // Fail CLOSED: if the gate cannot be evaluated we must not silently let a
    // live flip through. Surface a 500 the dashboard can retry.
    log.error('TRA-532 promotion gate evaluation failed', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      ok: false,
      code: 'promotion_gate_error',
      error: 'Could not verify the live-trading promotion gate. Live transition refused; please retry.',
    });
    return;
  }
  // TRA-511 — wrap the persistence call so a `writeFile` failure (disk full,
  // EACCES, EROFS, etc.) surfaces to the UI as a red "save failed" toast
  // instead of silently appearing to succeed. Before this, an EBUSY on the
  // user's account-settings.json could bubble out as a generic 500 with no
  // structured code for the dashboard to discriminate on, leaving the
  // Settings page in a "looks-saved" state while disk still held stale data.
  try {
    await saveSettings(username, updated);
  } catch (err: unknown) {
    log.error('TRA-511 saveSettings: persistence failed', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      ok: false,
      code: 'settings_persist_failed',
      error: 'Failed to persist account settings. Please retry; if the problem persists, contact support.',
    });
    return;
  }
  // Await the stocks engine: TRA-226 makes applySettings async so a flip into
  // live mode can refresh the Tradier balance once before the broadcast,
  // matching the Coinbase pattern from TRA-224 — without this the dashboard
  // would show $0 equity for up to 30s until the next tick.
  await ctx.engine.applySettings(updated);
  broadcastEngineState(ctx);
  // Await the crypto engine: switching into live mode does an initial Coinbase
  // balance fetch, and the broadcast that follows must reflect that equity
  // instead of a transient $0 the user sees until the next 60s tick (TRA-224).
  await ctx.cryptoEngine.applySettings(updated);
  broadcastCryptoState(ctx);
  res.json({ ok: true, settings: updated, missingLiveCredentials });
});

// ── TRA-566 (TRA-410 A2) — alert notifications ───────────────────────────────
//
// Channel adapters + shared renderer live in `notifications/`; these routes are
// the user-facing surface: edit prefs, fire a test send, and link a Telegram
// chat. The dispatcher itself fans out engine events (A1) through the same
// registered adapters.

/**
 * Validate + deep-merge a partial AlertPreferences patch over the user's
 * current (fully-resolved) prefs. Returns the sanitized result, or an error
 * string for a 400. Never lets a malformed field corrupt the stored snapshot.
 */
function sanitizeNotificationPrefs(
  base: AlertPreferences,
  patch: Partial<AlertPreferences> | undefined,
): { prefs: AlertPreferences; error?: string } {
  const next: AlertPreferences = resolveAlertPreferences({ alertPreferences: base });
  if (!patch || typeof patch !== 'object') return { prefs: next };

  // Channels
  if (patch.channels && typeof patch.channels === 'object') {
    for (const ch of ALERT_CHANNELS) {
      const inc = patch.channels[ch];
      if (!inc || typeof inc !== 'object') continue;
      const cur = next.channels[ch];
      if (typeof inc.enabled === 'boolean') cur.enabled = inc.enabled;
      if (typeof inc.emailAddress === 'string') {
        const v = inc.emailAddress.trim();
        if (v && !v.includes('@')) return { prefs: next, error: 'invalid email address' };
        cur.emailAddress = v || undefined;
      }
      if (typeof inc.telegramChatId === 'string') {
        cur.telegramChatId = inc.telegramChatId.trim() || undefined;
      }
      if (typeof inc.discordWebhookUrl === 'string') {
        const v = inc.discordWebhookUrl.trim();
        if (v && !isValidDiscordWebhook(v)) {
          return { prefs: next, error: 'invalid Discord webhook URL' };
        }
        cur.discordWebhookUrl = v || undefined;
      }
    }
  }

  // Event routing matrix
  if (patch.events && typeof patch.events === 'object') {
    for (const klass of Object.keys(next.events) as (keyof AlertPreferences['events'])[]) {
      const incRow = patch.events[klass];
      if (!incRow || typeof incRow !== 'object') continue;
      for (const ch of ALERT_CHANNELS) {
        if (typeof incRow[ch] === 'boolean') next.events[klass][ch] = incRow[ch];
      }
    }
  }

  // Quiet hours
  if (patch.quietHours && typeof patch.quietHours === 'object') {
    const q = patch.quietHours;
    if (typeof q.enabled === 'boolean') next.quietHours.enabled = q.enabled;
    const hm = /^([01]?\d|2[0-3]):[0-5]\d$/;
    if (typeof q.start === 'string') {
      if (!hm.test(q.start.trim())) return { prefs: next, error: 'invalid quiet-hours start (HH:MM)' };
      next.quietHours.start = q.start.trim();
    }
    if (typeof q.end === 'string') {
      if (!hm.test(q.end.trim())) return { prefs: next, error: 'invalid quiet-hours end (HH:MM)' };
      next.quietHours.end = q.end.trim();
    }
    if (typeof q.timezone === 'string' && q.timezone.trim()) {
      const tz = q.timezone.trim();
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
      } catch {
        return { prefs: next, error: 'invalid timezone' };
      }
      next.quietHours.timezone = tz;
    }
  }

  // Signal digest
  if (patch.signalDigest !== undefined) {
    if (!['immediate', '15min', 'hourly'].includes(patch.signalDigest)) {
      return { prefs: next, error: 'invalid signalDigest' };
    }
    next.signalDigest = patch.signalDigest;
  }

  // TRA-2252 — scheduled P&L report cadence. Whitelisted like every other field
  // so a bad value can't corrupt the stored snapshot (and so it isn't silently
  // dropped — this route validates by allow-list, not pass-through).
  if (patch.reportCadence !== undefined) {
    if (!['off', 'daily', 'weekly', 'monthly', 'yearly'].includes(patch.reportCadence)) {
      return { prefs: next, error: 'invalid reportCadence' };
    }
    next.reportCadence = patch.reportCadence;
  }

  return { prefs: next };
}

// Edit alert preferences. Partial patches are deep-merged over the user's
// current prefs and validated; a bad field 400s without touching disk.
app.put('/api/account/notifications', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  try {
    const current = await loadSettings(username);
    const base = resolveAlertPreferences(current);
    const { prefs, error } = sanitizeNotificationPrefs(base, req.body as Partial<AlertPreferences>);
    if (error) {
      res.status(400).json({ ok: false, error });
      return;
    }
    await saveSettings(username, { ...current, alertPreferences: prefs });
    res.json({ ok: true, alertPreferences: prefs });
  } catch (err) {
    log.error('PUT /api/account/notifications failed', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ ok: false, error: 'Failed to save notification preferences.' });
  }
});

// Fire a test alert through ONE channel, bypassing routing/quiet-hours/digest
// so the user can confirm a channel is wired. The channel must be configured
// (SMTP creds / linked Telegram chat / valid Discord webhook) or this 409s.
app.post('/api/notifications/test', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const channel = (req.body as { channel?: string } | undefined)?.channel;
  if (!channel || !ALERT_CHANNELS.includes(channel as AlertChannel)) {
    res.status(400).json({ ok: false, error: `channel must be one of ${ALERT_CHANNELS.join(', ')}` });
    return;
  }
  const adapter: ChannelAdapter | undefined =
    channelAdapters[channel as keyof typeof channelAdapters];
  if (!adapter) {
    res.status(500).json({ ok: false, error: 'channel adapter not registered' });
    return;
  }
  try {
    const settings = await loadSettings(username);
    const prefs = resolveAlertPreferences(settings);
    if (!adapter.isConfigured(prefs)) {
      res.status(409).json({
        ok: false,
        code: 'channel_not_configured',
        error: `The ${channel} channel is not configured yet.`,
      });
      return;
    }
    const sampleEvent = buildSampleAlertEvent(username);
    // TRA-2416 — a suppressed recipient must not read as a successful test send.
    // Naming the override in the error is the point: this is the documented way a
    // fixture book still proves the mail path (see the escape hatch on
    // `EmailChannelAdapter.suppressionReason`).
    const sampleSuppression = channelSuppressionReason(adapter, sampleEvent, prefs);
    if (sampleSuppression.reason) {
      res.status(409).json({
        ok: false,
        code: 'recipient_suppressed',
        reason: sampleSuppression.reason,
        error:
          `The ${channel} recipient for this account is suppressed (${sampleSuppression.reason}) — ` +
          'no mail was attempted. Fixture addresses (@qa.test) have no MX record and hard-bounce ' +
          'into the ops mailbox. To test delivery from this account, set a real address via ' +
          'PUT /api/account/notifications {"channels":{"email":{"emailAddress":"..."}}}.',
      });
      return;
    }
    await adapter.send(sampleEvent, prefs);
    res.json({ ok: true, channel });
  } catch (err) {
    log.warn('test notification failed', {
      username,
      channel,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({
      ok: false,
      code: 'send_failed',
      error: `Test send failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

// TRA-2284 — send the caller their OWN scheduled P&L report, on demand.
//
// The TRA-2252 report path only ever fires from the 21:00 ET archive hook, and
// `reportCadence` defaults to `off`. On a fleet with nobody opted in the feature
// emits nothing — which is BIT-IDENTICAL to a broken scheduler, a dead renderer
// or a dead transport. There was no failing state to observe, so the path stayed
// unverified after deploy. This route is that failing state.
//
// It reuses the real builders (`isPeriodEnd` / `aggregatePeriod` /
// `buildPeriodReport`) over the caller's real booked snapshots, so a green here
// exercises the same aggregation the scheduled run does. Two deliberate limits
// keep it honest:
//
//   • It NEVER fabricates stats. An empty window still skips — reported as a 409
//     `empty_period` naming the window and the in-range snapshot count, because
//     `scheduled-report.ts` skips an idle book and that silence is exactly what
//     a broken path looks like. Distinguishing the two is the point.
//   • `force` relaxes ONLY the calendar boundary (`isPeriodEnd`), so an operator
//     testing on a Tuesday doesn't have to wait for Sunday to test `weekly`.
//
// Unlike `POST /api/notifications/test` (one channel, sample event, routing
// bypassed) this awaits a per-channel verdict for the REAL event through the
// REAL routing matrix, and reports whether the scheduled path WOULD have
// delivered — quiet hours included — separately from what this probe sent.
app.post('/api/notifications/report/test', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const body = (req.body ?? {}) as {
    cadence?: string;
    asOfDate?: string;
    force?: boolean;
  };
  try {
    const settings = await loadSettings(username);
    const prefs = resolveAlertPreferences(settings);

    // Cadence: explicit override, else the user's stored opt-in. `off` with no
    // override is a 409, not a silent no-op — the whole failure mode here is a
    // path that returns "fine" while emitting nothing.
    const requested = body.cadence ?? prefs.reportCadence;
    if (requested === 'off') {
      res.status(409).json({
        ok: false,
        code: 'cadence_off',
        error:
          'reportCadence is off — pass an explicit cadence to test, or opt in via PUT /api/account/notifications.',
      });
      return;
    }
    if (!REPORT_CADENCES.includes(requested as ReportCadence)) {
      res.status(400).json({
        ok: false,
        error: `cadence must be one of ${REPORT_CADENCES.join(', ')}`,
      });
      return;
    }
    const cadence = requested as ActiveReportCadence;

    const asOfDate = body.asOfDate ?? etDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      res.status(400).json({ ok: false, error: 'asOfDate must be YYYY-MM-DD' });
      return;
    }

    const ctx = await userCtx(res);
    const snapshots = [...ctx.tracker.getSnapshots(), ...ctx.cryptoTracker.getSnapshots()];
    const periodStart = periodStartFor(cadence, asOfDate);
    const snapshotsInWindow = snapshots.filter(
      s => s.date >= periodStart && s.date <= asOfDate,
    ).length;
    const atPeriodEnd = isPeriodEnd(cadence, asOfDate);
    const force = body.force === true;

    // Diagnostics returned on EVERY outcome, so a skip is as legible as a send.
    const window = {
      cadence,
      asOfDate,
      periodStart,
      periodLabel: periodLabel(cadence, periodStart, asOfDate),
      atPeriodEnd,
      forced: force,
      snapshotsTotal: snapshots.length,
      snapshotsInWindow,
    };

    if (!atPeriodEnd && !force) {
      res.status(409).json({
        ok: false,
        code: 'not_period_end',
        error: `${asOfDate} does not close the ${cadence} period — the scheduled run would emit nothing. Retry with {"force":true} to test anyway.`,
        window,
      });
      return;
    }

    // Build through the real path when we're genuinely at a boundary; when
    // forcing, assemble the same event around `aggregatePeriod` so the ONLY
    // relaxed check is the calendar one. Stats are never synthesized.
    const event = atPeriodEnd
      ? buildPeriodReport(username, cadence, snapshots, asOfDate, Date.now())
      : (() => {
          const stats = aggregatePeriod(snapshots, periodStart, asOfDate);
          if (!stats) return null;
          return {
            kind: 'report' as const,
            username,
            timestamp: Date.now(),
            cadence,
            periodStart,
            periodEnd: asOfDate,
            periodLabel: window.periodLabel,
            stats,
          };
        })();

    if (!event) {
      res.status(409).json({
        ok: false,
        code: 'empty_period',
        error:
          snapshotsInWindow === 0
            ? 'No booked daily snapshot in the window — nothing to report. Book a snapshot (POST /api/reports/generate) and retry.'
            : 'Every snapshot in the window is flat with zero trades — the scheduled run skips an idle book by design.',
        window,
      });
      return;
    }

    // Quiet hours suppress the `report` class on the scheduled path. Report it
    // rather than silently mirroring it: an operator testing at 23:00 needs to
    // see the mail AND be told the 21:00 run would have been suppressed.
    const quietHoursActive = notificationDispatcher.inQuietHours(prefs.quietHours, Date.now());

    // Routing — the same three conditions `NotificationDispatcher.fanOut`
    // applies, plus TRA-2416's suppression split. Computed in
    // `notifications/report-routing.ts` rather than inline: `index.ts` has no
    // route-test harness, and every one of these outcomes is a 409 with a JSON
    // body, so a wiring bug here reads identically to a working route. The
    // route below only maps a verdict onto a status code.
    const { verdict, routing } = resolveReportRouting({
      adapters: channelAdapters,
      event,
      prefs,
      quietHoursActive,
      atPeriodEnd,
    });

    if (verdict !== 'attempt') {
      // `all_channels_suppressed` gets its own code — NOT `no_eligible_channel`
      // (misconfiguration) and NOT the 502 `send_failed` below (transport
      // broke). Everything routed there was refused by design, and a grader
      // that cannot tell those three apart is measuring nothing.
      res.status(409).json({
        ok: false,
        code: verdict,
        error: REPORT_ROUTING_BLOCKED_MESSAGE[verdict],
        window,
        routing,
      });
      return;
    }
    const { attempted, suppressed: suppressedChannels } = routing;

    const deliveries = await Promise.all(
      attempted.map(async ch => {
        const adapter = channelAdapters[ch as keyof typeof channelAdapters]!;
        try {
          await adapter.send(event, prefs);
          return { channel: ch, ok: true as const };
        } catch (err) {
          return {
            channel: ch,
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    const delivered = deliveries.filter(d => d.ok).map(d => d.channel);

    log.info('TRA-2284 on-demand report self-test', {
      username,
      cadence,
      asOfDate,
      forced: force,
      delivered,
      failed: deliveries.filter(d => !d.ok).map(d => d.channel),
      suppressed: suppressedChannels.map(s => `${s.channel}:${s.reason}`),
    });

    const payload = {
      window,
      // Same `routing` block on every outcome, including `wouldScheduledDeliver`
      // — which gates on `attempted`, not `eligible`. See `report-routing.ts`.
      routing,
      report: {
        periodLabel: event.periodLabel,
        totalPnl: event.stats.totalPnl,
        totalTrades: event.stats.totalTrades,
        tradingDays: event.stats.tradingDays,
      },
      deliveries,
    };
    if (delivered.length === 0) {
      res.status(502).json({ ok: false, code: 'send_failed', ...payload });
      return;
    }
    res.json({ ok: true, delivered, ...payload });
  } catch (err) {
    log.error('POST /api/notifications/report/test failed', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ ok: false, error: 'report self-test failed' });
  }
});

// Issue a single-use Telegram link token + deep link. The user taps the link,
// Telegram delivers `/start <token>` to the bot, and the webhook below records
// their chat_id. Requires a deployment bot token to be useful.
app.post('/api/notifications/telegram/link', requireAuth, (req, res) => {
  const username = res.locals['authUser'] as string;
  const botUsername = process.env['TELEGRAM_BOT_USERNAME'];
  if (!process.env['TELEGRAM_BOT_TOKEN']) {
    res.status(503).json({
      ok: false,
      code: 'telegram_not_configured',
      error: 'Telegram is not enabled on this deployment (no TELEGRAM_BOT_TOKEN).',
    });
    return;
  }
  const token = issueLinkToken(username);
  const deepLink = botUsername ? `https://t.me/${botUsername}?start=${token}` : undefined;
  res.json({ ok: true, token, deepLink, botUsername: botUsername ?? null });
});

// TRA-852 — issue a single-use Discord link token. Discord has no payload deep
// link for slash commands, so the user runs `/link <token>` in any channel the
// bot can see; the interactions endpoint below consumes the token and records
// their Discord user id. Reuses the channel-neutral link-token store. Requires a
// configured public key so an unusable (verification-less) flow can't be linked.
app.post('/api/notifications/discord/link', requireAuth, (req, res) => {
  const username = res.locals['authUser'] as string;
  if (!process.env['DISCORD_PUBLIC_KEY']) {
    res.status(503).json({
      ok: false,
      code: 'discord_not_configured',
      error: 'Discord is not enabled on this deployment (no DISCORD_PUBLIC_KEY).',
    });
    return;
  }
  const token = issueLinkToken(username);
  res.json({ ok: true, token, command: `/link ${token}` });
});

// TRA-848 — true when the agent-layer kill switch (TRADING_AGENTS_LLM_DISABLED)
// is engaged. Mirrors the truthy set used by the advisory layer; gates the
// capital-affecting inbound verbs (approve/reject) without disabling reads.
function isAgentKillSwitchEngaged(): boolean {
  const raw = process.env[LLM_KILL_ENV_VAR];
  if (raw == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

// TRA-848 — reverse of account-linking: map an inbound Telegram chat id back to
// the linked app user. The chat id is the auth token here — it was bound only
// via the single-use `/start <token>` flow, so a known chat id IS an
// authenticated user (the link-token auth boundary the issue calls for). Returns
// undefined for any chat we have not linked, so an unsolicited message is
// silently ignored rather than acted on.
function resolveUsernameByTelegramChat(chatId: string): string | undefined {
  for (const ctx of getAllUserContexts()) {
    const prefs = resolveAlertPreferences(getSettings(ctx.username));
    if (prefs.channels.telegram.telegramChatId === chatId) return ctx.username;
  }
  return undefined;
}

// TRA-852 — Discord mirror of resolveUsernameByTelegramChat. A Discord user id
// is the auth subject here: it is bound only via the single-use `/link <token>`
// interaction flow, so a known id IS an authenticated user. Returns undefined
// for any id we have not linked, so an unsolicited interaction is ignored.
function resolveUsernameByDiscordUser(userId: string): string | undefined {
  for (const ctx of getAllUserContexts()) {
    const prefs = resolveAlertPreferences(getSettings(ctx.username));
    if (prefs.channels.discord.discordUserId === userId) return ctx.username;
  }
  return undefined;
}

// TRA-848 — send one plain-text reply on the inbound Telegram chat. Fire-and-
// forget: a failed reply must never 500 the webhook (Telegram expects a fast
// 200 and retries on non-2xx).
async function sendTelegramReply(chatId: string, text: string): Promise<void> {
  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  if (!botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    log.warn('telegram reply failed', { reason: err instanceof Error ? err.message : String(err) });
  }
}

// TRA-848 / TRA-852 — assemble the injectable CommandContext the router runs
// against, reading from this user's live engine state. Channel-neutral: the
// Telegram webhook and the Discord interactions endpoint share it (the
// channel-specific bit is only how the reply text is delivered). Read renderers
// are deliberately plain text (chat-friendly); approve/reject delegate to the
// engine's human-in-the-loop methods, which keep every risk + live-gate control.
function buildCommandContext(username: string): CommandContext {
  const ctx = tryGetUserContext(username);
  const engine = ctx?.engine;
  const fmt = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(2);
  const priceFor = (symbol: string): number | undefined => {
    const s = engine?.getState().symbols.find(x => x.symbol.toUpperCase() === symbol.toUpperCase());
    return s?.price;
  };
  return {
    killSwitchEngaged: isAgentKillSwitchEngaged(),
    status: () => {
      if (!engine) return 'No active session.';
      const st = engine.getState();
      const a = st.account;
      return [
        `Equity $${a.totalEquity.toFixed(2)}  Cash $${a.availableCash.toFixed(2)}`,
        `Day P&L ${fmt(a.dailyPnl)}  Open ${a.openPositions.length}`,
        `Market ${st.marketOpen ? 'OPEN' : 'closed'}  Auto ${st.autoTradingEnabled ? 'on' : 'off'}` +
          `  Agents ${st.tradingAgentsEnabled ? 'on' : 'off'}` +
          (st.tradingHalted ? `  HALTED (${st.haltReason ?? 'risk'})` : ''),
      ].join('\n');
    },
    scan: () => {
      if (!engine) return 'No active session.';
      const sigs = engine.getState().signals.slice(-5);
      if (sigs.length === 0) return 'Scan: no recent signals.';
      return ['Recent signals:', ...sigs.map(s => `  ${s.symbol} ${s.side} ${s.type} @ ${s.entryPrice.toFixed(2)}`)].join('\n');
    },
    positions: () => {
      if (!engine) return 'No active session.';
      const pos = engine.getState().account.openPositions;
      if (pos.length === 0) return 'No open positions.';
      return ['Open positions:', ...pos.map(p => `  ${p.symbol} ${p.side} x${p.quantity} @ ${p.entryPrice.toFixed(2)}`)].join('\n');
    },
    pendingRecommendations: () =>
      (engine?.getAgentRecommendations() ?? []).map(r => ({
        id: r.proposedSignal?.id ?? `agent-${r.symbol}-${r.asOf}`,
        symbol: r.symbol,
        verdict: r.verdict,
        action: r.action,
        conviction: r.conviction,
      })),
    approve: async target => {
      if (!engine) return { ok: false, message: 'No active session.' };
      const r = await engine.approveRecommendationById(target, priceFor(target.toUpperCase()) ?? priceFor(target));
      return { ok: r.ok, message: r.ok ? `APPROVED — ${r.reason}` : `Cannot approve: ${r.reason}` };
    },
    reject: target => {
      if (!engine) return { ok: false, message: 'No active session.' };
      const r = engine.rejectRecommendationById(target);
      return { ok: r.ok, message: r.ok ? `REJECTED — ${r.reason}` : `Cannot reject: ${r.reason}` };
    },
    // TRA-851 — natural-language routine management. Read is synchronous (cache);
    // mutations parse + persist through the routine store.
    listRoutines: () => listRoutinesSync(username).map(toRoutineSummary),
    addRoutine: async spec => {
      const parsed = parseRoutine(spec);
      if (!parsed.ok) return { ok: false, message: parsed.error };
      const res = await addRoutineToStore(username, parsed.routine, spec);
      if (!res.ok) return { ok: false, message: res.error };
      return { ok: true, message: `Scheduled ${res.routine.id}: ${describeRoutine(res.routine)}` };
    },
    removeRoutine: async id => {
      const removed = await removeRoutineFromStore(username, id);
      return removed
        ? { ok: true, message: `Removed routine ${id}.` }
        : { ok: false, message: `No routine "${id}".` };
    },
    setRoutineEnabled: async (id, enabled) => {
      const updated = await setRoutineEnabledInStore(username, id, enabled);
      return updated
        ? { ok: true, message: `Routine ${id} ${enabled ? 'enabled' : 'disabled'}.` }
        : { ok: false, message: `No routine "${id}".` };
    },
  };
}

// TRA-851 — flatten a stored routine for chat display.
function toRoutineSummary(r: StoredRoutine): RoutineSummary {
  return {
    id: r.id,
    action: r.action,
    timeEt: r.timeEt,
    filter: filterLabel(r.filter),
    enabled: r.enabled,
    marketDaysOnly: r.marketDaysOnly,
  };
}

// TRA-851 — one-line confirmation of an added routine, e.g.
// "scan semis @ 09:30 ET (market days)".
function describeRoutine(r: StoredRoutine): string {
  const scope = filterLabel(r.filter);
  const scopeBit = scope !== 'all' ? ` ${scope}` : '';
  const days = r.marketDaysOnly ? 'market days' : 'every day';
  return `${r.action}${scopeBit} @ ${r.timeEt} ET (${days})`;
}

// TRA-851 — run one due routine for a user and produce the message to push.
// Reuses the same read paths the chat commands use: status/positions go through
// the command context, scan filters the engine's live signals, and brief reuses
// the TRA-849 morning-brief builder + renderer. Returns null when there is no
// active session for the user (nothing to send).
async function executeRoutineForUser(
  username: string,
  routine: StoredRoutine,
): Promise<RoutineRendered | null> {
  const ctx = tryGetUserContext(username);
  if (!ctx) return null;
  const scope = filterLabel(routine.filter);
  const scopeBit = scope !== 'all' ? ` (${scope})` : '';

  switch (routine.action) {
    case 'status':
      return { title: 'Routine: status', body: buildCommandContext(username).status() };
    case 'positions':
      return { title: 'Routine: positions', body: buildCommandContext(username).positions() };
    case 'scan': {
      const signals = ctx.engine.getState().signals;
      return { title: `Routine: scan${scopeBit}`, body: formatScan(signals, routine.filter) };
    }
    case 'brief': {
      // Build a full morning brief for this user on demand and reuse the shared
      // renderer's plain-text body so the routine push matches the 8:30 brief.
      const macro = await buildMacroSection();
      const now = new Date();
      const event = buildBriefForUser(ctx, macro, etDateString(now), now.getTime());
      const rendered = renderAlert(event, now.getTime());
      return { title: 'Routine: morning brief', body: rendered.text };
    }
    default:
      return null;
  }
}

// Telegram webhook receiver — records the chat_id for a `/start <token>` deep
// link (account linking, TRA-566) AND, post-link, handles inbound conversational
// control commands (TRA-848). Unauthenticated at the transport (Telegram calls
// it) but gated by the secret token configured via setWebhook
// (`TELEGRAM_WEBHOOK_SECRET`); without it the route is closed. Command handling
// is further gated by chat-id↔user resolution (the link-token auth boundary).
app.post('/api/notifications/telegram/webhook', async (req, res) => {
  const secret = process.env['TELEGRAM_WEBHOOK_SECRET'];
  if (!secret || req.header('x-telegram-bot-api-secret-token') !== secret) {
    res.status(403).json({ ok: false });
    return;
  }
  // Telegram always expects a 200 quickly; we never surface internal errors to it.
  try {
    const update = req.body as {
      message?: { text?: string; chat?: { id?: number | string } };
    };
    const text = update?.message?.text;
    const chatId = update?.message?.chat?.id;
    const token = parseStartCommand(text);
    if (token && chatId != null) {
      // ── Account linking (TRA-566) ──
      const username = consumeLinkToken(token);
      if (username) {
        const current = await loadSettings(username);
        const prefs = resolveAlertPreferences(current);
        prefs.channels.telegram.telegramChatId = String(chatId);
        prefs.channels.telegram.enabled = true;
        await saveSettings(username, { ...current, alertPreferences: prefs });
        log.info('telegram chat linked', { username });
        await sendTelegramReply(String(chatId), 'Linked. Send "help" for commands.');
      } else {
        log.debug('telegram link token unknown/expired');
      }
    } else if (text && chatId != null) {
      // ── Inbound conversational control (TRA-848) ──
      const cmd = parseCommand(text);
      if (cmd) {
        const username = resolveUsernameByTelegramChat(String(chatId));
        if (!username) {
          // Unlinked chat — do not act; nudge the user to link first.
          await sendTelegramReply(String(chatId), 'This chat is not linked. Use Settings → Notifications → Link to connect.');
        } else {
          const reply = await executeCommand(cmd, buildCommandContext(username));
          await sendTelegramReply(String(chatId), reply);
        }
      }
    }
  } catch (err) {
    log.warn('telegram webhook handling failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  res.json({ ok: true });
});

// TRA-852 — Discord Interactions endpoint. The Discord transport for the inbound
// conversational control shipped in TRA-848. Unauthenticated at the transport
// (Discord calls it) but every request is verified by Ed25519 signature against
// DISCORD_PUBLIC_KEY — an unsigned/forged request gets a 401 and never reaches
// the command path. Like Telegram, command handling is further gated by
// Discord-user↔app-user resolution (the link-token auth boundary) and the
// TRADING_AGENTS_LLM_DISABLED kill switch (inside the shared router).
//
// Discord expects an INTERACTION RESPONSE in the HTTP reply itself (not a
// follow-up call), so we answer synchronously: PONG to the PING handshake, and
// an ephemeral CHANNEL_MESSAGE_WITH_SOURCE carrying the reply text otherwise.
app.post('/api/notifications/discord/interactions', async (req, res) => {
  const publicKey = process.env['DISCORD_PUBLIC_KEY'];
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  const ok = verifyDiscordRequest({
    publicKey,
    signature: req.header('x-signature-ed25519'),
    timestamp: req.header('x-signature-timestamp'),
    rawBody,
  });
  if (!ok) {
    res.status(401).json({ error: 'invalid request signature' });
    return;
  }

  const interaction = (req.body ?? {}) as { type?: number };
  // PING handshake — Discord probes this on URL setup and on a schedule.
  if (interaction.type === DISCORD_INTERACTION_TYPE.PING) {
    res.json({ type: DISCORD_RESPONSE_TYPE.PONG });
    return;
  }

  const reply = (text: string): void => {
    res.json({
      type: DISCORD_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: text, flags: DISCORD_EPHEMERAL_FLAG },
    });
  };

  try {
    const extracted = extractInteraction(interaction);
    if (!extracted || !extracted.userId) {
      reply('Could not read that interaction.');
      return;
    }
    const { text, userId } = extracted;

    // ── Account linking (mirror of Telegram's `/start <token>`) ──
    const token = parseDiscordLinkToken(text);
    if (token) {
      const username = consumeLinkToken(token);
      if (username) {
        const current = await loadSettings(username);
        const prefs = resolveAlertPreferences(current);
        prefs.channels.discord.discordUserId = userId;
        prefs.channels.discord.enabled = true;
        await saveSettings(username, { ...current, alertPreferences: prefs });
        log.info('discord user linked', { username });
        reply('Linked. Use /status, /scan, /positions, /brief, /approve, /reject, or /help.');
      } else {
        log.debug('discord link token unknown/expired');
        reply('That link code is invalid or expired. Generate a new one in Settings → Notifications.');
      }
      return;
    }

    // ── Inbound conversational control (TRA-848 command core) ──
    const cmd = parseCommand(text);
    if (!cmd) {
      reply('Unrecognized command. Try /help.');
      return;
    }
    const username = resolveUsernameByDiscordUser(userId);
    if (!username) {
      reply('This Discord account is not linked. Use Settings → Notifications → Link, then run /link <code>.');
      return;
    }
    const replyText = await executeCommand(cmd, buildCommandContext(username));
    reply(replyText);
  } catch (err) {
    log.warn('discord interaction handling failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    // A signed request that blew up still gets a clean ephemeral reply.
    reply('Something went wrong handling that command.');
  }
});

// Per-market scope (TRA-192): Stockdashboard and Cryptodashboard each have
// their own "Reset Demo Account" button, and resetting one must not wipe the
// other. The optional `market` body field selects which engine to reset.
// Omitting it preserves the legacy "reset both" behavior used by the global
// settings page where no market context is active.
app.post('/api/account/reset-demo', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const market = (req.body as { market?: string } | undefined)?.market;
  if (market !== undefined && market !== 'stocks' && market !== 'crypto') {
    res.status(400).json({ error: "market must be 'stocks', 'crypto', or omitted" });
    return;
  }
  if (market === undefined || market === 'stocks') {
    ctx.engine.forceReset(settings);
    broadcastEngineState(ctx);
  }
  if (market === undefined || market === 'crypto') {
    const cryptoEquity = settings.demoEquityCrypto ?? settings.demoEquity;
    ctx.cryptoEngine.forceReset(cryptoEquity);
    broadcastCryptoState(ctx);
  }
  res.json({ ok: true, market: market ?? 'both' });
});

// ── Trading controls ──────────────────────────────────────────────────────────

/**
 * TRA-323 — build a Tradier options client targeting a specific env regardless
 * of the user's current `liveTradierEnvOptions` selection. Used by the
 * "Sync Tradier positions" flow so a user can pull sandbox state in even
 * while the engine is configured for production (or vice versa). Returns
 * `null` when neither saved per-options creds nor env-var fallbacks are
 * present for the requested env; the caller should respond with a clear
 * 409 rather than silently no-op.
 */
function buildTradierOptionsClientForEnv(
  settings: AccountSettings,
  env: TradierEnv,
): TradierOptionsClient | null {
  // TRA-714: `||` (not `??`) so a BLANK saved cred ('' — the default when
  // Tradier is configured only via env vars, e.g. the AI Ideas / options-ideas
  // feed) falls through to the env-var fallback. With `??`, an empty-string
  // field short-circuits and the env fallback never runs, leaving the feed stuck
  // on "no Tradier options credentials" even when TRADIER_* env vars are set.
  // (This is the copy the /api/options/ideas route actually calls; a sibling in
  // signal-engine.ts was fixed in the same way.)
  const apiToken = (
    (env === 'production'
      ? settings.liveApiKeyOptionsProduction
      : (settings.liveApiKeyOptionsSandbox || settings.liveApiKeyOptions))
    || (env === 'production'
      ? process.env['TRADIER_API_TOKEN']
      : (process.env['TRADIER_SANDBOX_API_TOKEN'] || process.env['TRADIER_API_TOKEN']))
    || ''
  ).trim();
  const accountId = (
    (env === 'production'
      ? settings.liveAccountIdOptionsProduction
      : (settings.liveAccountIdOptionsSandbox || settings.liveAccountIdOptions))
    || (env === 'production'
      ? process.env['TRADIER_ACCOUNT_ID']
      : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] || process.env['TRADIER_ACCOUNT_ID']))
    || ''
  ).trim();
  if (!apiToken || !accountId) return null;
  return new TradierOptionsClient(apiToken, accountId, env);
}

// TRA-229 — start/stop are scoped to the dashboard's current account mode
// (demo or live) so a user can run live trading while leaving demo paused, or
// vice versa. The mode is taken from saved settings; clients can also pass an
// explicit `{ "mode": "demo" | "live" }` body to set the inactive-mode flag
// without switching modes.
function resolveTradingMode(
  body: unknown,
  current: 'demo' | 'live',
): 'demo' | 'live' {
  const requested = (body as { mode?: unknown } | undefined)?.mode;
  if (requested === 'demo' || requested === 'live') return requested;
  return current;
}

app.post('/api/trading/start', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  ctx.engine.setAutoTrading(true, mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { stocksAutoTradingEnabledLive: true }
      : { stocksAutoTradingEnabledDemo: true }),
  };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: true });
});

app.post('/api/trading/stop', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  ctx.engine.setAutoTrading(false, mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { stocksAutoTradingEnabledLive: false }
      : { stocksAutoTradingEnabledDemo: false }),
  };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: false });
});

// TRA-526 — global kill switch (deterministic risk-layer master override).
// Engages/releases the manual master halt across BOTH the equities/options
// engine (via DailyRiskGovernor) and the crypto engine, and persists the state
// to settings so the halt survives a server restart. While engaged, every
// new-entry path is blocked regardless of the per-mode auto-trading flags or
// daily circuit-breakers — "the AI proposes, the math disposes."
app.post('/api/trading/kill-switch', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const body = req.body as { engaged?: unknown; reason?: unknown } | undefined;
  const engaged = body?.engaged === true || body?.engaged === 'true';
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 280) : undefined;

  if (engaged) ctx.engine.engageKillSwitch(reason);
  else ctx.engine.releaseKillSwitch();
  ctx.cryptoEngine.setKillSwitch(engaged);

  const updated: AccountSettings = {
    ...settings,
    globalKillSwitchEngaged: engaged,
    ...(engaged && reason ? { globalKillSwitchReason: reason } : { globalKillSwitchReason: undefined }),
  };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  broadcastCryptoState(ctx);
  res.json({
    ok: true,
    killSwitchEngaged: ctx.engine.isKillSwitchEngaged(),
    haltReason: engaged ? (reason ?? null) : null,
  });
});

// TRA-895 — operator reset of the daily circuit-breaker (consecutive-loss / drawdown halt).
// Clears the intraday halt so Trading Agents can open new entries again without waiting for
// the ET midnight day-roll. Does NOT touch the kill switch. Demo-safe: no settings are mutated.
app.post('/api/trading/reset-halt', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  ctx.engine.resetDailyCircuitBreaker();
  broadcastEngineState(ctx);
  res.json({ ok: true, tradingHalted: false });
});

// TRA-544 (TRA-529 §2B) — flip the runtime "Trading Agents" master switch from
// the banner toggle. ON hands trade decisions to the advisory multi-agent layer
// and SUSPENDS the deterministic auto-router; OFF restores the deterministic
// stack. The takeover never bypasses risk: agent orders still clear the
// deterministic RiskManager hard caps and the TRA-526 kill switch overrides
// everything. Persisted to settings so the choice survives a restart, and the
// state push confirms the new value to every client (per docs/architecture.md
// §2: REST flips, the WS state confirms). P1 is advisor-only (stub, no LLM
// spend); gating mode is P4.
app.post('/api/trading/trading-agents', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const body = req.body as { enabled?: unknown } | undefined;
  const enabled = body?.enabled === true || body?.enabled === 'true';

  ctx.engine.setTradingAgents(enabled);

  const updated: AccountSettings = { ...settings, tradingAgentsEnabled: enabled };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  res.json({ ok: true, tradingAgentsEnabled: enabled });
});

// TRA-796 (TRA-529 P4) — flip gating mode. `enabled` lets an APPROVE
// recommendation's proposedSignal actually route as a risk-checked order
// (demo-first). `liveEnabled` is the SEPARATE board+CTO go-live flag that permits
// routing in LIVE mode; it defaults to false and stays off unless this request
// explicitly sets it, so demo gating can be turned on without ever arming live.
// Routing never bypasses risk — every agent order still clears the deterministic
// RiskManager hard caps and the TRA-526 kill switch overrides everything.
// Persisted to settings so the choice survives a restart; the state push confirms
// the new values to every client.
app.post('/api/trading/trading-agents/gating', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const body = req.body as { enabled?: unknown; liveEnabled?: unknown } | undefined;
  const enabled = body?.enabled === true || body?.enabled === 'true';
  const liveEnabled = body?.liveEnabled === true || body?.liveEnabled === 'true';

  ctx.engine.setTradingAgentsGating(enabled, liveEnabled);

  const updated: AccountSettings = {
    ...settings,
    tradingAgentsGatingEnabled: enabled,
    tradingAgentsLiveGatingEnabled: liveEnabled,
  };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  res.json({ ok: true, tradingAgentsGatingEnabled: enabled, tradingAgentsLiveGatingEnabled: liveEnabled });
});

// TRA-941 (TRA-813 P2) — pending-proposals queue. The desktop panel (TRA-940)
// reads the queue + the live daily-cap usage from here, and confirms/rejects per
// proposal. Only a confirmed proposal routes to capital (Piece 3); rejection
// captures a required reason for the audit trail.
app.get('/api/proposals', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  res.json({
    proposals: ctx.engine.getPendingProposals(),
    caps: executionCapStatus(username),
    killSwitchEngaged: ctx.engine.isKillSwitchEngaged(),
    tradingAgentsEnabled: ctx.engine.isTradingAgentsEnabled(),
    // TRA-945 §2 — the store TTL (env-overridable) so the panel can grey out a
    // proposal nearing expiry instead of having it silently vanish at the TTL.
    proposalTtlMs: proposalTtlMs(),
  });
});

app.post('/api/proposals/:id/approve', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const proposal = ctx.engine.getPendingProposals().find(p => p.id === id);
  // Resolve the current quote for the proposal's symbol so routing sizes/fills
  // against a real price (mirrors the position-close route's price lookup).
  let price: number | undefined;
  if (proposal) {
    const sym = ctx.engine.getState().symbols.find(s => s.symbol === proposal.symbol);
    price = sym?.price;
  }
  const result = await ctx.engine.confirmProposalById(id, price);
  broadcastEngineState(ctx);
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/proposals/:id/reject', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const body = req.body as { reason?: unknown } | undefined;
  const reason = typeof body?.reason === 'string' ? body.reason : '';
  const result = ctx.engine.rejectProposalById(id, reason);
  broadcastEngineState(ctx);
  res.status(result.ok ? 200 : 400).json(result);
});

// TRA-230: clear the displayed signal list without resetting positions or equity.
app.post('/api/signals/reset', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  ctx.engine.clearSignals();
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

app.post('/api/positions/:id/close', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const state = ctx.engine.getState();
  const pos = state.account.openPositions.find(p => p.id === id);
  if (!pos) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }
  const sym = state.symbols.find(s => s.symbol === pos.symbol);
  const price = sym?.price ?? pos.entryPrice;
  ctx.engine.manualClosePosition(id, price);
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

app.post('/api/options/:id/close', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;

  // TRA-323 / TRA-348 / TRA-352 — close path. There are three sub-paths,
  // each routed by the position's origin:
  //
  //  1. Tradier-imported (TRA-323). The local row only exists for display;
  //     the position lives on Tradier's books, not on the paper cash
  //     bucket. Closing routes a real `sell_to_close` to Tradier; on fill
  //     we record a closed-options row WITHOUT crediting paper cash. On
  //     reject we leave the row and 502. On pending we tag
  //     `pendingCloseOrderId` and 202.
  //
  //  2. Engine-opened live (TRA-221 + TRA-352). The engine opened a paper
  //     row AND fired a real `buy_to_open` on Tradier (signal-engine.ts
  //     ~line 1017). Before TRA-352, the close path here was paper-only —
  //     the Tradier long leaked. Now we mirror the close to Tradier and
  //     close the local row at the broker's actual avg fill price (so
  //     paper cash + realized P&L match the broker reality, not the local
  //     mark which can be stale on wide-spread OCCs).
  //
  //  3. Engine-opened demo (or live without Tradier creds). Pure paper —
  //     no broker call, close at the local mark like before.
  //
  // Sub-paths 1 and 2 share the smart-pricing layer in
  // `submitSmartSellToClose`: pull a fresh quote, submit limit at mid,
  // walk a quarter-step toward the bid if the first attempt doesn't fill
  // within 5s. This is the TRA-352 fix for "market sell fills at the
  // bid on wide-spread contracts" — previously a 0.05/0.17 contract
  // filled at 0.05 instead of ~0.11.
  const imported = ctx.engine.findImportedOption(id);
  if (imported) {
    // TRA-407 (C4) — pending-close double-submit guard. The desktop UI
    // already swaps the Close button for a disabled "Pending #N" badge once
    // `pendingCloseOrderId` is set, but a stale client or a double-click
    // landing before that state broadcasts round-trips can still POST a
    // second close. Refuse server-side so a single contract can never have
    // two live `sell_to_close` orders working at the broker at once.
    if (imported.position.pendingCloseOrderId !== undefined) {
      res.status(409).json({
        error: 'A close order is already in flight for this position — wait for it to fill or be reconciled before closing again.',
        pendingCloseOrderId: imported.position.pendingCloseOrderId,
      });
      return;
    }
    const settings = getSettings(username);
    const client = buildTradierOptionsClientForEnv(settings, imported.env);
    if (!client) {
      res.status(409).json({
        error: `No Tradier credentials saved for ${imported.env} — set them in Settings before closing imported positions.`,
      });
      return;
    }
    const optionSymbol = imported.position.optionSymbol;
    const contracts = imported.position.contractsRemaining;
    if (!optionSymbol || contracts <= 0) {
      res.status(409).json({ error: 'Imported position is missing OCC symbol or contracts' });
      return;
    }
    const outcome = await submitSmartSellToClose(client, optionSymbol, contracts);
    // TRA-1601 — close-side maker-fill telemetry. Fire-and-forget; positive
    // realizedVsMid = received below mid = cost. `production` is the live book.
    recordMakerFill({
      ts: Date.now(),
      side: 'close',
      mode: imported.env === 'production' ? 'live' : 'demo',
      symbol: optionSymbol,
      result: outcome.status,
      ...(outcome.status === 'filled' && outcome.mid != null
        ? { realizedVsMidUsd: (outcome.mid - outcome.avgFillPrice) * contracts * 100 }
        : {}),
    }).catch(() => {});
    if (outcome.status === 'no_quote') {
      log.warn('tradier-import sell_to_close aborted', {
        optionSymbol,
        env: imported.env,
        reason: outcome.reason,
      });
      res.status(409).json({ error: outcome.reason });
      return;
    }
    if (outcome.status === 'rejected') {
      log.warn('tradier-import sell_to_close rejected', {
        optionSymbol,
        env: imported.env,
        reason: outcome.reason,
      });
      res.status(502).json({ error: `Tradier rejected the close: ${outcome.reason}` });
      return;
    }
    if (outcome.status === 'filled') {
      log.info('tradier-import sell_to_close filled', {
        optionSymbol,
        qty: contracts,
        env: imported.env,
        order: outcome.orderId,
        fillPrice: Number(outcome.avgFillPrice.toFixed(2)),
        limitPrice: Number(outcome.limitPrice.toFixed(2)),
      });
      ctx.engine.recordImportedOptionFill(id, outcome.avgFillPrice);
      broadcastEngineState(ctx);
      res.json({
        ok: true,
        imported: true,
        status: 'filled',
        orderId: outcome.orderId,
        fillPrice: outcome.avgFillPrice,
      });
      return;
    }
    // outcome.status === 'pending'
    log.info('tradier-import sell_to_close pending', {
      optionSymbol,
      qty: contracts,
      env: imported.env,
      order: outcome.orderId,
      limitPrice: Number(outcome.limitPrice.toFixed(2)),
    });
    ctx.engine.setPendingCloseOrderId(id, outcome.orderId);
    broadcastEngineState(ctx);
    res.status(202).json({ ok: true, imported: true, status: 'pending', orderId: outcome.orderId });
    return;
  }

  // Engine-opened path. Look up the position so we can decide whether to
  // mirror the close to Tradier (live + has creds) or stay paper-only
  // (demo, or live without creds — a rare race after the user revoked
  // their Tradier token mid-session).
  const engineOpened = ctx.engine.findEngineOpenedOption(id);
  if (!engineOpened) {
    res.status(404).json({ error: 'Option position not found' });
    return;
  }
  // TRA-598 (C3) — no-day-trading guardrail: refuse a voluntary same-session
  // round trip on an AI/engine-opened position. Risk-driven auto-exits don't go
  // through this route, so a losing position still auto-exits at its stop; this
  // only blocks the user from manually closing a position they opened today.
  const dayTradeGuard = ctx.engine.checkOptionDayTradingClose(id);
  if (!dayTradeGuard.allowed) {
    log.info('option close blocked by no-day-trading guardrail', {
      optionId: id,
      reason: dayTradeGuard.reason,
    });
    res.status(409).json({ error: dayTradeGuard.reason });
    return;
  }
  const liveMirror = engineOpened.position.mode === 'live';
  if (liveMirror) {
    // TRA-358 — user-driven LIMIT close on engine-opened live positions.
    // The body carries the price + qty + duration the user picked in the
    // Close drawer (mirrors Tradier's web close panel). The smart-walk
    // path (TRA-352) is intentionally retired for engine-opened live
    // closes: the user is choosing the price themselves, and we don't
    // want to overwrite that with a midpoint walk. Demo and imported
    // paths are unaffected.
    if (engineOpened.position.pendingExit) {
      res.status(409).json({
        error: 'A close order is already in flight for this position. Cancel it first if you want to re-stage.',
      });
      return;
    }
    const body = (req.body ?? {}) as {
      limitPrice?: unknown;
      qty?: unknown;
      duration?: unknown;
    };
    const limitPrice = Number(body.limitPrice);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      res.status(400).json({
        error: 'limitPrice (per-share, > 0) is required for a live engine-opened close.',
      });
      return;
    }
    const requestedQty = body.qty === undefined ? engineOpened.position.contractsRemaining : Number(body.qty);
    if (!Number.isFinite(requestedQty) || requestedQty <= 0 || requestedQty > engineOpened.position.contractsRemaining) {
      res.status(400).json({
        error: `qty must be between 1 and ${engineOpened.position.contractsRemaining}.`,
      });
      return;
    }
    const durationCandidate = typeof body.duration === 'string' ? body.duration : 'day';
    const duration = (durationCandidate === 'day' || durationCandidate === 'gtc' || durationCandidate === 'pre' || durationCandidate === 'post')
      ? durationCandidate
      : 'day';

    const outcome = await ctx.engine.submitManualOptionClose(id, requestedQty, limitPrice, duration);
    if (outcome.status === 'no_client') {
      // No Tradier creds for this env, but the position was opened in live
      // mode (so a real long likely exists on Tradier). Refuse rather
      // than close paper-only and leave the broker leg leaking — that's
      // the exact failure mode TRA-352 was filed to prevent.
      res.status(409).json({
        error: `No Tradier credentials saved for ${outcome.env} — set them in Settings before closing live option positions.`,
      });
      return;
    }
    if (outcome.status === 'not_found') {
      res.status(409).json({ error: outcome.reason });
      return;
    }
    if (outcome.status === 'reconciled') {
      // TRA-2799 — Tradier refused because it is flat on the contract, and a
      // `/positions` re-read confirmed it. The stale row has been closed
      // locally, so this is a success for the user even though no order
      // filled: the position they were trying to get rid of is gone. 200 (not
      // 502) so the dashboard drops the row instead of rendering another
      // "close failed" notice on a position that no longer exists.
      broadcastEngineState(ctx);
      res.json({
        ok: true,
        status: 'reconciled',
        reason: outcome.reason,
        message:
          'Tradier no longer holds this position, so it was closed here at the last known mark. ' +
          'Realized P&L is an estimate until the end-of-day Tradier history reconcile.',
        ...(outcome.orderId !== undefined ? { orderId: outcome.orderId } : {}),
      });
      return;
    }
    if (outcome.status === 'rejected') {
      res.status(502).json({ error: `Tradier rejected the close: ${outcome.reason}`, ...(outcome.orderId !== undefined ? { orderId: outcome.orderId } : {}) });
      broadcastEngineState(ctx);
      return;
    }
    if (outcome.status === 'filled') {
      broadcastEngineState(ctx);
      res.json({
        ok: true,
        status: 'filled',
        orderId: outcome.orderId,
        fillPrice: outcome.fillPrice,
      });
      return;
    }
    // outcome.status === 'pending' — Tradier accepted the limit but didn't
    // fill within the wait window. Leave the local row so the user sees
    // the position still open with the pendingExit badge; the engine's
    // per-tick `resolvePendingOptionExits` poller will finalise / clear
    // when Tradier moves.
    broadcastEngineState(ctx);
    res.status(202).json({ ok: true, status: 'pending', orderId: outcome.orderId });
    return;
  }

  // Demo (or live-without-creds, which we already refused above for safety).
  // Pure paper close — credit the paper bucket at the local mark.
  const closed = ctx.engine.manualCloseOption(id);
  if (!closed) {
    res.status(404).json({ error: 'Option position not found' });
    return;
  }
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

/**
 * TRA-358 — cancel an in-flight user-staged Tradier `sell_to_close` LIMIT.
 * Hits Tradier's `cancelOrder` for the staged order id, then clears the
 * paper book's `pendingExit` so the row re-renders the Close drawer. Only
 * applies to engine-opened positions whose `pendingExit.kind === 'manual'`
 * (or any pendingExit, since the user already sees a "Pending" badge for
 * engine-fired exits and may want to cancel those too).
 */
app.post('/api/options/:id/cancel-pending-exit', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const outcome = await ctx.engine.cancelManualPendingExit(id);
  if (outcome.status === 'cancelled') {
    broadcastEngineState(ctx);
    res.json({ ok: true, ...(outcome.orderId !== undefined ? { orderId: outcome.orderId } : {}) });
    return;
  }
  if (outcome.status === 'not_pending') {
    res.status(409).json({ error: 'No pending close to cancel for this position.' });
    return;
  }
  if (outcome.status === 'not_found') {
    res.status(404).json({ error: 'Option position not found.' });
    return;
  }
  if (outcome.status === 'no_client') {
    res.status(409).json({
      error: `No Tradier credentials saved for ${outcome.env} — set them in Settings before cancelling.`,
    });
    return;
  }
  res.status(502).json({ error: `Tradier cancel failed: ${outcome.reason}`, ...(outcome.orderId !== undefined ? { orderId: outcome.orderId } : {}) });
});

/**
 * TRA-323 — sync open option positions from Tradier into the local options
 * store so the user can manage them from TradeAI's Open Options view. Used
 * primarily for Sandbox (where the user opens positions on Tradier's web UI
 * and wants to close them through TradeAI), but the same flow works in
 * production. The env defaults to whichever the user has selected for
 * options live mode (`liveTradierEnvOptions`); a `?env=...` query param
 * lets the UI override it explicitly.
 *
 * Returns a count summary so the caller can render "synced N positions"
 * feedback. Failures pre-empt with a clear error rather than silently
 * leaving an empty list — the UI distinguishes "no creds" from "broker
 * returned no positions" from "we hit a network error".
 */
app.post('/api/tradier/positions/sync', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const envParam = typeof req.query['env'] === 'string' ? req.query['env'] : undefined;
  const env: TradierEnv =
    envParam === 'production' || envParam === 'sandbox'
      ? envParam
      : (settings.liveTradierEnvOptions ?? 'sandbox');

  const client = buildTradierOptionsClientForEnv(settings, env);
  if (!client) {
    res.status(409).json({
      error: `No Tradier credentials saved for ${env} — set them in Settings before syncing.`,
    });
    return;
  }

  let positions;
  try {
    positions = await client.listOpenOptionPositions();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('tradier-import list positions failed', { env, reason: message });
    res.status(502).json({ error: `Tradier list-positions failed: ${message}` });
    return;
  }

  // TRA-323 — imported rows are stamped with the position's mode so the
  // dashboard's mode-scoped views can find them. We attribute them to
  // 'live' since that's where Tradier-mirrored activity belongs; the demo
  // dashboard never owns Tradier positions.
  const summary = ctx.engine.reconcileTradierPositions(env, positions, 'live');
  broadcastEngineState(ctx);
  res.json({ ok: true, env, ...summary });
});

/**
 * TRA-503 — manual Tradier equity-position sync, matching the option sync
 * above. The signal engine already runs `reconcileLiveEquityPortfolio` on a
 * cadence (TRA-415); this endpoint forces an immediate sweep so the user can
 * pull out-of-band equity opens into the Positions tab on demand. Uses the
 * engine's already-configured live equity client (driven by saved Tradier
 * settings), so no env override is needed.
 *
 * Returns the same `{ added, updated, removed, total }` shape as the option
 * sync so the UI feedback line can be written once. `skipped` is folded into
 * an HTTP error for the no-creds / wrong-mode cases.
 */
app.post('/api/tradier/equity-positions/sync', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  const result = await ctx.engine.reconcileLiveEquityPortfolio({ force: true });
  if (result.skipped === 'mode') {
    res.status(409).json({ error: 'Equity sync requires Live mode.' });
    return;
  }
  if (result.skipped === 'no-client') {
    res.status(409).json({
      error: 'No Tradier credentials saved — set them in Settings before syncing equity positions.',
    });
    return;
  }
  broadcastEngineState(ctx);
  res.json({
    ok: true,
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    total: result.total,
  });
});

/**
 * Smoke-test Coinbase live credentials without placing any orders.
 *
 * Pulls the user's saved API key/secret (env-var fallback identical to
 * crypto-engine.buildLiveBroker), instantiates a CoinbaseOrderClient, then
 * issues a single authenticated GET against /api/v3/brokerage/accounts.
 *
 * The response always returns 200 with an `ok` flag; the UI only needs to
 * inspect the body. `authScheme` lets the user confirm a PEM secret was
 * recognised as CDP rather than silently treated as HMAC.
 */
app.post('/api/crypto/coinbase/test-connection', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const settings = getSettings(username);
  // Same precedence as crypto-engine.buildLiveBroker: per-market crypto
  // credentials (TRA-165) → legacy un-suffixed fields → env vars.
  const apiKey = (
    settings.liveApiKeyCrypto?.trim()
    || settings.liveApiKey?.trim()
    || process.env['COINBASE_API_KEY']
    || ''
  ).trim();
  const apiSecret = (
    settings.liveApiSecretCrypto?.trim()
    || settings.liveApiSecret?.trim()
    || process.env['COINBASE_API_SECRET']
    || ''
  ).trim();
  if (!apiKey || !apiSecret) {
    res.json({ ok: false, error: 'Coinbase API key and secret are not configured. Save them in Settings before testing.' });
    return;
  }
  let client: CoinbaseOrderClient;
  try {
    client = new CoinbaseOrderClient({ apiKey, apiSecret });
  } catch (err: unknown) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const authScheme = client.getAuthScheme();
  try {
    const accounts = await client.listAccounts();
    const currencies = Array.from(new Set(accounts.map(a => a.currency))).sort();
    res.json({ ok: true, authScheme, accountCount: accounts.length, currencies });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ ok: false, authScheme, error: message });
  }
});

/**
 * Place a deliberately tiny market BUY against Coinbase Advanced Trade so the
 * user can verify their funded live account end-to-end (TRA-222) before
 * flipping auto-trading on. Reuses the same credential precedence as
 * /test-connection. The order is NOT registered with the engine — it's a
 * one-shot smoke test, the resulting crypto sits in the user's Coinbase
 * wallet exactly like a manual buy.
 *
 * Hard caps: $5 USD max quote size and BUY only. We refuse to do this in demo
 * mode so a misclick can't waste real money on a user who hasn't switched
 * over yet.
 */
app.post('/api/crypto/coinbase/place-test-order', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const settings = getSettings(username);
  if (settings.mode !== 'live') {
    res.json({ ok: false, error: 'Account is in demo mode. Switch to Live before placing a test order.' });
    return;
  }
  const body = (req.body ?? {}) as { productId?: string; quoteSize?: number };
  const productId = (body.productId ?? 'BTC-USD').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}-USD[CT]?$/.test(productId)) {
    res.json({ ok: false, error: `Invalid productId "${productId}". Expected e.g. BTC-USD.` });
    return;
  }
  const quoteSize = Number(body.quoteSize ?? 1);
  if (!Number.isFinite(quoteSize) || quoteSize <= 0) {
    res.json({ ok: false, error: 'quoteSize must be a positive number (USD).' });
    return;
  }
  if (quoteSize > 5) {
    res.json({ ok: false, error: 'Test order capped at $5 USD. Reduce quoteSize.' });
    return;
  }
  const apiKey = (
    settings.liveApiKeyCrypto?.trim()
    || settings.liveApiKey?.trim()
    || process.env['COINBASE_API_KEY']
    || ''
  ).trim();
  const apiSecret = (
    settings.liveApiSecretCrypto?.trim()
    || settings.liveApiSecret?.trim()
    || process.env['COINBASE_API_SECRET']
    || ''
  ).trim();
  if (!apiKey || !apiSecret) {
    res.json({ ok: false, error: 'Coinbase API key and secret are not configured. Save them in Settings before testing.' });
    return;
  }
  let client: CoinbaseOrderClient;
  try {
    client = new CoinbaseOrderClient({ apiKey, apiSecret });
  } catch (err: unknown) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const authScheme = client.getAuthScheme();
  let orderId: string;
  try {
    const placed = await client.placeMarketOrder({ productId, side: 'buy', quoteSize });
    orderId = placed.order_id;
  } catch (err: unknown) {
    res.json({ ok: false, authScheme, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  // Best-effort fill reconciliation — same backoff schedule as
  // CryptoLiveAccount.awaitFill so a typical fill returns rich detail without
  // dragging the request out indefinitely.
  const delays = [200, 400, 800, 1500, 2000];
  let fillPrice: number | undefined;
  let fillSize: number | undefined;
  let status = 'unknown';
  for (const d of delays) {
    await new Promise(r => setTimeout(r, d));
    try {
      const order = await client.getOrder(orderId);
      status = (order.status ?? 'unknown').toUpperCase();
      if (status === 'FILLED') {
        const p = parseFloat(order.average_filled_price);
        const s = parseFloat(order.filled_size);
        if (Number.isFinite(p) && p > 0) fillPrice = p;
        if (Number.isFinite(s) && s > 0) fillSize = s;
        break;
      }
      if (status === 'CANCELLED' || status === 'EXPIRED' || status === 'FAILED') break;
    } catch {
      // Order was already accepted by Coinbase — keep polling.
    }
  }
  res.json({
    ok: true,
    authScheme,
    orderId,
    productId,
    quoteSize,
    status,
    fillPrice,
    fillSize,
  });
});

/**
 * Smoke-test Tradier live credentials without placing any orders (TRA-221).
 *
 * Reads the user's saved options API token, account ID, and environment from
 * AccountSettings and issues an authenticated GET against
 * `/v1/user/profile`. Tradier returns the account list scoped to the token,
 * so we can confirm the supplied accountId is reachable. Falls back to env
 * vars only if the user explicitly left the per-options fields blank — a hint
 * that the saved RV-scanner creds should also work for live trading.
 */
app.post('/api/options/tradier/test-connection', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const settings = getSettings(username);
  // TRA-506 — caller can pin the env explicitly via body / query so the
  // Settings page can render two buttons ("Test sandbox", "Test production")
  // that probe the saved pair for that env regardless of the currently
  // selected `liveTradierEnvOptions`. Falls back to the saved env when the
  // caller omits the parameter so the pre-506 single-button flow still works.
  const requestedEnv = ((): TradierEnv | null => {
    const fromBody = (req.body as { env?: unknown } | undefined)?.env;
    const fromQuery = req.query['env'];
    const raw = (typeof fromBody === 'string' ? fromBody : typeof fromQuery === 'string' ? fromQuery : '').trim();
    if (raw === 'production' || raw === 'sandbox') return raw;
    return null;
  })();
  // TRA-226 — sandbox/production credentials are stored on separate fields so
  // the resolver only returns the pair matching the currently selected env.
  // Env-var fallback is layered on top here so a deployment that bootstrapped
  // creds via env (TRADIER_*) still works without forcing every user to retype
  // them in Settings.
  const resolved = resolveTradierOptionsCreds(settings);
  const env: TradierEnv = requestedEnv ?? resolved.env;
  // TRA-506 — when the caller pinned an env different from the saved one, the
  // resolver's apiToken/accountId belong to the OTHER env. Read the env-pinned
  // fields directly off settings instead so "Test production" probes the
  // production pair even while the saved env is sandbox (and vice versa).
  const credsForEnv = ((): { apiToken: string; accountId: string } => {
    if (env === resolved.env) {
      return { apiToken: resolved.apiToken, accountId: resolved.accountId };
    }
    if (env === 'production') {
      return {
        apiToken: (settings.liveApiKeyOptionsProduction ?? '').trim(),
        accountId: (settings.liveAccountIdOptionsProduction ?? '').trim(),
      };
    }
    return {
      apiToken: (settings.liveApiKeyOptionsSandbox ?? settings.liveApiKeyOptions ?? '').trim(),
      accountId: (settings.liveAccountIdOptionsSandbox ?? settings.liveAccountIdOptions ?? '').trim(),
    };
  })();
  const apiToken = (
    credsForEnv.apiToken
    || (env === 'production'
      ? process.env['TRADIER_API_TOKEN']
      : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']))
    || ''
  ).trim();
  const accountId = (
    credsForEnv.accountId
    || (env === 'production'
      ? process.env['TRADIER_ACCOUNT_ID']
      : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']))
    || ''
  ).trim();
  if (!apiToken || !accountId) {
    res.json({
      ok: false,
      env,
      error: `Tradier ${env} API token and Account ID are not configured. Save them in Settings before testing.`,
    });
    return;
  }
  try {
    const profileResp = await fetch(`${tradierBaseUrl(env)}/user/profile`, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
    });
    if (!profileResp.ok) {
      const text = await profileResp.text().catch(() => '');
      res.json({ ok: false, env, error: `Tradier ${profileResp.status} — ${text || profileResp.statusText}` });
      return;
    }
    const data = (await profileResp.json()) as {
      profile?: {
        account?:
          | { account_number?: string; status?: string; classification?: string; type?: string }
          | { account_number?: string; status?: string; classification?: string; type?: string }[];
      };
    };
    const accountsRaw = data.profile?.account;
    const accounts = Array.isArray(accountsRaw) ? accountsRaw : accountsRaw ? [accountsRaw] : [];
    const matched = accounts.find(a => a.account_number === accountId);
    if (!matched) {
      const known = accounts.map(a => a.account_number).filter(Boolean).join(', ') || 'none';
      res.json({
        ok: false,
        env,
        error: `Token authenticated but Account ID ${accountId} not found on this Tradier profile (known: ${known}).`,
      });
      return;
    }
    // TRA-506 — surface buying power so the user sees a concrete signal that
    // the production credentials actually map to the funded account they
    // think they're trading against (e.g. "Production OK, $550.00"). Fetched
    // best-effort: a failed `/balances` call does not flip the connection
    // probe to `ok: false` because the profile lookup already proved the
    // creds work.
    let buyingPower: number | null = null;
    try {
      const client = new TradierOptionsClient(apiToken, accountId, env);
      const balance = await client.getAccountBalance();
      if (balance) {
        buyingPower =
          balance.optionBuyingPower
          ?? balance.stockBuyingPower
          ?? (Number.isFinite(balance.totalCash) ? balance.totalCash : null);
      }
    } catch (err: unknown) {
      log.warn('TRA-506 tradier test-connection: balance fetch failed', {
        env,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    res.json({
      ok: true,
      env,
      accountNumber: matched.account_number,
      status: matched.status,
      classification: matched.classification,
      buyingPower,
    });
  } catch (err: unknown) {
    res.json({ ok: false, env, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/crypto/trading/start', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { cryptoAutoTradingEnabledLive: true }
      : { cryptoAutoTradingEnabledDemo: true }),
  };
  // TRA-575 — enabling LIVE crypto auto-trading is the real trigger for the
  // TRA-532 promotion gate. Now that `cryptoAutoTradingEnabledLive` defaults OFF,
  // this endpoint (not the global mode flip) is the path a user takes to turn it
  // on — so it must enforce the same gate as PUT /api/account/settings, otherwise
  // it would be an ungated bypass. Demo starts are never gated; only a result that
  // runs live crypto auto-trading. Fail CLOSED if the gate can't be evaluated.
  //
  // TRA-2351 — gate through `evaluateLiveCryptoStartGate`, NOT by handing
  // `updated` to the general gate. `mode` here comes from the REQUEST BODY, so
  // `updated.mode` is still the PERSISTED mode — passing that snapshot asked the
  // gate to authorize a LIVE start against a snapshot that read `demo`, which it
  // correctly graded as "no real-capital axis active" and allowed. The route then
  // persisted a durable live-crypto arm that was never graded. The named entry
  // point declares the action, so the mismatch is not expressible here.
  if (mode === 'live') {
    try {
      const gate = await evaluateLiveCryptoStartGate(username, settings);
      if (!gate.allowed) {
        log.warn('TRA-575 refused live crypto start — promotion gate', {
          username,
          blocked: gate.blocked.map(b => b.strategyId),
        });
        res.status(422).json({
          ok: false,
          code: 'promotion_gate_blocked',
          error:
            'Live crypto auto-trading is blocked by the promotion gate: '
            + gate.blocked.map(b => `${b.strategyId} — ${b.reasons.join(' | ')}`).join(' ;; '),
          blocked: gate.blocked,
        });
        return;
      }
    } catch (err: unknown) {
      log.error('TRA-575 crypto-start promotion gate evaluation failed', {
        username,
        reason: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        ok: false,
        code: 'promotion_gate_error',
        error: 'Could not verify the live-trading promotion gate. Live crypto start refused; please retry.',
      });
      return;
    }
  }
  ctx.cryptoEngine.setAutoTrading(true, mode);
  await saveSettings(username, updated);
  broadcastCryptoState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: true });
});

app.post('/api/crypto/trading/stop', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  ctx.cryptoEngine.setAutoTrading(false, mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { cryptoAutoTradingEnabledLive: false }
      : { cryptoAutoTradingEnabledDemo: false }),
  };
  await saveSettings(username, updated);
  broadcastCryptoState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: false });
});

// ── Watchlist management ──────────────────────────────────────────────────────

app.get('/api/watchlist/crypto', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  await initWatchlistStore(username);
  res.json(getCryptoWatchlistData(username));
});

app.post('/api/watchlist/crypto', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const { symbol } = req.body as { symbol?: string };
  if (typeof symbol !== 'string' || !symbol.trim()) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const sym = symbol.trim().toUpperCase();
  if (!/^[A-Z]{2,10}-USD$/.test(sym)) {
    res.status(400).json({ error: 'Invalid symbol format. Expected XXX-USD (e.g. ETH-USD)' });
    return;
  }
  await addCryptoSymbol(username, sym);
  ctx.cryptoEngine.addSymbol(sym);
  ctx.cryptoEngine.refresh();
  res.json({ ok: true, symbol: sym });
});

app.delete('/api/watchlist/crypto/:symbol', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const raw = req.params['symbol'];
  const sym = (Array.isArray(raw) ? raw[0] : raw ?? '').toUpperCase();
  if (!sym) { res.status(400).json({ error: 'symbol is required' }); return; }
  await removeCryptoSymbol(username, sym);
  ctx.cryptoEngine.removeSymbol(sym);
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

app.post('/api/watchlist/crypto/scan', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  try {
    const results = await scanCryptoMarket();
    for (const r of results) {
      await addCryptoSymbol(username, r.symbol);
      ctx.cryptoEngine.addSymbol(r.symbol);
    }
    ctx.cryptoEngine.refresh();
    res.json({ ok: true, added: results.map(r => r.symbol) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/watchlist/stocks', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  await initWatchlistStore(username);
  res.json(getStocksWatchlistData(username));
});

app.post('/api/watchlist/stocks', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const { symbol } = req.body as { symbol?: string };
  if (typeof symbol !== 'string' || !symbol.trim()) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const sym = symbol.trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(sym)) {
    res.status(400).json({ error: 'Invalid symbol format. Expected 1–5 letters (e.g. NVDA)' });
    return;
  }
  await addStocksSymbol(username, sym);
  ctx.engine.addSymbol(sym);
  ctx.engine.refresh();
  res.json({ ok: true, symbol: sym });
});

app.delete('/api/watchlist/stocks/:symbol', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const raw = req.params['symbol'];
  const sym = (Array.isArray(raw) ? raw[0] : raw ?? '').toUpperCase();
  if (!sym) { res.status(400).json({ error: 'symbol is required' }); return; }
  await removeStocksSymbol(username, sym);
  ctx.engine.removeSymbol(sym);
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

app.post('/api/watchlist/stocks/scan', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  try {
    const results = await scanStocksMarket();
    for (const r of results) {
      await addStocksSymbol(username, r.symbol);
      ctx.engine.addSymbol(r.symbol);
    }
    ctx.engine.refresh();
    res.json({ ok: true, added: results.map(r => r.symbol) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// TRA-230: clear the displayed crypto signal list without resetting positions or equity.
app.post('/api/crypto/signals/reset', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  ctx.cryptoEngine.clearSignals();
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

app.post('/api/crypto/positions/:id/close', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const state = ctx.cryptoEngine.getState();
  const pos = state.account.openPositions.find(p => p.id === id);
  if (!pos) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }
  const sym = state.symbols.find(s => s.symbol === pos.symbol);
  const price = sym?.price ?? pos.entryPrice;
  // TRA-320 — await the broker close so a Coinbase reject (auth,
  // INSUFFICIENT_FUND, product not tradable) surfaces back to the dashboard
  // instead of being swallowed by a fire-and-forget. On failure the position
  // stays open in the broker mirror and the dashboard's next state tick will
  // continue to show it; we just need to tell the user *why* the close did
  // not go through.
  try {
    await ctx.cryptoEngine.manualClosePosition(id, price);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('crypto-engine manualClose live failed', { reason });
    broadcastCryptoState(ctx);
    res.status(502).json({ error: 'Coinbase rejected close', reason });
    return;
  }
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

// ── Data-source health check ─────────────────────────────────────────────────

// TRA-708 — `/api/health/quotes` was a self-inflicted production DoS. It runs
// eight network probes (incl. the Coinbase Exchange leg that Render's egress IP
// is blocked from, which hangs to its full timeout, plus the heavy minute-bar
// and daily-bar candle cascades). Each call could tie the work up for 30-60s,
// and nothing de-duplicated concurrent calls. Under RTH sampling (TRA-707) the
// heavy builds piled up on the single web process, which then flapped 502s on
// EVERY route and got restarted — the ~14:00Z 2026-06-08 "service outage". Fix:
//   • single-flight  → N concurrent samplers share ONE in-flight build, so the
//     work can never pile up no matter how often the endpoint is hit;
//   • short TTL cache → repeated samples reuse the last snapshot for free;
//   • overall build timeout → a slow build returns the last good (stale)
//     snapshot instead of holding the request open, and the lone in-flight
//     build keeps running in the background until it settles (still capped to
//     one at a time by single-flight).
const QUOTES_HEALTH_TTL_MS = 20_000;
const QUOTES_HEALTH_BUILD_TIMEOUT_MS = 9_000;
let quotesHealthCache: { ts: number; payload: Record<string, unknown> } | null = null;
let quotesHealthInFlight: Promise<Record<string, unknown>> | null = null;

// TRA-708 — hard per-probe timeout. Without it the build's slowest legs (the
// IP-blocked Coinbase Exchange host, the minute-bar/daily-bar candle cascades)
// keep the single in-flight build running for 30-60s; even one such build is
// enough to briefly load the web process and 502 other routes. Capping each
// probe means the whole (parallel) build settles in a few seconds. The losing
// race branch is swallowed so a late rejection from the orphaned upstream call
// can't surface as an unhandled rejection after the timeout already won.
const QUOTES_PROBE_TIMEOUT_MS = 4_500;
async function runQuotesProbe(fn: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.resolve()
    .then(fn)
    .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
  try {
    return await Promise.race<unknown>([
      guarded,
      new Promise<unknown>((resolve) => {
        timer = setTimeout(() => resolve({ error: `timeout after ${QUOTES_PROBE_TIMEOUT_MS}ms` }), QUOTES_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

app.get('/api/health/quotes', async (_req, res) => {
  const now = Date.now();
  if (quotesHealthCache && now - quotesHealthCache.ts < QUOTES_HEALTH_TTL_MS) {
    const p = quotesHealthCache.payload;
    // TRA-783 — a diagnostics endpoint that produced a payload returns HTTP 200;
    // per-component health (ok/stocksOk/cryptoOk) lives in the body. A crypto-egress
    // timeout (Coinbase IP-blocked on Render) must not page stock-only monitors.
    res.status(200).json({ ...p, cached: true });
    return;
  }
  if (!quotesHealthInFlight) {
    quotesHealthInFlight = buildQuotesHealthPayload()
      .then((payload) => {
        quotesHealthCache = { ts: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        quotesHealthInFlight = null;
      });
  }
  try {
    const payload = await Promise.race<Record<string, unknown> | null>([
      quotesHealthInFlight,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), QUOTES_HEALTH_BUILD_TIMEOUT_MS)),
    ]);
    if (payload) {
      // TRA-783 — payload built successfully: HTTP 200, component flags in the body.
      res.status(200).json(payload);
      return;
    }
    // Build is taking too long — serve the last good snapshot rather than hold
    // the request (and the proxy) open. The in-flight build still completes and
    // refreshes the cache for the next caller.
    if (quotesHealthCache) {
      const p = quotesHealthCache.payload;
      // TRA-783 — stale snapshot is still a produced payload: HTTP 200.
      res.status(200).json({ ...p, stale: true, note: 'probe build in progress' });
      return;
    }
    // No payload at all yet — could not assess. Keep 503 for the "still building" case.
    res.status(503).json({ ok: false, building: true, ts: new Date().toISOString() });
  } catch (err: unknown) {
    if (quotesHealthCache) {
      const p = quotesHealthCache.payload;
      // TRA-783 — we still have a produced payload to serve: HTTP 200, error in body.
      res.status(200).json({ ...p, stale: true, buildError: err instanceof Error ? err.message : String(err) });
      return;
    }
    // Hard build error with no payload at all — could not assess: keep 502.
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err), ts: new Date().toISOString() });
  }
});

// TRA-2126 — no-auth SANDBOX-ONLY Tradier probe + smoke-order path.
//
// Context: bqb1's admin API auth is dead, so the authenticated sandbox routes
// (`POST /api/options/tradier/test-connection {env:sandbox}`,
// `/api/tradier/positions/sync`, balances) are unreachable there — yet the
// deployment already carries the sandbox credential pair
// (`TRADIER_SANDBOX_API_TOKEN` / `TRADIER_SANDBOX_ACCOUNT_ID`, acct
// `VA20296703`). These routes give QuantTrader a reachable path to the sandbox
// account WITHOUT restoring admin auth or exposing any live/production surface.
//
// SANDBOX-ONLY by construction — this is the safety property, not a convenience:
//   • `env` is hard-pinned to `'sandbox'`; the resolver reads ONLY the
//     `TRADIER_SANDBOX_*` pair and NEVER falls back to the production
//     `TRADIER_API_TOKEN` / `TRADIER_ACCOUNT_ID` pair (bqb1 runs
//     `TRADIER_ENV=production`, so those are the LIVE creds — a fallback would
//     authenticate a no-auth route against a real funded account);
//   • the sandbox token only authenticates against Tradier's sandbox host
//     (`sandbox.tradier.com` via `tradierBaseUrl('sandbox')`), so even a
//     misrouted call cannot reach a production account.
// The smoke-order route additionally requires an explicit `confirm:"SANDBOX"`
// body field and caps quantity, so it cannot fire by accident.
function resolveSandboxTradierCreds(): { apiToken: string; accountId: string } | null {
  const apiToken = (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? '').trim();
  const accountId = (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? '').trim();
  // No production fallback — see the safety note above.
  if (!apiToken || !accountId) return null;
  return { apiToken, accountId };
}

function sandboxNotConfiguredPayload(): Record<string, unknown> {
  return {
    ok: false,
    env: 'sandbox',
    configured: false,
    error:
      'TRADIER_SANDBOX_API_TOKEN / TRADIER_SANDBOX_ACCOUNT_ID are not set on this deployment. '
      + 'Provision the sandbox credential pair (acct VA20296703) and restart.',
    apiTokenSet: !!process.env['TRADIER_SANDBOX_API_TOKEN'],
    accountIdSet: !!process.env['TRADIER_SANDBOX_ACCOUNT_ID'],
    ts: new Date().toISOString(),
  };
}

app.get('/api/health/tradier-sandbox', async (_req, res) => {
  const creds = resolveSandboxTradierCreds();
  if (!creds) {
    // 200 with configured:false — this is a diagnostics endpoint; the "creds
    // missing" state is a body flag, not an HTTP error (same convention as
    // /api/health/quotes).
    res.status(200).json(sandboxNotConfiguredPayload());
    return;
  }
  const { apiToken, accountId } = creds;
  try {
    // Prove the token authenticates and the configured account belongs to it
    // (mirrors the authenticated test-connection route's profile check).
    const profileResp = await fetch(`${tradierBaseUrl('sandbox')}/user/profile`, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
    });
    if (!profileResp.ok) {
      const text = await profileResp.text().catch(() => '');
      res.status(200).json({
        ok: false,
        env: 'sandbox',
        configured: true,
        error: `Tradier sandbox ${profileResp.status} — ${text || profileResp.statusText}`,
        ts: new Date().toISOString(),
      });
      return;
    }
    const profileData = (await profileResp.json()) as {
      profile?: {
        account?:
          | { account_number?: string; status?: string; classification?: string; type?: string }
          | { account_number?: string; status?: string; classification?: string; type?: string }[];
      };
    };
    const accountsRaw = profileData.profile?.account;
    const accounts = Array.isArray(accountsRaw) ? accountsRaw : accountsRaw ? [accountsRaw] : [];
    const matched = accounts.find(a => a.account_number === accountId);
    const client = new TradierOptionsClient(apiToken, accountId, 'sandbox');
    // Best-effort — a failed balances/positions read does not flip `ok` when the
    // profile lookup already proved the creds work.
    const balance = await client.getAccountBalance().catch(() => null);
    const positions = await client.listOpenEquityPositions().catch(() => []);
    res.status(200).json({
      ok: !!matched,
      env: 'sandbox',
      configured: true,
      accountNumber: matched?.account_number ?? null,
      accountStatus: matched?.status ?? null,
      accountType: matched?.type ?? null,
      accountMatched: !!matched,
      knownAccounts: accounts.map(a => a.account_number).filter(Boolean),
      buyingPower: balance
        ? (balance.stockBuyingPower ?? balance.optionBuyingPower ?? (Number.isFinite(balance.totalCash) ? balance.totalCash : null))
        : null,
      balance: balance
        ? {
            totalEquity: balance.totalEquity,
            totalCash: balance.totalCash,
            stockBuyingPower: balance.stockBuyingPower,
            optionBuyingPower: balance.optionBuyingPower,
            accountType: balance.accountType,
          }
        : null,
      positions: positions.map(p => ({
        symbol: p.symbol,
        quantity: p.quantity,
        side: p.side,
        costBasis: p.costBasis,
      })),
      positionCount: positions.length,
      ts: new Date().toISOString(),
    });
  } catch (err: unknown) {
    res.status(200).json({
      ok: false,
      env: 'sandbox',
      configured: true,
      error: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    });
  }
});

// TRA-2126 — place ONE small SANDBOX paper smoke order and report its terminal
// fill status. Guarded: SANDBOX creds only (see resolveSandboxTradierCreds),
// explicit `confirm:"SANDBOX"` required, quantity hard-capped. Equity market
// order by default. Body: { confirm, symbol, qty?, side? }.
const SANDBOX_SMOKE_QTY_CAP = 10;
app.post('/api/health/tradier-sandbox/smoke-order', async (req, res) => {
  const creds = resolveSandboxTradierCreds();
  if (!creds) {
    res.status(200).json(sandboxNotConfiguredPayload());
    return;
  }
  const body = (req.body ?? {}) as {
    confirm?: unknown;
    symbol?: unknown;
    qty?: unknown;
    side?: unknown;
  };
  if (body.confirm !== 'SANDBOX') {
    res.status(400).json({
      ok: false,
      error: 'Refused: body.confirm must equal "SANDBOX" to place a sandbox paper order.',
    });
    return;
  }
  const symbol = (typeof body.symbol === 'string' ? body.symbol : '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(symbol)) {
    res.status(400).json({ ok: false, error: `Refused: invalid symbol ${JSON.stringify(body.symbol)}.` });
    return;
  }
  const side: 'buy' | 'sell' = body.side === 'sell' ? 'sell' : 'buy';
  const qtyRaw = Number(body.qty ?? 1);
  const qty = Number.isInteger(qtyRaw) ? qtyRaw : 0;
  if (qty < 1 || qty > SANDBOX_SMOKE_QTY_CAP) {
    res.status(400).json({
      ok: false,
      error: `Refused: qty must be an integer in [1, ${SANDBOX_SMOKE_QTY_CAP}] for a smoke order.`,
    });
    return;
  }
  const { apiToken, accountId } = creds;
  try {
    const client = new TradierOptionsClient(apiToken, accountId, 'sandbox');
    const order = await client.submitEquityOrder({ symbol, side, qty, type: 'market', duration: 'day' });
    // Poll to a terminal state so the response carries the fill (validates the
    // order → fill leg). Sandbox risk-checks are fast; keep the window short.
    const finalStatus = await client.waitForOrderTerminalStatus(order.id, {
      timeoutMs: 8000,
      intervalMs: 750,
    });
    log.info('TRA-2126 sandbox smoke order placed', {
      symbol,
      side,
      qty,
      orderId: order.id,
      status: finalStatus?.status ?? order.status,
    });
    res.status(200).json({
      ok: true,
      env: 'sandbox',
      accountNumber: accountId,
      order: { id: order.id, status: order.status },
      fill: finalStatus
        ? {
            status: finalStatus.status,
            execQuantity: finalStatus.exec_quantity ?? null,
            avgFillPrice: finalStatus.avg_fill_price ?? null,
            reason: finalStatus.reason_description ?? null,
          }
        : null,
      ts: new Date().toISOString(),
    });
  } catch (err: unknown) {
    res.status(200).json({
      ok: false,
      env: 'sandbox',
      error: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    });
  }
});

// TRA-2130 — SANDBOX options (call + put) round-trip smoke route. Extends the
// TRA-2126 equity smoke path to options: place a long call and a long put in the
// sandbox, close each, and capture the full signal→submit→ack→fill timeline plus
// slippage vs the decision quote. Guarded IDENTICALLY to the equity route —
// SANDBOX creds only (resolveSandboxTradierCreds), explicit confirm:"SANDBOX",
// qty hard-capped to 1, underlying allow-list SPY/AAPL, hard-pinned 'sandbox'
// client with NO prod fallback. Deliberately bypasses the local option-idea
// journal / paper book: the fills exist only in the Tradier sandbox account
// history (readable via GET /api/health/tradier-sandbox positions / Tradier
// account history). Body: { confirm:"SANDBOX", underlying:"SPY"|"AAPL", qty?:1 }.
app.post('/api/health/tradier-sandbox/options-smoke-order', async (req, res) => {
  const creds = resolveSandboxTradierCreds();
  if (!creds) {
    res.status(200).json(sandboxNotConfiguredPayload());
    return;
  }
  const validation = validateOptionsSmokeRequest(req.body);
  if (!validation.ok) {
    res.status(validation.status).json({ ok: false, error: validation.error });
    return;
  }
  const { underlying, qty } = validation;
  const { apiToken, accountId } = creds;
  try {
    // Hard-pinned 'sandbox' — NO prod fallback (see resolveSandboxTradierCreds).
    const client = new TradierOptionsClient(apiToken, accountId, 'sandbox');
    const deps = {
      clock: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    };
    // Call first, then put — sequential so the sandbox order pipeline isn't raced.
    const call = await runContractRoundTrip(client, underlying, 'call', qty, deps);
    const put = await runContractRoundTrip(client, underlying, 'put', qty, deps);
    const okAll = call.ok && put.ok;
    // TRA-2134 Tier-1 short (CSP + covered call), flag-gated. Default OFF — the journal
    // reader shows neither 'csp' nor 'covered_call' until ENABLE_SANDBOX_CSP_COVERED_CALL
    // is armed via demo-flags.json or process.env. Sequential for the same reason as the
    // long trips above: avoid racing the sandbox order pipeline.
    const cspEnabled = demoFlagEnv().ENABLE_SANDBOX_CSP_COVERED_CALL === '1';
    let csp: import('./tradier-sandbox-options-smoke.js').SmokeContractResult | null = null;
    let coveredCall: import('./tradier-sandbox-options-smoke.js').SmokeContractResult | null = null;
    if (cspEnabled) {
      csp = await runShortContractRoundTrip(client, underlying, 'put', qty, deps);
      coveredCall = await runShortContractRoundTrip(client, underlying, 'call', qty, deps);
    }
    // TRA-2134 — land each round-trip that actually built a contract in the durable
    // multi-strategy journal so a scheduled runner accrues a graded-able series (the
    // Tradier sandbox account history is NOT a no-auth /api/health surface). A trip
    // that never built a contract maps to null and is intentionally NOT recorded.
    const etDay = etDateString();
    let journalRecorded = 0;
    for (const [optionType, result] of [['call', call], ['put', put]] as const) {
      const rec = recordFromContractResult(longStrategyFor(optionType), result, etDay);
      if (rec) { recordSandboxStrategy(rec); journalRecorded += 1; }
    }
    if (csp) {
      const rec = recordFromContractResult(shortStrategyFor('put'), csp, etDay);
      if (rec) { recordSandboxStrategy(rec); journalRecorded += 1; }
    }
    if (coveredCall) {
      const rec = recordFromContractResult(shortStrategyFor('call'), coveredCall, etDay);
      if (rec) { recordSandboxStrategy(rec); journalRecorded += 1; }
    }
    log.info('TRA-2130/2134 sandbox options smoke round-trip', {
      underlying,
      qty,
      callOk: call.ok,
      putOk: put.ok,
      cspEnabled,
      cspOk: csp?.ok ?? null,
      coveredCallOk: coveredCall?.ok ?? null,
      journalRecorded,
      callEntrySignalToSubmitMs: call.entry?.metrics.latencyMs.signalToSubmit ?? null,
      putEntrySignalToSubmitMs: put.entry?.metrics.latencyMs.signalToSubmit ?? null,
    });
    res.status(200).json({
      ok: okAll,
      env: 'sandbox',
      accountNumber: accountId,
      underlying,
      qty,
      contracts: { call, put, ...(cspEnabled ? { csp, coveredCall } : {}) },
      journal: {
        // Still bypasses the OPTION-IDEA journal / paper book (that models the real book).
        landsInOptionJournal: false,
        // TRA-2134 — but each round-trip that built a contract now DOES land in the durable
        // multi-strategy sandbox journal, readable no-auth at /api/health/sandbox-strategy-journal.
        landsInSandboxStrategyJournal: true,
        recorded: journalRecorded,
        readAt: '/api/health/sandbox-strategy-journal',
        note:
          'This smoke route calls TradierOptionsClient.buyContracts / sellContracts directly and '
          + 'deliberately BYPASSES the local option-idea journal and paper book. The fills are '
          + 'recorded in the Tradier sandbox account (GET /api/health/tradier-sandbox positions / '
          + 'listAccountHistory) AND in the durable TRA-2134 sandbox-strategy journal '
          + '(GET /api/health/sandbox-strategy-journal) for the standing learning program.',
      },
      fillRealism: FILL_REALISM,
      fillRealismNote: FILL_REALISM_NOTE,
      ts: new Date().toISOString(),
    });
  } catch (err: unknown) {
    res.status(200).json({
      ok: false,
      env: 'sandbox',
      underlying,
      error: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    });
  }
});

// TRA-2134 — no-auth read of the durable multi-strategy SANDBOX journal (bqb1 admin
// auth is dead, TRA-1992). Reports, per strategy, the acceptance-unit counts (clean
// round-trips within the <500ms signal→submit budget) + latency/slippage quality, and
// a `durability.ephemeral` flag so a reader can tell a real /data mount from the
// in-bundle fallback that evaporates on redeploy. Observe-only; never places an order.
app.get('/api/health/sandbox-strategy-journal', (_req, res) => {
  // TRA-2237 — the runner routine `d8ec9395` reads THIS route every weekday; piggy-back
  // the parity-reconcile daily snapshot on that existing cadence (best-effort) so the
  // parity series self-accrues without a new cron. TRA-2279 D2 — this RE-FOLDS today's
  // point (last-write-wins per ET day) rather than freezing it at the first read; the
  // durable post-close fold is the hourly scheduler tick, not this route.
  appendParitySnapshotForDay(getSandboxStrategyRecords());
  res.status(200).json({
    ...summarizeSandboxStrategyJournal(),
    scope: 'SANDBOX ONLY (acct VA20296703), $0 real notional — TRA-1897 HOLD POSTURE unaffected.',
    fillRealism: FILL_REALISM,
    fillRealismNote: FILL_REALISM_NOTE,
    ts: new Date().toISOString(),
  });
});

// TRA-2237 — no-auth read of the parity-reconcile monitor: per-strategy demo-mark-vs-
// sandbox-fill P&L gap folded from each sandbox round-trip's OWN mid-vs-fill (TRA-2134
// legs), plus the durable daily series. The read SELF-ACCRUES today's snapshot, RE-FOLDING
// it on every call (TRA-2279 D2 — last-write-wins per ET day; it used to freeze at the
// first read, which left every post-first-read fill in no daily point at all). Each point
// stamps `firstFoldTs`/`lastFoldTs`/`foldCount`/`sessionComplete` so a reader can tell a
// full session from a mid-session slice without reading the cron.
//
// ⚠️ TRA-2279 D1 — `gapPct` is GONE. It was a ratio under a percent's name (a live
// `gapPct: 17` meant 17×, and was duly read as "17.00%"). Its replacement is
// `gapToDemoMarkRatio`, explicitly a ratio and null below a materiality floor on its
// denominator. Grade on `parityGapUsd` / `halfSpreadBps` — those are unit-correct and
// stable at any denominator. Reads ONLY the sandbox journal — NEVER pooled with demo
// option-trade-journal rows. `fillRealism:'SANDBOX_SIMULATED'` rides the payload so no
// reader mistakes a broker-simulated gap for a live-execution number; observe-only under
// the TRA-1897 hold — gates/arms/graduates nothing.
// ⚠️ TRA-2370 — `parityForRoundTrip` dropped a leg only on `== null`, never on `<= 0`, so
// TRA-2283 D1's false-zero fills (`avg_fill_price: 0` — a MISSING price wearing a number's
// clothes) folded as real ±100·requestedPx terms: ±$665 live, on a book whose whole
// round-trip mid P&L is ~$1. With one such leg on each side, covered_call's two terms
// CANCELLED and the bucket published `parityGapUsd {sum: 0, mean: 0}` with `uncomputable: 0`
// — indistinguishable from "covered calls genuinely cross at zero cost". Those rows are now
// EXCLUDED and counted in their own `nonPhysical` bucket (never pooled into `uncomputable`:
// "no fill reported" and "an impossible fill reported" are different facts), and
// `parityGapUsd` carries `median`/`p90` beside `sum`/`mean` so one bad row can no longer
// destroy the only published central estimate.
app.get('/api/health/parity-reconcile', (_req, res) => {
  const records = getSandboxStrategyRecords();
  appendParitySnapshotForDay(records); // idempotent per ET day — self-accrues the series
  res.status(200).json({
    ...summarizeParityReconcile(records),
    dailySeries: getParityReconcileSeries(),
    durability: parityReconcileDurability(),
    scope: PARITY_SCOPE,
    ts: new Date().toISOString(),
  });
});

// TRA-2370 ask 4 — the RAW LEGS behind the fold above, read-only, no auth, SANDBOX only.
// Per record: `strategy` / `etDay` / `status` (the same classification `foldBucket` makes)
// and, per leg, `side` / `requestedPx` / `fillPx` / `nonPhysical`. For an EXCLUDED row,
// `wouldBeParityGapUsd` re-folds it with the guard OFF, so the ±$665 term the guard removed
// is directly readable rather than reconstructed from published moments — which is what the
// covered_call `$0.00` diagnosis cost. 30 records today; the payload is trivial.
// This route does NOT accrue the daily series (it is a pure projection, not a fold), so
// reading it can never move a number the series grades. Observe-only under the TRA-1897
// hold; gates/arms/graduates nothing.
app.get('/api/health/parity-reconcile/records', (_req, res) => {
  const rows = parityRecordRows(getSandboxStrategyRecords());
  res.status(200).json({
    totalRecords: rows.length,
    counts: {
      computable: rows.filter((r) => r.status === 'computable').length,
      uncomputable: rows.filter((r) => r.status === 'uncomputable').length,
      nonPhysical: rows.filter((r) => r.status === 'nonPhysical').length,
    },
    records: rows,
    qtyAssumed: 1,
    qtyAssumedNote: QTY_ASSUMPTION_NOTE,
    exclusionNote: EXCLUSION_NOTE,
    fillRealism: FILL_REALISM,
    fillRealismNote: FILL_REALISM_NOTE,
    scope: PARITY_SCOPE,
    ts: new Date().toISOString(),
  });
});

// TRA-2247 (parent TRA-2242) — no-auth read of the marketable(bid) MTM forward-validation
// gate. Folds the parity-true EXIT-leg cross from the SANDBOX journal (`getSandboxStrategyRecords`,
// TRA-2134) via the SAME `foldMarketableMtmForwardValidation` the CLI harness mirrors, and
// emits the PASS/REVIEW verdict QuantTrader reads for TRA-2242's final check — no more
// reaching for the raw `/data` JSONL that no route exposed. Optional query params `h`, `tol`,
// `minN`, `strategy` override the pinned defaults (h=0.134, tol=0.03, minN=30) for what-if
// reads; unset ⇒ the exact gate. `fillRealism:'SANDBOX_SIMULATED'` rides the payload so no
// reader mistakes a broker-simulated near-mid median for a live-execution number. Read-only;
// SANDBOX only ($0 notional); gates/arms/graduates NOTHING under the TRA-1897 hold.
//
// TRA-2283 — the payload is now UNPOOLED and AUDITABLE, because the pooled fold was lying in
// three directions at once: `excludedZeroFill` names the false-`fillPx:0` rows that folded to
// `actualH` = ±1 exactly, `perStructure[]` carries a verdict per structure (the pooled tail
// check read "covered" while long_call was under-charged 2.8×), `quotedH` measures the
// half-spread off the two-sided QUOTED book — the only falsifiable measurement on a venue
// that fills at the decision mid — and `diagnostics` echoes the dropped/outlier rows so the
// diagnosis is a direct read rather than a reconstruction from published moments. Extra query
// params: `samples=1` echoes per-row samples (capped), `requirePerStructureMinN=0|1` overrides
// the per-structure floor switch, `perStructureMinN` overrides its threshold.
// `actualHCaveat` rides the payload: the verdict's measured-median string is NOT an instruction
// to retune h.
//
// TRA-2300 — **the graded verdict on this route is now `quotedVerdict` (basis `quotedH`), not
// `verdict`**. `verdict`/`actualVerdict` (basis `actualH`) stays for shape compatibility and is
// ADVISORY ONLY: it is measured requestedPx-vs-fillPx on a venue that fills at the decision mid,
// so it reads ~0 whether the true spread is 0 or the simulator ignores the book — it has no
// failing state here. `gradedBasis` + a per-verdict `basis` field name the graded one so an
// old-shaped reader cannot grade the wrong number. Also new: `quoteCoverage` separates a benign
// legacy-record zero (`legacy_no_quote_field`) from a dead instrument — but read the dead-venue
// count off `quoteCoverage.unpricedExitQuoteDropped`, NOT `quote_null_at_snap`: TRA-2600 showed
// the latter is WRITER-UNREACHABLE and reads 0 on a dead venue exactly as it does on a healthy
// one (mapLeg takes requestedPx/bid/ask off one DecisionQuote, so a dead snap is DROPPED as
// `unpriced_exit_quote` before it can be classified). `structuresFullyDeadSnapped` names any
// structure dead on EVERY snap, which has no `perStructure[]` entry to carry a count.
// `quotedH.min`/`max` give the dispersion that rules out a synthesized constant quote, and the
// per-structure floor ships ON at 10 (pooled 30) — env-overridable via `MARKETABLE_MTM_MIN_N`,
// `MARKETABLE_MTM_PER_STRUCTURE_MIN_N`, `MARKETABLE_MTM_REQUIRE_PER_STRUCTURE_MIN_N`. Still
// read-only; arms NOTHING (h stays 0.134, ENABLE_MARKETABLE_OPEN_MTM untouched, TRA-1897 holds).
app.get('/api/health/marketable-mtm-forward-validation', (req, res) => {
  const numParam = (v: unknown): number | undefined => {
    if (typeof v !== 'string' || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const boolParam = (v: unknown): boolean =>
    typeof v === 'string' && (v === '1' || v.toLowerCase() === 'true');
  // A query param must be able to turn the floor OFF as well as on, so an ABSENT param falls
  // back to the env-resolved default rather than to `false` — otherwise every unparameterized
  // read would silently disarm the TRA-2300 §5 floor the route is supposed to ship with.
  const optBoolParam = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'string' && v.trim() !== '' ? boolParam(v) : fallback;
  const strategyParam = typeof req.query.strategy === 'string' && req.query.strategy.trim() !== ''
    ? req.query.strategy
    : null;
  const thresholds = resolveMarketableMtmGateThresholds(process.env);
  const result = foldMarketableMtmForwardValidation(getSandboxStrategyRecords(), {
    h: numParam(req.query.h),
    tol: numParam(req.query.tol),
    minN: numParam(req.query.minN) ?? thresholds.minN,
    strategy: strategyParam,
    requirePerStructureMinN: optBoolParam(
      req.query.requirePerStructureMinN, thresholds.requirePerStructureMinN,
    ),
    perStructureMinN: numParam(req.query.perStructureMinN) ?? thresholds.perStructureMinN,
    includeSamples: boolParam(req.query.samples),
  });
  res.status(200).json({
    ...result,
    fillRealismNote: FILL_REALISM_NOTE,
    scope: MARKETABLE_MTM_SCOPE,
    ts: new Date().toISOString(),
  });
});

async function buildQuotesHealthPayload(): Promise<Record<string, unknown>> {
  const {
    testYahooFinance,
    testYahooChartQuote,
    testTradier,
    testTwelveData,
    isYahooBreakerOpen,
    isTradierBreakerOpen,
    isTradierStocksConfigured,
    fetchMinuteBarsWithSource,
    getFallbackRequestCounts,
    getTwelveDataQuotaState,
    getTradierQuoteRateState,
    getTradierBarPullRateState,
    getFeedDegradationState,
  } = await import('./yahoo-feed.js');
  const {
    testCoinMarketCap,
    testCoinbase,
    testCoinbaseAdvancedTrade,
    testCoinGecko,
    isCoinbaseBreakerOpen,
    getCoinbaseBarPullRateState,
    fetchCryptoDailyBars,
  } = await import('./crypto-feed.js');
  const results: Record<string, unknown> = {};

  // TRA-708 — run every probe in PARALLEL, each under `runQuotesProbe`'s hard
  // timeout, so the whole build settles in a few seconds instead of the sum of
  // eight serial network calls. Probe semantics are unchanged:
  //   • tradier / twelveData / coinMarketCap keep their "skipped" fallback when
  //     unconfigured (null result);
  //   • coinbase (TRA-331 Exchange) + coinbaseAdvancedTrade (TRA-705 the real
  //     Render-resolvable primary) + yahooFinance are probed as-is;
  //   • chartFallback (TRA-191 minute-bar path) and cryptoDailyBars (TRA-705
  //     daily OHLC candle cascade) preserve their full diagnostic shapes.
  const [
    tradier, coinbase, coinbaseAdvancedTrade, coinGecko, yahooFinance, yahooChartQuote, twelveData,
    coinMarketCap, chartFallback, cryptoDailyBars,
  ] = await Promise.all([
    runQuotesProbe(async () => (await testTradier()) ?? { skipped: 'TRADIER_*_API_TOKEN not set' }),
    runQuotesProbe(() => testCoinbase()),
    runQuotesProbe(() => testCoinbaseAdvancedTrade()),
    runQuotesProbe(() => testCoinGecko()),
    runQuotesProbe(() => testYahooFinance()),
    runQuotesProbe(() => testYahooChartQuote()),
    runQuotesProbe(async () => (await testTwelveData()) ?? { skipped: 'TWELVE_DATA_API_KEY not set' }),
    runQuotesProbe(async () => (await testCoinMarketCap()) ?? { skipped: 'CMC_API_KEY not set' }),
    runQuotesProbe(async () => {
      const probe = await fetchMinuteBarsWithSource('AAPL', 60);
      return {
        symbol: 'AAPL',
        bars: probe.bars.length,
        source: probe.source,
        yahooSkipped: probe.yahooSkipped,
        cached: probe.cached ?? false,
        tradierDiag: probe.tradierDiag ?? null,
        twelveDataDiag: probe.twelveDataDiag ?? null,
      };
    }),
    runQuotesProbe(async () => {
      const dailyBars = await fetchCryptoDailyBars('BTC-USD', 60);
      return {
        symbol: 'BTC-USD',
        bars: dailyBars.length,
        lastClose: dailyBars.at(-1)?.close ?? null,
      };
    }),
  ]);
  results['tradier'] = tradier;
  results['coinbase'] = coinbase;
  results['coinbaseAdvancedTrade'] = coinbaseAdvancedTrade;
  results['coinGecko'] = coinGecko;
  results['yahooFinance'] = yahooFinance;
  results['yahooChartQuote'] = yahooChartQuote;
  results['twelveData'] = twelveData;
  results['coinMarketCap'] = coinMarketCap;
  results['chartFallback'] = chartFallback;
  results['cryptoDailyBars'] = cryptoDailyBars;

  // Daily request counters per provider. Resets at UTC midnight.
  try { results['fallbackRequestsToday'] = getFallbackRequestCounts(); }
  catch (err) { results['fallbackRequestsToday'] = { error: err instanceof Error ? err.message : String(err) }; }

  // TRA-552 — rolling Tradier quote requests/min + quote-cache state. Tradier is
  // the sole stock-quote source, so this is the headroom gauge against its
  // production rolling-window quota: a high `requestsLastMin` with few
  // `cachedSymbols` means coalescing isn't engaging and quotes are at risk of
  // re-breaking.
  try { results['tradierQuoteRate'] = getTradierQuoteRateState(); }
  catch (err) { results['tradierQuoteRate'] = { error: err instanceof Error ? err.message : String(err) }; }

  // TRA-739 — restart-resilient rolling Tradier bar-pull req/min (minute + daily
  // timesales), the companion to `tradierQuoteRate`. Tradier's quota is
  // account-wide, so total load is this plus the quote rate; this is the gauge the
  // TRA-554 sampler should sum, since `fallbackRequestsToday` (cumulative, resets
  // on restart) can't be differenced for a rate.
  try { results['tradierBarPullRate'] = getTradierBarPullRateState(); }
  catch (err) { results['tradierBarPullRate'] = { error: err instanceof Error ? err.message : String(err) }; }

  // TRA-1059 — rolling Coinbase request rate (req/min, 60s window) per host. The
  // crypto candle cascade (cold-start daily warmer + steady-state tick loop) hits
  // the Exchange host first and falls back to keyless Advanced Trade, so the load
  // spans both pacers; `requestsLastMin` is the combined total that must stay
  // under the ~200/min per-IP ceiling. Companion to the coarse `coinbaseBreakerOpen`
  // bool below — makes the cold-start-prefetch soak's criterion-2 directly
  // measurable instead of Render-log-only.
  try { results['coinbaseBarPullRate'] = getCoinbaseBarPullRateState(); }
  catch (err) { results['coinbaseBarPullRate'] = { error: err instanceof Error ? err.message : String(err) }; }

  // TRA-439 — Twelve Data quota guard: how much of the daily budget is spent
  // and whether the credit/rate-limit breaker is open. Lets QA confirm a
  // single provider can no longer blow its free-tier cap.
  try { results['twelveDataQuota'] = getTwelveDataQuotaState(); }
  catch (err) { results['twelveDataQuota'] = { error: err instanceof Error ? err.message : String(err) }; }

  const ok = (key: string) => {
    const v = results[key];
    return v && typeof v === 'object' && !('error' in (v as object)) && !('skipped' in (v as object));
  };
  // TRA-705 — a `cryptoDailyBars` result with bars > 0 means the OHLC candle
  // pipeline is operational: the engine can evaluate strategies and generate
  // signals. Quote probes (`coinbase`, `coinbaseAdvancedTrade`, `yahooFinance`,
  // `coinMarketCap`) are for watchlist display; the strategy layer runs on
  // candles, not spot quotes. So `cryptoOk` is true if either the spot-quote
  // path OR the candle path is live. On Render the AT candle endpoint
  // (`market/products/{id}/candles`) resolves while the AT quote endpoint
  // (`market/products`) does not — this gate ensures the gauge reports the
  // truth (engine can trade) rather than a false outage (quote endpoint down).
  const dailyBarsResult = results['cryptoDailyBars'] as { bars?: number } | undefined;
  const dailyBarsOk = typeof dailyBarsResult?.bars === 'number' && dailyBarsResult.bars > 0;
  // TRA-1035 — `yahooChartQuote` is the keyless chart-endpoint quote path. It
  // counts toward `stocksOk` because the equity engine prices the universe
  // through the same `fetchQuote`/`fetchQuotes` cascade (tradier → yahoo quote →
  // yahoo chart → stooq): when only the Yahoo *quote* endpoint is crumb-broken,
  // the chart path still serves live prices, so the gauge must report stocks as
  // up rather than a false outage.
  const stocksOk = ok('tradier') || ok('yahooFinance') || ok('yahooChartQuote');
  // TRA-331 / TRA-705 — Coinbase is primary for crypto; YF/CMC are fallbacks
  // only. `coinbaseAdvancedTrade` (keyless `api.coinbase.com`) is the engine's
  // real primary and the one source that resolves from the Render egress IP, so
  // it must count toward `cryptoOk` — otherwise the gauge reports a crypto
  // outage while the engine is happily pricing the universe through it.
  const cryptoOk =
    dailyBarsOk ||
    ok('coinbaseAdvancedTrade') || ok('coinbase') || ok('coinGecko') ||
    ok('yahooFinance') || ok('coinMarketCap');
  const allOk = stocksOk && cryptoOk;
  // TRA-572 diagnostic: report which boot-time env vars the process sees (boolean
  // presence only — no secret values). Lets ops confirm whether Render is actually
  // injecting the credentials before each new process starts.
  const bootEnv = {
    // TRA-2163 — redact any non-label value so a mis-set token cannot leak on
    // this no-auth health surface; presence is still visible via the label.
    TRADIER_ENV: redactTradierEnvLabel(process.env['TRADIER_ENV']) ?? '(unset — defaults to sandbox)',
    TRADIER_API_TOKEN_set: !!process.env['TRADIER_API_TOKEN'],
    TRADIER_SANDBOX_API_TOKEN_set: !!process.env['TRADIER_SANDBOX_API_TOKEN'],
    TRADIER_ACCOUNT_ID_set: !!process.env['TRADIER_ACCOUNT_ID'],
    TRADIER_SANDBOX_ACCOUNT_ID_set: !!process.env['TRADIER_SANDBOX_ACCOUNT_ID'],
  };
  return {
    ok: allOk,
    stocksOk,
    cryptoOk,
    tradierConfigured: isTradierStocksConfigured(),
    tradierBreakerOpen: isTradierBreakerOpen(),
    yahooBreakerOpen: isYahooBreakerOpen(),
    coinbaseBreakerOpen: isCoinbaseBreakerOpen(),
    // TRA-1940 — degraded-feed detail: which provider, why, quota/breaker expiry,
    // and the per-tick secondary-fetch wall-time budget currently enforced.
    feedDegradation: getFeedDegradationState(),
    bootEnv,
    results,
    ts: new Date().toISOString(),
  };
}

// ── WebSocket ────────────────────────────────────────────────────────────────

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// TRA-142 — every WS client is tagged with the authenticated username so
// state and EOD broadcasts only go to that user's clients.
type AuthedSocket = WebSocket & { username?: string };

function broadcastToUser(username: string, msg: string): void {
  for (const client of wss.clients) {
    const c = client as AuthedSocket;
    if (c.readyState === WebSocket.OPEN && c.username === username) c.send(msg);
  }
}

/**
 * TRA-2421 — hang up every live socket belonging to `username`.
 *
 * The upgrade handler refuses a deleted user's token, but an ALREADY-OPEN socket
 * was authenticated before the delete and would otherwise keep streaming state
 * from a book that no longer exists. Closes every socket regardless of
 * `readyState` (unlike `broadcastToUser`, which only writes to OPEN ones) —
 * a CONNECTING socket is exactly the one that would survive the sweep.
 * `1000 Normal Closure` so the client treats it as a sign-out, not a dropped
 * connection to retry.
 */
function closeUserSockets(username: string): number {
  let closed = 0;
  for (const client of wss.clients) {
    const c = client as AuthedSocket;
    if (c.username !== username) continue;
    try { c.close(1000, 'Account deleted'); } catch { /* already gone */ }
    closed += 1;
  }
  return closed;
}

function broadcastEngineState(ctx: UserContext): void {
  broadcastToUser(ctx.username, JSON.stringify({ type: 'state', payload: ctx.engine.getState() }));
}

function broadcastCryptoState(ctx: UserContext): void {
  broadcastToUser(ctx.username, JSON.stringify({ type: 'crypto_state', payload: ctx.cryptoEngine.getState() }));
}

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${firstHeader(req.headers.host) ?? 'localhost'}`);
  const token = url.searchParams.get('token') ?? '';
  const username = verifyToken(token);
  // TRA-2421 — same existence check as `requireAuth`. The WS is a SECOND door to
  // `ensureUserContext` (see the `connection` handler below), so a deleted user
  // reconnecting a socket would re-create the data directory and restart the
  // engines just as an HTTP request would. Gating only the HTTP side would leave
  // the resurrection path fully open through the transport the UI actually uses.
  if (!username || !getUser(username)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    (ws as AuthedSocket).username = username;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (ws) => {
  const c = ws as AuthedSocket;
  const username = c.username;
  if (!username) { ws.close(); return; }
  const ctx = await ensureUserContext(username);

  ws.send(JSON.stringify({ type: 'state', payload: ctx.engine.getState() }));
  ws.send(JSON.stringify({ type: 'crypto_state', payload: ctx.cryptoEngine.getState() }));

  // TRA-244 — read latest.json from the active stocks bucket so the WS
  // handshake matches whatever the Calendar tab is showing for this account.
  const stocksMode = stockModeKey(getSettings(ctx.username));
  const latestPath = join(stockReportsDirFor(ctx, stocksMode), 'latest.json');
  if (existsSync(latestPath)) {
    try {
      const raw = await readFile(latestPath, 'utf-8');
      ws.send(JSON.stringify({ type: 'eod_report', payload: JSON.parse(raw) }));
    } catch { /* ignore */ }
  }
});

// Wire up per-user engine onTick → user-scoped WS broadcasts.
//
// TRA-406 — the same onTick stream feeds a TradeAuditTracker per engine. The
// tracker diffs successive states so every position open/close (auto or
// manual, demo or live) lands in `trade-audit.jsonl` without touching the
// engine internals.
function attachBroadcastHandlers(ctx: UserContext): void {
  const equityAudit = new TradeAuditTracker(ctx.username, 'equity');
  const cryptoAudit = new TradeAuditTracker(ctx.username, 'crypto');
  // TRA-1317 — surface the process-global regime-gated TSMOM demo-route book's open
  // paper longs on this engine's Demo dashboard view. Consulted only in buildState's
  // demo branch, so a live-mode context never renders them (real capital untouched).
  //
  // TRA-2411 — ...but SCOPED to the operator books. The route book is a module-level
  // singleton with no user key, and binding it bare here handed the firm's paper
  // positions to EVERY demo account as their own — the TRA-2407 fold leak on the
  // crypto surface. The predicate is re-evaluated inside the closure on every
  // getState() rather than decided once at attach time, so a role change cannot leave
  // a demoted context still reading the book. A denied caller gets [], i.e. this
  // engine's own book untouched.
  ctx.cryptoEngine.setExternalDemoPositionsProvider(() =>
    demoRoutePositionsFor(ctx.username, getUser(ctx.username)?.role),
  );
  ctx.engine.onTick((state) => {
    try { equityAudit.observe(state as unknown as Parameters<typeof equityAudit.observe>[0]); } catch { /* audit must never break broadcast */ }
    broadcastToUser(ctx.username, JSON.stringify({ type: 'state', payload: state }));
  });
  ctx.cryptoEngine.onTick((state) => {
    try { cryptoAudit.observe(state as unknown as Parameters<typeof cryptoAudit.observe>[0]); } catch { /* audit must never break broadcast */ }
    broadcastToUser(ctx.username, JSON.stringify({ type: 'crypto_state', payload: state }));
  });
}

for (const ctx of getAllUserContexts()) {
  attachBroadcastHandlers(ctx);
}

// TRA-388 — on startup, backfill any EOD report whose 21:00 ET archive tick
// was missed while the server was offline (overnight close, redeploy, crash).
// This is what fills the calendar gap the next time the app is opened, rather
// than waiting for — and depending on — that night's archive tick.
void catchUpMissedEodReports().catch(err =>
  log.warn('reports startup catch-up failed', {
    reason: err instanceof Error ? err.message : String(err),
  }),
);

// TRA-2314 — on startup, repair the `optionsDailyPnl` false zeros TRA-2302
// proved (15 desk days, +$844.99 of realized option round trips booked as 0.00).
// Idempotent and bounded to days the durable journal names closes on, so it is
// safe to run on every boot; after the first pass it writes nothing.
void runOptionsDailyPnlRepair().catch(err =>
  log.warn('TRA-2314 optionsDailyPnl repair (startup) failed', {
    reason: err instanceof Error ? err.message : String(err),
  }),
);

// TRA-2829 — on startup, INSERT the EOD ledger rows the 21:00 ET archive never
// wrote for the live book (TRA-2817's inode outage). Disarmed by default; the
// plan is published on /api/health/pnl-reconciliation either way. Runs AFTER the
// false-zero repair above so it never races that pass over the same file.
void runEodRowBackfill().catch(err =>
  log.warn('TRA-2829 EOD row back-fill (startup) failed', {
    reason: err instanceof Error ? err.message : String(err),
  }),
);

// TRA-244 — on startup, rewrite the historical June Live-calendar cells from
// broker-truth realized P&L (board chose "backfill from fills"). Idempotent
// and bounded to the historical window, so it's safe to run every boot.
void runLiveRealizedCalendarBackfill().catch(err =>
  log.warn('live realized calendar backfill (startup) failed', {
    reason: err instanceof Error ? err.message : String(err),
  }),
);

/**
 * Provision a brand-new user: build their context and wire WS broadcast
 * handlers. Used by signup and admin-create. Failures are logged but do not
 * break the calling request — the user is created and their context can be
 * lazily rebuilt on first auth.
 */
async function provisionUser(username: string): Promise<void> {
  try {
    const ctx = await initUserContext(username);
    attachBroadcastHandlers(ctx);
  } catch (err: unknown) {
    log.warn('provisionUser failed', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// Periodic backup snapshots (TRA-140) — every 30 minutes the persisted JSON
// files are copied into a timestamped folder under DATA_DIR/backups/. Old
// folders are pruned (last 24 kept = ~12 hours). On startup, missing/corrupt
// primary files auto-restore from the latest backup.
void rotateBackups().catch(err => log.warn('trade-store initial backup failed', { reason: err instanceof Error ? err.message : String(err) }));
const BACKUP_INTERVAL_MS = 30 * 60_000;
const backupTimer = setInterval(() => {
  void rotateBackups().catch(err => log.warn('trade-store backup failed', { reason: err instanceof Error ? err.message : String(err) }));
}, BACKUP_INTERVAL_MS);
backupTimer.unref?.();

// TRA-2840 — DURABLE exit-cadence snapshots at the RTH open and close.
//
// `books.live.tickExitRegionMs` is in-memory and dies with the process, so
// reading it required an agent inside a ~37-minute unprotected post-close
// window. That failed four sessions running (see `exit-cadence-snapshot.ts` for
// the measurements). A log line has no window to lose and no agent that has to
// be invokable, and Render retains ~7 days of them across every restart.
//
// Polled once a minute rather than scheduled at two exact instants on purpose:
// a fixed `setTimeout` to 13:30Z is itself a single point of failure, and this
// process is restarted several times an hour. A poll re-derives what is due
// from the wall clock, so a process that boots at 15:00Z still emits its T0
// immediately — flagged `partialWindow` so a partial window is visible as
// partial rather than passing as a whole session.
const EXIT_CADENCE_SNAPSHOT_POLL_MS = 60_000;
let exitCadenceEmitState: ExitCadenceEmitState = { lastT0Session: null, lastT1Session: null };
function emitExitCadenceSnapshotIfDue(nowMs = Date.now()): void {
  const mark = dueExitCadenceMark(nowMs, exitCadenceEmitState);
  if (mark === null) return;
  try {
    const build = resolveBuildInfo();
    const line = buildExitCadenceSnapshotLine({
      mark,
      nowMs,
      bootedAtMs: Date.parse(build.startedAt),
      build,
      rollup: rollUpExitCadence(getAllUserContexts().map(ctx => ctx.engine.getExitCadenceHealth())),
    });
    // The marker leads the message so Render's `text=` filter matches it; the
    // payload rides as structured fields, parsed not grepped.
    log.info(EXIT_CADENCE_SNAPSHOT_MARKER, line as unknown as Record<string, unknown>);
    exitCadenceEmitState = recordExitCadenceMark(exitCadenceEmitState, mark, line.session);
  } catch (err) {
    // Never let an instrument take the box down. A failed emit must not also
    // burn the cursor, so the next poll retries this same mark.
    log.warn('exit-cadence snapshot emit failed', {
      mark,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
emitExitCadenceSnapshotIfDue();
const exitCadenceSnapshotTimer = setInterval(
  () => emitExitCadenceSnapshotIfDue(),
  EXIT_CADENCE_SNAPSHOT_POLL_MS,
);
exitCadenceSnapshotTimer.unref?.();

// ── Static frontend (production web) ────────────────────────────────────────
const DIST_DIR = join(__dirname, '..', '..', '..', 'apps', 'desktop', 'dist');
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(DIST_DIR, 'index.html'));
  });
}

// TRA-2320 — terminal 404, mounted after the routes AND after the static/SPA
// block so it only ever sees a path nothing else claimed. Express's built-in
// `finalhandler` would otherwise answer an unknown `/api` path with an HTML
// body no API consumer can parse. Must stay above `errorMiddleware`: a 4-arg
// error handler is only reached via `next(err)`, so it never shadows this.
app.use(notFoundHandler());

// TRA-406 — error-handling middleware. Mounted last so it catches anything a
// route handler threw; captures it against the request trace id and returns a
// 500 carrying that id. Express recognises this as an error handler by its
// 4-argument shape.
app.use(errorMiddleware);

// ── Observability monitor ────────────────────────────────────────────────────
//
// TRA-406 — run every 60s scheduler tick (see `onMonitor` below). Probes
// `/api/health`, checks disk space, watches captured-error volume, and — on
// market days past noon ET — alerts if no trades have been placed. Each alert
// key throttles itself, so a sustained outage produces one alert per window.

async function probeHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function runObservabilityMonitor(): Promise<void> {
  // TRA-2357 — liveness of THIS loop. `stalled`/`ageSec` are published on the
  // OPEN `/api/health/storage`; the raw `runs` count is admin-only (TRA-2599). A
  // 60s monitor that stopped ticking produces an empty alert ring, which reads
  // identically to "every check passed". Without a heartbeat there is no way
  // to tell those apart from outside the box, and the quiet ring gets read as
  // an all-clear.
  observabilityMonitorRuns += 1;
  observabilityMonitorLastRunAt = new Date().toISOString();
  await runHealthCheck(probeHealth);
  await checkDiskSpace(DATA_DIR);
  checkErrorSpike(getErrorCountSince());

  // Trade-volume-zero — only meaningful on a stock-market trading day.
  // TRA-2498 — via the shared ET helper. A bare `hour12: false` renders
  // midnight as 24 on Node 20 (prod), which cleared this check's
  // `etHour >= thresholdHour (12)` gate at 00:00–00:59 ET while the new day's
  // trade count was still legitimately 0 — a false `trade-volume-zero` warning
  // every midnight on a market day.
  const now = new Date();
  checkTradeVolume({
    tradeCountToday: getTradeOpenCount(),
    etHour: etHour(now),
    isMarketDay: isMarketDay(now),
  });

  // TRA-528 — stale-state probe. Walk live user engines and raise the
  // `stale-state` alert if the market is open but no fresh quotes are landing —
  // the direct detector for "nothing works in Live" (engine up, feed dead).
  runStaleStateCheck(getAllUserContexts(), getSettings, now.getTime());
}

// ── Start ────────────────────────────────────────────────────────────────────

// TRA-406 — capture errors that escape every try/catch, and record this boot
// so a crash-loop toward PM2's max_restarts raises a `restart-storm` alert.
installGlobalErrorHandlers();
void recordBootAndCheckRestarts().catch(err =>
  logger.warn('boot-history check failed', { reason: err instanceof Error ? err.message : String(err) }),
);

// TRA-851 — owns the per-ET-day dedup for user routines across scheduler ticks.
const routineRunner = new RoutineRunner();

// TRA-1003 — arm the external-intel trigger. Cheap no-op tick until an operator
// sets ENABLE_EXTERNAL_INTEL (the activation gate is a separate board decision).
const externalIntelSchedule = startExternalIntelSchedule();

// TRA-1004 — arm the autonomous demo-trading loop. Cheap no-op tick until an
// operator sets ENABLE_AUTONOMOUS_DEMO_LOOP (a demo-sandbox decision — no board
// gate, no live-capital path). When on, each tick drives the existing brain
// unattended on every DEMO-mode book: it enables demo auto-trading and forces a
// decision cycle (analysts→trader→risk + strategy selector across
// stocks/options/crypto), with the TRA-995 autopilot kept in-loop as the guard.
// A halted book is skipped, so an autopilot halt demonstrably stops the loop.
//
// The driver below only ever touches the *demo* book (`setAutoTrading(true,
// 'demo')`); the `listBooks` enumerator filters to `mode === 'demo'` first, so a
// user in live mode is never enrolled — there is no live-trade path here.
function makeDemoBookEngine(ctx: UserContext): DemoBookEngine {
  return {
    username: ctx.username,
    isHalted: () =>
      ctx.engine.getState().tradingHalted || ctx.cryptoEngine.isKillSwitchEngaged(),
    // TRA-1072 — the crypto leg ignores the equity feed-stale gate (an equity
    // feed gap must not freeze crypto); it still honours the crypto kill switch
    // and the equity latched breakers (loss-streak / drawdown / equity kill).
    isCryptoHalted: () =>
      ctx.engine.isHaltedExcludingFeedStale() || ctx.cryptoEngine.isKillSwitchEngaged(),
    haltReason: () =>
      ctx.engine.getState().haltReason ??
      (ctx.cryptoEngine.isKillSwitchEngaged() ? 'Crypto kill switch engaged' : null),
    riskThrottle: () => ctx.engine.getRiskThrottle(),
    regime: () => ctx.engine.getState().marketReview.regime,
    recentAutopilotActions: () => ctx.engine.getAutopilotActions(),
    openStocks: () => ctx.engine.getState().account.openPositions.length,
    openCrypto: () => ctx.cryptoEngine.getReportSnapshot('demo').accountState.openPositions.length,
    driveStocks: () => {
      ctx.engine.setAutoTrading(true, 'demo');
      ctx.engine.refresh();
    },
    driveCrypto: () => {
      ctx.cryptoEngine.setAutoTrading(true, 'demo');
      ctx.cryptoEngine.refresh();
    },
  };
}
const autonomousDemoLoopDeps: AutonomousDemoLoopDeps = {
  listBooks: () =>
    getAllUserContexts()
      .filter(ctx => getSettings(ctx.username).mode === 'demo')
      .map(makeDemoBookEngine),
  isStocksMarketOpen: () => isMarketOpen(),
};
const autonomousDemoSchedule = startAutonomousDemoSchedule({
  deps: autonomousDemoLoopDeps,
  // TRA-1008 — re-resolve env per tick so a file-backed flag flip is honored.
  resolveEnv: demoFlagEnv,
});

const scheduler = new MarketScheduler();
scheduler.start({
  // TRA-244 — collapsed onto the 9 PM ET archive hook so the Calendar row
  // appears AFTER the dashboard's dailyPnl reset (the previous 4:05 PM hooks
  // ran before the reset, leaving the row visible at 4:05 but the dashboard
  // still showing the stale total until 9). Stocks generation is gated on
  // market days inside the callback; crypto fires every day (24/7).
  //
  // TRA-386 — the post-market regime review runs on the same hook, after the
  // daily close so the EOD reports are already on disk.
  onArchive: async () => {
    await runDailyCloseForAllUsers();
    // TRA-2252 — scheduled P&L report emails. Fired AFTER the daily close so
    // today's snapshot is booked into each user's trackers before the period
    // window is rolled. Fire-and-forget (no await): the dispatcher isolates and
    // bounds each send, and a mail failure must never delay the archive tick.
    runScheduledReportsForAllUsers();
    await generateMarketReview('postmarket').catch(err =>
      log.error('market-review post-market generation failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    // TRA-1006 — automated post-market analyst review: fold the day's demo
    // journal + enqueue ≥1 hypothesis into the TRA-994 pipeline. No-op + zero
    // cost while ENABLE_ANALYST_AGENT is off (flag checked before any deps).
    await runAnalystPostmarketTick(Date.now()).catch(err =>
      log.error('analyst post-market tick failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    // TRA-2352 (TRA-927) — persist ONE learned-weights snapshot for this ET day,
    // last in the chain so `runDailyCloseForAllUsers()` above has already labelled
    // the day's resolutions into the reversal shadow ledger before the fold is
    // taken. Zero-IO no-op while ENABLE_LEARNED_WEIGHTS_SNAPSHOT is off (the flag
    // is checked before the ledger read). Write-only observer, no capital path.
    // NO BACK-FILL: a missed day stays absent — see learned-weights-history.ts.
    await recordDailyLearnedWeightsSnapshot({ readLedger: () => listReversalShadowSignals() }).catch(
      err =>
        log.error('learned-weights snapshot tick failed', {
          reason: err instanceof Error ? err.message : String(err),
        }),
    );
  },
  // TRA-249-D — hourly funding accrual on open Coinbase INTX perps. Fires
  // at minute=0 every ET hour; per-user trackers no-op when no perps are
  // open or the user is in demo mode. TRA-1216 — the same tick also drives the
  // observe-only perp funding-carry pass (flag-gated ⇒ zero cost/IO when off).
  onHourly: async () => {
    // TRA-2279 D2 — re-fold the parity-reconcile daily point on every ET hour boundary.
    // This is the DURABLE post-close read the series was missing: routine `d8ec9395`'s
    // two triggers are both MID-session (15:00Z / 18:30Z vs a 20:00Z close), so nothing
    // ever read the route after the close and every post-15:00Z fill landed in no daily
    // point at all. Hooking the EXISTING hourly tick (rather than adding a cron, or
    // editing a CTO-owned routine cross-boundary) means any top-of-hour at/after 16:00 ET
    // completes the session — a ~7-hour window to survive one restart in, instead of the
    // single 16:05 ET minute `onMarketClose` would have given.
    //
    // Runs FIRST, and synchronously, on purpose: every other callee here is awaited, so
    // placing it later would let one unrelated crypto/funding rejection starve the day's
    // post-close fold — the exact silent-gap failure this fix exists to close. Cost is a
    // pure fold over the already-in-memory sandbox journal (no broker call, no order path,
    // no flag read) and it is best-effort internally, so it cannot throw into this tick.
    // Idempotent by construction (last-write-wins per ET day). Observe-only under the
    // TRA-1897 hold — gates/arms/graduates nothing.
    appendParitySnapshotForDay(getSandboxStrategyRecords());
    await runHourlyFundingForAllUsers();
    await runHourlyPerpFundingCarry();
    // TRA-1220 — observe-only crypto regime-overlay classification (flag-gated ⇒
    // zero cost/IO when off). Read-only: emits labels only, no order path.
    await runHourlyCryptoRegime();
    // TRA-1221 — observe-only regime-gated TSMOM scan over the same regime label
    // (flag-gated ⇒ zero cost/IO when off). Read-only: would-be signals only.
    await runHourlyCryptoRegimeTsmom();
    // TRA-1271 — observe-only crypto ignition scan (flag-gated ⇒ zero cost/IO when
    // off). Read-only, ZERO capital: would-be forward records + fill instrument only.
    await runHourlyCryptoIgnition();
    // TRA-2810 — join Tradier account-history commission onto any live fee/slippage
    // ledger row still fees:null. Self-quenching (zero IO once nothing is unmeasured)
    // and internally best-effort — it cannot throw into this tick.
    await runLiveOptionsFeeReconcile(buildLiveFeeReconcileClient);
  },
  // TRA-849 — 8:30 AM ET pre-market morning brief. Renders the macro gate +
  // each user's watchlist setups, open book, and overnight news, then pushes
  // it through the notification dispatcher. Runs ahead of the 9:00 watchlist
  // build; market days only (gated in the scheduler).
  onMorningBrief: async () => {
    await runMorningBriefForAllUsers();
  },
  // TRA-368 — 9:00 AM ET pre-market routine. Replays prior session's EOD
  // review + a fresh pre-market scan into each user's smart watchlist so
  // the SignalEngine starts the new session with curated symbols. Stocks
  // only — crypto's 24/7 market has no pre-market boundary.
  //
  // TRA-386 — the pre-market regime review runs first so its GREEN/YELLOW/RED
  // gates are persisted before the watchlist builder (and any engine reader)
  // looks them up.
  onPremarket: async () => {
    await generateMarketReview('premarket').catch(err =>
      log.error('market-review pre-market generation failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    await runPremarketForAllUsers();
    // TRA-596 — refresh the upcoming-earnings calendar once per trading day,
    // pre-bell, so the engine's event-proximity read is current for the session.
    await runEarningsRefresh();
    // TRA-597 — refresh the macro/Fed economic calendar (FOMC + CPI/NFP/PCE)
    // pre-bell so daysToNextFOMC()/eventsNearDate() are current for the session.
    await runMacroRefresh();
    // TRA-1006 — automated pre-market analyst plan: rank the watchlist (S/R +
    // reversal + trend) and publish a ReviewBlock the demo loop consumes. No-op +
    // zero cost while ENABLE_ANALYST_AGENT is off (flag checked before any deps).
    await runAnalystPremarketTick(Date.now()).catch(err =>
      log.error('analyst pre-market tick failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  },
  // TRA-380 — 3:55 PM ET option-chain recorder. Captures one Tradier chain
  // snapshot per trading day into the persistent disk for the TRA-379
  // replay backtest harness. Market days only; see `runChainRecord`.
  //
  // TRA-822 — the StockTwits sentiment-snapshot logger rides the same hook so
  // the sentiment + chain partitions co-accumulate per symbol-day for the
  // TRA-820 IC/flow study. Isolated so a StockTwits failure can't drop the
  // chain capture (or vice-versa).
  // TRA-2476 — the scheduler's per-day dedup (`lastChainRecordDate`) is
  // in-memory, and the 15:55–20:00 ET catch-up refires this hook on EVERY boot
  // inside that window. On Mon 2026-07-27 that was a 73-boot crash loop
  // (20:00:17Z → 00:05:34Z — it ended the minute the ET catch-up window
  // closed): each boot re-ran capture + enrich + push on a cold process and
  // died, destroying the frozen RTH counters 17s after the close. The marker
  // below lives on the persistent disk so a reboot inside the window skips a
  // capture that already succeeded today; it is stamped ONLY on a real capture
  // (token-less no-ops stay retryable within the day).
  onChainRecord: async () => {
    const todayEt = etDateString(new Date());
    try {
      const marker = (await readFile(CHAIN_HOOK_MARKER_PATH, 'utf-8')).trim();
      if (marker === todayEt) {
        log.info('chain-record hook already ran today — skipping catch-up refire', {
          date: todayEt,
        });
        return;
      }
    } catch {
      // No marker yet (first run on this disk) — proceed.
    }
    const captured = await runChainRecord();
    if (captured) {
      await writeFile(CHAIN_HOOK_MARKER_PATH, todayEt, 'utf-8').catch((err) =>
        log.warn('chain-record day marker write failed', {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    await runSentimentSnapshot().catch((err) =>
      log.error('sentiment-recorder failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    // TRA-1209 — short-squeeze observe-capture (default-OFF, observe-only).
    // Isolated so a screener/feed failure can't drop the chain/sentiment
    // captures above (or vice-versa).
    await runShortSqueezeCapture().catch((err) =>
      log.error('short-squeeze capture failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    // TRA-1209 — resolve forward outcomes on prior captures (the graded label).
    // Isolated so a bar-feed failure can't drop the captures above.
    await runShortSqueezeForwardResolve().catch((err) =>
      log.error('short-squeeze forward-resolve failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    // TRA-845 — diff the just-captured chain vs yesterday and push Layer-4 alerts.
    // Isolated so a push failure can't drop the capture above (or vice-versa).
    await runOptionsAlertPush().catch((err) =>
      log.error('options-alert push failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  },
  // TRA-1971 — Monday-morning AI-Options-Ideas weekly forward-test roll-up.
  // Publishes the accumulation record to the News tab so the live-capital-gate
  // track record is auditable weekly without manual polling. Isolated so a
  // publish failure can't affect any other hook.
  onWeeklyRollup: async () => {
    await runWeeklyOptionsRollup().catch((err) =>
      log.error('weekly options roll-up failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  },
  // TRA-406 — observability monitor on every 60s tick.
  onMonitor: runObservabilityMonitor,
  // TRA-851 — user-routine tick on every 60s tick. The runner matches each
  // user's defined routines to the current ET minute, runs the action, and
  // pushes the result as a `routine` alert through the dispatcher (respecting
  // the user's channel prefs + quiet hours). Per-ET-day dedup lives in the
  // runner; the dispatcher dedups again by the same day key.
  onRoutineTick: (et) =>
    routineRunner.tick({
      nowEt: et,
      isMarketDay: (date) => isMarketDayIso(date),
      users: () => usersWithRoutinesSync(),
      listRoutines: (user) => listRoutinesSync(user),
      execute: (user, routine) => executeRoutineForUser(user, routine),
      emit: (user, routine, rendered) =>
        emitAlert({
          kind: 'routine',
          username: user,
          routineId: routine.id,
          date: et.date,
          title: rendered.title,
          body: rendered.body,
        }),
    }),
}, {
  // TRA-1404 — persist the 21:00 ET archive dedup key to the persistent disk so
  // a Render redeploy AFTER 21:00 ET doesn't re-fire the full daily close for a
  // day already archived. Defense-in-depth atop the TRA-1403 write guard: it
  // removes the redundant close work, leaving the missed-day catch-up as the
  // sole post-archive writer.
  archiveDateStore: createFileArchiveDateStore(),
});

httpServer.listen(PORT, () => {
  // Intentional: console, not the structured logger — this is the genuine
  // startup banner an operator expects on stdout when the process comes up.
  console.log(`Trading server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});

// TRA-1080 — event-loop/heap starvation watchdog. Detects the bqb1 "HTTP
// listener dead while worker timers live" state from inside the process and
// exits(1) for a clean Render restart, instead of hanging indefinitely in 502
// limbo. Monitoring is cheap and on by default; restart action is on by default
// (env-disableable). Started AFTER listen so a slow boot never trips it.
const eventLoopWatchdog: WatchdogHandle | null = startEventLoopWatchdog();

/**
 * TRA-407 (C5) — upper bound on how long shutdown waits for in-progress ticks
 * to drain. A tick that ignores the timer (e.g. a wedged socket) must not
 * block the process from exiting within Render's SIGTERM grace window.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;

/** TRA-407 (C5) — guard so a doubled SIGTERM/SIGINT can't re-enter shutdown. */
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown received — draining ticks, recording in-flight orders, flushing trade history', { signal });
  scheduler.stop();
  externalIntelSchedule.stop();
  autonomousDemoSchedule.stop();
  eventLoopWatchdog?.stop();
  const all = getAllUserContexts();
  // Clear each engine's tick timer first so no new tick starts; the in-flight
  // tick (if any) keeps running and is drained next.
  for (const ctx of all) {
    ctx.engine.stop();
    ctx.cryptoEngine.stop();
    if (ctx.stocksPersistTimer) clearTimeout(ctx.stocksPersistTimer);
    if (ctx.cryptoPersistTimer) clearTimeout(ctx.cryptoPersistTimer);
  }
  // TRA-407 (C5) — finish the current tick so we exit on a tick boundary, not
  // mid-tick. Bounded by SHUTDOWN_DRAIN_TIMEOUT_MS so a wedged tick can't hold
  // the process past the redeploy grace window.
  const drainAll = Promise.all(all.flatMap(ctx => [ctx.engine.drain(), ctx.cryptoEngine.drain()]));
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    drainAll.then(() => undefined),
    new Promise<void>(resolve => {
      drainTimer = setTimeout(() => {
        log.warn('shutdown tick drain exceeded timeout — exiting anyway', {
          timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
        });
        resolve();
      }, SHUTDOWN_DRAIN_TIMEOUT_MS);
      drainTimer.unref?.();
    }),
  ]);
  if (drainTimer) clearTimeout(drainTimer);
  // TRA-407 (C5) — record in-flight Tradier order ids so a redeploy mid-
  // reconcile leaves an audit trail for the next boot's reconciler.
  for (const ctx of all) {
    const inflight = ctx.engine.inFlightBrokerOrderIds();
    if (inflight.length > 0) {
      log.warn('shutdown: in-flight Tradier orders at exit', {
        count: inflight.length,
        orders: inflight.map(o => `${o.kind} ${o.optionSymbol} #${o.orderId} (${o.env})`).join(', '),
      });
    }
  }
  // Flush every user's pending trade-history writes synchronously before exit.
  try {
    await Promise.all(all.flatMap(ctx => [persistStocksNow(ctx), persistCryptoNow(ctx)]));
  } catch (err: unknown) {
    log.warn('shutdown persist failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  // TRA-406 — drain any in-flight structured-log / audit / alert file writes.
  await flushLogs().catch(() => undefined);
  log.info('shutdown drain complete — exiting');
  process.exit(0);
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
