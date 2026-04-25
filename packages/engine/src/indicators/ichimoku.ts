import type { Candle } from '@trading-app/shared';

export interface IchimokuState {
  tenkan: number;
  kijun: number;
  /** SenkouA from 26 bars ago — forms current cloud top or bottom */
  senkouA: number;
  /** SenkouB from 26 bars ago — forms current cloud top or bottom */
  senkouB: number;
  /** Upper boundary of the current cloud */
  cloudTop: number;
  /** Lower boundary of the current cloud */
  cloudBottom: number;
  /** True when current close is above the close from 26 bars ago (chikou confirmation) */
  chikouAbove: boolean;
}

function midRange(candles: Candle[], start: number, end: number): number {
  const slice = candles.slice(start, end);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  return (high + low) / 2;
}

/**
 * Ichimoku Cloud.
 * Requires at least 78 candles (52-period SenkouB + 26-period displacement).
 * Returns null when insufficient data.
 */
export function ichimoku(candles: Candle[]): IchimokuState | null {
  const n = candles.length;
  if (n < 78) return null;

  // Current Tenkan (9) and Kijun (26) — used for TK cross signal
  const tenkan = midRange(candles, n - 9, n);
  const kijun = midRange(candles, n - 26, n);

  // The cloud displayed at current time was calculated 26 bars ago
  const past = n - 26;
  const tenkanPast = midRange(candles, past - 9, past);
  const kijunPast = midRange(candles, past - 26, past);
  const senkouA = (tenkanPast + kijunPast) / 2;
  const senkouB = midRange(candles, past - 52, past);

  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);

  // Chikou span: current close vs the close 26 bars ago
  const chikouAbove = candles[n - 1].close > candles[past - 1].close;

  return { tenkan, kijun, senkouA, senkouB, cloudTop, cloudBottom, chikouAbove };
}

/**
 * Returns 'bullish' when tenkan just crossed above kijun,
 * 'bearish' when tenkan just crossed below kijun, or null.
 */
export function tkCross(candles: Candle[]): 'bullish' | 'bearish' | null {
  if (candles.length < 79) return null;

  const curr = ichimoku(candles);
  const prev = ichimoku(candles.slice(0, -1));
  if (!curr || !prev) return null;

  if (prev.tenkan <= prev.kijun && curr.tenkan > curr.kijun) return 'bullish';
  if (prev.tenkan >= prev.kijun && curr.tenkan < curr.kijun) return 'bearish';
  return null;
}
