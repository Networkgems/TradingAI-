// Shared types and utilities across all packages

export type Side = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';
export type SignalType = 'orb_breakout' | 'reversal' | 'macd_cross' | 'ichimoku';
export type OptionType = 'call' | 'put';

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
  signalType: SignalType;
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

// ── Account Modes ─────────────────────────────────────────────────────────────

export type AccountMode = 'demo' | 'live';
export type BrokerageType = 'webull';
export type LiveTradeMode = 'ai_in_brokerage' | 'transfer_to_platform';

export interface AccountSettings {
  mode: AccountMode;
  // Demo mode settings
  demoEquity: number;
  dailyTradesLimit: number;
  managedAccountRatio: number;
  riskPerTrade: number;
  // Live mode settings
  liveBrokerageType?: BrokerageType;
  liveTradeMode?: LiveTradeMode;
  liveApiKey?: string;
  liveAccountId?: string;
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  mode: 'demo',
  demoEquity: 25_000,
  dailyTradesLimit: 10,
  managedAccountRatio: 0.5,
  riskPerTrade: 0.01,
  liveBrokerageType: 'webull',
  liveTradeMode: 'ai_in_brokerage',
  liveApiKey: '',
  liveAccountId: '',
};
export const WATCHLIST_SIZE = 25;
export const OPTIONS_BUDGET_RATIO = 0.05;   // 5% of managed equity per options trade
export const OPTIONS_TP_PCT = 0.25;          // take profit at 25% gain on premium
export const OPTIONS_SL_PCT = 0.35;          // stop loss at 35% loss on premium
export const OPTIONS_ATM_PREMIUM_RATIO = 0.02; // estimated ATM premium ≈ 2% of underlying
export const OPTIONS_DAILY_LIMIT = 10;       // max 10 options trades per trading day
export const OPTIONS_TRAIL_OFFSET_PCT = 0.15; // trailing stop 15% below peak once TP is hit

export interface OptionPosition {
  id: string;
  symbol: string;
  optionSymbol?: string;      // OCC format, e.g. AAPL240419C00150000
  optionType: OptionType;
  strike?: number;
  expiration?: string;
  contracts: number;
  premiumPaid: number;        // per-share premium at entry
  currentPremium: number;     // current mark (updated on each tick)
  takeProfitPremium: number;  // initial TP trigger at +25%
  stopLossPremium: number;    // hard stop loss at -35%
  peakPremium: number;        // highest mark seen (used for trailing stop)
  trailingActive: boolean;    // true once TP is hit and trailing mode engaged
  trailingStopPremium: number; // current trailing stop level (peak * (1 - TRAIL_OFFSET))
  underlyingEntryPrice: number;
  openedAt: number;
  closedAt?: number;
  pnl?: number;
  signalId: string;
  signalType: SignalType;
}

export interface OptionsAccountState {
  openOptions: OptionPosition[];
  closedOptions: OptionPosition[];
  optionsPnl: number;
  optionsCash: number;
  dailyOptionsCount: number;  // number of options opened today (resets at market open)
}

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

// ── EOD Report Types ─────────────────────────────────────────────────────────

export interface EodTradeEntry {
  id: string;
  symbol: string;
  strategy: 'ORB' | 'Reversal' | 'MACD' | 'Ichimoku';
  side: Side;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  /** Achieved R:R — how many R units the trade made/lost */
  rr: number;
  openedAt: number;
  closedAt: number;
}

export interface EodMover {
  symbol: string;
  price: number;
  changePct: number;
}

export interface EodSignalAccuracy {
  totalSignals: number;
  /** Signals that closed with profit (TP hit) */
  winningSignals: number;
  winRate: number;
  avgRR: number;
}

export interface EodReport {
  date: string;          // YYYY-MM-DD
  generatedAt: number;   // Unix ms

  // P&L
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  optionsPnl: number;
  combinedPnl: number;

  // Account
  totalEquity: number;
  managedEquity: number;  // 50% allocation
  availableCash: number;

  // Trades
  trades: EodTradeEntry[];
  openPositionCount: number;

  // Performance
  winRate: number;         // % of closed trades that were winners
  avgRR: number;           // average risk-reward achieved
  totalTrades: number;
  winners: number;
  losers: number;

  // Market
  top5Movers: EodMover[];

  // Signal accuracy
  signalAccuracy: EodSignalAccuracy;

  // Markdown report body
  markdown: string;
}
