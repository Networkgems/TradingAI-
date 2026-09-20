// TRA-4748 (parent TRA-4746) — SESSION COVERAGE over the live-enforce-gate
// retained fold.
//
// ── the hole this closes ─────────────────────────────────────────────────────
// `retained.etDays` lists the ET days the ledger recorded a decision on. When a
// day is PRESENT, the payload already separates "evaluated nothing" from
// "refused everything" — `evaluated` vs `blocked`/`blockRate`, per gate, per
// day (TRA-4154). That axis works and this module does not touch it.
//
// When a day is ABSENT, nothing on any published surface distinguishes
//   (a) absent because there was no session (weekend / NYSE closure), from
//   (b) absent because the decision-recording path was dead.
// Those have completely different remedies. TRA-4746 asked the (b) question
// about 2026-09-19, and answering it took a hand-diff of `etDays` against a
// mental calendar — after the question had already reached a board escalation
// (TRA-4742 comment `3ea03fac` §2). The answer was (a): 2026-09-19 was a
// Saturday. The miss direction looks IDENTICAL and is equally live.
//
// ── ⛔ THE COMPARISON IS ONE-DIRECTIONAL. ────────────────────────────────────
// Only **expected-but-absent** is red. **Present-but-not-expected must not be**,
// because the entry-evaluation site does NOT honour the NYSE calendar and never
// claimed to: measured on live bytes, **2026-09-07 is Labor Day**
// (`exchangeClosureName` -> "Labor Day", `resolveSessionDate` -> `non_session`)
// and the retained ledger holds **736 `entry_window` evaluations for it**. A
// symmetric "diff the calendar against the ledger" alarms on every market
// holiday — i.e. it is wrong in both directions at once.
//
// Rejected alternative, recorded so it is not re-proposed: pure weekday
// arithmetic with no calendar import. Its measured false-positive rate over the
// 2026-08-21..2026-09-18 retained window is 0/21 — but only because holidays
// happen to append rows here. It is right by coincidence and breaks the first
// time one does not.
//
// ── rev2 — the MISS direction (CFO `9f20ec40`, QuantTrader `63de41b4`) ───────
// The one-directional rule above is correct and unchanged, but on its own it
// leaves a hole in the other direction, and review caught it: a session is
// always a weekday, so `missingSessions` exempts EVERY market holiday — a
// Thanksgiving on which the recorder was genuinely dead reads byte-identically
// to a healthy one. That is not hypothetical here, because the recorder's
// cadence is WEEKDAY-driven (09-07 above is the proof), so a weekday holiday is
// exactly as much a working day for it as a Tuesday.
//
// The fix is to enumerate on the WEEKDAY set (which strictly contains the
// session set, so it loses nothing) and let the calendar ANNOTATE each absence
// rather than gate the alarm. `darkWeekdayHolidays` is the resulting second
// alarm. It is not the rejected weekday arithmetic re-proposed: it fires only
// while `recorderCadence` — MEASURED off this payload, from whether a
// non-session weekday actually carried rows — says `weekday`, so the "right by
// coincidence" objection is tested every fold instead of being assumed away.
// `gateRosterBoundaries` answers the separate 2026-08-21 finding: the gate
// roster is not fixed across the window (7 changes in 21 days, measured), so
// "gate X evaluated 0" is not a stable predicate over it.
//
// ⚠️ STRICTLY DERIVED, STRICTLY READ-ONLY. Every field below is folded from the
// `etDays` / `byGate` the summary already carries plus the shipped NYSE bundle.
// Nothing on the admission path reads any of it and no gate behaviour changes.

import {
  MARKET_CALENDAR_VERSION,
  resolveSessionDate,
  type SessionResolution,
} from './market-calendar.js';
import type { LiveEnforceGate, LiveEnforceGateSummary } from './live-enforce-gate-ledger.js';

/**
 * Gates whose rows are a SHADOW/counterfactual recorder rather than a decision
 * the live path took. A day on which only these recorded is a day the ledger
 * recorded **zero gate decisions**, which is exactly the TRA-4746 question.
 *
 * ⚠️ Membership here is OPT-IN, and a new gate therefore counts as a decision by
 * default. That is the deliberate direction: the failure this module exists to
 * avoid is manufacturing a false alarm, and an unregistered shadow gate can only
 * make {@link LiveEnforceSessionCoverage.zeroEvaluatedSessions} SMALLER (quieter),
 * never louder. The residual is that a new shadow recorder added without being
 * listed here would mask a genuinely decision-free day — cheap to fix, and it
 * cannot page anyone in the meantime.
 */
const SHADOW_GATES: ReadonlySet<LiveEnforceGate> = new Set<LiveEnforceGate>([
  // TRA-3394 — the counterfactual arm of the entry |delta| ceiling. It records
  // what the ceiling WOULD have said; `blocked` on it refuses nothing.
  'entry_delta_ceiling_shadow',
]);

/**
 * How far back {@link foldSessionCoverage} will walk looking for absent
 * sessions. Retention is 30 days, so this is slack, not a limit that bites in
 * normal operation — it exists because the retention sweep runs on `apply()`,
 * so a store that has recorded NOTHING for a year never prunes and its oldest
 * `etDay` can sit arbitrarily far back. The clamp moves the LOWER bound, so the
 * most recent (and only actionable) days are always scanned.
 */
const MAX_SCAN_DAYS = 400;

/** Steps back from `todayEtDay` before giving up on finding a prior session. */
const MAX_PRIOR_SESSION_STEPS = 30;

/**
 * TRA-4748 — does the ledger's day coverage match the exchange calendar?
 *
 * Read `missingSessions` FIRST: non-empty is the alarm, and it is the only field
 * here that means something is broken.
 */
export interface LiveEnforceSessionCoverage {
  /** The NYSE bundle this fold was computed against (`nyse-2015-2035`). */
  calendarVersion: string;
  /**
   * **THE ALARM.** ET days that `resolveSessionDate` calls a `session` and the
   * ledger has NO row for, ascending. Non-empty ⇒ a trading session elapsed and
   * the decision-recording path wrote nothing — cause (b).
   *
   * Bounded by `[max(min(etDays), lastSessionEtDay - 400d), lastSessionEtDay]`.
   * Empty when `etDays` is empty: with no retained day there is no window to
   * claim a hole inside, and inventing one out of the calendar alone would page
   * on every cold boot.
   *
   * ⛔ The converse is NOT computed. See the one-directional note in the module
   * header — a present day the calendar calls `non_session` (Labor Day
   * 2026-09-07, 736 live `entry_window` rows) is NORMAL and never appears here.
   */
  missingSessions: string[];
  /**
   * ET days the ledger HAS a row for, on which every non-shadow gate evaluated
   * zero. Separates cause (a) from cause (b) on the day it happens rather than
   * retrospectively: the day is present, so it is not a `missingSessions` hole,
   * but nothing decided anything on it either.
   *
   * ⚠️ This is a DIFFERENT question from `evaluated: 0` on one gate, which is
   * ordinary and common (`cost_bar` evaluated 0 on all five of 2026-09-02..08
   * while `entry_window` evaluated 607/671/692/736/1222). It fires only when the
   * whole non-shadow roster is silent.
   */
  zeroEvaluatedSessions: string[];
  /**
   * The most recent `session` ET day STRICTLY BEFORE `todayEtDay`, or `null` if
   * the calendar covers none within 30 days.
   *
   * ⚠️ Strictly before, deliberately: today's session is still in progress, and
   * including it would put the current day in `missingSessions` every single
   * morning before the first candidate reaches a gate. The cost is that a dead
   * Monday raises on Tuesday rather than Monday evening; the alternative is an
   * alarm that cries wolf daily and is therefore read by nobody.
   */
  lastSessionEtDay: string | null;
  /**
   * Sessions strictly after the ledger's most recent DECISION day, up to and
   * including `lastSessionEtDay`. `0` is healthy. Counts sessions, not calendar
   * days, so a normal weekend reads `0` and not `2`.
   *
   * The anchor is the last `etDay` with a non-shadow evaluation — i.e. the last
   * day NOT in `zeroEvaluatedSessions` — not merely the last present day, so a
   * day that recorded only shadow rows cannot mask a stall.
   *
   * `null` ⇒ no retained day carries a decision at all, so there is nothing to
   * count from. That is not "healthy"; the days themselves are listed in
   * `zeroEvaluatedSessions`, or `etDays` is empty.
   */
  sessionsSinceLastDecision: number | null;

  // ── rev2 (TRA-4748, CFO comment `9f20ec40` + QuantTrader comment `63de41b4`) ──
  // Everything below answers the MISS direction. `missingSessions` above keys on
  // `resolveSessionDate === 'session'`, and a session is always a weekday — so it
  // is structurally blind to a Mon-Fri **market holiday** on which the recorder
  // was genuinely dead. The recorder's cadence is weekday-driven, not
  // session-driven (Labor Day 2026-09-07 wrote 2,025 decisions), so that day is
  // exactly as real as a dead Tuesday and nothing above would say a word.

  /**
   * Mon-Fri ET days in the scanned window, and how many of them the ledger has a
   * row for. QuantTrader's ask: the two numbers that turn "is the ledger
   * continuous?" from a hand-diff into a subtraction. Equal ⇒ every weekday in
   * the window recorded something.
   */
  weekdayDaysExpected: number;
  /** @see weekdayDaysExpected */
  weekdayDaysPresent: number;
  /**
   * Every Mon-Fri ET day in the scanned window the ledger has NO row for, each
   * carrying WHY the calendar thinks it is absent. Ascending.
   *
   * - `no_records` — the calendar calls it a `session`. **Red.** This is exactly
   *   {@link missingSessions}, republished here with its reason so one list
   *   answers the whole question; the two are kept in sync by construction and a
   *   test pins `missingSessions ⊆ absentWeekdays`.
   * - `non_session` — a market holiday (or an `uncovered` date outside the
   *   bundle). Silent on its own; promoted to {@link darkWeekdayHolidays} only
   *   when the measured cadence says the recorder should have run anyway.
   *
   * ⚠️ QuantTrader asked for a third value, `pre_wiring`. It is deliberately NOT
   * here: no ABSENT day in the measured window is pre-wiring — absences are
   * weekends. The real 2026-08-21 finding is about a day that is PRESENT with a
   * different gate roster, so it is answered by {@link gateRosterBoundaries}
   * instead, where it can carry which gates actually moved.
   */
  absentWeekdays: LiveEnforceAbsentWeekday[];
  /**
   * Which clock the RECORDER runs on, **measured off this payload** rather than
   * assumed. This is the field that lets the holiday alarm below exist without
   * hard-coding either answer.
   *
   * - `weekday` — at least one non-session weekday is PRESENT with rows, i.e.
   *   the recorder demonstrably ignores the exchange calendar (live: 2026-09-07).
   * - `session` — non-session weekdays appear in the window and are all absent,
   *   i.e. the recorder honours the calendar.
   * - `indeterminate` — the window contains no non-session weekday at all, so
   *   there is no evidence either way. Most 30-day windows land here; between
   *   US market holidays that is the normal reading, not a fault.
   *
   * ⚠️ This is evidence ABOUT the recorder, not a verdict on it. It is derived
   * from at most a handful of days a year and must not be cited as a claim that
   * the pipeline is calendar-aware.
   */
  recorderCadence: 'weekday' | 'session' | 'indeterminate';
  /** The non-session weekdays the {@link recorderCadence} call was made on. */
  cadenceEvidence: {
    /** Non-session weekdays the ledger HAS rows for, ascending. */
    nonSessionWeekdaysPresent: string[];
    /** Non-session weekdays the ledger has NO rows for, ascending. */
    nonSessionWeekdaysAbsent: string[];
  };
  /**
   * **THE SECOND ALARM.** Market holidays that fall on a weekday, have no rows,
   * and land AFTER the most recent holiday that DID record — i.e. days the
   * recorder's own measured cadence says it should have run on and did not.
   *
   * This is the hole the shipped rev1 could not see. `missingSessions` exempts
   * every `non_session` day, so a dead Thanksgiving reads byte-identically to a
   * healthy one; the weekday set strictly contains the session set, so keying the
   * enumeration on Mon-Fri and letting the calendar ANNOTATE (rather than gate)
   * loses nothing and covers that case.
   *
   * ⛔ This does NOT reinstate the rejected "pure weekday arithmetic". That was
   * rejected for being right by coincidence — because holidays *happen* to append
   * rows here. This field MEASURES that coincidence ({@link recorderCadence}) and
   * goes silent the moment it stops holding, so the objection is answered rather
   * than overridden. The one-directional rule is untouched: present-but-not-
   * expected is still never red.
   *
   * ⚠️ Known residual, deliberate. If the recorder is CORRECTLY taught to honour
   * the calendar, the first holiday after that change raises one advisory row
   * here, and goes quiet for good once the last recording holiday ages out of the
   * retained window. A behaviour change in the recorder's cadence is worth one
   * line to a reader, and this instrument blocks no order — see the module header.
   */
  darkWeekdayHolidays: string[];
  /**
   * Days on which the set of gates that recorded ANYTHING differs from the
   * previous retained day. **Read this before quoting any cross-day trend off
   * this funnel** — a gate's `evaluated` is not comparable across one of these.
   *
   * QuantTrader found the 2026-08-21 case: `contract_floor` and `entry_window`
   * both evaluate 0 there while `cost_bar` evaluates 1,562, because that day
   * predates the wiring of the upstream gates. A site-dark test keyed on the
   * largest-denominator gate calls that an outage; it is a schema change.
   *
   * ⚠️ Measured on live bytes 2026-09-20 this fires **7 times in 21 days**, not
   * once — the roster churns far more than the single boundary that prompted it.
   * Two consumers (TRA-4742 §2 and the TRA-4622 `cost_bar` ruling) quoted
   * cross-day trends over exactly this window.
   *
   * ⚠️ A boundary is NOT a defect claim. A genuinely low-volume gate that saw no
   * candidate for a day flips the set without any wiring change (`canary_ceiling`
   * evaluated 5 on 2026-08-21). The field asserts NON-COMPARABILITY and publishes
   * `added`/`removed` so the reader judges which kind it is.
   */
  gateRosterBoundaries: LiveEnforceGateRosterBoundary[];
}

/** One absent Mon-Fri day and the calendar's reason for it. */
export interface LiveEnforceAbsentWeekday {
  etDay: string;
  /** `no_records` is red; `non_session` is a holiday/closure. */
  reason: 'no_records' | 'non_session';
}

/** A day whose recording-gate roster differs from the previous retained day. */
export interface LiveEnforceGateRosterBoundary {
  etDay: string;
  /** Gates that recorded on this day and not the previous one, sorted. */
  added: LiveEnforceGate[];
  /** Gates that recorded on the previous day and not this one, sorted. */
  removed: LiveEnforceGate[];
  /** The gate carrying this day's largest `evaluated`, or `null` if none did. */
  maxEvaluatedGate: LiveEnforceGate | null;
}

/** `YYYY-MM-DD` + n days, UTC-anchored so it is timezone-independent. */
function addDays(dateIso: string, n: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is `YYYY-MM-DD` a Mon-Fri? UTC-anchored: an ET day string names a calendar
 * date, not an instant, so reading its weekday in UTC is exact and cannot drift
 * across a DST boundary the way `new Date(s)` in local time would.
 */
function isWeekday(dateIso: string): boolean {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/**
 * The most recent `session` strictly before `todayEtDay`. `null` when the
 * calendar makes no `session` statement within {@link MAX_PRIOR_SESSION_STEPS}
 * days — which is `uncovered` (outside 2015-2035), not "the market shut for a
 * month", and must not be turned into a verdict.
 */
export function previousSessionEtDay(todayEtDay: string): string | null {
  if (!ISO_DATE.test(todayEtDay)) return null;
  for (let i = 1; i <= MAX_PRIOR_SESSION_STEPS; i++) {
    const d = addDays(todayEtDay, -i);
    if (resolveSessionDate(d) === 'session') return d;
  }
  return null;
}

/**
 * TRA-4748 — fold {@link LiveEnforceSessionCoverage} from the retained day list
 * and the retained per-gate roll. **Pure**: no store read, no clock read, no IO.
 * `todayEtDay` is passed in so the caller's single `etDateString(now)` is the
 * one clock read on this route.
 *
 * @param etDays  `retained.etDays` — ascending, days the ledger has rows for.
 * @param byGate  `retained.byGate` — each gate's `byEtDay` roll carries one row
 *                per entry in `etDays` (TRA-4154 guarantees the length), so the
 *                per-day evaluation totals are readable without touching the store.
 */
export function foldSessionCoverage(
  etDays: readonly string[],
  byGate: readonly LiveEnforceGateSummary[],
  todayEtDay: string,
): LiveEnforceSessionCoverage {
  const present = new Set(etDays);
  const lastSessionEtDay = previousSessionEtDay(todayEtDay);

  // ── per-day non-shadow evaluation totals ───────────────────────────────────
  const decisionsByDay = new Map<string, number>();
  for (const d of etDays) decisionsByDay.set(d, 0);
  for (const g of byGate) {
    if (SHADOW_GATES.has(g.gate)) continue;
    for (const row of g.byEtDay) {
      // Defensive: only fold days the summary claims to retain. A roll row for a
      // day outside `etDays` would otherwise invent a coverage day.
      if (!decisionsByDay.has(row.etDay)) continue;
      decisionsByDay.set(row.etDay, decisionsByDay.get(row.etDay)! + row.evaluated);
    }
  }
  const zeroEvaluatedSessions = [...etDays].filter((d) => decisionsByDay.get(d) === 0).sort();

  // ── expected-but-absent ────────────────────────────────────────────────────
  // ONE walk over the scanned window produces both the session-keyed alarm
  // (rev1) and the weekday-keyed annotation layer (rev2), so the two can never
  // disagree about which days they looked at.
  const missingSessions: string[] = [];
  const absentWeekdays: LiveEnforceAbsentWeekday[] = [];
  let weekdayDaysExpected = 0;
  let weekdayDaysPresent = 0;
  const nonSessionWeekdaysPresent: string[] = [];
  const nonSessionWeekdaysAbsent: string[] = [];
  if (etDays.length > 0 && lastSessionEtDay !== null) {
    const earliestRetained = [...etDays].sort()[0]!;
    const clamp = addDays(lastSessionEtDay, -MAX_SCAN_DAYS);
    const from = earliestRetained < clamp ? clamp : earliestRetained;
    for (let d = from; d <= lastSessionEtDay; d = addDays(d, 1)) {
      // ⛔ `=== 'session'` and nothing else on the ALARM. `non_session` (weekend
      // or closure) and `uncovered` (outside the bundle) are both SILENT there —
      // an absent day the calendar has no opinion about is not evidence of
      // anything. The weekday axis below records them without alarming.
      const r: SessionResolution = resolveSessionDate(d);
      const here = present.has(d);
      if (isWeekday(d)) {
        weekdayDaysExpected++;
        if (here) weekdayDaysPresent++;
        if (r !== 'session') (here ? nonSessionWeekdaysPresent : nonSessionWeekdaysAbsent).push(d);
        if (!here) absentWeekdays.push({ etDay: d, reason: r === 'session' ? 'no_records' : 'non_session' });
      }
      if (!here && r === 'session') missingSessions.push(d);
    }
  }

  // ── which clock is the RECORDER on? ────────────────────────────────────────
  // Measured, never assumed. Presence of rows on a non-session weekday is the
  // only positive evidence available, so it wins: absence alone is what the
  // holiday alarm is trying to interpret and cannot also be its own premise.
  const recorderCadence: LiveEnforceSessionCoverage['recorderCadence'] =
    nonSessionWeekdaysPresent.length > 0
      ? 'weekday'
      : nonSessionWeekdaysAbsent.length > 0
        ? 'session'
        : 'indeterminate';
  // A dark holiday must post-date the evidence that the recorder runs on
  // holidays at all; an absent one BEFORE that evidence is the recorder changing
  // TOWARDS weekday cadence, which is not a fault.
  const lastRecordingHoliday = nonSessionWeekdaysPresent[nonSessionWeekdaysPresent.length - 1];
  const darkWeekdayHolidays =
    recorderCadence === 'weekday'
      ? nonSessionWeekdaysAbsent.filter((d) => d > lastRecordingHoliday!)
      : [];

  // ── gate-roster boundaries ────────────────────────────────────────────────
  // Which gates recorded at all, per day. The identity of that set — not any
  // gate's count — is what makes two days comparable, and it is NOT fixed across
  // the retained window (measured: 7 changes in 21 days on live bytes).
  const gateRosterBoundaries: LiveEnforceGateRosterBoundary[] = [];
  const orderedDays = [...etDays].sort();
  let priorRoster: string[] | null = null;
  for (const d of orderedDays) {
    const recording: LiveEnforceGate[] = [];
    let maxEvaluatedGate: LiveEnforceGate | null = null;
    let maxEvaluated = 0;
    for (const g of byGate) {
      const row = g.byEtDay.find((r) => r.etDay === d);
      if (!row || row.evaluated <= 0) continue;
      recording.push(g.gate);
      if (row.evaluated > maxEvaluated) {
        maxEvaluated = row.evaluated;
        maxEvaluatedGate = g.gate;
      }
    }
    recording.sort();
    if (priorRoster !== null && recording.join(',') !== priorRoster.join(',')) {
      const prev = new Set(priorRoster);
      const now = new Set<string>(recording);
      gateRosterBoundaries.push({
        etDay: d,
        added: recording.filter((g) => !prev.has(g)),
        removed: (priorRoster as LiveEnforceGate[]).filter((g) => !now.has(g)),
        maxEvaluatedGate,
      });
    }
    priorRoster = recording;
  }

  // ── sessions elapsed since the last day that decided anything ─────────────
  let sessionsSinceLastDecision: number | null = null;
  const decisionDays = [...etDays].filter((d) => (decisionsByDay.get(d) ?? 0) > 0).sort();
  const lastDecisionDay = decisionDays.length > 0 ? decisionDays[decisionDays.length - 1]! : null;
  if (lastDecisionDay !== null && lastSessionEtDay !== null) {
    let n = 0;
    for (
      let d = addDays(lastDecisionDay, 1), i = 0;
      d <= lastSessionEtDay && i <= MAX_SCAN_DAYS;
      d = addDays(d, 1), i++
    ) {
      if (resolveSessionDate(d) === 'session') n++;
    }
    sessionsSinceLastDecision = n;
  }

  return {
    calendarVersion: MARKET_CALENDAR_VERSION,
    missingSessions,
    zeroEvaluatedSessions,
    lastSessionEtDay,
    sessionsSinceLastDecision,
    weekdayDaysExpected,
    weekdayDaysPresent,
    absentWeekdays,
    recorderCadence,
    cadenceEvidence: { nonSessionWeekdaysPresent, nonSessionWeekdaysAbsent },
    darkWeekdayHolidays,
    gateRosterBoundaries,
  };
}
