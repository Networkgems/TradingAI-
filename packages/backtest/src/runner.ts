import { Candle, Position, TradeSignal } from '@trading-app/shared';
import {
  OrbStrategy,
  ReversalStrategy,
  MacdTrendStrategy,
  BbFadeStrategy,
  MomentumStrategy,
  BreakoutVolStrategy,
  MeanReversionCryptoStrategy,
  IchimokuStrategy,
  ScalpingStrategy,
  SwingStrategy,
  RegimeDetector,
  RiskManager,
  PositionManager,
} from '@trading-app/engine';
import { BacktestConfig, BacktestResult, PortfolioOpts, SignalEdge } from './types.js';

const DEFAULT_MAX_OPEN = 3;
const DEFAULT_MAX_SECTOR = 3;
const DEFAULT_LOOKAHEAD_BARS = 24;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1_000;

/**
 * TRA-203: normalize the {@link BacktestConfig.feeBps} field into per-fill
 * maker/taker rates. Returns `null` when `feeBps` isn't set so the runner can
 * fall through to the legacy `commissionBps` path. A scalar applies to both
 * sides — `executionMode` is the only thing that splits maker vs. taker.
 */
function resolveFeeRates(
  config: BacktestConfig,
): { maker: number; taker: number } | null {
  if (config.feeBps === undefined) return null;
  if (typeof config.feeBps === 'number') {
    const r = config.feeBps / 10_000;
    return { maker: r, taker: r };
  }
  return {
    maker: config.feeBps.maker / 10_000,
    taker: config.feeBps.taker / 10_000,
  };
}

/**
 * TRA-203: estimate the candle bar interval (ms) by taking the modal gap
 * between consecutive timestamps. Modal — not mean — because daylight-saving
 * jumps and weekend halts in equity series would skew an average. Returns
 * `null` for fewer than two candles.
 */
function inferBarIntervalMs(candles: ReadonlyArray<Candle>): number | null {
  if (candles.length < 2) return null;
  const counts = new Map<number, number>();
  for (let i = 1; i < candles.length; i++) {
    const dt = candles[i].timestamp - candles[i - 1].timestamp;
    if (dt > 0) counts.set(dt, (counts.get(dt) ?? 0) + 1);
  }
  let bestDt = 0;
  let bestCount = 0;
  for (const [dt, c] of counts) {
    if (c > bestCount) { bestCount = c; bestDt = dt; }
  }
  return bestDt > 0 ? bestDt : null;
}

/**
 * TRA-203: per-trade R multiple, signed by side. R = 1 means the trade
 * collected one stop-distance of profit; R = -1 means it lost the stop.
 */
function tradeR(
  side: 'buy' | 'sell',
  entryPrice: number,
  exitPrice: number,
  stopLoss: number,
): number {
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance === 0) return 0;
  const dir = side === 'buy' ? 1 : -1;
  return ((exitPrice - entryPrice) * dir) / stopDistance;
}

/**
 * Default sector resolver — `*-USD` tickers fall into the `crypto` bucket so
 * five highly correlated coins can't all open simultaneously and call
 * themselves "diversified". Everything else is treated as `equity`.
 */
export function defaultSectorOf(symbol: string): string {
  return /-USD$/i.test(symbol) ? 'crypto' : 'equity';
}

/**
 * Runs the portfolio-cap admission check for a candidate signal.
 *
 * Returns the reason for rejection if the cap would be breached, or `null`
 * when the trade is allowed. Exposed for unit tests so the policy can be
 * validated independently of the rest of the backtest pipeline.
 */
export function admitsUnderPortfolioCap(
  candidate: TradeSignal,
  open: ReadonlyArray<{ symbol: string; signalType: string }>,
  opts: PortfolioOpts = {},
): null | { reason: 'max_open' | 'max_sector'; sector?: string } {
  const maxOpen = opts.maxOpenPositions ?? DEFAULT_MAX_OPEN;
  const maxSector = opts.maxSectorExposure ?? DEFAULT_MAX_SECTOR;
  const sectorOf = opts.sectorOf ?? defaultSectorOf;

  if (open.length >= maxOpen) return { reason: 'max_open' };

  const candidateSector = sectorOf(candidate.symbol);
  const sectorCount = open.filter(p => sectorOf(p.symbol) === candidateSector).length;
  if (sectorCount >= maxSector) return { reason: 'max_sector', sector: candidateSector };

  return null;
}

/**
 * Determines whether price reached the 1R target within the lookahead window.
 *
 * 1R is one risk-unit (= |entry − stop|). For longs we look for `high >= entry + R`;
 * for shorts, `low <= entry - R`. Used by the signal-edge metric to measure raw
 * signal quality independently of bracket-order plumbing.
 */
export function reachedOneR(
  signal: TradeSignal,
  futureCandles: ReadonlyArray<Candle>,
): boolean {
  const r = Math.abs(signal.entryPrice - signal.stopLoss);
  if (r === 0 || futureCandles.length === 0) return false;
  const target = signal.side === 'buy'
    ? signal.entryPrice + r
    : signal.entryPrice - r;
  for (const c of futureCandles) {
    if (signal.side === 'buy' ? c.high >= target : c.low <= target) return true;
  }
  return false;
}

export class BacktestRunner {
  async run(config: BacktestConfig, candles: Candle[]): Promise<BacktestResult> {
    const account = {
      totalEquity: config.initialEquity,
      availableCash: config.initialEquity,
      openPositions: [],
      dailyPnl: 0,
    };

    // TRA-186: crypto symbols default to fractional-quantity sizing — without
    // it BTC trades silently never size at typical 1% risk budgets because
    // sizeFromStop floors a 0.31-BTC budget to 0.
    const fractionalQuantity = config.fractionalQuantity
      ?? (defaultSectorOf(config.symbol) === 'crypto');
    const risk = new RiskManager(account, { fractionalQuantity });
    const positions = new PositionManager();
    const orb = new OrbStrategy(config.orbOpts);
    const reversal = new ReversalStrategy(config.reversalOpts);
    // TRA-170 refactored MACD-Bollinger into a trend half + a mean-reversion
    // half. The legacy `'macd' | 'macd_bollinger'` strategyType triggers both
    // so callers upgrading from the old single class get equivalent coverage.
    const macdTrend = new MacdTrendStrategy(config.macdBollingerOpts);
    const bbFade = new BbFadeStrategy({
      bbPeriod: config.macdBollingerOpts?.bbPeriod,
      bbMultiplier: config.macdBollingerOpts?.bbMultiplier,
      enforceTimeFilter: config.macdBollingerOpts?.enforceTimeFilter,
      volatilityFloorPct: config.macdBollingerOpts?.volatilityFloorPct,
    });
    const ichimoku = new IchimokuStrategy(config.ichimokuOpts);
    const scalping = new ScalpingStrategy(config.scalpingOpts);
    const swing = new SwingStrategy(config.swingOpts);
    // TRA-205: momentum is regime-gated; the detector is owned by the runner
    // and re-fed each bar so its hysteresis state matches what the strategy
    // sees during live trading.
    const regimeDetector = new RegimeDetector(config.regimeOpts);
    const momentum = new MomentumStrategy(regimeDetector, config.momentumOpts);
    // TRA-207: breakout strategy classifies its own regime when called without
    // a label. The runner could share `regimeDetector` here but that would
    // double-tick the hysteresis state per bar; passing `regimeOpts` through
    // the strategy's `regimeOptions` keeps both classifications using the
    // same configuration without coupling state.
    const breakoutVol = new BreakoutVolStrategy({
      ...config.breakoutVolOpts,
      regimeOptions: config.breakoutVolOpts?.regimeOptions ?? config.regimeOpts,
    });
    // TRA-206: mean-reversion is regime-gated to `range` only. Same wiring
    // shape as breakoutVol — pass `regimeOpts` through so the strategy's
    // self-classification uses the same hysteresis/threshold config as the
    // rest of the runner. The router (TRA-208) will eventually drive a shared
    // detector; until then this keeps configuration consistent.
    const meanReversion = new MeanReversionCryptoStrategy({
      ...config.meanReversionOpts,
      regimeOptions: config.meanReversionOpts?.regimeOptions ?? config.regimeOpts,
    });

    // TRA-169 / TRA-185 / TRA-203: per-fill cost model. Commission charged on
    // entry+exit notional, slippage applied adversely to fill prices. The
    // resolution order is `costModel` > `feeBps` (with maker/taker split if
    // executionMode = 'limit') > legacy flat `commissionBps`. Each
    // `BacktestConfig` runs against a single symbol so we resolve once.
    const executionMode = config.executionMode ?? 'market';
    const feeRates = resolveFeeRates(config);
    const fill = config.costModel
      ? config.costModel.resolve(config.symbol)
      : {
          // Per-side commission falls back to legacy flat `commissionBps` when
          // `feeBps` isn't set, otherwise leaves it 0 here and lets
          // `commissionRateFor` pick maker/taker per fill.
          commissionBps: feeRates ? 0 : (config.commissionBps ?? 0),
          slippageBps: config.slippageBps ?? 0,
        };
    const slipRate = fill.slippageBps / 10_000;
    const fallbackCommissionRate = fill.commissionBps / 10_000;
    /**
     * Per-fill commission rate. With `feeBps`, entries are maker-priced when
     * `executionMode = 'limit'` and taker-priced otherwise; exits are always
     * taker-priced because stop-loss / take-profit fire as market hits.
     */
    const commissionRateFor = (leg: 'entry' | 'exit'): number => {
      if (!feeRates) return fallbackCommissionRate;
      if (leg === 'exit') return feeRates.taker;
      return executionMode === 'limit' ? feeRates.maker : feeRates.taker;
    };
    const applyEntrySlippage = (signal: TradeSignal): number =>
      signal.side === 'buy'
        ? signal.entryPrice * (1 + slipRate)
        : signal.entryPrice * (1 - slipRate);
    const applyExitSlippage = (side: 'buy' | 'sell', rawExit: number): number =>
      side === 'buy' ? rawExit * (1 - slipRate) : rawExit * (1 + slipRate);
    const computePnl = (
      side: 'buy' | 'sell',
      entryFill: number,
      exitFill: number,
      qty: number,
    ): number => {
      const dir = side === 'buy' ? 1 : -1;
      const gross = (exitFill - entryFill) * qty * dir;
      const commission =
        entryFill * qty * commissionRateFor('entry') +
        exitFill * qty * commissionRateFor('exit');
      return gross - commission;
    };

    const filtered = candles.filter(
      c => c.timestamp >= config.startDate && c.timestamp <= config.endDate,
    );

    const closedTrades: Position[] = [];
    const tradeRs: number[] = [];
    let ambiguousTrades = 0;
    let worstCaseTotalPnl = 0;
    /** Slippage-adjusted entry fill price keyed by position id. */
    const entryFills = new Map<string, number>();

    let peakEquity = config.initialEquity;
    let runningEquity = config.initialEquity;
    let maxDrawdown = 0;
    // TRA-203: per-bar mark-to-market equity series. Drives the annualized
    // Sharpe (per-bar returns are more stable than per-trade returns when the
    // sample is small) and lets `maxDrawdown` capture intra-trade drawdowns
    // — the realized-only series would miss a 30% paper loss that recovered
    // before the position closed.
    const barReturns: number[] = [];
    let prevMtmEquity = config.initialEquity;

    let skippedConcentration = 0;
    const lookahead = config.signalEdgeOpts?.lookaheadBars ?? DEFAULT_LOOKAHEAD_BARS;
    const signalLog: Array<{ signal: TradeSignal; barIndex: number }> = [];
    const seenSignalIds = new Set<string>();

    for (let i = 1; i <= filtered.length; i++) {
      const window = filtered.slice(0, i);
      const signals = [];

      if (config.strategyType === 'orb' || config.strategyType === 'combined') {
        const s = orb.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'reversal' || config.strategyType === 'combined') {
        const s = reversal.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'macd' || config.strategyType === 'macd_trend' || config.strategyType === 'macd_bollinger' || config.strategyType === 'combined') {
        const t = macdTrend.evaluate(config.symbol, window);
        if (t) signals.push(t);
      }
      if (config.strategyType === 'bb_fade' || config.strategyType === 'macd_bollinger' || config.strategyType === 'combined') {
        const f = bbFade.evaluate(config.symbol, window);
        if (f) signals.push(f);
      }
      if (config.strategyType === 'momentum' || config.strategyType === 'combined') {
        const m = momentum.evaluate(config.symbol, window);
        if (m) signals.push(m);
      }
      if (config.strategyType === 'breakout_vol' || config.strategyType === 'combined') {
        const b = breakoutVol.evaluate(config.symbol, window);
        if (b) signals.push(b);
      }
      if (config.strategyType === 'mean_reversion' || config.strategyType === 'combined') {
        const m = meanReversion.evaluate(config.symbol, window);
        if (m) signals.push(m);
      }
      if (config.strategyType === 'ichimoku' || config.strategyType === 'combined') {
        const s = ichimoku.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'scalping' || config.strategyType === 'combined') {
        const s = scalping.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'swing' || config.strategyType === 'combined') {
        const s = swing.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }

      for (const signal of signals) {
        // Track every distinct signal exactly once for the signal-edge metric,
        // independent of whether the trade is taken (some get blocked by
        // already-open / portfolio-cap filters below).
        if (!seenSignalIds.has(signal.id)) {
          seenSignalIds.add(signal.id);
          signalLog.push({ signal, barIndex: i - 1 });
        }

        const alreadyOpen = positions.getOpen().some(p => p.signalType === signal.type);
        if (alreadyOpen) continue;

        const admit = admitsUnderPortfolioCap(
          signal,
          positions.getOpen().map(p => ({ symbol: p.symbol, signalType: p.signalType })),
          config.portfolioOpts,
        );
        if (admit) {
          skippedConcentration += 1;
          continue;
        }

        const qty = risk.sizeFromStop(signal.entryPrice, signal.stopLoss);
        if (qty > 0) {
          const opened = positions.open(signal, qty);
          entryFills.set(opened.id, applyEntrySlippage(signal));
        }
      }

      for (const pos of positions.getOpen()) {
        const latest = filtered[i - 1];
        const hitsStop = pos.side === 'buy'
          ? latest.low <= pos.stopLoss
          : latest.high >= pos.stopLoss;
        const hitsTarget = pos.side === 'buy'
          ? latest.high >= pos.takeProfit
          : latest.low <= pos.takeProfit;
        if (!hitsStop && !hitsTarget) continue;

        // OHLC bars don't say which level fired first when the candle range
        // covers both. Resolve optimistically (TP) for the headline metrics
        // and record the pessimistic (SL) PnL alongside via worstCaseTotalPnl.
        const ambiguous = hitsStop && hitsTarget;
        const optimisticExitRaw = hitsTarget ? pos.takeProfit : pos.stopLoss;
        const pessimisticExitRaw = hitsStop ? pos.stopLoss : pos.takeProfit;
        const entryFill = entryFills.get(pos.id) ?? pos.entryPrice;
        const optimisticFill = applyExitSlippage(pos.side, optimisticExitRaw);
        const optimisticPnl = computePnl(pos.side, entryFill, optimisticFill, pos.quantity);

        const closed = positions.close(pos.id, optimisticExitRaw);
        // Overwrite the manager's naive PnL with the cost-adjusted version and
        // persist the slippage-adjusted entry/exit so downstream consumers see
        // realistic fill economics on every trade.
        closed.entryPrice = entryFill;
        closed.exitPrice = optimisticFill;
        closed.pnl = optimisticPnl;
        entryFills.delete(pos.id);
        closedTrades.push(closed);
        tradeRs.push(tradeR(pos.side, entryFill, optimisticFill, pos.stopLoss));

        if (ambiguous) {
          ambiguousTrades += 1;
          const pessimisticFill = applyExitSlippage(pos.side, pessimisticExitRaw);
          worstCaseTotalPnl += computePnl(pos.side, entryFill, pessimisticFill, pos.quantity);
        } else {
          worstCaseTotalPnl += optimisticPnl;
        }

        runningEquity += optimisticPnl;
      }

      // TRA-203: bar-level mark-to-market. After processing entries and
      // exits, value remaining open positions at this bar's close so peak
      // equity / drawdown / per-bar returns capture unrealized PnL too.
      const closePx = filtered[i - 1].close;
      let unrealized = 0;
      for (const pos of positions.getOpen()) {
        const entryFill = entryFills.get(pos.id) ?? pos.entryPrice;
        const dir = pos.side === 'buy' ? 1 : -1;
        unrealized += (closePx - entryFill) * pos.quantity * dir;
      }
      const mtmEquity = runningEquity + unrealized;
      peakEquity = Math.max(peakEquity, mtmEquity);
      if (peakEquity > 0) {
        const drawdown = (peakEquity - mtmEquity) / peakEquity;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      }
      if (prevMtmEquity > 0) {
        barReturns.push((mtmEquity - prevMtmEquity) / prevMtmEquity);
      } else {
        barReturns.push(0);
      }
      prevMtmEquity = mtmEquity;
    }

    const winners = closedTrades.filter(t => (t.pnl ?? 0) > 0);
    const losers = closedTrades.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate = closedTrades.length > 0 ? winners.length / closedTrades.length : 0;

    const grossProfit = winners.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // TRA-203: annualized Sharpe from per-bar mark-to-market returns. Falls
    // back to per-trade R returns when the bar series is too short (e.g.
    // pure trade-list replay without candles) — both are zero-rf-rate Sharpes
    // for cleanliness; subtract a risk-free term here if/when one matters.
    const barIntervalMs = inferBarIntervalMs(filtered);
    const barsPerYear = barIntervalMs ? MS_PER_YEAR / barIntervalMs : 252;
    let sharpeRatio = 0;
    if (barReturns.length > 1) {
      const meanRet = barReturns.reduce((s, r) => s + r, 0) / barReturns.length;
      const variance = barReturns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (barReturns.length - 1);
      const stdRet = Math.sqrt(variance);
      sharpeRatio = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(barsPerYear) : 0;
    } else if (tradeRs.length > 1) {
      const meanR = tradeRs.reduce((s, r) => s + r, 0) / tradeRs.length;
      const varR = tradeRs.reduce((s, r) => s + (r - meanR) ** 2, 0) / (tradeRs.length - 1);
      const stdR = Math.sqrt(varR);
      sharpeRatio = stdR > 0 ? meanR / stdR : 0;
    }

    // TRA-203: expectancy = average R per trade. Industry rule of thumb is
    // > 0.2R per trade after costs is the floor for a deployable system.
    const expectancy = tradeRs.length > 0
      ? tradeRs.reduce((s, r) => s + r, 0) / tradeRs.length
      : 0;

    const avgRiskReward = closedTrades.length > 0
      ? closedTrades.reduce((s, t) => {
          const risk = Math.abs(t.entryPrice - t.stopLoss) * t.quantity;
          return s + (risk > 0 ? (t.pnl ?? 0) / risk : 0);
        }, 0) / closedTrades.length
      : 0;

    let reachedCount = 0;
    for (const { signal, barIndex } of signalLog) {
      const future = filtered.slice(barIndex + 1, barIndex + 1 + lookahead);
      if (reachedOneR(signal, future)) reachedCount += 1;
    }
    const signalEdge: SignalEdge = {
      reachedOneR: reachedCount,
      totalSignals: signalLog.length,
      hitRatePct: signalLog.length > 0 ? (reachedCount / signalLog.length) * 100 : 0,
      lookaheadBars: lookahead,
    };

    return {
      config,
      trades: closedTrades,
      totalPnl,
      winRate,
      avgRiskReward,
      maxDrawdown,
      sharpeRatio,
      totalTrades: closedTrades.length,
      winners: winners.length,
      losers: losers.length,
      profitFactor,
      skippedConcentration,
      signalEdge,
      ambiguousTrades,
      worstCaseTotalPnl,
      tradeRs,
      expectancy,
      barIntervalMs,
    };
  }
}
