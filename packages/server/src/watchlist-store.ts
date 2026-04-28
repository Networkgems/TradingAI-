import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WATCHLIST, CRYPTO_WATCHLIST } from '@trading-app/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');

// TRA-142 — watchlists are now per-user. Each user has their own
// DATA_DIR/users/<username>/watchlist.json. The legacy global watchlist file
// is migrated into the admin namespace by runFirstBootMigration.

interface WatchlistData {
  crypto: { added: string[]; hidden: string[] };
  stocks: { added: string[]; hidden: string[] };
}

function emptyData(): WatchlistData {
  return { crypto: { added: [], hidden: [] }, stocks: { added: [], hidden: [] } };
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
      crypto: { added: parsed.crypto?.added ?? [], hidden: parsed.crypto?.hidden ?? [] },
      stocks: { added: parsed.stocks?.added ?? [], hidden: parsed.stocks?.hidden ?? [] },
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

export function getCryptoWatchlistData(username: string): { all: string[]; added: string[]; hidden: string[] } {
  const { added, hidden } = getCache(username).crypto;
  const hiddenSet = new Set(hidden);
  const base = (CRYPTO_WATCHLIST as readonly string[]).filter(s => !hiddenSet.has(s));
  const addedNotInBase = added.filter(s => !base.includes(s));
  return { all: [...base, ...addedNotInBase], added, hidden };
}

export function getStocksWatchlistData(username: string): { all: string[]; added: string[]; hidden: string[] } {
  const { added, hidden } = getCache(username).stocks;
  const hiddenSet = new Set(hidden);
  const base = (WATCHLIST as readonly string[]).filter(s => !hiddenSet.has(s));
  const addedNotInBase = added.filter(s => !base.includes(s));
  return { all: [...base, ...addedNotInBase], added, hidden };
}

export async function addCryptoSymbol(username: string, symbol: string): Promise<void> {
  const d = getCache(username);
  d.crypto.hidden = d.crypto.hidden.filter(s => s !== symbol);
  if (!(CRYPTO_WATCHLIST as readonly string[]).includes(symbol) && !d.crypto.added.includes(symbol)) {
    d.crypto.added.push(symbol);
  }
  await persist(username);
}

export async function removeCryptoSymbol(username: string, symbol: string): Promise<void> {
  const d = getCache(username);
  if ((CRYPTO_WATCHLIST as readonly string[]).includes(symbol)) {
    if (!d.crypto.hidden.includes(symbol)) d.crypto.hidden.push(symbol);
  } else {
    d.crypto.added = d.crypto.added.filter(s => s !== symbol);
  }
  await persist(username);
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
