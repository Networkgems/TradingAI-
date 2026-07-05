// TRA-1303 — Position Advisor readout data contract.
//
// Parent TRA-1302 asks the user-facing question: "when/how much do I add (DCA)
// and when/how do I sell?" per symbol. This module defines the SHAPE of the
// answer only — a read-only projection the server fills by re-running the
// SHIPPED engine cores (conviction-dca / crypto-dca / the exit engines) against
// the live demo book WITHOUT executing any order. No sizing logic lives here;
// it is a pure data contract shared by the server (producer) and the UI
// (consumer) so both sides agree on the fields the readout carries.

import type { DcaAction } from './conviction-dca.js';

/** Which demo book a row came from. */
export type AdvisorBook = 'equity' | 'options' | 'crypto';

/** Long / short, normalized across books (options rows are the underlying view). */
export type AdvisorSide = 'long' | 'short';

/**
 * The next-add ("DCA") half of the readout for one held position. Every field
 * is echoed straight from the engine's own DCA verdict — we surface, we do not
 * decide. `qty` is the size the engine WOULD add at `triggerPrice` (shares for
 * equity, contracts for options, coins for crypto); it is 0 when the core
 * refuses the add, and `reason` then explains why (max adds reached, earnings
 * blackout, budget full, disabled, …).
 */
export interface AdvisorDcaPlan {
  /** Master flag: false when the book's conviction/accumulation DCA is off (opt-in). */
  enabled: boolean;
  /** The core's verdict for the NEXT planned add: 'add' | 'shrink' | 'skip'. */
  action: DcaAction;
  /** Size the engine would add at `triggerPrice` (shares / contracts / coins). 0 on skip. */
  qty: number;
  /**
   * Price at which the next add becomes eligible. For equity this is the ATR
   * pullback-ladder level the engine already uses; for options/crypto the add is
   * not price-laddered (it is thesis/cadence-gated), so this is `null` and the
   * add is eligible at the current mark once the gates clear.
   */
  triggerPrice: number | null;
  /** True when the add would already fire at the CURRENT price (not just at the trigger). */
  eligibleNow: boolean;
  /** Blended average entry AFTER the projected add (price for equity/crypto, per-contract premium for options). */
  blendedAvgAfter: number | null;
  /** Total position dollar-risk AFTER the projected add — the audited `(avg−stop)·qty` / Σpremium. */
  projectedRisk: number | null;
  /** Per-position risk budget R (dollars) the add is capped against. */
  riskBudget: number;
  /** Human-readable reason for the verdict — the same string the engine logs. */
  reason: string;
}

/**
 * The sell-plan half of the readout for one held position: the protective stop,
 * the profit target, and any live trailing level — all read from the position's
 * own bracket / the exit engine, expressed in the unit the book trades.
 */
export interface AdvisorSellPlan {
  /** 'price' for equity/crypto brackets; 'premium' for options (per-share option premium). */
  unit: 'price' | 'premium';
  /** Protective stop level. */
  stopLoss: number;
  /** Take-profit / first-target level (options: the TP1 partial-exit trigger). */
  takeProfit: number;
  /** Current live trailing-stop level when trailing is engaged, else null. */
  trailingStop: number | null;
  /** Whether a trailing stop is currently active for this position. */
  trailingActive: boolean;
  /** Short description of the exit rule set driving this plan. */
  method: string;
}

/** One held-position row: current state + next-add plan + sell plan. */
export interface PositionAdvisorRow {
  book: AdvisorBook;
  symbol: string;
  side: AdvisorSide;
  signalType: string;
  /** Held size: shares (equity), coins (crypto), or contracts (options). */
  quantity: number;
  /** Blended average entry: price (equity/crypto) or per-share premium paid (options). */
  avgEntry: number;
  /** Current mark: underlying/coin price, or option premium mark for options. null when unpriced. */
  currentPrice: number | null;
  dca: AdvisorDcaPlan;
  sell: AdvisorSellPlan;
}

/** The full readout returned by `GET /api/advisor/positions`. Demo book only. */
export interface PositionAdvisorReadout {
  asOf: string;
  /** Always 'demo' — the advisor is read-only and never touches the live book. */
  mode: 'demo' | 'live';
  rows: PositionAdvisorRow[];
  /** Per-book context notes (e.g. "3 equity, 1 option; crypto DCA accumulation off"). */
  notes: string[];
}
