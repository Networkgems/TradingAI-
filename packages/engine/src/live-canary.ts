// TRA-2051 — Live-canary staging harness (PURE evaluator + state machine).
//
// The canary is a NEW intermediate promotion stage between shadow (paper) and
// full live: shadow -> canary -> full_live. It is the free engineering
// deliverable of the board-approved plan on TRA-2040 (spend envelope confirmed
// `0516d471`). NO new alpha — this is guard wiring around rails we already own
// (engine `RiskManager` TRA-2034/178, the six-guard promotion gate TRA-2031, the
// shadow ledger, live rails).
//
// This module is PURE and side-effect free, exactly like `pre-trade-gate.ts`: it
// knows nothing about flags, ledgers, capital, or I/O. It takes live-book
// telemetry + the hard limits and returns which guards are breached and how much
// headroom remains; it takes a `CanaryState` + an evaluation and returns the next
// state (with the `canaryDemoted` latch). The `ENABLE_LIVE_CANARY` kill switch,
// the JSONL ledger, the sizing call, and the health endpoint all live server-side
// in `packages/server/src/live-canary-ledger.ts`, which consumes this. Keeping the
// rules here means the unit tests pin the exact breach/demote/promote boundary
// independent of any wiring.
//
// FAIL-CLOSED is the governing principle. Any ambiguity — a missing telemetry
// field, a non-finite reading, a guard-eval error — is treated as a BREACH that
// demotes, never as a silent pass. With `ENABLE_LIVE_CANARY` off (the default,
// and the state while TRA-382 holds live trading), none of this runs and there is
// zero behaviour change. Arming a real candidate is a SEPARATE future action,
// hard-blocked on TRA-382 + a real candidate + board go-ahead; it is NOT here.

/** The three promotion stages. One candidate occupies the canary at a time. */
export type CanaryStage = 'shadow' | 'canary' | 'full_live';

/**
 * The five hard-limit breach reasons, plus the two fail-closed reasons. A clean
 * evaluation returns an empty `breaches[]`; a dirty one lists EVERY limit it
 * broke so a demotion is fully attributable.
 */
export type CanaryBreachReason =
  /** Cumulative realized loss since canary start >= `cumulativeLossCapPct` of allocation. */
  | 'CUMULATIVE_LOSS_CAP'
  /** Realized loss today >= `dailyLossCapPct` of allocation. */
  | 'DAILY_LOSS_CAP'
  /** Trades today > `maxTradesPerDay` OR concurrent positions > `maxConcurrentPositions`. */
  | 'TRADE_RATE_CAP'
  /** Realized slippage diverged from modeled beyond tolerance — the core fidelity test. */
  | 'SLIPPAGE_DIVERGENCE'
  /** A single trade's notional exceeded `perTradeNotionalCapPct` of allocation (TRA-178, live book). */
  | 'NOTIONAL_CAP'
  /** Fail-closed: a required telemetry field was missing or non-finite. */
  | 'TELEMETRY_MISSING'
  /** Fail-closed: the guard evaluation itself threw. */
  | 'GUARD_EVAL_ERROR';

/**
 * The five hard limits. All tunable; defaults come straight from the TRA-2040
 * board-approved envelope (cumulative 15%, daily 5%, trade-rate N=5/K=3,
 * slippage 2x-or-10bps-over-model, per-trade notional 1x allocation).
 */
export interface CanaryLimits {
  /** Cumulative-loss cap as a fraction of allocation. Default 0.15 (15%). */
  cumulativeLossCapPct: number;
  /** Daily-loss breaker as a fraction of allocation. Default 0.05 (5%). */
  dailyLossCapPct: number;
  /** Max trades opened per day. Default 5. */
  maxTradesPerDay: number;
  /** Max simultaneously-open canary positions. Default 3. */
  maxConcurrentPositions: number;
  /**
   * Realized slippage breaches when it reaches `multiplier x modeled`. Default 2.
   * The OR-tolerance below covers the small-modeled case (2x of ~0 is still ~0).
   */
  slippageDivergenceMultiplier: number;
  /**
   * ...OR when realized exceeds modeled by more than this many bps, whichever
   * trips first. Guards the near-zero-modeled regime. Default 10 bps.
   */
  maxSlippageBpsOverModel: number;
  /** Per-trade notional cap as a fraction of allocation (TRA-178). Default 1.0. */
  perTradeNotionalCapPct: number;
}

export const DEFAULT_CANARY_LIMITS: CanaryLimits = {
  cumulativeLossCapPct: 0.15,
  dailyLossCapPct: 0.05,
  maxTradesPerDay: 5,
  maxConcurrentPositions: 3,
  slippageDivergenceMultiplier: 2,
  maxSlippageBpsOverModel: 10,
  perTradeNotionalCapPct: 1.0,
};

/**
 * Live-book telemetry read once per guard evaluation. Every field is required and
 * must be finite — a missing/NaN reading is fail-closed to `TELEMETRY_MISSING`
 * (we cannot prove a limit is respected without its input, so we demote).
 */
export interface CanaryTelemetry {
  /** Canary equity allocation in account currency (the denominator for the caps). */
  allocation: number;
  /** Signed realized P&L since the candidate entered the canary (loss is negative). */
  cumulativePnl: number;
  /** Signed realized P&L today (loss is negative). */
  dailyPnl: number;
  /** Positions OPENED so far today. */
  tradesToday: number;
  /** Positions currently open on the canary book. */
  concurrentPositions: number;
  /** Rolling-window realized slippage in bps (>= 0). */
  realizedSlippageBps: number;
  /** Rolling-window modeled slippage in bps (>= 0) — what the cost model predicted. */
  modeledSlippageBps: number;
  /** Largest single-trade notional observed on the canary book. */
  maxTradeNotional: number;
}

/** Per-limit headroom row — how close a limit is to breaching, in its own units. */
export interface CanaryLimitHeadroom {
  limit: CanaryBreachReason;
  /** Current observed value in the limit's units. */
  value: number;
  /** The threshold that trips the breach. */
  threshold: number;
  /** `threshold - value`; negative once breached. */
  headroom: number;
  breached: boolean;
}

/** The verdict of one guard sweep. */
export interface CanaryGuardEvaluation {
  /** True iff no limit breached and telemetry was complete. */
  ok: boolean;
  /** Every breached limit (empty on a clean pass). */
  breaches: CanaryBreachReason[];
  /** Per-limit headroom for the health readout (empty when fail-closed). */
  headroom: CanaryLimitHeadroom[];
  /** True when the breach was forced by missing telemetry / an eval error. */
  failClosed: boolean;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

const REQUIRED_TELEMETRY_FIELDS: (keyof CanaryTelemetry)[] = [
  'allocation',
  'cumulativePnl',
  'dailyPnl',
  'tradesToday',
  'concurrentPositions',
  'realizedSlippageBps',
  'modeledSlippageBps',
  'maxTradeNotional',
];

/**
 * Evaluate the five hard-limit guards against a live-book telemetry snapshot.
 * PURE and TOTAL: it never throws — an internal error degrades to a fail-closed
 * `GUARD_EVAL_ERROR` breach rather than propagating, so a guard bug can only
 * demote, never let the canary run unchecked.
 *
 * FAIL-CLOSED semantics:
 *   - any missing / non-finite telemetry field -> `TELEMETRY_MISSING` breach;
 *   - a non-positive allocation -> `TELEMETRY_MISSING` (the caps have no
 *     denominator, so respect cannot be proven);
 *   - a thrown error anywhere -> `GUARD_EVAL_ERROR` breach.
 * In every fail-closed case `ok` is false and `failClosed` is true.
 */
export function evaluateCanaryGuards(
  telemetry: CanaryTelemetry,
  limits: CanaryLimits = DEFAULT_CANARY_LIMITS,
): CanaryGuardEvaluation {
  try {
    // Fail-closed on incomplete telemetry: we cannot assert a limit holds
    // without its input, so a gap demotes rather than passes.
    for (const field of REQUIRED_TELEMETRY_FIELDS) {
      if (!isFiniteNumber(telemetry[field])) {
        return { ok: false, breaches: ['TELEMETRY_MISSING'], headroom: [], failClosed: true };
      }
    }
    if (telemetry.allocation <= 0) {
      return { ok: false, breaches: ['TELEMETRY_MISSING'], headroom: [], failClosed: true };
    }

    const alloc = telemetry.allocation;
    const headroom: CanaryLimitHeadroom[] = [];
    const breaches: CanaryBreachReason[] = [];

    // 1. Cumulative loss cap. Loss is the positive magnitude of negative PnL.
    const cumLoss = Math.max(0, -telemetry.cumulativePnl);
    const cumThreshold = limits.cumulativeLossCapPct * alloc;
    const cumBreached = cumLoss >= cumThreshold;
    headroom.push({
      limit: 'CUMULATIVE_LOSS_CAP',
      value: cumLoss,
      threshold: cumThreshold,
      headroom: cumThreshold - cumLoss,
      breached: cumBreached,
    });
    if (cumBreached) breaches.push('CUMULATIVE_LOSS_CAP');

    // 2. Daily loss breaker.
    const dayLoss = Math.max(0, -telemetry.dailyPnl);
    const dayThreshold = limits.dailyLossCapPct * alloc;
    const dayBreached = dayLoss >= dayThreshold;
    headroom.push({
      limit: 'DAILY_LOSS_CAP',
      value: dayLoss,
      threshold: dayThreshold,
      headroom: dayThreshold - dayLoss,
      breached: dayBreached,
    });
    if (dayBreached) breaches.push('DAILY_LOSS_CAP');

    // 3. Trade-rate cap — trips on EITHER the daily count or concurrency limit.
    // Headroom reports the binding (smaller) of the two margins.
    const tradesHeadroom = limits.maxTradesPerDay - telemetry.tradesToday;
    const concurrentHeadroom = limits.maxConcurrentPositions - telemetry.concurrentPositions;
    const rateBreached =
      telemetry.tradesToday > limits.maxTradesPerDay ||
      telemetry.concurrentPositions > limits.maxConcurrentPositions;
    headroom.push({
      limit: 'TRADE_RATE_CAP',
      value: tradesHeadroom <= concurrentHeadroom ? telemetry.tradesToday : telemetry.concurrentPositions,
      threshold: tradesHeadroom <= concurrentHeadroom ? limits.maxTradesPerDay : limits.maxConcurrentPositions,
      headroom: Math.min(tradesHeadroom, concurrentHeadroom),
      breached: rateBreached,
    });
    if (rateBreached) breaches.push('TRADE_RATE_CAP');

    // 4. Slippage-fidelity divergence — THE core fidelity test. Realized slippage
    // breaches when it reaches `multiplier x modeled` OR exceeds modeled by more
    // than `maxSlippageBpsOverModel` bps, whichever trips first (the OR covers the
    // near-zero-modeled regime where a multiple is uninformative).
    const multipleThreshold = limits.slippageDivergenceMultiplier * telemetry.modeledSlippageBps;
    const absoluteThreshold = telemetry.modeledSlippageBps + limits.maxSlippageBpsOverModel;
    const slipThreshold = Math.min(multipleThreshold, absoluteThreshold);
    const slipBreached = telemetry.realizedSlippageBps >= slipThreshold;
    headroom.push({
      limit: 'SLIPPAGE_DIVERGENCE',
      value: telemetry.realizedSlippageBps,
      threshold: slipThreshold,
      headroom: slipThreshold - telemetry.realizedSlippageBps,
      breached: slipBreached,
    });
    if (slipBreached) breaches.push('SLIPPAGE_DIVERGENCE');

    // 5. Per-trade notional cap (TRA-178, now on the live book).
    const notionalThreshold = limits.perTradeNotionalCapPct * alloc;
    const notionalBreached = telemetry.maxTradeNotional > notionalThreshold;
    headroom.push({
      limit: 'NOTIONAL_CAP',
      value: telemetry.maxTradeNotional,
      threshold: notionalThreshold,
      headroom: notionalThreshold - telemetry.maxTradeNotional,
      breached: notionalBreached,
    });
    if (notionalBreached) breaches.push('NOTIONAL_CAP');

    return { ok: breaches.length === 0, breaches, headroom, failClosed: false };
  } catch {
    // A guard bug can only ever demote — never silently let the canary run.
    return { ok: false, breaches: ['GUARD_EVAL_ERROR'], headroom: [], failClosed: true };
  }
}

/** The canary's persisted state. The `canaryDemoted` latch is the safety core. */
export interface CanaryState {
  stage: CanaryStage;
  /** The single candidate armed in the canary, or null when idle. */
  candidateId: string | null;
  /**
   * One-way latch: once a breach demotes the canary it is set true and CANNOT be
   * cleared by this pure module. Re-arming after a demotion is an explicit,
   * out-of-band operator action (a fresh candidate + board sign-off), never a
   * silent auto-recovery. This is what stops a flapping guard from re-arming.
   */
  canaryDemoted: boolean;
  /** Why the last demotion fired (empty until one does). */
  demotionReasons: CanaryBreachReason[];
  /** ms-epoch of the last demotion, or null. */
  demotedAt: number | null;
}

/** The safe initial state: shadow-only, nothing armed, latch clear. */
export function initialCanaryState(): CanaryState {
  return {
    stage: 'shadow',
    candidateId: null,
    canaryDemoted: false,
    demotionReasons: [],
    demotedAt: null,
  };
}

/** What `applyGuardEvaluation` decided to do. */
export type CanaryAction =
  /** Canary armed and clean — entries continue. */
  | 'continue'
  /** A breach fired — halt entries, flatten, revert to shadow, latch. */
  | 'demote'
  /** Not in the canary stage (shadow / full_live) — guards are inert. */
  | 'noop';

export interface CanaryTransition {
  state: CanaryState;
  action: CanaryAction;
}

/**
 * Apply a guard evaluation to the canary state. The ONLY transition this module
 * makes autonomously is the safety one: canary + any breach -> demote to shadow,
 * latch `canaryDemoted`, record reasons. It NEVER promotes on its own (that is
 * `evaluateCanaryPromotion` + an operator) and NEVER clears the latch.
 *
 * Called every guard sweep. When the stage is not `canary` the guards are inert
 * (`noop`) — there is no live canary book to protect.
 */
export function applyGuardEvaluation(
  state: CanaryState,
  evaluation: CanaryGuardEvaluation,
  at: number,
): CanaryTransition {
  if (state.stage !== 'canary') {
    return { state, action: 'noop' };
  }
  if (evaluation.ok) {
    return { state, action: 'continue' };
  }
  // Breach (real or fail-closed) -> demote and latch. Idempotent: reasons reflect
  // this breach; the latch was already set on the first demotion.
  return {
    state: {
      ...state,
      stage: 'shadow',
      candidateId: null,
      canaryDemoted: true,
      demotionReasons: evaluation.breaches,
      demotedAt: at,
    },
    action: 'demote',
  };
}

/**
 * Promotion criteria: canary -> full_live. Board-approved gates (all tunable):
 * >= N trades AND >= M days with ZERO breaches, realized E[R]/win/slippage within
 * tolerance of modeled, all six promotion guards green, PLUS the 7th human
 * co-sign from the validator scoped in TRA-2042. Neither profitability nor
 * fidelity alone promotes — every gate must hold.
 */
export interface CanaryPromotionCriteria {
  /** Minimum canary trades. Default 30. */
  minTrades: number;
  /** Minimum canary days with zero breaches. Default 20. */
  minDays: number;
  /** Max |realized E[R] - modeled E[R]| tolerance (R units). Default 0.10. */
  expectancyToleranceR: number;
  /** Max |realized win% - modeled win%| tolerance (fraction). Default 0.10. */
  winRateTolerance: number;
  /** Max realized-over-modeled slippage tolerance (bps). Default 10. */
  slippageToleranceBps: number;
}

export const DEFAULT_CANARY_PROMOTION_CRITERIA: CanaryPromotionCriteria = {
  minTrades: 30,
  minDays: 20,
  expectancyToleranceR: 0.10,
  winRateTolerance: 0.10,
  slippageToleranceBps: 10,
};

/** The observed record a promotion decision is judged against. */
export interface CanaryPromotionInput {
  tradeCount: number;
  daysActive: number;
  breachCount: number;
  realizedExpectancyR: number;
  modeledExpectancyR: number;
  realizedWinRate: number;
  modeledWinRate: number;
  realizedSlippageBps: number;
  modeledSlippageBps: number;
  /** All six promotion-gate guards (TRA-2031) currently green. */
  sixGuardGatePass: boolean;
  /** The 7th human co-sign from the TRA-2042 validator is on file. */
  validatorSignoffPresent: boolean;
}

/** Reasons a promotion is blocked; empty means eligible. */
export type CanaryPromotionBlocker =
  | 'INSUFFICIENT_TRADES'
  | 'INSUFFICIENT_DAYS'
  | 'BREACHES_PRESENT'
  | 'EXPECTANCY_OUT_OF_TOLERANCE'
  | 'WIN_RATE_OUT_OF_TOLERANCE'
  | 'SLIPPAGE_OUT_OF_TOLERANCE'
  | 'SIX_GUARD_GATE_NOT_GREEN'
  | 'VALIDATOR_SIGNOFF_MISSING';

export interface CanaryPromotionVerdict {
  eligible: boolean;
  blockers: CanaryPromotionBlocker[];
}

/**
 * Evaluate canary -> full_live eligibility. INERT in TRA-2051: nothing calls this
 * to actually flip a candidate live (arming is a separate future action blocked on
 * TRA-382 + a real candidate + board go-ahead). It is encoded and tested now so
 * the criteria are pinned. FAIL-CLOSED: any non-finite metric is treated as
 * out-of-tolerance (a blocker), never a pass.
 */
export function evaluateCanaryPromotion(
  input: CanaryPromotionInput,
  criteria: CanaryPromotionCriteria = DEFAULT_CANARY_PROMOTION_CRITERIA,
): CanaryPromotionVerdict {
  const blockers: CanaryPromotionBlocker[] = [];

  if (!isFiniteNumber(input.tradeCount) || input.tradeCount < criteria.minTrades) {
    blockers.push('INSUFFICIENT_TRADES');
  }
  if (!isFiniteNumber(input.daysActive) || input.daysActive < criteria.minDays) {
    blockers.push('INSUFFICIENT_DAYS');
  }
  if (!isFiniteNumber(input.breachCount) || input.breachCount > 0) {
    blockers.push('BREACHES_PRESENT');
  }

  const withinTol = (a: number, b: number, tol: number): boolean =>
    isFiniteNumber(a) && isFiniteNumber(b) && Math.abs(a - b) <= tol;

  if (!withinTol(input.realizedExpectancyR, input.modeledExpectancyR, criteria.expectancyToleranceR)) {
    blockers.push('EXPECTANCY_OUT_OF_TOLERANCE');
  }
  if (!withinTol(input.realizedWinRate, input.modeledWinRate, criteria.winRateTolerance)) {
    blockers.push('WIN_RATE_OUT_OF_TOLERANCE');
  }
  // Slippage is one-sided: realized BELOW modeled is fine; only realized ABOVE
  // modeled beyond tolerance is a fidelity failure.
  const slipOk =
    isFiniteNumber(input.realizedSlippageBps) &&
    isFiniteNumber(input.modeledSlippageBps) &&
    input.realizedSlippageBps - input.modeledSlippageBps <= criteria.slippageToleranceBps;
  if (!slipOk) blockers.push('SLIPPAGE_OUT_OF_TOLERANCE');

  if (input.sixGuardGatePass !== true) blockers.push('SIX_GUARD_GATE_NOT_GREEN');
  if (input.validatorSignoffPresent !== true) blockers.push('VALIDATOR_SIGNOFF_MISSING');

  return { eligible: blockers.length === 0, blockers };
}
