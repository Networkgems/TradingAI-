/**
 * Sweep-and-reclaim swing study — CLI runner.
 *
 * Offline by default: reads the frozen TRA-4386 daily cache
 * (`packages/backtest/data/tra4386-daily/*.json`, 26 symbols × ~501 sessions,
 * Yahoo, dividend/split adjusted). `--tradier` instead pulls `--bars` daily
 * bars per symbol from Tradier `/markets/history` (needs TRADIER_ACCESS_TOKEN;
 * TRADIER_ENV=production|sandbox, default sandbox) and caches them under
 * `--out-data` so the run is reproducible afterwards.
 *
 *   pnpm --filter @trading-app/engine build && pnpm --filter @trading-app/backtest build
 *   node packages/backtest/dist/run-sweep-reclaim.js                     # frozen cache
 *   node packages/backtest/dist/run-sweep-reclaim.js --json out.json     # + machine-readable report
 *   TRADIER_ACCESS_TOKEN=… TRADIER_ENV=production \
 *     node packages/backtest/dist/run-sweep-reclaim.js --tradier --bars 2500 --symbols AAPL,MSFT,SPY
 *
 * ⚠ The verdict criteria are the PRE-REGISTERED ones in `PREREG` / `VARIANTS`
 * below, fixed before the first run on real bars (see
 * docs/sweep-reclaim-study.md). Changing a parameter and re-running until
 * something passes is the overfitting this file exists to prevent: a new
 * parameter set is a new study with its own pre-registration and its own
 * multiple-testing correction.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { TradierStocksClient } from '@trading-app/engine';
import type { SweepReclaimOptions } from '@trading-app/engine';
import { runVariant, BRACKET_DEFAULTS, type PreRegistration, type VariantReport } from './sweep-reclaim-backtest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA = resolve(HERE, '..', 'data', 'tra4386-daily');

/** k = 2 variants, declared before the first real-data run. Defaults otherwise. */
export const VARIANTS: ReadonlyArray<{ name: string; options: SweepReclaimOptions }> = [
  { name: 'V1_no_trend_filter', options: { trendFilter: 'none' } },
  { name: 'V2_sma200_trend_filter', options: { trendFilter: 'sma200' } },
];

/**
 * PASS requires ALL of: n ≥ 100 trades; the date-clustered bootstrap CI of
 * mean net R excludes 0 at two-sided α = 0.05 / k = 0.025; the real book's
 * mean beats ≥ 95% of 500 random-entry placebo books with identical bracket
 * geometry; mean net R > 0 in BOTH chronological halves.
 */
export const PREREG: PreRegistration = { minTrades: 100, ciAlpha: 0.05 / VARIANTS.length, placeboPercentile: 0.95 };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function loadCacheDir(dir: string, only?: Set<string>): Map<string, Candle[]> {
  const out = new Map<string, Candle[]>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const raw = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as {
      symbol: string;
      bars?: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
      candles?: Candle[];
    };
    if (only && !only.has(raw.symbol)) continue;
    const candles: Candle[] = raw.candles
      ? raw.candles
      : (raw.bars ?? []).map((b) => ({
          symbol: raw.symbol,
          timestamp: Date.parse(`${b.date}T00:00:00Z`),
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        }));
    out.set(raw.symbol, candles.filter((c) => c.high >= c.low && c.open > 0 && c.close > 0));
  }
  return out;
}

async function loadTradier(symbols: string[], bars: number, outDir: string): Promise<Map<string, Candle[]>> {
  const token = process.env.TRADIER_ACCESS_TOKEN;
  if (!token) throw new Error('--tradier needs TRADIER_ACCESS_TOKEN');
  const env = process.env.TRADIER_ENV === 'production' ? 'production' : 'sandbox';
  const client = new TradierStocksClient(token, env);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const out = new Map<string, Candle[]>();
  for (const sym of symbols) {
    const cs = await client.getDailyBars(sym, bars);
    console.log(`  ${sym}: ${cs.length} bars from Tradier (${env})`);
    writeFileSync(resolve(outDir, `${sym}.json`), JSON.stringify({ symbol: sym, fetchedAt: Date.now(), candles: cs }));
    out.set(sym, cs);
    await new Promise((r) => setTimeout(r, 600)); // ≤ ~100 req/min
  }
  return out;
}

const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined ? '—' : x.toFixed(d));

export function formatReport(r: VariantReport): string {
  const lines = [
    `── ${r.name} ─ verdict: ${r.verdict}${r.failedCriteria.length ? ` (${r.failedCriteria.join('; ')})` : ''}`,
    `   signals ${r.signals} · trades ${r.all.n} · skips ${JSON.stringify(r.skips)}`,
    `   net meanR ${f(r.all.meanR)} (gross ${f(r.grossMeanR)}) · median ${f(r.all.medianR)} · win ${f(r.all.winRate, 2)} · PF ${f(r.all.profitFactor, 2)} · totalR ${f(r.all.totalR, 1)}`,
    `   clustered CI(${(1 - PREREG.ciAlpha) * 100}%) [${f(r.ci.lower)}, ${f(r.ci.upper)}] over ${r.ci.clusters} entry days`,
    `   long  n=${r.bySide.long.n} meanR ${f(r.bySide.long.meanR)} · short n=${r.bySide.short.n} meanR ${f(r.bySide.short.meanR)}`,
    `   halves: first n=${r.halves.first.n} ${f(r.halves.first.meanR)} · second n=${r.halves.second.n} ${f(r.halves.second.meanR)}`,
    `   placebo (${r.placebo.draws} books): mean ${f(r.placebo.mean)} · p95 ${f(r.placebo.p95)} · real beats ${f((r.placebo.percentileOfReal ?? NaN) * 100, 1)}%`,
    `   fwd 5-session (non-overlap): n=${r.forward5.n} mean ${f(r.forward5.meanBp, 1)}bp t=${f(r.forward5.t, 2)}`,
    `   exits ${JSON.stringify(r.exitReasons)}`,
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const only = arg('symbols')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const universe = process.argv.includes('--tradier')
    ? await loadTradier(only ?? [], Number(arg('bars') ?? 2500), resolve(arg('out-data') ?? resolve(HERE, '..', 'data', 'sweep-reclaim-tradier')))
    : loadCacheDir(resolve(arg('data') ?? DEFAULT_DATA), only ? new Set(only) : undefined);
  if (universe.size === 0) throw new Error('empty universe');
  const lens = [...universe.values()].map((c) => c.length);
  console.log(
    `[sweep-reclaim] ${universe.size} symbols · ${Math.min(...lens)}–${Math.max(...lens)} bars · ` +
      `bracket ${JSON.stringify(BRACKET_DEFAULTS)} · prereg ${JSON.stringify(PREREG)}`,
  );
  const reports = VARIANTS.map((v) => runVariant(v.name, universe, v.options, PREREG));
  for (const r of reports) console.log(formatReport(r));
  const json = arg('json');
  if (json) writeFileSync(json, JSON.stringify({ ranAt: new Date().toISOString(), prereg: PREREG, bracket: BRACKET_DEFAULTS, reports }, null, 2));
}

const invoked = process.argv[1] && /[\\/]run-sweep-reclaim\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
