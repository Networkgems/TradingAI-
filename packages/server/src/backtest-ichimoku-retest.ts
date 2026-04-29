/**
 * TRA-183 ichimoku-retest acceptance + knob sweep.
 *
 * Goal: confirm that stacking the TRA-179 retest pattern on top of the
 * TRA-182 kumo-breakout entry closes the round-2 acceptance bars on
 * 90 d × 1 h BTC/ETH/SOL with 40 bps + 5 bps costs:
 *
 *   • N ≥ 30 trades on the combined sample
 *   • hit1R ≥ 40%
 *   • winRate ≥ 35%
 *   • avgRR > 0
 *   • net return ≥ 0%
 *
 * Strategy: a coordinate-descent sweep over four knobs (reward multiple,
 * tolerance, structural-stop buffer, expiry) anchored at the TRA-179
 * defaults except the swept axis. The TRA-182 immediate-entry baseline is
 * also reported as a comparison row so the regression vs the parent ticket
 * is visible inline.
 *
 * Run:
 *   node --import tsx/esm packages/server/src/backtest-ichimoku-retest.ts
 *
 * Output:
 *   • Console table of every swept config (sorted by avgRR among N>=30 rows).
 *   • Per-symbol breakdown for the best config that clears all bars.
 *   • Acceptance summary across the four bars listed above.
 *   • JSON tail bracketed by JSON_RESULTS_START / JSON_RESULTS_END.
 */

import YahooFinance from 'yahoo-finance2';
import type { Candle, Position } from '@trading-app/shared';
import { BacktestRunner } from '@trading-app/backtest';
import type { BacktestConfig, BacktestIchimokuOpts } from '@trading-app/backtest';
import { COMMISSION_BPS, SLIPPAGE_BPS } from './backtest-crypto.js';

const yf = new YahooFinance({ validation: { logErrors: false } });

const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'AVAX-USD', 'MATIC-USD', 'LINK-USD'];
const DAYS = 365;
const INITIAL_EQUITY = 100_000;

const BASELINE: Required<Pick<BacktestIchimokuOpts,
  'retestRewardMultiple' | 'retestTolerancePct' | 'retestExpiryBars' | 'kumoThicknessFloor'
>> = {
  retestRewardMultiple: 2,
  retestTolerancePct: 0,
  retestExpiryBars: 16,
  kumoThicknessFloor: 0.005,
};

interface KnobConfig {
  label: string;
  retestEntry: boolean;
  retestRewardMultiple: number;
  retestTolerancePct: number;
  retestExpiryBars: number;
  kumoThicknessFloor: number;
}

function configToOpts(c: KnobConfig): BacktestIchimokuOpts {
  return {
    enforceTimeFilter: false,
    retestEntry: c.retestEntry,
    retestRewardMultiple: c.retestRewardMultiple,
    retestTolerancePct: c.retestTolerancePct,
    retestExpiryBars: c.retestExpiryBars,
    kumoThicknessFloor: c.kumoThicknessFloor,
  };
}

function configFrom(overrides: Partial<KnobConfig>, label: string): KnobConfig {
  return {
    label,
    retestEntry: overrides.retestEntry ?? true,
    retestRewardMultiple: overrides.retestRewardMultiple ?? BASELINE.retestRewardMultiple,
    retestTolerancePct: overrides.retestTolerancePct ?? BASELINE.retestTolerancePct,
    retestExpiryBars: overrides.retestExpiryBars ?? BASELINE.retestExpiryBars,
    kumoThicknessFloor: overrides.kumoThicknessFloor ?? BASELINE.kumoThicknessFloor,
  };
}

/**
 * Axis sweep grid + the TRA-182 immediate-entry control row. Each axis sweep
 * holds the others at the baseline (rew=2, tol=0, exp=16, kumo=0.005).
 */
function buildAxisGrid(): KnobConfig[] {
  const grid: KnobConfig[] = [];
  grid.push(configFrom({ retestEntry: false }, 'TRA-182 immediate (control)'));
  grid.push(configFrom({}, 'baseline retest'));

  for (const v of [1, 1.5, 3]) {
    if (v === BASELINE.retestRewardMultiple) continue;
    grid.push(configFrom({ retestRewardMultiple: v }, `reward=${v}`));
  }
  for (const v of [0.10, 0.25]) {
    grid.push(configFrom({ retestTolerancePct: v }, `tolerance=${v}`));
  }
  for (const v of [8, 24]) {
    grid.push(configFrom({ retestExpiryBars: v }, `expiry=${v}`));
  }
  for (const v of [0.01, 0.015, 0.02]) {
    grid.push(configFrom({ kumoThicknessFloor: v }, `kumo=${v}`));
  }
  // Combo: stricter kumo + lower reward
  grid.push(configFrom({ kumoThicknessFloor: 0.01, retestRewardMultiple: 1.5 }, 'kumo=0.01 + rew=1.5'));
  grid.push(configFrom({ kumoThicknessFloor: 0.015, retestRewardMultiple: 1.5 }, 'kumo=0.015 + rew=1.5'));
  grid.push(configFrom({ kumoThicknessFloor: 0.01, retestRewardMultiple: 1, retestTolerancePct: 0.10 }, 'kumo=0.01 + rew=1 + tol=0.10'));
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
  totalSignals: number;
  hit1RPct: number;
  perSymbol: Map<string, { trades: number; avgRR: number; pnl: number }>;
}

async function fetchCandles(symbol: string, days: number): Promise<Candle[]> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  try {
    const result = await yf.chart(symbol, { period1: from, period2: now, interval: '1h' });
    const quotes = result.quotes ?? [];
    return quotes
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
  } catch (err) {
    console.error(`Failed to fetch ${symbol}:`, err);
    return [];
  }
}

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
  let totalSignals = 0;
  let totalReached = 0;
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
      strategyType: 'ichimoku',
      ichimokuOpts: configToOpts(cfg),
      commissionBps: COMMISSION_BPS,
      slippageBps: SLIPPAGE_BPS,
    };
    const r = await runner.run(config, candles);
    allTrades.push(...r.trades);
    if (r.signalEdge) {
      totalSignals += r.signalEdge.totalSignals;
      totalReached += r.signalEdge.reachedOneR;
    }
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
  const returnPct = (totalPnl / (INITIAL_EQUITY * candleMap.size)) * 100;
  const hit1RPct = totalSignals > 0 ? (totalReached / totalSignals) * 100 : 0;

  return {
    label: cfg.label, config: cfg, trades, winRate, avgRR, totalPnl, returnPct,
    totalSignals, hit1RPct, perSymbol,
  };
}

function printRanked(rows: AggResult[]) {
  const sorted = [...rows].sort((a, b) => {
    const aPasses = a.trades >= 30 ? 1 : 0;
    const bPasses = b.trades >= 30 ? 1 : 0;
    if (aPasses !== bPasses) return bPasses - aPasses;
    return b.avgRR - a.avgRR;
  });
  console.log('\n' + '='.repeat(118));
  console.log(`TRA-183 ICHIMOKU RETEST SWEEP — ${DAYS}d × 1h × ${SYMBOLS.length} crypto symbols, costs ON (40 bps + 5 bps)`);
  console.log('='.repeat(118));
  console.log(
    'Config'.padEnd(46) +
    'N'.padStart(6) +
    'Win%'.padStart(8) +
    'AvgRR'.padStart(10) +
    'Hit1R%'.padStart(10) +
    'Return%'.padStart(10) +
    'TotalPnL'.padStart(14),
  );
  console.log('-'.repeat(118));
  for (const r of sorted) {
    const flag = r.trades >= 30 ? '' : '  (N<30)';
    console.log(
      (r.label + flag).padEnd(46) +
      r.trades.toString().padStart(6) +
      (r.winRate * 100).toFixed(1).padStart(8) +
      r.avgRR.toFixed(3).padStart(10) +
      r.hit1RPct.toFixed(1).padStart(10) +
      r.returnPct.toFixed(2).padStart(10) +
      ('$' + r.totalPnl.toFixed(0)).padStart(14),
    );
  }
  console.log('='.repeat(118));
}

function printPerSymbol(r: AggResult) {
  console.log(`\nPer-symbol breakdown for [${r.label}]:`);
  console.log('-'.repeat(60));
  console.log('Symbol'.padEnd(12) + 'Trades'.padStart(8) + 'AvgRR'.padStart(10) + 'PnL'.padStart(14));
  for (const [sym, s] of r.perSymbol) {
    console.log(sym.padEnd(12) + s.trades.toString().padStart(8) + s.avgRR.toFixed(3).padStart(10) + ('$' + s.pnl.toFixed(0)).padStart(14));
  }
}

interface AcceptanceCheck {
  label: string;
  trades: { n: number; pass: boolean };
  hit1R: { pct: number; pass: boolean };
  winRate: { pct: number; pass: boolean };
  avgRR: { val: number; pass: boolean };
  returnPct: { val: number; pass: boolean };
  allPass: boolean;
}

function evaluateAcceptance(r: AggResult): AcceptanceCheck {
  const trades = { n: r.trades, pass: r.trades >= 30 };
  const hit1R = { pct: r.hit1RPct, pass: r.hit1RPct >= 40 };
  const winRate = { pct: r.winRate * 100, pass: r.winRate >= 0.35 };
  const avgRR = { val: r.avgRR, pass: r.avgRR > 0 };
  const returnPct = { val: r.returnPct, pass: r.returnPct >= 0 };
  return {
    label: r.label,
    trades, hit1R, winRate, avgRR, returnPct,
    allPass: trades.pass && hit1R.pass && winRate.pass && avgRR.pass && returnPct.pass,
  };
}

function printAcceptance(checks: AcceptanceCheck[]) {
  console.log('\nACCEPTANCE CHECK — TRA-183 round-2 bars:');
  console.log('-'.repeat(118));
  console.log(
    'Config'.padEnd(46) +
    'N≥30'.padStart(10) +
    'Hit1R≥40%'.padStart(13) +
    'Win≥35%'.padStart(11) +
    'avgRR>0'.padStart(11) +
    'Ret≥0%'.padStart(11) +
    'PASS'.padStart(8),
  );
  console.log('-'.repeat(118));
  for (const c of checks) {
    const pf = (b: boolean) => (b ? 'Y' : 'N');
    console.log(
      c.label.padEnd(46) +
      `${c.trades.n} ${pf(c.trades.pass)}`.padStart(10) +
      `${c.hit1R.pct.toFixed(1)}% ${pf(c.hit1R.pass)}`.padStart(13) +
      `${c.winRate.pct.toFixed(1)}% ${pf(c.winRate.pass)}`.padStart(11) +
      `${c.avgRR.val.toFixed(2)} ${pf(c.avgRR.pass)}`.padStart(11) +
      `${c.returnPct.val.toFixed(2)}% ${pf(c.returnPct.pass)}`.padStart(11) +
      (c.allPass ? '✅' : '❌').padStart(8),
    );
  }
}

async function main() {
  console.log(`Fetching ${DAYS}d × 1h candles for: ${SYMBOLS.join(', ')}`);
  const candleMap = new Map<string, Candle[]>();
  for (const sym of SYMBOLS) {
    process.stdout.write(`  ${sym}... `);
    const candles = await fetchCandles(sym, DAYS);
    candleMap.set(sym, candles);
    console.log(`${candles.length} bars`);
  }

  const grid = buildAxisGrid();
  console.log(`\nSweeping ${grid.length} configs × ${SYMBOLS.length} symbols = ${grid.length * SYMBOLS.length} backtests...`);

  const rows: AggResult[] = [];
  for (let i = 0; i < grid.length; i++) {
    const cfg = grid[i];
    process.stdout.write(`  [${i + 1}/${grid.length}] ${cfg.label}... `);
    const r = await runConfigOnSymbols(candleMap, cfg);
    rows.push(r);
    console.log(`N=${r.trades}  hit1R=${r.hit1RPct.toFixed(1)}%  avgRR=${r.avgRR.toFixed(3)}  ret=${r.returnPct.toFixed(2)}%`);
  }

  printRanked(rows);

  const checks = rows.map(evaluateAcceptance);
  printAcceptance(checks);

  const passing = checks.filter(c => c.allPass);
  if (passing.length > 0) {
    const bestRow = rows.find(r => r.label === passing[0].label)!;
    printPerSymbol(bestRow);
  } else {
    console.log('\nNo config passed all five acceptance bars. Best avgRR row breakdown:');
    const sorted = [...rows].filter(r => r.trades >= 30).sort((a, b) => b.avgRR - a.avgRR);
    if (sorted.length > 0) printPerSymbol(sorted[0]);
  }

  const output = {
    timestamp: new Date().toISOString(),
    days: DAYS,
    symbols: SYMBOLS,
    rows: rows.map(r => ({
      label: r.label,
      config: r.config,
      trades: r.trades,
      totalSignals: r.totalSignals,
      hit1RPct: r.hit1RPct,
      winRate: r.winRate,
      avgRR: r.avgRR,
      totalPnl: r.totalPnl,
      returnPct: r.returnPct,
    })),
    acceptance: checks,
  };
  console.log('\nJSON_RESULTS_START');
  console.log(JSON.stringify(output));
  console.log('JSON_RESULTS_END');
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.replace(/\\/g, '/').endsWith('/backtest-ichimoku-retest.ts')
      || entry.replace(/\\/g, '/').endsWith('/backtest-ichimoku-retest.js');
})();
if (invokedAsScript) {
  main().catch(err => {
    console.error('Sweep failed:', err);
    process.exit(1);
  });
}

export { buildAxisGrid, configToOpts, configFrom, BASELINE };
