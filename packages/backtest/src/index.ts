// Historical simulation — replay candle data through strategies and compute metrics

export {
  BacktestRunner,
  admitsUnderPortfolioCap,
  defaultSectorOf,
  reachedOneR,
} from './runner.js';
export type {
  BacktestResult,
  BacktestConfig,
  BacktestReversalOpts,
  BacktestIchimokuOpts,
  BacktestMacdBollingerOpts,
  PortfolioOpts,
  CorrelationCapOpts,
  VolKellySizerOpts,
  SignalEdgeOpts,
  ConfidenceBands,
  SignalEdge,
} from './types.js';
// TRA-429 — multi-symbol portfolio backtest runner. Ticks several symbols on
// one shared timeline against shared portfolio / risk state so the TRA-423
// cross-symbol correlation-cluster cap is regression-tested on historical data.
export { PortfolioBacktestRunner } from './portfolio-runner.js';
export type {
  PortfolioBacktestConfig,
  PortfolioBacktestResult,
  PortfolioSymbolResult,
} from './portfolio-runner.js';
export {
  trendingCandles,
  rangingCandles,
  mixedRegimeCandles,
  syntheticCryptoSeries,
} from './synthetic.js';
export { bootstrapEquityCurves, blockBootstrapEquityCurves } from './bootstrap.js';
export type { BootstrapOptions, BlockBootstrapOptions } from './bootstrap.js';
export { buildWindows, walkForward } from './walk-forward.js';
export type { WindowSpec, WalkForwardOptions, WalkForwardReport } from './walk-forward.js';
// TRA-540 — automated optimization harness + overfitting guards (TRA-531 spec).
export {
  normalCdf,
  normalPpf,
  sampleMoments,
  probabilisticSharpeRatio,
  expectedMaxSharpe,
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
} from './overfitting-stats.js';
export type {
  SampleMoments,
  DeflatedSharpeInput,
  DeflatedSharpeResult,
  PboInput,
  PboResult,
} from './overfitting-stats.js';
// TRA-1664 — offline PCR shadow-ledger expectancy harness (parent TRA-1609).
export {
  runPcrExpectancy,
  joinForwardReturns,
  atrBySession,
  cohortize,
  pcrSideFor,
  rawUpliftStat,
  placeboUpliftStat,
  placeboSidesBySession,
  adjustedUpliftStat,
  sessionClusteredBootstrap,
  naiveRowBootstrap,
  evaluateCell,
  overfittingGuards,
  sampleShape,
  mulberry32,
  PCR_UPLIFT_BAR_R,
  PRIMARY_HORIZON,
  HORIZONS,
  MIN_INDEPENDENT_SESSIONS,
  PCR_STUDY_TRIALS,
} from './pcr-expectancy.js';
export type {
  PcrShadowRow,
  DailyBar,
  JoinedRow,
  JoinResult,
  JoinDiagnostics,
  Cohorts,
  CellResult,
  OverfittingGuards,
  PcrExpectancyReport,
  PcrCarrier,
  PcrInterpretation,
  SampleShape,
  Ci,
} from './pcr-expectancy.js';
// TRA-1727 — the SECONDARY pre-registered estimand: a session-demeaned CROSS-SECTIONAL
// contrast. Readable at ~45 sessions rather than the primary's ~90, but a PASS promotes
// a PER-NAME SELECTION use ONLY and can never promote market timing — see
// SELECTION_ONLY_CONSTRAINT, which is stamped into every report it produces.
export {
  runPcrCrossSectional,
  crossSectionalContrasts,
  crossSectionalSeries,
  crossSectionalPlaceboCaller,
  sessionLevelPlaceboCaller,
  pcrSideCaller,
  blockBootstrapSeries,
  evaluateXsCell,
  xsOverfittingGuards,
  SELECTION_ONLY_CONSTRAINT,
  XS_MIN_SESSIONS,
  XS_MIN_NAMES_PER_SESSION,
} from './pcr-cross-sectional.js';
export type {
  PcrCrossSectionalReport,
  XsCellResult,
  XsGuards,
  XsSeries,
  XsDiagnostics,
  SessionContrast,
  SessionSideCaller,
} from './pcr-cross-sectional.js';
export { partitionData, DataPartition } from './data-partition.js';
export type { PartitionOptions, PartitionBoundaries } from './data-partition.js';
export { runOptimization, enumerateTrials, STRATEGY_SPECS } from './run-optimization.js';
export type {
  OptimizationReport,
  OptimizationVerdict,
  BacktestVerdictMetrics,
  GuardResult,
  WindowRow,
  RunOptimizationOpts,
} from './run-optimization.js';
// Re-export the TRA-185 cost model surface so harness scripts can pick up
// the spread-aware tiers without needing to also pin @trading-app/engine.
export {
  cryptoTieredCostModel,
  flatCostModel,
  cryptoTierOf,
  CRYPTO_TIER_FILLS,
  DEFAULT_CRYPTO_TIERS,
} from '@trading-app/engine';
export type {
  FillCost,
  CostModel,
  CryptoSpreadTier,
  CryptoTieredCostModelOptions,
} from '@trading-app/engine';
// TRA-267 — Coinbase 4H bar fetch + on-disk cache for the Phase-1 perp shorts
// universe. The server's `crypto-feed.ts` re-exports `fetchCoinbase4hBars` so
// engine consumers don't need to depend on @trading-app/backtest directly.
export {
  fetchCoinbaseHourlyBars,
  fetchCoinbase4hBars,
  fetchCoinbaseMinuteBars,
  fetchCoinbaseDailyBars,
  aggregate1hTo4h,
  fillGrid4h,
  summarize4hGaps,
  paceCoinbaseFetch,
  paceCoinbaseAdvancedTradeFetch,
  isCoinbaseBreakerOpen,
  isCoinbaseAdvancedTradeBreakerOpen,
  getCoinbaseBarPullRateState,
} from './coinbase-feed.js';
export type { GridGap } from './coinbase-feed.js';
export {
  cachePathFor,
  cachePathFor4h,
  loadOrFetchDailyBars,
  loadOrFetch4hBars,
  DEFAULT_4H_SYMBOLS,
} from './fetch-tra266-data.js';
export type { CacheEntry } from './fetch-tra266-data.js';
// TRA-376 — historical option-chain replay backtest harness.
export { loadChainDays, estimateSpotFromChain } from './options-chain-store.js';
export type { ChainDay, OptionChainSnapshotFile } from './options-chain-store.js';
export { OptionsReplayAccount } from './options-replay-account.js';
export type {
  ReplayPosition,
  ReplaySignalType,
  OpenOtmCandidate,
  OpenRvCandidate,
  OpenOutcome,
  OptionsReplayAccountConfig,
  EquitySample,
} from './options-replay-account.js';
export {
  summarizeBucket,
  maxDrawdown,
  buildCsv,
  buildMarkdown,
} from './options-replay-report.js';
export type { BucketResult, ClassificationStat } from './options-replay-report.js';
export {
  replayBucket,
  runOptionsReplay,
  DEFAULT_REPLAY_CONFIG,
  DEFAULT_SPREAD_RISK_PARAMS,
} from './run-options-replay.js';
export type { ReplayConfig } from './run-options-replay.js';
// TRA-918 (TRA-908 Phase D) — Phase-A signal-driven backtest + gate-consumable report.
export {
  modelSignalStructure,
  DEFAULT_SIGNAL_FILL,
} from './options-replay-structures.js';
export type { SignalFillParams } from './options-replay-structures.js';
export {
  DEFAULT_SPREAD_MANAGEMENT,
} from './options-replay-account.js';
export type {
  ReplaySpreadStrategy,
  SpreadRiskParams,
  SpreadManagementParams,
  OpenSpreadCandidate,
} from './options-replay-account.js';
export {
  replayPhaseABucket,
  buildSelectorInput,
  buildPhaseAGateReport,
  buildPhaseAMarkdown,
  validateGateReportShape,
  computeBacktestGateMetrics,
  emptyPaperGateMetrics,
  portfolioGreeksForDay,
  summarizeGreeks,
  trendLabel,
  atrProxy,
  highConvictionBreakout,
  defaultPhaseAConfig,
  DEFAULT_PHASEA_FEATURES,
} from './options-replay-phasea.js';
export type {
  PhaseAReplayConfig,
  PhaseABucketResult,
  PhaseAGateReport,
  PhaseAFeatureParams,
  PortfolioGreeksSample,
  GreeksSummary,
  ReplayMode,
} from './options-replay-phasea.js';
// TRA-546 (TRA-529 P3) — advisory multi-agent validation harness: point-in-time
// replay (as-of clock, no look-ahead) → scoring → calibration + net-of-cost
// edge. Drives the P1 stub graph; NO LLM spend.
export {
  replayAgents,
  momentumCandidate,
  clampConviction,
} from './agent-replay.js';
export type {
  CandidateGenerator,
  AgentReplayRecord,
  AgentReplayConfig,
  AgentReplayResult,
} from './agent-replay.js';
export {
  realizedR,
  summarizeAccuracy,
  scoreSignal,
  scoreReplay,
} from './agent-scoring.js';
export type { ScoredSignal, AgentScoreReport } from './agent-scoring.js';
export {
  reliabilityCurve,
  netOfCostEdge,
} from './agent-calibration.js';
export type {
  CalibrationBin,
  ReliabilityCurve,
  NetEdgeReport,
} from './agent-calibration.js';
export {
  runAgentValidation,
  buildValidationMarkdown,
} from './agent-validation.js';
export type {
  AgentValidationOptions,
  AgentValidationReport,
  RecommendationLedgerRow,
} from './agent-validation.js';
// TRA-731 (Phase 2) — synthetic-chain backtest harness for SupertrendConfluence.
// Build only; QuantTrader runs the analysis. `enableSupertrend` routing unchanged.
export {
  realizedVolatility,
  realizedVolSeries,
  ivRank,
  syntheticIv,
  buildSyntheticChain,
  rowDelta,
  roundStrike,
  isoDate as syntheticIsoDate,
  SYNTHETIC_TAG,
  DEFAULT_IV_MODEL,
  DEFAULT_CHAIN_GEN,
} from './synthetic-chain.js';
export type { IvModelParams, ChainGenParams, SyntheticChainFile } from './synthetic-chain.js';
export {
  profitFactor,
  tradeSharpe,
  tradeSortino,
  annualizedSharpe,
  downsideDeviation,
  summarizeTrades,
  PROFIT_FACTOR_CAP,
} from './tra731-metrics.js';
export type { TradeMetrics } from './tra731-metrics.js';
export {
  replaySymbol,
  replayPortfolio,
  DEFAULT_REPLAY_PARAMS,
} from './supertrend-confluence-replay.js';
export type {
  SupertrendReplayParams,
  ReplayTrade,
  SymbolReplayResult,
  PortfolioReplayResult,
} from './supertrend-confluence-replay.js';
export {
  runTrackA,
  trackASymbol,
  buyHoldStat,
  DEFAULT_TRACK_A,
} from './tra731-track-a.js';
export type {
  TrackAOptions,
  TrackAReport,
  SymbolTrackAResult,
  BuyHoldStat,
} from './tra731-track-a.js';
export { TRA731_UNIVERSE, lookbackWindow, fetchUniverse } from './run-tra731-fetch.js';

// TRA-1322 — guarded covered-call recovery branch on the put-write sleeve (paper/backtest).
export type {
  PriceSeries,
  WheelGuards,
  WheelParams,
  WheelCycle,
  WheelRunResult,
  WheelMetrics,
} from './wheel-recovery.js';
export {
  runWheel,
  metrics as wheelMetrics,
  pickStrike as wheelPickStrike,
  restrictUniverse,
  WHEEL_FULL_UNIVERSE,
  WHEEL_QUALITY_UNIVERSE,
} from './wheel-recovery.js';
