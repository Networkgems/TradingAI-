import type { Candle } from '@trading-app/shared';

/**
 * TRA-4605 — Anchored VWAP.
 *
 * ## How this differs from session VWAP
 *
 * `VwapTracker` in `./vwap.ts` resets every session and answers "where is the
 * average participant in TODAY's auction". Anchored VWAP never resets: it is
 * pinned to ONE chosen bar — an earnings gap, a major high or low, a news event
 * — and answers a different, more useful swing question:
 *
 *   *Is everyone who has traded since that event underwater or in profit?*
 *
 * That is why the reclaim matters. Price crossing back above an AVWAP anchored
 * to an earnings selloff means the marginal buyer since the event has stopped
 * losing money, which is a supply/demand fact rather than a curve-fitted level.
 *
 * ## Volume is not optional
 *
 * A VWAP computed over bars with zero or missing volume is just a moving
 * average wearing a VWAP label, and it will silently agree with you. Every
 * function here refuses rather than degrades: an anchor window with no traded
 * volume returns `null`. Synthetic gap-filler bars (TRA-427) are flat
 * fabrications carrying zero volume, so they contribute nothing by construction
 * — but they are also excluded explicitly, because "contributes zero" and "is
 * not real data" should not be the same code path.
 *
 * ## Purity
 *
 * Folds over a candle array. No env, no clock, no IO.
 */

export interface AnchoredVwapState {
  /** The volume-weighted average price since the anchor bar, inclusive. */
  readonly vwap: number;
  /** Volume-weighted standard deviation of typical price about the VWAP. */
  readonly stdDev: number;
  readonly upperBand: number;
  readonly lowerBand: number;
  /** Real bars that contributed. */
  readonly bars: number;
  /** Total traded volume since the anchor. */
  readonly volume: number;
  /** Index of the anchor bar in the series passed in. */
  readonly anchorIndex: number;
}

/** Typical price. The same definition `VwapTracker` uses, kept identical on purpose. */
function typicalPrice(c: Candle): number {
  return (c.high + c.low + c.close) / 3;
}

function isReal(c: Candle | undefined): c is Candle {
  return !!c && c.synthetic !== true;
}

/**
 * Anchored VWAP from `anchorIndex` to the end of the series, inclusive.
 *
 * Returns `null` — never a number — when the window is empty, the index is out
 * of range, or no real volume traded. A caller that wants "VWAP or else the
 * close" must say so itself; silently substituting a price here is how an
 * indicator starts lying on illiquid names.
 */
export function anchoredVwap(
  series: readonly Candle[],
  anchorIndex: number,
  bandMultiple = 1.5,
): AnchoredVwapState | null {
  if (!Number.isInteger(anchorIndex)) return null;
  if (anchorIndex < 0 || anchorIndex >= series.length) return null;

  const window = series.slice(anchorIndex).filter(isReal);
  if (window.length === 0) return null;

  let cumulativePV = 0;
  let cumulativeV = 0;
  for (const c of window) {
    if (!(c.volume > 0)) continue;
    cumulativePV += typicalPrice(c) * c.volume;
    cumulativeV += c.volume;
  }
  // No traded volume ⇒ no volume-weighted anything. Refuse.
  if (!(cumulativeV > 0)) return null;

  const vwap = cumulativePV / cumulativeV;

  // Volume-WEIGHTED dispersion. An unweighted standard deviation would let a
  // one-lot print move the bands as much as a block, which defeats the point of
  // using volume at all.
  let weightedSqDev = 0;
  for (const c of window) {
    if (!(c.volume > 0)) continue;
    weightedSqDev += ((typicalPrice(c) - vwap) ** 2) * c.volume;
  }
  const stdDev = Math.sqrt(weightedSqDev / cumulativeV);

  return {
    vwap,
    stdDev,
    upperBand: vwap + stdDev * bandMultiple,
    lowerBand: vwap - stdDev * bandMultiple,
    bars: window.length,
    volume: cumulativeV,
    anchorIndex,
  };
}

/**
 * Anchor to the most recent EVENT GAP — an open that jumps at least
 * `minGapPct` from the prior close — within `lookback` bars.
 *
 * The same gap definition the A-E setup taxonomy uses, so an AVWAP reclaim and
 * a Setup C/D verdict are talking about the same event rather than two nearby
 * ones.
 */
export function anchorIndexAtRecentGap(
  series: readonly Candle[],
  lookback = 30,
  minGapPct = 0.05,
): number | null {
  const start = Math.max(1, series.length - lookback);
  for (let i = series.length - 1; i >= start; i -= 1) {
    const prev = series[i - 1];
    const cur = series[i];
    if (!isReal(prev) || !isReal(cur)) continue;
    if (!(prev.close > 0)) continue;
    const gapPct = (cur.open - prev.close) / prev.close;
    if (Math.abs(gapPct) >= minGapPct) return i;
  }
  return null;
}

/** Anchor to the highest high / lowest low within `lookback` bars. */
export function anchorIndexAtExtreme(
  series: readonly Candle[],
  kind: 'high' | 'low',
  lookback = 60,
): number | null {
  const start = Math.max(0, series.length - lookback);
  let best: number | null = null;
  for (let i = start; i < series.length; i += 1) {
    const c = series[i];
    if (!isReal(c)) continue;
    if (best === null) {
      best = i;
      continue;
    }
    const prev = series[best]!;
    if (kind === 'high' ? c.high > prev.high : c.low < prev.low) best = i;
  }
  return best;
}

export type AvwapReclaimSide = 'call' | 'put';

export interface AvwapReclaimResult {
  readonly side: AvwapReclaimSide;
  readonly state: AnchoredVwapState;
  /** Close of the confirming bar, for the log. */
  readonly close: number;
  /** Whether volume expanded vs. the post-anchor average. */
  readonly volumeExpanded: boolean;
}

/**
 * A CONFIRMED anchored-VWAP reclaim (or loss).
 *
 * The rule this encodes is the one that makes AVWAP a swing trigger rather than
 * a chart decoration:
 *
 *   the prior bar closed on ONE side of the AVWAP and the current bar closed on
 *   the OTHER, with volume expansion.
 *
 * A cross is not a reclaim. Price that has been oscillating around the level
 * produces a "cross" on most bars; requiring a completed close-to-close
 * transition plus participation is what distinguishes the event from the noise.
 *
 * ⚠ Returns `null` while price merely sits near the level, which is the common
 * case and is supposed to be.
 */
export function avwapReclaim(
  series: readonly Candle[],
  anchorIndex: number,
  opts: { volumeExpansion?: number; bandMultiple?: number } = {},
): AvwapReclaimResult | null {
  const volumeExpansion = opts.volumeExpansion ?? 1.2;
  if (series.length < 2) return null;

  const last = series[series.length - 1];
  const prev = series[series.length - 2];
  if (!isReal(last) || !isReal(prev)) return null;
  // The transition must be measurable: the anchor has to precede the pair.
  if (anchorIndex > series.length - 2) return null;

  // The level the PRIOR bar is judged against must not include the current bar,
  // or the bar doing the crossing also moves the line it is crossing.
  const priorState = anchoredVwap(series.slice(0, series.length - 1), anchorIndex, opts.bandMultiple);
  const state = anchoredVwap(series, anchorIndex, opts.bandMultiple);
  if (!priorState || !state) return null;

  const wasBelow = prev.close < priorState.vwap;
  const wasAbove = prev.close > priorState.vwap;
  const isAbove = last.close > state.vwap;
  const isBelow = last.close < state.vwap;

  const postAnchor = series.slice(anchorIndex, series.length - 1).filter(isReal);
  const vols = postAnchor.map((c) => c.volume).filter((v) => v > 0);
  const avgVol = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const volumeExpanded = avgVol > 0 && last.volume >= avgVol * volumeExpansion;
  if (!volumeExpanded) return null;

  if (wasBelow && isAbove) return { side: 'call', state, close: last.close, volumeExpanded };
  if (wasAbove && isBelow) return { side: 'put', state, close: last.close, volumeExpanded };
  return null;
}
