// TRA-2208 (child of TRA-1965, Lead-Quant strategy directive) — HARD credit/width
// floor + short-strike delta band for the credit verticals the AI Options Ideas
// pass emits. **Flag-off by default; OFF is byte-for-byte the old behaviour.**
//
// THE FINDING (quantified off live bqb1, commit 577acd7c1198, asOf 2026-07-23).
// `/api/health/options-ideas-decomposition` `byStructure`:
//
//   bull_put_spread   n=29  hitRate 1.00  grossR +0.03  netR −0.01  meanCreditWidth 0.03
//   bear_call_spread  n=4   hitRate 0.75  grossR −0.18  netR −0.21  meanCreditWidth 0.01
//
// The credit book collects 1–3% of spread width. Everything follows from that one
// number, and the arithmetic reconciles exactly — which is how we know it is the
// whole story and not a slice artifact:
//
//   a 100%-win book collecting 3% of width earns 0.03/0.97 = +0.031R per trade
//   → reported grossR +0.03; costs ≈ 0.04R → netR −0.01. There is no other leak.
//
//   | requirement                                 | credit/width | collected | short |
//   | breakeven at REALIZED 88% hit rate          |    0.12      |   0.03    |  4×   |
//   | breakeven at calibrated POP 0.79            |    0.21      |   0.03    |  7×   |
//   | TRA-2005 admission bar (E[R] ≥ +0.10R)      |    0.28      |   0.03    |  9×   |
//
// WHY IT HAPPENS. Strike selection is UNCONSTRAINED. The research prompt gives the
// model no delta band and no credit/width floor; POP is the salient quality number
// it is asked to emit. An unconstrained model asked to produce a high POP sells FAR
// out-of-the-money, where POP is excellent and the premium is a rounding error.
// 29 wins out of 29 is the signature of that, not a sign of skill.
//
// SAME DEFECT, TWO FACES. It also explains the TRA-2006 calibration gap: realized
// hitRate 0.88 vs stated POP 0.71 is an UNDER-statement — strikes so far OTM they
// hit more often than the model claims. The calibration gap and the credit gap are
// one defect viewed from two sides.
//
// TAIL NOTE. At +0.031R per win a single max loss (−1R) needs ~32 wins to repay. We
// have 29. The FIRST full loss on the bull-put book erases the entire run and puts
// it net negative — so the headline +0.01R is optimistic, not pessimistic.
//
// DO NOT TUNE THE FLOOR TO MAKE IDEAS SURVIVE (explicit Lead-Quant instruction). If
// a 0.20 floor leaves the engine surfacing almost nothing, THAT IS THE ANSWER, and
// it is the CUT signal on TRA-1965 — it would mean our universe/IV regime does not
// offer sellable premium at our cost base. An empty slate is a valid, informative
// result here; the survival rate is reported honestly either way.
//
// KEEP `ENABLE_POP_CALIBRATION` OFF. Arming TRA-2006 would LOOSEN this gate: the
// expectancy breakeven is `1 − POP_cal`, so raising calibrated POP 0.71 → 0.79
// DROPS the required floor 0.29 → 0.21. It relaxes the entry bar in the exact
// dimension that is failing. TRA-2115's HOLD now has a second, stronger reason.
//
// RELATIONSHIP TO TRA-2005. The expectancy gate (`options-ideas-expectancy-gate.ts`)
// is a SHADOW scorer: it records what it WOULD drop and never acts. This is a HARD
// EMISSION floor: when its own flag is on it actually removes the idea. They are
// deliberately separate flags with separate thresholds — the expectancy bar is
// POP-conditional (`1 − POP_cal`, which POP calibration can move), while this floor
// is an absolute, POP-independent survival bar the desk sets. Both mirror the same
// `creditUsd / (creditUsd + maxLossUsd)` identity; neither imports the other's
// thresholds.

/**
 * The net-credit structures this floor governs. Mirrors — deliberately does not
 * import — `CREDIT_STRUCTURES` in `options-ideas-expectancy-gate.ts`: the two gates
 * must be independently retunable, and a shared set would silently couple them.
 * Keep in sync. Debit / long-premium families are out of scope (their expectancy
 * shape is reward = width − debit, not the penny-wide-credit leak this targets).
 */
export const FLOORED_CREDIT_STRUCTURES: ReadonlySet<string> = new Set<string>([
  'bull_put_spread',
  'bear_call_spread',
  'iron_condor',
  'iron_butterfly',
]);

/**
 * Short-strike delta band for credit verticals. Below ~0.20 delta the premium does
 * not clear costs at our fee base (~0.04R round-trip); above ~0.30 the structure
 * stops being a high-probability credit trade and becomes a directional bet. The
 * band is a PROMPT CONTRACT, not a deterministic reject: an idea record carries no
 * strikes, so there is nothing to re-derive the delta from server-side. What we do
 * enforce deterministically is the credit/width floor, which is the same constraint
 * expressed in the dimension we can actually verify from the emitted numbers.
 */
export const DEFAULT_SHORT_DELTA_MIN = 0.2;
export const DEFAULT_SHORT_DELTA_MAX = 0.3;

/**
 * The floor itself: a credit vertical must collect at least this fraction of its
 * defined width. It is NOT an independent number — it is the bottom of the short-leg
 * delta band, and the two constraints are one constraint.
 *
 * NO-ARBITRAGE IDENTITY. A vertical's credit is what the market charges for the
 * short strike being breached, so `credit ≈ width × P_rn(breach)` and therefore
 *
 *     c = creditUsd / (creditUsd + maxLossUsd) ≈ Δ_short
 *
 * The credit/width ratio IS the short-leg delta. Stating a 0.20–0.30 delta band in
 * the prompt mechanically produces `c ∈ [0.20, 0.30]`; the floor is that band's
 * lower edge, expressed in the one dimension we can verify server-side from the
 * emitted numbers (an idea record carries no strikes).
 *
 * Two second-order gaps, in opposite directions, both small at our widths:
 *   - Strictly the ratio tracks the DUAL delta `N(−d₂)`, not delta `N(−d₁)`. For a
 *     put `N(−d₂) > N(−d₁)`, so a 0.20-delta short strike pays slightly MORE than
 *     0.20 of width — the floor errs loose, never tight.
 *   - Over a finite width `c` is the dual delta AVERAGED across the two strikes, so
 *     widening pulls `c` down. Holding R constant only needs ~21% more width
 *     (R = width × (1 − c); 0.97 → 0.80), so this stays second-order.
 *
 * INVARIANT — IF THE DELTA BAND MOVES, THE FLOOR MOVES WITH IT. Do not restate 0.20
 * here. Two independent constants will drift apart on the next retune and silently
 * reopen the leak this floor exists to close. Deliberately still BELOW the TRA-2005
 * admission bar of 0.28, so this is the survival floor, not the edge bar.
 */
export const DEFAULT_CREDIT_WIDTH_FLOOR = DEFAULT_SHORT_DELTA_MIN; // c ≈ Δ_short (no-arb)

/** Resolved, fully-defaulted floor configuration. Pure — no env access. */
export interface CreditWidthFloorConfig {
  /** Minimum `credit / width` a credit vertical must collect. Default 0.20. */
  minCreditWidth: number;
  /** Lower edge of the short-strike delta band stated to the model. Default 0.20. */
  shortDeltaMin: number;
  /** Upper edge of the short-strike delta band stated to the model. Default 0.30. */
  shortDeltaMax: number;
}

export const DEFAULT_CREDIT_WIDTH_FLOOR_CONFIG: CreditWidthFloorConfig = {
  minCreditWidth: DEFAULT_CREDIT_WIDTH_FLOOR,
  shortDeltaMin: DEFAULT_SHORT_DELTA_MIN,
  shortDeltaMax: DEFAULT_SHORT_DELTA_MAX,
};

/** Env var names (all optional; unset/malformed → reference default). */
export const CREDIT_WIDTH_FLOOR_ENABLE_VAR = 'ENABLE_OPTIONS_IDEA_CREDIT_WIDTH_FLOOR';
export const CREDIT_WIDTH_FLOOR_MIN_VAR = 'OPTIONS_IDEA_CREDIT_WIDTH_MIN';
export const CREDIT_WIDTH_FLOOR_DELTA_MIN_VAR = 'OPTIONS_IDEA_SHORT_DELTA_MIN';
export const CREDIT_WIDTH_FLOOR_DELTA_MAX_VAR = 'OPTIONS_IDEA_SHORT_DELTA_MAX';

/**
 * `credit / width = creditUsd / (creditUsd + maxLossUsd)`. The ×100 contract
 * multipliers cancel, so no separate `width` datum is needed. Returns `null` when
 * the idea is not priced well enough to form the ratio — never a fabricated 0,
 * which would read as "collects nothing" rather than "we do not know".
 */
export function creditWidthRatioOf(
  creditUsd: number | undefined,
  maxLossUsd: number | undefined,
): number | null {
  if (typeof creditUsd !== 'number' || !Number.isFinite(creditUsd) || creditUsd <= 0) return null;
  if (typeof maxLossUsd !== 'number' || !Number.isFinite(maxLossUsd) || maxLossUsd <= 0) return null;
  return creditUsd / (creditUsd + maxLossUsd);
}

export type CreditWidthVerdict =
  /** Credit vertical collecting at/above the floor — emitted. */
  | 'pass'
  /** Credit vertical below the floor — REMOVED from the slate when the flag is on. */
  | 'reject'
  /**
   * Credit vertical the model did not price (no valid `creditUsd`). Also removed:
   * the floor is a HARD bar and an unverifiable credit idea cannot clear it.
   *
   * This DIVERGES from the TRA-2005 shadow gate, which admits `unpriced` because it
   * only records and a data gap is not a confirmed −EV. Here the consequence is real
   * emission, and prompt rule 4 already REQUIRES `creditUsd` on credit structures —
   * so an unpriced credit idea is a contract violation, not a data gap. Counted
   * separately from `reject` so the survival rate never conflates "collects too
   * little" with "did not say how much it collects".
   */
  | 'unpriced'
  /** Debit / long-premium family — out of scope, always emitted. */
  | 'not_credit';

export interface CreditWidthFloorResult {
  verdict: CreditWidthVerdict;
  /** Would this idea survive the floor and be emitted? */
  admit: boolean;
  /**
   * PRE-floor `credit / width`, or `null` when it could not be formed. This is the
   * datum the Lead Quant grades: it is recorded for EVERY credit idea the model
   * proposed, including the ones the floor removes.
   */
  creditWidthRatio: number | null;
  /** The floor the ratio was measured against (audit reproducibility). */
  floor: number;
  /** Short-leg delta the model reported, when it reported one. */
  shortDelta: number | null;
  /** Was `shortDelta` inside the stated band? `null` when the model reported none. */
  shortDeltaInBand: boolean | null;
  /** Human-readable cause. Empty on a clean pass / out-of-scope family. */
  reasons: string[];
}

/** Per-idea inputs the floor scores. Pure value object — no lookups. */
export interface CreditWidthFloorInput {
  strategy: string;
  /** Defined max loss per 1-lot in USD = (width − credit)·100 for credit verticals. */
  maxLossUsd: number;
  /** Net credit per 1-lot in USD (= credit·100). Absent on debit families. */
  creditUsd?: number;
  /**
   * Short-leg |delta| the model reported (0..1), when it reported one. Advisory —
   * out-of-band never rejects on its own (see {@link DEFAULT_SHORT_DELTA_MIN}); it
   * is recorded so the band's effect on the book is gradeable.
   */
  shortDelta?: number;
}

/**
 * Score one proposed idea against the hard credit/width floor. Pure — no env, no
 * IO, never throws.
 *
 *   1. not a floored credit structure → 'not_credit' (admit)
 *   2. no usable credit/width ratio   → 'unpriced'   (REJECT — see the verdict doc)
 *   3. ratio < floor                  → 'reject'
 *   4. else                           → 'pass'
 *
 * The delta band is recorded at every step but gates nothing.
 */
export function evaluateCreditWidthFloor(
  input: CreditWidthFloorInput,
  config: CreditWidthFloorConfig = DEFAULT_CREDIT_WIDTH_FLOOR_CONFIG,
): CreditWidthFloorResult {
  const shortDelta =
    typeof input.shortDelta === 'number' && Number.isFinite(input.shortDelta)
      ? Math.abs(input.shortDelta)
      : null;
  const shortDeltaInBand =
    shortDelta == null
      ? null
      : shortDelta >= config.shortDeltaMin && shortDelta <= config.shortDeltaMax;

  const base = (
    verdict: CreditWidthVerdict,
    admit: boolean,
    creditWidthRatio: number | null,
    reasons: string[],
  ): CreditWidthFloorResult => ({
    verdict,
    admit,
    creditWidthRatio,
    floor: config.minCreditWidth,
    shortDelta,
    shortDeltaInBand,
    reasons,
  });

  if (!FLOORED_CREDIT_STRUCTURES.has(input.strategy)) {
    return base('not_credit', true, null, []);
  }

  const ratio = creditWidthRatioOf(input.creditUsd, input.maxLossUsd);
  if (ratio == null) {
    return base('unpriced', false, null, [
      `credit structure "${input.strategy}" priced no net credit (creditUsd is required for credit ` +
        `structures) — the credit/width floor ${config.minCreditWidth.toFixed(2)} cannot be verified`,
    ]);
  }

  if (ratio < config.minCreditWidth) {
    return base('reject', false, ratio, [
      `credit/width ${ratio.toFixed(3)} < floor ${config.minCreditWidth.toFixed(2)} — the credit ` +
        `does not cover the structure's own loss rate at our cost base`,
    ]);
  }

  return base('pass', true, ratio, []);
}

/** One idea's floor verdict, keyed for the ledger. */
export interface CreditWidthFloorShadowEntry {
  ticker: string;
  strategy: string;
  result: CreditWidthFloorResult;
}

/**
 * PRE-floor ledger over one proposed slate. Records what the model wanted to emit
 * BEFORE the floor removed anything, which is the only way to measure how much of
 * the current book the floor takes out.
 */
export interface CreditWidthFloorShadow {
  /** Resolved config the verdicts were scored under (audit reproducibility). */
  config: CreditWidthFloorConfig;
  entries: CreditWidthFloorShadowEntry[];
  counts: {
    /** Every idea the model proposed, all families. */
    total: number;
    /** Credit verticals the floor governs (`pass + reject + unpriced`). */
    credit: number;
    pass: number;
    reject: number;
    unpriced: number;
    notCredit: number;
  };
  stats: {
    /** Credit ideas carrying a usable ratio (`pass + reject`). */
    priced: number;
    /** Mean PRE-floor credit/width over the priced credit ideas. Null when none. */
    meanCreditWidth: number | null;
    minCreditWidth: number | null;
    maxCreditWidth: number | null;
    /** Credit ideas that reported a short-leg delta. */
    deltaReported: number;
    /** Of those, how many landed inside the stated band. */
    deltaInBand: number;
  };
  /**
   * THE NUMBER THAT DRIVES THE CUT/CONTINUE FORK on TRA-1965: fraction of the
   * proposed CREDIT book that survives the floor (`pass / credit`). Null when the
   * slate proposed no credit ideas at all — an honest "no basis", never a 0 or 1
   * that would read as a measurement.
   *
   * `unpriced` sits in the denominator: a credit idea that refuses to price itself
   * is a book member that did not survive, and excluding it would flatter the rate.
   */
  survivalRate: number | null;
}

function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Score a whole PROPOSED slate and roll up the ledger. Pure. Call this on the raw
 * model output BEFORE the floor thins it, so the ledger holds the pre-floor
 * candidates the directive asks to log.
 */
export function evaluateIdeasCreditWidthFloor(
  ideas: ReadonlyArray<{ ticker: string } & CreditWidthFloorInput>,
  config: CreditWidthFloorConfig,
): CreditWidthFloorShadow {
  const entries: CreditWidthFloorShadowEntry[] = ideas.map((idea) => ({
    ticker: idea.ticker,
    strategy: idea.strategy,
    result: evaluateCreditWidthFloor(idea, config),
  }));
  const by = (v: CreditWidthVerdict): CreditWidthFloorShadowEntry[] =>
    entries.filter((e) => e.result.verdict === v);
  const pass = by('pass').length;
  const reject = by('reject').length;
  const unpriced = by('unpriced').length;
  const notCredit = by('not_credit').length;
  const credit = pass + reject + unpriced;

  const ratios = entries
    .map((e) => e.result.creditWidthRatio)
    .filter((r): r is number => r != null);
  const creditEntries = entries.filter((e) => e.result.verdict !== 'not_credit');
  const deltaReported = creditEntries.filter((e) => e.result.shortDelta != null).length;
  const deltaInBand = creditEntries.filter((e) => e.result.shortDeltaInBand === true).length;

  return {
    config: { ...config },
    entries,
    counts: { total: entries.length, credit, pass, reject, unpriced, notCredit },
    stats: {
      priced: ratios.length,
      meanCreditWidth: mean(ratios),
      minCreditWidth: ratios.length ? Math.min(...ratios) : null,
      maxCreditWidth: ratios.length ? Math.max(...ratios) : null,
      deltaReported,
      deltaInBand,
    },
    survivalRate: credit > 0 ? pass / credit : null,
  };
}

/** Parse a finite float in [min, max], else undefined. */
function parseBoundedFloat(raw: string | undefined, min: number, max: number): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/**
 * TRA-2680 — resolve the floor config from env **ignoring the enable flag**: the
 * config the next scored slate WOULD be built from, whether or not the floor is
 * currently armed. Always returns a config; never null.
 *
 * WHY THIS EXISTS SEPARATELY. TRA-2217 made the floor DERIVED (it falls back to the
 * resolved band bottom, below), so the live floor is now a function of
 * `OPTIONS_IDEA_SHORT_DELTA_MIN`. Neither that var nor `OPTIONS_IDEA_CREDIT_WIDTH_MIN`
 * is declared in the Render blueprint, so `/api/health/env-drift` — which compares
 * DECLARED keys only — cannot rule out a hand-set override moving the band and
 * carrying the floor with it. Before this split the resolved config was observable
 * ONLY through a scored slate, i.e. only once the flag was on and had already gated
 * ideas under whatever value was live. That made the pre-arm audit impossible by
 * construction. This is the flag-independent read the probe publishes.
 *
 * A delta band whose resolved min exceeds its max is discarded wholesale in favour
 * of the reference band: a nonsensical band would otherwise be stated to the model
 * as a contract it cannot satisfy.
 */
export function resolveCreditWidthFloorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CreditWidthFloorConfig {
  const shortDeltaMin =
    parseBoundedFloat(env[CREDIT_WIDTH_FLOOR_DELTA_MIN_VAR], 0, 1) ?? DEFAULT_SHORT_DELTA_MIN;
  const shortDeltaMax =
    parseBoundedFloat(env[CREDIT_WIDTH_FLOOR_DELTA_MAX_VAR], 0, 1) ?? DEFAULT_SHORT_DELTA_MAX;
  const bandOk = shortDeltaMin <= shortDeltaMax;
  const resolvedShortDeltaMin = bandOk ? shortDeltaMin : DEFAULT_SHORT_DELTA_MIN;
  return {
    // The floor defaults to the RESOLVED band bottom, not the module constant: the
    // c ≈ Δ_short identity has to survive an env-overridden band, or the two drift
    // apart at runtime. An explicit OPTIONS_IDEA_CREDIT_WIDTH_MIN still wins — that
    // is a deliberate operator override, not drift.
    minCreditWidth:
      parseBoundedFloat(env[CREDIT_WIDTH_FLOOR_MIN_VAR], 0, 1) ?? resolvedShortDeltaMin,
    shortDeltaMin: resolvedShortDeltaMin,
    shortDeltaMax: bandOk ? shortDeltaMax : DEFAULT_SHORT_DELTA_MAX,
  };
}

/**
 * Resolve the floor config for the EMISSION PATH. Returns `null` when
 * {@link CREDIT_WIDTH_FLOOR_ENABLE_VAR} is not truthy — the caller then leaves the
 * prompt, the guardrail and the emitted idea shape untouched, so a disabled floor
 * is byte-for-byte the old behaviour.
 *
 * Flag ON is NOT a shadow/recorder mode: it changes the system prompt, the batch
 * cache key, and it DROPS below-floor credit verticals from the surfaced slate
 * (`options-research.ts`). Anything that only wants to READ the configured floor
 * must call {@link resolveCreditWidthFloorConfigFromEnv} instead — reading must
 * never require arming.
 */
export function resolveCreditWidthFloorConfig(
  env: NodeJS.ProcessEnv = process.env,
): CreditWidthFloorConfig | null {
  const flag = (env[CREDIT_WIDTH_FLOOR_ENABLE_VAR] ?? '').trim().toLowerCase();
  const enabled = flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
  if (!enabled) return null;
  return resolveCreditWidthFloorConfigFromEnv(env);
}
