// TRA-995 (epic-C, self-regulation) — the RISK AUTOPILOT.
//
// The existing `DailyRiskGovernor` (signal-engine.ts) already halts new entries
// on two automatic daily breakers (consecutive-loss streak, daily-drawdown) plus
// a manual kill switch. This module is the standing AUTOPILOT that sits on top of
// those: a single pure decision function that, given a snapshot of firm state,
// decides whether to HALT or THROTTLE (de-risk) — and crucially can ONLY ever
// tighten risk, never loosen it.
//
//   Invariant 4 (the owner ask): the autopilot may autonomously TIGHTEN risk
//   (halt / throttle / de-risk) but may NEVER autonomously raise a limit. Any
//   loosening — re-enabling entries, lifting a throttle beyond the daily reset,
//   raising a size cap — requires board ratification (epic-A pipeline).
//
// The four trigger families the owner named:
//   1. daily-drawdown breach         — realized daily loss vs managed equity
//   2. volatility / regime shift     — a high-vol regime flip
//   3. consecutive-loss streak       — N losers in a row
//   4. stale-data / feed fault       — the market-data feed has gone stale
//
// Plus a fifth, fed by the epic-C self-AWARENESS layer (`strategy-introspection`):
//   5. edge-decay                    — a previously-profitable strategy degrading
//
// `evaluateRiskAutopilot` is a PURE function of its input snapshot, so every
// trigger is deterministic and unit-testable without a running engine. The
// `DailyRiskGovernor.applyAutopilotDecision` consumer enforces the tighten-only
// invariant a second time at the mutation boundary (defence in depth), and
// `guardLimitChange` is the single chokepoint any limit-raise must pass through.

import {
  MAX_CONSECUTIVE_LOSSES,
  DAILY_DRAWDOWN_HALT_PCT,
} from '@trading-app/shared';

/** Which family of risk condition fired an autopilot action. */
export type AutopilotTrigger =
  | 'daily_drawdown'
  | 'loss_streak'
  | 'regime_shift'
  | 'feed_stale'
  | 'edge_decay';

/** What the autopilot did. Both are tightenings; there is no "loosen" kind. */
export type AutopilotActionKind = 'halt' | 'throttle';

/**
 * One autopilot decision atom: a tightening, the trigger that caused it, and a
 * human-readable reason surfaced in health + EOD.
 */
export interface AutopilotAction {
  kind: AutopilotActionKind;
  trigger: AutopilotTrigger;
  /** Human-readable, surfaced verbatim in health + EOD. */
  reason: string;
  /**
   * For a `throttle`, the risk multiplier this action proposes, in (0, 1]. A
   * `halt` carries no multiplier (it stops all new entries outright). Never > 1
   * — that is the whole point.
   */
  throttleMultiplier?: number;
}

/** The snapshot the autopilot reasons over. All fields are observe-only reads. */
export interface RiskAutopilotInput {
  /** Cumulative realized P&L for the ET trading day (signed; losses negative). */
  dailyPnl: number;
  /** Managed equity the drawdown % is measured against. */
  managedEquity: number;
  /** Current consecutive-loss streak (0 on the last win). */
  consecutiveLosses: number;
  /**
   * Active market regime, if known. A `high_vol` regime trims size; `flat`/null
   * is treated as "no regime signal" and never tightens on its own.
   */
  regime?: 'trend_up' | 'trend_down' | 'range' | 'high_vol' | 'flat' | null;
  /**
   * True when the market-data feed is stale during market hours (no fresh
   * quotes / engine tick stalled). Out of hours this should be passed false —
   * a stale feed with the market closed is expected, not a fault.
   */
  feedStale?: boolean;
  /**
   * Names of strategies the self-awareness layer flagged as edge-decaying. Each
   * one throttles (and is separately queued for review via the epic-A pipeline).
   */
  decayingStrategies?: string[];
  /** Thresholds (defaults below); injectable for tests / per-book tuning. */
  thresholds?: Partial<AutopilotThresholds>;
}

export interface AutopilotThresholds {
  /** Halt the day on this consecutive-loss count. Default: shared breaker (3). */
  lossStreakHalt: number;
  /**
   * Begin throttling one loss BEFORE the hard halt, so we de-risk into a losing
   * streak rather than trading full size right up to the cliff. Default: halt-1.
   */
  lossStreakThrottleAt: number;
  /** Throttle multiplier applied at the loss-streak throttle step. */
  lossStreakThrottle: number;
  /** Halt the day at this daily-drawdown fraction. Default: shared breaker (8%). */
  drawdownHaltPct: number;
  /** Throttle once daily drawdown crosses this softer fraction. Default: half. */
  drawdownThrottlePct: number;
  /** Throttle multiplier applied at the drawdown throttle step. */
  drawdownThrottle: number;
  /** Throttle multiplier applied in a high-vol regime. */
  highVolThrottle: number;
  /** Throttle multiplier applied per edge-decaying strategy present. */
  edgeDecayThrottle: number;
}

export const DEFAULT_AUTOPILOT_THRESHOLDS: AutopilotThresholds = {
  lossStreakHalt: MAX_CONSECUTIVE_LOSSES,
  lossStreakThrottleAt: Math.max(1, MAX_CONSECUTIVE_LOSSES - 1),
  lossStreakThrottle: 0.5,
  drawdownHaltPct: DAILY_DRAWDOWN_HALT_PCT,
  drawdownThrottlePct: DAILY_DRAWDOWN_HALT_PCT / 2,
  drawdownThrottle: 0.5,
  highVolThrottle: 0.5,
  edgeDecayThrottle: 0.5,
};

/**
 * The autopilot's verdict for one evaluation. `riskThrottle` is the COMBINED
 * tighten-only multiplier in (0, 1] (the product of every throttle action,
 * floored), applied to per-trade risk sizing. `halt` stops all new entries.
 */
export interface RiskAutopilotDecision {
  /** True ⇒ stop all new entries (the hard breaker). */
  halt: boolean;
  /** First halting reason, surfaced as the governor halt reason. Null if !halt. */
  haltReason: string | null;
  /** Combined throttle multiplier in (0, 1]; 1 ⇒ no de-risking. */
  riskThrottle: number;
  /** Every tightening this evaluation produced, in trigger order. */
  actions: AutopilotAction[];
}

/**
 * Hard floor for the combined throttle: even a pile-up of triggers never sizes
 * a trade below 10% of normal risk (below that, halting is the honest signal).
 */
export const MIN_RISK_THROTTLE = 0.1;

/**
 * PURE — evaluate the autopilot over a state snapshot. Returns the tighten-only
 * decision: a halt flag, the combined throttle multiplier, and an itemised list
 * of every action with its trigger + reason. Never returns a throttle > 1.
 */
export function evaluateRiskAutopilot(input: RiskAutopilotInput): RiskAutopilotDecision {
  const t: AutopilotThresholds = { ...DEFAULT_AUTOPILOT_THRESHOLDS, ...input.thresholds };
  const actions: AutopilotAction[] = [];

  const drawdownPct =
    input.managedEquity > 0 && input.dailyPnl < 0
      ? Math.abs(input.dailyPnl) / input.managedEquity
      : 0;

  // --- HALT triggers (hard breakers) ---------------------------------------
  let halt = false;
  let haltReason: string | null = null;
  const recordHalt = (trigger: AutopilotTrigger, reason: string): void => {
    actions.push({ kind: 'halt', trigger, reason });
    if (!halt) {
      halt = true;
      haltReason = reason;
    }
  };

  if (input.consecutiveLosses >= t.lossStreakHalt) {
    recordHalt(
      'loss_streak',
      `${input.consecutiveLosses} consecutive losses — autopilot halted new entries for the day`,
    );
  }
  if (drawdownPct >= t.drawdownHaltPct) {
    recordHalt(
      'daily_drawdown',
      `Daily drawdown −${(drawdownPct * 100).toFixed(1)}% reached ${(t.drawdownHaltPct * 100).toFixed(0)}% limit — autopilot halted`,
    );
  }

  // --- THROTTLE triggers (de-risk short of a full halt) --------------------
  // Each appends a multiplier in (0,1]; the combined throttle is their product.
  const recordThrottle = (
    trigger: AutopilotTrigger,
    multiplier: number,
    reason: string,
  ): void => {
    actions.push({ kind: 'throttle', trigger, reason, throttleMultiplier: multiplier });
  };

  if (
    input.consecutiveLosses >= t.lossStreakThrottleAt &&
    input.consecutiveLosses < t.lossStreakHalt
  ) {
    recordThrottle(
      'loss_streak',
      t.lossStreakThrottle,
      `${input.consecutiveLosses} consecutive losses — autopilot throttled risk to ${(t.lossStreakThrottle * 100).toFixed(0)}%`,
    );
  }
  if (drawdownPct >= t.drawdownThrottlePct && drawdownPct < t.drawdownHaltPct) {
    recordThrottle(
      'daily_drawdown',
      t.drawdownThrottle,
      `Daily drawdown −${(drawdownPct * 100).toFixed(1)}% crossed soft ${(t.drawdownThrottlePct * 100).toFixed(0)}% limit — autopilot throttled risk to ${(t.drawdownThrottle * 100).toFixed(0)}%`,
    );
  }
  if (input.regime === 'high_vol') {
    recordThrottle(
      'regime_shift',
      t.highVolThrottle,
      `High-volatility regime — autopilot throttled risk to ${(t.highVolThrottle * 100).toFixed(0)}%`,
    );
  }
  if (input.feedStale) {
    // A stale feed during market hours: we can't trust prices, so stop opening.
    recordHalt(
      'feed_stale',
      'Market-data feed stale during market hours — autopilot halted new entries',
    );
  }
  for (const strat of input.decayingStrategies ?? []) {
    recordThrottle(
      'edge_decay',
      t.edgeDecayThrottle,
      `Strategy "${strat}" flagged edge-decaying — autopilot throttled risk to ${(t.edgeDecayThrottle * 100).toFixed(0)}% and queued for review`,
    );
  }

  // Combine throttles multiplicatively, floored. A halt subsumes any throttle.
  const combined = actions
    .filter((a) => a.kind === 'throttle')
    .reduce((acc, a) => acc * (a.throttleMultiplier ?? 1), 1);
  const riskThrottle = halt ? riskThrottleWhenHalted() : clampThrottle(combined);

  return { halt, haltReason, riskThrottle, actions };
}

/** When halted there are no new entries, so the surfaced throttle is the floor. */
function riskThrottleWhenHalted(): number {
  return MIN_RISK_THROTTLE;
}

/** Clamp a multiplier into the tighten-only band (MIN_RISK_THROTTLE, 1]. */
export function clampThrottle(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier >= 1) return 1;
  return Math.max(MIN_RISK_THROTTLE, multiplier);
}

/**
 * Invariant-4 chokepoint. Any code path that wants to CHANGE a numeric risk
 * limit autonomously must route through this. A request that would LOOSEN the
 * limit (raise a cap, lift a throttle, widen a drawdown allowance) is refused
 * and flagged as requiring board ratification; a tightening passes straight
 * through. `higherIsLooser` defaults true (caps, size budgets, throttles —
 * bigger = more risk); set false for limits where bigger = tighter.
 *
 * This makes the invariant a single auditable function rather than a convention
 * sprinkled across the engine, and lets a test assert "the autopilot can never
 * raise a limit on its own" against one symbol.
 */
export function guardLimitChange(
  current: number,
  proposed: number,
  higherIsLooser = true,
): { applied: number; requiresRatification: boolean; reason: string | null } {
  const isLoosening = higherIsLooser ? proposed > current : proposed < current;
  if (isLoosening) {
    return {
      applied: current,
      requiresRatification: true,
      reason: `Autopilot may only tighten autonomously; raising this limit (${current} → ${proposed}) requires board ratification`,
    };
  }
  return { applied: proposed, requiresRatification: false, reason: null };
}

/**
 * Defence-in-depth assertion used by the governor: a decision must never carry a
 * throttle above 1 (a loosening) nor a non-halt action tagged `halt`. Throws on
 * violation so a coding regression that smuggles a raise in fails loud in tests.
 */
export function assertTightenOnly(decision: RiskAutopilotDecision): void {
  if (decision.riskThrottle > 1) {
    throw new Error(
      `risk-autopilot invariant violated: riskThrottle ${decision.riskThrottle} > 1 (would loosen risk)`,
    );
  }
  for (const a of decision.actions) {
    if (a.kind === 'throttle' && (a.throttleMultiplier ?? 1) > 1) {
      throw new Error(
        `risk-autopilot invariant violated: throttle action ${a.trigger} multiplier ${a.throttleMultiplier} > 1`,
      );
    }
  }
}
