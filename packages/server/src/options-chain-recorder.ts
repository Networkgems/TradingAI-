/**
 * TRA-376 — Daily option-chain snapshot recorder.
 *
 * Pulls `getExpirations` + `getChainSnapshot` for each watchlist symbol once
 * per trading day at ~3:55 PM ET and writes the rows to a date-partitioned
 * JSON file. The output is consumed by the replay backtest harness
 * (`packages/backtest/src/run-options-replay.ts`) so we can iterate on
 * capital-efficient OTM / RV sizing against real market data instead of
 * synthetic GBM premium paths.
 *
 * Storage layout
 *   <outDir>/<YYYY-MM-DD>/<SYMBOL>.json   per-symbol snapshot
 *   <outDir>/<YYYY-MM-DD>/_meta.json     recorder run metadata
 *
 * The recorder is a pure data layer — it does not touch any user / paper
 * account state. A future heartbeat can wire it into the `MarketScheduler`
 * but the standalone CLI in `scripts/record-option-chains.ts` is sufficient
 * for the initial 30-day capture window.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { OptionChainRow, TradierOptionsClient } from '@trading-app/engine';

/** Inclusive DTE window the live OTM / RV scanners care about. */
const DEFAULT_MIN_DTE_DAYS = 14;
const DEFAULT_MAX_DTE_DAYS = 35;

export interface OptionChainSnapshotFile {
  /** Underlying ticker. */
  symbol: string;
  /** Spot price at recording time. Optional — the recorder may not have a quote feed. */
  spot: number | null;
  /** ms-epoch when the snapshot was pulled. */
  recordedAt: number;
  /** Expirations included in this snapshot (YYYY-MM-DD, ascending). */
  expirations: string[];
  /** Every chain row across the recorded expirations. */
  rows: OptionChainRow[];
}

export interface OptionChainRecorderResult {
  /** Per-symbol outcome — written, skipped, or errored. */
  symbols: Array<{
    symbol: string;
    outcome: 'written' | 'no_expirations' | 'no_chain' | 'error';
    expirationsRecorded: number;
    rowsRecorded: number;
    errorMessage?: string;
  }>;
  /** Date partition the recorder wrote into (YYYY-MM-DD in ET). */
  date: string;
  /** Absolute directory the snapshots were written to. */
  outDir: string;
}

export interface OptionChainRecorderOptions {
  /** Symbols to record. Caller resolves the active watchlist. */
  symbols: readonly string[];
  /** Configured Tradier client. Recorder does not own connection lifecycle. */
  client: Pick<TradierOptionsClient, 'getExpirations' | 'getChainSnapshot'>;
  /**
   * Optional spot resolver. Stamped onto each per-symbol snapshot so the
   * replay harness can run the scanners without a separate quote fetch.
   */
  fetchSpot?: (symbol: string) => Promise<number | null>;
  /** Output root — partitioned by ET date below. */
  outDir: string;
  /** Inclusive DTE bounds (defaults: 14–35 days, matching the live scanners). */
  minDteDays?: number;
  maxDteDays?: number;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

/** ET YYYY-MM-DD for a timestamp — partitions snapshots by trading day. */
export function etDateKey(ts: number): string {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function daysBetween(fromTs: number, isoDate: string): number {
  const target = Date.parse(`${isoDate}T16:00:00-04:00`);
  if (!Number.isFinite(target)) return -1;
  return Math.round((target - fromTs) / 86_400_000);
}

/**
 * Run a one-shot capture across all `symbols`. Returns the per-symbol outcome
 * so the caller can log a summary; the JSON files themselves are the durable
 * artifact. Errors are isolated per symbol — a single failing ticker doesn't
 * abort the whole sweep.
 */
export async function recordOptionChains(
  options: OptionChainRecorderOptions,
): Promise<OptionChainRecorderResult> {
  const now = options.now ? options.now() : Date.now();
  const date = etDateKey(now);
  const outDir = join(options.outDir, date);
  await mkdir(outDir, { recursive: true });

  const minDte = options.minDteDays ?? DEFAULT_MIN_DTE_DAYS;
  const maxDte = options.maxDteDays ?? DEFAULT_MAX_DTE_DAYS;

  const symbols: OptionChainRecorderResult['symbols'] = [];

  for (const raw of options.symbols) {
    const symbol = raw.trim().toUpperCase();
    try {
      const allExpirations = await options.client.getExpirations(symbol);
      const inWindow = allExpirations.filter((d) => {
        const dte = daysBetween(now, d);
        return dte >= minDte && dte <= maxDte;
      });
      if (inWindow.length === 0) {
        symbols.push({ symbol, outcome: 'no_expirations', expirationsRecorded: 0, rowsRecorded: 0 });
        continue;
      }

      const rows: OptionChainRow[] = [];
      for (const exp of inWindow) {
        const chain = await options.client.getChainSnapshot(symbol, exp);
        rows.push(...chain);
      }

      if (rows.length === 0) {
        symbols.push({ symbol, outcome: 'no_chain', expirationsRecorded: inWindow.length, rowsRecorded: 0 });
        continue;
      }

      const spot = options.fetchSpot ? await options.fetchSpot(symbol) : null;

      const file: OptionChainSnapshotFile = {
        symbol,
        spot: Number.isFinite(spot ?? NaN) && (spot ?? 0) > 0 ? spot : null,
        recordedAt: now,
        expirations: inWindow,
        rows,
      };
      await writeFile(join(outDir, `${symbol}.json`), JSON.stringify(file), 'utf-8');

      symbols.push({
        symbol,
        outcome: 'written',
        expirationsRecorded: inWindow.length,
        rowsRecorded: rows.length,
      });
    } catch (err) {
      symbols.push({
        symbol,
        outcome: 'error',
        expirationsRecorded: 0,
        rowsRecorded: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const meta = {
    date,
    recordedAt: now,
    minDteDays: minDte,
    maxDteDays: maxDte,
    symbolCount: symbols.length,
    written: symbols.filter((s) => s.outcome === 'written').length,
    skipped: symbols.filter((s) => s.outcome !== 'written').length,
    perSymbol: symbols,
  };
  await writeFile(join(outDir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  return { symbols, date, outDir };
}
