/**
 * TRA-1933 — ICC (Indication / Correction / Continuation) net-of-fee backtest.
 *
 * Owner: LeadDev. Delegated from TRA-1932 (QuantTrader's codified ICC spec).
 * This is a self-contained RESEARCH harness (same status as run-tra523-fee-aware.ts):
 * it reads the on-disk 4H Coinbase caches under `packages/backtest/data/` and
 * simulates ICC trades with explicit per-side fee + slippage accounting, then
 * grades the result against QuantTrader's PRE-REGISTERED adopt/kill gate.
 *
 * ── The spec (verbatim from TRA-1932) ──────────────────────────────────────
 *   HTF (bias) = 4H, LTF (entry) = 15m, crypto 24/7.
 *   Swing pivot: fractal k=2 (sensitivity k∈{2,3}).
 *   Indication = Break of Structure: HTF close beyond most recent confirmed swing.
 *   Impulse leg L0→H1: swing low preceding BOS → post-BOS extreme within N=12 HTF bars.
 *   Correction: retrace from H1, valid when close lands in the [0.382,0.786] Fib zone.
 *     Invalidation: any HTF close beyond L0 (long)/H0 (short) → discard (no flip).
 *   Continuation: micro-BOS on LTF (first LTF close beyond the correction swing).
 *   Stop: correction extreme ∓ 0.1×ATR(14,LTF). Target: H1.
 *   R:R filter (Playbook B): take only if (target-entry)/(entry-stop) ≥ 1.5.
 *   Regime filter: longs only when HTF EMA(50) slope ≥ 0; shorts when ≤ 0. On AND off.
 *   Cost model: crypto taker 60bps round-trip (the number that killed TSMOM) AND
 *     a maker-only variant; slippage 3bps/side.
 *
 * ── Data reality (why the timeframes shift up) ─────────────────────────────
 *   We do NOT have 15m crypto candles on disk — only 4H (2023-05..2025-06, many
 *   symbols) and daily. So the LITERAL 4H/15m run cannot be executed here.
 *   Faithful proxy: realise the *top-down two-timeframe* structure one notch up —
 *   HTF = daily (resampled from 4H, `HTF_MULT=6`), LTF entry = 4H.  A single-TF
 *   structural variant (HTF=LTF=4H, `HTF_MULT=1`) is run for sensitivity.
 *
 *   This SHIFT IS CONSERVATIVE FOR THE STRATEGY: coarser entry timeframes fire
 *   FEWER, LARGER-R trades, so they carry LESS fee drag per unit of edge than the
 *   spec's 15m entry would. Therefore:
 *     • a net-of-taker KILL here is ROBUST — 15m would only be worse (more churn,
 *       more fee), so the verdict holds a fortiori.
 *     • a net-of-taker PASS here would be NECESSARY-BUT-NOT-SUFFICIENT — it would
 *       have to be re-confirmed on real 15m data before adoption, because the
 *       higher entry timeframe understates the fee load of the real spec.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra1933-icc-fee-backtest.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const REPORT_DIR = resolve(HERE, '..', 'reports');

const FOUR_H_MS = 4 * 60 * 60 * 1000;

// Liquid, high-cap universe with 4H caches. Restricting to top liquidity keeps
// the fill assumptions honest (thin alts would not fill at the micro-BOS level).
const UNIVERSE = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'DOGE-USD', 'LINK-USD', 'AVAX-USD',
  'LTC-USD', 'BCH-USD', 'DOT-USD', 'ETC-USD', 'ATOM-USD', 'NEAR-USD', 'ARB-USD',
  'OP-USD', 'XRP-USD', 'UNI-USD', 'XLM-USD',
];

// ── ICC parameters ─────────────────────────────────────────────────────────
const FIB_LO = 0.382;
const FIB_HI = 0.786;
const IMPULSE_N_HTF = 12; // HTF bars to establish the post-BOS extreme
const ATR_PERIOD = 14;
const ATR_STOP_BUF = 0.1;
const RR_MIN = 1.5;
const ENTRY_WINDOW_LTF = 60; // LTF bars after arm to find a continuation entry
const TRADE_TIMEOUT_LTF = 90; // LTF bars in-trade before time-stop

// ── Cost arms (entry/exit fee + slippage bps, per side) ────────────────────
// Mirrors TRA-523's bracket so the answer is comparable to the crypto fee study.
interface CostArm {
  key: string;
  label: string;
  entryFeeBps: number;
  entrySlipBps: number;
  exitFeeBps: number;
  exitSlipBps: number;
}
const COST_ARMS: CostArm[] = [
  { key: 'gross_0', label: 'zero-fee reference (raw signal edge)', entryFeeBps: 0, entrySlipBps: 0, exitFeeBps: 0, exitSlipBps: 0 },
  { key: 'maker_both_10', label: 'optimistic: every leg maker 10bps', entryFeeBps: 10, entrySlipBps: 0, exitFeeBps: 10, exitSlipBps: 0 },
  { key: 'maker_entry', label: 'realistic: maker entry 25bps / taker exit 60bps', entryFeeBps: 25, entrySlipBps: 0, exitFeeBps: 60, exitSlipBps: 3 },
  { key: 'taker_60', label: 'status quo: taker 60bps both legs', entryFeeBps: 60, entrySlipBps: 3, exitFeeBps: 60, exitSlipBps: 3 },
  { key: 'taker_80', label: 'conservative: taker 80bps both legs', entryFeeBps: 80, entrySlipBps: 3, exitFeeBps: 80, exitSlipBps: 3 },
];
const GATE_ARM = 'taker_60'; // the pre-registered gate is graded net-of-taker

// ── small indicator helpers (self-contained; no engine import) ─────────────
function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function smaSeries(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
/** Wilder ATR series aligned to `bars` (NaN until enough history). */
function atrSeries(bars: Candle[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  if (bars.length < period + 1) return out;
  let prevClose = bars[0].close;
  const trs: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low;
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
    prevClose = bars[i].close;
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trs[i];
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < bars.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

// ── data loading ───────────────────────────────────────────────────────────
interface CacheEntry { symbol: string; candles: Candle[] }
function load4h(symbol: string): Candle[] | null {
  const p = resolve(DATA_DIR, `${symbol.toLowerCase()}.4h.json`);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf-8')) as CacheEntry;
  return (raw.candles ?? []).filter((c) => !c.synthetic).sort((a, b) => a.timestamp - b.timestamp);
}

/** BTC daily 200-SMA regime tape: trend_up when BTC>SMA200 else chop_down. */
function buildBtcRegime(): { ts: number[]; regime: string[] } {
  const p = resolve(DATA_DIR, 'btc-usd.json');
  const raw = JSON.parse(readFileSync(p, 'utf-8')) as CacheEntry;
  const bars = raw.candles.sort((a, b) => a.timestamp - b.timestamp);
  const sma = smaSeries(bars.map((b) => b.close), 200);
  return {
    ts: bars.map((b) => b.timestamp),
    regime: bars.map((b, i) => (isNaN(sma[i]) ? 'warmup' : b.close > sma[i] ? 'trend_up' : 'chop_down')),
  };
}
function regimeAt(tape: { ts: number[]; regime: string[] }, ms: number): string {
  // last daily bar at or before ms
  let lo = 0, hi = tape.ts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tape.ts[mid] <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return tape.regime[ans] ?? 'warmup';
}

/** Resample base 4H bars into HTF buckets of `mult` base bars, aligned to UTC. */
function resample(bars: Candle[], mult: number): Candle[] {
  if (mult <= 1) return bars;
  const bucketMs = mult * FOUR_H_MS;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curBucket = -1;
  for (const b of bars) {
    const bucket = Math.floor(b.timestamp / bucketMs);
    if (bucket !== curBucket) {
      if (cur) out.push(cur);
      curBucket = bucket;
      cur = { ...b, timestamp: bucket * bucketMs };
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ── swing pivots (fractal k) ───────────────────────────────────────────────
interface Pivot { idx: number; price: number; kind: 'high' | 'low' }
/** Confirmed fractal pivots. A pivot at i is confirmed only after k bars right. */
function fractalPivots(bars: Candle[], k: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= k; j++) {
      if (!(bars[i].high > bars[i - j].high && bars[i].high > bars[i + j].high)) isHigh = false;
      if (!(bars[i].low < bars[i - j].low && bars[i].low < bars[i + j].low)) isLow = false;
    }
    if (isHigh) out.push({ idx: i, price: bars[i].high, kind: 'high' });
    if (isLow) out.push({ idx: i, price: bars[i].low, kind: 'low' });
  }
  return out;
}

// ── the ICC state machine ──────────────────────────────────────────────────
type Side = 'long' | 'short';
interface Trade { side: Side; entryTs: number; rGross: number; entryPx: number; exitPx: number; risk: number; rr: number }

interface RunParams { htfMult: number; swingK: number; regimeFilter: boolean; rrFilter: boolean }

interface Setup {
  side: Side;
  L0: number; // long: swing low preceding BOS ; short: swing high preceding BOS
  H1: number; // long: post-BOS high extreme ; short: post-BOS low extreme
  armTs: number; // when the impulse window closes → correction hunting begins
  emaSlopeUp: boolean; // HTF EMA(50) slope ≥ 0 at arm
}

/** Build armed ICC setups from the HTF series (no LTF lookahead: armTs gates it). */
function buildSetups(htf: Candle[], k: number): Setup[] {
  const setups: Setup[] = [];
  const pivots = fractalPivots(htf, k);
  const emaC = emaSeries(htf.map((b) => b.close), 50);
  // index → most recent confirmed swing high/low as of that bar
  let pi = 0;
  const confirmedHighs: Pivot[] = [];
  const confirmedLows: Pivot[] = [];
  let consumedHighIdx = -1; // last swing-high idx already broken
  let consumedLowIdx = -1;
  for (let j = 0; j < htf.length; j++) {
    // ingest pivots confirmed by bar j (pivot.idx + k <= j)
    while (pi < pivots.length && pivots[pi].idx + k <= j) {
      const p = pivots[pi];
      (p.kind === 'high' ? confirmedHighs : confirmedLows).push(p);
      pi++;
    }
    const close = htf[j].close;
    const lastHigh = confirmedHighs[confirmedHighs.length - 1];
    const lastLow = confirmedLows[confirmedLows.length - 1];

    // Bullish BOS: close breaks an unconsumed confirmed swing high.
    if (lastHigh && lastHigh.idx !== consumedHighIdx && close > lastHigh.price) {
      consumedHighIdx = lastHigh.idx;
      // L0 = swing low preceding the BOS (most recent confirmed low before j)
      const l0 = [...confirmedLows].reverse().find((p) => p.idx < j);
      if (l0) {
        const end = Math.min(j + IMPULSE_N_HTF, htf.length - 1);
        let h1 = -Infinity;
        for (let m = j; m <= end; m++) h1 = Math.max(h1, htf[m].high);
        if (h1 > l0.price) {
          setups.push({
            side: 'long', L0: l0.price, H1: h1, armTs: htf[end].timestamp,
            emaSlopeUp: emaC[end] >= emaC[Math.max(0, end - 1)],
          });
        }
      }
    }
    // Bearish BOS
    if (lastLow && lastLow.idx !== consumedLowIdx && close < lastLow.price) {
      consumedLowIdx = lastLow.idx;
      const h0 = [...confirmedHighs].reverse().find((p) => p.idx < j);
      if (h0) {
        const end = Math.min(j + IMPULSE_N_HTF, htf.length - 1);
        let l1 = Infinity;
        for (let m = j; m <= end; m++) l1 = Math.min(l1, htf[m].low);
        if (l1 < h0.price) {
          setups.push({
            side: 'short', L0: h0.price, H1: l1, armTs: htf[end].timestamp,
            emaSlopeUp: emaC[end] >= emaC[Math.max(0, end - 1)],
          });
        }
      }
    }
  }
  return setups;
}

/** Trade one armed setup on the LTF (base) bars. Returns a Trade or null. */
function tradeSetup(base: Candle[], atr: number[], ltfK: number, s: Setup, p: RunParams): Trade | null {
  if (p.regimeFilter) {
    if (s.side === 'long' && !s.emaSlopeUp) return null;
    if (s.side === 'short' && s.emaSlopeUp) return null;
  }
  const startIdx = base.findIndex((b) => b.timestamp >= s.armTs);
  if (startIdx < 0) return null;
  const range = s.side === 'long' ? s.H1 - s.L0 : s.L0 - s.H1;
  if (range <= 0) return null;
  // Fib zone in price terms (retrace back from the extreme H1 toward L0)
  const zoneShallow = s.side === 'long' ? s.H1 - FIB_LO * range : s.H1 + FIB_LO * range;
  const zoneDeep = s.side === 'long' ? s.H1 - FIB_HI * range : s.H1 + FIB_HI * range;
  const zoneHi = Math.max(zoneShallow, zoneDeep);
  const zoneLo = Math.min(zoneShallow, zoneDeep);

  let corrActive = false;
  let corrExtreme = s.side === 'long' ? Infinity : -Infinity; // lowest low / highest high in correction
  // rolling fractal detection of the LTF micro-swing that continuation must break
  const microK = ltfK;
  let microSwing: number | null = null; // long: swing high to break up ; short: swing low to break down

  const end = Math.min(startIdx + ENTRY_WINDOW_LTF, base.length - 1);
  for (let i = startIdx; i <= end; i++) {
    const c = base[i];
    // Invalidation: base close beyond L0 kills the setup (no flip).
    if (s.side === 'long' && c.close < s.L0) return null;
    if (s.side === 'short' && c.close > s.L0) return null;

    // Correction detection: a close inside the Fib zone arms the correction.
    if (!corrActive && c.close >= zoneLo && c.close <= zoneHi) corrActive = true;
    if (!corrActive) continue;

    // Track correction extreme.
    if (s.side === 'long') corrExtreme = Math.min(corrExtreme, c.low);
    else corrExtreme = Math.max(corrExtreme, c.high);

    // Update the most recent confirmed LTF micro-swing (fractal microK) up to i.
    if (i - microK >= startIdx && i - microK - microK >= 0) {
      const p0 = i - microK;
      let isHigh = true, isLow = true;
      for (let j = 1; j <= microK; j++) {
        if (!(base[p0].high > base[p0 - j].high && base[p0].high > base[p0 + j].high)) isHigh = false;
        if (!(base[p0].low < base[p0 - j].low && base[p0].low < base[p0 + j].low)) isLow = false;
      }
      if (s.side === 'long' && isHigh) microSwing = base[p0].high;
      if (s.side === 'short' && isLow) microSwing = base[p0].low;
    }

    // Continuation: first LTF close beyond the micro-swing in trend direction.
    if (microSwing != null) {
      const trigger = s.side === 'long' ? c.close > microSwing : c.close < microSwing;
      if (trigger) {
        const a = atr[i];
        if (isNaN(a) || a <= 0) return null;
        const entry = c.close;
        const stop = s.side === 'long' ? corrExtreme - ATR_STOP_BUF * a : corrExtreme + ATR_STOP_BUF * a;
        const risk = s.side === 'long' ? entry - stop : stop - entry;
        if (risk <= 0) return null;
        const target = s.H1;
        const rr = s.side === 'long' ? (target - entry) / risk : (entry - target) / risk;
        if (rr <= 0) return null;
        if (p.rrFilter && rr < RR_MIN) return null;
        // ── simulate the trade forward ──
        const tEnd = Math.min(i + TRADE_TIMEOUT_LTF, base.length - 1);
        for (let m = i + 1; m <= tEnd; m++) {
          const bar = base[m];
          if (s.side === 'long') {
            const hitStop = bar.low <= stop, hitTgt = bar.high >= target;
            if (hitStop && hitTgt) return mkTrade(s.side, c.timestamp, entry, stop, risk, rr); // stop-first (conservative)
            if (hitStop) return mkTrade(s.side, c.timestamp, entry, stop, risk, rr);
            if (hitTgt) return mkTrade(s.side, c.timestamp, entry, target, risk, rr);
          } else {
            const hitStop = bar.high >= stop, hitTgt = bar.low <= target;
            if (hitStop && hitTgt) return mkTrade(s.side, c.timestamp, entry, stop, risk, rr);
            if (hitStop) return mkTrade(s.side, c.timestamp, entry, stop, risk, rr);
            if (hitTgt) return mkTrade(s.side, c.timestamp, entry, target, risk, rr);
          }
        }
        // time stop at last bar's close
        return mkTrade(s.side, c.timestamp, entry, base[tEnd].close, risk, rr);
      }
    }
  }
  return null;
}

function mkTrade(side: Side, entryTs: number, entry: number, exit: number, risk: number, rr: number): Trade {
  const rGross = side === 'long' ? (exit - entry) / risk : (entry - exit) / risk;
  return { side, entryTs, entryPx: entry, exitPx: exit, risk, rr, rGross };
}

/** Apply a cost arm to a gross trade → net R (fees expressed in R via the risk unit). */
function netR(t: Trade, arm: CostArm): number {
  const fEntry = (arm.entryFeeBps + arm.entrySlipBps) / 10000;
  const fExit = (arm.exitFeeBps + arm.exitSlipBps) / 10000;
  const feePrice = t.entryPx * fEntry + t.exitPx * fExit; // round-trip fee in price units
  const feeR = feePrice / t.risk;
  return t.rGross - feeR;
}

// ── metrics ────────────────────────────────────────────────────────────────
interface Stats {
  n: number; winRate: number; expectancyR: number; avgWinR: number; avgLossR: number;
  sharpe: number; sortino: number; maxDDR: number; realizedRR: number;
  byRegime: Record<string, { n: number; expectancyR: number }>;
}
function summarize(rs: number[], regimes: string[]): Stats {
  const n = rs.length;
  if (n === 0) return { n: 0, winRate: 0, expectancyR: 0, avgWinR: 0, avgLossR: 0, sharpe: 0, sortino: 0, maxDDR: 0, realizedRR: 0, byRegime: {} };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1e-9;
  const downside = Math.sqrt(losses.reduce((a, b) => a + b * b, 0) / n) || 1e-9;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  // max drawdown of the cumulative-R equity curve
  let cum = 0, peak = 0, dd = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  // realized R:R = avg win magnitude / avg loss magnitude
  const realizedRR = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
  const byRegime: Record<string, { n: number; sum: number }> = {};
  rs.forEach((r, i) => {
    const g = regimes[i];
    (byRegime[g] ??= { n: 0, sum: 0 });
    byRegime[g].n++; byRegime[g].sum += r;
  });
  const byRegimeOut: Record<string, { n: number; expectancyR: number }> = {};
  for (const [g, v] of Object.entries(byRegime)) byRegimeOut[g] = { n: v.n, expectancyR: v.sum / v.n };
  return {
    n, winRate: wins.length / n, expectancyR: mean, avgWinR: avgWin, avgLossR: avgLoss,
    sharpe: mean / sd, sortino: mean / downside, maxDDR: dd, realizedRR, byRegime: byRegimeOut,
  };
}

// ── main ───────────────────────────────────────────────────────────────────
function runConfig(allTrades: { t: Trade; regime: string }[], p: RunParams) {
  const arms: Record<string, Stats> = {};
  for (const arm of COST_ARMS) {
    const rs = allTrades.map((x) => netR(x.t, arm));
    arms[arm.key] = summarize(rs, allTrades.map((x) => x.regime));
  }
  return { params: p, nTrades: allTrades.length, arms };
}

function main() {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const btcRegime = buildBtcRegime();

  const configs: RunParams[] = [];
  // Primary: top-down daily→4H, k=2, regime filter ON, R:R filter ON.
  for (const htfMult of [6, 1]) {
    for (const swingK of [2, 3]) {
      for (const regimeFilter of [true, false]) {
        for (const rrFilter of [true, false]) {
          configs.push({ htfMult, swingK, regimeFilter, rrFilter });
        }
      }
    }
  }

  // Precompute per-symbol setups + base ATR once per (htfMult, swingK).
  const results: any[] = [];
  const symbolsUsed: string[] = [];
  let dataStart = Infinity, dataEnd = -Infinity;

  for (const p of configs) {
    const allTrades: { t: Trade; regime: string }[] = [];
    for (const sym of UNIVERSE) {
      const base = load4h(sym);
      if (!base || base.length < 300) continue;
      if (!symbolsUsed.includes(sym)) symbolsUsed.push(sym);
      dataStart = Math.min(dataStart, base[0].timestamp);
      dataEnd = Math.max(dataEnd, base[base.length - 1].timestamp);
      const htf = resample(base, p.htfMult);
      const atr = atrSeries(base, ATR_PERIOD);
      const setups = buildSetups(htf, p.swingK);
      for (const s of setups) {
        const t = tradeSetup(base, atr, p.swingK, s, p);
        if (t) allTrades.push({ t, regime: regimeAt(btcRegime, t.entryTs) });
      }
    }
    results.push(runConfig(allTrades, p));
  }

  // Grade the pre-registered gate on the PRIMARY config (htf=6, k=2, regime ON, rr ON).
  const primary = results.find((r) => r.params.htfMult === 6 && r.params.swingK === 2 && r.params.regimeFilter && r.params.rrFilter)!;
  const gate = gradeGate(primary);

  const report = {
    issue: 'TRA-1933',
    parent: 'TRA-1932',
    generatedAt: new Date().toISOString(),
    dataWindow: { startMs: dataStart, endMs: dataEnd, start: new Date(dataStart).toISOString(), end: new Date(dataEnd).toISOString() },
    universe: symbolsUsed,
    note: 'No 15m data on disk; top-down structure realised as daily(HTF,resampled from 4H)/4H(LTF). Coarser entry TF ⇒ LESS fee drag, so a net-of-taker KILL here is robust (15m would be worse). Costs: taker 60/80bps, maker 10/25bps, slippage 3bps/side.',
    gateArm: GATE_ARM,
    gate,
    configs: results,
  };
  writeFileSync(resolve(REPORT_DIR, 'tra1933-icc.json'), JSON.stringify(report, null, 2));
  writeFileSync(resolve(REPORT_DIR, 'tra1933-icc.md'), renderMd(report));
  console.log('Wrote reports/tra1933-icc.json and reports/tra1933-icc.md');
  console.log(`Primary (htf=daily,k=2,regime+rr): n=${primary.nTrades} taker60 expectancy=${primary.arms[GATE_ARM].expectancyR.toFixed(4)}R → ${gate.verdict}`);
}

interface Gate { verdict: string; passes: Record<string, boolean>; detail: string }
function gradeGate(primary: any): Gate {
  const taker = primary.arms[GATE_ARM] as Stats;
  const regimesPositive = Object.entries(taker.byRegime)
    .filter(([g]) => g === 'trend_up' || g === 'chop_down');
  const nRegimesPositive = regimesPositive.filter(([, v]) => (v as any).expectancyR > 0).length;
  const passes = {
    'net-of-taker expectancy > 0': taker.expectancyR > 0,
    'n >= 40': taker.n >= 40,
    '>= 2 regimes positive': nRegimesPositive >= 2,
    'realized R:R >= 1.3': taker.realizedRR >= 1.3,
  };
  const allPass = Object.values(passes).every(Boolean);
  // maker-conditional: taker fails but maker_entry expectancy > 0
  const makerEntry = primary.arms['maker_entry'] as Stats;
  let verdict: string;
  let detail: string;
  if (allPass) {
    verdict = 'ADOPT-CANDIDATE (net-of-taker; re-confirm on real 15m before live capital)';
    detail = 'All four pre-registered conditions met on the taker-60 arm.';
  } else if (taker.expectancyR <= 0 && makerEntry.expectancyR > 0 && makerEntry.n >= 40) {
    verdict = 'MAKER-CONDITIONAL, STILL GATED (taker-negative, maker-positive — not adopted)';
    detail = 'Taker-60 expectancy ≤ 0 but maker-entry expectancy > 0; per spec this is not an adopt.';
  } else {
    verdict = 'KILL (documented; same discipline as TSMOM at n=18)';
    detail = 'Failed the pre-registered net-of-taker gate; the fee-vulnerable continuation profile does not clear the bar.';
  }
  return { verdict, passes, detail };
}

function fmt(n: number, d = 3): string { return Number.isFinite(n) ? n.toFixed(d) : 'n/a'; }
function renderMd(r: any): string {
  const L: string[] = [];
  L.push(`# TRA-1933 — ICC net-of-fee backtest`);
  L.push('');
  L.push(`_Generated ${r.generatedAt}. Parent: TRA-1932 (QuantTrader ICC spec)._`);
  L.push('');
  L.push(`**Data window:** ${r.dataWindow.start.slice(0, 10)} → ${r.dataWindow.end.slice(0, 10)} · **Universe (${r.universe.length}):** ${r.universe.join(', ')}`);
  L.push('');
  L.push(`> ${r.note}`);
  L.push('');
  L.push(`## Pre-registered gate (net-of-taker, primary config: daily→4H, k=2, regime+R:R filters ON)`);
  L.push('');
  for (const [k, v] of Object.entries(r.gate.passes)) L.push(`- ${v ? '✅' : '❌'} ${k}`);
  L.push('');
  L.push(`### VERDICT: **${r.gate.verdict}**`);
  L.push('');
  L.push(`${r.gate.detail}`);
  L.push('');
  L.push(`## Primary config — cost-arm sweep`);
  L.push('');
  L.push(`| cost arm | n | expectancy (R) | win% | realized R:R | Sharpe | Sortino | maxDD (R) |`);
  L.push(`|---|--:|--:|--:|--:|--:|--:|--:|`);
  const primary = r.configs.find((c: any) => c.params.htfMult === 6 && c.params.swingK === 2 && c.params.regimeFilter && c.params.rrFilter);
  for (const arm of COST_ARMS) {
    const s = primary.arms[arm.key];
    L.push(`| ${arm.key} | ${s.n} | ${fmt(s.expectancyR, 4)} | ${fmt(s.winRate * 100, 1)} | ${fmt(s.realizedRR, 2)} | ${fmt(s.sharpe, 3)} | ${fmt(s.sortino, 3)} | ${fmt(s.maxDDR, 2)} |`);
  }
  L.push('');
  L.push(`### Primary config — taker-60 expectancy by regime`);
  L.push('');
  const preg = primary.arms[GATE_ARM].byRegime;
  L.push(`| regime | n | expectancy (R) |`);
  L.push(`|---|--:|--:|`);
  for (const [g, v] of Object.entries(preg)) L.push(`| ${g} | ${(v as any).n} | ${fmt((v as any).expectancyR, 4)} |`);
  L.push('');
  L.push(`## Sensitivity — net-of-taker (${GATE_ARM}) expectancy across all configs`);
  L.push('');
  L.push(`| HTF/LTF | swingK | regimeFilter | rrFilter | n | taker60 expectancy (R) | gross expectancy (R) |`);
  L.push(`|---|--:|:--:|:--:|--:|--:|--:|`);
  for (const c of r.configs) {
    const tf = c.params.htfMult === 6 ? 'daily/4H' : '4H/4H';
    L.push(`| ${tf} | ${c.params.swingK} | ${c.params.regimeFilter ? 'on' : 'off'} | ${c.params.rrFilter ? 'on' : 'off'} | ${c.nTrades} | ${fmt(c.arms[GATE_ARM].expectancyR, 4)} | ${fmt(c.arms['gross_0'].expectancyR, 4)} |`);
  }
  L.push('');
  L.push(`## Method notes`);
  L.push(`- **Indication:** HTF close breaks the most recent confirmed fractal swing (k=${'{2,3}'}). Impulse leg L0→H1 over ≤${IMPULSE_N_HTF} HTF bars.`);
  L.push(`- **Correction:** valid when an LTF close lands in the [${FIB_LO}, ${FIB_HI}] Fib retrace of (H1−L0). Any close beyond L0 invalidates (no flip).`);
  L.push(`- **Continuation:** first LTF close beyond the correction's micro-swing (fractal k). Stop = correction extreme ∓ ${ATR_STOP_BUF}×ATR(${ATR_PERIOD}); target = H1; R:R filter ≥ ${RR_MIN}.`);
  L.push(`- **Fills/exits:** entry at the trigger close; intrabar stop-first when both stop & target print on one bar (conservative). Time-stop after ${TRADE_TIMEOUT_LTF} LTF bars.`);
  L.push(`- **Fees in R:** round-trip (entryPx·fEntry + exitPx·fExit)/risk subtracted from gross R. Regimes tagged by BTC daily 200-SMA (trend_up / chop_down).`);
  L.push('');
  return L.join('\n');
}

main();
