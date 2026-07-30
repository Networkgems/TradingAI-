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
// ── TRA-2300: THE GATE NOW GRADES `quotedH`. `actualH` IS ADVISORY. ───────────
// D2 above left the choice open ("which of the two QuantTrader grades on is QuantTrader's
// call"). That call is made: **the gate grades `quotedH`**. Four consequences live here:
//
//   §1 `quotedVerdict` is emitted alongside `verdict`, same shape and tolerance, decided on
//      `quotedH.median` vs `modeledH` and gated on **`quotedH.n`, not `summary.n`** (rows with
//      a usable FILL are not rows with a usable QUOTE; conflating them would let 30 quote-less
//      rows clear the floor and grade a verdict computed from NaN). `verdict` KEEPS its name so
//      an old-shaped consumer is never handed a different number under a name it trusts; every
//      verdict carries a `basis` field and `gradedBasis` names the graded one.
//   §2 The tail check — the direction that matters, since an under-charging haircut re-inflates
//      realizable P&L — now exists on the quoted basis too, per structure and pooled, with D3's
//      "any structure under-charged forces REVIEW" rule intact. It compares
//      `modeledCrossUsdOnQuoted.p90` against `quotedCrossUsd.p90`: the modeled leg is restricted
//      to the SAME quote-bearing rows, because a p90 over 26 rows vs a p90 over 4 different rows
//      is not a tail check.
//   §3 `quoteCoverage` splits the missing-quote zero into `legacy_no_quote_field` (no bid/ask KEY
//      — predates `4871bbc`, drains on its own) and `quote_null_at_snap` (keys present, snap
//      returned no book — the instrument is DEAD and can never be graded). Same observable
//      consequence, opposite diagnoses; `== null` collapsed them, so the probe is `in`.
//   §4 `quotedH.min`/`max` ride the payload: a live chain snapped at N decision times cannot
//      produce `min === max`, so dispersion is what separates a real book from a synthesized
//      constant quote.
//   §5 The per-structure floor is ON at n=10 (pooled stays 30), env/param-overridable. It is a
//      FLOOR CHECK, not a tail estimate — see MARKETABLE_MTM_PER_STRUCTURE_MIN_N_NOTE.
//
// NOT done here, deliberately (QuantTrader's written instruction): `h` STAYS 0.134 — retuning it
// off the ~0.0025 actualH median would collapse the haircut to indistinguishable from
// mid-marking (the TRA-2131 shape TRA-2233 exists to remove); `ENABLE_MARKETABLE_OPEN_MTM` is
// NOT armed (a fresh decision behind TRA-1897); no bid/ask is backfilled onto legacy rows.
//
// ── THE ADVISORY (actualH) VERDICT ───────────────────────────────────────────
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
/** Minimum computable samples before the POOLED verdict can leave REVIEW. */
export const MARKETABLE_MTM_DEFAULT_MIN_N = 30;
/**
 * Minimum samples PER STRUCTURE before a structure stops forcing REVIEW (TRA-2300 §5).
 *
 * This is a FLOOR CHECK, NOT AN ESTIMATE. Ten points do not estimate a p90; they only
 * establish that a structure's tail figure was computed from more than a handful of rows.
 * The threshold exists because D3's failure was arithmetic, not statistical: pooling four
 * structures whose signs flip with direction cancelled ±0.13 means to ~0.0026 and read
 * "tail covered" while long_call was under-charged 2.8×. A p90 off n=6 is not a tail
 * estimate, so the gate refuses to grade one rather than pretending 6 rows carry a tail.
 * Do not read a cleared floor as "this structure's p90 is now precise".
 */
export const MARKETABLE_MTM_DEFAULT_PER_STRUCTURE_MIN_N = 10;
/**
 * Which of the two emitted verdicts IS the gate (TRA-2300 §1, QuantTrader's call under
 * TRA-2283 D2). `quotedH` is measured off the two-sided QUOTED book — real even on a
 * venue whose fills are broker-simulated — so it is the only one of the two with a
 * failing state here. The `actualH` verdict stays in the payload as ADVISORY.
 */
export const MARKETABLE_MTM_GRADED_BASIS = 'quotedH' as const;
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

/**
 * TRA-2300 §1 — the basis discriminator, spelled out on the payload so no reader grades
 * the wrong verdict. Both verdicts are emitted; only ONE of them is the gate.
 */
export const MARKETABLE_MTM_VERDICT_BASIS_NOTE =
  'TWO verdicts ride this payload and they do NOT agree by construction. `quotedVerdict` '
  + '(basis quotedH) IS THE GATE — it grades modeled h against the two-sided QUOTED book, '
  + 'the only measurement on this venue with a failing state. `verdict` / `actualVerdict` '
  + '(basis actualH) is ADVISORY ONLY: it grades against requestedPx-vs-fillPx, which reads '
  + '~0 on a SANDBOX_SIMULATED venue whether the true spread is 0 or the simulator ignores '
  + 'the book, so it can neither PASS nor FAIL the model honestly. `verdict` keeps its name '
  + 'for shape compatibility with pre-TRA-2300 readers; every verdict object carries its own '
  + '`basis` field, and `gradedBasis` names the graded one. Read `gradedBasis`, not position.';

/**
 * Why a quoted-basis n of 0 is expected-and-benign today rather than an instrument failure.
 * Rides the quoted verdict's REVIEW reason so "cannot yet be graded" never reads as "graded".
 */
export const MARKETABLE_MTM_QUOTED_COVERAGE_NOTE =
  'bid/ask persist on sandbox legs only from `4871bbc` (TRA-2283 D2, deployed '
  + '2026-07-25T17:37Z). Records written earlier carry NO quote key at all, so quotedH.n '
  + 'stays 0 until post-deploy round-trips accrue. `quoteCoverage` separates that benign '
  + 'drain (`legacy_no_quote_field`) from a DEAD instrument — but read the dead-venue count '
  + 'off `quoteCoverage.unpricedExitQuoteDropped`, NOT off `quote_null_at_snap`: TRA-2600 '
  + 'established that `quote_null_at_snap` is WRITER-UNREACHABLE (mapLeg takes requestedPx, '
  + 'bid and ask off one DecisionQuote, and mid is non-null iff both sides are > 0), so a '
  + 'dead snap is DROPPED as `unpriced_exit_quote` before it can ever be classified and '
  + '`quote_null_at_snap` reads 0 whether the venue is healthy or dead.';

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
  /**
   * TRA-2300 §3 — WHY this row does or does not carry a quoted measurement. `quotedH === null`
   * alone cannot distinguish "record predates the writer" from "the venue's book was empty at
   * decision time", and those drain in opposite directions (one ages out on its own; the other
   * means the gate can NEVER be graded). Exactly one state per retained sample.
   */
  quoteState: MarketableMtmQuoteState;
  /**
   * The exit cross implied by the QUOTED book, $ — `quotedH · exitMid · 100`, the quoted-basis
   * analogue of {@link MarketableMtmSample.exitCrossUsd}. `null` whenever `quotedH` is.
   */
  quotedCrossUsd: number | null;
}

/**
 * Why a retained sample does or does not contribute to `quotedH` (TRA-2300 §3). Mutually
 * exclusive and exhaustive over RETAINED samples, so the four counts always sum to `n`.
 *
 * - `quoted`                — a usable two-sided book; this row IS in `quotedH`.
 * - `legacy_no_quote_field` — the exit leg has neither `bid` nor `ask` KEY. The record
 *                             predates `4871bbc`. Benign: drains as legacy rows age out.
 * - `quote_null_at_snap`    — the keys ARE present and one/both are `null`.
 *                             ⚠️ **WRITER-UNREACHABLE (TRA-2600).** No row this codebase
 *                             writes can carry this state, so a `0` here is a TAUTOLOGY, not
 *                             evidence of a healthy venue. `mapLeg`
 *                             (`sandbox-strategy-journal.ts`) takes `requestedPx`, `bid` and
 *                             `ask` off the SAME `DecisionQuote`, and `buildDecisionQuote`
 *                             (`tradier-sandbox-options-smoke.ts`) sets `mid` non-null **iff**
 *                             bid and ask are both non-null and both `> 0`. Therefore
 *                             `requestedPx != null` ⟺ `anyNull === false`, and a row with a
 *                             dead snap is dropped as `unpriced_exit_quote` at
 *                             {@link classifyRecord} ~50 lines BEFORE this branch is reached.
 *                             The dead-venue signal lives in
 *                             {@link MarketableMtmQuoteCoverage.unpricedExitQuoteDropped}
 *                             instead — read THAT, not this.
 *                             The bucket is retained (not deleted) because it becomes live the
 *                             moment a writer DECOUPLES `requestedPx` from the quote snap —
 *                             e.g. persists a `last`-derived or carried-forward mid alongside
 *                             a one-sided book. Until such a writer exists, expect exactly `0`.
 * - `quote_unusable`        — keys present and non-null, but the book fails the shared guards
 *                             (crossed `ask < bid`, `ask <= 0`, negative bid, non-finite).
 *                             Kept as its own bucket so the three counts RECONCILE against `n`
 *                             instead of a corrupt book hiding inside one of the other two.
 *                             This IS writer-reachable: a crossed book still yields a mid.
 */
export type MarketableMtmQuoteState =
  | 'quoted'
  | 'legacy_no_quote_field'
  | 'quote_null_at_snap'
  | 'quote_unusable';

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

/**
 * TRA-2300 §3 — does this leg carry the quote KEYS at all, and are they populated?
 *
 * `SandboxStrategyLeg` types `bid`/`ask` as `number | null`, but records written before
 * `4871bbc` were serialized WITHOUT those keys, so the runtime shape is `undefined` there and
 * `null` when the writer ran but the snap came back one-sided. `== null` collapses both — the
 * exact ABSENT-vs-PRESENT-WITH-NULL collapse that makes a dead instrument read like a benign
 * legacy drain. So this probes the KEY with `in` rather than the value.
 */
function quoteKeyPresence(leg: SandboxStrategyLeg | undefined): {
  keysPresent: boolean;
  anyNull: boolean;
} {
  if (leg == null || typeof leg !== 'object') return { keysPresent: false, anyNull: false };
  const keysPresent = 'bid' in leg || 'ask' in leg;
  return { keysPresent, anyNull: leg.bid == null || leg.ask == null };
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

  // TRA-2300 §3 — separate the two states that both zero `quotedH`. Evaluated in this order:
  // a usable quote wins; otherwise ABSENT KEYS (legacy record) before PRESENT-BUT-NULL (the
  // snap returned no book), with a corrupt-but-populated book falling to `quote_unusable` so
  // the buckets stay exhaustive.
  const presence = quoteKeyPresence(exit);
  const quoteState: MarketableMtmQuoteState = quotedRaw != null
    ? 'quoted'
    : !presence.keysPresent
      ? 'legacy_no_quote_field'
      : presence.anyNull
        ? 'quote_null_at_snap'
        : 'quote_unusable';

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
      quoteState,
      quotedCrossUsd: quotedRaw != null ? quotedRaw * reqExit * per : null,
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

/**
 * TRA-2300 §3 — the quote-coverage census over RETAINED samples. The four state counts are
 * exhaustive and sum to `n`, so a reader can reconcile rather than infer. `etDayMin`/`etDayMax`
 * bound the quote-bearing rows so coverage can be confirmed to START at the `4871bbc` deploy
 * boundary (2026-07-25) — a quote-bearing row dated BEFORE it would mean the writer is not the
 * source of these quotes and the whole measurement is suspect.
 */
export interface MarketableMtmQuoteCoverage {
  /** Retained samples this census covers (equals `summary.n`). */
  retained: number;
  /** Rows carrying a usable two-sided book — i.e. `quotedH.n`. */
  quoted: number;
  /** Exit leg has NO `bid`/`ask` key: record predates `4871bbc`. Benign; drains with age. */
  legacy_no_quote_field: number;
  /**
   * Keys present, one/both `null`.
   *
   * ⚠️ **WRITER-UNREACHABLE — always `0` today (TRA-2600).** This is NOT the dead-venue
   * counter and must not be read as one; see {@link MarketableMtmQuoteState} for the
   * `requestedPx`/`bid`/`ask` coupling that makes it unassignable, and read
   * {@link unpricedExitQuoteDropped} for the signal this bucket LOOKS like it carries.
   */
  quote_null_at_snap: number;
  /** Keys present and populated but the book fails the shared guards (crossed / non-finite). */
  quote_unusable: number;
  /**
   * TRA-2600 — **THE DEAD-VENUE COUNTER.** Records dropped as
   * `exclusions.unpriced_exit_quote`: the exit leg had no usable `requestedPx`, which on this
   * writer means the Tradier snap returned a one-sided or empty book at decision time. This is
   * the observable `quote_null_at_snap` was supposed to be.
   *
   * ⚠️ **OUTSIDE the four-state sum.** A dropped record never becomes a retained sample, so
   * this is deliberately NOT part of `quoted + legacy_no_quote_field + quote_null_at_snap +
   * quote_unusable === retained`. It is a CROSS-REFERENCE into `exclusions`, surfaced here
   * because a coverage reader never looks at the exclusions block.
   *
   * `null` ⇒ **not attributed at this level**, which is not the same as zero. A bare
   * {@link summarizeMarketableMtm} has no access to drop counts and always yields `null`;
   * {@link foldMarketableMtmForwardValidation} fills in the pooled total and genuinely
   * attributes the per-structure counts by `rec.strategy`. A `0` from the fold is a measured
   * zero; a `0` defaulted at a level that cannot see drops would be the same
   * no-failing-state bug one level down, which is why the type admits `null`.
   */
  unpricedExitQuoteDropped: number | null;
  /** ET day bounds of the QUOTE-BEARING samples; `null` when none carry a quote. */
  etDayMin: string | null;
  etDayMax: string | null;
}

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
  quotedH: {
    n: number;
    clamped: number;
    /**
     * TRA-2300 §4 — DISPERSION, so a synthesized constant quote is separable from a real book.
     * A live chain snapped at 26 different decision times cannot produce `min === max`; if it
     * does, the "quote" is a constant somebody wrote, not a book somebody read. `null` at
     * `n === 0` (never 0 — an absent measurement must not read as a zero spread).
     */
    min: number | null;
    max: number | null;
  } & MarketableMtmMoments;
  /**
   * TRA-2300 §2 — the exit cross implied by the QUOTED book, $, over the quote-bearing subset.
   * The quoted-basis analogue of `actualCrossUsd`; `NaN` moments at `quotedH.n === 0`.
   */
  quotedCrossUsd: MarketableMtmMoments;
  /**
   * The modeled cross at `h`, restricted to the SAME quote-bearing subset `quotedCrossUsd` is
   * measured over. This is what the quoted tail check compares against — NOT `modeledCrossUsd`,
   * which spans all retained rows. Comparing a p90 over 26 rows to a p90 over 4 different rows
   * would be a tail check against a different corpus, which is how a tail under-charge hides.
   */
  modeledCrossUsdOnQuoted: MarketableMtmMoments;
  /**
   * TRA-2300 §3 — the ABSENT-vs-NULL census; the FOUR STATE counts sum to `n`.
   * TRA-2600 added `unpricedExitQuoteDropped`, which is a cross-reference into `exclusions`
   * and sits deliberately OUTSIDE that sum (a dropped record is never a retained sample).
   */
  quoteCoverage: MarketableMtmQuoteCoverage;
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
  // TRA-2300 §2/§4 — the quote-bearing SUBSET, kept as rows (not just fractions) so the quoted
  // cross and its paired modeled cross are folded over exactly the same corpus.
  const quotedRows = samples.filter((s) => s.quotedH != null);
  const quoted = quotedRows.map((s) => s.quotedH as number).sort((a, b) => a - b);
  const quotedCross = quotedRows.map((s) => s.quotedCrossUsd as number).sort((a, b) => a - b);
  const modeledCrossOnQuoted = quotedRows
    .map((s) => h * s.exitMidPerShare * CONTRACT_MULTIPLIER)
    .sort((a, b) => a - b);
  const quotedEtDays = quotedRows.map((s) => s.etDay).filter((d) => typeof d === 'string' && d !== '').sort();
  const countState = (state: MarketableMtmQuoteState): number =>
    samples.filter((s) => s.quoteState === state).length;
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
      // Sorted ascending above, so the ends ARE the extrema. `null` (not 0) at n=0.
      min: quoted.length ? quoted[0] : null,
      max: quoted.length ? quoted[quoted.length - 1] : null,
    },
    quotedCrossUsd: {
      mean: mean(quotedCross),
      median: quantile(quotedCross, 0.5),
      p90: quantile(quotedCross, 0.9),
    },
    modeledCrossUsdOnQuoted: {
      mean: mean(modeledCrossOnQuoted),
      median: quantile(modeledCrossOnQuoted, 0.5),
      p90: quantile(modeledCrossOnQuoted, 0.9),
    },
    quoteCoverage: {
      retained: samples.length,
      quoted: quoted.length,
      legacy_no_quote_field: countState('legacy_no_quote_field'),
      quote_null_at_snap: countState('quote_null_at_snap'),
      quote_unusable: countState('quote_unusable'),
      // TRA-2600 — this function folds RETAINED samples and structurally cannot see a dropped
      // record, so it reports `null` (= not attributed here), NEVER `0`. The fold patches in
      // the real count; see `withUnpricedDrops`.
      unpricedExitQuoteDropped: null,
      etDayMin: quotedEtDays.length ? quotedEtDays[0] : null,
      etDayMax: quotedEtDays.length ? quotedEtDays[quotedEtDays.length - 1] : null,
    },
  };
}

export interface MarketableMtmVerdict {
  code: 'PASS' | 'REVIEW';
  reason: string;
  /**
   * TRA-2300 §1 — WHICH measurement this verdict graded. Carried on the verdict object itself
   * (not just inferred from the field it sits in) so a reader that grabs a verdict out of
   * `perStructure[]` still knows what it means. `quotedH` is the gate; `actualH` is advisory.
   */
  basis: 'actualH' | 'quotedH';
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
 * TRA-2300 §2 — the QUOTED-basis tail check: does the modeled p90 cross cover the p90 cross
 * implied by the quoted book, over the SAME quote-bearing rows?
 *
 * The tail is the direction that matters. A haircut that under-charges the tail re-inflates
 * realizable P&L, which is the entire bias TRA-2233 exists to remove — so this must be checked
 * on the basis the gate actually grades, not only on the advisory `actualH` one.
 *
 * Returns `false` when either p90 is non-finite (no quoted rows): NOT-MEASURABLE is not a tail
 * failure, and asserting one would manufacture a REVIEW reason out of an absent measurement.
 * The `quotedH.n` floor in {@link marketableMtmQuotedVerdict} is what stops an unmeasurable
 * tail from reading as a covered one.
 */
function quotedTailUnderCharged(summary: MarketableMtmSummary): boolean {
  const m = summary.modeledCrossUsdOnQuoted.p90;
  const q = summary.quotedCrossUsd.p90;
  if (!Number.isFinite(m) || !Number.isFinite(q)) return false;
  return !(m >= q);
}

/** How many × the quoted tail exceeds the modeled tail on the same rows; `null` when it does not. */
function quotedTailUnderChargeRatio(summary: MarketableMtmSummary): number | null {
  const m = summary.modeledCrossUsdOnQuoted.p90;
  const q = summary.quotedCrossUsd.p90;
  if (!Number.isFinite(m) || !Number.isFinite(q) || m <= 0 || q <= m) return null;
  return q / m;
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
    return { code: 'REVIEW', basis: 'actualH', reason: `insufficient n (${summary.n} < ${minN}); accrue more parity-true sandbox round-trips` };
  }
  const withinTol = Math.abs(summary.actualH.median - summary.modeledH) <= tol;
  const tailOk = !tailUnderCharged(summary);
  if (withinTol && tailOk) {
    return { code: 'PASS', basis: 'actualH', reason: `median realized h ${summary.actualH.median.toFixed(4)} within ±${tol} of modeled ${summary.modeledH}; tail covered` };
  }
  const bits: string[] = [];
  // NOTE (TRA-2283 D2): the parenthetical is a DESCRIPTION of where the measured median sits,
  // NOT an instruction. On a SANDBOX_SIMULATED venue that fills at the decision mid, actualH
  // is ~0 by construction, so "retune h ≈ 0.002" would collapse the haircut to mid-marking.
  // See MARKETABLE_MTM_ACTUAL_H_CAVEAT, which rides the payload next to this string.
  if (!withinTol) bits.push(`median realized h ${summary.actualH.median.toFixed(4)} outside ±${tol} of modeled ${summary.modeledH} (measured median ≈ ${summary.actualH.median.toFixed(3)} — do NOT retune h off a SANDBOX_SIMULATED fill; see actualHCaveat)`);
  if (!tailOk) bits.push(`modeled p90 cross $${summary.modeledCrossUsd.p90.toFixed(2)} < actual p90 $${summary.actualCrossUsd.p90.toFixed(2)} (under-charges the tail)`);
  return { code: 'REVIEW', basis: 'actualH', reason: bits.join('; ') };
}

/**
 * TRA-2600 — the DEAD-VENUE sentence, spliced into the quoted REVIEW reason.
 *
 * This exists so that a dead venue and a draining legacy backlog produce **different strings**.
 * Before this, both rendered `0 had a null quote AT SNAP` and were textually identical, because
 * the only counter that actually moves for a dead venue (`exclusions.unpriced_exit_quote`) lives
 * in a different section of the payload that the coverage reader never reaches. Three distinct
 * renderings — attributed-and-dead, attributed-and-healthy, not-attributed — and never a
 * silent omission, because an omitted clause reads exactly like a zero.
 */
function deadSnapClause(cov: MarketableMtmQuoteCoverage): string {
  const dropped = cov.unpricedExitQuoteDropped;
  if (dropped == null) {
    return ' Dead-snap drops (exclusions.unpriced_exit_quote) are NOT ATTRIBUTED at this level'
      + ' — this census covers retained rows only; read the pooled quoteCoverage.';
  }
  if (dropped > 0) {
    return ` DEAD VENUE: a further ${dropped} record(s) were DROPPED BEFORE retention with no`
      + ` usable exit quote at all (exclusions.unpriced_exit_quote), OVER AND ABOVE the`
      + ` ${cov.retained} retained rows above. This is NOT a draining legacy backlog — those`
      + ' rows will never age into a gradeable quotedH, and the count does not shrink on its own.';
  }
  return ' No record was dropped for a missing exit quote (exclusions.unpriced_exit_quote = 0),'
    + ' so the venue returned a two-sided book on every snap: the shortfall above is a LEGACY'
    + ' DRAIN, which does resolve as post-4871bbc round-trips accrue.';
}

/**
 * TRA-2600 — patch the dead-venue cross-reference onto a summary's coverage census.
 *
 * {@link summarizeMarketableMtm} folds retained samples and cannot see a dropped record, so it
 * emits `null`. Only the fold knows the drop counts, and it must apply them BEFORE the verdicts
 * are computed — a verdict built off the unpatched summary would render the "not attributed"
 * branch into the very string a reader acts on.
 */
function withUnpricedDrops<T extends MarketableMtmSummary>(summary: T, dropped: number): T {
  return { ...summary, quoteCoverage: { ...summary.quoteCoverage, unpricedExitQuoteDropped: dropped } };
}

/**
 * TRA-2300 §1 — **THE GATE.** PASS iff the median QUOTED-book half-spread is within `±tol` of
 * modeled `h` AND the modeled p90 cross covers the quoted p90 cross on the same rows.
 *
 * Identical in shape and tolerance to {@link marketableMtmVerdict}; only the decision variable
 * differs — `quotedH.median` instead of `actualH.median` — and the sufficiency floor is read
 * off `quotedH.n`, NOT `summary.n`. That distinction is the point: `summary.n` counts rows with
 * a usable exit FILL, and on this venue every one of those has a dead `actualH`. Gating the
 * quoted verdict on `summary.n` would let 30 quote-less rows clear the floor and hand back a
 * verdict computed from `NaN`.
 *
 * Below `minN` QUOTED samples the code is REVIEW, never PASS, and the reason carries
 * {@link MARKETABLE_MTM_QUOTED_COVERAGE_NOTE} plus the ABSENT-vs-NULL split so "not yet
 * gradeable (legacy rows draining)" is never confused with "instrument dead".
 */
export function marketableMtmQuotedVerdict(
  summary: MarketableMtmSummary,
  tol: number,
  minN: number,
): MarketableMtmVerdict {
  const qn = summary.quotedH.n;
  if (qn < minN) {
    const cov = summary.quoteCoverage;
    return {
      code: 'REVIEW',
      basis: 'quotedH',
      reason: `insufficient QUOTED-basis n (${qn} < ${minN}); of ${cov.retained} retained rows `
        + `${cov.legacy_no_quote_field} predate the bid/ask writer (legacy_no_quote_field), `
        + `${cov.quote_null_at_snap} had a null quote AT SNAP (quote_null_at_snap — `
        + 'WRITER-UNREACHABLE, always 0; not the dead-venue signal), '
        + `${cov.quote_unusable} carried an unusable book.${deadSnapClause(cov)} `
        + `${MARKETABLE_MTM_QUOTED_COVERAGE_NOTE}`,
    };
  }
  const withinTol = Math.abs(summary.quotedH.median - summary.modeledH) <= tol;
  const tailOk = !quotedTailUnderCharged(summary);
  if (withinTol && tailOk) {
    return {
      code: 'PASS',
      basis: 'quotedH',
      reason: `median QUOTED h ${summary.quotedH.median.toFixed(4)} within ±${tol} of modeled `
        + `${summary.modeledH}; quoted tail covered (modeled p90 $${summary.modeledCrossUsdOnQuoted.p90.toFixed(2)} `
        + `≥ quoted p90 $${summary.quotedCrossUsd.p90.toFixed(2)} over the same ${qn} quote-bearing rows)`,
    };
  }
  const bits: string[] = [];
  if (!withinTol) {
    bits.push(`median QUOTED h ${summary.quotedH.median.toFixed(4)} outside ±${tol} of modeled ${summary.modeledH}`);
  }
  if (!tailOk) {
    const ratio = quotedTailUnderChargeRatio(summary);
    const mult = ratio != null ? ` — under-charged ${ratio.toFixed(1)}×` : '';
    bits.push(`modeled p90 cross $${summary.modeledCrossUsdOnQuoted.p90.toFixed(2)} < quoted p90 `
      + `$${summary.quotedCrossUsd.p90.toFixed(2)} (under-charges the tail${mult})`);
  }
  return { code: 'REVIEW', basis: 'quotedH', reason: bits.join('; ') };
}

/** Per-structure fold — the unpooled view (TRA-2283 D3). */
export interface MarketableMtmStructureBreakdown extends MarketableMtmSummary {
  structure: string;
  /** `modeledCrossUsd.p90 < actualCrossUsd.p90` for THIS structure alone. */
  tailUnderCharged: boolean;
  /** `actualCrossUsd.p90 / modeledCrossUsd.p90` when under-charged; `null` otherwise. */
  tailUnderChargeRatio: number | null;
  /**
   * TRA-2300 §2 — the QUOTED-basis tail check for THIS structure alone:
   * `modeledCrossUsdOnQuoted.p90 < quotedCrossUsd.p90`. `false` when this structure has no
   * quote-bearing rows (unmeasurable ≠ under-charged; `quotedH.n` is what reports that).
   */
  quotedTailUnderCharged: boolean;
  /** `quotedCrossUsd.p90 / modeledCrossUsdOnQuoted.p90` when under-charged; `null` otherwise. */
  quotedTailUnderChargeRatio: number | null;
  /** This structure's ADVISORY (actualH-basis) verdict, at `tol` / the PER-STRUCTURE `minN`. */
  verdict: MarketableMtmVerdict;
  /** This structure's GRADED (quotedH-basis) verdict, at `tol` / the PER-STRUCTURE `minN`. */
  quotedVerdict: MarketableMtmVerdict;
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
 * `requirePerStructureMinN` additionally demands every structure reach `perStructureMinN` on
 * its own (n=7–8 per structure is exactly where one bad row moves a mean by 0.13). TRA-2300 §5
 * SET that threshold and turned the switch ON: it is now `true` with a per-structure floor of
 * {@link MARKETABLE_MTM_DEFAULT_PER_STRUCTURE_MIN_N} (10) against the unchanged pooled 30 —
 * a FLOOR CHECK, not a claim that 10 points estimate a p90. Both remain overridable.
 */
export function marketableMtmPooledVerdict(
  summary: MarketableMtmSummary,
  structures: readonly MarketableMtmStructureBreakdown[],
  tol: number,
  minN: number,
  requirePerStructureMinN = true,
  perStructureMinN = MARKETABLE_MTM_DEFAULT_PER_STRUCTURE_MIN_N,
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

  const below = structures.filter((s) => s.n < perStructureMinN).map((s) => `${s.structure} (n=${s.n})`);
  if (requirePerStructureMinN && below.length > 0) {
    bits.push(`insufficient per-structure n (< ${perStructureMinN}): ${below.join(', ')}`);
  }

  if (bits.length === 0) return base;
  // A pooled PASS is REVOKED by any per-structure failure; a pooled REVIEW keeps its own
  // reason and gains the per-structure detail.
  const prefix = base.code === 'REVIEW' ? `${base.reason}; ` : '';
  return { code: 'REVIEW', basis: 'actualH', reason: `${prefix}${bits.join('; ')}` };
}

/**
 * TRA-2300 §1+§2+§5 — **THE POOLED GATE.** The quoted-basis analogue of
 * {@link marketableMtmPooledVerdict}, carrying D3's rule onto the basis that actually grades:
 * **any structure whose QUOTED tail is under-charged forces REVIEW**, named with its multiple,
 * and pooling can never absolve it.
 *
 * The per-structure floor is applied on `quotedH.n`, not `n`. A structure can hold 30 rows with
 * a usable fill and ZERO quotes — grading its quoted tail off that would be a p90 over an empty
 * set. Structures below the quoted floor are NAMED as ungradeable rather than silently skipped,
 * because "no structure was flagged" and "no structure could be checked" read identically
 * otherwise — the exact indistinguishable-pass-and-fail shape this ticket exists to remove.
 */
export function marketableMtmQuotedPooledVerdict(
  summary: MarketableMtmSummary,
  structures: readonly MarketableMtmStructureBreakdown[],
  tol: number,
  minN: number,
  requirePerStructureMinN = true,
  perStructureMinN = MARKETABLE_MTM_DEFAULT_PER_STRUCTURE_MIN_N,
): MarketableMtmVerdict {
  const base = marketableMtmQuotedVerdict(summary, tol, minN);
  const bits: string[] = [];

  const under = structures.filter((s) => s.quotedTailUnderCharged);
  if (under.length > 0) {
    const named = [...under]
      .sort((a, b) => (b.quotedTailUnderChargeRatio ?? Infinity) - (a.quotedTailUnderChargeRatio ?? Infinity))
      .map((s) => {
        const ratio = s.quotedTailUnderChargeRatio;
        const mult = ratio != null ? `${ratio.toFixed(1)}×` : 'modeled p90 ≤ 0';
        return `${s.structure} (quoted n=${s.quotedH.n}, quoted p90 $${s.quotedCrossUsd.p90.toFixed(2)} `
          + `vs modeled $${s.modeledCrossUsdOnQuoted.p90.toFixed(2)} — under-charged ${mult})`;
      })
      .join(', ');
    bits.push(`per-structure QUOTED tail UNDER-CHARGED: ${named}`);
  }

  const below = structures
    .filter((s) => s.quotedH.n < perStructureMinN)
    .map((s) => `${s.structure} (quoted n=${s.quotedH.n})`);
  if (requirePerStructureMinN && below.length > 0) {
    bits.push(`insufficient per-structure QUOTED n (< ${perStructureMinN}), NOT gradeable: ${below.join(', ')}`);
  }

  if (bits.length === 0) return base;
  const prefix = base.code === 'REVIEW' ? `${base.reason}; ` : '';
  return { code: 'REVIEW', basis: 'quotedH', reason: `${prefix}${bits.join('; ')}` };
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
  /**
   * TRA-2300 §1 — the ADVISORY actualH-basis verdict. Keeps the field name it has always had so
   * a pre-TRA-2300 consumer is not silently handed a DIFFERENT number under a name it already
   * trusts. It is not the gate; read {@link MarketableMtmForwardValidation.quotedVerdict}.
   */
  verdict: MarketableMtmVerdict;
  /** Explicit alias of {@link MarketableMtmForwardValidation.verdict} — same object, named for what it grades. */
  actualVerdict: MarketableMtmVerdict;
  /** TRA-2300 §1 — **THE GATE**: the quotedH-basis verdict (see {@link MARKETABLE_MTM_GRADED_BASIS}). */
  quotedVerdict: MarketableMtmVerdict;
  /** Names which of the two verdicts grades. Always `'quotedH'` since TRA-2300. */
  gradedBasis: typeof MARKETABLE_MTM_GRADED_BASIS;
  /** Prose form of the discriminator, so the payload explains itself (see {@link MARKETABLE_MTM_VERDICT_BASIS_NOTE}). */
  verdictBasisNote: string;
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
  /**
   * Structures below the PER-STRUCTURE floor on retained `n` — always reported.
   *
   * ⚠️ TRA-2300 §5 changed this field's BASIS: it is now measured against `perStructureMinN`
   * (default 10), not the pooled `minN` (30). `perStructureMinN` is emitted right beside it so
   * the threshold is pinned WITH the number instead of assumed.
   */
  structuresBelowMinN: string[];
  /** Structures below the per-structure floor on QUOTED n — i.e. not gradeable on the graded basis. */
  structuresBelowQuotedMinN: string[];
  /**
   * TRA-2600 — structures that produced dead-snap drops but **no retained sample at all**, so
   * they have NO `perStructure[]` entry to carry a count.
   *
   * Without this list a wholly-dead structure does not read as `0` dead snaps — it does not
   * appear anywhere in `perStructure[]`, which is strictly worse: absence looks like "that
   * structure was not traded". Naming it here is what lets a reader reconcile
   * `quoteCoverage.unpricedExitQuoteDropped` (pooled) against the sum of the per-structure
   * counts — pooled MINUS that sum is exactly the drops belonging to these structures.
   */
  structuresFullyDeadSnapped: string[];
  /** Whether the pooled verdicts enforced the per-structure floor this call (default true since TRA-2300). */
  requirePerStructureMinN: boolean;
  /** The per-structure floor applied this call. A FLOOR CHECK, not a tail estimate — see the constant. */
  perStructureMinN: number;
  /** Restates the floor's epistemic status on the payload so it is not read as precision. */
  perStructureMinNNote: string;
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
  /** Enforce the per-structure floor in the POOLED verdicts too. Default TRUE since TRA-2300 §5. */
  requirePerStructureMinN?: boolean;
  /** The per-structure floor; defaults to {@link MARKETABLE_MTM_DEFAULT_PER_STRUCTURE_MIN_N} (10). */
  perStructureMinN?: number;
  /** Echo the per-row samples on the payload (capped). */
  includeSamples?: boolean;
}

/** The gate thresholds as resolved from the environment (TRA-2300 §5). */
export interface MarketableMtmGateThresholds {
  minN: number;
  perStructureMinN: number;
  requirePerStructureMinN: boolean;
}

/**
 * Resolve the TRA-2300 §5 thresholds from an explicit env bag — `MARKETABLE_MTM_MIN_N`,
 * `MARKETABLE_MTM_PER_STRUCTURE_MIN_N`, `MARKETABLE_MTM_REQUIRE_PER_STRUCTURE_MIN_N`.
 *
 * Takes the env as an ARGUMENT rather than reading `process.env`, so the fold stays pure and a
 * test can pin every branch without mutating global state. Non-numeric / non-positive / absent
 * values fall back to the shipped defaults — an unparseable override must never silently
 * become `NaN`, because `n < NaN` is `false` and would DISABLE the floor rather than tighten it.
 */
export function resolveMarketableMtmGateThresholds(
  env: Record<string, string | undefined> = {},
): MarketableMtmGateThresholds {
  const posInt = (raw: string | undefined, fallback: number): number => {
    if (typeof raw !== 'string' || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const boolEnv = (raw: string | undefined, fallback: boolean): boolean => {
    if (typeof raw !== 'string' || raw.trim() === '') return fallback;
    const v = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return fallback;
  };
  return {
    minN: posInt(env.MARKETABLE_MTM_MIN_N, MARKETABLE_MTM_DEFAULT_MIN_N),
    perStructureMinN: posInt(
      env.MARKETABLE_MTM_PER_STRUCTURE_MIN_N,
      MARKETABLE_MTM_DEFAULT_PER_STRUCTURE_MIN_N,
    ),
    requirePerStructureMinN: boolEnv(env.MARKETABLE_MTM_REQUIRE_PER_STRUCTURE_MIN_N, true),
  };
}

/** Rides the payload so a cleared per-structure floor is not read as a precise tail estimate. */
export const MARKETABLE_MTM_PER_STRUCTURE_MIN_N_NOTE =
  'perStructureMinN is a FLOOR CHECK, not an estimate. Clearing it means a structure\'s tail '
  + 'figure was computed from more than a handful of rows — it does NOT mean that p90 is '
  + 'precise. Ten points do not estimate a 90th percentile. The floor exists because D3\'s '
  + 'failure was arithmetic (a pooled median cancelling ±0.13 signs to ~0.0026 while long_call '
  + 'was under-charged 2.8×), so the gate refuses to grade a p90 off n=6 rather than pretending '
  + 'six rows carry a tail.';

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
  const requirePerStructureMinN = opts.requirePerStructureMinN ?? true;
  const perStructureMinN = opts.perStructureMinN ?? MARKETABLE_MTM_DEFAULT_PER_STRUCTURE_MIN_N;

  const samples: MarketableMtmSample[] = [];
  const exclusions = emptyExclusions();
  const zeroFillRows: MarketableMtmZeroFillRow[] = [];
  // TRA-2600 — dead-snap drops attributed by structure. GENUINELY attributed, not defaulted:
  // a per-structure block that hard-coded `0` here would report "no dead snaps" for every
  // structure regardless of truth, which is the same no-failing-state bug one level down.
  // Key matches the sample's `structure` (`rec.strategy ?? 'unknown'`) so the two join.
  const unpricedByStructure = new Map<string, number>();
  for (const rec of records) {
    const c = classifyRecord(rec, strategy);
    if (c.sample != null) {
      samples.push(c.sample);
      continue;
    }
    if (c.drop != null) exclusions[c.drop] += 1;
    if (c.drop === 'unpriced_exit_quote') {
      const key = rec.strategy ?? 'unknown';
      unpricedByStructure.set(key, (unpricedByStructure.get(key) ?? 0) + 1);
    }
    if (c.zeroFill != null) zeroFillRows.push(c.zeroFill);
  }

  const summary = withUnpricedDrops(
    summarizeMarketableMtm(samples, h),
    exclusions.unpriced_exit_quote,
  );

  // ── D3: unpool ────────────────────────────────────────────────────────────
  const byStructure = new Map<string, MarketableMtmSample[]>();
  for (const s of samples) {
    const list = byStructure.get(s.structure) ?? [];
    list.push(s);
    byStructure.set(s.structure, list);
  }
  const perStructure: MarketableMtmStructureBreakdown[] = [...byStructure.entries()]
    .map(([structure, list]) => {
      // TRA-2600 — patched BEFORE the verdicts below, so the per-structure quoted REVIEW
      // reason carries this structure's own dead-snap count rather than "not attributed".
      const sub = withUnpricedDrops(
        summarizeMarketableMtm(list, h),
        unpricedByStructure.get(structure) ?? 0,
      );
      return {
        structure,
        ...sub,
        tailUnderCharged: tailUnderCharged(sub),
        tailUnderChargeRatio: tailUnderChargeRatio(sub),
        quotedTailUnderCharged: quotedTailUnderCharged(sub),
        quotedTailUnderChargeRatio: quotedTailUnderChargeRatio(sub),
        // A per-structure verdict is graded at the PER-STRUCTURE floor, not the pooled 30 —
        // otherwise every structure in a healthy 4-way split reads "insufficient n (20 < 30)".
        verdict: marketableMtmVerdict(sub, tol, perStructureMinN),
        quotedVerdict: marketableMtmQuotedVerdict(sub, tol, perStructureMinN),
      };
    })
    .sort((a, b) => b.n - a.n || a.structure.localeCompare(b.structure));

  const v = marketableMtmPooledVerdict(
    summary, perStructure, tol, minN, requirePerStructureMinN, perStructureMinN,
  );
  const quotedV = marketableMtmQuotedPooledVerdict(
    summary, perStructure, tol, minN, requirePerStructureMinN, perStructureMinN,
  );

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
    actualVerdict: v,
    quotedVerdict: quotedV,
    gradedBasis: MARKETABLE_MTM_GRADED_BASIS,
    verdictBasisNote: MARKETABLE_MTM_VERDICT_BASIS_NOTE,
    fillRealism: FILL_REALISM,
    strategy,
    excludedRecords: records.length - samples.length,
    excludedZeroFill: exclusions.zero_fill_exit,
    exclusions,
    perStructure,
    structuresBelowMinN: perStructure.filter((s) => s.n < perStructureMinN).map((s) => s.structure),
    structuresBelowQuotedMinN: perStructure
      .filter((s) => s.quotedH.n < perStructureMinN)
      .map((s) => s.structure),
    structuresFullyDeadSnapped: [...unpricedByStructure.keys()]
      .filter((s) => !byStructure.has(s))
      .sort(),
    requirePerStructureMinN,
    perStructureMinN,
    perStructureMinNNote: MARKETABLE_MTM_PER_STRUCTURE_MIN_N_NOTE,
    diagnostics,
    ...(opts.includeSamples === true ? { samples: samples.slice(0, cap) } : {}),
    actualHCaveat: MARKETABLE_MTM_ACTUAL_H_CAVEAT,
    totalRecords: records.length,
  };
}
