// TRA-1629 (TRA-1623A, parent TRA-1623) — D1 news-catalyst watchlist source.
//
// Turns the free Yahoo market news (yahoo-feed.ts `fetchMarketNews`) into a
// *discovery* engine: map headlines → tickers via the existing
// `newsMentionsSymbol` + `EQUITY_NAME_ALIASES` seams, score each name with the
// pure §4 `computeCatalystScore`, gate on eligibility, and hand the top-8 back
// as a `news_catalyst` source for the smart watchlist. Every scored candidate
// (chosen or dropped) is written to the shadow ledger so QuantTrader can
// forward-validate on the TRA-532 gate.
//
// Flag-gated (`ENABLE_NEWS_CATALYST_WATCHLIST`, DEFAULT OFF) and observe-only —
// this only ADDS names to the watchlist for the engine to *watch*; it routes no
// order, sizes nothing, and touches no exit. The provider seam is generic (news
// + per-name metrics are injected), so a premium feed drops in later in a
// board-gated Phase 2 without changing the selection logic below.

import type { CatalystScore, NewsItem } from '@trading-app/shared';
import {
  WATCHLIST,
  WATCHLIST_MIN_PRICE,
  aggregateSymbolSentiment,
  nameAliasesFor,
  newsMentionsSymbol,
  computeCatalystScore,
  EQUITY_NAME_ALIASES,
  CATALYST_FRESHNESS_MAX_MINUTES,
} from '@trading-app/shared';
import { fetchDailyCandles } from './yahoo-feed.js';
import {
  recordCatalystObservation,
  type CatalystDropReason,
  type CatalystObservationInput,
} from './news-catalyst-ledger.js';
import { recordCatalystRun } from './news-catalyst-run-ledger.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'news-catalyst-source' });

/** Top-N names injected into the watchlist per run (§4 cap). */
export const CATALYST_TOP_N = 8;

/**
 * Directional liquidity floor (avg $-volume) reused from the options-directional
 * quality gate — the same bar the live desk uses so a catalyst name is at least
 * as tradable as anything we'd route. Kept as a module constant (not imported
 * from the gate) so the pure selection stays dependency-light and testable.
 */
export const CATALYST_MIN_AVG_DOLLAR_VOLUME_DEFAULT = 250_000;

/**
 * The candidate universe we can map headlines onto: the base WATCHLIST plus every
 * symbol carrying a company-name alias. This is the honest Phase-1 constraint —
 * free Yahoo news + our alias table can only *discover* names inside our known
 * universe (a name here that the price/volume screener missed is still a
 * discovery). A premium feed that tags tickers directly widens this in Phase 2.
 */
export function catalystUniverse(): string[] {
  const set = new Set<string>();
  for (const s of WATCHLIST as readonly string[]) set.add(s.toUpperCase());
  for (const s of Object.keys(EQUITY_NAME_ALIASES)) set.add(s.toUpperCase());
  return [...set];
}

/** Per-name catalyst inputs, assembled from news + market metrics. */
export interface CatalystCandidate {
  symbol: string;
  netScore: number;
  tilt: 'bullish' | 'bearish' | 'neutral';
  freshHeadlineCount: number;
  freshnessMinutes: number;
  rvolZ: number;
  gapPct: number;
  /** Latest price, or null when uncovered. */
  price: number | null;
  /** Trailing avg $-volume, or null when uncovered. */
  avgDollarVol: number | null;
  /** Sessions until next earnings, or null. */
  earningsInDays: number | null;
}

/** A chosen (or scored-then-dropped) name plus its computed score. */
export interface ScoredCandidate extends CatalystCandidate {
  score: CatalystScore;
  chosen: boolean;
  dropReason: CatalystDropReason | null;
}

export interface SelectOptions {
  minPrice?: number;
  minAvgDollarVol?: number;
  hidden?: ReadonlySet<string>;
  cap?: number;
  /** Predicate for a tradable US equity — defaults to "in the catalyst universe". */
  tradable?: (symbol: string) => boolean;
}

/**
 * Map a market-news stream onto candidate tickers using the existing
 * `newsMentionsSymbol` + alias seams, then fold each name's mapped headlines into
 * a recency-weighted sentiment aggregate. Pure given `now`. Only names actually
 * mentioned (articleCount ≥ 1) become candidates. `rvolZ`/`gapPct`/`price`/
 * `avgDollarVol`/`earningsInDays` are left at their neutral defaults here — the
 * caller enriches them via a metrics provider before {@link scoreAndSelect}.
 */
export function mapNewsToCandidates(
  news: readonly NewsItem[],
  now: number,
  universe: readonly string[] = catalystUniverse(),
): CatalystCandidate[] {
  const out: CatalystCandidate[] = [];
  for (const symbol of universe) {
    const names = nameAliasesFor(symbol);
    const mapped = news.filter((n) => newsMentionsSymbol(n, symbol, names));
    if (mapped.length === 0) continue;

    const agg = aggregateSymbolSentiment({ symbol, names, news: mapped, now });
    const freshHeadlineCount = mapped.filter((n) => {
      const ageMin = (now - Date.parse(n.publishedAt)) / 60000;
      return Number.isFinite(ageMin) && ageMin <= CATALYST_FRESHNESS_MAX_MINUTES;
    }).length;

    out.push({
      symbol,
      netScore: agg.netScore,
      tilt: agg.tilt,
      freshHeadlineCount,
      freshnessMinutes: agg.freshnessMinutes,
      rvolZ: 0,
      gapPct: 0,
      price: null,
      avgDollarVol: null,
      earningsInDays: null,
    });
  }
  return out;
}

/**
 * Score every candidate with `computeCatalystScore`, apply the §4 eligibility
 * gates (freshness, non-neutral tilt, price floor, liquidity floor, hidden,
 * tradable, earnings-demote), and cap the survivors to the top-N by score. Pure.
 *
 * Returns BOTH the chosen picks (for watchlist injection) and the full set of
 * scored candidates with a `chosen` flag + `dropReason`, so the caller can write
 * every one to the shadow ledger for attribution.
 */
export function scoreAndSelect(
  candidates: readonly CatalystCandidate[],
  opts: SelectOptions = {},
): { chosen: ScoredCandidate[]; scored: ScoredCandidate[] } {
  const minPrice = opts.minPrice ?? WATCHLIST_MIN_PRICE;
  const minVol = opts.minAvgDollarVol ?? CATALYST_MIN_AVG_DOLLAR_VOLUME_DEFAULT;
  const hidden = opts.hidden ?? new Set<string>();
  const cap = opts.cap ?? CATALYST_TOP_N;
  const tradable = opts.tradable ?? (() => true);

  const scored: ScoredCandidate[] = candidates.map((c) => {
    const score = computeCatalystScore({
      netScore: c.netScore,
      tilt: c.tilt,
      rvolZ: c.rvolZ,
      gapPct: c.gapPct,
      freshHeadlineCount: c.freshHeadlineCount,
      freshnessMinutes: c.freshnessMinutes,
      earningsInDays: c.earningsInDays,
    });
    // Hard-eligibility drops (checked before ranking).
    let dropReason: CatalystDropReason | null = null;
    if (!tradable(c.symbol)) dropReason = 'not_tradable';
    else if (hidden.has(c.symbol.toUpperCase())) dropReason = 'hidden';
    else if (c.price == null || c.price < minPrice) dropReason = 'below_min_price';
    else if (c.avgDollarVol == null || c.avgDollarVol < minVol) dropReason = 'below_liquidity';
    else if (!score.fresh) dropReason = 'stale';
    else if (c.tilt === 'neutral') dropReason = 'neutral_tilt';
    else if (score.demoted) dropReason = 'earnings_demote';
    return { ...c, score, chosen: false, dropReason };
  });

  // Rank the still-eligible names (dropReason === null) by score desc; cap → chosen.
  const eligible = scored
    .filter((s) => s.dropReason === null)
    .sort((a, b) => b.score.score - a.score.score);
  eligible.forEach((s, i) => {
    if (i < cap) s.chosen = true;
    else s.dropReason = 'below_cap';
  });

  return { chosen: eligible.filter((s) => s.chosen), scored };
}

// ── Live orchestration ───────────────────────────────────────────────────────

/** Per-name market metrics the score needs, injected so the pipeline is testable. */
export interface CatalystMetrics {
  price: number | null;
  avgDollarVol: number | null;
  rvolZ: number;
  gapPct: number;
}

export interface CatalystSourceDeps {
  /** Market-wide news stream (defaults to `fetchMarketNews`). */
  fetchNews: () => Promise<NewsItem[]>;
  /** Per-name metrics (defaults to {@link fetchCatalystMetrics}). */
  fetchMetrics: (symbol: string) => Promise<CatalystMetrics>;
  /** Sessions-until-earnings lookup (defaults to `earningsInDaysSync`). */
  earningsInDays: (symbol: string) => number | null;
  now: number;
  hidden?: ReadonlySet<string>;
}

function zScore(value: number, history: readonly number[]): number {
  const sample = history.filter((v) => Number.isFinite(v));
  if (sample.length < 2) return 0;
  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  const variance = sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length;
  const sd = Math.sqrt(variance);
  if (!(sd > 1e-9)) return 0;
  return (value - mean) / sd;
}

/**
 * Live per-name metrics from the free daily-candle feed. Pre-open the newest
 * completed bar is the prior session, so `rvolZ`/`gapPct` are the most-recent
 * completed session's read (a documented Phase-1 proxy — the memo §6 flags free-
 * news/data latency as exactly what validation measures). `avgDollarVol` and
 * `price` come from the same window. Degrades to neutral values on a thin feed.
 */
export async function fetchCatalystMetrics(symbol: string): Promise<CatalystMetrics> {
  const candles = await fetchDailyCandles(symbol, 22).catch(() => []);
  if (candles.length < 2) {
    return { price: null, avgDollarVol: null, rvolZ: 0, gapPct: 0 };
  }
  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const window = candles.slice(0, -1); // exclude the latest bar from its own baseline
  const priorVolumes = window.map((c) => c.volume);
  const rvolZ = zScore(latest.volume, priorVolumes);
  const gapPct = prev.close > 0 ? ((latest.open - prev.close) / prev.close) * 100 : 0;
  const dollarVols = candles.map((c) => c.close * c.volume).filter((v) => Number.isFinite(v) && v > 0);
  const avgDollarVol =
    dollarVols.length > 0 ? dollarVols.reduce((a, b) => a + b, 0) / dollarVols.length : null;
  return {
    price: Number.isFinite(latest.close) && latest.close > 0 ? latest.close : null,
    avgDollarVol,
    rvolZ,
    gapPct,
  };
}

function toLedgerRow(s: ScoredCandidate, asof: number): CatalystObservationInput {
  return {
    symbol: s.symbol,
    asof,
    catalystScore: s.score.score,
    components: s.score.components,
    sentimentNetScore: s.netScore,
    sentimentTilt: s.tilt,
    rvolZ: s.rvolZ,
    gapPct: s.gapPct,
    freshHeadlineCount: s.freshHeadlineCount,
    freshnessMinutes: s.freshnessMinutes,
    chosen: s.chosen,
    dropReason: s.dropReason,
    tags: s.score.tags,
  };
}

/**
 * Build the `news_catalyst` picks for one run: fetch market news, map onto the
 * universe, enrich with per-name metrics, score + select the top-N, and append
 * every scored candidate to the shadow ledger. Returns the chosen symbols
 * (UPPERCASE) for injection into the smart watchlist. Never throws — a feed
 * failure logs and yields an empty pick list so the watchlist build continues.
 */
export async function buildNewsCatalystPicks(deps: CatalystSourceDeps): Promise<string[]> {
  let news: NewsItem[] = [];
  try {
    news = await deps.fetchNews();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('market news fetch failed', { reason });
    // TRA-2064 — `headlineCount: null`, NOT 0: the feed never returned, so
    // there is nothing measured. A `0` here would read identically to a feed
    // that legitimately returned no headlines.
    await recordCatalystRun({
      at: deps.now,
      outcome: 'fetch_failed',
      headlineCount: null,
      candidateCount: null,
      chosenCount: null,
      reason,
    });
    return [];
  }

  const base = mapNewsToCandidates(news, deps.now);
  if (base.length === 0) {
    log.info('news-catalyst: no mapped candidates', { headlines: news.length });
    await recordCatalystRun({
      at: deps.now,
      outcome: 'no_mapped_candidates',
      headlineCount: news.length,
      candidateCount: 0,
      chosenCount: 0,
    });
    return [];
  }

  // Enrich each candidate with market metrics + earnings (bounded fan-out —
  // candidate count is universe ∩ news-mentioned, typically < 15).
  const enriched: CatalystCandidate[] = [];
  for (const c of base) {
    let metrics: CatalystMetrics = { price: null, avgDollarVol: null, rvolZ: 0, gapPct: 0 };
    try {
      metrics = await deps.fetchMetrics(c.symbol);
    } catch (err) {
      log.warn('news-catalyst metrics fetch failed', {
        symbol: c.symbol,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    enriched.push({
      ...c,
      ...metrics,
      earningsInDays: deps.earningsInDays(c.symbol),
    });
  }

  const { chosen, scored } = scoreAndSelect(enriched, { hidden: deps.hidden });

  // Persist every scored candidate to the shadow ledger (deduped per session).
  for (const s of scored) {
    try {
      await recordCatalystObservation(toLedgerRow(s, deps.now));
    } catch (err) {
      log.warn('news-catalyst ledger append failed', {
        symbol: s.symbol,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const picks = chosen.map((s) => s.symbol.toUpperCase());
  await recordCatalystRun({
    at: deps.now,
    outcome: 'picks_built',
    headlineCount: news.length,
    candidateCount: scored.length,
    chosenCount: picks.length,
  });
  log.info('news-catalyst picks built', {
    headlines: news.length,
    candidates: scored.length,
    chosen: picks.length,
    ...(picks.length ? { symbols: picks.join(', ') } : {}),
  });
  return picks;
}
