/**
 * TRA-822 (TRA-820 Step 1) — Daily StockTwits sentiment-snapshot recorder.
 *
 * Mirrors the TRA-376 option-chain recorder (`options-chain-recorder.ts`): once
 * per trading day at ~3:55 PM ET it reduces each watchlist symbol's live
 * StockTwits stream to a single {@link SocialSentiment} read and appends it to a
 * date-partitioned JSON file. The output is the forward-collected sentiment time
 * series the TRA-820 IC/flow study needs — StockTwits sentiment is otherwise
 * held only in `SignalEngine.socialCache` (in-memory, reduced on read), so
 * without this logger there is no persisted history to measure.
 *
 * Storage layout
 *   <outDir>/<YYYY-MM-DD>/sentiment.json   one snapshot row per symbol
 *   <outDir>/<YYYY-MM-DD>/_meta.json       recorder run metadata
 *
 * Like the chain recorder this is a pure data layer: it owns no engine / account
 * state and the actual StockTwits fetch + aggregation is injected as
 * `fetchSentiment`, keeping the recorder testable without network IO. The server
 * wires it into the SAME `onChainRecord` scheduler hook so the two snapshots
 * co-accumulate on the persistent disk (TRA-820 §5).
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { SocialSentiment } from '@trading-app/shared';
import { etDateKey } from './options-chain-recorder.js';

export interface SentimentSnapshotRow {
  /** Underlying ticker (uppercased). */
  symbol: string;
  /**
   * `recorded` — a sentiment read was obtained (even a neutral/empty one);
   * `no_data` — the fetch degraded to null (rate-limit breaker / 429 / cold),
   * so there is no read for this symbol-day; `error` — the resolver threw.
   */
  outcome: 'recorded' | 'no_data' | 'error';
  /** The aggregated read, or null when not `recorded`. */
  sentiment: SocialSentiment | null;
  errorMessage?: string;
}

export interface SentimentSnapshotFile {
  /** ET date partition (YYYY-MM-DD). */
  date: string;
  /** ms-epoch when the snapshot sweep ran. */
  recordedAt: number;
  /** One row per requested symbol, in request order. */
  symbols: SentimentSnapshotRow[];
}

export interface SentimentSnapshotRecorderResult {
  symbols: SentimentSnapshotRow[];
  /** Date partition written into (YYYY-MM-DD in ET). */
  date: string;
  /** Absolute directory the snapshot was written to. */
  outDir: string;
  /** Absolute path of the sentiment.json file. */
  filePath: string;
}

export interface SentimentSnapshotRecorderOptions {
  /** Symbols to record. Caller resolves the active watchlist. */
  symbols: readonly string[];
  /**
   * Sentiment resolver — returns the aggregated read for a symbol, or null when
   * no read could be obtained (rate-limited / cold). Injected so the recorder
   * stays a pure data layer; the server wires the StockTwits fetch +
   * `aggregateStockTwitsSentiment` reduction here.
   */
  fetchSentiment: (symbol: string) => Promise<SocialSentiment | null>;
  /** Output root — partitioned by ET date below. */
  outDir: string;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Run a one-shot sentiment capture across all `symbols`. Returns the per-symbol
 * outcome so the caller can log a summary; the JSON file itself is the durable
 * artifact. Errors are isolated per symbol — a single failing ticker doesn't
 * abort the whole sweep.
 */
export async function recordSentimentSnapshot(
  options: SentimentSnapshotRecorderOptions,
): Promise<SentimentSnapshotRecorderResult> {
  const now = options.now ? options.now() : Date.now();
  const date = etDateKey(now);
  const outDir = join(options.outDir, date);
  await mkdir(outDir, { recursive: true });

  const symbols: SentimentSnapshotRow[] = [];

  for (const raw of options.symbols) {
    const symbol = raw.trim().toUpperCase();
    try {
      const sentiment = await options.fetchSentiment(symbol);
      if (sentiment === null) {
        symbols.push({ symbol, outcome: 'no_data', sentiment: null });
      } else {
        symbols.push({ symbol, outcome: 'recorded', sentiment });
      }
    } catch (err) {
      symbols.push({
        symbol,
        outcome: 'error',
        sentiment: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const file: SentimentSnapshotFile = { date, recordedAt: now, symbols };
  const filePath = join(outDir, 'sentiment.json');
  await writeFile(filePath, JSON.stringify(file), 'utf-8');

  const meta = {
    date,
    recordedAt: now,
    symbolCount: symbols.length,
    recorded: symbols.filter((s) => s.outcome === 'recorded').length,
    noData: symbols.filter((s) => s.outcome === 'no_data').length,
    errored: symbols.filter((s) => s.outcome === 'error').length,
    perSymbol: symbols.map((s) => ({ symbol: s.symbol, outcome: s.outcome })),
  };
  await writeFile(join(outDir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  return { symbols, date, outDir, filePath };
}
