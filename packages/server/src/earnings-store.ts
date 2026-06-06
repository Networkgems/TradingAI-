import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { EarningsCalendarClient, daysUntil } from '@trading-app/engine';
import { logger } from './observability/index.js';

// TRA-596 (TRA-595 C1) — file-backed upcoming-earnings calendar.
//
// A scheduled refresh (boot + the 9 AM ET pre-market hook) pulls the active
// symbol universe's next earnings date from `EarningsCalendarClient` (Finnhub)
// and persists `symbol → next-earnings-date` here under DATA_DIR. The engine and
// the future LLM research pass read it through `earningsInDays(symbol)` /
// `earningsInDaysSync(symbol)`, which derive the days-until value at read time so
// it stays correct as the clock advances between refreshes.
//
// Persisting the *date* (not a pre-computed days count) is deliberate: a stored
// days value would silently drift stale between refreshes, whereas the date is
// stable and the days-until is a cheap pure recompute.

const log = logger.child({ module: 'earnings-store' });

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'earnings-calendar.json');
}

let storeFileOverride: string | null = null;
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** One persisted earnings record per symbol. */
export interface EarningsRecord {
  /** Next scheduled earnings date, `YYYY-MM-DD`. */
  date: string;
  /** Epoch ms this record was last refreshed from the provider. */
  fetchedAt: number;
}

interface StoreFile {
  version: 1;
  /** Epoch ms of the last successful refresh. */
  updatedAt: number;
  /** Keyed by UPPER-CASE symbol. */
  symbols: Record<string, EarningsRecord>;
}

let cache: Map<string, EarningsRecord> | null = null;

async function ensureLoaded(): Promise<Map<string, EarningsRecord>> {
  if (cache) return cache;
  const path = storeFile();
  if (!existsSync(path)) {
    cache = new Map();
    return cache;
  }
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    const map = new Map<string, EarningsRecord>();
    if (parsed.symbols && typeof parsed.symbols === 'object') {
      for (const [sym, rec] of Object.entries(parsed.symbols)) {
        if (rec && typeof rec.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.date)) {
          map.set(sym.toUpperCase(), {
            date: rec.date,
            fetchedAt: typeof rec.fetchedAt === 'number' ? rec.fetchedAt : 0,
          });
        }
      }
    }
    cache = map;
  } catch (err) {
    log.error('failed to read earnings store, starting empty', {
      reason: err instanceof Error ? err.message : String(err),
    });
    cache = new Map();
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const payload: StoreFile = {
    version: 1,
    updatedAt: Date.now(),
    symbols: Object.fromEntries(cache),
  };
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Eagerly load the on-disk store into the in-memory cache so the synchronous
 * accessor (`earningsInDaysSync`) has data available right after boot, before
 * the first refresh completes. Idempotent.
 */
export async function initEarningsStore(): Promise<void> {
  await ensureLoaded();
}

/**
 * Days until `symbol`'s next earnings event, or `null` when the symbol is not
 * covered / the stored date has already passed. Async — loads the store on first
 * use. `asOf` defaults to now; pass the decision bar's timestamp for a
 * point-in-time read.
 */
export async function earningsInDays(symbol: string, asOf: number = Date.now()): Promise<number | null> {
  const map = await ensureLoaded();
  return daysFromRecord(map.get(symbol.trim().toUpperCase()), asOf);
}

/**
 * Synchronous variant for hot paths (e.g. the per-tick agent advisory) where
 * the store has already been loaded at boot via `initEarningsStore`. Returns
 * `null` when the cache is not yet loaded or the symbol is uncovered/past.
 */
export function earningsInDaysSync(symbol: string, asOf: number = Date.now()): number | null {
  if (!cache) return null;
  return daysFromRecord(cache.get(symbol.trim().toUpperCase()), asOf);
}

function daysFromRecord(rec: EarningsRecord | undefined, asOf: number): number | null {
  if (!rec) return null;
  const d = daysUntil(rec.date, asOf);
  // A stored date that has already passed is stale (the next refresh replaces
  // it); treat it as unknown rather than returning a negative count.
  if (d === null || d < 0) return null;
  return d;
}

/** Raw next-earnings date (`YYYY-MM-DD`) for `symbol`, or `null` if uncovered. */
export async function getNextEarningsDate(symbol: string): Promise<string | null> {
  const map = await ensureLoaded();
  return map.get(symbol.trim().toUpperCase())?.date ?? null;
}

export interface EarningsRefreshResult {
  /** Number of symbols that now have a stored upcoming-earnings date. */
  covered: number;
  /** Number of requested symbols with no event in the fetch window. */
  uncovered: number;
}

/**
 * Refresh the stored calendar for `symbols` from `client`, replacing each
 * covered symbol's record. Symbols absent from the provider response are left
 * untouched (a transient gap shouldn't wipe a still-valid date); stale past
 * dates are pruned so they don't linger. Returns coverage counts. Throws only on
 * a hard client failure (HTTP error) so the caller can log + continue.
 */
export async function refreshEarningsCalendar(
  client: EarningsCalendarClient,
  symbols: readonly string[],
): Promise<EarningsRefreshResult> {
  const map = await ensureLoaded();
  const upper = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const fetched = await client.getUpcomingEarnings(upper);
  const now = Date.now();
  let covered = 0;
  let uncovered = 0;
  for (const sym of upper) {
    const date = fetched.get(sym);
    if (date) {
      map.set(sym, { date, fetchedAt: now });
      covered++;
    } else {
      // No upcoming event in the window — drop any stale record we held.
      if (map.has(sym)) map.delete(sym);
      uncovered++;
    }
  }
  cache = map;
  await persist();
  log.info('earnings calendar refreshed', { requested: upper.length, covered, uncovered });
  return { covered, uncovered };
}

/**
 * Build an `EarningsCalendarClient` from `FINNHUB_API_TOKEN`, or `null` when the
 * token is unset (the refresh job then logs + skips, leaving equity/options
 * trading unaffected).
 */
export function makeEarningsClientFromEnv(): EarningsCalendarClient | null {
  const token = (process.env['FINNHUB_API_TOKEN'] ?? '').trim();
  if (!token) return null;
  return new EarningsCalendarClient(token);
}

/** Test-only: reset the in-memory cache and (optionally) override the on-disk path. */
export function __resetEarningsStoreForTests(overridePath?: string | null): void {
  cache = null;
  storeFileOverride = overridePath ?? null;
}
