/**
 * TRA-296 — Phase-1.2.1 regime-gated mean-reversion long §8 walk-forward
 * sweep on 4H r9 (SOL + DOGE).
 *
 * Routed forward from TRA-295 (mean-reversion long sweep — 2/9 binding,
 * regime-conditional edge: deep alpha in alt-favorable windows W0/W5,
 * deep losses in BTC-dominance windows W2/W3/W4) and unblocked by
 * TRA-294 ratifying the universe-aware 25% rolling-90d DD bar for the
 * SOL+DOGE 4H r9 universe at these strategy params.
 *
 * This child layers a daily BTC-dominance regime gate on top of the same
 * trigger family TRA-295 wired and tightens ATR-pullback selectivity
 * (which fired 2.2× the volume of BB-reentry pre-route at similar
 * negative expectancy).
 *
 * Triggers
 * --------
 *
 *   - BB-reentry-long (UNCHANGED from TRA-295): 4H close at/below the
 *     lower Bollinger band (20-period mean, 2.0σ) on bar i-1, AND 4H close
 *     back inside the band (above the lower band) on bar i, AND RSI(14)
 *     reversing up from < 30 (RSI[i] > RSI[i-1] AND RSI[i-1] < 30).
 *     Entry on the open of bar i+1.
 *
 *   - ATR-pullback-long (TIGHTENED from TRA-295): 4H close has pulled back
 *     ≥ 2.5×ATR(14) below the 50-period EMA on bar i-1 (was ≥ 2.0×),
 *     AND 4H close on bar i shows a bullish reversal (close[i] > open[i]
 *     AND close[i] > close[i-1]) with volume[i] > 1.5× the 20-bar volume
 *     mean (was > 1.2×), AND RSI(14)[i-1] < 40 (NEW — oversold confirm
 *     on the pullback bar). Entry on the open of bar i+1.
 *
 * BTC-dominance regime gate (new, binding)
 * ----------------------------------------
 *
 * Daily BTC-dominance series with a 50-period SMA filter:
 *
 *   - Signal: btcDominance[d] < SMA(btcDominance, 50)[d]   (alt-favorable)
 *   - Application: on 4H bar i, look up the most-recent-completed daily
 *     BTC.D close. If it is ≥ SMA(50), suppress the entry. If below, allow.
 *   - Warm-up: extends back regardless of test-span boundary (analogous to
 *     ATR(14) / EMA(50) handling in the trigger family). The synthetic-
 *     dominance daily series starts at 2022-01-01 so all 9 windows have
 *     ≥ 50 prior daily closes available.
 *
 * Source — synthetic 5-coin basket (LeadDev choice)
 *
 *   The lowest-friction reproducible source available offline is a
 *   synthetic dominance series computed from the existing daily Coinbase
 *   caches for the top 5 USD-listed coins (BTC, ETH, SOL, DOGE, XRP)
 *   weighted by approximate mid-period circulating supply constants.
 *
 *   Rationale: TradingView CRYPTOCAP:BTC.D is not directly fetchable via
 *   the existing data-loader path (Yahoo daily / Coinbase 1H/4H). The
 *   CoinGecko free public API caps historical per-coin market_chart at
 *   365 days (we need ≥ 1000d for warm-up + 9 windows), and global
 *   historical-mcap is Pro-only. Coinpaprika is also 1y-capped on free.
 *   Binance pair flows would require new infra. The 5-coin synthetic
 *   from existing caches needs no network and is deterministic.
 *
 *   Documented proxy nature: the synthetic basket overstates BTC's
 *   absolute dominance (5-coin basket excludes USDT/USDC/BNB/etc.) but
 *   tracks the *trend* of real CRYPTOCAP:BTC.D — what the regime gate
 *   actually cares about. ETH/SOL/DOGE/XRP are precisely the alts that
 *   move in alt-favorable regimes, so the basket is appropriate for the
 *   alt-favorable vs BTC-favorable regime classification.
 *
 *   Constant supplies (mid-period 2024 approximations) drift < 1% per
 *   50d window so the rolling-SMA-vs-current-level signal is unaffected.
 *
 * Risk knobs (UNCHANGED from TRA-292 / TRA-295)
 * ---------------------------------------------
 *
 *   - 1% account risk per trade
 *   - ATR-2.0 initial stop below entry
 *   - 1:2 R:R minimum target
 *   - ATR-trail engages at +1R favorable; trail = high-water close − 2.0×ATR
 *
 * §5.1 funding gate stays wired direction-aware (no-op for longs).
 *
 * Walk-forward (UNCHANGED from TRA-287 / TRA-292 / TRA-294 / TRA-295)
 * -------------------------------------------------------------------
 *
 *   XRP-aligned start (2023-07-13T20:00Z), train=1080×4H, test=540×4H,
 *   step=540×4H, 9 windows.
 *
 * Acceptance bar (§8 — task spec, all four bars binding now)
 * ----------------------------------------------------------
 *
 *   - Density: ≥ 4 trades / window (post-gate)
 *   - Hit rate: ≥ 35%
 *   - Expectancy: ≥ +0.10R
 *   - Rolling-90d DD: ≤ 25%   (binding now per §8.1 amendment, §8.1
 *                              ratified TRA-294 → see reports/SPEC.md)
 *   - Pass: clear all four on ≥ 5 of 9 windows.
 *
 * §8.1 amendment — universe-aware rolling-90d DD bar (verbatim from
 * TRA-294 ratification comment, applied here as first-downstream-consumer
 * record per task §1):
 *
 *   §8 amendment — universe-aware rolling-90d DD bar.
 *
 *   The §8 rolling-90d DD bar SHALL be calibrated per-universe rather
 *   than as a single global value. For each universe + strategy-params
 *   combination, the bar SHALL be derived as:
 *
 *       bar_universe = ceil_to_5pct(p99(synthetic_MC_DD) + 1.5%)
 *
 *   where synthetic_MC_DD is the distribution of max in-window equity-
 *   drawdowns across n=1000 Monte-Carlo paths of a hardcoded-outcome
 *   strategy with the universe's spec params: per-trade-risk fraction,
 *   hit rate, reward:risk ratio, and trade density (trades / window).
 *   Trade outcomes are i.i.d. Bernoulli(hit_rate) → +reward_R or -risk_R,
 *   applied as multiplicative steps on current equity. The 1.5% additive
 *   buffer covers residual intra-trade DD that ATR-stop sizing does not
 *   absorb.
 *
 *   Rationale: when position sizing is risk-normalised via ATR-stops at
 *   a fixed per-trade-risk fraction, equity-DD does NOT scale linearly
 *   with underlying σ — the σ effect is largely absorbed by ATR sizing.
 *   A simple linear vol scaling (bar = 8% × σ_uni / σ_SPY) over-scales
 *   and lands at the passive buy-and-hold floor on high-σ universes,
 *   failing to discriminate active alpha from passive exposure.
 *
 *   For the SOL+DOGE 4H r9 universe (30% hit / 1:2 R:R / 1.0% risk /
 *   ~38 trades per 90-day window) the resulting bar is 25%. The
 *   original 8% bar SHALL remain in force on the Phase-1 stock universe
 *   at its native strategy params.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra296-meanrev-long-regime-sweep.ts
 *
 * Outputs:
 *   reports/tra296-sweep-4h-r9-meanrev-long-regime.md
 *   reports/tra296-sweep-4h-r9-meanrev-long-regime.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { atr, ema, rsi } from '@trading-app/engine';
import { loadOrFetch4hBars, loadOrFetchDailyBars } from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');
const DATA_DIR = resolve(HERE, '..', 'data');
const DOMINANCE_CACHE = resolve(DATA_DIR, 'btc-dominance-synthetic.json');

// ── Spec constants (task TRA-296) ─────────────────────────────────────────

const UNIVERSE = ['SOL-USD', 'DOGE-USD'] as const;

const INITIAL_EQUITY_USD = 25_000;
const FEE_BPS = 40;
const SLIPPAGE_BPS = 5;
const RISK_FRACTION = 0.01;

const ATR_K_STOP = 2.0;
const ATR_K_TRAIL = 2.0;
const RR_MIN = 2.0;
const TRAIL_ARM_R = 1.0;

// BB-reentry-long trigger — UNCHANGED from TRA-295
const BB_PERIOD = 20;
const BB_MULT = 2.0;
const BB_RSI_PERIOD = 14;
const BB_RSI_OVERSOLD = 30;

// ATR-pullback-long trigger — TIGHTENED per task §3
const ATR_PB_PERIOD = 14;
const ATR_PB_EMA_PERIOD = 50;
const ATR_PB_DEPTH = 2.5;        // was 2.0 (TRA-295) — deeper pullback required
const ATR_PB_VOL_LOOKBACK = 20;
const ATR_PB_VOL_MULT = 1.5;     // was 1.2 (TRA-295) — heavier confirm volume
const ATR_PB_RSI_MAX = 40;       // NEW — oversold confirm RSI(14)[i-1] < 40

// BTC-dominance regime gate — task §2
const BTC_D_SMA_PERIOD = 50;     // daily 50-period SMA on dominance series

// Synthetic basket (mid-period 2024 circulating-supply constants).
const BASKET = [
  { symbol: 'BTC-USD',  supply: 19_500_000        },
  { symbol: 'ETH-USD',  supply: 120_000_000       },
  { symbol: 'SOL-USD',  supply: 400_000_000       },
  { symbol: 'DOGE-USD', supply: 144_000_000_000   },
  { symbol: 'XRP-USD',  supply: 55_000_000_000    },
] as const;

// Walk-forward — UNCHANGED from TRA-287 / TRA-292 / TRA-294 / TRA-295
const TRAIN_BARS = 180 * 6;      // 1080 × 4H ≈ 6 months
const TEST_BARS = 90 * 6;        // 540  × 4H ≈ 3 months
const STEP_BARS = TEST_BARS;
const ROLLING_DD_BARS = 90 * 6;

// XRP-aligned start (calendar-identical with TRA-287/292/294/295)
const ALIGNED_START_TS = Date.UTC(2023, 6, 13, 20);
const FROM_MS = Date.UTC(2022, 0, 1);

// §8 binding bar — recalibrated 25% per TRA-294 ratification (now binding
// for pass/fail; the diagnostic 8% column is dropped — it was already
// ratified out of force on this universe).
const DD_BAR_PCT = 25;

const SKIP_NO_TRIGGER = 'no trigger emitted';
const SKIP_BTCD_WARMUP = '§2 btc.d sma(50) warm-up insufficient';
const SKIP_FUNDING_LONG_NOOP = '§5.1 funding gate (no-op for longs)';
const SKIP_ZERO_ATR = 'zero ATR — skipped';
const SKIP_ZERO_QTY = 'zero qty';
const SKIP_NEXT_BAR_MISSING = 'no next bar — entry impossible';
const SKIP_EQUITY_EXHAUSTED = 'equity exhausted';
// Per-trigger pre-gate fire counts (every fire, before regime gate).
const FIRED_PRE_GATE_BB = 'fired_pre_gate: bb_reentry_long';
const FIRED_PRE_GATE_ATR = 'fired_pre_gate: atr_pullback_long';
// Per-trigger post-gate "tradeable" counts (fired AND regime gate passed).
const POST_GATE_BB = 'post_gate_tradeable: bb_reentry_long';
const POST_GATE_ATR = 'post_gate_tradeable: atr_pullback_long';
// Per-trigger gated counts (fired AND regime gate suppressed).
const GATED_BB_BTCD = '§2 gated_by_btcd: bb_reentry_long';
const GATED_ATR_BTCD = '§2 gated_by_btcd: atr_pullback_long';

type Side = 'buy';
type SignalType = 'bb_reentry_long' | 'atr_pullback_long';
type ExitReason = 'target' | 'stop' | 'trailing' | 'time_stop';

interface LongSignal {
  symbol: string;
  type: SignalType;
  detectedAt: number;
  entryAt: number;
  entryPrice: number;
  initialStop: number;
  takeProfit: number;
  atrAtTrigger: number;
}

interface OpenLong {
  signal: LongSignal;
  side: Side;
  symbol: string;
  type: SignalType;
  entryFill: number;
  qty: number;
  initialStop: number;
  currentStop: number;
  takeProfit: number;
  atrAtTrigger: number;
  highWaterClose: number;
  trailArmed: boolean;
  openedAt: number;
  barsHeld: number;
}

interface ClosedLong {
  symbol: string;
  signalType: SignalType;
  side: Side;
  openedAt: number;
  closedAt: number;
  entryFill: number;
  exitFill: number;
  qty: number;
  pnlUsd: number;
  rMultiple: number;
  exitReason: ExitReason;
  initialStop: number;
}

interface SimReport {
  closedLongs: ClosedLong[];
  equityCurve: Array<{ ts: number; equity: number }>;
  skipReasons: Map<string, number>;
}

interface WindowReport extends SimReport {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  index: number;
}

interface PerSymbolMetrics {
  symbol: string;
  trades: number;
  winners: number;
  hitRatePct: number;
  expectancyR: number;
  totalPnlUsd: number;
}

interface PerTriggerMetrics {
  trigger: SignalType;
  trades: number;
  winners: number;
  hitRatePct: number;
  expectancyR: number;
}

interface UniverseMetrics {
  trades: number;
  winners: number;
  hitRatePct: number;
  expectancyR: number;
  totalPnlUsd: number;
  rollingMaxDrawdownPct: number;
  /** §8 pass result: trades + hit + expectancy + DD all binding. */
  passes: boolean;
  reasons: string[];
  passesDdBar: boolean;
}

// ── Cost model ────────────────────────────────────────────────────────────

const slipRate = SLIPPAGE_BPS / 10_000;
const feeRate = FEE_BPS / 10_000;

function applyEntrySlippage(side: Side, entryPrice: number): number {
  return side === 'buy' ? entryPrice * (1 + slipRate) : entryPrice * (1 - slipRate);
}

function applyExitSlippage(side: Side, rawExit: number): number {
  return side === 'buy' ? rawExit * (1 - slipRate) : rawExit * (1 + slipRate);
}

function netPnl(side: Side, entryFill: number, exitFill: number, qty: number): number {
  const dir = side === 'buy' ? 1 : -1;
  const gross = (exitFill - entryFill) * qty * dir;
  const commission = entryFill * qty * feeRate + exitFill * qty * feeRate;
  return gross - commission;
}

function rMultiple(side: Side, entryFill: number, exitFill: number, initialStop: number): number {
  const stopDistance = Math.abs(entryFill - initialStop);
  if (stopDistance === 0) return 0;
  const dir = side === 'buy' ? 1 : -1;
  return ((exitFill - entryFill) * dir) / stopDistance;
}

// ── Indicator helpers ─────────────────────────────────────────────────────

function trailingMean(values: number[], period: number, endIdxExclusive: number): number {
  if (endIdxExclusive < period) return NaN;
  let sum = 0;
  for (let i = endIdxExclusive - period; i < endIdxExclusive; i++) sum += values[i];
  return sum / period;
}

interface BollingerBar {
  middle: number;
  upper: number;
  lower: number;
}

function bollingerAt(closes: number[], period: number, mult: number, endIdxInclusive: number): BollingerBar | null {
  if (endIdxInclusive + 1 < period) return null;
  const start = endIdxInclusive + 1 - period;
  let sum = 0;
  for (let i = start; i <= endIdxInclusive; i++) sum += closes[i];
  const sma = sum / period;
  let variance = 0;
  for (let i = start; i <= endIdxInclusive; i++) variance += (closes[i] - sma) ** 2;
  variance /= period;
  const sd = Math.sqrt(variance);
  return { middle: sma, upper: sma + mult * sd, lower: sma - mult * sd };
}

interface PreCompute {
  rsi: number[];
  atr14: number[];
  ema50: number[];
  bbLower: number[];
  bbUpper: number[];
  volMean20: number[];
}

function preCompute(bars: Candle[]): PreCompute {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume);

  const rsiSeries = new Array<number>(n).fill(NaN);
  const atrSeries = new Array<number>(n).fill(NaN);
  const ema50Series = new Array<number>(n).fill(NaN);
  const bbLowerSeries = new Array<number>(n).fill(NaN);
  const bbUpperSeries = new Array<number>(n).fill(NaN);
  const volMeanSeries = new Array<number>(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const closeWindow = closes.slice(0, i + 1);
    const candleWindow = bars.slice(0, i + 1);
    const rv = rsi(closeWindow, BB_RSI_PERIOD);
    const av = atr(candleWindow, ATR_PB_PERIOD);
    const ev = ema(closeWindow, ATR_PB_EMA_PERIOD);
    rsiSeries[i] = Number.isFinite(rv) ? rv : NaN;
    atrSeries[i] = av ?? NaN;
    ema50Series[i] = Number.isFinite(ev) ? ev : NaN;

    const bb = bollingerAt(closes, BB_PERIOD, BB_MULT, i);
    if (bb) {
      bbLowerSeries[i] = bb.lower;
      bbUpperSeries[i] = bb.upper;
    }
  }

  for (let i = 0; i < n; i++) {
    volMeanSeries[i] = trailingMean(vols, ATR_PB_VOL_LOOKBACK, i);
  }

  return {
    rsi: rsiSeries,
    atr14: atrSeries,
    ema50: ema50Series,
    bbLower: bbLowerSeries,
    bbUpper: bbUpperSeries,
    volMean20: volMeanSeries,
  };
}

// ── Synthetic BTC-dominance series ────────────────────────────────────────

interface DominancePoint {
  ts: number;          // start-of-day ts (daily bar timestamp)
  dominance: number;   // BTC_mcap / Σ basket_mcaps
  sma50: number | null;
}

interface DominanceSeries {
  points: DominancePoint[];
  /** Returns the most-recent-completed daily dominance bar at 4H ts `t`,
   *  or null if warm-up insufficient (no daily close ≥ SMA period prior). */
  lookup: (ts4h: number) => DominancePoint | null;
}

async function loadSyntheticBtcDominanceDaily(fromMs: number, toMs: number): Promise<DominanceSeries> {
  // Try cache first.
  let points: DominancePoint[] | null = null;
  if (existsSync(DOMINANCE_CACHE)) {
    try {
      const raw = JSON.parse(readFileSync(DOMINANCE_CACHE, 'utf-8'));
      if (
        Array.isArray(raw.points) &&
        raw.points.length > 0 &&
        raw.basketSig === basketSignature() &&
        raw.points[0].ts <= fromMs &&
        raw.points[raw.points.length - 1].ts >= toMs - 24 * 60 * 60 * 1000
      ) {
        points = raw.points;
      }
    } catch { /* fall through to recompute */ }
  }

  if (!points) {
    const series = new Map<string, Candle[]>();
    for (const c of BASKET) {
      series.set(c.symbol, await loadOrFetchDailyBars(c.symbol, fromMs, toMs));
    }

    // Intersect timestamps across all 5 daily series.
    const all = BASKET.map((c) => series.get(c.symbol)!);
    const tsSets = all.map((arr) => new Set(arr.map((b) => b.timestamp)));
    const baseTs = all[0].map((b) => b.timestamp).filter((ts) => tsSets.every((s) => s.has(ts)));

    // Per-symbol close lookup.
    const closeMaps = new Map<string, Map<number, number>>();
    for (const c of BASKET) {
      const m = new Map<number, number>();
      for (const b of series.get(c.symbol)!) m.set(b.timestamp, b.close);
      closeMaps.set(c.symbol, m);
    }

    const raw: { ts: number; dominance: number }[] = [];
    for (const ts of baseTs) {
      let total = 0;
      let btc = 0;
      for (const c of BASKET) {
        const close = closeMaps.get(c.symbol)!.get(ts)!;
        const mcap = close * c.supply;
        total += mcap;
        if (c.symbol === 'BTC-USD') btc = mcap;
      }
      if (total > 0) raw.push({ ts, dominance: btc / total });
    }

    // Compute SMA(50) over the dominance series in-place.
    points = raw.map((p, i) => {
      if (i + 1 < BTC_D_SMA_PERIOD) return { ...p, sma50: null };
      let sum = 0;
      for (let k = i + 1 - BTC_D_SMA_PERIOD; k <= i; k++) sum += raw[k].dominance;
      return { ...p, sma50: sum / BTC_D_SMA_PERIOD };
    });

    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DOMINANCE_CACHE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      basketSig: basketSignature(),
      basket: BASKET,
      smaPeriod: BTC_D_SMA_PERIOD,
      points,
    }, null, 2));
  }

  // Build O(log n) lookup keyed by "most-recent-completed daily" semantics.
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const lookup = (ts4h: number): DominancePoint | null => {
    // Most-recent-completed daily means: a daily bar whose close happened
    // strictly before bar i's open. A daily bar at timestamp `D_ts`
    // covers [D_ts, D_ts + 24h] and closes at D_ts + 24h. So we want the
    // largest `D_ts` with `D_ts + 24h ≤ ts4h`.
    const cutoff = ts4h - 24 * 60 * 60 * 1000;
    let lo = 0;
    let hi = sorted.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].ts <= cutoff) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found >= 0 ? sorted[found] : null;
  };

  return { points: sorted, lookup };
}

function basketSignature(): string {
  return BASKET.map((c) => `${c.symbol}=${c.supply}`).join('|') + `;sma=${BTC_D_SMA_PERIOD}`;
}

// ── Trigger evaluation ────────────────────────────────────────────────────

function detectBbReentryLong(bars: Candle[], pc: PreCompute, i: number): LongSignal | null {
  if (i <= 0 || i + 1 >= bars.length) return null;

  const closePrev = bars[i - 1].close;
  const closeCurr = bars[i].close;

  const bbPrevLower = pc.bbLower[i - 1];
  const bbCurrLower = pc.bbLower[i];
  if (!Number.isFinite(bbPrevLower) || !Number.isFinite(bbCurrLower)) return null;
  if (!(closePrev <= bbPrevLower)) return null;
  if (!(closeCurr > bbCurrLower)) return null;

  const rsiPrev = pc.rsi[i - 1];
  const rsiCurr = pc.rsi[i];
  if (!Number.isFinite(rsiPrev) || !Number.isFinite(rsiCurr)) return null;
  if (!(rsiPrev < BB_RSI_OVERSOLD)) return null;
  if (!(rsiCurr > rsiPrev)) return null;

  const atrCurr = pc.atr14[i];
  if (!Number.isFinite(atrCurr) || atrCurr <= 0) return null;

  const entry = bars[i + 1].open;
  const stopDist = ATR_K_STOP * atrCurr;
  return {
    symbol: bars[i + 1].symbol,
    type: 'bb_reentry_long',
    detectedAt: bars[i].timestamp,
    entryAt: bars[i + 1].timestamp,
    entryPrice: entry,
    initialStop: entry - stopDist,
    takeProfit: entry + RR_MIN * stopDist,
    atrAtTrigger: atrCurr,
  };
}

/**
 * ATR-pullback-long (TIGHTENED per task §3): close[i-1] ≤ EMA50[i-1] −
 * 2.5×ATR(14)[i-1] AND RSI(14)[i-1] < 40 AND bullish reversal candle on
 * bar i (close>open, close>close[i-1]) AND volume[i] > 1.5× mean(vol,20).
 */
function detectAtrPullbackLong(bars: Candle[], pc: PreCompute, i: number): LongSignal | null {
  if (i <= 0 || i + 1 >= bars.length) return null;

  const closePrev = bars[i - 1].close;
  const ema50Prev = pc.ema50[i - 1];
  const atrPrev = pc.atr14[i - 1];
  const rsiPrev = pc.rsi[i - 1];
  if (!Number.isFinite(ema50Prev) || !Number.isFinite(atrPrev) || atrPrev <= 0) return null;
  if (!Number.isFinite(rsiPrev)) return null;
  if (!(closePrev <= ema50Prev - ATR_PB_DEPTH * atrPrev)) return null;
  if (!(rsiPrev < ATR_PB_RSI_MAX)) return null;

  const closeCurr = bars[i].close;
  const openCurr = bars[i].open;
  if (!(closeCurr > openCurr)) return null;
  if (!(closeCurr > closePrev)) return null;

  const volCurr = bars[i].volume;
  const volMean = pc.volMean20[i];
  if (!Number.isFinite(volMean) || volMean <= 0) return null;
  if (!(volCurr > ATR_PB_VOL_MULT * volMean)) return null;

  const atrCurr = pc.atr14[i];
  if (!Number.isFinite(atrCurr) || atrCurr <= 0) return null;

  const entry = bars[i + 1].open;
  const stopDist = ATR_K_STOP * atrCurr;
  return {
    symbol: bars[i + 1].symbol,
    type: 'atr_pullback_long',
    detectedAt: bars[i].timestamp,
    entryAt: bars[i + 1].timestamp,
    entryPrice: entry,
    initialStop: entry - stopDist,
    takeProfit: entry + RR_MIN * stopDist,
    atrAtTrigger: atrCurr,
  };
}

// ── Multi-symbol simulation ───────────────────────────────────────────────

interface SimInput {
  candlesBySymbol: Map<string, Candle[]>;
  dominance: DominanceSeries;
}

function runLongSim(input: SimInput): SimReport {
  const symbols = Array.from(input.candlesBySymbol.keys());

  const preBySymbol = new Map<string, PreCompute>();
  for (const sym of symbols) preBySymbol.set(sym, preCompute(input.candlesBySymbol.get(sym)!));

  const tsSets = symbols.map((s) => new Set(input.candlesBySymbol.get(s)!.map((c) => c.timestamp)));
  const baseTimestamps = symbols.length > 0
    ? input.candlesBySymbol.get(symbols[0])!.map((c) => c.timestamp).filter((ts) => tsSets.every((set) => set.has(ts)))
    : [];

  const idxBySymbol = new Map<string, number>();
  for (const sym of symbols) idxBySymbol.set(sym, 0);

  const openLongs: OpenLong[] = [];
  const closedLongs: ClosedLong[] = [];
  const equityCurve: Array<{ ts: number; equity: number }> = [];
  const skipReasons = new Map<string, number>();

  let cashUsd = INITIAL_EQUITY_USD;

  function bumpSkip(reason: string) {
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
  }

  function totalEquityUsd(latestCloseBySymbol: Map<string, number>): number {
    let unrealised = 0;
    for (const o of openLongs) {
      const px = latestCloseBySymbol.get(o.symbol);
      if (px === undefined) continue;
      unrealised += (px - o.entryFill) * o.qty;
    }
    return cashUsd + unrealised;
  }

  for (const ts of baseTimestamps) {
    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      let idx = idxBySymbol.get(sym)!;
      while (idx < bars.length && bars[idx].timestamp < ts) idx += 1;
      idxBySymbol.set(sym, idx);
    }

    const latestCloseBySymbol = new Map<string, number>();
    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx < bars.length && bars[idx].timestamp === ts) {
        latestCloseBySymbol.set(sym, bars[idx].close);
      }
    }

    // 1) Trigger evaluation per symbol.
    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;

      const pc = preBySymbol.get(sym)!;
      const bbSig = detectBbReentryLong(bars, pc, idx);
      const atrSig = detectAtrPullbackLong(bars, pc, idx);
      if (bbSig) bumpSkip(FIRED_PRE_GATE_BB);
      if (atrSig) bumpSkip(FIRED_PRE_GATE_ATR);

      // BTC.D regime gate — apply per trigger so post-gate counts are
      // independently auditable. The trigger that becomes the actual
      // entry candidate (BB precedence over ATR) flows through below.
      const dom = input.dominance.lookup(bars[idx].timestamp);
      const altFavorable = dom !== null && dom.sma50 !== null && dom.dominance < dom.sma50;

      if (bbSig) {
        if (dom === null || dom.sma50 === null) bumpSkip(SKIP_BTCD_WARMUP);
        else if (altFavorable) bumpSkip(POST_GATE_BB);
        else bumpSkip(GATED_BB_BTCD);
      }
      if (atrSig) {
        if (dom === null || dom.sma50 === null) bumpSkip(SKIP_BTCD_WARMUP);
        else if (altFavorable) bumpSkip(POST_GATE_ATR);
        else bumpSkip(GATED_ATR_BTCD);
      }

      // BB-reentry takes precedence when both fire.
      const sig = bbSig ?? atrSig;
      if (!sig) {
        bumpSkip(SKIP_NO_TRIGGER);
        continue;
      }
      if (!altFavorable) {
        // Already accounted in GATED_*_BTCD / SKIP_BTCD_WARMUP per trigger.
        continue;
      }

      // §5.1 funding gate — direction-aware no-op for longs (same as TRA-292/295).
      bumpSkip(SKIP_FUNDING_LONG_NOOP);

      const equityNow = totalEquityUsd(latestCloseBySymbol);
      if (equityNow <= 0) {
        bumpSkip(SKIP_EQUITY_EXHAUSTED);
        continue;
      }
      if (idx + 1 >= bars.length) {
        bumpSkip(SKIP_NEXT_BAR_MISSING);
        continue;
      }
      const stopDistance = sig.entryPrice - sig.initialStop;
      if (stopDistance <= 0) {
        bumpSkip(SKIP_ZERO_ATR);
        continue;
      }
      const riskUsd = equityNow * RISK_FRACTION;
      const qty = riskUsd / stopDistance;
      if (qty <= 0) {
        bumpSkip(SKIP_ZERO_QTY);
        continue;
      }

      const entryFill = applyEntrySlippage('buy', sig.entryPrice);
      openLongs.push({
        signal: sig,
        side: 'buy',
        symbol: sym,
        type: sig.type,
        entryFill,
        qty,
        initialStop: sig.initialStop,
        currentStop: sig.initialStop,
        takeProfit: sig.takeProfit,
        atrAtTrigger: sig.atrAtTrigger,
        highWaterClose: entryFill,
        trailArmed: false,
        openedAt: sig.entryAt,
        barsHeld: 0,
      });
    }

    // 2) Lifecycle for open longs at the current bar.
    for (const o of [...openLongs]) {
      const sym = o.symbol;
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;
      const latest = bars[idx];

      if (o.openedAt === ts) continue;

      o.barsHeld += 1;

      if (latest.close > o.highWaterClose) o.highWaterClose = latest.close;

      const oneR = o.entryFill - o.initialStop;
      if (!o.trailArmed && latest.close >= o.entryFill + TRAIL_ARM_R * oneR) {
        o.trailArmed = true;
      }

      if (o.trailArmed) {
        const proposed = o.highWaterClose - ATR_K_TRAIL * o.atrAtTrigger;
        if (proposed > o.currentStop) o.currentStop = proposed;
      }

      const hitsStop = latest.low <= o.currentStop;
      const hitsTarget = latest.high >= o.takeProfit;
      let exitReason: ExitReason | null = null;
      let rawExit = 0;
      if (hitsStop && hitsTarget) {
        rawExit = o.takeProfit;
        exitReason = 'target';
      } else if (hitsTarget) {
        rawExit = o.takeProfit;
        exitReason = 'target';
      } else if (hitsStop) {
        rawExit = o.currentStop;
        exitReason = o.currentStop !== o.initialStop ? 'trailing' : 'stop';
      }

      if (exitReason !== null) {
        const exitFill = applyExitSlippage('buy', rawExit);
        const pnl = netPnl('buy', o.entryFill, exitFill, o.qty);
        const r = rMultiple('buy', o.entryFill, exitFill, o.initialStop);
        cashUsd += pnl;
        closedLongs.push({
          symbol: sym,
          signalType: o.type,
          side: 'buy',
          openedAt: o.openedAt,
          closedAt: ts,
          entryFill: o.entryFill,
          exitFill,
          qty: o.qty,
          pnlUsd: pnl,
          rMultiple: r,
          exitReason,
          initialStop: o.initialStop,
        });
        const i = openLongs.indexOf(o);
        if (i >= 0) openLongs.splice(i, 1);
      }
    }

    // 3) Per-bar MTM equity curve point.
    equityCurve.push({ ts, equity: totalEquityUsd(latestCloseBySymbol) });
  }

  return { closedLongs, equityCurve, skipReasons };
}

// ── Walk-forward + window aggregation ─────────────────────────────────────

interface WindowSpec {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

function buildWindows(totalBars: number, trainBars: number, testBars: number, step: number): WindowSpec[] {
  const out: WindowSpec[] = [];
  let origin = 0;
  while (origin + trainBars + testBars <= totalBars) {
    out.push({
      trainStart: origin,
      trainEnd: origin + trainBars,
      testStart: origin + trainBars,
      testEnd: origin + trainBars + testBars,
    });
    origin += step;
  }
  return out;
}

function sliceCandles(candles: Candle[], startIdx: number, endIdx: number): Candle[] {
  return candles.slice(startIdx, endIdx);
}

interface WalkForwardOutput {
  windows: WindowReport[];
  equityCurve: Array<{ ts: number; equity: number }>;
  perWindow: Array<{
    index: number;
    metrics: UniverseMetrics;
    perSymbol: PerSymbolMetrics[];
    perTrigger: PerTriggerMetrics[];
  }>;
}

function runWalkForward(fullByPair: Map<string, Candle[]>, dominance: DominanceSeries): WalkForwardOutput {
  const symbols = Array.from(fullByPair.keys());
  const minLen = Math.min(...symbols.map((s) => fullByPair.get(s)!.length));
  const wins = buildWindows(minLen, TRAIN_BARS, TEST_BARS, STEP_BARS);
  const out: WalkForwardOutput = { windows: [], equityCurve: [], perWindow: [] };

  for (let i = 0; i < wins.length; i++) {
    const win = wins[i];
    const sliceMap = new Map<string, Candle[]>();
    for (const sym of symbols) {
      const all = fullByPair.get(sym)!;
      sliceMap.set(sym, sliceCandles(all, win.trainStart, win.testEnd));
    }
    const sim = runLongSim({ candlesBySymbol: sliceMap, dominance });

    const sampleSym = symbols[0];
    const sampleSlice = fullByPair.get(sampleSym)!;
    const testStartTs = sampleSlice[win.testStart].timestamp;
    const testEndTs = sampleSlice[Math.min(win.testEnd - 1, sampleSlice.length - 1)].timestamp;

    const testTrades = sim.closedLongs.filter((t) => t.openedAt >= testStartTs && t.openedAt <= testEndTs);
    const testEquity = sim.equityCurve.filter((p) => p.ts >= testStartTs && p.ts <= testEndTs);

    // Filter the skip-reason histogram to the test span. Re-run trigger
    // detection on the test slice only to get clean per-window pre/post-gate
    // counts (the sim's skipReasons covers train+test combined).
    const testSkipReasons = recomputeTestWindowSkipHistogram(
      sliceMap,
      dominance,
      testStartTs,
      testEndTs,
    );

    const windowReport: WindowReport = {
      ...sim,
      closedLongs: testTrades,
      equityCurve: testEquity,
      skipReasons: testSkipReasons,
      trainStart: win.trainStart,
      trainEnd: win.trainEnd,
      testStart: win.testStart,
      testEnd: win.testEnd,
      index: i,
    };

    out.windows.push(windowReport);
    out.equityCurve.push(...testEquity);

    const perSymbol = perSymbolMetrics(testTrades, symbols);
    const perTrigger = perTriggerMetrics(testTrades);
    const universe = universeMetrics(testTrades, testEquity, ROLLING_DD_BARS);
    out.perWindow.push({ index: i, metrics: universe, perSymbol, perTrigger });
  }

  return out;
}

/**
 * Re-walk the test span only, counting per-trigger pre-gate fires and
 * post-gate-tradeable counts. This is a no-side-effect read pass; the
 * authoritative simulation already happened in runLongSim. We just need
 * histogram numbers scoped to the test window for the report.
 */
function recomputeTestWindowSkipHistogram(
  candlesBySymbol: Map<string, Candle[]>,
  dominance: DominanceSeries,
  testStartTs: number,
  testEndTs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  for (const [_sym, bars] of candlesBySymbol) {
    const pc = preCompute(bars);
    for (let i = 0; i < bars.length; i++) {
      const ts = bars[i].timestamp;
      if (ts < testStartTs || ts > testEndTs) continue;
      const bbSig = detectBbReentryLong(bars, pc, i);
      const atrSig = detectAtrPullbackLong(bars, pc, i);
      if (bbSig) bump(FIRED_PRE_GATE_BB);
      if (atrSig) bump(FIRED_PRE_GATE_ATR);
      const dom = dominance.lookup(ts);
      const altFavorable = dom !== null && dom.sma50 !== null && dom.dominance < dom.sma50;
      if (bbSig) {
        if (dom === null || dom.sma50 === null) bump(SKIP_BTCD_WARMUP);
        else if (altFavorable) bump(POST_GATE_BB);
        else bump(GATED_BB_BTCD);
      }
      if (atrSig) {
        if (dom === null || dom.sma50 === null) bump(SKIP_BTCD_WARMUP);
        else if (altFavorable) bump(POST_GATE_ATR);
        else bump(GATED_ATR_BTCD);
      }
    }
  }
  return out;
}

function perSymbolMetrics(trades: ClosedLong[], symbols: string[]): PerSymbolMetrics[] {
  return symbols.map((sym) => {
    const ts = trades.filter((t) => t.symbol === sym);
    const winners = ts.filter((t) => t.pnlUsd > 0);
    const expectancy = ts.length > 0 ? ts.reduce((s, t) => s + t.rMultiple, 0) / ts.length : 0;
    const totalPnl = ts.reduce((s, t) => s + t.pnlUsd, 0);
    return {
      symbol: sym,
      trades: ts.length,
      winners: winners.length,
      hitRatePct: ts.length > 0 ? (winners.length / ts.length) * 100 : 0,
      expectancyR: expectancy,
      totalPnlUsd: totalPnl,
    };
  });
}

function perTriggerMetrics(trades: ClosedLong[]): PerTriggerMetrics[] {
  const types: SignalType[] = ['bb_reentry_long', 'atr_pullback_long'];
  return types.map((trigger) => {
    const ts = trades.filter((t) => t.signalType === trigger);
    const winners = ts.filter((t) => t.pnlUsd > 0);
    const expectancy = ts.length > 0 ? ts.reduce((s, t) => s + t.rMultiple, 0) / ts.length : 0;
    return {
      trigger,
      trades: ts.length,
      winners: winners.length,
      hitRatePct: ts.length > 0 ? (winners.length / ts.length) * 100 : 0,
      expectancyR: expectancy,
    };
  });
}

function universeMetrics(
  trades: ClosedLong[],
  equity: Array<{ ts: number; equity: number }>,
  rollingDdBars: number,
): UniverseMetrics {
  const winners = trades.filter((t) => t.pnlUsd > 0);
  const expectancy = trades.length > 0 ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const hitRatePct = trades.length > 0 ? (winners.length / trades.length) * 100 : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const rollingDD = rollingMaxDrawdownPct(equity, rollingDdBars);

  // All four bars binding (DD is binding now per §8.1 amendment).
  const reasons: string[] = [];
  if (trades.length < 4) reasons.push(`trades ${trades.length} < 4`);
  if (expectancy < 0.10) reasons.push(`expectancy ${expectancy.toFixed(3)}R < 0.10R`);
  if (hitRatePct < 35) reasons.push(`hit rate ${hitRatePct.toFixed(1)}% < 35%`);
  if (rollingDD > DD_BAR_PCT) reasons.push(`DD90 ${rollingDD.toFixed(1)}% > ${DD_BAR_PCT}%`);

  return {
    trades: trades.length,
    winners: winners.length,
    hitRatePct,
    expectancyR: expectancy,
    totalPnlUsd: totalPnl,
    rollingMaxDrawdownPct: rollingDD,
    passes: reasons.length === 0,
    reasons,
    passesDdBar: rollingDD <= DD_BAR_PCT,
  };
}

function rollingMaxDrawdownPct(curve: Array<{ ts: number; equity: number }>, windowBars: number): number {
  if (curve.length < 2) return 0;
  let worst = 0;
  for (let i = 0; i < curve.length; i++) {
    const lo = Math.max(0, i - windowBars + 1);
    let runningPeak = curve[lo].equity;
    let dd = 0;
    for (let j = lo; j <= i; j++) {
      const eq = curve[j].equity;
      if (eq > runningPeak) runningPeak = eq;
      if (runningPeak > 0) {
        const candidate = ((runningPeak - eq) / runningPeak) * 100;
        if (candidate > dd) dd = candidate;
      }
    }
    if (dd > worst) worst = dd;
  }
  return worst;
}

// ── Reporting ─────────────────────────────────────────────────────────────

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function buildReport(
  wf: WalkForwardOutput,
  symbols: string[],
  fullByPair: Map<string, Candle[]>,
  dominance: DominanceSeries,
  // TRA-295 per-window comparison source. If absent (fresh run), the
  // delta column will simply read "—".
  tra295Sidecar: TRA295Sidecar | null,
): string {
  const lines: string[] = [];
  lines.push('# TRA-296 — §8 Walk-Forward Sweep Report (4H Phase-1.2.1 regime-gated mean-reversion long — r9 SOL+DOGE)\n');
  lines.push(`Generated: ${new Date().toISOString()}\n`);
  lines.push('Granularity: 4h');
  lines.push(`Universe: ${symbols.join(', ')} (r9 binding — TRA-292 Momentum-long & Breakout-long parked for 4H/r9)`);
  const sample = fullByPair.get(symbols[0])!;
  lines.push(`Date span: ${fmtDate(sample[0].timestamp)} → ${fmtDate(sample[sample.length - 1].timestamp)}`);
  lines.push(`Initial equity: $${INITIAL_EQUITY_USD.toLocaleString()}, fees ${FEE_BPS} bps taker, slippage ${SLIPPAGE_BPS} bps`);
  lines.push(`Walk-forward: train=${TRAIN_BARS}×4H, test=${TEST_BARS}×4H, step=${STEP_BARS}×4H, windows=${wf.windows.length}`);
  lines.push('');
  lines.push('## Triggers (TRA-296 deltas vs TRA-295)\n');
  lines.push('- **BB-reentry-long (UNCHANGED):** close[i-1] ≤ lower BB(20, 2σ), close[i] > lower BB(20, 2σ), AND RSI(14)[i] > RSI(14)[i-1] with RSI(14)[i-1] < 30. Entry on open of bar i+1.');
  lines.push('- **ATR-pullback-long (TIGHTENED):** close[i-1] ≤ EMA(50)[i-1] − **2.5×ATR(14)[i-1]** *(was 2.0×)*, **RSI(14)[i-1] < 40** *(NEW)*, bullish reversal candle on bar i (close>open AND close>close[i-1]) with volume[i] > **1.5×mean(volume[i-20..i-1])** *(was 1.2×)*. Entry on open of bar i+1.');
  lines.push('');
  lines.push('## BTC-dominance regime gate (new, binding)\n');
  lines.push('Daily BTC-dominance series with a 50-period SMA filter. On 4H bar i, look up the most-recent-completed daily BTC.D close; if ≥ SMA(50) the entry is suppressed (BTC-favorable regime), if below the entry is allowed (alt-favorable regime).');
  lines.push('');
  lines.push('Source — synthetic 5-coin basket (LeadDev choice; rationale documented in harness header). BTC mcap divided by Σ(BTC + ETH + SOL + DOGE + XRP) mcaps using mid-period 2024 circulating-supply constants from existing daily Coinbase caches. Reproducible offline, no API key required. The synthetic basket overstates BTC.D in absolute terms (excludes USDT/USDC/BNB/etc.) but tracks the *trend* of real CRYPTOCAP:BTC.D, which is what the regime gate cares about.');
  lines.push('');

  // BTC.D coverage line — useful sanity check.
  const points = dominance.points;
  lines.push(`BTC.D synthetic series: ${points.length} daily points spanning ${fmtDate(points[0].ts)} → ${fmtDate(points[points.length - 1].ts)}; SMA(50) warm-up extended back from 2022-01-01 (≥ 558d before aligned start, comfortably > 50d).`);
  lines.push('');
  lines.push('Risk knobs (binding, UNCHANGED): 1% account risk per trade, ATR-2.0 stop below entry, 1:2 R:R minimum target, ATR-trail engages at +1R favorable (trail = high-water close − 2.0×ATR(14)).');
  lines.push('');
  lines.push('§5.1 funding gate stays wired direction-aware (no-op for longs).');
  lines.push('');
  lines.push(`§8 acceptance bar (TRA-296 — all four bars binding):`);
  lines.push('- Density ≥ 4 trades / window (post-gate)');
  lines.push('- Hit rate ≥ 35%');
  lines.push('- Expectancy ≥ +0.10R');
  lines.push(`- Rolling-90d DD ≤ ${DD_BAR_PCT}% (binding now per §8.1 amendment ratified in TRA-294 — see reports/SPEC.md)`);
  lines.push('- Pass criterion: clear all four bars on **≥ 5 of 9** windows.');
  lines.push('');

  // Acceptance table.
  lines.push('## §8 Acceptance bars (binding: trades + hit + expectancy + DD90)\n');
  lines.push('| Window | Test span | Trades | Hit % | Expectancy R | DD90 % | Total PnL | Pass? | Reasons |');
  lines.push('| ------ | --------- | ------ | ----- | ------------ | ------ | --------- | ----- | ------- |');
  for (const w of wf.windows) {
    const m = wf.perWindow[w.index].metrics;
    const startStr = w.equityCurve.length > 0 ? fmtDate(w.equityCurve[0].ts) : '—';
    const endStr = w.equityCurve.length > 0 ? fmtDate(w.equityCurve[w.equityCurve.length - 1].ts) : '—';
    const pass = m.passes ? '✅' : '❌';
    lines.push(`| ${w.index} | ${startStr}→${endStr} | ${m.trades} | ${m.hitRatePct.toFixed(1)} | ${m.expectancyR.toFixed(3)} | ${m.rollingMaxDrawdownPct.toFixed(2)} | $${m.totalPnlUsd.toFixed(0)} | ${pass} | ${m.reasons.join('; ') || '—'} |`);
  }
  lines.push('');
  const passingCount = wf.perWindow.filter((w) => w.metrics.passes).length;
  const failingCount = wf.perWindow.length - passingCount;
  lines.push(`Passing windows (binding): ${passingCount} / ${wf.perWindow.length} (acceptance: ≥ 5 / 9)`);
  lines.push(`Failing windows: ${failingCount} / ${wf.perWindow.length}`);
  lines.push('');

  // Aggregate rollup.
  const allTrades = wf.windows.flatMap((w) => w.closedLongs);
  const allWinners = allTrades.filter((t) => t.pnlUsd > 0);
  const aggHit = allTrades.length > 0 ? (allWinners.length / allTrades.length) * 100 : 0;
  const aggExp = allTrades.length > 0 ? allTrades.reduce((s, t) => s + t.rMultiple, 0) / allTrades.length : 0;
  const aggDD = rollingMaxDrawdownPct(wf.equityCurve, ROLLING_DD_BARS);
  lines.push('## Aggregate (across all 9 test windows)\n');
  lines.push(`- Trades: ${allTrades.length}`);
  lines.push(`- Hit rate: ${aggHit.toFixed(1)}%`);
  lines.push(`- Mean expectancy: ${aggExp.toFixed(3)}R`);
  lines.push(`- Rolling 90d DD (concatenated equity curve): ${aggDD.toFixed(2)}%`);
  lines.push('');

  // Per-trigger aggregate decomposition.
  lines.push('## Per-trigger aggregate decomposition (post-gate trades only)\n');
  lines.push('| Trigger | Trades | Winners | Hit % | Expectancy R |');
  lines.push('| ------- | ------ | ------- | ----- | ------------ |');
  for (const trig of ['bb_reentry_long', 'atr_pullback_long'] as SignalType[]) {
    const ts = allTrades.filter((t) => t.signalType === trig);
    const win = ts.filter((t) => t.pnlUsd > 0).length;
    const hit = ts.length > 0 ? (win / ts.length) * 100 : 0;
    const exp = ts.length > 0 ? ts.reduce((s, t) => s + t.rMultiple, 0) / ts.length : 0;
    lines.push(`| ${trig} | ${ts.length} | ${win} | ${hit.toFixed(1)} | ${exp.toFixed(3)} |`);
  }
  lines.push('');

  // Per-trigger pre-gate fire vs post-gate-tradeable per-window histogram.
  lines.push('## Per-trigger pre-gate-fire / post-gate-tradeable histogram (per window, test span only)\n');
  lines.push('| Window | BB pre-gate | BB post-gate | BB gated | ATR pre-gate | ATR post-gate | ATR gated | BTC.D warm-up missing |');
  lines.push('| ------ | ----------- | ------------ | -------- | ------------ | ------------- | --------- | --------------------- |');
  for (const w of wf.windows) {
    const r = w.skipReasons;
    const bbPre = r.get(FIRED_PRE_GATE_BB) ?? 0;
    const bbPost = r.get(POST_GATE_BB) ?? 0;
    const bbGated = r.get(GATED_BB_BTCD) ?? 0;
    const atrPre = r.get(FIRED_PRE_GATE_ATR) ?? 0;
    const atrPost = r.get(POST_GATE_ATR) ?? 0;
    const atrGated = r.get(GATED_ATR_BTCD) ?? 0;
    const warmup = r.get(SKIP_BTCD_WARMUP) ?? 0;
    lines.push(`| ${w.index} | ${bbPre} | ${bbPost} | ${bbGated} | ${atrPre} | ${atrPost} | ${atrGated} | ${warmup} |`);
  }
  lines.push('');
  lines.push('Notes: pre-gate counts every signal that fires per trigger (independently — both can fire on the same bar). Post-gate is the subset where the BTC.D regime gate was alt-favorable. Gated is the subset where the gate suppressed the signal. Pre-gate = post-gate + gated + warm-up-missing per trigger.');
  lines.push('');

  // Per-symbol per-window R decomposition.
  lines.push('## Per-symbol per-window R decomposition\n');
  lines.push('| Window | ' + symbols.map((s) => `${s} (n / hit% / R)`).join(' | ') + ' |');
  lines.push('| ------ | ' + symbols.map(() => '---').join(' | ') + ' |');
  for (const w of wf.perWindow) {
    const cells = symbols.map((sym) => {
      const m = w.perSymbol.find((p) => p.symbol === sym)!;
      return `${m.trades} / ${m.hitRatePct.toFixed(0)}% / ${m.expectancyR.toFixed(2)}R`;
    });
    lines.push(`| ${w.index} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // Per-trigger per-window decomposition (post-gate trades only).
  lines.push('## Per-trigger per-window decomposition (post-gate trades only)\n');
  lines.push('| Window | BB-reentry (n / hit% / R) | ATR-pullback (n / hit% / R) |');
  lines.push('| ------ | ------------------------- | --------------------------- |');
  for (const w of wf.perWindow) {
    const bb = w.perTrigger.find((p) => p.trigger === 'bb_reentry_long')!;
    const ap = w.perTrigger.find((p) => p.trigger === 'atr_pullback_long')!;
    lines.push(`| ${w.index} | ${bb.trades} / ${bb.hitRatePct.toFixed(0)}% / ${bb.expectancyR.toFixed(2)}R | ${ap.trades} / ${ap.hitRatePct.toFixed(0)}% / ${ap.expectancyR.toFixed(2)}R |`);
  }
  lines.push('');

  // Side-by-side TRA-295 vs TRA-296 per-window comparison.
  lines.push('## Side-by-side TRA-295 vs TRA-296 (per window)\n');
  lines.push('| Window | TRA-295 trades | TRA-296 trades | Δ trades | TRA-295 hit% | TRA-296 hit% | TRA-295 R | TRA-296 R | TRA-296 pass? |');
  lines.push('| ------ | -------------- | -------------- | -------- | ------------ | ------------ | --------- | --------- | ------------- |');
  for (const w of wf.perWindow) {
    const m = w.metrics;
    const prior = tra295Sidecar?.perWindow.find((p) => p.index === w.index);
    const priorTrades = prior?.trades ?? null;
    const priorHit = prior?.hitRatePct ?? null;
    const priorExp = prior?.expectancyR ?? null;
    const dT = priorTrades !== null ? `${m.trades - priorTrades >= 0 ? '+' : ''}${m.trades - priorTrades}` : '—';
    const tradesPrior = priorTrades !== null ? String(priorTrades) : '—';
    const hitPrior = priorHit !== null ? priorHit.toFixed(1) : '—';
    const expPrior = priorExp !== null ? priorExp.toFixed(3) : '—';
    lines.push(`| ${w.index} | ${tradesPrior} | ${m.trades} | ${dT} | ${hitPrior} | ${m.hitRatePct.toFixed(1)} | ${expPrior} | ${m.expectancyR.toFixed(3)} | ${m.passes ? '✅' : '❌'} |`);
  }
  lines.push('');

  // Decision.
  lines.push('## Decision\n');
  if (passingCount >= 5) {
    lines.push(`**SHIP SIGNAL** — ${passingCount} / 9 windows clear all four binding §8 bars (≥ 5 / 9 required), with the 25% rolling-90d DD bar binding. Phase-1.2.1 regime-gated mean-reversion long ready to ship.`);
  } else {
    lines.push(`**FAIL** — Only ${passingCount} / 9 windows clear all four binding §8 bars (≥ 5 / 9 required). Per task spec, do **not** silently tune. Reassign back to QuantTrader with the per-window pre-gate vs post-gate trade counts (above), per-trigger split post-gate, and density-failure list (any window where post-gate density dropped below 4 trades).`);
  }
  return lines.join('\n');
}

interface TRA295Sidecar {
  perWindow: Array<{ index: number; trades: number; hitRatePct: number; expectancyR: number }>;
}

function maybeLoadTra295Sidecar(): TRA295Sidecar | null {
  const path = resolve(REPORT_DIR, 'tra291-sweep-4h-r9-meanrev-long.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return { perWindow: raw.perWindow };
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const fromMs = FROM_MS;
  const toMs = Date.now();

  console.log(`[run-tra296] Loading 4H bars ${fmtDate(fromMs)} → ${fmtDate(toMs)} for r9 universe ${UNIVERSE.join(', ')}`);
  const fullByPair = new Map<string, Candle[]>();
  for (const sym of UNIVERSE) {
    const bars = await loadOrFetch4hBars(sym, fromMs, toMs);
    fullByPair.set(sym, bars);
    console.log(`  ${sym}: ${bars.length} 4H bars (${fmtDate(bars[0].timestamp)} → ${fmtDate(bars[bars.length - 1].timestamp)})`);
  }

  for (const [sym, bars] of fullByPair) {
    const trimmed = bars.filter((c) => c.timestamp >= ALIGNED_START_TS);
    fullByPair.set(sym, trimmed);
  }
  const aligned = [...fullByPair.entries()].map(([s, c]) => `${s}=${c.length}`).join(', ');
  console.log(`[run-tra296] Aligned to ${new Date(ALIGNED_START_TS).toISOString()}: ${aligned}`);

  console.log('[run-tra296] Building synthetic BTC.D daily series (5-coin basket)…');
  const dominance = await loadSyntheticBtcDominanceDaily(fromMs, toMs);
  const minDom = dominance.points[0];
  const maxDom = dominance.points[dominance.points.length - 1];
  console.log(`[run-tra296] BTC.D series: ${dominance.points.length} points, ${fmtDate(minDom.ts)} → ${fmtDate(maxDom.ts)}`);
  console.log(`[run-tra296] BTC.D snapshot @ aligned start ${fmtDate(ALIGNED_START_TS)}: dominance=${dominance.lookup(ALIGNED_START_TS)?.dominance.toFixed(3) ?? 'n/a'}, sma50=${dominance.lookup(ALIGNED_START_TS)?.sma50?.toFixed(3) ?? 'n/a'}`);

  console.log('[run-tra296] Running regime-gated mean-reversion-long walk-forward…');
  const wf = runWalkForward(fullByPair, dominance);
  console.log(`[run-tra296] ${wf.windows.length} windows produced.`);

  const symbols = [...UNIVERSE];
  const tra295Prior = maybeLoadTra295Sidecar();
  const report = buildReport(wf, symbols, fullByPair, dominance, tra295Prior);
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, 'tra296-sweep-4h-r9-meanrev-long-regime.md');
  writeFileSync(reportPath, report);
  console.log(`\n[run-tra296] Report written: ${reportPath}`);

  const passingCount = wf.perWindow.filter((w) => w.metrics.passes).length;
  const passAll = passingCount >= 5;

  const totalSkips = (() => {
    const t = new Map<string, number>();
    for (const w of wf.windows) {
      for (const [k, v] of w.skipReasons) t.set(k, (t.get(k) ?? 0) + v);
    }
    return Object.fromEntries(t);
  })();

  const sidecarPath = resolve(REPORT_DIR, 'tra296-sweep-4h-r9-meanrev-long-regime.json');
  writeFileSync(sidecarPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    granularity: '4h',
    direction: 'long',
    triggerFamily: 'mean-reversion (regime-gated)',
    triggers: ['bb_reentry_long', 'atr_pullback_long'],
    universe: symbols,
    initialEquityUsd: INITIAL_EQUITY_USD,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    riskFraction: RISK_FRACTION,
    atrKStop: ATR_K_STOP,
    atrKTrail: ATR_K_TRAIL,
    rrMin: RR_MIN,
    trailArmR: TRAIL_ARM_R,
    bbPeriod: BB_PERIOD,
    bbMult: BB_MULT,
    atrPullbackEmaPeriod: ATR_PB_EMA_PERIOD,
    atrPullbackDepthAtr: ATR_PB_DEPTH,
    atrPullbackVolMult: ATR_PB_VOL_MULT,
    atrPullbackRsiMax: ATR_PB_RSI_MAX,
    btcdSmaPeriod: BTC_D_SMA_PERIOD,
    btcdSource: 'synthetic-5coin-basket',
    btcdBasket: BASKET,
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    stepBars: STEP_BARS,
    alignedStartTs: ALIGNED_START_TS,
    ddBarPct: DD_BAR_PCT,
    perWindow: wf.perWindow.map((w) => {
      const win = wf.windows.find((x) => x.index === w.index)!;
      const r = win.skipReasons;
      return {
        index: w.index,
        ...w.metrics,
        perSymbol: w.perSymbol,
        perTrigger: w.perTrigger,
        preGateBb: r.get(FIRED_PRE_GATE_BB) ?? 0,
        postGateBb: r.get(POST_GATE_BB) ?? 0,
        gatedBb: r.get(GATED_BB_BTCD) ?? 0,
        preGateAtr: r.get(FIRED_PRE_GATE_ATR) ?? 0,
        postGateAtr: r.get(POST_GATE_ATR) ?? 0,
        gatedAtr: r.get(GATED_ATR_BTCD) ?? 0,
        btcdWarmupMissing: r.get(SKIP_BTCD_WARMUP) ?? 0,
      };
    }),
    skipReasonsAggregate: totalSkips,
    decision: passAll ? 'PASS' : 'FAIL',
    passingWindowsBinding: passingCount,
    requiredPassing: 5,
  }, null, 2));
  console.log(`[run-tra296] JSON sidecar: ${sidecarPath}`);

  console.log(`\n=== TRA-296 §8 Acceptance (4H r9 regime-gated mean-reversion long, SOL+DOGE) ===`);
  console.log(`Windows passing all four binding bars: ${passingCount} / ${wf.perWindow.length}`);
  console.log(`Decision: ${passAll ? 'PASS — ship signal' : 'FAIL — TRA-296 → QuantTrader'}`);
}

const invoked = process.argv[1] && /[\\/]run-tra296-meanrev-long-regime-sweep\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
