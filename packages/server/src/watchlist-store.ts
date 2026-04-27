import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WATCHLIST, CRYPTO_WATCHLIST } from '@trading-app/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');
const WATCHLIST_FILE = join(DATA_DIR, 'watchlist.json');

interface WatchlistData {
  crypto: { added: string[]; hidden: string[] };
  stocks: { added: string[]; hidden: string[] };
}

let cached: WatchlistData | null = null;

export async function initWatchlistStore(): Promise<void> {
  if (cached) return;
  if (!existsSync(WATCHLIST_FILE)) {
    cached = { crypto: { added: [], hidden: [] }, stocks: { added: [], hidden: [] } };
    return;
  }
  try {
    const raw = await readFile(WATCHLIST_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WatchlistData>;
    cached = {
      crypto: { added: parsed.crypto?.added ?? [], hidden: parsed.crypto?.hidden ?? [] },
      stocks: { added: parsed.stocks?.added ?? [], hidden: parsed.stocks?.hidden ?? [] },
    };
  } catch {
    cached = { crypto: { added: [], hidden: [] }, stocks: { added: [], hidden: [] } };
  }
}

function getCache(): WatchlistData {
  return cached ?? { crypto: { added: [], hidden: [] }, stocks: { added: [], hidden: [] } };
}

async function persist(): Promise<void> {
  if (!cached) return;
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(WATCHLIST_FILE, JSON.stringify(cached, null, 2), 'utf-8');
}

export function getCryptoWatchlistData(): { all: string[]; added: string[]; hidden: string[] } {
  const { added, hidden } = getCache().crypto;
  const hiddenSet = new Set(hidden);
  const base = (CRYPTO_WATCHLIST as readonly string[]).filter(s => !hiddenSet.has(s));
  const addedNotInBase = added.filter(s => !base.includes(s));
  return { all: [...base, ...addedNotInBase], added, hidden };
}

export function getStocksWatchlistData(): { all: string[]; added: string[]; hidden: string[] } {
  const { added, hidden } = getCache().stocks;
  const hiddenSet = new Set(hidden);
  const base = (WATCHLIST as readonly string[]).filter(s => !hiddenSet.has(s));
  const addedNotInBase = added.filter(s => !base.includes(s));
  return { all: [...base, ...addedNotInBase], added, hidden };
}

export async function addCryptoSymbol(symbol: string): Promise<void> {
  const d = getCache();
  d.crypto.hidden = d.crypto.hidden.filter(s => s !== symbol);
  if (!(CRYPTO_WATCHLIST as readonly string[]).includes(symbol) && !d.crypto.added.includes(symbol)) {
    d.crypto.added.push(symbol);
  }
  await persist();
}

export async function removeCryptoSymbol(symbol: string): Promise<void> {
  const d = getCache();
  if ((CRYPTO_WATCHLIST as readonly string[]).includes(symbol)) {
    if (!d.crypto.hidden.includes(symbol)) d.crypto.hidden.push(symbol);
  } else {
    d.crypto.added = d.crypto.added.filter(s => s !== symbol);
  }
  await persist();
}

export async function addStocksSymbol(symbol: string): Promise<void> {
  const d = getCache();
  d.stocks.hidden = d.stocks.hidden.filter(s => s !== symbol);
  if (!(WATCHLIST as readonly string[]).includes(symbol) && !d.stocks.added.includes(symbol)) {
    d.stocks.added.push(symbol);
  }
  await persist();
}

export async function removeStocksSymbol(symbol: string): Promise<void> {
  const d = getCache();
  if ((WATCHLIST as readonly string[]).includes(symbol)) {
    if (!d.stocks.hidden.includes(symbol)) d.stocks.hidden.push(symbol);
  } else {
    d.stocks.added = d.stocks.added.filter(s => s !== symbol);
  }
  await persist();
}
