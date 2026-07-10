/**
 * TRA-451 — SMA-200 trend filter + pullback/reclaim signals.
 *
 * Pure, deterministic signal computation over **daily** OHLCV bars, per the
 * authoritative build spec (TRA-449 → "SMA-200 Signals Build Spec"). This
 * module owns the indicator math and the three fire conditions; the server's
 * SignalEngine owns the daily-candle fetch, debounce, and UI surfacing.
 *
 * Definitions (from the spec):
 *   - SMA200        = simple mean of the last 200 daily closes.
 *   - SMA200_rising = SMA200[today] > SMA200[20 bars ago] (positive ~1-month slope).
 *   - RVOL_daily    = today volume / AvgVol20.
 *   - dist_atr      = (close - SMA200) / ATR(14) — distance to the 200-SMA in ATRs.
 *
 * TRA-458/TRA-460 — Signal 2 (pullback) v2 cleared the TRA-455 acceptance
 * gate; the server's SignalEngine now opens a live position off it. Signal 3
 * (reclaim) failed validation and stays display-only. This module only
 * computes the signals — the entry wiring lives in the SignalEngine.
 */
import type { Candle } from '@trading-app/shared';
import { atr } from './indicators/atr.js';
import { rsi } from './indicators/rsi.js';

/** Minimum daily bars required to evaluate (spec: ≥ 250 trading days). */
export const SMA200_MIN_BARS = 250;

/** Liquidity floor — these signals are noise on sub-$3 micro-caps. */
export const SMA200_MIN_PRICE = 3;
/** Liquidity floor — 20-day average dollar volume must clear this. */
export const SMA200_MIN_AVG_DOLLAR_VOL = 5_000_000;

/** Debounce: one signal per symbol per type within this many daily bars. */
export const SMA200_DEBOUNCE_BARS = 5;

/**
 * TRA-458 — Signal 2 v2 trend-strength gate. A pullback bounce only fires when
 * the 200-SMA is rising at least this much over the trailing 20 bars
 * (`SMA200[t] / SMA200[t-20] − 1`). 2.0% cleared the TRA-455 acceptance gate
 * (PF 1.93, MAR 0.61 vs SPY 0.41, robust across the 2R/2.5R/3R TP sweep).
 * QuantTrader owns future tuning of this threshold.
 */
export const SMA200_PULLBACK_MIN_SLOPE20 = 0.02;

export type Sma200SignalKind = 'sma200_pullback' | 'sma200_reclaim';

/** Indicator snapshot for the most recent (latest) daily bar. */
export interface Sma200Indicators {
  /** Simple mean of the last 200 daily closes. */
  sma200: number;
  /** Simple mean of the last 50 daily closes. */
  sma50: number;
  /** SMA200[today] > SMA200[20 bars ago]. */
  sma200Rising: boolean;
  /** Wilder ATR(14). */
  atr14: number;
  /** Wilder RSI(14) on closes. */
  rsi14: number;
  /** 20-day average share volume. */
  avgVol20: number;
  /** today volume / AvgVol20. */
  rvol: number;
  /** (close - SMA200) / ATR(14). */
  distAtr: number;
  /** 20-day average dollar volume (mean of volume × close). */
  avgDollarVol20: number;
}

/** A single fired pullback/reclaim signal. */
export interface Sma200SignalResult {
  kind: Sma200SignalKind;
  symbol: string;
  /** Entry = latest daily close. */
  entry: number;
  /** Suggested protective stop, per the spec formula for the kind. */
  stop: number;
  /** RSI(14) at the fire bar. */
  rsi: number;
  /** dist_atr at the fire bar. */
  distAtr: number;
  /** Signal-1 trend-quality gate state at the fire bar. */
  trendQuality: boolean;
  /** Reclaim-only: SMA50 > SMA200 golden-cross secondary confirmation. */
  goldenCross?: boolean;
  /** Human-readable context label. */
  label: string;
  /** Timestamp of the fire (latest) daily bar. */
  timestamp: number;
}

/** Full evaluation result for one symbol's daily series. */
export interface Sma200Evaluation {
  symbol: string;
  /** Indicator snapshot, or null when there is insufficient history. */
  indicators: Sma200Indicators | null;
  /** Symbol clears the price + dollar-volume liquidity filter. */
  liquidityOk: boolean;
  /** Signal 1 — uptrend-quality trend/quality gate flag. */
  trendQuality: boolean;
  /** Signals 2 & 3 that fired on the latest bar (empty when none / filtered). */
  signals: Sma200SignalResult[];
  /** Set when the series could not be evaluated. */
  rejectReason?: string;
}

/** Simple moving average of `values[end - period + 1 .. end]`. NaN if short. */
function smaAt(values: number[], period: number, end: number): number {
  if (period <= 0 || end < period - 1 || end >= values.length) return NaN;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += values[i];
  return sum / period;
}

/**
 * Full simple-moving-average series. Entries before index `period − 1` are
 * NaN (insufficient data). Used so callers can read SMA[t] and SMA[t − k].
 */
export function smaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** max(high) − min(low) over `candles[start .. end]` inclusive. */
function rangeOf(candles: Candle[], start: number, end: number): number {
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i <= end; i++) {
    if (candles[i].high > hi) hi = candles[i].high;
    if (candles[i].low < lo) lo = candles[i].low;
  }
  return hi - lo;
}

/**
 * Evaluate the SMA-200 trend filter and pullback/reclaim signals for one
 * symbol's daily series. `candles` must be chronologically ascending; only the
 * latest bar is treated as "today".
 */
export function evaluateSma200(symbol: string, candles: Candle[]): Sma200Evaluation {
  const empty: Sma200Evaluation = {
    symbol,
    indicators: null,
    liquidityOk: false,
    trendQuality: false,
    signals: [],
  };

  if (candles.length < SMA200_MIN_BARS) {
    return { ...empty, rejectReason: `need ≥ ${SMA200_MIN_BARS} daily bars, got ${candles.length}` };
  }

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const t = candles.length - 1;
  const today = candles[t];

  const sma200Series = smaSeries(closes, 200);
  const sma200 = sma200Series[t];
  const sma200Prev = sma200Series[t - 20];
  const sma50 = smaAt(closes, 50, t);
  const atr14 = atr(candles, 14);
  const rsi14 = rsi(closes, 14);
  const avgVol20 = smaAt(volumes, 20, t);

  if (
    !Number.isFinite(sma200) || !Number.isFinite(sma200Prev)
    || !Number.isFinite(sma50) || atr14 === null || atr14 <= 0
    || !Number.isFinite(rsi14) || !Number.isFinite(avgVol20)
  ) {
    return { ...empty, rejectReason: 'indicator computation produced a non-finite value' };
  }

  // 20-day average dollar volume — mean of per-bar (volume × close).
  let dollarVolSum = 0;
  for (let i = t - 19; i <= t; i++) dollarVolSum += volumes[i] * closes[i];
  const avgDollarVol20 = dollarVolSum / 20;

  const sma200Rising = sma200 > sma200Prev;
  const rvol = avgVol20 > 0 ? today.volume / avgVol20 : 0;
  const distAtr = (today.close - sma200) / atr14;

  const indicators: Sma200Indicators = {
    sma200, sma50, sma200Rising, atr14, rsi14, avgVol20, rvol, distAtr, avgDollarVol20,
  };

  // ---- Signal 1: trend / quality filter (gate, not a trade) -------------
  const trendQuality = today.close > sma200 && sma200Rising && today.close > sma50;

  // ---- Guardrail: liquidity filter --------------------------------------
  const liquidityOk = today.close >= SMA200_MIN_PRICE && avgDollarVol20 >= SMA200_MIN_AVG_DOLLAR_VOL;

  const base: Sma200Evaluation = { symbol, indicators, liquidityOk, trendQuality, signals: [] };
  if (!liquidityOk) {
    return { ...base, rejectReason: 'below liquidity floor (price ≥ $3 and 20d avg $vol ≥ $5M)' };
  }

  const signals: Sma200SignalResult[] = [];

  // ---- Signal 2: Pullback-to-200 Bounce (continuation long) -------------
  // TRA-458 v2 — cleared the TRA-455 acceptance gate after two revisions vs
  // v1: a trend-strength gate (200-SMA 20-bar slope ≥ 2.0%) and a decisive
  // up-close trigger that replaces the late-firing RSI-cross-40 momentum turn.
  // Pullback: low within 1.5×ATR of the 200-SMA on today or the prior 1–3 bars.
  let pullbackTouched = false;
  for (let i = t; i >= t - 3 && i >= 0; i--) {
    const sma = sma200Series[i];
    if (!Number.isFinite(sma)) continue;
    if (Math.abs(candles[i].low - sma) <= 1.5 * atr14) { pullbackTouched = true; break; }
  }
  // Hold confirmation: today closes back above SMA200 AND closes above its
  // open OR finishes in the top 40% of the day's range.
  const dayRange = today.high - today.low;
  const topOfRange = dayRange > 0 && (today.close - today.low) / dayRange >= 0.6;
  const holdConfirmed = today.close > sma200 && (today.close > today.open || topOfRange);
  // Trend strength: the 200-SMA must be rising ≥ 2.0% over the trailing 20 bars.
  const sma200Slope20 = sma200 / sma200Prev - 1;
  const trendStrength = sma200Slope20 >= SMA200_PULLBACK_MIN_SLOPE20;
  // Trigger: a decisive up-close above the highs of *both* prior bars.
  const decisiveUpClose = today.close > candles[t - 1].high && today.close > candles[t - 2].high;
  if (trendQuality && trendStrength && pullbackTouched && holdConfirmed && decisiveUpClose) {
    const stop = sma200 - 1.0 * atr14;
    // TRA-520 — guard against a non-positive / above-entry stop. When daily
    // data is spiky (an outlier bar inflates ATR(14) past the SMA200 level)
    // `sma200 − ATR` can go ≤ 0, which slipped through and persisted as a
    // negative stopLoss (e.g. ASTC stopLoss=-0.215) — a long with no real
    // downside protection. A valid pullback long must have 0 < stop < entry.
    if (stop > 0 && stop < today.close) {
      signals.push({
        kind: 'sma200_pullback',
        symbol,
        entry: today.close,
        stop,
        rsi: rsi14,
        distAtr,
        trendQuality: true,
        // TRA-1542 — plain ASCII hyphen: an em-dash in signal.context
        // mis-decoded downstream and rendered as mojibake.
        label: 'continuation - trend was already up',
        timestamp: today.timestamp,
      });
    }
  }

  // ---- Signal 3: 200-SMA Reclaim Reversal (trend-change swing) ----------
  // Prior down regime: close < SMA200 for ≥ 20 of the 30 bars before today.
  let belowCount = 0;
  for (let i = t - 30; i <= t - 1; i++) {
    if (i < 0) continue;
    const sma = sma200Series[i];
    if (Number.isFinite(sma) && closes[i] < sma) belowCount++;
  }
  const priorDownRegime = belowCount >= 20;
  // Reclaim: today is the first close above SMA200 in ≥ 10 bars (none of the
  // prior 10 bars closed above their own SMA200).
  let priorAbove = false;
  for (let i = t - 10; i <= t - 1; i++) {
    if (i < 0) continue;
    const sma = sma200Series[i];
    if (Number.isFinite(sma) && closes[i] > sma) { priorAbove = true; break; }
  }
  const reclaim = today.close > sma200 && !priorAbove;
  // Volume confirm.
  const volumeConfirm = rvol >= 1.5;
  // Basing: current 15-bar range ≤ 1.2 × the prior 15-bar range (no vertical spike).
  const currentRange = rangeOf(candles, t - 14, t);
  const priorRange = rangeOf(candles, t - 29, t - 15);
  const basing = priorRange > 0 && currentRange <= 1.2 * priorRange;
  if (priorDownRegime && reclaim && volumeConfirm && basing) {
    // Suggested stop: recent swing low, floored at SMA200 − 1.5×ATR so a
    // tight bounce-bar low can't park the stop above a sensible level.
    let swingLow = Infinity;
    for (let i = t - 9; i <= t; i++) {
      if (i < 0) continue;
      if (candles[i].low < swingLow) swingLow = candles[i].low;
    }
    const atrStop = sma200 - 1.5 * atr14;
    const stop = Math.min(swingLow, atrStop);
    const goldenCross = sma50 > sma200;
    signals.push({
      kind: 'sma200_reclaim',
      symbol,
      entry: today.close,
      stop,
      rsi: rsi14,
      distAtr,
      trendQuality,
      goldenCross,
      // TRA-1542 — ASCII hyphen (see note above): avoids em-dash mojibake
      // when signal.context is serialized/rendered downstream.
      label: goldenCross
        ? 'trend-change reclaim - golden cross confirmed'
        : 'trend-change reclaim',
      timestamp: today.timestamp,
    });
  }

  return { ...base, signals };
}
