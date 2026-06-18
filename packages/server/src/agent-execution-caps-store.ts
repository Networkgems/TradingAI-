// TRA-941 (TRA-813 P3) — daily execution caps for agent-placed orders, the
// circuit-breaker that bounds real-money exposure separately from the $2/day
// LLM spend cap (agent-spend-store). Numbers are QuantTrader's ratified TRA-939
// values:
//
//   • LIVE: max 5 orders/user/day, max $1,000 notional/user/day, AND a per-order
//     ceiling of $250 (TRA-939 §B, NEW). Whichever binds first stops placement;
//     the proposal stays pending (queues for manual approval), it is NOT dropped.
//   • DEMO: no order-count / notional cap beyond the existing 2% sizing cap, but
//     a runaway ops-guard soft cap of 50 demo orders/user/day stops a stuck or
//     looping agent (a safety stop, not a risk limit).
//
// Counting & reset semantics (TRA-939 §D): per user, per calendar day in
// America/New_York (ET), reset at ET midnight. Only orders the broker/paper book
// actually ACCEPTED count — a rejected/errored submission consumes no budget, so
// the caller records usage only after a successful open. A partial fill counts as
// one order at its submitted notional.
//
// Pattern mirrors agent-spend-store.ts: in-memory, process-global so the caps
// span every per-user engine in the process, keyed by (user, ET day).
import {
  type AccountMode,
  LIVE_MAX_ORDERS_PER_DAY,
  LIVE_MAX_NOTIONAL_PER_DAY_USD,
  LIVE_MAX_NOTIONAL_PER_ORDER_USD,
  DEMO_RUNAWAY_SOFT_CAP_PER_DAY,
} from '@trading-app/shared';
import { logger } from './observability/index.js';
import { etDateString } from './scheduler.js';

const log = logger.child({ module: 'agent-exec-caps' });

/** Env overrides for the ratified caps (empty/invalid → the default). */
export const LIVE_ORDERS_CAP_ENV_VAR = 'TRADING_AGENTS_LIVE_ORDERS_PER_DAY';
export const LIVE_NOTIONAL_CAP_ENV_VAR = 'TRADING_AGENTS_LIVE_NOTIONAL_PER_DAY_USD';
export const LIVE_PER_ORDER_CAP_ENV_VAR = 'TRADING_AGENTS_LIVE_NOTIONAL_PER_ORDER_USD';
export const DEMO_SOFT_CAP_ENV_VAR = 'TRADING_AGENTS_DEMO_ORDERS_SOFT_CAP_PER_DAY';

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function liveOrdersCap(): number {
  return envNum(LIVE_ORDERS_CAP_ENV_VAR, LIVE_MAX_ORDERS_PER_DAY);
}
export function liveNotionalCap(): number {
  return envNum(LIVE_NOTIONAL_CAP_ENV_VAR, LIVE_MAX_NOTIONAL_PER_DAY_USD);
}
export function livePerOrderCap(): number {
  return envNum(LIVE_PER_ORDER_CAP_ENV_VAR, LIVE_MAX_NOTIONAL_PER_ORDER_USD);
}
export function demoSoftCap(): number {
  return envNum(DEMO_SOFT_CAP_ENV_VAR, DEMO_RUNAWAY_SOFT_CAP_PER_DAY);
}

/** ET calendar-day bucket key, e.g. "2026-06-18" (resets at ET midnight). */
export function etDayKey(now: number): string {
  return etDateString(new Date(now));
}

interface ModeUsage {
  orders: number;
  notionalUsd: number;
}

interface DayBucket {
  day: string;
  /** Per-user, per-mode accepted-order usage for the day. */
  perUser: Map<string, { demo: ModeUsage; live: ModeUsage }>;
}

let bucket: DayBucket | null = null;

function currentBucket(now: number): DayBucket {
  const day = etDayKey(now);
  if (!bucket || bucket.day !== day) {
    bucket = { day, perUser: new Map() };
  }
  return bucket;
}

function userKey(user: string | undefined): string {
  const u = (user ?? '').trim();
  return u === '' ? 'anonymous' : u;
}

function usageFor(now: number, user: string | undefined): { demo: ModeUsage; live: ModeUsage } {
  const b = currentBucket(now);
  const u = userKey(user);
  let entry = b.perUser.get(u);
  if (!entry) {
    entry = { demo: { orders: 0, notionalUsd: 0 }, live: { orders: 0, notionalUsd: 0 } };
    b.perUser.set(u, entry);
  }
  return entry;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ExecutionGateDecision {
  /** True when this order may be placed under the daily caps. */
  allowed: boolean;
  /** Reason it was blocked (empty when allowed). */
  reason: string;
}

/**
 * Check whether placing one order of `notional` USD in `mode` is within the
 * ratified daily caps for `user` today. Pure read — does NOT consume budget;
 * the caller records usage via {@link recordExecutedOrder} only after the broker
 * accepts the order. Precedence on any exceeded cap: block + reason (the caller
 * then leaves the proposal pending for manual approval).
 */
export function checkDailyExecutionCaps(args: {
  user: string | undefined;
  mode: AccountMode;
  notional: number;
  now?: number;
}): ExecutionGateDecision {
  const now = args.now ?? Date.now();
  const notional = Number.isFinite(args.notional) ? Math.max(0, args.notional) : 0;
  const usage = usageFor(now, args.user);

  if (args.mode === 'live') {
    const perOrder = livePerOrderCap();
    if (notional > perOrder) {
      return { allowed: false, reason: `per-order live notional $${round2(notional)} exceeds $${perOrder} ceiling` };
    }
    const ordersCap = liveOrdersCap();
    if (usage.live.orders >= ordersCap) {
      return { allowed: false, reason: `daily live order cap reached (${usage.live.orders}/${ordersCap})` };
    }
    const notionalCap = liveNotionalCap();
    if (usage.live.notionalUsd + notional > notionalCap) {
      return {
        allowed: false,
        reason: `daily live notional cap reached ($${round2(usage.live.notionalUsd)} + $${round2(notional)} > $${notionalCap})`,
      };
    }
    return { allowed: true, reason: '' };
  }

  // Demo — uncapped on count/notional beyond the 2% sizing cap, except the
  // runaway ops-guard soft cap that stops a stuck/looping agent.
  const soft = demoSoftCap();
  if (usage.demo.orders >= soft) {
    return { allowed: false, reason: `demo runaway soft cap reached (${usage.demo.orders}/${soft}) — paused` };
  }
  return { allowed: true, reason: '' };
}

/**
 * Record one ACCEPTED agent order against the daily caps. Call ONLY after the
 * broker/paper book has accepted the order (rejected submissions consume no
 * budget, TRA-939 §D). Non-finite/negative notionals are clamped to 0.
 */
export function recordExecutedOrder(args: {
  user: string | undefined;
  mode: AccountMode;
  notional: number;
  now?: number;
}): void {
  const now = args.now ?? Date.now();
  const notional = Number.isFinite(args.notional) ? Math.max(0, args.notional) : 0;
  const usage = usageFor(now, args.user);
  const m = args.mode === 'live' ? usage.live : usage.demo;
  m.orders += 1;
  m.notionalUsd += notional;
  if (args.mode === 'live' && (m.orders >= liveOrdersCap() || m.notionalUsd >= liveNotionalCap())) {
    log.warn('agent live daily execution cap reached', {
      user: userKey(args.user),
      day: etDayKey(now),
      orders: m.orders,
      notionalUsd: round2(m.notionalUsd),
      ordersCap: liveOrdersCap(),
      notionalCap: liveNotionalCap(),
    });
  }
}

export interface ExecutionCapStatus {
  day: string;
  user: string;
  live: { orders: number; ordersCap: number; notionalUsd: number; notionalCap: number; perOrderCap: number };
  demo: { orders: number; softCap: number };
}

/** Snapshot of one user's daily execution-cap usage (drives the panel header). */
export function executionCapStatus(user: string | undefined, now = Date.now()): ExecutionCapStatus {
  const b = currentBucket(now);
  const usage = usageFor(now, user);
  return {
    day: b.day,
    user: userKey(user),
    live: {
      orders: usage.live.orders,
      ordersCap: liveOrdersCap(),
      notionalUsd: round2(usage.live.notionalUsd),
      notionalCap: liveNotionalCap(),
      perOrderCap: livePerOrderCap(),
    },
    demo: { orders: usage.demo.orders, softCap: demoSoftCap() },
  };
}

/** Test seam — reset the in-memory accumulator. */
export function resetExecutionCapsForTests(): void {
  bucket = null;
}
