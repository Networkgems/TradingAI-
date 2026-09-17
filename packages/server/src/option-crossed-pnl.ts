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

import { deriveEntrySpreadPct } from '@trading-app/shared';

/**
 * The structural slice of a journal record this module reads. Kept structural
 * (same pattern as `journalIdForPosition`) so this module has no import back
 * into `option-trade-journal.ts` — which imports THIS module for the summary
 * fold — and so any reader holding these fields can price a row.
 */
export interface CrossedPricingRow {
  outcome: 'OPEN' | 'WIN' | 'LOSS' | 'SCRATCH';
  structure: string;
  contracts?: number;
  atRiskUsd: number;
  realizedPnlUsd?: number;
  /** TRA-3990 stamp — broker-submit-superseded on live rows; preferred. */
  entryBidAtOpen?: number | null;
  entryAskAtOpen?: number | null;
  entrySpreadPct?: number | null;
  /** TRA-1656 scanner snapshot — the pre-stamp fallback. */
  entryBid?: number;
  entryAsk?: number;
  markProvenance?: { quoteAtFire: { bid: number; ask: number } | null } | null;
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
 *   • `exit_quote_missing`       — no `markProvenance.quoteAtFire` (row closed
 *     before TRA-4055, or by a path that never evaluated a mark).
 *   • `exit_quote_unusable`      — a quote was stamped but the side this
 *     structure transacts on is not a positive finite number.
 */
export type CrossedUnpricedReason =
  | 'open_row'
  | 'structure_not_crossable'
  | 'contracts_unknown'
  | 'entry_quote_missing'
  | 'exit_quote_missing'
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
}

const roundCents = (v: number): number => Math.round(v * 100) / 100;

const usableSide = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

const unpriced = (reason: CrossedUnpricedReason): CrossedRowPricing => ({
  crossedPnlUsd: null,
  crossedR: null,
  crossedUnpriced: reason,
});

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
  const quote = row.markProvenance?.quoteAtFire ?? null;
  if (quote === null || quote === undefined) return unpriced('exit_quote_missing');
  // Long sells the exit bid; short buys back the exit ask.
  const exitSide = long ? quote.bid : quote.ask;
  if (!usableSide(exitSide)) return unpriced('exit_quote_unusable');
  const crossedPnlUsd = roundCents(
    (long ? exitSide - entrySide : entrySide - exitSide) * 100 * contracts,
  );
  const crossedR =
    typeof row.atRiskUsd === 'number' && Number.isFinite(row.atRiskUsd) && row.atRiskUsd > 0
      ? Math.round((crossedPnlUsd / row.atRiskUsd) * 10_000) / 10_000
      : null;
  return { crossedPnlUsd, crossedR, crossedUnpriced: null };
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
  const crossedRs: number[] = [];
  for (const row of closedRows) {
    const p = priceCrossedRow(row);
    if (p.crossedPnlUsd === null) {
      const reason = p.crossedUnpriced ?? 'exit_quote_missing';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      continue;
    }
    priced += 1;
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
    const quote = row.markProvenance?.quoteAtFire;
    const exitSpread = quote ? deriveEntrySpreadPct(quote.bid, quote.ask) : null;
    if (exitSpread !== null) exit.push(exitSpread);
  }
  return { entry: spreadStat(entry), exit: spreadStat(exit) };
}
