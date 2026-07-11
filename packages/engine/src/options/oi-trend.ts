import type { OptionChainRow } from './otm-mispricing.js';

/**
 * TRA-1610 (parent TRA-1607) — Open-Interest trend read for equity options,
 * pure computation.
 *
 * We already pull per-contract `openInterest` on the Tradier chain but derive no
 * signal from it. The classic price × open-interest read (Investopedia "Using
 * Open Interest to Find Trends") is a 4-quadrant conviction filter: it asks
 * whether a price move is backed by NEW money (rising OI) or is just
 * position-shuffling (falling OI). This module is the DECISION-FREE, I/O-free
 * fold — it (a) sums OI across the tracked expiries and (b) classifies the
 * price/OI quadrant given the session-over-session deltas. The durable capture,
 * the prior-session delta bookkeeping, and the trio pairing live in the server
 * ledger (`oi-shadow-ledger.ts`), which QuantTrader validates on the TRA-532
 * promotion gate after a ≥200-signal shadow window. NOTHING here is wired to
 * live sizing or exits — shadow-first, $0 live.
 *
 * The 4-quadrant read (price direction × OI direction):
 *   price↑ / OI↑ → `strong`     — trend confirmed by fresh money      → confirm
 *   price↑ / OI↓ → `weakening`  — rally on unwinding, thinning         → caution
 *   price↓ / OI↑ → `weak`       — fresh shorts pressing the tape       → veto-candidate
 *   price↓ / OI↓ → `weakening`  — sellers covering, unwinding          → caution
 *
 * CADENCE NOTE: OCC open-interest updates ONCE DAILY (prior-close figure), so
 * this is a slow, session-spaced read, not an intraday one. The ledger computes
 * `oiDelta` session-over-session and pairs it with a session-over-session
 * `priceDelta` (close-to-close) so both legs of the quadrant share the same
 * daily cadence; it also stamps `oiAsOf` so a stale OI value isn't over-weighted.
 */

/** The article's 4-quadrant strength read. */
export type OiQuadrant = 'strong' | 'weak' | 'weakening';

/** Conviction mapped from the quadrant, for QuantTrader's filter measurement. */
export type OiConviction = 'confirm' | 'caution' | 'veto-candidate';

/** Sign of a session-over-session delta. */
export type DeltaDirection = 'up' | 'down' | 'flat';

export interface OiTotalsOptions {
  /**
   * Restrict aggregation to these expirations (YYYY-MM-DD). When omitted, every
   * row is aggregated — the caller is expected to have pre-filtered the snapshot
   * to the tracked window (near + next monthly).
   */
  expiries?: readonly string[];
  /**
   * Minimum count of contracts carrying a usable (>0) OI across the tracked
   * expiries. Below this the chain's OI is too thin/stale to trust, so
   * `oiTotal` is nulled and `reason` is set. Default 1 (any usable OI counts);
   * the server can raise it.
   */
  minContractsWithOi?: number;
}

export const OI_TREND_DEFAULTS = {
  minContractsWithOi: 1,
} as const;

export interface OiTotals {
  /** Σ open interest across the tracked expiries (calls + puts). null when unusable. */
  oiTotal: number | null;
  callOpenInterest: number;
  putOpenInterest: number;
  /** Count of contract rows that carried a usable (>0) OI — the liquidity basis. */
  contractsWithOi: number;
  /** Distinct expirations that contributed ≥1 OI-bearing row (ascending). */
  expiriesUsed: string[];
  /** True when no usable OI rows were present (or below the floor). */
  insufficientData: boolean;
  /** Why `oiTotal` is null, when applicable; null when clean. */
  reason: string | null;
}

/**
 * Fold a chain snapshot into total open interest across the tracked expiries.
 * Rows with a non-finite / non-positive OI contribute 0 and don't count toward
 * `contractsWithOi` — a missing or zero/stale OI never poisons the aggregate.
 * Equity-options only is the caller's responsibility.
 */
export function computeOiTotals(
  rows: readonly OptionChainRow[],
  opts: OiTotalsOptions = {},
): OiTotals {
  const floor = opts.minContractsWithOi ?? OI_TREND_DEFAULTS.minContractsWithOi;
  const expiryFilter = opts.expiries ? new Set(opts.expiries) : null;

  let callOpenInterest = 0;
  let putOpenInterest = 0;
  let contractsWithOi = 0;
  const expiries = new Set<string>();

  for (const r of rows) {
    if (expiryFilter && !expiryFilter.has(r.expiration)) continue;
    const oi =
      typeof r.openInterest === 'number' && Number.isFinite(r.openInterest) && r.openInterest > 0
        ? r.openInterest
        : 0;
    if (oi <= 0) continue;
    contractsWithOi += 1;
    expiries.add(r.expiration);
    if (r.optionType === 'put') putOpenInterest += oi;
    else if (r.optionType === 'call') callOpenInterest += oi;
  }

  const expiriesUsed = [...expiries].sort();
  const base = {
    callOpenInterest,
    putOpenInterest,
    contractsWithOi,
    expiriesUsed,
  } as const;

  if (contractsWithOi < floor) {
    return {
      ...base,
      oiTotal: null,
      insufficientData: true,
      reason:
        contractsWithOi === 0
          ? 'no_open_interest'
          : `insufficient_oi: ${contractsWithOi} contracts < floor ${floor}`,
    };
  }

  return {
    ...base,
    oiTotal: callOpenInterest + putOpenInterest,
    insufficientData: false,
    reason: null,
  };
}

/** Map a computed quadrant to its conviction bucket. */
export function oiQuadrantToConviction(quadrant: OiQuadrant): OiConviction {
  switch (quadrant) {
    case 'strong':
      return 'confirm';
    case 'weak':
      return 'veto-candidate';
    case 'weakening':
      return 'caution';
  }
}

export interface OiQuadrantReadOptions {
  /**
   * Deadband: a |priceDelta| at or below this is treated as `flat`. Default 0
   * (any nonzero move counts). Close-to-close prints rarely tie exactly.
   */
  priceFlatEps?: number;
  /**
   * Deadband: a |oiDelta| at or below this is treated as `flat`. Default 0.
   */
  oiFlatEps?: number;
}

export interface OiQuadrantRead {
  /** The 4-quadrant read; null when either leg is flat or a delta is missing. */
  quadrant: OiQuadrant | null;
  priceDirection: DeltaDirection | null;
  oiDirection: DeltaDirection | null;
  /** Conviction from the quadrant; null when the quadrant is null. */
  conviction: OiConviction | null;
  /** Why the quadrant is null (flat leg / missing prior snapshot), else null. */
  reason: string | null;
}

function direction(delta: number, eps: number): DeltaDirection {
  if (delta > eps) return 'up';
  if (delta < -eps) return 'down';
  return 'flat';
}

/**
 * Classify the price × OI quadrant from the session-over-session deltas. A null
 * delta (no prior snapshot yet) or a `flat` leg yields a null quadrant with a
 * reason — the article's read is only defined on the four directional corners,
 * so we don't manufacture a conviction where the tape is indeterminate. Those
 * rows are recorded but don't count toward the promotion window.
 */
export function classifyOiQuadrant(
  priceDelta: number | null,
  oiDelta: number | null,
  opts: OiQuadrantReadOptions = {},
): OiQuadrantRead {
  if (priceDelta === null || oiDelta === null) {
    return {
      quadrant: null,
      priceDirection: priceDelta === null ? null : direction(priceDelta, opts.priceFlatEps ?? 0),
      oiDirection: oiDelta === null ? null : direction(oiDelta, opts.oiFlatEps ?? 0),
      conviction: null,
      reason: 'no_prior_snapshot',
    };
  }

  const priceDir = direction(priceDelta, opts.priceFlatEps ?? 0);
  const oiDir = direction(oiDelta, opts.oiFlatEps ?? 0);

  if (priceDir === 'flat' || oiDir === 'flat') {
    return {
      quadrant: null,
      priceDirection: priceDir,
      oiDirection: oiDir,
      conviction: null,
      reason: priceDir === 'flat' ? 'flat_price' : 'flat_oi',
    };
  }

  let quadrant: OiQuadrant;
  if (priceDir === 'up') {
    // price↑ / OI↑ → strong (new money); price↑ / OI↓ → weakening (rally on unwind)
    quadrant = oiDir === 'up' ? 'strong' : 'weakening';
  } else {
    // price↓ / OI↑ → weak (fresh shorts); price↓ / OI↓ → weakening (unwind)
    quadrant = oiDir === 'up' ? 'weak' : 'weakening';
  }

  return {
    quadrant,
    priceDirection: priceDir,
    oiDirection: oiDir,
    conviction: oiQuadrantToConviction(quadrant),
    reason: null,
  };
}
