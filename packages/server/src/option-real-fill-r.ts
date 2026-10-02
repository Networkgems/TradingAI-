/**
 * TRA-4894 (spec TRA-4887 §1/§2/§6) — the REAL-FILL R of one journal row:
 * broker truth on BOTH legs, re-denominated on the entry FILL, net of the
 * measured EXIT cross.
 *
 * ── The three-part discriminator, and the two fields that look like it ──────
 *
 * A row carries a real-fill R iff ALL THREE hold (TRA-2819):
 *   • `pnlBasis === 'broker-fill'`  — `realizedPnlUsd` is broker truth, net of
 *     MEASURED fees. The restatement refuses outright when any allocated leg's
 *     fee is `null`, so this stamp cannot be worn by a gross number.
 *   • `entryFillPremium` finite and > 0
 *   • `exitFillPremium`  finite and > 0
 *
 * ⛔ **NOT `entryBasisPremium`** (TRA-4031). It is the book's entry basis at
 * close, and its own doc records that it SKIPS every lot whose fills carry
 * `fees: null` — measured on `NVTS261002C00012500`: mid 1.395, basis 1.51,
 * sweep `skip: fees_unmeasured`. A basis is not a fill.
 *
 * ⛔ **NOT `atRiskBasis`.** Documented ABSENT on every ENGINE-opened row.
 * Absent is UNKNOWN, never `'mark'`; filtering on it drops the entire engine
 * population, which is the whole population.
 *
 * ── Why the R has to be re-denominated ──────────────────────────────────────
 *
 * `realizedR = realizedPnlUsd / atRiskUsd`, and `amend_close_basis` explicitly
 * recomputes on the SAME denominator. Measured live 2026-09-24: the only path
 * that moves `atRiskUsd` is `amend_open_basis` — 3 of them, 2 `labelOnly: true`
 * (`96b0dc72` RIG 22→22 `unconsulted`, `a2f9c8cd` NOK 57→57 `no_unclaimed_buys`)
 * and 1 an operator pin (`6bbc5d17` BAC 141→117, `admin_restatement:TRA-3958`),
 * with `openBasisRegrade.totalPromoted: 0`. **Exactly one row on the entire tape
 * has a fill-denominated R, and its provenance is a human.** So a broker-fill
 * numerator over a mid-booked denominator is still a mid-basis R — the
 * correction has to land on BOTH halves or it lands on neither.
 *
 * ── Why the cross is charged on the EXIT LEG ONLY ───────────────────────────
 *
 * ⛔ `priceCrossedRow` (`option-crossed-pnl.ts`, TRA-4674) prices the FULL round
 * trip at `(exitBid − entryAsk)`. On a row already denominated on
 * `entryFillPremium` that DOUBLE-CHARGES the entry. Here the entry is already
 * broker truth, so only the exit is restated from the achieved fill down to the
 * pessimistic taker side of `markProvenance.quoteAtFire`.
 *
 * ── FAIL-NULL, never fail-zero ──────────────────────────────────────────────
 *
 * Every ignorance case returns `null` + a named {@link RealFillUnpricedReason}
 * and the row LEAVES the population. An absent cross charged as `0` would make
 * the net column byte-identical to the gross one — i.e. it would reproduce the
 * exact defect this ticket exists to close, while reading green. Same discipline
 * as TRA-4578's `netOfModelledCross` and TRA-4674's `crossedUnpriced`.
 *
 * ── TRA-5040: this arm reads ONE field fewer than its sibling ──────────────
 *
 * `crossedPnlUsd` resolves its exit book as `markProvenance.quoteAtFire` and
 * then TRA-4997's close-seam `exitQuote`; this module read only the first, so 15
 * of the 20 broker-truth rows on the live tape dropped `exit_quote_missing`
 * (measured 2026-10-02T03:29Z on `6690770689b5`) — inside the one gate standing
 * between the OTM sleeve and a live entry. The fallback is implemented here as an
 * OPT-IN ({@link RealFillPricingOpts.seamQuoteFallback}, default off) and the
 * fold publishes what it recovers as a SHADOW beside `nRealFill`: the deciding
 * number does not move until the board rules on the shadow.
 *
 * PURE — no env, no I/O, no clock. Structural row type (the `CrossedPricingRow`
 * pattern) so this module has no import back into `option-trade-journal.ts`.
 */

import type { OptionExitQuote } from '@trading-app/shared';

import {
  CROSSED_LONG_PREMIUM_STRUCTURES,
  CROSSED_SHORT_PREMIUM_STRUCTURES,
  resolveCrossedExitQuote,
} from './option-crossed-pnl.js';

/**
 * `GATE_R_PER_PREMIUM_R`, re-imported rather than re-spelled — TRA-4894 §B says
 * "reuse the constant, do not re-spell it". It is `1 / STOP_DISTANCE_FRACTION_OF_MARK`
 * = 4: the premium→gate-R conversion for a full-premium `atRiskUsd` against a
 * `mark · 0.75` stop.
 */
import { GATE_R_PER_PREMIUM_R } from './option-trade-journal.js';

/**
 * Why a row has no real-fill R. A row that cannot be classified must be VISIBLY
 * unclassifiable — a bare null with no reason is one `?? 0` away from a zero.
 *   • `not_broker_fill`         — no `pnlBasis: 'broker-fill'` stamp: the P&L is
 *     the engine's own close arithmetic over a pre-trade NBBO mid.
 *   • `entry_fill_missing`      — no usable `entryFillPremium` (finite, > 0).
 *   • `exit_fill_missing`       — no usable `exitFillPremium`.
 *   • `realized_pnl_missing`    — the stamp is there but the money is not.
 *   • `structure_not_crossable` — multi-leg: one two-sided quote cannot price
 *     the package, and a wrong-sign charge is worse than none.
 *   • `contracts_unknown`       — pre-TRA-1656 row with no contract count.
 *   • `exit_quote_missing`      — no `markProvenance.quoteAtFire` (closed before
 *     TRA-4055, or by a path that never evaluated a mark) and — when the
 *     TRA-5040 fallback is enabled — no TRA-4997 close-seam `exitQuote` either.
 *   • `exit_quote_stale`        — TRA-5040: a close-seam `exitQuote` exists but
 *     its `ageMs` exceeds `EXIT_QUOTE_MAX_AGE_MS`. Held apart from
 *     `exit_quote_missing` for the reason TRA-4997 gives: "we have a book and it
 *     is too old to price against" and "we never had a book" license different
 *     conclusions, and collapsing them makes a coverage gap read as a feed
 *     outage. ⛔ Only reachable with the fallback enabled.
 *   • `exit_quote_unusable`     — a quote was stamped but the side this
 *     structure transacts on is not a positive finite number.
 */
export type RealFillUnpricedReason =
  | 'not_broker_fill'
  | 'entry_fill_missing'
  | 'exit_fill_missing'
  | 'realized_pnl_missing'
  | 'structure_not_crossable'
  | 'contracts_unknown'
  | 'exit_quote_missing'
  | 'exit_quote_stale'
  | 'exit_quote_unusable';

/** The structural slice of a journal record this module reads. */
export interface RealFillPricingRow {
  structure: string;
  outcome?: string;
  contracts?: number;
  realizedPnlUsd?: number;
  /** TRA-2819 — the broker-truth stamp. Anything else is a mid-booked row. */
  pnlBasis?: 'broker-fill';
  entryFillPremium?: number;
  exitFillPremium?: number;
  markProvenance?: { quoteAtFire: { bid: number; ask: number } | null } | null;
  /**
   * TRA-4997's close-seam exit book — stamped synchronously in
   * `queueJournalClose`, the one seam EVERY close path funnels through, where
   * `markProvenance` is stamped only at the exit cascade's fire site.
   *
   * ⛔ Read ONLY when {@link RealFillPricingOpts.seamQuoteFallback} is set, and
   * then strictly after `markProvenance.quoteAtFire` — see
   * {@link priceRealFillRow}. With the flag off this field is not read at all and
   * the shipped census is byte-identical to pre-TRA-5040.
   */
  exitQuote?: OptionExitQuote | null;
}

/** TRA-5040 — opt-ins for {@link priceRealFillRow}. Default: everything off. */
export interface RealFillPricingOpts {
  /**
   * Fall back to TRA-4997's close-seam `exitQuote` when the row carries no
   * `markProvenance.quoteAtFire`.
   *
   * ⛔ **Default FALSE, and the live gate does not set it.** The real-fill arm is
   * a conjunct of a live-capital promotion gate (`nRealFill >= 40`), so widening
   * the population it counts can only move that count toward its floor. The flag
   * exists so the recovery can be MEASURED as a shadow beside the deciding
   * number and put to the board with that number attached, rather than flipped
   * because the data happened to be sitting there (TRA-5040 AC4).
   */
  seamQuoteFallback?: boolean;
}

/** One row's real-fill pricing. `rFillNet` is null iff `unpriced` is non-null. */
export interface RealFillRowPricing {
  /** `4 · netPnlUsd / (entryFillPremium · contracts · 100)`, in GATE R. */
  rFillNet: number | null;
  /** `realizedPnlUsd − exitCrossUsd`, in USD. Null when unpriced. */
  netPnlUsd: number | null;
  /**
   * The exit leg restated from the achieved fill to the pessimistic taker side,
   * in USD. Long premium: `(exitFillPremium − bid) · 100 · contracts`; short
   * premium mirrors to `(ask − exitFillPremium) · …`. Positive = the fill beat
   * the taker bound, and it is charged BACK.
   */
  exitCrossUsd: number | null;
  unpriced: RealFillUnpricedReason | null;
  /**
   * TRA-5040 — WHICH exit book charged the cross, `null` when the row did not
   * price. `fire_tick` is the only value reachable with the fallback off, so a
   * `last_known` row is exactly a row this ticket recovered — which is what makes
   * the shadow countable without re-running the fold a second way.
   *
   * Same discipline as `crossedExitQuoteSource`: a fallback ships its own
   * counter, because the two provenances are indistinguishable in the price.
   */
  exitQuoteSource: 'fire_tick' | 'last_known' | null;
}

const usable = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

const unpriced = (reason: RealFillUnpricedReason): RealFillRowPricing => ({
  rFillNet: null,
  netPnlUsd: null,
  exitCrossUsd: null,
  unpriced: reason,
  exitQuoteSource: null,
});

/**
 * Price ONE row on the real-fill basis. Pure; fails to `null` + reason, never
 * to 0.
 *
 * Order of the predicates is deliberate: the BASIS stamp is checked first, so a
 * mid-booked row reads `not_broker_fill` rather than being classified by
 * whichever of its quote fields happens to be absent. The population census a
 * reader folds off these reasons has to say "we never measured on fills" louder
 * than it says "one quote was missing".
 */
export function priceRealFillRow(
  row: RealFillPricingRow,
  opts: RealFillPricingOpts = {},
): RealFillRowPricing {
  if (row.pnlBasis !== 'broker-fill') return unpriced('not_broker_fill');
  if (!usable(row.entryFillPremium)) return unpriced('entry_fill_missing');
  if (!usable(row.exitFillPremium)) return unpriced('exit_fill_missing');
  const realizedPnlUsd = row.realizedPnlUsd;
  if (typeof realizedPnlUsd !== 'number' || !Number.isFinite(realizedPnlUsd)) {
    return unpriced('realized_pnl_missing');
  }
  const long = CROSSED_LONG_PREMIUM_STRUCTURES.has(row.structure);
  const short = !long && CROSSED_SHORT_PREMIUM_STRUCTURES.has(row.structure);
  if (!long && !short) return unpriced('structure_not_crossable');
  const contracts = row.contracts;
  if (!usable(contracts)) return unpriced('contracts_unknown');

  // TRA-5040 — the fire-tick quote first, ALWAYS. With `seamQuoteFallback` off
  // this is the whole resolution and the refusal is the pre-TRA-5040 one; with it
  // on, `resolveCrossedExitQuote` applies TRA-4997's precedence and staleness
  // rule — the same function `crossedPnlUsd` prices on, not a second copy of it.
  const fireQuote = row.markProvenance?.quoteAtFire ?? null;
  let quote: { bid: number; ask: number } | null =
    fireQuote === undefined ? null : fireQuote;
  let exitQuoteSource: 'fire_tick' | 'last_known' = 'fire_tick';
  if (quote === null) {
    if (!opts.seamQuoteFallback) return unpriced('exit_quote_missing');
    const resolved = resolveCrossedExitQuote(row);
    if (resolved.quote === null) {
      // Only these two of the crossed reasons are reachable here: everything
      // upstream of the exit book was already decided above.
      return unpriced(
        resolved.reason === 'exit_quote_stale' ? 'exit_quote_stale' : 'exit_quote_missing',
      );
    }
    quote = resolved.quote;
    exitQuoteSource = resolved.source ?? 'last_known';
  }
  // Long premium sells the exit BID; short premium buys back the exit ASK.
  const exitSide = long ? quote.bid : quote.ask;
  if (!usable(exitSide)) return unpriced('exit_quote_unusable');

  const exitFill = row.exitFillPremium;
  const exitCrossUsd = (long ? exitFill - exitSide : exitSide - exitFill) * 100 * contracts;
  // `realizedPnlUsd` is ALREADY net of the measured `feesUsd` (TRA-2819 sets the
  // two together and never zero-fills the fee), so fees are not deducted again.
  const netPnlUsd = realizedPnlUsd - exitCrossUsd;
  // The denominator is the ENTRY FILL — this is the half `amend_close_basis`
  // never moves, and the reason a broker-fill numerator alone is still mid-basis.
  const denomUsd = row.entryFillPremium * contracts * 100;
  return {
    rFillNet: (GATE_R_PER_PREMIUM_R * netPnlUsd) / denomUsd,
    netPnlUsd,
    exitCrossUsd,
    unpriced: null,
    exitQuoteSource,
  };
}
