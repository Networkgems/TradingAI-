/**
 * TRA-731 (Phase 2) — unified synthetic-chain backtest harness runner for
 * SupertrendConfluence. Offline-reproducible: reads the cached equity bars from
 * `packages/backtest/data/<symbol>.json` (warm them once with
 * `run-tra731-fetch.js`) and makes NO network calls.
 *
 * Everything it emits is tagged SYNTHETIC — synthetic chains bake in our own
 * IV/pricing assumptions, so these numbers are a directional/sanity gate, NOT a
 * substitute for live-chain validation (see TRA-729 §3 caveat).
 *
 * Run (after `pnpm --filter @trading-app/backtest build`):
 *   node packages/backtest/dist/run-tra731.js                 # Track A + Track B (default params)
 *   node packages/backtest/dist/run-tra731.js --sweep         # + sensitivity sweep grid
 *   node packages/backtest/dist/run-tra731.js --gen-chains    # also write synthetic chains to disk
 *                                                             #   (for the OTM/RV --synthetic path)
 *   node packages/backtest/dist/run-tra731.js --months 18 --out-dir ./data/tra731-reports
 *
 * `enableSupertrend` live routing is UNCHANGED by this runner — it is analysis only.
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { Candle } from '@trading-app/shared';
import { SUPERTREND_DEFAULT_PERIOD } from '@trading-app/engine';
import { TRA731_UNIVERSE, lookbackWindow } from './run-tra731-fetch.js';
import { cachePathFor } from './fetch-tra266-data.js';
import { runTrackA, type TrackAReport } from './tra731-track-a.js';
import {
  replayPortfolio,
  DEFAULT_REPLAY_PARAMS,
  type SupertrendReplayParams,
  type PortfolioReplayResult,
} from './supertrend-confluence-replay.js';
import { buildSyntheticChain, SYNTHETIC_TAG, type SyntheticChainFile } from './synthetic-chain.js';
import type { TradeMetrics } from './tra731-metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');

interface CacheEntryShape {
  symbol: string;
  candles: Candle[];
}

/** Read a symbol's cached daily bars (offline), filtered to the lookback window. */
async function loadCachedBars(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const path = cachePathFor(symbol);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    throw new Error(
      `No cached bars for ${symbol} at ${path}. Run run-tra731-fetch.js first to warm the cache.`,
    );
  }
  const parsed = JSON.parse(raw) as CacheEntryShape;
  return (parsed.candles ?? []).filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
}

async function loadUniverse(months: number): Promise<Map<string, Candle[]>> {
  const { fromMs, toMs } = lookbackWindow(months);
  const out = new Map<string, Candle[]>();
  for (const symbol of TRA731_UNIVERSE) {
    out.set(symbol, await loadCachedBars(symbol, fromMs, toMs));
  }
  return out;
}

// ── Synthetic-chain disk export (feeds the OTM/RV `--synthetic` replay path) ──

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Write a point-in-time synthetic chain per bar under
 * `<outDir>/synthetic-chains/<YYYY-MM-DD>/<SYMBOL>.json` in the recorder's
 * `OptionChainSnapshotFile` schema, so `run-options-replay --synthetic` (the OTM /
 * RV scanners) consumes them unchanged. Returns the count of files written.
 */
async function writeSyntheticChains(
  barsBySymbol: ReadonlyMap<string, readonly Candle[]>,
  outDir: string,
  everyNBars: number,
): Promise<number> {
  const root = join(outDir, 'synthetic-chains');
  let written = 0;
  for (const [symbol, bars] of barsBySymbol) {
    for (let i = 0; i < bars.length; i += everyNBars) {
      const file: SyntheticChainFile | null = buildSyntheticChain(symbol, bars.slice(0, i + 1));
      if (!file) continue;
      const dir = join(root, isoDate(bars[i].timestamp));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${symbol}.json`), JSON.stringify(file), 'utf-8');
      written += 1;
    }
  }
  return written;
}

// ── Report builders ──────────────────────────────────────────────────────────

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const num = (v: number, dp = 2): string => v.toFixed(dp);

function buildTrackAMarkdown(report: TrackAReport): string {
  const md: string[] = [];
  md.push('# TRA-731 Track A — equity-signal validation (SupertrendConfluence)');
  md.push('');
  md.push(`Methodology-independent kill-switch. ${report.horizonBars}-bar scoring horizon.`);
  md.push('');
  md.push('## Pooled (universe)');
  md.push('');
  md.push('| Stream | Signals | Hit-rate | Avg R |');
  md.push('| --- | ---: | ---: | ---: |');
  md.push(`| SupertrendConfluence | ${report.supertrend.totalSignals} | ${pct(report.supertrend.winRate)} | ${num(report.supertrend.avgRR)}R |`);
  md.push(`| macd-trend (baseline) | ${report.macdTrend.totalSignals} | ${pct(report.macdTrend.winRate)} | ${num(report.macdTrend.avgRR)}R |`);
  md.push(`| **Edge (ST − macd)** | — | ${pct(report.edgeVsMacd.winRateDelta)} | ${num(report.edgeVsMacd.avgRDelta)}R |`);
  md.push('');
  md.push(`Mean buy-and-hold (delta-equivalent) return across universe: **${pct(report.avgBuyHoldReturnPct)}**`);
  md.push('');
  md.push('## Per-symbol');
  md.push('');
  md.push('| Symbol | Bars | ST signals | ST hit | ST avgR | macd signals | macd hit | macd avgR | BuyHold ret | BuyHold Sharpe | BuyHold maxDD |');
  md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of report.perSymbol) {
    md.push(
      `| ${s.symbol} | ${s.bars} | ${s.supertrend.totalSignals} | ${pct(s.supertrend.winRate)} | ${num(s.supertrend.avgRR)} | ` +
        `${s.macdTrend.totalSignals} | ${pct(s.macdTrend.winRate)} | ${num(s.macdTrend.avgRR)} | ` +
        `${pct(s.buyHold.totalReturnPct)} | ${num(s.buyHold.annualizedSharpe)} | ${pct(s.buyHold.maxDrawdownPct)} |`,
    );
  }
  md.push('');
  return md.join('\n') + '\n';
}

function metricsRow(label: string, m: TradeMetrics): string {
  return (
    `| ${label} | ${m.trades} | ${pct(m.winRate)} | ${num(m.profitFactor)} | ${num(m.avgR)}R | ` +
    `${num(m.sharpe)} | ${num(m.sortino)} | ${num(m.maxDrawdownR)}R | $${num(m.totalPnl)} |`
  );
}

function buildTrackBMarkdown(result: PortfolioReplayResult, months: number): string {
  const md: string[] = [];
  md.push('# TRA-731 Track B — SYNTHETIC-chain options replay (SupertrendConfluence)');
  md.push('');
  md.push(
    `> **SYNTHETIC DATA.** Chains are Black-Scholes priced from ~${months}mo equity bars + a ` +
      'realized-vol/term-structure IV model. PF here is WEAKER evidence than a recorded-chain ' +
      'replay — directional/sanity gate only (TRA-729 §3).',
  );
  md.push('');
  md.push('Single long contract per trade (1×), so metrics reflect the pure signal + structure edge.');
  md.push(`Per-trade R = pnl / (entryPremium × |premiumStop| × multiplier). Suppressed signals: ${result.totalSuppressed}.`);
  md.push('');
  md.push('## Portfolio (pooled trades)');
  md.push('');
  md.push('| Scope | Trades | Win rate | PF | Avg R | Sharpe | Sortino | Max DD (R) | Total P&L |');
  md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  md.push(metricsRow('ALL', result.metrics));
  md.push('');
  md.push('## Per-symbol');
  md.push('');
  md.push('| Symbol | Trades | Win rate | PF | Avg R | Sharpe | Sortino | Max DD (R) | Total P&L | Suppressed |');
  md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of result.perSymbol) {
    md.push(metricsRow(s.symbol, s.metrics) + ` ${s.suppressedSignals} |`);
  }
  md.push('');
  return md.join('\n') + '\n';
}

// ── Sensitivity sweep ──────────────────────────────────────────────────────────

interface SweepCell {
  supertrendPeriod: number;
  supertrendFactor: number;
  rsiLow: number;
  rsiHigh: number;
  ivRankCutoff: number;
  expiryTargetDays: number;
  deltaTarget: number;
  metrics: TradeMetrics;
  trades: number;
}

const SWEEP_GRID = {
  supertrend: [
    { period: 7, factor: 3 },
    { period: SUPERTREND_DEFAULT_PERIOD, factor: 3 },
  ],
  rsiBands: [
    [50, 70],
    [55, 70],
  ] as Array<[number, number]>,
  ivRankCutoffs: [50, 60, 70],
  expiryTargets: [14, 21, 28],
  deltaTargets: [0.6, 0.65, 0.7],
};

function runSweep(barsBySymbol: ReadonlyMap<string, readonly Candle[]>): SweepCell[] {
  const cells: SweepCell[] = [];
  for (const st of SWEEP_GRID.supertrend) {
    for (const band of SWEEP_GRID.rsiBands) {
      for (const cutoff of SWEEP_GRID.ivRankCutoffs) {
        for (const expTarget of SWEEP_GRID.expiryTargets) {
          for (const deltaTarget of SWEEP_GRID.deltaTargets) {
            const params: SupertrendReplayParams = {
              ...DEFAULT_REPLAY_PARAMS,
              confluence: {
                ...DEFAULT_REPLAY_PARAMS.confluence,
                supertrend: { period: st.period, factor: st.factor },
                rsiLongBand: band,
              },
              ivGate: { ...DEFAULT_REPLAY_PARAMS.ivGate, verticalMinIvRank: cutoff },
              expiry: {
                ...DEFAULT_REPLAY_PARAMS.expiry,
                targetDays: expTarget,
                minDays: Math.max(7, expTarget - 7),
                maxDays: expTarget + 7,
              },
              delta: {
                target: deltaTarget,
                band: [Math.max(0.5, deltaTarget - 0.05), Math.min(0.85, deltaTarget + 0.05)],
              },
            };
            const result = replayPortfolio(barsBySymbol, params);
            cells.push({
              supertrendPeriod: st.period,
              supertrendFactor: st.factor,
              rsiLow: band[0],
              rsiHigh: band[1],
              ivRankCutoff: cutoff,
              expiryTargetDays: expTarget,
              deltaTarget,
              metrics: result.metrics,
              trades: result.totalTrades,
            });
          }
        }
      }
    }
  }
  return cells;
}

function buildSweepCsv(cells: readonly SweepCell[]): string {
  const lines: string[] = [];
  lines.push(
    'source,supertrendPeriod,supertrendFactor,rsiLow,rsiHigh,ivRankCutoff,expiryTargetDays,deltaTarget,trades,winRate,profitFactor,avgR,sharpe,sortino,maxDrawdownR,totalPnl',
  );
  for (const c of cells) {
    lines.push(
      [
        SYNTHETIC_TAG,
        c.supertrendPeriod,
        c.supertrendFactor,
        c.rsiLow,
        c.rsiHigh,
        c.ivRankCutoff,
        c.expiryTargetDays,
        c.deltaTarget,
        c.trades,
        c.metrics.winRate.toFixed(4),
        c.metrics.profitFactor.toFixed(4),
        c.metrics.avgR.toFixed(4),
        c.metrics.sharpe.toFixed(4),
        c.metrics.sortino.toFixed(4),
        c.metrics.maxDrawdownR.toFixed(4),
        c.metrics.totalPnl.toFixed(2),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const months = parseArg('months') ? Number(parseArg('months')) : 18;
  const outDir = parseArg('out-dir') ?? join(DATA_DIR, 'tra731-reports');
  const doSweep = hasFlag('sweep');
  const doGenChains = hasFlag('gen-chains');

  console.log(`[TRA-731] loading cached bars for ${TRA731_UNIVERSE.join(', ')} (${months}mo)`);
  const barsBySymbol = await loadUniverse(months);
  for (const [sym, bars] of barsBySymbol) {
    if (bars.length === 0) {
      console.error(`[TRA-731] ${sym}: 0 cached bars — run run-tra731-fetch.js first.`);
      process.exit(2);
    }
  }

  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  // Track A.
  console.log('[TRA-731] Track A — equity-signal validation…');
  const trackA = runTrackA(barsBySymbol);
  const trackAMd = buildTrackAMarkdown(trackA);
  await writeFile(join(outDir, `track-a-${stamp}.md`), trackAMd, 'utf-8');
  console.log(
    `  SupertrendConfluence: ${trackA.supertrend.totalSignals} signals, ` +
      `${(trackA.supertrend.winRate * 100).toFixed(1)}% hit, ${trackA.supertrend.avgRR.toFixed(2)}R · ` +
      `edge vs macd ${trackA.edgeVsMacd.avgRDelta.toFixed(2)}R`,
  );

  // Track B (default params).
  console.log('[TRA-731] Track B — synthetic-chain options replay (default params)…');
  const trackB = replayPortfolio(barsBySymbol, DEFAULT_REPLAY_PARAMS);
  const trackBMd = buildTrackBMarkdown(trackB, months);
  await writeFile(join(outDir, `track-b-${stamp}.md`), trackBMd, 'utf-8');
  console.log(
    `  ${trackB.totalTrades} trades · PF ${trackB.metrics.profitFactor.toFixed(2)} · ` +
      `win ${(trackB.metrics.winRate * 100).toFixed(1)}% · Sharpe ${trackB.metrics.sharpe.toFixed(2)} · ` +
      `Sortino ${trackB.metrics.sortino.toFixed(2)} · maxDD ${trackB.metrics.maxDrawdownR.toFixed(2)}R`,
  );

  // Optional sweep.
  if (doSweep) {
    console.log('[TRA-731] sensitivity sweep…');
    const cells = runSweep(barsBySymbol);
    await writeFile(join(outDir, `sweep-${stamp}.csv`), buildSweepCsv(cells), 'utf-8');
    const best = cells.reduce((b, c) => (c.metrics.profitFactor > b.metrics.profitFactor ? c : b));
    console.log(
      `  ${cells.length} cells · best PF ${best.metrics.profitFactor.toFixed(2)} ` +
        `(ST ${best.supertrendPeriod}/${best.supertrendFactor}, RSI ${best.rsiLow}-${best.rsiHigh}, ` +
        `IVrank<${best.ivRankCutoff}, exp ${best.expiryTargetDays}d, Δ ${best.deltaTarget})`,
    );
  }

  // Optional synthetic-chain disk export for the OTM/RV `--synthetic` path.
  if (doGenChains) {
    const every = parseArg('chain-stride') ? Number(parseArg('chain-stride')) : 5;
    console.log(`[TRA-731] writing synthetic chains to disk (every ${every} bars)…`);
    const written = await writeSyntheticChains(barsBySymbol, outDir, every);
    console.log(`  ${written} synthetic chain file(s) under ${join(outDir, 'synthetic-chains')}`);
  }

  console.log(`[TRA-731] reports → ${outDir}`);
}

const invoked = process.argv[1] && /[\\/]run-tra731\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
