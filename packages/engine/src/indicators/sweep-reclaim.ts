import type { Candle } from '@trading-app/shared';
import { atr } from './atr.js';
import { findSwings, type SwingPoint } from './support-resistance.js';

/**
 * Liquidity SWEEP-AND-RECLAIM detector (the "fake-out" price-action trigger).
 *
 * Long: price wicks BELOW a confirmed support zone on bar t, then CLOSES back
 * above the zone's lower edge, in the upper part of the bar's range. Short is
 * the mirror at a resistance zone. The claim behind it is that stops resting
 * under an obvious level get run and the breakout sellers are trapped.
 *
 * ── LOOKAHEAD DISCIPLINE (the whole reason this is its own module) ─────────
 * A fractal pivot at index i is only KNOWN at bar i + lookback, because the
 * definition needs `lookback` bars on its right. `supportResistance()` runs
 * over the whole input and is meant for the last bar of a live series; fed a
 * historical prefix it is fine, but a backtest that computes swings ONCE over
 * the full series and then reads zones at bar t sees pivots from the future.
 * This module only ever uses pivots with `index + lookback <= t - 1` (confirmed
 * strictly before the signal bar), and {@link detectSweepReclaimSeries} computes
 * swings once and applies that filter per bar, so the series form and the
 * single-bar form agree exactly (pinned by a test).
 *
 * Pure, deterministic, no I/O, no capital path.
 */

export interface SweepReclaimOptions {
  /** Fractal half-width for swing pivots (bars each side). */
  pivotLookback?: number;
  /** Only pivots within this many bars before t form zones. */
  zoneLookbackBars?: number;
  /** Pivots within this fraction of price cluster into one zone. */
  clusterPct?: number;
  /** A zone needs at least this many pivots to count as "key". */
  minTouches?: number;
  atrPeriod?: number;
  /** The wick must pierce the zone edge by at least this many ATR. */
  minSweepAtr?: number;
  /** ...and by at most this many ATR (deeper is a breakdown, not a sweep). */
  maxSweepAtr?: number;
  /** Close location in the bar's range: (close−low)/(high−low) for longs. */
  minCloseLocation?: number;
  /** Stop sits this many ATR beyond the sweep extreme. */
  stopAtrBuffer?: number;
  /** Fallback target in R when no opposing zone exists. */
  fallbackTargetR?: number;
  /**
   * `sma200`: longs only when close > SMA(200), shorts only when below.
   * `none`: both sides always allowed.
   */
  trendFilter?: 'none' | 'sma200';
  /** Which sides to emit. */
  sides?: 'both' | 'long' | 'short';
}

export const SWEEP_RECLAIM_DEFAULTS: Required<SweepReclaimOptions> = Object.freeze({
  pivotLookback: 5,
  zoneLookbackBars: 180,
  clusterPct: 0.01,
  minTouches: 2,
  atrPeriod: 14,
  minSweepAtr: 0.1,
  maxSweepAtr: 1.5,
  minCloseLocation: 0.5,
  stopAtrBuffer: 0.25,
  fallbackTargetR: 2,
  trendFilter: 'none',
  sides: 'both',
});

export interface SweepZone {
  level: number;
  lower: number;
  upper: number;
  touches: number;
}

export interface SweepReclaimSignal {
  index: number;
  timestamp: number;
  side: 'long' | 'short';
  zone: SweepZone;
  /** How far the wick pierced the zone edge, in ATR. */
  sweepDepthAtr: number;
  closeLocation: number;
  atr: number;
  /** Reference entry = signal bar close (a backtest should fill at the NEXT open). */
  entryRef: number;
  stop: number;
  target: number;
  /** Whether `target` came from an opposing zone or the R fallback. */
  targetSource: 'zone' | 'fallback_r';
  riskReward: number;
}

function clusterZones(pivots: SwingPoint[], refPrice: number, clusterPct: number): SweepZone[] {
  if (pivots.length === 0) return [];
  const tol = Math.max(refPrice * clusterPct, 1e-9);
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: SwingPoint[][] = [];
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && p.price - last[last.length - 1].price <= tol) last.push(p);
    else clusters.push([p]);
  }
  return clusters.map((m) => ({
    lower: m[0].price,
    upper: m[m.length - 1].price,
    level: m.reduce((a, x) => a + x.price, 0) / m.length,
    touches: m.length,
  }));
}

function sma(candles: Candle[], end: number, period: number): number | null {
  if (end + 1 < period) return null;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) s += candles[i].close;
  return s / period;
}

/** Evaluate bar `t` given precomputed swings over (at least) candles[0..t]. */
function evaluateAt(
  candles: Candle[],
  t: number,
  swings: SwingPoint[],
  o: Required<SweepReclaimOptions>,
): SweepReclaimSignal | null {
  if (t < 1) return null;
  const bar = candles[t];
  const prev = candles[t - 1];
  const range = bar.high - bar.low;
  if (!(range > 0)) return null;
  const a = atr(candles.slice(Math.max(0, t - o.atrPeriod - 1), t + 1), o.atrPeriod);
  if (a === null || !(a > 0)) return null;

  const confirmedBy = t - 1 - o.pivotLookback; // pivot index must be <= this
  const oldest = t - o.zoneLookbackBars;
  const usable = swings.filter((s) => s.index <= confirmedBy && s.index >= oldest);
  const lows = usable.filter((s) => s.kind === 'low');
  const highs = usable.filter((s) => s.kind === 'high');

  const trend = o.trendFilter === 'sma200' ? sma(candles, t, 200) : null;
  if (o.trendFilter === 'sma200' && trend === null) return null;

  const supports = clusterZones(lows, prev.close, o.clusterPct).filter(
    (z) => z.touches >= o.minTouches && z.lower < prev.close,
  );
  const resistances = clusterZones(highs, prev.close, o.clusterPct).filter(
    (z) => z.touches >= o.minTouches && z.upper > prev.close,
  );

  const candidates: SweepReclaimSignal[] = [];

  if (o.sides !== 'short' && (trend === null || bar.close > trend)) {
    const closeLoc = (bar.close - bar.low) / range;
    for (const z of supports) {
      const depth = (z.lower - bar.low) / a;
      if (depth < o.minSweepAtr || depth > o.maxSweepAtr) continue;
      if (!(bar.close > z.lower) || closeLoc < o.minCloseLocation) continue;
      const stop = bar.low - o.stopAtrBuffer * a;
      const risk = bar.close - stop;
      if (!(risk > 0)) continue;
      const above = resistances.filter((r) => r.lower > bar.close).sort((x, y) => x.lower - y.lower)[0];
      const zoneTarget = above ? above.lower : null;
      const target = zoneTarget ?? bar.close + o.fallbackTargetR * risk;
      candidates.push({
        index: t,
        timestamp: bar.timestamp,
        side: 'long',
        zone: z,
        sweepDepthAtr: depth,
        closeLocation: closeLoc,
        atr: a,
        entryRef: bar.close,
        stop,
        target,
        targetSource: zoneTarget !== null ? 'zone' : 'fallback_r',
        riskReward: (target - bar.close) / risk,
      });
    }
  }

  if (o.sides !== 'long' && (trend === null || bar.close < trend)) {
    const closeLoc = (bar.high - bar.close) / range;
    for (const z of resistances) {
      const depth = (bar.high - z.upper) / a;
      if (depth < o.minSweepAtr || depth > o.maxSweepAtr) continue;
      if (!(bar.close < z.upper) || closeLoc < o.minCloseLocation) continue;
      const stop = bar.high + o.stopAtrBuffer * a;
      const risk = stop - bar.close;
      if (!(risk > 0)) continue;
      const below = supports.filter((s) => s.upper < bar.close).sort((x, y) => y.upper - x.upper)[0];
      const zoneTarget = below ? below.upper : null;
      const target = zoneTarget ?? bar.close - o.fallbackTargetR * risk;
      candidates.push({
        index: t,
        timestamp: bar.timestamp,
        side: 'short',
        zone: z,
        sweepDepthAtr: depth,
        closeLocation: closeLoc,
        atr: a,
        entryRef: bar.close,
        stop,
        target,
        targetSource: zoneTarget !== null ? 'zone' : 'fallback_r',
        riskReward: (bar.close - target) / risk,
      });
    }
  }

  if (candidates.length === 0) return null;
  // One signal per bar: the most-touched zone, then the shallowest sweep.
  candidates.sort((x, y) => y.zone.touches - x.zone.touches || x.sweepDepthAtr - y.sweepDepthAtr);
  return candidates[0];
}

/**
 * Sweep-and-reclaim on the LAST bar of `candles`. Safe on a live series: only
 * pivots confirmed before the last bar are used.
 */
export function detectSweepReclaim(
  candles: Candle[],
  opts: SweepReclaimOptions = {},
): SweepReclaimSignal | null {
  const o = { ...SWEEP_RECLAIM_DEFAULTS, ...opts };
  if (candles.length === 0) return null;
  return evaluateAt(candles, candles.length - 1, findSwings(candles, o.pivotLookback), o);
}

/**
 * Every bar's signal over a historical series, lookahead-safe. Swings are
 * computed once over the full series; each bar only reads pivots that were
 * confirmed before it, so the result equals calling {@link detectSweepReclaim}
 * on each prefix.
 */
export function detectSweepReclaimSeries(
  candles: Candle[],
  opts: SweepReclaimOptions = {},
): SweepReclaimSignal[] {
  const o = { ...SWEEP_RECLAIM_DEFAULTS, ...opts };
  const swings = findSwings(candles, o.pivotLookback);
  const out: SweepReclaimSignal[] = [];
  for (let t = 1; t < candles.length; t++) {
    const s = evaluateAt(candles, t, swings, o);
    if (s) out.push(s);
  }
  return out;
}
