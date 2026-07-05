import {
  SCALE_OUT_LADDER_RUNGS,
  SCALE_OUT_TAKER_FEE_EQUITY,
  type ScaleOutLadderRung,
} from '@trading-app/shared';

/**
 * TRA-1300 (parent TRA-1290, board confirmation `38a50f39`) — the observe-only
 * scale-out (take-profit) ladder decision.
 *
 * The board REJECTED the finfluencer add-down / averaging-down ladder (TRA-1291
 * verdict: NO-GO — it blows the account up) and GREENLIT only the scale-out side:
 * TRIM an existing position on moves ABOVE the average entry. This module is a
 * PURE decision helper with no I/O and no position mutation — the mirror of the
 * exit-rules helpers. The caller owns the running per-position "which rungs have
 * already fired" state and records the intended trims into its observe-only
 * ledger; nothing here places an order.
 *
 * Deliberate scope boundary: the ladder governs the UPSIDE ONLY. Any price
 * at/below the average entry (`gainPct <= 0`) is a downside the ladder does not
 * touch — it defers to the shipped chandelier trail + give-back cap
 * (TRA-1267/1268) via the `downsideDeferred` flag. There is NO add-down rung.
 *
 * Sell % is of the ORIGINAL (base) position size, matching the TRA-1291 fee-aware
 * harness reference. Trims are FEE-AWARE on a taker (market-order) assumption,
 * consistent with that harness. Convention mirrors `exit-rules.ts`:
 * `side: 'buy'` = long, `side: 'sell'` = short; favorable excursion is measured
 * from the average entry in the position's favorable direction.
 */

export type Side = 'buy' | 'sell';

export interface ScaleOutLadderParams {
  side: Side;
  /** Average entry price of the (possibly scaled-in) position. */
  avgEntry: number;
  /** Current mark. */
  currentPrice: number;
  /** Original (base) position size in shares / contracts / units. */
  baseQty: number;
  /**
   * Per-side TAKER fee rate applied to each trim's gross proceeds. Defaults to the
   * equity rate; the caller passes the crypto rate for crypto names.
   */
  feeRate?: number;
  /**
   * The rung `up` thresholds that have ALREADY fired for this position (so a rung
   * trims once and only once across the position's life, surviving restart because
   * the caller rebuilds this from its ledger). Order-independent.
   */
  firedRungs?: readonly number[];
  /** Override the default ladder (mostly for tests). */
  rungs?: readonly ScaleOutLadderRung[];
}

/** One intended trim the ladder would emit this evaluation (observe-only). */
export interface ScaleOutTrim {
  /** The rung's favorable-move threshold (0.25 = +25% from avg entry). */
  up: number;
  /** Base-size fraction trimmed at this rung (the `'remainder'` rung resolves to the leftover fraction). */
  sellPctBase: number;
  /** Units trimmed = `sellPctBase × baseQty`. */
  trimQty: number;
  /** Gross proceeds = `trimQty × currentPrice` (pre-fee). */
  grossProceeds: number;
  /** Taker fee charged on the trim = `grossProceeds × feeRate`. */
  feeCost: number;
  /** Net proceeds = `grossProceeds − feeCost`. */
  netProceeds: number;
  /**
   * True when this trim brings the position FULLY scaled out (cumulative base sold
   * reaches 100%). Note the spec's numeric rungs sum to exactly 100% by the +60%
   * rung (10+20+30+40), so in normal operation the +60% trim carries this flag and
   * the `'remainder'` rung is a defensive 0-qty catch that never emits.
   */
  isFullExit: boolean;
}

export interface ScaleOutLadderDecision {
  /** Favorable excursion from avg entry: long `price/avg−1`, short `avg/price−1`. */
  gainPct: number;
  /**
   * True when the position is NOT above its average entry (`gainPct <= 0`), i.e.
   * the loss-control side owns it. The ladder emits no trim in this state — the
   * chandelier trail + give-back cap (TRA-1267/1268) govern the downside.
   */
  downsideDeferred: boolean;
  /** The taker fee rate applied to the trims below. */
  feeRate: number;
  /** Newly-triggered trims this evaluation (rungs armed by `gainPct`, not in `firedRungs`), ascending. */
  triggered: ScaleOutTrim[];
  /** Cumulative base fraction sold once these trims apply (prior fired + newly triggered). */
  cumulativeSoldPctBase: number;
  /** True when the `'remainder'` rung fires this evaluation (position fully exited). */
  fullyExited: boolean;
}

/** Resolve a rung's numeric base fraction; `'remainder'` returns null (leftover-driven). */
function rungBaseFrac(rung: ScaleOutLadderRung): number | null {
  return rung.sellPctBase === 'remainder' ? null : rung.sellPctBase;
}

/**
 * Evaluate the scale-out ladder for one position. Pure — returns the trims the
 * ladder WOULD emit; the observe-only caller records them and never routes.
 *
 * A rung arms when `gainPct >= rung.up` and it is not already in `firedRungs`.
 * Multiple rungs can arm in one evaluation (a gap-up crossing several at once);
 * they are emitted in ascending `up` order, accumulating the sold fraction so the
 * `'remainder'` rung trims exactly the leftover. A degenerate input (non-finite /
 * non-positive avg entry, price, or base qty) yields no trim.
 */
export function scaleOutLadderDecision(p: ScaleOutLadderParams): ScaleOutLadderDecision {
  const feeRate = Number.isFinite(p.feeRate) && (p.feeRate as number) >= 0
    ? (p.feeRate as number)
    : SCALE_OUT_TAKER_FEE_EQUITY;
  const rungs = p.rungs ?? SCALE_OUT_LADDER_RUNGS;

  const degenerate =
    !(p.avgEntry > 0) || !Number.isFinite(p.avgEntry) ||
    !(p.currentPrice > 0) || !Number.isFinite(p.currentPrice) ||
    !(p.baseQty > 0) || !Number.isFinite(p.baseQty);
  if (degenerate) {
    return { gainPct: 0, downsideDeferred: false, feeRate, triggered: [], cumulativeSoldPctBase: 0, fullyExited: false };
  }

  const gainPct =
    p.side === 'buy' ? p.currentPrice / p.avgEntry - 1 : p.avgEntry / p.currentPrice - 1;

  // Sum the base fraction already sold at the fired rungs (the `'remainder'` rung,
  // if it were in firedRungs, means the position is already flat — no leftover).
  const fired = new Set(p.firedRungs ?? []);
  let cumulativeSoldPctBase = 0;
  let remainderAlreadyFired = false;
  for (const rung of rungs) {
    if (!fired.has(rung.up)) continue;
    const frac = rungBaseFrac(rung);
    if (frac === null) remainderAlreadyFired = true;
    else cumulativeSoldPctBase += frac;
  }

  // At/below the average entry (or already fully exited) the ladder stands down —
  // the downside is the chandelier / give-back cap's job, not the take-profit ladder's.
  if (gainPct <= 0 || remainderAlreadyFired) {
    return {
      gainPct,
      downsideDeferred: gainPct <= 0,
      feeRate,
      triggered: [],
      cumulativeSoldPctBase: remainderAlreadyFired ? 1 : cumulativeSoldPctBase,
      fullyExited: false,
    };
  }

  const triggered: ScaleOutTrim[] = [];
  const EPS = 1e-9;
  // Ascending `up` so trims accumulate in order and the `'remainder'` rung (highest)
  // resolves against the true leftover. The `- EPS` tolerance arms a rung at an
  // EXACT threshold move despite float error (e.g. `145/100 - 1 = 0.44999…956`,
  // just under 0.45, would otherwise miss the +45% rung at a clean +45%).
  const armed = rungs
    .filter((r) => !fired.has(r.up) && gainPct >= r.up - EPS)
    .sort((a, b) => a.up - b.up);

  for (const rung of armed) {
    const frac = rungBaseFrac(rung);
    const leftover = Math.max(0, 1 - cumulativeSoldPctBase);
    // A numeric rung trims its fraction (clamped to the leftover); `'remainder'`
    // trims the leftover. Either way it can never oversell the base.
    const sellPctBase = frac === null ? leftover : Math.min(frac, leftover);
    if (!(sellPctBase > 0)) continue; // nothing left (rungs already summed to 100%)
    cumulativeSoldPctBase += sellPctBase;
    const trimQty = sellPctBase * p.baseQty;
    const grossProceeds = trimQty * p.currentPrice;
    const feeCost = grossProceeds * feeRate;
    triggered.push({
      up: rung.up,
      sellPctBase,
      trimQty,
      grossProceeds,
      feeCost,
      netProceeds: grossProceeds - feeCost,
      // This trim fully scales the position out once cumulative sold reaches 100%.
      isFullExit: cumulativeSoldPctBase >= 1 - EPS,
    });
  }

  return {
    gainPct,
    downsideDeferred: false,
    feeRate,
    triggered,
    cumulativeSoldPctBase: Math.min(1, cumulativeSoldPctBase),
    fullyExited: cumulativeSoldPctBase >= 1 - EPS,
  };
}
