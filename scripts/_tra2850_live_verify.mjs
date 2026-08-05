// TRA-2850 — one-shot live verification of the gainloss-derived fee back-fill.
// Reads only. Pins build identity FIRST (a wrong-box read looks healthy — see
// the TRADING_API_BASE trap), then grades the reconcile provenance and the
// repaired feesMeasured semantics on the live payload.
//
// PASS bar (pre-registered before the read):
//   1. build SHA is d6a1a5f (this fix) — else BLIND, not a verdict
//   2. no record reads fees:0 without a feeSource (the poison shape is gone)
//   3. feesMeasured === feesBySource.historyCommission + feesBySource.gainlossDerived
//   4. autoReconcile exposes stalled/consecutiveNoMatch (the non-green state exists)
//   5. if the boot kick already ran (ticks >= 1) AND any settled lots were
//      fetched: gainlossDerived > 0 with per-leg fees in (0, 0.90]/contract
// Exit 0 PASS · 2 FAIL (bar broken) · 3 BLIND (wrong build / route unreadable)

const BASE = 'https://tradingai-bqb1.onrender.com';
const EXPECT_SHA = 'd6a1a5f';

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 2; };

let payload;
try {
  payload = await getJson('/api/health/live-options-fee-slippage');
} catch (err) {
  console.error(`BLIND: ${err.message}`);
  process.exit(3);
}

// 1 — build identity pin
const sha = String(payload?.build?.commit ?? payload?.build?.sha ?? payload?.build?.version ?? '');
console.log('build:', JSON.stringify(payload.build));
if (!sha.startsWith(EXPECT_SHA)) {
  console.error(`BLIND: live build ${sha || '(absent)'} is not ${EXPECT_SHA} — not grading a different build`);
  process.exit(3);
}

const records = payload.records ?? [];
const bySource = payload.feesBySource;
const ar = payload.autoReconcile ?? {};
console.log(`n=${payload.n} feesMeasured=${payload.feesMeasured} feesBySource=${JSON.stringify(bySource)}`);
console.log(`autoReconcile: ticks=${ar.ticks} attempts=${ar.attempts} lastOutcome=${ar.lastOutcome} ` +
  `lastGainLossLots=${ar.lastGainLossLots} lastGainLossUpdated=${ar.lastGainLossUpdated} ` +
  `totalUpdated=${ar.totalUpdated} consecutiveNoMatch=${ar.consecutiveNoMatch} stalled=${ar.stalled} lastError=${ar.lastError}`);

// 2 — the poison shape is gone
const poisoned = records.filter((r) => r.fees === 0 && !r.feeSource);
if (poisoned.length > 0) fail(`${poisoned.length} record(s) still read fees:0 with no feeSource`);

// 3 — feesMeasured is exactly the sourced count
if (!bySource) fail('feesBySource absent from payload');
else if (payload.feesMeasured !== bySource.historyCommission + bySource.gainlossDerived) {
  fail(`feesMeasured ${payload.feesMeasured} != sourced sum ${bySource.historyCommission + bySource.gainlossDerived}`);
}

// 4 — the non-green state exists on the wire
if (typeof ar.stalled !== 'boolean' || typeof ar.consecutiveNoMatch !== 'number') {
  fail('autoReconcile.stalled / consecutiveNoMatch missing — the non-green state is not expressible');
}

// 5 — if the pass ran and lots settled, real fees must have landed
const measured = records.filter((r) => r.fees !== null);
for (const r of measured) {
  const perContract = r.contracts > 0 ? r.fees / r.contracts : NaN;
  console.log(`  measured: ${r.optionSymbol} ${r.side} x${r.contracts} fees=${r.fees} (${perContract.toFixed(4)}/ct) src=${r.feeSource}`);
  if (r.feeSource === 'gainloss_derived' && !(perContract >= 0 && perContract <= 0.9)) {
    fail(`gainloss-derived fee out of sanity bound: ${r.optionSymbol} ${perContract}/contract`);
  }
}
if ((ar.ticks ?? 0) >= 1 && (ar.lastGainLossLots ?? 0) > 0 && (bySource?.gainlossDerived ?? 0) === 0) {
  console.log('NOTE: boot kick ran with settled lots fetched but derived 0 — check window/join before calling PASS on leg 5');
  fail('gainloss pass fetched lots but measured nothing');
}
if ((ar.ticks ?? 0) === 0) {
  console.log('NOTE: boot kick has not fired yet (runs ~90s after boot) — legs 1-4 graded, leg 5 pending');
}

console.log(process.exitCode === 2 ? 'VERDICT: FAIL' : 'VERDICT: PASS');
