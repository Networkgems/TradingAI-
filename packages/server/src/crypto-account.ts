import type { AccountState, Position, PositionQuoteSource, TradeSignal, SignalType } from '@trading-app/shared';
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

// TRA-342 — Coinbase Advanced Trade taker fee (~40 bps) and modeled slippage
// on TP/SL fills (~5 bps). Mirror the values used in
// packages/backtest/src/run-tra306-sweep.ts so demo, the sweep harness, and
// what live actually pays all share a single cost model. Without these the
// demo paper account exits at the exact trigger and bb_fade in particular
// looks ~3–8× more profitable than what live can capture, since its risk
// distance is 10–25 bps and a round-trip fee alone is ~80 bps.
export const CRYPTO_FEE_BPS = 40;
export const CRYPTO_SLIPPAGE_BPS = 5;
const FEE_RATE = CRYPTO_FEE_BPS / 10_000;
const SLIPPAGE_RATE = CRYPTO_SLIPPAGE_BPS / 10_000;

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

  /**
   * @param signal       Strategy signal that fired the entry.
   * @param currentPrice Live quote used to size + record the entry. Must be
   *                     sourced from the venue we trade on (Coinbase) per
   *                     TRA-338 — the engine enforces this before calling.
   * @param quoteSource  TRA-338 — provider that supplied `currentPrice`. The
   *                     engine only routes Coinbase-priced signals to the
   *                     paper account, so in practice this is `'coinbase'`;
   *                     the parameter exists so the audit trail on
   *                     `Position.quoteSource` is correct on the rare
   *                     manual-entry path (admin tooling). Optional with no
   *                     default so an accidental missing argument lights up
   *                     in code review rather than silently writing
   *                     `'unknown'` onto a fresh entry.
   */
  openPosition(signal: TradeSignal, currentPrice: number, quoteSource?: PositionQuoteSource): Position | null {
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
    // TRA-342 — apply Coinbase taker fee on the entry leg so demo cash flow
    // mirrors live. The matching exit fee is taken on the close in
    // checkExits / closePosition.
    // TRA-330 — shorts collateralise against equity, not spot cash: opening a
    // short receives proceeds rather than spending them, so the `cost > cash`
    // gate never applied to them. Longs keep the spot gate; shorts use the
    // managedEquity sizing cap above as their margin floor.
    const notional = currentPrice * qty;
    const entryFee = notional * FEE_RATE;
    const cost = notional + entryFee;
    if (signal.side === 'buy' && cost > this.cash) {
      console.warn(`[crypto-account] skip ${signal.symbol} ${signal.type}: cost=${cost.toFixed(2)} > cash=${this.cash.toFixed(2)} (existing positions consuming cash)`);
      return null;
    }

    if (signal.side === 'buy') {
      this.cash -= cost;
    } else {
      // Short proceeds land in cash net of the entry fee; the buyback at close
      // subtracts the exit notional plus the exit fee. Net cash change over
      // open+close = (entry − exit) × qty − round-trip fee, which is the
      // short's fee-aware PnL, keeping cash and equity in lock-step.
      this.cash += notional - entryFee;
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
      quoteSource,
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
        // TRA-342 — paper instant-fill at the exact trigger is unrealistic;
        // model a small slippage so the fill is always *worse* than the
        // trigger (longs fill below, shorts fill above), then book P&L net
        // of round-trip fees. Manual closes via closePosition still use the
        // quote price since they represent an explicit user click.
        const trigger = hit === 'tp' ? pos.takeProfit : pos.stopLoss;
        const slipDir = pos.side === 'buy' ? -1 : 1;
        const exitPrice = trigger * (1 + slipDir * SLIPPAGE_RATE);
        const multiplier = pos.side === 'buy' ? 1 : -1;
        const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity * multiplier;
        const totalFee = (pos.entryPrice + exitPrice) * pos.quantity * FEE_RATE;
        const pnl = grossPnl - totalFee;
        pos.pnl = pnl;
        pos.closedAt = Date.now();
        pos.exitPrice = exitPrice;
        // TRA-330 + TRA-342 — symmetric short cash flow with the exit fee
        // baked in: longs sell on close and receive proceeds net of fee,
        // shorts buy back on close and pay notional plus fee.
        const exitNotional = exitPrice * pos.quantity;
        const exitFee = exitNotional * FEE_RATE;
        if (pos.side === 'buy') this.cash += exitNotional - exitFee;
        else this.cash -= exitNotional + exitFee;
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
    // TRA-342 — manual close still pays the round-trip fee (the user clicked
    // close at the live quote, but Coinbase still takes its taker cut on the
    // exit leg). Skip the slippage modeling — the user picked this price
    // explicitly, no spread crossing to model on top.
    const multiplier = pos.side === 'buy' ? 1 : -1;
    const grossPnl = (currentPrice - pos.entryPrice) * pos.quantity * multiplier;
    const totalFee = (pos.entryPrice + currentPrice) * pos.quantity * FEE_RATE;
    const pnl = grossPnl - totalFee;
    pos.pnl = pnl;
    pos.exitPrice = currentPrice;
    pos.closedAt = Date.now();
    // TRA-330 + TRA-342 — long sells with proceeds net of exit fee,
    // short buys back paying notional + exit fee.
    const exitNotional = currentPrice * pos.quantity;
    const exitFee = exitNotional * FEE_RATE;
    if (pos.side === 'buy') this.cash += exitNotional - exitFee;
    else this.cash -= exitNotional + exitFee;
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
    for (const p of snap.openPositions) {
      // TRA-338 — backfill quoteSource on legacy positions persisted before
      // the field existed so the API surface always answers a non-undefined
      // value. New entries write 'coinbase' explicitly via openPosition;
      // anything else on disk is from a pre-fix snapshot and is untraceable.
      this.positions.set(p.id, p.quoteSource ? p : { ...p, quoteSource: 'unknown' });
    }
  }
}
