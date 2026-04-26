// Trading engine sidecar — signal generation, order management, position tracking

export { OrbStrategy } from './strategies/orb.js';
export { ReversalStrategy } from './strategies/reversal.js';
export { MacdBollingerStrategy } from './strategies/macd-bollinger.js';
export { IchimokuStrategy } from './strategies/ichimoku-strategy.js';
export { ScalpingStrategy } from './strategies/scalping-strategy.js';
export type { ScalpingOptions } from './strategies/scalping-strategy.js';
export { SwingStrategy } from './strategies/swing-strategy.js';
export type { SwingOptions } from './strategies/swing-strategy.js';
export { RiskManager } from './risk.js';
export { PositionManager } from './positions.js';
export { AlpacaFeed } from './feed/index.js';
export type { AlpacaFeedEvents } from './feed/index.js';
export { AlpacaOrderClient } from './alpaca/index.js';
export type { BracketOrderParams, AlpacaOrderResponse } from './alpaca/index.js';
export { AlpacaOptionsClient } from './alpaca/index.js';
export type { AlpacaOptionsContract, AlpacaOptionOrderResponse } from './alpaca/index.js';
export { rsi, rsiDivergence, VwapTracker, detectPattern, isBullishPattern, isBearishPattern, adx, ema, emaCross } from './indicators/index.js';
export type { VwapState, CandlePattern, AdxResult } from './indicators/index.js';
