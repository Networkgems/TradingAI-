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
import type { EodReport } from '@trading-app/shared';
import { WATCHLIST } from '@trading-app/shared';
import { scanStocksMarket, type ScanResult } from './market-scanner.js';
import { addStocksSymbol } from './watchlist-store.js';
import { getSettings } from './account-settings.js';
import {
  getAllUserContexts,
  stockModeKey,
  stockReportsDirFor,
  type UserContext,
} from './user-context.js';

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
 */
const WEIGHTS: Record<string, number> = {
  eod_mover: 5,
  eod_traded: 3,
  gainer: 4,
  loser: 4,
  volume: 3,
  trending: 1,
};

/** Read the prior-session EOD report for a user's active stocks mode. */
async function loadLatestEodReport(ctx: UserContext): Promise<EodReport | null> {
  const mode = stockModeKey(getSettings(ctx.username));
  const file = join(stockReportsDirFor(ctx, mode), 'latest.json');
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw) as EodReport;
  } catch (err) {
    console.warn(
      `[premarket:${ctx.username}] failed to read EOD report ${file}:`,
      err instanceof Error ? err.message : String(err),
    );
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
    for (const mover of eod.top5Movers) bump(mover.symbol, 'eod_mover');
    // Symbols the engine actually traded yesterday — keep them under watch.
    const tradedSet = new Set<string>();
    for (const t of eod.trades) tradedSet.add(t.symbol.toUpperCase());
    for (const sym of tradedSet) bump(sym, 'eod_traded');
  }

  for (const r of preMarket) bump(r.symbol, r.reason);

  return [...scores.values()].sort((a, b) => b.score - a.score);
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
    console.warn(
      `[premarket:${ctx.username}] scanStocksMarket failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const ranked = scoreSymbols(eod, preMarketScan);

  // Skip names already in the base WATCHLIST — those are watched by default
  // and re-adding them would just clutter the per-user `stocks.added` audit.
  const baseSet = new Set((WATCHLIST as readonly string[]).map(s => s.toUpperCase()));
  const newcomers = ranked.filter(r => !baseSet.has(r.symbol)).slice(0, MAX_NEW_SYMBOLS);

  for (const r of newcomers) {
    try {
      await addStocksSymbol(ctx.username, r.symbol);
      ctx.engine.addSymbol(r.symbol);
    } catch (err) {
      console.warn(
        `[premarket:${ctx.username}] failed to add ${r.symbol}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (newcomers.length > 0) {
    ctx.engine.refresh();
  }

  const summary = newcomers.map(s => `${s.symbol}(${s.sources.join('|')})`).join(', ');
  console.log(
    `[premarket:${ctx.username}] smart watchlist: +${newcomers.length} symbol(s)${summary ? ` → ${summary}` : ''}`,
  );

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
      console.error(`[premarket:${ctx.username}] smart watchlist failed:`, err);
    }
  }
}
