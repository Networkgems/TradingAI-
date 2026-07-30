import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';
import { resolveDataDir } from './data-dir.js';

// TRA-2064 (parent TRA-1630, TRA-1623A) — durable RUN ledger for the
// news-catalyst premarket writer.
//
// Why this exists: TRA-1630 accrued ZERO signal rows across 5 armed RTH
// sessions (07-13 → 07-17) and there was no way to tell which of four things
// happened, because every failure path exited into a `log.warn` with nothing
// surfaced on a probe:
//
//   1. the writer ran and simply selected nothing   → `picks_built`
//   2. news mapped onto zero universe names         → `no_mapped_candidates`
//   3. the news feed threw                          → `fetch_failed`
//   4. the call site threw before/around the build  → `source_failed`
//   5. the `onPremarket` hook never fired at all    → NO ROW AT ALL
//
// Cases 1 and 5 read IDENTICALLY on the old probe: `count: 0`. That is the
// whole defect — "no catalysts today" and "pipeline never executed" were the
// same observation, which makes every fire of the watch routine unfalsifiable.
//
// DURABILITY IS LOAD-BEARING, NOT INCIDENTAL. The leading root-cause hypothesis
// for the missed sessions is crash-restarts across the writer's firing window
// (TRA-1894 / TRA-1905 / TRA-1996). An in-memory `runCount` would be zeroed by
// exactly the event under investigation, and a post-restart read of `0` would
// again be indistinguishable from "never ran". So the run history is appended
// to the persistent disk (`DATA_DIR`, mounted at `/data` on bqb1) with the same
// append-only JSONL shape as `news-catalyst-ledger.ts`.
//
// Observe-only. Nothing here routes an order, sizes a position, or alters an
// exit — it records what the writer did and when.

const log = logger.child({ module: 'news-catalyst-run-ledger' });

/** Terminal disposition of one `buildNewsCatalystPicks` invocation. */
export type CatalystRunOutcome =
  | 'picks_built' // writer completed; scored `candidateCount`, chose `chosenCount`
  | 'no_mapped_candidates' // feed returned headlines, none mapped onto the universe
  | 'fetch_degraded' // TRA-2064 — feed returned, but EVERY query failed
  | 'fetch_failed' // `fetchNews()` threw — feed/breaker problem
  | 'source_failed'; // the call site threw around the whole build

/** One persisted invocation of the news-catalyst premarket writer. */
export interface CatalystRunRecord {
  /** ms-epoch at which the run terminated. */
  at: number;
  /** ET trading day (YYYY-MM-DD) the run belongs to. */
  session: string;
  outcome: CatalystRunOutcome;
  /**
   * Headlines returned by the feed.
   *
   * `null` — NOT MEASURED, not zero. On `fetch_failed` the feed never returned,
   * so there is no count to report; writing `0` here would read identically to
   * "the feed returned an empty list", which is a different diagnosis. `0` on
   * this field is only ever a real, measured zero.
   */
  headlineCount: number | null;
  /** Candidates scored (chosen AND dropped). `null` when never reached. */
  candidateCount: number | null;
  /** Candidates injected into the watchlist. `null` when never reached. */
  chosenCount: number | null;
  /**
   * TRA-2064 — feed queries issued / answered on this run. `null` when the feed
   * never reported (it threw, or the run predates this field).
   *
   * These are what make `headlineCount: 0` READABLE. A measured zero with
   * `queriesSucceeded === queriesAttempted > 0` is a genuinely quiet news day;
   * the same zero with `queriesSucceeded === 0` is an outage. Before this pair
   * existed both wrote `no_mapped_candidates / headlineCount: 0` and the actual
   * defect — every query resolving to nothing — was unfalsifiable for 6 sessions.
   */
  queriesAttempted: number | null;
  queriesSucceeded: number | null;
  /** Error message on the failure outcomes. */
  reason?: string;
}

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'news-catalyst-runs.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the run ledger at a temp file. Pass `null` to restore default. */
export function setNewsCatalystRunLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
  runsSinceBoot = 0;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** In-memory view of the append-only file, ascending by `at`. */
let cache: CatalystRunRecord[] | null = null;

/**
 * Invocations observed by THIS process since boot. Deliberately kept alongside
 * the durable count: a durable `runCount` that advances while this stays at 0
 * or 1 is the signature of a process that keeps restarting.
 */
let runsSinceBoot = 0;

async function ensureLoaded(): Promise<CatalystRunRecord[]> {
  if (cache) return cache;
  const rows: CatalystRunRecord[] = [];
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as CatalystRunRecord;
          if (rec && typeof rec.at === 'number') rows.push(rec);
        } catch {
          // Skip a single corrupt line rather than losing the whole history.
        }
      }
    } catch (err) {
      log.error('failed to read news-catalyst run ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  rows.sort((a, b) => a.at - b.at);
  cache = rows;
  return cache;
}

/** Eagerly load the run ledger so the health probe has data right after boot. */
export async function initNewsCatalystRunLedger(): Promise<void> {
  await ensureLoaded();
}

/**
 * Record one terminated invocation of the news-catalyst premarket writer.
 *
 * NEVER THROWS. This sits on the premarket watchlist path; an observability
 * write must not be able to take down the thing it observes.
 */
export async function recordCatalystRun(
  input: Omit<CatalystRunRecord, 'session'> & { session?: string },
): Promise<void> {
  runsSinceBoot += 1;
  try {
    const rows = await ensureLoaded();
    const rec: CatalystRunRecord = {
      ...input,
      session: input.session ?? etDateKey(input.at),
    };
    rows.push(rec);

    const path = storeFile();
    const dir = dirname(path);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf-8');

    log.info('news-catalyst run recorded', {
      session: rec.session,
      outcome: rec.outcome,
      headlineCount: rec.headlineCount,
      candidateCount: rec.candidateCount,
      chosenCount: rec.chosenCount,
      ...(rec.reason ? { reason: rec.reason } : {}),
    });
  } catch (err) {
    log.error('news-catalyst run record failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** All persisted runs, ascending by time. */
export async function listCatalystRuns(): Promise<CatalystRunRecord[]> {
  return [...(await ensureLoaded())];
}

/** The run-observability surface rendered onto `/api/health/news-catalyst-signals`. */
export interface CatalystRunSummary {
  /** ms-epoch of the last invocation. `null` ↔ the writer has NEVER run. */
  lastRunAt: number | null;
  lastRunSession: string | null;
  lastRunOutcome: CatalystRunOutcome | null;
  lastRunHeadlineCount: number | null;
  lastRunCandidateCount: number | null;
  lastRunChosenCount: number | null;
  /** TRA-2064 — feed health on the last run; see {@link CatalystRunRecord}. */
  lastRunQueriesAttempted: number | null;
  lastRunQueriesSucceeded: number | null;
  lastRunReason: string | null;
  /** Cumulative invocations across ALL boots (durable — survives a restart). */
  runCount: number;
  /** Invocations observed by the current process only. */
  runCountSinceBoot: number;
  /** Distinct ET sessions in which the writer ran at least once. */
  sessionsWithRun: number;
  /** Tail of the run history, most recent last. */
  recentRuns: CatalystRunRecord[];
}

/**
 * Fold the run history into the probe surface.
 *
 * Read `lastRunAt === null` as "the writer has never run on this disk" — that
 * is the case the old probe could not distinguish from a legitimately empty
 * session, and it is what points at the `onPremarket` hook rather than at
 * selection or the feed.
 */
export async function summarizeCatalystRuns(tail = 20): Promise<CatalystRunSummary> {
  const rows = await ensureLoaded();
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  return {
    lastRunAt: last?.at ?? null,
    lastRunSession: last?.session ?? null,
    lastRunOutcome: last?.outcome ?? null,
    lastRunHeadlineCount: last ? last.headlineCount : null,
    lastRunCandidateCount: last ? last.candidateCount : null,
    lastRunChosenCount: last ? last.chosenCount : null,
    // `?? null` (not `last ? … : null`) — runs written before TRA-2064 have no
    // such key, and an absent measurement is `null`, never `0`.
    lastRunQueriesAttempted: last?.queriesAttempted ?? null,
    lastRunQueriesSucceeded: last?.queriesSucceeded ?? null,
    lastRunReason: last?.reason ?? null,
    runCount: rows.length,
    runCountSinceBoot: runsSinceBoot,
    sessionsWithRun: new Set(rows.map((r) => r.session)).size,
    recentRuns: rows.slice(-tail),
  };
}
