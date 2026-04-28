// Shared types and utilities across all packages

export type Side = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';
export type SignalType = 'orb_breakout' | 'reversal' | 'macd_cross' | 'ichimoku' | 'scalping' | 'swing_trade';
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
  exitPrice?: number;
  pnl?: number;
}

export interface AccountState {
  totalEquity: number;
  availableCash: number;
  openPositions: Position[];
  dailyPnl: number;
  weeklyPnl?: number;
  monthlyPnl?: number;
  yearlyPnl?: number;
  allTimePnl?: number;
}

export const DEFAULT_RISK_PER_TRADE = 0.01; // 1% of account equity
export const MANAGED_ACCOUNT_RATIO = 0.5;   // 50% of total account auto-managed

// ── Account Modes ─────────────────────────────────────────────────────────────

export type AccountMode = 'demo' | 'live';
export type BrokerageType = 'webull' | 'coinbase';
export type LiveTradeMode = 'ai_in_brokerage' | 'transfer_to_platform';

export interface AccountSettings {
  mode: AccountMode;
  // Demo mode settings
  demoEquity: number;
  demoEquityStocks: number;
  demoEquityCrypto: number;
  dailyTradesLimit: number;
  managedAccountRatio: number;
  riskPerTrade: number;
  // Auto-trading persistence — survives server restarts
  stocksAutoTradingEnabled: boolean;
  cryptoAutoTradingEnabled: boolean;
  // Live mode settings
  liveBrokerageType?: BrokerageType;
  liveTradeMode?: LiveTradeMode;
  liveApiKey?: string;
  liveAccountId?: string;
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  mode: 'demo',
  demoEquity: 25_000,
  demoEquityStocks: 25_000,
  demoEquityCrypto: 25_000,
  dailyTradesLimit: 10,
  managedAccountRatio: 0.5,
  riskPerTrade: 0.01,
  stocksAutoTradingEnabled: true,
  cryptoAutoTradingEnabled: true,
  liveBrokerageType: 'webull',
  liveTradeMode: 'ai_in_brokerage',
  liveApiKey: '',
  liveAccountId: '',
};
export const WATCHLIST_SIZE = 25;
export const OPTIONS_BUDGET_RATIO = 0.05;   // 5% of managed equity per options trade
export const OPTIONS_TP1_PCT = 0.25;         // take partial profit (50%) at +25% premium gain
export const OPTIONS_TP2_PCT = 0.50;         // final TP target at +50% gain on remaining half
export const OPTIONS_SL_PCT = 0.25;          // stop loss at 25% loss (improved R:R vs previous 35%)
export const OPTIONS_ATM_PREMIUM_RATIO = 0.02; // estimated ATM premium ≈ 2% of underlying
export const OPTIONS_DAILY_LIMIT = 4;        // max 4 high-quality trades per day (was 10)
export const OPTIONS_TRAIL_ACTIVATE_PCT = 0.20; // activate trailing stop once position is up 20%
export const OPTIONS_TRAIL_OFFSET_PCT = 0.12; // trail 12% below peak (tighter than previous 15%)
export const OPTIONS_PARTIAL_EXIT_RATIO = 0.5; // exit 50% of contracts at TP1; trail the rest

// Market regime thresholds (ADX-based)
export const ADX_TRENDING_THRESHOLD = 25;   // ADX > 25 → trending → favor ORB/MACD/Ichimoku
export const ADX_RANGING_THRESHOLD = 20;    // ADX < 20 → ranging → favor reversal; avoid ORB

// Daily risk circuit-breakers
export const MAX_CONSECUTIVE_LOSSES = 3;     // halt new entries after 3 consecutive losses
export const DAILY_DRAWDOWN_HALT_PCT = 0.08; // halt if daily P&L < −8% of managed equity

// Valid ET trading windows stored as [startMinuteOfDay, endMinuteOfDay]
export const TRADING_WINDOWS: readonly [number, number][] = [
  [9 * 60 + 35,  11 * 60 + 30],  // 9:35–11:30 AM ET (morning session)
  [13 * 60 + 30, 15 * 60 + 30],  // 1:30–3:30 PM ET (afternoon session)
] as const;

/**
 * Returns the US Eastern Time UTC offset in hours for a given UTC timestamp.
 * EDT (UTC-4) from second Sunday in March through first Sunday in November;
 * EST (UTC-5) the rest of the year.
 */
export function getEasternUtcOffset(utcMs: number): -4 | -5 {
  const d = new Date(utcMs);
  const year = d.getUTCFullYear();

  // Second Sunday in March (DST starts at 2 AM local, approximated as UTC midnight)
  const march1Day = new Date(Date.UTC(year, 2, 1)).getUTCDay(); // 0=Sun
  const dstStart = new Date(Date.UTC(year, 2, 1 + ((7 - march1Day) % 7) + 7));

  // First Sunday in November (DST ends)
  const nov1Day = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const dstEnd = new Date(Date.UTC(year, 10, 1 + ((7 - nov1Day) % 7)));

  return utcMs >= dstStart.getTime() && utcMs < dstEnd.getTime() ? -4 : -5;
}

/** Returns true when the UTC timestamp falls inside a valid ET trading window. */
export function isValidTradingWindow(utcMs: number): boolean {
  const offsetHours = getEasternUtcOffset(utcMs);
  const etMs = utcMs + offsetHours * 60 * 60 * 1000;
  const etMinutes = Math.floor(etMs / 60_000) % (24 * 60);
  return TRADING_WINDOWS.some(([start, end]) => etMinutes >= start && etMinutes <= end);
}

/**
 * Returns true when US stock markets are currently open (weekdays 9:30 AM–4:00 PM ET,
 * excluding weekends). Does not account for market holidays.
 */
export function isStockMarketOpen(utcMs: number = Date.now()): boolean {
  const offsetHours = getEasternUtcOffset(utcMs);
  const etMs = utcMs + offsetHours * 60 * 60 * 1000;
  const etDate = new Date(etMs);
  const dayOfWeek = etDate.getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const etMinutes = etDate.getUTCHours() * 60 + etDate.getUTCMinutes();
  return etMinutes >= 9 * 60 + 30 && etMinutes < 16 * 60;
}

// Crypto trading windows (UTC minutes) — skip dead zone 04:00–07:59
// Based on academic analysis: peak volume/volatility 12:00–17:00, secondary peaks at 00:00 and 08:00.
export const CRYPTO_TRADING_WINDOWS: readonly [number, number][] = [
  [0 * 60,   4 * 60],   // 00:00–04:00 UTC (Asian session open)
  [8 * 60,  12 * 60],   // 08:00–12:00 UTC (London session open)
  [12 * 60, 17 * 60],   // 12:00–17:00 UTC (London/NY overlap — peak volatility)
  [21 * 60, 24 * 60],   // 21:00–24:00 UTC (pre-Asian accumulation)
] as const;

/** Returns true when the UTC timestamp falls inside an active crypto trading window. */
export function isValidCryptoTradingWindow(utcMs: number): boolean {
  const utcMinutes = Math.floor(utcMs / 60_000) % (24 * 60);
  return CRYPTO_TRADING_WINDOWS.some(([start, end]) => utcMinutes >= start && utcMinutes < end);
}

// Backward-compat alias
export const OPTIONS_TP_PCT = OPTIONS_TP1_PCT;

export interface OptionPosition {
  id: string;
  symbol: string;
  optionSymbol?: string;      // OCC format, e.g. AAPL240419C00150000
  optionType: OptionType;
  strike?: number;
  expiration?: string;
  contracts: number;
  contractsRemaining: number; // after partial exit at TP1; starts equal to contracts
  premiumPaid: number;        // per-share premium at entry
  currentPremium: number;     // current mark (updated on each tick)
  tp1Premium: number;         // partial exit trigger at +25%
  tp1Hit: boolean;            // true once 50% has been exited at TP1
  stopLossPremium: number;    // hard stop loss at -25% (improved from -35%)
  peakPremium: number;        // highest mark seen (used for trailing stop)
  trailingActive: boolean;    // true once price is up 20% and trailing mode engaged
  trailingStopPremium: number; // current trailing stop level (peak * (1 - 0.12))
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

export const CRYPTO_WATCHLIST: readonly string[] = [
  'BTC-USD',   'ETH-USD',   'BNB-USD',   'SOL-USD',   'ADA-USD',
  'DOT-USD',   'AVAX-USD',  'LINK-USD',  'MATIC-USD', 'XRP-USD',
  'LTC-USD',   'BCH-USD',   'ATOM-USD',  'DOGE-USD',  'SHIB-USD',
  'NEAR-USD',  'FTM-USD',   'SAND-USD',  'MANA-USD',  'AXS-USD',
  'UNI-USD',   'AAVE-USD',  'MKR-USD',   'CRV-USD',   'ALGO-USD',
  'XLM-USD',   'ETC-USD',   'TRX-USD',   'FIL-USD',   'VET-USD',
  'THETA-USD', 'HBAR-USD',  'ICP-USD',   'FLOW-USD',  'GRT-USD',
  'ARB-USD',   'OP-USD',    'APT-USD',   'SUI-USD',   'INJ-USD',
  'RUNE-USD',  'RNDR-USD',  'IMX-USD',   'EGLD-USD',  'LDO-USD',
  'SNX-USD',   'APE-USD',   'COMP-USD',  'CHZ-USD',   'ZEC-USD',
] as const;

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary?: string;
}

export interface CryptoSymbolState {
  symbol: string;
  price: number;
  volume: number;
  change: number;
  changePct: number;
  lastUpdated: number;
  /**
   * Why this symbol's quote is missing/stale. The watchlist UI uses this to render
   * a useful state ("Quote unavailable — provider rate-limited") instead of a
   * permanent "Loading…" spinner when upstream providers are down.
   */
  quoteStatus?: 'ok' | 'rate_limited' | 'unavailable';
}

export interface CryptoEngineState {
  symbols: CryptoSymbolState[];
  signals: TradeSignal[];
  account: AccountState;
  closedPositions: Position[];
  news: NewsItem[];
  lastTick: number;
  autoTradingEnabled: boolean;
  /** Always true — crypto trades 24/7 */
  marketOpen: true;
}

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
  strategy: 'ORB' | 'Reversal' | 'MACD' | 'Ichimoku' | 'Scalping' | 'Swing';
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
