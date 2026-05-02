/**
 * Market-day scheduler.
 *
 * Fires the EOD callback at 4:05 PM ET on trading days (Mon–Fri, non-holiday)
 * and the archive callback at 9:00 PM ET every calendar day.
 * Uses a 1-minute polling loop so no external cron dependency is needed.
 *
 * US market holidays are pre-computed for 2025–2026 and checked on each fire.
 */

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

export function isMarketDay(date: Date = new Date()): boolean {
  const dayOfWeek = date.getDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return !MARKET_HOLIDAYS.has(dateStr);
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
}

export class MarketScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMarketCloseDate = '';
  private lastDailyDate = '';
  private lastArchiveDate = '';

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
      const todayKey = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      if (hour === 16 && minute === 5) {
        if (cfg.onMarketClose && isMarketDay(date) && this.lastMarketCloseDate !== todayKey) {
          this.lastMarketCloseDate = todayKey;
          console.log(`[scheduler] market-close EOD trigger fired for ${todayKey}`);
          Promise.resolve(cfg.onMarketClose()).catch(err =>
            console.error('[scheduler] market-close EOD callback error:', err),
          );
        }

        if (cfg.onDaily && this.lastDailyDate !== todayKey) {
          this.lastDailyDate = todayKey;
          console.log(`[scheduler] daily EOD trigger fired for ${todayKey}`);
          Promise.resolve(cfg.onDaily()).catch(err =>
            console.error('[scheduler] daily EOD callback error:', err),
          );
        }
      }

      if (hour === 21 && minute === 0) {
        if (cfg.onArchive && this.lastArchiveDate !== todayKey) {
          this.lastArchiveDate = todayKey;
          console.log(`[scheduler] archive trigger fired for ${todayKey}`);
          Promise.resolve(cfg.onArchive()).catch(err =>
            console.error('[scheduler] archive callback error:', err),
          );
        }
      }
    }, 60_000);

    console.log('[scheduler] EOD scheduler started (4:05 PM ET reports, 9:00 PM ET archive)');
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
