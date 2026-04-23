// Shared types and utilities across all packages

export type Side = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';
export type SignalType = 'orb_breakout' | 'reversal';

export interface Candle {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeSignal {
  id: string;
  symbol: string;
  type: SignalType;
  side: Side;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  timestamp: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  closedAt?: number;
  pnl?: number;
}

export interface AccountState {
  totalEquity: number;
  availableCash: number;
  openPositions: Position[];
  dailyPnl: number;
}

export const DEFAULT_RISK_PER_TRADE = 0.01; // 1% of account equity
export const MANAGED_ACCOUNT_RATIO = 0.5;   // 50% of total account auto-managed
export const WATCHLIST_SIZE = 25;

export const WATCHLIST: readonly string[] = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN',
  'META',  'TSLA', 'AMD',  'NFLX',  'ORCL',
  'INTC',  'QCOM', 'AVGO', 'CRM',   'ADBE',
  'PYPL',  'SQ',   'SHOP', 'COIN',  'MSTR',
  'SPY',   'QQQ',  'IWM',  'DIA',   'XLF',
] as const;

export interface MarketBar {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  vwap: number;
  timeframe: '1Min' | '5Min';
}

export interface MarketTrade {
  symbol: string;
  timestamp: number;
  price: number;
  size: number;
  conditions: string[];
  exchange: string;
}

export interface MarketQuote {
  symbol: string;
  timestamp: number;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
}
