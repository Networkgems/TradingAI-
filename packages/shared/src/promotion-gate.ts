// ── Live-Trading Promotion Gate (LTPG) — TRA-532 ─────────────────────────────
//
// Enforcement of the TRA-527 gate-spec: no strategy flips to LIVE until it has
// PASSED Stage 1 (backtest) AND Stage 2 (paper / forward test) AND has a
// recorded Stage 3 sign-off. This module is the *pure* core of the gate:
//
//   • thresholds (v1 defaults from the spec, tunable per strategy),
//   • metric computation **from data** (a backtest report's fields and the
//     paper-trade ledger) — never hand-entered, so the gate can't be gamed by
//     typing numbers,
//   • per-stage evaluation + an overall `canGoLive` verdict with the exact
//     blocked reasons.
//
// It has no I/O. The server layer (promotion-store / promotion-service) loads
// the registered backtest report, the paper ledger, and the sign-off record,
// then calls `evaluatePromotion()` to decide whether the mode-switch route may
// flip a strategy live.

/** Per-stage state surfaced on a strategy's `promotion_status`. */
export type PromotionStageState = 'pass' | 'fail' | 'missing';

/** Stage-3 sign-off presence. */
export type SignoffState = 'present' | 'absent';

// ── Thresholds (TRA-527 v1 defaults) ─────────────────────────────────────────

/**
 * Tunable gate thresholds. The values below are the TRA-527 v1 defaults; they
 * may be overridden per strategy but — per the spec — only *loosened* by a
 * QuantTrader sign-off carrying a written rationale (enforced at the service
 * layer via the override record, not here).
 */
export interface PromotionThresholds {
  /** Stage 1 — backtest (OOS, net of costs). */
  backtest: {
    minSharpe: number;
    minExpectancy: number;
    minProfitFactor: number;
    maxDrawdownPct: number; // 0.20 == 20%
    minTradeCount: number;
  };
  /** Stage 2 — paper / forward test (net). */
  paper: {
    minTradeCount: number;
    minExpectancy: number;
    /** Paper expectancy must be ≥ this fraction × backtest expectancy. */
    minExpectancyVsBacktestRatio: number;
    minSharpe: number;
    /** Realized slippage must be ≤ this multiple of modeled slippage. */
    maxSlippageRatio: number;
  };
}

export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  backtest: {
    minSharpe: 1.0,
    minExpectancy: 0, // expectancy > 0 (strictly); see comparison below
    minProfitFactor: 1.3,
    maxDrawdownPct: 0.2,
    minTradeCount: 100,
  },
  paper: {
    minTradeCount: 50,
    minExpectancy: 0, // expectancy > 0 (strictly)
    minExpectancyVsBacktestRatio: 0.5,
    minSharpe: 0.8,
    maxSlippageRatio: 1.5,
  },
};

// ── Metric shapes ────────────────────────────────────────────────────────────

/**
 * Backtest metrics that feed the Stage-1 gate. These are *picked* from a
 * computed backtest report (`@trading-app/backtest` `BacktestResult`), never
 * hand-entered. Kept as a minimal structural type so `@trading-app/shared`
 * does not have to depend on the backtest package (dependency direction is
 * backtest → shared, never the reverse).
 */
export interface BacktestGateMetrics {
  sharpe: number;
  /** Average R per trade. */
  expectancy: number;
  profitFactor: number;
  /** Fractional max drawdown, e.g. 0.18 for 18%. */
  maxDrawdown: number;
  tradeCount: number;
}

/**
 * TRA-541 — the TRA-540 optimization harness's machine-readable `verdict`,
 * reduced to what the Stage-1 gate needs. The harness runs a six-guard
 * overfitting battery (G1 walk-forward efficiency, G2 deflated/probabilistic
 * Sharpe, G3 probability of backtest overfitting, G4 bootstrap OOS floor,
 * G5 holdout confirmation, G6 cost/slippage stress) and only sets `pass: true`
 * when ALL SIX are green.
 *
 * When such a verdict is registered for a strategy it BECOMES the Stage-1 gate:
 * the leg passes iff `pass === true`. A strategy with strong headline
 * `BacktestGateMetrics` but `pass === false` must NOT clear Stage 1 — the
 * six-guard verdict is the gate, not the raw metrics. Kept structural (no
 * dependency on `@trading-app/backtest`) to preserve the backtest → shared
 * dependency direction.
 */
export interface BacktestGateVerdict {
  /** True iff all six TRA-540 overfitting guards (G1–G6) are green. */
  pass: boolean;
  /** Per-guard pass/value, used to name which guard(s) blocked Stage 1. */
  guards?: Record<string, { pass: boolean; value: number }>;
}

/** Computed paper-trade metrics that feed the Stage-2 gate. */
export interface PaperGateMetrics {
  tradeCount: number;
  /** Average R per trade (same unit as backtest expectancy). */
  expectancy: number;
  /**
   * Annualized Sharpe — `perTradeIR × √(tradesPerYear)` — on the SAME time
   * basis as the Stage-1 backtest Sharpe, so the `paper.minSharpe = 0.8`
   * threshold is a like-for-like (mildly relaxed) sibling of Stage-1's 1.0.
   * Per-trade IR is `mean(R) / stdev(R)`; `tradesPerYear` is derived from the
   * ledger's open/close timestamps (see {@link computePaperGateMetrics}).
   *
   * `null` when the Sharpe cannot be credibly annualized — fewer than 2 valid-R
   * trades, no usable open/close timestamps, a zero-variance R series, or a
   * span shorter than {@link MIN_PAPER_SHARPE_YEARS_SPAN}. A `null` Sharpe is
   * treated as a hard Stage-2 *fail* (unverified), never a pass — see
   * {@link evaluatePaperGate}. This guard stops a near-zero span from minting a
   * fake pass via the √ blow-up.
   */
  sharpe: number | null;
  profitFactor: number;
  /**
   * Realized ÷ modeled slippage over trades that carry both figures, or `null`
   * when no trade in the sample recorded modeled slippage (the ledger has not
   * been instrumented for it yet). A `null` ratio is treated as *unverified*
   * (advisory) rather than a hard fail — see {@link evaluatePaperGate}.
   */
  slippageRatio: number | null;
  /** Trades that carried both realized and modeled slippage (slippage sample size). */
  slippageSampleSize: number;
}

/**
 * Minimal per-trade shape consumed when computing paper metrics. Structurally
 * compatible with `@trading-app/shared` `Position` (closed paper trades), so
 * the service can pass `closedPositions` straight through.
 */
export interface PromotionTradeSample {
  /** Net realized PnL in account currency. Required; trades without it are ignored. */
  pnl?: number;
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  /** Per-trade realized slippage cost (account currency), if instrumented. */
  realizedSlippage?: number;
  /** Per-trade modeled slippage cost (account currency), if instrumented. */
  modeledSlippage?: number;
  /** Epoch ms the trade was opened. Used to derive the ledger span for annualizing Sharpe. */
  openedAt?: number;
  /** Epoch ms the trade was closed. Used to derive the ledger span for annualizing Sharpe. */
  closedAt?: number;
}

// ── Metric computation (from data) ───────────────────────────────────────────

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Profit factor capped to a JSON-safe finite value. Backtest/paper reports
 * with zero gross loss would otherwise be `Infinity` (not representable in
 * JSON); we clamp to {@link PROFIT_FACTOR_CAP} which is far above any
 * threshold so the gate still passes.
 */
export const PROFIT_FACTOR_CAP = 999;

/** Milliseconds in one year — same basis the backtest runner uses for annualization. */
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1_000;

/**
 * Minimum ledger span (in years) required to credibly annualize the paper
 * Sharpe. ~0.02y ≈ 5 trading days. Below this, `tradesPerYear` (and thus the
 * √ annualization factor) blows up off a near-zero denominator and would mint a
 * fake pass, so the Sharpe is reported as `null` (unverified) instead.
 */
export const MIN_PAPER_SHARPE_YEARS_SPAN = 0.02;

/**
 * Compute the Stage-2 paper metrics from a closed-trade ledger. R per trade is
 * `pnl / (|entryPrice − stopLoss| × quantity)` — the same risk-unit definition
 * the backtest runner uses for `tradeRs` — so paper expectancy is directly
 * comparable to backtest expectancy. Trades missing `pnl` or with a zero/
 * undefined risk distance are excluded from the R-based metrics.
 */
export function computePaperGateMetrics(trades: readonly PromotionTradeSample[]): PaperGateMetrics {
  const rs: number[] = [];
  let grossWin = 0;
  let grossLoss = 0;
  let realizedSlip = 0;
  let modeledSlip = 0;
  let slippageSampleSize = 0;
  // Span of the valid-R trades, from earliest open to latest close, used to
  // derive trades-per-year for annualizing the Sharpe.
  let firstOpenedAt = Infinity;
  let lastClosedAt = -Infinity;

  for (const t of trades) {
    if (typeof t.pnl !== 'number' || !Number.isFinite(t.pnl)) continue;
    if (t.pnl >= 0) grossWin += t.pnl;
    else grossLoss += -t.pnl;

    const riskDistance = Math.abs(t.entryPrice - t.stopLoss);
    const riskAmount = riskDistance * t.quantity;
    if (riskAmount > 0 && Number.isFinite(riskAmount)) {
      rs.push(t.pnl / riskAmount);
      if (typeof t.openedAt === 'number' && Number.isFinite(t.openedAt) && t.openedAt < firstOpenedAt)
        firstOpenedAt = t.openedAt;
      if (typeof t.closedAt === 'number' && Number.isFinite(t.closedAt) && t.closedAt > lastClosedAt)
        lastClosedAt = t.closedAt;
    }

    if (typeof t.realizedSlippage === 'number' && typeof t.modeledSlippage === 'number') {
      realizedSlip += Math.abs(t.realizedSlippage);
      modeledSlip += Math.abs(t.modeledSlippage);
      slippageSampleSize += 1;
    }
  }

  const expectancy = rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  const sd = stdev(rs);
  // Per-trade information ratio, then annualized to the backtest's time basis so
  // the 0.8 threshold reads as a standard annualized Sharpe. Guarded: with < 2
  // valid-R trades, zero variance, no usable timestamps, or a span shorter than
  // MIN_PAPER_SHARPE_YEARS_SPAN, the Sharpe is unverified (`null`) — a fail, not
  // a √-blow-up pass.
  let sharpe: number | null = null;
  if (rs.length >= 2 && sd > 0 && Number.isFinite(firstOpenedAt) && Number.isFinite(lastClosedAt)) {
    const yearsSpan = (lastClosedAt - firstOpenedAt) / MS_PER_YEAR;
    if (yearsSpan >= MIN_PAPER_SHARPE_YEARS_SPAN) {
      const perTradeIR = expectancy / sd;
      const tradesPerYear = rs.length / yearsSpan;
      sharpe = perTradeIR * Math.sqrt(tradesPerYear);
    }
  }
  const profitFactor =
    grossLoss > 0 ? Math.min(grossWin / grossLoss, PROFIT_FACTOR_CAP) : grossWin > 0 ? PROFIT_FACTOR_CAP : 0;
  const slippageRatio = slippageSampleSize > 0 && modeledSlip > 0 ? realizedSlip / modeledSlip : null;

  return {
    // The hard "≥ N monitored paper trades" count is the number of recorded
    // trades, not just those that yielded a valid R — a trade with a missing
    // risk distance is still a monitored trade for the count threshold.
    tradeCount: trades.filter(t => typeof t.pnl === 'number' && Number.isFinite(t.pnl)).length,
    expectancy,
    sharpe,
    profitFactor,
    slippageRatio,
    slippageSampleSize,
  };
}

// ── Per-stage evaluation ─────────────────────────────────────────────────────

/** Outcome of evaluating one stage: pass/fail plus the human-readable reasons it failed. */
export interface StageEvaluation {
  state: PromotionStageState;
  /** Empty when `state === 'pass'`. Each entry names the threshold that was not met. */
  failedChecks: string[];
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * Stage 1 — backtest gate. `metrics === null` means no backtest report is
 * registered for the strategy → `missing`.
 *
 * TRA-541: when a TRA-540 optimization `verdict` is registered (passed as
 * `verdict`), the six-guard verdict IS the gate — the leg passes iff
 * `verdict.pass === true`, regardless of how strong the raw `metrics` look.
 * A `verdict.pass === false` therefore fails Stage 1 even when every metric
 * threshold is cleared.
 *
 * TRA-542 — **fail-closed**: a registered TRA-540 verdict is now *required* to
 * clear Stage 1. When `metrics` are registered but no verdict accompanies them
 * (the legacy `POST /api/promotion/backtest` path, or any report ingested before
 * the optimization harness was run), the leg **fails** rather than falling back
 * to the raw-metric thresholds. Strong headline numbers can no longer mint a
 * Stage-1 pass on their own — the six-guard overfitting battery is the gate, and
 * an unrun (absent) battery is treated as a hard block, never a silent pass.
 * This closes the hole where a strategy with no overfitting verification could
 * still be flipped live. The raw `metrics` are still surfaced on
 * `promotion_status` for context, but they no longer constitute a pass path.
 *
 * The `thresholds` parameter is retained for signature stability (and is still
 * consulted by the Stage-2 paper gate); Stage 1 no longer reads its `backtest`
 * thresholds because the verdict supersedes them.
 */
export function evaluateBacktestGate(
  metrics: BacktestGateMetrics | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS,
  verdict?: BacktestGateVerdict | null,
): StageEvaluation {
  if (!metrics) return { state: 'missing', failedChecks: ['no backtest report registered'] };
  if (!verdict) {
    // TRA-542 fail-closed: no overfitting verdict on record → refuse Stage 1.
    return {
      state: 'fail',
      failedChecks: [
        'no TRA-540 optimization verdict registered — Stage 1 is fail-closed and requires a '
          + 'passing six-guard overfitting verdict (run the TRA-540 harness and register it via '
          + 'POST /api/promotion/optimization)',
      ],
    };
  }
  if (!verdict.pass) {
    const failedGuards = verdict.guards
      ? Object.entries(verdict.guards)
          .filter(([, g]) => !g.pass)
          .map(([id]) => id)
      : [];
    return {
      state: 'fail',
      failedChecks: [
        `optimization verdict FAIL — TRA-540 six-guard overfitting battery not all green`
          + (failedGuards.length ? ` (failed: ${failedGuards.join(', ')})` : ''),
      ],
    };
  }
  // All six guards green: the strategy is robustly OOS-validated. The verdict
  // is authoritative for Stage 1 — it supersedes the raw-metric thresholds.
  return { state: 'pass', failedChecks: [] };
}

/**
 * Stage 2 — paper gate. `paper === null` means no paper metrics could be
 * computed (no monitored paper trades) → `missing`. The expectancy-vs-backtest
 * ratio check is skipped when backtest expectancy is unavailable (Stage 1 not
 * registered) since there is nothing to compare against; that case is already
 * blocked by Stage 1 being `missing`.
 *
 * Slippage is advisory: a `null` ratio (ledger not instrumented for modeled
 * slippage) does not fail the stage, but a ratio that exceeds the cap does.
 */
export function evaluatePaperGate(
  paper: PaperGateMetrics | null,
  backtest: BacktestGateMetrics | null,
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS,
): StageEvaluation {
  if (!paper || paper.tradeCount === 0)
    return { state: 'missing', failedChecks: ['no monitored paper trades recorded'] };
  const t = thresholds.paper;
  const failed: string[] = [];
  if (!(paper.tradeCount >= t.minTradeCount))
    failed.push(`paper trade count ${fmt(paper.tradeCount)} < ${t.minTradeCount}`);
  if (!(paper.expectancy > t.minExpectancy))
    failed.push(`paper expectancy ${fmt(paper.expectancy)} not > ${t.minExpectancy}`);
  if (backtest && backtest.expectancy > 0) {
    const floor = t.minExpectancyVsBacktestRatio * backtest.expectancy;
    if (!(paper.expectancy >= floor))
      failed.push(
        `paper expectancy ${fmt(paper.expectancy)} < ${fmt(t.minExpectancyVsBacktestRatio)}× backtest (${fmt(floor)}) — overfit signal`,
      );
  }
  if (paper.sharpe === null)
    failed.push(
      'paper Sharpe unverified — too few valid-R trades or too short a span to annualize (need ≥2 trades over ≥~5 trading days)',
    );
  else if (!(paper.sharpe >= t.minSharpe)) failed.push(`paper Sharpe ${fmt(paper.sharpe)} < ${t.minSharpe}`);
  if (paper.slippageRatio !== null && !(paper.slippageRatio <= t.maxSlippageRatio))
    failed.push(`realized slippage ${fmt(paper.slippageRatio)}× modeled > ${t.maxSlippageRatio}×`);
  return { state: failed.length === 0 ? 'pass' : 'fail', failedChecks: failed };
}

// ── Overall verdict ──────────────────────────────────────────────────────────

/** Inputs to a full promotion evaluation for one strategy. */
export interface PromotionEvaluationInput {
  strategyId: string;
  /** Stage-1 metrics from the registered backtest report, or null if none registered. */
  backtest: BacktestGateMetrics | null;
  /**
   * TRA-541 — the registered TRA-540 optimization verdict, if any. When present
   * it is authoritative for Stage 1 (see {@link evaluateBacktestGate}).
   */
  backtestVerdict?: BacktestGateVerdict | null;
  /** Stage-2 metrics computed from the paper ledger, or null if none. */
  paper: PaperGateMetrics | null;
  /** Whether a Stage-3 sign-off (`promotion_decision`) record exists. */
  signoff: SignoffState;
  thresholds?: PromotionThresholds;
}

/**
 * Full per-stage state for a strategy, plus the overall verdict. This is the
 * `promotion_status` the spec calls for, augmented with the exact blocked
 * reasons so a refused "go live" attempt can surface which gate failed.
 */
export interface PromotionStatus {
  strategyId: string;
  backtest: {
    state: PromotionStageState;
    metrics: BacktestGateMetrics | null;
    /** TRA-541 — the optimization verdict that gated Stage 1, if one is registered. */
    verdict?: BacktestGateVerdict | null;
    failedChecks: string[];
  };
  paper: {
    state: PromotionStageState;
    tradeCount: number;
    metrics: PaperGateMetrics | null;
    failedChecks: string[];
  };
  signoff: SignoffState;
  /** True iff backtest=pass AND paper=pass AND signoff=present. */
  canGoLive: boolean;
  /** Empty when `canGoLive`. Human-readable reasons the live transition is refused. */
  blockedReasons: string[];
}

/**
 * Evaluate the full promotion gate for one strategy. The overall rule is the
 * one-liner from TRA-527: live is permitted iff
 * `backtest=pass AND paper=pass AND signoff=present`.
 */
export function evaluatePromotion(input: PromotionEvaluationInput): PromotionStatus {
  const thresholds = input.thresholds ?? DEFAULT_PROMOTION_THRESHOLDS;
  const bt = evaluateBacktestGate(input.backtest, thresholds, input.backtestVerdict);
  const paper = evaluatePaperGate(input.paper, input.backtest, thresholds);

  const blockedReasons: string[] = [];
  if (bt.state !== 'pass')
    blockedReasons.push(`Stage 1 (backtest) ${bt.state}: ${bt.failedChecks.join('; ')}`);
  if (paper.state !== 'pass')
    blockedReasons.push(`Stage 2 (paper) ${paper.state}: ${paper.failedChecks.join('; ')}`);
  if (input.signoff !== 'present') blockedReasons.push('Stage 3 (sign-off) absent: no promotion_decision on record');

  return {
    strategyId: input.strategyId,
    backtest: {
      state: bt.state,
      metrics: input.backtest,
      verdict: input.backtestVerdict ?? null,
      failedChecks: bt.failedChecks,
    },
    paper: {
      state: paper.state,
      tradeCount: input.paper?.tradeCount ?? 0,
      metrics: input.paper,
      failedChecks: paper.failedChecks,
    },
    signoff: input.signoff,
    canGoLive: blockedReasons.length === 0,
    blockedReasons,
  };
}

// ── Audit record (Stage 3) ───────────────────────────────────────────────────

/**
 * Persisted `promotion_decision` — the Stage-3 audit trail. Captures the
 * strategy, both reports' metrics that justified the decision, the reviewer,
 * the timestamp, and any threshold override + rationale. Stored append-only so
 * a future audit can reconstruct *why* a strategy was allowed live.
 */
export interface PromotionDecision {
  id: string;
  strategyId: string;
  /** ISO timestamp the decision was recorded. */
  decidedAt: string;
  /** Username of the reviewer who signed off (QuantTrader / admin). */
  reviewer: string;
  /** Snapshot of the Stage-1 metrics at sign-off time. */
  backtestMetrics: BacktestGateMetrics | null;
  /** Snapshot of the Stage-2 metrics at sign-off time. */
  paperMetrics: PaperGateMetrics | null;
  /**
   * Threshold overrides applied for this decision (loosen-only). Present only
   * when the reviewer deviated from the v1 defaults; `rationale` is then
   * required (enforced at the service layer).
   */
  thresholdOverrides?: Partial<PromotionThresholds>;
  /** Written justification — mandatory when `thresholdOverrides` is present. */
  rationale?: string;
}
