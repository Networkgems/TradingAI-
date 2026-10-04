/**
 * TRA-5087 — the in-RTH staleness discriminator for /api/health/rv-scan.
 *
 * ## The defect this kills
 *
 * `verdict: "scanning"` + `enabled: true` + a 20.7h-stale `lastScanAt` is ONE
 * reading that describes two opposite worlds:
 *
 *   • Saturday 12:39 ET, last scan at Friday 15:59:59 ET — a healthy scanner
 *     over a closed exchange. Silence is the calendar.
 *   • Tuesday 12:39 ET, last scan at Monday 15:59:59 ET — the scanner has been
 *     dark for a full open session on the live-money host. Silence is an outage.
 *
 * On 2026-10-03 the first of those was read as the second and filed as an RTH
 * outage (TRA-5087): the reader took 10-03 for a Friday, and nothing on the
 * route said otherwise — `scanning` asserts only that the loop has turned at
 * least once SINCE BOOT, which on a long-lived process says nothing about
 * today. An instrument that reads identically in pass and fail is the house's
 * most-repeated bug shape; the fix is a grade that consults the exchange
 * calendar so the route, not the reader, owns the session question.
 *
 * ## Grade semantics
 *
 *   • `stale_in_rth`     — ⛔ RED. Now is inside a session's regular hours, the
 *     arming graces are spent, and the newest scan (across every instrumented
 *     path) is older than {@link RV_SCAN_STALE_IN_RTH_THRESHOLD_MS} — or has
 *     never happened. Dark-in-RTH, not quiet-overnight.
 *   • `fresh_in_rth`     — in session and scanning on cadence.
 *   • `out_of_session`   — weekend, NYSE closure, pre-open or post-close. GREEN
 *     no matter how old `lastScanAt` is: staleness is only a fault while the
 *     exchange is open. Early closes shorten the window (a 14:00 ET read on an
 *     early-close day is post-close, not stale).
 *   • `arming_grace`     — in session, but inside the post-open or post-boot
 *     grace. The 10-02 session's first scan landed 36s after the open, but the
 *     scheduler is not contractually that fast, and a watchdog restart mid-RTH
 *     must not read as an outage while the loop re-arms.
 *   • `disarmed`         — every instrumented path is off. Silence is correct
 *     and already named by the route's `verdict`; it must not ALSO read as an
 *     in-RTH staleness fault demanding the opposite remedy.
 *   • `calendar_uncovered` — ⛔ RED. The calendar makes no statement about
 *     today, so in-RTH staleness is unjudgeable. "Could not check" and
 *     "checked and it is fine" must never share a value (house rule; same
 *     direction as `calendarEntryGate`, which is refusing entries then anyway).
 *
 * ## Threshold rationale
 *
 * The aggregate `lastScanAt` is the MAX across instrumented paths, and the
 * fastest paths (`otm`, `rv_scan`) tick ~every 80s in-session with the slowest
 * (`directional`) at ~5min (measured on the 2026-10-02 session: 72/296/294
 * scans over 6.5h). 15 minutes is ~11x the fastest cadence and 3x the slowest,
 * and under 4% of a session — late enough to never fire on scheduler jitter,
 * early enough that a dark session pages while it is still worth saving.
 */

import { etDateKey, etWallClockToUtcMs } from './et-clock.js';
import {
  exchangeClosureName,
  resolveSessionDate,
  sessionCloseEtMinute,
  sessionOpenEtMinute,
  type SessionResolution,
} from './market-calendar.js';

/** Red line: newest scan older than this, inside RTH, is `stale_in_rth`. */
export const RV_SCAN_STALE_IN_RTH_THRESHOLD_MS = 15 * 60_000;

/**
 * Post-open and post-boot grace before staleness can be judged at all. Covers
 * the scheduler arming after the open and a watchdog restart mid-session.
 */
export const RV_SCAN_ARMING_GRACE_MS = 15 * 60_000;

export type RvScanRthStalenessState =
  | 'fresh_in_rth'
  | 'stale_in_rth'
  | 'arming_grace'
  | 'out_of_session'
  | 'disarmed'
  | 'calendar_uncovered';

export interface RvScanRthStaleness {
  state: RvScanRthStalenessState;
  /**
   * The route's top-level `ok` is wired to this. False ONLY for `stale_in_rth`
   * and `calendar_uncovered` — green over a closed exchange is the control
   * half of the discriminator, not a courtesy.
   */
  ok: boolean;
  /** ET calendar day the grade is about. */
  etDay: string;
  /** The calendar's own three-valued verdict for `etDay`. */
  session: SessionResolution;
  /** Was `nowMs` inside the session's regular hours (open..close)? */
  inRth: boolean;
  /** Session window in UTC, when `etDay` is a session; null otherwise. */
  sessionOpenUtc: string | null;
  sessionCloseUtc: string | null;
  /** Echo of the input — null means no scan has completed since boot. */
  lastScanAt: number | null;
  /** `nowMs - lastScanAt`, clamped at 0; null when never scanned. */
  ageMs: number | null;
  thresholdMs: number;
  graceMs: number;
  /** One sentence a 02:00Z operator can act on without opening this file. */
  reason: string;
}

function minuteToUtcMs(etDay: string, etMinute: number): number | null {
  return etWallClockToUtcMs(etDay, Math.floor(etMinute / 60), etMinute % 60);
}

function fmtMin(ms: number): string {
  return `${Math.round(ms / 60_000)}min`;
}

/**
 * Grade the scanner's staleness against the exchange calendar.
 *
 * `bootedAtMs`: `undefined` ⇒ derived from `process.uptime()` (the prod
 * wiring); `null` ⇒ unknown, the boot grace is skipped. Tests pass explicit
 * values — a fixture clock mixed with the real boot instant grades nothing.
 */
export function gradeRvScanRthStaleness(opts: {
  nowMs: number;
  /** The roll-up `lastScanAt` (max across instrumented paths). */
  lastScanAtMs: number | null;
  /** Is ANY instrumented path armed? A fully disarmed scanner is not "stale". */
  armed: boolean;
  bootedAtMs?: number | null;
}): RvScanRthStaleness {
  const { nowMs, lastScanAtMs, armed } = opts;
  const bootedAtMs =
    opts.bootedAtMs === undefined
      ? Date.now() - Math.round(process.uptime() * 1000)
      : opts.bootedAtMs;
  const etDay = etDateKey(nowMs);
  const session = resolveSessionDate(etDay, 'options');
  const ageMs = lastScanAtMs == null ? null : Math.max(0, nowMs - lastScanAtMs);
  const base = {
    etDay,
    session,
    lastScanAt: lastScanAtMs,
    ageMs,
    thresholdMs: RV_SCAN_STALE_IN_RTH_THRESHOLD_MS,
    graceMs: RV_SCAN_ARMING_GRACE_MS,
  };

  if (session === 'uncovered') {
    return {
      ...base,
      state: 'calendar_uncovered',
      ok: false,
      inRth: false,
      sessionOpenUtc: null,
      sessionCloseUtc: null,
      reason:
        `the exchange calendar makes no statement about ${etDay}, so in-RTH staleness is `
        + 'unjudgeable — failing closed rather than reading green. Remedy: raise '
        + 'COVERAGE_END_YEAR in scripts/gen-nyse-calendar.mjs and re-run it.',
    };
  }

  if (session === 'non_session') {
    const closure = exchangeClosureName(etDay);
    return {
      ...base,
      state: 'out_of_session',
      ok: true,
      inRth: false,
      sessionOpenUtc: null,
      sessionCloseUtc: null,
      reason: closure
        ? `${etDay} is an NYSE closure (${closure}) — scan silence is the calendar, not an outage.`
        : `${etDay} is not an NYSE session (weekend) — scan silence is the calendar, not an outage.`,
    };
  }

  const openMin = sessionOpenEtMinute(etDay, 'options');
  const closeMin = sessionCloseEtMinute(etDay, 'options');
  const openMs = openMin == null ? null : minuteToUtcMs(etDay, openMin);
  const closeMs = closeMin == null ? null : minuteToUtcMs(etDay, closeMin);
  if (openMs == null || closeMs == null) {
    // A session day whose window cannot be placed in UTC is a calendar fault,
    // and it takes the fail-closed branch for the same reason `uncovered` does.
    return {
      ...base,
      state: 'calendar_uncovered',
      ok: false,
      inRth: false,
      sessionOpenUtc: null,
      sessionCloseUtc: null,
      reason: `could not resolve the ${etDay} session window to UTC instants — failing closed rather than reading green.`,
    };
  }
  const sessionOpenUtc = new Date(openMs).toISOString();
  const sessionCloseUtc = new Date(closeMs).toISOString();
  const windowed = { sessionOpenUtc, sessionCloseUtc };

  if (nowMs < openMs) {
    return {
      ...base,
      ...windowed,
      state: 'out_of_session',
      ok: true,
      inRth: false,
      reason: `pre-open on ${etDay} (session opens ${sessionOpenUtc}) — scan silence is the clock, not an outage.`,
    };
  }
  if (nowMs > closeMs) {
    return {
      ...base,
      ...windowed,
      state: 'out_of_session',
      ok: true,
      inRth: false,
      reason: `post-close on ${etDay} (session closed ${sessionCloseUtc}) — scan silence is the clock, not an outage.`,
    };
  }

  if (!armed) {
    return {
      ...base,
      ...windowed,
      state: 'disarmed',
      ok: true,
      inRth: true,
      reason:
        'every instrumented path is disarmed — silence is correct and already named by '
        + '`verdict`; it must not also read as an in-RTH staleness fault.',
    };
  }
  if (nowMs - openMs < RV_SCAN_ARMING_GRACE_MS) {
    return {
      ...base,
      ...windowed,
      state: 'arming_grace',
      ok: true,
      inRth: true,
      reason: `inside the ${fmtMin(RV_SCAN_ARMING_GRACE_MS)} post-open arming grace on ${etDay} — too early to judge staleness.`,
    };
  }
  if (bootedAtMs != null && nowMs - bootedAtMs < RV_SCAN_ARMING_GRACE_MS) {
    return {
      ...base,
      ...windowed,
      state: 'arming_grace',
      ok: true,
      inRth: true,
      reason: `process booted inside the last ${fmtMin(RV_SCAN_ARMING_GRACE_MS)} — too early to judge staleness mid-session.`,
    };
  }
  if (ageMs == null) {
    return {
      ...base,
      ...windowed,
      state: 'stale_in_rth',
      ok: false,
      inRth: true,
      reason:
        `mid-RTH on ${etDay}, past every arming grace, and NO scan has completed since boot — `
        + 'dark-in-RTH, not quiet-overnight.',
    };
  }
  if (ageMs > RV_SCAN_STALE_IN_RTH_THRESHOLD_MS) {
    return {
      ...base,
      ...windowed,
      state: 'stale_in_rth',
      ok: false,
      inRth: true,
      reason:
        `zero scans for ${fmtMin(ageMs)} inside RTH on ${etDay} (last scan `
        + `${new Date(lastScanAtMs!).toISOString()}, threshold ${fmtMin(RV_SCAN_STALE_IN_RTH_THRESHOLD_MS)}) — `
        + 'dark-in-RTH, not quiet-overnight.',
    };
  }
  return {
    ...base,
    ...windowed,
    state: 'fresh_in_rth',
    ok: true,
    inRth: true,
    reason: `last scan ${fmtMin(ageMs)} ago inside RTH on ${etDay} — within the ${fmtMin(RV_SCAN_STALE_IN_RTH_THRESHOLD_MS)} threshold.`,
  };
}
