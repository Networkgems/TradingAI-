// TRA-923 (TRA-920 D) — news-window awareness + post-open reversal timing gate.
//
// The brief's Chapter 4 makes two intraday timing rules first-class:
//   (1) The 15m and 30m post-open reversal windows — after the market opens,
//       reversals cluster at these offsets (the video's "rinse and repeat" timing).
//   (2) High/medium-impact US economic news — being near a release window means
//       the move in could be news-driven rather than a clean technical reversal.
//
// Pure, deterministic helpers. No I/O — callers supply a pre-loaded MacroEvent[]
// from EconomicCalendarClient and a market-open timestamp (UTC epoch ms).

import type { MacroEvent, MacroImportance } from './macro-client.js';

export interface ReversalWindow {
  /** Human-readable label (e.g. "+15m", "+30m"). */
  label: string;
  /** Start of the window (ms epoch, inclusive). */
  startMs: number;
  /** End of the window (ms epoch, exclusive). */
  endMs: number;
}

export interface ReversalTimingOptions {
  /**
   * Minutes after market open that mark key reversal timing windows.
   * Default: [15, 30] — from Chapter 4 of the brief.
   */
  windowMinutes?: number[];
  /**
   * Half-width (minutes) of each timing window, applied symmetrically around
   * the target offset. Default: 5 min (so "+15m" covers 14:55–15:05 offset).
   */
  halfWidthMinutes?: number;
}

/**
 * Build the set of post-open reversal timing windows from a market-open
 * timestamp. Each entry is a ±halfWidth-minute band around the named offset.
 *
 * Example: openMs = 13:30 UTC (9:30 ET), default opts →
 *   [{label:"+15m", 13:25–13:35 UTC}, {label:"+30m", 13:55–14:05 UTC}]
 */
export function getReversalTimingWindows(
  openMs: number,
  opts: ReversalTimingOptions = {},
): ReversalWindow[] {
  const offsets = opts.windowMinutes ?? [15, 30];
  const hw = (opts.halfWidthMinutes ?? 5) * 60_000;
  return offsets.map((min) => {
    const center = openMs + min * 60_000;
    return { label: `+${min}m`, startMs: center - hw, endMs: center + hw };
  });
}

/**
 * True when `nowMs` falls inside any of the configured post-open reversal
 * timing windows. This is the intraday timing gate from Chapter 4 of the brief:
 * reversals tend to cluster 15m and 30m after open, so a checklist setup that
 * fires in one of these windows has an additional confluence factor.
 */
export function isInReversalWindow(
  nowMs: number,
  openMs: number,
  opts?: ReversalTimingOptions,
): boolean {
  return getReversalTimingWindows(openMs, opts).some(
    (w) => nowMs >= w.startMs && nowMs < w.endMs,
  );
}

/**
 * Standard US economic release times (Eastern Time, HH:MM). Most macro prints
 * drop at 08:30 ET; FOMC at 14:00. These are public-knowledge fixed times used
 * to build an intraday guard without needing a minute-level paid feed.
 */
const RELEASE_TIME_ET: Partial<Record<string, string>> = {
  CPI: '08:30',
  NFP: '08:30',
  PCE: '08:30',
  FOMC: '14:00',
};

export interface NewsWindowOptions {
  /**
   * Minimum event importance to count as a news window.
   * Default: 'high' — only CPI / NFP / PCE / FOMC trigger the guard.
   */
  minImportance?: MacroImportance;
  /**
   * Half-window (minutes) around the release time. Default: 30.
   * Times within ±30m of the release are flagged.
   */
  windowMinutes?: number;
  /**
   * ET offset from UTC in hours. Default: -4 (EDT).
   * Pass -5 during EST (November–March).
   */
  etOffsetHours?: number;
}

/**
 * True when `nowMs` is within a news guard window for any qualifying event on
 * the same UTC calendar day. Uses the event's standard release time (see
 * RELEASE_TIME_ET) and a ±windowMinutes guard around it. Events without a
 * known release time fall back to 08:30 ET (typical pre-market print time).
 *
 * Pass `minImportance: 'medium'` to also flag medium-impact events.
 */
export function isInNewsWindow(
  nowMs: number,
  events: readonly MacroEvent[],
  opts: NewsWindowOptions = {},
): boolean {
  const minImp = opts.minImportance ?? 'high';
  const wMs = (opts.windowMinutes ?? 30) * 60_000;
  const etOffset = opts.etOffsetHours ?? -4;

  const impRank: Record<MacroImportance, number> = { low: 0, medium: 1, high: 2 };
  const minRank = impRank[minImp];

  // Calendar day in UTC — events carry YYYY-MM-DD UTC dates.
  const nowUtcDate = new Date(nowMs);
  const todayUtc = nowUtcDate.toISOString().slice(0, 10);

  for (const ev of events) {
    if (ev.date !== todayUtc) continue;
    if (impRank[ev.importance] < minRank) continue;

    const timeEt = RELEASE_TIME_ET[ev.type] ?? '08:30';
    const [hh, mm] = timeEt.split(':').map(Number);
    const releaseMs =
      Date.UTC(
        nowUtcDate.getUTCFullYear(),
        nowUtcDate.getUTCMonth(),
        nowUtcDate.getUTCDate(),
      ) +
      (hh - etOffset) * 3_600_000 +
      mm * 60_000;

    if (Math.abs(nowMs - releaseMs) <= wMs) return true;
  }
  return false;
}

/** Morning briefing summary of the day's macro context and timing windows. */
export interface DailyNewsSummary {
  /** YYYY-MM-DD UTC date this summary covers. */
  date: string;
  /** High/medium-impact events on this date. */
  events: MacroEvent[];
  hasHighImpact: boolean;
  hasMediumImpact: boolean;
  /** Pre-computed reversal timing windows for the session. */
  reversalWindows: ReversalWindow[];
}

/**
 * Build the morning briefing's macro + timing context. Pass `allEvents` from
 * `EconomicCalendarClient.getUpcomingEvents()` and the session's `marketOpenMs`
 * (e.g. US equities: 13:30 UTC under EDT). `dateIso` defaults to the UTC date
 * of `marketOpenMs`.
 */
export function dailyNewsSummary(
  allEvents: readonly MacroEvent[],
  marketOpenMs: number,
  opts: ReversalTimingOptions & { dateIso?: string } = {},
): DailyNewsSummary {
  const dateIso =
    opts.dateIso ?? new Date(marketOpenMs).toISOString().slice(0, 10);
  const events = allEvents.filter(
    (ev) => ev.date === dateIso && ev.importance !== 'low',
  );
  return {
    date: dateIso,
    events,
    hasHighImpact: events.some((ev) => ev.importance === 'high'),
    hasMediumImpact: events.some((ev) => ev.importance === 'medium'),
    reversalWindows: getReversalTimingWindows(marketOpenMs, opts),
  };
}
