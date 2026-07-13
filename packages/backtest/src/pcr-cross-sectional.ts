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
 * TRA-1756 R1. The FAIL branch's own floor, in USED sessions.
 *
 * *** THIS IS A COUNT OF USED SESSIONS, NOT OF CALENDAR SESSIONS. ***
 *
 * The review asked for "no FAIL below N=60", meaning 60 CALENDAR sessions. This code
 * cannot see calendar sessions — `XsCellResult.sessions` counts the sessions that carry
 * a DEFINED contrast, after `droppedTooFewNames` and `droppedEmptyCohort`. On a realistic
 * (zero-to-small-edge) world those drops are severe and remarkably stable:
 *
 *     used ~= 0.48 x calendar    (measured: calendar 45/60/90/150 -> used 21.6/29.2/43.3/73.2)
 *
 * So 30 USED sessions IS calendar ~62, which is the review's N=60 to within the noise.
 * Taking the "60" literally and writing `sessions >= 60` would have been a silent
 * catastrophe: on a realistic world that is not reached until calendar ~125, so it would
 * not have NARROWED the condemn branch, it would have DELETED it — and the deletion would
 * have been invisible, because a branch that never fires and a branch that never needs to
 * fire render identically in a passing test suite.
 *
 * It is deliberately a SEPARATE constant from `XS_MIN_SESSIONS` even though both are 30:
 * they mean different things (one gates promotion, one gates condemnation) and a later
 * reader must be able to move one without moving the other.
 */
export const XS_MIN_FAIL_SESSIONS = 30;

/**
 * Re-exported for the CLI and the tests. Defined in `pcr-expectancy.ts` so the import
 * stays acyclic — see the doc comment there for why the primary's penalty goes UP when
 * this estimand is added.
 */
export { PCR_STUDY_TRIALS };

// ===========================================================================
// SPEC v3.1(C) — THE SECONDARY'S N=30 FEASIBILITY KILL-GATE            TRA-1800
// ===========================================================================
//
// Spec v3.1 (ruled on TRA-1741) puts a KILL GATE at calendar N=30: on the REAL ledger, if
// the estimand cannot resolve its own bar, TRA-1609 is RETIRED and we do NOT accrue to 90.
// The ruling gave the PRIMARY a number (`hw(30) <= 0.09R`) and left the SECONDARY without
// one. A joint gate with a threshold on only one arm can kill only half the study, and a
// HELD on the un-thresholded arm silently buys the extension the whole ruling exists to
// forbid. This is that missing number, derived the same way.
//
// --- THE DERIVATION (the primary's number, recovered, then re-run for this estimand) ---
//
// "Feasible" means: THE TERMINAL READ AT N=90 CAN RESOLVE THE BAR. That is `hw(90) <= bar`
// — at which point the decisive-FAIL branch becomes reachable AND the MDE comes down near
// the bar. One criterion rescues both branches. Back-propagate it to the gate at N=30:
//
//     hw(N) = c * N^-p          =>   hw(30) = hw(90) * (90/30)^p = bar * 3^p
//     THRESHOLD  T = bar * 3^p                                      <-- the general form
//
// The primary's ruled 0.09R is exactly this with p = 0.5:  0.05 * 3^0.5 = 0.0866 ~ 0.09R.
//
// *** SO THE ONLY ESTIMAND-SPECIFIC INPUT IS p, THE DECAY EXPONENT. AND p IS NOT 0.5. ***
//
// p = 0.5 is the textbook 1/sqrt(N) rate. It assumes i.i.d. observations. These are not:
// the bootstrap is a MOVING-BLOCK resample over serially-dependent session contrasts (an
// H-session forward return at session i shares H-1 of its days with the one at i+1), and
// the used-session count grows sub-linearly in calendar sessions. Measured, this estimand's
// half-width decays like N^-0.35, NOT N^-0.5 — it takes MORE data than the textbook rate to
// buy the same resolution, so THE SAME hw AT N=30 IS WORSE NEWS THAN p=0.5 IMPLIES, and a
// threshold built on p=0.5 IS TOO LOOSE.
//
//   fitted p, secondary, calendar N = 30..150, primary cell (H=5, raw, contrarian):
//     zero edge ................ 0.386      market-factor edge, xs=0 . 0.349
//     xs edge 0.3 .............. 0.356      xs edge 0.75 ............. 0.362
//     xs edge 1.5 (pos ctl) .... 0.402
//
//   INDEPENDENT CONTROL — fitting `POWER_CONSTRAINT`'s OWN table above (TRA-1756 R2,
//   measured at 200 worlds/cell, different seeds, different author): p = 0.354. It is not
//   an artifact of one run's seeds. T depends ONLY on the RATIO hw(30)/hw(90), i.e. only
//   on p, so the ~12% level disagreement between the two runs does not move the threshold.
//
//     T(p=0.500, the assumption) = 0.0866R      <- what the primary was given
//     T(p=0.386, null world)     = 0.0764R
//     T(p=0.349, fail-closed)    = 0.0733R      <- THE NUMBER, rounded DOWN to 0.073R
//
// FAIL-CLOSED means taking the SMALLEST p across the worlds we might be in: a slower decay
// projects a LARGER hw(90), which is the harder thing to call feasible. Rounding is DOWN.
//
// --- WHY THIS ESTIMAND IS NOT STATE-DEPENDENT, AND THE PRIMARY IS ---
//
// TRA-1741's headline correction was that the PRIMARY's half-width is STATE-DEPENDENT: it
// inflates 2.5-3x in the world where a promotion decision actually gets made (0.20R at a
// zero edge -> 0.63R at a real one), because that edge is injected through the MARKET
// FACTOR and the edge and the noise scale together. A power number read off the null world
// is therefore not the power of the decision.
//
// *** THAT TRAP DOES NOT TRANSFER TO THIS ESTIMAND, AND THE REASON IS STRUCTURAL. ***
//
// Measured here: hw(30) is 0.326R at a zero edge and 0.296R at a 32x-bar cross-sectional
// edge — FLAT, if anything slightly NARROWER. This estimand is a contrast between names
// WITHIN one session, so the market factor differences out exactly (see THE DEMEANING IS A
// NO-OP). A per-NAME edge does not inflate the contrast's variance the way a market-factor
// edge inflates the primary's. So for the SECONDARY — and ONLY the secondary — the
// null-world half-width IS a sound estimate of the act-world half-width.
//
// This is worth stating because the obvious move is to inherit the primary's 3x inflation
// factor by analogy. It would be wrong, and it would be wrong in the CONSERVATIVE direction
// here, which is how a wrong number survives review.

/** The calendar session count at which Spec v3.1(A)'s feasibility gate is read. */
export const XS_FEASIBILITY_GATE_N = 30;

/**
 * SPEC v3.1(C). The SECONDARY's N=30 feasibility kill-threshold, in R. TRA-1800.
 *
 * `hw_xs(30) <= 0.073R` => FEASIBLE, accrue on to the terminal read.
 * `hw_xs(30) >  0.073R` => RETIRE. Non-evaluable => RETIRE. Fail-closed, both ways.
 *
 * = bar * 3^p with p = 0.349 (the fail-closed decay exponent), rounded DOWN. See above.
 *
 * TIGHTER than the primary's ruled 0.09R, and that is not a typo: this estimand's
 * half-width decays MORE SLOWLY than the 1/sqrt(N) the primary's number assumed, so the
 * same hw at N=30 buys LESS resolution at N=90. (The primary's own act-world p measures
 * 0.335, which would put ITS threshold at 0.072R too — reported to the CTO on TRA-1741;
 * changing a ruled number is not this file's call.)
 *
 * ON OUR BEST PRIOR (the synthetic) hw_xs(30) ~ 0.30R — 4x ABOVE THIS GATE. We therefore
 * EXPECT this gate to kill the secondary at N=30, exactly as we expect the primary's to
 * kill the primary. That is the POINT of Spec v3.1: spend six weeks and a flag, not four
 * and a half months, and take the kill on REAL data rather than on a generator.
 */
export const XS_HW30_FEASIBILITY_R = 0.073;

/**
 * SPEC v3.1(C). The USED-session floor at the N=30 gate. TRA-1800.
 *
 * *** THE LEG THE PRIMARY HAS NO ANALOGUE FOR, AND THE ONE MOST LIKELY TO FIRE. ***
 *
 * The primary's N is calendar sessions. THIS estimand's N is USED sessions — a session
 * enters only if it carries >= `XS_MIN_NAMES_PER_SESSION` (5) fired-trio names AND the PCR
 * read splits them into two non-empty cohorts. Everything downstream is denominated in
 * USED sessions: `XS_MIN_SESSIONS` (30, promotion), `XS_MIN_FAIL_SESSIONS` (30, condemn),
 * and the block bootstrap itself (which returns NaN below 2*H = 10).
 *
 * So a secondary can have a beautiful half-width at N=30 and STILL be dead on arrival,
 * because at the TERMINAL read it will not have the 30 used sessions that BOTH its verdict
 * branches require. A half-width gate cannot see that. This one can.
 *
 * Derivation. The terminal read needs `used(90) >= 30`. The projection `used(90) = 3 *
 * used(30)` is measured TIGHT on the synth (proj 60.7/63.8/63.1/72.7/84.8 vs actual
 * 61.0/62.6/63.4/73.7/84.9 across five worlds) => `used(30) >= 10`. That is ALSO exactly
 * the bootstrap's own evaluability floor (2*H = 10), so one number carries both reasons.
 * Set at 12, not 10, for headroom against yield drift (sd of used(30) ~ 3.5 on the synth):
 * 12 projects to 36 used sessions at N=90, ~20% clear of the 30 both branches need.
 *
 * 🔴 THE SYNTH GIVES NO PRIOR FOR THIS LEG, AND SAYS SO. On the synthetic ledger all 15
 * names fire every session, so `droppedTooFewNames` is 0 in EVERY world and the 5-name
 * minimum is NEVER exercised. The measured yield (0.67-0.94) is an artifact of a universe
 * where the trio always fires broadly. THE REAL LEDGER'S CROSS-SECTIONAL BREADTH IS
 * UNKNOWN. If the real trio fires on fewer than 5 names on most sessions, `used(30)` is
 * near ZERO and the secondary is structurally unreadable at ANY N — and this leg is the
 * only thing standing between us and accruing 90 sessions into an estimand that was never
 * going to produce a number. Sibling of TRA-1810's uncalibrated R-scale: the generator is
 * being asked a question about the real world that it has never been checked against.
 */
export const XS_MIN_USED_SESSIONS_AT_30 = 12;

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
 * TRA-1756 R2. Stamped into every secondary report ALONGSIDE `SELECTION_ONLY_CONSTRAINT`,
 * and printed by the CLI on PASS, FAIL and HELD alike.
 *
 * Same reasoning that made `SELECTION_ONLY_CONSTRAINT` necessary, and it applies twice
 * over: in November somebody reads a verdict off a table, not this file, and a bare "HELD"
 * reads as "PCR does not rank names — drop it." It does not mean that. It means the edge,
 * if any, was smaller than the smallest edge this read can SEE.
 *
 * The numbers are measured, not asserted (12 worlds/cell for the PASS curve, 200/cell for
 * the intervals):
 *
 *   true edge | vs bar | PASS at N=45 | PASS at N=90        session-clustered 90% CI
 *   ----------+--------+--------------+-------------        HALF-WIDTH, zero-edge worlds:
 *     +0.10R  |    2x  |     0/12     |     0/12              calendar N=45  -> 0.309R
 *     +0.20R  |    4x  |     0/12     |     0/12              calendar N=60  -> 0.286R
 *     +0.36R  |    7x  |     0/12     |     2/12              calendar N=90  -> 0.246R
 *     +1.62R  |   32x  |    11/12     |    12/12              calendar N=150 -> 0.203R
 *
 * The half-width column is the whole story in one number: the instrument's resolution is
 * 0.2-0.3R and the promotion bar is 0.05R. THE BAR IS 4-6x BELOW THE NOISE FLOOR OF THE
 * ESTIMATOR THAT GRADES IT. The +0.05R bar was chosen as a PROMOTION threshold and nobody
 * ever checked it was a DETECTABLE one (TRA-1756 R3: the primary has the same disease —
 * its own positive control is 30x the bar and it musters 62% power at N=90 against it).
 */
export const POWER_CONSTRAINT =
  'POWER. At N=45 sessions this read releases only on a selection edge of roughly +1.0R ' +
  'or larger; edges below ~+0.4R are INVISIBLE to it at any N <= 90. The session-clustered ' +
  '90% CI has a half-width of 0.2-0.3R against a +0.05R promotion bar, so the bar sits 4-6x ' +
  'BELOW the noise floor of the estimator that grades it. *** A HELD IS NOT EVIDENCE OF ' +
  'ABSENCE. *** It means "no edge larger than the minimum detectable effect" — NOT "no ' +
  'edge", and NEVER "PCR does not rank names". Do not read a HELD as a reason to drop the ' +
  'PCR overlay; the only thing it licenses is continuing to accrue sessions.';

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

/** The condemn branch's ruling, and — when it withholds — WHY. */
export interface XsCondemnRuling {
  /** True => the verdict may be FAIL: a DECISIVE, IRREVERSIBLE no-go. */
  decisive: boolean;
  /**
   * Set when the STATUS-QUO rule (`hi < bar`) would have condemned and this rule REFUSED.
   * It must be surfaced in the report: a reader who sees a sub-bar point estimate and a
   * HELD is owed the reason, or they will "fix" the gate back to the coin flip.
   */
  withheld: string | null;
}

/**
 * THE CONDEMN RULE — the single source of truth for whether a FAIL is permitted.
 *
 * The verdict calls this, and so does every test. NOBODY RETYPES IT. A grader written from
 * recall is a different grader, and the one thing this issue has proved three times over is
 * that a control which does not discriminate looks exactly like one that does.
 *
 * ===========================================================================
 * TRA-1756 R1 — WHY `hi < bar` ALONE IS A COIN FLIP WITH AN IRREVERSIBLE CONSEQUENCE
 * ===========================================================================
 *
 * A FAIL is a DECISIVE NO-GO (TRA-1726): it retires the overlay. It does not mean "not
 * yet". So the ONLY costs that matter are:
 *
 *   - the FALSE KILL: condemning a world that carries a real, promotable edge, and
 *   - REACHABILITY: a branch that can never fire certifies nothing (TRA-1726).
 *
 * The pre-TRA-1756 rule was `hi < bar` — condemn whenever the optimistic end of the
 * interval fails to reach +0.05R. But the interval's own HALF-WIDTH is 0.2-0.3R, i.e.
 * 4-6x the bar (see `POWER_CONSTRAINT`). Condemning on a hair's breadth with a ruler that
 * wide is not evidence. Measured, 200 worlds/cell:
 *
 *                                       FALSE KILL on a real +0.087R edge (1.7x the bar)
 *   rule                                 N=45    N=60    N=90   N=150
 *   -----------------------------------  -----   -----   -----  -----
 *   `hi < bar` (the old rule)             9.5%    6.5%    7.0%   4.0%     <- a coin flip
 *   + session floor ONLY (R1 as written)  1.0%    2.5%    6.5%   4.0%     <- DELAYS it
 *   + floor AND margin (this rule)        0.0%    0.5%    0.5%   0.0%     <- cures it
 *
 * *** THE FLOOR ALONE IS NOT THE FIX, AND THAT IS THE POINT OF THIS FUNCTION. ***
 * The review's remedy was a session floor. It looks clean at N=45-60 and then the false
 * kill CLIMBS BACK TO 6.5% AT N=90 — the exact window the study is actually read at —
 * because once used-sessions cross the floor the old coin flip simply resumes. A floor
 * moves the disease; it does not cure it. (A CORRECT DIAGNOSIS IS NOT A CORRECT REMEDY.)
 *
 * The second term is what cures it: *** THE SHORTFALL MUST EXCEED THE RESOLUTION. ***
 * Condemn only if the gap from the bar down to the interval's optimistic end is BIGGER
 * than the interval's own half-width — i.e. only if we missed the bar by more than we can
 * measure. That is self-calibrating: it tightens automatically as the sample grows and it
 * does not depend on the synthetic generator's R-scale, which is the one input TRA-1756 R3
 * flags as never having been checked against the real ledger.
 *
 * And it costs NOTHING in reachability, which is the part that could have gone wrong: a
 * genuinely HARMFUL overlay (a true contrast of ~-1.6R — PCR anti-ranking the names) is
 * still condemned in *** 100% of worlds at every N from 45 to 150 ***. The branch is
 * narrowed, not deleted. Three outcomes, all three reachable, exactly as TRA-1726 requires.
 *
 * The rule the review floated — "require the CI WIDTH to be smaller than the bar" — was
 * measured and rejected: widths run 0.4-0.6R against a 0.05R bar, so it would need N in the
 * thousands and the FAIL branch would be dead on arrival at every N this study will ever
 * see. Dead-on-arrival is the failure TRA-1726 exists to prevent.
 */
export function xsCondemnRuling(
  cell: Pick<XsCellResult, 'clustered' | 'sessions'>,
): XsCondemnRuling {
  const { lo, hi } = cell.clustered;

  // IGNORANCE IS NOT CONDEMNATION (TRA-1726). A NaN interval is an abstention. The caller
  // reports this case itself, so there is nothing to explain here.
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return { decisive: false, withheld: null };

  // The interval still reaches the bar: an ordinary HELD, nothing was withheld.
  if (hi >= PCR_UPLIFT_BAR_R) return { decisive: false, withheld: null };

  // Below here the OLD rule would have condemned. Both new terms must clear.
  if (cell.sessions < XS_MIN_FAIL_SESSIONS) {
    return {
      decisive: false,
      withheld:
        `CONDEMNATION WITHHELD (session floor): the 90% CI upper bound ${hi.toFixed(4)}R is ` +
        `below the ${PCR_UPLIFT_BAR_R}R bar, but only ${cell.sessions} sessions carry a defined ` +
        `contrast (< ${XS_MIN_FAIL_SESSIONS}). A DECISIVE NO-GO is not available on a sample ` +
        `this thin — at that size the branch fires on a real 1.7x-bar edge about as often as ` +
        `on no edge at all. HELD. Waiting costs nothing; being decisive early is exactly when ` +
        `the decision is worthless.`,
    };
  }

  const halfWidth = (hi - lo) / 2;
  const shortfall = PCR_UPLIFT_BAR_R - hi;
  if (shortfall <= halfWidth) {
    return {
      decisive: false,
      withheld:
        `CONDEMNATION WITHHELD (resolution): the 90% CI upper bound ${hi.toFixed(4)}R is below ` +
        `the ${PCR_UPLIFT_BAR_R}R bar, but only by ${shortfall.toFixed(4)}R — LESS THAN THE ` +
        `INTERVAL'S OWN HALF-WIDTH of ${halfWidth.toFixed(4)}R. We missed the bar by less than ` +
        `we can measure, so this is not positive evidence AGAINST the overlay; it is a ` +
        `downward fluctuation of an instrument too coarse to grade its own bar. HELD.`,
    };
  }

  return { decisive: true, withheld: null };
}

/**
 * The N=30 feasibility gate's ruling on the SECONDARY.
 *
 * - `GATE_NOT_REACHED` — fewer than `XS_FEASIBILITY_GATE_N` CALENDAR sessions have accrued.
 *   Keep accruing. This is NOT a pass.
 * - `FEASIBLE` — the estimand can resolve its own bar by the terminal read. Accrue on.
 * - `RETIRE` — it cannot, or it cannot be evaluated at all. DECISIVE, and it retires the
 *   secondary. Do not accrue to 90.
 */
export type XsFeasibilityState = 'GATE_NOT_REACHED' | 'FEASIBLE' | 'RETIRE';

export interface XsFeasibilityRuling {
  state: XsFeasibilityState;
  /** The measured half-width at the gate, in R. NaN if the interval is not evaluable. */
  hw: number;
  /** USED sessions — the estimator's real N. Not calendar sessions. */
  usedSessions: number;
  /** hw * 3^-p — what the half-width is projected to be at the N=90 terminal read. */
  projectedHw90: number;
  /** Which leg decided it. `null` when the gate was not reached. */
  leg: 'resolution' | 'breadth' | 'non-evaluable' | 'pass' | null;
  reason: string;
}

/**
 * SPEC v3.1(C) — THE SECONDARY'S N=30 FEASIBILITY KILL-GATE. TRA-1800.
 *
 * The single source of truth. The report calls this, and so does every test. NOBODY
 * RETYPES IT — a grader written from recall is a different grader, and this study has now
 * produced three separate controls that did not discriminate (TRA-1727) precisely because
 * a second copy of a rule drifted from the first.
 *
 * Three legs, CONJUNCTIVE, all FAIL-CLOSED. Any one of them ⇒ RETIRE:
 *
 *   1. NON-EVALUABLE ⇒ RETIRE. A NaN interval, no defined contrast, an empty join. A
 *      broken or empty ledger must NEVER buy an extension — per the ruling, that is
 *      precisely how the last four months were lost. Note this INVERTS the sign of
 *      `xsCondemnRuling`'s "IGNORANCE IS NOT CONDEMNATION": there, a NaN is an abstention
 *      because a FAIL is a scientific claim ABOUT THE OVERLAY and you cannot make one from
 *      ignorance. HERE, a NaN is a RETIRE because feasibility is a claim ABOUT THE STUDY,
 *      and an instrument that cannot produce a number has ALREADY demonstrated it cannot
 *      answer the question. THE TWO RULES DISAGREE ON PURPOSE. They are asking different
 *      questions, and reading either as the other is how a fail-closed gate becomes a
 *      fail-open one.
 *   2. BREADTH ⇒ `usedSessions >= XS_MIN_USED_SESSIONS_AT_30`, else RETIRE. Projected used
 *      sessions at N=90 would not clear the 30 that BOTH verdict branches require.
 *   3. RESOLUTION ⇒ `hw <= XS_HW30_FEASIBILITY_R`, else RETIRE. The projected terminal
 *      half-width cannot resolve the +0.05R bar.
 *
 * `calendarSessions` is passed EXPLICITLY and is not inferrable from the cell — `cell.sessions`
 * is a count of USED sessions and confusing the two is the exact silent catastrophe
 * `XS_MIN_FAIL_SESSIONS` documents above. Below the gate this returns `GATE_NOT_REACHED`
 * rather than a verdict, so an early call cannot be mistaken for a pass.
 */
export function xsFeasibilityRuling(
  cell: Pick<XsCellResult, 'clustered' | 'sessions'>,
  calendarSessions: number,
): XsFeasibilityRuling {
  const { lo, hi } = cell.clustered;
  const hw = (hi - lo) / 2;
  const used = cell.sessions;
  // p = 0.349, the fail-closed decay exponent the threshold is derived from.
  const projectedHw90 = Number.isFinite(hw) ? hw * Math.pow(3, -0.349) : Number.NaN;
  const base = { hw, usedSessions: used, projectedHw90 };

  if (calendarSessions < XS_FEASIBILITY_GATE_N) {
    return {
      ...base,
      state: 'GATE_NOT_REACHED',
      leg: null,
      reason:
        `feasibility gate not reached: ${calendarSessions} < ${XS_FEASIBILITY_GATE_N} CALENDAR ` +
        `sessions. Keep accruing. THIS IS NOT A PASS.`,
    };
  }

  if (!Number.isFinite(hw) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return {
      ...base,
      state: 'RETIRE',
      leg: 'non-evaluable',
      reason:
        `RETIRE (non-evaluable): at ${calendarSessions} calendar sessions the secondary's ` +
        `session-clustered interval is not computable (${used} used session(s)). Spec v3.1 is ` +
        `FAIL-CLOSED: an instrument that cannot produce a number at the gate has already shown ` +
        `it cannot answer the question by N=90. A broken or empty ledger must never buy an ` +
        `extension.`,
    };
  }

  if (used < XS_MIN_USED_SESSIONS_AT_30) {
    return {
      ...base,
      state: 'RETIRE',
      leg: 'breadth',
      reason:
        `RETIRE (breadth): only ${used} of ${calendarSessions} calendar sessions carry a DEFINED ` +
        `cross-sectional contrast (< ${XS_MIN_USED_SESSIONS_AT_30}). Projected used sessions at ` +
        `the N=90 terminal read is ~${(3 * used).toFixed(0)}, short of the ${XS_MIN_SESSIONS} that ` +
        `BOTH the PASS and the FAIL branch require — so the terminal read could return NOTHING BUT ` +
        `HELD no matter what the data say. The half-width is irrelevant when the verdict is ` +
        `structurally unreachable. Accruing to 90 would buy a number that cannot be read.`,
    };
  }

  if (hw > XS_HW30_FEASIBILITY_R) {
    return {
      ...base,
      state: 'RETIRE',
      leg: 'resolution',
      reason:
        `RETIRE (resolution): session-clustered 90% CI half-width ${hw.toFixed(4)}R at the N=30 ` +
        `gate exceeds the ${XS_HW30_FEASIBILITY_R}R feasibility threshold. Projected half-width at ` +
        `the N=90 terminal read is ${projectedHw90.toFixed(4)}R — against a ${PCR_UPLIFT_BAR_R}R ` +
        `bar. The instrument cannot resolve its own promotion bar at the terminal read, so the ` +
        `read cannot answer the question and the remaining 60 sessions of accrual would be a ` +
        `DELAY, NOT AN EXPERIMENT.`,
    };
  }

  return {
    ...base,
    state: 'FEASIBLE',
    leg: 'pass',
    reason:
      `FEASIBLE: half-width ${hw.toFixed(4)}R <= ${XS_HW30_FEASIBILITY_R}R on ${used} used ` +
      `sessions. Projected ${projectedHw90.toFixed(4)}R at the N=90 terminal read, which resolves ` +
      `the ${PCR_UPLIFT_BAR_R}R bar. Accrue on to the terminal read.`,
  };
}

export interface PcrCrossSectionalReport {
  /** Stamped on every report. The number must never travel without this sentence. */
  constraint: string;
  /** TRA-1756 R2. Stamped on every report, for the same reason `constraint` is. */
  power: string;
  diagnostics: Record<number, JoinDiagnostics>;
  shape: SampleShape;
  cells: XsCellResult[];
  primary: XsCellResult | null;
  guards: XsGuards | null;
  /**
   * Three-valued and all three REACHABLE, on the TRA-1726 rule.
   *
   * - PASS — every leg AND both guards evaluable and passing. Promotes SELECTION ONLY.
   * - FAIL — DECISIVE NO-GO, on `xsCondemnRuling`: the clustered CI's upper bound sits
   *   below the +0.05R bar BY MORE THAN THE INTERVAL'S OWN HALF-WIDTH, on at least
   *   `XS_MIN_FAIL_SESSIONS` sessions. Irreversible, so it must rest on evidence the
   *   instrument can actually resolve — see `xsCondemnRuling` for the measurements.
   * - HELD — anything else: the interval reaches the bar, or is not evaluable, or the
   *   sample is below a floor, or it missed the bar by less than it can measure. NOT a
   *   NO-GO. Never a pass.
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
      power: POWER_CONSTRAINT,
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

  // THE DECISIVE-NO-GO RULE (TRA-1726 + TRA-1756 R1). ONE predicate, shared by the verdict
  // and by every test — see `xsCondemnRuling`.
  //
  // A FAIL must rest on POSITIVE evidence AGAINST, never on the mere ABSENCE of evidence
  // for. IGNORANCE IS NOT CONDEMNATION: a NaN interval is HELD — and so, now, is a
  // shortfall smaller than the interval's own half-width, which is the same thing wearing
  // a number.
  const hi = primary.clustered.hi;
  const ruling = xsCondemnRuling(primary);

  let verdict: 'PASS' | 'FAIL' | 'HELD';
  if (primary.pass && guardsPass) {
    verdict = 'PASS';
    reasons.push(
      `PASS — SELECTION USE ONLY. ${SELECTION_ONLY_CONSTRAINT}`,
    );
  } else if (ruling.decisive) {
    verdict = 'FAIL';
    reasons.push(
      `DECISIVE NO-GO: session-clustered 90% CI upper bound ${hi.toFixed(4)}R falls short of ` +
        `the ${PCR_UPLIFT_BAR_R}R bar by ${(PCR_UPLIFT_BAR_R - hi).toFixed(4)}R — MORE than the ` +
        `interval's own half-width of ${((hi - primary.clustered.lo) / 2).toFixed(4)}R, on ` +
        `${primary.sessions} sessions. Even the optimistic end of the interval cannot clear the ` +
        `bar, and it misses by more than this instrument can resolve, so this is positive ` +
        `evidence AGAINST (adjusted cross-sectional contrast ` +
        `${primary.adjustedContrastR.toFixed(4)}R; raw ${primary.rawContrastR.toFixed(4)}R, of ` +
        `which ${primary.placeboContrastR.toFixed(4)}R is earned by a zero-information "buy the ` +
        `relative laggard")`,
    );
  } else {
    verdict = 'HELD';
    if (!Number.isFinite(hi)) {
      reasons.push(
        'HELD: the session-clustered CI is not evaluable on this sample — that is an ' +
          'abstention, not a NO-GO',
      );
    } else if (ruling.withheld) {
      // The old rule WOULD have condemned here. Say so, and say why we refused — otherwise
      // the next reader sees a sub-bar interval sitting on a HELD, calls it a bug, and
      // "fixes" the gate straight back into the coin flip.
      reasons.push(`HELD: ${ruling.withheld}`);
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
    // TRA-1756 R2. A HELD is the MODAL outcome of this read and the one most likely to be
    // misread — "PCR doesn't rank names, drop it". It does not say that. The power caveat
    // ships INSIDE the verdict's own reasons, not just in a field somebody has to look up.
    reasons.push(`HELD — READ THIS BEFORE ACTING ON IT. ${POWER_CONSTRAINT}`);
  }

  return {
    constraint: SELECTION_ONLY_CONSTRAINT,
    power: POWER_CONSTRAINT,
    diagnostics,
    shape,
    cells,
    primary,
    guards,
    verdict,
    reasons,
  };
}
