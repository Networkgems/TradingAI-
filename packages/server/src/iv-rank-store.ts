import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { OptionChainRow } from '@trading-app/engine';
import { logger } from './observability/index.js';

// TRA-604 (TRA-595 C4b) — the trailing-IV store + IV-rank source.
//
// Before this module no IV-history store existed, so the Head-of-Options-Research
// pass always saw `ivRank: null` (an honest "unknown"). This is the missing
// feed: it records one at-the-money IV sample per symbol per UTC trading day and
// derives a real IV-RANK percentile from the trailing 52-week window.
//
// IV-RANK (not IV-percentile): `(currentIV − min) / (max − min) × 100` over the
// trailing window — where today's IV sits between its 1-year low and high. This
// is the standard tastytrade definition and matches what the C5 panel's IV-rank
// meter and the research prompt's "high IV-rank → prefer credit structures" rule
// both expect. We return `null` (still honest-unknown) until the window has
// enough samples to be meaningful, so a cold store never fabricates a rank.

const log = logger.child({ module: 'iv-rank-store' });

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'iv-history.json');
}

let storeFileOverride: string | null = null;
/** Test seam — point the store at a temp file. Pass `null` to restore default. */
export function setIvStoreFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** Trailing window for the IV-rank computation (≈ 52 weeks of trading days). */
const TRAILING_DAYS = 366;
/** Minimum samples in-window before a rank is meaningful (else honest `null`). */
export const MIN_IV_SAMPLES = 20;
/** Hard cap on stored samples per symbol so the file can't grow unbounded. */
const MAX_SAMPLES = 400;

/** One daily IV observation. */
export interface IvSample {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  /** At-the-money implied volatility (annualized, e.g. 0.32 = 32%). */
  iv: number;
}

interface StoreFile {
  version: 1;
  updatedAt: number;
  /** Keyed by UPPER-CASE symbol → ascending-by-day samples. */
  symbols: Record<string, IvSample[]>;
}

let cache: Map<string, IvSample[]> | null = null;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function ensureLoaded(): Promise<Map<string, IvSample[]>> {
  if (cache) return cache;
  const path = storeFile();
  if (!existsSync(path)) {
    cache = new Map();
    return cache;
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<StoreFile>;
    const map = new Map<string, IvSample[]>();
    if (parsed.symbols && typeof parsed.symbols === 'object') {
      for (const [sym, samples] of Object.entries(parsed.symbols)) {
        if (!Array.isArray(samples)) continue;
        const clean = samples
          .filter(
            (s): s is IvSample =>
              !!s &&
              typeof s.day === 'string' &&
              /^\d{4}-\d{2}-\d{2}$/.test(s.day) &&
              typeof s.iv === 'number' &&
              Number.isFinite(s.iv) &&
              s.iv > 0,
          )
          .sort((a, b) => a.day.localeCompare(b.day));
        map.set(sym.toUpperCase(), clean);
      }
    }
    cache = map;
  } catch (err) {
    log.error('failed to read IV store, starting empty', {
      reason: err instanceof Error ? err.message : String(err),
    });
    cache = new Map();
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const payload: StoreFile = {
    version: 1,
    updatedAt: Date.now(),
    symbols: Object.fromEntries(cache),
  };
  await writeFile(path, JSON.stringify(payload), 'utf-8');
}

/** Eagerly load the store so the sync accessor has data right after boot. */
export async function initIvRankStore(): Promise<void> {
  await ensureLoaded();
}

/**
 * Record one at-the-money IV sample for `symbol`, deduped by UTC day (a second
 * sample on the same day replaces the first). Caps the trailing window so the
 * file stays bounded. Async — loads the store on first use, then persists.
 */
export async function recordDailyIv(
  symbol: string,
  iv: number,
  asOf: number = Date.now(),
): Promise<void> {
  if (!Number.isFinite(iv) || iv <= 0) return;
  const map = await ensureLoaded();
  const key = symbol.trim().toUpperCase();
  const day = utcDay(asOf);
  const samples = map.get(key) ?? [];
  const without = samples.filter((s) => s.day !== day);
  without.push({ day, iv });
  without.sort((a, b) => a.day.localeCompare(b.day));
  map.set(key, without.slice(-MAX_SAMPLES));
  await persist();
}

/**
 * Compute the IV-rank of `currentIv` against a trailing sample window. Returns
 * `null` (honest unknown) when there are fewer than {@link MIN_IV_SAMPLES} or the
 * window is flat (max === min). Pure — exported for tests.
 */
export function computeIvRank(samples: readonly IvSample[], currentIv: number): number | null {
  if (!Number.isFinite(currentIv) || currentIv <= 0) return null;
  const ivs = samples.map((s) => s.iv).filter((v) => Number.isFinite(v) && v > 0);
  if (ivs.length < MIN_IV_SAMPLES) return null;
  const min = Math.min(...ivs);
  const max = Math.max(...ivs);
  if (max <= min) return null;
  const clamped = Math.max(min, Math.min(max, currentIv));
  return ((clamped - min) / (max - min)) * 100;
}

/**
 * TRA-2028 — IV PERCENTILE (distinct from IV RANK above). Per the TRA-2026
 * acceptance criteria the wheel promotion gate keys on the PERCENTILE, which is
 * more robust to a single outlier high/low than the rank: the fraction of the
 * trailing sessions whose IV closed strictly BELOW today's IV, scaled 0–100.
 * Same honest-`null` discipline as {@link computeIvRank}: fewer than
 * {@link MIN_IV_SAMPLES} in-window ⇒ `null`, never a fabricated percentile on a
 * thin store. Pure — exported for tests and the wheel IV-entry filter.
 */
export function computeIvPercentile(
  samples: readonly IvSample[],
  currentIv: number,
): number | null {
  if (!Number.isFinite(currentIv) || currentIv <= 0) return null;
  const ivs = samples.map((s) => s.iv).filter((v) => Number.isFinite(v) && v > 0);
  if (ivs.length < MIN_IV_SAMPLES) return null;
  const below = ivs.filter((v) => v < currentIv).length;
  return (below / ivs.length) * 100;
}

/** Samples within the trailing window relative to `asOf`. */
function windowFor(samples: readonly IvSample[], asOf: number): IvSample[] {
  const cutoffMs = asOf - TRAILING_DAYS * 86_400_000;
  const cutoff = utcDay(cutoffMs);
  return samples.filter((s) => s.day >= cutoff);
}

/**
 * Synchronous IV-rank read for the per-request research adapter (the store is
 * loaded at boot via {@link initIvRankStore}). Returns the 0–100 rank of
 * `currentIv` in `symbol`'s trailing 52-week window, or `null` when the cache is
 * unloaded / the symbol is uncovered / there is insufficient history.
 */
export function ivRankSync(
  symbol: string,
  currentIv: number,
  asOf: number = Date.now(),
): number | null {
  if (!cache) return null;
  const samples = cache.get(symbol.trim().toUpperCase());
  if (!samples) return null;
  return computeIvRank(windowFor(samples, asOf), currentIv);
}

/**
 * Synchronous IV-PERCENTILE read (TRA-2028), the sibling of {@link ivRankSync}
 * the wheel IV-entry filter gates on. Returns the 0–100 percentile of
 * `currentIv` in `symbol`'s trailing window, or `null` when the cache is
 * unloaded / the symbol is uncovered / there is insufficient history. Reads the
 * SAME store the rank does so both are computed off one mid-mark ATM-IV series.
 */
export function ivPercentileSync(
  symbol: string,
  currentIv: number,
  asOf: number = Date.now(),
): number | null {
  if (!cache) return null;
  const samples = cache.get(symbol.trim().toUpperCase());
  if (!samples) return null;
  return computeIvPercentile(windowFor(samples, asOf), currentIv);
}

/**
 * The at-the-money implied volatility for one underlying, read off a chain
 * snapshot: the IV of the contract whose strike is nearest `spot`, preferring
 * the smoothed `smvVol` and falling back to `midIv`. Returns `null` when no row
 * carries a usable IV. This is the value the daily recorder feeds to
 * {@link recordDailyIv} and the per-request adapter ranks.
 *
 * Both source fields (`smvVol`, `midIv`) are MID-derived by construction — the
 * chain marks legs at the bid/ask midpoint, never the last trade — so a non-null
 * return is always a mid mark. The wheel IV-entry filter (TRA-2028) treats a
 * `null` here as "no usable mid IV this pass" and stands its entry down rather
 * than gating on a stale/last-trade proxy.
 */
export function atmIvFromRows(rows: readonly OptionChainRow[], spot: number): number | null {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  let best: { dist: number; iv: number } | null = null;
  for (const r of rows) {
    const iv = r.smvVol ?? r.midIv;
    if (typeof iv !== 'number' || !Number.isFinite(iv) || iv <= 0) continue;
    const dist = Math.abs(r.strike - spot);
    if (!best || dist < best.dist) best = { dist, iv };
  }
  return best ? best.iv : null;
}
