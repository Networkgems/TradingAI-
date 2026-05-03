/**
 * TRA-295 — Phase-1.2 real mean-reversion long §8 walk-forward sweep on 4H r9
 * (SOL + DOGE).
 *
 * Routed from TRA-291 → TRA-292 consolidation. TRA-292 mirrored the §4.4
 * short stack into long (direction-inverted *trend-following* triggers),
 * which misread the TRA-287 parent diagnosis ("4H Coinbase tape rewards
 * mean-reversion long entries far more than short continuations"). This
 * harness wires the trigger family the diagnosis actually pointed at:
 *
 *   - BB-reentry-long: 4H close at/below the lower Bollinger band
 *     (20-period mean, 2.0σ) on bar i-1, AND 4H close back inside the band
 *     (above the lower band) on bar i, AND RSI(14) reversing up from < 30
 *     (RSI[i] > RSI[i-1] AND RSI[i-1] < 30). Entry on the open of bar i+1.
 *   - ATR-pullback-long: 4H close has pulled back ≥ 2.0×ATR(14) below the
 *     50-period EMA on bar i-1, AND 4H close on bar i shows a bullish
 *     reversal (close[i] > open[i] AND close[i] > close[i-1]) with
 *     volume[i] > 1.2× the 20-bar volume mean. Entry on the open of bar i+1.
 *
 * Risk knobs (binding per task spec — same as TRA-292 to isolate the
 * trigger-family change):
 *
 *   - 1% account risk per trade
 *   - ATR-2.0 initial stop below entry
 *   - 1:2 R:R minimum target
 *   - ATR-trail engages at +1R favorable; trail = high-water close − 2.0×ATR
 *
 * Walk-forward: aligned to TRA-287's XRP-aligned start (2023-07-13T20:00Z)
 * so the 9 windows are calendar-identical with the short-side r9 sweep and
 * with TRA-292. train=1080×4H, test=540×4H, step=540×4H.
 *
 * Acceptance bar (§8 — task spec):
 *   - >= 4 trades / window
 *   - expectancy >= +0.10R
 *   - hit rate >= 35%
 *   - rolling-90d DD reported against TWO bars side-by-side:
 *       • existing  = 8%   (the original §8 spec)
 *       • recalibrated = 25% (TRA-294 sibling landed: anchor = synthetic-MC
 *         p99 21.53% + 1.5% intra-trade buffer, ceil-to-5%)
 *     DD is reported but NOT binding for pass/fail (per spec — sibling is
 *     calibrating it). Pass criterion: ≥ 5 of 9 windows clear hit + expectancy
 *     + density. Ship signal: pass + clear the recalibrated DD bar on the
 *     same windows.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra295-meanrev-long-sweep.ts
 *
 * Outputs:
 *   reports/tra291-sweep-4h-r9-meanrev-long.md
 *   reports/tra291-sweep-4h-r9-meanrev-long.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { atr, ema, rsi } from '@trading-app/engine';
import { loadOrFetch4hBars } from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

// ── Spec constants (task TRA-295) ─────────────────────────────────────────

const UNIVERSE = ['SOL-USD', 'DOGE-USD'] as const;

const INITIAL_EQUITY_USD = 25_000;
const FEE_BPS = 40;
const SLIPPAGE_BPS = 5;
const RISK_FRACTION = 0.01;

const ATR_K_STOP = 2.0;
const ATR_K_TRAIL = 2.0;
const RR_MIN = 2.0;
const TRAIL_ARM_R = 1.0;

// BB-reentry-long trigger
const BB_PERIOD = 20;
const BB_MULT = 2.0;
const BB_RSI_PERIOD = 14;
const BB_RSI_OVERSOLD = 30;

// ATR-pullback-long trigger
const ATR_PB_PERIOD = 14;
const ATR_PB_EMA_PERIOD = 50;
const ATR_PB_DEPTH = 2.0;        // close[i-1] ≤ ema50[i-1] - 2.0×ATR(14)[i-1]
const ATR_PB_VOL_LOOKBACK = 20;
const ATR_PB_VOL_MULT = 1.2;

// Walk-forward
const TRAIN_BARS = 180 * 6;      // 1080 × 4H ≈ 6 months
const TEST_BARS = 90 * 6;        // 540  × 4H ≈ 3 months
const STEP_BARS = TEST_BARS;
const ROLLING_DD_BARS = 90 * 6;

// XRP-aligned start (calendar-identical with TRA-287 / TRA-292 / TRA-294)
const ALIGNED_START_TS = Date.UTC(2023, 6, 13, 20);
const FROM_MS = Date.UTC(2022, 0, 1);

// DD bars reported side-by-side per task spec
const DD_BAR_EXISTING_PCT = 8;       // original §8 spec
const DD_BAR_RECAL_PCT = 25;         // TRA-294 sibling landed value

const SKIP_NO_TRIGGER = 'no trigger emitted';
const SKIP_FUNDING_LONG_NOOP = '§5.1 funding gate (no-op for longs)';
const SKIP_ZERO_ATR = 'zero ATR — skipped';
const SKIP_ZERO_QTY = 'zero qty';
const SKIP_NEXT_BAR_MISSING = 'no next bar — entry impossible';
const SKIP_EQUITY_EXHAUSTED = 'equity exhausted';
// Per-trigger fire diagnostics (so the report can show how many of each fire
// vs how many become tradeable entries vs are gated post-fire).
const FIRED_BB_REENTRY = 'fired: bb-reentry-long';
const FIRED_ATR_PULLBACK = 'fired: atr-pullback-long';

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
  /** §8 pass result (binding bars: trades + hit + expectancy ONLY per task spec). */
  passes: boolean;
  reasons: string[];
  /** Diagnostic: would-pass under the 8% (existing) DD bar. */
  passesExistingDdBar: boolean;
  /** Diagnostic: would-pass under the 25% (recalibrated) DD bar. */
  passesRecalDdBar: boolean;
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

/**
 * 20-period Bollinger Bands over closes[0..endIdxInclusive], using the
 * rolling-window SMA + population stdev (matches engine/indicators/bollinger).
 * Returns NaN-laden bars when fewer than `period` samples are available.
 */
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
  rsi: number[];           // RSI(14) at close[i]
  atr14: number[];         // ATR(14) at close[i]
  ema50: number[];         // EMA(50) at close[i]
  bbLower: number[];       // 20σ2 BB lower at close[i]
  bbUpper: number[];       // 20σ2 BB upper at close[i] (kept for diagnostics)
  volMean20: number[];     // trailing 20-bar mean of volume (excluding bar i)
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

// ── Trigger evaluation ────────────────────────────────────────────────────

/**
 * BB-reentry-long: bar i-1 closes at or below the lower Bollinger band, bar i
 * closes back inside (strictly above the lower band on i), AND RSI(14) is
 * reversing up from oversold (RSI[i] > RSI[i-1] AND RSI[i-1] < 30).
 *
 * Note on band-of-record: we evaluate the "below band" leg using the BB
 * computed *up to and including* bar i-1 (so the trader could observe the
 * touch on close[i-1]'s tape). The "back inside" leg uses the BB at bar i
 * (observed on close[i]).
 */
function detectBbReentryLong(bars: Candle[], pc: PreCompute, i: number): LongSignal | null {
  if (i <= 0 || i + 1 >= bars.length) return null;

  const closePrev = bars[i - 1].close;
  const closeCurr = bars[i].close;

  const bbPrev = { lower: pc.bbLower[i - 1] };
  const bbCurr = { lower: pc.bbLower[i] };
  if (!Number.isFinite(bbPrev.lower) || !Number.isFinite(bbCurr.lower)) return null;

  if (!(closePrev <= bbPrev.lower)) return null;
  if (!(closeCurr > bbCurr.lower)) return null;

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
 * ATR-pullback-long: close[i-1] ≤ EMA50[i-1] - 2.0×ATR(14)[i-1] (deep
 * pullback below the trend line), AND bar i is a bullish reversal (close[i]
 * > open[i] AND close[i] > close[i-1]) with volume[i] > 1.2× the 20-bar
 * volume mean.
 */
function detectAtrPullbackLong(bars: Candle[], pc: PreCompute, i: number): LongSignal | null {
  if (i <= 0 || i + 1 >= bars.length) return null;

  const closePrev = bars[i - 1].close;
  const ema50Prev = pc.ema50[i - 1];
  const atrPrev = pc.atr14[i - 1];
  if (!Number.isFinite(ema50Prev) || !Number.isFinite(atrPrev) || atrPrev <= 0) return null;
  if (!(closePrev <= ema50Prev - ATR_PB_DEPTH * atrPrev)) return null;

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
      if (bbSig) bumpSkip(FIRED_BB_REENTRY);
      if (atrSig) bumpSkip(FIRED_ATR_PULLBACK);

      // BB-reentry takes precedence when both fire (rare; mean-reversion-from-
      // band is a more specific tape pattern than a generic deep pullback).
      const sig = bbSig ?? atrSig;
      if (!sig) {
        bumpSkip(SKIP_NO_TRIGGER);
        continue;
      }

      // §5.1 funding gate — direction-aware no-op for longs (same as TRA-292).
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

function runWalkForward(fullByPair: Map<string, Candle[]>): WalkForwardOutput {
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
    const sim = runLongSim({ candlesBySymbol: sliceMap });

    const sampleSym = symbols[0];
    const sampleSlice = fullByPair.get(sampleSym)!;
    const testStartTs = sampleSlice[win.testStart].timestamp;
    const testEndTs = sampleSlice[Math.min(win.testEnd - 1, sampleSlice.length - 1)].timestamp;

    const testTrades = sim.closedLongs.filter((t) => t.openedAt >= testStartTs && t.openedAt <= testEndTs);
    const testEquity = sim.equityCurve.filter((p) => p.ts >= testStartTs && p.ts <= testEndTs);

    const windowReport: WindowReport = {
      ...sim,
      closedLongs: testTrades,
      equityCurve: testEquity,
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

  // Per task spec: DD is reported but NOT binding for pass/fail in this child;
  // the binding bars are trades, hit rate, and expectancy.
  const reasons: string[] = [];
  if (trades.length < 4) reasons.push(`trades ${trades.length} < 4`);
  if (expectancy < 0.10) reasons.push(`expectancy ${expectancy.toFixed(3)}R < 0.10R`);
  if (hitRatePct < 35) reasons.push(`hit rate ${hitRatePct.toFixed(1)}% < 35%`);

  return {
    trades: trades.length,
    winners: winners.length,
    hitRatePct,
    expectancyR: expectancy,
    totalPnlUsd: totalPnl,
    rollingMaxDrawdownPct: rollingDD,
    passes: reasons.length === 0,
    reasons,
    passesExistingDdBar: rollingDD <= DD_BAR_EXISTING_PCT,
    passesRecalDdBar: rollingDD <= DD_BAR_RECAL_PCT,
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
): string {
  const lines: string[] = [];
  lines.push('# TRA-295 — §8 Walk-Forward Sweep Report (4H Phase-1.2 real mean-reversion long — r9 SOL+DOGE)\n');
  lines.push(`Generated: ${new Date().toISOString()}\n`);
  lines.push('Granularity: 4h');
  lines.push(`Universe: ${symbols.join(', ')} (r9 binding — TRA-292 Momentum-long & Breakout-long parked for 4H/r9 per consolidation)`);
  const sample = fullByPair.get(symbols[0])!;
  lines.push(`Date span: ${fmtDate(sample[0].timestamp)} → ${fmtDate(sample[sample.length - 1].timestamp)}`);
  lines.push(`Initial equity: $${INITIAL_EQUITY_USD.toLocaleString()}, fees ${FEE_BPS} bps taker, slippage ${SLIPPAGE_BPS} bps`);
  lines.push(`Walk-forward: train=${TRAIN_BARS}×4H, test=${TEST_BARS}×4H, step=${STEP_BARS}×4H, windows=${wf.windows.length}`);
  lines.push('');
  lines.push('Triggers (real mean-reversion, replacing TRA-292\'s direction-inverted trend stack):');
  lines.push('- **BB-reentry-long:** close[i-1] ≤ lower BB(20, 2σ), close[i] > lower BB(20, 2σ), AND RSI(14)[i] > RSI(14)[i-1] with RSI(14)[i-1] < 30. Entry on open of bar i+1.');
  lines.push('- **ATR-pullback-long:** close[i-1] ≤ EMA(50)[i-1] − 2.0×ATR(14)[i-1], AND bar i closes bullish (close>open AND close>close[i-1]) with volume[i] > 1.2×mean(volume[i-20..i-1]). Entry on open of bar i+1.');
  lines.push('');
  lines.push('Risk knobs (binding): 1% account risk per trade, ATR-2.0 stop below entry, 1:2 R:R minimum target, ATR-trail engages at +1R favorable (trail = high-water close − 2.0×ATR(14)).');
  lines.push('');
  lines.push('§5.1 funding gate stays wired direction-aware (no-op for longs).');
  lines.push('');
  lines.push(`DD bars (reported side-by-side per task spec; **not** binding for pass/fail in this child — TRA-294 sibling is recalibrating):`);
  lines.push(`- **existing**: rolling-90d DD ≤ ${DD_BAR_EXISTING_PCT}% (the original §8 spec)`);
  lines.push(`- **recalibrated**: rolling-90d DD ≤ ${DD_BAR_RECAL_PCT}% (TRA-294 landed value: ceil-to-5%(synthetic-MC p99 21.53% + 1.5% intra-trade buffer))`);
  lines.push('');

  // Acceptance table (binding bars only).
  lines.push('## §8 Acceptance bars (binding: trades + hit + expectancy)\n');
  lines.push('| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Pass? | Reasons |');
  lines.push('| ------ | --------- | ------ | ----- | ------------ | --------- | ----- | ------- |');
  for (const w of wf.windows) {
    const m = wf.perWindow[w.index].metrics;
    const startStr = w.equityCurve.length > 0 ? fmtDate(w.equityCurve[0].ts) : '—';
    const endStr = w.equityCurve.length > 0 ? fmtDate(w.equityCurve[w.equityCurve.length - 1].ts) : '—';
    const pass = m.passes ? '✅' : '❌';
    lines.push(`| ${w.index} | ${startStr}→${endStr} | ${m.trades} | ${m.hitRatePct.toFixed(1)} | ${m.expectancyR.toFixed(3)} | $${m.totalPnlUsd.toFixed(0)} | ${pass} | ${m.reasons.join('; ') || '—'} |`);
  }
  lines.push('');
  const passingCount = wf.perWindow.filter((w) => w.metrics.passes).length;
  const failingCount = wf.perWindow.length - passingCount;
  lines.push(`Passing windows (binding): ${passingCount} / ${wf.perWindow.length} (acceptance: ≥ 5 / 9)`);
  lines.push(`Failing windows: ${failingCount} / ${wf.perWindow.length}`);
  lines.push('');

  // DD side-by-side (existing 8% vs recalibrated 25%).
  lines.push('## DD bar side-by-side (reported, not binding)\n');
  lines.push(`| Window | Rolling-90d DD % | Existing 8% bar | Recalibrated ${DD_BAR_RECAL_PCT}% bar |`);
  lines.push('| ------ | ---------------- | --------------- | --------------------- |');
  for (const w of wf.perWindow) {
    const m = w.metrics;
    const ex = m.passesExistingDdBar ? '✅' : '❌';
    const rc = m.passesRecalDdBar ? '✅' : '❌';
    lines.push(`| ${w.index} | ${m.rollingMaxDrawdownPct.toFixed(2)} | ${ex} | ${rc} |`);
  }
  lines.push('');
  const passExisting = wf.perWindow.filter((w) => w.metrics.passesExistingDdBar).length;
  const passRecal = wf.perWindow.filter((w) => w.metrics.passesRecalDdBar).length;
  lines.push(`Windows clearing existing 8% bar: ${passExisting} / ${wf.perWindow.length}`);
  lines.push(`Windows clearing recalibrated ${DD_BAR_RECAL_PCT}% bar: ${passRecal} / ${wf.perWindow.length}`);
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
  lines.push(`- Rolling 90d DD: ${aggDD.toFixed(2)}%`);
  lines.push('');

  // Per-trigger aggregate (BB-reentry vs ATR-pullback workload).
  lines.push('## Per-trigger aggregate decomposition\n');
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

  // Per-trigger per-window decomposition.
  lines.push('## Per-trigger per-window decomposition\n');
  lines.push('| Window | BB-reentry (n / hit% / R) | ATR-pullback (n / hit% / R) |');
  lines.push('| ------ | ------------------------- | --------------------------- |');
  for (const w of wf.perWindow) {
    const bb = w.perTrigger.find((p) => p.trigger === 'bb_reentry_long')!;
    const ap = w.perTrigger.find((p) => p.trigger === 'atr_pullback_long')!;
    lines.push(`| ${w.index} | ${bb.trades} / ${bb.hitRatePct.toFixed(0)}% / ${bb.expectancyR.toFixed(2)}R | ${ap.trades} / ${ap.hitRatePct.toFixed(0)}% / ${ap.expectancyR.toFixed(2)}R |`);
  }
  lines.push('');

  // Pre-route skip-reason histogram (with explicit fire counts).
  const totalSkips = new Map<string, number>();
  for (const w of wf.windows) {
    for (const [k, v] of w.skipReasons) totalSkips.set(k, (totalSkips.get(k) ?? 0) + v);
  }
  if (totalSkips.size > 0) {
    lines.push('## Pre-route skip / fire histogram\n');
    lines.push('| Reason | Count |');
    lines.push('| ------ | ----- |');
    const entries = [...totalSkips.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, v] of entries) lines.push(`| ${k} | ${v} |`);
    lines.push('');
    const bbFires = totalSkips.get(FIRED_BB_REENTRY) ?? 0;
    const apFires = totalSkips.get(FIRED_ATR_PULLBACK) ?? 0;
    lines.push(`Fires → tradeable entries: BB-reentry-long fired ${bbFires}× and ATR-pullback-long fired ${apFires}×; ${allTrades.length} total tradeable entries (BB-reentry takes precedence when both fire on the same bar).`);
    lines.push('');
  }

  // Decision.
  const passAll = passingCount >= 5;
  const passShipSignal = passAll && wf.perWindow.filter((w) => w.metrics.passes && w.metrics.passesRecalDdBar).length >= 5;
  lines.push('## Decision\n');
  if (passShipSignal) {
    lines.push(`**SHIP SIGNAL** — ${passingCount} / 9 windows clear binding §8 bars (≥ 5 / 9 required) AND clear the recalibrated ${DD_BAR_RECAL_PCT}% DD bar on the same windows. Phase-1.2 real mean-reversion long ready to ship.`);
  } else if (passAll) {
    lines.push(`**PASS (binding)** — ${passingCount} / 9 windows clear binding §8 bars (≥ 5 / 9 required), but the recalibrated ${DD_BAR_RECAL_PCT}% DD bar is not cleared on those same windows. Comment back to QuantTrader with the DD breakdown before shipping.`);
  } else {
    lines.push(`**FAIL** — Only ${passingCount} / 9 windows clear binding §8 bars (≥ 5 / 9 required). Per task spec, do **not** silently tune. Reassign back to QuantTrader and call out which trigger (BB-reentry vs ATR-pullback) is doing more or less of the work and which bars miss on which windows.`);
  }
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const fromMs = FROM_MS;
  const toMs = Date.now();

  console.log(`[run-tra295-meanrev-long-sweep] Loading 4H bars ${fmtDate(fromMs)} → ${fmtDate(toMs)} for r9 universe ${UNIVERSE.join(', ')}`);
  const fullByPair = new Map<string, Candle[]>();
  for (const sym of UNIVERSE) {
    const bars = await loadOrFetch4hBars(sym, fromMs, toMs);
    fullByPair.set(sym, bars);
    console.log(`  ${sym}: ${bars.length} bars (${fmtDate(bars[0].timestamp)} → ${fmtDate(bars[bars.length - 1].timestamp)})`);
  }

  for (const [sym, bars] of fullByPair) {
    const trimmed = bars.filter((c) => c.timestamp >= ALIGNED_START_TS);
    fullByPair.set(sym, trimmed);
  }
  const aligned = [...fullByPair.entries()].map(([s, c]) => `${s}=${c.length}`).join(', ');
  console.log(`[run-tra295-meanrev-long-sweep] Aligned to ${new Date(ALIGNED_START_TS).toISOString()}: ${aligned}`);

  console.log('[run-tra295-meanrev-long-sweep] Running mean-reversion-long walk-forward…');
  const wf = runWalkForward(fullByPair);
  console.log(`[run-tra295-meanrev-long-sweep] ${wf.windows.length} windows produced.`);

  const symbols = [...UNIVERSE];
  const report = buildReport(wf, symbols, fullByPair);
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, 'tra291-sweep-4h-r9-meanrev-long.md');
  writeFileSync(reportPath, report);
  console.log(`\n[run-tra295-meanrev-long-sweep] Report written: ${reportPath}`);

  const passingCount = wf.perWindow.filter((w) => w.metrics.passes).length;
  const passAll = passingCount >= 5;
  const passShipSignal = passAll && wf.perWindow.filter((w) => w.metrics.passes && w.metrics.passesRecalDdBar).length >= 5;

  const totalSkips = (() => {
    const t = new Map<string, number>();
    for (const w of wf.windows) {
      for (const [k, v] of w.skipReasons) t.set(k, (t.get(k) ?? 0) + v);
    }
    return Object.fromEntries(t);
  })();

  const sidecarPath = resolve(REPORT_DIR, 'tra291-sweep-4h-r9-meanrev-long.json');
  writeFileSync(sidecarPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    granularity: '4h',
    direction: 'long',
    triggerFamily: 'mean-reversion (real)',
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
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    stepBars: STEP_BARS,
    alignedStartTs: ALIGNED_START_TS,
    ddBarExistingPct: DD_BAR_EXISTING_PCT,
    ddBarRecalibratedPct: DD_BAR_RECAL_PCT,
    perWindow: wf.perWindow.map((w) => ({
      index: w.index,
      ...w.metrics,
      perSymbol: w.perSymbol,
      perTrigger: w.perTrigger,
    })),
    skipReasons: totalSkips,
    decision: passShipSignal ? 'SHIP SIGNAL' : passAll ? 'PASS (binding)' : 'FAIL',
    passingWindowsBinding: passingCount,
    passingWindowsRecalDdBar: wf.perWindow.filter((w) => w.metrics.passesRecalDdBar).length,
    passingWindowsExistingDdBar: wf.perWindow.filter((w) => w.metrics.passesExistingDdBar).length,
    requiredPassing: 5,
  }, null, 2));
  console.log(`[run-tra295-meanrev-long-sweep] JSON sidecar: ${sidecarPath}`);

  console.log(`\n=== TRA-295 §8 Acceptance (4H r9 mean-reversion long, SOL+DOGE) ===`);
  console.log(`Windows passing binding bars: ${passingCount} / ${wf.perWindow.length}`);
  console.log(`Decision: ${passShipSignal ? 'SHIP SIGNAL' : passAll ? 'PASS (binding) — DD breakdown to QuantTrader' : 'FAIL — TRA-295 → QuantTrader'}`);
}

const invoked = process.argv[1] && /[\\/]run-tra295-meanrev-long-sweep\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
