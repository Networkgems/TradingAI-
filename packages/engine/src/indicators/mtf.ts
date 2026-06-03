/**
 * TRA-533 (TRA-530 Part A) — multi-timeframe technical signal snapshot.
 *
 * Pure, deterministic compose function over per-timeframe OHLCV candle arrays.
 * Reuses the existing engine indicator library (rsi, macd, bollinger, adx,
 * ema, sma200, atrPct, vwap) — no new indicator math, no I/O. The signal-engine
 * owns the candle fetch / resample / caching; this module is a pure reduction
 * so it can be golden-fixture unit-tested (acceptance #1, #2 in the TRA-530
 * spec).
 *
 * Scoring (per the spec):
 *   - Per timeframe, three sub-scores in [-1,+1]:
 *       trend    = mean of {EMA20 vs EMA50, close vs SMA200, SMA200 slope sign}
 *       momentum = mean of {RSI band, MACD histogram sign}
 *       location = Bollinger %B mapped to [-1,+1] (+ VWAP side on intraday TFs)
 *     tfScore = 0.45·trend + 0.35·momentum + 0.20·location, clamped [-1,+1].
 *     ADX<15 (chop) multiplies the trend term by 0.5 before fusion.
 *   - Fusion across {15m, 1h, 1d}:
 *       mtfScore = 0.50·tf(1d) + 0.30·tf(1h) + 0.20·tf(15m), weights renormalized
 *                  over whichever timeframes are present.
 *       mtfAlignment = fraction of present TFs whose tfScore sign matches
 *                      sign(mtfScore).
 *       mtfBias bucketed on mtfScore at ±0.2 / ±0.5.
 */
import type {
  Candle,
  MtfBias,
  TechnicalIndicatorReads,
  TechnicalSignalSnapshot,
  TechnicalTimeframe,
  TimeframeSignal,
} from '@trading-app/shared';
import { rsi } from './rsi.js';
import { macd } from './macd.js';
import { bollinger } from './bollinger.js';
import { adx } from './adx.js';
import { ema } from './ema.js';
import { atrPct } from './atr.js';

/** ADX below this de-weights the trend term (spec: chop guard). */
export const MTF_CHOP_ADX = 15;

/** RSI bands for the momentum vote. */
const RSI_BULL = 55;
const RSI_BEAR = 45;

/** Fusion weights by timeframe (renormalized over present TFs). */
export const MTF_TF_WEIGHTS: Record<TechnicalTimeframe, number> = {
  '1d': 0.5,
  '1h': 0.3,
  '15m': 0.2,
};

/** Candle bucket sizes (ms) for resampling minute bars. */
const MIN_MS = 60_000;
export const TF_BUCKET_MS: Record<'15m' | '1h', number> = {
  '15m': 15 * MIN_MS,
  '1h': 60 * MIN_MS,
};

function clamp(x: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/**
 * Sign with a dead-zone: values whose magnitude is below `eps` vote neutral
 * (0). The directional inputs (EMA gap, SMA distance/slope, MACD histogram) are
 * passed pre-normalized to a fraction-of-price so a single relative `eps`
 * applies. This keeps a flat / mean-reverting tape from amplifying
 * floating-point dust (and hair's-breadth crosses) into a hard ±1 vote — a
 * linear ramp drives the MACD histogram to ~1e-16, which a bare `sign()` would
 * read as bearish. */
function signEps(x: number, eps: number): number {
  if (!Number.isFinite(x) || Math.abs(x) < eps) return 0;
  return x > 0 ? 1 : -1;
}

/**
 * Relative dead-zone (fraction of price) below which a trend/VWAP read is noise.
 * Calibrated so a flat / mean-reverting tape votes 0 rather than coin-flipping.
 */
const VOTE_EPS = 5e-4;

/**
 * Absolute dead-zone for the MACD histogram. The histogram is tiny relative to
 * price even for genuine momentum, so it gets its own threshold — large enough
 * to swallow the ~1e-16 float dust a perfectly linear tape produces, small
 * enough to keep any real divergence.
 */
const MACD_EPS = 1e-6;

/** Mean of the finite votes; 0 when none are available (neutral). */
function meanVotes(votes: Array<number | null>): number {
  const present = votes.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) return 0;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

/**
 * Resample minute bars into fixed-width buckets aligned to the epoch (UTC
 * clock). open = first bar's open, close = last bar's close, high/low are the
 * window extremes, volume sums. Deterministic: bucketing depends only on each
 * bar's timestamp. The trailing (still-forming) bucket is included so the
 * snapshot reflects the latest partial bar.
 */
export function resampleCandles(minuteBars: Candle[], bucketMs: number): Candle[] {
  if (minuteBars.length === 0 || bucketMs <= 0) return [];
  const sorted = [...minuteBars].sort((a, b) => a.timestamp - b.timestamp);
  const out: Candle[] = [];
  let bucketStart = -1;
  for (const bar of sorted) {
    const start = Math.floor(bar.timestamp / bucketMs) * bucketMs;
    if (start !== bucketStart) {
      out.push({
        symbol: bar.symbol,
        timestamp: start,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
      bucketStart = start;
    } else {
      const agg = out[out.length - 1];
      agg.high = Math.max(agg.high, bar.high);
      agg.low = Math.min(agg.low, bar.low);
      agg.close = bar.close;
      agg.volume += bar.volume;
    }
  }
  return out;
}

/**
 * Session VWAP over the supplied candles (typical-price weighted). Pure helper
 * so the snapshot does not need the stateful {@link VwapTracker}. Returns null
 * when there is no traded volume.
 */
function vwapOf(candles: Candle[]): number | null {
  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    v += c.volume;
  }
  if (v <= 0) return null;
  return pv / v;
}

/**
 * Compose one timeframe's directional signal from its candle series. Intraday
 * TFs (`15m`/`1h`) fold a VWAP-side vote into `location`; the daily TF does
 * not (VWAP is a session-intraday construct). Returns null only when the series
 * is empty — otherwise every indicator degrades to a null read and a neutral
 * (0) vote, so a short series still yields a (weakly-signed) score.
 */
export function composeTimeframeSignal(
  candles: Candle[],
  timeframe: TechnicalTimeframe,
): TimeframeSignal | null {
  if (candles.length === 0) return null;

  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];

  // --- indicator reads (each null when insufficient data) ---
  const emaFast = closes.length >= 20 ? ema(closes, 20) : NaN;
  const emaSlow = closes.length >= 50 ? ema(closes, 50) : NaN;
  const sma200 =
    closes.length >= 200
      ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200
      : NaN;
  const sma200Prev =
    closes.length >= 220
      ? closes.slice(-220, -20).reduce((a, b) => a + b, 0) / 200
      : NaN;
  const rsiVal = closes.length >= 15 ? rsi(closes, 14) : NaN;
  const macdRes = macd(closes);
  const adxRes = adx(candles, 14);
  const bands = bollinger(closes, 20, 2);
  const atrPctVal = atrPct(candles, 14);
  const vwapVal =
    timeframe === '1d' ? null : vwapOf(candles);

  const macdHist = macdRes ? macdRes.histogram : NaN;
  const adxVal = adxRes ? adxRes.adx : NaN;
  const bbPercentB =
    bands && bands.upper > bands.lower
      ? (price - bands.lower) / (bands.upper - bands.lower)
      : NaN;
  const vwapDist =
    vwapVal != null && price > 0 ? (price - vwapVal) / price : null;

  const indicators: TechnicalIndicatorReads = {
    rsi: Number.isFinite(rsiVal) ? rsiVal : null,
    adx: Number.isFinite(adxVal) ? adxVal : null,
    macdHist: Number.isFinite(macdHist) ? macdHist : null,
    emaFast: Number.isFinite(emaFast) ? emaFast : null,
    emaSlow: Number.isFinite(emaSlow) ? emaSlow : null,
    atrPct: atrPctVal,
    bbPercentB: Number.isFinite(bbPercentB) ? bbPercentB : null,
  };
  if (timeframe !== '1d') indicators.vwapDist = vwapDist;

  // --- trend sub-score ---
  // All directional reads are normalized to a fraction of price so one relative
  // dead-zone (VOTE_EPS) filters out flat-tape noise uniformly.
  const px = price || 1;
  const emaStackVote =
    Number.isFinite(emaFast) && Number.isFinite(emaSlow)
      ? signEps((emaFast - emaSlow) / px, VOTE_EPS)
      : null;
  const smaPosVote = Number.isFinite(sma200) ? signEps((price - sma200) / px, VOTE_EPS) : null;
  const smaSlopeVote =
    Number.isFinite(sma200) && Number.isFinite(sma200Prev)
      ? signEps((sma200 - sma200Prev) / px, VOTE_EPS)
      : null;
  let trend = meanVotes([emaStackVote, smaPosVote, smaSlopeVote]);

  // --- momentum sub-score ---
  const rsiVote = Number.isFinite(rsiVal)
    ? rsiVal > RSI_BULL
      ? 1
      : rsiVal < RSI_BEAR
        ? -1
        : 0
    : null;
  const macdVote = Number.isFinite(macdHist) ? signEps(macdHist, MACD_EPS) : null;
  const momentum = meanVotes([rsiVote, macdVote]);

  // --- location sub-score ---
  // Bollinger %B mapped from ~[0,1] to [-1,+1] (0.5 = mid-band = neutral).
  const bbVote = Number.isFinite(bbPercentB) ? clamp((bbPercentB - 0.5) * 2) : null;
  const vwapVote = vwapDist != null ? signEps(vwapDist, VOTE_EPS) : null;
  const location = meanVotes(timeframe === '1d' ? [bbVote] : [bbVote, vwapVote]);

  // ADX<15 ⇒ de-weight trend (chop). A missing ADX read is treated as "not
  // confirmed chop" and leaves the trend term at full weight.
  const chop = Number.isFinite(adxVal) && adxVal < MTF_CHOP_ADX;
  if (chop) trend = trend * 0.5;

  const tfScore = clamp(0.45 * trend + 0.35 * momentum + 0.2 * location);

  return {
    trend: clamp(trend),
    momentum: clamp(momentum),
    location: clamp(location),
    tfScore,
    indicators,
  };
}

/** Bucket `mtfScore` into the directional bias per the spec thresholds. */
export function mtfBiasOf(score: number): MtfBias {
  if (score >= 0.5) return 'strong_bull';
  if (score >= 0.2) return 'bull';
  if (score > -0.2) return 'neutral';
  if (score > -0.5) return 'bear';
  return 'strong_bear';
}

export interface TimeframeCandles {
  '15m'?: Candle[];
  '1h'?: Candle[];
  '1d'?: Candle[];
}

/**
 * Compose the full multi-timeframe snapshot for a symbol. `asOf` is supplied by
 * the caller (the signal-engine stamps the tick time) to keep this function
 * pure and golden-testable. A timeframe with no candles is omitted entirely and
 * dropped from the weighted fusion (weights renormalize over present TFs); when
 * no timeframe has data the snapshot is neutral with empty `timeframes`.
 */
export function composeTechnicalSnapshot(
  symbol: string,
  asOf: string,
  candlesByTf: TimeframeCandles,
): TechnicalSignalSnapshot {
  const timeframes: Partial<Record<TechnicalTimeframe, TimeframeSignal>> = {};
  const order: TechnicalTimeframe[] = ['15m', '1h', '1d'];
  for (const tf of order) {
    const candles = candlesByTf[tf];
    if (!candles || candles.length === 0) continue;
    const sig = composeTimeframeSignal(candles, tf);
    if (sig) timeframes[tf] = sig;
  }

  const present = order.filter(tf => timeframes[tf] != null);
  let mtfScore = 0;
  if (present.length > 0) {
    const weightSum = present.reduce((a, tf) => a + MTF_TF_WEIGHTS[tf], 0);
    mtfScore = clamp(
      present.reduce((a, tf) => a + MTF_TF_WEIGHTS[tf] * timeframes[tf]!.tfScore, 0) / weightSum,
    );
  }

  const overallSign = sign(mtfScore);
  const mtfAlignment =
    present.length === 0
      ? 0
      : overallSign === 0
        ? 0
        : present.filter(tf => sign(timeframes[tf]!.tfScore) === overallSign).length /
          present.length;

  return {
    symbol,
    asOf,
    timeframes,
    mtfScore,
    mtfBias: mtfBiasOf(mtfScore),
    mtfAlignment,
  };
}
