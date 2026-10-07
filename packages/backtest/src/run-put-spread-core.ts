/**
 * CORE put-credit-spread study — CLI runner (see docs/core-put-spread.md).
 *
 *   pnpm --filter @trading-app/engine build && pnpm --filter @trading-app/backtest build
 *   node packages/backtest/dist/run-put-spread-core.js                 # SPY + ^VIX from Yahoo, 2007 → today
 *   node packages/backtest/dist/run-put-spread-core.js --symbol QQQ --vix ^VXN
 *   node packages/backtest/dist/run-put-spread-core.js --spy-csv spy.csv --vix-csv vix.csv   # offline: date,open,high,low,close[,volume]
 *   ... --json out.json
 *
 * The first two network runs cache bars under packages/backtest/data/ (the
 * TRA-266 loader), so later runs are offline and reproducible.
 *
 * ⚠ VARIANTS and PREREG are fixed BEFORE the first real-data run. Re-running
 * with tweaked rules until one passes is overfitting; a new rule set is a new,
 * separately registered study.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { Candle } from '@trading-app/shared';
import { loadOrFetchDailyBars } from './fetch-tra266-data.js';
import {
  CORE_COSTS,
  CORE_RULES,
  joinSpyVix,
  simulatePutSpreads,
  summarize,
  type CoreReport,
  type PutSpreadRules,
  type SpreadTrade,
} from './put-spread-core.js';
import { clusteredBootstrapMeanCI } from './sweep-reclaim-backtest.js';

/** k = 2, declared before first contact with real bars. */
export const VARIANTS: ReadonlyArray<{ name: string; rules: PutSpreadRules }> = [
  { name: 'V1_managed_50pct_21dte_2xstop', rules: CORE_RULES },
  {
    name: 'V2_hold_to_expiry',
    rules: { ...CORE_RULES, takeProfitFrac: 0.999, stopLossMultiple: 1e9, exitAtDte: -1 },
  },
];

export interface CorePrereg {
  minTrades: number;
  /** Two-sided α after Bonferroni over k variants, on mean return-on-risk, MONTH-clustered. */
  ciAlpha: number;
  /** Share of calendar years with positive P&L. */
  minPositiveYearShare: number;
  /** Max drawdown as a share of the capital the variant ties up. */
  maxDrawdownShare: number;
}

export const PREREG: CorePrereg = {
  minTrades: 200,
  ciAlpha: 0.05 / VARIANTS.length,
  minPositiveYearShare: 0.6,
  maxDrawdownShare: 0.5,
};

export interface VariantVerdict {
  name: string;
  report: CoreReport;
  ci: { lower: number | null; upper: number | null; clusters: number };
  positiveYearShare: number | null;
  stress: Array<{ label: string; pnlUsd: number; worstTradeUsd: number | null; n: number }>;
  verdict: 'PASS' | 'FAIL' | 'UNDERPOWERED';
  failed: string[];
}

const STRESS_WINDOWS: Array<{ label: string; from: string; to: string }> = [
  { label: '2008 GFC', from: '2008-09-01', to: '2009-03-31' },
  { label: '2018 Volmageddon', from: '2018-01-15', to: '2018-03-31' },
  { label: '2020 COVID', from: '2020-02-15', to: '2020-04-30' },
  { label: '2022 bear', from: '2022-01-01', to: '2022-10-31' },
];

export function gradeVariant(name: string, trades: SpreadTrade[], rules: PutSpreadRules, prereg: CorePrereg = PREREG): VariantVerdict {
  const report = summarize(trades, rules);
  // Spreads overlap and share market moves; cluster by ENTRY MONTH.
  const monthTs = (ts: number) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const ci = clusteredBootstrapMeanCI(trades.map((t) => ({ entryTs: monthTs(t.entryTs), netR: t.returnOnRisk })), { alpha: prereg.ciAlpha, seed: 11 });
  const years = report.byYear;
  const positiveYearShare = years.length ? years.filter((y) => y.pnlUsd > 0).length / years.length : null;
  const stress = STRESS_WINDOWS.map((w) => {
    const a = Date.parse(`${w.from}T00:00:00Z`);
    const b = Date.parse(`${w.to}T23:59:59Z`);
    const ts = trades.filter((t) => t.exitTs >= a && t.exitTs <= b);
    return { label: w.label, n: ts.length, pnlUsd: ts.reduce((x, t) => x + t.pnlUsd, 0), worstTradeUsd: ts.length ? Math.min(...ts.map((t) => t.pnlUsd)) : null };
  });
  const failed: string[] = [];
  if (report.n < prereg.minTrades) failed.push(`n ${report.n} < ${prereg.minTrades}`);
  if (!(ci.lower !== null && ci.lower > 0)) failed.push(`return-on-risk CI lower ${ci.lower?.toFixed(4)} <= 0`);
  if (!(report.totalPnlUsd > 0)) failed.push('total P&L <= 0');
  if (!(positiveYearShare !== null && positiveYearShare >= prereg.minPositiveYearShare)) failed.push(`positive years ${positiveYearShare?.toFixed(2)} < ${prereg.minPositiveYearShare}`);
  if (!(report.maxDrawdownPctOfCapital !== null && report.maxDrawdownPctOfCapital <= prereg.maxDrawdownShare)) failed.push(`max drawdown ${report.maxDrawdownPctOfCapital?.toFixed(2)} of capital > ${prereg.maxDrawdownShare}`);
  const verdict = report.n < prereg.minTrades ? 'UNDERPOWERED' : failed.length ? 'FAIL' : 'PASS';
  return { name, report, ci, positiveYearShare, stress, verdict, failed };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function readCsv(path: string, symbol: string): Candle[] {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const out: Candle[] = [];
  for (const line of lines.slice(1)) {
    const [date, open, high, low, close, volume] = line.split(',');
    const ts = Date.parse(`${date.trim()}T00:00:00Z`);
    const c = Number(close);
    if (Number.isFinite(ts) && c > 0) out.push({ symbol, timestamp: ts, open: Number(open), high: Number(high), low: Number(low), close: c, volume: Number(volume ?? 0) });
  }
  return out;
}

const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '—' : x.toFixed(d));

async function main(): Promise<void> {
  const symbol = (arg('symbol') ?? 'SPY').toUpperCase();
  const vixSym = arg('vix') ?? '^VIX';
  const from = Date.parse(`${arg('from') ?? '2007-01-01'}T00:00:00Z`);
  const to = Date.now();
  const spy = arg('spy-csv') ? readCsv(arg('spy-csv')!, symbol) : await loadOrFetchDailyBars(symbol, from, to);
  const vix = arg('vix-csv') ? readCsv(arg('vix-csv')!, vixSym) : await loadOrFetchDailyBars(vixSym, from, to);
  const bars = joinSpyVix(spy, vix);
  if (bars.length < 500) throw new Error(`only ${bars.length} joined bars — need years of ${symbol} + ${vixSym}`);
  console.log(`[core] ${symbol} + ${vixSym}: ${bars.length} days ${new Date(bars[0].ts).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].ts).toISOString().slice(0, 10)}`);
  console.log(`[core] costs ${JSON.stringify(CORE_COSTS)} · prereg ${JSON.stringify(PREREG)}`);
  const out: VariantVerdict[] = [];
  for (const v of VARIANTS) {
    const { trades } = simulatePutSpreads(bars, v.rules, CORE_COSTS);
    const g = gradeVariant(v.name, trades, v.rules);
    out.push(g);
    const r = g.report;
    console.log(`\n── ${g.name}: ${g.verdict}${g.failed.length ? ` (${g.failed.join('; ')})` : ''}`);
    console.log(`   trades ${r.n} · win ${f((r.winRate ?? 0) * 100, 1)}% · avg win $${f(r.avgWinUsd)} · avg loss $${f(r.avgLossUsd)} · worst $${f(r.worstTradeUsd)}`);
    console.log(`   total $${f(r.totalPnlUsd)} on capital $${f(r.capitalUsd)} (${VARIANTS[0].rules.maxOpen} spreads) · ${f((r.annualReturnOnCapital ?? 0) * 100, 1)}%/yr · max DD $${f(r.maxDrawdownUsd)} (${f((r.maxDrawdownPctOfCapital ?? 0) * 100, 1)}% of capital)`);
    console.log(`   mean return-on-risk ${f((r.meanReturnOnRisk ?? 0) * 100, 2)}% · month-clustered CI [${f((g.ci.lower ?? NaN) * 100, 2)}%, ${f((g.ci.upper ?? NaN) * 100, 2)}%] · positive years ${f((g.positiveYearShare ?? 0) * 100, 0)}%`);
    console.log(`   exits ${JSON.stringify(r.exits)}`);
    for (const s of g.stress) console.log(`   stress ${s.label}: n=${s.n} P&L $${f(s.pnlUsd)} worst $${f(s.worstTradeUsd)}`);
    console.log(`   by year: ${r.byYear.map((y) => `${y.year}:${y.pnlUsd >= 0 ? '+' : ''}${y.pnlUsd.toFixed(0)}`).join(' ')}`);
  }
  const json = arg('json');
  if (json) writeFileSync(json, JSON.stringify({ ranAt: new Date().toISOString(), symbol, vixSym, costs: CORE_COSTS, prereg: PREREG, variants: out }, null, 2));
}

const invoked = process.argv[1] && /[\\/]run-put-spread-core\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
