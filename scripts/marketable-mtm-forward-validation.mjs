#!/usr/bin/env node
// TRA-2233 (parent TRA-2174), data source repointed by TRA-2243 — forward-validation
// harness for the marketable(bid) open-position valuation.
//
// The DARK marketable mark (see packages/server/src/marketable-open-mtm.ts) values
// an open long at `mid · (1 − h)` where `h` is a MODELED half-spread fraction
// (default 0.134). This script answers the question the flag is gated on:
//
//     does the modeled marketable mark predict the price a REAL exit actually
//     fills at?
//
// ── Why the option-trade-journal source was WRONG (TRA-2243) ──────────────────
// The original harness read `option-trade-journal.jsonl` and recovered the realized
// cross from each close row's `exitSlippageUsd`. But that field has NO WRITER:
// `OptionsAccount.queueJournalClose` never stamps it, and on live bqb1 every one of
// the 2327 closed rows carries `slippage.exitSampled = 0`. The accrual source was a
// STRUCTURAL ZERO — no amount of sandbox trading could ever move it, so the harness
// could never leave "insufficient n". A detector that cannot fire reads identically
// to one that passes; this is exactly that trap.
//
// ── The parity-true ground truth (where the cross actually lives) ─────────────
// The real Tradier-fill cross is on the SANDBOX round-trip's EXIT LEG in
// `sandbox-strategy-journal.jsonl` (TRA-2134, acct VA20296703 — the parity-true
// sleeve, TRA-2174). Each record carries `legs: [entry, exit]`, and each leg has:
//     requestedPx = the decision-quote MID  (= what the demo book marks at)
//     fillPx      = the REAL broker avg fill (Tradier sandbox)
// The realized half-spread the marketable mark is trying to model ahead of time is
// the EXIT leg's signed cost of crossing the spread away from that mid:
//     signedCost = side === 'buy' ? (fillPx − requestedPx)   // short exit: bought UP
//                                 : (requestedPx − fillPx)   // long  exit: sold DOWN
//     actualH    = signedCost / requestedPx
// This is the SAME per-leg identity TRA-2237's parity-reconcile.ts folds; here we
// restrict it to the EXIT leg, because `actualH` recovers the EXIT half-spread that
// `mid · (1 − h)` prices. It is SIGNED on purpose: a sandbox fill that comes in at or
// through the mid (actualH ≤ 0) is genuine parity evidence that the modeled haircut
// is too aggressive. Dropping non-positive crosses would BIAS the median upward — a
// biased sampler that manufactures a half-spread out of a symmetric fill distribution.
//
// ── The comparison ───────────────────────────────────────────────────────────
// Per round-trip we take contracts = 1 (TRA-2134 single-contract; `actualH` is a
// fraction and qty-invariant), exit mid per share = `requestedPx`, and realized cross
//     exitSlippageUsd = signedCost · contracts · 100      (SIGNED $)
// then compare the modeled `h` to the measured distribution and emit a PASS/REVIEW
// verdict: the modeled `h` is accepted iff the measured MEDIAN realized `actualH` sits
// within `--tol` of it AND the model does not systematically UNDER-charge the tail
// (p90 modeled cross ≥ p90 actual cross), because an under-charging mark re-inflates
// realizable P&L — the very bias this ticket exists to remove.
//
// ── CAVEAT surfaced to the reader (TRA-2242 must weigh it) ────────────────────
// Tradier SANDBOX fills are broker-SIMULATED (`SANDBOX_SIMULATED`): they model no real
// queue position or partial-fill-under-load, so a near-mid median here may UNDERSTATE
// the spread a live exit pays. This harness measures the parity-true source we have;
// it does not certify live realism. It gates/arms nothing (TRA-1897 hold).
//
// ── The DEPLOYED single-source-of-truth (TRA-2247) ───────────────────────────
// The identical exit-leg fold now lives server-side in
// `packages/server/src/marketable-mtm-forward-validation.ts` and is emitted no-auth at
//     GET /api/health/marketable-mtm-forward-validation
// which folds the SAME sandbox journal from `getSandboxStrategyRecords()` — so once live
// n≥30 the gate is a single curl (bqb1 admin auth is dead; the raw `/data` JSONL this CLI
// reads is not itself a no-auth surface). This CLI stays the OFFLINE `--file` runner; both
// implement the identity below and `marketable-mtm-forward-validation.test.ts` pins them to
// the same numeric output on the shared synthetic corpus so they cannot silently drift.
//
// Usage:
//   node scripts/marketable-mtm-forward-validation.mjs [--file PATH] [--h 0.134]
//        [--tol 0.03] [--strategy long_call|long_put|csp|covered_call]
//        [--min-n 30] [--json] [--self-test]
//
// ── TRA-2300: THE GRADED BASIS IS `quotedH`; THE EXIT CODE FOLLOWS IT ────────
// QuantTrader's call under TRA-2283 D2 is made: the gate grades the QUOTED-book half-spread,
// not the fill-derived one. This CLI mirrors that, and it MUST — a CLI whose exit code graded
// `actualH` while the route graded `quotedH` would be a second grader disagreeing with the
// gate, which is exactly the silent drift the two-implementation note above warns about.
// So `--json` now emits BOTH verdicts with a `basis` on each plus `gradedBasis`, the human
// report prints both and labels which one grades, and **the process exit code is the QUOTED
// verdict's**. Also mirrored: the quoted-basis tail check (per structure and pooled), the
// ABSENT-vs-NULL quote-coverage split, quotedH min/max, and the per-structure floor, which now
// ships ON at 10 (pooled min-n stays 30) — `--per-structure-min-n N` and
// `--no-require-per-structure-min-n` override it.
//
// Exit code: 0 = PASS on the QUOTED basis (or self-test ok), 2 = REVIEW (insufficient quoted n
// or model off), 4 = NOT_GRADEABLE (TRA-3459 — this population provably has no pass state; more
// rows of the same book cannot change it), 1 = usage / IO error.
//
// ⚠ 2 and 4 are DELIBERATELY different codes. A caller that cannot tell "come back with more
// rows" from "this venue can never answer the question" is the shell-level form of the exact
// defect TRA-3459 fixed in the payload, and it is the one that cost TRA-2242 four beats of
// accrual. Anything scripting this must branch on 4, not fold it into "non-zero".
//
// Read-only: never writes any journal. Arms nothing: `h` stays 0.134 and
// ENABLE_MARKETABLE_OPEN_MTM is untouched (TRA-1897 hold).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_H = 0.134; // packages/server/src/marketable-open-mtm.ts DEFAULT_MARKETABLE_HALF_SPREAD_FRAC
const CONTRACT_MULTIPLIER = 100;
// marketable-open-mtm.ts MAX_MARKETABLE_HALF_SPREAD_FRAC — also the |actualH| outlier threshold.
const MAX_HALF_SPREAD_FRAC = 0.5;
// TRA-2300 §5 — a FLOOR CHECK, not a tail estimate. Ten points do not estimate a p90; they
// only establish the figure was not computed off a handful of rows.
const DEFAULT_PER_STRUCTURE_MIN_N = 10;

function parseArgs(argv) {
  const a = {
    file: null, h: DEFAULT_H, tol: 0.03, strategy: null, minN: 30, json: false, selfTest: false,
    requirePerStructureMinN: true, perStructureMinN: DEFAULT_PER_STRUCTURE_MIN_N,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--file') a.file = argv[++i];
    else if (t === '--h') a.h = Number(argv[++i]);
    else if (t === '--tol') a.tol = Number(argv[++i]);
    else if (t === '--strategy') a.strategy = argv[++i];
    else if (t === '--min-n') a.minN = Number(argv[++i]);
    else if (t === '--per-structure-min-n') a.perStructureMinN = Number(argv[++i]);
    else if (t === '--require-per-structure-min-n') a.requirePerStructureMinN = true;
    else if (t === '--no-require-per-structure-min-n') a.requirePerStructureMinN = false;
    else if (t === '--json') a.json = true;
    else if (t === '--self-test') a.selfTest = true;
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

function defaultFile() {
  // The parity-true source: the SANDBOX strategy journal (TRA-2134). Each line is a
  // COMPLETE SandboxStrategyRecord — unlike the option-trade-journal there are no
  // open/close/amend events to fold.
  const root = process.env.DATA_DIR ?? join(process.cwd(), 'packages', 'server', 'data');
  return join(root, 'sandbox-strategy-journal.jsonl');
}

// Parse the sandbox journal: one full SandboxStrategyRecord per line (no folding).
function parseSandboxJournal(text) {
  const recs = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj && Array.isArray(obj.legs)) recs.push(obj);
  }
  return recs;
}

function quantile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);

/** Signed cost of crossing the spread AWAY from the decision mid, for one leg. */
function signedCross(side, requestedPx, fillPx) {
  return side === 'buy' ? fillPx - requestedPx : requestedPx - fillPx;
}

/** A leg PRICE is usable iff finite and strictly POSITIVE (TRA-2283 D1 — a `0` fill is a
 *  missing price wearing a number's clothes, and folding it yields actualH = ±1 exactly). */
function usablePx(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Half-spread off the two-sided QUOTED book, on the side the position exits through
 *  (`sell` exit closes a long ⇒ mid→bid; `buy` exit closes a short ⇒ mid→ask). Mirrors
 *  `marketable-open-mtm.ts::halfSpreadFracFromQuoteForSide`, guards and clamp included.
 *  TRA-2283 D2 — the quote is REAL even when the fill is broker-simulated. */
function quotedHalfSpread(bid, ask, mark, exitSide) {
  if (![bid, ask, mark].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (mark <= 0 || bid < 0 || ask <= 0) return null;
  if (ask < bid) return null; // crossed / corrupt book
  const frac = exitSide === 'sell' ? (mark - bid) / mark : (ask - mark) / mark;
  if (!Number.isFinite(frac) || frac <= 0) return 0;
  return Math.min(frac, MAX_HALF_SPREAD_FRAC);
}

// Turn one sandbox round-trip into a validation sample, or null when it can't
// falsify a bid model (no exit leg, one-sided quote, the exit never filled, or a
// FALSE-ZERO exit fill — TRA-2283 D1). The realized cross is kept SIGNED — a fill
// at/through the mid is real evidence, not something to filter out (that would bias
// the measured half-spread upward). Drops are tallied into `tally` when supplied.
function toSample(rec, strategyFilter, tally) {
  const bump = (k) => { if (tally) tally[k] = (tally[k] ?? 0) + 1; return null; };
  if (!Array.isArray(rec.legs) || rec.legs.length < 2) return bump('too_few_legs'); // need entry + exit
  if (strategyFilter && rec.strategy !== strategyFilter) return bump('strategy_filter');
  const entry = rec.legs[0];
  const exit = rec.legs[rec.legs.length - 1]; // recordFromContractResult: legs = [entry, exit]

  // Reject null BEFORE Number(): `Number(null) === 0` is finite, so a one-sided quote
  // (`requestedPx: null`) or an unfilled leg (`fillPx: null`) would slip through as a bogus
  // $0 price and manufacture a ~100% cross. A missing price is EXCLUDED, never folded.
  if (exit.requestedPx == null) return bump('unpriced_exit_quote');
  if (exit.fillPx == null) return bump('unfilled_exit');
  const reqExit = Number(exit.requestedPx);
  const fillExit = Number(exit.fillPx);
  if (!Number.isFinite(reqExit) || reqExit <= 0) return bump('unpriced_exit_quote'); // one-sided quote
  if (!Number.isFinite(fillExit)) return bump('unfilled_exit');                      // never filled
  // TRA-2283 D1 — SYMMETRIC with reqExit. A literal `0` fill folds to actualH = exactly ±1
  // (a 100% half-spread) from a contract that in fact traded near its mid; 4 such rows in a
  // 30-record corpus produced every per-structure mean of ±0.13 and both tail failures.
  if (fillExit <= 0) return bump('zero_fill_exit');
  if (exit.side !== 'buy' && exit.side !== 'sell') return bump('bad_exit_side');

  const contracts = 1; // TRA-2134 single-contract; actualH is a fraction and qty-invariant
  const per = contracts * CONTRACT_MULTIPLIER;
  const exitMidPerShare = reqExit;
  const signed = signedCross(exit.side, reqExit, fillExit);
  const actualH = signed / reqExit;              // realized EXIT half-spread fraction (SIGNED)
  const exitSlippageUsd = signed * per;          // realized EXIT cross, $ (SIGNED)

  // TRA-2283 D2 — the falsifiable measurement: the QUOTED-book half-spread. `null` on every
  // record written before D2 persisted `bid`/`ask` on the leg.
  const quotedH = quotedHalfSpread(
    typeof exit.bid === 'number' ? exit.bid : null,
    typeof exit.ask === 'number' ? exit.ask : null,
    reqExit,
    exit.side,
  );

  // TRA-2300 §3 — WHY this row does or does not carry a quote. `== null` collapses ABSENT
  // (record predates the 4871bbc writer — benign, drains with age) into PRESENT-BUT-NULL (the
  // snap returned no book — the instrument is dead and can NEVER be graded). Same observable
  // consequence, opposite diagnoses, so the probe is `in` on the KEY, not a value test.
  const quoteKeysPresent = exit != null && typeof exit === 'object'
    && ('bid' in exit || 'ask' in exit);
  const quoteState = quotedH != null
    ? 'quoted'
    : !quoteKeysPresent
      ? 'legacy_no_quote_field'
      : (exit.bid == null || exit.ask == null)
        ? 'quote_null_at_snap'
        : 'quote_unusable';

  // Realized ENTRY-leg half-spread, as a reference, when the entry leg is priced. The entry
  // fill is guarded at `> 0` symmetrically with the exit (TRA-2283 D1): a zero-filled entry
  // leg yields hEntry = ∓1, which is what made entryH read as the negative of actualH.
  let hEntry = null;
  if (entry != null) {
    const reqEntry = usablePx(entry.requestedPx);
    const fillEntry = usablePx(entry.fillPx);
    if (reqEntry != null && fillEntry != null && (entry.side === 'buy' || entry.side === 'sell')) {
      hEntry = signedCross(entry.side, reqEntry, fillEntry) / reqEntry;
    }
  }

  return {
    structure: rec.strategy ?? 'unknown',
    etDay: rec.etDay ?? null,
    mode: 'sandbox',
    contracts,
    exitMidPerShare,
    exitSlippageUsd,        // realized exit cross, $ (signed)
    actualH,                // realized exit half-spread fraction (signed)
    hEntry,                 // realized entry-leg half-spread (reference)
    quotedH,                // QUOTED-book half-spread on the exit side (TRA-2283 D2)
    quoteState,             // TRA-2300 §3 — absent-key vs null-at-snap vs unusable vs quoted
    quotedCrossUsd: quotedH != null ? quotedH * exitMidPerShare * per : null,
  };
}

const TICK_USD = 0.01;
const TICK_EPSILON = 1e-9;

/**
 * TRA-3459 Task 2 — the MID-INVARIANT discriminator, in the absolute units `h` normalizes
 * away. MIRRORS `foldMidInvariants` in the server module; keep the two in step.
 *
 * The old non-degeneracy guard (`median !== p90`, `clamped === 0`) is VACUOUS — a synthetic
 * constant-width book passes it, because the MID varies even when the width does not. The
 * integer-tick count is the check that separates a lattice from a real book.
 *
 * `hOf` may be signed (`actualH` is); the magnitude is taken, because a book's WIDTH has no
 * sign and signing it would put half the rows at negative ticks.
 */
function foldMidInvariants(rows, hOf) {
  if (rows.length === 0) {
    return {
      n: 0, midMedianUsd: null, fullSpreadUsd: null, fullSpreadTicks: null,
      tickQuantizedRows: 0, maxTickDeviation: null, distinctWidthTicks: null,
      modalWidthTicks: null, widthHistogramTicks: [],
    };
  }
  const mids = rows.map((s) => s.exitMidPerShare).sort((a, b) => a - b);
  const full = rows.map((s) => 2 * Math.abs(hOf(s)) * s.exitMidPerShare);
  const ticks = full.map((w) => w / TICK_USD);
  const devs = ticks.map((t) => Math.abs(t - Math.round(t)));
  const hist = new Map();
  for (const t of ticks) { const k = Math.round(t); hist.set(k, (hist.get(k) ?? 0) + 1); }
  const entries = [...hist.entries()].sort((a, b) => a[0] - b[0]);
  const modal = [...entries].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const fullSorted = [...full].sort((a, b) => a - b);
  const tickSorted = [...ticks].sort((a, b) => a - b);
  return {
    n: rows.length,
    midMedianUsd: quantile(mids, 0.5),
    fullSpreadUsd: { median: quantile(fullSorted, 0.5), p90: quantile(fullSorted, 0.9) },
    fullSpreadTicks: { median: quantile(tickSorted, 0.5), p90: quantile(tickSorted, 0.9) },
    tickQuantizedRows: devs.filter((d) => d < TICK_EPSILON).length,
    maxTickDeviation: Math.max(...devs),
    distinctWidthTicks: entries.length,
    modalWidthTicks: { ticks: modal[0], rows: modal[1] },
    widthHistogramTicks: entries,
  };
}

function summarize(samples, h) {
  const actualHs = samples.map((s) => s.actualH).sort((a, b) => a - b);
  const actualCross = samples.map((s) => s.exitSlippageUsd).sort((a, b) => a - b);
  // Modeled cross under the flag's h, using the SAME exit mid the actual cross was
  // measured against, so the two are dollar-comparable per row.
  const modeledCross = samples.map((s) => h * s.exitMidPerShare * s.contracts * CONTRACT_MULTIPLIER).sort((a, b) => a - b);
  const errUsd = samples.map((s) => h * s.exitMidPerShare * s.contracts * CONTRACT_MULTIPLIER - s.exitSlippageUsd);
  const withEntry = samples.filter((s) => s.hEntry != null);
  // TRA-2300 §2/§4 — keep the quote-bearing SUBSET as rows, so the quoted cross and the
  // modeled cross it is compared against are folded over exactly the same corpus. A p90 over
  // 26 rows against a p90 over 4 different rows is not a tail check.
  const quotedRows = samples.filter((s) => s.quotedH != null);
  const quoted = quotedRows.map((s) => s.quotedH).sort((a, b) => a - b);
  const quotedCross = quotedRows.map((s) => s.quotedCrossUsd).sort((a, b) => a - b);
  const modeledCrossOnQuoted = quotedRows
    .map((s) => h * s.exitMidPerShare * s.contracts * CONTRACT_MULTIPLIER)
    .sort((a, b) => a - b);
  const quotedEtDays = quotedRows.map((s) => s.etDay).filter((d) => typeof d === 'string' && d !== '').sort();
  const countState = (st) => samples.filter((s) => s.quoteState === st).length;
  return {
    n: samples.length,
    modeledH: h,
    actualH: { mean: mean(actualHs), median: quantile(actualHs, 0.5), p90: quantile(actualHs, 0.9) },
    actualCrossUsd: { mean: mean(actualCross), median: quantile(actualCross, 0.5), p90: quantile(actualCross, 0.9) },
    modeledCrossUsd: { mean: mean(modeledCross), median: quantile(modeledCross, 0.5), p90: quantile(modeledCross, 0.9) },
    modelErrorUsd: { mean: mean(errUsd), median: quantile([...errUsd].sort((a, b) => a - b), 0.5) },
    entryH: withEntry.length
      ? { n: withEntry.length, mean: mean(withEntry.map((s) => s.hEntry)) }
      : { n: 0, mean: Number.NaN },
    // TRA-2283 D2 — the QUOTED-book half-spread. n = 0 until round-trips booked after the D2
    // deploy accrue (earlier legs persisted no bid/ask). NaN moments mean "not yet
    // measurable"; they must NEVER be read as 0.
    quotedH: {
      n: quoted.length,
      clamped: quoted.filter((q) => q >= MAX_HALF_SPREAD_FRAC).length,
      mean: mean(quoted),
      median: quantile(quoted, 0.5),
      p90: quantile(quoted, 0.9),
      // TRA-2300 §4 — dispersion. A live chain snapped at N decision times cannot produce
      // min === max; if it does, the "quote" is a constant somebody wrote, not a book someone
      // read — and the moments alone would look perfectly healthy. `null` (never 0) at n=0.
      min: quoted.length ? quoted[0] : null,
      max: quoted.length ? quoted[quoted.length - 1] : null,
    },
    // TRA-2300 §2 — the quoted-basis cross and its PAIRED modeled cross on the same rows.
    quotedCrossUsd: {
      mean: mean(quotedCross), median: quantile(quotedCross, 0.5), p90: quantile(quotedCross, 0.9),
    },
    modeledCrossUsdOnQuoted: {
      mean: mean(modeledCrossOnQuoted),
      median: quantile(modeledCrossOnQuoted, 0.5),
      p90: quantile(modeledCrossOnQuoted, 0.9),
    },
    // TRA-2300 §3 — the census. Exhaustive: the four STATE counts sum to n, so a reader
    // reconciles rather than inferring a residual (which is where a fifth, unnamed state
    // would hide).
    //
    // TRA-2600 — `quote_null_at_snap` is WRITER-UNREACHABLE and always 0: mapLeg takes
    // requestedPx, bid and ask off ONE DecisionQuote and buildDecisionQuote nulls the mid
    // unless both sides are > 0, so a dead snap is DROPPED as `unpriced_exit_quote` before it
    // can be classified. The dead-venue signal is `unpricedExitQuoteDropped` below — a
    // cross-reference into `exclusions`, deliberately OUTSIDE the four-state sum (a dropped
    // record is never a retained sample). `null` here = NOT ATTRIBUTED: this function folds
    // retained samples and cannot see a drop; `foldAll` patches in the real count.
    quoteCoverage: {
      retained: samples.length,
      quoted: quoted.length,
      legacy_no_quote_field: countState('legacy_no_quote_field'),
      quote_null_at_snap: countState('quote_null_at_snap'),
      quote_unusable: countState('quote_unusable'),
      unpricedExitQuoteDropped: null,
      etDayMin: quotedEtDays.length ? quotedEtDays[0] : null,
      etDayMax: quotedEtDays.length ? quotedEtDays[quotedEtDays.length - 1] : null,
    },
    // TRA-3459 Task 2 — the mid-invariant discriminator on both bases.
    midInvariants: {
      quoted: foldMidInvariants(quotedRows, (s) => s.quotedH),
      all: foldMidInvariants(samples, (s) => s.actualH),
    },
  };
}

/**
 * TRA-2600 — the DEAD-VENUE sentence. MIRRORS `deadSnapClause` in
 * packages/server/src/marketable-mtm-forward-validation.ts; keep the two in step.
 *
 * Exists so a dead venue and a draining legacy backlog render DIFFERENT strings. Before this
 * they were byte-identical — both said "0 had a null quote AT SNAP", because the only counter
 * that moves for a dead venue lives in `exclusions`, which this reason never referenced.
 */
function deadSnapClause(c) {
  const dropped = c.unpricedExitQuoteDropped;
  if (dropped == null) {
    return ' Dead-snap drops (exclusions.unpriced_exit_quote) are NOT ATTRIBUTED at this level'
      + ' — this census covers retained rows only; read the pooled quoteCoverage.';
  }
  if (dropped > 0) {
    return ` DEAD VENUE: a further ${dropped} record(s) were DROPPED BEFORE retention with no`
      + ` usable exit quote at all (exclusions.unpriced_exit_quote), OVER AND ABOVE the`
      + ` ${c.retained} retained rows above. This is NOT a draining legacy backlog — those rows`
      + ' will never age into a gradeable quotedH, and the count does not shrink on its own.';
  }
  return ' No record was dropped for a missing exit quote (exclusions.unpriced_exit_quote = 0),'
    + ' so the venue returned a two-sided book on every snap: the shortfall above is a LEGACY'
    + ' DRAIN, which does resolve as post-4871bbc round-trips accrue.';
}

/** TRA-2600 — patch the dead-venue cross-reference onto a summary's coverage census. */
function withUnpricedDrops(summary, dropped) {
  return { ...summary, quoteCoverage: { ...summary.quoteCoverage, unpricedExitQuoteDropped: dropped } };
}

/**
 * TRA-3459 — the CALIBRATION POPULATION of `h = 0.134`. MIRRORS `MODELED_H_CALIBRATION` in
 * packages/server/src/marketable-mtm-forward-validation.ts; keep the two in step. See that
 * constant's doc for provenance — 140 demo-journal rows, 2026-07-15..07-21, reproduced against
 * `.tra2131-analysis.md` on every published moment.
 *
 * The load-bearing field is `statistic: 'mean'`. `0.134` is the MEAN of a right-skewed
 * distribution whose MEDIAN is 0.0667, and the predicate below used to compare a median to it.
 */
const MODELED_H_CALIBRATION = {
  statistic: 'mean',
  n: 140,
  h: { mean: 0.1351, median: 0.0667, p90: 0.3532, medianToMeanRatio: 0.4937 },
  midUsd: { median: 1.32 },
  fullSpreadUsd: { median: 0.15 },
};
const POPULATION_FITNESS_MIN_N = 10;
const POPULATION_FITNESS_MAX_RATIO = 3;

/**
 * TRA-3459 — can `h` be graded on this population AT ALL? MIRRORS
 * `marketableMtmPopulationFitness` in the server module; keep the two in step.
 *
 * The rule is a theorem, not a threshold: `min(x) <= mean(x) <= max(x)` for every sample, so if
 * `modeledH` sits further than `tol` outside `[min(quotedH), max(quotedH)]` then
 * `|mean(quotedH) − modeledH| > tol` is FORCED and the comparison has no pass state on this
 * book. The width/mid ratios are reported to EXPLAIN it and decide nothing.
 */
function populationFitness(summary, tol) {
  const inv = summary.midInvariants?.quoted;
  const ratio = (a, b) => (
    a == null || !Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0
      ? null
      : (a >= b ? a / b : b / a)
  );
  const observed = {
    midMedianUsd: inv?.midMedianUsd ?? null,
    fullSpreadUsdMedian: inv?.fullSpreadUsd?.median ?? null,
  };
  const widthRatio = ratio(observed.fullSpreadUsdMedian, MODELED_H_CALIBRATION.fullSpreadUsd.median);
  const midRatio = ratio(observed.midMedianUsd, MODELED_H_CALIBRATION.midUsd.median);
  const lo = summary.quotedH.min, hi = summary.quotedH.max;
  const base = {
    n: summary.quotedH.n, tol, modeledH: summary.modeledH,
    observedHSupport: { min: lo, max: hi },
    maxRatio: POPULATION_FITNESS_MAX_RATIO, widthRatio, midRatio, observed,
  };
  if (summary.quotedH.n < POPULATION_FITNESS_MIN_N
    || lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { ...base, verdict: 'unmeasured', supportGap: null, hNeededForGradeability: null, reasons: [] };
  }
  const h = summary.modeledH;
  const supportGap = h < lo ? lo - h : h > hi ? h - hi : 0;
  if (supportGap <= tol) {
    return { ...base, verdict: 'fit', supportGap, hNeededForGradeability: null, reasons: [] };
  }
  const needed = h > hi ? h - tol : h + tol;
  const reasons = [
    `modeled h ${h} lies ${supportGap.toFixed(4)} OUTSIDE the entire observed support of `
    + `quotedH [${lo.toFixed(5)}, ${hi.toFixed(5)}] over ${summary.quotedH.n} rows, against a `
    + `tolerance of ${tol}. A mean always lies inside its own sample's support, so `
    + `|mean(quotedH) − ${h}| > ${tol} is FORCED on this population — the comparison has no `
    + `pass state here, and accruing more rows of the same book cannot create one. It would `
    + `become gradeable if the book's far edge reached h ≈ ${needed.toFixed(4)}`,
  ];
  if (widthRatio != null && widthRatio > POPULATION_FITNESS_MAX_RATIO) {
    reasons.push(`WIDTH regime differs ${widthRatio.toFixed(1)}× (validation median full spread `
      + `$${observed.fullSpreadUsdMedian.toFixed(3)} vs calibration `
      + `$${MODELED_H_CALIBRATION.fullSpreadUsd.median.toFixed(2)}). h is LINEAR in the width, so `
      + 'no mid-bucketing removes this term');
  }
  if (midRatio != null && midRatio > POPULATION_FITNESS_MAX_RATIO) {
    reasons.push(`MID regime differs ${midRatio.toFixed(1)}× (validation median mid `
      + `$${observed.midMedianUsd.toFixed(2)} vs calibration `
      + `$${MODELED_H_CALIBRATION.midUsd.median.toFixed(2)}). h is INVERSE in the mid`);
  }
  return { ...base, verdict: 'unfit', supportGap, hNeededForGradeability: needed, reasons };
}

/** True when the modeled p90 cross fails to cover the actual p90 cross. */
function isTailUnderCharged(summary) {
  return !(summary.modeledCrossUsd.p90 >= summary.actualCrossUsd.p90);
}

function underChargeRatio(summary) {
  const m = summary.modeledCrossUsd.p90, a = summary.actualCrossUsd.p90;
  if (!Number.isFinite(m) || !Number.isFinite(a) || m <= 0 || a <= m) return null;
  return a / m;
}

/** TRA-2300 §2 — the QUOTED-basis tail check, over the quote-bearing rows only. Returns false
 *  when either p90 is non-finite: NOT-MEASURABLE is not a tail failure, and the quotedH.n floor
 *  is what stops an unmeasurable tail from reading as a covered one. */
function isQuotedTailUnderCharged(summary) {
  const m = summary.modeledCrossUsdOnQuoted.p90, q = summary.quotedCrossUsd.p90;
  if (!Number.isFinite(m) || !Number.isFinite(q)) return false;
  return !(m >= q);
}

function quotedUnderChargeRatio(summary) {
  const m = summary.modeledCrossUsdOnQuoted.p90, q = summary.quotedCrossUsd.p90;
  if (!Number.isFinite(m) || !Number.isFinite(q) || m <= 0 || q <= m) return null;
  return q / m;
}

/**
 * TRA-2300 §1 — **THE GATE.** Same shape and tolerance as `verdict`, but decided on
 * `quotedH.median` and gated on **`quotedH.n`, not `summary.n`**: rows with a usable FILL are
 * not rows with a usable QUOTE, and gating on `summary.n` would let quote-less rows clear the
 * floor and hand back a verdict computed from NaN.
 */
function quotedVerdict(summary, tol, minN) {
  const qn = summary.quotedH.n;

  // TRA-3459 — POPULATION FITNESS, asked BEFORE the n floor. When the population cannot decide
  // the question, "insufficient n" is the wrong answer and it is the one that cost TRA-2242
  // four beats of accrual. MIRRORS the server module's ordering; keep the two in step.
  const fitness = populationFitness(summary, tol);
  if (fitness.verdict === 'unfit') {
    const inv = summary.midInvariants.quoted;
    return {
      code: 'NOT_GRADEABLE',
      basis: 'quotedH',
      reason: 'NOT GRADEABLE ON THIS POPULATION — the validation book is not the book h was '
        + `calibrated on, and MORE ROWS OF THIS BOOK CANNOT FIX IT. ${fitness.reasons.join('; ')}. `
        + `Calibration population: ${MODELED_H_CALIBRATION.n} demo-journal rows, median mid `
        + `$${MODELED_H_CALIBRATION.midUsd.median.toFixed(2)}, median full spread `
        + `$${MODELED_H_CALIBRATION.fullSpreadUsd.median.toFixed(2)}, mean h `
        + `${MODELED_H_CALIBRATION.h.mean} (median ${MODELED_H_CALIBRATION.h.median}). `
        + `Validation population: ${qn} quoted rows, median mid `
        + `$${(inv.midMedianUsd ?? NaN).toFixed(2)}, median full spread `
        + `$${(inv.fullSpreadUsd?.median ?? NaN).toFixed(3)} (${inv.tickQuantizedRows}/${inv.n} `
        + `integer-tick, ${inv.distinctWidthTicks ?? 0} distinct widths, modal `
        + `${inv.modalWidthTicks?.ticks ?? 0}¢). This is a TERMINAL, not a wait. TRA-2242 needs a `
        + 'different evidence source for h. Do NOT retune h to close the gap: fitting 0.134 to '
        + '~0.003 collapses the haircut to mid-marking, the TRA-2131 shape TRA-2233 removes.',
    };
  }

  if (qn < minN) {
    const c = summary.quoteCoverage;
    return {
      code: 'REVIEW',
      basis: 'quotedH',
      reason: `insufficient QUOTED-basis n (${qn} < ${minN}); of ${c.retained} retained rows `
        + `${c.legacy_no_quote_field} predate the bid/ask writer (legacy_no_quote_field), `
        + `${c.quote_null_at_snap} had a null quote AT SNAP (quote_null_at_snap — `
        + 'WRITER-UNREACHABLE, always 0; not the dead-venue signal), '
        + `${c.quote_unusable} carried an unusable book.${deadSnapClause(c)} bid/ask persist `
        + 'only from 4871bbc (TRA-2283 D2) — the legacy count drains as those rows age out; '
        + 'the DROP count does not drain and means the gate can never be graded.',
    };
  }
  // TRA-3459 — the decision variable is the MEAN. `modeledH` IS a mean
  // (MODELED_H_CALIBRATION.statistic) and the DARK mark applies it to every position. This
  // line used to read `summary.quotedH.median`, which is a p50 against a mean across a 2.03×
  // skew and cannot pass on the calibration population itself (TRA-2602).
  const impliedMedianH = summary.modeledH * MODELED_H_CALIBRATION.h.medianToMeanRatio;
  const shape = `shape: median ${summary.quotedH.median.toFixed(4)} vs the calibration-implied `
    + `${impliedMedianH.toFixed(4)} — DIAGNOSTIC, not graded`;
  const withinTol = Math.abs(summary.quotedH.mean - summary.modeledH) <= tol;
  const tailOk = !isQuotedTailUnderCharged(summary);
  if (withinTol && tailOk) {
    return {
      code: 'PASS',
      basis: 'quotedH',
      reason: `mean QUOTED h ${summary.quotedH.mean.toFixed(4)} within ±${tol} of modeled `
        + `${summary.modeledH} (statistic-matched: modeledH is a MEAN); quoted tail covered `
        + `(modeled p90 $${summary.modeledCrossUsdOnQuoted.p90.toFixed(2)} `
        + `≥ quoted p90 $${summary.quotedCrossUsd.p90.toFixed(2)} over the same ${qn} quote-bearing rows); ${shape}`,
    };
  }
  const bits = [];
  if (!withinTol) {
    bits.push(`mean QUOTED h ${summary.quotedH.mean.toFixed(4)} outside ±${tol} of modeled `
      + `${summary.modeledH} (statistic-matched: modeledH is a MEAN); ${shape}`);
  }
  if (!tailOk) {
    const r = quotedUnderChargeRatio(summary);
    bits.push(`modeled p90 cross $${summary.modeledCrossUsdOnQuoted.p90.toFixed(2)} < quoted p90 `
      + `$${summary.quotedCrossUsd.p90.toFixed(2)} (under-charges the tail${r != null ? ` — under-charged ${r.toFixed(1)}×` : ''})`);
  }
  return { code: 'REVIEW', basis: 'quotedH', reason: bits.join('; ') };
}

/** TRA-2300 §1+§2 — the pooled QUOTED gate: D3's "any structure under-charged forces REVIEW"
 *  rule, carried onto the basis that actually grades. The per-structure floor is applied to
 *  `quotedH.n` (a structure can hold 30 filled rows and ZERO quotes), and structures under it
 *  are NAMED as ungradeable — "nothing was flagged" must not read like "nothing was checked". */
function quotedPooledVerdict(summary, structures, tol, minN, requirePerStructureMinN, perStructureMinN) {
  const base = quotedVerdict(summary, tol, minN);
  const bits = [];
  const under = structures.filter((s) => s.quotedTailUnderCharged);
  if (under.length > 0) {
    const named = [...under]
      .sort((a, b) => (b.quotedTailUnderChargeRatio ?? Infinity) - (a.quotedTailUnderChargeRatio ?? Infinity))
      .map((s) => `${s.structure} (quoted n=${s.quotedH.n}, quoted p90 $${s.quotedCrossUsd.p90.toFixed(2)} vs modeled $${s.modeledCrossUsdOnQuoted.p90.toFixed(2)} — under-charged ${s.quotedTailUnderChargeRatio != null ? `${s.quotedTailUnderChargeRatio.toFixed(1)}×` : 'modeled p90 ≤ 0'})`)
      .join(', ');
    bits.push(`per-structure QUOTED tail UNDER-CHARGED: ${named}`);
  }
  const below = structures.filter((s) => s.quotedH.n < perStructureMinN).map((s) => `${s.structure} (quoted n=${s.quotedH.n})`);
  if (requirePerStructureMinN && below.length > 0) {
    bits.push(`insufficient per-structure QUOTED n (< ${perStructureMinN}), NOT gradeable: ${below.join(', ')}`);
  }
  if (bits.length === 0) return base;
  // TRA-3459 — a NOT_GRADEABLE base KEEPS its code. Folding it down to REVIEW would restore
  // the "grade it later" reading the terminal exists to remove, from a branch that only fires
  // once rows accrue. MIRRORS the server module; keep the two in step.
  if (base.code === 'NOT_GRADEABLE') {
    return { code: 'NOT_GRADEABLE', basis: 'quotedH', reason: `${base.reason} ALSO: ${bits.join('; ')}` };
  }
  return { code: 'REVIEW', basis: 'quotedH', reason: `${base.code === 'REVIEW' ? `${base.reason}; ` : ''}${bits.join('; ')}` };
}

function verdict(summary, tol, minN) {
  if (summary.n < minN) {
    return { code: 'REVIEW', basis: 'actualH', reason: `insufficient n (${summary.n} < ${minN}); accrue more parity-true sandbox round-trips` };
  }
  const withinTol = Math.abs(summary.actualH.median - summary.modeledH) <= tol;
  // The tail must not be UNDER-charged: a modeled mark that haircuts LESS than the
  // real fill re-inflates realizable P&L — the bias this ticket removes.
  const tailNotUnderCharged = !isTailUnderCharged(summary);
  if (withinTol && tailNotUnderCharged) {
    return { code: 'PASS', basis: 'actualH', reason: `median realized h ${summary.actualH.median.toFixed(4)} within ±${tol} of modeled ${summary.modeledH}; tail covered` };
  }
  const bits = [];
  // TRA-2283 D2 — this is a DESCRIPTION of where the measured median sits, NOT an
  // instruction. On a SANDBOX_SIMULATED venue that fills at the decision mid, actualH is ~0
  // by construction, so "retune h" off it would collapse the haircut to mid-marking.
  if (!withinTol) bits.push(`median realized h ${summary.actualH.median.toFixed(4)} outside ±${tol} of modeled ${summary.modeledH} (measured median ≈ ${summary.actualH.median.toFixed(3)} — do NOT retune --h off a SANDBOX_SIMULATED fill; grade on quotedH)`);
  if (!tailNotUnderCharged) bits.push(`modeled p90 cross $${summary.modeledCrossUsd.p90.toFixed(2)} < actual p90 $${summary.actualCrossUsd.p90.toFixed(2)} (under-charges the tail)`);
  return { code: 'REVIEW', basis: 'actualH', reason: bits.join('; ') };
}

/** TRA-2283 D3 — per-structure fold; the pooled verdict may not absolve a structure whose
 *  own tail is under-charged (pooled read "covered" at $61.14 ≥ $4.00 while long_call was
 *  under-charged 2.8× — signs that flip with structure direction cancel in the pool). */
function perStructureBreakdown(samples, h, tol, perStructureMinN, unpricedByStructure = new Map()) {
  const by = new Map();
  for (const s of samples) {
    const list = by.get(s.structure) ?? [];
    list.push(s);
    by.set(s.structure, list);
  }
  return [...by.entries()]
    .map(([structure, list]) => {
      // TRA-2600 — GENUINELY attributed, and patched BEFORE the verdicts below so the
      // per-structure quoted REVIEW reason carries this structure's own count. Defaulting to 0
      // here would make every structure report "no dead snaps" regardless of truth.
      const sub = withUnpricedDrops(summarize(list, h), unpricedByStructure.get(structure) ?? 0);
      return {
        structure,
        ...sub,
        tailUnderCharged: isTailUnderCharged(sub),
        tailUnderChargeRatio: underChargeRatio(sub),
        quotedTailUnderCharged: isQuotedTailUnderCharged(sub),
        quotedTailUnderChargeRatio: quotedUnderChargeRatio(sub),
        // Graded at the PER-STRUCTURE floor, not the pooled one — otherwise every structure in
        // a healthy 4-way split reads "insufficient n (20 < 30)".
        verdict: verdict(sub, tol, perStructureMinN),
        quotedVerdict: quotedVerdict(sub, tol, perStructureMinN),
      };
    })
    .sort((a, b) => b.n - a.n || a.structure.localeCompare(b.structure));
}

function pooledVerdict(summary, structures, tol, minN, requirePerStructureMinN, perStructureMinN) {
  const base = verdict(summary, tol, minN);
  const bits = [];
  const under = structures.filter((s) => s.tailUnderCharged);
  if (under.length > 0) {
    const named = [...under]
      .sort((a, b) => (b.tailUnderChargeRatio ?? Infinity) - (a.tailUnderChargeRatio ?? Infinity))
      .map((s) => `${s.structure} (n=${s.n}, actual p90 $${s.actualCrossUsd.p90.toFixed(2)} vs modeled $${s.modeledCrossUsd.p90.toFixed(2)} — under-charged ${s.tailUnderChargeRatio != null ? `${s.tailUnderChargeRatio.toFixed(1)}×` : 'modeled p90 ≤ 0'})`)
      .join(', ');
    bits.push(`per-structure tail UNDER-CHARGED: ${named}`);
  }
  const below = structures.filter((s) => s.n < perStructureMinN).map((s) => `${s.structure} (n=${s.n})`);
  if (requirePerStructureMinN && below.length > 0) {
    bits.push(`insufficient per-structure n (< ${perStructureMinN}): ${below.join(', ')}`);
  }
  if (bits.length === 0) return base;
  return { code: 'REVIEW', basis: 'actualH', reason: `${base.code === 'REVIEW' ? `${base.reason}; ` : ''}${bits.join('; ')}` };
}

// Build a synthetic SANDBOX journal (one full record per line) whose EXIT-leg realized
// half-spread ≈ `halfSpread`. Deterministic (no RNG). Alternates a long_call (exit =
// SELL below mid) and a csp (short exit = BUY above mid) so both leg-side branches of
// `toSample` are exercised. qty is 1 per record.
function synthSandboxCorpus(halfSpread, n = 40) {
  const entryH = 0.06;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const isLong = i % 2 === 0;
    const strategy = isLong ? 'long_call' : 'csp';
    const exitMid = 1.0 + (i % 5) * 0.1;   // a spread of exit mids
    const entryMid = 0.8 + (i % 4) * 0.05;
    // Entry leg: long BUYS (fill above mid), short SELLS (fill below mid).
    const entrySide = isLong ? 'buy' : 'sell';
    const entryFill = isLong ? entryMid * (1 + entryH) : entryMid * (1 - entryH);
    // Exit leg: long SELLS (fill below mid), short BUYS (fill above mid).
    const exitSide = isLong ? 'sell' : 'buy';
    const exitFill = isLong ? exitMid * (1 - halfSpread) : exitMid * (1 + halfSpread);
    // TRA-2283 D2 — a symmetric two-sided book around each mid, so `quotedH` recovers
    // EXACTLY `halfSpread` on both exit branches (sell ⇒ mid→bid, buy ⇒ mid→ask).
    const entryBid = entryMid * (1 - halfSpread), entryAsk = entryMid * (1 + halfSpread);
    const exitBid = exitMid * (1 - halfSpread), exitAsk = exitMid * (1 + halfSpread);
    const rec = {
      ts: 1_700_000_000_000 + i,
      etDay: '2026-07-24',
      strategy,
      underlying: 'AAPL',
      ok: true,
      realizedRoundTripUsd: (exitFill - entryFill) * CONTRACT_MULTIPLIER,
      legs: [
        { side: entrySide, optionSymbol: 'AAPL', submitTs: 1, fillTs: 2, signalToSubmitMs: 40, requestedPx: entryMid, bid: entryBid, ask: entryAsk, fillPx: entryFill, slippageBps: null, spreadAtSubmitPct: null, withinSpread: null },
        { side: exitSide, optionSymbol: 'AAPL', submitTs: 3, fillTs: 4, signalToSubmitMs: 40, requestedPx: exitMid, bid: exitBid, ask: exitAsk, fillPx: exitFill, slippageBps: null, spreadAtSubmitPct: null, withinSpread: null },
      ],
    };
    lines.push(JSON.stringify(rec));
  }
  return lines.join('\n');
}

/**
 * TRA-2300 — a corpus on THIS VENUE'S ACTUAL SHAPE: every leg fills at the decision mid, so
 * `actualH` is dead by construction (exactly as observed live), while the QUOTED book is real
 * and two-sided at `quotedHs[i % len]`. The mid is CONSTANT so the modeled cross is constant
 * and a quoted-tail under-charge can only come from the quoted half-spread — not from a mid
 * that happens to be larger on the wide rows. Deterministic (no RNG).
 */
function synthQuotedCorpus(quotedHs, n = 40, mid = 2.0, etDay = '2026-07-26') {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const isLong = i % 2 === 0;
    const qh = quotedHs[i % quotedHs.length];
    const bid = mid * (1 - qh), ask = mid * (1 + qh);
    const legOf = (side, submitTs) => ({
      side, optionSymbol: 'AAPL', submitTs, fillTs: submitTs + 1, signalToSubmitMs: 40,
      requestedPx: mid, bid, ask, fillPx: mid,
      slippageBps: null, spreadAtSubmitPct: null, withinSpread: null,
    });
    lines.push(JSON.stringify({
      ts: 1_700_000_000_000 + i,
      etDay,
      strategy: isLong ? 'long_call' : 'csp',
      underlying: 'AAPL',
      ok: true,
      realizedRoundTripUsd: 0,
      legs: [legOf(isLong ? 'buy' : 'sell', 1), legOf(isLong ? 'sell' : 'buy', 3)],
    }));
  }
  return lines.join('\n');
}

function report(summary, v, args, extra = {}) {
  const { perStructure = [], exclusions = null, quotedV = null, structuresFullyDeadSnapped = [] } = extra;
  if (args.json) {
    console.log(JSON.stringify({
      ...summary,
      // TRA-2300 §1 — `verdict` keeps its name (an old-shaped consumer must not be handed a
      // DIFFERENT number under a name it already trusts); `quotedVerdict` is the gate.
      verdict: v,
      actualVerdict: v,
      quotedVerdict: quotedV,
      gradedBasis: 'quotedH',
      verdictBasisNote: 'quotedVerdict (basis quotedH) IS THE GATE. verdict/actualVerdict '
        + '(basis actualH) is ADVISORY ONLY: on a SANDBOX_SIMULATED venue that fills at the '
        + 'decision mid it reads ~0 whether the true spread is 0 or the simulator ignores the '
        + 'book, so it has no failing state. The process exit code follows quotedVerdict.',
      tol: args.tol,
      minN: args.minN,
      perStructureMinN: args.perStructureMinN,
      requirePerStructureMinN: args.requirePerStructureMinN,
      perStructureMinNNote: 'a FLOOR CHECK, not an estimate — ten points do not estimate a p90',
      fillRealism: 'SANDBOX_SIMULATED',
      excludedZeroFill: exclusions?.zero_fill_exit ?? 0,
      exclusions,
      perStructure,
      structuresBelowMinN: perStructure.filter((s) => s.n < args.perStructureMinN).map((s) => s.structure),
      structuresBelowQuotedMinN: perStructure.filter((s) => s.quotedH.n < args.perStructureMinN).map((s) => s.structure),
      // TRA-2600 — structures dead on EVERY snap have no perStructure entry to carry a count.
      structuresFullyDeadSnapped,
    }, null, 2));
    return;
  }
  console.log('TRA-2233 marketable(bid) forward-validation  [source: sandbox-strategy-journal, exit-leg cross]');
  console.log('─'.repeat(60));
  console.log(`samples (parity-true exit-leg cross):    ${summary.n}`);
  console.log(`modeled half-spread h:                  ${summary.modeledH}`);
  console.log(`realized h  mean/median/p90:            ${summary.actualH.mean.toFixed(4)} / ${summary.actualH.median.toFixed(4)} / ${summary.actualH.p90.toFixed(4)}`);
  console.log(`actual  cross $  mean/median/p90:        ${summary.actualCrossUsd.mean.toFixed(2)} / ${summary.actualCrossUsd.median.toFixed(2)} / ${summary.actualCrossUsd.p90.toFixed(2)}`);
  console.log(`modeled cross $  mean/median/p90:        ${summary.modeledCrossUsd.mean.toFixed(2)} / ${summary.modeledCrossUsd.median.toFixed(2)} / ${summary.modeledCrossUsd.p90.toFixed(2)}`);
  console.log(`model error $ (modeled−actual) mean:     ${summary.modelErrorUsd.mean.toFixed(2)}`);
  if (summary.entryH.n) console.log(`entry-leg realized h (ref, n=${summary.entryH.n}):    ${summary.entryH.mean.toFixed(4)}`);
  // TRA-2283 D2 — the falsifiable line. n=0 means "no persisted quote yet", NOT "no spread".
  console.log(summary.quotedH.n
    ? `QUOTED-book h (n=${summary.quotedH.n}) mean/median/p90:  ${summary.quotedH.mean.toFixed(4)} / ${summary.quotedH.median.toFixed(4)} / ${summary.quotedH.p90.toFixed(4)}`
    : 'QUOTED-book h:                          n=0 — no persisted bid/ask on these legs (pre-TRA-2283 D2 records)');
  // TRA-2300 §4 — dispersion. min === max on a multi-day sample means a CONSTANT was written,
  // not a book read; the moments above would look identical either way.
  if (summary.quotedH.n) {
    console.log(`QUOTED-book h min/max (dispersion):     ${summary.quotedH.min.toFixed(4)} / ${summary.quotedH.max.toFixed(4)}${summary.quotedH.min === summary.quotedH.max ? '  ⚠ min === max — a CONSTANT quote, not a book' : ''}`);
    console.log(`quoted cross $ p90 vs modeled p90:      ${summary.quotedCrossUsd.p90.toFixed(2)} vs ${summary.modeledCrossUsdOnQuoted.p90.toFixed(2)} (same ${summary.quotedH.n} rows)`);
  }
  // TRA-2300 §3 — ABSENT vs NULL. Same observable zero, opposite diagnoses.
  {
    const c = summary.quoteCoverage;
    console.log(`quote coverage (of ${String(c.retained).padStart(3)} retained):      quoted=${c.quoted}  legacy_no_quote_field=${c.legacy_no_quote_field}  quote_null_at_snap=${c.quote_null_at_snap}(unreachable)  quote_unusable=${c.quote_unusable}`);
    console.log(`quote-bearing etDay range:              ${c.etDayMin ?? '—'} … ${c.etDayMax ?? '—'}`);
    // TRA-2600 — THE dead-venue line. `quote_null_at_snap` is writer-unreachable and always 0,
    // so the old "⚠ quote_null_at_snap > 0" warning here could never fire. This one can.
    {
      const d = c.unpricedExitQuoteDropped;
      const dead = d == null
        ? 'NOT ATTRIBUTED (retained-only census)'
        : d > 0
          ? `${d}   ⚠ DEAD VENUE — no usable exit quote at snap; these rows are OUTSIDE the ${c.retained} retained above and do NOT drain with age`
          : '0   (venue quoted two-sided on every snap ⇒ any shortfall above is a LEGACY DRAIN)';
      console.log(`dead snaps DROPPED (unpriced_exit_quote): ${dead}`);
      if (structuresFullyDeadSnapped.length) {
        console.log(`  ⚠ dead on EVERY snap (no retained row, so absent from perStructure): ${structuresFullyDeadSnapped.join(', ')}`);
      }
    }
  }
  console.log('fill realism:                           SANDBOX_SIMULATED (fills at the decision mid ⇒ actualH ~0 BY CONSTRUCTION; grade on quotedH)');
  if (exclusions != null) {
    const zf = exclusions.zero_fill_exit ?? 0;
    console.log(`excluded (zero/false-$0 exit fill):     ${zf}${zf ? '  ← each would have folded to actualH = ±1 exactly (TRA-2283 D1)' : ''}`);
    const others = Object.entries(exclusions).filter(([k, n]) => k !== 'zero_fill_exit' && n > 0);
    if (others.length) console.log(`excluded (other):                       ${others.map(([k, n]) => `${k}=${n}`).join(', ')}`);
  }
  if (perStructure.length) {
    console.log('─'.repeat(60));
    console.log('PER-STRUCTURE (TRA-2283 D3 — the pooled fold hid a per-structure tail under-charge):');
    for (const s of perStructure) {
      const flag = s.tailUnderCharged
        ? `  ⚠ TAIL UNDER-CHARGED ${s.tailUnderChargeRatio != null ? `${s.tailUnderChargeRatio.toFixed(1)}×` : ''}`
        : '';
      const qflag = s.quotedTailUnderCharged
        ? `  ⚠ QUOTED TAIL UNDER-CHARGED ${s.quotedTailUnderChargeRatio != null ? `${s.quotedTailUnderChargeRatio.toFixed(1)}×` : ''}`
        : '';
      console.log(`  ${s.structure.padEnd(14)} n=${String(s.n).padStart(3)}  h med ${s.actualH.median.toFixed(4)}  actual p90 $${s.actualCrossUsd.p90.toFixed(2)}  modeled p90 $${s.modeledCrossUsd.p90.toFixed(2)}  ${s.verdict.code}${flag}`);
      console.log(`  ${' '.repeat(14)} quoted n=${String(s.quotedH.n).padStart(3)}  q med ${Number.isFinite(s.quotedH.median) ? s.quotedH.median.toFixed(4) : '  n/a '}  quoted p90 $${Number.isFinite(s.quotedCrossUsd.p90) ? s.quotedCrossUsd.p90.toFixed(2) : 'n/a'}  modeled p90 $${Number.isFinite(s.modeledCrossUsdOnQuoted.p90) ? s.modeledCrossUsdOnQuoted.p90.toFixed(2) : 'n/a'}  ${s.quotedVerdict.code}${qflag}   ← GRADED`);
    }
  }
  console.log('─'.repeat(60));
  // TRA-2300 §1 — print BOTH and label which one grades. Printing only one, or printing them
  // unlabelled, is how a reader grades the wrong number.
  console.log(`VERDICT (pooled, GRADED — basis quotedH): ${quotedV ? `${quotedV.code} — ${quotedV.reason}` : 'n/a'}`);
  console.log(`verdict (pooled, ADVISORY — basis actualH, NOT the gate): ${v.code} — ${v.reason}`);
  console.log('note: actualH is measured requestedPx-vs-fillPx on a venue that fills at the decision');
  console.log('      mid, so it reads ~0 whether the true spread is 0 or the simulator ignores the');
  console.log('      book. Do NOT retune --h off it. The exit code follows the GRADED verdict.');
}

/** Fold a parsed record list exactly as `main` does — samples + exclusion tally + unpooled verdict. */
function foldAll(records, args) {
  const exclusions = {
    too_few_legs: 0, strategy_filter: 0, unpriced_exit_quote: 0,
    unfilled_exit: 0, zero_fill_exit: 0, bad_exit_side: 0,
  };
  // TRA-2600 — dead-snap drops attributed by structure, keyed the same way a sample's
  // `structure` is (`rec.strategy ?? 'unknown'`) so the two join. Re-classifying per record is
  // what lets the count be attributed at all: `toSample` returns null and loses the record.
  const unpricedByStructure = new Map();
  const samples = records.map((r) => {
    const before = exclusions.unpriced_exit_quote;
    const s = toSample(r, args.strategy, exclusions);
    if (exclusions.unpriced_exit_quote > before) {
      const key = r.strategy ?? 'unknown';
      unpricedByStructure.set(key, (unpricedByStructure.get(key) ?? 0) + 1);
    }
    return s;
  }).filter(Boolean);
  const summary = withUnpricedDrops(summarize(samples, args.h), exclusions.unpriced_exit_quote);
  const perStructure = perStructureBreakdown(samples, args.h, args.tol, args.perStructureMinN, unpricedByStructure);
  // Structures whose every row was dead-snapped have NO perStructure entry to carry a count;
  // absence reads as "not traded", which is worse than a 0. Name them.
  const structuresFullyDeadSnapped = [...unpricedByStructure.keys()]
    .filter((s) => !perStructure.some((p) => p.structure === s))
    .sort();
  const v = pooledVerdict(summary, perStructure, args.tol, args.minN, args.requirePerStructureMinN, args.perStructureMinN);
  // TRA-2300 §1 — the GRADED verdict. `v` stays in the payload as ADVISORY.
  const quotedV = quotedPooledVerdict(summary, perStructure, args.tol, args.minN, args.requirePerStructureMinN, args.perStructureMinN);
  return { samples, summary, perStructure, exclusions, v, quotedV, structuresFullyDeadSnapped };
}

function runSelfTest(args) {
  // 1. A corpus whose exit-leg realized half-spread ≈ 0.13 must PASS at the default h.
  {
    const f = foldAll(parseSandboxJournal(synthSandboxCorpus(0.13)), args);
    report(f.summary, f.v, args, f);
    if (f.v.code !== 'PASS') { console.error('SELF-TEST FAILED: expected PASS on the 0.13 synthetic corpus'); process.exit(1); }
    // TRA-2283 D2 — the synthetic book is symmetric around each mid, so quotedH must recover
    // the injected half-spread EXACTLY on both exit branches. If this drifts, the falsifiable
    // measurement is broken and only the un-fireable actualH is left.
    if (f.summary.quotedH.n !== f.summary.n || Math.abs(f.summary.quotedH.median - 0.13) > 1e-9) {
      console.error(`SELF-TEST FAILED: quotedH must recover 0.13 on all ${f.summary.n} rows (got n=${f.summary.quotedH.n}, median=${f.summary.quotedH.median})`);
      process.exit(1);
    }
  }
  // 2. Prove the harness can FALSIFY: a mid-booked corpus (fill = mid ⇒ actualH ≈ 0)
  //    must NOT pass — otherwise a detector that can't fire reads like one that passes.
  {
    const f = foldAll(parseSandboxJournal(synthSandboxCorpus(0.0)), args);
    if (f.v.code === 'PASS') { console.error('SELF-TEST FAILED: mid-booked corpus (actualH≈0) must NOT PASS at h=0.134'); process.exit(1); }
  }
  // 3. TRA-2283 D1 — a false-$0 exit fill must be EXCLUDED, not folded to actualH = ±1.
  {
    const clean = parseSandboxJournal(synthSandboxCorpus(0.13));
    const poisoned = JSON.parse(JSON.stringify(clean[0]));
    poisoned.legs[1].fillPx = 0;
    const f = foldAll([...clean, poisoned], args);
    if (f.samples.length !== clean.length || f.exclusions.zero_fill_exit !== 1) {
      console.error(`SELF-TEST FAILED: a fillPx=0 exit leg must be excluded and counted (n=${f.samples.length}, zeroFill=${f.exclusions.zero_fill_exit})`);
      process.exit(1);
    }
    if (f.samples.some((s) => Math.abs(s.actualH) > MAX_HALF_SPREAD_FRAC)) {
      console.error('SELF-TEST FAILED: a |actualH| > 0.5 row survived the fold');
      process.exit(1);
    }
  }
  // ── TRA-2300: the GRADED (quotedH) basis must fire in BOTH directions ──────
  // 4. A plausible quoted book near the modeled h must PASS on the graded basis — WHILE the
  //    advisory basis REVIEWs, because every fill is at the mid. That divergence is the whole
  //    ticket: grading actualH here would reject a model that is right.
  {
    const f = foldAll(parseSandboxJournal(synthQuotedCorpus([0.13])), args);
    if (f.quotedV.code !== 'PASS') {
      console.error(`SELF-TEST FAILED: quoted basis must PASS at quoted h=0.13 vs modeled 0.134 (got ${f.quotedV.code} — ${f.quotedV.reason})`);
      process.exit(1);
    }
    if (f.v.code !== 'REVIEW') {
      console.error('SELF-TEST FAILED: the ADVISORY basis must REVIEW on a mid-filled corpus (actualH ≈ 0)');
      process.exit(1);
    }
  }
  // 5. PROVE IT FIRES ON THE TAIL ALONE. 80% of rows quote at 0.0675 and 20% at 0.40, so the
  //    MEAN is exactly the modeled 0.134 — the tolerance check PASSES — and the only thing
  //    that can produce a REVIEW is the quoted tail check. A self-test that only exercised the
  //    passing direction is what let the actualH path look healthy for three tickets; this is
  //    the failing direction, isolated.
  //
  //    TRA-3459 rebalanced these values from `[0.134 ×4, 0.40]`, which pinned the MEDIAN at
  //    0.134 back when the median was the decision variable. Under a mean-based predicate that
  //    old corpus fails BOTH arms and stops isolating the tail.
  {
    const f = foldAll(parseSandboxJournal(synthQuotedCorpus([0.0675, 0.0675, 0.0675, 0.0675, 0.40])), args);
    if (Math.abs(f.summary.quotedH.mean - 0.134) > 1e-9) {
      console.error(`SELF-TEST FAILED: the tail fixture must hold the MEAN at the modeled h (got ${f.summary.quotedH.mean})`);
      process.exit(1);
    }
    if (f.quotedV.code !== 'REVIEW' || !/under-charges the tail/.test(f.quotedV.reason)) {
      console.error(`SELF-TEST FAILED: a wide quoted tail must force a quoted REVIEW (got ${f.quotedV.code} — ${f.quotedV.reason})`);
      process.exit(1);
    }
    if (/mean QUOTED h .* outside/.test(f.quotedV.reason)) {
      console.error('SELF-TEST FAILED: this fixture must fire on the TAIL, not the tolerance');
      process.exit(1);
    }
  }
  // 6. TRA-2300 §3 — the two missing-quote states must be SEPARABLE. Same observable zero,
  //    opposite diagnoses: absent keys drain as legacy rows age out; null-at-snap never does.
  {
    const recs = parseSandboxJournal(synthQuotedCorpus([0.13], 4));
    const legacy = JSON.parse(JSON.stringify(recs[0]));
    delete legacy.legs[1].bid; delete legacy.legs[1].ask;   // pre-4871bbc record
    const nulled = JSON.parse(JSON.stringify(recs[1]));
    nulled.legs[1].bid = null; nulled.legs[1].ask = null;    // snap returned no book
    const f = foldAll([legacy, nulled, recs[2], recs[3]], args);
    const c = f.summary.quoteCoverage;
    if (c.legacy_no_quote_field !== 1 || c.quote_null_at_snap !== 1 || c.quoted !== 2) {
      console.error(`SELF-TEST FAILED: quote states must separate (got ${JSON.stringify(c)})`);
      process.exit(1);
    }
    if (c.legacy_no_quote_field + c.quote_null_at_snap + c.quote_unusable + c.quoted !== c.retained) {
      console.error('SELF-TEST FAILED: quote-coverage counts must reconcile against n');
      process.exit(1);
    }
    // TRA-2600 — the cross-reference is OUTSIDE that sum, and this corpus drops nothing, so it
    // must be a MEASURED 0 (never null: `foldAll` attributes it).
    if (c.unpricedExitQuoteDropped !== 0) {
      console.error(`SELF-TEST FAILED: unpricedExitQuoteDropped must be a measured 0 here (got ${c.unpricedExitQuoteDropped})`);
      process.exit(1);
    }
  }
  // 7. TRA-2600 — A DEAD VENUE MUST NOT READ LIKE A LEGACY DRAIN.
  //    `quote_null_at_snap` is WRITER-UNREACHABLE: mapLeg takes requestedPx/bid/ask off ONE
  //    DecisionQuote and buildDecisionQuote nulls the mid unless both sides are > 0, so a dead
  //    snap is DROPPED as `unpriced_exit_quote` before it can be classified. That made the two
  //    diagnoses render BYTE-IDENTICAL reason strings. This arm is the failing direction: it
  //    asserts the strings DIFFER, which is the only assertion that actually kills the bug.
  {
    const base = parseSandboxJournal(synthQuotedCorpus([0.13], 4));
    const legacyDrain = base.map((r) => {
      const c = JSON.parse(JSON.stringify(r));
      delete c.legs[1].bid; delete c.legs[1].ask;
      return c;
    });
    // A dead snap AS THE WRITER PRODUCES IT: no mid, so no requestedPx — the keys are still
    // there. Hand-authoring `bid:null, ask:null` NEXT TO a live requestedPx would decouple
    // exactly what the writer couples, and is what let this sit latent behind a green test.
    const deadVenue = [...legacyDrain, ...base.slice(0, 3).map((r) => {
      const c = JSON.parse(JSON.stringify(r));
      c.legs[1].bid = null; c.legs[1].ask = 5; c.legs[1].requestedPx = null;
      return c;
    })];

    const fLegacy = foldAll(legacyDrain, args);
    const fDead = foldAll(deadVenue, args);

    if (fDead.summary.quoteCoverage.quote_null_at_snap !== 0) {
      console.error('SELF-TEST FAILED: quote_null_at_snap is writer-unreachable and must stay 0 — '
        + 'if this fires, a writer now decouples requestedPx from the snap and the docs are stale');
      process.exit(1);
    }
    if (fDead.summary.quoteCoverage.unpricedExitQuoteDropped !== 3) {
      console.error(`SELF-TEST FAILED: the dead-venue drops must surface in quoteCoverage (got ${fDead.summary.quoteCoverage.unpricedExitQuoteDropped})`);
      process.exit(1);
    }
    // The two corpora are indistinguishable on every observable the reason string used to
    // carry — same quotedH.n, same retained, same (zero) quote_null_at_snap…
    if (fDead.summary.quotedH.n !== fLegacy.summary.quotedH.n
      || fDead.summary.quoteCoverage.retained !== fLegacy.summary.quoteCoverage.retained) {
      console.error('SELF-TEST FAILED: the two corpora must be matched on n/retained, else the string check is not a controlled comparison');
      process.exit(1);
    }
    // …and must now be SEPARABLE in the sentence a reader acts on.
    if (fDead.quotedV.reason === fLegacy.quotedV.reason) {
      console.error('SELF-TEST FAILED: a DEAD venue and a LEGACY DRAIN produced the SAME reason string — the dead-snap state is unobservable');
      process.exit(1);
    }
    if (!/DEAD VENUE/.test(fDead.quotedV.reason) || /DEAD VENUE/.test(fLegacy.quotedV.reason)) {
      console.error(`SELF-TEST FAILED: the DEAD VENUE marker must appear on the dead corpus ONLY (dead=${fDead.quotedV.reason} | legacy=${fLegacy.quotedV.reason})`);
      process.exit(1);
    }
  }
  // 8. TRA-3459 — NOT_GRADEABLE, and the three states it must stay distinct from.
  //    The failing direction the old harness could not express at all: a population on which
  //    the comparison provably has no pass state used to render "insufficient n", which reads
  //    as "come back with more rows" and cost TRA-2242 four beats of exactly that.
  {
    // (a) THE LIVE SANDBOX SHAPE — a 2¢ book at h ≈ 0.0027, 25× below the modeled 0.134, so
    //     0.134 sits outside the ENTIRE observed support. Terminal.
    const tight = foldAll(parseSandboxJournal(synthQuotedCorpus([0.0023, 0.0027, 0.0031, 0.0053], 20, 4.31)), args);
    if (tight.quotedV.code !== 'NOT_GRADEABLE') {
      console.error(`SELF-TEST FAILED: a book whose entire support is 25× below h must be NOT_GRADEABLE (got ${tight.quotedV.code} — ${tight.quotedV.reason})`);
      process.exit(1);
    }
    if (/insufficient QUOTED-basis n/.test(tight.quotedV.reason)) {
      console.error('SELF-TEST FAILED: the terminal must NOT be dressed as an accrual wait — this is the TRA-2242 misreading');
      process.exit(1);
    }
    // The mid-invariant block must be POPULATED — the terminal's reason quotes it, and a null
    // there would render "$NaN median full spread" into the sentence a reader acts on. The
    // integer-tick counter itself is graded against the REAL live rows in the server unit
    // test; this synthetic book is deliberately OFF the cent lattice (fractional widths), so
    // asserting quantization here would assert the fixture, not the instrument.
    const ti = tight.summary.midInvariants.quoted;
    if (ti.n !== tight.summary.quotedH.n || ti.midMedianUsd == null || ti.fullSpreadUsd == null) {
      console.error(`SELF-TEST FAILED: the mid-invariant block must be populated over every quoted row (got ${JSON.stringify(ti)})`);
      process.exit(1);
    }
    if (ti.tickQuantizedRows !== 0) {
      console.error('SELF-TEST FAILED: this fixture is OFF the cent lattice by construction — a non-zero tick count means the counter is not measuring what it claims');
      process.exit(1);
    }
    // (b) GRADEABLE AND WRONG must stay a REVIEW. Support [0.10, 0.30] contains 0.134, mean
    //     0.20 is outside tol. Collapsing this into the terminal would hide a real failure.
    const wrong = foldAll(parseSandboxJournal(synthQuotedCorpus([0.10, 0.30], 40)), args);
    if (wrong.quotedV.code !== 'REVIEW' || !/mean QUOTED h 0\.2000 outside/.test(wrong.quotedV.reason)) {
      console.error(`SELF-TEST FAILED: a gradeable-but-wrong book must REVIEW on the mean, not go terminal (got ${wrong.quotedV.code} — ${wrong.quotedV.reason})`);
      process.exit(1);
    }
    // (c) UNMEASURED must not read as unfit. 8 quoted rows is under the fitness floor.
    const few = foldAll(parseSandboxJournal(synthQuotedCorpus([0.002], 8, 4.31)), args);
    if (few.quotedV.code !== 'REVIEW' || !/insufficient QUOTED-basis n/.test(few.quotedV.reason)) {
      console.error(`SELF-TEST FAILED: below the fitness floor the n-floor must speak, not the terminal (got ${few.quotedV.code})`);
      process.exit(1);
    }
    // (d) THE STATISTIC-MATCHED FIX, with its positive control. A corpus carrying the
    //     CALIBRATION population's own moments (mean 0.1351 / median 0.0667) must clear the
    //     tolerance arm — and the OLD median-vs-mean predicate must NOT. Without the control
    //     the first assertion could hold for reasons unrelated to the fix.
    const calib = foldAll(parseSandboxJournal(synthQuotedCorpus([0.0634, 0.07, 0.021, 0.386], 40, 1.32)), args);
    if (Math.abs(calib.summary.quotedH.mean - args.h) > args.tol) {
      console.error(`SELF-TEST FAILED: the statistic-matched arm must PASS on the calibration population (mean ${calib.summary.quotedH.mean})`);
      process.exit(1);
    }
    if (Math.abs(calib.summary.quotedH.median - args.h) <= args.tol) {
      console.error('SELF-TEST FAILED: the OLD median-vs-mean predicate must FAIL here — if it passes, this fixture no longer reproduces the TRA-2602 defect and proves nothing');
      process.exit(1);
    }
  }
  console.log('self-test OK (advisory: PASS on 0.13, REVIEW mid-booked, fillPx=0 excluded; '
    + 'GRADED quotedH: PASS at 0.13, REVIEW on a wide tail at the SAME mean, quote states separable; '
    + 'TRA-2600: quote_null_at_snap writer-unreachable, dead-venue drops surfaced in quoteCoverage '
    + 'and the DEAD-vs-LEGACY reason strings DIFFER; TRA-3459: NOT_GRADEABLE on a support-disjoint '
    + 'book and distinct from REVIEW-wrong / under-floor, tolerance arm clears its own calibration '
    + 'population where the old median predicate could not)');
  process.exit(0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/marketable-mtm-forward-validation.mjs [--file PATH] [--h 0.134] [--tol 0.03] [--strategy NAME] [--min-n 30] [--per-structure-min-n 10] [--no-require-per-structure-min-n] [--json] [--self-test]');
    console.log('The GRADED verdict is quotedVerdict (basis quotedH, TRA-2300); the actualH verdict is advisory and the exit code follows the graded one.');
    process.exit(0);
  }
  if (args.selfTest) { runSelfTest(args); return; }

  const file = args.file ?? defaultFile();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`cannot read sandbox journal at ${file}: ${err.message}`);
    console.error('(pass --file PATH, or --self-test to exercise the harness on a synthetic corpus)');
    process.exit(1);
  }

  const records = parseSandboxJournal(text);
  const f = foldAll(records, args);
  if (f.samples.length === 0) {
    console.error('no parity-true samples (sandbox round-trips with a priced exit leg: requestedPx>0 AND fillPx>0).');
    console.error(`exclusions: ${JSON.stringify(f.exclusions)}`);
    console.error('an empty sandbox-strategy-journal, one-sided quotes, unfilled legs, or false-$0 fills all yield 0.');
    process.exit(2);
  }
  report(f.summary, f.v, args, f);
  // TRA-2300 §1 — the exit code follows the GRADED (quotedH) verdict, not the advisory one.
  // An automation that trusted the old code would otherwise be gated on a detector with no
  // failing state on this venue.
  // TRA-3459 — NOT_GRADEABLE gets its OWN code. See the exit-code contract in the header.
  process.exit(f.quotedV.code === 'PASS' ? 0 : f.quotedV.code === 'NOT_GRADEABLE' ? 4 : 2);
}

main();
