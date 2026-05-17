// Trading engine sidecar — signal generation, order management, position tracking

export { OrbStrategy } from './strategies/orb.js';
export type { OrbOptions } from './strategies/orb.js';
export { ReversalStrategy } from './strategies/reversal.js';
export type { ReversalOptions } from './strategies/reversal.js';
export { MacdTrendStrategy } from './strategies/macd-trend.js';
export type { MacdTrendOptions } from './strategies/macd-trend.js';
export { BbFadeStrategy } from './strategies/bb-fade.js';
export type { BbFadeOptions } from './strategies/bb-fade.js';
export { MomentumStrategy } from './strategies/momentum.js';
export type { MomentumOptions } from './strategies/momentum.js';
export {
  BTC_RSI_BRACKET_DEFAULTS,
  resolveBtcRsiBracket,
  tryBtcRsiBracketShort,
} from './strategies/btc-rsi-bracket.js';
export type {
  BtcRsiBracketOverride,
  ResolvedBtcRsiBracket,
  BtcRsiBracketEvalArgs,
} from './strategies/btc-rsi-bracket.js';
export { MeanReversionCryptoStrategy } from './strategies/mean-reversion-crypto.js';
export type { MeanReversionCryptoOptions } from './strategies/mean-reversion-crypto.js';
export { BreakoutVolStrategy } from './strategies/breakout-vol.js';
export type { BreakoutVolOptions } from './strategies/breakout-vol.js';
export { IchimokuStrategy } from './strategies/ichimoku-strategy.js';
export type { IchimokuOptions } from './strategies/ichimoku-strategy.js';
export { ScalpingStrategy } from './strategies/scalping-strategy.js';
export type { ScalpingOptions } from './strategies/scalping-strategy.js';
export { SwingStrategy } from './strategies/swing-strategy.js';
export type { SwingOptions } from './strategies/swing-strategy.js';
export { RiskManager } from './risk.js';
export type { RiskManagerOptions } from './risk.js';
export {
  CorrelationMatrix,
  admitUnderClusterCap,
  formClusters,
  resolveCorrelationCapConfig,
  assetClassOf,
  dailyLogReturns,
  toDailyCloses,
  pearson,
  utcDayOf,
  DEFAULT_CORRELATION_CAP_CONFIG,
  CORRELATION_WINDOW_OBS,
  MIN_CORRELATION_OBS,
} from './correlation-cap.js';
export type {
  CorrelationCapConfig,
  CorrelationFn,
  ClusterCapPosition,
  ClusterCapCandidate,
  ClusterCapBinding,
  ClusterCapDecision,
} from './correlation-cap.js';
export {
  trailingRealisedVol,
  volScalar,
  volRiskPct,
  kellyFull,
  kellyCapPct,
  effectiveRiskPct,
  resolveVolKellySizerConfig,
  barsPerYearFor,
  DEFAULT_VOL_KELLY_SIZER_CONFIG,
} from './vol-kelly-sizer.js';
export type {
  VolKellySizerConfig,
  CellExpectancy,
} from './vol-kelly-sizer.js';
export { PositionManager } from './positions.js';
export { AlpacaFeed } from './feed/index.js';
export type { AlpacaFeedEvents } from './feed/index.js';
export { CoinbaseFeed } from './feed/index.js';
export type { CoinbaseFeedEvents, CoinbaseFeedOptions } from './feed/index.js';
export { AlpacaOrderClient } from './alpaca/index.js';
export type { BracketOrderParams, AlpacaOrderResponse } from './alpaca/index.js';
export { AlpacaOptionsClient } from './alpaca/index.js';
export type { AlpacaOptionsContract, AlpacaOptionOrderResponse } from './alpaca/index.js';
export { TradierFeed } from './feed/index.js';
export type { TradierFeedEvents } from './feed/index.js';
export {
  TradierOrderClient,
  TradierOptionsClient,
  TradierStocksClient,
  tradierBaseUrl,
  underlyingFromOcc,
  parseOccSymbol,
  parseTradierPositions,
  parseTradierEquityPositions,
  parseTradierHistory,
  parseTradierCashEvents,
  roundToCent,
  TRADIER_TERMINAL_STATUSES,
  TRADIER_REJECTED_STATUSES,
} from './tradier/index.js';
export type {
  TradierEnv,
  TradierBracketOrderParams,
  TradierOrderResponse,
  TradierOrderDetail,
  TradierOptionsContract,
  TradierOptionQuote,
  TradierEquityQuote,
  TradierAccountBalance,
  TradierOpenOptionPosition,
  TradierOpenEquityPosition,
  TradierTradeHistoryFill,
  TradierCashEvent,
} from './tradier/index.js';
export { CoinbaseOrderClient } from './coinbase/index.js';
export type {
  CoinbaseOrderClientOptions,
  CoinbaseAccountBalance,
  CoinbaseOrderSuccessResponse,
  CoinbaseOrderDetails,
  CoinbaseProductInfo,
  CoinbaseListedProduct,
  CoinbaseFuturesPosition,
  CoinbaseFundingRate,
  CoinbasePerpMetrics,
  CoinbaseProductBook,
  CoinbaseMarginType,
  CoinbasePositionSide,
  MarketOrderParams as CoinbaseMarketOrderParams,
  LimitOrderParams as CoinbaseLimitOrderParams,
} from './coinbase/index.js';
export { rsi, rsiDivergence, VwapTracker, detectPattern, isBullishPattern, isBearishPattern, adx, ema, emaCross, emaSeries, maSlope, atr, atrPct, donchian, ichimoku, tkCross } from './indicators/index.js';
export type { VwapState, CandlePattern, AdxResult, DonchianChannel, IchimokuState } from './indicators/index.js';
export { RegimeDetector, classifyRegime } from './regime.js';
export type { Regime, RegimeDetectorOptions } from './regime.js';
export { StrategyRouter, DEFAULT_ROUTER_PRIORITY } from './router.js';
export type {
  StrategyRouterOptions,
  RouterEvaluation,
  RouterPriority,
  RouterUniverse,
} from './router.js';
export {
  TIME_STOP_BARS,
  MOMENTUM_TRAIL_PERIOD_BY_SIDE,
  BREAKOUT_TRAIL_OPTIONS_BY_SIDE,
  initLifecycleState,
  advanceExtreme,
  momentumTrailStop,
  breakoutTrailStop,
  meanReversionRsiAltExitTriggered,
  timeStopBarsFor,
  momentumTrailPeriodFor,
  breakoutTrailOptionsFor,
} from './lifecycle.js';
export type { LifecycleState, BreakoutTrailOptions } from './lifecycle.js';
export {
  PERP_SHORTS_UNIVERSE,
  PERP_SHORTS_TIER2,
  PERP_SHORT_RISK_TIER1,
  PERP_SHORT_RISK_TIER2,
  PERP_SHORT_SINGLE_SYMBOL_CAP,
  PERP_SHORT_SINGLE_SYMBOL_CAP_MAX,
  resolveSingleSymbolShortCap,
  PERP_SHORT_CROSS_STRATEGY_CAP,
  PERP_SHORT_TOTAL_NOTIONAL_CAP,
  FUNDING_GATE_THRESHOLD_PER_HOUR,
  FUNDING_FLIP_INTERVALS,
  SPREAD_GATE_FRACTION,
  OI_GATE_USD,
  VOL_EXPANSION_ATR_RATIO,
  VOL_EXPANSION_BAR_LOOKBACK,
  DAILY_SHORT_CIRCUIT_BREAKER_PCT,
  MAX_CONCURRENT_SHORTS,
  CONSECUTIVE_LOSS_THRESHOLD,
  CONSECUTIVE_LOSS_COOLDOWN_MS,
  SKIP_NOT_IN_UNIVERSE,
  SKIP_MR_OFF_STRATEGY,
  SKIP_FUNDING_TOO_NEGATIVE,
  SKIP_BTC_TREND_UP,
  SKIP_SPREAD_TOO_WIDE,
  SKIP_OI_UNDER_MIN,
  SKIP_TOTAL_SHORT_NOTIONAL,
  SKIP_SINGLE_SYMBOL_CAP,
  SKIP_CROSS_STRATEGY_CAP,
  SKIP_CONSECUTIVE_LOSSES,
  SKIP_MAX_CONCURRENT_SHORTS,
  SKIP_PARKED_1D_DAILY,
  SKIP_PARKED_4H_LAYER12,
  SKIP_PARKED_4H_R9,
  isPerpShortSymbol,
  isTier2PerpShort,
  perpShortRiskFraction,
  evaluateShortFilters,
  evaluateShortNotionalCaps,
  evaluateShortBookCaps,
  symbolShortCooldownActive,
  fundingFlipStopTriggered,
  adverseVolExpansionShortExitTriggered,
  dailyShortCircuitBreakerTripped,
} from './perp-shorts.js';
export type {
  ShortFilterContext,
  ShortNotionalCapInputs,
  ShortBookCapInputs,
  ClosedShortTrade,
} from './perp-shorts.js';
export { blackScholesPrice, blackScholesDelta, bsImpliedVolatility, daysToExpiration } from './options/black-scholes.js';
export type { BlackScholesInputs, ImpliedVolInputs } from './options/black-scholes.js';
export { findMispricedOtmContracts } from './options/otm-mispricing.js';
export type {
  OptionChainRow,
  OtmMispricingCandidate,
  OtmScannerOptions,
  Mispricing,
} from './options/otm-mispricing.js';
export { findRelativeValueOpportunities } from './options/relative-value.js';
export type {
  RelativeValueCandidate,
  RelativeValueScannerOptions,
  RelativeValueClassification,
} from './options/relative-value.js';
export {
  cryptoTieredCostModel,
  flatCostModel,
  cryptoTierOf,
  CRYPTO_TIER_FILLS,
  DEFAULT_CRYPTO_TIERS,
} from './cost/index.js';
export type {
  FillCost,
  CostModel,
  CryptoSpreadTier,
  CryptoTierEntry,
  CryptoTieredCostModelOptions,
} from './cost/index.js';
