/**
 * Per-strategy Monte Carlo report (TRA-172, productionised in TRA-420).
 *
 * Runs each strategy on REAL Coinbase 4H bars — in-sample and out-of-sample
 * windows reported separately — then attaches a moving-block bootstrap
 * confidence band (5th / 50th / 95th percentile final equity + worst observed
 * drawdown) to each result.
 *
 * TRA-420 §1/§2: the retired version generated `syntheticCryptoSeries` and
 * resampled it with the IID `bootstrapEquityCurves`. Synthetic candles do not
 * predict live behaviour, and the IID resample assumed trades are independent
 * — they are not (trends cluster wins, regime shifts drag whole runs). This
 * harness consumes `loadOrFetch4hBars` and uses the moving-block bootstrap
 * (block length 5) so within-block autocorrelation survives the resample.
 *
 * Run with the workspace tsx wrapper:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-monte-carlo.ts
 *
 * Output: a Markdown report saved next to the package so it can be linked
 * from the issue.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacktestRunner } from './runner.js';
import { loadOrFetch4hBars } from './fetch-tra266-data.js';
import { blockBootstrapEquityCurves } from './bootstrap.js';
import { cryptoTieredCostModel } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';
import type { BacktestConfig, BacktestResult } from './types.js';

const INITIAL_EQUITY = 25_000;
const SYMBOL = 'BTC-USD';
const BOOTSTRAP_ITERATIONS = 3000;
const BOOTSTRAP_SEED = 7;
const BLOCK_LENGTH = 5;
// 4H bars: 250 warmup bars clear the 200-bar EMA / 90-bar ATR-median regime
// window so the out-of-sample run is not cold-started (TRA-420 §3).
const WARMUP_BARS = 250;

// IS/OOS split mirrors the TRA-405 §2 rationale: the production strategy
// constants were tuned in-sample on 2024 Coinbase data, so the honest
// out-of-sample test is the period after that tuning era.
// Aligned with the TRA-405 4H data window (the on-disk Coinbase cache). IS
// begins at the data edge, so the in-sample run is cold-started — acceptable
// given the ~20-month IS window dwarfs the ~250-bar warmup (TRA-405 §2).
const DATA_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01
const IS_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01
const IS_END_MS = Date.UTC(2025, 0, 1) - 1; // 2024-12-31 23:59:59.999
const OOS_START_MS = Date.UTC(2025, 0, 1); // 2025-01-01

interface StrategySpec {
  name: string;
  type: BacktestConfig['strategyType'];
  extra: Partial<BacktestConfig>;
}

// Configs mirror the live router call-site / TRA-306 / TRA-405 conventions.
const STRATEGIES: StrategySpec[] = [
  { name: 'reversal', type: 'reversal', extra: { reversalOpts: { enforceTimeFilter: false, rsiOverbought: 65, rsiOversold: 35 } } },
  { name: 'macd_bollinger', type: 'macd_bollinger', extra: { macdBollingerOpts: { enforceTimeFilter: false } } },
  { name: 'momentum', type: 'momentum', extra: { momentumOpts: {} } },
  { name: 'breakout_vol', type: 'breakout_vol', extra: { breakoutVolOpts: {} } },
  { name: 'mean_reversion', type: 'mean_reversion', extra: { meanReversionOpts: {}, meanReversionRiskPct: 0.0075 } },
];

interface Segment {
  label: 'IS' | 'OOS';
  start: number;
  end: number;
}

function fmtMoney(n: number) { return `$${n.toFixed(2)}`; }
function fmtPct(n: number) { return `${(n * 100).toFixed(2)}%`; }

/**
 * Warmup boundary for an evaluation window: the timestamp `WARMUP_BARS` bars
 * before the first candle at-or-after `evalStartMs`. Clamped to the start of
 * the series when the window begins near the data edge.
 */
function warmupStartFor(candles: Candle[], evalStartMs: number): number {
  let idx = candles.findIndex(c => c.timestamp >= evalStartMs);
  if (idx < 0) idx = candles.length - 1;
  return candles[Math.max(0, idx - WARMUP_BARS)].timestamp;
}

async function runSegment(
  runner: BacktestRunner,
  candles: Candle[],
  spec: StrategySpec,
  seg: Segment,
): Promise<BacktestResult> {
  return runner.run(
    {
      symbol: SYMBOL,
      warmupStartDate: warmupStartFor(candles, seg.start),
      startDate: seg.start,
      endDate: seg.end,
      initialEquity: INITIAL_EQUITY,
      strategyType: spec.type,
      // TRA-420 §1: real data → real costs (same tiered model as TRA-405).
      costModel: cryptoTieredCostModel(),
      portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
      ...spec.extra,
    },
    candles,
  );
}

async function main() {
  // TRA-420 §1/§2: real Coinbase 4H bars only — never synthetic.
  const candles = await loadOrFetch4hBars(SYMBOL, DATA_START_MS, Date.now());
  if (candles.length === 0) {
    throw new Error(`No 4H bars available for ${SYMBOL}`);
  }
  const segments: Segment[] = [
    { label: 'IS', start: IS_START_MS, end: IS_END_MS },
    { label: 'OOS', start: OOS_START_MS, end: Date.now() },
  ];

  const runner = new BacktestRunner();
  const lines: string[] = [];
  lines.push(`# Monte Carlo report — ${SYMBOL} (real Coinbase 4H data)`);
  lines.push('');
  lines.push(
    `Initial equity: ${fmtMoney(INITIAL_EQUITY)}  •  Data source: coinbase-exchange  •  ` +
      `Block bootstrap: ${BOOTSTRAP_ITERATIONS} iterations, block length ${BLOCK_LENGTH}, seed ${BOOTSTRAP_SEED}`,
  );
  lines.push('');
  lines.push(
    `IS window: ${new Date(IS_START_MS).toISOString().slice(0, 10)} → ${new Date(IS_END_MS).toISOString().slice(0, 10)}  •  ` +
      `OOS window: ${new Date(OOS_START_MS).toISOString().slice(0, 10)} → ${new Date(segments[1].end).toISOString().slice(0, 10)}`,
  );
  lines.push('');
  lines.push('| Strategy | Window | Trades | Win % | Realised P&L | Signal-edge % | p5 final | p50 final | p95 final | Worst DD |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');

  for (const spec of STRATEGIES) {
    for (const seg of segments) {
      const result = await runSegment(runner, candles, spec, seg);
      // TRA-420 §2: block bootstrap is the default Monte Carlo path.
      const bands = blockBootstrapEquityCurves(result.trades, INITIAL_EQUITY, {
        iterations: BOOTSTRAP_ITERATIONS,
        seed: BOOTSTRAP_SEED,
        blockLength: BLOCK_LENGTH,
      });
      result.confidenceBands = bands;

      lines.push(
        `| ${spec.name} | ${seg.label} | ${result.totalTrades} | ${fmtPct(result.winRate)} | ` +
          `${fmtMoney(result.totalPnl)} | ` +
          `${result.signalEdge ? result.signalEdge.hitRatePct.toFixed(2) + '%' : '—'} | ` +
          `${fmtMoney(bands.p5)} | ${fmtMoney(bands.p50)} | ${fmtMoney(bands.p95)} | ${fmtPct(bands.worstDrawdown)} |`,
      );

      console.log(
        `[${spec.name.padEnd(15)} ${seg.label.padEnd(3)}] ` +
          `trades=${String(result.totalTrades).padStart(3)} ` +
          `pnl=${fmtMoney(result.totalPnl).padStart(11)} ` +
          `edge=${(result.signalEdge?.hitRatePct ?? 0).toFixed(1).padStart(5)}% ` +
          `p5=${fmtMoney(bands.p5).padStart(11)} ` +
          `p50=${fmtMoney(bands.p50).padStart(11)} ` +
          `p95=${fmtMoney(bands.p95).padStart(11)} ` +
          `worstDD=${fmtPct(bands.worstDrawdown).padStart(7)}`,
      );
    }
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Runs on real Coinbase Exchange 4H bars after the TRA-185 tiered crypto cost');
  lines.push('  model. Synthetic data is no longer used for evaluation (TRA-420 §1).');
  lines.push('- `IS` overlaps the era the production constants were tuned on; `OOS` is the');
  lines.push('  genuinely unseen period after — compare the two rows per strategy to see how');
  lines.push('  much of the in-sample edge survives out of sample.');
  lines.push('- Confidence bands are **moving-block** bootstrap percentiles of *final equity*');
  lines.push('  (block length 5): blocks of consecutive trades are resampled so losing');
  lines.push('  streaks / winning clusters survive the resample (TRA-420 §2). The IID');
  lines.push('  resample understated tail drawdown by assuming trade independence.');
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
