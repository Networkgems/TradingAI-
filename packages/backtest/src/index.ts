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
export { bootstrapEquityCurves } from './bootstrap.js';
export type { BootstrapOptions } from './bootstrap.js';
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
  paceCoinbaseFetch,
  isCoinbaseBreakerOpen,
} from './coinbase-feed.js';
export {
  cachePathFor,
  cachePathFor4h,
  loadOrFetchDailyBars,
  loadOrFetch4hBars,
} from './fetch-tra266-data.js';
export type { CacheEntry } from './fetch-tra266-data.js';
