import {
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
  type DeflatedSharpeResult,
  type PboResult,
} from './overfitting-stats.js';

// TRA-1664 (parent TRA-1609) — OFFLINE expectancy harness for the PCR shadow
// ledger. Reads `DATA_DIR/pcr-shadow-signals.jsonl`, joins a forward outcome the
// ledger deliberately does not carry, and grades the TRA-532 promotion bar.
//
// Nothing here is imported by the server, the engine, or `doTick`. No live path,
// no order surface, no broker call. It is analysis code that runs by hand.
//
// The pre-registration (locked 2026-07-12, before any row accrued) is encoded as
// CONSTANTS in this file rather than left in a comment thread, because the whole
// point of pre-registering is that the bar cannot move after the data is seen.
// If you are changing a number below AFTER looking at a result, you are p-hacking.

/**
 * THE ECONOMIC FLOOR. The incremental expectancy uplift the PCR overlay must clear, in R.
 *
 * *** THIS BAR IS SOUND AS AN ECONOMIC FLOOR AND WAS NEVER A STATISTICAL ONE. ***
 *
 * It says "an edge smaller than +0.05R is not worth trading". That is a business judgement
 * and it stands. What it CANNOT say — and what it silently did duty as for four months —
 * is "an edge of +0.05R is one this study could SEE". It is not. Measured on REAL bars
 * (TRA-1810), the session-clustered interval that grades this bar has a half-width of
 * 0.18R-0.44R at the planned N=90 read, so the bar sits 3.6x-8.9x BELOW THE NOISE FLOOR OF
 * THE ESTIMATOR THAT GRADES IT. Resolving +0.05R at 80% power needs ~2,300-2,700 sessions —
 * NINE TO ELEVEN YEARS.
 *
 * A bar you cannot resolve is not a bar; it is a coin flip with a number written on it. So
 * this constant is NO LONGER THE BINDING THRESHOLD ON ITS OWN. It is one of two terms in
 * `effectiveBar()`, which takes the LARGER of this and the measured resolution of the
 * instrument. See `DETECTABILITY_FLOOR_CONSTRAINT` (TRA-1830).
 *
 * The value is UNCHANGED, deliberately: nothing here moves the economic floor. Landing
 * this BEFORE the ledger's first row is what makes it legitimate — see the header.
 */
export const PCR_UPLIFT_BAR_R = 0.05;

/**
 * ===========================================================================
 * TRA-1830 — THE DETECTABILITY FLOOR. The bar the estimator can actually resolve.
 * ===========================================================================
 *
 * THE PROBLEM, IN ONE LINE: `PCR_UPLIFT_BAR_R` is an ECONOMIC floor that has been quietly
 * doing duty as a STATISTICAL one, and it cannot. Nobody chose that; it was never measured.
 *
 * TRA-1756 R3 measured the primary's MDE on the synth and found the bar ~4-12x under the
 * interval's own half-width. TRA-1810 then calibrated the synth against the REAL 25-name
 * watchlist and closed the last escape hatch: `k_total = 0.92`, so the real cross-section is
 * NOT more dispersed than the synth and the finding is a CALIBRATED CLAIM ABOUT REAL BARS,
 * not a claim about a generator. On real bars the half-width runs 0.18R (null) to 0.44R (a
 * real edge) against a 0.05R bar.
 *
 * THE FIX. The binding bar becomes
 *
 *     effectiveBar = max(PCR_UPLIFT_BAR_R, clustered CI half-width)
 *
 * - It PRESERVES the economic floor: never promote below +0.05R.
 * - It ENFORCES the statistical floor: never promote an uplift the estimator cannot resolve.
 * - It makes the impossibility VISIBLE IN THE REPORT. At N=90 the effective bar surfaces as
 *   ~0.4R and the report SAYS SO, out loud, on the page where the verdict is read — instead
 *   of being hidden inside a constant that reads as 0.05. IN NOVEMBER SOMEBODY READS A
 *   VERDICT OFF A TABLE, NOT THIS FILE. That is the whole point of the change.
 * - It is SELF-CALIBRATING: it tightens automatically as sessions accrue, and it needs no
 *   input from the synthetic generator, whose R-scale is the one thing that could have been
 *   wrong. (Same construction as TRA-1756 R1's condemn rule in `pcr-cross-sectional.ts`:
 *   "the shortfall must exceed the resolution". Same idea, the other side of the bar.)
 *
 * *** IT IS MONOTONE. IT CAN ONLY EVER MAKE A PASS HARDER. ***
 *
 * `effectiveBar >= PCR_UPLIFT_BAR_R` always, so the PASS leg is strictly tightened and no
 * sample that FAILed or HELD under the old bar can PASS under the new one. It CANNOT
 * manufacture a promotion. That is the same safety property that let TRA-1726's FAIL->HELD
 * change land without re-opening the pre-registration, and it is why this one can too.
 *
 * *** AND IT DOES NOT TOUCH THE FAIL BRANCH. THIS IS THE LOAD-BEARING ASYMMETRY. ***
 *
 * The obvious-looking move — swap `effectiveBar` into the decisive-NO-GO rule as well, "for
 * consistency" — is a CATASTROPHE, and it is worth spelling out because it looks like tidying:
 *
 *     FAIL iff  ciUpper < effectiveBar  ~=  point + hw < hw  ~=  point < 0
 *
 * On a NULL world the point estimate is negative half the time. That rule would CONDEMN the
 * overlay — irreversibly, TRA-1726: a FAIL retires TRA-1609 — on roughly a COIN FLIP. The
 * detectability floor exists to stop imprecision being read as PROMOTION; wiring it into the
 * condemn branch would convert that same imprecision into CONDEMNATION, which is the exact
 * error TRA-1726 fixed, running backwards. A wide interval is IGNORANCE. Ignorance must make
 * both PASS and FAIL harder, never one of them easier.
 *
 * So: the FAIL branch keeps the ECONOMIC bar. PASS gets the effective one. The two branches
 * disagree ON PURPOSE — as `xsFeasibilityRuling` and `xsCondemnRuling` already do, and for
 * the same reason: they are asking different questions, and reading either as the other is
 * how a fail-closed gate becomes a fail-open one.
 */
export const DETECTABILITY_FLOOR_CONSTRAINT =
  'DETECTABILITY FLOOR (TRA-1830). The promotion bar is `max(+0.05R, the session-clustered ' +
  'CI half-width)` — the LARGER of the ECONOMIC floor ("an edge this small is not worth ' +
  'trading") and the STATISTICAL one ("an edge this small cannot be told from zero by this ' +
  'estimator"). The +0.05R constant is ONLY the economic term and it was never a detectable ' +
  'threshold: on REAL bars the half-width runs 0.18-0.44R at N=90, so the raw bar sits ' +
  '3.6x-8.9x BELOW the noise floor of the estimator that grades it, and resolving +0.05R at ' +
  '80% power would take ~2,300-2,700 sessions (NINE TO ELEVEN YEARS). *** IF THE EFFECTIVE ' +
  'BAR PRINTED ON THIS REPORT IS MUCH LARGER THAN 0.05R, THAT IS NOT A BUG — IT IS THE ' +
  'INSTRUMENT TELLING YOU WHAT IT CAN ACTUALLY SEE. *** The floor only ever makes a PASS ' +
  'HARDER; it can never manufacture one, and it is deliberately NOT applied to the FAIL ' +
  'branch (there it would convert imprecision into an irreversible condemnation).';

/** How the effective bar was decided, and out of what. Reported on every cell. */
export interface EffectiveBar {
  /** The ECONOMIC floor — `PCR_UPLIFT_BAR_R`. Never moves. */
  economicR: number;
  /** The STATISTICAL floor — the session-clustered CI's half-width. NaN if inevaluable. */
  halfWidthR: number;
  /** THE BINDING BAR: max of the two. NaN (=> no PASS) when the CI is inevaluable. */
  effectiveR: number;
  /** WHICH TERM IS BINDING. `non-evaluable` fails closed: the uplift leg cannot pass. */
  binding: 'economic' | 'detectability' | 'non-evaluable';
}

/** The half-width of an interval — the estimator's own resolution, in R. */
export function ciHalfWidth(ci: Pick<Ci, 'lo' | 'hi'>): number {
  if (!Number.isFinite(ci.lo) || !Number.isFinite(ci.hi)) return Number.NaN;
  return (ci.hi - ci.lo) / 2;
}

/**
 * THE BINDING PROMOTION BAR (TRA-1830). The single source of truth — the verdict calls it,
 * the report prints it, and every test calls it. NOBODY RETYPES IT: a grader written from
 * recall is a different grader, and this study has already shipped three controls that did
 * not discriminate because a second copy of a rule drifted from the first.
 *
 * FAILS CLOSED. An inevaluable interval yields `NaN`, and `NaN >= x` is false, so the uplift
 * leg cannot pass on an instrument that could not produce a number. "We could not measure the
 * noise" is not a licence to promote.
 */
export function effectiveBar(ci: Pick<Ci, 'lo' | 'hi'>): EffectiveBar {
  const halfWidthR = ciHalfWidth(ci);
  if (!Number.isFinite(halfWidthR)) {
    return {
      economicR: PCR_UPLIFT_BAR_R,
      halfWidthR: Number.NaN,
      effectiveR: Number.NaN,
      binding: 'non-evaluable',
    };
  }
  const effectiveR = Math.max(PCR_UPLIFT_BAR_R, halfWidthR);
  return {
    economicR: PCR_UPLIFT_BAR_R,
    halfWidthR,
    effectiveR,
    binding: halfWidthR > PCR_UPLIFT_BAR_R ? 'detectability' : 'economic',
  };
}

/** Does an uplift clear the binding bar? The ONLY place the PASS comparison is made. */
export function clearsEffectiveBar(upliftR: number, bar: EffectiveBar): boolean {
  return Number.isFinite(upliftR) && Number.isFinite(bar.effectiveR) && upliftR >= bar.effectiveR;
}

/**
 * The line that travels with every verdict. It names the effective bar, the half-width, and
 * WHICH of the two terms is binding — because a reader who sees a 0.4R bar and does not know
 * where it came from will "fix" it back to 0.05R.
 */
export function effectiveBarReason(bar: EffectiveBar, upliftR: number): string {
  if (bar.binding === 'non-evaluable') {
    return (
      'EFFECTIVE BAR: NOT EVALUABLE — the session-clustered interval could not be computed, so ' +
      'the estimator\'s resolution is unknown and the detectability floor cannot be checked. ' +
      'FAILS CLOSED: no PASS is available. (Economic floor is still ' +
      `${PCR_UPLIFT_BAR_R}R; measured uplift ${Number.isFinite(upliftR) ? upliftR.toFixed(4) : 'n/a'}R.)`
    );
  }
  if (bar.binding === 'economic') {
    return (
      `EFFECTIVE BAR ${bar.effectiveR.toFixed(4)}R — the ECONOMIC floor is binding ` +
      `(${PCR_UPLIFT_BAR_R}R >= the ${bar.halfWidthR.toFixed(4)}R CI half-width). The estimator ` +
      `can resolve its own bar on this sample. Measured uplift ` +
      `${Number.isFinite(upliftR) ? upliftR.toFixed(4) : 'n/a'}R.`
    );
  }
  return (
    `EFFECTIVE BAR ${bar.effectiveR.toFixed(4)}R — *** THE DETECTABILITY FLOOR IS BINDING *** ` +
    `(the session-clustered CI half-width ${bar.halfWidthR.toFixed(4)}R exceeds the ` +
    `${PCR_UPLIFT_BAR_R}R economic floor by ${(bar.halfWidthR / PCR_UPLIFT_BAR_R).toFixed(1)}x). ` +
    `THE +0.05R BAR IS BELOW THE NOISE FLOOR OF THE ESTIMATOR THAT GRADES IT, so promoting on ` +
    `it would promote an uplift this study cannot tell from zero. Measured uplift ` +
    `${Number.isFinite(upliftR) ? upliftR.toFixed(4) : 'n/a'}R. ${DETECTABILITY_FLOOR_CONSTRAINT}`
  );
}

/**
 * TRA-1756 R3, RE-ISSUED AGAINST THE TRA-1830 FACTOR-CALIBRATED GENERATOR. The PRIMARY's
 * minimum detectable effect. Stamped into every primary report for the same reason TRA-1727's
 * SELECTION_ONLY_CONSTRAINT is stamped into every secondary one: in November somebody reads a
 * verdict off a table, not this file.
 *
 * WHY THIS TABLE MOVED. The original R3 table was measured on the pre-TRA-1830 synth, whose
 * within-session ICC was 0.712 — 2.0x the real watchlist's 0.358 (TRA-1810). Because
 * `edge:'real'` injects its edge THROUGH the market factor, an over-loaded factor made the
 * same `gamma` buy ~2x the uplift it buys on realistic bars, so the old headline "MDE ~+1.5R"
 * was itself a synth artefact. TRA-1830 reparameterised the generator to ICC 0.358 (holding
 * the already-calibrated R-scale fixed, k_total 0.92 -> 0.90) and this table is the re-read.
 *
 * The secondary (TRA-1727) was found unable to release on any edge we could plausibly find.
 * THE PRIMARY HAS THE SAME DISEASE. Measured on the CORRECTED synth, calibrating the knob to
 * an EFFECT SIZE first (`gamma` is a coefficient, not an uplift) and only then reading power:
 *
 *   generator     | true uplift | vs the bar | PASS at N=45 | PASS at N=90 | half-width N=90
 *   --------------+-------------+------------+--------------+--------------+----------------
 *   zero edge     |   -0.03R    |     -      |     0/12     |     0/12     |  0.205R
 *   real, g=0.15  |   +0.22R    |    4.3x    |     1/12     |     1/12     |  0.378R
 *   real, g=0.3   |   +0.48R    |    9.6x    |     0/12     |     2/12     |  0.406R
 *   real, g=0.6   |   +0.80R    |   16.1x    |     1/12     |     2/12     |  0.450R
 *   real, g=1.2   |   +1.02R    |   20.5x    |     3/12     |     7/12     |  0.466R  <- the
 *   real, g=2.0   |   +1.06R    |   21.2x    |     5/12     |     7/12     |  0.462R  positive
 *                                                                                     control
 *
 * READ THE `g=0.3` ROW. A TRUE EDGE OF NEARLY TEN TIMES THE PROMOTION BAR MUSTERS ~17% POWER
 * AT THE PLANNED N=90 READ. The MDE is ~+1.0R (about 20x the bar). The gate's own positive
 * control (`edge:'real'`, gamma 1.2) is +1.02R and only reaches ~58% power. The magnitudes
 * shrank ~30% from the old synth's 30x/+1.5R headline, and THE DISEASE SURVIVED THE FIX: the
 * bar is still far under the noise floor after the generator was made realistic.
 *
 * The right-hand column is the mechanism: the session-clustered interval runs 0.20R (null) to
 * 0.47R (a real edge) at the HALF-width, against a bar of 0.05R. THE BAR SITS ROUGHLY 4x TO 9x
 * BELOW THE NOISE FLOOR OF THE ESTIMATOR THAT GRADES IT, and the interval WIDENS as the true
 * edge grows, so the instrument gets LESS precise exactly when there is something to see.
 *
 * CONSEQUENCE FOR THE NOVEMBER READ: a HELD is the overwhelmingly likely outcome and it is
 * NOT EVIDENCE OF ABSENCE. It means "no edge larger than ~+1.0R", which rules out nothing
 * anyone ever believed about PCR. Do not read it as "PCR does not work — drop TRA-1609".
 *
 * THE REMAINING SYNTH-vs-REAL GAP. The R-scale and factor structure are now calibrated to real
 * bars, but the edge injected per `gamma` still reads ~1.5x above the real-bars uplift measured
 * on TRA-1810 (g=1.2 = +1.02R here vs +0.70R on real bars) — the ICC fix does not fully calibrate
 * the edge-injection mechanism. So every effect size above is, if anything, still OPTIMISTIC:
 * the real detectability floor is at least this bad, and the DETECTABILITY_FLOOR of TRA-1830 —
 * which reads the resolution off the SAMPLE, not off this generator — is the guard that does not
 * depend on any of these numbers being exactly right.
 */
export const PRIMARY_POWER_CONSTRAINT =
  'POWER. The minimum detectable effect of this PRIMARY read is roughly +1.0R at N=90 — about ' +
  '20x the +0.05R promotion bar — measured on the TRA-1830 factor-calibrated generator (its ' +
  'within-session ICC is matched to the real watchlist at 0.358). A true uplift of +0.48R — nearly ' +
  'TEN times the bar — still releases only ~2 times in 12. The session-clustered 90% CI runs ' +
  '0.20-0.47R at the half-width, so the bar sits roughly 4x to 9x BELOW the noise floor of the ' +
  'estimator that grades it: the bar was chosen as a PROMOTION threshold and was never checked to ' +
  'be a DETECTABLE one. *** A HELD IS NOT EVIDENCE OF ABSENCE. *** It means "no edge larger than ' +
  'the MDE" — it does NOT mean "no edge", and it is NOT a reason to drop the PCR overlay. The ' +
  'generator R-scale and factor structure are now CALIBRATED TO REAL BARS (TRA-1810/1830, k_total ' +
  '0.92), but the edge injected per gamma still reads ~1.5x above the real-bars uplift (g=1.2 = ' +
  '+1.0R synth vs +0.70R on real bars), so every synth effect size here is if anything OPTIMISTIC.';
/** Bootstrap confidence level — the binding CI is the session-clustered one. */
export const PCR_BOOTSTRAP_CONFIDENCE = 0.9;
/** Bootstrap resamples. Fixed so a run is reproducible from the seed alone. */
export const PCR_BOOTSTRAP_ITERS = 5000;
/** Deterministic seed — a pre-registered test may not vary run to run. */
export const PCR_BOOTSTRAP_SEED = 1664;
/** |z| beyond which the z-delta carrier calls a side. */
export const PCR_Z_SIDE_THRESHOLD = 1.0;
/** TRA-540's floor: below this many independent units, no verdict is possible. */
export const MIN_INDEPENDENT_SESSIONS = 20;

/** PRIMARY horizon. The verdict is read off this one. */
export const PRIMARY_HORIZON = 5;
/** Pre-declared robustness horizons. Publishing all three is mandatory. */
export const HORIZONS = [3, 5, 10] as const;

/**
 * TOTAL multiplicity of the WHOLE PCR study, and the DSR trial count for BOTH reads.
 *
 * The PRIMARY (time-series) grid is 2 carriers x 2 interpretations x 3 horizons = 12
 * cells. TRA-1727 adds a SECONDARY (cross-sectional) estimand that looks at the SAME
 * grid = 12 more. 24 configurations have now been searched, and DSR must deflate by
 * all 24 — on BOTH reads.
 *
 * ADDING A SECOND LOOK IS NOT FREE AND MUST NOT BE LAUNDERED AS ONE. If each read
 * deflated by only its own 12, the study would take two independent shots at the bar
 * while each shot reported the multiplicity of a single one — which is precisely the
 * bias DSR exists to remove. So the primary's penalty goes UP when the secondary is
 * added, and that cost is paid where it is incurred rather than hidden.
 *
 * Lives HERE, not in `pcr-cross-sectional.ts`, only to keep the import acyclic.
 */
export const PCR_STUDY_TRIALS = 24;

/**
 * The two carriers of the PCR read (bar point 4 — reported separately).
 * - `raw`   — the face-value ratio level (its regime bucket).
 * - `zDelta`— the trailing-20-session z-score of the ratio. Only defined on
 *             MATURE-z rows (trailing n >= 10), which the ledger already encodes
 *             by nulling `pcrZ` below that floor (TRA-1663).
 */
export type PcrCarrier = 'raw' | 'zDelta';

/**
 * The two interpretations of the read (bar point 6 — reported separately).
 * These call OPPOSITE sides from the same number, so they can never be collapsed
 * into one cohort: heavy put flow is face-value `bearish` and contrarian `bullish`.
 */
export type PcrInterpretation = 'confirming' | 'contrarian';

export type Side = 'call' | 'put';

/** The ledger row, structurally — see packages/server/src/pcr-shadow-ledger.ts. */
export interface PcrShadowRow {
  id: string;
  session: string;
  underlying: string;
  asof: number;
  pcrVolume: number | null;
  pcrZ: number | null;
  pcrRegime: 'bullish' | 'neutral' | 'bearish' | null;
  contrarian: 'bullish' | 'bearish' | null;
  trio: {
    side: 'call' | 'put' | 'none';
    trioFired: boolean;
  } | null;
}

/** One daily OHLC bar for an underlying. The outcome + ATR both come from these. */
export interface DailyBar {
  underlying: string;
  /** ET session key, YYYY-MM-DD. Must match the ledger's `session`. */
  session: string;
  high: number;
  low: number;
  close: number;
}

/**
 * Wilder ATR over daily bars, indexed by session, using ONLY bars STRICTLY AT OR
 * BEFORE that session. The ATR at the capture session is a denominator, not an
 * outcome — if it could see the forward window it would leak the answer into the
 * normalizer and manufacture edge out of nothing.
 *
 * Returns null for a session until `period` true ranges exist behind it.
 */
export function atrBySession(
  bars: readonly DailyBar[],
  period = 14,
): Map<string, number | null> {
  const sorted = [...bars].sort((a, b) => a.session.localeCompare(b.session));
  const out = new Map<string, number | null>();
  const trs: number[] = [];
  let atr: number | null = null;

  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    const prevClose = i > 0 ? sorted[i - 1].close : null;
    const tr =
      prevClose === null
        ? b.high - b.low
        : Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    trs.push(tr);

    if (trs.length < period) {
      out.set(b.session, null);
      continue;
    }
    if (atr === null) {
      atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
    } else {
      atr = (atr * (period - 1) + tr) / period;
    }
    out.set(b.session, atr > 0 ? atr : null);
  }
  return out;
}

/** A ledger row that successfully carries an outcome. */
export interface JoinedRow {
  session: string;
  underlying: string;
  /** The trio's directional side (the tradable direction). */
  side: Side;
  trioFired: boolean;
  pcrRegime: 'bullish' | 'neutral' | 'bearish' | null;
  contrarian: 'bullish' | 'bearish' | null;
  pcrZ: number | null;
  /** Signed forward move over H sessions, normalized by capture-session ATR. */
  rMultiple: number;
  /**
   * The underlying's own TRAILING H-session fractional return, ending at capture.
   * Carries no forward information. It exists only to build the placebo — see
   * `placeboSidesBySession` — and it is never an input to a cohort.
   */
  trailingReturn: number;
}

/** Why rows fell out of the join. Silent drops are how a harness lies. */
export interface JoinDiagnostics {
  ledgerRows: number;
  joined: number;
  droppedNoTrioSide: number;
  droppedNoBars: number;
  droppedNoForwardBar: number;
  droppedNoAtr: number;
  droppedNoTrailingBar: number;
  droppedUnusablePcr: number;
}

export interface JoinResult {
  rows: JoinedRow[];
  diagnostics: JoinDiagnostics;
}

/**
 * Join the underlying's forward close-to-close return onto each ledger row, in R.
 *
 * H is measured in the UNDERLYING'S OWN sessions (its sorted bar list), not in
 * calendar days — a holiday must not silently shorten the horizon.
 *
 * A row that cannot be joined is DROPPED AND COUNTED. It is never imputed, and
 * never silently skipped: an unexplained denominator is indistinguishable from a
 * favourable one.
 */
export function joinForwardReturns(
  ledger: readonly PcrShadowRow[],
  bars: readonly DailyBar[],
  horizon: number,
): JoinResult {
  const byName = new Map<string, DailyBar[]>();
  for (const b of bars) {
    const list = byName.get(b.underlying) ?? [];
    list.push(b);
    byName.set(b.underlying, list);
  }
  const atrByName = new Map<string, Map<string, number | null>>();
  const idxByName = new Map<string, Map<string, number>>();
  for (const [name, list] of byName) {
    list.sort((a, b) => a.session.localeCompare(b.session));
    atrByName.set(name, atrBySession(list));
    const idx = new Map<string, number>();
    list.forEach((b, i) => idx.set(b.session, i));
    idxByName.set(name, idx);
  }

  const diagnostics: JoinDiagnostics = {
    ledgerRows: ledger.length,
    joined: 0,
    droppedNoTrioSide: 0,
    droppedNoBars: 0,
    droppedNoForwardBar: 0,
    droppedNoAtr: 0,
    droppedNoTrailingBar: 0,
    droppedUnusablePcr: 0,
  };
  const rows: JoinedRow[] = [];

  for (const r of ledger) {
    // The whole bar is written about the incremental value of PCR ON a trio
    // signal. A row with no directional side has no outcome to attribute.
    const side = r.trio?.side;
    if (side !== 'call' && side !== 'put') {
      diagnostics.droppedNoTrioSide++;
      continue;
    }
    if (typeof r.pcrVolume !== 'number') {
      diagnostics.droppedUnusablePcr++;
      continue;
    }
    const list = byName.get(r.underlying);
    const idx = idxByName.get(r.underlying)?.get(r.session);
    if (!list || idx === undefined) {
      diagnostics.droppedNoBars++;
      continue;
    }
    const fwd = list[idx + horizon];
    if (!fwd) {
      diagnostics.droppedNoForwardBar++;
      continue;
    }
    const atr = atrByName.get(r.underlying)?.get(r.session) ?? null;
    if (atr === null || !(atr > 0)) {
      diagnostics.droppedNoAtr++;
      continue;
    }
    // The placebo needs a trailing window of the SAME length as the forward one.
    const back = list[idx - horizon];
    if (!back || !(back.close > 0)) {
      diagnostics.droppedNoTrailingBar++;
      continue;
    }

    const move = fwd.close - list[idx].close;
    const signed = side === 'call' ? move : -move;
    rows.push({
      session: r.session,
      underlying: r.underlying,
      side,
      trioFired: r.trio?.trioFired === true,
      pcrRegime: r.pcrRegime,
      contrarian: r.contrarian,
      pcrZ: r.pcrZ,
      rMultiple: signed / atr,
      trailingReturn: (list[idx].close - back.close) / back.close,
    });
    diagnostics.joined++;
  }

  return { rows, diagnostics };
}

/**
 * The side the PCR read calls, for one (carrier, interpretation) cell.
 * Returns null when the read is silent — which is NOT the same as disagreeing.
 */
export function pcrSideFor(
  row: Pick<JoinedRow, 'pcrRegime' | 'contrarian' | 'pcrZ'>,
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  zThreshold = PCR_Z_SIDE_THRESHOLD,
): Side | null {
  if (carrier === 'raw') {
    if (interpretation === 'confirming') {
      // Face value: low PCR (call-heavy) = bullish = call.
      if (row.pcrRegime === 'bullish') return 'call';
      if (row.pcrRegime === 'bearish') return 'put';
      return null; // neutral bucket is silent
    }
    // Contrarian is only populated at a regime extreme, and already inverted.
    if (row.contrarian === 'bullish') return 'call';
    if (row.contrarian === 'bearish') return 'put';
    return null;
  }

  // z-delta carrier — mature-z rows only (the ledger nulls pcrZ below n=10).
  const z = row.pcrZ;
  if (typeof z !== 'number' || Math.abs(z) < zThreshold) return null;
  // z > 0 = put flow surging vs its own trailing base = face-value bearish.
  const faceValue: Side = z > 0 ? 'put' : 'call';
  if (interpretation === 'confirming') return faceValue;
  return faceValue === 'put' ? 'call' : 'put';
}

export interface Cohorts {
  /** The incumbent baseline: every fired-trio row, PCR ignored. */
  trioAlone: JoinedRow[];
  /** Fired trio AND the PCR read confirms the trio's side. */
  agreeing: JoinedRow[];
  /** Fired trio AND the PCR read opposes it. */
  disagreeing: JoinedRow[];
  /** Fired trio, PCR read silent — in NEITHER overlay cohort. Reported, not hidden. */
  silent: JoinedRow[];
}

export function cohortize(
  rows: readonly JoinedRow[],
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  zThreshold = PCR_Z_SIDE_THRESHOLD,
): Cohorts {
  const trioAlone = rows.filter((r) => r.trioFired);
  const agreeing: JoinedRow[] = [];
  const disagreeing: JoinedRow[] = [];
  const silent: JoinedRow[] = [];
  for (const r of trioAlone) {
    const s = pcrSideFor(r, carrier, interpretation, zThreshold);
    if (s === null) silent.push(r);
    else if (s === r.side) agreeing.push(r);
    else disagreeing.push(r);
  }
  return { trioAlone, agreeing, disagreeing, silent };
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Deterministic PRNG. A pre-registered result must reproduce from the seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Ci {
  lo: number;
  hi: number;
  /** The point estimate on the observed sample (not a bootstrap mean). */
  point: number;
  /** Resamples that produced a defined statistic. */
  effective: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * BLOCK BOOTSTRAP CLUSTERED BY ET SESSION — the binding inference.
 *
 * The sample is ~25 watchlist names x N sessions. Those names are heavily
 * cross-correlated: SPY/QQQ/IWM/DIA are four near-duplicate index exposures, and
 * the mega-cap tech block is one beta factor. On a market-wide fear day every
 * name's PCR lifts TOGETHER. So 200 rows is not 200 independent observations; it
 * is closer to ~8-20 independent SESSIONS.
 *
 * Resampling rows iid would shrink the interval by ~sqrt(25) ≈ 5x and let pure
 * noise clear a "CI lower bound > 0" test. That is exactly the failure mode that
 * made Supertrend look promotable (TRA-1334; it washed out at E[R] -0.047R over
 * 2098 signals). So: resample WHOLE SESSIONS with replacement, keeping every name
 * within a session together. Never resample rows iid.
 */
export function sessionClusteredBootstrap(
  rows: readonly JoinedRow[],
  stat: (sample: readonly JoinedRow[]) => number,
  opts: { iters?: number; confidence?: number; seed?: number; blockLength?: number } = {},
): Ci {
  const iters = opts.iters ?? PCR_BOOTSTRAP_ITERS;
  const confidence = opts.confidence ?? PCR_BOOTSTRAP_CONFIDENCE;
  const rng = mulberry32(opts.seed ?? PCR_BOOTSTRAP_SEED);

  const bySession = new Map<string, JoinedRow[]>();
  for (const r of rows) {
    const list = bySession.get(r.session) ?? [];
    list.push(r);
    bySession.set(r.session, list);
  }
  // Chronological — a MOVING-BLOCK bootstrap needs the sessions in order.
  const sessions = [...bySession.keys()].sort().map((s) => bySession.get(s)!);
  const point = stat(rows);
  if (sessions.length === 0) return { lo: Number.NaN, hi: Number.NaN, point, effective: 0 };

  // Blocks of CONSECUTIVE sessions, not single sessions.
  //
  // An H-session forward return at session i and one at session i+1 share H-1 of
  // their forward days. Sessions are therefore serially dependent by construction,
  // and resampling them INDEPENDENTLY destroys that dependence and understates the
  // variance — measured at 1.43x too narrow on synthetic data at H=5. A block
  // length >= H keeps overlapping windows together in the same draw.
  const L = Math.max(1, Math.min(opts.blockLength ?? PRIMARY_HORIZON, sessions.length));

  // FAIL CLOSED on a degenerate resample. When the block length covers (half or
  // more of) the sample, every circular draw is just a ROTATION of the whole
  // session set: the statistic is identical in every resample, the interval
  // collapses to zero width, and a zero-width interval sitting above zero reports
  // `lo > 0` — a CONFIDENT-LOOKING PASS backed by no variance at all. Caught on the
  // thin-ledger dry run, where H=10 over 6 sessions printed a CI of [0.918, 0.918].
  // Fewer than two whole blocks means the bootstrap cannot resample, so there is no
  // interval to report.
  if (sessions.length < 2 * L) {
    return { lo: Number.NaN, hi: Number.NaN, point, effective: 0 };
  }
  const nBlocks = Math.ceil(sessions.length / L);

  const stats: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample: JoinedRow[] = [];
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * sessions.length);
      for (let k = 0; k < L; k++) {
        // Circular so every session has equal probability of appearing.
        sample.push(...sessions[(start + k) % sessions.length]);
      }
    }
    const v = stat(sample);
    if (Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    lo: percentile(stats, alpha),
    hi: percentile(stats, 1 - alpha),
    point,
    effective: stats.length,
  };
}

/**
 * The NAIVE row-level bootstrap. Reported ONLY to show the size of the illusion —
 * it is never the binding number. If this interval is much tighter than the
 * clustered one, that gap IS the cross-name correlation you would have been
 * fooled by.
 */
export function naiveRowBootstrap(
  rows: readonly JoinedRow[],
  stat: (sample: readonly JoinedRow[]) => number,
  opts: { iters?: number; confidence?: number; seed?: number } = {},
): Ci {
  const iters = opts.iters ?? PCR_BOOTSTRAP_ITERS;
  const confidence = opts.confidence ?? PCR_BOOTSTRAP_CONFIDENCE;
  const rng = mulberry32(opts.seed ?? PCR_BOOTSTRAP_SEED);
  const point = stat(rows);
  if (rows.length === 0) return { lo: Number.NaN, hi: Number.NaN, point, effective: 0 };

  const stats: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample: JoinedRow[] = [];
    for (let k = 0; k < rows.length; k++) sample.push(rows[Math.floor(rng() * rows.length)]);
    const v = stat(sample);
    if (Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    lo: percentile(stats, alpha),
    hi: percentile(stats, 1 - alpha),
    point,
    effective: stats.length,
  };
}

/**
 * The RAW statistic exactly as pre-registered: incremental E[R] of the
 * PCR-agreeing cohort over the trio-alone baseline.
 *
 * ⚠️  THIS NUMBER IS BIASED UPWARD ON A SHORT SAMPLE AND MUST NOT BE PROMOTED ON.
 * It is computed and published because the pre-registration named it, and because
 * the gap between it and the bias-adjusted statistic IS the artifact — see
 * `placeboUpliftStat`. The binding number is `adjustedUpliftStat`.
 */
export function rawUpliftStat(
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  zThreshold = PCR_Z_SIDE_THRESHOLD,
): (sample: readonly JoinedRow[]) => number {
  return (sample) => {
    const c = cohortize(sample, carrier, interpretation, zThreshold);
    if (c.agreeing.length === 0 || c.trioAlone.length === 0) return Number.NaN;
    return mean(c.agreeing.map((r) => r.rMultiple)) - mean(c.trioAlone.map((r) => r.rMultiple));
  };
}

/**
 * THE PLACEBO — a signal with provably ZERO forward information that nonetheless
 * carries the SAME mechanical bias as the real PCR read.
 *
 * ## Why this exists (the finding that reshaped this harness)
 *
 * Over ONE finite price path, a backward-looking window and a forward-looking
 * window are MECHANICALLY NEGATIVELY CORRELATED: the realized sum over the sample
 * is fixed, so sessions whose trailing return was unusually low are necessarily
 * followed by above-average returns *within that sample*. Any contrarian signal
 * built from recent returns therefore shows FAKE forward edge in-sample.
 *
 * Measured on synthetic ledgers with EXACTLY ZERO true edge, the raw
 * pre-registered uplift comes out at:
 *
 *     30 sessions  -> +0.23 R      (the ~4-week window this study plans to read)
 *     60 sessions  -> +0.07 R
 *    120 sessions  -> +0.03 R
 *    960 sessions  -> ~0.00 R
 *
 * — tracking the within-path corr(backward, forward) as it decays to zero. At the
 * planned window the artifact is ~5x the +0.05R promotion bar. A session-clustered
 * CI does NOT save you: it puts an interval around a BIASED POINT ESTIMATE. Nor
 * does a permutation null, which would randomise away the very selection that
 * causes the bias and so come out centred on zero.
 *
 * The fix is to calibrate against a signal that has the bias and nothing else.
 * The placebo is a dumb SESSION-LEVEL "buy the dip" contrarian: on each session,
 * take the cross-sectional mean trailing H-session return across the names in the
 * sample; if it is negative the placebo calls `call`, else `put`. It is a pure
 * function of the past. It cannot know anything. Whatever uplift it "earns" is
 * exactly the artifact.
 *
 * Session-level, not name-level: the bias lives in the shared market factor, so a
 * per-name placebo under-absorbs it (measured: it leaves +0.055R on the table,
 * still above the bar, while the session-level placebo leaves +0.002R).
 */
export function placeboSidesBySession(sample: readonly JoinedRow[]): Map<string, Side> {
  const trailing = new Map<string, number[]>();
  for (const r of sample) {
    const list = trailing.get(r.session) ?? [];
    list.push(r.trailingReturn);
    trailing.set(r.session, list);
  }
  const out = new Map<string, Side>();
  for (const [session, list] of trailing) {
    out.set(session, mean(list) < 0 ? 'call' : 'put');
  }
  return out;
}

/** The uplift the PLACEBO earns — i.e. the size of the finite-sample artifact. */
export function placeboUpliftStat(): (sample: readonly JoinedRow[]) => number {
  return (sample) => {
    const trioAlone = sample.filter((r) => r.trioFired);
    if (trioAlone.length === 0) return Number.NaN;
    const sides = placeboSidesBySession(trioAlone);
    const agreeing = trioAlone.filter((r) => sides.get(r.session) === r.side);
    if (agreeing.length === 0) return Number.NaN;
    return mean(agreeing.map((r) => r.rMultiple)) - mean(trioAlone.map((r) => r.rMultiple));
  };
}

/**
 * THE BINDING STATISTIC — the PCR overlay's uplift NET of the placebo's.
 *
 * Reads as: "how much does the real PCR read beat a signal that knows nothing but
 * is wired into the same finite-sample trap?" On a zero-edge ledger this is ~0
 * (measured +0.0025R, SE 0.021 over 300 synthetic worlds at 30 sessions). On a
 * genuinely predictive ledger it retains the real signal (+1.38R of a +1.64R raw).
 *
 * Both cohorts and the placebo are recomputed INSIDE each resample, so the whole
 * contrast is bootstrapped jointly — they are drawn from the same sessions and are
 * not independent samples.
 */
export function adjustedUpliftStat(
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  zThreshold = PCR_Z_SIDE_THRESHOLD,
): (sample: readonly JoinedRow[]) => number {
  const raw = rawUpliftStat(carrier, interpretation, zThreshold);
  const placebo = placeboUpliftStat();
  return (sample) => {
    const r = raw(sample);
    const p = placebo(sample);
    if (!Number.isFinite(r) || !Number.isFinite(p)) return Number.NaN;
    return r - p;
  };
}

export interface SampleShape {
  rows: number;
  sessionCount: number;
  underlyingCount: number;
  maxNameSharePct: number;
  /** Rows carrying a MATURE z (trailing n >= 10) — bar point 4 is only readable here. */
  matureZRows: number;
}

export function sampleShape(rows: readonly JoinedRow[]): SampleShape {
  const perName = new Map<string, number>();
  for (const r of rows) perName.set(r.underlying, (perName.get(r.underlying) ?? 0) + 1);
  return {
    rows: rows.length,
    sessionCount: new Set(rows.map((r) => r.session)).size,
    underlyingCount: perName.size,
    maxNameSharePct:
      rows.length === 0 ? 0 : (Math.max(...perName.values(), 0) / rows.length) * 100,
    matureZRows: rows.filter((r) => typeof r.pcrZ === 'number').length,
  };
}

/** One (carrier x interpretation x horizon) cell of the pre-registered grid. */
export interface CellResult {
  horizon: number;
  carrier: PcrCarrier;
  interpretation: PcrInterpretation;
  n: { trioAlone: number; agreeing: number; disagreeing: number; silent: number };
  meanR: { trioAlone: number; agreeing: number; disagreeing: number };
  /** RAW uplift as pre-registered. BIASED on a short sample — published, not binding. */
  rawUpliftR: number;
  /** What a zero-information placebo earns on this same sample = the artifact. */
  placeboUpliftR: number;
  /** BINDING: raw uplift NET of the placebo's. This is the promotable number. */
  adjustedUpliftR: number;
  /** BINDING: session-clustered, moving-block 90% CI on the ADJUSTED uplift. */
  clustered: Ci;
  /** Reported only to expose the illusion. Never binding. */
  naive: Ci;
  /**
   * TRA-1830. THE BINDING PROMOTION BAR on this cell: `max(economic floor, CI half-width)`,
   * and which of the two is binding. Reported on EVERY cell — the number the `upliftBar` leg
   * is actually graded against is not 0.05R and must never look like it is.
   */
  bar: EffectiveBar;
  legs: {
    /** ADJUSTED uplift clears the EFFECTIVE bar — `max(+0.05R, the CI half-width)` (TRA-1830). */
    upliftBar: boolean;
    /** Session-clustered 90% CI lower bound on the ADJUSTED uplift > 0. */
    clusteredCiPositive: boolean;
    /** TRA-540 n<20 floor, measured in SESSIONS (independent units), not rows. */
    sessionFloor: boolean;
  };
  /** True only when every leg holds. Fails closed on a NaN / empty cohort. */
  pass: boolean;
  notes: string[];
}

export function evaluateCell(
  rows: readonly JoinedRow[],
  horizon: number,
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  opts: { zThreshold?: number; seed?: number; iters?: number } = {},
): CellResult {
  const z = opts.zThreshold ?? PCR_Z_SIDE_THRESHOLD;
  const c = cohortize(rows, carrier, interpretation, z);
  const adjusted = adjustedUpliftStat(carrier, interpretation, z);
  // Block length tracks the horizon — that is where the window overlap comes from.
  const boot = { seed: opts.seed, iters: opts.iters, blockLength: horizon };

  const clustered = sessionClusteredBootstrap(rows, adjusted, boot);
  const naive = naiveRowBootstrap(rows, adjusted, boot);
  const sessionCount = new Set(rows.map((r) => r.session)).size;

  const rawUpliftR = rawUpliftStat(carrier, interpretation, z)(rows);
  const placeboUpliftR = placeboUpliftStat()(rows);
  const adjustedUpliftR = adjusted(rows);

  const notes: string[] = [];
  if (c.agreeing.length === 0) notes.push('no PCR-agreeing rows — uplift undefined');
  if (sessionCount < MIN_INDEPENDENT_SESSIONS) {
    notes.push(
      `session floor: ${sessionCount} < ${MIN_INDEPENDENT_SESSIONS} independent sessions (TRA-540)`,
    );
  }
  if (Number.isFinite(placeboUpliftR) && Math.abs(placeboUpliftR) >= PCR_UPLIFT_BAR_R) {
    notes.push(
      `placebo earns ${placeboUpliftR.toFixed(3)}R on this sample — a zero-information signal ` +
        `clears the raw bar, so the RAW uplift is not readable here`,
    );
  }

  // TRA-1830 — THE BINDING BAR. `max(economic floor, the estimator's own resolution)`.
  const bar = effectiveBar(clustered);
  if (bar.binding === 'detectability') {
    notes.push(effectiveBarReason(bar, adjustedUpliftR));
  }

  const legs = {
    upliftBar: clearsEffectiveBar(adjustedUpliftR, bar),
    clusteredCiPositive: Number.isFinite(clustered.lo) && clustered.lo > 0,
    sessionFloor: sessionCount >= MIN_INDEPENDENT_SESSIONS,
  };

  return {
    horizon,
    carrier,
    interpretation,
    n: {
      trioAlone: c.trioAlone.length,
      agreeing: c.agreeing.length,
      disagreeing: c.disagreeing.length,
      silent: c.silent.length,
    },
    meanR: {
      trioAlone: mean(c.trioAlone.map((r) => r.rMultiple)),
      agreeing: mean(c.agreeing.map((r) => r.rMultiple)),
      disagreeing: mean(c.disagreeing.map((r) => r.rMultiple)),
    },
    rawUpliftR,
    placeboUpliftR,
    adjustedUpliftR,
    clustered,
    naive,
    bar,
    legs,
    pass: Object.values(legs).every(Boolean),
    notes,
  };
}

/** The DSR/PBO overfitting guards, wired to the REAL multiplicity of this study. */
export interface OverfittingGuards {
  /**
   * Number of pre-registered configurations searched. DSR must deflate by the
   * multiplicity we ACTUALLY looked at (carriers x interpretations x horizons),
   * not by 1 — reporting the single best cell as if it were the only one tried is
   * the definition of the bias DSR exists to remove.
   */
  trials: number;
  dsr: DeflatedSharpeResult | null;
  pbo: PboResult | null;
  /**
   * PBO is NOT EVALUABLE on a thin ledger (fewer columns than partitions).
   * `probabilityOfBacktestOverfitting` degrades to `{pbo: 0, pass: true}` in that
   * case — a FAIL-OPEN. We refuse to count that as a cleared guard: not-evaluable
   * is HELD, never PASS.
   */
  pboEvaluable: boolean;
  dsrEvaluable: boolean;
  notes: string[];
}

/**
 * Grade the DSR/PBO guards across the pre-registered grid.
 *
 * The per-session mean R of the winning cell's agreeing cohort is the return
 * series DSR reads; the trial matrix for PBO is one row per grid cell, one column
 * per session. Sessions — not rows — are the observation unit throughout, for the
 * same clustering reason the bootstrap exists.
 */
export function overfittingGuards(
  rows: readonly JoinedRow[],
  cells: readonly CellResult[],
  primary: CellResult,
  /** Joined rows per horizon — the trial set spans horizons, not just the primary. */
  rowsByHorizon: Record<number, readonly JoinedRow[]> = {},
  /**
   * Total configurations looked at across the WHOLE STUDY — the multiplicity penalty.
   *
   * Defaults to the study-wide `PCR_STUDY_TRIALS` (24), NOT to this read's own cell
   * count. TRA-1727 added a second estimand over the same grid, and the primary pays
   * for it: a study that takes two shots at the bar must deflate by both.
   */
  gridSize = PCR_STUDY_TRIALS,
): OverfittingGuards {
  const notes: string[] = [];
  const sessions = [...new Set(rows.map((r) => r.session))].sort();
  const trials = gridSize;

  // Per-session mean R for one cohort, NET OF THE PLACEBO's — the observation
  // series. It has to be the bias-adjusted quantity for the same reason the CI is:
  // a Sharpe measured on the raw series inherits the finite-sample artifact.
  const seriesOf = (
    src: readonly JoinedRow[],
    carrier: PcrCarrier,
    interpretation: PcrInterpretation,
  ): number[] => {
    const bySession = new Map<string, JoinedRow[]>();
    for (const r of src) {
      const list = bySession.get(r.session) ?? [];
      list.push(r);
      bySession.set(r.session, list);
    }
    const placeboSides = placeboSidesBySession(src.filter((r) => r.trioFired));
    return [...bySession.keys()].sort().map((s) => {
      const day = bySession.get(s) ?? [];
      const c = cohortize(day, carrier, interpretation);
      const pcr = mean(c.agreeing.map((r) => r.rMultiple));
      const placebo = mean(
        c.trioAlone.filter((r) => placeboSides.get(r.session) === r.side).map((r) => r.rMultiple),
      );
      return (Number.isFinite(pcr) ? pcr : 0) - (Number.isFinite(placebo) ? placebo : 0);
    });
  };
  const seriesFor = (cell: CellResult): number[] =>
    seriesOf(rows, cell.carrier, cell.interpretation);

  const sharpe = (xs: readonly number[]): number => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    return sd > 0 ? m / sd : 0;
  };

  const primarySeries = seriesFor(primary);
  const dsrEvaluable = primarySeries.length >= MIN_INDEPENDENT_SESSIONS;
  let dsr: DeflatedSharpeResult | null = null;
  if (dsrEvaluable) {
    // The DSR trial set must be the DISTINCT configurations searched — one per
    // (carrier x horizon), all read at the pre-registered PRIMARY interpretation.
    //
    // It must NOT include both the `confirming` and `contrarian` cells. Those are
    // the SAME read with the sign flipped, so a mirrored pair enters Var[SR] as a
    // spread of +SR against -SR. The consequence is perverse and was caught here on
    // the positive control: the STRONGER the genuine edge, the wider the mirrored
    // trial spread, the higher SR* climbs — and a real +1.6R edge could never clear
    // its own deflation benchmark at ANY sample size. A guard that no true signal
    // can pass is not conservative, it is broken; it refuses everything and so
    // certifies nothing.
    //
    // `trialCount` still carries the FULL grid multiplicity (every cell we looked
    // at), so the multiple-testing penalty is not softened — only the dispersion
    // estimate is de-mirrored.
    const trialSharpes: number[] = [];
    for (const carrier of ['raw', 'zDelta'] as const) {
      for (const h of HORIZONS) {
        const src = rowsByHorizon[h] ?? (h === primary.horizon ? rows : []);
        if (src.length > 0) trialSharpes.push(sharpe(seriesOf(src, carrier, primary.interpretation)));
      }
    }
    dsr = deflatedSharpeRatio({
      returns: primarySeries,
      trialSharpes: trialSharpes.length >= 2 ? trialSharpes : [sharpe(primarySeries), 0],
      trialCount: trials,
    });
  } else {
    notes.push(
      `DSR not evaluable: ${primarySeries.length} sessions < ${MIN_INDEPENDENT_SESSIONS} floor — HELD, not passed`,
    );
  }

  const matrix = cells.map(seriesFor);
  // CSCV needs at least 2 trials and >= `partitions` columns; below that the
  // implementation returns pass:true vacuously. Grade evaluability OURSELVES.
  const pboPartitions = 4;
  const pboEvaluable = trials >= 2 && sessions.length >= pboPartitions;
  let pbo: PboResult | null = null;
  if (pboEvaluable) {
    pbo = probabilityOfBacktestOverfitting({ matrix, partitions: pboPartitions, threshold: 0.25 });
  } else {
    notes.push(
      `PBO not evaluable: ${trials} trials x ${sessions.length} sessions — HELD, not passed (the underlying CSCV would fail OPEN here)`,
    );
  }

  return { trials, dsr, pbo, pboEvaluable, dsrEvaluable, notes };
}

export interface PcrExpectancyReport {
  /**
   * TRA-1756 R3. Stamped on every report. The verdict must never travel without it —
   * above all a HELD, which is the outcome this study will almost certainly produce and
   * the one that reads, wrongly, as "PCR does not work".
   */
  power: string;
  /**
   * TRA-1830. Stamped on every report, alongside `power`, for the same reason: the bar the
   * verdict was ACTUALLY graded against is `primary.bar.effectiveR`, not the 0.05R constant,
   * and a reader who does not know that will misread a HELD as a near miss.
   */
  detectability: string;
  diagnostics: Record<number, JoinDiagnostics>;
  shape: SampleShape;
  cells: CellResult[];
  primary: CellResult | null;
  guards: OverfittingGuards | null;
  /**
   * The pre-registered verdict, and all THREE values are reachable (TRA-1726).
   *
   * - PASS — EVERY leg: the primary cell's uplift bar, its session-clustered CI, the
   *   session floor, AND both overfitting guards EVALUABLE and passing.
   * - FAIL — a DECISIVE NO-GO, and nothing weaker: the primary cell's clustered CI
   *   upper bound sits BELOW the +0.05R bar, so the optimistic end of the interval
   *   cannot clear it. Decisive at any N. This is the verdict that retires TRA-1609.
   * - HELD — the interval straddles the bar, or is not evaluable. The sample cannot
   *   answer the question. NOT a NO-GO. Never a pass.
   */
  verdict: 'PASS' | 'FAIL' | 'HELD';
  reasons: string[];
}

/**
 * Run the whole pre-registered study. The verdict is read off the PRIMARY cell
 * (H=5, raw carrier, contrarian interpretation is NOT assumed — the primary is
 * whichever cell the caller pre-registers; we default to H=5 and report all).
 *
 * Every horizon and every carrier x interpretation cell is computed and returned
 * whether or not it clears. Publishing all of them is mandatory: a result that is
 * only visible at one horizon is a horizon-cherry-pick, and hiding the other
 * eleven cells is how that gets laundered into a promotion.
 */
export function runPcrExpectancy(
  ledger: readonly PcrShadowRow[],
  bars: readonly DailyBar[],
  opts: {
    primaryCarrier?: PcrCarrier;
    primaryInterpretation?: PcrInterpretation;
    zThreshold?: number;
    seed?: number;
    iters?: number;
  } = {},
): PcrExpectancyReport {
  const primaryCarrier = opts.primaryCarrier ?? 'raw';
  const primaryInterpretation = opts.primaryInterpretation ?? 'contrarian';

  const diagnostics: Record<number, JoinDiagnostics> = {};
  const cells: CellResult[] = [];
  const rowsByHorizon: Record<number, JoinedRow[]> = {};
  let primaryRows: JoinedRow[] = [];

  for (const h of HORIZONS) {
    const { rows, diagnostics: d } = joinForwardReturns(ledger, bars, h);
    diagnostics[h] = d;
    rowsByHorizon[h] = rows;
    if (h === PRIMARY_HORIZON) primaryRows = rows;
    for (const carrier of ['raw', 'zDelta'] as const) {
      for (const interpretation of ['confirming', 'contrarian'] as const) {
        cells.push(evaluateCell(rows, h, carrier, interpretation, opts));
      }
    }
  }

  const shape = sampleShape(primaryRows);
  const primary =
    cells.find(
      (c) =>
        c.horizon === PRIMARY_HORIZON &&
        c.carrier === primaryCarrier &&
        c.interpretation === primaryInterpretation,
    ) ?? null;

  const reasons: string[] = [];
  if (!primary) {
    return {
      power: PRIMARY_POWER_CONSTRAINT,
      detectability: DETECTABILITY_FLOOR_CONSTRAINT,
      diagnostics,
      shape,
      cells,
      primary: null,
      guards: null,
      verdict: 'HELD',
      reasons: ['primary cell not computed'],
    };
  }

  const primaryHorizonCells = cells.filter((c) => c.horizon === PRIMARY_HORIZON);
  const guards = overfittingGuards(
    primaryRows,
    primaryHorizonCells,
    primary,
    rowsByHorizon,
    // FULL STUDY multiplicity — every cell we looked at across BOTH estimands (24),
    // not just this read's own 12. TRA-1727's second look is not free.
    PCR_STUDY_TRIALS,
  );

  reasons.push(...primary.notes, ...guards.notes);

  const guardsPass =
    guards.dsrEvaluable &&
    guards.pboEvaluable &&
    guards.dsr?.pass === true &&
    guards.pbo?.pass === true;

  // THE DECISIVE-NO-GO RULE (TRA-1726).
  //
  // The verdict is three-valued, and all three values must be REACHABLE. They were
  // not. The previous branch made HELD unreachable above the 20-session floor: once
  // DSR, PBO and the session floor were merely EVALUABLE, every non-PASS fell
  // through to FAIL. So a genuinely good overlay, read on a thin-but-legal sample,
  // was CONDEMNED — 7 of 8 seeds at 20/30/45 sessions on the `edge:'real'`
  // generator came back FAIL. That is a type-II error laundered as a decision, and
  // FAIL is the verdict that retires the overlay for good.
  //
  // A FAIL must now rest on POSITIVE evidence AGAINST the overlay, not on the mere
  // ABSENCE of evidence for it. The primary cell's session-clustered CI must lie
  // ENTIRELY BELOW the promotion bar — even the optimistic end of the interval
  // cannot clear +0.05R. That is decisive at ANY N, a thin sample included, which
  // is what buys the early exit: a junk overlay still earns a decisive NO-GO the
  // moment its interval tightens under the bar. We are not committing to a blind
  // wait for 90 sessions.
  //
  // Two properties this rule preserves, deliberately:
  //
  //  1. STRICTLY MONOTONE TOWARD ABSTENTION. It can only ever convert a former FAIL
  //     into HELD. It can NEVER manufacture a PASS: PASS is evaluated FIRST and its
  //     legs are untouched. That is what makes it safe to land without re-opening
  //     the pre-registration.
  //
  //  2. IGNORANCE IS NEVER CONDEMNATION. A non-evaluable / NaN interval is HELD —
  //     never FAIL, never PASS. "Don't know" has its own verdict now, and the tests
  //     assert the EXACT verdict: a `not.toBe('PASS')` assertion cannot tell a
  //     rejection from an abstention, and that is precisely what hid this bug.
  // TRA-1830 — THE EFFECTIVE BAR TRAVELS WITH EVERY VERDICT, PASS / FAIL / HELD ALIKE.
  //
  // It goes in FIRST, before the verdict's own reasoning, because it is the number the
  // verdict was graded against. `PCR_UPLIFT_BAR_R` is only ONE of its two terms and on any
  // realistic sample it is not the binding one. A reader who takes "0.05R" off this report is
  // reading a number the gate did not use.
  reasons.push(effectiveBarReason(primary.bar, primary.adjustedUpliftR));

  // *** THE FAIL BRANCH KEEPS THE ECONOMIC BAR. THIS IS DELIBERATE. ***
  //
  // See DETECTABILITY_FLOOR_CONSTRAINT: `ciUpper < effectiveBar` reduces to `point < 0`, which
  // would condemn the overlay — IRREVERSIBLY — on roughly a coin flip in a null world. The
  // detectability floor makes PASS harder; it must never make FAIL easier. Ignorance is not
  // condemnation (TRA-1726), and a wide interval is ignorance.
  const ciUpper = primary.clustered.hi;
  const decisiveNoGo = Number.isFinite(ciUpper) && ciUpper < PCR_UPLIFT_BAR_R;

  let verdict: 'PASS' | 'FAIL' | 'HELD';
  if (primary.pass && guardsPass) {
    verdict = 'PASS';
  } else if (decisiveNoGo) {
    verdict = 'FAIL';
    reasons.push(
      `DECISIVE NO-GO: session-clustered 90% CI upper bound ${ciUpper.toFixed(4)}R < ` +
        `${PCR_UPLIFT_BAR_R}R bar — even the optimistic end of the interval cannot clear it ` +
        `(bias-adjusted uplift ${primary.adjustedUpliftR.toFixed(4)}R; raw ` +
        `${primary.rawUpliftR.toFixed(4)}R, of which ${primary.placeboUpliftR.toFixed(4)}R is ` +
        `earned by a zero-information placebo)`,
    );
  } else {
    verdict = 'HELD';
    if (!Number.isFinite(ciUpper)) {
      reasons.push(
        'HELD: the session-clustered CI is not evaluable on this sample — that is an ' +
          'abstention, not a NO-GO',
      );
    } else {
      reasons.push(
        `HELD: session-clustered 90% CI [${primary.clustered.lo.toFixed(4)}, ` +
          `${ciUpper.toFixed(4)}]R STRADDLES the ${PCR_UPLIFT_BAR_R}R bar — the sample cannot ` +
          `answer the question either way. Not a NO-GO; accrue more sessions.`,
      );
    }
    // Publish WHICH legs are short, so a HELD is diagnosable and not just a shrug.
    if (!primary.legs.sessionFloor) {
      reasons.push(`HELD leg: below the ${MIN_INDEPENDENT_SESSIONS}-session floor`);
    }
    if (!primary.legs.upliftBar) {
      reasons.push(
        `HELD leg: bias-adjusted uplift ${primary.adjustedUpliftR.toFixed(4)}R < the EFFECTIVE ` +
          `bar of ${primary.bar.effectiveR.toFixed(4)}R ` +
          `(binding term: ${primary.bar.binding}; economic floor ${PCR_UPLIFT_BAR_R}R, CI ` +
          `half-width ${primary.bar.halfWidthR.toFixed(4)}R)`,
      );
    }
    if (!primary.legs.clusteredCiPositive) {
      reasons.push(`HELD leg: session-clustered 90% CI lower bound ${primary.clustered.lo.toFixed(4)} <= 0`);
    }
    if (guards.dsr && !guards.dsr.pass) reasons.push('HELD leg: DSR guard failed');
    if (guards.pbo && !guards.pbo.pass) reasons.push('HELD leg: PBO guard failed');
    // TRA-1756 R3. A HELD is the modal outcome of this read, and on its own it reads as
    // "PCR does not work — retire TRA-1609". It does not say that, and it CANNOT: the MDE
    // is ~30x the bar. The caveat ships INSIDE the verdict's reasons, not only in a field.
    reasons.push(`HELD — READ THIS BEFORE ACTING ON IT. ${PRIMARY_POWER_CONSTRAINT}`);
  }

  return {
    power: PRIMARY_POWER_CONSTRAINT,
    detectability: DETECTABILITY_FLOOR_CONSTRAINT,
    diagnostics,
    shape,
    cells,
    primary,
    guards,
    verdict,
    reasons,
  };
}
