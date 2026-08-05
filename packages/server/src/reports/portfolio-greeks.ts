// TRA-844 — Layer-2 portfolio Greeks + theta-$ bleed + allocation rollup.
//
// Pure aggregation over the OPEN options book that nets per-contract
// Black-Scholes Greeks into a portfolio-level exposure view (delta / gamma /
// vega) plus the daily theta-$ bleed, and rolls premium notional up by
// underlying name and by sector. Closes the issue's "biggest risk blind spot":
// the dashboard previously showed per-row marks but never the netted
// directional / convexity / vol exposure or the book's concentration.
//
// The function takes a spot resolver (the engine has live underlying prices)
// rather than reaching into engine state, so it stays a pure, unit-testable
// primitive that both the live-state path (signal-engine) and the EOD report
// can call. Implied vol is solved per contract from its current mark + the
// resolved spot, so the Greeks reflect today's market rather than a stale
// entry-time snapshot.
import type { OptionPosition, PortfolioGreeks, AllocationBucket, GreeksUnvaluedReason } from '@trading-app/shared';
import { sectorOf, displayOptionMark } from '@trading-app/shared';
import { blackScholesGreeks, bsImpliedVolatility, daysToExpiration } from '@trading-app/engine';

/** Resolve an underlying ticker to its current spot price (or undefined/≤0 if unknown). */
export type SpotResolver = (symbol: string) => number | undefined;

export interface PortfolioGreeksOptions {
  /** Annualized risk-free rate for the BS solve. Defaults to 0.045 (the scanner default). */
  riskFreeRate?: number;
  /** Wall-clock ms used for time-to-expiry + the `asOf` stamp. Defaults to Date.now(). */
  now?: number;
}

const DEFAULT_RISK_FREE_RATE = 0.045;
const TRADING_DAYS_PER_YEAR = 365; // calendar-day theta to match dashboard "per day" convention

/** Per-position valuation: market notional plus book-scaled Greeks (0 when not valued). */
interface PositionValuation {
  symbol: string;
  notional: number;
  greeksValued: boolean;
  /** TRA-931 — set when `greeksValued` is false so the rollup can tally WHY. */
  unvaluedReason?: GreeksUnvaluedReason;
  deltaShares: number;     // Σ scaled to equivalent shares of underlying
  gammaShares: number;     // Δdelta (shares) per $1 underlying move
  vegaDollars: number;     // $ per +1 IV vol-point
  thetaDollarsDay: number; // $ per calendar day (negative for long premium)
}

/**
 * TRA-931 — resolve an open position's underlying spot. Prefers the caller's
 * live quote-tape resolver, but a tradeable single-leg position can have a live
 * option mark (the chain quote resolves) while its underlying is absent from the
 * watchlist tape (e.g. an RV scanner opened on an off-watchlist small-cap like
 * SPCX). Rather than leave such a position blind to the risk gate, fall back to
 * the entry-time `underlyingEntryPrice` the position persisted at open — stale,
 * but every engine-opened position carries it, so a tradeable position is always
 * priceable for Greeks. Returns undefined only when neither source yields a
 * positive finite number (truly unpriceable → honest `no_spot` under-count).
 */
function resolvePositionSpot(opt: OptionPosition, resolveSpot: SpotResolver): number | undefined {
  const live = resolveSpot(opt.symbol);
  if (Number.isFinite(live) && (live as number) > 0) return live;
  const entry = opt.underlyingEntryPrice;
  if (Number.isFinite(entry) && entry > 0) return entry;
  return undefined;
}

/** Tag an all-zero valuation with the reason Greeks were skipped. */
function unvalued(base: PositionValuation, reason: GreeksUnvaluedReason): PositionValuation {
  return { ...base, unvaluedReason: reason };
}

/**
 * Market value of one position's open premium. Uses the live mark when present,
 * else the entry premium paid; for multi-leg combos `premiumPaid` already
 * encodes the per-share reserved capital-at-risk, so this returns capital at
 * risk for them. Returns 0 (skip) when neither a mark nor a paid basis exists
 * or the remaining size is non-positive.
 */
function positionNotional(opt: OptionPosition): number {
  const qty = opt.contractsRemaining ?? opt.contracts;
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  // TRA-2890 — DISPLAY valuation: an open live row is valued at the
  // broker-tape last trade when present, so the Book Premium tile and the
  // allocation buckets equal the Options table and Tradier's positions view.
  // The "no mid → premium paid" fallback chain is unchanged.
  const disp = displayOptionMark(opt);
  const mark = Number.isFinite(disp) && disp > 0
    ? disp
    : (Number.isFinite(opt.premiumPaid) && opt.premiumPaid > 0 ? opt.premiumPaid : 0);
  if (mark <= 0) return 0;
  return mark * qty * 100;
}

function valuePosition(opt: OptionPosition, resolveSpot: SpotResolver, riskFreeRate: number, now: number): PositionValuation {
  const notional = positionNotional(opt);
  const base: PositionValuation = {
    symbol: opt.symbol,
    notional,
    greeksValued: false,
    deltaShares: 0,
    gammaShares: 0,
    vegaDollars: 0,
    thetaDollarsDay: 0,
  };
  if (notional <= 0) return base; // dropped entirely upstream — no reason tag needed

  // Multi-leg combos are defined-risk and have no single-contract mark to solve
  // an IV against, so we count their capital-at-risk notional in the allocation
  // buckets but skip Greeks rather than fabricate them from a per-share basis.
  if (Array.isArray(opt.legs) && opt.legs.length >= 2) return unvalued(base, 'multi_leg_combo');

  const qty = opt.contractsRemaining ?? opt.contracts;
  const spot = resolvePositionSpot(opt, resolveSpot);
  if (!Number.isFinite(spot) || (spot as number) <= 0) return unvalued(base, 'no_spot');
  if (opt.strike == null || !Number.isFinite(opt.strike) || opt.strike <= 0) return unvalued(base, 'bad_strike');
  if (!opt.expiration) return unvalued(base, 'expired');

  const days = daysToExpiration(opt.expiration, now);
  const T = days / 365;
  if (!Number.isFinite(T) || T <= 0) return unvalued(base, 'expired');

  // Solve IV from the current MID (per-share premium) so the Greeks track
  // today's market. TRA-2890 — deliberately NOT the display mark the notional
  // above uses: Greeks are a risk read, and solving IV off a stale last-trade
  // print on an illiquid contract would fabricate a vol surface from a price
  // nobody is quoting. Same "no mid → premium paid" fallback as before.
  const mark = Number.isFinite(opt.currentPremium) && opt.currentPremium > 0
    ? opt.currentPremium
    : opt.premiumPaid;
  const iv = bsImpliedVolatility({
    spot: spot as number,
    strike: opt.strike,
    timeToExpiryYears: T,
    riskFreeRate,
    optionType: opt.optionType,
    marketPrice: mark,
  });
  if (iv == null || !Number.isFinite(iv) || iv <= 0) return unvalued(base, 'no_iv_solve');

  const g = blackScholesGreeks({
    spot: spot as number,
    strike: opt.strike,
    timeToExpiryYears: T,
    riskFreeRate,
    volatility: iv,
    optionType: opt.optionType,
  });

  return {
    symbol: opt.symbol,
    notional,
    greeksValued: true,
    // ×100 shares per contract × qty contracts.
    deltaShares: g.delta * 100 * qty,
    gammaShares: g.gamma * 100 * qty,
    // vega is per 1.00 (100 vol points): /100 to a vol-point, ×100 to a contract → ×qty.
    vegaDollars: g.vega * qty,
    // annual theta → per calendar day, ×100 shares × qty contracts.
    thetaDollarsDay: (g.theta / TRADING_DAYS_PER_YEAR) * 100 * qty,
  };
}

/** Sort a `{key → {notional, positions}}` map into notional-descending allocation buckets. */
function buildBuckets(
  groups: Map<string, { notional: number; positions: number }>,
  totalNotional: number,
): AllocationBucket[] {
  return Array.from(groups.entries())
    .map(([key, v]) => ({
      key,
      notional: v.notional,
      pctOfBook: totalNotional > 0 ? v.notional / totalNotional : 0,
      positions: v.positions,
    }))
    .sort((a, b) => b.notional - a.notional);
}

/**
 * Aggregate the open options book into a {@link PortfolioGreeks} rollup. Pure:
 * deterministic given the same positions, spot resolver, and `now`.
 *
 * Positions that can't be valued for Greeks (no resolvable spot, no IV solve,
 * expired, or multi-leg combos) still contribute their premium notional to the
 * allocation buckets; `positionsValued < positionsTotal` surfaces that gap so a
 * consumer can show "Greeks cover N of M positions" rather than implying full
 * coverage. TRA-931 — `greeksUnvaluedReasons` tallies WHY each such gap exists
 * (combo vs no_spot vs no_iv_solve …) so the blind-spot case is distinguishable
 * from the benign combo case; single-leg positions fall back to their persisted
 * `underlyingEntryPrice` when the live resolver is blind, so a tradeable
 * position is priceable for Greeks even off the watchlist tape.
 */
export function computePortfolioGreeks(
  openOptions: readonly OptionPosition[],
  resolveSpot: SpotResolver,
  opts: PortfolioGreeksOptions = {},
): PortfolioGreeks {
  const riskFreeRate = opts.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const now = opts.now ?? Date.now();

  let netDelta = 0;
  let netGamma = 0;
  let netVega = 0;
  let thetaDollarsPerDay = 0;
  let netNotional = 0;
  let positionsValued = 0;
  let positionsTotal = 0;

  // TRA-931 — tally why notional-bearing positions skipped Greeks so a consumer
  // can tell a benign combo gap from a real spot/IV blind spot.
  const unvaluedReasons: Partial<Record<GreeksUnvaluedReason, number>> = {};

  const byName = new Map<string, { notional: number; positions: number }>();
  const bySector = new Map<string, { notional: number; positions: number }>();

  for (const opt of openOptions) {
    const v = valuePosition(opt, resolveSpot, riskFreeRate, now);
    if (v.notional <= 0) continue; // no premium to attribute — drop from the rollup entirely

    positionsTotal += 1;
    netNotional += v.notional;
    if (v.greeksValued) {
      positionsValued += 1;
      netDelta += v.deltaShares;
      netGamma += v.gammaShares;
      netVega += v.vegaDollars;
      thetaDollarsPerDay += v.thetaDollarsDay;
    } else if (v.unvaluedReason) {
      unvaluedReasons[v.unvaluedReason] = (unvaluedReasons[v.unvaluedReason] ?? 0) + 1;
    }

    const nameKey = (opt.symbol ?? 'UNKNOWN').toUpperCase();
    const name = byName.get(nameKey) ?? { notional: 0, positions: 0 };
    name.notional += v.notional;
    name.positions += 1;
    byName.set(nameKey, name);

    const sectorKey = sectorOf(opt.symbol);
    const sector = bySector.get(sectorKey) ?? { notional: 0, positions: 0 };
    sector.notional += v.notional;
    sector.positions += 1;
    bySector.set(sectorKey, sector);
  }

  return {
    netDelta,
    netGamma,
    netVega,
    thetaDollarsPerDay,
    netNotional,
    positionsValued,
    positionsTotal,
    byName: buildBuckets(byName, netNotional),
    bySector: buildBuckets(bySector, netNotional),
    ...(Object.keys(unvaluedReasons).length > 0 ? { greeksUnvaluedReasons: unvaluedReasons } : {}),
    asOf: now,
  };
}
