import { Position } from '@trading-app/shared';
import type { OrbOptions, ScalpingOptions, SwingOptions } from '@trading-app/engine';

export interface BacktestReversalOpts {
  rsiPeriod?: number;
  rsiOverbought?: number;
  rsiOversold?: number;
  lookback?: number;
  /** Pass-through to the engine strategy; set false for 24/7 crypto datasets. */
  enforceTimeFilter?: boolean;
  /** TRA-171: ATR-based stop multiplier; 0 forces the fixed-pct / structural stop path. */
  atrStopMultiplier?: number;
  /** TRA-171: skip signals when realized volatility (ATR/price) is below this floor. */
  volatilityFloorPct?: number;
}

export interface BacktestMacdBollingerOpts {
  bbPeriod?: number;
  bbMultiplier?: number;
  volumeMultiplier?: number;
  volumeLookback?: number;
  enforceTimeFilter?: boolean;
  /** TRA-171: ATR-based stop multiplier; 0 forces the fixed-pct / structural stop path. */
  atrStopMultiplier?: number;
  /** TRA-171: skip signals when realized volatility (ATR/price) is below this floor. */
  volatilityFloorPct?: number;
}

/**
 * Portfolio-level concentration controls (TRA-172).
 *
 * `maxOpenPositions` caps the total number of simultaneously open positions
 * across every strategy. `maxSectorExposure` caps how many of those open
 * positions may share the same sector bucket — e.g. all `*-USD` crypto symbols
 * roll up into a single "crypto" bucket so the engine can't pile five highly
 * correlated coins on the same directional bet.
 */
export interface PortfolioOpts {
  maxOpenPositions?: number;
  maxSectorExposure?: number;
  /**
   * Optional symbol → sector resolver. Defaults to a heuristic that maps any
   * `*-USD` ticker to `crypto` and everything else to `equity`.
   */
  sectorOf?: (symbol: string) => string;
}

export interface SignalEdgeOpts {
  /**
   * Bars to look ahead for the 1R-target test. Default = 24 (one trading
   * session of 1-minute bars covers the morning session).
   */
  lookaheadBars?: number;
}

export interface BacktestConfig {
  symbol: string;
  startDate: number;
  endDate: number;
  initialEquity: number;
  strategyType:
    | 'orb'
    | 'reversal'
    | 'macd'
    | 'macd_trend'
    | 'bb_fade'
    | 'ichimoku'
    | 'combined'
    | 'macd_bollinger'
    | 'scalping'
    | 'swing';
  reversalOpts?: BacktestReversalOpts;
  macdBollingerOpts?: BacktestMacdBollingerOpts;
  /**
   * Pass-through to OrbStrategy. Use this to inject `timeFilter:
   * isValidCryptoTradingWindow` and a `sessionAnchorTimestampOf` callback for
   * crypto datasets — without it the default ET equity session anchor blocks
   * every crypto bar (verified empirically: 0 trades on 6,483 bars of
   * BTC/ETH/SOL 1h data).
   */
  orbOpts?: OrbOptions;
  scalpingOpts?: ScalpingOptions;
  swingOpts?: SwingOptions;
  portfolioOpts?: PortfolioOpts;
  signalEdgeOpts?: SignalEdgeOpts;
  /**
   * Per-fill commission charged on entry and exit, in basis points of notional
   * (1 bp = 0.01% = 0.0001). Defaults to 0 for backwards compat. Pass 40 for
   * Coinbase taker fees, ~5 bps for low-cost equity brokers, etc.
   */
  commissionBps?: number;
  /**
   * Per-fill slippage applied adversely to fill prices, in basis points. Buys
   * fill at `price * (1 + slip)`, sells at `price * (1 - slip)`. Defaults to 0.
   * Typical: 5 bps for liquid US equities, 10–20 bps for thinner names.
   */
  slippageBps?: number;
}

/**
 * Distribution snapshot from Monte Carlo bootstrap (TRA-172). Percentiles are
 * dollar-denominated final equity values across resampled trade-order draws.
 */
export interface ConfidenceBands {
  p5: number;
  p50: number;
  p95: number;
  /**
   * Worst observed peak-to-trough drawdown (as a fraction in [0,1]) across all
   * bootstrap iterations. Useful as a tail-risk sanity check.
   */
  worstDrawdown: number;
  iterations: number;
}

/**
 * Fill-independent signal-quality metric (TRA-172). Measures the share of
 * generated signals where price reached the entry +/- 1R level within the
 * lookahead window, regardless of whether the bracket order would have
 * triggered. Bypasses bracket-order / slippage assumptions to expose the raw
 * directional edge of the signal.
 */
export interface SignalEdge {
  reachedOneR: number;
  totalSignals: number;
  hitRatePct: number;
  /** Bars used for the lookahead test (echoed back for reporting). */
  lookaheadBars: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  /**
   * Closed trades. PnL is net of commissions and slippage. When the closing
   * candle range covered both stop-loss and take-profit, the recorded
   * `exitPrice`/`pnl` resolve the ambiguity optimistically (TP first); see
   * {@link ambiguousTrades} and {@link worstCaseTotalPnl} for the worst case.
   */
  trades: Position[];
  /** Sum of trade PnL net of commissions/slippage; optimistic on ambiguous candles. */
  totalPnl: number;
  winRate: number;
  avgRiskReward: number;
  maxDrawdown: number;
  sharpeRatio: number;
  totalTrades: number;
  winners: number;
  losers: number;
  profitFactor: number;
  /** Number of would-be entries skipped because they exceeded the portfolio cap. */
  skippedConcentration?: number;
  signalEdge?: SignalEdge;
  confidenceBands?: ConfidenceBands;
  /**
   * Trades whose closing candle range contained both stop-loss and take-profit
   * levels. With OHLC bars we can't tell which fired first; the headline
   * metrics resolve them optimistically (TP first) while {@link
   * worstCaseTotalPnl} reports the pessimistic resolution (SL first).
   */
  ambiguousTrades: number;
  /**
   * Sum of trade PnL when ambiguous candles are resolved pessimistically (SL
   * first instead of TP first). When zero ambiguous trades occurred this
   * equals {@link totalPnl}. Always net of commissions and slippage.
   */
  worstCaseTotalPnl: number;
}
