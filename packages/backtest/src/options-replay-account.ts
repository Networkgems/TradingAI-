/**
 * TRA-376 — Lightweight paper options account used by the chain-replay
 * harness. Mirrors the OTM / RV sizing + exit semantics of the live
 * `PaperOptionsAccount` (`packages/server/src/options-account.ts`) without
 * pulling the server package into the backtest dependency tree (the server
 * already depends on @trading-app/backtest).
 *
 * What we reproduce 1:1 from `PaperOptionsAccount`:
 *   • OTM open path  — budget = equity × managedAccountRatio × OTM.budgetRatio;
 *                      contracts = floor(budget / (mark × 100)); skip-on-0
 *   • RV  open path  — same formula with RV.budgetRatio
 *   • Daily entries cap — sum of OTM + RV counters checked against
 *                          `optionsDailyTradesLimit`
 *   • Exit machinery — partial at TP1, trailing arms at trailActivate,
 *                      tightens to peak × (1 − trailOffset), hard SL at
 *                      premium × (1 − slPct), trail stop breach exits the
 *                      remainder
 *
 * What we add for backtest replay:
 *   • Expiration-day close — when a held contract's expiration is past the
 *     current replay day OR the next-day chain no longer carries the
 *     `optionSymbol`, the position is force-closed at last seen mark (or
 *     intrinsic value if a spot is known on expiration day).
 *
 * Pure / in-memory. No timers, no Tradier I/O.
 */

import type { OptionType, OtmRiskParams, RvRiskParams } from '@trading-app/shared';

const CONTRACT_MULTIPLIER = 100;

export type ReplaySignalType = 'otm_mispricing' | 'relative_value';

export interface ReplayPosition {
  id: string;
  symbol: string;
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  contracts: number;
  contractsRemaining: number;
  premiumPaid: number;
  currentPremium: number;
  tp1Premium: number;
  tp1Hit: boolean;
  stopLossPremium: number;
  peakPremium: number;
  trailingActive: boolean;
  trailingStopPremium: number;
  openedAtDay: string;
  closedAtDay?: string;
  signalType: ReplaySignalType;
  /** Classification stamped from the scanner so the report can hit-rate by it. */
  classification: string;
  /** Total realized P&L over the lifetime of this position (dollars). */
  pnl: number;
  /** Reason the last-closing leg fired. */
  exitReason?: 'tp1_partial' | 'stop_loss' | 'trailing' | 'expired' | 'forced_close';
}

export interface OpenOtmCandidate {
  symbol: string;
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  /** Per-share mark (entry premium). */
  mark: number;
  classification: 'cheap' | 'expensive' | 'fair';
}

export interface OpenRvCandidate {
  symbol: string;
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  mark: number;
  classification: 'cheap' | 'expensive' | 'monotonic_violation' | 'below_intrinsic' | 'fair';
}

export interface OptionsReplayAccountConfig {
  initialEquity: number;
  managedAccountRatio: number;
  optionsDailyTradesLimit: number;
  otmRiskParams: OtmRiskParams;
  rvRiskParams: RvRiskParams;
}

/**
 * Per-day equity curve sample. Recorded once per replay day for max-drawdown
 * and equity-curve plotting.
 */
export interface EquitySample {
  day: string;
  equity: number;
  cash: number;
  openPositions: number;
}

/** Day-keyed counters so the daily cap resets on each new ET trading day. */
function counterKey(day: string): string {
  return day;
}

/**
 * Outcome of an `openOtm` / `openRv` attempt. `zero_size` is the headline
 * TRA-375 finding — sizing collapses to 0 contracts — so the runner counts
 * it separately from a candidate that simply lost a daily-cap slot.
 */
export type OpenOutcome =
  | { reason: 'opened'; position: ReplayPosition }
  | { reason: 'zero_size' | 'daily_cap' | 'duplicate' | 'no_cash' | 'bad_mark'; position: null };

export class OptionsReplayAccount {
  private readonly cfg: OptionsReplayAccountConfig;
  private equity: number;
  private cash: number;
  private idSeq = 0;
  private currentDay: string | null = null;
  private dailyCount = 0;
  private currentDayKey: string | null = null;
  private readonly open = new Map<string, ReplayPosition>();
  private readonly closed: ReplayPosition[] = [];
  private readonly equityCurve: EquitySample[] = [];

  constructor(cfg: OptionsReplayAccountConfig) {
    this.cfg = cfg;
    this.equity = cfg.initialEquity;
    this.cash = cfg.initialEquity;
  }

  /** Roll the day pointer; resets the daily-entries cap so the budget knob behaves like prod. */
  startDay(day: string): void {
    this.currentDay = day;
    if (this.currentDayKey !== counterKey(day)) {
      this.dailyCount = 0;
      this.currentDayKey = counterKey(day);
    }
  }

  /** Snapshot the equity curve for the just-closed day. */
  recordEquityForDay(day: string): void {
    this.equityCurve.push({
      day,
      equity: this.equity,
      cash: this.cash,
      openPositions: this.open.size,
    });
  }

  /** Read-only snapshot of the equity curve. */
  getEquityCurve(): readonly EquitySample[] {
    return this.equityCurve;
  }

  /** Total realized P&L across closed positions. */
  getRealizedPnl(): number {
    return this.equity - this.cfg.initialEquity;
  }

  /** Closed positions are surface for the report (win-rate, hit-rate). */
  getClosedPositions(): readonly ReplayPosition[] {
    return this.closed;
  }

  /** Open positions still on the books — used at the tail of the replay window. */
  getOpenPositions(): readonly ReplayPosition[] {
    return Array.from(this.open.values());
  }

  /** Pricier OTM /  RV sizing matches `PaperOptionsAccount.{otm,rv}BudgetPerTrade`. */
  private budgetFor(signalType: ReplaySignalType): number {
    const ratio = signalType === 'otm_mispricing'
      ? this.cfg.otmRiskParams.budgetRatio
      : this.cfg.rvRiskParams.budgetRatio;
    return this.equity * this.cfg.managedAccountRatio * ratio;
  }

  private hasOpenForSymbol(optionSymbol: string): boolean {
    for (const p of this.open.values()) {
      if (p.optionSymbol === optionSymbol) return true;
    }
    return false;
  }

  /**
   * Open from an OTM candidate. Mirrors `openOptionFromCandidate` — the
   * `OpenOutcome` carries the reason so the runner can count `zero_size`
   * skips (the TRA-375 headline finding) separately from cap / dup skips.
   */
  openOtm(c: OpenOtmCandidate): OpenOutcome {
    if (!this.currentDay) throw new Error('startDay() must be called before openOtm()');
    if (!Number.isFinite(c.mark) || c.mark <= 0) return { reason: 'bad_mark', position: null };
    if (this.hasOpenForSymbol(c.optionSymbol)) return { reason: 'duplicate', position: null };

    const budget = this.budgetFor('otm_mispricing');
    const costPerContract = c.mark * CONTRACT_MULTIPLIER;
    const contracts = Math.floor(budget / costPerContract);
    if (contracts <= 0) return { reason: 'zero_size', position: null };

    // Cap is checked after sizing so a candidate that would never fit doesn't
    // consume a slot — matches the live engine's pre-check ordering intent.
    if (this.dailyCount >= this.cfg.optionsDailyTradesLimit) {
      return { reason: 'daily_cap', position: null };
    }

    const totalCost = contracts * costPerContract;
    if (totalCost > this.cash) return { reason: 'no_cash', position: null };

    this.cash -= totalCost;
    this.dailyCount += 1;

    const r = this.cfg.otmRiskParams;
    const position = this.recordOpen({
      symbol: c.symbol,
      optionSymbol: c.optionSymbol,
      optionType: c.optionType,
      strike: c.strike,
      expiration: c.expiration,
      contracts,
      premiumPaid: c.mark,
      tp1Premium: c.mark * (1 + r.tp1Pct),
      stopLossPremium: c.mark * (1 - r.slPct),
      trailActivatePremium: c.mark * (1 + r.trailActivatePct),
      signalType: 'otm_mispricing',
      classification: c.classification,
    });
    return { reason: 'opened', position };
  }

  /** Mirror of `openOptionFromRvCandidate`. See {@link openOtm} for the outcome rationale. */
  openRv(c: OpenRvCandidate): OpenOutcome {
    if (!this.currentDay) throw new Error('startDay() must be called before openRv()');
    if (!Number.isFinite(c.mark) || c.mark <= 0) return { reason: 'bad_mark', position: null };
    if (this.hasOpenForSymbol(c.optionSymbol)) return { reason: 'duplicate', position: null };

    const budget = this.budgetFor('relative_value');
    const costPerContract = c.mark * CONTRACT_MULTIPLIER;
    const contracts = Math.floor(budget / costPerContract);
    if (contracts <= 0) return { reason: 'zero_size', position: null };

    if (this.dailyCount >= this.cfg.optionsDailyTradesLimit) {
      return { reason: 'daily_cap', position: null };
    }

    const totalCost = contracts * costPerContract;
    if (totalCost > this.cash) return { reason: 'no_cash', position: null };

    this.cash -= totalCost;
    this.dailyCount += 1;

    const r = this.cfg.rvRiskParams;
    const position = this.recordOpen({
      symbol: c.symbol,
      optionSymbol: c.optionSymbol,
      optionType: c.optionType,
      strike: c.strike,
      expiration: c.expiration,
      contracts,
      premiumPaid: c.mark,
      tp1Premium: c.mark * (1 + r.tp1Pct),
      stopLossPremium: c.mark * (1 - r.slPct),
      trailActivatePremium: c.mark * (1 + r.trailActivatePct),
      signalType: 'relative_value',
      classification: c.classification,
    });
    return { reason: 'opened', position };
  }

  private recordOpen(p: {
    symbol: string;
    optionSymbol: string;
    optionType: OptionType;
    strike: number;
    expiration: string;
    contracts: number;
    premiumPaid: number;
    tp1Premium: number;
    stopLossPremium: number;
    trailActivatePremium: number;
    signalType: ReplaySignalType;
    classification: string;
  }): ReplayPosition {
    if (!this.currentDay) throw new Error('startDay() must be called before recordOpen()');
    this.idSeq += 1;
    const position: ReplayPosition = {
      id: `rp-${this.idSeq}`,
      symbol: p.symbol,
      optionSymbol: p.optionSymbol,
      optionType: p.optionType,
      strike: p.strike,
      expiration: p.expiration,
      contracts: p.contracts,
      contractsRemaining: p.contracts,
      premiumPaid: p.premiumPaid,
      currentPremium: p.premiumPaid,
      tp1Premium: p.tp1Premium,
      tp1Hit: false,
      stopLossPremium: p.stopLossPremium,
      peakPremium: p.premiumPaid,
      trailingActive: false,
      trailingStopPremium: p.trailActivatePremium,
      openedAtDay: this.currentDay,
      signalType: p.signalType,
      classification: p.classification,
      pnl: 0,
    };
    this.open.set(position.id, position);
    return position;
  }

  /**
   * Apply a per-OCC mark map to every open position and run the standard
   * partial / SL / trailing logic — exactly mirrors `checkExits` for OTM and
   * RV positions in the live `PaperOptionsAccount`.
   */
  markAndCheckExits(
    day: string,
    marksByOcc: ReadonlyMap<string, number>,
    riskOf: (signalType: ReplaySignalType) => { trailActivatePct: number; trailOffsetPct: number; partialExitRatio: number },
  ): void {
    for (const [id, opt] of this.open) {
      const mark = marksByOcc.get(opt.optionSymbol);
      if (typeof mark !== 'number' || mark <= 0) continue;

      const r = riskOf(opt.signalType);
      opt.currentPremium = mark;
      if (mark > opt.peakPremium) opt.peakPremium = mark;

      if (!opt.trailingActive && mark >= opt.premiumPaid * (1 + r.trailActivatePct)) {
        opt.trailingActive = true;
        opt.trailingStopPremium = opt.peakPremium * (1 - r.trailOffsetPct);
      }
      if (opt.trailingActive) {
        opt.trailingStopPremium = opt.peakPremium * (1 - r.trailOffsetPct);
      }

      // Partial exit at TP1
      if (!opt.tp1Hit && mark >= opt.tp1Premium && opt.contractsRemaining > 1) {
        const exitContracts = Math.floor(opt.contractsRemaining * r.partialExitRatio);
        if (exitContracts > 0) {
          const partialPnl = (mark - opt.premiumPaid) * exitContracts * CONTRACT_MULTIPLIER;
          this.cash += mark * exitContracts * CONTRACT_MULTIPLIER;
          this.equity += partialPnl;
          opt.pnl += partialPnl;
          opt.contractsRemaining -= exitContracts;
          opt.tp1Hit = true;
          opt.trailingActive = true;
          opt.trailingStopPremium = opt.peakPremium * (1 - r.trailOffsetPct);
          opt.exitReason = 'tp1_partial';
        }
      }

      // Full close: hard SL or trailing stop breach.
      let exitPremium: number | null = null;
      let exitReason: ReplayPosition['exitReason'] = opt.exitReason;
      if (mark <= opt.stopLossPremium) {
        exitPremium = opt.stopLossPremium;
        exitReason = 'stop_loss';
      } else if (opt.trailingActive && mark <= opt.trailingStopPremium) {
        exitPremium = opt.trailingStopPremium;
        exitReason = 'trailing';
      }

      if (exitPremium !== null) {
        this.closePosition(id, exitPremium, day, exitReason ?? 'stop_loss');
      }
    }
  }

  /**
   * Day-tail housekeeping: any open contract whose expiration is on/before
   * `day` is force-closed. If a chain row at/under intrinsic exists in
   * `marksByOcc` we use that mark; otherwise the position closes at $0
   * (worthless expiry — typical for OTM that drift to zero).
   */
  expireOrForceCloseDueContracts(day: string, marksByOcc: ReadonlyMap<string, number>): void {
    for (const [id, opt] of this.open) {
      if (opt.expiration > day) continue;
      const finalMark = marksByOcc.get(opt.optionSymbol);
      const exitPremium = typeof finalMark === 'number' && finalMark > 0 ? finalMark : 0;
      this.closePosition(id, exitPremium, day, 'expired');
    }
  }

  /**
   * Close any position whose OCC symbol drops out of the chain snapshot for
   * `lookaheadDays` consecutive days — surrogate for "Tradier no longer
   * reports the contract." Defaults to closing at the last seen mark.
   */
  forceCloseDelisted(day: string, isMissing: (optionSymbol: string) => boolean): void {
    for (const [id, opt] of this.open) {
      if (isMissing(opt.optionSymbol)) {
        this.closePosition(id, opt.currentPremium, day, 'forced_close');
      }
    }
  }

  private closePosition(
    id: string,
    exitPremium: number,
    day: string,
    reason: NonNullable<ReplayPosition['exitReason']>,
  ): void {
    const opt = this.open.get(id);
    if (!opt) return;
    const remaining = opt.contractsRemaining;
    if (remaining > 0) {
      const pnl = (exitPremium - opt.premiumPaid) * remaining * CONTRACT_MULTIPLIER;
      opt.pnl += pnl;
      this.cash += exitPremium * remaining * CONTRACT_MULTIPLIER;
      this.equity += pnl;
      opt.contractsRemaining = 0;
    }
    opt.closedAtDay = day;
    opt.currentPremium = exitPremium;
    opt.exitReason = reason;
    this.open.delete(id);
    this.closed.push({ ...opt });
  }

  /**
   * Tail-close every position still open at the end of the replay window.
   * Used so the final report doesn't leave embedded marked-to-market P&L
   * floating in open positions.
   */
  closeAllOpenAt(day: string, marksByOcc: ReadonlyMap<string, number>): void {
    for (const [id, opt] of this.open) {
      const m = marksByOcc.get(opt.optionSymbol);
      const exit = typeof m === 'number' && m > 0 ? m : opt.currentPremium;
      this.closePosition(id, exit, day, 'forced_close');
    }
  }
}
