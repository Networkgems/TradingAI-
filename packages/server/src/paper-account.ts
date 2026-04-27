import type { AccountState, Position, TradeSignal, SignalType } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import { randomUUID } from 'crypto';

interface PaperAccountConfig {
  initialEquity?: number;
  managedAccountRatio?: number;
  riskPerTrade?: number;
}

export class PaperAccount {
  private initialEquity: number;
  private managedAccountRatio: number;
  private riskPerTrade: number;
  private equity: number;
  private cash: number;
  private positions: Map<string, Position> = new Map();
  private dailyPnl = 0;

  constructor(config: PaperAccountConfig = {}) {
    this.initialEquity = config.initialEquity ?? DEFAULT_ACCOUNT_SETTINGS.demoEquity;
    this.managedAccountRatio = config.managedAccountRatio ?? DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
    this.riskPerTrade = config.riskPerTrade ?? DEFAULT_ACCOUNT_SETTINGS.riskPerTrade;
    this.equity = this.initialEquity;
    this.cash = this.initialEquity;
  }

  reset(config: PaperAccountConfig = {}): void {
    if (config.initialEquity !== undefined) this.initialEquity = config.initialEquity;
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.riskPerTrade !== undefined) this.riskPerTrade = config.riskPerTrade;
    this.equity = this.initialEquity;
    this.cash = this.initialEquity;
    this.positions.clear();
    this.dailyPnl = 0;
  }

  updateConfig(config: PaperAccountConfig): void {
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.riskPerTrade !== undefined) this.riskPerTrade = config.riskPerTrade;
  }

  getState(): AccountState {
    return {
      totalEquity: this.equity,
      availableCash: this.cash,
      openPositions: Array.from(this.positions.values()),
      dailyPnl: this.dailyPnl,
    };
  }

  managedEquity(): number {
    return this.equity * this.managedAccountRatio;
  }

  maxRiskPerTrade(): number {
    return this.managedEquity() * this.riskPerTrade;
  }

  sizeFromStop(entryPrice: number, stopPrice: number): number {
    const dist = Math.abs(entryPrice - stopPrice);
    if (dist === 0) return 0;
    return Math.floor(this.maxRiskPerTrade() / dist);
  }

  openPosition(signal: TradeSignal, currentPrice: number): Position | null {
    let qty = this.sizeFromStop(signal.entryPrice, signal.stopLoss);
    if (qty <= 0) return null;
    // Cap qty so the position cost never exceeds managed equity.
    // Risk-sized quantity can be very large with tight stops on high-priced stocks,
    // causing cost to exceed available cash. Capping to managedEquity / price ensures
    // the position always fits while still deploying a meaningful allocation.
    const maxQtyForManagedEquity = Math.floor(this.managedEquity() / currentPrice);
    if (maxQtyForManagedEquity <= 0) return null;
    qty = Math.min(qty, maxQtyForManagedEquity);
    const cost = currentPrice * qty;
    if (cost > this.cash) return null;

    this.cash -= cost;
    const position: Position = {
      id: randomUUID(),
      symbol: signal.symbol,
      side: signal.side,
      signalType: signal.type,
      entryPrice: currentPrice,
      quantity: qty,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      openedAt: Date.now(),
    };
    this.positions.set(position.id, position);
    return position;
  }

  checkExits(prices: Map<string, number>): Position[] {
    const closed: Position[] = [];
    for (const [id, pos] of this.positions) {
      const price = prices.get(pos.symbol);
      if (price == null) continue;

      let hit: 'tp' | 'sl' | null = null;
      if (pos.side === 'buy') {
        if (price >= pos.takeProfit) hit = 'tp';
        else if (price <= pos.stopLoss) hit = 'sl';
      } else {
        if (price <= pos.takeProfit) hit = 'tp';
        else if (price >= pos.stopLoss) hit = 'sl';
      }

      if (hit) {
        const exitPrice = hit === 'tp' ? pos.takeProfit : pos.stopLoss;
        const multiplier = pos.side === 'buy' ? 1 : -1;
        const pnl = (exitPrice - pos.entryPrice) * pos.quantity * multiplier;
        pos.pnl = pnl;
        pos.closedAt = Date.now();
        this.cash += exitPrice * pos.quantity;
        this.equity += pnl;
        this.dailyPnl += pnl;
        this.positions.delete(id);
        closed.push({ ...pos });
      }
    }
    return closed;
  }

  closePosition(positionId: string, currentPrice: number): Position | null {
    const pos = this.positions.get(positionId);
    if (!pos) return null;
    const multiplier = pos.side === 'buy' ? 1 : -1;
    const pnl = (currentPrice - pos.entryPrice) * pos.quantity * multiplier;
    pos.pnl = pnl;
    pos.exitPrice = currentPrice;
    pos.closedAt = Date.now();
    this.cash += currentPrice * pos.quantity;
    this.equity += pnl;
    this.dailyPnl += pnl;
    this.positions.delete(positionId);
    return { ...pos };
  }

  resetDay(): void {
    this.dailyPnl = 0;
  }

  hasOpenPosition(symbol: string): boolean {
    return Array.from(this.positions.values()).some(p => p.symbol === symbol);
  }

  hasOpenPositionForSignalType(symbol: string, signalType: SignalType): boolean {
    return Array.from(this.positions.values()).some(
      p => p.symbol === symbol && p.signalType === signalType,
    );
  }
}
