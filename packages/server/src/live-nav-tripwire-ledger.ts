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
 *   - post-onset TRIP-CAPABLE pair count `=== 0`   -> `vacuous` — ran, graded NOTHING.
 *   - any of the above `null` / absent / ungradeable-declared -> `blind`.
 *
 * ## TRA-3450 — why `vacuous` had to become a fifth verdict
 *
 * The gate as first shipped keyed the alarm on `livePriorOptionsLagOk === false`. QuantTrader
 * measured that scalar the same beat and found it is a **VACUOUS true**: it is `true` because
 * the pair set it quantifies over is EMPTY, not because anything passed.
 *
 * Recomputed here off the served 2026-08-13T03:53:21Z payload, independently of the filing:
 *
 *     book    onset        pairs | skipped | tripCapable | POST-onset tripCapable | trips
 *     admin   2026-07-30      73 |      71 |           2 |                      0 |     0
 *     v0nni   (null)           5 |       5 |           0 |                      0 |     0
 *
 * `admin`'s only two trip-capable pairs are 2026-07-28 and 2026-07-29 — its last non-zero
 * `stockDaily` is 07-29, **one session BEFORE its own `liveOptionsOnsetDate` of 07-30**. So the
 * tripwire has never observed a trip-capable session in the live-options era it exists to watch,
 * and a gate keyed on the scalar alone would have read GREEN FOREVER and hardened a false
 * assurance into code — the precise opposite of why TRA-3449 was filed.
 *
 * This is TRA-3449 item 4 ("`null` is not a pass") extended from a null scalar to an EMPTY
 * DENOMINATOR. "Ran and passed" and "ran and had nothing to grade" are different facts and the
 * durable record has to be able to tell them apart, so `vacuous` is its own persisted verdict —
 * never folded into `clean`, and never folded into `blind` either. `blind` means the operand
 * could not be read; `vacuous` means it was read perfectly and quantified over nothing.
 *
 * ### Two denominators, and why the STRICTER one grades
 *
 * `priorOptionsLagEligible` (the endpoint's own cohort) requires only `prev.optionsDaily != 0`,
 * deliberately NOT `cur.stockDaily != 0` — given a non-zero prior the lag hypothesis names one
 * exact value for `cur.stockDaily`, so observing `0.00` refutes it as hard as any third number.
 * That reasoning is sound and is left untouched. But it makes the two denominators diverge on
 * live data today: `admin` has **3** post-onset eligible dates (08-05, 08-06, 08-12) and **0**
 * post-onset trip-capable ones. TRA-3450 asks for the trip-capable count, which is the strictly
 * more conservative of the two, so that is what grades. The eligible count is published beside
 * it on every row ({@link LiveNavBookDenominator.postOnsetEligiblePairs}) so the gap between the
 * two readings stays auditable rather than becoming an argument nobody can settle from the data.
 *
 * ### It is graded PER BOOK, and it is red on day one — on purpose
 *
 * Any live book whose post-onset trip-capable count is 0 makes the axis vacuous, because a
 * fleet-wide sum would let a busy book manufacture cover for a silent one. Both live books are
 * at 0 today, so this axis is `vacuous` from its first row. That is the module header's
 * born-red warning being knowingly overridden: the born-red gate that gets switched off in a
 * week is one that reports a condition nobody can act on, whereas this one reports the exact
 * thing the filer wants known — the real-money tripwire is currently grading nothing — and it
 * clears by itself the first session `admin` books stock P&L after an options day.
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
 * lands. That is the false-red that gets a gate disabled. So: three verdicts, `clean`
 * requires every axis to have genuinely passed, and the ungraded book is NAMED in the row
 * with the reason it could not be graded. It is not silent, it is not green, and it is
 * not indistinguishable from a $-real breach.
 *
 * ## TRA-3711 — the verdict was right and the ALARM was wrong
 *
 * The paragraph above got the VERDICT lattice right and then hung a single boolean off it:
 * `alarm = verdict !== 'clean'`. That boolean is the thing a consumer actually binds to, and
 * it collapsed the exact distinction the verdict had just been careful to make. Measured on
 * the first ever written row (2026-08-13): `lag`, `eodRows`, `eodTail` all `pass`,
 * `lagDenominator` correctly `vacuous`, `coverage` `blind` for `ungraded_live_books:1_of_2`
 * — `v0nni`, `no_eligible_dates`, no live-options onset. `blind` dominates the fold, so
 * `alarm: true`. And `v0nni` having no onset is STRUCTURAL, not transient: every session
 * writes that same row. **An alarm that is pinned on is an alarm nobody can read** — the
 * first real trip would land on a row that already said `alarm: true` yesterday, and the day
 * before, and every day since. It had already cost a grading rule: TRA-3489 bound its
 * PASS/FAIL branches to this aggregate and was structurally incapable of ever passing, and
 * the TRA-3684 ruling had to re-bind rule v2 to `axes.lagDenominator.status` to make it
 * decidable at all.
 *
 * This is the mirror image of TRA-3450. That one was a vacuous TRUE (a false clean); this is
 * a vacuous ALARM (a false red). Same root cause — a signal computed over a denominator that
 * does not exist — opposite polarity.
 *
 * ### Two channels, because there are two questions
 *
 * `blind`/`vacuous` answer **"could we grade it?"**. `fail` answers **"did it trip?"**. One
 * boolean cannot carry both, so there are now three, all published on every row and on the
 * summary:
 *
 *   - {@link LiveNavGrade.alarm}      — **NARROWED.** An assertion TRIPPED: some axis is `fail`.
 *   - {@link LiveNavGrade.degraded}   — we could NOT grade: some axis is `blind` or `vacuous`.
 *   - {@link LiveNavGrade.attention}  — `alarm || degraded`. The PRE-TRA-3711 `alarm`
 *     semantics, preserved verbatim under a name so that anything which needed the union
 *     cannot silently under-alert by keeping its old binding.
 *   - {@link LiveNavGrade.driver}     — WHICH axis set the verdict, its kind, and its reason,
 *     so a consumer binds to a CAUSE and not to a value. This is the field the next TRA-3489
 *     should read; the aggregate `verdict` is a summary, not an operand.
 *
 * `fail` on ANY axis raises `alarm`, including `lagDenominator`'s
 * `post_onset_trip_not_reported_by_scalar` — that one IS an assertion (the endpoint's verdict
 * contradicting its own day rows), so the trip channel must not be gated on the axis's kind.
 *
 * ### The rejected alternative, and why
 *
 * The other candidate was to put a `no_eligible_dates` book OUT OF COHORT for the `coverage`
 * axis — the denominator discipline TRA-3450 applied to `lag`, applied one axis over. It is
 * rejected. TRA-3450's exclusion made its denominator STRICTER and published a NEW, LOUDER
 * state (`vacuous`); excluding `v0nni` from `coverage` makes that denominator WEAKER and
 * publishes GREEN. `v0nni` is a live book holding $25,000. The session it finally fills, a
 * grader still returning `null` on it would read `pass` over a cohort of one — the coverage
 * hole this axis exists to catch, hidden by the fix for a cosmetic complaint about it. The
 * book stays IN cohort, keeps grading `blind`, and `blind` simply stops consuming the trip
 * signal. What DOES change on the axis is its `reason`, which now names the CLASS of the
 * hole (`no_eligible_dates` = structural, `ungraded` = a defect in the grader) rather than
 * only its count.
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
 *
 * ## TRA-4001 — the coverage axis had no OBSERVATION-START marker
 *
 * Measured on the served endpoint at 2026-08-25T18:43Z, twelve sessions into the ledger's
 * life: `WRITER DOWN - 1 consecutive session(s)`, `realizedCoverage 0.25` (8/32) — while the
 * ledger held an UNBROKEN run of 12 served rows, 2026-08-13..2026-08-24, `appendErrors 0`.
 * The 24 sessions scored `missing` decomposed as 23 that PREDATE the ledger's own first row
 * and 1 that was TODAY, pulled at 14:44 ET against a writer that fires at 21:00 ET.
 *
 * Both readings fall out of one omission: `summarizeLiveNavTripwire` denominated over a
 * fixed 45-calendar-day window with no notion of WHEN the ledger started observing or WHEN a
 * session's row falls due. "Never observed" was reported as "observed and absent", and an
 * in-flight session was reported as a lost one — so the route said WRITER DOWN for ~21 hours
 * of every 24, and 25% coverage over a writer that was 12-of-12. That reading is IDENTICAL
 * to the real writer-down state this ledger was built to catch (STEP J of routine 8d2c80a9:
 * three lost fires, 0% coverage 08-06..08-12). It is the pinned-red mirror of the false-green
 * TRA-3449 exists to prevent, and equally unusable: a reader who sees WRITER DOWN every day
 * stops reading, which is exactly how the next genuinely lost fire goes unnoticed.
 *
 * ### The repair, in four parts
 *
 *  (a) A persisted per-deployment **observation-start marker**
 *      (`live-nav-tripwire.observation-start.json`, written beside the ledger on the first
 *      hydrate that finds none, never moved forward). The effective observation start is the
 *      EARLIER of that marker and the ledger's first row, so a writer that is dead from its
 *      first boot is still caught — a marker that only appeared with the first row would
 *      make "never wrote anything" permanently unmeasurable, which is the memory lesson
 *      behind `boot-arm-repair-ledger.ts` applied here.
 *  (b) A session is **DUE** only once its 21:00 ET writer slot plus a short grace has
 *      passed ({@link liveNavWriterDueAtMs}). Before that it sits in its own `pending`
 *      bucket — never `missing`.
 *  (c) Sessions whose writer slot precedes the observation start are **`not_measured`** —
 *      published as a named, counted bucket (`coverage.marketDaysNotMeasured`), neither
 *      folded into `missing` nor into `recorded` nor silently dropped. Zero rows under the
 *      window floor is NOT MEASURED; it is not clean and it is not a failure.
 *  (d) The `writer` / `no_assertion_row` driver, `consecutiveMissingSessions` and
 *      `realizedCoverage` all key on DUE sessions since observation start, so WRITER DOWN
 *      can only fire when a session that genuinely owed a row has none.
 *
 * The calendar count of the window is kept, renamed `coverage.marketDaysInWindow`;
 * `marketDaysExpected` is now the MEASURED denominator (`recorded + missing`) and the
 * `signalClasses` partition holds over it exactly as before. The four buckets partition the
 * window's sessions: `recorded + missing + pending + notMeasured === marketDaysInWindow`.
 *
 * Both branches stay reachable, and the tests hold them: a served row deleted or torn inside
 * the observation window produces EXACTLY one `missing` DUE session (positive control); a
 * same-day pull before the writer slot reports that day `pending` at 100% realized coverage
 * (negative control). A repair that only loosened the failing branch would be a softening.
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

/**
 * TRA-4001 — the observation-start sidecar. A separate file rather than a marker line in
 * the JSONL: `validRecord` (and every build before this one) drops non-`assert` lines on
 * compaction, so a marker row would not survive a rollback. The sidecar is inert to old
 * builds and is never compacted.
 */
export const LIVE_NAV_OBSERVATION_START_FILENAME = 'live-nav-tripwire.observation-start.json';

/**
 * TRA-4001 — the ET hour the writer is scheduled for. The tick hangs LAST off the
 * `onArchive` hook, which the scheduler fires at-or-after 21:00 ET once per ET day
 * (`scheduler.ts`, TRA-388). A session's row is not owed before this.
 */
export const LIVE_NAV_WRITER_EXPECTED_ET_HOUR = 21;

/**
 * TRA-4001 — how long after the 21:00 ET slot a session is still `pending` rather than
 * `missing`. The archive chain runs several closes before this tick (measured ~50s on
 * 2026-08-24: row `payloadTime` 2026-08-25T01:00:50Z), and a post-21:00 restart re-fires the
 * archive on boot. Thirty minutes covers both without hiding a real outage past the same
 * evening — a writer that is down at 21:30 ET reads WRITER DOWN at 21:30 ET.
 */
export const LIVE_NAV_WRITER_DUE_GRACE_MS = 30 * 60 * 1000;

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

/**
 * `vacuous` (TRA-3450) — the axis was READ CLEANLY and quantified over an EMPTY set. It is
 * neither `pass` (nothing passed) nor `blind` (nothing was unreadable). Keeping it distinct is
 * the whole point of the amendment: a scalar that is `true` over zero observations and one that
 * is `true` over a hundred are different facts.
 */
export type LiveNavAxisStatus = 'pass' | 'fail' | 'blind' | 'vacuous';

/**
 * TRA-3711 — what KIND of question the axis answers.
 *
 * - `assertion` — "did the thing we are watching for happen?" A `fail` here is a real trip.
 * - `coverage`  — "were we in a position to answer at all?" `blind`/`vacuous` here is a hole
 *   in the instrument, not an event in the world.
 *
 * Published so a reader can tell the two apart without knowing the axis names. It does NOT
 * gate the trip channel: a `fail` on a `coverage` axis (see `lagDenominator`'s
 * `post_onset_trip_not_reported_by_scalar`) still raises `alarm`, because that status means
 * the axis DID grade something and found it wrong.
 */
export type LiveNavAxisKind = 'assertion' | 'coverage';

export interface LiveNavAxis {
  status: LiveNavAxisStatus;
  /** Machine-readable cause. `null` only on `pass`. */
  reason: string | null;
  /**
   * TRA-3711. Optional on the type because rows written before TRA-3711 do not carry it —
   * {@link liveNavAxisKind} re-derives it from the axis NAME so a hydrated old row classifies
   * identically to a fresh one, with no migration and no back-filled guess.
   */
  kind?: LiveNavAxisKind;
}

/** `fail` > `blind` > `vacuous` > `clean`. */
export type LiveNavVerdict = 'clean' | 'vacuous' | 'blind' | 'fail';

/**
 * The five axis names in PRECEDENCE order. Used to pick {@link LiveNavSignals.driver}
 * deterministically, and as the authority for {@link liveNavAxisKind}.
 *
 * Assertion axes come first so that when a real trip and a coverage hole are present on the
 * same row, the published driver names the TRIP. Ordering the other way would reproduce this
 * ticket one level down: the consumer reads `driver.axis === 'coverage'` and files it as an
 * instrument problem while a live book is overstating NAV.
 */
export const LIVE_NAV_AXIS_ORDER = [
  'lag',
  'eodRows',
  'eodTail',
  'lagDenominator',
  'coverage',
] as const;

export type LiveNavAxisName = (typeof LIVE_NAV_AXIS_ORDER)[number];

const AXIS_KINDS: Record<LiveNavAxisName, LiveNavAxisKind> = {
  lag: 'assertion',
  eodRows: 'assertion',
  eodTail: 'assertion',
  // Both of these answer "could we grade?", not "did it trip?". `lagDenominator` is filed
  // `coverage` because that is what `vacuous` means on it; its `fail` branch is handled by
  // status, not by kind.
  lagDenominator: 'coverage',
  coverage: 'coverage',
};

export function liveNavAxisKind(axis: string): LiveNavAxisKind {
  return AXIS_KINDS[axis as LiveNavAxisName] ?? 'coverage';
}

/** TRA-3711 — the axis that set the verdict, published so a consumer can bind to a CAUSE. */
export interface LiveNavDriver {
  axis: string;
  kind: LiveNavAxisKind;
  status: LiveNavAxisStatus;
  reason: string | null;
}

/**
 * TRA-3711 — the three separated channels, derived from the axes and NOTHING else.
 *
 * Deliberately a pure function of `axes` rather than of a stored boolean: a row written
 * before TRA-3711 carries the old union `alarm: true`, and re-reading that field would keep
 * the pinned alarm alive in the served summary forever. The axes are the primitive; these
 * are a view of them, recomputed on every read.
 */
export interface LiveNavSignals {
  /** An assertion TRIPPED — some axis is `fail`. THE real-money signal. */
  alarm: boolean;
  /** We could NOT grade — some axis is `blind` or `vacuous`. An instrument hole. */
  degraded: boolean;
  /** `alarm || degraded`. The pre-TRA-3711 `alarm` semantics, preserved under a name. */
  attention: boolean;
  /** Which axis set the verdict, and why. `null` only when every axis passed. */
  driver: LiveNavDriver | null;
}

const STATUS_RANK: Record<LiveNavAxisStatus, number> = { fail: 3, blind: 2, vacuous: 1, pass: 0 };

/**
 * Classify a set of axes into the three channels plus the driver.
 *
 * Tolerates a partial / unknown-shaped `axes` map on purpose: it is fed both freshly graded
 * axes and axes rehydrated from a JSONL row that a future build may have written with more
 * axes than this one knows about. An unrecognised axis still ranks by status, so a new axis
 * cannot be silently dropped out of the fold.
 */
export function signalsFromAxes(axes: Record<string, LiveNavAxis | undefined> | null | undefined): LiveNavSignals {
  const entries: Array<[string, LiveNavAxis]> = [];
  const seen = new Set<string>();
  for (const name of LIVE_NAV_AXIS_ORDER) {
    const a = axes?.[name];
    if (a && typeof a.status === 'string') {
      entries.push([name, a]);
      seen.add(name);
    }
  }
  for (const [name, a] of Object.entries(axes ?? {})) {
    if (seen.has(name) || !a || typeof a.status !== 'string') continue;
    entries.push([name, a]);
  }

  let driver: LiveNavDriver | null = null;
  let alarm = false;
  let degraded = false;
  for (const [name, a] of entries) {
    if (a.status === 'fail') alarm = true;
    else if (a.status === 'blind' || a.status === 'vacuous') degraded = true;
    if (a.status === 'pass') continue;
    const rank = STATUS_RANK[a.status] ?? 0;
    if (driver === null || rank > (STATUS_RANK[driver.status] ?? 0)) {
      driver = { axis: name, kind: a.kind ?? liveNavAxisKind(name), status: a.status, reason: a.reason ?? null };
    }
  }
  return { alarm, degraded, attention: alarm || degraded, driver };
}

/** The verdict lattice, over the same axis set. `fail` > `blind` > `vacuous` > `clean`. */
export function verdictFromAxes(
  axes: Record<string, LiveNavAxis | undefined> | null | undefined,
): LiveNavVerdict {
  const statuses = Object.values(axes ?? {})
    .filter((a): a is LiveNavAxis => !!a && typeof a.status === 'string')
    .map((a) => a.status);
  return statuses.includes('fail')
    ? 'fail'
    : statuses.includes('blind')
      ? 'blind'
      : statuses.includes('vacuous')
        ? 'vacuous'
        : 'clean';
}

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

/**
 * TRA-3450 — per-live-book pair census for the lag tripwire's own denominator.
 *
 * Every count is recomputed HERE from `engines[].days[]`, not read from a served summary
 * scalar. That is deliberate: the defect being fixed is a served scalar that reads `true` over
 * an empty set, so a denominator taken from that same summary layer could inherit the exact
 * emptiness it is supposed to expose.
 */
export interface LiveNavBookDenominator {
  username: string;
  /** `engines[].liveOptionsOnsetDate`. `null` ⇒ the book has never opened a live option. */
  onsetDate: string | null;
  /** Consecutive day pairs in the book's series, post-onset or not. */
  totalPairs: number;
  /**
   * Pairs where `stockDaily[t] != 0` AND `optionsDaily[t-1] != 0` — the pairs on which
   * `round(stockDaily[t],2) === round(optionsDaily[t-1],2)` COULD have fired. Not onset-gated.
   */
  tripCapablePairs: number;
  /** {@link tripCapablePairs} additionally gated on `date[t] >= onsetDate`. **THE denominator.** */
  postOnsetTripCapablePairs: number;
  /** Post-onset pairs that actually tripped. Non-zero here means the `lag` axis should be red. */
  postOnsetTripPairs: number;
  /**
   * The endpoint's own weaker cohort, post-onset: `priorOptionsLagEligible` requires only a
   * non-zero PRIOR options figure. Published to keep the two readings comparable — see the
   * module header. NOT graded.
   */
  postOnsetEligiblePairs: number;
  /**
   * `null` when the book's post-onset trip-capable count is > 0.
   *
   * TRA-4000 — `onset_present_no_realized_options`: the book HAS an onset (it opened a live
   * option) but no row carries realized options P&L, so no pair can be trip-capable yet. This
   * is the transitional window between the first live open and the first live close; it is
   * named so a reader can tell it from a book that has realized P&L and merely has no pair
   * with a non-zero stock leg beside it (`no_post_onset_trip_capable_pairs`).
   */
  vacuousReason:
    | 'no_live_options_onset'
    | 'onset_present_no_realized_options'
    | 'no_post_onset_trip_capable_pairs'
    | null;
  /**
   * TRA-3952 — rows in the book's series whose `optionsDaily` clears the cent tolerance.
   * The operand behind {@link lagScope}: a book with no onset AND no options P&L anywhere
   * has nothing for the lag predicate to grade; a book with no onset BUT options P&L has a
   * broken onset derivation, which is a grader defect and must not leave the cohort quietly.
   */
  optionsPnlRows: number;
  /**
   * TRA-3952 — which cohort this book sits in for the `lagDenominator` ANY-gate.
   *
   * - `graded`: the book has a live-options onset; it is in the gate and can hold the axis
   *   `vacuous` on its own (the TRA-3450 per-book rule, unchanged).
   * - `excluded_no_onset`: no onset and no options P&L in any row. The predicate is about
   *   options money leaking into the stock leg, and this book has never had any, so it has
   *   nothing to cover and nothing to be covered for. Published as a NAMED bucket
   *   (`LiveNavGrade.lagDenominatorScope`), never dropped.
   * - `suspect_onset_derivation`: no onset but options P&L is present. The onset operand is
   *   contradicted by the book's own rows; the axis grades `blind` on it.
   * - `onset_unrealized` (TRA-4000): onset present but NO options P&L in any row. The onset
   *   is stamped from the first live option OPENED (`liveOptionsOnsetEtDate` keys on
   *   `openTs`), while `optionsPnlRows` counts sessions with REALIZED options P&L — two
   *   different operands, and between a book's first live open and its first live close they
   *   disagree. Before TRA-4000 this window read as `graded`, which violated the TRA-3952
   *   membership test ("in `excludedNoOnset` iff `optionsPnlRows == 0`") silently: `v0nni`
   *   served `graded` with `optionsPnlRows 0` on 2026-08-25, one session after its onset was
   *   stamped, and walked out of the state the next day by trading. The book stays IN the
   *   gate — it holds the axis `vacuous` exactly as a graded book at zero pairs does, so this
   *   value can never move the axis toward `pass` — but it is named, on the row and in the
   *   reason string, instead of being folded into `graded`.
   *
   * The four values are exhaustive and disjoint over (onset present?, optionsPnlRows > 0?):
   * `graded` = (yes, yes), `onset_unrealized` = (yes, no), `suspect_onset_derivation` =
   * (no, yes), `excluded_no_onset` = (no, no). So `graded` ⇒ `optionsPnlRows > 0`, by
   * construction — the invariant TRA-4000 asked for.
   *
   * Absent on rows written before TRA-3952; `onset_unrealized` absent before TRA-4000.
   */
  lagScope: 'graded' | 'onset_unrealized' | 'excluded_no_onset' | 'suspect_onset_derivation';
}

/**
 * TRA-3952 — the scoping record for the `lagDenominator` ANY-gate, written on every row so
 * "which books was the gate actually over" is recoverable without the payload. The excluded
 * bucket is the point: scoping the gate must not turn into silent exclusion.
 */
export interface LiveNavLagDenominatorScope {
  /** Books with an onset AND realized options P&L. In the gate, and can earn it `pass`. */
  graded: string[];
  /** Live books with no onset and no options P&L — outside the gate, by design, by name. */
  excludedNoOnset: string[];
  /** Live books with no onset but options P&L present — the axis is `blind` on these. */
  suspectOnset: string[];
  /**
   * TRA-4000 — live books with an onset but NO realized options P&L yet (first live option
   * opened, none closed). IN the gate: each holds the axis `vacuous` until it realizes. Named
   * here so "onset stamped, nothing realized" is readable from the scope record alone, without
   * re-deriving it from `optionsPnlRows` by hand. Absent on rows written before TRA-4000, where
   * such a book was folded into `graded` — do not read an absent field as an empty bucket.
   */
  onsetUnrealized?: string[];
}

/** The graded result. Pure function of the payload — no IO, no clock, no LLM. */
export interface LiveNavGrade extends LiveNavSignals {
  verdict: LiveNavVerdict;
  axes: {
    /** `livePriorOptionsLagOk` — the real-money NAV-overstatement tripwire. */
    lag: LiveNavAxis;
    /** `liveGradeableBookCount` vs `liveBookCount` — is every live book actually covered? */
    coverage: LiveNavAxis;
    /** `liveEodRowsPresentOk` — interior EOD row presence on live books. */
    eodRows: LiveNavAxis;
    /** `liveEodTailMaxStaleSessions` — dead tail on a live book. */
    eodTail: LiveNavAxis;
    /**
     * TRA-3450 — did the `lag` axis have ANYTHING to grade? `vacuous` when any live book's
     * post-onset trip-capable pair count is 0. Never `pass` unless every live book has at
     * least one, so a `clean` verdict now carries a non-empty denominator by construction.
     *
     * TRA-3952 — "every live book" is now every live book WITH a live-options onset. A live
     * book that has never opened an option and has never booked options P&L has no lag
     * predicate to grade and sits outside the gate in the named `excludedNoOnset` bucket of
     * {@link LiveNavGrade.lagDenominatorScope}. An empty graded cohort is still `vacuous`,
     * never `pass`; a no-onset book that DOES carry options P&L makes the axis `blind`.
     */
    lagDenominator: LiveNavAxis;
  };
  /** TRA-3952 — which books the `lagDenominator` gate ran over, and which it set aside, by name. */
  lagDenominatorScope: LiveNavLagDenominatorScope;
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
  /**
   * TRA-3450 — the per-live-book pair census behind the `lagDenominator` axis. Written into
   * every row so "the tripwire had nothing to grade that day" is recoverable a year later
   * WITHOUT the payload, which is the same durability argument as TRA-3449 criterion 2.
   */
  lagDenominatorBooks: LiveNavBookDenominator[];
  /** The operands verbatim, so a row is auditable a year later without re-fetching. */
  observed: {
    livePriorOptionsLagOk: boolean | null | undefined;
    liveBookCount: number | null | undefined;
    liveGradeableBookCount: number | null | undefined;
    liveEodRowsPresentOk: boolean | null | undefined;
    liveEodTailMaxStaleSessions: number | null | undefined;
    /**
     * TRA-3450 — the fleet sum of {@link LiveNavBookDenominator.postOnsetTripCapablePairs}.
     * `null` when the census could not be computed at all (no readable `engines`). Recorded as
     * a scalar as well as per book so a one-line query answers "was there anything to grade".
     */
    postOnsetTripCapablePairs: number | null;
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

/**
 * TRA-4001 — UTC ms of an ET wall-clock instant on an ET calendar day (DST-aware).
 *
 * Solved by fixed point rather than by a guessed offset: take the EDT reading, ask the
 * shared offset function what the offset actually is AT that instant, and re-derive. The
 * two agree everywhere except inside the DST transition hour, where the second pass lands
 * on the correct side.
 */
export function liveNavEtWallClockToUtcMs(etDay: string, hour: number, minute = 0): number {
  const [y, m, d] = etDay.split('-').map(Number);
  const naive = Date.UTC(y!, m! - 1, d!, hour, minute);
  let guess = naive - getEasternUtcOffset(naive + 4 * 3_600_000) * 3_600_000;
  const off = getEasternUtcOffset(guess);
  guess = naive - off * 3_600_000;
  return guess;
}

/** TRA-4001 — the instant the writer is SCHEDULED for on an ET session day (21:00 ET). */
export function liveNavWriterExpectedAtMs(etDay: string): number {
  return liveNavEtWallClockToUtcMs(etDay, LIVE_NAV_WRITER_EXPECTED_ET_HOUR, 0);
}

/**
 * TRA-4001 — the instant a session's row falls DUE: scheduled slot plus grace. Before this
 * a session with no row is `pending`; at or after it, `missing`.
 */
export function liveNavWriterDueAtMs(etDay: string): number {
  return liveNavWriterExpectedAtMs(etDay) + LIVE_NAV_WRITER_DUE_GRACE_MS;
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
 * The cent tolerance the endpoint itself compares P&L at (`PNL_RECONCILE_TOLERANCE_USD`).
 * Duplicated rather than imported so this module keeps zero coupling to the computation it
 * audits — importing the constant would mean a future edit to the thing under test silently
 * moves the auditor's own threshold with it.
 */
const CENT_TOLERANCE_USD = 0.01;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * TRA-3450 — recompute, per live book, how many pairs the lag tripwire could possibly have
 * fired on since that book's live-options onset.
 *
 * A pair `(t-1, t)` is TRIP-CAPABLE when `stockDaily[t] != 0` and `optionsDaily[t-1] != 0`:
 * those are the two operands of `round(stockDaily[t],2) === round(optionsDaily[t-1],2)`, and
 * with either at zero the predicate has no failing state on that pair. POST-ONSET adds
 * `date[t] >= liveOptionsOnsetDate` — a trip before the book held any live option cannot be a
 * real-money NAV overstatement, which is the same onset scoping TRA-2831 forced on the credit
 * metrics after 100% of a "live" numerator turned out to predate onset.
 *
 * Returns `null` when `engines` is unreadable — the caller must grade that `blind`, never
 * vacuous. "The census said zero" and "there was no census" are not the same reading, which is
 * this ticket's own lesson applied one level down.
 */
export function computeLiveLagDenominators(payload: unknown): LiveNavBookDenominator[] | null {
  const p = (typeof payload === 'object' && payload !== null ? payload : null) as Record<
    string,
    unknown
  > | null;
  if (p === null || !Array.isArray(p.engines)) return null;

  const out: LiveNavBookDenominator[] = [];
  for (const e of p.engines) {
    if (typeof e !== 'object' || e === null) continue;
    const eng = e as Record<string, unknown>;
    if (eng.mode !== 'live') continue;
    const username = typeof eng.username === 'string' ? eng.username : '(unnamed)';
    const onsetDate = typeof eng.liveOptionsOnsetDate === 'string' ? eng.liveOptionsOnsetDate : null;
    const days = Array.isArray(eng.days)
      ? eng.days.filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      : [];

    let totalPairs = 0;
    let tripCapablePairs = 0;
    let postOnsetTripCapablePairs = 0;
    let postOnsetTripPairs = 0;
    // TRA-3952 — counted over EVERY row (the pair loop below starts at 1), so a lone first
    // row carrying options P&L is not missed by the scope guard.
    let optionsPnlRows = 0;
    for (const d of days) {
      const o = num(d.optionsDaily);
      if (o !== null && Math.abs(o) > CENT_TOLERANCE_USD) optionsPnlRows += 1;
    }
    for (let i = 1; i < days.length; i += 1) {
      const cur = days[i]!;
      const prev = days[i - 1]!;
      totalPairs += 1;
      const stock = num(cur.stockDaily);
      const priorOptions = num(prev.optionsDaily);
      // A row missing either operand is NOT trip-capable and is NOT counted as evidence —
      // it is the absent-field case, and counting it would inflate the very denominator
      // whose emptiness is the finding.
      if (stock === null || priorOptions === null) continue;
      if (Math.abs(stock) <= CENT_TOLERANCE_USD || Math.abs(priorOptions) <= CENT_TOLERANCE_USD) {
        continue;
      }
      tripCapablePairs += 1;
      const date = typeof cur.date === 'string' ? cur.date : null;
      // No onset ⇒ no post-onset pair can exist. ISO dates compare correctly as strings.
      if (onsetDate === null || date === null || date < onsetDate) continue;
      postOnsetTripCapablePairs += 1;
      if (Math.abs(stock - priorOptions) <= CENT_TOLERANCE_USD) postOnsetTripPairs += 1;
    }

    const postOnsetEligiblePairs = Array.isArray(eng.priorOptionsLagEligibleDates)
      ? eng.priorOptionsLagEligibleDates.filter(
          (d): d is string => typeof d === 'string' && onsetDate !== null && d >= onsetDate,
        ).length
      : 0;

    out.push({
      username,
      onsetDate,
      totalPairs,
      tripCapablePairs,
      postOnsetTripCapablePairs,
      postOnsetTripPairs,
      postOnsetEligiblePairs,
      // TRA-4000 — `optionsPnlRows == 0` ⇒ no pair has a non-zero prior `optionsDaily` ⇒
      // `postOnsetTripCapablePairs == 0`, so an `onset_unrealized` book is vacuous BY
      // CONSTRUCTION and the reason names the window rather than the generic zero.
      vacuousReason:
        postOnsetTripCapablePairs > 0
          ? null
          : onsetDate === null
            ? 'no_live_options_onset'
            : optionsPnlRows === 0
              ? 'onset_present_no_realized_options'
              : 'no_post_onset_trip_capable_pairs',
      optionsPnlRows,
      // Exhaustive over (onset?, realized?) — see the `lagScope` doc. `graded` requires BOTH,
      // so `lagScope === 'graded'` ⇒ `optionsPnlRows > 0` cannot be violated by any input.
      lagScope:
        onsetDate !== null
          ? optionsPnlRows > 0
            ? 'graded'
            : 'onset_unrealized'
          : optionsPnlRows > 0
            ? 'suspect_onset_derivation'
            : 'excluded_no_onset',
    });
  }
  return out;
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
  const vacuous = (reason: string): LiveNavAxis => ({ status: 'vacuous', reason });

  const denominators = payloadUsable ? computeLiveLagDenominators(p) : null;

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
  else if (gradeableRaw.value < bookCountRaw.value) {
    // TRA-3711 — name the CLASS of the hole, not just its size. `no_eligible_dates` is a
    // structural condition of the book (live, never filled, no live-options onset) and clears
    // by itself; `ungraded` is a defect in the grader and does not. A count alone cannot tell
    // a consumer which repair applies, which is how this axis came to pin an alarm nobody
    // could act on. The books themselves stay in `ungradedBooks`, named.
    const classes = [...new Set(ungradedBooks.map((b) => b.reason))].sort();
    coverage = blind(
      `ungraded_live_books:${gradeableRaw.value}_of_${bookCountRaw.value}` +
        (classes.length > 0 ? `:${classes.join('+')}` : ''),
    );
  } else coverage = pass();

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

  // ── TRA-3450 — did the lag axis have anything to grade? ───────────────────
  //
  // Graded PER BOOK: any live book at zero makes the axis vacuous. A fleet SUM would let one
  // busy book manufacture cover for a silent one, which is the same offender-only-cohort
  // mistake `liveGradeableBookCount` exists to catch one field over.
  //
  // TRA-3952 — the per-book gate runs over books that HAVE a live-options onset. A live book
  // that has never opened an option and has never booked options P&L (v0nni: 13 rows, every
  // one `stockDaily: 0` AND `optionsDaily: 0`) is not a silent book being covered for — it
  // has nothing the predicate could leak. Holding the axis `vacuous` on it gave the axis no
  // reachable `pass` off ANY repair and no terminating event anyone on the board controls.
  // Two things keep this from being the silent-exclusion mistake one field over:
  //   1. the set-aside books are PUBLISHED by name on every row (`lagDenominatorScope`), and
  //      named in the reason string whenever the axis is not `pass`;
  //   2. a no-onset book that DOES carry options P&L is a contradicted onset operand — a
  //      grader defect, not an absence of evidence — and grades the axis `blind`, which
  //      outranks `vacuous` and is never green.
  // An empty graded cohort (every live book no-onset) is still `vacuous`, never `pass`: the
  // ANY-gate over nothing is the `every`-on-empty green this module exists to refuse.
  // TRA-4000 — a book with an onset but nothing realized (`onset_unrealized`) is IN the gate
  // alongside `graded`: it holds the axis `vacuous` exactly as it did when it read `graded`
  // (its pair count is 0 by construction), so naming it changes the row and the reason string
  // and NOTHING about the axis. That is the point: the fix must be observable without being
  // able to move the axis toward `pass` — "DO NOT resolve this by making the axis go
  // non-vacuous" (TRA-4000). It is NOT set aside like `excluded_no_onset`: there is live
  // money at risk in an open option, and the window ends on an event the book itself
  // produces (its first live close), so holding `vacuous` on it terminates on its own.
  let lagDenominator: LiveNavAxis;
  const gradedBooks = (denominators ?? []).filter((b) => b.lagScope === 'graded');
  const onsetUnrealizedBooks = (denominators ?? []).filter((b) => b.lagScope === 'onset_unrealized');
  const excludedBooks = (denominators ?? []).filter((b) => b.lagScope === 'excluded_no_onset');
  const suspectBooks = (denominators ?? []).filter((b) => b.lagScope === 'suspect_onset_derivation');
  const gateBooks = [...gradedBooks, ...onsetUnrealizedBooks];
  const emptyBooks = gateBooks.filter((b) => b.vacuousReason !== null);
  const names = (bs: LiveNavBookDenominator[]): string => bs.map((b) => b.username).join(',');
  // The set-aside and transitional buckets ride every non-pass reason, by name.
  const excludedSuffix =
    (excludedBooks.length > 0 ? `;excluded_no_onset:${names(excludedBooks)}` : '') +
    (onsetUnrealizedBooks.length > 0 ? `;onset_unrealized:${names(onsetUnrealizedBooks)}` : '');
  if (!payloadUsable) lagDenominator = blind('payload_unusable');
  else if (disowned('livePriorOptionsLagOk')) lagDenominator = blind('operand_declared_ungradeable');
  // A census we could not take is BLIND, never vacuous — see `computeLiveLagDenominators`.
  else if (denominators === null) lagDenominator = blind('engines_unreadable');
  else if (denominators.length === 0) lagDenominator = blind('empty_live_cohort');
  else if (suspectBooks.length > 0)
    lagDenominator = blind(`onset_derivation_suspect:${names(suspectBooks)}${excludedSuffix}`);
  else if (gateBooks.length === 0)
    lagDenominator = vacuous(`no_live_book_with_options_onset${excludedSuffix}`);
  else if (emptyBooks.length > 0)
    lagDenominator = vacuous(
      `no_post_onset_trip_capable_pairs:${emptyBooks.map((b) => `${b.username}=${b.vacuousReason}`).join(',')}${excludedSuffix}`,
    );
  // A post-onset trip that the served scalar did NOT report is a contradiction between the
  // endpoint's verdict and its own day rows. Louder than vacuous: it means the tripwire had
  // something to grade and graded it wrong.
  else if (gradedBooks.some((b) => b.postOnsetTripPairs > 0) && lagRaw.value !== false)
    lagDenominator = fail(`post_onset_trip_not_reported_by_scalar${excludedSuffix}`);
  else lagDenominator = pass();

  const lagDenominatorScope: LiveNavLagDenominatorScope = {
    graded: gradedBooks.map((b) => b.username),
    excludedNoOnset: excludedBooks.map((b) => b.username),
    suspectOnset: suspectBooks.map((b) => b.username),
    onsetUnrealized: onsetUnrealizedBooks.map((b) => b.username),
  };

  const axes = {
    lag: { ...lag, kind: liveNavAxisKind('lag') },
    coverage: { ...coverage, kind: liveNavAxisKind('coverage') },
    eodRows: { ...eodRows, kind: liveNavAxisKind('eodRows') },
    eodTail: { ...eodTail, kind: liveNavAxisKind('eodTail') },
    lagDenominator: { ...lagDenominator, kind: liveNavAxisKind('lagDenominator') },
  };
  // `fail` > `blind` > `vacuous` > `clean`. `vacuous` must outrank `clean` (TRA-3450: never
  // folded into green) and must NOT outrank `blind` — an unreadable operand is the worse
  // state, because it could be hiding either of the other two.
  const verdict = verdictFromAxes(axes);

  return {
    verdict,
    // TRA-3711 — `alarm` is now the TRIP channel only. It was `verdict !== 'clean'`, which
    // pinned it true on every session a live book was structurally ungradeable.
    ...signalsFromAxes(axes),
    axes,
    lagBooks,
    ungradedBooks,
    eodRowMissingBooks,
    eodTailStaleBooks,
    interiorAbsentBooks,
    lagDenominatorBooks: denominators ?? [],
    lagDenominatorScope,
    observed: {
      livePriorOptionsLagOk: lagRaw.value,
      liveBookCount: bookCountRaw.value,
      liveGradeableBookCount: gradeableRaw.value,
      liveEodRowsPresentOk: eodRowsRaw.value,
      liveEodTailMaxStaleSessions: eodTailRaw.value,
      postOnsetTripCapablePairs:
        denominators === null
          ? null
          : denominators.reduce((n, b) => n + b.postOnsetTripCapablePairs, 0),
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

/**
 * TRA-4001 — the persisted observation-start marker, as stored in the sidecar.
 *
 * `firstBootTs` is the instant this ledger FIRST hydrated against this data dir, and it is
 * never moved forward: a later boot only bumps `boots` / `lastBootTs`. That is what makes
 * a multi-day outage read as `missing` rather than as a fresh start — the marker belongs to
 * the data dir, not to the process (an ephemeral dir loses it, and `durability.ephemeral`
 * says so).
 */
export interface LiveNavObservationMarker {
  kind: 'observation_start';
  firstBootTs: number;
  firstBootEtDay: string;
  lastBootTs: number;
  /** Hydrates seen. `>= 2` with `hydratedRecords >= 1` is a production proof rows survive a restart. */
  boots: number;
}

let observationMarker: LiveNavObservationMarker | null = null;
let observationMarkerError: string | null = null;
/** Test seam only — see {@link seedLiveNavObservationStartForTest}. */
let observationStartOverride: number | null = null;

export function liveNavTripwireLogPath(dir: string): string {
  return join(dir, LIVE_NAV_TRIPWIRE_FILENAME);
}

export function liveNavObservationStartPath(dir: string): string {
  return join(dir, LIVE_NAV_OBSERVATION_START_FILENAME);
}

export function clearLiveNavTripwire(): void {
  rows.clear();
  dataDir = null;
  appendErrors = 0;
  lastAppendError = null;
  hydratedRecords = 0;
  observationMarker = null;
  observationMarkerError = null;
  observationStartOverride = null;
}

/** Test seam — inject rows without touching disk. */
export function seedLiveNavTripwireForTest(recs: LiveNavTripwireRecord[]): void {
  for (const r of recs) rows.set(r.etDay, r);
}

/**
 * Test seam — pin the observation start without a hydrate or a row. Takes part in the
 * same MIN fold as the marker and the first row, so it can only move the start EARLIER.
 */
export function seedLiveNavObservationStartForTest(ts: number | null): void {
  observationStartOverride = ts;
}

function validMarker(v: unknown): LiveNavObservationMarker | null {
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Record<string, unknown>;
  if (m.kind !== 'observation_start') return null;
  if (typeof m.firstBootTs !== 'number' || !Number.isFinite(m.firstBootTs)) return null;
  return {
    kind: 'observation_start',
    firstBootTs: m.firstBootTs,
    firstBootEtDay:
      typeof m.firstBootEtDay === 'string' ? m.firstBootEtDay : liveNavEtDay(m.firstBootTs),
    lastBootTs: typeof m.lastBootTs === 'number' && Number.isFinite(m.lastBootTs) ? m.lastBootTs : m.firstBootTs,
    boots: typeof m.boots === 'number' && Number.isFinite(m.boots) && m.boots >= 1 ? Math.floor(m.boots) : 1,
  };
}

/**
 * TRA-4001 — load-or-create the observation-start marker on hydrate.
 *
 * Memory first, disk best-effort, same discipline as `appendRow`: a sidecar that cannot be
 * written must not cost the boot, and the in-memory marker still pins the start for this
 * process's lifetime. `observationMarkerError` is published under `observation` so a
 * memory-only marker cannot pass for a durable one.
 */
function loadOrCreateObservationMarker(dir: string, now: number): void {
  const path = liveNavObservationStartPath(dir);
  let existing: LiveNavObservationMarker | null = null;
  try {
    existing = validMarker(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    existing = null;
  }
  const next: LiveNavObservationMarker = existing
    ? { ...existing, lastBootTs: now, boots: existing.boots + 1 }
    : {
        kind: 'observation_start',
        firstBootTs: now,
        firstBootEtDay: liveNavEtDay(now),
        lastBootTs: now,
        boots: 1,
      };
  observationMarker = next;
  observationMarkerError = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the write below surfaces it
  }
  try {
    writeFileSync(path, JSON.stringify(next) + '\n', 'utf8');
  } catch (err) {
    observationMarkerError = err instanceof Error ? err.message : String(err);
    log.warn('live-nav-tripwire observation-start marker write failed (TRA-4001)', {
      reason: observationMarkerError,
    });
  }
}

/** TRA-4001 — where the effective observation start came from. */
export type LiveNavObservationStartSource = 'marker' | 'first_row' | 'test';

export interface LiveNavObservationStart {
  /** The EARLIEST of the marker's first boot and the ledger's first row. */
  startTs: number;
  startEtDay: string;
  source: LiveNavObservationStartSource;
  /** The persisted marker, or `null` when no hydrate has run in this process. */
  marker: LiveNavObservationMarker | null;
  /** Non-null when the marker exists in memory but could not be written to disk. */
  markerError: string | null;
  /** Earliest row's `etDay`, or `null` on an empty ledger. */
  firstRowEtDay: string | null;
}

/**
 * TRA-4001 — resolve the observation start. `null` only when NOTHING pins it: no hydrate
 * has run, the ledger is empty, and no test seam is set. That state is an instrument hole
 * (nothing can be measured against it) and the summary grades it `blind`, never clean.
 */
export function resolveLiveNavObservationStart(): LiveNavObservationStart | null {
  let best: { ts: number; source: LiveNavObservationStartSource } | null = null;
  const consider = (ts: number | null | undefined, source: LiveNavObservationStartSource): void => {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
    if (best === null || ts < best.ts) best = { ts, source };
  };
  consider(observationMarker?.firstBootTs, 'marker');
  let firstRow: LiveNavTripwireRecord | null = null;
  for (const r of rows.values()) if (firstRow === null || r.ts < firstRow.ts) firstRow = r;
  consider(firstRow?.ts, 'first_row');
  consider(observationStartOverride, 'test');
  if (best === null) return null;
  const chosen = best as { ts: number; source: LiveNavObservationStartSource };
  return {
    startTs: chosen.ts,
    startEtDay: liveNavEtDay(chosen.ts),
    source: chosen.source,
    marker: observationMarker,
    markerError: observationMarkerError,
    firstRowEtDay: firstRow === null ? null : (firstRow as LiveNavTripwireRecord).etDay,
  };
}

function validRecord(v: unknown): LiveNavTripwireRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (r.kind !== 'assert') return null;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null;
  if (typeof r.etDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.etDay)) return null;
  // `vacuous` is TRA-3450's persisted state. Rows written before it existed carry the other
  // three and hydrate unchanged — their `lagDenominatorBooks` is simply absent, which the
  // summary reports as an unknown census rather than as a zero one.
  if (r.verdict !== 'clean' && r.verdict !== 'blind' && r.verdict !== 'fail' && r.verdict !== 'vacuous') {
    return null;
  }
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
    log.error('LIVE-MONEY NAV TRIPWIRE: FAIL — alarm=true, an assertion TRIPPED (TRA-3449)', {
      etDay,
      driver: rec.driver,
      axes: rec.axes,
      lagBooks: rec.lagBooks,
      eodRowMissingBooks: rec.eodRowMissingBooks,
      eodTailStaleBooks: rec.eodTailStaleBooks,
    });
  } else if (rec.verdict === 'vacuous') {
    // WARN, not INFO. The tripwire ran and had nothing to grade — which reads exactly like a
    // clean day to anyone watching the scalar, and is the whole of TRA-3450.
    log.warn('live-money NAV tripwire: VACUOUS — ran, graded NOTHING (TRA-3450)', {
      etDay,
      lagDenominatorBooks: rec.lagDenominatorBooks,
      postOnsetTripCapablePairs: rec.observed.postOnsetTripCapablePairs,
    });
  } else if (rec.verdict === 'blind') {
    // WARN, and `alarm` is FALSE here (TRA-3711). Blind is a hole in the instrument, not a
    // trip; it rides `degraded`/`attention`. A blind row that kept raising the trip channel
    // is what made this alarm unreadable for as long as `v0nni` has no onset.
    log.warn('live-money NAV tripwire: BLIND — degraded, not tripped (TRA-3449/TRA-3711)', {
      etDay,
      driver: rec.driver,
      degraded: rec.degraded,
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

  // TRA-4001 — pin the observation start. AFTER the rows so a ledger copied in from an older
  // deployment keeps its own (earlier) start via the MIN fold in `resolveLiveNavObservationStart`.
  loadOrCreateObservationMarker(dir, now);

  return { days: rows.size, records: kept.length };
}

// ── Health summary ───────────────────────────────────────────────────────────

/**
 * TRA-4001 — which coverage bucket a day sits in. The four session buckets PARTITION the
 * window's sessions; `non_session` is a weekend/holiday and carries no expectation.
 *
 * - `recorded`     — a row exists (any verdict).
 * - `missing`      — DUE, inside the observation window, and no row. THE writer-down state.
 * - `pending`      — inside the observation window but the writer slot (+ grace) has not
 *                    passed yet. Today, before 21:30 ET. Never a miss.
 * - `not_measured` — the writer slot precedes the observation start; the ledger did not
 *                    exist to observe it. Neither clean nor failed, and never silent.
 */
export type LiveNavDayBucket = 'recorded' | 'missing' | 'pending' | 'not_measured' | 'non_session';

/** A day in the window that SHOULD have a row. `missing` is the whole point of this module. */
export interface LiveNavDaySummary extends LiveNavSignals {
  etDay: string;
  marketDay: boolean;
  /**
   * `missing` — the assertion was DUE and did not run. Distinguishable from `clean`.
   * TRA-4001 — `pending` (not yet due) and `not_measured` (pre-observation) are their own
   * verdicts so neither can read as a miss OR as a clean.
   */
  verdict: LiveNavVerdict | 'missing' | 'pending' | 'not_measured';
  /** TRA-4001 — the coverage bucket, published so the partition is checkable per day. */
  bucket: LiveNavDayBucket;
  /** TRA-4001 — ISO instant the session's row falls due; `null` on a non-session. */
  dueAt: string | null;
  source: 'served' | 'unreachable' | null;
  axes: LiveNavTripwireRecord['axes'] | null;
  lagBooks: Array<{ username: string; dates: string[] }>;
  ungradedBooks: LiveNavUngradedBook[];
  /**
   * TRA-3450 — fleet post-onset trip-capable pair count on that day. `null` on a `missing`
   * day and on a pre-TRA-3450 row (census not taken vs census taken and empty).
   */
  postOnsetTripCapablePairs: number | null;
}

/**
 * TRA-3711 — the per-class session split behind the window verdict.
 *
 * Published because the fix's own evidence bar demands it: an INVARIANT TOTAL with a FLIPPED
 * CLASS SPLIT is the shape a "fix" takes when it has merely relabelled the same rows. The
 * three classes partition the sessions exactly — `sessionsTrip + sessionsDegradedOnly +
 * sessionsClean === coverage.marketDaysExpected` — so the split is checkable, not asserted.
 */
export interface LiveNavSignalClasses {
  /** Sessions whose row TRIPPED an assertion (`verdict: 'fail'`). The number that must page. */
  sessionsTrip: number;
  /** Sessions that were degraded (`blind` / `vacuous` / `missing`) with NO trip. */
  sessionsDegradedOnly: number;
  /** Sessions with a graded, fully passing row. */
  sessionsClean: number;
  /** `sessionsTrip + sessionsDegradedOnly` — what the PRE-TRA-3711 `alarm` counted. */
  sessionsAttention: number;
}

export interface LiveNavTripwireSummary extends LiveNavSignals {
  /** `fail` if ANY market day in the window failed; else `blind` if any blind/missing; else `clean`; `null` on an empty window. */
  verdict: LiveNavVerdict | null;
  /**
   * TRA-3711 — the class split behind `verdict`. Read this before quoting `alarm`: the whole
   * window can be `attention: true` at 0 trips.
   */
  signalClasses: LiveNavSignalClasses;
  /** Newest first. */
  byDay: LiveNavDaySummary[];
  coverage: {
    /**
     * TRA-4001 — names the denominator so a consumer cannot mistake it for the calendar
     * count it used to be.
     */
    denominator: 'due_sessions_since_observation_start';
    /** NYSE sessions in the CALENDAR window, from the independent calendar — not from the rows. */
    marketDaysInWindow: number;
    /**
     * Sessions that OWED a row: `marketDaysRecorded + marketDaysMissing.length`. Before
     * TRA-4001 this was the calendar count, which counted sessions the ledger never
     * existed for and today's not-yet-due session as writer failures.
     */
    marketDaysExpected: number;
    /** Sessions with a row of any verdict. */
    marketDaysRecorded: number;
    /** DUE sessions since observation start with NO row. THE metric TRA-3449 exists to publish. */
    marketDaysMissing: string[];
    /** TRA-4001 — sessions inside the observation window whose row is not yet due. Newest first. */
    marketDaysPending: string[];
    /** TRA-4001 — sessions the ledger did not exist to observe. Newest first. A named bucket, never dropped. */
    marketDaysNotMeasured: string[];
    /** `marketDaysRecorded / marketDaysExpected`, or `null` when nothing was owed. */
    realizedCoverage: number | null;
  };
  /**
   * TRA-4001 — the observation start the coverage axis denominates from. `null` when nothing
   * pins it (no hydrate, no row), in which case the window grades `blind` /
   * `no_observation_start` — an instrument with no start cannot report coverage.
   */
  observation: LiveNavObservationStart | null;
  latest: LiveNavTripwireRecord | null;
  /** Most recent day whose verdict was `fail`, or null. */
  lastFailDay: string | null;
  /**
   * Consecutive most-recent DUE sessions with no row. >0 means the writer is down NOW.
   * TRA-4001 — a `pending` session is skipped over, not counted and not a break; a
   * `not_measured` one ends the run.
   */
  consecutiveMissingSessions: number;
  /**
   * TRA-3450 — the vacuity record. Separate from `coverage`: coverage answers "did the check
   * run", this answers "did it have anything to grade when it did". A window can be 100%
   * covered and 100% vacuous at the same time, which is exactly the state on 2026-08-13.
   */
  vacuity: {
    /** Sessions in the window whose verdict was `vacuous`. */
    sessionsVacuous: number;
    /**
     * Sessions whose row was graded (any verdict) AND carried a non-empty post-onset
     * trip-capable census. THE number to quote when claiming the tripwire is watching.
     */
    sessionsWithTripCapableEvidence: number;
    /** Consecutive most-recent GRADED sessions with a zero/absent census. */
    consecutiveVacuousSessions: number;
    /** Latest row's per-book census, or `[]` on a pre-TRA-3450 / absent row. */
    latestDenominators: LiveNavBookDenominator[];
    /** Live books at zero on the latest row, with the reason. */
    vacuousBooks: Array<{ username: string; reason: string }>;
    /**
     * TRA-3952 — the latest row's gate scoping. `excludedNoOnset` is the named bucket of
     * live books outside the `lagDenominator` gate; `null` on a pre-TRA-3952 row, whose gate
     * ran cohort-complete and recorded no scope.
     */
    latestScope: LiveNavLagDenominatorScope | null;
  };
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
 *
 * TRA-4001 — `nowMs` is the read instant, needed to decide whether a session's row is DUE
 * yet. The window end defaults to its ET day. A test that pins `windowEndEtDay` in the past
 * without `nowMs` sees every session in that window as due, which is the pre-TRA-4001
 * reading for a window that is entirely behind us — the right one.
 */
export function summarizeLiveNavTripwire(
  dayLimit = 45,
  windowEndEtDay?: string,
  nowMs: number = Date.now(),
): LiveNavTripwireSummary {
  const windowEnd = windowEndEtDay ?? liveNavEtDay(nowMs);
  const calendarDays: string[] = [];
  let cursor = windowEnd;
  for (let i = 0; i < dayLimit; i += 1) {
    calendarDays.push(cursor);
    cursor = prevDay(cursor);
  }

  const observation = resolveLiveNavObservationStart();

  const byDay: LiveNavDaySummary[] = calendarDays.map((etDay) => {
    const rec = rows.get(etDay);
    const marketDay = isMarketDayIso(etDay);
    const dueAtMs = marketDay ? liveNavWriterDueAtMs(etDay) : null;
    const dueAt = dueAtMs === null ? null : new Date(dueAtMs).toISOString();
    if (!rec) {
      // TRA-4001 — bucket a rowless session by WHEN it was owed, not merely by whether it
      // was a session. Order matters: a session whose writer slot precedes the observation
      // start is `not_measured` even if it is also long past due — the ledger did not exist
      // to miss it. A session inside the observation window that is not yet due is
      // `pending`. Only a DUE session inside the window is `missing`.
      const bucket: LiveNavDayBucket = !marketDay
        ? 'non_session'
        : observation === null || liveNavWriterExpectedAtMs(etDay) < observation.startTs
          ? 'not_measured'
          : nowMs < (dueAtMs as number)
            ? 'pending'
            : 'missing';
      const missing = bucket === 'missing';
      return {
        etDay,
        marketDay,
        bucket,
        dueAt,
        // A non-session with no row is NOT a miss — the assertion is only expected after
        // the 21:00 archive on a trading day. Folding weekends in would bury a real miss
        // under ~30% expected absence (the TRA-2930 denominator mistake). A pending or
        // pre-observation session is not a miss either, and is not `clean`: it carries its
        // own verdict so it cannot be read as either.
        verdict:
          bucket === 'non_session'
            ? ('clean' as const)
            : bucket === 'missing'
              ? ('missing' as const)
              : bucket === 'pending'
                ? ('pending' as const)
                : ('not_measured' as const),
        // TRA-3711 — a session the writer never reached is a COVERAGE fact, so it rides
        // `degraded`, not `alarm`. It stays just as loud: `attention`, the named
        // `coverage.marketDaysMissing`, `consecutiveMissingSessions` and the route's
        // WRITER DOWN note all still carry it. What it must NOT do is spend the trip
        // channel, because the week TRA-3449 was filed for would then read the same as a
        // real-money NAV overstatement.
        alarm: false,
        degraded: missing,
        attention: missing,
        driver: missing
          ? { axis: 'writer', kind: 'coverage' as const, status: 'blind' as const, reason: 'no_assertion_row' }
          : null,
        source: null,
        axes: null,
        lagBooks: [],
        ungradedBooks: [],
        postOnsetTripCapablePairs: null,
      };
    }
    // Derived from the row's AXES, never from its stored `alarm`. A row written before
    // TRA-3711 carries the old union boolean; reading it back would keep the pinned alarm
    // alive across the very deploy that fixes it.
    const signals = signalsFromAxes(rec.axes as unknown as Record<string, LiveNavAxis>);
    return {
      etDay,
      marketDay,
      bucket: marketDay ? ('recorded' as const) : ('non_session' as const),
      dueAt,
      verdict: rec.verdict,
      ...signals,
      source: rec.source,
      axes: rec.axes,
      lagBooks: rec.lagBooks,
      ungradedBooks: rec.ungradedBooks,
      // `?? null` covers the pre-TRA-3450 row, whose census was never taken. Defaulting it
      // to 0 would back-date a vacuity finding onto days that were never measured for it.
      postOnsetTripCapablePairs: rec.observed?.postOnsetTripCapablePairs ?? null,
    };
  });

  const calendarSessions = byDay.filter((d) => d.marketDay);
  const missing = calendarSessions.filter((d) => d.bucket === 'missing').map((d) => d.etDay);
  const pending = calendarSessions.filter((d) => d.bucket === 'pending').map((d) => d.etDay);
  const notMeasured = calendarSessions.filter((d) => d.bucket === 'not_measured').map((d) => d.etDay);
  const recorded = calendarSessions.filter((d) => d.bucket === 'recorded').length;
  // TRA-4001 — the sessions that OWED a row. Everything below folds over THIS set: a
  // pending or pre-observation session carries no verdict and no signal, so it can neither
  // drag the window red nor pad it green.
  const sessions = calendarSessions.filter((d) => d.bucket === 'recorded' || d.bucket === 'missing');

  // Only owed sessions carry a verdict. `fail` > `blind`/`missing` > `vacuous` > `clean`.
  const anyFail = sessions.some((d) => d.verdict === 'fail');
  const anyBlind = sessions.some((d) => d.verdict === 'blind' || d.verdict === 'missing');
  const anyVacuous = sessions.some((d) => d.verdict === 'vacuous');
  // TRA-4001 — an instrument with NO observation start cannot report coverage at all. That
  // is a hole in the instrument (`blind`), not a clean window and not an empty one.
  const noObservationStart = observation === null && calendarSessions.length > 0;
  const verdict: LiveNavVerdict | null = noObservationStart
    ? 'blind'
    : sessions.length === 0
      ? null
      : anyFail
        ? 'fail'
        : anyBlind
          ? 'blind'
          : anyVacuous
            ? 'vacuous'
            : 'clean';

  // TRA-3711 — the window's channels are the OR of its sessions', so a single tripped
  // session cannot be diluted by 44 clean ones. The driver is the driver of the WORST
  // session, picked by the same status rank, so `driver.axis` names the axis a reader
  // should go look at.
  const windowAlarm = sessions.some((d) => d.alarm);
  const windowDegraded = noObservationStart || sessions.some((d) => d.degraded);
  const windowDriver: LiveNavDriver | null = noObservationStart
    ? { axis: 'writer', kind: 'coverage', status: 'blind', reason: 'no_observation_start' }
    : (sessions
        .map((d) => d.driver)
        .filter((d): d is LiveNavDriver => d !== null)
        .sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0))[0] ?? null);

  const sessionsTrip = sessions.filter((d) => d.alarm).length;
  const sessionsDegradedOnly = sessions.filter((d) => !d.alarm && d.degraded).length;

  // TRA-4001 — newest first over the CALENDAR sessions: a pending session is stepped over
  // (it is not a miss and not evidence of recovery), a recorded one ends the run, and a
  // pre-observation one ends it too — the writer cannot have been down for a session the
  // ledger did not exist for.
  let consecutiveMissing = 0;
  for (const d of calendarSessions) {
    if (d.bucket === 'pending') continue;
    if (d.bucket === 'missing') consecutiveMissing += 1;
    else break;
  }

  const ordered = [...rows.values()].sort((a, b) => b.ts - a.ts);
  const latest = ordered[0] ?? null;

  // TRA-3450 — vacuity is counted over GRADED sessions only. A `missing` session is a coverage
  // fact, already counted above; folding it in here would double-count the same absence under
  // two headings and make "the tripwire had nothing to grade" unreadable.
  const gradedSessions = sessions.filter((d) => d.bucket === 'recorded');
  const sessionsVacuous = gradedSessions.filter((d) => d.verdict === 'vacuous').length;
  const sessionsWithTripCapableEvidence = gradedSessions.filter(
    (d) => (d.postOnsetTripCapablePairs ?? 0) > 0,
  ).length;
  let consecutiveVacuousSessions = 0;
  for (const d of gradedSessions) {
    if ((d.postOnsetTripCapablePairs ?? 0) > 0) break;
    consecutiveVacuousSessions += 1;
  }
  const latestDenominators = latest?.lagDenominatorBooks ?? [];

  return {
    verdict,
    alarm: windowAlarm,
    degraded: windowDegraded,
    attention: windowAlarm || windowDegraded,
    driver: windowDriver,
    signalClasses: {
      sessionsTrip,
      sessionsDegradedOnly,
      // By subtraction, so the three classes PARTITION the sessions by construction and a
      // future fourth day-verdict cannot quietly fall out of the split.
      sessionsClean: sessions.length - sessionsTrip - sessionsDegradedOnly,
      sessionsAttention: sessionsTrip + sessionsDegradedOnly,
    },
    byDay,
    coverage: {
      denominator: 'due_sessions_since_observation_start',
      marketDaysInWindow: calendarSessions.length,
      marketDaysExpected: sessions.length,
      marketDaysRecorded: recorded,
      marketDaysMissing: missing,
      marketDaysPending: pending,
      marketDaysNotMeasured: notMeasured,
      realizedCoverage: sessions.length === 0 ? null : recorded / sessions.length,
    },
    observation,
    latest,
    lastFailDay: sessions.find((d) => d.verdict === 'fail')?.etDay ?? null,
    consecutiveMissingSessions: consecutiveMissing,
    vacuity: {
      sessionsVacuous,
      sessionsWithTripCapableEvidence,
      consecutiveVacuousSessions,
      latestDenominators,
      vacuousBooks: latestDenominators
        .filter((b) => b.vacuousReason !== null)
        .map((b) => ({ username: b.username, reason: b.vacuousReason as string })),
      latestScope: latest?.lagDenominatorScope ?? null,
    },
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
