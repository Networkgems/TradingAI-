import { existsSync } from 'fs';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { etDateKey } from './et-clock.js';
import { resolveDataDir } from './data-dir.js';
import { resolveBuildInfo } from './observability/build-info.js';
// The narrow logger import (email.ts idiom), not the barrel: this module is in
// the scanner's unit-test closure and must not drag the whole observability
// re-export graph behind it.
import { logger } from './observability/logger.js';

// TRA-5176 — the durable, dated SHORT-PREMIUM candidate-ARRIVAL ledger.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// TRA-5173 item 2 grades the IVR>=50 floor on the candidate-arrival DENOMINATOR
// over >= 10 sessions, and that series existed nowhere: the only surface that
// publishes `candidateCount` is `/api/health/short-premium`, which serves a live
// snapshot the next scan cycle overwrites (and the next boot erases — bqb1
// restarts several times a day, so a since-boot series can never reach 10
// sessions). This module appends one row per ET session and keeps it across
// restarts, so after 10 sessions the grade is one no-auth read.
//
// ── THE HONEST DENOMINATOR ───────────────────────────────────────────────────
// The scan runs many cycles a session, so `sum(candidateCount)` over cycles
// double-counts the same structure — one resting NVDA call_credit_spread
// 260/270 would read as dozens. The field the grade reads is therefore
// `distinctCandidateCount`: distinct `(symbol, expiration, structure)` keys seen
// at ANY point in the session. The naive cycle sum is published BESIDE it
// (`cycleCandidateCountSum`), never instead of it, so the inflation factor is
// itself readable.
//
// ── ABSENT ≠ ZERO ────────────────────────────────────────────────────────────
// A session with no recorded activity is ABSENT from the ledger, never a zero
// row: "the recorder was down" and "nothing arrived" are the two readings this
// ticket family keeps conflating, and they must not serialise identically. A
// genuine zero-candidate session IS present (the scan ran, rows folded,
// `distinctCandidateCount: 0`). `distinctSessionsRecorded` / `oldestSessionDate`
// ride beside the array so `n < 10` reads as "not yet", not as a measured rate.
//
// ── DURABILITY (the cd053d3c / TRA-5172 idiom, verbatim) ─────────────────────
// Whole-file JSON under DATA_DIR, tmp + rename so a kill mid-write can never
// leave a truncated file; a FAILED load fails CLOSED — persists are refused
// while the unreadable original sits at the store path, each refusal attempts a
// rename-aside to `short-premium-arrivals.corrupt-<ts>.json` for forensics, and
// only a successful rename re-opens the write path. Additionally an EMPTY
// in-memory ledger is never persisted over an existing file (a recorder that
// clobbers its own history on a bad boot would reproduce, in the instrument,
// the exact defect TRA-5172 fixed in the IV store).
//
// Observe-only, same posture as TRA-5171: no flag, no gate change, no touch to
// `SHORT_PREMIUM_MIN_IV_RANK` or the fail-open branch. Nothing here ever gates.

const log = logger.child({ module: 'short-premium-arrival-ledger' });

export const SHORT_PREMIUM_ARRIVALS_FILENAME = 'short-premium-arrivals.json';

/** Sessions retained on disk and on the wire (spec floor is 30; headroom for a grade window). */
export const ARRIVAL_RETAINED_SESSION_CAP = 40;
/**
 * Hard cap on distinct keys tracked per session so the file stays bounded. The
 * live base rate is ~1/session (TRA-5173 window read #1), so the cap is three
 * orders of magnitude of headroom; if it is ever hit the row says so
 * (`distinctKeyCapHit`) rather than silently undercounting.
 */
export const ARRIVAL_DISTINCT_KEY_CAP = 2000;
/** Builds recorded per session before the list caps (restarts are several/day, not hundreds). */
export const ARRIVAL_BUILDS_CAP = 50;
/**
 * Counter-only updates (no new distinct key / session / build) persist at most
 * this often; structural changes persist immediately. Bounds a kill's data loss
 * to one throttle window of counter increments — never a distinct arrival.
 */
const PERSIST_THROTTLE_MS = 60_000;

/** One build that contributed scan records to a session (process-granular on purpose). */
export interface ArrivalBuildStamp {
  /** First 12 chars of the serving commit, or null when the build cannot name one. */
  commitShort: string | null;
  /** ISO process-start instant — a restart of the SAME commit is a new stamp. */
  startedAt: string;
}

/** In-memory accumulator for one ET session. */
interface SessionAccum {
  /** Distinct `SYMBOL|expiration|structure` keys seen this session. */
  distinctKeys: Set<string>;
  distinctKeyCapHit: boolean;
  /** Per-symbol scan records folded (cycle-summed — NOT distinct symbols). */
  scanCount: number;
  /** Completed whole-universe sweeps (the ticket's "cycles"). */
  cycleCount: number;
  /** The NAIVE denominator: candidate counts summed over every scan record. */
  cycleCandidateCountSum: number;
  reasonCounts: Record<string, number>;
  /** Scan records whose `ivRank` was a finite number (cycle-summed). */
  ivRankMeasured: number;
  /** Scan records whose `ivRank` was null (cycle-summed). */
  ivRankUnknown: number;
  /** The unknown records split by their `ivRankCoverage` code. */
  unknownByCode: Record<string, number>;
  /** `ivSampleDepth` → scan-record count; a null depth lands under the key `"null"`. */
  ivSampleDepthHistogram: Record<string, number>;
  builds: ArrivalBuildStamp[];
  buildsCapHit: boolean;
  firstRecordedAt: number;
  lastRecordedAt: number;
}

interface PersistedSession extends Omit<SessionAccum, 'distinctKeys'> {
  distinctKeys: string[];
}

interface PersistedLedger {
  version: 1;
  updatedAt: number;
  /** Keyed by ET session date (`YYYY-MM-DD`). */
  sessions: Record<string, PersistedSession>;
}

/**
 * The slice of a scan result this ledger folds. Structural on purpose: the
 * scanner's full result type carries candidate economics the ledger never
 * reads, and tests should not have to fabricate them.
 */
export interface ShortPremiumArrivalScanInput {
  symbol: string;
  reason: string;
  ivRank: number | null;
  ivSampleDepth: number | null;
  ivRankCoverage: string;
  candidates: ReadonlyArray<{ structure: string; underlying: string; expiration: string }>;
}

// ── Module state ─────────────────────────────────────────────────────────────

let fileOverride: string | null = null;
/**
 * Disk I/O happens only once something ARMED the ledger (boot init, or the test
 * seam). Unarmed (unit tests of the scanner, CLI without boot) the fold still
 * updates memory; no file is read or written — the cost-aware-gate-ledger rule.
 */
let armed = false;
let cache: Map<string, SessionAccum> | null = null;
let loadFailed = false;
let loadParseError: string | null = null;
let persistCount = 0;
let persistErrors = 0;
let lastPersistError: string | null = null;
/** Writes refused because the unreadable original was still at the store path. */
let persistRefusals = 0;
let corruptFileRenamedTo: string | null = null;
/** Writes refused because an EMPTY ledger would have replaced an existing file. */
let emptyLedgerWriteRefusals = 0;
let lastPersistAt = 0;
/**
 * All mutation/persist work is serialised on this chain: the fold entry points
 * are synchronous (the scanner's record path must never await), so overlapping
 * read-modify-write of the file is structurally impossible.
 */
let opChain: Promise<void> = Promise.resolve();

function ledgerFile(): string {
  return fileOverride ?? join(resolveDataDir(), SHORT_PREMIUM_ARRIVALS_FILENAME);
}

/** Test seam — point the ledger at a temp file (arming it) and reset all state. */
export function setShortPremiumArrivalLedgerFileForTests(path: string | null): void {
  fileOverride = path;
  armed = path != null;
  cache = null;
  loadFailed = false;
  loadParseError = null;
  persistCount = 0;
  persistErrors = 0;
  lastPersistError = null;
  persistRefusals = 0;
  corruptFileRenamedTo = null;
  emptyLedgerWriteRefusals = 0;
  lastPersistAt = 0;
  opChain = Promise.resolve();
}

/** The forensics path beside the store (`:`/`.` are not Windows-safe in names). */
function corruptAsidePath(path: string, atMs: number): string {
  const stamp = new Date(atMs).toISOString().replace(/[:.]/g, '-');
  return path.endsWith('.json')
    ? `${path.slice(0, -'.json'.length)}.corrupt-${stamp}.json`
    : `${path}.corrupt-${stamp}`;
}

function finiteOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function cleanCountRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object') {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[k] = n;
    }
  }
  return out;
}

function sanitizeSession(raw: unknown): SessionAccum | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PersistedSession>;
  const keys = Array.isArray(r.distinctKeys)
    ? r.distinctKeys.filter((k): k is string => typeof k === 'string' && k !== '')
    : [];
  const builds = Array.isArray(r.builds)
    ? r.builds
        .filter((b): b is ArrivalBuildStamp => !!b && typeof (b as ArrivalBuildStamp).startedAt === 'string')
        .map((b) => ({
          commitShort: typeof b.commitShort === 'string' ? b.commitShort : null,
          startedAt: b.startedAt,
        }))
    : [];
  const first = finiteOr0(r.firstRecordedAt);
  const last = finiteOr0(r.lastRecordedAt);
  // A row that recorded nothing and stamps no time is not a session — skip it
  // rather than hydrate a fabricated zero row (absent must stay absent).
  if (first <= 0 && last <= 0) return null;
  return {
    distinctKeys: new Set(keys.slice(0, ARRIVAL_DISTINCT_KEY_CAP)),
    distinctKeyCapHit: r.distinctKeyCapHit === true || keys.length > ARRIVAL_DISTINCT_KEY_CAP,
    scanCount: finiteOr0(r.scanCount),
    cycleCount: finiteOr0(r.cycleCount),
    cycleCandidateCountSum: finiteOr0(r.cycleCandidateCountSum),
    reasonCounts: cleanCountRecord(r.reasonCounts),
    ivRankMeasured: finiteOr0(r.ivRankMeasured),
    ivRankUnknown: finiteOr0(r.ivRankUnknown),
    unknownByCode: cleanCountRecord(r.unknownByCode),
    ivSampleDepthHistogram: cleanCountRecord(r.ivSampleDepthHistogram),
    builds: builds.slice(0, ARRIVAL_BUILDS_CAP),
    buildsCapHit: r.buildsCapHit === true || builds.length > ARRIVAL_BUILDS_CAP,
    firstRecordedAt: first > 0 ? first : last,
    lastRecordedAt: last > 0 ? last : first,
  };
}

async function ensureLoaded(): Promise<Map<string, SessionAccum>> {
  if (cache) return cache;
  const path = ledgerFile();
  if (!armed || !existsSync(path)) {
    cache = new Map();
    return cache;
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<PersistedLedger>;
    const map = new Map<string, SessionAccum>();
    if (parsed.sessions && typeof parsed.sessions === 'object') {
      for (const [day, raw] of Object.entries(parsed.sessions)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const s = sanitizeSession(raw);
        if (s) map.set(day, s);
      }
    }
    cache = map;
    pruneRetention(cache);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // TRA-5172 idiom — fail CLOSED: persists are refused until the unreadable
    // original has been moved aside, so one bad byte can never cost the series.
    loadFailed = true;
    loadParseError = reason;
    cache = new Map();
    log.error(
      'failed to read short-premium arrival ledger, starting empty in-memory; persists refused until the file is moved aside',
      { reason },
    );
  }
  return cache;
}

/** Keep the newest {@link ARRIVAL_RETAINED_SESSION_CAP} session dates. */
function pruneRetention(map: Map<string, SessionAccum>): void {
  if (map.size <= ARRIVAL_RETAINED_SESSION_CAP) return;
  const days = [...map.keys()].sort(); // ascending — oldest first
  while (days.length > ARRIVAL_RETAINED_SESSION_CAP) {
    const oldest = days.shift();
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

async function persist(now: number): Promise<void> {
  if (!armed || !cache) return;
  const path = ledgerFile();

  if (loadFailed && corruptFileRenamedTo == null) {
    // The unreadable original still occupies the store path — a write here would
    // destroy the only copy of the bytes. Refuse (counted), try the rename-aside,
    // and let a FUTURE persist write once the rename has succeeded. Nothing is
    // lost: the refused rows stay in memory and land with the next persist.
    persistRefusals++;
    const aside = corruptAsidePath(path, now);
    try {
      await rename(path, aside);
      corruptFileRenamedTo = aside;
      log.warn('unreadable arrival ledger moved aside for forensics; a fresh ledger will start accumulating', { aside });
    } catch (err) {
      log.error('refusing to persist over an unreadable arrival ledger (rename-aside failed)', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (cache.size === 0) {
    // Never persist an empty ledger over a good file; and an empty ledger with
    // no file yet has nothing to say (absence of the file IS the honest state).
    if (existsSync(path)) {
      emptyLedgerWriteRefusals++;
      log.warn('refusing to persist an EMPTY arrival ledger over an existing file');
    }
    return;
  }

  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const payload: PersistedLedger = {
    version: 1,
    updatedAt: now,
    sessions: Object.fromEntries(
      [...cache.entries()].map(([day, s]) => [day, { ...s, distinctKeys: [...s.distinctKeys] }]),
    ),
  };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(payload), 'utf-8');
    await rename(tmp, path);
    persistCount++;
    lastPersistAt = now;
  } catch (err) {
    // Counted and swallowed (observe-only accounting must never break the scan
    // pass); the previous good file is untouched either way.
    await rm(tmp, { force: true }).catch(() => {});
    persistErrors++;
    lastPersistError = err instanceof Error ? err.message : String(err);
    log.warn('arrival ledger persist failed', { reason: lastPersistError });
  }
}

function getOrCreateSession(map: Map<string, SessionAccum>, day: string, now: number): { s: SessionAccum; created: boolean } {
  let s = map.get(day);
  if (s) return { s, created: false };
  s = {
    distinctKeys: new Set(),
    distinctKeyCapHit: false,
    scanCount: 0,
    cycleCount: 0,
    cycleCandidateCountSum: 0,
    reasonCounts: {},
    ivRankMeasured: 0,
    ivRankUnknown: 0,
    unknownByCode: {},
    ivSampleDepthHistogram: {},
    builds: [],
    buildsCapHit: false,
    firstRecordedAt: now,
    lastRecordedAt: now,
  };
  map.set(day, s);
  pruneRetention(map);
  return { s, created: true };
}

/** Stamp `build` onto the session if unseen. Returns true when the list changed. */
function stampBuild(s: SessionAccum, build: ArrivalBuildStamp): boolean {
  const seen = s.builds.some((b) => b.commitShort === build.commitShort && b.startedAt === build.startedAt);
  if (seen) return false;
  if (s.builds.length >= ARRIVAL_BUILDS_CAP) {
    s.buildsCapHit = true;
    return false;
  }
  s.builds.push({ commitShort: build.commitShort, startedAt: build.startedAt });
  return true;
}

/**
 * Fold one per-symbol scan record into the current ET session. Synchronous
 * entry (the scanner's record path never awaits); the actual work is serialised
 * on the module's op chain. `build` is injectable for tests and defaults to the
 * running process's identity.
 */
export function recordShortPremiumArrival(
  result: ShortPremiumArrivalScanInput,
  now: number = Date.now(),
  build?: ArrivalBuildStamp,
): void {
  const stamp: ArrivalBuildStamp = build ?? (() => {
    const b = resolveBuildInfo();
    return { commitShort: b.commitShort, startedAt: b.startedAt };
  })();
  opChain = opChain
    .then(async () => {
      const map = await ensureLoaded();
      const day = etDateKey(now);
      const { s, created } = getOrCreateSession(map, day, now);
      s.scanCount += 1;
      s.lastRecordedAt = now;
      s.reasonCounts[result.reason] = (s.reasonCounts[result.reason] ?? 0) + 1;
      if (typeof result.ivRank === 'number' && Number.isFinite(result.ivRank)) {
        s.ivRankMeasured += 1;
      } else {
        s.ivRankUnknown += 1;
        s.unknownByCode[result.ivRankCoverage] = (s.unknownByCode[result.ivRankCoverage] ?? 0) + 1;
      }
      const depthKey = result.ivSampleDepth == null ? 'null' : String(result.ivSampleDepth);
      s.ivSampleDepthHistogram[depthKey] = (s.ivSampleDepthHistogram[depthKey] ?? 0) + 1;
      s.cycleCandidateCountSum += result.candidates.length;
      let newKey = false;
      for (const c of result.candidates) {
        const key = `${c.underlying.trim().toUpperCase()}|${c.expiration}|${c.structure}`;
        if (s.distinctKeys.has(key)) continue;
        if (s.distinctKeys.size >= ARRIVAL_DISTINCT_KEY_CAP) {
          s.distinctKeyCapHit = true;
          continue;
        }
        s.distinctKeys.add(key);
        newKey = true;
      }
      const newBuild = stampBuild(s, stamp);
      // A distinct arrival / new session / new build persists IMMEDIATELY (those
      // are the rows the grade reads); counter-only churn is throttled.
      if (created || newKey || newBuild || now - lastPersistAt >= PERSIST_THROTTLE_MS) {
        await persist(now);
      }
    })
    .catch((err: unknown) => {
      log.warn('arrival ledger record failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Note one COMPLETED whole-universe sweep (the ticket's "cycle"). Creates the
 * session row if the sweep folded zero scan records — that is a genuine
 * measured zero (the scanner ran and nothing arrived), which must serialise
 * differently from an absent row (the recorder was down). Always persists:
 * sweep completion is the natural, bounded-frequency durability point.
 */
export function noteShortPremiumCycleComplete(now: number = Date.now()): void {
  opChain = opChain
    .then(async () => {
      const map = await ensureLoaded();
      const day = etDateKey(now);
      const { s } = getOrCreateSession(map, day, now);
      s.cycleCount += 1;
      s.lastRecordedAt = now;
      await persist(now);
    })
    .catch((err: unknown) => {
      log.warn('arrival ledger cycle note failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    });
}

/** Eagerly load the ledger at boot (arming disk I/O) so the sync read has data immediately. */
export async function initShortPremiumArrivalLedger(): Promise<void> {
  armed = true;
  await ensureLoaded();
}

/** Await every queued fold/persist — test seam and graceful-shutdown hook. */
export function flushShortPremiumArrivalLedger(): Promise<void> {
  return opChain;
}

/** Force a persist of the current in-memory state through the same refusal gates. */
export function persistShortPremiumArrivalLedgerNow(now: number = Date.now()): Promise<void> {
  opChain = opChain
    .then(async () => {
      await ensureLoaded();
      await persist(now);
    })
    .catch((err: unknown) => {
      log.warn('arrival ledger forced persist failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    });
  return opChain;
}

/** One session row as published on `/api/health/short-premium`. */
export interface ShortPremiumArrivalSessionView {
  /** ET session date (`YYYY-MM-DD`). */
  sessionDate: string;
  /**
   * THE field TRA-5173 item 2 reads: distinct `(symbol, expiration, structure)`
   * seen at any point in the session. Never a sum over scan cycles.
   */
  distinctCandidateCount: number;
  /** True ⇒ the distinct set hit {@link ARRIVAL_DISTINCT_KEY_CAP} and the count is a FLOOR. */
  distinctKeyCapHit: boolean;
  /** Per-symbol scan records folded this session (cycle-summed, NOT distinct symbols). */
  scanCount: number;
  /** Completed whole-universe sweeps this session. */
  cycleCount: number;
  /** The naive cycle-summed candidate count — published to make the double-count visible. */
  cycleCandidateCountSum: number;
  reasonCounts: Record<string, number>;
  ivRankMeasured: number;
  ivRankUnknown: number;
  unknownByCode: Record<string, number>;
  /** `ivSampleDepth` → scan-record count; null depths land under the key `"null"`. */
  ivSampleDepthHistogram: Record<string, number>;
  /**
   * Every build that contributed records to this session. More than one entry
   * means the session straddled a restart (same commit) or a deploy (new
   * commit) — TRA-5173's PASS bar turns on the latter, so a straddling session
   * says so rather than being averaged into one anonymous row.
   */
  builds: ArrivalBuildStamp[];
  buildsCapHit: boolean;
  firstRecordedAt: string;
  lastRecordedAt: string;
}

/** The `arrivalHistory` block on `/api/health/short-premium`. */
export interface ShortPremiumArrivalHistoryView {
  /** False ⇒ the ledger has not loaded in this process; `sessions` is then vacuously empty. */
  loaded: boolean;
  /** False ⇒ disk I/O never armed (no boot init) — an in-memory-only fold. */
  armed: boolean;
  ledgerFile: string;
  /** TRA-5172 idiom — true once a load failed; persists are refused until the rename-aside lands. */
  loadFailed: boolean;
  loadParseError: string | null;
  persistCount: number;
  persistErrors: number;
  lastPersistError: string | null;
  persistRefusals: number;
  corruptFileRenamedTo: string | null;
  emptyLedgerWriteRefusals: number;
  retainedSessionCap: number;
  distinctKeyCap: number;
  /**
   * How many session rows the array holds, published beside it so a 3-session
   * ledger reads as "not yet", never as a measured 30-session rate.
   */
  distinctSessionsRecorded: number;
  oldestSessionDate: string | null;
  newestSessionDate: string | null;
  /** Newest first. A session with no recorded activity is ABSENT, never a zero row. */
  sessions: ShortPremiumArrivalSessionView[];
}

/** Synchronous read for the health route — in-memory state only, never disk. */
export function readShortPremiumArrivalHistorySync(): ShortPremiumArrivalHistoryView {
  const days = cache ? [...cache.keys()].sort().reverse() : [];
  const sessions: ShortPremiumArrivalSessionView[] = days.map((day) => {
    const s = cache!.get(day)!;
    return {
      sessionDate: day,
      distinctCandidateCount: s.distinctKeys.size,
      distinctKeyCapHit: s.distinctKeyCapHit,
      scanCount: s.scanCount,
      cycleCount: s.cycleCount,
      cycleCandidateCountSum: s.cycleCandidateCountSum,
      reasonCounts: { ...s.reasonCounts },
      ivRankMeasured: s.ivRankMeasured,
      ivRankUnknown: s.ivRankUnknown,
      unknownByCode: { ...s.unknownByCode },
      ivSampleDepthHistogram: { ...s.ivSampleDepthHistogram },
      builds: s.builds.map((b) => ({ ...b })),
      buildsCapHit: s.buildsCapHit,
      firstRecordedAt: new Date(s.firstRecordedAt).toISOString(),
      lastRecordedAt: new Date(s.lastRecordedAt).toISOString(),
    };
  });
  return {
    loaded: cache != null,
    armed,
    ledgerFile: ledgerFile(),
    loadFailed,
    loadParseError,
    persistCount,
    persistErrors,
    lastPersistError,
    persistRefusals,
    corruptFileRenamedTo,
    emptyLedgerWriteRefusals,
    retainedSessionCap: ARRIVAL_RETAINED_SESSION_CAP,
    distinctKeyCap: ARRIVAL_DISTINCT_KEY_CAP,
    distinctSessionsRecorded: sessions.length,
    oldestSessionDate: days.length > 0 ? days[days.length - 1]! : null,
    newestSessionDate: days.length > 0 ? days[0]! : null,
    sessions,
  };
}
