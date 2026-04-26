import { Position } from '@trading-app/shared';

export interface BacktestReversalOpts {
  rsiPeriod?: number;
  rsiOverbought?: number;
  rsiOversold?: number;
  lookback?: number;
}

export interface BacktestMacdBollingerOpts {
  bbPeriod?: number;
  bbMultiplier?: number;
  volumeMultiplier?: number;
  volumeLookback?: number;
}

export interface BacktestConfig {
  symbol: string;
  startDate: number;
  endDate: number;
  initialEquity: number;
  strategyType: 'orb' | 'reversal' | 'macd' | 'ichimoku' | 'combined' | 'macd_bollinger';
  reversalOpts?: BacktestReversalOpts;
  macdBollingerOpts?: BacktestMacdBollingerOpts;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: Position[];
  totalPnl: number;
  winRate: number;
  avgRiskReward: number;
  maxDrawdown: number;
  sharpeRatio: number;
  totalTrades: number;
  winners: number;
  losers: number;
  profitFactor: number;
}
