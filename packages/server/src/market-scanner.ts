import YahooFinance from 'yahoo-finance2';
import { WATCHLIST, assessQuotePlausibility, describeQuoteSuspicion } from '@trading-app/shared';
import { logger } from './observability/index.js';

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
 *
 * TRA-3243 — WHICH PROPOSITION THIS CONSUMER NEEDS: **P-now**, and it is the only
 * one available here. Per the module note above, this path never touches
 * `symbolState`, so there is no session history for a Yahoo screener row and no
 * `moveSuspectSession` to read — `assessQuotePlausibility` on the row's own numbers
 * is the whole instrument. That is also the right proposition: the scanner's
 * question is "is this worth ADDING to a watchlist", a fresh decision about a symbol
 * we may never have ticked, not "may today's published move be ranked in a document
 * a human reads as the session summary" (which is EOD movers, and that one is
 * P-session).
 *
 * ⚠️ Residual, stated rather than papered over: a symbol the engine condemned at
 * 15:00 can still be suggested by a 15:30 screener call if its ratio has fallen back
 * under the bar. That is bounded — a suggestion is not a publication, and the engine
 * re-condemns the row on its next tick, at which point every ranking surface honours
 * P-session. Closing it would mean giving this module an engine-state dependency it
 * was deliberately built without.
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

