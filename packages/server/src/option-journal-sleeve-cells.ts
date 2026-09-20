import {
  GATE_R_BASIS_STRUCTURES,
  GATE_R_PER_PREMIUM_R,
  type OptionTradeJournalRecord,
  type OptionTradeSupersededClose,
} from './option-trade-journal.js';
import {
  UNSPECIFIED_ENTRY_ARCHETYPE,
  classifySpreadCeilingAccount,
  SPREAD_CEILING_ACCOUNT_CLASSES,
  type SpreadCeilingAccountClass,
} from './option-spread-cost.js';
import { etDateKey, etWallClockToUtcMs } from './et-clock.js';

// TRA-3715 (split out of TRA-3709) — the cell a sleeve grade can legally be read
// from, and the two things that have to sit ON it before it is legal.
//
// ── What manufactured TRA-3682 and TRA-3709 ─────────────────────────────────
//
// `/api/health/option-journal` publishes `byAccountClass.{desk,fixture,
// unattributed}`, and inside each class `byStructure`, `byArchetype`,
// `byExitReason` and `byStructureExit`. Every one of those is either a MARGINAL
// or a LIFETIME aggregate, so two tickets in a row did the only thing left: pull
// `rows[]` and re-fold by hand. `rows[]` carries no `accountClass`, so the
// hand-fold silently pooled QA fixture books — 92.8% of the array — into a
// number published as a desk sleeve baseline. Both tickets shipped a fabricated
// positive.
//
// THREE independent defects, each sufficient on its own:
//
//  1. **No `structure × entryArchetype` cell.** TRA-3682's stated rule, restated
//     as a hard rule in TRA-3709, is "do NOT grade on `structure` alone —
//     `structure × entryArchetype` only". The route offered exactly the axis the
//     rule forbids and not the one it mandates: live `byAccountClass.desk
//     .byStructure` reports `single_leg_rv closed=83` while `single_leg_rv` rows
//     carry THREE archetypes (`<none>` / `directional` / `iv-rv-buy-premium`).
//
//  2. **No date window on the exit axis.** Every cell was a lifetime aggregate,
//     so every windowed grade — which is every grade anyone needs — had to leave
//     the published surface. See {@link resolveEtDayCloseWindow}.
//
//  3. **No strategy-vs-harness exit split.** `manual` and `take_profit_early`
//     are QA/harness close paths, not sleeve behaviour. On TRA-3709's window
//     they were 18 rows at avgR +0.7409 and 34 rows at avgR +0.4655 — and they
//     carried the ENTIRE positive baseline for both sleeves. Strip them and
//     `single_leg_directional` window A goes +0.1193 → −0.0453 and
//     `single_leg_otm` +0.2098 → −0.0459: both sleeves were already negative
//     before the "flip" they were reported to have flipped from.
//
// ── The recurring shape ─────────────────────────────────────────────────────
//
// A published sleeve `avgR` reads IDENTICALLY whether it came from strategy
// exits on desk books or from QA hand-closes on fixture books. There was no
// field on the wire separating those two states, which is how a +0.12 baseline
// survived two tickets, a −$2,761.71 Impact section and a pre-registered
// invalidation rule calibrated against it. The failure is silent and biased
// POSITIVE — fixture books hand-closed at a profit inflate the very sleeve a
// promotion decision would read.
//
// Everything below exists to make that state unrepresentable rather than merely
// fixed: the class is ON the cell, the archetype is ON the cell, the exit owner
// is a NAMED TABLE on the wire, and a thin cell says `UNDERPOWERED` instead of
// shipping a bare mean that reads like a verdict.

/**
 * Who owns the exit that closed a trade.
 *
 * `unknown` is a first-class value, not a shrug. Two populations need it and
 * both must stay OUT of the strategy number:
 *
 *  - a close whose `exitReason` is absent, or one the table below has never
 *    seen. A close path added tomorrow would otherwise land in the strategy
 *    slice invisibly — which is defect 3 above, one build later.
 *  - `reconstructed-TRA-3472`, where the row's real exit was LOST and the close
 *    was rebuilt by a repair tool. The trade is real; the exit is not evidence
 *    of anything the strategy did.
 */
export type OptionExitOwner = 'strategy' | 'harness' | 'unknown';

/** One row of {@link OPTION_EXIT_REASON_TABLE}. */
export interface OptionExitReasonRule {
  /** The `exitReason` string exactly as the journal writes it. */
  reason: string;
  owner: OptionExitOwner;
  /** Why it is owned that way — this is the rule, in words, on the wire. */
  why: string;
}

/**
 * TRA-3715 item 3 — the exit-owner partition, AS DATA.
 *
 * The ticket asks for this as "a table, not filter-expression order", and the
 * distinction is the whole point. An inline `r.exitReason !== 'manual' &&
 * r.exitReason !== 'take_profit_early'` at the fold site is invisible to a
 * reader of the payload, cannot be tested apart from the fold, and grows a third
 * clause silently. A table can be published, diffed, and mutated by a test.
 *
 * ⚠ EVERY exit reason observed in the live journal is listed, so nothing real
 * falls through to `unknown` today (measured 2026-08-14 against live
 * `0e9f0e8bb4b6`, n=2,722 closed: manual 813, sl 580, supertrend_flip 364,
 * time_stop 298, ma20_close_through 211, trail 171, chandelier 132,
 * book_halt_flat 75, take_profit_early 43, profit_lock 28,
 * reconstructed-TRA-3472 7). A reason NOT on this list is reported by
 * `unclassifiedExitReasons` on the grid rather than being absorbed — an
 * unrecognised close must be loud, because "silently counted as strategy" is
 * exactly the defect.
 */
export const OPTION_EXIT_REASON_TABLE: readonly OptionExitReasonRule[] = [
  {
    reason: 'manual',
    owner: 'harness',
    why:
      'A hand-close. On QA fixture books this is the harness flattening a position, not the '
      + 'sleeve taking an exit. TRA-3709 window: 18 rows at avgR +0.7409, carrying the entire '
      + 'positive baseline of the sleeve it was pooled into.',
  },
  {
    reason: 'take_profit_early',
    owner: 'harness',
    why:
      'SPLIT BY ROW (TRA-4759): `strategy` for a `mode: \'live\'` row with closeTs >= '
      + '1789912043779 (2026-09-20T13:47:23.779Z, the instant TAKE_PROFIT_EARLY_LIVE_ENABLED '
      + 'armed on bqb1 and the ENGINE started choosing this exit on real money); `harness` '
      + 'otherwise — the demo/QA capture path and every pre-arm row, including TRA-3709\'s 34 '
      + 'rows at avgR +0.4655, whose baseline a blanket flip would corrupt. The `owner` on this '
      + 'table row is the PRE-ARM base rule; `classifyOptionExitOwnerForRow` applies the split.',
  },
  {
    reason: 'reconstructed-TRA-3472',
    owner: 'unknown',
    why:
      'The close was REBUILT by the TRA-3472 repair path after the original close row was '
      + 'lost. The realized P&L is a fact; the exit that produced it is not recoverable, so '
      + 'the row is not evidence of strategy behaviour in either direction.',
  },
  { reason: 'sl', owner: 'strategy', why: 'The sleeve\'s hard stop fired.' },
  { reason: 'supertrend_flip', owner: 'strategy', why: 'Structural exit — the supertrend regime flipped against the position.' },
  { reason: 'time_stop', owner: 'strategy', why: 'The sleeve\'s own max-hold timer expired.' },
  { reason: 'ma20_close_through', owner: 'strategy', why: 'Structural exit — price closed through the 20-period MA.' },
  { reason: 'trail', owner: 'strategy', why: 'The sleeve\'s trailing stop fired.' },
  { reason: 'chandelier', owner: 'strategy', why: 'The sleeve\'s chandelier trailing stop fired.' },
  { reason: 'profit_lock', owner: 'strategy', why: 'The sleeve\'s profit-lock rule fired.' },
  {
    reason: 'book_halt_flat',
    owner: 'strategy',
    why:
      'The book-level halt flattened the position. Owned by the STRATEGY side deliberately: '
      + 'the halt is an in-engine risk control the sleeve is genuinely subject to on a real '
      + 'desk book, unlike a QA hand-close. Judgement call — 75 rows all-time, 3 rows / '
      + '+0.025R total inside TRA-3709\'s fixture window, so it moves no acceptance number. '
      + 'Flip it here, in one place, if the desk rules otherwise.',
  },
];

const EXIT_OWNER_BY_REASON: ReadonlyMap<string, OptionExitOwner> = new Map(
  OPTION_EXIT_REASON_TABLE.map((r) => [r.reason, r.owner] as const),
);

/** Owner order used for the per-cell slices and for the sum check. */
export const OPTION_EXIT_OWNERS: readonly OptionExitOwner[] = ['strategy', 'harness', 'unknown'];

/**
 * Classify one `exitReason` through {@link OPTION_EXIT_REASON_TABLE}.
 *
 * Absent / blank / unlisted ⇒ `unknown`, NEVER `strategy`. Same fail-closed
 * branch as `classifySpreadCeilingAccount`'s absent ⇒ `unattributed`: defaulting
 * an unrecognised close to the strategy side would manufacture strategy evidence
 * out of a row whose provenance nobody has established.
 */
export function classifyOptionExitOwner(exitReason: string | null | undefined): OptionExitOwner {
  if (typeof exitReason !== 'string') return 'unknown';
  const trimmed = exitReason.trim();
  if (trimmed.length === 0) return 'unknown';
  return EXIT_OWNER_BY_REASON.get(trimmed) ?? 'unknown';
}

/**
 * TRA-4759 item 4 — the instant `TAKE_PROFIT_EARLY_LIVE_ENABLED` armed on bqb1
 * (boot 2026-09-20T13:47:23.779Z, commit `e2b542538dbc`). From this instant a
 * live `take_profit_early` close is the ENGINE's own choice, not a harness
 * hand-close, and a grader following this surface's own instruction ("grade a
 * sleeve on `strategyExits`") must be able to see it.
 */
export const TAKE_PROFIT_EARLY_LIVE_STRATEGY_SINCE_TS = 1789912043779;

/**
 * TRA-4759 item 4 — the ROW-conditional owner. `take_profit_early` was a
 * harness/QA close path while the flag was demo-only, and from
 * {@link TAKE_PROFIT_EARLY_LIVE_STRATEGY_SINCE_TS} it is the live engine's own
 * exit — so ownership is a function of the row, not of the label alone:
 * `strategy` for a `mode: 'live'` row closed at or after the arm instant,
 * the reason-table's owner (`harness`) otherwise. ⛔ Deliberately NOT a
 * blanket table flip: that would relabel TRA-3709's 34 pre-arm harness rows
 * (avgR +0.4655) and corrupt the exact baseline TRA-4758's pre-registration
 * freezes. Every other reason delegates to {@link classifyOptionExitOwner}.
 */
export function classifyOptionExitOwnerForRow(
  row: Pick<OptionTradeJournalRecord, 'exitReason' | 'mode' | 'closeTs'>,
): OptionExitOwner {
  const reason = typeof row.exitReason === 'string' ? row.exitReason.trim() : '';
  if (
    reason === 'take_profit_early'
    && row.mode === 'live'
    && typeof row.closeTs === 'number'
    && row.closeTs >= TAKE_PROFIT_EARLY_LIVE_STRATEGY_SINCE_TS
  ) {
    return 'strategy';
  }
  return classifyOptionExitOwner(row.exitReason);
}

/**
 * TRA-3715 item 4 — below this many closes a cell is labelled `UNDERPOWERED`
 * and its mean must not be read as a verdict.
 *
 * 20 is the ticket's number, and it binds hard: every desk sleeve cell in
 * TRA-3709's window is n ≤ 15, i.e. the entire population that produced the
 * fabricated baseline is on the wrong side of this line.
 */
export const SLEEVE_CELL_MIN_N = 20;

export type SleeveCellPower = 'UNDERPOWERED' | 'POWERED';

/** `n < SLEEVE_CELL_MIN_N` ⇒ UNDERPOWERED. n = 0 is underpowered, never absent. */
export function sleeveCellPower(n: number): SleeveCellPower {
  return n >= SLEEVE_CELL_MIN_N ? 'POWERED' : 'UNDERPOWERED';
}

/** One exit-owner slice of a cell (or the `all` slice over every close). */
export interface OptionSleeveExitSlice {
  /** `all` = every closed row in the cell; otherwise the owner this slice folds. */
  exitOwner: OptionExitOwner | 'all';
  /** Closed rows in this slice. */
  n: number;
  win: number;
  loss: number;
  scratch: number;
  winRate: number | null;
  /** Mean realized R, PREMIUM basis. `null` at n = 0 — never 0. */
  avgR: number | null;
  /** Sample SD (n−1) of realized R; null below n = 2. */
  sdR: number | null;
  /** Standard error of the mean; null below n = 2. */
  seR: number | null;
  realizedPnlUsd: number;
  /**
   * TRA-3715 item 4. A bare `avgR` reads like a verdict at any n; this is the
   * label that stops it. Emitted on EVERY slice including `all`, because the
   * pooled slice is the one a hurried reader grabs.
   */
  power: SleeveCellPower;
  underpowered: boolean;
  minSampleForVerdict: number;
}

/**
 * TRA-4246 (AC4) — ONE closed row whose headline `exitReason` was written by a
 * SUPERSEDE, naming both reasons. See {@link OptionSleeveCellGrid.exitReasonSupersedes}.
 */
export interface OptionSleeveExitReasonSupersede {
  journalId: string;
  optionSymbol: string;
  accountClass: SpreadCeilingAccountClass;
  structure: string;
  /** What `byExitReason` counts this row under TODAY. */
  headlineExitReason: string;
  headlineBrokerOrderId: string | number | null;
  /** What the displaced close said — the reason the fold is no longer counting. */
  supersededExitReason: string;
  supersededBrokerOrderId: string | number | null;
  supersededCloseTs: number;
  /** The writer, e.g. `engine_close_on_already_closed_row`. */
  supersedeReason: string;
  supersededAt: number;
}

/**
 * TRA-4246 (AC3) — the premium→stop-basis R divisor, MEASURED on a cell's rows.
 * See {@link OptionSleeveCell.stopRPerPremiumR}.
 */
export interface OptionSleeveStopBasisDivisor {
  /** Closed rows in the cell carrying a per-row divisor. Never 0 (the field is null instead). */
  n: number;
  /**
   * Closed rows carrying NONE — pre-stamp closes plus rows whose stop was
   * unarmed at the close. Published so `n` is read against its own
   * denominator: `n = 1, missing = 40` is not a cell-wide conversion.
   */
  missing: number;
  min: number;
  max: number;
  /** Lower median at even n — a real observed row's divisor, never an interpolation. */
  median: number;
  /**
   * `max − min < 1e-9`. TRUE ⇒ a single divisor describes every measured row.
   * FALSE ⇒ it does not, and a reader must convert PER ROW.
   */
  unanimous: boolean;
}

/**
 * Per-exit-reason attribution inside one cell — how the slices were built.
 * TRA-4759 — keyed by (reason, ROW-owner): a reason whose ownership is
 * row-conditional (`take_profit_early`, split at the live-arm instant) appears
 * once per owner, so `owner` is true of every row the entry counts.
 */
export interface OptionSleeveExitReasonStat {
  exitReason: string;
  owner: OptionExitOwner;
  closed: number;
  avgR: number | null;
  realizedPnlUsd: number;
}

/**
 * TRA-3715 item 1 — ONE `accountClass × structure × entryArchetype` cell.
 *
 * All three axes are ON the cell as fields, never encoded into a joined key a
 * consumer has to split: an archetype label is free-form and a split key that
 * re-parses wrong silently RELABELS a cell, which is the one error this whole
 * surface exists to make impossible (same reasoning as `crossTabStructureExit`).
 */
export interface OptionSleeveCell {
  accountClass: SpreadCeilingAccountClass;
  structure: string;
  /** `UNSPECIFIED_ENTRY_ARCHETYPE` when the row stamped none. Never dropped. */
  entryArchetype: string;
  /** Stable display key `accountClass|structure|entryArchetype`. Derived, never parsed back. */
  cell: string;
  /** All rows in the cell, open + closed. */
  total: number;
  open: number;
  /** Every closed row — the number a naive read grabs, labelled with its power. */
  all: OptionSleeveExitSlice;
  /** The number a sleeve grade may actually cite. */
  strategyExits: OptionSleeveExitSlice;
  harnessExits: OptionSleeveExitSlice;
  unknownExits: OptionSleeveExitSlice;
  /** `strategy + harness + unknown === all.n`. False ⇒ the split lost a row. */
  exitOwnerCountsSumToClosed: boolean;
  /** Non-empty reasons in the cell, descending by count. Empty at n = 0. */
  byExitReason: OptionSleeveExitReasonStat[];
  /**
   * The COST-AWARE GATE's premium→R factor (4 = `1 / STOP_DISTANCE_FRACTION_OF_MARK`)
   * where the structure has a valid conversion, else null.
   *
   * ⛔ TRA-4246 (AC3) — THIS IS NOT THE SLEEVE'S STOP. It is the gate's MODEL
   * of a stop (`mark × 0.75`), used to price spread-cross in R at admission.
   * The OTM sleeve that actually trades stops at `OTM_OPTIONS_SL_PCT 0.20` —
   * `premium × 0.80`, a **5×**. Converting a premium-R figure to stop-basis R
   * through this constant understates the magnitude by 20% on that sleeve, and
   * that is not hypothetical: it is what happened to every row of the CFO's
   * TRA-4243 give-back table, because this was the only divisor any surface
   * published. Read {@link stopRPerPremiumR} instead — it is MEASURED on this
   * cell's own rows and cannot be wrong about which sleeve it describes.
   */
  gateRPerPremiumR: number | null;
  /**
   * TRA-4246 (AC3) — the premium→stop-basis R factor MEASURED on this cell's
   * own closed rows, `null` when no row in the cell carries one.
   *
   * Each closed row stamps its own `premiumPaid ÷ |premiumPaid −
   * stopLossPremium|` at the close (TRA-4246 AC1). This folds them. It is not a
   * constant, not a table keyed on sleeve, and not a default — a cell whose
   * rows all predate the stamp, or all closed with an unarmed stop, publishes
   * `null` and a reader learns that the conversion is unavailable rather than
   * being handed the gate's number by omission.
   *
   * `unanimous` is the field that matters for a fold: TRUE ⇒ one stop rule
   * governed every measured row in the cell and a single divisor is a sound
   * summary of it. FALSE ⇒ the cell spans rows with different stop distances
   * (a re-tune mid-window, an adopted lot, a pinned stop) and NO single divisor
   * describes it — which is exactly the "one constant cannot cover mixed
   * sleeves" failure, caught here instead of shipped as a number.
   */
  stopRPerPremiumR: OptionSleeveStopBasisDivisor | null;
  /**
   * True when this cell exists only because the axis floor demanded it — no row
   * in the filtered set landed here. Published so "no trades" is a POSITIVE
   * assertion rather than an absence a reader has to notice (TRA-3682: the
   * sleeve that opened ZERO trades for 14 sessions was invisible precisely
   * because its cell was missing, and a missing cell reads like a passing one).
   */
  emptyByConstruction: boolean;
}

/** One `(structure, entryArchetype)` pair the grid spans. */
export interface OptionSleeveAxisPair {
  structure: string;
  entryArchetype: string;
}

/**
 * The sleeve cells that MUST be emitted whether or not any row lands in them.
 *
 * TRA-3682 is the argument: a sleeve that has stopped trading entirely
 * disappears from every count-derived rollup, and an absent cell reads exactly
 * like a healthy one. These five pairs are the option sleeves currently under
 * grade; a dark one now reports `n = 0, UNDERPOWERED, emptyByConstruction:true`.
 */
export const OPTION_SLEEVE_AXIS_FLOOR: readonly OptionSleeveAxisPair[] = [
  { structure: 'single_leg_directional', entryArchetype: 'directional' },
  { structure: 'single_leg_otm', entryArchetype: UNSPECIFIED_ENTRY_ARCHETYPE },
  { structure: 'single_leg_rv', entryArchetype: UNSPECIFIED_ENTRY_ARCHETYPE },
  { structure: 'single_leg_rv', entryArchetype: 'directional' },
  { structure: 'single_leg_rv', entryArchetype: 'iv-rv-buy-premium' },
];

/** The grid plus the checks that keep it honest. */
export interface OptionSleeveCellGrid {
  /**
   * Every `accountClass × structure × entryArchetype` cell — the full cross
   * product of the three classes with {@link axisPairs}, so all three classes
   * are present for every pair even at n = 0. Sorted by class, then by closed
   * count descending, then by key.
   */
  cells: OptionSleeveCell[];
  /** The three classes, always all three, in canonical order. */
  accountClasses: readonly SpreadCeilingAccountClass[];
  /** The `(structure, entryArchetype)` pairs spanned: the floor ∪ what was observed. */
  axisPairs: OptionSleeveAxisPair[];
  /** Closed rows in the filtered set. */
  closed: number;
  /** `Σ cells.all.n === closed`. False ⇒ the fold lost or double-counted a row. */
  cellsSumToClosed: boolean;
  /** `closed − Σ cells.all.n`. Published, not asserted away. */
  residual: number;
  /** Cells emitted at n = 0 (the ones a count-derived rollup would have dropped). */
  emptyCellCount: number;
  minSampleForVerdict: number;
  /** Keys of every cell below the min sample — including the n = 0 ones. */
  underpoweredCells: string[];
  /**
   * Exit reasons seen in the data that {@link OPTION_EXIT_REASON_TABLE} does not
   * list. Non-empty means somebody added a close path and this table did not
   * follow; those rows are in `unknownExits`, NOT in `strategyExits`.
   */
  unclassifiedExitReasons: string[];
  /** The classification rule itself, on the wire. */
  exitOwnerTable: readonly OptionExitReasonRule[];
  /**
   * TRA-4246 (AC4) — every closed row in this fold whose headline `exitReason`
   * was written by a SUPERSEDE over a different reason, naming both.
   *
   * ── Why a `byExitReason` count is not enough on its own ─────────────────
   * `RIG260925C00006000` closed 2026-08-24 under `sl_otm_premium_pct` (broker
   * 143048620, a filled sell). On 08-26 an `engine_close_on_already_closed_row`
   * supersede replaced that close with a DIFFERENT filled sell's (broker
   * 143384264), and the row's headline reason became `profit_lock`. Nothing on
   * any surface said so, so `byExitReason` attributed a STOP fire to the
   * give-back rule — and a −2.31R stop landed in the population whose whole
   * question is "how much does the give-back rule keep". One row is enough to
   * flip a give-back verdict at these sample sizes.
   *
   * ⛔ This list is NOT the fix for the incident. **TRA-4241 owns that**: the
   * `supersede_close` fold now refuses a supersede that would demote a close
   * the broker witnessed under a different order, keyed on the broker order and
   * not on the clock, and — because the fold is the log's interpreter — that
   * refusal applies on REPLAY to bytes already on disk. AC4 is scoped here to
   * the journal SURFACE, per this ticket's own coordination clause: publish the
   * displaced reason so the supersedes that legitimately DO apply (a
   * reconstructed close, a TRA-4082 restore) are readable as relabels instead
   * of being silently folded as give-back releases.
   *
   * Empty means no closed row in the window carries a reason-changing
   * supersede. A row whose supersede did not change the label is not listed —
   * there is nothing for a reader to correct.
   */
  exitReasonSupersedes: OptionSleeveExitReasonSupersede[];
  rBasis: 'premium';
  note: string;
}

/**
 * TRA-4246 (AC3) — fold the per-row stop-basis divisors a cell's closed rows
 * carry. `null` when none of them does, never a constant standing in.
 */
function foldStopBasisDivisor(
  closedList: OptionTradeJournalRecord[],
): OptionSleeveStopBasisDivisor | null {
  const values = closedList
    .map((r) => r.stopBasisRPerPremiumR)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const min = values[0] as number;
  const max = values[values.length - 1] as number;
  return {
    n: values.length,
    missing: closedList.length - values.length,
    min,
    max,
    // Lower median: at even n this is a divisor some row actually carried. An
    // interpolated midpoint between 4 and 5 would be 4.5 — a conversion factor
    // no sleeve in this book uses, published as if it were measured.
    median: values[Math.floor((values.length - 1) / 2)] as number,
    unanimous: max - min < 1e-9,
  };
}

function slice(
  exitOwner: OptionExitOwner | 'all',
  rows: OptionTradeJournalRecord[],
): OptionSleeveExitSlice {
  const n = rows.length;
  // Mean over the CLOSED rows using the surrounding folds' `?? 0` treatment, so
  // this column stays comparable to `byExitReason.avgR` / `byStructure.avgR`.
  // Dispersion uses the same denominator for the same reason.
  const sum = rows.reduce((a, r) => a + (r.realizedR ?? 0), 0);
  const mean = n > 0 ? sum / n : null;
  const sd =
    n > 1 && mean !== null
      ? Math.sqrt(rows.reduce((a, r) => a + ((r.realizedR ?? 0) - mean) ** 2, 0) / (n - 1))
      : null;
  return {
    exitOwner,
    n,
    win: rows.filter((r) => r.outcome === 'WIN').length,
    loss: rows.filter((r) => r.outcome === 'LOSS').length,
    scratch: rows.filter((r) => r.outcome === 'SCRATCH').length,
    winRate: n > 0 ? rows.filter((r) => r.outcome === 'WIN').length / n : null,
    avgR: mean,
    sdR: sd,
    seR: sd !== null && n > 1 ? sd / Math.sqrt(n) : null,
    realizedPnlUsd: rows.reduce((a, r) => a + (r.realizedPnlUsd ?? 0), 0),
    power: sleeveCellPower(n),
    underpowered: sleeveCellPower(n) === 'UNDERPOWERED',
    minSampleForVerdict: SLEEVE_CELL_MIN_N,
  };
}

/** The archetype bucket key for a row. `null`/absent ⇒ `UNSPECIFIED_ENTRY_ARCHETYPE`. */
export function sleeveArchetypeKey(entryArchetype: string | null | undefined): string {
  return typeof entryArchetype === 'string' && entryArchetype.length > 0
    ? entryArchetype
    : UNSPECIFIED_ENTRY_ARCHETYPE;
}

/**
 * TRA-3715 — fold journal rows into the `accountClass × structure ×
 * entryArchetype` grid, each cell split by exit owner and labelled with its
 * power. Pure.
 *
 * The account class is recomputed at READ time from the row's frozen `account`
 * string, exactly as `partitionRowsByAccountClass` does — one classifier, so
 * this grid and `byAccountClass` can never disagree for a reason that is not a
 * defect.
 */
export function foldOptionSleeveCells(rows: OptionTradeJournalRecord[]): OptionSleeveCellGrid {
  const closedRows = rows.filter((r) => r.outcome !== 'OPEN');

  // The spanning set: the declared floor first (stable order), then anything
  // else the data actually contains. Union, never "whichever the data has" —
  // that is the drop this ticket is about.
  const pairKey = (structure: string, archetype: string) => JSON.stringify([structure, archetype]);
  const pairs = new Map<string, OptionSleeveAxisPair>();
  for (const p of OPTION_SLEEVE_AXIS_FLOOR) {
    pairs.set(pairKey(p.structure, p.entryArchetype), { ...p });
  }
  for (const r of rows) {
    const archetype = sleeveArchetypeKey(r.entryArchetype);
    const key = pairKey(r.structure, archetype);
    if (!pairs.has(key)) pairs.set(key, { structure: r.structure, entryArchetype: archetype });
  }

  // Bucket every row once, keyed on all three axes carried BESIDE the rows.
  const buckets = new Map<string, OptionTradeJournalRecord[]>();
  const cellKey = (klass: string, structure: string, archetype: string) =>
    JSON.stringify([klass, structure, archetype]);
  for (const r of rows) {
    const klass = classifySpreadCeilingAccount(r.account);
    const key = cellKey(klass, r.structure, sleeveArchetypeKey(r.entryArchetype));
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }

  // A table GAP, not merely an `unknown` owner. `reconstructed-TRA-3472` IS on
  // the table and IS owned `unknown` on purpose — reporting it here would pin
  // this list permanently non-empty, and a signal that is always on is not a
  // signal. Only a reason that was WRITTEN and is ABSENT from the table counts;
  // an absent reason is its own already-modelled state.
  const unclassified = new Set<string>();
  for (const r of closedRows) {
    if (typeof r.exitReason !== 'string') continue;
    const reason = r.exitReason.trim();
    if (reason.length === 0) continue;
    if (!EXIT_OWNER_BY_REASON.has(reason)) unclassified.add(reason);
  }

  // TRA-4246 (AC4) — every closed row in the fold whose headline `exitReason`
  // was WRITTEN BY A SUPERSEDE rather than by the close that realized the P&L.
  // See {@link OptionSleeveCellGrid.exitReasonSupersedes}.
  const exitReasonSupersedes: OptionSleeveExitReasonSupersede[] = [];
  for (const r of closedRows) {
    const prior = r.supersededCloses;
    if (prior === undefined || prior.length === 0) continue;
    // The LAST superseded close is the one this row's current reason displaced.
    const last = prior[prior.length - 1] as OptionTradeSupersededClose;
    const headline = r.exitReason ?? 'unknown';
    if (last.exitReason === headline) continue; // the move did not change the label
    exitReasonSupersedes.push({
      journalId: r.id,
      optionSymbol: r.optionSymbol ?? r.symbol,
      accountClass: classifySpreadCeilingAccount(r.account),
      structure: r.structure,
      headlineExitReason: headline,
      headlineBrokerOrderId: r.brokerOrderId ?? null,
      supersededExitReason: last.exitReason,
      supersededBrokerOrderId: last.brokerOrderId,
      supersededCloseTs: last.closeTs,
      supersedeReason: last.reason,
      supersededAt: last.supersededAt,
    });
  }
  exitReasonSupersedes.sort((a, b) => b.supersededAt - a.supersededAt || a.journalId.localeCompare(b.journalId));

  const axisPairs = [...pairs.values()];
  const cells: OptionSleeveCell[] = [];
  for (const klass of SPREAD_CEILING_ACCOUNT_CLASSES) {
    for (const pair of axisPairs) {
      const list = buckets.get(cellKey(klass, pair.structure, pair.entryArchetype)) ?? [];
      const closedList = list.filter((r) => r.outcome !== 'OPEN');
      const byOwner = new Map<OptionExitOwner, OptionTradeJournalRecord[]>();
      for (const owner of OPTION_EXIT_OWNERS) byOwner.set(owner, []);
      // TRA-4759 item 4 — ROW-conditional: a live post-arm `take_profit_early`
      // is the engine's own exit and lands in `strategyExits`; every other row
      // of that reason stays `harness`. See `classifyOptionExitOwnerForRow`.
      for (const r of closedList) byOwner.get(classifyOptionExitOwnerForRow(r))!.push(r);

      // TRA-4759 — keyed by (reason, ROW-owner), carried beside the rows, so a
      // reason whose ownership is row-conditional appears once PER OWNER and
      // each stat row's `owner` is true of every row it counts. Every
      // unconditional reason folds exactly as before (one entry, same owner).
      const byReasonMap = new Map<
        string,
        { exitReason: string; owner: OptionExitOwner; rows: OptionTradeJournalRecord[] }
      >();
      for (const r of closedList) {
        const reason = r.exitReason ?? 'unknown';
        const owner = classifyOptionExitOwnerForRow(r);
        const key = JSON.stringify([reason, owner]);
        const cellRows = byReasonMap.get(key) ?? { exitReason: reason, owner, rows: [] };
        cellRows.rows.push(r);
        byReasonMap.set(key, cellRows);
      }
      const byExitReason: OptionSleeveExitReasonStat[] = [...byReasonMap.values()]
        .map(({ exitReason, owner, rows: l }) => ({
          exitReason,
          owner,
          closed: l.length,
          avgR: l.length > 0 ? l.reduce((a, r) => a + (r.realizedR ?? 0), 0) / l.length : null,
          realizedPnlUsd: l.reduce((a, r) => a + (r.realizedPnlUsd ?? 0), 0),
        }))
        .sort((a, b) => b.closed - a.closed || a.exitReason.localeCompare(b.exitReason));

      const strategyExits = slice('strategy', byOwner.get('strategy')!);
      const harnessExits = slice('harness', byOwner.get('harness')!);
      const unknownExits = slice('unknown', byOwner.get('unknown')!);
      cells.push({
        accountClass: klass,
        structure: pair.structure,
        entryArchetype: pair.entryArchetype,
        cell: `${klass}|${pair.structure}|${pair.entryArchetype}`,
        total: list.length,
        open: list.length - closedList.length,
        all: slice('all', closedList),
        strategyExits,
        harnessExits,
        unknownExits,
        exitOwnerCountsSumToClosed:
          strategyExits.n + harnessExits.n + unknownExits.n === closedList.length,
        byExitReason,
        gateRPerPremiumR: GATE_R_BASIS_STRUCTURES.has(pair.structure) ? GATE_R_PER_PREMIUM_R : null,
        // TRA-4246 (AC3) — and the divisor this cell's OWN rows measured,
        // beside the gate's constant, so the two can never be mistaken for
        // each other again.
        stopRPerPremiumR: foldStopBasisDivisor(closedList),
        emptyByConstruction: list.length === 0,
      });
    }
  }

  cells.sort(
    (a, b) =>
      SPREAD_CEILING_ACCOUNT_CLASSES.indexOf(a.accountClass)
        - SPREAD_CEILING_ACCOUNT_CLASSES.indexOf(b.accountClass)
      || b.all.n - a.all.n
      || a.cell.localeCompare(b.cell),
  );

  const summed = cells.reduce((a, c) => a + c.all.n, 0);
  return {
    cells,
    accountClasses: SPREAD_CEILING_ACCOUNT_CLASSES,
    axisPairs,
    closed: closedRows.length,
    cellsSumToClosed: summed === closedRows.length,
    residual: closedRows.length - summed,
    emptyCellCount: cells.filter((c) => c.emptyByConstruction).length,
    minSampleForVerdict: SLEEVE_CELL_MIN_N,
    underpoweredCells: cells.filter((c) => c.all.underpowered).map((c) => c.cell),
    unclassifiedExitReasons: [...unclassified].sort(),
    exitOwnerTable: OPTION_EXIT_REASON_TABLE,
    exitReasonSupersedes,
    rBasis: 'premium',
    note:
      'TRA-3715. One cell per accountClass x structure x entryArchetype, emitted for ALL THREE '
      + 'classes even at n=0 (an absent cell reads like a passing one). GRADE A SLEEVE ON '
      + '`strategyExits`, NOT on `all`: `manual` is a harness/QA close path, and on TRA-3709\'s '
      + 'window it and pre-arm `take_profit_early` carried the ENTIRE positive baseline of both '
      + 'sleeves (strip them and single_leg_directional goes +0.1193 -> -0.0453, single_leg_otm '
      + '+0.2098 -> -0.0459). TRA-4759: `take_profit_early` ownership is ROW-conditional — '
      + '`strategy` for a mode=live row with closeTs >= 1789912043779 (2026-09-20T13:47:23.779Z, '
      + 'the TAKE_PROFIT_EARLY_LIVE_ENABLED arm instant, from which the ENGINE chooses this exit '
      + 'on real money), `harness` otherwise — so live post-arm rows are IN `strategyExits` and '
      + 'the pre-arm harness baseline is untouched; that reason can appear once per owner in '
      + '`byExitReason`. `exitOwnerTable` is the classification rule itself; a reason it '
      + 'does not list lands in `unknownExits` and is named in `unclassifiedExitReasons`, never '
      + 'absorbed into strategy. Any slice with n < ' + SLEEVE_CELL_MIN_N + ' is labelled '
      + 'UNDERPOWERED and its avgR must not be read as a verdict. R is PREMIUM R '
      + '(realizedPnlUsd / atRiskUsd); the COST-AWARE GATE\'s R is 4x that wherever '
      + 'gateRPerPremiumR is non-null. TRA-4246: that 4x is the GATE\'S MODELLED stop '
      + '(mark x 0.75) and is NOT the sleeve\'s armed stop -- single_leg_otm stops at '
      + 'OTM_OPTIONS_SL_PCT 0.20 (premium x 0.80), a 5x, so converting premium R to '
      + 'STOP-BASIS R through gateRPerPremiumR understates the magnitude by 20% on that '
      + 'sleeve. Use stopRPerPremiumR, which is MEASURED on each cell\'s own closed rows '
      + '(null where no row carries one; unanimous:false means NO single divisor describes '
      + 'the cell and you must convert per row off the journal row\'s own '
      + 'stopBasisRPerPremiumR). exitReasonSupersedes names every row whose headline '
      + 'exitReason was written by a supersede over a different reason -- byExitReason '
      + 'counts those rows under the NEW label, so a fold that cares which rule fired must '
      + 'read that list. Window this with ?sinceEtDay=/&untilEtDay= (ET session '
      + 'days on closeTs) or the epoch-ms cohort params; unwindowed it is a LIFETIME fold.',
  };
}

// ── TRA-3715 item 2 — the date window ────────────────────────────────────────

/** A resolved close-time window, plus everything needed to audit the resolution. */
export interface EtDayCloseWindow {
  /** ET session day the window opens on, `YYYY-MM-DD`. */
  sinceEtDay: string;
  /** ET session day the window closes on, INCLUSIVE, `YYYY-MM-DD`. */
  untilEtDay: string;
  /** 00:00:00.000 ET of `sinceEtDay`, epoch ms. Inclusive. */
  fromMs: number;
  /** 23:59:59.999 ET of `untilEtDay`, epoch ms. Inclusive. */
  toMs: number;
  fromInclusive: true;
  toInclusive: true;
  note: string;
}

export type EtDayWindowParse =
  | { ok: true; window: EtDayCloseWindow | null }
  | { ok: false; error: string; detail: string };

const ET_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * TRA-3715 item 2 — resolve an ET-session day window onto `closeTs`.
 *
 * WHY THIS AND NOT JUST EPOCH MS. Every windowed grade this journal is asked for
 * is written in ET session days ("2026-07-27 → 2026-08-13"), and the route's
 * existing cohort params are epoch-ms only — deliberately, because `Date.parse`
 * is lenient in ways that silently shift a cohort by the host's UTC offset
 * (TRA-3380). So a grader had to hand-convert two ET midnights to UTC, per
 * window, getting DST right, or give up and re-fold `rows[]` by hand. The second
 * is what actually happened, twice, and it is defect 2 of this ticket.
 *
 * The conversion is done HERE, once, through {@link etWallClockToUtcMs}, which
 * resolves the offset in force at each instant rather than assuming EDT — and
 * both resolved bounds are echoed on the wire so the caller can check the
 * conversion instead of trusting it.
 *
 * Both params are REQUIRED together. A half-open window silently reverts to
 * "everything on one side", which is the fail-open shape the whole cohort-param
 * contract exists to prevent.
 */
export function parseEtDayCloseWindow(
  sinceRaw: unknown,
  untilRaw: unknown,
): EtDayWindowParse {
  if (sinceRaw === undefined && untilRaw === undefined) return { ok: true, window: null };
  for (const [name, raw] of [
    ['sinceEtDay', sinceRaw],
    ['untilEtDay', untilRaw],
  ] as const) {
    if (Array.isArray(raw)) {
      return {
        ok: false,
        error: `${name}_repeated`,
        detail: `\`${name}\` was supplied ${raw.length} times. Send it exactly once.`,
      };
    }
    if (raw !== undefined && typeof raw !== 'string') {
      return { ok: false, error: `${name}_invalid`, detail: `\`${name}\` must be a scalar query value.` };
    }
  }
  const since = typeof sinceRaw === 'string' ? sinceRaw.trim() : '';
  const until = typeof untilRaw === 'string' ? untilRaw.trim() : '';
  if (since === '' || until === '') {
    return {
      ok: false,
      error: 'et_day_window_incomplete',
      detail:
        'Pass BOTH `sinceEtDay` and `untilEtDay` (YYYY-MM-DD, ET session days, both '
        + 'inclusive). A half-open window would silently select everything on one side.',
    };
  }
  for (const [name, value] of [
    ['sinceEtDay', since],
    ['untilEtDay', until],
  ] as const) {
    if (!ET_DAY_RE.test(value)) {
      return {
        ok: false,
        error: `${name}_not_et_day`,
        detail: `\`${name}\` must be an ET calendar day as YYYY-MM-DD. Received ${JSON.stringify(value)}.`,
      };
    }
  }
  const fromMs = etWallClockToUtcMs(since, 0, 0);
  // 24:00 of `until` IS 00:00 of the next ET day, resolved at the offset in
  // force there; minus 1 ms makes the upper bound inclusive of the whole day.
  const endExclusive = etWallClockToUtcMs(until, 24, 0);
  if (fromMs === null || endExclusive === null) {
    return {
      ok: false,
      error: 'et_day_window_unresolvable',
      detail: `Could not resolve ${JSON.stringify(since)}..${JSON.stringify(until)} to ET session boundaries.`,
    };
  }
  const toMs = endExclusive - 1;
  if (toMs < fromMs) {
    return {
      ok: false,
      error: 'et_day_window_inverted',
      detail: `\`untilEtDay\` (${until}) is before \`sinceEtDay\` (${since}).`,
    };
  }
  return {
    ok: true,
    window: {
      sinceEtDay: since,
      untilEtDay: until,
      fromMs,
      toMs,
      fromInclusive: true,
      toInclusive: true,
      note:
        'ET SESSION DAY semantics on `closeTs`: [00:00:00.000 ET of sinceEtDay, 23:59:59.999 ET '
        + 'of untilEtDay], BOTH ends inclusive, offsets resolved per-instant so a window '
        + 'spanning a DST transition is exact. Rows still OPEN carry no closeTs and are '
        + 'excluded by construction. Both resolved epoch-ms bounds are published so the '
        + 'conversion can be checked rather than trusted.',
    },
  };
}

/** True iff the row closed inside `window`. An OPEN row is always false. */
export function rowClosedInWindow(
  row: OptionTradeJournalRecord,
  window: EtDayCloseWindow,
): boolean {
  const closeTs = row.closeTs;
  if (typeof closeTs !== 'number' || !Number.isFinite(closeTs)) return false;
  return closeTs >= window.fromMs && closeTs <= window.toMs;
}

/** ET session day a row closed on, or `null` while it is still open. */
export function rowCloseEtDay(row: OptionTradeJournalRecord): string | null {
  const closeTs = row.closeTs;
  if (typeof closeTs !== 'number' || !Number.isFinite(closeTs)) return null;
  return etDateKey(closeTs);
}
