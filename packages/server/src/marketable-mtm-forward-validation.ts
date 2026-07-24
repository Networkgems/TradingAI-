// TRA-2247 (parent TRA-2242 → TRA-2233 → TRA-2174) — the SHARED, single-source-of-truth
// fold for the marketable(bid) MTM forward-validation gate.
//
// ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
// The gate's verdict was computed ONLY by the standalone CLI harness
// `scripts/marketable-mtm-forward-validation.mjs` (TRA-2243, `89c806e`), which reads
// `sandbox-strategy-journal.jsonl` off the live bqb1 `/data` disk. But NO deployed route
// exposed the raw sandbox legs, so once accrual reached n≥30 there was no way to run the
// gate against live data (bqb1 admin auth is dead by design, TRA-1992; the raw JSONL is
// not a no-auth surface). This module lifts the harness's EXACT exit-leg fold
// (`toSample` → `summarize` → `verdict`) into the server so a no-auth health route can
// emit the verdict from the in-memory `getSandboxStrategyRecords()` series — QuantTrader
// reads the PASS/REVIEW with one curl (TRA-2242's final check).
//
// The `.mjs` harness stays the CLI for offline `--file` runs; both implement the identical
// documented identity below, and `marketable-mtm-forward-validation.test.ts` pins the two
// to the SAME numeric output on a shared synthetic corpus so they cannot silently drift.
//
// ── THE PARITY-TRUE GROUND TRUTH (pin this exactly — TRA-2242) ────────────────
// The DARK marketable mark (packages/server/src/marketable-open-mtm.ts) values an open
// long at `mid · (1 − h)`, h = MODELED half-spread fraction (DEFAULT 0.134). The real
// Tradier-fill cross lives on the SANDBOX round-trip's EXIT leg (`legs[last]`, TRA-2134,
// acct VA20296703). Per exit leg, using `requestedPx` (the decision-quote MID = what the
// demo book marks at) and `fillPx` (the REAL broker avg fill):
//     signedCross = exit.side === 'buy' ? (fillPx − requestedPx)   // short exit: bought UP
//                                       : (requestedPx − fillPx)   // long  exit: sold DOWN
//     actualH     = signedCross / requestedPx        // SIGNED fraction — keep the sign
//     exitCrossUsd= signedCross · 1 · 100            // single-contract, SIGNED $
// It is SIGNED on purpose: a fill at/through the mid (actualH ≤ 0) is genuine parity
// evidence that the modeled haircut is too aggressive. Dropping non-positive crosses would
// BIAS the median upward — a biased sampler that manufactures a half-spread out of a
// symmetric fill distribution. We restrict to the EXIT leg because `actualH` recovers the
// exit half-spread that `mid · (1 − h)` prices (this is the same per-leg identity TRA-2237
// parity-reconcile folds, but that route folds entry AND exit together, in bps — NOT the
// statistic this gate needs).
//
// ── THE VERDICT ──────────────────────────────────────────────────────────────
// PASS iff median(actualH) is within ±tol of modeled h AND the tail is not UNDER-charged
// (`p90(modeledCrossUsd) ≥ p90(actualCrossUsd)`): a mark that haircuts LESS than the real
// fill re-inflates realizable P&L — the exact bias this ticket removes. Below `minN`
// computable samples the verdict is REVIEW (insufficient n), never PASS — a detector that
// cannot fire must not read like one that passes.
//
// ── CAVEAT that MUST ride the payload (TRA-2242 must weigh it) ────────────────
// Tradier SANDBOX fills are broker-SIMULATED (`fillRealism:'SANDBOX_SIMULATED'`): no real
// queue position or partial-fill-under-load, so a near-mid median here may UNDERSTATE the
// spread a live exit pays. This measures the parity-true source we HAVE; it does not
// certify live realism. Read-only, SANDBOX only, $0 notional; gates/arms NOTHING under the
// TRA-1897 hold.

import { DEFAULT_MARKETABLE_HALF_SPREAD_FRAC } from './marketable-open-mtm.js';
import { FILL_REALISM } from './tradier-sandbox-options-smoke.js';
import type { SandboxStrategyRecord } from './sandbox-strategy-journal.js';

/** Modeled half-spread the gate validates — the SAME default the DARK mark prices at. */
export const MARKETABLE_MTM_DEFAULT_H = DEFAULT_MARKETABLE_HALF_SPREAD_FRAC;
/** Default tolerance band on `|median(actualH) − h|` for a PASS. */
export const MARKETABLE_MTM_DEFAULT_TOL = 0.03;
/** Minimum computable samples before the verdict can leave REVIEW. */
export const MARKETABLE_MTM_DEFAULT_MIN_N = 30;
/** Option contract multiplier; qty assumed 1 (TRA-2134 single-contract round-trips). */
const CONTRACT_MULTIPLIER = 100;

export const MARKETABLE_MTM_SCOPE =
  'SANDBOX ONLY (acct VA20296703), $0 real notional. Parity-true EXIT-leg cross folded '
  + 'from the sandbox round-trip itself (mid vs real fill) — NEVER pooled with demo '
  + 'option-trade-journal rows. Read-only observable under the TRA-1897 hold; the '
  + 'marketable(bid) MTM flag it forward-validates arms/gates nothing here.';

/** Percentile by linear interpolation on a sorted-ascending sample; `NaN` on empty.
 *  p=0.5 ⇒ median, p=0.9 ⇒ p90. n=1 returns that value for any p. Matches the harness. */
function quantile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
const mean = (xs: readonly number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;

/** Signed cost of crossing the spread AWAY from the decision mid, for one leg. */
function signedCross(side: string, requestedPx: number, fillPx: number): number {
  return side === 'buy' ? fillPx - requestedPx : requestedPx - fillPx;
}

/** One parity-true validation sample recovered from a sandbox round-trip's EXIT leg. */
export interface MarketableMtmSample {
  structure: string;
  /** Exit-leg decision mid per share (= `requestedPx`, what the demo book marks at). */
  exitMidPerShare: number;
  /** Realized exit cross, $ — SIGNED (`signedCross · 1 · 100`). */
  exitCrossUsd: number;
  /** Realized exit half-spread fraction — SIGNED (`signedCross / requestedPx`). */
  actualH: number;
  /** Realized ENTRY-leg half-spread fraction (reference only), or `null` when unpriced. */
  hEntry: number | null;
}

/**
 * Turn one sandbox round-trip into a validation sample, or `null` when it cannot falsify a
 * bid model: no exit leg, a one-sided decision quote (`requestedPx` ≤ 0 / non-finite), an
 * unfilled exit (`fillPx` non-finite), or an unusable side. The realized cross is kept
 * SIGNED — a fill at/through the mid is real evidence, not something to filter out (that
 * would bias the measured half-spread upward). `strategyFilter` (optional) restricts to one
 * `strategy` tag. Pure; mirrors the harness `toSample`.
 */
export function sampleFromRecord(
  rec: SandboxStrategyRecord,
  strategyFilter?: string | null,
): MarketableMtmSample | null {
  if (!Array.isArray(rec.legs) || rec.legs.length < 2) return null; // need entry + exit
  if (strategyFilter && rec.strategy !== strategyFilter) return null;
  const entry = rec.legs[0];
  const exit = rec.legs[rec.legs.length - 1]; // recordFromContractResult: legs = [entry, exit]

  // Reject null BEFORE any Number() coercion: `Number(null) === 0` is finite, so a one-sided
  // quote (`requestedPx: null`) or an unfilled leg (`fillPx: null`) would otherwise slip
  // through as a bogus $0 price and manufacture a ~100% cross — the same null-as-0 false-zero
  // parity-reconcile guards. A missing price is NEVER folded; it is EXCLUDED.
  if (exit.requestedPx == null || exit.fillPx == null) return null;
  const reqExit = Number(exit.requestedPx);
  const fillExit = Number(exit.fillPx);
  if (!Number.isFinite(reqExit) || reqExit <= 0) return null; // one-sided decision quote — unprovable
  if (!Number.isFinite(fillExit)) return null;                // exit never filled — unprovable
  if (exit.side !== 'buy' && exit.side !== 'sell') return null;

  const per = CONTRACT_MULTIPLIER; // contracts = 1; actualH is a fraction and qty-invariant
  const signed = signedCross(exit.side, reqExit, fillExit);
  const actualH = signed / reqExit;   // realized EXIT half-spread fraction (SIGNED)
  const exitCrossUsd = signed * per;  // realized EXIT cross, $ (SIGNED)

  // Realized ENTRY-leg half-spread, as a reference, when the entry leg is priced.
  let hEntry: number | null = null;
  if (entry != null && entry.requestedPx != null && entry.fillPx != null) {
    const reqEntry = Number(entry.requestedPx);
    const fillEntry = Number(entry.fillPx);
    if (Number.isFinite(reqEntry) && reqEntry > 0 && Number.isFinite(fillEntry) &&
        (entry.side === 'buy' || entry.side === 'sell')) {
      hEntry = signedCross(entry.side, reqEntry, fillEntry) / reqEntry;
    }
  }

  return {
    structure: rec.strategy ?? 'unknown',
    exitMidPerShare: reqExit,
    exitCrossUsd,
    actualH,
    hEntry,
  };
}

export interface MarketableMtmSummary {
  n: number;
  modeledH: number;
  actualH: { mean: number; median: number; p90: number };
  actualCrossUsd: { mean: number; median: number; p90: number };
  modeledCrossUsd: { mean: number; median: number; p90: number };
  modelErrorUsd: { mean: number; median: number };
  entryH: { n: number; mean: number };
}

/** Fold a set of samples into the comparison summary at modeled half-spread `h`. Pure. */
export function summarizeMarketableMtm(
  samples: readonly MarketableMtmSample[],
  h: number,
): MarketableMtmSummary {
  const actualHs = samples.map((s) => s.actualH).sort((a, b) => a - b);
  const actualCross = samples.map((s) => s.exitCrossUsd).sort((a, b) => a - b);
  // Modeled cross under the flag's h, using the SAME exit mid the actual cross was measured
  // against, so the two are dollar-comparable per row.
  const modeledCross = samples
    .map((s) => h * s.exitMidPerShare * CONTRACT_MULTIPLIER)
    .sort((a, b) => a - b);
  const errUsd = samples.map((s) => h * s.exitMidPerShare * CONTRACT_MULTIPLIER - s.exitCrossUsd);
  const withEntry = samples.filter((s) => s.hEntry != null);
  return {
    n: samples.length,
    modeledH: h,
    actualH: { mean: mean(actualHs), median: quantile(actualHs, 0.5), p90: quantile(actualHs, 0.9) },
    actualCrossUsd: { mean: mean(actualCross), median: quantile(actualCross, 0.5), p90: quantile(actualCross, 0.9) },
    modeledCrossUsd: { mean: mean(modeledCross), median: quantile(modeledCross, 0.5), p90: quantile(modeledCross, 0.9) },
    modelErrorUsd: { mean: mean(errUsd), median: quantile([...errUsd].sort((a, b) => a - b), 0.5) },
    entryH: withEntry.length
      ? { n: withEntry.length, mean: mean(withEntry.map((s) => s.hEntry as number)) }
      : { n: 0, mean: Number.NaN },
  };
}

export interface MarketableMtmVerdict {
  code: 'PASS' | 'REVIEW';
  reason: string;
}

/**
 * PASS iff the measured median realized `actualH` is within `±tol` of the modeled `h` AND
 * the modeled p90 cross covers the actual p90 cross (the tail is not UNDER-charged). Below
 * `minN` computable samples ⇒ REVIEW (insufficient n) — never PASS. Pure; mirrors the
 * harness `verdict`.
 */
export function marketableMtmVerdict(
  summary: MarketableMtmSummary,
  tol: number,
  minN: number,
): MarketableMtmVerdict {
  if (summary.n < minN) {
    return { code: 'REVIEW', reason: `insufficient n (${summary.n} < ${minN}); accrue more parity-true sandbox round-trips` };
  }
  const withinTol = Math.abs(summary.actualH.median - summary.modeledH) <= tol;
  const tailNotUnderCharged = summary.modeledCrossUsd.p90 >= summary.actualCrossUsd.p90;
  if (withinTol && tailNotUnderCharged) {
    return { code: 'PASS', reason: `median realized h ${summary.actualH.median.toFixed(4)} within ±${tol} of modeled ${summary.modeledH}; tail covered` };
  }
  const bits: string[] = [];
  if (!withinTol) bits.push(`median realized h ${summary.actualH.median.toFixed(4)} outside ±${tol} of modeled ${summary.modeledH} (retune h ≈ ${summary.actualH.median.toFixed(3)})`);
  if (!tailNotUnderCharged) bits.push(`modeled p90 cross $${summary.modeledCrossUsd.p90.toFixed(2)} < actual p90 $${summary.actualCrossUsd.p90.toFixed(2)} (under-charges the tail)`);
  return { code: 'REVIEW', reason: bits.join('; ') };
}

export interface MarketableMtmForwardValidation {
  n: number;
  modeledH: number;
  tol: number;
  minN: number;
  actualH: { mean: number; median: number; p90: number };
  actualCrossUsd: { mean: number; median: number; p90: number };
  modeledCrossUsd: { mean: number; median: number; p90: number };
  modelErrorUsd: { mean: number; median: number };
  entryH: { n: number; mean: number };
  verdict: MarketableMtmVerdict;
  fillRealism: typeof FILL_REALISM;
  strategy: string | null;
  /** Sandbox round-trips that had no falsifiable exit-leg cross (excluded from `n`). */
  excludedRecords: number;
  totalRecords: number;
}

export interface MarketableMtmOptions {
  h?: number;
  tol?: number;
  minN?: number;
  strategy?: string | null;
}

/**
 * End-to-end fold from the raw sandbox journal series to the gate payload — the single
 * source of truth the health route emits and the harness mirrors. Pure (no IO). Records
 * with no falsifiable exit-leg cross are excluded from `n` and counted in `excludedRecords`
 * so a reader can tell "few samples" from "many unpriced".
 */
export function foldMarketableMtmForwardValidation(
  records: readonly SandboxStrategyRecord[],
  opts: MarketableMtmOptions = {},
): MarketableMtmForwardValidation {
  const h = opts.h ?? MARKETABLE_MTM_DEFAULT_H;
  const tol = opts.tol ?? MARKETABLE_MTM_DEFAULT_TOL;
  const minN = opts.minN ?? MARKETABLE_MTM_DEFAULT_MIN_N;
  const strategy = opts.strategy ?? null;

  const samples: MarketableMtmSample[] = [];
  for (const rec of records) {
    const s = sampleFromRecord(rec, strategy);
    if (s != null) samples.push(s);
  }
  const summary = summarizeMarketableMtm(samples, h);
  const v = marketableMtmVerdict(summary, tol, minN);
  return {
    ...summary,
    tol,
    minN,
    verdict: v,
    fillRealism: FILL_REALISM,
    strategy,
    excludedRecords: records.length - samples.length,
    totalRecords: records.length,
  };
}
