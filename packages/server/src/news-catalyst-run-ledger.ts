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
  /**
   * TRA-4585 — PRICE-feed health on this run: candidates we tried to price, and
   * candidates that came back with a usable quote (`hasUsableQuote`). `null`
   * when the run never reached the enrichment step, or when it predates these
   * fields. Same `null`-means-not-measured discipline as the pair above.
   *
   * These are a SEPARATE feed from `queries*`. `queriesAttempted/Succeeded`
   * measure the Yahoo *news* sweep; these measure the daily-candle pull behind
   * `fetchCatalystMetrics`. The 2026-08-31 defect is only fully visible with
   * both: a run can score candidates off perfectly healthy news and then drop
   * every one of them because the quote feed answered null. Without this pair
   * that run writes `picks_built / chosenCount: 0` — indistinguishable from a
   * real day on which nothing scored well enough.
   */
  quotesAttempted: number | null;
  quotesOk: number | null;
  /** Error message on the failure outcomes. */
  reason?: string;
}

/**
 * TRA-4598 — the fraction of this run's priced candidates that came back with a
 * usable quote, or `null` when the question does not apply.
 *
 * TWO distinct `null` cases, and conflating either with `0` is the defect this
 * function exists to prevent:
 *
 *   - `quotesAttempted: null` — NOT MEASURED. A pre-TRA-4585 run has no such
 *     key. A ratio must not manufacture a verdict out of an absent measurement.
 *   - `quotesAttempted: 0` — MEASURED, and there was nothing to price. A
 *     genuinely quiet news day maps zero candidates and writes `0`/`0`
 *     (`no_mapped_candidates`, `news-catalyst-source.ts`). That is not an
 *     outage and `0/0` is not a coverage of zero — it is no coverage question
 *     at all. Never divide by it.
 *
 * `quotesOk: null` under a non-null `quotesAttempted` is not a shape the writer
 * emits (both are written in the same object literal or neither is), but it is
 * handled as NOT MEASURED rather than trusted, because the ledger is a
 * long-lived append-only file read back by code that is younger than its
 * oldest rows.
 */
export function catalystQuoteCoverage(
  r: Pick<CatalystRunRecord, 'quotesAttempted' | 'quotesOk'>,
): number | null {
  if (r.quotesAttempted == null || r.quotesOk == null) return null;
  if (r.quotesAttempted <= 0) return null;
  return r.quotesOk / r.quotesAttempted;
}

/**
 * TRA-4598 — the quote-coverage floor below which a run is degraded.
 *
 * NOT a guess. Derived 2026-09-16 by folding coverage over all 32 banked
 * shadow-ledger sessions (505 rows, 2026-07-21 → 2026-09-16). The banked rows
 * predate `quotesAttempted`, so coverage was reconstructed from the drop
 * histogram: before TRA-4585 an unpriced candidate fell through
 * `price == null → 'below_min_price'`, so on history `below_min_price` IS the
 * unquoted count. Two independent derivations agree EXACTLY — all 21
 * `below_min_price` rows, and only those 21, also carry the `rvolZ === 0 &&
 * gapPct === 0` signature of a candidate that got no daily candle. The universe
 * is 25 mega-caps and ETFs (SPY and TSLA are both in the 21), so none of these
 * is a real price-floor drop.
 *
 * The distribution is sharply bimodal:
 *
 *   coverage 1.000 ×28 sessions · 0.952 (07-30) · 0.895 (09-11)
 *   ────────────────── no observation anywhere in (0.263, 0.895) ──────────────
 *   0.263 (08-31, 5/19) · 0.000 (09-01, 0/4)
 *
 * So the classification of every banked session is INVARIANT across a 63-point
 * threshold range, and the floor is not a tuned parameter. `0.50` is chosen
 * inside that dead zone because it also has a meaning that survives this
 * sample — "most of the candidates we tried to price came back unpriced" —
 * and it sits 23.7pts above the worst outage and 39.5pts below the best clean
 * day, both margins wider than the entire 10.5pt spread of the clean cluster.
 *
 * This is the rule the commit message for `4fccdc7f` warned against getting
 * wrong in either direction: it does not flag everything (30 of 32 banked
 * sessions stay eligible), and it does not miss the partial case (08-31 at
 * 0.263 is caught, where the old all-or-nothing arm let it through).
 */
export const CATALYST_MIN_QUOTE_COVERAGE = 0.5;

/**
 * TRA-4585 — did this run measure its inputs, or did it only look like it did?
 *
 * THE predicate. The row stamp (`CatalystShadowRecord.degradedRun`) and the
 * session partition below both call this, so a row can never disagree with the
 * session it belongs to.
 *
 * Degraded ⇔ any of:
 *   1. a terminal outcome that by definition measured nothing
 *      (`fetch_degraded`, `fetch_failed`, `source_failed`);
 *   2. the news sweep issued queries and NONE answered;
 *   3. the price feed was asked for quotes and fewer than
 *      {@link CATALYST_MIN_QUOTE_COVERAGE} of them came back usable.
 *
 * (3) is the arm that catches 2026-08-31 in the general case. (1) and (2)
 * overlap on that specific day — it recorded `fetch_degraded` — but they are
 * not the same rule: `fetch_degraded` is only raised when the *news* sweep dies
 * before enrichment, and a dead quote feed under live news never reaches it.
 *
 * TRA-4598 widened (3) from `quotesOk === 0` to the coverage floor. The
 * all-or-nothing form let the canonical incident's own shape through: 08-31
 * wrote 19 rows, 14 unpriced and 5 priced-and-scored, so `quotesOk === 0` is
 * FALSE and that day was flagged only because the news sweep separately died.
 * A 74%-of-candidates quote outage under a healthy news sweep therefore entered
 * the forward-test cohort as a legitimate low-catalyst session, and reading it
 * back required counting `no_quote` off the per-row histogram — which is
 * exactly what TRA-4222's acceptance sentence rules out ("identifiable from the
 * health payload alone, without inspecting per-row drop reasons"). The old arm
 * is not removed, it is SUBSUMED: `quotesOk === 0` ⇒ coverage `0` ⇒ below any
 * positive floor.
 *
 * ⚠️ `null` is NOT degraded. A pre-TRA-4585 run has `quotesAttempted: null`,
 * which means "not measured", and treating an absent measurement as a positive
 * finding would retro-contaminate the 25 clean sessions QuantTrader has already
 * banked. Each clause therefore requires its counter to be a real number > 0 —
 * for the quote arm that requirement now lives in
 * {@link catalystQuoteCoverage}, which returns `null` for BOTH "not measured"
 * and "nothing to price", so neither can reach the comparison.
 *
 * ⚠️ Consequently this change moves NO banked session. Every row on disk today
 * has `quotesAttempted: null`, so the widened arm cannot fire on history and
 * `degradedSessions[]` is byte-identical across the deploy. It only classifies
 * sessions born after it.
 */
export function isCatalystRunDegraded(
  r: Pick<
    CatalystRunRecord,
    'outcome' | 'queriesAttempted' | 'queriesSucceeded' | 'quotesAttempted' | 'quotesOk'
  >,
): boolean {
  if (r.outcome === 'fetch_degraded' || r.outcome === 'fetch_failed' || r.outcome === 'source_failed')
    return true;
  if (r.queriesAttempted != null && r.queriesAttempted > 0 && r.queriesSucceeded === 0) return true;
  const coverage = catalystQuoteCoverage(r);
  if (coverage != null && coverage < CATALYST_MIN_QUOTE_COVERAGE) return true;
  return false;
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
  /** TRA-4585 — price-feed health on the last run; see {@link CatalystRunRecord}. */
  lastRunQuotesAttempted: number | null;
  lastRunQuotesOk: number | null;
  /** TRA-4598 — {@link catalystQuoteCoverage} over the last run; `null` ⇔ NOT MEASURED. */
  lastRunQuoteCoverage: number | null;
  /**
   * TRA-4585 — {@link isCatalystRunDegraded} over the last run. `null` ↔ there
   * is no last run (the writer has never run on this disk), which is a third
   * state and not a `false`.
   */
  lastRunDegraded: boolean | null;
  lastRunReason: string | null;
  /** Cumulative invocations across ALL boots (durable — survives a restart). */
  runCount: number;
  /** Invocations observed by the current process only. */
  runCountSinceBoot: number;
  /** Distinct ET sessions in which the writer ran at least once. */
  sessionsWithRun: number;
  /**
   * TRA-4585 — the forward-test DENOMINATOR, as a three-field partition.
   *
   * `sessionsDegraded + sessionsEligible === sessionsTotal`, always, and a test
   * pins it (the shape `live-nav-tripwire-ledger.ts` uses for
   * `sessionsTrip + sessionsDegradedOnly + sessionsClean`). A partition that is
   * checkable is the point: the reader does not have to trust that the two
   * buckets were derived from the same set.
   *
   * `sessionsTotal` is the same set as {@link sessionsWithRun} — distinct ET
   * days with ≥1 run — re-exposed under the name that makes the partition read
   * as one. It is not a second measurement and must never diverge.
   *
   * A session is DEGRADED if **any** run in it was degraded, not if all were.
   * That looks harsh until you remember the shadow ledger dedupes one row per
   * symbol per session, first write wins: one degraded run early in the day
   * owns that session's rows outright, and a later healthy run cannot overwrite
   * them. The strict rule is the one that matches what is actually on disk.
   */
  sessionsTotal: number;
  sessionsDegraded: number;
  sessionsEligible: number;
  /**
   * The ET day keys behind `sessionsDegraded`, ascending. Bounded by the
   * degraded subset (rare by construction), and it is what lets a reader
   * reconcile this fold against a hand-kept exclusion list — QuantTrader's
   * banked `26 total | 1 contaminated | 25 eligible` should show up here as
   * exactly `['2026-08-31']` once the field has history behind it.
   */
  degradedSessions: string[];
  /**
   * TRA-4598 — the floor {@link isCatalystRunDegraded} applies, published so a
   * reader can grade `quoteCoverageBySession` without reading the source.
   */
  quoteCoverageFloor: number;
  /**
   * TRA-4598 — how many of `sessionsTotal` have ANY quote telemetry behind
   * them. This is the field that stops "no partial outages" being read as a
   * clean bill of health when the truth is that nothing was measured: every
   * session banked before the TRA-4585 deploy has `quotesAttempted: null`, so
   * immediately after that deploy this reads `0` (or 1) against a
   * `sessionsTotal` in the forties. An absent measurement is not a zero.
   */
  sessionsQuoteMeasured: number;
  /**
   * TRA-4598 — per-session quote coverage, ascending by session. The PARTIAL
   * outage surface: `quoteCoverage: 0.263` is the 2026-08-31 shape, which reads
   * as an ordinary low-catalyst session on every other field of this payload.
   *
   * `quoteCoverage: null` is NOT MEASURED — either the session predates
   * TRA-4585, or every run in it mapped zero candidates so there was nothing to
   * price. It is never a zero, and a reader must not average over it.
   *
   * The reported run is the session's WORST measured one, not a sum across the
   * session. Summing dilutes exactly the case worth catching: one dead run at
   * 0/19 followed by five healthy ones at 19/19 sums to 95/114 = 0.83 and reads
   * clean, while the dead run already owns that session's rows outright — the
   * shadow ledger dedupes one row per symbol per session, first write wins, so
   * a later healthy run cannot overwrite them. Worst-run is also the only rule
   * consistent with `sessionsDegraded`, which flags a session if ANY run in it
   * was degraded.
   */
  quoteCoverageBySession: CatalystSessionQuoteCoverage[];
  /** Tail of the run history, most recent last. */
  recentRuns: CatalystRunRecord[];
}

/** TRA-4598 — one session's worst measured quote coverage. */
export interface CatalystSessionQuoteCoverage {
  session: string;
  /** Counters of the WORST measured run in the session; `null` ⇔ none measured. */
  quotesAttempted: number | null;
  quotesOk: number | null;
  /** `quotesOk / quotesAttempted` of that run, or `null` when NOT MEASURED. */
  quoteCoverage: number | null;
  /**
   * `quoteCoverage != null && quoteCoverage < quoteCoverageFloor`. Explicitly
   * `false` when measured and fine, and `null` when NOT MEASURED — so "clean"
   * and "never looked" are different observations here too.
   */
  belowFloor: boolean | null;
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

  // TRA-4585 — fold the SAME `rows` into the session partition. No new
  // persistence: `session`, `outcome` and both health pairs are already durable
  // per run, so this is arithmetic over what the ledger has always stored.
  const allSessions = new Set(rows.map((r) => r.session));
  const degraded = new Set(rows.filter((r) => isCatalystRunDegraded(r)).map((r) => r.session));
  const degradedSessions = [...degraded].sort();

  // TRA-4598 — worst MEASURED coverage per session. A run whose coverage is
  // `null` contributes nothing: it cannot win the `<` comparison, so a session
  // in which no run measured keeps `null` counters and reads NOT MEASURED,
  // rather than collapsing onto a manufactured `0`.
  const worstBySession = new Map<string, CatalystRunRecord>();
  for (const r of rows) {
    const cov = catalystQuoteCoverage(r);
    if (cov == null) continue;
    const incumbent = worstBySession.get(r.session);
    const incumbentCov = incumbent ? catalystQuoteCoverage(incumbent) : null;
    if (incumbentCov == null || cov < incumbentCov) worstBySession.set(r.session, r);
  }
  const quoteCoverageBySession: CatalystSessionQuoteCoverage[] = [...allSessions]
    .sort()
    .map((session) => {
      const worst = worstBySession.get(session);
      const quoteCoverage = worst ? catalystQuoteCoverage(worst) : null;
      return {
        session,
        quotesAttempted: worst?.quotesAttempted ?? null,
        quotesOk: worst?.quotesOk ?? null,
        quoteCoverage,
        belowFloor: quoteCoverage == null ? null : quoteCoverage < CATALYST_MIN_QUOTE_COVERAGE,
      };
    });

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
    // Same `?? null` for the same reason — a run written before TRA-4585 has no
    // such key, and "not measured" is `null`, never `0`.
    lastRunQuotesAttempted: last?.quotesAttempted ?? null,
    lastRunQuotesOk: last?.quotesOk ?? null,
    lastRunQuoteCoverage: last ? catalystQuoteCoverage(last) : null,
    lastRunDegraded: last ? isCatalystRunDegraded(last) : null,
    lastRunReason: last?.reason ?? null,
    runCount: rows.length,
    runCountSinceBoot: runsSinceBoot,
    sessionsWithRun: allSessions.size,
    sessionsTotal: allSessions.size,
    sessionsDegraded: degraded.size,
    // Subtraction, not a second filter — this is what makes the partition an
    // identity rather than a coincidence two predicates have to keep agreeing on.
    sessionsEligible: allSessions.size - degraded.size,
    degradedSessions,
    quoteCoverageFloor: CATALYST_MIN_QUOTE_COVERAGE,
    // Keyed on `quotesAttempted != null` — "the writer looked" — NOT on
    // `worstBySession`, which excludes the measured-but-nothing-to-price case
    // (`quotesAttempted: 0` on a quiet news day). Those sessions were measured;
    // they just have no coverage ratio to report.
    sessionsQuoteMeasured: new Set(
      rows.filter((r) => r.quotesAttempted != null).map((r) => r.session),
    ).size,
    quoteCoverageBySession,
    recentRuns: rows.slice(-tail),
  };
}
