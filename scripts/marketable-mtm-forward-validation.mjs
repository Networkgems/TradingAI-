#!/usr/bin/env node
// TRA-2233 (parent TRA-2174) — forward-validation harness for the marketable(bid)
// open-position valuation.
//
// The DARK marketable mark (see packages/server/src/marketable-open-mtm.ts) values
// an open long at `mid · (1 − h)` where `h` is a MODELED half-spread fraction
// (default 0.134). This script answers the question the flag is gated on:
//
//     does the modeled marketable mark predict the price a REAL exit actually
//     fills at?
//
// ── The ground truth ─────────────────────────────────────────────────────────
// The option trade journal's CLOSE row already carries the MEASURED cross:
//
//     exitSlippageUsd = (exitMid − fillPremium) · contracts · 100      (≥ 0 = paid)
//
// i.e. the dollars the real sell fill came in BELOW the closing mid. That is the
// realized half-spread cross — exactly what the marketable mark is trying to model
// ahead of time. The SANDBOX sleeve books REAL Tradier fills, so its rows are the
// parity-true sample (TRA-2174); demo rows with `demoSlippagePct = 0` book at the
// mid and carry `exitSlippageUsd ≈ 0`, so they are excluded (they cannot falsify a
// bid model — a detector that "can't fire" reads identically to one that passes).
//
// ── The comparison ───────────────────────────────────────────────────────────
// For each resolved row with a measured `exitSlippageUsd > 0` we recover the exit
// mid per share and compute the ACTUAL realized half-spread fraction:
//
//     fillPerShare = premiumPaid + realizedPnlUsd / (contracts · 100)
//     exitMidPerShare = fillPerShare + exitSlippageUsd / (contracts · 100)
//     actualH = (exitMidPerShare − fillPerShare) / exitMidPerShare
//             = exitSlippageUsd / (exitMidPerShare · contracts · 100)
//
// and compare it to the modeled `h` (the flag's fraction) and to the row's own
// ENTRY spread `hEntry = (entryMark − entryBid) / entryMark` when present. We
// report the distribution of the model's dollar error
// `modeledCrossUsd − exitSlippageUsd` per structure, and a PASS/REVIEW verdict:
// the modeled `h` is accepted iff the measured median realized `actualH` sits
// within `--tol` of it AND the model does not systematically UNDER-charge the
// tail (p90 modeled cross ≥ p90 actual cross), because an under-charging mark
// re-inflates realizable P&L — the very bias this ticket exists to remove.
//
// Usage:
//   node scripts/marketable-mtm-forward-validation.mjs [--file PATH] [--h 0.134]
//        [--tol 0.03] [--mode demo|live|all] [--min-n 30] [--json] [--self-test]
//
// Exit code: 0 = PASS (or self-test ok), 2 = REVIEW (insufficient n or model off),
// 1 = usage / IO error. Read-only: never writes the journal.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_H = 0.134; // packages/server/src/marketable-open-mtm.ts DEFAULT_MARKETABLE_HALF_SPREAD_FRAC

function parseArgs(argv) {
  const a = { file: null, h: DEFAULT_H, tol: 0.03, mode: 'all', minN: 30, json: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--file') a.file = argv[++i];
    else if (t === '--h') a.h = Number(argv[++i]);
    else if (t === '--tol') a.tol = Number(argv[++i]);
    else if (t === '--mode') a.mode = argv[++i];
    else if (t === '--min-n') a.minN = Number(argv[++i]);
    else if (t === '--json') a.json = true;
    else if (t === '--self-test') a.selfTest = true;
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

function defaultFile() {
  const root = process.env.DATA_DIR ?? join(process.cwd(), 'packages', 'server', 'data');
  return join(root, 'option-trade-journal.jsonl');
}

// Fold append-only OPEN/CLOSE/amend lines into merged records keyed by id.
function foldJournal(text) {
  const byId = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.kind === 'open' && obj.rec?.id) {
      byId.set(obj.rec.id, { ...obj.rec, outcome: 'OPEN' });
    } else if (obj.kind === 'close' && obj.id) {
      const rec = byId.get(obj.id);
      if (rec) Object.assign(rec, obj.close, { outcome: obj.close.outcome });
    } else if (obj.kind === 'amend_entry_slippage' && obj.id) {
      const rec = byId.get(obj.id);
      if (rec) rec.entrySlippageUsd = obj.entrySlippageUsd;
    }
  }
  return [...byId.values()];
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

// Turn one merged record into a validation sample, or null if it can't falsify a
// bid model (open, no measured cross, degenerate contracts/mark).
function toSample(rec, mode) {
  if (rec.outcome === 'OPEN') return null;
  if (mode !== 'all' && (rec.mode ?? 'demo') !== mode) return null;
  const contracts = Number(rec.contracts);
  const premiumPaid = Number(rec.premiumPaid ?? rec.entryMarkUsd);
  const realizedPnlUsd = Number(rec.realizedPnlUsd);
  const exitSlippageUsd = Number(rec.exitSlippageUsd);
  if (!Number.isFinite(contracts) || contracts <= 0) return null;
  if (!Number.isFinite(premiumPaid) || premiumPaid <= 0) return null;
  if (!Number.isFinite(realizedPnlUsd)) return null;
  // Only a MEASURED, non-zero cross can validate a bid model. A mid-booked demo
  // fill (exitSlippageUsd ≈ 0) is excluded — it would pass any h vacuously.
  if (!Number.isFinite(exitSlippageUsd) || exitSlippageUsd <= 0) return null;

  const per = contracts * 100;
  const fillPerShare = premiumPaid + realizedPnlUsd / per;
  const exitMidPerShare = fillPerShare + exitSlippageUsd / per;
  if (!(exitMidPerShare > 0)) return null;
  const actualH = exitSlippageUsd / (exitMidPerShare * per);
  const hEntry =
    Number.isFinite(rec.entryMarkUsd) && Number.isFinite(rec.entryBid) && rec.entryMarkUsd > 0
      ? (rec.entryMarkUsd - rec.entryBid) / rec.entryMarkUsd
      : null;
  return {
    structure: rec.structure ?? 'unknown',
    mode: rec.mode ?? 'demo',
    contracts,
    exitMidPerShare,
    exitSlippageUsd,        // actual realized cross, $
    actualH,                // actual realized half-spread fraction
    hEntry,                 // this row's entry-measured half-spread (reference)
  };
}

function summarize(samples, h) {
  const actualHs = samples.map((s) => s.actualH).sort((a, b) => a - b);
  const actualCross = samples.map((s) => s.exitSlippageUsd).sort((a, b) => a - b);
  // Modeled cross under the flag's h, using the SAME exit mid the actual cross was
  // measured against, so the two are dollar-comparable per row.
  const modeledCross = samples.map((s) => h * s.exitMidPerShare * s.contracts * 100).sort((a, b) => a - b);
  const errUsd = samples.map((s) => h * s.exitMidPerShare * s.contracts * 100 - s.exitSlippageUsd);
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
    return { code: 'REVIEW', reason: `insufficient n (${summary.n} < ${minN}); accrue more parity-true fills` };
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

function synthCorpus() {
  // 40 rows whose real cross ≈ 13% of the exit mid — a corpus the default h=0.134
  // should PASS. Deterministic (no RNG): a fixed spread of premiums.
  const lines = [];
  for (let i = 0; i < 40; i++) {
    const id = `synth-${i}`;
    const premiumPaid = 1.0 + (i % 5) * 0.1;
    const contracts = 3 + (i % 3);
    const exitMid = premiumPaid * (1.1 + (i % 4) * 0.05); // a gain
    const h = 0.13; // real realized half-spread ~13%
    const per = contracts * 100;
    const fill = exitMid * (1 - h);
    const realizedPnlUsd = (fill - premiumPaid) * per;
    const exitSlippageUsd = (exitMid - fill) * per;
    lines.push(JSON.stringify({ kind: 'open', rec: { id, structure: 'single_leg_rv', mode: 'demo', contracts, premiumPaid, entryMarkUsd: premiumPaid, entryBid: premiumPaid * 0.935, entryAsk: premiumPaid * 1.065, openTs: 1, symbol: 'AAPL' } }));
    lines.push(JSON.stringify({ kind: 'close', id, close: { closeTs: 2, outcome: 'WIN', realizedPnlUsd, realizedR: 1, exitReason: 'tp1', holdDays: 1, exitSlippageUsd } }));
  }
  return lines.join('\n');
}

function report(summary, v, args) {
  if (args.json) {
    console.log(JSON.stringify({ ...summary, verdict: v, tol: args.tol, minN: args.minN }, null, 2));
    return;
  }
  console.log('TRA-2233 marketable(bid) forward-validation');
  console.log('─'.repeat(60));
  console.log(`samples (parity-true, measured cross):  ${summary.n}`);
  console.log(`modeled half-spread h:                  ${summary.modeledH}`);
  console.log(`realized h  mean/median/p90:            ${summary.actualH.mean.toFixed(4)} / ${summary.actualH.median.toFixed(4)} / ${summary.actualH.p90.toFixed(4)}`);
  console.log(`actual  cross $  mean/median/p90:        ${summary.actualCrossUsd.mean.toFixed(2)} / ${summary.actualCrossUsd.median.toFixed(2)} / ${summary.actualCrossUsd.p90.toFixed(2)}`);
  console.log(`modeled cross $  mean/median/p90:        ${summary.modeledCrossUsd.mean.toFixed(2)} / ${summary.modeledCrossUsd.median.toFixed(2)} / ${summary.modeledCrossUsd.p90.toFixed(2)}`);
  console.log(`model error $ (modeled−actual) mean:     ${summary.modelErrorUsd.mean.toFixed(2)}`);
  if (summary.entryH.n) console.log(`entry-spread h (reference, n=${summary.entryH.n}):    ${summary.entryH.mean.toFixed(4)}`);
  console.log('─'.repeat(60));
  console.log(`VERDICT: ${v.code} — ${v.reason}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/marketable-mtm-forward-validation.mjs [--file PATH] [--h 0.134] [--tol 0.03] [--mode demo|live|all] [--min-n 30] [--json] [--self-test]');
    process.exit(0);
  }
  let text;
  if (args.selfTest) {
    text = synthCorpus();
  } else {
    const file = args.file ?? defaultFile();
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`cannot read journal at ${file}: ${err.message}`);
      console.error('(pass --file PATH, or --self-test to exercise the harness on a synthetic corpus)');
      process.exit(1);
    }
  }

  const records = foldJournal(text);
  const samples = records.map((r) => toSample(r, args.mode)).filter(Boolean);
  if (samples.length === 0) {
    console.error('no parity-true samples (resolved rows with a measured exitSlippageUsd > 0).');
    console.error('demo rows booked at the mid carry exitSlippageUsd ≈ 0 and cannot falsify a bid model.');
    process.exit(2);
  }
  const summary = summarize(samples, args.h);
  const v = verdict(summary, args.tol, args.minN);
  report(summary, v, args);

  if (args.selfTest) {
    // The synthetic corpus is built to PASS at h=0.134; assert the harness agrees.
    if (v.code !== 'PASS') { console.error('SELF-TEST FAILED: expected PASS on the synthetic corpus'); process.exit(1); }
    console.log('self-test OK');
    process.exit(0);
  }
  process.exit(v.code === 'PASS' ? 0 : 2);
}

main();
