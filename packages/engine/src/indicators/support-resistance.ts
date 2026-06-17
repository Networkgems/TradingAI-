import type { Candle } from '@trading-app/shared';
import { atr } from './atr.js';
import { detectPattern, isBullishPattern, isBearishPattern } from './patterns.js';
import type { CandlePattern } from './patterns.js';

/**
 * Swing-based support/resistance levels and a reversal-confluence checklist.
 *
 * Today the agents derive "support/resistance" from a flat 20-bar min/max,
 * which is just the extremes of a window — it neither survives a level being
 * tested repeatedly nor tells us how *recently* price reacted there. This
 * module instead finds swing pivots (fractals), clusters repeated pivots into
 * touch-counted zones, and scores a price's proximity to a real zone.
 *
 * On top of the zones it implements the discretionary "reversal off a key
 * level" checklist the desk has been building toward (see opening-range-box):
 * a trade is only interesting when price reaches a key zone, the trend *into*
 * the zone has broken, the move in was fast/over-extended ("unhealthy"), and a
 * candlestick reversal prints in the trade direction. Each leg is a boolean so
 * the score is auditable rather than a black-box float.
 *
 * Pure, deterministic decision logic — no I/O, no capital path. Intended for
 * the shadow pipeline and for feeding the option strategy selector richer
 * level context than a raw window min/max.
 */

export interface SwingPoint {
  /** Index of the pivot bar within the input series. */
  index: number;
  timestamp: number;
  price: number;
  kind: 'high' | 'low';
}

export interface SrZone {
  /** Whether the zone sits below (support) or above (resistance) the reference price. */
  kind: 'support' | 'resistance';
  /** Touch-weighted representative price for the zone. */
  level: number;
  /** Lower edge of the zone band. */
  lower: number;
  /** Upper edge of the zone band. */
  upper: number;
  /** Number of swing pivots that formed the zone — a proxy for how "key" it is. */
  touches: number;
  /** Index of the most recent pivot that touched the zone (recency). */
  lastTouchIndex: number;
}

export interface SrLevels {
  zones: SrZone[];
  /** Nearest zone at or below the reference price. */
  support: SrZone | null;
  /** Nearest zone at or above the reference price. */
  resistance: SrZone | null;
}

export interface SwingOptions {
  /** Bars on each side a pivot must dominate to qualify (fractal half-width). */
  lookback?: number;
  /**
   * Cluster tolerance as a fraction of price — pivots within this band of each
   * other collapse into one zone. Defaults to 0.4% of the reference price.
   */
  clusterPct?: number;
}

const DEFAULT_LOOKBACK = 3;
const DEFAULT_CLUSTER_PCT = 0.004;

/**
 * Find confirmed swing pivots. A swing high at bar i has the strictly highest
 * high over [i-lookback, i+lookback]; a swing low has the strictly lowest low.
 * The final `lookback` bars can never be pivots (not yet confirmed), which is
 * what keeps a level from being a tautology of the current bar.
 */
export function findSwings(candles: Candle[], lookback = DEFAULT_LOOKBACK): SwingPoint[] {
  if (lookback < 1) return [];
  const out: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) out.push({ index: i, timestamp: c.timestamp, price: c.high, kind: 'high' });
    if (isLow) out.push({ index: i, timestamp: c.timestamp, price: c.low, kind: 'low' });
  }
  return out;
}

/**
 * Cluster swing pivots into support/resistance zones relative to a reference
 * price (defaults to the last close). Zones below the reference are support,
 * zones above are resistance; a level straddling the price is dropped.
 */
export function supportResistance(
  candles: Candle[],
  opts: SwingOptions = {},
): SrLevels {
  const empty: SrLevels = { zones: [], support: null, resistance: null };
  if (candles.length === 0) return empty;

  const lookback = opts.lookback ?? DEFAULT_LOOKBACK;
  const ref = candles[candles.length - 1].close;
  const clusterPct = opts.clusterPct ?? DEFAULT_CLUSTER_PCT;
  const tol = Math.max(ref * clusterPct, 1e-9);

  const swings = findSwings(candles, lookback);
  if (swings.length === 0) return empty;

  // Greedy cluster by price proximity.
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters: SwingPoint[][] = [];
  for (const s of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && s.price - last[last.length - 1].price <= tol) {
      last.push(s);
    } else {
      clusters.push([s]);
    }
  }

  const zones: SrZone[] = clusters.map((members) => {
    const lower = members[0].price;
    const upper = members[members.length - 1].price;
    const level = members.reduce((acc, m) => acc + m.price, 0) / members.length;
    const lastTouchIndex = members.reduce((acc, m) => Math.max(acc, m.index), 0);
    const kind: SrZone['kind'] = level <= ref ? 'support' : 'resistance';
    return { kind, level, lower, upper, touches: members.length, lastTouchIndex };
  });

  let support: SrZone | null = null;
  let resistance: SrZone | null = null;
  for (const z of zones) {
    if (z.level <= ref) {
      if (!support || z.level > support.level) support = z;
    } else {
      if (!resistance || z.level < resistance.level) resistance = z;
    }
  }

  return { zones, support, resistance };
}

export interface ReversalOptions extends SwingOptions {
  /** ATR period for distance/extension measurement. */
  atrPeriod?: number;
  /** How close (in ATR) price must be to a zone to count as "at the level". */
  proximityAtr?: number;
  /** Number of bars treated as the approach leg into the level. */
  legBars?: number;
  /** Approach-leg net move (in ATR) required to call it an "unhealthy" move. */
  unhealthyAtr?: number;
  /** Fraction of the target multiple R used when no opposing zone is in range. */
  targetRMultiple?: number;
}

export interface ReversalChecklist {
  side: 'long' | 'short' | null;
  /** The zone price is reacting off, if any. */
  zone: SrZone | null;
  /** Price is within `proximityAtr` of a key zone. */
  atKeyLevel: boolean;
  /** The trend *into* the level has broken (bullish reclaim at support / bearish rejection at resistance). */
  trendBreak: boolean;
  /** The approach into the level was a fast, over-extended move. */
  unhealthyMove: boolean;
  /** Reversal candlestick in the trade direction, if present. */
  pattern: CandlePattern | null;
  /** Count of satisfied checklist legs (0–4). */
  score: number;
  /** True once all four legs line up — the desk's "rinse and repeat" entry. */
  confirmed: boolean;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
}

const NO_SETUP: ReversalChecklist = {
  side: null,
  zone: null,
  atKeyLevel: false,
  trendBreak: false,
  unhealthyMove: false,
  pattern: null,
  score: 0,
  confirmed: false,
  entry: null,
  stop: null,
  target: null,
  riskReward: null,
};

/**
 * Score the "reversal off a key level" checklist for the latest bar.
 *
 * The checklist mirrors the desk playbook: (1) price is at a key swing zone,
 * (2) the trend into that zone has broken, (3) the move into it was unhealthy
 * (fast and over-extended), and (4) a reversal candlestick confirms. All four
 * legs lining up sets `confirmed`; `score` exposes partial confluence so the
 * shadow pipeline can study how often N-of-4 setups actually resolve.
 *
 * Entry is on the side that bets the reversal; the stop sits just beyond the
 * zone, and the target is the opposing zone (or an R-multiple fallback).
 */
export function reversalChecklist(
  candles: Candle[],
  opts: ReversalOptions = {},
): ReversalChecklist {
  const atrPeriod = opts.atrPeriod ?? 14;
  const legBars = opts.legBars ?? 5;
  const proximityAtr = opts.proximityAtr ?? 0.75;
  const unhealthyAtr = opts.unhealthyAtr ?? 3;
  const targetRMultiple = opts.targetRMultiple ?? 2;

  if (candles.length < legBars + 2) return NO_SETUP;
  const a = atr(candles, atrPeriod);
  if (a === null || a <= 0) return NO_SETUP;

  const levels = supportResistance(candles, opts);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // Decide which zone we are reacting off: whichever of nearest support /
  // resistance the current bar's range is closest to.
  const dSup = levels.support ? Math.abs(last.close - levels.support.level) : Infinity;
  const dRes = levels.resistance ? Math.abs(last.close - levels.resistance.level) : Infinity;
  const useSupport = dSup <= dRes;
  const zone = useSupport ? levels.support : levels.resistance;
  if (!zone) return NO_SETUP;

  const side: 'long' | 'short' = useSupport ? 'long' : 'short';
  const distance = Math.abs(last.close - zone.level);
  const atKeyLevel = distance <= proximityAtr * a;

  // Approach leg: the `legBars` bars ending just before the current bar.
  const legStart = candles.length - 1 - legBars;
  const leg = candles.slice(legStart, candles.length - 1);
  const legHigh = Math.max(...leg.map((c) => c.high));
  const legLow = Math.min(...leg.map((c) => c.low));

  // Unhealthy = the leg covered a large distance fast and mostly one-directional.
  const downBars = leg.filter((c) => c.close < c.open).length;
  const upBars = leg.filter((c) => c.close > c.open).length;
  let unhealthyMove = false;
  if (side === 'long') {
    const drop = legHigh - legLow;
    unhealthyMove = drop >= unhealthyAtr * a && downBars >= Math.ceil(leg.length * 0.6);
  } else {
    const rip = legHigh - legLow;
    unhealthyMove = rip >= unhealthyAtr * a && upBars >= Math.ceil(leg.length * 0.6);
  }

  // Trend break: a reclaim of the prior bar's extreme against the approach.
  const trendBreak =
    side === 'long' ? last.close > prev.high : last.close < prev.low;

  // Reversal candlestick in the trade direction.
  const raw = detectPattern(candles);
  const pattern =
    side === 'long'
      ? isBullishPattern(raw) ? raw : null
      : isBearishPattern(raw) ? raw : null;

  const score =
    (atKeyLevel ? 1 : 0) +
    (trendBreak ? 1 : 0) +
    (unhealthyMove ? 1 : 0) +
    (pattern ? 1 : 0);
  const confirmed = score === 4;

  // Bracket: enter on a break of the current bar, stop just beyond the zone,
  // target the opposing zone (or an R-multiple fallback).
  let entry: number | null = null;
  let stop: number | null = null;
  let target: number | null = null;
  let riskReward: number | null = null;
  if (atKeyLevel) {
    if (side === 'long') {
      entry = last.high;
      stop = Math.min(zone.lower, legLow) - 0.1 * a;
      const opp = levels.resistance && levels.resistance.level > entry ? levels.resistance.level : null;
      const risk = entry - stop;
      target = opp ?? entry + targetRMultiple * risk;
    } else {
      entry = last.low;
      stop = Math.max(zone.upper, legHigh) + 0.1 * a;
      const opp = levels.support && levels.support.level < entry ? levels.support.level : null;
      const risk = stop - entry;
      target = opp ?? entry - targetRMultiple * risk;
    }
    const risk = side === 'long' ? entry - stop : stop - entry;
    const reward = side === 'long' ? target - entry : entry - target;
    riskReward = risk > 0 ? reward / risk : null;
  }

  return {
    side,
    zone,
    atKeyLevel,
    trendBreak,
    unhealthyMove,
    pattern,
    score,
    confirmed,
    entry,
    stop,
    target,
    riskReward,
  };
}
