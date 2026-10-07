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
// TRA-5292 — the floor's ARM switch. Off (default) the floor gates nothing at
// any store depth, so crossing MIN_IV_SAMPLES cannot change behaviour by itself.
import { isShortPremiumIvFloorArmed, SHORT_PREMIUM_IV_FLOOR_FLAG } from './option-exec-flag.js';
// TRA-5176 — every recorded scan also folds into the DURABLE per-session
// arrival ledger (the dated series TRA-5173 item 2 grades on). The in-memory
// store below stays exactly what it was: a live snapshot.
import { recordShortPremiumArrival } from './short-premium-arrival-ledger.js';

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
// The desk gate is ivPercentile >= 50 (elevated IV) + VRP-positive (IV/RV >= 1)
// + short-strike delta ~0.15–0.30. TRA-5280 (the TRA-5173 item 1 ruling): the
// elevated-IV floor keys on the trailing-window IV PERCENTILE (TRA-2028), not
// the IV rank — percentile wins on lift (+0.2416 vs +0.2218 mean log-ratio),
// throughput (~1.7x) and robustness (rank is defined by two extreme order
// statistics over 366 days, so one vol spike sets the denominator for a year).
// The rank is RETIRED as a gate statistic and kept only as a published
// diagnostic. A FINITE percentile below the floor stands the scan down here
// with a discriminating `reason` — but ONLY while the floor is ARMED
// (TRA-5292: env ENABLE_SHORT_PREMIUM_IV_FLOOR, default OFF, so crossing the
// store's MIN_IV_SAMPLES depth is behaviour-neutral until TRA-5173 releases
// the floor by decision), and NEVER on a `flat_window` (a degenerate window is
// a stale-feed signature, honest-unknown to the floor). An unknown percentile
// (thin IV store on a fresh demo, TRA-1114) is allowed to surface OBSERVE-ONLY
// candidates so the forward sample can accrue while the store warms — the
// >= 50 floor is re-asserted as a hard LIVE-promotion gate, not an observe
// gate. Live promotion stays gated on TRA-382 regardless.
//
// ⚠️ TRA-4917 — MEASURED on bqb1 (live SHA 66a8a1ab40cc, 2026-09-25T17:25Z), that
// floor was INERT: `ivRank` was null on 164/164 published rows, so `ivrank_low`
// fired 0 times in 128 scans and all 36 candidates cleared a gate that never
// evaluated. Fail-open is still correct under record-first-gate-later (TRA-2045),
// but it must be VISIBLE: the scan record now carries `atmIv`, `ivSampleDepth`
// and an `ivRankCoverage` code, and the summary publishes the measured/unknown
// split per code. Nothing here gates on the coverage fields — and the ruling on
// which statistic the floor keys on landed as TRA-5173 item 1 / TRA-5280: the
// PERCENTILE, with the rank retired to a diagnostic.
//
// In-memory (not the on-disk option journal) by design: these are transient,
// observe-only candidates the board watches to decide thresholds — not trade
// outcomes — so nothing here needs to survive a restart. Per-symbol latest-wins,
// capped so it can't grow without bound.

/**
 * The elevated-IV floor (mirrors the engine default) — the desk's sell gate.
 * Keys on the trailing-window IV PERCENTILE since TRA-5280; the same `>= 50`
 * value the retired rank floor carried, applied to the more robust statistic.
 *
 * TRA-5292 — this VALUE binds only while the floor is ARMED
 * ({@link isShortPremiumIvFloorArmed}, env `ENABLE_SHORT_PREMIUM_IV_FLOOR`,
 * default OFF). Unarmed, the first depth-20 session would otherwise have
 * started gating 100% of scans on a date rather than a decision — before the
 * TRA-5173 PASS bar (depth >= 20 sustained across a deploy) could be evaluated.
 */
export const SHORT_PREMIUM_MIN_IV_PERCENTILE = 50;

/**
 * TRA-5292 — server-side scan options: the engine options plus the floor-arm
 * test seam. Callers normally omit `ivFloorArmed` and the scan resolves it from
 * the env each pass, so an env write (plus the redeploy that applies it) is the
 * release path and no code change re-arms the floor.
 */
export interface ShortPremiumScanOptions extends ShortPremiumScannerOptions {
  /** Overrides the env-resolved arm state (tests). Default: env-resolved. */
  ivFloorArmed?: boolean;
}

/** Why a scan produced (or did not produce) structures — surfaced for diagnosis. */
export type ShortPremiumScanReason =
  | 'ok'
  | 'no_chain'
  | 'no_spot'
  | 'no_realized_vol'
  | 'iv_percentile_low'
  | 'no_candidates';

export interface ShortPremiumScanResult {
  symbol: string;
  spot: number | null;
  expiration: string | null;
  /** Annualised realised vol used as the VRP baseline σ, or null when uncomputable. */
  realizedVol: number | null;
  /** Number of daily closes the realised-vol estimate was built from. */
  dailyCloseCount: number;
  /**
   * Trailing-year IV-rank (TRA-1153), or null when the store is thin/uncovered.
   * DIAGNOSTIC ONLY since TRA-5280 — the gate keys on `ivPercentile`; the rank
   * stays published so the TRA-4917 coverage instrument keeps its series.
   */
  ivRank: number | null;
  /**
   * TRA-5280 — the trailing-window IV percentile (TRA-2028) the elevated-IV
   * floor keys on, computed off the SAME store read as `ivRank`. Null = honest
   * unknown; the floor fails open on it (the TRA-5170 ruling).
   */
  ivPercentile: number | null;
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
 * TRA-4917 — what the caller knows about this pass's IV read. The `number |
 * null` form is the legacy shape (the GATE statistic alone, no diagnostic) —
 * since TRA-5280 that bare number is the IV PERCENTILE, because the percentile
 * is what the floor keys on. It stamps `not_evaluated` and leaves
 * `atmIv`/`ivSampleDepth`/`ivRank` null rather than fabricating a branch, so an
 * unclassified row is visible as unclassified.
 */
export type ShortPremiumIvRankInput = number | null | IvRankCoverageReading;

function normalizeIvRankInput(input: ShortPremiumIvRankInput): IvRankCoverageReading {
  if (input === null || typeof input === 'number') {
    const ivPercentile = typeof input === 'number' && Number.isFinite(input) ? input : null;
    return { ivRank: null, ivPercentile, atmIv: null, ivSampleDepth: null, coverage: 'not_evaluated' };
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
 * is derived from it); `ivInput` carries the IV percentile the floor keys on
 * (TRA-5280) plus the rank-coverage diagnostics the caller stamped.
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
  options: ShortPremiumScanOptions = {},
  lookbackDays = 20,
): ShortPremiumScanResult {
  const symbol = snap.symbol.trim().toUpperCase();
  const minIvPercentile = options.minIvPercentile ?? SHORT_PREMIUM_MIN_IV_PERCENTILE;
  const reading = normalizeIvRankInput(ivRankInput);
  const ivPercentile = reading.ivPercentile;
  // TRA-5292 — the floor binds only when ARMED, and never on a `flat_window`:
  // a flat 20-sample window is a stale-feed signature (the same quote repeated),
  // not a statement about premium richness. Its percentile is defined (0 when
  // currentIv <= the flat value) where the rank's is not, so without this
  // carve-out the floor would book a dead feed as "premium not rich enough to
  // sell" the instant the store crossed MIN_IV_SAMPLES. Honest-unknown ⇒ fail
  // open, matching the rank's `max <= min ⇒ null` behaviour.
  const floorArmed = options.ivFloorArmed ?? isShortPremiumIvFloorArmed();
  const floorBinds = floorArmed && reading.coverage !== 'flat_window';
  const base: Omit<ShortPremiumScanResult, 'candidates' | 'reason'> = {
    symbol,
    spot: Number.isFinite(snap.spot) && snap.spot > 0 ? snap.spot : null,
    expiration: snap.expiration || null,
    realizedVol: null,
    dailyCloseCount: dailyCloses.length,
    ivRank: reading.ivRank ?? null,
    ivPercentile: ivPercentile ?? null,
    atmIv: reading.atmIv,
    ivSampleDepth: reading.ivSampleDepth,
    ivRankCoverage: reading.coverage,
  };

  if (base.spot == null) return { ...base, candidates: [], reason: 'no_spot' };
  if (snap.rows.length === 0) return { ...base, candidates: [], reason: 'no_chain' };

  // Faithful desk gate (TRA-5280: percentile-keyed; the rank must NOT bind): a
  // KNOWN percentile below the floor stands the scan down. An unknown
  // percentile (null) defers to observe-only so the forward sample can accrue
  // (the TRA-5170 fail-open branch) — and since TRA-5292 the comparison runs
  // only while `floorBinds` (armed + not a flat window) holds at all.
  if (
    floorBinds &&
    typeof ivPercentile === 'number' &&
    Number.isFinite(ivPercentile) &&
    ivPercentile < minIvPercentile
  ) {
    return { ...base, candidates: [], reason: 'iv_percentile_low' };
  }

  const realizedVol = realizedVolFromDailyCloses(dailyCloses, lookbackDays);
  if (realizedVol == null) {
    return { ...base, candidates: [], reason: 'no_realized_vol' };
  }

  // TRA-5292 — the engine re-applies the same strict `ivPercentile <
  // minIvPercentile` compare internally, so when the floor must not bind the
  // engine gets a floor of 0: `ivPercentile` is always >= 0, so `p < 0` never
  // fires and nothing gates, while the true percentile still flows through to
  // the candidate echoes unchanged.
  const candidates = findShortPremiumStructures(snap.rows, base.spot, realizedVol, {
    ...options,
    minIvPercentile: floorBinds ? minIvPercentile : 0,
    ivPercentile,
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
  // TRA-5176 — fold into the durable session ledger. Synchronous enqueue (the
  // ledger serialises its own I/O); cannot throw into the scan pass.
  recordShortPremiumArrival(result, now);
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
  /** Diagnostic only since TRA-5280 — the TRA-4917 coverage instrument's series. */
  ivRank: number | null;
  /** TRA-5280 — the trailing-window IV percentile the elevated-IV floor keys on. */
  ivPercentile: number | null;
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
    /**
     * Echo of the scan's diagnostic `ivRank` (candidates always echoed the
     * scan-level value by construction — TRA-4917's wire identity is kept).
     */
    ivRank: number | null;
    /** TRA-5280 — echo of the percentile the structure was gated on. */
    ivPercentile: number | null;
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
   * The desk's documented floor VALUE. Retained wire key (TRA-5173's grade
   * reads this block); since TRA-5280 the floor keys on `ivPercentile`, not the
   * rank — see `floorStatistic`. Published so a reader can see the floor AND
   * `gateEvaluable` in one read instead of inferring the gate binds.
   */
  ivRankFloor: number;
  /** TRA-5280 — the same floor value under its honest name. */
  ivPercentileFloor: number;
  /** TRA-5280 — which statistic the floor compares against. Self-describing wire. */
  floorStatistic: 'ivPercentile';
  /**
   * TRA-5292 — whether the floor is ARMED (env `ENABLE_SHORT_PREMIUM_IV_FLOOR`,
   * resolved at fold time; default OFF). `false` means the floor gates NOTHING
   * at any store depth. This is the armed-vs-inert discriminator the TRA-4917
   * incident family keeps missing: `candidateCount` reads identically when the
   * floor is inert and when it is armed and dropping everything, so the arm
   * state must be ON the wire, not inferred. Published even on an empty fold —
   * it is an env fact, not a population statistic.
   */
  floorArmed: boolean;
  /** TRA-5292 — the env lever that arms the floor, named so the release path needs no code read. */
  floorArmEnvVar: string;
  /**
   * Scans where the floor comparison is evaluable — finite `ivPercentile`
   * since TRA-5280, EXCLUDING `flat_window` scans since TRA-5292 (a degenerate
   * window's percentile is defined but is a stale-feed signature, so the floor
   * treats it as honest-unknown and never gates on it). Counts "would the
   * armed floor compare here"; whether it actually binds is `floorArmed`.
   */
  gateEvaluable: number;
  /** Scans where the floor comparison cannot run: null percentile, or a `flat_window` (both fail open, by design). */
  gateInert: number;
  /** The sample floor a trailing window must clear before any rank is emitted. */
  minSamples: number;
  /**
   * Whether this fold had ANY population to measure — `scanCount > 0`.
   *
   * ⚠️ Read this BEFORE any counter below it. The store is swept to
   * {@link STORE_TTL_MS}, so a read taken more than 30 minutes after the last
   * demo tick folds ZERO scans, and every counter here is then a vacuous 0 —
   * `gateInert: 0` in particular reads exactly like "the floor evaluated on
   * every row", which is the *healthiest* possible value, published over
   * nothing. Measured on bqb1 2026-10-02T06:31Z (live `28e61b7be5f5`, booted
   * 05:59:57Z, pre-open): `scanCount 0`, every counter 0, `partitionOk` was
   * `true`. That is the repo's "absent evidence must read as its own named
   * state" rule (CLAUDE.md §health fields) violated by this very rollup.
   */
  populated: boolean;
  /** The store's sweep horizon, so "no pass within the TTL" is answerable on the wire. */
  storeTtlMs: number;
  /** Newest in-TTL scan record in this fold, or null when there is no population. */
  lastRecordedAt: string | null;
  /**
   * Named outcome of the cross-check, never a bare boolean:
   *   `verified`      — there was a population AND no field disagreed.
   *   `mismatch`      — a producer stamped rank and code inconsistently.
   *   `no_population` — nothing was folded, so NOTHING WAS CHECKED. Not a pass.
   */
  partitionState: 'verified' | 'mismatch' | 'no_population';
  /**
   * Cross-check between two independently STORED fields: the rank value and the
   * coverage code. `false` means a producer stamped them inconsistently (e.g.
   * `covered` beside a null rank) and every counter here is suspect. It can go
   * red — see the scanner tests.
   *
   * **`null` when {@link populated} is false** — an honest unknown, the same
   * discipline this row applies to `ivRank` itself (TRA-4917 point 4: never
   * collapse "not measured" into the value that happens to mean healthy). A
   * `true` here therefore always means "checked, over at least one row".
   */
  partitionOk: boolean | null;
  /** Why `partitionOk` is not `true`, or null when it holds. */
  partitionMismatch: string | null;
}

function zeroByCode(): Record<IvRankCoverageCode, number> {
  const out = {} as Record<IvRankCoverageCode, number>;
  for (const code of IV_RANK_COVERAGE_CODES) out[code] = 0;
  return out;
}

/** Build the TRA-4917 rollup off the rendered views. Pure beyond the injected arm state. */
function buildIvRankCoverageRollup(
  views: readonly ShortPremiumScanView[],
  floorArmed: boolean,
): ShortPremiumIvRankCoverageRollup {
  const finite = (v: number | null): boolean => v != null && Number.isFinite(v);
  const byCode = zeroByCode();
  const unknownByCode = zeroByCode();
  let ivRankMeasured = 0;
  let gateEvaluable = 0;
  let candidateCount = 0;
  let candidateIvRankMeasured = 0;
  for (const v of views) {
    byCode[v.ivRankCoverage] = (byCode[v.ivRankCoverage] ?? 0) + 1;
    if (finite(v.ivRank)) ivRankMeasured++;
    else unknownByCode[v.ivRankCoverage] = (unknownByCode[v.ivRankCoverage] ?? 0) + 1;
    // TRA-5292 — a flat window's percentile is finite but the floor treats it
    // as honest-unknown, so it is NOT evaluable (mirrors the scan gate).
    if (finite(v.ivPercentile) && v.ivRankCoverage !== 'flat_window') gateEvaluable++;
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

  // An EMPTY fold satisfies all three asserts vacuously — 0 === 0 three times —
  // so a bare `mismatches.length === 0` publishes the pass value having compared
  // nothing. Gate the verdict on the POPULATION, never on the absence of a
  // complaint (the same shape as `gateInert: 0` over zero scans).
  const populated = scanCount > 0;
  const recordedAts = views
    .map((v) => Date.parse(v.recordedAt))
    .filter((t) => Number.isFinite(t));
  const partitionState = !populated
    ? ('no_population' as const)
    : mismatches.length === 0
      ? ('verified' as const)
      : ('mismatch' as const);
  return {
    populated,
    storeTtlMs: STORE_TTL_MS,
    lastRecordedAt:
      recordedAts.length > 0 ? new Date(Math.max(...recordedAts)).toISOString() : null,
    partitionState,
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
    ivRankFloor: SHORT_PREMIUM_MIN_IV_PERCENTILE,
    ivPercentileFloor: SHORT_PREMIUM_MIN_IV_PERCENTILE,
    floorStatistic: 'ivPercentile',
    floorArmed,
    floorArmEnvVar: SHORT_PREMIUM_IV_FLOOR_FLAG,
    gateEvaluable,
    gateInert: scanCount - gateEvaluable,
    minSamples: MIN_IV_SAMPLES,
    partitionOk: populated ? mismatches.length === 0 : null,
    partitionMismatch: !populated
      ? 'no_population: 0 scans within storeTtlMs — NOTHING WAS CHECKED, this is not a pass'
      : mismatches.length === 0
        ? null
        : mismatches.join('; '),
  };
}

/**
 * Fold the store into the read-only diagnostics summary, dropping entries past
 * the TTL and sorting symbols by their strongest structure score (best
 * expected-value-per-risk first), then by symbol for stability. Pure beyond the
 * injected clock.
 */
export function summarizeShortPremiumScans(
  now: number = Date.now(),
  // TRA-5292 — resolved here (not inside the pure rollup builder) so the arm
  // state on the wire is the same read the scan gate would make this instant.
  floorArmed: boolean = isShortPremiumIvFloorArmed(),
): ShortPremiumScansSummary {
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
      // The scan-level diagnostic rank, echoed — identical to the pre-TRA-5280
      // wire (the engine always stamped the value the scan handed it).
      ivRank: r.ivRank,
      ivPercentile: c.ivPercentile,
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
        ivPercentile: r.ivPercentile,
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
    ivRankCoverage: buildIvRankCoverageRollup(scans, floorArmed),
    reasonCounts,
    scans,
  };
}
