import type { Candle } from '@trading-app/shared';
import type {
  SetupTaxonomyDefinition,
  SetupTaxonomyInput,
  SetupTaxonomyMatch,
  SetupTaxonomyOutcome,
} from './setup-taxonomy.js';

/**
 * TRA-4423 — the A-E setup definitions for the OTM mispricing taxonomy.
 *
 * ## Why this file is not `SETUP_TAXONOMY_REGISTRY`
 *
 * `evaluateSetupTaxonomy(input, setups)` already takes the setup list as a
 * parameter, and `setup-taxonomy.ts` documents that landing a setup must not arm
 * it. Exporting from here and letting the server seam pass this array keeps
 * those two acts separate, and keeps the module graph acyclic — `setup-taxonomy`
 * owns the types, this file owns the behaviour, and nothing points back.
 *
 * ## The rule every setup here obeys
 *
 * **Confirmation, never prediction.** A dislocation on its own is a watchlist
 * entry. Each `evaluate` below requires the underlying to have ALREADY done
 * something — reclaimed a level, lost a level, held a gap, broken a range — and
 * returns `null` while the move is merely extended. "The stock crashed" is not a
 * setup; "the stock crashed AND has started turning" is.
 *
 * This is the single most load-bearing property in the file. A setup that fires
 * on magnitude alone turns the sleeve into a falling-knife catcher, and every
 * one of these would be trivially "improved" by relaxing exactly that check.
 *
 * ## Timeframe
 *
 * These are 3-20 day swing theses and assume DAILY bars. `evaluateSetupTaxonomy`
 * publishes `seriesSpanMs` precisely so a 60-bar 5-minute window (5 hours)
 * cannot silently answer a question posed over months. Nothing here re-checks
 * that; the seam owns it.
 *
 * ## Purity
 *
 * No env, no clock, no IO. Every function is a fold over the candle array, so
 * each is testable against a literal series.
 */

// ─── shared helpers ──────────────────────────────────────────────────────────

/** A bar we are willing to read. Synthetic bars are flat fabrications (TRA-427)
 * bridging a data gap: they would report a false "inside day" and a false zero
 * volume, so structure is never inferred from them. */
function isReal(c: Candle | undefined): c is Candle {
  return !!c && c.synthetic !== true;
}

/** Percent change between two closes, as a fraction. */
function pctChange(from: number, to: number): number {
  if (!(from > 0)) return 0;
  return (to - from) / from;
}

/** Highest high / lowest low over the last `n` real bars (excluding `exclude` trailing bars). */
function highestHigh(series: readonly Candle[], n: number, exclude = 0): number | null {
  const end = series.length - exclude;
  const slice = series.slice(Math.max(0, end - n), end).filter(isReal);
  if (slice.length === 0) return null;
  return Math.max(...slice.map((c) => c.high));
}

function lowestLow(series: readonly Candle[], n: number, exclude = 0): number | null {
  const end = series.length - exclude;
  const slice = series.slice(Math.max(0, end - n), end).filter(isReal);
  if (slice.length === 0) return null;
  return Math.min(...slice.map((c) => c.low));
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** The last `n` real bars, oldest first. */
function tail(series: readonly Candle[], n: number): Candle[] {
  return series.filter(isReal).slice(-n);
}

/**
 * Locate the most recent EVENT GAP — an open that jumps at least
 * `minGapPct` from the prior close — within the last `lookback` bars.
 *
 * This stands in for "earnings happened". The taxonomy is pure and has no
 * earnings calendar, and a gap of this size on a liquid single name is
 * overwhelmingly an event. ⚠ It will also catch a guidance pre-announcement, an
 * M&A headline, or a sector shock — which is why setups C and D additionally
 * require the POST-gap behaviour, not merely the gap.
 */
function findRecentGap(
  series: readonly Candle[],
  lookback: number,
  minGapPct: number,
): { index: number; gapPct: number; prevClose: number; bar: Candle } | null {
  const bars = series.filter(isReal);
  const start = Math.max(1, bars.length - lookback);
  for (let i = bars.length - 1; i >= start; i -= 1) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (!prev || !cur) continue;
    const gapPct = pctChange(prev.close, cur.open);
    if (Math.abs(gapPct) >= minGapPct) {
      return { index: i, gapPct, prevClose: prev.close, bar: cur };
    }
  }
  return null;
}

// ─── Setup A — Panic Reversal ────────────────────────────────────────────────

const MOVE_LOOKBACK = 5;
const PANIC_DECLINE_PCT = -0.05;

/**
 * Big selloff → stabilisation → reversal. Confirms a CALL.
 *
 * The decline establishes the dislocation; the reclaim is what makes it
 * tradeable. Confirmation here is deliberately strict — close above the PRIOR
 * bar's high, and an up bar — because the cheap-looking wing after a panic is
 * cheap for a reason until the tape says otherwise.
 */
const SETUP_A: SetupTaxonomyDefinition = {
  setupId: 'A',
  label: 'Panic Reversal (selloff → reclaim)',
  minBars: 20,
  evaluate(input: SetupTaxonomyInput): SetupTaxonomyMatch | null {
    const bars = tail(input.series, 30);
    if (bars.length < 10) return null;
    const last = bars[bars.length - 1]!;
    const prev = bars[bars.length - 2]!;

    // 1. the dislocation — a real decline over the window, measured to the LOW
    //    so a sharp intraday flush counts even if it closed off the bottom.
    const windowStart = bars[Math.max(0, bars.length - 1 - MOVE_LOOKBACK)]!;
    const trough = lowestLow(bars, MOVE_LOOKBACK + 1) ?? last.low;
    if (pctChange(windowStart.close, trough) > PANIC_DECLINE_PCT) return null;

    // 2. the confirmation — price has turned, not merely stopped falling.
    const reclaimedPriorHigh = last.close > prev.high;
    const upBar = last.close > last.open;
    const offTheLow = trough > 0 && pctChange(trough, last.close) > 0.01;
    if (!(reclaimedPriorHigh && upBar && offTheLow)) return null;

    return { setupId: 'A', side: 'call', detail: 'selloff_reclaim' };
  },
};

// ─── Setup B — Blow-off Reversal ─────────────────────────────────────────────

const BLOWOFF_RALLY_PCT = 0.05;

/**
 * Big run-up → exhaustion → breakdown. Confirms a PUT.
 *
 * The mirror of A, and the same discipline: an extended stock is not a short.
 * It becomes one when it FAILS — no new high, then a close below the prior
 * bar's low.
 */
const SETUP_B: SetupTaxonomyDefinition = {
  setupId: 'B',
  label: 'Blow-off Reversal (rally → failure)',
  minBars: 20,
  evaluate(input: SetupTaxonomyInput): SetupTaxonomyMatch | null {
    const bars = tail(input.series, 30);
    if (bars.length < 10) return null;
    const last = bars[bars.length - 1]!;
    const prev = bars[bars.length - 2]!;

    const windowStart = bars[Math.max(0, bars.length - 1 - MOVE_LOOKBACK)]!;
    const peak = highestHigh(bars, MOVE_LOOKBACK + 1) ?? last.high;
    if (pctChange(windowStart.close, peak) < BLOWOFF_RALLY_PCT) return null;

    // Exhaustion: the last bar did NOT make the window's high — the advance
    // stopped extending — and then lost the prior bar's low.
    const failedToExtend = last.high < peak;
    const brokeDown = last.close < prev.low;
    const downBar = last.close < last.open;
    if (!(failedToExtend && brokeDown && downBar)) return null;

    return { setupId: 'B', side: 'put', detail: 'rally_failure' };
  },
};

// ─── Setups C & D — Post-Earnings ────────────────────────────────────────────

const GAP_LOOKBACK = 10;
const MIN_GAP_PCT = 0.05;
/** Fraction of the gap that must survive (C) or be surrendered (D). */
const GAP_HOLD_FRACTION = 0.5;

/**
 * Earnings gap + CONTINUATION. Confirms the gap's own side.
 *
 * The drift thesis: a gap driven by a real change in expectations tends to
 * persist. The test is that the market has NOT taken it back — price still
 * holds more than half the gap — and is extending, not merely resting.
 *
 * ⚠ Sessions 1-2 after the gap are deliberately excluded. The initial move is
 * noise plus forced repositioning, and the durable direction is not yet legible.
 */
const SETUP_C: SetupTaxonomyDefinition = {
  setupId: 'C',
  label: 'Post-Earnings Continuation',
  minBars: 25,
  evaluate(input: SetupTaxonomyInput): SetupTaxonomyMatch | null {
    const bars = tail(input.series, 40);
    if (bars.length < 15) return null;
    const gap = findRecentGap(bars, GAP_LOOKBACK, MIN_GAP_PCT);
    if (!gap) return null;

    const barsSince = bars.length - 1 - gap.index;
    if (barsSince < 2) return null; // observation window, not a trade

    const last = bars[bars.length - 1]!;
    const up = gap.gapPct > 0;
    // How much of the gap survives right now.
    const held = up
      ? pctChange(gap.prevClose, last.close) / gap.gapPct
      : pctChange(gap.prevClose, last.close) / gap.gapPct;
    if (!(held >= GAP_HOLD_FRACTION)) return null;

    // Continuation needs the trend to still be working: the last bar closes
    // beyond the midpoint of the post-gap range in the gap's direction.
    const postGap = bars.slice(gap.index);
    const hi = Math.max(...postGap.map((c) => c.high));
    const lo = Math.min(...postGap.map((c) => c.low));
    const mid = (hi + lo) / 2;
    const extending = up ? last.close > mid : last.close < mid;
    if (!extending) return null;

    return { setupId: 'C', side: up ? 'call' : 'put', detail: 'gap_held' };
  },
};

/**
 * Earnings gap + REVERSAL. Confirms the side OPPOSITE the gap.
 *
 * The failed-move thesis: the market priced one thing and the stock did
 * another. The test is that the gap has been substantially FILLED and the
 * event-day extreme has been lost — both, because a half-filled gap that still
 * holds its low is a pullback, not a failure.
 */
const SETUP_D: SetupTaxonomyDefinition = {
  setupId: 'D',
  label: 'Post-Earnings Reversal',
  minBars: 25,
  evaluate(input: SetupTaxonomyInput): SetupTaxonomyMatch | null {
    const bars = tail(input.series, 40);
    if (bars.length < 15) return null;
    const gap = findRecentGap(bars, GAP_LOOKBACK, MIN_GAP_PCT);
    if (!gap) return null;

    const barsSince = bars.length - 1 - gap.index;
    if (barsSince < 2) return null;

    const last = bars[bars.length - 1]!;
    const up = gap.gapPct > 0;
    const held = pctChange(gap.prevClose, last.close) / gap.gapPct;
    // Most of the gap is gone.
    if (held > 1 - GAP_HOLD_FRACTION) return null;

    // ...and the event bar's own extreme has been surrendered.
    const lostExtreme = up ? last.close < gap.bar.low : last.close > gap.bar.high;
    if (!lostExtreme) return null;

    return { setupId: 'D', side: up ? 'put' : 'call', detail: 'gap_failed' };
  },
};

// ─── Setup E — Breakout after consolidation ──────────────────────────────────

const CONSOLIDATION_BARS = 10;
/** Max range of the consolidation, as a fraction of its own midpoint. */
const MAX_CONSOLIDATION_RANGE = 0.08;
const VOLUME_EXPANSION = 1.3;

/**
 * Consolidation → breakout → volatility expansion.
 *
 * The lowest-drama setup, and the one whose failure mode is a false break. Two
 * independent confirmations are required: the close must clear the range (not
 * just the intrabar high — a wick through a level is not a break), and volume
 * must expand, because a breakout nobody participated in is noise.
 *
 * ⛔ EVERY DECLINE PATH HERE IS ATTRIBUTED (TRA-4423). E is the first setup to
 * return {@link SetupTaxonomyDecline} instead of a bare `null`, because on
 * 2026-09-25 it read an honest, dense `matchedSameSide: 0 / reached: 1869` live
 * and that zero was still unreadable — a four-leg conjunction collapsed into one
 * symbol cannot say whether the market was quiet or a threshold is unsatisfiable.
 *
 * ⛔ `no_volume_data` IS SPLIT FROM `volume_not_expanded` ON PURPOSE, and it is
 * the reason this attribution was built. E is the ONLY setup of the five that
 * reads `volume`; `fetchDailyCandles` maps `volume: q.volume ?? 0`, so a provider
 * that answers null volume silently coerces the whole leg to zero and E can
 * NEVER fire — on any symbol, on any day, forever, while looking exactly like an
 * ordinary quiet session. Those two readings must not share a histogram key.
 */
const SETUP_E: SetupTaxonomyDefinition = {
  setupId: 'E',
  label: 'Breakout after consolidation',
  minBars: 30,
  evaluate(input: SetupTaxonomyInput): SetupTaxonomyOutcome {
    const bars = tail(input.series, 40);
    if (bars.length < CONSOLIDATION_BARS + 3) return { setupId: 'E', declinedAt: 'too_few_real_bars' };
    const last = bars[bars.length - 1]!;

    // The consolidation is the window BEFORE the breakout bar.
    const hi = highestHigh(bars, CONSOLIDATION_BARS, 1);
    const lo = lowestLow(bars, CONSOLIDATION_BARS, 1);
    if (hi === null || lo === null) return { setupId: 'E', declinedAt: 'no_range' };
    const mid = (hi + lo) / 2;
    if (!(mid > 0)) return { setupId: 'E', declinedAt: 'bad_midpoint' };
    if ((hi - lo) / mid > MAX_CONSOLIDATION_RANGE) return { setupId: 'E', declinedAt: 'not_coiled' };

    // Volume expansion vs. the consolidation's own average.
    const priorVol = bars.slice(bars.length - 1 - CONSOLIDATION_BARS, bars.length - 1).map((c) => c.volume);
    const avgVol = mean(priorVol);
    // ⛔ Split deliberately — see the header. `no_volume_data` is a FEED fault
    // that makes E structurally unable to fire; `volume_not_expanded` is E
    // working and the market declining to participate.
    if (!(avgVol > 0)) return { setupId: 'E', declinedAt: 'no_volume_data' };
    if (last.volume < avgVol * VOLUME_EXPANSION) {
      return { setupId: 'E', declinedAt: 'volume_not_expanded' };
    }

    // CLOSE beyond the range, not merely a wick.
    if (last.close > hi) return { setupId: 'E', side: 'call', detail: 'range_break_up' };
    if (last.close < lo) return { setupId: 'E', side: 'put', detail: 'range_break_down' };
    return { setupId: 'E', declinedAt: 'no_close_break' };
  },
};

/**
 * A-E, in taxonomy order.
 *
 * ⛔ Importing this does NOT arm anything. The server seam holds the per-setup
 * enable list and passes the subset it wants into `evaluateSetupTaxonomy`.
 */
export const SETUP_DEFINITIONS: readonly SetupTaxonomyDefinition[] = [
  SETUP_A,
  SETUP_B,
  SETUP_C,
  SETUP_D,
  SETUP_E,
] as const;

/** Lookup by id, for the seam's enable list. */
export function setupDefinitionsById(ids: readonly string[]): SetupTaxonomyDefinition[] {
  const wanted = new Set(ids);
  return SETUP_DEFINITIONS.filter((d) => wanted.has(d.setupId));
}
