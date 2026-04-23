import { randomUUID } from 'crypto';
import type { TradeSignal, OptionPosition, OptionsAccountState } from '@trading-app/shared';
import {
  MANAGED_ACCOUNT_RATIO,
  OPTIONS_BUDGET_RATIO,
  OPTIONS_TP_PCT,
  OPTIONS_SL_PCT,
  OPTIONS_ATM_PREMIUM_RATIO,
} from '@trading-app/shared';

const INITIAL_EQUITY = 25_000;
// ATM option delta approximation: $0.50 move per $1 move in underlying
const ATM_DELTA = 0.50;

export class PaperOptionsAccount {
  private equity = INITIAL_EQUITY;
  private cash = INITIAL_EQUITY;
  private openOptions: Map<string, OptionPosition> = new Map();
  private closedOptions: OptionPosition[] = [];
  private optionsPnl = 0;

  getState(): OptionsAccountState {
    return {
      openOptions: Array.from(this.openOptions.values()),
      closedOptions: [...this.closedOptions].slice(-20),
      optionsPnl: this.optionsPnl,
      optionsCash: this.cash,
    };
  }

  private budgetPerTrade(): number {
    return this.equity * MANAGED_ACCOUNT_RATIO * OPTIONS_BUDGET_RATIO;
  }

  /** Open a paper option position for the given signal. */
  openOption(signal: TradeSignal, underlyingPrice: number): OptionPosition | null {
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
      underlyingEntryPrice: underlyingPrice,
      openedAt: Date.now(),
      signalId: signal.id,
      signalType: signal.type,
    };

    this.openOptions.set(position.id, position);
    return position;
  }

  /** Update mark prices and close any positions that hit TP or SL. */
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

      let hit: 'tp' | 'sl' | null = null;
      if (mark >= opt.takeProfitPremium) hit = 'tp';
      else if (mark <= opt.stopLossPremium) hit = 'sl';

      if (hit) {
        const exitPremium = hit === 'tp' ? opt.takeProfitPremium : opt.stopLossPremium;
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
