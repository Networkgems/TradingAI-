import YahooFinance from 'yahoo-finance2';
import { WATCHLIST, CRYPTO_WATCHLIST, isCryptoSymbolBlocked } from '@trading-app/shared';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'market-scanner' });

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
  return filterNew(dedup(blocked), CRYPTO_WATCHLIST);
}
