// TRA-1656 (TRA-1602B) — MEASURE the option spread cross, in R units.
//
// The cost-aware fire bar (TRA-1602, `option-cost-gate.ts`) rests on a spread
// cross that was never measured: `makerAdjustedSpreadCrossR = 1.00R`, carrying
// its own admission that it is "INTERIM (modeled, not measured)". That number is
// the DOMINANT term in the shipped 1.25R bar, so every downstream verdict — most
// of all TRA-1647's "the book cannot cover its cost" — is an artifact of it until
// it is replaced by a measurement. This module is the measurement.
//
// ── The R basis (this is the whole ballgame) ─────────────────────────────────
// Both option sites stop at `mark * 0.75` (see `signal-engine.ts`, the RV and OTM
// signal builders), so the trade's at-risk STOP distance is
//
//     R = entryMark − stopPrice = 0.25 · entryMark
//
// which is the unit `estimateModeledGrossR` and therefore the cost gate speak in.
// The ROUND-TRIP spread cross (buy at the ask, sell at the bid) costs the full
// quoted spread, so
//
//     spreadCrossR = (ask − bid) / (0.25 · mark) = 4 · spreadPct
//
// where `spreadPct = (ask − bid) / mark` is the quantity the scanners already
// compute and liquidity-filter on. That identity is the load-bearing fact here.
//
// ⚠ The journal's OWN `realizedR` uses a DIFFERENT basis: `atRiskUsd` is stamped
// as the full premium paid (`options-account.ts` passes `totalCost`), so journal
// R = premium, not 0.25·premium. The two are a factor of 4 apart. We therefore
// report BOTH bases on every row so a reader can never silently compare a
// stop-basis cost against a premium-basis return. `spreadCrossR` is the STOP
// basis (the gate's unit, the one TRA-1656 asks for); `spreadCrossRPremiumBasis`
// is the journal's.
//
// ── Selection-independent ceiling ────────────────────────────────────────────
// The scanners hard-reject any contract whose `spreadPct` exceeds `maxSpreadPct`
// BEFORE it can ever be selected (OTM: 0.20, RV: 0.10 — see the engine scanner
// option defaults). Via the identity above that is a hard upper bound on the
// cross of ANY contract the sleeve is even allowed to buy:
//
//     OTM: spreadPct ≤ 0.20 ⇒ spreadCrossR ≤ 0.80
//     RV : spreadPct ≤ 0.10 ⇒ spreadCrossR ≤ 0.40
//
// This bound does not depend on which contracts the sleeve actually picks, so it
// holds no matter how the selection is distributed. The gate's 1.00R input sits
// ABOVE both ceilings: it charges every candidate more than the worst contract
// the scanner could possibly admit. See {@link SLEEVE_SPREAD_CEILINGS}.
//
// Observe-only: nothing here routes an order or gates an admission. It measures.

/** The at-risk stop distance as a fraction of the entry mark (stop = mark·0.75). */
export const STOP_DISTANCE_FRACTION_OF_MARK = 0.25;

/**
 * The scanner-enforced `maxSpreadPct` per sleeve, converted through
 * `spreadCrossR = 4 · spreadPct` into the hard ceiling on the round-trip cross
 * of any contract that sleeve can admit. Sourced from the engine scanner option
 * defaults (`otm-mispricing.ts` maxSpreadPct 0.20, `relative-value.ts` 0.10).
 *
 * These are CEILINGS, not estimates — the measured means are far lower. They
 * exist so a reviewer can falsify a proposed cost input without any data at all:
 * any `makerAdjustedSpreadCrossR` above the ceiling is infeasible by construction.
 */
export const SLEEVE_SPREAD_CEILINGS: Readonly<Record<string, { maxSpreadPct: number; maxSpreadCrossR: number }>> = {
  single_leg_otm: { maxSpreadPct: 0.2, maxSpreadCrossR: 0.8 },
  single_leg_rv: { maxSpreadPct: 0.1, maxSpreadCrossR: 0.4 },
};

/** A two-sided quote captured at fill time. */
export interface FillQuote {
  /** Per-share bid at fill. */
  bid: number;
  /** Per-share ask at fill. */
  ask: number;
  /** Per-share mark (mid) the fill booked against. */
  mark: number;
}

/** The measured spread cross for one fill, in dollars and in both R bases. */
export interface SpreadCrossMeasurement {
  /** Round-trip cross in dollars per share: `ask − bid`. */
  spreadCrossUsdPerShare: number;
  /** `(ask − bid) / mark` — the quantity the scanners liquidity-filter on. */
  spreadPct: number;
  /** Round-trip cross in the GATE's R unit (R = 0.25·mark). The number TRA-1656 asks for. */
  spreadCrossR: number;
  /** Round-trip cross in the JOURNAL's R unit (R = full premium). 4× smaller. */
  spreadCrossRPremiumBasis: number;
  /** The mark the cross is measured against — makes the R conversion auditable. */
  entryMarkUsd: number;
}

/**
 * Measure the round-trip spread cross for a single fill quote. Returns `null`
 * when the quote is unusable (non-finite, non-positive mark, crossed book), so
 * an unmeasurable fill DROPS OUT of the rollup rather than being counted as a
 * free (zero-cost) fill — the failure mode that would bias the measured cost
 * toward zero and re-open exactly the hole this ticket exists to close.
 */
export function measureSpreadCross(quote: FillQuote): SpreadCrossMeasurement | null {
  const { bid, ask, mark } = quote;
  if (![bid, ask, mark].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (mark <= 0 || bid < 0 || ask <= 0) return null;
  if (ask < bid) return null; // crossed / corrupt book

  const spreadCrossUsdPerShare = ask - bid;
  const spreadPct = spreadCrossUsdPerShare / mark;
  return {
    spreadCrossUsdPerShare,
    spreadPct,
    spreadCrossR: spreadPct / STOP_DISTANCE_FRACTION_OF_MARK,
    spreadCrossRPremiumBasis: spreadPct,
    entryMarkUsd: mark,
  };
}

/** Commission in R (stop basis) for a round trip on `contracts` contracts. */
export function commissionR(
  entryMarkUsd: number,
  contracts: number,
  perContractPerSideUsd: number,
): number | null {
  if (!Number.isFinite(entryMarkUsd) || entryMarkUsd <= 0) return null;
  if (!Number.isFinite(contracts) || contracts <= 0) return null;
  if (!Number.isFinite(perContractPerSideUsd) || perContractPerSideUsd < 0) return null;
  // Round trip = 2 sides. R in dollars = 0.25 · mark · 100 · contracts.
  const roundTripUsd = 2 * perContractPerSideUsd * contracts;
  const rUsd = STOP_DISTANCE_FRACTION_OF_MARK * entryMarkUsd * 100 * contracts;
  if (rUsd <= 0) return null;
  return roundTripUsd / rUsd;
}

/** One measurable fill: the structure it fired under plus its fill-time quote. */
export interface SpreadCostSample {
  structure: string;
  quote: FillQuote;
  /** Contracts filled — only needed for the commission-in-R term. */
  contracts?: number;
}

/** The measured rollup for one structure. Mirrors the TRA-1656 probe shape. */
export interface StructureSpreadCost {
  structure: string;
  /** Fills carrying a usable fill-time quote. The honest `n`. */
  n: number;
  /** THE number: measured round-trip cross / R, R = 0.25·mark (the gate's unit). */
  avgSpreadCrossR: number;
  medianSpreadCrossR: number;
  /** The mean is skewed by illiquid names; p90 is the tail a bar must survive. */
  p90SpreadCrossR: number;
  /** Same measurement in the journal's premium basis (4× smaller). */
  avgSpreadCrossRPremiumBasis: number;
  /** Dollar terms, so the R conversion is auditable end-to-end. */
  avgSpreadCrossUsd: number;
  avgEntryMarkUsd: number;
  /** Measured round-trip commission in R — checks the gate's 0.05R input. */
  avgCommissionR: number | null;
  /** The scanner-enforced ceiling, when the structure has one. */
  maxSpreadCrossR: number | null;
  /**
   * Re-derived admission bar for this structure from the MEASURED cross:
   * `avgCommissionR + avgSpreadCrossR + safetyMargin`. This is what the gate's
   * bar should be, versus the 1.25R it currently is.
   */
  impliedBarR: number;
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0] as number;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loV = sorted[lo] as number;
  if (lo === hi) return loV;
  const hiV = sorted[hi] as number;
  return loV + (hiV - loV) * (idx - lo);
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface SpreadCostSummaryOptions {
  /** Tradier options commission per contract per side (default $0.35). */
  commissionPerContractPerSideUsd?: number;
  /** Safety margin used to re-derive the implied bar (default 0.20R, the gate's). */
  safetyMarginR?: number;
}

/**
 * Fold a set of measurable fills into the per-structure measured spread-cost
 * rollup. Samples whose quote is unusable are dropped (never zero-filled), so
 * `n` is always the count of genuinely MEASURED fills — the quantity the
 * TRA-1656 acceptance bar (`n >= 50`) is stated against. Pure.
 */
export function summarizeSpreadCost(
  samples: readonly SpreadCostSample[],
  options: SpreadCostSummaryOptions = {},
): StructureSpreadCost[] {
  const commissionPerSide = options.commissionPerContractPerSideUsd ?? 0.35;
  const safetyMarginR = options.safetyMarginR ?? 0.2;

  const byStructure = new Map<string, Array<{ m: SpreadCrossMeasurement; contracts?: number }>>();
  for (const s of samples) {
    const m = measureSpreadCross(s.quote);
    if (!m) continue;
    const bucket = byStructure.get(s.structure) ?? [];
    bucket.push({ m, ...(s.contracts !== undefined ? { contracts: s.contracts } : {}) });
    byStructure.set(s.structure, bucket);
  }

  const out: StructureSpreadCost[] = [];
  for (const [structure, rows] of byStructure) {
    const crossR = rows.map((r) => r.m.spreadCrossR).sort((a, b) => a - b);
    const commissions = rows
      .map((r) => (r.contracts === undefined ? null : commissionR(r.m.entryMarkUsd, r.contracts, commissionPerSide)))
      .filter((v): v is number => v !== null);

    const avgSpreadCrossR = mean(crossR);
    const avgCommissionR = commissions.length > 0 ? mean(commissions) : null;
    const ceiling = SLEEVE_SPREAD_CEILINGS[structure]?.maxSpreadCrossR ?? null;

    out.push({
      structure,
      n: rows.length,
      avgSpreadCrossR,
      medianSpreadCrossR: quantile(crossR, 0.5),
      p90SpreadCrossR: quantile(crossR, 0.9),
      avgSpreadCrossRPremiumBasis: mean(rows.map((r) => r.m.spreadCrossRPremiumBasis)),
      avgSpreadCrossUsd: mean(rows.map((r) => r.m.spreadCrossUsdPerShare)),
      avgEntryMarkUsd: mean(rows.map((r) => r.m.entryMarkUsd)),
      avgCommissionR,
      maxSpreadCrossR: ceiling,
      impliedBarR: (avgCommissionR ?? 0.05) + avgSpreadCrossR + safetyMarginR,
    });
  }
  return out.sort((a, b) => a.structure.localeCompare(b.structure));
}
