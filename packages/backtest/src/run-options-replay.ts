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
} from './options-replay-account.js';
import {
  loadChainDays,
  estimateSpotFromChain,
  type ChainDay,
} from './options-chain-store.js';
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
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  equityBuckets: [2000, 5000, 10000],
  managedAccountRatio: 0.5,
  optionsDailyTradesLimit: 10,
  otmRiskParams: OTM_RISK_PARAMS,
  rvRiskParams: RV_RISK_PARAMS,
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

/** Per-strategy trail / partial schedule — mirrors `PaperOptionsAccount.checkExits`. */
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
  });
  const riskOf = riskScheduleOf(cfg);
  let skippedZeroSize = 0;

  for (const day of days) {
    account.startDay(day.date);
    const marks = marksForDay(day);

    // 1. Mark + exit open positions, then expire anything past its date.
    account.markAndCheckExits(day.date, marks, riskOf);
    account.expireOrForceCloseDueContracts(day.date, marks);

    // 2. Scan today's chains and open the strongest long-only candidate per
    //    symbol per scanner.
    for (const file of day.bySymbol.values()) {
      const spot = resolveSpot(file);
      if (spot == null || !Number.isFinite(spot) || spot <= 0) continue;
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
    }

    account.recordEquityForDay(day.date);
  }

  // Tail-close everything still open at the last day's marks.
  const lastDay = days[days.length - 1];
  if (lastDay) {
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
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const dataDir = parseArg('data-dir') ?? './data/option-chains';
  const outDir = parseArg('out-dir') ?? './data/replay-reports';

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

  const buckets = runOptionsReplay(days, cfg);

  const generatedAt = Date.now();
  const csv = buildCsv(buckets);
  const md = buildMarkdown({ buckets, daysReplayed: days.length, symbolsCount, generatedAt });

  await mkdir(outDir, { recursive: true });
  const stamp = new Date(generatedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const csvPath = join(outDir, `options-replay-${stamp}.csv`);
  const mdPath = join(outDir, `options-replay-${stamp}.md`);
  await writeFile(csvPath, csv, 'utf-8');
  await writeFile(mdPath, md, 'utf-8');

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
