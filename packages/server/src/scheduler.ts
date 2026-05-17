/**
 * Market-day scheduler.
 *
 * Fires the EOD callback at 4:05 PM ET on trading days (Mon–Fri, non-holiday)
 * and the archive callback at 9:00 PM ET every calendar day.
 * Uses a 1-minute polling loop so no external cron dependency is needed.
 *
 * US market holidays are pre-computed for 2025–2026 and checked on each fire.
 */

import { logger } from './observability/index.js';

const log = logger.child({ module: 'scheduler' });

// ── Holiday calendar (NYSE observed dates) ───────────────────────────────────

/** Set of YYYY-MM-DD strings that are NYSE market holidays. */
const MARKET_HOLIDAYS = new Set<string>([
  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-20', // MLK Day
  '2025-02-17', // Presidents Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed, July 4 is Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
]);

/**
 * TRA-407 — the calendar date in ET (`YYYY-MM-DD`) for `date`. This is the
 * single ET-correct date helper the scheduler and the daily risk governor
 * both roll their "trading day" on. Deriving the day from a UTC date string
 * (`new Date().toISOString().slice(0, 10)`) rolls the day 4–5 hours early —
 * at UTC-midnight rather than ET-midnight — which can drop a halt or reset a
 * dedupe key in the ET evening. Always route a day-boundary check through
 * here so that window is closed.
 */
export function etDateString(date: Date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function isMarketDay(date: Date = new Date()): boolean {
  const dayOfWeek = date.getDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  return !MARKET_HOLIDAYS.has(etDateString(date));
}

/**
 * TRA-388 — `isMarketDay` for a calendar date already expressed as a
 * `YYYY-MM-DD` string. The `Date`-based variant derives day-of-week from the
 * host's local timezone, which is wrong for a date-only value; deriving it
 * from a UTC date keeps the result timezone-independent. Used by the missed-
 * day catch-up so a backfill scan never mis-classifies a weekend/holiday.
 */
export function isMarketDayIso(dateIso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return false;
  if (MARKET_HOLIDAYS.has(dateIso)) return false;
  const [y, m, d] = dateIso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
  return dow !== 0 && dow !== 6;
}

/**
 * TRA-388 — compute the trading days that should have an EOD report on disk
 * but don't, so a startup / pre-archive catch-up can backfill them.
 *
 * Root cause this guards against: the EOD report is generated only by the
 * 21:00 ET archive tick (`onArchive` → `runDailyCloseForAllUsers`). That tick
 * needs the server process alive during its fire window and the dedup key is
 * in-memory only, so a server that is closed overnight (the desktop case), a
 * Render redeploy, or a crash silently drops that day — there was no catch-up.
 * This is what left May 14/15 2026 blank on the calendar (TRA-388), a repeat
 * of the earlier calendar gaps.
 *
 * Returns the missed market days in ascending order, restricted to:
 *   - strictly AFTER the most recent existing report — older gaps can't be
 *     reconstructed from current engine state (those trades were archived);
 *   - strictly BEFORE `today` — today's report is the normal tick's job;
 *   - actual NYSE trading days (`isMarketDayIso`);
 *   - within `maxLookbackDays` of today — a safety cap so a long-idle install
 *     does not try to fabricate weeks of history.
 *
 * When `existingDates` is empty there is no anchor, so nothing is returned:
 * the next normal EOD run seeds the first report.
 */
export function missedTradingDays(
  existingDates: readonly string[],
  today: string,
  maxLookbackDays = 14,
): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return [];
  const valid = existingDates
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (valid.length === 0) return [];
  const anchor = valid[valid.length - 1];
  if (anchor >= today) return [];
  const have = new Set(valid);
  const out: string[] = [];
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  for (let back = maxLookbackDays; back >= 1; back--) {
    const iso = new Date(todayMs - back * 86_400_000).toISOString().slice(0, 10);
    if (iso <= anchor || iso >= today) continue;
    if (have.has(iso)) continue;
    if (!isMarketDayIso(iso)) continue;
    out.push(iso);
  }
  return out;
}

/** Returns the current hour and minute in ET. */
function nowET(): { hour: number; minute: number; date: Date } {
  const now = new Date();
  // Get ET time parts
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' });
  // Parse "MM/DD/YYYY, HH:MM"
  const match = etStr.match(/(\d+)\/(\d+)\/(\d+),\s+(\d+):(\d+)/);
  if (!match) return { hour: 0, minute: 0, date: now };
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  return { hour, minute, date: now };
}

export type EodTriggerCallback = () => void | Promise<void>;

export interface ScheduleCallbacks {
  /** Fires at 4:05 PM ET on stock-market trading days (Mon–Fri, non-holiday). */
  onMarketClose?: EodTriggerCallback;
  /** Fires at 4:05 PM ET every calendar day — for 24/7 markets like crypto. */
  onDaily?: EodTriggerCallback;
  /**
   * TRA-219 — fires at 9:00 PM ET every calendar day. Used to archive the
   * "Recent Closed" trade history so the Positions/Options pages start each
   * new session clean; the EOD reports already saved to disk preserve the
   * trades for the Calendar tab's per-date view.
   *
   * TRA-241 — also drives the dashboard's daily-P&L reset (see
   * `runDailyCloseForAllUsers` in index.ts) so the new trading day starts at 0
   * and the day's row lands in the Calendar at the same moment.
   */
  onArchive?: EodTriggerCallback;
  /**
   * TRA-249-D — fires once per hour, on the ET minute=0 boundary. Used to
   * accrue Coinbase INTX perp funding into the day's P&L so a multi-hour
   * open position's running cost shows up in the dashboard within the hour
   * (rather than only at close). Idempotent within the same ET hour: the
   * 60s polling loop checks back at minute=0 each tick but the dedupe key
   * (`YYYY-MM-DD-HH`) keeps the callback to one fire per hour.
   */
  onHourly?: EodTriggerCallback;
  /**
   * TRA-368 — fires at 9:00 AM ET on stock-market trading days, 30 minutes
   * before the opening bell. Used to build a "smart watchlist" by combining
   * the prior session's post-market EOD review (top movers, signal accuracy)
   * with a fresh pre-market scan (gainers / losers / volume / trending), and
   * feeding the result into each user's SignalEngine so the engine has a
   * curated symbol set ready when the bell rings.
   */
  onPremarket?: EodTriggerCallback;
  /**
   * TRA-380 — fires at 3:55 PM ET on stock-market trading days, 5 minutes
   * before the closing bell. Drives the TRA-376 option-chain recorder so a
   * fresh date-partitioned chain snapshot lands once per trading day for the
   * replay backtest harness (parent TRA-379). Gated on `isMarketDay` so
   * weekends + NYSE holidays are skipped, and deduped per ET date so the 60s
   * polling loop can't double-fire within the 3:55 minute.
   */
  onChainRecord?: EodTriggerCallback;
  /**
   * TRA-406 — fires on every 60s scheduler tick. Drives the observability
   * monitor (health probe, disk-space, restart-storm and trade-volume
   * checks). Unlike the other hooks it is not time-gated; the individual
   * alert checks own their throttling and thresholds.
   */
  onMonitor?: EodTriggerCallback;
}

/**
 * TRA-407 — hard ceiling for any single scheduled callback. A hung job (e.g.
 * a stalled feed fetch inside the market-review generation) otherwise leaves
 * a never-settling promise: its `.catch` never runs, so the failure is
 * silent and unbounded. Racing every callback against this timeout makes a
 * stuck job observable (it logs an error) and stops it from holding a live
 * promise across the rest of the trading day.
 */
const SCHEDULED_JOB_TIMEOUT_MS = 5 * 60_000;

/**
 * TRA-407 — resolve when `job` settles, or reject once `ms` elapses. The
 * timeout timer is `unref`-ed so it never keeps the event loop alive on its
 * own. Note this bounds the *promise chain*, not the underlying work — a job
 * that ignores cancellation keeps running, but the scheduler stops waiting on
 * it and surfaces the timeout.
 */
function withTimeout(job: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`scheduled job '${label}' exceeded ${ms}ms timeout`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([job, timeout]).finally(() => clearTimeout(timer));
}

/**
 * TRA-407 — run a scheduled callback fire-and-forget with a timeout guard so
 * a hung callback can neither stall the 60s polling loop nor fail silently.
 */
function runScheduled(label: string, cb: EodTriggerCallback): void {
  withTimeout(Promise.resolve(cb()), SCHEDULED_JOB_TIMEOUT_MS, label).catch(err =>
    log.error('scheduled callback error', {
      label,
      reason: err instanceof Error ? err.message : String(err),
    }),
  );
}

export class MarketScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMarketCloseDate = '';
  private lastDailyDate = '';
  private lastArchiveDate = '';
  /** TRA-249-D — `YYYY-MM-DD-HH` ET key of the last `onHourly` fire. Dedupes within an hour. */
  private lastHourlyKey = '';
  /** TRA-368 — last ET date the 9 AM pre-market hook fired. Dedupes within the day. */
  private lastPremarketDate = '';
  /** TRA-380 — last ET date the 3:55 PM option-chain recorder hook fired. Dedupes within the day. */
  private lastChainRecordDate = '';

  /**
   * Start polling. Accepts either a single market-close callback (legacy form)
   * or an object with separate `onMarketClose`, `onDaily`, and `onArchive`
   * callbacks. The first two fire at 4:05 PM ET; `onArchive` fires at 9:00 PM
   * ET every calendar day.
   */
  start(callbacks: EodTriggerCallback | ScheduleCallbacks): void {
    if (this.timer) return;
    const cfg: ScheduleCallbacks =
      typeof callbacks === 'function' ? { onMarketClose: callbacks } : callbacks;

    // Check every 60 seconds
    this.timer = setInterval(() => {
      const { hour, minute, date } = nowET();
      const todayKey = etDateString(date);

      if (hour === 16 && minute === 5) {
        if (cfg.onMarketClose && isMarketDay(date) && this.lastMarketCloseDate !== todayKey) {
          this.lastMarketCloseDate = todayKey;
          log.info('market-close EOD trigger fired', { date: todayKey });
          runScheduled('market-close EOD', cfg.onMarketClose);
        }

        if (cfg.onDaily && this.lastDailyDate !== todayKey) {
          this.lastDailyDate = todayKey;
          log.info('daily EOD trigger fired', { date: todayKey });
          runScheduled('daily EOD', cfg.onDaily);
        }
      }

      // TRA-368 — 9:00 AM ET pre-market hook, 30 min before the opening bell.
      // Gated on market days so weekends + NYSE holidays are skipped. The
      // callback is responsible for replaying the prior session's post-market
      // EOD review + a fresh pre-market scan into a curated watchlist.
      if (hour === 9 && minute === 0) {
        if (cfg.onPremarket && isMarketDay(date) && this.lastPremarketDate !== todayKey) {
          this.lastPremarketDate = todayKey;
          log.info('pre-market trigger fired', { date: todayKey });
          runScheduled('pre-market', cfg.onPremarket);
        }
      }

      // TRA-380 — 3:55 PM ET option-chain recorder hook, 5 min before the
      // closing bell. Gated on market days so weekends + NYSE holidays are
      // skipped. The callback runs the TRA-376 recorder, writing one date
      // partition per trading day for the replay backtest harness.
      if (hour === 15 && minute === 55) {
        if (cfg.onChainRecord && isMarketDay(date) && this.lastChainRecordDate !== todayKey) {
          this.lastChainRecordDate = todayKey;
          log.info('option-chain recorder trigger fired', { date: todayKey });
          runScheduled('option-chain recorder', cfg.onChainRecord);
        }
      }

      // TRA-388 — fire at OR AFTER 21:00 ET (once per ET day) instead of
      // demanding the exact 21:00 minute. The archive drives the Calendar's
      // EOD report; a server that was asleep/restarting at 21:00 but is up
      // later that evening still gets the day archived rather than losing it
      // outright. A full-evening outage is healed separately by the missed-
      // day catch-up (see `missedTradingDays`). Late archiving is harmless —
      // it is end-of-day bookkeeping, not a time-sensitive market action.
      if (hour >= 21) {
        if (cfg.onArchive && this.lastArchiveDate !== todayKey) {
          this.lastArchiveDate = todayKey;
          log.info('archive trigger fired', {
            date: todayKey,
            etTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ET`,
          });
          runScheduled('archive', cfg.onArchive);
        }
      }

      // TRA-249-D — top-of-hour funding-rate accrual hook. Fires once per ET
      // hour; the dedupe key includes the hour so the every-60s polling loop
      // can't double-fire when wall-clock jitter parks us at minute=0 across
      // two ticks.
      if (cfg.onHourly && minute === 0) {
        const hourlyKey = `${todayKey}-${String(hour).padStart(2, '0')}`;
        if (this.lastHourlyKey !== hourlyKey) {
          this.lastHourlyKey = hourlyKey;
          log.info('hourly trigger fired', { hourlyKey });
          runScheduled('hourly', cfg.onHourly);
        }
      }

      // TRA-406 — observability monitor. Runs every tick; the alert checks
      // throttle themselves so this can't spam.
      if (cfg.onMonitor) {
        Promise.resolve(cfg.onMonitor()).catch(err =>
          log.error('monitor callback error', {
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }, 60_000);

    log.info('EOD scheduler started (9:00 AM ET pre-market, 3:55 PM ET chain recorder, 4:05 PM ET reports, 9:00 PM ET archive)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Manually trigger the EOD report (for testing or on-demand generation).
   */
  async fireNow(onEod: EodTriggerCallback): Promise<void> {
    await onEod();
  }
}

export function isMarketOpen(): boolean {
  const { hour, minute, date } = nowET();
  if (!isMarketDay(date)) return false;
  const minuteOfDay = hour * 60 + minute;
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60;
}
