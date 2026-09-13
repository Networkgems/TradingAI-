/**
 * TRA-4604 — the paper-accrual net-of-fee validation harness.
 *
 * ## Why this exists
 *
 * `promotion-service` names `single_leg_rv` and `single_leg_otm` as the
 * production sleeves and records that NEITHER has cleared net-of-fee forward
 * validation. The last captured live gate was underpowered at 61 observed
 * against 727 required.
 *
 * 727 live round-trips is not reachable. At the account sizes this app actually
 * runs (one contract, a premium cap in the tens of dollars, one open position at
 * a time) that is years of trading — and the whole point of the gate is to
 * decide whether to risk the capital in the first place. Accruing the evidence
 * by spending the money the evidence is supposed to authorise is circular.
 *
 * So this harness accrues the SAME statistic from PAPER fills, priced through
 * the same explicit-and-implicit cost model as live, and reports how far the
 * sample has to go. Paper fills are labelled at every layer and never silently
 * merged into a live cohort (see {@link CohortSource} and the `sourceMix` field
 * every summary carries) — a paper trade is evidence about the STRATEGY, not
 * about execution quality, and conflating them is how a backtest becomes a
 * production authorisation.
 *
 * ## What "net of fee" means here
 *
 * Four layers, and the two that get skipped are the two that decide the answer:
 *
 *  1. EXPLICIT — broker commission, per-contract fees, and the regulatory levies
 *     (SEC Section 31 on sales, FINRA TAF). Taken from the ledger's own `fees`
 *     when the broker reported them (`feeSource: 'history_commission'`), never
 *     modelled on top of a reported figure.
 *  2. IMPLICIT — the spread actually crossed, measured as fill vs. the MID at
 *     submit. This is the cost most cost models omit, and on a wide-spread
 *     option it routinely exceeds commission by an order of magnitude.
 *  3. COMPOUNDING — returns are chained multiplicatively, not summed. A simple
 *     mean of per-trade percentages overstates a series containing losses.
 *  4. RECONCILIATION — every round-trip is built from two REAL ledger rows.
 *     A fill that cannot be paired is reported in `unpaired`, never dropped:
 *     silently discarding unpairable fills biases the cohort toward completed,
 *     and completed correlates with profitable.
 *
 * ## The only honest way to "speed this up"
 *
 * Required N falls with the SQUARE of the effect/noise ratio. There are exactly
 * three levers and only one of them is legitimate:
 *
 *  - Lower the confidence bar → not faster validation, just weaker validation.
 *  - Trade more, live → spends the capital the gate exists to protect.
 *  - REDUCE σ → legitimate, and what {@link requiredSampleSize} is built to
 *    expose. Measuring costs exactly rather than estimating them, and scoping a
 *    cohort to one sleeve and one regime rather than pooling everything, both
 *    shrink the variance term directly. Halving σ cuts required N by 4×.
 *
 * This module therefore reports σ and the required N it implies as first-class
 * outputs, so the operator can see which of those three they are actually
 * pulling.
 */

/** Options are deliverable in 100-share lots; every dollar figure depends on it. */
export const CONTRACT_MULTIPLIER = 100;

/**
 * Where a round-trip's evidence came from. Never collapse these: paper measures
 * the strategy, live measures the strategy AND the execution.
 */
export type CohortSource = 'live' | 'paper';

/** The subset of a ledger fill row this harness needs. Structurally compatible
 * with `LiveOptionFillRecord` so the live ledger can be fed in directly. */
export interface HarnessFill {
  ts: number;
  etDay: string;
  sleeve: string;
  book: string | null;
  optionSymbol: string;
  side: 'buy_to_open' | 'sell_to_close';
  contracts: number;
  /** Broker-reported fill. `null` = UNMEASURED; the fill cannot be priced. */
  filledPrice: number | null;
  /** Mid at submit, for the implicit-cost leg. `null` on a single-sided quote. */
  midAtSubmit: number | null;
  /** Broker-reported total fees for this fill. `null` = UNREPORTED, never zero. */
  fees: number | null;
  source: CohortSource;
}

/** A completed open→close pair, priced net of both cost layers. */
export interface RoundTrip {
  sleeve: string;
  book: string | null;
  optionSymbol: string;
  source: CohortSource;
  openTs: number;
  closeTs: number;
  /** Calendar days held, for holding-period stats. */
  daysHeld: number;
  contracts: number;
  openPrice: number;
  closePrice: number;
  /** (close − open) × 100 × contracts. Before any cost. */
  grossPnl: number;
  /** Explicit costs: commission + per-contract + regulatory, both legs. */
  fees: number;
  /**
   * Implicit cost: |fill − mid| × 100 × contracts, summed across both legs.
   * Reported separately from `fees` because they have different remedies —
   * commission is negotiated, spread is a routing and liquidity decision.
   */
  slippageCost: number;
  /** grossPnl − fees − slippageCost. The number the gate actually grades. */
  netPnl: number;
  /** netPnl as a fraction of capital at risk (open premium × 100 × contracts). */
  netReturnPct: number;
}

/** A fill that could not be paired, and why. Never silently dropped. */
export interface UnpairedFill {
  fill: HarnessFill;
  reason:
    | 'no_matching_open'
    | 'still_open'
    | 'unpriced_fill'
    | 'unreported_fees'
    | 'unmeasured_mid';
}

export interface PairingResult {
  roundTrips: RoundTrip[];
  unpaired: UnpairedFill[];
}

/**
 * Pair fills into round-trips, FIFO within (book, optionSymbol).
 *
 * FIFO and not LIFO because the broker's own cost basis is FIFO; matching the
 * other way produces per-trade P&L that will not reconcile against a statement.
 *
 * Partial closes are supported: a close consumes from the front of the open
 * queue and leaves any remainder queued.
 *
 * ⚠ A fill missing `filledPrice`, `fees`, or `midAtSubmit` is NOT priced and NOT
 * counted. `null` is UNMEASURED, never zero (TRA-1707): treating an unreported
 * fee as zero fee biases every downstream statistic in the flattering direction,
 * which is precisely the failure mode a net-of-fee gate exists to catch.
 */
export function pairFillsIntoRoundTrips(fills: readonly HarnessFill[]): PairingResult {
  const roundTrips: RoundTrip[] = [];
  const unpaired: UnpairedFill[] = [];

  const unmeasured = (f: HarnessFill): UnpairedFill['reason'] | null => {
    if (f.filledPrice === null || !Number.isFinite(f.filledPrice)) return 'unpriced_fill';
    if (f.fees === null || !Number.isFinite(f.fees)) return 'unreported_fees';
    if (f.midAtSubmit === null || !Number.isFinite(f.midAtSubmit)) return 'unmeasured_mid';
    return null;
  };

  // Queue of still-open lots, keyed by the position's identity.
  const openQueues = new Map<string, { fill: HarnessFill; remaining: number }[]>();
  const keyOf = (f: HarnessFill) => `${f.book ?? ''}\u0000${f.optionSymbol}`;

  const ordered = [...fills].sort((a, b) => a.ts - b.ts);

  for (const fill of ordered) {
    const bad = unmeasured(fill);
    if (bad) {
      unpaired.push({ fill, reason: bad });
      continue;
    }
    const key = keyOf(fill);

    if (fill.side === 'buy_to_open') {
      const q = openQueues.get(key) ?? [];
      q.push({ fill, remaining: fill.contracts });
      openQueues.set(key, q);
      continue;
    }

    // sell_to_close — consume FIFO from the open queue.
    let toClose = fill.contracts;
    const q = openQueues.get(key) ?? [];
    while (toClose > 0 && q.length > 0) {
      const lot = q[0]!;
      const matched = Math.min(lot.remaining, toClose);

      const openPrice = lot.fill.filledPrice!;
      const closePrice = fill.filledPrice!;
      const grossPnl = (closePrice - openPrice) * CONTRACT_MULTIPLIER * matched;

      // Fees are per-FILL; apportion by the fraction of each leg consumed.
      const openFeeShare = (lot.fill.fees! * matched) / lot.fill.contracts;
      const closeFeeShare = (fill.fees! * matched) / fill.contracts;

      // Implicit cost: distance from mid, both legs, always a COST (abs) —
      // a fill better than mid is price improvement, not negative friction we
      // get to book as profit twice.
      const openSlip =
        Math.abs(openPrice - lot.fill.midAtSubmit!) * CONTRACT_MULTIPLIER * matched;
      const closeSlip = Math.abs(closePrice - fill.midAtSubmit!) * CONTRACT_MULTIPLIER * matched;

      const fees = openFeeShare + closeFeeShare;
      const slippageCost = openSlip + closeSlip;
      const netPnl = grossPnl - fees - slippageCost;
      const capitalAtRisk = openPrice * CONTRACT_MULTIPLIER * matched;

      roundTrips.push({
        sleeve: lot.fill.sleeve,
        book: lot.fill.book,
        optionSymbol: lot.fill.optionSymbol,
        // A pair is only 'live' if BOTH legs were. A paper leg anywhere makes
        // the round-trip paper evidence.
        source: lot.fill.source === 'live' && fill.source === 'live' ? 'live' : 'paper',
        openTs: lot.fill.ts,
        closeTs: fill.ts,
        daysHeld: Math.max(0, (fill.ts - lot.fill.ts) / 86_400_000),
        contracts: matched,
        openPrice,
        closePrice,
        grossPnl,
        fees,
        slippageCost,
        netPnl,
        netReturnPct: capitalAtRisk > 0 ? netPnl / capitalAtRisk : 0,
      });

      lot.remaining -= matched;
      toClose -= matched;
      if (lot.remaining <= 0) q.shift();
    }
    openQueues.set(key, q);

    if (toClose > 0) {
      // Closed more than we ever opened — an imported position, or a gap in the
      // ledger. Surfaced, never inferred away.
      unpaired.push({ fill, reason: 'no_matching_open' });
    }
  }

  // Whatever is still queued is an open position, not a discard.
  for (const q of openQueues.values()) {
    for (const lot of q) unpaired.push({ fill: lot.fill, reason: 'still_open' });
  }

  return { roundTrips, unpaired };
}

export interface CohortStats {
  n: number;
  sourceMix: { live: number; paper: number };
  winRate: number;
  avgWin: number;
  avgLoss: number;
  /** Per-trade dollar expectancy, net of both cost layers. */
  expectancy: number;
  /** Gross profit ÷ gross loss. `null` when there are no losses to divide by. */
  profitFactor: number | null;
  grossProfit: number;
  grossLoss: number;
  totalNetPnl: number;
  totalFees: number;
  totalSlippage: number;
  /** Mean and SD of per-trade NET RETURN — the inputs to the power calc. */
  meanNetReturnPct: number;
  stdDevNetReturnPct: number;
  /** Compounded, not summed. See the module docblock, layer 3. */
  compoundedReturnPct: number;
  /** Worst peak-to-trough of the cumulative net-P&L curve, in dollars. */
  maxDrawdown: number;
}

/**
 * Summarise a cohort. Pass ONE sleeve and ONE source unless you specifically
 * want the pooled figure — pooling inflates σ, which inflates required N, which
 * is the opposite of what anyone wants here.
 */
export function computeCohortStats(trips: readonly RoundTrip[]): CohortStats {
  const n = trips.length;
  const empty: CohortStats = {
    n: 0,
    sourceMix: { live: 0, paper: 0 },
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    expectancy: 0,
    profitFactor: null,
    grossProfit: 0,
    grossLoss: 0,
    totalNetPnl: 0,
    totalFees: 0,
    totalSlippage: 0,
    meanNetReturnPct: 0,
    stdDevNetReturnPct: 0,
    compoundedReturnPct: 0,
    maxDrawdown: 0,
  };
  if (n === 0) return empty;

  const wins = trips.filter((t) => t.netPnl > 0);
  const losses = trips.filter((t) => t.netPnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const totalNetPnl = trips.reduce((s, t) => s + t.netPnl, 0);

  const returns = trips.map((t) => t.netReturnPct);
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  // Sample SD (n−1): these are a sample of the strategy's trades, not the
  // population. With n small — which is the entire situation here — the
  // population form understates σ and would flatter the power calc.
  const variance =
    n > 1 ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1) : 0;

  let compounded = 1;
  for (const r of returns) compounded *= 1 + r;

  let peak = 0;
  let cum = 0;
  let maxDrawdown = 0;
  for (const t of trips) {
    cum += t.netPnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    n,
    sourceMix: {
      live: trips.filter((t) => t.source === 'live').length,
      paper: trips.filter((t) => t.source === 'paper').length,
    },
    winRate: wins.length / n,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    expectancy: totalNetPnl / n,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    grossProfit,
    grossLoss,
    totalNetPnl,
    totalFees: trips.reduce((s, t) => s + t.fees, 0),
    totalSlippage: trips.reduce((s, t) => s + t.slippageCost, 0),
    meanNetReturnPct: mean,
    stdDevNetReturnPct: Math.sqrt(variance),
    compoundedReturnPct: compounded - 1,
    maxDrawdown,
  };
}

export interface PowerInput {
  /** Observed per-trade SD of net return. */
  stdDevNetReturnPct: number;
  /**
   * The smallest per-trade edge worth detecting, as a fraction. Setting this
   * loosely is the silent way to fake a passing gate: a larger assumed effect
   * needs a smaller sample, so an over-optimistic δ "proves" the strategy on
   * fewer trades than the evidence can actually support.
   */
  minDetectableEffectPct: number;
  /** Two-sided significance. Default 0.05. */
  alpha?: number;
  /** Desired power. Default 0.80. */
  power?: number;
}

export interface PowerResult {
  requiredN: number;
  alpha: number;
  power: number;
  stdDevNetReturnPct: number;
  minDetectableEffectPct: number;
}

/** Inverse standard normal CDF (Acklam). Adequate for the α/β range used here. */
function probit(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError(`probit domain: ${p}`);
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pLow) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/**
 * Required sample size for a one-sample test that mean net return > 0.
 *
 *   n = (z_{1−α/2} + z_{1−β})² · σ² / δ²
 *
 * THE POINT OF SURFACING THIS. n scales with σ², so the ONLY legitimate way to
 * reach the bar sooner is to shrink σ — measure costs exactly instead of
 * estimating them, and scope the cohort to one sleeve and one regime instead of
 * pooling. Halving σ cuts required N by four. Lowering α or inflating δ also
 * cuts N, but those buy a smaller number rather than better evidence.
 */
export function requiredSampleSize(input: PowerInput): PowerResult {
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;
  const { stdDevNetReturnPct: sd, minDetectableEffectPct: delta } = input;
  if (!(delta > 0)) throw new RangeError('minDetectableEffectPct must be > 0');
  if (!(sd >= 0)) throw new RangeError('stdDevNetReturnPct must be >= 0');
  const zAlpha = probit(1 - alpha / 2);
  const zBeta = probit(power);
  const requiredN = Math.ceil(((zAlpha + zBeta) ** 2 * sd ** 2) / delta ** 2);
  return { requiredN, alpha, power, stdDevNetReturnPct: sd, minDetectableEffectPct: delta };
}

export interface ValidationVerdict {
  sleeve: string;
  stats: CohortStats;
  power: PowerResult;
  observedN: number;
  /** Live-only count. The gate's own bar; paper never substitutes for it. */
  observedLiveN: number;
  shortfall: number;
  /** Fraction of required N accrued, capped at 1. */
  progress: number;
  passes: boolean;
  blockers: string[];
}

/**
 * Grade a sleeve against the gate.
 *
 * `passes` requires BOTH statistical power and a positive net-of-fee result. It
 * is deliberately not reachable on paper alone: `requireLiveN` defaults to the
 * full required N, so a paper cohort can show a strategy is WORTH validating
 * live, and can size how long that will take, but cannot itself authorise
 * capital. Lowering `requireLiveN` is an explicit, auditable operator decision.
 */
export function gradeSleeve(opts: {
  sleeve: string;
  trips: readonly RoundTrip[];
  minDetectableEffectPct: number;
  alpha?: number;
  power?: number;
  minProfitFactor?: number;
  requireLiveN?: number;
}): ValidationVerdict {
  const trips = opts.trips.filter((t) => t.sleeve === opts.sleeve);
  const stats = computeCohortStats(trips);
  const power = requiredSampleSize({
    stdDevNetReturnPct: stats.stdDevNetReturnPct,
    minDetectableEffectPct: opts.minDetectableEffectPct,
    alpha: opts.alpha,
    power: opts.power,
  });
  const minPf = opts.minProfitFactor ?? 1.3;
  const requireLiveN = opts.requireLiveN ?? power.requiredN;

  const blockers: string[] = [];
  if (stats.n < power.requiredN) {
    blockers.push(`underpowered: ${stats.n} of ${power.requiredN} required (σ=${stats.stdDevNetReturnPct.toFixed(4)})`);
  }
  if (stats.sourceMix.live < requireLiveN) {
    blockers.push(`live cohort ${stats.sourceMix.live} of ${requireLiveN} required — paper accrual does not authorise capital`);
  }
  if (stats.expectancy <= 0) {
    blockers.push(`non-positive net-of-fee expectancy: ${stats.expectancy.toFixed(2)}`);
  }
  if (stats.profitFactor !== null && stats.profitFactor < minPf) {
    blockers.push(`profit factor ${stats.profitFactor.toFixed(2)} below ${minPf}`);
  }
  if (stats.profitFactor === null && stats.n > 0) {
    blockers.push('profit factor undefined (no losing trades yet) — cohort is not yet representative');
  }

  return {
    sleeve: opts.sleeve,
    stats,
    power,
    observedN: stats.n,
    observedLiveN: stats.sourceMix.live,
    shortfall: Math.max(0, power.requiredN - stats.n),
    progress: power.requiredN > 0 ? Math.min(1, stats.n / power.requiredN) : 0,
    passes: blockers.length === 0,
    blockers,
  };
}
