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

import type { OptionLeg, OptionType, OtmRiskParams, RvRiskParams } from '@trading-app/shared';

const CONTRACT_MULTIPLIER = 100;

/**
 * TRA-918 — the four TRA-911 Phase-A signal structures get mid-life management
 * (50%-profit take / credit stop / 21-DTE time stop) via
 * {@link OptionsReplayAccount.markAndManageSpreads}. The two TRA-800 structures
 * (`put_write` / `call_debit_spread`) are deliberately NOT in this set — they
 * stay on the hold-to-expiry {@link OptionsReplayAccount.settleSpreads} path so
 * the existing TRA-800 replay behaviour is unchanged.
 */
const MANAGED_SPREAD_STRATEGIES: ReadonlySet<ReplaySpreadStrategy> = new Set([
  'bull_put_spread',
  'bear_call_spread',
  'iron_condor',
  'debit_spread',
]);

/** TRA-918 (plan §1.6) — mid-life spread-management thresholds. All sweepable. */
export interface SpreadManagementParams {
  /** Take profit at this fraction of max profit (default 0.5 — the 50% rule). */
  takeProfitFraction: number;
  /** Credit-structure stop: close when spread mark ≥ this × entry credit (default 2). */
  creditStopMultiple: number;
  /** Debit-structure stop: close when this fraction of the debit is lost (default 0.5). */
  debitStopLossFraction: number;
  /** Close (no roll) at/under this DTE if neither TP nor stop fired (default 21). */
  timeStopDte: number;
}

export const DEFAULT_SPREAD_MANAGEMENT: SpreadManagementParams = {
  takeProfitFraction: 0.5,
  creditStopMultiple: 2,
  debitStopLossFraction: 0.5,
  timeStopDte: 21,
};

/**
 * Whole calendar days from `now` (ms) to an expiration date (UTC midnight).
 * Local copy so the account does not depend on `options-replay-structures.ts`
 * (which already depends on this module — importing back would cycle).
 */
function comboDteDays(expiration: string, now: number): number {
  const expMs = Date.parse(`${expiration}T00:00:00Z`);
  if (!Number.isFinite(expMs)) return Number.NEGATIVE_INFINITY;
  return Math.floor((expMs - now) / 86_400_000);
}

/**
 * TRA-800 — the structures the replay engine can model. The two single-leg
 * scanner sources (`otm_mispricing` / `relative_value`) are managed per-tick by
 * {@link OptionsReplayAccount.markAndCheckExits}; the two defined-risk
 * structures (`put_write` / `call_debit_spread`) are entered as one combo row
 * via {@link OptionsReplayAccount.openSpread}, held to expiry, and settled at
 * their defined-risk payoff by {@link OptionsReplayAccount.settleSpreads} —
 * exactly mirroring the live `PaperOptionsAccount.openDefinedRiskSpread`
 * (combos are skipped by `checkExits` server-side and booked off the capped
 * worst-case basis at close/expiry).
 */
export type ReplaySignalType =
  | 'otm_mispricing'
  | 'relative_value'
  | ReplaySpreadStrategy;

/**
 * The defined-risk structure ids the replay can enter as a combo (a strict
 * subset of {@link ReplaySignalType}).
 *
 *   • TRA-800 — `put_write` / `call_debit_spread` (the OTM/RV scanner-fed
 *     structures, held to expiry).
 *   • TRA-918 (TRA-908 Phase D) — the four TRA-911 Phase-A signal structures
 *     (`bull_put_spread`, `bear_call_spread`, `iron_condor`, `debit_spread`),
 *     entered from a `ShadowOptionSignal` and managed mid-life by
 *     {@link OptionsReplayAccount.markAndManageSpreads} (50%-profit take, credit
 *     stop, 21-DTE time stop) rather than held to expiry.
 */
export type ReplaySpreadStrategy =
  | 'put_write'
  | 'call_debit_spread'
  | 'bull_put_spread'
  | 'bear_call_spread'
  | 'iron_condor'
  | 'debit_spread';

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
  exitReason?:
    | 'tp1_partial'
    | 'stop_loss'
    | 'trailing'
    | 'expired'
    | 'forced_close'
    | 'settled'
    // TRA-918 — Phase-D mid-life spread management exits.
    | 'take_profit'
    | 'time_stop';
  // ── TRA-800 — defined-risk combo payload (only set when `signalType` is a
  //    spread). Per-1-lot figures so {@link settleSpreads} can compute the
  //    payoff then scale by `contracts`; mirrors the live combo's `legs` /
  //    `netUsd` / `maxLossUsd` / `maxProfitUsd` / `breakevens`.
  /** True for the two defined-risk structures (combo, held to expiry). */
  isCombo?: boolean;
  /** The full modeled structure (1 leg for put-write, 2 for the call debit spread). */
  legs?: OptionLeg[];
  /** + credit / − debit at entry, USD per 1-lot. */
  netUsdPerLot?: number;
  /** Capped capital-at-risk, USD per 1-lot. */
  maxLossPerLot?: number;
  /** Capped max profit, USD per 1-lot. */
  maxProfitPerLot?: number;
  /** Payoff breakeven underlying price(s). */
  breakevens?: number[];
  /** Structure id, e.g. `put_write` / `call_debit_spread`. */
  spreadStrategy?: ReplaySpreadStrategy;
  /**
   * TRA-918 — total modeled slippage + commission charged at entry for this
   * position (dollars, across all lots). Recorded so the report can publish a
   * modeled-slippage figure against which forward paper `slippageRatio` is
   * computed once real paper data exists.
   */
  modeledSlippage?: number;
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

/**
 * TRA-800 — open a defined-risk structure as one combo row. Mirrors the
 * `params` object of the live `PaperOptionsAccount.openDefinedRiskSpread`: the
 * whole structure is sized off its capped per-lot capital-at-risk
 * (`maxLossUsd`), entered for a uniform reserved-capital debit regardless of
 * net credit / debit. All dollar figures are per 1-lot (×100).
 */
export interface OpenSpreadCandidate {
  symbol: string;
  strategy: ReplaySpreadStrategy;
  legs: OptionLeg[];
  /** + credit / − debit, USD per 1-lot. */
  netUsd: number;
  /** Capped capital-at-risk, USD per 1-lot. */
  maxLossUsd: number;
  /** Capped max profit, USD per 1-lot. */
  maxProfitUsd: number;
  breakevens: number[];
  expiration: string;
  /** Underlying spot at entry (recorded for the report; not used for cash). */
  spot: number;
  /** Stamped onto the position so the report can hit-rate by it. */
  classification: string;
  /**
   * TRA-918 — modeled slippage + commission charged at entry, USD per 1-lot.
   * Scaled by `contracts` and recorded on the opened {@link ReplayPosition}.
   */
  modeledSlippageUsd?: number;
}

/** TRA-800 — per-structure sizing knob (fraction of managed equity reserved per lot). */
export interface SpreadRiskParams {
  budgetRatio: number;
}

export interface OptionsReplayAccountConfig {
  initialEquity: number;
  managedAccountRatio: number;
  optionsDailyTradesLimit: number;
  otmRiskParams: OtmRiskParams;
  rvRiskParams: RvRiskParams;
  /**
   * Per-structure budget ratios for the defined-risk combos. Partial: a
   * structure absent from the map falls back to {@link DEFAULT_SPREAD_BUDGET_RATIO}
   * in {@link OptionsReplayAccount.openSpread} (TRA-918 — the four Phase-A
   * structures are optional so a TRA-800-era config with only the two original
   * structures still type-checks).
   */
  spreadRiskParams: Partial<Record<ReplaySpreadStrategy, SpreadRiskParams>>;
}

/** Fallback per-lot budget ratio when a structure is absent from `spreadRiskParams`. */
export const DEFAULT_SPREAD_BUDGET_RATIO = 0.02;

/** TRA-800 — single-contract intrinsic value at `spot`, per share. */
function intrinsic(optionType: OptionType, strike: number, spot: number): number {
  return optionType === 'call' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

/**
 * TRA-800 — total per-lot P&L of a defined-risk structure if it is closed at
 * leg intrinsics for underlying `spot`. `netUsdPerLot` is the entry cash flow
 * (+ credit / − debit); each leg is closed at intrinsic with the sign of the
 * closing action (a bought leg is sold to close → + intrinsic; a sold leg is
 * bought back → − intrinsic). Clamped to the defined-risk band
 * `[−maxLossPerLot, +maxProfitPerLot]`.
 */
export function spreadPayoffPerLot(
  legs: readonly OptionLeg[],
  netUsdPerLot: number,
  maxLossPerLot: number,
  maxProfitPerLot: number,
  spot: number,
): number {
  let closeCash = 0;
  for (const leg of legs) {
    const iv = intrinsic(leg.optionType, leg.strike, spot) * CONTRACT_MULTIPLIER;
    closeCash += leg.action === 'buy' ? iv : -iv;
  }
  const raw = netUsdPerLot + closeCash;
  return Math.min(maxProfitPerLot, Math.max(-maxLossPerLot, raw));
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

  /** Stable combo key for dedup — mirrors the live `COMBO:…` synthetic symbol. */
  private comboSymbolFor(symbol: string, strategy: ReplaySpreadStrategy, legs: readonly OptionLeg[]): string {
    const legKey = legs
      .map((l) => `${l.action[0]}${l.optionType[0]}${l.strike}@${l.expiration}`)
      .join('+');
    return `COMBO:${symbol.toUpperCase()}:${strategy}:${legKey}`;
  }

  /**
   * TRA-800 — open a defined-risk structure as one combo position. This is the
   * replay counterpart of `PaperOptionsAccount.openDefinedRiskSpread`: the
   * uniform capital-at-risk model debits `maxLossUsd × contracts` from cash
   * (credit netted into reserved capital, never freed as instant profit), and
   * `premiumPaid` is the per-share reserved-capital basis so the close-path P&L
   * math books the capped worst case as the cost basis. Sized off the
   * per-structure budget ratio against the per-lot max loss; one lot is forced
   * when a single defined-risk lot still fits cash (so a high-max-loss credit
   * structure isn't silently rounded to zero).
   */
  openSpread(c: OpenSpreadCandidate): OpenOutcome {
    if (!this.currentDay) throw new Error('startDay() must be called before openSpread()');
    const maxLossPerLot = c.maxLossUsd;
    if (!Number.isFinite(maxLossPerLot) || maxLossPerLot <= 0) return { reason: 'bad_mark', position: null };
    if (!Array.isArray(c.legs) || c.legs.length < 1) return { reason: 'bad_mark', position: null };

    const comboSymbol = this.comboSymbolFor(c.symbol, c.strategy, c.legs);
    if (this.hasOpenForSymbol(comboSymbol)) return { reason: 'duplicate', position: null };

    const budgetRatio = this.cfg.spreadRiskParams[c.strategy]?.budgetRatio ?? DEFAULT_SPREAD_BUDGET_RATIO;
    const budget = this.equity * this.cfg.managedAccountRatio * budgetRatio;
    let contracts = Math.floor(budget / maxLossPerLot);
    if (contracts < 1 && maxLossPerLot <= this.cash) contracts = 1;
    if (contracts < 1) return { reason: 'zero_size', position: null };

    // Trim to whatever paper cash can actually reserve (the binding constraint).
    let totalRisk = contracts * maxLossPerLot;
    if (totalRisk > this.cash) {
      contracts = Math.floor(this.cash / maxLossPerLot);
      if (contracts < 1) return { reason: 'no_cash', position: null };
      totalRisk = contracts * maxLossPerLot;
    }

    if (this.dailyCount >= this.cfg.optionsDailyTradesLimit) {
      return { reason: 'daily_cap', position: null };
    }

    this.cash -= totalRisk;
    this.dailyCount += 1;
    this.idSeq += 1;

    const premiumPaid = maxLossPerLot / CONTRACT_MULTIPLIER;
    const position: ReplayPosition = {
      id: `rp-${this.idSeq}`,
      symbol: c.symbol.toUpperCase(),
      optionSymbol: comboSymbol,
      optionType: c.legs[0]!.optionType,
      strike: c.legs[0]!.strike,
      expiration: c.expiration,
      contracts,
      contractsRemaining: contracts,
      premiumPaid,
      currentPremium: premiumPaid,
      // Combos are held to expiry; the per-tick SL/TP/trailing engine skips
      // them (sentinels keep markAndCheckExits a no-op even if it sees one).
      tp1Premium: Number.POSITIVE_INFINITY,
      tp1Hit: false,
      stopLossPremium: 0,
      peakPremium: premiumPaid,
      trailingActive: false,
      trailingStopPremium: 0,
      openedAtDay: this.currentDay,
      signalType: c.strategy,
      classification: c.classification,
      pnl: 0,
      isCombo: true,
      legs: c.legs,
      netUsdPerLot: c.netUsd,
      maxLossPerLot,
      maxProfitPerLot: c.maxProfitUsd,
      breakevens: c.breakevens,
      spreadStrategy: c.strategy,
      modeledSlippage: (c.modeledSlippageUsd ?? 0) * contracts,
    };
    this.open.set(position.id, position);
    return { reason: 'opened', position };
  }

  /**
   * TRA-918 (TRA-908 Phase D, plan §1.6) — mid-life management for the Phase-A
   * signal structures. The two TRA-800 structures are held to expiry via
   * {@link settleSpreads}; the four Phase-A structures are instead marked to the
   * day's chain mids and closed early, in priority order, on:
   *
   *   1. **Take profit** — unrealized P&L ≥ `takeProfitFraction` × max profit
   *      (credit structures: bought back at ≤ (1−f)× entry credit; debit: mark
   *      ≥ entry debit + f×(width−debit)). The dominant, plan-required exit.
   *   2. **Stop** — credit structures at a `creditStopMultiple`×-credit spread
   *      mark (default 2× → a full-credit loss); debit structures at
   *      `debitStopLossFraction` of the debit lost (default 50%).
   *   3. **Time stop** — at/under `timeStopDte` (default 21) calendar DTE, close
   *      at the current mark (NO roll in backtest) — mirrors the selector's
   *      `minShortDte` floor.
   *
   * `legMid` resolves a per-share mid for one structure leg from the current
   * day's chain (null when unpriceable). When a structure can't be priced this
   * tick only the time stop can fire (booked at its capped max loss — the
   * conservative defined-risk floor). Single-leg scanner positions and the two
   * TRA-800 hold-to-expiry combos are untouched.
   */
  markAndManageSpreads(
    day: string,
    nowMs: number,
    legMid: (symbol: string, leg: OptionLeg) => number | null,
    params: SpreadManagementParams = DEFAULT_SPREAD_MANAGEMENT,
  ): void {
    for (const [id, opt] of this.open) {
      if (!opt.isCombo || !opt.legs) continue;
      if (!MANAGED_SPREAD_STRATEGIES.has(opt.spreadStrategy as ReplaySpreadStrategy)) continue;

      const netUsdPerLot = opt.netUsdPerLot ?? 0;
      const maxProfitPerLot = opt.maxProfitPerLot ?? 0;
      const maxLossPerLot = opt.maxLossPerLot ?? opt.premiumPaid * CONTRACT_MULTIPLIER;
      const isCredit = netUsdPerLot > 0;

      // Per-share liquidation value: sell longs (+mid), buy back shorts (−mid).
      let closeValuePerShare = 0;
      let priced = true;
      for (const leg of opt.legs) {
        const m = legMid(opt.symbol, leg);
        if (m == null || !Number.isFinite(m) || m < 0) {
          priced = false;
          break;
        }
        closeValuePerShare += leg.action === 'buy' ? m : -m;
      }

      if (priced) {
        const rawPnl = netUsdPerLot + closeValuePerShare * CONTRACT_MULTIPLIER;
        const pnlPerLot = Math.min(maxProfitPerLot, Math.max(-maxLossPerLot, rawPnl));

        // 1. Take profit — ≥ f × max profit.
        if (maxProfitPerLot > 0 && pnlPerLot >= params.takeProfitFraction * maxProfitPerLot) {
          this.closeComboAtPnl(id, pnlPerLot, day, 'take_profit');
          continue;
        }

        // 2. Stop.
        if (isCredit) {
          const costToClose = -closeValuePerShare * CONTRACT_MULTIPLIER; // M (≥0) for a credit spread
          if (costToClose >= params.creditStopMultiple * netUsdPerLot) {
            this.closeComboAtPnl(id, pnlPerLot, day, 'stop_loss');
            continue;
          }
        } else if (-pnlPerLot >= params.debitStopLossFraction * maxLossPerLot) {
          this.closeComboAtPnl(id, pnlPerLot, day, 'stop_loss');
          continue;
        }
      }

      // 3. Time stop at/under the DTE floor.
      if (comboDteDays(opt.expiration, nowMs) <= params.timeStopDte) {
        const pnlPerLot = priced
          ? Math.min(maxProfitPerLot, Math.max(-maxLossPerLot, netUsdPerLot + closeValuePerShare * CONTRACT_MULTIPLIER))
          : -maxLossPerLot;
        this.closeComboAtPnl(id, pnlPerLot, day, 'time_stop');
      }
    }
  }

  /** Close a managed combo booking exactly `pnlPerLot × contracts` (see {@link settleSpreads}). */
  private closeComboAtPnl(
    id: string,
    pnlPerLot: number,
    day: string,
    reason: NonNullable<ReplayPosition['exitReason']>,
  ): void {
    const opt = this.open.get(id);
    if (!opt) return;
    const maxLossPerLot = opt.maxLossPerLot ?? opt.premiumPaid * CONTRACT_MULTIPLIER;
    const exitPremium = (maxLossPerLot + pnlPerLot) / CONTRACT_MULTIPLIER;
    this.closePosition(id, exitPremium, day, reason);
  }

  /**
   * TRA-800 — settle defined-risk combos at their leg-intrinsic payoff. Any
   * open combo whose expiration is on/before `day` (or every open combo when
   * `force` is set, for the tail of the window) is closed at the per-lot payoff
   * for the underlying `spotBySymbol` value, clamped to its defined-risk band.
   * When no spot is known the combo books its capped max loss (conservative).
   * Single-leg scanner positions are untouched — they exit via the per-tick
   * path / {@link expireOrForceCloseDueContracts}.
   */
  settleSpreads(
    day: string,
    spotBySymbol: ReadonlyMap<string, number>,
    opts: { force?: boolean } = {},
  ): void {
    for (const [id, opt] of this.open) {
      if (!opt.isCombo) continue;
      if (!opts.force && opt.expiration > day) continue;
      const spot = spotBySymbol.get(opt.symbol.toUpperCase());
      const maxLossPerLot = opt.maxLossPerLot ?? opt.premiumPaid * CONTRACT_MULTIPLIER;
      const pnlPerLot =
        typeof spot === 'number' && Number.isFinite(spot) && spot > 0
          ? spreadPayoffPerLot(
              opt.legs ?? [],
              opt.netUsdPerLot ?? 0,
              maxLossPerLot,
              opt.maxProfitPerLot ?? 0,
              spot,
            )
          : -maxLossPerLot;
      // Reserved-capital returned per share so closePosition books exactly
      // `pnlPerLot × contracts` (premiumPaid basis === maxLossPerLot / 100).
      const exitPremium = (maxLossPerLot + pnlPerLot) / CONTRACT_MULTIPLIER;
      this.closePosition(id, exitPremium, day, opts.force ? 'forced_close' : 'settled');
    }
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
      // TRA-800 — defined-risk combos are held to expiry (settleSpreads), never
      // managed per-tick. Mirrors the live `checkExits` combo skip.
      if (opt.isCombo) continue;
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
      if (opt.isCombo) continue; // combos settle at intrinsic via settleSpreads
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
      if (opt.isCombo) continue; // synthetic combo symbols are never in the chain
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
      // Combos are tail-settled by settleSpreads(force) at the window's last
      // spot — they carry no chain mark to tail-close against here.
      if (opt.isCombo) continue;
      const m = marksByOcc.get(opt.optionSymbol);
      const exit = typeof m === 'number' && m > 0 ? m : opt.currentPremium;
      this.closePosition(id, exit, day, 'forced_close');
    }
  }
}
