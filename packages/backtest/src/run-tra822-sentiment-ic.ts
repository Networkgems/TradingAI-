/**
 * TRA-822 (TRA-820 Step 1) — offline StockTwits sentiment IC / flow harness.
 *
 * Joins the forward-collected sentiment snapshots (TRA-822 server recorder) with
 * the TRA-376 option-chain snapshots and daily candles, runs the §3 metrics, and
 * grades them against the §4 verdict gate from
 * `docs/stocktwits-signal-study-TRA-820.md`. Emits a committed JSON + Markdown
 * report under `reports/`.
 *
 * This is a RESEARCH harness: it only reads on-disk snapshots + the public daily
 * feed and writes a report. It promotes nothing and wires no live trade — per
 * the TRA-820 acceptance criterion no options entry is gated off StockTwits
 * until a positive Step-1 result clears this gate.
 *
 * Until ~20 trading days of snapshots have co-accumulated (the recorder only
 * just shipped) the join is empty and the harness correctly reports
 * INCONCLUSIVE — "keep collecting". That empty run is the end-to-end proof that
 * the pipeline is wired; the real verdict is written once the sample bar is met.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra822-sentiment-ic.ts
 * Env:
 *   SENTIMENT_DIR   sentiment-snapshot root (default ./data/sentiment-snapshots)
 *   CHAINS_DIR      option-chain snapshot root (default ./data/option-chains)
 *   TRA822_NO_FETCH=1  skip the daily-candle fetch (offline smoke)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { EQUITIES_WATCHLIST } from '@trading-app/shared';
import { loadOrFetchDailyBars } from './fetch-tra266-data.js';
import { loadSentimentDays } from './sentiment-snapshot-store.js';
import { loadChainDays, estimateSpotFromChain } from './options-chain-store.js';
import {
  netOTMflow,
  rawForwardReturns,
  deMarket,
  runSentimentStudy,
  HORIZONS,
  MIN_TAGGED,
  MAX_FRESHNESS_MIN,
  type SentimentSymbolDay,
  type Horizon,
  type DatedBar,
  type StudyReport,
} from './sentiment-ic-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');
const PKG_ROOT = resolve(HERE, '..');

const SENTIMENT_DIR = process.env['SENTIMENT_DIR'] ?? resolve(PKG_ROOT, 'data', 'sentiment-snapshots');
const CHAINS_DIR = process.env['CHAINS_DIR'] ?? resolve(PKG_ROOT, 'data', 'option-chains');
const NO_FETCH = process.env['TRA822_NO_FETCH'] === '1';

/** Index/ETF names — kept for a sanity baseline but excluded from the gate set. */
const ETF_NAMES = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'XLF']);

/** Trading-date label for a daily candle (UTC date == the ET trading day). */
function candleDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  console.log('TRA-822 sentiment IC / flow harness');
  console.log(`  sentiment dir: ${SENTIMENT_DIR}`);
  console.log(`  chains dir:    ${CHAINS_DIR}`);

  const sentimentDays = await loadSentimentDays(SENTIMENT_DIR);
  const chainDays = await loadChainDays(CHAINS_DIR);
  console.log(`  loaded ${sentimentDays.length} sentiment day(s), ${chainDays.length} chain day(s)`);

  // Universe = recorded single-name symbols ∩ study watchlist. ETFs are tracked
  // separately (sanity baseline), never in the gate set.
  const recorded = new Set<string>();
  for (const d of sentimentDays) for (const s of d.bySymbol.keys()) recorded.add(s);
  const studyUniverse = [...EQUITIES_WATCHLIST].filter(
    (s) => !ETF_NAMES.has(s) && (recorded.size === 0 || recorded.has(s)),
  );
  const etfUniverse = [...EQUITIES_WATCHLIST].filter((s) => ETF_NAMES.has(s) && recorded.has(s));

  // Chain snapshots indexed by date → symbol for the flow join.
  const chainByDate = new Map<string, (typeof chainDays)[number]['bySymbol']>();
  for (const c of chainDays) chainByDate.set(c.date, c.bySymbol);

  // Per-symbol daily bars (skipped entirely when there are no signal days, so
  // the empty smoke stays fully offline).
  const barsBySymbol = new Map<string, DatedBar[]>();
  const allSymbols = [...studyUniverse, ...etfUniverse];
  // TRA-2076 — bar-fetch failures must reach the report payload. A `console.warn`
  // that nobody reads is not an instrument: the routine that grades this run
  // reads the JSON, and a rate-limited daily feed silently produces the same
  // all-`fwd`-null state as TRA822_NO_FETCH=1.
  const barFetchFailures: { symbol: string; message: string }[] = [];
  if (sentimentDays.length > 0 && !NO_FETCH) {
    const dates = sentimentDays.map((d) => d.date).sort();
    const fromMs = Date.parse(`${dates[0]}T00:00:00Z`) - 5 * 86_400_000;
    // +40 calendar days past the last signal day so the 20d horizon has bars.
    const toMs = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + 45 * 86_400_000;
    for (const sym of allSymbols) {
      try {
        const candles: Candle[] = await loadOrFetchDailyBars(sym, fromMs, toMs);
        const bars = candles
          .map((c) => ({ date: candleDateKey(c.timestamp), open: c.open, close: c.close }))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        barsBySymbol.set(sym, bars);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        barFetchFailures.push({ symbol: sym, message });
        console.warn(`  bars fetch failed for ${sym}: ${message}`);
      }
    }
  }

  // ── assemble the (de-market) symbol-day set ────────────────────────────────
  // Raw forward returns per symbol, keyed `${date}|${symbol}`, then de-market.
  const signalDatesBySymbol = new Map<string, string[]>();
  for (const day of sentimentDays) {
    for (const sym of day.bySymbol.keys()) {
      if (!allSymbols.includes(sym)) continue;
      const arr = signalDatesBySymbol.get(sym);
      if (arr) arr.push(day.date);
      else signalDatesBySymbol.set(sym, [day.date]);
    }
  }

  const rawByKey = new Map<string, Record<Horizon, number | null>>();
  for (const [sym, dates] of signalDatesBySymbol) {
    const bars = barsBySymbol.get(sym) ?? [];
    const fwd = rawForwardReturns(dates, bars);
    for (const [date, rec] of fwd) rawByKey.set(`${date}|${sym}`, rec);
  }
  const demarketed = deMarket(rawByKey);

  const symbolDays: SentimentSymbolDay[] = [];
  for (const day of sentimentDays) {
    for (const [sym, sent] of day.bySymbol) {
      if (!studyUniverse.includes(sym)) continue; // gate set = single names only
      const chainRows = chainByDate.get(day.date)?.get(sym);
      let flow: number | null = null;
      if (chainRows) {
        const spot =
          chainRows.spot && chainRows.spot > 0 ? chainRows.spot : estimateSpotFromChain(chainRows.rows);
        flow = netOTMflow(chainRows.rows, spot, day.date);
      }
      const usable = sent.taggedCount >= MIN_TAGGED && sent.freshnessMinutes <= MAX_FRESHNESS_MIN;
      symbolDays.push({
        date: day.date,
        symbol: sym,
        netScore: sent.netScore,
        tilt: sent.tilt,
        taggedCount: sent.taggedCount,
        curatedCount: sent.curatedCount,
        messageCount: sent.messageCount,
        freshnessMinutes: sent.freshnessMinutes,
        netOTMflow: flow,
        usable,
        fwd: demarketed.get(`${day.date}|${sym}`) ?? { '1d': null, '5d': null, '20d': null },
      });
    }
  }

  const study = runSentimentStudy(symbolDays);

  const report = {
    issue: 'TRA-822',
    parent: 'TRA-820',
    generatedAt,
    inputs: {
      sentimentDir: SENTIMENT_DIR,
      chainsDir: CHAINS_DIR,
      sentimentDaysLoaded: sentimentDays.length,
      chainDaysLoaded: chainDays.length,
      studyUniverse,
      etfUniverse,
      noFetch: NO_FETCH,
      // TRA-2076 bar-coverage instruments. `symbolsWithBars === 0` with a
      // non-zero `symbolsAttempted` is the total-outage signature that used to
      // grade as FAIL.
      symbolsAttempted: allSymbols.length,
      symbolsWithBars: barsBySymbol.size,
      barFetchFailures,
    },
    study,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = resolve(REPORT_DIR, 'tra822-sentiment-ic.json');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  const mdPath = resolve(REPORT_DIR, 'tra822-sentiment-ic.md');
  writeFileSync(mdPath, renderMarkdown(report), 'utf-8');

  console.log(`\nVERDICT: ${study.verdict}`);
  for (const r of study.verdictReasons) console.log(`  - ${r}`);
  console.log(`\nwrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}
/**
 * TRA-2076 — `null` means "not measured" and renders `n/a`, never `0.0000`. A
 * rendered zero for an unmeasured IC is how a bar outage read as a dead signal.
 */
function num(x: number | null, dp = 4): string {
  return x != null && Number.isFinite(x) ? x.toFixed(dp) : 'n/a';
}

function renderMarkdown(report: {
  generatedAt: string;
  inputs: {
    sentimentDaysLoaded: number;
    chainDaysLoaded: number;
    studyUniverse: string[];
    etfUniverse: string[];
    symbolsAttempted: number;
    symbolsWithBars: number;
    barFetchFailures: { symbol: string; message: string }[];
  };
  study: StudyReport;
}): string {
  const s = report.study;
  const L: string[] = [];
  L.push('# TRA-822 — StockTwits Sentiment IC / Flow Measurement');
  L.push('');
  L.push(`**Generated:** ${report.generatedAt} · **Parent:** TRA-820 Step 1`);
  L.push('');
  L.push(`**VERDICT: ${s.verdict}**`);
  L.push('');
  for (const r of s.verdictReasons) L.push(`- ${r}`);
  L.push('');
  L.push('## Sample');
  L.push('');
  L.push(`- Sentiment days loaded: ${report.inputs.sentimentDaysLoaded}`);
  L.push(`- Chain days loaded: ${report.inputs.chainDaysLoaded}`);
  L.push(`- Symbol-days (total / usable / buzz-only): ${s.sample.nSymbolDays} / ${s.sample.nUsableSymbolDays} / ${s.sample.nBuzzOnlySymbolDays}`);
  L.push(`- Trading days: ${s.sample.nTradingDays}`);
  L.push(`- Chain days joined (S2 flow coverage): ${s.sample.nChainDays}`);
  L.push(
    `- Daily-bar coverage: ${report.inputs.symbolsWithBars}/${report.inputs.symbolsAttempted} symbols` +
      (report.inputs.barFetchFailures.length > 0
        ? ` · **${report.inputs.barFetchFailures.length} bar-fetch failure(s)**: ` +
          report.inputs.barFetchFailures.map((f) => `${f.symbol} (${f.message})`).join('; ')
        : ''),
  );
  L.push(`- Confirmed (S2) symbol-days: ${s.sample.nConfirmedSymbolDays}`);
  L.push(`- Study universe (single names): ${report.inputs.studyUniverse.join(', ') || '(none recorded yet)'}`);
  L.push('');
  L.push('## IC by horizon');
  L.push('');
  L.push('| Horizon | S1 meanIC | S1 ICIR | S1 nDays | S2 meanIC | S2 ICIR | S2 nDays | S2−S1 Δ |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const h of HORIZONS) {
    const a = s.s1Ic[h];
    const b = s.s2Ic[h];
    L.push(
      `| ${h} | ${num(a.meanIC)} | ${num(a.icir, 2)} | ${a.nDays} | ${num(b.meanIC)} | ${num(b.icir, 2)} | ${b.nDays} | ${num(s.confirmedVsAloneDelta[h])} |`,
    );
  }
  L.push('');
  L.push('## S2 bucketed forward returns by netScore quintile');
  L.push('');
  for (const h of HORIZONS) {
    const buckets = s.s2BucketsByQuintile[h];
    if (buckets.length === 0) {
      L.push(`- **${h}**: no confirmed symbol-days yet.`);
      continue;
    }
    L.push(`- **${h}**: ${buckets.map((b) => `${b.bucket}=${pct(b.meanRet)} (n=${b.n})`).join(', ')}`);
  }
  L.push('');
  L.push('> No live options entry is wired off StockTwits. Only a PASS unlocks TRA-820 Step 2, which still has to clear the TRA-817 OOS keeper gate after costs.');
  L.push('');
  return L.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
