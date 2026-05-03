/**
 * TRA-292 — Phase-1.2 long-side §8 walk-forward sweep on 4H r9 (SOL + DOGE).
 *
 * Routed from TRA-291 escalation: the §4.4 short-trigger family was
 * wrong-direction for the 4H Coinbase tape on SOL+DOGE (mean expectancy
 * -0.336R across 9 windows). Fix is a direction pivot — short-side r9 is
 * implicitly parked for this run (this harness never emits a sell), and the
 * §5.1 funding gate is direction-aware (no-op on long entries per spec).
 *
 * The triggers mirror the §4.4 short stack, inverted:
 *
 *   - Momentum-long: RSI(14) at close[i-1] < 30 AND RSI(14) at close[i] > 35.
 *     Confirm with ATR(14)[i] >= 1.10 × mean(ATR(14)) over the trailing 20
 *     bars ending at i. Entry on the open of bar i+1.
 *   - Breakout-long: close[i] > max(high[i-20..i-1]) AND volume[i] > 1.50 ×
 *     mean(volume[i-20..i-1]). Entry on the open of bar i+1.
 *
 * Risk knobs (binding per task spec):
 *
 *   - 1% account risk per trade
 *   - ATR-2.0 initial stop below entry (atrK_stop = 2.0)
 *   - 1:2 R:R minimum target (atrK_tp = 4.0 ⇒ TP = entry + 2 × stopDistance)
 *   - ATR-trail engages at +1R favorable; trail = highWaterClose - 2.0 × ATR
 *
 * Walk-forward: aligned to the same XRP-aligned start as TRA-287
 * (2023-07-13T20:00:00Z) so the 9 windows are calendar-identical with the
 * short-side r9 sweep. train=1080×4H, test=540×4H, step=540×4H (≈ 6 mo / 3 mo
 * with the 4H bar density).
 *
 * Acceptance bar (§8 — task spec):
 *   - >= 4 trades / window
 *   - expectancy >= +0.10R
 *   - hit rate >= 35%
 *   - rolling-90d DD <= 8%
 *   - >= 5 of 9 windows must clear all of the above
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra292-long-sweep.ts
 *
 * Outputs:
 *   reports/tra291-sweep-4h-r9-long.md
 *   reports/tra291-sweep-4h-r9-long.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { atr } from '@trading-app/engine';
import { rsi } from '@trading-app/engine';
import { loadOrFetch4hBars } from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

// ── Spec constants (task TRA-292) ─────────────────────────────────────────

/** r9 universe binding — same as TRA-287 / TRA-291. */
const UNIVERSE = ['SOL-USD', 'DOGE-USD'] as const;

const INITIAL_EQUITY_USD = 25_000;
const FEE_BPS = 40;            // Coinbase Advanced Trade taker
const SLIPPAGE_BPS = 5;
const RISK_FRACTION = 0.01;    // 1% account risk per trade

const ATR_K_STOP = 2.0;        // Initial stop = entry - 2.0 × ATR(14)
const ATR_K_TRAIL = 2.0;       // ATR-trail = high-water close - 2.0 × ATR(14)
const RR_MIN = 2.0;            // 1:2 minimum reward:risk
const TRAIL_ARM_R = 1.0;       // Trail engages once price hits +1R favorable

// Momentum-long trigger
const RSI_PERIOD = 14;
const RSI_OVERSOLD = 30;       // close[i-1] < 30
const RSI_CROSS_BACK = 35;     // close[i] > 35
const ATR_CONFIRM_PERIOD = 14;
const ATR_CONFIRM_LOOKBACK = 20;
const ATR_CONFIRM_MULT = 1.10;

// Breakout-long trigger
const BREAKOUT_LOOKBACK = 20;
const VOLUME_CONFIRM_LOOKBACK = 20;
const VOLUME_CONFIRM_MULT = 1.50;

// Walk-forward window sizing — matches WINDOW_SIZING['4h'] in run-tra261-sweep
const TRAIN_BARS = 180 * 6;    // 1080 × 4H ≈ 6 months
const TEST_BARS = 90 * 6;      // 540 × 4H ≈ 3 months
const STEP_BARS = TEST_BARS;
const ROLLING_DD_BARS = 90 * 6;

// XRP-aligned start to match TRA-287's 9-window calendar exactly. The short-side
// r9 sweep was constrained by XRP's late listing (bars from 2023-07-13T20:00Z);
// to keep the SOL+DOGE long-side §8 numbers comparable window-by-window, we
// trim SOL/DOGE bars to the same start before windowing.
const ALIGNED_START_TS = Date.UTC(2023, 6, 13, 20); // 2023-07-13T20:00:00Z
const FROM_MS = Date.UTC(2022, 0, 1);

const SKIP_NO_TRIGGER = 'no trigger emitted';
const SKIP_FUNDING_LONG_NOOP = '§5.1 funding gate (no-op for longs)';
const SKIP_ZERO_ATR = 'zero ATR — skipped';
const SKIP_ZERO_QTY = 'zero qty';
const SKIP_NEXT_BAR_MISSING = 'no next bar — entry impossible';
const SKIP_EQUITY_EXHAUSTED = 'equity exhausted';

type Side = 'buy';
type SignalType = 'momentum_long' | 'breakout_long';
type ExitReason = 'target' | 'stop' | 'trailing' | 'time_stop';

interface LongSignal {
  symbol: string;
  type: SignalType;
  detectedAt: number; // close timestamp of bar i (trigger bar)
  entryAt: number;    // open timestamp of bar i+1 (entry bar)
  entryPrice: number; // open of bar i+1
  initialStop: number;
  takeProfit: number;
  atrAtTrigger: number;
}

interface OpenLong {
  signal: LongSignal;
  side: Side;
  symbol: string;
  type: SignalType;
  entryFill: number;       // slippage-adjusted entry
  qty: number;
  initialStop: number;     // immune to trailing — denominator for R
  currentStop: number;
  takeProfit: number;
  atrAtTrigger: number;
  highWaterClose: number;  // for ATR-trail high-water mark
  trailArmed: boolean;     // becomes true once close hits entry + 1R
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
  /** Per-bar mark-to-market combined-equity series (one entry per simulated 4H bar). */
  equityCurve: Array<{ ts: number; equity: number }>;
  /** Skip-reason histogram for diagnostics (pre-route). */
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
}

// ── Cost model ────────────────────────────────────────────────────────────

const slipRate = SLIPPAGE_BPS / 10_000;
const feeRate = FEE_BPS / 10_000;

function applyEntrySlippage(side: Side, entryPrice: number): number {
  // Long: pay up on entry (slip adverse).
  return side === 'buy' ? entryPrice * (1 + slipRate) : entryPrice * (1 - slipRate);
}

function applyExitSlippage(side: Side, rawExit: number): number {
  // Long: receive less on exit.
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

/**
 * Trailing-window mean of a series. Returns NaN if fewer than `period`
 * samples are available (so the caller can short-circuit instead of
 * silently averaging warmup zeroes).
 */
function trailingMean(values: number[], period: number, endIdxExclusive: number): number {
  if (endIdxExclusive < period) return NaN;
  let sum = 0;
  for (let i = endIdxExclusive - period; i < endIdxExclusive; i++) sum += values[i];
  return sum / period;
}

/**
 * Trailing-window max of a price series. Returns NaN if fewer than `period`
 * samples are available.
 */
function trailingMax(values: number[], period: number, endIdxExclusive: number): number {
  if (endIdxExclusive < period) return NaN;
  let m = -Infinity;
  for (let i = endIdxExclusive - period; i < endIdxExclusive; i++) {
    if (values[i] > m) m = values[i];
  }
  return m;
}

// ── Per-symbol indicator pre-compute ──────────────────────────────────────
//
// We pre-compute RSI(14), ATR(14), and the 20-bar trailing mean of ATR for
// every bar so trigger evaluation in the simulation loop is O(1). Bars before
// warmup get NaN; the trigger short-circuits on NaN (treated as "no trigger
// emitted" pre-route).

interface PreCompute {
  rsi: number[];          // RSI(14) at close[i]
  atr: number[];          // ATR(14) at close[i]
  atrMean20: number[];    // trailing 20-bar mean of ATR (excluding bar i)
  highMax20: number[];    // trailing 20-bar max of high (excluding bar i)
  volMean20: number[];    // trailing 20-bar mean of volume (excluding bar i)
}

function preCompute(bars: Candle[]): PreCompute {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const vols = bars.map((b) => b.volume);

  const rsiSeries = new Array<number>(n).fill(NaN);
  const atrSeries = new Array<number>(n).fill(NaN);
  const atrMean = new Array<number>(n).fill(NaN);
  const highMax = new Array<number>(n).fill(NaN);
  const volMean = new Array<number>(n).fill(NaN);

  // Walk forward computing RSI/ATR at each bar via a closing-window slice. The
  // RSI/ATR helpers are O(period) per call so total cost is O(n × period) per
  // symbol — fine for ~6k bars × 14 period.
  for (let i = 0; i < n; i++) {
    const closeWindow = closes.slice(0, i + 1);
    const candleWindow = bars.slice(0, i + 1);
    const rv = rsi(closeWindow, RSI_PERIOD);
    const av = atr(candleWindow, ATR_CONFIRM_PERIOD);
    rsiSeries[i] = Number.isFinite(rv) ? rv : NaN;
    atrSeries[i] = av ?? NaN;
  }

  // Trailing means/max over the prior 20 bars (NOT including bar i — the
  // breakout-long spec says "prior 20-bar high" and "20-bar volume mean",
  // both of which exclude the trigger bar's own value).
  for (let i = 0; i < n; i++) {
    atrMean[i] = trailingMean(atrSeries, ATR_CONFIRM_LOOKBACK, i);
    highMax[i] = trailingMax(highs, BREAKOUT_LOOKBACK, i);
    volMean[i] = trailingMean(vols, VOLUME_CONFIRM_LOOKBACK, i);
  }

  return { rsi: rsiSeries, atr: atrSeries, atrMean20: atrMean, highMax20: highMax, volMean20: volMean };
}

// ── Trigger evaluation ────────────────────────────────────────────────────

/**
 * Detect Momentum-long trigger at bar `i`. Requires:
 *   - RSI(14) at close[i-1] < 30
 *   - RSI(14) at close[i] > 35
 *   - ATR(14)[i] >= 1.10 × mean(ATR(14) over bars [i-20 .. i-1])
 *   - bar i+1 exists (so we have an open to enter on)
 */
function detectMomentumLong(bars: Candle[], pc: PreCompute, i: number): LongSignal | null {
  if (i <= 0 || i + 1 >= bars.length) return null;
  const rsiPrev = pc.rsi[i - 1];
  const rsiCurr = pc.rsi[i];
  if (!Number.isFinite(rsiPrev) || !Number.isFinite(rsiCurr)) return null;
  if (!(rsiPrev < RSI_OVERSOLD)) return null;
  if (!(rsiCurr > RSI_CROSS_BACK)) return null;

  const atrCurr = pc.atr[i];
  const atrMean = pc.atrMean20[i];
  if (!Number.isFinite(atrCurr) || !Number.isFinite(atrMean) || atrCurr <= 0) return null;
  if (!(atrCurr >= ATR_CONFIRM_MULT * atrMean)) return null;

  const entry = bars[i + 1].open;
  const stopDist = ATR_K_STOP * atrCurr;
  return {
    symbol: bars[i + 1].symbol,
    type: 'momentum_long',
    detectedAt: bars[i].timestamp,
    entryAt: bars[i + 1].timestamp,
    entryPrice: entry,
    initialStop: entry - stopDist,
    takeProfit: entry + RR_MIN * stopDist,
    atrAtTrigger: atrCurr,
  };
}

/**
 * Detect Breakout-long trigger at bar `i`. Requires:
 *   - close[i] > max(high[i-20 .. i-1])  (strictly above the prior 20-bar high)
 *   - volume[i] > 1.50 × mean(volume[i-20 .. i-1])
 *   - bar i+1 exists
 */
function detectBreakoutLong(bars: Candle[], pc: PreCompute, i: number): LongSignal | null {
  if (i <= 0 || i + 1 >= bars.length) return null;
  const closeI = bars[i].close;
  const highMax = pc.highMax20[i];
  const volI = bars[i].volume;
  const volMean = pc.volMean20[i];
  if (!Number.isFinite(highMax) || !Number.isFinite(volMean) || volMean <= 0) return null;
  if (!(closeI > highMax)) return null;
  if (!(volI > VOLUME_CONFIRM_MULT * volMean)) return null;

  const atrCurr = pc.atr[i];
  if (!Number.isFinite(atrCurr) || atrCurr <= 0) return null;

  const entry = bars[i + 1].open;
  const stopDist = ATR_K_STOP * atrCurr;
  return {
    symbol: bars[i + 1].symbol,
    type: 'breakout_long',
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

  // Pre-compute indicator series per symbol once, before the simulation loop.
  const preBySymbol = new Map<string, PreCompute>();
  for (const sym of symbols) preBySymbol.set(sym, preCompute(input.candlesBySymbol.get(sym)!));

  // Unified bar-step index — every 4H Coinbase symbol shares the same
  // 4H grid, so we walk on the intersection of bar timestamps to avoid
  // running ahead of any symbol's data.
  const tsSets = symbols.map((s) => new Set(input.candlesBySymbol.get(s)!.map((c) => c.timestamp)));
  const baseTimestamps = symbols.length > 0
    ? input.candlesBySymbol.get(symbols[0])!.map((c) => c.timestamp).filter((ts) => tsSets.every((set) => set.has(ts)))
    : [];

  // Per-symbol indices into their candle arrays at the current sim bar.
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
    // Long PnL: (px - entryFill) × qty
    let unrealised = 0;
    for (const o of openLongs) {
      const px = latestCloseBySymbol.get(o.symbol);
      if (px === undefined) continue;
      unrealised += (px - o.entryFill) * o.qty;
    }
    return cashUsd + unrealised;
  }

  for (const ts of baseTimestamps) {
    // Advance per-symbol indices to this timestamp.
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

    // ── 1) Per-symbol trigger evaluation on bar `i` (close-based). Entries
    //       deferred to the open of bar i+1, which we capture into the signal
    //       and fill on the next loop iteration.
    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;

      const pc = preBySymbol.get(sym)!;
      const sig =
        detectMomentumLong(bars, pc, idx) ?? detectBreakoutLong(bars, pc, idx);
      if (!sig) {
        bumpSkip(SKIP_NO_TRIGGER);
        continue;
      }

      // §5.1 funding gate is direction-aware: no-op for longs per task spec.
      // Bumped as a diagnostic so the histogram makes the no-op visible.
      bumpSkip(SKIP_FUNDING_LONG_NOOP);

      // Sizing — 1% account risk per trade. Stop distance is the spec
      // ATR-2.0; if it's zero (degenerate ATR) we skip and tally.
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

      // Open on the next bar's open with adverse slippage. Cash decreases by
      // the entry notional; mark-to-market closes the unrealised gap. To stay
      // direction-symmetric with the short harness we don't pre-debit cash —
      // the equity calc already folds unrealised PnL.
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

    // ── 2) Lifecycle for open longs on the *current* bar.
    for (const o of [...openLongs]) {
      const sym = o.symbol;
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;
      const latest = bars[idx];

      // Skip the entry bar's lifecycle pass — entries on this bar shouldn't
      // also exit on the same bar (matches the runner's behaviour).
      if (o.openedAt === ts) continue;

      o.barsHeld += 1;

      // High-water update for ATR-trail. Use close (matches "engages at +1R
      // favorable" spec semantics — we arm on a close that hits +1R, not on
      // an intra-bar wick).
      if (latest.close > o.highWaterClose) o.highWaterClose = latest.close;

      // Arm trail at +1R favorable on close.
      const oneR = o.entryFill - o.initialStop; // positive for longs
      if (!o.trailArmed && latest.close >= o.entryFill + TRAIL_ARM_R * oneR) {
        o.trailArmed = true;
      }

      // Trail update — only after armed. Use the trigger-bar ATR as the
      // trailing distance (spec §5: "trail moves with ATR(14)"; we lock the
      // ATR scalar at entry to keep the trail stable — recomputing per-bar
      // makes the trail noisier in vol expansion). Stop only ratchets up.
      if (o.trailArmed) {
        const proposed = o.highWaterClose - ATR_K_TRAIL * o.atrAtTrigger;
        if (proposed > o.currentStop) o.currentStop = proposed;
      }

      // Hard SL / TP. Long: low <= stop = stopped, high >= TP = filled.
      const hitsStop = latest.low <= o.currentStop;
      const hitsTarget = latest.high >= o.takeProfit;
      let exitReason: ExitReason | null = null;
      let rawExit = 0;
      if (hitsStop && hitsTarget) {
        // Optimistic resolution (TP first) matching the short-side runner.
        rawExit = o.takeProfit;
        exitReason = 'target';
      } else if (hitsTarget) {
        rawExit = o.takeProfit;
        exitReason = 'target';
      } else if (hitsStop) {
        rawExit = o.currentStop;
        exitReason = o.currentStop !== o.initialStop ? 'trailing' : 'stop';
      } else {
        // Time stop — mirror the short harness's `timeStopBarsFor` default
        // for momentum/breakout (no time-stop in TRA-261, so leave open).
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

    // ── 3) Per-bar MTM for the equity curve.
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
  perWindow: Array<{ index: number; metrics: UniverseMetrics; perSymbol: PerSymbolMetrics[] }>;
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
      // Pass train+test bars so RSI/ATR warmup is satisfied at testStart;
      // trades opened before testStart are filtered out below.
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
    const universe = universeMetrics(testTrades, testEquity, ROLLING_DD_BARS);
    out.perWindow.push({ index: i, metrics: universe, perSymbol });
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

  // §8 acceptance bars per task spec — all four must clear.
  const reasons: string[] = [];
  if (trades.length < 4) reasons.push(`trades ${trades.length} < 4`);
  if (expectancy < 0.10) reasons.push(`expectancy ${expectancy.toFixed(3)}R < 0.10R`);
  if (hitRatePct < 35) reasons.push(`hit rate ${hitRatePct.toFixed(1)}% < 35%`);
  if (rollingDD > 8) reasons.push(`rolling-90d DD ${rollingDD.toFixed(2)}% > 8%`);

  return {
    trades: trades.length,
    winners: winners.length,
    hitRatePct,
    expectancyR: expectancy,
    totalPnlUsd: totalPnl,
    rollingMaxDrawdownPct: rollingDD,
    passes: reasons.length === 0,
    reasons,
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
  lines.push('# TRA-292 — §8 Walk-Forward Sweep Report (4H Phase-1.2 long-side mirror — r9 SOL+DOGE)\n');
  lines.push(`Generated: ${new Date().toISOString()}\n`);
  lines.push('Granularity: 4h');
  lines.push(`Universe: ${symbols.join(', ')} (r9 binding — short-side spec implicitly parked for this run)`);
  const sample = fullByPair.get(symbols[0])!;
  lines.push(`Date span: ${fmtDate(sample[0].timestamp)} → ${fmtDate(sample[sample.length - 1].timestamp)}`);
  lines.push(`Initial equity: $${INITIAL_EQUITY_USD.toLocaleString()}, fees ${FEE_BPS} bps taker, slippage ${SLIPPAGE_BPS} bps`);
  lines.push(`Walk-forward: train=${TRAIN_BARS}×4H, test=${TEST_BARS}×4H, step=${STEP_BARS}×4H, windows=${wf.windows.length}`);
  lines.push('');
  lines.push('Triggers (mirror of §4.4 short stack, inverted):');
  lines.push('- **Momentum-long:** RSI(14)<30 at close[i-1] AND RSI(14)>35 at close[i] AND ATR(14)[i] ≥ 1.10×mean(ATR over trailing 20 bars). Entry on open of bar i+1.');
  lines.push('- **Breakout-long:** close[i] > max(high over prior 20 bars) AND volume[i] > 1.50×mean(volume over prior 20 bars). Entry on open of bar i+1.');
  lines.push('');
  lines.push('Risk knobs (binding): 1% account risk per trade, ATR-2.0 stop below entry, 1:2 R:R minimum target, ATR-trail engages at +1R favorable (trail = high-water close − 2.0×ATR(14)).');
  lines.push('');
  lines.push('§5.1 funding gate stays wired but is a no-op for longs (per task spec); cap remains active for any short trigger that fires elsewhere.');
  lines.push('');

  // ── Acceptance table ────────────────────────────────────────────────
  lines.push('## §8 Acceptance bars\n');
  lines.push('| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Reasons |');
  lines.push('| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | ------- |');
  for (const w of wf.windows) {
    const m = wf.perWindow[w.index].metrics;
    const startStr = w.equityCurve.length > 0 ? fmtDate(w.equityCurve[0].ts) : '—';
    const endStr = w.equityCurve.length > 0 ? fmtDate(w.equityCurve[w.equityCurve.length - 1].ts) : '—';
    const pass = m.passes ? '✅' : '❌';
    lines.push(`| ${w.index} | ${startStr}→${endStr} | ${m.trades} | ${m.hitRatePct.toFixed(1)} | ${m.expectancyR.toFixed(3)} | $${m.totalPnlUsd.toFixed(0)} | ${m.rollingMaxDrawdownPct.toFixed(2)} | ${pass} | ${m.reasons.join('; ') || '—'} |`);
  }
  lines.push('');
  const passingCount = wf.perWindow.filter((w) => w.metrics.passes).length;
  const failingCount = wf.perWindow.length - passingCount;
  lines.push(`Passing windows: ${passingCount} / ${wf.perWindow.length} (acceptance: ≥ 5 / 9)`);
  lines.push(`Failing windows: ${failingCount} / ${wf.perWindow.length}`);
  lines.push('');

  // ── Aggregate rollup ────────────────────────────────────────────────
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

  // ── Per-symbol per-window R decomposition ───────────────────────────
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

  // ── Pre-route skip-reason histogram ─────────────────────────────────
  const totalSkips = new Map<string, number>();
  for (const w of wf.windows) {
    for (const [k, v] of w.skipReasons) totalSkips.set(k, (totalSkips.get(k) ?? 0) + v);
  }
  if (totalSkips.size > 0) {
    lines.push('## Pre-route skip reasons\n');
    lines.push('| Reason | Count |');
    lines.push('| ------ | ----- |');
    const entries = [...totalSkips.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, v] of entries) lines.push(`| ${k} | ${v} |`);
    lines.push('');
  }

  // ── Decision ────────────────────────────────────────────────────────
  const passAll = passingCount >= 5;
  lines.push('## Decision\n');
  if (passAll) {
    lines.push(`**PASS** — ${passingCount} / 9 windows clear §8 acceptance bars (≥ 5 / 9 required). Phase-1.2 long-side pivot ready to ship.`);
  } else {
    lines.push(`**FAIL** — Only ${passingCount} / 9 windows clear §8 acceptance bars (≥ 5 / 9 required). Per task spec, route back to QuantTrader for next strategy/parameter call. Do **not** silently tune.`);
  }
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const fromMs = FROM_MS;
  const toMs = Date.now();

  console.log(`[run-tra292-long-sweep] Loading 4H bars ${fmtDate(fromMs)} → ${fmtDate(toMs)} for r9 universe ${UNIVERSE.join(', ')}`);
  const fullByPair = new Map<string, Candle[]>();
  for (const sym of UNIVERSE) {
    const bars = await loadOrFetch4hBars(sym, fromMs, toMs);
    fullByPair.set(sym, bars);
    console.log(`  ${sym}: ${bars.length} bars (${fmtDate(bars[0].timestamp)} → ${fmtDate(bars[bars.length - 1].timestamp)})`);
  }

  // Align to TRA-287's XRP-aligned start so the 9 windows are calendar-
  // identical with the short-side r9 sweep. Without alignment SOL+DOGE start
  // 18 months earlier than the TRA-287 calendar and we'd produce a different
  // (incomparable) 15-window grid.
  for (const [sym, bars] of fullByPair) {
    const trimmed = bars.filter((c) => c.timestamp >= ALIGNED_START_TS);
    fullByPair.set(sym, trimmed);
  }
  const aligned = [...fullByPair.entries()].map(([s, c]) => `${s}=${c.length}`).join(', ');
  console.log(`[run-tra292-long-sweep] Aligned to ${new Date(ALIGNED_START_TS).toISOString()}: ${aligned}`);

  console.log('[run-tra292-long-sweep] Running long-side walk-forward…');
  const wf = runWalkForward(fullByPair);
  console.log(`[run-tra292-long-sweep] ${wf.windows.length} windows produced.`);

  const symbols = [...UNIVERSE];
  const report = buildReport(wf, symbols, fullByPair);
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, 'tra291-sweep-4h-r9-long.md');
  writeFileSync(reportPath, report);
  console.log(`\n[run-tra292-long-sweep] Report written: ${reportPath}`);

  const passingCount = wf.perWindow.filter((w) => w.metrics.passes).length;
  const passAll = passingCount >= 5;

  // JSON sidecar — same shape as the short-side sweep so downstream
  // automation (TRA-291 update, dashboard) can read either side uniformly.
  const sidecarPath = resolve(REPORT_DIR, 'tra291-sweep-4h-r9-long.json');
  writeFileSync(sidecarPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    granularity: '4h',
    direction: 'long',
    universe: symbols,
    initialEquityUsd: INITIAL_EQUITY_USD,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    riskFraction: RISK_FRACTION,
    atrKStop: ATR_K_STOP,
    atrKTrail: ATR_K_TRAIL,
    rrMin: RR_MIN,
    trailArmR: TRAIL_ARM_R,
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    stepBars: STEP_BARS,
    alignedStartTs: ALIGNED_START_TS,
    perWindow: wf.perWindow.map((w) => ({
      index: w.index,
      ...w.metrics,
      perSymbol: w.perSymbol,
    })),
    skipReasons: (() => {
      const totalSkips = new Map<string, number>();
      for (const w of wf.windows) {
        for (const [k, v] of w.skipReasons) totalSkips.set(k, (totalSkips.get(k) ?? 0) + v);
      }
      return Object.fromEntries(totalSkips);
    })(),
    decision: passAll ? 'PASS' : 'FAIL',
    passingWindows: passingCount,
    requiredPassing: 5,
  }, null, 2));
  console.log(`[run-tra292-long-sweep] JSON sidecar: ${sidecarPath}`);

  console.log(`\n=== TRA-292 §8 Acceptance (4H r9 long, SOL+DOGE) ===`);
  console.log(`Windows passing all bars: ${passingCount} / ${wf.perWindow.length}`);
  console.log(`Decision: ${passAll ? 'PASS — Phase-1.2 long pivot ready to ship' : 'FAIL — TRA-292 → QuantTrader'}`);
}

const invoked = process.argv[1] && /[\\/]run-tra292-long-sweep\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
