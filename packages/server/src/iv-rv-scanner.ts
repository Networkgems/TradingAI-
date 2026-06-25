import {
  findIvRvMispricings,
  realizedVolFromDailyCloses,
  type OptionChainRow,
  type IvRvMispricingCandidate,
  type IvRvScannerOptions,
} from '@trading-app/engine';

// TRA-1156 (TRA-1155 follow-up) — wire the IV-vs-realised-vol mispricing engine
// into the live pipeline, OBSERVE-ONLY and flag-gated (ENABLE_OPTION_IV_RV_SCANNER).
//
// This module is the thin sibling to `relative-value-scanner.ts`: the RV scanner
// owns the Tradier chain fetch / cache / breaker; this layer is PURE wiring on
// top of a chain snapshot the caller already has in hand. `scanIvRvFromSnapshot`
// computes the underlying's realised vol from its daily closes and runs
// `findIvRvMispricings`; it places NO orders and touches no account. The signal
// engine calls it per demo tick and records the result into the in-memory store
// below, which backs the read-only `GET /api/health/iv-rv` diagnostics surface.
//
// In-memory (not the on-disk option journal) by design: these are transient,
// observe-only candidates the board watches to decide thresholds — they are not
// trade outcomes, so nothing here needs to survive a restart. The store is
// per-symbol latest-wins and capped so it can't grow without bound.

/** Why a scan produced (or did not produce) candidates — surfaced for diagnosis. */
export type IvRvScanReason =
  | 'ok'
  | 'no_chain'
  | 'no_spot'
  | 'no_realized_vol'
  | 'no_candidates';

export interface IvRvScanResult {
  symbol: string;
  spot: number | null;
  expiration: string | null;
  /** Annualised realised vol used as the baseline σ, or null when uncomputable. */
  realizedVol: number | null;
  /** Number of daily closes the realised-vol estimate was built from. */
  dailyCloseCount: number;
  candidates: IvRvMispricingCandidate[];
  reason: IvRvScanReason;
}

export interface IvRvSnapshotInput {
  symbol: string;
  spot: number;
  expiration: string;
  rows: OptionChainRow[];
}

/**
 * Run the IV-vs-RV mispricing engine over a chain snapshot the caller already
 * holds (the warm RV-scanner selector chain). `dailyCloses` is the underlying's
 * closed daily-bar close series (already loaded for the book); realised vol is
 * derived from it via {@link realizedVolFromDailyCloses}. Pure — no I/O, no
 * orders. Returns an empty candidate list with a discriminating `reason` when a
 * precondition is missing so the diagnostics surface can explain a quiet scan.
 *
 * @param lookbackDays trailing window for the realised-vol estimate (default 20).
 */
export function scanIvRvFromSnapshot(
  snap: IvRvSnapshotInput,
  dailyCloses: readonly number[],
  options: IvRvScannerOptions = {},
  lookbackDays = 20,
): IvRvScanResult {
  const symbol = snap.symbol.trim().toUpperCase();
  const base: Omit<IvRvScanResult, 'candidates' | 'reason'> = {
    symbol,
    spot: Number.isFinite(snap.spot) && snap.spot > 0 ? snap.spot : null,
    expiration: snap.expiration || null,
    realizedVol: null,
    dailyCloseCount: dailyCloses.length,
  };

  if (base.spot == null) return { ...base, candidates: [], reason: 'no_spot' };
  if (snap.rows.length === 0) return { ...base, candidates: [], reason: 'no_chain' };

  const realizedVol = realizedVolFromDailyCloses(dailyCloses, lookbackDays);
  if (realizedVol == null) {
    return { ...base, candidates: [], reason: 'no_realized_vol' };
  }

  const candidates = findIvRvMispricings(snap.rows, base.spot, realizedVol, options);
  return {
    ...base,
    realizedVol,
    candidates,
    reason: candidates.length > 0 ? 'ok' : 'no_candidates',
  };
}

// ── In-memory latest-scan store (backs GET /api/health/iv-rv) ────────────────

interface StoredScan {
  result: IvRvScanResult;
  recordedAt: number;
}

/** Cap on retained symbols so the store can't grow unbounded over a long run. */
const MAX_STORED_SYMBOLS = 128;
/** Entries older than this are swept on read so the surface never shows stale candidates. */
const STORE_TTL_MS = 30 * 60_000;

const store = new Map<string, StoredScan>();

/**
 * Record the latest IV-vs-RV scan for a symbol (latest-wins). Oldest-inserted
 * symbols are evicted past the cap. Demo-only / observe-only — callers gate on
 * the flag, so the store stays empty when the scanner is off.
 */
export function recordIvRvScan(result: IvRvScanResult, now: number = Date.now()): void {
  const key = result.symbol.trim().toUpperCase();
  store.delete(key); // re-insert at the tail so eviction is oldest-first
  store.set(key, { result: { ...result, symbol: key }, recordedAt: now });
  while (store.size > MAX_STORED_SYMBOLS) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Test seam — drop every recorded scan. */
export function clearIvRvScans(): void {
  store.clear();
}

/** One symbol's most-recent scan, redacted to the diagnostics shape. */
export interface IvRvScanView {
  symbol: string;
  spot: number | null;
  expiration: string | null;
  realizedVol: number | null;
  dailyCloseCount: number;
  reason: IvRvScanReason;
  recordedAt: string;
  candidateCount: number;
  candidates: Array<{
    optionSymbol: string;
    underlying: string;
    optionType: IvRvMispricingCandidate['optionType'];
    strike: number;
    expiration: string;
    daysToExpiration: number;
    action: IvRvMispricingCandidate['action'];
    ivRvRatio: number;
    mispricingPct: number;
    score: number;
    impliedVol: number;
    realizedVol: number;
    mark: number;
    fairValue: number;
    delta: number;
    reason: string;
  }>;
}

export interface IvRvScansSummary {
  /** Symbols with a fresh (within-TTL) recorded scan. */
  symbolCount: number;
  /** Total candidates across all fresh scans. */
  candidateCount: number;
  scans: IvRvScanView[];
}

/**
 * Fold the store into the read-only diagnostics summary, dropping entries past
 * the TTL and sorting symbols by their strongest candidate score (most-mispriced
 * first), then by symbol for stability. Pure beyond the injected clock.
 */
export function summarizeIvRvScans(now: number = Date.now()): IvRvScansSummary {
  const views: Array<{ view: IvRvScanView; topScore: number }> = [];
  for (const [key, entry] of store) {
    if (now - entry.recordedAt >= STORE_TTL_MS) {
      store.delete(key);
      continue;
    }
    const r = entry.result;
    const candidates = r.candidates.map((c) => ({
      optionSymbol: c.optionSymbol,
      underlying: c.underlying,
      optionType: c.optionType,
      strike: c.strike,
      expiration: c.expiration,
      daysToExpiration: c.daysToExpiration,
      action: c.action,
      ivRvRatio: c.ivRvRatio,
      mispricingPct: c.mispricingPct,
      score: c.score,
      impliedVol: c.impliedVol,
      realizedVol: c.realizedVol,
      mark: c.mark,
      fairValue: c.fairValue,
      delta: c.delta,
      reason: c.reason,
    }));
    views.push({
      topScore: candidates.length > 0 ? candidates[0]!.score : -1,
      view: {
        symbol: r.symbol,
        spot: r.spot,
        expiration: r.expiration,
        realizedVol: r.realizedVol,
        dailyCloseCount: r.dailyCloseCount,
        reason: r.reason,
        recordedAt: new Date(entry.recordedAt).toISOString(),
        candidateCount: candidates.length,
        candidates,
      },
    });
  }
  views.sort((a, b) => b.topScore - a.topScore || a.view.symbol.localeCompare(b.view.symbol));
  const scans = views.map((v) => v.view);
  return {
    symbolCount: scans.length,
    candidateCount: scans.reduce((acc, s) => acc + s.candidateCount, 0),
    scans,
  };
}
