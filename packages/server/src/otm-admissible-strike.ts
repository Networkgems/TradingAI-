/**
 * TRA-3401 — nominate an OTM strike the armed gates can actually ADMIT.
 *
 * ## The defect
 *
 * `signal-engine.ts` nominates exactly ONE contract per symbol per scan:
 *
 * ```ts
 * const cheap = result.candidates.find((c) => c.classification === 'cheap');
 * if (!cheap) continue;
 * ```
 *
 * The scanner sorts by `|mispricingPct|`, so that `find` returns the single
 * strongest MISPRICING read — chosen with no reference to `delta`. The cost bar
 * downstream is, algebraically, a delta FLOOR: with the shipped estimator knobs
 * absent (mult 1.0, rewardR 2.0, cap 0.95),
 *
 *     grossR = winProb*rewardR - (1 - winProb),  winProb = clamp(|d|*mult, 0, cap)
 *            = 3|d| - 1
 *
 * so `gross_negative` ⟺ |d| < 0.3333 and admission (≥ 0.485R) ⟺ **|d| ≥ 0.4950**
 * (TRA-3388, confirmed out-of-sample 4/4 on post-arm entry deltas: KVYO 0.5052,
 * TROW 0.5111, ABCL 0.5044, SO 0.5091).
 *
 * `|mispricingPct|` is a RATIO, and ranking by a ratio returns the far tail
 * (TRA-2388 documents the same pathology on the read-only panel). So the nominee
 * is systematically a |d| ~ 0.02-0.20 lottery strike, the bar rejects it
 * `gross_negative`, and the `continue` **discards the whole symbol for that
 * scan** — including any near-ATM `cheap` candidate sitting further down the
 * very same chain. Live at `eb1dcf0c` on 2026-08-12T19:20Z: cost_bar evaluated
 * 138 / blocked 138, share 1.00 `gross_negative`, 0 opens, across v0nni (53),
 * Richard (48) and admin (37).
 *
 * That is a SELECTOR/GATE MISMATCH, not strictness. It is why "we used to work
 * a couple of weeks, then it stopped": nothing about the bar changed, the
 * nominee simply never lands where the bar can say yes.
 *
 * ## Why this is not a loosening
 *
 * Every gate keeps its exact shipped threshold. This module changes only WHICH
 * contract from an already-scanned chain is nominated, and it nominates INTO the
 * band TRA-3392 ratified — `[0.495, 0.55)` — which is:
 *
 *   - the only |d| cell with a positive, Bonferroni-surviving expectancy on the
 *     model-facing tape (n=87, E[R_gate] +1.649, t=+3.45 — TRA-3388), and
 *   - bounded ABOVE at 0.55 by TRA-1670's measured loss tail (realized win rate
 *     collapses to 0.077 above it).
 *
 * The de-authorized |d| < 0.20 region (E[R_gate] -0.117 at t=-4.45, and -0.212
 * at t=-3.11) is exactly what today's nominee sits in. Retargeting therefore
 * moves the sleeve OUT of its two measured losing cells and INTO its one
 * measured winner, while leaving every threshold untouched.
 *
 * ## Never silent
 *
 * The old `find` reports nothing: a chain with no admissible strike and a chain
 * with no `cheap` candidate at all both read as "no signal". Both branches here
 * return a populated result so the caller can log and count the verdict, which
 * is the property TRA-2341/TRA-2388 exist to preserve.
 *
 * ## Screen order (TRA-3619, inverted by TRA-3856)
 *
 * **Armed, the band filter runs FIRST and classification ranks INSIDE it.**
 * Until TRA-3856 the order was the reverse — `classification === 'cheap'`
 * first, band second — and the no-overlap branch fell back to the top
 * mispricing at ANY delta instead of abstaining, so the armed selector was
 * guaranteed to nominate a far-OTM strike the cost bar must reject whenever
 * `cheap ∩ band = ∅` (which TRA-3859 measured as the normal live shape: every
 * in-band strike on the 10-name universe classified `fair`). `cheapInBand` is
 * still `cheap ∩ band` and `strikesInBand` is still the pre-classification
 * band count, so both series stay comparable across the change.
 *
 * The upstream ordering matters too: `findMispricedOtmContracts` applies the OTM
 * side test and the liquidity/quality screens BEFORE classifying, so even the
 * "pre-cheapness" set is post-liquidity. See {@link AdmissibleStrikeResult.strikesConsidered}.
 */

/** The subset of `OtmMispricingCandidate` this selector reads. */
export interface AdmissibleStrikeCandidate {
  /** Sign-adjusted Black-Scholes delta — negative for puts, hence the abs. */
  delta: number;
  classification: string;
  /**
   * TRA-3870 — per-contract ask, USD (option quote units, ×100 for notional).
   * Optional: a caller that passes no `maxEntryUsd` never reads it.
   */
  ask?: number;
}

export const OTM_ADMISSIBLE_STRIKE_FLAG = 'ENABLE_OTM_ADMISSIBLE_STRIKE_SELECT';
export const OTM_ADMISSIBLE_DELTA_MIN_VAR = 'OTM_ADMISSIBLE_DELTA_MIN';
export const OTM_ADMISSIBLE_DELTA_MAX_VAR = 'OTM_ADMISSIBLE_DELTA_MAX';

/**
 * Inclusive lower edge of the ratified band. 0.495 is the cost bar's own
 * admission threshold under the shipped config (`3|d| - 1 >= 0.485`), not a
 * preference — nominating below it is nominating a guaranteed reject.
 */
export const OTM_ADMISSIBLE_DELTA_MIN_DEFAULT = 0.495;
/** Exclusive upper edge — TRA-1670's measured loss tail begins at 0.55. */
export const OTM_ADMISSIBLE_DELTA_MAX_DEFAULT = 0.55;

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff admissible-strike selection is armed. OFF by default (dark). */
export function isOtmAdmissibleStrikeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OTM_ADMISSIBLE_STRIKE_FLAG]);
}

function resolveBandEdge(raw: string | undefined, fallback: number): number {
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    // A delta magnitude is a probability-like (0,1) quantity. Anything else is a
    // malformed knob, and a malformed knob must not silently redefine the band.
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) return parsed;
  }
  return fallback;
}

export interface AdmissibleBand {
  /** Inclusive. */
  min: number;
  /** Exclusive. */
  max: number;
}

/**
 * Resolve the admission band from env, falling back to the TRA-3392 ratified
 * edges. An inverted or degenerate band (min >= max) falls back to BOTH
 * defaults rather than to a half-applied band — a band that admits nothing is
 * indistinguishable from the bug this module fixes.
 */
export function resolveAdmissibleBand(env: NodeJS.ProcessEnv = process.env): AdmissibleBand {
  const min = resolveBandEdge(env[OTM_ADMISSIBLE_DELTA_MIN_VAR], OTM_ADMISSIBLE_DELTA_MIN_DEFAULT);
  const max = resolveBandEdge(env[OTM_ADMISSIBLE_DELTA_MAX_VAR], OTM_ADMISSIBLE_DELTA_MAX_DEFAULT);
  if (!(min < max)) {
    return { min: OTM_ADMISSIBLE_DELTA_MIN_DEFAULT, max: OTM_ADMISSIBLE_DELTA_MAX_DEFAULT };
  }
  return { min, max };
}

export type AdmissibleSelection =
  /** A `cheap` candidate inside the band — the nominee the bar can admit. */
  | 'in_band'
  /**
   * TRA-3856 — no `cheap` strike in the band, so the strongest non-`expensive`
   * mispricing read INSIDE the band is nominated instead. This is the
   * "non-cheapest in-band strike" population TRA-3859 priced: on the live
   * 10-name universe every in-band strike classified `fair`, so without this
   * tier the armed selector nominates in-band roughly never (`cheap ∩ band` was
   * 2 rows in the whole 08-19 session, both off-allowlist). `expensive` (IV
   * rich) is never nominated — buying measured-rich premium is not a tier.
   */
  | 'in_band_fair'
  /**
   * HISTORICAL (pre-TRA-3856). The armed no-overlap branch used to return the
   * top mispricing at ANY delta — a far-OTM strike the cost bar must reject
   * (766/766 blocked over 08-05→08-19). No new row can carry this value; it
   * stays in the union so persisted ledger rows hydrate instead of dropping.
   */
  | 'fallback_top_mispricing'
  /**
   * TRA-3856 — band armed, chain surveyed, and no nominable strike (cheap or
   * fair) sits inside it: ABSTAIN. The old behaviour here was the defect — a
   * nominee the downstream gates are guaranteed to reject is not a signal, and
   * emitting one made the sleeve's zero read as gate strictness instead of
   * selector output. The caller records the abstention on its own scan-run
   * bucket, so a suppressed scan is counted, never silent.
   */
  | 'abstain_no_in_band'
  /** Selector disarmed — byte-identical to the legacy `find`. */
  | 'legacy'
  /** Empty chain (armed) or no `cheap` candidate (disarmed). Thin, not suppressed. */
  | 'none';

export interface AdmissibleStrikeResult<T extends AdmissibleStrikeCandidate> {
  candidate: T | null;
  selection: AdmissibleSelection;
  /** How many `cheap` candidates the chain offered. */
  cheapConsidered: number;
  /** How many of those landed inside the band. */
  cheapInBand: number;
  /**
   * TRA-3619 — every candidate the scanner handed this selector, BEFORE the
   * cheapness screen. The denominator {@link strikesInBand} has to be read
   * against: `strikesInBand: 0` out of 3 considered is a thin chain, and
   * `strikesInBand: 0` out of 40 is a statement about where the band sits.
   *
   * NOT the raw option chain. `findMispricedOtmContracts` has already applied the
   * OTM side test and the liquidity/quality screens (bid>0, ask≥bid,
   * mark ≥ `minMark`, spreadPct ≤ `maxSpreadPct`, openInterest ≥ `minOpenInterest`,
   * dte > 0, resolvable IV, and `minAbsDelta` when a caller sets one — the live
   * path does not). So this counts SURVIVING strikes, and the honest reading of a
   * zero is "no in-band strike survived the liquidity screen", which is one step
   * short of "the chain has no in-band strike".
   */
  strikesConsidered: number;
  /**
   * TRA-3619 — the measurement this field exists for. Candidates whose |Δ| is
   * inside the band, counted BEFORE `classification === 'cheap'` is applied.
   *
   * {@link cheapInBand} is `cheap ∩ band`, so on an `abstain_no_in_band` row
   * (or a persisted `fallback_top_mispricing` one) it is 0 by construction and
   * cannot separate two very different worlds:
   *
   *   • `strikesInBand: 0`  ⇒ the band is empty IN THE CHAIN. Nothing the branch
   *     ordering does can help; the band edges are the question (TRA-3401).
   *   • `strikesInBand ≥ 1` ⇒ the chain HAD in-band strikes and every one of
   *     them classified `expensive` — nominable under no tier.
   *
   * The band is only consulted when the selector is armed, so this is 0 on the
   * `legacy` (disarmed) branch — the same convention {@link cheapInBand} uses.
   * `legacy` is its own key on the `bySelection` axis, so a dark-selector 0 can
   * never be folded in with an armed branch's measured 0.
   */
  strikesInBand: number;
  /** The band applied, echoed so a verdict is readable without re-deriving it. */
  band: AdmissibleBand;
  /**
   * TRA-3870 — in-band candidates whose ONE-CONTRACT ask notional (`ask × 100`)
   * fits the caller's `maxEntryUsd` budget. `null` ⇔ no budget was applied
   * (absent ≠ 0: a 0 here is a measured "nothing in band is fundable", which is
   * the wall-2/3 diagnosis, while `null` is "affordability was never graded").
   */
  fundableInBand: number | null;
}

/**
 * Pick the OTM nominee — BAND FIRST (TRA-3856).
 *
 * Candidates arrive sorted by `|mispricingPct|` (rank order), and that order is
 * preserved within the band: within each tier this returns the STRONGEST
 * mispricing read, so the mispricing edge still drives the choice — the band
 * bounds where it may look.
 *
 * Armed, the band filter runs FIRST and classification ranks INSIDE it:
 *
 *   1. `cheap` in band   → `in_band`         (unchanged from TRA-3401)
 *   2. `fair` in band    → `in_band_fair`    (TRA-3856 — the tier that makes the
 *                                             armed selector nominate at all on
 *                                             chains where nothing in band is
 *                                             underpriced, which TRA-3859 measured
 *                                             to be the normal live shape)
 *   3. nothing nominable → `abstain_no_in_band`, candidate `null` — NEVER the
 *      far-OTM fallback. The old no-overlap branch nominated the top mispricing
 *      at any delta, which the cost bar is algebraically guaranteed to reject
 *      (|Δ| < 0.495 ⇒ blocked; 766/766 over 08-05→08-19). An abstention the
 *      caller can count beats a nomination the gates must refuse.
 *
 * `expensive` is excluded from every tier: this sleeve is long-only, and an
 * IV-rich contract is a measured overpay, not a weaker signal.
 *
 * When `enabled` is false the result is byte-identical to the legacy
 * `find(c => c.classification === 'cheap')`, which is what makes this safe to
 * ship dark.
 *
 * A non-finite `delta` fails the band (matching TRA-1407's engine-side
 * predicate): an un-scored contract has no business clearing a distance gate.
 *
 * ## Budget preference (TRA-3870)
 *
 * `maxEntryUsd`, when set, is the board's small-account per-entry bound ($300,
 * 2026-08-19). WITHIN each tier the selector prefers the strongest mispricing
 * read whose one-contract ask notional fits it. Without this, the strongest
 * in-band read (an $800–$1,819 SPY/QQQ contract on the measured live chains)
 * permanently shadows a fundable in-band strike further down the SAME chain —
 * sizing returns 0 contracts and the sleeve re-creates the screen/gate
 * no-intersection zero one wall later. When NOTHING in the tier fits, the
 * tier's top pick is still nominated (unchanged behaviour): the funding
 * refusal downstream stays visible on the ledger instead of being converted
 * into a silent abstention. No budget (`null`/absent) ⇒ behaviour is
 * byte-identical to pre-TRA-3870.
 */
export function selectAdmissibleOtmCandidate<T extends AdmissibleStrikeCandidate>(
  candidates: readonly T[],
  opts: { enabled: boolean; band: AdmissibleBand; maxEntryUsd?: number | null },
): AdmissibleStrikeResult<T> {
  const { enabled, band } = opts;
  // A budget must be a positive finite dollar figure to grade anything; every
  // other shape means "no budget applied", never "budget 0" (absent ≠ 0).
  const budgetUsd =
    typeof opts.maxEntryUsd === 'number' && Number.isFinite(opts.maxEntryUsd) && opts.maxEntryUsd > 0
      ? opts.maxEntryUsd
      : null;
  const cheap = candidates.filter((c) => c.classification === 'cheap');

  if (!enabled) {
    const top = cheap.length > 0 ? cheap[0] : null;
    return {
      candidate: top,
      selection: top ? 'legacy' : 'none',
      cheapConsidered: cheap.length,
      cheapInBand: 0,
      strikesConsidered: candidates.length,
      strikesInBand: 0,
      band,
      fundableInBand: null,
    };
  }

  const inBandOf = (c: AdmissibleStrikeCandidate): boolean => {
    const abs = Math.abs(c.delta);
    return Number.isFinite(abs) && abs >= band.min && abs < band.max;
  };

  // TRA-3619 — the SAME band predicate for the count and the tiers. It is
  // deliberately the identical function rather than a re-implementation: the
  // whole value of the count is that `strikesInBand === 0` and `cheapInBand === 0`
  // are comparable, and two predicates that could drift apart would make the
  // comparison meaningless.
  const bandCandidates = candidates.filter(inBandOf);
  const strikesInBand = bandCandidates.length;
  const inBandCheap = bandCandidates.filter((c) => c.classification === 'cheap');

  // TRA-3870 — does ONE contract fit the budget? Requires a readable positive
  // ask: an unpriced candidate cannot prove it fits, so it fails the preference
  // (it stays nominable through the no-fundable fallback, never silently).
  const fitsBudget = (c: AdmissibleStrikeCandidate): boolean =>
    budgetUsd !== null
    && typeof c.ask === 'number'
    && Number.isFinite(c.ask)
    && c.ask > 0
    && c.ask * 100 <= budgetUsd;
  const fundableInBand = budgetUsd === null ? null : bandCandidates.filter(fitsBudget).length;

  // Rank order (strongest |mispricingPct| first) is preserved by `find`, so the
  // preferred pick is the strongest FUNDABLE read; the tier's top pick is the
  // fallback when nothing in the tier fits.
  const pickPreferringBudget = (tier: readonly T[]): T =>
    (budgetUsd === null ? tier[0] : (tier.find(fitsBudget) ?? tier[0]));

  const shape = {
    cheapConsidered: cheap.length,
    strikesConsidered: candidates.length,
    strikesInBand,
    band,
    fundableInBand,
  };

  if (inBandCheap.length > 0) {
    return {
      candidate: pickPreferringBudget(inBandCheap),
      selection: 'in_band',
      cheapInBand: inBandCheap.length,
      ...shape,
    };
  }

  const inBandFair = bandCandidates.filter((c) => c.classification === 'fair');
  if (inBandFair.length > 0) {
    return {
      candidate: pickPreferringBudget(inBandFair),
      selection: 'in_band_fair',
      cheapInBand: 0,
      ...shape,
    };
  }

  // An empty chain is a fact about the market data ('none'); a surveyed chain
  // with nothing nominable in band is a fact about the band ('abstain...').
  // They demand opposite responses, so they must not share a key.
  return {
    candidate: null,
    selection: candidates.length === 0 ? 'none' : 'abstain_no_in_band',
    cheapInBand: 0,
    ...shape,
  };
}
