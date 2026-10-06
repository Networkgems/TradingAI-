import { loadChainDays, estimateSpotFromChain, type ChainDay } from '@trading-app/backtest';
import { buildIvSeriesFromChains } from './iv-rank-archive.js';
import { MIN_IV_SAMPLES, usableInWindowDepth } from './iv-rank-store.js';
import { defaultChainsDir } from './options-forward-test.js';
import { logger } from './observability/index.js';

// TRA-5171 (step 1 of the TRA-5170 ruling) — chain-archive SEEDABLE-DEPTH CENSUS.
//
// The ruling defers the `ENABLE_IV_RANK_ARCHIVE_SEED` option because the seed's
// own source depth was UNMEASURED: the only number anyone had was a stale code
// comment ("~45 dates of full chains", TRA-2476 era), which is documentation,
// not a live read. This module measures it — for each symbol the chain recorder
// has partitions for, the per-symbol ATM-IV series depth the archive seed WOULD
// produce (via the same pure `buildIvSeriesFromChains` the seed path uses), and
// specifically how many of the live short-premium universe's symbols would clear
// {@link MIN_IV_SAMPLES}. That single count decides the seed option.
//
// READ-ONLY by construction: nothing here writes the store, flips a flag, or
// changes a gate. It is a disk walk over `<DATA_DIR>/option-chains`, so it is
// CACHED — computed once in the background (kicked at boot and lazily from the
// health route), refreshed on a long TTL (the archive gains at most one
// partition per day). A request never blocks on the walk; until the first walk
// finishes the route reads an honest `status: 'pending'`, never a fabricated 0.

const log = logger.child({ module: 'iv-seed-census' });

/** Refresh interval — the archive gains at most one partition per trading day. */
const CENSUS_REFRESH_MS = 6 * 3_600_000;

/** What the chain archive could seed, measured — published on /api/health/short-premium. */
export interface ArchiveSeedCensus {
  /** Resolved archive root the walk ran over. */
  chainsDir: string;
  /** Non-empty date partitions found. */
  partitionCount: number;
  oldestPartitionDay: string | null;
  newestPartitionDay: string | null;
  /** Symbols for which the archive yields at least one usable ATM-IV sample. */
  archiveSymbolCount: number;
  /** Usable in-window seed depth → count of archive symbols at that depth. */
  depthHistogram: Record<string, number>;
  /** Archive symbols whose seedable in-window depth clears {@link MIN_IV_SAMPLES}. */
  archiveSymbolsAtOrAboveFloor: number;
  /** The sample floor the depths are graded against (the store's own). */
  minSamples: number;
  computedAt: string;
  computeMs: number;
}

export type ChainDayLoader = (dataDir: string) => Promise<ChainDay[]>;

interface CensusCache {
  census: ArchiveSeedCensus;
  /** Per-symbol seedable depth, retained for the universe rollup (not on the wire). */
  depthBySymbol: Map<string, number>;
  computedAtMs: number;
}

let cached: CensusCache | null = null;
let inFlight: Promise<void> | null = null;
let lastComputeError: string | null = null;
let loaderOverride: ChainDayLoader | null = null;
let chainsDirOverride: string | null = null;

/** Test seam — inject a loader/dir and clear all cached state. Pass no args to restore. */
export function resetArchiveSeedCensusForTests(
  loader: ChainDayLoader | null = null,
  chainsDir: string | null = null,
): void {
  cached = null;
  inFlight = null;
  lastComputeError = null;
  loaderOverride = loader;
  chainsDirOverride = chainsDir;
}

async function computeCensus(asOf: number): Promise<void> {
  const chainsDir = chainsDirOverride ?? defaultChainsDir();
  const started = Date.now();
  try {
    const days = await (loaderOverride ?? loadChainDays)(chainsDir);
    const series = buildIvSeriesFromChains(days, estimateSpotFromChain);
    const depthBySymbol = new Map<string, number>();
    const depthHistogram: Record<string, number> = {};
    let atOrAboveFloor = 0;
    for (const [sym, samples] of series) {
      const depth = usableInWindowDepth(samples, asOf);
      depthBySymbol.set(sym, depth);
      depthHistogram[String(depth)] = (depthHistogram[String(depth)] ?? 0) + 1;
      if (depth >= MIN_IV_SAMPLES) atOrAboveFloor++;
    }
    cached = {
      census: {
        chainsDir,
        partitionCount: days.length,
        oldestPartitionDay: days.length > 0 ? days[0]!.date : null,
        newestPartitionDay: days.length > 0 ? days[days.length - 1]!.date : null,
        archiveSymbolCount: series.size,
        depthHistogram,
        archiveSymbolsAtOrAboveFloor: atOrAboveFloor,
        minSamples: MIN_IV_SAMPLES,
        computedAt: new Date().toISOString(),
        computeMs: Date.now() - started,
      },
      depthBySymbol,
      computedAtMs: Date.now(),
    };
    lastComputeError = null;
    log.info('archive seedable-depth census computed', {
      partitions: cached.census.partitionCount,
      symbols: cached.census.archiveSymbolCount,
      atOrAboveFloor,
      computeMs: cached.census.computeMs,
    });
  } catch (err) {
    // Keep any previous census (served with its own computedAt beside the error)
    // rather than discarding a good measurement over one failed refresh.
    lastComputeError = err instanceof Error ? err.message : String(err);
    log.warn('archive seedable-depth census failed', { reason: lastComputeError });
  }
}

/**
 * Kick the census in the background if none is cached or the cache has aged past
 * {@link CENSUS_REFRESH_MS}. Never blocks the caller and never throws — a walk
 * failure lands in `computeError` on the read, not on a request. Returns the
 * in-flight promise (or null when the cache is fresh) so tests can await the
 * walk; production callers deliberately do not.
 */
export function ensureArchiveSeedCensusFresh(now: number = Date.now()): Promise<void> | null {
  if (inFlight) return inFlight;
  if (cached && now - cached.computedAtMs < CENSUS_REFRESH_MS) return null;
  inFlight = computeCensus(now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** The census as published: `pending` until the first walk completes. */
export interface ArchiveSeedCensusRead {
  /** `ready` ⇒ `census` is a measurement; `pending` ⇒ the walk has not completed. */
  status: 'ready' | 'pending';
  /** Last walk failure, verbatim, or null. Non-null beside `ready` = serving a stale census. */
  computeError: string | null;
  census: ArchiveSeedCensus | null;
}

/** Read the cached census (kicking a background compute/refresh as a side effect). */
export function readArchiveSeedCensusSync(now: number = Date.now()): ArchiveSeedCensusRead {
  void ensureArchiveSeedCensusFresh(now);
  return {
    status: cached != null ? 'ready' : 'pending',
    computeError: lastComputeError,
    census: cached != null ? cached.census : null,
  };
}

/**
 * The TRA-5170 decision block: of the symbols in the CURRENT short-premium fold
 * (the live universe — 82 on bqb1 at ruling time), how many would the archive
 * seed take to a usable in-window depth of {@link MIN_IV_SAMPLES} or better.
 */
export interface SeedableUniverseSummary {
  /** Distinct symbols in the current fresh scan fold. */
  universeSize: number;
  /** `archive_census` = the numbers below are measurements; `census_pending` = nulls. */
  basis: 'archive_census' | 'census_pending';
  /** Universe symbols the archive holds at least one usable sample for. */
  matchedInArchive: number | null;
  /** THE deciding number: universe symbols whose seedable depth >= `minSamples`. */
  seedableAtFloor: number | null;
  minSamples: number;
  /** Seedable depth → count of UNIVERSE symbols at that depth. */
  universeDepthHistogram: Record<string, number> | null;
}

/** Roll the cached census up over the given universe symbols. */
export function summarizeSeedableUniverse(symbols: readonly string[]): SeedableUniverseSummary {
  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()))];
  if (cached == null) {
    return {
      universeSize: unique.length,
      basis: 'census_pending',
      matchedInArchive: null,
      seedableAtFloor: null,
      minSamples: MIN_IV_SAMPLES,
      universeDepthHistogram: null,
    };
  }
  let matched = 0;
  let seedableAtFloor = 0;
  const universeDepthHistogram: Record<string, number> = {};
  for (const sym of unique) {
    const depth = cached.depthBySymbol.get(sym);
    // Absence from a COMPLETED census is a measurement, not an unread counter:
    // the walk ran and yielded zero usable samples for this symbol, so the seed
    // would produce depth 0 for it. (Distinct from `census_pending`, where no
    // walk has run and every field above stays null.)
    const measuredDepth = depth != null ? depth : 0;
    if (depth != null) matched++;
    universeDepthHistogram[String(measuredDepth)] =
      (universeDepthHistogram[String(measuredDepth)] ?? 0) + 1;
    if (measuredDepth >= MIN_IV_SAMPLES) seedableAtFloor++;
  }
  return {
    universeSize: unique.length,
    basis: 'archive_census',
    matchedInArchive: matched,
    seedableAtFloor,
    minSamples: MIN_IV_SAMPLES,
    universeDepthHistogram,
  };
}
