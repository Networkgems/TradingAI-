/**
 * TRA-310 — Phase-1.3 dead-zone complementary-strategy KILL-GATE.
 *
 * QuantTrader research harness (not application code — consumes only existing
 * exported APIs: `donchian`, `atr` from @trading-app/engine, `loadOrFetch4hBars`
 * and `loadSyntheticBtcDominanceDaily`; same posture as run-tra432-validation.ts).
 *
 * Context — CFO authorization (TRA-310 thread, 2026-06-08, comment 9c072747):
 * Option 2 "refresh-then-build" approved but scoped as a bounded kill-gate, NOT
 * a build green-light. One research spin, no LLM spend. Re-validate the
 * dead-zone short design (candidate A: trend-following Donchian breakdown short
 * gated to the BTC-favorable regime) against the CURRENT robustness bar — the
 * lower-CI-bound block-bootstrap gate adopted after the TRA-431 (macd_bollinger)
 * and TRA-432 (bb_fade) Phase-2 NO-GOs. Route:
 *   - clears the tighter bar  -> update plan, request_confirmation, ping CFO
 *   - fails the tighter bar    -> close TRA-310 + TRA-291 won't-do with evidence
 *
 * Strategy under test (candidate A — pre-registered, SINGLE config, no sweep)
 * --------------------------------------------------------------------------
 * The TRA-431 root cause was multiple-comparisons / over-fit edge surviving a
 * mean-only bar. To not repeat it, exactly ONE parameterisation is tested here
 * and committed to a priori — no period sweep, no knob tuning.
 *
 *   Trigger — Donchian-20 breakdown SHORT (trend-following, NOT a mirror of
 *     TRA-296's BB-reentry long; per the strategy-mirror memo a valid trend-down
 *     trigger is structurally distinct from inverting a mean-reversion long):
 *       4H close[i] < Donchian lower channel = min(low[i-20 .. i-1])
 *       (engine `donchian(.., 20, excludeCurrent=true)`). Entry on open[i+1].
 *   Gate — BTC-favorable regime: most-recent-completed daily synthetic BTC.D
 *     >= SMA(50). This is the COMPLEMENT of TRA-296's alt-favorable gate, so the
 *     short is active in exactly the dead-zone windows (W2/W4/W7/W8) where the
 *     mean-rev long is correctly sidelined. Same 5-coin synthetic source +
 *     period (50) as the ratified TRA-296/298 gate — no MA-period sweeping.
 *   Risk knobs — TRA-291 chain defaults, unchanged: 1% account risk / trade,
 *     ATR(14)×2.0 initial stop (above entry for a short), 1:2 R:R min target,
 *     ATR-trail arms at +1R favorable (trail = low-water close + 2.0×ATR).
 *   Universe / calendar — SOL+DOGE 4H r9, XRP-aligned 9-window walk-forward
 *     (train 1080 / test 540 / step 540 ×4H). Candidate C (universe re-open)
 *     stays deferred per CFO guardrail 4.
 *
 * Acceptance — TWO bars, both reported; the robustness bar is BINDING
 * ---------------------------------------------------------------------
 *   (1) §8 walk-forward (TRA-296 parity, supporting evidence): per test window
 *       density >= 4, hit >= 35%, expectancy >= +0.10R, rolling-90d DD <= 25%;
 *       pass = clear all four on >= 5 / 9 windows.
 *   (2) Lower-CI-bound robustness gate (TRA-431/432, BINDING kill-gate): pool
 *       all post-gate test-window trade PnLs (each test window is out-of-sample
 *       vs its train window, so the pooled sequence is the walk-forward OOS
 *       analog of TRA-432's 2025 OOS block). 3000-iter moving-block bootstrap
 *       (blockLen 5, deterministic mulberry32). PASS requires p5 of the final-
 *       equity CI > start equity (positive after costs) AND >= 25 OOS trades.
 *       Same structural tells (fat tail / thin sample / OOS>IS) reported.
 *
 * Verdict logic: GO only if the robustness gate PASSES. The §8 result is
 * reported alongside but the binding gate is (2) per CFO scope. A clean NO-GO
 * here routes to won't-do closure of TRA-310 + TRA-291.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra310-donchian-short-validation.ts
 *
 * Writes reports/tra310-donchian-short-validation.json (+ .md summary).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { cachePathFor4h, type CacheEntry } from './fetch-tra266-data.js';
import {
  BTC_DOMINANCE_BASKET as BASKET,
  type DominanceSeries,
  loadSyntheticBtcDominanceDaily,
} from './btc-dominance-synthetic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

// ── Pre-registered spec constants (TRA-310 candidate A — SINGLE config) ──────
const UNIVERSE = ['SOL-USD', 'DOGE-USD'] as const;

const INITIAL_EQUITY_USD = 25_000;
const FEE_BPS = 40;
const SLIPPAGE_BPS = 5;
const RISK_FRACTION = 0.01;

const ATR_PERIOD = 14;
const ATR_K_STOP = 2.0;
const ATR_K_TRAIL = 2.0;
const RR_MIN = 2.0;
const TRAIL_ARM_R = 1.0;

const DONCHIAN_PERIOD = 20;       // pre-registered; NO sweep
const BTC_D_SMA_PERIOD = 50;      // ratified TRA-298 — NO MA-period sweeping

// Walk-forward — identical calendar to TRA-287 → TRA-309.
const TRAIN_BARS = 180 * 6;
const TEST_BARS = 90 * 6;
const STEP_BARS = TEST_BARS;
const ROLLING_DD_BARS = 90 * 6;
const ALIGNED_START_TS = Date.UTC(2023, 6, 13, 20);
const FROM_MS = Date.UTC(2022, 0, 1);

const DD_BAR_PCT = 25;            // §8 binding DD bar (TRA-294)
const ADEQUATE_OOS_TRADES = 25;   // TRA-432 adequacy floor for the bootstrap CI

const slipRate = SLIPPAGE_BPS / 10_000;
const feeRate = FEE_BPS / 10_000;

type Side = 'sell';
type ExitReason = 'target' | 'stop' | 'trailing';

interface ShortSignal {
  symbol: string;
  detectedAt: number;
  entryAt: number;
  entryPrice: number;
  initialStop: number;
  takeProfit: number;
  atrAtTrigger: number;
}

interface OpenShort {
  symbol: string;
  entryFill: number;
  qty: number;
  initialStop: number;
  currentStop: number;
  takeProfit: number;
  atrAtTrigger: number;
  lowWaterClose: number;
  trailArmed: boolean;
  openedAt: number;
  barsHeld: number;
}

interface ClosedShort {
  symbol: string;
  openedAt: number;
  closedAt: number;
  entryFill: number;
  exitFill: number;
  qty: number;
  pnlUsd: number;
  rMultiple: number;
  exitReason: ExitReason;
}

// ── Cost / R helpers (mirror TRA-296, short-side) ────────────────────────────
function applyEntrySlippage(side: Side, px: number): number {
  return side === 'sell' ? px * (1 - slipRate) : px * (1 + slipRate);
}
function applyExitSlippage(side: Side, px: number): number {
  // exiting a short = buying back -> slippage pushes the fill UP (worse).
  return side === 'sell' ? px * (1 + slipRate) : px * (1 - slipRate);
}
function netPnl(entryFill: number, exitFill: number, qty: number): number {
  const gross = (exitFill - entryFill) * qty * -1; // short: profit when price falls
  const commission = entryFill * qty * feeRate + exitFill * qty * feeRate;
  return gross - commission;
}
function rMultiple(entryFill: number, exitFill: number, initialStop: number): number {
  const stopDistance = Math.abs(entryFill - initialStop);
  if (stopDistance === 0) return 0;
  return ((exitFill - entryFill) * -1) / stopDistance;
}

// ── Indicator precompute (O(n)) ──────────────────────────────────────────────
/** Wilder ATR(14) full series; atrSeries[i] == engine atr(bars[0..i]). */
function atrSeries(bars: Candle[], period: number): number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period + 1) return out;
  const tr = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const c = bars[i], p = bars[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  // TR is defined for indices 1..n-1. Seed = SMA of first `period` TRs
  // (indices 1..period); first ATR value lands at bar index `period`.
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let smoothed = sum / period;
  out[period] = smoothed;
  for (let i = period + 1; i < n; i++) {
    smoothed = (smoothed * (period - 1) + tr[i]) / period;
    out[i] = smoothed;
  }
  return out;
}

/** Donchian lower channel excluding current bar: min(low[i-period .. i-1]). */
function donchianLowerSeries(bars: Candle[], period: number): number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    let lo = Infinity;
    for (let k = i - period; k < i; k++) if (bars[k].low < lo) lo = bars[k].low;
    out[i] = Number.isFinite(lo) ? lo : NaN;
  }
  return out;
}

interface PreCompute {
  atr: number[];
  donchLower: number[];
}
function preCompute(bars: Candle[]): PreCompute {
  return { atr: atrSeries(bars, ATR_PERIOD), donchLower: donchianLowerSeries(bars, DONCHIAN_PERIOD) };
}

function detectDonchianShort(bars: Candle[], pc: PreCompute, i: number): ShortSignal | null {
  if (i < DONCHIAN_PERIOD || i + 1 >= bars.length) return null;
  const lower = pc.donchLower[i];
  if (!Number.isFinite(lower)) return null;
  if (!(bars[i].close < lower)) return null;       // close breaks below prior 20-bar low
  const atrCurr = pc.atr[i];
  if (!Number.isFinite(atrCurr) || atrCurr <= 0) return null;
  const entry = bars[i + 1].open;
  const stopDist = ATR_K_STOP * atrCurr;
  return {
    symbol: bars[i + 1].symbol,
    detectedAt: bars[i].timestamp,
    entryAt: bars[i + 1].timestamp,
    entryPrice: entry,
    initialStop: entry + stopDist,
    takeProfit: entry - RR_MIN * stopDist,
    atrAtTrigger: atrCurr,
  };
}

// Skip-reason keys for the per-window histogram.
const FIRED_PRE_GATE = 'fired_pre_gate: donchian_short';
const POST_GATE = 'post_gate_tradeable: donchian_short';
const GATED_BTCD = 'gated_by_btcd (alt-favorable): donchian_short';
const SKIP_BTCD_WARMUP = 'btc.d sma(50) warm-up insufficient';

interface SimReport {
  closed: ClosedShort[];
  equityCurve: Array<{ ts: number; equity: number }>;
  skipReasons: Map<string, number>;
}
interface SimInput {
  candlesBySymbol: Map<string, Candle[]>;
  dominance: DominanceSeries;
}

function runShortSim(input: SimInput): SimReport {
  const symbols = Array.from(input.candlesBySymbol.keys());
  const preBySymbol = new Map<string, PreCompute>();
  for (const s of symbols) preBySymbol.set(s, preCompute(input.candlesBySymbol.get(s)!));

  const tsSets = symbols.map((s) => new Set(input.candlesBySymbol.get(s)!.map((c) => c.timestamp)));
  const baseTimestamps = symbols.length > 0
    ? input.candlesBySymbol.get(symbols[0])!.map((c) => c.timestamp).filter((ts) => tsSets.every((set) => set.has(ts)))
    : [];

  const idxBySymbol = new Map<string, number>();
  for (const s of symbols) idxBySymbol.set(s, 0);

  const openShorts: OpenShort[] = [];
  const closed: ClosedShort[] = [];
  const equityCurve: Array<{ ts: number; equity: number }> = [];
  const skipReasons = new Map<string, number>();
  const bump = (k: string) => skipReasons.set(k, (skipReasons.get(k) ?? 0) + 1);

  let cashUsd = INITIAL_EQUITY_USD;
  function totalEquity(latestClose: Map<string, number>): number {
    let unreal = 0;
    for (const o of openShorts) {
      const px = latestClose.get(o.symbol);
      if (px === undefined) continue;
      unreal += (px - o.entryFill) * o.qty * -1;
    }
    return cashUsd + unreal;
  }

  for (const ts of baseTimestamps) {
    for (const s of symbols) {
      const bars = input.candlesBySymbol.get(s)!;
      let idx = idxBySymbol.get(s)!;
      while (idx < bars.length && bars[idx].timestamp < ts) idx += 1;
      idxBySymbol.set(s, idx);
    }
    const latestClose = new Map<string, number>();
    for (const s of symbols) {
      const bars = input.candlesBySymbol.get(s)!;
      const idx = idxBySymbol.get(s)!;
      if (idx < bars.length && bars[idx].timestamp === ts) latestClose.set(s, bars[idx].close);
    }

    // 1) trigger eval
    for (const s of symbols) {
      const bars = input.candlesBySymbol.get(s)!;
      const idx = idxBySymbol.get(s)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;
      const pc = preBySymbol.get(s)!;
      const sig = detectDonchianShort(bars, pc, idx);
      if (!sig) continue;
      bump(FIRED_PRE_GATE);

      const dom = input.dominance.lookup(bars[idx].timestamp);
      if (dom === null || dom.sma === null) { bump(SKIP_BTCD_WARMUP); continue; }
      const btcFavorable = dom.dominance >= dom.sma;   // complement of TRA-296
      if (!btcFavorable) { bump(GATED_BTCD); continue; }
      bump(POST_GATE);

      const equityNow = totalEquity(latestClose);
      if (equityNow <= 0) continue;
      const stopDistance = sig.initialStop - sig.entryPrice;
      if (stopDistance <= 0) continue;
      const qty = (equityNow * RISK_FRACTION) / stopDistance;
      if (qty <= 0) continue;
      const entryFill = applyEntrySlippage('sell', sig.entryPrice);
      openShorts.push({
        symbol: s,
        entryFill,
        qty,
        initialStop: sig.initialStop,
        currentStop: sig.initialStop,
        takeProfit: sig.takeProfit,
        atrAtTrigger: sig.atrAtTrigger,
        lowWaterClose: entryFill,
        trailArmed: false,
        openedAt: sig.entryAt,
        barsHeld: 0,
      });
    }

    // 2) lifecycle
    for (const o of [...openShorts]) {
      const bars = input.candlesBySymbol.get(o.symbol)!;
      const idx = idxBySymbol.get(o.symbol)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;
      const latest = bars[idx];
      if (o.openedAt === ts) continue;
      o.barsHeld += 1;
      if (latest.close < o.lowWaterClose) o.lowWaterClose = latest.close;

      const oneR = o.initialStop - o.entryFill;
      if (!o.trailArmed && latest.close <= o.entryFill - TRAIL_ARM_R * oneR) o.trailArmed = true;
      if (o.trailArmed) {
        const proposed = o.lowWaterClose + ATR_K_TRAIL * o.atrAtTrigger;
        if (proposed < o.currentStop) o.currentStop = proposed;
      }

      const hitsStop = latest.high >= o.currentStop;
      const hitsTarget = latest.low <= o.takeProfit;
      let exitReason: ExitReason | null = null;
      let rawExit = 0;
      if (hitsTarget) { rawExit = o.takeProfit; exitReason = 'target'; }
      else if (hitsStop) { rawExit = o.currentStop; exitReason = o.currentStop !== o.initialStop ? 'trailing' : 'stop'; }

      if (exitReason !== null) {
        const exitFill = applyExitSlippage('sell', rawExit);
        const pnl = netPnl(o.entryFill, exitFill, o.qty);
        const r = rMultiple(o.entryFill, exitFill, o.initialStop);
        cashUsd += pnl;
        closed.push({
          symbol: o.symbol, openedAt: o.openedAt, closedAt: ts,
          entryFill: o.entryFill, exitFill, qty: o.qty, pnlUsd: pnl, rMultiple: r, exitReason,
        });
        const k = openShorts.indexOf(o);
        if (k >= 0) openShorts.splice(k, 1);
      }
    }

    equityCurve.push({ ts, equity: totalEquity(latestClose) });
  }
  return { closed, equityCurve, skipReasons };
}

// ── Walk-forward ─────────────────────────────────────────────────────────────
interface WindowSpec { trainStart: number; trainEnd: number; testStart: number; testEnd: number; }
function buildWindows(total: number, train: number, test: number, step: number): WindowSpec[] {
  const out: WindowSpec[] = [];
  let o = 0;
  while (o + train + test <= total) {
    out.push({ trainStart: o, trainEnd: o + train, testStart: o + train, testEnd: o + train + test });
    o += step;
  }
  return out;
}

interface WindowMetrics {
  index: number;
  trades: number;
  winners: number;
  hitRatePct: number;
  expectancyR: number;
  totalPnlUsd: number;
  rollingDdPct: number;
  passes: boolean;
  reasons: string[];
  preGate: number;
  postGate: number;
  gated: number;
}

function rollingMaxDdPct(curve: Array<{ ts: number; equity: number }>, windowBars: number): number {
  if (curve.length < 2) return 0;
  let worst = 0;
  for (let i = 0; i < curve.length; i++) {
    const lo = Math.max(0, i - windowBars + 1);
    let peak = curve[lo].equity;
    let dd = 0;
    for (let j = lo; j <= i; j++) {
      const eq = curve[j].equity;
      if (eq > peak) peak = eq;
      if (peak > 0) { const c = ((peak - eq) / peak) * 100; if (c > dd) dd = c; }
    }
    if (dd > worst) worst = dd;
  }
  return worst;
}

function metricsForWindow(
  index: number, trades: ClosedShort[], equity: Array<{ ts: number; equity: number }>,
  hist: Map<string, number>,
): WindowMetrics {
  const winners = trades.filter((t) => t.pnlUsd > 0);
  const expectancy = trades.length > 0 ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const hit = trades.length > 0 ? (winners.length / trades.length) * 100 : 0;
  const pnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const dd = rollingMaxDdPct(equity, ROLLING_DD_BARS);
  const reasons: string[] = [];
  if (trades.length < 4) reasons.push(`trades ${trades.length} < 4`);
  if (expectancy < 0.10) reasons.push(`expectancy ${expectancy.toFixed(3)}R < 0.10R`);
  if (hit < 35) reasons.push(`hit ${hit.toFixed(1)}% < 35%`);
  if (dd > DD_BAR_PCT) reasons.push(`DD90 ${dd.toFixed(1)}% > ${DD_BAR_PCT}%`);
  return {
    index, trades: trades.length, winners: winners.length, hitRatePct: hit,
    expectancyR: expectancy, totalPnlUsd: pnl, rollingDdPct: dd,
    passes: reasons.length === 0, reasons,
    preGate: hist.get(FIRED_PRE_GATE) ?? 0,
    postGate: hist.get(POST_GATE) ?? 0,
    gated: hist.get(GATED_BTCD) ?? 0,
  };
}

function recomputeTestHistogram(
  candlesBySymbol: Map<string, Candle[]>, dominance: DominanceSeries, t0: number, t1: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  for (const [, bars] of candlesBySymbol) {
    const pc = preCompute(bars);
    for (let i = 0; i < bars.length; i++) {
      const ts = bars[i].timestamp;
      if (ts < t0 || ts > t1) continue;
      const sig = detectDonchianShort(bars, pc, i);
      if (!sig) continue;
      bump(FIRED_PRE_GATE);
      const dom = dominance.lookup(ts);
      if (dom === null || dom.sma === null) { bump(SKIP_BTCD_WARMUP); continue; }
      if (dom.dominance >= dom.sma) bump(POST_GATE); else bump(GATED_BTCD);
    }
  }
  return out;
}

interface WalkForwardOutput {
  perWindow: WindowMetrics[];
  pooledTestTrades: ClosedShort[];
  concatEquity: Array<{ ts: number; equity: number }>;
}

function runWalkForward(fullByPair: Map<string, Candle[]>, dominance: DominanceSeries): WalkForwardOutput {
  const symbols = Array.from(fullByPair.keys());
  const minLen = Math.min(...symbols.map((s) => fullByPair.get(s)!.length));
  const wins = buildWindows(minLen, TRAIN_BARS, TEST_BARS, STEP_BARS);
  const perWindow: WindowMetrics[] = [];
  const pooledTestTrades: ClosedShort[] = [];
  const concatEquity: Array<{ ts: number; equity: number }> = [];

  for (let i = 0; i < wins.length; i++) {
    const win = wins[i];
    const sliceMap = new Map<string, Candle[]>();
    for (const s of symbols) sliceMap.set(s, fullByPair.get(s)!.slice(win.trainStart, win.testEnd));
    const sim = runShortSim({ candlesBySymbol: sliceMap, dominance });

    const sample = fullByPair.get(symbols[0])!;
    const t0 = sample[win.testStart].timestamp;
    const t1 = sample[Math.min(win.testEnd - 1, sample.length - 1)].timestamp;
    const testTrades = sim.closed.filter((t) => t.openedAt >= t0 && t.openedAt <= t1);
    const testEquity = sim.equityCurve.filter((p) => p.ts >= t0 && p.ts <= t1);
    const hist = recomputeTestHistogram(sliceMap, dominance, t0, t1);

    perWindow.push(metricsForWindow(i, testTrades, testEquity, hist));
    pooledTestTrades.push(...testTrades);
    concatEquity.push(...testEquity);
  }
  return { perWindow, pooledTestTrades, concatEquity };
}

// ── Block bootstrap (byte-identical to TRA-432 §4) ──────────────────────────
function blockBootstrap(pnls: number[], initialEquity: number, blockLen = 5, iterations = 3000, seed = 310) {
  if (pnls.length === 0) return null;
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = pnls.length;
  const finals: number[] = [];
  let worstDd = 0;
  for (let it = 0; it < iterations; it++) {
    let equity = initialEquity, peak = initialEquity, dd = 0, drawn = 0;
    while (drawn < n) {
      const start = Math.floor(rand() * n);
      for (let k = 0; k < blockLen && drawn < n; k++, drawn++) {
        equity += pnls[(start + k) % n];
        peak = Math.max(peak, equity);
        if (peak > 0) dd = Math.max(dd, (peak - equity) / peak);
      }
    }
    finals.push(equity);
    worstDd = Math.max(worstDd, dd);
  }
  finals.sort((a, b) => a - b);
  const pct = (p: number) => finals[Math.min(finals.length - 1, Math.floor((p / 100) * finals.length))];
  const p5 = pct(5), p50 = pct(50), p95 = pct(95);
  const ret = (eq: number) => ((eq - initialEquity) / initialEquity) * 100;
  return {
    blockLen, iterations,
    p5Usd: p5, p50Usd: p50, p95Usd: p95,
    p5ReturnPct: ret(p5), p50ReturnPct: ret(p50), p95ReturnPct: ret(p95),
    worstDdPct: worstDd * 100,
  };
}

function structuralTells(pnls: number[]) {
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const sortedWinsDesc = [...wins].sort((a, b) => b - a);
  const top1 = grossProfit > 0 ? (sortedWinsDesc[0] ?? 0) / grossProfit : 0;
  const top3 = grossProfit > 0 ? sortedWinsDesc.slice(0, 3).reduce((a, b) => a + b, 0) / grossProfit : 0;
  const mean = n > 0 ? pnls.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  const sd = Math.sqrt(variance);
  const exKurt = n > 3 && sd > 0 ? pnls.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / n - 3 : 0;
  const tells: string[] = [];
  if (n < ADEQUATE_OOS_TRADES) tells.push(`THIN SAMPLE — only ${n} OOS trades (< ${ADEQUATE_OOS_TRADES})`);
  if (top1 > 0.35) tells.push(`FAT TAIL — single best trade = ${(top1 * 100).toFixed(0)}% of gross profit`);
  if (top3 > 0.6) tells.push(`FAT TAIL — top-3 trades = ${(top3 * 100).toFixed(0)}% of gross profit`);
  if (exKurt > 3) tells.push(`FAT TAIL — excess kurtosis ${exKurt.toFixed(1)}`);
  return { grossProfitUsd: grossProfit, top1WinShareOfGrossProfit: top1, top3WinShareOfGrossProfit: top3, excessKurtosis: exKurt, tells };
}

function fmtDate(ts: number): string { return new Date(ts).toISOString().slice(0, 10); }

/** Read a 4H cache directly off disk (bypasses the 12h TTL refetch — the
 *  on-disk TRA-427 caches are deterministic and we run fully offline, same
 *  posture as run-tra432-validation.ts which reads cachePathFor4h directly). */
function loadCached4h(symbol: string): Candle[] {
  const path = cachePathFor4h(symbol);
  if (!existsSync(path)) throw new Error(`4H cache ${path} missing — run run-tra432-fetch.ts first`);
  const entry = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
  return entry.candles;
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  console.log(`[tra310] Loading 4H bars for ${UNIVERSE.join(', ')} (Donchian-${DONCHIAN_PERIOD} short kill-gate)`);
  const fullByPair = new Map<string, Candle[]>();
  let lastBarTs = 0;
  for (const sym of UNIVERSE) {
    const bars = loadCached4h(sym).filter((c) => c.timestamp >= ALIGNED_START_TS);
    fullByPair.set(sym, bars);
    lastBarTs = Math.max(lastBarTs, bars[bars.length - 1].timestamp);
    console.log(`  ${sym}: ${bars.length} aligned 4H bars (${fmtDate(bars[0].timestamp)} → ${fmtDate(bars[bars.length - 1].timestamp)})`);
  }
  // Cap the dominance request at the last cached 4H bar so the daily series
  // only needs to cover the actual backtest span.
  const toMs = lastBarTs;

  console.log('[tra310] Building synthetic BTC.D daily series (5-coin basket, SMA 50)…');
  const dominance = await loadSyntheticBtcDominanceDaily(FROM_MS, toMs, BTC_D_SMA_PERIOD);
  console.log(`[tra310] BTC.D: ${dominance.points.length} daily points, ${fmtDate(dominance.points[0].ts)} → ${fmtDate(dominance.points[dominance.points.length - 1].ts)}`);

  const wf = runWalkForward(fullByPair, dominance);

  // §8 view
  const passingWindows = wf.perWindow.filter((w) => w.passes).length;
  const eightPass = passingWindows >= 5;

  // Robustness (binding) view
  const pooledPnls = wf.pooledTestTrades.map((t) => t.pnlUsd);
  const boot = blockBootstrap(pooledPnls, INITIAL_EQUITY_USD);
  const tells = structuralTells(pooledPnls);
  const winners = wf.pooledTestTrades.filter((t) => t.pnlUsd > 0).length;
  const aggHit = pooledPnls.length > 0 ? (winners / pooledPnls.length) * 100 : 0;
  const aggExp = wf.pooledTestTrades.length > 0 ? wf.pooledTestTrades.reduce((s, t) => s + t.rMultiple, 0) / wf.pooledTestTrades.length : 0;
  const aggDd = rollingMaxDdPct(wf.concatEquity, ROLLING_DD_BARS);
  const p5Positive = boot ? boot.p5Usd > INITIAL_EQUITY_USD : false;
  const sampleAdequate = pooledPnls.length >= ADEQUATE_OOS_TRADES;
  const robustnessPass = p5Positive && sampleAdequate;

  const verdict = robustnessPass ? 'GO' : 'NO-GO';

  // ── Console summary ──
  console.log(`\n=== TRA-310 Donchian-${DONCHIAN_PERIOD} short kill-gate (SOL+DOGE 4H r9, BTC-favorable gate) ===`);
  console.log(`Pooled OOS test trades: ${pooledPnls.length}  (winners ${winners}, hit ${aggHit.toFixed(1)}%, mean ${aggExp.toFixed(3)}R)`);
  console.log(`Concatenated rolling-90d DD: ${aggDd.toFixed(1)}%`);
  console.log('\n§8 walk-forward (supporting):');
  console.log('  Win | tr | hit%  | expR   | DD90% | pre/post/gated | pass');
  for (const w of wf.perWindow) {
    console.log(`  ${String(w.index).padStart(2)}  | ${String(w.trades).padStart(2)} | ${w.hitRatePct.toFixed(1).padStart(5)} | ${w.expectancyR.toFixed(3).padStart(6)} | ${w.rollingDdPct.toFixed(1).padStart(5)} | ${w.preGate}/${w.postGate}/${w.gated} | ${w.passes ? '✅' : '❌'}`);
  }
  console.log(`  §8 passing windows: ${passingWindows} / ${wf.perWindow.length} (need ≥5) → ${eightPass ? 'PASS' : 'FAIL'}`);
  console.log('\nRobustness gate (BINDING — lower-CI-bound, TRA-431/432):');
  if (boot) {
    console.log(`  p5  = $${boot.p5Usd.toFixed(0)}  (${boot.p5ReturnPct >= 0 ? '+' : ''}${boot.p5ReturnPct.toFixed(2)}%)`);
    console.log(`  p50 = $${boot.p50Usd.toFixed(0)}  (${boot.p50ReturnPct >= 0 ? '+' : ''}${boot.p50ReturnPct.toFixed(2)}%)`);
    console.log(`  p95 = $${boot.p95Usd.toFixed(0)}  (${boot.p95ReturnPct >= 0 ? '+' : ''}${boot.p95ReturnPct.toFixed(2)}%)`);
  } else {
    console.log('  bootstrap SKIPPED — 0 pooled trades');
  }
  for (const t of tells.tells) console.log(`  ⚠ ${t}`);
  console.log(`  p5 positive: ${p5Positive} | sample adequate (≥${ADEQUATE_OOS_TRADES}): ${sampleAdequate}`);
  console.log(`\nVERDICT: ${verdict}`);

  const payload = {
    generatedAt: new Date().toISOString(),
    issue: 'TRA-310',
    strategy: 'donchian_breakdown_short',
    candidate: 'A (trend-following short, BTC-favorable gate)',
    preRegistered: { donchianPeriod: DONCHIAN_PERIOD, btcdSmaPeriod: BTC_D_SMA_PERIOD, note: 'single config, no sweep (TRA-431 multiple-comparisons discipline)' },
    universe: [...UNIVERSE],
    barTimeframe: '4h',
    gate: 'BTC-favorable: synthetic BTC.D >= SMA(50) (complement of TRA-296)',
    btcdSource: 'synthetic-5coin-basket',
    btcdBasket: BASKET,
    riskKnobs: { riskFraction: RISK_FRACTION, atrKStop: ATR_K_STOP, atrKTrail: ATR_K_TRAIL, rrMin: RR_MIN, trailArmR: TRAIL_ARM_R },
    walkForward: { trainBars: TRAIN_BARS, testBars: TEST_BARS, stepBars: STEP_BARS, alignedStartTs: ALIGNED_START_TS, windows: wf.perWindow.length },
    costModel: { feeBps: FEE_BPS, slippageBps: SLIPPAGE_BPS, initialEquityUsd: INITIAL_EQUITY_USD },
    section8: {
      bar: 'density>=4, hit>=35%, expectancy>=+0.10R, DD90<=25%, pass>=5/9',
      passingWindows, requiredPassing: 5, verdict: eightPass ? 'PASS' : 'FAIL',
      perWindow: wf.perWindow,
    },
    robustnessGate: {
      bar: 'p5 of OOS block-bootstrap CI > start equity AND pooled OOS trades >= 25',
      pooledOosTrades: pooledPnls.length,
      aggHitPct: aggHit, aggExpectancyR: aggExp, aggRollingDd90Pct: aggDd,
      blockBootstrap: boot, structural: tells,
      p5Positive, sampleAdequate, verdict: robustnessPass ? 'PASS' : 'FAIL',
    },
    bindingGate: 'robustnessGate',
    verdict,
  };
  writeFileSync(resolve(REPORT_DIR, 'tra310-donchian-short-validation.json'), JSON.stringify(payload, null, 2));
  console.log(`\nWrote reports/tra310-donchian-short-validation.json`);
}

const invoked = process.argv[1] && /[\\/]run-tra310-donchian-short-validation\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
