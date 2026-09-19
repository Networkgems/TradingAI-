import {
  liveOptionEvidenceCoverage,
  liveOptionPromotionEvidenceRecords,
  type LiveOptionEvidenceCoverage,
  type LiveOptionFillRecord,
} from './live-options-fee-slippage-ledger.js';
import {
  pairFillsIntoRoundTrips,
  gradeSleeve,
  type HarnessFill,
  type RoundTrip,
  type ValidationVerdict,
} from './paper-accrual-validation.js';
import { OPTIONS_PRODUCTION_STRATEGIES } from './promotion-service.js';

/**
 * TRA-4607 — wire the TRA-4604 harness to the LIVE fee/slippage ledger.
 *
 * ## The question this answers
 *
 * `promotion-service` records that neither production sleeve has cleared
 * net-of-fee forward validation, and the last captured gate was underpowered at
 * 61 observed against 727 required. Those were two numbers in a document. The
 * ledger meanwhile accumulates real fills with real fees and real fill-vs-mid
 * distances, and nothing joined the two — so "are we there yet" was answered by
 * reading a stale report rather than by measuring.
 *
 * This module does the join: ledger rows → round-trips → net-of-fee cohort
 * stats → required-N from the cohort's OWN variance.
 *
 * ## What it deliberately refuses to do
 *
 * **It does not lower the bar.** `requiredSampleSize` is computed from observed
 * σ, so the number moves only when the data moves. If it reports 700-odd
 * remaining, that is the measurement, not a policy choice.
 *
 * **It does not launder `unattributed` rows into a sleeve.** TRA-2959 rows are
 * fills recovered from broker history with no usable provenance. Counting them
 * toward `single_leg_otm` would inflate the sample with trades the sleeve may
 * never have made — the fastest possible way to fake progress toward the gate.
 * They are excluded and COUNTED, in `excluded.unattributed`.
 *
 * **It does not treat derived fees as reported ones.** `gainloss_derived` fees
 * are inferred from the cost/proceeds delta because Tradier's production history
 * reports 0 commission on every row. That inference is sound in aggregate and is
 * still an inference; `feeQuality` publishes the split so a cohort resting
 * mostly on derived fees is visible as such rather than presenting as measured.
 */

/** A live sleeve this gate actually grades. */
export type GradedSleeve = (typeof OPTIONS_PRODUCTION_STRATEGIES)[number];

export interface ValidationProgressExclusions {
  /** TRA-2959 rows with no sleeve provenance. Never attributed. */
  unattributed: number;
  /** Rows whose sleeve is live but is not a graded production sleeve. */
  otherSleeve: number;
  /** Rows the harness refused to price, by reason. */
  unpriced: number;
  unreportedFees: number;
  unmeasuredMid: number;
  /** Opens with no matching close yet — a position, not a discard. */
  stillOpen: number;
  /** Closes with no matching open in the ledger. */
  noMatchingOpen: number;
}

export interface SleeveProgress {
  sleeve: GradedSleeve;
  verdict: ValidationVerdict;
  /**
   * Split of the cohort's fee provenance. `derived` means the figure was
   * inferred from cost/proceeds, not reported by the broker.
   */
  feeQuality: { reported: number; derived: number; unknown: number };
  /** Plain-language read of where this sleeve stands. */
  note: string;
}

export interface ValidationProgressReport {
  /** Ledger rows seen, before any exclusion. */
  fillsSeen: number;
  /**
   * TRA-4727 — WHICH tape was graded and how far back it reaches. The sample is
   * the cumulative archive ∪ window, not the 30-day calibration window; read
   * `earliestFillTs` before reading a small `observedN` as a quiet sleeve —
   * fills compacted away before the archive existed are NOT on it.
   * `null` when the caller passed its own `records` (a fixture).
   */
  coverage: LiveOptionEvidenceCoverage | null;
  /** Round-trips the harness could price. */
  roundTrips: number;
  excluded: ValidationProgressExclusions;
  sleeves: SleeveProgress[];
  /**
   * ⛔ The whole-report caveat. TRUE when NO sleeve has enough data to say
   * anything, which is different from "the sleeves failed".
   */
  unmeasured: boolean;
  note: string;
}

/**
 * The smallest per-trade edge worth detecting, as a fraction of premium at risk.
 *
 * ⚠️ THIS IS THE LEVER THAT FAKES A PASS. Required N scales with (σ/δ)², so
 * inflating δ shrinks the sample requirement without improving the evidence one
 * bit. 0.10 says "a 10% per-trade net edge is what we are trying to detect",
 * which on a long-premium sleeve is already generous. Raising it should be a
 * deliberate, recorded act, not a tuning knob.
 */
export const DEFAULT_MIN_DETECTABLE_EFFECT = 0.1;

function toHarnessFill(r: LiveOptionFillRecord): HarnessFill {
  return {
    ts: r.ts,
    etDay: r.etDay,
    sleeve: r.sleeve,
    book: r.book,
    optionSymbol: r.optionSymbol,
    side: r.side,
    contracts: r.contracts,
    filledPrice: r.filledPrice,
    midAtSubmit: r.midAtSubmit,
    fees: r.fees,
    // Every row in THIS ledger is a live broker fill. The harness's paper/live
    // split exists so a paper cohort can never authorise capital; feeding the
    // live ledger is the only place `live` is legitimate.
    source: 'live',
  };
}

function noteFor(v: ValidationVerdict, n: number): string {
  if (n === 0) {
    return 'UNMEASURED — no priced round-trips for this sleeve yet. Not a failure; there is '
      + 'nothing to grade. Read `excluded` before concluding the sleeve is idle.';
  }
  if (v.passes) {
    return 'PASSES — powered, positive net-of-fee expectancy, profit factor above the floor. '
      + 'This authorises a promotion PROPOSAL, not an automatic arm.';
  }
  const short = v.shortfall;
  if (short > 0) {
    return `UNDERPOWERED — ${v.observedN} of ${v.power.requiredN} required round-trips `
      + `(σ=${v.stats.stdDevNetReturnPct.toFixed(4)}). Required N scales with σ², so the only `
      + 'honest way to shorten this is to reduce σ — measure costs exactly, scope the cohort to '
      + 'one sleeve and one regime. Lowering α or inflating the detectable effect buys a smaller '
      + 'number, not better evidence.';
  }
  return `BLOCKED — ${v.blockers.join('; ')}`;
}

/**
 * Grade the production sleeves against the live ledger.
 *
 * Pure with respect to its input: pass `records` to test against a fixture. The
 * default reads the process-wide CUMULATIVE tape (TRA-4727: archive ∪ window —
 * the 30-day window alone manufactured `noMatchingOpen` and shrank on every boot).
 */
export function computeValidationProgress(
  records?: readonly LiveOptionFillRecord[],
  opts: { minDetectableEffectPct?: number; minProfitFactor?: number } = {},
): ValidationProgressReport {
  const coverage = records === undefined ? liveOptionEvidenceCoverage() : null;
  if (records === undefined) records = liveOptionPromotionEvidenceRecords();
  const graded = new Set<string>(OPTIONS_PRODUCTION_STRATEGIES);
  const excluded: ValidationProgressExclusions = {
    unattributed: 0,
    otherSleeve: 0,
    unpriced: 0,
    unreportedFees: 0,
    unmeasuredMid: 0,
    stillOpen: 0,
    noMatchingOpen: 0,
  };

  const keep: LiveOptionFillRecord[] = [];
  for (const r of records) {
    if (r.sleeve === 'unattributed') {
      excluded.unattributed += 1;
      continue;
    }
    if (!graded.has(r.sleeve)) {
      excluded.otherSleeve += 1;
      continue;
    }
    keep.push(r);
  }

  const { roundTrips, unpaired } = pairFillsIntoRoundTrips(keep.map(toHarnessFill));
  for (const u of unpaired) {
    switch (u.reason) {
      case 'unpriced_fill': excluded.unpriced += 1; break;
      case 'unreported_fees': excluded.unreportedFees += 1; break;
      case 'unmeasured_mid': excluded.unmeasuredMid += 1; break;
      case 'still_open': excluded.stillOpen += 1; break;
      case 'no_matching_open': excluded.noMatchingOpen += 1; break;
    }
  }

  // Fee provenance, per sleeve, over the rows that actually became round-trips.
  const feeQualityBySleeve = new Map<string, { reported: number; derived: number; unknown: number }>();
  for (const r of keep) {
    const q = feeQualityBySleeve.get(r.sleeve) ?? { reported: 0, derived: 0, unknown: 0 };
    if (r.feeSource === 'history_commission') q.reported += 1;
    else if (r.feeSource === 'gainloss_derived') q.derived += 1;
    else q.unknown += 1;
    feeQualityBySleeve.set(r.sleeve, q);
  }

  const sleeves: SleeveProgress[] = OPTIONS_PRODUCTION_STRATEGIES.map((sleeve) => {
    const verdict = gradeSleeve({
      sleeve,
      trips: roundTrips as readonly RoundTrip[],
      minDetectableEffectPct: opts.minDetectableEffectPct ?? DEFAULT_MIN_DETECTABLE_EFFECT,
      minProfitFactor: opts.minProfitFactor,
    });
    return {
      sleeve,
      verdict,
      feeQuality: feeQualityBySleeve.get(sleeve) ?? { reported: 0, derived: 0, unknown: 0 },
      note: noteFor(verdict, verdict.observedN),
    };
  });

  const unmeasured = sleeves.every((s) => s.verdict.observedN === 0);

  return {
    fillsSeen: records.length,
    coverage,
    roundTrips: roundTrips.length,
    excluded,
    sleeves,
    unmeasured,
    note: unmeasured
      ? 'UNMEASURED — no graded sleeve has a priced round-trip. This is NOT "the sleeves are '
        + 'failing"; it is "there is nothing to grade yet". `excluded` says where the rows went.'
      : 'Each sleeve is graded on its OWN variance: requiredN = (z_α/2 + z_β)² · σ²/δ². A sleeve '
        + 'that passes here authorises a promotion PROPOSAL only — arming remains a separate act.',
  };
}
