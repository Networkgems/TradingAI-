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
  SignalEdgeOpts,
  ConfidenceBands,
  SignalEdge,
} from './types.js';
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
  isCoinbaseBreakerOpen,
} from './coinbase-feed.js';
export type { GridGap } from './coinbase-feed.js';
export {
  cachePathFor,
  cachePathFor4h,
  loadOrFetchDailyBars,
  loadOrFetch4hBars,
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
} from './run-options-replay.js';
export type { ReplayConfig } from './run-options-replay.js';
