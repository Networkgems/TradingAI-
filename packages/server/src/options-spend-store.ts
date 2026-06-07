// TRA-658 (TRA-595 C4c) — CFO spend guardrail for the live "AI Options Ideas" feed.
//
// The CFO authorized recurring Anthropic spend for the live `GET /api/options/ideas`
// feed but bounded it (board approval 169f274f): $50/month, alert at 80%, hard stop
// at the cap. This module enforces that cap *in code* so the feed can never spend
// past it the moment the company key is provisioned:
//   - a rolling MONTHLY accumulator (calendar month, UTC), cap configurable via env
//   - a one-shot heads-up log when spend first crosses 80% of the cap
//   - a hard `isOverMonthlyCap` tripwire the service reads to auto-degrade the feed
//     to `source: 'non_live'` instead of issuing another paid LLM call
//   - a running monthly total surfaced for CFO review (log line + `optionsSpendStatus`)
//
// Only *real* (non-cached) LLM spend is recorded: a batch-cache hit re-serves a
// prior result for $0 and must not double-count against the cap.
import { logger } from './observability/index.js';

const log = logger.child({ module: 'options-spend' });

/** Board-approved starting cap (TRA-658 / approval 169f274f). Override via env. */
export const DEFAULT_MONTHLY_CAP_USD = 50;
/** Emit a single heads-up when spend first crosses this fraction of the cap. */
export const ALERT_RATIO = 0.8;
/** Env override for the monthly cap (USD). Empty/invalid → the default. */
export const CAP_ENV_VAR = 'OPTIONS_IDEAS_MONTHLY_USD_CAP';

/** The enforced monthly cap in USD — env-configurable, defaulting to the board floor. */
export function monthlyCapUsd(): number {
  const raw = process.env[CAP_ENV_VAR];
  if (raw == null || raw.trim() === '') return DEFAULT_MONTHLY_CAP_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MONTHLY_CAP_USD;
}

/** Calendar-month bucket key in UTC, e.g. "2026-06". */
export function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

interface MonthBucket {
  month: string;
  spentUsd: number;
  alerted: boolean;
}

// Process-wide accumulator. Resets automatically when the calendar month rolls.
let bucket: MonthBucket | null = null;

function currentBucket(now: number): MonthBucket {
  const month = monthKey(now);
  if (!bucket || bucket.month !== month) {
    bucket = { month, spentUsd: 0, alerted: false };
  }
  return bucket;
}

export interface SpendStatus {
  /** UTC calendar month this total covers, e.g. "2026-06". */
  month: string;
  /** Recorded Anthropic spend so far this month, USD. */
  spentUsd: number;
  /** The enforced cap, USD. */
  capUsd: number;
  /** spentUsd / capUsd (1 when the cap is 0). */
  ratio: number;
  /** True once the cap is reached — the feed degrades to non_live. */
  overCap: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Snapshot of the current month's spend vs the cap (for CFO review / diagnostics). */
export function optionsSpendStatus(now = Date.now()): SpendStatus {
  const b = currentBucket(now);
  const capUsd = monthlyCapUsd();
  return {
    month: b.month,
    spentUsd: round2(b.spentUsd),
    capUsd,
    ratio: capUsd > 0 ? round2(b.spentUsd / capUsd) : 1,
    overCap: b.spentUsd >= capUsd,
  };
}

/** Hard tripwire: true once this month's recorded spend has reached the cap. */
export function isOverMonthlyCap(now = Date.now()): boolean {
  const b = currentBucket(now);
  return b.spentUsd >= monthlyCapUsd();
}

/**
 * Record real (non-cached) LLM spend against the current month. Emits a one-shot
 * 80% alert and a cap-reached/auto-degrade log the first time each threshold is
 * crossed. Non-positive or non-finite costs are ignored. Returns the new status.
 */
export function recordOptionsSpend(costUsd: number, now = Date.now()): SpendStatus {
  const b = currentBucket(now);
  if (Number.isFinite(costUsd) && costUsd > 0) {
    const cap = monthlyCapUsd();
    const wasOverCap = b.spentUsd >= cap;
    b.spentUsd += costUsd;
    if (!b.alerted && cap > 0 && b.spentUsd >= cap * ALERT_RATIO) {
      b.alerted = true;
      log.warn('AI Options Ideas monthly LLM spend reached 80% of cap', {
        month: b.month,
        spentUsd: round2(b.spentUsd),
        capUsd: cap,
      });
    }
    if (!wasOverCap && b.spentUsd >= cap) {
      log.warn('AI Options Ideas monthly LLM spend cap reached — feed auto-degraded to non_live until next month', {
        month: b.month,
        spentUsd: round2(b.spentUsd),
        capUsd: cap,
      });
    }
  }
  return optionsSpendStatus(now);
}

/** Test seam — reset the in-memory accumulator. */
export function resetOptionsSpendForTests(): void {
  bucket = null;
}
