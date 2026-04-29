/**
 * Per-strategy Monte Carlo report (TRA-172).
 *
 * Runs each strategy once on the 90-day synthetic crypto dataset, then
 * resamples the realised closed-trade list 1,000 times to attach a confidence
 * band (5th / 50th / 95th percentile final equity) and a worst observed
 * drawdown to each result. Output: a Markdown report saved next to the
 * package so it can be linked from the issue.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacktestRunner } from './runner.js';
import { syntheticCryptoSeries } from './synthetic.js';
import { bootstrapEquityCurves } from './bootstrap.js';
import type { BacktestConfig, BacktestResult } from './types.js';

const INITIAL_EQUITY = 25_000;
const SYMBOL = 'BTC-USD';
const DAYS = 90;
const BAR_INTERVAL_MIN = 60;
const BOOTSTRAP_ITERATIONS = 1000;
const BOOTSTRAP_SEED = 7;

const STRATEGIES: Array<{ name: string; type: BacktestConfig['strategyType'] }> = [
  { name: 'reversal', type: 'reversal' },
  { name: 'macd_bollinger', type: 'macd_bollinger' },
  { name: 'orb', type: 'orb' },
  { name: 'ichimoku', type: 'ichimoku' },
  { name: 'combined', type: 'combined' },
];

function fmtMoney(n: number) { return `$${n.toFixed(2)}`; }
function fmtPct(n: number) { return `${(n * 100).toFixed(2)}%`; }

async function main() {
  const candles = syntheticCryptoSeries(DAYS, SYMBOL, 30_000, BAR_INTERVAL_MIN, 31);
  const start = candles[0].timestamp;
  const end = candles[candles.length - 1].timestamp;

  const runner = new BacktestRunner();
  const lines: string[] = [];
  lines.push(`# Monte Carlo report — ${SYMBOL} (${DAYS}-day synthetic)`);
  lines.push('');
  lines.push(`Initial equity: ${fmtMoney(INITIAL_EQUITY)}  •  Bootstrap iterations: ${BOOTSTRAP_ITERATIONS}  •  Seed: ${BOOTSTRAP_SEED}`);
  lines.push('');
  lines.push('| Strategy | Trades | Win % | Realised P&L | Signal-edge % | p5 final | p50 final | p95 final | Worst DD |');
  lines.push('|---|---|---|---|---|---|---|---|---|');

  const results: Array<{ name: string; result: BacktestResult }> = [];

  for (const s of STRATEGIES) {
    const result = await runner.run(
      {
        symbol: SYMBOL,
        startDate: start,
        endDate: end,
        initialEquity: INITIAL_EQUITY,
        strategyType: s.type,
        reversalOpts: { enforceTimeFilter: false },
        macdBollingerOpts: { enforceTimeFilter: false },
        portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
      },
      candles,
    );
    const bands = bootstrapEquityCurves(result.trades, INITIAL_EQUITY, {
      iterations: BOOTSTRAP_ITERATIONS,
      seed: BOOTSTRAP_SEED,
    });
    result.confidenceBands = bands;
    results.push({ name: s.name, result });

    lines.push(
      `| ${s.name} | ${result.totalTrades} | ${fmtPct(result.winRate)} | ${fmtMoney(result.totalPnl)} | ` +
        `${result.signalEdge ? result.signalEdge.hitRatePct.toFixed(2) + '%' : '—'} | ` +
        `${fmtMoney(bands.p5)} | ${fmtMoney(bands.p50)} | ${fmtMoney(bands.p95)} | ${fmtPct(bands.worstDrawdown)} |`,
    );

    console.log(
      `[${s.name.padEnd(15)}] trades=${String(result.totalTrades).padStart(3)} ` +
        `pnl=${fmtMoney(result.totalPnl).padStart(10)} ` +
        `edge=${(result.signalEdge?.hitRatePct ?? 0).toFixed(1).padStart(5)}% ` +
        `p5=${fmtMoney(bands.p5).padStart(10)} ` +
        `p50=${fmtMoney(bands.p50).padStart(10)} ` +
        `p95=${fmtMoney(bands.p95).padStart(10)} ` +
        `worstDD=${fmtPct(bands.worstDrawdown).padStart(7)}`,
    );
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Confidence bands are bootstrap percentiles of *final equity* over 1,000 resamples');
  lines.push('  of the realised closed-trade list. They quantify how dependent the headline');
  lines.push('  number is on trade ordering and on the small sample size.');
  lines.push('- Worst DD is the worst peak-to-trough drawdown observed across all bootstrap');
  lines.push('  iterations — a tail-risk sanity check, not the realised drawdown.');
  lines.push('- `Signal-edge %` is the share of generated signals where price reached the');
  lines.push('  +/- 1R target within 24 bars of the signal, regardless of whether the bracket');
  lines.push('  order would have triggered. Bypasses fill assumptions.');

  // Anchor outputs to the package root regardless of cwd so `tsx src/run-monte-carlo.ts`
  // works whether invoked from the repo root or `packages/backtest`.
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, '..', 'monte-carlo-report.md');
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\nWrote Monte Carlo report → ${out}`);
}

const invoked = process.argv[1] && /run-monte-carlo\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch(err => { console.error(err); process.exit(1); });
