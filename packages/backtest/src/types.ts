import { Position } from '@trading-app/shared';
import type { ReversalOptions } from '@trading-app/engine';
import type { MacdBollingerOptions } from '@trading-app/engine';

export interface BacktestConfig {
  symbol: string;
  startDate: number;
  endDate: number;
  initialEquity: number;
  strategyType: 'orb' | 'reversal' | 'combined' | 'macd_bollinger' | 'ichimoku' | 'all';
  reversalOpts?: ReversalOptions;
  macdBollingerOpts?: MacdBollingerOptions;
  /** Cap the rolling window fed to each strategy (default: 150). Keeps O(n) complexity. */
  maxWindowSize?: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: Position[];
  totalPnl: number;
  winRate: number;
  avgRiskReward: number;
  maxDrawdown: number;
  sharpeRatio: number;
}
