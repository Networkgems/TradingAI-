/**
 * Equity backtesting script (TRA-169) — runs all 6 strategies on SPY / QQQ /
 * AAPL with realistic fill modeling. Mirrors `backtest-crypto.ts` so the two
 * outputs can be compared side-by-side.
 *
 * Data: 1-minute bars from Twelve Data, last 30 days. The free tier caps a
 * single call at 5,000 bars (~12.8 trading days), so we paginate by date range
 * and stitch the chunks together. Set `TWELVE_DATA_API_KEY` in the environment;
 * the script exits with a clear message if the key is missing.
 *
 * Cost model: 5 bps slippage, 0 bps commission (equity brokers like Webull /
 * IBKR Lite are commission-free; slippage alone captures the realistic drag).
 *
 * Usage:
 *   TWELVE_DATA_API_KEY=… node --import tsx/esm packages/server/src/backtest-equity.ts
 */

import type { Candle } from '@trading-app/shared';
import { BacktestRunner } from '@trading-app/backtest';
import type { BacktestConfig } from '@trading-app/backtest';

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY ?? '';
const TWELVE_DATA_BASE = 'https://api.twelvedata.com';
const SYMBOLS = ['SPY', 'QQQ', 'AAPL'];
const INITIAL_EQUITY = 100_000;
const DAYS = 30;
const SLIPPAGE_BPS = 5;
const COMMISSION_BPS = 0;
/**
 * Max bars per Twelve Data call on the free tier. We paginate in this size
 * stepped backwards from "now" until we cover the requested window.
 */
const TWELVE_DATA_PAGE_SIZE = 5000;
/** Approx US-equity 1-min bars per session, used to size the pagination step. */
const BARS_PER_SESSION = 390;

interface TwelveDataValue {
  datetime?: string;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: string;
}

interface TwelveDataResponse {
  values?: TwelveDataValue[];
  status?: string;
  code?: number;
  message?: string;
}

function formatYmdHms(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

async function fetchPage(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const url =
    `${TWELVE_DATA_BASE}/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1min&outputsize=${TWELVE_DATA_PAGE_SIZE}` +
    `&start_date=${encodeURIComponent(formatYmdHms(new Date(fromMs)))}` +
    `&end_date=${encodeURIComponent(formatYmdHms(new Date(toMs)))}` +
    `&timezone=UTC&apikey=${TWELVE_DATA_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Twelve Data HTTP ${resp.status} for ${symbol}: ${body.slice(0, 200)}`);
  }
  const json = (await resp.json()) as TwelveDataResponse;
  if (json && json.status === 'error') {
    throw new Error(`Twelve Data error for ${symbol}: code=${json.code} ${json.message ?? ''}`);
  }
  const values = json.values ?? [];
  const candles: Candle[] = [];
  for (const row of values) {
    if (!row.datetime) continue;
    const norm = row.datetime.includes('T') ? row.datetime : row.datetime.replace(' ', 'T') + 'Z';
    const ts = new Date(norm).getTime();
    if (!Number.isFinite(ts)) continue;
    const o = row.open != null ? Number(row.open) : NaN;
    const h = row.high != null ? Number(row.high) : NaN;
    const l = row.low != null ? Number(row.low) : NaN;
    const c = row.close != null ? Number(row.close) : NaN;
    const v = row.volume != null ? Number(row.volume) : 0;
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    candles.push({
      symbol,
      timestamp: ts,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: Number.isFinite(v) ? v : 0,
    });
  }
  return candles;
}

async function fetchHistoricalCandles(symbol: string, days: number): Promise<Candle[]> {
  // Pagination: walk the window backwards in `pageDays`-sized slices that
  // comfortably fit under the 5,000-bar page size (12 trading days × ~390
  // bars/session ≈ 4,680).
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  const pageDays = Math.max(1, Math.floor(TWELVE_DATA_PAGE_SIZE / BARS_PER_SESSION) - 1);
  const pageMs = pageDays * 24 * 60 * 60 * 1000;

  const seen = new Set<number>();
  const all: Candle[] = [];
  let cursor = now;
  while (cursor > start) {
    const pageStart = Math.max(start, cursor - pageMs);
    const page = await fetchPage(symbol, pageStart, cursor);
    let added = 0;
    for (const c of page) {
      if (c.timestamp < start || c.timestamp > now) continue;
      if (seen.has(c.timestamp)) continue;
      seen.add(c.timestamp);
      all.push(c);
      added += 1;
    }
    // Even if a slice returns 0 bars (e.g. a weekend window), still advance the
    // cursor so we don't loop forever.
    if (added === 0 && pageStart === start) break;
    cursor = pageStart;
    // Twelve Data free tier is 8 req/min — ~120 ms between calls is overkill
    // for safety but keeps this script behaving for shared keys.
    await new Promise(r => setTimeout(r, 120));
  }
  all.sort((a, b) => a.timestamp - b.timestamp);
  return all;
}

interface StrategyResult {
  symbol: string;
  strategy: string;
  trades: number;
  ambiguous: number;
  winRate: number;
  avgRR: number;
  totalPnl: number;
  worstCasePnl: number;
  returnPct: number;
}

async function runBacktest(
  symbol: string,
  candles: Candle[],
  strategyType: BacktestConfig['strategyType'],
  label: string,
  opts: Partial<BacktestConfig> = {},
): Promise<StrategyResult> {
  if (candles.length === 0) {
    return {
      symbol,
      strategy: label,
      trades: 0,
      ambiguous: 0,
      winRate: 0,
      avgRR: 0,
      totalPnl: 0,
      worstCasePnl: 0,
      returnPct: 0,
    };
  }
  const runner = new BacktestRunner();
  const config: BacktestConfig = {
    symbol,
    startDate: candles[0].timestamp,
    endDate: candles[candles.length - 1].timestamp,
    initialEquity: INITIAL_EQUITY,
    strategyType,
    commissionBps: COMMISSION_BPS,
    slippageBps: SLIPPAGE_BPS,
    ...opts,
  };
  const result = await runner.run(config, candles);
  return {
    symbol,
    strategy: label,
    trades: result.trades.length,
    ambiguous: result.ambiguousTrades,
    winRate: result.winRate,
    avgRR: result.avgRiskReward,
    totalPnl: result.totalPnl,
    worstCasePnl: result.worstCaseTotalPnl,
    returnPct: (result.totalPnl / INITIAL_EQUITY) * 100,
  };
}

function printTable(results: StrategyResult[]) {
  console.log('\n' + '='.repeat(116));
  console.log(
    `EQUITY BACKTEST — ${DAYS} Days, 1m Candles, $${INITIAL_EQUITY.toLocaleString()} Initial Equity ` +
      `(slippage=${SLIPPAGE_BPS}bps, commission=${COMMISSION_BPS}bps)`,
  );
  console.log('='.repeat(116));
  console.log(
    'Symbol'.padEnd(10) +
      'Strategy'.padEnd(22) +
      'Trades'.padStart(8) +
      'Ambig'.padStart(7) +
      'Win Rate'.padStart(11) +
      'Avg R:R'.padStart(10) +
      'Total PnL'.padStart(14) +
      'Worst PnL'.padStart(14) +
      'Return %'.padStart(11),
  );
  console.log('-'.repeat(116));
  for (const r of results) {
    console.log(
      r.symbol.padEnd(10) +
        r.strategy.padEnd(22) +
        String(r.trades).padStart(8) +
        String(r.ambiguous).padStart(7) +
        ((r.winRate * 100).toFixed(1) + '%').padStart(11) +
        r.avgRR.toFixed(2).padStart(10) +
        ('$' + r.totalPnl.toFixed(2)).padStart(14) +
        ('$' + r.worstCasePnl.toFixed(2)).padStart(14) +
        (r.returnPct.toFixed(2) + '%').padStart(11),
    );
  }
  console.log('='.repeat(116));
}

async function main() {
  if (!TWELVE_DATA_API_KEY) {
    console.error('TWELVE_DATA_API_KEY is not set. Set it in the environment and retry.');
    process.exit(2);
  }

  console.log(`Fetching ${DAYS}-day 1m bars from Twelve Data for: ${SYMBOLS.join(', ')}...`);
  const candleMap = new Map<string, Candle[]>();
  for (const sym of SYMBOLS) {
    process.stdout.write(`  ${sym}... `);
    try {
      const candles = await fetchHistoricalCandles(sym, DAYS);
      candleMap.set(sym, candles);
      console.log(`${candles.length} bars`);
    } catch (err) {
      console.log(`failed: ${err instanceof Error ? err.message : String(err)}`);
      candleMap.set(sym, []);
    }
  }

  const results: StrategyResult[] = [];
  for (const sym of SYMBOLS) {
    const candles = candleMap.get(sym) ?? [];
    // All 6 strategies run with default ET equity time filters and session
    // anchor — no overrides needed for stocks.
    results.push(await runBacktest(sym, candles, 'orb', 'ORB'));
    results.push(await runBacktest(sym, candles, 'reversal', 'Reversal'));
    results.push(await runBacktest(sym, candles, 'macd_bollinger', 'MACD-Bollinger'));
    results.push(await runBacktest(sym, candles, 'ichimoku', 'Ichimoku'));
    results.push(await runBacktest(sym, candles, 'scalping', 'Scalping'));
    results.push(await runBacktest(sym, candles, 'swing', 'Swing'));
  }
  printTable(results);

  const strategies = [...new Set(results.map(r => r.strategy))];
  console.log('\nAGGREGATE BY STRATEGY (avg across SPY/QQQ/AAPL)');
  console.log('-'.repeat(96));
  for (const strat of strategies) {
    const group = results.filter(r => r.strategy === strat);
    const avgWin = group.reduce((s, r) => s + r.winRate, 0) / group.length;
    const avgRet = group.reduce((s, r) => s + r.returnPct, 0) / group.length;
    const totalTrades = group.reduce((s, r) => s + r.trades, 0);
    const totalAmbig = group.reduce((s, r) => s + r.ambiguous, 0);
    const avgRR = group.reduce((s, r) => s + r.avgRR, 0) / group.length;
    console.log(
      `  ${strat.padEnd(20)}  trades=${totalTrades}  ambig=${totalAmbig}  ` +
        `winRate=${(avgWin * 100).toFixed(1)}%  avgRR=${avgRR.toFixed(2)}  return=${avgRet.toFixed(2)}%`,
    );
  }
  console.log();

  const output = { timestamp: new Date().toISOString(), results };
  console.log('\nJSON_RESULTS_START');
  console.log(JSON.stringify(output));
  console.log('JSON_RESULTS_END');
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
