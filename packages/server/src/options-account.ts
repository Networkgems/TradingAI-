import { randomUUID } from 'crypto';
import type {
  AccountMode,
  TradeSignal,
  OptionPosition,
  OptionsAccountState,
  OtmMispricingSignal,
  OtmRiskParams,
  RelativeValueSignal,
  RvRiskParams,
  TradierEnv,
} from '@trading-app/shared';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  OPTIONS_BUDGET_RATIO,
  OPTIONS_TP1_PCT,
  OPTIONS_SL_PCT,
  OPTIONS_ATM_PREMIUM_RATIO,
  OPTIONS_TRAIL_ACTIVATE_PCT,
  OPTIONS_TRAIL_OFFSET_PCT,
  OPTIONS_PARTIAL_EXIT_RATIO,
  OTM_RISK_PARAMS,
  RV_RISK_PARAMS,
  isValidTradingWindow,
} from '@trading-app/shared';

const ATM_DELTA = 0.50;

function toDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

interface OptionsAccountConfig {
  initialEquity?: number;
  managedAccountRatio?: number;
  /**
   * TRA-233 — Tradier env this paper account belongs to. Stamped onto every
   * opened position so the dashboard / Open Positions view can segregate
   * sandbox vs production state when the user flips `liveTradierEnvOptions`.
   * Optional so existing tests / call sites that don't care about env still
   * compile; absent ↔ legacy sandbox bucket.
   */
  tradierEnv?: TradierEnv;
  /**
   * Max options entries per day across ALL sources — ATM, OTM, and RV
   * combined (TRA-195). Replaces the previously hardcoded `OPTIONS_DAILY_LIMIT`
   * /`OTM_RISK_PARAMS.dailyLimit` / `RV_RISK_PARAMS.dailyLimit` per-source
   * caps so the Settings-page knob is the single source of truth and matches
   * the unified `n/N` badge in the UI.
   */
  optionsDailyTradesLimit?: number;
  /**
   * OTM-specific risk overrides (TRA-160). When omitted, the account uses
   * `OTM_RISK_PARAMS` from `@trading-app/shared`. Tests pass a tweaked bundle
   * to lock in deterministic behaviour without touching the global constants.
   */
  otmRiskParams?: OtmRiskParams;
  /**
   * Relative-value scanner risk overrides (TRA-191). When omitted, the account
   * uses `RV_RISK_PARAMS` from `@trading-app/shared`.
   */
  rvRiskParams?: RvRiskParams;
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
  private optionsDailyTradesLimit: number;
  private otmRiskParams: OtmRiskParams;
  private equity: number;
  private cash: number;
  private openOptions: Map<string, OptionPosition> = new Map();
  private closedOptions: OptionPosition[] = [];
  /**
   * TRA-246 — realized options P&L split per account mode. Replaces the
   * single bucket-wide `optionsPnl` so `getStateForMode('demo')` no longer
   * surfaces P&L accrued by live-mode trades on the Demo dashboard. Every
   * exit path (`checkExits` partial + full close, `closeOption`) attributes
   * its realized P&L to the position's `mode` stamp; positions without a
   * stamp default to 'demo' (mirrors `getStateForMode`'s pre-TRA-231 routing
   * for legacy positions). The total is exposed via `getState().optionsPnl`
   * for consumers (EOD report, PnlTracker) that still need the cross-mode
   * aggregate.
   */
  private optionsPnlByMode: Record<AccountMode, number> = { demo: 0, live: 0 };
  private dailyCount = 0;
  /**
   * Per-source counters retained so the badge `n/N` display can attribute
   * today's entries to ATM / OTM / RV. Since TRA-195 the *gate* is unified —
   * every source path checks the SUM (`dailyOptionsTotal`) against the
   * user-configurable `optionsDailyTradesLimit` rather than its own constant.
   */
  private dailyOtmCount = 0;
  /** TRA-191 — relative-value scanner tickets, counted into the total. */
  private dailyRvCount = 0;
  private rvRiskParams: RvRiskParams;
  private tradierEnv: TradierEnv | null;
  private currentDayKey = toDateKey(Date.now());

  constructor(config: OptionsAccountConfig = {}) {
    this.initialEquity = config.initialEquity ?? DEFAULT_ACCOUNT_SETTINGS.demoEquity;
    this.managedAccountRatio = config.managedAccountRatio ?? DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
    this.optionsDailyTradesLimit = config.optionsDailyTradesLimit ?? DEFAULT_ACCOUNT_SETTINGS.optionsDailyTradesLimit;
    this.otmRiskParams = config.otmRiskParams ?? OTM_RISK_PARAMS;
    this.rvRiskParams = config.rvRiskParams ?? RV_RISK_PARAMS;
    this.tradierEnv = config.tradierEnv ?? null;
    this.equity = this.initialEquity;
    this.cash = this.initialEquity;
  }

  /** TRA-233 — env this paper account stamps onto opened positions. */
  getTradierEnv(): TradierEnv | null {
    return this.tradierEnv;
  }

  reset(config: OptionsAccountConfig = {}): void {
    if (config.initialEquity !== undefined) this.initialEquity = config.initialEquity;
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.optionsDailyTradesLimit !== undefined) this.optionsDailyTradesLimit = config.optionsDailyTradesLimit;
    if (config.otmRiskParams !== undefined) this.otmRiskParams = config.otmRiskParams;
    if (config.rvRiskParams !== undefined) this.rvRiskParams = config.rvRiskParams;
    if (config.tradierEnv !== undefined) this.tradierEnv = config.tradierEnv;
    this.equity = this.initialEquity;
    this.cash = this.initialEquity;
    this.openOptions.clear();
    this.closedOptions = [];
    this.optionsPnlByMode = { demo: 0, live: 0 };
    this.dailyCount = 0;
    this.dailyOtmCount = 0;
    this.dailyRvCount = 0;
    this.currentDayKey = toDateKey(Date.now());
  }

  updateConfig(config: OptionsAccountConfig): void {
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.optionsDailyTradesLimit !== undefined) this.optionsDailyTradesLimit = config.optionsDailyTradesLimit;
    if (config.otmRiskParams !== undefined) this.otmRiskParams = config.otmRiskParams;
    if (config.rvRiskParams !== undefined) this.rvRiskParams = config.rvRiskParams;
  }

  /** Current options daily cap — exposed so the UI can render a count badge. */
  getOptionsDailyTradesLimit(): number {
    return this.optionsDailyTradesLimit;
  }

  /**
   * TRA-195 — unified total options-trades cap. The previous design gated each
   * source (ATM `dailyCount`, OTM `dailyOtmCount`, RV `dailyRvCount`) against a
   * separate constant, which meant changing the user-facing setting only moved
   * the ATM cap while OTM/RV stayed pinned to `OTM_RISK_PARAMS.dailyLimit` /
   * `RV_RISK_PARAMS.dailyLimit`. The active stock-options scanner is RV
   * (TRA-191), so users editing the setting saw no effect. Gating every entry
   * path against the *sum* of the three source counters makes the setting the
   * single source of truth — matches the badge `n/N` display, which already
   * sums those counters.
   */
  private dailyOptionsTotal(): number {
    return this.dailyCount + this.dailyOtmCount + this.dailyRvCount;
  }

  /** Rebase starting equity by the delta, preserving optionsPnl and open/closed positions. */
  applyEquity(newInitialEquity: number): void {
    const delta = newInitialEquity - this.initialEquity;
    if (delta === 0) return;
    this.initialEquity = newInitialEquity;
    this.equity += delta;
    this.cash += delta;
  }

  /** TRA-246 — total realized options P&L across both modes. */
  private totalOptionsPnl(): number {
    return this.optionsPnlByMode.demo + this.optionsPnlByMode.live;
  }

  getState(): OptionsAccountState {
    return {
      openOptions: Array.from(this.openOptions.values()),
      closedOptions: [...this.closedOptions].slice(-20),
      optionsPnl: this.totalOptionsPnl(),
      optionsCash: this.cash,
      dailyOptionsCount: this.dailyCount + this.dailyOtmCount + this.dailyRvCount,
    };
  }

  /**
   * TRA-231 — mode-scoped state. Filters open and closed options to those
   * stamped with the requested mode so the dashboard's Options panel can show
   * only positions opened under the active mode while the bucket internally
   * keeps both halves around (so a flip back restores the other side intact).
   *
   * Legacy positions persisted before TRA-231 have no `mode` stamp; we route
   * them to `demo` because pre-TRA-220 (when paper options first started
   * persisting) the engine only opened paper options in demo.
   *
   * TRA-246 — `optionsPnl` is now also mode-scoped via `optionsPnlByMode`
   * (updated at every exit path). `optionsCash` is forced to 0 in the demo
   * branch because TRA-220 forbids demo from ever opening options, so the
   * bucket-wide cash always equals the live-side cash; surfacing it on the
   * Demo dashboard would mislead a user who flipped Live → Demo into
   * thinking the demo Options account had drawn down its cash.
   */
  getStateForMode(mode: AccountMode): OptionsAccountState {
    const matches = (p: OptionPosition): boolean => (p.mode ?? 'demo') === mode;
    return {
      openOptions: Array.from(this.openOptions.values()).filter(matches),
      closedOptions: this.closedOptions.filter(matches).slice(-20),
      optionsPnl: this.optionsPnlByMode[mode],
      optionsCash: mode === 'demo' ? 0 : this.cash,
      dailyOptionsCount: this.dailyCount + this.dailyOtmCount + this.dailyRvCount,
    };
  }

  private budgetPerTrade(): number {
    return this.equity * this.managedAccountRatio * OPTIONS_BUDGET_RATIO;
  }

  private otmBudgetPerTrade(): number {
    return this.equity * this.managedAccountRatio * this.otmRiskParams.budgetRatio;
  }

  private rvBudgetPerTrade(): number {
    return this.equity * this.managedAccountRatio * this.rvRiskParams.budgetRatio;
  }

  private resetDayIfNeeded(): void {
    const today = toDateKey(Date.now());
    if (today !== this.currentDayKey) {
      this.dailyCount = 0;
      this.dailyOtmCount = 0;
      this.dailyRvCount = 0;
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
  /**
   * TRA-231 — `mode` stamps the opened position with the account mode that
   * fired the trade so the engine can scope the dashboard's Open Positions /
   * Recent Closed Options views per-mode. Optional with a 'demo' default so
   * tests / back-compat callers that don't care about the demo↔live split
   * still compile.
   */
  openOptionFromCandidate(signal: OtmMispricingSignal, mode: AccountMode = 'demo'): OptionPosition | null {
    this.resetDayIfNeeded();

    if (!isValidTradingWindow(Date.now())) return null;
    if (this.dailyOptionsTotal() >= this.optionsDailyTradesLimit) return null;

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
      mode,
      ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
    };

    this.openOptions.set(position.id, position);
    return position;
  }

  /**
   * Open a long contract from a relative-value scanner candidate (TRA-191).
   * Mirrors {@link openOptionFromCandidate} but uses the RV-specific risk
   * bundle (`rvRiskParams`) so cheap-vs-curve tickets get their own SL/TP/
   * trail schedule and don't fight OTM tail trades for daily slots.
   *
   * Returns `null` and consumes nothing when:
   *   • outside a valid trading window
   *   • daily RV cap reached
   *   • a position already exists for the same OCC symbol
   *   • sized contracts ≤ 0 or budget exceeded
   */
  /** TRA-231 — see {@link openOptionFromCandidate} for the `mode` stamp rationale. */
  openOptionFromRvCandidate(signal: RelativeValueSignal, mode: AccountMode = 'demo'): OptionPosition | null {
    this.resetDayIfNeeded();

    if (!isValidTradingWindow(Date.now())) return null;
    if (this.dailyOptionsTotal() >= this.optionsDailyTradesLimit) return null;

    const existing = Array.from(this.openOptions.values()).find(
      o => o.optionSymbol === signal.optionSymbol,
    );
    if (existing) return null;

    const premiumPaid = signal.mark;
    if (!Number.isFinite(premiumPaid) || premiumPaid <= 0) return null;

    const budget = this.rvBudgetPerTrade();
    const costPerContract = premiumPaid * 100;
    const contracts = Math.floor(budget / costPerContract);
    if (contracts <= 0) return null;

    const totalCost = contracts * costPerContract;
    if (totalCost > this.cash) return null;

    this.cash -= totalCost;
    this.dailyRvCount += 1;

    const tp1Premium = premiumPaid * (1 + this.rvRiskParams.tp1Pct);
    const stopLossPremium = premiumPaid * (1 - this.rvRiskParams.slPct);
    const trailActivatePremium = premiumPaid * (1 + this.rvRiskParams.trailActivatePct);

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
      signalType: 'relative_value',
      mode,
      ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
    };

    this.openOptions.set(position.id, position);
    return position;
  }

  /** TRA-231 — see {@link openOptionFromCandidate} for the `mode` stamp rationale. */
  openOption(signal: TradeSignal, underlyingPrice: number, mode: AccountMode = 'demo'): OptionPosition | null {
    this.resetDayIfNeeded();

    // Time filter: only open options during high-volume trading windows
    if (!isValidTradingWindow(Date.now())) return null;

    if (this.dailyOptionsTotal() >= this.optionsDailyTradesLimit) return null;

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
      mode,
      ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
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
    /**
     * TRA-231 — when supplied, skip positions whose `mode` doesn't match. The
     * dashboard hides the inactive mode's positions; we don't want a tick to
     * silently close them out from under the user. Absent stamps default to
     * 'demo' (the only pre-field opener) so legacy snapshots still get the
     * right comparison.
     */
    mode?: AccountMode,
  ): OptionPosition[] {
    const closed: OptionPosition[] = [];

    for (const [id, opt] of this.openOptions) {
      if (mode !== undefined && (opt.mode ?? 'demo') !== mode) continue;
      const liveMark = opt.optionSymbol ? optionMarks?.get(opt.optionSymbol) : undefined;
      let mark: number;
      if (typeof liveMark === 'number' && liveMark > 0) {
        mark = liveMark;
      } else if (opt.signalType === 'otm_mispricing' || opt.signalType === 'relative_value') {
        // OTM and RV positions are mark-driven. Without a fresh chain snapshot
        // we'd have no honest way to update them, so wait for the next tick
        // rather than synthesise a fake mark off the underlying delta.
        continue;
      } else {
        const currentUnderlying = underlyingPrices.get(opt.symbol);
        if (currentUnderlying == null) continue;
        const underlyingMove = currentUnderlying - opt.underlyingEntryPrice;
        const premiumMove = underlyingMove * ATM_DELTA * (opt.optionType === 'call' ? 1 : -1);
        mark = Math.max(0.01, opt.premiumPaid + premiumMove);
      }

      // OTM positions follow the OTM_RISK_PARAMS trail/partial schedule;
      // RV positions follow RV_RISK_PARAMS (TRA-191); ATM legacy paths stay on
      // OPTIONS_* constants so existing behaviour is unchanged for those tickets.
      let trailActivatePct: number;
      let trailOffsetPct: number;
      let partialExitRatio: number;
      if (opt.signalType === 'otm_mispricing') {
        trailActivatePct = this.otmRiskParams.trailActivatePct;
        trailOffsetPct = this.otmRiskParams.trailOffsetPct;
        partialExitRatio = this.otmRiskParams.partialExitRatio;
      } else if (opt.signalType === 'relative_value') {
        trailActivatePct = this.rvRiskParams.trailActivatePct;
        trailOffsetPct = this.rvRiskParams.trailOffsetPct;
        partialExitRatio = this.rvRiskParams.partialExitRatio;
      } else {
        trailActivatePct = OPTIONS_TRAIL_ACTIVATE_PCT;
        trailOffsetPct = OPTIONS_TRAIL_OFFSET_PCT;
        partialExitRatio = OPTIONS_PARTIAL_EXIT_RATIO;
      }

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
          // TRA-246 — attribute realized P&L to the position's mode bucket so
          // the Demo / Live dashboards can show their own running totals.
          this.optionsPnlByMode[opt.mode ?? 'demo'] += partialPnl;
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
        // TRA-246 — see partial-exit comment above; same per-mode attribution.
        this.optionsPnlByMode[opt.mode ?? 'demo'] += pnl;

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
    // TRA-246 — same per-mode attribution as the auto-exit paths above.
    this.optionsPnlByMode[opt.mode ?? 'demo'] += pnl;
    this.openOptions.delete(optionId);
    this.closedOptions.push({ ...opt });
    return { ...opt };
  }

  hasOpenOption(symbol: string): boolean {
    return Array.from(this.openOptions.values()).some(o => o.symbol === symbol);
  }

  /**
   * TRA-219 — drop the in-memory closed-options history. The Options page's
   * "Recent Closed Options" table reads from this list, and we want it cleared
   * after the daily 9 PM ET archive tick. EOD reports already saved to disk
   * still contain each day's closed contracts and feed the Calendar tab's
   * per-date detail view.
   */
  archiveClosedOptions(): number {
    const dropped = this.closedOptions.length;
    this.closedOptions = [];
    return dropped;
  }

  /** Serialize current state for durable storage (TRA-140). */
  exportSnapshot(): {
    openOptions: OptionPosition[];
    closedOptions: OptionPosition[];
    optionsPnl: number;
    /**
     * TRA-246 — per-mode realized P&L. Total equals demo + live and matches
     * `optionsPnl`. Typed `Partial` so the snapshot shape matches the
     * `importSnapshot` parameter (which has to tolerate legacy snapshots
     * missing one or both keys).
     */
    optionsPnlByMode?: Partial<Record<AccountMode, number>>;
    dailyCount: number;
    dailyOtmCount?: number;
    dailyRvCount?: number;
    currentDayKey: string;
    cash: number;
    equity: number;
    /** TRA-233 — env this snapshot belongs to (null for the demo bucket). */
    tradierEnv?: TradierEnv | null;
  } {
    return {
      openOptions: Array.from(this.openOptions.values()),
      closedOptions: [...this.closedOptions],
      optionsPnl: this.totalOptionsPnl(),
      optionsPnlByMode: { ...this.optionsPnlByMode },
      dailyCount: this.dailyCount,
      dailyOtmCount: this.dailyOtmCount,
      dailyRvCount: this.dailyRvCount,
      currentDayKey: this.currentDayKey,
      cash: this.cash,
      equity: this.equity,
      tradierEnv: this.tradierEnv,
    };
  }

  /** Restore state previously serialized via exportSnapshot (TRA-140). */
  importSnapshot(snap: {
    openOptions: OptionPosition[];
    closedOptions: OptionPosition[];
    optionsPnl: number;
    /**
     * TRA-246 — per-mode P&L bucket. Older snapshots only carry the bucket-
     * wide `optionsPnl`; we attribute the legacy total to the `live` bucket
     * because TRA-220 has gated demo from opening options since well before
     * any persisted snapshot would have built up P&L (the post-TRA-237
     * one-shot reset already wiped pre-fix state).
     */
    optionsPnlByMode?: Partial<Record<AccountMode, number>>;
    dailyCount: number;
    /** Added in TRA-160 — older snapshots don't have it; default to 0. */
    dailyOtmCount?: number;
    /** Added in TRA-191 — older snapshots don't have it; default to 0. */
    dailyRvCount?: number;
    currentDayKey: string;
    cash: number;
    equity: number;
  }): void {
    this.openOptions.clear();
    for (const o of snap.openOptions) this.openOptions.set(o.id, o);
    this.closedOptions = [...snap.closedOptions];
    if (snap.optionsPnlByMode) {
      this.optionsPnlByMode = {
        demo: snap.optionsPnlByMode.demo ?? 0,
        live: snap.optionsPnlByMode.live ?? 0,
      };
    } else {
      this.optionsPnlByMode = { demo: 0, live: snap.optionsPnl };
    }
    this.dailyCount = snap.dailyCount;
    this.dailyOtmCount = snap.dailyOtmCount ?? 0;
    this.dailyRvCount = snap.dailyRvCount ?? 0;
    this.currentDayKey = snap.currentDayKey;
    this.cash = snap.cash;
    this.equity = snap.equity;
  }
}
