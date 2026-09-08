/**
 * TRA-4246 (AC1/AC3) — THE ROW'S OWN STOP-BASIS R, computed once, at the close.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * `/api/trades/export` published `pnl_r_stop_basis: null` on every
 * journal-served row, forever — 0 non-null of 23 rows at TRA-4246's filing, 0
 * of 105 on 2026-09-03, 0 of 106 on 2026-09-08. The reason was stated in
 * `export-history.ts` as a virtue: *"The journal records no stop, so the
 * stop-basis column is null here — a blank, never a premium figure re-scaled by
 * a constant that is stale the day the stop is re-tuned."* The blank was right.
 * What followed from it was not: a reader who needed the number did the
 * re-scaling BY HAND, off the only divisor any surface published — the sleeve
 * cell's `gateRPerPremiumR: 4`.
 *
 * That constant is `1 / STOP_DISTANCE_FRACTION_OF_MARK` (`option-spread-cost.ts`,
 * `0.25`): the COST-AWARE GATE's modelled stop, `mark × 0.75`. The OTM sleeve
 * that actually trades stops at `OTM_OPTIONS_SL_PCT 0.20` — `premium × 0.80`, a
 * **5×**. Both constants are correct; they describe different things, and
 * nothing on the wire said which one a column was in. So every stop-basis
 * magnitude derived through the cell was 4/5 of true — understated by 20%,
 * across the whole of the CFO's TRA-4243 table (recover true from published by
 * ×1.25).
 *
 * ── Why per-row, and not a per-sleeve constant table ────────────────────────
 *
 * A table keyed on `OTM_OPTIONS_SL_PCT` / `OPTIONS_SL_PCT` encodes today's two
 * sleeves and goes red the first time a third arrives — it reintroduces the
 * exact "one constant cannot cover mixed sleeves" defect one level up, and it
 * is still wrong on any row whose stop was moved off the sleeve default (an
 * adopted lot, an operator pin, a ratcheted stop). The row knows its own stop.
 * `/api/state` already carries `stopLossPremium` on OPEN rows and the exit
 * evaluation consumes that exact value — the only thing missing was capturing
 * it at the close, before it goes out of scope. That is all this module does.
 * (CFO scope ruling on this ticket, 2026-09-01: the per-row basis is the
 * primary path; a divisor constant is a labelled fallback, never a parallel
 * implementation.)
 *
 * ── Null is a verdict ───────────────────────────────────────────────────────
 *
 * `stopLossPremium: 0` is the book's "never stop" sentinel (`isArmedThreshold`
 * rejects it; an unauthorized adopted lot carries it). A distance measured from
 * a stop that does not exist equals the PREMIUM basis exactly, so a defaulted
 * number there would read as a coincidence — "this row's stop R happens to
 * equal its premium R" — rather than as "this row had no stop". Every null
 * therefore ships a {@link OptionStopBasisNullReason} beside it, and the caller
 * persists both.
 */

import type { OptionStopBasisNullReason } from './option-trade-journal.js';

/** Shares per contract. Local, for the same reason `export.ts` keeps its own. */
const OPTION_CONTRACT_MULTIPLIER = 100;

/** The operands, exactly as the close path holds them. */
export interface OptionStopBasisInput {
  /**
   * The book's per-share entry basis AT CLOSE — `OptionPosition.premiumPaid`
   * after `restateEngineOpenedBasis` or an operator pin has moved it. The same
   * figure the close row publishes as `entryBasisPremium`, so the two columns
   * are guaranteed to describe one basis.
   */
  premiumPaid: number | undefined;
  /** `OptionPosition.stopLossPremium` as the row carried it at the close. */
  stopLossPremium: number | undefined;
  contracts: number | undefined;
  /** The close row's `realizedPnlUsd` — CUMULATIVE, partials included. */
  realizedPnlUsd: number | undefined;
}

/** What the close row persists. A null figure ALWAYS carries a reason. */
export interface OptionStopBasisResult {
  pnlRStopBasis: number | null;
  reason?: OptionStopBasisNullReason;
  /** `|premiumPaid − stopLossPremium|`, per share. Absent when the figure is null. */
  stopBasisPremium?: number;
  /**
   * `premiumPaid ÷ stopBasisPremium` — THIS ROW'S premium-R→stop-R factor
   * (5.0 on the 0.20 sleeve, 4.0 on a 0.25 one). Absent when the figure is null.
   */
  stopBasisRPerPremiumR?: number;
}

const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Compute the row's stop-basis R and its divisor.
 *
 * Order of refusal matters and is asserted in the tests: an unarmed stop is
 * reported as `stop_unarmed` even when the basis is also missing, because
 * "no stop" is the fact an operator acts on and "no basis" is a bookkeeping
 * gap. A row that clears every structural check but carries no finite P&L is
 * `pnl_unknown` — the risk UNIT is good there, so `stopBasisPremium` and the
 * divisor are still published; only the quotient is unavailable.
 */
export function computeOptionStopBasisR(input: OptionStopBasisInput): OptionStopBasisResult {
  const { premiumPaid, stopLossPremium, contracts, realizedPnlUsd } = input;
  // The `> 0` is the sentinel test, not a range check: `stopLossPremium: 0`
  // means "never stop", and `isArmedThreshold` in `options-account.ts` rejects
  // it at every trigger site. This must agree with that predicate or the
  // journal will publish an R for a stop the engine refuses to fire.
  if (!finite(stopLossPremium) || stopLossPremium <= 0) {
    return { pnlRStopBasis: null, reason: 'stop_unarmed' };
  }
  if (!finite(premiumPaid) || premiumPaid <= 0) {
    return { pnlRStopBasis: null, reason: 'basis_unknown' };
  }
  if (!finite(contracts) || contracts <= 0) {
    return { pnlRStopBasis: null, reason: 'basis_unknown' };
  }
  const stopBasisPremium = Math.abs(premiumPaid - stopLossPremium);
  // A stop AT the basis leaves no room between entry and stop — the same
  // degenerate-R case `profitLockDecision` refuses with `R > 0`. There is no
  // risk unit to divide by, and dividing anyway yields ±Infinity, which every
  // downstream `Number.isFinite` guard would then read as "unmeasured" without
  // ever saying why.
  if (!(stopBasisPremium > 0)) {
    return { pnlRStopBasis: null, reason: 'nonpositive_r' };
  }
  const stopBasisRPerPremiumR = premiumPaid / stopBasisPremium;
  if (!finite(realizedPnlUsd)) {
    return { pnlRStopBasis: null, reason: 'pnl_unknown', stopBasisPremium, stopBasisRPerPremiumR };
  }
  const riskUsd = stopBasisPremium * contracts * OPTION_CONTRACT_MULTIPLIER;
  if (!(riskUsd > 0)) {
    return { pnlRStopBasis: null, reason: 'nonpositive_r' };
  }
  return {
    // Rounded to the same 3dp the export's `pnl_r` uses, so the two R columns
    // on one row are read at one precision and a reader diffing them is not
    // chasing float hair.
    pnlRStopBasis: Math.round((realizedPnlUsd / riskUsd + Number.EPSILON) * 1000) / 1000,
    stopBasisPremium,
    stopBasisRPerPremiumR,
  };
}
