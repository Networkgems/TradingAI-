import type { Candle } from '@trading-app/shared';

/**
 * TRA-843 — US Opening Candle Box ("opening range box") indicator engine.
 *
 * Reproduces the second strategy the board attached to TRA-843
 * (youtu.be/BlbRke-Fgyk): a session-open range strategy with no indicators,
 * built entirely from ONE candle — the 1-hour US-open candle.
 *
 *   - Draw a box around the US opening hourly candle: its HIGH is the box top
 *     (strongest selling pressure / resistance), its LOW is the box bottom
 *     (aggressive buying / support), and the 50% midline is the decision line
 *     (above = buyers in control, below = sellers).
 *   - The box is only valid AFTER that opening candle closes; the strategy then
 *     trades the bars that follow it (the video works the next ~2 hours).
 *
 * Three structural reads, exactly as the video describes:
 *
 *   1. RANGE fade — price taps a box edge and is rejected back inside while the
 *      box is still intact. Tap the top with an upper rejection wick → short
 *      toward the opposite edge; tap the bottom with a lower wick → long.
 *   2. BREAKOUT retest — price has already CLOSED clean through an edge (do NOT
 *      chase the break). Wait for the pullback to that edge; if it holds with a
 *      rejection wick, enter in the breakout direction. Stop = the FAR side of
 *      the opening box (the video's exact stop rule), target = N box-heights.
 *
 * The engine is pure and deterministic — it depends only on OHLC + the bar
 * timestamp used to locate the opening candle — so every output is golden
 * testable, matching the rest of `indicators/`. It does NOT gate on R:R or
 * regime; that is the strategy layer's job.
 *
 * Timezone: the opening candle is located by matching the bar's UTC wall-clock
 * time against `openHourUtc`/`openMinuteUtc`. Keeping it UTC keeps the engine
 * pure and DST-agnostic — the caller passes the UTC time the session open lands
 * on (e.g. the 09:30 ET equities open is 13:30 UTC under EDT, 14:30 under EST).
 */

export interface OpeningRangeOptions {
  /** UTC hour the session-open candle starts (default 13 — 09:30 ET under EDT). */
  openHourUtc?: number;
  /** UTC minute the session-open candle starts (default 30). */
  openMinuteUtc?: number;
  /**
   * Rejection-wick minimum as a fraction of the candle range for a fade/retest
   * to count as a real rejection (default 0.3).
   */
  minWickFraction?: number;
  /**
   * How close to an edge counts as "tapping"/"retesting" it, as a fraction of
   * box height (default 0.1). Absorbs the small overshoot/undershoot of a wick.
   */
  edgeTolerance?: number;
  /**
   * Breakout target distance, in box heights beyond the broken edge (default 1
   * — the video's minimum "one box" target; raise to 2 or 3 in a strong trend).
   */
  targetBoxMultiple?: number;
}

export const ORB_DEFAULTS = {
  openHourUtc: 13,
  openMinuteUtc: 30,
  minWickFraction: 0.3,
  edgeTolerance: 0.1,
  targetBoxMultiple: 1,
} as const;

export interface OpeningRangeBox {
  /** Timestamp of the opening candle the box was drawn from. */
  openTimestamp: number;
  /** Box top — opening-candle high (resistance). */
  high: number;
  /** Box bottom — opening-candle low (support). */
  low: number;
  /** 50% midline — the decision/bias line. */
  mid: number;
  /** Box height (high − low). */
  height: number;
}

export type OrbSignalType =
  | 'range_short'
  | 'range_long'
  | 'breakout_long'
  | 'breakout_short'
  | 'none';

export interface OrbSignal {
  type: OrbSignalType;
  /** Human-readable rationale (the "why" behind the trade). */
  reason: string;
  /** Suggested entry (latest close), or null on `none`. */
  entry: number | null;
  /** Suggested protective stop, or null on `none`. */
  stop: number | null;
  /** Suggested target, or null on `none`. */
  target: number | null;
  /** reward / risk for the suggested levels, or null on `none`. */
  riskReward: number | null;
  /** The box the read was taken against, or null on `none`. */
  box: OpeningRangeBox | null;
}

const NONE: OrbSignal = {
  type: 'none',
  reason: 'no setup',
  entry: null,
  stop: null,
  target: null,
  riskReward: null,
  box: null,
};

/** True when `c` is the session-open candle for the configured UTC wall time. */
function isOpenCandle(c: Candle, hourUtc: number, minuteUtc: number): boolean {
  const d = new Date(c.timestamp);
  return d.getUTCHours() === hourUtc && d.getUTCMinutes() === minuteUtc;
}

/** Index of the most recent opening candle at or before `end`, or -1. */
function lastOpenCandleIndex(
  candles: Candle[],
  end: number,
  hourUtc: number,
  minuteUtc: number,
): number {
  for (let i = end; i >= 0; i--) {
    if (isOpenCandle(candles[i], hourUtc, minuteUtc)) return i;
  }
  return -1;
}

/**
 * The opening-range box drawn from the most recent US-open candle at or before
 * the latest bar, or null when no opening candle is present or it is degenerate.
 */
export function openingRangeBox(
  candles: Candle[],
  opts: OpeningRangeOptions = {},
): OpeningRangeBox | null {
  if (candles.length === 0) return null;
  const hourUtc = opts.openHourUtc ?? ORB_DEFAULTS.openHourUtc;
  const minuteUtc = opts.openMinuteUtc ?? ORB_DEFAULTS.openMinuteUtc;

  const idx = lastOpenCandleIndex(candles, candles.length - 1, hourUtc, minuteUtc);
  if (idx < 0) return null;

  const oc = candles[idx];
  const height = oc.high - oc.low;
  if (height <= 0) return null;

  return {
    openTimestamp: oc.timestamp,
    high: oc.high,
    low: oc.low,
    mid: (oc.high + oc.low) / 2,
    height,
  };
}

/**
 * Classify the latest bar against the most recent US-open box.
 *
 * Returns `none` until the opening candle has closed and at least one bar has
 * printed after it — the strategy never trades the opening candle itself.
 *
 * Breakout takes priority over a fade on the same edge: once a prior bar has
 * closed clean through an edge, a pullback to that edge is a retest entry, not a
 * fade of intact resistance/support.
 */
export function openingRangeBoxSignal(
  candles: Candle[],
  opts: OpeningRangeOptions = {},
): OrbSignal {
  const hourUtc = opts.openHourUtc ?? ORB_DEFAULTS.openHourUtc;
  const minuteUtc = opts.openMinuteUtc ?? ORB_DEFAULTS.openMinuteUtc;
  const minWick = opts.minWickFraction ?? ORB_DEFAULTS.minWickFraction;
  const edgeTol = opts.edgeTolerance ?? ORB_DEFAULTS.edgeTolerance;
  const mult = opts.targetBoxMultiple ?? ORB_DEFAULTS.targetBoxMultiple;

  if (candles.length < 2) return NONE;
  const last = candles.length - 1;

  const openIdx = lastOpenCandleIndex(candles, last, hourUtc, minuteUtc);
  // Need an opening candle that closed strictly before the bar we are grading.
  if (openIdx < 0 || openIdx >= last) return NONE;

  const oc = candles[openIdx];
  const height = oc.high - oc.low;
  if (height <= 0) return NONE;
  const box: OpeningRangeBox = {
    openTimestamp: oc.timestamp,
    high: oc.high,
    low: oc.low,
    mid: (oc.high + oc.low) / 2,
    height,
  };

  const c = candles[last];
  const range = c.high - c.low;
  if (range <= 0) return NONE;

  const bodyTop = Math.max(c.open, c.close);
  const bodyBottom = Math.min(c.open, c.close);
  const upperWick = c.high - bodyTop;
  const lowerWick = bodyBottom - c.low;
  const tol = edgeTol * height;

  // Did a bar between the open candle and now CLOSE clean through an edge?
  let brokeAbove = false;
  let brokeBelow = false;
  for (let i = openIdx + 1; i < last; i++) {
    if (candles[i].close > box.high) brokeAbove = true;
    if (candles[i].close < box.low) brokeBelow = true;
  }

  // --- Top edge: breakout retest (if already broken) else range fade.
  if (brokeAbove) {
    // Pullback to the box top that holds above it with a lower rejection wick.
    if (c.low <= box.high + tol && c.close > box.high && lowerWick >= minWick * range) {
      const entry = c.close;
      const stop = box.low; // video's rule: stop at the far (bottom) side of the box
      const risk = entry - stop;
      if (risk > 0) {
        const target = entry + mult * height;
        return {
          type: 'breakout_long',
          reason: 'upside breakout retest: closed back above the box top with a rejection wick after a clean break',
          entry,
          stop,
          target,
          riskReward: (target - entry) / risk,
          box,
        };
      }
    }
  } else if (c.high >= box.high - tol && c.close < box.high && upperWick >= minWick * range) {
    // Tapped the top of an intact box and was rejected — fade toward the bottom.
    const entry = c.close;
    const stop = c.high; // above the rejected high
    const target = box.low; // opposite edge
    const risk = stop - entry;
    const reward = entry - target;
    if (risk > 0 && reward > 0) {
      return {
        type: 'range_short',
        reason: 'range fade: tapped the box top and was rejected with an upper wick while the box held',
        entry,
        stop,
        target,
        riskReward: reward / risk,
        box,
      };
    }
  }

  // --- Bottom edge: breakout retest (if already broken) else range fade.
  if (brokeBelow) {
    if (c.high >= box.low - tol && c.close < box.low && upperWick >= minWick * range) {
      const entry = c.close;
      const stop = box.high; // far (top) side of the box
      const risk = stop - entry;
      if (risk > 0) {
        const target = entry - mult * height;
        return {
          type: 'breakout_short',
          reason: 'downside breakout retest: closed back below the box bottom with a rejection wick after a clean break',
          entry,
          stop,
          target,
          riskReward: (entry - target) / risk,
          box,
        };
      }
    }
  } else if (c.low <= box.low + tol && c.close > box.low && lowerWick >= minWick * range) {
    const entry = c.close;
    const stop = c.low; // below the rejected low
    const target = box.high; // opposite edge
    const risk = entry - stop;
    const reward = target - entry;
    if (risk > 0 && reward > 0) {
      return {
        type: 'range_long',
        reason: 'range fade: tapped the box bottom and was rejected with a lower wick while the box held',
        entry,
        stop,
        target,
        riskReward: reward / risk,
        box,
      };
    }
  }

  return NONE;
}
