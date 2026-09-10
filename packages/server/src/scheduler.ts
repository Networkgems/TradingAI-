/**
 * Market-day scheduler.
 *
 * Fires the EOD callback at 4:05 PM ET on trading days (Mon–Fri, non-holiday)
 * and the archive callback at 9:00 PM ET every calendar day.
 * Uses a 1-minute polling loop so no external cron dependency is needed.
 *
 * The NYSE calendar it fires against is NOT defined here — see
 * `market-calendar.ts` (TRA-4478).
 */

import { logger } from './observability/index.js';
import { etClockParts } from './et-clock.js';
import { isSessionDateOptimistic, sessionCloseEtMinute } from './market-calendar.js';

const log = logger.child({ module: 'scheduler' });

// ── Holiday calendar ─────────────────────────────────────────────────────────
//
// TRA-4478 — this module used to OWN the calendar: `MARKET_HOLIDAYS`, a
// hand-typed `Set` covering 2025 and 2026 only, with a bare weekday fall-
// through for everything after. The first miss was **2027-01-01**, a Friday,
// and it would have mis-dated every per-ET-day fold keyed off this predicate —
// not just the session gate. Early closes were not modelled at all.
//
// Exchange policy now lives in `market-calendar.ts`, generated from the
// observance rules into `data/nyse-calendar.generated.ts` and graded by
// `pnpm check:calendar-coverage`. The scheduler is a CONSUMER.
//
// ⛔ The re-export below keeps the OPTIMISTIC (weekday-guess) fallback for an
// out-of-coverage date, deliberately and unchanged. Twelve non-test server
// modules key evidence folds and EOD writes off `isMarketDayIso` (measured
// 2026-09-09: close-ledger, both denominator-flip-tape halves,
// directional-exploration-allowance, eod-archive-participation,
// giveback-arm-floor-ledger, index, live-nav-tripwire-ledger,
// reports/desk-calendar, reports/eod-write-gate, session-coverage,
// user-context); failing those closed on a
// stale calendar would drop every row fleet-wide, which is the TRA-3267
// incident shape, not a fix for it. The fallback is counted and logged
// (`calendarFallbackCount`). Anything that OPENS RISK must consult
// `calendarEntryGate` instead, which fails closed — see that module's header.

export {
  calendarCoverage,
  calendarEntryGate,
  calendarFreshness,
  calendarFallbackCount,
  calendarFallbackDates,
  earlyCloseName,
  exchangeClosureName,
  isEarlyClose,
  resolveSessionDate,
  sessionCloseEtMinute,
  sessionOpenEtMinute,
  MARKET_CALENDAR_VERSION,
} from './market-calendar.js';

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
 *
 * TRA-4478 — the holiday table it consults moved to `market-calendar.ts`. The
 * date-only, UTC-midnight day-of-week derivation is unchanged; so is the
 * behaviour on an out-of-coverage date (weekday guess), which is now counted
 * and logged rather than silent. See the ⛔ note at the top of this file for
 * why this predicate does NOT fail closed and what to use when you need one
 * that does.
 */
export function isMarketDayIso(dateIso: string): boolean {
  return isSessionDateOptimistic(dateIso, 'equities');
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
 * exchange calendar can produce (a Thu/Fri holiday pair around a weekend is 4;
 * 10 leaves margin) and bounds the loop so a malformed date cannot spin.
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
 * TRA-1404 / TRA-4417 — persistence port for the scheduler's per-ET-day dedup
 * keys. The scheduler itself stays fs-free (so its unit tests need no disk); the
 * concrete file-backed store lives in `scheduler-state.ts`.
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
 *
 * TRA-4417 — widened from the archive key alone to EVERY per-ET-day dedup key,
 * because the archive was never the only hook with this defect. Measured on
 * bqb1 2026-09-08: a restart at 08:56 ET landed inside the morning-brief
 * catch-up window and dispatched the 09-08 brief to all 67 users a SECOND time,
 * 27 minutes after the first. `onPremarket` — a WRITER — carries the identical
 * guard behind a 30-minute window.
 */
export type SchedulerDedupeKey =
  | 'lastMarketCloseDate'
  | 'lastDailyDate'
  | 'lastArchiveDate'
  | 'lastPremarketDate'
  | 'lastMorningBriefDate'
  | 'lastChainRecordDate'
  | 'lastWeeklyRollupDate';

/**
 * TRA-4417 — every key this store carries is an ET date (`YYYY-MM-DD`) produced
 * by `etDateString`, the SAME `todayKey` the hook compares against in the tick.
 * Not UTC: these hooks are ET-scheduled and the archive boundary is 21:00 ET, so
 * a UTC key would roll over mid-evening and re-open an already-closed day.
 *
 * `lastHourlyKey` is deliberately NOT in this set. It is `YYYY-MM-DD-HH`, not a
 * date, and it sits behind an exact `minute === 0` gate — a 60-second exposure
 * rather than the 30-minute and 5-hour catch-up windows that make the keys above
 * reachable by an ordinary restart. Whether the funding accrual it guards is
 * itself idempotent is a separate question and not one this change answers.
 */
export interface SchedulerDedupeStore {
  /** The `key`'s ET date (`YYYY-MM-DD`) from a prior process, or undefined if none. */
  load(key: SchedulerDedupeKey): string | undefined;
  /** Persist `date` (`YYYY-MM-DD`) for `key`. Best-effort — must not throw. */
  save(key: SchedulerDedupeKey, date: string): void;
}

/** TRA-1404 — optional wiring passed to `MarketScheduler.start`. */
export interface ScheduleOptions {
  /**
   * TRA-1404 / TRA-4417 — persists/restores the per-ET-day dedup keys across
   * process restarts, so a redeploy that lands inside a hook's catch-up window
   * does not re-fire a hook that already ran today. Omit (e.g. in unit tests) to
   * keep the in-memory-only behavior.
   */
  dedupeStore?: SchedulerDedupeStore;
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
  /**
   * TRA-1404 / TRA-4417 — persists the per-ET-day dedup keys so a restart INSIDE a
   * hook's catch-up window can't re-fire a hook that already ran today.
   */
  private dedupeStore: SchedulerDedupeStore | null = null;

  /**
   * TRA-4417 — mark `key` as fired for `todayKey`, in memory AND (when wired) on
   * disk. Persisting happens BEFORE the callback runs, deliberately and for the
   * same reason TRA-1404 chose that order: a crash mid-hook must not leave the day
   * looking un-fired, because the re-run would repeat whatever side effects the
   * first attempt already committed. That matters most for `onPremarket`, whose
   * callback seeds the watchlist via `engine.addSymbol()` and fans a full
   * `scanStocksMarket()` out per user. The cost of this order is that a hook which
   * dies early is not retried today — a missed day, which is loud in the same logs
   * that made this bug visible, versus a silent double-write.
   */
  private markFired(key: SchedulerDedupeKey, todayKey: string): void {
    try {
      this.dedupeStore?.save(key, todayKey);
    } catch (err) {
      // The store contract says `save` never throws, and the file-backed one honours
      // it — but this call sits on the 60s tick, INSIDE the `if` that has already
      // decided the hook runs. An exception escaping here would abort the tick before
      // `runScheduled`, i.e. a broken disk would silently stop the hook it is meant to
      // protect, and take every later hook in the same tick with it. Degrade to
      // in-memory-only dedup instead; the day still fires.
      log.warn('scheduler dedup key persist threw; continuing with in-memory dedup', {
        key,
        date: todayKey,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

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

    // TRA-1404 / TRA-4417 — restore each hook's last-fired ET date from disk, so a
    // process that restarts INSIDE that hook's catch-up window does not run the hook
    // a second time for a day it already ran. A day the hook has NOT yet run restores
    // a stale/absent key, which cannot equal `todayKey`, so the hook still fires
    // normally — the windows below keep their full width and their full healing power
    // (TRA-2064); all that changes is that "already done today" now survives the
    // restart the window exists to tolerate.
    if (opts.dedupeStore) {
      this.dedupeStore = opts.dedupeStore;
      const restored: Partial<Record<SchedulerDedupeKey, string>> = {};
      // A throwing `load` must not kill boot: this runs inside `start()`, which is on
      // the server's startup path. Fail OPEN, per key — an unreadable key means "has
      // not fired today", so the hook runs, which is the same place we were before
      // TRA-4417 and strictly better than a process that does not come up at all.
      const take = (key: SchedulerDedupeKey): string => {
        let value: string | undefined;
        try {
          value = opts.dedupeStore?.load(key);
        } catch (err) {
          log.warn('scheduler dedup key restore threw; treating as not-yet-fired', {
            key,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        if (value) restored[key] = value;
        return value ?? '';
      };
      this.lastMarketCloseDate = take('lastMarketCloseDate');
      this.lastDailyDate = take('lastDailyDate');
      this.lastArchiveDate = take('lastArchiveDate');
      this.lastPremarketDate = take('lastPremarketDate');
      this.lastMorningBriefDate = take('lastMorningBriefDate');
      this.lastChainRecordDate = take('lastChainRecordDate');
      this.lastWeeklyRollupDate = take('lastWeeklyRollupDate');
      // Logged even when empty: "restored nothing" and "never looked" are different
      // facts, and the second one is what TRA-4417 spent a live incident learning to
      // tell apart. An empty object here means a fresh disk, not a disabled store.
      log.info('restored persisted scheduler dedup keys', {
        restored,
        count: Object.keys(restored).length,
      });
    }

    // Check every 60 seconds
    this.timer = setInterval(() => {
      const { hour, minute, date } = nowET();
      const todayKey = etDateString(date);

      if (hour === 16 && minute === 5) {
        if (cfg.onMarketClose && isMarketDay(date) && this.lastMarketCloseDate !== todayKey) {
          this.lastMarketCloseDate = todayKey;
          this.markFired('lastMarketCloseDate', todayKey);
          log.info('market-close EOD trigger fired', { date: todayKey });
          runScheduled('market-close EOD', cfg.onMarketClose);
        }

        if (cfg.onDaily && this.lastDailyDate !== todayKey) {
          this.lastDailyDate = todayKey;
          this.markFired('lastDailyDate', todayKey);
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
          this.markFired('lastMorningBriefDate', todayKey);
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
          this.markFired('lastPremarketDate', todayKey);
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
          this.markFired('lastChainRecordDate', todayKey);
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
          this.markFired('lastWeeklyRollupDate', todayKey);
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
          this.markFired('lastArchiveDate', todayKey);
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

/**
 * Is the NYSE regular session open right now?
 *
 * TRA-4478 — the close boundary is now read from the exchange calendar rather
 * than hard-coded to 16:00, so a 13:00 ET EARLY CLOSE (the Friday after
 * Thanksgiving, Christmas Eve, July 3) reports shut at 13:00 instead of
 * claiming three more hours of session that do not exist. Early closes were
 * previously not modelled anywhere.
 *
 * ⛔ On an out-of-coverage date `isMarketDay` takes the optimistic weekday
 * guess and `sessionCloseEtMinute` returns `null` — so the close falls back to
 * 16:00 rather than being guessed at. This function is a "the exchange is
 * open" READ, not an entry gate; anything opening risk must consult
 * `calendarEntryGate`, which refuses out-of-coverage dates outright.
 */
export function isMarketOpen(): boolean {
  const { hour, minute, date } = nowET();
  if (!isMarketDay(date)) return false;
  const minuteOfDay = hour * 60 + minute;
  const close = sessionCloseEtMinute(etDateString(date), 'equities') ?? 16 * 60;
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay < close;
}
