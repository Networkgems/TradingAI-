// ── Analyst-agent schedule wiring (TRA-1006) ─────────────────────────────────
//
// Drives the TRA-1006 analyst agent on the existing market-scheduler ticks: a
// pre-open tick (builds + publishes the day's plan) and a post-close tick (folds
// the day's demo journal + enqueues ≥1 hypothesis). Both are hooked alongside the
// existing `onPremarket` / EOD (`onArchive`) hooks in index.ts.
//
// STRICTLY behind `ENABLE_ANALYST_AGENT` (default-OFF): every tick checks the flag
// FIRST and short-circuits BEFORE constructing any deps (candle feeds, market
// review, journal reads, backtest executor), so a deploy with the flag off does
// ZERO IO/cost — just one cheap env read per tick. Flipping the flag ON is an
// operator/board activation decision, not this issue's job.

import type { Candle } from '@trading-app/shared';

import { logger } from './observability/index.js';
import { getAllUserContexts } from './user-context.js';
import { getStocksWatchlistData, seedReviewLeaders } from './watchlist-store.js';
import { fetchDailyCandles } from './yahoo-feed.js';
import { generateMarketReview } from './market-review.js';
import { listOptionTradeJournal } from './option-trade-journal.js';
import { makeBacktestExecutor, RV_CRYPTO_MAJORS_BASE_CONFIG } from './backtest-executor.js';
import {
  isAnalystAgentEnabled,
  analystEtDate,
  readAnalystPlan,
  runPremarketPlan,
  runPostmarketReview,
  MAX_PLAN_SYMBOLS,
  type AnalystTunable,
  type RunPremarketDeps,
  type RunPostmarketDeps,
} from './analyst-agent.js';

const log = logger.child({ module: 'analyst-scheduler' });

/** Daily bars pulled per symbol for S/R + reversal scoring. */
const DAILY_BARS = 120;

/**
 * Default tunable map (QuantTrader owns refinement at sign-off). Bridges the
 * common demo option setup-types to numeric leaves of the backtest base config,
 * with tighten (R1, risk-reducing) + nudge (R2, small upward) deltas declared so
 * direction is auditable. Everything still clears the G0 gate + board ratification
 * before it can touch even demo sizing — the demo-override flag stays OFF.
 */
export const DEFAULT_ANALYST_TUNABLES: AnalystTunable[] = [
  {
    key: 'single_leg_rv',
    kind: 'sleeve',
    path: 'RV_CRYPTO_MAJORS.riskPerTradePct',
    tighten: { op: 'mul', value: 0.9 }, // less risk per trade
    nudge: { op: 'mul', value: 1.1 },
  },
  {
    key: 'mean_reversion',
    kind: 'gate',
    path: 'RV_CRYPTO_MAJORS.rsiOversold',
    tighten: { op: 'mul', value: 0.9 }, // demand a deeper oversold to enter
    nudge: { op: 'mul', value: 1.1 },
  },
  {
    key: 'breakout',
    kind: 'gate',
    path: 'RV_CRYPTO_MAJORS.atrStopMultiplier',
    tighten: { op: 'mul', value: 0.9 }, // tighter stop
    nudge: { op: 'mul', value: 1.1 },
  },
];

/** Outcome of one scheduled analyst tick — for logging/tests. */
export interface AnalystTickOutcome {
  ran: boolean;
  reason?: 'disabled' | 'no-deps';
}

/** Injectable seams so a tick is fully unit-testable without feeds/LLM/IO. */
export interface AnalystTickInject {
  buildPremarketDeps?: (nowMs: number, env: NodeJS.ProcessEnv) => Promise<RunPremarketDeps | null>;
  buildPostmarketDeps?: (nowMs: number, env: NodeJS.ProcessEnv) => Promise<RunPostmarketDeps | null>;
}

/** Union of every user's stocks watchlist, de-duped + capped — the plan universe. */
function collectWatchlistSymbols(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ctx of getAllUserContexts()) {
    for (const sym of getStocksWatchlistData(ctx.username).all) {
      const u = sym.trim().toUpperCase();
      if (u && !seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
  }
  return out.slice(0, MAX_PLAN_SYMBOLS);
}

/**
 * Build the production pre-market deps from the live feeds, or `null` when nothing
 * can run (no users / no watchlist). ONLY called once the flag is on.
 */
export async function buildPremarketDeps(
  nowMs: number,
  _env: NodeJS.ProcessEnv = process.env,
): Promise<RunPremarketDeps | null> {
  const contexts = getAllUserContexts();
  if (contexts.length === 0) return null;

  const universe = collectWatchlistSymbols();
  if (universe.length === 0) return null;

  const review = await generateMarketReview('premarket');

  const symbols: { symbol: string; candles: Candle[] }[] = [];
  for (const symbol of universe) {
    const candles = await fetchDailyCandles(symbol, DAILY_BARS).catch(() => [] as Candle[]);
    if (candles.length > 0) symbols.push({ symbol, candles });
  }
  if (symbols.length === 0) return null;

  return {
    date: review.date,
    now: nowMs,
    regime: review.regime,
    regimeRationale: review.regimeRationale,
    gates: review.gates,
    gapRisk: review.reviewBlock?.gapRisk ?? false,
    symbols,
    publish: async (block) => {
      for (const ctx of contexts) {
        try {
          await seedReviewLeaders(ctx.username, block);
        } catch (err) {
          log.warn('analyst plan publish failed for user', {
            username: ctx.username,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}

/**
 * Build the production post-market deps. Reads the day's regime from the persisted
 * plan when present (else recomputes via a post-market review), the day's DEMO
 * journal, and the same backtest executor the external-intel pipeline uses.
 */
export async function buildPostmarketDeps(
  nowMs: number,
  _env: NodeJS.ProcessEnv = process.env,
): Promise<RunPostmarketDeps | null> {
  const date = analystEtDate(nowMs);
  const plan = await readAnalystPlan(date);
  const regime = plan?.regime ?? (await generateMarketReview('postmarket')).regime;
  const rows = await listOptionTradeJournal({ mode: 'demo' });

  return {
    date,
    now: nowMs,
    regime,
    rows,
    plan,
    baseConfig: RV_CRYPTO_MAJORS_BASE_CONFIG,
    tunables: DEFAULT_ANALYST_TUNABLES,
    pipeline: {
      baseConfig: RV_CRYPTO_MAJORS_BASE_CONFIG,
      runBacktest: makeBacktestExecutor(),
    },
  };
}

/**
 * Run ONE pre-market analyst tick. The flag is checked FIRST, before any deps are
 * built, so a tick with `ENABLE_ANALYST_AGENT` off does zero IO/cost.
 */
export async function runAnalystPremarketTick(
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
  inject: AnalystTickInject = {},
): Promise<AnalystTickOutcome> {
  if (!isAnalystAgentEnabled(env)) return { ran: false, reason: 'disabled' };
  const build = inject.buildPremarketDeps ?? buildPremarketDeps;
  const deps = await build(nowMs, env);
  if (!deps) return { ran: false, reason: 'no-deps' };
  await runPremarketPlan(deps);
  return { ran: true };
}

/**
 * Run ONE post-market analyst tick. Flag-checked before deps, same as pre-market.
 */
export async function runAnalystPostmarketTick(
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
  inject: AnalystTickInject = {},
): Promise<AnalystTickOutcome> {
  if (!isAnalystAgentEnabled(env)) return { ran: false, reason: 'disabled' };
  const build = inject.buildPostmarketDeps ?? buildPostmarketDeps;
  const deps = await build(nowMs, env);
  if (!deps) return { ran: false, reason: 'no-deps' };
  await runPostmarketReview(deps);
  return { ran: true };
}
