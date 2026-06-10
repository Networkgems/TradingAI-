// TRA-747 (TRA-529 P2 §6.5) — the CFO spend guardrail for the advisory
// multi-agent layer. The CFO approved the envelope on TRA-746 with four operating
// conditions; this module enforces the cost ones IN CODE so the layer can never
// spend past them once the company Anthropic key is provisioned:
//
//   • a HARD per-user/day cap of $2.00 (acceptance #1) — every AgentRecommendation
//     stamps its real costUsd, the day's running total per user is accumulated
//     here, and `isOverUserDailyCap` halts that user/day at the cap. No untested cap.
//   • a DAILY AGGREGATE readout across ALL users (acceptance #4) — the CFO owns the
//     P&L and wants the absolute number, not just the per-user bound. `agentSpendAggregate`
//     returns it for `GET /api/health/agent-spend`, and a one-shot daily INFO log
//     emits it for the record.
//   • a re-review tripwire (FYI per the issue) — a one-shot WARN when aggregate spend
//     first crosses ~$50/day, the level at which the CFO revisits the envelope.
//
// Pattern mirrors options-spend-store.ts (the TRA-658 monthly cap) but keyed by
// (user, ET/UTC day) with an aggregate roll-up. In-memory + process-global so the
// aggregate spans every per-user engine in the process; resets when the day rolls.
import { logger } from './observability/index.js';

const log = logger.child({ module: 'agent-spend' });

/** CFO-approved per-user/day cap (TRA-746/TRA-747 §6.5). Override via env. */
export const DEFAULT_DAILY_USER_CAP_USD = 2;
/** Aggregate level at which the CFO revisits the envelope (re-review tripwire, FYI). */
export const DEFAULT_AGGREGATE_REVIEW_USD = 50;
/** Env override for the per-user/day cap (USD). Empty/invalid → the default. */
export const USER_CAP_ENV_VAR = 'TRADING_AGENTS_DAILY_USER_USD_CAP';
/** Env override for the aggregate re-review level (USD). */
export const AGGREGATE_REVIEW_ENV_VAR = 'TRADING_AGENTS_AGGREGATE_REVIEW_USD';

function envUsd(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The enforced per-user/day cap in USD — env-configurable, defaulting to $2. */
export function dailyUserCapUsd(): number {
  return envUsd(USER_CAP_ENV_VAR, DEFAULT_DAILY_USER_CAP_USD);
}

/** The aggregate re-review level in USD — env-configurable, defaulting to $50. */
export function aggregateReviewUsd(): number {
  return envUsd(AGGREGATE_REVIEW_ENV_VAR, DEFAULT_AGGREGATE_REVIEW_USD);
}

/** Calendar-day bucket key in UTC, e.g. "2026-06-09". */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

interface DayBucket {
  day: string;
  /** Per-user spend for the day, USD. */
  perUser: Map<string, number>;
  /** One-shot: aggregate crossed the re-review level. */
  reviewAlerted: boolean;
}

// Process-wide accumulator. Resets automatically when the calendar day rolls.
let bucket: DayBucket | null = null;

function currentBucket(now: number): DayBucket {
  const day = dayKey(now);
  if (!bucket || bucket.day !== day) {
    // On the day roll, emit the CLOSING aggregate readout for the day that just
    // ended (acceptance #4: a real end-of-day total, not a $0 start-of-day one).
    if (bucket) emitClosingReadout(bucket);
    bucket = { day, perUser: new Map(), reviewAlerted: false };
  }
  return bucket;
}

function emitClosingReadout(b: DayBucket): void {
  let total = 0;
  const perUser: Array<{ user: string; spentUsd: number }> = [];
  for (const [user, spent] of b.perUser) {
    total += spent;
    perUser.push({ user, spentUsd: round4(spent) });
  }
  perUser.sort((a, c) => c.spentUsd - a.spentUsd);
  log.info('trading-agents daily aggregate LLM spend readout (day closed)', {
    day: b.day,
    totalUsd: round2(total),
    userCount: perUser.length,
    userCapUsd: dailyUserCapUsd(),
    perUser,
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Normalise a user key so an unset owner still has a stable bucket. */
function userKey(user: string | undefined): string {
  const u = (user ?? '').trim();
  return u === '' ? 'anonymous' : u;
}

export interface UserSpendStatus {
  /** UTC calendar day this total covers, e.g. "2026-06-09". */
  day: string;
  user: string;
  /** Recorded LLM spend so far today for this user, USD. */
  spentUsd: number;
  /** The enforced per-user/day cap, USD. */
  capUsd: number;
  /** Remaining headroom before the cap, USD (0 once reached). */
  remainingUsd: number;
  /** True once this user has reached the cap today — the layer stops spending. */
  overCap: boolean;
}

/** Snapshot of one user's spend vs the per-user/day cap. */
export function agentUserSpendStatus(user: string | undefined, now = Date.now()): UserSpendStatus {
  const b = currentBucket(now);
  const u = userKey(user);
  const cap = dailyUserCapUsd();
  const spent = b.perUser.get(u) ?? 0;
  return {
    day: b.day,
    user: u,
    spentUsd: round4(spent),
    capUsd: cap,
    remainingUsd: round4(Math.max(0, cap - spent)),
    overCap: spent >= cap,
  };
}

/**
 * Hard tripwire (acceptance #1): true once this user's recorded spend has reached
 * the per-user/day cap. The advisory layer reads this BEFORE issuing a paid LLM
 * call and falls back to the deterministic (zero-cost) path when it is true, so a
 * user/day can never spend past the cap.
 */
export function isOverUserDailyCap(user: string | undefined, now = Date.now()): boolean {
  const b = currentBucket(now);
  return (b.perUser.get(userKey(user)) ?? 0) >= dailyUserCapUsd();
}

export interface AggregateSpendStatus {
  /** UTC calendar day this total covers. */
  day: string;
  /** Total LLM spend across ALL users today, USD (the CFO's absolute number). */
  totalUsd: number;
  /** Per-user breakdown, sorted high→low. */
  perUser: Array<{ user: string; spentUsd: number }>;
  /** Number of users with any spend today. */
  userCount: number;
  /** The enforced per-user/day cap, USD. */
  userCapUsd: number;
  /** The aggregate level at which the CFO revisits the envelope. */
  reviewUsd: number;
  /** True once aggregate spend has crossed the re-review level. */
  overReview: boolean;
}

/**
 * The DAILY AGGREGATE readout (acceptance #4): total $/day across all users plus a
 * per-user breakdown. Served by `GET /api/health/agent-spend` and logged once/day.
 */
export function agentSpendAggregate(now = Date.now()): AggregateSpendStatus {
  const b = currentBucket(now);
  let total = 0;
  const perUser: Array<{ user: string; spentUsd: number }> = [];
  for (const [user, spent] of b.perUser) {
    total += spent;
    perUser.push({ user, spentUsd: round4(spent) });
  }
  perUser.sort((a, c) => c.spentUsd - a.spentUsd);
  const reviewUsd = aggregateReviewUsd();
  return {
    day: b.day,
    totalUsd: round2(total),
    perUser,
    userCount: perUser.length,
    userCapUsd: dailyUserCapUsd(),
    reviewUsd,
    overReview: total >= reviewUsd,
  };
}

/**
 * Record real (non-zero) LLM spend for a user against the current day. Emits a
 * one-shot WARN the first time the daily aggregate crosses the re-review level.
 * Non-positive or non-finite costs are ignored. Returns the user's new status.
 */
export function recordAgentSpend(
  user: string | undefined,
  costUsd: number,
  now = Date.now(),
): UserSpendStatus {
  const b = currentBucket(now);
  const u = userKey(user);
  if (Number.isFinite(costUsd) && costUsd > 0) {
    b.perUser.set(u, (b.perUser.get(u) ?? 0) + costUsd);
    const agg = agentSpendAggregate(now);
    if (!b.reviewAlerted && agg.totalUsd >= aggregateReviewUsd()) {
      b.reviewAlerted = true;
      log.warn('trading-agents aggregate LLM spend crossed the CFO re-review level', {
        day: agg.day,
        totalUsd: agg.totalUsd,
        reviewUsd: agg.reviewUsd,
        userCount: agg.userCount,
      });
    }
  }
  return agentUserSpendStatus(u, now);
}

/**
 * Force-log the CURRENT running aggregate-spend readout (acceptance #4: "a simple
 * logged/queryable daily total is fine"). Intended for a once-daily scheduler hook
 * (e.g. the 9 PM ET close) so the day's total is on the record even if the process
 * does not survive to the natural day-roll readout. The live total is always
 * queryable at `GET /api/health/agent-spend`.
 */
export function logAgentSpendDailyReadout(now = Date.now()): void {
  const agg = agentSpendAggregate(now);
  log.info('trading-agents daily aggregate LLM spend readout', {
    day: agg.day,
    totalUsd: agg.totalUsd,
    userCount: agg.userCount,
    userCapUsd: agg.userCapUsd,
    perUser: agg.perUser,
  });
}

/** Test seam — reset the in-memory accumulator. */
export function resetAgentSpendForTests(): void {
  bucket = null;
}
