import { randomUUID } from 'crypto';
import type { TradeSignal, OptionPosition, OptionsAccountState } from '@trading-app/shared';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  OPTIONS_BUDGET_RATIO,
  OPTIONS_TP1_PCT,
  OPTIONS_SL_PCT,
  OPTIONS_ATM_PREMIUM_RATIO,
  OPTIONS_DAILY_LIMIT,
  OPTIONS_TRAIL_ACTIVATE_PCT,
  OPTIONS_TRAIL_OFFSET_PCT,
  OPTIONS_PARTIAL_EXIT_RATIO,
  isValidTradingWindow,
} from '@trading-app/shared';

const ATM_DELTA = 0.50;

function toDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

interface OptionsAccountConfig {
  initialEquity?: number;
  managedAccountRatio?: number;
  dailyTradesLimit?: number;
}

/**
 * Paper options account — improved per TRA-40:
 *
 *   • SL tightened to −25% (was −35%) for better R:R
 *   • Trailing stop activates at +20% gain (was at TP1 +25%)
 *   • Trail offset tightened to 12% below peak (was 15%)
 *   • Partial exit: 50% of contracts closed at TP1 (+25%); remaining half trailed
 *   • Daily limit reduced to 4 high-quality trades (was 10)
 *   • Time filter: only open options during valid ET trading windows
 */
export class PaperOptionsAccount {
  private initialEquity: number;
  private managedAccountRatio: number;
  private dailyTradesLimit: number;
  private equity: number;
  private cash: number;
  private openOptions: Map<string, OptionPosition> = new Map();
  private closedOptions: OptionPosition[] = [];
  private optionsPnl = 0;
  private dailyCount = 0;
  private currentDayKey = toDateKey(Date.now());

  constructor(config: OptionsAccountConfig = {}) {
    this.initialEquity = config.initialEquity ?? DEFAULT_ACCOUNT_SETTINGS.demoEquity;
    this.managedAccountRatio = config.managedAccountRatio ?? DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
    this.dailyTradesLimit = config.dailyTradesLimit ?? DEFAULT_ACCOUNT_SETTINGS.dailyTradesLimit;
    this.equity = this.initialEquity;
    this.cash = this.initialEquity;
  }

  reset(config: OptionsAccountConfig = {}): void {
    if (config.initialEquity !== undefined) this.initialEquity = config.initialEquity;
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.dailyTradesLimit !== undefined) this.dailyTradesLimit = config.dailyTradesLimit;
    this.equity = this.initialEquity;
    this.cash = this.initialEquity;
    this.openOptions.clear();
    this.closedOptions = [];
    this.optionsPnl = 0;
    this.dailyCount = 0;
    this.currentDayKey = toDateKey(Date.now());
  }

  updateConfig(config: OptionsAccountConfig): void {
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.dailyTradesLimit !== undefined) this.dailyTradesLimit = config.dailyTradesLimit;
  }

  /** Rebase starting equity by the delta, preserving optionsPnl and open/closed positions. */
  applyEquity(newInitialEquity: number): void {
    const delta = newInitialEquity - this.initialEquity;
    if (delta === 0) return;
    this.initialEquity = newInitialEquity;
    this.equity += delta;
    this.cash += delta;
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

  private budgetPerTrade(): number {
    return this.equity * this.managedAccountRatio * OPTIONS_BUDGET_RATIO;
  }

  private resetDayIfNeeded(): void {
    const today = toDateKey(Date.now());
    if (today !== this.currentDayKey) {
      this.dailyCount = 0;
      this.currentDayKey = today;
    }
  }

  openOption(signal: TradeSignal, underlyingPrice: number): OptionPosition | null {
    this.resetDayIfNeeded();

    // Time filter: only open options during high-volume trading windows
    if (!isValidTradingWindow(Date.now())) return null;

    if (this.dailyCount >= OPTIONS_DAILY_LIMIT) return null;

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

    const tp1Premium = premiumPaid * (1 + OPTIONS_TP1_PCT);
    const stopLossPremium = premiumPaid * (1 - OPTIONS_SL_PCT);
    // Trailing activates when position is up 20% (before TP1)
    const trailActivatePremium = premiumPaid * (1 + OPTIONS_TRAIL_ACTIVATE_PCT);

    const position: OptionPosition = {
      id: randomUUID(),
      symbol: signal.symbol,
      optionType,
      contracts,
      contractsRemaining: contracts,
      premiumPaid,
      currentPremium: premiumPaid,
      tp1Premium,
      tp1Hit: false,
      stopLossPremium,
      peakPremium: premiumPaid,
      trailingActive: false,
      // Store trailActivatePremium in trailingStopPremium until trailing is engaged
      trailingStopPremium: trailActivatePremium,
      underlyingEntryPrice: underlyingPrice,
      openedAt: Date.now(),
      signalId: signal.id,
      signalType: signal.type,
    };

    this.openOptions.set(position.id, position);
    return position;
  }

  /**
   * Update mark prices and handle exits:
   *   1. Partial exit (50% contracts) when premium hits TP1 (+25%)
   *   2. Trailing stop activates at +20% gain; trails 12% below peak
   *   3. Full exit when hard SL (−25%) or trailing stop is breached
   */
  checkExits(underlyingPrices: Map<string, number>): OptionPosition[] {
    const closed: OptionPosition[] = [];

    for (const [id, opt] of this.openOptions) {
      const currentUnderlying = underlyingPrices.get(opt.symbol);
      if (currentUnderlying == null) continue;

      const underlyingMove = currentUnderlying - opt.underlyingEntryPrice;
      const premiumMove = underlyingMove * ATM_DELTA * (opt.optionType === 'call' ? 1 : -1);
      const mark = Math.max(0.01, opt.premiumPaid + premiumMove);
      opt.currentPremium = mark;

      if (mark > opt.peakPremium) opt.peakPremium = mark;

      // Activate trailing once position reaches +20% gain
      if (!opt.trailingActive && mark >= opt.premiumPaid * (1 + OPTIONS_TRAIL_ACTIVATE_PCT)) {
        opt.trailingActive = true;
        opt.trailingStopPremium = opt.peakPremium * (1 - OPTIONS_TRAIL_OFFSET_PCT);
      }

      // Keep trailing stop updated at 12% below peak while active
      if (opt.trailingActive) {
        opt.trailingStopPremium = opt.peakPremium * (1 - OPTIONS_TRAIL_OFFSET_PCT);
      }

      // Partial exit at TP1 (+25%): sell half the contracts, trail the rest
      if (!opt.tp1Hit && mark >= opt.tp1Premium && opt.contractsRemaining > 1) {
        const exitContracts = Math.floor(opt.contractsRemaining * OPTIONS_PARTIAL_EXIT_RATIO);
        if (exitContracts > 0) {
          const partialPnl = (mark - opt.premiumPaid) * exitContracts * 100;
          this.cash += mark * exitContracts * 100;
          this.equity += partialPnl;
          this.optionsPnl += partialPnl;
          opt.contractsRemaining -= exitContracts;
          opt.tp1Hit = true;
          // After partial exit, trailing is engaged on the remainder
          opt.trailingActive = true;
          opt.trailingStopPremium = opt.peakPremium * (1 - OPTIONS_TRAIL_OFFSET_PCT);
        }
      }

      // Determine full exit: hard SL or trailing stop breach
      let exitPremium: number | null = null;

      if (mark <= opt.stopLossPremium) {
        exitPremium = opt.stopLossPremium;
      } else if (opt.trailingActive && mark <= opt.trailingStopPremium) {
        exitPremium = opt.trailingStopPremium;
      }

      if (exitPremium !== null) {
        const remainingContracts = opt.contractsRemaining;
        const pnl = (exitPremium - opt.premiumPaid) * remainingContracts * 100;
        opt.pnl = (opt.pnl ?? 0) + pnl;
        opt.closedAt = Date.now();
        opt.currentPremium = exitPremium;
        opt.contractsRemaining = 0;

        this.cash += exitPremium * remainingContracts * 100;
        this.equity += pnl;
        this.optionsPnl += pnl;

        this.openOptions.delete(id);
        this.closedOptions.push({ ...opt });
        closed.push({ ...opt });
      }
    }

    return closed;
  }

  closeOption(optionId: string): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt) return null;
    const mark = opt.currentPremium;
    const remainingContracts = opt.contractsRemaining;
    const pnl = (mark - opt.premiumPaid) * remainingContracts * 100;
    opt.pnl = (opt.pnl ?? 0) + pnl;
    opt.closedAt = Date.now();
    opt.contractsRemaining = 0;
    this.cash += mark * remainingContracts * 100;
    this.equity += pnl;
    this.optionsPnl += pnl;
    this.openOptions.delete(optionId);
    this.closedOptions.push({ ...opt });
    return { ...opt };
  }

  hasOpenOption(symbol: string): boolean {
    return Array.from(this.openOptions.values()).some(o => o.symbol === symbol);
  }
}
