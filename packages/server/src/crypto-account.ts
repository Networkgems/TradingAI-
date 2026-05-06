import type { AccountState, Position, TradeSignal, SignalType } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import { randomUUID } from 'crypto';

const INITIAL_EQUITY = 25_000;

/**
 * TRA-330 — runaway-equity tripwire. The user-facing demo equity is hard-capped
 * to $10M by `clampEquity` in `index.ts`; 10x that ceiling is the cheapest
 * canary value that distinguishes "user typed a big number" from "internal
 * accounting blew up". When `enforceEquityInvariant` sees equity OR cash beyond
 * this on either side it rebases the account to the configured demo equity and
 * logs the breach so the offending path leaves a paper trail.
 */
export const CRYPTO_MAX_EQUITY = 100_000_000;

export class CryptoPaperAccount {
  private equity: number;
  private cash: number;
  private positions: Map<string, Position> = new Map();
  private openingEquityToday: number;
  private initialEquity: number;
  // TRA-232 — risk knobs come from per-user AccountSettings instead of the
  // hardcoded MANAGED_ACCOUNT_RATIO / DEFAULT_RISK_PER_TRADE constants. The
  // engine pushes fresh values via updateRiskConfig on every settings save so
  // the Crypto dashboard honors what the user enters in Settings.
  private managedAccountRatio: number = DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
  private riskPerTrade: number = DEFAULT_ACCOUNT_SETTINGS.riskPerTrade;

  constructor(savedEquity = INITIAL_EQUITY, openingEquityToday = savedEquity) {
    this.initialEquity = savedEquity;
    this.equity = savedEquity;
    this.cash = savedEquity;
    this.openingEquityToday = openingEquityToday;
  }

  /**
   * Apply per-user risk settings (managedAccountRatio, riskPerTrade) so the
   * crypto demo account sizes positions the same way the user expects from
   * the Settings page. Called on construction and on every settings save.
   */
  updateRiskConfig(config: { managedAccountRatio?: number; riskPerTrade?: number }): void {
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.riskPerTrade !== undefined) this.riskPerTrade = config.riskPerTrade;
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
   * TRA-241 — re-anchor the daily-P&L baseline to current equity. Called from
   * the engine at the 9 PM ET daily close so `dailyPnl` shows 0 for the new
   * trading day. Open positions and equity are untouched.
   */
  resetDay(): void {
    this.openingEquityToday = this.equity;
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
    return this.equity * this.managedAccountRatio;
  }

  maxRiskPerTrade(): number {
    return this.managedEquity() * this.riskPerTrade;
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
    // TRA-330 — shorts collateralise against equity, not spot cash: opening a
    // short receives `cost` as proceeds rather than spending it, so the spot
    // `cost > cash` gate never applied to them. Pre-fix the gate ran for shorts
    // anyway (they took the same `cash -= cost` path as longs), which let cash
    // and equity drift apart on every short cycle and eventually inflated demo
    // equity into the billions. Longs keep the spot gate; shorts use the
    // managedEquity sizing cap above as their margin floor.
    if (signal.side === 'buy' && cost > this.cash) {
      console.warn(`[crypto-account] skip ${signal.symbol} ${signal.type}: cost=${cost.toFixed(2)} > cash=${this.cash.toFixed(2)} (existing positions consuming cash)`);
      return null;
    }

    if (signal.side === 'buy') {
      this.cash -= cost;
    } else {
      // Short proceeds land in cash; the buyback at close subtracts the exit
      // notional. Net cash change over open+close = (entry − exit) × qty,
      // which is exactly the short's PnL, keeping cash and equity in lock-step.
      this.cash += cost;
    }
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
        // TRA-330 — symmetric short fix: longs sell on close (cash += notional),
        // shorts buy back on close (cash -= notional).
        if (pos.side === 'buy') this.cash += exitPrice * pos.quantity;
        else this.cash -= exitPrice * pos.quantity;
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
    // TRA-330 — match the short cash flow fix in checkExits.
    if (pos.side === 'buy') this.cash += currentPrice * pos.quantity;
    else this.cash -= currentPrice * pos.quantity;
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

  /**
   * TRA-330 — runtime tripwire against the runaway-equity drift seen in prod
   * (cash $2.5B, equity ~$6.8B on a $25k demo account). When the in-memory
   * equity OR cash exits the [-CRYPTO_MAX_EQUITY, CRYPTO_MAX_EQUITY] envelope
   * we log loudly with the breach values, clear open positions, and rebase
   * equity/cash/openingEquityToday/initialEquity to `rebaseTarget`. Returns
   * true when a rebase happened so callers can persist the corrected state
   * (and skip downstream work that would re-corrupt the snapshot).
   *
   * Cheap: O(1), called once per tick. The threshold (10x the user-facing
   * `clampEquity` ceiling of $10M) is wide enough to never trip on legitimate
   * settings but tight enough to catch the $2.5B class of drift before it
   * suppresses every signal via `cost > cash`.
   */
  enforceEquityInvariant(rebaseTarget: number): boolean {
    const equityBreach = Math.abs(this.equity) > CRYPTO_MAX_EQUITY;
    const cashBreach = Math.abs(this.cash) > CRYPTO_MAX_EQUITY;
    if (!equityBreach && !cashBreach) return false;
    console.warn(
      `[crypto-account] INVARIANT BREACH equity=${this.equity.toFixed(2)} cash=${this.cash.toFixed(2)} `
      + `positions=${this.positions.size} initialEquity=${this.initialEquity.toFixed(2)} `
      + `(>${CRYPTO_MAX_EQUITY}); rebasing to ${rebaseTarget}`,
    );
    this.initialEquity = rebaseTarget;
    this.equity = rebaseTarget;
    this.cash = rebaseTarget;
    this.openingEquityToday = rebaseTarget;
    this.positions.clear();
    return true;
  }

  /** Serialize current state for durable storage (TRA-140). */
  exportSnapshot(): {
    cash: number;
    equity: number;
    initialEquity: number;
    openingEquityToday: number;
    openPositions: Position[];
  } {
    return {
      cash: this.cash,
      equity: this.equity,
      initialEquity: this.initialEquity,
      openingEquityToday: this.openingEquityToday,
      openPositions: Array.from(this.positions.values()),
    };
  }

  /** Restore state previously serialized via exportSnapshot (TRA-140). */
  importSnapshot(snap: {
    cash: number;
    equity: number;
    initialEquity: number;
    openingEquityToday: number;
    openPositions: Position[];
  }): void {
    this.cash = snap.cash;
    this.equity = snap.equity;
    this.initialEquity = snap.initialEquity;
    this.openingEquityToday = snap.openingEquityToday;
    this.positions.clear();
    for (const p of snap.openPositions) this.positions.set(p.id, p);
  }
}
