/**
 * TRA-177 — Consolidated commission-adjusted real-data + walk-forward + Monte
 * Carlo run for the TRA-168 final live-capital recommendation.
 *
 * One script, one Coinbase fetch, three reads:
 *   1. In-sample, commission-adjusted (40 bps + 10 bps slip), per
 *      asset / strategy / `combined` basket, on the most recent 90 days.
 *   2. Walk-forward OOS over 60d-train / 30d-test windows slid by 15d, with
 *      the parameter grid spelled out in the TRA-177 brief. Fetches 120 days
 *      of 1h candles so three folds fit; cost model applied to OOS only.
 *   3. Monte Carlo bootstrap (1,000 iters) on the realised in-sample
 *      closed-trade list per strategy.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra177.ts
 *
 * Outputs `reports/tra168-final.md` next to the package; the script is the
 * single reproducible entry-point for the TRA-168 recommendation.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, Position } from '@trading-app/shared';
import { BacktestRunner } from './runner.js';
import { buildWindows } from './walk-forward.js';
import { bootstrapEquityCurves } from './bootstrap.js';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestReversalOpts,
  BacktestMacdBollingerOpts,
  BacktestIchimokuOpts,
} from './types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const GRANULARITY_1H = 3600;
const MAX_CANDLES_PER_REQUEST = 300;

const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const;
const INITIAL_EQUITY = 25_000;
const COMMISSION_BPS = 40;
const SLIPPAGE_BPS = 10;

const IN_SAMPLE_DAYS = 90;
const WALK_FORWARD_DAYS = 120; // 60d train + 30d test + 2*15d slide → 3 folds
const BAR_INTERVAL_MIN = 60;
const BARS_PER_DAY = Math.floor((24 * 60) / BAR_INTERVAL_MIN);

const BOOTSTRAP_ITERATIONS = 1000;
const BOOTSTRAP_SEED = 7;

type StrategyType = BacktestConfig['strategyType'];

// Strategies covered in the in-sample read. `combined` is the basket the
// TRA-168 recommendation will ride if the per-strategy read is acceptable.
const IN_SAMPLE_STRATEGIES: ReadonlyArray<{
  name: string;
  type: StrategyType;
}> = [
  { name: 'reversal', type: 'reversal' },
  { name: 'macd_trend', type: 'macd_trend' },
  { name: 'bb_fade', type: 'bb_fade' },
  { name: 'ichimoku', type: 'ichimoku' },
  { name: 'combined', type: 'combined' },
];

// 24/7-friendly knob defaults shared by every in-sample run. Walk-forward
// folds override the relevant knob; everything else stays on these defaults.
const DEFAULT_REVERSAL: BacktestReversalOpts = {
  enforceTimeFilter: false,
  rsiOverbought: 65,
  rsiOversold: 35,
  volatilityFloorPct: 0,
};
const DEFAULT_MACD_BOLLINGER: BacktestMacdBollingerOpts = {
  enforceTimeFilter: false,
  volatilityFloorPct: 0,
};
const DEFAULT_ICHIMOKU: BacktestIchimokuOpts = {
  enforceTimeFilter: false,
};

// ── Coinbase fetch ────────────────────────────────────────────────────────────

/**
 * Pulls hourly OHLCV from Coinbase Exchange's public candles endpoint. Yahoo's
 * crypto 1h feed reports US-equity-aligned bars only; Coinbase gives the true
 * 24/7 series we need for in-sample frequency and walk-forward fold counts.
 */
async function fetchHourlyFromCoinbase(symbol: string, days: number): Promise<Candle[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const stepMs = MAX_CANDLES_PER_REQUEST * GRANULARITY_1H * 1000;
  const all: Candle[] = [];

  let cursor = start.getTime();
  while (cursor < end.getTime()) {
    const winEnd = Math.min(cursor + stepMs, end.getTime());
    const url = new URL(`${COINBASE_BASE}/products/${symbol}/candles`);
    url.searchParams.set('granularity', String(GRANULARITY_1H));
    url.searchParams.set('start', new Date(cursor).toISOString());
    url.searchParams.set('end', new Date(winEnd).toISOString());

    const res = await fetch(url.toString(), { headers: { 'User-Agent': 'TRA-177/1.0' } });
    if (!res.ok) {
      throw new Error(`Coinbase ${res.status} for ${symbol}: ${(await res.text()).slice(0, 200)}`);
    }
    const rows = (await res.json()) as Array<[number, number, number, number, number, number]>;
    for (const [time, low, high, open, close, volume] of rows) {
      all.push({ symbol, timestamp: time * 1000, open, high, low, close, volume });
    }
    cursor = winEnd;
    await new Promise(r => setTimeout(r, 150));
  }

  all.sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set<number>();
  return all.filter(c => (seen.has(c.timestamp) ? false : (seen.add(c.timestamp), true)));
}

// ── Formatting helpers ────────────────────────────────────────────────────────

const fmtMoney = (n: number) => `$${n.toFixed(2)}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;
const fmtPf = (n: number) =>
  n === Infinity ? '∞' : Number.isFinite(n) ? n.toFixed(2) : '—';
const dateStr = (ts: number) => new Date(ts).toISOString().slice(0, 10);

// ── In-sample (commission-adjusted) ───────────────────────────────────────────

interface InSampleRow {
  symbol: string;
  strategy: string;
  trades: number;
  winRate: number;
  totalPnl: number;
  worstCasePnl: number;
  profitFactor: number;
  sharpe: number;
  signalEdgePct: number;
  signalReached: number;
  signalTotal: number;
}

async function runInSample(
  runner: BacktestRunner,
  candles: Candle[],
  symbol: string,
  strat: { name: string; type: StrategyType },
): Promise<{ row: InSampleRow; trades: Position[] }> {
  const start = candles[0].timestamp;
  const end = candles[candles.length - 1].timestamp;
  const result = await runner.run(
    {
      symbol,
      startDate: start,
      endDate: end,
      initialEquity: INITIAL_EQUITY,
      strategyType: strat.type,
      reversalOpts: DEFAULT_REVERSAL,
      macdBollingerOpts: DEFAULT_MACD_BOLLINGER,
      ichimokuOpts: DEFAULT_ICHIMOKU,
      portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
      commissionBps: COMMISSION_BPS,
      slippageBps: SLIPPAGE_BPS,
    },
    candles,
  );
  return {
    row: {
      symbol,
      strategy: strat.name,
      trades: result.totalTrades,
      winRate: result.winRate,
      totalPnl: result.totalPnl,
      worstCasePnl: result.worstCaseTotalPnl,
      profitFactor: result.profitFactor,
      sharpe: result.sharpeRatio,
      signalEdgePct: result.signalEdge?.hitRatePct ?? 0,
      signalReached: result.signalEdge?.reachedOneR ?? 0,
      signalTotal: result.signalEdge?.totalSignals ?? 0,
    },
    trades: result.trades,
  };
}

// ── Walk-forward grid ─────────────────────────────────────────────────────────

interface ParamPoint {
  label: string;
  type: StrategyType;
  reversalOpts?: BacktestReversalOpts;
  macdBollingerOpts?: BacktestMacdBollingerOpts;
  ichimokuOpts?: BacktestIchimokuOpts;
}

const REVERSAL_GRID: ParamPoint[] = [1.2, 1.3, 1.5].map(volumeMultiplier => ({
  label: `volMult=${volumeMultiplier}`,
  type: 'reversal',
  reversalOpts: { ...DEFAULT_REVERSAL, volumeMultiplier },
}));

// `bb_fade` reads the same `macdBollingerOpts` as the legacy macd_bollinger
// strategy in the runner — `rsiOversold` is the long-entry threshold.
const BB_FADE_GRID: ParamPoint[] = [25, 30, 35].map(rsiThreshold => ({
  label: `rsiOversold=${rsiThreshold}`,
  type: 'bb_fade',
  macdBollingerOpts: { ...DEFAULT_MACD_BOLLINGER, rsiOversold: rsiThreshold },
}));

const MACD_TREND_GRID: ParamPoint[] = [1.0, 1.2, 1.5].map(volumeMultiplier => ({
  label: `volMult=${volumeMultiplier}`,
  type: 'macd_trend',
  macdBollingerOpts: { ...DEFAULT_MACD_BOLLINGER, volumeMultiplier },
}));

const ICHIMOKU_GRID: ParamPoint[] = [0.003, 0.005, 0.008].map(kumoThicknessFloor => ({
  label: `kumo>=${kumoThicknessFloor}`,
  type: 'ichimoku',
  ichimokuOpts: { ...DEFAULT_ICHIMOKU, kumoThicknessFloor },
}));

const STRATEGY_GRIDS: Array<{ name: string; type: StrategyType; grid: ParamPoint[] }> = [
  { name: 'reversal', type: 'reversal', grid: REVERSAL_GRID },
  { name: 'bb_fade', type: 'bb_fade', grid: BB_FADE_GRID },
  { name: 'macd_trend', type: 'macd_trend', grid: MACD_TREND_GRID },
  { name: 'ichimoku', type: 'ichimoku', grid: ICHIMOKU_GRID },
];

interface WalkForwardRow {
  strategy: string;
  fold: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  pickedParams: string;
  trainSharpe: number;
  trainTrades: number;
  oosSharpe: number;
  oosPnl: number;
  oosWinRate: number;
  oosTrades: number;
  oosSignalEdgePct: number;
}

async function evaluateOnSlice(
  runner: BacktestRunner,
  symbol: string,
  slice: Candle[],
  point: ParamPoint,
  applyCosts: boolean,
): Promise<BacktestResult> {
  const start = slice[0].timestamp;
  const end = slice[slice.length - 1].timestamp;
  return runner.run(
    {
      symbol,
      startDate: start,
      endDate: end,
      initialEquity: INITIAL_EQUITY,
      strategyType: point.type,
      reversalOpts: point.reversalOpts ?? DEFAULT_REVERSAL,
      macdBollingerOpts: point.macdBollingerOpts ?? DEFAULT_MACD_BOLLINGER,
      ichimokuOpts: point.ichimokuOpts ?? DEFAULT_ICHIMOKU,
      portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
      // Train picks should be insensitive to costs — sweep on gross edge,
      // then apply the realistic cost model on the OOS test window.
      commissionBps: applyCosts ? COMMISSION_BPS : 0,
      slippageBps: applyCosts ? SLIPPAGE_BPS : 0,
    },
    slice,
  );
}

async function runWalkForwardForSymbol(
  runner: BacktestRunner,
  symbol: string,
  candles: Candle[],
): Promise<WalkForwardRow[]> {
  const trainBars = 60 * BARS_PER_DAY;
  const testBars = 30 * BARS_PER_DAY;
  const stepBars = 15 * BARS_PER_DAY;
  const windows = buildWindows(candles.length, trainBars, testBars, stepBars);
  const out: WalkForwardRow[] = [];

  for (const grid of STRATEGY_GRIDS) {
    for (let f = 0; f < windows.length; f++) {
      const win = windows[f];
      const trainSlice = candles.slice(win.trainStart, win.trainEnd);
      const testSlice = candles.slice(win.testStart, win.testEnd);

      let best: { point: ParamPoint; sharpe: number; trades: number } | null = null;
      for (const point of grid.grid) {
        const r = await evaluateOnSlice(runner, symbol, trainSlice, point, false);
        // Tie-break: prefer more trades when sharpe ties (zero-trade or
        // zero-variance grids both produce sharpe = 0).
        if (
          best === null ||
          r.sharpeRatio > best.sharpe ||
          (r.sharpeRatio === best.sharpe && r.totalTrades > best.trades)
        ) {
          best = { point, sharpe: r.sharpeRatio, trades: r.totalTrades };
        }
      }
      if (best === null) continue;

      const oos = await evaluateOnSlice(runner, symbol, testSlice, best.point, true);
      out.push({
        strategy: grid.name,
        fold: f,
        trainStart: dateStr(trainSlice[0].timestamp),
        trainEnd: dateStr(trainSlice[trainSlice.length - 1].timestamp),
        testStart: dateStr(testSlice[0].timestamp),
        testEnd: dateStr(testSlice[testSlice.length - 1].timestamp),
        pickedParams: best.point.label,
        trainSharpe: best.sharpe,
        trainTrades: best.trades,
        oosSharpe: oos.sharpeRatio,
        oosPnl: oos.totalPnl,
        oosWinRate: oos.winRate,
        oosTrades: oos.totalTrades,
        oosSignalEdgePct: oos.signalEdge?.hitRatePct ?? 0,
      });
    }
  }

  return out;
}

// ── Monte Carlo ───────────────────────────────────────────────────────────────

interface MonteCarloRow {
  symbol: string;
  strategy: string;
  trades: number;
  realizedPnl: number;
  p5: number;
  p50: number;
  p95: number;
  worstDrawdown: number;
}

function monteCarlo(
  symbol: string,
  strategy: string,
  trades: ReadonlyArray<Position>,
  realizedPnl: number,
): MonteCarloRow {
  const bands = bootstrapEquityCurves(trades, INITIAL_EQUITY, {
    iterations: BOOTSTRAP_ITERATIONS,
    seed: BOOTSTRAP_SEED,
  });
  return {
    symbol,
    strategy,
    trades: trades.length,
    realizedPnl,
    p5: bands.p5,
    p50: bands.p50,
    p95: bands.p95,
    worstDrawdown: bands.worstDrawdown,
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

interface ReportPayload {
  generatedAt: string;
  inSampleStart: string;
  inSampleEnd: string;
  walkForwardStart: string;
  walkForwardEnd: string;
  inSample: InSampleRow[];
  walkForward: Record<string, WalkForwardRow[]>; // keyed by symbol
  monteCarlo: MonteCarloRow[];
}

function renderReport(p: ReportPayload): string {
  const lines: string[] = [];

  lines.push('# TRA-168 final read — TRA-177 consolidated run');
  lines.push('');
  lines.push(`Generated ${p.generatedAt}.`);
  lines.push('');
  lines.push('## Reproduction');
  lines.push('');
  lines.push('```bash');
  lines.push('pnpm --filter @trading-app/backtest build');
  lines.push('pnpm --filter @trading-app/backtest exec tsx src/run-tra177.ts');
  lines.push('```');
  lines.push('');
  lines.push(
    `- **Cost model**: commission ${COMMISSION_BPS} bps + slippage ${SLIPPAGE_BPS} bps, applied per fill (TRA-169).`,
  );
  lines.push(
    `- **In-sample window**: ${p.inSampleStart} → ${p.inSampleEnd} (${IN_SAMPLE_DAYS}d × 1h Coinbase, BTC/ETH/SOL).`,
  );
  lines.push(
    `- **Walk-forward window**: ${p.walkForwardStart} → ${p.walkForwardEnd} ` +
      `(${WALK_FORWARD_DAYS}d × 1h Coinbase). The TRA-177 brief asks for "60d train / 30d test rolling ` +
      'windows (slide every 15d → at least 3 folds)"; that requires more than 90d of data, so the ' +
      `walk-forward leg fetches ${WALK_FORWARD_DAYS}d while the in-sample leg keeps the requested 90d window.`,
  );
  lines.push(
    `- **Monte Carlo**: ${BOOTSTRAP_ITERATIONS} bootstrap iterations on the in-sample closed-trade list ` +
      `(seed=${BOOTSTRAP_SEED}, initial equity ${fmtMoney(INITIAL_EQUITY)}).`,
  );
  lines.push('');

  // ─ In-sample table
  lines.push('## 1. Commission-adjusted in-sample read');
  lines.push('');
  lines.push(
    '| Symbol | Strategy | Trades | Win % | Net P&L | Worst-case P&L | PF | Sharpe | Signal-edge |',
  );
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of p.inSample) {
    lines.push(
      `| ${r.symbol} | ${r.strategy} | ${r.trades} | ` +
        `${r.trades > 0 ? fmtPct(r.winRate) : '—'} | ${fmtMoney(r.totalPnl)} | ${fmtMoney(r.worstCasePnl)} | ` +
        `${fmtPf(r.profitFactor)} | ${r.trades > 0 ? r.sharpe.toFixed(2) : '—'} | ` +
        `${r.signalTotal > 0 ? `${r.signalEdgePct.toFixed(1)}% (${r.signalReached}/${r.signalTotal})` : '—'} |`,
    );
  }
  lines.push('');

  // ─ Walk-forward table per symbol
  lines.push('## 2. Walk-forward OOS read');
  lines.push('');
  lines.push(
    '60d train / 30d test rolling windows, slide=15d. Train picks Sharpe-best params on gross edge; ' +
      'OOS test applies the cost model. Tie-break = trade count when Sharpe ties.',
  );
  lines.push('');
  for (const symbol of SYMBOLS) {
    const rows = p.walkForward[symbol] ?? [];
    lines.push(`### ${symbol}`);
    lines.push('');
    if (rows.length === 0) {
      lines.push('_No folds — insufficient data._');
      lines.push('');
      continue;
    }
    lines.push(
      '| Strategy | Fold | Train | Test | Picked | Train Sharpe (trades) | OOS Sharpe | OOS P&L | OOS Win % | OOS Trades | OOS Edge |',
    );
    lines.push('|---|---:|---|---|---|---|---:|---:|---:|---:|---:|');
    for (const r of rows) {
      lines.push(
        `| ${r.strategy} | ${r.fold} | ${r.trainStart} → ${r.trainEnd} | ${r.testStart} → ${r.testEnd} | ` +
          `${r.pickedParams} | ${r.trainSharpe.toFixed(2)} (${r.trainTrades}) | ` +
          `${r.oosTrades > 0 ? r.oosSharpe.toFixed(2) : '—'} | ${fmtMoney(r.oosPnl)} | ` +
          `${r.oosTrades > 0 ? fmtPct(r.oosWinRate) : '—'} | ${r.oosTrades} | ` +
          `${r.oosSignalEdgePct.toFixed(1)}% |`,
      );
    }
    lines.push('');
  }

  // ─ Monte Carlo table
  lines.push('## 3. Monte Carlo confidence bands (in-sample trades)');
  lines.push('');
  lines.push('| Symbol | Strategy | Trades | Realised P&L | p5 final | p50 final | p95 final | Worst DD |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const r of p.monteCarlo) {
    lines.push(
      `| ${r.symbol} | ${r.strategy} | ${r.trades} | ${fmtMoney(r.realizedPnl)} | ` +
        `${fmtMoney(r.p5)} | ${fmtMoney(r.p50)} | ${fmtMoney(r.p95)} | ${fmtPct(r.worstDrawdown)} |`,
    );
  }
  lines.push('');

  // ─ Notes
  lines.push('## Notes');
  lines.push('');
  lines.push(
    '- `Worst-case P&L` resolves ambiguous OHLC bars (range covers both stop and target) ' +
      'with stop-first instead of target-first. Equal to net P&L when no ambiguous bars occurred.',
  );
  lines.push(
    '- `Signal-edge` is the share of generated signals where price reached ±1R within 24 bars ' +
      'of the signal, regardless of bracket-order plumbing. A fill-independent quality check.',
  );
  lines.push(
    '- Monte Carlo bootstraps the realised closed-trade list 1,000× — it does not invent new edges, ' +
      'only resamples the ones we observed. Treat the band as a *floor* on uncertainty.',
  );
  lines.push(
    '- ATR stops / compounding RiskManager (TRA-171) are out of scope for this read; rerun once they merge.',
  );

  return lines.join('\n') + '\n';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const runner = new BacktestRunner();

  console.log('═'.repeat(110));
  console.log('  TRA-177 — consolidated commission-adjusted real-data + walk-forward + Monte Carlo run');
  console.log('═'.repeat(110));

  const inSampleRows: InSampleRow[] = [];
  const monteCarloRows: MonteCarloRow[] = [];
  const walkForwardBySymbol: Record<string, WalkForwardRow[]> = {};

  let inSampleStartTs = Number.POSITIVE_INFINITY;
  let inSampleEndTs = 0;
  let walkForwardStartTs = Number.POSITIVE_INFINITY;
  let walkForwardEndTs = 0;

  for (const symbol of SYMBOLS) {
    console.log(`\n── ${symbol} ──`);

    console.log(`  fetching ${WALK_FORWARD_DAYS}d × 1h from Coinbase…`);
    const fullCandles = await fetchHourlyFromCoinbase(symbol, WALK_FORWARD_DAYS);
    if (fullCandles.length === 0) {
      console.log(`  ⚠ no candles for ${symbol}; skipping.`);
      continue;
    }
    console.log(`  ${fullCandles.length} bars total.`);

    // The most recent IN_SAMPLE_DAYS form the in-sample leg; the full series
    // feeds walk-forward.
    const inSampleBars = IN_SAMPLE_DAYS * BARS_PER_DAY;
    const inSampleCandles = fullCandles.slice(-inSampleBars);

    inSampleStartTs = Math.min(inSampleStartTs, inSampleCandles[0].timestamp);
    inSampleEndTs = Math.max(inSampleEndTs, inSampleCandles[inSampleCandles.length - 1].timestamp);
    walkForwardStartTs = Math.min(walkForwardStartTs, fullCandles[0].timestamp);
    walkForwardEndTs = Math.max(walkForwardEndTs, fullCandles[fullCandles.length - 1].timestamp);

    // ── 1. In-sample (commission-adjusted) ─────────────────────────────────
    console.log(`  in-sample (last ${IN_SAMPLE_DAYS}d, commission ${COMMISSION_BPS} bps + slip ${SLIPPAGE_BPS} bps):`);
    for (const strat of IN_SAMPLE_STRATEGIES) {
      const { row, trades } = await runInSample(runner, inSampleCandles, symbol, strat);
      inSampleRows.push(row);
      monteCarloRows.push(
        monteCarlo(symbol, strat.name, trades, row.totalPnl),
      );
      console.log(
        `    ${strat.name.padEnd(12)} trades=${String(row.trades).padStart(3)} ` +
          `pnl=${fmtMoney(row.totalPnl).padStart(10)} ` +
          `worst=${fmtMoney(row.worstCasePnl).padStart(10)} ` +
          `sharpe=${row.trades > 0 ? row.sharpe.toFixed(2).padStart(5) : '   —'} ` +
          `edge=${row.signalTotal > 0 ? row.signalEdgePct.toFixed(1) + '%' : '—'}`,
      );
    }

    // ── 2. Walk-forward OOS ────────────────────────────────────────────────
    console.log('  walk-forward (60d/30d slide=15d, costs OOS only):');
    walkForwardBySymbol[symbol] = await runWalkForwardForSymbol(runner, symbol, fullCandles);
    for (const r of walkForwardBySymbol[symbol]) {
      console.log(
        `    [${r.strategy.padEnd(10)} fold ${r.fold}] picked=${r.pickedParams.padEnd(20)} ` +
          `train_sh=${r.trainSharpe.toFixed(2)} (${r.trainTrades}) → ` +
          `oos_sh=${r.oosTrades > 0 ? r.oosSharpe.toFixed(2) : '—'} ` +
          `oos_pnl=${fmtMoney(r.oosPnl).padStart(10)} ` +
          `oos_n=${r.oosTrades}`,
      );
    }
  }

  // ── 3. Render & write report ─────────────────────────────────────────────
  const here = dirname(fileURLToPath(import.meta.url));
  const reportsDir = resolve(here, '..', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const outPath = resolve(reportsDir, 'tra168-final.md');

  const md = renderReport({
    generatedAt: new Date().toISOString(),
    inSampleStart: dateStr(inSampleStartTs),
    inSampleEnd: dateStr(inSampleEndTs),
    walkForwardStart: dateStr(walkForwardStartTs),
    walkForwardEnd: dateStr(walkForwardEndTs),
    inSample: inSampleRows,
    walkForward: walkForwardBySymbol,
    monteCarlo: monteCarloRows,
  });
  writeFileSync(outPath, md);

  console.log('\n' + '═'.repeat(110));
  console.log(`  Report → ${outPath}`);
  console.log('═'.repeat(110));
}

const invoked = process.argv[1] && /run-tra177\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch(err => { console.error(err); process.exit(1); });
