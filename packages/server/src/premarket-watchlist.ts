/**
 * TRA-368 — Smart watchlist generator.
 *
 * Fires at 9:00 AM ET (30 min before the opening bell, via the scheduler's
 * `onPremarket` hook) and builds a curated stocks watchlist by fusing two
 * inputs:
 *
 *   1. **Post-market review** — the prior trading day's stocks EOD report
 *      (`reports/<mode>/latest.json`). The `top5Movers` carry yesterday's
 *      strongest |%-change| names; high-conviction follow-through often
 *      shows up at the next open. We also propagate the symbols that
 *      actually traded yesterday so the engine keeps watching anything it
 *      already had a thesis on.
 *
 *      TRA-3071 — this file is read OFF DISK, so it is the one ranking input
 *      that the read-time archive stamp (TRA-2631) cannot reach. Every
 *      `top5Movers` row is put through `isMoveSuspect` here, at the consumer,
 *      before it can seed a symbol or a price. See {@link suspectMover}.
 *
 *   2. **Pre-market scan** — a fresh `scanStocksMarket()` pull of Yahoo's
 *      day-gainers / losers / most-actives / trending screeners. Pre-market
 *      movers correlate with first-hour volatility; feeding them in early
 *      lets the engine's signal generators (ORB, momentum, BB-fade, …) see
 *      bars from the open instead of waiting for the user to scan-and-add
 *      manually mid-session.
 *
 * The merged list is scored, capped, persisted into each user's stocks
 * watchlist (so refresh-on-reload still has it) and pushed into the live
 * `SignalEngine` via `addSymbol(...)` + `refresh()` so today's bars are
 * collected from minute one.
 *
 * Scoring is intentionally simple: each source contributes a weight, and
 * symbols that appear in multiple sources rank higher than single-source
 * picks. The cap (`MAX_NEW_SYMBOLS`) keeps the engine's per-tick fan-out
 * bounded — the engine refreshes every 30 s and pulls quotes per symbol,
 * so an unbounded list would push us through Yahoo's rate-limit ceiling.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { EodMover, EodReport } from '@trading-app/shared';
import {
  WATCHLIST,
  WATCHLIST_MIN_PRICE,
  SUSPECT_MOVE_RATIO_FLOOR,
  assessQuotePlausibility,
  isMoveSuspect,
} from '@trading-app/shared';
import { scanStocksMarket, type ScanResult } from './market-scanner.js';
import { fetchQuotes, fetchMarketNews } from './yahoo-feed.js';
import { addStocksSymbol, getStocksWatchlistData } from './watchlist-store.js';
import { isNewsCatalystEnabled } from './news-catalyst-ledger.js';
import {
  buildNewsCatalystPicks,
  catalystUniverse,
  fetchCatalystMetrics,
} from './news-catalyst-source.js';
import { recordCatalystRun } from './news-catalyst-run-ledger.js';
import { earningsInDaysSync } from './earnings-store.js';
import { getSettings } from './account-settings.js';
import {
  getAllUserContexts,
  stockModeKey,
  stockReportsDirFor,
  type UserContext,
} from './user-context.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'premarket-watchlist' });

/** Soft cap on net-new symbols added per user per pre-market run. */
const MAX_NEW_SYMBOLS = 15;

interface ScoredSymbol {
  symbol: string;
  score: number;
  sources: string[];
}

/**
 * Source weights — higher = stronger contribution to the smart watchlist.
 *
 *   - `eod_mover`: showed up in yesterday's top-5 |%-change|. Strong signal
 *     that the name has follow-through energy.
 *   - `eod_traded`: symbol the engine actually traded yesterday. Re-watch
 *     so any open swing has continuity.
 *   - `gainer` / `loser`: pre-market screener. Big intraday range potential.
 *   - `volume`: pre-market most-actives. Liquidity for the engine's
 *     liquidity-gated entries.
 *   - `trending`: news / search trending. Lowest weight (noisy).
 *   - `news_catalyst`: TRA-1629 — a name the news-catalyst discovery source
 *     surfaced (fresh headline + non-neutral sentiment tilt + rel-vol/gap).
 *     Weighted ABOVE `eod_mover` (5) and well above the noisy `trending` (1),
 *     per the parent memo §4. Flag-gated (`ENABLE_NEWS_CATALYST_WATCHLIST`,
 *     default OFF); the score is a discovery signal, not an order.
 */
const WEIGHTS: Record<string, number> = {
  news_catalyst: 6,
  eod_mover: 5,
  gainer: 4,
  loser: 4,
  eod_traded: 3,
  volume: 3,
  trending: 1,
};

/**
 * TRA-3071 — the plausibility guard for the ARCHIVED top-movers.
 *
 * This module's first input is read STRAIGHT OFF DISK (`loadLatestEodReport`),
 * so it is the one ranking consumer that neither of the shipped defences can
 * reach:
 *
 *   - **TRA-2610** guards report GENERATION. It stops a NEW `latest.json` from
 *     containing a suspect row; it says nothing about one already on disk.
 *   - **TRA-2631** stamps the archive at READ TIME, at the HTTP/WS response
 *     boundary. This path never crosses that boundary — it opens the file
 *     itself — so the stamp is structurally invisible to it.
 *
 * Without this, a symbol earns the top-weight `eod_mover` bump (5) on a session
 * move THAT NEVER HAPPENED, and the engine watches it into the next open.
 *
 * The predicate is `isMoveSuspect`, the same one TRA-2610 gave the other
 * ranking consumers: it honours the producer's `moveSuspect` flag AND
 * re-executes the rule over the numbers. The second half is what makes it work
 * here at all — a persisted `EodMover` carries no flag (`moveSuspect` is never
 * written to disk), so a flag-only guard would pass every archived row.
 *
 * The split-calendar leg (TRA-3068) is deliberately NOT passed. It needs the
 * row's session pair against a live provider calendar; an archived row is dated
 * by the report, not by itself, and TRA-3068 settled that the continuity rule
 * abstains here rather than guessing. This is the session-move leg only.
 *
 * Returns the verdict on a suspect row (so the caller can log the arithmetic
 * that condemned it — per TRA-2379 decision 2 a silent drop reads identically
 * to nothing being wrong) and `null` on a row that may be ranked.
 *
 * TRA-3243 — WHICH PROPOSITION THIS CONSUMER NEEDS: **P-now**, and for the same
 * structural reason as `market-scanner`: an archived `EodMover` carries no session
 * fact (nothing writes one to disk), so `isMoveSuspect` degrades here to
 * `isMoveSuspectNow` by construction. That is not a gap — this path got STRICTLY
 * safer without changing, because the archive it reads is now written by a
 * `top5Movers` that already dropped the session-condemned rows upstream. The rule is
 * re-executed here anyway, as the belt-and-braces this docblock describes.
 *
 * TRA-4303 — EXPORTED for the 08:30 morning brief's overnight-setups section,
 * which reads the same `latest.json` off the same disk and therefore inherits
 * the same blind spot verbatim. It is exported rather than reimplemented so the
 * two consumers cannot drift: a second hand-rolled copy of this rule is exactly
 * how a fabricated mover reaches the board's inbox. The brief is READ-ONLY — it
 * ranks and renders, it never seeds a symbol.
 */
export function suspectMover(mover: EodMover): { reason: string; impliedPrevClose: number | null; ratio: number | null } | null {
  if (!isMoveSuspect(mover)) return null;
  const v = assessQuotePlausibility({ price: mover.price, changePct: mover.changePct });
  return {
    // `isMoveSuspect` fired but the rule did not ⇒ the row carried the
    // producer's flag and nothing else. Name that, rather than logging a
    // suspicion with no reason attached.
    reason: v.reason ?? 'producer_flag',
    impliedPrevClose: v.impliedPrevClose,
    ratio: v.ratio,
  };
}

/**
 * Read the prior-session EOD report for a user's active stocks mode.
 *
 * TRA-4303 — EXPORTED for the morning brief's overnight-setups section. Same
 * file, same mode resolution, same `null`-on-any-failure contract; the brief
 * degrades that `null` into a named "prior-session report unavailable" note
 * rather than failing its run.
 */
export async function loadLatestEodReport(ctx: UserContext): Promise<EodReport | null> {
  const mode = stockModeKey(getSettings(ctx.username));
  const file = join(stockReportsDirFor(ctx, mode), 'latest.json');
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw) as EodReport;
  } catch (err) {
    log.warn('failed to read EOD report', {
      username: ctx.username,
      file,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Merge post-market review + pre-market scan into a scored, deduped list.
 * Exported so the unit test can exercise the scoring without touching disk
 * or Yahoo.
 */
export function scoreSymbols(
  eod: EodReport | null,
  preMarket: ReadonlyArray<ScanResult>,
  /**
   * TRA-1629 — symbols the news-catalyst discovery source chose this run. Bumped
   * under the `news_catalyst` source (the highest weight) so a fresh catalyst
   * name outranks a plain price/volume mover. Empty (default) when the feature
   * flag is off, so the scoring is byte-identical to the pre-TRA-1629 behaviour.
   */
  newsCatalyst: readonly string[] = [],
): ScoredSymbol[] {
  const scores = new Map<string, ScoredSymbol>();

  const bump = (symbol: string, source: string) => {
    const sym = symbol.toUpperCase();
    const weight = WEIGHTS[source] ?? 0;
    const existing = scores.get(sym);
    if (existing) {
      existing.score += weight;
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      scores.set(sym, { symbol: sym, score: weight, sources: [source] });
    }
  };

  if (eod) {
    for (const mover of eod.top5Movers) {
      // TRA-3071 — the archived row is not fact. Skip the top-weight bump when
      // its own published numbers are mutually unbelievable; log the arithmetic
      // so the skip is auditable, not a silent count.
      const suspect = suspectMover(mover);
      if (suspect) {
        log.info('eod_mover skipped — archived row failed the plausibility rule', {
          symbol: mover.symbol,
          price: mover.price,
          changePct: mover.changePct,
          impliedPrevClose: suspect.impliedPrevClose,
          ratio: suspect.ratio,
          suspectMoveRatio: SUSPECT_MOVE_RATIO_FLOOR,
          reason: suspect.reason,
          source: 'eod_mover',
        });
        continue;
      }
      bump(mover.symbol, 'eod_mover');
    }
    // Symbols the engine actually traded yesterday — keep them under watch.
    const tradedSet = new Set<string>();
    for (const t of eod.trades) tradedSet.add(t.symbol.toUpperCase());
    for (const sym of tradedSet) bump(sym, 'eod_traded');
  }

  for (const r of preMarket) bump(r.symbol, r.reason);

  for (const sym of newsCatalyst) bump(sym, 'news_catalyst');

  return [...scores.values()].sort((a, b) => b.score - a.score);
}

/**
 * TRA-510 — drop ranked newcomers whose last-known quote is below
 * {@link WATCHLIST_MIN_PRICE}. Symbols already on the base WATCHLIST are
 * passed back through untouched (the caller has already split base members
 * out of `newcomers`; this is a belt-and-braces invariant — see the call
 * site in {@link generateSmartWatchlist}).
 *
 * Price lookup precedence per symbol:
 *   1. `eod.top5Movers[].price` — the prior-session close already on hand.
 *      Free; no API round-trip; the only price source for the `eod_mover`
 *      bucket that drove every QTEX-style stop-out in TRA-508.
 *   2. `quoteLookup(symbols)` — batched fetch for whatever is left after
 *      step 1. In production this is `fetchQuotes` (a single Tradier
 *      multi-symbol call); tests pass an in-memory map. Symbols the
 *      lookup can't price are conservatively dropped — without a price we
 *      can't prove the symbol clears the floor.
 *
 * Returns `{ kept, dropped }`. `dropped` carries `{ symbol, price, reason }`
 * so the call site can emit one structured `info` log per dropped name.
 *
 * Exported so the unit test can exercise the filter without touching disk,
 * Yahoo, or Tradier.
 */
export async function filterByPriceFloor(
  newcomers: ScoredSymbol[],
  eod: EodReport | null,
  quoteLookup: (symbols: readonly string[]) => Promise<Map<string, { price: number }>>,
  minPrice: number = WATCHLIST_MIN_PRICE,
): Promise<{
  kept: ScoredSymbol[];
  dropped: Array<{ symbol: string; price: number | null; reason: 'below_min_price' | 'no_quote' }>;
}> {
  if (newcomers.length === 0) {
    return { kept: [], dropped: [] };
  }

  // Step 1: seed the price map from yesterday's EOD top-5 movers (cheap).
  //
  // TRA-3071 — but not from a row that failed the plausibility rule. In this
  // defect class the fabrication usually lives in `changePct` rather than
  // `price`, so this leg is the weaker of the two; it is guarded anyway because
  // the seed exists purely to SKIP the live quote, and skipping a live quote in
  // favour of an untrusted archived number is the wrong trade at any odds. A
  // skipped seed is not a drop: the symbol simply falls through to step 2 and
  // gets priced off a fresh quote, which is strictly better evidence.
  const priceBySymbol = new Map<string, number>();
  if (eod) {
    for (const mover of eod.top5Movers) {
      const suspect = suspectMover(mover);
      if (suspect) {
        log.info('eod price seed skipped — archived row failed the plausibility rule', {
          symbol: mover.symbol,
          price: mover.price,
          changePct: mover.changePct,
          impliedPrevClose: suspect.impliedPrevClose,
          ratio: suspect.ratio,
          suspectMoveRatio: SUSPECT_MOVE_RATIO_FLOOR,
          reason: suspect.reason,
          source: 'price_floor_seed',
        });
        continue;
      }
      priceBySymbol.set(mover.symbol.toUpperCase(), mover.price);
    }
  }

  // Step 2: batch-fetch the remainder so the watchlist refresh is one HTTP
  // call (Tradier multi-symbol) instead of N.
  const needsFetch = newcomers.filter(r => !priceBySymbol.has(r.symbol)).map(r => r.symbol);
  if (needsFetch.length > 0) {
    try {
      const fetched = await quoteLookup(needsFetch);
      for (const [sym, q] of fetched) {
        priceBySymbol.set(sym.toUpperCase(), q.price);
      }
    } catch (err) {
      log.warn('price-floor quote lookup failed — falling back to drop-without-quote', {
        symbols: needsFetch,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const kept: ScoredSymbol[] = [];
  const dropped: Array<{ symbol: string; price: number | null; reason: 'below_min_price' | 'no_quote' }> = [];
  for (const r of newcomers) {
    const price = priceBySymbol.get(r.symbol);
    if (price == null || !Number.isFinite(price) || price <= 0) {
      // No usable quote — drop conservatively. Without a price we can't
      // prove the symbol clears the floor, and TRA-508 showed unfiltered
      // micro-caps are exactly the cohort the floor is meant to gate out.
      dropped.push({ symbol: r.symbol, price: null, reason: 'no_quote' });
      continue;
    }
    if (price < minPrice) {
      dropped.push({ symbol: r.symbol, price, reason: 'below_min_price' });
      continue;
    }
    kept.push(r);
  }
  return { kept, dropped };
}

/**
 * Build today's smart watchlist for `ctx` and feed it into the user's
 * SignalEngine. Returns the list of symbols actually added (already-present
 * symbols are filtered out so the dashboard's per-user audit trail in
 * `stocks.added` doesn't grow with noise).
 */
export async function generateSmartWatchlist(ctx: UserContext): Promise<string[]> {
  const eod = await loadLatestEodReport(ctx);

  let preMarketScan: ScanResult[] = [];
  try {
    preMarketScan = await scanStocksMarket();
  } catch (err) {
    log.warn('scanStocksMarket failed', {
      username: ctx.username,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // TRA-1629 — flag-gated news-catalyst discovery source. Default OFF: when the
  // flag is unset this is skipped entirely and `ranked` is byte-identical to the
  // pre-TRA-1629 price/volume watchlist. Observe-only — it only ADDS names for
  // the engine to watch and appends a shadow ledger; it routes no order.
  let newsCatalyst: string[] = [];
  if (isNewsCatalystEnabled()) {
    try {
      const hidden = new Set(
        getStocksWatchlistData(ctx.username).hidden.map(s => s.toUpperCase()),
      );
      newsCatalyst = await buildNewsCatalystPicks({
        // TRA-2064 — sweep the catalyst universe by ENTITY. Yahoo's search
        // returns news only for a resolvable ticker/company; the free-text topic
        // queries this used to rely on came back empty every session. The
        // universe is passed in (not imported inside yahoo-feed) to keep the feed
        // module provider-generic and out of a cycle with the source module.
        fetchNews: () => fetchMarketNews(catalystUniverse()),
        fetchMetrics: fetchCatalystMetrics,
        earningsInDays: earningsInDaysSync,
        now: Date.now(),
        hidden,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('news-catalyst source failed', { username: ctx.username, reason });
      // TRA-2064 — the outermost exit. `buildNewsCatalystPicks` never throws,
      // so reaching here means the failure was in building its deps (e.g. the
      // hidden-list read) — a case no in-function recorder can see. All counts
      // are `null`: nothing was measured.
      await recordCatalystRun({
        at: Date.now(),
        outcome: 'source_failed',
        headlineCount: null,
        candidateCount: null,
        chosenCount: null,
        queriesAttempted: null,
        queriesSucceeded: null,
        reason,
      });
    }
  }

  const ranked = scoreSymbols(eod, preMarketScan, newsCatalyst);

  // Skip names already in the base WATCHLIST — those are watched by default
  // and re-adding them would just clutter the per-user `stocks.added` audit.
  const baseSet = new Set((WATCHLIST as readonly string[]).map(s => s.toUpperCase()));
  const baseCandidates = ranked.filter(r => !baseSet.has(r.symbol));

  // TRA-510 — gate sub-$5 micro-caps out before applying the MAX_NEW_SYMBOLS
  // cap, so a slate of QTEX-style names can't crowd out the legitimate
  // higher-priced movers we actually want to watch. Symbols on the base
  // WATCHLIST were already excluded above and stay watched regardless of
  // price (the floor is a *newcomer* filter, not a delisting tool).
  const { kept: priceFiltered, dropped } = await filterByPriceFloor(
    baseCandidates,
    eod,
    (syms) => fetchQuotes(syms),
  );
  for (const d of dropped) {
    log.info('symbol filtered from smart watchlist', {
      username: ctx.username,
      symbol: d.symbol,
      ...(d.price != null ? { price: d.price } : {}),
      reason: d.reason,
      minPrice: WATCHLIST_MIN_PRICE,
    });
  }
  const newcomers = priceFiltered.slice(0, MAX_NEW_SYMBOLS);

  for (const r of newcomers) {
    try {
      await addStocksSymbol(ctx.username, r.symbol);
      ctx.engine.addSymbol(r.symbol);
    } catch (err) {
      log.warn('failed to add symbol', {
        username: ctx.username,
        symbol: r.symbol,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (newcomers.length > 0) {
    ctx.engine.refresh();
  }

  const summary = newcomers.map(s => `${s.symbol}(${s.sources.join('|')})`).join(', ');
  log.info('smart watchlist built', {
    username: ctx.username,
    added: newcomers.length,
    ...(summary ? { symbols: summary } : {}),
  });

  return newcomers.map(s => s.symbol);
}

/**
 * Fan out the smart-watchlist build across every active user. Wired into
 * the scheduler's `onPremarket` hook from `index.ts`. Per-user failures are
 * isolated so one user's outage can't starve the rest of the fleet — same
 * pattern as `runDailyCloseForAllUsers` / `runHourlyFundingForAllUsers`.
 */
export async function runPremarketForAllUsers(): Promise<void> {
  for (const ctx of getAllUserContexts()) {
    try {
      await generateSmartWatchlist(ctx);
    } catch (err) {
      log.error('smart watchlist failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
