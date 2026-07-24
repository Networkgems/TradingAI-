/**
 * TRA-2252 — Scheduled P&L + trade-summary report emails.
 *
 * Rolls each user's booked `DailySnapshot` ledger (stocks + crypto) into a
 * daily / weekly / monthly / yearly P&L + trade summary and emits it as a
 * `report` AlertEvent, which the notification dispatcher fans out to whichever
 * channels the user has enabled for the `report` class — inheriting quiet-hours,
 * dedup, and failure-isolation for free (same pattern as `morning-brief.ts`).
 *
 * Design choices worth calling out:
 *
 *   • Data source is the PER-DAY snapshot ROLLUP (`DailySnapshot`), not raw
 *     trade/journal rows. Each snapshot is already one booked total per ET date,
 *     so summing them cannot re-count a mirrored QA-fixture row (the TRA-2139
 *     "mirror trap": bit-identical, id-distinct rows) — that hazard only exists
 *     when aggregating individual rows, which we deliberately do not do here.
 *
 *   • Day P&L is the DAY-ONLY realized total `dailyPnl + optionsDailyPnl`, NOT
 *     the cumulative-carrying `combinedPnl`. `combinedPnl` booked the mode's
 *     all-time options total into every cell (TRA-1633 BUG 2 / TRA-1557), so a
 *     weekly/monthly window that summed it would re-add the running options total
 *     on every day with option activity. This matches `getCumulativeStats`.
 *
 *   • An EMPTY period (no closed trades AND flat P&L across the whole window) is
 *     SKIPPED, not sent as a "no trades" email. The fleet carries many idle demo
 *     books; a daily "you did nothing" email to each would be noise. A period
 *     with any activity (a trade, or a non-zero day) always sends. This is a
 *     documented, testable rule — see `buildPeriodReport`.
 *
 * Boundary firing rides the 21:00 ET archive tick (after `runDailyCloseForAllUsers`
 * has booked today's snapshot), so "today" is always in the window. Each cadence
 * decides for itself whether today closes its period (`isPeriodEnd`).
 */

import type { AlertPreferences, ReportCadence } from '@trading-app/shared';
import type { DailySnapshot } from './pnl-tracker.js';
import {
  emitAlert,
  type ReportAlertEvent,
  type ReportPeriodStats,
} from './notifications/index.js';
// TRA-1684 / TRA-2252 gotcha — the LEAF logger, not the barrel, from any
// email-adjacent module (the email -> barrel -> alerts -> email cycle is live).
import { logger } from './observability/logger.js';

const log = logger.child({ module: 'scheduled-report' });

/** A cadence that actually fires (everything but `off`). */
export type ActiveReportCadence = Exclude<ReportCadence, 'off'>;

// ── date helpers (all ET-`YYYY-MM-DD`-string based, timezone-independent) ─────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC-midnight epoch for a `YYYY-MM-DD` date-only string. */
function dayMs(dateIso: string): number {
  return Date.parse(`${dateIso}T00:00:00Z`);
}

/** `YYYY-MM-DD` for a UTC-midnight epoch. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Day-of-week (0=Sun … 6=Sat) for a date-only string, parsed at UTC midnight so
 * the result never depends on the host timezone — same technique the scheduler's
 * `etDayOfWeekIso` uses (not imported to keep this module scheduler-free).
 */
function dowIso(dateIso: string): number {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * TRA-2252 — the inclusive start date of `cadence`'s period containing
 * `dateIso`. Weeks are Monday-started (matching `PnlTracker.startOfWeek`), months
 * start on the 1st, years on Jan 1.
 */
export function periodStartFor(cadence: ActiveReportCadence, dateIso: string): string {
  const [y, m] = dateIso.split('-').map(Number);
  switch (cadence) {
    case 'daily':
      return dateIso;
    case 'weekly': {
      // Monday-started week: Sunday (dow 0) is the LAST day, 6 days after Monday.
      const dow = dowIso(dateIso);
      const offset = dow === 0 ? 6 : dow - 1;
      return isoOf(dayMs(dateIso) - offset * 86_400_000);
    }
    case 'monthly':
      return `${y}-${String(m).padStart(2, '0')}-01`;
    case 'yearly':
      return `${y}-01-01`;
  }
}

/**
 * TRA-2252 — whether `dateIso` is the LAST day of `cadence`'s period, i.e. the
 * day the report should fire. Daily fires every day; weekly on Sunday (the
 * Monday-week's close); monthly on the calendar month's last day; yearly on
 * Dec 31.
 */
export function isPeriodEnd(cadence: ActiveReportCadence, dateIso: string): boolean {
  if (!DATE_RE.test(dateIso)) return false;
  switch (cadence) {
    case 'daily':
      return true;
    case 'weekly':
      return dowIso(dateIso) === 0; // Sunday closes the Mon–Sun week
    case 'monthly': {
      // Last day of the month ⇔ tomorrow is in a different month.
      const tomorrow = isoOf(dayMs(dateIso) + 86_400_000);
      return tomorrow.slice(0, 7) !== dateIso.slice(0, 7);
    }
    case 'yearly':
      return dateIso.slice(5) === '12-31';
  }
}

/** Human label for a period, e.g. "Weekly — 2026-07-20 to 2026-07-26". */
export function periodLabel(
  cadence: ActiveReportCadence,
  start: string,
  end: string,
): string {
  switch (cadence) {
    case 'daily':
      return `Daily — ${end}`;
    case 'weekly':
      return `Weekly — ${start} to ${end}`;
    case 'monthly':
      return `Monthly — ${end.slice(0, 7)}`;
    case 'yearly':
      return `Yearly — ${end.slice(0, 4)}`;
  }
}

// ── aggregation ──────────────────────────────────────────────────────────────

/** Day-only realized P&L for a snapshot (stock + day-only options; no carry). */
function dayPnl(s: DailySnapshot): number {
  return (s.dailyPnl ?? 0) + (s.optionsDailyPnl ?? 0);
}

interface MergedDay {
  date: string;
  pnl: number;
  stockPnl: number;
  optionsPnl: number;
  trades: number;
  openingEquity: number;
  closingEquity: number;
}

/**
 * Merge snapshots (possibly from BOTH the stocks and crypto trackers, which can
 * each carry a row for the same date) into one row per date, summing P&L / trades
 * / equity across trackers. Rows outside `[start, end]` are dropped.
 */
function mergeByDate(
  snapshots: readonly DailySnapshot[],
  start: string,
  end: string,
): MergedDay[] {
  const byDate = new Map<string, MergedDay>();
  for (const s of snapshots) {
    if (!s || !DATE_RE.test(s.date)) continue;
    if (s.date < start || s.date > end) continue;
    const cur = byDate.get(s.date) ?? {
      date: s.date,
      pnl: 0,
      stockPnl: 0,
      optionsPnl: 0,
      trades: 0,
      openingEquity: 0,
      closingEquity: 0,
    };
    cur.pnl += dayPnl(s);
    cur.stockPnl += s.dailyPnl ?? 0;
    cur.optionsPnl += s.optionsDailyPnl ?? 0;
    cur.trades += s.trades ?? 0;
    cur.openingEquity += s.openingEquity ?? 0;
    cur.closingEquity += s.closingEquity ?? 0;
    byDate.set(s.date, cur);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * TRA-2252 — roll a set of daily snapshots into period stats over the inclusive
 * window `[start, end]`. Returns `null` when the window is EMPTY of activity (no
 * closed trades AND every day flat), which is the documented skip case — the
 * caller sends nothing rather than an idle "no trades" email. A window with any
 * trade or any non-zero day always returns stats.
 */
export function aggregatePeriod(
  snapshots: readonly DailySnapshot[],
  start: string,
  end: string,
): ReportPeriodStats | null {
  const days = mergeByDate(snapshots, start, end);
  if (days.length === 0) return null;

  const hasActivity = days.some((d) => d.trades > 0 || d.pnl !== 0);
  if (!hasActivity) return null;

  let totalPnl = 0;
  let stockPnl = 0;
  let optionsPnl = 0;
  let totalTrades = 0;
  let winDays = 0;
  let lossDays = 0;
  let bestDay: ReportPeriodStats['bestDay'];
  let worstDay: ReportPeriodStats['worstDay'];

  for (const d of days) {
    totalPnl += d.pnl;
    stockPnl += d.stockPnl;
    optionsPnl += d.optionsPnl;
    totalTrades += d.trades;
    if (d.pnl > 0) winDays += 1;
    else if (d.pnl < 0) lossDays += 1;
    if (!bestDay || d.pnl > bestDay.pnl) bestDay = { date: d.date, pnl: d.pnl, trades: d.trades };
    if (!worstDay || d.pnl < worstDay.pnl) worstDay = { date: d.date, pnl: d.pnl, trades: d.trades };
  }

  return {
    totalPnl,
    stockPnl,
    optionsPnl,
    totalTrades,
    tradingDays: days.length,
    winDays,
    lossDays,
    startEquity: days[0]!.openingEquity,
    endEquity: days[days.length - 1]!.closingEquity,
    bestDay,
    worstDay,
  };
}

/**
 * TRA-2252 — build the `report` event for one user's cadence as of `asOfDate`,
 * or `null` when nothing should fire (period not ending, or an empty period).
 * Pure given its inputs — exported so a test or an on-demand endpoint can build a
 * report without the dispatcher.
 */
export function buildPeriodReport(
  username: string,
  cadence: ActiveReportCadence,
  snapshots: readonly DailySnapshot[],
  asOfDate: string,
  timestamp: number,
): ReportAlertEvent | null {
  if (!isPeriodEnd(cadence, asOfDate)) return null;
  const start = periodStartFor(cadence, asOfDate);
  const stats = aggregatePeriod(snapshots, start, asOfDate);
  if (!stats) return null;

  return {
    kind: 'report',
    username,
    timestamp,
    cadence,
    periodStart: start,
    periodEnd: asOfDate,
    periodLabel: periodLabel(cadence, start, asOfDate),
    stats,
  };
}

// ── fan-out ──────────────────────────────────────────────────────────────────

/** One user's inputs for the scheduled-report run (injectable for tests). */
export interface ReportUser {
  username: string;
  /** Combined stocks + crypto daily snapshots for the user. */
  snapshots: readonly DailySnapshot[];
  /** Resolved alert prefs — `reportCadence` decides whether/what fires. */
  prefs: AlertPreferences;
}

export interface RunScheduledReportsDeps {
  /** Enumerate every user with their snapshots + resolved prefs. */
  users: () => ReportUser[];
  /** ET calendar date for this run, `YYYY-MM-DD`. */
  asOfDate: string;
  /** Epoch ms stamped on the emitted events. */
  now: number;
  /** Emit an alert (defaults to the real dispatcher; injectable for tests). */
  emit?: (event: ReportAlertEvent) => void;
}

/**
 * TRA-2252 — fan the scheduled P&L report out across every user whose chosen
 * cadence closes on `asOfDate`. Per-user composition + emit is isolated so one
 * user can't break the fleet. Returns the number of reports emitted (for logging
 * / test assertions). Pure control-flow — all I/O is behind `deps`.
 */
export function runScheduledReports(deps: RunScheduledReportsDeps): number {
  const emit = deps.emit ?? emitAlert;
  let emitted = 0;
  for (const u of deps.users()) {
    try {
      const cadence = u.prefs.reportCadence;
      if (cadence === 'off') continue;
      const event = buildPeriodReport(u.username, cadence, u.snapshots, deps.asOfDate, deps.now);
      if (!event) continue;
      emit(event);
      emitted += 1;
    } catch (err) {
      log.error('scheduled report failed', {
        username: u.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (emitted > 0) {
    log.info('scheduled reports dispatched', { date: deps.asOfDate, reports: emitted });
  }
  return emitted;
}
