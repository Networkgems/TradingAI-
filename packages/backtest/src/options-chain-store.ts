/**
 * TRA-376 — loader for the date-partitioned option-chain snapshots written by
 * the server-side recorder (`packages/server/src/options-chain-recorder.ts`).
 *
 * Storage layout the recorder produces:
 *   <dataDir>/<YYYY-MM-DD>/<SYMBOL>.json
 *   <dataDir>/<YYYY-MM-DD>/_meta.json
 *
 * This module is the read half — it has no dependency on the server package
 * (which already depends on @trading-app/backtest, so importing it would
 * cycle). The on-disk JSON is plain data; we type it structurally here.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { OptionChainRow } from '@trading-app/engine';

/** Shape of a per-symbol snapshot JSON file. Mirrors the recorder's output. */
export interface OptionChainSnapshotFile {
  symbol: string;
  spot: number | null;
  recordedAt: number;
  expirations: string[];
  rows: OptionChainRow[];
}

/** One trading day's worth of recorded chains, keyed by symbol. */
export interface ChainDay {
  date: string;
  bySymbol: Map<string, OptionChainSnapshotFile>;
}

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Load every date partition under `dataDir`, ascending by date. A partition
 * directory whose name isn't a YYYY-MM-DD date is skipped; `_meta.json` and
 * any non-`.json` file inside a partition is ignored.
 */
export async function loadChainDays(dataDir: string): Promise<ChainDay[]> {
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    return [];
  }

  const dateDirs = entries.filter((e) => DATE_DIR.test(e)).sort();
  const days: ChainDay[] = [];

  for (const date of dateDirs) {
    const dir = join(dataDir, date);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    const bySymbol = new Map<string, OptionChainSnapshotFile>();
    for (const f of files) {
      if (!f.endsWith('.json') || f === '_meta.json') continue;
      try {
        const raw = await readFile(join(dir, f), 'utf-8');
        const parsed = JSON.parse(raw) as OptionChainSnapshotFile;
        if (parsed && Array.isArray(parsed.rows) && typeof parsed.symbol === 'string') {
          bySymbol.set(parsed.symbol.toUpperCase(), parsed);
        }
      } catch {
        // Skip a corrupt file rather than aborting the whole load.
      }
    }
    if (bySymbol.size > 0) days.push({ date, bySymbol });
  }

  return days;
}

/**
 * Estimate the underlying spot from an option chain when the recorder didn't
 * stamp one. Uses put-call parity: C − P = S − K·e^{−rT}, which is minimised
 * (≈ 0) at the ATM strike. We find the strike where the call mid and put mid
 * are closest, then back out S ≈ K + (C − P). Returns null when the chain
 * lacks paired call/put quotes.
 */
export function estimateSpotFromChain(rows: readonly OptionChainRow[]): number | null {
  const callByStrikeExp = new Map<string, number>();
  const putByStrikeExp = new Map<string, number>();
  for (const r of rows) {
    const bid = r.bid ?? 0;
    const ask = r.ask ?? 0;
    if (bid <= 0 || ask <= 0 || ask < bid) continue;
    const mid = (bid + ask) / 2;
    const key = `${r.expiration}|${r.strike}`;
    if (r.optionType === 'call') callByStrikeExp.set(key, mid);
    else putByStrikeExp.set(key, mid);
  }

  let bestDiff = Infinity;
  let bestSpot: number | null = null;
  for (const [key, callMid] of callByStrikeExp) {
    const putMid = putByStrikeExp.get(key);
    if (putMid == null) continue;
    const strike = Number(key.split('|')[1]);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const diff = Math.abs(callMid - putMid);
    if (diff < bestDiff) {
      bestDiff = diff;
      // C − P ≈ S − K  (ignoring the small discount factor — adequate for sizing).
      bestSpot = strike + (callMid - putMid);
    }
  }
  return bestSpot;
}
