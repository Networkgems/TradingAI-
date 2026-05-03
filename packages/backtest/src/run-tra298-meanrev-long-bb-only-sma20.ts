/**
 * TRA-298 — Phase-1.2.2 BB-reentry-only + loosened SMA(20) BTC.D regime
 * gate: §8 walk-forward re-sweep on SOL+DOGE 4H r9.
 *
 * Diff vs TRA-296 (`run-tra296-meanrev-long-regime-sweep.ts`)
 * ----------------------------------------------------------
 *
 *   1. **Drop ATR-pullback-long entirely.** TRA-296 measured -0.106R
 *      post-gate aggregate even after the §3 selectivity tightening
 *      (depth 2.5×ATR, vol 1.5×, RSI<40). Park-by-evidence — same
 *      precedent as TRA-292 trend-stack triggers parked on this
 *      universe at this timeframe.
 *
 *   2. **BTC.D regime gate SMA(50) → SMA(20).** TRA-296 had a
 *      density-floor problem on 4/9 windows (W2/W4/W7/W8 → 0/0/1/0
 *      post-gate trades), not an edge-floor problem (the windows that
 *      did fire post-gate cleared cleanly). The originally-templated
 *      "SMA(50) AND 7d slope < 0" tightens the gate further (LeadDev
 *      flagged in TRA-297 §2). The opposite direction is what the data
 *      points at — a faster MA that flips alt-favorable / alt-bleed
 *      sooner, recovering density on borderline quarters while keeping
 *      the directional edge of "BTC.D below trend".
 *
 *      Halving the lookback (50 → 20) is the cleanest knob, no exotic
 *      smoothing parameters introduced. If this overshoots the other
 *      way (too much whipsaw → BB-reentry-only post-gate aggregate
 *      regresses below TRA-296's +0.091R), the next iteration's call
 *      is SMA(30) or a slope confirm.
 *
 * Triggers (BB-reentry-long only — UNCHANGED from TRA-295/296)
 * ------------------------------------------------------------
 *
 *   - 4H close at/below the lower Bollinger band (20-period mean,
 *     2.0σ) on bar i-1 (`close[i-1] ≤ lowerBB[i-1]`)
 *   - 4H close back inside the band on bar i (`close[i] > lowerBB[i]`)
 *   - RSI(14) reversing up from < 30
 *     (`RSI[i] > RSI[i-1] AND RSI[i-1] < 30`)
 *   - Entry on the open of bar i+1
 *
 *   Note on spec interpretation: TRA-298 task §1 reads "BB-reentry-long
 *   spec stays at the TRA-295 §4 / TRA-297 §4 form, **unchanged**" and
 *   then lists bullet items that differ slightly from the TRA-295/296
 *   detector (low-band touch via `low[i-1]` vs `close[i-1]`; an added
 *   bullish-reversal-candle requirement). The "unchanged" claim is
 *   binding — using TRA-295/296's actual implementation keeps the
 *   apples-to-apples diagnostic the report's side-by-side requires.
 *   If QuantTrader meant the listed-item form, that's a one-line
 *   re-spec for a follow-up; not silently divergent here.
 *
 * BTC-dominance regime gate
 * -------------------------
 *
 *   - Source: synthetic 5-coin basket (`btc-dominance-synthetic.ts`).
 *     Same as TRA-296. Per task §2 out-of-scope: do not modify the
 *     basket composition.
 *   - Filter: SMA(20) on dominance (was SMA(50) in TRA-296).
 *   - Application: on 4H bar i, look up the most-recent-completed
 *     daily synthetic-BTC.D close. If it is ≥ SMA(20), suppress entry.
 *     If below, allow.
 *   - Warm-up: extends back regardless of test-span boundary; trivially
 *     covered by the existing 558-daily-close pre-roll (≥ 50 prior
 *     daily closes available, much more than the 20 SMA(20) needs).
 *
 * Risk knobs (UNCHANGED): 1% account risk per trade, ATR-2.0 initial
 * stop, 1:2 minimum R:R target, ATR-trail engages at +1R favorable.
 * §5.1 funding gate stays direction-aware (no-op for longs).
 *
 * Walk-forward (UNCHANGED): SOL-USD + DOGE-USD on 4H r9; XRP-aligned
 * start 2023-07-13T20:00Z; train=1080×4H, test=540×4H, step=540×4H,
 * 9 windows.
 *
 * §8 acceptance bar (UNCHANGED): density ≥ 4 trades/window,
 * hit ≥ 35%, expectancy ≥ +0.10R, rolling-90d DD ≤ 25% (binding per
 * §8.1 amendment ratified TRA-294 → see `reports/SPEC.md`). Pass on
 * ≥ 5 of 9 windows.
 *
 * §8.1 amendment carry-forward (verbatim from TRA-294 ratification —
 * the canonical record is `packages/backtest/reports/SPEC.md`):
 *
 *   §8 amendment — universe-aware rolling-90d DD bar.
 *
 *   The §8 rolling-90d DD bar SHALL be calibrated per-universe rather
 *   than as a single global value. For each universe + strategy-params
 *   combination, the bar SHALL be derived as:
 *
 *       bar_universe = ceil_to_5pct(p99(synthetic_MC_DD) + 1.5%)
 *
 *   For the SOL+DOGE 4H r9 universe (30% hit / 1:2 R:R / 1.0% risk /
 *   ~38 trades per 90-day window) the resulting bar is 25%. The
 *   original 8% bar SHALL remain in force on the Phase-1 stock
 *   universe at its native strategy params.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra298-meanrev-long-bb-only-sma20.ts
 *
 * Outputs:
 *   reports/tra298-sweep-4h-r9-meanrev-long-bb-only-sma20.md
 *   reports/tra298-sweep-4h-r9-meanrev-long-bb-only-sma20.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { atr, rsi } from '@trading-app/engine';
import { loadOrFetch4hBars } from './fetch-tra266-data.js';
import {
  BTC_DOMINANCE_BASKET as BASKET,
  type DominanceSeries,
  loadSyntheticBtcDominanceDaily,
} from './btc-dominance-synthetic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

// ── Spec constants (task TRA-298) ─────────────────────────────────────────

const UNIVERSE = ['SOL-USD', 'DOGE-USD'] as const;

const INITIAL_EQUITY_USD = 25_000;
const FEE_BPS = 40;
const SLIPPAGE_BPS = 5;
const RISK_FRACTION = 0.01;

const ATR_K_STOP = 2.0;
const ATR_K_TRAIL = 2.0;
const ATR_PERIOD = 14;
const RR_MIN = 2.0;
const TRAIL_ARM_R = 1.0;

// BB-reentry-long trigger — UNCHANGED from TRA-295/296
const BB_PERIOD = 20;
const BB_MULT = 2.0;
const BB_RSI_PERIOD = 14;
const BB_RSI_OVERSOLD = 30;

// BTC-dominance regime gate — task §2: SMA(50) → SMA(20)
const BTC_D_SMA_PERIOD = 20;

// Walk-forward — UNCHANGED
const TRAIN_BARS = 180 * 6;
const TEST_BARS = 90 * 6;
const STEP_BARS = TEST_BARS;
const ROLLING_DD_BARS = 90 * 6;

// XRP-aligned start (calendar-identical with TRA-287/292/294/295/296)
const ALIGNED_START_TS = Date.UTC(2023, 6, 13, 20);
const FROM_MS = Date.UTC(2022, 0, 1);

// §8 binding DD bar — recalibrated 25% per TRA-294 ratification.
const DD_BAR_PCT = 25;

const SKIP_NO_TRIGGER = 'no trigger emitted';
const SKIP_BTCD_WARMUP = '§2 btc.d sma(20) warm-up insufficient';
const SKIP_FUNDING_LONG_NOOP = '§5.1 funding gate (no-op for longs)';
const SKIP_ZERO_ATR = 'zero ATR — skipped';
const SKIP_ZERO_QTY = 'zero qty';
const SKIP_NEXT_BAR_MISSING = 'no next bar — entry impossible';
const SKIP_EQUITY_EXHAUSTED = 'equity exhausted';
const FIRED_PRE_GATE_BB = 'fired_pre_gate: bb_reentry_long';
const POST_GATE_BB = 'post_gate_tradeable: bb_reentry_long';
const GATED_BB_BTCD = '§2 gated_by_btcd: bb_reentry_long';

type Side = 'buy';
type SignalType = 'bb_reentry_long';
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

interface UniverseMetrics {
  trades: number;
  winners: number;
  hitRatePct: number;
  expectancyR: number;
  totalPnlUsd: number;
  rollingMaxDrawdownPct: number;
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

interface BollingerBar { middle: number; upper: number; lower: number; }

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
  bbLower: number[];
}

function preCompute(bars: Candle[]): PreCompute {
  const n = bars.length;
  const closes = bars.map((b) => b.close);

  const rsiSeries = new Array<number>(n).fill(NaN);
  const atrSeries = new Array<number>(n).fill(NaN);
  const bbLowerSeries = new Array<number>(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const closeWindow = closes.slice(0, i + 1);
    const candleWindow = bars.slice(0, i + 1);
    const rv = rsi(closeWindow, BB_RSI_PERIOD);
    const av = atr(candleWindow, ATR_PERIOD);
    rsiSeries[i] = Number.isFinite(rv) ? rv : NaN;
    atrSeries[i] = av ?? NaN;
    const bb = bollingerAt(closes, BB_PERIOD, BB_MULT, i);
    if (bb) bbLowerSeries[i] = bb.lower;
  }

  return { rsi: rsiSeries, atr14: atrSeries, bbLower: bbLowerSeries };
}

// ── BB-reentry-long detector (sole trigger; UNCHANGED from TRA-295/296) ───

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

    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;

      const pc = preBySymbol.get(sym)!;
      const sig = detectBbReentryLong(bars, pc, idx);
      if (sig) bumpSkip(FIRED_PRE_GATE_BB);

      const dom = input.dominance.lookup(bars[idx].timestamp);
      const altFavorable = dom !== null && dom.sma !== null && dom.dominance < dom.sma;

      if (sig) {
        if (dom === null || dom.sma === null) bumpSkip(SKIP_BTCD_WARMUP);
        else if (altFavorable) bumpSkip(POST_GATE_BB);
        else bumpSkip(GATED_BB_BTCD);
      }

      if (!sig) {
        bumpSkip(SKIP_NO_TRIGGER);
        continue;
      }
      if (!altFavorable) continue;

      bumpSkip(SKIP_FUNDING_LONG_NOOP);

      const equityNow = totalEquityUsd(latestCloseBySymbol);
      if (equityNow <= 0) { bumpSkip(SKIP_EQUITY_EXHAUSTED); continue; }
      if (idx + 1 >= bars.length) { bumpSkip(SKIP_NEXT_BAR_MISSING); continue; }
      const stopDistance = sig.entryPrice - sig.initialStop;
      if (stopDistance <= 0) { bumpSkip(SKIP_ZERO_ATR); continue; }
      const riskUsd = equityNow * RISK_FRACTION;
      const qty = riskUsd / stopDistance;
      if (qty <= 0) { bumpSkip(SKIP_ZERO_QTY); continue; }

      const entryFill = applyEntrySlippage('buy', sig.entryPrice);
      openLongs.push({
        signal: sig, side: 'buy', symbol: sym, type: sig.type,
        entryFill, qty,
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
      if (!o.trailArmed && latest.close >= o.entryFill + TRAIL_ARM_R * oneR) o.trailArmed = true;
      if (o.trailArmed) {
        const proposed = o.highWaterClose - ATR_K_TRAIL * o.atrAtTrigger;
        if (proposed > o.currentStop) o.currentStop = proposed;
      }

      const hitsStop = latest.low <= o.currentStop;
      const hitsTarget = latest.high >= o.takeProfit;
      let exitReason: ExitReason | null = null;
      let rawExit = 0;
      if (hitsStop && hitsTarget) { rawExit = o.takeProfit; exitReason = 'target'; }
      else if (hitsTarget) { rawExit = o.takeProfit; exitReason = 'target'; }
      else if (hitsStop) { rawExit = o.currentStop; exitReason = o.currentStop !== o.initialStop ? 'trailing' : 'stop'; }

      if (exitReason !== null) {
        const exitFill = applyExitSlippage('buy', rawExit);
        const pnl = netPnl('buy', o.entryFill, exitFill, o.qty);
        const r = rMultiple('buy', o.entryFill, exitFill, o.initialStop);
        cashUsd += pnl;
        closedLongs.push({
          symbol: sym, signalType: o.type, side: 'buy',
          openedAt: o.openedAt, closedAt: ts,
          entryFill: o.entryFill, exitFill, qty: o.qty,
          pnlUsd: pnl, rMultiple: r, exitReason,
          initialStop: o.initialStop,
        });
        const k = openLongs.indexOf(o);
        if (k >= 0) openLongs.splice(k, 1);
      }
    }

    equityCurve.push({ ts, equity: totalEquityUsd(latestCloseBySymbol) });
  }

  return { closedLongs, equityCurve, skipReasons };
}

// ── Walk-forward + window aggregation ─────────────────────────────────────

interface WindowSpec { trainStart: number; trainEnd: number; testStart: number; testEnd: number; }

function buildWindows(totalBars: number, trainBars: number, testBars: number, step: number): WindowSpec[] {
  const out: WindowSpec[] = [];
  let origin = 0;
  while (origin + trainBars + testBars <= totalBars) {
    out.push({
      trainStart: origin, trainEnd: origin + trainBars,
      testStart: origin + trainBars, testEnd: origin + trainBars + testBars,
    });
    origin += step;
  }
  return out;
}

interface WalkForwardOutput {
  windows: WindowReport[];
  equityCurve: Array<{ ts: number; equity: number }>;
  perWindow: Array<{ index: number; metrics: UniverseMetrics; perSymbol: PerSymbolMetrics[] }>;
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
      sliceMap.set(sym, all.slice(win.trainStart, win.testEnd));
    }
    const sim = runLongSim({ candlesBySymbol: sliceMap, dominance });

    const sampleSym = symbols[0];
    const sampleSlice = fullByPair.get(sampleSym)!;
    const testStartTs = sampleSlice[win.testStart].timestamp;
    const testEndTs = sampleSlice[Math.min(win.testEnd - 1, sampleSlice.length - 1)].timestamp;

    const testTrades = sim.closedLongs.filter((t) => t.openedAt >= testStartTs && t.openedAt <= testEndTs);
    const testEquity = sim.equityCurve.filter((p) => p.ts >= testStartTs && p.ts <= testEndTs);

    const testSkipReasons = recomputeTestWindowSkipHistogram(sliceMap, dominance, testStartTs, testEndTs);

    const windowReport: WindowReport = {
      ...sim,
      closedLongs: testTrades,
      equityCurve: testEquity,
      skipReasons: testSkipReasons,
      trainStart: win.trainStart, trainEnd: win.trainEnd,
      testStart: win.testStart, testEnd: win.testEnd,
      index: i,
    };

    out.windows.push(windowReport);
    out.equityCurve.push(...testEquity);

    const perSymbol = perSymbolMetrics(testTrades, symbols);
    const universe = universeMetrics(testTrades, testEquity, ROLLING_DD_BARS);
    out.perWindow.push({ index: i, metrics: universe, perSymbol });
  }

  return out;
}

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
      const sig = detectBbReentryLong(bars, pc, i);
      if (sig) bump(FIRED_PRE_GATE_BB);
      const dom = dominance.lookup(ts);
      const altFavorable = dom !== null && dom.sma !== null && dom.dominance < dom.sma;
      if (sig) {
        if (dom === null || dom.sma === null) bump(SKIP_BTCD_WARMUP);
        else if (altFavorable) bump(POST_GATE_BB);
        else bump(GATED_BB_BTCD);
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
      trades: ts.length, winners: winners.length,
      hitRatePct: ts.length > 0 ? (winners.length / ts.length) * 100 : 0,
      expectancyR: expectancy,
      totalPnlUsd: totalPnl,
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

interface PriorSidecar {
  perWindow: Array<{
    index: number;
    trades: number;
    hitRatePct: number;
    expectancyR: number;
    rollingMaxDrawdownPct?: number;
    postGateBb?: number;
  }>;
}

function maybeLoadTra296Sidecar(): PriorSidecar | null {
  const path = resolve(REPORT_DIR, 'tra296-sweep-4h-r9-meanrev-long-regime.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return { perWindow: raw.perWindow };
  } catch {
    return null;
  }
}

function buildReport(
  wf: WalkForwardOutput,
  symbols: string[],
  fullByPair: Map<string, Candle[]>,
  dominance: DominanceSeries,
  tra296: PriorSidecar | null,
): string {
  const lines: string[] = [];
  lines.push('# TRA-298 — §8 Walk-Forward Sweep Report (4H Phase-1.2.2 BB-reentry-only + SMA(20) BTC.D regime gate — r9 SOL+DOGE)\n');
  lines.push(`Generated: ${new Date().toISOString()}\n`);
  lines.push('Granularity: 4h');
  lines.push(`Universe: ${symbols.join(', ')} (r9 binding — TRA-292 trend-stack triggers parked, TRA-296 ATR-pullback parked-by-evidence)`);
  const sample = fullByPair.get(symbols[0])!;
  lines.push(`Date span: ${fmtDate(sample[0].timestamp)} → ${fmtDate(sample[sample.length - 1].timestamp)}`);
  lines.push(`Initial equity: $${INITIAL_EQUITY_USD.toLocaleString()}, fees ${FEE_BPS} bps taker, slippage ${SLIPPAGE_BPS} bps`);
  lines.push(`Walk-forward: train=${TRAIN_BARS}×4H, test=${TEST_BARS}×4H, step=${STEP_BARS}×4H, windows=${wf.windows.length}`);
  lines.push('');
  lines.push('## Diff vs TRA-296\n');
  lines.push('1. **ATR-pullback-long DROPPED.** TRA-296 ran -0.106R post-gate aggregate even after the §3 selectivity tightening. Park-by-evidence on this universe at this timeframe.');
  lines.push('2. **BTC.D gate SMA(50) → SMA(20).** TRA-296 had a density-floor problem (W2/W4/W7/W8 → 0/0/1/0 post-gate trades), not an edge-floor problem. A faster MA flips alt-favorable / alt-bleed sooner, recovering density on borderline quarters.');
  lines.push('');
  lines.push('## BB-reentry-long trigger (UNCHANGED from TRA-295/296)\n');
  lines.push('- close[i-1] ≤ lower BB(20, 2σ)');
  lines.push('- close[i] > lower BB(20, 2σ)');
  lines.push('- RSI(14)[i] > RSI(14)[i-1] AND RSI(14)[i-1] < 30');
  lines.push('- Entry: open of bar i+1');
  lines.push('');
  lines.push(`## BTC-dominance regime gate — SMA(${BTC_D_SMA_PERIOD})\n`);
  lines.push(`Source: synthetic 5-coin basket (BTC mcap / Σ(BTC+ETH+SOL+DOGE+XRP) on existing daily Coinbase caches with mid-period 2024 supply constants). Same source as TRA-296 — basket composition explicitly out-of-scope per task.`);
  lines.push('');
  lines.push(`Filter: SMA(${BTC_D_SMA_PERIOD}) on dominance. On 4H bar i, look up most-recent-completed daily synthetic-BTC.D close; if ≥ SMA(${BTC_D_SMA_PERIOD}) suppress entry, if below allow.`);
  lines.push('');
  const points = dominance.points;
  lines.push(`BTC.D series: ${points.length} daily points spanning ${fmtDate(points[0].ts)} → ${fmtDate(points[points.length - 1].ts)}; SMA(${BTC_D_SMA_PERIOD}) warm-up trivially covered (≥ 558d before aligned start, much more than ${BTC_D_SMA_PERIOD}d needed).`);
  lines.push('');
  lines.push(`Risk knobs (binding, UNCHANGED): 1% account risk per trade, ATR-2.0 stop, 1:2 R:R minimum target, ATR-trail engages at +1R favorable.`);
  lines.push('');
  lines.push(`§8 acceptance bar (UNCHANGED — all four bars binding): density ≥ 4 / hit ≥ 35% / expectancy ≥ +0.10R / DD90 ≤ ${DD_BAR_PCT}%. Pass on ≥ 5 / 9 windows.`);
  lines.push('');

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
  lines.push(`Passing windows (binding): ${passingCount} / ${wf.perWindow.length} (acceptance: ≥ 5 / 9)`);
  lines.push(`Failing windows: ${wf.perWindow.length - passingCount} / ${wf.perWindow.length}`);
  lines.push('');

  // Aggregate.
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

  // BB pre-gate / post-gate / gated histogram per window.
  lines.push('## BB-reentry pre-gate-fire / post-gate-tradeable histogram (per window, test span only)\n');
  lines.push('| Window | BB pre-gate | BB post-gate | BB gated | BTC.D warm-up missing |');
  lines.push('| ------ | ----------- | ------------ | -------- | --------------------- |');
  for (const w of wf.windows) {
    const r = w.skipReasons;
    const bbPre = r.get(FIRED_PRE_GATE_BB) ?? 0;
    const bbPost = r.get(POST_GATE_BB) ?? 0;
    const bbGated = r.get(GATED_BB_BTCD) ?? 0;
    const warmup = r.get(SKIP_BTCD_WARMUP) ?? 0;
    lines.push(`| ${w.index} | ${bbPre} | ${bbPost} | ${bbGated} | ${warmup} |`);
  }
  lines.push('');
  lines.push('Pre-gate = post-gate + gated + warm-up-missing per trigger.');
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

  // Side-by-side TRA-296 vs TRA-298 comparison.
  lines.push('## Side-by-side TRA-296 vs TRA-298 (per window)\n');
  lines.push('| Window | TRA-296 trades | TRA-298 trades | Δ trades | TRA-296 hit% | TRA-298 hit% | TRA-296 R | TRA-298 R | TRA-298 pass? |');
  lines.push('| ------ | -------------- | -------------- | -------- | ------------ | ------------ | --------- | --------- | ------------- |');
  for (const w of wf.perWindow) {
    const m = w.metrics;
    const prior = tra296?.perWindow.find((p) => p.index === w.index);
    const dT = prior ? `${m.trades - prior.trades >= 0 ? '+' : ''}${m.trades - prior.trades}` : '—';
    const tradesPrior = prior ? String(prior.trades) : '—';
    const hitPrior = prior ? prior.hitRatePct.toFixed(1) : '—';
    const expPrior = prior ? prior.expectancyR.toFixed(3) : '—';
    lines.push(`| ${w.index} | ${tradesPrior} | ${m.trades} | ${dT} | ${hitPrior} | ${m.hitRatePct.toFixed(1)} | ${expPrior} | ${m.expectancyR.toFixed(3)} | ${m.passes ? '✅' : '❌'} |`);
  }
  lines.push('');

  lines.push('## Decision\n');
  if (passingCount >= 5) {
    lines.push(`**SHIP SIGNAL** — ${passingCount} / 9 windows clear all four binding §8 bars (≥ 5 / 9 required), with the 25% rolling-90d DD bar binding. Phase-1.2.2 BB-reentry-only + SMA(20) regime gate ready to ship.`);
  } else {
    lines.push(`**FAIL** — Only ${passingCount} / 9 windows clear all four binding §8 bars (≥ 5 / 9 required). Per task spec, do **not** silently tune. Reassign back to QuantTrader with the per-window pre-gate vs post-gate trade counts (above), per-window BB-reentry-only expectancy (was W3 still negative without ATR-pullback?), and explicit notes on whether SMA(20) recovered density on TRA-296's W2/W4/W7/W8 dead-zones.`);
  }
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const fromMs = FROM_MS;
  const toMs = Date.now();

  console.log(`[run-tra298] Loading 4H bars ${fmtDate(fromMs)} → ${fmtDate(toMs)} for r9 universe ${UNIVERSE.join(', ')}`);
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
  console.log(`[run-tra298] Aligned to ${new Date(ALIGNED_START_TS).toISOString()}: ${aligned}`);

  console.log(`[run-tra298] Building synthetic BTC.D daily series (5-coin basket, SMA(${BTC_D_SMA_PERIOD}))…`);
  const dominance = await loadSyntheticBtcDominanceDaily(fromMs, toMs, BTC_D_SMA_PERIOD);
  const minDom = dominance.points[0];
  const maxDom = dominance.points[dominance.points.length - 1];
  console.log(`[run-tra298] BTC.D series: ${dominance.points.length} points, ${fmtDate(minDom.ts)} → ${fmtDate(maxDom.ts)}`);
  const snap = dominance.lookup(ALIGNED_START_TS);
  console.log(`[run-tra298] BTC.D snapshot @ aligned start ${fmtDate(ALIGNED_START_TS)}: dominance=${snap?.dominance.toFixed(3) ?? 'n/a'}, sma${BTC_D_SMA_PERIOD}=${snap?.sma?.toFixed(3) ?? 'n/a'}`);

  console.log('[run-tra298] Running BB-reentry-only + SMA(20) regime-gated walk-forward…');
  const wf = runWalkForward(fullByPair, dominance);
  console.log(`[run-tra298] ${wf.windows.length} windows produced.`);

  const symbols = [...UNIVERSE];
  const tra296 = maybeLoadTra296Sidecar();
  const report = buildReport(wf, symbols, fullByPair, dominance, tra296);
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, 'tra298-sweep-4h-r9-meanrev-long-bb-only-sma20.md');
  writeFileSync(reportPath, report);
  console.log(`\n[run-tra298] Report written: ${reportPath}`);

  const passingCount = wf.perWindow.filter((w) => w.metrics.passes).length;
  const passAll = passingCount >= 5;

  const totalSkips = (() => {
    const t = new Map<string, number>();
    for (const w of wf.windows) for (const [k, v] of w.skipReasons) t.set(k, (t.get(k) ?? 0) + v);
    return Object.fromEntries(t);
  })();

  const sidecarPath = resolve(REPORT_DIR, 'tra298-sweep-4h-r9-meanrev-long-bb-only-sma20.json');
  writeFileSync(sidecarPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    granularity: '4h',
    direction: 'long',
    triggerFamily: 'mean-reversion (regime-gated, BB-only)',
    triggers: ['bb_reentry_long'],
    universe: symbols,
    initialEquityUsd: INITIAL_EQUITY_USD,
    feeBps: FEE_BPS, slippageBps: SLIPPAGE_BPS, riskFraction: RISK_FRACTION,
    atrKStop: ATR_K_STOP, atrKTrail: ATR_K_TRAIL,
    rrMin: RR_MIN, trailArmR: TRAIL_ARM_R,
    bbPeriod: BB_PERIOD, bbMult: BB_MULT,
    btcdSmaPeriod: BTC_D_SMA_PERIOD,
    btcdSource: 'synthetic-5coin-basket',
    btcdBasket: BASKET,
    trainBars: TRAIN_BARS, testBars: TEST_BARS, stepBars: STEP_BARS,
    alignedStartTs: ALIGNED_START_TS,
    ddBarPct: DD_BAR_PCT,
    perWindow: wf.perWindow.map((w) => {
      const win = wf.windows.find((x) => x.index === w.index)!;
      const r = win.skipReasons;
      return {
        index: w.index,
        ...w.metrics,
        perSymbol: w.perSymbol,
        preGateBb: r.get(FIRED_PRE_GATE_BB) ?? 0,
        postGateBb: r.get(POST_GATE_BB) ?? 0,
        gatedBb: r.get(GATED_BB_BTCD) ?? 0,
        btcdWarmupMissing: r.get(SKIP_BTCD_WARMUP) ?? 0,
      };
    }),
    skipReasonsAggregate: totalSkips,
    decision: passAll ? 'PASS' : 'FAIL',
    passingWindowsBinding: passingCount,
    requiredPassing: 5,
  }, null, 2));
  console.log(`[run-tra298] JSON sidecar: ${sidecarPath}`);

  console.log(`\n=== TRA-298 §8 Acceptance (4H r9 BB-reentry-only + SMA(20) regime gate, SOL+DOGE) ===`);
  console.log(`Windows passing all four binding bars: ${passingCount} / ${wf.perWindow.length}`);
  console.log(`Decision: ${passAll ? 'PASS — ship signal' : 'FAIL — TRA-298 → QuantTrader'}`);
}

const invoked = process.argv[1] && /[\\/]run-tra298-meanrev-long-bb-only-sma20\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
