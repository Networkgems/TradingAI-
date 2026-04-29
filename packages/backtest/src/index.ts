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
export { buildWindows } from './walk-forward.js';
export type { WindowSpec } from './walk-forward.js';
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
