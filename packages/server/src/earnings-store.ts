import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { EarningsCalendarClient, daysUntil } from '@trading-app/engine';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';

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

function defaultStoreFile(): string {
  const root = resolveDataDir();
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
  /**
   * TRA-4706 — the most recent PAST earnings date per symbol (`YYYY-MM-DD`).
   * Optional so a pre-TRA-4706 file still loads.
   */
  previous?: Record<string, string>;
}

let cache: Map<string, EarningsRecord> | null = null;
/**
 * TRA-4706 — `symbol → most recent past earnings date`. Kept APART from `cache`
 * so every existing reader (the `unpopulated` / `covered` split, `coveredSymbols`)
 * keeps meaning "upcoming dates" exactly as before.
 *
 * ⛔ Why it exists: the refresh used to overwrite or delete a record the moment
 * its date passed, so the one date the post-earnings swing scanner needs — the
 * report that just happened — was thrown away by the 9 AM ET refresh that
 * follows it. The refresh now moves it here instead.
 */
let previous: Map<string, string> = new Map();

async function ensureLoaded(): Promise<Map<string, EarningsRecord>> {
  if (cache) return cache;
  const path = storeFile();
  if (!existsSync(path)) {
    cache = new Map();
    previous = new Map();
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
    const prev = new Map<string, string>();
    if (parsed.previous && typeof parsed.previous === 'object') {
      for (const [sym, date] of Object.entries(parsed.previous)) {
        if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) prev.set(sym.toUpperCase(), date);
      }
    }
    cache = map;
    previous = prev;
  } catch (err) {
    log.error('failed to read earnings store, starting empty', {
      reason: err instanceof Error ? err.message : String(err),
    });
    cache = new Map();
    previous = new Map();
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
    previous: Object.fromEntries(previous),
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

/**
 * TRA-4642 (parent TRA-4413 item 1) — the readability-aware read. The plain
 * `earningsInDaysSync` collapses FOUR worlds into one `null`: store never
 * loaded, store loaded-but-never-refreshed (no FINNHUB token / refresh never
 * ran), symbol genuinely without an upcoming event, and a stored date that has
 * already passed. A consumer that must not launder a calendar outage into a
 * clean "no earnings" pass (the TRA-4424 trap) needs the split.
 *
 * States:
 *  - `unloaded`    — `initEarningsStore` has not run; the cache is dark.
 *  - `unpopulated` — loaded but EMPTY. Read as an outage, not as "no name in
 *    the universe has earnings": with a real symbol universe and the client's
 *    fetch horizon, an empty store means the refresh never succeeded (token
 *    missing, boot refresh failed). The conservative direction is unreadable.
 *  - `uncovered`   — store has data; THIS symbol has no usable upcoming date
 *    (absent, or the stored date passed and awaits the next refresh's prune).
 *    This is the store's own "no earnings scheduled" semantics — identical to
 *    what `earningsInDaysSync` hands the news-catalyst scorer today.
 *  - `covered`     — an upcoming date exists; `days` is non-null.
 *
 * `days` is EXACTLY `earningsInDaysSync(symbol, asOf)` in every state, so a
 * consumer routing this into `computeCatalystScore` consults the demoter on
 * the same input the news-catalyst path would have.
 */
export type EarningsCalendarReadState = 'unloaded' | 'unpopulated' | 'covered' | 'uncovered';

export interface EarningsCalendarRead {
  state: EarningsCalendarReadState;
  /** Days to next earnings; non-null iff `state === 'covered'`. */
  days: number | null;
  /** Symbols currently holding an upcoming date (0 when unloaded/unpopulated). */
  coveredSymbols: number;
}

export function earningsCalendarReadSync(
  symbol: string,
  asOf: number = Date.now(),
): EarningsCalendarRead {
  if (!cache) return { state: 'unloaded', days: null, coveredSymbols: 0 };
  if (cache.size === 0) return { state: 'unpopulated', days: null, coveredSymbols: 0 };
  const days = daysFromRecord(cache.get(symbol.trim().toUpperCase()), asOf);
  if (days === null) return { state: 'uncovered', days: null, coveredSymbols: cache.size };
  return { state: 'covered', days, coveredSymbols: cache.size };
}

/** Store-level status for health surfaces (no per-symbol argument needed). */
export function earningsStoreStatusSync(): { loaded: boolean; coveredSymbols: number } {
  return { loaded: cache !== null, coveredSymbols: cache?.size ?? 0 };
}

function daysFromRecord(rec: EarningsRecord | undefined, asOf: number): number | null {
  if (!rec) return null;
  const d = daysUntil(rec.date, asOf);
  // A stored date that has already passed is stale (the next refresh replaces
  // it); treat it as unknown rather than returning a negative count.
  if (d === null || d < 0) return null;
  return d;
}

/**
 * TRA-4706 — the most recent earnings date on or before `asOf`'s day, for the
 * post-earnings swing scanner.
 *
 * Three states, not a nullable date, for the same reason as
 * {@link earningsCalendarReadSync}: a dark calendar must not read as "no recent
 * earnings". `unreadable` = store not loaded, or loaded with nothing in it
 * (the refresh never succeeded). `none` = the store is live and holds no past
 * date for this symbol within its memory.
 *
 * Sources, newest wins: the upcoming record once its date has arrived (between
 * the report and the next refresh it is still sitting there), then the
 * `previous` date the refresh moved aside.
 */
export type RecentEarningsRead =
  | { state: 'recent'; date: string }
  | { state: 'none' }
  | { state: 'unreadable' };

export function recentEarningsDateSync(symbol: string, asOf: number = Date.now()): RecentEarningsRead {
  if (!cache || (cache.size === 0 && previous.size === 0)) return { state: 'unreadable' };
  const sym = symbol.trim().toUpperCase();
  const candidates = [cache.get(sym)?.date, previous.get(sym)].filter(
    (d): d is string => typeof d === 'string' && (daysUntil(d, asOf) ?? 1) <= 0,
  );
  if (candidates.length === 0) return { state: 'none' };
  return { state: 'recent', date: candidates.sort().at(-1)! };
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
    // TRA-4706 — a held date that has arrived is about to be replaced or
    // dropped; keep it as the symbol's most recent report first.
    const held = map.get(sym)?.date;
    if (held && (daysUntil(held, now) ?? 1) <= 0 && held !== date) {
      const prior = previous.get(sym);
      if (!prior || held > prior) previous.set(sym, held);
    }
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
  previous = new Map();
  storeFileOverride = overridePath ?? null;
}
