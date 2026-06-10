// TRA-745 — fetch the per-symbol StockTwits social-sentiment read for the
// watchlist from `GET /api/analysis/breadth/:symbol` (the `social` half +
// `notes.social` reason). Returns a symbol → {social, note} map the watchlist
// row consumes via <SocialSentimentBadge>. Refreshes on a slow interval (the
// social aggregate is a 24h window — it does not need quote-level cadence) and
// degrades quietly: a failed fetch leaves a null read with a human reason rather
// than throwing.
import { useEffect, useState } from 'react';
import type { SocialSentiment } from '@trading-app/shared';
import { HTTP_URL } from '../server-url';
import { logger } from '../lib/logger';

/** One symbol's social read, or a null feed with the reason it's empty. */
export interface SocialRead {
  social: SocialSentiment | null;
  note?: string;
}

/** Shape of the slice of `GET /api/analysis/breadth/:symbol` we consume. */
interface BreadthResponse {
  social: SocialSentiment | null;
  notes?: { social?: string };
}

const REFRESH_MS = 2 * 60_000;

export function useSocialSentiment(
  token: string,
  symbols: string[],
): Record<string, SocialRead> {
  const [reads, setReads] = useState<Record<string, SocialRead>>({});
  // Stable dependency so the effect re-runs only when the symbol set changes,
  // not on every parent render that hands us a fresh array reference.
  const key = symbols.join(',');

  useEffect(() => {
    if (!key) {
      setReads({});
      return;
    }
    const list = key.split(',');
    let cancelled = false;

    async function loadOne(sym: string): Promise<[string, SocialRead]> {
      try {
        const r = await fetch(`${HTTP_URL}/api/analysis/breadth/${encodeURIComponent(sym)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) {
          return [sym, { social: null, note: `social feed unavailable (HTTP ${r.status})` }];
        }
        const data = (await r.json()) as BreadthResponse;
        return [sym, { social: data.social ?? null, note: data.notes?.social }];
      } catch (err) {
        logger.warn('social-sentiment', `breadth fetch failed for ${sym}`, err);
        return [sym, { social: null, note: 'social feed unavailable — network error' }];
      }
    }

    async function loadAll() {
      const entries = await Promise.all(list.map(loadOne));
      if (!cancelled) setReads(Object.fromEntries(entries));
    }

    loadAll();
    const id = setInterval(loadAll, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [key, token]);

  return reads;
}
