import type { DailySnapshot } from './pnl-tracker.js';
import { CLOSING_EQUITY_BASIS_BROKER, STOCK_LEG_PROBE_TOLERANCE_USD } from './pnl-tracker.js';
import { isJournalAuthoritativeSource, journalRealizingEvents } from './options-daily-pnl-source.js';
// TRA-2888 — the permanent 07-30/07-31/08-03 gap ruling. `eod-ledger-gap.ts`
// imports only a TYPE back from this module (`EodTailCalendar`), which erases at
// compile time, so this is not a runtime cycle.
import {
  PNL_EOD_DOCUMENTED_GAP_NOTE,
  PNL_EOD_INTERIOR_ACKNOWLEDGED_NOTE,
  PNL_EOD_INTERIOR_RETIREMENT_NOTE,
  sessionsInRange,
} from './eod-ledger-gap.js';
// TRA-3849 — the caveat only. The FOLD lives in that module and is called by the
// route, not from here: this function grades one book and has no fleet to fold.
import { NON_SESSION_LEDGER_ROW_CAVEAT } from './eod-nonsession-row.js';

/**
 * TRA-3589 — the era label a row carries when it predates the
 * {@link DailySnapshot.closingEquityBasis} stamp entirely.
 *
 * A string, not `null`, and deliberately so: `equitySourceEra` is the ONE field
 * on the published row that is never absent and never null, so a reader that
 * finds the KEY missing is reading a build older than this fix rather than a row
 * whose provenance is merely unknown. Absence of the key is the evidence.
 */
export const EQUITY_SOURCE_ERA_UNSTAMPED = 'unstamped-pre-tra3349';

/**
 * TRA-3589 — name the surface that set a row's `closingEquity`, as an era label
 * that always renders.
 *
 * The vocabulary is OPEN: `closingEquityBasis` is an enumerated string written by
 * several writers over several tickets, and a classifier that folded an unknown
 * value into a known bucket would launder a surface nobody has audited into one
 * somebody has. So the label is the basis string VERBATIM whenever there is one,
 * and the only closed decision in the module is the equality in
 * {@link isBrokerEquityEra} against the single constant that means "broker NAV".
 */
export function equitySourceEraOf(basis: string | null | undefined): string {
  return typeof basis === 'string' && basis !== '' ? basis : EQUITY_SOURCE_ERA_UNSTAMPED;
}

/**
 * TRA-3589 — where a book's published equity series changes SURFACE, and the
 * size of the step it takes when it does.
 *
 * The marker the CFO asked for in TRA-3589 ask 3, phrased as the invariant and
 * not as "the re-source ran": every field here is derived from durable row state
 * (two rows' basis stamps and their equity figures), so any later build can
 * re-attest it, and a build that never observed the deploy still renders it
 * correctly. Nothing is stamped onto a historical row — the era of a past row is
 * READ from what that row already carries, never written back (TRA-2886/2888
 * refuse back-fill, and a fabricated audit trail is worse than an honest gap).
 */
export interface EquitySourceEraBoundary {
  /** First session whose `closingEquity` came from the broker, or `null` if none has. */
  brokerOnsetDate: string | null;
  /** That row's `openingEquity` — a `broker-prev-eod-balance` anchor. */
  brokerOnsetOpeningEquity: number | null;
  /** The newest measured row STRICTLY BEFORE the onset, i.e. the last pre-boundary close. */
  priorEraRowDate: string | null;
  priorEraRowEquitySourceEra: string | null;
  priorEraRowClosingEquity: number | null;
  /**
   * `brokerOnsetOpeningEquity - priorEraRowClosingEquity`.
   *
   * THIS NUMBER IS NOT P&L AND MUST NOT BE REPORTED AS ONE, at any value, under
   * any name. It is the same book re-measured on a different instrument on the
   * first session after TRA-3349 went live; the onset row books it to neither
   * `stockDaily`, nor `optionsDaily`, nor `netCashFlowUsd`, which is why it is
   * invisible to every leg-level check and has to be named here instead.
   *
   * It is published as a SIGNED DOLLAR FIGURE rather than a boolean so it cannot
   * decay the way a pinned verdict does: a second boundary on a third book moves
   * it, and a reader who computed the delta by hand can match it to the cent.
   */
  restatementUsd: number | null;
  /** Every era label present on this book's rows, with counts. Open vocabulary. */
  eraCensus: Record<string, number>;
  /**
   * TRUE when this book has rows on BOTH sides of the boundary — i.e. when a
   * cross-era subtraction is possible on its published series at all. This is
   * the flag that says "a naive reader of this series can be wrong here".
   */
  seriesSpansBrokerBoundary: boolean;
}

/** TRA-3589 — the one closed decision: is this row's equity the BROKER's NAV? */
export function isBrokerEquityEra(basis: string | null | undefined): boolean {
  return basis === CLOSING_EQUITY_BASIS_BROKER;
}

/**
 * TRA-3589 — THE INVARIANT, as a predicate.
 *
 * An equity delta is a measurement of P&L only when BOTH of its endpoints were
 * read off the SAME surface. `closingEquity` on a `mode: live` book was the
 * engine's demo PaperAccount until TRA-3349 (commit `eb1dcf0`, live
 * 2026-08-12T10:39:01Z) re-sourced it from the broker FORWARD ONLY — so on both
 * live books there is a date at which the series changes surface mid-flight, and
 * a subtraction spanning it measures the change of surface, not the change of
 * money.
 *
 * Stated as the invariant rather than as "the fixed writer ran", so any later
 * build can attest it off durable row state: the operands are two rows' basis
 * stamps and nothing else. Deliberately says NOTHING about whether two
 * non-broker endpoints are mutually comparable — an unstamped row and an
 * `engine-paper-account` row are both not-broker, and asserting more than that
 * would be a fabricated audit trail.
 */
export function equitySpanCrossesSourceEra(
  leftBasis: string | null | undefined,
  rightBasis: string | null | undefined,
): boolean {
  return isBrokerEquityEra(leftBasis) !== isBrokerEquityEra(rightBasis);
}

/**
 * TRA-1633 FIX 3 — cross-surface P&L reconciliation guard.
 *
 * The board asked that the four daily-P&L surfaces (trade journal / PnL tracker /
 * EOD report / Calendar) agree. Three of them differ BY DESIGN in which legs
 * they cover — this note documents that so an operator reading a mismatch knows
 * it is definitional, not a bug:
 *
 *  - PnL tracker `dailyPnl`         → STOCK-only realized (paper-account marks)
 *  - Trade journal / Desk calendar  → OPTIONS-only realized (firm-wide journal)
 *  - EOD report / account calendar  → STOCK + OPTIONS realized (the daily cell)
 *
 * All four are realized-only and bucket on the US/Eastern day boundary. The one
 * identity that MUST hold on every day is therefore:
 *
 *     EOD.combinedPnl  ==  stock dailyPnl (realized)  +  day-only options realized
 *
 * `reconcilePnl` checks that identity per ET day and flags any |drift| over the
 * penny tolerance. Pure + I/O-free so it is unit-testable; the caller supplies
 * the persisted daily snapshots and a date→EOD-combinedPnl map read off disk.
 */

/** One-line leg-coverage note emitted in the EOD markdown header. */
export const PNL_LEG_COVERAGE_NOTE =
  '> _Leg coverage (TRA-1633): PnL tracker `dailyPnl` = stock-only; Trade journal / Desk calendar = options-only; EOD / account calendar = stock + options. All realized-only, ET day boundary._';

/**
 * TRA-2630 DEFECT A — why the single `drift` number cannot be graded, and what
 * replaced it.
 *
 * `drift` is `eodCombined − (stockDaily + optionsDaily)`. Both sides carry a
 * stock leg and an options leg, but the two stock legs have DIFFERENT
 * PROVENANCE:
 *
 *  - `eodCombined`'s stock leg is the EOD report's `realizedPnl` = Σ P&L of
 *    positions the engine's in-memory `allClosedPositions` list says closed
 *    today. The TRA-219 nightly archive CLEARS that list at 9 PM ET — the same
 *    21:00 ET slot the EOD snapshot writer runs in — and `importSnapshot`
 *    restores at most `MAX_RESTORED_CLOSED_POSITIONS`. So it is LOSSY.
 *  - `stockDaily` is the snapshot's `dailyPnl` = a DURABLE equity delta
 *    (`closingEquity − openingEquity − optionsCreditedInWindow`). `equity` only
 *    ever moves on a realized close, an option credit, or an `applyEquity`
 *    rebase, so this leg keeps the P&L the list above dropped.
 *
 * Consequence: one number absorbs at least three independent causes — an
 * options-leg disagreement, stock closes lost by the archive race, and (until
 * TRA-2629) option credit leaking into the stock leg. They are not separable
 * from `drift`, so no gate keyed on `drift` / `ok` / `maxDriftUsd` can say WHICH
 * is wrong, or go green by fixing any one of them. That is the unfalsifiability,
 * and it is a provenance defect, not an arithmetic one.
 *
 * MEASURED on live prod 2026-07-30T04:19:30Z (58 books / 167 post-baseline
 * sessions): of the 40 sessions with a non-zero `stockDaily`, the EOD report's
 * implied `realizedPnl` was EXACTLY 0.00 on **40 of 40**. 18 of those are the
 * TRA-2629 T+1 credit lag; the other 22 (including 2 `admin` live sessions) are
 * the archive race.
 *
 * FALSIFIED — the reported diagnosis "`eodCombined` stopped including equity P&L
 * at the 2026-07-12 baseline" is NOT what happens. `eodCombined` is
 * `realizedPnl + optionsPnl` in code and has never excluded the equity leg. Of
 * the 22 PRE-baseline sessions with a non-zero `stockDaily`, only **1**
 * reconciled to drift 0 — the single `admin 2026-05-05` row that diagnosis was
 * drawn from. The other 21 carry arbitrary drift (`2026-05-14`: `stockDaily
 * 686.43` vs `eodCombined 42.77`). n=1 of 22 is not a regime. So "make
 * `eodCombined` include equity P&L" cannot be the fix: it already tries to, and
 * loses it downstream.
 *
 * THE FIX — `drift` keeps its exact numeric meaning for every existing consumer
 * (the additive discipline TRA-2302/TRA-2193 established), and the two legs it
 * pools are now reported SEPARATELY, each with its own verdict:
 *
 *     stockLegDrift    = eodStockPnl   − stockDaily     → stockLegOk
 *     optionsLegDrift  = eodOptionsPnl − optionsDaily   → optionsLegOk
 *
 * TRA-2633 (CEO) — the line that used to sit here said "Each is falsifiable on
 * its own axis and each has a reachable green state. Grade THOSE." Only HALF of
 * that survived contact with the live fleet:
 *
 *   `optionsLegOk`  — TRUE **at the time that was written**. See the TRA-2641
 *                     correction below: it no longer holds.
 *   `stockLegOk`    — FALSE. `eodStockPnl` is the report's `realizedPnl`, which
 *                     the TRA-219 archive zeroes at the same 21:00 ET the report
 *                     is written: 167/167 live rows read exactly 0.00, including
 *                     all 40 with a non-zero `stockDaily`. Decomposing did not
 *                     rescue this leg — it only made its ONE cause legible. It is
 *                     now TRI-STATE and reports `null` = NOT MEASURED.
 *
 * ── TRA-2641 CORRECTION: the options leg became SELF-CONFIRMING ──────────────
 *
 * TRA-2641 shipped `syncEodReportOptionsLegs`, which writes the day cell's
 * `optionsDailyPnl` INTO the report file's options leg for every row the journal
 * is authority for (`optionsDailyPnlSource` of `journal` / `journal-repair`).
 * That fix is CORRECT — the file should converge on the journal. But
 * `optionsLegDrift` is `eodOptionsPnl − optionsDaily`, so on exactly those rows
 * both operands now trace to ONE source and the difference is 0 BY CONSTRUCTION.
 *
 * Measured on live prod 2026-07-30T09:40Z, build `239f2b5`, 167 post-baseline rows:
 *
 *     journal / journal-repair (file leg written FROM the day cell)  147  (88.0%)
 *       └─ rows among those with a non-zero `optionsLegDrift`          0
 *     no provenance (legs genuinely independent)                      20  (12.0%)
 *       └─ rows among those where EITHER leg is non-zero               0
 *     ⇒ rows that could produce a non-zero `optionsLegDrift`           0 / 167
 *
 * So `optionsLegOk` flipped false→true across the TRA-2641 deploy
 * (`maxOptionsLegDriftUsd` 217.50 → 0.00) and that flip reads as "the defect was
 * fixed" when what actually happened is that the last independence between the
 * two operands was removed. A tautological comparison cannot fail, which is
 * Defect A's own shape — one level further down, in its own fix.
 *
 * `optionsLegOk` is therefore TRI-STATE too, and the verdict order is
 * RED > NOT MEASURED > GREEN: a slaved row that STILL disagrees means the writer
 * failed, which is a genuine red and must never be masked by the `null`.
 *
 * So: grade neither leg as a reconciliation verdict. The independent signal is
 * the CREDIT axis — `equityAbsorbedOptionsOk` / `uncreditedOptionsUsd` — whose
 * two operands are the journal and the EQUITY ledger, which no writer joins.
 * Read both `*LegDrift` values as EVIDENCE (they attribute where a pooled error
 * lives) but never as a VERDICT.
 */
export const PNL_DRIFT_DECOMPOSITION_NOTE =
  'TRA-2630: `drift` pools a LOSSY stock leg (EOD `realizedPnl`, cleared by the TRA-219 21:00 ET archive) against a DURABLE one (snapshot `dailyPnl`, an equity delta), so it cannot attribute a mismatch. `drift`, `ok` and `maxDriftUsd` are retained unchanged for existing consumers but are NOT gradeable. TRA-2641 CORRECTION — this note previously said to grade `optionsLegOk` only; that is now WRONG and is retracted. NEITHER leg is a gradeable reconciliation verdict. `stockLegOk` inherits the same lossy source `drift` does. And `optionsLegOk` became SELF-CONFIRMING: TRA-2641\'s `syncEodReportOptionsLegs` writes the day cell\'s `optionsDailyPnl` into the report file\'s options leg on every `journal`/`journal-repair` row, so `optionsLegDrift` = `eodOptionsPnl` - `optionsDaily` compares one source against a copy of itself. Live 2026-07-30, build 239f2b5: 147/167 post-baseline rows are journal-slaved (0 with non-zero drift) and the other 20 carry 0.00 on BOTH legs, so 0 of 167 rows can produce a non-zero drift. The false->true flip across that deploy (max 217.50 -> 0.00) reads as "fixed" but is the operands losing independence. BOTH legs are now TRI-STATE with `null` = NOT MEASURED; read `optionsLegMeasuredCount` / `optionsLegSlavedCount` for the denominator, and never read a `null` as green. The INDEPENDENT signal to grade instead is the CREDIT axis — `equityAbsorbedOptionsOk` / `uncreditedOptionsUsd` — whose operands are the journal and the equity ledger, which no writer joins. Verdict order on both legs is RED > NOT MEASURED > GREEN: a slaved row that still disagrees means the sync writer failed, and that red is never masked. TRA-2924 COVERAGE — publishing the denominator was not enough: on 2026-08-05 (build 237c147e) the live cohort was 1 measured against 207 slaved and `optionsLegOk` had DEGRADED from `null` to `true`, a fleet-wide green asserted off 0.5% of the rows that had something to say. A green now additionally requires `optionsLegScope === \'fleet\'`, i.e. `optionsLegSilencedDates` (evaluated rows with a non-zero leg that were excluded from the denominator) is EMPTY. That is an identity, not a minimum cohort size or a share threshold - a constant would decay the way a dollar-denominated one does. `partial` reports `null` and keeps the residual evidence in `optionsLegCoveredDates`; `optionsLegCoverageShare` is descriptive only and nothing branches on it. While `syncEodReportOptionsLegs` slaves every journal row the fleet green is UNREACHABLE by construction, and that is the finding rather than a bug in the gate: grade the CREDIT axis instead.';

export const PNL_ABSENT_EOD_ROW_NOTE =
  'TRA-2637: an ABSENT EOD row is NOT a pass. `drift` is now `null` (was 0) on any session whose `eodCombined` is null, and the absence is graded on its own axis — per-row `eodRowMissing`, per-book `eodRowsPresentOk` / `eodRowMissingDates` / `eodRowGradeableCount`, fleet-level `liveEodRowsPresentOk` / `liveEodRowMissingBooks`. Live proof: `admin` 2026-07-29 served `drift: 0` with `eodCombined: null` over 6 journal closes worth +$250.01. The presence verdicts are TRI-STATE; `null` = NOT MEASURED (empty cohort) and must never be read as green.';

export const PNL_FROZEN_COUNTER_NOTE =
  'TRA-2658: a FROZEN `optionsCreditedCumulative` is invisible to the reset signatures. `counterDurable` graded non-durability off `lagsPriorOptionsDaily` and a NEGATIVE window, and both are MOTION detectors — a counter stuck at exactly 0 never decreases and never pushes a credit into the stock leg, because `openingEquity` absorbed the credit across a boot before the 21:00 close ran. Live bqb1 2026-07-30T14:08Z: `admin` served `counterDurable: true` with `counterResetDates: []` and `optionsCreditedCumulative: 0` on 07-27, 07-28 AND 07-29, while $254.00 of option credit had demonstrably reached its equity ($2,008.29 -> $2,243.48 against a -$18.81 stock leg). So the predicate TRA-2658 AC2 grades had NO FAILING STATE on the one book that mattered. The third signature is `unbookedEquityMoveUsd` = (closingEquity - prevClosingEquity) - stockDaily - optionsCreditedInWindow, which is algebraically `openingEquity - prevClosingEquity` and is 0 on a continuously-run book; it read +140.00 on 07-28 (= 07-27 `optionsDaily` to the cent) and +114.00 on 07-29. Its operands are three durable snapshot fields that NO writer joins, so it cannot go self-confirming the way TRA-2641 `optionsLegDrift` did. It now folds into `counterDurable` via `counterFrozenDates`; read `counterNonDurableDates` for the union and `counterResetDates` for the original narrower meaning — a ZEROED counter and a FROZEN one need OPPOSITE remediations, because a zeroed counter has already double-booked the credit into `stockDaily` (making `uncreditedOptionsUsd` an upper bound) while a frozen one leaves the stock leg exact and the credit present in `closingEquity` but absent from every daily row. `unbookedEquityMoveDates` additionally publishes un-attributed moves (a starting-balance edit via `PaperAccount.applyEquity` is the benign cause) WITHOUT folding them into the verdict. TRA-2926: the accusation is GAP-GATED — a row whose `priorSessionAdjacent` is false (its prior ROW sits across the permanent TRA-2888 hole) reads `counterFrozen: null` (NOT MEASURED), because `prevClosingEquity` there spans several settled sessions and real gap-session P&L lands as "unbooked" (2026-08-04: 36/36 unbooked rows and 12/12 frozen rows were non-adjacent). The raw `unbookedEquityMoveUsd` stays published on suppressed rows; read `counterFrozenGradeableDates` for the detector\'s denominator and `counterGapSuppressedDates` for the suppressed set. `counterDurable` is `null`, never green, when that denominator is empty.';

export const PNL_LIVE_MODE_SPAN_NOTE =
  'TRA-2831: the live COHORT is keyed on the book\'s mode TODAY (`stockModeKey(loadSettings(username))`, read per request) while the day-cell options ledger under it is per-BOOK and MODE-BLIND for all time. On any book that flipped demo -> live mid-series those compose into a silent attribution defect: the whole pre-flip DEMO history folds into every `live*` credit metric. Live bqb1 2026-08-04T22:22Z: `liveUncreditedOptionsUsd` published 733.60 as a live-money shortfall, whose numerator `postBaselineOptionsRealized` 987.60 is the sum of eleven `journal-repair` cells dated 2026-07-15..2026-07-29 — a window in which the live book (`admin`) held ZERO live options, its first having opened 2026-07-30 09:36 ET. Those 987.60 are admin\'s own DEMO option P&L: summing every book\'s `journal-repair` cells fleet-wide reproduces the demo-mode fleet total to the cent (07-15 301.30, 07-17 102.00, 07-22 4919.50), with admin contributing 17.00 / 217.50 / 54.40. The equality to `eodCombined` on those rows is NOT independent corroboration — it is the TRA-2641 slaving (`syncEodReportOptionsLegs` writes the day cell into the report file\'s options leg on every `journal`/`journal-repair` row) plus a 0.00 stock leg on 9 of the 11. `liveUncreditedOptionsUsd` is now null (NOT MEASURED) whenever any contributing book carries pre-onset options money. DO NOT FALL BACK TO `liveUncreditedOptionsUsdUnscoped` -- an earlier revision of this note pointed readers at it "for the arithmetic" and that instruction is WITHDRAWN by TRA-2922 (CFO ruling, 2026-08-05), which made the suspension PERMANENT and keyed it to an IDENTITY rather than to a dollar figure: while `optionsRealizedBeforeLiveOnsetUsd >= postBaselineOptionsRealized` on a book, that book\'s `uncreditedOptionsUsd` carries ZERO live-onset options money and MUST NOT be reported, escalated or budgeted as a live-money shortfall, at ANY value, under any name. `*Unscoped` is that same suspended measurement under a different key and is published as EVIDENCE ONLY. The decisive leg is an inequality, not a magnitude: the pre-onset window 07-15..07-29 is a strict SUBSET of the post-baseline window, so `preOnset <= postBaseline` must hold and it does not (987.60 > 985.60 on 2026-08-05) -- MORE than 100 percent of the numerator predates onset, and zero of it is live-onset money. A rule keyed to the value would have expired on contact: the same contaminated measurement rendered 733.60 (08-04), 371.59 (08-05) and -52.41 (08-06), so it has already changed SIGN and any consumer still reading it would now report the live book as OVER-credited. Read `liveUncreditedOptionsGradeable` for the denominator -- print that denominator alongside any verdict, because exactly ONE book (`admin`) of the two live books carries a non-null `liveOptionsOnsetDate`, so an "all live books pass" predicate is TRUE on a cohort of one and would stay TRUE on a cohort of ZERO -- and `liveModeSpanContaminatedBooks` for the attribution. For an actual live-money number read `engines[].postOnsetCredit` (TRA-2919), never this key. Completing TRA-2827\'s 07-30/07-31/08-03 back-fill does NOT discharge this: those rows are post-onset and add a live term without removing the 987.60 pre-onset term. NOTE also that `optionsDailyPnl` is not a field on the published day rows at all — the durable snapshot field of that name surfaces as `optionsDaily`, and querying the published shape for `optionsDailyPnl` returns null on all 67 admin cells (and on every cell of every book) as a NAME MISS, not as a TRA-2629-style dropped field; the values are present and journal-sourced (`optionsDaily === journalOptionsPnl` on all 11 repaired cells, where `journalOptionsPnl` is recomputed per request straight from the journal). TRA-3864 CORRECTION (2026-08-19) — that last identity is asserted too broadly and is now FALSE ON THE LIVE MONEY BOOK. It held when it was written and it still holds on those 11 cells; it does NOT hold as a standing property of journal-authoritative cells, because a day cell is PERSISTED at the 21:00 ET archive while `journalOptionsPnl` is RECOMPUTED per request, and the TRA-2819 close-basis restatement (applied in bulk by the TRA-3730 sweep) moves the journal row AFTERWARDS. Nothing propagates the correction into the cell and — until TRA-3864 — nothing subtracted the two numbers this object publishes side by side. Measured on bqb1 build `bc92e57109c1` 2026-08-19T21:2xZ: 985 day cells fleet-wide, 853 journal-authoritative, 3 divergent — `admin`/live 2026-08-18 `optionsDaily` -393.00 vs `journalOptionsPnl` -271.23 (delta -121.77, the `SPY260821C00777000` restatement -278.00 -> -156.23 EXACTLY), `admin`/live 2026-08-11 -16.00 vs -16.86 (delta +0.86, a commission from the TRA-3730 cohort), `qa_mirror_1578_38096`/demo 2026-07-28 48.50 vs 111.50. 850/853 holding the identity is what makes those 3 real rather than reader noise. DO NOT read `optionsLegDrift` for this — it is 0.00 on all three and CORRECTLY so, per the TRA-2641 slaving ruling above; that leg has no failing state on this cohort by construction. THE RULING: the cell is FROZEN at archive time, not re-derived (silently rewriting a non-zero booked figure is what `planOptionsDailyPnlRepair` already refuses to do, TRA-2079), and `optionsDailyPnlSource` names WHICH WRITER BOOKED THE NUMBER — it is not, and never was, a claim that the number is still current. Currency is now a first-class field: read `days[].optionsDailySupersededByJournal` and `days[].journalOptionsPnlDeltaUsd` per row, `engines[].journalSupersededDates` / `journalAgreementOk` / `journalAgreementGradeableCount` per book, and `journalDayCellAgreementOk` / `journalDayCellGradeableCount` / `liveJournalDayCellSupersededBooks` fleet-wide. Quote the GRADEABLE COUNT beside any green: this axis is tri-state and `null` means nobody looked.';

export const PNL_POST_ONSET_JOURNAL_CREDIT_NOTE =
  'TRA-2919: the live credit axis TRA-2630 named as the INDEPENDENT signal was PERMANENTLY ungradeable after TRA-2831, and is now re-sourced from the option-trade JOURNAL. TRA-2831 was right to suspend `liveUncreditedOptionsUsd` (its numerator was 987.60 of admin\'s own DEMO option P&L), but its gate keys on `optionsRealizedBeforeLiveOnsetUsd`, which is DURABLE history and does not age out -- so the axis could never flip back. DO NOT "fix" this by scoping the existing day-cell numerator to post-onset dates. Measured on bqb1 2026-08-05: admin had exactly ONE post-onset day cell (2026-08-04, `optionsDaily` -2.00, source `bucket-journal-silent`), so a day-cell post-onset numerator publishes -2.00 while the live book actually realized +739.00 on 2026-07-31 across 3 journal closes -- money booked to NO day cell at all, because 07-30/07-31/08-03 are the permanent TRA-2888 hole and back-fill is refused. A wrong number carrying `gradeable: true` is strictly worse than the honest null. The journal is append-only, is keyed by CLOSE timestamp rather than by the existence of a snapshot row, and survived the ENOSPC window with `corruptLines 0`; it is the only surviving source. Read `engines[].postOnsetCredit` per book and `liveOnsetOptionsRealizedJournalUsd` fleet-wide; `liveOnsetOptionsDayCellUsd` publishes the day-cell FOIL over the same window so the rejected arithmetic stays visible. THE COMPARISON IS A SEPARATE QUESTION: the equity leg is holed over the same window, so `liveOnsetUncreditedOptionsUsd` (= journal numerator + post-onset stockDaily - post-onset equity delta) is null whenever an expected NYSE session inside the anchor window `(leftAnchor, rightAnchor]` has no ledger row -- reason `equity-anchor-spans-absent-session`, which is admin\'s standing state. Absence is enumerated from the exchange calendar and diffed against the rows, deliberately NOT from the three known gap dates: a hard-coded list goes green by EVICTION the moment a newer row advances past it (exactly how TRA-2888 retired `liveEodTailStaleBooks`) and is blind to the next hole. `liveUncreditedOptionsGradeable` is REDEFINED by this ticket to mean "some live book has a journal-sourced post-onset numerator", i.e. ATTRIBUTION only; it is NOT a claim that the dollar comparison exists, and `true` alongside `liveOnsetUncreditedOptionsUsd: null` is the correct standing read. A gate wanting the money verdict must require BOTH that boolean AND `liveOnsetCreditNotMeasuredBooks` to be EMPTY. The day-cell fields `liveUncreditedOptionsUsd` / `liveUncreditedOptionsUsdUnscoped` / `liveModeSpanContaminatedBooks` are UNCHANGED and stay published as the evidence the TRA-2831 suspension rests on. TRA-3288 UPDATE: `equity-anchor-spans-absent-session` was a HOLE gate that was right by accident -- `closingEquity` on every RECORDED row is the engine\'s DEMO PaperAccount (frozen on a live book by design), so a hole-free window still grades broker-journal dollars against demo-book dollars. A live book\'s comparison is now refused with `equity-anchor-not-broker-sourced` (precedence over the absence reason) unless BOTH anchor rows carry `closingEquityBasis: \'broker-eod-balance\'`; recorded rows now stamp `\'engine-paper-account\'`, and an ABSENT basis reads as NOT broker-sourced. This is admin\'s and v0nni\'s standing state and it is PERMANENT for admin (its left anchor is a demo-book row and back-fill is refused); the axis becomes measurable only on rows written broker-sourced going forward.';

/**
 * TRA-3517 — what a GREEN `combinedAgreementOk` is worth, published beside the
 * axis so nobody has to re-derive it.
 */
export const PNL_COMBINED_AGREEMENT_NOTE =
  'TRA-3517: `engines[].combinedAgreementOk` / `days[].combinedAgreement` is the reader that REPLACES `drift` on a broker-shaped row. TRA-3349 correctly suppressed `drift` to null there (the `eodCombined == stockDaily + optionsDaily` identity is an engine-book decomposition a broker row does not satisfy), and that suppression removed the ONLY automated cross-check watching `combinedPnl` on live books; the row/report agreement meant to replace it was published on neither side, so a future divergence between the TRA-359 override and the stored row would have been silent. READ A GREEN NARROWLY. Both sides are written from the SAME `override` object on the same tick (`applyTradierBalanceOverride` for the report, `shapeLiveRecordedRow` for the row), so agreement holds BY CONSTRUCTION today and is NOT independent corroboration that the broker figure is right — it would read exactly the same if the figure were wrong on both. What it can catch is the two stores DRIFTING APART later: a re-generated report, a back-fill, a clobber, or a refactor that stops threading the override into the row. The axis is graded ONLY where the claim is made (row `closingEquityBasis: \'broker-eod-balance\'` AND report `pnlSource: \'tradier-balance\'`); everywhere else it is `\'not-measured\'` with a reason, and `\'not-measured\'` MUST NEVER be folded into `\'agree\'` — on the broker-shaped cohort a vacuous true is the same reading as a real pass. `combinedAgreementOk: null` means NOTHING THAT COULD HAVE FAILED was looked at; report that state as `unknown`, never as clean. TWO DENOMINATORS, AND THEY DIFFER: `combinedAgreementGradeableCount` is how many sessions the axis GRADED, `combinedAgreementDiscriminatingCount` is how many of those could have read `disagree` (at least one side materially non-zero) — and the verdict keys on the SECOND. A session where the row and the report both read 0.00 emits `agree` however broken the wiring is, so it is a measurement and not evidence. First live read of this axis, 2026-08-13T08:39Z on build 3877000: graded 2, discriminating 1 — `admin` 2026-08-12 at -0.10 vs -0.10 is the real one, `v0nni` 2026-08-12 at 0.00 vs 0.00 is degenerate. Quote the discriminating count beside any verdict; the graded count alone doubles the apparent coverage of a single session. Also read `combinedPnlNoReaderDates` (real-money sessions whose `combinedPnl` neither reader observes).';

/**
 * TRA-3948 — the equity-probe axis and the false-green it replaces, published
 * beside the fields so a gate author reading the payload head cannot miss it.
 */
export const PNL_STOCK_LEG_PROBE_NOTE =
  'TRA-3948: on a broker-shaped LIVE row `stockLegDrift` and `maxStockLegDriftUsd` ARE STRUCTURALLY 0 AND CANNOT SEE THE EQUITY RESIDUAL THEIR NAMES PROMISE. This is not a formula bug, it is a scope mismatch, and it read as a live green for four sessions. `stockLegDrift` is `eodStockPnl - stockDaily`; the probe is `closingEquity - openingEquity - optionsDaily - netCashFlowUsd`. The operand sets are DISJOINT. `shapeLiveRecordedRow` books `dailyPnl: 0` on every broker-shaped row by design (broker delta-equity already contains the stock P&L, so booking a demo stock figure beside it would be the TRA-3288 two-surface error relocated) and the TRA-219 21:00 ET archive zeroes `eodStockPnl`, so the drift computes `0 - 0` for EVERY possible value of the probe. Measured live 2026-08-22T04:42Z on build `0fd3b68`: `admin` served `stockLegBasis: \'zero-probe-disagrees\'` with `stockLegProbeUsd` -197.36 (08-17), +196.56 (08-18), -71.36 (08-20) and +112.47 (08-21) -- $197.36 against a $946.60 closing equity, ~21 percent of the book in one session -- while `stockLegDrift` read 0 on all four and 0 of the endpoint\'s 117 top-level keys matched /probe|basis/. THE OTHER TWO READERS WERE ALSO SILENT, AND FOR STRUCTURAL REASONS: row-level `drift` is `null` on a broker-shaped row (TRA-3349, correctly), and `stockLegOk`\'s cohort requires `stockDaily !== 0`, which the writer pins to 0, so no live row can EVER enter it -- the fleet `stockLegOk: false` / `stockLegMeasuredCount: 217` / `maxStockLegDriftUsd: 765` on the same pull is entirely DEMO rows and is pinned red, carrying no information about a live probe in either direction. READ `liveStockLegProbeOk` INSTEAD (per book: `engines[].stockLegProbeOk`; per row: `days[].stockLegProbeUsd` / `stockLegBasis`). It is TRI-STATE, RED > NOT MEASURED > GREEN, and `null` means nobody looked. THE VERDICT KEYS ON THE NUMBER, NOT ON THE `stockLegBasis` STRING: that vocabulary is an open enum owned by another module, and binding to `\'zero-probe-disagrees\'` would let a renamed or added constant empty the offender set and turn the axis green with no code change here. `stockLegBasisCounts` publishes the strings as DIAGNOSIS. QUOTE `liveStockLegProbeDiscriminatingCount`, NOT `liveStockLegProbeMeasuredCount`, BESIDE ANY VERDICT: a dormant book probes 0-0-0-0 and emits `zero-probe-agrees` however broken the wiring is, and this is not hypothetical -- live book `v0nni` sat at 400.00 -> 400.00 across all 8 of its probed sessions on that pull, so the measured count reads 16 clean-ish sessions over what is really 4 discriminating live sessions, ALL FOUR of which disagree. `liveStockLegProbeNotMeasuredCount` is the third state: rows the writer stamped a basis on whose probe could not run (an operand absent); a `null` verdict beside a non-zero value there is a COVERAGE HOLE on real-money rows, never a pass. AND THE AXIS DOES NOT COVER THE WHOLE LIVE BOOK -- READ `liveStockLegProbeUnstampedCount` BESIDE ANY GREEN. The `admin` book has 14 sessions since its 2026-07-30 live-options onset, and they split into THREE regimes, not one: 07-30/07-31/08-03 have NO ledger row (the permanent TRA-2888 hole, see the `eodInterior*` axes); 08-04..08-11 are 6 rows stamped `equitySourceEra` = unstamped-pre-tra3349 whose `closingEquity` is FROZEN at 2603.49 across the entire run (the TRA-3288 preserved demo PaperAccount) while options booked -$462, so `stockDaily: 0` there is the FROZEN SURFACE and not the deliberate broker-row 0, and they carry no probe and never will; only 08-12..08-21 are broker-shaped and probed. So "`stockDaily` is 0 on all 14 post-onset sessions" is TWO different phenomena with two different causes, and only the second is by design. FINALLY, WHAT THE PROBE IS NOT: it is the per-session equity move NEITHER BOOKED LEG ACCOUNTS FOR, not a claim that the residual is stock P&L. `netCashFlowUsd` was 0 and MEASURED (not null) on all 8 admin rows -- a null flow forces `stockLegBasis: \'zero-probe-not-measured\'` -- so a deposit or withdrawal is excluded, conditional on the TRA-359 flow capture; mis-timed option credits, fees and assignment are not. Attribution is open work; the DETECTOR is what this ticket restored. TRA-3954 (2026-08-22): THE THREE-OPERAND PROBE HAD NO UNREALIZED-MARK OPERAND. Every operand above is REALIZED except `closingEquity`, the broker mark-to-market, so the probe read the MTM-vs-realized gap and pinned RED on EVERY session the book held an option overnight: TRA-3951 reconciled admin 08-17 (-197.36) and 08-20 (-71.36) to the cent as unrealized P&L on four open contracts (bought 691.44, marked 494.08), reversing on the session each closed. No missed trade. The writer now captures the EOD open-option mark (`option_long_value - sum cost_basis`, Tradier `/balances` + `/positions`, same tick as the balance snapshot, `tradier-eod-option-mark.<env>.json`) and subtracts its session-over-session delta: `stockLegProbeUsd = dEquity - optionsDaily - dOpenOptionMark - flow`. Rows carry `openOptionMarkUsd`, `openOptionMarkDeltaUsd` and `stockLegProbeMarkBasis` (`mark-differenced` / `mark-not-measured`). THE VERDICT IS UNCHANGED AND STILL KEYS ON THE NUMBER; what changed is what the number MEANS on a row with the operand. READ `liveStockLegProbeMarkDifferencedCount` BESIDE ANY VERDICT: a probe row WITHOUT the operand (every row written before 2026-08-22, and any session whose capture failed -- never assumed 0) is still the MTM gap, and `liveStockLegProbeOffendingWithoutMarkCount` says how many of the REDs are that and not a missed trade. The four pre-existing admin offenders remain RED and remain honest -- they cannot be re-stamped (no historical mark exists) and are NOT softened. `liveStockLegProbeOvernightReconciledCount` is the count that matters for this fix: a discriminating session with |mark delta| above tolerance that reconciled within tolerance -- the GREEN branch that had NEVER fired live. 0 beside a green means it still has not. The difference is taken against `optionsDaily`, NOT `journalOptionsPnl`: Tradier says `optionsDaily` is the correct side (08-18 realized -393.92 vs -393; `journalOptionsPnl` -271.23 is wrong by 122.69, acknowledged under TRA-3864). The mark delta is NOT MEASURED on the first session after the capture ships (no prior endpoint) and on any session carrying a non-zero `option_short_value` (the positions parser is long-only, so the basis would be incomplete).';

/**
 * TRA-3589 — the NAV source-of-record boundary, in band.
 *
 * Filed by the CFO off an independent pull: on 2026-08-12 both `mode: live`
 * books changed the surface their equity is read from and stepped down in the
 * same session, with `netCashFlowUsd: 0`. The change was intended and is an
 * improvement; what was missing was any statement of it inside the data.
 */
export const PNL_EQUITY_SOURCE_ERA_NOTE =
  'TRA-3589: `closingEquity` on a `mode: live` book changed SOURCE OF RECORD mid-series. TRA-3349 (commit `eb1dcf0`, authored 2026-08-12 06:36 ET, live on bqb1 2026-08-12T10:39:01Z) re-sourced the live recorded row from the broker `tradier-eod-balance` file, FORWARD ONLY — historical rows were deliberately NOT restated, because back-fill is refused (TRA-2886/2888) and a fabricated audit trail is worse than an honest gap. Before that boundary a live book\'s `closingEquity` was `PaperAccount.getState().totalEquity`, written unconditionally at `index.ts:2058` — on a live book that is the PRESERVED DEMO seed, a constant no live fill or option credit can move (TRA-3288, RULED). So EVERY live NAV figure this endpoint published before 2026-08-12 was demo-sourced, and the numbers on either side of the boundary are not the same measurement. FIRST BOUNDARY, MEASURED: `admin` 2026-08-11 close 2603.49 -> 2026-08-12 open 1144.06 (step -1459.43); `v0nni` 25000.00 -> 400.00 (step -24600.00); combined -26059.43. Both onset rows carry `netCashFlowUsd: 0`, `stockDaily: 0` and `optionsDaily: 0`, so the step is booked to NO leg and is invisible to every leg-level check — which is why it is named here instead. THE INVARIANT: an equity delta is a P&L measurement only when BOTH endpoints were read off the SAME surface. Read `days[].equitySourceEra` (always present, never null — the basis string verbatim, or `\'unstamped-pre-tra3349\'`; if the KEY itself is missing you are reading a build older than this fix), `engines[].equitySourceEraBoundary` per book, and `liveEquitySourceEraBoundaryBooks` / `liveEquitySourceEraRestatementUsd` fleet-wide. `restatementUsd` IS NOT P&L AND MUST NOT BE REPORTED, ESCALATED OR BUDGETED AS A LOSS, at any value, under any name — it is the same book re-measured on a different instrument. WHAT THIS ALREADY CONTAMINATED: `engines[].postBaselineEquityGrowth` differences `closingEquity[last] - closingEquity[first]` across the whole post-baseline window, and since 2026-08-12 those endpoints straddle the boundary — the SAME cross-surface error TRA-3288 gated out of `postOnsetCredit`, relocated from across-books to across-time. Live on build `4cac8b70ee3c` 2026-08-13T18:27Z it published `v0nni.uncreditedOptionsUsd: 24600.00` on a book with `liveOptionsOnsetDate: null` and `postBaselineOptionsRealized: 0` — a book that has never opened an option in any mode, so 100% of that "options money missing from NAV" was the surface change; `admin` carried 1371.12 the same way, and the fleet fold `liveUncreditedOptionsUsdUnscoped` published their sum 25971.12, against 733.60 (2026-07-30) and 371.59 (2026-08-05). `uncreditedOptionsUsd` now reads NOT MEASURED with `uncreditedOptionsNotMeasuredReason: \'equity-span-crosses-equity-source-era\'` on any book whose window straddles, and `liveUncreditedOptionsUsdUnscoped` follows it to `null` (never 0). THE OPERANDS STAY PUBLISHED — `postBaselineEquityGrowth`, `postBaselineOptionsRealized` and `postBaselineStockDaily` are unchanged, because deleting the arithmetic would destroy the evidence the refusal rests on. NOT AFFECTED: the dashboard / daily-P&L baseline still rebases on the paper equity (`engines[].anchor` read 2603.49 basis `day-roll-state-equity` on 2026-08-13, i.e. it did NOT follow the row), so the step does not surface there as a one-day loss; and `postOnsetCredit` was already refusing with `equity-anchor-not-broker-sourced`. This suppression is NOT a cohort eviction: the boundary is published as a signed dollar figure per named book, so a second boundary on a third book moves it.';

/** Two legers never reconciled — surfaced in the endpoint output as a caveat. */
export const PNL_RECONCILIATION_CAVEATS = [
  'The account calendar reads the user\'s personal engine book; the Desk calendar + demo back-fill read the firm-wide option-trade-journal.jsonl — the SAME date can show different numbers for the operator vs the trading accounts. These two ledgers are never reconciled by design.',
  '/api/health/option-journal folds ALL modes; the Desk calendar filters mode:\'demo\'. Comparing the two mixes live rows into one side.',
  PNL_DRIFT_DECOMPOSITION_NOTE,
  PNL_ABSENT_EOD_ROW_NOTE,
  PNL_FROZEN_COUNTER_NOTE,
  PNL_LIVE_MODE_SPAN_NOTE,
  PNL_POST_ONSET_JOURNAL_CREDIT_NOTE,
  PNL_EOD_DOCUMENTED_GAP_NOTE,
  PNL_EOD_INTERIOR_RETIREMENT_NOTE,
  PNL_EOD_INTERIOR_ACKNOWLEDGED_NOTE,
  PNL_COMBINED_AGREEMENT_NOTE,
  PNL_STOCK_LEG_PROBE_NOTE,
  PNL_EQUITY_SOURCE_ERA_NOTE,
  NON_SESSION_LEDGER_ROW_CAVEAT,
];

/**
 * TRA-2630 DEFECT A, AC1 — the fields a gate must NOT key on, published as DATA.
 *
 * AC1 offered two closes: make `drift` mean what its name says, or keep it
 * options-only and DOCUMENT it "so no future gate mistakes it for a
 * reconciliation error". The documented close shipped — and then the
 * documentation landed one level BELOW the fields it documents. `caveats` is
 * returned by {@link reconcilePnl}, so on the wire it lives at
 * `engines[i].caveats`, while `ok` and `maxDriftUsd` — the two fields TRA-2624's
 * C5 actually keyed on — sit at the TOP level with nothing beside them. A gate
 * author reading the response head sees `"ok": false, "maxDriftUsd": 765` and no
 * hint that neither is a verdict. That is the same mistake this AC exists to
 * prevent, committed by its own fix.
 *
 * Two things follow, and the second matters more:
 *
 *   1. `caveats` is hoisted to the top level, beside the fields it disclaims.
 *   2. The disclaimer is also emitted MACHINE-READABLY. A prose sentence inside
 *      a string array cannot be asserted by a checker; `driftGradeable: false`
 *      can. A gate that wants to fail closed on ungradeable inputs can read one
 *      boolean instead of grepping English.
 *
 * `driftGradeable` is a constant, deliberately. It is not a verdict about
 * today's data — it is a STRUCTURAL property of how `drift` is computed: the
 * stock leg is summed from `allClosedPositions`, which the TRA-219 21:00 ET
 * archive clears at the same moment the report is written, so it is lossy by
 * construction while `stockDaily` (an equity delta) is durable. Pooling those
 * two can never have a reachable green state. It flips to `true` only when a
 * writer change makes both operands durable — at which point this constant is
 * the thing that must be edited, on purpose, with evidence.
 */
export const PNL_DRIFT_GRADEABLE = false;

/**
 * Top-level response fields that are RETAINED for existing consumers but are not
 * gradeable verdicts, plus the per-row field they are folded from. Published so
 * a checker can enumerate them rather than hard-code its own copy of the list.
 *
 * The first three are TRA-2630's: `ok` / `maxDriftUsd` / `drift` pool a lossy
 * stock leg with a durable one and have no reachable green state.
 *
 * `eodInteriorAbsentOk` joins them under TRA-2943 for a different reason and it
 * is worth keeping the two reasons distinct: it is not structurally ungradeable,
 * it is PINNED FALSE by an adjudicated absence (`enock`, thirty never-written
 * sessions) that does not self-heal while `baselineDate` stays 2026-07-12. A
 * second interior-absent book would not move it. Grade the SET OF USERNAMES in
 * `eodInteriorAbsentBooks`; see `EOD_INTERIOR_ABSENT_OK_RETIREMENT`, published on
 * the payload as `eodInteriorAbsentOkRetirement`. `liveEodInteriorAbsentOk` is a
 * DIFFERENT cohort and is deliberately absent from this list — it stays gradeable.
 *
 * TRA-2931 gives that entry a machine-readable successor: `eodInteriorAbsentOk`
 * stays here and stays pinned false, but `eodInteriorNotAcknowledgedOk` /
 * `eodInteriorNotAcknowledgedBooks` grade the same absence with the adjudicated
 * `enock` pairs subtracted, so a gate has a predicate instead of the retirement's
 * human instruction to "read the set of usernames". It is deliberately NOT in
 * this list. Note it is RED today and correctly so — 2026-08-07, TRA-3267.
 */
export const PNL_UNGRADEABLE_FIELDS = [
  'ok',
  'maxDriftUsd',
  'engines[].drift',
  'eodInteriorAbsentOk',
  // TRA-3948 — SCOPED entries, and the scope is load-bearing. Both fields are
  // gradeable on the DEMO cohort, where `stockDaily` is a real equity delta;
  // they are structurally 0 only on broker-shaped LIVE rows, where the writer
  // pins `dailyPnl: 0` and the archive zeroes `eodStockPnl`. Listing them
  // unscoped would retire a working demo signal to fix a live one. See
  // `PNL_STOCK_LEG_PROBE_NOTE`; the live reader is `liveStockLegProbeOk`.
  'maxStockLegDriftUsd (live cohort only — structurally 0)',
  'engines[].stockLegDrift (broker-shaped rows only — structurally 0)',
];

/**
 * TRA-2630 AC1 — the gradeability disclaimer, hoisted to the top of the payload.
 *
 * Spread into `/api/health/pnl-reconciliation` beside `ok` / `maxDriftUsd`. See
 * {@link PNL_DRIFT_GRADEABLE} for why this is a constant and not a measurement.
 */
export function summarizeDriftGradeability(): {
  driftGradeable: boolean;
  ungradeableFields: string[];
  caveats: string[];
} {
  return {
    driftGradeable: PNL_DRIFT_GRADEABLE,
    ungradeableFields: [...PNL_UNGRADEABLE_FIELDS],
    caveats: PNL_RECONCILIATION_CAVEATS,
  };
}

/** Penny tolerance — a drift at or below this is treated as clean (rounding). */
export const PNL_RECONCILE_TOLERANCE_USD = 0.01;

/**
 * TRA-1636 — default reconciliation baseline (inclusive ET `YYYY-MM-DD`). The
 * TRA-1633 P&L fix shipped `634261c` on 2026-07-12; snapshots from before that
 * ET day were written by the buggy code (stale repeated stock marks, all-time
 * cumulative leaking into a day cell) and can never reconcile. Days on/after the
 * baseline are the ones the fixed code produced. Override with the
 * `PNL_RECONCILE_BASELINE_DATE` env var; set it to `none`/empty to evaluate all
 * history (the pre-TRA-1636 behaviour).
 */
export const PNL_RECONCILE_DEFAULT_BASELINE_DATE = '2026-07-12';

/**
 * Resolve the active reconciliation baseline from the environment, falling back
 * to {@link PNL_RECONCILE_DEFAULT_BASELINE_DATE}. Returns null (evaluate every
 * day) when the override is explicitly cleared to `none`/`off`/`all`/empty or an
 * unparseable value. Pure of side effects — callers pass `process.env`.
 */
export function resolvePnlBaselineDate(
  env: Record<string, string | undefined> = {},
): string | null {
  const raw = env.PNL_RECONCILE_BASELINE_DATE;
  if (raw == null) return PNL_RECONCILE_DEFAULT_BASELINE_DATE;
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'none' || v === 'off' || v === 'all' || v === '0') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? raw.trim() : PNL_RECONCILE_DEFAULT_BASELINE_DATE;
}

/**
 * TRA-2302 — one ET day's option-close census read off the DURABLE option-trade
 * journal (`option-trade-journal.jsonl`), for the book being reconciled.
 *
 * This is the count that SEPARATES. `optionsDaily` is computed from the engine's
 * VOLATILE in-memory `closedOptions` bucket at 21:00 ET; that bucket is emptied
 * by the nightly archive and does not survive every restart, so a day whose
 * closes were lost books `optionsDaily: 0.00` — the exact same number a day with
 * no option activity books. The journal is append-only and per-trade, so it can
 * tell those two states apart.
 */
export interface JournalDayCloses {
  /** Option round trips the journal recorded FULLY closing on this ET day. */
  closes: number;
  /**
   * TRA-2895 — partial exits the journal recorded realizing on this ET day
   * (TP1 trims, manual partial `sell_to_close`, partial-fill slices). A day can
   * have `closes: 0, partialCloses: 2` — real realized dollars, no round trip
   * finished. Counted separately from `closes` because a slice is NOT a round
   * trip: folding it into `closes` would inflate every per-trade denominator
   * built off this census. Use {@link journalRealizingEvents} to ask the only
   * question the day cell cares about — did the journal see realized options
   * activity today.
   */
  partialCloses: number;
  /**
   * Σ realized P&L ATTRIBUTED to this ET day, USD — partial slices on the day
   * they realized, plus each full close's RESIDUAL (cumulative minus its own
   * slices) on the close day. Not "Σ over the closes": a trade that trimmed on
   * Monday and closed on Friday contributes to both days and to neither twice.
   */
  realizedPnlUsd: number;
}


/**
 * TRA-3517 — the report-file `pnlSource` value that means **the TRA-359 broker
 * override actually computed and was written into the cell**.
 *
 * `applyTradierBalanceOverride` in `index.ts` stamps this and only this. Every
 * other value (`'engine'`, `'realized-backfill'`, `'live-intraday'`) and an
 * ABSENT `pnlSource` all mean the report's `combinedPnl` is NOT the override, so
 * comparing a row against it grades nothing. Absent is the common case — 46 of
 * 69 stored live rows carry no `pnlSource` at all (TRA-3102) — and it must read
 * as NOT-OVERRIDDEN, never as a pass.
 */
export const EOD_PNL_SOURCE_BROKER_OVERRIDE = 'tradier-balance';

/**
 * TRA-3517 — tri-state verdict on the row/report `combinedPnl` agreement that
 * TRA-3349 item 2b shipped and no surface could read.
 *
 * `'not-measured'` is a FIRST-CLASS state and must never be folded into
 * `'agree'`. On a broker-shaped row `drift` is deliberately `null`, so a vacuous
 * true here would be the same reading as a real pass on the one cohort that has
 * no other reader at all.
 */
export type CombinedAgreementState = 'agree' | 'disagree' | 'not-measured';

/**
 * TRA-3517 — WHY a row's {@link CombinedAgreementState} is `'not-measured'`.
 * Four very different rows land in that state and a bare `null` cannot tell
 * them apart:
 *
 *  - `'row-not-broker-shaped'` — the row is an ordinary engine row, so
 *    {@link PnlReconcileDay.drift} grades it and this axis ABSTAINS. This is the
 *    only not-measured reason that is not a coverage hole.
 *  - `'row-combined-absent'` — the snapshot carries no numeric `combinedPnl`.
 *  - `'no-report-row'` — no EOD report file exists for the date.
 *  - `'override-not-computed'` — a report file exists but its `pnlSource` is not
 *    {@link EOD_PNL_SOURCE_BROKER_OVERRIDE}, i.e. the cell carries the ENGINE
 *    figure. Comparing a broker-shaped row against an engine cell measures the
 *    TRA-3288 two-surface gap, not the TRA-3349 agreement.
 */
export type CombinedAgreementNotMeasuredReason =
  | 'row-not-broker-shaped'
  | 'row-combined-absent'
  | 'no-report-row'
  | 'override-not-computed';

export interface PnlReconcileDay {
  date: string;
  /** EOD report `combinedPnl` for the day (null when no report file exists). */
  eodCombined: number | null;
  /** PnL-tracker stock-only realized daily P&L. */
  stockDaily: number;
  /**
   * TRA-3043 — the row's RECORDED opening-equity anchor, published rather than
   * inferred.
   *
   * `stockDaily` is written as `(closingEquity − openingEquity) −
   * optionsCreditedInWindow`, so until this ticket every consumer that wanted
   * the anchor had to invert that identity off three other published fields
   * (`closingEquity − stockDaily − optionsCreditedInWindow`). That derivation is
   * exact but it is an INFERENCE ABOUT the writer, and it silently disappears
   * wherever any operand is a TRA-2829 null. This is the writer's own number.
   *
   * With it, the telescoping invariant `openingEquity(N) === closingEquity(N−1)`
   * — which the TRA-3039 day-roll defect breaks, and which is the ONLY direct
   * read of whether a session's anchor advanced across the prior close — becomes
   * a comparison of two published fields.
   *
   * `null` is NOT MEASURED, not zero: see {@link DailySnapshot.closingEquity}
   * for why a back-filled row may be unable to name an equity anchor at all. A
   * zero here would read as a book that opened the day flat broke.
   */
  openingEquity: number | null;
  /**
   * TRA-3043 — WHICH authority set {@link openingEquity}, as declared by the
   * writer on the row itself. See {@link DailySnapshot.openingEquityBasis} for
   * the value set and, in particular, for why
   * `verified-prior-session-close` is the POST-FIX discriminator: no build
   * before TRA-3043 can emit it, and it is written only after a boot has CHECKED
   * `openingEquity` against the newest recorded close. Its presence is evidence
   * the telescoping invariant held; its absence is evidence nobody could vouch
   * for the anchor — never a pass.
   *
   * `null` is NOT MEASURED. Two very different rows land here — one written by a
   * pre-TRA-3043 build, and a back-fill row whose historical anchor the live
   * process declined to speak for — so it must never be folded into a verdict as
   * though it were a reading.
   */
  openingEquityBasis: string | null;
  /** Day-only realized options P&L (0 on legacy snapshots without the field). */
  optionsDaily: number;
  /**
   * TRA-2302 — whether `optionsDailyPnl` was actually WRITTEN on this snapshot,
   * as opposed to defaulted to 0 by the `?? 0` above. A legacy row (field never
   * written) and a row genuinely booked at 0.00 are the same `optionsDaily`
   * value and were previously indistinguishable from this endpoint.
   */
  optionsFieldPresent: boolean;
  /**
   * TRA-2302 — option closes the durable journal recorded for this ET day on
   * this book. `null` when no journal census was supplied (the caller did not
   * load it), which is NOT the same as zero.
   */
  journalCloses: number | null;
  /**
   * TRA-2895 — partial exits (TP1 trims / manual partial `sell_to_close` /
   * partial fills) the journal dated on this ET day. `null` on the same
   * NOT-MEASURED input as {@link journalCloses}. A row with
   * `journalCloses: 0, journalPartialCloses: 2` is a day that realized options
   * dollars without finishing a round trip — before this ticket that day was
   * indistinguishable from one the journal had no record of.
   */
  journalPartialCloses: number | null;
  /** TRA-2302 — Σ realized options P&L the journal recorded for this ET day. */
  journalOptionsPnl: number | null;
  /**
   * TRA-3864 — `optionsDaily − journalOptionsPnl` on rows the JOURNAL is the
   * authority for, i.e. the one comparison on this row whose two operands are
   * genuinely independent: `optionsDaily` is the figure PERSISTED at the 21:00
   * ET archive, `journalOptionsPnl` is recomputed per request straight from the
   * append-only journal.
   *
   * Both numbers were already published side by side and NOTHING SUBTRACTED
   * THEM. That is how the TRA-2819 / TRA-3730 close-basis restatement came to
   * correct the journal and leave two live money-book day cells booking the
   * pre-restatement figure, unread, for a day: `admin` / `live` 2026-08-18 at
   * −393.00 vs −271.23 (delta −121.77, the `SPY260821C00777000` restatement
   * −278.00 → −156.23 exactly) and 2026-08-11 at −16.00 vs −16.86 (delta +0.86,
   * a commission from the TRA-3730 cohort). Found by QA on live bqb1 build
   * `bc92e57109c1`, 2026-08-19; 850 of the 853 journal-authoritative cells on
   * the box held the identity, so the reader was controlled and the three (the
   * two above plus `qa_mirror_1578_38096` / demo 2026-07-28) are real.
   *
   * `null` = NOT MEASURED, on exactly two inputs: the row is not
   * journal-authoritative (`optionsDailyPnlSource` outside `journal` /
   * `journal-repair` — the file, not the journal, is the better record there),
   * or no census was supplied. NEVER `0` on an unmeasured row: `0` is
   * byte-identical to perfect agreement, the collapse TRA-2637 fixed on `drift`
   * and TRA-3517 fixed on `combinedAgreementDeltaUsd`.
   *
   * ⚠️ This is NOT `optionsLegDrift`, which reads 0 on all three divergent rows
   * and is CORRECT to. TRA-2630 / TRA-2641 ruled that leg self-confirming:
   * `syncEodReportOptionsLegs` writes the day cell INTO the report file's
   * options leg on every journal-authoritative row, so `eodOptionsPnl −
   * optionsDaily` compares a source against a copy of itself and has no failing
   * state here by construction. This axis is the independent one.
   */
  journalOptionsPnlDeltaUsd: number | null;
  /**
   * TRA-3864 — TRUE when this day cell publishes a figure the journal has since
   * MOVED AWAY FROM: journal-authoritative provenance, and
   * {@link journalOptionsPnlDeltaUsd} outside tolerance.
   *
   * ── Why the cell is not silently re-derived ──────────────────────────────
   *
   * QA offered two discharges — propagate the restatement into the cell, or
   * freeze the archive-time value and say so — and left the choice here. FROZEN,
   * and this field is the "say so".
   *
   * The propagate branch is already ruled against, in code: the historical
   * repair (`planOptionsDailyPnlRepair`) moves a day cell ONLY from an exact
   * `0.00`, and names any non-zero disagreement in `leftAloneDates` instead,
   * "because that number may be right and silently rewriting it is precisely the
   * unannounced correction the ticket forbids (TRA-2079)". A day cell is the
   * durable record of what the book published that evening. Restating it in
   * place would destroy the only copy of the figure every downstream consumer —
   * the EOD report file the sync slaves to it, the credit axis, any grade cited
   * off a past read — was computed from, to gain nothing this field does not
   * already give.
   *
   * ── Why the provenance label still reads `journal` ────────────────────────
   *
   * QA also asked that a frozen cell stop labelling itself
   * `optionsDailyPnlSource: 'journal'`. It does not, and the reason is a
   * behaviour dependency rather than a preference:
   * {@link isJournalAuthoritativeSource} is ONE definition with TWO consumers —
   * it gates `syncEodReportOptionsLegs` (which writer owns the report file's
   * options leg) and it scopes the `optionsLegOk` denominator. Moving a live
   * money-book row out of that predicate to relabel it would hand the report
   * file's options leg back to a different writer mid-series and silently change
   * what `optionsLegOk` is measured over — a live behaviour change smuggled in
   * as a rename.
   *
   * `optionsDailyPnlSource` names WHICH WRITER BOOKED THE NUMBER. It never
   * claimed the number was still current, and the false reading QA hit came from
   * there being no field that answered currency at all. That is now this field,
   * on the same object, always present, and `false` on a measured row is a real
   * pass rather than an absence.
   */
  optionsDailySupersededByJournal: boolean;
  /**
   * TRA-2302 — TRUE when this day's `optionsDailyPnl` is 0.00 while the journal
   * recorded at least one option close on it. That combination cannot be a real
   * zero: the round trips exist, the day-only ledger just did not receive them.
   * Never true when no census was supplied (absence of evidence is not
   * evidence — the flag stays false and `journalCloses` stays null).
   */
  optionsFalseZero: boolean;
  /**
   * TRA-2314 — the OPTIONS leg of the settled EOD report file for this day, as
   * distinct from its `combinedPnl`. TRA-2302 could not close its second
   * pathway (2026-07-15 and 2026-07-21, where `eodCombined` equalled the journal
   * total exactly while the snapshot carried 0.00) because this endpoint only
   * read `combinedPnl` — so "the file booked the options figure and the snapshot
   * did not" was indistinguishable from "the file booked that much STOCK".
   * Null when no report file exists or it carries no `optionsPnl`.
   */
  eodOptionsPnl: number | null;
  /**
   * TRA-2314 — which source booked `optionsDaily` (`journal`, `journal-repair`,
   * `bucket-no-census`, `bucket-journal-silent`). Null on rows written before
   * the field existed, which were all volatile-bucket sourced.
   */
  optionsDailyPnlSource: string | null;
  /**
   * TRA-2314 — the volatile-bucket figure that WOULD have been booked. On a
   * repaired row this is the original `0.00`, so a repaired cell stays
   * distinguishable from one that was never broken — without it both read
   * identically once the number is right (the TRA-2301 lesson).
   */
  optionsDailyPnlBucket: number | null;
  /**
   * TRA-2630 — the STOCK leg of the settled EOD report file for this day (its
   * `realizedPnl`), as distinct from `combinedPnl`. This is the operand whose
   * absence made `drift` unattributable: with only `combinedPnl` on the row,
   * "the report lost a stock close" and "the snapshot booked the wrong options
   * figure" produce the same `drift` and cannot be told apart. Null when no
   * report file exists or it carries no `realizedPnl`.
   */
  eodStockPnl: number | null;
  /**
   * TRA-2630 — `eodStockPnl − stockDaily`, the STOCK-leg disagreement on its
   * own axis. 0 when `eodStockPnl` is null (nothing to compare — absence is not
   * a mismatch, the same rule `drift` follows for `eodCombined`).
   *
   * Non-zero means the EOD report and the equity book disagree about how much
   * STOCK P&L this day realized. `stockDaily` is the durable side; a non-zero
   * value is normally the report's `allClosedPositions` list having been cleared
   * by the 21:00 ET archive before the report was written.
   *
   * ⛔ TRA-3948 — **THIS FIELD IS STRUCTURALLY `0` ON A BROKER-SHAPED LIVE ROW
   * AND CANNOT SEE THE EQUITY RESIDUAL ITS NAME PROMISES.** Not a bug in the
   * formula — a scope mismatch that read as a green for four live sessions:
   *
   *     stockLegDrift  operands: { eodStockPnl, stockDaily }
   *     stockLegProbeUsd operands: { closingEquity, openingEquity,
   *                                  optionsDailyPnl, netCashFlowUsd }
   *
   * The two sets are DISJOINT. `shapeLiveRecordedRow` books `dailyPnl: 0` on
   * every broker-shaped row by design (broker delta-equity already contains the
   * stock P&L), and `eodStockPnl` is zeroed by the TRA-219 21:00 archive, so
   * this reads `0 − 0` identically for every possible value of the probe.
   * Measured live 2026-08-22T04:42Z on build `0fd3b68`: `admin` carried
   * `stockLegBasis: 'zero-probe-disagrees'` with a −$197.36 probe on 2026-08-17
   * while `stockLegDrift` — and {@link PnlReconcileSummary.maxStockLegDriftUsd}
   * with it — read `0`.
   *
   * A monitor bound to this field on a LIVE book is green by construction, not
   * by measurement. Read {@link stockLegProbeUsd} and the
   * `liveStockLegProbe*` fold instead; this field keeps its exact TRA-2630
   * meaning (report-realized vs book-realized) and is left untouched on purpose.
   */
  stockLegDrift: number;
  /**
   * TRA-2630 — `eodOptionsPnl − optionsDaily`, the OPTIONS-leg disagreement on
   * its own axis. 0 when `eodOptionsPnl` is null. This is the leg that actually
   * reconciles today (159/166 exact on the 2026-07-30 live pull), which is
   * precisely why pooling it into `drift` with the broken stock leg destroyed a
   * working signal.
   */
  optionsLegDrift: number;
  /**
   * TRA-2630 AC3 / TRA-2629 — REAL-MONEY TRIPWIRE. True when `stockDaily`
   * equals the PRIOR session's `optionsDaily` to the cent (and is itself
   * non-zero), i.e. the equity book re-booked the previous session's realized
   * option credit into this session's STOCK leg.
   *
   * That is the exact production signature of TRA-2629 (`optionsCredited` not
   * surviving a restart, so the writer lost the left endpoint of its
   * subtraction). Measured 2026-07-30T04:19:30Z: **18 post-baseline rows, 0
   * pre-baseline** — a clean discriminator, all 18 on 07-28/07-29 and all
   * `mode: demo`. It must read false on every book once that fix is live, and
   * on a `mode: live` book it is a NAV overstatement of a full session of
   * options P&L — see `livePriorOptionsLagDates` on the endpoint, which fails
   * separately and loudly.
   *
   * Deliberately NOT baseline-gated: the lag is a writer defect, not the
   * pre-fix arithmetic the baseline exists to excuse. It reads false on all 109
   * pre-baseline rows anyway, so un-gating costs no noise.
   */
  lagsPriorOptionsDaily: boolean;
  /**
   * TRA-2630 AC2/AC3 — **could {@link lagsPriorOptionsDaily} have fired on this
   * session at all?** True iff the PRIOR session carried a non-zero
   * `optionsDaily`.
   *
   * WHY THIS FIELD EXISTS. The lag hypothesis is "the writer posts the prior
   * session's realized option P&L into this session's equity line", so it
   * PREDICTS `stockDaily == prev.optionsDaily`. When `prev.optionsDaily` is
   * non-zero that prediction is sharp, and any other value — INCLUDING `0.00` —
   * refutes it, so the session is genuine evidence. When `prev.optionsDaily` is
   * `0.00` the hypothesis predicts `stockDaily == 0.00`, which is
   * INDISTINGUISHABLE from an ordinary quiet day. Such a session has no failing
   * state, so scoring it as a pass manufactures confidence.
   *
   * Measured on bqb1 2026-07-30T08:02Z: of the 13 books currently carrying a lag
   * date, **SEVEN have `optionsDaily 0.00` on their latest session** — they
   * cannot verify the fix on the next session no matter what it writes. The
   * OFFENDER cohort is not the GRADEABLE cohort, and deriving the verification
   * set from "who was broken" instead of from the tripwire's own trigger
   * condition is what makes an AC2-style before/after read unfalsifiable.
   */
  priorOptionsLagEligible: boolean;
  /**
   * TRA-2835 — is `days[i-1]` the session that ACTUALLY precedes this one on the
   * exchange calendar, or merely the previous row we happen to hold?
   *
   * `null` = NOT MEASURED (no calendar supplied), never an implied `true`.
   *
   * WHY THIS FIELD EXISTS. The T+1 credit-lag hypothesis is a statement about
   * ADJACENT sessions: "the writer posts the PRIOR session's realized option P&L
   * into THIS session's equity line". The detector, however, pairs `days[i]`
   * with `days[i-1]` — array-adjacent, not calendar-adjacent — and a gap in
   * `days[]` does not suppress it. Proven on live `admin` before this fix:
   * 2026-07-20 (Mon) was graded against 2026-07-17 (Fri), three calendar days
   * back, and read `priorOptionsLagEligible: true`.
   *
   * That was harmless while the only gaps were weekends. It stopped being
   * harmless when the TRA-2888 gap (2026-07-30/07-31/08-03, permanent and
   * fleet-wide) put a THREE-SETTLED-SESSION hole in every book: the 2026-08-04
   * row's predecessor in `days[]` is 2026-07-29, and the pair was graded as if
   * it were T+1. A "lag" measured across a hole is not the lag the tripwire
   * names, and — the part that matters — a PASS across that hole is not
   * evidence the writer was fixed. It is the tripwire's own trigger condition
   * never having been met, scored as a pass. Same failure class as TRA-2301 /
   * TRA-2642: a flag with no reachable failing state.
   *
   * When this reads `false` the session is excluded from eligibility outright,
   * because there is no repair to the arithmetic that makes a non-adjacent pair
   * informative about a T+1 property.
   */
  priorSessionAdjacent: boolean | null;
  /**
   * TRA-2635 (CEO) — the DURABLE equity STATE at this session's close, i.e.
   * `PaperAccount.totalEquity` as the 21:00 ET writer saw it.
   *
   * Every other figure on this row is a DELTA, and CEO's TRA-2635 is the lesson
   * about what a delta cannot answer: on a book where realized option P&L has
   * been earned but never credited to equity, `stockDaily` / `optionsDaily` read
   * IDENTICALLY to a book where the credit landed correctly and the stock leg
   * simply excludes it. "Clean" and "the credit path never fired here" are the
   * same reading. State is what separates them — equity either absorbed the
   * money or it did not — which is why this is published on the row.
   *
   * Not baseline-gated and not folded into any verdict: it is a measurement,
   * and rounding is the only transformation applied.
   *
   * TRA-2829 — `null` also when the row itself is a BACK-FILL whose broker
   * equity anchor could not be measured. Every arithmetic consumer below already
   * guards with `Number.isFinite`, which rejects `null`, so such a row drops out
   * of the equity population instead of poisoning it — see
   * {@link DailySnapshot.closingEquity} for why an interpolation was refused.
   */
  closingEquity: number | null;
  /**
   * TRA-3288 — WHICH surface set {@link closingEquity}, straight off the row
   * (see {@link DailySnapshot.closingEquityBasis}). `'broker-eod-balance'` is
   * the broker NAV; `'engine-paper-account'` is the demo paper book, which on a
   * `mode: live` book is a preserved constant. `null` = the row predates the
   * stamp — and a null here must be read as NOT broker-sourced, never as a
   * pass: every historical row has it absent, including the demo-book live
   * rows this field exists to disqualify.
   */
  closingEquityBasis: string | null;
  /**
   * TRA-3589 — the same provenance as {@link closingEquityBasis}, rendered so it
   * can never be absent: the basis string verbatim, or
   * {@link EQUITY_SOURCE_ERA_UNSTAMPED} on a row written before the stamp
   * existed. See {@link equitySourceEraOf}.
   *
   * WHY A SECOND FIELD FOR THE SAME FACT. `closingEquityBasis: null` is read by
   * a human as "provenance unknown", and on a `mode: live` book that is exactly
   * wrong — the provenance IS known (TRA-3288 ruled it the demo PaperAccount,
   * written unconditionally at `index.ts:2058`), it is simply not written down.
   * A silence and a disclosure must not render identically. This field always
   * renders, so the absence of the KEY means "old build", never "old row".
   */
  equitySourceEra: string;
  /**
   * TRA-3288 item 2 — signed broker cash flow over the span this row's equity
   * delta covers (see {@link DailySnapshot.netCashFlowUsd}). `null` is NOT
   * MEASURED — never 0 — and the post-onset credit window fails closed on it:
   * a deposit inside the window would otherwise read as uncredited P&L.
   */
  netCashFlowUsd: number | null;
  /**
   * TRA-3517 — how the STOCK leg (`dailyPnl`) was established on this row, off
   * the row itself (see {@link DailySnapshot.stockLegBasis}). `null` = the field
   * was never written, which is every ordinary recorded row: the stock leg there
   * is a measured equity delta, not a booked `0` standing in for one.
   *
   * WHY IT IS PUBLISHED. On a TRA-3349 broker-shaped row `dailyPnl` is booked
   * `0` — not because the book was flat, but because broker delta-equity already
   * contains the stock P&L and booking a demo stock figure beside it would be
   * the two-surface error relocated. That `0` is only falsifiable if the basis
   * and its probe are readable, and until this ticket neither string occurred
   * anywhere in this endpoint's payload. `'zero-probe-disagrees'` is the state
   * the CFO ruling names as the trigger for building stock reconstruction, and
   * nothing could see it.
   */
  stockLegBasis: string | null;
  /**
   * TRA-3517 — the residual the booked-`0` stock leg would have to explain
   * (see {@link DailySnapshot.stockLegProbeUsd}), projected onto this endpoint.
   *
   * `null` is NOT MEASURED — an operand (either equity anchor, or the broker
   * cash flow) was absent — never `0`. A recomputation of this value from the
   * published operands is NOT a substitute: the formula cannot fail when the
   * field is absent, so it reads identically whether the writer stamped the
   * probe or never ran. This is the writer's own number.
   */
  stockLegProbeUsd: number | null;
  /**
   * TRA-3954 — the EOD unrealized P&L on open option positions at this
   * session's close, projected from {@link DailySnapshot.openOptionMarkUsd}.
   * `null` = not captured. Writer's own number.
   */
  openOptionMarkUsd: number | null;
  /**
   * TRA-3954 — the session-over-session change in that mark, the FOURTH operand
   * the writer subtracted from `stockLegProbeUsd`. `null` = the probe on this
   * row is the three-operand form and still CONTAINS unrealized mark motion
   * (every row written before this ticket, and any session whose mark capture
   * failed). Writer's own number.
   */
  openOptionMarkDeltaUsd: number | null;
  /**
   * TRA-3954 — which form the writer stamped (`'mark-differenced'` /
   * `'mark-not-measured'`), or `null` on a row that predates the field.
   * DIAGNOSIS: the verdict keys on the number.
   */
  stockLegProbeMarkBasis: string | null;
  /**
   * TRA-3517 — the ROW's own `combinedPnl` (see {@link DailySnapshot.combinedPnl}),
   * as distinct from {@link eodCombined}, which is the REPORT FILE's.
   *
   * These are two different stores written by two different code paths, and
   * TRA-3349 item 2b claims they carry the same figure on a live broker-shaped
   * row. Nothing published either one beside the other, so the claim had no
   * reader. `null` when the snapshot carries no numeric `combinedPnl`.
   */
  rowCombinedPnl: number | null;
  /**
   * TRA-2635 — `PaperAccount.getOptionsCredited()` as of this row: cumulative
   * realized option P&L this book's EQUITY has absorbed (see
   * {@link DailySnapshot.optionsCreditedCumulative}).
   *
   * **`null` when the field was never written — NEVER 0.** That distinction is
   * the entire point of the field here. A pre-TRA-2323 row and a row on a book
   * whose credit path has genuinely never fired both carry "no credit", and
   * defaulting the absent case to 0 would make the two indistinguishable — the
   * same `?? 0` collapse TRA-2629 shipped one layer down in the durable
   * snapshot type.
   */
  optionsCreditedCumulative: number | null;
  /**
   * TRA-2635 — credit that landed in THIS session's window: this row's
   * cumulative minus the PRIOR row's. `null` unless BOTH endpoints are present,
   * because a subtraction with an absent endpoint is not a zero.
   *
   * A NEGATIVE value is not a debit — the cumulative is an in-memory counter, so
   * a negative window is the counter having been reset by a boot (the TRA-2629
   * durability defect) between the two writes. Both cases are informative and
   * neither is silently clamped.
   */
  optionsCreditedInWindow: number | null;
  /**
   * TRA-2658 — **equity that moved between the previous booked close and this
   * session's opening, explained by NOTHING in the ledger.**
   *
   *     unbookedEquityMoveUsd
   *       = (closingEquity − prevClosingEquity) − stockDaily − optionsCreditedInWindow
   *
   * Algebraically this is `openingEquity − prevClosingEquity`, because the writer
   * builds `stockDaily` as `(equity − openingEquity) − optionsCreditedInWindow`
   * (see `generateAndSaveReport` in `index.ts`). On a continuously-run book
   * `saveSnapshot` sets `openingEquity` to the row it just closed, so the two
   * telescope and this is exactly 0. It is non-zero only when
   * `advanceDayIfNeeded()` / `syncOpeningEquity()` rolled `openingEquity` forward
   * across a boot WITHOUT booking a snapshot — the TRA-1557 un-booked equity
   * re-anchor — so real equity movement entered no daily row at all.
   *
   * ## Why this axis exists: it is the ONLY signal that can see a FROZEN counter
   *
   * {@link PnlReconcileResult.counterDurable} grades non-durability off two
   * signatures, and BOTH are motion detectors: `lagsPriorOptionsDaily` (the T+1
   * mis-bucket) and a NEGATIVE window. A counter that is stuck at exactly 0
   * across every session produces neither — it never decreases and it never
   * pushes a credit into the stock leg, because the credit was absorbed by
   * `openingEquity` before the close ran. So the reset-only predicate reports
   * `counterDurable: true` on a book whose counter demonstrably lost every cent
   * it was supposed to record. That is not hypothetical: live on bqb1
   * 2026-07-30T14:08Z, `admin` served `counterDurable: true` with
   * `optionsCreditedCumulative: 0` on 07-27, 07-28 AND 07-29 while this figure
   * read **+140.00** on 07-28 (= 07-27's `optionsDaily` to the cent) and
   * **+114.00** on 07-29 — $254.00 of credit that reached equity and that the
   * counter recorded as nothing. "Clean" and "never fired" were the same reading,
   * one layer in from TRA-2635.
   *
   * Its three operands (`closingEquity` on two rows, `stockDaily` on this one)
   * are all durable snapshot fields and NO writer joins them — `stockDaily` is
   * subtracted against `openingEquity`, never against the previous row — so this
   * cannot become self-confirming the way TRA-2641's `optionsLegDrift` did.
   *
   * `null` when there is no previous row with a finite `closingEquity`; a
   * subtraction with an absent endpoint is not a zero (TRA-2637).
   */
  unbookedEquityMoveUsd: number | null;
  /**
   * TRA-2658 — this session carries a material {@link unbookedEquityMoveUsd}
   * that is ATTRIBUTABLE to a lost option credit: the window spans a session
   * which realized option P&L, and the recorded `optionsCreditedInWindow` is
   * nonetheless zero (or absent).
   *
   * The attribution term is load-bearing. `PaperAccount.applyEquity()` rebases
   * equity on a starting-balance edit, which is also an un-booked move and is
   * NOT a counter defect. Flagging every un-booked move as a frozen counter
   * would manufacture a red on any book whose operator edited demo equity —
   * the TRA-2193 pooling trap. Un-attributable moves stay visible on
   * {@link PnlReconcileResult.unbookedEquityMoveDates} without an accusation.
   *
   * TRA-2926 — **`null` = NOT MEASURED**, and a session whose
   * {@link priorSessionAdjacent} is `false` is exactly that. The subtraction
   * pairs this row's `closingEquity` with the previous ROW's, so across the
   * permanent TRA-2888 gap it measures a multi-session equity span as if it
   * were one window — real, correctly-booked movement from the uncaptured
   * sessions lands as "unbooked" and the accusation is manufactured. On
   * 2026-08-04, the first post-gap session, 36 of 36 non-zero
   * `unbookedEquityMoveUsd` rows and 12 of 12 `counterFrozen` rows sat on a
   * non-adjacent prior (07-29, three settled sessions back). This is the mirror
   * image of the TRA-2835 finding on the lag axis: one missing gate, two
   * opposite wrong answers — the lag axis went vacuously GREEN, this one
   * spuriously RED. `null` also on any row the pass never graded (row 0, or an
   * absent `closingEquity` endpoint); it was `false` there before, which read
   * "measured clean" on rows nothing had measured. The raw
   * {@link unbookedEquityMoveUsd} arithmetic is still published on suppressed
   * rows — it is fenced out of the verdict, not deleted.
   */
  counterFrozen: boolean | null;
  /**
   * eodCombined − (stockDaily + optionsDaily).
   *
   * TRA-2637 (QuantTrader) — **`null` when `eodCombined` is null, NEVER 0.** This
   * used to score `0` on a row whose EOD report file does not exist, with the
   * rationale "absence is not a mismatch". True, but a `0` here is the SAME value
   * a perfectly reconciled session writes, so every gate that counts matches read
   * a MISSING session as a pass. Live proof, `admin` (the only `mode: live` book)
   * on 2026-07-29 at 02:17:30Z: `eodCombined: null`, `eodOptionsPnl: null`,
   * `journalOptionsPnl: 250.01` over 6 real closes — and `drift: 0`.
   * `optionsFalseZero` was `false` too, so the false-zero tripwire could not see
   * it either: the value was not a wrong zero, it was absent.
   *
   * Absence now has its own state on three axes — this `null`, the per-row
   * {@link PnlReconcileDay.eodRowMissing} flag, and the cohort verdict
   * {@link PnlReconcileResult.eodRowsPresentOk}. `offendingDates` / `maxDriftUsd`
   * skip null rows exactly as they always effectively did, so no existing number
   * moves; what changes is that a consumer can no longer mistake "nothing to
   * reconcile" for "reconciled".
   */
  drift: number | null;
  /**
   * TRA-2637 — TRUE when this session has NO EOD report file (`eodCombined` is
   * null), i.e. there is nothing to reconcile against. Published as its own
   * boolean so a gate does not have to reason about a nullable number to see the
   * state. See {@link PnlReconcileResult.eodRowMissingDates} for the graded
   * subset (sessions that actually had activity).
   */
  eodRowMissing: boolean;
  /**
   * TRA-3849 — TRUE when this row's DATE was never an NYSE session.
   *
   * The opposite direction from {@link PnlReconcileDay.eodRowMissing} and from
   * every other EOD presence axis on this endpoint, all of which grade a
   * SESSION for a missing row. `days[]` is built from the persisted snapshots,
   * so a phantom date key enters it unchallenged and nothing downstream has ever
   * questioned it — including the pairing passes that walk `days[i-1]`.
   *
   * `null` = NOT MEASURED (no `tailCalendar` supplied), never a pass.
   *
   * Live on `b70404f`: 83 such rows over 918, across 63 books and 11 date keys,
   * 82 of them Sundays. See `eod-nonsession-row.ts` for the fold, the standing
   * board question, and why a red here is the expected steady state.
   */
  nonSessionRow: boolean | null;
  /**
   * TRA-3849 — TRUE when {@link PnlReconcileDay.nonSessionRow} is true AND the
   * row carries a materially non-zero `eodCombined`, `stockDaily` or
   * `optionsDaily`. `null` when the axis is not measured.
   *
   * Split out because the retraction question is not the same question for an
   * inert row and for one whose figure every weekly/monthly/yearly window has
   * already summed. See `NON_SESSION_MONEY_PREDICATE`.
   */
  nonSessionRowMoneyBearing: boolean | null;
  /**
   * TRA-3517 — **the reader that replaces `drift` on a broker-shaped row.**
   *
   * `drift` grades `eodCombined == stockDaily + optionsDaily`, an ENGINE-book
   * decomposition a broker row does not satisfy, so TRA-3349 correctly
   * suppressed it to `null` there. That suppression removed the only automated
   * cross-check watching `combinedPnl`, and the row/report agreement that was
   * supposed to replace it was published on neither side. Net effect on live
   * books: `combinedPnl` had no reader at all, and a future divergence between
   * the TRA-359 override and the stored row would have been silent.
   *
   * Graded ONLY where the claim is actually made: the row is broker-shaped (so
   * `drift` abstains) AND the report cell carries the override
   * ({@link EOD_PNL_SOURCE_BROKER_OVERRIDE}). Anywhere else this is
   * `'not-measured'` with {@link combinedAgreementReason} naming which leg is
   * missing.
   *
   * ## What a green here is, and what it is NOT
   *
   * Today both sides are written from the same `override` object on the same
   * tick (`applyTradierBalanceOverride` and `shapeLiveRecordedRow` share it), so
   * agreement holds BY CONSTRUCTION and a green is NOT independent
   * corroboration of either figure. It is a regression tripwire: the two stores
   * are written by different code paths and are separately re-writable (a
   * back-fill, a clobber, a re-generated report, a future refactor that stops
   * threading the override into the row). This axis is what makes that
   * divergence loud instead of silent. Do not quote it as evidence the broker
   * figure is right — see `combinedAgreementSameTickCaveat` in the caveats.
   */
  combinedAgreement: CombinedAgreementState;
  /**
   * TRA-3517 — `rowCombinedPnl − eodCombined` when
   * {@link combinedAgreement} is `'agree'` or `'disagree'`; `null` on
   * `'not-measured'`. NEVER `0` on an ungraded row — that is the same value a
   * perfect agreement writes, which is the TRA-2637 collapse one axis over.
   */
  combinedAgreementDeltaUsd: number | null;
  /**
   * TRA-3517 — which leg was missing, on a `'not-measured'` row; `null` when the
   * axis graded. See {@link CombinedAgreementNotMeasuredReason}.
   */
  combinedAgreementReason: CombinedAgreementNotMeasuredReason | null;
  /**
   * TRA-3517 — **could this graded session have read `disagree` at all?**
   *
   * True iff the axis graded AND at least one side is materially non-zero. When
   * BOTH the row and the report carry `0.00`, `agree` is what the axis emits no
   * matter how broken the wiring is: a writer that never threaded the override
   * into the row books the `dailyPnl + optionsDailyPnl` identity, which on a
   * quiet session is also `0.00`. Such a session has no failing state, so
   * scoring it as evidence manufactures confidence — the TRA-2633 /
   * TRA-2630-AC2 rule, one axis over.
   *
   * This is not hypothetical and it is not a future risk. The first live read of
   * this axis (2026-08-13T08:39Z, build 3877000) graded exactly two sessions:
   * `admin` 2026-08-12 at −0.10 vs −0.10 (sharp — the override shape, and any
   * other value refutes it) and `v0nni` 2026-08-12 at 0.00 vs 0.00 (degenerate).
   * Counting both would have published a denominator of 2 for one real reading.
   *
   * `combinedAgreement` stays `'agree'` on a degenerate row — it IS an
   * agreement, and hiding it would lose a measurement. What it must not do is
   * fund a verdict, which is why {@link PnlReconcileResult.combinedAgreementOk}
   * keys on this flag and not on the graded count.
   */
  combinedAgreementDiscriminating: boolean;
  /**
   * TRA-3517 — **this session's `combinedPnl` is observed by NOTHING.**
   *
   * True iff `drift` is suppressed for broker shape AND the agreement axis is
   * also `'not-measured'`. Both readers abstain, so the field is carried on a
   * real-money row with no cross-check of any kind behind it.
   *
   * Published as its own flag rather than left for a reader to derive, because
   * the derivation is exactly the one nobody performed: the endpoint served
   * `drift: null` and no agreement field at all, and `null` reads as "fine" at a
   * glance. See {@link PnlReconcileResult.combinedPnlNoReaderDates}.
   */
  combinedPnlHasNoReader: boolean;
  /**
   * TRA-1636 — true when `date` predates the reconciliation baseline, i.e. the
   * snapshot was written by pre-fix (buggy) code. The row is still returned for
   * transparency but its drift never affects `ok` / `offendingDates` / maxDrift.
   */
  belowBaseline: boolean;
}

/**
 * TRA-2924 — how far an options-leg verdict may be quoted. A boolean cannot
 * carry its own coverage, so the coverage travels beside it as a label rather
 * than as a row count a reader has to interpret.
 *
 * See {@link PnlReconcileResult.optionsLegScope} for the branch definitions and
 * `docs/self-confirming-health-gates-TRA-2671.md` clause 5 for the standing rule.
 */
export type PnlOptionsLegScope = 'fleet' | 'partial' | 'not-measured';

export interface PnlReconcileResult {
  ok: boolean;
  days: PnlReconcileDay[];
  maxDriftUsd: number;
  /** Dates whose |drift| exceeds the tolerance (baseline-eligible days only). */
  offendingDates: string[];
  caveats: string[];
  /**
   * TRA-1636 — the baseline cutoff applied (inclusive ET day, `YYYY-MM-DD`), or
   * null when no baseline was set (every day is evaluated). Days before this are
   * reported but excluded from the pass/fail verdict.
   */
  baselineDate: string | null;
  /** Count of rows skipped because they predate `baselineDate`. */
  belowBaselineCount: number;
  /**
   * TRA-2302 — dates whose `optionsDailyPnl` is 0.00 while the durable journal
   * recorded option closes on them. Empty when no census was supplied.
   *
   * DELIBERATELY NOT folded into `ok`. `ok` keeps meaning exactly what it has
   * always meant (the `eodCombined == stockDaily + optionsDaily` identity), so
   * this addition cannot move a number already under a consumer — the same
   * additive discipline TRA-2193 applied to `byAccountClass`. Read
   * `optionsFalseZeroOk` for this check's verdict.
   */
  falseZeroDates: string[];
  /** TRA-2302 — false iff at least one `falseZeroDates` entry was found. */
  optionsFalseZeroOk: boolean;
  /**
   * TRA-3864 — dates whose persisted `optionsDaily` has been SUPERSEDED by a
   * later journal restatement, i.e. rows where
   * {@link PnlDayRow.optionsDailySupersededByJournal} is true.
   *
   * NOT baseline-gated, and NOT folded into `ok` — same additive discipline as
   * `falseZeroDates`. A superseded cell says nothing about the
   * `eodCombined == stockDaily + optionsDaily` identity `ok` grades.
   */
  journalSupersededDates: string[];
  /**
   * TRA-3864 — the DENOMINATOR, and the reason a zero here is worth anything.
   * How many of this book's day cells could have read superseded at all:
   * journal-authoritative provenance AND a census to compare against.
   *
   * Publish it beside the verdict. An empty `journalSupersededDates` on a book
   * with `journalAgreementGradeableCount: 0` is "nothing was looked at", which
   * is the manufactured green this module has already shipped twice
   * (`optionsLegOk` under TRA-2924, `livePriorOptionsLagOk` under TRA-2630 AC2).
   * QA's live measurement was 853 gradeable cells fleet-wide with 3 divergent —
   * grade against that denominator, not against the 3.
   */
  journalAgreementGradeableCount: number;
  /**
   * TRA-3864 — TRI-STATE, folded the same way every other verdict on this
   * result is: `false` (a superseded cell exists) wins outright, `null` means
   * NOT MEASURED (no gradeable cell on this book) and is NEVER a pass, `true`
   * means at least one cell could have diverged and none did.
   *
   * ⛔ TRA-3867 — this is the RAW IDENTITY and it is NOT gateable. The cells the
   * TRA-3864 (b) ruling froze can never be retired (TRA-2079 refuses to move a
   * non-zero cell), so on `admin`/live this reads `false` permanently while the
   * box is behaving correctly. The gateable fleet verdict is
   * `journalDayCellNoNewSupersessionOk`, which subtracts the ruled set — see
   * {@link ACKNOWLEDGED_JOURNAL_DAY_CELL_SUPERSESSIONS}.
   */
  journalAgreementOk: boolean | null;
  /**
   * TRA-3864 — the largest |`optionsDaily` − `journalOptionsPnl`| over the
   * gradeable cohort, USD. `null` when the cohort is empty — `0` there would be
   * indistinguishable from a perfectly-agreeing book.
   */
  maxJournalSupersessionUsd: number | null;
  /**
   * TRA-2637 — evaluated sessions that HAD activity (a journal close, or a
   * non-zero P&L leg) and yet have **no EOD report row at all**. This is the
   * absence `drift: 0` used to render as a clean reconciliation.
   *
   * Not folded into `ok` — same additive discipline as `falseZeroDates`. Read
   * `eodRowsPresentOk` for the verdict.
   */
  eodRowMissingDates: string[];
  /**
   * TRA-3849 — dates in `days[]` that the exchange calendar says were never
   * sessions. Empty when the axis is not measured — read
   * `nonSessionRowGradeableCount` to tell "none found" from "nothing looked at".
   *
   * NOT baseline-gated, unlike every other list on this result: a phantom row is
   * a phantom row whatever the baseline says about its numbers, and 9 of the 11
   * live date keys predate most books' baselines.
   */
  nonSessionRowDates: string[];
  /**
   * TRA-3849 — the money-bearing subset of {@link nonSessionRowDates}. See
   * `NON_SESSION_MONEY_PREDICATE` in `eod-nonsession-row.ts`.
   */
  nonSessionRowMoneyBearingDates: string[];
  /**
   * TRA-3849 — rows this book actually graded on the calendar axis:
   * `days.length` when a calendar was supplied, `0` when none was. THE
   * DENOMINATOR. `nonSessionRowDates: []` with a `0` here is not a clean book,
   * it is an unexamined one.
   */
  nonSessionRowGradeableCount: number;
  /**
   * TRA-3849 — TRI-STATE. `false` = this book holds a non-session row.
   * `true` = rows were graded and none is. `null` = NOT MEASURED (no calendar).
   *
   * ⛔ A `false` here is the EXPECTED STEADY STATE on this fleet, not an outage:
   * the 83 known rows are deliberately left in place pending a board ruling. The
   * actionable signal is the population MOVING; see `eod-nonsession-row.ts`.
   */
  nonSessionRowsOk: boolean | null;
  /**
   * TRA-2637 — TRI-STATE verdict on EOD-row presence over the sessions that had
   * something to reconcile:
   *
   *   - `false` — an active session has no EOD report row. Nothing downstream
   *     reconciles that session, and it previously read GREEN everywhere.
   *   - `true`  — every active evaluated session wrote its row.
   *   - `null`  — NOT MEASURED: no evaluated session had any activity, so the
   *     check never looked at anything. Never a pass; callers must fail closed.
   *
   * `eodRowGradeableCount` is the denominator that makes the empty cohort
   * distinguishable from a graded one.
   *
   * TRA-2817 — the verdict is now over the INTERIOR **and** the TAIL. It is
   * `false` whenever `eodTailStaleSessions > 0`, regardless of how clean the
   * interior is. See `eodTailStaleSessions` for why the interior check alone
   * has no failing state on a writer that stopped.
   */
  eodRowsPresentOk: boolean | null;
  /** TRA-2637 — size of the cohort `eodRowsPresentOk` was graded over. */
  eodRowGradeableCount: number;
  /**
   * TRA-3517 — TRI-STATE verdict on the row/report `combinedPnl` agreement over
   * this book's evaluated sessions.
   *
   *   - `false` — at least one graded session DISAGREES. The stored row and the
   *     TRA-359 override carry different broker day P&L for the same date.
   *   - `true`  — no disagreement, over a NON-EMPTY DISCRIMINATING cohort.
   *   - `null`  — NOT MEASURED: {@link combinedAgreementDiscriminatingCount} is
   *     0, so nothing that could have failed was looked at. **Never a pass.** On
   *     a book whose live rows are broker-shaped this is the reportable state,
   *     not a quiet green: it means `combinedPnl` is effectively unobserved (see
   *     {@link combinedPnlNoReaderDates}).
   *
   * KEYED ON THE DISCRIMINATING COUNT, NOT THE GRADED ONE. A session where both
   * sides read 0.00 emits `agree` however broken the wiring is, so a `true`
   * funded by it is the vacuous pass this ticket exists to prevent — see
   * {@link PnlReconcileDay.combinedAgreementDiscriminating} for the live
   * 2026-08-13 reading where exactly that would have happened on `v0nni`. The
   * narrowing cannot hide a red: a disagreement is discriminating by
   * construction, and it short-circuits this branch anyway.
   *
   * A demo book has no broker-shaped rows and legitimately reads `null` here
   * forever; that is why the fleet fold scopes to live books and publishes its
   * own denominator rather than `every`-ing over the whole fleet.
   */
  combinedAgreementOk: boolean | null;
  /**
   * TRA-3517 — evaluated sessions the agreement axis GRADED (emitted `agree` or
   * `disagree` on). This is MEASUREMENT coverage: how many rows the axis
   * reached. It is deliberately NOT the denominator behind
   * {@link combinedAgreementOk} — read {@link combinedAgreementDiscriminatingCount}
   * for that, and publish both, because the gap between them is exactly the
   * degenerate-session count.
   */
  combinedAgreementGradeableCount: number;
  /**
   * TRA-3517 — the graded sessions that could actually have read `disagree`
   * (at least one side materially non-zero). **This is the denominator behind
   * {@link combinedAgreementOk}.** First live read, 2026-08-13T08:39Z: graded 2,
   * discriminating 1 — `v0nni`'s 0.00-vs-0.00 session is a measurement, not
   * evidence.
   */
  combinedAgreementDiscriminatingCount: number;
  /** TRA-3517 — evaluated sessions whose row and report `combinedPnl` disagree. */
  combinedAgreementDisagreeDates: string[];
  /**
   * TRA-3517 — largest |row − report| over GRADED sessions, USD. `null` on an
   * empty cohort — `0` there is the `every`-on-the-empty-set pass wearing a
   * number.
   */
  combinedAgreementMaxDeltaUsd: number | null;
  /**
   * TRA-3517 — evaluated sessions by not-measured reason, so a zero denominator
   * is attributable instead of merely empty. Keys are
   * {@link CombinedAgreementNotMeasuredReason}; absent keys are 0.
   */
  combinedAgreementNotMeasuredCounts: Record<string, number>;
  /**
   * TRA-3517 — evaluated sessions where `drift` is suppressed for broker shape
   * AND the agreement axis is not-measured: real-money rows whose `combinedPnl`
   * NOTHING reads. Non-empty is a coverage hole, not a failure of the figure —
   * report it as `unknown`, never as clean.
   */
  combinedPnlNoReaderDates: string[];
  /**
   * TRA-2817 — THE TAIL AXIS. Completed NYSE sessions strictly after this book's
   * newest ledger row, through the last session whose 21:00 ET archive is past.
   * `0` = the ledger is current. `null` = NOT MEASURED (no rows at all, or no
   * calendar supplied) — never read as a pass.
   *
   * TRA-2637 fixed the INTERIOR case: an absent `eodCombined` inside the
   * measured range no longer scores `drift: 0`. It could not fix the TAIL case,
   * and the reason is structural rather than an oversight. The presence check
   * walks the dates that are already in `days[]`, and `days[]` is built from the
   * persisted snapshots. A session with no snapshot is not in `days[]`, so it is
   * never walked, so it can never be counted missing. **When the writer stops
   * entirely, the axis goes green** — and the greener it looks, the more
   * completely it has stopped.
   *
   * Live proof, and the reason this exists: on 2026-08-04 all 47 books with a
   * ledger carried `closingEquityLatestDate: "2026-07-29"` — three completed,
   * overdue sessions unwritten across the entire fleet — while
   * `liveEodRowsPresentOk` served `true` and `liveEodRowMissingBooks` served
   * `[]`. `/data` had been returning `ENOSPC` on every write since
   * 2026-07-30T23:40:19Z (the disk was out of INODES, not bytes — TRA-2817).
   * Every downstream figure computed over that window, including TRA-2658's
   * $733.60, was measured against a ledger that had stopped, and read as stable
   * precisely BECAUSE it had stopped.
   *
   * Graded against the exchange calendar, not elapsed days: a Monday row is
   * current on a Saturday, and a Tuesday-afternoon read is current with
   * Monday's row because today's 21:00 ET archive is not yet due.
   */
  eodTailStaleSessions: number | null;
  /**
   * TRA-2817 — the anchor `eodTailStaleSessions` was measured from: this book's
   * newest ledger row date, or `null` when it has none. Published so a stale
   * tail is legible without re-deriving `days[]` by hand — the omission that let
   * this run three sessions unseen.
   */
  eodTailLatestRowDate: string | null;
  /**
   * TRA-2817 — the last session whose 21:00 ET archive is past, i.e. the date
   * this book's tail is being held to. `null` when no calendar was supplied.
   */
  eodTailSettledSession: string | null;
  /**
   * TRA-2302 — how many snapshots never had `optionsDailyPnl` written at all.
   * A high count over days the book was trading options means the writer was
   * not reaching the ledger, independent of any single day's value.
   */
  optionsFieldMissingCount: number;
  /**
   * TRA-2314 — how many day cells each source booked. This is the repair's
   * failing state: a book that was never broken shows no `journal-repair` rows,
   * a repaired one names them. `bucket-no-census` appearing on a recent day
   * means the journal went unreadable and the writer silently fell back to the
   * volatile bucket this ticket exists to stop trusting.
   */
  optionsDailyPnlSourceCounts: Record<string, number>;
  /** TRA-2314 — dates whose `optionsDailyPnl` was rewritten by the historical repair. */
  repairedDates: string[];
  /**
   * TRA-2630 — the STOCK-leg verdict, baseline-gated exactly like `ok`.
   * TRI-STATE: `false` iff some evaluated day's |`stockLegDrift`| exceeds the
   * tolerance, `true` if none does, and **`null` = NOT MEASURED**.
   *
   * TRA-2633 (CEO) — the previous doc here claimed this leg "has a reachable
   * green state and exactly one cause, so a fix moves it". That is FALSE, and
   * shipping it as a plain boolean reproduced Defect A one level down. Measured
   * on the live fleet 2026-07-30T05:52Z, build `1b803bd`:
   *
   *     eodStockPnl === 0             167/167 evaluated rows
   *     stockLegDrift === -stockDaily 167/167 evaluated rows
   *     rows with stockDaily !== 0     40  — every one of them eodStockPnl 0.00
   *
   * `eodStockPnl` comes from the EOD report's `realizedPnl`, which is summed
   * from `allClosedPositions` — the list the TRA-219 archive clears at the SAME
   * 21:00 ET the report is written. So the source is structurally zero: this leg
   * is red iff `stockDaily !== 0`, which is a restatement of the equity delta,
   * not a defect signal. No fix to stock reconciliation can move it.
   *
   * The `null` branch is therefore not cosmetic — it is the difference between
   * "the legs agree" and "nothing looked". It is data-driven, not hardcoded: the
   * moment the report carries a real stock figure on any row that could
   * disagree, this returns to a boolean on its own. See {@link
   * PnlReconcileResult.stockLegMeasuredCount}.
   */
  stockLegOk: boolean | null;
  /**
   * TRA-2633 — how many evaluated rows could actually have shown a stock-leg
   * disagreement (`eodStockPnl` present AND `stockDaily !== 0`). `0` means the
   * verdict above is `null` because there was no cohort to grade — the same
   * empty-set trap that made `livePriorOptionsLagOk` report green over zero live
   * books. Published so a consumer can tell the two `null` causes apart.
   */
  stockLegMeasuredCount: number;
  /** TRA-2630 — dates whose |`stockLegDrift`| exceeds the tolerance (evaluated days only). */
  stockLegOffendingDates: string[];
  /**
   * TRA-2630 — max |`stockLegDrift`| over evaluated days, USD.
   *
   * ⛔ TRA-3948 — carries the scope limit of the field it folds: on a
   * broker-shaped LIVE row `stockLegDrift` is structurally `0`, so this number
   * cannot rise on the live cohort no matter how large the equity residual gets.
   * See {@link PnlReconcileDay.stockLegDrift}. For the live cohort read
   * {@link maxLiveStockLegProbeUsd}.
   */
  maxStockLegDriftUsd: number;
  /**
   * TRA-3948 — **THE EQUITY-PROBE VERDICT: does the booked-`0` stock leg
   * actually explain the session's equity move?** TRI-STATE, and the order is
   * RED > NOT MEASURED > GREEN:
   *
   *  - `false` — some row's |{@link PnlReconcileDay.stockLegProbeUsd}| exceeds
   *    {@link STOCK_LEG_PROBE_TOLERANCE_USD}. Any residual wins outright.
   *  - `null`  — NOT MEASURED. No row in this book could have produced a
   *    material residual (see {@link stockLegProbeDiscriminatingCount}).
   *  - `true`  — at least one DISCRIMINATING row, and none disagreed.
   *
   * WHY IT EXISTS. `stockLegBasis: 'zero-probe-disagrees'` shipped in TRA-3517
   * as a per-row string and NOTHING folded it: on the 2026-08-22T04:42Z live
   * pull, 0 of the endpoint's 117 top-level keys matched `/probe|basis/` while
   * `admin` carried four disagreements up to $197.36. The field whose name
   * promised this — `stockLegDrift` — is arithmetically incapable of moving here
   * (disjoint operands; see {@link PnlReconcileDay.stockLegDrift}), so the
   * reading was a live false-green with no honest `null` behind it.
   *
   * THE VERDICT KEYS ON THE NUMBER, NOT ON `stockLegBasis`. The basis is an
   * open enum written by another module; binding the verdict to the string
   * `'zero-probe-disagrees'` would let a renamed or added constant silently
   * empty the offender set and turn this axis green without a code change here.
   * The string is published as {@link stockLegBasisCounts} — diagnosis, never
   * the verdict — and it is graded against the SAME tolerance the writer
   * stamped it with, so a `'zero-probe-disagrees'` row inside a green cohort is
   * itself a detectable contradiction rather than an invisible one.
   */
  stockLegProbeOk: boolean | null;
  /**
   * TRA-3948 — rows carrying a numeric `stockLegProbeUsd`. MEASUREMENT
   * coverage: how many rows the probe actually ran on. Deliberately NOT the
   * denominator behind {@link stockLegProbeOk}.
   */
  stockLegProbeMeasuredCount: number;
  /**
   * TRA-3948 — rows the writer stamped a `stockLegBasis` on but whose probe is
   * `null` (an operand was absent). Published so a zero
   * {@link stockLegProbeMeasuredCount} is attributable: "the probe could not
   * run" and "there were no broker-shaped rows" are different outages and a
   * count of 0 alone renders them identically.
   */
  stockLegProbeNotMeasuredCount: number;
  /**
   * TRA-3948 — rows carrying NO `stockLegBasis` at all: the writer never made a
   * claim about their stock leg, so they are outside this axis entirely.
   *
   * Published because a `MeasuredCount` alone reads as "the live book is
   * covered", and on `admin` it is not. Its 14 sessions since the
   * 2026-07-30 live-options onset split into THREE regimes, not one:
   *
   *   2026-07-30, 07-31, 08-03  — no ledger row at all (the permanent TRA-2888
   *                               hole). Absent from `days[]`; see the
   *                               `eodInterior*` axes.
   *   2026-08-04 .. 2026-08-11  — 6 rows, `equitySourceEra:
   *                               'unstamped-pre-tra3349'`, UNSTAMPED. Their
   *                               `closingEquity` is frozen at 2603.49 for the
   *                               whole run (the TRA-3288 preserved demo
   *                               PaperAccount) while options booked -$462, so
   *                               `stockDaily: 0` there is the FROZEN SURFACE,
   *                               not the deliberate broker-row `0`. These are
   *                               permanently unprobeable — counted here.
   *   2026-08-12 .. 2026-08-21  — 8 broker-shaped rows, probe stamped. The only
   *                               sessions this axis can speak about.
   *
   * A reader that does not separate the second regime from the third will treat
   * "`stockDaily` is 0 on all 14 post-onset sessions" as one phenomenon with one
   * cause. It is two, and only one of them is by design.
   */
  stockLegProbeUnstampedCount: number;
  /**
   * TRA-3948 — **THE DENOMINATOR BEHIND {@link stockLegProbeOk}.** Measured
   * rows where a material residual was even POSSIBLE: at least one probe
   * operand moved by more than the tolerance
   * (|closingEquity − openingEquity|, |optionsDaily|, or |netCashFlowUsd|).
   *
   * A dormant book probes `0 − 0 − 0 − 0` and emits `zero-probe-agrees` however
   * broken the wiring is. That is a measurement, not evidence — and it is not
   * hypothetical: on the 2026-08-22 live pull the second live book `v0nni` sat
   * at 400.00 → 400.00 on all 8 of its probed sessions and scored 8 clean
   * agreements. Counting those as coverage would have reported 12 clean live
   * sessions against 4 disagreements instead of the true 4-of-4.
   *
   * No red can hide behind this narrowing: a row with a material residual has,
   * by definition, a material equity delta, so every offender is discriminating.
   */
  stockLegProbeDiscriminatingCount: number;
  /** TRA-3948 — dates whose |`stockLegProbeUsd`| exceeds the tolerance. */
  stockLegProbeOffendingDates: string[];
  /**
   * TRA-3948 — largest |`stockLegProbeUsd`| over MEASURED rows, USD. `null` on
   * an empty cohort — `0` there is the `every`-on-the-empty-set pass wearing a
   * number, the exact shape `maxStockLegDriftUsd` was reporting.
   */
  maxStockLegProbeUsd: number | null;
  /**
   * TRA-3948 — rows by `stockLegBasis` string, absent rows excluded. DIAGNOSIS,
   * not the verdict (see {@link stockLegProbeOk}); the vocabulary is open, so
   * treat an unfamiliar key as unread rather than as clean.
   */
  stockLegBasisCounts: Record<string, number>;
  /**
   * TRA-3954 — MEASURED probe rows whose writer subtracted the open-option
   * mark delta (`openOptionMarkDeltaUsd` numeric). Only on these rows does the
   * probe mean "equity motion booked to no leg"; on the rest it is the
   * MTM-vs-realized gap and reads RED on every overnight-option session.
   * Quote beside {@link stockLegProbeDiscriminatingCount}: a green with this
   * at 0 has never exercised the four-operand form.
   */
  stockLegProbeMarkDifferencedCount: number;
  /**
   * TRA-3954 — offending dates whose probe LACKS the mark operand. These are
   * honest (that much equity motion IS booked to no realized leg) but they are
   * not attributable to a missed trade until the mark is known — every pre-
   * TRA-3954 admin offender (08-17/18/20/21) is one, and TRA-3951 attributed
   * all four to unrealized MTM on open contracts. Subset of
   * {@link stockLegProbeOffendingDates}; never removed from it.
   */
  stockLegProbeOffendingWithoutMarkDates: string[];
  /**
   * TRA-3954 — the case that had NEVER fired live before this ticket: a
   * discriminating session that held an option overnight (|mark delta| above
   * tolerance) and still reconciled within tolerance. `0` beside a green means
   * the GREEN branch of the four-operand probe is still unexercised on this
   * book.
   */
  stockLegProbeOvernightReconciledCount: number;
  /**
   * TRA-2630 — the OPTIONS-leg verdict, baseline-gated exactly like `ok`.
   * TRI-STATE as of TRA-2641, and the order is RED > NOT MEASURED > GREEN:
   *
   *   `false` — some evaluated day's |`optionsLegDrift`| exceeds the tolerance.
   *             This is checked FIRST and is never masked by the `null` branch: a
   *             journal-slaved row that still disagrees means
   *             `syncEodReportOptionsLegs` failed to write, which is a real
   *             defect in the writer.
   *   `null`  — NOT MEASURED **as a fleet verdict**. No offender AND either no
   *             independent non-zero row at all, or (TRA-2924) an independent
   *             cohort that does not COVER the rows which had something to say.
   *             Read {@link PnlReconcileResult.optionsLegScope} to tell the two
   *             apart, and `optionsLegCoveredDates` for what did pass.
   *   `true`  — no offender, and `optionsLegScope === 'fleet'`: every row with a
   *             non-zero leg was measured. Nothing was silently excluded.
   *
   * Why the independence test is needed at all: TRA-2641 writes the day cell's
   * `optionsDailyPnl` into the report file's options leg for every `journal` /
   * `journal-repair` row, so on those rows `eodOptionsPnl − optionsDaily` is 0 by
   * construction. That is 147 of 167 live post-baseline rows; the remaining 20
   * carry 0.00 on both legs. See the TRA-2641 block in this file's header and
   * {@link PnlReconcileResult.optionsLegSlavedCount}.
   */
  optionsLegOk: boolean | null;
  /**
   * TRA-2641 — how many evaluated rows could actually have shown an options-leg
   * disagreement: `eodOptionsPnl` present, the row NOT journal-slaved, and at
   * least one of the two legs non-zero. `0` means the verdict above is `null`
   * because there was no independent cohort to grade. This is the DENOMINATOR;
   * publishing it is what stops the next grader from reading a green off it.
   */
  optionsLegMeasuredCount: number;
  /**
   * TRA-2641 — how many evaluated rows were excluded from
   * {@link PnlReconcileResult.optionsLegMeasuredCount} because the report file's
   * options leg is WRITTEN FROM the day cell (`optionsDailyPnlSource` of
   * `journal` or `journal-repair`). Names WHY the denominator is empty, so an
   * empty one reads as "the operands are joined" rather than "no data".
   */
  optionsLegSlavedCount: number;
  /**
   * TRA-2924 — the SCOPE the verdict above may be quoted at. This is the field
   * an acceptance criterion should read; the bare boolean cannot carry its own
   * coverage.
   *
   *   `'fleet'`        — every evaluated row with a non-zero leg was measured.
   *                      `optionsLegOk` covers the whole cohort.
   *   `'partial'`      — the cohort is non-empty and non-tautological, but rows
   *                      that could have disagreed were excluded (joined
   *                      operands, or an absent report leg). `optionsLegOk` is
   *                      `null`; what passed is in `optionsLegCoveredDates`.
   *   `'not-measured'` — no independent non-zero row at all (TRA-2641 shape).
   *
   * There is deliberately no minimum row count and no share threshold anywhere
   * in this: the branch is `optionsLegSilencedDates.length === 0`. A constant
   * would need re-tuning as the fleet changes shape, and re-tuning is how a
   * threshold quietly stops binding.
   */
  optionsLegScope: PnlOptionsLegScope;
  /**
   * TRA-2924 — evaluated rows that had something to say (a non-zero figure on at
   * least one leg) and were nonetheless kept OUT of
   * {@link PnlReconcileResult.optionsLegMeasuredCount}. Non-empty is exactly
   * what demotes a green to `partial`. Published as a SET, not a count: a count
   * invites a threshold, and the identity being asserted is emptiness.
   */
  optionsLegSilencedDates: string[];
  /**
   * TRA-2924 — the rows the verdict actually covers. On a `partial` scope this
   * is the residual evidence: `optionsLegOk` is `null`, but these dates did have
   * independent operands and did agree. Suppressing the CLAIM must not suppress
   * the finding.
   */
  optionsLegCoveredDates: string[];
  /**
   * TRA-2924 — `measured / (measured + silenced)`, rounded to 4 dp; `null` when
   * that denominator is 0. DESCRIPTIVE ONLY — published so a reader can see how
   * thin a `partial` is at a glance. It is **not** the gate and nothing branches
   * on it; the gate is `optionsLegSilencedDates` being empty. Do not write an
   * acceptance criterion against a share constant.
   */
  optionsLegCoverageShare: number | null;
  /** TRA-2630 — dates whose |`optionsLegDrift`| exceeds the tolerance (evaluated days only). */
  optionsLegOffendingDates: string[];
  /** TRA-2630 — max |`optionsLegDrift`| over evaluated days, USD. */
  maxOptionsLegDriftUsd: number;
  /**
   * TRA-2630 AC3 — dates flagged by {@link PnlReconcileDay.lagsPriorOptionsDaily}.
   * Not baseline-gated (see that field). Empty is the passing state.
   */
  priorOptionsLagDates: string[];
  /**
   * TRA-2630 AC3 — the tripwire verdict for this book.
   *
   * TRI-STATE as of TRA-2630 AC2 hardening: `false` = a lag date was found;
   * `true` = at least one {@link PnlReconcileDay.priorOptionsLagEligible}
   * session was graded and none lagged; **`null` = NOT MEASURED** — this book
   * has no session whose prior carried a non-zero `optionsDaily`, so the
   * tripwire had no failing state available and its silence means nothing.
   *
   * It was `priorOptionsLagDates.length === 0` before, i.e. `true` on a book the
   * tripwire could not have flagged. That is `Array.every`-on-the-empty-set
   * wearing different clothes, and it is the same defect this very module
   * documents at {@link summarizeLiveLagTripwire} one layer up.
   */
  priorOptionsLagOk: boolean | null;
  /**
   * TRA-2630 AC2 — sessions where the tripwire COULD have fired, i.e. the
   * gradeable cohort. See {@link PnlReconcileDay.priorOptionsLagEligible}.
   */
  priorOptionsLagEligibleDates: string[];
  /**
   * TRA-2835 — sessions dropped from the gradeable cohort because their
   * predecessor row is not the preceding exchange session (see
   * {@link PnlReconcileDay.priorSessionAdjacent}). Empty when a calendar was
   * supplied and no gaps exist; also empty when no calendar was supplied, which
   * is why `priorSessionAdjacent` carries the tri-state and this does not.
   */
  priorOptionsLagGapSuppressedDates: string[];
  /**
   * TRA-2635 (CEO) — **did realized option P&L actually reach this book's equity?**
   * TRI-STATE: `true` = yes, some gradeable session shows a non-zero credited
   * cumulative; `false` = option P&L was realized and NOTHING was ever credited;
   * **`null` = NOT MEASURED**, never a pass.
   *
   * This is the criterion CEO's TRA-2635 filed against, and it exists because no
   * delta on this row can answer it. Both `stockDaily` and `optionsDaily` are the
   * same on a book that credits correctly and on a book whose credit path has
   * never fired — the live `admin` book showed ZERO T+1-lag rows while its
   * options leg had earned +$987.60, and that "clean" reading was equally
   * consistent with (1) the credit path working and `stockDaily` correctly
   * excluding it, and (2) the credit path never having fired on live at all,
   * where "clean" is what a completely unshipped bridge looks like.
   *
   * THE GRADEABLE COHORT IS DERIVED FROM THE TRIGGER, not from the fleet. A
   * session only grades this if (a) `optionsCreditedCumulative` was actually
   * written on it, and (b) it realized non-zero `optionsDaily` — i.e. there WAS
   * option P&L for equity to absorb. A book that never traded an option cannot
   * verify the bridge, and counting it would be the vacuous pass that made
   * TRA-2625 C5 read green off two books that both had `stockDaily === 0`.
   * `optionsCreditedMeasuredCount` publishes that cohort's size so the two
   * causes of `null` (nothing written / nothing to absorb) stay tellable apart.
   *
   * A ZERO COUNTER IS NOT A `false`. The counter is only admissible as evidence
   * of ABSENCE against a book whose counter is DURABLE — see
   * {@link PnlReconcileResult.counterDurable}, which is `false` on the live fleet
   * today. `true` (a counter that moved) never needs that guard: money that was
   * recorded was recorded. So this is asymmetric on purpose.
   */
  equityAbsorbedOptionsOk: boolean | null;
  /**
   * TRA-2635 — is `optionsCreditedCumulative` trustworthy as evidence of absence
   * on this book? `false` when the row itself proves the counter was zeroed
   * between two writes: a `lagsPriorOptionsDaily` session (the TRA-2629 reset
   * signature — and its presence PROVES a credit arrived) or a negative
   * `optionsCreditedInWindow` (a cumulative cannot decrease). `null` when the
   * counter was never written at all.
   *
   * Measured 2026-07-30T07:48Z: `false` on `Richard`, which wrote 0 on three
   * consecutive sessions while its `closingEquity` moved +67.50 then +22.50 —
   * exactly the two prior sessions' `optionsDaily`.
   *
   * TRA-2658 — a THIRD signature now folds in: {@link counterFrozenDates}. Both
   * signatures above are motion detectors and neither can see a counter stuck at
   * exactly 0, which is what `admin` served while $254.00 of credit reached its
   * equity. Read {@link counterNonDurableDates} for the union that drives this
   * verdict; `counterResetDates` keeps its original, narrower meaning so a reader
   * can still tell a zeroed counter from a frozen one.
   *
   * TRA-2926 — also `null` when the frozen detector graded NO session
   * ({@link counterFrozenGradeableDates} empty), even though the counter was
   * written. Verdict order is RED > NOT MEASURED > GREEN (the standing TRA-2641
   * rule): a red from the gap-robust reset signatures still wins, but green may
   * no longer be claimed off a cohort the gap suppressed entirely.
   */
  counterDurable: boolean | null;
  /** TRA-2635 — the sessions that prove the counter was RESET (zeroed between two writes). */
  counterResetDates: string[];
  /**
   * TRA-2658 — the sessions that prove the counter was FROZEN: material
   * {@link PnlReconcileDay.unbookedEquityMoveUsd}, zero/absent recorded credit,
   * and option P&L realized in the window. Empty is the passing state.
   */
  counterFrozenDates: string[];
  /**
   * TRA-2926 — sessions the frozen-counter detector actually reached a verdict
   * on ({@link PnlReconcileDay.counterFrozen} is a boolean, either way). This is
   * the detector's honest denominator; `counterDurable` may not claim green off
   * an empty one.
   */
  counterFrozenGradeableDates: string[];
  /**
   * TRA-2926 — sessions whose `unbookedEquityMoveUsd` arithmetic was measurable
   * but whose prior ROW is not the preceding exchange session
   * ({@link PnlReconcileDay.priorSessionAdjacent} `false`), so the frozen
   * accusation was suppressed. The raw dollar figure stays on the row and on
   * {@link unbookedEquityMoveDates}; what is fenced is only its contribution to
   * {@link counterDurable}. Mirrors `priorOptionsLagGapSuppressedDates` — the
   * suppression is published, never silent. After the permanent TRA-2888 hole
   * this is where every book's 2026-08-04 row lands.
   */
  counterGapSuppressedDates: string[];
  /** TRA-2658 — the union that drives {@link counterDurable}. Empty is the passing state. */
  counterNonDurableDates: string[];
  /**
   * TRA-2658 — every session with a material un-booked equity move, INCLUDING the
   * ones not attributable to a lost option credit (a starting-balance edit via
   * `PaperAccount.applyEquity` is the common benign cause). Published without an
   * accusation so an un-attributed move stays visible rather than being either
   * silently dropped or wrongly folded into `counterDurable`.
   */
  unbookedEquityMoveDates: string[];
  /** TRA-2658 — largest absolute un-booked equity move on this book, in USD. */
  maxUnbookedEquityMoveUsd: number;
  /**
   * TRA-2635 — THE STATE MEASUREMENT. Needs no counter, so it survives the defect
   * above: `(Σ optionsDaily + Σ stockDaily) − Δ closingEquity` over evaluated
   * sessions, i.e. how much of the realized book P&L never reached NAV.
   *
   * UPPER BOUND when `counterDurable === false`: the lagged credit is already
   * inside `stockDaily` there, so that leg double-counts it (Richard: 400.29
   * nominal vs ~310.29 net of its $90.00 of double-counted credit — the same
   * double-count that must not be denominated into an equity backfill).
   */
  uncreditedOptionsUsd: number | null;
  /**
   * TRA-3589 — why {@link uncreditedOptionsUsd} is `null`, or `null` when it is
   * a number. `'equity-span-crosses-equity-source-era'` is the TRA-3349
   * boundary: the window's two equity endpoints were read off different
   * surfaces, so their difference is not a P&L measurement at any value.
   */
  uncreditedOptionsNotMeasuredReason: string | null;
  /** TRA-2635 — the three operands, published so the subtraction is checkable. */
  postBaselineEquityGrowth: number | null;
  /**
   * TRA-3589 — TRUE when {@link postBaselineEquityGrowth}'s two endpoints sit on
   * either side of the broker boundary, i.e. when that number measures a change
   * of instrument rather than a change of money. The operand stays published
   * when this is `true`; only the derived verdict refuses.
   */
  postBaselineEquityGrowthSpansEquitySourceEras: boolean;
  /** TRA-3589 — where this book's equity changed surface. See {@link EquitySourceEraBoundary}. */
  equitySourceEraBoundary: EquitySourceEraBoundary;
  postBaselineOptionsRealized: number;
  postBaselineStockDaily: number;
  /**
   * TRA-2831 — the ET date this book first opened a LIVE option, or `null` if it
   * never has. See {@link liveOptionsOnsetEtDate}. `null` on every demo book,
   * and on a live book that has not yet traded an option in live mode.
   */
  liveOptionsOnsetDate: string | null;
  /**
   * TRA-2831 — how much of `postBaselineOptionsRealized` is booked to sessions
   * that predate {@link liveOptionsOnsetDate}, i.e. how much of the numerator is
   * NOT live money. Equals `postBaselineOptionsRealized` exactly when the onset
   * is `null` (nothing in the window can be live), which is the honest reading
   * and not a manufactured zero.
   *
   * On a demo book this is simply "all of it" and carries no accusation — the
   * field only becomes a verdict input inside the live cohort, where
   * {@link summarizeLiveCreditObservation} uses it to disqualify a contaminated
   * `liveUncreditedOptionsUsd`.
   */
  optionsRealizedBeforeLiveOnsetUsd: number;
  /** TRA-2831 — the pre-onset sessions carrying a non-zero options figure. */
  preLiveOnsetOptionsDates: string[];
  /**
   * TRA-2919 — the live credit axis re-sourced from the option-trade JOURNAL, so
   * it survives both the TRA-2831 contamination gate (which is permanent on
   * `admin`) and the permanent TRA-2888 EOD hole. See
   * {@link summarizePostOnsetLiveCredit} for why the day cells cannot carry it.
   *
   * This is the axis to grade. The three `*UncreditedOptions*` fields on the
   * fleet fold retain their TRA-2831 meaning and are DAY-CELL-sourced over the
   * whole post-baseline window; they are evidence, not a live-money verdict.
   */
  postOnsetCredit: PostOnsetLiveCredit;
  /**
   * TRA-2635 — how many evaluated sessions could actually have graded the
   * bridge (`optionsCreditedCumulative` present AND `optionsDaily` non-zero).
   * `0` means the verdict above is `null` for want of a cohort, not because
   * anything failed.
   */
  optionsCreditedMeasuredCount: number;
  /**
   * TRA-2635 — sessions whose `optionsCreditedInWindow` is non-zero: the dates
   * on which a credit demonstrably MOVED. Positive evidence, and the direct
   * answer to "when did the bridge last fire on this book?".
   */
  optionsCreditedDates: string[];
  /** TRA-2635 — latest written `optionsCreditedCumulative`; null if never written. */
  optionsCreditedLatest: number | null;
  /** TRA-2635 — latest durable `closingEquity`, and the session it was written on. */
  closingEquityLatest: number | null;
  closingEquityLatestDate: string | null;
}

/**
 * TRA-2630 AC3 — the REAL-MONEY tripwire, folded over the fleet.
 *
 * WHY THIS IS NOT A ONE-LINER. The obvious spelling is
 *
 *     livePriorOptionsLagOk: engines.every(e => e.mode !== 'live' || e.priorOptionsLagOk)
 *
 * and that is what shipped in `2b198109`. `Array.every` is TRUE ON THE EMPTY SET,
 * so when the fleet contains no `mode: 'live'` book at all the tripwire reports a
 * clean bill of health for real money it never looked at. "No live book was
 * affected" and "there was no live book" are then the SAME reading — the exact
 * confusion CEO filed as TRA-2635, one layer down.
 *
 * That is not hypothetical, and it is not a rare state. Measured on bqb1
 * 2026-07-30T05:16Z: all 58 books resolved `mode: 'demo'` and
 * `livePriorOptionsLagOk` read `true`. The live cohort was empty because the
 * TRA-713/TRA-1652 boot-arm failed to converge that boot —
 * `/api/health/options-live` reported `bootArmEligible: true` with
 * `bootArmDrift: ['mode']`, i.e. the operator SHOULD have been armed live and was
 * not. Two pulls 3h earlier (02:08Z, 03:52Z) both carried `admin` as `mode: live`.
 * So the cohort empties on a boot-arm miss, and the tripwire's answer flips from
 * "graded and clean" to "manufactured green" with no change in the field's value.
 *
 * The mode axis is `stockModeKey`, which is 'demo' | 'live' | 'sandbox' — a book
 * armed live but pointed at the Tradier SANDBOX resolves 'sandbox', routes paper
 * fills, and is CORRECTLY outside a real-money tripwire. It still empties the
 * cohort, so it must still read NOT MEASURED rather than OK.
 *
 * Hence the tri-state: `null` means NOT MEASURED and is never a pass. Callers
 * must fail closed on it (`scripts/check-pnl-options-lag.mjs` exits BLIND/3),
 * which is the same "ABSENCE IS NOT A PASS" discipline this module already
 * applies to absent per-leg fields (TRA-2637).
 */
export function summarizeLiveLagTripwire(
  engines: ReadonlyArray<{
    username: string;
    mode: string;
    priorOptionsLagOk: boolean | null;
    priorOptionsLagDates: string[];
    priorOptionsLagEligibleDates: string[];
  }>,
): {
  liveBookCount: number;
  liveGradeableBookCount: number;
  livePriorOptionsLagOk: boolean | null;
  livePriorOptionsLagBooks: Array<{ username: string; dates: string[] }>;
} {
  const liveBooks = engines.filter(e => e.mode === 'live');
  const offenders = liveBooks
    .filter(e => e.priorOptionsLagOk === false)
    .map(e => ({ username: e.username, dates: e.priorOptionsLagDates }));
  // TRA-2630 AC2 — the SECOND empty cohort, one level in from the one this
  // function was written to close. `liveBookCount: 1` proves a live book was
  // LOOKED AT; it does not prove the tripwire could have fired on it. A live book
  // whose every session follows a zero-`optionsDaily` prior is graded by a
  // predicate with no failing state, and folding it as green rebuilds the exact
  // manufactured-green this doc comment is about — just with a non-empty filter.
  const gradeable = liveBooks.filter(e => e.priorOptionsLagEligibleDates.length > 0);
  return {
    liveBookCount: liveBooks.length,
    liveGradeableBookCount: gradeable.length,
    // NOT MEASURED, not OK — see the note above. Red wins over unmeasured, so a
    // flagged book is still reported even if some other live book is ungradeable.
    livePriorOptionsLagOk:
      offenders.length > 0 ? false : gradeable.length === 0 ? null : true,
    livePriorOptionsLagBooks: offenders,
  };
}

/**
 * TRA-3864 — the fleet fold of the day-cell / journal agreement axis.
 *
 * ── What this exists to catch ────────────────────────────────────────────────
 *
 * A day cell persisted at the 21:00 ET archive from the journal, whose journal
 * row was LATER restated (TRA-2819's close-basis correction, applied in bulk by
 * TRA-3730's self-driving sweep). The cell keeps the pre-restatement figure.
 * Nothing propagates, and — until this fold — nothing compared, even though both
 * numbers rode the same published object.
 *
 * ── Why the obvious reader was blind ─────────────────────────────────────────
 *
 * `optionsLegDrift` reads exactly 0.00 on every one of these rows and is RIGHT
 * to: TRA-2641's `syncEodReportOptionsLegs` writes the day cell into the report
 * file's options leg on precisely the journal-authoritative cohort, so that leg
 * compares a source against a copy of itself (TRA-2630 ruled it self-confirming
 * and NOT gradeable). Re-reading a slaved axis harder would never have found
 * this. The operand that IS independent — `journalOptionsPnl`, recomputed per
 * request from the append-only journal — sat unread in the same object.
 *
 * ── Verdict discipline ───────────────────────────────────────────────────────
 *
 * Tri-state and folded RED > NOT MEASURED > GREEN, and `engines.every(...)` is
 * the WRONG spelling here for the reason TRA-2633 already had to fix once: it
 * coerces a `null` book to `false` and invents a fleet regression out of "nobody
 * looked". `gradeableBookCount` is published because a green over an EMPTY
 * cohort is the manufactured pass this module has shipped twice
 * (`optionsLegOk` / TRA-2924, `livePriorOptionsLagOk` / TRA-2630 AC2).
 *
 * The LIVE cohort is folded separately and named per book. The 2026-08-19 finding
 * was two live money-book cells (`admin` 08-18 at −121.77 and 08-11 at +0.86)
 * against one demo mirror cell — a fleet-only count of 3 does not say that, and
 * "which of these is real money" is the only question a desk asks first.
 *
 * ── TRA-3867: why `journalDayCellAgreementOk` is NOT the field to gate on ─────
 *
 * TRA-3864 was ruled **(b) freeze, and say so** — the archived cell keeps its
 * archive-time figure and the divergence is published rather than silently
 * corrected, because `planOptionsDailyPnlRepair` moves a cell only from an exact
 * `0.00` and puts every non-zero disagreement in `leftAloneDates` (TRA-2079).
 *
 * The arithmetic consequence nobody wrote down: **nothing in the system can ever
 * retire those 3 cells**, so `journalDayCellAgreementOk` and
 * `liveJournalDayCellAgreementOk` are `false` PERMANENTLY, on a correctly
 * behaving box. As shipped, the verdict field could not distinguish "the 3 known,
 * ruled, frozen cells" from "a 4th one arrived overnight and nobody looked" —
 * both render `false`. An alarm that is always firing is exactly as uninformative
 * as one that never fires; it is TRA-3827's clamped metric approached from the
 * other side, and the observed end state is that the axis gets routed around.
 *
 * So the two questions are SPLIT, and neither number already on the wire moves:
 *
 *   `journalDayCellAgreementOk`         RAW IDENTITY. "Does every gradeable cell
 *                                       equal its journal?" Permanently `false`
 *                                       while any ruled cell is frozen. ⛔ DO NOT
 *                                       BIND A GATE OR A DASHBOARD LIGHT TO IT.
 *   `journalDayCellNoNewSupersessionOk` THE GATEABLE VERDICT. "Is every divergent
 *                                       cell one that was ruled and accepted?"
 *                                       `false` means NEW, UNRULED divergence.
 *                                       Reachable-green on a healthy box.
 *
 * The acknowledged set is a NAMED, PINNED list, not a high-water count. A count
 * of 3 would let a 4th arrive while one of the 3 retired and still read green —
 * and these cells cannot retire, so a count carries no information the names do
 * not. Every acknowledged cell keeps publishing in `journalDayCellSupersededBooks`
 * and keeps being counted by `journalDayCellSupersededCount`: the exemption
 * suppresses a VERDICT, never a row.
 *
 * ⚠️ The standing hazard with any name list is TRA-3831's: a ban list is *names*
 * while the invariant is a *property*, so the list goes quiet on its own shape as
 * it grows. Three things hold that down here and all three are load-bearing:
 * (1) the set is a source constant with NO env override, so widening it costs a
 * commit and a review exactly as the ruling did; (2) the set is PUBLISHED on the
 * wire (`journalDayCellAcknowledgedCells`), so the exemption is auditable without
 * reading source; (3) an entry naming a cell that is no longer superseded is
 * published as `journalDayCellStaleAcknowledgements` rather than dropped, because
 * a dead entry silently pre-exempts a future re-divergence on that same cell.
 */

/**
 * TRA-3867 — the ruled-and-accepted day-cell supersessions, keyed
 * `username|mode|date`. Membership here suppresses ONLY
 * `journalDayCellNoNewSupersessionOk`; the cell still publishes in every count
 * and every date list.
 *
 * ⛔ Adding a row here says "the board ruled this specific historical cell frozen
 * and it will never converge". It does NOT mean "this is noisy". A cell that
 * could still be repaired belongs in `planOptionsDailyPnlRepair`, not here.
 */
export const ACKNOWLEDGED_JOURNAL_DAY_CELL_SUPERSESSIONS: ReadonlyArray<{
  username: string;
  mode: string;
  date: string;
  /** The issue that ruled this cell frozen. Every entry cites one. */
  ticket: string;
  note: string;
}> = [
  {
    username: 'admin',
    mode: 'live',
    date: '2026-08-11',
    ticket: 'TRA-3864',
    note: 'Live money cell, +0.86 (−16.00 archived vs −16.86 restated). Frozen '
      + 'under the TRA-3864 (b) ruling; non-zero, so TRA-2079 refuses to move it.',
  },
  {
    username: 'admin',
    mode: 'live',
    date: '2026-08-18',
    ticket: 'TRA-3864',
    note: 'Live money cell, −121.77 (−393.00 archived vs −271.23 restated). '
      + 'Frozen under the TRA-3864 (b) ruling; TRA-2819/TRA-3730 close-basis.',
  },
  {
    username: 'qa_mirror_1578_38096',
    mode: 'demo',
    date: '2026-07-28',
    ticket: 'TRA-3864',
    note: 'QA mirror cell, −63.00. Same restatement, demo cohort.',
  },
];

const dayCellKey = (username: string, mode: string, date: string): string =>
  `${username}|${mode}|${date}`;

export function summarizeJournalDayCellAgreement(
  engines: ReadonlyArray<{
    username: string;
    mode: string;
    journalAgreementOk: boolean | null;
    journalSupersededDates: string[];
    journalAgreementGradeableCount: number;
    maxJournalSupersessionUsd: number | null;
  }>,
  acknowledged: ReadonlyArray<{
    username: string;
    mode: string;
    date: string;
    ticket: string;
  }> = ACKNOWLEDGED_JOURNAL_DAY_CELL_SUPERSESSIONS,
): {
  journalDayCellAgreementOk: boolean | null;
  journalDayCellGradeableCount: number;
  journalDayCellGradeableBookCount: number;
  journalDayCellSupersededCount: number;
  journalDayCellSupersededBooks: Array<{
    username: string;
    mode: string;
    dates: string[];
    maxDeltaUsd: number | null;
  }>;
  liveJournalDayCellAgreementOk: boolean | null;
  liveJournalDayCellGradeableBookCount: number;
  liveJournalDayCellSupersededBooks: Array<{ username: string; dates: string[] }>;
  journalDayCellNoNewSupersessionOk: boolean | null;
  liveJournalDayCellNoNewSupersessionOk: boolean | null;
  journalDayCellUnacknowledgedCount: number;
  journalDayCellUnacknowledgedBooks: Array<{
    username: string;
    mode: string;
    dates: string[];
  }>;
  liveJournalDayCellUnacknowledgedBooks: Array<{ username: string; dates: string[] }>;
  journalDayCellAcknowledgedCount: number;
  journalDayCellAcknowledgedCells: Array<{
    username: string;
    mode: string;
    date: string;
    ticket: string;
  }>;
  journalDayCellStaleAcknowledgements: Array<{
    username: string;
    mode: string;
    date: string;
    ticket: string;
  }>;
} {
  const fold = (cohort: ReadonlyArray<(typeof engines)[number]>): boolean | null =>
    cohort.some(e => e.journalAgreementOk === false)
      ? false
      : cohort.some(e => e.journalAgreementGradeableCount > 0)
        ? true
        : null;
  const offenders = engines.filter(e => e.journalSupersededDates.length > 0);
  const liveBooks = engines.filter(e => e.mode === 'live');

  // TRA-3867 — the UNACKNOWLEDGED residue, per book. Same tri-state fold as the
  // raw identity above, and deliberately the same shape: `false` (a new,
  // unruled divergence) wins outright, `null` means NOBODY WAS GRADEABLE and is
  // never a pass, `true` means at least one cell could have diverged and every
  // cell that did was already ruled.
  const ackKeys = new Set(acknowledged.map(a => dayCellKey(a.username, a.mode, a.date)));
  const unacknowledgedByBook = offenders
    .map(e => ({
      username: e.username,
      mode: e.mode,
      dates: e.journalSupersededDates.filter(
        d => !ackKeys.has(dayCellKey(e.username, e.mode, d)),
      ),
    }))
    .filter(b => b.dates.length > 0);
  const unackKeys = new Set(unacknowledgedByBook.map(b => `${b.username}|${b.mode}`));
  const foldNoNew = (cohort: ReadonlyArray<(typeof engines)[number]>): boolean | null =>
    cohort.some(e => unackKeys.has(`${e.username}|${e.mode}`))
      ? false
      : cohort.some(e => e.journalAgreementGradeableCount > 0)
        ? true
        : null;
  // An acknowledgement whose cell no longer reads superseded. Published, never
  // dropped: a dead entry is a standing pre-exemption for that exact cell, so it
  // has to be visible to whoever audits the list. NOT folded into the verdict —
  // a book leaving the fleet (a retired QA mirror) is not an incident.
  const supersededKeys = new Set(
    offenders.flatMap(e => e.journalSupersededDates.map(d => dayCellKey(e.username, e.mode, d))),
  );

  return {
    journalDayCellAgreementOk: fold(engines),
    journalDayCellGradeableCount: engines.reduce(
      (n, e) => n + e.journalAgreementGradeableCount,
      0,
    ),
    journalDayCellGradeableBookCount: engines.filter(e => e.journalAgreementGradeableCount > 0)
      .length,
    journalDayCellSupersededCount: offenders.reduce(
      (n, e) => n + e.journalSupersededDates.length,
      0,
    ),
    journalDayCellSupersededBooks: offenders.map(e => ({
      username: e.username,
      mode: e.mode,
      dates: e.journalSupersededDates,
      maxDeltaUsd: e.maxJournalSupersessionUsd,
    })),
    liveJournalDayCellAgreementOk: fold(liveBooks),
    liveJournalDayCellGradeableBookCount: liveBooks.filter(
      e => e.journalAgreementGradeableCount > 0,
    ).length,
    liveJournalDayCellSupersededBooks: liveBooks
      .filter(e => e.journalSupersededDates.length > 0)
      .map(e => ({ username: e.username, dates: e.journalSupersededDates })),
    journalDayCellNoNewSupersessionOk: foldNoNew(engines),
    liveJournalDayCellNoNewSupersessionOk: foldNoNew(liveBooks),
    journalDayCellUnacknowledgedCount: unacknowledgedByBook.reduce(
      (n, b) => n + b.dates.length,
      0,
    ),
    journalDayCellUnacknowledgedBooks: unacknowledgedByBook,
    liveJournalDayCellUnacknowledgedBooks: unacknowledgedByBook
      .filter(b => b.mode === 'live')
      .map(b => ({ username: b.username, dates: b.dates })),
    journalDayCellAcknowledgedCount: acknowledged.length,
    journalDayCellAcknowledgedCells: acknowledged.map(a => ({
      username: a.username,
      mode: a.mode,
      date: a.date,
      ticket: a.ticket,
    })),
    journalDayCellStaleAcknowledgements: acknowledged
      .filter(a => !supersededKeys.has(dayCellKey(a.username, a.mode, a.date)))
      .map(a => ({ username: a.username, mode: a.mode, date: a.date, ticket: a.ticket })),
  };
}

/**
 * TRA-2635 (CEO) — **the money question, folded over the live cohort.** Did
 * realized option P&L reach the equity of the book that carries real capital?
 *
 * `livePriorOptionsLagOk` (above) can only report the T+1 MIS-BUCKET signature.
 * It reads clean on a book where the credit never fired at all, because there is
 * no lag when there is no credit. CEO's TRA-2635 retraction is exactly that:
 * grading the live book off the lag signature alone graded it with an instrument
 * that cannot resolve the question, and a "clean" live book is what BOTH a
 * working bridge and a completely unshipped one look like on that axis.
 *
 * TRI-STATE, and folded the same way as {@link PnlReconcileResult.stockLegOk} —
 * a red book wins, otherwise one genuinely-measured green is required to claim
 * green, all-NOT-MEASURED stays `null`:
 *
 *   - `false` — a live book realized option P&L and equity absorbed NONE of it.
 *     That is a NAV UNDERSTATEMENT on real capital: the bridge is unshipped
 *     there and every sizing decision is being made off the wrong book value.
 *   - `true`  — some live book's equity demonstrably absorbed a credit.
 *   - `null`  — NOT MEASURED. Either the live cohort is EMPTY (which bqb1 serves
 *     intermittently on a boot-arm miss — see the note on
 *     `summarizeLiveLagTripwire`) or no live session both wrote the counter and
 *     realized option P&L. Never a pass; callers must fail closed.
 *
 * `liveCreditBookCount` is what makes the empty cohort distinguishable from a
 * graded one — publishing the verdict without it reproduces the `every`-is-true-
 * on-the-empty-set defect this module has already shipped twice.
 */
export function summarizeLiveCreditObservation(
  engines: ReadonlyArray<{
    username: string;
    mode: string;
    equityAbsorbedOptionsOk: boolean | null;
    counterDurable: boolean | null;
    counterFrozenDates: string[];
    counterNonDurableDates: string[];
    maxUnbookedEquityMoveUsd: number;
    optionsCreditedMeasuredCount: number;
    optionsCreditedLatest: number | null;
    optionsCreditedDates: string[];
    closingEquityLatest: number | null;
    closingEquityLatestDate: string | null;
    uncreditedOptionsUsd: number | null;
    postBaselineEquityGrowth: number | null;
    postBaselineOptionsRealized: number;
    postBaselineStockDaily: number;
    liveOptionsOnsetDate: string | null;
    optionsRealizedBeforeLiveOnsetUsd: number;
    preLiveOnsetOptionsDates: string[];
    postOnsetCredit: PostOnsetLiveCredit;
    uncreditedOptionsNotMeasuredReason: string | null;
    postBaselineEquityGrowthSpansEquitySourceEras: boolean;
    equitySourceEraBoundary: EquitySourceEraBoundary;
  }>,
): {
  liveCreditBookCount: number;
  liveEquityAbsorbedOptionsOk: boolean | null;
  liveUncreditedOptionsUsd: number | null;
  liveUncreditedOptionsUsdUnscoped: number | null;
  liveEquitySourceEraBoundaryBooks: Array<Record<string, unknown>>;
  liveEquitySourceEraRestatementUsd: number | null;
  liveUncreditedOptionsGradeable: boolean;
  liveModeSpanContaminatedBooks: Array<Record<string, unknown>>;
  liveCounterDurableOk: boolean | null;
  liveCreditBooks: Array<Record<string, unknown>>;
  liveOnsetOptionsRealizedJournalUsd: number | null;
  liveOnsetOptionsDayCellUsd: number | null;
  liveOnsetUncreditedOptionsUsd: number | null;
  liveOnsetCreditNumeratorBookCount: number;
  liveOnsetCreditComparisonBookCount: number;
  liveOnsetCreditNotMeasuredBooks: Array<Record<string, unknown>>;
} {
  const liveBooks = engines.filter(e => e.mode === 'live');
  const measurable = liveBooks.filter(e => e.uncreditedOptionsUsd != null);
  // TRA-3589 — the live books whose published equity series changes surface
  // mid-flight. A SET of named books with their dates and dollar steps, never a
  // boolean and never a count: a boolean pinned `true` by `admin` and `v0nni`
  // stops discriminating the moment a third book joins them, and a count is dead
  // the same way once one entity permanently occupies slot one.
  const eraBoundaryBooks = liveBooks.filter(e =>
    e.equitySourceEraBoundary.seriesSpansBrokerBoundary);
  // TRA-2831 — a measurable book whose numerator is (partly) demo money. The
  // dollar figure is arithmetically fine; what is wrong is calling it LIVE.
  const contaminated = measurable.filter(e =>
    Math.abs(e.optionsRealizedBeforeLiveOnsetUsd) > PNL_RECONCILE_TOLERANCE_USD);
  const unscoped = measurable.length === 0
    ? null
    : round2(measurable.reduce((s, e) => s + (e.uncreditedOptionsUsd ?? 0), 0));
  // TRA-2919 — the JOURNAL-sourced axis, folded over the same live cohort. Two
  // separate cohorts, and they must not be collapsed:
  //
  //  - NUMERATOR measurable — the book has a live onset and a journal to ask, so
  //    its post-onset live realized P&L is a number. This is what makes the axis
  //    gradeable again after TRA-2831 made the day-cell figure permanently null.
  //  - COMPARISON measurable — additionally, no expected session inside the
  //    equity anchor window is missing a row, so the subtraction means something.
  //
  // On `admin` today the first holds and the second does not (07-30/07-31/08-03
  // are the permanent TRA-2888 hole), which is exactly the state this fold has to
  // be able to express: the live money is MEASURED, and whether NAV absorbed it
  // is NOT.
  const onsetNumerator = liveBooks.filter(e => e.postOnsetCredit.journalOptionsUsd != null);
  const onsetComparison = liveBooks.filter(e => e.postOnsetCredit.uncreditedOptionsUsd != null);
  return {
    liveCreditBookCount: liveBooks.length,
    liveEquityAbsorbedOptionsOk: liveBooks.some(e => e.equityAbsorbedOptionsOk === false)
      ? false
      : liveBooks.some(e => e.equityAbsorbedOptionsOk === true)
        ? true
        : null,
    // TRA-2635 — THE DOLLAR FIGURE, and it is what carries the finding when the
    // boolean above is NOT MEASURED. Null (not 0) when no live book could be
    // measured: a zero here must never be reachable by absence.
    //
    // TRA-2831 — now ALSO null when any contributing book's numerator predates
    // its live-options onset. The published 733.60 was built entirely out of
    // `admin`'s 2026-07-15 … 07-29 DEMO-mode option P&L (987.60), booked into the
    // live cohort because the cohort is keyed on the book's mode TODAY while the
    // ledger under it is mode-blind for all time. This field's contract is "live
    // money not in NAV"; a demo-sourced number cannot satisfy it at any value,
    // so it reads NOT MEASURED rather than being silently rescaled.
    //
    // Note what this does NOT do: it does not wait on TRA-2827's back-fill of
    // 07-30 / 07-31 / 08-03. Those rows are post-onset, so writing them adds a
    // genuinely live term WITHOUT removing the 987.60 pre-onset term — the
    // window would look unbroken while the numerator stayed exactly as
    // un-attributable, which is strictly worse than the visible hole. The gate
    // is on provenance, not on completeness.
    liveUncreditedOptionsUsd: contaminated.length > 0 ? null : unscoped,
    // The arithmetic, retained verbatim as a MEASUREMENT. CFO's TRA-2831 ruling
    // suspends 733.60 as a live-money figure but keeps it published — deleting it
    // would destroy the evidence the suspension rests on, and a reader comparing
    // this to `liveUncreditedOptionsUsd` can see the disqualification directly.
    liveUncreditedOptionsUsdUnscoped: unscoped,
    // TRA-3589 — THE MARKER, at the fleet level: which live books' equity series
    // changes surface, where, and by how much. Published beside the numbers it
    // disqualifies so a reader cannot find one without the other.
    //
    // Until 2026-08-12 both entries here were absent and `*Unscoped` published
    // 733.60 / 371.59; on 2026-08-13 it published 25,971.12, of which 24,600.00
    // came from a book that has never opened an option. That jump WAS the
    // boundary, and nothing in the payload said so.
    liveEquitySourceEraBoundaryBooks: eraBoundaryBooks.map(e => ({
      username: e.username,
      brokerOnsetDate: e.equitySourceEraBoundary.brokerOnsetDate,
      brokerOnsetOpeningEquity: e.equitySourceEraBoundary.brokerOnsetOpeningEquity,
      priorEraRowDate: e.equitySourceEraBoundary.priorEraRowDate,
      priorEraRowEquitySourceEra: e.equitySourceEraBoundary.priorEraRowEquitySourceEra,
      priorEraRowClosingEquity: e.equitySourceEraBoundary.priorEraRowClosingEquity,
      restatementUsd: e.equitySourceEraBoundary.restatementUsd,
      eraCensus: e.equitySourceEraBoundary.eraCensus,
      uncreditedOptionsNotMeasuredReason: e.uncreditedOptionsNotMeasuredReason,
      // The operand kept visible beside the verdict it disqualifies.
      postBaselineEquityGrowth: e.postBaselineEquityGrowth,
      postBaselineOptionsRealized: e.postBaselineOptionsRealized,
      postBaselineStockDaily: e.postBaselineStockDaily,
    })),
    // The combined step, published so the -26,059.43 a reader can compute is
    // already named. NOT a loss, NOT a cash movement, NOT P&L — see
    // {@link EquitySourceEraBoundary.restatementUsd}. `null` (never 0) when no
    // live book has both endpoints, so "no boundary yet" and "the boundary
    // netted to zero" cannot render alike.
    liveEquitySourceEraRestatementUsd: eraBoundaryBooks.length === 0
      ? null
      : round2(eraBoundaryBooks.reduce(
        (s, e) => s + (e.equitySourceEraBoundary.restatementUsd ?? 0), 0)),
    // TRA-2919 — REDEFINED, and read this before grading it.
    //
    // It used to mean "the day-cell figure above is attributable live money",
    // which on `admin` is FALSE FOREVER: the gate keys on
    // `optionsRealizedBeforeLiveOnsetUsd`, that figure is durable history, and it
    // does not age out. A boolean with no reachable true state on the only book
    // that carries capital is not a grade, it is a mute button.
    //
    // It now means: **at least one live book has a post-onset numerator sourced
    // from the JOURNAL** — i.e. the axis TRA-2630 named as the independent signal
    // can be measured at all. It is an ATTRIBUTION gate and nothing more.
    //
    // IT IS NOT A CLAIM THAT THE DOLLAR COMPARISON IS AVAILABLE. `true` here with
    // `liveOnsetUncreditedOptionsUsd: null` is the correct and expected reading on
    // a book whose equity anchor spans the permanent TRA-2888 hole. A gate that
    // wants the money verdict must require BOTH this AND
    // `liveOnsetCreditNotMeasuredBooks` to be EMPTY — asserting a published
    // denominator without also asserting the silenced set is empty is how a
    // fleet-wide green survives a cohort that quietly shrank to nothing.
    liveUncreditedOptionsGradeable: onsetNumerator.length > 0,
    // The attribution for the null above. Empty array + `gradeable: false` means
    // "no measurable live book at all"; non-empty means "measured, and the money
    // is not live" — two different states that must not collapse.
    liveModeSpanContaminatedBooks: contaminated.map(e => ({
      username: e.username,
      liveOptionsOnsetDate: e.liveOptionsOnsetDate,
      optionsRealizedBeforeLiveOnsetUsd: e.optionsRealizedBeforeLiveOnsetUsd,
      preLiveOnsetOptionsDates: e.preLiveOnsetOptionsDates,
      postBaselineOptionsRealized: e.postBaselineOptionsRealized,
      uncreditedOptionsUsd: e.uncreditedOptionsUsd,
    })),
    // TRA-2658 AC2, folded so a checker can assert it without walking the array.
    // Same tri-state precedence as every other fold in this module — RED beats
    // NOT MEASURED beats GREEN — and `null` requires `liveCreditBookCount` to
    // interpret: an empty live cohort must never read as a passing durability
    // grade, which is the failure mode `summarizeLiveLagTripwire` documents.
    liveCounterDurableOk: liveBooks.some(e => e.counterDurable === false)
      ? false
      : liveBooks.some(e => e.counterDurable === true)
        ? true
        : null,
    // Named, not anonymized: this endpoint already publishes each book's full
    // per-session P&L series under its username, and an unnamed red verdict on
    // real capital is not actionable.
    liveCreditBooks: liveBooks.map(e => ({
      username: e.username,
      equityAbsorbedOptionsOk: e.equityAbsorbedOptionsOk,
      counterDurable: e.counterDurable,
      // TRA-2658 — the ATTRIBUTION for a `counterDurable: false`. Without these a
      // reader cannot tell a zeroed counter (money already double-booked into the
      // stock leg, so `uncreditedOptionsUsd` is an upper bound) from a frozen one
      // (stock leg is exact, and the credit is missing from every daily row while
      // still present in `closingEquity`). The two need opposite remediations.
      counterFrozenDates: e.counterFrozenDates,
      counterNonDurableDates: e.counterNonDurableDates,
      maxUnbookedEquityMoveUsd: e.maxUnbookedEquityMoveUsd,
      optionsCreditedMeasuredCount: e.optionsCreditedMeasuredCount,
      optionsCreditedLatest: e.optionsCreditedLatest,
      optionsCreditedDates: e.optionsCreditedDates,
      closingEquityLatest: e.closingEquityLatest,
      closingEquityLatestDate: e.closingEquityLatestDate,
      uncreditedOptionsUsd: e.uncreditedOptionsUsd,
      // TRA-3589 — a `null` above now always carries its reason, so a suppressed
      // figure and an unreachable one do not read alike on the book list.
      uncreditedOptionsNotMeasuredReason: e.uncreditedOptionsNotMeasuredReason,
      equitySourceEraBoundary: e.equitySourceEraBoundary,
      postBaselineEquityGrowthSpansEquitySourceEras:
        e.postBaselineEquityGrowthSpansEquitySourceEras,
      postBaselineEquityGrowth: e.postBaselineEquityGrowth,
      postBaselineOptionsRealized: e.postBaselineOptionsRealized,
      postBaselineStockDaily: e.postBaselineStockDaily,
      // TRA-2831 — the provenance of the numerator, on every live book and not
      // only the contaminated ones. A reader must be able to see that a book's
      // figure IS attributable, not just infer it from absence from the
      // contaminated list.
      liveOptionsOnsetDate: e.liveOptionsOnsetDate,
      optionsRealizedBeforeLiveOnsetUsd: e.optionsRealizedBeforeLiveOnsetUsd,
      preLiveOnsetOptionsDates: e.preLiveOnsetOptionsDates,
      // TRA-2919 — the journal-sourced axis, per book, on every live book and not
      // only the measurable ones. A reader must be able to see WHY a book's
      // comparison is null without inferring it from absence.
      postOnsetCredit: e.postOnsetCredit,
    })),
    // TRA-2919 — THE NUMERATOR, folded. Post-onset live realized option P&L
    // straight from the journal: the money the day cells lost to the TRA-2888
    // hole. `null` (never 0) when no live book could be measured.
    liveOnsetOptionsRealizedJournalUsd: onsetNumerator.length === 0
      ? null
      : round2(onsetNumerator.reduce((s, e) => s + (e.postOnsetCredit.journalOptionsUsd ?? 0), 0)),
    // The FOIL, folded over the same windows — what a day-cell-sourced numerator
    // would have published. Kept beside the real figure so the reason this was
    // not built the obvious way is readable off the live surface, not just out of
    // TRA-2919 and a regression test.
    liveOnsetOptionsDayCellUsd: onsetNumerator.length === 0
      ? null
      : round2(onsetNumerator.reduce((s, e) => s + (e.postOnsetCredit.dayCellOptionsUsd ?? 0), 0)),
    // THE MONEY QUESTION. Null unless some live book's equity leg spans its
    // post-onset window without a hole in it. Do NOT read a null here as clean —
    // read `liveOnsetCreditNotMeasuredBooks` for the reason.
    liveOnsetUncreditedOptionsUsd: onsetComparison.length === 0
      ? null
      : round2(onsetComparison.reduce((s, e) => s + (e.postOnsetCredit.uncreditedOptionsUsd ?? 0), 0)),
    liveOnsetCreditNumeratorBookCount: onsetNumerator.length,
    liveOnsetCreditComparisonBookCount: onsetComparison.length,
    // THE SILENCED SET, published. Every live book whose comparison is NOT
    // MEASURED, with the machine-readable reason and the sessions that caused it.
    // This is what a gate must assert is empty before treating any figure above
    // as a verdict; a cohort that shrinks silently is indistinguishable from one
    // that was never there.
    liveOnsetCreditNotMeasuredBooks: liveBooks
      .filter(e => e.postOnsetCredit.uncreditedOptionsUsd == null)
      .map(e => ({
        username: e.username,
        reason: e.postOnsetCredit.notMeasuredReason,
        onsetDate: e.postOnsetCredit.onsetDate,
        leftAnchorDate: e.postOnsetCredit.leftAnchorDate,
        rightAnchorDate: e.postOnsetCredit.rightAnchorDate,
        // TRA-3288 — the operands of `equity-anchor-not-broker-sourced`, so
        // the disqualifier is readable off the live endpoint: which surface
        // each anchor actually sits on, `null` = no basis on the row.
        leftAnchorEquityBasis: e.postOnsetCredit.leftAnchorEquityBasis,
        rightAnchorEquityBasis: e.postOnsetCredit.rightAnchorEquityBasis,
        absentSessions: e.postOnsetCredit.absentSessions,
        journalOptionsUsd: e.postOnsetCredit.journalOptionsUsd,
        dayCellOptionsUsd: e.postOnsetCredit.dayCellOptionsUsd,
      })),
  };
}

/**
 * TRA-2637 (QuantTrader) — **EOD-row presence, folded over the live cohort.**
 *
 * The finding this exists for: on 2026-07-30T02:17:30Z the only `mode: live`
 * book on bqb1 had NO EOD row for 2026-07-29 while its durable journal recorded
 * 6 closes worth +$250.01 — and the endpoint served `drift: 0` for that session.
 * 1 of 47 books was in that state and it was the real-money one, so no firm-wide
 * average could surface it either.
 *
 * ROOT CAUSE, from the prod tape (see TRA-2637 for the full log excerpts): the
 * 21:00-ET archive never ran for 2026-07-29 on ANY book — the pre-TRA-2498 build
 * had already misfired it at **00:00 ET** that morning (`archive trigger fired
 * … etTime:"24:00 ET"`) and persisted `lastArchiveDate: 2026-07-29`, which
 * dedup-suppressed the real evening fire. The live book differs from the 46 demo
 * books only because the report directory is MODE-KEYED: that midnight misfire
 * wrote admin's row to `…/reports/demo/2026-07-29.json` (admin resolved as
 * `mode: demo` on that boot — the TRA-2649 boot-arm instability), while this
 * endpoint reads `…/reports/live/`. So the writer and the reader disagreed about
 * which book they were looking at, and the demo books' misfire write landed in
 * the same directory their reader uses.
 *
 * That makes a mode-scoped presence verdict load-bearing rather than cosmetic: a
 * book whose mode flips between the write and the read loses its row on exactly
 * this axis, and on no other axis this endpoint publishes.
 *
 * TRI-STATE and folded like {@link PnlReconcileResult.stockLegOk} — a red book
 * wins, otherwise one genuinely-measured green is required, all-NOT-MEASURED
 * stays `null`. `liveEodRowBookCount` is the denominator; bqb1 serves an EMPTY
 * live cohort intermittently (TRA-2649), and without the count a `null` there is
 * indistinguishable from a graded pass.
 */
export function summarizeLiveEodRowPresence(
  engines: ReadonlyArray<{
    username: string;
    mode: string;
    eodRowsPresentOk: boolean | null;
    eodRowMissingDates: string[];
    eodRowGradeableCount: number;
    // TRA-2817 — optional so a caller that has not wired the tail calendar yet
    // still type-checks; absent reads as NOT MEASURED, never as current.
    eodTailStaleSessions?: number | null;
    eodTailLatestRowDate?: string | null;
  }>,
): {
  liveEodRowBookCount: number;
  liveEodRowsPresentOk: boolean | null;
  liveEodRowMissingBooks: Array<{
    username: string;
    dates: string[];
    gradeableCount: number;
  }>;
  liveEodTailStaleBooks: Array<{
    username: string;
    latestRowDate: string | null;
    staleSessions: number;
  }>;
  liveEodTailMaxStaleSessions: number | null;
} {
  const liveBooks = engines.filter(e => e.mode === 'live');
  // TRA-2817 — a tail gap produces NO missing dates (the dates were never
  // written, so nothing walks them), so it has to be enumerated on its own list.
  // `liveEodRowMissingBooks: []` alongside `liveEodRowsPresentOk: false` is a
  // legitimate reading now, and it means "the tail, not the interior".
  //
  // TRA-2888 — RETIRED AS AN ACCEPTANCE PREDICATE. The TRA-2829 line
  // "`liveEodTailStaleBooks` is empty" must NOT be graded. It is already true on
  // live and it discriminates nothing: this cohort is `(newestRow,
  // lastSettledSession]`, so when the fleet wrote its 2026-08-04 rows the anchor
  // advanced 07-29 -> 08-04 and the three absent sessions left the cohort. The
  // list went empty by EVICTION, not by repair, and now reads identically on a
  // healthy ledger and on one missing three fleet-wide sessions. Any tail-shaped
  // predicate inherits this — the emptiness is structural, not evidential.
  // Grade the SET OF USERNAMES in `eodInteriorAbsentBooks` (`eod-ledger-gap.ts`)
  // instead: that cohort is enumerated FROM the exchange calendar, so a later row
  // cannot empty it. NOT the fleet boolean `eodInteriorAbsentOk` — TRA-2943
  // retired it as pinned-false (see `EOD_INTERIOR_ABSENT_OK_RETIREMENT`), and not
  // a count either: a count is as dead as the boolean once one book permanently
  // occupies slot one.
  const tailStale = liveBooks
    .filter(e => (e.eodTailStaleSessions ?? 0) > 0)
    .map(e => ({
      username: e.username,
      latestRowDate: e.eodTailLatestRowDate ?? null,
      staleSessions: e.eodTailStaleSessions!,
    }));
  const measuredTails = liveBooks
    .map(e => e.eodTailStaleSessions)
    .filter((n): n is number => typeof n === 'number');
  return {
    liveEodRowBookCount: liveBooks.length,
    liveEodRowsPresentOk: liveBooks.some(e => e.eodRowsPresentOk === false)
      ? false
      : liveBooks.some(e => e.eodRowsPresentOk === true)
        ? true
        : null,
    // Named, not counted: "one live book is missing a row" is not actionable
    // without the dates, and this endpoint already publishes each book's full
    // per-session series under its username.
    liveEodRowMissingBooks: liveBooks
      .filter(e => e.eodRowMissingDates.length > 0)
      .map(e => ({
        username: e.username,
        dates: e.eodRowMissingDates,
        gradeableCount: e.eodRowGradeableCount,
      })),
    liveEodTailStaleBooks: tailStale,
    // `null` on an empty or wholly unmeasured cohort — `0` there is the
    // `every`-on-the-empty-set pass this codebase keeps rediscovering.
    liveEodTailMaxStaleSessions: measuredTails.length === 0 ? null : Math.max(...measuredTails),
  };
}

/**
 * TRA-3517 — fleet fold of the row/report `combinedPnl` agreement over the LIVE
 * cohort.
 *
 * Scoped to live books because only they can carry a broker-shaped row; folding
 * over the whole fleet would bury one graded live book under ~60 structurally
 * not-measured demo books and make the denominator meaningless.
 *
 * Three states, and the denominator travels with them:
 *
 *  - `false` — some live book disagrees. Any disagreement wins outright.
 *  - `true`  — no disagreement AND at least one live book genuinely graded a
 *    session. A green requires a real reading somewhere; it is not reachable by
 *    an empty cohort.
 *  - `null`  — NOT MEASURED. No live book graded anything. This is the state the
 *    axis was in before this ticket, and it is the state a live book sits in
 *    while its rows are engine-shaped or its override is not computing.
 *
 * `liveCombinedAgreementBookCount` is the live denominator and
 * `liveCombinedPnlNoReaderBooks` names the books carrying real-money rows that
 * NOTHING reads — publish both beside any verdict. A `null` with a non-empty
 * no-reader list is materially different from a `null` on an empty live cohort,
 * and the two are indistinguishable from the boolean alone (TRA-2649).
 */
export function summarizeLiveCombinedAgreement(
  engines: ReadonlyArray<{
    username: string;
    mode: string;
    combinedAgreementOk: boolean | null;
    combinedAgreementGradeableCount: number;
    combinedAgreementDiscriminatingCount: number;
    combinedAgreementDisagreeDates: string[];
    combinedAgreementMaxDeltaUsd: number | null;
    combinedPnlNoReaderDates: string[];
  }>,
): {
  liveCombinedAgreementBookCount: number;
  liveCombinedAgreementOk: boolean | null;
  liveCombinedAgreementGradedCount: number;
  liveCombinedAgreementDiscriminatingCount: number;
  liveCombinedAgreementDisagreeBooks: Array<{
    username: string;
    dates: string[];
    maxDeltaUsd: number | null;
  }>;
  liveCombinedAgreementMaxDeltaUsd: number | null;
  liveCombinedPnlNoReaderBooks: Array<{ username: string; dates: string[] }>;
} {
  const liveBooks = engines.filter(e => e.mode === 'live');
  const measuredDeltas = liveBooks
    .map(e => e.combinedAgreementMaxDeltaUsd)
    .filter((n): n is number => typeof n === 'number');
  return {
    liveCombinedAgreementBookCount: liveBooks.length,
    liveCombinedAgreementOk: liveBooks.some(e => e.combinedAgreementOk === false)
      ? false
      : liveBooks.some(e => e.combinedAgreementOk === true)
        ? true
        : null,
    // Sessions, not books: one live book with 40 graded rows and forty books
    // with one each are very different coverage, and the book count alone
    // cannot tell them apart.
    liveCombinedAgreementGradedCount: liveBooks.reduce(
      (n, e) => n + e.combinedAgreementGradeableCount,
      0,
    ),
    // The EVIDENTIAL denominator. Quote this one beside the verdict, not the
    // graded count: the first live read of this axis was `graded 2` over
    // `discriminating 1`, and publishing only the former doubles the apparent
    // coverage of a single real session.
    liveCombinedAgreementDiscriminatingCount: liveBooks.reduce(
      (n, e) => n + e.combinedAgreementDiscriminatingCount,
      0,
    ),
    liveCombinedAgreementDisagreeBooks: liveBooks
      .filter(e => e.combinedAgreementDisagreeDates.length > 0)
      .map(e => ({
        username: e.username,
        dates: e.combinedAgreementDisagreeDates,
        maxDeltaUsd: e.combinedAgreementMaxDeltaUsd,
      })),
    liveCombinedAgreementMaxDeltaUsd:
      measuredDeltas.length === 0 ? null : Math.max(...measuredDeltas),
    liveCombinedPnlNoReaderBooks: liveBooks
      .filter(e => e.combinedPnlNoReaderDates.length > 0)
      .map(e => ({ username: e.username, dates: e.combinedPnlNoReaderDates })),
  };
}

/**
 * TRA-3948 — fleet fold of the BOOKED-`0` STOCK LEG's equity probe over the
 * LIVE cohort: is there a per-session equity move that neither booked leg
 * accounts for?
 *
 * ── Why a new axis rather than a fix to `stockLegDrift` ──────────────────────
 *
 * `stockLegDrift` is `eodStockPnl − stockDaily`; the probe is
 * `closingEquity − openingEquity − optionsDaily − netCashFlow`. DISJOINT
 * operands. `shapeLiveRecordedRow` pins `dailyPnl: 0` on every broker-shaped row
 * and the TRA-219 archive zeroes `eodStockPnl`, so the drift reads `0 − 0`
 * however large the residual is. Read live 2026-08-22T04:42Z, build `0fd3b68`:
 *
 *     admin 2026-08-17  probe −197.36  basis 'zero-probe-disagrees'  drift 0
 *     admin 2026-08-18  probe +196.56  basis 'zero-probe-disagrees'  drift 0
 *     admin 2026-08-20  probe  −71.36  basis 'zero-probe-disagrees'  drift 0
 *     admin 2026-08-21  probe +112.47  basis 'zero-probe-disagrees'  drift 0
 *
 * — $197.36 against a $946.60 book, and `maxStockLegDriftUsd` on the live cohort
 * read `0.00`. Rewriting the drift formula to cover this would destroy the
 * TRA-2630 leg semantics for the demo cohort where it still works; the honest
 * repair is a second axis with its own denominator, which is what this is.
 *
 * ── Scoped LIVE, and the denominator travels with the verdict ────────────────
 *
 * Only live books carry broker-shaped rows; folding over ~65 structurally
 * unprobed demo books would bury one graded live book. The fleet-wide
 * `stockLegOk` demonstrates the cost of not doing this — it reads `false` with
 * `stockLegMeasuredCount: 217` off DEMO rows and is pinned red, so it can
 * neither report nor clear anything about a live probe.
 *
 * ── The green requires a MOVING book ─────────────────────────────────────────
 *
 * `liveStockLegProbeDiscriminatingCount` is the denominator, not
 * `...MeasuredCount`. A dormant book probes `0 − 0 − 0 − 0` and emits
 * `'zero-probe-agrees'` however broken the wiring is. That is not hypothetical:
 * on the same pull, live book `v0nni` sat at 400.00 → 400.00 across all 8 of its
 * probed sessions and contributed 8 clean agreements. Folding those in reports
 * "12 measured, 4 offenders" over what is really 4-of-4 discriminating sessions
 * disagreeing.
 *
 * `null` is NOT MEASURED and must never be reported as clean — with a non-empty
 * `liveStockLegProbeNotMeasuredCount` beside it, it means the probe COULD NOT
 * RUN on real-money rows, which is a coverage hole, not a pass.
 */
export function summarizeLiveStockLegProbe(
  engines: ReadonlyArray<{
    username: string;
    mode: string;
    stockLegProbeOk: boolean | null;
    stockLegProbeMeasuredCount: number;
    stockLegProbeNotMeasuredCount: number;
    stockLegProbeUnstampedCount: number;
    stockLegProbeDiscriminatingCount: number;
    stockLegProbeOffendingDates: string[];
    maxStockLegProbeUsd: number | null;
    stockLegBasisCounts: Record<string, number>;
    // TRA-3954 — optional so pre-existing fixtures keep compiling; an absent
    // field folds as 0 / [] (NOT measured on that book, not clean).
    stockLegProbeMarkDifferencedCount?: number;
    stockLegProbeOffendingWithoutMarkDates?: string[];
    stockLegProbeOvernightReconciledCount?: number;
  }>,
): {
  liveStockLegProbeBookCount: number;
  liveStockLegProbeOk: boolean | null;
  liveStockLegProbeMeasuredCount: number;
  liveStockLegProbeNotMeasuredCount: number;
  liveStockLegProbeUnstampedCount: number;
  liveStockLegProbeDiscriminatingCount: number;
  liveStockLegProbeOffendingBooks: Array<{
    username: string;
    dates: string[];
    maxProbeUsd: number | null;
    /** TRA-3954 — the subset of `dates` whose probe lacks the mark operand. */
    datesWithoutMark: string[];
  }>;
  maxLiveStockLegProbeUsd: number | null;
  liveStockLegBasisCounts: Record<string, number>;
  /**
   * TRA-3954 — measured live rows whose probe subtracted the open-option mark
   * delta. 0 = no live row has yet been written by the four-operand writer.
   */
  liveStockLegProbeMarkDifferencedCount: number;
  /**
   * TRA-3954 — live offenders whose probe LACKS the mark operand. Equal to the
   * total offender count = every live RED is the pre-TRA-3954 MTM-vs-realized
   * reading, none is yet attributable to a missed trade.
   */
  liveStockLegProbeOffendingWithoutMarkCount: number;
  /**
   * TRA-3954 — live discriminating sessions that held an option overnight AND
   * reconciled within tolerance under the four-operand probe. The GREEN branch
   * that had never fired live; 0 beside a green = still unexercised.
   */
  liveStockLegProbeOvernightReconciledCount: number;
} {
  const liveBooks = engines.filter(e => e.mode === 'live');
  const measuredMaxima = liveBooks
    .map(e => e.maxStockLegProbeUsd)
    .filter((n): n is number => typeof n === 'number');
  return {
    liveStockLegProbeBookCount: liveBooks.length,
    liveStockLegProbeOk: liveBooks.some(e => e.stockLegProbeOk === false)
      ? false
      : liveBooks.some(e => e.stockLegProbeOk === true)
        ? true
        : null,
    liveStockLegProbeMeasuredCount: liveBooks.reduce(
      (n, e) => n + e.stockLegProbeMeasuredCount,
      0,
    ),
    liveStockLegProbeNotMeasuredCount: liveBooks.reduce(
      (n, e) => n + e.stockLegProbeNotMeasuredCount,
      0,
    ),
    // Live rows the writer never made a claim about (`admin` 2026-08-04..08-11,
    // `equitySourceEra` = unstamped-pre-tra3349, frozen demo equity). Non-zero
    // beside a green means the axis is speaking about a SUBSET of the live book.
    liveStockLegProbeUnstampedCount: liveBooks.reduce(
      (n, e) => n + e.stockLegProbeUnstampedCount,
      0,
    ),
    liveStockLegProbeDiscriminatingCount: liveBooks.reduce(
      (n, e) => n + e.stockLegProbeDiscriminatingCount,
      0,
    ),
    // Named with dates, not counted. "One live book has a residual" is not
    // actionable without knowing which sessions to reconcile against the broker.
    liveStockLegProbeOffendingBooks: liveBooks
      .filter(e => e.stockLegProbeOffendingDates.length > 0)
      .map(e => ({
        username: e.username,
        dates: e.stockLegProbeOffendingDates,
        maxProbeUsd: e.maxStockLegProbeUsd,
        datesWithoutMark: e.stockLegProbeOffendingWithoutMarkDates ?? [],
      })),
    maxLiveStockLegProbeUsd: measuredMaxima.length === 0 ? null : Math.max(...measuredMaxima),
    liveStockLegProbeMarkDifferencedCount: liveBooks.reduce(
      (n, e) => n + (e.stockLegProbeMarkDifferencedCount ?? 0),
      0,
    ),
    liveStockLegProbeOffendingWithoutMarkCount: liveBooks.reduce(
      (n, e) => n + (e.stockLegProbeOffendingWithoutMarkDates ?? []).length,
      0,
    ),
    liveStockLegProbeOvernightReconciledCount: liveBooks.reduce(
      (n, e) => n + (e.stockLegProbeOvernightReconciledCount ?? 0),
      0,
    ),
    liveStockLegBasisCounts: liveBooks.reduce<Record<string, number>>((acc, e) => {
      for (const [basis, n] of Object.entries(e.stockLegBasisCounts)) {
        acc[basis] = (acc[basis] ?? 0) + n;
      }
      return acc;
    }, {}),
  };
}

/**
 * TRA-2761 — **cohort-membership integrity: is every open live-mode position
 * still inside the live cohort that grades it?**
 *
 * Every `live*` fold above filters `engines` on the READ-TIME mode classifier
 * (`stockModeKey(settings)`), while the option journal's `mode: 'live'` is a
 * WRITE-TIME stamp by the engine that opened the position. Those are two
 * different ledgers, and on 2026-08-02T00:47Z they disagreed in one process:
 * `pnl-reconciliation` resolved all 61 books `mode: 'demo'` while the journal
 * held 10 `mode: 'live'` rows against `admin` — 7 of them OPEN, $1,401.50 at
 * risk. The live cohort emptied, every `live*` verdict above went FALSE → null
 * (NOT MEASURED), and the open real-money positions were outside every
 * live-axis gate with nothing anywhere reading RED.
 *
 * `null` is the correct reading for "no live book exists" — but it is a
 * catastrophically wrong reading for "the live book was reclassified out from
 * under a still-open live position". This fold is what separates them: the
 * journal's open `mode: 'live'` rows are durable evidence that live-mode
 * notional EXISTS, independent of what the read-time classifier serves, so a
 * cohort that empties while such rows persist must be RED, not unmeasured.
 *
 * Tri-state, same precedence discipline as every fold above:
 *   - `false` — some account holds OPEN live-mode journal rows while its engine
 *     is NOT classified `mode: 'live'` (reclassified out — the observer is
 *     blind to real open notional), or open live-mode rows exist that no
 *     current book claims at all (orphaned by identity retirement — worse).
 *   - `true`  — open live-mode rows exist and every holding account is inside
 *     the live cohort. The observer can see everything it must.
 *   - `null`  — the journal census is unavailable (NOT MEASURED), or there are
 *     no open live-mode rows anywhere (nothing to protect; the published
 *     count `0` is what distinguishes this from unmeasured).
 *
 * Sandbox nuance: a book the classifier resolves `'sandbox'` (armed live,
 * Tradier sandbox env) journals `mode: 'demo'` rows in practice (measured
 * 2026-08-04: every journal `mode:'live'` row belongs to the production-armed
 * operator). If a book ever DOES hold open `mode:'live'` rows while resolving
 * `'sandbox'`, that still reads RED here — an open production-era position
 * under a book that has since been pointed at the sandbox is exactly as
 * unobserved as one under a demo reclassification.
 */
export function summarizeLiveCohortIntegrity(
  engines: ReadonlyArray<{
    username: string;
    mode: string;
    openLiveJournalRowCount: number | null;
    openLiveJournalAtRiskUsd: number | null;
  }>,
  opts: {
    journalCensusAvailable: boolean;
    unattributedOpenLiveRowCount: number;
    unattributedOpenLiveAtRiskUsd: number;
  },
): {
  liveOpenJournalRowCount: number | null;
  liveOpenJournalAtRiskUsd: number | null;
  liveOpenJournalUnattributedRowCount: number | null;
  liveCohortReclassifiedBooks: Array<{
    username: string;
    mode: string;
    openLiveJournalRowCount: number;
    openLiveJournalAtRiskUsd: number;
  }> | null;
  liveCohortIntegrityOk: boolean | null;
} {
  if (!opts.journalCensusAvailable) {
    return {
      liveOpenJournalRowCount: null,
      liveOpenJournalAtRiskUsd: null,
      liveOpenJournalUnattributedRowCount: null,
      liveCohortReclassifiedBooks: null,
      liveCohortIntegrityOk: null,
    };
  }
  const holders = engines.filter(e => (e.openLiveJournalRowCount ?? 0) > 0);
  const reclassified = holders
    .filter(e => e.mode !== 'live')
    .map(e => ({
      username: e.username,
      mode: e.mode,
      openLiveJournalRowCount: e.openLiveJournalRowCount ?? 0,
      openLiveJournalAtRiskUsd: round2(e.openLiveJournalAtRiskUsd ?? 0),
    }));
  const attributedCount = holders.reduce((n, e) => n + (e.openLiveJournalRowCount ?? 0), 0);
  const attributedAtRisk = holders.reduce((s, e) => s + (e.openLiveJournalAtRiskUsd ?? 0), 0);
  const totalCount = attributedCount + opts.unattributedOpenLiveRowCount;
  return {
    liveOpenJournalRowCount: totalCount,
    liveOpenJournalAtRiskUsd: round2(attributedAtRisk + opts.unattributedOpenLiveAtRiskUsd),
    liveOpenJournalUnattributedRowCount: opts.unattributedOpenLiveRowCount,
    liveCohortReclassifiedBooks: reclassified,
    liveCohortIntegrityOk:
      reclassified.length > 0 || opts.unattributedOpenLiveRowCount > 0
        ? false
        : totalCount === 0
          ? null
          : true,
  };
}

/**
 * TRA-2302 — fold durable option-trade-journal rows into a per-ET-day close
 * census for ONE book.
 *
 * Only rows that actually CLOSED contribute (`closeTs` present): an OPEN row
 * carries no realized P&L and must not make a day look like it had activity the
 * day-only ledger missed. `account` scoping is the caller's job — pass only the
 * rows belonging to the book being reconciled, or the census will attribute
 * another book's closes to this one (the TRA-2193 pooling trap).
 *
 * `etDate` is injected so this stays pure and testable across timezones; the
 * caller passes the same ET bucketing the EOD report uses.
 */
/**
 * TRA-2817 — the exchange-calendar context the TAIL axis is graded against.
 *
 * Injected rather than imported so this module stays pure and testable, the
 * same discipline `foldJournalClosesByEtDay`'s `etDate` follows. The caller
 * passes the same NYSE calendar the 21:00 ET archive itself runs on, so the two
 * cannot drift into disagreeing about what a session is.
 */
export interface EodTailCalendar {
  /**
   * The most recent NYSE session whose 21:00 ET archive is already PAST — i.e.
   * the newest date a healthy ledger is required to hold a row for.
   *
   * This is deliberately not "the last market day". A read at 16:45 ET on a
   * Tuesday must not accuse the ledger of missing Tuesday: that session's
   * archive is hours away. Grading against the last SETTLED session is what
   * keeps this axis free of a false red every single afternoon — and an axis
   * that cries wolf daily is one nobody reads on the day it is right.
   */
  lastSettledSession: string | null;
  /** Is `YYYY-MM-DD` an NYSE trading day? */
  isMarketDay: (dateIso: string) => boolean;
}

/**
 * TRA-2817 — completed NYSE sessions strictly after `anchor`, through
 * `lastSettledSession` inclusive. `0` means the ledger is current.
 *
 * Counts SESSIONS, not elapsed days, which is the whole point: a Friday row
 * read on a Sunday is current (0), and a Friday row read on the following
 * Wednesday afternoon is 2 sessions stale (Mon + Tue), not 5 days stale. The
 * 2026-08-03 Monday in this incident is a session; the TRA-2764 correction
 * exists because it was once mistaken for a weekend.
 *
 * Returns `null` when either endpoint is absent — NOT MEASURED. A book with no
 * rows at all has no anchor, and inventing `0` for it would hand the empty
 * ledger the cleanest reading on the endpoint.
 */
export function countStaleTailSessions(
  anchor: string | null,
  lastSettledSession: string | null,
  isMarketDay: (dateIso: string) => boolean,
  maxLookaheadDays = 400,
): number | null {
  return staleTailSessions(anchor, lastSettledSession, isMarketDay, maxLookaheadDays)?.length ?? null;
}

/**
 * TRA-2829 — the tail sessions themselves, not just how many there are.
 *
 * {@link countStaleTailSessions} is now `this.length`, deliberately. The
 * back-fill writer needs the DATES and the health axis needs the COUNT, and the
 * two describing different sets is the failure mode that matters here: the
 * ticket that spawned this work framed the hole as "the constant 3", and a
 * writer carrying its own private notion of which sessions are absent would
 * back-fill a set the axis never graded (or vice versa) while both read
 * correct. One enumeration, two consumers — the same shape as
 * `isJournalAuthoritativeSource` (TRA-2641).
 *
 * Returns `null` on the same NOT-MEASURED inputs the count does: a book with no
 * anchor row has no tail, and `[]` there would hand the empty ledger the
 * cleanest reading on the endpoint. `[]` means genuinely current.
 */
export function staleTailSessions(
  anchor: string | null,
  lastSettledSession: string | null,
  isMarketDay: (dateIso: string) => boolean,
  maxLookaheadDays = 400,
): string[] | null {
  if (anchor == null || lastSettledSession == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || !/^\d{4}-\d{2}-\d{2}$/.test(lastSettledSession)) {
    return null;
  }
  if (anchor >= lastSettledSession) return [];
  let t = Date.parse(`${anchor}T00:00:00Z`);
  const end = Date.parse(`${lastSettledSession}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(end)) return null;
  const out: string[] = [];
  // Bounded so a malformed pair cannot spin. A ledger more than `maxLookahead`
  // days behind is already maximally red; the exact count stops mattering.
  for (let i = 0; i < maxLookaheadDays && t < end; i++) {
    t += 86_400_000;
    const iso = new Date(t).toISOString().slice(0, 10);
    if (isMarketDay(iso)) out.push(iso);
  }
  return out;
}

/**
 * Fold journal rows into a per-ET-day census of realized options activity.
 *
 * ── TRA-2895 — why this is not just "bucket by closeTs" ──────────────────────
 *
 * A CLOSE row carries the position's CUMULATIVE realized P&L stamped with the
 * FULL-close timestamp, and the journal writes no close row at all until the
 * position fully closes. So a trade that trimmed at TP1 on Monday and closed on
 * Friday used to fold as: Monday = nothing, Friday = the whole trade. Two
 * defects in one arithmetic:
 *
 *  - Monday's cell had no journal record of a day that DID realize dollars, so
 *    the writer booked `bucket-journal-silent` (or a proven zero) and could
 *    never converge to `journal`;
 *  - Friday's cell was credited with Monday's slice on top of its own, while the
 *    day-only bucket had already booked that slice on Monday — the same dollars
 *    in two day cells, so any multi-day sum over day cells overstated by the
 *    partial.
 *
 * This fold re-dates the slices. Each partial lands on ITS OWN day; the close
 * day gets `realizedPnlUsd − Σ slices`, the residual. Σ over all days is exactly
 * the trade's cumulative P&L — one dollar, one day, no dollar dropped. A legacy
 * row with no `partials` has Σ = 0 and folds byte-identically to the old code,
 * which is what keeps the historical repair reproducible.
 *
 * A partial on a row that never closed still counts: the dollars are realized
 * and spent whether or not the residual position is still open.
 */
export function foldJournalClosesByEtDay(
  rows: ReadonlyArray<{
    closeTs?: number;
    realizedPnlUsd?: number;
    partials?: ReadonlyArray<{ ts: number; realizedPnlUsd: number }>;
  }>,
  etDate: (ts: number) => string,
): Map<string, JournalDayCloses> {
  const byDay = new Map<string, JournalDayCloses>();
  const dayOf = (day: string): JournalDayCloses => {
    const cur = byDay.get(day) ?? { closes: 0, partialCloses: 0, realizedPnlUsd: 0 };
    byDay.set(day, cur);
    return cur;
  };
  for (const r of rows) {
    // TRA-2895 — slices first, and INDEPENDENTLY of whether the trade has closed.
    let sliceTotal = 0;
    for (const p of r.partials ?? []) {
      if (typeof p?.ts !== 'number' || !Number.isFinite(p.ts)) continue;
      if (typeof p.realizedPnlUsd !== 'number' || !Number.isFinite(p.realizedPnlUsd)) continue;
      // Only a slice this fold could actually PLACE on a day is subtracted from
      // the close-day residual. An unplaceable one (no usable ts) is left inside
      // the cumulative figure on the close day rather than deleted from the
      // ledger — losing a real dollar is worse than dating it late.
      sliceTotal += p.realizedPnlUsd;
      const cur = dayOf(etDate(p.ts));
      cur.partialCloses += 1;
      cur.realizedPnlUsd += p.realizedPnlUsd;
    }
    if (typeof r.closeTs !== 'number' || !Number.isFinite(r.closeTs)) continue;
    const cur = dayOf(etDate(r.closeTs));
    cur.closes += 1;
    cur.realizedPnlUsd += (r.realizedPnlUsd ?? 0) - sliceTotal;
  }
  for (const [day, v] of byDay) byDay.set(day, { ...v, realizedPnlUsd: round2(v.realizedPnlUsd) });
  return byDay;
}

/**
 * TRA-2831 — the ET date this book first opened an option in **live** mode, or
 * `null` if it never has.
 *
 * ── Why a mode-blind ledger needs this ───────────────────────────────────────
 *
 * The day-cell options ledger is per-BOOK and MODE-BLIND, deliberately and for
 * good reasons (see `options-daily-pnl-source.ts` — scoping the fold by mode
 * would retroactively DELETE a book's history the moment somebody flips a
 * settings toggle). The live COHORT, by contrast, is defined by the book's
 * CURRENT mode: `engines.filter(e => e.mode === 'live')`, where `mode` is
 * `stockModeKey(await loadSettings(username))` read at request time.
 *
 * Those two facts compose into a silent attribution defect on any book that
 * flipped demo → live mid-series: its ENTIRE pre-flip demo history is folded
 * into every `live*` credit metric, because the fold asks what the book is
 * today and the ledger answers with everything it has ever done.
 *
 * Measured live on bqb1 2026-08-04T22:22Z, book `admin` (the fleet's only live
 * book): `liveUncreditedOptionsUsd` published **733.60** as a live-money
 * shortfall. Its numerator `postBaselineOptionsRealized` = 987.60 is the sum of
 * eleven `journal-repair` day cells dated 2026-07-15 … 2026-07-29 — a window in
 * which admin held no live options at all (its first live position opened
 * 2026-07-30 09:36 ET). Every one of those 987.60 is admin's own DEMO-mode
 * realized options P&L. Proof that the population is demo, straight off the
 * published surface: summing each book's `journal-repair` cells across the whole
 * fleet reproduces the demo-mode fleet total to the cent on every test date —
 * 07-15 → 301.30, 07-17 → 102.00, 07-22 → 4,919.50 — with admin contributing
 * 17.00 / 217.50 / 54.40 of those. The partitions ARE the demo population.
 *
 * ── What this measures, and what it deliberately does not ────────────────────
 *
 * This is the first LIVE OPTION, not the mode flip. The flip timestamp is not
 * persisted anywhere durable, and the option journal is; a book that flipped to
 * live on the 20th and first traded an option on the 30th therefore reads onset
 * 07-30 here. That error is one-directional — it can only mark genuinely-live
 * sessions as pre-onset, i.e. push the verdict toward NOT MEASURED, never toward
 * a false green or a fabricated red. Named `liveOptionsOnsetDate` rather than
 * anything suggesting a mode-change date so no reader mistakes it for one.
 *
 * Keyed on `openTs`, not `closeTs`: the position that PROVES the book was live
 * is the one it opened, and a live position opened on the 30th and closed on the
 * 31st must not date the onset to the 31st.
 */
export function liveOptionsOnsetEtDate(
  rows: ReadonlyArray<{ mode?: string; openTs?: number }>,
  etDate: (ts: number) => string,
): string | null {
  let earliest: string | null = null;
  for (const r of rows) {
    if (r.mode !== 'live') continue;
    if (typeof r.openTs !== 'number' || !Number.isFinite(r.openTs)) continue;
    const day = etDate(r.openTs);
    if (earliest === null || day < earliest) earliest = day;
  }
  return earliest;
}

/**
 * TRA-2919 — why the post-onset credit axis reads NOT MEASURED, when it does.
 *
 * Every one of these can only push the verdict AWAY from a number. There is no
 * value of any of them that manufactures a comparison.
 */
export type PostOnsetCreditNotMeasuredReason =
  /** The book has never opened a live option, so there is no post-onset window. */
  | 'no-live-options-onset'
  /**
   * No option-trade journal to ask. The numerator MUST come from the journal
   * (see {@link summarizePostOnsetLiveCredit}), and `?? 0` here would publish a
   * zero-dollar live numerator for a book whose whole live record is in the file
   * we failed to read — the TRA-2314 false zero, one layer up.
   */
  | 'no-journal-census'
  /** No post-baseline row carries a finite `closingEquity` to anchor on. */
  | 'no-equity-anchor'
  /** Fewer than two anchorable rows, so the equity delta cannot telescope. */
  | 'no-post-anchor-span'
  /** No exchange calendar was supplied, so session ABSENCE has no failing state. */
  | 'no-session-calendar'
  /**
   * TRA-3288 — THE SURFACE GATE. The book is `mode: live` but at least one
   * equity anchor row does not carry `closingEquityBasis:
   * 'broker-eod-balance'` — i.e. the equity leg would grade broker-journal
   * dollars against the DEMO paper book, which on a live book is a preserved
   * constant (live stock fills and live option credits are both refused entry
   * by design). Evaluated with PRECEDENCE OVER the absence gate below: the
   * absence gate is a HOLE gate, right by accident on `admin` only because its
   * left anchor is pinned behind the permanent TRA-2888 gap, and it clears
   * itself the moment a window has full rows — which is exactly what happens
   * on `v0nni`'s first live option close. An ABSENT basis reads as NOT
   * broker-sourced: every historical row has it absent, and absent is not
   * broker.
   */
  | 'equity-anchor-not-broker-sourced'
  /** THE AC2 ARM — an expected session inside the anchor window has no ledger row. */
  | 'equity-anchor-spans-absent-session'
  /**
   * TRA-3288 item 2 — the anchors are broker-sourced and the window has no
   * hole, but some window row's `netCashFlowUsd` is NOT MEASURED. A broker
   * equity delta contains deposits/withdrawals, so subtracting an assumed-zero
   * flow would book a deposit inside the window as uncredited P&L (or a
   * withdrawal as credited). Live books only — a demo book's paper delta has
   * no external flows to net.
   */
  | 'cash-flow-not-measured';

/** TRA-2919 — the post-onset live-credit measurement for ONE book. */
export interface PostOnsetLiveCredit {
  /** {@link PnlReconcileResult.liveOptionsOnsetDate}, echoed so this object stands alone. */
  onsetDate: string | null;
  /** Was there a journal to ask at all? `false` ⇒ `no-journal-census`. */
  journalCensusAvailable: boolean;
  /**
   * Which row the left endpoint of the equity delta came from. `pre-onset-close`
   * is the one that brackets ALL post-onset money; `first-post-onset-close` is
   * the fallback for a book with no pre-onset row, and it necessarily excludes
   * its own session's P&L from the window (the same telescoping rule
   * `postBaselineEquityGrowth` follows).
   */
  anchorBasis: 'pre-onset-close' | 'first-post-onset-close' | null;
  leftAnchorDate: string | null;
  leftAnchorEquity: number | null;
  rightAnchorDate: string | null;
  rightAnchorEquity: number | null;
  /**
   * TRA-3288 — `closingEquityBasis` of each anchor row, echoed so the surface
   * gate's operands are readable off the published object: a reader of
   * `equity-anchor-not-broker-sourced` can see WHICH surface the anchors
   * actually sit on without pulling the ledger. `null` = the row carries no
   * basis (pre-stamp history), which the gate reads as NOT broker-sourced.
   */
  leftAnchorEquityBasis: string | null;
  rightAnchorEquityBasis: string | null;
  /** Sessions the exchange calendar expects inside `(leftAnchor, rightAnchor]`. */
  windowSessions: number | null;
  /** Ledger rows this book actually holds inside that window. */
  windowRowDates: string[];
  /**
   * THE DISQUALIFIER. Expected sessions in the window with NO ledger row —
   * enumerated from the calendar and diffed against the rows, because you cannot
   * discover a missing session by iterating the sessions you have. `null` when
   * there was no calendar to enumerate from; `[]` is the passing state.
   */
  absentSessions: string[] | null;
  /**
   * THE NUMERATOR, sourced from the option-trade JOURNAL. `null` = NOT MEASURED.
   */
  journalOptionsUsd: number | null;
  /**
   * THE FOIL — the same window summed from `optionsDaily` DAY CELLS instead.
   * Published, never used, and that is the entire point: it is the number the
   * obvious fix would have shipped, so the reason this was not built that way is
   * readable off the live surface and not only out of TRA-2919. On `admin` at the
   * time of writing the two read +739.00 (journal) against −2.00 (day cells).
   */
  dayCellOptionsUsd: number | null;
  stockDailyUsd: number | null;
  equityGrowthUsd: number | null;
  /**
   * TRA-3288 item 2 — Σ `netCashFlowUsd` over the window rows, i.e. the broker
   * cash flow the equity delta absorbed that is NOT P&L. Computed (and
   * required) only on the live broker-anchored path; `null` elsewhere and
   * whenever any window row's flow is NOT MEASURED — in which case the
   * comparison is refused with `cash-flow-not-measured` rather than assuming 0.
   */
  windowNetCashFlowUsd: number | null;
  /**
   * THE COMPARISON: `journalOptionsUsd + stockDailyUsd − equityGrowthUsd`, i.e.
   * how much post-onset LIVE realized P&L never reached NAV. `null` whenever
   * {@link notMeasuredReason} is set — in particular whenever the equity anchor
   * spans a session with no row, because the equity leg is then missing exactly
   * the window the numerator covers and the subtraction is meaningless.
   *
   * TRA-3288 item 2 — on the live broker-anchored path the equity term is
   * netted of {@link windowNetCashFlowUsd} first
   * (`journal + stock − (equityGrowth − flow)`), and the comparison is refused
   * outright when any window flow is unmeasured.
   */
  uncreditedOptionsUsd: number | null;
  notMeasuredReason: PostOnsetCreditNotMeasuredReason | null;
  /**
   * Per-date decomposition for every date in the window carrying money on
   * EITHER leg. This is what makes the numerator auditable: the +739.00 lives on
   * a date with `hasLedgerRow: false`, so it appears on no `days[]` row and is
   * invisible on every other field this endpoint publishes.
   */
  legs: Array<{
    date: string;
    journalOptionsUsd: number;
    journalCloses: number;
    journalPartialCloses: number;
    /** `null` when this date has no ledger row at all — the hole, per date. */
    dayCellOptionsUsd: number | null;
    hasLedgerRow: boolean;
  }>;
}

/**
 * TRA-2919 (CFO) — **the live credit axis, re-sourced from the JOURNAL.**
 *
 * ── Why the day cells cannot carry this ──────────────────────────────────────
 *
 * TRA-2831 correctly stopped publishing `liveUncreditedOptionsUsd` as live
 * money: its numerator `postBaselineOptionsRealized` was 987.60 of `admin`'s own
 * DEMO-mode option P&L, booked 2026-07-15 … 07-29, folded into the live cohort
 * because the cohort is keyed on the book's mode TODAY while the ledger under it
 * is mode-blind for all time. The gate it installed keys on
 * `optionsRealizedBeforeLiveOnsetUsd > 0`, and that figure is DURABLE HISTORY —
 * it does not age out. So the axis went null and, without this, stays null
 * forever on the only book that carries real capital. TRA-2630 had named this
 * axis as the INDEPENDENT signal to grade after `optionsLegOk` became
 * self-confirming, so the replacement signal was dead on arrival.
 *
 * The natural repair is to scope the existing numerator to post-onset dates.
 * DO NOT. Measured on bqb1 2026-08-05, `admin` had exactly ONE post-onset day
 * cell — 2026-08-04, `optionsDaily −2.00`, source `bucket-journal-silent`,
 * `journalOptionsPnl 0`. Σ post-onset `optionsDaily` = **−2.00**, while the live
 * book actually realized **+739.00** on 2026-07-31 across 3 journal closes. That
 * money is booked to NO day cell at all: 07-30 / 07-31 / 08-03 are the permanent
 * TRA-2888 hole (never captured, back-fill REFUSED, `ENABLE_EOD_ROW_BACKFILL`
 * stays false — no writer will ever create those rows). A day-cell-sourced
 * post-onset numerator therefore publishes −2.00 against a real +739.00 and
 * carries `gradeable: true`. A wrong number that LOOKS gradeable is strictly
 * worse than the honest null it replaced. `dayCellOptionsUsd` publishes that
 * −2.00 beside the real figure precisely so this stays visible.
 *
 * The journal is append-only, survived the ENOSPC window intact (`corruptLines
 * 0`) and is keyed by CLOSE timestamp, not by the existence of a snapshot row —
 * so it holds the 07-31 closes the ledger lost. It is the only surviving source.
 *
 * ── Why the journal leg alone must not manufacture a verdict ─────────────────
 *
 * The EQUITY leg has a hole over the same window, and it is the subtrahend. The
 * comparison telescopes `closingEquity[right] − closingEquity[left]`, so an
 * absent session inside `(left, right]` means the equity delta and the numerator
 * cover different spans — on `admin`, the delta 07-29 → 08-04 also silently
 * absorbs whatever happened on three sessions nobody recorded. Publishing a
 * number there would be the same fabrication in the other operand. Hence
 * `equity-anchor-spans-absent-session`, and hence the anchor window is diffed
 * against the CALENDAR rather than against the three known gap dates: a
 * hard-coded date list goes green by EVICTION the moment a newer row advances
 * past it (exactly how TRA-2888 retired `liveEodTailStaleBooks`) and is blind to
 * the next hole. This predicate cannot be emptied by a later row.
 *
 * Note the composition: absence is checked over the WHOLE window, which also
 * covers the gap between `leftAnchor` and the onset. It has to — if an expected
 * session sat between them it could not hold a row (or it would BE `leftAnchor`,
 * which is the LAST row before the onset), so a numerator floored at the onset
 * against a delta anchored earlier is precisely the apples-to-oranges case, and
 * one predicate fails it closed.
 *
 * ── TRA-3288: why absence of holes is still not enough ──────────────────────
 *
 * The absence gate above is a HOLE gate, and on a live book it is right by
 * accident. `closingEquity` on every RECORDED row is the PaperAccount — the
 * demo paper book — written unconditionally at the 21:00 ET archive, and on a
 * live book that number cannot move: live stock fills are refused by the
 * `setSettings` live early-return and live option credits by
 * `bindOptionsPnlToEquityBook`'s non-demo refusal. So a hole-free window over
 * recorded rows subtracts a demo constant from a demo constant and calls the
 * result the equity leg of a LIVE credit comparison — on `v0nni` (every row a
 * flat 25,000.00 demo seed) the first live close would have published the
 * entire journal numerator, verbatim, as money that never reached NAV. Hence
 * the surface gate: a live book's comparison is refused with
 * `equity-anchor-not-broker-sourced`, with precedence over the absence reason,
 * unless BOTH anchor rows carry `closingEquityBasis: 'broker-eod-balance'`.
 * Absent basis is NOT broker (every pre-TRA-3288 row has it absent), and the
 * check is an allow-list on the one broker value so no future basis string can
 * open it by default.
 *
 * Pure and calendar-injected, the same discipline the rest of this module keeps.
 */
export function summarizePostOnsetLiveCredit(args: {
  /** Post-baseline rows only, in any order. */
  rows: ReadonlyArray<{
    date: string;
    optionsDaily: number;
    stockDaily: number;
    closingEquity: number | null;
    /**
     * TRA-3288 — `closingEquityBasis` off the row. Absent/`null` reads as NOT
     * broker-sourced; see the surface gate below.
     */
    closingEquityBasis?: string | null;
    /**
     * TRA-3288 item 2 — the row's broker cash flow. Absent/`null` reads NOT
     * MEASURED and refuses the live comparison (`cash-flow-not-measured`).
     */
    netCashFlowUsd?: number | null;
  }>;
  liveOptionsOnsetDate: string | null;
  /** `null` = there was no journal to ask, which is NOT a zero numerator. */
  journalClosesByDate: ReadonlyMap<string, JournalDayCloses> | null;
  calendar: EodTailCalendar | null;
  /**
   * TRA-3288 — the book's read-time mode (`stockModeKey`: 'demo' | 'live' |
   * 'sandbox'). REQUIRED, not defaulted, because this is the operand that arms
   * the surface gate and a caller that could silently omit it would ship a
   * live book graded on demo anchors — the defect this gate exists to refuse.
   * `null` means "mode unknown", which does NOT arm the gate: arming it on
   * unknown would put every demo book (whose rows will never carry a broker
   * basis) into permanent NOT MEASURED the moment a caller loses the mode.
   * The production caller passes the TRA-2761-hardened `loadSettings` mode.
   */
  bookMode: string | null;
}): PostOnsetLiveCredit {
  const { rows, liveOptionsOnsetDate: onset, journalClosesByDate: census, calendar, bookMode } = args;
  const base: PostOnsetLiveCredit = {
    onsetDate: onset,
    journalCensusAvailable: census != null,
    anchorBasis: null,
    leftAnchorDate: null,
    leftAnchorEquity: null,
    rightAnchorDate: null,
    rightAnchorEquity: null,
    leftAnchorEquityBasis: null,
    rightAnchorEquityBasis: null,
    windowSessions: null,
    windowRowDates: [],
    absentSessions: null,
    journalOptionsUsd: null,
    dayCellOptionsUsd: null,
    stockDailyUsd: null,
    equityGrowthUsd: null,
    windowNetCashFlowUsd: null,
    uncreditedOptionsUsd: null,
    notMeasuredReason: null,
    legs: [],
  };
  if (onset == null) return { ...base, notMeasuredReason: 'no-live-options-onset' };
  // Ordered here rather than trusted from the caller: every endpoint that will
  // read this sorts its own rows, and a mis-ordered series would pick the wrong
  // anchors silently.
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const anchorable = sorted.filter(d => d.closingEquity !== null && Number.isFinite(d.closingEquity));
  if (anchorable.length === 0) return { ...base, notMeasuredReason: 'no-equity-anchor' };
  const preOnset = anchorable.filter(d => d.date < onset);
  const postOnset = anchorable.filter(d => d.date >= onset);
  const left = preOnset.length > 0
    ? preOnset[preOnset.length - 1]!
    : postOnset.length >= 2 ? postOnset[0]! : null;
  const right = preOnset.length > 0
    ? (postOnset.length > 0 ? postOnset[postOnset.length - 1]! : null)
    : postOnset.length >= 2 ? postOnset[postOnset.length - 1]! : null;
  if (left === null || right === null || right.date <= left.date) {
    return { ...base, notMeasuredReason: 'no-post-anchor-span' };
  }
  const anchorBasis = preOnset.length > 0 ? 'pre-onset-close' as const : 'first-post-onset-close' as const;
  const anchored = {
    ...base,
    anchorBasis,
    leftAnchorDate: left.date,
    leftAnchorEquity: round2(left.closingEquity as number),
    rightAnchorDate: right.date,
    rightAnchorEquity: round2(right.closingEquity as number),
    leftAnchorEquityBasis: left.closingEquityBasis ?? null,
    rightAnchorEquityBasis: right.closingEquityBasis ?? null,
    equityGrowthUsd: round2((right.closingEquity as number) - (left.closingEquity as number)),
  };
  // TRA-3288 — THE SURFACE GATE, armed here (the moment the anchors exist) and
  // returned below with precedence over BOTH calendar availability and the
  // absence gate. On a live book the recorded rows' `closingEquity` is the
  // preserved DEMO paper book — a constant that no live fill or option credit
  // can move — so an equity delta over non-broker anchors grades broker-journal
  // dollars against demo-book dollars no matter how hole-free the window is.
  // The check is an allow-list on the ONE broker value, never a deny-list:
  // absent, `'engine-paper-account'`, `'not-measured'` and every future
  // non-broker basis all fail it closed. The return sits AFTER the journal
  // computation so the numerator (TRA-2919's attribution axis) stays published
  // for a gated book — the gate kills the COMPARISON, not the attribution.
  const anchorsNotBrokerSourced = bookMode === 'live'
    && !(left.closingEquityBasis === CLOSING_EQUITY_BASIS_BROKER
      && right.closingEquityBasis === CLOSING_EQUITY_BASIS_BROKER);
  // A date contributes to the window iff it is strictly after the left anchor
  // (telescoping: the anchor's own session landed in a delta whose left endpoint
  // is outside the series), at or after the onset (attribution: nothing pre-onset
  // may enter the numerator, ever), and at or before the right anchor.
  const inWindow = (d: string): boolean => d > left.date && d >= onset && d <= right.date;
  const windowRows = sorted.filter(d => inWindow(d.date));
  const windowRowDates = windowRows.map(d => d.date);
  const rowByDate = new Map(windowRows.map(d => [d.date, d] as const));
  const withRows = {
    ...anchored,
    windowRowDates,
    stockDailyUsd: round2(windowRows.reduce((s, d) => s + d.stockDaily, 0)),
    dayCellOptionsUsd: round2(windowRows.reduce((s, d) => s + d.optionsDaily, 0)),
  };
  if (census == null) return { ...withRows, notMeasuredReason: 'no-journal-census' };
  const journalUsd = round2(
    [...census.entries()]
      .filter(([date]) => inWindow(date))
      .reduce((s, [, v]) => s + v.realizedPnlUsd, 0),
  );
  // Every date in the window carrying money on EITHER leg, journal-first. A date
  // with journal money and no row is the hole; a date with a row and no journal
  // money is a cell the journal does not support (`admin` 2026-08-05 booked
  // −424.00 from the volatile bucket against zero journal closes). Both are
  // findings, and neither is visible from a single total.
  const legDates = [...new Set([
    ...[...census.keys()].filter(d => inWindow(d)
      && Math.abs(census.get(d)!.realizedPnlUsd) > PNL_RECONCILE_TOLERANCE_USD),
    ...windowRows
      .filter(d => Math.abs(d.optionsDaily) > PNL_RECONCILE_TOLERANCE_USD)
      .map(d => d.date),
  ])].sort();
  const withJournal = {
    ...withRows,
    journalOptionsUsd: journalUsd,
    legs: legDates.map(date => {
      const c = census.get(date) ?? null;
      const row = rowByDate.get(date) ?? null;
      return {
        date,
        journalOptionsUsd: round2(c?.realizedPnlUsd ?? 0),
        journalCloses: c?.closes ?? 0,
        journalPartialCloses: c?.partialCloses ?? 0,
        dayCellOptionsUsd: row === null ? null : round2(row.optionsDaily),
        hasLedgerRow: row !== null,
      };
    }),
  };
  if (calendar == null) {
    // TRA-3288 — even with no calendar the surface verdict is already known,
    // and it is the more fundamental disqualifier: a calendar can be supplied
    // later, at which point a live book on demo anchors must NOT degrade to
    // the self-clearing absence reason on its way to a publish.
    if (anchorsNotBrokerSourced) {
      return { ...withJournal, notMeasuredReason: 'equity-anchor-not-broker-sourced' };
    }
    return { ...withJournal, notMeasuredReason: 'no-session-calendar' };
  }
  const expected = sessionsInRange(left.date, right.date, calendar.isMarketDay)
    .filter(d => d > left.date);
  const present = new Set(windowRowDates);
  const absentSessions = expected.filter(d => !present.has(d));
  const measured = {
    ...withJournal,
    windowSessions: expected.length,
    absentSessions,
  };
  // TRA-3288 — surface gate BEFORE the absence gate, deliberately. The absence
  // check below is a HOLE gate: it clears itself the moment a window has full
  // rows, which is precisely the v0nni geometry (first live close ⇒ a
  // one-session window with one row ⇒ `absentSessions: []` ⇒ the whole journal
  // numerator publishes as uncredited live money on the next 21:00 ET
  // archive). A gate that happens to be closed is not a gate, so the published
  // reason must name the real disqualifier. `absentSessions` is still computed
  // and published above — the ORDER of the reasons changes, not the evidence.
  if (anchorsNotBrokerSourced) {
    return { ...measured, notMeasuredReason: 'equity-anchor-not-broker-sourced' };
  }
  if (absentSessions.length > 0) {
    return { ...measured, notMeasuredReason: 'equity-anchor-spans-absent-session' };
  }
  // TRA-3288 item 2 — THE CASH-FLOW LEG, live books only. Reached only past
  // the surface gate, so both anchors are broker-sourced and the equity delta
  // is a broker delta — which contains deposits and withdrawals. Each broker
  // row carries `netCashFlowUsd` over the span its own equity delta covers,
  // and with a hole-free window those spans tile `(leftAnchor, rightAnchor]`
  // exactly (a row whose broker balance was unmeasured breaks the tiling, but
  // such a row cannot be inside this path: its flow is null and fails here
  // first). ANY unmeasured flow refuses the comparison — 0 is an assumption, a
  // deposit read as uncredited P&L — and the sum is published beside the raw
  // growth so a reader can re-derive the netting.
  if (bookMode === 'live') {
    const flows = windowRows.map(d =>
      typeof d.netCashFlowUsd === 'number' && Number.isFinite(d.netCashFlowUsd)
        ? d.netCashFlowUsd
        : null);
    if (flows.some(f => f === null)) {
      return { ...measured, notMeasuredReason: 'cash-flow-not-measured' };
    }
    const windowNetCashFlowUsd = round2(flows.reduce<number>((s, f) => s + (f as number), 0));
    return {
      ...measured,
      windowNetCashFlowUsd,
      uncreditedOptionsUsd: round2(
        journalUsd + (measured.stockDailyUsd ?? 0)
        - ((measured.equityGrowthUsd ?? 0) - windowNetCashFlowUsd),
      ),
    };
  }
  return {
    ...measured,
    uncreditedOptionsUsd: round2(
      journalUsd + (measured.stockDailyUsd ?? 0) - (measured.equityGrowthUsd ?? 0),
    ),
  };
}

/**
 * Reconcile the EOD combined P&L against the stock-only + day-only-options
 * decomposition for every day that has a persisted snapshot. A snapshot with no
 * matching EOD report file contributes a row with `eodCombined: null` and a
 * `drift` of 0 (nothing to compare — absence is not a mismatch).
 *
 * TRA-1636 — `baselineDate` (inclusive ET `YYYY-MM-DD`) is a data-integrity
 * cutoff: rows with `date < baselineDate` were written by the pre-fix (buggy)
 * TRA-1633 code and would keep the guard permanently red on stale legacy drift.
 * They are still returned (flagged `belowBaseline`) for transparency but never
 * contribute to `ok` / `offendingDates` / `maxDriftUsd`. Pass `null` to evaluate
 * every day (the historical behaviour).
 */
export function reconcilePnl(
  snapshots: ReadonlyArray<DailySnapshot>,
  eodCombinedByDate: ReadonlyMap<string, number>,
  baselineDate: string | null = null,
  journalClosesByDate: ReadonlyMap<string, JournalDayCloses> | null = null,
  eodOptionsByDate: ReadonlyMap<string, number> | null = null,
  eodStockByDate: ReadonlyMap<string, number> | null = null,
  // TRA-2817 — the TAIL axis. Optional and defaulting to `null` so every
  // existing caller keeps compiling; a caller that passes nothing gets
  // `eodTailStaleSessions: null` (NOT MEASURED), never a fabricated `0`.
  tailCalendar: EodTailCalendar | null = null,
  // TRA-2831 — the book's live-options onset (see `liveOptionsOnsetEtDate`).
  // Optional and defaulting to `null` so every existing caller keeps compiling.
  // A caller that passes nothing gets `optionsRealizedBeforeLiveOnsetUsd` equal
  // to the whole numerator, which reads as "none of this is provably live" —
  // the safe direction. There is no default that fabricates a clean attribution.
  liveOptionsOnsetDate: string | null = null,
  // TRA-3288 — the book's read-time mode, for the post-onset SURFACE GATE.
  // Optional so every existing caller keeps compiling, and `null` (= unknown)
  // does NOT arm the gate — arming on unknown would send every demo book
  // permanently NOT MEASURED (demo rows never carry a broker basis). That makes
  // omission fail-OPEN on a live book, so the production endpoint passes the
  // TRA-2761-hardened `loadSettings` mode; see `summarizePostOnsetLiveCredit`,
  // where the same field is deliberately REQUIRED.
  bookMode: string | null = null,
  // TRA-3517 — date → the EOD report file's `pnlSource`, which is the ONLY way
  // to tell a cell the TRA-359 override wrote from a cell carrying the engine
  // figure. Optional and defaulting to `null` so every existing caller keeps
  // compiling; a caller that passes nothing grades NOTHING on the agreement axis
  // (every row reads `'override-not-computed'`), which is the safe direction —
  // omission cannot manufacture a green.
  eodPnlSourceByDate: ReadonlyMap<string, string> | null = null,
): PnlReconcileResult {
  const days: PnlReconcileDay[] = [...snapshots]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(s => {
      const stockDaily = round2(s.dailyPnl);
      // TRA-3043 — the anchor and its provenance, straight off the row. Both
      // pass through NOT-MEASURED rather than defaulting: `?? 0` on the anchor
      // would publish a flat-broke opening for every TRA-2829 back-filled row,
      // and `?? 'prior-session-close'` on the basis would manufacture the exact
      // declaration the field exists to withhold.
      const openingEquity = Number.isFinite(s.openingEquity as number)
        ? round2(s.openingEquity as number)
        : null;
      const openingEquityBasis = typeof s.openingEquityBasis === 'string' && s.openingEquityBasis !== ''
        ? s.openingEquityBasis
        : null;
      const optionsFieldPresent = s.optionsDailyPnl !== undefined && s.optionsDailyPnl !== null;
      const optionsDaily = round2(s.optionsDailyPnl ?? 0);
      const eodCombined = eodCombinedByDate.has(s.date)
        ? round2(eodCombinedByDate.get(s.date)!)
        : null;
      // TRA-2637 — ABSENT stays null. `0` here made a session with no EOD report
      // read bit-identical to a session that reconciled to the cent.
      // TRA-3288 item 2 — the drift identity is NOT CLAIMABLE on a broker-shaped
      // row. `drift` grades `eodCombined == stockDaily + optionsDaily`, a
      // decomposition of the ENGINE book; a live broker row deliberately books
      // `dailyPnl: 0` (stock leg made falsifiable via `stockLegProbeUsd`, not
      // measured) and carries the broker day P&L in `combinedPnl`, so the legs
      // do not — and must not — sum to the broker figure. Grading it would flag
      // every live session as an offender for agreeing with the broker. `null`
      // here is NOT MEASURED (the same value an absent report reads), never a
      // pass, and the row's `closingEquityBasis` says why.
      const rowBrokerShaped =
        typeof s.closingEquityBasis === 'string'
        && s.closingEquityBasis === CLOSING_EQUITY_BASIS_BROKER;
      const drift = eodCombined == null || rowBrokerShaped
        ? null
        : round2(eodCombined - (stockDaily + optionsDaily));
      // TRA-3517 — the reader that REPLACES `drift` on the rows the line above
      // just suppressed. Ordered so the reason names the FIRST leg that is
      // missing, and so `'row-not-broker-shaped'` (an abstention, because
      // `drift` covers that row) is distinguishable from the three that are
      // genuine coverage holes.
      const rowCombinedPnl =
        typeof s.combinedPnl === 'number' && Number.isFinite(s.combinedPnl)
          ? round2(s.combinedPnl)
          : null;
      const eodPnlSource = eodPnlSourceByDate?.get(s.date) ?? null;
      const combinedAgreementReason: CombinedAgreementNotMeasuredReason | null =
        !rowBrokerShaped
          ? 'row-not-broker-shaped'
          : rowCombinedPnl === null
            ? 'row-combined-absent'
            : eodCombined === null
              ? 'no-report-row'
              : eodPnlSource !== EOD_PNL_SOURCE_BROKER_OVERRIDE
                ? 'override-not-computed'
                : null;
      // The delta stays `null` on an ungraded row. `0` there is byte-identical
      // to a perfect agreement, which is the exact collapse TRA-2637 fixed on
      // `drift` — and this axis exists precisely because `drift` abstains here,
      // so it has no second reader to catch the mistake.
      const combinedAgreementDeltaUsd =
        combinedAgreementReason === null ? round2(rowCombinedPnl! - eodCombined!) : null;
      const combinedAgreement: CombinedAgreementState =
        combinedAgreementReason !== null
          ? 'not-measured'
          : Math.abs(combinedAgreementDeltaUsd!) > PNL_RECONCILE_TOLERANCE_USD
            ? 'disagree'
            : 'agree';
      // Both readers abstained on a real-money row: `drift` for broker shape,
      // the agreement axis for a missing leg. Nothing observes `combinedPnl`
      // here at all.
      const combinedPnlHasNoReader =
        rowBrokerShaped && combinedAgreement === 'not-measured';
      // Could this session have read `disagree`? Both sides at 0.00 emit `agree`
      // however broken the wiring is, so it has no failing state and must not
      // fund the verdict. It stays published as the measurement it is.
      const combinedAgreementDiscriminating =
        combinedAgreementReason === null
        && (Math.abs(rowCombinedPnl!) > PNL_RECONCILE_TOLERANCE_USD
          || Math.abs(eodCombined!) > PNL_RECONCILE_TOLERANCE_USD);
      const belowBaseline = baselineDate != null && s.date < baselineDate;
      // TRA-2302 — a day is only claimed as a FALSE zero when a census exists
      // for this book AND it names closes the day-only ledger did not receive.
      // No census ⇒ null / false, never an implied zero.
      const census = journalClosesByDate?.get(s.date) ?? null;
      const journalCloses = journalClosesByDate == null ? null : (census?.closes ?? 0);
      // TRA-2895 — the partial-exit leg of the same census, on its own axis. A
      // day can carry realized dollars with `journalCloses: 0`; without this
      // field that row reads as "the journal recorded nothing here" while the
      // writer treats it as journal-authoritative, and the two surfaces would
      // disagree about the same census with no way to see why.
      const journalPartialCloses = journalClosesByDate == null ? null : (census?.partialCloses ?? 0);
      const journalOptionsPnl =
        journalClosesByDate == null ? null : round2(census?.realizedPnlUsd ?? 0);
      // TRA-3864 — the one INDEPENDENT comparison available on this row, finally
      // subtracted. Gated on journal authority, because on a `bucket-*` row the
      // report file is the better record and a non-zero difference there is not
      // an accusation. `null` = NOT MEASURED, never 0 (TRA-2637 / TRA-3517).
      const journalOptionsPnlDeltaUsd =
        isJournalAuthoritativeSource(s.optionsDailyPnlSource) && journalOptionsPnl !== null
          ? round2(optionsDaily - journalOptionsPnl)
          : null;
      // Threshold is HALF a cent, deliberately NOT `PNL_RECONCILE_TOLERANCE_USD`
      // (1c). Both operands are already `round2`-ed, so the smallest disagreement
      // this axis can ever express IS one cent — and `> 0.01` would therefore
      // have no failing state at the boundary, silencing exactly the one-cent
      // restatement deltas TRA-3730's cohort is made of. Same predicate QA filed
      // the repro with (`abs(...) >= 0.005`), so the published set and the
      // hand-run set are the same set by construction.
      const optionsDailySupersededByJournal =
        journalOptionsPnlDeltaUsd !== null && Math.abs(journalOptionsPnlDeltaUsd) >= 0.005;
      // TRA-2642 (found grading TRA-2625) — a day whose closes net EXACTLY $0.00
      // books 0.00 correctly: the snapshot and the journal AGREE, and agreement at
      // zero is not a false zero. Without the `journalOptionsPnl !== 0` term such a
      // day is flagged forever — the repair cannot clear it either, because moving
      // 0 → 0 is not a move (`planOptionsDailyPnlRepair`) — so `optionsFalseZeroOk`
      // has no passing state at all. Live proof: `ctoverify_tra2227` /
      // `ctoverify_tra2329` held `falseZeroDates:['2026-07-27']` while the repair
      // re-ran `0.00->0.00` on 34 consecutive boots. The day stays fully visible via
      // `journalCloses` / `journalOptionsPnl` on the row; only the accusation goes.
      // TRA-2895 — count PARTIAL exits too, via the shared predicate. A day
      // whose only options activity was a trim realizes real dollars the day
      // cell can still miss, and grading only `closes` left that whole class
      // outside the accusation the flag exists to make.
      const optionsFalseZero =
        journalRealizingEvents(census) > 0 && optionsDaily === 0 && (journalOptionsPnl ?? 0) !== 0;
      // TRA-2630 — the two legs `drift` pools, each on its own axis. Absence is
      // not a mismatch on either (same rule `drift` applies to `eodCombined`),
      // so a missing report leg scores 0 rather than accusing the snapshot.
      const eodStockPnl = eodStockByDate?.has(s.date)
        ? round2(eodStockByDate.get(s.date)!)
        : null;
      const eodOptionsPnl = eodOptionsByDate?.has(s.date)
        ? round2(eodOptionsByDate.get(s.date)!)
        : null;
      // TRA-2635 — ABSENT stays null. `?? 0` here would make "the writer never
      // recorded a credit" and "the credit was 0" the same value, which is the
      // exact ambiguity this field is being added to resolve.
      const optionsCreditedCumulative =
        s.optionsCreditedCumulative !== undefined && s.optionsCreditedCumulative !== null
          ? round2(s.optionsCreditedCumulative)
          : null;
      return {
        date: s.date,
        eodCombined,
        stockDaily,
        openingEquity,
        openingEquityBasis,
        optionsDaily,
        eodStockPnl,
        stockLegDrift: eodStockPnl == null ? 0 : round2(eodStockPnl - stockDaily),
        optionsLegDrift: eodOptionsPnl == null ? 0 : round2(eodOptionsPnl - optionsDaily),
        // Filled in by the second pass below — it needs the PRIOR row, which is
        // not available inside this per-row map.
        lagsPriorOptionsDaily: false,
        // TRA-2630 AC2 — both are filled in by the second pass below; it needs
        // the PRIOR row. Session 0 has no prior, so it stays ineligible.
        priorOptionsLagEligible: false,
        // TRA-2835 — null until the pairing pass runs; days[0] has no predecessor.
        priorSessionAdjacent: null,
        optionsFieldPresent,
        journalCloses,
        journalPartialCloses,
        journalOptionsPnl,
        journalOptionsPnlDeltaUsd,
        optionsDailySupersededByJournal,
        optionsFalseZero,
        eodOptionsPnl,
        optionsDailyPnlSource: s.optionsDailyPnlSource ?? null,
        optionsDailyPnlBucket:
          s.optionsDailyPnlBucket !== undefined && s.optionsDailyPnlBucket !== null
            ? round2(s.optionsDailyPnlBucket)
            : null,
        // TRA-2829 — pass an unmeasured anchor through as `null`. `round2(null)`
        // is 0, and a $0 closing equity on a live book reads as a total wipeout.
        closingEquity:
          s.closingEquity !== null && Number.isFinite(s.closingEquity)
            ? round2(s.closingEquity)
            : null,
        // TRA-3288 — the provenance travels WITH the number it qualifies.
        // Absent/empty passes through as `null` (NOT MEASURED, which downstream
        // must read as not-broker), the same rule `openingEquityBasis` follows.
        closingEquityBasis:
          typeof s.closingEquityBasis === 'string' && s.closingEquityBasis !== ''
            ? s.closingEquityBasis
            : null,
        // TRA-3589 — the SAME fact, rendered so it is never absent. This is the
        // one field on the row that a null-tolerant reader cannot mistake for
        // "not applicable"; see {@link PnlDayRow.equitySourceEra}.
        equitySourceEra: equitySourceEraOf(s.closingEquityBasis),
        // TRA-3288 item 2 — absent reads `null` (NOT MEASURED), the same rule
        // as every other flow-through here. `round2(null)` would be 0, and an
        // assumed-zero cash flow books a deposit as P&L.
        netCashFlowUsd:
          typeof s.netCashFlowUsd === 'number' && Number.isFinite(s.netCashFlowUsd)
            ? round2(s.netCashFlowUsd)
            : null,
        // TRA-3517 — the booked-`0` stock leg's own falsifier, straight off the
        // row. Absent/empty passes through as `null` (NOT MEASURED), the same
        // rule every other basis string here follows; a `?? 'inert'` default
        // would manufacture the declaration the field exists to withhold.
        stockLegBasis:
          typeof s.stockLegBasis === 'string' && s.stockLegBasis !== ''
            ? s.stockLegBasis
            : null,
        // `round2(null)` is 0, and a $0 probe is the PASSING state ("the stock
        // leg really was inert") — the one value an unmeasured probe must never
        // be allowed to render as.
        stockLegProbeUsd:
          typeof s.stockLegProbeUsd === 'number' && Number.isFinite(s.stockLegProbeUsd)
            ? round2(s.stockLegProbeUsd)
            : null,
        // TRA-3954 — the mark operands, same null discipline: a `0` here is the
        // "nothing open / nothing moved" reading and an uncaptured mark must
        // never render as it.
        openOptionMarkUsd:
          typeof s.openOptionMarkUsd === 'number' && Number.isFinite(s.openOptionMarkUsd)
            ? round2(s.openOptionMarkUsd)
            : null,
        openOptionMarkDeltaUsd:
          typeof s.openOptionMarkDeltaUsd === 'number' && Number.isFinite(s.openOptionMarkDeltaUsd)
            ? round2(s.openOptionMarkDeltaUsd)
            : null,
        stockLegProbeMarkBasis:
          typeof s.stockLegProbeMarkBasis === 'string' && s.stockLegProbeMarkBasis !== ''
            ? s.stockLegProbeMarkBasis
            : null,
        rowCombinedPnl,
        combinedAgreement,
        combinedAgreementDeltaUsd,
        combinedAgreementReason,
        combinedAgreementDiscriminating,
        combinedPnlHasNoReader,
        optionsCreditedCumulative,
        // TRA-2635 — filled in by the second pass below; it needs the PRIOR row.
        optionsCreditedInWindow: null,
        // TRA-2658 — both filled in by the same pass, for the same reason.
        // TRA-2926 — `counterFrozen` starts NOT MEASURED, and only the pass may
        // promote it to a boolean: a row the pass never reaches (row 0, absent
        // equity endpoint) or gap-suppresses must not read "measured clean".
        unbookedEquityMoveUsd: null,
        counterFrozen: null,
        drift,
        eodRowMissing: eodCombined == null,
        // TRA-3849 — filled in by the calendar pass below. Starts NOT MEASURED
        // rather than `false`: without a calendar there is nothing to grade
        // against, and a `false` here would publish "this date is a session" as
        // a positive claim the code never made.
        nonSessionRow: null,
        nonSessionRowMoneyBearing: null,
        belowBaseline,
      };
    });

  // TRA-3849 — THE CALENDAR PASS. Grade every row's own date against the
  // exchange calendar.
  //
  // Runs over `days` in full, NOT over `evaluated`. Every other verdict in this
  // file is baseline-gated because a drift figure computed over pre-baseline
  // data is not trustworthy; that reasoning does not transfer. A row on a date
  // that was never a session is residue whatever the baseline says about its
  // numbers, and 9 of the 11 live date keys are May/June — gating would drop
  // most of the population and then report the remainder as the total.
  if (tailCalendar) {
    for (const d of days) {
      const nonSession = !tailCalendar.isMarketDay(d.date);
      d.nonSessionRow = nonSession;
      d.nonSessionRowMoneyBearing =
        nonSession
        && ((d.eodCombined != null && Math.abs(d.eodCombined) > PNL_RECONCILE_TOLERANCE_USD)
          || Math.abs(d.stockDaily) > PNL_RECONCILE_TOLERANCE_USD
          || Math.abs(d.optionsDaily) > PNL_RECONCILE_TOLERANCE_USD);
    }
  }

  // TRA-2630 AC3 — second pass for the T+1 credit-lag tripwire, which is the one
  // property here that needs the PREVIOUS session's row. `days` is already
  // date-sorted ascending, so index-1 is the prior session for this book.
  //
  // The `> tolerance` guard on `stockDaily` is load-bearing: without it every
  // quiet day (`stockDaily 0.00` after an options-free prior session, i.e.
  // `optionsDaily 0.00`) matches "equal to the cent" and the tripwire fires on
  // 127 of 167 clean sessions — a flag that is true in the passing state has no
  // failing state, the TRA-2301/TRA-2642 lesson.
  // TRA-2630 AC2 — `priorOptionsLagEligible` is stamped BEFORE the `stockDaily`
  // guard below, and deliberately does not depend on `cur` at all. Eligibility
  // asks "was the prediction sharp on this session", which is a property of the
  // PRIOR row only: given a non-zero `prev.optionsDaily`, the lag hypothesis
  // names one exact value for `cur.stockDaily`, so observing `0.00` refutes it
  // just as hard as observing some third number. Folding the `stockDaily` guard
  // into eligibility would throw away precisely the sessions that PASS, leaving
  // a cohort of offenders only.
  // TRA-2835 — the pair must be CALENDAR-adjacent, not merely array-adjacent.
  // `sessionsInRange(prev, cur)` enumerates the exchange sessions in
  // `[prev, cur]` inclusive, so exactly 2 means nothing sits between them. Any
  // other count (a hole, or a `prev` that is not itself a session) is
  // non-adjacent, and non-adjacent suppresses BOTH the eligibility stamp and
  // the tripwire — a T+1 property cannot be graded across a gap in either
  // direction. Without a calendar we cannot PROVE a gap, so the field reads
  // `null` and behaviour is unchanged: this fix removes false passes it can
  // demonstrate, and never invents one it cannot.
  for (let i = 1; i < days.length; i++) {
    const cur = days[i]!;
    const prev = days[i - 1]!;
    // TRA-3267 — the `=== 2` test assumes BOTH endpoints are sessions. A row
    // whose own date is not an exchange session (the 21:00 ET archive wrote
    // phantom Sunday rows when `isMarketDay` read the host-UTC weekday, e.g.
    // 2026-08-09 fleet-wide) breaks that assumption in the accusing direction:
    // [Thu 08-06, Sun 08-09] contains exactly two sessions — Thursday and the
    // UNWRITTEN Friday — so the phantom pair graded as adjacent while carrying
    // Friday's real P&L as an "unbooked" move. A non-session row can never form
    // a gradeable pair; the prev-side case needs no gate because a non-session
    // `prev` already fails the session count.
    const adjacent = tailCalendar
      ? tailCalendar.isMarketDay(cur.date) &&
        sessionsInRange(prev.date, cur.date, tailCalendar.isMarketDay).length === 2
      : null;
    cur.priorSessionAdjacent = adjacent;
    if (adjacent === false) {
      cur.priorOptionsLagEligible = false;
      continue;
    }
    cur.priorOptionsLagEligible =
      Math.abs(prev.optionsDaily) > PNL_RECONCILE_TOLERANCE_USD;
    if (Math.abs(cur.stockDaily) <= PNL_RECONCILE_TOLERANCE_USD) continue;
    if (Math.abs(cur.stockDaily - prev.optionsDaily) <= PNL_RECONCILE_TOLERANCE_USD) {
      cur.lagsPriorOptionsDaily = true;
    }
  }

  // TRA-2635 — separate pass for the per-session credit window. It must NOT be
  // folded into the loop above: that one `continue`s on every quiet session, and
  // a credit landing on a day with no stock P&L is precisely the session this
  // needs to see.
  for (let i = 1; i < days.length; i++) {
    const cur = days[i]!;
    const prev = days[i - 1]!;
    if (cur.optionsCreditedCumulative == null || prev.optionsCreditedCumulative == null) continue;
    cur.optionsCreditedInWindow = round2(
      cur.optionsCreditedCumulative - prev.optionsCreditedCumulative,
    );
  }

  // TRA-2658 — the UN-BOOKED EQUITY MOVE pass, and the frozen-counter
  // attribution built on it. See {@link PnlReconcileDay.unbookedEquityMoveUsd}
  // for why this axis is the only one that can see a counter stuck at 0.
  //
  // Deliberately a THIRD pass rather than folded into either loop above. The
  // credit-window loop `continue`s whenever an endpoint of the counter is absent
  // — which is precisely the state a frozen counter produces on its first
  // session — so computing this there would blind it on exactly the rows it
  // exists to grade. `optionsCreditedInWindow` is read as `?? 0` here (NOT
  // skipped on absent) on purpose: an absent counter contributes no explanation
  // for the equity move, which is the same thing a recorded 0 contributes. The
  // ambiguity TRA-2635 preserved matters when the counter is the ANSWER; here it
  // is the SUBTRAHEND, and both spellings of "explains nothing" are one value.
  // THE ATTRIBUTION POOL: realized option P&L that nothing has accounted for yet.
  //
  //     pool = Σ |optionsDaily|  −  Σ |recorded credit window|  −  Σ attributed moves
  //
  // A move is charged to a lost credit only if the pool can pay for it. This one
  // running figure replaces two weaker terms that each failed a control:
  //
  //  - "option P&L realized in the ADJACENT sessions" is too NARROW. A counter
  //    frozen for a week delivers several sessions' credit in one window whose two
  //    adjacent sessions may both be quiet, so it cleared exactly the longest
  //    freezes — the worst ones.
  //  - "≤ cumulative realized" alone is too WIDE. On a book that realized $1,000
  //    and had every cent properly credited, a later $50 starting-balance edit
  //    (`PaperAccount.applyEquity`) still fits under $1,000 and would be accused.
  //    Subtracting what the counter already recorded is what closes that: a fully
  //    credited book has an empty pool and cannot produce a frozen-counter claim.
  //
  // `Math.abs` throughout because the sink takes a SIGNED delta — a realized loss
  // is credited too, so a losing session still supplies explanatory room.
  // Pre-baseline sessions do not contribute: the bridge did not exist then, so
  // their P&L was never creditable and counting it would fund a false accusation.
  let pool = 0;
  for (let i = 0; i < days.length; i++) {
    const cur = days[i]!;
    if (!cur.belowBaseline) pool += Math.abs(cur.optionsDaily);
    if (i === 0) continue;
    const prev = days[i - 1]!;
    // TRA-2829 — same guard, hoisted into locals so it NARROWS. `Number.isFinite`
    // rejects `null` at runtime but does not tell the compiler so, and an
    // unmeasured back-fill anchor must drop out of this pair rather than
    // subtract as 0.
    const curEquity = cur.closingEquity;
    const prevEquity = prev.closingEquity;
    if (curEquity === null || prevEquity === null) continue;
    if (!Number.isFinite(curEquity) || !Number.isFinite(prevEquity)) continue;
    // TRA-3288 item 2 — the frozen-counter axis is a PAPER-book instrument:
    // its subtrahends (`stockDaily`, the TRA-2323 credit counter) live on the
    // PaperAccount, so an equity endpoint sourced from the BROKER makes `move`
    // a cross-surface difference — every real broker day move would read as an
    // "unbooked" paper credit and the pool (journal money) would happily fund
    // the accusation, nightly, on every live book. Both fields stay `null`
    // (NOT MEASURED, the TRA-2926 discipline: absence of a grade, never a
    // pass), and the pool is not charged — the broker move never entered the
    // paper book this pool models.
    if (cur.closingEquityBasis === CLOSING_EQUITY_BASIS_BROKER
      || prev.closingEquityBasis === CLOSING_EQUITY_BASIS_BROKER) continue;
    const recorded = cur.optionsCreditedInWindow ?? 0;
    const move = round2((curEquity - prevEquity) - cur.stockDaily - recorded);
    cur.unbookedEquityMoveUsd = move;
    pool -= Math.abs(recorded);
    // TRA-2926 — the same gate TRA-2888 put on `priorOptionsLagEligible`, for
    // the same reason: `prevEquity` is the previous ROW, and across the
    // permanent gap this window spans several settled sessions whose real,
    // correctly-booked P&L has nowhere else to land than `move`. The raw
    // arithmetic above is kept (it is still the only non-motion detector of
    // the frozen-counter signature); only the ACCUSATION is fenced. The pool
    // is deliberately not charged for a suppressed move — the gap sessions'
    // own `optionsDaily` never entered `days[]`, so the pool never received
    // the money that move represents either. `null` calendar grades as before
    // (TRA-2835: without a calendar we cannot prove a gap).
    if (cur.priorSessionAdjacent === false) continue;
    cur.counterFrozen = false;
    if (Math.abs(move) <= PNL_RECONCILE_TOLERANCE_USD) continue;
    // Recorded nothing for it — an ABSENT counter says "recorded nothing" just as
    // a written 0 does, and here the counter is the subtrahend rather than the
    // answer, so the TRA-2635 null/0 distinction does not apply.
    if (Math.abs(recorded) > PNL_RECONCILE_TOLERANCE_USD) continue;
    if (Math.abs(move) > pool + PNL_RECONCILE_TOLERANCE_USD) continue;
    cur.counterFrozen = true;
    pool -= Math.abs(move);
  }

  const evaluated = days.filter(d => !d.belowBaseline);
  // TRA-2637 — `drift` is now `null` on a row with no EOD report. The explicit
  // null guard is not a behaviour change (an absent row scored 0 before and so
  // passed both filters); it keeps `ok` / `maxDriftUsd` byte-identical for every
  // existing consumer while the absence itself moves onto its own axis below.
  const offendingDates = evaluated
    .filter(d => d.drift != null && Math.abs(d.drift) > PNL_RECONCILE_TOLERANCE_USD)
    .map(d => d.date);
  const maxDriftUsd = evaluated.reduce((m, d) => Math.max(m, Math.abs(d.drift ?? 0)), 0);
  // TRA-2637 — THE ABSENCE AXIS. Cohort = evaluated sessions that had something
  // to reconcile: a real option close per the durable journal, or a non-zero P&L
  // leg. The activity term is what gives this a failing state AND keeps it from
  // manufacturing one: a genuinely quiet session with no report file has nothing
  // to reconcile, so it is not an offender — but its `drift` is `null`, not 0, so
  // it is not a pass either. The journal term is disjunctive (not required)
  // because the census can be unavailable, and an unreadable journal must not
  // silently empty the cohort — the `every`-on-the-empty-set trap.
  const eodRowGradeable = evaluated.filter(
    d =>
      (d.journalCloses ?? 0) > 0
      || Math.abs(d.optionsDaily) > PNL_RECONCILE_TOLERANCE_USD
      || Math.abs(d.stockDaily) > PNL_RECONCILE_TOLERANCE_USD,
  );
  const eodRowMissingDates = eodRowGradeable.filter(d => d.eodRowMissing).map(d => d.date);
  // TRA-3849 — the calendar axis, folded per book. `nonSessionRowGradeableCount`
  // is `days.length` under a calendar and `0` without one, which is what keeps
  // `nonSessionRowsOk: null` distinguishable from a graded clean book.
  const nonSessionRowGradeableCount = tailCalendar ? days.length : 0;
  const nonSessionRowDates = days.filter(d => d.nonSessionRow === true).map(d => d.date);
  const nonSessionRowMoneyBearingDates = days
    .filter(d => d.nonSessionRowMoneyBearing === true)
    .map(d => d.date);
  const nonSessionRowsOk: boolean | null =
    nonSessionRowGradeableCount === 0 ? null : nonSessionRowDates.length === 0;
  // TRA-2817 — THE TAIL. Anchored on the newest row in `days`, INCLUDING
  // below-baseline ones: the baseline is a data-integrity cutoff for grading
  // drift, not evidence that the writer was dead. Anchoring on `evaluated`
  // instead would score a book whose whole history predates the baseline as
  // maximally stale for a writer that is working fine.
  const eodTailLatestRowDate = days.length === 0 ? null : days[days.length - 1]!.date;
  const eodTailSettledSession = tailCalendar?.lastSettledSession ?? null;
  const eodTailStaleSessions = tailCalendar
    ? countStaleTailSessions(eodTailLatestRowDate, eodTailSettledSession, tailCalendar.isMarketDay)
    : null;
  // A stale tail is a HARD false, and it outranks the interior cohort entirely.
  // Both of the interior's non-false states are wrong here: `true` is the
  // clean-pass-over-a-dead-writer this ticket was filed about, and `null` reads
  // as "nothing to check" when the truth is "nothing was written". The interior
  // verdict is only consulted once the tail is known to be current.
  const eodRowsPresentOk: boolean | null =
    eodTailStaleSessions != null && eodTailStaleSessions > 0
      ? false
      : eodRowGradeable.length === 0
        ? null
        : eodRowMissingDates.length === 0;
  // TRA-3517 — the row/report `combinedPnl` agreement, folded per book.
  //
  // Baseline-gated (`evaluated`) exactly like every other verdict here, and the
  // gate costs nothing: only the TRA-3349 shaper writes a broker-shaped row, so
  // the graded cohort is post-fix by construction — there is no pre-fix era for
  // it to drag in.
  const combinedAgreementGraded = evaluated.filter(d => d.combinedAgreement !== 'not-measured');
  // The GRADEABLE cohort is the DISCRIMINATING subset, not everything the axis
  // touched. A 0.00-vs-0.00 session emits `agree` however broken the wiring is,
  // so it is a measurement and not evidence — the same separation TRA-2633 drew
  // between `stockLegOffendingDates` and `stockLegMeasurableDays`. No red is
  // lost by the narrowing: a degenerate session cannot produce one.
  const combinedAgreementDiscriminatingRows = evaluated.filter(
    d => d.combinedAgreementDiscriminating,
  );
  const combinedAgreementDisagreeDates = evaluated
    .filter(d => d.combinedAgreement === 'disagree')
    .map(d => d.date);
  const combinedAgreementNotMeasuredCounts = evaluated.reduce<Record<string, number>>((acc, d) => {
    if (d.combinedAgreementReason === null) return acc;
    acc[d.combinedAgreementReason] = (acc[d.combinedAgreementReason] ?? 0) + 1;
    return acc;
  }, {});
  // NULL on the empty cohort, never `true`. An empty DISCRIMINATING cohort is
  // the state this whole ticket is about: nothing that could have failed was
  // looked at, and on a broker-shaped row nothing else is looking either. A
  // disagreement still wins outright wherever it lands — it is by construction
  // discriminating (the two sides differ, so they cannot both be 0.00), so this
  // ordering cannot swallow a red.
  const combinedAgreementOk: boolean | null =
    combinedAgreementDisagreeDates.length > 0
      ? false
      : combinedAgreementDiscriminatingRows.length === 0
        ? null
        : true;
  // TRA-2630 — the per-leg verdicts. Baseline-gated exactly like `ok`: a
  // pre-fix row's stock leg is un-reconcilable for the same reason its `drift`
  // is, so grading it would hand these new fields the same dead state `ok` has.
  const stockLegOffendingDates = evaluated
    .filter(d => Math.abs(d.stockLegDrift) > PNL_RECONCILE_TOLERANCE_USD)
    .map(d => d.date);
  const optionsLegOffendingDates = evaluated
    .filter(d => Math.abs(d.optionsLegDrift) > PNL_RECONCILE_TOLERANCE_USD)
    .map(d => d.date);
  // TRA-2633 — the stock leg is only GRADEABLE where it could have disagreed:
  // the report leg must be present, and the snapshot leg must be non-zero. A row
  // with `stockDaily === 0` scores 0 on both sides no matter how broken the
  // source is, so counting it as evidence is the same vacuous pass that made C5
  // of TRA-2625 read green off two books that both had `stockDaily === 0`.
  const stockLegMeasurableDays = evaluated.filter(
    d => d.eodStockPnl != null && d.stockDaily !== 0,
  );
  // TRA-3948 — THE EQUITY-PROBE AXIS, the reader `stockLegDrift` cannot be.
  //
  // Cohort is `days`, NOT `evaluated`, and that is deliberate. The baseline gate
  // exists to keep pre-fix rows out of verdicts they cannot satisfy; a
  // `stockLegProbeUsd` is only ever stamped by the post-TRA-3349 writers, so the
  // gate excludes nothing here and would only add an EVICTION path — move the
  // baseline forward and a real disagreement leaves the cohort silently, which
  // is how `eodTailStaleBooks` came to empty by eviction rather than by repair.
  const stockLegProbeRows = days.filter(
    d => typeof d.stockLegProbeUsd === 'number' && Number.isFinite(d.stockLegProbeUsd),
  );
  const stockLegProbeNotMeasuredCount = days.filter(
    d => d.stockLegBasis !== null && (d.stockLegProbeUsd == null),
  ).length;
  // Rows the writer made NO claim about. Not a failure — but publishing only the
  // measured count would read as "the live book is covered", and on `admin` 6 of
  // its 11 present post-onset rows are `unstamped-pre-tra3349` with a frozen
  // demo `closingEquity`, permanently outside this axis.
  const stockLegProbeUnstampedCount = days.filter(d => d.stockLegBasis === null).length;
  // DISCRIMINATING = a material residual was reachable on this row. Every
  // operand the writer differences is checked, not just the equity delta: a
  // session that moved $0 but booked $400 of options could still have produced a
  // residual, and pinning this to equity alone would drop it from the
  // denominator.
  const stockLegProbeDiscriminatingRows = stockLegProbeRows.filter(d => {
    const equityMove =
      d.closingEquity != null && d.openingEquity != null
        ? Math.abs(d.closingEquity - d.openingEquity)
        : null;
    return (
      (equityMove != null && equityMove > STOCK_LEG_PROBE_TOLERANCE_USD) ||
      Math.abs(d.optionsDaily) > STOCK_LEG_PROBE_TOLERANCE_USD ||
      (d.netCashFlowUsd != null && Math.abs(d.netCashFlowUsd) > STOCK_LEG_PROBE_TOLERANCE_USD) ||
      // TRA-3954 — the fourth operand is checked like the other three.
      (d.openOptionMarkDeltaUsd != null
        && Math.abs(d.openOptionMarkDeltaUsd) > STOCK_LEG_PROBE_TOLERANCE_USD)
    );
  });
  const stockLegProbeOffendingDates = stockLegProbeRows
    .filter(d => Math.abs(d.stockLegProbeUsd!) > STOCK_LEG_PROBE_TOLERANCE_USD)
    .map(d => d.date);
  // TRA-3954 — the verdict below is UNCHANGED: it keys on the probe number,
  // and a row lacking the mark operand still honestly reports equity motion
  // booked to no realized leg. What this ticket adds is the ATTRIBUTION split
  // (which offenders lack the operand) and the one count that proves the
  // four-operand GREEN branch has fired on a real overnight position.
  const hasMark = (d: PnlReconcileDay): boolean =>
    typeof d.openOptionMarkDeltaUsd === 'number' && Number.isFinite(d.openOptionMarkDeltaUsd);
  const stockLegProbeMarkDifferencedCount = stockLegProbeRows.filter(hasMark).length;
  const stockLegProbeOffendingWithoutMarkDates = stockLegProbeRows
    .filter(d => Math.abs(d.stockLegProbeUsd!) > STOCK_LEG_PROBE_TOLERANCE_USD && !hasMark(d))
    .map(d => d.date);
  const stockLegProbeOvernightReconciledCount = stockLegProbeRows.filter(
    d =>
      hasMark(d)
      && Math.abs(d.openOptionMarkDeltaUsd!) > STOCK_LEG_PROBE_TOLERANCE_USD
      && Math.abs(d.stockLegProbeUsd!) <= STOCK_LEG_PROBE_TOLERANCE_USD,
  ).length;
  // RED > NOT MEASURED > GREEN. A residual wins outright wherever it lands — it
  // is discriminating by construction (a material probe needs a material
  // operand), so this ordering cannot swallow one.
  const stockLegProbeOk: boolean | null =
    stockLegProbeOffendingDates.length > 0
      ? false
      : stockLegProbeDiscriminatingRows.length === 0
        ? null
        : true;
  const stockLegBasisCounts = days.reduce<Record<string, number>>((acc, d) => {
    if (d.stockLegBasis === null) return acc;
    acc[d.stockLegBasis] = (acc[d.stockLegBasis] ?? 0) + 1;
    return acc;
  }, {});
  // NOT MEASURED (`null`) in two distinct situations, both of which a plain
  // boolean would have rendered as a green:
  //   1. no measurable row at all  — the empty-cohort trap (`every` is true on
  //      the empty set), which shipped live as `livePriorOptionsLagOk`;
  //   2. every measurable row has `eodStockPnl === 0` — the source is zeroed by
  //      the TRA-219 archive, so `stockLegDrift` is just `-stockDaily`.
  // Case 2 is deliberately a `some`, not a threshold: ONE row carrying a real
  // non-zero report figure proves the source is live again and hands the verdict
  // straight back to the boolean, with no code change and no flag to remember.
  const stockLegSourceLive = stockLegMeasurableDays.some(d => d.eodStockPnl !== 0);
  const stockLegOk: boolean | null =
    stockLegMeasurableDays.length === 0 || !stockLegSourceLive
      ? null
      : stockLegOffendingDates.length === 0;
  // TRA-2641 — the options leg needs the SAME denominator discipline, for a
  // different reason. `syncEodReportOptionsLegs` writes the day cell's
  // `optionsDailyPnl` into the report file's options leg on every row the journal
  // is authority for, so on those rows `eodOptionsPnl - optionsDaily` is 0 BY
  // CONSTRUCTION — one source compared against a copy of itself. A row is
  // independent evidence only when all three hold:
  //   1. the report leg is present at all (a null one is forced to drift 0 above,
  //      which is the TRA-2637 absent-row hazard);
  //   2. the row is NOT journal-slaved;
  //   3. at least one leg is non-zero — 0.00 vs 0.00 is the same vacuous pass
  //      that made `stockLegOk` unfalsifiable.
  const optionsLegSlavedDays = evaluated.filter(d => isJournalAuthoritativeSource(d.optionsDailyPnlSource));
  // A row HAS SUBSTANCE when at least one of its two legs is non-zero, i.e. a
  // disagreement was arithmetically possible on it. `eodOptionsPnl == null` is an
  // ABSENT report leg, which is forced to drift 0 above — that row still has
  // substance whenever the day cell is non-zero, because the journal said
  // something and the report did not answer.
  const optionsLegRowHasSubstance = (d: PnlReconcileDay): boolean =>
    (d.eodOptionsPnl ?? 0) !== 0 || d.optionsDaily !== 0;
  const optionsLegMeasurableDays = evaluated.filter(
    d =>
      d.eodOptionsPnl != null
      && !isJournalAuthoritativeSource(d.optionsDailyPnlSource)
      && optionsLegRowHasSubstance(d),
  );
  // TRA-2924 — the COVERAGE axis. TRA-2641 fixed independence: a slaved row is
  // no longer counted as evidence. What it did not fix is that the verdict kept
  // claiming the WHOLE cohort off whatever survived the exclusion. Live
  // 2026-08-05, build 237c147e: 1 measured against 207 slaved, and the gate read
  // `true` — a fleet-wide green asserted off 0.5% of the rows that had something
  // to say. `null` on 07-30 was the honest read; it DEGRADED into `true` purely
  // because one independent row appeared.
  //
  // The rule is deliberately NOT a minimum cohort size. A constant ("at least 20
  // rows", "at least 30%") decays exactly the way a dollar-denominated threshold
  // does and would have to be re-tuned every time the fleet changes shape. The
  // rule is an IDENTITY: a verdict may claim the cohort it MEASURED and nothing
  // else, so a fleet-wide green requires that no row with something to say was
  // excluded. `optionsLegSilencedDates` is that set — rows that carried a real
  // figure on at least one leg and were nonetheless kept out of the denominator,
  // because a writer joined their operands or the report leg is absent.
  //
  // Empty silenced set ⇒ the measured cohort IS the cohort; the green covers
  // everything and `fleet` is the truthful scope. Non-empty ⇒ `partial`: rows
  // that could have falsified this verdict were never asked, however many rows
  // did answer. Note this holds at n=1 AND at n=200 — it is share-free.
  const optionsLegMeasurableDates = new Set(optionsLegMeasurableDays.map(d => d.date));
  const optionsLegSilencedDates = evaluated
    .filter(d => !optionsLegMeasurableDates.has(d.date) && optionsLegRowHasSubstance(d))
    .map(d => d.date);
  const optionsLegCoveredDates = optionsLegMeasurableDays.map(d => d.date);
  const optionsLegScope: PnlOptionsLegScope =
    optionsLegMeasurableDays.length === 0
      ? 'not-measured'
      : optionsLegSilencedDates.length === 0
        ? 'fleet'
        : 'partial';
  // RED outranks NOT MEASURED: a slaved row that still disagrees means the sync
  // writer failed, and that is a genuine defect the `null` must never swallow.
  // TRA-2924 — the GREEN branch now additionally requires `scope === 'fleet'`.
  // A `partial` cohort reports `null`: the evidence is not discarded (it is in
  // `optionsLegCoveredDates`, `optionsLegOffendingDates` and
  // `maxOptionsLegDriftUsd`), only the fleet-wide CLAIM is withheld.
  const optionsLegOk: boolean | null =
    optionsLegOffendingDates.length > 0
      ? false
      : optionsLegScope === 'fleet'
        ? true
        : null;
  const priorOptionsLagDates = days.filter(d => d.lagsPriorOptionsDaily).map(d => d.date);
  const priorOptionsLagEligibleDates = days
    .filter(d => d.priorOptionsLagEligible)
    .map(d => d.date);
  // TRA-2835 — sessions that WOULD have been eligible on the old array-adjacent
  // pairing but are suppressed because their predecessor row is not the
  // preceding exchange session. Published rather than silently dropped: a
  // cohort that quietly shrinks is indistinguishable from one that was never
  // there, and this is exactly the set that would have produced a false PASS.
  const priorOptionsLagGapSuppressedDates = days
    .filter(d => d.priorSessionAdjacent === false)
    .map(d => d.date);
  // TRA-2302 — the false-zero sweep is NOT baseline-gated. The baseline exists
  // because pre-fix code wrote arithmetically un-reconcilable drift; a missing
  // option close is a different defect, and silencing it before 2026-07-12
  // would hide exactly the history the parent (TRA-2297) is arguing about.
  const falseZeroDates = days.filter(d => d.optionsFalseZero).map(d => d.date);
  // TRA-3864 — over ALL days, not `evaluated`. The baseline (TRA-1636) exists to
  // keep pre-fix ROWS out of the drift verdict; it does not apply here because
  // the gate is the provenance stamp itself, which post-dates TRA-2314 — a row
  // old enough for the baseline to matter carries a null `optionsDailyPnlSource`
  // and is already outside the cohort. Grading `evaluated` instead would silently
  // shrink the denominator by a rule that has nothing to say about this axis, and
  // would stop the published set matching the hand-run repro.
  const journalAgreementGradeable = days.filter(d => d.journalOptionsPnlDeltaUsd !== null);
  const journalSupersededDates = days
    .filter(d => d.optionsDailySupersededByJournal)
    .map(d => d.date);
  // TRA-2635 — the CREDIT-REACHED-EQUITY cohort and verdict. Baseline-gated
  // (`evaluated`) because the bridge did not exist pre-baseline, so a pre-fix row
  // carrying no credit is correct behaviour, not a failure.
  //
  // The cohort is the TRIGGER condition: the session must have written the
  // counter AND realized option P&L for equity to absorb. Without the second
  // term the "offender cohort" and the "gradeable cohort" diverge — 7 of the 13
  // lag books on 2026-07-29 had a zero prior and could never have verified the
  // fix no matter what shipped.
  const creditWrittenDays = days.filter(d => d.optionsCreditedCumulative != null);
  const creditMeasurableDays = evaluated.filter(
    d =>
      d.optionsCreditedCumulative != null
      && Math.abs(d.optionsDaily) > PNL_RECONCILE_TOLERANCE_USD,
  );
  const optionsCreditedDates = days
    .filter(
      d =>
        d.optionsCreditedInWindow != null
        && Math.abs(d.optionsCreditedInWindow) > PNL_RECONCILE_TOLERANCE_USD,
    )
    .map(d => d.date);
  // TRA-2635 SECOND PASS (found on the FIRST live pull of this field, 07:48Z) —
  // A ZERO COUNTER IS NOT EVIDENCE THAT NO CREDIT REACHED EQUITY. The counter is
  // only admissible against a book whose counter is DURABLE, and on the live
  // fleet it is not: `Richard` wrote `optionsCreditedCumulative: 0` on three
  // consecutive sessions while its `closingEquity` moved 2233.91 -> 2301.41
  // (+67.50, exactly 07-27's `optionsDaily`) -> 2323.91 (+22.50, exactly 07-28's).
  // The money demonstrably arrived; the counter that records it did not survive.
  //
  // So the FIRST cut of this verdict read `false` on a book where equity had
  // absorbed every cent — a manufactured red, and the same class of error as the
  // manufactured green it was shipped to fix. Two signatures prove non-durability
  // from the row itself, and either one forces NOT MEASURED:
  //
  //   lagsPriorOptionsDaily  the T+1 mis-bucket IS the reset signature (TRA-2629):
  //                          the writer lost the left endpoint of its subtraction,
  //                          so the credit landed in equity and was re-booked into
  //                          the stock leg. Its presence PROVES a credit arrived.
  //   a NEGATIVE window      a cumulative counter cannot decrease. It only can if
  //                          it was zeroed between two writes.
  const counterResetDates = days
    .filter(d => d.lagsPriorOptionsDaily || (d.optionsCreditedInWindow ?? 0) < -PNL_RECONCILE_TOLERANCE_USD)
    .map(d => d.date);
  // TRA-2658 — THE THIRD NON-DURABILITY SIGNATURE, and the one both signatures
  // above are structurally blind to.
  //
  // Both `counterResetDates` terms are MOTION detectors: a T+1 mis-bucket, or a
  // decrease. A counter frozen at exactly 0 produces neither. It never decreases,
  // and it never pushes a credit into the stock leg, because `openingEquity`
  // absorbed the credit across a boot before the close ran — so `stockDaily`
  // stays the true stock leg and the lag signature never fires.
  //
  // `counterDurable` therefore had NO FAILING STATE on the most important book on
  // the fleet. Live bqb1 2026-07-30T14:08Z, `admin`: `counterDurable: true`,
  // `counterResetDates: []`, `optionsCreditedCumulative: 0` on 07-27/07-28/07-29
  // — while `unbookedEquityMoveUsd` read +140.00 then +114.00, i.e. $254.00 of
  // credit that reached equity and was recorded as nothing. TRA-2658 AC2 asks for
  // `counterDurable === true` as the proof Defect A is fixed at the durable seam;
  // graded against the reset-only predicate that acceptance was ALREADY green on
  // the broken book, which is the `every`-is-true-on-the-empty-cohort failure this
  // module has now shipped four times, wearing a non-empty filter.
  //
  // Folded INTO `counterDurable` rather than published beside it, deliberately.
  // The field's documented meaning — "is `optionsCreditedCumulative` trustworthy
  // as evidence of absence?" — is exactly right; a counter frozen at 0 is the
  // least trustworthy state it can be in. A parallel field would have left AC2
  // vacuously green and pushed the discrimination onto every future reader.
  const counterFrozenDates = days.filter(d => d.counterFrozen === true).map(d => d.date);
  const counterNonDurableDates = [...new Set([...counterResetDates, ...counterFrozenDates])].sort();
  const unbookedEquityMoveDates = days
    .filter(d => d.unbookedEquityMoveUsd != null
      && Math.abs(d.unbookedEquityMoveUsd) > PNL_RECONCILE_TOLERANCE_USD)
    .map(d => d.date);
  // TRA-2926 — the frozen detector's own denominator and its suppressed set.
  // Gradeable = the pass reached a verdict (either one); suppressed = the
  // arithmetic was measurable but the prior row sits across a session gap, so
  // the accusation was fenced. Published for the same reason
  // `priorOptionsLagGapSuppressedDates` is: a cohort that quietly shrinks is
  // indistinguishable from one that was never there.
  const counterFrozenGradeableDates = days
    .filter(d => d.counterFrozen !== null)
    .map(d => d.date);
  const counterGapSuppressedDates = days
    .filter(d => d.unbookedEquityMoveUsd != null && d.priorSessionAdjacent === false)
    .map(d => d.date);
  // TRA-2926 — green now additionally requires the frozen detector to have
  // graded at least one session. Without that term, gap-suppressing every
  // measurable row would flip a book from spuriously RED to vacuously GREEN —
  // the same wrong answer in the other direction. RED still wins outright: the
  // reset signatures are gap-robust (a cumulative counter cannot decrease over
  // ANY span), so a red from them stands even on an otherwise ungradeable book.
  const counterDurable: boolean | null =
    creditWrittenDays.length === 0
      ? null
      : counterNonDurableDates.length > 0
        ? false
        : counterFrozenGradeableDates.length === 0
          ? null
          : true;
  const equityAbsorbedOptionsOk: boolean | null =
    creditMeasurableDays.some(d => d.optionsCreditedCumulative !== 0)
      ? true
      : creditMeasurableDays.length === 0 || counterDurable !== true
        ? null
        : false;
  const creditWritten = creditWrittenDays;
  const equityWritten = days.filter(d => Number.isFinite(d.closingEquity));
  // TRA-2635 — THE STATE MEASUREMENT, which needs no counter at all and is the
  // only rigorous handle on "how much of the realized options leg is in NAV?".
  // Equity either grew or it did not.
  //
  //     uncreditedOptionsUsd = (Σ optionsDaily + Σ stockDaily) − Δ closingEquity
  //
  // On the live `admin` book at 2026-07-30T07:48Z: 987.60 + (−18.81) − 235.19 =
  // **+733.60 absent from NAV**, against CEO's TRA-2635 predictions of 2977.08
  // (bridge works) and 1989.48 (never fired) — observed 2243.48, i.e. NEITHER.
  //
  // CAVEAT, and it is why this is published as a number and not as a verdict: on
  // a book where `counterDurable === false` the lagged credit is ALREADY inside
  // `stockDaily`, so that leg double-counts it and this figure is an UPPER BOUND
  // (Richard: 400.29 nominal, ~310.29 once its $90.00 of double-counted credit is
  // removed — the same $90 double-count CEO flagged against a naive backfill).
  // THE OPERANDS MUST TELESCOPE. `closingEquity[last] − closingEquity[first]` spans
  // the windows of rows 1..N, NOT 0..N, so the P&L sums must skip the first row —
  // its own session's P&L landed in an equity delta whose left endpoint is outside
  // the series. Summing 0..N against a 1..N delta overstates the shortfall by
  // exactly the first row's P&L, which is a fabricated finding whenever the series
  // happens to start on an active session.
  const evaluatedEquity = evaluated.filter(d => Number.isFinite(d.closingEquity));
  const spanned = evaluatedEquity.slice(1);
  // TRA-2829 — the filter above already drops an unmeasured anchor (`null` is not
  // finite); these locals just prove it to the compiler. Kept as an explicit
  // null test rather than a `!`, so that widening `closingEquity` can never
  // silently become a `null - null === 0` growth reading.
  const firstEquity = evaluatedEquity[0]?.closingEquity ?? null;
  const lastEquity = evaluatedEquity[evaluatedEquity.length - 1]?.closingEquity ?? null;
  const postBaselineEquityGrowth =
    evaluatedEquity.length < 2 || firstEquity === null || lastEquity === null
      ? null
      : round2(lastEquity - firstEquity);
  const postBaselineOptionsRealized = round2(spanned.reduce((s, d) => s + d.optionsDaily, 0));
  const postBaselineStockDaily = round2(spanned.reduce((s, d) => s + d.stockDaily, 0));
  // TRA-3589 — WHERE THIS BOOK'S EQUITY CHANGED SURFACE, and by how much.
  //
  // TRA-3349 (`eb1dcf0`, live 2026-08-12T10:39:01Z) re-sourced the live recorded
  // row's equity from the broker FORWARD ONLY — by design, and correctly: no
  // historical row was restated, because back-fill is refused (TRA-2886/2888).
  // The unavoidable consequence is a discontinuity inside a single published
  // series: the onset row's `openingEquity` is a BROKER anchor while the row
  // immediately before it closed on the demo PaperAccount. On 2026-08-12 that
  // step was -1,459.43 on `admin` and -24,600.00 on `v0nni`, with
  // `netCashFlowUsd: 0`, `stockDaily: 0` and `optionsDaily: 0` — i.e. it is
  // NOT a cash movement and NOT P&L, it is the same book measured on a
  // different instrument. Published so a reader who computes that delta finds it
  // already named, rather than discovering a $26k one-day loss that never
  // happened.
  const brokerRows = days.filter(d => isBrokerEquityEra(d.closingEquityBasis));
  const brokerOnsetRow = brokerRows[0] ?? null;
  const priorEraRow = brokerOnsetRow === null
    ? null
    : [...days].reverse().find(d =>
      d.date < brokerOnsetRow.date && Number.isFinite(d.closingEquity)) ?? null;
  const eraCensus = days.reduce<Record<string, number>>((acc, d) => {
    const era = equitySourceEraOf(d.closingEquityBasis);
    acc[era] = (acc[era] ?? 0) + 1;
    return acc;
  }, {});
  const equitySourceEraBoundary: EquitySourceEraBoundary = {
    brokerOnsetDate: brokerOnsetRow?.date ?? null,
    brokerOnsetOpeningEquity: brokerOnsetRow?.openingEquity ?? null,
    priorEraRowDate: priorEraRow?.date ?? null,
    priorEraRowEquitySourceEra: priorEraRow === null
      ? null
      : equitySourceEraOf(priorEraRow.closingEquityBasis),
    priorEraRowClosingEquity: priorEraRow?.closingEquity ?? null,
    // The step across the boundary. NOT P&L — see the field doc. `null` unless
    // BOTH endpoints exist, never 0: a manufactured zero here would read as
    // "the surfaces agreed", which is the one conclusion this field must never
    // be able to state by absence.
    restatementUsd:
      brokerOnsetRow === null
      || priorEraRow === null
      || brokerOnsetRow.openingEquity === null
      || priorEraRow.closingEquity === null
        ? null
        : round2(brokerOnsetRow.openingEquity - priorEraRow.closingEquity),
    eraCensus,
    seriesSpansBrokerBoundary: brokerOnsetRow !== null && priorEraRow !== null,
  };
  // TRA-3589 — does the `postBaseline*` window itself straddle the boundary?
  //
  // This is the defect, and it is the TRA-3288 finding a second time in an
  // adjacent metric. TRA-3288 gated `postOnsetCredit` on the anchor rows'
  // broker basis (`equity-anchor-not-broker-sourced`) because differencing a
  // broker figure against a demo figure is meaningless. It did NOT gate the
  // older day-cell `postBaselineEquityGrowth`, which differences
  // `closingEquity[last] - closingEquity[first]` over the whole post-baseline
  // window — and since 2026-08-12 those two endpoints sit on DIFFERENT
  // surfaces. Same error, moved from across-books to across-time.
  //
  // Measured live on bqb1 2026-08-13T18:27Z, build `4cac8b70ee3c`: `v0nni`
  // published `uncreditedOptionsUsd: 24600.00` — on a book with
  // `liveOptionsOnsetDate: null`, `postBaselineOptionsRealized: 0` and
  // `postBaselineStockDaily: 0`. It has never traded an option in any mode, so
  // every cent of that "options money missing from NAV" is the 25,000.00 ->
  // 400.00 surface change and nothing else. `admin` carried the same artifact at
  // 1,371.12 (its -1,459.43 step), and the fleet fold
  // `liveUncreditedOptionsUsdUnscoped` published their sum, 25,971.12 — against
  // 733.60 on 2026-07-30 and 371.59 on 2026-08-05.
  const postBaselineEquityGrowthSpansEquitySourceEras =
    evaluatedEquity.length >= 2
    && equitySpanCrossesSourceEra(
      evaluatedEquity[0]!.closingEquityBasis,
      evaluatedEquity[evaluatedEquity.length - 1]!.closingEquityBasis,
    );
  // The VERDICT refuses; the OPERANDS stay published. Deleting
  // `postBaselineEquityGrowth` would destroy the evidence this refusal rests on
  // — the same reason TRA-2831 kept 733.60 visible while suspending it. A reader
  // can still see -24,600.00 sitting next to the boundary that explains it.
  const uncreditedOptionsNotMeasuredReason: string | null =
    postBaselineEquityGrowth == null
      ? 'equity-growth-not-measured'
      : postBaselineEquityGrowthSpansEquitySourceEras
        ? 'equity-span-crosses-equity-source-era'
        : null;
  // TRA-2831 — decompose the numerator by whether the book was demonstrably live
  // on the session. Computed over `spanned`, the SAME rows the numerator sums, so
  // `optionsRealizedBeforeLiveOnsetUsd` is a true partition of
  // `postBaselineOptionsRealized` and a reader can subtract the two. Folding over
  // `evaluated` instead would let the contamination figure exceed the numerator
  // it is supposed to qualify, on exactly the books whose first row is active.
  const preLiveOnsetRows = spanned.filter(d =>
    (liveOptionsOnsetDate === null || d.date < liveOptionsOnsetDate)
    && Math.abs(d.optionsDaily) > PNL_RECONCILE_TOLERANCE_USD);
  const optionsRealizedBeforeLiveOnsetUsd = round2(
    preLiveOnsetRows.reduce((s, d) => s + d.optionsDaily, 0),
  );
  // TRA-2919 — the JOURNAL-sourced post-onset axis, computed over `evaluated`
  // (post-baseline rows) and the SAME census/calendar/onset this function was
  // already handed. Nothing above it changes: the day-cell figures stay published
  // byte-identically as the evidence the TRA-2831 suspension rests on.
  const postOnsetCredit = summarizePostOnsetLiveCredit({
    rows: evaluated,
    liveOptionsOnsetDate,
    journalClosesByDate,
    calendar: tailCalendar,
    bookMode,
  });

  return {
    ok: offendingDates.length === 0,
    days,
    maxDriftUsd: round2(maxDriftUsd),
    offendingDates,
    caveats: PNL_RECONCILIATION_CAVEATS,
    baselineDate,
    belowBaselineCount: days.length - evaluated.length,
    falseZeroDates,
    optionsFalseZeroOk: falseZeroDates.length === 0,
    journalSupersededDates,
    journalAgreementGradeableCount: journalAgreementGradeable.length,
    journalAgreementOk:
      journalSupersededDates.length > 0
        ? false
        : journalAgreementGradeable.length === 0
          ? null
          : true,
    maxJournalSupersessionUsd:
      journalAgreementGradeable.length === 0
        ? null
        : round2(
          journalAgreementGradeable.reduce(
            (m, d) => Math.max(m, Math.abs(d.journalOptionsPnlDeltaUsd ?? 0)),
            0,
          ),
        ),
    eodRowMissingDates,
    eodRowsPresentOk,
    eodRowGradeableCount: eodRowGradeable.length,
    nonSessionRowDates,
    nonSessionRowMoneyBearingDates,
    nonSessionRowGradeableCount,
    nonSessionRowsOk,
    combinedAgreementOk,
    combinedAgreementGradeableCount: combinedAgreementGraded.length,
    combinedAgreementDiscriminatingCount: combinedAgreementDiscriminatingRows.length,
    combinedAgreementDisagreeDates,
    combinedAgreementMaxDeltaUsd:
      combinedAgreementGraded.length === 0
        ? null
        : round2(
          combinedAgreementGraded.reduce(
            (m, d) => Math.max(m, Math.abs(d.combinedAgreementDeltaUsd ?? 0)),
            0,
          ),
        ),
    combinedAgreementNotMeasuredCounts,
    combinedPnlNoReaderDates: evaluated.filter(d => d.combinedPnlHasNoReader).map(d => d.date),
    eodTailStaleSessions,
    eodTailLatestRowDate,
    eodTailSettledSession,
    optionsFieldMissingCount: days.filter(d => !d.optionsFieldPresent).length,
    optionsDailyPnlSourceCounts: days.reduce<Record<string, number>>((acc, d) => {
      const key = d.optionsDailyPnlSource ?? 'legacy-bucket';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    repairedDates: days.filter(d => d.optionsDailyPnlSource === 'journal-repair').map(d => d.date),
    stockLegOk,
    stockLegMeasuredCount: stockLegMeasurableDays.length,
    stockLegOffendingDates,
    maxStockLegDriftUsd: round2(
      evaluated.reduce((m, d) => Math.max(m, Math.abs(d.stockLegDrift)), 0),
    ),
    stockLegProbeOk,
    stockLegProbeMeasuredCount: stockLegProbeRows.length,
    stockLegProbeNotMeasuredCount,
    stockLegProbeUnstampedCount,
    stockLegProbeDiscriminatingCount: stockLegProbeDiscriminatingRows.length,
    stockLegProbeOffendingDates,
    stockLegProbeMarkDifferencedCount,
    stockLegProbeOffendingWithoutMarkDates,
    stockLegProbeOvernightReconciledCount,
    maxStockLegProbeUsd:
      stockLegProbeRows.length === 0
        ? null
        : round2(stockLegProbeRows.reduce((m, d) => Math.max(m, Math.abs(d.stockLegProbeUsd!)), 0)),
    stockLegBasisCounts,
    optionsLegOk,
    optionsLegMeasuredCount: optionsLegMeasurableDays.length,
    optionsLegSlavedCount: optionsLegSlavedDays.length,
    optionsLegScope,
    optionsLegSilencedDates,
    optionsLegCoveredDates,
    optionsLegCoverageShare:
      optionsLegMeasurableDays.length + optionsLegSilencedDates.length === 0
        ? null
        : Math.round(
            (optionsLegMeasurableDays.length
              / (optionsLegMeasurableDays.length + optionsLegSilencedDates.length))
              * 10000,
          ) / 10000,
    optionsLegOffendingDates,
    maxOptionsLegDriftUsd: round2(
      evaluated.reduce((m, d) => Math.max(m, Math.abs(d.optionsLegDrift)), 0),
    ),
    priorOptionsLagDates,
    priorOptionsLagEligibleDates,
    priorOptionsLagGapSuppressedDates,
    // TRA-2630 AC2 — a red book wins outright; otherwise green REQUIRES at least
    // one gradeable session, and an ungradeable book reads NOT MEASURED.
    priorOptionsLagOk:
      priorOptionsLagDates.length > 0
        ? false
        : priorOptionsLagEligibleDates.length > 0
          ? true
          : null,
    equityAbsorbedOptionsOk,
    counterDurable,
    counterResetDates,
    counterFrozenDates,
    counterFrozenGradeableDates,
    counterGapSuppressedDates,
    counterNonDurableDates,
    unbookedEquityMoveDates,
    maxUnbookedEquityMoveUsd: round2(
      days.reduce((m, d) => Math.max(m, Math.abs(d.unbookedEquityMoveUsd ?? 0)), 0),
    ),
    postBaselineEquityGrowth,
    postBaselineEquityGrowthSpansEquitySourceEras,
    equitySourceEraBoundary,
    postBaselineOptionsRealized,
    postBaselineStockDaily,
    liveOptionsOnsetDate,
    optionsRealizedBeforeLiveOnsetUsd,
    preLiveOnsetOptionsDates: preLiveOnsetRows.map(d => d.date),
    postOnsetCredit,
    uncreditedOptionsUsd: uncreditedOptionsNotMeasuredReason !== null || postBaselineEquityGrowth == null
      ? null
      : round2(postBaselineOptionsRealized + postBaselineStockDaily - postBaselineEquityGrowth),
    uncreditedOptionsNotMeasuredReason,
    optionsCreditedMeasuredCount: creditMeasurableDays.length,
    optionsCreditedDates,
    optionsCreditedLatest: creditWritten.length === 0
      ? null
      : creditWritten[creditWritten.length - 1]!.optionsCreditedCumulative,
    closingEquityLatest: equityWritten.length === 0
      ? null
      : equityWritten[equityWritten.length - 1]!.closingEquity,
    closingEquityLatestDate: equityWritten.length === 0
      ? null
      : equityWritten[equityWritten.length - 1]!.date,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
