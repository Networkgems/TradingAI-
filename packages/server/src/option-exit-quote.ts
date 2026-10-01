/**
 * TRA-4997 — RESOLVE THE EXIT-SIDE QUOTE for a closing option row, and measure
 * what crossing it costs. Pure: no env, no I/O, no clock.
 *
 * ## The defect this closes
 *
 * `crossedPnlUsd` (TRA-4674) is the only column that prices an exit at what we
 * would actually pay to get out, and on 2026-10-01 it covered **58 of 3,541
 * resolved rows (1.6%)**. 1,310 of the misses were `exit_quote_missing` — no
 * bid/ask captured at close time at all — and `summary.slippage.exitSampled` was
 * **0**, blinding round-trip cost entirely. QuantTrader is holding the options
 * sleeve at zero admissions on the strength of that 58-row sample (bar 0.3386 R
 * vs a crossed −0.3136 R); whether the bar is right or the gate is over-refusing
 * is not decidable from 1.6% coverage. (TRA-4997, off the TRA-4971 review.)
 *
 * The cause was never the maths — it was that only ONE of the book's close paths
 * captured a quote. `markProvenance.quoteAtFire` is stamped at the exit
 * cascade's fire site; `closeOption` (the give-back halt flatten, the manual
 * close, the broker reconcile) evaluates no mark and stamps nothing. Of the 228
 * rows that closed AFTER the TRA-4055 stamp shipped and still could not be
 * priced, 189 (83%) were `book_halt_flat`.
 *
 * ## The two disciplines
 *
 *   • **The fire-tick quote always wins.** A row that prices today prices off
 *     `quoteAtFire`, and this module's precedence keeps it there — so no row
 *     that already had a crossed number gets a different one. The fallback can
 *     only ever ADD coverage.
 *   • **A fallback ships its own counter.** A `last_known` quote is a weaker
 *     measurement than a `fire_tick` one, and the difference is invisible in the
 *     price itself. `source` + `ageMs` ride on every stamp, the crossed fold
 *     counts `pricedByLastKnownQuote` separately, and anything past
 *     {@link EXIT_QUOTE_MAX_AGE_MS} is refused outright with its own reason
 *     rather than quietly priced.
 */

import type { OptionExitQuote } from '@trading-app/shared';

/**
 * How old a `last_known` quote may be and still price a cross: **10 minutes**.
 *
 * This is a MEASUREMENT bound, not a trading threshold — nothing reads it into
 * an order, a level or a gate. It is set where it is because the quote fan runs
 * once per engine tick (tens of seconds), so a close reached by `closeOption`
 * inside a tick resolves a quote seconds old; 10 minutes admits a couple of
 * missed fans without admitting a row whose feed went dark for a session. A
 * quote older than this reads `exit_quote_stale`, which is a NAMED refusal and
 * deliberately not the same bucket as "no quote was ever captured".
 */
export const EXIT_QUOTE_MAX_AGE_MS = 10 * 60_000;

/** Two-sided, non-negative bid, positive ask, uncrossed — `liveQuoteFor`'s predicate. */
export function isUsableQuote(q: unknown): q is { bid: number; ask: number } {
  if (q === null || typeof q !== 'object') return false;
  const r = q as { bid?: unknown; ask?: unknown };
  if (typeof r.bid !== 'number' || typeof r.ask !== 'number') return false;
  if (!Number.isFinite(r.bid) || !Number.isFinite(r.ask)) return false;
  return r.bid >= 0 && r.ask > 0 && r.ask >= r.bid;
}

/** What {@link resolveExitQuote} reads off a closing position. All optional. */
export interface ExitQuoteInputs {
  /** ms epoch the row closed — the instant `ageMs` is measured against. */
  closeTs: number;
  /** `markProvenance.quoteAtFire`: the book the closing exit rule itself read. */
  fireQuote?: { bid: number; ask: number } | null;
  /** `markProvenance.at`: when that evaluation ran. */
  fireQuoteAt?: number | null;
  /** `OptionPosition.lastUsableQuote`: the newest usable book before the close. */
  lastUsableQuote?: { bid: number; ask: number; at: number } | null;
}

/**
 * Resolve the exit-side quote for a close, or `null` when the row carried none.
 *
 * Precedence is load-bearing: `fireQuote` first, ALWAYS — see the module header.
 * `ageMs` is floored at 0 so a clock that ran backwards cannot publish a
 * negative age, and a `fireQuote` with no `at` reads age 0 (it is by definition
 * the closing evaluation's own quote).
 *
 * ⛔ Returns `null`, never a zero-filled stamp: an unmeasured book must not read
 * as a zero-width one.
 */
export function resolveExitQuote(inputs: ExitQuoteInputs): OptionExitQuote | null {
  const ageFrom = (at: number | null | undefined): number =>
    typeof at === 'number' && Number.isFinite(at) ? Math.max(0, inputs.closeTs - at) : 0;
  const fire = inputs.fireQuote;
  if (isUsableQuote(fire)) {
    return { bid: fire.bid, ask: fire.ask, source: 'fire_tick', at:
      typeof inputs.fireQuoteAt === 'number' && Number.isFinite(inputs.fireQuoteAt)
        ? inputs.fireQuoteAt
        : inputs.closeTs,
      ageMs: ageFrom(inputs.fireQuoteAt) };
  }
  const last = inputs.lastUsableQuote;
  if (isUsableQuote(last) && typeof last.at === 'number' && Number.isFinite(last.at)) {
    return { bid: last.bid, ask: last.ask, source: 'last_known', at: last.at, ageMs: ageFrom(last.at) };
  }
  return null;
}

/**
 * TRA-4997 / TRA-1600 (D) — the MEASURED exit-side cross for a closing slice, in
 * USD, positive = cost: `((ask − bid) / 2) × contracts × 100`.
 *
 * Crossing out of a long sells the BID against a mid of `(bid + ask) / 2`;
 * closing a short buys the ASK against the same mid. Both are the half-spread,
 * so one expression serves both sides and the sign cannot be got wrong.
 *
 * ⚠️ **This is a quote-cross measurement, NOT a broker-fill one**, which is why
 * the close row stamps `exitSlippageBasis: 'quote_cross'` beside it. Deriving
 * the number from the modelled demo fill instead would make the measurement
 * equal its own input — `demoSlippagePct` defaults to 0, so `(mark − fill)` is
 * identically $0.00 on the demo book — and report "no slippage" on trades whose
 * slippage is simply unknown. That trap is spelled out verbatim on the
 * reconstructed-close writer (`tra3485-stale-open-repair.ts`) and this module
 * does not walk into it.
 *
 * `null` when the inputs cannot support a measurement — never 0.
 */
export function exitQuoteCrossUsd(
  quote: Pick<OptionExitQuote, 'bid' | 'ask'>,
  contracts: number,
): number | null {
  if (!isUsableQuote(quote)) return null;
  if (!Number.isFinite(contracts) || !(contracts > 0)) return null;
  return Math.round(((quote.ask - quote.bid) / 2) * contracts * 100 * 100) / 100;
}
