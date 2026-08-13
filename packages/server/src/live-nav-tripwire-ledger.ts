/**
 * TRA-3449 — **the live-money NAV tripwire, made independent of an agent run.**
 *
 * ## What broke
 *
 * TRA-2636 is the only thing watching whether a `mode: live` book overstates NAV by a
 * lagged session of options P&L. It ran as routine `8d2c80a9` — an LLM agent on a
 * weekday cron. Three consecutive fires were lost (2026-08-11T12:41Z quota,
 * 2026-08-11T21:15Z session limit, 2026-08-12T21:15Z `ENOTFOUND`), `catchUpPolicy` is
 * `skip_missed`, and realized coverage of a real-money safety instrument across
 * 2026-08-06..2026-08-12 was **0%**. The routine's `status` read `active` and its
 * trigger's `enabled` read `true` through all three — **the arming fields read
 * IDENTICALLY in the covered and the uncovered state**, which is why a week went by.
 *
 * ## Why this module exists rather than a platform fix
 *
 * Nothing here fixes agent quota or DNS. It removes the dependency, because C1 does not
 * need an LLM: the endpoint already publishes the entire verdict as first-class scalars.
 * The grade is a field read plus a comparison. An agent is needed for the NARRATIVE, not
 * for the ALARM. Routine `8d2c80a9` is deliberately kept — after this, a lost fire costs
 * a narrative instead of costing coverage.
 *
 * ## The three design constraints that shaped the code
 *
 * 1. **A non-run must leave a trace.** The failure mode being fixed is precisely "the
 *    check did not run and nobody could tell afterwards". So this is a durable JSONL
 *    ledger, not a log line and not an in-memory ring — and {@link summarizeLiveNavTripwire}
 *    enumerates expected market days FROM THE EXCHANGE CALENDAR and reports the ones with
 *    no row as `missing`. A missed day is a first-class state, distinguishable from a
 *    clean one. Same lesson as TRA-2930.
 *
 * 2. **`null` is never a pass, and neither is an ABSENT FIELD.** Every axis is tri-state.
 *    {@link gradeLiveNavTripwirePayload} reads each operand through a typed accessor: a
 *    field that is missing, renamed, or the wrong type grades `blind` with an explicit
 *    reason — it can never fall through to green. This generalises TRA-2630 AC3's
 *    "ABSENCE IS NOT A PASS" from `null` to the field itself, because a gate that reads a
 *    payload it does not own must assume the payload can change under it.
 *
 * 3. **Do not grade on `ok`, `drift`, or `maxDriftUsd`.** They are in the endpoint's own
 *    `ungradeableFields` list and read identically in the pass and the fail state
 *    (TRA-2630 Defect A). Nothing in this module touches them. Worse, this module
 *    ASSERTS that: if the served `ungradeableFields` ever grows to include one of the
 *    four fields this gate DOES key on, the day grades `blind` with
 *    `operand_declared_ungradeable` rather than continuing to publish a verdict the
 *    endpoint itself has disowned.
 *
 * ## What is graded, and what is only RECORDED
 *
 * GRADED (an alarm fires):
 *   - `livePriorOptionsLagOk === false`            -> `fail`  — the tripwire itself.
 *   - `liveEodRowsPresentOk === false`             -> `fail`  — unwritten EOD row, live book.
 *   - `liveEodTailMaxStaleSessions > 0`            -> `fail`  — dead tail, live book.
 *   - `liveGradeableBookCount < liveBookCount`     -> `blind` — a live book is UNGRADED.
 *   - any of the above `null` / absent / ungradeable-declared -> `blind`.
 *
 * RECORDED BUT NOT GRADED — `liveEodInteriorAbsentBooks`. It is the discriminator of
 * record per TRA-2943 (the boolean `eodInteriorAbsentOk` is retired, pinned false), and
 * it is NON-EMPTY today on both live books. Gating on it would ship a born-red gate, and
 * a gate that is red on day one is switched off within a week — the exact outcome
 * TRA-3449 item 3 warns about. Instead the username/date set is written verbatim into
 * every row, so a NEW interior absence is recoverable from the ledger after the fact by
 * diffing consecutive days. Promoting it to a graded axis needs a pinned known-hole
 * baseline first (TRA-2886 ruled 2026-07-30..08-03 permanent and fleet-wide; the
 * 2026-08-07 date live today is NOT in that documented set).
 *
 * ## Why `blind` is a separate verdict from `fail`
 *
 * TRA-3449 item 2 asks for a loud failure when `liveGradeableBookCount < liveBookCount`.
 * The word doing the work in that line is **silently** ungraded. Collapsing a coverage
 * hole into the same bucket as a real-money NAV overstatement would mean `v0nni` — a live
 * book with $25,000 that has not filled yet, so `priorOptionsLagOk: null` and
 * `priorOptionsLagEligibleDates: []` — publishes a red every single day until TRA-3417
 * lands. That is the false-red that gets a gate disabled. So: three verdicts, `alarm` is
 * TRUE for both `fail` and `blind`, `clean` requires every axis to have genuinely passed,
 * and the ungraded book is NAMED in the row with the reason it could not be graded. It is
 * not silent, it is not green, and it is not indistinguishable from a $-real breach.
 *
 * ## Where the payload comes from
 *
 * The 21:00 ET archive hook self-fetches `http://127.0.0.1:${PORT}/api/health/pnl-reconciliation`
 * — the same in-process probe pattern as `probeHealth()`. That is deliberate: it grades the
 * SERVING build's actual response body, so a field this gate depends on that gets renamed or
 * dropped by a deploy shows up as `blind`/`missing_field` on the next row instead of silently
 * degrading. The engine assembly is inlined in the route handler (~536 lines in `index.ts`),
 * so re-deriving it here would fork the very computation under test.
 *
 * A fetch that throws, times out, or returns non-200 STILL writes a row —
 * `source: 'unreachable'`, `verdict: 'blind'`. Only a process that is not running at all
 * leaves no row, and that is what the calendar-derived `missing` day catches.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getEasternUtcOffset } from '@trading-app/shared';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import { isMarketDayIso } from './scheduler.js';

const log = logger.child({ module: 'live-nav-tripwire' });

export const LIVE_NAV_TRIPWIRE_FILENAME = 'live-nav-tripwire.jsonl';

/**
 * Retain this many ms on disk (compacted on boot). The outage this module was built for
 * ran 5 sessions / 7 days before anyone noticed. 400 days keeps a full year of the
 * real-money record readable long after the fact, at one line per calendar day — the file
 * is bounded by ~400 rows regardless of fleet size, so retention is cheap here in a way it
 * is not for the per-book ledgers.
 */
const RETAIN_MS = 400 * 24 * 60 * 60 * 1000;

/** The four served scalars this gate keys on. Named once so the ungradeable cross-check can use them. */
export const LIVE_NAV_GRADED_FIELDS = [
  'livePriorOptionsLagOk',
  'liveGradeableBookCount',
  'liveEodRowsPresentOk',
  'liveEodTailMaxStaleSessions',
] as const;

/**
 * Fields the endpoint publishes that this gate must NEVER key on (TRA-2630 Defect A,
 * restated as code so a future edit trips the unit test rather than shipping a false-red).
 */
export const LIVE_NAV_FORBIDDEN_FIELDS = ['ok', 'drift', 'maxDriftUsd', 'eodInteriorAbsentOk'] as const;

export type LiveNavAxisStatus = 'pass' | 'fail' | 'blind';

export interface LiveNavAxis {
  status: LiveNavAxisStatus;
  /** Machine-readable cause. `null` only on `pass`. */
  reason: string | null;
}

/** `fail` > `blind` > `clean`. `alarm` is true for the first two. */
export type LiveNavVerdict = 'clean' | 'blind' | 'fail';

export interface LiveNavUngradedBook {
  username: string;
  /**
   * - `no_eligible_dates` — the book has no session whose PRIOR carried non-zero
   *   `optionsDaily`, so the lag predicate has no failing state on it. Benign TODAY
   *   (`v0nni`, live since 2026-08-05, has not filled). Not green: the instant it fills
   *   this must start grading, and a row that recorded it as covered would hide that.
   * - `ungraded` — live, HAS eligible dates, and still `priorOptionsLagOk === null`.
   *   That is a defect in the grader, not a quiet book.
   */
  reason: 'no_eligible_dates' | 'ungraded';
}

/** The graded result. Pure function of the payload — no IO, no clock, no LLM. */
export interface LiveNavGrade {
  verdict: LiveNavVerdict;
  alarm: boolean;
  axes: {
    /** `livePriorOptionsLagOk` — the real-money NAV-overstatement tripwire. */
    lag: LiveNavAxis;
    /** `liveGradeableBookCount` vs `liveBookCount` — is every live book actually covered? */
    coverage: LiveNavAxis;
    /** `liveEodRowsPresentOk` — interior EOD row presence on live books. */
    eodRows: LiveNavAxis;
    /** `liveEodTailMaxStaleSessions` — dead tail on a live book. */
    eodTail: LiveNavAxis;
  };
  /** Offending books, ready to print. Empty on a clean lag axis. */
  lagBooks: Array<{ username: string; dates: string[] }>;
  /** Named, with WHY — see {@link LiveNavUngradedBook}. */
  ungradedBooks: LiveNavUngradedBook[];
  eodRowMissingBooks: Array<{ username: string; dates: string[] }>;
  eodTailStaleBooks: Array<{ username: string; staleSessions: number }>;
  /**
   * TRA-2943 discriminator of record. RECORDED, NOT GRADED — see the module header.
   * Diff this across consecutive rows to detect a NEW interior absence.
   */
  interiorAbsentBooks: Array<{ username: string; dates: string[] }>;
  /** The operands verbatim, so a row is auditable a year later without re-fetching. */
  observed: {
    livePriorOptionsLagOk: boolean | null | undefined;
    liveBookCount: number | null | undefined;
    liveGradeableBookCount: number | null | undefined;
    liveEodRowsPresentOk: boolean | null | undefined;
    liveEodTailMaxStaleSessions: number | null | undefined;
    /** The endpoint's own disowned-field list, as served. */
    ungradeableFields: string[] | null;
  };
}

/** One durable row. Exactly one per ET calendar day; a re-run UPSERTS (last write wins). */
export interface LiveNavTripwireRecord extends LiveNavGrade {
  kind: 'assert';
  /** Record time, ms epoch. */
  ts: number;
  /** ET calendar day of the assertion (America/New_York, YYYY-MM-DD). */
  etDay: string;
  /** NYSE session? From `isMarketDayIso` — the INDEPENDENT calendar, not a recorded flag (TRA-3284). */
  marketDay: boolean;
  /** `served` — a 200 with a JSON body. `unreachable` — fetch threw / timed out / non-200. */
  source: 'served' | 'unreachable';
  /** The payload's own `time`, so a stale cached body is visible. */
  payloadTime: string | null;
  /** Non-null only when `source: 'unreachable'`. */
  fetchError: string | null;
}

// ── ET day ───────────────────────────────────────────────────────────────────

/** ET calendar-day string (YYYY-MM-DD) for a UTC ms instant (DST-aware). */
export function liveNavEtDay(utcMs: number): string {
  const shifted = utcMs + getEasternUtcOffset(utcMs) * 3_600_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

// ── Grading (pure) ───────────────────────────────────────────────────────────

function asBoolOrNull(v: unknown): { value: boolean | null | undefined; bad: string | null } {
  if (v === undefined) return { value: undefined, bad: 'missing_field' };
  if (v === null) return { value: null, bad: null };
  if (typeof v !== 'boolean') return { value: undefined, bad: 'field_wrong_type' };
  return { value: v, bad: null };
}

function asNumOrNull(v: unknown): { value: number | null | undefined; bad: string | null } {
  if (v === undefined) return { value: undefined, bad: 'missing_field' };
  if (v === null) return { value: null, bad: null };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { value: undefined, bad: 'field_wrong_type' };
  return { value: v, bad: null };
}

function bookList(v: unknown): Array<{ username: string; dates: string[] }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      username: typeof e.username === 'string' ? e.username : '(unnamed)',
      dates: Array.isArray(e.dates) ? e.dates.filter((d): d is string => typeof d === 'string') : [],
    }));
}

/**
 * Grade one served `/api/health/pnl-reconciliation` body.
 *
 * PURE — same input, same output, no clock and no IO, so the unit tests can pin every
 * state including the ones that have never occurred in production.
 *
 * Fails closed on every path: a non-object payload, a missing field, a wrong-typed field,
 * an operand the endpoint has itself declared ungradeable, an empty live cohort — all of
 * them grade `blind`. There is no input for which an absent operand yields `clean`.
 */
export function gradeLiveNavTripwirePayload(payload: unknown): LiveNavGrade {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const payloadUsable = typeof payload === 'object' && payload !== null;

  const rawUngradeable = Array.isArray(p.ungradeableFields)
    ? p.ungradeableFields.filter((f): f is string => typeof f === 'string')
    : null;
  const ungradeableSet = new Set(rawUngradeable ?? []);
  /**
   * The endpoint disowning one of OUR operands is not a detail — it means the field we
   * grade on has joined the class of fields that read identically in the pass and fail
   * state. Publishing a verdict off it after that is exactly TRA-2630 Defect A. Blind.
   */
  const disowned = (field: string): boolean => ungradeableSet.has(field);

  const lagRaw = asBoolOrNull(p.livePriorOptionsLagOk);
  const bookCountRaw = asNumOrNull(p.liveBookCount);
  const gradeableRaw = asNumOrNull(p.liveGradeableBookCount);
  const eodRowsRaw = asBoolOrNull(p.liveEodRowsPresentOk);
  const eodTailRaw = asNumOrNull(p.liveEodTailMaxStaleSessions);

  const lagBooks = bookList(p.livePriorOptionsLagBooks);
  const eodRowMissingBooks = bookList(p.liveEodRowMissingBooks);
  const interiorAbsentBooks = bookList(p.liveEodInteriorAbsentBooks);
  const eodTailStaleBooks = Array.isArray(p.liveEodTailStaleBooks)
    ? p.liveEodTailStaleBooks
        .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
        .map((e) => ({
          username: typeof e.username === 'string' ? e.username : '(unnamed)',
          staleSessions: typeof e.staleSessions === 'number' ? e.staleSessions : 0,
        }))
    : [];

  // Per-book ungraded detail, from `engines[]`. Absent engines is not fatal to the fold —
  // the coverage COUNTS above are the graded operand; this list is the human-readable why.
  const ungradedBooks: LiveNavUngradedBook[] = [];
  if (Array.isArray(p.engines)) {
    for (const e of p.engines) {
      if (typeof e !== 'object' || e === null) continue;
      const eng = e as Record<string, unknown>;
      if (eng.mode !== 'live') continue;
      if (eng.priorOptionsLagOk !== null && eng.priorOptionsLagOk !== undefined) continue;
      const eligible = Array.isArray(eng.priorOptionsLagEligibleDates)
        ? eng.priorOptionsLagEligibleDates.length
        : 0;
      ungradedBooks.push({
        username: typeof eng.username === 'string' ? eng.username : '(unnamed)',
        reason: eligible === 0 ? 'no_eligible_dates' : 'ungraded',
      });
    }
  }

  const blind = (reason: string): LiveNavAxis => ({ status: 'blind', reason });
  const pass = (): LiveNavAxis => ({ status: 'pass', reason: null });
  const fail = (reason: string): LiveNavAxis => ({ status: 'fail', reason });

  // ── lag axis — THE tripwire ────────────────────────────────────────────────
  let lag: LiveNavAxis;
  if (!payloadUsable) lag = blind('payload_unusable');
  else if (disowned('livePriorOptionsLagOk')) lag = blind('operand_declared_ungradeable');
  else if (lagRaw.bad) lag = blind(lagRaw.bad);
  else if (lagRaw.value === null) lag = blind('not_measured');
  else if (lagRaw.value === false) lag = fail('live_book_overstated_nav');
  else lag = pass();

  // ── coverage axis — is every live book actually covered? ───────────────────
  let coverage: LiveNavAxis;
  if (!payloadUsable) coverage = blind('payload_unusable');
  else if (disowned('liveGradeableBookCount') || disowned('liveBookCount'))
    coverage = blind('operand_declared_ungradeable');
  else if (bookCountRaw.bad) coverage = blind(`liveBookCount_${bookCountRaw.bad}`);
  else if (gradeableRaw.bad) coverage = blind(`liveGradeableBookCount_${gradeableRaw.bad}`);
  else if (bookCountRaw.value == null || gradeableRaw.value == null) coverage = blind('not_measured');
  // The empty live cohort is the original TRA-2630 AC3 manufactured-green: "no live book
  // was affected" and "there was no live book" must never be the same reading.
  else if (bookCountRaw.value === 0) coverage = blind('empty_live_cohort');
  else if (gradeableRaw.value < bookCountRaw.value)
    coverage = blind(
      `ungraded_live_books:${gradeableRaw.value}_of_${bookCountRaw.value}`,
    );
  else coverage = pass();

  // ── EOD interior row presence, live books ─────────────────────────────────
  let eodRows: LiveNavAxis;
  if (!payloadUsable) eodRows = blind('payload_unusable');
  else if (disowned('liveEodRowsPresentOk')) eodRows = blind('operand_declared_ungradeable');
  else if (eodRowsRaw.bad) eodRows = blind(eodRowsRaw.bad);
  else if (eodRowsRaw.value === null) eodRows = blind('not_measured');
  else if (eodRowsRaw.value === false) eodRows = fail('live_book_missing_eod_row');
  else eodRows = pass();

  // ── EOD tail staleness, live books ────────────────────────────────────────
  let eodTail: LiveNavAxis;
  if (!payloadUsable) eodTail = blind('payload_unusable');
  else if (disowned('liveEodTailMaxStaleSessions')) eodTail = blind('operand_declared_ungradeable');
  else if (eodTailRaw.bad) eodTail = blind(eodTailRaw.bad);
  // `== null` rather than `=== null`: the `bad` branch above has already claimed
  // `undefined`, and the loose form is what narrows the operand to `number` for the
  // comparison below. A `> 0` on a possibly-undefined operand is false, i.e. GREEN.
  else if (eodTailRaw.value == null) eodTail = blind('not_measured');
  else if (eodTailRaw.value > 0) eodTail = fail(`live_book_eod_tail_stale:${eodTailRaw.value}`);
  else eodTail = pass();

  const axes = { lag, coverage, eodRows, eodTail };
  const statuses = Object.values(axes).map((a) => a.status);
  const verdict: LiveNavVerdict = statuses.includes('fail')
    ? 'fail'
    : statuses.includes('blind')
      ? 'blind'
      : 'clean';

  return {
    verdict,
    alarm: verdict !== 'clean',
    axes,
    lagBooks,
    ungradedBooks,
    eodRowMissingBooks,
    eodTailStaleBooks,
    interiorAbsentBooks,
    observed: {
      livePriorOptionsLagOk: lagRaw.value,
      liveBookCount: bookCountRaw.value,
      liveGradeableBookCount: gradeableRaw.value,
      liveEodRowsPresentOk: eodRowsRaw.value,
      liveEodTailMaxStaleSessions: eodTailRaw.value,
      ungradeableFields: rawUngradeable,
    },
  };
}

// ── Store (disk is the record; memory backs the health view) ─────────────────

let dataDir: string | null = null;
/** Keyed by `etDay` — one row per day, last write wins. */
const rows = new Map<string, LiveNavTripwireRecord>();
let appendErrors = 0;
let lastAppendError: string | null = null;
let hydratedRecords = 0;

export function liveNavTripwireLogPath(dir: string): string {
  return join(dir, LIVE_NAV_TRIPWIRE_FILENAME);
}

export function clearLiveNavTripwire(): void {
  rows.clear();
  dataDir = null;
  appendErrors = 0;
  lastAppendError = null;
  hydratedRecords = 0;
}

/** Test seam — inject rows without touching disk. */
export function seedLiveNavTripwireForTest(recs: LiveNavTripwireRecord[]): void {
  for (const r of recs) rows.set(r.etDay, r);
}

function validRecord(v: unknown): LiveNavTripwireRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (r.kind !== 'assert') return null;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null;
  if (typeof r.etDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.etDay)) return null;
  if (r.verdict !== 'clean' && r.verdict !== 'blind' && r.verdict !== 'fail') return null;
  if (typeof r.axes !== 'object' || r.axes === null) return null;
  return r as unknown as LiveNavTripwireRecord;
}

function appendRow(rec: LiveNavTripwireRecord): void {
  // Memory first and unconditionally, then a best-effort disk write — the same ordering
  // as `eod-archive-participation.ts`, and for the same reason: this recorder must not be
  // able to break the archive it hangs off. `durability.appendErrors` below is what keeps
  // a memory-only recorder from reading as durable.
  rows.set(rec.etDay, rec);
  if (dataDir == null) return;
  const path = liveNavTripwireLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces it
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('live-nav-tripwire append failed', { reason: lastAppendError });
  }
}

export interface RecordLiveNavAssertionInput {
  grade: LiveNavGrade;
  source: 'served' | 'unreachable';
  payloadTime?: string | null;
  fetchError?: string | null;
  now?: number;
}

/**
 * Write one assertion row for the current ET day, and log LOUDLY when it is not clean.
 *
 * The log line is the immediate alarm; the row is the durable one. Neither is sufficient
 * alone — a log line rotates away (that is half of what TRA-3449 is about), and a row
 * nobody reads is silent until someone queries the route.
 */
export function recordLiveNavTripwireAssertion(
  input: RecordLiveNavAssertionInput,
): LiveNavTripwireRecord {
  const now = input.now ?? Date.now();
  const etDay = liveNavEtDay(now);
  const rec: LiveNavTripwireRecord = {
    ...input.grade,
    kind: 'assert',
    ts: now,
    etDay,
    marketDay: isMarketDayIso(etDay),
    source: input.source,
    payloadTime: input.payloadTime ?? null,
    fetchError: input.fetchError ?? null,
  };
  appendRow(rec);

  if (rec.verdict === 'fail') {
    log.error('LIVE-MONEY NAV TRIPWIRE: FAIL (TRA-3449)', {
      etDay,
      axes: rec.axes,
      lagBooks: rec.lagBooks,
      eodRowMissingBooks: rec.eodRowMissingBooks,
      eodTailStaleBooks: rec.eodTailStaleBooks,
    });
  } else if (rec.verdict === 'blind') {
    log.warn('live-money NAV tripwire: BLIND — not clean, not graded (TRA-3449)', {
      etDay,
      axes: rec.axes,
      ungradedBooks: rec.ungradedBooks,
      source: rec.source,
      fetchError: rec.fetchError,
    });
  } else {
    log.info('live-money NAV tripwire: clean (TRA-3449)', {
      etDay,
      liveBookCount: rec.observed.liveBookCount,
      liveGradeableBookCount: rec.observed.liveGradeableBookCount,
    });
  }
  return rec;
}

export interface LiveNavHydration {
  days: number;
  records: number;
}

/**
 * Load the ledger from disk, compacting past-retention and unparseable lines.
 *
 * One bad line is skipped, never fatal: a half-written row from a hard kill must not cost
 * the whole record. Later rows for the same `etDay` overwrite earlier ones, which makes a
 * hand re-run of the assertion idempotent on the day it targets.
 */
export function hydrateLiveNavTripwireFromDisk(dir: string, now: number = Date.now()): LiveNavHydration {
  clearLiveNavTripwire();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(liveNavTripwireLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  let seen = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    seen += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = validRecord(parsed);
    if (rec === null) continue;
    if (rec.ts < cutoff) continue;
    rows.set(rec.etDay, rec);
  }

  const kept = [...rows.values()].sort((a, b) => a.ts - b.ts);
  if (kept.length < seen) {
    const path = liveNavTripwireLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8');
    } catch (err) {
      log.warn('live-nav-tripwire compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hydratedRecords = kept.length;
  return { days: rows.size, records: kept.length };
}

// ── Health summary ───────────────────────────────────────────────────────────

/** A day in the window that SHOULD have a row. `missing` is the whole point of this module. */
export interface LiveNavDaySummary {
  etDay: string;
  marketDay: boolean;
  /** `missing` — the assertion did not run at all that day. Distinguishable from `clean`. */
  verdict: LiveNavVerdict | 'missing';
  alarm: boolean;
  source: 'served' | 'unreachable' | null;
  axes: LiveNavTripwireRecord['axes'] | null;
  lagBooks: Array<{ username: string; dates: string[] }>;
  ungradedBooks: LiveNavUngradedBook[];
}

export interface LiveNavTripwireSummary {
  /** `fail` if ANY market day in the window failed; else `blind` if any blind/missing; else `clean`; `null` on an empty window. */
  verdict: LiveNavVerdict | null;
  alarm: boolean;
  /** Newest first. */
  byDay: LiveNavDaySummary[];
  coverage: {
    /** NYSE sessions in the window, from the INDEPENDENT calendar — not from the rows. */
    marketDaysExpected: number;
    /** Sessions with a row of any verdict. */
    marketDaysRecorded: number;
    /** Sessions with NO row. THE metric TRA-3449 exists to publish. */
    marketDaysMissing: string[];
    /** `marketDaysRecorded / marketDaysExpected`, or `null` on an empty window. */
    realizedCoverage: number | null;
  };
  latest: LiveNavTripwireRecord | null;
  /** Most recent day whose verdict was `fail`, or null. */
  lastFailDay: string | null;
  /** Consecutive most-recent market days with no row. >0 means the writer is down NOW. */
  consecutiveMissingSessions: number;
  /** Non-graded evidence — diff across days to find a NEW interior absence (TRA-2943). */
  interiorAbsentBooksLatest: Array<{ username: string; dates: string[] }>;
  durability: {
    /** `true` ⇒ nothing here survives a restart, so an empty ledger proves nothing. */
    ephemeral: boolean;
    dataDir: string | null;
    hydratedRecords: number;
    appendErrors: number;
    lastAppendError: string | null;
  };
}

function prevDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Fold the ledger into the health view.
 *
 * The denominator is re-derived from `isMarketDayIso` over the last `dayLimit` calendar
 * days, NOT from the rows — TRA-3284's lesson, and the only construction under which a
 * day the writer never reached can appear at all. A summary whose day list came from the
 * rows would report 100% coverage over the exact week that had 0%.
 *
 * `windowEndEtDay` is normally today. It is a parameter so the tests can pin a window and
 * so a caller can ask "what did the last 30 sessions look like as of the 12th".
 */
export function summarizeLiveNavTripwire(
  dayLimit = 45,
  windowEndEtDay: string = liveNavEtDay(Date.now()),
): LiveNavTripwireSummary {
  const calendarDays: string[] = [];
  let cursor = windowEndEtDay;
  for (let i = 0; i < dayLimit; i += 1) {
    calendarDays.push(cursor);
    cursor = prevDay(cursor);
  }

  const byDay: LiveNavDaySummary[] = calendarDays.map((etDay) => {
    const rec = rows.get(etDay);
    const marketDay = isMarketDayIso(etDay);
    if (!rec) {
      return {
        etDay,
        marketDay,
        // A non-session with no row is NOT a miss — the assertion is only expected after
        // the 21:00 archive on a trading day. Folding weekends in would bury a real miss
        // under ~30% expected absence (the TRA-2930 denominator mistake).
        verdict: marketDay ? ('missing' as const) : ('clean' as const),
        alarm: marketDay,
        source: null,
        axes: null,
        lagBooks: [],
        ungradedBooks: [],
      };
    }
    return {
      etDay,
      marketDay,
      verdict: rec.verdict,
      alarm: rec.alarm,
      source: rec.source,
      axes: rec.axes,
      lagBooks: rec.lagBooks,
      ungradedBooks: rec.ungradedBooks,
    };
  });

  const sessions = byDay.filter((d) => d.marketDay);
  const missing = sessions.filter((d) => d.verdict === 'missing').map((d) => d.etDay);
  const recorded = sessions.length - missing.length;

  // Only sessions carry a verdict. `fail` beats `blind`/`missing` beats `clean`.
  const anyFail = sessions.some((d) => d.verdict === 'fail');
  const anyBlind = sessions.some((d) => d.verdict === 'blind' || d.verdict === 'missing');
  const verdict: LiveNavVerdict | null =
    sessions.length === 0 ? null : anyFail ? 'fail' : anyBlind ? 'blind' : 'clean';

  let consecutiveMissing = 0;
  for (const d of sessions) {
    if (d.verdict === 'missing') consecutiveMissing += 1;
    else break;
  }

  const ordered = [...rows.values()].sort((a, b) => b.ts - a.ts);
  const latest = ordered[0] ?? null;

  return {
    verdict,
    alarm: verdict != null && verdict !== 'clean',
    byDay,
    coverage: {
      marketDaysExpected: sessions.length,
      marketDaysRecorded: recorded,
      marketDaysMissing: missing,
      realizedCoverage: sessions.length === 0 ? null : recorded / sessions.length,
    },
    latest,
    lastFailDay: sessions.find((d) => d.verdict === 'fail')?.etDay ?? null,
    consecutiveMissingSessions: consecutiveMissing,
    interiorAbsentBooksLatest: latest?.interiorAbsentBooks ?? [],
    durability: {
      ephemeral: isEphemeralDataDir(dataDir),
      dataDir,
      hydratedRecords,
      appendErrors,
      lastAppendError,
    },
  };
}

// ── The tick (IO) ────────────────────────────────────────────────────────────

export interface RunLiveNavTripwireTickInput {
  /** Injected so the test can drive every branch without a listening socket. */
  fetchPayload: () => Promise<{ ok: boolean; status: number; body: unknown }>;
  now?: number;
}

/**
 * Fetch the served payload, grade it, and write exactly one durable row.
 *
 * NEVER THROWS and ALWAYS WRITES. That is load-bearing: the whole ticket is "the check
 * did not run and nobody could tell afterwards", so a tick that swallowed its own failure
 * without leaving a row would reproduce the bug it is fixing one layer down.
 */
export async function runLiveNavTripwireTick(
  input: RunLiveNavTripwireTickInput,
): Promise<LiveNavTripwireRecord> {
  const now = input.now ?? Date.now();
  let body: unknown = null;
  let source: 'served' | 'unreachable' = 'unreachable';
  let fetchError: string | null = null;

  try {
    const resp = await input.fetchPayload();
    if (!resp.ok) {
      fetchError = `http_${resp.status}`;
    } else {
      body = resp.body;
      source = 'served';
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const grade = gradeLiveNavTripwirePayload(source === 'served' ? body : null);
  const payloadTime =
    source === 'served' && typeof (body as Record<string, unknown> | null)?.time === 'string'
      ? ((body as Record<string, unknown>).time as string)
      : null;

  return recordLiveNavTripwireAssertion({ grade, source, payloadTime, fetchError, now });
}
