/**
 * TRA-376 — historical option-chain replay backtest harness.
 *
 * Replays the OTM mispricing scanner (`findMispricedOtmContracts`) and the RV
 * scanner (`findRelativeValueOpportunities`) against recorded historical
 * option chains, sized through an `OptionsReplayAccount` that mirrors the
 * live `PaperOptionsAccount` OTM / RV sizing + exit semantics.
 *
 * This replaces the synthetic GBM premium paths the TRA-375 $2k backtest had
 * to fall back on — synthetic GBM understates RV edge (it doesn't know which
 * contracts are IV-mispriced) and overstates OTM tail risk.
 *
 * Daily flow per equity bucket:
 *   1. Mark every open position to today's chain row for its `optionSymbol`,
 *      run partial-TP1 / hard-SL / trailing-stop exits.
 *   2. Force-close any contract whose expiration has passed.
 *   3. Run the OTM + RV scanners on today's chains; open the strongest
 *      long-only candidate per symbol per scanner (account enforces the
 *      daily cap, skip-on-0-contracts, and dedup-by-OCC).
 *   4. Snapshot the equity curve.
 * At the end of the window every still-open position is tail-closed at its
 * last seen mark so the report carries no embedded mark-to-market P&L.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest build
 *   node packages/backtest/dist/run-options-replay.js \
 *     --data-dir ./data/option-chains --out-dir ./data/replay-reports
 *
 * Flags:
 *   --data-dir <path>   chain snapshot root (default ./data/option-chains)
 *   --out-dir <path>    report output dir   (default ./data/replay-reports)
 *   --equity <list>     comma-separated starting equities (default 2000,5000,10000)
 *   --mr <ratio>        managedAccountRatio (default 0.50)
 *   --daily-limit <n>   options daily trades cap (default 10)
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  findMispricedOtmContracts,
  findRelativeValueOpportunities,
  type OptionChainRow,
} from '@trading-app/engine';
import { OTM_RISK_PARAMS, RV_RISK_PARAMS } from '@trading-app/shared';
import type { OtmRiskParams, RvRiskParams } from '@trading-app/shared';
import {
  OptionsReplayAccount,
  type ReplaySignalType,
  type ReplaySpreadStrategy,
  type SpreadRiskParams,
} from './options-replay-account.js';
import {
  modelPutWrite,
  modelCallDebitSpread,
  DEFAULT_STRUCTURE_CONFIG,
  type StructureModelConfig,
} from './options-replay-structures.js';
import {
  loadChainDays,
  estimateSpotFromChain,
  type ChainDay,
} from './options-chain-store.js';
import { DEFAULT_SELECTOR_PARAMS } from '@trading-app/engine';
import {
  replayPhaseABucket,
  buildPhaseAGateReport,
  buildPhaseAMarkdown,
  validateGateReportShape,
  defaultPhaseAConfig,
} from './options-replay-phasea.js';
import {
  summarizeBucket,
  buildCsv,
  buildMarkdown,
  type BucketResult,
} from './options-replay-report.js';

export interface ReplayConfig {
  /** Starting-equity buckets to compare. */
  equityBuckets: number[];
  managedAccountRatio: number;
  optionsDailyTradesLimit: number;
  otmRiskParams: OtmRiskParams;
  rvRiskParams: RvRiskParams;
  /** TRA-800 — per-structure sizing knobs for the defined-risk combos. */
  spreadRiskParams: Record<ReplaySpreadStrategy, SpreadRiskParams>;
  /** TRA-800 — structure-modeler config (e.g. put-write OTM offset). */
  structureConfig: StructureModelConfig;
}

/**
 * TRA-800 — default per-structure budget ratios (fraction of managed equity
 * reserved as capital-at-risk per lot). The cash-secured put-write reserves a
 * far larger per-lot capital (≈ strike ×100) than the narrow call debit spread,
 * so it gets a higher budget slice; both stay well under the live RV ticket
 * budget (2%) scaled for their wider capital footprints.
 */
export const DEFAULT_SPREAD_RISK_PARAMS: Record<ReplaySpreadStrategy, SpreadRiskParams> = {
  put_write: { budgetRatio: 0.5 },
  call_debit_spread: { budgetRatio: 0.05 },
  // TRA-918 — the four TRA-911 Phase-A structures are defined-risk verticals /
  // condors sized off their per-lot capped loss; a single 2%-of-managed-equity
  // ticket budget mirrors the selector's advisory `riskFraction` (0.02).
  bull_put_spread: { budgetRatio: 0.02 },
  bear_call_spread: { budgetRatio: 0.02 },
  iron_condor: { budgetRatio: 0.02 },
  debit_spread: { budgetRatio: 0.02 },
};

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  equityBuckets: [2000, 5000, 10000],
  managedAccountRatio: 0.5,
  optionsDailyTradesLimit: 10,
  otmRiskParams: OTM_RISK_PARAMS,
  rvRiskParams: RV_RISK_PARAMS,
  spreadRiskParams: DEFAULT_SPREAD_RISK_PARAMS,
  structureConfig: DEFAULT_STRUCTURE_CONFIG,
};

/** Build an OCC-symbol → mid-mark map from a day's chains across all symbols. */
function marksForDay(day: ChainDay): Map<string, number> {
  const marks = new Map<string, number>();
  for (const file of day.bySymbol.values()) {
    for (const row of file.rows) {
      const bid = row.bid ?? 0;
      const ask = row.ask ?? 0;
      if (bid > 0 && ask > 0 && ask >= bid) {
        marks.set(row.optionSymbol, (bid + ask) / 2);
      }
    }
  }
  return marks;
}

/** Resolve the underlying spot — recorder-stamped value preferred, parity estimate otherwise. */
function resolveSpot(file: { spot: number | null; rows: OptionChainRow[] }): number | null {
  if (typeof file.spot === 'number' && Number.isFinite(file.spot) && file.spot > 0) {
    return file.spot;
  }
  return estimateSpotFromChain(file.rows);
}

/**
 * TRA-800 — UPPER-CASE symbol → resolved spot for a day. Feeds the defined-risk
 * combo settlement (leg-intrinsic payoff at expiry needs the underlying price).
 */
function spotsForDay(day: ChainDay): Map<string, number> {
  const spots = new Map<string, number>();
  for (const [sym, file] of day.bySymbol) {
    const spot = resolveSpot(file);
    if (spot != null && Number.isFinite(spot) && spot > 0) spots.set(sym.toUpperCase(), spot);
  }
  return spots;
}

/**
 * Per-structure trail / partial schedule — mirrors `PaperOptionsAccount.checkExits`.
 *
 * TRA-800 — only the single-leg scanner structures are managed per tick, so
 * those two branch to their own OTM / RV risk params. The two defined-risk
 * combos (`put_write` / `call_debit_spread`) are NOT marked per tick (mirrors
 * the live `checkExits` combo skip); their "risk schedule" is the per-structure
 * sizing budget ratio (`cfg.spreadRiskParams`), wired into `openSpread`, and
 * their exit is the leg-intrinsic settlement at expiry. This schedule is never
 * invoked for a combo (markAndCheckExits skips them), but we branch the union
 * exhaustively so a future per-tick combo manager has an obvious seam.
 */
function riskScheduleOf(cfg: ReplayConfig) {
  return (signalType: ReplaySignalType) => {
    const r = signalType === 'otm_mispricing' ? cfg.otmRiskParams : cfg.rvRiskParams;
    return {
      trailActivatePct: r.trailActivatePct,
      trailOffsetPct: r.trailOffsetPct,
      partialExitRatio: r.partialExitRatio,
    };
  };
}

/**
 * Replay one equity bucket through all chain days. Pure — no I/O. Returns the
 * summarized {@link BucketResult}.
 */
export function replayBucket(days: readonly ChainDay[], startingEquity: number, cfg: ReplayConfig): BucketResult {
  const account = new OptionsReplayAccount({
    initialEquity: startingEquity,
    managedAccountRatio: cfg.managedAccountRatio,
    optionsDailyTradesLimit: cfg.optionsDailyTradesLimit,
    otmRiskParams: cfg.otmRiskParams,
    rvRiskParams: cfg.rvRiskParams,
    spreadRiskParams: cfg.spreadRiskParams,
  });
  const riskOf = riskScheduleOf(cfg);
  let skippedZeroSize = 0;
  // TRA-800 — prior-day spot per symbol drives the call-debit-spread trend gate
  // (only enter the bull structure when the underlying is rising).
  let prevSpotBySymbol = new Map<string, number>();

  for (const day of days) {
    account.startDay(day.date);
    const marks = marksForDay(day);
    const spotBySymbol = spotsForDay(day);

    // 1. Mark + exit single-leg positions, settle any expired defined-risk
    //    combos at their leg-intrinsic payoff, then expire single-leg contracts.
    account.markAndCheckExits(day.date, marks, riskOf);
    account.settleSpreads(day.date, spotBySymbol);
    account.expireOrForceCloseDueContracts(day.date, marks);

    const nextPrevSpot = new Map<string, number>();

    // 2. Scan today's chains and open the strongest long-only candidate per
    //    symbol per scanner, plus the two defined-risk structures.
    for (const file of day.bySymbol.values()) {
      const spot = resolveSpot(file);
      if (spot == null || !Number.isFinite(spot) || spot <= 0) continue;
      const sym = file.symbol.toUpperCase();
      nextPrevSpot.set(sym, spot);
      const now = file.recordedAt;

      // OTM scanner — long-only entries on `cheap` mispricings.
      const otm = findMispricedOtmContracts(file.rows, spot, { now });
      const otmCheap = otm.find((c) => c.classification === 'cheap');
      if (otmCheap) {
        const outcome = account.openOtm({
          symbol: otmCheap.underlying,
          optionSymbol: otmCheap.optionSymbol,
          optionType: otmCheap.optionType,
          strike: otmCheap.strike,
          expiration: otmCheap.expiration,
          mark: otmCheap.mark,
          classification: otmCheap.classification,
        });
        if (outcome.reason === 'zero_size') skippedZeroSize += 1;
      }

      // RV scanner — long-only entries on `cheap` / `below_intrinsic`
      // (mirrors signal-engine.runRelativeValueScan).
      const rv = findRelativeValueOpportunities(file.rows, spot, { now });
      const rvCheap = rv.find(
        (c) => c.classification === 'cheap' || c.classification === 'below_intrinsic',
      );
      if (rvCheap) {
        const outcome = account.openRv({
          symbol: rvCheap.underlying,
          optionSymbol: rvCheap.optionSymbol,
          optionType: rvCheap.optionType,
          strike: rvCheap.strike,
          expiration: rvCheap.expiration,
          mark: rvCheap.mark,
          classification: rvCheap.classification,
        });
        if (outcome.reason === 'zero_size') skippedZeroSize += 1;
      }

      // TRA-800 — defined-risk structures (held to expiry, settled at payoff).
      //   • put-write: cash-secured short put, always modeled (credit primary).
      //   • call debit spread: trend-filtered — only enter when the underlying
      //     rose vs the prior recorded day for this symbol.
      const putWrite = modelPutWrite(sym, spot, file.rows, now, cfg.structureConfig);
      if (putWrite) {
        const outcome = account.openSpread(putWrite);
        if (outcome.reason === 'zero_size') skippedZeroSize += 1;
      }

      const prevSpot = prevSpotBySymbol.get(sym);
      const trendOk = typeof prevSpot === 'number' && spot > prevSpot;
      const callSpread = modelCallDebitSpread(sym, spot, file.rows, trendOk, now, cfg.structureConfig);
      if (callSpread) {
        const outcome = account.openSpread(callSpread);
        if (outcome.reason === 'zero_size') skippedZeroSize += 1;
      }
    }

    account.recordEquityForDay(day.date);
    prevSpotBySymbol = nextPrevSpot;
  }

  // Tail-close everything still open at the last day's marks: settle any
  // remaining defined-risk combos at the last spot, then tail-close single legs.
  const lastDay = days[days.length - 1];
  if (lastDay) {
    account.settleSpreads(lastDay.date, spotsForDay(lastDay), { force: true });
    account.closeAllOpenAt(lastDay.date, marksForDay(lastDay));
  }

  return summarizeBucket({
    startingEquity,
    managedAccountRatio: cfg.managedAccountRatio,
    closed: account.getClosedPositions(),
    equityCurve: account.getEquityCurve(),
    skippedZeroSize,
  });
}

/** Replay every configured equity bucket. Pure — no I/O. */
export function runOptionsReplay(days: readonly ChainDay[], cfg: ReplayConfig): BucketResult[] {
  return cfg.equityBuckets.map((eq) => replayBucket(days, eq, cfg));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArg(name: string): string | undefined {
  // Support both `--name value` and `--name=value` forms.
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

/**
 * TRA-918 — the `--source=phaseA` CLI path: replay the TRA-911 Phase-A selector
 * across the loaded chain days and emit a markdown + a promotion-gate-consumable
 * JSON report per equity bucket. `mode` tags every report so a synthetic
 * backtest is never mistaken for real-chain paper accrual.
 */
async function runPhaseACli(
  days: readonly ChainDay[],
  cfg: ReplayConfig,
  outDir: string,
  mode: 'synthetic' | 'recorded',
  symbolsCount: number,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const generatedAt = Date.now();
  const stamp = new Date(generatedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');

  for (const startingEquity of cfg.equityBuckets) {
    const phaseCfg = defaultPhaseAConfig(DEFAULT_SELECTOR_PARAMS, cfg.spreadRiskParams, startingEquity);
    phaseCfg.managedAccountRatio = cfg.managedAccountRatio;
    phaseCfg.optionsDailyTradesLimit = cfg.optionsDailyTradesLimit;

    const bucket = replayPhaseABucket(days, startingEquity, phaseCfg);
    const report = buildPhaseAGateReport(bucket, mode);
    const shapeErrors = validateGateReportShape(report);
    if (shapeErrors.length) {
      console.error('[TRA-918 phaseA] gate-report shape validation FAILED:', shapeErrors);
      process.exit(3);
    }

    const md = buildPhaseAMarkdown({ report, daysReplayed: days.length, symbolsCount, generatedAt });
    const base = `options-phasea-${mode}-eq${startingEquity}-${stamp}`;
    const jsonPath = join(outDir, `${base}.json`);
    const mdPath = join(outDir, `${base}.md`);
    await writeFile(jsonPath, JSON.stringify({ generatedAt: new Date(generatedAt).toISOString(), ...report }, null, 2), 'utf-8');
    await writeFile(mdPath, md, 'utf-8');

    const m = report.pooled;
    console.log(
      `[TRA-918 phaseA] $${startingEquity}: ${m.tradeCount} trades, ` +
        `expectancy(R)=${m.expectancy}, sharpe=${m.sharpe}, PF=${m.profitFactor}, ` +
        `maxDD=${m.maxDrawdown}, signals=${bucket.signalCount}, unpriceable=${bucket.unpriceableSignals}`,
    );
    console.log(`[TRA-918 phaseA] JSON → ${jsonPath}`);
    console.log(`[TRA-918 phaseA] MD   → ${mdPath}`);
  }
}

async function main(): Promise<void> {
  // TRA-731 — `--synthetic` points the recorded-chain replay at the synthetic
  // chains generated by `run-tra731.js --gen-chains` and tags every output so it
  // is never confused with a recorded-chain replay. Defaults flip to the
  // synthetic chain root / report dir unless explicitly overridden.
  const synthetic = process.argv.includes('--synthetic');
  const dataDir =
    parseArg('data-dir') ?? (synthetic ? './data/tra731-reports/synthetic-chains' : './data/option-chains');
  const outDir =
    parseArg('out-dir') ?? (synthetic ? './data/tra731-reports/replay-synthetic' : './data/replay-reports');

  const equityArg = parseArg('equity');
  const equityBuckets = equityArg
    ? equityArg.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
    : DEFAULT_REPLAY_CONFIG.equityBuckets;

  const mrArg = parseArg('mr');
  const managedAccountRatio = mrArg ? Number(mrArg) : DEFAULT_REPLAY_CONFIG.managedAccountRatio;

  const limitArg = parseArg('daily-limit');
  const optionsDailyTradesLimit = limitArg
    ? Number(limitArg)
    : DEFAULT_REPLAY_CONFIG.optionsDailyTradesLimit;

  const cfg: ReplayConfig = {
    ...DEFAULT_REPLAY_CONFIG,
    equityBuckets,
    managedAccountRatio,
    optionsDailyTradesLimit,
  };

  console.log(`[TRA-376 replay] loading chain snapshots from ${dataDir}`);
  const days = await loadChainDays(dataDir);
  if (days.length === 0) {
    console.error(
      `[TRA-376 replay] no chain snapshots found under ${dataDir}. ` +
        'Run scripts/record-option-chains.ts daily to capture data first.',
    );
    process.exit(2);
  }

  const symbolsCount = new Set(
    days.flatMap((d) => Array.from(d.bySymbol.keys())),
  ).size;
  console.log(
    `[TRA-376 replay] ${days.length} day(s), ${symbolsCount} symbol(s), ` +
      `${days[0].date} → ${days[days.length - 1].date}`,
  );

  // TRA-918 — Phase-A signal-driven harness (`--source=phaseA`). Replaces the
  // OTM/RV scanner entry path with the TRA-911 selector; emits gate-consumable JSON.
  const source = parseArg('source');
  if (source === 'phaseA') {
    await runPhaseACli(days, cfg, outDir, synthetic ? 'synthetic' : 'recorded', symbolsCount);
    return;
  }

  const buckets = runOptionsReplay(days, cfg);

  const generatedAt = Date.now();
  const csv = buildCsv(buckets);
  const md = buildMarkdown({ buckets, daysReplayed: days.length, symbolsCount, generatedAt });

  await mkdir(outDir, { recursive: true });
  const stamp = new Date(generatedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const tag = synthetic ? 'synthetic-' : '';
  const csvPath = join(outDir, `options-replay-${tag}${stamp}.csv`);
  const mdPath = join(outDir, `options-replay-${tag}${stamp}.md`);
  await writeFile(csvPath, synthetic ? `# SYNTHETIC chains (TRA-731) — directional/sanity only\n${csv}` : csv, 'utf-8');
  await writeFile(
    mdPath,
    synthetic ? `> **SYNTHETIC DATA (TRA-731)** — Black-Scholes priced, NOT recorded chains.\n\n${md}` : md,
    'utf-8',
  );

  // Console summary.
  const col = (s: string, w: number): string => s.padEnd(w);
  console.log('');
  console.log(
    '  ' +
      col('Equity', 12) +
      col('Trades', 9) +
      col('WinRate', 10) +
      col('Total P&L', 15) +
      col('P&L %', 10) +
      col('Max DD', 14) +
      'Skipped(0-size)',
  );
  console.log('  ' + '·'.repeat(82));
  for (const b of buckets) {
    console.log(
      '  ' +
        col(`$${b.startingEquity}`, 12) +
        col(String(b.trades), 9) +
        col(`${(b.winRate * 100).toFixed(1)}%`, 10) +
        col(`$${b.totalPnl.toFixed(2)}`, 15) +
        col(`${(b.pnlPct * 100).toFixed(1)}%`, 10) +
        col(`$${b.maxDrawdown.toFixed(2)}`, 14) +
        String(b.skippedZeroSize),
    );
  }
  console.log('');
  console.log(`[TRA-376 replay] CSV  → ${csvPath}`);
  console.log(`[TRA-376 replay] MD   → ${mdPath}`);
}

// Only run the CLI when executed directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('run-options-replay.js');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
