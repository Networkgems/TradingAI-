/**
 * TRA-455 — Backtest acceptance gate for the SMA-200 pullback / reclaim signals
 * built in TRA-451 (spec: TRA-449 → "SMA-200 Signals Build Spec").
 *
 * QuantTrader-owned RESEARCH harness (not application code). It does NOT touch
 * the live trading path — it imports `evaluateSma200`, the pure deterministic
 * signal core from `packages/engine/src/sma200-signals.ts`, so the backtest
 * math is byte-identical to what the live SignalEngine will eventually run.
 *
 * Method
 * ------
 * Universe: 40 liquid S&P large-cap names across all 11 GICS sectors, plus SPY
 * as the buy-and-hold benchmark. Daily OHLCV is pulled from Yahoo (cached on
 * disk by `loadOrFetchDailyBars`).
 *
 * Walk-forward: for every symbol and every bar `t` with ≥ 250 prior bars we
 * call `evaluateSma200(symbol, candles.slice(0, t + 1))`. A fired Signal-2
 * (`sma200_pullback`) or Signal-3 (`sma200_reclaim`) opens a simulated long at
 * that bar's close. The spec's 5-bar per-symbol-per-type debounce is enforced.
 *
 * Trade model (deterministic, long-only, R-multiple accounting):
 *   - Risk unit  R_price = entry − stop  (stop is the signal's suggested stop).
 *   - Stop:   bar.low ≤ stop  → exit at stop (or at the open on a gap-down).
 *   - Target: bar.high ≥ entry + TP·R_price → exit at target.
 *   - If a single bar tags both, the stop is assumed first (conservative).
 *   - Time stop: no exit within `maxHold` bars → exit at that bar's close.
 *   - Round-trip slippage of 10 bps is charged against every trade.
 * Trade outcome is reported in R: R = (exit − entry) / R_price − slippage.
 *
 * Risk-adjusted comparison: closed trades are sized at 1% account risk per
 * trade and compounded in exit-date order into an equity curve (a conservative
 * single-slot approximation — parallel deployment of capital is NOT credited).
 * From that curve we take CAGR and max drawdown and form the MAR ratio
 * (CAGR / |maxDD|). The signal "beats buy-and-hold risk-adjusted" when its MAR
 * exceeds SPY's MAR over the identical calendar window.
 *
 * Ship gate (TRA-449 spec): profit factor > 1.3 AND beats B&H risk-adjusted.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra455-validation.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { evaluateSma200, SMA200_DEBOUNCE_BARS, type Sma200SignalKind } from '@trading-app/engine';
import { loadOrFetchDailyBars } from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

// ---- Window ---------------------------------------------------------------
// Fetch from 2020-09-01 so the 200-SMA + 250-bar minimum is warm well before
// the test window opens. Signals are only COUNTED from TEST_START onward, so
// the measured sample is a clean ≥ 3-year out-of-warmup span.
const FETCH_START_MS = Date.UTC(2020, 8, 1); // 2020-09-01
const TEST_START_MS = Date.UTC(2022, 0, 1); // 2022-01-01 — first counted fire
const TO_MS = Date.UTC(2026, 4, 18); // 2026-05-18 — today

// ---- Trade model ----------------------------------------------------------
const TP_PRIMARY = 2.5; // headline take-profit, in R
const TP_SENSITIVITY = [2.0, 2.5, 3.0]; // robustness sweep
const MAX_HOLD_BARS = 50; // ~10 trading weeks time stop
const SLIPPAGE_BPS = 10; // round-trip, charged in R terms
const RISK_PER_TRADE = 0.01; // 1% account risk per trade for the equity curve

// ---- Universe — 40 liquid S&P large caps, all 11 GICS sectors -------------
const UNIVERSE = [
  // Information Technology
  'AAPL', 'MSFT', 'NVDA', 'AVGO', 'CRM', 'ADBE', 'AMD', 'CSCO', 'ORCL', 'TXN',
  // Communication Services
  'GOOGL', 'META', 'NFLX', 'DIS', 'TMUS',
  // Consumer Discretionary
  'AMZN', 'TSLA', 'HD', 'MCD', 'NKE',
  // Consumer Staples
  'PG', 'KO', 'PEP', 'COST', 'WMT',
  // Financials
  'JPM', 'V', 'MA', 'BAC', 'GS',
  // Health Care
  'UNH', 'LLY', 'ABBV', 'MRK', 'TMO',
  // Energy / Industrials / Materials / Utilities / Real Estate
  'XOM', 'CVX', 'CAT', 'GE', 'NEE',
];
const BENCHMARK = 'SPY';

interface Trade {
  symbol: string;
  kind: Sma200SignalKind;
  entryIdx: number;
  entryTs: number;
  exitTs: number;
  entry: number;
  stop: number;
  rPrice: number;
  exitPrice: number;
  rMultiple: number; // net of slippage
  exitReason: 'stop' | 'target' | 'time' | 'eod';
  bars: number;
}

/**
 * Simulate one long trade forward from `entryIdx` using the stop/target/time
 * exit model. `tp` is the take-profit in R.
 */
function simulateTrade(
  candles: Candle[],
  entryIdx: number,
  kind: Sma200SignalKind,
  entry: number,
  stop: number,
  tp: number,
): Trade {
  const rPrice = entry - stop;
  const target = entry + tp * rPrice;
  const slipR = (SLIPPAGE_BPS / 10_000) * entry / rPrice;
  let exitPrice = entry;
  let exitIdx = entryIdx;
  let exitReason: Trade['exitReason'] = 'eod';

  for (let i = entryIdx + 1; i < candles.length && i <= entryIdx + MAX_HOLD_BARS; i++) {
    const bar = candles[i];
    exitIdx = i;
    // Gap handling on the open.
    if (bar.open <= stop) { exitPrice = bar.open; exitReason = 'stop'; break; }
    if (bar.open >= target) { exitPrice = bar.open; exitReason = 'target'; break; }
    // Intrabar — stop assumed first when a bar tags both levels.
    if (bar.low <= stop) { exitPrice = stop; exitReason = 'stop'; break; }
    if (bar.high >= target) { exitPrice = target; exitReason = 'target'; break; }
    if (i === entryIdx + MAX_HOLD_BARS) { exitPrice = bar.close; exitReason = 'time'; break; }
  }
  if (exitReason === 'eod') {
    exitPrice = candles[exitIdx].close; // ran off the end of the data
  }
  const grossR = (exitPrice - entry) / rPrice;
  return {
    symbol: candles[entryIdx].symbol,
    kind,
    entryIdx,
    entryTs: candles[entryIdx].timestamp,
    exitTs: candles[exitIdx].timestamp,
    entry,
    stop,
    rPrice,
    exitPrice,
    rMultiple: grossR - slipR,
    exitReason,
    bars: exitIdx - entryIdx,
  };
}

/** Walk one symbol forward, collecting every fired Signal-2 / Signal-3 trade. */
function collectTrades(candles: Candle[], tp: number): Trade[] {
  const trades: Trade[] = [];
  const lastFire: Record<string, number> = {};
  for (let t = 249; t < candles.length; t++) {
    if (candles[t].timestamp < TEST_START_MS) continue;
    const evaln = evaluateSma200(candles[t].symbol, candles.slice(0, t + 1));
    for (const sig of evaln.signals) {
      const key = `${sig.symbol}:${sig.kind}`;
      const prev = lastFire[key];
      if (prev !== undefined && t - prev < SMA200_DEBOUNCE_BARS) continue; // spec debounce
      lastFire[key] = t;
      if (sig.entry <= sig.stop) continue; // degenerate — skip (cannot happen for longs)
      trades.push(simulateTrade(candles, t, sig.kind, sig.entry, sig.stop, tp));
    }
  }
  return trades;
}

interface SignalMetrics {
  trades: number;
  wins: number;
  winRatePct: number;
  avgR: number;
  profitFactor: number;
  expectancyR: number;
  cagrPct: number;
  maxDrawdownPct: number;
  mar: number;
  exposureDays: number;
}

/** Per-trade + equity-curve metrics for a set of closed trades. */
function metricsOf(trades: Trade[], years: number): SignalMetrics {
  const n = trades.length;
  const rs = trades.map((t) => t.rMultiple);
  const wins = rs.filter((r) => r > 0);
  const grossWin = wins.reduce((s, r) => s + r, 0);
  const grossLoss = rs.filter((r) => r <= 0).reduce((s, r) => s + Math.abs(r), 0);
  const avgR = n > 0 ? rs.reduce((s, r) => s + r, 0) / n : 0;

  // Equity curve: 1% risk per trade, compounded in exit-date order.
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
  const exposureDays = trades.reduce((s, t) => s + t.bars, 0);

  return {
    trades: n,
    wins: wins.length,
    winRatePct: n > 0 ? (wins.length / n) * 100 : 0,
    avgR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancyR: avgR,
    cagrPct: cagr * 100,
    maxDrawdownPct: maxDD * 100,
    mar: maxDD > 0 ? cagr / maxDD : Infinity,
    exposureDays,
  };
}

interface BuyHold {
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  mar: number;
}

/** Buy-and-hold metrics over [TEST_START_MS, TO_MS] for a daily series. */
function buyHold(candles: Candle[], years: number): BuyHold {
  const win = candles.filter((c) => c.timestamp >= TEST_START_MS && c.timestamp <= TO_MS);
  if (win.length < 2) return { totalReturnPct: 0, cagrPct: 0, maxDrawdownPct: 0, sharpe: 0, mar: 0 };
  const first = win[0].close;
  const last = win[win.length - 1].close;
  const totalReturn = last / first - 1;
  const cagr = Math.pow(last / first, 1 / years) - 1;
  let peak = win[0].close;
  let maxDD = 0;
  const rets: number[] = [];
  for (let i = 0; i < win.length; i++) {
    if (win[i].close > peak) peak = win[i].close;
    const dd = (peak - win[i].close) / peak;
    if (dd > maxDD) maxDD = dd;
    if (i > 0) rets.push(win[i].close / win[i - 1].close - 1);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const std = Math.sqrt(variance);
  return {
    totalReturnPct: totalReturn * 100,
    cagrPct: cagr * 100,
    maxDrawdownPct: maxDD * 100,
    sharpe: std > 0 ? (mean / std) * Math.sqrt(252) : 0,
    mar: maxDD > 0 ? cagr / maxDD : Infinity,
  };
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '∞';
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  console.log('TRA-455 — SMA-200 pullback/reclaim backtest acceptance gate\n');

  // ---- Load data ----------------------------------------------------------
  const bars: Record<string, Candle[]> = {};
  for (const sym of [...UNIVERSE, BENCHMARK]) {
    const c = await loadOrFetchDailyBars(sym, FETCH_START_MS, TO_MS);
    bars[sym] = c;
    process.stdout.write(`  ${sym}: ${c.length} bars  `);
  }
  console.log('\n');

  const spy = bars[BENCHMARK];
  const years = (TO_MS - TEST_START_MS) / (365.25 * 864e5);
  console.log(`Test window: 2022-01-01 → 2026-05-18  (${years.toFixed(2)} years)\n`);

  // ---- Collect trades at the primary TP ----------------------------------
  const allTrades: Trade[] = [];
  for (const sym of UNIVERSE) allTrades.push(...collectTrades(bars[sym], TP_PRIMARY));

  const pullback = allTrades.filter((t) => t.kind === 'sma200_pullback');
  const reclaim = allTrades.filter((t) => t.kind === 'sma200_reclaim');

  const mPull = metricsOf(pullback, years);
  const mRecl = metricsOf(reclaim, years);
  const mAll = metricsOf(allTrades, years);

  // ---- Benchmarks ---------------------------------------------------------
  const spyBH = buyHold(spy, years);
  // Equal-weight universe buy-and-hold (average member total return).
  const memberReturns = UNIVERSE.map((s) => buyHold(bars[s], years));
  const ewTotalReturn =
    memberReturns.reduce((s, m) => s + m.totalReturnPct, 0) / memberReturns.length;
  const ewMaxDD = memberReturns.reduce((s, m) => s + m.maxDrawdownPct, 0) / memberReturns.length;
  const ewCagr = (Math.pow(1 + ewTotalReturn / 100, 1 / years) - 1) * 100;
  const ewMar = ewMaxDD > 0 ? ewCagr / ewMaxDD : Infinity;

  // ---- TP sensitivity sweep ----------------------------------------------
  const sweep = TP_SENSITIVITY.map((tp) => {
    const tps: Trade[] = [];
    for (const sym of UNIVERSE) tps.push(...collectTrades(bars[sym], tp));
    return {
      tp,
      pullback: metricsOf(tps.filter((t) => t.kind === 'sma200_pullback'), years),
      reclaim: metricsOf(tps.filter((t) => t.kind === 'sma200_reclaim'), years),
    };
  });

  // ---- Verdicts -----------------------------------------------------------
  const verdict = (m: SignalMetrics) => {
    const pfOk = m.profitFactor > 1.3;
    const riskOk = m.mar > spyBH.mar;
    return { pfOk, riskOk, pass: pfOk && riskOk };
  };
  const vPull = verdict(mPull);
  const vRecl = verdict(mRecl);

  // ---- Console report -----------------------------------------------------
  const line = (label: string, m: SignalMetrics) =>
    `  ${label.padEnd(22)} n=${String(m.trades).padStart(3)}  win=${fmt(m.winRatePct, 1)}%  ` +
    `avgR=${fmt(m.avgR)}  PF=${fmt(m.profitFactor)}  CAGR=${fmt(m.cagrPct, 1)}%  ` +
    `maxDD=${fmt(m.maxDrawdownPct, 1)}%  MAR=${fmt(m.mar)}`;

  console.log('Per-signal results (primary TP = 2.5R, 1R stop, 50-bar time stop):');
  console.log(line('Signal 2 pullback', mPull));
  console.log(line('Signal 3 reclaim', mRecl));
  console.log(line('Combined book', mAll));
  console.log('');
  console.log('Buy-and-hold benchmarks (2022-01-01 → 2026-05-18):');
  console.log(
    `  SPY                    totalRet=${fmt(spyBH.totalReturnPct, 1)}%  CAGR=${fmt(spyBH.cagrPct, 1)}%  ` +
      `maxDD=${fmt(spyBH.maxDrawdownPct, 1)}%  Sharpe=${fmt(spyBH.sharpe)}  MAR=${fmt(spyBH.mar)}`,
  );
  console.log(
    `  Universe (equal-wt)    totalRet=${fmt(ewTotalReturn, 1)}%  CAGR=${fmt(ewCagr, 1)}%  ` +
      `maxDD=${fmt(ewMaxDD, 1)}%  MAR=${fmt(ewMar)}`,
  );
  console.log('');
  console.log('TP sensitivity sweep:');
  for (const s of sweep) {
    console.log(
      `  TP=${s.tp}R  pullback: PF=${fmt(s.pullback.profitFactor)} win=${fmt(s.pullback.winRatePct, 1)}% MAR=${fmt(s.pullback.mar)}` +
        `  |  reclaim: PF=${fmt(s.reclaim.profitFactor)} win=${fmt(s.reclaim.winRatePct, 1)}% MAR=${fmt(s.reclaim.mar)}`,
    );
  }
  console.log('');
  console.log('SHIP GATE  (PF > 1.3  AND  MAR > SPY MAR):');
  console.log(
    `  Signal 2 pullback: PF ${vPull.pfOk ? 'PASS' : 'FAIL'}  risk-adj ${vPull.riskOk ? 'PASS' : 'FAIL'}  ` +
      `→ ${vPull.pass ? 'PASS ✅' : 'FAIL ❌'}`,
  );
  console.log(
    `  Signal 3 reclaim:  PF ${vRecl.pfOk ? 'PASS' : 'FAIL'}  risk-adj ${vRecl.riskOk ? 'PASS' : 'FAIL'}  ` +
      `→ ${vRecl.pass ? 'PASS ✅' : 'FAIL ❌'}`,
  );

  // ---- Persist JSON -------------------------------------------------------
  const out = {
    issue: 'TRA-455',
    generatedAt: new Date().toISOString(),
    window: { testStart: '2022-01-01', testEnd: '2026-05-18', years: Number(years.toFixed(2)) },
    universe: UNIVERSE,
    tradeModel: {
      takeProfitR: TP_PRIMARY,
      stopR: 1,
      maxHoldBars: MAX_HOLD_BARS,
      slippageBps: SLIPPAGE_BPS,
      riskPerTrade: RISK_PER_TRADE,
      stopFirstOnAmbiguousBar: true,
    },
    signals: {
      sma200_pullback: mPull,
      sma200_reclaim: mRecl,
      combined: mAll,
    },
    benchmarks: {
      spy: spyBH,
      universeEqualWeight: { totalReturnPct: ewTotalReturn, cagrPct: ewCagr, maxDrawdownPct: ewMaxDD, mar: ewMar },
    },
    sensitivity: sweep,
    shipGate: {
      criteria: 'profit factor > 1.3 AND MAR > SPY MAR',
      sma200_pullback: vPull,
      sma200_reclaim: vRecl,
    },
    tradeLedger: allTrades,
  };
  const path = resolve(REPORT_DIR, 'tra455-validation.json');
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nReport written: ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
