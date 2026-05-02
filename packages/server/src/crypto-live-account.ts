import type { Position, TradeSignal, SignalType } from '@trading-app/shared';
import { MANAGED_ACCOUNT_RATIO, DEFAULT_RISK_PER_TRADE } from '@trading-app/shared';
import type {
  CoinbaseOrderClient,
  CoinbaseAccountBalance,
  CoinbaseOrderDetails,
  CoinbaseOrderSuccessResponse,
} from '@trading-app/engine';
import { randomUUID } from 'crypto';

/** Stable currencies treated 1:1 with USD when computing equity. */
const CASH_CURRENCIES = new Set(['USD', 'USDC', 'USDT']);
const BALANCE_REFRESH_MS = 30_000;

/**
 * Backoff schedule (ms) for polling `GET /orders/historical/{id}` after a
 * market IOC order succeeds. Coinbase usually fills these within tens of ms,
 * but the historical endpoint can briefly report PENDING; budget ~5s total
 * before treating the order as suspect (TRA-156).
 */
const FILL_POLL_DELAYS_MS = [0, 200, 400, 800, 1500, 2000];

const TERMINAL_FAILURE_STATUSES = new Set(['CANCELLED', 'EXPIRED', 'FAILED']);

export interface CryptoLiveAccountState {
  totalEquity: number;
  availableCash: number;
  openPositions: Position[];
  dailyPnl: number;
}

export interface CryptoLiveAccountOptions {
  /** Override sleep so tests can advance time without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

interface ReconciledFill {
  /** Volume-weighted average fill price across all partial fills. */
  price: number;
  /** Total base size actually filled. */
  size: number;
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
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly positions: Map<string, Position> = new Map();
  private cashUsd = 0;
  private equityUsd = 0;
  private realizedPnlToday = 0;
  private lastBalanceRefresh = 0;

  constructor(coinbase: CoinbaseOrderClient, opts: CryptoLiveAccountOptions = {}) {
    this.coinbase = coinbase;
    this.sleep = opts.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  }

  /**
   * Refresh USD-equivalent cash and equity from Coinbase.
   *
   * Cash is summed across stable currencies (USD, USDC, USDT). Non-cash
   * holdings (BTC, ETH, SOL, …) are valued at the current Coinbase spot
   * price for `{currency}-USD` so the dashboard reflects the user's full
   * portfolio rather than just the stable-cash slice (TRA-224 — users with
   * pre-existing crypto on Coinbase were seeing equity = $0).
   *
   * Spot-pricing is best-effort: a failed `getProductPrices` call leaves
   * crypto holdings unvalued (logged as a warning) rather than blowing up
   * the whole refresh. Currencies without a USD pair on Coinbase are simply
   * skipped — the absent price drops out of the Map.
   *
   * Coinbase's `available_balance` already reflects fills from orders we've
   * placed, so we no longer add a separate "open-position notional" term —
   * doing so would double-count the local mirror against the real wallet.
   */
  async refreshBalance(): Promise<void> {
    let accounts: CoinbaseAccountBalance[];
    try {
      accounts = await this.coinbase.listAccounts();
    } catch (err: unknown) {
      console.warn('[crypto-live] balance refresh failed:', err instanceof Error ? err.message : String(err));
      return;
    }
    let cash = 0;
    const cryptoBalances = new Map<string, number>();
    for (const a of accounts) {
      const currency = a.currency.toUpperCase();
      const v = parseFloat(a.available_balance.value);
      if (!Number.isFinite(v) || v === 0) continue;
      if (CASH_CURRENCIES.has(currency)) {
        cash += v;
      } else {
        cryptoBalances.set(`${currency}-USD`, v);
      }
    }

    let cryptoValue = 0;
    if (cryptoBalances.size > 0) {
      let prices: Map<string, number>;
      try {
        prices = await this.coinbase.getProductPrices(Array.from(cryptoBalances.keys()));
      } catch (err: unknown) {
        console.warn('[crypto-live] product price lookup failed:', err instanceof Error ? err.message : String(err));
        prices = new Map();
      }
      for (const [productId, balance] of cryptoBalances) {
        const price = prices.get(productId);
        if (price != null) cryptoValue += balance * price;
      }
    }

    this.cashUsd = cash;
    this.equityUsd = cash + cryptoValue;
    this.lastBalanceRefresh = Date.now();
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

    // Reconcile against the real fill so the local mirror reflects what Coinbase
    // actually executed (TRA-156). Falls back to the quote price/requested qty
    // if the API hasn't caught up — refreshBalance() will smooth out any drift.
    const fill = await this.awaitFill(resp.order_id, signal.symbol);
    const entryPrice = fill?.price ?? currentPrice;
    const filledQty = fill?.size ?? qty;

    const position: Position = {
      id: randomUUID(),
      symbol: signal.symbol,
      side: signal.side,
      signalType: signal.type,
      entryPrice,
      quantity: filledQty,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      openedAt: Date.now(),
    };
    this.positions.set(position.id, position);
    // Optimistic cash debit; refreshBalance() will reconcile from Coinbase.
    this.cashUsd -= entryPrice * filledQty;
    const reconciled = fill ? `@ ${entryPrice.toFixed(2)} (filled ${filledQty})` : `@ ~${currentPrice.toFixed(2)} (unreconciled)`;
    console.log(`[crypto-live] OPEN ${signal.side.toUpperCase()} ${signal.symbol} ${reconciled} (coinbase order=${resp.order_id})`);
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
      let exitOrder: CoinbaseOrderSuccessResponse;
      try {
        exitOrder = await this.coinbase.placeMarketOrder({
          productId: pos.symbol,
          side: exitSide,
          baseSize: pos.quantity,
        });
      } catch (err: unknown) {
        console.error(`[crypto-live] exit failed for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)} — leaving position open, will retry next tick`);
        continue;
      }

      // Prefer the real fill VWAP from Coinbase over our TP/SL trigger price so
      // realized P&L matches the Coinbase statement (TRA-156). Fall back to the
      // trigger price if the historical-orders endpoint doesn't settle in time.
      const exitFill = await this.awaitFill(exitOrder.order_id, pos.symbol);
      const triggerPrice = hit === 'tp' ? pos.takeProfit : pos.stopLoss;
      const exitPrice = exitFill?.price ?? triggerPrice;
      const exitQty = exitFill?.size ?? pos.quantity;
      const multiplier = pos.side === 'buy' ? 1 : -1;
      const pnl = (exitPrice - pos.entryPrice) * exitQty * multiplier;
      pos.pnl = pnl;
      pos.closedAt = Date.now();
      pos.exitPrice = exitPrice;
      pos.quantity = exitQty;
      this.realizedPnlToday += pnl;
      this.cashUsd += exitPrice * exitQty;
      this.equityUsd += pnl;
      this.positions.delete(id);
      closed.push({ ...pos });
      console.log(`[crypto-live] CLOSE ${pos.symbol} ${hit.toUpperCase()} @ ${exitPrice.toFixed(2)} pnl=${pnl.toFixed(2)}`);
    }
    return closed;
  }

  /** Manual close — flatten via market order at current price. */
  async closePosition(positionId: string, currentPrice: number): Promise<Position | null> {
    const pos = this.positions.get(positionId);
    if (!pos) return null;
    const exitSide: 'buy' | 'sell' = pos.side === 'buy' ? 'sell' : 'buy';
    const exitOrder = await this.coinbase.placeMarketOrder({
      productId: pos.symbol,
      side: exitSide,
      baseSize: pos.quantity,
    });
    const exitFill = await this.awaitFill(exitOrder.order_id, pos.symbol);
    const exitPrice = exitFill?.price ?? currentPrice;
    const exitQty = exitFill?.size ?? pos.quantity;
    const multiplier = pos.side === 'buy' ? 1 : -1;
    const pnl = (exitPrice - pos.entryPrice) * exitQty * multiplier;
    pos.pnl = pnl;
    pos.exitPrice = exitPrice;
    pos.quantity = exitQty;
    pos.closedAt = Date.now();
    this.realizedPnlToday += pnl;
    this.cashUsd += exitPrice * exitQty;
    this.equityUsd += pnl;
    this.positions.delete(positionId);
    return { ...pos };
  }

  /** Reset realized P&L tracker — called on UTC day rollover by the engine. */
  rolloverDay(): void {
    this.realizedPnlToday = 0;
  }

  /**
   * Poll `GET /orders/historical/{order_id}` until the order reports FILLED,
   * or until the backoff schedule is exhausted. Returns the VWAP price + total
   * filled size. Returns null on:
   *
   * - terminal failure statuses (CANCELLED / EXPIRED / FAILED) — caller should
   *   keep its requested values; refreshBalance will rebalance cash next tick;
   * - timeout (Coinbase still reports OPEN/PENDING after ~5s);
   * - repeated lookup errors.
   *
   * Throwing here would invert the API contract — `placeMarketOrder` already
   * succeeded, so we'd lose the position record entirely. A warning + null
   * keeps us aligned with the legacy "use quote price" behaviour.
   */
  private async awaitFill(orderId: string, symbol: string): Promise<ReconciledFill | null> {
    let lastStatus = 'unknown';
    for (let i = 0; i < FILL_POLL_DELAYS_MS.length; i++) {
      const delay = FILL_POLL_DELAYS_MS[i];
      if (delay > 0) await this.sleep(delay);
      let order: CoinbaseOrderDetails;
      try {
        order = await this.coinbase.getOrder(orderId);
      } catch (err: unknown) {
        console.warn(`[crypto-live] fill lookup ${orderId} (${symbol}) attempt ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      lastStatus = (order.status ?? 'unknown').toUpperCase();
      if (lastStatus === 'FILLED') {
        const price = parseFloat(order.average_filled_price);
        const size = parseFloat(order.filled_size);
        if (Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0) {
          return { price, size };
        }
        console.warn(`[crypto-live] fill ${orderId} (${symbol}) FILLED with bad numbers price=${order.average_filled_price} size=${order.filled_size}`);
        return null;
      }
      if (TERMINAL_FAILURE_STATUSES.has(lastStatus)) {
        console.warn(`[crypto-live] fill ${orderId} (${symbol}) terminal status=${lastStatus}; cannot reconcile`);
        return null;
      }
      // OPEN / PENDING — keep polling.
    }
    console.warn(`[crypto-live] fill ${orderId} (${symbol}) did not settle within ${FILL_POLL_DELAYS_MS.length} attempts (last status=${lastStatus})`);
    return null;
  }
}
