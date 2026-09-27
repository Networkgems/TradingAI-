import {
  findShortPremiumStructures,
  realizedVolFromDailyCloses,
  type OptionChainRow,
  type ShortPremiumCandidate,
  type ShortPremiumScannerOptions,
} from '@trading-app/engine';
import {
  IV_RANK_COVERAGE_CODES,
  MIN_IV_SAMPLES,
  type IvRankCoverageCode,
  type IvRankCoverageReading,
} from './iv-rank-store.js';

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
// ⚠️ TRA-4917 — MEASURED on bqb1 (live SHA 66a8a1ab40cc, 2026-09-25T17:25Z), that
// floor was INERT: `ivRank` was null on 164/164 published rows, so `ivrank_low`
// fired 0 times in 128 scans and all 36 candidates cleared a gate that never
// evaluated. Fail-open is still correct under record-first-gate-later (TRA-2045),
// but it must be VISIBLE: the scan record now carries `atmIv`, `ivSampleDepth`
// and an `ivRankCoverage` code, and the summary publishes the measured/unknown
// split per code. Nothing here gates on the new fields — whether the IVR floor
// should bind is QuantTrader's call on the accrued sample.
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
  /**
   * TRA-4917 — the ATM IV the rank was (or would have been) ranked against.
   * `null` here is the `no_atm_iv` branch: extraction off the chain failed, which
   * is a BUG, as opposed to a cold store, which self-heals.
   */
  atmIv: number | null;
  /**
   * TRA-4917 — usable in-window trailing samples for this symbol, the count
   * {@link MIN_IV_SAMPLES} binds against. `null` = not supplied by the caller
   * (never 0, which is a real and different measurement).
   */
  ivSampleDepth: number | null;
  /** TRA-4917 — which branch produced `ivRank`. See {@link IV_RANK_COVERAGE_CODES}. */
  ivRankCoverage: IvRankCoverageCode;
  candidates: ShortPremiumCandidate[];
  reason: ShortPremiumScanReason;
}

/**
 * TRA-4917 — what the caller knows about this pass's IV-rank read. The `number |
 * null` form is the legacy shape (the rank alone, no diagnostic): it stamps
 * `not_evaluated` and leaves `atmIv`/`ivSampleDepth` null rather than fabricating
 * a branch, so an unclassified row is visible as unclassified.
 */
export type ShortPremiumIvRankInput = number | null | IvRankCoverageReading;

function normalizeIvRankInput(input: ShortPremiumIvRankInput): IvRankCoverageReading {
  if (input === null || typeof input === 'number') {
    const ivRank = typeof input === 'number' && Number.isFinite(input) ? input : null;
    return { ivRank, atmIv: null, ivSampleDepth: null, coverage: 'not_evaluated' };
  }
  return input;
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
  ivRankInput: ShortPremiumIvRankInput,
  options: ShortPremiumScannerOptions = {},
  lookbackDays = 20,
): ShortPremiumScanResult {
  const symbol = snap.symbol.trim().toUpperCase();
  const minIvRank = options.minIvRank ?? SHORT_PREMIUM_MIN_IV_RANK;
  const reading = normalizeIvRankInput(ivRankInput);
  const ivRank = reading.ivRank;
  const base: Omit<ShortPremiumScanResult, 'candidates' | 'reason'> = {
    symbol,
    spot: Number.isFinite(snap.spot) && snap.spot > 0 ? snap.spot : null,
    expiration: snap.expiration || null,
    realizedVol: null,
    dailyCloseCount: dailyCloses.length,
    ivRank: ivRank ?? null,
    atmIv: reading.atmIv,
    ivSampleDepth: reading.ivSampleDepth,
    ivRankCoverage: reading.coverage,
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
  /** TRA-4917 — the ATM IV behind `ivRank`; null ⇒ the `no_atm_iv` branch. */
  atmIv: number | null;
  /** TRA-4917 — usable in-window trailing samples; null ⇒ not supplied. */
  ivSampleDepth: number | null;
  /** TRA-4917 — which branch produced `ivRank`. */
  ivRankCoverage: IvRankCoverageCode;
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
  /** TRA-4917 — the IV-rank coverage rollup over this fold. */
  ivRankCoverage: ShortPremiumIvRankCoverageRollup;
  /** TRA-4917 — scans per `reason`, so the quiet-scan split needs no code read. */
  reasonCounts: Record<string, number>;
  scans: ShortPremiumScanView[];
}

/**
 * TRA-4917 — "how many of this fold's scans carry a numeric `ivRank`, and for the
 * rest, which branch", answerable off the wire alone.
 *
 * ⚠️ The two levels are NOT one population of independent observations. A
 * candidate's `ivRank` is a COPY of its scan's — `findShortPremiumStructures`
 * stamps the value it was handed onto every structure it builds — so the
 * candidate counters are ECHOES, and the 164-row figure in the incident is 128
 * distinct IV-rank reads plus 36 repeats of 36 of them. They are reported
 * separately and summed only into `wireRows*`, never averaged together, because
 * a symbol that happened to produce 6 structures would otherwise weigh 7×.
 */
export interface ShortPremiumIvRankCoverageRollup {
  /** Scans in this fold — the DISTINCT population (one store read per symbol). */
  scanCount: number;
  /** Candidate rows, each echoing its scan's rank. */
  candidateCount: number;
  /** Rows on the wire carrying an `ivRank` field: `scanCount + candidateCount`. */
  wireRowCount: number;
  /** Scans whose `ivRank` is a finite number. */
  ivRankMeasured: number;
  /** Scans whose `ivRank` is null. `ivRankMeasured + ivRankUnknown === scanCount`. */
  ivRankUnknown: number;
  /** Per-code split over ALL scans. Values sum to `scanCount`. */
  byCode: Record<IvRankCoverageCode, number>;
  /** The same split restricted to the unknown scans. Values sum to `ivRankUnknown`. */
  unknownByCode: Record<IvRankCoverageCode, number>;
  /** Candidate echoes carrying a finite rank. */
  candidateIvRankMeasured: number;
  /** Candidate echoes carrying null. */
  candidateIvRankUnknown: number;
  /** `ivRankMeasured + candidateIvRankMeasured` — the incident's numerator. */
  wireRowsMeasured: number;
  /** `ivRankUnknown + candidateIvRankUnknown`. Sums with the above to `wireRowCount`. */
  wireRowsUnknown: number;
  /**
   * The desk's documented floor. Published so a reader can see the floor AND
   * `gateEvaluable` in one read instead of inferring the gate binds.
   */
  ivRankFloor: number;
  /** Scans where the `ivRank >= floor` comparison actually evaluated (== `ivRankMeasured`). */
  gateEvaluable: number;
  /** Scans where the floor was INERT because the rank was null (fails open, by design). */
  gateInert: number;
  /** The sample floor a trailing window must clear before any rank is emitted. */
  minSamples: number;
  /**
   * Cross-check between two independently STORED fields: the rank value and the
   * coverage code. `false` means a producer stamped them inconsistently (e.g.
   * `covered` beside a null rank) and every counter here is suspect. It can go
   * red — see the scanner tests.
   */
  partitionOk: boolean;
  /** Why `partitionOk` is false, or null when it holds. */
  partitionMismatch: string | null;
}

function zeroByCode(): Record<IvRankCoverageCode, number> {
  const out = {} as Record<IvRankCoverageCode, number>;
  for (const code of IV_RANK_COVERAGE_CODES) out[code] = 0;
  return out;
}

/** Build the TRA-4917 rollup off the rendered views. Pure. */
function buildIvRankCoverageRollup(
  views: readonly ShortPremiumScanView[],
): ShortPremiumIvRankCoverageRollup {
  const finite = (v: number | null): boolean => v != null && Number.isFinite(v);
  const byCode = zeroByCode();
  const unknownByCode = zeroByCode();
  let ivRankMeasured = 0;
  let candidateCount = 0;
  let candidateIvRankMeasured = 0;
  for (const v of views) {
    byCode[v.ivRankCoverage] = (byCode[v.ivRankCoverage] ?? 0) + 1;
    if (finite(v.ivRank)) ivRankMeasured++;
    else unknownByCode[v.ivRankCoverage] = (unknownByCode[v.ivRankCoverage] ?? 0) + 1;
    candidateCount += v.candidates.length;
    for (const c of v.candidates) if (finite(c.ivRank)) candidateIvRankMeasured++;
  }
  const scanCount = views.length;
  const ivRankUnknown = scanCount - ivRankMeasured;
  const candidateIvRankUnknown = candidateCount - candidateIvRankMeasured;
  const codeTotal = IV_RANK_COVERAGE_CODES.reduce((acc, code) => acc + byCode[code], 0);

  // Two DIFFERENT stored fields are compared here on purpose: `byCode.covered`
  // is counted off `ivRankCoverage`, `ivRankMeasured` off `ivRank`. Deriving one
  // from the other would make this assert agree with itself.
  const mismatches: string[] = [];
  if (codeTotal !== scanCount) mismatches.push(`byCode sums ${codeTotal} != scanCount ${scanCount}`);
  if (byCode.covered !== ivRankMeasured) {
    mismatches.push(`byCode.covered ${byCode.covered} != ivRankMeasured ${ivRankMeasured}`);
  }
  if (unknownByCode.covered !== 0) {
    mismatches.push(`${unknownByCode.covered} scan(s) coded 'covered' with a null ivRank`);
  }
  return {
    scanCount,
    candidateCount,
    wireRowCount: scanCount + candidateCount,
    ivRankMeasured,
    ivRankUnknown,
    byCode,
    unknownByCode,
    candidateIvRankMeasured,
    candidateIvRankUnknown,
    wireRowsMeasured: ivRankMeasured + candidateIvRankMeasured,
    wireRowsUnknown: ivRankUnknown + candidateIvRankUnknown,
    ivRankFloor: SHORT_PREMIUM_MIN_IV_RANK,
    gateEvaluable: ivRankMeasured,
    gateInert: ivRankUnknown,
    minSamples: MIN_IV_SAMPLES,
    partitionOk: mismatches.length === 0,
    partitionMismatch: mismatches.length === 0 ? null : mismatches.join('; '),
  };
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
        atmIv: r.atmIv,
        ivSampleDepth: r.ivSampleDepth,
        ivRankCoverage: r.ivRankCoverage,
        reason: r.reason,
        recordedAt: new Date(entry.recordedAt).toISOString(),
        candidateCount: candidates.length,
        candidates,
      },
    });
  }
  views.sort((a, b) => b.topScore - a.topScore || a.view.symbol.localeCompare(b.view.symbol));
  const scans = views.map((v) => v.view);
  const reasonCounts: Record<string, number> = {};
  for (const s of scans) reasonCounts[s.reason] = (reasonCounts[s.reason] ?? 0) + 1;
  return {
    symbolCount: scans.length,
    candidateCount: scans.reduce((acc, s) => acc + s.candidateCount, 0),
    ivRankCoverage: buildIvRankCoverageRollup(scans),
    reasonCounts,
    scans,
  };
}
