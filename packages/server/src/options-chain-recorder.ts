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
 * account state. TRA-380 wires it into the `MarketScheduler` as the
 * `onChainRecord` hook (3:55 PM ET, market days) for the managed in-process
 * daily capture; the standalone CLI in `scripts/record-option-chains.ts`
 * remains as the manual backfill / one-off entry point.
 *
 * ## TRA-4059 — a skipped symbol-day is gone for good, so skips retry and count
 *
 * The store accrues FORWARD ONLY: there is no backfill path for a symbol-day
 * the 3:55 PM sweep did not write. Measured 2026-07-31 → 2026-08-25 on bqb1,
 * only 7 of 20 sessions wrote the full 25-name universe; 2026-08-18 wrote ZERO
 * files with all 25 symbols filed as `no_expirations` — in a sweep that took
 * under a minute. That is not 25 large-caps with no weeklies; it is the broker
 * refusing the calls. The engine client collapsed every non-2xx into `[]`, so
 * the recorder could not tell a 429 from an empty list, filed it as a quiet
 * skip, and moved on.
 *
 * Three things change here:
 *   1. A broker refusal is its own outcome, `feed_error`, carrying the HTTP
 *      status — it is no longer indistinguishable from `no_expirations`.
 *   2. Every non-written symbol is retried in-session, bounded (default two
 *      further passes, 30s apart). A rate-limit that clears in a minute no
 *      longer costs the symbol-day.
 *   3. `_meta.json` and the result carry `passes`, `outcomeCounts` and
 *      `wholesaleSkip` (written 0 of N>0), so a session that captured nothing
 *      is readable as an outage rather than as one more partition.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { OptionChainRow, TradierOptionsClient, TradierFetchResult } from '@trading-app/engine';

/** Inclusive DTE window the live OTM / RV scanners care about. */
const DEFAULT_MIN_DTE_DAYS = 14;
const DEFAULT_MAX_DTE_DAYS = 35;

/** TRA-4059 — bounded in-session retry of every non-written symbol. */
export const DEFAULT_CHAIN_RECORD_MAX_RETRIES = 2;
export const DEFAULT_CHAIN_RECORD_RETRY_DELAY_MS = 30_000;

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

/**
 * Per-symbol outcome.
 *   written         — snapshot file on disk.
 *   no_expirations  — broker answered 2xx and nothing lists inside the DTE window.
 *   no_chain        — expirations listed, every chain came back empty (2xx).
 *   feed_error      — broker refused (non-2xx); `httpStatus` says how. TRA-4059.
 *   error           — the call threw (network, parse).
 */
export type OptionChainSymbolOutcome = 'written' | 'no_expirations' | 'no_chain' | 'feed_error' | 'error';

export interface OptionChainSymbolResult {
  symbol: string;
  outcome: OptionChainSymbolOutcome;
  expirationsRecorded: number;
  rowsRecorded: number;
  errorMessage?: string;
  /** TRA-4059 — the refusing status when `outcome === 'feed_error'`. */
  httpStatus?: number;
  /** TRA-4059 — passes this symbol was attempted in (1 = first sweep only). */
  attempts: number;
}

export type OptionChainOutcomeCounts = Record<OptionChainSymbolOutcome, number>;

export interface OptionChainRecorderResult {
  /** Per-symbol outcome — written, skipped, or errored. */
  symbols: OptionChainSymbolResult[];
  /** Date partition the recorder wrote into (YYYY-MM-DD in ET). */
  date: string;
  /** Absolute directory the snapshots were written to. */
  outDir: string;
  /** TRA-4059 — summary the caller can grade without re-folding `symbols`. */
  written: number;
  skipped: number;
  outcomeCounts: OptionChainOutcomeCounts;
  /** Sweeps run, including retries (1 = nothing needed retrying). */
  passes: number;
  /** Symbols a retry pass rescued (non-written after pass 1, written by the end). */
  rescuedByRetry: string[];
  /**
   * `written === 0` with a non-empty universe. An outage, not a partition —
   * the caller logs it at `error` and the health route reads it as non-green.
   */
  wholesaleSkip: boolean;
}

/** TRA-4059 — the status-preserving reads, when the client has them. */
type ChainFeedClient = Pick<TradierOptionsClient, 'getExpirations' | 'getChainSnapshot'> &
  Partial<Pick<TradierOptionsClient, 'fetchExpirations' | 'fetchChainSnapshot'>>;

export interface OptionChainRecorderOptions {
  /** Symbols to record. Caller resolves the active watchlist. */
  symbols: readonly string[];
  /**
   * Configured Tradier client. Recorder does not own connection lifecycle.
   * When the client exposes `fetchExpirations` / `fetchChainSnapshot`
   * (TRA-4059) a broker refusal is filed as `feed_error` with its status;
   * a bare `getExpirations` client still works but cannot tell a 429 from an
   * empty list, so every refusal reads as `no_expirations` there.
   */
  client: ChainFeedClient;
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
  /**
   * TRA-4059 — further passes over the symbols that did not write. `0`
   * disables. Defaults to {@link DEFAULT_CHAIN_RECORD_MAX_RETRIES}.
   */
  maxRetries?: number;
  /** Pause before each retry pass. Defaults to {@link DEFAULT_CHAIN_RECORD_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
  /** Test seam — defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional per-pass hook so the caller can log a retry as it starts. */
  onRetry?: (info: { pass: number; pending: string[]; delayMs: number }) => void;
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

export function emptyOutcomeCounts(): OptionChainOutcomeCounts {
  return { written: 0, no_expirations: 0, no_chain: 0, feed_error: 0, error: 0 };
}

export function countOutcomes(symbols: readonly Pick<OptionChainSymbolResult, 'outcome'>[]): OptionChainOutcomeCounts {
  const counts = emptyOutcomeCounts();
  for (const s of symbols) counts[s.outcome] += 1;
  return counts;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readExpirations(client: ChainFeedClient, symbol: string): Promise<TradierFetchResult<string[]>> {
  if (typeof client.fetchExpirations === 'function') return client.fetchExpirations(symbol);
  return { ok: true, httpStatus: 200, value: await client.getExpirations(symbol) };
}

async function readChain(
  client: ChainFeedClient,
  symbol: string,
  expiration: string,
): Promise<TradierFetchResult<OptionChainRow[]>> {
  if (typeof client.fetchChainSnapshot === 'function') return client.fetchChainSnapshot(symbol, expiration);
  return { ok: true, httpStatus: 200, value: await client.getChainSnapshot(symbol, expiration) };
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
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_CHAIN_RECORD_MAX_RETRIES));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_CHAIN_RECORD_RETRY_DELAY_MS);
  const sleep = options.sleep ?? realSleep;

  const captureSymbol = async (
    symbol: string,
    attempts: number,
  ): Promise<OptionChainSymbolResult> => {
    try {
      const expirations = await readExpirations(options.client, symbol);
      if (!expirations.ok) {
        return {
          symbol,
          outcome: 'feed_error',
          expirationsRecorded: 0,
          rowsRecorded: 0,
          httpStatus: expirations.httpStatus,
          errorMessage: `getExpirations http ${expirations.httpStatus}`,
          attempts,
        };
      }
      const inWindow = expirations.value.filter((d) => {
        const dte = daysBetween(now, d);
        return dte >= minDte && dte <= maxDte;
      });
      if (inWindow.length === 0) {
        return { symbol, outcome: 'no_expirations', expirationsRecorded: 0, rowsRecorded: 0, attempts };
      }

      const rows: OptionChainRow[] = [];
      for (const exp of inWindow) {
        const chain = await readChain(options.client, symbol, exp);
        if (!chain.ok) {
          return {
            symbol,
            outcome: 'feed_error',
            expirationsRecorded: inWindow.length,
            rowsRecorded: 0,
            httpStatus: chain.httpStatus,
            errorMessage: `getChainSnapshot(${exp}) http ${chain.httpStatus}`,
            attempts,
          };
        }
        rows.push(...chain.value);
      }

      if (rows.length === 0) {
        return { symbol, outcome: 'no_chain', expirationsRecorded: inWindow.length, rowsRecorded: 0, attempts };
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

      return {
        symbol,
        outcome: 'written',
        expirationsRecorded: inWindow.length,
        rowsRecorded: rows.length,
        attempts,
      };
    } catch (err) {
      return {
        symbol,
        outcome: 'error',
        expirationsRecorded: 0,
        rowsRecorded: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
        attempts,
      };
    }
  };

  // Pass 1 — the whole universe, in order. Keyed by symbol so a retry pass can
  // overwrite an entry in place and the output order stays the universe order.
  const universe = Array.from(new Set(options.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)));
  const bySymbol = new Map<string, OptionChainSymbolResult>();
  for (const symbol of universe) bySymbol.set(symbol, await captureSymbol(symbol, 1));

  // TRA-4059 — bounded retry of everything that did not write. `no_expirations`
  // is retried too: on a 25-name large-cap universe with a 7–60 DTE window a
  // genuine empty list is near-impossible, and the pre-TRA-4059 client could
  // not distinguish it from a refusal anyway. Cost is one expirations call per
  // pending symbol per pass.
  const pendingAfterFirstPass = universe.filter((s) => bySymbol.get(s)!.outcome !== 'written');
  let passes = 1;
  for (let retry = 1; retry <= maxRetries; retry++) {
    const pending = universe.filter((s) => bySymbol.get(s)!.outcome !== 'written');
    if (pending.length === 0) break;
    passes += 1;
    options.onRetry?.({ pass: passes, pending, delayMs: retryDelayMs });
    if (retryDelayMs > 0) await sleep(retryDelayMs);
    for (const symbol of pending) bySymbol.set(symbol, await captureSymbol(symbol, passes));
  }

  const symbols = universe.map((s) => bySymbol.get(s)!);
  const outcomeCounts = countOutcomes(symbols);
  const written = outcomeCounts.written;
  const skipped = symbols.length - written;
  const rescuedByRetry = pendingAfterFirstPass.filter((s) => bySymbol.get(s)!.outcome === 'written');
  const wholesaleSkip = symbols.length > 0 && written === 0;

  const meta = {
    date,
    recordedAt: now,
    minDteDays: minDte,
    maxDteDays: maxDte,
    symbolCount: symbols.length,
    written,
    skipped,
    // TRA-4059 — readable from the partition alone, long after the process
    // that wrote it is gone.
    outcomeCounts,
    passes,
    maxRetries,
    rescuedByRetry,
    wholesaleSkip,
    perSymbol: symbols,
  };
  await writeFile(join(outDir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  return { symbols, date, outDir, written, skipped, outcomeCounts, passes, rescuedByRetry, wholesaleSkip };
}
