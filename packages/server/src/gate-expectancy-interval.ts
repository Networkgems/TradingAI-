// TRA-4735 (CFO ruling TRA-4734) — the 2σ interval on the graded book's cost-net
// expectancy, and the ONE-SIDED stopping rule it licenses.
//
// `n_req = (2σ/δ)²` (gate-power.ts) is a DESIGN-STAGE sample size: how many rows it
// takes to resolve an effect to ±δ when the mean sits NEAR the bar. It is not a
// stopping rule. `positive_expectancy` asks one one-sided question — is E[netR] above
// the bar? — and when the whole interval already sits below the bar that question is
// answered long before n_req. Live bqb1 2026-09-19: n=63, mean −0.0629R, upper 2σ
// bound +0.0493R against a 0.10R bar, printed as "a PASS or FAIL would be a coin flip".
//
// The rule is ASYMMETRIC by design: this module can only ever produce a FAIL. PASS
// stays on `power.powered ∧ measured pass`, untouched.
//
// SE_eff is the MAX of four estimators, because with ~8 week-clusters no single
// clustering is defensible and a FAIL must survive the worst of them:
//   1. iid           sd/√n  (n−1 sd, same `pnlNetR ?? 0` fold as expectancyNetR)
//   2. CR1 by ISO week of resolvedAt
//   3. CR1 by surfacedWeek
//   4. CR1 by ticker
// CR1: var = G/(G−1) · Σ_g (Σ_{i∈g}(x_i − x̄))² / n².
// Any uncomputable estimator (G < 2, degenerate σ̂) makes SE_eff null, and a null
// SE_eff can never FAIL — fail-closed toward "no verdict", never toward FAIL.
//
// Pure — no I/O, no env, no clock.

import { sampleStdev } from './gate-power.js';

/** One graded row, reduced to what the estimators need. */
export interface ExpectancyIntervalObservation {
  /** Cost-net R (`pnlNetR ?? 0`, the gate's own fold). */
  x: number;
  /** ISO week of the settlement date (`resolvedAt`). */
  resolvedWeek: string;
  surfacedWeek: string;
  ticker: string;
}

/** Report-side estimators over the graded set (bar-independent). */
export interface ExpectancySeEstimates {
  n: number;
  /** UNROUNDED mean — the published `expectancyNetR` is rounded to 2 dp. */
  mean: number | null;
  seIid: number | null;
  seClusterResolvedWeek: number | null;
  seClusterSurfacedWeek: number | null;
  seClusterTicker: number | null;
  clusters: { resolvedWeek: number; surfacedWeek: number; ticker: number };
}

/** CR1 cluster-robust SE of the mean. Null when G < 2 or n < 2. */
export function cr1ClusterSe(
  xs: readonly number[],
  keys: readonly string[],
): { se: number | null; g: number } {
  const n = xs.length;
  const sums = new Map<string, number>();
  const m = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  xs.forEach((x, i) => sums.set(keys[i]!, (sums.get(keys[i]!) ?? 0) + (x - m)));
  const g = sums.size;
  if (n < 2 || g < 2) return { se: null, g };
  let ss = 0;
  for (const s of sums.values()) ss += s * s;
  const v = ((g / (g - 1)) * ss) / (n * n);
  return { se: Number.isFinite(v) ? Math.sqrt(v) : null, g };
}

export function computeExpectancySeEstimates(
  obs: readonly ExpectancyIntervalObservation[],
): ExpectancySeEstimates {
  const n = obs.length;
  const xs = obs.map((o) => o.x);
  const sd = sampleStdev(xs);
  const rw = cr1ClusterSe(xs, obs.map((o) => o.resolvedWeek));
  const sw = cr1ClusterSe(xs, obs.map((o) => o.surfacedWeek));
  const tk = cr1ClusterSe(xs, obs.map((o) => o.ticker));
  return {
    n,
    mean: n ? xs.reduce((a, b) => a + b, 0) / n : null,
    seIid: sd == null ? null : sd / Math.sqrt(n),
    seClusterResolvedWeek: rw.se,
    seClusterSurfacedWeek: sw.se,
    seClusterTicker: tk.se,
    clusters: { resolvedWeek: rw.g, surfacedWeek: sw.g, ticker: tk.g },
  };
}

export type ExpectancyDecidedBy = 'upper_bound_below_bar' | 'powered' | null;

/** The working, published on the gate route as `expectancyInterval` in every state. */
export interface ExpectancyInterval {
  n: number;
  mean: number | null;
  seIid: number | null;
  seClusterResolvedWeek: number | null;
  seClusterSurfacedWeek: number | null;
  seClusterTicker: number | null;
  clusters: { resolvedWeek: number; surfacedWeek: number; ticker: number };
  /** max of the four; null if ANY is uncomputable or σ̂ is degenerate. */
  seEff: number | null;
  upper2Sigma: number | null;
  lower2Sigma: number | null;
  barR: number;
  /** Filled by the gate: which rule produced `positive_expectancy`'s PASS/FAIL. */
  decidedBy: ExpectancyDecidedBy;
  /** `upper2Sigma < barR` (null-safe: false when the interval is uncomputable). */
  upperBelowBar: boolean;
}

export const INTERVAL_SIGMA = 2;
const r4 = (v: number | null): number | null => (v == null ? null : Math.round(v * 1e4) / 1e4);

/** Combine the report-side estimators with the bar. Absent estimates ⇒ uncomputable. */
export function buildExpectancyInterval(
  est: ExpectancySeEstimates | undefined,
  barR: number,
): ExpectancyInterval {
  const e: ExpectancySeEstimates = est ?? {
    n: 0,
    mean: null,
    seIid: null,
    seClusterResolvedWeek: null,
    seClusterSurfacedWeek: null,
    seClusterTicker: null,
    clusters: { resolvedWeek: 0, surfacedWeek: 0, ticker: 0 },
  };
  const ses = [e.seIid, e.seClusterResolvedWeek, e.seClusterSurfacedWeek, e.seClusterTicker];
  // Degenerate σ̂ (every row identical) gives an iid SE of 0 — an interval of zero
  // width is not evidence, so it is treated as uncomputable, never as a sharp FAIL.
  const computable =
    e.mean != null &&
    ses.every((s): s is number => s != null && Number.isFinite(s)) &&
    (e.seIid ?? 0) > 0;
  const seEff = computable ? Math.max(...(ses as number[])) : null;
  const upper = seEff == null ? null : e.mean! + INTERVAL_SIGMA * seEff;
  const lower = seEff == null ? null : e.mean! - INTERVAL_SIGMA * seEff;
  return {
    n: e.n,
    mean: r4(e.mean),
    seIid: r4(e.seIid),
    seClusterResolvedWeek: r4(e.seClusterResolvedWeek),
    seClusterSurfacedWeek: r4(e.seClusterSurfacedWeek),
    seClusterTicker: r4(e.seClusterTicker),
    clusters: e.clusters,
    seEff: r4(seEff),
    upper2Sigma: r4(upper),
    lower2Sigma: r4(lower),
    barR,
    decidedBy: null,
    // Compared UNROUNDED so the published 4-dp figures can never flip the verdict.
    upperBelowBar: upper != null && upper < barR,
  };
}
