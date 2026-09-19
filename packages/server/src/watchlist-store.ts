import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { WATCHLIST, type ReviewBlock } from '@trading-app/shared';
import { resolveDataDir } from './data-dir.js';

const DATA_DIR = resolveDataDir();

// TRA-142 — watchlists are now per-user. Each user has their own
// DATA_DIR/users/<username>/watchlist.json. The legacy global watchlist file
// is migrated into the admin namespace by runFirstBootMigration.
//
// TRA-4729 — stocks only. The crypto half (and CRYPTO_WATCHLIST) went with the
// crypto engine (TRA-4629); a legacy `crypto` key in an old file is ignored on
// load and dropped on the next write.

// TRA-950 — hard cap on how many leaders a single review may seed into the
// watchlist, so a runaway review block can never blow past the size/risk caps.
export const MAX_REVIEW_LEADERS = 15;

interface WatchlistData {
  stocks: {
    added: string[];
    hidden: string[];
    /**
     * TRA-950 — the subset of `added` that was auto-seeded from the latest
     * review block's `leaders`. Tagged so it can be distinguished from
     * user/QuantTrader manual adds and EXPIRED when a newer review drops them.
     */
    reviewSourced?: string[];
    /** TRA-950 — advisory invalidation levels (symbol → price) from the review. */
    invalidationLevels?: Record<string, number>;
  };
}

function emptyData(): WatchlistData {
  return {
    stocks: { added: [], hidden: [], reviewSourced: [], invalidationLevels: {} },
  };
}

function watchlistFile(username: string): string {
  return join(DATA_DIR, 'users', username, 'watchlist.json');
}

const cache: Map<string, WatchlistData> = new Map();

export async function initWatchlistStore(username: string): Promise<void> {
  if (cache.has(username)) return;
  const file = watchlistFile(username);
  if (!existsSync(file)) {
    cache.set(username, emptyData());
    return;
  }
  try {
    const raw = await readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WatchlistData>;
    cache.set(username, {
      stocks: {
        added: parsed.stocks?.added ?? [],
        hidden: parsed.stocks?.hidden ?? [],
        reviewSourced: parsed.stocks?.reviewSourced ?? [],
        invalidationLevels: parsed.stocks?.invalidationLevels ?? {},
      },
    });
  } catch {
    cache.set(username, emptyData());
  }
}

function getCache(username: string): WatchlistData {
  let data = cache.get(username);
  if (!data) {
    data = emptyData();
    cache.set(username, data);
  }
  return data;
}

async function persist(username: string): Promise<void> {
  const data = cache.get(username);
  if (!data) return;
  const dir = dirname(watchlistFile(username));
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(watchlistFile(username), JSON.stringify(data, null, 2), 'utf-8');
}

export function getStocksWatchlistData(username: string): { all: string[]; added: string[]; hidden: string[] } {
  const { added, hidden } = getCache(username).stocks;
  const hiddenSet = new Set(hidden);
  const base = (WATCHLIST as readonly string[]).filter(s => !hiddenSet.has(s));
  const addedNotInBase = added.filter(s => !base.includes(s));
  return { all: [...base, ...addedNotInBase], added, hidden };
}

export async function addStocksSymbol(username: string, symbol: string): Promise<void> {
  const d = getCache(username);
  d.stocks.hidden = d.stocks.hidden.filter(s => s !== symbol);
  if (!(WATCHLIST as readonly string[]).includes(symbol) && !d.stocks.added.includes(symbol)) {
    d.stocks.added.push(symbol);
  }
  await persist(username);
}

export async function removeStocksSymbol(username: string, symbol: string): Promise<void> {
  const d = getCache(username);
  if ((WATCHLIST as readonly string[]).includes(symbol)) {
    if (!d.stocks.hidden.includes(symbol)) d.stocks.hidden.push(symbol);
  } else {
    d.stocks.added = d.stocks.added.filter(s => s !== symbol);
  }
  await persist(username);
}

export function clearWatchlistCache(username: string): void {
  cache.delete(username);
}

// ── TRA-950: review-block → watchlist merge ───────────────────────────────────

/**
 * Pure merge of a review's `leaders` into an existing stocks watchlist. Used by
 * {@link seedReviewLeaders} and unit-tested directly. Rules:
 *   • de-duped — a leader already present is never added twice;
 *   • respects `hidden` — a symbol the user removed is NOT resurrected;
 *   • skips base-list symbols — those are already in the watchlist by default
 *     (they need no `added` entry), but they still don't count toward the cap;
 *   • capped — at most `cap` review-sourced symbols are tagged/added, so a
 *     runaway block can't blow past the watchlist size cap;
 *   • expires stale review leaders — a symbol previously review-sourced but
 *     absent from the latest leaders is dropped from `added` (user/manual adds,
 *     which are not in `reviewSourced`, are left untouched).
 *
 * Returns the next `added` + `reviewSourced` arrays; never mutates its inputs.
 */
export function mergeReviewLeaders(
  current: { added: string[]; hidden: string[]; reviewSourced: string[] },
  leaders: string[],
  baseSymbols: readonly string[],
  cap: number = MAX_REVIEW_LEADERS,
): { added: string[]; reviewSourced: string[] } {
  const up = (s: string): string => s.trim().toUpperCase();
  const leaderSet = new Set(leaders.map(up).filter(Boolean));
  const baseSet = new Set(baseSymbols.map(up));
  const hiddenSet = new Set(current.hidden.map(up));
  const prevReview = new Set(current.reviewSourced.map(up));

  // 1. Expire previously review-sourced symbols the latest review no longer
  //    features. Manual adds (not in prevReview) survive untouched.
  const added = current.added.filter((s) => {
    const u = up(s);
    return !(prevReview.has(u) && !leaderSet.has(u));
  });
  const addedSet = new Set(added.map(up));

  // 2. Merge the latest leaders (order-preserved, de-duped, hidden/base/cap-aware).
  const reviewSourced: string[] = [];
  for (const sym of leaderSet) {
    if (reviewSourced.length >= cap) break;
    if (hiddenSet.has(sym)) continue; // user removed it — respect that
    if (baseSet.has(sym)) continue; // already in the watchlist by default
    if (!addedSet.has(sym)) {
      added.push(sym);
      addedSet.add(sym);
    }
    reviewSourced.push(sym);
  }
  return { added, reviewSourced };
}

/**
 * TRA-950 (Part B) — merge the latest review block's `leaders` into a user's
 * stocks watchlist at session boot, tagging them review-sourced and recording
 * the advisory invalidation levels. Idempotent: re-seeding the same block is a
 * no-op; seeding a newer block expires the previous review's leaders. Returns
 * the symbols that ended up review-sourced.
 */
export async function seedReviewLeaders(
  username: string,
  block: ReviewBlock,
): Promise<{ reviewSourced: string[] }> {
  const d = getCache(username);
  const { added, reviewSourced } = mergeReviewLeaders(
    {
      added: d.stocks.added,
      hidden: d.stocks.hidden,
      reviewSourced: d.stocks.reviewSourced ?? [],
    },
    block.leaders,
    WATCHLIST as readonly string[],
  );
  d.stocks.added = added;
  d.stocks.reviewSourced = reviewSourced;
  // Advisory metadata only — no order behavior keys off these (TRA-950 scope).
  d.stocks.invalidationLevels = { ...block.invalidationLevels };
  await persist(username);
  return { reviewSourced };
}

/**
 * TRA-950 — read the review-sourced provenance + advisory invalidation levels
 * for a user's stocks watchlist (so the UI / agents can distinguish + expire
 * review leaders). Empty when no review has seeded the watchlist yet.
 */
export function getReviewWatchlistMeta(
  username: string,
): { reviewSourced: string[]; invalidationLevels: Record<string, number> } {
  const s = getCache(username).stocks;
  return {
    reviewSourced: s.reviewSourced ?? [],
    invalidationLevels: s.invalidationLevels ?? {},
  };
}
