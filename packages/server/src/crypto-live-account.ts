import type { Position, TradeSignal, SignalType } from '@trading-app/shared';
import { MANAGED_ACCOUNT_RATIO, DEFAULT_RISK_PER_TRADE } from '@trading-app/shared';
import type {
  CoinbaseOrderClient,
  CoinbaseAccountBalance,
  CoinbaseOrderSuccessResponse,
} from '@trading-app/engine';
import { randomUUID } from 'crypto';

/** Stable currencies treated 1:1 with USD when computing equity. */
const CASH_CURRENCIES = new Set(['USD', 'USDC', 'USDT']);
const BALANCE_REFRESH_MS = 30_000;

export interface CryptoLiveAccountState {
  totalEquity: number;
  availableCash: number;
  openPositions: Position[];
  dailyPnl: number;
}

/**
 * Live crypto trading account backed by a Coinbase Advanced Trade order client.
 *
 * Mirrors the surface of CryptoPaperAccount (size sizing, openPosition, checkExits,
 * closePosition, snapshot import/export) so the engine can swap implementations
 * without changing call sites. All orders are routed through Coinbase; the local
 * `positions` map is a mirror of in-flight trades that we opened in this session.
 *
 * Cash and equity are sourced from Coinbase account balances on a 30s refresh.
 * Today's P&L is tracked locally as the running sum of realized P&L on closes.
 *
 * **Failure semantics:** if Coinbase rejects an order we throw and the local
 * mirror is left untouched — the engine treats the signal as unfilled. Stale
 * positions on Coinbase that were not opened by us are intentionally NOT
 * imported (we'd risk unwinding pre-existing user holdings).
 */
export class CryptoLiveAccount {
  private readonly coinbase: CoinbaseOrderClient;
  private readonly positions: Map<string, Position> = new Map();
  private cashUsd = 0;
  private equityUsd = 0;
  private realizedPnlToday = 0;
  private lastBalanceRefresh = 0;

  constructor(coinbase: CoinbaseOrderClient) {
    this.coinbase = coinbase;
  }

  /** Refresh USD-equivalent cash from Coinbase. Should be called periodically. */
  async refreshBalance(): Promise<void> {
    let accounts: CoinbaseAccountBalance[];
    try {
      accounts = await this.coinbase.listAccounts();
    } catch (err: unknown) {
      console.warn('[crypto-live] balance refresh failed:', err instanceof Error ? err.message : String(err));
      return;
    }
    let cash = 0;
    for (const a of accounts) {
      if (CASH_CURRENCIES.has(a.currency.toUpperCase())) {
        const v = parseFloat(a.available_balance.value);
        if (Number.isFinite(v)) cash += v;
      }
    }
    this.cashUsd = cash;
    this.equityUsd = cash + this.estimateOpenPositionValue();
    this.lastBalanceRefresh = Date.now();
  }

  /** Equity at last refresh, plus open-position notional at last seen price. */
  private estimateOpenPositionValue(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.entryPrice * pos.quantity;
    }
    return total;
  }

  getState(): CryptoLiveAccountState {
    return {
      totalEquity: this.equityUsd,
      availableCash: this.cashUsd,
      openPositions: Array.from(this.positions.values()),
      dailyPnl: this.realizedPnlToday,
    };
  }

  isStale(): boolean {
    return Date.now() - this.lastBalanceRefresh > BALANCE_REFRESH_MS;
  }

  managedEquity(): number {
    return this.equityUsd * MANAGED_ACCOUNT_RATIO;
  }

  maxRiskPerTrade(): number {
    return this.managedEquity() * DEFAULT_RISK_PER_TRADE;
  }

  /** Same fractional sizing as the paper account — 6 decimal places. */
  sizeFromStop(entryPrice: number, stopPrice: number): number {
    const dist = Math.abs(entryPrice - stopPrice);
    if (dist === 0) return 0;
    const rawQty = this.maxRiskPerTrade() / dist;
    return Math.round(rawQty * 1_000_000) / 1_000_000;
  }

  hasOpenPosition(symbol: string): boolean {
    return Array.from(this.positions.values()).some(p => p.symbol === symbol);
  }

  hasOpenPositionForSignalType(symbol: string, signalType: SignalType): boolean {
    return Array.from(this.positions.values()).some(
      p => p.symbol === symbol && p.signalType === signalType,
    );
  }

  /**
   * Submit a market order to Coinbase and, on success, record the resulting
   * position locally. Returns null if the trade was skipped before order
   * submission (qty too small, insufficient cash). Throws if Coinbase rejects.
   */
  async openPosition(signal: TradeSignal, currentPrice: number): Promise<Position | null> {
    let qty = this.sizeFromStop(signal.entryPrice, signal.stopLoss);
    if (qty <= 0) {
      console.warn(`[crypto-live] skip ${signal.symbol} ${signal.type}: qty=0`);
      return null;
    }
    const maxQtyForManagedEquity = this.managedEquity() / currentPrice;
    qty = Math.min(qty, maxQtyForManagedEquity);
    qty = Math.round(qty * 1_000_000) / 1_000_000;
    if (qty <= 0) {
      console.warn(`[crypto-live] skip ${signal.symbol} ${signal.type}: managed equity too small`);
      return null;
    }
    const cost = currentPrice * qty;
    if (cost > this.cashUsd) {
      console.warn(`[crypto-live] skip ${signal.symbol} ${signal.type}: cost=${cost.toFixed(2)} > cash=${this.cashUsd.toFixed(2)}`);
      return null;
    }

    let resp: CoinbaseOrderSuccessResponse;
    try {
      resp = await this.coinbase.placeMarketOrder({
        productId: signal.symbol,
        side: signal.side,
        baseSize: qty,
      });
    } catch (err: unknown) {
      console.error(`[crypto-live] open failed for ${signal.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

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
    // Optimistic cash debit; refreshBalance() will reconcile from Coinbase.
    this.cashUsd -= cost;
    console.log(`[crypto-live] OPEN ${signal.side.toUpperCase()} ${qty} ${signal.symbol} @ ~${currentPrice.toFixed(2)} (coinbase order=${resp.order_id})`);
    return position;
  }

  /**
   * For each open position whose current price has hit TP or SL, send a
   * market order to flatten and record realized P&L locally.
   */
  async checkExits(prices: Map<string, number>): Promise<Position[]> {
    const closed: Position[] = [];
    for (const [id, pos] of Array.from(this.positions.entries())) {
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
      if (!hit) continue;

      const exitSide: 'buy' | 'sell' = pos.side === 'buy' ? 'sell' : 'buy';
      try {
        await this.coinbase.placeMarketOrder({
          productId: pos.symbol,
          side: exitSide,
          baseSize: pos.quantity,
        });
      } catch (err: unknown) {
        console.error(`[crypto-live] exit failed for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)} — leaving position open, will retry next tick`);
        continue;
      }

      const exitPrice = hit === 'tp' ? pos.takeProfit : pos.stopLoss;
      const multiplier = pos.side === 'buy' ? 1 : -1;
      const pnl = (exitPrice - pos.entryPrice) * pos.quantity * multiplier;
      pos.pnl = pnl;
      pos.closedAt = Date.now();
      pos.exitPrice = exitPrice;
      this.realizedPnlToday += pnl;
      this.cashUsd += exitPrice * pos.quantity;
      this.equityUsd += pnl;
      this.positions.delete(id);
      closed.push({ ...pos });
      console.log(`[crypto-live] CLOSE ${pos.symbol} ${hit.toUpperCase()} pnl=${pnl.toFixed(2)}`);
    }
    return closed;
  }

  /** Manual close — flatten via market order at current price. */
  async closePosition(positionId: string, currentPrice: number): Promise<Position | null> {
    const pos = this.positions.get(positionId);
    if (!pos) return null;
    const exitSide: 'buy' | 'sell' = pos.side === 'buy' ? 'sell' : 'buy';
    await this.coinbase.placeMarketOrder({
      productId: pos.symbol,
      side: exitSide,
      baseSize: pos.quantity,
    });
    const multiplier = pos.side === 'buy' ? 1 : -1;
    const pnl = (currentPrice - pos.entryPrice) * pos.quantity * multiplier;
    pos.pnl = pnl;
    pos.exitPrice = currentPrice;
    pos.closedAt = Date.now();
    this.realizedPnlToday += pnl;
    this.cashUsd += currentPrice * pos.quantity;
    this.equityUsd += pnl;
    this.positions.delete(positionId);
    return { ...pos };
  }

  /** Reset realized P&L tracker — called on UTC day rollover by the engine. */
  rolloverDay(): void {
    this.realizedPnlToday = 0;
  }
}
