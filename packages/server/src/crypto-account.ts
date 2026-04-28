import type { AccountState, Position, TradeSignal, SignalType } from '@trading-app/shared';
import { MANAGED_ACCOUNT_RATIO, DEFAULT_RISK_PER_TRADE } from '@trading-app/shared';
import { randomUUID } from 'crypto';

const INITIAL_EQUITY = 25_000;

export class CryptoPaperAccount {
  private equity: number;
  private cash: number;
  private positions: Map<string, Position> = new Map();
  private openingEquityToday: number;
  private initialEquity: number;

  constructor(savedEquity = INITIAL_EQUITY, openingEquityToday = savedEquity) {
    this.initialEquity = savedEquity;
    this.equity = savedEquity;
    this.cash = savedEquity;
    this.openingEquityToday = openingEquityToday;
  }

  reset(savedEquity?: number): void {
    const eq = savedEquity ?? this.initialEquity;
    this.initialEquity = eq;
    this.equity = eq;
    this.cash = eq;
    this.openingEquityToday = eq;
    this.positions.clear();
  }

  /**
   * Rebase starting equity by the delta, preserving open positions and today's
   * P&L (the openingEquityToday baseline shifts by the same delta so dailyPnl
   * stays the same).
   */
  applyEquity(newInitialEquity: number): void {
    const delta = newInitialEquity - this.initialEquity;
    if (delta === 0) return;
    this.initialEquity = newInitialEquity;
    this.equity += delta;
    this.cash += delta;
    this.openingEquityToday += delta;
  }

  getInitialEquity(): number {
    return this.initialEquity;
  }

  getState(): Omit<AccountState, 'weeklyPnl' | 'monthlyPnl' | 'yearlyPnl' | 'allTimePnl'> {
    return {
      totalEquity: this.equity,
      availableCash: this.cash,
      openPositions: Array.from(this.positions.values()),
      dailyPnl: this.equity - this.openingEquityToday,
    };
  }

  getEquity(): number {
    return this.equity;
  }

  managedEquity(): number {
    return this.equity * MANAGED_ACCOUNT_RATIO;
  }

  maxRiskPerTrade(): number {
    return this.managedEquity() * DEFAULT_RISK_PER_TRADE;
  }

  /** Fractional sizing for crypto (6 decimal places). */
  sizeFromStop(entryPrice: number, stopPrice: number): number {
    const dist = Math.abs(entryPrice - stopPrice);
    if (dist === 0) return 0;
    const rawQty = this.maxRiskPerTrade() / dist;
    return Math.round(rawQty * 1_000_000) / 1_000_000;
  }

  openPosition(signal: TradeSignal, currentPrice: number): Position | null {
    let qty = this.sizeFromStop(signal.entryPrice, signal.stopLoss);
    if (qty <= 0) {
      console.warn(`[crypto-account] skip ${signal.symbol} ${signal.type}: qty=0 (entry=${signal.entryPrice} stop=${signal.stopLoss} maxRisk=${this.maxRiskPerTrade().toFixed(2)})`);
      return null;
    }
    // Cap qty so cost never exceeds managed equity — same rationale as PaperAccount:
    // tight stops yield large fractional quantities whose cost exceeds cash.
    const maxQtyForManagedEquity = this.managedEquity() / currentPrice;
    qty = Math.min(qty, maxQtyForManagedEquity);
    qty = Math.round(qty * 1_000_000) / 1_000_000;
    if (qty <= 0) {
      console.warn(`[crypto-account] skip ${signal.symbol} ${signal.type}: managedEquity=${this.managedEquity().toFixed(2)} too small for price=${currentPrice}`);
      return null;
    }
    const cost = currentPrice * qty;
    if (cost > this.cash) {
      console.warn(`[crypto-account] skip ${signal.symbol} ${signal.type}: cost=${cost.toFixed(2)} > cash=${this.cash.toFixed(2)} (existing positions consuming cash)`);
      return null;
    }

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
        pos.exitPrice = exitPrice;
        this.cash += exitPrice * pos.quantity;
        this.equity += pnl;
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
    this.positions.delete(positionId);
    return { ...pos };
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
