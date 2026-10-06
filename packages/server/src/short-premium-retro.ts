import { loadChainDays, estimateSpotFromChain, type ChainDay } from '@trading-app/backtest';
import { realizedVolFromDailyCloses, type OptionChainRow } from '@trading-app/engine';
import { buildIvSeriesFromChains, reconstructIvStatsAt, type ReconstructionMiss } from './iv-rank-archive.js';
import { atmIvFromRows, MIN_IV_SAMPLES, type IvSample } from './iv-rank-store.js';
import { defaultChainsDir } from './options-forward-test.js';
import { logger } from './observability/index.js';

// TRA-5241 — READ-ONLY retrospective emitter over the recorded chain archive.
//
// TRA-5173 item 3 ("what would the IVR>=50 floor actually have selected?") is
// the only term of that grade that can move before the live store accrues
// `minSamples` depth (~2026-10-29 on arithmetic), and the data it needs — full
// chains per (symbol, ET day) since 2026-05-15 — already sits on bqb1 under
// `<DATA_DIR>/option-chains`. This module replays the archive through the SAME
// pure functions the live paths use and publishes one row per (symbol, archive
// day) on `GET /api/health/short-premium-retro`, so the cohort compare (A =
// ivRv>=1, B = A ∩ ivRank>=50, graded on forward realised vol) can run off the
// wire without waiting for store depth.
//
// Reuse, not reinvention — each statistic is the shipped definition:
//   • ivRank / ivPercentile — `reconstructIvStatsAt` (TRA-2206/TRA-2028): both
//     statistics off ONE backward-only (`day <= D`) window, so there is no
//     look-ahead and no scope divergence between the two.
//   • realizedVol — `realizedVolFromDailyCloses` (TRA-430 close-to-close,
//     lookback 20, annualised √252), exactly the estimator the live
//     short-premium scan feeds `findShortPremiumStructures` as its VRP baseline.
//     The close series here is the archive's own per-day recorded spot (capture
//     ~same time each session), the only daily price series the archive
//     affords; the estimator and lookback are the scanner's own.
//   • ivRvRatio — `atmIv / realizedVol`. The live gate at
//     `short-premium-scanner.ts` (engine) line ~282 divides the SHORT STRIKE's
//     IV by this same realizedVol; per (symbol, day) rows have no short strike,
//     so the ATM IV stands in for it — same denominator, same estimator, ATM
//     numerator. Named here so nobody mistakes it for a fresh definition.
//   • fwdRealizedVol30 — the SAME estimator run over the FORWARD window
//     (D, D+30] calendar days (base close = the close at D), the realised
//     outcome a short-premium entry at D was paid against. Rows whose forward
//     window runs past the newest partition are COMPUTED OVER WHAT EXISTS and
//     flagged `fwdWindowComplete: false` — never silently truncated, never
//     dropped, never padded (TRA-5241 load-bearing requirement #1).
//
// Null discipline (requirement #2): a null ivRank is a MEASUREMENT — the floor
// would have been inert on that row — so null rows are emitted with the same
// closed reason vocabulary the live scan uses (`ReconstructionMiss` plus the
// two extraction codes below), never dropped.
//
// daysToNextEarnings (requirement #3): there is NO dated forward earnings
// series on this host (the Tradier corporate-actions feed is splits/dividends
// history; news-catalyst is keyword detection, not a calendar), so the field is
// an explicit null with `earningsBasis: 'no_dated_earnings_series_on_host'` —
// the term is honestly unmeasured, not quietly graded without.
//
// READ-ONLY by construction: a disk walk plus pure math. Nothing here writes
// the store, flips a flag, gates a scan, or places an order. The walk is
// CACHED on the iv-seed-census pattern — computed lazily in the background,
// long TTL (the archive gains one partition per trading day); until the first
// walk completes the route serves an honest `status: 'pending'`, never a
// fabricated empty row set.

const log = logger.child({ module: 'short-premium-retro' });

/** Refresh interval — the archive gains at most one partition per trading day. */
const RETRO_REFRESH_MS = 6 * 3_600_000;

/** Trailing realised-vol lookback — the live scan's own default (`lookbackDays = 20`). */
export const RETRO_RV_LOOKBACK_DAYS = 20;

/** Forward realised-vol horizon, calendar days — the (D, D+30] outcome window. */
export const FWD_REALIZED_VOL_CALENDAR_DAYS = 30;

/** Why a row carries no ATM IV of its own — the extraction half of the vocabulary. */
export type AtmIvMiss =
  /** The partition recorded no usable spot and none could be estimated off the chain. */
  | 'no_spot'
  /** Spot resolved but no row on the day's chain carried a usable mid IV. */
  | 'no_atm_iv';

/** One (symbol, archive day) observation — the TRA-5241 per-row payload. */
export interface ShortPremiumRetroRow {
  symbol: string;
  /** D — the archive partition day (ET date the chain was captured). */
  day: string;
  /** `reconstructIvRankAt(symbol, D)` — the shipped pure fn, unchanged. */
  ivRank: number | null;
  /** Why `ivRank` is null — the live scan's closed vocabulary. Null when ranked. */
  ivRankMiss: ReconstructionMiss | null;
  /** `computeIvPercentile` at D over the SAME window as `ivRank` (TRA-5173 item 1). */
  ivPercentile: number | null;
  /** ATM IV captured on day D itself, or null with `atmIvMiss` naming why. */
  atmIv: number | null;
  atmIvMiss: AtmIvMiss | null;
  /** Resolved spot for day D (recorded, else chain-estimated), or null. */
  spot: number | null;
  /** Trailing realised vol at D — the scanner's own estimator/lookback over archive closes <= D. */
  realizedVol: number | null;
  /** Closes feeding `realizedVol` (including D's own). */
  realizedVolCloseCount: number;
  /** `atmIv / realizedVol` — the live `minIvRvRatio: 1.0` gate's read at the ATM point. */
  ivRvRatio: number | null;
  /** Realised vol over the forward window (D, D+30] (base close at D). */
  fwdRealizedVol30: number | null;
  /** Closes inside (D, D+30] (excluding the base close at D). */
  fwdCloseCount: number;
  /** FALSE when D + 30 runs past the newest partition — filter, don't trust, those rows. */
  fwdWindowComplete: boolean;
  /** `atmIv - fwdRealizedVol30` — the outcome. Positive = short premium won on this row. */
  vrpRealized: number | null;
  /** Samples backing `ivRank` at D (the reconstruction window size). */
  ivSampleDepth: number;
  /** Always null on this host — no dated earnings series is reachable (see `earningsBasis`). */
  daysToNextEarnings: number | null;
}

/** The computed retro set plus the provenance a grader needs to trust it. */
export interface ShortPremiumRetro {
  /** Resolved archive root the walk ran over. */
  chainsDir: string;
  /** Non-empty date partitions found. */
  partitionCount: number;
  oldestPartitionDay: string | null;
  /** The archive end — `fwdWindowComplete` is graded against this day. */
  newestPartitionDay: string | null;
  /** Distinct symbols with at least one archive row. */
  symbolCount: number;
  rowCount: number;
  /** The store's own sample floor (`MIN_IV_SAMPLES`) binding both statistics. */
  minSamples: number;
  /** Named definitions, so the consumer never has to reverse-engineer a basis. */
  definitions: {
    realizedVol: string;
    ivRvRatio: string;
    fwdRealizedVol30: string;
    closesBasis: string;
    population: string;
  };
  /** Why `daysToNextEarnings` is null on every row (TRA-5241 requirement #3). */
  earningsBasis: 'no_dated_earnings_series_on_host';
  rows: ShortPremiumRetroRow[];
  computedAt: string;
  computeMs: number;
}

interface DatedClose {
  day: string;
  close: number;
}

function resolveSpot(
  snap: { spot: number | null; rows: OptionChainRow[] },
  estimateSpot: (rows: readonly OptionChainRow[]) => number | null,
): number | null {
  return typeof snap.spot === 'number' && Number.isFinite(snap.spot) && snap.spot > 0
    ? snap.spot
    : estimateSpot(snap.rows);
}

function addCalendarDays(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Pure builder — one row per (symbol, archive day the recorder captured that
 * symbol). Deterministic from `chainDays` alone: no clock, no env, no I/O.
 * Backward-only statistics at D never read a partition after D; the two
 * forward fields read only (D, D+30] and are flagged when that window runs
 * past the archive end.
 */
export function buildShortPremiumRetroRows(
  chainDays: readonly ChainDay[],
  estimateSpot: (rows: readonly OptionChainRow[]) => number | null = estimateSpotFromChain,
): { rows: ShortPremiumRetroRow[]; newestPartitionDay: string | null } {
  const days = [...chainDays].sort((a, b) => a.date.localeCompare(b.date));
  const newestPartitionDay = days.length > 0 ? days[days.length - 1]!.date : null;

  // The same ATM-IV series the archive seed / forward-test reconstruction use.
  const ivSeries: Map<string, IvSample[]> = buildIvSeriesFromChains(days, estimateSpot);

  // Per-symbol dated close series off the archive's own recorded spots.
  const closesBySymbol = new Map<string, DatedClose[]>();
  for (const day of days) {
    for (const [symbol, snap] of day.bySymbol) {
      const spot = resolveSpot(snap, estimateSpot);
      if (spot == null) continue;
      const key = symbol.toUpperCase();
      const arr = closesBySymbol.get(key) ?? [];
      arr.push({ day: day.date, close: spot });
      closesBySymbol.set(key, arr);
    }
  }
  for (const arr of closesBySymbol.values()) arr.sort((a, b) => a.day.localeCompare(b.day));

  const rows: ShortPremiumRetroRow[] = [];
  for (const day of days) {
    const d = day.date;
    for (const [rawSymbol, snap] of day.bySymbol) {
      const symbol = rawSymbol.toUpperCase();
      const spot = resolveSpot(snap, estimateSpot);
      const atmIv = spot == null ? null : atmIvFromRows(snap.rows, spot);
      const atmIvMiss: AtmIvMiss | null = spot == null ? 'no_spot' : atmIv == null ? 'no_atm_iv' : null;

      const stats = reconstructIvStatsAt(ivSeries.get(symbol) ?? [], d);

      const closes = closesBySymbol.get(symbol) ?? [];
      const trailing = closes.filter((c) => c.day <= d).map((c) => c.close);
      const realizedVol = realizedVolFromDailyCloses(trailing, RETRO_RV_LOOKBACK_DAYS);

      const fwdEnd = addCalendarDays(d, FWD_REALIZED_VOL_CALENDAR_DAYS);
      const fwdWindow = closes.filter((c) => c.day > d && c.day <= fwdEnd).map((c) => c.close);
      const baseClose = trailing.length > 0 ? trailing[trailing.length - 1] : undefined;
      const fwdCloses = baseClose != null ? [baseClose, ...fwdWindow] : fwdWindow;
      // The whole forward series feeds the estimator (windowBars = its own
      // return count) — the 20-bar trailing default must not clip the outcome.
      const fwdRealizedVol30 =
        fwdCloses.length >= 2 ? realizedVolFromDailyCloses(fwdCloses, fwdCloses.length, 252) : null;
      const fwdWindowComplete = newestPartitionDay != null && fwdEnd <= newestPartitionDay;

      rows.push({
        symbol,
        day: d,
        ivRank: stats.ivRank,
        ivRankMiss: stats.miss,
        ivPercentile: stats.ivPercentile,
        atmIv,
        atmIvMiss,
        spot,
        realizedVol,
        realizedVolCloseCount: trailing.length,
        ivRvRatio: atmIv != null && realizedVol != null ? atmIv / realizedVol : null,
        fwdRealizedVol30,
        fwdCloseCount: fwdWindow.length,
        fwdWindowComplete,
        vrpRealized: atmIv != null && fwdRealizedVol30 != null ? atmIv - fwdRealizedVol30 : null,
        ivSampleDepth: stats.windowSamples,
        daysToNextEarnings: null,
      });
    }
  }
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.day.localeCompare(b.day));
  return { rows, newestPartitionDay };
}

export type ChainDayLoader = (dataDir: string) => Promise<ChainDay[]>;

interface RetroCache {
  retro: ShortPremiumRetro;
  computedAtMs: number;
}

let cached: RetroCache | null = null;
let inFlight: Promise<void> | null = null;
let lastComputeError: string | null = null;
let loaderOverride: ChainDayLoader | null = null;
let chainsDirOverride: string | null = null;

/** Test seam — inject a loader/dir and clear all cached state. Pass no args to restore. */
export function resetShortPremiumRetroForTests(
  loader: ChainDayLoader | null = null,
  chainsDir: string | null = null,
): void {
  cached = null;
  inFlight = null;
  lastComputeError = null;
  loaderOverride = loader;
  chainsDirOverride = chainsDir;
}

async function computeRetro(): Promise<void> {
  const chainsDir = chainsDirOverride ?? defaultChainsDir();
  const started = Date.now();
  try {
    const days = await (loaderOverride ?? loadChainDays)(chainsDir);
    const { rows, newestPartitionDay } = buildShortPremiumRetroRows(days, estimateSpotFromChain);
    cached = {
      retro: {
        chainsDir,
        partitionCount: days.length,
        oldestPartitionDay: days.length > 0 ? days[0]!.date : null,
        newestPartitionDay,
        symbolCount: new Set(rows.map((r) => r.symbol)).size,
        rowCount: rows.length,
        minSamples: MIN_IV_SAMPLES,
        definitions: {
          realizedVol:
            `realizedVolFromDailyCloses (TRA-430 close-to-close, lookback ${RETRO_RV_LOOKBACK_DAYS}, ` +
            'annualised sqrt(252)) over archive closes <= D — the live scan’s own estimator and lookback',
          ivRvRatio:
            'atmIv / realizedVol — same denominator/estimator as the live minIvRvRatio gate ' +
            '(short-premium-scanner ~L282); ATM IV stands in for the short strike’s IV on per-day rows',
          fwdRealizedVol30:
            `same estimator over the forward (D, D+${FWD_REALIZED_VOL_CALENDAR_DAYS}] calendar window ` +
            '(base close at D); computed over what exists and flagged via fwdWindowComplete when the ' +
            'window runs past the archive end — never truncated silently, never padded',
          closesBasis:
            'the archive’s own per-day recorded spot (capture-time, not official close) — the only ' +
            'daily price series the chain archive affords',
          population:
            'one row per (symbol, archive day the recorder captured that symbol); null ivRank rows are ' +
            'emitted with their reason code, never dropped',
        },
        earningsBasis: 'no_dated_earnings_series_on_host',
        rows,
        computedAt: new Date().toISOString(),
        computeMs: Date.now() - started,
      },
      computedAtMs: Date.now(),
    };
    lastComputeError = null;
    log.info('short-premium retro computed', {
      partitions: days.length,
      rows: rows.length,
      symbols: cached.retro.symbolCount,
      computeMs: cached.retro.computeMs,
    });
  } catch (err) {
    // Keep any previous retro (served beside the error) rather than discarding
    // a good measurement over one failed refresh.
    lastComputeError = err instanceof Error ? err.message : String(err);
    log.warn('short-premium retro compute failed', { reason: lastComputeError });
  }
}

/**
 * Kick the retro walk in the background if none is cached or the cache has aged
 * past {@link RETRO_REFRESH_MS}. Never blocks and never throws — a walk failure
 * lands in `computeError` on the read. Returns the in-flight promise so tests
 * can await it; production callers deliberately do not.
 */
export function ensureShortPremiumRetroFresh(now: number = Date.now()): Promise<void> | null {
  if (inFlight) return inFlight;
  if (cached && now - cached.computedAtMs < RETRO_REFRESH_MS) return null;
  inFlight = computeRetro().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** The retro set as published: `pending` until the first walk completes. */
export interface ShortPremiumRetroRead {
  /** `ready` ⇒ `retro` is a measurement; `pending` ⇒ the walk has not completed. */
  status: 'ready' | 'pending';
  /** Last walk failure, verbatim, or null. Non-null beside `ready` = serving a stale retro. */
  computeError: string | null;
  retro: ShortPremiumRetro | null;
}

/** Read the cached retro (kicking a background compute/refresh as a side effect). */
export function readShortPremiumRetroSync(now: number = Date.now()): ShortPremiumRetroRead {
  void ensureShortPremiumRetroFresh(now);
  return {
    status: cached != null ? 'ready' : 'pending',
    computeError: lastComputeError,
    retro: cached != null ? cached.retro : null,
  };
}
