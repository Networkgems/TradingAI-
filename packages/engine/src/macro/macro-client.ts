// TRA-597 (TRA-595 C2) — macro / Fed economic-event calendar feed.
//
// Provider: **FRED** (Federal Reserve Economic Data, St. Louis Fed)
//   `/fred/release/dates` (free, documented, generous rate limit).
//   GET https://api.stlouisfed.org/fred/release/dates
//        ?release_id=<id>&api_key=<key>&file_type=json
//        &include_release_dates_with_no_data=true&sort_order=asc
//   One call per economic-release type returns that release's scheduled dates
//   (including *future* dates, with `include_release_dates_with_no_data=true`),
//   so the whole macro calendar costs a handful of small HTTP calls per refresh.
//
// Why FRED over Finnhub's `/calendar/economic`: that Finnhub endpoint is a paid
// add-on (not on the free tier C1's earnings feed uses), whereas FRED's release
// calendar is free, stable, and run by the Fed itself — the authoritative source
// for U.S. macro-print timing (CPI, jobs, PCE). The client is isolated behind
// `EconomicCalendarClient` so a future swap only touches this file.
//
// FOMC meeting dates are *not* fetched: the Federal Reserve publishes the full
// year's FOMC calendar in advance and it does not map to a FRED data release, so
// we ship it as the curated `FOMC_MEETINGS` constant (decision-day dates) and
// merge it into the same `MacroEvent` stream the store persists. Update the
// constant once per year when the Fed publishes the next year's schedule.

import { daysUntil } from '../earnings/earnings-client.js';

export { daysUntil };

/** Category of a macro event. Extend as new release types are wired in. */
export type MacroEventType = 'FOMC' | 'CPI' | 'NFP' | 'PCE';

/** Relative market-moving weight, used by scanners to gate event-proximity logic. */
export type MacroImportance = 'high' | 'medium' | 'low';

/** A single scheduled macro/Fed event, normalised across providers. */
export interface MacroEvent {
  type: MacroEventType;
  /** Event date, `YYYY-MM-DD` (U.S. release / decision date). */
  date: string;
  importance: MacroImportance;
  /** Human-readable label, e.g. "FOMC rate decision" or "CPI (Consumer Price Index)". */
  title: string;
  /** Where the row came from: `fred` or `curated` (FOMC schedule). */
  source: 'fred' | 'curated';
}

/**
 * FRED release-id → macro-event metadata. These IDs are stable FRED release
 * identifiers (visible at https://fred.stlouisfed.org/releases). One HTTP call
 * per entry fetches that release's scheduled dates.
 */
export const FRED_RELEASES: ReadonlyArray<{
  releaseId: number;
  type: Exclude<MacroEventType, 'FOMC'>;
  importance: MacroImportance;
  title: string;
}> = [
  { releaseId: 10, type: 'CPI', importance: 'high', title: 'CPI (Consumer Price Index)' },
  { releaseId: 50, type: 'NFP', importance: 'high', title: 'Employment Situation (Nonfarm Payrolls)' },
  { releaseId: 21, type: 'PCE', importance: 'high', title: 'Personal Income & Outlays (PCE)' },
];

/**
 * Curated FOMC meeting calendar — the *decision-day* (second day) of each
 * regularly-scheduled meeting, as published by the Federal Reserve. FOMC dates
 * are fixed a year ahead and do not correspond to a FRED data release, so they
 * are shipped here rather than fetched. Refresh annually.
 *
 * Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 */
export const FOMC_MEETINGS: readonly string[] = [
  // 2026 (decision day = second meeting day)
  '2026-01-28',
  '2026-03-18',
  '2026-04-29',
  '2026-06-17',
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-09',
];

/** Build the curated FOMC `MacroEvent`s from {@link FOMC_MEETINGS}. */
export function fomcEvents(): MacroEvent[] {
  return FOMC_MEETINGS.map((date) => ({
    type: 'FOMC' as const,
    date,
    importance: 'high' as const,
    title: 'FOMC rate decision',
    source: 'curated' as const,
  }));
}

/**
 * Events within ±`windowDays` calendar days of `dateIso` (`YYYY-MM-DD`),
 * inclusive, sorted by date ascending. Pure. `windowDays` defaults to 3.
 * Rows with an unparseable date are skipped.
 */
export function eventsNearDate(
  events: readonly MacroEvent[],
  dateIso: string,
  windowDays = 3,
): MacroEvent[] {
  const anchorMs = Date.parse(`${dateIso}T00:00:00Z`);
  if (!Number.isFinite(anchorMs)) return [];
  const win = Math.abs(windowDays);
  return events
    .filter((ev) => {
      const evMs = Date.parse(`${ev.date}T00:00:00Z`);
      if (!Number.isFinite(evMs)) return false;
      const days = Math.round((evMs - anchorMs) / 86_400_000);
      return Math.abs(days) <= win;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The soonest not-yet-past event of `type` from `events`, as of `asOf`
 * ("not past" = `daysUntil >= 0`, so an event dated today still counts), or
 * `null` when none remain. Pass no `type` to consider every event type.
 */
export function nextEventOfType(
  events: readonly MacroEvent[],
  type: MacroEventType | null = null,
  asOf: number = Date.now(),
): MacroEvent | null {
  let best: MacroEvent | null = null;
  let bestDays = Infinity;
  for (const ev of events) {
    if (type && ev.type !== type) continue;
    const d = daysUntil(ev.date, asOf);
    if (d === null || d < 0) continue;
    if (d < bestDays) {
      bestDays = d;
      best = ev;
    }
  }
  return best;
}

/**
 * Whole calendar-days until the next FOMC decision in `events`, or `null` when
 * none is upcoming. Convenience wrapper over {@link nextEventOfType} for the
 * scanners and the LLM research pass.
 */
export function daysToNextFOMC(
  events: readonly MacroEvent[],
  asOf: number = Date.now(),
): number | null {
  const next = nextEventOfType(events, 'FOMC', asOf);
  return next ? daysUntil(next.date, asOf) : null;
}

interface FredReleaseDateRow {
  release_id?: unknown;
  date?: unknown;
}
interface FredReleaseDatesEnvelope {
  release_dates?: FredReleaseDateRow[] | null;
}

/**
 * Parse a FRED `/fred/release/dates` payload into `MacroEvent`s tagged with the
 * supplied `type`/`importance`/`title`. Pure and defensive: rows without a
 * `YYYY-MM-DD` `date` are dropped, and a non-object / empty payload yields `[]`.
 * Kept separate from the HTTP client so parsing is unit-testable offline.
 */
export function parseFredReleaseDates(
  payload: unknown,
  meta: { type: MacroEventType; importance: MacroImportance; title: string },
): MacroEvent[] {
  if (!payload || typeof payload !== 'object') return [];
  const rows = (payload as FredReleaseDatesEnvelope).release_dates;
  if (!Array.isArray(rows)) return [];
  const out: MacroEvent[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const date = typeof r.date === 'string' ? r.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({ type: meta.type, date, importance: meta.importance, title: meta.title, source: 'fred' });
  }
  return out;
}

export interface MacroWindowOptions {
  /** Calendar days back from `asOf` for the lower date bound. Default 0. */
  fromDays?: number;
  /** Calendar days forward from `asOf` for the upper date bound. Default 180. */
  toDays?: number;
  /** Anchor for the window (epoch ms). Default `Date.now()`. */
  asOf?: number;
}

/** `YYYY-MM-DD` for `ms` in UTC — the format FRED's date bounds expect. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * FRED economic-calendar client. Read-only; only needs an API key.
 *
 * `getUpcomingEvents()` fetches each configured release's scheduled dates,
 * normalises them to `MacroEvent`s, merges in the curated FOMC schedule, and
 * returns the union restricted to the requested forward window. The curated
 * FOMC rows are included even without network access, so a missing/invalid key
 * still yields FOMC proximity (the store logs and continues).
 */
export class EconomicCalendarClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, baseUrl = 'https://api.stlouisfed.org/fred') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Fetch + parse one FRED release's scheduled dates. */
  async fetchRelease(
    meta: { releaseId: number; type: MacroEventType; importance: MacroImportance; title: string },
  ): Promise<MacroEvent[]> {
    const params = new URLSearchParams({
      release_id: String(meta.releaseId),
      api_key: this.apiKey,
      file_type: 'json',
      include_release_dates_with_no_data: 'true',
      sort_order: 'asc',
    });
    const url = `${this.baseUrl}/release/dates?${params}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) {
      throw new Error(
        `FRED release ${meta.releaseId} HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`,
      );
    }
    return parseFredReleaseDates(await resp.json(), meta);
  }

  /**
   * Fetch every configured econ release plus the curated FOMC schedule, filtered
   * to `[asOf-fromDays, asOf+toDays]` and sorted ascending by date. A single
   * release failing (HTTP / parse) is logged via `onReleaseError` and skipped so
   * one bad release never blanks the whole calendar; FOMC rows are always kept.
   */
  async getUpcomingEvents(
    opts: MacroWindowOptions = {},
    onReleaseError?: (releaseId: number, err: unknown) => void,
  ): Promise<MacroEvent[]> {
    const asOf = opts.asOf ?? Date.now();
    const fromMs = asOf - (opts.fromDays ?? 0) * 86_400_000;
    const toMs = asOf + (opts.toDays ?? 180) * 86_400_000;
    const fromDay = isoDay(fromMs);
    const toDay = isoDay(toMs);

    const collected: MacroEvent[] = [...fomcEvents()];
    for (const rel of FRED_RELEASES) {
      try {
        collected.push(...(await this.fetchRelease(rel)));
      } catch (err) {
        onReleaseError?.(rel.releaseId, err);
      }
    }
    return collected
      .filter((ev) => ev.date >= fromDay && ev.date <= toDay)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
