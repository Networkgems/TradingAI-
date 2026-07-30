import type { DailySnapshot } from './pnl-tracker.js';

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
 *   `optionsLegOk`  — TRUE. Options-vs-options, identity exact on 167/167 live
 *                     rows, 70 rows carry a non-zero `eodOptionsPnl` so it can
 *                     move, and 0 of its 7 offenders are explained by
 *                     `stockDaily`. This is the gradeable one.
 *   `stockLegOk`    — FALSE. `eodStockPnl` is the report's `realizedPnl`, which
 *                     the TRA-219 archive zeroes at the same 21:00 ET the report
 *                     is written: 167/167 live rows read exactly 0.00, including
 *                     all 40 with a non-zero `stockDaily`. Decomposing did not
 *                     rescue this leg — it only made its ONE cause legible. It is
 *                     now TRI-STATE and reports `null` = NOT MEASURED.
 *
 * So: grade `optionsLegOk`. Read `stockLegDrift` as EVIDENCE (it correctly
 * attributes where the pooled error lives) but never as a VERDICT.
 */
export const PNL_DRIFT_DECOMPOSITION_NOTE =
  'TRA-2630: `drift` pools a LOSSY stock leg (EOD `realizedPnl`, cleared by the TRA-219 21:00 ET archive) against a DURABLE one (snapshot `dailyPnl`, an equity delta), so it cannot attribute a mismatch. `drift`, `ok` and `maxDriftUsd` are retained unchanged for existing consumers but are NOT gradeable. TRA-2633 CORRECTION: this note previously said to grade `stockLegOk` / `optionsLegOk`. Grade **`optionsLegOk` only** — it is options-vs-options and verified Defect-A-immune (identity exact on 167/167 live rows, 0 of 7 offenders explained by `stockDaily`). `stockLegOk` inherits the SAME lossy source `drift` does and is now TRI-STATE: `null` = NOT MEASURED, which is what the live fleet returns today. Treating that `null` as a pass is the bug this correction exists to stop.';

/** Two legers never reconciled — surfaced in the endpoint output as a caveat. */
export const PNL_RECONCILIATION_CAVEATS = [
  'The account calendar reads the user\'s personal engine book; the Desk calendar + demo back-fill read the firm-wide option-trade-journal.jsonl — the SAME date can show different numbers for the operator vs the trading accounts. These two ledgers are never reconciled by design.',
  '/api/health/option-journal folds ALL modes; the Desk calendar filters mode:\'demo\'. Comparing the two mixes live rows into one side.',
  PNL_DRIFT_DECOMPOSITION_NOTE,
];

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
  /** Option round trips the journal recorded closing on this ET day. */
  closes: number;
  /** Σ realized P&L over those closes, USD. */
  realizedPnlUsd: number;
}

export interface PnlReconcileDay {
  date: string;
  /** EOD report `combinedPnl` for the day (null when no report file exists). */
  eodCombined: number | null;
  /** PnL-tracker stock-only realized daily P&L. */
  stockDaily: number;
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
  /** TRA-2302 — Σ realized options P&L the journal recorded for this ET day. */
  journalOptionsPnl: number | null;
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
   */
  closingEquity: number;
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
  /** eodCombined − (stockDaily + optionsDaily); 0 when no EOD file to compare. */
  drift: number;
  /**
   * TRA-1636 — true when `date` predates the reconciliation baseline, i.e. the
   * snapshot was written by pre-fix (buggy) code. The row is still returned for
   * transparency but its drift never affects `ok` / `offendingDates` / maxDrift.
   */
  belowBaseline: boolean;
}

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
  /** TRA-2630 — max |`stockLegDrift`| over evaluated days, USD. */
  maxStockLegDriftUsd: number;
  /**
   * TRA-2630 — the OPTIONS-leg verdict, baseline-gated exactly like `ok`. False
   * iff some evaluated day's |`optionsLegDrift`| exceeds the tolerance. This is
   * the criterion CEO's TRA-2633 redirected the TRA-2625 grade onto, now
   * computed on the row rather than by hand off the raw day list.
   */
  optionsLegOk: boolean;
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
   */
  counterDurable: boolean | null;
  /** TRA-2635 — the sessions that prove the reset. Empty is the passing state. */
  counterResetDates: string[];
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
  /** TRA-2635 — the three operands, published so the subtraction is checkable. */
  postBaselineEquityGrowth: number | null;
  postBaselineOptionsRealized: number;
  postBaselineStockDaily: number;
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
    optionsCreditedMeasuredCount: number;
    optionsCreditedLatest: number | null;
    optionsCreditedDates: string[];
    closingEquityLatest: number | null;
    closingEquityLatestDate: string | null;
    uncreditedOptionsUsd: number | null;
    postBaselineEquityGrowth: number | null;
    postBaselineOptionsRealized: number;
    postBaselineStockDaily: number;
  }>,
): {
  liveCreditBookCount: number;
  liveEquityAbsorbedOptionsOk: boolean | null;
  liveUncreditedOptionsUsd: number | null;
  liveCreditBooks: Array<Record<string, unknown>>;
} {
  const liveBooks = engines.filter(e => e.mode === 'live');
  const measurable = liveBooks.filter(e => e.uncreditedOptionsUsd != null);
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
    liveUncreditedOptionsUsd: measurable.length === 0
      ? null
      : round2(measurable.reduce((s, e) => s + (e.uncreditedOptionsUsd ?? 0), 0)),
    // Named, not anonymized: this endpoint already publishes each book's full
    // per-session P&L series under its username, and an unnamed red verdict on
    // real capital is not actionable.
    liveCreditBooks: liveBooks.map(e => ({
      username: e.username,
      equityAbsorbedOptionsOk: e.equityAbsorbedOptionsOk,
      counterDurable: e.counterDurable,
      optionsCreditedMeasuredCount: e.optionsCreditedMeasuredCount,
      optionsCreditedLatest: e.optionsCreditedLatest,
      optionsCreditedDates: e.optionsCreditedDates,
      closingEquityLatest: e.closingEquityLatest,
      closingEquityLatestDate: e.closingEquityLatestDate,
      uncreditedOptionsUsd: e.uncreditedOptionsUsd,
      postBaselineEquityGrowth: e.postBaselineEquityGrowth,
      postBaselineOptionsRealized: e.postBaselineOptionsRealized,
      postBaselineStockDaily: e.postBaselineStockDaily,
    })),
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
export function foldJournalClosesByEtDay(
  rows: ReadonlyArray<{ closeTs?: number; realizedPnlUsd?: number }>,
  etDate: (ts: number) => string,
): Map<string, JournalDayCloses> {
  const byDay = new Map<string, JournalDayCloses>();
  for (const r of rows) {
    if (typeof r.closeTs !== 'number' || !Number.isFinite(r.closeTs)) continue;
    const day = etDate(r.closeTs);
    const cur = byDay.get(day) ?? { closes: 0, realizedPnlUsd: 0 };
    cur.closes += 1;
    cur.realizedPnlUsd += r.realizedPnlUsd ?? 0;
    byDay.set(day, cur);
  }
  for (const [day, v] of byDay) byDay.set(day, { ...v, realizedPnlUsd: round2(v.realizedPnlUsd) });
  return byDay;
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
): PnlReconcileResult {
  const days: PnlReconcileDay[] = [...snapshots]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(s => {
      const stockDaily = round2(s.dailyPnl);
      const optionsFieldPresent = s.optionsDailyPnl !== undefined && s.optionsDailyPnl !== null;
      const optionsDaily = round2(s.optionsDailyPnl ?? 0);
      const eodCombined = eodCombinedByDate.has(s.date)
        ? round2(eodCombinedByDate.get(s.date)!)
        : null;
      const drift = eodCombined == null ? 0 : round2(eodCombined - (stockDaily + optionsDaily));
      const belowBaseline = baselineDate != null && s.date < baselineDate;
      // TRA-2302 — a day is only claimed as a FALSE zero when a census exists
      // for this book AND it names closes the day-only ledger did not receive.
      // No census ⇒ null / false, never an implied zero.
      const census = journalClosesByDate?.get(s.date) ?? null;
      const journalCloses = journalClosesByDate == null ? null : (census?.closes ?? 0);
      const journalOptionsPnl =
        journalClosesByDate == null ? null : round2(census?.realizedPnlUsd ?? 0);
      // TRA-2642 (found grading TRA-2625) — a day whose closes net EXACTLY $0.00
      // books 0.00 correctly: the snapshot and the journal AGREE, and agreement at
      // zero is not a false zero. Without the `journalOptionsPnl !== 0` term such a
      // day is flagged forever — the repair cannot clear it either, because moving
      // 0 → 0 is not a move (`planOptionsDailyPnlRepair`) — so `optionsFalseZeroOk`
      // has no passing state at all. Live proof: `ctoverify_tra2227` /
      // `ctoverify_tra2329` held `falseZeroDates:['2026-07-27']` while the repair
      // re-ran `0.00->0.00` on 34 consecutive boots. The day stays fully visible via
      // `journalCloses` / `journalOptionsPnl` on the row; only the accusation goes.
      const optionsFalseZero =
        (journalCloses ?? 0) > 0 && optionsDaily === 0 && (journalOptionsPnl ?? 0) !== 0;
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
        optionsFieldPresent,
        journalCloses,
        journalOptionsPnl,
        optionsFalseZero,
        eodOptionsPnl,
        optionsDailyPnlSource: s.optionsDailyPnlSource ?? null,
        optionsDailyPnlBucket:
          s.optionsDailyPnlBucket !== undefined && s.optionsDailyPnlBucket !== null
            ? round2(s.optionsDailyPnlBucket)
            : null,
        closingEquity: round2(s.closingEquity),
        optionsCreditedCumulative,
        // TRA-2635 — filled in by the second pass below; it needs the PRIOR row.
        optionsCreditedInWindow: null,
        drift,
        belowBaseline,
      };
    });

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
  for (let i = 1; i < days.length; i++) {
    const cur = days[i]!;
    const prev = days[i - 1]!;
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

  const evaluated = days.filter(d => !d.belowBaseline);
  const offendingDates = evaluated
    .filter(d => Math.abs(d.drift) > PNL_RECONCILE_TOLERANCE_USD)
    .map(d => d.date);
  const maxDriftUsd = evaluated.reduce((m, d) => Math.max(m, Math.abs(d.drift)), 0);
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
  const priorOptionsLagDates = days.filter(d => d.lagsPriorOptionsDaily).map(d => d.date);
  const priorOptionsLagEligibleDates = days
    .filter(d => d.priorOptionsLagEligible)
    .map(d => d.date);
  // TRA-2302 — the false-zero sweep is NOT baseline-gated. The baseline exists
  // because pre-fix code wrote arithmetically un-reconcilable drift; a missing
  // option close is a different defect, and silencing it before 2026-07-12
  // would hide exactly the history the parent (TRA-2297) is arguing about.
  const falseZeroDates = days.filter(d => d.optionsFalseZero).map(d => d.date);
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
  const counterDurable: boolean | null =
    creditWrittenDays.length === 0 ? null : counterResetDates.length === 0;
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
  const postBaselineEquityGrowth = evaluatedEquity.length < 2
    ? null
    : round2(
      evaluatedEquity[evaluatedEquity.length - 1]!.closingEquity - evaluatedEquity[0]!.closingEquity,
    );
  const postBaselineOptionsRealized = round2(spanned.reduce((s, d) => s + d.optionsDaily, 0));
  const postBaselineStockDaily = round2(spanned.reduce((s, d) => s + d.stockDaily, 0));

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
    optionsLegOk: optionsLegOffendingDates.length === 0,
    optionsLegOffendingDates,
    maxOptionsLegDriftUsd: round2(
      evaluated.reduce((m, d) => Math.max(m, Math.abs(d.optionsLegDrift)), 0),
    ),
    priorOptionsLagDates,
    priorOptionsLagEligibleDates,
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
    postBaselineEquityGrowth,
    postBaselineOptionsRealized,
    postBaselineStockDaily,
    uncreditedOptionsUsd: postBaselineEquityGrowth == null
      ? null
      : round2(postBaselineOptionsRealized + postBaselineStockDaily - postBaselineEquityGrowth),
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
