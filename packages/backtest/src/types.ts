import { Candle, Position } from '@trading-app/shared';
import type { BreakoutVolOptions, CellExpectancy, CorrelationCapConfig, CostModel, IchimokuOptions, MeanReversionCryptoOptions, MomentumOptions, OrbOptions, RegimeDetectorOptions, ScalpingOptions, SwingOptions, VolKellySizerConfig } from '@trading-app/engine';

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

/**
 * TRA-423 — portfolio correlation / concentration cap (TRA-411 spec).
 *
 * When `enabled`, the runner enforces the §6 admission rule on every entry:
 * the position-count cap is a hard reject, the cluster/portfolio risk and
 * cluster-notional caps scale the candidate down to exact headroom (rejecting
 * below `minTradeRiskPct`). It is an *additional* gate on top of
 * {@link PortfolioOpts} — `maxOpen` / `maxSector` still apply.
 *
 * `config` overrides any of the five spec §5 keys; omitted keys take the
 * recommended defaults so the cap is tunable without a code change.
 *
 * `dailyCandlesBySymbol` supplies the real Coinbase daily history used to
 * estimate correlations. When omitted, the insufficient-history fallback
 * applies — which, for a single-symbol backtest, correctly collapses every
 * open position into one cluster (a symbol is ρ=1.0 with itself).
 */
export interface CorrelationCapOpts {
  enabled?: boolean;
  config?: Partial<CorrelationCapConfig>;
  dailyCandlesBySymbol?: Record<string, Candle[]>;
}

/**
 * TRA-430 — volatility-/Kelly-scaled per-trade risk sizing (TRA-428 spec).
 *
 * When `enabled`, the runner computes an effective per-trade risk fraction
 * (vol-targeted off trailing realised vol, bounded by a fractional-Kelly cap)
 * and feeds it to `RiskManager` as a per-call `riskPct` override — *ahead* of
 * the TRA-423 cluster cap, which still runs last. Omit (or `enabled: false`)
 * to leave behaviour unchanged: the sizer ships dark.
 *
 * `config` overrides any of the §7 spec keys; omitted keys take the
 * recommended defaults.
 *
 * `expectancyByCell` supplies the §3.4 static per-cell expectancy table for
 * the backtest Kelly cap. Keys are matched as `${signalType}|${symbol}` first,
 * then a bare `${symbol}` fallback. Omit the table for the §6 "vol-only" arm —
 * the Kelly cap is then inactive and vol-targeting alone governs.
 */
export interface VolKellySizerOpts {
  enabled?: boolean;
  config?: Partial<VolKellySizerConfig>;
  expectancyByCell?: Record<string, CellExpectancy>;
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
  /**
   * TRA-420 §3: optional warmup-history boundary. When set earlier than
   * {@link startDate}, the runner feeds candles in `[warmupStartDate,
   * startDate)` to the strategies (and the stateful regime detector) to warm
   * indicators — a 200-bar EMA or 90-bar ATR-median window cannot be filled
   * by a short test slice on its own — but opens no positions and records no
   * metrics for those bars. Trades and headline metrics still cover only
   * `[startDate, endDate]`. Omit (or set ≥ startDate) for a cold start.
   */
  warmupStartDate?: number;
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
   * TRA-211: per-strategy risk-budget override for mean-reversion entries —
   * spec §3 sizes mean reversion at 0.75% of equity (vs. the 1% default that
   * momentum/breakout share). Defaults to 0.0075 when omitted; set explicitly
   * to override (e.g. 0.01 to flatten back to the global default).
   */
  meanReversionRiskPct?: number;
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
  /**
   * TRA-423 — portfolio correlation / concentration cap. Omit (or set
   * `enabled: false`) to leave behaviour unchanged; set `enabled: true` to
   * have the runner enforce the TRA-411 §6 admission rule. QuantTrader drives
   * the spec §8 validation by toggling this on the {BTC-USD, SOL-USD}
   * `macd_bollinger` book.
   */
  correlationCapOpts?: CorrelationCapOpts;
  /**
   * TRA-430 — volatility-/Kelly-scaled per-trade risk sizing (TRA-428 spec).
   * Omit (or `enabled: false`) to leave sizing unchanged. The §6 three-arm
   * validation toggles this on the {BTC-USD, SOL-USD} `macd_bollinger` book.
   */
  volKellySizerOpts?: VolKellySizerOpts;
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
  /**
   * TRA-423 — portfolio correlation / concentration cap activity. Present only
   * when {@link BacktestConfig.correlationCapOpts} enabled the cap. `rejected`
   * counts hard-rejected entries (full-cluster or below the scale-down floor);
   * `scaledDown` counts entries admitted at a reduced size. The §8 validation
   * checks `rejected + scaledDown > 0` to prove the cap actually binds.
   */
  correlationCap?: {
    enabled: boolean;
    rejected: number;
    scaledDown: number;
  };
  /**
   * TRA-430 — vol-/Kelly-sizer activity. Present only when
   * {@link BacktestConfig.volKellySizerOpts} enabled the sizer. `applied`
   * counts entries whose risk fraction the sizer set; `zeroEdgeSkipped` counts
   * entries dropped because the Kelly cap forced `effRiskPct = 0` (non-positive
   * edge); `avgEffRiskPct` is the mean effective risk fraction over applied
   * entries (the §6 arms compare this against the flat 1% baseline).
   */
  volKellySizer?: {
    enabled: boolean;
    applied: number;
    zeroEdgeSkipped: number;
    avgEffRiskPct: number;
  };
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
   * TRA-818 (fix for TRA-815): per-trade R multiples **net of commission +
   * slippage**, computed as `optimisticPnl / (stopDistance * quantity)`. Runs
   * in parallel to the fee-blind gross {@link tradeRs}; with `feeBps: 0` the two
   * series are identical. Unlike {@link tradeRs}, this is NOT consumed by live
   * vol/Kelly sizing — it exists so cost-sensitivity analysis (TRA-523) can pool
   * a fee-aware expectancy that actually differs across cost arms.
   */
  tradeRsNet: number[];
  /**
   * TRA-818 (fix for TRA-815): average net-of-cost R per trade — mean of
   * {@link tradeRsNet}. Strictly `<=` gross {@link expectancy} and monotonically
   * worse as fees rise; equal to it at zero fees.
   */
  expectancyNet: number;
  /**
   * TRA-203: bar interval in milliseconds inferred from candle timestamps,
   * used to annualize Sharpe. `null` when fewer than 2 candles were supplied
   * (Sharpe falls back to per-trade-return annualization).
   */
  barIntervalMs: number | null;
}
