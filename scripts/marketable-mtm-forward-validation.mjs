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

function parseArgs(argv) {
  const a = { file: null, h: DEFAULT_H, tol: 0.03, strategy: null, minN: 30, json: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--file') a.file = argv[++i];
    else if (t === '--h') a.h = Number(argv[++i]);
    else if (t === '--tol') a.tol = Number(argv[++i]);
    else if (t === '--strategy') a.strategy = argv[++i];
    else if (t === '--min-n') a.minN = Number(argv[++i]);
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

// Turn one sandbox round-trip into a validation sample, or null when it can't
// falsify a bid model (no exit leg, one-sided quote, or the exit never filled).
// The realized cross is kept SIGNED — a fill at/through the mid is real evidence,
// not something to filter out (that would bias the measured half-spread upward).
function toSample(rec, strategyFilter) {
  if (!Array.isArray(rec.legs) || rec.legs.length < 2) return null; // need entry + exit
  if (strategyFilter && rec.strategy !== strategyFilter) return null;
  const entry = rec.legs[0];
  const exit = rec.legs[rec.legs.length - 1]; // recordFromContractResult: legs = [entry, exit]

  // Reject null BEFORE Number(): `Number(null) === 0` is finite, so a one-sided quote
  // (`requestedPx: null`) or an unfilled leg (`fillPx: null`) would slip through as a bogus
  // $0 price and manufacture a ~100% cross. A missing price is EXCLUDED, never folded.
  if (exit.requestedPx == null || exit.fillPx == null) return null;
  const reqExit = Number(exit.requestedPx);
  const fillExit = Number(exit.fillPx);
  if (!Number.isFinite(reqExit) || reqExit <= 0) return null; // one-sided decision quote — unprovable
  if (!Number.isFinite(fillExit)) return null;                // exit never filled — unprovable
  if (exit.side !== 'buy' && exit.side !== 'sell') return null;

  const contracts = 1; // TRA-2134 single-contract; actualH is a fraction and qty-invariant
  const per = contracts * CONTRACT_MULTIPLIER;
  const exitMidPerShare = reqExit;
  const signed = signedCross(exit.side, reqExit, fillExit);
  const actualH = signed / reqExit;              // realized EXIT half-spread fraction (SIGNED)
  const exitSlippageUsd = signed * per;          // realized EXIT cross, $ (SIGNED)

  // Realized ENTRY-leg half-spread, as a reference, when the entry leg is priced.
  let hEntry = null;
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
    mode: 'sandbox',
    contracts,
    exitMidPerShare,
    exitSlippageUsd,        // realized exit cross, $ (signed)
    actualH,                // realized exit half-spread fraction (signed)
    hEntry,                 // realized entry-leg half-spread (reference)
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
  };
}

function verdict(summary, tol, minN) {
  if (summary.n < minN) {
    return { code: 'REVIEW', reason: `insufficient n (${summary.n} < ${minN}); accrue more parity-true sandbox round-trips` };
  }
  const withinTol = Math.abs(summary.actualH.median - summary.modeledH) <= tol;
  // The tail must not be UNDER-charged: a modeled mark that haircuts LESS than the
  // real fill re-inflates realizable P&L — the bias this ticket removes.
  const tailNotUnderCharged = summary.modeledCrossUsd.p90 >= summary.actualCrossUsd.p90;
  if (withinTol && tailNotUnderCharged) {
    return { code: 'PASS', reason: `median realized h ${summary.actualH.median.toFixed(4)} within ±${tol} of modeled ${summary.modeledH}; tail covered` };
  }
  const bits = [];
  if (!withinTol) bits.push(`median realized h ${summary.actualH.median.toFixed(4)} outside ±${tol} of modeled ${summary.modeledH} (retune --h ≈ ${summary.actualH.median.toFixed(3)})`);
  if (!tailNotUnderCharged) bits.push(`modeled p90 cross $${summary.modeledCrossUsd.p90.toFixed(2)} < actual p90 $${summary.actualCrossUsd.p90.toFixed(2)} (under-charges the tail)`);
  return { code: 'REVIEW', reason: bits.join('; ') };
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
    const rec = {
      ts: 1_700_000_000_000 + i,
      etDay: '2026-07-24',
      strategy,
      underlying: 'AAPL',
      ok: true,
      realizedRoundTripUsd: (exitFill - entryFill) * CONTRACT_MULTIPLIER,
      legs: [
        { side: entrySide, optionSymbol: 'AAPL', submitTs: 1, fillTs: 2, signalToSubmitMs: 40, requestedPx: entryMid, fillPx: entryFill, slippageBps: null, spreadAtSubmitPct: null, withinSpread: null },
        { side: exitSide, optionSymbol: 'AAPL', submitTs: 3, fillTs: 4, signalToSubmitMs: 40, requestedPx: exitMid, fillPx: exitFill, slippageBps: null, spreadAtSubmitPct: null, withinSpread: null },
      ],
    };
    lines.push(JSON.stringify(rec));
  }
  return lines.join('\n');
}

function report(summary, v, args) {
  if (args.json) {
    console.log(JSON.stringify({ ...summary, verdict: v, tol: args.tol, minN: args.minN, fillRealism: 'SANDBOX_SIMULATED' }, null, 2));
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
  console.log('fill realism:                           SANDBOX_SIMULATED (may understate live spread)');
  console.log('─'.repeat(60));
  console.log(`VERDICT: ${v.code} — ${v.reason}`);
}

function runSelfTest(args) {
  // 1. A corpus whose exit-leg realized half-spread ≈ 0.13 must PASS at the default h.
  {
    const summary = summarize(parseSandboxJournal(synthSandboxCorpus(0.13)).map((r) => toSample(r, null)).filter(Boolean), args.h);
    const v = verdict(summary, args.tol, args.minN);
    report(summary, v, args);
    if (v.code !== 'PASS') { console.error('SELF-TEST FAILED: expected PASS on the 0.13 synthetic corpus'); process.exit(1); }
  }
  // 2. Prove the harness can FALSIFY: a mid-booked corpus (fill = mid ⇒ actualH ≈ 0)
  //    must NOT pass — otherwise a detector that can't fire reads like one that passes.
  {
    const samples = parseSandboxJournal(synthSandboxCorpus(0.0)).map((r) => toSample(r, null)).filter(Boolean);
    const v = verdict(summarize(samples, args.h), args.tol, args.minN);
    if (v.code === 'PASS') { console.error('SELF-TEST FAILED: mid-booked corpus (actualH≈0) must NOT PASS at h=0.134'); process.exit(1); }
  }
  console.log('self-test OK (PASS on 0.13 corpus; REVIEW on mid-booked corpus)');
  process.exit(0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/marketable-mtm-forward-validation.mjs [--file PATH] [--h 0.134] [--tol 0.03] [--strategy NAME] [--min-n 30] [--json] [--self-test]');
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
  const samples = records.map((r) => toSample(r, args.strategy)).filter(Boolean);
  if (samples.length === 0) {
    console.error('no parity-true samples (sandbox round-trips with a priced exit leg: requestedPx>0 AND fillPx).');
    console.error('an empty sandbox-strategy-journal, or exit legs with one-sided quotes / unfilled legs, yields 0.');
    process.exit(2);
  }
  const summary = summarize(samples, args.h);
  const v = verdict(summary, args.tol, args.minN);
  report(summary, v, args);
  process.exit(v.code === 'PASS' ? 0 : 2);
}

main();
