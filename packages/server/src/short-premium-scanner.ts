import {
  findShortPremiumStructures,
  realizedVolFromDailyCloses,
  type OptionChainRow,
  type ShortPremiumCandidate,
  type ShortPremiumScannerOptions,
} from '@trading-app/engine';

// TRA-1292 — wire the defined-risk SHORT-PREMIUM engine (credit spreads / iron
// condors) into the live pipeline, OBSERVE-ONLY and flag-gated
// (ENABLE_OPTION_SHORT_PREMIUM_SCANNER). Sibling to `iv-rv-scanner.ts`.
//
// This layer is PURE wiring on top of a chain snapshot the caller already holds
// (the warm RV-scanner selector chain). `scanShortPremiumFromSnapshot` computes
// the underlying's realised vol from its daily closes (the VRP baseline), takes
// the trailing-year IV-rank the caller stamped (TRA-1153), and runs
// `findShortPremiumStructures`. It places NO orders and touches no account. The
// signal engine calls it per demo tick and records the result into the in-memory
// store below, which backs the read-only `GET /api/health/short-premium`
// diagnostics surface.
//
// The desk gate is ivRank >= 50 (elevated IV) + VRP-positive (IV/RV >= 1) +
// short-strike delta ~0.15–0.30. A FINITE rank below the floor stands the scan
// down here with a discriminating `reason`; an unknown rank (thin IV store on a
// fresh demo, TRA-1114) is allowed to surface OBSERVE-ONLY candidates so the
// forward sample can accrue while the store warms — the >= 50 rank gate is
// re-asserted as a hard LIVE-promotion gate, not an observe gate. Live promotion
// stays gated on TRA-382 regardless.
//
// In-memory (not the on-disk option journal) by design: these are transient,
// observe-only candidates the board watches to decide thresholds — not trade
// outcomes — so nothing here needs to survive a restart. Per-symbol latest-wins,
// capped so it can't grow without bound.

/** The elevated-IV floor (mirrors the engine default) — the desk's sell gate. */
export const SHORT_PREMIUM_MIN_IV_RANK = 50;

/** Why a scan produced (or did not produce) structures — surfaced for diagnosis. */
export type ShortPremiumScanReason =
  | 'ok'
  | 'no_chain'
  | 'no_spot'
  | 'no_realized_vol'
  | 'ivrank_low'
  | 'no_candidates';

export interface ShortPremiumScanResult {
  symbol: string;
  spot: number | null;
  expiration: string | null;
  /** Annualised realised vol used as the VRP baseline σ, or null when uncomputable. */
  realizedVol: number | null;
  /** Number of daily closes the realised-vol estimate was built from. */
  dailyCloseCount: number;
  /** Trailing-year IV-rank (TRA-1153), or null when the store is thin/uncovered. */
  ivRank: number | null;
  candidates: ShortPremiumCandidate[];
  reason: ShortPremiumScanReason;
}

export interface ShortPremiumSnapshotInput {
  symbol: string;
  spot: number;
  expiration: string;
  rows: OptionChainRow[];
}

/**
 * Run the short-premium engine over a chain snapshot the caller already holds.
 * `dailyCloses` is the underlying's closed daily-bar close series (realised vol
 * is derived from it); `ivRank` is the trailing-year IV-rank the caller stamped.
 * Pure — no I/O, no orders. Returns an empty candidate list with a discriminating
 * `reason` when a precondition fails so the diagnostics surface can explain a
 * quiet scan.
 *
 * @param lookbackDays trailing window for the realised-vol estimate (default 20).
 */
export function scanShortPremiumFromSnapshot(
  snap: ShortPremiumSnapshotInput,
  dailyCloses: readonly number[],
  ivRank: number | null,
  options: ShortPremiumScannerOptions = {},
  lookbackDays = 20,
): ShortPremiumScanResult {
  const symbol = snap.symbol.trim().toUpperCase();
  const minIvRank = options.minIvRank ?? SHORT_PREMIUM_MIN_IV_RANK;
  const base: Omit<ShortPremiumScanResult, 'candidates' | 'reason'> = {
    symbol,
    spot: Number.isFinite(snap.spot) && snap.spot > 0 ? snap.spot : null,
    expiration: snap.expiration || null,
    realizedVol: null,
    dailyCloseCount: dailyCloses.length,
    ivRank: ivRank ?? null,
  };

  if (base.spot == null) return { ...base, candidates: [], reason: 'no_spot' };
  if (snap.rows.length === 0) return { ...base, candidates: [], reason: 'no_chain' };

  // Faithful desk gate: a KNOWN rank below the floor stands the scan down. An
  // unknown rank (null) defers to observe-only so the forward sample can accrue.
  if (typeof ivRank === 'number' && Number.isFinite(ivRank) && ivRank < minIvRank) {
    return { ...base, candidates: [], reason: 'ivrank_low' };
  }

  const realizedVol = realizedVolFromDailyCloses(dailyCloses, lookbackDays);
  if (realizedVol == null) {
    return { ...base, candidates: [], reason: 'no_realized_vol' };
  }

  const candidates = findShortPremiumStructures(snap.rows, base.spot, realizedVol, {
    ...options,
    minIvRank,
    ivRank,
  });
  return {
    ...base,
    realizedVol,
    candidates,
    reason: candidates.length > 0 ? 'ok' : 'no_candidates',
  };
}

// ── In-memory latest-scan store (backs GET /api/health/short-premium) ────────

interface StoredScan {
  result: ShortPremiumScanResult;
  recordedAt: number;
}

/** Cap on retained symbols so the store can't grow unbounded over a long run. */
const MAX_STORED_SYMBOLS = 128;
/** Entries older than this are swept on read so the surface never shows stale structures. */
const STORE_TTL_MS = 30 * 60_000;

const store = new Map<string, StoredScan>();

/**
 * Record the latest short-premium scan for a symbol (latest-wins). Oldest-inserted
 * symbols are evicted past the cap. Demo-only / observe-only — callers gate on the
 * flag, so the store stays empty when the scanner is off.
 */
export function recordShortPremiumScan(
  result: ShortPremiumScanResult,
  now: number = Date.now(),
): void {
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
export function clearShortPremiumScans(): void {
  store.clear();
}

/** One symbol's most-recent scan, redacted to the diagnostics shape. */
export interface ShortPremiumScanView {
  symbol: string;
  spot: number | null;
  expiration: string | null;
  realizedVol: number | null;
  dailyCloseCount: number;
  ivRank: number | null;
  reason: ShortPremiumScanReason;
  recordedAt: string;
  candidateCount: number;
  candidates: Array<{
    structure: ShortPremiumCandidate['structure'];
    underlying: string;
    expiration: string;
    daysToExpiration: number;
    netCredit: number;
    width: number;
    maxProfit: number;
    maxLoss: number;
    returnOnRisk: number;
    estPoP: number;
    shortDelta: number;
    ivRvRatio: number;
    impliedVol: number;
    realizedVol: number;
    ivRank: number | null;
    score: number;
    reason: string;
    legs: ShortPremiumCandidate['legs'];
  }>;
}

export interface ShortPremiumScansSummary {
  /** Symbols with a fresh (within-TTL) recorded scan. */
  symbolCount: number;
  /** Total structures across all fresh scans. */
  candidateCount: number;
  scans: ShortPremiumScanView[];
}

/**
 * Fold the store into the read-only diagnostics summary, dropping entries past
 * the TTL and sorting symbols by their strongest structure score (best
 * expected-value-per-risk first), then by symbol for stability. Pure beyond the
 * injected clock.
 */
export function summarizeShortPremiumScans(now: number = Date.now()): ShortPremiumScansSummary {
  const views: Array<{ view: ShortPremiumScanView; topScore: number }> = [];
  for (const [key, entry] of store) {
    if (now - entry.recordedAt >= STORE_TTL_MS) {
      store.delete(key);
      continue;
    }
    const r = entry.result;
    const candidates = r.candidates.map((c) => ({
      structure: c.structure,
      underlying: c.underlying,
      expiration: c.expiration,
      daysToExpiration: c.daysToExpiration,
      netCredit: c.netCredit,
      width: c.width,
      maxProfit: c.maxProfit,
      maxLoss: c.maxLoss,
      returnOnRisk: c.returnOnRisk,
      estPoP: c.estPoP,
      shortDelta: c.shortDelta,
      ivRvRatio: c.ivRvRatio,
      impliedVol: c.impliedVol,
      realizedVol: c.realizedVol,
      ivRank: c.ivRank,
      score: c.score,
      reason: c.reason,
      legs: c.legs,
    }));
    views.push({
      topScore: candidates.length > 0 ? candidates[0]!.score : -Infinity,
      view: {
        symbol: r.symbol,
        spot: r.spot,
        expiration: r.expiration,
        realizedVol: r.realizedVol,
        dailyCloseCount: r.dailyCloseCount,
        ivRank: r.ivRank,
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
