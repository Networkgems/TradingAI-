import type { AccountState, Position, TradeSignal, SignalType } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS, validateBracket } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'paper-account' });

interface PaperAccountConfig {
  initialEquity?: number;
  managedAccountRatio?: number;
  riskPerTrade?: number;
  /** Optional override of current equity (when restoring from persisted state). */
  currentEquity?: number;
  /** Optional restore of today's accumulated P&L across server restarts. */
  dailyPnl?: number;
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
    this.equity = config.currentEquity ?? this.initialEquity;
    this.cash = this.equity;
    if (config.dailyPnl !== undefined) this.dailyPnl = config.dailyPnl;
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

  /**
   * Rebase starting equity to a new value, preserving open positions, dailyPnl,
   * and realized progress. Equity and cash are shifted by the delta so a
   * settings save reflects the new starting balance immediately.
   */
  applyEquity(newInitialEquity: number): void {
    const delta = newInitialEquity - this.initialEquity;
    if (delta === 0) return;
    this.initialEquity = newInitialEquity;
    this.equity += delta;
    this.cash += delta;
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

  /**
   * Open a paper position for `signal` at `currentPrice`.
   *
   * `sizeMultiplier` (TRA-389) is a position-size scalar in (0,1] applied
   * after the risk- and managed-equity caps — the signal engine passes the
   * market-review regime's `sizingMultiplier` here when the gate-consumption
   * flag is on. Defaults to 1 (no trim) so every other caller sizes exactly
   * as before. A multiplier that rounds the share count to 0 skips the open.
   */
  openPosition(signal: TradeSignal, currentPrice: number, sizeMultiplier = 1): Position | null {
    // TRA-520 — never open a position whose protective bracket is on the wrong
    // side of entry (or non-positive). A negative stop/target silently disables
    // the risk-management exits, letting a loser run unbounded. Validate against
    // the actual fill price the position will carry (`currentPrice`), since that
    // — not the signal's entry — is what the exit checks compare against.
    const bracket = validateBracket(signal.side, currentPrice, signal.stopLoss, signal.takeProfit);
    if (!bracket.ok) {
      log.warn('skip signal: invalid stop/take bracket', {
        symbol: signal.symbol,
        signalType: signal.type,
        side: signal.side,
        price: currentPrice,
        stop: signal.stopLoss,
        takeProfit: signal.takeProfit,
        reason: bracket.reason,
      });
      return null;
    }
    let qty = this.sizeFromStop(signal.entryPrice, signal.stopLoss);
    if (qty <= 0) {
      log.warn('skip signal: qty=0', {
        symbol: signal.symbol,
        signalType: signal.type,
        entry: signal.entryPrice,
        stop: signal.stopLoss,
        maxRisk: this.maxRiskPerTrade().toFixed(2),
      });
      return null;
    }
    // Cap qty so the position cost never exceeds managed equity.
    // Risk-sized quantity can be very large with tight stops on high-priced stocks,
    // causing cost to exceed available cash. Capping to managedEquity / price ensures
    // the position always fits while still deploying a meaningful allocation.
    const maxQtyForManagedEquity = Math.floor(this.managedEquity() / currentPrice);
    if (maxQtyForManagedEquity <= 0) {
      log.warn('skip signal: managedEquity below price (equity too small for one share)', {
        symbol: signal.symbol,
        signalType: signal.type,
        managedEquity: this.managedEquity().toFixed(2),
        price: currentPrice,
      });
      return null;
    }
    qty = Math.min(qty, maxQtyForManagedEquity);
    // TRA-389 — trim by the market-review regime scalar (1 ↔ no-op).
    if (Number.isFinite(sizeMultiplier) && sizeMultiplier > 0 && sizeMultiplier < 1) {
      qty = Math.floor(qty * sizeMultiplier);
      if (qty <= 0) {
        log.warn('skip signal: market-review sizing multiplier rounded qty to 0', {
          symbol: signal.symbol,
          signalType: signal.type,
          sizeMultiplier,
        });
        return null;
      }
    }
    const cost = currentPrice * qty;
    if (cost > this.cash) {
      log.warn('skip signal: cost exceeds cash (existing positions consuming cash)', {
        symbol: signal.symbol,
        signalType: signal.type,
        cost: cost.toFixed(2),
        cash: this.cash.toFixed(2),
      });
      return null;
    }

    this.cash -= cost;
    const position: Position = {
      id: randomUUID(),
      symbol: signal.symbol,
      side: signal.side,
      signalType: signal.type,
      signalId: signal.id,
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

      // TRA-518 — self-heal: a position whose protective bracket is structurally
      // invalid (negative/NaN stop or target, or sitting on the wrong side of
      // entry) can never satisfy the stop/target comparisons below, so it would
      // stay open forever — the "demo account never closes anything / nothing
      // updates" symptom. These brackets predate the TRA-520 `validateBracket`
      // guard (observed live: ASTC stopLoss=-0.215, PRFX takeProfit=-0.04).
      // Force-close at the live price so the book unfreezes and the bad data is
      // purged; healthy brackets pass validateBracket and are untouched.
      const bracket = validateBracket(pos.side, pos.entryPrice, pos.stopLoss, pos.takeProfit);
      if (!bracket.ok) {
        const healed = this.closePosition(id, price);
        if (healed) {
          healed.exitReason = 'invalid_bracket';
          log.warn('force-closed position with invalid bracket (TRA-518 self-heal)', {
            positionId: id,
            symbol: pos.symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            exitPrice: price,
            reason: bracket.reason,
          });
          closed.push(healed);
        }
        continue;
      }

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

  /** Serialize current state for durable storage (TRA-140). */
  exportSnapshot(): {
    cash: number;
    equity: number;
    initialEquity: number;
    dailyPnl: number;
    openPositions: Position[];
  } {
    return {
      cash: this.cash,
      equity: this.equity,
      initialEquity: this.initialEquity,
      dailyPnl: this.dailyPnl,
      openPositions: Array.from(this.positions.values()),
    };
  }

  /** Restore state previously serialized via exportSnapshot (TRA-140). */
  importSnapshot(snap: {
    cash: number;
    equity: number;
    initialEquity: number;
    dailyPnl: number;
    openPositions: Position[];
  }): void {
    this.cash = snap.cash;
    this.equity = snap.equity;
    this.initialEquity = snap.initialEquity;
    this.dailyPnl = snap.dailyPnl;
    this.positions.clear();
    for (const p of snap.openPositions) {
      this.positions.set(p.id, p);
    }
  }
}
