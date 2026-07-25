import type { AccountState, ExitReason, Position, TradeSignal, SignalType } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS, validateBracket } from '@trading-app/shared';
import { chandelierStop, chandelierExitTriggered, profitLockDecision } from '@trading-app/engine';
import { sizeFromStopViaRiskManager } from './account-sizing.js';
import { randomUUID } from 'crypto';
import { logger } from './observability/index.js';

/**
 * TRA-1268 (TRA-1250 Rules 1-2) — per-tick inputs the demo-equity exit loop
 * needs to evaluate the ATR chandelier trail (Rule 1) and the trade-level
 * profit-lock give-back cap (Rule 2). The caller (signal-engine) computes the
 * live ATR(14) on minute bars per symbol and only supplies this object when
 * `EXIT_RISK_RULES_ENABLED` is on, so the rules ship dark and `checkExits`
 * behaviour is byte-for-byte unchanged when it is absent.
 */
export interface EquityExitRiskInput {
  /** Live ATR(14) on the position's minute-bar timeframe, keyed by symbol. */
  atrBySymbol: Map<string, number>;
  /** ATR / price by symbol — picks the high-beta chandelier multiplier. Optional. */
  atrPctBySymbol?: Map<string, number>;
}

const log = logger.child({ module: 'paper-account' });

/**
 * TRA-536 — per-fill modeled slippage assumption for equity paper fills, in
 * basis points of notional. Mirrors `SLIPPAGE_BPS` in `backtest-equity.ts` so
 * the demo book's modeled slippage budget matches what the equity backtest
 * charges (commission-free brokers; slippage alone captures the drag). Used to
 * stamp `Position.modeledSlippage` at open for the TRA-532 Stage-2 gate.
 */
export const STOCK_SLIPPAGE_BPS = 5;
const STOCK_SLIPPAGE_RATE = STOCK_SLIPPAGE_BPS / 10_000;

/** TRA-2301 — record of the one-shot cash repair applied at restore. */
export interface CashRepairRecord {
  appliedAt: number;
  delta: number;
  from: number;
  to: number;
}

/** Durable shape for {@link PaperAccount.exportSnapshot} / `importSnapshot` (TRA-140). */
export interface PaperAccountSnapshot {
  cash: number;
  equity: number;
  initialEquity: number;
  dailyPnl: number;
  openPositions: Position[];
  /**
   * TRA-2301 — audit trace of the cash repair. Optional: absent on every
   * snapshot written before the fix, and on books that never drifted.
   */
  cashRepair?: CashRepairRecord | null;
}

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
  /**
   * TRA-2301 — audit trace of the one-shot cash repair applied at
   * {@link importSnapshot}. `null` means the restored book already satisfied
   * the cash invariant. Persisted through the snapshot so a repaired book stays
   * distinguishable from a book that never drifted — without it, a repaired
   * book and a healthy book read IDENTICALLY on `/api/health/demo-book-public`
   * (gap 0 either way) and the repair would be unverifiable after the fact.
   */
  private cashRepair: CashRepairRecord | null = null;
  /**
   * TRA-1268 — per-position running state for the exit-risk rules, keyed by
   * position id: the favorable `extremeSinceEntry` (peak for longs / trough for
   * shorts) and the last chandelier `prevTrailStop` (so the trail only ratchets
   * one way). Seeded lazily on first `checkExits` sighting and dropped when the
   * position closes. Not persisted — it re-seeds from the entry price on the
   * next tick after a restart, which is conservative (a wider initial trail).
   */
  private exitRiskState: Map<string, { extremeSinceEntry: number; prevTrailStop?: number }> = new Map();

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
    this.exitRiskState.clear();
    this.dailyPnl = 0;
    this.cashRepair = null;
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
      // TRA-2301 — omit the key entirely on a book that never drifted, so
      // "repaired" and "never broken" are distinguishable downstream.
      ...(this.cashRepair ? { cashRepair: this.cashRepair } : {}),
    };
  }

  /**
   * TRA-2301 — signed capital committed to the open book at cost basis: a long
   * has spent `entry × qty` of cash, a short has *received* it. Equity is not
   * marked to market (it only moves on a close), so this is the exact bridge
   * between the two ledgers.
   */
  private committedCapital(): number {
    let committed = 0;
    for (const pos of this.positions.values()) {
      committed += (pos.side === 'buy' ? 1 : -1) * pos.entryPrice * pos.quantity;
    }
    return committed;
  }

  /**
   * TRA-2301 — the cash balance this book *should* hold. Every open debits
   * (long) or credits (short) cash by cost basis and leaves equity alone; every
   * close moves cash by the exit notional and equity by the P&L, which
   * telescopes the pair back together. So with a flat book this is exactly
   * `equity`, and `cash − expectedCash()` is drift with no legitimate source.
   */
  private expectedCash(): number {
    return this.equity - this.committedCapital();
  }

  /**
   * TRA-2301 — the audit trace of the one-shot cash repair applied when this
   * book was restored, or `null` if it was already consistent. Surfaced on
   * `/api/health/demo-book-public` so "repaired" stays readable as something
   * other than "never broken".
   */
  getCashRepair(): CashRepairRecord | null {
    return this.cashRepair;
  }

  managedEquity(): number {
    return this.equity * this.managedAccountRatio;
  }

  maxRiskPerTrade(): number {
    return this.managedEquity() * this.riskPerTrade;
  }

  /**
   * TRA-2034 — size through the shared engine `RiskManager` (the same code the
   * backtest runner uses) instead of a bespoke `floor(maxRisk / dist)`, so demo
   * and backtest size identically from the same risk inputs and the TRA-178
   * notional cap now runs on the demo book too. See {@link sizeFromStopViaRiskManager}.
   */
  sizeFromStop(entryPrice: number, stopPrice: number): number {
    return sizeFromStopViaRiskManager(entryPrice, stopPrice, {
      managedEquity: this.managedEquity(),
      riskPerTrade: this.riskPerTrade,
      fractionalQuantity: false,
    });
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
    // TRA-2301 (mirrors TRA-330 on the crypto book) — shorts collateralise
    // against equity, not spot cash: opening a short *receives* proceeds rather
    // than spending them, so the `cost > cash` gate never applied to them. The
    // `maxQtyForManagedEquity` cap above is the short's margin floor. Longs keep
    // the spot-cash gate, which is their real constraint.
    if (signal.side === 'buy' && cost > this.cash) {
      // TRA-2301 ask 4 — name the constraint that actually bound instead of
      // asserting a cause. "existing positions consuming cash" was a hardcoded
      // sentence that read the same whether the book held positions or not, and
      // it named the wrong cause on every drifted flat book (bqb1 'Richard':
      // $2,233.91 equity, $325.91 cash, nothing open). Attribute from the book.
      const shortfall = cost - this.cash;
      log.warn('skip signal: insufficient cash for long entry', {
        symbol: signal.symbol,
        signalType: signal.type,
        cost: cost.toFixed(2),
        cash: this.cash.toFixed(2),
        shortfall: shortfall.toFixed(2),
        equity: this.equity.toFixed(2),
        openPositions: this.positions.size,
        committedCapital: this.committedCapital().toFixed(2),
        constraint: this.positions.size > 0
          ? 'open_positions_consuming_cash'
          : 'cash_below_equity_on_a_flat_book',
      });
      return null;
    }

    if (signal.side === 'buy') {
      this.cash -= cost;
    } else {
      // Short proceeds land in cash; the buyback at close subtracts the exit
      // notional. Net cash change over open+close = (entry − exit) × qty, which
      // is the short's P&L — the same figure equity accrues, so the two ledgers
      // stay in lock-step instead of diverging by 2 × pnl per round trip.
      this.cash += cost;
    }
    // TRA-536 — stamp realized vs modeled entry slippage so the Stage-2
    // promotion gate can enforce its realized-≤-1.5×-modeled check. Realized =
    // how far the live fill (`currentPrice`) drifted from the price the
    // strategy intended (`signal.entryPrice`); modeled = the 5 bps per-fill
    // budget the equity backtest charges. Guard against a non-finite signal
    // entry so we never write NaN onto the snapshot.
    const intendedEntry = signal.entryPrice;
    const realizedSlippage = Number.isFinite(intendedEntry)
      ? Math.abs(currentPrice - intendedEntry) * qty
      : undefined;
    const modeledSlippage = realizedSlippage === undefined ? undefined : STOCK_SLIPPAGE_RATE * currentPrice * qty;
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
      ...(realizedSlippage !== undefined ? { realizedSlippage, modeledSlippage } : {}),
    };
    this.positions.set(position.id, position);
    return position;
  }

  /**
   * TRA-954 — conviction DCA scale-in. Add `addQty` shares to an existing open
   * position at `addPrice`, blending the average entry while keeping the
   * original protective stop FIXED — we average *size*, never the *stop* (the
   * classic DCA failure mode of widening the stop "to give it room" is
   * forbidden by the issue's core invariant). The R-cap arithmetic lives in the
   * pure `evaluateEquityDcaAdd` core; this method is just the book mutation.
   *
   * Returns the updated Position, or `null` when the position is absent, the
   * add size/price is non-positive, or available cash can't cover the add.
   */
  addToPosition(positionId: string, addQty: number, addPrice: number): Position | null {
    const pos = this.positions.get(positionId);
    if (!pos) return null;
    if (!Number.isFinite(addQty) || addQty <= 0) return null;
    if (!Number.isFinite(addPrice) || addPrice <= 0) return null;
    const cost = addPrice * addQty;
    // TRA-2301 — same asymmetry as the open path: scaling into a short receives
    // proceeds, so only a long add is gated on spot cash.
    if (pos.side === 'buy' && cost > this.cash) {
      log.warn('skip DCA add: insufficient cash for long add', {
        positionId,
        symbol: pos.symbol,
        cost: cost.toFixed(2),
        cash: this.cash.toFixed(2),
        shortfall: (cost - this.cash).toFixed(2),
        equity: this.equity.toFixed(2),
        openPositions: this.positions.size,
      });
      return null;
    }
    const newQty = pos.quantity + addQty;
    // Blend the average entry; the protective stop is intentionally left as-is.
    pos.entryPrice = (pos.entryPrice * pos.quantity + addPrice * addQty) / newQty;
    pos.quantity = newQty;
    if (pos.side === 'buy') this.cash -= cost;
    else this.cash += cost;
    this.positions.set(positionId, pos);
    return pos;
  }

  checkExits(prices: Map<string, number>, exitRisk?: EquityExitRiskInput): Position[] {
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

      // Hard bracket first — the take-profit target and the initial hard stop
      // are the position's contractual exits and take precedence over the
      // discretionary give-back rules below.
      let exitReason: ExitReason | null = null;
      let exitPrice = price;
      if (pos.side === 'buy') {
        if (price >= pos.takeProfit) { exitReason = 'target'; exitPrice = pos.takeProfit; }
        else if (price <= pos.stopLoss) { exitReason = 'stop'; exitPrice = pos.stopLoss; }
      } else {
        if (price <= pos.takeProfit) { exitReason = 'target'; exitPrice = pos.takeProfit; }
        else if (price >= pos.stopLoss) { exitReason = 'stop'; exitPrice = pos.stopLoss; }
      }

      // TRA-1268 (TRA-1250 Rules 1-2) — when the exit-risk rules are enabled the
      // caller passes a live ATR per symbol. Layer the ATR chandelier trail and
      // the trade-level profit-lock on top of the hard bracket: whichever of
      // {hard stop, chandelier, profit-lock} triggers first exits (the hard TP
      // still wins outright — it's the good outcome). Both fire at the live
      // price. Kept OFF unless `exitRisk` is supplied so demo behaviour is
      // unchanged when the flag is dark.
      if (exitReason !== 'target' && exitRisk) {
        const atr = exitRisk.atrBySymbol.get(pos.symbol);
        if (atr !== undefined && atr > 0) {
          const st = this.exitRiskState.get(id) ?? { extremeSinceEntry: pos.entryPrice };
          st.extremeSinceEntry = pos.side === 'buy'
            ? Math.max(st.extremeSinceEntry, price)
            : Math.min(st.extremeSinceEntry, price);
          const atrPct = exitRisk.atrPctBySymbol?.get(pos.symbol);
          // Rule 1 — ATR chandelier trail (ratchets against the initial hard stop).
          const trail = chandelierStop({
            side: pos.side,
            initialStop: pos.stopLoss,
            extremeSinceEntry: st.extremeSinceEntry,
            atr,
            atrPct,
            prevTrailStop: st.prevTrailStop,
          });
          st.prevTrailStop = trail;
          this.exitRiskState.set(id, st);
          if (exitReason == null && chandelierExitTriggered(pos.side, price, trail)) {
            exitReason = 'chandelier';
            exitPrice = price;
          } else if (exitReason == null) {
            // Rule 2 — trade-level profit-lock give-back cap.
            const lock = profitLockDecision({
              side: pos.side,
              entry: pos.entryPrice,
              initialStop: pos.stopLoss,
              peakPrice: st.extremeSinceEntry,
              currentPrice: price,
            });
            if (lock.shouldExit) {
              exitReason = 'profit_lock';
              exitPrice = price;
            }
          }
        }
      }

      if (exitReason) {
        const multiplier = pos.side === 'buy' ? 1 : -1;
        const pnl = (exitPrice - pos.entryPrice) * pos.quantity * multiplier;
        pos.pnl = pnl;
        pos.exitPrice = exitPrice;
        pos.exitReason = exitReason;
        pos.closedAt = Date.now();
        // TRA-2301 — a long sells out (cash in), a short buys to cover (cash
        // out). Paired with the signed open above, cash moves by exactly `pnl`.
        this.cash += multiplier * exitPrice * pos.quantity;
        this.equity += pnl;
        this.dailyPnl += pnl;
        this.positions.delete(id);
        this.exitRiskState.delete(id);
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
    // TRA-2301 — see checkExits: signed by side so cash moves by exactly `pnl`.
    this.cash += multiplier * currentPrice * pos.quantity;
    this.equity += pnl;
    this.dailyPnl += pnl;
    this.positions.delete(positionId);
    this.exitRiskState.delete(positionId);
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
  exportSnapshot(): PaperAccountSnapshot {
    return {
      cash: this.cash,
      equity: this.equity,
      initialEquity: this.initialEquity,
      dailyPnl: this.dailyPnl,
      openPositions: Array.from(this.positions.values()),
      cashRepair: this.cashRepair,
    };
  }

  /** Restore state previously serialized via exportSnapshot (TRA-140). */
  importSnapshot(snap: PaperAccountSnapshot): void {
    this.cash = snap.cash;
    this.equity = snap.equity;
    this.initialEquity = snap.initialEquity;
    this.dailyPnl = snap.dailyPnl;
    this.positions.clear();
    this.exitRiskState.clear();
    for (const p of snap.openPositions) {
      this.positions.set(p.id, p);
    }
    this.cashRepair = snap.cashRepair ?? null;
    this.repairDriftedCash();
  }

  /**
   * TRA-2301 — one-shot repair of books already drifted by the short-open cash
   * bug. Runs on every restore and is idempotent: a consistent book is left
   * untouched, so once the persisted snapshot has been rewritten post-fix this
   * is a permanent no-op.
   *
   * **Equity is authoritative, cash is the corrupted side.** The two ledgers
   * disagree because the *cash* leg carried the sign error — `equity += pnl`
   * always used the correct `multiplier = -1` for shorts, so equity accrued the
   * right number on every close while cash moved the opposite way. Nothing in
   * this bug's mechanism can bias equity. (The parent TRA-2297 contests the
   * demo equity figure for unrelated reasons — the `optionsDailyPnl` false
   * zeros and the calendar-vs-book-event mismatch. That dispute is about which
   * *events* equity should contain, not about this cash/equity gap, and
   * whichever way it lands the repair below is still the right bridge.)
   *
   * An in-flight short opened under the buggy code is migrated correctly too:
   * its cash was debited `E×Q` where the new model credits it, so the repair
   * moves cash by `2×E×Q` and the subsequent cover settles to the right place.
   */
  private repairDriftedCash(): void {
    const expected = this.expectedCash();
    if (!Number.isFinite(expected)) return;
    const delta = expected - this.cash;
    // One cent — below this it is float residue from accumulated round trips,
    // not the bug, and snapping it would emit a repair record every restart.
    if (Math.abs(delta) < 0.01) return;
    const from = this.cash;
    this.cash = expected;
    this.cashRepair = { appliedAt: Date.now(), delta, from, to: expected };
    log.warn('repaired drifted cash on restore (TRA-2301 short-open cash bug)', {
      from: from.toFixed(2),
      to: expected.toFixed(2),
      delta: delta.toFixed(2),
      equity: this.equity.toFixed(2),
      openPositions: this.positions.size,
      committedCapital: this.committedCapital().toFixed(2),
    });
  }
}
