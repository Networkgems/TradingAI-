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
export { TradierOrderClient, TradierOptionsClient, TradierStocksClient, tradierBaseUrl, underlyingFromOcc } from './tradier/index.js';
export type {
  TradierEnv,
  TradierBracketOrderParams,
  TradierOrderResponse,
  TradierOptionsContract,
  TradierOptionQuote,
  TradierEquityQuote,
  TradierAccountBalance,
} from './tradier/index.js';
export { CoinbaseOrderClient } from './coinbase/index.js';
export type {
  CoinbaseOrderClientOptions,
  CoinbaseAccountBalance,
  CoinbaseOrderSuccessResponse,
  CoinbaseOrderDetails,
  CoinbaseProductInfo,
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
} from './router.js';
export {
  TIME_STOP_BARS,
  initLifecycleState,
  advanceExtreme,
  momentumTrailStop,
  breakoutTrailStop,
  meanReversionRsiAltExitTriggered,
  timeStopBarsFor,
} from './lifecycle.js';
export type { LifecycleState, BreakoutTrailOptions } from './lifecycle.js';
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
