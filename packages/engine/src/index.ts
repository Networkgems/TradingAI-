// Trading engine sidecar — signal generation, order management, position tracking

export { OrbStrategy } from './strategies/orb.js';
export type { OrbOptions } from './strategies/orb.js';
export type { SharedTickIndicators } from './strategies/shared-indicators.js';
export { ReversalStrategy } from './strategies/archived/reversal.js';
export type { ReversalOptions } from './strategies/archived/reversal.js';
export { MacdTrendStrategy } from './strategies/archived/macd-trend.js';
export type { MacdTrendOptions } from './strategies/archived/macd-trend.js';
export { BbFadeStrategy } from './strategies/bb-fade.js';
export type { BbFadeOptions } from './strategies/bb-fade.js';
export { MomentumStrategy } from './strategies/archived/momentum.js';
export type { MomentumOptions } from './strategies/archived/momentum.js';
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
export { MeanReversionCryptoStrategy } from './strategies/archived/mean-reversion-crypto.js';
export type { MeanReversionCryptoOptions } from './strategies/archived/mean-reversion-crypto.js';
export { BreakoutVolStrategy } from './strategies/archived/breakout-vol.js';
export type { BreakoutVolOptions } from './strategies/archived/breakout-vol.js';
export { IchimokuStrategy } from './strategies/ichimoku-strategy.js';
export type { IchimokuOptions } from './strategies/ichimoku-strategy.js';
export { ScalpingStrategy } from './strategies/archived/scalping-strategy.js';
export type { ScalpingOptions } from './strategies/archived/scalping-strategy.js';
export { SwingStrategy } from './strategies/archived/swing-strategy.js';
export type { SwingOptions } from './strategies/archived/swing-strategy.js';
export { CryptoDcaStrategy } from './strategies/crypto-dca.js';
export type { DcaOptions } from './strategies/crypto-dca.js';
export {
  SupertrendConfluenceStrategy,
  evaluateSupertrendConfluence,
  evaluateSupertrendConfluenceRow,
  confluenceSide,
  confluenceReads,
  SUPERTREND_MIN_CONFIRM_BARS,
} from './strategies/supertrend-confluence.js';
export type {
  SupertrendConfluenceParams,
  ConfluenceReads,
  SupertrendShadowRow,
} from './strategies/supertrend-confluence.js';
export {
  TsmomMajorsStrategy,
  evaluateTsmomMajors,
  tsmomExitToFlat,
  trailingTotalReturn,
  tsmomSizingStopFraction,
  resolveTsmomMajorsParams,
  TSMOM_BARS_PER_YEAR,
} from './strategies/tsmom-majors.js';
export type {
  TsmomMajorsParams,
  ResolvedTsmomMajorsParams,
} from './strategies/tsmom-majors.js';
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
export {
  chandelierMultiplier,
  chandelierStop,
  chandelierExitTriggered,
  stopModifyDecision,
  profitLockDecision,
  bookGiveBackDecision,
} from './exit-rules.js';
export type {
  Side,
  ChandelierParams,
  StopModifyParams,
  StopModifyDecision,
  ProfitLockParams,
  ProfitLockDecision,
  BookGiveBackParams,
  BookHaltReason,
  BookGiveBackDecision,
} from './exit-rules.js';
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
  parseTradierOrderLegs,
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
  TradierOrderLeg,
  TradierOptionsContract,
  TradierOptionQuote,
  TradierEquityQuote,
  TradierAccountBalance,
  TradierOpenOptionPosition,
  TradierOpenEquityPosition,
  TradierTradeHistoryFill,
  TradierCashEvent,
  TradierMultilegSide,
  TradierMultilegLeg,
  TradierMultilegPricing,
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
export { rsi, rsiDivergence, VwapTracker, detectPattern, isBullishPattern, isBearishPattern, adx, choppinessIndex, efficiencyRatio, ema, emaCross, emaSeries, maSlope, atr, atrPct, supertrend, supertrendLatest, SUPERTREND_DEFAULT_PERIOD, SUPERTREND_DEFAULT_FACTOR, donchian, ichimoku, tkCross, composeTechnicalSnapshot, composeTimeframeSignal, resampleCandles, mtfBiasOf, MTF_CHOP_ADX, MTF_TF_WEIGHTS, TF_BUCKET_MS } from './indicators/index.js';
export type { VwapState, CandlePattern, AdxResult, DonchianChannel, IchimokuState, TimeframeCandles, SupertrendBar, SupertrendDirection, SupertrendOptions } from './indicators/index.js';
// TRA-920 — swing-based S/R zones + reversal-confluence checklist (TRA-921 wires
// these into the OBSERVE-ONLY reversal shadow ledger).
export { findSwings, supportResistance, reversalChecklist } from './indicators/index.js';
// NOTE: SwingOptions / ReversalOptions are already exported above from the
// archived strategies, so they are intentionally NOT re-exported here.
export type { SwingPoint, SrZone, SrLevels, ReversalChecklist } from './indicators/index.js';
export {
  evaluateSma200,
  smaSeries,
  SMA200_MIN_BARS,
  SMA200_MIN_PRICE,
  SMA200_MIN_AVG_DOLLAR_VOL,
  SMA200_DEBOUNCE_BARS,
} from './sma200-signals.js';
export type {
  Sma200Indicators,
  Sma200SignalResult,
  Sma200SignalKind,
  Sma200Evaluation,
} from './sma200-signals.js';
export { evaluateShortSqueeze, DEFAULT_SHORT_SQUEEZE_THRESHOLDS } from './short-squeeze/short-squeeze.js';
export type {
  ShortSqueezeFundamentals,
  ShortSqueezePriceStats,
  ShortSqueezeThresholds,
  ShortSqueezeFilterKey,
  ShortSqueezeFilterResult,
  ShortSqueezeClassification,
  ShortSqueezeResult,
  EvaluateShortSqueezeOptions,
} from './short-squeeze/short-squeeze.js';
export { RegimeDetector, classifyRegime } from './regime.js';
export type { Regime, RegimeDetectorOptions } from './regime.js';
// TRA-1220 (parent TRA-1218) — crypto ADX/CHOP/ER regime classifier. DISTINCT
// from `classifyRegime` above; the shared substrate rec #2 (regime-gated TSMOM)
// imports.
export { classifyCryptoRegime, CRYPTO_REGIME_DEFAULTS } from './crypto-regime-classifier.js';
export type {
  CryptoRegimeConfig,
  CryptoRegimeReading,
  CryptoRegimeLabel,
} from './crypto-regime-classifier.js';
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
export { blackScholesPrice, blackScholesDelta, blackScholesGreeks, bsImpliedVolatility, daysToExpiration } from './options/black-scholes.js';
export type { BlackScholesInputs, BlackScholesGreeks, ImpliedVolInputs } from './options/black-scholes.js';
export {
  selectStructureByIv,
  selectExpiry,
  isThirdFriday,
  selectStrikeByDelta,
  deltasForStrikes,
  optionTypeForSide,
  evaluateExit,
  sizeOptionContracts,
  DEFAULT_IV_GATE,
  DEFAULT_EXPIRY_PARAMS,
  DEFAULT_DELTA_PARAMS,
  DEFAULT_EXIT_PARAMS,
  DEFAULT_OPTION_SIZING,
} from './options/supertrend-options.js';
export type {
  OptionsStructure,
  IvGateParams,
  StructureDecision,
  ExpiryParams,
  ExpiryCandidate,
  DeltaTargetParams,
  StrikeCandidate,
  ExitParams,
  ExitReason,
  ExitState,
  OptionSizingParams,
  OptionSizingInputs,
  OptionSizingResult,
} from './options/supertrend-options.js';
export {
  selectStrategyKind,
  selectShadowOptionSignal,
  isLiquid,
  DEFAULT_SELECTOR_PARAMS,
} from './options/strategy-selector.js';
export {
  OptionsRiskBreaker,
  DEFAULT_OPTIONS_BREAKER_PARAMS,
} from './options/options-risk-breaker.js';
export type {
  OptionsBreakerParams,
  OptionCloseRecord,
  OptionsBreakerSnapshot,
} from './options/options-risk-breaker.js';
export type {
  OptionTrend,
  OptionStrategyKind,
  ContractQuote,
  StrategySelectorParams,
  StrategySelectorInput,
  LegAction,
  OptionLeg,
  ShadowOptionSignal,
  StrategySelectorResult,
  GateDecision,
  ReversalContext,
} from './options/strategy-selector.js';
export {
  evaluateMultiLegPreTrade,
  DEFAULT_MAX_LOSS_PCT_CAP,
} from './options/multi-leg-gate.js';
export type {
  MultiLegPreTradeInput,
  MultiLegPreTradeVerdict,
} from './options/multi-leg-gate.js';
export {
  evaluatePortfolioGreeksGate,
  DEFAULT_PORTFOLIO_GREEKS_GATE,
} from './options/portfolio-greeks-gate.js';
export type {
  PortfolioGreeksGateConfig,
  PortfolioGreeksGateInput,
  PortfolioGreeksGateVerdict,
} from './options/portfolio-greeks-gate.js';
export { findMispricedOtmContracts } from './options/otm-mispricing.js';
export type {
  OptionChainRow,
  OtmMispricingCandidate,
  OtmScannerOptions,
  Mispricing,
} from './options/otm-mispricing.js';
export {
  findIvRvMispricings,
  realizedVolFromDailyCloses,
} from './options/iv-rv-mispricing.js';
export type {
  IvRvMispricingCandidate,
  IvRvScannerOptions,
  IvRvAction,
} from './options/iv-rv-mispricing.js';
export {
  findRelativeValueOpportunities,
  selectRvLongCandidate,
  RV_LONG_DELTA_TARGET_MIN,
  RV_LONG_DELTA_TARGET_MAX,
  RV_LONG_DTE_ENTRY_MIN,
  RV_LONG_DTE_ENTRY_MAX,
} from './options/relative-value.js';
export type {
  RelativeValueCandidate,
  RelativeValueScannerOptions,
  RelativeValueClassification,
  RvLongTrendSide,
  RvLongSelectionOptions,
} from './options/relative-value.js';
export {
  emaPullbackTrigger,
  volumeConfirmedBreakout,
  EMA_PULLBACK_DEFAULTS,
  VOLUME_BREAKOUT_DEFAULTS,
} from './options/swing-entries.js';
export type {
  SwingSide,
  EmaPullbackOptions,
  EmaPullbackResult,
  VolumeBreakoutOptions,
  VolumeBreakoutResult,
} from './options/swing-entries.js';
export {
  EarningsCalendarClient,
  parseFinnhubEarnings,
  daysUntil,
  nextEarningsDate,
} from './earnings/index.js';
export type { EarningsEvent, EarningsWindowOptions } from './earnings/index.js';
// TRA-597 (TRA-595 C2) — macro / Fed economic-event calendar. `daysUntil` is
// already re-exported above (earnings) so it is intentionally omitted here.
export {
  EconomicCalendarClient,
  parseFredReleaseDates,
  eventsNearDate,
  nextEventOfType,
  daysToNextFOMC,
  fomcEvents,
  FRED_RELEASES,
  FOMC_MEETINGS,
} from './macro/index.js';
export type {
  MacroEvent,
  MacroEventType,
  MacroImportance,
  MacroWindowOptions,
} from './macro/index.js';
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
