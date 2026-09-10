import type { Position, OptionPosition, AccountMode } from '@trading-app/shared';
// TRA-3930 — the canonical book↔journal id join; see `option-trade-journal.ts`.
import { journalIdForPosition } from './option-trade-journal.js';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-564 (parent TRA-410 §2.3/§2.4, B1) — trade-history export serializer.
//
// Pure, UI-free, fully unit-testable. The HTTP route in `index.ts` loads the
// per-user closed-trade buckets from `trade-store` and hands them to
// `buildExport`, which normalises every market into one flat `ExportTradeRow`
// shape, applies the requested filters, and produces either CSV or a JSON
// document with a summary header.
//
// Field notes:
//   * fees_usd — SCOPED, since TRA-3864, to BOOK-SOURCED rows only. On a row
//     built from `Position` / `OptionPosition` (`rowFromStock`, `rowFromCrypto`,
//     `rowFromOption`) the engine records no per-trade commission, so `fees_usd`
//     is 0 and `gross_pnl_usd === net_pnl_usd === pnl`. That was the whole of
//     this route's input when the note was written and it is still true of the
//     book. It is NOT true of the option-trade JOURNAL, which has carried a
//     measured `feesUsd` on every TRA-2819 close-basis restatement since
//     2026-08-06 — and `rowFromJournalRecord` (`export-history.ts`) inherited
//     this premise along with the row shape, publishing `fees_usd: 0` and a
//     `gross` equal to `net` on a row whose fee was measured at $0.23. See
//     {@link rowFromJournalRecord}: journal-sourced rows now carry the measured
//     fee, and `gross_pnl_usd = net_pnl_usd + fees_usd` there is an identity
//     with content rather than a vacuous one.
//     Residual, deliberately NOT papered over: a journal row with no
//     `pnlBasis: 'broker-fill'` carries no fee MEASUREMENT at all, and exports 0
//     — the same value a genuinely fee-free trade exports. TRA-3875 closes this
//     for JSON readers: every row now publishes `pnl_basis` (`'book'` ⇒ no fee
//     measurement exists, `'broker-fill'` ⇒ the 0 would be a measured 0). The
//     §2.3 CSV header is still byte-identical, because `toCsv` maps
//     EXPORT_COLUMNS explicitly and the new fields are not in it.
//     The column is kept in the schema (design §2.3) so a future fee-tracking
//     change on the BOOK side stays purely additive and the CSV header never has
//     to change.
//   * pnl_r — R-multiple. ⚠ THE BASIS DEPENDS ON THE MARKET, and since TRA-3989
//     it depends on NOTHING ELSE:
//       - equity/crypto rows: pnl ÷ the entry→stop distance × quantity (the
//         trade's initial risk). Null when the stop is absent/zero.
//       - OPTIONS rows: pnl ÷ the FULL PREMIUM at open (`premiumPaid × contracts
//         × 100`) — the option-trade JOURNAL's `realizedR` basis (`realizedPnlUsd
//         / atRiskUsd`, where `atRiskUsd` is `totalCost` at the open site). Before
//         TRA-3989 a BOOK-served options row divided by the stop distance and a
//         JOURNAL-served one by the premium, so the unit of this column flipped
//         on the 21:00 ET archive — the same 30 closes read ~5× larger at 19:00Z
//         than at 02:00Z, with the losers (which terminate at a stop and are
//         read same-day) amplified and the winners not. See
//         {@link optionPremiumRiskUsd} for why the premium is the reference.
//         ⚠ TRA-4027 — "the premium" is read at an INSTANT, and the two emitters
//         read it at different ones: the book's `premiumPaid` is overwritten
//         with the broker FILL once the mirror reconciles
//         (`restateEngineOpenedBasis`), while the journal's `atRiskUsd` is the
//         OPEN MARK, frozen at open (TRA-991). A book-served row with a journal
//         twin now divides by the TWIN's `atRiskUsd` (threaded in through
//         `ExportInput.optionPremiumBases`), so the figure no longer changes
//         across the archive edge; a twin-less row keeps the inline arithmetic
//         and says so. `premium_basis_usd` (JSON) is the number divided by.
//     `pnl_r_basis` (JSON) names the unit per row so no reader has to know this.
//   * pnl_r_stop_basis — TRA-3989: the stop-distance R, RELABELLED rather than
//     deleted. On options rows this is the gate-basis reading (`pnl ÷
//     |premiumPaid − stopLossPremium| × contracts × 100`); null when the row has
//     no armed stop (`stopLossPremium` absent or the `0` "never stop" sentinel —
//     see `isArmedThreshold` in `options-account.ts`) and null on every
//     journal-served row (the journal does not record the stop). On equity/crypto
//     rows it equals `pnl_r`. In the CSV header as the LAST column, so every
//     existing §2.3 column keeps its ordinal.
//   * hold_duration — human string ("2h 14m") derived from openedAt→closedAt.
// ─────────────────────────────────────────────────────────────────────────────

export type ExportMarket = 'stocks' | 'crypto' | 'options';
export type ExportFormat = 'csv' | 'json';

/**
 * TRA-3875 — where a served row's IDENTITY came from (`source`) and what its
 * money columns are MEASURED AGAINST (`pnl_basis`). The two are independent, and
 * that is the whole point: a book-sourced row can carry broker-settled money.
 *
 * `'book'` basis = the engine's own close arithmetic, `(exit − entryMark) × n ×
 * 100`, mid-basis and gross of commission. `'broker-fill'` = restated from the
 * durable fill ledger (TRA-2819/TRA-3730): broker entry fill, broker exit fill,
 * net of measured fees.
 *
 * Published on the JSON document ONLY. `toCsv` maps {@link EXPORT_COLUMNS}
 * explicitly, so the design §2.3 header stays byte-identical and every existing
 * CSV consumer is untouched — the residual `export.ts` header notes ("a
 * provenance column would change the §2.3 CSV header") is discharged for JSON
 * readers without paying that price.
 */
export type ExportRowSource = 'book' | 'journal';
export type ExportPnlBasis = 'book' | 'broker-fill';

/**
 * TRA-3989 — the UNIT of the `pnl_r` column, per row, so a reader never has to
 * infer it from `market` (or, as before this ticket, from the clock).
 *
 * `'stop-distance'` = pnl ÷ entry→stop distance (equity/crypto, whose risk unit
 * IS the stop). The stop-distance reading for options is published separately as
 * `pnl_r_stop_basis` and is never what `pnl_r` holds.
 *
 * TRA-4027 — the options value `'premium'` is SPLIT by the INSTANT the premium
 * was read at, because one unit at two instants is still two denominators:
 *
 *   * `'premium-open-mark'` = pnl ÷ the journal's `atRiskUsd`, the premium at
 *     the OPEN MARK. This is the journal's `realizedR` basis (TRA-991 freezes it
 *     at open; nothing restates it to the fill) and therefore the reference —
 *     every journal-served row is in it, and since TRA-4027 so is every
 *     book-served row that has a journal twin to read it from.
 *   * `'premium-fill'` = pnl ÷ the book row's own `premiumPaid × contracts ×
 *     100`, computed inline because NO journal twin exists. `premiumPaid` is the
 *     open mark until `restateEngineOpenedBasis` overwrites it with the broker
 *     fill (mirror reconcile), so on a reconciled live row this is the FILL
 *     basis — 8.2% off the mark on `NVTS261002C00012500` 2026-08-25 (1.51 vs
 *     1.395) — and on an unreconciled or demo row it is the mark. The label says
 *     which SOURCE the basis came from, not which of those two the row happened
 *     to hold; a reader who needs the mark basis partitions on this value and
 *     `premium_basis_usd` carries the exact figure either way.
 *
 * The bare `'premium'` is retired rather than kept as a third value: a row that
 * still published it would be one whose instant a reader could not tell, which
 * is the defect.
 */
export type ExportPnlRBasis = 'premium-open-mark' | 'premium-fill' | 'stop-distance';

/**
 * TRA-4035 — a journal twin's premium basis WITH its instant, as the export
 * consumes it. `atRiskUsd` is the divisor (`OptionTradeJournalRecord.atRiskUsd`);
 * `atRiskBasis` is the journal's own statement of what that dollar figure IS
 * (TRA-4028): `'fill'` = the lot's attributable ledger fill, `'mark'` = the
 * figure the book row carried at the write, `null` = the record predates the
 * field or is an engine-opened row (whose open IS the scanner mark, TRA-4027).
 *
 * A bare `number` is accepted everywhere this is consumed, for the hand-built
 * fixtures and callers that predate the label; it reads as "instant unknown"
 * and labels `'premium-open-mark'` exactly as before this ticket.
 */
export interface ExportJournalPremiumBasis {
  atRiskUsd: number;
  atRiskBasis: 'fill' | 'mark' | null;
}

/**
 * TRA-4035 — the `pnl_r_basis` label for an R divided by a JOURNAL `atRiskUsd`,
 * keyed on what the journal says that figure is — not on whether the figure is
 * present. Before this ticket every journal-basis row was labelled
 * `'premium-open-mark'` on the strength of `atRiskUsd` being finite, which was
 * true only while the journal could not say otherwise. TRA-4028 made the basis
 * self-describing and restated BAC `6bbc5d17` onto its $117 ledger fill
 * (`atRiskBasis: 'fill'`); the export then published `pnl_r -0.026` (correct,
 * ÷117) under `'premium-open-mark'` (wrong: $117 is the 1.17 fill, not any
 * mark). The number was right and the label misnamed its own divisor — and a
 * reader told `open-mark` pairs it with the wrong instant (TRA-4027).
 *
 * `'mark'` and ABSENT both read `'premium-open-mark'`: absent is every
 * pre-TRA-4028 row and every engine `single_leg_otm` row, whose open is the
 * scanner mark by definition. Absent is NOT treated as `'fill'` — the journal's
 * own doc says a reader must treat it as unknown, and the open mark is what
 * every such row has held since TRA-991 froze it there.
 */
export function premiumRBasisLabel(atRiskBasis: 'fill' | 'mark' | null | undefined): ExportPnlRBasis {
  return atRiskBasis === 'fill' ? 'premium-fill' : 'premium-open-mark';
}

/** TRA-4035 — normalise the `number | ExportJournalPremiumBasis` a caller may hand over. */
function journalPremiumBasisOf(
  basis: number | ExportJournalPremiumBasis | undefined,
): { atRiskUsd: number; atRiskBasis: 'fill' | 'mark' | null } {
  if (typeof basis === 'number') return { atRiskUsd: basis, atRiskBasis: null };
  if (basis && typeof basis === 'object') {
    return {
      atRiskUsd: basis.atRiskUsd,
      atRiskBasis: basis.atRiskBasis === 'fill' || basis.atRiskBasis === 'mark' ? basis.atRiskBasis : null,
    };
  }
  return { atRiskUsd: NaN, atRiskBasis: null };
}

/**
 * TRA-4031 — WHICH QUANTITY the `entry_price` column holds, per row, so a
 * reader never has to infer it from the clock.
 *
 * `/api/trades/export` published `entry_price` in TWO bases for the SAME closed
 * option row, selected by whether the 21:00 ET `archiveClosedOptions()` had
 * run — the clock-selected-unit shape TRA-3989 found on `pnl_r`, one column
 * over. Measured on `NVTS261002C00012500` (live, `otm_mispricing`, journal row
 * `63a5bc3a`): the book-sourced row read `entry_price 1.51` (2026-08-25, pre-
 * archive) and the journal-sourced row read `1.395` (2026-08-26T04:3xZ, post-
 * archive). `1.51 / 1.395 = 1.082`: the mirror reconcile had rebased the row
 * +8.2% to broker truth after open and the journal-served export never learned
 * it, because the journal's OPEN write froze the scanner's mid (`entryMarkUsd`)
 * and the only restating path (the TRA-2819 close-basis sweep) skips every lot
 * whose fills carry `fees: null`. Any reader deriving R, slippage or the
 * give-back the exit rule saw from that column after 21:00 ET was computing
 * against a number the engine never traded on.
 *
 *   * `'broker-fill'`   — the volume-weighted broker ENTRY fill, from a
 *     TRA-2819 restatement (`entryFillPremium`). Strongest; only on restated
 *     rows.
 *   * `'book-basis'`    — the book's `premiumPaid` as the close path found it:
 *     post-reconcile, the basis the stop schedule / `profitLockDecision` /
 *     the row's `pnl` were computed against. Every book-sourced row; and every
 *     journal-sourced row closed since the CLOSE write carries it
 *     (`OptionTradeJournalClose.entryBasisPremium`).
 *   * `'pre-trade-mid'` — the scanner's mid at the OPEN write (`entryMarkUsd`).
 *     Only on a journal-sourced row closed BEFORE the stamp shipped (AC4:
 *     forward-only, no backfill — the discontinuity is visible in the column,
 *     not hidden).
 *   * `null`            — the row states no entry price at all.
 *
 * Equity/crypto rows read `'book-basis'`: `Position.entryPrice` is the book's
 * fill and nothing restates it.
 *
 * ⚠️ JSON-only, exactly like `source`/`pnl_basis`/`pnl_r_basis`: `toCsv` maps
 * {@link EXPORT_COLUMNS} explicitly, so the design §2.3 CSV header stays
 * byte-identical and no existing consumer is touched.
 */
export type ExportEntryPriceBasis = 'broker-fill' | 'book-basis' | 'pre-trade-mid';

/**
 * TRA-3985 (Defect 2) — WHICH LOT this row's exit consumed.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * On 2026-08-24 two live rows shared one OCC symbol — `RIG260925C00006000`,
 * opened **357ms apart** (`…18:04:24.494Z` and `…18:04:24.851Z`) — and one of
 * them closed on `sl_otm_premium_pct` while the other survived and had its
 * basis restated to `0.22` by a `residual_identity` desk-add 28m53s earlier.
 * The two lots carry DIFFERENT premium anchors (`0.33` vs `0.22`), so the same
 * `0.18` fill grades **−45.45%** against one and **−18.18%** against the other.
 * TRA-3943 AC3's bar is `>= −40% of premium`: the verdict INVERTS on the lot
 * attribution, and neither `/api/trades/export` nor `/api/state` could say
 * which lot the exit consumed. `buildRows` said so in as many words — "
 * `ExportTradeRow` carries no id, so the book↔journal join is unrecoverable one
 * line later" — and that is the sentence this pair of fields retires.
 *
 * `lot_id` is the BOOK row's own id, i.e. the lot. `journal_id` is the id the
 * durable journal knows that close by, which is `journalId ?? id` and therefore
 * **NOT** always the same string (TRA-3078/TRA-3930: a position the reconcile
 * REBOUND onto a pre-existing open row carries a different `journalId`, and a
 * `-130.00` for a `-65.00` day is what conflating the two cost). Publishing one
 * and calling it "the id" is the defect that already shipped once; both are
 * published, separately, and a reader joins on the one it means.
 *
 * A JOURNAL-sourced row publishes `journal_id` and leaves `lot_id` **null** —
 * the journal does not store the book position id, so it cannot be recovered
 * from that side, and the "blank beats an invented value" rule that governs
 * `exit_price` in {@link rowFromJournalRecord} governs identity too.
 *
 * ⚠️ JSON-only, exactly like `source`/`pnl_basis`: `toCsv` maps
 * {@link EXPORT_COLUMNS} explicitly, so the design §2.3 CSV header stays
 * byte-identical and no existing consumer is touched.
 */
export type ExportLotIdentity = {
  /** The BOOK row's id — the lot. `null` on a journal-sourced row. */
  lot_id: string | null;
  /** The id the durable option-trade journal keys this close on (options only). */
  journal_id: string | null;
};

/** Standard equity-option contract multiplier (shares per contract). */
const OPTION_CONTRACT_MULTIPLIER = 100;

/** Column order is the design §2.3 schema, verbatim. */
export const EXPORT_COLUMNS = [
  'symbol',
  'market',
  'mode',
  'side',
  'strategy',
  'quantity',
  'entry_time',
  'entry_price',
  'exit_time',
  'exit_price',
  'exit_reason',
  'gross_pnl_usd',
  'fees_usd',
  'net_pnl_usd',
  'pnl_r',
  'hold_duration',
  // TRA-3989 — appended LAST so the sixteen §2.3 columns keep their ordinals
  // and a positional CSV consumer reads exactly what it read before. This is
  // the first change to the §2.3 header since it was written; it is made
  // because a stop-basis R that is only available by *inferring* it from the
  // premium-basis one is how the two got confused in the first place (AC3).
  'pnl_r_stop_basis',
  // TRA-3990 — appended after it for the same reason. `(ask − bid) / mid` on
  // the snapshot the fill price came from; options only. Null — NEVER 0 — on
  // a row opened before the stamp shipped, on a row whose quote was
  // unavailable at open, and on every equity/crypto row. A zero here would be
  // indistinguishable from a perfectly tight quote and would poison the
  // median split TRA-3945's secondary analysis is pre-registered on.
  'entry_spread_pct',
] as const;

export interface ExportTradeRow {
  symbol: string;
  market: ExportMarket;
  mode: AccountMode;
  side: string;
  strategy: string;
  quantity: number;
  /** ISO-8601 UTC; empty string when the open timestamp is missing. */
  entry_time: string;
  entry_price: number | null;
  /** ISO-8601 UTC; empty string when the trade has no recorded close. */
  exit_time: string;
  exit_price: number | null;
  exit_reason: string;
  gross_pnl_usd: number | null;
  fees_usd: number;
  net_pnl_usd: number | null;
  pnl_r: number | null;
  hold_duration: string;
  /**
   * TRA-3989 — the stop-distance R (see the header note). In the CSV as the last
   * column. Optional on the TYPE only so a hand-built fixture still type-checks
   * (`tsc -b` compiles the test files — TRA-3695); every mapper sets it, and
   * `toCsv` renders an absent one as an empty cell exactly like a null.
   */
  pnl_r_stop_basis?: number | null;
  /**
   * TRA-3990 — `(ask − bid) / mid` at entry, from the SAME snapshot the fill
   * price came from (see `OptionPosition.entrySpreadPct`). Last CSV column.
   * `null` on a pre-stamp row, an unmeasured quote, and every non-option row;
   * never `0` for any of those. Optional on the TYPE for the same reason as
   * `pnl_r_stop_basis`; every mapper sets it.
   */
  entry_spread_pct?: number | null;
  /**
   * TRA-3989 — the unit `pnl_r` is in, JSON-only (see {@link ExportPnlRBasis}).
   * Optional on the TYPE for the same reason as `pnl_r_stop_basis`.
   */
  pnl_r_basis?: ExportPnlRBasis;
  /**
   * TRA-4031 — which quantity `entry_price` holds, JSON-only (see
   * {@link ExportEntryPriceBasis}). `null` when `entry_price` is null. Optional
   * on the TYPE for the same reason as `pnl_r_stop_basis`; every mapper sets it.
   */
  entry_price_basis?: ExportEntryPriceBasis | null;
  /**
   * TRA-4027 — the USD figure `pnl_r` was divided by, JSON-only. On an options
   * row this is the journal twin's `atRiskUsd` (`pnl_r_basis: 'premium-open-
   * mark'`) or the inline `premiumPaid × contracts × 100` (`'premium-fill'`),
   * so `pnl_r == net_pnl_usd / premium_basis_usd` reconciles to 3dp on EVERY
   * options row regardless of `source` — the identity TRA-3989 AC2 stated as
   * `entry_price × 100 × quantity`, which a fill/mark split breaks by
   * construction (`entry_price` is a PRICE column and stays the fill; see
   * {@link rowFromOption}). `null` on equity/crypto rows and on an options row
   * that could state no premium at all (then `pnl_r` is null too).
   */
  premium_basis_usd?: number | null;
  /**
   * TRA-3875 — provenance, JSON-only (see {@link ExportRowSource}). Optional on
   * the TYPE so a fixture or an older caller that builds a row by hand still
   * type-checks; every mapper in this module and in `export-history.ts` sets
   * both. An ABSENT `source` is counted as `'book'` by {@link summarize}, which
   * is what the pre-ticket census did (`rows.length − journalServed`).
   */
  source?: ExportRowSource;
  pnl_basis?: ExportPnlBasis;
  /**
   * TRA-3985 — lot identity, JSON-only (see {@link ExportLotIdentity}). Optional
   * on the TYPE for the same reason `source` is: a hand-built fixture or an
   * older caller still type-checks. Every mapper in this module and in
   * `export-history.ts` sets both. ABSENT and `null` mean the same thing here —
   * "this row does not name a lot" — and neither may ever be read as "the lot is
   * whatever the OCC symbol matched", which is the inference this field exists
   * to make unnecessary.
   */
  lot_id?: string | null;
  journal_id?: string | null;
  /**
   * TRA-3985 — the broker order id of the REALISING CLOSE, when the durable fill
   * ledger measured one (TRA-3945 stamps it on the journal's close row). This is
   * the strongest available attribution: an order id is the broker's own handle
   * on the fill, and unlike `lot_id` it survives an archive.
   *
   * `null` when nothing measured one — an unrestated row, a demo row, or a close
   * the fill ledger never saw. It is NOT a claim the close had no order.
   */
  broker_order_id?: string | number | null;
}

/**
 * TRA-3875 — the money columns a restated journal row imposes on its BOOK twin.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `/api/trades/export` published TWO different P&L figures for one contract,
 * selected by nothing but the hour of the read. `SPY260821C00777000` (live,
 * closed 2026-08-18) served **-278.00** before the 21:00 ET archive and
 * **-156.23** after it; the day totalled -393.00 then -271.23. A $121.77 swing,
 * same route, same query.
 *
 * The mechanism is two correct tickets composing into a hole:
 *   1. TRA-2819/TRA-3730 restated the JOURNAL and deliberately did not touch
 *      `OptionPosition.pnl` on the in-memory book.
 *   2. TRA-3860's dedupe drops the journal twin whenever the book still holds
 *      the same `position.id`, because the book carried the exit premium.
 *   3. `archiveClosedOptions()` empties `closedOptions` at 21:00 ET, so the book
 *      twin — and with it the superseded figure — vanishes on a clock.
 *
 * So the dedupe bought the exit premium and paid for it with the close basis,
 * and the payment was invisible because the two answers were never on screen at
 * the same time. Worse, the pre-archive total AGREED with the frozen day cell
 * (-393.00 both), so a reconciliation came back GREEN during the trading day and
 * RED after it — and the RED one is the correct state, because TRA-3864 ruled
 * (b) FREEZE precisely so that divergence stays visible. Two surfaces sharing
 * one superseded number is not corroboration.
 *
 * ── The ruling (TRA-3875, LeadDev) ──────────────────────────────────────────
 *
 * **The restated journal row wins every column it has actually MEASURED; the
 * book wins only what the journal never recorded.** That is the filing's option
 * (1), split-precedence-by-column, and it is chosen over (2) journal-wins-
 * outright because the restatement measures `exitFillPremium`/`entryFillPremium`
 * — so on a restated row the journal does not merely tie the book on the exit
 * premium, it BEATS it (a broker fill against a last mark). The dedupe's stated
 * reason for existing does not survive contact with a restated row.
 *
 * Concretely, for a book/journal twin whose journal record carries
 * `pnlBasis: 'broker-fill'`:
 *   * `net_pnl_usd`, `gross_pnl_usd`, `fees_usd` ← journal (broker-settled).
 *   * `pnl_r` ← journal's `realizedR`, which the restatement re-derives in the
 *     same write (`option-trade-journal.ts:907`). Taking the money and leaving
 *     the book's R would publish an R computed from the number we just replaced.
 *   * `exit_price` / `entry_price` ← the broker fills, when measured. A fill is
 *     not a fabricated price; the "blank beats invented" rule in
 *     {@link rowFromJournalRecord} does not apply to a measured one.
 *   * everything else (`exit_reason`, `strategy`, `hold_duration`, timestamps)
 *     stays the book's — the journal restatement explicitly does not restate it.
 *
 * A journal row with NO `pnlBasis` is not a restatement and imposes nothing: the
 * book copy is not superseded, so the pre-ticket behaviour (drop the twin, serve
 * the book) is left exactly as it was.
 *
 * Field-by-field merging was rejected once, in TRA-3860, on the grounds that it
 * would let "a recovered row silently inherit a richer provenance than it has".
 * That objection is answered rather than overruled: the merge is now PUBLISHED,
 * per row, via `source` + `pnl_basis` and `summary.supersededRowCount`. Nothing
 * is silent.
 */
export interface ExportMoneyRestatement {
  gross_pnl_usd: number | null;
  fees_usd: number;
  net_pnl_usd: number | null;
  pnl_r: number | null;
  /** Broker EXIT fill per share; null when the restatement measured none. */
  exit_price: number | null;
  /** Broker ENTRY fill per share; null when the restatement measured none. */
  entry_price: number | null;
  /**
   * TRA-4031 — what `entry_price` above holds. A restatement's entry is the
   * broker fill (`'broker-fill'`) whenever it states one; the label travels
   * with the figure so {@link applyMoneyRestatement} never has to guess. Absent
   * ⇒ `'broker-fill'` when `entry_price` is finite (every hand-built fixture
   * that predates this field is a broker-fill restatement). Ignored when
   * `entry_price` is null — an unmeasured fill deletes neither the book's
   * figure nor its label.
   */
  entry_price_basis?: ExportEntryPriceBasis | null;
  /**
   * TRA-3985 — the realising close's broker order id (TRA-3945), when the fill
   * ledger measured one. It rides on the RESTATEMENT rather than being read off
   * the book row for the same reason the fills do: it is a thing the broker
   * settled, and the in-memory book never holds it after the close.
   *
   * `null` ⇒ nothing measured one. It does NOT overwrite a value already on the
   * row (see {@link applyMoneyRestatement}) — a restatement that could not
   * measure an order id is not a reason to delete one the row already carried,
   * the same rule `exit_price`/`entry_price` follow one field up.
   */
  broker_order_id: string | number | null;
  /**
   * TRA-4027 — the journal's `atRiskUsd`, the denominator of the `pnl_r` this
   * restatement carries (`realizedR = realizedPnlUsd / atRiskUsd`, re-derived
   * against the SAME open-mark basis by the close-basis restatement — see
   * `OptionTradeCloseBasis.realizedR`). Travels with `pnl_r` so the row's
   * `premium_basis_usd` reconciles against the R it actually publishes.
   * `null` when the journal record states no basis.
   *
   * Optional on the TYPE only — `tsc -b` compiles the test files (TRA-3695) and
   * the hand-built restatement fixtures in `tra3985-lot-attribution.test.ts`
   * predate this field. `restatementFromRecord` always sets it; an ABSENT one is
   * treated exactly like `null` by {@link applyMoneyRestatement}.
   */
  premium_basis_usd?: number | null;
  /**
   * TRA-4035 — what `premium_basis_usd` above IS (the journal's `atRiskBasis`,
   * TRA-4028, through {@link premiumRBasisLabel}). Travels with the figure so
   * the overlay never has to guess the instant from the figure's presence.
   * Absent or null ⇒ `'premium-open-mark'` when `premium_basis_usd` is finite
   * (the pre-ticket label, and the truth for every fixture that predates the
   * field); ignored when `premium_basis_usd` is not finite.
   */
  pnl_r_basis?: ExportPnlRBasis | null;
}

/**
 * TRA-3875 — overlay a restatement onto a BOOK row. Returns the row unchanged
 * (same object) when there is nothing to apply, so the no-restatement path is
 * allocation-free and provably a no-op.
 *
 * `exit_price`/`entry_price` fall BACK to the book's value when the restatement
 * has none, rather than nulling it: a restatement that could not measure a fill
 * is not a reason to delete a mark the book did record.
 */
export function applyMoneyRestatement(
  row: ExportTradeRow,
  restatement: ExportMoneyRestatement | undefined,
  /**
   * TRA-3989 — the BOOK row's stop-distance risk in USD ({@link optionStopRiskUsd}),
   * so the relabelled stop-basis R can be re-derived against the restated NET.
   * `pnl_r` already travels with the money (the journal re-derives `realizedR` in
   * the same write); leaving `pnl_r_stop_basis` as the book's own arithmetic would
   * put an R computed from the replaced figure one column over from the figure
   * that replaced it — the exact defect TRA-3875 fixed for `pnl_r`. Absent or
   * unarmed ⇒ null: broker money over a book-mark stop is not published.
   */
  stopRiskUsd?: number,
): ExportTradeRow {
  if (!restatement) return row;
  const restatedEntry = isFiniteNumber(restatement.entry_price);
  return {
    ...row,
    entry_price: restatement.entry_price ?? row.entry_price,
    // TRA-4031 — the label follows the figure: a restated entry is the broker
    // fill (or whatever basis the restatement names); an unmeasured one leaves
    // the book's figure AND its label, same rule as the price one line up.
    entry_price_basis: restatedEntry
      ? (restatement.entry_price_basis ?? 'broker-fill')
      : (row.entry_price_basis ?? null),
    exit_price: restatement.exit_price ?? row.exit_price,
    gross_pnl_usd: restatement.gross_pnl_usd,
    fees_usd: restatement.fees_usd,
    net_pnl_usd: restatement.net_pnl_usd,
    pnl_r: restatement.pnl_r,
    pnl_r_stop_basis: rMultiple(restatement.net_pnl_usd ?? undefined, stopRiskUsd ?? NaN),
    pnl_basis: 'broker-fill',
    // TRA-4027 — the R that just landed is the journal's, over the journal's
    // open-mark `atRiskUsd`; the basis figure and its label travel with it.
    // A restatement that states no basis (null, absent, or non-finite) leaves
    // the row's own figure AND label (same rule as `entry_price`/`exit_price`
    // above: an unmeasured figure deletes nothing).
    premium_basis_usd: isFiniteNumber(restatement.premium_basis_usd)
      ? restatement.premium_basis_usd
      : (row.premium_basis_usd ?? null),
    // TRA-4035 — and the label is the one the restatement NAMES, not one inferred
    // from the figure being present: a twin restated onto its ledger fill
    // (TRA-4028) publishes `'premium-fill'` here, an open-mark twin (or a
    // restatement that predates the label) `'premium-open-mark'`.
    pnl_r_basis: isFiniteNumber(restatement.premium_basis_usd)
      ? (restatement.pnl_r_basis ?? 'premium-open-mark')
      : row.pnl_r_basis,
    // TRA-3985 — identity is NOT restated: `lot_id`/`journal_id` describe which
    // row this is, and the restatement is joined ON `journal_id`, so letting it
    // rewrite the key would make the join unverifiable from the output.
    broker_order_id: restatement.broker_order_id ?? row.broker_order_id ?? null,
  };
}

export interface ExportFilters {
  /** Account modes to include; undefined/empty ⇒ all modes. */
  modes?: AccountMode[];
  /** Markets to include; undefined/empty ⇒ all markets. */
  markets?: ExportMarket[];
  /** Inclusive lower bound (epoch ms) on the trade's exit time. */
  from?: number;
  /** Inclusive upper bound (epoch ms) on the trade's exit time. */
  to?: number;
}

/** Raw closed-trade buckets, already de-duped by the caller (`index.ts`). */
export interface ExportInput {
  stocksClosed?: Position[];
  cryptoClosed?: Position[];
  optionsClosed?: OptionPosition[];
  /**
   * TRA-3860 — rows recovered from a durable ledger rather than an in-memory
   * book, already mapped (see `export-history.ts`). They join the same filter
   * and summary pass as the buckets above, so a historical row cannot be counted
   * by one and missed by the other. The caller de-dupes them against the buckets
   * by trade id before passing them in.
   */
  preMappedRows?: ExportTradeRow[];
  /**
   * TRA-3875 — restated money columns for `optionsClosed`, keyed by
   * `OptionPosition.id` (the same id the journal is keyed on). Built by
   * `collectJournalMoneyRestatements` in `export-history.ts` and applied in
   * {@link buildRows}, where the id is in hand — the row shape itself carries no
   * id, so this is the last point at which the join is possible.
   *
   * Absent ⇒ nothing is overlaid, which is the pre-ticket behaviour exactly.
   */
  optionMoneyRestatements?: ReadonlyMap<string, ExportMoneyRestatement>;
  /**
   * TRA-4027 — the journal twin's `atRiskUsd` (premium at the OPEN MARK) for
   * each of `optionsClosed`, keyed like `optionMoneyRestatements` by the id the
   * JOURNAL knows the position by (`journalIdForPosition`). Built by
   * `collectJournalPremiumBases` in `export-history.ts` and consumed by
   * {@link rowFromOption} through {@link buildRows}, so a book-served row divides
   * `pnl_r` by the same figure its journal-served twin will divide by after the
   * 21:00 ET archive — instead of by `premiumPaid`, which the mirror reconcile
   * has by then overwritten with the broker FILL (`restateEngineOpenedBasis`).
   *
   * Unlike the restatement map this is populated for EVERY twin, restated or
   * not: the fill/mark gap opens the moment the mirror reconciles, hours before
   * any close-basis restatement runs. Absent ⇒ every book row divides inline
   * and labels itself `'premium-fill'`, which is the pre-ticket arithmetic.
   *
   * TRA-4035 — the value carries the twin's `atRiskBasis` beside the figure
   * ({@link ExportJournalPremiumBasis}) so the book row's label names the
   * instant the twin states, not the instant the presence of a twin implied. A
   * bare `number` is still accepted and reads as "instant unknown" ⇒
   * `'premium-open-mark'`.
   */
  optionPremiumBases?: ReadonlyMap<string, number | ExportJournalPremiumBasis>;
}

/**
 * TRA-3860 — where a market's coverage floor came from. Published on the wire
 * because the four are NOT interchangeable: a reader deciding whether to trust an
 * empty result needs to know which one produced the bound. Full rationale and the
 * resolution rules live in `export-history.ts`.
 */
export type ExportCoverageSource =
  /** A real archive tick was observed on this book; the floor is exact. */
  | 'archive-boundary'
  /** No archive tick observed yet; falls back to process start (conservative). */
  | 'process-start'
  /** The durable per-close journal extends this market's floor past the archive. */
  | 'option-trade-journal'
  /** Nothing to attest with. Any explicit `from` is refused. */
  | 'unknown';

export interface ExportMarketCoverage {
  /** Earliest exit time (epoch ms) this export can attest to; null ⇒ unknown. */
  since: number | null;
  /** `since` as ISO-8601, or null. Convenience for humans reading the document. */
  sinceIso: string | null;
  source: ExportCoverageSource;
}

/**
 * TRA-3860 — the window this export speaks for, per market. Carried on EVERY
 * response (served or refused) so an empty result is always qualified: before
 * this, `trades: []` over an archived day was byte-identical to a day that had no
 * trades.
 */
export interface ExportCoverage {
  stocks: ExportMarketCoverage;
  crypto: ExportMarketCoverage;
  options: ExportMarketCoverage;
  /** The modes these floors were computed for (the request's, or all of them). */
  modes: AccountMode[];
  /** Plain-language statement of the bound, carried on every response. */
  note: string;
}

/**
 * TRA-3874 — which filter parameters the REQUEST actually carried.
 *
 * Declared HERE rather than in `export-request.ts` (which owns the rules that
 * produce it) for the same reason as the coverage types above: `ExportSummary`
 * carries it on the wire, and `export-request.ts` reaches `export-history.ts`,
 * which imports a VALUE from this module. Keeping the type here means the wire
 * shape never depends on the direction of a runtime import.
 */
export interface ExportFiltersRequested {
  modes: boolean;
  markets: boolean;
  from: boolean;
  to: boolean;
}

/**
 * TRA-4358 — the BOOK this document speaks for.
 *
 * The export is a PER-BOOK surface: every candidate row — in-memory book
 * positions and journal rows alike — is scoped to the authenticated user before
 * anything else runs (`journalRowsForBook`, TRA-2421). The journal itself and
 * the health surfaces built on it (`/api/health/option-journal`
 * `summary.byMode`) are FIRM-WIDE and pool every book trading a mode. Nothing
 * on the wire said so, and the difference was mis-read as the export dropping
 * rows: 32 firm-wide live option rows vs 27 served here, where the other 5
 * belonged to a second live book. This block states the scope in the document
 * itself, so a cross-surface count delta is explicable from the payloads alone.
 */
export interface ExportScope {
  /** The authenticated book whose rows — and only whose rows — this export serves. */
  book: string;
  note: string;
}

/** TRA-3860 — row-provenance census, so a mixed export is legible. */
export interface ExportSourceCounts {
  /** Rows from the live in-memory book (full premiums). */
  book: number;
  /** Rows recovered from the durable option-trade journal (no exit premium). */
  journal: number;
}

export interface ExportSummary {
  count: number;
  totals: {
    gross_pnl_usd: number;
    fees_usd: number;
    net_pnl_usd: number;
  };
  /** Fraction (0..1) of exported rows whose net P&L is strictly positive. */
  win_rate: number;
  /** Echo of the filters that produced this export. */
  filters: ExportFilters;
  /**
   * TRA-3860 — the window this document attests to. Optional on the TYPE only so
   * the pure `summarize()` (which has no access to the archive boundary or the
   * journal) still type-checks; the HTTP route attaches it unconditionally, and
   * an absent block means the summary did not come from the route.
   */
  coverage?: ExportCoverage;
  /** TRA-3860 — how many served rows came from the book vs the durable journal. */
  sources?: ExportSourceCounts;
  /**
   * TRA-3875 — how many SERVED rows are book-identity rows whose money columns
   * were superseded by a broker-fill restatement out of the journal.
   *
   * This is the count the filing pre-registered under this name. Read it as "how
   * many rows would have published a stale close basis before this fix", not as
   * "how many rows are publishing a stale one now" — after the fix the served
   * number IS the restatement. `> 0` is the signal that the book and the journal
   * disagreed and the journal won; it goes to 0 after the 21:00 ET archive not
   * because anything was resolved but because the book twin stopped existing.
   *
   * Optional on the TYPE for the same reason as `coverage`, but unlike `coverage`
   * it IS produced by the pure `summarize()` — it is derived from the served rows
   * alone, so a filter that drops every restated row reports 0 rather than the
   * number that was offered up.
   */
  supersededRowCount?: number;
  /**
   * TRA-3874 — which filter parameters the REQUEST carried, as booleans.
   *
   * `filters.modes: []` publishes the RESOLVED filter, in which empty means
   * "every mode". That was ambiguous while an unrecognized token could be dropped
   * into the same `[]`; it no longer can be (`export-request.ts` refuses it), but
   * the echo alone still requires a reader to KNOW that rule before they can tell
   * "I asked for nothing" from "something I asked for went missing". This block
   * states it in the document they keep. Optional on the TYPE for the same reason
   * as `coverage`: the pure `summarize()` never sees the query string.
   */
  filtersRequested?: ExportFiltersRequested;
  /**
   * TRA-4358 — which book this document speaks for. Optional on the TYPE for
   * the same reason as `coverage`: the pure `summarize()` never sees the
   * authenticated user; the HTTP route attaches it unconditionally.
   */
  scope?: ExportScope;
}

export interface ExportDocument {
  summary: ExportSummary;
  trades: ExportTradeRow[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isoOrEmpty(ms: number | undefined): string {
  if (!isFiniteNumber(ms)) return '';
  return new Date(ms).toISOString();
}

/**
 * Human-readable hold time, e.g. "3d 4h", "2h 14m", "47s". Returns '' when the
 * open/close timestamps are missing or the span is negative.
 */
export function formatHoldDuration(openedAt: number | undefined, closedAt: number | undefined): string {
  if (!isFiniteNumber(openedAt) || !isFiniteNumber(closedAt)) return '';
  const ms = closedAt - openedAt;
  if (ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** R-multiple from realized P&L and the trade's initial risk; null if undefined. */
function rMultiple(pnl: number | undefined, risk: number): number | null {
  if (!isFiniteNumber(pnl) || !isFiniteNumber(risk) || risk <= 0) return null;
  return round(pnl / risk, 3);
}

function moneyOrNull(value: number | undefined): number | null {
  return isFiniteNumber(value) ? round(value, 2) : null;
}

/**
 * TRA-3989 — an options row's risk in the JOURNAL's basis: the full premium at
 * open, `premiumPaid × contracts × 100`. `NaN` when the row cannot state one.
 *
 * ── Why the premium, and not the stop, is the export's `pnl_r` unit ──────────
 *
 * Measured live 2026-08-24 (bqb1 `07cc4ba4`): 98 export rows, 96 of which
 * reconciled `pnl_r == gross_pnl_usd / (entry_price × 100 × quantity)`. The 2
 * that did not were both closes from THAT DAY, still book-served, and both
 * divided by the stop distance instead: `RIG260925C00006000` published
 * `-2.273` for a `-0.455` premium-basis loss (5.0×), `BAC260925C00063000`
 * `-0.103` for `-0.026` (4.0×). At 02:00Z the archive would have re-served
 * both from the journal at the premium figure. Same route, same query, a
 * different UNIT selected by the hour of the read.
 *
 * The premium is the reference because it is (a) the basis of every archived
 * row — the 15 historical live OTM closes TRA-3945's baseline is frozen on —
 * so choosing it changes nothing a reader has already been served; (b) fixed at
 * the open and therefore stable across the 21:00 ET archive edge; (c) invariant
 * to a stop re-tune (TRA-3943 moved the OTM stop; an R denominated on the stop
 * moves with the thing the arm under test changed — TRA-2677's mixed-population
 * defect, on the units axis); and (d) the SAME arithmetic as the journal's
 * `atRiskUsd`, which is `totalCost = contracts × premiumPaid × 100` at every
 * single-leg open site (`options-account.ts`, `queueJournalOpen`).
 *
 * `opt.contracts` is the count OPENED (`contractsRemaining` is what a TP1
 * scale-out decrements), so a partially-exited row still divides by the premium
 * it actually paid — matching the journal, which captured `atRiskUsd` at open.
 *
 * Residual, stated rather than hidden: a book row whose `premiumPaid` was later
 * restated in place (TRA-3958 operator pin, `residual_identity` desk-add) divides
 * by its CURRENT basis, and the row's own `entry_price` is that same basis, so
 * the row stays self-consistent (AC2's identity holds row-locally). The journal
 * twin, if it carries `pnlBasis: 'broker-fill'`, wins `pnl_r` via the
 * restatement overlay regardless.
 */
export function optionPremiumRiskUsd(opt: Pick<OptionPosition, 'premiumPaid' | 'contracts'>): number {
  return isFiniteNumber(opt.premiumPaid) && isFiniteNumber(opt.contracts)
    ? opt.premiumPaid * opt.contracts * OPTION_CONTRACT_MULTIPLIER
    : NaN;
}

/**
 * TRA-3989 — an options row's risk in the GATE's basis: the entry→stop distance,
 * `|premiumPaid − stopLossPremium| × contracts × 100`. This was `pnl_r`'s
 * denominator on book-served rows before this ticket; it now feeds
 * `pnl_r_stop_basis` only.
 *
 * `NaN` when there is no ARMED stop. `stopLossPremium: 0` is the book's "never
 * stop" sentinel (`isArmedThreshold` in `options-account.ts` rejects it; an
 * unauthorized adopted lot carries it), and a distance measured from a stop that
 * does not exist is not a risk unit — it would silently equal the premium
 * basis and read as a coincidence rather than as "no stop".
 *
 * ⚠ Even where a stop IS armed this is the GENERIC stop on the row, not
 * necessarily the stop that FIRED: RIG closed on `sl_otm_premium_pct` (the
 * TRA-3943 day-one leg, floor `premium × 0.65`) while its `stopLossPremium` was
 * the 20% stop. The stop basis is therefore not self-consistent as a unit, which
 * is one more reason it is relabelled rather than kept as `pnl_r`.
 */
export function optionStopRiskUsd(
  opt: Pick<OptionPosition, 'premiumPaid' | 'contracts' | 'stopLossPremium'>,
): number {
  if (!isFiniteNumber(opt.stopLossPremium) || opt.stopLossPremium <= 0) return NaN;
  if (!isFiniteNumber(opt.premiumPaid) || !isFiniteNumber(opt.contracts)) return NaN;
  return Math.abs(opt.premiumPaid - opt.stopLossPremium) * opt.contracts * OPTION_CONTRACT_MULTIPLIER;
}

// ── Row mappers ──────────────────────────────────────────────────────────────

/** Map an equity/crypto closed `Position` into the flat export row shape. */
export function rowFromPosition(pos: Position, market: 'stocks' | 'crypto'): ExportTradeRow {
  const risk = isFiniteNumber(pos.stopLoss)
    ? Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity
    : NaN;
  const net = moneyOrNull(pos.pnl);
  return {
    symbol: pos.symbol,
    market,
    mode: pos.mode ?? 'demo',
    side: pos.side,
    strategy: pos.signalType ?? '',
    quantity: pos.quantity,
    entry_time: isoOrEmpty(pos.openedAt),
    entry_price: isFiniteNumber(pos.entryPrice) ? pos.entryPrice : null,
    // TRA-4031 — the book's own fill; nothing restates an equity/crypto entry.
    entry_price_basis: isFiniteNumber(pos.entryPrice) ? 'book-basis' : null,
    exit_time: isoOrEmpty(pos.closedAt),
    exit_price: isFiniteNumber(pos.exitPrice) ? pos.exitPrice : null,
    exit_reason: pos.exitReason ?? '',
    // No per-trade fee is tracked, so gross == net and fees == 0 (see header).
    gross_pnl_usd: net,
    fees_usd: 0,
    net_pnl_usd: net,
    pnl_r: rMultiple(pos.pnl, risk),
    hold_duration: formatHoldDuration(pos.openedAt, pos.closedAt),
    // TRA-3989 — an equity/crypto row's risk unit IS the stop distance, so the
    // relabelled column carries the same figure as `pnl_r` and the basis says so.
    pnl_r_stop_basis: rMultiple(pos.pnl, risk),
    pnl_r_basis: 'stop-distance',
    // TRA-4027 — a premium basis is an options measurement; null, never 0.
    premium_basis_usd: null,
    source: 'book',
    pnl_basis: 'book',
    // TRA-3985 — equity/crypto rows have a lot id and no option-trade journal.
    // `journal_id: null` here is a statement about the STORE, not a missing
    // measurement: there is no journal for this market to be keyed on.
    lot_id: pos.id,
    journal_id: null,
    broker_order_id: null,
    // TRA-3990 — options-only measurement; an equity/crypto row is null, not 0.
    entry_spread_pct: null,
  };
}

/**
 * Map a closed `OptionPosition` (always long premium) into an export row.
 *
 * TRA-4027 — `journalAtRiskUsd` is the journal twin's open-mark premium basis
 * when the caller has one ({@link buildRows} reads it off
 * `ExportInput.optionPremiumBases`). When it is a finite positive number the row
 * divides `pnl_r` by IT and labels the basis by what the twin SAYS it is
 * (TRA-4035, {@link premiumRBasisLabel}: `atRiskBasis 'fill'` ⇒
 * `'premium-fill'`, `'mark'`/unknown ⇒ `'premium-open-mark'`); otherwise the row
 * divides by its own `premiumPaid × contracts × 100` and says `'premium-fill'`.
 * Either way `premium_basis_usd` publishes the divisor.
 *
 * `entry_price` is NOT moved to the mark on a twinned row. It is a PRICE column
 * — what this lot paid per share, which after the mirror reconcile is the
 * broker fill — and rewriting it to the journal's mark would make the row lie
 * about the fill to keep an identity (`entry_price × 100 × quantity`) that the
 * basis column now carries honestly instead.
 */
export function rowFromOption(
  opt: OptionPosition,
  journalPremiumBasis?: number | ExportJournalPremiumBasis,
): ExportTradeRow {
  // TRA-3989 — `pnl_r` divides by the PREMIUM (the journal's `atRiskUsd`), never
  // by the stop distance: a book-served row and its journal-served twin must
  // publish the same R, and the twin has no stop to divide by. The stop-basis
  // figure survives one column over as `pnl_r_stop_basis`.
  //
  // TRA-4027 — ...and by the premium at the SAME INSTANT the twin reads it: the
  // open mark, not the fill `premiumPaid` becomes once the mirror reconciles.
  //
  // TRA-4035 — ...and the LABEL is the instant the twin states (`atRiskBasis`,
  // TRA-4028), not "open-mark because a twin exists": a twin restated onto its
  // ledger fill divides by the fill and must say so.
  const twin = journalPremiumBasisOf(journalPremiumBasis);
  const twinRisk = isFiniteNumber(twin.atRiskUsd) && twin.atRiskUsd > 0 ? twin.atRiskUsd : NaN;
  const inlineRisk = optionPremiumRiskUsd(opt);
  const premiumRisk = isFiniteNumber(twinRisk) ? twinRisk : inlineRisk;
  const pnlRBasis: ExportPnlRBasis = isFiniteNumber(twinRisk) ? premiumRBasisLabel(twin.atRiskBasis) : 'premium-fill';
  const stopRisk = optionStopRiskUsd(opt);
  const net = moneyOrNull(opt.pnl);
  return {
    symbol: opt.optionSymbol ?? opt.symbol,
    market: 'options',
    mode: opt.mode ?? 'demo',
    // Long calls/puts: entry is buy_to_open, exit is sell_to_close.
    side: 'buy',
    strategy: opt.signalType ?? '',
    quantity: opt.contracts,
    entry_time: isoOrEmpty(opt.openedAt),
    entry_price: isFiniteNumber(opt.premiumPaid) ? opt.premiumPaid : null,
    // TRA-4031 — `premiumPaid` is the basis the exit rule consumed (post-
    // reconcile); the journal's CLOSE row now carries the same figure as
    // `entryBasisPremium`, so a journal-served twin publishes the same
    // `entry_price` under the same label after the 21:00 ET archive.
    entry_price_basis: isFiniteNumber(opt.premiumPaid) ? 'book-basis' : null,
    exit_time: isoOrEmpty(opt.closedAt),
    // The last mark recorded on the closed option is its exit premium.
    exit_price: isFiniteNumber(opt.currentPremium) ? opt.currentPremium : null,
    // TRA-2937 — this was a hardcoded `''` for EVERY option row, closed or not,
    // thirty lines below an equity mapper that maps the field properly. The
    // export is the only place a human can read "which rule closed this" for a
    // whole book at once, so the hardcode made every option exit unattributable
    // from outside the process. `exitReason` is stamped on every option close
    // path by TRA-2940; empty here now means exactly one thing — the row closed
    // before that stamp shipped.
    exit_reason: opt.exitReason ?? '',
    gross_pnl_usd: net,
    fees_usd: 0,
    net_pnl_usd: net,
    pnl_r: rMultiple(opt.pnl, premiumRisk),
    hold_duration: formatHoldDuration(opt.openedAt, opt.closedAt),
    pnl_r_stop_basis: rMultiple(opt.pnl, stopRisk),
    pnl_r_basis: pnlRBasis,
    // TRA-4027 — the divisor itself, so the reconcile is against the number
    // used and not against a price column that means something else. Rounded
    // only to strip float noise (`0.33 × 100` is `33.00000000000001`); at 6dp a
    // 3dp R cannot tell the difference.
    premium_basis_usd: isFiniteNumber(premiumRisk) ? round(premiumRisk, 6) : null,
    source: 'book',
    // TRA-3875 — the ENGINE's close arithmetic, unless `buildRows` overlays a
    // broker-fill restatement over it (see {@link applyMoneyRestatement}). The
    // in-memory book is never restated in place: TRA-3730's sweep writes the
    // journal only, and that asymmetry is what this field makes readable.
    pnl_basis: 'book',
    // TRA-3985 — BOTH ids, because they are not always the same string and the
    // question "which lot did this exit consume" is only answerable with the
    // book one. `journalIdForPosition` is the SAME accessor `buildRows` joins
    // the restatement on, deliberately: an id published here that disagreed
    // with the id the join used would be worse than none.
    lot_id: opt.id,
    journal_id: journalIdForPosition(opt),
    // Book rows carry no measured close order id of their own. `buildRows`
    // overlays one from the restatement when the fill ledger measured it; until
    // then this reads null rather than reaching for `pendingCloseOrderId`, which
    // tracks a WORKING order and is cleared on the close it describes.
    broker_order_id: null,
    // TRA-3990 — the row's own stamp, or null. `isFiniteNumber` and not `?? null`
    // so a NaN that somehow reached the row is a blank, not a number.
    entry_spread_pct: isFiniteNumber(opt.entrySpreadPct) ? opt.entrySpreadPct : null,
  };
}

// ── Build / filter / summarise ───────────────────────────────────────────────

/** Normalise every bucket into one ordered row list (no filtering yet). */
export function buildRows(input: ExportInput): ExportTradeRow[] {
  const rows: ExportTradeRow[] = [];
  for (const p of input.stocksClosed ?? []) rows.push(rowFromPosition(p, 'stocks'));
  for (const p of input.cryptoClosed ?? []) rows.push(rowFromPosition(p, 'crypto'));
  // TRA-3875 — the restatement overlay lands HERE, not in the mapper, because
  // this is the last point that still holds the `OptionPosition` itself.
  //
  // TRA-3985 — the second half of that sentence used to read "`ExportTradeRow`
  // carries no id, so the book↔journal join is unrecoverable one line later",
  // and it was true: on 2026-08-24 an `sl_otm_premium_pct` exit on
  // `RIG260925C00006000` could not be tied to either of the two lots that share
  // that OCC (opened 357ms apart, basis 0.33 vs a restated 0.22), and TRA-3943
  // AC3's −40% verdict inverts on which one it was. The row now publishes
  // `lot_id`/`journal_id`/`broker_order_id`, so the join survives the mapper.
  for (const o of input.optionsClosed ?? []) {
    // TRA-3930 — joined on the id the JOURNAL knows this position by, which is
    // the key `collectJournalMoneyRestatements` publishes under. `o.id` is the
    // BOOK's id and the two differ on any reconcile-rebound import.
    rows.push(
      applyMoneyRestatement(
        // TRA-4027 — the twin's open-mark basis, joined on the SAME accessor as
        // the restatement one line down (a source-text guard in
        // `export-history.test.ts` pins both to `journalIdForPosition`, never a
        // bare `o.id`); absent ⇒ the mapper divides inline and says so.
        rowFromOption(o, input.optionPremiumBases?.get(journalIdForPosition(o))),
        input.optionMoneyRestatements?.get(journalIdForPosition(o)),
        // TRA-3989 — the stop risk is only recoverable HERE, where the position
        // is still in hand; the overlay re-derives `pnl_r_stop_basis` against
        // the restated net with it.
        optionStopRiskUsd(o),
      ),
    );
  }
  // TRA-3860 — durable-ledger rows last, so a book row and its journal twin can
  // never reorder relative to each other between two calls.
  for (const r of input.preMappedRows ?? []) rows.push(r);
  return rows;
}

export function applyFilters(rows: ExportTradeRow[], filters: ExportFilters): ExportTradeRow[] {
  const modes = filters.modes && filters.modes.length > 0 ? new Set(filters.modes) : null;
  const markets = filters.markets && filters.markets.length > 0 ? new Set(filters.markets) : null;
  const from = isFiniteNumber(filters.from) ? filters.from : null;
  const to = isFiniteNumber(filters.to) ? filters.to : null;

  return rows.filter(row => {
    if (modes && !modes.has(row.mode)) return false;
    if (markets && !markets.has(row.market)) return false;
    if (from !== null || to !== null) {
      const exitMs = row.exit_time ? Date.parse(row.exit_time) : NaN;
      if (!Number.isFinite(exitMs)) return false;
      if (from !== null && exitMs < from) return false;
      if (to !== null && exitMs > to) return false;
    }
    return true;
  });
}

export function summarize(rows: ExportTradeRow[], filters: ExportFilters): ExportSummary {
  let gross = 0;
  let fees = 0;
  let net = 0;
  let wins = 0;
  // TRA-3875 — the provenance census is derived from the SERVED rows here, where
  // TRA-3860 derived it in `index.ts` from object identity against the candidate
  // list. Same numbers, but this one survives a row being copied (which the
  // restatement overlay now does) and is reachable from the pure serializer.
  let bookRows = 0;
  let journalRows = 0;
  let superseded = 0;
  for (const row of rows) {
    if (isFiniteNumber(row.gross_pnl_usd)) gross += row.gross_pnl_usd;
    fees += row.fees_usd;
    if (isFiniteNumber(row.net_pnl_usd)) {
      net += row.net_pnl_usd;
      if (row.net_pnl_usd > 0) wins += 1;
    }
    // Absent `source` counts as book — the pre-ticket census was
    // `rows.length − journalServed`, i.e. book was the default there too.
    if (row.source === 'journal') journalRows += 1;
    else {
      bookRows += 1;
      if (row.pnl_basis === 'broker-fill') superseded += 1;
    }
  }
  return {
    count: rows.length,
    totals: {
      gross_pnl_usd: round(gross, 2),
      fees_usd: round(fees, 2),
      net_pnl_usd: round(net, 2),
    },
    win_rate: rows.length > 0 ? round(wins / rows.length, 4) : 0,
    filters,
    sources: { book: bookRows, journal: journalRows },
    supersededRowCount: superseded,
  };
}

// ── Serializers ──────────────────────────────────────────────────────────────

// TRA-3989 — `undefined` is admitted on the TYPE now that `pnl_r_stop_basis` is
// optional on the row (a hand-built fixture may omit it); the body already
// rendered it as an empty cell, so the widening changes no output.
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** RFC-4180 CSV with the §2.3 header row. */
export function toCsv(rows: ExportTradeRow[]): string {
  const lines: string[] = [EXPORT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(EXPORT_COLUMNS.map(col => csvCell(row[col])).join(','));
  }
  // Trailing newline so the file ends cleanly and POSIX tools are happy.
  return lines.join('\r\n') + '\r\n';
}

export function toJsonDocument(rows: ExportTradeRow[], filters: ExportFilters): ExportDocument {
  return { summary: summarize(rows, filters), trades: rows };
}

/**
 * One-shot: normalise → filter → both the filtered rows and their summary.
 * The route uses `rows` for CSV and the whole document for JSON.
 */
export function buildExport(
  input: ExportInput,
  filters: ExportFilters,
): { rows: ExportTradeRow[]; summary: ExportSummary } {
  const rows = applyFilters(buildRows(input), filters);
  return { rows, summary: summarize(rows, filters) };
}
