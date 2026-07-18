// TRA-2005 (child of TRA-2000, proposal items 1 & 3) — SHADOW-first
// POSITIVE-EXPECTANCY + IVR/credit-width admission gate for the AI Options Ideas
// feed. **SHADOW-first, flag-off. No live wiring (that is TRA-1985).**
//
// THE LEAK (TRA-2000 diagnosis). The ideas feed ranks POP-desc then smaller
// max-loss (`options-research.ts` `enforceGuardrail`) and filters only on
// cost-efficiency. It never checks that a credit spread's credit/width clears its
// own breakeven win-rate, so it surfaces penny-wide credit spreads that are
// NEGATIVE-EXPECTANCY at their own stated POP — e.g. a QQQ bull_put width 4 /
// credit 0.76 → breakeven credit/width 0.81 vs stated POP 0.766 → −0.05R. That is
// the gross-edge leak (gross R flat at +0.01).
//
// THE EXPECTANCY IDENTITY. For a credit vertical, R is DEFINED as the at-risk max
// loss (= width − credit). Win keeps the credit, loss forfeits (width − credit):
//
//   E[R] = POP·(credit / (width − credit)) − (1 − POP)·1
//
// This is exactly the `modeledGrossR = winProb·rewardR − (1 − winProb)·lossR`
// identity of the executing-open estimator (`estimateModeledGrossR`,
// packages/server/src/option-modeled-gross-r.ts) specialised to a credit vertical:
// winProb = POP_cal, rewardR = credit/(width − credit), lossR = 1. We MIRROR the
// identity here rather than import it because the agents package is deliberately
// decoupled from server (server → agents, never the reverse) — the same
// "mirror-not-import" convention as `EVENT_IV_MIN_RANK` in options-research.ts.
// Keep the two in sync.
//
// THE ONE MISSING DATUM. An idea already carries `pop` and `maxLossUsd`, and for a
// credit vertical `maxLossUsd = (width − credit)·100`. The only thing missing to
// evaluate E[R] is the net credit, added as the optional `creditUsd` field on the
// idea. Then the ×100 multipliers cancel:
//
//   rewardR      = credit/(width − credit) = creditUsd / maxLossUsd
//   creditWidth  = credit/width            = creditUsd / (maxLossUsd + creditUsd)
//
// so no separate `width` is needed — `creditUsd` + `maxLossUsd` fully price it.
//
// POP_cal (TRA-2006). The gate scores the CALIBRATED POP. Until the calibration
// layer is armed for the ideas feed, POP_cal is the interim flat haircut
// `clamp01(pop − 0.15)` — matching TRA-2006's <n43 interim flat map. When the
// server passes a real calibrated POP in, that value is used verbatim instead.
//
// THRESHOLDS ARE DATA-DRIVEN (TRA-2004). The +0.10R buffer and the IVR/DTE cutoffs
// are placeholders until confirmed against the resolved cohort from the
// decomposition probe (TRA-2004) on bqb1. Every knob is env-overridable so a
// retune needs no code change. Nothing here drops a live idea: the master flag is
// OFF, and even ON this only RECORDS the shadow verdict — actually thinning the
// surfaced slate is a later, separately-flagged arming gated on the QuantTrader
// shadow grade + board endorsement of the TRA-2000 proposal.

/**
 * The net-credit defined-risk structures this expectancy gate scores. Debit /
 * long-premium families are out of scope (a different expectancy shape — reward =
 * width − debit — and not the penny-wide-credit leak this gate targets).
 */
export const CREDIT_STRUCTURES: ReadonlySet<string> = new Set<string>([
  'bull_put_spread',
  'bear_call_spread',
  'iron_condor',
  'iron_butterfly',
]);

/**
 * Structures PARKED until they accrue sample. The bqb1 book has iron_condor at
 * n=7, 0 wins — too thin to admit on, so it is shadow-dropped regardless of its
 * modelled expectancy until the cohort grows. iron_butterfly rides along (same
 * thin four-leg-condor family). Data-driven; revisit against TRA-2004.
 */
export const PARKED_STRUCTURES: ReadonlySet<string> = new Set<string>(['iron_condor']);

/** Resolved, fully-defaulted gate configuration. Pure — no env access. */
export interface ExpectancyGateConfig {
  /** Admission bar on modelled E[R] (in R). Default +0.10R (TRA-2004-tunable). */
  minExpectancyR: number;
  /** Hard IV-rank floor for credit structures. Default 50 (aligns strategy-selector). */
  minIvRank: number;
  /**
   * Interim flat POP haircut applied when no calibrated POP is supplied
   * (`popCalibrated`). Default 0.15 — TRA-2006's <n43 interim flat map.
   */
  popHaircut: number;
  /**
   * Extra margin required on the credit/width floor above breakeven `(1 − POP_cal)`.
   * Default 0 (the E[R] ≥ minExpectancyR bar already supplies the margin); a
   * positive buffer is a second, independent tightening tuned from TRA-2004.
   */
  creditWidthBuffer: number;
  /** Structures shadow-dropped as too-thin regardless of expectancy. */
  parkStructures: ReadonlySet<string>;
}

/** The proposed reference config. Interim until TRA-2004 confirms the cutoffs. */
export const DEFAULT_EXPECTANCY_GATE_CONFIG: ExpectancyGateConfig = {
  minExpectancyR: 0.1,
  minIvRank: 50,
  popHaircut: 0.15,
  creditWidthBuffer: 0,
  parkStructures: PARKED_STRUCTURES,
};

/** Env var names (all optional; unset/malformed → reference default). */
export const EXPECTANCY_GATE_ENABLE_VAR = 'ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE';
export const EXPECTANCY_GATE_MIN_R_VAR = 'OPTIONS_IDEA_EXPECTANCY_MIN_R';
export const EXPECTANCY_GATE_MIN_IVR_VAR = 'OPTIONS_IDEA_EXPECTANCY_MIN_IVR';
export const EXPECTANCY_GATE_POP_HAIRCUT_VAR = 'OPTIONS_IDEA_EXPECTANCY_POP_HAIRCUT';
export const EXPECTANCY_GATE_CW_BUFFER_VAR = 'OPTIONS_IDEA_EXPECTANCY_CW_BUFFER';

/** Per-idea inputs the gate scores. `sym` fields are looked up by the caller. */
export interface IdeaExpectancyInput {
  strategy: string;
  /** Raw stated probability-of-profit at expiry, 0..1. */
  pop: number;
  /** Defined max loss per 1-lot in USD = (width − credit)·100 for credit verticals. */
  maxLossUsd: number;
  /**
   * Net credit received per 1-lot in USD (= credit·100). Optional: absent on debit
   * structures and on any credit idea the model didn't price → 'unpriced' verdict.
   */
  creditUsd?: number;
  /** Underlying IV-rank 0–100, or null when unknown. */
  ivRank: number | null;
  /**
   * Calibrated POP (0..1) from the TRA-2006 layer when the server arms it. When
   * omitted the gate falls back to the interim flat haircut `pop − popHaircut`.
   */
  popCalibrated?: number;
}

export type ExpectancyVerdict =
  /** Credit structure clears every check — would be surfaced as tradable. */
  | 'admit'
  /** Credit structure fails E[R]/credit-width/IVR — would be dropped. */
  | 'drop'
  /** Parked family (too-thin sample) — would be dropped regardless of expectancy. */
  | 'parked'
  /** Credit structure the model didn't price (no valid creditUsd) — flagged, not a confirmed drop. */
  | 'unpriced'
  /** Debit / long-premium family — out of scope for this expectancy gate. */
  | 'not_credit';

export interface IdeaExpectancyResult {
  verdict: ExpectancyVerdict;
  /** Would this idea survive the gate and be surfaced as tradable? */
  admit: boolean;
  /** POP after calibration/haircut (NaN when not scored). */
  popUsed: number;
  /** rewardR = credit/(width − credit) = creditUsd/maxLossUsd (NaN when unpriced). */
  rewardR: number;
  /** E[R] = popUsed·rewardR − (1 − popUsed) (NaN when unpriced). */
  expectancyR: number;
  /** credit/width = creditUsd/(maxLossUsd + creditUsd) (NaN when unpriced). */
  creditWidth: number;
  /** Breakeven credit/width the structure must clear = (1 − popUsed) + buffer (NaN when unpriced). */
  breakevenCreditWidth: number;
  /** Human-readable reasons (empty when a clean admit). */
  reasons: string[];
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Score one idea against the SHADOW expectancy gate. Pure — no env, no I/O. Never
 * throws: unusable / unpriced inputs resolve to a non-committal verdict rather
 * than a fabricated edge.
 *
 * Order of checks (most specific first):
 *   1. not a credit structure           → 'not_credit' (admit; out of scope)
 *   2. parked family (iron_condor)       → 'parked'     (drop)
 *   3. IV-rank unknown or < minIvRank    → 'drop'       (credit needs elevated IV)
 *   4. no valid creditUsd / maxLossUsd   → 'unpriced'   (admit; data gap, not a confirmed −EV)
 *   5. E[R] < minExpectancyR
 *      OR credit/width < breakeven+buffer → 'drop'
 *   6. else                              → 'admit'
 */
export function evaluateIdeaExpectancy(
  input: IdeaExpectancyInput,
  config: ExpectancyGateConfig = DEFAULT_EXPECTANCY_GATE_CONFIG,
): IdeaExpectancyResult {
  const NA = Number.NaN;
  const bare = (
    verdict: ExpectancyVerdict,
    admit: boolean,
    reasons: string[],
  ): IdeaExpectancyResult => ({
    verdict,
    admit,
    popUsed: NA,
    rewardR: NA,
    expectancyR: NA,
    creditWidth: NA,
    breakevenCreditWidth: NA,
    reasons,
  });

  const strategy = input.strategy;

  // 1. Out of scope — debit / long-premium families are not the credit-spread leak.
  if (!CREDIT_STRUCTURES.has(strategy)) {
    return bare('not_credit', true, []);
  }

  // 2. Parked family — too-thin sample, shadow-drop regardless of modelled edge.
  if (config.parkStructures.has(strategy)) {
    return bare('parked', false, [
      `strategy "${strategy}" is parked until it accrues sample (bqb1 book too thin)`,
    ]);
  }

  // 3. Hard IV-rank floor for credit structures.
  const ivRank = input.ivRank;
  if (ivRank == null || !Number.isFinite(ivRank) || ivRank < config.minIvRank) {
    const seen = ivRank == null || !Number.isFinite(ivRank) ? 'unknown' : ivRank.toFixed(0);
    return bare('drop', false, [
      `ivRank ${seen} < ${config.minIvRank} — credit structure requires elevated IV`,
    ]);
  }

  // 4. Pricing. Need a positive credit and a positive max loss to evaluate E[R].
  const { creditUsd, maxLossUsd } = input;
  const priced =
    typeof creditUsd === 'number' &&
    Number.isFinite(creditUsd) &&
    creditUsd > 0 &&
    Number.isFinite(maxLossUsd) &&
    maxLossUsd > 0;
  if (!priced) {
    return bare('unpriced', true, [
      'credit not provided (no valid creditUsd) — cannot verify positive expectancy',
    ]);
  }

  // 5. Expectancy. POP_cal = supplied calibrated POP, else interim flat haircut.
  const popUsed =
    typeof input.popCalibrated === 'number' && Number.isFinite(input.popCalibrated)
      ? clamp01(input.popCalibrated)
      : clamp01(input.pop - config.popHaircut);

  const rewardR = (creditUsd as number) / (maxLossUsd as number);
  const expectancyR = popUsed * rewardR - (1 - popUsed);
  const creditWidth = (creditUsd as number) / ((maxLossUsd as number) + (creditUsd as number));
  const breakevenCreditWidth = 1 - popUsed + config.creditWidthBuffer;

  const reasons: string[] = [];
  if (expectancyR < config.minExpectancyR) {
    reasons.push(
      `E[R]=${expectancyR.toFixed(3)} < ${config.minExpectancyR.toFixed(2)}R at POP_cal ${popUsed.toFixed(3)} ` +
        `(rewardR ${rewardR.toFixed(3)} = credit/(width−credit))`,
    );
  }
  if (creditWidth < breakevenCreditWidth) {
    reasons.push(
      `credit/width ${creditWidth.toFixed(3)} < breakeven ${breakevenCreditWidth.toFixed(3)} ` +
        `(= 1 − POP_cal ${popUsed.toFixed(3)}${config.creditWidthBuffer ? ` + buffer ${config.creditWidthBuffer}` : ''})`,
    );
  }

  const verdict: ExpectancyVerdict = reasons.length > 0 ? 'drop' : 'admit';
  return {
    verdict,
    admit: verdict === 'admit',
    popUsed,
    rewardR,
    expectancyR,
    creditWidth,
    breakevenCreditWidth,
    reasons,
  };
}

/** One idea's shadow verdict, keyed for the ledger. */
export interface IdeaExpectancyShadowEntry {
  ticker: string;
  strategy: string;
  rank: number;
  result: IdeaExpectancyResult;
}

/** Aggregate SHADOW ledger over a surfaced slate. */
export interface IdeaExpectancyShadow {
  /** Resolved config the verdicts were scored under (for audit reproducibility). */
  config: {
    minExpectancyR: number;
    minIvRank: number;
    popHaircut: number;
    creditWidthBuffer: number;
    parked: string[];
  };
  entries: IdeaExpectancyShadowEntry[];
  counts: {
    total: number;
    admit: number;
    /** Would-drop for CONFIRMED negative-expectancy / credit-width / IVR — the leak cohort. */
    drop: number;
    parked: number;
    unpriced: number;
    notCredit: number;
  };
}

/** Parse a finite float in [min, max], else undefined. */
function parseBoundedFloat(raw: string | undefined, min: number, max: number): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/**
 * Resolve the gate config from env, field-by-field falling back to
 * {@link DEFAULT_EXPECTANCY_GATE_CONFIG}. Returns `null` when the master flag
 * {@link EXPECTANCY_GATE_ENABLE_VAR} is not truthy — the caller then skips the
 * shadow pass entirely, so a disabled gate is byte-for-byte the old behaviour.
 */
export function resolveExpectancyGateConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExpectancyGateConfig | null {
  const flag = (env[EXPECTANCY_GATE_ENABLE_VAR] ?? '').trim().toLowerCase();
  const enabled = flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
  if (!enabled) return null;
  return {
    minExpectancyR:
      parseBoundedFloat(env[EXPECTANCY_GATE_MIN_R_VAR], -5, 5) ??
      DEFAULT_EXPECTANCY_GATE_CONFIG.minExpectancyR,
    minIvRank:
      parseBoundedFloat(env[EXPECTANCY_GATE_MIN_IVR_VAR], 0, 100) ??
      DEFAULT_EXPECTANCY_GATE_CONFIG.minIvRank,
    popHaircut:
      parseBoundedFloat(env[EXPECTANCY_GATE_POP_HAIRCUT_VAR], 0, 1) ??
      DEFAULT_EXPECTANCY_GATE_CONFIG.popHaircut,
    creditWidthBuffer:
      parseBoundedFloat(env[EXPECTANCY_GATE_CW_BUFFER_VAR], 0, 1) ??
      DEFAULT_EXPECTANCY_GATE_CONFIG.creditWidthBuffer,
    parkStructures: DEFAULT_EXPECTANCY_GATE_CONFIG.parkStructures,
  };
}

/**
 * Score a whole surfaced slate and roll up the ledger counts. Pure. SHADOW-ONLY:
 * this never reorders or drops — it only records what the gate WOULD do, so the
 * caller can surface the ledger for the QuantTrader grade while the live slate is
 * unchanged.
 */
export function evaluateIdeasExpectancyShadow(
  ideas: ReadonlyArray<{ ticker: string; strategy: string; rank: number } & IdeaExpectancyInput>,
  config: ExpectancyGateConfig,
): IdeaExpectancyShadow {
  const entries: IdeaExpectancyShadowEntry[] = ideas.map((idea) => ({
    ticker: idea.ticker,
    strategy: idea.strategy,
    rank: idea.rank,
    result: evaluateIdeaExpectancy(idea, config),
  }));
  const counts = {
    total: entries.length,
    admit: entries.filter((e) => e.result.verdict === 'admit').length,
    drop: entries.filter((e) => e.result.verdict === 'drop').length,
    parked: entries.filter((e) => e.result.verdict === 'parked').length,
    unpriced: entries.filter((e) => e.result.verdict === 'unpriced').length,
    notCredit: entries.filter((e) => e.result.verdict === 'not_credit').length,
  };
  return {
    config: {
      minExpectancyR: config.minExpectancyR,
      minIvRank: config.minIvRank,
      popHaircut: config.popHaircut,
      creditWidthBuffer: config.creditWidthBuffer,
      parked: [...config.parkStructures],
    },
    entries,
    counts,
  };
}
