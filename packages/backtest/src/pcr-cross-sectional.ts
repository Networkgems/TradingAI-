import {
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
  type DeflatedSharpeResult,
  type PboResult,
} from './overfitting-stats.js';
import {
  HORIZONS,
  PCR_BOOTSTRAP_CONFIDENCE,
  PCR_BOOTSTRAP_ITERS,
  PCR_BOOTSTRAP_SEED,
  PCR_STUDY_TRIALS,
  PCR_UPLIFT_BAR_R,
  PCR_Z_SIDE_THRESHOLD,
  PRIMARY_HORIZON,
  joinForwardReturns,
  mean,
  mulberry32,
  pcrSideFor,
  percentile,
  sampleShape,
  type Ci,
  type DailyBar,
  type JoinDiagnostics,
  type JoinedRow,
  type PcrCarrier,
  type PcrInterpretation,
  type PcrShadowRow,
  type SampleShape,
  type Side,
} from './pcr-expectancy.js';

// TRA-1727 (parent TRA-1664, grandparent TRA-1609) — the SECONDARY pre-registered
// estimand for the PCR study: a SESSION-DEMEANED CROSS-SECTIONAL CONTRAST.
//
// Pre-registered 2026-07-13, BEFORE any real ledger row has been read. That is the
// only moment at which adding an estimand is legitimate. The bar, the floor, the
// horizon grid and the verdict rule below are CONSTANTS for the same reason they
// are in `pcr-expectancy.ts`: if you are editing one of them after looking at a
// real result, you are p-hacking.
//
// Offline analysis only. Nothing here is imported by the server, the engine, or
// `doTick`. No live path, no order surface, no broker call.
//
// ===========================================================================
// WHAT THIS MEASURES, AND THE ONE USE IT CAN EVER PROMOTE
// ===========================================================================
//
// The PRIMARY (time-series) estimand asks: "does the PCR overlay raise the trio's
// expected R?" That is a MARKET-TIMING question, and it cannot be answered until
// ~90 sessions, because the finite-sample artifact documented in TRA-1664 destroys
// the short-window read and the placebo correction that removes the bias also costs
// power.
//
// This estimand asks a strictly narrower question: "GIVEN that the trio fired on
// several names today, does PCR RANK them — do the names PCR agrees with beat the
// names it is silent on or disagrees with, WITHIN THE SAME SESSION?"
//
//   *** A PASS HERE PROMOTES A PER-NAME SELECTION USE AND NOTHING ELSE. ***
//
// It can NEVER promote a market-timing use, and this is not a matter of caution —
// it is arithmetic. The statistic is a contrast between two groups of names drawn
// from the SAME session, so the session's own direction cancels out of it exactly
// (see THE DEMEANING IS A NO-OP, below). The estimand is BLIND to whether today was
// a good day to trade at all; it can only say which names to prefer once you have
// already decided to trade. Reading a PASS here as "PCR times the market" is reading
// a number that provably contains no information about the market's direction.
// `SELECTION_ONLY_CONSTRAINT` is stamped into every report so this cannot be quietly
// forgotten in November.
//
// ===========================================================================
// WHY IT SHOULD BE READABLE SOONER — AND THE TWO CLAIMS I HAD TO CORRECT
// ===========================================================================
//
// The pre-registration's stated mechanism was: "subtracting the session mean removes
// the market factor, which is precisely the thing that manufactures the fake edge."
// The CONCLUSION is right and the secondary is sound. But two of the mechanical
// claims underneath it are not, and both were load-bearing for how the code gets
// written, so they are corrected here rather than silently coded around.
//
// --- (1) THE DEMEANING IS A NO-OP. The immunity comes from the CONTRAST. ---
//
// The pre-registered statistic is a difference of two group means taken WITHIN one
// session. Write c for the session mean of rMultiple. Then:
//
//     mean(rTilde | A) - mean(rTilde | B)
//   = (mean(r | A) - c) - (mean(r | B) - c)
//   = mean(r | A) - mean(r | B)
//
// The c cancels EXACTLY. Demeaning changes nothing — the un-demeaned contrast and
// the demeaned contrast are the SAME NUMBER, to the last bit (pinned as a test).
//
// This is good news, not bad: it means the artifact-immunity does not RELY on a
// subtraction that could be mis-specified. It is STRUCTURAL. Both cohorts eat the
// same market factor on the same day, so the market factor — the entire source of
// the finite-sample bias — is differenced away by the shape of the estimand itself.
// The demeaning step is retained because it is what was pre-registered and because
// it makes the per-session quantity mean-zero (which the DSR/PBO series want), but
// no claim in this file leans on it.
//
// The reason the pre-registration expected the placebo to come out at ~0 "by
// construction" is therefore CORRECT, but for a reason one step removed from the one
// it gives.
//
// --- (2) THE PRIMARY'S PLACEBO IS DEGENERATE HERE. It needed a new one. ---
//
// The primary's placebo (`placeboSidesBySession`) calls ONE side for the WHOLE
// session — deliberately, because the primary's bias lives in the shared market
// factor and a per-name placebo under-absorbs it (TRA-1664 measured the shortfall:
// +0.055R left on the table, still over the bar).
//
// In the CROSS-SECTION that same construction is not merely weaker, it is VACUOUS. A
// side that is CONSTANT across the names in a session has ZERO cross-sectional
// variation, so it cannot rank names — the thing this estimand exists to measure. It
// sorts every name in the session into ONE cohort and leaves the other EMPTY, and the
// contrast is undefined. Run it on the synthetic ledger and it returns NaN on 100% of
// sessions (pinned as a test).
//
//   *** AND NaN IS EXACTLY WHAT A CLEAN PLACEBO IS SUPPOSED TO LOOK LIKE. ***
//
// "The placebo came out at ~0" and "the placebo could not be computed at all" render
// IDENTICALLY in a report that prints `n/a` or coerces to zero — and the
// pre-registration says, in terms, that a ~0 placebo is what VALIDATES the secondary.
// So the degenerate placebo would have SILENTLY CONFIRMED the thing it was placed
// there to falsify. It is a blind check that reports CLEAN. That is why
// `sessionLevelPlaceboCaller` is kept in this file and pinned by a test asserting it
// is degenerate: the trap is now nailed down where the next reader trips over it,
// instead of lurking as a `null` in a table.
//
// The correct placebo lives in the SAME SPACE as the statistic. It must be a per-NAME
// side call that (a) is a pure function of the past, and (b) actually VARIES across
// the names in a session. `crossSectionalPlaceboCaller` is the cross-sectional
// analogue of the primary's "buy the dip": BUY THE RELATIVE LAGGARD. Within a session,
// demean each name's trailing H-session return by the session's mean trailing return;
// if a name lagged its peers, call `call`, else `put`. It knows nothing about the
// future. Whatever IT earns in the demeaned cross-section IS the cross-sectional
// artifact, and it is subtracted — exactly as the primary does.
//
// ===========================================================================

/** Minimum names in a session for a cross-sectional contrast to mean anything. */
export const XS_MIN_NAMES_PER_SESSION = 5;

/**
 * The pre-registered session floor for the SECONDARY. Below this, HELD.
 *
 * Higher than the primary's 20 (TRA-540's floor) because the secondary buys its
 * speed by spending the cross-section, and 30 sessions is the number the
 * pre-registration named. It is not a number to tune.
 */
export const XS_MIN_SESSIONS = 30;

/**
 * Re-exported for the CLI and the tests. Defined in `pcr-expectancy.ts` so the import
 * stays acyclic — see the doc comment there for why the primary's penalty goes UP when
 * this estimand is added.
 */
export { PCR_STUDY_TRIALS };

/**
 * Stamped verbatim into every secondary report, and printed by the CLI.
 *
 * The pre-registration requires the constraint to travel WITH the number, because the
 * number will be read months from now by someone who did not read this file.
 */
export const SELECTION_ONLY_CONSTRAINT =
  'SELECTION-ONLY. A PASS on the secondary (cross-sectional) estimand promotes exactly ' +
  'one use: given the trio has ALREADY fired on several names in a session, prefer the ' +
  'names the PCR read agrees with. It can NEVER promote a market-timing use. The ' +
  'statistic is a contrast between names WITHIN one session, so the session\'s own ' +
  'direction cancels out of it exactly — the estimand is blind to timing BY ' +
  'CONSTRUCTION and contains no information about whether to trade at all. Only the ' +
  'PRIMARY time-series read at N >= 90 sessions can promote a full overlay.';

/**
 * Calls a side for EACH name in ONE session. Returns one entry per input row,
 * positionally; `null` means the read is SILENT on that name (not that it disagrees).
 *
 * Session-scoped rather than row-scoped because a cross-sectional signal is allowed
 * to be relative to its peers — which is the whole point of the placebo below.
 */
export type SessionSideCaller = (sessionRows: readonly JoinedRow[]) => Array<Side | null>;

/**
 * The real PCR read. Delegates to `pcrSideFor` — the SAME carriers, the SAME
 * interpretations, the SAME z threshold as the primary, as the pre-registration
 * requires. The secondary must not be a different signal, only a different contrast.
 */
export function pcrSideCaller(
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  zThreshold = PCR_Z_SIDE_THRESHOLD,
): SessionSideCaller {
  return (rows) => rows.map((r) => pcrSideFor(r, carrier, interpretation, zThreshold));
}

/**
 * THE CROSS-SECTIONAL PLACEBO — "buy the relative laggard".
 *
 * A pure function of TRAILING price, with genuine cross-sectional variation. Within a
 * session, demean each name's trailing H-session return by the session mean; a name
 * that lagged its peers gets `call`, one that led them gets `put`.
 *
 * It cannot know anything about the forward window. So whatever uplift it earns in the
 * demeaned cross-section IS the residual cross-sectional artifact — the idiosyncratic
 * echo of the same finite-path mechanic that fakes +0.23R in the primary — and the
 * binding statistic nets it out.
 *
 * Contrast with `sessionLevelPlaceboCaller`, which is the primary's placebo and is
 * DEGENERATE in this space.
 */
export function crossSectionalPlaceboCaller(): SessionSideCaller {
  return (rows) => {
    const m = mean(rows.map((r) => r.trailingReturn));
    if (!Number.isFinite(m)) return rows.map(() => null);
    return rows.map((r) => (r.trailingReturn - m < 0 ? 'call' : 'put'));
  };
}

/**
 * THE PRIMARY'S PLACEBO, ported verbatim — and KEPT ONLY TO PROVE IT IS DEGENERATE.
 *
 * One side for the whole session => zero cross-sectional variation => every name lands
 * in the SAME cohort => the other cohort is EMPTY => the contrast is UNDEFINED on every
 * session. It is not a weak placebo here; it is not a placebo at all.
 *
 * DO NOT WIRE THIS INTO THE VERDICT. It is exported so a test can pin the degeneracy,
 * because a placebo that cannot be computed and a placebo that comes out at zero look
 * the same in a report — and the pre-registration treats a ~0 placebo as the check that
 * VALIDATES this whole estimand. A blind check that renders as a clean one is worse
 * than no check.
 */
export function sessionLevelPlaceboCaller(): SessionSideCaller {
  return (rows) => {
    const m = mean(rows.map((r) => r.trailingReturn));
    const side: Side = m < 0 ? 'call' : 'put';
    return rows.map(() => side);
  };
}

/** One session's contrast — the unit of observation for the secondary. */
export interface SessionContrast {
  session: string;
  /** mean(rTilde | agrees) - mean(rTilde | silent or disagrees), demeaned within session. */
  contrast: number;
  names: number;
  nAgree: number;
  nOther: number;
}

/** Why sessions fell out of the cross-section. A silent drop is how a harness lies. */
export interface XsDiagnostics {
  sessionsSeen: number;
  sessionsUsed: number;
  /** Fewer than XS_MIN_NAMES_PER_SESSION fired-trio names — no cross-section to read. */
  droppedTooFewNames: number;
  /**
   * The side caller sorted every name into ONE cohort, so the contrast has nothing to
   * contrast against. For a DEGENERATE caller (one constant side per session) this is
   * EVERY session — which is exactly how `sessionLevelPlaceboCaller` is caught.
   */
  droppedEmptyCohort: number;
}

/**
 * The pre-registered estimand, per session.
 *
 * 1. fired-trio rows in the session; require >= `minNames`, else DROP AND COUNT.
 * 2. demean rMultiple within the session.
 * 3. the caller names a side per name.
 * 4. contrast = mean(rTilde | agrees) - mean(rTilde | silent or disagrees).
 *
 * NB the demeaning in (2) cancels out of (4) exactly — see the header. It is applied
 * because it is what was pre-registered, and because the mean-zero per-session values
 * are what the DSR series wants. Nothing here depends on it, and a test pins the
 * identity so nobody later "optimizes" it away believing they have changed the answer.
 */
export function crossSectionalContrasts(
  rows: readonly JoinedRow[],
  caller: SessionSideCaller,
  minNames = XS_MIN_NAMES_PER_SESSION,
): { contrasts: SessionContrast[]; diagnostics: XsDiagnostics } {
  const bySession = new Map<string, JoinedRow[]>();
  for (const r of rows) {
    if (!r.trioFired) continue;
    const list = bySession.get(r.session) ?? [];
    list.push(r);
    bySession.set(r.session, list);
  }

  const diagnostics: XsDiagnostics = {
    sessionsSeen: bySession.size,
    sessionsUsed: 0,
    droppedTooFewNames: 0,
    droppedEmptyCohort: 0,
  };
  const contrasts: SessionContrast[] = [];

  for (const session of [...bySession.keys()].sort()) {
    const list = bySession.get(session)!;
    if (list.length < minNames) {
      diagnostics.droppedTooFewNames++;
      continue;
    }
    const c = mean(list.map((r) => r.rMultiple));
    const sides = caller(list);
    const agree: number[] = [];
    const other: number[] = [];
    list.forEach((r, i) => {
      const s = sides[i];
      // "Silent" and "disagrees" are ONE cohort here, by pre-registration: the
      // question is whether PCR's agreement RANKS names, so the comparison group is
      // every name it did not endorse.
      (s !== null && s === r.side ? agree : other).push(r.rMultiple - c);
    });
    if (agree.length === 0 || other.length === 0) {
      diagnostics.droppedEmptyCohort++;
      continue;
    }
    contrasts.push({
      session,
      contrast: mean(agree) - mean(other),
      names: list.length,
      nAgree: agree.length,
      nOther: other.length,
    });
    diagnostics.sessionsUsed++;
  }

  return { contrasts, diagnostics };
}

/**
 * The PAIRED per-session series: the PCR contrast NET OF the placebo's, session by
 * session.
 *
 * Paired — not two independently-averaged series — because the two contrasts are drawn
 * from the SAME session and are not independent samples. A session enters the series
 * only if BOTH contrasts are defined on it; otherwise it is DROPPED AND COUNTED, so the
 * raw mean and the placebo mean below are always computed over the SAME sessions and
 * their difference is the reported adjusted number.
 */
export interface XsSeries {
  sessions: string[];
  /** Per session: the real PCR cross-sectional contrast. */
  raw: number[];
  /** Per session: what a zero-information "buy the laggard" earns = the artifact. */
  placebo: number[];
  /** Per session: raw - placebo. THE BINDING observation series. */
  adjusted: number[];
  diagnostics: XsDiagnostics;
  placeboDiagnostics: XsDiagnostics;
}

export function crossSectionalSeries(
  rows: readonly JoinedRow[],
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  opts: { zThreshold?: number; minNames?: number } = {},
): XsSeries {
  const minNames = opts.minNames ?? XS_MIN_NAMES_PER_SESSION;
  const z = opts.zThreshold ?? PCR_Z_SIDE_THRESHOLD;

  const pcr = crossSectionalContrasts(rows, pcrSideCaller(carrier, interpretation, z), minNames);
  const plc = crossSectionalContrasts(rows, crossSectionalPlaceboCaller(), minNames);

  const plcBySession = new Map(plc.contrasts.map((c) => [c.session, c.contrast]));
  const sessions: string[] = [];
  const raw: number[] = [];
  const placebo: number[] = [];
  const adjusted: number[] = [];

  for (const c of pcr.contrasts) {
    const p = plcBySession.get(c.session);
    if (p === undefined || !Number.isFinite(p) || !Number.isFinite(c.contrast)) continue;
    sessions.push(c.session);
    raw.push(c.contrast);
    placebo.push(p);
    adjusted.push(c.contrast - p);
  }

  return {
    sessions,
    raw,
    placebo,
    adjusted,
    diagnostics: pcr.diagnostics,
    placeboDiagnostics: plc.diagnostics,
  };
}

/**
 * MOVING-BLOCK BOOTSTRAP OVER SESSIONS — the binding inference, exactly as the primary.
 *
 * The unit of observation is the SESSION CONTRAST, one scalar per session, so we
 * resample the SERIES directly rather than resampling rows and recomputing. That is not
 * a shortcut — it is the only correct thing to do here, and doing it the other way is a
 * live trap:
 *
 *   A row-level resample would hand the statistic a flat row array in which the SAME
 *   session can appear twice. Grouping those rows back by session key would MERGE the
 *   duplicates into one group — silently DE-DUPLICATING the resample. The session would
 *   be drawn twice and counted once, the between-session variance would collapse, and
 *   the interval would come out TOO NARROW. A too-narrow interval is a false PASS.
 *
 * Blocks of CONSECUTIVE sessions, block length >= H, for the same reason as the primary:
 * an H-session forward return at session i and one at i+1 share H-1 of their forward
 * days, so sessions are serially dependent by construction and resampling them
 * independently understates the variance.
 *
 * FAILS CLOSED on a degenerate resample (fewer than two whole blocks): every circular
 * draw would then be a rotation of the entire series, the statistic would never vary,
 * and the interval would collapse to ZERO WIDTH — which, sitting above zero, reads as a
 * confident PASS backed by no variance at all. NaN instead.
 */
export function blockBootstrapSeries(
  series: readonly number[],
  opts: { iters?: number; confidence?: number; seed?: number; blockLength?: number } = {},
): Ci {
  const iters = opts.iters ?? PCR_BOOTSTRAP_ITERS;
  const confidence = opts.confidence ?? PCR_BOOTSTRAP_CONFIDENCE;
  const rng = mulberry32(opts.seed ?? PCR_BOOTSTRAP_SEED);
  const point = mean(series);

  const n = series.length;
  if (n === 0) return { lo: Number.NaN, hi: Number.NaN, point, effective: 0 };

  const L = Math.max(1, Math.min(opts.blockLength ?? PRIMARY_HORIZON, n));
  if (n < 2 * L) return { lo: Number.NaN, hi: Number.NaN, point, effective: 0 };

  const nBlocks = Math.ceil(n / L);
  const stats: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample: number[] = [];
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * n);
      for (let k = 0; k < L; k++) sample.push(series[(start + k) % n]);
    }
    const v = mean(sample);
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

/** One (carrier x interpretation x horizon) cell of the SECONDARY grid. */
export interface XsCellResult {
  horizon: number;
  carrier: PcrCarrier;
  interpretation: PcrInterpretation;
  /** Sessions carrying a defined contrast — the independent units. NOT rows. */
  sessions: number;
  meanNamesPerSession: number;
  /** The un-adjusted cross-sectional contrast, in R. */
  rawContrastR: number;
  /** What "buy the relative laggard" earns on the same sessions = the artifact. */
  placeboContrastR: number;
  /** BINDING: raw NET of the placebo. This is the promotable number. */
  adjustedContrastR: number;
  /** BINDING: session-clustered moving-block 90% CI on the ADJUSTED contrast. */
  clustered: Ci;
  legs: {
    /** ADJUSTED contrast clears the pre-registered +0.05R bar. */
    upliftBar: boolean;
    /** 90% CI lower bound on the ADJUSTED contrast > 0. */
    clusteredCiPositive: boolean;
    /** N >= 30 SESSIONS. The secondary's own floor. */
    sessionFloor: boolean;
  };
  pass: boolean;
  diagnostics: XsDiagnostics;
  notes: string[];
}

export function evaluateXsCell(
  rows: readonly JoinedRow[],
  horizon: number,
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  opts: { zThreshold?: number; seed?: number; iters?: number; minNames?: number } = {},
): XsCellResult {
  const s = crossSectionalSeries(rows, carrier, interpretation, opts);
  const clustered = blockBootstrapSeries(s.adjusted, {
    seed: opts.seed,
    iters: opts.iters,
    blockLength: horizon,
  });

  const rawContrastR = mean(s.raw);
  const placeboContrastR = mean(s.placebo);
  const adjustedContrastR = mean(s.adjusted);
  const sessions = s.sessions.length;

  const notes: string[] = [];
  if (sessions === 0) notes.push('no session carries a defined cross-sectional contrast');
  if (sessions < XS_MIN_SESSIONS) {
    notes.push(`session floor: ${sessions} < ${XS_MIN_SESSIONS} sessions (secondary floor)`);
  }
  if (s.diagnostics.droppedTooFewNames > 0) {
    notes.push(
      `${s.diagnostics.droppedTooFewNames} session(s) dropped: fewer than ` +
        `${opts.minNames ?? XS_MIN_NAMES_PER_SESSION} fired names`,
    );
  }
  if (s.diagnostics.droppedEmptyCohort > 0) {
    notes.push(
      `${s.diagnostics.droppedEmptyCohort} session(s) dropped: PCR endorsed either every ` +
        `name or none, so there was nothing to contrast against`,
    );
  }
  // THE PLACEBO, REPORTED — but NOT as a per-sample alarm.
  //
  // The pre-registration requires the placebo to be run and reported, and treats "it
  // comes out at ~0" as the check that validates the estimand. It does come out at ~0 —
  // but that is a claim about the EXPECTATION ACROSS WORLDS, and it is pinned by the
  // control suite (|mean| < 0.05R over 200 zero-edge worlds), NOT by this number.
  //
  // ON A SINGLE SAMPLE THE PLACEBO IS VERY NOISY — SD of order 0.2R at 30-60 sessions,
  // i.e. several times the bar. An earlier revision of this file raised an ALARM here
  // whenever |placebo| >= the bar and declared "the pre-registration's premise does not
  // hold". Run against a real sample it fired immediately, on a PASSING world, on a
  // perfectly healthy estimand. That check would have cried wolf on the majority of real
  // reads and invited someone to void a valid result in November. A per-sample test of a
  // cross-world property is not a conservative check; it is a WRONG one.
  //
  // (I made the same mistake by hand while building this: I read +0.05R off a 30-world
  // batch, believed the premise had failed, and only a 300-world run with a standard
  // error showed it was zero. A HARNESS-BUILDER IS NOT EXEMPT FROM THE ARTIFACT THE
  // HARNESS EXISTS TO CATCH.)
  //
  // The VERDICT does not need this note to be safe: the placebo is SUBTRACTED from the
  // binding statistic, so whatever it earns on this sample is already netted out.
  if (Number.isFinite(placeboContrastR) && Math.abs(placeboContrastR) >= PCR_UPLIFT_BAR_R) {
    notes.push(
      `placebo on this sample: ${placeboContrastR.toFixed(4)}R (a zero-information "buy the ` +
        `relative laggard"). It is NETTED OUT of the binding statistic, so the verdict already ` +
        `accounts for it. A single sample's placebo is NOISY (SD ~0.2R) and a large value here ` +
        `is NOT evidence the estimand is broken — the "~0 by construction" premise is about the ` +
        `EXPECTATION across worlds and is pinned by the control suite. DO NOT void the secondary ` +
        `on the strength of this number.`,
    );
  }

  const legs = {
    upliftBar: Number.isFinite(adjustedContrastR) && adjustedContrastR >= PCR_UPLIFT_BAR_R,
    clusteredCiPositive: Number.isFinite(clustered.lo) && clustered.lo > 0,
    sessionFloor: sessions >= XS_MIN_SESSIONS,
  };

  return {
    horizon,
    carrier,
    interpretation,
    sessions,
    meanNamesPerSession: 0, // filled below
    rawContrastR,
    placeboContrastR,
    adjustedContrastR,
    clustered,
    legs,
    pass: Object.values(legs).every(Boolean),
    diagnostics: s.diagnostics,
    notes,
  };
}

/** DSR/PBO for the secondary. Same guards, same fail-closed evaluability rules. */
export interface XsGuards {
  /** The WHOLE STUDY's multiplicity — primary grid + secondary grid. */
  trials: number;
  dsr: DeflatedSharpeResult | null;
  pbo: PboResult | null;
  dsrEvaluable: boolean;
  pboEvaluable: boolean;
  notes: string[];
}

export function xsOverfittingGuards(
  rowsByHorizon: Record<number, readonly JoinedRow[]>,
  primary: XsCellResult,
  cells: readonly XsCellResult[],
  opts: { zThreshold?: number; minNames?: number } = {},
): XsGuards {
  const notes: string[] = [];
  const trials = PCR_STUDY_TRIALS;

  const primaryRows = rowsByHorizon[primary.horizon] ?? [];
  const seriesOf = (
    src: readonly JoinedRow[],
    carrier: PcrCarrier,
    interpretation: PcrInterpretation,
  ): number[] => crossSectionalSeries(src, carrier, interpretation, opts).adjusted;

  const primarySeries = seriesOf(primaryRows, primary.carrier, primary.interpretation);

  const sharpe = (xs: readonly number[]): number => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    return sd > 0 ? m / sd : 0;
  };

  const dsrEvaluable = primarySeries.length >= XS_MIN_SESSIONS;
  let dsr: DeflatedSharpeResult | null = null;
  if (dsrEvaluable) {
    // De-mirrored, exactly as the primary (TRA-1664): the trial SHARPES span
    // carrier x horizon at the PRE-REGISTERED interpretation only. Including both
    // `confirming` and `contrarian` would enter Var[SR] as +SR against -SR — the same
    // read with the sign flipped — and the STRONGER the true edge, the higher the
    // benchmark it would have to clear. That is a gate no real signal can pass.
    //
    // `trialCount` still carries the FULL 24-cell study multiplicity, so the
    // multiple-testing penalty is NOT softened — only the dispersion estimate.
    const trialSharpes: number[] = [];
    for (const carrier of ['raw', 'zDelta'] as const) {
      for (const h of HORIZONS) {
        const src = rowsByHorizon[h] ?? [];
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
      `DSR not evaluable: ${primarySeries.length} sessions < ${XS_MIN_SESSIONS} floor — HELD, not passed`,
    );
  }

  // PBO's CSCV needs >= `partitions` COLUMNS, and columns must ALIGN across trials.
  // Different cells drop different sessions, so align on the primary cell's session
  // list and fill a missing session with 0 (the same convention the primary uses for an
  // empty cohort). Grade evaluability OURSELVES — the underlying CSCV returns
  // `{pbo: 0, pass: true}` on thin data, i.e. it FAILS OPEN.
  const pboPartitions = 4;
  const axis = crossSectionalSeries(primaryRows, primary.carrier, primary.interpretation, opts)
    .sessions;
  const matrix = cells.map((c) => {
    const s = crossSectionalSeries(
      rowsByHorizon[c.horizon] ?? [],
      c.carrier,
      c.interpretation,
      opts,
    );
    const bySession = new Map(s.sessions.map((k, i) => [k, s.adjusted[i]]));
    return axis.map((k) => bySession.get(k) ?? 0);
  });
  const pboEvaluable = trials >= 2 && axis.length >= pboPartitions && cells.length >= 2;
  let pbo: PboResult | null = null;
  if (pboEvaluable) {
    pbo = probabilityOfBacktestOverfitting({ matrix, partitions: pboPartitions, threshold: 0.25 });
  } else {
    notes.push(
      `PBO not evaluable: ${cells.length} cells x ${axis.length} sessions — HELD, not passed ` +
        `(the underlying CSCV would fail OPEN here)`,
    );
  }

  return { trials, dsr, pbo, dsrEvaluable, pboEvaluable, notes };
}

export interface PcrCrossSectionalReport {
  /** Stamped on every report. The number must never travel without this sentence. */
  constraint: string;
  diagnostics: Record<number, JoinDiagnostics>;
  shape: SampleShape;
  cells: XsCellResult[];
  primary: XsCellResult | null;
  guards: XsGuards | null;
  /**
   * Three-valued and all three REACHABLE, on the TRA-1726 rule.
   *
   * - PASS — every leg AND both guards evaluable and passing. Promotes SELECTION ONLY.
   * - FAIL — DECISIVE NO-GO: the clustered CI's UPPER bound sits below the +0.05R bar,
   *   so even the optimistic end of the interval cannot clear it. Decisive at any N.
   * - HELD — the interval straddles the bar, or is not evaluable, or the sample is below
   *   the 30-session floor. NOT a NO-GO. Never a pass.
   *
   * A GATE WITH THREE OUTCOMES NEEDS THREE CONTROLS, and all three are pinned.
   */
  verdict: 'PASS' | 'FAIL' | 'HELD';
  reasons: string[];
}

/**
 * Run the SECONDARY estimand across the full pre-registered grid.
 *
 * Every cell is computed and published whether or not it clears — a result visible at
 * only one horizon is a horizon-cherry-pick, and hiding the other eleven cells is how
 * that gets laundered into a promotion.
 */
export function runPcrCrossSectional(
  ledger: readonly PcrShadowRow[],
  bars: readonly DailyBar[],
  opts: {
    primaryCarrier?: PcrCarrier;
    primaryInterpretation?: PcrInterpretation;
    zThreshold?: number;
    seed?: number;
    iters?: number;
    minNames?: number;
  } = {},
): PcrCrossSectionalReport {
  const primaryCarrier = opts.primaryCarrier ?? 'raw';
  const primaryInterpretation = opts.primaryInterpretation ?? 'contrarian';

  const diagnostics: Record<number, JoinDiagnostics> = {};
  const rowsByHorizon: Record<number, JoinedRow[]> = {};
  const cells: XsCellResult[] = [];
  let primaryRows: JoinedRow[] = [];

  for (const h of HORIZONS) {
    const { rows, diagnostics: d } = joinForwardReturns(ledger, bars, h);
    diagnostics[h] = d;
    rowsByHorizon[h] = rows;
    if (h === PRIMARY_HORIZON) primaryRows = rows;
    for (const carrier of ['raw', 'zDelta'] as const) {
      for (const interpretation of ['confirming', 'contrarian'] as const) {
        const cell = evaluateXsCell(rows, h, carrier, interpretation, opts);
        const used = crossSectionalSeries(rows, carrier, interpretation, opts);
        const namesPer = crossSectionalContrasts(
          rows,
          pcrSideCaller(carrier, interpretation, opts.zThreshold),
          opts.minNames,
        ).contrasts.filter((c) => used.sessions.includes(c.session));
        cell.meanNamesPerSession = namesPer.length
          ? mean(namesPer.map((c) => c.names))
          : Number.NaN;
        cells.push(cell);
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

  if (!primary) {
    return {
      constraint: SELECTION_ONLY_CONSTRAINT,
      diagnostics,
      shape,
      cells,
      primary: null,
      guards: null,
      verdict: 'HELD',
      reasons: ['primary secondary-cell not computed'],
    };
  }

  const primaryHorizonCells = cells.filter((c) => c.horizon === PRIMARY_HORIZON);
  const guards = xsOverfittingGuards(rowsByHorizon, primary, primaryHorizonCells, opts);

  const reasons: string[] = [...primary.notes, ...guards.notes];

  const guardsPass =
    guards.dsrEvaluable &&
    guards.pboEvaluable &&
    guards.dsr?.pass === true &&
    guards.pbo?.pass === true;

  // THE DECISIVE-NO-GO RULE (TRA-1726), applied verbatim to the secondary.
  //
  // A FAIL must rest on POSITIVE evidence AGAINST, never on the mere ABSENCE of
  // evidence for. IGNORANCE IS NOT CONDEMNATION: a NaN interval is HELD.
  const hi = primary.clustered.hi;
  const decisiveNoGo = Number.isFinite(hi) && hi < PCR_UPLIFT_BAR_R;

  let verdict: 'PASS' | 'FAIL' | 'HELD';
  if (primary.pass && guardsPass) {
    verdict = 'PASS';
    reasons.push(
      `PASS — SELECTION USE ONLY. ${SELECTION_ONLY_CONSTRAINT}`,
    );
  } else if (decisiveNoGo) {
    verdict = 'FAIL';
    reasons.push(
      `DECISIVE NO-GO: session-clustered 90% CI upper bound ${hi.toFixed(4)}R < ` +
        `${PCR_UPLIFT_BAR_R}R bar — even the optimistic end of the interval cannot clear it ` +
        `(adjusted cross-sectional contrast ${primary.adjustedContrastR.toFixed(4)}R; raw ` +
        `${primary.rawContrastR.toFixed(4)}R, of which ${primary.placeboContrastR.toFixed(4)}R ` +
        `is earned by a zero-information "buy the relative laggard")`,
    );
  } else {
    verdict = 'HELD';
    if (!Number.isFinite(hi)) {
      reasons.push(
        'HELD: the session-clustered CI is not evaluable on this sample — that is an ' +
          'abstention, not a NO-GO',
      );
    } else {
      reasons.push(
        `HELD: session-clustered 90% CI [${primary.clustered.lo.toFixed(4)}, ${hi.toFixed(4)}]R ` +
          `STRADDLES the ${PCR_UPLIFT_BAR_R}R bar — the sample cannot answer the question ` +
          `either way. Not a NO-GO; accrue more sessions.`,
      );
    }
    if (!primary.legs.sessionFloor) {
      reasons.push(`HELD leg: below the ${XS_MIN_SESSIONS}-session secondary floor`);
    }
    if (!primary.legs.upliftBar) {
      reasons.push(
        `HELD leg: adjusted cross-sectional contrast ${primary.adjustedContrastR.toFixed(4)}R < ` +
          `${PCR_UPLIFT_BAR_R}R bar (point estimate only — the interval still reaches it)`,
      );
    }
    if (!primary.legs.clusteredCiPositive) {
      reasons.push(
        `HELD leg: session-clustered 90% CI lower bound ${primary.clustered.lo.toFixed(4)} <= 0`,
      );
    }
    if (guards.dsr && !guards.dsr.pass) reasons.push('HELD leg: DSR guard failed');
    if (guards.pbo && !guards.pbo.pass) reasons.push('HELD leg: PBO guard failed');
  }

  return {
    constraint: SELECTION_ONLY_CONSTRAINT,
    diagnostics,
    shape,
    cells,
    primary,
    guards,
    verdict,
    reasons,
  };
}
