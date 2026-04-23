import type { AccountState, Position, TradeSignal, SignalType } from '@trading-app/shared';
import { MANAGED_ACCOUNT_RATIO, DEFAULT_RISK_PER_TRADE } from '@trading-app/shared';
import { randomUUID } from 'crypto';

const INITIAL_EQUITY = 25_000; // paper account starting equity

export class PaperAccount {
  private equity = INITIAL_EQUITY;
  private cash = INITIAL_EQUITY;
  private positions: Map<string, Position> = new Map();
  private dailyPnl = 0;
  private sessionStart = Date.now();

  getState(): AccountState {
    return {
      totalEquity: this.equity,
      availableCash: this.cash,
      openPositions: Array.from(this.positions.values()),
      dailyPnl: this.dailyPnl,
    };
  }

  managedEquity(): number {
    return this.equity * MANAGED_ACCOUNT_RATIO;
  }

  maxRiskPerTrade(): number {
    return this.managedEquity() * DEFAULT_RISK_PER_TRADE;
  }

  sizeFromStop(entryPrice: number, stopPrice: number): number {
    const dist = Math.abs(entryPrice - stopPrice);
    if (dist === 0) return 0;
    return Math.floor(this.maxRiskPerTrade() / dist);
  }

  /** Open a position for a signal and return the position if funded. */
  openPosition(signal: TradeSignal, currentPrice: number): Position | null {
    const qty = this.sizeFromStop(signal.entryPrice, signal.stopLoss);
    if (qty <= 0) return null;
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

  /** Check open positions against latest prices and close any that hit TP or SL. */
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

  /** Reset daily P&L at session boundary. */
  resetDay(): void {
    this.dailyPnl = 0;
    this.sessionStart = Date.now();
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
