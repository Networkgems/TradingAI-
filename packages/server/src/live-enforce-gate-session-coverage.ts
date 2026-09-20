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
  const missingSessions: string[] = [];
  if (etDays.length > 0 && lastSessionEtDay !== null) {
    const earliestRetained = [...etDays].sort()[0]!;
    const clamp = addDays(lastSessionEtDay, -MAX_SCAN_DAYS);
    const from = earliestRetained < clamp ? clamp : earliestRetained;
    for (let d = from; d <= lastSessionEtDay; d = addDays(d, 1)) {
      if (present.has(d)) continue;
      // ⛔ `=== 'session'` and nothing else. `non_session` (weekend or closure)
      // and `uncovered` (outside the bundle) are both SILENT here — an absent
      // day the calendar has no opinion about is not evidence of anything.
      const r: SessionResolution = resolveSessionDate(d);
      if (r === 'session') missingSessions.push(d);
    }
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
  };
}
