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

import type { ShadowExpectancyGuardVerdict } from './shadow-expectancy-guard.js';

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
  /** Stage 2 — paper / forward test (net). Close-based strategies only. */
  paper: {
    minTradeCount: number;
    minExpectancy: number;
    /** Paper expectancy must be ≥ this fraction × backtest expectancy. */
    minExpectancyVsBacktestRatio: number;
    minSharpe: number;
    /** Realized slippage must be ≤ this multiple of modeled slippage. */
    maxSlippageRatio: number;
  };
  /**
   * TRA-1461 — Stage 2 for `accumulate`/hold-mode strategies (e.g. crypto DCA).
   * A hold-mode strategy never closes positions by construction, so the
   * closed-trade PF/expectancy `paper` leg above can never be satisfied. This
   * leg instead validates **accumulation correctness** over a time-based paper
   * soak: enough fills built into one growing position, held long enough, with
   * no unintended sells and the fixed-stop risk invariant never breached. Same
   * anti-gaming principle as the close-based leg — every figure is computed from
   * the live paper book, never hand-entered (see {@link computeAccumulationGateMetrics}).
   */
  accumulation: {
    /** ≥ this many total accumulation fills (entry + adds) across the open book. */
    minFills: number;
    /** ≥ this many open accumulation positions being monitored. */
    minPositions: number;
    /** The accumulation must have been building for ≥ this many days (time-based soak). */
    minSoakDays: number;
    /**
     * Max tolerated closes that violated hold-mode (a held position sold by
     * anything other than its catastrophe stop). 0 → any unintended sell fails.
     */
    maxUnintendedSells: number;
  };
  /**
   * TRA-1465 — Stage 1 (backtest) for `accumulate`/hold-mode strategies (crypto
   * DCA). The close-based `backtest` leg above certifies a **per-trade timing
   * edge** survives out-of-sample via the TRA-540 six-guard overfitting battery.
   * A DCA strategy has NO per-trade timing edge by construction — its return is
   * market beta smoothed by cadence + a macro trend gate — so the six-guard
   * battery runs degenerate/meaningless on it (TRA-695 never runs `runOptimization`
   * on DCA). This leg instead certifies **accumulation robustness** on an OOS
   * window: the trend gate actually fires (non-degenerate deployment), the
   * value/invested drawdown is bounded, the accumulation beats a lump-sum
   * buy-and-hold benchmark on drawdown and/or return (DCA's structural value
   * prop), the result is robust across cadences, and fills survive a tiered
   * per-fill cost model. Same anti-gaming principle as the close-based leg — every
   * figure is computed from the OOS backtest by the harness, never hand-entered
   * (see {@link evaluateAccumulationBacktestGate}). QuantTrader ratifies the final
   * thresholds (TRA-1464); the values below are LeadDev's proposed v1 defaults.
   */
  accumulationBacktest: {
    /** OOS backtest window must span ≥ this many days (a long-horizon DCA test). */
    minOosDays: number;
    /**
     * Fraction of the OOS window in which the macro trend gate DEPLOYED capital
     * must be ≥ this floor — the gate must actually fire; a near-zero deployment
     * ratio is a degenerate strategy that never buys.
     */
    minDeploymentRatio: number;
    /**
     * …and ≤ this ceiling — the gate must also STAND DOWN sometimes. A ratio of
     * ~1.0 means the trend gate never gated anything (it is not a gate at all,
     * just unconditional buying), which is degenerate in the other direction.
     */
    maxDeploymentRatio: number;
    /** Value/invested accumulation-curve max drawdown must be ≤ this fraction. */
    maxValueInvestedDrawdownPct: number;
    /**
     * The accumulation must beat a lump-sum buy-and-hold benchmark over the same
     * OOS window on DRAWDOWN by ≥ this fraction of the lump-sum's drawdown
     * (0 → merely not worse). The benchmark check also passes on RETURN alone
     * (accumulation OOS return ≥ lump-sum return), so a strategy that gives up a
     * little drawdown for materially more return still clears — "on drawdown
     * and/or return" per the spec.
     */
    minDrawdownImprovementVsLumpSum: number;
    /**
     * Fraction of the tested cadence variants (weekly/biweekly/monthly) that must
     * be directionally consistent with the primary cadence (same sign of OOS
     * return). 1.0 → all cadences must agree; a strategy that only works on one
     * cadence is a fragile artifact, not a robust accumulation.
     */
    minCadenceConsistencyRatio: number;
    /**
     * Value/invested ratio net of the tiered per-fill cost model must be ≥ this
     * (1.0 → fills are net-positive of fees; the cost model does not eat the
     * accumulation). Guards against a strategy whose edge is entirely consumed by
     * per-fill trading costs.
     */
    minFeeAdjustedValueRatio: number;
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
  accumulation: {
    minFills: 8, // ≥ 8 fills proves "multiple fills averaging one growing position" is really running
    minPositions: 1,
    minSoakDays: 14, // a two-week forward soak, the accumulate-class analogue of the 50-trade count
    maxUnintendedSells: 0, // a hold-mode strategy must never sell outside its catastrophe stop
  },
  // TRA-1465 — proposed v1 defaults for the accumulate-class Stage-1 leg;
  // QuantTrader ratifies the final numbers via TRA-1464 (loosen-only overrides).
  accumulationBacktest: {
    minOosDays: 180, // a ~6-month OOS window — DCA's value prop shows over a horizon, the accumulate analogue of 100 trades
    minDeploymentRatio: 0.25, // the trend gate must deploy in ≥ a quarter of the window (not a dead strategy)
    maxDeploymentRatio: 0.98, // …and stand down at least sometimes (an ~always-on gate is no gate)
    maxValueInvestedDrawdownPct: 0.35, // bounded accumulation-curve drawdown (DCA smooths beta but is still long the market)
    minDrawdownImprovementVsLumpSum: 0, // must at least not be WORSE than lump-sum on drawdown (or beat it on return)
    minCadenceConsistencyRatio: 1.0, // every tested cadence must agree in direction — no single-cadence artifacts
    minFeeAdjustedValueRatio: 1.0, // fills net-positive of the tiered per-fill cost model
  },
};

// ── Strategy class (close-based vs accumulate/hold-mode) ─────────────────────

/**
 * TRA-1461 — the promotion-gate strategy class. Close-based strategies clear
 * Stage 2 on the closed-trade PF/expectancy `paper` leg; `accumulate` (hold-
 * mode) strategies never close by construction and clear Stage 2 on the
 * accumulation-correctness leg instead. Everything about Stage 1 (the six-guard
 * backtest verdict) and Stage 3 (sign-off) is identical for both classes — only
 * the Stage-2 validator differs, so close-based rigor is untouched.
 */
export type PromotionStrategyClass = 'close' | 'accumulate';

/**
 * Strategy ids whose Stage-2 leg is validated on accumulation correctness
 * rather than closed-trade metrics. `dca` is the crypto dollar-cost-averaging
 * accumulation strategy (TRA-693/698, the `crypto_core` roster) — long-only,
 * hold-mode, never closes on a take-profit. Kept as an explicit allowlist so a
 * strategy defaults to the stricter close-based leg unless deliberately marked.
 */
export const ACCUMULATE_STRATEGY_IDS: ReadonlySet<string> = new Set(['dca']);

/** Classify a strategy for the promotion gate. Unlisted ids are `close`-based. */
export function promotionStrategyClass(strategyId: string): PromotionStrategyClass {
  return ACCUMULATE_STRATEGY_IDS.has(strategyId) ? 'accumulate' : 'close';
}

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

/**
 * TRA-1461 — one monitored paper position for an `accumulate`/hold-mode
 * strategy. Structurally a subset of `@trading-app/shared` `Position` (the
 * demo DCA book), so the service passes demo positions straight through. Unlike
 * {@link PromotionTradeSample} these are NOT required to be closed — the whole
 * point is that a hold-mode accumulation stays open. `fills` is the count of
 * fills blended into the growing position (`Position.dcaFills`); `hold` is the
 * TRA-961 `dcaHold` flag; `openedAt`/`closedAt` bound the soak.
 */
export interface AccumulationPositionSample {
  /** 'buy' for a long accumulation (the only legal DCA side); 'sell' would be a spec breach. */
  side: 'buy' | 'sell';
  /** Blended average cost basis (`Position.entryPrice` after all fills). */
  entryPrice: number;
  /** Fixed protective (catastrophe) stop — never widened through entry by the add path. */
  stopLoss: number;
  /** Current total accumulated quantity. */
  quantity: number;
  /** Fills blended into this position (entry + adds). Defaults to 1 when absent. */
  fills?: number;
  /** True when this is a held DCA accumulation (per-leg TP suppressed). */
  hold?: boolean;
  /** Epoch ms the position was first opened (first fill). Bounds the soak. */
  openedAt?: number;
  /** Epoch ms the position closed, if it has. Open accumulations leave this absent. */
  closedAt?: number;
  /**
   * Lifecycle path that closed the position, if closed. `'sl'` is the legitimate
   * catastrophe-stop exit for a hold-mode strategy; any other reason on a held
   * position is an unintended sell.
   */
  exitReason?: string;
}

/**
 * TRA-1461 — computed accumulation metrics that feed the Stage-2 gate for
 * `accumulate`/hold-mode strategies. All derived from the live paper book by
 * {@link computeAccumulationGateMetrics}, never hand-entered.
 */
export interface AccumulationGateMetrics {
  /** Open accumulation positions being monitored. */
  positionCount: number;
  /** Total fills (entry + adds) across the open positions — the accumulation activity. */
  totalFills: number;
  /** Days from the earliest open position's first fill to now (the soak length). */
  soakDays: number;
  /**
   * Closes that violated hold-mode: a held position exited by anything other
   * than its catastrophe stop (`exitReason !== 'sl'`). Must be 0.
   */
  unintendedSells: number;
  /**
   * Open positions whose fixed-stop risk invariant is broken — not a long, or
   * the stop is at/above the blended entry (a widened/through-entry stop), or a
   * non-positive quantity. Must be 0: the add path averages size, never the stop.
   */
  riskInvariantBreaches: number;
}

/**
 * TRA-1465 — Stage-1 accumulation-backtest metrics for an `accumulate`/hold-mode
 * strategy, computed by the TRA-695 harness on an out-of-sample window and
 * ingested 1:1 by the gate (never hand-entered — the anti-gaming principle of
 * TRA-527 §3). These certify **accumulation robustness**, not a per-trade timing
 * edge (which DCA does not have by construction), so they are the accumulate-
 * class analogue of the close-based {@link BacktestGateMetrics} + six-guard
 * {@link BacktestGateVerdict}. Judged by {@link evaluateAccumulationBacktestGate}.
 */
export interface AccumulationBacktestGateMetrics {
  /** Length of the OOS backtest window, in days. */
  oosDays: number;
  /**
   * Fraction (0..1) of the OOS window in which the macro trend gate deployed
   * capital. Degenerate at 0 (never buys) and at 1 (never gates — unconditional
   * buying); a healthy trend-gated DCA sits between the floor and the ceiling.
   */
  deploymentRatio: number;
  /** Fractional max drawdown of the value/invested accumulation curve (the DCA-appropriate DD). */
  valueInvestedMaxDrawdown: number;
  /** Fractional max drawdown of a lump-sum buy-and-hold over the SAME OOS window (the benchmark). */
  lumpSumMaxDrawdown: number;
  /** Total return of the accumulation over the OOS window (value/invested − 1). */
  oosReturn: number;
  /** Total return of the lump-sum buy-and-hold benchmark over the same window. */
  lumpSumReturn: number;
  /** Cadence variants tested (e.g. weekly/biweekly/monthly → 3). */
  cadenceVariantsTested: number;
  /**
   * Of the tested cadences, how many were directionally consistent with the
   * primary cadence (same sign of OOS return). Equal to `cadenceVariantsTested`
   * when every cadence agrees.
   */
  cadenceVariantsConsistent: number;
  /** Value/invested ratio net of the tiered per-fill cost model (>1 ⇒ fills net-positive of fees). */
  feeAdjustedValueRatio: number;
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

/** Milliseconds in one day — used to measure the accumulation paper soak. */
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

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

/**
 * TRA-1461 — compute the Stage-2 accumulation metrics for a hold-mode strategy
 * from its monitored paper book. `nowMs` is the wall-clock the soak is measured
 * against (the caller passes `Date.now()`), kept as a parameter so this stays a
 * pure function. Open positions (no `closedAt`) drive the count/fills/soak/
 * risk-invariant; closed positions are inspected only to count hold-mode
 * violations (a held position that sold outside its catastrophe stop).
 */
export function computeAccumulationGateMetrics(
  positions: readonly AccumulationPositionSample[],
  nowMs: number,
): AccumulationGateMetrics {
  let positionCount = 0;
  let totalFills = 0;
  let earliestOpenedAt = Infinity;
  let riskInvariantBreaches = 0;
  let unintendedSells = 0;

  for (const p of positions) {
    const isOpen = p.closedAt === undefined;
    if (isOpen) {
      positionCount += 1;
      totalFills += Math.max(1, p.fills ?? 1);
      if (typeof p.openedAt === 'number' && Number.isFinite(p.openedAt) && p.openedAt < earliestOpenedAt) {
        earliestOpenedAt = p.openedAt;
      }
      // Long-only, positive size, and a stop strictly below the blended entry —
      // the "average size, never the stop" invariant. Anything else is a breach.
      const wellFormed =
        p.side === 'buy' && p.quantity > 0 && Number.isFinite(p.entryPrice) && p.stopLoss < p.entryPrice;
      if (!wellFormed) riskInvariantBreaches += 1;
    } else if (p.hold === true && p.exitReason !== 'sl') {
      // A held accumulation that closed by anything other than the catastrophe
      // stop is an unintended sell (the hold semantics were not honored).
      unintendedSells += 1;
    }
  }

  const soakDays =
    positionCount > 0 && Number.isFinite(earliestOpenedAt)
      ? Math.max(0, (nowMs - earliestOpenedAt) / MS_PER_DAY)
      : 0;

  return { positionCount, totalFills, soakDays, unintendedSells, riskInvariantBreaches };
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
 * TRA-1465 — Stage 1 for `accumulate`/hold-mode strategies. `metrics === null`
 * means no accumulation-backtest verdict is registered for the strategy →
 * `missing` (the accumulate analogue of the close-based Stage-1 `missing`). This
 * mirrors the TRA-1461 Stage-2 pattern: the leg thresholds accumulation-
 * robustness metrics directly (deriving pass from the data), rather than trusting
 * a hand-entered `pass`. It is deliberately independent of PF/expectancy/Sharpe
 * and of the six-guard overfitting battery — DCA has no per-trade timing edge to
 * validate — so it certifies what an accumulation actually produces: a firing-but-
 * not-degenerate trend gate, a bounded value/invested drawdown, an edge over
 * lump-sum buy-and-hold, cadence robustness, and per-fill cost survival.
 *
 * The close-based {@link evaluateBacktestGate} (the full six-guard battery) is
 * untouched, so close-based strategies keep their timing-alpha rigor; and because
 * {@link evaluatePromotion} branches Stage 1 on `strategyClass`, a six-guard
 * verdict can never clear an accumulate Stage 1 nor vice-versa. The gate can still
 * render a genuine accumulate NO-GO (degenerate deployment, unbounded DD, loses to
 * lump-sum on both axes, single-cadence artifact, or fees eating the edge).
 */
export function evaluateAccumulationBacktestGate(
  metrics: AccumulationBacktestGateMetrics | null,
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS,
): StageEvaluation {
  if (!metrics)
    return { state: 'missing', failedChecks: ['no accumulation-backtest verdict registered'] };
  const t = thresholds.accumulationBacktest;
  const failed: string[] = [];

  if (!(metrics.oosDays >= t.minOosDays))
    failed.push(`OOS window ${fmt(metrics.oosDays)}d < ${t.minOosDays}d`);

  if (!(metrics.deploymentRatio >= t.minDeploymentRatio))
    failed.push(
      `deployment ratio ${fmt(metrics.deploymentRatio)} < ${fmt(t.minDeploymentRatio)} — trend gate barely fires (degenerate)`,
    );
  else if (!(metrics.deploymentRatio <= t.maxDeploymentRatio))
    failed.push(
      `deployment ratio ${fmt(metrics.deploymentRatio)} > ${fmt(t.maxDeploymentRatio)} — trend gate never stands down (not a gate)`,
    );

  if (!(metrics.valueInvestedMaxDrawdown <= t.maxValueInvestedDrawdownPct))
    failed.push(
      `value/invested drawdown ${fmt(metrics.valueInvestedMaxDrawdown)} > ${fmt(t.maxValueInvestedDrawdownPct)}`,
    );

  // Beats a lump-sum buy-and-hold benchmark on DRAWDOWN by ≥ the required
  // fraction of the lump-sum's drawdown, OR on RETURN alone. `ddImprovement` is
  // the fractional reduction in max drawdown vs lump-sum; when the lump-sum had
  // no drawdown it is 1 iff the accumulation also had none, else 0 (can't beat a
  // zero-DD benchmark on drawdown → must win on return).
  const ddImprovement =
    metrics.lumpSumMaxDrawdown > 0
      ? (metrics.lumpSumMaxDrawdown - metrics.valueInvestedMaxDrawdown) / metrics.lumpSumMaxDrawdown
      : metrics.valueInvestedMaxDrawdown <= 0
        ? 1
        : 0;
  const beatsOnDrawdown = ddImprovement >= t.minDrawdownImprovementVsLumpSum;
  const beatsOnReturn = metrics.oosReturn >= metrics.lumpSumReturn;
  if (!beatsOnDrawdown && !beatsOnReturn)
    failed.push(
      `loses to lump-sum buy-and-hold on both drawdown (Δ ${fmt(ddImprovement)} < ${fmt(t.minDrawdownImprovementVsLumpSum)}) `
        + `and return (${fmt(metrics.oosReturn)} < ${fmt(metrics.lumpSumReturn)})`,
    );

  const cadenceRatio =
    metrics.cadenceVariantsTested > 0 ? metrics.cadenceVariantsConsistent / metrics.cadenceVariantsTested : 0;
  if (!(cadenceRatio >= t.minCadenceConsistencyRatio))
    failed.push(
      `cadence consistency ${fmt(metrics.cadenceVariantsConsistent)}/${fmt(metrics.cadenceVariantsTested)} `
        + `(${fmt(cadenceRatio)}) < ${fmt(t.minCadenceConsistencyRatio)} — not robust across cadences`,
    );

  if (!(metrics.feeAdjustedValueRatio >= t.minFeeAdjustedValueRatio))
    failed.push(
      `fee-adjusted value ratio ${fmt(metrics.feeAdjustedValueRatio)} < ${fmt(t.minFeeAdjustedValueRatio)} — per-fill costs eat the accumulation`,
    );

  return { state: failed.length === 0 ? 'pass' : 'fail', failedChecks: failed };
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

/**
 * TRA-1461 — Stage 2 for `accumulate`/hold-mode strategies. `metrics === null`
 * or zero open positions ⇒ `missing` (no monitored accumulation yet), mirroring
 * the close-based `missing` case. Otherwise the leg passes iff the accumulation
 * has built enough fills across enough positions, soaked long enough, sold
 * nothing it shouldn't have, and never breached the fixed-stop risk invariant.
 *
 * This is deliberately independent of PF/expectancy: a hold-mode strategy never
 * realizes closed-trade P&L during the soak, so the validation is that the
 * position-building itself matches spec — the same rigor, applied to what an
 * accumulation actually produces. The close-based {@link evaluatePaperGate} is
 * untouched, so close-based strategies keep their full PF/expectancy/Sharpe/
 * slippage battery.
 */
export function evaluateAccumulationGate(
  metrics: AccumulationGateMetrics | null,
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS,
): StageEvaluation {
  if (!metrics || metrics.positionCount === 0)
    return { state: 'missing', failedChecks: ['no monitored accumulation positions recorded'] };
  const t = thresholds.accumulation;
  const failed: string[] = [];
  if (!(metrics.positionCount >= t.minPositions))
    failed.push(`accumulation positions ${fmt(metrics.positionCount)} < ${t.minPositions}`);
  if (!(metrics.totalFills >= t.minFills))
    failed.push(`accumulation fills ${fmt(metrics.totalFills)} < ${t.minFills}`);
  if (!(metrics.soakDays >= t.minSoakDays))
    failed.push(`paper soak ${fmt(metrics.soakDays)}d < ${t.minSoakDays}d`);
  if (metrics.unintendedSells > t.maxUnintendedSells)
    failed.push(
      `${fmt(metrics.unintendedSells)} unintended sell(s) — a hold-mode strategy must only exit on its catastrophe stop`,
    );
  if (metrics.riskInvariantBreaches > 0)
    failed.push(
      `${fmt(metrics.riskInvariantBreaches)} position(s) breach the fixed-stop risk invariant (long-only, stop below blended entry)`,
    );
  return { state: failed.length === 0 ? 'pass' : 'fail', failedChecks: failed };
}

// ── Overall verdict ──────────────────────────────────────────────────────────

/** Inputs to a full promotion evaluation for one strategy. */
export interface PromotionEvaluationInput {
  strategyId: string;
  /**
   * TRA-1461 — the strategy class. `close` (default) runs the closed-trade
   * Stage-2 `paper` leg; `accumulate` runs the accumulation-correctness leg on
   * `accumulation` instead. Absent ⇒ `close` (back-compat: every existing caller
   * that omits it keeps the exact close-based behavior).
   */
  strategyClass?: PromotionStrategyClass;
  /** Stage-1 metrics from the registered backtest report, or null if none registered. Close-based only. */
  backtest: BacktestGateMetrics | null;
  /**
   * TRA-541 — the registered TRA-540 optimization verdict, if any. When present
   * it is authoritative for Stage 1 (see {@link evaluateBacktestGate}). Close-based only.
   */
  backtestVerdict?: BacktestGateVerdict | null;
  /**
   * TRA-1465 — Stage-1 accumulation-backtest metrics for an `accumulate`
   * strategy, computed by the TRA-695 harness on an OOS window, or null if none
   * registered. Ignored for `close` strategies (which use `backtest` +
   * `backtestVerdict`); it is the ONLY Stage-1 source consulted for an
   * `accumulate` strategy, so a six-guard verdict can never clear it.
   */
  accumulationBacktest?: AccumulationBacktestGateMetrics | null;
  /** Stage-2 metrics computed from the paper ledger, or null if none. Close-based only. */
  paper: PaperGateMetrics | null;
  /**
   * TRA-1461 — Stage-2 accumulation metrics for an `accumulate` strategy,
   * computed from the demo book, or null if none. Ignored for `close` strategies.
   */
  accumulation?: AccumulationGateMetrics | null;
  /** Whether a Stage-3 sign-off (`promotion_decision`) record exists. */
  signoff: SignoffState;
  thresholds?: PromotionThresholds;
  /**
   * TRA-2036 — the shadow-expectancy guard verdict for this strategy, if the
   * guard is wired in (its server flag is on). Computed by
   * `evaluateShadowExpectancyGuard` over the strategy's cost-netted shadow
   * sample. Absent/null when the guard is off — then it is a pure no-op and the
   * gate behaves exactly as before. When present it is always surfaced on
   * `promotion_status`; it only contributes a `blockedReason` when it is
   * ENFORCING and `wouldBlock` (i.e. `verdict.blocks === true`). In observe-only
   * mode it reports "would block: yes/no" without blocking.
   */
  shadowExpectancy?: ShadowExpectancyGuardVerdict | null;
}

/**
 * Full per-stage state for a strategy, plus the overall verdict. This is the
 * `promotion_status` the spec calls for, augmented with the exact blocked
 * reasons so a refused "go live" attempt can surface which gate failed.
 */
export interface PromotionStatus {
  strategyId: string;
  /** TRA-1461 — which Stage-2 leg was applied (`close` PF/expectancy vs `accumulate`). */
  strategyClass: PromotionStrategyClass;
  backtest: {
    state: PromotionStageState;
    metrics: BacktestGateMetrics | null;
    /** TRA-541 — the optimization verdict that gated Stage 1, if one is registered. Close-based only. */
    verdict?: BacktestGateVerdict | null;
    /**
     * TRA-1465 — accumulation-backtest metrics when `strategyClass === 'accumulate'`
     * (the Stage-1 leg that gated an accumulate strategy). Null/absent for
     * close-based strategies, which use `metrics`/`verdict` above.
     */
    accumulationBacktest?: AccumulationBacktestGateMetrics | null;
    failedChecks: string[];
  };
  paper: {
    state: PromotionStageState;
    tradeCount: number;
    metrics: PaperGateMetrics | null;
    /**
     * TRA-1461 — accumulation metrics when `strategyClass === 'accumulate'`
     * (the Stage-2 leg that gated an accumulate strategy). Null/absent for
     * close-based strategies, which use `metrics`/`tradeCount` above.
     */
    accumulation?: AccumulationGateMetrics | null;
    failedChecks: string[];
  };
  signoff: SignoffState;
  /**
   * TRA-2036 — the shadow-expectancy guard verdict, when the guard is wired in.
   * Always surfaced on the readout (so the observe-only "would block: yes/no"
   * per candidate is visible), but only affects `canGoLive` when it is enforcing
   * (`blocks === true`). Absent when the guard flag is off.
   */
  shadowExpectancy?: ShadowExpectancyGuardVerdict | null;
  /** True iff backtest=pass AND stage-2=pass AND signoff=present. */
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
  const strategyClass: PromotionStrategyClass = input.strategyClass ?? 'close';

  // TRA-1465 — Stage 1 is class-aware: `accumulate` strategies (hold-mode DCA)
  // validate on accumulation robustness over an OOS window (they have no per-
  // trade timing edge for the six-guard battery to certify); everyone else keeps
  // the close-based six-guard backtest leg untouched. Reading ONLY the class's
  // own Stage-1 source makes it impossible to clear an accumulate Stage 1 with a
  // timing verdict, or a close Stage 1 with an accumulation verdict.
  const accumulationBacktest = strategyClass === 'accumulate' ? input.accumulationBacktest ?? null : null;
  const bt =
    strategyClass === 'accumulate'
      ? evaluateAccumulationBacktestGate(accumulationBacktest, thresholds)
      : evaluateBacktestGate(input.backtest, thresholds, input.backtestVerdict);
  const stage1Label = strategyClass === 'accumulate' ? 'accumulation backtest' : 'backtest';

  // TRA-1461 — Stage 2 is class-aware: `accumulate` strategies validate on
  // accumulation correctness; everyone else keeps the closed-trade PF/expectancy
  // leg untouched.
  const accumulation = strategyClass === 'accumulate' ? input.accumulation ?? null : null;
  const stage2 =
    strategyClass === 'accumulate'
      ? evaluateAccumulationGate(accumulation, thresholds)
      : evaluatePaperGate(input.paper, input.backtest, thresholds);
  const stage2Label = strategyClass === 'accumulate' ? 'accumulation' : 'paper';

  const blockedReasons: string[] = [];
  if (bt.state !== 'pass')
    blockedReasons.push(`Stage 1 (${stage1Label}) ${bt.state}: ${bt.failedChecks.join('; ')}`);
  if (stage2.state !== 'pass')
    blockedReasons.push(`Stage 2 (${stage2Label}) ${stage2.state}: ${stage2.failedChecks.join('; ')}`);
  if (input.signoff !== 'present') blockedReasons.push('Stage 3 (sign-off) absent: no promotion_decision on record');

  // TRA-2036 — shadow-expectancy guard. Only an ENFORCING would-block
  // (`blocks === true`) contributes a blocked reason; an observe-only verdict is
  // surfaced below but never blocks. When the guard is off (`shadowExpectancy`
  // absent) this is a no-op and the gate is unchanged.
  const shadowExpectancy = input.shadowExpectancy ?? null;
  if (shadowExpectancy?.blocks) {
    blockedReasons.push(
      `Shadow-expectancy guard BLOCK (net E[R] ${fmt(shadowExpectancy.expectancyR)}, `
        + `effN ${fmt(shadowExpectancy.effectiveN)}/${shadowExpectancy.rawN}): `
        + shadowExpectancy.reasons.join('; '),
    );
  }

  return {
    strategyId: input.strategyId,
    strategyClass,
    backtest: {
      state: bt.state,
      metrics: strategyClass === 'accumulate' ? null : input.backtest,
      verdict: strategyClass === 'accumulate' ? null : input.backtestVerdict ?? null,
      accumulationBacktest,
      failedChecks: bt.failedChecks,
    },
    paper: {
      state: stage2.state,
      tradeCount: input.paper?.tradeCount ?? 0,
      metrics: strategyClass === 'accumulate' ? null : input.paper,
      accumulation,
      failedChecks: stage2.failedChecks,
    },
    signoff: input.signoff,
    shadowExpectancy,
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
