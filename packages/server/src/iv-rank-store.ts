import { readFile, writeFile, mkdir, rename, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type { OptionChainRow } from '@trading-app/engine';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';

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

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'iv-history.json');
}

let storeFileOverride: string | null = null;
/** Test seam — point the store at a temp file. Pass `null` to restore default. */
export function setIvStoreFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
  bootProvenance = null;
  persistCount = 0;
  persistErrors = 0;
  lastPersistError = null;
  loadFailed = false;
  persistRefusals = 0;
  corruptFileRenamedTo = null;
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

// ── Boot-load provenance (TRA-5171) ─────────────────────────────────────────
//
// bqb1 published `ivSampleDepth: 2` on 82/82 scans after THREE MONTHS of daily
// recording, and no surface could say WHY the store was that shallow. The three
// candidate mechanisms serialise identically without this block:
//   file absent      → storeFileExisted:false, parseError:null,  samples 0
//   file corrupt     → storeFileExisted:true,  parseError:"...", samples 0
//   parsed + shallow → storeFileExisted:true,  parseError:null,  samples N>0
// Those three MUST never read the same — that identity is the defect this
// exists to kill. Captured at the moment the store is actually loaded (boot via
// `initIvRankStore`, or the first lazy `recordDailyIv`), never re-derived.

/** What the trailing-IV store found the moment it loaded from disk. */
export interface IvStoreBootProvenance {
  /** Resolved store path, so a reader can see which disk root it lives under. */
  storeFile: string;
  /** Did the file exist when the load ran. */
  storeFileExisted: boolean;
  /** The load's catch reason, verbatim — non-null means the file was unreadable/corrupt. */
  parseError: string | null;
  symbolsLoadedAtBoot: number;
  samplesLoadedAtBoot: number;
  oldestSampleDay: string | null;
  newestSampleDay: string | null;
  distinctDaysInStore: number;
  /**
   * Usable in-window depth (as of load time) → symbol count. The live incident's
   * uniform depth-2 shape is itself evidence; publish it rather than making a
   * grader re-derive it from 82 per-scan rows.
   */
  depthHistogram: Record<string, number>;
  loadedAt: string;
}

let bootProvenance: IvStoreBootProvenance | null = null;
let persistCount = 0;
let persistErrors = 0;
let lastPersistError: string | null = null;

// ── Fail-closed load failure (TRA-5172) ─────────────────────────────────────
//
// Before this, a load failure started an empty cache and the very next
// `recordDailyIv` persisted that empty map over the file: one unreadable byte
// permanently destroyed up to a year of history, with no deploy and no error
// anyone could see (bqb1 exposes no log surface to a grader). Now a failed load
// sets `loadFailed`, and `persist()` REFUSES to write for as long as the
// unreadable original still sits at the destination path — a degraded in-memory
// store is strictly better than a destroyed on-disk one. Each refused write
// attempts to move the original aside to `iv-history.corrupt-<ts>.json` so the
// bytes survive for forensics; only a successful rename re-opens the write path.

/** True once a load attempt failed in this process (`bootLoad.parseError` has the reason). */
let loadFailed = false;
/** Writes refused because the unreadable original was still at the store path. */
let persistRefusals = 0;
/** Where the unreadable file was moved for forensics, once the rename succeeds. */
let corruptFileRenamedTo: string | null = null;

/** The forensics path: `iv-history.corrupt-<ts>.json` beside the store (`:`/`.` are not Windows-safe). */
function corruptAsidePath(path: string, atMs: number): string {
  const stamp = new Date(atMs).toISOString().replace(/[:.]/g, '-');
  return path.endsWith('.json')
    ? `${path.slice(0, -'.json'.length)}.corrupt-${stamp}.json`
    : `${path}.corrupt-${stamp}`;
}

function captureBootProvenance(
  map: Map<string, IvSample[]>,
  path: string,
  storeFileExisted: boolean,
  parseError: string | null,
  loadedAtMs: number,
): void {
  let samplesLoaded = 0;
  const days = new Set<string>();
  const depthHistogram: Record<string, number> = {};
  for (const arr of map.values()) {
    samplesLoaded += arr.length;
    for (const s of arr) days.add(s.day);
    const depth = usableInWindowDepth(arr, loadedAtMs);
    depthHistogram[String(depth)] = (depthHistogram[String(depth)] ?? 0) + 1;
  }
  const sortedDays = [...days].sort();
  bootProvenance = {
    storeFile: path,
    storeFileExisted,
    parseError,
    symbolsLoadedAtBoot: map.size,
    samplesLoadedAtBoot: samplesLoaded,
    oldestSampleDay: sortedDays[0] ?? null,
    newestSampleDay: sortedDays[sortedDays.length - 1] ?? null,
    distinctDaysInStore: days.size,
    depthHistogram,
    loadedAt: new Date(loadedAtMs).toISOString(),
  };
}

async function ensureLoaded(): Promise<Map<string, IvSample[]>> {
  if (cache) return cache;
  const path = storeFile();
  if (!existsSync(path)) {
    cache = new Map();
    captureBootProvenance(cache, path, false, null, Date.now());
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
    captureBootProvenance(cache, path, true, null, Date.now());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error('failed to read IV store, starting empty in-memory; persists refused until the file is moved aside', { reason });
    cache = new Map();
    // TRA-5172 — fail CLOSED: mark the failure so persist() refuses to clobber
    // the unreadable original (the leading wipe hypothesis on TRA-5170). The
    // provenance block makes the mechanism readable from the health route.
    loadFailed = true;
    captureBootProvenance(cache, path, true, reason, Date.now());
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const path = storeFile();

  // TRA-5172 — while the unreadable original still occupies the store path, a
  // write would destroy the only copy of the bytes. Refuse (counted), try to
  // move the original aside for forensics, and only let a FUTURE persist write
  // once the rename has succeeded. The refused sample is not lost: it stays in
  // the cache and lands with the next persist. Never silently replace.
  if (loadFailed && corruptFileRenamedTo == null) {
    persistRefusals++;
    const aside = corruptAsidePath(path, Date.now());
    try {
      await rename(path, aside);
      corruptFileRenamedTo = aside;
      log.warn('unreadable IV store moved aside for forensics; a fresh store will start accumulating', { aside });
    } catch (err) {
      // Rename failed (locked, perms, already gone) — stay closed and keep
      // serving the in-memory store; the next persist attempt retries.
      log.error('refusing to persist over an unreadable IV store (rename-aside failed)', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const payload: StoreFile = {
    version: 1,
    updatedAt: Date.now(),
    symbols: Object.fromEntries(cache),
  };
  // TRA-5172 — tmp + rename, the same durability idiom the package's sibling
  // stores use (cost-aware-gate-ledger, hard-controls, chain-partition-compactor
  // …): this store used to rewrite the whole file IN PLACE on every
  // `recordDailyIv` call, so a kill mid-write (deploy SIGTERM, or the memory
  // watchdog's pm2 self-restart, which writes no deploy record at all) left a
  // truncated file the next boot could not parse.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(payload), 'utf-8');
    await rename(tmp, path);
    persistCount++;
  } catch (err) {
    // Counted, then rethrown; the previous good file is untouched either way.
    await rm(tmp, { force: true }).catch(() => {});
    persistErrors++;
    lastPersistError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/** Provenance + since-boot persist counters, as published on /api/health/short-premium. */
export interface IvStoreProvenanceView {
  /** Whether the store has been loaded in this process (false ⇒ `bootLoad` is null). */
  loaded: boolean;
  /** Resolved store path — readable even before the store loads. */
  storeFile: string;
  /** Null until the store loads; never fabricated from defaults. */
  bootLoad: IvStoreBootProvenance | null;
  /** Successful whole-store writes since boot. */
  persistCount: number;
  /** Failed whole-store writes since boot. */
  persistErrors: number;
  lastPersistError: string | null;
  /**
   * TRA-5172 — true once a load attempt failed in this process. Read beside
   * `bootLoad.parseError` (the reason) and `corruptFileRenamedTo`: failed +
   * renamed means a fresh store is accumulating and the original bytes are
   * safe; failed + not renamed means every persist is being refused.
   */
  loadFailed: boolean;
  /** Writes refused because the unreadable original was still at the store path. */
  persistRefusals: number;
  /** Forensics path the unreadable original was moved to, once the rename succeeds. */
  corruptFileRenamedTo: string | null;
}

/**
 * TRA-5171 — synchronous read of the boot-load provenance for the health route.
 * Honest-null discipline: an unloaded store reads `bootLoad: null`, which can
 * never be confused with a loaded-but-empty one (`bootLoad.samplesLoadedAtBoot: 0`
 * plus the file-existed/parse-error discriminators).
 */
export function readIvStoreProvenanceSync(): IvStoreProvenanceView {
  return {
    loaded: cache != null,
    storeFile: storeFile(),
    bootLoad: bootProvenance,
    persistCount,
    persistErrors,
    lastPersistError,
    loadFailed,
    persistRefusals,
    corruptFileRenamedTo,
  };
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
 * TRA-2206 — merge archive-derived samples into a store map, adding ONLY days the
 * store has no sample for. Pure (exported for tests); {@link seedFromArchive}
 * wraps it with load/persist.
 *
 * Add-only, never overwrite, is the load-bearing rule. The live recorder keys a
 * sample by UTC day ({@link recordDailyIv}) while the chain archive is
 * partitioned by ET date, so the two can disagree by up to one day at a
 * boundary. Refusing to overwrite means a live-recorded sample always wins and
 * the seed can only fill genuine holes; the residual risk is at most one extra
 * sample near a boundary, which is immaterial to a min/max range statistic over
 * a 20+ sample window and can never displace a real observation.
 */
export function mergeMissingDays(
  existing: ReadonlyMap<string, readonly IvSample[]>,
  archived: ReadonlyMap<string, readonly IvSample[]>,
): { merged: Map<string, IvSample[]>; samplesAdded: number; symbolsTouched: number } {
  const merged = new Map<string, IvSample[]>();
  for (const [sym, samples] of existing) merged.set(sym, [...samples]);
  let samplesAdded = 0;
  let symbolsTouched = 0;
  for (const [rawSym, samples] of archived) {
    const sym = rawSym.toUpperCase();
    const current = merged.get(sym) ?? [];
    const haveDays = new Set(current.map((s) => s.day));
    const additions = samples.filter(
      (s) => !haveDays.has(s.day) && Number.isFinite(s.iv) && s.iv > 0,
    );
    if (additions.length === 0) continue;
    const next = [...current, ...additions].sort((a, b) => a.day.localeCompare(b.day));
    merged.set(sym, next.slice(-MAX_SAMPLES));
    samplesAdded += additions.length;
    symbolsTouched++;
  }
  return { merged, samplesAdded, symbolsTouched };
}

/**
 * TRA-2206 — seed the trailing-IV store from archive-derived samples and persist.
 *
 * Why this exists: the store only starts accumulating when a symbol first flows
 * through a chain pull, so every idea surfaced during the warm-up window was
 * stamped `ivRank: null` — 81% of the TRA-2000 resolved cohort on bqb1. The
 * daily chain recorder has far deeper history than the store; this backfills the
 * store from it so `ivRankSync` clears {@link MIN_IV_SAMPLES} for symbols whose
 * chains were recorded all along.
 *
 * NOT read-only: a previously-null `ivRank` becoming a number is visible to the
 * research prompt and the (separately flag-gated) wheel IV entry filter. The
 * caller must therefore gate this on `ENABLE_IV_RANK_ARCHIVE_SEED`; it is off by
 * default so a deploy alone changes nothing.
 */
export async function seedFromArchive(
  archived: ReadonlyMap<string, readonly IvSample[]>,
): Promise<{ samplesAdded: number; symbolsTouched: number }> {
  const map = await ensureLoaded();
  const { merged, samplesAdded, symbolsTouched } = mergeMissingDays(map, archived);
  if (samplesAdded === 0) return { samplesAdded: 0, symbolsTouched: 0 };
  cache = merged;
  await persist();
  log.info('IV store seeded from chain archive', { samplesAdded, symbolsTouched });
  return { samplesAdded, symbolsTouched };
}

/**
 * TRA-2206 — in-window sample depth for `symbol`, the diagnostic that separates
 * "the store is cold, coverage will self-heal" from "no usable IV in the chains,
 * it never will". Returns 0 when the cache is unloaded or the symbol is unknown.
 */
export function ivSampleDepthSync(symbol: string, asOf: number = Date.now()): number {
  if (!cache) return 0;
  const samples = cache.get(symbol.trim().toUpperCase());
  if (!samples) return 0;
  return windowFor(samples, asOf).length;
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
 * TRA-5171 — USABLE in-window sample depth: the trailing window further filtered
 * to finite positive IVs, i.e. exactly the count {@link MIN_IV_SAMPLES} binds
 * against inside {@link computeIvRank}. Exported so the boot-provenance depth
 * histogram and the chain-archive seedable-depth census measure the SAME
 * statistic the live gate does, not a near-miss of it.
 */
export function usableInWindowDepth(samples: readonly IvSample[], asOf: number = Date.now()): number {
  return windowFor(samples, asOf).filter((s) => Number.isFinite(s.iv) && s.iv > 0).length;
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

// ── IV-rank COVERAGE classification (TRA-4917) ───────────────────────────────
//
// `ivRankSync` collapses five structurally different outcomes into one `null`:
// the store never loaded, the chain carried no usable ATM IV, the symbol is
// uncovered, the window is too thin, or the window is flat. On bqb1 the
// short-premium scan published `ivRank: null` on 164/164 rows and NO surface
// could say which branch produced them — and they have opposite fixes (an
// extraction bug vs a store that self-heals as it warms). This is the
// discriminator: one read of the store, one code out of a CLOSED vocabulary.
//
// `not_evaluated` is deliberately part of the vocabulary and is REUSED from the
// existing `buildIvRankCoverage` idiom (options-forward-test.ts): it marks a row
// whose producer supplied no classification at all, so an unclassified row can
// never be silently folded into a real branch.
//
// ── Relationship to `IV_PERCENTILE_COVERAGE_CODES` (correction, 2026-10-02) ──
// TRA-4917 asked for that 4-code vocabulary to be reused rather than a fifth one
// minted. The commit that shipped this file (`0fb62e3e`) recorded that the
// constant "does not exist on origin/main" — THAT WAS WRONG. `215fd4db`
// (TRA-4644) added `iv-percentile-coverage.ts` on 2026-09-17, eight days EARLIER;
// the grep that cleared it ran against a stale `origin/main` in a checkout 285
// commits behind, which is the repo's own LOCAL-IS-A-FORK trap.
//
// The vocabularies are kept COMPATIBLE rather than merged, and the difference is
// load-bearing, so do not pool the two surfaces' counts by code name:
//
//   * All four percentile codes appear here VERBATIM — asserted mechanically in
//     `iv-rank-store.test.ts` so neither list can drift away from the other.
//   * `uncovered` is NARROWER here. `classifyIvPercentileCoverage` pools "store
//     unloaded" into `uncovered`; this classifier splits `store_unloaded` out,
//     because a process-wide blind store and a per-symbol gap have different
//     owners and the 164/164 incident was exactly a failure to tell branches
//     apart. `flat_window` is likewise split out of `insufficient_history` —
//     pooling it tells a reader "warm up and wait" about a window that will
//     never rank.
//   * So this set is a REFINEMENT: every code here maps up to exactly one
//     percentile code, but not back down.

/**
 * Closed vocabulary for "why is this IV-rank what it is". `covered` is the only
 * code that carries a number; every other code means `ivRank === null`, and the
 * set is exhaustive over {@link readIvRankCoverageSync}'s branches.
 */
export const IV_RANK_COVERAGE_CODES = [
  /** A finite 0–100 rank was computed. */
  'covered',
  /** The trailing-IV store is not loaded in this process — every symbol is blind. */
  'store_unloaded',
  /** `atmIvFromRows` found no usable mid IV on the chain this pass (branch (a)). */
  'no_atm_iv',
  /** Store loaded, ATM IV in hand, but ZERO usable in-window samples for the symbol. */
  'uncovered',
  /** 0 < usable in-window samples < {@link MIN_IV_SAMPLES} — self-heals as the store warms. */
  'insufficient_history',
  /** Enough samples, but max === min: a rank would be a meaningless 0 or 100. */
  'flat_window',
  /** The producer supplied no classification (legacy/hand-built row). NOT a measurement. */
  'not_evaluated',
] as const;

export type IvRankCoverageCode = (typeof IV_RANK_COVERAGE_CODES)[number];

/** The rank plus the two diagnostics that separate its null branches. */
export interface IvRankCoverageReading {
  /** Trailing-window IV-rank, or null. Never fabricated — no `?? 0`. */
  ivRank: number | null;
  /** The ATM IV the rank was (or would have been) computed against. */
  atmIv: number | null;
  /**
   * USABLE in-window sample count — {@link windowFor} further filtered to finite
   * positive IVs, i.e. exactly the count {@link MIN_IV_SAMPLES} binds against
   * inside {@link computeIvRank}. `null` only when the store is unloaded, where
   * the honest answer is "unknown", never 0. (This is a strictly tighter number
   * than {@link ivSampleDepthSync}, which does not apply the usability filter.)
   */
  ivSampleDepth: number | null;
  coverage: IvRankCoverageCode;
}

/** Whether the trailing-IV store has been loaded in this process. */
export function isIvRankStoreLoaded(): boolean {
  return cache != null;
}

/**
 * Classify one symbol's IV-rank read, reading the store ONCE so the rank and the
 * reason can never disagree about which window they saw.
 *
 * Precedence — `store_unloaded` before `no_atm_iv` because an unloaded store is a
 * PROCESS fault that makes the whole surface blind, and reporting a per-symbol
 * chain reason for it would understate the fault. Below that the branches are
 * mutually exclusive by construction: with `atmIv > 0` guaranteed,
 * {@link computeIvRank} can only return null for `usable.length < MIN_IV_SAMPLES`
 * or `max <= min`, so `uncovered` / `insufficient_history` / `flat_window`
 * partition the remaining null space exhaustively.
 */
export function readIvRankCoverageSync(
  symbol: string,
  atmIv: number | null,
  asOf: number = Date.now(),
): IvRankCoverageReading {
  const iv = atmIv != null && Number.isFinite(atmIv) && atmIv > 0 ? atmIv : null;
  if (!cache) {
    return { ivRank: null, atmIv: iv, ivSampleDepth: null, coverage: 'store_unloaded' };
  }
  const samples = cache.get(symbol.trim().toUpperCase()) ?? [];
  const usable = windowFor(samples, asOf).filter((s) => Number.isFinite(s.iv) && s.iv > 0);
  const depth = usable.length;
  if (iv == null) {
    return { ivRank: null, atmIv: null, ivSampleDepth: depth, coverage: 'no_atm_iv' };
  }
  const ivRank = computeIvRank(usable, iv);
  if (ivRank != null) {
    return { ivRank, atmIv: iv, ivSampleDepth: depth, coverage: 'covered' };
  }
  const coverage: IvRankCoverageCode =
    depth === 0 ? 'uncovered' : depth < MIN_IV_SAMPLES ? 'insufficient_history' : 'flat_window';
  return { ivRank: null, atmIv: iv, ivSampleDepth: depth, coverage };
}
