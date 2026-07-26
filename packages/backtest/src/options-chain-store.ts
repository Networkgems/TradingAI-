/**
 * TRA-376 — loader for the date-partitioned option-chain snapshots written by
 * the server-side recorder (`packages/server/src/options-chain-recorder.ts`).
 *
 * Storage layout the recorder produces:
 *   <dataDir>/<YYYY-MM-DD>/<SYMBOL>.json      (or <SYMBOL>.json.gz once compacted)
 *   <dataDir>/<YYYY-MM-DD>/_meta.json         (never compacted — see below)
 *
 * This module is the read half — it has no dependency on the server package
 * (which already depends on @trading-app/backtest, so importing it would
 * cycle). The on-disk JSON is plain data; we type it structurally here.
 *
 * TRA-2417 — aged partitions are stored gzipped. `/data` is a 1 GB volume and
 * the capture was adding ~8.4 MB of per-symbol JSON per trading day with nothing
 * reclaiming it; measured on the 2026-07-24 partition, gzip -6 takes that to
 * 11.3% of the bytes. The compactor
 * (`packages/server/src/chain-partition-compactor.ts`) rewrites `<SYMBOL>.json`
 * as `<SYMBOL>.json.gz`, so **every reader must go through the helpers below** —
 * a bare `readFile(...,'utf-8')` on a compacted partition throws, and a bare
 * `endsWith('.json')` file filter silently skips it (`'AAPL.json.gz'` does not
 * end with `.json`), which reads exactly like an empty partition.
 * `_meta.json` is deliberately left uncompressed: it is ~3 KB × 48 partitions,
 * and keeping it plain means every metadata reader keeps working unchanged.
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import type { OptionChainRow } from '@trading-app/engine';

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

/** Per-date recorder metadata file. Never compacted. */
export const CHAIN_META_FILE = '_meta.json';

/**
 * True for a per-symbol snapshot file in either storage form. Excludes
 * `_meta.json` — callers that want the metadata read it by name.
 */
export function isChainSnapshotFile(name: string): boolean {
  if (name === CHAIN_META_FILE) return false;
  return name.endsWith('.json') || name.endsWith('.json.gz');
}

/** `AAPL.json` / `AAPL.json.gz` → `AAPL`. */
export function chainSnapshotSymbol(name: string): string {
  return name.replace(/\.json(\.gz)?$/i, '').toUpperCase();
}

/**
 * Read one per-symbol snapshot, transparently gunzipping a `.json.gz`. Throws
 * on a missing/corrupt file — callers decide whether to skip or fail.
 *
 * A name read from `readdir` can be compacted out from under us between the
 * listing and the read (compaction writes `X.json.gz` then unlinks `X.json`).
 * Every caller wraps this in a skip-on-error, so that race would drop a symbol
 * from a partition **silently** — a 24-of-25 export that looks like a normal
 * one. On ENOENT we therefore retry the sibling form before giving up; the file
 * is one rename away, not gone.
 */
export async function readChainSnapshotFile(path: string): Promise<OptionChainSnapshotFile> {
  let target = path;
  let raw: Buffer;
  try {
    raw = await readFile(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    target = path.endsWith('.gz') ? path.slice(0, -3) : `${path}.gz`;
    raw = await readFile(target);
  }
  const json = target.endsWith('.gz') ? (await gunzipAsync(raw)).toString('utf-8') : raw.toString('utf-8');
  return JSON.parse(json) as OptionChainSnapshotFile;
}

/**
 * Rewrite one per-symbol snapshot **in the storage form its path already
 * names** — a `.json.gz` path is re-gzipped, a `.json` path stays plain. Used by
 * the server's IVR enrichment post-pass, which must not silently decompress a
 * compacted partition back to plaintext (that would undo the reclaim on the very
 * partitions TRA-2417 compacted, and nothing downstream would notice).
 */
export async function writeChainSnapshotFile(
  path: string,
  snapshot: OptionChainSnapshotFile,
): Promise<void> {
  const json = Buffer.from(JSON.stringify(snapshot), 'utf-8');
  await writeFile(path, path.endsWith('.gz') ? await gzipAsync(json, { level: 6 }) : json);
}

/**
 * Per-symbol snapshot file names inside one date partition, sorted. Returns []
 * when the directory is unreadable.
 */
export async function listChainSnapshotFiles(partitionDir: string): Promise<string[]> {
  try {
    return (await readdir(partitionDir)).filter(isChainSnapshotFile).sort();
  } catch {
    return [];
  }
}

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
 * any file that is neither `.json` nor `.json.gz` is ignored. Compacted
 * (`.json.gz`) and plain partitions load identically.
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
      if (!isChainSnapshotFile(f)) continue;
      try {
        const parsed = await readChainSnapshotFile(join(dir, f));
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
