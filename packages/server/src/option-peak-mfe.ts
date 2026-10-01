/**
 * TRA-4950 — `peakPremium` as a MAXIMUM FAVOURABLE EXCURSION, and the instrument
 * that says whether it currently is one.
 *
 * ── The defect ─────────────────────────────────────────────────────────────────
 *
 * For a long single-leg option the realized exit can never exceed the true peak.
 * Measured 2026-09-27 and re-derived 2026-10-01 off
 * `GET /api/health/option-journal?rows=all` on bqb1 (`faae9388`, 3542 rows):
 * **101 of the 312 rows carrying all four operands book MORE than the peak they
 * recorded**, every one of them on a winner, and the violation rate is a step
 * function of which SIDE the exit is on — `sl` + every other adverse-side exit
 * 0/78, `take_profit_early` 8/8, `book_halt_flat` 85/201.
 *
 * The side-asymmetry is not a second bug. A violation is only VISIBLE when the
 * exit lands near the peak, which is what a profit-side exit is; a stop books far
 * below any peak and so satisfies the inequality no matter how badly the peak
 * under-records. So the adverse-side 0% is not evidence the stamp is sound there
 * — it is evidence the test has no power there, and it must never be cited as a
 * control.
 *
 * ── The mechanism ──────────────────────────────────────────────────────────────
 *
 * `peakPremium` was advanced in exactly two places, and both are TICK paths:
 * `checkExits`' per-row ratchet (`ratchetObservedPeakPremium` off the tick's
 * `mark`) and `refreshImportedMarks`. Every CLOSE path, by contrast, resolves its
 * OWN exit price and books P&L against it without ever offering that price to the
 * ratchet:
 *
 *   • `closeOption(id, undefined, 'book_halt_flat')` books at `opt.currentPremium`
 *     — a mark that may have been written by `resolvePendingExit`/`bookPartialFill`
 *     (neither of which ratcheted) or carried from a tick the row was gated out of;
 *   • `resolvePendingExit` books the BROKER'S avg fill, which is a real print the
 *     tick loop never sampled;
 *   • `recordImportedFill` / `bookPartialFill` — same, for mirrored rows;
 *   • the multi-leg settle books a synthetic per-share `closeMark`.
 *
 * And the tick ratchet is skipped entirely whenever the row `continue`s above it
 * — most importantly on `opt.pendingExit`, i.e. for the whole life of a staged
 * exit. So the engine could observe a price, act on it, bank it, and never widen
 * the excursion it claims to have seen. `desk`-attributed SIRI `1af1c58c`
 * (2026-09-11, `chandelier`) is the clean real-money-book witness: peak 1.43179
 * stamped `observed` 17.9 min before the close, exit implied 1.48999, and the
 * close's own `markProvenance` says `delta_backstop` / `staleMarkTicks: 5`.
 *
 * ── What this module is ────────────────────────────────────────────────────────
 *
 * The grader, and the boot-scoped accrual behind
 * `/api/health/option-journal` → `peakMfeInvariant`. Per the CLAUDE.md
 * health-field rule it reports the OUTCOME OF THE LAST REAL CLOSE, carries the
 * attempt's timestamp beside it, and reads
 * `never_attempted_this_boot` — an alarm, not a pass — when nothing has closed.
 * `unmeasurable_*` is likewise its own named state: a row with no peak publishes
 * "no excursion was measured", never a zero excursion.
 *
 * ⛔ STAMPS ARE FORWARD-ONLY AND NOTHING IS BACKFILLED. The 3542 rows already on
 * the tape keep whatever peak they recorded; a reconstructed high-water mark is a
 * fabricated column (the TRA-4160 ruling, restated). `peakPremium` is an MFE only
 * on rows whose CLOSE was written by a build carrying this ticket — see
 * {@link PEAK_MFE_TRUSTWORTHY_FROM_ISO}.
 */

/**
 * The ET day from which a CLOSE row's `peakPremium` is an MFE rather than "the
 * highest mark some tick happened to sample". Rows closed before this carry the
 * pre-fix stamp and are **not** repaired — see the module docblock.
 *
 * Bumped only when a close path is newly brought under the ratchet; a reader
 * comparing two cohorts across this date is comparing two different instruments.
 */
export const PEAK_MFE_TRUSTWORTHY_FROM_ISO = '2026-10-01';

/**
 * Relative tolerance on the inequality. The live tape carries float noise at
 * 1e-16 on both sides of a premium (the `PEAK_RATCHET_EPSILON_REL` argument in
 * `options-account.ts`), and the implied-exit arithmetic below divides by
 * `contracts * 100`, so a strict `>` would classify rounding as a violation.
 *
 * Scaled by `max(|peak|, 1)` for the same reason the ratchet epsilon is: a
 * $0.05 contract and a $40 contract do not share an absolute noise floor.
 */
const PEAK_MFE_EPSILON_REL = 1e-9;

/**
 * Why a row was not graded, or the verdict if it was.
 *
 * `ok` / `violated` are the only two that carry a comparison. Everything else is
 * an ABSENCE with a name on it — the shape the CLAUDE.md rule exists to force,
 * because today a row with no peak folds as a small MFE rather than as an
 * unmeasured one, and a naive capture-ratio fold over this cohort returns 3.1,
 * 4.0 and 12.5 (booking more than the recorded peak) without ever going red.
 */
export type PeakMfeVerdict =
  | 'ok'
  | 'violated'
  /** No finite `peakPremium` on the row — the close path never stamped one. */
  | 'unmeasurable_no_peak'
  /** No finite positive `entryBasisPremium` — the excursion has no origin. */
  | 'unmeasurable_no_basis'
  /** No finite `realizedPnlUsd` — there is nothing to compare the peak against. */
  | 'unmeasurable_no_pnl'
  /**
   * The row's realized P&L and its size disagree, so an implied exit premium
   * cannot be derived from it: a TP1/partial trim banked dollars at one size and
   * the close row's cumulative figure covers both (TRA-2895), or
   * `contractsAtClose` differs from `contracts` (the TRA-4609 add shape).
   * Deliberately NOT graded — the expensive direction of a grader over the
   * engine's own exits is the false accusation.
   */
  | 'unmeasurable_size_ambiguous'
  /**
   * Not a long single-leg row. A covered write is SHORT the premium (the
   * excursion runs the other way) and a multi-leg settle books a synthetic
   * per-share mark against a net debit/credit, so neither is in this
   * inequality's domain. Counted separately so "not applicable" can never
   * dilute the violation rate.
   */
  | 'not_applicable_not_long_single_leg';

/** The operands a grade needs, projected off a folded journal CLOSE row. */
export interface PeakMfeRowInput {
  id?: string;
  optionSymbol?: string | null;
  mode?: string | null;
  exitReason?: string | null;
  structure?: string | null;
  outcome?: string | null;
  closeTs?: number | null;
  peakPremium?: number | null;
  peakPremiumStamp?: string | null;
  entryBasisPremium?: number | null;
  realizedPnlUsd?: number | null;
  realizedR?: number | null;
  atRiskUsd?: number | null;
  contracts?: number | null;
  contractsAtClose?: number | null;
  partials?: unknown[] | null;
  coveredWrite?: unknown;
}

export interface PeakMfeGrade {
  verdict: PeakMfeVerdict;
  /** True only for `violated`. Kept explicit so a caller never re-derives it. */
  violated: boolean;
  /** True for `ok` | `violated` — i.e. the row carried a usable comparison. */
  graded: boolean;
  peakPremium: number | null;
  /**
   * `entryBasisPremium + realizedPnlUsd / (100 * contracts)` — the per-share
   * exit the row's own money implies. PREMIUM space is the primary test: it is
   * exact on the row's own operands, where the R-space form additionally divides
   * by `atRiskUsd`, which after a conviction add is a different denominator than
   * the one the P&L was earned over (TRA-4609).
   *
   * Fees push this DOWN (a demo close pays `demoFeePerContract`), so the test is
   * conservative: it under-reports violations and cannot manufacture one.
   */
  impliedExitPremium: number | null;
  /** `impliedExitPremium - peakPremium`; positive is the defect. */
  excessPremium: number | null;
  /** The ticket's R-space form, published for continuity. Null when unavailable. */
  peakR: number | null;
  realizedR: number | null;
  excessR: number | null;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

const UNGRADED: Omit<PeakMfeGrade, 'verdict'> = {
  violated: false,
  graded: false,
  peakPremium: null,
  impliedExitPremium: null,
  excessPremium: null,
  peakR: null,
  realizedR: null,
  excessR: null,
};

/**
 * TRA-4950 — is this row's `peakPremium` consistent with the money it booked?
 *
 * Pure. No clock, no I/O, no module state — so the health accrual and the
 * invariant test grade with the same function, and a fixture is a literal.
 */
export function gradePeakMfe(row: PeakMfeRowInput): PeakMfeGrade {
  const structure = typeof row.structure === 'string' ? row.structure : '';
  const isLongSingleLeg = structure.startsWith('single_leg') && row.coveredWrite == null;
  if (!isLongSingleLeg) {
    return { ...UNGRADED, verdict: 'not_applicable_not_long_single_leg' };
  }
  const peak = fin(row.peakPremium) ? row.peakPremium : null;
  const basis = fin(row.entryBasisPremium) && row.entryBasisPremium > 0 ? row.entryBasisPremium : null;
  const pnl = fin(row.realizedPnlUsd) ? row.realizedPnlUsd : null;
  if (peak === null) return { ...UNGRADED, verdict: 'unmeasurable_no_peak' };
  if (basis === null) return { ...UNGRADED, verdict: 'unmeasurable_no_basis', peakPremium: peak };
  if (pnl === null) return { ...UNGRADED, verdict: 'unmeasurable_no_pnl', peakPremium: peak };

  // Size must be unambiguous or the implied exit is an average over two sizes.
  const entryContracts = fin(row.contracts) && row.contracts > 0 ? row.contracts : null;
  const closeContracts = fin(row.contractsAtClose) && row.contractsAtClose > 0 ? row.contractsAtClose : null;
  const hadPartial = Array.isArray(row.partials) && row.partials.length > 0;
  if (entryContracts === null
    || hadPartial
    || (closeContracts !== null && closeContracts !== entryContracts)) {
    return { ...UNGRADED, verdict: 'unmeasurable_size_ambiguous', peakPremium: peak };
  }

  const impliedExitPremium = basis + pnl / (100 * entryContracts);
  const excessPremium = impliedExitPremium - peak;
  const eps = Math.max(Math.abs(peak), 1) * PEAK_MFE_EPSILON_REL;

  const atRisk = fin(row.atRiskUsd) && row.atRiskUsd > 0 ? row.atRiskUsd : null;
  const peakR = atRisk === null ? null : ((peak - basis) * 100 * entryContracts) / atRisk;
  const realizedR = fin(row.realizedR) ? row.realizedR : null;
  const excessR = peakR === null || realizedR === null ? null : realizedR - peakR;

  const violated = excessPremium > eps;
  return {
    verdict: violated ? 'violated' : 'ok',
    violated,
    graded: true,
    peakPremium: peak,
    impliedExitPremium,
    excessPremium,
    peakR,
    realizedR,
    excessR,
  };
}

/** The last real close this boot, graded. `null` until one lands. */
export interface PeakMfeLastAttempt {
  at: number;
  atIso: string;
  id: string | null;
  optionSymbol: string | null;
  mode: string | null;
  exitReason: string | null;
  structure: string | null;
  outcome: string | null;
  verdict: PeakMfeVerdict;
  peakPremium: number | null;
  peakPremiumStamp: string | null;
  impliedExitPremium: number | null;
  excessPremium: number | null;
  peakR: number | null;
  realizedR: number | null;
  excessR: number | null;
}

export interface OptionPeakMfeHealth {
  /**
   * ⚠️ `never_attempted_this_boot` IS AN ALARM, NOT A PASS. It means no close has
   * been graded since this process booted, so this field has measured nothing —
   * which on a box that has been up for days is itself the finding (the live
   * options sleeve has opened nothing since 2026-09-22). It must never be read
   * as "no violations".
   */
  state: 'never_attempted_this_boot' | 'measured';
  /** The outcome of the LAST REAL CLOSE, with its own timestamp beside it. */
  lastAttempt: PeakMfeLastAttempt | null;
  sinceBoot: {
    bootAt: number;
    bootAtIso: string;
    /** Every close offered to the grader, whatever the verdict. */
    closesSeen: number;
    /** Closes that carried a usable comparison (`ok` + `violated`). */
    graded: number;
    ok: number;
    violated: number;
    /** `unmeasurable_*` — absent evidence, named. Never folded into `ok`. */
    unmeasurable: number;
    /** `not_applicable_not_long_single_leg` — outside the inequality's domain. */
    notApplicable: number;
    /**
     * `violated / graded`. **`null` when `graded === 0`** — a rate over an empty
     * denominator is not 0, and publishing 0 there is exactly the
     * `queriesSucceeded: 0` conflation the CLAUDE.md rule was written for.
     */
    violationRate: number | null;
    byVerdict: Record<PeakMfeVerdict, number>;
    /** First/last graded close this boot — the window the rate covers. */
    firstGradedAt: number | null;
    lastGradedAt: number | null;
  };
  /** The largest `excessPremium` seen this boot, kept for triage. */
  worstViolation: PeakMfeLastAttempt | null;
  trustworthyFromIso: string;
  note: string;
}

const EMPTY_BY_VERDICT = (): Record<PeakMfeVerdict, number> => ({
  ok: 0,
  violated: 0,
  unmeasurable_no_peak: 0,
  unmeasurable_no_basis: 0,
  unmeasurable_no_pnl: 0,
  unmeasurable_size_ambiguous: 0,
  not_applicable_not_long_single_leg: 0,
});

interface Accrual {
  bootAt: number;
  closesSeen: number;
  byVerdict: Record<PeakMfeVerdict, number>;
  firstGradedAt: number | null;
  lastGradedAt: number | null;
  lastAttempt: PeakMfeLastAttempt | null;
  worstViolation: PeakMfeLastAttempt | null;
}

let accrual: Accrual = {
  bootAt: Date.now(),
  closesSeen: 0,
  byVerdict: EMPTY_BY_VERDICT(),
  firstGradedAt: null,
  lastGradedAt: null,
  lastAttempt: null,
  worstViolation: null,
};

/** Test seam. Resets the boot-scoped fold so a suite is not order-dependent. */
export function resetPeakMfeAccrualForTests(bootAt: number = Date.now()): void {
  accrual = {
    bootAt,
    closesSeen: 0,
    byVerdict: EMPTY_BY_VERDICT(),
    firstGradedAt: null,
    lastGradedAt: null,
    lastAttempt: null,
    worstViolation: null,
  };
}

/**
 * TRA-4950 — record the grade of ONE real close. Called from the journal's close
 * writer, after the fold, so the row it grades is the row a reader will see.
 *
 * Returns the grade so a caller can log it. Never throws: an instrument that can
 * fail a close write is worse than the defect it measures.
 */
export function notePeakMfeClose(row: PeakMfeRowInput, at: number = Date.now()): PeakMfeGrade {
  const grade = gradePeakMfe(row);
  const attempt: PeakMfeLastAttempt = {
    at,
    atIso: new Date(at).toISOString(),
    id: typeof row.id === 'string' ? row.id : null,
    optionSymbol: row.optionSymbol ?? null,
    mode: row.mode ?? null,
    exitReason: row.exitReason ?? null,
    structure: row.structure ?? null,
    outcome: row.outcome ?? null,
    verdict: grade.verdict,
    peakPremium: grade.peakPremium,
    peakPremiumStamp: row.peakPremiumStamp ?? null,
    impliedExitPremium: grade.impliedExitPremium,
    excessPremium: grade.excessPremium,
    peakR: grade.peakR,
    realizedR: grade.realizedR,
    excessR: grade.excessR,
  };
  accrual.closesSeen += 1;
  accrual.byVerdict[grade.verdict] += 1;
  accrual.lastAttempt = attempt;
  if (grade.graded) {
    if (accrual.firstGradedAt === null) accrual.firstGradedAt = at;
    accrual.lastGradedAt = at;
  }
  if (grade.violated) {
    const worst = accrual.worstViolation;
    if (worst === null || (grade.excessPremium ?? 0) > (worst.excessPremium ?? 0)) {
      accrual.worstViolation = attempt;
    }
  }
  return grade;
}

export function getOptionPeakMfeHealth(): OptionPeakMfeHealth {
  const v = accrual.byVerdict;
  const graded = v.ok + v.violated;
  const unmeasurable =
    v.unmeasurable_no_peak + v.unmeasurable_no_basis + v.unmeasurable_no_pnl + v.unmeasurable_size_ambiguous;
  return {
    state: accrual.closesSeen === 0 ? 'never_attempted_this_boot' : 'measured',
    lastAttempt: accrual.lastAttempt,
    sinceBoot: {
      bootAt: accrual.bootAt,
      bootAtIso: new Date(accrual.bootAt).toISOString(),
      closesSeen: accrual.closesSeen,
      graded,
      ok: v.ok,
      violated: v.violated,
      unmeasurable,
      notApplicable: v.not_applicable_not_long_single_leg,
      violationRate: graded === 0 ? null : v.violated / graded,
      byVerdict: { ...v },
      firstGradedAt: accrual.firstGradedAt,
      lastGradedAt: accrual.lastGradedAt,
    },
    worstViolation: accrual.worstViolation,
    trustworthyFromIso: PEAK_MFE_TRUSTWORTHY_FROM_ISO,
    note:
      'TRA-4950 — `violated` means the row booked MORE than the peak it recorded, which is '
      + 'arithmetically impossible for a true MFE on a long option. `state: '
      + '"never_attempted_this_boot"` is an ALARM (nothing has closed since boot, so this field '
      + 'has measured nothing) and `violationRate: null` over `graded: 0` is the same statement — '
      + 'neither is a pass. `unmeasurable_*` rows are absent evidence with a name on it and are '
      + 'NEVER folded into `ok`. The adverse-side 0% in the TRA-4950 measurement is a LACK OF '
      + `POWER, not a control. Peaks are forward-only: a close written before ${PEAK_MFE_TRUSTWORTHY_FROM_ISO} `
      + 'carries the pre-fix stamp and is not backfilled.',
  };
}
