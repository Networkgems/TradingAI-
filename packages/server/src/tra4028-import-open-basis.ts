// TRA-4028 (parent TRA-3989) — what an IMPORTED / ADOPTED lot's journal OPEN row
// should carry as `atRiskUsd`, and where that figure came from.
//
// ── The measured defect (bqb1, BAC260925C00063000, admin book) ───────────────
//
// On 2026-08-21T17:06:09.836Z the reconciler minted journal row `6bbc5d17` for
// the desk's residual BAC lot with `atRiskUsd 141`. Nothing on the ledger ever
// traded at 1.41. Tradier's `/positions` is ONE row per OCC and its
// `cost_basis / quantity` is an AVERAGE across every contract in the account on
// that symbol: the engine's `buy_to_open` 1 @ 1.65 (order 142603649) and the
// desk's hand-placed 1 @ 1.17 (`history_import`) blend to (1.65 + 1.17) / 2 =
// 1.41, and after the engine sold ITS contract the broker still reported the
// residual contract at the blend. `queueJournalImportOpen` copied
// `premiumPaid × contracts × 100` off that row and wrote $141 as the basis every
// R on the row divides by. The lot's real exit (−$3.00, TRA-4004) then graded
// at −0.021 instead of −0.026 — a 20% denominator error on a real-money row,
// published as the REFERENCE basis while the export copied it faithfully.
//
// The ledger held the desk's 1.17 fill the whole time. The mint just never asked.
//
// ── The rule ─────────────────────────────────────────────────────────────────
//
// An import row's basis comes from the ledger's own `buy_to_open` fill(s) when
// one is ATTRIBUTABLE to the lot, and from the figure the book row carries (the
// mark, or the broker's blend) otherwise — AND the row says which
// (`atRiskBasis: 'fill' | 'mark'`), so a mark basis can never again pass for a
// measured one.
//
// "Attributable" is the TRA-3986 sibling-claim rule, not a time window: the
// desk's `history_import` fill carries a synthetic 17:00:00Z stamp, so the
// 10-minute `ENTRY_MATCH_WINDOW_MS` that pairs an ENGINE row with its fill can
// never pair a desk lot with its own. Instead every OTHER journal row on the
// contract claims what is its own first (its entry inside the window, its exit
// by order id / millisecond), and the fill remainder is this lot's iff it
// covers the lot EXACTLY. Short means a contract we cannot price; excess means
// two or more unclaimed buys and no way to say which one is this lot's;
// an unclaimed `sell_to_close` means some contract left the account through
// no row we know of and which buy it consumed is unknowable. Every one of
// those is `'mark'`, with the reason on the row — never a guess that happens
// to be right on the fixture.
//
// Two sources rank ABOVE the ledger allocation because they already name a
// fill: a TRA-3958 operator pin (the operator's citation is on the row) and a
// TRA-3909 desk-add mint priced from the TRA-3939 capture (`basisSource:
// 'capture_fill'`, with its order ids).
//
// PURE — no IO, no clock, no module state — so the mint's decision is gradeable
// from its inputs (AC4) and the same function can replay a historical row.
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import { claimFillsBySiblingRows } from './tra3485-stale-open-repair.js';

export type ImportOpenAtRiskBasis = 'fill' | 'mark';

/** Why a fill basis could NOT be established; `null` on `'fill'`. */
export type ImportOpenMarkReason =
  | 'demo_book'
  | 'no_contract_identity'
  | 'no_ledger_fills'
  | 'unclaimed_sells'
  | 'unpriced_fill'
  | 'no_unclaimed_buys'
  | 'remainder_short'
  | 'remainder_excess';

export interface ImportOpenBasisInput {
  /** The journal id the row will be written under. Never a claimant against itself. */
  id: string;
  optionSymbol: string | undefined;
  mode: 'demo' | 'live';
  contracts: number;
  /**
   * The per-contract figure the BOOK row carries at the mint: the broker's
   * OCC-level blend on a plain reconcile import, the residual identity on a
   * TRA-3909 desk-add, the operator's figure under a TRA-3958 pin.
   */
  premiumPaid: number;
  deskAddBasis?: { source: 'capture_fill' | 'residual_identity'; orderIds: number[] } | undefined;
  operatorBasisPin?: { premiumPaid: number; contracts: number; provenance: string } | undefined;
}

export interface ImportOpenBasis {
  /** The figure to write. */
  atRiskUsd: number;
  atRiskBasis: ImportOpenAtRiskBasis;
  /** `atRiskUsd / (contracts × 100)` — the per-contract basis, for the log. */
  premiumPerContract: number;
  /** The source, named: `ledger_fill:…`, `operator_pin:…`, `desk_add_capture:…`, `mark:<reason>`. */
  atRiskProvenance: string;
  /** Fills the allocation consumed; empty on `'mark'` and on the two pre-ranked sources. */
  fills: Array<{ ts: number; contracts: number; filledPrice: number; orderId: number | null; origin: string }>;
  markReason: ImportOpenMarkReason | null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function resolveImportOpenBasis(
  input: ImportOpenBasisInput,
  /** Every journal row on the contract in the row's mode — OPEN and CLOSED — including or excluding `input.id`. */
  siblingRows: readonly OptionTradeJournalRecord[],
  /** The ledger's fills on the contract (any order; filtered to the OCC again here). */
  fills: readonly LiveOptionFillRecord[],
): ImportOpenBasis {
  const contracts = input.contracts;
  const bookUsd = round2(input.premiumPaid * contracts * 100);
  const mark = (reason: ImportOpenMarkReason): ImportOpenBasis => ({
    atRiskUsd: bookUsd,
    atRiskBasis: 'mark',
    premiumPerContract: input.premiumPaid,
    atRiskProvenance: `mark:${reason}`,
    fills: [],
    markReason: reason,
  });

  // ── Sources that already NAME a fill outrank the allocation ────────────────
  const pin = input.operatorBasisPin;
  if (pin && Number.isFinite(pin.premiumPaid) && pin.premiumPaid > 0) {
    return {
      atRiskUsd: round2(pin.premiumPaid * contracts * 100),
      atRiskBasis: 'fill',
      premiumPerContract: pin.premiumPaid,
      atRiskProvenance: `operator_pin:${pin.provenance}`,
      fills: [],
      markReason: null,
    };
  }
  const desk = input.deskAddBasis;
  if (desk && desk.source === 'capture_fill' && Number.isFinite(input.premiumPaid) && input.premiumPaid > 0) {
    return {
      atRiskUsd: bookUsd,
      atRiskBasis: 'fill',
      premiumPerContract: input.premiumPaid,
      atRiskProvenance: `desk_add_capture:${desk.orderIds.join('+') || 'unnumbered'}`,
      fills: [],
      markReason: null,
    };
  }

  // ── The ledger allocation ──────────────────────────────────────────────────
  if (input.mode !== 'live') return mark('demo_book');
  const occ = input.optionSymbol;
  if (!occ) return mark('no_contract_identity');
  const onOcc = fills.filter((f) => f.optionSymbol === occ && f.mode === 'live');
  if (onOcc.length === 0) return mark('no_ledger_fills');
  if (!(Number.isFinite(contracts) && contracts > 0)) return mark('no_contract_identity');

  const byContract = new Map<string, LiveOptionFillRecord[]>([[occ, onOcc]]);
  const claims = claimFillsBySiblingRows(
    siblingRows.filter((r) => r.id !== input.id),
    byContract,
  );
  const left = (f: LiveOptionFillRecord): number => f.contracts - (claims.get(f)?.total ?? 0);

  // A sell nobody accounts for: some contract left the account and which buy
  // it consumed is unknowable, so no buy remainder below is safely this lot's.
  if (onOcc.some((f) => f.side === 'sell_to_close' && left(f) > 0)) return mark('unclaimed_sells');

  const buys = onOcc
    .filter((f) => f.side === 'buy_to_open')
    .map((f) => ({ f, n: left(f) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => a.f.ts - b.f.ts);
  if (buys.length === 0) return mark('no_unclaimed_buys');
  if (buys.some((x) => !(typeof x.f.filledPrice === 'number' && Number.isFinite(x.f.filledPrice) && x.f.filledPrice > 0))) {
    return mark('unpriced_fill');
  }
  const remainder = buys.reduce((s, x) => s + x.n, 0);
  if (remainder < contracts) return mark('remainder_short');
  if (remainder > contracts) return mark('remainder_excess');

  const costUsd = buys.reduce((s, x) => s + (x.f.filledPrice as number) * x.n * 100, 0);
  const atRiskUsd = round2(costUsd);
  return {
    atRiskUsd,
    atRiskBasis: 'fill',
    premiumPerContract: Math.round((costUsd / (contracts * 100)) * 1e6) / 1e6,
    atRiskProvenance: `ledger_fill:${buys.map((x) => (x.f.orderId ?? x.f.origin)).join('+')}`,
    fills: buys.map((x) => ({
      ts: x.f.ts,
      contracts: x.n,
      filledPrice: x.f.filledPrice as number,
      orderId: x.f.orderId ?? null,
      origin: x.f.origin,
    })),
    markReason: null,
  };
}
