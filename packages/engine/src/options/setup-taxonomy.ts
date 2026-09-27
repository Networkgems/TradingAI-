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

/**
 * What a setup returns when it declines and wants to say WHICH LEG refused.
 *
 * ⛔ WHY THIS EXISTS (TRA-4423, measured live 2026-09-25). Every setup here is a
 * CONJUNCTION, and a bare `null` collapses all of its legs into one symbol. On
 * 2026-09-25 setup E read `matchedSameSide: 0` against an honest, dense
 * `reached: 1869` — and that zero was STILL unreadable, because "the market
 * offered no coiled breakout today" (correct, expected, common on one session)
 * and "the coil threshold is mis-specified and can never pass" are the same
 * `null`. Worse, E is the only setup of the five that reads `volume`, and the
 * daily fetcher maps `volume: q.volume ?? 0` — so a provider answering null
 * volume zeroes E's expansion leg FOREVER, on every row, with no tell.
 *
 * Returning a decline instead of `null` is what makes those states different
 * symbols. It is OPTIONAL: `null` stays valid and means "declined, leg not
 * attributed", so A-D need no change and no second implementation can drift
 * away from the one that decides.
 *
 * ⛔ A DECLINE IS NOT A MATCH. It carries no `side` and the verdict treats it
 * EXACTLY as `null` — see {@link isSetupTaxonomyMatch}.
 */
export interface SetupTaxonomyDecline {
  readonly setupId: string;
  /**
   * Which conjunctive leg refused. Short, stable, low-cardinality snake_case —
   * this is a histogram key on a health route, never a per-candidate number.
   */
  readonly declinedAt: string;
}

/** A match, an attributed decline, or an unattributed decline. */
export type SetupTaxonomyOutcome = SetupTaxonomyMatch | SetupTaxonomyDecline | null;

/**
 * Discriminate a match from a decline.
 *
 * Keyed on `side`, which {@link SetupTaxonomyMatch} always carries and
 * {@link SetupTaxonomyDecline} never does. ⛔ Do NOT key this on `declinedAt`
 * being absent — that would read a malformed match as a decline instead of
 * failing, and the whole point here is that the two must never be confusable.
 */
export function isSetupTaxonomyMatch(o: SetupTaxonomyOutcome): o is SetupTaxonomyMatch {
  return o !== null && 'side' in o;
}

/** One registered setup. A-E implement this; none exist yet, by design. */
export interface SetupTaxonomyDefinition {
  readonly setupId: string;
  readonly label: string;
  /** Minimum bars THIS setup needs; the gate takes the max over enabled setups. */
  readonly minBars: number;
  /**
   * ⛔ A {@link SetupTaxonomyDecline} return is a DECLINE, byte-equivalent to
   * `null` for the verdict. It exists only so the leg that refused reaches the
   * counterfactual fold.
   */
  evaluate(input: SetupTaxonomyInput): SetupTaxonomyOutcome;
}

export interface SetupTaxonomyInput {
  readonly symbol: string;
  readonly series: readonly Candle[];
  /** The wing the mispricing nominator picked. */
  readonly nomineeSide: SetupTaxonomySide;
}

/**
 * What ONE setup did on ONE row, independent of who won.
 *
 * ⛔ THIS EXISTS BECAUSE THE VERDICT IS FIRST-MATCH-WINS AND THE REGISTRY IS
 * ORDERED. {@link SetupTaxonomyVerdict.setupId} names whichever setup matched
 * FIRST in registry order, so a setup late in the list is invisible on every row
 * an earlier one already claimed — and a per-setup counter folded off `setupId`
 * alone reads IDENTICALLY whether that setup never fires or is never reached.
 * Measured live on 2026-09-24 (TRA-4423): setup `E`, last of five, scored 0
 * confirms and 0 conflicts, but had genuinely been CALLED on only 2,197 of 2,876
 * rows — the other 679 returned at A-D before E ran. `reached` is the
 * discriminator that makes those two states distinguishable.
 */
export interface SetupTaxonomyScore {
  readonly setupId: string;
  /** TRUE ⇒ `evaluate` was actually CALLED on this row. */
  readonly reached: boolean;
  /** TRUE ⇒ it returned a match. ⛔ Meaningless unless `reached`. */
  readonly matched: boolean;
  /** The side it matched, when it did. Null otherwise. */
  readonly side: SetupTaxonomySide | null;
  /** TRUE ⇒ `evaluate` threw and was folded as a decline (never a series fault). */
  readonly threw: boolean;
  /**
   * Which conjunctive leg refused, when the setup declined AND attributed it.
   * Null on a match, on a throw, and on a setup that returns bare `null`.
   *
   * ⛔ NULL IS "NOT ATTRIBUTED", NOT "NO REASON". A setup that declines without
   * naming a leg reads null here, exactly like one that matched — always gate a
   * decline histogram on `reached && !matched` before reading this.
   */
  readonly declinedAt: string | null;
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
   *
   * ⚠️ This is the TRUE call count, so it depends on `scoreAll`: under the
   * default first-match-wins walk it stops at the confirming setup, and under
   * `scoreAll` it is the full enabled count. Compare it against
   * {@link perSetup} rather than across modes.
   */
  readonly setupsScored: number;
  /**
   * Per-setup detail, dense over the ENABLED list, in registry order. Present
   * only when scored with `{ scoreAll: true }`.
   *
   * ⛔ ABSENT IS NOT EMPTY. An absent `perSetup` means this row was walked
   * first-match-wins and carries NO per-setup truth — a fold must skip the row
   * and say so, never treat it as "no setup matched".
   */
  readonly perSetup?: readonly SetupTaxonomyScore[];
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
 *  2. Then the enabled setups are walked. A CONFLICT never stops the walk,
 *     because a match on the wrong side is a different fact from no match at
 *     all, and stopping there would report whichever one happened to be first.
 *     ⚠️ A CONFIRMATION *does* settle the verdict, so by default the walk stops
 *     and setups after the winner are never called. That is correct for the
 *     decision and WRONG for measurement — pass `{ scoreAll: true }` to keep
 *     walking and fill {@link SetupTaxonomyVerdict.perSetup}. The verdict is
 *     identical either way. (TRA-4423: without it, a per-setup counter cannot
 *     tell "never fires" from "never reached" for anything but setup A.)
 *  3. A same-side match confirms. Otherwise, if any setup matched on the other
 *     side, that is `setup_side_conflict` and NOT a flip: the sleeve does not go
 *     shopping for the other wing. (Flipping would make the taxonomy a
 *     nominator, a far larger change — TRA-4421 §11 default 2, still pending
 *     board ratification on card `70e36987`.)
 */
export interface SetupTaxonomyScoreOptions {
  /**
   * Score EVERY enabled setup instead of returning at the first same-side
   * match, and publish {@link SetupTaxonomyVerdict.perSetup}.
   *
   * ⛔ THE VERDICT IS BYTE-FOR-BYTE THE SAME EITHER WAY. This flag buys
   * measurement, never behaviour: `confirmed`, `reasonCode`, `setupId` and
   * `confirmedSide` are still first-match-wins in registry order, because that
   * is what the gate consumes and what the enforce proposal (card `70e36987`)
   * is written against. Only `setupsScored` moves, and only because it is a
   * truthful call count.
   */
  readonly scoreAll?: boolean;
}

export function evaluateSetupTaxonomy(
  input: SetupTaxonomyInput,
  setups: readonly SetupTaxonomyDefinition[] = SETUP_TAXONOMY_REGISTRY,
  opts: SetupTaxonomyScoreOptions = {},
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

  const scoreAll = opts.scoreAll === true;
  // Dense over the ENABLED list from the start, so a setup that is never
  // reached is still present with `reached: false` rather than missing.
  const perSetup: SetupTaxonomyScore[] | null = scoreAll
    ? setups.map((s) => ({
        setupId: s.setupId,
        reached: false,
        matched: false,
        side: null,
        threw: false,
        declinedAt: null,
      }))
    : null;

  let conflict: SetupTaxonomyMatch | null = null;
  let confirm: SetupTaxonomyMatch | null = null;
  let scored = 0;
  for (let i = 0; i < setups.length; i += 1) {
    const setup = setups[i]!;
    // Once a confirmation is in hand the verdict is settled; under `scoreAll`
    // we keep walking PURELY to fill `perSetup`, and nothing below may touch
    // `confirm`/`conflict` again.
    const settled = confirm !== null;
    scored += 1;
    let match: SetupTaxonomyMatch | null = null;
    let declinedAt: string | null = null;
    let threw = false;
    try {
      const outcome = setup.evaluate(input);
      if (isSetupTaxonomyMatch(outcome)) {
        match = outcome;
      } else if (outcome !== null) {
        // An ATTRIBUTED decline. Identical to `null` for the verdict below; the
        // only thing it adds is which leg refused, for the fold.
        declinedAt = outcome.declinedAt;
      }
    } catch {
      // A setup that throws is that setup declining, not the series being
      // unreadable — the series demonstrably read fine for its siblings. It
      // folds to `no_setup_matched` rather than voiding the row's grade.
      match = null;
      declinedAt = null;
      threw = true;
    }
    if (perSetup) {
      perSetup[i] = {
        setupId: setup.setupId,
        reached: true,
        matched: match !== null,
        side: match?.side ?? null,
        threw,
        declinedAt,
      };
    }
    if (settled || !match) continue;
    if (match.side === input.nomineeSide) {
      confirm = match;
      if (!scoreAll) break;
      continue;
    }
    if (!conflict) conflict = match;
  }

  if (confirm) {
    return {
      confirmed: true,
      reasonCode: null,
      setupId: confirm.setupId,
      confirmedSide: confirm.side,
      setupsScored: scored,
      bars,
      seriesSpanMs,
      ...(perSetup ? { perSetup } : {}),
    };
  }

  return {
    confirmed: false,
    reasonCode: conflict ? 'setup_side_conflict' : 'no_setup_matched',
    setupId: conflict?.setupId ?? null,
    confirmedSide: conflict?.side ?? null,
    setupsScored: scored,
    bars,
    seriesSpanMs,
    ...(perSetup ? { perSetup } : {}),
  };
}
