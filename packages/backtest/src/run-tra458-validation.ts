/**
 * TRA-458 — SMA-200 signals v2: quant-logic revision after the TRA-455 gate fail.
 *
 * QuantTrader-owned RESEARCH harness (not application code). The TRA-451 engine
 * implementation of `evaluateSma200` is correct and unit-tested; TRA-455 showed
 * the *signal definitions* fail the spec ship gate (PF > 1.3 AND beats SPY
 * buy-and-hold risk-adjusted). This harness carries a revised v2 definition of
 * Signal 2 (pullback) and Signal 3 (reclaim) and re-runs the same acceptance
 * gate. If a config clears the gate, the v2 definition is handed to the
 * Developer/LeadDev to port into `packages/engine/src/sma200-signals.ts`.
 *
 * v2 hypotheses under test (from TRA-458):
 *   - Signal 2: the RSI-cross-up-through-40 trigger fires late. Try a
 *     reclaim-of-prior-bar-highs trigger (decisive bounce bar) plus a
 *     trend-strength gate (SMA200 20-bar slope, ADX(14), golden cross).
 *   - Signal 3: the first-reclaim entry catches falling knives. Try a
 *     follow-through confirmation bar, a rising SMA50, and an ADX gate.
 *
 * Trade model, window, universe, slippage and the ship gate are byte-identical
 * to run-tra455-validation.ts so the comparison is apples-to-apples.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra458-validation.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { loadOrFetchDailyBars } from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

// ---- Window (identical to TRA-455) ----------------------------------------
const FETCH_START_MS = Date.UTC(2020, 8, 1); // 2020-09-01 — warm-up
const TEST_START_MS = Date.UTC(2022, 0, 1); // 2022-01-01 — first counted fire
const TO_MS = Date.UTC(2026, 4, 18); // 2026-05-18

// ---- Trade model (identical to TRA-455) -----------------------------------
const TP_PRIMARY = 2.5;
const TP_SENSITIVITY = [2.0, 2.5, 3.0];
const MAX_HOLD_BARS = 50;
const SLIPPAGE_BPS = 10;
const RISK_PER_TRADE = 0.01;
const DEBOUNCE_BARS = 5;

// ---- Liquidity floor (spec) -----------------------------------------------
const MIN_PRICE = 3;
const MIN_AVG_DOLLAR_VOL = 5_000_000;

// ---- Universe (identical to TRA-455) --------------------------------------
const UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AVGO', 'CRM', 'ADBE', 'AMD', 'CSCO', 'ORCL', 'TXN',
  'GOOGL', 'META', 'NFLX', 'DIS', 'TMUS',
  'AMZN', 'TSLA', 'HD', 'MCD', 'NKE',
  'PG', 'KO', 'PEP', 'COST', 'WMT',
  'JPM', 'V', 'MA', 'BAC', 'GS',
  'UNH', 'LLY', 'ABBV', 'MRK', 'TMO',
  'XOM', 'CVX', 'CAT', 'GE', 'NEE',
];
const BENCHMARK = 'SPY';

type Kind = 'sma200_pullback' | 'sma200_reclaim';

// =========================================================================
// Indicator series — Wilder ATR / RSI / ADX, replicated to match the engine's
// `atr`/`rsi`/`adx` exactly at every bar so the eventual engine port is a
// faithful translation of what was validated here.
// =========================================================================

/** Simple-moving-average series; NaN before index `period - 1`. */
function smaSeries(values: number[], period: number): number[] {
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

/** Wilder ATR(14) series — out[t] === engine atr(candles.slice(0, t + 1)). */
function atrSeries(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period + 1) return out;
  const tr: number[] = []; // tr[k] is the true range of candle k + 1
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let smoothed = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = smoothed;
  for (let i = period; i < tr.length; i++) {
    smoothed = (smoothed * (period - 1) + tr[i]) / period;
    out[i + 1] = smoothed;
  }
  return out;
}

/** Wilder RSI(14) series — out[t] === engine rsi(closes.slice(0, t + 1)). */
function rsiSeries(closes: number[], period = 14): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period + 1) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsiFrom = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = rsiFrom(avgGain, avgLoss);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

/** Wilder ADX(14) series — out[t] === engine adx(candles.slice(0, t + 1)).adx. */
function adxSeries(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period * 2) return out;
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high - p.high;
    const dn = p.low - c.low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let sTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let sP = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let sM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  // dx[j] corresponds to tr index period + j  →  candle index period + j + 1.
  const dx: number[] = [];
  const dxCandleIdx: number[] = [];
  for (let i = period; i < tr.length; i++) {
    sTR = sTR - sTR / period + tr[i];
    sP = sP - sP / period + plusDM[i];
    sM = sM - sM / period + minusDM[i];
    if (sTR === 0) continue;
    const diP = (sP / sTR) * 100;
    const diM = (sM / sTR) * 100;
    const sum = diP + diM;
    dx.push(sum === 0 ? 0 : (Math.abs(diP - diM) / sum) * 100);
    dxCandleIdx.push(i + 1);
  }
  if (dx.length < period) return out;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[dxCandleIdx[period - 1]] = adxVal;
  for (let j = period; j < dx.length; j++) {
    adxVal = (adxVal * (period - 1) + dx[j]) / period;
    out[dxCandleIdx[j]] = adxVal;
  }
  return out;
}

// =========================================================================
// Per-symbol precomputed series.
// =========================================================================

interface Series {
  symbol: string;
  candles: Candle[];
  closes: number[];
  sma200: number[];
  sma50: number[];
  atr14: number[];
  rsi14: number[];
  adx14: number[];
  avgVol20: number[];
  avgDollarVol20: number[];
}

function buildSeries(candles: Candle[]): Series {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const dollarVol = candles.map((c) => c.volume * c.close);
  return {
    symbol: candles[0]?.symbol ?? '?',
    candles,
    closes,
    sma200: smaSeries(closes, 200),
    sma50: smaSeries(closes, 50),
    atr14: atrSeries(candles, 14),
    rsi14: rsiSeries(closes, 14),
    adx14: adxSeries(candles, 14),
    avgVol20: smaSeries(volumes, 20),
    avgDollarVol20: smaSeries(dollarVol, 20),
  };
}

// =========================================================================
// v2 signal definitions — parameterised so a single run sweeps the revisions.
// =========================================================================

interface PullbackCfg {
  /** Require an established uptrend: SMA50 > SMA200 (golden cross) at the fire bar. */
  requireGoldenCross: boolean;
  /** Minimum SMA200 20-bar slope, as a fraction (e.g. 0.01 = +1% over ~1 month). */
  minSlope20: number;
  /** Minimum ADX(14); 0 disables the gate. */
  minAdx: number;
  /** Bounce trigger: late-lagging RSI cross, or a decisive prior-highs reclaim. */
  trigger: 'rsi40' | 'priorHigh';
}

interface ReclaimCfg {
  /** Enter on a follow-through bar after the reclaim instead of the reclaim bar itself. */
  followThrough: boolean;
  /** Require SMA50 to be rising over the last 10 bars (medium-term momentum turned up). */
  sma50Rising: boolean;
  /** Minimum ADX(14); 0 disables the gate. */
  minAdx: number;
}

interface Sig {
  kind: Kind;
  entryIdx: number;
  entry: number;
  stop: number;
}

/** Signal-1 trend/quality gate — unchanged from v1, reused as the Signal-2 base gate. */
function trendQualityAt(s: Series, t: number): boolean {
  return s.closes[t] > s.sma200[t] && s.sma200[t] > s.sma200[t - 20] && s.closes[t] > s.sma50[t];
}

/** v2 Signal 2 — pullback-to-200 bounce. Returns a fired signal at bar t or null. */
function evalPullback(s: Series, t: number, cfg: PullbackCfg): Sig | null {
  const sma200 = s.sma200[t];
  const atr14 = s.atr14[t];
  if (!Number.isFinite(sma200) || !Number.isFinite(atr14) || atr14 <= 0) return null;
  if (!trendQualityAt(s, t)) return null;

  // Trend-strength gate.
  if (cfg.requireGoldenCross && !(s.sma50[t] > sma200)) return null;
  const slope20 = sma200 / s.sma200[t - 20] - 1;
  if (slope20 < cfg.minSlope20) return null;
  if (cfg.minAdx > 0 && !(s.adx14[t] >= cfg.minAdx)) return null;

  // Pullback: a low within 1.5×ATR of the 200-SMA on today or the prior 1–3 bars.
  let touched = false;
  for (let i = t; i >= t - 3 && i >= 0; i--) {
    const sma = s.sma200[i];
    if (Number.isFinite(sma) && Math.abs(s.candles[i].low - sma) <= 1.5 * atr14) {
      touched = true;
      break;
    }
  }
  if (!touched) return null;

  // Hold confirmation: close back above SMA200 and a constructive bar.
  const today = s.candles[t];
  const range = today.high - today.low;
  const topOfRange = range > 0 && (today.close - today.low) / range >= 0.6;
  if (!(today.close > sma200 && (today.close > today.open || topOfRange))) return null;

  // Bounce trigger.
  let triggered = false;
  if (cfg.trigger === 'rsi40') {
    for (let i = t; i >= t - 2 && i >= 1; i--) {
      const prev = s.rsi14[i - 1];
      const cur = s.rsi14[i];
      if (Number.isFinite(prev) && Number.isFinite(cur) && prev < 40 && cur >= 40) {
        triggered = true;
        break;
      }
    }
  } else {
    // priorHigh — a decisive up-close above both prior bars' highs.
    triggered = today.close > s.candles[t - 1].high && today.close > s.candles[t - 2].high;
  }
  if (!triggered) return null;

  return { kind: 'sma200_pullback', entryIdx: t, entry: today.close, stop: sma200 - 1.0 * atr14 };
}

/** True when bar k is a fresh reclaim: close above SMA200 with no close above it in the prior 10 bars. */
function reclaimAt(s: Series, k: number): boolean {
  if (k < 11 || !Number.isFinite(s.sma200[k]) || !(s.closes[k] > s.sma200[k])) return false;
  for (let i = k - 10; i <= k - 1; i++) {
    if (Number.isFinite(s.sma200[i]) && s.closes[i] > s.sma200[i]) return false;
  }
  return true;
}

/** v2 Signal 3 — 200-SMA reclaim reversal. Returns a fired signal at bar t or null. */
function evalReclaim(s: Series, t: number, cfg: ReclaimCfg): Sig | null {
  const sma200 = s.sma200[t];
  const atr14 = s.atr14[t];
  if (!Number.isFinite(sma200) || !Number.isFinite(atr14) || atr14 <= 0) return null;

  // Prior down regime: close < SMA200 on ≥ 20 of the 30 bars before today.
  let below = 0;
  for (let i = t - 30; i <= t - 1; i++) {
    if (i >= 0 && Number.isFinite(s.sma200[i]) && s.closes[i] < s.sma200[i]) below++;
  }
  if (below < 20) return null;

  // Locate the reclaim bar.
  let reclaimBar = -1;
  if (cfg.followThrough) {
    // Reclaim happened on t-1..t-3; today is the confirming follow-through bar:
    // closes above the reclaim bar's high and still above SMA200.
    for (let r = t - 1; r >= t - 3 && r >= 0; r--) {
      if (reclaimAt(s, r) && s.closes[t] > s.candles[r].high && s.closes[t] > sma200) {
        reclaimBar = r;
        break;
      }
    }
  } else if (reclaimAt(s, t)) {
    reclaimBar = t;
  }
  if (reclaimBar < 0) return null;

  // Volume confirm on the reclaim bar.
  const rvol = s.avgVol20[reclaimBar] > 0
    ? s.candles[reclaimBar].volume / s.avgVol20[reclaimBar]
    : 0;
  if (!(rvol >= 1.5)) return null;

  // Basing — current 15-bar range ≤ 1.2× the prior 15-bar range (no vertical spike).
  const rangeOf = (a: number, b: number) => {
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = a; i <= b; i++) {
      if (i < 0) continue;
      if (s.candles[i].high > hi) hi = s.candles[i].high;
      if (s.candles[i].low < lo) lo = s.candles[i].low;
    }
    return hi - lo;
  };
  const cur = rangeOf(t - 14, t);
  const prior = rangeOf(t - 29, t - 15);
  if (!(prior > 0 && cur <= 1.2 * prior)) return null;

  // v2 gates.
  if (cfg.sma50Rising && !(s.sma50[t] > s.sma50[t - 10])) return null;
  if (cfg.minAdx > 0 && !(s.adx14[t] >= cfg.minAdx)) return null;

  // Suggested stop: recent swing low, floored at SMA200 − 1.5×ATR.
  let swingLow = Infinity;
  for (let i = t - 9; i <= t; i++) {
    if (i >= 0 && s.candles[i].low < swingLow) swingLow = s.candles[i].low;
  }
  const stop = Math.min(swingLow, sma200 - 1.5 * atr14);
  return { kind: 'sma200_reclaim', entryIdx: t, entry: s.closes[t], stop };
}

// =========================================================================
// Trade simulation + metrics (identical model to TRA-455).
// =========================================================================

interface Trade {
  symbol: string;
  kind: Kind;
  entryTs: number;
  exitTs: number;
  rMultiple: number;
  exitReason: 'stop' | 'target' | 'time' | 'eod';
  bars: number;
}

function simulateTrade(candles: Candle[], sig: Sig, tp: number): Trade {
  const { entryIdx, entry, stop } = sig;
  const rPrice = entry - stop;
  const target = entry + tp * rPrice;
  const slipR = (SLIPPAGE_BPS / 10_000) * (entry / rPrice);
  let exitPrice = entry;
  let exitIdx = entryIdx;
  let exitReason: Trade['exitReason'] = 'eod';
  for (let i = entryIdx + 1; i < candles.length && i <= entryIdx + MAX_HOLD_BARS; i++) {
    const bar = candles[i];
    exitIdx = i;
    if (bar.open <= stop) { exitPrice = bar.open; exitReason = 'stop'; break; }
    if (bar.open >= target) { exitPrice = bar.open; exitReason = 'target'; break; }
    if (bar.low <= stop) { exitPrice = stop; exitReason = 'stop'; break; }
    if (bar.high >= target) { exitPrice = target; exitReason = 'target'; break; }
    if (i === entryIdx + MAX_HOLD_BARS) { exitPrice = bar.close; exitReason = 'time'; break; }
  }
  if (exitReason === 'eod') exitPrice = candles[exitIdx].close;
  return {
    symbol: candles[entryIdx].symbol,
    kind: sig.kind,
    entryTs: candles[entryIdx].timestamp,
    exitTs: candles[exitIdx].timestamp,
    rMultiple: (exitPrice - entry) / rPrice - slipR,
    exitReason,
    bars: exitIdx - entryIdx,
  };
}

interface Metrics {
  trades: number;
  winRatePct: number;
  avgR: number;
  profitFactor: number;
  cagrPct: number;
  maxDrawdownPct: number;
  mar: number;
}

function metricsOf(trades: Trade[], years: number): Metrics {
  const n = trades.length;
  const rs = trades.map((t) => t.rMultiple);
  const wins = rs.filter((r) => r > 0);
  const grossWin = wins.reduce((s, r) => s + r, 0);
  const grossLoss = rs.filter((r) => r <= 0).reduce((s, r) => s + Math.abs(r), 0);
  const avgR = n > 0 ? rs.reduce((s, r) => s + r, 0) / n : 0;
  const ordered = [...trades].sort((a, b) => a.exitTs - b.exitTs);
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const tr of ordered) {
    equity *= 1 + RISK_PER_TRADE * tr.rMultiple;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const cagr = years > 0 && equity > 0 ? Math.pow(equity, 1 / years) - 1 : 0;
  return {
    trades: n,
    winRatePct: n > 0 ? (wins.length / n) * 100 : 0,
    avgR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    cagrPct: cagr * 100,
    maxDrawdownPct: maxDD * 100,
    mar: maxDD > 0 ? cagr / maxDD : Infinity,
  };
}

function buyHoldMar(candles: Candle[], years: number): number {
  const win = candles.filter((c) => c.timestamp >= TEST_START_MS && c.timestamp <= TO_MS);
  if (win.length < 2) return 0;
  const cagr = Math.pow(win[win.length - 1].close / win[0].close, 1 / years) - 1;
  let peak = win[0].close;
  let maxDD = 0;
  for (const c of win) {
    if (c.close > peak) peak = c.close;
    const dd = (peak - c.close) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD > 0 ? cagr / maxDD : Infinity;
}

// =========================================================================
// Walk-forward — collect every fired trade for one signal config.
// =========================================================================

function liquidityOk(s: Series, t: number): boolean {
  return s.closes[t] >= MIN_PRICE && s.avgDollarVol20[t] >= MIN_AVG_DOLLAR_VOL;
}

function collectPullback(seriesList: Series[], cfg: PullbackCfg, tp: number): Trade[] {
  const trades: Trade[] = [];
  for (const s of seriesList) {
    let lastFire = -Infinity;
    for (let t = 249; t < s.candles.length; t++) {
      if (s.candles[t].timestamp < TEST_START_MS) continue;
      if (!liquidityOk(s, t)) continue;
      const sig = evalPullback(s, t, cfg);
      if (!sig) continue;
      if (t - lastFire < DEBOUNCE_BARS) continue;
      lastFire = t;
      if (sig.entry <= sig.stop) continue;
      trades.push(simulateTrade(s.candles, sig, tp));
    }
  }
  return trades;
}

function collectReclaim(seriesList: Series[], cfg: ReclaimCfg, tp: number): Trade[] {
  const trades: Trade[] = [];
  for (const s of seriesList) {
    let lastFire = -Infinity;
    for (let t = 249; t < s.candles.length; t++) {
      if (s.candles[t].timestamp < TEST_START_MS) continue;
      if (!liquidityOk(s, t)) continue;
      const sig = evalReclaim(s, t, cfg);
      if (!sig) continue;
      if (t - lastFire < DEBOUNCE_BARS) continue;
      lastFire = t;
      if (sig.entry <= sig.stop) continue;
      trades.push(simulateTrade(s.candles, sig, tp));
    }
  }
  return trades;
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '∞';
}

// =========================================================================

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  console.log('TRA-458 — SMA-200 signals v2 revision: re-running the TRA-455 acceptance gate\n');

  const bars: Record<string, Candle[]> = {};
  for (const sym of [...UNIVERSE, BENCHMARK]) {
    bars[sym] = await loadOrFetchDailyBars(sym, FETCH_START_MS, TO_MS);
    process.stdout.write(`  ${sym}`);
  }
  console.log('\n');

  const years = (TO_MS - TEST_START_MS) / (365.25 * 864e5);
  const seriesList = UNIVERSE.map((s) => buildSeries(bars[s]));
  const spyMar = buyHoldMar(bars[BENCHMARK], years);
  console.log(`Test window: 2022-01-01 → 2026-05-18 (${years.toFixed(2)}y)   SPY buy-and-hold MAR = ${fmt(spyMar)}\n`);

  const pass = (m: Metrics) => m.profitFactor > 1.3 && m.mar > spyMar;

  // ---- Signal 2 (pullback) config sweep ---------------------------------
  const pullbackCfgs: { name: string; cfg: PullbackCfg }[] = [
    { name: 'v1-baseline (rsi40)',          cfg: { requireGoldenCross: false, minSlope20: 0,     minAdx: 0,  trigger: 'rsi40' } },
    { name: 'priorHigh trigger',            cfg: { requireGoldenCross: false, minSlope20: 0,     minAdx: 0,  trigger: 'priorHigh' } },
    { name: 'priorHigh + goldenCross',      cfg: { requireGoldenCross: true,  minSlope20: 0,     minAdx: 0,  trigger: 'priorHigh' } },
    { name: 'priorHigh + slope≥1.0%',       cfg: { requireGoldenCross: false, minSlope20: 0.010, minAdx: 0,  trigger: 'priorHigh' } },
    { name: 'priorHigh + slope≥1.5%',       cfg: { requireGoldenCross: false, minSlope20: 0.015, minAdx: 0,  trigger: 'priorHigh' } },
    { name: 'priorHigh + slope≥2.0%',       cfg: { requireGoldenCross: false, minSlope20: 0.020, minAdx: 0,  trigger: 'priorHigh' } },
    { name: 'priorHigh + slope≥2.5%',       cfg: { requireGoldenCross: false, minSlope20: 0.025, minAdx: 0,  trigger: 'priorHigh' } },
    { name: 'priorHigh + slope≥3.0%',       cfg: { requireGoldenCross: false, minSlope20: 0.030, minAdx: 0,  trigger: 'priorHigh' } },
    { name: 'priorHigh + GC + slope≥2.0%',  cfg: { requireGoldenCross: true,  minSlope20: 0.020, minAdx: 0,  trigger: 'priorHigh' } },
    { name: 'priorHigh + ADX≥20',           cfg: { requireGoldenCross: false, minSlope20: 0,     minAdx: 20, trigger: 'priorHigh' } },
    { name: 'rsi40 + slope≥2.0%',           cfg: { requireGoldenCross: false, minSlope20: 0.020, minAdx: 0,  trigger: 'rsi40' } },
  ];

  // ---- Signal 3 (reclaim) config sweep ----------------------------------
  const reclaimCfgs: { name: string; cfg: ReclaimCfg }[] = [
    { name: 'v1-baseline',                  cfg: { followThrough: false, sma50Rising: false, minAdx: 0 } },
    { name: 'followThrough',                cfg: { followThrough: true,  sma50Rising: false, minAdx: 0 } },
    { name: 'followThrough + sma50Rising',  cfg: { followThrough: true,  sma50Rising: true,  minAdx: 0 } },
    { name: 'followThrough + ADX≥20',       cfg: { followThrough: true,  sma50Rising: false, minAdx: 20 } },
    { name: 'followThrough + sma50R + ADX20', cfg: { followThrough: true, sma50Rising: true, minAdx: 20 } },
  ];

  const line = (label: string, m: Metrics, gate: boolean) =>
    `  ${label.padEnd(30)} n=${String(m.trades).padStart(3)}  win=${fmt(m.winRatePct, 1).padStart(5)}%  ` +
    `avgR=${fmt(m.avgR).padStart(5)}  PF=${fmt(m.profitFactor).padStart(5)}  ` +
    `CAGR=${fmt(m.cagrPct, 1).padStart(5)}%  maxDD=${fmt(m.maxDrawdownPct, 1).padStart(5)}%  ` +
    `MAR=${fmt(m.mar).padStart(5)}  ${gate ? 'PASS ✅' : 'fail'}`;

  const report: Record<string, unknown> = {
    issue: 'TRA-458',
    generatedAt: new Date().toISOString(),
    window: { testStart: '2022-01-01', testEnd: '2026-05-18', years: Number(years.toFixed(2)) },
    spyBuyHoldMar: spyMar,
    shipGate: 'profit factor > 1.3 AND MAR > SPY buy-and-hold MAR',
    primaryTp: TP_PRIMARY,
  };

  console.log(`Signal 2 — pullback v2 sweep (primary TP = ${TP_PRIMARY}R):`);
  const pbResults = pullbackCfgs.map(({ name, cfg }) => {
    const m = metricsOf(collectPullback(seriesList, cfg, TP_PRIMARY), years);
    const tpSweep = TP_SENSITIVITY.map((tp) => ({ tp, m: metricsOf(collectPullback(seriesList, cfg, tp), years) }));
    const g = pass(m);
    console.log(line(name, m, g));
    return { name, cfg, primary: m, gate: g, tpSweep };
  });

  console.log(`\nSignal 3 — reclaim v2 sweep (primary TP = ${TP_PRIMARY}R):`);
  const rcResults = reclaimCfgs.map(({ name, cfg }) => {
    const m = metricsOf(collectReclaim(seriesList, cfg, TP_PRIMARY), years);
    const tpSweep = TP_SENSITIVITY.map((tp) => ({ tp, m: metricsOf(collectReclaim(seriesList, cfg, tp), years) }));
    const g = pass(m);
    console.log(line(name, m, g));
    return { name, cfg, primary: m, gate: g, tpSweep };
  });

  // ---- TP-robustness detail for the best config of each signal ----------
  const bestPb = [...pbResults].sort((a, b) => b.primary.profitFactor - a.primary.profitFactor)[0];
  const bestRc = [...rcResults].sort((a, b) => b.primary.profitFactor - a.primary.profitFactor)[0];
  console.log('\nTP robustness — best pullback config:', bestPb.name);
  for (const x of bestPb.tpSweep) {
    console.log(`  TP=${x.tp}R  PF=${fmt(x.m.profitFactor)}  win=${fmt(x.m.winRatePct, 1)}%  MAR=${fmt(x.m.mar)}  n=${x.m.trades}`);
  }
  console.log('TP robustness — best reclaim config:', bestRc.name);
  for (const x of bestRc.tpSweep) {
    console.log(`  TP=${x.tp}R  PF=${fmt(x.m.profitFactor)}  win=${fmt(x.m.winRatePct, 1)}%  MAR=${fmt(x.m.mar)}  n=${x.m.trades}`);
  }

  const anyPass = [...pbResults, ...rcResults].some((r) => r.gate);
  console.log(`\nGATE RESULT: ${anyPass ? 'at least one v2 config PASSES ✅' : 'no v2 config clears the gate ❌'}`);

  report.signal2_pullback = pbResults;
  report.signal3_reclaim = rcResults;
  report.anyConfigPasses = anyPass;
  const path = resolve(REPORT_DIR, 'tra458-validation.json');
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
