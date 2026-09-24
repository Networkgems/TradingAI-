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
import { fetchDailyCandles, type MarketNewsResult } from './yahoo-feed.js';
import {
  recordCatalystObservation,
  hasUsableQuote,
  type CatalystDropReason,
  type CatalystObservationInput,
} from './news-catalyst-ledger.js';
import { recordCatalystRun, isCatalystRunDegraded } from './news-catalyst-run-ledger.js';
import { etDateKey } from './options-chain-recorder.js';
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
    // TRA-4585 — the missing quote is checked FIRST and separately. This used to
    // read `c.price == null || c.price < minPrice → 'below_min_price'`, which
    // filed a market-data outage under the price screen. Order matters as much
    // as the split: `hasUsableQuote` has to answer before any comparison against
    // `minPrice`, or a `0` price reaches `0 < minPrice` and is reported as a
    // cheap stock. See `hasUsableQuote` for why null/NaN/≤0 are all one class.
    else if (!hasUsableQuote(c.price)) dropReason = 'no_quote';
    else if (c.price < minPrice) dropReason = 'below_min_price';
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
  /**
   * News stream for the run (defaults to `fetchMarketNews` over the catalyst
   * universe). Returns feed HEALTH alongside the headlines so an empty
   * `items` can be told apart from a feed that answered nothing — see
   * {@link MarketNewsResult}.
   */
  fetchNews: () => Promise<MarketNewsResult>;
  /** Per-name metrics (defaults to {@link fetchCatalystMetrics}). */
  fetchMetrics: (symbol: string) => Promise<CatalystMetrics>;
  /** Sessions-until-earnings lookup (defaults to `earningsInDaysSync`). */
  earningsInDays: (symbol: string) => number | null;
  now: number;
  hidden?: ReadonlySet<string>;
}

/**
 * TRA-4901 — which checkpoint of the trading day a sweep belongs to.
 *
 * The morning brief (8:30 ET) and the pre-market watchlist build (9:00 ET)
 * both read overnight/premarket headlines and correctly share ONE vendor
 * sweep per day (TRA-4682) — headlines from 4pm-yesterday through the open
 * do not go stale in that 30-minute gap. Afternoon setups are a different
 * question: a name that caught a lunchtime headline needs a FRESH sweep, and
 * before this the once-per-session cache silently served the 9am pool all
 * afternoon — "midday news" never actually re-hit the vendor.
 *
 * Each window gets its own cache entry and its own attempt budget, so a
 * midday sweep can never crowd out (or be crowded out by) the premarket one.
 */
export type CatalystSweepWindow = 'premarket' | 'midday';

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
 *
 * TRA-4805 — runs on the `chart` breaker lane, not the `crumb` lane that the
 * 577-symbol quote fan-out keeps permanently open. This is the PRICE half of
 * the same starvation: `candles.length < 2` returns `price: null`, which
 * `hasUsableQuote` counts as an unquoted candidate, which drags the run's quote
 * coverage under the 0.50 floor and marks it degraded — 09-17 closed at 5/22
 * (0.227) and 09-18 at 0/7. Fixing the news sweep alone would have left
 * `healthyRuns` pinned at 0 through a second, differently-named door.
 */
export async function fetchCatalystMetrics(symbol: string): Promise<CatalystMetrics> {
  const candles = await fetchDailyCandles(symbol, 22, 'chart').catch(() => []);
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

function toLedgerRow(
  s: ScoredCandidate,
  asof: number,
  degradedRun: boolean,
): CatalystObservationInput {
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
    // TRA-4585 — written EXPLICITLY on every row, `true` or `false`. Omitting
    // it on the healthy path would make "clean row" and "row written before
    // this field existed" the same observation, which is the identical
    // false-equivalence this ticket exists to remove one layer up.
    degradedRun,
  };
}

/**
 * Build the `news_catalyst` picks for one run: fetch market news, map onto the
 * universe, enrich with per-name metrics, score + select the top-N, and append
 * every scored candidate to the shadow ledger. Returns the chosen symbols
 * (UPPERCASE) for injection into the smart watchlist. Never throws — a feed
 * failure logs and yields an empty pick list so the watchlist build continues.
 *
 * UNGATED — every call is a full vendor sweep and a run-ledger row. The
 * premarket path must go through {@link sessionCatalystPicks} instead (TRA-4682).
 */
export async function buildNewsCatalystPicks(deps: CatalystSourceDeps): Promise<string[]> {
  return (await runCatalystSweep(deps)).picks;
}

/**
 * One sweep's result. `pool` is the enriched candidate list of a HEALTHY run —
 * the thing a later caller in the same session can re-select from without
 * touching the vendor — and `null` on every run that must not be reused
 * (degraded, failed, or the feed never answered).
 */
interface CatalystSweepResult {
  picks: string[];
  pool: CatalystCandidate[] | null;
}

/**
 * TRA-4805 — render the sweep's failure census into the one-line `reason` that
 * the run ledger and the health route both carry.
 *
 * The old constant string, `'all market-news queries failed'`, is the sentence
 * three separate triages read and drew three different wrong conclusions from
 * (scheduler gap, loop-cap regression, credential/billing event). It could not
 * have distinguished them: the dominant real cause was `breaker_open`, which
 * means no request was issued at all. Naming the dominant cause inline costs
 * nothing and dates an episode instantly.
 *
 * Falls back to the old string verbatim when the census is absent, so a caller
 * that never measured does not get a fabricated attribution.
 */
export function describeFeedFailure(feed: MarketNewsResult): string {
  const f = feed.failures;
  if (!f) return 'all market-news queries failed';
  const parts = (
    [
      ['breaker_open', f.breakerOpen],
      ['rate_limited', f.rateLimited],
      ['timeout', f.timeout],
      ['error', f.error],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} x${n}`);
  if (parts.length === 0) return 'all market-news queries failed';
  const head = `all ${feed.queriesAttempted} market-news queries failed (${parts.join(', ')})`;
  return feed.firstFailureMessage ? `${head}: ${feed.firstFailureMessage}` : head;
}

async function runCatalystSweep(deps: CatalystSourceDeps): Promise<CatalystSweepResult> {
  let feed: MarketNewsResult;
  try {
    feed = await deps.fetchNews();
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
      queriesAttempted: null,
      queriesSucceeded: null,
      // TRA-4585 — `null`, not `0`: the run died at the news fetch and never
      // reached enrichment, so no quote was ever requested. A `0` here would
      // claim we asked for quotes and got none, which is a different diagnosis.
      quotesAttempted: null,
      quotesOk: null,
      reason,
    });
    return { picks: [], pool: null };
  }

  const news = feed.items;

  // TRA-2064 — the branch that hid the original defect. `fetchMarketNews` never
  // throws: on total failure it resolves to an empty list, which used to fall
  // through and record `no_mapped_candidates / headlineCount: 0` — the same row
  // a quiet news day writes. Separate it BEFORE the mapping step so an outage
  // can never again be filed as "no catalysts today".
  if (feed.queriesAttempted > 0 && feed.queriesSucceeded === 0) {
    // TRA-4805 — carry the CAUSE, not just the count. `reason` was a single
    // rolled-up string ("all market-news queries failed") that is emitted
    // identically whether we were refused by Yahoo or never asked it, and the
    // 09-18 → 09-22 outage was the latter for 3 straight sessions.
    log.warn('news-catalyst: every market-news query failed', {
      queriesAttempted: feed.queriesAttempted,
      failures: feed.failures ?? null,
      firstFailure: feed.firstFailureMessage ?? null,
    });
    await recordCatalystRun({
      at: deps.now,
      outcome: 'fetch_degraded',
      headlineCount: null, // nothing was measured — the queries did not answer
      candidateCount: null,
      chosenCount: null,
      queriesAttempted: feed.queriesAttempted,
      queriesSucceeded: 0,
      // Returned before enrichment — no quote requested. See above.
      quotesAttempted: null,
      quotesOk: null,
      feedFailures: feed.failures ?? null,
      feedFirstFailure: feed.firstFailureMessage ?? null,
      reason: describeFeedFailure(feed),
    });
    return { picks: [], pool: null };
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
      queriesAttempted: feed.queriesAttempted,
      queriesSucceeded: feed.queriesSucceeded,
      // TRA-4805 — carried on the HEALTHY paths too: a sweep that answered 9 of
      // 25 is a partial outage, and the census is the only place that says so.
      feedFailures: feed.failures ?? null,
      feedFirstFailure: feed.firstFailureMessage ?? null,
      // Zero candidates mapped, so zero names to price. `0`/`0` is MEASURED
      // here — and `isCatalystRunDegraded` requires `quotesAttempted > 0`, so a
      // genuinely quiet news day is correctly NOT degraded by the quote arm.
      quotesAttempted: 0,
      quotesOk: 0,
    });
    // A measured quiet day IS healthy — the empty pool is a real answer, and a
    // re-sweep would only spend vendor quota to learn the same thing.
    return { picks: [], pool: [] };
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

  // TRA-4585 — price-feed health for THIS run, measured over the names we
  // actually asked about. `fetchMetrics` swallows its own failures into
  // `price: null` (above, and again inside `fetchCatalystMetrics`), so a dead
  // quote feed raises no error anywhere on this path; counting the usable
  // answers is the only place it becomes visible.
  const quotesAttempted = enriched.length;
  const quotesOk = enriched.filter((c) => hasUsableQuote(c.price)).length;
  const degradedRun = isCatalystRunDegraded({
    outcome: 'picks_built',
    queriesAttempted: feed.queriesAttempted,
    queriesSucceeded: feed.queriesSucceeded,
    quotesAttempted,
    quotesOk,
  });

  // Persist every scored candidate to the shadow ledger (deduped per session),
  // each stamped with whether the run that wrote it had measured inputs.
  for (const s of scored) {
    try {
      await recordCatalystObservation(toLedgerRow(s, deps.now, degradedRun));
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
    queriesAttempted: feed.queriesAttempted,
    queriesSucceeded: feed.queriesSucceeded,
      // TRA-4805 — carried on the HEALTHY paths too: a sweep that answered 9 of
      // 25 is a partial outage, and the census is the only place that says so.
      feedFailures: feed.failures ?? null,
      feedFirstFailure: feed.firstFailureMessage ?? null,
    quotesAttempted,
    quotesOk,
    ...(degradedRun
      ? { reason: `price feed degraded: ${quotesOk}/${quotesAttempted} candidates priced` }
      : {}),
  });
  if (degradedRun) {
    // TRA-4585 — loud, because this is the run shape that used to be silent: a
    // healthy news sweep, a full candidate list, and every name dropped for
    // want of a quote. It exits `picks_built / chosenCount: 0`, which reads as
    // an ordinary uneventful session unless something says otherwise.
    log.warn('news-catalyst: run wrote rows with DEGRADED inputs', {
      quotesAttempted,
      quotesOk,
      queriesAttempted: feed.queriesAttempted,
      queriesSucceeded: feed.queriesSucceeded,
      // TRA-4805 — carried on the HEALTHY paths too: a sweep that answered 9 of
      // 25 is a partial outage, and the census is the only place that says so.
      feedFailures: feed.failures ?? null,
      feedFirstFailure: feed.firstFailureMessage ?? null,
      candidates: scored.length,
    });
  }
  log.info('news-catalyst picks built', {
    headlines: news.length,
    candidates: scored.length,
    chosen: picks.length,
    degradedRun,
    ...(picks.length ? { symbols: picks.join(', ') } : {}),
  });
  return { picks, pool: degradedRun ? null : enriched };
}

// ── TRA-4682: one vendor sweep per session, not one per account ──────────────
//
// The premarket hook builds the smart watchlist PER USER CONTEXT
// (`runPremarketForAllUsers` → `generateSmartWatchlist(ctx)`), and before this
// gate every one of those called `buildNewsCatalystPicks` — a full 25-query
// Yahoo news sweep plus a run-ledger row — once per account. That is the
// measured `runCount` 2521 over 43 sessions = 58.6 runs/session (TRA-4680).
//
// The news sweep is user-independent: the only per-user input is `hidden`, and
// that only filters selection. So the first healthy sweep of a session is
// cached as its enriched candidate pool and every later caller re-selects from
// it in memory — no vendor call and no run row. A failed sweep is retried at
// most {@link CATALYST_SWEEP_MAX_ATTEMPTS} times per session, no sooner than
// {@link CATALYST_SWEEP_RETRY_BACKOFF_MS} apart; callers in between get `[]`.
//
// Why the backoff is longer than 90s: the failure shape on 2026-09-17 was 20
// `fetch_degraded` rows at a uniform 1.7s — which is NOT vendor latency. It is
// `withRetry` short-circuiting all 25 queries on an OPEN 429 breaker
// (`yahoo-feed.ts` `isRateLimited`, 90s cooldown), leaving only the 9 batches x
// 200ms `BATCH_PAUSE_MS`. Retrying inside the cooldown cannot succeed and only
// writes another degraded row, so the backoff must clear it.
//
// Process-local on purpose: a restart loses the cache, which costs at most one
// extra sweep, and the durable run ledger still records every sweep that ran.
//
// TRA-4901 — the cache key used to be the bare ET session (`etDateKey`), so
// EVERY caller for the rest of the day — including one built specifically to
// re-hit the vendor for fresh midday headlines — served from the 9am pool.
// The key is now `${session}:${window}` ({@link CatalystSweepWindow}) so the
// premarket sweep and a midday refresh each get their own budget and their
// own cache slot; the midday window still cannot exceed
// {@link CATALYST_SWEEP_MAX_ATTEMPTS} of its own vendor sweeps, it just no
// longer inherits the premarket window's exhausted one (or vice versa).

/** Vendor sweeps allowed per ET session PER WINDOW, successful or not. */
export const CATALYST_SWEEP_MAX_ATTEMPTS = 3;
/** Minimum gap between failed sweep attempts — clears the 90s Yahoo 429 breaker. */
export const CATALYST_SWEEP_RETRY_BACKOFF_MS = 2 * 60_000;

interface SessionSweepState {
  key: string;
  attempts: number;
  lastAttemptAt: number;
  /** Enriched pool from the session's healthy sweep; `null` until one lands. */
  pool: CatalystCandidate[] | null;
  /** Callers answered without a vendor sweep (cache hit or backoff/cap skip). */
  servedFromCache: number;
  skipped: number;
  inFlight: Promise<void> | null;
}

const sweepStates = new Map<string, SessionSweepState>();

/**
 * Retire every other key for this window, so the map holds AT MOST ONE state
 * per window — the invariant the old single-slot `sweepState` gave for free and
 * that {@link catalystSweepGateSnapshot} reads. Without this the map is
 * append-only for the life of the process: an unbounded leak on a long-lived
 * pm2 box, and a health probe frozen on day 1. An evicted state is still held
 * by any caller mid-await, so dropping it here cannot strand an in-flight
 * sweep — it only stops a PAST session from being consulted again, which is
 * exactly what the pre-TRA-4901 code did when `sweepState.session !== session`.
 */
function retireStaleWindowKeys(liveKey: string, window: CatalystSweepWindow): void {
  for (const k of [...sweepStates.keys()]) {
    if (k !== liveKey && k.endsWith(`:${window}`)) sweepStates.delete(k);
  }
}

/** Test seam — forget every per-session/window sweep gate. */
export function resetCatalystSweepGateForTests(): void {
  sweepStates.clear();
}

/**
 * Test seam — how many session/window states are resident. The at-most-one-per-
 * window invariant is otherwise unobservable from outside, and an append-only
 * map is both a leak and the cause of the frozen probe (TRA-4737).
 */
export function catalystSweepStateCountForTests(): number {
  return sweepStates.size;
}

/**
 * Production probe of the at-most-one-per-window invariant (TRA-4777), as
 * `session:window` keys in insertion order.
 *
 * This is the ONLY field that grades the eviction. {@link catalystSweepGateSnapshot}
 * takes the LAST match precisely so that a regressed `retireStaleWindowKeys`
 * still reports the newest session — a backstop that makes the reported
 * `session` read correct whether or not the eviction is alive, so it cannot
 * discriminate the two. The resident keys can — but only once ONE PROCESS HAS
 * SWEPT ON TWO SESSIONS. At that point a live eviction still holds one key per
 * window, while a dead one holds a key per session per window. Until then both
 * worlds emit the identical key set, so a single-session read is vacuous rather
 * than passing; callers must check the sessions, not merely the count, and not
 * merely uptime. (TRA-4737 shipped the eviction; TRA-4761 could not grade it
 * because nothing was on the wire.)
 */
export function catalystSweepResidentKeys(): string[] {
  return [...sweepStates.keys()];
}

/** Probe view of the gate, for `/api/health/news-catalyst-signals`. Defaults to `premarket`. */
export interface CatalystSweepGateSnapshot {
  session: string | null;
  window: CatalystSweepWindow;
  attempts: number;
  maxAttempts: number;
  retryBackoffMs: number;
  healthy: boolean;
  servedFromCache: number;
  skipped: number;
}

export function catalystSweepGateSnapshot(
  window: CatalystSweepWindow = 'premarket',
): CatalystSweepGateSnapshot {
  // The live key for this window. `retireStaleWindowKeys` keeps at most one
  // per window, so this loop normally sees exactly one candidate; it takes the
  // LAST match rather than the first so that even if that eviction ever
  // regressed, the probe would report the newest session instead of silently
  // freezing on the oldest one the process ever saw. (TRA-4737: `Map` iterates
  // in insertion order, so a `.find()` here reported day 1 forever and a dead
  // feed read `healthy: true` from the second ET day onward.)
  let state: SessionSweepState | null = null;
  for (const s of sweepStates.values()) {
    if (s.key.endsWith(`:${window}`)) state = s;
  }
  return {
    session: state ? state.key.slice(0, state.key.length - window.length - 1) : null,
    window,
    attempts: state?.attempts ?? 0,
    maxAttempts: CATALYST_SWEEP_MAX_ATTEMPTS,
    retryBackoffMs: CATALYST_SWEEP_RETRY_BACKOFF_MS,
    healthy: state?.pool != null,
    servedFromCache: state?.servedFromCache ?? 0,
    skipped: state?.skipped ?? 0,
  };
}

function selectFromPool(pool: readonly CatalystCandidate[], hidden?: ReadonlySet<string>): string[] {
  if (pool.length === 0) return [];
  return scoreAndSelect(pool, { hidden }).chosen.map((s) => s.symbol.toUpperCase());
}

/**
 * The premarket/midday entry point: {@link buildNewsCatalystPicks} behind a
 * once-per-session-per-window gate. See the block comment above. Never throws.
 *
 * `window` defaults to `'premarket'` for back-compat with every existing
 * caller (the 9am watchlist build); pass `'midday'` from the afternoon
 * refresh hook so it gets an independent cache slot and attempt budget
 * instead of silently reading the morning's stale pool.
 */
export async function sessionCatalystPicks(
  deps: CatalystSourceDeps,
  window: CatalystSweepWindow = 'premarket',
): Promise<string[]> {
  const session = etDateKey(deps.now);
  const key = `${session}:${window}`;
  let state = sweepStates.get(key);
  if (!state) {
    state = {
      key,
      attempts: 0,
      lastAttemptAt: 0,
      pool: null,
      servedFromCache: 0,
      skipped: 0,
      inFlight: null,
    };
    sweepStates.set(key, state);
    retireStaleWindowKeys(key, window);
  }
  // Single-flight: a concurrent caller waits for the running sweep, then reads
  // its outcome like any later caller.
  if (state.inFlight) await state.inFlight;

  if (state.pool) {
    state.servedFromCache += 1;
    return selectFromPool(state.pool, deps.hidden);
  }
  if (
    state.attempts >= CATALYST_SWEEP_MAX_ATTEMPTS ||
    (state.attempts > 0 && deps.now - state.lastAttemptAt < CATALYST_SWEEP_RETRY_BACKOFF_MS)
  ) {
    state.skipped += 1;
    return [];
  }

  state.attempts += 1;
  state.lastAttemptAt = deps.now;
  let picks: string[] = [];
  const run = runCatalystSweep(deps).then((r) => {
    picks = r.picks;
    if (r.pool) state!.pool = r.pool;
  });
  state.inFlight = run.catch(() => undefined);
  try {
    await run;
  } finally {
    state.inFlight = null;
  }
  return picks;
}
