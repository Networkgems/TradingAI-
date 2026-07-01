/**
 * TRA-1217 — Crypto momentum-ignition / "about-to-pop" scanner.
 *
 * QuantTrader-owned RESEARCH harness (same status as run-tra1211-regime.ts /
 * run-tra523-fee-aware.ts): it only consumes the already-exported
 * loadOrFetch4hBars API and runs a self-contained discrete-trade TP/SL sim.
 * It does NOT touch any live/demo path and places no orders.
 *
 * Hypothesis (board ask, distinct from TRA-1211's continuous TSMOM):
 *   Flag coins about to make a discrete +10-15% move; enter in time; take profit
 *   at a fixed target with a hard stop. A big discrete target dwarfs the ~1.2%
 *   round-trip taker cost, and high-conviction ignitions fire rarely (low
 *   turnover), so the binding constraint is SIGNAL QUALITY + ENTRY LATENCY +
 *   HIT RATE, not fees.
 *
 * Signal (OHLCV-only — no funding/OI/on-chain history in the harness, same
 * limitation TRA-1211 flagged; those features are ranked from literature in the
 * memo, not tested here):
 *   1. Donchian breakout: close > highest-high of the prior `donchLen` bars.
 *   2. Prior tight consolidation (squeeze): the Donchian channel width over the
 *      pre-breakout window < `squeezePct` of price (a coiled range).
 *   3. Volume ignition: RVOL = bar volume / SMA(volume, volLen) >= `rvolMin`.
 *   4. Trend filter: close > EMA(trendLen) (only fire with the higher-TF trend).
 *
 * Entry latency honesty (scope item 3): the signal is decided on the CLOSE of the
 * signal bar; we enter at the NEXT bar's OPEN (no lookahead). Intrabar TP/SL is
 * resolved PESSIMISTICALLY (stop-first when a single bar spans both) to avoid the
 * TP-first optimism TRA-1211 called out. We also report an OPTIMISTIC (TP-first)
 * arm to quantify how much of any edge is bar-resolution artifact.
 *
 * Fees (scope item 2): taker (60 bps/side, +3 bps slip) vs maker-limit (20 bps/
 * side, 0 slip) — same bounding cases TRA-523 used to show mean-reversion only
 * survived at maker cost. R is normalised by the stop distance: a clean TP with
 * tp=10% / stop=4% ~ +2.5R gross; a full stop-out ~ -1R minus fees.
 *
 * Run (network-free against the on-disk 4H cache):
 *   TRA1217_CACHED_ONLY=1 TRA1217_END=2026-06-03T00:00:00Z \
 *     pnpm --filter @trading-app/backtest exec tsx src/run-tra1217-ignition.ts
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { loadOrFetch4hBars, cachePathFor4h } from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const DATA_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01
const BULL_END_MS = Date.UTC(2025, 9, 6); // 2025-10-06 ATH
const BEAR_START_MS = Date.UTC(2025, 9, 6);
const END_OVERRIDE = process.env['TRA1217_END'];
const BEAR_END_MS = END_OVERRIDE ? Date.parse(END_OVERRIDE) : Date.now();
const YEAR_MS = 365.25 * 864e5;
const RISK_PER_TRADE = 0.01; // 1% account risk per trade for the merged-equity curve

// Majors + liquid mid-cap alts — where discrete 10-15% pops actually happen.
const UNIVERSE = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD', 'DOGE-USD', 'AVAX-USD',
  'LINK-USD', 'DOT-USD', 'LTC-USD', 'BCH-USD', 'ATOM-USD', 'UNI-USD', 'XLM-USD',
  'ETC-USD', 'FIL-USD', 'NEAR-USD', 'APT-USD', 'ARB-USD', 'OP-USD', 'INJ-USD',
  'SUI-USD', 'RENDER-USD', 'AAVE-USD', 'MKR-USD', 'CRV-USD', 'LDO-USD', 'SNX-USD',
  'GRT-USD', 'ALGO-USD', 'HBAR-USD', 'IMX-USD', 'SAND-USD', 'MANA-USD', 'APE-USD',
  'AXS-USD', 'CHZ-USD', 'COMP-USD', 'FLOW-USD', 'ICP-USD', 'POL-USD', 'ZEC-USD',
] as const;

interface SignalParams {
  donchLen: number; // breakout lookback (bars)
  squeezeLen: number; // pre-breakout window measured for tightness
  squeezePct: number; // channel width / price must be below this (fraction)
  volLen: number; // RVOL baseline window (bars)
  rvolMin: number; // RVOL threshold
  trendLen: number; // EMA trend filter length
}

const SIGNAL: SignalParams = {
  donchLen: 20, // ~3.3 days on 4h
  squeezeLen: 20,
  squeezePct: 0.14, // channel spanned < 14% of price = coiled
  volLen: 30, // ~5 days
  rvolMin: 3.0,
  trendLen: 50,
};

interface ExitParams { tpPct: number; slPct: number; maxHoldBars: number; }
// Grid: two TP targets × two hold horizons, one stop.
const EXIT_GRID: ExitParams[] = [
  { tpPct: 0.10, slPct: 0.04, maxHoldBars: 12 }, // +10% / -4% / 2 days
  { tpPct: 0.10, slPct: 0.04, maxHoldBars: 30 }, // +10% / -4% / 5 days
  { tpPct: 0.15, slPct: 0.05, maxHoldBars: 30 }, // +15% / -5% / 5 days
  { tpPct: 0.15, slPct: 0.05, maxHoldBars: 60 }, // +15% / -5% / 10 days
];

interface FeeArm { name: string; feeBps: number; slipBps: number; }
const FEE_ARMS: FeeArm[] = [
  { name: 'taker_60', feeBps: 60, slipBps: 3 }, // status-quo Coinbase taker (market)
  { name: 'maker_20', feeBps: 20, slipBps: 0 }, // limit / maker entry+exit
];

type Resolution = 'pessimistic' | 'optimistic';

// ---- indicators -----------------------------------------------------------
function ema(values: number[], len: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const k = 2 / (len + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = Number.isNaN(prev) ? v : v * k + prev * (1 - k);
    if (i >= len - 1) out[i] = prev;
  }
  return out;
}

// ---- signal detection ------------------------------------------------------
/** Returns bar indices at whose CLOSE an ignition fires (entry is the NEXT open). */
function detectSignals(c: Candle[], p: SignalParams): number[] {
  const closes = c.map((x) => x.close);
  const emaTrend = ema(closes, p.trendLen);
  const need = Math.max(p.donchLen, p.squeezeLen, p.volLen, p.trendLen) + 1;
  const signals: number[] = [];
  for (let i = need; i < c.length - 1; i++) {
    if (c[i].synthetic) continue; // don't fire on gap-filled flat bars
    // 1. Donchian breakout: close above prior donchLen-bar high (exclusive of i).
    let priorHigh = -Infinity;
    for (let j = i - p.donchLen; j < i; j++) priorHigh = Math.max(priorHigh, c[j].high);
    if (!(c[i].close > priorHigh)) continue;
    // 2. Squeeze: pre-breakout channel width small relative to price.
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p.squeezeLen; j < i; j++) { hi = Math.max(hi, c[j].high); lo = Math.min(lo, c[j].low); }
    const width = (hi - lo) / c[i].close;
    if (!(width < p.squeezePct)) continue;
    // 3. Volume ignition (RVOL) — exclude the current bar from the baseline.
    let volSum = 0;
    for (let j = i - p.volLen; j < i; j++) volSum += c[j].volume;
    const baseVol = volSum / p.volLen;
    if (!(baseVol > 0 && c[i].volume / baseVol >= p.rvolMin)) continue;
    // 4. Trend filter.
    if (!(Number.isFinite(emaTrend[i]) && c[i].close > emaTrend[i])) continue;
    signals.push(i);
  }
  return signals;
}

// ---- discrete-trade simulation --------------------------------------------
interface TradeResult {
  entryIdx: number; entryTime: number; entryPrice: number;
  exitIdx: number; exitTime: number; exitPrice: number;
  outcome: 'tp' | 'sl' | 'timeout';
  grossRet: number; netRet: number; rNet: number; holdBars: number;
}

function simulateTrade(
  c: Candle[], sigIdx: number, ex: ExitParams, fee: FeeArm, res: Resolution,
): TradeResult | null {
  const entryIdx = sigIdx + 1;
  if (entryIdx >= c.length) return null;
  const entryPrice = c[entryIdx].open; // enter next bar open — no lookahead
  if (!(entryPrice > 0)) return null;
  const tp = entryPrice * (1 + ex.tpPct);
  const sl = entryPrice * (1 - ex.slPct);
  const feeFrac = fee.feeBps / 10_000;
  const slipFrac = fee.slipBps / 10_000;
  const costFrac = 2 * feeFrac + 2 * slipFrac; // entry + exit

  let exitIdx = -1, exitPrice = NaN;
  let outcome: TradeResult['outcome'] = 'timeout';
  const lastBar = Math.min(entryIdx + ex.maxHoldBars, c.length - 1);
  for (let k = entryIdx; k <= lastBar; k++) {
    const bar = c[k];
    // Entry-bar gap handling: if the open already cleared a level, fill at open.
    if (k === entryIdx) {
      if (bar.open >= tp) { exitIdx = k; exitPrice = tp; outcome = 'tp'; break; }
      if (bar.open <= sl) { exitIdx = k; exitPrice = sl; outcome = 'sl'; break; }
    }
    const hitTp = bar.high >= tp;
    const hitSl = bar.low <= sl;
    if (hitTp && hitSl) {
      // Single bar spans both — resolution assumption decides which fills first.
      if (res === 'pessimistic') { exitIdx = k; exitPrice = sl; outcome = 'sl'; }
      else { exitIdx = k; exitPrice = tp; outcome = 'tp'; }
      break;
    }
    if (hitTp) { exitIdx = k; exitPrice = tp; outcome = 'tp'; break; }
    if (hitSl) { exitIdx = k; exitPrice = sl; outcome = 'sl'; break; }
  }
  if (exitIdx < 0) { exitIdx = lastBar; exitPrice = c[lastBar].close; outcome = 'timeout'; }

  const grossRet = exitPrice / entryPrice - 1;
  const netRet = grossRet - costFrac;
  const rNet = netRet / ex.slPct; // normalise by stop distance
  return {
    entryIdx, entryTime: c[entryIdx].timestamp, entryPrice,
    exitIdx, exitTime: c[exitIdx].timestamp, exitPrice,
    outcome, grossRet, netRet, rNet, holdBars: exitIdx - entryIdx,
  };
}

/** Non-overlapping trades per symbol: skip signals while a position is open. */
function runSymbol(
  c: Candle[], signals: number[], ex: ExitParams, fee: FeeArm, res: Resolution,
): TradeResult[] {
  const trades: TradeResult[] = [];
  let freeAfterIdx = -1;
  for (const s of signals) {
    if (s <= freeAfterIdx) continue; // still in a trade
    const t = simulateTrade(c, s, ex, fee, res);
    if (!t) continue;
    trades.push(t);
    freeAfterIdx = t.exitIdx;
  }
  return trades;
}

// ---- stats -----------------------------------------------------------------
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function profitFactor(xs: number[]): number {
  let g = 0, l = 0;
  for (const r of xs) { if (r > 0) g += r; else l += Math.abs(r); }
  return l > 0 ? g / l : g > 0 ? Infinity : 0;
}
function mergedEquity(trades: { exitTime: number; rNet: number }[]) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let eq = 1, peak = 1, maxDd = 0;
  for (const t of sorted) {
    eq *= 1 + RISK_PER_TRADE * t.rNet;
    peak = Math.max(peak, eq);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  return { finalMult: eq, maxDdPct: maxDd * 100 };
}

interface Regime { name: string; start: number; end: number; }
const REGIMES: Regime[] = [
  { name: 'bull', start: DATA_START_MS, end: BULL_END_MS },
  { name: 'bear', start: BEAR_START_MS, end: BEAR_END_MS },
  { name: 'all', start: DATA_START_MS, end: BEAR_END_MS },
];

interface Cell {
  exit: string; feeArm: string; resolution: Resolution; regime: string;
  symbolsContributing: number; trades: number; turnoverPerYr: number;
  hitRatePct: number; stopRatePct: number; timeoutRatePct: number;
  expectancyNetR: number; medianNetR: number; profitFactor: number;
  sharpe: number; avgHoldBars: number; avgHoldHours: number;
  maxDdPct: number; finalEquityMult: number; returnPct: number;
}

function summarize(
  label: { exit: string; feeArm: string; resolution: Resolution; regime: string },
  trades: TradeResult[], symbolsContributing: number, windowYears: number,
): Cell {
  const rs = trades.map((t) => t.rNet);
  const n = rs.length;
  const tp = trades.filter((t) => t.outcome === 'tp').length;
  const sl = trades.filter((t) => t.outcome === 'sl').length;
  const to = trades.filter((t) => t.outcome === 'timeout').length;
  const m = mean(rs);
  const sd = stdev(rs);
  const tradesPerYr = windowYears > 0 ? n / windowYears : 0;
  const ann = Math.sqrt(Math.max(tradesPerYr, 0));
  const eq = mergedEquity(trades);
  const avgHold = mean(trades.map((t) => t.holdBars));
  return {
    ...label,
    symbolsContributing,
    trades: n,
    turnoverPerYr: Number(tradesPerYr.toFixed(1)),
    hitRatePct: Number((n ? (100 * tp) / n : 0).toFixed(1)),
    stopRatePct: Number((n ? (100 * sl) / n : 0).toFixed(1)),
    timeoutRatePct: Number((n ? (100 * to) / n : 0).toFixed(1)),
    expectancyNetR: Number(m.toFixed(4)),
    medianNetR: Number(median(rs).toFixed(4)),
    profitFactor: Number((Number.isFinite(profitFactor(rs)) ? profitFactor(rs) : -1).toFixed(3)),
    sharpe: Number((sd > 0 ? (m / sd) * ann : 0).toFixed(3)),
    avgHoldBars: Number(avgHold.toFixed(1)),
    avgHoldHours: Number((avgHold * 4).toFixed(1)),
    maxDdPct: Number(eq.maxDdPct.toFixed(2)),
    finalEquityMult: Number(eq.finalMult.toFixed(4)),
    returnPct: Number(((eq.finalMult - 1) * 100).toFixed(2)),
  };
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const cachedOnly = process.env['TRA1217_CACHED_ONLY'] === '1';
  console.log(`[tra1217] ignition scanner — ${UNIVERSE.length} symbols  (Donchian ${SIGNAL.donchLen} / squeeze<${SIGNAL.squeezePct} / RVOL>=${SIGNAL.rvolMin} / EMA${SIGNAL.trendLen})`);

  const candlesBySym = new Map<string, Candle[]>();
  const loaded: string[] = [];
  const failed: { symbol: string; error: string }[] = [];
  for (const symbol of UNIVERSE) {
    if (cachedOnly && !existsSync(cachePathFor4h(symbol))) { failed.push({ symbol, error: 'not cached' }); continue; }
    try {
      const c = await loadOrFetch4hBars(symbol, DATA_START_MS, BEAR_END_MS);
      candlesBySym.set(symbol, c);
      loaded.push(symbol);
    } catch (err) { failed.push({ symbol, error: err instanceof Error ? err.message : String(err) }); }
  }
  console.log(`[tra1217] loaded ${loaded.length}/${UNIVERSE.length}`);

  // Detect signals once per symbol (independent of exit/fee/resolution).
  const sigsBySym = new Map<string, number[]>();
  let totalSignals = 0;
  for (const symbol of loaded) {
    const s = detectSignals(candlesBySym.get(symbol)!, SIGNAL);
    sigsBySym.set(symbol, s);
    totalSignals += s.length;
  }
  console.log(`[tra1217] ${totalSignals} raw ignition signals across ${loaded.length} symbols`);

  const cells: Cell[] = [];
  const resolutions: Resolution[] = ['pessimistic', 'optimistic'];
  for (const ex of EXIT_GRID) {
    const exLabel = `tp${Math.round(ex.tpPct * 100)}/sl${Math.round(ex.slPct * 100)}/${ex.maxHoldBars}b`;
    for (const fee of FEE_ARMS) {
      for (const res of resolutions) {
        // Simulate all trades per symbol once, then bucket by regime on exit time.
        const allTrades: { symbol: string; t: TradeResult }[] = [];
        for (const symbol of loaded) {
          const trades = runSymbol(candlesBySym.get(symbol)!, sigsBySym.get(symbol)!, ex, fee, res);
          for (const t of trades) allTrades.push({ symbol, t });
        }
        for (const reg of REGIMES) {
          const inReg = allTrades.filter((x) => x.t.entryTime >= reg.start && x.t.entryTime < reg.end);
          const symbols = new Set(inReg.map((x) => x.symbol)).size;
          const windowYears = (reg.end - reg.start) / YEAR_MS;
          cells.push(summarize(
            { exit: exLabel, feeArm: fee.name, resolution: res, regime: reg.name },
            inReg.map((x) => x.t), symbols, windowYears,
          ));
        }
      }
    }
  }

  const payload = {
    issue: 'TRA-1217',
    generatedAt: new Date().toISOString(),
    parent: 'TRA-1210',
    hypothesis: 'discrete +10-15% momentum-ignition pops; low turnover; fee cost dwarfed by target',
    signalParams: SIGNAL,
    exitGrid: EXIT_GRID,
    feeArms: FEE_ARMS,
    regimes: REGIMES.map((r) => ({ name: r.name, start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() })),
    riskPerTrade: RISK_PER_TRADE,
    barTimeframe: '4h',
    dataSource: 'coinbase-exchange',
    universe: UNIVERSE,
    loaded,
    failed,
    totalRawSignals: totalSignals,
    notes: [
      'OHLCV-only signal: no funding/open-interest/on-chain/social history in the harness (same limit as TRA-1211). Perp-OI/funding-surge & social features are ranked from literature in the memo, NOT tested here.',
      'Entry = NEXT bar open after the signal bar CLOSE (no lookahead).',
      'PESSIMISTIC resolution assumes STOP fills first when one 4h bar spans both TP and SL; OPTIMISTIC assumes TP-first. The gap between them is the bar-resolution ambiguity TRA-1211 flagged.',
      'R normalised by stop distance (slPct). Clean TP tp10/sl4 = +2.5R gross; full stop = -1R minus fees.',
      'maxDD is a REAL merged-equity curve across the universe, per-trade 1% risk compounded by exit time.',
      'Non-overlapping trades per symbol (no pyramiding); a new signal is ignored while a position is open.',
    ],
    cells,
  };

  // --- conviction sensitivity: does tightening thresholds (fewer, higher-
  //     conviction signals) rescue hit rate / net expectancy? Tests the board's
  //     "few high-conviction ignitions" premise. Fixed exit tp10/sl4/30b,
  //     PESSIMISTIC, both fee arms, bull + all-regime. ---
  const convExit: ExitParams = { tpPct: 0.10, slPct: 0.04, maxHoldBars: 30 };
  const convGrid: SignalParams[] = [
    { ...SIGNAL, rvolMin: 3.0, squeezePct: 0.14 }, // baseline
    { ...SIGNAL, rvolMin: 4.0, squeezePct: 0.12 },
    { ...SIGNAL, rvolMin: 5.0, squeezePct: 0.10 },
    { ...SIGNAL, rvolMin: 6.0, squeezePct: 0.08, donchLen: 30 }, // strictest
  ];
  interface ConvRow { rvolMin: number; squeezePct: number; donchLen: number; regime: string; feeArm: string; trades: number; hitRatePct: number; expectancyNetR: number; medianNetR: number; profitFactor: number; ciLo?: number; ciHi?: number; pPositive?: number; }
  const convRows: ConvRow[] = [];
  // Seeded percentile bootstrap of the mean (deterministic; TRA-1133 style).
  function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function bootstrapMeanCI(xs: number[], iters = 5000, seed = 12345) {
    if (xs.length < 5) return { ciLo: NaN, ciHi: NaN, pPositive: NaN };
    const rnd = mulberry32(seed);
    const means: number[] = [];
    for (let b = 0; b < iters; b++) {
      let s = 0;
      for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)];
      means.push(s / xs.length);
    }
    means.sort((a, b) => a - b);
    const pPositive = means.filter((m) => m > 0).length / iters;
    return { ciLo: means[Math.floor(0.05 * iters)], ciHi: means[Math.floor(0.95 * iters)], pPositive };
  }
  for (const sp of convGrid) {
    const sigs = new Map<string, number[]>();
    for (const symbol of loaded) sigs.set(symbol, detectSignals(candlesBySym.get(symbol)!, sp));
    for (const fee of FEE_ARMS) {
      const all: { symbol: string; t: TradeResult }[] = [];
      for (const symbol of loaded) {
        for (const t of runSymbol(candlesBySym.get(symbol)!, sigs.get(symbol)!, convExit, fee, 'pessimistic')) all.push({ symbol, t });
      }
      for (const reg of REGIMES) {
        const inReg = all.filter((x) => x.t.entryTime >= reg.start && x.t.entryTime < reg.end);
        const rs = inReg.map((x) => x.t.rNet);
        const tp = inReg.filter((x) => x.t.outcome === 'tp').length;
        // Only spend bootstrap on the strictest (decision-relevant) config.
        const isStrict = sp.rvolMin >= 6;
        const ci = isStrict ? bootstrapMeanCI(rs) : { ciLo: undefined, ciHi: undefined, pPositive: undefined };
        convRows.push({
          rvolMin: sp.rvolMin, squeezePct: sp.squeezePct, donchLen: sp.donchLen, regime: reg.name, feeArm: fee.name,
          trades: rs.length, hitRatePct: Number((rs.length ? (100 * tp) / rs.length : 0).toFixed(1)),
          expectancyNetR: Number(mean(rs).toFixed(4)), medianNetR: Number(median(rs).toFixed(4)),
          profitFactor: Number((Number.isFinite(profitFactor(rs)) ? profitFactor(rs) : -1).toFixed(3)),
          ciLo: ci.ciLo === undefined || Number.isNaN(ci.ciLo) ? undefined : Number(ci.ciLo.toFixed(4)),
          ciHi: ci.ciHi === undefined || Number.isNaN(ci.ciHi) ? undefined : Number(ci.ciHi.toFixed(4)),
          pPositive: ci.pPositive === undefined || Number.isNaN(ci.pPositive) ? undefined : Number(ci.pPositive.toFixed(3)),
        });
      }
    }
  }
  (payload as unknown as { convictionSweep: unknown }).convictionSweep = { exit: convExit, rows: convRows };

  const jsonPath = resolve(REPORT_DIR, 'tra1217-ignition.json');
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  console.log('\n=== conviction sweep (exit tp10/sl4/30b, pessimistic) — does tightening rescue the edge? ===');
  console.log('rvol squeeze donch  regime  fee        n    hit%   exp(R)   med(R)  PF     90%CI[lo,hi]      P(exp>0)');
  for (const r of convRows) {
    const ci = r.ciLo !== undefined ? `[${r.ciLo.toFixed(3)}, ${r.ciHi!.toFixed(3)}]`.padStart(17) : ''.padStart(17);
    const pp = r.pPositive !== undefined ? String(r.pPositive).padStart(8) : ''.padStart(8);
    console.log(
      `${String(r.rvolMin).padStart(4)} ${String(r.squeezePct).padStart(7)} ${String(r.donchLen).padStart(5)}  ${r.regime.padEnd(6)} ${r.feeArm.padEnd(9)} ` +
      `${String(r.trades).padStart(4)}  ${String(r.hitRatePct).padStart(5)} ${r.expectancyNetR.toFixed(3).padStart(7)} ${r.medianNetR.toFixed(3).padStart(7)} ${String(r.profitFactor).padStart(6)} ${ci} ${pp}`,
    );
  }

  console.log('\n=== TRA-1217 ignition (1% risk; hit=TP rate; exp/med in R NET of fees) ===');
  console.log('exit              fee       res     regime   n    t/yr  hit%  stop%  to%   exp(R)   med(R)  PF     Sharpe hold(h)  maxDD%   ret%');
  for (const c of cells) {
    console.log(
      `${c.exit.padEnd(17)} ${c.feeArm.padEnd(9)} ${c.resolution.slice(0, 4).padEnd(6)} ${c.regime.padEnd(6)} ` +
      `${String(c.trades).padStart(4)} ${String(c.turnoverPerYr).padStart(5)} ${String(c.hitRatePct).padStart(5)} ` +
      `${String(c.stopRatePct).padStart(5)} ${String(c.timeoutRatePct).padStart(5)} ${c.expectancyNetR.toFixed(3).padStart(7)} ` +
      `${c.medianNetR.toFixed(3).padStart(7)} ${String(c.profitFactor).padStart(6)} ${String(c.sharpe).padStart(6)} ` +
      `${String(c.avgHoldHours).padStart(7)} ${String(c.maxDdPct).padStart(6)} ${String(c.returnPct).padStart(7)}`,
    );
  }
  console.log(`\n[tra1217] report written: ${jsonPath}`);
}

const invoked = process.argv[1] && /run-tra1217-ignition\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
