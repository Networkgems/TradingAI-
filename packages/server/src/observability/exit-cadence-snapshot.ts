// TRA-2840 — make the exit-cadence measurement DURABLE.
//
// TRA-2268's narrowing decision needs one number: an RTH-scoped
// `books.live.tickExitRegionMs.atOrAbove30s`, read off a process that spanned
// RTH. That number lives ONLY in the bqb1 process's memory and dies with the
// next restart, so obtaining it required an agent to run a read inside a narrow
// post-close window. That arrangement failed FOUR sessions running, for two
// independent reasons, and on 2026-08-04 both fired on the same day:
//
//   1. The window is unprotected by construction. `render-redeploy.mjs`'s RTH
//      freeze releases at 20:00:00Z sharp, and on 2026-08-04 the 20:00Z close
//      was followed by 14 `trigger=api` deploys between 20:35:51Z and
//      22:32:39Z — the first landing at 20:37:49.868Z. The read window went
//      from ~4.5h (07-29) to ~37min, and nothing noticed, because nothing was
//      reading it. (TRA-2322 recorded the strict-inequality hole; still open.)
//   2. The reading arm fires and dies in the harness. Both TRA-2305 routines
//      stamp `lastFiredAt` then fail before enqueueing an agent
//      ("Agent is not invokable in its current state"), while reading `active`
//      / `enabled` with a healthy `nextRunAt`. Every board proxy says the arm
//      is live; it has delivered nothing.
//
// A log line subsumes BOTH failure modes: there is no window to lose and no
// agent that has to be invokable. Render retains ~7 days of logs and they
// survive every restart — the same property that lets `tra2203-dotick-tape.mjs`
// recover a doTick tape hours after the fact.
//
// This module is deliberately pure: it BUILDS the line and DECIDES when one is
// due. Emission and scheduling are the caller's, so the whole thing is testable
// without an Express app, a clock, or a live tape.

import type { ExitCadenceRollup } from './health-routes.js';
import type { BuildInfo } from './build-info.js';

/**
 * The greppable marker. Render's `text=` log filter silently returns
 * `{"logs":null}` on values it dislikes — indistinguishable from "the line
 * never fired" — so this token is built from substrings MEASURED to match on
 * this service (`cadence`, `exit-cadence`, `timing`, `engine`). Do not
 * "tidy" it into something Render's filter will reject.
 *
 * Search with `text=exit-cadence-snapshot`, or the looser `text=cadence`.
 */
export const EXIT_CADENCE_SNAPSHOT_MARKER = 'exit-cadence-snapshot';

/** Which end of the session a line was emitted at. */
export type ExitCadenceSnapshotMark = 'T0-open' | 'T1-close';

/** RTH in UTC minutes-from-midnight: 13:30Z open, 20:00Z close. */
export const RTH_OPEN_UTC_MIN = 13 * 60 + 30;
export const RTH_CLOSE_UTC_MIN = 20 * 60;

/**
 * Fields on the line that are NOT differenceable between T0 and T1, stamped
 * onto the line itself so a consumer reading one line in isolation cannot
 * mistake them for counters.
 *
 * `maxMs` is a running MAXIMUM, not a monotonic counter: `T1.maxMs - T0.maxMs`
 * is not "the max during RTH", it is a meaningless subtraction of two extremes.
 * It is published because the absolute T1 value is useful on its own.
 */
export const EXIT_CADENCE_NOT_DIFFERENCEABLE: readonly string[] = Object.freeze([
  'books.live.tickExitRegionMs.maxMs',
  'books.demo.tickExitRegionMs.maxMs',
  'tickExitRegionMs.maxMs',
]);

export interface ExitCadenceSnapshotLine {
  marker: typeof EXIT_CADENCE_SNAPSHOT_MARKER;
  ticket: 'TRA-2840';
  mark: ExitCadenceSnapshotMark;
  /** ISO instant the line was emitted. */
  at: string;
  /** ET session date this line belongs to (`YYYY-MM-DD`). */
  session: string;
  /**
   * Process identity. A consumer MUST refuse to difference a pair whose
   * `startedAt` or `pid` disagree — that is a restart, and the counters reset.
   * The correct verdict there is BLIND, never zero.
   */
  process: {
    startedAt: string | null;
    pid: number | null;
    commit: string | null;
  };
  /**
   * True when the process booted AFTER the session's open, so the T0 line does
   * not actually mark the open. The window it anchors is PARTIAL and must be
   * reported as partial rather than passing as a session.
   */
  partialWindow: boolean;
  /** Minutes of RTH already elapsed when this process booted (0 if it predates the open). */
  missedOpenMinutes: number;
  /** Fields above that a differencing consumer must not subtract. */
  notDifferenceable: readonly string[];
  /** The `/api/health/exit-cadence` rollup, verbatim. */
  rollup: ExitCadenceRollup;
}

/** UTC minutes-from-midnight for an instant. */
function utcMinutes(ms: number): number {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * ET calendar date for an instant. The ET offset is derived rather than
 * hardcoded so this does not silently drift an hour across a DST boundary.
 */
export function etSessionDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Build the line. Pure — no clock, no logger, no I/O.
 *
 * `bootedAtMs` is the PROCESS start (`build.startedAt`), used to decide whether
 * a T0 line is anchoring a real open or a partial window.
 */
export function buildExitCadenceSnapshotLine(input: {
  mark: ExitCadenceSnapshotMark;
  nowMs: number;
  bootedAtMs: number | null;
  build: Pick<BuildInfo, 'commit'> & { startedAt?: string | null; pid?: number | null };
  rollup: ExitCadenceRollup;
}): ExitCadenceSnapshotLine {
  const { mark, nowMs, bootedAtMs, build, rollup } = input;

  // A process that booted after the open cannot have observed the whole
  // session, regardless of which mark this is: T1 differenced against a T0 that
  // was itself late is still a partial window.
  const sessionOpenMs = bootedAtMs == null ? null : rthOpenMsFor(nowMs);
  const missedOpenMinutes =
    bootedAtMs == null || sessionOpenMs == null || bootedAtMs <= sessionOpenMs
      ? 0
      : Math.round((bootedAtMs - sessionOpenMs) / 60_000);

  return {
    marker: EXIT_CADENCE_SNAPSHOT_MARKER,
    ticket: 'TRA-2840',
    mark,
    at: new Date(nowMs).toISOString(),
    session: etSessionDate(nowMs),
    process: {
      startedAt: build.startedAt ?? null,
      pid: build.pid ?? null,
      commit: build.commit ?? null,
    },
    partialWindow: missedOpenMinutes > 0,
    missedOpenMinutes,
    notDifferenceable: EXIT_CADENCE_NOT_DIFFERENCEABLE,
    rollup,
  };
}

/** The 13:30Z open instant on the UTC day containing `ms`. */
function rthOpenMsFor(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    Math.floor(RTH_OPEN_UTC_MIN / 60), RTH_OPEN_UTC_MIN % 60, 0, 0,
  );
}

/**
 * Which mark, if any, is due at `nowMs` given the last one already emitted.
 *
 * Semantics chosen so a missed tick still produces a line rather than skipping
 * the session — the whole point of this ticket is that a read which only
 * happens under ideal conditions does not happen:
 *
 *  - at/after the open and no T0 yet for this session -> `T0-open`. A process
 *    that boots at 15:00Z still emits T0 immediately, flagged `partialWindow`.
 *  - at/after the close and no T1 yet for this session -> `T1-close`.
 *  - otherwise `null`.
 *
 * Weekends/holidays are NOT filtered here: a line on a non-session day is
 * harmless (it carries its own `session` date and the rollup will show no
 * activity), whereas wiring a holiday calendar in would add a way for the
 * emitter to go quiet for a reason nobody notices. Silence is the failure mode
 * this ticket exists to remove.
 */
export function dueExitCadenceMark(
  nowMs: number,
  state: ExitCadenceEmitState,
): ExitCadenceSnapshotMark | null {
  const mins = utcMinutes(nowMs);
  const session = etSessionDate(nowMs);

  // Close first: past 20:00Z the close line is what matters, and a process that
  // booted post-close should not emit a T0 that would look like an open.
  if (mins >= RTH_CLOSE_UTC_MIN) {
    return state.lastT1Session === session ? null : 'T1-close';
  }
  if (mins >= RTH_OPEN_UTC_MIN) {
    return state.lastT0Session === session ? null : 'T0-open';
  }
  return null;
}

/** Per-session emission cursor. Tracked separately so a missed T0 cannot suppress T1. */
export interface ExitCadenceEmitState {
  lastT0Session: string | null;
  lastT1Session: string | null;
}

/** Fold an emitted mark back into the cursor. */
export function recordExitCadenceMark(
  state: ExitCadenceEmitState,
  mark: ExitCadenceSnapshotMark,
  session: string,
): ExitCadenceEmitState {
  return mark === 'T0-open'
    ? { ...state, lastT0Session: session }
    : { ...state, lastT1Session: session };
}
