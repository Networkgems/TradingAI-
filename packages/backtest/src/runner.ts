import { Candle } from '@trading-app/shared';
import { OrbStrategy, ReversalStrategy, MacdBollingerStrategy, IchimokuStrategy, RiskManager, PositionManager } from '@trading-app/engine';
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
    const reversal = new ReversalStrategy(config.reversalOpts);
    const macdBollinger = new MacdBollingerStrategy(config.macdBollingerOpts);
    const ichimoku = new IchimokuStrategy();

    const filtered = candles.filter(
      c => c.timestamp >= config.startDate && c.timestamp <= config.endDate
    );

    const closed: ReturnType<PositionManager['close']>[] = [];
    const maxWindow = config.maxWindowSize ?? 150;

    for (let i = 1; i <= filtered.length; i++) {
      const windowStart = Math.max(0, i - maxWindow);
      const window = filtered.slice(windowStart, i);
      const signals = [];

      if (config.strategyType === 'orb' || config.strategyType === 'combined' || config.strategyType === 'all') {
        const s = orb.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'reversal' || config.strategyType === 'combined' || config.strategyType === 'all') {
        const s = reversal.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'macd_bollinger' || config.strategyType === 'all') {
        const s = macdBollinger.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'ichimoku' || config.strategyType === 'all') {
        const s = ichimoku.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }

      for (const signal of signals) {
        const qty = risk.sizeFromStop(signal.entryPrice, signal.stopLoss);
        if (qty > 0) positions.open(signal, qty);
      }

      for (const pos of positions.getOpen()) {
        const latest = filtered[i - 1];
        if (pos.side === 'buy' && latest.low <= pos.stopLoss) {
          closed.push(positions.close(pos.id, pos.stopLoss));
        } else if (pos.side === 'buy' && latest.high >= pos.takeProfit) {
          closed.push(positions.close(pos.id, pos.takeProfit));
        } else if (pos.side === 'sell' && latest.high >= pos.stopLoss) {
          closed.push(positions.close(pos.id, pos.stopLoss));
        } else if (pos.side === 'sell' && latest.low <= pos.takeProfit) {
          closed.push(positions.close(pos.id, pos.takeProfit));
        }
      }
    }

    const totalPnl = closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const winners = closed.filter(t => (t.pnl ?? 0) > 0);
    const winRate = closed.length > 0 ? winners.length / closed.length : 0;
    const avgRR = closed.length > 0
      ? closed.reduce((s, t) => {
          const entry = t.entryPrice;
          const stop = t.stopLoss;
          const tp = t.takeProfit;
          const stopDist = Math.abs(entry - stop);
          const tpDist = Math.abs(tp - entry);
          return s + (stopDist > 0 ? tpDist / stopDist : 0);
        }, 0) / closed.length
      : 0;

    return {
      config,
      trades: closed,
      totalPnl,
      winRate,
      avgRiskReward: avgRR,
      maxDrawdown: 0,
      sharpeRatio: 0,
    };
  }
}
