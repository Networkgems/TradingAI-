// Shared types and utilities across all packages

export type Side = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';
export type SignalType =
  | 'orb_breakout'
  | 'reversal'
  | 'macd_cross'   // legacy MacdBollingerStrategy — kept so historical positions/snapshots still type-check
  | 'macd_trend'   // TRA-170: trend-continuation half of the split MACD-Bollinger
  | 'bb_fade'      // TRA-170: pure mean-reversion half
  | 'ichimoku'
  | 'scalping'
  | 'swing_trade'
  | 'otm_mispricing'
  | 'relative_value'; // TRA-191: options chain relative-value scanner (IV skew + monotonic + no-arb)
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

/**
 * Signal emitted by the OTM mispricing scanner (TRA-159) for cheap OTM contracts
 * — long-only path. `entryPrice` is the per-share option mark so the existing
 * watchlist UI can render it without special-casing; option-specific fields ride
 * along on the same record so `PaperOptionsAccount.openOptionFromCandidate` can
 * sticker the position with the OCC symbol, strike, and theo without a second
 * lookup.
 */
export interface OtmMispricingSignal extends TradeSignal {
  type: 'otm_mispricing';
  side: 'buy';
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  /** Per-share mark used as the entry premium. */
  mark: number;
  /** Black-Scholes theoretical price for the contract at scan time. */
  theo: number;
  /** (mark − theo) / theo. Negative for `cheap` candidates. */
  mispricingPct: number;
  /** Sign-adjusted Black-Scholes delta from the scanner. */
  delta: number;
}

/**
 * Signal emitted by the options chain relative-value scanner (TRA-191).
 * Long-only entry when a contract trades cheap relative to its same-expiration
 * IV skew — short legs are deferred to a future defined-risk-spread iteration.
 *
 * `entryPrice` is the per-share mark; the option-specific fields ride along on
 * the same record so `PaperOptionsAccount.openOptionFromRvCandidate` can
 * sticker the position with the OCC symbol, strike, and fair-value reference.
 */
export interface RelativeValueSignal extends TradeSignal {
  type: 'relative_value';
  side: 'buy';
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  /** Per-share mid (entry premium). */
  mark: number;
  /** Black-Scholes price built from the fitted skew IV. */
  fairPrice: number;
  /** (mark − fairPrice) / fairPrice. Negative for cheap candidates. */
  mispricingPct: number;
  /** IV residual versus fitted skew, in standard deviations. */
  zScore: number;
  /** σ predicted by the fitted skew at this strike. */
  ivFitted: number;
  /** σ used for this row (Tradier mid IV / smvVol / BS-implied fallback). */
  ivUsed: number;
  /** Sign-adjusted Black-Scholes delta at the fitted IV. */
  delta: number;
  /** Free-text reason mirrored from the scanner — surfaces in the UI feed. */
  reason: string;
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
  // Live mode settings — legacy un-suffixed fields. Kept as a read-time
  // fallback so existing saved settings still surface in the UI; new writes
  // land on the per-market fields below so Coinbase (crypto) and Webull
  // (stocks) credentials never bleed across dashboards (TRA-165).
  liveBrokerageType?: BrokerageType;
  liveTradeMode?: LiveTradeMode;
  liveApiKey?: string;
  /**
   * API secret paired with `liveApiKey` (e.g. Coinbase Advanced Trade HMAC secret).
   * Stored per-user; if blank, the server falls back to env vars
   * (COINBASE_API_KEY / COINBASE_API_SECRET) when initialising the live broker.
   */
  liveApiSecret?: string;
  liveAccountId?: string;
  // Live mode settings — Crypto (Coinbase). API Secret holds the HMAC secret
  // or full PEM private key; Coinbase has no concept of an Account ID here.
  liveBrokerageTypeCrypto?: BrokerageType;
  liveTradeModeCrypto?: LiveTradeMode;
  liveApiKeyCrypto?: string;
  liveApiSecretCrypto?: string;
  // Live mode settings — Stocks (Webull). Webull uses Account ID for routing
  // and (today) does not require a separate API secret.
  liveBrokerageTypeStocks?: BrokerageType;
  liveTradeModeStocks?: LiveTradeMode;
  liveApiKeyStocks?: string;
  liveAccountIdStocks?: string;
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
  liveApiSecret: '',
  liveAccountId: '',
  liveBrokerageTypeCrypto: 'coinbase',
  liveTradeModeCrypto: 'ai_in_brokerage',
  liveApiKeyCrypto: '',
  liveApiSecretCrypto: '',
  liveBrokerageTypeStocks: 'webull',
  liveTradeModeStocks: 'ai_in_brokerage',
  liveApiKeyStocks: '',
  liveAccountIdStocks: '',
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

// ── OTM long-premium risk overrides (TRA-160) ───────────────────────────────
//
// Far-OTM long premium has a fundamentally different payoff distribution from
// the ATM directional plays the OPTIONS_* constants above are tuned for:
//
//   • most contracts expire worthless → faster theta decay, especially short-DTE
//   • winners are right-tail-heavy (2x–5x is common, 10x is not unheard of)
//   • gamma is higher per dollar of premium → bigger %-moves on same spot move
//
// The risk profile we want is therefore "small budget per ticket, cut losers
// fast, let winners run further". The values below were chosen by sweeping
// SL ∈ {0.18, 0.20, 0.25}, TP1 ∈ {0.40, 0.50, 0.60}, budget ∈ {0.02, 0.025,
// 0.03} on the Geometric-Brownian-Motion premium-path simulator in
// `@trading-app/backtest` (`run-otm-sweep.ts`) and picking the combo with the
// best aggregate P&L ÷ max-drawdown across the trending and choppy regimes.
//
// Daily limit is split out so OTM tickets don't crowd out ATM directional
// signals when both fire on the same day — the engine compares the daily
// count for each kind against its own cap.
export const OTM_OPTIONS_BUDGET_RATIO = 0.025;       // 2.5% of managed equity per OTM ticket
export const OTM_OPTIONS_SL_PCT = 0.20;              // tighter SL — OTM theta bites quickly
export const OTM_OPTIONS_TP1_PCT = 0.50;             // wider TP1 — capture the asymmetric upside
export const OTM_OPTIONS_TP2_PCT = 1.00;             // wider TP2 (informational; trailing handles tail)
export const OTM_OPTIONS_TRAIL_ACTIVATE_PCT = 0.30;  // wait for +30% before engaging trailing
export const OTM_OPTIONS_TRAIL_OFFSET_PCT = 0.20;    // wider trail — OTM marks are noisier
export const OTM_OPTIONS_PARTIAL_EXIT_RATIO = 0.4;   // exit only 40% at TP1; trail more for the right tail
export const OTM_OPTIONS_DAILY_LIMIT = 2;            // separate cap so OTM ≠ competing for ATM slots

/** Risk-parameter bundle handed to the options account for OTM tickets. */
export interface OtmRiskParams {
  budgetRatio: number;
  slPct: number;
  tp1Pct: number;
  trailActivatePct: number;
  trailOffsetPct: number;
  partialExitRatio: number;
  dailyLimit: number;
}

export const OTM_RISK_PARAMS: OtmRiskParams = {
  budgetRatio: OTM_OPTIONS_BUDGET_RATIO,
  slPct: OTM_OPTIONS_SL_PCT,
  tp1Pct: OTM_OPTIONS_TP1_PCT,
  trailActivatePct: OTM_OPTIONS_TRAIL_ACTIVATE_PCT,
  trailOffsetPct: OTM_OPTIONS_TRAIL_OFFSET_PCT,
  partialExitRatio: OTM_OPTIONS_PARTIAL_EXIT_RATIO,
  dailyLimit: OTM_OPTIONS_DAILY_LIMIT,
};

// ── Relative-value scanner risk overrides (TRA-191) ─────────────────────────
//
// Long-only RV entries: pay a cheap mid premium against the fitted skew, exit
// when the residual collapses (target) or runs further away (stop). Cheap-vs-
// curve trades have a different distribution from far-OTM lottery tickets:
//   • most candidates land at moderate moneyness, not deep-OTM tails
//   • theo edge ≈ |(mark − fair)| dollars per share is the expected payoff
//   • winners tend to be 30–80% gains, not 10x lottery wins
//
// We size smaller than ATM directional plays (richer alpha density per ticket)
// and run a tighter stop than OTM far-tail tickets. Daily limit is split out
// so RV doesn't compete with ATM directional or OTM tail slots.
export const RV_OPTIONS_BUDGET_RATIO = 0.03;        // 3% of managed equity per RV ticket
export const RV_OPTIONS_SL_PCT = 0.25;              // tighter than OTM, looser than ATM
export const RV_OPTIONS_TP1_PCT = 0.40;             // partial-take when residual half-collapses
export const RV_OPTIONS_TRAIL_ACTIVATE_PCT = 0.25;  // engage trailing at +25%
export const RV_OPTIONS_TRAIL_OFFSET_PCT = 0.15;
export const RV_OPTIONS_PARTIAL_EXIT_RATIO = 0.5;
export const RV_OPTIONS_DAILY_LIMIT = 4;

export interface RvRiskParams {
  budgetRatio: number;
  slPct: number;
  tp1Pct: number;
  trailActivatePct: number;
  trailOffsetPct: number;
  partialExitRatio: number;
  dailyLimit: number;
}

export const RV_RISK_PARAMS: RvRiskParams = {
  budgetRatio: RV_OPTIONS_BUDGET_RATIO,
  slPct: RV_OPTIONS_SL_PCT,
  tp1Pct: RV_OPTIONS_TP1_PCT,
  trailActivatePct: RV_OPTIONS_TRAIL_ACTIVATE_PCT,
  trailOffsetPct: RV_OPTIONS_TRAIL_OFFSET_PCT,
  partialExitRatio: RV_OPTIONS_PARTIAL_EXIT_RATIO,
  dailyLimit: RV_OPTIONS_DAILY_LIMIT,
};

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
  strategy:
    | 'ORB'
    | 'Reversal'
    | 'MACD'
    | 'MACD Trend'   // TRA-170 split
    | 'BB Fade'      // TRA-170 split
    | 'Ichimoku'
    | 'Scalping'
    | 'Swing'
    | 'OTM'
    | 'RV';          // TRA-191 — relative-value scanner
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
