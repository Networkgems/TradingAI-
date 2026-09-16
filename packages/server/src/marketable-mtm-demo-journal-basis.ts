// TRA-3502 Task 2 (carrier from TRA-3499; parent TRA-2242 → TRA-2233 → TRA-2174) — the
// DEMO-JOURNAL basis for the marketable(bid) MTM forward validation, beside the sandbox
// one in `marketable-mtm-forward-validation.ts`.
//
// ── WHY A SECOND BASIS ───────────────────────────────────────────────────────
// TRA-3459 ruled the Tradier sandbox UNFIT to validate `h`: a 7.5× width regime and
// 0/140 overlap with the calibration population. TRA-2242 step 1 — "accrue ≥ 30
// parity-true SANDBOX round-trips" — therefore names an accrual that CAN NEVER
// COMPLETE. Waiting for it is waiting on a detector with no reachable pass state.
//
// The demo journal is the source that does overlap, on the exact term the sandbox
// missed:
//
//                   calibration (n=140)   forward demo (n=389)   sandbox (n=20)
//   median spread   $0.15                 $0.15                  $0.02
//   median mid      $1.32                 $1.43                  $4.31
//
// The width regime is an EXACT match. That, and not row count, is why this source can
// grade the model and the sandbox cannot.
//
// ── WHAT THIS BASIS MEASURES, AND WHAT IT DOES NOT ───────────────────────────
// It measures the QUOTED half-spread — `(mark − bid)/mark` long, `(ask − mark)/mark`
// short — off `entryBid`/`entryAsk`/`entryMarkUsd`, the two-sided book that SET THE
// FILL. That is a real book read at a real decision time, which is exactly what makes
// a quoted basis able to validate a bid model (the same argument as TRA-2283 D2).
//
// ⚠️ It is an **ENTRY** quote and the haircut is applied at **EXIT**. This basis grades
// the WIDTH REGIME the model prices against; it does not observe the book the position
// actually exits through. QuantTrader's Task 3 ruling turns on exactly this — "retuning
// onto entry quotes when the haircut is applied at exit fits the wrong seam" — so the
// caveat rides the payload and this module NEVER emits a retune target. There is no `h`
// proposal anywhere below, by construction.
//
// ── IN-SAMPLE REFUSAL IS STRUCTURAL, NOT CONVENTIONAL ────────────────────────
// `h = 0.134` was calibrated on rows inside `MODELED_H_CALIBRATION.windowUtc`. Grading
// it on those rows is grading a fit against its own training set — it cannot fail, and
// an unfailable criterion is the defect this ticket family exists to remove. Two checks,
// and they are NOT two measurements of the same thing:
//
//   1. `IN_SAMPLE_COHORT` — the REFUSAL. A requested cohort start at or inside the
//      calibration window is rejected outright, never clamped forward to a safe value:
//      silently widening a caller's cohort would hide that they asked for an in-sample
//      grade. Together with the strictly-greater `openTs > fromTsExclusive` retention
//      filter, this is what makes the rejection structural rather than conventional —
//      the only cohorts that survive both are entirely forward of the window close.
//
//   2. `IN_SAMPLE_ROWS` — an INVARIANT ASSERTION on (1), not a second discriminator.
//      Given (1) it is unreachable on correct code, and that is stated plainly here
//      rather than left to read as an independent safety net. What it buys is a real
//      failing state under the exact mutation that would break the cohort: weaken the
//      retention filter from `openTs <= fromTsExclusive` to `openTs < fromTsExclusive`
//      and the boundary row — which sits exactly ON the calibration close, i.e. IN the
//      training set — is admitted, and this fires. Pinned by a test.
//
// A refusal returns NO moments and NO cells — not zeroed ones — so there is nothing for
// a downstream reader to accidentally grade. `retainedOpenTsMin` is published so the
// forward-ness of the graded population is a direct read, not a trusted claim.
//
// Pure: no IO, no clock, no globals. `now` is never read.

import {
  MODELED_H_CALIBRATION,
  MARKETABLE_MTM_DEFAULT_H,
  MARKETABLE_MTM_H_BY_STRUCTURE,
  marketableMtmUncalibratedStructures,
  quotedTailUnderCharged,
  quotedTailUnderChargeRatio,
  resolveMarketableMtmH,
} from './marketable-mtm-forward-validation.js';
import { halfSpreadFracFromQuoteForSide, type MarketableSide } from './marketable-open-mtm.js';

/** Options contract multiplier — a per-share cross is 100× per contract. */
const CONTRACT_MULTIPLIER = 100;

/**
 * TRA-3502 — the account partition. `desk` is the DEPLOYMENT population and the only
 * cell a deployment decision may be read off; the pooled number carries QA fixture
 * books (`qa*`, `ctoverify*`, …) that dominate the ~51-book demo fleet. `unattributed`
 * is pre-TRA-1475 rows with no `account` at all — kept as its own class rather than
 * folded into either, because "unclassifiable" is not "not a fixture".
 */
export type MarketableMtmAccountClass = 'desk' | 'fixture' | 'unattributed';

export const MARKETABLE_MTM_ACCOUNT_CLASSES: readonly MarketableMtmAccountClass[] =
  ['desk', 'fixture', 'unattributed'] as const;

/** The subset of an option-trade-journal row this basis reads. Structurally satisfied by `OptionTradeJournalRow`. */
export interface MarketableMtmDemoJournalRow {
  structure?: string | null;
  account?: string | null;
  openTs?: number | null;
  entryBid?: number | null;
  entryAsk?: number | null;
  entryMarkUsd?: number | null;
}

/** Why a row produced no sample. Mutually exclusive, evaluated in this order. */
export type MarketableMtmDemoDropReason =
  /** No usable `openTs` — cannot be placed relative to the calibration window at all. */
  | 'no_open_ts'
  /** `openTs` at or before the cohort boundary. Not a defect: the cohort filter working. */
  | 'before_cohort'
  /** None of `entryBid`/`entryAsk`/`entryMarkUsd` present — a pre-TRA-1656 row. Drains with age. */
  | 'no_quote_field'
  /** Keys present but the book fails the shared guards (crossed, non-finite, non-positive mark). */
  | 'quote_unusable';

export interface MarketableMtmDemoMoments {
  n: number;
  /** `NaN` at n=0 — never 0, which is a real half-spread and a real dollar cross. */
  mean: number;
  median: number;
  p90: number;
}

/** One retained row, reduced to what the fold needs. Echoed only under `includeSamples`. */
export interface MarketableMtmDemoSample {
  structure: string;
  accountClass: MarketableMtmAccountClass;
  side: MarketableSide;
  openTs: number;
  midUsd: number;
  fullSpreadUsd: number;
  quotedH: number;
  quotedCrossUsd: number;
  modeledCrossUsd: number;
}

/**
 * One graded cell. Emitted per structure × account class AND per each axis alone AND
 * pooled — the ticket's "report mean AND median AND p90, per structure and per account
 * class, never a single pooled scalar".
 */
export interface MarketableMtmDemoCell {
  /** `'*'` on an axis this cell aggregates over. */
  structure: string;
  accountClass: MarketableMtmAccountClass | '*';
  n: number;
  /** The measured quoted half-spread fraction. Compare `mean` against `modeledH`. */
  quotedH: MarketableMtmDemoMoments;
  /** The cross implied by the quoted book, $ (`quotedH · mid · 100`). */
  quotedCrossUsd: MarketableMtmDemoMoments;
  /** The cross the MODEL charges on the SAME rows (`h · mid · 100`). The tail check's other side. */
  modeledCrossUsdOnQuoted: MarketableMtmDemoMoments;
  /** Regime terms, so a cell can be checked for population fitness before it is read. */
  midUsd: MarketableMtmDemoMoments;
  fullSpreadUsd: MarketableMtmDemoMoments;
  /**
   * TRA-3499 / Task 3 — THE SHIPPED PREDICATE, imported from
   * `marketable-mtm-forward-validation.ts`, not re-derived here. It compares DOLLARS
   * (`p90 modeled >= p90 quoted`) and reduces to the h-space form only on a constant
   * mid; the demo book's mid has CV 0.42, so both states are reachable and it is a
   * working discriminator. It is NOT weakened by this ticket.
   */
  quotedTailUnderCharged: boolean;
  quotedTailUnderChargeRatio: number | null;
  /** Signed mean error in h-space (`mean(quotedH) − modeledH`). Negative ⇒ `h` OVER-charges. */
  meanHError: number;
  /**
   * TRA-3697 — THIS structure's **own** calibrated `h`, or `null`.
   *
   * `null` is one of two statements, and `hRefusal.code` says which:
   *
   * - `UNCALIBRATED_STRUCTURE` — this structure has no fit in
   *   {@link MODELED_H_CALIBRATION}.byStructure and therefore has **no modeled half-spread at
   *   all**. It is emphatically NOT {@link MARKETABLE_MTM_DEFAULT_H}: that scalar is
   *   `single_leg_rv`'s fit at 88.6% weight, and handing it to `single_leg_directional`
   *   (forward desk mean 0.036) is a 3.7× over-charge that reads identically to a real
   *   calibration at every call site. Naming it is the entire point.
   * - `POOLED_MARGINAL` — this cell aggregates over the structure axis (`structure === '*'`),
   *   so there is no single structure to resolve. A marginal is not uncalibrated; conflating
   *   the two would put `'*'` in `structuresUncalibratedH` on a perfectly calibrated book.
   *
   * ⚠️ `meanHError` and `modeledCrossUsdOnQuoted` on this cell are still computed at the
   * `modeledH` scalar the fold was called with — unchanged by TRA-3697, which is a spec change
   * to `h`'s SHAPE and not to any measured or published value. When `calibratedH` is non-null
   * and differs from `modeledH`, those two fields are charging this structure at another
   * structure's rate, and this field is how a reader can tell.
   */
  calibratedH: number | null;
  /** Non-null ⇒ `calibratedH` is `null`, with the reason. See {@link MarketableMtmDemoCellHRefusal}. */
  hRefusal: MarketableMtmDemoCellHRefusal | null;
}

/** Why a cell has no `calibratedH`. Two codes because "no fit" and "no single structure" differ. */
export interface MarketableMtmDemoCellHRefusal {
  code: 'UNCALIBRATED_STRUCTURE' | 'POOLED_MARGINAL';
  reason: string;
}

export interface MarketableMtmDemoRefusal {
  code: 'IN_SAMPLE_COHORT' | 'IN_SAMPLE_ROWS';
  reason: string;
  /** For `IN_SAMPLE_ROWS`: how many retained rows landed inside the calibration window. */
  offendingRows: number;
}

export interface MarketableMtmDemoJournalBasis {
  basis: 'demoJournalEntryQuote';
  modeledH: number;
  /**
   * Non-null ⇒ THIS RESULT IS NOT A GRADE. `pooled` is `null` and `cells` is empty; there
   * are no zeroed moments to mistake for measured ones.
   */
  refusal: MarketableMtmDemoRefusal | null;
  cohort: {
    /** Rows are retained on `openTs > fromTsExclusive`. Strictly greater — the boundary row is IN-sample. */
    fromTsExclusive: number;
    fromIso: string;
    /** The window `h` was fitted on. Any overlap with it is a refusal, not a warning. */
    calibrationWindowUtc: typeof MODELED_H_CALIBRATION.windowUtc;
  };
  rowsSeen: number;
  rowsRetained: number;
  /**
   * Earliest / latest `openTs` among RETAINED rows, and their ISO forms. Published so a
   * reader can confirm the graded population is forward of the calibration close by
   * looking at it, instead of trusting that the filter ran. `null` at zero retained —
   * never 0, which is a real (1970) epoch.
   */
  retainedOpenTsMin: number | null;
  retainedOpenTsMax: number | null;
  retainedOpenIsoMin: string | null;
  retainedOpenIsoMax: string | null;
  drops: Record<MarketableMtmDemoDropReason, number>;
  /** `null` under a refusal. Pooled is published for reference and is NOT the grading cell. */
  pooled: MarketableMtmDemoCell | null;
  /** structure × accountClass, plus the `'*'` marginals on each axis. `n`-descending. */
  cells: MarketableMtmDemoCell[];
  /**
   * TRA-3697 — structures PRESENT in this population that have no calibrated `h`, named and
   * sorted. `'*'` is never here; a marginal is not an uncalibrated structure.
   *
   * Named rather than counted, and published even when empty, for the reason
   * `structuresBelowQuotedMinN` already is: "no structure was flagged" and "no structure could
   * be checked" must not read alike. A non-empty list is a **non-OK** condition — those rows
   * are being charged `single_leg_rv`'s half-spread under another structure's name — and
   * `/api/health/marketable-mtm-forward-validation` downgrades its verdicts accordingly.
   */
  structuresUncalibratedH: string[];
  /** TRA-3697 — the per-structure `h` table in force, derived from {@link MODELED_H_CALIBRATION}. */
  hByStructure: Readonly<Record<string, number>>;
  /** Rides the payload: this is an ENTRY quote and the haircut is applied at EXIT. */
  seamCaveat: string;
  /** Rides the payload: this module emits no retune target, by construction. */
  retuneNote: string;
  samples?: MarketableMtmDemoSample[];
}

export const MARKETABLE_MTM_DEMO_SEAM_CAVEAT =
  'ENTRY QUOTE, EXIT HAIRCUT. Every measurement here is read off entryBid/entryAsk/'
  + 'entryMarkUsd — the two-sided book that SET THE FILL. That is a real book at a real '
  + 'decision time, which is what lets it validate a bid model at all; but the marketable '
  + 'haircut is applied when the position EXITS, and this basis never observes that book. '
  + 'Read it as a grade of the WIDTH REGIME the model prices against — the exact term '
  + '(median full spread $0.15) that TRA-3459 showed the sandbox cannot reach — not as a '
  + 'measurement of the exit cross. TRA-3502 Task 1 threads the live two-sided quote into '
  + 'the exit path itself; its fallback counter (markQuoteCoverage on '
  + '/api/health/marketable-mtm-forward-validation) is what will say how much h still matters.';

export const MARKETABLE_MTM_DEMO_RETUNE_NOTE =
  'NO RETUNE TARGET IS EMITTED HERE, BY CONSTRUCTION. h stays 0.134 (QuantTrader, '
  + 'TRA-3499). On forward DESK, mean(quotedH) = 0.0936 vs 0.134 — h OVER-charges by 43%, '
  + 'which UNDERSTATES realizable P&L: the conservative direction, and the opposite of the '
  + 'TRA-2233 bias. `meanHError` is published so the size and SIGN of the gap are readable, '
  + 'not so it can be subtracted. Never retune onto the sandbox (~0.003 = mid-marking, the '
  + 'TRA-2131 shape TRA-2233 exists to remove).';

/** Retained-population bounds; all four `null` at n=0 (never 0, which is a real epoch). */
function retainedBounds(samples: readonly MarketableMtmDemoSample[]): {
  retainedOpenTsMin: number | null;
  retainedOpenTsMax: number | null;
  retainedOpenIsoMin: string | null;
  retainedOpenIsoMax: string | null;
} {
  if (samples.length === 0) {
    return {
      retainedOpenTsMin: null,
      retainedOpenTsMax: null,
      retainedOpenIsoMin: null,
      retainedOpenIsoMax: null,
    };
  }
  const ts = samples.map((s) => s.openTs);
  const min = Math.min(...ts);
  const max = Math.max(...ts);
  return {
    retainedOpenTsMin: min,
    retainedOpenTsMax: max,
    retainedOpenIsoMin: new Date(min).toISOString(),
    retainedOpenIsoMax: new Date(max).toISOString(),
  };
}

function emptyDrops(): Record<MarketableMtmDemoDropReason, number> {
  return { no_open_ts: 0, before_cohort: 0, no_quote_field: 0, quote_unusable: 0 };
}

function mean(sorted: readonly number[]): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted.reduce((a, b) => a + b, 0) / sorted.length;
}

/** Linear-interpolated quantile over an ASCENDING array. `NaN` at n=0 — never 0. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function moments(values: readonly number[]): MarketableMtmDemoMoments {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    mean: mean(sorted),
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
  };
}

/**
 * CREDIT structures are SHORT the option and buy it back at the ASK; everything else is
 * long and sells at the BID. Listed explicitly rather than inferred, and an unrecognised
 * structure falls to `long` — which is correct for this book (every demo sleeve that
 * writes an `entryBid` opens long premium) and is stated here so the assumption is a
 * readable line of code rather than a silent default buried in a ternary.
 */
const SHORT_STRUCTURES = new Set(['bull_put', 'bear_call', 'iron_condor', 'csp', 'covered_call']);

export function demoJournalSide(structure: string): MarketableSide {
  return SHORT_STRUCTURES.has(structure) ? 'short' : 'long';
}

/** The account partition. `isTestAccount` is INJECTED so the fold stays pure and env-free. */
export function classifyAccount(
  account: string | null | undefined,
  isTestAccount: (username: string) => boolean,
): MarketableMtmAccountClass {
  if (typeof account !== 'string' || account.trim().length === 0) return 'unattributed';
  return isTestAccount(account) ? 'fixture' : 'desk';
}

export interface MarketableMtmDemoJournalOptions {
  /** Modeled half-spread being graded. Defaults to the shipped 0.134. */
  h?: number;
  /**
   * Cohort start, EXCLUSIVE. Defaults to the calibration window's close — the
   * out-of-sample boundary, already on the wire as `MODELED_H_CALIBRATION.windowUtc.to`.
   * A value at or before that close is REFUSED, not clamped: silently widening a
   * caller's cohort to a safe one would hide that they asked for an in-sample grade.
   */
  cohortFromTsExclusive?: number;
  /** Account classifier. Wire to `test-accounts.ts::isTestAccount`; injected to keep this pure. */
  isTestAccount?: (username: string) => boolean;
  includeSamples?: boolean;
}

function cell(
  structure: string,
  accountClass: MarketableMtmAccountClass | '*',
  rows: readonly MarketableMtmDemoSample[],
  h: number,
): MarketableMtmDemoCell {
  const quotedH = moments(rows.map((r) => r.quotedH));
  const quotedCrossUsd = moments(rows.map((r) => r.quotedCrossUsd));
  const modeledCrossUsdOnQuoted = moments(rows.map((r) => r.modeledCrossUsd));
  const tailInput = { modeledCrossUsdOnQuoted, quotedCrossUsd };
  // TRA-3697 — RESOLVED, never defaulted. `'*'` is the structure-axis marginal and has no
  // single structure to resolve; everything else either has its own fit or is refused.
  const hRes = structure === '*' ? null : resolveMarketableMtmH(structure);
  return {
    structure,
    accountClass,
    n: rows.length,
    calibratedH: hRes?.ok === true ? hRes.h : null,
    hRefusal: hRes == null
      ? {
        code: 'POOLED_MARGINAL' as const,
        reason:
          'This cell aggregates over the structure axis, so no per-structure h applies. '
          + 'NOT an uncalibrated structure — read the per-structure cells for that.',
      }
      : hRes.refusal,
    quotedH,
    quotedCrossUsd,
    modeledCrossUsdOnQuoted,
    midUsd: moments(rows.map((r) => r.midUsd)),
    fullSpreadUsd: moments(rows.map((r) => r.fullSpreadUsd)),
    quotedTailUnderCharged: quotedTailUnderCharged(tailInput),
    quotedTailUnderChargeRatio: quotedTailUnderChargeRatio(tailInput),
    meanHError: quotedH.mean - h,
  };
}

/**
 * Fold demo option-journal rows into the out-of-sample quoted-basis grade. Pure.
 *
 * Read {@link MarketableMtmDemoJournalBasis.refusal} FIRST. Non-null means this is not a
 * grade and `pooled`/`cells` carry nothing.
 */
export function foldMarketableMtmDemoJournalBasis(
  rows: readonly MarketableMtmDemoJournalRow[],
  opts: MarketableMtmDemoJournalOptions = {},
): MarketableMtmDemoJournalBasis {
  const h = opts.h ?? MARKETABLE_MTM_DEFAULT_H;
  const calibrationFrom = Date.parse(MODELED_H_CALIBRATION.windowUtc.from);
  const calibrationTo = Date.parse(MODELED_H_CALIBRATION.windowUtc.to);
  const fromTsExclusive = Number.isFinite(opts.cohortFromTsExclusive as number)
    ? (opts.cohortFromTsExclusive as number)
    : calibrationTo;
  const isTestAccount = opts.isTestAccount ?? (() => false);

  const base = {
    basis: 'demoJournalEntryQuote' as const,
    modeledH: h,
    cohort: {
      fromTsExclusive,
      fromIso: new Date(fromTsExclusive).toISOString(),
      calibrationWindowUtc: MODELED_H_CALIBRATION.windowUtc,
    },
    seamCaveat: MARKETABLE_MTM_DEMO_SEAM_CAVEAT,
    retuneNote: MARKETABLE_MTM_DEMO_RETUNE_NOTE,
    hByStructure: MARKETABLE_MTM_H_BY_STRUCTURE,
    // A refusal returns NO cells, so it has censused NO structures. `[]` here means "not
    // measured", exactly as `pooled: null` beside it does — the refusal is what a reader must
    // check first, and it is on the same object.
    structuresUncalibratedH: [] as string[],
  };

  // ── Refusal 1: the requested cohort itself overlaps the training window ──────
  if (fromTsExclusive < calibrationTo) {
    return {
      ...base,
      refusal: {
        code: 'IN_SAMPLE_COHORT',
        reason:
          `Requested cohort starts ${new Date(fromTsExclusive).toISOString()}, at or inside the `
          + `window h=${h} was calibrated on (${MODELED_H_CALIBRATION.windowUtc.from}..`
          + `${MODELED_H_CALIBRATION.windowUtc.to}). Grading a fit against its own training set `
          + 'has no failing state. REFUSED — pass a cohort strictly after the window close.',
        offendingRows: 0,
      },
      rowsSeen: rows.length,
      rowsRetained: 0,
      retainedOpenTsMin: null,
      retainedOpenTsMax: null,
      retainedOpenIsoMin: null,
      retainedOpenIsoMax: null,
      drops: emptyDrops(),
      pooled: null,
      cells: [],
    };
  }

  const drops = emptyDrops();
  const samples: MarketableMtmDemoSample[] = [];
  for (const r of rows) {
    const openTs = typeof r.openTs === 'number' && Number.isFinite(r.openTs) ? r.openTs : null;
    if (openTs == null) { drops.no_open_ts += 1; continue; }
    if (openTs <= fromTsExclusive) { drops.before_cohort += 1; continue; }
    // Probe the KEYS, not the values: a row written before TRA-1656 has no quote fields at
    // all, which drains with age, while a present-but-unusable book is a live data defect.
    // `== null` would collapse the two, which is the ABSENT-vs-NULL collapse TRA-2300 §3
    // had to unpick on the sandbox basis.
    const hasKeys = r.entryBid != null || r.entryAsk != null || r.entryMarkUsd != null;
    if (!hasKeys) { drops.no_quote_field += 1; continue; }
    const structure = typeof r.structure === 'string' && r.structure.trim() !== ''
      ? r.structure
      : 'unknown';
    const side = demoJournalSide(structure);
    const mark = typeof r.entryMarkUsd === 'number' ? r.entryMarkUsd : Number.NaN;
    // Shared guards + shared clamp, from the same kernel the DARK mark prices with, so a
    // corrupt book yields `null` here instead of a manufactured half-spread.
    const quotedH = halfSpreadFracFromQuoteForSide(
      {
        ...(typeof r.entryBid === 'number' ? { bid: r.entryBid } : {}),
        ...(typeof r.entryAsk === 'number' ? { ask: r.entryAsk } : {}),
        mark,
      },
      side,
    );
    if (quotedH == null) { drops.quote_unusable += 1; continue; }
    samples.push({
      structure,
      accountClass: classifyAccount(r.account, isTestAccount),
      side,
      openTs,
      midUsd: mark,
      fullSpreadUsd: (r.entryAsk as number) - (r.entryBid as number),
      quotedH,
      quotedCrossUsd: quotedH * mark * CONTRACT_MULTIPLIER,
      modeledCrossUsd: h * mark * CONTRACT_MULTIPLIER,
    });
  }

  // ── The invariant assertion on the cohort filter (see header §2) ────────────
  // UNREACHABLE on correct code: refusal 1 guarantees `fromTsExclusive >= calibrationTo`
  // and retention is strictly `openTs > fromTsExclusive`, so no retained row can land in
  // the window. It is kept because it HAS a failing state under the one mutation that
  // matters — weaken retention to `openTs < fromTsExclusive` and the boundary row (which
  // sits exactly on the calibration close, inside the training set) is admitted and
  // caught here. Not advertised as an independent check; it is a tripwire on the filter.
  const offending = samples.filter((s) => s.openTs >= calibrationFrom && s.openTs <= calibrationTo);
  if (offending.length > 0) {
    return {
      ...base,
      refusal: {
        code: 'IN_SAMPLE_ROWS',
        reason:
          `${offending.length} retained row(s) fall inside the calibration window `
          + `(${MODELED_H_CALIBRATION.windowUtc.from}..${MODELED_H_CALIBRATION.windowUtc.to}) `
          + 'despite a forward cohort boundary. The population is in-sample and cannot '
          + 'falsify the fit. REFUSED — no moments emitted.',
        offendingRows: offending.length,
      },
      rowsSeen: rows.length,
      rowsRetained: samples.length,
      ...retainedBounds(samples),
      drops,
      pooled: null,
      cells: [],
    };
  }

  // ── Cells: structure × accountClass, plus the marginals on each axis ─────────
  const cells: MarketableMtmDemoCell[] = [];
  const structures = [...new Set(samples.map((s) => s.structure))].sort();
  for (const structure of structures) {
    const inStructure = samples.filter((s) => s.structure === structure);
    cells.push(cell(structure, '*', inStructure, h));
    for (const ac of MARKETABLE_MTM_ACCOUNT_CLASSES) {
      const rowsIn = inStructure.filter((s) => s.accountClass === ac);
      // Emitted only when populated: a cell of n=0 carrying NaN moments is noise, and the
      // absent combination is recoverable from the marginals it is missing from.
      if (rowsIn.length > 0) cells.push(cell(structure, ac, rowsIn, h));
    }
  }
  for (const ac of MARKETABLE_MTM_ACCOUNT_CLASSES) {
    const rowsIn = samples.filter((s) => s.accountClass === ac);
    if (rowsIn.length > 0) cells.push(cell('*', ac, rowsIn, h));
  }
  cells.sort((a, b) => b.n - a.n
    || a.structure.localeCompare(b.structure)
    || a.accountClass.localeCompare(b.accountClass));

  return {
    ...base,
    refusal: null,
    rowsSeen: rows.length,
    rowsRetained: samples.length,
    ...retainedBounds(samples),
    drops,
    pooled: cell('*', '*', samples, h),
    cells,
    // TRA-3697 — censused off the RETAINED structures, not off the cells, so a structure that
    // is present but produced no populated account-class cell still counts. `'*'` is excluded
    // by construction: it is not in `samples[].structure`.
    structuresUncalibratedH: marketableMtmUncalibratedStructures(structures),
    ...(opts.includeSamples === true ? { samples: samples.slice(0, 50) } : {}),
  };
}
