/**
 * TRA-1933 (board follow-up: "what about stocks and stock options") —
 * ICC net-of-fee PROBE on the equity daily caches.
 *
 * Owner: LeadDev. Companion to run-tra1933-icc-fee-backtest.ts (which killed the
 * crypto variant). Same ICC state machine, ported to the equity daily caches.
 *
 * ── Data reality (read this before trusting any number) ────────────────────
 *   The backtest data/ dir holds 26 equity tickers, but ONLY PLTR carries a
 *   gradeable history (627 daily bars, 2024-01..2026-07). Every other equity
 *   cache is a 5–99-bar freshly-fetched stub — unusable. So this probe is a
 *   SINGLE-NAME daily/weekly run: it CANNOT reach the n>=40 pre-registered gate
 *   and is ANECDOTAL, not a graded adopt/kill. Its job is to answer whether the
 *   crypto KILL's *mechanism* (a razor-thin gross edge that any realistic cost
 *   erases) reproduces on an equity underlying.
 *
 *   Stock OPTIONS: there is NO options data on disk (no chains, no IV, no
 *   greeks), so an options net-of-fee backtest cannot run here at all. Options
 *   fee drag is structurally WORSE than equity or crypto (per-contract
 *   commission + bid/ask spread routinely 3–10% of premium), so an ICC signal
 *   that is already net-negative on the cheap equity/crypto tape does not
 *   survive an options overlay a fortiori. See the issue comment.
 *
 * Timeframes: equity daily is the finest bar we have, so HTF = weekly
 *   (resample mult 5 trading days), LTF (entry) = daily. This mirrors the
 *   two-timeframe structure of the crypto run one notch up, and — as there —
 *   the coarser entry TF UNDERSTATES fee drag, so a net-negative result is
 *   conservative.
 *
 * Cost arms are equity-appropriate (commission ~0, spread/slippage the real
 *   cost) — deliberately CHEAPER than the crypto taker-60 arm, to isolate
 *   whether the gross edge itself (not fees) is the problem.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra1933-icc-equity-probe.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const REPORT_DIR = resolve(HERE, '..', 'reports');
const DAY_MS = 24 * 60 * 60 * 1000;

// Every equity ticker present in data/. Only those with >=250 real daily bars
// are actually tradeable; the rest are filtered out and REPORTED as skipped so
// the thin coverage is never silently laundered into "we tested equities".
const EQUITY_UNIVERSE = [
  'aapl', 'adbe', 'amd', 'amzn', 'avgo', 'coin', 'crm', 'dia', 'googl', 'intc',
  'iwm', 'meta', 'msft', 'mstr', 'nflx', 'nvda', 'orcl', 'pltr', 'pypl', 'qcom',
  'qqq', 'shop', 'spy', 'tsla', 'xlf', 'xyz',
];
const MIN_BARS = 250;

// ── ICC parameters (identical to the crypto harness) ────────────────────────
const FIB_LO = 0.382;
const FIB_HI = 0.786;
const IMPULSE_N_HTF = 12;
const ATR_PERIOD = 14;
const ATR_STOP_BUF = 0.1;
const RR_MIN = 1.5;
const ENTRY_WINDOW_LTF = 60;
const TRADE_TIMEOUT_LTF = 90;
const HTF_MULT = 5; // weekly HTF from daily base (5 trading days)

interface CostArm { key: string; label: string; entryFeeBps: number; entrySlipBps: number; exitFeeBps: number; exitSlipBps: number }
// Equity cost bracket: commission is ~0 at retail/algo scale; the true cost is
// the half-spread + market-impact slippage. Even the "conservative" equity arm
// is cheaper than crypto taker-60 — that is the point.
const COST_ARMS: CostArm[] = [
  { key: 'gross_0', label: 'zero-cost reference (raw signal edge)', entryFeeBps: 0, entrySlipBps: 0, exitFeeBps: 0, exitSlipBps: 0 },
  { key: 'eq_liquid', label: 'liquid large-cap: 0 commission + 2bps slippage/side', entryFeeBps: 0, entrySlipBps: 2, exitFeeBps: 0, exitSlipBps: 2 },
  { key: 'eq_retail', label: 'retail spread: 0 commission + 5bps slippage/side', entryFeeBps: 0, entrySlipBps: 5, exitFeeBps: 0, exitSlipBps: 5 },
  { key: 'eq_wide', label: 'conservative: 1bps commission + 10bps slippage/side', entryFeeBps: 1, entrySlipBps: 10, exitFeeBps: 1, exitSlipBps: 10 },
];
const GATE_ARM = 'eq_retail';

// ── indicator + ICC helpers (ported verbatim from the crypto harness) ───────
function emaSeries(values: number[], period: number): number[] {
  const out: number[] = []; const k = 2 / (period + 1); let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) { prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}
function atrSeries(bars: Candle[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  if (bars.length < period + 1) return out;
  let prevClose = bars[0].close; const trs: number[] = [0];
  for (let i = 1; i < bars.length; i++) { const h = bars[i].high, l = bars[i].low; trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose))); prevClose = bars[i].close; }
  let atr = 0; for (let i = 1; i <= period; i++) atr += trs[i]; atr /= period; out[period] = atr;
  for (let i = period + 1; i < bars.length; i++) { atr = (atr * (period - 1) + trs[i]) / period; out[i] = atr; }
  return out;
}
interface CacheEntry { symbol: string; candles: Candle[] }
function loadDaily(symbol: string): Candle[] | null {
  const p = resolve(DATA_DIR, `${symbol.toLowerCase()}.json`);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf-8')) as CacheEntry;
  return (raw.candles ?? []).filter((c) => !c.synthetic).sort((a, b) => a.timestamp - b.timestamp);
}
function resample(bars: Candle[], mult: number): Candle[] {
  if (mult <= 1) return bars;
  const bucketMs = mult * DAY_MS; const out: Candle[] = []; let cur: Candle | null = null; let curBucket = -1;
  for (const b of bars) {
    const bucket = Math.floor(b.timestamp / bucketMs);
    if (bucket !== curBucket) { if (cur) out.push(cur); curBucket = bucket; cur = { ...b, timestamp: bucket * bucketMs }; }
    else if (cur) { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  if (cur) out.push(cur); return out;
}
interface Pivot { idx: number; price: number; kind: 'high' | 'low' }
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
type Side = 'long' | 'short';
interface Trade { side: Side; entryTs: number; rGross: number; entryPx: number; exitPx: number; risk: number; rr: number }
interface RunParams { swingK: number; regimeFilter: boolean; rrFilter: boolean }
interface Setup { side: Side; L0: number; H1: number; armTs: number; emaSlopeUp: boolean }

function buildSetups(htf: Candle[], k: number): Setup[] {
  const setups: Setup[] = []; const pivots = fractalPivots(htf, k); const emaC = emaSeries(htf.map((b) => b.close), 50);
  let pi = 0; const confirmedHighs: Pivot[] = []; const confirmedLows: Pivot[] = []; let consumedHighIdx = -1, consumedLowIdx = -1;
  for (let j = 0; j < htf.length; j++) {
    while (pi < pivots.length && pivots[pi].idx + k <= j) { const p = pivots[pi]; (p.kind === 'high' ? confirmedHighs : confirmedLows).push(p); pi++; }
    const close = htf[j].close; const lastHigh = confirmedHighs[confirmedHighs.length - 1]; const lastLow = confirmedLows[confirmedLows.length - 1];
    if (lastHigh && lastHigh.idx !== consumedHighIdx && close > lastHigh.price) {
      consumedHighIdx = lastHigh.idx; const l0 = [...confirmedLows].reverse().find((p) => p.idx < j);
      if (l0) { const end = Math.min(j + IMPULSE_N_HTF, htf.length - 1); let h1 = -Infinity; for (let m = j; m <= end; m++) h1 = Math.max(h1, htf[m].high);
        if (h1 > l0.price) setups.push({ side: 'long', L0: l0.price, H1: h1, armTs: htf[end].timestamp, emaSlopeUp: emaC[end] >= emaC[Math.max(0, end - 1)] }); }
    }
    if (lastLow && lastLow.idx !== consumedLowIdx && close < lastLow.price) {
      consumedLowIdx = lastLow.idx; const h0 = [...confirmedHighs].reverse().find((p) => p.idx < j);
      if (h0) { const end = Math.min(j + IMPULSE_N_HTF, htf.length - 1); let l1 = Infinity; for (let m = j; m <= end; m++) l1 = Math.min(l1, htf[m].low);
        if (l1 < h0.price) setups.push({ side: 'short', L0: h0.price, H1: l1, armTs: htf[end].timestamp, emaSlopeUp: emaC[end] >= emaC[Math.max(0, end - 1)] }); }
    }
  }
  return setups;
}
function mkTrade(side: Side, entryTs: number, entry: number, exit: number, risk: number, rr: number): Trade {
  const rGross = side === 'long' ? (exit - entry) / risk : (entry - exit) / risk;
  return { side, entryTs, entryPx: entry, exitPx: exit, risk, rr, rGross };
}
function tradeSetup(base: Candle[], atr: number[], ltfK: number, s: Setup, p: RunParams): Trade | null {
  if (p.regimeFilter) { if (s.side === 'long' && !s.emaSlopeUp) return null; if (s.side === 'short' && s.emaSlopeUp) return null; }
  const startIdx = base.findIndex((b) => b.timestamp >= s.armTs); if (startIdx < 0) return null;
  const range = s.side === 'long' ? s.H1 - s.L0 : s.L0 - s.H1; if (range <= 0) return null;
  const zoneShallow = s.side === 'long' ? s.H1 - FIB_LO * range : s.H1 + FIB_LO * range;
  const zoneDeep = s.side === 'long' ? s.H1 - FIB_HI * range : s.H1 + FIB_HI * range;
  const zoneHi = Math.max(zoneShallow, zoneDeep), zoneLo = Math.min(zoneShallow, zoneDeep);
  let corrActive = false; let corrExtreme = s.side === 'long' ? Infinity : -Infinity; const microK = ltfK; let microSwing: number | null = null;
  const end = Math.min(startIdx + ENTRY_WINDOW_LTF, base.length - 1);
  for (let i = startIdx; i <= end; i++) {
    const c = base[i];
    if (s.side === 'long' && c.close < s.L0) return null; if (s.side === 'short' && c.close > s.L0) return null;
    if (!corrActive && c.close >= zoneLo && c.close <= zoneHi) corrActive = true; if (!corrActive) continue;
    if (s.side === 'long') corrExtreme = Math.min(corrExtreme, c.low); else corrExtreme = Math.max(corrExtreme, c.high);
    if (i - microK >= startIdx && i - microK - microK >= 0) {
      const p0 = i - microK; let isHigh = true, isLow = true;
      for (let j = 1; j <= microK; j++) { if (!(base[p0].high > base[p0 - j].high && base[p0].high > base[p0 + j].high)) isHigh = false; if (!(base[p0].low < base[p0 - j].low && base[p0].low < base[p0 + j].low)) isLow = false; }
      if (s.side === 'long' && isHigh) microSwing = base[p0].high; if (s.side === 'short' && isLow) microSwing = base[p0].low;
    }
    if (microSwing != null) {
      const trigger = s.side === 'long' ? c.close > microSwing : c.close < microSwing;
      if (trigger) {
        const a = atr[i]; if (isNaN(a) || a <= 0) return null;
        const entry = c.close; const stop = s.side === 'long' ? corrExtreme - ATR_STOP_BUF * a : corrExtreme + ATR_STOP_BUF * a;
        const risk = s.side === 'long' ? entry - stop : stop - entry; if (risk <= 0) return null;
        const target = s.H1; const rr = s.side === 'long' ? (target - entry) / risk : (entry - target) / risk;
        if (rr <= 0) return null; if (p.rrFilter && rr < RR_MIN) return null;
        const tEnd = Math.min(i + TRADE_TIMEOUT_LTF, base.length - 1);
        for (let m = i + 1; m <= tEnd; m++) {
          const bar = base[m];
          if (s.side === 'long') { const hitStop = bar.low <= stop, hitTgt = bar.high >= target;
            if (hitStop) return mkTrade(s.side, c.timestamp, entry, stop, risk, rr); if (hitTgt) return mkTrade(s.side, c.timestamp, entry, target, risk, rr); }
          else { const hitStop = bar.high >= stop, hitTgt = bar.low <= target;
            if (hitStop) return mkTrade(s.side, c.timestamp, entry, stop, risk, rr); if (hitTgt) return mkTrade(s.side, c.timestamp, entry, target, risk, rr); }
        }
        return mkTrade(s.side, c.timestamp, entry, base[tEnd].close, risk, rr);
      }
    }
  }
  return null;
}
function netR(t: Trade, arm: CostArm): number {
  const fEntry = (arm.entryFeeBps + arm.entrySlipBps) / 10000, fExit = (arm.exitFeeBps + arm.exitSlipBps) / 10000;
  const feePrice = t.entryPx * fEntry + t.exitPx * fExit; return t.rGross - feePrice / t.risk;
}
interface Stats { n: number; winRate: number; expectancyR: number; realizedRR: number; sharpe: number }
function summarize(rs: number[]): Stats {
  const n = rs.length; if (n === 0) return { n: 0, winRate: 0, expectancyR: 0, realizedRR: 0, sharpe: 0 };
  const mean = rs.reduce((a, b) => a + b, 0) / n; const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1e-9;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  return { n, winRate: wins.length / n, expectancyR: mean, realizedRR: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0, sharpe: mean / sd };
}

function main() {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const tradeable: string[] = []; const skipped: { sym: string; bars: number }[] = [];
  let dataStart = Infinity, dataEnd = -Infinity;

  const configs: RunParams[] = [];
  for (const swingK of [2, 3]) for (const regimeFilter of [true, false]) for (const rrFilter of [true, false]) configs.push({ swingK, regimeFilter, rrFilter });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose result rows aggregated for the harness report
  const results: any[] = [];
  for (const p of configs) {
    const all: Trade[] = [];
    for (const sym of EQUITY_UNIVERSE) {
      const base = loadDaily(sym);
      const bars = base?.length ?? 0;
      if (!base || bars < MIN_BARS) { if (p === configs[0]) skipped.push({ sym, bars }); continue; }
      if (!tradeable.includes(sym)) tradeable.push(sym);
      dataStart = Math.min(dataStart, base[0].timestamp); dataEnd = Math.max(dataEnd, base[base.length - 1].timestamp);
      const htf = resample(base, HTF_MULT); const atr = atrSeries(base, ATR_PERIOD); const setups = buildSetups(htf, p.swingK);
      for (const s of setups) { const t = tradeSetup(base, atr, p.swingK, s, p); if (t) all.push(t); }
    }
    const arms: Record<string, Stats> = {};
    for (const arm of COST_ARMS) arms[arm.key] = summarize(all.map((t) => netR(t, arm)));
    results.push({ params: p, nTrades: all.length, arms });
  }

  const primary = results.find((r) => r.params.swingK === 2 && r.params.regimeFilter && r.params.rrFilter)!;
  const g = primary.arms[GATE_ARM] as Stats;
  const gross = primary.arms['gross_0'] as Stats;
  const report = {
    issue: 'TRA-1933', parent: 'TRA-1932', kind: 'equity-probe (board follow-up: stocks & stock options)',
    generatedAt: new Date().toISOString(),
    dataCoverage: {
      tradeable, minBars: MIN_BARS,
      skipped: skipped.sort((a, b) => b.bars - a.bars),
      note: 'ONLY PLTR has a gradeable equity history on disk; all other equity caches are 5–99-bar stubs. This is a SINGLE-NAME anecdote, NOT a graded gate (n>=40 unreachable). There is NO options data on disk — the options question cannot be backtested here.',
      window: dataStart <= dataEnd ? { start: new Date(dataStart).toISOString(), end: new Date(dataEnd).toISOString() } : null,
    },
    gateArm: GATE_ARM, configs: results,
    headline: {
      primaryConfig: 'weekly→daily, k=2, regime+R:R ON',
      n: g.n, grossExpectancyR: gross.expectancyR, netExpectancyR_eqRetail: g.expectancyR,
      verdict: g.n < 40
        ? 'INCONCLUSIVE BY DATA — single-name, n<40; cannot grade. Directional read only.'
        : (g.expectancyR > 0 ? 'net-positive (would need full universe to confirm)' : 'net-negative'),
    },
  };
  writeFileSync(resolve(REPORT_DIR, 'tra1933-icc-equity.json'), JSON.stringify(report, null, 2));
  console.log('Wrote reports/tra1933-icc-equity.json');
  console.log(`Tradeable equity names: ${tradeable.join(', ') || '(none)'} | skipped ${skipped.length} thin caches`);
  console.log(`Primary (weekly→daily,k=2,regime+rr): n=${g.n} gross=${gross.expectancyR.toFixed(4)}R eqRetail=${g.expectancyR.toFixed(4)}R → ${report.headline.verdict}`);
  for (const c of results) {
    console.log(`  k=${c.params.swingK} regime=${c.params.regimeFilter ? 'on' : 'off'} rr=${c.params.rrFilter ? 'on' : 'off'}: n=${c.nTrades} gross=${c.arms['gross_0'].expectancyR.toFixed(4)} eqRetail=${c.arms['eq_retail'].expectancyR.toFixed(4)} eqWide=${c.arms['eq_wide'].expectancyR.toFixed(4)}`);
  }
}
main();
