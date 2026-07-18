/**
 * TRA-2024 (impl of TRA-2022) — point-in-time feature + label engineering for
 * the ML-classifier feasibility spike.
 *
 * FROZEN by the pre-registration ([TRA-2022] `pre-registration` document). This
 * file builds *exactly* the 16-feature vector §3 lists, the 3-class label §2
 * defines, and the net-of-fee R translation §6 defines — nothing added, nothing
 * re-derived.
 *
 * ── The one invariant that decides whether this spike is trustworthy ─────────
 * Point-in-time / no-lookahead (pre-reg §2, hard invariant):
 *   • every FEATURE at bar T reads only `candles[… T]` (inclusive of T's close);
 *   • the LABEL at T reads `candles[T+1 … T+H]` and is used in TRAINING TARGETS
 *     ONLY — nothing the model *sees* at T depends on data after T.
 *
 * We enforce the feature invariant STRUCTURALLY, the same way `earningsInDaysAsOf`
 * does in `run-tra1968-earnings-gate.ts`: {@link featureVectorAt} computes bar T's
 * vector from `candles.slice(0, T + 1)` — the future bars are not even passed in,
 * so a leak is impossible by construction. {@link computeFeatureBundle} is the
 * fast batch path (one pass, causal indicators indexed in place); the unit test
 * asserts the two agree AND that mutating bars > T leaves T's vector byte-
 * identical. A leak here would produce a **false REAL** — the single highest-risk
 * bug in the whole spike (MEMORY: "an instrument reads identically in pass/fail").
 *
 * Every indicator used is the EXACT frozen one from `packages/engine/src/
 * indicators/` (§3 reuse map) — we call the shipped functions on the point-in-
 * time prefix rather than re-implementing them.
 */

import {
  rsi,
  macd,
  adx,
  bollinger,
  atr,
  supertrend,
  ichimoku,
  VwapTracker,
  efficiencyRatio,
  choppinessIndex,
  detectPattern,
  isBullishPattern,
  isBearishPattern,
  type SupertrendBar,
} from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';

/** The frozen label horizon H (daily bars) — pre-reg §2. */
export const LABEL_HORIZON = 5;

/** The frozen feature count — pre-reg §3. A vector of any other length is a bug. */
export const FEATURE_COUNT = 16;

/** Frozen, human-readable feature names (report + coefficient inspection). */
export const FEATURE_NAMES: readonly string[] = [
  'rsi14',
  'macd_line',
  'macd_signal',
  'macd_hist',
  'adx14',
  'atr_pct14',
  'bb_pctB',
  'bb_bandwidth',
  'supertrend_dir',
  'supertrend_dist_pct',
  'ichimoku_cloud_pos',
  'ichimoku_tk_spread_pct',
  'vwap_dist_pct',
  'efficiency_ratio10',
  'choppiness14',
  'pattern_flag',
];

/** 3-class label. Index order is fixed: 0 = down, 1 = range, 2 = up. */
export const CLASS_DOWN = 0;
export const CLASS_RANGE = 1;
export const CLASS_UP = 2;
export const CLASS_COUNT = 3;

export interface FeatureBundle {
  /** One 16-vector per bar, or `null` when a required indicator is not yet warm. */
  readonly features: ReadonlyArray<number[] | null>;
  /** ATR(14) in PRICE units at each bar (needed for the label band + R unit). */
  readonly atr14: ReadonlyArray<number | null>;
  readonly closes: readonly number[];
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly timestamps: readonly number[];
}

/**
 * Assemble bar T's 16-feature vector from its already-computed indicator reads.
 * Returns `null` if any required indicator is undefined (not-yet-warm) so the
 * caller can drop the row rather than fabricate a zero.
 */
function assembleRow(
  close: number,
  rsiVal: number,
  macdVal: { macd: number; signal: number; histogram: number } | null,
  adxVal: { adx: number } | null,
  atrPctVal: number | null,
  bbVal: { upper: number; lower: number; bandwidth: number } | null,
  stVal: SupertrendBar | null,
  ichiVal: {
    tenkan: number;
    kijun: number;
    cloudTop: number;
    cloudBottom: number;
  } | null,
  vwapDistPct: number,
  effVal: number | null,
  chopVal: number | null,
  patternFlag: number,
): number[] | null {
  if (
    macdVal === null ||
    adxVal === null ||
    atrPctVal === null ||
    bbVal === null ||
    stVal === null ||
    ichiVal === null ||
    effVal === null ||
    chopVal === null ||
    close <= 0
  ) {
    return null;
  }

  // Bollinger %B — where close sits across the band (0 = lower, 1 = upper).
  const bandWidthAbs = bbVal.upper - bbVal.lower;
  const pctB = bandWidthAbs > 0 ? (close - bbVal.lower) / bandWidthAbs : 0.5;

  // Supertrend: signed direction + signed distance-to-price as a fraction.
  const stDir = stVal.direction === 'green' ? 1 : -1;
  const stDistPct = (close - stVal.line) / close;

  // Ichimoku price-vs-cloud: +1 above, -1 below, 0 inside; tenkan−kijun spread%.
  const cloudPos = close > ichiVal.cloudTop ? 1 : close < ichiVal.cloudBottom ? -1 : 0;
  const tkSpreadPct = (ichiVal.tenkan - ichiVal.kijun) / close;

  const row = [
    rsiVal,
    macdVal.macd,
    macdVal.signal,
    macdVal.histogram,
    adxVal.adx,
    atrPctVal,
    pctB,
    bbVal.bandwidth,
    stDir,
    stDistPct,
    cloudPos,
    tkSpreadPct,
    vwapDistPct,
    effVal,
    chopVal,
    patternFlag,
  ];
  // Guard: any non-finite indicator read invalidates the row (a NaN would
  // silently poison the scaler / model fit).
  for (const v of row) if (!Number.isFinite(v)) return null;
  return row;
}

/** Signed pattern flag: +1 bullish, −1 bearish, 0 none — the single §3 categorical. */
function patternFlagAt(prefix: Candle[]): number {
  const p = detectPattern(prefix);
  if (isBullishPattern(p)) return 1;
  if (isBearishPattern(p)) return -1;
  return 0;
}

/**
 * Batch feature/label inputs for a full candle series — the fast path used by
 * the harness. Each indicator is CAUSAL (bar i depends only on bars ≤ i), so
 * indexing the once-computed Supertrend series and calling the shipped latest-
 * value indicators on each point-in-time prefix yields exactly what
 * {@link featureVectorAt} produces on the isolated prefix (asserted in the test).
 *
 * Cost is O(N²) (each prefix call rescans its history); N is a few hundred to
 * ~1k daily bars per symbol, so this stays well under a second in the smoke and
 * a few seconds on the real `--execute` universe. Fidelity to the FROZEN
 * indicator definitions (we call the shipped functions, never re-implement)
 * is worth more here than shaving the constant.
 */
export function computeFeatureBundle(candles: Candle[]): FeatureBundle {
  const n = candles.length;
  const features: Array<number[] | null> = new Array(n).fill(null);
  const atr14: Array<number | null> = new Array(n).fill(null);
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const timestamps = candles.map((c) => c.timestamp);

  // Supertrend as a single causal series (bar i uses candles[0..i]); indexed
  // below to avoid an O(N³) per-prefix recompute.
  const stSeries = supertrend(candles);

  // Anchored VWAP: fed the whole prefix each bar via a fresh tracker with no
  // intraday reset (daily bars have no session). Anchored-from-start VWAP is
  // slow-moving but causal — see the report's `notes[]` caveat.
  for (let t = 0; t < n; t++) {
    const prefix = candles.slice(0, t + 1);
    const close = candles[t].close;
    const closesPrefix = prefix.map((c) => c.close);

    const atrPrice = atr(prefix, 14);
    atr14[t] = atrPrice;

    const rsiVal = rsi(closesPrefix, 14);
    const macdVal = macd(closesPrefix);
    const adxVal = adx(prefix, 14);
    const atrPctVal = atrPrice !== null && close > 0 ? atrPrice / close : null;
    const bbVal = bollinger(closesPrefix, 20, 2);
    const ichiVal = ichimoku(prefix);
    const effVal = efficiencyRatio(closesPrefix, 10);
    const chopVal = choppinessIndex(prefix, 14);

    let vwapDistPct = 0;
    const tracker = new VwapTracker();
    let vwapState: { vwap: number } | null = null;
    for (const c of prefix) vwapState = tracker.update(c);
    if (vwapState && vwapState.vwap > 0) vwapDistPct = (close - vwapState.vwap) / vwapState.vwap;

    features[t] = assembleRow(
      close,
      rsiVal,
      macdVal,
      adxVal,
      atrPctVal,
      bbVal,
      stSeries[t] ?? null,
      ichiVal,
      vwapDistPct,
      effVal,
      chopVal,
      patternFlagAt(prefix),
    );
  }

  return { features, atr14, closes, highs, lows, timestamps };
}

/**
 * The point-in-time feature vector at bar T, computed from `candles.slice(0,
 * T + 1)` ONLY. This is the leak-proof reference the no-lookahead test drives:
 * future bars are not passed in, so mutating them cannot change the result.
 */
export function featureVectorAt(candles: Candle[], t: number): number[] | null {
  if (t < 0 || t >= candles.length) return null;
  const prefix = candles.slice(0, t + 1);
  return computeFeatureBundle(prefix).features[t];
}

/** Forward-average label read (pre-reg §2). `null` when the H-bar future is short. */
export interface LabelRead {
  cls: number;
  fwd: number;
  tau: number;
}

/**
 * The FROZEN 3-class label at bar T (pre-reg §2), volatility-scaled:
 *   fwd = mean(close[T+1 .. T+H]) / close[T] − 1
 *   τ_T = 0.5 × ATR%₁₄(T)
 *   up if fwd > τ ; down if fwd < −τ ; else range.
 * Uses ONLY forward data (T+1 … T+H) — a training target, never a feature.
 * Returns `null` when the H-bar future is unavailable or ATR is undefined.
 */
export function labelAt(bundle: FeatureBundle, t: number, horizon = LABEL_HORIZON): LabelRead | null {
  const { closes, atr14 } = bundle;
  const base = closes[t];
  const atrPrice = atr14[t];
  if (base === undefined || base <= 0 || atrPrice === null || atrPrice === undefined) return null;
  if (t + horizon >= closes.length) return null;

  let sum = 0;
  for (let k = 1; k <= horizon; k++) sum += closes[t + k];
  const fwd = sum / horizon / base - 1;
  const tau = 0.5 * (atrPrice / base);

  let cls = CLASS_RANGE;
  if (fwd > tau) cls = CLASS_UP;
  else if (fwd < -tau) cls = CLASS_DOWN;
  return { cls, fwd, tau };
}

/**
 * Translate a directional call at bar T into a net-of-fee R multiple over the
 * next H bars (pre-reg §6). Risk unit = 1.0 × ATR₁₄(T); exit = close[T+H];
 * a hard ATR-stop touch inside the window caps the loss at −1R. Round-trip
 * slippage (`slippageBps`/side) is subtracted, expressed in R. `dir` is +1
 * (long, from an `up` call) or −1 (short, from a `down` call); a `range` call
 * does not act and must not be passed here.
 */
export function translateToR(
  bundle: FeatureBundle,
  t: number,
  dir: 1 | -1,
  slippageBps: number,
  horizon = LABEL_HORIZON,
): number | null {
  const { closes, highs, lows, atr14 } = bundle;
  const entry = closes[t];
  const atrPrice = atr14[t];
  if (entry === undefined || atrPrice === null || atrPrice === undefined || atrPrice <= 0) return null;
  if (t + horizon >= closes.length) return null;

  // Round-trip slippage cost, converted from price to R units.
  const costR = (2 * (slippageBps / 10_000) * entry) / atrPrice;

  // Hard 1×ATR stop: for a long, a low ≤ entry−ATR caps at −1R; mirror for short.
  const stop = dir === 1 ? entry - atrPrice : entry + atrPrice;
  for (let k = 1; k <= horizon; k++) {
    const touched = dir === 1 ? lows[t + k] <= stop : highs[t + k] >= stop;
    if (touched) return -1 - costR;
  }

  const exit = closes[t + horizon];
  const grossR = (dir * (exit - entry)) / atrPrice;
  return grossR - costR;
}
