// TRA-2247 (parent TRA-2242 → TRA-2233 → TRA-2174), instrument repair TRA-2283 — the
// SHARED, single-source-of-truth fold for the marketable(bid) MTM forward-validation gate.
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
// ── TRA-2283: THREE DEFECTS THAT MADE THIS INSTRUMENT LIE ─────────────────────
// D1 — `fillPx = 0` sailed through the guard and manufactured a ~100% half-spread.
//   `reqExit` was rejected at `<= 0` but `fillExit` was only checked for finiteness, so a
//   literal `0` fill was FOLDED — and `actualH = signedCross / reqExit` then evaluates to
//   EXACTLY +1 (sell exit) or −1 (buy exit). That is the same false zero the null-check two
//   lines above it exists to stop, arriving through a different door. On the live 30-record
//   corpus this was 4 rows (13%), and they were the SOLE source of every per-structure mean
//   of ±0.13 AND of both tail-coverage failures. Both legs of those 4 round-trips were
//   zero-filled, which is independently visible as `meanSlippageBps ≈ −1262 / −1251 /
//   −1418 / −1443` on `sandbox-strategy-journal` (one `0`-fill leg scores −10_000bps).
//   Fixed on BOTH sides: the writer no longer records a non-positive fill as a number
//   (`sandbox-strategy-journal.ts::usableFillPrice`), and this reader drops it and reports
//   the count as `excludedZeroFill` so the exclusion is auditable rather than inferred.
//
// D2 — `actualH` is a detector that CANNOT FIRE on this venue, so the gate needs `quotedH`.
//   All three sandbox routes report `fillRealism: 'SANDBOX_SIMULATED'`, and the venue fills
//   at the DECISION MID. Strip the 4 zero-fill rows and the remaining rows sit at
//   `actualH` 0.0015–0.0046 with an `actualCrossUsd` median of $1.00 — 1 to 4 PENNIES on a
//   1-lot, i.e. minimum-tick quantization, not a bid-ask cross. `entryH` says the same on
//   the other leg: in a real book you pay to cross in BOTH directions; here neither leg
//   pays. So `requestedPx`-vs-`fillPx` measures ~0 whatever the true spread is, and no
//   amount of further accrual can change that. Retuning `h` 0.134 → 0.002 to force a PASS
//   would collapse the marketable(bid) haircut to numerically indistinguishable from
//   mid-marking — the exact unrealizable-mark failure (TRA-2131 shape) that TRA-2233
//   exists to prevent. The fix is to measure the modeled half-spread against the QUOTED
//   BOOK (`bid`/`ask` now persisted at decision time, TRA-2283 D2) via
//   `marketable-open-mtm.ts::halfSpreadFracFromQuoteForSide`. **The quote is REAL even when
//   the fill is not** — that is what makes a simulated-fill venue able to validate a bid
//   model at all. `quotedH` is emitted ALONGSIDE `actualH` with its own verdict; it does not
//   silently become the gate. Which of the two QuantTrader grades on is QuantTrader's call.
//
// D3 — the POOLED verdict hid a per-structure tail under-charge.
//   Pooling four structures whose means were ±0.13 with signs that flip with structure
//   DIRECTION (long_call/long_put open with a BUY; csp/covered_call with a SELL) cancelled
//   them to ~0.0026, and the pooled tail check read "tail covered" (`modeled p90 $61.14 ≥
//   actual p90 $4.00`) while long_call was under-charged 2.8× ($199.80 actual vs $72.08
//   modeled) and long_put 1.6×. A pooled median masking a per-structure tail under-charge is
//   the single most dangerous direction for a valuation haircut to be wrong in. The verdict
//   is now emitted PER STRUCTURE as well as pooled, and **the pooled verdict FAILS if ANY
//   structure's tail is under-charged** — the pooled fold can no longer absolve a structure
//   that individually under-charges.
//
// ── THE VERDICT ──────────────────────────────────────────────────────────────
// PASS iff median(actualH) is within ±tol of modeled h AND the tail is not UNDER-charged
// (`p90(modeledCrossUsd) ≥ p90(actualCrossUsd)`) POOLED **AND** per structure: a mark that
// haircuts LESS than the real fill re-inflates realizable P&L — the exact bias this ticket
// removes. Below `minN` computable samples the verdict is REVIEW (insufficient n), never
// PASS — a detector that cannot fire must not read like one that passes.
//
// ── CAVEAT that MUST ride the payload (TRA-2242 must weigh it) ────────────────
// Tradier SANDBOX fills are broker-SIMULATED (`fillRealism:'SANDBOX_SIMULATED'`): no real
// queue position or partial-fill-under-load, so a near-mid median here may UNDERSTATE the
// spread a live exit pays. This measures the parity-true source we HAVE; it does not
// certify live realism. Read-only, SANDBOX only, $0 notional; gates/arms NOTHING under the
// TRA-1897 hold.

import {
  DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
  MAX_MARKETABLE_HALF_SPREAD_FRAC,
  halfSpreadFracFromQuoteForSide,
} from './marketable-open-mtm.js';
import { FILL_REALISM } from './tradier-sandbox-options-smoke.js';
import type { SandboxStrategyRecord, SandboxStrategyLeg } from './sandbox-strategy-journal.js';

/** Modeled half-spread the gate validates — the SAME default the DARK mark prices at. */
export const MARKETABLE_MTM_DEFAULT_H = DEFAULT_MARKETABLE_HALF_SPREAD_FRAC;
/** Default tolerance band on `|median(actualH) − h|` for a PASS. */
export const MARKETABLE_MTM_DEFAULT_TOL = 0.03;
/** Minimum computable samples before the verdict can leave REVIEW. */
export const MARKETABLE_MTM_DEFAULT_MIN_N = 30;
/** Option contract multiplier; qty assumed 1 (TRA-2134 single-contract round-trips). */
const CONTRACT_MULTIPLIER = 100;
/**
 * `|actualH|` above this is an implausible half-spread — a 50%-of-mid half-spread already
 * means the bid sits at HALF the mid. Deliberately equal to
 * {@link MAX_MARKETABLE_HALF_SPREAD_FRAC}, the point past which the DARK mark itself
 * clamps: anything the mark would refuse to price is something this gate should NAME
 * rather than average into a moment. TRA-2283 D4.
 */
export const MARKETABLE_MTM_OUTLIER_ABS_H = MAX_MARKETABLE_HALF_SPREAD_FRAC;
/** Cap on rows echoed in the diagnostics block / `samples` dump, so the payload stays bounded. */
export const MARKETABLE_MTM_MAX_DIAGNOSTIC_ROWS = 50;

export const MARKETABLE_MTM_SCOPE =
  'SANDBOX ONLY (acct VA20296703), $0 real notional. Parity-true EXIT-leg cross folded '
  + 'from the sandbox round-trip itself (mid vs real fill) — NEVER pooled with demo '
  + 'option-trade-journal rows. Read-only observable under the TRA-1897 hold; the '
  + 'marketable(bid) MTM flag it forward-validates arms/gates nothing here.';

/**
 * Why the fill-derived `actualH` cannot falsify a bid model on this venue (TRA-2283 D2).
 * Rides the payload so no reader grades a ~0 median as "the model is wrong by 0.132".
 */
export const MARKETABLE_MTM_ACTUAL_H_CAVEAT =
  'actualH is measured requestedPx-vs-fillPx, and this venue (fillRealism SANDBOX_SIMULATED) '
  + 'fills at the DECISION MID — so actualH reads ~0 whether the true spread is 0 or the '
  + 'simulator merely ignores it. It is NOT evidence that modeled h is too high, and the '
  + 'verdict string\'s "retune h" suggestion MUST NOT be actioned off it. Grade the model on '
  + 'quotedH (measured off the two-sided QUOTED book, which is real even when the fill is '
  + 'not); read actualH only as a floor on realized cross.';

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

/** A leg price is usable iff it is a finite, strictly POSITIVE number. A `0` is a missing
 *  price wearing a number's clothes — see the D1 note in the module header. */
function usablePx(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One parity-true validation sample recovered from a sandbox round-trip's EXIT leg. */
export interface MarketableMtmSample {
  structure: string;
  /** ET calendar day of the source round-trip (diagnostics / auditability). */
  etDay: string;
  /** Exit-leg side: `sell` closes a long, `buy` closes a short. */
  exitSide: 'buy' | 'sell';
  /** Exit-leg decision mid per share (= `requestedPx`, what the demo book marks at). */
  exitMidPerShare: number;
  /** Realized exit cross, $ — SIGNED (`signedCross · 1 · 100`). */
  exitCrossUsd: number;
  /** Realized exit half-spread fraction — SIGNED (`signedCross / requestedPx`). */
  actualH: number;
  /** Realized ENTRY-leg half-spread fraction (reference only), or `null` when unpriced. */
  hEntry: number | null;
  /**
   * Half-spread fraction read off the EXIT leg's two-sided QUOTED book at decision time,
   * on the side the position actually exits through (`sell` ⇒ mid→bid, `buy` ⇒ mid→ask).
   * `null` when the record carries no usable quote — which is EVERY record written before
   * TRA-2283 D2 persisted `bid`/`ask`, so expect `quotedH.n === 0` until fresh round-trips
   * accrue. This is the falsifiable measurement (see D2 in the module header).
   */
  quotedH: number | null;
  /** True ⇔ `quotedH` hit the `[0, MAX_MARKETABLE_HALF_SPREAD_FRAC]` clamp (a very wide book). */
  quotedHClamped: boolean;
}

/** Why a record produced no sample. Mutually exclusive, evaluated in this order. */
export type MarketableMtmDropReason =
  | 'too_few_legs'
  | 'strategy_filter'
  | 'unpriced_exit_quote'
  | 'unfilled_exit'
  | 'zero_fill_exit'
  | 'bad_exit_side';

/** A row dropped for a non-positive exit `fillPx` — the D1 false zero, made checkable. */
export interface MarketableMtmZeroFillRow {
  structure: string;
  etDay: string;
  exitSide: string;
  exitMidPerShare: number;
  exitFillPx: number;
  /** The `actualH` this row WOULD have contributed had it been folded: exactly ±1. */
  wouldBeActualH: number;
  /** True ⇔ the ENTRY leg was ALSO zero-filled (the observed shape: both legs at $0). */
  entryAlsoZeroFill: boolean;
}

/** {@link sampleFromRecord} plus the reason a `null` happened, for auditable exclusion counts. */
export interface MarketableMtmClassified {
  sample: MarketableMtmSample | null;
  drop: MarketableMtmDropReason | null;
  /** Present only when `drop === 'zero_fill_exit'`. */
  zeroFill: MarketableMtmZeroFillRow | null;
}

/** Read the persisted decision-quote off a leg. Tolerates pre-TRA-2283 legs (no `bid`/`ask`). */
function legQuote(leg: SandboxStrategyLeg | undefined): { bid?: number; ask?: number } {
  const bid = leg == null ? null : usablePxOrZero(leg.bid);
  const ask = leg == null ? null : usablePx(leg.ask);
  return {
    ...(bid != null ? { bid } : {}),
    ...(ask != null ? { ask } : {}),
  };
}

/** A BID of exactly `0` is legitimate (no buyers) — unlike a fill price, it is a real quote.
 *  So the bid is admitted at `>= 0` while everything else requires `> 0`. */
function usablePxOrZero(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Turn one sandbox round-trip into a validation sample AND the reason it was dropped when
 * it cannot falsify a bid model: no exit leg, a one-sided decision quote (`requestedPx` ≤ 0
 * / non-finite), an unfilled exit (`fillPx` null / non-finite), a FALSE-ZERO exit fill
 * (`fillPx <= 0` — TRA-2283 D1), or an unusable side. The realized cross is kept SIGNED — a
 * fill at/through the mid is real evidence, not something to filter out (that would bias the
 * measured half-spread upward). `strategyFilter` (optional) restricts to one `strategy` tag.
 * Pure; mirrors the harness `toSample`.
 */
export function classifyRecord(
  rec: SandboxStrategyRecord,
  strategyFilter?: string | null,
): MarketableMtmClassified {
  const drop = (d: MarketableMtmDropReason): MarketableMtmClassified =>
    ({ sample: null, drop: d, zeroFill: null });

  if (!Array.isArray(rec.legs) || rec.legs.length < 2) return drop('too_few_legs'); // need entry + exit
  if (strategyFilter && rec.strategy !== strategyFilter) return drop('strategy_filter');
  const entry = rec.legs[0];
  const exit = rec.legs[rec.legs.length - 1]; // recordFromContractResult: legs = [entry, exit]

  // Reject null BEFORE any Number() coercion: `Number(null) === 0` is finite, so a one-sided
  // quote (`requestedPx: null`) or an unfilled leg (`fillPx: null`) would otherwise slip
  // through as a bogus $0 price and manufacture a ~100% cross — the same null-as-0 false-zero
  // parity-reconcile guards. A missing price is NEVER folded; it is EXCLUDED.
  if (exit.requestedPx == null) return drop('unpriced_exit_quote');
  if (exit.fillPx == null) return drop('unfilled_exit');
  const reqExit = Number(exit.requestedPx);
  const fillExit = Number(exit.fillPx);
  if (!Number.isFinite(reqExit) || reqExit <= 0) return drop('unpriced_exit_quote'); // one-sided quote
  if (!Number.isFinite(fillExit)) return drop('unfilled_exit');                      // never filled
  // TRA-2283 D1 — SYMMETRIC with `reqExit`: a non-positive fill is a MISSING price, and
  // folding it yields `actualH` of exactly ±1 (a 100% half-spread) out of a contract that
  // traded near its mid. Counted separately as `excludedZeroFill` so the drop is auditable
  // from the route instead of reconstructed from published moments.
  if (fillExit <= 0) {
    const entryFillZero = entry != null && entry.fillPx != null
      && Number.isFinite(Number(entry.fillPx)) && Number(entry.fillPx) <= 0;
    return {
      sample: null,
      drop: 'zero_fill_exit',
      zeroFill: {
        structure: rec.strategy ?? 'unknown',
        etDay: rec.etDay,
        exitSide: exit.side,
        exitMidPerShare: reqExit,
        exitFillPx: fillExit,
        wouldBeActualH: signedCross(exit.side, reqExit, fillExit) / reqExit,
        entryAlsoZeroFill: entryFillZero,
      },
    };
  }
  if (exit.side !== 'buy' && exit.side !== 'sell') return drop('bad_exit_side');

  const per = CONTRACT_MULTIPLIER; // contracts = 1; actualH is a fraction and qty-invariant
  const signed = signedCross(exit.side, reqExit, fillExit);
  const actualH = signed / reqExit;   // realized EXIT half-spread fraction (SIGNED)
  const exitCrossUsd = signed * per;  // realized EXIT cross, $ (SIGNED)

  // TRA-2283 D2 — the half-spread off the QUOTED book, on the side this position exits
  // through: a `sell` exit closes a LONG (realizes at the bid), a `buy` exit closes a SHORT
  // (pays the ask). `halfSpreadFracFromQuoteForSide` carries the crossed-book / non-finite
  // guards and the shared clamp, so a corrupt quote yields `null`, never a manufactured mark.
  const quotedRaw = halfSpreadFracFromQuoteForSide(
    { ...legQuote(exit), mark: reqExit },
    exit.side === 'sell' ? 'long' : 'short',
  );
  const quotedHClamped = quotedRaw != null && quotedRaw >= MAX_MARKETABLE_HALF_SPREAD_FRAC;

  // Realized ENTRY-leg half-spread, as a reference, when the entry leg is priced. Guards the
  // entry fill at `> 0` symmetrically with the exit leg (TRA-2283 D1): a zero-filled entry
  // leg yields `hEntry` of exactly ∓1, which is what made every structure's `entryH` read as
  // very nearly the negative of its `actualH`.
  let hEntry: number | null = null;
  if (entry != null) {
    const reqEntry = usablePx(entry.requestedPx);
    const fillEntry = usablePx(entry.fillPx);
    if (reqEntry != null && fillEntry != null && (entry.side === 'buy' || entry.side === 'sell')) {
      hEntry = signedCross(entry.side, reqEntry, fillEntry) / reqEntry;
    }
  }

  return {
    sample: {
      structure: rec.strategy ?? 'unknown',
      etDay: rec.etDay,
      exitSide: exit.side,
      exitMidPerShare: reqExit,
      exitCrossUsd,
      actualH,
      hEntry,
      quotedH: quotedRaw,
      quotedHClamped,
    },
    drop: null,
    zeroFill: null,
  };
}

/** Back-compatible sample accessor — see {@link classifyRecord} for the drop reason. */
export function sampleFromRecord(
  rec: SandboxStrategyRecord,
  strategyFilter?: string | null,
): MarketableMtmSample | null {
  return classifyRecord(rec, strategyFilter).sample;
}

export interface MarketableMtmMoments { mean: number; median: number; p90: number }

export interface MarketableMtmSummary {
  n: number;
  modeledH: number;
  actualH: MarketableMtmMoments;
  actualCrossUsd: MarketableMtmMoments;
  modeledCrossUsd: MarketableMtmMoments;
  modelErrorUsd: { mean: number; median: number };
  entryH: { n: number; mean: number };
  /**
   * TRA-2283 D2 — the QUOTED-book half-spread distribution. `n` counts samples carrying a
   * usable two-sided quote; `0` until round-trips booked after the D2 deploy accrue (legs
   * written earlier persisted no `bid`/`ask`). `clamped` counts quotes so wide they hit
   * {@link MAX_MARKETABLE_HALF_SPREAD_FRAC}. Moments are `NaN` at `n === 0` — a reader must
   * treat that as "not yet measurable", never as 0.
   */
  quotedH: { n: number; clamped: number } & MarketableMtmMoments;
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
  const quoted = samples
    .map((s) => s.quotedH)
    .filter((q): q is number => q != null)
    .sort((a, b) => a - b);
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
    quotedH: {
      n: quoted.length,
      clamped: samples.filter((s) => s.quotedHClamped).length,
      mean: mean(quoted),
      median: quantile(quoted, 0.5),
      p90: quantile(quoted, 0.9),
    },
  };
}

export interface MarketableMtmVerdict {
  code: 'PASS' | 'REVIEW';
  reason: string;
}

/** `true` when the modeled p90 cross fails to cover the actual p90 cross — the model
 *  haircuts LESS than the real tail, re-inflating realizable P&L. */
function tailUnderCharged(summary: MarketableMtmSummary): boolean {
  return !(summary.modeledCrossUsd.p90 >= summary.actualCrossUsd.p90);
}

/** How many × the actual tail exceeds the modeled tail, or `null` when it does not. */
function tailUnderChargeRatio(summary: MarketableMtmSummary): number | null {
  const m = summary.modeledCrossUsd.p90;
  const a = summary.actualCrossUsd.p90;
  if (!Number.isFinite(m) || !Number.isFinite(a) || m <= 0 || a <= m) return null;
  return a / m;
}

/**
 * PASS iff the measured median realized `actualH` is within `±tol` of the modeled `h` AND
 * the modeled p90 cross covers the actual p90 cross (the tail is not UNDER-charged). Below
 * `minN` computable samples ⇒ REVIEW (insufficient n) — never PASS. Pure; mirrors the
 * harness `verdict`. Used as-is for each PER-STRUCTURE verdict; the POOLED verdict adds the
 * cross-structure tail check (see {@link marketableMtmPooledVerdict}).
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
  const tailOk = !tailUnderCharged(summary);
  if (withinTol && tailOk) {
    return { code: 'PASS', reason: `median realized h ${summary.actualH.median.toFixed(4)} within ±${tol} of modeled ${summary.modeledH}; tail covered` };
  }
  const bits: string[] = [];
  // NOTE (TRA-2283 D2): the parenthetical is a DESCRIPTION of where the measured median sits,
  // NOT an instruction. On a SANDBOX_SIMULATED venue that fills at the decision mid, actualH
  // is ~0 by construction, so "retune h ≈ 0.002" would collapse the haircut to mid-marking.
  // See MARKETABLE_MTM_ACTUAL_H_CAVEAT, which rides the payload next to this string.
  if (!withinTol) bits.push(`median realized h ${summary.actualH.median.toFixed(4)} outside ±${tol} of modeled ${summary.modeledH} (measured median ≈ ${summary.actualH.median.toFixed(3)} — do NOT retune h off a SANDBOX_SIMULATED fill; see actualHCaveat)`);
  if (!tailOk) bits.push(`modeled p90 cross $${summary.modeledCrossUsd.p90.toFixed(2)} < actual p90 $${summary.actualCrossUsd.p90.toFixed(2)} (under-charges the tail)`);
  return { code: 'REVIEW', reason: bits.join('; ') };
}

/** Per-structure fold — the unpooled view (TRA-2283 D3). */
export interface MarketableMtmStructureBreakdown extends MarketableMtmSummary {
  structure: string;
  /** `modeledCrossUsd.p90 < actualCrossUsd.p90` for THIS structure alone. */
  tailUnderCharged: boolean;
  /** `actualCrossUsd.p90 / modeledCrossUsd.p90` when under-charged; `null` otherwise. */
  tailUnderChargeRatio: number | null;
  /** This structure's own verdict at the same `tol`/`minN` as the pooled gate. */
  verdict: MarketableMtmVerdict;
}

/**
 * The POOLED verdict, hardened against the fold that hid a per-structure tail
 * under-charge (TRA-2283 D3).
 *
 * On the live 30-record corpus the pooled tail check read "covered" (`modeled p90 $61.14 ≥
 * actual p90 $4.00`) while long_call was under-charged 2.8× and long_put 1.6×. Pooling
 * cannot be allowed to absolve a structure that individually under-charges its tail, so any
 * such structure forces REVIEW and is NAMED in the reason.
 *
 * `requirePerStructureMinN` additionally demands every structure reach `minN` on its own
 * (n=7–8 per structure is exactly where one bad row moves a mean by 0.13). It defaults to
 * FALSE: `minN` is QuantTrader's threshold to set, so this ships as a reportable switch
 * (`structuresBelowMinN` is always emitted) rather than a unilateral tightening.
 */
export function marketableMtmPooledVerdict(
  summary: MarketableMtmSummary,
  structures: readonly MarketableMtmStructureBreakdown[],
  tol: number,
  minN: number,
  requirePerStructureMinN = false,
): MarketableMtmVerdict {
  const base = marketableMtmVerdict(summary, tol, minN);
  const bits: string[] = [];

  const under = structures.filter((s) => s.tailUnderCharged);
  if (under.length > 0) {
    const named = [...under]
      .sort((a, b) => (b.tailUnderChargeRatio ?? Infinity) - (a.tailUnderChargeRatio ?? Infinity))
      .map((s) => {
        const ratio = s.tailUnderChargeRatio;
        const mult = ratio != null ? `${ratio.toFixed(1)}×` : 'modeled p90 ≤ 0';
        return `${s.structure} (n=${s.n}, actual p90 $${s.actualCrossUsd.p90.toFixed(2)} vs modeled $${s.modeledCrossUsd.p90.toFixed(2)} — under-charged ${mult})`;
      })
      .join(', ');
    bits.push(`per-structure tail UNDER-CHARGED: ${named}`);
  }

  const below = structures.filter((s) => s.n < minN).map((s) => `${s.structure} (n=${s.n})`);
  if (requirePerStructureMinN && below.length > 0) {
    bits.push(`insufficient per-structure n (< ${minN}): ${below.join(', ')}`);
  }

  if (bits.length === 0) return base;
  // A pooled PASS is REVOKED by any per-structure failure; a pooled REVIEW keeps its own
  // reason and gains the per-structure detail.
  const prefix = base.code === 'REVIEW' ? `${base.reason}; ` : '';
  return { code: 'REVIEW', reason: `${prefix}${bits.join('; ')}` };
}

/** TRA-2283 D4 — the checkable diagnostic: outlier moments + the DROPPED false-zero rows. */
export interface MarketableMtmDiagnostics {
  /** `|actualH|` above this counts as an outlier ({@link MARKETABLE_MTM_OUTLIER_ABS_H}). */
  outlierAbsHThreshold: number;
  /** Retained samples with `|actualH| > outlierAbsHThreshold`. Expected 0 once D1 is live. */
  outlierCount: number;
  /** Min/max `actualH` across retained samples; `null` at n=0. */
  minActualH: number | null;
  maxActualH: number | null;
  /** The outlier rows themselves, capped at {@link MARKETABLE_MTM_MAX_DIAGNOSTIC_ROWS}. */
  outlierRows: MarketableMtmSample[];
  /**
   * The rows EXCLUDED for a non-positive exit `fillPx`, each with the exactly-±1 `actualH`
   * it would have contributed. This is the direct read that replaces reconstructing the
   * defect from published moments.
   */
  zeroFillRows: MarketableMtmZeroFillRow[];
  /** True ⇔ a row was dropped or echoed past the cap (so a reader never reads a cap as a total). */
  truncated: boolean;
}

export interface MarketableMtmForwardValidation extends MarketableMtmSummary {
  tol: number;
  minN: number;
  verdict: MarketableMtmVerdict;
  fillRealism: typeof FILL_REALISM;
  strategy: string | null;
  /** Sandbox round-trips that had no falsifiable exit-leg cross (excluded from `n`). */
  excludedRecords: number;
  /**
   * TRA-2283 D1 — records excluded because the exit leg reported a NON-POSITIVE `fillPx`
   * (the false zero that folds to `actualH` = ±1 exactly). Distinct from
   * `excludedRecords`, which counts every exclusion including the `strategy` filter.
   */
  excludedZeroFill: number;
  /** Full exclusion breakdown, so "few samples" vs "many unpriced" needs no inference. */
  exclusions: Record<MarketableMtmDropReason, number>;
  /** TRA-2283 D3 — the unpooled verdict, one entry per structure, `n`-descending. */
  perStructure: MarketableMtmStructureBreakdown[];
  /** Structures below `minN` on their own — always reported (see {@link marketableMtmPooledVerdict}). */
  structuresBelowMinN: string[];
  /** Whether the pooled verdict enforced per-structure `minN` this call. */
  requirePerStructureMinN: boolean;
  diagnostics: MarketableMtmDiagnostics;
  /** Per-row samples, only when `includeSamples` is set. Capped; see `diagnostics.truncated`. */
  samples?: MarketableMtmSample[];
  actualHCaveat: string;
  totalRecords: number;
}

export interface MarketableMtmOptions {
  h?: number;
  tol?: number;
  minN?: number;
  strategy?: string | null;
  /** Enforce `minN` per structure in the POOLED verdict too (default false). */
  requirePerStructureMinN?: boolean;
  /** Echo the per-row samples on the payload (capped). */
  includeSamples?: boolean;
}

function emptyExclusions(): Record<MarketableMtmDropReason, number> {
  return {
    too_few_legs: 0,
    strategy_filter: 0,
    unpriced_exit_quote: 0,
    unfilled_exit: 0,
    zero_fill_exit: 0,
    bad_exit_side: 0,
  };
}

/**
 * End-to-end fold from the raw sandbox journal series to the gate payload — the single
 * source of truth the health route emits and the harness mirrors. Pure (no IO). Records
 * with no falsifiable exit-leg cross are excluded from `n`, counted in `excludedRecords`,
 * and broken out by reason in `exclusions` (+ `excludedZeroFill` for the TRA-2283 D1 false
 * zero) so a reader can tell "few samples" from "many unpriced" from "silently corrupted".
 */
export function foldMarketableMtmForwardValidation(
  records: readonly SandboxStrategyRecord[],
  opts: MarketableMtmOptions = {},
): MarketableMtmForwardValidation {
  const h = opts.h ?? MARKETABLE_MTM_DEFAULT_H;
  const tol = opts.tol ?? MARKETABLE_MTM_DEFAULT_TOL;
  const minN = opts.minN ?? MARKETABLE_MTM_DEFAULT_MIN_N;
  const strategy = opts.strategy ?? null;
  const requirePerStructureMinN = opts.requirePerStructureMinN ?? false;

  const samples: MarketableMtmSample[] = [];
  const exclusions = emptyExclusions();
  const zeroFillRows: MarketableMtmZeroFillRow[] = [];
  for (const rec of records) {
    const c = classifyRecord(rec, strategy);
    if (c.sample != null) {
      samples.push(c.sample);
      continue;
    }
    if (c.drop != null) exclusions[c.drop] += 1;
    if (c.zeroFill != null) zeroFillRows.push(c.zeroFill);
  }

  const summary = summarizeMarketableMtm(samples, h);

  // ── D3: unpool ────────────────────────────────────────────────────────────
  const byStructure = new Map<string, MarketableMtmSample[]>();
  for (const s of samples) {
    const list = byStructure.get(s.structure) ?? [];
    list.push(s);
    byStructure.set(s.structure, list);
  }
  const perStructure: MarketableMtmStructureBreakdown[] = [...byStructure.entries()]
    .map(([structure, list]) => {
      const sub = summarizeMarketableMtm(list, h);
      return {
        structure,
        ...sub,
        tailUnderCharged: tailUnderCharged(sub),
        tailUnderChargeRatio: tailUnderChargeRatio(sub),
        verdict: marketableMtmVerdict(sub, tol, minN),
      };
    })
    .sort((a, b) => b.n - a.n || a.structure.localeCompare(b.structure));

  const v = marketableMtmPooledVerdict(summary, perStructure, tol, minN, requirePerStructureMinN);

  // ── D4: diagnostics ───────────────────────────────────────────────────────
  const cap = MARKETABLE_MTM_MAX_DIAGNOSTIC_ROWS;
  const outlierRows = samples.filter((s) => Math.abs(s.actualH) > MARKETABLE_MTM_OUTLIER_ABS_H);
  const actualHs = samples.map((s) => s.actualH);
  const diagnostics: MarketableMtmDiagnostics = {
    outlierAbsHThreshold: MARKETABLE_MTM_OUTLIER_ABS_H,
    outlierCount: outlierRows.length,
    minActualH: actualHs.length ? Math.min(...actualHs) : null,
    maxActualH: actualHs.length ? Math.max(...actualHs) : null,
    outlierRows: outlierRows.slice(0, cap),
    zeroFillRows: zeroFillRows.slice(0, cap),
    truncated: outlierRows.length > cap || zeroFillRows.length > cap
      || (opts.includeSamples === true && samples.length > cap),
  };

  return {
    ...summary,
    tol,
    minN,
    verdict: v,
    fillRealism: FILL_REALISM,
    strategy,
    excludedRecords: records.length - samples.length,
    excludedZeroFill: exclusions.zero_fill_exit,
    exclusions,
    perStructure,
    structuresBelowMinN: perStructure.filter((s) => s.n < minN).map((s) => s.structure),
    requirePerStructureMinN,
    diagnostics,
    ...(opts.includeSamples === true ? { samples: samples.slice(0, cap) } : {}),
    actualHCaveat: MARKETABLE_MTM_ACTUAL_H_CAVEAT,
    totalRecords: records.length,
  };
}
