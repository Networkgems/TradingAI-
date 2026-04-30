import { Position } from '@trading-app/shared';
import type { BreakoutVolOptions, CostModel, IchimokuOptions, MeanReversionCryptoOptions, MomentumOptions, OrbOptions, RegimeDetectorOptions, ScalpingOptions, SwingOptions } from '@trading-app/engine';

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
  /** TRA-177: volume-climax multiplier vs. lookback average (default 1.3). */
  volumeMultiplier?: number;
  /** TRA-179: arm a pending retest on the first match instead of firing immediately. */
  retestEntry?: boolean;
  /** TRA-179: bars to wait for a retest before discarding the pending. */
  retestExpiryBars?: number;
  /** TRA-179: take-profit multiple applied to the retest stop distance. */
  retestRewardMultiple?: number;
  /** TRA-181: tolerance band around the midpoint, as a fraction of |entry-stop|. 0 = strict. */
  retestTolerancePct?: number;
  /** TRA-181: structural-stop buffer fraction applied to the retest bar's low/high. Default 0.25. */
  retestStopBufferFrac?: number;
  /** TRA-181: when true, the retest bar must clear the signal-bar volume to fire. */
  retestRequireVolumeIncrease?: boolean;
}

/**
 * Pass-through to `IchimokuStrategy`. Aliased directly to the engine type so
 * new knobs (e.g. TRA-183 retest-entry options) flow through automatically
 * without a duplicate definition that drifts.
 */
export type BacktestIchimokuOpts = IchimokuOptions;

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
    | 'momentum'
    | 'ichimoku'
    | 'combined'
    | 'macd_bollinger'
    | 'scalping'
    | 'swing'
    | 'breakout_vol'
    | 'mean_reversion';
  reversalOpts?: BacktestReversalOpts;
  macdBollingerOpts?: BacktestMacdBollingerOpts;
  ichimokuOpts?: BacktestIchimokuOpts;
  /** TRA-205: pass-through to MomentumStrategy. */
  momentumOpts?: MomentumOptions;
  /** TRA-207: pass-through to BreakoutVolStrategy. */
  breakoutVolOpts?: BreakoutVolOptions;
  /** TRA-206: pass-through to MeanReversionCryptoStrategy. */
  meanReversionOpts?: MeanReversionCryptoOptions;
  /**
   * TRA-205: regime-detector knobs forwarded to the detector that gates
   * momentum (and any future regime-aware strategy). Omit to use defaults.
   */
  regimeOpts?: RegimeDetectorOptions;
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
   * Coinbase taker fees, ~5 bps for low-cost equity brokers, etc. Ignored
   * when {@link costModel} is also provided.
   */
  commissionBps?: number;
  /**
   * Per-fill slippage applied adversely to fill prices, in basis points. Buys
   * fill at `price * (1 + slip)`, sells at `price * (1 - slip)`. Defaults to 0.
   * Typical: 5 bps for liquid US equities, 10–20 bps for thinner names.
   * Ignored when {@link costModel} is also provided.
   */
  slippageBps?: number;
  /**
   * TRA-185: spread-aware cost model. When set, overrides
   * {@link commissionBps}/{@link slippageBps} — the runner resolves
   * `costModel.resolve(symbol)` once per backtest and uses the per-fill cost
   * it returns for every fill. Use `cryptoTieredCostModel()` from
   * `@trading-app/engine` for the default crypto tier table. Existing flat-cost
   * callers can leave this unset and behavior is unchanged.
   */
  costModel?: CostModel;
  /**
   * TRA-186: opt into fractional-quantity sizing. Defaults to true for `*-USD`
   * symbols (crypto) and false otherwise — without it, RiskManager.sizeFromStop
   * floors to whole units, which silently zeros out high-priced fractional
   * assets like BTC: at $80k spot with a 2% stop on a $100k account, the risk
   * budget sizes to 0.31 BTC and the integer floor reports 0. Set explicitly
   * to override the heuristic.
   */
  fractionalQuantity?: boolean;
  /**
   * TRA-203: per-fill maker/taker fees, in basis points of notional. When set,
   * the runner picks `maker` for resting entries (`executionMode: 'limit'`)
   * and `taker` for market hits — exits always pay `taker` since stop-loss /
   * take-profit fire as market orders. Pass a number to charge it on every
   * fill regardless of side. Ignored when {@link costModel} is also provided;
   * `commissionBps` remains the legacy back-compat path.
   */
  feeBps?: number | { maker: number; taker: number };
  /**
   * TRA-203: order type for entries. `'market'` pays the taker fee on entry;
   * `'limit'` posts the entry as a resting maker order. Exits (stop / target)
   * always count as taker fills. Defaults to `'market'` so flat-cost callers
   * see no behavior change. Only consulted when {@link feeBps} is supplied.
   */
  executionMode?: 'market' | 'limit';
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
  /**
   * TRA-203: per-trade R multiples — `(exitPrice - entryPrice) / stopDistance`
   * signed by side. Drives {@link expectancy} and feeds the annualized
   * {@link sharpeRatio} when bar-frequency inference fails.
   */
  tradeRs: number[];
  /**
   * TRA-203: average R per trade. Negative on losing systems, > 0.2R is
   * usually the floor for a system worth deploying.
   */
  expectancy: number;
  /**
   * TRA-203: bar interval in milliseconds inferred from candle timestamps,
   * used to annualize Sharpe. `null` when fewer than 2 candles were supplied
   * (Sharpe falls back to per-trade-return annualization).
   */
  barIntervalMs: number | null;
}
