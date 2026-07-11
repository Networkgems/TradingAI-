// TRA-1602 (deliverable C of TRA-1600, parent TRA-1599 cost-gap plan) — the
// PER-CANDIDATE MODELED GROSS R estimator for the executing options opens.
//
// The cost-aware admission primitive ({@link admitByCostAwareGate}, TRA-1600)
// already exists and is unit-tested, but it consumes a `modeledGrossR` that does
// NOT exist anywhere on the executing open path: admission on runRelativeValueScan
// / runOtmScan / evaluateDemoDirectional is purely STRUCTURAL (delta / IVR<=25 /
// trend / DTE / greeks-gate / churn). This module builds that missing number from
// the locally-available per-candidate ingredients (mark, delta, and the take-
// profit / stop premium the open site already derives) so the gate can reject the
// mass of ~0-edge scratch-tier ideas.
//
//   modeledGrossR = winProb·rewardR − (1 − winProb)·lossR          (lossR ≡ 1)
//
//     lossR    ≡ 1        — R is DEFINED as the trade's at-risk stop-loss, so a
//                           full stop is exactly −1R. Keeping the unit tied to the
//                           stop (not the whole premium) is what makes rewardR a
//                           clean reward:risk multiple.
//     rewardR  = (target − mark)/(mark − stop)  when the open site set a real
//                take-profit + stop (RV / OTM: 1.5×/0.75× mark → 2.0R); falls back
//                to the signal's `riskRewardRatio` (or {@link DEFAULT_MODELED_GROSS_R_CONFIG}
//                `defaultRewardR`) on the deterministic directional path, which
//                carries no fixed target/stop (managed at close/SL/trail).
//     winProb  = clamp(|delta|·winProbDeltaMultiplier, 0, winProbCap) — the long
//                option's Black-Scholes |delta| is the only locally-available
//                win-probability proxy; the multiplier is the tuning knob that
//                lets QuantTrader haircut the ITM-at-expiry reading toward the
//                probability of actually reaching the +move target on a swing exit.
//
// GROSS, NOT NET: this returns the pre-cost expectancy on purpose. The cost term
// lives in the gate's bar (admissionBarR = costModel + margin), so the admission
// test `modeledGrossR >= costModel + margin` already nets the cost exactly once.
// Netting the structure cost in HERE too would double-count it — hence the name.
//
// ────────────────────────────────────────────────────────────────────────────
// ⚠ PROPOSED CONSTRUCTION — pending QuantTrader spec sign-off (TRA-1602/TRA-1599).
// QuantTrader owns the expectancy model (delta→win-prob mapping, reward multiple,
// gross-vs-net). The formula below is a concrete, tunable STRAWMAN so that sign-
// off can react to spec-in-code; it is intentionally UNWIRED (no open site calls
// it yet) and the master flag is OFF, so there is ZERO behaviour change until both
// (a) QuantTrader signs off and (b) an operator arms `ENABLE_OPTION_COST_AWARE_GATE`.
// Every knob is env-overridable so a retune needs no code change.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Operator-tunable knobs for the modeled-gross-R estimator (all optional; each
 * falls back to {@link DEFAULT_MODELED_GROSS_R_CONFIG} so an unset/malformed env
 * preserves the proposed reference behaviour).
 *
 *  - WIN_PROB_DELTA_MULT: multiply |delta| by this before clamping to get the
 *    win probability. Default 1.0 (use |delta| directly as the win-prob proxy).
 *    QuantTrader lowers it to haircut the ITM-at-expiry delta toward the
 *    probability of hitting the +move target on an early swing exit.
 *  - DEFAULT_REWARD_R: reward:risk multiple assumed when the open site carries no
 *    explicit target/stop (the deterministic directional path). Default 2.0, to
 *    match the `riskRewardRatio: 2` those signals already advertise.
 *  - WIN_PROB_CAP: upper clamp on the win probability (default 0.95) so a deep-ITM
 *    ~1.0 delta can't imply a near-certain win.
 */
export const OPTION_MGR_WIN_PROB_DELTA_MULT_VAR = 'OPTION_COST_GATE_WIN_PROB_DELTA_MULT';
export const OPTION_MGR_DEFAULT_REWARD_R_VAR = 'OPTION_COST_GATE_DEFAULT_REWARD_R';
export const OPTION_MGR_WIN_PROB_CAP_VAR = 'OPTION_COST_GATE_WIN_PROB_CAP';

/** A parsed finite float in [min, max], or undefined when unset/invalid. */
function parseBoundedFloat(raw: string | undefined, min: number, max: number): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/** The per-candidate ingredients the open sites have locally in scope. */
export interface ModeledGrossRInputs {
  /** Option premium mid (per share), i.e. the candidate's `mark`. */
  mark: number;
  /** Signed Black-Scholes delta of the contract; only the magnitude is used. */
  delta: number;
  /** Take-profit premium (per share). Optional — absent on the directional path. */
  targetPrice?: number;
  /** Stop-loss premium (per share). Optional — absent on the directional path. */
  stopPrice?: number;
  /**
   * Reward:risk fallback used when {@link targetPrice}/{@link stopPrice} are not
   * both present/valid (the signal's `riskRewardRatio`). Falls back further to the
   * config `defaultRewardR` when this too is missing.
   */
  riskRewardRatio?: number;
}

/** Resolved, fully-defaulted estimator configuration. Pure — no env access. */
export interface ModeledGrossRConfig {
  winProbDeltaMultiplier: number;
  defaultRewardR: number;
  winProbCap: number;
}

/**
 * The proposed reference config. With the defaults the estimate reduces to
 * `modeledGrossR = |delta|·rewardR − (1 − |delta|)`, i.e. on the RV/OTM 2:1
 * structures `3·|delta| − 1` — which clears the shipped 0.80R options bar at
 * |delta| ≥ 0.60. That is exactly the intended "fire fewer, higher-edge" effect:
 * far-OTM lottery deltas (~0.40 floor) and near-ATM 0.50 directional reads model
 * below the bar and are rejected as scratch-tier.
 */
export const DEFAULT_MODELED_GROSS_R_CONFIG: ModeledGrossRConfig = {
  winProbDeltaMultiplier: 1.0,
  defaultRewardR: 2.0,
  winProbCap: 0.95,
};

/** The estimate for one candidate. */
export interface ModeledGrossREstimate {
  /** winProb·rewardR − (1 − winProb)·lossR; NaN when inputs are unusable. */
  modeledGrossR: number;
  /** clamp(|delta|·mult, 0, cap). */
  winProb: number;
  /** Reward:risk multiple used (from target/stop, else fallback). */
  rewardR: number;
  /** Always 1 — R is defined as the stop-loss. Surfaced for readouts. */
  lossR: number;
  /** How rewardR was sourced: 'target_stop' | 'risk_reward_ratio' | 'default'. */
  rewardSource: 'target_stop' | 'risk_reward_ratio' | 'default';
  /** Human-readable note (empty when a clean estimate was produced). */
  reason: string;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Estimate the per-candidate modeled GROSS R. Pure — no env, no I/O. Returns a
 * NaN `modeledGrossR` (which {@link admitByCostAwareGate} treats as a reject) when
 * the mark or delta is non-finite/non-positive: we never admit on an unknown edge.
 */
export function estimateModeledGrossR(
  inputs: ModeledGrossRInputs,
  config: ModeledGrossRConfig = DEFAULT_MODELED_GROSS_R_CONFIG,
): ModeledGrossREstimate {
  const { mark, delta, targetPrice, stopPrice, riskRewardRatio } = inputs;
  const lossR = 1;

  if (!Number.isFinite(mark) || mark <= 0 || !Number.isFinite(delta)) {
    return {
      modeledGrossR: Number.NaN,
      winProb: Number.NaN,
      rewardR: Number.NaN,
      lossR,
      rewardSource: 'default',
      reason: 'unusable inputs (mark/delta non-finite) — modeled edge unknown',
    };
  }

  const winProb = clamp(Math.abs(delta) * config.winProbDeltaMultiplier, 0, config.winProbCap);

  // rewardR: prefer the real take-profit / stop the open site derived; fall back
  // to the signal's declared risk:reward, then the config default.
  let rewardR: number;
  let rewardSource: ModeledGrossREstimate['rewardSource'];
  const haveTargetStop =
    typeof targetPrice === 'number' && typeof stopPrice === 'number'
    && Number.isFinite(targetPrice) && Number.isFinite(stopPrice)
    && targetPrice > mark && mark > stopPrice && stopPrice >= 0;
  if (haveTargetStop) {
    rewardR = (targetPrice - mark) / (mark - stopPrice);
    rewardSource = 'target_stop';
  } else if (typeof riskRewardRatio === 'number' && Number.isFinite(riskRewardRatio) && riskRewardRatio > 0) {
    rewardR = riskRewardRatio;
    rewardSource = 'risk_reward_ratio';
  } else {
    rewardR = config.defaultRewardR;
    rewardSource = 'default';
  }

  const modeledGrossR = winProb * rewardR - (1 - winProb) * lossR;
  return { modeledGrossR, winProb, rewardR, lossR, rewardSource, reason: '' };
}

/**
 * Resolve the operator-tunable estimator config from env, falling back to
 * {@link DEFAULT_MODELED_GROSS_R_CONFIG} field-by-field so any unset/malformed
 * knob preserves the proposed reference behaviour. Bounds are defensive: a
 * multiplier is clamped to [0, 5], the reward default to [0.1, 20], the win-prob
 * cap to [0, 1].
 */
export function resolveModeledGrossRConfig(
  env: NodeJS.ProcessEnv = process.env,
): ModeledGrossRConfig {
  const mult = parseBoundedFloat(env[OPTION_MGR_WIN_PROB_DELTA_MULT_VAR], 0, 5);
  const rewardR = parseBoundedFloat(env[OPTION_MGR_DEFAULT_REWARD_R_VAR], 0.1, 20);
  const cap = parseBoundedFloat(env[OPTION_MGR_WIN_PROB_CAP_VAR], 0, 1);
  return {
    winProbDeltaMultiplier: mult ?? DEFAULT_MODELED_GROSS_R_CONFIG.winProbDeltaMultiplier,
    defaultRewardR: rewardR ?? DEFAULT_MODELED_GROSS_R_CONFIG.defaultRewardR,
    winProbCap: cap ?? DEFAULT_MODELED_GROSS_R_CONFIG.winProbCap,
  };
}
