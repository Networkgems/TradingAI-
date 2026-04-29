/**
 * TRA-181 reversal-retest knob sweep + walk-forward stability check.
 *
 * Goal: find a retest-entry config that clears
 *   • combined N >= 30 trades across the 7-symbol crypto sample
 *   • trade-level avgRR >= 0
 *   • cost-adjusted return >= 0% (TRA-169 model: 40 bps + 5 bps)
 *   • walk-forward stability — OOS avgRR within 0.5R of in-sample
 *
 * Strategy: a coordinate-descent sweep over five knobs, all anchored at the
 * TRA-179 defaults except the swept axis. This keeps the run tractable
 * (≈ 17 configs × 7 symbols on 365 d × 1 h candles) while still surfacing
 * which knob is doing the work. The best per-axis values are then combined
 * into a "best-of-axes" config that is reported alongside the per-axis winners
 * and re-evaluated on a 180-day train / 185-day test split for stability.
 *
 * Run:
 *   node --import tsx/esm packages/server/src/backtest-retest-sweep.ts
 *
 * Output:
 *   • Console table of every swept config (sorted by avgRR among N>=30 rows).
 *   • Per-symbol breakdown for the chosen config.
 *   • Walk-forward IS/OOS comparison.
 *   • JSON tail bracketed by JSON_RESULTS_START / JSON_RESULTS_END.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YahooFinance from 'yahoo-finance2';
import { type Candle, type Position } from '@trading-app/shared';
import { BacktestRunner } from '@trading-app/backtest';
import type { BacktestConfig, BacktestReversalOpts } from '@trading-app/backtest';
import { COMMISSION_BPS, SLIPPAGE_BPS } from './backtest-crypto.js';

const yf = new YahooFinance({ validation: { logErrors: false } });

// MATIC-USD returns 0 bars after the Polygon→POL rebrand; drop it.
const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'AVAX-USD', 'LINK-USD'];
const DAYS = Number(process.env.SWEEP_DAYS ?? 365);
const INITIAL_EQUITY = 100_000;

// Use console.error (line-buffered to stderr) for progress so the parent
// process sees each tick promptly. console.log to stdout is block-buffered
// when stdout is redirected to a file, which made the first run look hung.
const log = (msg: string): void => { console.error(msg); };

/** Default knob anchors — each axis sweep holds the others at these. */
const BASELINE: Required<Pick<BacktestReversalOpts,
  'retestRewardMultiple' | 'retestTolerancePct' | 'retestStopBufferFrac' | 'retestRequireVolumeIncrease' | 'retestExpiryBars'
>> = {
  retestRewardMultiple: 3,
  retestTolerancePct: 0,
  retestStopBufferFrac: 0.25,
  retestRequireVolumeIncrease: false,
  retestExpiryBars: 16,
};

interface KnobConfig {
  label: string;
  retestRewardMultiple: number;
  retestTolerancePct: number;
  retestStopBufferFrac: number;
  retestRequireVolumeIncrease: boolean;
  retestExpiryBars: number;
}

function configToOpts(c: KnobConfig): BacktestReversalOpts {
  return {
    rsiOverbought: 60,
    rsiOversold: 40,
    enforceTimeFilter: false,
    retestEntry: true,
    retestRewardMultiple: c.retestRewardMultiple,
    retestTolerancePct: c.retestTolerancePct,
    retestStopBufferFrac: c.retestStopBufferFrac,
    retestRequireVolumeIncrease: c.retestRequireVolumeIncrease,
    retestExpiryBars: c.retestExpiryBars,
  };
}

function configFrom(overrides: Partial<KnobConfig>, label: string): KnobConfig {
  return {
    label,
    retestRewardMultiple: overrides.retestRewardMultiple ?? BASELINE.retestRewardMultiple,
    retestTolerancePct: overrides.retestTolerancePct ?? BASELINE.retestTolerancePct,
    retestStopBufferFrac: overrides.retestStopBufferFrac ?? BASELINE.retestStopBufferFrac,
    retestRequireVolumeIncrease: overrides.retestRequireVolumeIncrease ?? BASELINE.retestRequireVolumeIncrease,
    retestExpiryBars: overrides.retestExpiryBars ?? BASELINE.retestExpiryBars,
  };
}

/** Build the axis-sweep grid: every value on each axis, others at baseline. */
function buildAxisGrid(): KnobConfig[] {
  const grid: KnobConfig[] = [];
  // Baseline first so the table has a clear anchor row.
  grid.push(configFrom({}, 'baseline (TRA-179 defaults)'));

  for (const v of [2, 3, 4, 5]) {
    if (v === BASELINE.retestRewardMultiple) continue;
    grid.push(configFrom({ retestRewardMultiple: v }, `reward=${v}`));
  }
  for (const v of [0, 0.10]) {
    if (v === BASELINE.retestTolerancePct) continue;
    grid.push(configFrom({ retestTolerancePct: v }, `tolerance=${v}`));
  }
  for (const v of [0.05, 0.10, 0.25, 0.50]) {
    if (v === BASELINE.retestStopBufferFrac) continue;
    grid.push(configFrom({ retestStopBufferFrac: v }, `buffer=${v}`));
  }
  for (const v of [false, true]) {
    if (v === BASELINE.retestRequireVolumeIncrease) continue;
    grid.push(configFrom({ retestRequireVolumeIncrease: v }, `volGate=${v}`));
  }
  for (const v of [8, 16, 24, 32]) {
    if (v === BASELINE.retestExpiryBars) continue;
    grid.push(configFrom({ retestExpiryBars: v }, `expiry=${v}`));
  }
  return grid;
}

interface AggResult {
  label: string;
  config: KnobConfig;
  trades: number;
  winRate: number;
  avgRR: number;
  totalPnl: number;
  returnPct: number;
  perSymbol: Map<string, { trades: number; avgRR: number; pnl: number }>;
}

// Candle cache: avoids re-hitting Yahoo on every sweep iteration during
// development. Cache key is symbol+days; entries expire after 24 h so live
// data gradually refreshes.
const CACHE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.cache');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cachePath(symbol: string, days: number): string {
  return resolve(CACHE_DIR, `${symbol}-${days}d-1h.json`);
}

function readCache(symbol: string, days: number): Candle[] | null {
  const p = cachePath(symbol, days);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { fetchedAt: number; candles: Candle[] };
    if (Date.now() - raw.fetchedAt > CACHE_TTL_MS) return null;
    return raw.candles;
  } catch { return null; }
}

function writeCache(symbol: string, days: number, candles: Candle[]): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(symbol, days), JSON.stringify({ fetchedAt: Date.now(), candles }));
}

async function fetchCandles(symbol: string, days: number): Promise<Candle[]> {
  const cached = readCache(symbol, days);
  if (cached) return cached;
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  try {
    const result = await yf.chart(symbol, { period1: from, period2: now, interval: '1h' });
    const quotes = result.quotes ?? [];
    const candles = quotes
      .filter(q => q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
      .map(q => ({
        symbol,
        timestamp: new Date(q.date).getTime(),
        open: q.open!,
        high: q.high!,
        low: q.low!,
        close: q.close!,
        volume: q.volume!,
      }));
    if (candles.length > 0) writeCache(symbol, days, candles);
    return candles;
  } catch (err) {
    console.error(`Failed to fetch ${symbol}:`, err);
    return [];
  }
}

/** Per-trade R:R = pnl / (risk * qty), aligned with BacktestRunner.avgRiskReward. */
function tradeRR(t: Position): number {
  const risk = Math.abs(t.entryPrice - t.stopLoss) * t.quantity;
  return risk > 0 ? (t.pnl ?? 0) / risk : 0;
}

async function runConfigOnSymbols(
  candleMap: Map<string, Candle[]>,
  cfg: KnobConfig,
): Promise<AggResult> {
  const runner = new BacktestRunner();
  const allTrades: Position[] = [];
  const perSymbol = new Map<string, { trades: number; avgRR: number; pnl: number }>();

  for (const [sym, candles] of candleMap) {
    if (candles.length === 0) {
      perSymbol.set(sym, { trades: 0, avgRR: 0, pnl: 0 });
      continue;
    }
    const config: BacktestConfig = {
      symbol: sym,
      startDate: candles[0].timestamp,
      endDate: candles[candles.length - 1].timestamp,
      initialEquity: INITIAL_EQUITY,
      strategyType: 'reversal',
      reversalOpts: configToOpts(cfg),
      commissionBps: COMMISSION_BPS,
      slippageBps: SLIPPAGE_BPS,
    };
    const r = await runner.run(config, candles);
    allTrades.push(...r.trades);
    perSymbol.set(sym, {
      trades: r.totalTrades,
      avgRR: r.avgRiskReward,
      pnl: r.totalPnl,
    });
  }

  const trades = allTrades.length;
  const winners = allTrades.filter(t => (t.pnl ?? 0) > 0).length;
  const winRate = trades > 0 ? winners / trades : 0;
  const totalPnl = allTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const avgRR = trades > 0 ? allTrades.reduce((s, t) => s + tradeRR(t), 0) / trades : 0;
  // Returns are computed per-symbol equity curves elsewhere; this is a
  // book-PnL-divided-by-aggregate-equity proxy that still ranks consistently.
  const returnPct = (totalPnl / (INITIAL_EQUITY * candleMap.size)) * 100;

  return { label: cfg.label, config: cfg, trades, winRate, avgRR, totalPnl, returnPct, perSymbol };
}

function printRanked(rows: AggResult[]) {
  const sorted = [...rows].sort((a, b) => {
    const aPasses = a.trades >= 30 ? 1 : 0;
    const bPasses = b.trades >= 30 ? 1 : 0;
    if (aPasses !== bPasses) return bPasses - aPasses;
    return b.avgRR - a.avgRR;
  });
  log('\n' + '='.repeat(110));
  log(`TRA-181 RETEST SWEEP — ${DAYS}d × 1h × ${SYMBOLS.length} crypto symbols, costs ON (40 bps + 5 bps)`);
  log('='.repeat(110));
  log(
    'Config'.padEnd(36) +
    'Trades'.padStart(8) +
    'Win%'.padStart(8) +
    'AvgRR'.padStart(10) +
    'Return%'.padStart(10) +
    'TotalPnL'.padStart(14),
  );
  log('-'.repeat(110));
  for (const r of sorted) {
    const flag = r.trades >= 30 ? '' : '  (N<30)';
    log(
      (r.label + flag).padEnd(36) +
      r.trades.toString().padStart(8) +
      (r.winRate * 100).toFixed(1).padStart(8) +
      r.avgRR.toFixed(3).padStart(10) +
      r.returnPct.toFixed(2).padStart(10) +
      ('$' + r.totalPnl.toFixed(0)).padStart(14),
    );
  }
  log('='.repeat(110));
}

function printPerSymbol(r: AggResult) {
  log(`\nPer-symbol breakdown for [${r.label}]:`);
  log('-'.repeat(60));
  log('Symbol'.padEnd(12) + 'Trades'.padStart(8) + 'AvgRR'.padStart(10) + 'PnL'.padStart(14));
  for (const [sym, s] of r.perSymbol) {
    log(sym.padEnd(12) + s.trades.toString().padStart(8) + s.avgRR.toFixed(3).padStart(10) + ('$' + s.pnl.toFixed(0)).padStart(14));
  }
}

/** Single-split walk-forward: first half train, second half test. */
async function walkForward(
  candleMap: Map<string, Candle[]>,
  cfg: KnobConfig,
): Promise<{ is: AggResult; oos: AggResult }> {
  const trainMap = new Map<string, Candle[]>();
  const testMap = new Map<string, Candle[]>();
  for (const [sym, candles] of candleMap) {
    const mid = Math.floor(candles.length / 2);
    trainMap.set(sym, candles.slice(0, mid));
    testMap.set(sym, candles.slice(mid));
  }
  const is = await runConfigOnSymbols(trainMap, { ...cfg, label: cfg.label + ' [IS]' });
  const oos = await runConfigOnSymbols(testMap, { ...cfg, label: cfg.label + ' [OOS]' });
  return { is, oos };
}

/**
 * Combine the best per-axis values into a single config. Each axis's best is
 * the row with the highest avgRR (subject to N>=30 if any such row exists,
 * otherwise the highest avgRR overall — diagnostic, even if not acceptance-
 * passing).
 */
function bestOfAxes(rows: AggResult[]): KnobConfig {
  const pickAxis = <T,>(predicate: (r: AggResult) => T | null): T | null => {
    const candidates = rows
      .map(predicate)
      .filter((v): v is T => v !== null);
    return candidates.length > 0 ? candidates[0] : null;
  };

  const bestForKey = <K extends keyof KnobConfig>(key: K): KnobConfig[K] => {
    const sorted = [...rows].sort((a, b) => b.avgRR - a.avgRR);
    const passing = sorted.filter(r => r.trades >= 30);
    const pool = passing.length > 0 ? passing : sorted;
    return pool[0].config[key];
  };

  // Per-axis best — only consider configs that *moved* this axis off baseline
  // (the baseline row is in `rows` and would otherwise always win).
  const perAxis = (key: keyof KnobConfig, ofInterest: (r: AggResult) => boolean): KnobConfig[typeof key] => {
    const sorted = rows
      .filter(ofInterest)
      .sort((a, b) => {
        const aPass = a.trades >= 30 ? 1 : 0;
        const bPass = b.trades >= 30 ? 1 : 0;
        if (aPass !== bPass) return bPass - aPass;
        return b.avgRR - a.avgRR;
      });
    return (sorted[0]?.config[key] ?? BASELINE[key as keyof typeof BASELINE]) as KnobConfig[typeof key];
  };
  void pickAxis; void bestForKey; // keep helpers in case the picker grows

  const reward = perAxis('retestRewardMultiple', r => r.label.startsWith('reward=') || r.label.startsWith('baseline')) as number;
  const tol = perAxis('retestTolerancePct', r => r.label.startsWith('tolerance=') || r.label.startsWith('baseline')) as number;
  const buf = perAxis('retestStopBufferFrac', r => r.label.startsWith('buffer=') || r.label.startsWith('baseline')) as number;
  const vol = perAxis('retestRequireVolumeIncrease', r => r.label.startsWith('volGate=') || r.label.startsWith('baseline')) as boolean;
  const exp = perAxis('retestExpiryBars', r => r.label.startsWith('expiry=') || r.label.startsWith('baseline')) as number;
  return {
    label: `best-of-axes (rew=${reward}, tol=${tol}, buf=${buf}, vol=${vol}, exp=${exp})`,
    retestRewardMultiple: reward,
    retestTolerancePct: tol,
    retestStopBufferFrac: buf,
    retestRequireVolumeIncrease: vol,
    retestExpiryBars: exp,
  };
}

async function main() {
  log(`Fetching ${DAYS}d × 1h candles for: ${SYMBOLS.join(', ')}`);
  const candleMap = new Map<string, Candle[]>();
  for (const sym of SYMBOLS) {
    const candles = await fetchCandles(sym, DAYS);
    candleMap.set(sym, candles);
    log(`  ${sym} → ${candles.length} bars`);
  }

  const grid = buildAxisGrid();
  log(`\nSweeping ${grid.length} configs × ${SYMBOLS.length} symbols = ${grid.length * SYMBOLS.length} backtests`);

  const rows: AggResult[] = [];
  for (let i = 0; i < grid.length; i++) {
    const cfg = grid[i];
    const t0 = Date.now();
    const r = await runConfigOnSymbols(candleMap, cfg);
    const ms = Date.now() - t0;
    rows.push(r);
    log(`  [${i + 1}/${grid.length}] ${cfg.label}: N=${r.trades}  avgRR=${r.avgRR.toFixed(3)}  ret=${r.returnPct.toFixed(2)}%  (${ms}ms)`);
  }

  printRanked(rows);

  const best = bestOfAxes(rows);
  log(`\nBest-of-axes config: ${best.label}`);
  const bestRun = await runConfigOnSymbols(candleMap, best);
  printPerSymbol(bestRun);

  log('\nWalk-forward stability (split = first half / second half):');
  const sortedPassing = [...rows]
    .filter(r => r.trades >= 30)
    .sort((a, b) => b.avgRR - a.avgRR);
  const candidates = [best];
  if (sortedPassing.length > 0) candidates.push(sortedPassing[0].config);

  const wfResults: Array<{ label: string; isAvgRR: number; oosAvgRR: number; isN: number; oosN: number; isRet: number; oosRet: number }> = [];
  for (const cfg of candidates) {
    const { is, oos } = await walkForward(candleMap, cfg);
    const drift = Math.abs(is.avgRR - oos.avgRR);
    const stable = drift <= 0.5 ? 'STABLE' : 'UNSTABLE';
    log(
      `  ${cfg.label}\n    IS:  N=${is.trades}  avgRR=${is.avgRR.toFixed(3)}  ret=${is.returnPct.toFixed(2)}%\n    OOS: N=${oos.trades}  avgRR=${oos.avgRR.toFixed(3)}  ret=${oos.returnPct.toFixed(2)}%\n    drift=${drift.toFixed(3)} → ${stable}`,
    );
    wfResults.push({
      label: cfg.label,
      isAvgRR: is.avgRR,
      oosAvgRR: oos.avgRR,
      isN: is.trades,
      oosN: oos.trades,
      isRet: is.returnPct,
      oosRet: oos.returnPct,
    });
  }

  const passingFull = rows.filter(r => r.trades >= 30 && r.avgRR >= 0 && r.returnPct >= 0);
  log('\nACCEPTANCE CHECK (N>=30, avgRR>=0, return>=0% net of costs):');
  if (passingFull.length === 0) {
    log('  FAIL: No config passed all three thresholds.');
  } else {
    log(`  PASS: ${passingFull.length} config(s) passed.`);
    for (const r of passingFull) {
      log(`     - ${r.label}  N=${r.trades}  avgRR=${r.avgRR.toFixed(3)}  ret=${r.returnPct.toFixed(2)}%`);
    }
  }

  const output = {
    timestamp: new Date().toISOString(),
    days: DAYS,
    symbols: SYMBOLS,
    rows: rows.map(r => ({
      label: r.label,
      config: r.config,
      trades: r.trades,
      winRate: r.winRate,
      avgRR: r.avgRR,
      totalPnl: r.totalPnl,
      returnPct: r.returnPct,
    })),
    bestOfAxes: best,
    walkForward: wfResults,
    acceptance: passingFull.map(r => ({ label: r.label, trades: r.trades, avgRR: r.avgRR, returnPct: r.returnPct })),
  };
  console.log('\nJSON_RESULTS_START');
  console.log(JSON.stringify(output));
  console.log('JSON_RESULTS_END');
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.replace(/\\/g, '/').endsWith('/backtest-retest-sweep.ts')
      || entry.replace(/\\/g, '/').endsWith('/backtest-retest-sweep.js');
})();
if (invokedAsScript) {
  main().catch(err => {
    console.error('Sweep failed:', err);
    process.exit(1);
  });
}

export { buildAxisGrid, configToOpts, configFrom, bestOfAxes, BASELINE };
