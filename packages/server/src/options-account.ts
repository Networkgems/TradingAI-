import { randomUUID } from 'crypto';
import type { TradeSignal, OptionPosition, OptionsAccountState } from '@trading-app/shared';
import {
  MANAGED_ACCOUNT_RATIO,
  OPTIONS_BUDGET_RATIO,
  OPTIONS_TP_PCT,
  OPTIONS_SL_PCT,
  OPTIONS_ATM_PREMIUM_RATIO,
  OPTIONS_DAILY_LIMIT,
  OPTIONS_TRAIL_OFFSET_PCT,
} from '@trading-app/shared';

const INITIAL_EQUITY = 25_000;
// ATM option delta approximation: $0.50 move per $1 move in underlying
const ATM_DELTA = 0.50;

function toDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

export class PaperOptionsAccount {
  private equity: number;
  private cash: number;
  private openOptions: Map<string, OptionPosition> = new Map();
  private closedOptions: OptionPosition[] = [];
  private optionsPnl: number;
  private dailyCount = 0;
  private currentDayKey = toDateKey(Date.now());

  constructor(savedEquity = INITIAL_EQUITY, savedOptionsPnl = 0) {
    this.equity = savedEquity;
    this.cash = savedEquity;
    this.optionsPnl = savedOptionsPnl;
  }

  getState(): OptionsAccountState {
    return {
      openOptions: Array.from(this.openOptions.values()),
      closedOptions: [...this.closedOptions].slice(-20),
      optionsPnl: this.optionsPnl,
      optionsCash: this.cash,
      dailyOptionsCount: this.dailyCount,
    };
  }

  getEquity(): number {
    return this.equity;
  }

  getOptionsPnl(): number {
    return this.optionsPnl;
  }

  private budgetPerTrade(): number {
    return this.equity * MANAGED_ACCOUNT_RATIO * OPTIONS_BUDGET_RATIO;
  }

  private resetDayIfNeeded(): void {
    const today = toDateKey(Date.now());
    if (today !== this.currentDayKey) {
      this.dailyCount = 0;
      this.currentDayKey = today;
    }
  }

  /** Open a paper option position for the given signal. */
  openOption(signal: TradeSignal, underlyingPrice: number): OptionPosition | null {
    this.resetDayIfNeeded();

    // Enforce daily trade limit (5 options per day)
    if (this.dailyCount >= OPTIONS_DAILY_LIMIT) return null;

    // Already have an open option on this symbol from this signal type
    const existing = Array.from(this.openOptions.values()).find(
      o => o.symbol === signal.symbol && o.signalType === signal.type,
    );
    if (existing) return null;

    const optionType = signal.side === 'buy' ? 'call' : 'put';
    const premiumPaid = underlyingPrice * OPTIONS_ATM_PREMIUM_RATIO;
    if (premiumPaid <= 0) return null;

    const budget = this.budgetPerTrade();
    const costPerContract = premiumPaid * 100;
    const contracts = Math.floor(budget / costPerContract);
    if (contracts <= 0) return null;

    const totalCost = contracts * costPerContract;
    if (totalCost > this.cash) return null;

    this.cash -= totalCost;
    this.dailyCount += 1;

    const takeProfitPremium = premiumPaid * (1 + OPTIONS_TP_PCT);
    const stopLossPremium = premiumPaid * (1 - OPTIONS_SL_PCT);

    const position: OptionPosition = {
      id: randomUUID(),
      symbol: signal.symbol,
      optionType,
      contracts,
      premiumPaid,
      currentPremium: premiumPaid,
      takeProfitPremium,
      stopLossPremium,
      peakPremium: premiumPaid,
      trailingActive: false,
      trailingStopPremium: stopLossPremium, // initially same as hard SL
      underlyingEntryPrice: underlyingPrice,
      openedAt: Date.now(),
      signalId: signal.id,
      signalType: signal.type,
    };

    this.openOptions.set(position.id, position);
    return position;
  }

  /** Update mark prices, activate trailing stops at TP, and close on SL or trail stop. */
  checkExits(underlyingPrices: Map<string, number>): OptionPosition[] {
    const closed: OptionPosition[] = [];

    for (const [id, opt] of this.openOptions) {
      const currentUnderlying = underlyingPrices.get(opt.symbol);
      if (currentUnderlying == null) continue;

      // Estimate current premium using delta approximation
      const underlyingMove = currentUnderlying - opt.underlyingEntryPrice;
      const premiumMove = underlyingMove * ATM_DELTA * (opt.optionType === 'call' ? 1 : -1);
      const mark = Math.max(0.01, opt.premiumPaid + premiumMove);
      opt.currentPremium = mark;

      // Track peak premium for trailing stop
      if (mark > opt.peakPremium) {
        opt.peakPremium = mark;
      }

      // Activate trailing mode once TP (+25%) is first hit
      if (!opt.trailingActive && mark >= opt.takeProfitPremium) {
        opt.trailingActive = true;
      }

      // Keep trailing stop updated at 15% below peak
      if (opt.trailingActive) {
        opt.trailingStopPremium = opt.peakPremium * (1 - OPTIONS_TRAIL_OFFSET_PCT);
      }

      // Determine exit: hard SL at -35% or trailing stop when momentum stalls
      let exitPremium: number | null = null;

      if (mark <= opt.stopLossPremium) {
        exitPremium = opt.stopLossPremium;
      } else if (opt.trailingActive && mark <= opt.trailingStopPremium) {
        exitPremium = opt.trailingStopPremium;
      }

      if (exitPremium !== null) {
        const pnl = (exitPremium - opt.premiumPaid) * opt.contracts * 100;
        opt.pnl = pnl;
        opt.closedAt = Date.now();
        opt.currentPremium = exitPremium;

        this.cash += exitPremium * opt.contracts * 100;
        this.equity += pnl;
        this.optionsPnl += pnl;

        this.openOptions.delete(id);
        this.closedOptions.push({ ...opt });
        closed.push({ ...opt });
      }
    }

    return closed;
  }

  hasOpenOption(symbol: string): boolean {
    return Array.from(this.openOptions.values()).some(o => o.symbol === symbol);
  }
}
