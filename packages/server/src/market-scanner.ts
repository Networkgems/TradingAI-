import YahooFinance from 'yahoo-finance2';
import { WATCHLIST, CRYPTO_WATCHLIST, isCryptoSymbolBlocked, assessQuotePlausibility, describeQuoteSuspicion } from '@trading-app/shared';
import { logger } from './observability/index.js';
import { isCoinbaseListed, refreshCoinbaseProductCatalog } from './crypto-feed.js';

const log = logger.child({ module: 'market-scanner' });

/**
 * TRA-2379 — this module does NOT read `symbolState`; it makes its own Yahoo
 * screener calls, so the `quoteStatus:'suspect'` that `signal-engine.applyQuotes`
 * stamps is invisible here. The plausibility rule therefore has to be applied
 * independently, against the screener's own price/change fields.
 *
 * `yahoo-finance2` types the screener rows loosely, so narrow only what we read.
 */
export interface ScreenerMoveFields {
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
}

/**
 * True when a screener row's published move should not be ranked.
 *
 * Logs every exclusion: per TRA-2379 decision 2 a silent drop reads identically to
 * "nothing was wrong", which is the failure this ticket exists to end.
 */
export function isScreenerMoveSuspect(symbol: string, q: ScreenerMoveFields, reason: ScanReason): boolean {
  const input = {
    price: q.regularMarketPrice ?? NaN,
    change: q.regularMarketChange,
    changePct: q.regularMarketChangePercent,
  };
  if (!assessQuotePlausibility(input).suspect) return false;
  log.warn('scanner suggestion EXCLUDED — implausible published move', {
    issue: 'TRA-2379',
    symbol,
    reason,
    detail: describeQuoteSuspicion(symbol, input),
  });
  return true;
}

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'], validation: { logErrors: true } });

const CMC_API_KEY = process.env.CMC_API_KEY ?? '';
const CMC_BASE = 'https://pro-api.coinmarketcap.com';

export type ScanReason = 'gainer' | 'loser' | 'volume' | 'trending';

export interface ScanResult {
  symbol: string;
  reason: ScanReason;
  changePct?: number;
  volume?: number;
}

function dedup(results: ScanResult[]): ScanResult[] {
  const seen = new Set<string>();
  return results.filter(r => { if (seen.has(r.symbol)) return false; seen.add(r.symbol); return true; });
}

function filterNew(results: ScanResult[], alreadyDefault: readonly string[]): ScanResult[] {
  const set = new Set((alreadyDefault as string[]).map(s => s.toUpperCase()));
  return results.filter(r => !set.has(r.symbol));
}

export async function scanStocksMarket(): Promise<ScanResult[]> {
  const collected: ScanResult[] = [];

  // Day gainers
  try {
    const gainers = await yf.screener({ scrIds: 'day_gainers', count: 10 });
    for (const q of gainers.quotes) {
      if (q.symbol && q.quoteType === 'EQUITY') {
        // TRA-2379 — a screener ranks by the same unbounded changePct the feed
        // publishes, so an unadjusted prev close puts a fabricated +8,951% move at
        // the top of the suggestion list. Refuse to rank it (and say so).
        if (isScreenerMoveSuspect(q.symbol, q, 'gainer')) continue;
        collected.push({ symbol: q.symbol, reason: 'gainer', changePct: q.regularMarketChangePercent });
      }
    }
  } catch (err: unknown) {
    log.warn('screener failed', { screener: 'day_gainers', reason: err instanceof Error ? err.message : String(err) });
  }

  // Day losers (big moves worth watching)
  try {
    const losers = await yf.screener({ scrIds: 'day_losers', count: 10 });
    for (const q of losers.quotes) {
      if (q.symbol && q.quoteType === 'EQUITY') {
        // TRA-2379 — same rule on the losing side. The ratio statistic is
        // direction-free precisely so an unadjusted FORWARD split (which reads as
        // a large negative, never a large positive) is caught here too.
        if (isScreenerMoveSuspect(q.symbol, q, 'loser')) continue;
        collected.push({ symbol: q.symbol, reason: 'loser', changePct: q.regularMarketChangePercent });
      }
    }
  } catch (err: unknown) {
    log.warn('screener failed', { screener: 'day_losers', reason: err instanceof Error ? err.message : String(err) });
  }

  // Most active by volume
  try {
    const active = await yf.screener({ scrIds: 'most_actives', count: 10 });
    for (const q of active.quotes) {
      if (q.symbol && q.quoteType === 'EQUITY') {
        collected.push({ symbol: q.symbol, reason: 'volume', volume: q.regularMarketVolume });
      }
    }
  } catch (err: unknown) {
    log.warn('screener failed', { screener: 'most_actives', reason: err instanceof Error ? err.message : String(err) });
  }

  // Trending symbols (news/search-driven)
  try {
    const trending = await yf.trendingSymbols('US', { count: 20 });
    for (const q of trending.quotes) {
      // Skip crypto and forex symbols
      if (q.symbol && !q.symbol.includes('-') && !q.symbol.includes('=')) {
        collected.push({ symbol: q.symbol, reason: 'trending' });
      }
    }
  } catch (err: unknown) {
    log.warn('trendingSymbols failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  return filterNew(dedup(collected), WATCHLIST);
}

export async function scanCryptoMarket(): Promise<ScanResult[]> {
  const collected: ScanResult[] = [];

  // TRA-300 — scanner suggestions must be tradable on Coinbase. CMC's
  // top-volume / top-gainer lists include thousands of obscure tokens
  // (SUL-USD, WEVER-USD, NEFTY-USD, …) that Coinbase doesn't list. Adding
  // them to the watchlist is pure noise: per TRA-338 the entry gate refuses
  // to open positions on non-Coinbase symbols, and the quote cascade then
  // burns its Yahoo budget on every tick trying to price them — which trips
  // the shared 429 breaker and labels the entire watchlist
  // "Quote unavailable — provider rate-limited". Warm the catalog first so
  // the final filter below has authoritative data instead of a cold-cache
  // `null` that would force fail-open.
  await refreshCoinbaseProductCatalog();

  if (CMC_API_KEY) {
    // Top by 24h volume
    try {
      const resp = await fetch(
        `${CMC_BASE}/v1/cryptocurrency/listings/latest?limit=30&sort=volume_24h&convert=USD`,
        { headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' } },
      );
      if (resp.ok) {
        const json = (await resp.json()) as {
          data?: Array<{ symbol: string; quote?: { USD?: { volume_24h?: number; percent_change_24h?: number } } }>;
        };
        for (const coin of json.data ?? []) {
          const sym = `${coin.symbol.toUpperCase()}-USD`;
          const usd = coin.quote?.USD;
          collected.push({ symbol: sym, reason: 'volume', volume: usd?.volume_24h, changePct: usd?.percent_change_24h });
        }
      }
    } catch { /* ignore */ }

    // Top gainers by 24h % change
    try {
      const resp = await fetch(
        `${CMC_BASE}/v1/cryptocurrency/listings/latest?limit=20&sort=percent_change_24h&sort_dir=desc&convert=USD`,
        { headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' } },
      );
      if (resp.ok) {
        const json = (await resp.json()) as {
          data?: Array<{ symbol: string; quote?: { USD?: { volume_24h?: number; percent_change_24h?: number } } }>;
        };
        for (const coin of json.data ?? []) {
          const sym = `${coin.symbol.toUpperCase()}-USD`;
          const usd = coin.quote?.USD;
          collected.push({ symbol: sym, reason: 'gainer', changePct: usd?.percent_change_24h, volume: usd?.volume_24h });
        }
      }
    } catch { /* ignore */ }
  }

  // Yahoo Finance trending (may include crypto like BTC-USD)
  try {
    const trending = await yf.trendingSymbols('US', { count: 30 });
    for (const q of trending.quotes) {
      if (q.symbol && q.symbol.endsWith('-USD')) {
        collected.push({ symbol: q.symbol, reason: 'trending' });
      }
    }
  } catch (err: unknown) {
    log.warn('trendingSymbols failed', { market: 'crypto', reason: err instanceof Error ? err.message : String(err) });
  }

  // TRA-283: drop denylisted tickers from scanner suggestions so they can't be
  // re-added via the "Scan Market" UI flow.
  const blocked = collected.filter(r => !isCryptoSymbolBlocked(r.symbol));

  // TRA-300 — final Coinbase-listed gate. Fail-closed: if the catalog refresh
  // above failed and `isCoinbaseListed` returns `null` for every symbol, we
  // suggest nothing this scan rather than re-introducing the noise we just
  // fixed. The next scan attempt re-warms the catalog and proceeds normally.
  const tradable = blocked.filter(r => isCoinbaseListed(r.symbol) === true);
  return filterNew(dedup(tradable), CRYPTO_WATCHLIST);
}
