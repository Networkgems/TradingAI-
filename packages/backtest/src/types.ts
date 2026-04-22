import { Position } from '@trading-app/shared';

export interface BacktestConfig {
  symbol: string;
  startDate: number;
  endDate: number;
  initialEquity: number;
  strategyType: 'orb' | 'reversal' | 'combined';
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
