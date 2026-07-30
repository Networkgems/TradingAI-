import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import {
  EconomicCalendarClient,
  eventsNearDate as eventsNearDatePure,
  daysToNextFOMC as daysToNextFOMCPure,
  nextEventOfType,
  daysUntil,
  type MacroEvent,
  type MacroEventType,
} from '@trading-app/engine';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';

// TRA-597 (TRA-595 C2) — file-backed macro / Fed economic-event calendar.
//
// A scheduled refresh (boot + the 9 AM ET pre-market hook) pulls upcoming FOMC
// decisions and key econ prints (CPI / NFP / PCE) from `EconomicCalendarClient`
// (FRED, plus the curated FOMC schedule) and persists them here under DATA_DIR.
// The scanners and the LLM research pass read it through `eventsNearDate(date,
// window)` / `daysToNextFOMC()` / `daysToEvent(type)`, which derive days-until at
// read time so proximity stays correct as the clock advances between refreshes.
//
// Like C1's earnings store, we persist the *dates* (not pre-computed day counts)
// so values never silently drift stale between refreshes — days-until is a cheap
// pure recompute. The store also exposes a synchronous hot-path reader for the
// per-tick engine, warmed from disk at boot via `initMacroStore`.

const log = logger.child({ module: 'macro-store' });

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'economic-calendar.json');
}

let storeFileOverride: string | null = null;
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

interface StoreFile {
  version: 1;
  /** Epoch ms of the last successful refresh. */
  updatedAt: number;
  events: MacroEvent[];
}

let cache: MacroEvent[] | null = null;

function isMacroEvent(v: unknown): v is MacroEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e['type'] === 'string' &&
    typeof e['date'] === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(e['date']) &&
    typeof e['importance'] === 'string' &&
    typeof e['title'] === 'string'
  );
}

async function ensureLoaded(): Promise<MacroEvent[]> {
  if (cache) return cache;
  const path = storeFile();
  if (!existsSync(path)) {
    cache = [];
    return cache;
  }
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    cache = Array.isArray(parsed.events) ? parsed.events.filter(isMacroEvent) : [];
  } catch (err) {
    log.error('failed to read macro store, starting empty', {
      reason: err instanceof Error ? err.message : String(err),
    });
    cache = [];
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const payload: StoreFile = { version: 1, updatedAt: Date.now(), events: cache };
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Eagerly load the on-disk calendar into the in-memory cache so the synchronous
 * accessors have data right after boot, before the first refresh completes.
 * Idempotent.
 */
export async function initMacroStore(): Promise<void> {
  await ensureLoaded();
}

/**
 * Macro events within ±`windowDays` calendar days of `dateIso` (`YYYY-MM-DD`),
 * sorted ascending. Async — loads the store on first use. `windowDays` defaults
 * to 3. Returns `[]` when the store is empty or the date is unparseable.
 */
export async function eventsNearDate(dateIso: string, windowDays = 3): Promise<MacroEvent[]> {
  const events = await ensureLoaded();
  return eventsNearDatePure(events, dateIso, windowDays);
}

/** Synchronous hot-path variant of {@link eventsNearDate} (store must be warmed). */
export function eventsNearDateSync(dateIso: string, windowDays = 3): MacroEvent[] {
  if (!cache) return [];
  return eventsNearDatePure(cache, dateIso, windowDays);
}

/**
 * Whole calendar-days until the next FOMC decision, or `null` when none is
 * upcoming / the store is empty. `asOf` defaults to now.
 */
export async function daysToNextFOMC(asOf: number = Date.now()): Promise<number | null> {
  const events = await ensureLoaded();
  return daysToNextFOMCPure(events, asOf);
}

/** Synchronous hot-path variant of {@link daysToNextFOMC} (store must be warmed). */
export function daysToNextFOMCSync(asOf: number = Date.now()): number | null {
  if (!cache) return null;
  return daysToNextFOMCPure(cache, asOf);
}

/**
 * Whole calendar-days until the next not-yet-past event of `type`, or `null`
 * when none remains / the store is empty. Coordinates with C1's
 * `earningsInDays(symbol)` so C4 can read macro + earnings proximity uniformly.
 */
export async function daysToEvent(type: MacroEventType, asOf: number = Date.now()): Promise<number | null> {
  const events = await ensureLoaded();
  const next = nextEventOfType(events, type, asOf);
  return next ? daysUntil(next.date, asOf) : null;
}

/** All stored events with `date >= today` (sorted ascending). */
export async function getUpcomingMacroEvents(asOf: number = Date.now()): Promise<MacroEvent[]> {
  const events = await ensureLoaded();
  const today = new Date(asOf).toISOString().slice(0, 10);
  return events.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
}

export interface MacroRefreshResult {
  /** Number of upcoming events now stored. */
  stored: number;
  /** Number of those that are FOMC decisions. */
  fomc: number;
}

/**
 * Refresh the stored calendar from `client`, replacing the cache with the
 * fetched forward window. Throws only on a hard client failure so the caller can
 * log + continue; per-release fetch errors inside the client are swallowed (and
 * logged here) so a single bad release never blanks the calendar — the curated
 * FOMC rows always survive.
 */
export async function refreshMacroCalendar(client: EconomicCalendarClient): Promise<MacroRefreshResult> {
  const events = await client.getUpcomingEvents({}, (releaseId, err) => {
    log.warn('macro release fetch failed — skipping', {
      releaseId,
      reason: err instanceof Error ? err.message : String(err),
    });
  });
  cache = events;
  await persist();
  const fomc = events.filter((e) => e.type === 'FOMC').length;
  log.info('macro calendar refreshed', { stored: events.length, fomc });
  return { stored: events.length, fomc };
}

/**
 * Build an `EconomicCalendarClient` from `FRED_API_KEY`, or `null` when the key
 * is unset. Note: even without the key the curated FOMC schedule is still useful,
 * but we treat the key as required to fetch the econ prints; the boot job logs +
 * skips when it's absent, leaving trading unaffected.
 */
export function makeMacroClientFromEnv(): EconomicCalendarClient | null {
  const key = (process.env['FRED_API_KEY'] ?? '').trim();
  if (!key) return null;
  return new EconomicCalendarClient(key);
}

/** Test-only: reset the in-memory cache and (optionally) override the on-disk path. */
export function __resetMacroStoreForTests(overridePath?: string | null): void {
  cache = null;
  storeFileOverride = overridePath ?? null;
}
