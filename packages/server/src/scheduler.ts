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
import { etClockParts } from './et-clock.js';

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

/**
 * TRA-3267 — is the ET calendar day containing `date` a trading day?
 *
 * Day-of-week MUST come from the ET date, not from `date.getDay()`: that reads
 * the HOST-LOCAL day, and prod runs in UTC, where every instant from 20:00 ET
 * (EDT; 19:00 EST) onward already sits on the NEXT UTC day. The 21:00 ET
 * archive lives entirely inside that window, so the local-day version returned
 * "Saturday" for Friday's close (dropping Friday's EOD ledger row fleet-wide,
 * 2026-08-07) and "Monday" for Sunday evening (booking a phantom Sunday
 * session, 2026-08-09). The holiday lookup below was already ET-keyed — the
 * two halves of the predicate disagreed about what day it was.
 */
export function isMarketDay(date: Date = new Date()): boolean {
  return isMarketDayIso(etDateString(date));
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
 * TRA-2634 — the NYSE session immediately before `dateIso`, or `null` if none is
 * found inside the lookback.
 *
 * Exists so the cross-artifact level-continuity check can insist on ADJACENCY.
 * Yesterday's published close is today's previous close only when "yesterday" is
 * the previous SESSION; over a weekend-plus-holiday gap the comparison silently
 * becomes a multi-day move and the residual stops meaning anything. The caller
 * must abstain rather than reach for the nearest report file it can find.
 *
 * The 10-day lookback covers the longest run of consecutive non-sessions the
 * `MARKET_HOLIDAYS` table can produce (a Thu/Fri holiday pair around a weekend
 * is 4; 10 leaves margin) and bounds the loop so a malformed date cannot spin.
 */
export function previousMarketDayIso(dateIso: string, maxLookbackDays = 10): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return null;
  const [y, m, d] = dateIso.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < maxLookbackDays; i++) {
    t -= 86400000;
    const iso = new Date(t).toISOString().slice(0, 10);
    if (isMarketDayIso(iso)) return iso;
  }
  return null;
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

/**
 * TRA-1971 — day-of-week (0=Sun … 6=Sat) for a `YYYY-MM-DD` ET date. Parses the
 * date-only value at UTC midnight so the result is timezone-independent (the same
 * technique `isMarketDayIso` uses); deriving it from a host-local `Date` would be
 * wrong for a date-only value. Used to gate the weekly roll-up to Mondays in ET.
 */
export function etDayOfWeekIso(dateIso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return -1;
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Returns the current hour and minute in ET.
 *
 * TRA-2498 — this used to render with a bare `hour12: false` and regex-parse
 * the hour inline. On Node 20 (the prod runtime) ICU renders the whole midnight
 * hour as `24:MM`, so `hour` read **24** for all of 00:00–00:59 ET. Every
 * `hour >= N` gate below then passed at midnight — most damagingly the 21:00 ET
 * archive, which fired at 00:00, stamped `lastArchiveDate` with the already-new
 * ET date, and thereby dedup-suppressed its own real 21:00 fire that evening.
 * Delegates to `et-clock.ts`, which pins `hourCycle: 'h23'` and folds `% 24`.
 */
function nowET(): { hour: number; minute: number; date: Date } {
  const now = new Date();
  const { hour, minute } = etClockParts(now);
  return { hour, minute, date: now };
}

export type EodTriggerCallback = () => void | Promise<void>;

/** ET wall-clock parts for the current scheduler tick. */
export interface EtTick {
  hour: number;
  minute: number;
  /** ET calendar date, `YYYY-MM-DD`. */
  date: string;
}

/** TRA-851 — per-tick callback that receives the current ET time. */
export type RoutineTickCallback = (et: EtTick) => void | Promise<void>;

/**
 * TRA-1404 — persistence port for the 21:00 ET archive dedup key
 * (`lastArchiveDate`). The scheduler itself stays fs-free (so its unit tests
 * need no disk); the concrete file-backed store lives in `scheduler-state.ts`.
 *
 * Motivation: the archive gate (`this.lastArchiveDate !== todayKey`) is
 * in-memory only. A Render redeploy AFTER 21:00 ET resets it to `''`, so the
 * fresh process re-fires `runDailyCloseForAllUsers` for a day it already
 * archived — wasteful full-close work every post-21:00 restart. (The TRA-1403
 * write-layer guard already neutralizes the *harm* — the re-fire can no longer
 * zero a settled calendar cell — so this only removes the redundant work.)
 * Persisting the key across restarts skips the re-fire entirely, leaving
 * `catchUpMissedEodReports` (writes only MISSING days) as the sole post-archive
 * writer.
 */
export interface ArchiveDateStore {
  /** The last-archived ET date (`YYYY-MM-DD`) from a prior process, or `''`/undefined if none. */
  load(): string | undefined;
  /** Persist `date` (`YYYY-MM-DD`) as the last-archived ET date. Best-effort — must not throw. */
  save(date: string): void;
}

/** TRA-1404 — optional wiring passed to `MarketScheduler.start`. */
export interface ScheduleOptions {
  /**
   * TRA-1404 — persists/restores the 21:00 ET archive dedup key across process
   * restarts so a post-21:00 redeploy does not re-fire the daily close. Omit
   * (e.g. in unit tests) to keep the in-memory-only behavior.
   */
  archiveDateStore?: ArchiveDateStore;
}

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
   * TRA-849 — fires at OR AFTER 8:30 AM ET (once per ET trading day) on stock-
   * market trading days, ahead of the 9:00 ET pre-market watchlist build.
   * Renders + pushes the per-user morning brief (macro gate + watchlist setups
   * + open positions + overnight news) through the notification dispatcher.
   * Fired at-or-after 8:30 rather than the exact minute (deduped per ET day) so
   * a server restarting/redeploying across 8:30 ET still sends the brief later
   * that morning instead of silently dropping the day — the same resilience the
   * chain-recorder and archive hooks have. Capped to before the 9:00 bell by
   * the gate below so it can't drift into the session.
   */
  onMorningBrief?: EodTriggerCallback;
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
   * TRA-1971 — fires once per week on MONDAY at OR AFTER 7:00 AM ET (through
   * noon), after the prior trading week's chains + Friday settlements have
   * accumulated on the durable disk. Publishes the AI-Options-Ideas forward-test
   * weekly roll-up (see `runWeeklyOptionsRollup` in index.ts) to the Stocks →
   * News tab so the live-capital-gate track record is auditable weekly without
   * manual polling. Deduped per ET Monday date (unique per ISO week) so a
   * Monday-morning restart can't double-publish; the at-or-after window (rather
   * than the exact 7:00 minute) means a server asleep/redeploying at 7:00 still
   * publishes later that morning — the same resilience the chain-recorder and
   * archive hooks have. Not market-day gated: it publishes bookkeeping, and a
   * Monday holiday roll-up of the just-closed week is still wanted.
   */
  onWeeklyRollup?: EodTriggerCallback;
  /**
   * TRA-406 — fires on every 60s scheduler tick. Drives the observability
   * monitor (health probe, disk-space, restart-storm and trade-volume
   * checks). Unlike the other hooks it is not time-gated; the individual
   * alert checks own their throttling and thresholds.
   */
  onMonitor?: EodTriggerCallback;
  /**
   * TRA-851 — fires on every 60s scheduler tick with the current ET time so the
   * routine runner can match user-defined fire times to the minute. Like
   * `onMonitor` it is not time-gated here; the runner owns the per-routine
   * time match, market-day gate, and per-ET-day dedup.
   */
  onRoutineTick?: RoutineTickCallback;
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
  /** TRA-849 — last ET date the 8:30 AM morning-brief hook fired. Dedupes within the day. */
  private lastMorningBriefDate = '';
  /** TRA-380 — last ET date the 3:55 PM option-chain recorder hook fired. Dedupes within the day. */
  private lastChainRecordDate = '';
  /** TRA-1971 — last ET Monday date the weekly options roll-up fired. Dedupes per ISO week. */
  private lastWeeklyRollupDate = '';
  /** TRA-1404 — persists `lastArchiveDate` so a post-21:00 restart doesn't re-fire the archive. */
  private archiveDateStore: ArchiveDateStore | null = null;

  /**
   * Start polling. Accepts either a single market-close callback (legacy form)
   * or an object with separate `onMarketClose`, `onDaily`, and `onArchive`
   * callbacks. The first two fire at 4:05 PM ET; `onArchive` fires at 9:00 PM
   * ET every calendar day.
   *
   * TRA-1404 — pass `opts.archiveDateStore` to persist/restore the 21:00 ET
   * archive dedup key across restarts (see `ArchiveDateStore`).
   */
  start(callbacks: EodTriggerCallback | ScheduleCallbacks, opts: ScheduleOptions = {}): void {
    if (this.timer) return;
    const cfg: ScheduleCallbacks =
      typeof callbacks === 'function' ? { onMarketClose: callbacks } : callbacks;

    // TRA-1404 — restore the last-archived ET date from disk so a process that
    // restarts AFTER 21:00 ET on an already-archived day does not re-fire the
    // daily close. A not-yet-archived day restores a stale/empty key and still
    // archives normally at 21:00.
    if (opts.archiveDateStore) {
      this.archiveDateStore = opts.archiveDateStore;
      const restored = opts.archiveDateStore.load();
      if (restored) {
        this.lastArchiveDate = restored;
        log.info('restored persisted archive dedup key', { lastArchiveDate: restored });
      }
    }

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

      // TRA-849 — morning-brief hook. Fire once per market day at OR AFTER
      // 8:30 AM ET, with a 9:00-bell catch-up window, so a redeploy across the
      // 8:30 minute still sends the brief later that pre-market window instead
      // of dropping the day. Gated on market days; deduped per ET date.
      if ((hour === 8 && minute >= 30) || (hour === 9 && minute === 0)) {
        if (cfg.onMorningBrief && isMarketDay(date) && this.lastMorningBriefDate !== todayKey) {
          this.lastMorningBriefDate = todayKey;
          log.info('morning-brief trigger fired', { date: todayKey, etHour: hour, etMinute: minute });
          runScheduled('morning-brief', cfg.onMorningBrief);
        }
      }

      // TRA-368 — 9:00 AM ET pre-market hook, 30 min before the opening bell.
      // Gated on market days so weekends + NYSE holidays are skipped. The
      // callback is responsible for replaying the prior session's post-market
      // EOD review + a fresh pre-market scan into a curated watchlist.
      //
      // TRA-2064 — fire at OR AFTER 9:00 ET but STRICTLY BEFORE the 9:30 bell,
      // instead of demanding the exact 9:00 minute. This tick loop is a 60s
      // `setInterval`: a restart, a redeploy, or an event-loop stall across that
      // single minute (TRA-1894 / TRA-1905 / TRA-1996 all document exactly that
      // on bqb1) skipped the sample and dropped the ENTIRE trading day, with no
      // catch-up and no error — the same failure the chain-record hook already
      // fixed below, and the same one the morning-brief hook fixed above.
      //
      // This is the leading root cause of TRA-1630 accruing 0 news-catalyst rows
      // across 5 armed sessions: the writer's ONLY caller is this hook. The
      // differential is the evidence — `onChainRecord`, which runs in the SAME
      // process over the SAME period but has a wide catch-up window, captured
      // 23 of ~24 trading days; this exact-minute hook captured 0 of 5.
      //
      // The window stops at the bell ON PURPOSE. The callback writes a
      // regime review labelled `premarket` and builds a *pre*-market watchlist;
      // letting it fire intraday would stamp a mid-session read with pre-market
      // semantics. Better to drop a day than to mislabel one.
      if (hour === 9 && minute < 30) {
        if (cfg.onPremarket && isMarketDay(date) && this.lastPremarketDate !== todayKey) {
          this.lastPremarketDate = todayKey;
          log.info('pre-market trigger fired', { date: todayKey });
          runScheduled('pre-market', cfg.onPremarket);
        }
      }

      // TRA-380 / TRA-779 — option-chain recorder hook. Fire once per market
      // day at OR AFTER 3:55 PM ET (through 8 PM ET) rather than demanding the
      // exact 15:55 minute. An EOD chain snapshot is a daily artifact, not a
      // time-critical market action, so a server that was restarting/redeploying
      // across 15:55 ET — but is up any time later that afternoon/evening — still
      // captures the day instead of silently dropping it. This is the same
      // resilience the EOD archive hook (hour >= 21) already has. The old
      // exact-minute gate is the likely reason ~30 daily partitions never
      // accumulated for the replay harness (TRA-779): any redeploy or GC pause
      // across that single minute lost the whole trading day with no catch-up.
      // Capturing at/after the 4 PM close is fine (settled EOD quotes/greeks).
      if ((hour === 15 && minute >= 55) || (hour >= 16 && hour < 20)) {
        if (cfg.onChainRecord && isMarketDay(date) && this.lastChainRecordDate !== todayKey) {
          this.lastChainRecordDate = todayKey;
          log.info('option-chain recorder trigger fired', { date: todayKey, etHour: hour, etMinute: minute });
          runScheduled('option-chain recorder', cfg.onChainRecord);
        }
      }

      // TRA-1971 — weekly options-ideas roll-up. Monday 07:00–11:59 ET window,
      // deduped per ET Monday date (unique per ISO week). The at-or-after window
      // heals a server that was asleep across 07:00; publishing bookkeeping is
      // not time-critical so a late-morning post is fine.
      if (cfg.onWeeklyRollup && hour >= 7 && hour < 12 && etDayOfWeekIso(todayKey) === 1) {
        if (this.lastWeeklyRollupDate !== todayKey) {
          this.lastWeeklyRollupDate = todayKey;
          log.info('weekly options roll-up trigger fired', { date: todayKey, etHour: hour });
          runScheduled('weekly options roll-up', cfg.onWeeklyRollup);
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
          // TRA-1404 — persist BEFORE running the close so a crash mid-close
          // can't re-fire the archive on the next boot. Best-effort (never throws).
          this.archiveDateStore?.save(todayKey);
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

      // TRA-851 — user-routine tick. Runs every tick with the ET time; the
      // runner matches user-defined fire times + dedups per ET day.
      if (cfg.onRoutineTick) {
        Promise.resolve(cfg.onRoutineTick({ hour, minute, date: todayKey })).catch(err =>
          log.error('routine tick error', {
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }, 60_000);

    log.info('EOD scheduler started (8:30 AM ET morning brief, 9:00 AM ET pre-market, 3:55 PM ET chain recorder, 4:05 PM ET reports, 9:00 PM ET archive)');
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
