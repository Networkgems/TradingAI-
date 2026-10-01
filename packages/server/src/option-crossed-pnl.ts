/**
 * TRA-4674 — CROSSED P&L: the option journal re-priced at what a position
 * actually transacts, published BESIDE `realizedPnlUsd`, never instead of it.
 *
 * `realizedPnlUsd` / `realizedR` are marked to mid/mark. On the desk book that
 * is not a rounding detail: re-pricing the 9 desk closes of 2026-09-09..09-17
 * that carry both quotes at ask→bid turns booked −$32.07 into crossed −$87.00
 * — a $54.93 drag, 52% of the mean absolute booked P&L, flipping the book's
 * sign (QuantTrader's measurement, TRA-4671 comment `49abc97a`). A flat book
 * and a bleeding book produce the same booked number; the crossed column is
 * what tells them apart.
 *
 * Everything here is computed at READ time from quotes the rows already carry
 * (the TRA-3990 entry-quote stamp / TRA-1656 fill snapshot on the entry side,
 * `markProvenance.quoteAtFire` (TRA-4055) on the exit side) — so historical
 * rows are priced retroactively and the column cannot drift from the ledger.
 * Nothing is written back; nothing here reaches an order path.
 *
 * The three disciplines this module holds to:
 *   • `null`, never 0, for an unpriceable row — and a named reason beside it.
 *   • A row unpriced on either side is excluded from BOTH columns of the fold:
 *     `crossedPnlUsd` and `bookedPnlUsdPriced` are a matched comparison over
 *     the SAME rows, never 13-booked-vs-9-crossed.
 *   • Ask→bid is the PESSIMISTIC bound (real fills land between it and the
 *     mid), which is exactly why both columns stay readable rather than either
 *     one replacing the other.
 */

import { deriveEntrySpreadPct, type OptionExitQuote } from '@trading-app/shared';
import { EXIT_QUOTE_MAX_AGE_MS } from './option-exit-quote.js';

/**
 * The structural slice of a journal record this module reads. Kept structural
 * (same pattern as `journalIdForPosition`) so this module has no import back
 * into `option-trade-journal.ts` — which imports THIS module for the summary
 * fold — and so any reader holding these fields can price a row.
 */
export interface CrossedPricingRow {
  outcome: 'OPEN' | 'WIN' | 'LOSS' | 'SCRATCH' | 'UNMEASURED'; // TRA-4857
  structure: string;
  contracts?: number;
  atRiskUsd: number;
  /** TRA-4857: can be `null` for unpriced reconcile closes. */
  realizedPnlUsd?: number | null;
  /** TRA-3990 stamp — broker-submit-superseded on live rows; preferred. */
  entryBidAtOpen?: number | null;
  entryAskAtOpen?: number | null;
  entrySpreadPct?: number | null;
  /** TRA-1656 scanner snapshot — the pre-stamp fallback. */
  entryBid?: number;
  entryAsk?: number;
  markProvenance?: { quoteAtFire: { bid: number; ask: number } | null; at?: number } | null;
  /**
   * TRA-4997 — the exit-side quote stamped at the CLOSE SEAM, which every close
   * path reaches (the cascade fire, the halt flatten, the manual close, the
   * broker reconcile) rather than only the one `markProvenance` covers. Read
   * ONLY as a fallback, strictly after `markProvenance.quoteAtFire`, so the
   * crossed number on a row that already priced is bit-for-bit unchanged.
   */
  exitQuote?: OptionExitQuote | null;
}

/**
 * Long single-leg DEBIT structures: we pay the ask to open and sell the bid to
 * close, so crossed = `(exitBid − entryAsk) × 100 × contracts`. Deliberately
 * the same membership as `GATE_R_BASIS_STRUCTURES` (option-trade-journal.ts)
 * — both sets are "the long single-leg premium sleeves" — duplicated here only
 * to avoid a runtime import cycle; the tra4674 test asserts they stay equal.
 */
export const CROSSED_LONG_PREMIUM_STRUCTURES: ReadonlySet<string> = new Set([
  'single_leg',
  'single_leg_otm',
  'single_leg_rv',
  'single_leg_directional',
  'directional',
]);

/**
 * Short single-leg premium (the wheel): we SELL the bid to open and pay the
 * ask to close, so the convention mirrors: `(entryBid − exitAsk) × 100 ×
 * contracts`. Zero such rows exist in the journal today (measured TRA-2385);
 * the branch exists so the day one appears it is priced with the right sign
 * instead of silently landing in `structure_not_crossable`.
 */
export const CROSSED_SHORT_PREMIUM_STRUCTURES: ReadonlySet<string> = new Set([
  'covered_call',
  'cash_secured_put',
]);

/**
 * Why a row has `crossedPnlUsd: null`. An unpriceable row must be VISIBLY
 * unpriceable — a bare null with no reason is one `?? 0` away from a zero.
 *   • `open_row`                 — no exit yet; nothing to cross.
 *   • `structure_not_crossable`  — multi-leg (spreads, condors, imports): the
 *     row's single two-sided quote cannot price the package, and a wrong-sign
 *     number is worse than none.
 *   • `contracts_unknown`        — pre-TRA-1656 row with no contract count.
 *   • `entry_quote_missing`      — neither the TRA-3990 stamp nor the TRA-1656
 *     snapshot carries a usable entry side (finite, > 0).
 *   • `exit_quote_missing`       — NEITHER `markProvenance.quoteAtFire` NOR the
 *     TRA-4997 close-seam `exitQuote` carries a book: the row closed before
 *     either stamp shipped, or on a path that captured no quote at all.
 *   • `exit_quote_stale`         — TRA-4997: a close-seam `exitQuote` exists but
 *     its `ageMs` exceeds `EXIT_QUOTE_MAX_AGE_MS`. A NAMED refusal, held apart
 *     from `exit_quote_missing` on purpose: "we have a book and it is too old to
 *     price against" and "we never had a book" license different conclusions,
 *     and collapsing them is how a coverage gap reads as a feed outage.
 *   • `exit_quote_unusable`      — a quote was stamped but the side this
 *     structure transacts on is not a positive finite number.
 */
export type CrossedUnpricedReason =
  | 'open_row'
  | 'structure_not_crossable'
  | 'contracts_unknown'
  | 'entry_quote_missing'
  | 'exit_quote_missing'
  | 'exit_quote_stale'
  | 'exit_quote_unusable';

/** Per-row crossed re-pricing, spread onto the `?rows=` dump. */
export interface CrossedRowPricing {
  /**
   * `(exitBid − entryAsk) × 100 × contracts` (long premium; mirrored for
   * short), rounded to cents. `null` — never 0 — when the row cannot be
   * priced; `crossedUnpriced` names why.
   */
  crossedPnlUsd: number | null;
  /** `crossedPnlUsd / atRiskUsd` — same divisor as `realizedR` — 4 dp. */
  crossedR: number | null;
  crossedUnpriced: CrossedUnpricedReason | null;
  /**
   * TRA-4997 — WHICH exit-side book priced this row, `null` when it did not
   * price. `fire_tick` = the quote the closing exit rule itself read (the strong
   * case, and the only one that existed before TRA-4997); `last_known` = the
   * newest usable book before a close path that evaluated no quote of its own.
   *
   * Published per row, and counted on the fold as `pricedByLastKnownQuote`,
   * because the two are indistinguishable in the price itself — a re-grade that
   * wants to discount the weaker half has to be able to partition it.
   */
  crossedExitQuoteSource: 'fire_tick' | 'last_known' | null;
  /** TRA-4997 — `exitQuote.ageMs` of the book that priced it; `null` on a fire-tick or unpriced row. */
  crossedExitQuoteAgeMs: number | null;
}

const roundCents = (v: number): number => Math.round(v * 100) / 100;

const usableSide = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

const unpriced = (reason: CrossedUnpricedReason): CrossedRowPricing => ({
  crossedPnlUsd: null,
  crossedR: null,
  crossedUnpriced: reason,
  crossedExitQuoteSource: null,
  crossedExitQuoteAgeMs: null,
});

/**
 * TRA-4997 — the exit-side book to price this row against, with its provenance.
 *
 * ⛔ The precedence is load-bearing and must not be reordered: the fire-tick
 * quote wins unconditionally, so every row that had a crossed number before
 * TRA-4997 keeps the IDENTICAL one and the fallback can only add coverage.
 * `{ quote: null, reason }` when nothing is usable.
 */
function resolveCrossedExitQuote(row: CrossedPricingRow): {
  quote: { bid: number; ask: number } | null;
  source: 'fire_tick' | 'last_known' | null;
  ageMs: number | null;
  reason: CrossedUnpricedReason | null;
} {
  const fire = row.markProvenance?.quoteAtFire ?? null;
  if (fire !== null && fire !== undefined) {
    return { quote: fire, source: 'fire_tick', ageMs: null, reason: null };
  }
  const stamp = row.exitQuote ?? null;
  if (stamp === null || stamp === undefined) {
    return { quote: null, source: null, ageMs: null, reason: 'exit_quote_missing' };
  }
  // A stamp whose own age is unreadable is treated as stale, not as fresh: the
  // absence of an age is not evidence of a young quote.
  const ageMs = typeof stamp.ageMs === 'number' && Number.isFinite(stamp.ageMs)
    ? stamp.ageMs
    : Number.POSITIVE_INFINITY;
  if (ageMs > EXIT_QUOTE_MAX_AGE_MS) {
    return { quote: null, source: null, ageMs: null, reason: 'exit_quote_stale' };
  }
  return {
    quote: { bid: stamp.bid, ask: stamp.ask },
    source: stamp.source === 'fire_tick' ? 'fire_tick' : 'last_known',
    ageMs,
    reason: null,
  };
}

/** Price ONE row at the cross. Pure; fails to `null` + reason, never to 0. */
export function priceCrossedRow(row: CrossedPricingRow): CrossedRowPricing {
  if (row.outcome === 'OPEN') return unpriced('open_row');
  const long = CROSSED_LONG_PREMIUM_STRUCTURES.has(row.structure);
  const short = !long && CROSSED_SHORT_PREMIUM_STRUCTURES.has(row.structure);
  if (!long && !short) return unpriced('structure_not_crossable');
  const contracts = row.contracts;
  if (typeof contracts !== 'number' || !Number.isFinite(contracts) || !(contracts > 0)) {
    return unpriced('contracts_unknown');
  }
  // Entry side: the TRA-3990 stamp first (broker-submit-superseded on live
  // rows, and the quote `entrySpreadPct` is derived from), then the TRA-1656
  // scanner snapshot for pre-stamp history. Long pays the ask; short sells the bid.
  const entrySide = long
    ? (usableSide(row.entryAskAtOpen) ? row.entryAskAtOpen : usableSide(row.entryAsk) ? row.entryAsk : null)
    : (usableSide(row.entryBidAtOpen) ? row.entryBidAtOpen : usableSide(row.entryBid) ? row.entryBid : null);
  if (entrySide === null) return unpriced('entry_quote_missing');
  // TRA-4997 — fire-tick quote first, close-seam stamp second. See
  // `resolveCrossedExitQuote`: the ordering is what keeps every already-priced
  // row's number identical.
  const resolved = resolveCrossedExitQuote(row);
  if (resolved.quote === null) return unpriced(resolved.reason ?? 'exit_quote_missing');
  // Long sells the exit bid; short buys back the exit ask.
  const exitSide = long ? resolved.quote.bid : resolved.quote.ask;
  if (!usableSide(exitSide)) return unpriced('exit_quote_unusable');
  const crossedPnlUsd = roundCents(
    (long ? exitSide - entrySide : entrySide - exitSide) * 100 * contracts,
  );
  const crossedR =
    typeof row.atRiskUsd === 'number' && Number.isFinite(row.atRiskUsd) && row.atRiskUsd > 0
      ? Math.round((crossedPnlUsd / row.atRiskUsd) * 10_000) / 10_000
      : null;
  return {
    crossedPnlUsd,
    crossedR,
    crossedUnpriced: null,
    crossedExitQuoteSource: resolved.source,
    crossedExitQuoteAgeMs: resolved.ageMs,
  };
}

/**
 * The crossed fold cells, emitted on `summary` and per `byStructure` entry.
 *
 * `crossedPnlUsd` and `bookedPnlUsdPriced` are a MATCHED comparison: both are
 * sums over exactly the `priced` rows, so an unpriceable row moves neither
 * column (it is counted in `unpriced` + `unpricedReasons` instead). When
 * `priced` is 0 every sum is `null` — a fold with nothing priced must not
 * read as a fold that measured $0.
 */
export interface CrossedFoldCells {
  /** Closed rows the re-pricing could price (both quotes + a contract count). */
  priced: number;
  /**
   * TRA-4997 — of `priced`, how many were priced off the FIRE-TICK quote (the
   * book the closing exit rule itself read). Before TRA-4997 this was `priced`
   * by construction; it is published so that stays checkable.
   */
  pricedByFireTickQuote: number;
  /**
   * TRA-4997 — of `priced`, how many were priced off a `last_known` close-seam
   * quote instead. **The discount column.** `pricedByFireTickQuote +
   * pricedByLastKnownQuote === priced`, always. A fold whose coverage is carried
   * by this cell is a weaker measurement than one carried by the other, and
   * there is nothing in `crossedPnlUsd` itself that says which you have.
   */
  pricedByLastKnownQuote: number;
  /**
   * TRA-4997 — mean `ageMs` over the `pricedByLastKnownQuote` rows; `null` when
   * that count is 0 (⛔ never 0 — an unmeasured age must not read as a fresh
   * quote). Seconds-scale ⇒ the fallback resolved inside the closing tick;
   * minutes-scale ⇒ it did not, and the cross is priced against a book that may
   * already have moved.
   */
  lastKnownQuoteMeanAgeMs: number | null;
  /** Closed rows it could not. priced + unpriced === closed, always. */
  unpriced: number;
  /** Census of WHY, by {@link CrossedUnpricedReason}. Sums to `unpriced`. */
  unpricedReasons: Partial<Record<CrossedUnpricedReason, number>>;
  /** Σ crossed P&L over the priced rows; null (never 0) when priced === 0. */
  crossedPnlUsd: number | null;
  /** Σ `realizedPnlUsd` over the SAME priced rows — the matched booked column. */
  bookedPnlUsdPriced: number | null;
  /** `crossedPnlUsd − bookedPnlUsdPriced`: what the spread ate, in USD. */
  spreadDragUsd: number | null;
  /** Mean `crossedR` over priced rows carrying a valid divisor. */
  avgCrossedR: number | null;
  /** How many priced rows carried that divisor (atRiskUsd > 0). */
  crossedRSampled: number;
  /** Sign census of the PRICED rows' crossed P&L (flat = exactly $0.00). */
  win: number;
  loss: number;
  flat: number;
}

/** Fold closed rows into {@link CrossedFoldCells}. Pure. */
export function foldCrossedCells(closedRows: CrossedPricingRow[]): CrossedFoldCells {
  const reasons: Partial<Record<CrossedUnpricedReason, number>> = {};
  let priced = 0;
  let crossedSum = 0;
  let bookedSum = 0;
  let win = 0;
  let loss = 0;
  let flat = 0;
  let pricedByFireTickQuote = 0;
  const lastKnownAges: number[] = [];
  const crossedRs: number[] = [];
  for (const row of closedRows) {
    const p = priceCrossedRow(row);
    if (p.crossedPnlUsd === null) {
      const reason = p.crossedUnpriced ?? 'exit_quote_missing';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      continue;
    }
    priced += 1;
    // TRA-4997 — partition the coverage by WHICH book priced it. Exhaustive by
    // construction: a priced row always carries a source.
    if (p.crossedExitQuoteSource === 'last_known') {
      lastKnownAges.push(p.crossedExitQuoteAgeMs ?? 0);
    } else {
      pricedByFireTickQuote += 1;
    }
    crossedSum += p.crossedPnlUsd;
    // The matched booked column: THIS row's booked P&L, because this row
    // priced. A row that did not price contributes to neither sum.
    bookedSum += row.realizedPnlUsd ?? 0;
    if (p.crossedPnlUsd > 0) win += 1;
    else if (p.crossedPnlUsd < 0) loss += 1;
    else flat += 1;
    if (p.crossedR !== null) crossedRs.push(p.crossedR);
  }
  const crossedPnlUsd = priced > 0 ? roundCents(crossedSum) : null;
  const bookedPnlUsdPriced = priced > 0 ? roundCents(bookedSum) : null;
  return {
    priced,
    pricedByFireTickQuote,
    pricedByLastKnownQuote: lastKnownAges.length,
    lastKnownQuoteMeanAgeMs:
      lastKnownAges.length > 0
        ? Math.round(lastKnownAges.reduce((a, v) => a + v, 0) / lastKnownAges.length)
        : null,
    unpriced: closedRows.length - priced,
    unpricedReasons: reasons,
    crossedPnlUsd,
    bookedPnlUsdPriced,
    spreadDragUsd:
      crossedPnlUsd !== null && bookedPnlUsdPriced !== null
        ? roundCents(crossedPnlUsd - bookedPnlUsdPriced)
        : null,
    avgCrossedR:
      crossedRs.length > 0 ? crossedRs.reduce((a, v) => a + v, 0) / crossedRs.length : null,
    crossedRSampled: crossedRs.length,
    win,
    loss,
    flat,
  };
}

/**
 * Distribution of one spread column over the rows that carry it. Values are
 * FRACTIONS, the `entrySpreadPct` convention (0.0592 = 5.92%). All null when
 * `sampled` is 0 — an unmeasured spread must never read as a tight one.
 */
export interface SpreadFoldStat {
  sampled: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

/** Entry- and exit-side spread stats for the summary fold (TRA-4674 "also useful"). */
export interface SpreadFoldCells {
  /** Entry spread over closed rows carrying a measured entry quote. */
  entry: SpreadFoldStat;
  /** Exit spread over closed rows carrying `markProvenance.quoteAtFire`. */
  exit: SpreadFoldStat;
}

function spreadStat(values: number[]): SpreadFoldStat {
  if (values.length === 0) return { sampled: 0, mean: null, median: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return {
    sampled: sorted.length,
    mean: sorted.reduce((a, v) => a + v, 0) / sorted.length,
    median: sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

/**
 * Fold closed rows into entry/exit spread distributions, so an entry-side
 * spread bar can be graded off `summary` without a full row dump. Entry reads
 * the row's own `entrySpreadPct` when the stamp carried one, else derives it
 * from whichever quote pair the row holds (stamp, then TRA-1656 snapshot) —
 * the same precedence the crossed pricing uses. Pure.
 */
export function foldSpreadCells(closedRows: CrossedPricingRow[]): SpreadFoldCells {
  const entry: number[] = [];
  const exit: number[] = [];
  for (const row of closedRows) {
    const stamped =
      typeof row.entrySpreadPct === 'number' && Number.isFinite(row.entrySpreadPct)
        ? row.entrySpreadPct
        : (deriveEntrySpreadPct(row.entryBidAtOpen, row.entryAskAtOpen)
          ?? deriveEntrySpreadPct(row.entryBid, row.entryAsk));
    if (stamped !== null && stamped !== undefined) entry.push(stamped);
    // TRA-4997 — the same precedence the crossed pricing uses, so the exit-side
    // spread distribution is measured over exactly the rows the cross priced
    // rather than over a narrower set.
    const quote = resolveCrossedExitQuote(row).quote;
    const exitSpread = quote ? deriveEntrySpreadPct(quote.bid, quote.ask) : null;
    if (exitSpread !== null) exit.push(exitSpread);
  }
  return { entry: spreadStat(entry), exit: spreadStat(exit) };
}
