/**
 * TRA-309 — Phase-1.2.4 BB+tight-ATR + asset-side EMA(200)+slope(EMA(50)) OR
 * overlay supplementing SMA(50) BTC.D gate, §8 walk-forward sweep on 4H r9
 * (SOL+DOGE).
 *
 * Routed forward from TRA-308 (LeadDev FAIL report 2/9 + QuantTrader decision).
 * Sibling child of TRA-291, continuation of the
 * TRA-308 → TRA-298 → TRA-297 → TRA-295 → TRA-287 chain.
 *
 * Diff vs TRA-299 / TRA-308 (`run-tra299-meanrev-long-bbatr-asset-overlay.ts`)
 * ----------------------------------------------------------------------------
 *
 *   1. Trigger family — REVERT to TRA-296 baseline (BB-reentry-long +
 *      *tight* ATR-pullback-long). Concretely vs TRA-299:
 *
 *        - BB-reentry-long: UNCHANGED (TRA-295 ≡ TRA-296 ≡ TRA-299 spec).
 *        - ATR-pullback-long: RE-TIGHTENED back to TRA-296 spec — depth
 *          2.5×ATR (TRA-299 was 2.0×), vol 1.5× (TRA-299 was 1.2×), and
 *          re-instate RSI(14)[i-1] < 40 entry-bar filter (TRA-299 dropped it).
 *
 *      Per TRA-309 spec §1: TRA-308's revert to loose ATR-pullback regressed
 *      W6 from PASS (+0.105R) to FAIL (+0.071R), accounting for the 3→2 drop
 *      vs TRA-296. Clean A/B requires re-installing the working trigger
 *      baseline so the only-new-variable is the asset-side overlay.
 *
 *   2. BTC.D regime gate — KEPT at SMA(50). Same synthetic 5-coin basket,
 *      same loader (`./btc-dominance-synthetic.ts`), same per-bar lookup.
 *      Period stays 50 (TRA-298 confirmed local optimum).
 *
 *   3. NEW asset-side EMA(200) + slope(EMA(50)) trend overlay — replaces
 *      TRA-299's plain EMA(50) leg. Applied as an `OR` with the BTC.D gate.
 *      For each candidate trigger fire on bar `i` (4H), allow the entry
 *      if EITHER:
 *
 *        - **(existing BTC.D leg)** most-recent-completed daily synthetic
 *          BTC.D close < SMA(synthetic BTC.D, 50), OR
 *        - **(new asset leg)** `close[i-1] > EMA(close, 200)[i-1]` AND
 *          `EMA(close, 50)[i-1] > EMA(close, 50)[i-2]` on the entered
 *          asset (4H bars). Both sub-conditions are required (internal AND);
 *          the asset leg as a whole is OR\'d with the BTC.D leg.
 *
 *      Rationale (per TRA-309 §3): TRA-308's plain EMA(50) leg admitted
 *      ZERO marginal signals on all 9 windows (per LeadDev's diagnostic).
 *      ATR-pullback was mathematically excluded (its trigger requires
 *      close < EMA(50) − 2×ATR, implying close < EMA(50)). BB-reentry was
 *      empirically excluded — on SOL+DOGE 4H, lower-band-touch coincides
 *      100% with close < EMA(50). The overlay never fired.
 *
 *      EMA(200) on 4H is ~33-day trend baseline — far enough from BB(20)'s
 *      ~3-day centering that the geometric coincidence problem from TRA-308
 *      should not recur. The slope(EMA(50)) condition adds independent
 *      momentum information that doesn't share the trigger's anchor.
 *
 *      OR (not AND) at the gate level is deliberate — we are *adding*
 *      firing opportunity, not further restricting.
 *
 *      Note: with the tight ATR-pullback restored, the asset leg may now
 *      admit ATR-pullback signals as well (depth 2.5×ATR pulls deeper than
 *      EMA(50) but is no longer mechanically below EMA(200), which sits
 *      well above EMA(50) in trending markets). Per-leg attribution
 *      reporting splits the leg counts per-trigger so we can audit.
 *
 *   4. Risk knobs — UNCHANGED. 1% account risk per trade, ATR-2.0 initial
 *      stop, 1:2 R:R minimum target, ATR-trail engages at +1R favorable
 *      (trail = high-water close − 2.0×ATR(14)).
 *
 *   5. §5.1 funding gate — UNCHANGED, direction-aware (no-op on longs).
 *
 *   6. Universe + calendar — UNCHANGED. SOL-USD + DOGE-USD on 4H r9, same
 *      XRP-aligned 9 walk-forward windows as TRA-287/292/294/295/297/298/308.
 *
 *   7. Warm-up — TRAIN_BARS = 1080 × 4H per window comfortably covers the
 *      EMA(200) requirement (1080 ≫ 200). Confirmed in the report.
 *
 * §8 acceptance bar (UNCHANGED — task TRA-309 §7)
 * -----------------------------------------------
 *
 *   - Density ≥ 4 trades / window (post-gate)
 *   - Hit rate ≥ 35%
 *   - Expectancy ≥ +0.10R
 *   - Rolling-90d DD ≤ 25% (binding per §8.1 amendment ratified in TRA-294
 *     — see reports/SPEC.md for full text)
 *   - Pass criterion: clear all four bars on ≥ 5 of 9 windows.
 *
 * §8.1 amendment — universe-aware rolling-90d DD bar (verbatim from TRA-294
 * ratification comment, carried forward per task spec):
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
 *   For the SOL+DOGE 4H r9 universe (30% hit / 1:2 R:R / 1.0% risk /
 *   ~38 trades per 90-day window) the resulting bar is 25%.
 *
 * Reporting (per TRA-309 §3 + Deliverables)
 * -----------------------------------------
 *
 *   - Per-window §8 acceptance table (binding: trades + hit + expectancy + DD90).
 *   - Per-symbol per-window R decomposition.
 *   - Per-trigger pre-gate / post-gate / blocked histogram.
 *   - Per-window per-asset breakdown of *entries by gate leg*:
 *     (BTC.D-only / asset-overlay-only / both / blocked) split per trigger.
 *   - Side-by-side TRA-296 vs TRA-309 per-window comparison so the
 *     asset-overlay effect is auditable (loads tra296 sidecar JSON).
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx \
 *     src/run-tra309-meanrev-long-bbatr-asset-overlay-ema200.ts
 *
 * Outputs:
 *   reports/tra309-sweep-4h-r9-meanrev-long-bbatr-asset-overlay-ema200.md
 *   reports/tra309-sweep-4h-r9-meanrev-long-bbatr-asset-overlay-ema200.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { atr, ema, rsi } from '@trading-app/engine';
import { loadOrFetch4hBars } from './fetch-tra266-data.js';
import {
  BTC_DOMINANCE_BASKET as BASKET,
  type DominanceSeries,
  loadSyntheticBtcDominanceDaily,
} from './btc-dominance-synthetic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

// ── Spec constants (task TRA-309) ─────────────────────────────────────────

const UNIVERSE = ['SOL-USD', 'DOGE-USD'] as const;

const INITIAL_EQUITY_USD = 25_000;
const FEE_BPS = 40;
const SLIPPAGE_BPS = 5;
const RISK_FRACTION = 0.01;

const ATR_K_STOP = 2.0;
const ATR_K_TRAIL = 2.0;
const RR_MIN = 2.0;
const TRAIL_ARM_R = 1.0;

// BB-reentry-long trigger — TRA-295 §3 spec, unchanged.
const BB_PERIOD = 20;
const BB_MULT = 2.0;
const BB_RSI_PERIOD = 14;
const BB_RSI_OVERSOLD = 30;

// ATR-pullback-long trigger — TRA-296 §4 TIGHT spec (re-installed per
// TRA-309 §1).
const ATR_PB_PERIOD = 14;
const ATR_PB_EMA_PERIOD = 50;
const ATR_PB_DEPTH = 2.5;        // TRA-296 tight (TRA-299 had 2.0×)
const ATR_PB_VOL_LOOKBACK = 20;
const ATR_PB_VOL_MULT = 1.5;     // TRA-296 tight (TRA-299 had 1.2×)
const ATR_PB_RSI_MAX = 40;       // TRA-296 tight (TRA-299 had no RSI filter)

// BTC.D regime gate — kept at SMA(50) per TRA-309 §2.
const BTC_D_SMA_PERIOD = 50;

// Asset-side EMA(200) + slope(EMA(50)) overlay — TRA-309 §3.
const ASSET_OVERLAY_EMA_LEVEL = 200;
const ASSET_OVERLAY_EMA_SLOPE = 50;

// Walk-forward — UNCHANGED from TRA-287/292/294/295/297/298/308.
const TRAIN_BARS = 180 * 6;      // 1080 × 4H ≈ 6 months  (≥ 200, EMA(200) warm-up safe)
const TEST_BARS = 90 * 6;        // 540  × 4H ≈ 3 months
const STEP_BARS = TEST_BARS;
const ROLLING_DD_BARS = 90 * 6;

// XRP-aligned start (calendar-identical with full chain).
const ALIGNED_START_TS = Date.UTC(2023, 6, 13, 20);
const FROM_MS = Date.UTC(2022, 0, 1);

// §8 binding bar — 25% per TRA-294 ratification.
const DD_BAR_PCT = 25;

// Skip-reason histogram keys.
const SKIP_NO_TRIGGER = 'no trigger emitted';
const SKIP_BTCD_WARMUP = '§2 btc.d sma(50) warm-up insufficient';
const SKIP_FUNDING_LONG_NOOP = '§5.1 funding gate (no-op for longs)';
const SKIP_ZERO_ATR = 'zero ATR — skipped';
const SKIP_ZERO_QTY = 'zero qty';
const SKIP_NEXT_BAR_MISSING = 'no next bar — entry impossible';
const SKIP_EQUITY_EXHAUSTED = 'equity exhausted';
// Per-trigger pre-gate fire counts (every fire, before any gate).
const FIRED_PRE_GATE_BB = 'fired_pre_gate: bb_reentry_long';
const FIRED_PRE_GATE_ATR = 'fired_pre_gate: atr_pullback_long';
// Per-trigger post-gate "tradeable" counts (BTC.D OR asset leg open).
const POST_GATE_BB = 'post_gate_tradeable: bb_reentry_long';
const POST_GATE_ATR = 'post_gate_tradeable: atr_pullback_long';
// Per-trigger blocked counts (neither leg open).
const BLOCKED_BB = 'blocked (neither leg fires): bb_reentry_long';
const BLOCKED_ATR = 'blocked (neither leg fires): atr_pullback_long';

// Per-leg attribution (per fired trigger, post-warm-up). One key per
// (leg, trigger) combination so we can compute btcd-only / asset-only / both
// from these aggregate counts.
const LEG_BTCD_ONLY_BB = 'leg: btcd-only (bb)';
const LEG_BTCD_ONLY_ATR = 'leg: btcd-only (atr)';
const LEG_ASSET_ONLY_BB = 'leg: asset-only (bb)';
const LEG_ASSET_ONLY_ATR = 'leg: asset-only (atr)';
const LEG_BOTH_BB = 'leg: both (bb)';
const LEG_BOTH_ATR = 'leg: both (atr)';

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
  /** Per-symbol per-leg counts for the test span (per TRA-309 §3 reporting). */
  perSymbolLeg: PerSymbolLegCounts[];
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
  passes: boolean;
  reasons: string[];
  passesDdBar: boolean;
}

interface LegBuckets {
  btcdOnlyBb: number;
  btcdOnlyAtr: number;
  assetOnlyBb: number;
  assetOnlyAtr: number;
  bothBb: number;
  bothAtr: number;
  blockedBb: number;
  blockedAtr: number;
}

interface PerSymbolLegCounts {
  symbol: string;
  legs: LegBuckets;
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
  ema200: number[];
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
  const ema200Series = new Array<number>(n).fill(NaN);
  const bbLowerSeries = new Array<number>(n).fill(NaN);
  const bbUpperSeries = new Array<number>(n).fill(NaN);
  const volMeanSeries = new Array<number>(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const closeWindow = closes.slice(0, i + 1);
    const candleWindow = bars.slice(0, i + 1);
    const rv = rsi(closeWindow, BB_RSI_PERIOD);
    const av = atr(candleWindow, ATR_PB_PERIOD);
    const e50 = ema(closeWindow, ASSET_OVERLAY_EMA_SLOPE);
    const e200 = ema(closeWindow, ASSET_OVERLAY_EMA_LEVEL);
    rsiSeries[i] = Number.isFinite(rv) ? rv : NaN;
    atrSeries[i] = av ?? NaN;
    ema50Series[i] = Number.isFinite(e50) ? e50 : NaN;
    ema200Series[i] = Number.isFinite(e200) ? e200 : NaN;

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
    ema200: ema200Series,
    bbLower: bbLowerSeries,
    bbUpper: bbUpperSeries,
    volMean20: volMeanSeries,
  };
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
 * ATR-pullback-long — TRA-296 §4 TIGHT spec (re-installed per TRA-309 §1).
 *
 * close[i-1] ≤ EMA50[i-1] − 2.5×ATR(14)[i-1] AND bullish reversal candle on
 * bar i (close>open AND close>close[i-1]) AND volume[i] > 1.5×mean(vol,20)
 * AND RSI(14)[i-1] < 40.
 */
function detectAtrPullbackLong(bars: Candle[], pc: PreCompute, i: number): LongSignal | null {
  if (i <= 0 || i + 1 >= bars.length) return null;

  const closePrev = bars[i - 1].close;
  const ema50Prev = pc.ema50[i - 1];
  const atrPrev = pc.atr14[i - 1];
  if (!Number.isFinite(ema50Prev) || !Number.isFinite(atrPrev) || atrPrev <= 0) return null;
  if (!(closePrev <= ema50Prev - ATR_PB_DEPTH * atrPrev)) return null;

  const rsiPrev = pc.rsi[i - 1];
  if (!Number.isFinite(rsiPrev)) return null;
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

/**
 * Asset-side overlay leg: close[i-1] > EMA(close, 200)[i-1] AND
 * EMA(close, 50)[i-1] > EMA(close, 50)[i-2]. Both sub-conditions are
 * required. Returns false when warm-up is insufficient (i < 2 or the
 * required EMA values are NaN).
 */
function assetOverlayLegOpen(bars: Candle[], pc: PreCompute, i: number): boolean {
  if (i < 2) return false;
  const closePrev = bars[i - 1].close;
  const ema200Prev = pc.ema200[i - 1];
  const ema50Prev = pc.ema50[i - 1];
  const ema50Prev2 = pc.ema50[i - 2];
  if (!Number.isFinite(closePrev)) return false;
  if (!Number.isFinite(ema200Prev) || !Number.isFinite(ema50Prev) || !Number.isFinite(ema50Prev2)) {
    return false;
  }
  if (!(closePrev > ema200Prev)) return false;
  if (!(ema50Prev > ema50Prev2)) return false;
  return true;
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

      // Gate-leg evaluation per bar (independent of trigger):
      //   - btcdLeg:  most-recent-completed daily synthetic BTC.D close < SMA(50)
      //   - assetLeg: close[i-1] > EMA(200)[i-1] AND EMA(50)[i-1] > EMA(50)[i-2]
      const dom = input.dominance.lookup(bars[idx].timestamp);
      const btcdLegReady = dom !== null && dom.sma !== null;
      const btcdLegOpen = btcdLegReady && dom!.dominance < (dom!.sma as number);

      const assetLegOpen = assetOverlayLegOpen(bars, pc, idx);

      const tradeable = btcdLegOpen || assetLegOpen;

      // Per-trigger leg-attribution + post-gate / blocked accounting.
      // Pre-warm-up (BTC.D series < 50d) is bucketed separately so we don't
      // conflate "no signal" with "warm-up failed".
      function attribute(sigPresent: boolean, isBb: boolean) {
        if (!sigPresent) return;
        if (!btcdLegReady) {
          bumpSkip(SKIP_BTCD_WARMUP);
          // Even if BTC.D warm-up missing, asset leg may still admit.
          if (assetLegOpen) {
            bumpSkip(isBb ? POST_GATE_BB : POST_GATE_ATR);
            bumpSkip(isBb ? LEG_ASSET_ONLY_BB : LEG_ASSET_ONLY_ATR);
          } else {
            bumpSkip(isBb ? BLOCKED_BB : BLOCKED_ATR);
          }
          return;
        }
        if (btcdLegOpen && assetLegOpen) {
          bumpSkip(isBb ? POST_GATE_BB : POST_GATE_ATR);
          bumpSkip(isBb ? LEG_BOTH_BB : LEG_BOTH_ATR);
        } else if (btcdLegOpen) {
          bumpSkip(isBb ? POST_GATE_BB : POST_GATE_ATR);
          bumpSkip(isBb ? LEG_BTCD_ONLY_BB : LEG_BTCD_ONLY_ATR);
        } else if (assetLegOpen) {
          bumpSkip(isBb ? POST_GATE_BB : POST_GATE_ATR);
          bumpSkip(isBb ? LEG_ASSET_ONLY_BB : LEG_ASSET_ONLY_ATR);
        } else {
          bumpSkip(isBb ? BLOCKED_BB : BLOCKED_ATR);
        }
      }
      attribute(!!bbSig, true);
      attribute(!!atrSig, false);

      // BB-reentry takes precedence when both fire.
      const sig = bbSig ?? atrSig;
      if (!sig) {
        bumpSkip(SKIP_NO_TRIGGER);
        continue;
      }
      if (!tradeable) continue;

      // §5.1 funding gate — direction-aware no-op for longs.
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
    perSymbolLeg: PerSymbolLegCounts[];
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

    const { aggregateSkipHistogram, perSymbolLeg } = recomputeTestWindowSkipHistogram(
      sliceMap,
      dominance,
      testStartTs,
      testEndTs,
    );

    const windowReport: WindowReport = {
      ...sim,
      closedLongs: testTrades,
      equityCurve: testEquity,
      skipReasons: aggregateSkipHistogram,
      trainStart: win.trainStart,
      trainEnd: win.trainEnd,
      testStart: win.testStart,
      testEnd: win.testEnd,
      index: i,
      perSymbolLeg,
    };

    out.windows.push(windowReport);
    out.equityCurve.push(...testEquity);

    const perSymbol = perSymbolMetrics(testTrades, symbols);
    const perTrigger = perTriggerMetrics(testTrades);
    const universe = universeMetrics(testTrades, testEquity, ROLLING_DD_BARS);
    out.perWindow.push({ index: i, metrics: universe, perSymbol, perTrigger, perSymbolLeg });
  }

  return out;
}

/**
 * Re-walk the test span only. Returns:
 *   - aggregateSkipHistogram: per-trigger pre-gate / post-gate / per-leg / blocked
 *     counts aggregated across all symbols (drives the histogram).
 *   - perSymbolLeg: per-symbol per-leg buckets (drives the per-window
 *     per-asset reporting required by TRA-309 §3).
 *
 * No-side-effect read pass; the authoritative simulation already happened
 * in runLongSim. We need histogram numbers scoped to the test window.
 */
function recomputeTestWindowSkipHistogram(
  candlesBySymbol: Map<string, Candle[]>,
  dominance: DominanceSeries,
  testStartTs: number,
  testEndTs: number,
): { aggregateSkipHistogram: Map<string, number>; perSymbolLeg: PerSymbolLegCounts[] } {
  const agg = new Map<string, number>();
  const bump = (k: string) => agg.set(k, (agg.get(k) ?? 0) + 1);
  const perSymbolLeg: PerSymbolLegCounts[] = [];

  for (const [sym, bars] of candlesBySymbol) {
    const pc = preCompute(bars);
    const legs: LegBuckets = {
      btcdOnlyBb: 0, btcdOnlyAtr: 0,
      assetOnlyBb: 0, assetOnlyAtr: 0,
      bothBb: 0, bothAtr: 0,
      blockedBb: 0, blockedAtr: 0,
    };

    for (let i = 0; i < bars.length; i++) {
      const ts = bars[i].timestamp;
      if (ts < testStartTs || ts > testEndTs) continue;

      const bbSig = detectBbReentryLong(bars, pc, i);
      const atrSig = detectAtrPullbackLong(bars, pc, i);
      if (bbSig) bump(FIRED_PRE_GATE_BB);
      if (atrSig) bump(FIRED_PRE_GATE_ATR);

      const dom = dominance.lookup(ts);
      const btcdLegReady = dom !== null && dom.sma !== null;
      const btcdLegOpen = btcdLegReady && dom!.dominance < (dom!.sma as number);

      const assetLegOpen = assetOverlayLegOpen(bars, pc, i);

      function attribute(sigPresent: boolean, isBb: boolean) {
        if (!sigPresent) return;
        if (!btcdLegReady) {
          bump(SKIP_BTCD_WARMUP);
          if (assetLegOpen) {
            bump(isBb ? POST_GATE_BB : POST_GATE_ATR);
            bump(isBb ? LEG_ASSET_ONLY_BB : LEG_ASSET_ONLY_ATR);
            if (isBb) legs.assetOnlyBb += 1; else legs.assetOnlyAtr += 1;
          } else {
            bump(isBb ? BLOCKED_BB : BLOCKED_ATR);
            if (isBb) legs.blockedBb += 1; else legs.blockedAtr += 1;
          }
          return;
        }
        if (btcdLegOpen && assetLegOpen) {
          bump(isBb ? POST_GATE_BB : POST_GATE_ATR);
          bump(isBb ? LEG_BOTH_BB : LEG_BOTH_ATR);
          if (isBb) legs.bothBb += 1; else legs.bothAtr += 1;
        } else if (btcdLegOpen) {
          bump(isBb ? POST_GATE_BB : POST_GATE_ATR);
          bump(isBb ? LEG_BTCD_ONLY_BB : LEG_BTCD_ONLY_ATR);
          if (isBb) legs.btcdOnlyBb += 1; else legs.btcdOnlyAtr += 1;
        } else if (assetLegOpen) {
          bump(isBb ? POST_GATE_BB : POST_GATE_ATR);
          bump(isBb ? LEG_ASSET_ONLY_BB : LEG_ASSET_ONLY_ATR);
          if (isBb) legs.assetOnlyBb += 1; else legs.assetOnlyAtr += 1;
        } else {
          bump(isBb ? BLOCKED_BB : BLOCKED_ATR);
          if (isBb) legs.blockedBb += 1; else legs.blockedAtr += 1;
        }
      }
      attribute(!!bbSig, true);
      attribute(!!atrSig, false);
    }
    perSymbolLeg.push({ symbol: sym, legs });
  }

  return { aggregateSkipHistogram: agg, perSymbolLeg };
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
  tra296Sidecar: Tra296Sidecar | null,
): string {
  const lines: string[] = [];
  lines.push('# TRA-309 — §8 Walk-Forward Sweep Report (4H Phase-1.2.4 BB+tight-ATR + asset-side EMA(200)+slope(EMA(50)) OR overlay supplementing SMA(50) BTC.D gate — r9 SOL+DOGE)\n');
  lines.push(`Generated: ${new Date().toISOString()}\n`);
  lines.push('Granularity: 4h');
  lines.push(`Universe: ${symbols.join(', ')} (r9 binding)`);
  const sample = fullByPair.get(symbols[0])!;
  lines.push(`Date span: ${fmtDate(sample[0].timestamp)} → ${fmtDate(sample[sample.length - 1].timestamp)}`);
  lines.push(`Initial equity: $${INITIAL_EQUITY_USD.toLocaleString()}, fees ${FEE_BPS} bps taker, slippage ${SLIPPAGE_BPS} bps`);
  lines.push(`Walk-forward: train=${TRAIN_BARS}×4H, test=${TEST_BARS}×4H, step=${STEP_BARS}×4H, windows=${wf.windows.length}`);
  lines.push('');

  lines.push('## Triggers (TRA-309 deltas vs TRA-299/TRA-308)\n');
  lines.push('- **BB-reentry-long (UNCHANGED, TRA-295 spec):** close[i-1] ≤ lower BB(20, 2σ), close[i] > lower BB(20, 2σ), AND RSI(14)[i] > RSI(14)[i-1] with RSI(14)[i-1] < 30. Entry on open of bar i+1.');
  lines.push('- **ATR-pullback-long (RE-TIGHTENED to TRA-296 spec, was loose in TRA-299):** close[i-1] ≤ EMA(50)[i-1] − **2.5×ATR(14)[i-1]** *(TRA-299 had 2.0×)*, bullish reversal candle on bar i (close>open AND close>close[i-1]) with volume[i] > **1.5×mean(volume[i-20..i-1])** *(TRA-299 had 1.2×)*, AND **RSI(14)[i-1] < 40** *(TRA-299 had no RSI filter)*. Entry on open of bar i+1.');
  lines.push('');

  lines.push('## Gate (BTC.D leg + asset-side EMA(200)+slope(EMA(50)) leg, OR-combined)\n');
  lines.push('Each candidate trigger fire on bar `i` (4H) is admitted if EITHER:');
  lines.push('- **(BTC.D leg, existing)** most-recent-completed daily synthetic BTC.D close < SMA(synthetic BTC.D, 50), OR');
  lines.push('- **(asset overlay leg, NEW — replaces TRA-299 plain-EMA(50))** `close[i-1] > EMA(close, 200)[i-1]` **AND** `EMA(close, 50)[i-1] > EMA(close, 50)[i-2]` on the entered asset itself (4H bars). Both sub-conditions are required (internal AND); the asset leg as a whole is OR\'d with the BTC.D leg.');
  lines.push('');
  lines.push('Rationale (per TRA-309 §3): TRA-308 found the plain-EMA(50) overlay structurally inert across all 9 windows. ATR-pullback is mathematically excluded (its trigger requires `close < EMA(50) − 2×ATR`, implying `close < EMA(50)`); BB-reentry is empirically excluded — on SOL+DOGE 4H, lower-band-touch coincides 100% with `close < EMA(50)`. EMA(200) on 4H is ~33-day trend baseline — far enough from BB(20)\'s ~3-day centering that the geometric coincidence problem from TRA-308 should not recur. The slope(EMA(50)) condition adds independent momentum information that does not share the trigger\'s anchor. The OR (not AND) at the gate level is deliberate — we *add* firing opportunity, not further restrict.');
  lines.push('');
  lines.push('Source — synthetic 5-coin basket loader (`./btc-dominance-synthetic.ts`), shared with TRA-296/297/298/299. BTC mcap divided by Σ(BTC + ETH + SOL + DOGE + XRP) mcaps using mid-period 2024 circulating-supply constants from existing daily Coinbase caches. Reproducible offline, no API key required.');
  lines.push('');

  const points = dominance.points;
  lines.push(`BTC.D synthetic series: ${points.length} daily points spanning ${fmtDate(points[0].ts)} → ${fmtDate(points[points.length - 1].ts)}; SMA(50) warm-up extended back from 2022-01-01 (≥ 558d before aligned start, comfortably > 50d).`);
  lines.push('');

  lines.push(`Asset-side EMA(200) warm-up: each window\'s slice covers train(${TRAIN_BARS}×4H) + test(${TEST_BARS}×4H) = ${TRAIN_BARS + TEST_BARS} bars per asset. The 1080-bar train alone is ≥ 200, so EMA(200) is fully warm at every window\'s \`testStart\`. EMA(50) slope (which needs 2 prior values) is warm at \`testStart\` for the same reason. Confirmed.`);
  lines.push('');

  lines.push('Risk knobs (binding, UNCHANGED): 1% account risk per trade, ATR-2.0 stop below entry, 1:2 R:R minimum target, ATR-trail engages at +1R favorable (trail = high-water close − 2.0×ATR(14)).');
  lines.push('');
  lines.push('§5.1 funding gate stays wired direction-aware (no-op for longs).');
  lines.push('');

  lines.push(`§8 acceptance bar (UNCHANGED — all four bars binding):`);
  lines.push('- Density ≥ 4 trades / window (post-gate)');
  lines.push('- Hit rate ≥ 35%');
  lines.push('- Expectancy ≥ +0.10R');
  lines.push(`- Rolling-90d DD ≤ ${DD_BAR_PCT}% (binding per §8.1 amendment ratified in TRA-294 — see reports/SPEC.md)`);
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
    const pass = m.passes ? 'PASS' : 'FAIL';
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

  // Per-trigger pre-gate / post-gate / blocked histogram.
  lines.push('## Per-trigger pre-gate-fire / post-gate-tradeable / blocked (per window, test span)\n');
  lines.push('| Window | BB pre-gate | BB post-gate | BB blocked | ATR pre-gate | ATR post-gate | ATR blocked | BTC.D warm-up missing |');
  lines.push('| ------ | ----------- | ------------ | ---------- | ------------ | ------------- | ----------- | --------------------- |');
  for (const w of wf.windows) {
    const r = w.skipReasons;
    const bbPre = r.get(FIRED_PRE_GATE_BB) ?? 0;
    const bbPost = r.get(POST_GATE_BB) ?? 0;
    const bbBlock = r.get(BLOCKED_BB) ?? 0;
    const atrPre = r.get(FIRED_PRE_GATE_ATR) ?? 0;
    const atrPost = r.get(POST_GATE_ATR) ?? 0;
    const atrBlock = r.get(BLOCKED_ATR) ?? 0;
    const warmup = r.get(SKIP_BTCD_WARMUP) ?? 0;
    lines.push(`| ${w.index} | ${bbPre} | ${bbPost} | ${bbBlock} | ${atrPre} | ${atrPost} | ${atrBlock} | ${warmup} |`);
  }
  lines.push('');
  lines.push('Notes: per-trigger pre-gate counts every signal fire (BB and ATR are independent). Post-gate-tradeable = `(BTC.D leg open) OR (asset overlay leg open)` AND BTC.D warm-up satisfied (or asset leg alone admits if warm-up missing). Blocked = BTC.D warm-up satisfied AND neither leg open.');
  lines.push('');

  // Per-window per-asset gate-leg attribution histogram.
  lines.push('## Per-window per-asset gate-leg attribution (TRA-309 §3 reporting)\n');
  lines.push('Per-trigger fire counts bucketed by which leg(s) of the OR-gate were open on the trigger bar. Counts are independent per trigger (BB and ATR can both fire on the same bar). Pre-gate = BTCD-only + Asset-only + Both + Blocked + warm-up missing.');
  lines.push('');
  lines.push('| Window | Asset | BB pre-gate | BB BTCD-only | BB Asset-only | BB Both | BB Blocked | ATR pre-gate | ATR BTCD-only | ATR Asset-only | ATR Both | ATR Blocked |');
  lines.push('| ------ | ----- | ----------- | ------------ | ------------- | ------- | ---------- | ------------ | ------------- | -------------- | -------- | ----------- |');
  for (const w of wf.windows) {
    for (const psl of w.perSymbolLeg) {
      const l = psl.legs;
      const bbPre = l.btcdOnlyBb + l.assetOnlyBb + l.bothBb + l.blockedBb;
      const atrPre = l.btcdOnlyAtr + l.assetOnlyAtr + l.bothAtr + l.blockedAtr;
      lines.push(`| ${w.index} | ${psl.symbol} | ${bbPre} | ${l.btcdOnlyBb} | ${l.assetOnlyBb} | ${l.bothBb} | ${l.blockedBb} | ${atrPre} | ${l.btcdOnlyAtr} | ${l.assetOnlyAtr} | ${l.bothAtr} | ${l.blockedAtr} |`);
    }
  }
  lines.push('');
  lines.push('Reading guide:');
  lines.push('- **Asset-only** counts are the new opportunity the asset-overlay opens (signals BTC.D-only would have blocked).');
  lines.push('- A window where BB Asset-only > 0 (or ATR Asset-only > 0) tells us the EMA(200)+slope leg is no longer structurally inert as it was in TRA-308.');
  lines.push('- A window where Asset-only ≈ 0 but Both > 0 means the leg was active but fully redundant with the BTC.D leg in that window — coverage was not opened.');
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

  // Side-by-side TRA-296 vs TRA-309.
  lines.push('## Side-by-side TRA-296 vs TRA-309 (per window)\n');
  lines.push('| Window | TRA-296 trades | TRA-309 trades | Δ trades | TRA-296 hit% | TRA-309 hit% | TRA-296 R | TRA-309 R | TRA-296 DD90% | TRA-309 DD90% | TRA-296 pass? | TRA-309 pass? |');
  lines.push('| ------ | -------------- | -------------- | -------- | ------------ | ------------ | --------- | --------- | ------------- | ------------- | ------------- | ------------- |');
  for (const w of wf.perWindow) {
    const m = w.metrics;
    const prior = tra296Sidecar?.perWindow.find((p) => p.index === w.index);
    const priorTrades = prior?.trades ?? null;
    const priorHit = prior?.hitRatePct ?? null;
    const priorExp = prior?.expectancyR ?? null;
    const priorDd = prior?.rollingMaxDrawdownPct ?? null;
    const priorPass = prior?.passes ?? null;
    const dT = priorTrades !== null ? `${m.trades - priorTrades >= 0 ? '+' : ''}${m.trades - priorTrades}` : '—';
    const tradesPrior = priorTrades !== null ? String(priorTrades) : '—';
    const hitPrior = priorHit !== null ? priorHit.toFixed(1) : '—';
    const expPrior = priorExp !== null ? priorExp.toFixed(3) : '—';
    const ddPrior = priorDd !== null ? priorDd.toFixed(2) : '—';
    const passPrior = priorPass === null ? '—' : (priorPass ? 'PASS' : 'FAIL');
    lines.push(`| ${w.index} | ${tradesPrior} | ${m.trades} | ${dT} | ${hitPrior} | ${m.hitRatePct.toFixed(1)} | ${expPrior} | ${m.expectancyR.toFixed(3)} | ${ddPrior} | ${m.rollingMaxDrawdownPct.toFixed(2)} | ${passPrior} | ${m.passes ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');

  // Decision.
  lines.push('## Decision\n');
  if (passingCount >= 5) {
    lines.push(`**SHIP SIGNAL** — ${passingCount} / 9 windows clear all four binding §8 bars (≥ 5 / 9 required), with the 25% rolling-90d DD bar binding. Asset-side EMA(200)+slope(EMA(50)) overlay supplementing SMA(50) BTC.D gate clears the bar.`);
  } else {
    lines.push(`**FAIL** — Only ${passingCount} / 9 windows clear all four binding §8 bars (≥ 5 / 9 required). Per task spec, do **not** silently tune. Reassign back to QuantTrader with the per-leg fire counts (above), per-window working-set comparison vs TRA-296, and W3 status. Possible follow-ups (QuantTrader call per TRA-309 'Final gate-side iteration'):`);
    lines.push('- **≥ 4 / 9 with new asset-leg active and decoupled:** QuantTrader judgement on whether to tune ATR-pullback params (§1 carve-out only) or accept partial-coverage.');
    lines.push('- **≤ 3 / 9 OR new asset-leg structurally inert again:** accept partial-coverage acceptance (handle (3) per TRA-308 recommendation §3). TRA-296 (3/9: W0/W5/W6) remains the validated SOL+DOGE 4H mean-rev-long strategy. Pivot to complementary BTC-favorable / dead-zone strategy work for W2/W4/W7/W8 (separate child of TRA-291).');
  }
  return lines.join('\n');
}

interface Tra296Sidecar {
  perWindow: Array<{
    index: number;
    trades: number;
    hitRatePct: number;
    expectancyR: number;
    rollingMaxDrawdownPct: number;
    passes: boolean;
  }>;
}

function maybeLoadTra296Sidecar(): Tra296Sidecar | null {
  const path = resolve(REPORT_DIR, 'tra296-sweep-4h-r9-meanrev-long-regime.json');
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

  console.log(`[run-tra309] Loading 4H bars ${fmtDate(fromMs)} → ${fmtDate(toMs)} for r9 universe ${UNIVERSE.join(', ')}`);
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
  console.log(`[run-tra309] Aligned to ${new Date(ALIGNED_START_TS).toISOString()}: ${aligned}`);

  console.log('[run-tra309] Loading synthetic BTC.D daily series (5-coin basket, shared loader)…');
  const dominance = await loadSyntheticBtcDominanceDaily(fromMs, toMs, BTC_D_SMA_PERIOD);
  const minDom = dominance.points[0];
  const maxDom = dominance.points[dominance.points.length - 1];
  console.log(`[run-tra309] BTC.D series: ${dominance.points.length} points, ${fmtDate(minDom.ts)} → ${fmtDate(maxDom.ts)}`);
  const lookupAtAligned = dominance.lookup(ALIGNED_START_TS);
  console.log(`[run-tra309] BTC.D snapshot @ aligned start ${fmtDate(ALIGNED_START_TS)}: dominance=${lookupAtAligned?.dominance.toFixed(3) ?? 'n/a'}, sma=${lookupAtAligned?.sma?.toFixed(3) ?? 'n/a'}`);

  console.log('[run-tra309] Running BB+tight-ATR + asset-side EMA(200)+slope(EMA(50)) overlay walk-forward…');
  const wf = runWalkForward(fullByPair, dominance);
  console.log(`[run-tra309] ${wf.windows.length} windows produced.`);

  const symbols = [...UNIVERSE];
  const tra296Prior = maybeLoadTra296Sidecar();
  const report = buildReport(wf, symbols, fullByPair, dominance, tra296Prior);
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, 'tra309-sweep-4h-r9-meanrev-long-bbatr-asset-overlay-ema200.md');
  writeFileSync(reportPath, report);
  console.log(`\n[run-tra309] Report written: ${reportPath}`);

  const passingCount = wf.perWindow.filter((w) => w.metrics.passes).length;
  const passAll = passingCount >= 5;

  const totalSkips = (() => {
    const t = new Map<string, number>();
    for (const w of wf.windows) {
      for (const [k, v] of w.skipReasons) t.set(k, (t.get(k) ?? 0) + v);
    }
    return Object.fromEntries(t);
  })();

  const sidecarPath = resolve(REPORT_DIR, 'tra309-sweep-4h-r9-meanrev-long-bbatr-asset-overlay-ema200.json');
  writeFileSync(sidecarPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    granularity: '4h',
    direction: 'long',
    triggerFamily: 'mean-reversion (BTC.D OR asset-EMA200+slope(EMA50) gate)',
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
    assetOverlayEmaLevel: ASSET_OVERLAY_EMA_LEVEL,
    assetOverlayEmaSlope: ASSET_OVERLAY_EMA_SLOPE,
    gateCombination: 'OR (BTC.D leg OR asset-side EMA(200)+slope(EMA(50)) leg)',
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
        blockedBb: r.get(BLOCKED_BB) ?? 0,
        preGateAtr: r.get(FIRED_PRE_GATE_ATR) ?? 0,
        postGateAtr: r.get(POST_GATE_ATR) ?? 0,
        blockedAtr: r.get(BLOCKED_ATR) ?? 0,
        btcdWarmupMissing: r.get(SKIP_BTCD_WARMUP) ?? 0,
        legCounts: {
          btcdOnlyBb: r.get(LEG_BTCD_ONLY_BB) ?? 0,
          btcdOnlyAtr: r.get(LEG_BTCD_ONLY_ATR) ?? 0,
          assetOnlyBb: r.get(LEG_ASSET_ONLY_BB) ?? 0,
          assetOnlyAtr: r.get(LEG_ASSET_ONLY_ATR) ?? 0,
          bothBb: r.get(LEG_BOTH_BB) ?? 0,
          bothAtr: r.get(LEG_BOTH_ATR) ?? 0,
        },
        perSymbolLeg: w.perSymbolLeg,
      };
    }),
    skipReasonsAggregate: totalSkips,
    decision: passAll ? 'PASS' : 'FAIL',
    passingWindowsBinding: passingCount,
    requiredPassing: 5,
  }, null, 2));
  console.log(`[run-tra309] JSON sidecar: ${sidecarPath}`);

  console.log(`\n=== TRA-309 §8 Acceptance (4H r9 BB+tight-ATR + asset-side EMA(200)+slope(EMA(50)) overlay, SOL+DOGE) ===`);
  console.log(`Windows passing all four binding bars: ${passingCount} / ${wf.perWindow.length}`);
  console.log(`Decision: ${passAll ? 'PASS — ship signal' : 'FAIL — TRA-309 → QuantTrader'}`);
}

const invoked = process.argv[1] && /[\\/]run-tra309-meanrev-long-bbatr-asset-overlay-ema200\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
