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
 */

/** The subset of `OtmMispricingCandidate` this selector reads. */
export interface AdmissibleStrikeCandidate {
  /** Sign-adjusted Black-Scholes delta — negative for puts, hence the abs. */
  delta: number;
  classification: string;
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
  /** Band armed, but no `cheap` candidate landed in it; legacy nominee kept. */
  | 'fallback_top_mispricing'
  /** Selector disarmed — byte-identical to the legacy `find`. */
  | 'legacy'
  /** No `cheap` candidate at all. A thin chain, not a suppressed one. */
  | 'none';

export interface AdmissibleStrikeResult<T extends AdmissibleStrikeCandidate> {
  candidate: T | null;
  selection: AdmissibleSelection;
  /** How many `cheap` candidates the chain offered. */
  cheapConsidered: number;
  /** How many of those landed inside the band. */
  cheapInBand: number;
  /** The band applied, echoed so a verdict is readable without re-deriving it. */
  band: AdmissibleBand;
}

/**
 * Pick the OTM nominee.
 *
 * Candidates arrive sorted by `|mispricingPct|` (rank order), and that order is
 * preserved within the band: this returns the STRONGEST mispricing read that is
 * also admissible, so the mispricing edge still drives the choice — the band
 * only bounds where it may look.
 *
 * When `enabled` is false the result is byte-identical to the legacy
 * `find(c => c.classification === 'cheap')`, which is what makes this safe to
 * ship dark.
 *
 * A non-finite `delta` fails the band (matching TRA-1407's engine-side
 * predicate): an un-scored contract has no business clearing a distance gate.
 */
export function selectAdmissibleOtmCandidate<T extends AdmissibleStrikeCandidate>(
  candidates: readonly T[],
  opts: { enabled: boolean; band: AdmissibleBand },
): AdmissibleStrikeResult<T> {
  const { enabled, band } = opts;
  const cheap = candidates.filter((c) => c.classification === 'cheap');
  const top = cheap.length > 0 ? cheap[0] : null;

  if (!enabled) {
    return {
      candidate: top,
      selection: top ? 'legacy' : 'none',
      cheapConsidered: cheap.length,
      cheapInBand: 0,
      band,
    };
  }

  const inBand = cheap.filter((c) => {
    const abs = Math.abs(c.delta);
    return Number.isFinite(abs) && abs >= band.min && abs < band.max;
  });

  if (inBand.length > 0) {
    return {
      candidate: inBand[0],
      selection: 'in_band',
      cheapConsidered: cheap.length,
      cheapInBand: inBand.length,
      band,
    };
  }

  return {
    candidate: top,
    selection: top ? 'fallback_top_mispricing' : 'none',
    cheapConsidered: cheap.length,
    cheapInBand: 0,
    band,
  };
}
