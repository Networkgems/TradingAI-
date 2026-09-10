/**
 * TRA-4506 (filed by CFO off TRA-4245) — the stock-leg probe's MISSING OPERANDS.
 *
 * The probe on a live broker-shaped row is
 *
 *     stockLegProbeUsd = dEquity − optionsDaily − netCashFlow − dOpenOptionMark
 *
 * and it pinned three marked dates RED that were not stock motion at all. Each
 * one is a term the identity never had, reconciled to the cent against Tradier
 * account ***0154 on 2026-09-10:
 *
 *  1. admin 2026-09-03, −10.12 — a broker `fee` of −10.00 and nothing else. TRA-2906
 *     ruled (correctly) that a fee stays IN P&L, so `netCashFlowUsd` excludes it by
 *     design — and the probe had no other slot for it. {@link sumBrokerFeesOverSpan}.
 *
 *  3. admin 2026-08-26, −5.50 of it — the mark differences Tradier's AVERAGE cost
 *     basis while `optionsDaily` realizes the LEDGER lot. After the 08-24
 *     re-buy-while-held, `/positions` averaged the two RIG lots ((33 + 22) / 2 =
 *     27.50 on the remaining contract) against the lot's own 22.00, and the 5.50
 *     landed on whichever day the lot left the book. {@link resolveOptionBasisShift}.
 *
 *  4. v0nni 2026-08-25, −1.34 — fee dust. `optionsDaily` books GROSS while equity
 *     moves net of every fill's commission, so the tolerance was crossed on the one
 *     three-fill day. {@link datedOptionTradeFeesOverSpan}. NOT a wider tolerance.
 *
 * (Item 2 is a mis-booked row, restated in `options-daily-pnl-source.ts`.)
 *
 * ── Why these are computed at READ time ──────────────────────────────────────
 *
 * The probe is stamped on the row at 21:00 ET and the row is frozen (the
 * TRA-2886/2888 refusal to restate banked rows stands). So every operand here is
 * derived from a DURABLE, per-book store the route already holds — the typed
 * cash-event record, the EOD mark file, the option-trade journal — and published
 * per row BESIDE the writer's own number, never written back into it. The 30-day
 * fee/slippage ledger was rejected as a source: it evaporates, and every fill on it
 * before 2026-08-27 carries `book: null` (TRA-3977), so it can neither date nor
 * attribute the 08-25 fills this ticket grades.
 *
 * Every operand is `null` — NOT MEASURED — rather than `0` when its store cannot
 * answer. `0` is the "nothing happened" reading, the one a failed read must never
 * impersonate.
 *
 * Pure; the caller supplies the stores.
 */
import { isCapitalMovement } from '@trading-app/engine';

const round2 = (n: number): number => Math.round(n * 100) / 100;

const finitePositive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/** One typed broker cash event (`tradier-cash-flow.<env>.json`, v2-typed schema). */
export interface ProbeCashEvent {
  date: string;
  type: string;
  amount: number;
}

/**
 * The fields of an option-trade journal row the operands read. Structural, so a
 * fixture and the real `OptionTradeJournalRecord` both satisfy it.
 */
export interface ProbeJournalLot {
  mode?: string;
  optionSymbol?: string;
  contracts?: number;
  openTs?: number;
  closeTs?: number;
  entryBasisPremium?: number;
  entryFillPremium?: number;
  atRiskUsd?: number;
  atRiskBasis?: string;
  feesUsd?: number;
  pnlBasis?: string;
  partials?: ReadonlyArray<{ ts: number; contracts: number }>;
}

/** The two fields of an EOD mark capture the basis shift reads. */
export interface ProbeMarkCapture {
  /** Σ Tradier `/positions` `cost_basis` over open long options — the BROKER basis. */
  costBasisUsd: number;
  /** Open long option positions (one per OCC symbol) the capture counted. */
  positionCount: number;
}

// ── AC1 — the broker-fee operand ────────────────────────────────────────────

/**
 * Σ of the events {@link isCapitalMovement} REJECTS (today exactly `fee`) over the
 * half-open span `(afterDate, throughDate]` — the SAME span, and the complement of
 * the SAME predicate, that `netCashFlowUsd` sums. Together the two account for
 * every non-trade event exactly once.
 *
 * Signed as the broker posts it: a $10 fee is `−10`. The probe subtracts it like
 * every other operand, so a fee day reads its residual, not the fee.
 *
 * ⛔ This does NOT move fees into `netCashFlowUsd`. TRA-2906's ruling stands: a fee
 * is a cost of operating and stays in P&L. This is an operand of the PROBE only.
 */
export function sumBrokerFeesOverSpan(
  events: ReadonlyArray<ProbeCashEvent>,
  afterDate: string,
  throughDate: string,
): number {
  let total = 0;
  for (const ev of events) {
    if (ev.date <= afterDate || ev.date > throughDate) continue;
    if (isCapitalMovement(ev.type)) continue;
    if (typeof ev.amount !== 'number' || !Number.isFinite(ev.amount)) continue;
    total += ev.amount;
  }
  return round2(total);
}

/**
 * Σ of the capital-movement events over the same span — what a v2-typed record
 * says `netCashFlowUsd` SHOULD be. Carried so the reader can prove a row's stored
 * flow EXCLUDES the fee before subtracting it: a row written while the record was
 * still `v1-aggregate` baked its fees INTO the flow, and subtracting them again
 * would book each one twice.
 */
export function sumCapitalFlowOverSpan(
  events: ReadonlyArray<ProbeCashEvent>,
  afterDate: string,
  throughDate: string,
): number {
  let total = 0;
  for (const ev of events) {
    if (ev.date <= afterDate || ev.date > throughDate) continue;
    if (!isCapitalMovement(ev.type)) continue;
    if (typeof ev.amount !== 'number' || !Number.isFinite(ev.amount)) continue;
    total += ev.amount;
  }
  return round2(total);
}

// ── AC3 — the mark's basis shift ────────────────────────────────────────────

function lotContracts(l: ProbeJournalLot): number | null {
  return finitePositive(l.contracts) ? l.contracts : null;
}

/**
 * The ledger's per-share entry premium for one lot, GROSS of fees — the basis
 * `optionsDaily` realizes against. Preference order:
 *
 *  1. `entryBasisPremium` — the book's basis the close CONSUMED (TRA-4031), i.e.
 *     the exact figure the booked realized P&L was computed from.
 *  2. `entryFillPremium` — the volume-weighted broker entry fill (TRA-2819).
 *  3. `atRiskUsd ÷ (contracts × 100)`, ONLY when `atRiskBasis === 'fill'` (TRA-4028).
 *
 * Nothing else. An engine row's bare `atRiskUsd` is the pre-trade MID, and an
 * import's `'mark'` basis is the broker's OWN average — pricing a lot off that
 * would make the ledger basis equal the broker basis by construction and hide the
 * very shift this measures. Such a lot is UNPRICED, and the shift is NOT MEASURED.
 */
export function lotEntryPremium(l: ProbeJournalLot): number | null {
  if (finitePositive(l.entryBasisPremium)) return l.entryBasisPremium;
  if (finitePositive(l.entryFillPremium)) return l.entryFillPremium;
  const c = lotContracts(l);
  if (l.atRiskBasis === 'fill' && finitePositive(l.atRiskUsd) && c !== null) {
    return l.atRiskUsd / (c * 100);
  }
  return null;
}

export type OptionBasisShiftNotMeasuredReason =
  /** No journal census for this book. */
  | 'no-journal'
  /** No EOD mark capture on one endpoint, so there is no broker basis to compare. */
  | 'mark-not-captured'
  /** A lot open at an endpoint has no ledger price (see {@link lotEntryPremium}). */
  | 'lot-unpriced'
  /** A lot open at an endpoint carries no usable `contracts`. */
  | 'lot-contracts-unknown'
  /**
   * The journal's open OCC symbols at an endpoint do not match the broker's
   * position count. The ledger basis would then be stated over a different
   * population than the broker's, and the "shift" would be a missing (or extra)
   * lot's whole cost. Refused rather than published.
   */
  | 'position-count-mismatch';

/**
 * The LEDGER's cost of the option lots open at the END of ET day `date`: Σ over
 * live lots of remaining contracts × {@link lotEntryPremium} × 100.
 *
 * Open-ness is judged by ET DATE, never by intraday order. A reconciler mint can
 * carry an `openTs` DAYS off the real fill (the desk RIG re-buy, bought 08-24, is
 * journalled 08-21 14:04 — copied off the lot it replaced), so intraday ordering
 * against it is meaningless; at an END-OF-DAY instant only the date matters.
 */
export function ledgerOpenOptionBasisAt(
  lots: ReadonlyArray<ProbeJournalLot>,
  date: string,
  etDate: (ts: number) => string,
):
  | { ok: true; costUsd: number; symbolCount: number }
  | { ok: false; reason: 'lot-unpriced' | 'lot-contracts-unknown' } {
  let costUsd = 0;
  const symbols = new Set<string>();
  for (const l of lots) {
    if (l.mode !== 'live' || !l.optionSymbol) continue;
    if (typeof l.openTs !== 'number' || !Number.isFinite(l.openTs)) continue;
    if (etDate(l.openTs) > date) continue;
    if (typeof l.closeTs === 'number' && Number.isFinite(l.closeTs) && etDate(l.closeTs) <= date) continue;
    const c = lotContracts(l);
    if (c === null) return { ok: false, reason: 'lot-contracts-unknown' };
    let sold = 0;
    for (const p of l.partials ?? []) {
      if (typeof p?.ts !== 'number' || !Number.isFinite(p.ts)) continue;
      if (!finitePositive(p.contracts)) continue;
      if (etDate(p.ts) <= date) sold += p.contracts;
    }
    const remaining = c - sold;
    if (remaining <= 0) continue;
    const px = lotEntryPremium(l);
    if (px === null) return { ok: false, reason: 'lot-unpriced' };
    costUsd += px * remaining * 100;
    symbols.add(l.optionSymbol);
  }
  return { ok: true, costUsd: round2(costUsd), symbolCount: symbols.size };
}

/** `brokerBasis − ledgerBasis` at the end of `date`, or why it cannot be stated. */
export function optionBasisGapAt(
  marks: Readonly<Record<string, ProbeMarkCapture>>,
  lots: ReadonlyArray<ProbeJournalLot>,
  date: string,
  etDate: (ts: number) => string,
): { gapUsd: number; reason: null } | { gapUsd: null; reason: OptionBasisShiftNotMeasuredReason } {
  const m = marks[date];
  if (!m || !Number.isFinite(m.costBasisUsd) || !Number.isFinite(m.positionCount)) {
    return { gapUsd: null, reason: 'mark-not-captured' };
  }
  const ledger = ledgerOpenOptionBasisAt(lots, date, etDate);
  if (!ledger.ok) return { gapUsd: null, reason: ledger.reason };
  if (ledger.symbolCount !== m.positionCount) {
    return { gapUsd: null, reason: 'position-count-mismatch' };
  }
  return { gapUsd: round2(m.costBasisUsd - ledger.costUsd), reason: null };
}

/**
 * The BASIS-SHIFT operand over `(prevDate, date]`: the change in
 * `brokerBasis − ledgerBasis` across the span.
 *
 * `dOpenOptionMark` is `Δ(marketValue − brokerBasis)`. Re-stated on the ledger's
 * basis it is `Δ(marketValue − ledgerBasis)`, which is the broker figure PLUS this
 * shift — so subtracting it from the probe differences the mark on the same lot
 * `optionsDaily` realized. Wherever the broker basis equals the ledger basis (every
 * single-lot position, and every multi-lot one before a partial sale) the gap is
 * constant and the shift is exactly 0; it is non-zero only where the broker
 * averaged lots the ledger keeps apart, and it nets to 0 over the averaged lot's
 * life.
 *
 * Live: admin RIG, 08-25 gap +5.50 (27.50 broker vs 22.00 ledger), 08-26 gap 0.00
 * (flat) ⇒ shift −5.50 on 08-26, the day the averaged lot left the book.
 */
export function resolveOptionBasisShift(
  marks: Readonly<Record<string, ProbeMarkCapture>>,
  lots: ReadonlyArray<ProbeJournalLot>,
  date: string,
  prevDate: string,
  etDate: (ts: number) => string,
): { shiftUsd: number; reason: null } | { shiftUsd: null; reason: OptionBasisShiftNotMeasuredReason } {
  const now = optionBasisGapAt(marks, lots, date, etDate);
  if (now.reason !== null) return { shiftUsd: null, reason: now.reason };
  const prev = optionBasisGapAt(marks, lots, prevDate, etDate);
  if (prev.reason !== null) return { shiftUsd: null, reason: prev.reason };
  return { shiftUsd: round2(now.gapUsd - prev.gapUsd), reason: null };
}

// ── AC4 — the dated trade-fee operand ───────────────────────────────────────

export type TradeFeeNotMeasuredReason =
  /** No journal census for this book. */
  | 'no-journal'
  /**
   * A lot filled inside the span but carries no MEASURED fees: `pnlBasis` is not
   * `'broker-fill'` (the TRA-2819 restatement never ran on it — an import, a lot
   * still open, or one whose fills read `fees: null`). Partial knowledge is not
   * published as a total: the operand is all-or-nothing per span.
   */
  | 'lot-fees-unmeasured'
  /** A lot filled inside the span carries no usable `contracts`. */
  | 'lot-contracts-unknown';

/**
 * The TRADE-FEE operand over `(afterDate, throughDate]`: −Σ broker commission on
 * every option fill dated inside the span, signed as a cost.
 *
 * `optionsDaily` is booked GROSS (the 21:00 ET writer books the journal figure
 * before the TRA-2819 fee restatement has run), while equity moves net of each
 * fill's commission ON THE FILL'S DAY — the entry fee on the entry day, the exit
 * fee on the exit day. So every fill leaves its fee in the probe. Measured on
 * v0nni's other seven marked days: 1-fill days −0.48/−0.52, 2-fill days
 * −0.88/−0.92; 08-25 (1 exit, 2 entries) −1.34, the only day over $1.
 *
 * Source: a lot's `feesUsd`, which TRA-2819 sets ONLY beside `pnlBasis:
 * 'broker-fill'` and never zero-fills. It is the lot's round-trip total, so it is
 * allocated PER CONTRACT-FILL (`feesUsd ÷ 2·contracts` per contract, entry and
 * exit alike) — Tradier charges per contract. The allocation can misplace a
 * regulatory cent between the two legs (admin pays 0.11 in, 0.13 out) and cannot
 * lose one: a lot's allocations sum to its `feesUsd` exactly.
 */
export function datedOptionTradeFeesOverSpan(
  lots: ReadonlyArray<ProbeJournalLot>,
  afterDate: string,
  throughDate: string,
  etDate: (ts: number) => string,
):
  | { feeUsd: number; reason: null }
  | { feeUsd: null; reason: 'lot-fees-unmeasured' | 'lot-contracts-unknown' } {
  const inSpan = (d: string): boolean => d > afterDate && d <= throughDate;
  let total = 0;
  for (const l of lots) {
    if (l.mode !== 'live') continue;
    if (typeof l.openTs !== 'number' || !Number.isFinite(l.openTs)) continue;
    const c = lotContracts(l);
    // The fills this lot made, dated. Partials first so the close carries only
    // the contracts the slices left.
    const fills: Array<{ day: string; qty: number | null }> = [{ day: etDate(l.openTs), qty: c }];
    let sliced = 0;
    for (const p of l.partials ?? []) {
      if (typeof p?.ts !== 'number' || !Number.isFinite(p.ts) || !finitePositive(p.contracts)) continue;
      sliced += p.contracts;
      fills.push({ day: etDate(p.ts), qty: p.contracts });
    }
    if (typeof l.closeTs === 'number' && Number.isFinite(l.closeTs)) {
      fills.push({ day: etDate(l.closeTs), qty: c === null ? null : c - sliced });
    }
    const inside = fills.filter(f => inSpan(f.day));
    if (inside.length === 0) continue;
    if (c === null) return { feeUsd: null, reason: 'lot-contracts-unknown' };
    if (
      l.pnlBasis !== 'broker-fill'
      || typeof l.feesUsd !== 'number' || !Number.isFinite(l.feesUsd) || l.feesUsd < 0
    ) {
      return { feeUsd: null, reason: 'lot-fees-unmeasured' };
    }
    const perContractFill = l.feesUsd / (2 * c);
    for (const f of inside) total -= perContractFill * Math.max(0, f.qty ?? 0);
  }
  return { feeUsd: round2(total), reason: null };
}

// ── The per-row fold the route consumes ─────────────────────────────────────

/**
 * Every read-time operand for ONE row, over `(previous row's date, date]`.
 * `null` fields are NOT MEASURED and carry a reason where one is nameable.
 */
export interface StockLegProbeReadOperands {
  /** Capital-movement flow the typed record states for the span; `null` = no typed record. */
  capitalFlowUsd: number | null;
  /** AC1 — {@link sumBrokerFeesOverSpan}; `null` = no typed record (a v1 file baked fees into the flow). */
  brokerFeeUsd: number | null;
  /** AC3 — {@link resolveOptionBasisShift}. */
  basisShiftUsd: number | null;
  basisShiftReason: OptionBasisShiftNotMeasuredReason | null;
  /** AC4 — {@link datedOptionTradeFeesOverSpan}. */
  tradeFeeUsd: number | null;
  tradeFeeReason: TradeFeeNotMeasuredReason | null;
}

/**
 * Build the operands for every row of one live book. The first date has no
 * predecessor and gets no entry — the reader then applies nothing to it, exactly
 * as the writer could not difference anything on a book's first row.
 */
export function buildStockLegProbeReadOperands(args: {
  dates: ReadonlyArray<string>;
  /** v2-typed cash events, or `null` when the record is v1-aggregate / absent. */
  cashEvents: ReadonlyArray<ProbeCashEvent> | null;
  /** `tradier-eod-option-mark.<env>.json`, parsed; `null` = unreadable. */
  marks: Readonly<Record<string, ProbeMarkCapture>> | null;
  /** This book's journal rows (`journalRowsForBook`); `null` = no census. */
  lots: ReadonlyArray<ProbeJournalLot> | null;
  etDate: (ts: number) => string;
}): Map<string, StockLegProbeReadOperands> {
  const { cashEvents, marks, lots, etDate } = args;
  const dates = [...new Set(args.dates)].sort();
  const out = new Map<string, StockLegProbeReadOperands>();
  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1];
    const date = dates[i];
    const shift = lots === null
      ? { shiftUsd: null, reason: 'no-journal' as const }
      : marks === null
        ? { shiftUsd: null, reason: 'mark-not-captured' as const }
        : resolveOptionBasisShift(marks, lots, date, prev, etDate);
    const fees = lots === null
      ? { feeUsd: null, reason: 'no-journal' as const }
      : datedOptionTradeFeesOverSpan(lots, prev, date, etDate);
    out.set(date, {
      capitalFlowUsd: cashEvents === null ? null : sumCapitalFlowOverSpan(cashEvents, prev, date),
      brokerFeeUsd: cashEvents === null ? null : sumBrokerFeesOverSpan(cashEvents, prev, date),
      basisShiftUsd: shift.shiftUsd,
      basisShiftReason: shift.reason,
      tradeFeeUsd: fees.feeUsd,
      tradeFeeReason: fees.reason,
    });
  }
  return out;
}
