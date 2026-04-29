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
