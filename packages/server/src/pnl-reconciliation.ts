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
 * Each is falsifiable on its own axis and each has a reachable green state.
 * Grade THOSE. `drift` is now documented as their sum, not a single error.
 */
export const PNL_DRIFT_DECOMPOSITION_NOTE =
  'TRA-2630: `drift` pools a LOSSY stock leg (EOD `realizedPnl`, cleared by the TRA-219 21:00 ET archive) against a DURABLE one (snapshot `dailyPnl`, an equity delta), so it cannot attribute a mismatch. Grade `stockLegOk` / `optionsLegOk` instead — `drift`, `ok` and `maxDriftUsd` are retained unchanged for existing consumers but are NOT gradeable.';

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
   * TRA-2630 — the STOCK-leg verdict, baseline-gated exactly like `ok`. False
   * iff some evaluated day's |`stockLegDrift`| exceeds the tolerance.
   *
   * THIS is what a gate should read instead of `ok` when it means "the equity
   * book and the EOD report agree about stock P&L". It has a reachable green
   * state (a day with no stock activity scores 0 on both sides) and exactly one
   * cause, so a fix moves it.
   */
  stockLegOk: boolean;
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
  /** TRA-2630 AC3 — false iff at least one `priorOptionsLagDates` entry was found. */
  priorOptionsLagOk: boolean;
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
  for (let i = 1; i < days.length; i++) {
    const cur = days[i]!;
    const prev = days[i - 1]!;
    if (Math.abs(cur.stockDaily) <= PNL_RECONCILE_TOLERANCE_USD) continue;
    if (Math.abs(cur.stockDaily - prev.optionsDaily) <= PNL_RECONCILE_TOLERANCE_USD) {
      cur.lagsPriorOptionsDaily = true;
    }
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
  const priorOptionsLagDates = days.filter(d => d.lagsPriorOptionsDaily).map(d => d.date);
  // TRA-2302 — the false-zero sweep is NOT baseline-gated. The baseline exists
  // because pre-fix code wrote arithmetically un-reconcilable drift; a missing
  // option close is a different defect, and silencing it before 2026-07-12
  // would hide exactly the history the parent (TRA-2297) is arguing about.
  const falseZeroDates = days.filter(d => d.optionsFalseZero).map(d => d.date);

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
    stockLegOk: stockLegOffendingDates.length === 0,
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
    priorOptionsLagOk: priorOptionsLagDates.length === 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
