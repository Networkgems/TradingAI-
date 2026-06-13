/**
 * TRA-822 (TRA-820 Step 1) — loader for the date-partitioned StockTwits
 * sentiment snapshots written by the server-side recorder
 * (`packages/server/src/sentiment-snapshot-recorder.ts`).
 *
 * Storage layout the recorder produces:
 *   <dataDir>/<YYYY-MM-DD>/sentiment.json   one row per symbol
 *   <dataDir>/<YYYY-MM-DD>/_meta.json       run metadata
 *
 * This is the read half — the mirror of `options-chain-store.ts`. It has no
 * dependency on the server package (which already depends on
 * @trading-app/backtest, so importing it would cycle). The on-disk JSON is
 * plain data; we type it structurally here.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { SocialSentiment } from '@trading-app/shared';

/** One symbol's recorded sentiment for a day. Mirrors the recorder's row. */
export interface SentimentSnapshotRow {
  symbol: string;
  outcome: 'recorded' | 'no_data' | 'error';
  sentiment: SocialSentiment | null;
  errorMessage?: string;
}

/** Shape of a per-day sentiment.json file. */
export interface SentimentSnapshotFile {
  date: string;
  recordedAt: number;
  symbols: SentimentSnapshotRow[];
}

/** One trading day's sentiment, keyed by symbol (only `recorded` rows). */
export interface SentimentDay {
  date: string;
  recordedAt: number;
  bySymbol: Map<string, SocialSentiment>;
}

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Load every date partition under `dataDir`, ascending by date. A partition
 * directory whose name isn't a YYYY-MM-DD date is skipped; only `recorded` rows
 * with a sentiment payload are surfaced. Returns [] when the directory is
 * missing (the recorder hasn't run yet) — callers treat that as "no sample".
 */
export async function loadSentimentDays(dataDir: string): Promise<SentimentDay[]> {
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    return [];
  }

  const dateDirs = entries.filter((e) => DATE_DIR.test(e)).sort();
  const days: SentimentDay[] = [];

  for (const date of dateDirs) {
    const file = join(dataDir, date, 'sentiment.json');
    let parsed: SentimentSnapshotFile;
    try {
      parsed = JSON.parse(await readFile(file, 'utf-8')) as SentimentSnapshotFile;
    } catch {
      continue; // skip a missing/corrupt partition rather than aborting the load
    }
    if (!parsed || !Array.isArray(parsed.symbols)) continue;

    const bySymbol = new Map<string, SocialSentiment>();
    for (const row of parsed.symbols) {
      if (row.outcome === 'recorded' && row.sentiment && typeof row.symbol === 'string') {
        bySymbol.set(row.symbol.toUpperCase(), row.sentiment);
      }
    }
    if (bySymbol.size > 0) {
      days.push({ date, recordedAt: parsed.recordedAt, bySymbol });
    }
  }

  return days;
}
