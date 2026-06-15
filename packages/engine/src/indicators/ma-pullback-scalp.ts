import type { Candle } from '@trading-app/shared';
import { emaSeries } from './ma.js';

/**
 * TRA-854 — MA-pullback scalp ("risk vs profitable take-away") indicator engine.
 *
 * Reproduces the strategy the board attached to TRA-854
 * (youtu.be/BihgTI9tq_A): a 20-MA mean-reversion scalp whose entire edge is the
 * TARGET you pick, not the entry. The video's "one number" is 25%.
 *
 * The read, exactly as the video describes it:
 *
 *   1. The 20 moving average reads trend — sloping up = uptrend, down =
 *      downtrend.
 *   2. When price stretches FAR from the MA (a large "price deviation from the
 *      MA"), a pullback back toward the MA becomes highly probable. In a
 *      downtrend that is a bounce up off a stretched low; in an uptrend it is a
 *      fade down off a stretched high.
 *   3. You take that pullback and exit at a FRACTION of the impulse leg. The
 *      win rate is a pure function of how much you try to take — the video's
 *      back-test of the NASDAQ:
 *
 *         retracement target   reaches it
 *              25%                9 / 10   (90%)
 *              50%                6 / 10   (60%)
 *              75%                2 / 10   (20%)
 *             100%               1 / 10   (10%)
 *
 *      So "take 25%" is a ~90% win-rate scalp; chasing 75–100% is a 10–20%
 *      lottery that bleeds the account. Secure the 25% first; 50% is a
 *      reasonable runner because it still comes 6/10.
 *   4. The exception that flips the trade: when a bounce breaks past ~75% and
 *      then FAILS to make a new extreme, the trend may be reversing. The quick
 *      scalp is off — the prior structure extreme becomes the stop and you take
 *      a swing trade for R multiples (the video's 1R/2R/3R, up to 5R).
 *
 * The engine is pure and deterministic — it depends only on OHLC — so every
 * output is golden testable, matching the rest of `indicators/`. It reports the
 * full target ladder (price + probability for each tier) so the strategy layer
 * can size the take-profit; it does NOT gate on R:R or regime itself.
 */

export type MaType = 'sma' | 'ema';

export interface PullbackScalpOptions {
  /** Moving-average period that reads trend and stretch (default 20). */
  maPeriod?: number;
  /** Moving-average type — the video's plain MA defaults to 'sma'. */
  maType?: MaType;
  /** Bars used to read the MA slope for trend direction (default 5). */
  slopeLookback?: number;
  /** Window (bars) the impulse leg is searched within (default 20). */
  swingLookback?: number;
  /**
   * Minimum stretch of the impulse extreme beyond the MA, as a fraction of the
   * MA, for the move to count as "far from the MA" (default 0.002 = 0.2%).
   */
  minDeviationPct?: number;
  /**
   * The scalp take-profit as a fraction of the impulse leg — the video's "one
   * number" (default 0.25). Drives the primary target and its win probability.
   */
  scalpTarget?: number;
  /**
   * Retracement past which the scalp is abandoned and the move is read as a
   * possible trend reversal / swing setup (default 0.75).
   */
  reversalThreshold?: number;
  /** Reward:risk for the reversal swing target, in R (default 3 — the video's 3:1). */
  swingRiskReward?: number;
}

export const SCALP_DEFAULTS = {
  maPeriod: 20,
  maType: 'sma' as MaType,
  slopeLookback: 5,
  swingLookback: 20,
  minDeviationPct: 0.002,
  scalpTarget: 0.25,
  reversalThreshold: 0.75,
  swingRiskReward: 3,
} as const;

/** The video's back-tested NASDAQ retracement → reach-probability ladder. */
export const SCALP_TIERS: ReadonlyArray<{ retracement: number; probability: number }> = [
  { retracement: 0.25, probability: 0.9 },
  { retracement: 0.5, probability: 0.6 },
  { retracement: 0.75, probability: 0.2 },
  { retracement: 1.0, probability: 0.1 },
];

/**
 * Probability that price reaches a given retracement target, per the video's
 * ladder. Flat at 0.90 below 0.25 and 0.10 above 1.0; linearly interpolated
 * between the four tiers in between.
 */
export function retracementWinRate(target: number): number {
  if (target <= SCALP_TIERS[0].retracement) return SCALP_TIERS[0].probability;
  const lastTier = SCALP_TIERS[SCALP_TIERS.length - 1];
  if (target >= lastTier.retracement) return lastTier.probability;
  for (let i = 1; i < SCALP_TIERS.length; i++) {
    const hi = SCALP_TIERS[i];
    const lo = SCALP_TIERS[i - 1];
    if (target <= hi.retracement) {
      const f = (target - lo.retracement) / (hi.retracement - lo.retracement);
      return lo.probability + f * (hi.probability - lo.probability);
    }
  }
  return lastTier.probability;
}

export type ScalpSetup =
  | 'scalp_long'
  | 'scalp_short'
  | 'reversal_long'
  | 'reversal_short'
  | 'none';

export interface RetracementLevel {
  /** Retracement fraction of the impulse (0.25, 0.50, 0.75, 1.00). */
  retracement: number;
  /** Probability price reaches this level, per the video's ladder. */
  probability: number;
  /** The actual price for this retracement of the current impulse leg. */
  price: number;
}

export interface PullbackScalpSignal {
  setup: ScalpSetup;
  /** Human-readable rationale (the "why" behind the trade). */
  reason: string;
  /** MA-slope trend read at the latest bar. */
  trend: 'up' | 'down' | 'flat';
  /** Latest moving-average value, or null when insufficient data. */
  ma: number | null;
  /** Stretch of the impulse extreme beyond the MA, as a fraction of the MA. */
  deviationPct: number | null;
  /** Impulse-leg high, or null when no valid impulse. */
  impulseHigh: number | null;
  /** Impulse-leg low, or null when no valid impulse. */
  impulseLow: number | null;
  /** How far the pullback/bounce has retraced the impulse so far (fraction). */
  retracement: number | null;
  /** Suggested entry (latest close), or null on `none`. */
  entry: number | null;
  /** Suggested protective stop, or null on `none`. */
  stop: number | null;
  /** Suggested primary target — the scalp's 25% level, or R-based on reversal. */
  target: number | null;
  /** reward / risk for the suggested levels, or null on `none`. */
  riskReward: number | null;
  /** Probability the primary target is reached, or null when R-based/none. */
  winProbability: number | null;
  /** The full target ladder priced against the current impulse, or [] on none. */
  tiers: RetracementLevel[];
}

const NONE: PullbackScalpSignal = {
  setup: 'none',
  reason: 'no setup',
  trend: 'flat',
  ma: null,
  deviationPct: null,
  impulseHigh: null,
  impulseLow: null,
  retracement: null,
  entry: null,
  stop: null,
  target: null,
  riskReward: null,
  winProbability: null,
  tiers: [],
};

/** Simple-moving-average series; first `period − 1` entries are NaN. */
function smaSeries(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (period <= 0 || closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function maSeriesOf(closes: number[], period: number, type: MaType): number[] {
  return type === 'ema' ? emaSeries(closes, period) : smaSeries(closes, period);
}

/**
 * Classify the latest bar as an MA-pullback scalp, a reversal swing, or none.
 *
 * Returns `none` until there are enough bars to read the MA and its slope, and
 * whenever no impulse leg is stretched far enough from the MA to expect a
 * pullback. When an impulse is present the structural fields (`ma`, `impulse*`,
 * `retracement`, `tiers`) are populated even if no actionable trade is offered,
 * so the caller can still see the read.
 */
export function maPullbackScalp(
  candles: Candle[],
  opts: PullbackScalpOptions = {},
): PullbackScalpSignal {
  const maPeriod = opts.maPeriod ?? SCALP_DEFAULTS.maPeriod;
  const maType = opts.maType ?? SCALP_DEFAULTS.maType;
  const slopeLookback = opts.slopeLookback ?? SCALP_DEFAULTS.slopeLookback;
  const swingLookback = opts.swingLookback ?? SCALP_DEFAULTS.swingLookback;
  const minDeviationPct = opts.minDeviationPct ?? SCALP_DEFAULTS.minDeviationPct;
  const scalpTarget = opts.scalpTarget ?? SCALP_DEFAULTS.scalpTarget;
  const reversalThreshold = opts.reversalThreshold ?? SCALP_DEFAULTS.reversalThreshold;
  const swingRR = opts.swingRiskReward ?? SCALP_DEFAULTS.swingRiskReward;

  const last = candles.length - 1;
  if (last < maPeriod + slopeLookback - 1) return NONE;

  const closes = candles.map((c) => c.close);
  const ma = maSeriesOf(closes, maPeriod, maType);
  const maNow = ma[last];
  const maPrev = ma[last - slopeLookback];
  if (!Number.isFinite(maNow) || !Number.isFinite(maPrev) || maPrev === 0) return NONE;

  const slope = (maNow - maPrev) / maPrev;
  const trend: 'up' | 'down' | 'flat' = slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat';
  if (trend === 'flat') {
    return { ...NONE, trend, ma: maNow, reason: 'flat MA — no trend to fade a pullback in' };
  }

  const start = Math.max(0, last - swingLookback + 1);
  const c = candles[last];
  const entry = c.close;

  if (trend === 'down') {
    // Drop impulse: a stretched low after a prior high, then a bounce up.
    let iLow = start;
    for (let i = start; i <= last; i++) if (candles[i].low < candles[iLow].low) iLow = i;
    if (iLow <= start) return { ...NONE, trend, ma: maNow, reason: 'no completed drop impulse in window' };

    let impulseHigh = candles[start].high;
    for (let i = start; i <= iLow; i++) if (candles[i].high > impulseHigh) impulseHigh = candles[i].high;
    const impulseLow = candles[iLow].low;
    const impulse = impulseHigh - impulseLow;
    if (impulse <= 0) return { ...NONE, trend, ma: maNow, reason: 'degenerate drop impulse' };

    const maAtLow = ma[iLow];
    const deviationPct = Number.isFinite(maAtLow) ? (maAtLow - impulseLow) / maAtLow : 0;
    if (deviationPct < minDeviationPct) {
      return {
        ...NONE,
        trend,
        ma: maNow,
        impulseHigh,
        impulseLow,
        deviationPct,
        reason: 'drop not stretched far enough below the MA to expect a bounce',
      };
    }

    const retracement = (entry - impulseLow) / impulse;
    const tiers: RetracementLevel[] = SCALP_TIERS.map((t) => ({
      retracement: t.retracement,
      probability: t.probability,
      price: impulseLow + t.retracement * impulse,
    }));
    const base = {
      trend,
      ma: maNow,
      deviationPct,
      impulseHigh,
      impulseLow,
      retracement,
      tiers,
    };

    if (retracement >= reversalThreshold) {
      // Bounce ran past the reversal line — read it as a swing long, not a scalp.
      const stop = impulseLow;
      const risk = entry - stop;
      if (risk > 0) {
        return {
          ...base,
          setup: 'reversal_long',
          reason: `bounce retraced ${(retracement * 100).toFixed(0)}% (> ${(reversalThreshold * 100).toFixed(0)}%) — possible reversal; swing long off the structure low for ${swingRR}R`,
          entry,
          stop,
          target: entry + swingRR * risk,
          riskReward: swingRR,
          winProbability: null,
        };
      }
    } else {
      // Counter-trend scalp long: take the bounce to the 25% level.
      const target = impulseLow + scalpTarget * impulse;
      const stop = impulseLow;
      const risk = entry - stop;
      const reward = target - entry;
      if (risk > 0 && reward > 0) {
        return {
          ...base,
          setup: 'scalp_long',
          reason: `stretched ${(deviationPct * 100).toFixed(2)}% below the 20 MA in a downtrend — scalp the bounce to the ${(scalpTarget * 100).toFixed(0)}% retracement (~${(retracementWinRate(scalpTarget) * 100).toFixed(0)}% win rate)`,
          entry,
          stop,
          target,
          riskReward: reward / risk,
          winProbability: retracementWinRate(scalpTarget),
        };
      }
    }

    return {
      ...base,
      ...{ setup: 'none' as ScalpSetup },
      reason:
        retracement >= scalpTarget
          ? `bounce already past the ${(scalpTarget * 100).toFixed(0)}% target and below the reversal line — no fresh scalp`
          : 'no actionable scalp (risk/reward not positive)',
      entry: null,
      stop: null,
      target: null,
      riskReward: null,
      winProbability: null,
    };
  }

  // trend === 'up' — Rise impulse: a stretched high after a prior low, then a fade.
  let iHigh = start;
  for (let i = start; i <= last; i++) if (candles[i].high > candles[iHigh].high) iHigh = i;
  if (iHigh <= start) return { ...NONE, trend, ma: maNow, reason: 'no completed rise impulse in window' };

  let impulseLow = candles[start].low;
  for (let i = start; i <= iHigh; i++) if (candles[i].low < impulseLow) impulseLow = candles[i].low;
  const impulseHigh = candles[iHigh].high;
  const impulse = impulseHigh - impulseLow;
  if (impulse <= 0) return { ...NONE, trend, ma: maNow, reason: 'degenerate rise impulse' };

  const maAtHigh = ma[iHigh];
  const deviationPct = Number.isFinite(maAtHigh) ? (impulseHigh - maAtHigh) / maAtHigh : 0;
  if (deviationPct < minDeviationPct) {
    return {
      ...NONE,
      trend,
      ma: maNow,
      impulseHigh,
      impulseLow,
      deviationPct,
      reason: 'rise not stretched far enough above the MA to expect a fade',
    };
  }

  const retracement = (impulseHigh - entry) / impulse;
  const tiers: RetracementLevel[] = SCALP_TIERS.map((t) => ({
    retracement: t.retracement,
    probability: t.probability,
    price: impulseHigh - t.retracement * impulse,
  }));
  const base = {
    trend,
    ma: maNow,
    deviationPct,
    impulseHigh,
    impulseLow,
    retracement,
    tiers,
  };

  if (retracement >= reversalThreshold) {
    const stop = impulseHigh;
    const risk = stop - entry;
    if (risk > 0) {
      return {
        ...base,
        setup: 'reversal_short',
        reason: `fade retraced ${(retracement * 100).toFixed(0)}% (> ${(reversalThreshold * 100).toFixed(0)}%) — possible reversal; swing short off the structure high for ${swingRR}R`,
        entry,
        stop,
        target: entry - swingRR * risk,
        riskReward: swingRR,
        winProbability: null,
      };
    }
  } else {
    const target = impulseHigh - scalpTarget * impulse;
    const stop = impulseHigh;
    const risk = stop - entry;
    const reward = entry - target;
    if (risk > 0 && reward > 0) {
      return {
        ...base,
        setup: 'scalp_short',
        reason: `stretched ${(deviationPct * 100).toFixed(2)}% above the 20 MA in an uptrend — scalp the fade to the ${(scalpTarget * 100).toFixed(0)}% retracement (~${(retracementWinRate(scalpTarget) * 100).toFixed(0)}% win rate)`,
        entry,
        stop,
        target,
        riskReward: reward / risk,
        winProbability: retracementWinRate(scalpTarget),
      };
    }
  }

  return {
    ...base,
    ...{ setup: 'none' as ScalpSetup },
    reason:
      retracement >= scalpTarget
        ? `fade already past the ${(scalpTarget * 100).toFixed(0)}% target and below the reversal line — no fresh scalp`
        : 'no actionable scalp (risk/reward not positive)',
    entry: null,
    stop: null,
    target: null,
    riskReward: null,
    winProbability: null,
  };
}
