// TRA-1001 (parent TRA-995) — CONSUME the risk-autopilot throttle in per-trade
// sizing.
//
// TRA-995 shipped the autopilot: it decides HALT or THROTTLE and can only ever
// tighten. Its HALT has been consumed live since day one (every entry chokepoint
// reads `riskGovernor.isHalted()`), but the THROTTLE was surfaced-and-observed
// only — a 50% throttle logged a de-risk action in health + EOD while every
// ticket still sized at 100%. This module is the seam that makes the throttle
// actually trim share/contract counts.
//
// Two things live here, deliberately together:
//
//   1. `riskThrottleSizeMultiplier` — the PURE tighten-only clamp. It is the
//      single place that decides what a throttle value means for sizing, so the
//      "never raises a sized quantity" invariant is one unit-testable function
//      rather than a rule re-implemented at six call sites.
//
//   2. A since-boot counted registry. The throttle is 1 on most days, and a
//      multiplier of 1 is byte-for-byte the pre-TRA-1001 behaviour — i.e. an
//      ARMED-but-never-throttled build reads EXACTLY like an unarmed one, and
//      like a build where the wiring silently regressed. `trims` makes "did the
//      consuming path ever actually run with a real throttle?" a countable
//      question instead of an assumption (the TRA-2302 `source`-enum lesson).
//
// GATED (the issue title): this changes LIVE position-sizing math, so it ships
// OFF and the board arms it with `RISK_THROTTLE_SIZING_ENABLED` after forward
// evidence, exactly like the other live-risk flags in `exit-risk-rules-flag.ts`.
// Flag OFF ⇒ multiplier is always 1 ⇒ sizing is byte-for-byte unchanged, and the
// registry still records the consult (with `armed: false`), so health can show
// how often a throttle WOULD have trimmed before anyone flips it.

import { MIN_RISK_THROTTLE } from './risk-autopilot.js';

export const RISK_THROTTLE_SIZING_FLAG = 'RISK_THROTTLE_SIZING_ENABLED';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff the risk-autopilot throttle is CONSUMED by per-trade sizing
 * (accepts 1/true/yes/on). Standalone — deliberately NOT under the
 * `EXIT_RISK_RULES_ENABLED` master, because this arms a tightening that must be
 * flippable without also arming the exit-side rules on the live options path.
 * OFF by default.
 */
export function isRiskThrottleSizingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[RISK_THROTTLE_SIZING_FLAG]);
}

/**
 * The tighten-only sizing multiplier for a given autopilot throttle.
 *
 * Contract — the invariant TRA-995 Invariant 4 demands, enforced here so no
 * caller can violate it by arithmetic accident:
 *   • `armed === false`      ⇒ 1 (dark; sizing unchanged)
 *   • non-finite throttle    ⇒ 1 (no information ⇒ no trim; a NaN must never
 *                                 silently zero the book)
 *   • throttle ≥ 1           ⇒ 1 (the autopilot may never RAISE size)
 *   • otherwise              ⇒ clamped into [MIN_RISK_THROTTLE, 1)
 *
 * The `≤ 0` case clamps UP to `MIN_RISK_THROTTLE` rather than through to 0: a
 * zero/negative throttle is a corrupted input, and the conservative reading of
 * "de-risk" is "size small", not "the autopilot silently became a second halt".
 * A real halt is a separate, explicit, surfaced state (`isHalted()`).
 *
 * The return value is never > 1, so composing it into an existing
 * `sizeMultiplier` argument can only ever shrink a sized quantity.
 */
export function riskThrottleSizeMultiplier(throttle: number | null | undefined, armed: boolean): number {
  if (!armed) return 1;
  if (typeof throttle !== 'number' || !Number.isFinite(throttle)) return 1;
  if (throttle >= 1) return 1;
  return Math.min(1, Math.max(MIN_RISK_THROTTLE, throttle));
}

// ── Counted-reason telemetry ────────────────────────────────────────────────

/** Which sizing chokepoint consulted the throttle. */
export type RiskThrottleSizingPath =
  /** Live Tradier equity bracket — the real broker order quantity. */
  | 'equity_live'
  /** Local mirror of that bracket (kept in lockstep with `equity_live`). */
  | 'equity_live_mirror'
  /** Demo `PaperAccount.openPosition` share sizing. */
  | 'equity_demo'
  /** Single-leg options open (RV / directional / AI-ideas). */
  | 'options_single_leg'
  /** OTM-mispricing options open. */
  | 'options_otm'
  /** Correlated-exposure-cap candidate-risk estimate (not an order). */
  | 'equity_cap_estimate'
  /** Agent-proposal notional estimate (not an order). */
  | 'proposal_estimate';

export interface RiskThrottleSizingPathStats {
  /** How many times this path asked for the multiplier. */
  consults: number;
  /** How many of those returned a multiplier < 1, i.e. actually trimmed size. */
  trims: number;
  /** The smallest multiplier this path has applied since boot (null ⇒ never trimmed). */
  minMultiplier: number | null;
  /** The throttle value seen on the most recent consult. */
  lastThrottle: number | null;
}

const pathStats = new Map<RiskThrottleSizingPath, RiskThrottleSizingPathStats>();

/** Record one sizing consult for the since-boot rollup. */
export function recordRiskThrottleSizing(
  path: RiskThrottleSizingPath,
  detail: { armed: boolean; throttle: number; multiplier: number },
): void {
  const cur = pathStats.get(path) ?? { consults: 0, trims: 0, minMultiplier: null, lastThrottle: null };
  cur.consults += 1;
  cur.lastThrottle = Number.isFinite(detail.throttle) ? detail.throttle : null;
  if (detail.multiplier < 1) {
    cur.trims += 1;
    cur.minMultiplier = cur.minMultiplier === null
      ? detail.multiplier
      : Math.min(cur.minMultiplier, detail.multiplier);
  }
  pathStats.set(path, cur);
}

export interface RiskThrottleSizingSnapshot {
  /** The env flag name, so a health reader can see WHICH key arms this. */
  flag: string;
  /** Whether the consuming path is armed right now. */
  armed: boolean;
  /** Total consults across every path since boot. */
  totalConsults: number;
  /**
   * Total consults that actually trimmed a sized quantity since boot. THE
   * countable bit: `armed: true` with `totalTrims: 0` means the throttle has
   * never been below 1 while an entry was sized — not that the wiring works.
   */
  totalTrims: number;
  /** Per-chokepoint breakdown (only paths that were consulted appear). */
  byPath: Partial<Record<RiskThrottleSizingPath, RiskThrottleSizingPathStats>>;
}

/** Snapshot the since-boot counters for the health route. */
export function snapshotRiskThrottleSizing(env: NodeJS.ProcessEnv = process.env): RiskThrottleSizingSnapshot {
  const byPath: Partial<Record<RiskThrottleSizingPath, RiskThrottleSizingPathStats>> = {};
  let totalConsults = 0;
  let totalTrims = 0;
  for (const [path, stats] of pathStats) {
    byPath[path] = { ...stats };
    totalConsults += stats.consults;
    totalTrims += stats.trims;
  }
  return {
    flag: RISK_THROTTLE_SIZING_FLAG,
    armed: isRiskThrottleSizingEnabled(env),
    totalConsults,
    totalTrims,
    byPath,
  };
}

/** Test seam — reset the since-boot counters. */
export function resetRiskThrottleSizingForTests(): void {
  pathStats.clear();
}
