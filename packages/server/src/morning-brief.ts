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
 *   2. Setups       — today's watchlist trade signals from each user's stocks +
 *                     crypto engines (`getState().signals`).
 *   3. Positions    — the open book: stocks + crypto spot/perp positions plus
 *                     open option legs.
 *   4. Overnight news — the headlines cached on each engine's last news refresh.
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

import type { NewsItem, Position, OptionPosition } from '@trading-app/shared';
import {
  emitAlert,
  type BriefHeadline,
  type BriefingAlertEvent,
  type BriefMacroIndex,
  type BriefPosition,
  type BriefSetup,
} from './notifications/index.js';
import { getFreshMarketReview } from './market-review.js';
import { getAllUserContexts, type UserContext } from './user-context.js';
import { etDateString } from './scheduler.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'morning-brief' });

/** Caps so a noisy session can't produce an unreadable wall-of-text brief. */
const MAX_SETUPS = 8;
const MAX_POSITIONS = 12;
const MAX_NEWS = 6;

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
): BriefingAlertEvent {
  const stocks = ctx.engine.getState();
  const crypto = ctx.cryptoEngine.getState();

  // Setups — most-recent signals across both engines, newest first.
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

  let emitted = 0;
  for (const ctx of getAllUserContexts()) {
    try {
      const event = buildBriefForUser(ctx, macro, date, ts);
      emitAlert(event);
      emitted += 1;
    } catch (err) {
      log.error('morning brief failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('morning brief dispatched', { date, regime: macro.regime, users: emitted });
}
