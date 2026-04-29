import { randomUUID } from 'crypto';
import type { TradeSignal, OptionPosition, OptionsAccountState, OtmMispricingSignal, OtmRiskParams } from '@trading-app/shared';
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
  OTM_RISK_PARAMS,
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
  /**
   * OTM-specific risk overrides (TRA-160). When omitted, the account uses
   * `OTM_RISK_PARAMS` from `@trading-app/shared`. Tests pass a tweaked bundle
   * to lock in deterministic behaviour without touching the global constants.
   */
  otmRiskParams?: OtmRiskParams;
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
  private otmRiskParams: OtmRiskParams;
  private equity: number;
  private cash: number;
  private openOptions: Map<string, OptionPosition> = new Map();
  private closedOptions: OptionPosition[] = [];
  private optionsPnl = 0;
  private dailyCount = 0;
  /**
   * OTM tickets are counted separately so OTM and ATM don't compete for the
   * same daily slot pool (TRA-160). `dailyCount` keeps tracking ATM entries
   * for backward-compat with the `OPTIONS_DAILY_LIMIT` cap.
   */
  private dailyOtmCount = 0;
  private currentDayKey = toDateKey(Date.now());

  constructor(config: OptionsAccountConfig = {}) {
    this.initialEquity = config.initialEquity ?? DEFAULT_ACCOUNT_SETTINGS.demoEquity;
    this.managedAccountRatio = config.managedAccountRatio ?? DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
    this.dailyTradesLimit = config.dailyTradesLimit ?? DEFAULT_ACCOUNT_SETTINGS.dailyTradesLimit;
    this.otmRiskParams = config.otmRiskParams ?? OTM_RISK_PARAMS;
    this.equity = this.initialEquity;
    this.cash = this.initialEquity;
  }

  reset(config: OptionsAccountConfig = {}): void {
    if (config.initialEquity !== undefined) this.initialEquity = config.initialEquity;
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.dailyTradesLimit !== undefined) this.dailyTradesLimit = config.dailyTradesLimit;
    if (config.otmRiskParams !== undefined) this.otmRiskParams = config.otmRiskParams;
    this.equity = this.initialEquity;
    this.cash = this.initialEquity;
    this.openOptions.clear();
    this.closedOptions = [];
    this.optionsPnl = 0;
    this.dailyCount = 0;
    this.dailyOtmCount = 0;
    this.currentDayKey = toDateKey(Date.now());
  }

  updateConfig(config: OptionsAccountConfig): void {
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.dailyTradesLimit !== undefined) this.dailyTradesLimit = config.dailyTradesLimit;
    if (config.otmRiskParams !== undefined) this.otmRiskParams = config.otmRiskParams;
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
      dailyOptionsCount: this.dailyCount + this.dailyOtmCount,
    };
  }

  private budgetPerTrade(): number {
    return this.equity * this.managedAccountRatio * OPTIONS_BUDGET_RATIO;
  }

  private otmBudgetPerTrade(): number {
    return this.equity * this.managedAccountRatio * this.otmRiskParams.budgetRatio;
  }

  private resetDayIfNeeded(): void {
    const today = toDateKey(Date.now());
    if (today !== this.currentDayKey) {
      this.dailyCount = 0;
      this.dailyOtmCount = 0;
      this.currentDayKey = today;
    }
  }

  /**
   * Open an OTM contract from a scanner candidate (TRA-159, long-only path).
   *
   * Differs from {@link openOption} in two ways:
   *   • Per-contract entry premium = `signal.mark * 100` (the actual chain mid)
   *     rather than the 2%-of-spot ATM heuristic.
   *   • The position is stickered with the OCC `optionSymbol`, `strike`, and
   *     `expiration` so the engine's mark-refresh path can look the contract
   *     up in the cached chain snapshot instead of extrapolating off the
   *     underlying.
   *
   * Returns `null` and consumes nothing when sized contracts ≤ 0, when the
   * trading window or daily limit blocks entry, or when an open position for
   * the same `optionSymbol` already exists.
   */
  openOptionFromCandidate(signal: OtmMispricingSignal): OptionPosition | null {
    this.resetDayIfNeeded();

    if (!isValidTradingWindow(Date.now())) return null;
    if (this.dailyOtmCount >= this.otmRiskParams.dailyLimit) return null;

    // Dedup by OCC symbol — one open contract at a time per strike/expiration.
    const existing = Array.from(this.openOptions.values()).find(
      o => o.optionSymbol === signal.optionSymbol,
    );
    if (existing) return null;

    const premiumPaid = signal.mark;
    if (!Number.isFinite(premiumPaid) || premiumPaid <= 0) return null;

    const budget = this.otmBudgetPerTrade();
    const costPerContract = premiumPaid * 100;
    const contracts = Math.floor(budget / costPerContract);
    if (contracts <= 0) return null;

    const totalCost = contracts * costPerContract;
    if (totalCost > this.cash) return null;

    this.cash -= totalCost;
    this.dailyOtmCount += 1;

    const tp1Premium = premiumPaid * (1 + this.otmRiskParams.tp1Pct);
    const stopLossPremium = premiumPaid * (1 - this.otmRiskParams.slPct);
    const trailActivatePremium = premiumPaid * (1 + this.otmRiskParams.trailActivatePct);

    const position: OptionPosition = {
      id: randomUUID(),
      symbol: signal.symbol,
      optionSymbol: signal.optionSymbol,
      optionType: signal.optionType,
      strike: signal.strike,
      expiration: signal.expiration,
      contracts,
      contractsRemaining: contracts,
      premiumPaid,
      currentPremium: premiumPaid,
      tp1Premium,
      tp1Hit: false,
      stopLossPremium,
      peakPremium: premiumPaid,
      trailingActive: false,
      trailingStopPremium: trailActivatePremium,
      underlyingEntryPrice: signal.entryPrice,
      openedAt: Date.now(),
      signalId: signal.id,
      signalType: 'otm_mispricing',
    };

    this.openOptions.set(position.id, position);
    return position;
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
   *
   * `optionMarks` (TRA-159) supplies live per-share marks keyed by OCC symbol
   * — when present for a position with `optionSymbol`, that mark is used
   * directly instead of extrapolating off the underlying with a fixed delta.
   * Positions opened from the OTM scanner (`signalType === 'otm_mispricing'`)
   * REQUIRE a fresh mark to evaluate exits; if the chain wasn't fetched this
   * tick the position is skipped (next tick gets it). ATM positions opened
   * from `openOption` keep the existing delta-extrapolation fallback.
   */
  checkExits(
    underlyingPrices: Map<string, number>,
    optionMarks?: Map<string, number>,
  ): OptionPosition[] {
    const closed: OptionPosition[] = [];

    for (const [id, opt] of this.openOptions) {
      const liveMark = opt.optionSymbol ? optionMarks?.get(opt.optionSymbol) : undefined;
      let mark: number;
      if (typeof liveMark === 'number' && liveMark > 0) {
        mark = liveMark;
      } else if (opt.signalType === 'otm_mispricing') {
        // OTM positions are mark-driven. Without a fresh chain snapshot we'd
        // have no honest way to update them, so wait for the next tick rather
        // than synthesise a fake mark off the underlying delta.
        continue;
      } else {
        const currentUnderlying = underlyingPrices.get(opt.symbol);
        if (currentUnderlying == null) continue;
        const underlyingMove = currentUnderlying - opt.underlyingEntryPrice;
        const premiumMove = underlyingMove * ATM_DELTA * (opt.optionType === 'call' ? 1 : -1);
        mark = Math.max(0.01, opt.premiumPaid + premiumMove);
      }

      // OTM positions follow the OTM_RISK_PARAMS trail/partial schedule;
      // ATM legacy paths stay on OPTIONS_* constants so existing behaviour
      // is unchanged for non-OTM tickets.
      const isOtm = opt.signalType === 'otm_mispricing';
      const trailActivatePct = isOtm ? this.otmRiskParams.trailActivatePct : OPTIONS_TRAIL_ACTIVATE_PCT;
      const trailOffsetPct = isOtm ? this.otmRiskParams.trailOffsetPct : OPTIONS_TRAIL_OFFSET_PCT;
      const partialExitRatio = isOtm ? this.otmRiskParams.partialExitRatio : OPTIONS_PARTIAL_EXIT_RATIO;

      opt.currentPremium = mark;

      if (mark > opt.peakPremium) opt.peakPremium = mark;

      // Activate trailing once position reaches the per-strategy threshold.
      if (!opt.trailingActive && mark >= opt.premiumPaid * (1 + trailActivatePct)) {
        opt.trailingActive = true;
        opt.trailingStopPremium = opt.peakPremium * (1 - trailOffsetPct);
      }

      if (opt.trailingActive) {
        opt.trailingStopPremium = opt.peakPremium * (1 - trailOffsetPct);
      }

      // Partial exit at TP1: sell `partialExitRatio` of contracts, trail the rest
      if (!opt.tp1Hit && mark >= opt.tp1Premium && opt.contractsRemaining > 1) {
        const exitContracts = Math.floor(opt.contractsRemaining * partialExitRatio);
        if (exitContracts > 0) {
          const partialPnl = (mark - opt.premiumPaid) * exitContracts * 100;
          this.cash += mark * exitContracts * 100;
          this.equity += partialPnl;
          this.optionsPnl += partialPnl;
          opt.contractsRemaining -= exitContracts;
          opt.tp1Hit = true;
          // After partial exit, trailing is engaged on the remainder
          opt.trailingActive = true;
          opt.trailingStopPremium = opt.peakPremium * (1 - trailOffsetPct);
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

  /** Serialize current state for durable storage (TRA-140). */
  exportSnapshot(): {
    openOptions: OptionPosition[];
    closedOptions: OptionPosition[];
    optionsPnl: number;
    dailyCount: number;
    dailyOtmCount?: number;
    currentDayKey: string;
    cash: number;
    equity: number;
  } {
    return {
      openOptions: Array.from(this.openOptions.values()),
      closedOptions: [...this.closedOptions],
      optionsPnl: this.optionsPnl,
      dailyCount: this.dailyCount,
      dailyOtmCount: this.dailyOtmCount,
      currentDayKey: this.currentDayKey,
      cash: this.cash,
      equity: this.equity,
    };
  }

  /** Restore state previously serialized via exportSnapshot (TRA-140). */
  importSnapshot(snap: {
    openOptions: OptionPosition[];
    closedOptions: OptionPosition[];
    optionsPnl: number;
    dailyCount: number;
    /** Added in TRA-160 — older snapshots don't have it; default to 0. */
    dailyOtmCount?: number;
    currentDayKey: string;
    cash: number;
    equity: number;
  }): void {
    this.openOptions.clear();
    for (const o of snap.openOptions) this.openOptions.set(o.id, o);
    this.closedOptions = [...snap.closedOptions];
    this.optionsPnl = snap.optionsPnl;
    this.dailyCount = snap.dailyCount;
    this.dailyOtmCount = snap.dailyOtmCount ?? 0;
    this.currentDayKey = snap.currentDayKey;
    this.cash = snap.cash;
    this.equity = snap.equity;
  }
}
