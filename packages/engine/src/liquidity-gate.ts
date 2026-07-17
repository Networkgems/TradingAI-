// TRA-1967 — PRE-TRADE LIQUIDITY GATE (pure evaluator).
//
// CEO roadmap NEXT (TRA-1964): "read order flow / liquidity" and trade "fast and
// accurate". Today execution charges a STATIC per-symbol bps tier table
// (packages/engine/src/cost/index.ts) and reprices with a maker-walk ladder
// (tradier-smart-open.ts). Neither PREDICTS fill quality from the book that is
// actually in front of the order at signal time. This module is that prediction:
// given the L1 quote (bid/ask, and — when available — the notional resting at the
// touch), it computes the estimated spread cost + a naive impact term and returns
// a verdict that can VETO a fill in a pathologically wide book or DOWNSIZE it when
// the order is large relative to the displayed depth.
//
// This module is PURE and side-effect free — it knows nothing about flags,
// ledgers, engines, or capital. The SHADOW-FIRST recording and the
// ENABLE_PRE_TRADE_LIQUIDITY_GATE kill switch live in the server-side ledger that
// consumes it (packages/server/src/pre-trade-liquidity-ledger.ts), exactly as the
// universal pre-trade gate (TRA-1457) splits pure rule from wired ledger. Keeping
// the model here means the unit tests below pin the exact allow/downsize/veto
// boundary independent of any wiring, and both the live equity and options paths
// share one verbatim cost model rather than re-deriving impact math per call site.
//
// ── The model (naive on purpose — no L2 / market-maker fantasy, per the DoD) ───
//   spreadCostBps — the cost of crossing HALF the quoted spread from the mid to
//     the side's touch. For a BUY that is (ask − mid)/mid; for a SELL (mid − bid)/
//     mid. Mid is the midpoint, so the two are equal — but the term uses the side's
//     ACTUAL touch, not a nominal fixed spread, so a skewed or one-sided book is
//     charged what it really costs. Size-independent — no downsize can shrink it.
//   impactBps — a linear "naive impact": impactCoeffBps × (orderNotional /
//     depthNotional), where depthNotional is the notional resting at the touch
//     (askSize×ask for a buy, bidSize×bid for a sell). An order equal to the whole
//     displayed touch is charged `impactCoeffBps`. Linear, not square-root: the DoD
//     asked for "naive impact", and with only L1 depth a convex model would be
//     false precision. When depth is unknown the impact term is UNMEASURED (null),
//     and the gate degrades to a spread-only decision (impactMeasured=false).
//   totalCostBps = spreadCostBps + impactBps.
//
// ── The verdict ────────────────────────────────────────────────────────────────
//   The spread cost is a floor no sizing can beat, so if it ALONE exceeds
//   `maxCostBps` the book is too wide → VETO (SPREAD_TOO_WIDE). Otherwise the
//   remaining budget (maxCostBps − spreadCostBps) is the impact allowance; the
//   largest notional that fits it is `depthNotional × budget / impactCoeffBps`.
//   sizeFactor = min(1, maxNotional / orderNotional): ≥ 1 → ALLOW; in
//   [minDownsizeFactor, 1) → DOWNSIZE to that fraction; below the floor → VETO
//   (THIN_BOOK_VETO), because a fill that small isn't worth the slippage it still
//   eats. An unusable quote (non-finite, crossed, non-positive mid) → VETO
//   (UNUSABLE_QUOTE): we refuse to predict a fill against a dead book.

/** Order side, in the terms L1 quotes use (which touch the order crosses). */
export type LiquiditySide = 'buy' | 'sell';

/**
 * The five verdict reasons. An ALLOW returns an empty `reasons[]`; a downsize or
 * veto names WHY so the shadow ledger can attribute the decision per reason.
 */
export type LiquidityGateReason =
  /** Quote was non-finite, crossed (ask < bid), or had a non-positive mid. */
  | 'UNUSABLE_QUOTE'
  /** Spread cost alone exceeds `maxCostBps` — no downsize can help. */
  | 'SPREAD_TOO_WIDE'
  /** Order is large vs displayed depth; filled fraction cut to stay under budget. */
  | 'THIN_BOOK_DOWNSIZE'
  /** Even the minimum downsize fraction can't clear the cost budget → vetoed. */
  | 'THIN_BOOK_VETO';

/**
 * Tunable cuts. These are SHADOW-CALIBRATION SEEDS, not tuned live thresholds —
 * the gate is flag-off / shadow-first, so the point of the first cut is to record
 * what the model WOULD have done and let the realized-slippage KPI (TRA-1967
 * item 2) calibrate them per asset class before any live veto is armed.
 */
export interface LiquidityGateConfig {
  /**
   * Total modeled cost (spread + impact, bps) above which the order is not allowed
   * at full size. Default 50 bps (0.5%). Below it → allow; above it → downsize
   * toward it, or veto when even the floor size can't reach it.
   */
  maxCostBps: number;
  /**
   * Linear impact coefficient (bps) charged when the order equals the entire
   * notional resting at the touch. Default 100 bps. impactBps scales linearly with
   * orderNotional / depthNotional.
   */
  impactCoeffBps: number;
  /**
   * Smallest fill fraction worth taking. A computed size factor below this vetoes
   * rather than downsizing to a token fill. Default 0.25.
   */
  minDownsizeFactor: number;
}

export const DEFAULT_LIQUIDITY_GATE_CONFIG: LiquidityGateConfig = {
  maxCostBps: 50,
  impactCoeffBps: 100,
  minDownsizeFactor: 0.25,
};

/**
 * One order to evaluate against the book in front of it. `bid`/`ask` are the L1
 * touch; `bidSize`/`askSize` are the displayed sizes at those touches (shares /
 * contracts) and are OPTIONAL — when the feed gives no size the impact term is
 * left unmeasured and the gate falls back to a spread-only decision.
 */
export interface LiquidityGateInput {
  side: LiquiditySide;
  /** L1 best bid price. */
  bid: number;
  /** L1 best ask price. */
  ask: number;
  /** Intended fill size in the instrument's native units (shares / contracts×100). */
  orderQty: number;
  /** Displayed size at the best bid (native units). Optional. */
  bidSize?: number;
  /** Displayed size at the best ask (native units). Optional. */
  askSize?: number;
}

export interface LiquidityGateResult {
  /** allow → fill full size; downsize → fill `sizeFactor` of it; veto → skip. */
  action: 'allow' | 'downsize' | 'veto';
  /** Every reason that shaped the verdict; empty on a full allow. */
  reasons: LiquidityGateReason[];
  /** Cost of crossing half the spread to the side's touch (bps). Null on a dead quote. */
  spreadCostBps: number | null;
  /** Naive linear impact (bps). Null when depth is unknown (impactMeasured=false). */
  impactBps: number | null;
  /** spreadCostBps + impactBps (bps). Null when spread is unmeasurable. */
  totalCostBps: number | null;
  /** Fraction of the order to fill: 1 (allow), in [min,1) (downsize), 0 (veto). */
  sizeFactor: number;
  /** True iff a usable displayed depth let the impact term be computed. */
  impactMeasured: boolean;
  /** The config actually applied (echoed so a ledger row is self-describing). */
  config: LiquidityGateConfig;
}

function isFinitePos(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Evaluate one order against the L1 book. Pure and total: any non-finite /
 * nonsensical input degrades to a UNUSABLE_QUOTE veto rather than throwing, so a
 * bad feed read can never crash the shadow pass (nor, once armed, a live route).
 */
export function evaluateLiquidityGate(
  input: LiquidityGateInput,
  config: LiquidityGateConfig = DEFAULT_LIQUIDITY_GATE_CONFIG,
): LiquidityGateResult {
  const cfg = config;
  const { side, bid, ask, orderQty } = input;

  // Unusable quote: non-finite, crossed book, or non-positive mid. We refuse to
  // predict a fill against a dead / corrupt book — that IS the thin-book veto the
  // ticket asks for at its most extreme.
  const usable =
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask > 0 &&
    ask >= bid;
  const mid = usable ? (bid + ask) / 2 : Number.NaN;
  if (!usable || !(mid > 0)) {
    return {
      action: 'veto',
      reasons: ['UNUSABLE_QUOTE'],
      spreadCostBps: null,
      impactBps: null,
      totalCostBps: null,
      sizeFactor: 0,
      impactMeasured: false,
      config: cfg,
    };
  }

  // Spread cost — the side's actual touch vs the mid, in bps. Size-independent.
  const touchDistance = side === 'buy' ? ask - mid : mid - bid;
  const spreadCostBps = (touchDistance / mid) * 1e4;

  // Impact — linear in order-vs-depth. Depth is the notional resting at the touch
  // the order crosses. Unknown depth ⇒ unmeasured (null), spread-only decision.
  const touchPrice = side === 'buy' ? ask : bid;
  const touchSize = side === 'buy' ? input.askSize : input.bidSize;
  const depthNotional = isFinitePos(touchSize) ? touchSize * touchPrice : null;
  const orderNotional = isFinitePos(orderQty) ? orderQty * touchPrice : 0;
  const impactMeasured = depthNotional !== null;
  const impactBps =
    depthNotional !== null && orderNotional > 0
      ? cfg.impactCoeffBps * (orderNotional / depthNotional)
      : depthNotional !== null
        ? 0 // measurable depth, but a zero/nonsensical order size ⇒ no impact
        : null;

  const totalCostBps = spreadCostBps + (impactBps ?? 0);

  // Verdict. Spread is a floor no sizing can beat.
  if (spreadCostBps > cfg.maxCostBps) {
    return {
      action: 'veto',
      reasons: ['SPREAD_TOO_WIDE'],
      spreadCostBps,
      impactBps,
      totalCostBps: impactBps === null ? spreadCostBps : totalCostBps,
      sizeFactor: 0,
      impactMeasured,
      config: cfg,
    };
  }

  // No measurable depth: fall back to a spread-only allow (spread already cleared
  // the ceiling above, so at full size the modeled cost is within budget).
  if (depthNotional === null || orderNotional <= 0) {
    return {
      action: 'allow',
      reasons: [],
      spreadCostBps,
      impactBps,
      totalCostBps: impactBps === null ? spreadCostBps : totalCostBps,
      sizeFactor: 1,
      impactMeasured,
      config: cfg,
    };
  }

  // Impact budget after paying the spread. Largest notional that fits it, then the
  // fraction of the order that lands inside the budget.
  const impactBudgetBps = cfg.maxCostBps - spreadCostBps;
  const maxNotional = depthNotional * (impactBudgetBps / cfg.impactCoeffBps);
  const rawFactor = maxNotional / orderNotional;
  const sizeFactor = Math.min(1, rawFactor);

  if (sizeFactor >= 1) {
    return {
      action: 'allow',
      reasons: [],
      spreadCostBps,
      impactBps,
      totalCostBps,
      sizeFactor: 1,
      impactMeasured,
      config: cfg,
    };
  }
  if (sizeFactor >= cfg.minDownsizeFactor) {
    return {
      action: 'downsize',
      reasons: ['THIN_BOOK_DOWNSIZE'],
      spreadCostBps,
      impactBps,
      totalCostBps,
      sizeFactor,
      impactMeasured,
      config: cfg,
    };
  }
  return {
    action: 'veto',
    reasons: ['THIN_BOOK_VETO'],
    spreadCostBps,
    impactBps,
    totalCostBps,
    sizeFactor: 0,
    impactMeasured,
    config: cfg,
  };
}
