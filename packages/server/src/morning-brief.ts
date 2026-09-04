/**
 * TRA-849 — Scheduled pre-market morning briefing.
 *
 * Fires ~8:30 ET on trading days (via the scheduler's `onMorningBrief` hook,
 * 30 min before the 9:00 ET smart-watchlist build) and pushes a per-user
 * morning brief through the existing notification dispatcher. The brief has
 * four sections, each sourced from artifacts we already compute — no new
 * external infra:
 *
 *   1. Macro gate   — the latest pre-market market review (regime + VIX / S&P
 *                     trend / 10Y-yield index readings + the rationale). Global,
 *                     read once per run and shared across all users.
 *   2. Overnight setups — TRA-4303. The prior session's EOD movers + the names
 *                     that traded yesterday, fused with ONE fresh pre-market
 *                     screener pull, ranked by the same scorer the 09:00 build
 *                     uses. READ-ONLY (see {@link buildOvernightSection}).
 *   3. Prior-session engine signals — the tail of each engine's `recentSignals`
 *                     (`getState().signals`). TRA-4303 corrected the label this
 *                     docstring used to carry ("today's watchlist trade
 *                     signals"): that log only grows when a BAR EVALUATES, and
 *                     no bar evaluates overnight, so at the 08:30 fire the
 *                     newest entries are yesterday's RTH signals — never
 *                     today's. Restored from the snapshot across restarts
 *                     (`signal-engine.ts` `recentSignals`), so a redeploy does
 *                     not even reset it.
 *   4. Positions    — the open book: stocks + crypto spot/perp positions plus
 *                     open option legs.
 *   5. Overnight news — the headlines cached on each engine's last news refresh.
 *                     TRA-4303 measured this: `doTick` runs off-hours (only the
 *                     DECOUPLED quote refresher is RTH-gated,
 *                     `shouldRunDecoupledQuoteRefresh`) and refreshes the cache
 *                     on the 5-min `NEWS_REFRESH_MS` cadence, so at 08:30 ET
 *                     this section is genuinely fresh and was left alone.
 *
 * The brief is emitted as a `briefing` AlertEvent; the shared renderer formats
 * it and the dispatcher fans it out to whichever channels (email / Telegram /
 * Discord) the user has enabled for the `briefing` class. Delivery, dedup,
 * quiet-hours and failure-isolation are all the dispatcher's job — this module
 * only gathers and composes.
 *
 * Per-user failures are isolated so one user's outage can't starve the rest of
 * the fleet — same pattern as `runPremarketForAllUsers`.
 */

import type { EodReport, NewsItem, Position, OptionPosition } from '@trading-app/shared';
import {
  emitAlert,
  type BriefHeadline,
  type BriefingAlertEvent,
  type BriefMacroIndex,
  type BriefOvernightSection,
  type BriefOvernightSetup,
  type BriefPosition,
  type BriefSetup,
} from './notifications/index.js';
import { getFreshMarketReview } from './market-review.js';
import { loadLatestEodReport, scoreSymbols, suspectMover } from './premarket-watchlist.js';
import { scanStocksMarket, type ScanResult } from './market-scanner.js';
import { getAllUserContexts, type UserContext } from './user-context.js';
import { etDateString } from './scheduler.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'morning-brief' });

/** Caps so a noisy session can't produce an unreadable wall-of-text brief. */
const MAX_SETUPS = 8;
const MAX_POSITIONS = 12;
const MAX_NEWS = 6;
/** TRA-4303 — same rationale, applied to the overnight section. */
const MAX_OVERNIGHT = 8;

/** Shape of a market review with just the fields the brief reads. */
interface MacroSource {
  regime: string;
  rationale: string;
  indexes: BriefMacroIndex[];
}

/**
 * Build the macro-gate section from the latest pre-market market review. Returns
 * a neutral "unavailable" gate when no review can be read (cold store / feed
 * down) so the brief still renders rather than failing the whole run.
 */
export async function buildMacroSection(): Promise<MacroSource> {
  try {
    const review = await getFreshMarketReview('premarket');
    if (!review) {
      return { regime: 'unknown', rationale: 'No market review available yet.', indexes: [] };
    }
    return {
      regime: review.regime,
      rationale: review.regimeRationale,
      indexes: review.indexes.map((ix) => ({ label: ix.label, value: ix.value, note: ix.note })),
    };
  } catch (err) {
    log.warn('macro section unavailable', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return { regime: 'unknown', rationale: 'Market review unavailable.', indexes: [] };
  }
}

// ── TRA-4303 overnight / pre-close setups ────────────────────────────────────

/**
 * Kill switch for the overnight-setups section. Default **ON**.
 *
 * It is not a feature gate — the section's cost is bounded and stated below —
 * it is an operator escape hatch for the one thing that could go wrong on the
 * live host: Yahoo's rate limit. `MORNING_BRIEF_OVERNIGHT_SETUPS=0` (or
 * `false`/`no`/`off`) drops the extra scan and the section with it, and the
 * brief renders byte-identically to the pre-TRA-4303 one. Unset means ON, so
 * bqb1 gets the section on the first deploy that carries it without an env
 * write — which matters, because an env write there is its own operator verb
 * (TRA-3724) and this change does not deserve one.
 */
const OVERNIGHT_FLAG = 'MORNING_BRIEF_OVERNIGHT_SETUPS';

export function isOvernightSetupsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OVERNIGHT_FLAG];
  if (typeof raw !== 'string' || raw.trim() === '') return true;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/**
 * MEASURED COST (acceptance #5).
 *
 * `scanStocksMarket()` is exactly four Yahoo requests: three `screener` calls
 * (`day_gainers`, `day_losers`, `most_actives`, count 10 each) and one
 * `trendingSymbols('US', count 20)`. Each is individually try/caught inside the
 * scanner, so a throttled screener degrades that leg and not the pull.
 *
 * This module makes that pull **at most once per {@link OVERNIGHT_SCAN_TTL_MS}
 * process-wide**, not once per user: `runMorningBriefForAllUsers` reads it once
 * before the per-user loop (same shape as the shared macro read), and the TTL
 * cache bounds the on-demand `brief` routine, which a user can schedule at any
 * hour. So the 08:30 brief costs **+4 Yahoo requests per trading day**.
 *
 * It does NOT enter the 09:00 build's ceiling. `generateSmartWatchlist` calls
 * `scanStocksMarket()` itself, directly, per user — that call site is untouched
 * and does not read this cache, so the 09:00 fan-out is numerically identical
 * to what it was. The 30-minute TTL is also strictly shorter than the 08:30 →
 * 09:00 gap, which is deliberate: the 09:00 build must never be served a
 * half-hour-old screener read that this section warmed.
 *
 * ⛔ The news-catalyst leg is deliberately NOT run here, and that is a
 * documented deviation from the issue's option-B sketch. `buildNewsCatalystPicks`
 * fans `fetchMarketNews` out over `catalystUniverse()` (the whole WATCHLIST plus
 * every equity name alias) plus `fetchCatalystMetrics` — tens of requests, which
 * is precisely the unbounded second pull acceptance #5 forbids — and it appends
 * a `recordCatalystRun` row, so running it twice a session would corrupt the
 * discovery-run ledger TRA-1629 built to measure the 09:00 run. Its flag
 * (`ENABLE_NEWS_CATALYST_WATCHLIST`) is OFF on bqb1 today, so nothing is missing
 * from the board's brief; when it is armed, the 09:00 build still consumes it.
 */
const OVERNIGHT_SCAN_TTL_MS = 30 * 60_000;

/** Outcome of the shared pre-market pull: rows plus whether the leg worked. */
export interface OvernightScan {
  rows: ScanResult[];
  ok: boolean;
  /** Failure reason when `ok` is false. */
  reason?: string;
}

let scanCache: { at: number; value: OvernightScan } | null = null;

/** Test seam — drop the TTL cache so a test can control the pull count. */
export function resetOvernightScanCache(): void {
  scanCache = null;
}

/**
 * The overnight leg: one bounded `scanStocksMarket()` pull, TTL-cached.
 *
 * Never throws — a scanner failure comes back as `{ ok: false, reason }` so the
 * caller can degrade the section by name instead of losing the brief. Failures
 * are deliberately NOT cached: the pull is rare enough that retrying the next
 * caller is cheaper than blanking the section for half an hour on one blip.
 */
export async function getOvernightScan(now: number = Date.now()): Promise<OvernightScan> {
  if (scanCache && now - scanCache.at < OVERNIGHT_SCAN_TTL_MS) return scanCache.value;
  try {
    const rows = await scanStocksMarket();
    const value: OvernightScan = { rows, ok: true };
    scanCache = { at: now, value };
    return value;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('overnight scan unavailable', { reason });
    return { rows: [], ok: false, reason };
  }
}

/**
 * Human label per scoring source, so every row says WHY it is listed
 * (acceptance #1). Keys mirror `premarket-watchlist`'s `WEIGHTS`; an unmapped
 * source falls through to its raw key rather than being dropped, so a new
 * source added there shows up here as itself instead of silently vanishing.
 */
const LEG_LABEL: Record<string, string> = {
  eod_mover: 'prior-close mover',
  eod_traded: 'traded yesterday',
  gainer: 'pre-market gainer',
  loser: 'pre-market loser',
  volume: 'most active',
  trending: 'trending',
};

/**
 * Build one user's overnight-setups section from the prior-session EOD report
 * (per-user: it is that user's mode's `latest.json`) and the shared pre-market
 * scan.
 *
 * ⛔ READ-ONLY, and that is the point of acceptance #3. This function calls
 * `loadLatestEodReport` (a disk read), the pure `scoreSymbols`, and nothing
 * else. It does not call `addStocksSymbol`, `engine.addSymbol` or
 * `engine.refresh()`, and it does not touch the watchlist store. The 09:00
 * `onPremarket` build remains the single writer of the smart watchlist; this
 * section shows the board 30 minutes early what that build is about to see.
 *
 * Degradation (acceptance #4): both legs dead ⇒ `available: false` and the
 * renderer prints "unavailable". One leg dead ⇒ the section still renders, off
 * the surviving leg, carrying a note that names the dead one. It never throws.
 */
export async function buildOvernightSection(
  ctx: UserContext,
  scan: OvernightScan,
): Promise<BriefOvernightSection> {
  let eod: EodReport | null = null;
  try {
    eod = await loadLatestEodReport(ctx);
  } catch (err) {
    // `loadLatestEodReport` already swallows read/parse failures into `null`;
    // this is the belt-and-braces so a future change there cannot kill a brief.
    log.warn('overnight EOD leg unavailable', {
      username: ctx.username,
      reason: err instanceof Error ? err.message : String(err),
    });
    eod = null;
  }

  const notes: string[] = [];
  if (!eod) notes.push('prior-session report unavailable');
  if (!scan.ok) notes.push('pre-market scan unavailable');
  if (!eod && !scan.ok) {
    return { available: false, rows: [], note: notes.join('; ') };
  }

  // The same scorer the 09:00 build uses — which is also where acceptance #2 is
  // enforced: `scoreSymbols` puts every `top5Movers` row through `suspectMover`
  // before it can earn the `eod_mover` bump. The catalyst argument is omitted
  // (see OVERNIGHT_SCAN_TTL_MS's note), so this is the price/volume fusion only.
  const ranked = scoreSymbols(eod, scan.rows);

  // Move size per row. The pre-market screener's %-change wins where there is
  // one — it is the more recent fact and it is the "overnight gap" the board
  // asked about; the prior session's close only fills the gaps.
  //
  // Acceptance #2 again, and this is the leg that needs it stated: a symbol can
  // reach `ranked` through the SCAN even when its archived EOD row was
  // condemned, so guarding only the scorer would still let a fabricated
  // `changePct` be rendered beside a legitimately-ranked symbol. Guard the
  // price/move seed too, exactly as `filterByPriceFloor` does.
  const changeBySymbol = new Map<string, number>();
  for (const r of scan.rows) {
    if (typeof r.changePct === 'number' && Number.isFinite(r.changePct)) {
      changeBySymbol.set(r.symbol.toUpperCase(), r.changePct);
    }
  }
  if (eod) {
    for (const mover of eod.top5Movers) {
      if (suspectMover(mover)) continue;
      const sym = mover.symbol.toUpperCase();
      if (!changeBySymbol.has(sym) && Number.isFinite(mover.changePct)) {
        changeBySymbol.set(sym, mover.changePct);
      }
    }
  }

  const rows: BriefOvernightSetup[] = ranked.slice(0, MAX_OVERNIGHT).map((r) => {
    const changePct = changeBySymbol.get(r.symbol);
    return {
      symbol: r.symbol,
      legs: r.sources.map((s) => LEG_LABEL[s] ?? s),
      score: r.score,
      ...(changePct != null ? { changePct } : {}),
    };
  });

  return {
    available: true,
    rows,
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
}

/** Map a TradeSignal-shaped record onto a brief setup row. */
function toSetup(s: {
  symbol: string;
  type: string;
  side: string;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
}): BriefSetup {
  return {
    symbol: s.symbol,
    signalType: s.type,
    side: s.side,
    entryPrice: Number.isFinite(s.entryPrice) ? s.entryPrice : undefined,
    stopLoss: Number.isFinite(s.stopLoss) ? s.stopLoss : undefined,
    takeProfit: Number.isFinite(s.takeProfit) ? s.takeProfit : undefined,
  };
}

/** Map an equity/crypto spot/perp position onto a brief position row. */
function toPosition(p: Position, market: 'stocks' | 'crypto'): BriefPosition {
  return {
    symbol: p.symbol,
    market,
    side: p.side,
    quantity: p.quantity,
    entryPrice: p.entryPrice,
    ...(p.productType === 'perp' ? { detail: 'perp' } : {}),
  };
}

/** Map an open option leg onto a brief position row with an unrealized-P&L estimate. */
function toOptionPosition(o: OptionPosition): BriefPosition {
  const legBits = [o.optionType, o.strike != null ? String(o.strike) : '', o.expiration ?? '']
    .filter(Boolean)
    .join(' ');
  const qty = o.contractsRemaining > 0 ? o.contractsRemaining : o.contracts;
  // Per-contract premium covers 100 shares; estimate live unrealized P&L.
  const pnl =
    Number.isFinite(o.currentPremium) && Number.isFinite(o.premiumPaid)
      ? (o.currentPremium - o.premiumPaid) * qty * 100
      : undefined;
  return {
    symbol: o.symbol,
    market: 'options',
    side: 'long',
    quantity: qty,
    entryPrice: o.premiumPaid,
    ...(legBits ? { detail: legBits } : {}),
    ...(pnl != null ? { pnl } : {}),
  };
}

/** Merge + dedupe + recency-sort the cached news from both engines. */
function toHeadlines(items: NewsItem[]): BriefHeadline[] {
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  const out: BriefHeadline[] = [];
  for (const n of sorted) {
    const key = (n.title ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ title: n.title, source: n.source });
    if (out.length >= MAX_NEWS) break;
  }
  return out;
}

/**
 * Compose the brief event for one user. Pulls live engine state (signals +
 * open book + cached news) and stitches it onto the shared macro section.
 * Pure given its inputs except for the engine reads — exported so a test or an
 * on-demand endpoint can build a brief without the dispatcher.
 */
export function buildBriefForUser(
  ctx: UserContext,
  macro: MacroSource,
  date: string,
  timestamp: number,
  /**
   * TRA-4303 — the overnight section, built by the caller (it is async and its
   * scan leg is shared across users; this function stays synchronous and
   * engine-only). Omitted ⇒ the renderer drops the section entirely.
   */
  overnight?: BriefOvernightSection,
): BriefingAlertEvent {
  const stocks = ctx.engine.getState();
  const crypto = ctx.cryptoEngine.getState();

  // TRA-4303 — the PRIOR session's signals, not today's. `recentSignals` grows
  // only when a bar evaluates and no bar evaluates overnight; the renderer
  // labels it honestly. The overnight read is `overnight`, threaded below.
  const setups = [...stocks.signals, ...crypto.signals]
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, MAX_SETUPS)
    .map(toSetup);

  // Positions — stocks + crypto spot/perp + open option legs.
  const positions: BriefPosition[] = [
    ...stocks.account.openPositions.map((p) => toPosition(p, 'stocks')),
    ...crypto.account.openPositions.map((p) => toPosition(p, 'crypto')),
    ...stocks.options.openOptions.map(toOptionPosition),
  ].slice(0, MAX_POSITIONS);

  // News — cached on each engine's last refresh; no fresh network fetch.
  const news = toHeadlines([...ctx.engine.getNews(), ...ctx.cryptoEngine.getNews()]);

  return {
    kind: 'briefing',
    username: ctx.username,
    timestamp,
    date,
    macro: { regime: macro.regime, rationale: macro.rationale, indexes: macro.indexes },
    setups,
    positions,
    news,
    ...(overnight ? { overnight } : {}),
  };
}

/**
 * Fan the morning brief out across every active user. Wired into the scheduler's
 * `onMorningBrief` hook from `index.ts`. The macro section is read once and
 * shared; per-user composition + emit is isolated so one user can't break the
 * fleet. Emits are fire-and-forget through the dispatcher.
 */
export async function runMorningBriefForAllUsers(now: Date = new Date()): Promise<void> {
  const date = etDateString(now);
  const ts = now.getTime();
  const macro = await buildMacroSection();

  // TRA-4303 — ONE pre-market pull for the whole fleet, read before the loop and
  // shared, exactly like the macro section. Per-user inside the loop would
  // multiply the Yahoo cost by the user count, which is the thing acceptance #5
  // forbids. `getOvernightScan` never throws.
  const enabled = isOvernightSetupsEnabled();
  const scan = enabled ? await getOvernightScan() : null;

  let emitted = 0;
  for (const ctx of getAllUserContexts()) {
    try {
      // Per-user EOD leg + composition, inside the existing isolation so one
      // user's unreadable report can't starve the fleet.
      const overnight = scan ? await buildOvernightSection(ctx, scan) : undefined;
      const event = buildBriefForUser(ctx, macro, date, ts, overnight);
      emitAlert(event);
      emitted += 1;
    } catch (err) {
      log.error('morning brief failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('morning brief dispatched', {
    date,
    regime: macro.regime,
    users: emitted,
    overnight: !enabled ? 'off' : scan?.ok ? 'scan_ok' : 'scan_failed',
  });
}
