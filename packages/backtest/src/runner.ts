import { Candle } from '@trading-app/shared';
import {
  OrbStrategy,
  ReversalStrategy,
  MacdBollingerStrategy,
  IchimokuStrategy,
  RiskManager,
  PositionManager,
} from '@trading-app/engine';
import { BacktestConfig, BacktestResult } from './types.js';

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
    const orb = new OrbStrategy();
    const reversal = new ReversalStrategy();
    const macd = new MacdBollingerStrategy();
    const ichimoku = new IchimokuStrategy();

    const filtered = candles.filter(
      c => c.timestamp >= config.startDate && c.timestamp <= config.endDate,
    );

    const closedTrades: ReturnType<PositionManager['close']>[] = [];

    // Track equity curve for drawdown calculation
    let peakEquity = config.initialEquity;
    let runningEquity = config.initialEquity;
    let maxDrawdown = 0;

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
      if (config.strategyType === 'macd' || config.strategyType === 'combined') {
        const s = macd.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'ichimoku' || config.strategyType === 'combined') {
        const s = ichimoku.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }

      // Skip duplicate signals (same symbol + type already open)
      for (const signal of signals) {
        const alreadyOpen = positions.getOpen().some(p => p.signalType === signal.type);
        if (alreadyOpen) continue;
        const qty = risk.sizeFromStop(signal.entryPrice, signal.stopLoss);
        if (qty > 0) positions.open(signal, qty);
      }

      for (const pos of positions.getOpen()) {
        const latest = filtered[i - 1];
        let exitPrice: number | null = null;

        if (pos.side === 'buy') {
          if (latest.low <= pos.stopLoss) exitPrice = pos.stopLoss;
          else if (latest.high >= pos.takeProfit) exitPrice = pos.takeProfit;
        } else {
          if (latest.high >= pos.stopLoss) exitPrice = pos.stopLoss;
          else if (latest.low <= pos.takeProfit) exitPrice = pos.takeProfit;
        }

        if (exitPrice !== null) {
          const closed = positions.close(pos.id, exitPrice);
          closedTrades.push(closed);
          runningEquity += closed.pnl ?? 0;
          peakEquity = Math.max(peakEquity, runningEquity);
          const drawdown = (peakEquity - runningEquity) / peakEquity;
          maxDrawdown = Math.max(maxDrawdown, drawdown);
        }
      }
    }

    const winners = closedTrades.filter(t => (t.pnl ?? 0) > 0);
    const losers = closedTrades.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate = closedTrades.length > 0 ? winners.length / closedTrades.length : 0;

    const grossProfit = winners.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Simplified Sharpe: mean trade PnL / stddev of PnL (not annualized)
    const pnls = closedTrades.map(t => t.pnl ?? 0);
    const meanPnl = pnls.length > 0 ? totalPnl / pnls.length : 0;
    const variance = pnls.length > 1
      ? pnls.reduce((s, p) => s + (p - meanPnl) ** 2, 0) / (pnls.length - 1)
      : 0;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? meanPnl / stdDev : 0;

    // Average achieved R:R
    const avgRiskReward = closedTrades.length > 0
      ? closedTrades.reduce((s, t) => {
          const risk = Math.abs(t.entryPrice - t.stopLoss) * t.quantity;
          return s + (risk > 0 ? (t.pnl ?? 0) / risk : 0);
        }, 0) / closedTrades.length
      : 0;

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
    };
  }
}
