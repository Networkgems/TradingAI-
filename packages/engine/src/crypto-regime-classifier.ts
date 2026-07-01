// TRA-1220 (parent TRA-1218, rec #3 of the TRA-1211 memo) — crypto regime
// classifier. A PURE, importable substrate (rec #2's regime-gated TSMOM consumes
// `classifyCryptoRegime` as its entry gate — do NOT inline this into a strategy).
//
// This is DISTINCT from `regime.ts`'s `classifyRegime` (TRA-197: ADX+ATR+MA-slope
// with hysteresis) — that stays untouched. This is an ADX+CHOP+ER composite tuned
// for crypto 4H with an explicit [0,1] confidence and NO hysteresis (stateless per
// bar — we want the raw forward label stream as evidence; smoothing is a rec-#2
// gating concern). Reuses the shared `adx()` + `ema()` indicators; does not
// re-implement either.
//
// Three orthogonal trend/chop measures vote (2-of-3 → trend), because they fail
// in different ways: ADX lags, CHOP is range-based, ER is path-based. Direction
// comes from the ADX ±DI split with an EMA tiebreak. Fail-closed to a null regime
// (never an invented default) whenever inputs are insufficient (spec §4).

import type { Candle } from '@trading-app/shared';
import { adx } from './indicators/adx.js';
import { ema } from './indicators/ema.js';
import { choppinessIndex } from './indicators/choppiness.js';
import { efficiencyRatio } from './indicators/efficiency-ratio.js';

export interface CryptoRegimeConfig {
  adxPeriod: number;
  /** ADX ≥ this → trend vote. */
  adxTrendMin: number;
  /** adxScore lower reference (dead-zone floor for confidence interpolation). */
  adxRangeMax: number;
  chopPeriod: number;
  /** CHOP ≤ this → trend vote. */
  chopTrendMax: number;
  /** CHOP ≥ this → deep-chop reference (confidence lower bound). */
  chopChopMin: number;
  erPeriod: number;
  /** ER ≥ this → trend vote. */
  erTrendMin: number;
  /** erScore lower reference (confidence interpolation floor). */
  erChopMax: number;
  /** EMA period used only to break a `plusDI == minusDI` direction tie. */
  emaPeriod: number;
  /** Votes (of 3) required to call a trend; else `chop`. */
  minTrendVotes: number;
  /** Fail-closed floor: fewer closed bars than this → null regime. */
  minBars: number;
}

/** Spec §3/§5 defaults — every one env-overridable in the server flag module. */
export const CRYPTO_REGIME_DEFAULTS: CryptoRegimeConfig = {
  adxPeriod: 14,
  adxTrendMin: 25,
  adxRangeMax: 20,
  chopPeriod: 14,
  chopTrendMax: 38.2,
  chopChopMin: 61.8,
  erPeriod: 10,
  erTrendMin: 0.3,
  erChopMax: 0.1,
  emaPeriod: 50,
  minTrendVotes: 2,
  minBars: 60,
};

export type CryptoRegimeLabel = 'trend_up' | 'trend_down' | 'chop';

export interface CryptoRegimeReading {
  symbol: string;
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
  choppiness: number | null;
  efficiencyRatio: number | null;
  regime: CryptoRegimeLabel | null;
  /** null when chop or insufficient data. */
  direction: 'up' | 'down' | null;
  /** [0,1], null when insufficient. */
  confidence: number | null;
  /** 0..3, null when insufficient. */
  trendVotes: number | null;
  reason: 'insufficient_data' | null;
  barCount: number;
  /** ISO of the last CLOSED bar classified, or null. */
  lastBarTime: string | null;
  /** Injected scan clock, ISO. */
  asOf: string;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Interpolate a saturating [0,1] sub-score between a chop-reference and a
 * trend-reference threshold. Direction-agnostic: `from` is the value that maps
 * to 0, `to` is the value that maps to 1. A degenerate span (from == to) yields
 * a hard step at the boundary rather than a NaN.
 */
function subScore(value: number, from: number, to: number): number {
  const span = to - from;
  if (span === 0) return value >= to ? 1 : 0;
  return clamp01((value - from) / span);
}

function insufficient(
  symbol: string,
  asOfIso: string,
  barCount: number,
  lastBarTime: string | null,
  partial: {
    adx?: number | null;
    plusDI?: number | null;
    minusDI?: number | null;
    choppiness?: number | null;
    efficiencyRatio?: number | null;
  } = {},
): CryptoRegimeReading {
  return {
    symbol,
    adx: partial.adx ?? null,
    plusDI: partial.plusDI ?? null,
    minusDI: partial.minusDI ?? null,
    choppiness: partial.choppiness ?? null,
    efficiencyRatio: partial.efficiencyRatio ?? null,
    regime: null,
    direction: null,
    confidence: null,
    trendVotes: null,
    reason: 'insufficient_data',
    barCount,
    lastBarTime,
    asOf: asOfIso,
  };
}

/**
 * Classify one symbol's CLOSED 4H bars into a regime reading. Pure — no I/O, no
 * orders, stateless per call (no hysteresis). The caller MUST pass only closed
 * bars (drop the forming bar) so there is no lookahead.
 *
 * @param bars   CLOSED candles, oldest-first.
 * @param cfg    thresholds (defaults in {@link CRYPTO_REGIME_DEFAULTS}).
 * @param now    injected clock (ms) so `asOf` is deterministic in tests.
 */
export function classifyCryptoRegime(
  bars: Candle[],
  cfg: CryptoRegimeConfig = CRYPTO_REGIME_DEFAULTS,
  now: number = Date.now(),
): CryptoRegimeReading {
  const asOfIso = new Date(now).toISOString();
  const barCount = bars.length;
  const symbol =
    barCount > 0 && typeof bars[barCount - 1].symbol === 'string'
      ? bars[barCount - 1].symbol
      : '';
  const lastBarTime =
    barCount > 0 && Number.isFinite(bars[barCount - 1].timestamp)
      ? new Date(bars[barCount - 1].timestamp).toISOString()
      : null;

  // Fail-closed floor (invariant #2): never invent a regime from partial data.
  if (barCount < cfg.minBars) {
    return insufficient(symbol, asOfIso, barCount, lastBarTime);
  }

  const adxRes = adx(bars, cfg.adxPeriod);
  const closes = bars.map((b) => b.close);
  const chop = choppinessIndex(bars, cfg.chopPeriod);
  const er = efficiencyRatio(closes, cfg.erPeriod);

  const adxVal = adxRes ? adxRes.adx : null;
  const plusDI = adxRes ? adxRes.plusDI : null;
  const minusDI = adxRes ? adxRes.minusDI : null;

  // Any null / non-finite indicator ⇒ fail-closed, still surfacing what computed.
  if (
    adxRes == null ||
    !Number.isFinite(adxVal as number) ||
    !Number.isFinite(plusDI as number) ||
    !Number.isFinite(minusDI as number) ||
    chop == null ||
    er == null
  ) {
    return insufficient(symbol, asOfIso, barCount, lastBarTime, {
      adx: adxVal,
      plusDI,
      minusDI,
      choppiness: chop,
      efficiencyRatio: er,
    });
  }

  const adxNum = adxVal as number;
  const plus = plusDI as number;
  const minus = minusDI as number;

  // Trend votes (spec §3).
  const adxVote = adxNum >= cfg.adxTrendMin;
  const chopVote = chop <= cfg.chopTrendMax;
  const erVote = er >= cfg.erTrendMin;
  const trendVotes = (adxVote ? 1 : 0) + (chopVote ? 1 : 0) + (erVote ? 1 : 0);

  // Continuous trendiness, averaged over three saturating sub-scores.
  const adxScore = subScore(adxNum, cfg.adxRangeMax, cfg.adxTrendMin); // 20→0, 25→1
  const chopScore = subScore(chop, cfg.chopChopMin, cfg.chopTrendMax); // 61.8→0, 38.2→1
  const erScore = subScore(er, cfg.erChopMax, cfg.erTrendMin); // 0.10→0, 0.30→1
  const trendScore = (adxScore + chopScore + erScore) / 3;

  let regime: CryptoRegimeLabel;
  let direction: 'up' | 'down' | null;
  if (trendVotes >= cfg.minTrendVotes) {
    if (plus > minus) direction = 'up';
    else if (minus > plus) direction = 'down';
    else {
      // Deterministic EMA tiebreak on plusDI == minusDI. ema() returns NaN when
      // < emaPeriod closes; barCount ≥ minBars(60) ≥ emaPeriod(50) so this is
      // finite in practice, but guard anyway (NaN comparison → 'down').
      const ema50 = ema(closes, cfg.emaPeriod);
      const lastClose = closes[closes.length - 1];
      direction = Number.isFinite(ema50) && lastClose >= ema50 ? 'up' : 'down';
    }
    regime = direction === 'up' ? 'trend_up' : 'trend_down';
  } else {
    regime = 'chop';
    direction = null;
  }

  // Confidence is symmetric: strong trend → ~1 (trend label), deep chop → ~1
  // (chop label), ambiguous middle → ~0.5 either way.
  const confidence = round3(clamp01(regime === 'chop' ? 1 - trendScore : trendScore));

  return {
    symbol,
    adx: adxNum,
    plusDI: plus,
    minusDI: minus,
    choppiness: chop,
    efficiencyRatio: er,
    regime,
    direction,
    confidence,
    trendVotes,
    reason: null,
    barCount,
    lastBarTime,
    asOf: asOfIso,
  };
}
