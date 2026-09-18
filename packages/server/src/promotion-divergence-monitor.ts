import {
  compareToBacktestBasis,
  computePaperGateMetrics,
  type PaperGateMetrics,
  type PromotionDecision,
  type PromotionThresholds,
  type PromotionTradeSample,
} from '@trading-app/shared';

/**
 * TRA-4661 (parent TRA-4413 item 6) — a STANDING backtest-vs-forward divergence
 * check for strategies that already cleared the TRA-532 promotion gate,
 * SHADOW-first.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * The Stage-2 admission gate already compares forward performance against the
 * backtest that certified a strategy (paper expectancy ≥ 0.5 × backtest
 * expectancy — the "overfit signal" — and realized ≤ 1.5 × modeled slippage).
 * It runs ONCE, at admission. Nothing re-asks the question afterwards, and
 * every standing control we run (give-back halt, drawdown brake, fleet caps) is
 * P&L-shaped — so a strategy can drift well off the basis it was promoted on
 * while still mildly profitable and nothing notices. This module re-asks it on
 * a schedule and REPORTS the answer.
 *
 * ── CONSULTED, NOT RE-IMPLEMENTED ────────────────────────────────────────────
 * The metrics come out of `computePaperGateMetrics` and the comparison out of
 * `compareToBacktestBasis` — the very function `evaluatePaperGate` now calls
 * (extracted, not copied). The thresholds are the strategy's EFFECTIVE
 * thresholds (the ratified 0.5 / 1.5 defaults, or the loosen-only override its
 * sign-off recorded). Nothing here is tuned to today's numbers.
 *
 * ── THE BASIS (deliverable 2) ────────────────────────────────────────────────
 * The basis is the `backtestMetrics` SNAPSHOT persisted on the active (latest)
 * `PromotionDecision` at sign-off (`recordSignoff`, promotion-store.ts) — the
 * numbers that admitted the strategy, never the mutable `rec.backtest` (which a
 * later `registerBacktestReport` replaces in place) and never a re-derived
 * backtest. A sign-off with a null snapshot (accumulate-class, or a legacy
 * record) reads `no_admission_basis`, never a comparison.
 *
 * ── THE FORWARD POPULATION ───────────────────────────────────────────────────
 * Closed trades of the strategy OPENED at/after the active sign-off, demo and
 * live books and the PCS shadow ledger (`collectForwardTradeSamples`). Disjoint
 * from the admission sample by construction.
 *
 * ── REASON CODES (the TRA-3945 trap) ─────────────────────────────────────────
 * Five, low-cardinality. `insufficient_population` and `no_divergence` are
 * DIFFERENT codes and both are counted: we run ~0 live fills structurally
 * (TRA-1620), and an expectancy ratio over n=2 is noise — a monitor that says
 * "no divergence" when it had nothing to compare manufactures a green surface.
 * The minimum population is the RATIFIED Stage-2 `paper.minTradeCount` (50 by
 * default): the monitor refuses to grade drift on less evidence than admission
 * required. `no_divergence` is emitted ONLY when BOTH arms were graded and both
 * were clean; an arm that could not be graded contributes its own code instead.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
 *   • NOT a demotion. It disables nothing, in any mode; there is no enforce arm
 *     in this module. Demotion authority is a separate, later decision.
 *   • NOT durable. Counters are SINCE-BOOT; each pass recomputes from the
 *     durable ledgers, so a restart loses only the tally, never the verdict.
 *
 * ── FLAG / CADENCE ───────────────────────────────────────────────────────────
 * `ENABLE_PROMOTION_DIVERGENCE_MONITOR_SHADOW`, default OFF, STANDALONE.
 * Recomputed hourly ({@link PROMOTION_DIVERGENCE_RECOMPUTE_MS}): the forward
 * ledgers only move when a trade closes, so hourly bounds the lag to one hour at
 * a cost of one snapshot read per user per signed-off strategy.
 */

export const PROMOTION_DIVERGENCE_SHADOW_FLAG = 'ENABLE_PROMOTION_DIVERGENCE_MONITOR_SHADOW';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function isPromotionDivergenceMonitorShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[PROMOTION_DIVERGENCE_SHADOW_FLAG]);
}

/** Hourly: the forward ledgers only move when a trade closes. */
export const PROMOTION_DIVERGENCE_RECOMPUTE_MS = 60 * 60_000;

export const PROMOTION_DIVERGENCE_CODES = [
  'no_admission_basis',
  'insufficient_population',
  'no_divergence',
  'expectancy_divergence',
  'slippage_divergence',
] as const;
export type PromotionDivergenceCode = (typeof PROMOTION_DIVERGENCE_CODES)[number];

/** Per-arm state. `clean` exists only for an arm that was actually graded. */
export type PromotionDivergenceArmState = 'diverged' | 'clean' | 'insufficient_population' | 'no_admission_basis';

export interface PromotionDivergenceVerdict {
  strategyId: string;
  /** The active sign-off the basis was read from; null ⇒ `no_admission_basis`. */
  decisionId: string | null;
  decidedAt: string | null;
  /** Non-empty. Divergence codes, else `no_divergence`, else the refusal code(s). */
  reasonCodes: PromotionDivergenceCode[];
  /** The ratified Stage-2 minimum trade count the forward sample must reach. */
  minPopulation: number;
  /** Forward metrics (null only when there is no basis to measure from). */
  forward: PaperGateMetrics | null;
  arms: {
    expectancy: { state: PromotionDivergenceArmState; forward: number | null; basis: number | null; floor: number | null };
    slippage: { state: PromotionDivergenceArmState; ratio: number | null; cap: number; sampleSize: number };
  };
}

/**
 * Pure verdict for one strategy. `decision` is the ACTIVE sign-off (latest
 * entry), `forward` the samples opened at/after it.
 */
export function evaluatePromotionDivergence(input: {
  strategyId: string;
  decision: PromotionDecision | null;
  forward: readonly PromotionTradeSample[];
  thresholds: PromotionThresholds;
}): PromotionDivergenceVerdict {
  const { strategyId, decision, thresholds } = input;
  const minPopulation = thresholds.paper.minTradeCount;
  const cap = thresholds.paper.maxSlippageRatio;
  const basis = decision?.backtestMetrics ?? null;

  if (!decision || !basis) {
    return {
      strategyId,
      decisionId: decision?.id ?? null,
      decidedAt: decision?.decidedAt ?? null,
      reasonCodes: ['no_admission_basis'],
      minPopulation,
      forward: null,
      arms: {
        expectancy: { state: 'no_admission_basis', forward: null, basis: null, floor: null },
        slippage: { state: 'no_admission_basis', ratio: null, cap, sampleSize: 0 },
      },
    };
  }

  const forward = computePaperGateMetrics(input.forward);
  const cmp = compareToBacktestBasis(forward, basis, thresholds);

  let expectancyState: PromotionDivergenceArmState;
  let slippageState: PromotionDivergenceArmState;
  if (forward.tradeCount < minPopulation) {
    expectancyState = 'insufficient_population';
    slippageState = 'insufficient_population';
  } else {
    // A non-positive basis expectancy admits no ratio floor: that is a property
    // of the BASIS, not of the forward sample.
    expectancyState = cmp.expectancy === null ? 'no_admission_basis' : cmp.expectancy.diverged ? 'diverged' : 'clean';
    // The slippage ratio is graded on the trades that carry BOTH figures, so
    // that sub-sample must clear the same floor on its own.
    slippageState =
      cmp.slippage === null || forward.slippageSampleSize < minPopulation
        ? 'insufficient_population'
        : cmp.slippage.diverged
          ? 'diverged'
          : 'clean';
  }

  const codes: PromotionDivergenceCode[] = [];
  if (expectancyState === 'diverged') codes.push('expectancy_divergence');
  if (slippageState === 'diverged') codes.push('slippage_divergence');
  if (codes.length === 0) {
    if (expectancyState === 'clean' && slippageState === 'clean') codes.push('no_divergence');
    else
      for (const s of [expectancyState, slippageState]) {
        if (s !== 'clean' && !codes.includes(s as PromotionDivergenceCode)) codes.push(s as PromotionDivergenceCode);
      }
  }

  return {
    strategyId,
    decisionId: decision.id,
    decidedAt: decision.decidedAt,
    reasonCodes: codes,
    minPopulation,
    forward,
    arms: {
      expectancy: {
        state: expectancyState,
        forward: forward.expectancy,
        basis: basis.expectancy,
        floor: cmp.expectancy?.floor ?? null,
      },
      slippage: { state: slippageState, ratio: forward.slippageRatio, cap, sampleSize: forward.slippageSampleSize },
    },
  };
}

// ── Scheduled pass + since-boot counters ─────────────────────────────────────

export interface PromotionDivergencePassDeps {
  /** Every promotion record (strategyId + append-only decisions). */
  listRecords: () => Promise<Array<{ strategyId: string; decisions: PromotionDecision[] }>>;
  getThresholds: (strategyId: string) => Promise<PromotionThresholds>;
  collectForward: (
    strategyId: string,
    sinceMs: number,
  ) => Promise<{ samples: PromotionTradeSample[]; byMode: Record<string, number>; undated: number }>;
  now?: () => number;
}

export interface PromotionDivergencePassRow extends PromotionDivergenceVerdict {
  byMode: Record<string, number>;
  undated: number;
}

function emptyByCode(): Record<PromotionDivergenceCode, number> {
  return Object.fromEntries(PROMOTION_DIVERGENCE_CODES.map((c) => [c, 0])) as Record<PromotionDivergenceCode, number>;
}

let byCode = emptyByCode();
let passes = 0;
let failedPasses = 0;
let lastPassAt: number | null = null;
let lastPassError: string | null = null;
let lastRows: PromotionDivergencePassRow[] = [];
let sinceMs = Date.now();

/** Test seam. */
export function resetPromotionDivergenceCountersForTest(): void {
  byCode = emptyByCode();
  passes = 0;
  failedPasses = 0;
  lastPassAt = null;
  lastPassError = null;
  lastRows = [];
  sinceMs = Date.now();
}

/**
 * One recomputation over every SIGNED-OFF strategy (a strategy with no sign-off
 * was never promoted and is out of scope). Every code on every verdict is
 * counted. Returns the rows, plus the strategies whose reason codes CHANGED
 * since the previous pass (the caller logs transitions, not every pass).
 */
export async function runPromotionDivergencePass(
  deps: PromotionDivergencePassDeps,
): Promise<{ rows: PromotionDivergencePassRow[]; changed: PromotionDivergencePassRow[] }> {
  const now = deps.now ?? Date.now;
  try {
    const records = (await deps.listRecords()).filter((r) => r.decisions.length > 0);
    const rows: PromotionDivergencePassRow[] = [];
    for (const rec of records) {
      const decision = rec.decisions[rec.decisions.length - 1]!;
      const decidedMs = Date.parse(decision.decidedAt);
      const thresholds = await deps.getThresholds(rec.strategyId);
      const fwd = Number.isFinite(decidedMs)
        ? await deps.collectForward(rec.strategyId, decidedMs)
        : { samples: [], byMode: {}, undated: 0 };
      const verdict = evaluatePromotionDivergence({
        strategyId: rec.strategyId,
        // An unparseable decidedAt cannot bound a forward window: no basis.
        decision: Number.isFinite(decidedMs) ? decision : null,
        forward: fwd.samples,
        thresholds,
      });
      rows.push({ ...verdict, byMode: fwd.byMode, undated: fwd.undated });
    }
    const prev = new Map(lastRows.map((r) => [r.strategyId, r.reasonCodes.join(',')]));
    const changed = rows.filter((r) => prev.get(r.strategyId) !== r.reasonCodes.join(','));
    for (const r of rows) for (const c of r.reasonCodes) byCode[c] += 1;
    passes += 1;
    lastPassAt = now();
    lastPassError = null;
    lastRows = rows;
    return { rows, changed };
  } catch (err) {
    failedPasses += 1;
    lastPassError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

export interface PromotionDivergenceHealth {
  readonly issue: 'TRA-4661';
  readonly flag: string;
  readonly enabled: boolean;
  /** The raw env string, so a typo'd arm attempt is visible (UNKNOWN IS NOT OFF). */
  readonly raw: string | null;
  readonly shadowOnly: true;
  readonly recomputeEveryMs: number;
  /** ⚠️ SINCE-BOOT. A restart zeroes the tallies (not the verdicts — each pass recomputes). */
  readonly countersSince: string;
  readonly passes: number;
  readonly failedPasses: number;
  readonly lastPassAt: string | null;
  readonly lastPassError: string | null;
  /** Verdict-code tallies across every pass since boot; dense — absent is not zero. */
  readonly byCode: { code: PromotionDivergenceCode; count: number }[];
  /** The most recent pass, one row per signed-off strategy. */
  readonly strategies: PromotionDivergencePassRow[];
  readonly note: string;
}

export function promotionDivergenceHealth(env: NodeJS.ProcessEnv = process.env): PromotionDivergenceHealth {
  const raw = env[PROMOTION_DIVERGENCE_SHADOW_FLAG];
  const enabled = isPromotionDivergenceMonitorShadowEnabled(env);
  return {
    issue: 'TRA-4661',
    flag: PROMOTION_DIVERGENCE_SHADOW_FLAG,
    enabled,
    raw: raw ?? null,
    shadowOnly: true,
    recomputeEveryMs: PROMOTION_DIVERGENCE_RECOMPUTE_MS,
    countersSince: new Date(sinceMs).toISOString(),
    passes,
    failedPasses,
    lastPassAt: lastPassAt === null ? null : new Date(lastPassAt).toISOString(),
    lastPassError,
    byCode: PROMOTION_DIVERGENCE_CODES.map((code) => ({ code, count: byCode[code] })),
    strategies: lastRows,
    note: enabled
      ? 'SHADOW ONLY: re-asks the Stage-2 backtest-vs-forward comparison (same function, same '
        + 'effective thresholds) against the backtestMetrics snapshot on each strategy\'s ACTIVE '
        + 'sign-off, over trades opened since that sign-off. Disables nothing. '
        + '`insufficient_population` (forward n below the ratified Stage-2 minTradeCount) is NOT '
        + '`no_divergence` — only the latter is a clean result, and it requires BOTH arms graded. '
        + 'passes == 0 with strategies == [] is NOT a clean bill either: nothing has been measured.'
      : `DARK: set ${PROMOTION_DIVERGENCE_SHADOW_FLAG}=1 to record. Everything below is structurally `
        + 'zero — the shipped-but-unarmed default, not a clean bill.',
  };
}
