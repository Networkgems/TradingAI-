import { randomUUID } from 'crypto';
import type { TradeSignal, OptionPosition, OptionsAccountState } from '@trading-app/shared';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  OPTIONS_BUDGET_RATIO,
  OPTIONS_TP_PCT,
  OPTIONS_SL_PCT,
  OPTIONS_ATM_PREMIUM_RATIO,
  OPTIONS_TRAIL_OFFSET_PCT,
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

    if (this.dailyCount >= this.dailyTradesLimit) return null;

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
      trailingStopPremium: stopLossPremium,
      underlyingEntryPrice: underlyingPrice,
      openedAt: Date.now(),
      signalId: signal.id,
      signalType: signal.type,
    };

    this.openOptions.set(position.id, position);
    return position;
  }

  checkExits(underlyingPrices: Map<string, number>): OptionPosition[] {
    const closed: OptionPosition[] = [];

    for (const [id, opt] of this.openOptions) {
      const currentUnderlying = underlyingPrices.get(opt.symbol);
      if (currentUnderlying == null) continue;

      const underlyingMove = currentUnderlying - opt.underlyingEntryPrice;
      const premiumMove = underlyingMove * ATM_DELTA * (opt.optionType === 'call' ? 1 : -1);
      const mark = Math.max(0.01, opt.premiumPaid + premiumMove);
      opt.currentPremium = mark;

      if (mark > opt.peakPremium) {
        opt.peakPremium = mark;
      }

      if (!opt.trailingActive && mark >= opt.takeProfitPremium) {
        opt.trailingActive = true;
      }

      if (opt.trailingActive) {
        opt.trailingStopPremium = opt.peakPremium * (1 - OPTIONS_TRAIL_OFFSET_PCT);
      }

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
