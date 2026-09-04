// TRA-4343 — does a SINCE-BOOT counter block cover the session a reader is grading?
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// On 2026-09-03 the postmarket review read three since-boot blocks
// (`underlyingAssetClass.entrySite`, `averageDown.sinceBoot`,
// `entryQuoteStamp.sinceBoot`) and every one of them read `0`. The session had
// closed at 16:00 ET; bqb1 restarted at 21:11 ET onto `a22668a3`; the review
// fired at 21:59 ET. So the counters described 48 minutes of an empty evening,
// not a trading session — and the session's entry-site record was gone.
//
// The zeros were VACUOUS, and nothing on the wire said so. A zero from a
// process that was alive all session is the datum you want (the scanner looked
// and refused everything). A zero from a process that booted after the close is
// not a measurement at all. They rendered byte-identically.
//
// This is STRUCTURAL, not a one-off: `scripts/render-redeploy.mjs` enforces an
// RTH freeze (refuses 13:25–20:00Z Mon–Fri), which deliberately pushes every
// deploy into the post-close window — the only window in which these counters
// exist. **The deploy policy and the telemetry lifetime are in direct
// conflict**, so this recurs on every post-close deploy until something
// announces it.
//
// ── WHAT IT DOES ─────────────────────────────────────────────────────────────
// Grades the process's boot instant against the most recently CLOSED regular
// session and publishes how a `0` in the accompanying block must be read.
// It does not recover the lost data — {@link ./entry-site-census-ledger.js} is
// the durable twin that does — it makes the loss self-announcing, which is the
// half that works even where no durable twin exists.
//
// ⛔ FAILS CLOSED. An unparseable boot stamp, or a calendar that cannot be
// resolved, reads `unknown` / `vacuous` — never `measurement`. "Could not
// check" and "checked and it covers the session" must not share a value.

import { etDateKey, etWallClockToUtcMs } from './et-clock.js';
import { isMarketDayIso, previousMarketDayIso } from './scheduler.js';

/** Regular-session open, ET wall clock. */
export const RTH_OPEN_ET = { hour: 9, minute: 30 } as const;
/** Regular-session close, ET wall clock — the boundary this module grades on. */
export const RTH_CLOSE_ET = { hour: 16, minute: 0 } as const;
/** 09:30–16:00 ET. Half-days are NOT subtracted; see {@link SinceBootSessionCoverage.coveredMinutes}. */
export const RTH_SESSION_MINUTES = 390;

export type SessionCoverageStatus =
  /** Boot at or before 09:30 ET of the graded session ⇒ the counters span all of it. */
  | 'covers_session'
  /** Boot inside 09:30–16:00 ET ⇒ the counters span the tail of it. */
  | 'partial_session'
  /** ⛔ Boot AFTER 16:00 ET ⇒ the counters describe NONE of it. Every 0 is vacuous. */
  | 'boot_after_close'
  /** The boot stamp or the calendar could not be resolved. Treated as vacuous. */
  | 'unknown';

/** How a `0` in the accompanying since-boot block must be read. */
export type SinceBootZeroReading =
  /** A real measurement: the writer was alive for the whole session and counted nothing. */
  | 'measurement'
  /** A LOWER bound: the writer missed part of the session. */
  | 'lower_bound'
  /** ⛔ NOT a measurement. Says nothing about the session. Do not report it as a quiet day. */
  | 'vacuous';

export interface SinceBootSessionCoverage {
  issue: 'TRA-4343';
  /** Process boot, ISO. `null` ⇒ unreadable ⇒ `status: 'unknown'`. */
  startedAt: string | null;
  /** The most recent NYSE session whose 16:00 ET close is at or before `gradedAt`. */
  sessionDate: string | null;
  sessionOpenAt: string | null;
  sessionCloseAt: string | null;
  status: SessionCoverageStatus;
  /**
   * Minutes of that session's 09:30–16:00 ET this process was alive for, clamped
   * to [0, 390]. `null` when `status` is `unknown`. Exchange half-days are not
   * subtracted, so a 13:00 ET early close reads as partial coverage of a full
   * session — which biases toward "less covered than you think", the safe
   * direction for a reader deciding whether to trust a zero.
   */
  coveredMinutes: number | null;
  sessionMinutes: number;
  zeroReading: SinceBootZeroReading;
  gradedAt: string;
  statement: string;
}

/** The most recent NYSE session whose 16:00 ET close is at or before `now`. */
export function mostRecentClosedSession(
  now: number,
): { date: string; openMs: number; closeMs: number } | null {
  if (!Number.isFinite(now)) return null;
  let iso: string | null = etDateKey(now);
  // 12 steps is well past the longest run of non-sessions `MARKET_HOLIDAYS` can
  // produce, and bounds the walk on a malformed key.
  for (let guard = 0; iso !== null && guard < 12; guard += 1) {
    if (isMarketDayIso(iso)) {
      const openMs = etWallClockToUtcMs(iso, RTH_OPEN_ET.hour, RTH_OPEN_ET.minute);
      const closeMs = etWallClockToUtcMs(iso, RTH_CLOSE_ET.hour, RTH_CLOSE_ET.minute);
      // A calendar that will not resolve is UNKNOWN, never the nearest guess.
      if (openMs === null || closeMs === null) return null;
      if (closeMs <= now) return { date: iso, openMs, closeMs };
    }
    iso = previousMarketDayIso(iso);
  }
  return null;
}

function unknownCoverage(startedAt: string | null, now: number, why: string): SinceBootSessionCoverage {
  return {
    issue: 'TRA-4343',
    startedAt,
    sessionDate: null,
    sessionOpenAt: null,
    sessionCloseAt: null,
    status: 'unknown',
    coveredMinutes: null,
    sessionMinutes: RTH_SESSION_MINUTES,
    zeroReading: 'vacuous',
    gradedAt: new Date(now).toISOString(),
    statement:
      `⛔ SESSION COVERAGE UNKNOWN (${why}) — a 0 in this block is NOT a measurement. `
      + 'Fails closed by design (TRA-4343).',
  };
}

/**
 * Grade a since-boot block's coverage of the most recently closed session.
 *
 * `startedAtIso` is the process boot stamp — on this server, `resolveBuildInfo().startedAt`.
 * Pure over its two arguments plus the NYSE calendar; no IO, no process state.
 */
export function gradeSinceBootSessionCoverage(
  startedAtIso: string | null | undefined,
  now: number = Date.now(),
): SinceBootSessionCoverage {
  const startedAt = typeof startedAtIso === 'string' && startedAtIso !== '' ? startedAtIso : null;
  if (startedAt === null) return unknownCoverage(null, now, 'no boot stamp');
  const bootMs = Date.parse(startedAt);
  if (!Number.isFinite(bootMs)) return unknownCoverage(startedAt, now, 'unparseable boot stamp');

  const session = mostRecentClosedSession(now);
  if (session === null) return unknownCoverage(startedAt, now, 'no closed session resolved');

  const openIso = new Date(session.openMs).toISOString();
  const closeIso = new Date(session.closeMs).toISOString();
  const base = {
    issue: 'TRA-4343' as const,
    startedAt,
    sessionDate: session.date,
    sessionOpenAt: openIso,
    sessionCloseAt: closeIso,
    sessionMinutes: RTH_SESSION_MINUTES,
    gradedAt: new Date(now).toISOString(),
  };

  if (bootMs > session.closeMs) {
    return {
      ...base,
      status: 'boot_after_close',
      coveredMinutes: 0,
      zeroReading: 'vacuous',
      statement:
        `⛔ BOOT AFTER CLOSE — this process started ${startedAt}, after the ${session.date} `
        + `16:00 ET close (${closeIso}). Every counter in this block describes 0 minutes of that `
        + 'session, so a 0 here is VACUOUS, not quiet: it is NOT evidence the writer was idle. '
        + 'Read the durable twin, or record the session as UNMEASURED (TRA-4343).',
    };
  }

  if (bootMs <= session.openMs) {
    return {
      ...base,
      status: 'covers_session',
      coveredMinutes: RTH_SESSION_MINUTES,
      zeroReading: 'measurement',
      statement:
        `This process started ${startedAt}, at or before the ${session.date} 09:30 ET open, and has `
        + `been up across the whole 09:30–16:00 ET session. A 0 in this block IS a measurement: `
        + 'the writer was alive and counted nothing.',
    };
  }

  const covered = Math.max(0, Math.min(
    RTH_SESSION_MINUTES,
    Math.round((session.closeMs - bootMs) / 60_000),
  ));
  return {
    ...base,
    status: 'partial_session',
    coveredMinutes: covered,
    zeroReading: 'lower_bound',
    statement:
      `⚠ PARTIAL SESSION — this process started ${startedAt}, inside the ${session.date} session, `
      + `and covers ${String(covered)} of ${String(RTH_SESSION_MINUTES)} RTH minutes. Every count in `
      + 'this block is a LOWER BOUND on the session; a 0 does not rule out activity before boot.',
  };
}
