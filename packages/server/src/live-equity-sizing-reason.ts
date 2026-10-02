/**
 * TRA-4877 — WHICH zero did the live-equity sizer return?
 *
 * ## The defect this exists to remove
 *
 * `sizeLiveEquityFromStop` returns a bare `number`, and `0` is the value it
 * uses for **six structurally different refusals**:
 *
 *   1. the stop distance is zero/inverted            (a signal-shape problem)
 *   2. the price is non-positive                     (a quote problem)
 *   3. the book is empty                             (a funding problem)
 *   4. the risk budget rounds below one unit         (a risk-setting problem)
 *   5. one share costs at or above the per-position cap at this book
 *                                                    (a CAPITAL-SIZE fact)
 *   6. available funds cannot settle one share       (a settlement problem)
 *
 * The caller then stamps one string for all six:
 *
 *     Tradier sizing yielded qty=0 (cash=427.94 stockBP=427.94)
 *
 * …which `categorizeLiveSkipReason` maps to `other`. So on both surfaces that
 * exist — the dashboard's `liveSkipReason` and the unauthenticated
 * `/api/health/live-equity` breakdown — a $428 book priced out of AAPL reads
 * **byte-identically** to a broken quote feed, a mis-set `riskPerTrade`, and a
 * genuinely empty account. Four different operator actions behind one value.
 * That is the recurring "an instrument that reads identically in pass and fail"
 * shape, and it is why the TRA-4874 census had to be re-derived by hand from
 * the sizing source before anyone could tell which bound was binding.
 *
 * ## What this module is NOT
 *
 * It does **not** move a bound. `OPTIONS_PER_TICKET_DOLLAR_FLOOR` ($150),
 * `OPTIONS_POSITION_CAP_RATIO` (0.15) and the TRA-499 strict-less-than
 * admission are untouched and the qty this module computes is bit-for-bit the
 * qty `sizeLiveEquityFromStop` computed before it existed (there is a parity
 * control over a 1,000-point matrix in the test file). Per the CEO ruling on
 * TRA-4877, 2026-09-27: `qty = 0` above the cap is **the concentration control
 * working** — one share of a $150 stock is 35% of a $428 book. The defect is
 * that the refusal does not name itself.
 *
 * ## Why a ledger and not just a better string
 *
 * `LiveEquityAcceptance.liveSkipReasonCategories` is folded over
 * `this.recentSignals`, which is the newest-50 ring. TRA-4936 measured that
 * exact ring keeping 50 of 907 rows **by recency**, so a count derived from it
 * cannot answer "how often did we price out today". {@link
 * LiveEquitySizingLedger} therefore folds at the decision point, per ET day,
 * outside the ring — the TRA-4788/TRA-4936 precedent.
 *
 * And it carries a **provenance cell** ({@link LiveEquitySizingZeroView.wiring}),
 * because `pricedOutAtBook: 0` otherwise reads identically whether the fold was
 * never called or was called and measured a true zero (TRA-4936 second pass,
 * `4a1116d8`; and the standing rule that a modelled zero and a measured zero
 * are the same number).
 */

import {
  OPTIONS_PER_TICKET_DOLLAR_FLOOR,
  OPTIONS_POSITION_CAP_RATIO,
  perPositionCap,
} from '@trading-app/shared';
import type { TradierAccountBalance } from '@trading-app/engine';
import { etDateKey } from './et-clock.js';

/**
 * The low-cardinality vocabulary a live-equity `qty = 0` is attributed to.
 * Constant labels only — never a symbol, price, quantity or balance — so the
 * breakdown keyed by these is safe on the unauthenticated
 * `/api/health/live-equity` probe (same contract as {@link
 * import('./signal-engine.js').LiveSkipCategory}).
 *
 * Ordered as the sizer evaluates them, which is also the precedence order: the
 * first bound that bites is the one reported. `priced_out_at_book` is checked
 * BEFORE `available_funds_below_one_share` in the shipped sizer, and that order
 * is load-bearing — on the measured $427.94 cash book both are true at once for
 * a $350 share, and the one the operator needs is the cap.
 */
export type LiveEquitySizingZeroReason =
  /** `|entry − stop| <= 0` — the signal carries no risk distance to size from. */
  | 'stop_distance_nonpositive'
  /** `currentPrice <= 0` — no usable quote. A FEED problem, not a book problem. */
  | 'price_nonpositive'
  /** `totalCash + longMarketValue <= 0` — the account is empty. */
  | 'equity_nonpositive'
  /** `managedEquity × riskPerTrade <= 0` — the risk budget itself is zero. */
  | 'risk_budget_nonpositive'
  /**
   * TRA-499 — one share costs at or above `perPositionCap(equity)`, so the
   * ticket would be ~100% of the per-position cap in a single fill. THE
   * CONCENTRATION CONTROL, WORKING. At a $427.94 book the cap is the $150
   * dollar floor, and 44 of 97 watchlist names were above it (TRA-4874
   * census, 2026-09-24T20:47Z). This is a statement about CAPITAL SIZE.
   */
  | 'priced_out_at_book'
  /**
   * TRA-711 — the broker's available funds cannot settle even one share, so
   * the 1-share floor is not lifted. Distinct from `priced_out_at_book`: that
   * one is a policy bound we chose, this one is the broker's.
   */
  | 'available_funds_below_one_share';

/** The reason union as a runtime array, for zero-init breakdown maps. */
export const LIVE_EQUITY_SIZING_ZERO_REASONS: readonly LiveEquitySizingZeroReason[] = Object.freeze([
  'stop_distance_nonpositive',
  'price_nonpositive',
  'equity_nonpositive',
  'risk_budget_nonpositive',
  'priced_out_at_book',
  'available_funds_below_one_share',
]);

/**
 * WHICH term of `max($150, 15% × equity)` produced the per-position cap.
 *
 * The labels embed today's board numbers on purpose — they are the contract the
 * CEO named on the TRA-4877 re-scope and what other surfaces will grep for —
 * so a board change to either constant must fail a test rather than silently
 * mislabel the cap. {@link assertCapSourceLabelsMatchConstants} is that test's
 * assertion, and {@link LiveEquitySizingDecision} publishes the two numbers
 * beside the label so a reader never has to trust the label alone.
 *
 * Ties (`15% × equity === $150`, i.e. exactly a $1,000 book) report
 * `floor_150`: at and below $1,000 the floor is what is holding the cap up.
 */
export type PerPositionCapSource = 'floor_150' | 'pct_15';

/**
 * Guard for the labels above. Returns the mismatch description, or `null` when
 * the labels still describe the live constants. Exported so the assertion lives
 * next to the thing it constrains and a board-number change trips it wherever
 * it is called from.
 */
export function capSourceLabelsMismatch(): string | null {
  const problems: string[] = [];
  if (OPTIONS_PER_TICKET_DOLLAR_FLOOR !== 150) {
    problems.push(
      `label 'floor_150' claims a $150 per-ticket floor but OPTIONS_PER_TICKET_DOLLAR_FLOOR is ${OPTIONS_PER_TICKET_DOLLAR_FLOOR}`,
    );
  }
  if (OPTIONS_POSITION_CAP_RATIO !== 0.15) {
    problems.push(
      `label 'pct_15' claims a 15% equity ratio but OPTIONS_POSITION_CAP_RATIO is ${OPTIONS_POSITION_CAP_RATIO}`,
    );
  }
  return problems.length > 0 ? problems.join('; ') : null;
}

/** Which term of `max(floor, ratio × equity)` is producing the cap at `baseEquity`. */
export function perPositionCapSource(baseEquity: number): PerPositionCapSource {
  return baseEquity * OPTIONS_POSITION_CAP_RATIO > OPTIONS_PER_TICKET_DOLLAR_FLOOR
    ? 'pct_15'
    : 'floor_150';
}

/** The sizer's full decision: the qty it returns, plus WHY when that qty is 0. */
export interface LiveEquitySizingDecision {
  /**
   * The share count. Bit-for-bit what `sizeLiveEquityFromStop` returns — this
   * IS the shipped sizer; the legacy signature is a `.qty` projection of it.
   */
  qty: number;
  /** `null` ⇔ `qty > 0`. Never both set, never both unset. */
  zeroReason: LiveEquitySizingZeroReason | null;
  /**
   * `(totalCash ?? 0) + (longMarketValue ?? 0)` — the book the cap is derived
   * from. `null` only when the sizer refused before reading it
   * (`stop_distance_nonpositive` / `price_nonpositive`), which is an UNREAD
   * cell, not a zero book.
   */
  baseEquity: number | null;
  /** `perPositionCap(baseEquity)` in dollars, or `null` when unread. */
  cap: number | null;
  /** Which term produced {@link cap}, or `null` when unread. */
  capSource: PerPositionCapSource | null;
  /** The $ per-ticket floor in force when this decision was taken. */
  capFloorUsd: number;
  /** The equity-ratio term in force when this decision was taken. */
  capRatio: number;
  /** The price the decision was taken against. */
  currentPrice: number;
  /**
   * Whole shares the broker's available funds could settle.
   *
   * `null` means Tradier surfaced NO buying-power bucket — an UNKNOWN, which
   * the sizer treats permissively. It is deliberately not `0` and not
   * `Infinity`: an absent reading must never serialise as a measured one
   * (standing rule — absent ≠ 0, never `?? 0`).
   */
  affordableShares: number | null;
}

/** Argument shape of the sizer. Identical to the legacy `sizeLiveEquityFromStop` args. */
export interface LiveEquitySizingArgs {
  balance: TradierAccountBalance;
  managedAccountRatio: number;
  riskPerTrade: number;
  entryPrice: number;
  stopPrice: number;
  currentPrice: number;
  /** TRA-389 — regime position-size scalar in (0,1]; omitted ↔ 1 (no trim). */
  sizeMultiplier?: number;
}

/**
 * TRA-335 / TRA-389 / TRA-499 / TRA-711 / TRA-1001 / TRA-1301 — size a live
 * Tradier equity order off the broker balance, and SAY WHICH BOUND BOUND when
 * the answer is zero.
 *
 * This is the shipped sizing core. `sizeLiveEquityFromStop` delegates here and
 * projects `.qty`, so there is exactly one copy of the arithmetic — a second
 * copy that "mirrors" it would agree with itself and drift from the engine,
 * which is the control-on-a-local-copy trap.
 *
 * Every step below, in order and including the comparison operators, is the
 * pre-TRA-4877 body verbatim. The only additions are the `zeroReason` stamps.
 */
export function explainLiveEquitySizing(args: LiveEquitySizingArgs): LiveEquitySizingDecision {
  const { balance, managedAccountRatio, riskPerTrade, entryPrice, stopPrice, currentPrice } = args;
  const capFloorUsd = OPTIONS_PER_TICKET_DOLLAR_FLOOR;
  const capRatio = OPTIONS_POSITION_CAP_RATIO;
  /** The refusals below the cap read: nothing about the book has been read yet. */
  const unread = (zeroReason: LiveEquitySizingZeroReason): LiveEquitySizingDecision => ({
    qty: 0,
    zeroReason,
    baseEquity: null,
    cap: null,
    capSource: null,
    capFloorUsd,
    capRatio,
    currentPrice,
    affordableShares: null,
  });

  const dist = Math.abs(entryPrice - stopPrice);
  // Split what the legacy `if (dist <= 0 || currentPrice <= 0)` folded into one
  // branch: a dead quote and a degenerate stop are different pages.
  if (dist <= 0) return unread('stop_distance_nonpositive');
  if (currentPrice <= 0) return unread('price_nonpositive');

  const lmv = balance.longMarketValue ?? 0;
  const baseEquity = (balance.totalCash ?? 0) + lmv;
  const cap = perPositionCap(baseEquity);
  const capSource = perPositionCapSource(baseEquity);
  const sbp = balance.stockBuyingPower;
  // TRA-711 — whole shares available funds can cover. `null` bucket ⇒ unknown
  // ⇒ stay permissive (Infinity internally, published as `null`).
  const affordableSharesRaw =
    typeof sbp === 'number' && Number.isFinite(sbp) && sbp > 0
      ? Math.floor(sbp / currentPrice)
      : Number.POSITIVE_INFINITY;
  const affordableShares = Number.isFinite(affordableSharesRaw) ? affordableSharesRaw : null;
  const decided = (
    qty: number,
    zeroReason: LiveEquitySizingZeroReason | null,
  ): LiveEquitySizingDecision => ({
    qty,
    zeroReason,
    baseEquity,
    cap,
    capSource,
    capFloorUsd,
    capRatio,
    currentPrice,
    affordableShares,
  });

  if (baseEquity <= 0) return decided(0, 'equity_nonpositive');
  const managedEquity = baseEquity * managedAccountRatio;
  const maxRisk = managedEquity * riskPerTrade;
  if (maxRisk <= 0) return decided(0, 'risk_budget_nonpositive');
  const riskQty = Math.floor(maxRisk / dist);
  const equityCap = Math.floor(managedEquity / currentPrice);
  let qty = Math.min(riskQty, equityCap);
  if (typeof sbp === 'number' && sbp > 0) {
    qty = Math.min(qty, Math.floor(sbp / currentPrice));
  }
  const mult = args.sizeMultiplier;
  if (typeof mult === 'number' && Number.isFinite(mult) && mult > 0 && mult < 1) {
    qty = Math.floor(qty * mult);
  }

  // TRA-499 — per-position dollar cap on live equity tickets, mirroring the
  // TRA-495/TRA-497 options ticket cap. Below ~$1k equity the raw 15%-of-equity
  // cap drops below the $150 ticket floor and would null out reasonable
  // entries even though the risk-from-stop math allows them. Apply the cap
  // *after* the risk/equity/BP/regime trims so the cap is the final upper
  // bound rather than something the broader risk math has to respect.
  //
  // Two-step gate, mirroring `OptionsAccount.sizeContracts`:
  //   1. If the risk-from-stop math rounded `qty` to 0 (e.g. $550 book, $50
  //      share, $2 stop distance ⇒ `riskQty = 13` but the buying-power /
  //      managed-equity caps trim it down) AND a single share's notional fits
  //      under the per-position cap, force `qty = 1`. This is the LIVE-only
  //      1-share floor that makes a $550 book actually buy something.
  //   2. If multi-share `qty × currentPrice` exceeds the cap, trim back to
  //      `floor(cap / currentPrice)`. This is the same trim the options path
  //      does after the dollar floor lifts the budget above the cap.
  //
  // Cap is `max($150, 15% × equity)`. Per QuantTrader on the TRA-499 review
  // handoff, the equity sizing uses a *strict-less-than* admission boundary
  // for the 1-share-cost vs the per-position cap: a single ticket whose
  // 1-share cost equals or exceeds the cap is rejected up-front, because
  // that ticket would consume 100% of the cap (e.g. a $150 stock on a $550
  // book is 27% concentration in one fill). This is intentionally asymmetric
  // with `OptionsAccount.sizeContracts`, where the 1-contract floor uses
  // `<= cap` because options have 100× quantization and the cap floor was
  // raised to $150 in TRA-497 specifically to admit a $1.50-mark contract
  // on a small book. Multi-share equity positions trimmed down so that the
  // final notional equals the cap exactly (e.g. 3 × $50 = $150) are kept —
  // the per-share granularity diversifies the same dollar concentration
  // across multiple fills. Fractional-share support is intentionally not
  // enabled here (see TRA-499 spec).
  //
  // TRA-4877 — this IS the concentration control working, and the only thing
  // that ticket changed about it is that the refusal now says so. At the
  // measured $427.94 live book the cap is the $150 floor and 44 of 97 watchlist
  // names sit above it; that is a statement about capital size, not a defect.
  if (currentPrice >= cap) return decided(0, 'priced_out_at_book');

  // TRA-711 — only lift to the LIVE 1-share floor when a single share's
  // notional actually fits inside available funds. Forcing qty = 1 on a book
  // whose available funds are below one share's cost (e.g. $26 available, a
  // $129 share) is exactly what made Tradier reject the equity bracket in the
  // screenshot: the buying-power cap above had already ground qty to 0 and
  // this floor re-inflated it to an order the broker could never fill. When
  // funds can't cover even one share, size to 0 so the caller surfaces a
  // clean `liveSkipReason` instead of submitting an order we know will bounce.
  if (qty <= 0) {
    if (affordableSharesRaw < 1) return decided(0, 'available_funds_below_one_share');
    qty = 1;
  }
  if (qty > 0 && qty * currentPrice > cap) {
    qty = Math.floor(cap / currentPrice);
  }
  // TRA-711 — final hard ceiling on available funds.
  if (Number.isFinite(affordableSharesRaw)) {
    qty = Math.min(qty, affordableSharesRaw);
  }
  // Defensive: `currentPrice < cap` ⇒ `floor(cap / price) >= 1`, and the branch
  // above already refused an `affordableSharesRaw < 1` book, so this is
  // unreachable today. Attribute it rather than return a bare 0 if a future
  // trim re-opens it — an unattributed zero here is the whole defect.
  return qty > 0 ? decided(qty, null) : decided(0, 'available_funds_below_one_share');
}

/**
 * The operator-facing one-liner for a zero, naming the bound that produced it.
 *
 * Goes on `signal.liveSkipReason`, which is an AUTHENTICATED surface and
 * already carries `cash=` / `stockBP=`, so the dollar detail here leaks nothing
 * new. The unauthenticated health probe never sees this string — it sees the
 * constant category label only.
 */
export function describeLiveEquitySizingZero(d: LiveEquitySizingDecision): string {
  const usd = (n: number): string => `$${n.toFixed(2)}`;
  const head = `Tradier sizing yielded qty=0 [${d.zeroReason ?? 'unattributed'}]`;
  switch (d.zeroReason) {
    case 'priced_out_at_book':
      return (
        `${head}: one share at ${usd(d.currentPrice)} is at or above the `
        + `${usd(d.cap ?? 0)} per-position cap on a ${usd(d.baseEquity ?? 0)} book `
        + `(cap source ${d.capSource ?? 'unknown'} = max(${usd(d.capFloorUsd)}, `
        + `${(d.capRatio * 100).toFixed(0)}% x equity)) — TRA-499 concentration `
        + `admission, not a risk-math zero. This is a CAPITAL-SIZE bound: fund the `
        + `book above ${usd(d.capFloorUsd / d.capRatio)} to clear the floor, or reach `
        + `this underlying through options instead of shares.`
      );
    case 'available_funds_below_one_share':
      return (
        `${head}: available funds cover ${d.affordableShares ?? 0} whole shares at `
        + `${usd(d.currentPrice)} — below the 1-share floor (TRA-711), so the order `
        + `would bounce at the broker.`
      );
    case 'risk_budget_nonpositive':
      return (
        `${head}: risk budget is zero (managed equity x riskPerTrade) on a `
        + `${usd(d.baseEquity ?? 0)} book — a RISK SETTING, not a price bound.`
      );
    case 'equity_nonpositive':
      return `${head}: book is ${usd(d.baseEquity ?? 0)} — nothing to size against.`;
    case 'price_nonpositive':
      return `${head}: no usable quote (price ${usd(d.currentPrice)}) — a FEED gap, not a book bound.`;
    case 'stop_distance_nonpositive':
      return `${head}: |entry - stop| is zero or inverted — the signal carries no risk distance.`;
    default:
      return head;
  }
}

/** ET days of per-day rows the ledger retains. Matches the card fold. */
export const LIVE_EQUITY_SIZING_RETAINED_ET_DAYS = 14;

/** A fresh all-zero reason breakdown, with stable key order for JSON. */
export function emptyLiveEquitySizingZeroCounts(): Record<LiveEquitySizingZeroReason, number> {
  const out = {} as Record<LiveEquitySizingZeroReason, number>;
  for (const r of LIVE_EQUITY_SIZING_ZERO_REASONS) out[r] = 0;
  return out;
}

/** One ET day's fold of live-equity sizing outcomes. */
export interface LiveEquitySizingDayRow {
  /** `YYYY-MM-DD` in ET. */
  etDay: string;
  /** Sizing decisions taken that day (sized + refused). The denominator. */
  decisions: number;
  /** Decisions that produced `qty > 0`. */
  sized: number;
  /** Decisions that produced `qty = 0`, by attributed reason. */
  zerosByReason: Record<LiveEquitySizingZeroReason, number>;
}

/**
 * Whether this fold has ever been exercised — the discriminator between "wired,
 * and today genuinely had no priced-out refusal" and "never called, so every
 * count is a default".
 */
export type LiveEquitySizingWiringVerdict =
  /** No decision has ever reached the ledger this boot. Every count is a DEFAULT, not a measurement. */
  | 'never_recorded'
  /** Decisions recorded, but none of them refused. Zeros are MEASURED zeros. */
  | 'recorded_no_zeros'
  /** Decisions recorded and at least one refused. */
  | 'recorded_with_zeros';

/** The published view. Counts and constant labels only — safe for the unauth probe. */
export interface LiveEquitySizingZeroView {
  /**
   * READ THIS BEFORE ANY COUNT BELOW. `never_recorded` ⇒ the numbers are
   * defaults and say nothing about the sizer; a `pricedOutAtBook: 0` under
   * `never_recorded` is NOT evidence the book is clearing its cap.
   */
  wiring: LiveEquitySizingWiringVerdict;
  /** Epoch ms the fold started counting (process boot, in practice). */
  countsSince: string;
  /** Every decision since boot. Never evicted, never derived from the signal ring. */
  decisionsSinceBoot: number;
  /** Decisions since boot that produced `qty > 0`. */
  sizedSinceBoot: number;
  /** Zeros since boot by reason. Never evicted. */
  zerosSinceBootByReason: Record<LiveEquitySizingZeroReason, number>;
  /** Per-ET-day rows, newest first, capped at {@link LIVE_EQUITY_SIZING_RETAINED_ET_DAYS}. */
  days: LiveEquitySizingDayRow[];
  /** ET day of the most recent decision, or `null` when none. */
  lastDecisionEtDay: string | null;
  /** Reason of the most recent zero, or `null` when no zero has been recorded. */
  lastZeroReason: LiveEquitySizingZeroReason | null;
  /** ET days dropped by the day cap — so a short `days` array is never read as a quiet week. */
  etDaysDropped: number;
  /**
   * Set when the `floor_150` / `pct_15` labels no longer describe the live
   * board constants. Non-null is a BUG REPORT about this surface, not about the
   * sizer: the counts are still right, the cap labels are not.
   */
  capLabelMismatch: string | null;
}

/** Fleet roll-up of per-engine {@link LiveEquitySizingZeroView}s. */
export interface LiveEquitySizingZeroFleetView {
  /**
   * `never_recorded` ⇔ NO engine has recorded a decision. Read this before any
   * count: under it the counts are defaults and say nothing about the sizer.
   * One engine with a measurement outranks any number of silent ones.
   */
  wiring: LiveEquitySizingWiringVerdict;
  /** Engines contributing to this roll-up. 0 ⇒ nothing was read, not "all quiet". */
  engineCount: number;
  /** Engines whose own fold reads `never_recorded`. */
  enginesNeverRecorded: number;
  /** Fleet-summed decisions since each engine's boot. */
  decisionsSinceBoot: number;
  /** Fleet-summed decisions that produced `qty > 0`. */
  sizedSinceBoot: number;
  /** Fleet-summed zeros by reason. */
  zerosSinceBootByReason: Record<LiveEquitySizingZeroReason, number>;
  /** Newest `lastDecisionEtDay` across engines, or `null`. */
  lastDecisionEtDay: string | null;
  /** Any engine reporting stale cap labels. Non-null is a bug in THIS surface. */
  capLabelMismatch: string | null;
}

/**
 * Fold per-engine views into one. Counts only — no price, quantity or balance —
 * so the result is safe on the unauthenticated `/api/health/live-equity` probe.
 *
 * An empty `views` array reports `never_recorded` with `engineCount: 0`, never a
 * clean `recorded_no_zeros`: "nobody was asked" and "everybody answered zero"
 * must not share a serialisation.
 */
export function aggregateLiveEquitySizingZeroViews(
  views: readonly LiveEquitySizingZeroView[],
): LiveEquitySizingZeroFleetView {
  const zerosSinceBootByReason = emptyLiveEquitySizingZeroCounts();
  let decisionsSinceBoot = 0;
  let sizedSinceBoot = 0;
  let enginesNeverRecorded = 0;
  let lastDecisionEtDay: string | null = null;
  let capLabelMismatch: string | null = null;
  for (const v of views) {
    decisionsSinceBoot += v.decisionsSinceBoot;
    sizedSinceBoot += v.sizedSinceBoot;
    if (v.wiring === 'never_recorded') enginesNeverRecorded += 1;
    for (const r of LIVE_EQUITY_SIZING_ZERO_REASONS) {
      zerosSinceBootByReason[r] += v.zerosSinceBootByReason[r] ?? 0;
    }
    if (v.lastDecisionEtDay !== null && (lastDecisionEtDay === null || v.lastDecisionEtDay > lastDecisionEtDay)) {
      lastDecisionEtDay = v.lastDecisionEtDay;
    }
    if (capLabelMismatch === null && v.capLabelMismatch !== null) capLabelMismatch = v.capLabelMismatch;
  }
  const anyZero = LIVE_EQUITY_SIZING_ZERO_REASONS.some(r => zerosSinceBootByReason[r] > 0);
  return {
    wiring:
      decisionsSinceBoot === 0
        ? 'never_recorded'
        : anyZero
          ? 'recorded_with_zeros'
          : 'recorded_no_zeros',
    engineCount: views.length,
    enginesNeverRecorded,
    decisionsSinceBoot,
    sizedSinceBoot,
    zerosSinceBootByReason,
    lastDecisionEtDay,
    capLabelMismatch,
  };
}

/**
 * The per-ET-day live-equity sizing fold, OUTSIDE the newest-50 signal ring.
 *
 * `LiveEquityAcceptance.liveSkipReasonCategories` is folded over
 * `recentSignals`, which TRA-4936 measured keeping 50 of 907 rows by recency.
 * This ledger is fed at the decision point instead, so "how many times did we
 * price out today" is answerable by a reader who arrives after the close.
 *
 * In-memory and per-process by construction — same durability class as the card
 * fold. `countsSince` is published so a count is never mistaken for an
 * all-time figure (the durable-vs-since-boot trap).
 */
export class LiveEquitySizingLedger {
  private readonly days = new Map<string, LiveEquitySizingDayRow>();
  private readonly zerosSinceBoot = emptyLiveEquitySizingZeroCounts();
  private readonly countsSince: number;
  private decisionsSinceBoot = 0;
  private sizedSinceBoot = 0;
  private lastDecisionEtDay: string | null = null;
  private lastZeroReason: LiveEquitySizingZeroReason | null = null;
  private etDaysDropped = 0;

  constructor(
    now: number = Date.now(),
    private readonly dayCap: number = LIVE_EQUITY_SIZING_RETAINED_ET_DAYS,
  ) {
    this.countsSince = now;
  }

  /**
   * Record one sizing decision. Call at the single live-equity entry chokepoint
   * (`placeTradierEquityBracket`) — the mirror and the correlated-cap estimate
   * re-run the same sizer on the same tick, and counting those would treble the
   * denominator for one decision.
   *
   * @param at epoch ms the decision was taken (fixes the ET day)
   */
  record(decision: LiveEquitySizingDecision, at: number = Date.now()): void {
    const etDay = etDateKey(at);
    // Since-boot roll FIRST and unconditionally: the day cap below can decline
    // a decision stamped older than every retained day, and the never-evicting
    // roll must still see it.
    this.decisionsSinceBoot += 1;
    this.lastDecisionEtDay = etDay;
    if (decision.zeroReason === null) {
      this.sizedSinceBoot += 1;
    } else {
      this.zerosSinceBoot[decision.zeroReason] += 1;
      this.lastZeroReason = decision.zeroReason;
    }

    let row = this.days.get(etDay);
    if (!row) {
      row = { etDay, decisions: 0, sized: 0, zerosByReason: emptyLiveEquitySizingZeroCounts() };
      this.days.set(etDay, row);
      this.evictOldestDaysOverCap();
      if (!this.days.has(etDay)) return;
    }
    row.decisions += 1;
    if (decision.zeroReason === null) row.sized += 1;
    else row.zerosByReason[decision.zeroReason] += 1;
  }

  /** Published view. Pure read — never throws, never mutates. */
  snapshot(): LiveEquitySizingZeroView {
    const days = Array.from(this.days.values()).sort((a, b) => (a.etDay < b.etDay ? 1 : -1));
    return {
      wiring:
        this.decisionsSinceBoot === 0
          ? 'never_recorded'
          : this.hasAnyZero()
            ? 'recorded_with_zeros'
            : 'recorded_no_zeros',
      countsSince: new Date(this.countsSince).toISOString(),
      decisionsSinceBoot: this.decisionsSinceBoot,
      sizedSinceBoot: this.sizedSinceBoot,
      zerosSinceBootByReason: { ...this.zerosSinceBoot },
      days: days.map(d => ({ ...d, zerosByReason: { ...d.zerosByReason } })),
      lastDecisionEtDay: this.lastDecisionEtDay,
      lastZeroReason: this.lastZeroReason,
      etDaysDropped: this.etDaysDropped,
      capLabelMismatch: capSourceLabelsMismatch(),
    };
  }

  private hasAnyZero(): boolean {
    for (const r of LIVE_EQUITY_SIZING_ZERO_REASONS) {
      if (this.zerosSinceBoot[r] > 0) return true;
    }
    return false;
  }

  private evictOldestDaysOverCap(): void {
    while (this.days.size > this.dayCap) {
      let oldest: string | null = null;
      for (const key of this.days.keys()) {
        if (oldest === null || key < oldest) oldest = key;
      }
      if (oldest === null) return;
      this.days.delete(oldest);
      this.etDaysDropped += 1;
    }
  }
}
