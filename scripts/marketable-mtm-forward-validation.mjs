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
// Exit code: 0 = PASS (or self-test ok), 2 = REVIEW (insufficient n or model off),
// 1 = usage / IO error. Read-only: never writes any journal.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_H = 0.134; // packages/server/src/marketable-open-mtm.ts DEFAULT_MARKETABLE_HALF_SPREAD_FRAC
const CONTRACT_MULTIPLIER = 100;
// marketable-open-mtm.ts MAX_MARKETABLE_HALF_SPREAD_FRAC — also the |actualH| outlier threshold.
const MAX_HALF_SPREAD_FRAC = 0.5;

function parseArgs(argv) {
  const a = { file: null, h: DEFAULT_H, tol: 0.03, strategy: null, minN: 30, json: false, selfTest: false, requirePerStructureMinN: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--file') a.file = argv[++i];
    else if (t === '--h') a.h = Number(argv[++i]);
    else if (t === '--tol') a.tol = Number(argv[++i]);
    else if (t === '--strategy') a.strategy = argv[++i];
    else if (t === '--min-n') a.minN = Number(argv[++i]);
    else if (t === '--require-per-structure-min-n') a.requirePerStructureMinN = true;
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
    mode: 'sandbox',
    contracts,
    exitMidPerShare,
    exitSlippageUsd,        // realized exit cross, $ (signed)
    actualH,                // realized exit half-spread fraction (signed)
    hEntry,                 // realized entry-leg half-spread (reference)
    quotedH,                // QUOTED-book half-spread on the exit side (TRA-2283 D2)
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
  const quoted = samples.map((s) => s.quotedH).filter((q) => q != null).sort((a, b) => a - b);
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
    },
  };
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

function verdict(summary, tol, minN) {
  if (summary.n < minN) {
    return { code: 'REVIEW', reason: `insufficient n (${summary.n} < ${minN}); accrue more parity-true sandbox round-trips` };
  }
  const withinTol = Math.abs(summary.actualH.median - summary.modeledH) <= tol;
  // The tail must not be UNDER-charged: a modeled mark that haircuts LESS than the
  // real fill re-inflates realizable P&L — the bias this ticket removes.
  const tailNotUnderCharged = !isTailUnderCharged(summary);
  if (withinTol && tailNotUnderCharged) {
    return { code: 'PASS', reason: `median realized h ${summary.actualH.median.toFixed(4)} within ±${tol} of modeled ${summary.modeledH}; tail covered` };
  }
  const bits = [];
  // TRA-2283 D2 — this is a DESCRIPTION of where the measured median sits, NOT an
  // instruction. On a SANDBOX_SIMULATED venue that fills at the decision mid, actualH is ~0
  // by construction, so "retune h" off it would collapse the haircut to mid-marking.
  if (!withinTol) bits.push(`median realized h ${summary.actualH.median.toFixed(4)} outside ±${tol} of modeled ${summary.modeledH} (measured median ≈ ${summary.actualH.median.toFixed(3)} — do NOT retune --h off a SANDBOX_SIMULATED fill; grade on quotedH)`);
  if (!tailNotUnderCharged) bits.push(`modeled p90 cross $${summary.modeledCrossUsd.p90.toFixed(2)} < actual p90 $${summary.actualCrossUsd.p90.toFixed(2)} (under-charges the tail)`);
  return { code: 'REVIEW', reason: bits.join('; ') };
}

/** TRA-2283 D3 — per-structure fold; the pooled verdict may not absolve a structure whose
 *  own tail is under-charged (pooled read "covered" at $61.14 ≥ $4.00 while long_call was
 *  under-charged 2.8× — signs that flip with structure direction cancel in the pool). */
function perStructureBreakdown(samples, h, tol, minN) {
  const by = new Map();
  for (const s of samples) {
    const list = by.get(s.structure) ?? [];
    list.push(s);
    by.set(s.structure, list);
  }
  return [...by.entries()]
    .map(([structure, list]) => {
      const sub = summarize(list, h);
      return {
        structure,
        ...sub,
        tailUnderCharged: isTailUnderCharged(sub),
        tailUnderChargeRatio: underChargeRatio(sub),
        verdict: verdict(sub, tol, minN),
      };
    })
    .sort((a, b) => b.n - a.n || a.structure.localeCompare(b.structure));
}

function pooledVerdict(summary, structures, tol, minN, requirePerStructureMinN) {
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
  const below = structures.filter((s) => s.n < minN).map((s) => `${s.structure} (n=${s.n})`);
  if (requirePerStructureMinN && below.length > 0) {
    bits.push(`insufficient per-structure n (< ${minN}): ${below.join(', ')}`);
  }
  if (bits.length === 0) return base;
  return { code: 'REVIEW', reason: `${base.code === 'REVIEW' ? `${base.reason}; ` : ''}${bits.join('; ')}` };
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

function report(summary, v, args, extra = {}) {
  const { perStructure = [], exclusions = null } = extra;
  if (args.json) {
    console.log(JSON.stringify({
      ...summary,
      verdict: v,
      tol: args.tol,
      minN: args.minN,
      fillRealism: 'SANDBOX_SIMULATED',
      excludedZeroFill: exclusions?.zero_fill_exit ?? 0,
      exclusions,
      perStructure,
      structuresBelowMinN: perStructure.filter((s) => s.n < args.minN).map((s) => s.structure),
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
      console.log(`  ${s.structure.padEnd(14)} n=${String(s.n).padStart(3)}  h med ${s.actualH.median.toFixed(4)}  actual p90 $${s.actualCrossUsd.p90.toFixed(2)}  modeled p90 $${s.modeledCrossUsd.p90.toFixed(2)}  ${s.verdict.code}${flag}`);
    }
  }
  console.log('─'.repeat(60));
  console.log(`VERDICT (pooled): ${v.code} — ${v.reason}`);
}

/** Fold a parsed record list exactly as `main` does — samples + exclusion tally + unpooled verdict. */
function foldAll(records, args) {
  const exclusions = {
    too_few_legs: 0, strategy_filter: 0, unpriced_exit_quote: 0,
    unfilled_exit: 0, zero_fill_exit: 0, bad_exit_side: 0,
  };
  const samples = records.map((r) => toSample(r, args.strategy, exclusions)).filter(Boolean);
  const summary = summarize(samples, args.h);
  const perStructure = perStructureBreakdown(samples, args.h, args.tol, args.minN);
  const v = pooledVerdict(summary, perStructure, args.tol, args.minN, args.requirePerStructureMinN);
  return { samples, summary, perStructure, exclusions, v };
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
  console.log('self-test OK (PASS on 0.13 corpus; quotedH recovers 0.13; REVIEW on mid-booked corpus; fillPx=0 excluded)');
  process.exit(0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/marketable-mtm-forward-validation.mjs [--file PATH] [--h 0.134] [--tol 0.03] [--strategy NAME] [--min-n 30] [--require-per-structure-min-n] [--json] [--self-test]');
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
  process.exit(f.v.code === 'PASS' ? 0 : 2);
}

main();
