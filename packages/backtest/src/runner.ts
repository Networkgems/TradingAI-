import { Candle, Position, TradeSignal } from '@trading-app/shared';
import {
  OrbStrategy,
  ReversalStrategy,
  MacdTrendStrategy,
  BbFadeStrategy,
  IchimokuStrategy,
  ScalpingStrategy,
  SwingStrategy,
  RiskManager,
  PositionManager,
} from '@trading-app/engine';
import { BacktestConfig, BacktestResult, PortfolioOpts, SignalEdge } from './types.js';

const DEFAULT_MAX_OPEN = 3;
const DEFAULT_MAX_SECTOR = 3;
const DEFAULT_LOOKAHEAD_BARS = 24;

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

    const risk = new RiskManager(account);
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
    const ichimoku = new IchimokuStrategy();
    const scalping = new ScalpingStrategy(config.scalpingOpts);
    const swing = new SwingStrategy(config.swingOpts);

    // TRA-169: per-fill cost model. Commission charged on entry+exit notional,
    // slippage applied adversely to fill prices. Bps are converted once up
    // front so the per-fill hot path is just a multiply.
    const commissionRate = (config.commissionBps ?? 0) / 10_000;
    const slipRate = (config.slippageBps ?? 0) / 10_000;
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
      const commission = (entryFill + exitFill) * qty * commissionRate;
      return gross - commission;
    };

    const filtered = candles.filter(
      c => c.timestamp >= config.startDate && c.timestamp <= config.endDate,
    );

    const closedTrades: Position[] = [];
    let ambiguousTrades = 0;
    let worstCaseTotalPnl = 0;
    /** Slippage-adjusted entry fill price keyed by position id. */
    const entryFills = new Map<string, number>();

    let peakEquity = config.initialEquity;
    let runningEquity = config.initialEquity;
    let maxDrawdown = 0;

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

        if (ambiguous) {
          ambiguousTrades += 1;
          const pessimisticFill = applyExitSlippage(pos.side, pessimisticExitRaw);
          worstCaseTotalPnl += computePnl(pos.side, entryFill, pessimisticFill, pos.quantity);
        } else {
          worstCaseTotalPnl += optimisticPnl;
        }

        runningEquity += optimisticPnl;
        peakEquity = Math.max(peakEquity, runningEquity);
        const drawdown = (peakEquity - runningEquity) / peakEquity;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
      }
    }

    const winners = closedTrades.filter(t => (t.pnl ?? 0) > 0);
    const losers = closedTrades.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate = closedTrades.length > 0 ? winners.length / closedTrades.length : 0;

    const grossProfit = winners.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const pnls = closedTrades.map(t => t.pnl ?? 0);
    const meanPnl = pnls.length > 0 ? totalPnl / pnls.length : 0;
    const variance = pnls.length > 1
      ? pnls.reduce((s, p) => s + (p - meanPnl) ** 2, 0) / (pnls.length - 1)
      : 0;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? meanPnl / stdDev : 0;

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
    };
  }
}
