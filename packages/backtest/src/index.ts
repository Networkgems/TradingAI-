// Historical simulation — replay candle data through strategies and compute metrics

export { BacktestRunner } from './runner.js';
export type { BacktestResult, BacktestConfig } from './types.js';
export { trendingCandles, rangingCandles, mixedRegimeCandles } from './synthetic.js';
