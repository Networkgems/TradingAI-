import type { Candle } from '@trading-app/shared';

/**
 * TRA-4422 (parent TRA-4421, off the TRA-4412 swing-OTM spec) — THE SETUP
 * TAXONOMY INSTRUMENT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS FILE SHIPS ZERO SETUPS ON PURPOSE. {@link SETUP_TAXONOMY_REGISTRY} is
 *  empty, so {@link evaluateSetupTaxonomy} confirms nothing and the gate above
 *  it admits everything. It is measurement, not behaviour.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY AN EMPTY GATE IS A DELIVERABLE. The `single_leg_otm` sleeve today has 18
 * gates and every one of them is a veto on the CONTRACT — enumerated from every
 * `scanRun.reject(...)` call site on the OTM sweep body. Not one asks anything
 * about the underlying, and because the nominator ranks on `|mispricingPct|`
 * over a long-only sleeve, the option's SIDE is chosen by whichever wing happens
 * to be cheap. Setups A-E (TRA-4421 §5) are the fix.
 *
 * But adding a directional trigger is a RESTRICTION: `opensPlaced` falls whether
 * the trigger works or is broken and silently confirming nothing. A working gate
 * and a dead one read identically on every metric this sleeve publishes. So the
 * denominator, the reason-code histogram and the unreadable-input split have to
 * exist BEFORE the first setup, or the first setup's soak produces a number
 * indistinguishable from a wiring bug.
 *
 * WHAT THE EMPTY VERSION ACTUALLY MEASURES, and it is not nothing: the fraction
 * of live OTM nominees that arrive at the seam with a series deep enough to run
 * ANY of the setups on. That precondition has never been measured on this path,
 * and if it is bad then setup E is not buildable — which is worth knowing before
 * building it rather than after. See {@link SETUP_TAXONOMY_MIN_BARS}.
 */

/** The two wings the long-only OTM sleeve can nominate. */
export type SetupTaxonomySide = 'call' | 'put';

/**
 * Why a nominee was NOT setup-confirmed. Low-cardinality by construction — this
 * is the tuneable axis, and folding on per-candidate prose yields one bucket per
 * decision and answers nothing.
 *
 * ⛔ `series_unreadable` is SPLIT OUT from `no_setup_matched` deliberately, for
 * exactly the reason `entry_window` splits `clock_unreadable` from `closed`
 * (`signal-engine.ts:8006-8012`): an unreadable input is a runtime defect that
 * happens to fail closed, and folding it into the ordinary refusal hides a
 * broken box inside a bucket that is SUPPOSED to be large. `no_setup_matched` is
 * a real negative the taxonomy should be graded on; `series_unreadable` voids
 * that grade for the row.
 */
export type SetupTaxonomyReasonCode =
  /** Scored against every enabled setup, nothing confirmed. A real negative. */
  | 'no_setup_matched'
  /**
   * A setup confirmed, but on the OPPOSITE side from the cheap wing the
   * nominator picked. Its own code because the remedy is different: this says
   * the underlying has a directional read and the sleeve wants the wrong wing,
   * which no threshold change fixes.
   */
  | 'setup_side_conflict'
  /** Dislocation parked awaiting confirmation — correctly not ordering yet. */
  | 'awaiting_confirmation'
  /** Parked and timed out without confirming. */
  | 'confirmation_expired'
  /** No series / too few bars — THE GATE NEVER RAN. Not a refusal. */
  | 'series_unreadable';

export const SETUP_TAXONOMY_REASON_CODES: readonly SetupTaxonomyReasonCode[] = [
  'no_setup_matched',
  'setup_side_conflict',
  'awaiting_confirmation',
  'confirmation_expired',
  'series_unreadable',
] as const;

/**
 * Minimum bars required before a series is considered readable at all.
 *
 * ⚠️ THIS CONSTANT IS THE INSTRUMENT'S ONLY FREE PARAMETER, so it is justified
 * rather than picked. The shallowest of the five setups (E, Normal Breakout —
 * TRA-4421 §5-E) composes a Donchian channel, an ATR expansion read and a
 * volume-confirmed breakout. The deepest single lookback in that composition is
 * the channel; 60 bars is the smallest series on which a 20-period channel has a
 * settled value plus enough history to say the price was CONSOLIDATING inside it
 * rather than merely inside it on the last bar.
 *
 * ⛔ It bounds READABILITY, not sufficiency. A 60-bar 5-minute series is
 * readable by this definition and is still the wrong TIMEFRAME for a 3-20 day
 * swing thesis — see the `seriesSpanMs` field on {@link SetupTaxonomyVerdict}
 * and the header of {@link evaluateSetupTaxonomy}.
 */
export const SETUP_TAXONOMY_MIN_BARS = 60;

/** What a setup returns when it confirms. */
export interface SetupTaxonomyMatch {
  /** Stable id — 'A'..'E' per TRA-4421 §5. */
  readonly setupId: string;
  /** The side the UNDERLYING confirms, which may disagree with the cheap wing. */
  readonly side: SetupTaxonomySide;
  /** Short, low-cardinality note for the log. Never per-candidate numbers. */
  readonly detail?: string;
}

/** One registered setup. A-E implement this; none exist yet, by design. */
export interface SetupTaxonomyDefinition {
  readonly setupId: string;
  readonly label: string;
  /** Minimum bars THIS setup needs; the gate takes the max over enabled setups. */
  readonly minBars: number;
  evaluate(input: SetupTaxonomyInput): SetupTaxonomyMatch | null;
}

export interface SetupTaxonomyInput {
  readonly symbol: string;
  readonly series: readonly Candle[];
  /** The wing the mispricing nominator picked. */
  readonly nomineeSide: SetupTaxonomySide;
}

export interface SetupTaxonomyVerdict {
  /** TRUE ⇒ a setup confirmed on the nominee's own side. */
  readonly confirmed: boolean;
  /** Null when confirmed; otherwise WHY not. */
  readonly reasonCode: SetupTaxonomyReasonCode | null;
  /** Which setup confirmed, or which one conflicted. Null when neither. */
  readonly setupId: string | null;
  /** The side the underlying confirmed, when one did. */
  readonly confirmedSide: SetupTaxonomySide | null;
  /**
   * How many setups were actually scored. ⛔ ZERO IS NOT A PASS — with an empty
   * registry every verdict is `no_setup_matched` at `setupsScored: 0`, which a
   * grader must read as UNMEASURED, never as "the taxonomy found nothing".
   */
  readonly setupsScored: number;
  /** Bars seen. 0 ⇒ absent series. */
  readonly bars: number;
  /**
   * Wall-clock span of the series, ms. Published because bar COUNT alone cannot
   * tell a 60-bar 5-minute window (5 hours) from a 60-bar daily window (3
   * months), and every setup in this taxonomy is a MULTI-DAY thesis. A verdict
   * computed over 5 hours of intraday structure is answering a different
   * question than the one the sleeve is asking; this field is what makes that
   * visible on the tape instead of inferable from source.
   */
  readonly seriesSpanMs: number | null;
}

/**
 * The registered setups. EMPTY until TRA-4423 (setup E) lands.
 *
 * ⛔ A setup arriving in this array does NOT arm it — the server seam holds an
 * explicit per-setup enable list on top (`OTM_SETUP_TAXONOMY_SETUPS`), so
 * landing code and changing behaviour stay two separate acts.
 */
export const SETUP_TAXONOMY_REGISTRY: readonly SetupTaxonomyDefinition[] = [] as const;

function spanOf(series: readonly Candle[]): number | null {
  if (series.length < 2) return null;
  const first = series[0]?.timestamp;
  const last = series[series.length - 1]?.timestamp;
  if (typeof first !== 'number' || typeof last !== 'number') return null;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const span = last - first;
  return span >= 0 ? span : null;
}

/**
 * Score one nominee against the enabled setups.
 *
 * PURE. No env, no clock, no IO — the server seam owns all three, so this
 * function is testable against a literal series and cannot pick up the
 * "compiled default vs live env" ambiguity that has produced two false-greens on
 * this desk in the last week.
 *
 * Order of the checks is load-bearing:
 *
 *  1. READABILITY FIRST. An unreadable series short-circuits to
 *     `series_unreadable` before any setup runs, so a cold cache can never be
 *     laundered into `no_setup_matched`.
 *  2. Then every enabled setup is scored — ALL of them, not until-first-match —
 *     because a match on the wrong side is a different fact from no match at
 *     all, and stopping early would report whichever one happened to be first.
 *  3. A same-side match confirms. Otherwise, if any setup matched on the other
 *     side, that is `setup_side_conflict` and NOT a flip: the sleeve does not go
 *     shopping for the other wing. (Flipping would make the taxonomy a
 *     nominator, a far larger change — TRA-4421 §11 default 2, still pending
 *     board ratification on card `70e36987`.)
 */
export function evaluateSetupTaxonomy(
  input: SetupTaxonomyInput,
  setups: readonly SetupTaxonomyDefinition[] = SETUP_TAXONOMY_REGISTRY,
): SetupTaxonomyVerdict {
  const bars = input.series.length;
  const seriesSpanMs = spanOf(input.series);
  // The bar floor is the deepest requirement among the setups actually enabled,
  // never a global constant — an empty registry must not manufacture a
  // readability failure for a series nothing was going to read.
  const requiredBars = setups.length === 0
    ? SETUP_TAXONOMY_MIN_BARS
    : Math.max(...setups.map((s) => s.minBars));

  if (bars === 0 || bars < requiredBars) {
    return {
      confirmed: false,
      reasonCode: 'series_unreadable',
      setupId: null,
      confirmedSide: null,
      setupsScored: 0,
      bars,
      seriesSpanMs,
    };
  }

  let conflict: SetupTaxonomyMatch | null = null;
  let scored = 0;
  for (const setup of setups) {
    scored += 1;
    let match: SetupTaxonomyMatch | null = null;
    try {
      match = setup.evaluate(input);
    } catch {
      // A setup that throws is that setup declining, not the series being
      // unreadable — the series demonstrably read fine for its siblings. It
      // folds to `no_setup_matched` rather than voiding the row's grade.
      match = null;
    }
    if (!match) continue;
    if (match.side === input.nomineeSide) {
      return {
        confirmed: true,
        reasonCode: null,
        setupId: match.setupId,
        confirmedSide: match.side,
        setupsScored: scored,
        bars,
        seriesSpanMs,
      };
    }
    if (!conflict) conflict = match;
  }

  return {
    confirmed: false,
    reasonCode: conflict ? 'setup_side_conflict' : 'no_setup_matched',
    setupId: conflict?.setupId ?? null,
    confirmedSide: conflict?.side ?? null,
    setupsScored: scored,
    bars,
    seriesSpanMs,
  };
}
