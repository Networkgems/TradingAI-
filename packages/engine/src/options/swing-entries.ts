import type { Candle } from '@trading-app/shared';
import { ema } from '../indicators/ema.js';
import { emaSeries } from '../indicators/ma.js';
import { detectPattern } from '../indicators/patterns.js';
import { donchian, type DonchianChannel } from '../indicators/donchian.js';

/**
 * TRA-1028 — net-new options swing-entry triggers surfaced by the TRA-1026
 * playbook review (docs/reviews/TRA-1026-options-swing-playbook-review.md):
 *
 *   1. EMA-pullback (Trend-Pullback) entry archetype — leading-name uptrend
 *      above the 21 EMA + pullback to the 9/21 EMA + bullish reversal candle ->
 *      long call (mirror inverse for puts). The executing RV path today only
 *      reads cheap-vs-fitted-IV + trend confluence; it has no pullback trigger.
 *   2. Volume-confirmed breakout — a Donchian breakout *close* beyond the
 *      channel that also clears an above-average-volume bar, so a no-volume
 *      poke through resistance no longer counts as a high-conviction breakout.
 *
 * Both are PURE and deterministic (OHLCV in, decision out) so every output is
 * golden-testable, matching the rest of `indicators/` and `options/`. They do
 * NOT do any I/O, sizing, or routing — the signal-engine layer wires them in
 * behind the per-trigger execution sub-flags (default OFF) and records the
 * archetype to the shadow/paper ledger for the before/after readout.
 */

export type SwingSide = 'call' | 'put';

// --------------------------------------------------------------------------
// 1. EMA-pullback (Trend-Pullback) entry archetype
// --------------------------------------------------------------------------

export interface EmaPullbackOptions {
  /** Fast EMA period — the pullback target (default 9). */
  fastPeriod?: number;
  /** Slow EMA period — the trend gate (default 21). */
  slowPeriod?: number;
  /** How many recent bars to scan for the pullback touch (default 3). */
  pullbackLookback?: number;
  /**
   * Proximity band around the fast EMA, as a fraction of the EMA, that counts
   * as a "touch" of the 9 EMA on the pullback (default 0.01 = 1%). In an
   * uptrend a bar low at or below `fastEma * (1 + proximityPct)` qualifies;
   * mirror inverse for a downtrend high.
   */
  proximityPct?: number;
}

export const EMA_PULLBACK_DEFAULTS = {
  fastPeriod: 9,
  slowPeriod: 21,
  pullbackLookback: 3,
  proximityPct: 0.01,
} as const;

export interface EmaPullbackResult {
  /** True iff trend + pullback + reversal-candle all confirm. */
  fired: boolean;
  side: SwingSide;
  /** Above (call) / below (put) the 21 EMA with the 9 EMA on the same side. */
  trendOk: boolean;
  /** A recent bar tagged the 9 EMA band without losing the 21 EMA. */
  pulledBack: boolean;
  /** The latest bar is a directional reversal candle confirming resumption. */
  reversalCandle: boolean;
  ema9: number | null;
  ema21: number | null;
  reason: string;
}

/** Bullish reversal candle: a named bullish pattern or a simple up-close reclaim. */
function isBullishReversal(candles: Candle[]): boolean {
  const p = detectPattern(candles);
  if (p === 'hammer' || p === 'bullish_engulfing') return true;
  const c = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return c.close > c.open && c.close > prev.close;
}

/** Bearish reversal candle: a named bearish pattern or a simple down-close break. */
function isBearishReversal(candles: Candle[]): boolean {
  const p = detectPattern(candles);
  if (p === 'shooting_star' || p === 'bearish_engulfing') return true;
  const c = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return c.close < c.open && c.close < prev.close;
}

/**
 * Classify the latest bar as a Trend-Pullback entry for the requested side.
 *
 * For a call: price is in an uptrend (last close above the 21 EMA and the 9 EMA
 * above the 21 EMA), a bar within the last `pullbackLookback` has pulled back to
 * the 9 EMA band, and the latest bar is a bullish reversal candle. Mirror
 * inverse for a put. Returns `fired:false` with the partial read otherwise so a
 * caller can log exactly which leg failed.
 */
export function emaPullbackTrigger(
  candles: Candle[],
  side: SwingSide,
  opts: EmaPullbackOptions = {},
): EmaPullbackResult {
  const fast = opts.fastPeriod ?? EMA_PULLBACK_DEFAULTS.fastPeriod;
  const slow = opts.slowPeriod ?? EMA_PULLBACK_DEFAULTS.slowPeriod;
  const lookback = opts.pullbackLookback ?? EMA_PULLBACK_DEFAULTS.pullbackLookback;
  const proximityPct = opts.proximityPct ?? EMA_PULLBACK_DEFAULTS.proximityPct;

  const none = (reason: string, extra: Partial<EmaPullbackResult> = {}): EmaPullbackResult => ({
    fired: false,
    side,
    trendOk: false,
    pulledBack: false,
    reversalCandle: false,
    ema9: null,
    ema21: null,
    reason,
    ...extra,
  });

  if (candles.length < slow + 1) return none('insufficient bars for the 21 EMA');

  const closes = candles.map((c) => c.close);
  const fastSeries = emaSeries(closes, fast);
  const ema9 = ema(closes, fast);
  const ema21 = ema(closes, slow);
  if (!Number.isFinite(ema9) || !Number.isFinite(ema21)) return none('EMA not finite');

  const last = candles[candles.length - 1];

  // 1. Trend structure: above/below the 21 EMA with the 9 EMA on the same side.
  const trendOk =
    side === 'call'
      ? last.close > ema21 && ema9 > ema21
      : last.close < ema21 && ema9 < ema21;
  if (!trendOk) {
    return none(
      side === 'call'
        ? 'not in an uptrend above the 21 EMA'
        : 'not in a downtrend below the 21 EMA',
      { ema9, ema21 },
    );
  }

  // 2. Pullback: a recent bar tagged the 9 EMA band (low near/under the 9 EMA in
  //    an uptrend, high near/over it in a downtrend).
  let pulledBack = false;
  const startIdx = Math.max(0, candles.length - lookback);
  for (let i = startIdx; i < candles.length; i++) {
    const f = fastSeries[i];
    if (!Number.isFinite(f)) continue;
    if (side === 'call') {
      if (candles[i].low <= f * (1 + proximityPct)) {
        pulledBack = true;
        break;
      }
    } else if (candles[i].high >= f * (1 - proximityPct)) {
      pulledBack = true;
      break;
    }
  }
  if (!pulledBack) return none('no recent pullback to the 9 EMA', { trendOk, ema9, ema21 });

  // 3. Bullish/bearish reversal candle confirming the resumption.
  const reversalCandle = side === 'call' ? isBullishReversal(candles) : isBearishReversal(candles);
  if (!reversalCandle) {
    return none('no confirming reversal candle on the latest bar', {
      trendOk,
      pulledBack,
      ema9,
      ema21,
    });
  }

  return {
    fired: true,
    side,
    trendOk,
    pulledBack,
    reversalCandle,
    ema9,
    ema21,
    reason:
      side === 'call'
        ? 'uptrend above the 21 EMA, pullback to the 9 EMA, bullish reversal candle'
        : 'downtrend below the 21 EMA, pullback to the 9 EMA, bearish reversal candle',
  };
}

// --------------------------------------------------------------------------
// 2. Volume-confirmed Donchian breakout
// --------------------------------------------------------------------------

export interface VolumeBreakoutOptions {
  /** Donchian lookback for the resistance/support channel (default 20). */
  channelPeriod?: number;
  /** Lookback for the average-volume benchmark, prior bars only (default 20). */
  volumePeriod?: number;
  /** Breakout-bar volume must exceed `avgVolume * volumeMult` (default 1.5). */
  volumeMult?: number;
}

export const VOLUME_BREAKOUT_DEFAULTS = {
  channelPeriod: 20,
  volumePeriod: 20,
  volumeMult: 1.5,
} as const;

export interface VolumeBreakoutResult {
  /** True iff the close broke the channel AND on above-average volume. */
  fired: boolean;
  side: SwingSide;
  /** The close cleared the Donchian band in the requested direction. */
  breakout: boolean;
  /** The breakout bar's volume cleared the average-volume threshold. */
  volumeConfirmed: boolean;
  channel: DonchianChannel | null;
  volume: number | null;
  avgVolume: number | null;
  reason: string;
}

/**
 * A breakout *close* beyond the Donchian channel (excluding the current bar, so
 * the break is not a tautology) that also clears an above-average-volume bar.
 * For a call the close must exceed the channel upper on volume; for a put it
 * must break the channel lower. The average-volume benchmark excludes the
 * breakout bar itself so a single huge bar can't clear its own threshold.
 */
export function volumeConfirmedBreakout(
  candles: Candle[],
  side: SwingSide,
  opts: VolumeBreakoutOptions = {},
): VolumeBreakoutResult {
  const channelPeriod = opts.channelPeriod ?? VOLUME_BREAKOUT_DEFAULTS.channelPeriod;
  const volumePeriod = opts.volumePeriod ?? VOLUME_BREAKOUT_DEFAULTS.volumePeriod;
  const volumeMult = opts.volumeMult ?? VOLUME_BREAKOUT_DEFAULTS.volumeMult;

  const none = (reason: string, extra: Partial<VolumeBreakoutResult> = {}): VolumeBreakoutResult => ({
    fired: false,
    side,
    breakout: false,
    volumeConfirmed: false,
    channel: null,
    volume: null,
    avgVolume: null,
    reason,
    ...extra,
  });

  const channel = donchian(candles, channelPeriod, true);
  if (!channel) return none('insufficient bars for the Donchian channel');

  const last = candles[candles.length - 1];
  const breakout = side === 'call' ? last.close > channel.upper : last.close < channel.lower;
  if (!breakout) {
    return none(
      side === 'call'
        ? 'close did not clear the channel high'
        : 'close did not break the channel low',
      { channel },
    );
  }

  // Average volume over the prior `volumePeriod` bars, excluding the breakout bar.
  const end = candles.length - 1;
  const start = end - volumePeriod;
  if (start < 0) return none('insufficient bars for the volume benchmark', { breakout, channel });
  let sum = 0;
  for (let i = start; i < end; i++) sum += candles[i].volume;
  const avgVolume = sum / volumePeriod;
  const volume = last.volume;
  const volumeConfirmed = avgVolume > 0 && volume > avgVolume * volumeMult;
  if (!volumeConfirmed) {
    return none('breakout on below-average volume', {
      breakout,
      channel,
      volume,
      avgVolume,
    });
  }

  return {
    fired: true,
    side,
    breakout,
    volumeConfirmed,
    channel,
    volume,
    avgVolume,
    reason: `volume-confirmed breakout (${volume.toFixed(0)} vol vs ${(avgVolume * volumeMult).toFixed(0)} threshold)`,
  };
}
