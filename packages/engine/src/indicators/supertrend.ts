import type { Candle } from '@trading-app/shared';
import { atr } from './atr.js';

/**
 * TRA-728 (Phase 1) — Supertrend, an ATR-based stop-and-reverse trend filter.
 *
 * The Supertrend line is a volatility-scaled trailing stop placed `factor × ATR`
 * either side of the bar midpoint `(high + low) / 2`. The "final" bands ratchet
 * monotonically toward price (they only loosen when price closes through them),
 * and the active line flips from the upper band (downtrend / "red") to the lower
 * band (uptrend / "green") when price closes across it. This is the standard
 * stop-and-reverse construction used on TradingView and in the TRA-727 spec.
 *
 * Direction semantics:
 *   - `green` — price is ABOVE the Supertrend line (the line is the lower band);
 *     the trend read is up.
 *   - `red`   — price is BELOW the Supertrend line (the line is the upper band);
 *     the trend read is down.
 *
 * ATR is the existing engine primitive ({@link atr}, Wilder smoothing). We do
 * NOT reimplement it here — we read the Wilder ATR of each prefix so bar `i`
 * sees the ATR computed over `candles[0..i]`, exactly matching the standalone
 * `atr()` value a caller would get for that window. The default ATR length is 10
 * and the default factor is 3; both are parameters so the Phase-2 sweep can test
 * e.g. 7/3 vs 10/3.
 */

export type SupertrendDirection = 'green' | 'red';

export interface SupertrendBar {
  /** The active Supertrend line value (the trailing stop level) for this bar. */
  line: number;
  /** `green` when price is above the line (uptrend), `red` when below. */
  direction: SupertrendDirection;
  /** Final upper band for this bar (the level used while in a downtrend). */
  upperBand: number;
  /** Final lower band for this bar (the level used while in an uptrend). */
  lowerBand: number;
}

export interface SupertrendOptions {
  /** ATR length (default 10). */
  period?: number;
  /** Band multiplier (default 3). */
  factor?: number;
}

export const SUPERTREND_DEFAULT_PERIOD = 10;
export const SUPERTREND_DEFAULT_FACTOR = 3;

/**
 * Per-bar Supertrend series aligned to `candles`. Bars in the ATR warm-up
 * window (the first `period` bars, where Wilder ATR is not yet defined) are
 * `null`; every bar from index `period` onward carries a {@link SupertrendBar}.
 *
 * Pure and deterministic: depends only on the candle OHLC values, so the output
 * is golden-fixture testable.
 */
export function supertrend(
  candles: Candle[],
  opts: SupertrendOptions = {},
): Array<SupertrendBar | null> {
  const period = opts.period ?? SUPERTREND_DEFAULT_PERIOD;
  const factor = opts.factor ?? SUPERTREND_DEFAULT_FACTOR;

  const out: Array<SupertrendBar | null> = new Array(candles.length).fill(null);
  // ATR needs period+1 candles, so the first valid index is `period`.
  if (candles.length < period + 1 || period <= 0 || factor <= 0) return out;

  let prevFinalUpper = NaN;
  let prevFinalLower = NaN;
  let prevDirection: SupertrendDirection | null = null;

  for (let i = period; i < candles.length; i++) {
    const c = candles[i];
    // Reuse the existing Wilder ATR primitive on the prefix ending at bar i.
    const atrValue = atr(candles.slice(0, i + 1), period);
    if (atrValue === null) {
      out[i] = null;
      continue;
    }

    const mid = (c.high + c.low) / 2;
    const basicUpper = mid + factor * atrValue;
    const basicLower = mid - factor * atrValue;

    // Final bands ratchet: tighten toward price each bar, only loosening when
    // the prior bar closed beyond the band. First valid bar seeds from basic.
    const prevClose = candles[i - 1].close;
    const finalUpper =
      Number.isNaN(prevFinalUpper) || basicUpper < prevFinalUpper || prevClose > prevFinalUpper
        ? basicUpper
        : prevFinalUpper;
    const finalLower =
      Number.isNaN(prevFinalLower) || basicLower > prevFinalLower || prevClose < prevFinalLower
        ? basicLower
        : prevFinalLower;

    // Direction flip: stop-and-reverse on a close through the active band.
    let direction: SupertrendDirection;
    if (prevDirection === null) {
      // Seed: green when the first valid close sits above the upper band,
      // otherwise red. Deterministic and self-correcting within a bar or two.
      direction = c.close > finalUpper ? 'green' : 'red';
    } else if (prevDirection === 'red') {
      direction = c.close > finalUpper ? 'green' : 'red';
    } else {
      direction = c.close < finalLower ? 'red' : 'green';
    }

    out[i] = {
      line: direction === 'green' ? finalLower : finalUpper,
      direction,
      upperBand: finalUpper,
      lowerBand: finalLower,
    };

    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevDirection = direction;
  }

  return out;
}

/**
 * Latest Supertrend read, or `null` when there are not enough candles for a
 * defined ATR. Convenience over {@link supertrend} for strategy callers that
 * only need the current bar.
 */
export function supertrendLatest(
  candles: Candle[],
  opts: SupertrendOptions = {},
): SupertrendBar | null {
  const series = supertrend(candles, opts);
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i];
  }
  return null;
}
