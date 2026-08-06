#!/usr/bin/env node
// TRA-3010 — gate A of TRA-2873: assert the TRA-2889 cost-basis restatement on
// the first ENGINE-OPENED live option row.
//
// READ-ONLY. GET only. It never calls `POST /api/tradier/positions/sync` — that
// mutates the book under test — and never writes env or settings.
//
// Exit codes:
//   0  PASS   — at least one restatement witnessed and every assertion held
//   1  FAIL   — a restatement was witnessed and an assertion broke
//   2  BLIND  — nothing to measure (no engine row has been restated yet). This
//               is the expected state until the next live OTM entry fires, and
//               it is deliberately NOT 0: an empty ledger is not a pass.
//   3  BLIND  — could not read (host, login, route, or drift)
//
// Why the census route and not a plain read of `/api/state`:
// the restatement overwrites `premiumPaid` in place, the live portfolio
// reconcile runs every 30s, and the risk thresholds are RESCALED (so
// `stop / premiumPaid` reads the same constant before and after). A row read
// after the fact is therefore byte-identical whether the restatement fired or
// was never wired. `GET /api/options/basis-restatements` publishes the
// before/after pair captured at the restatement itself, plus the denominator.

const HOST = 'https://tradingai-bqb1.onrender.com';
const CENTS = 2;
const RATIO_DP = 10;

const fail = (msg) => { console.error(`BLIND — ${msg}`); process.exit(3); };

const user = process.env.TRADING_ADMIN_USERNAME;
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!user || !pass) fail('admin creds unset');

const ver = await fetch(`${HOST}/api/health/version`).then(r => (r.ok ? r.json() : null)).catch(() => null);
if (!ver) fail('/api/health/version unreachable');
console.log(`# READ AT     ${new Date().toISOString()}`);
console.log(`# live commit ${ver.commit}`);
console.log(`# startedAt   ${ver.startedAt}  uptimeSec ${ver.uptimeSec}`);
console.log(`# nodeVersion ${ver.nodeVersion ?? '(absent)'}`);
console.log('# NOTE: the `sinceBoot` counters reset on restart (see uptimeSec above).');
console.log('#       Grading reads the `durable` tape, which survives reboots.');

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) fail(`login ${login.status}`);
const auth = { Authorization: `Bearer ${lb.token}` };

const res = await fetch(`${HOST}/api/options/basis-restatements?env=production`, { headers: auth });
if (res.status === 404) fail('census route absent — the TRA-3010 instrument is not deployed on this box');
if (!res.ok) fail(`/api/options/basis-restatements ${res.status}`);
const census = await res.json();

const boot = census.sinceBoot ?? {};
const durable = census.durable ?? {};
const sweeps = census.sweeps ?? null;

console.log(`\n# env                 ${census.env}`);
if (!sweeps) {
  fail(
    'census payload carries no `sweeps` witness — this host predates the '
    + 'enabling-precondition fix, so `candidates: 0` cannot be told apart from an unread instrument',
  );
}
console.log(`# --- sweep witness (${sweeps.window}) — the ENABLING PRECONDITION ---`);
console.log(`# reached             ${sweeps.reached}   <- sweeps that got as far as the census branch`);
console.log(`# lastReachedAt       ${sweeps.lastReachedAt ?? '(never)'}   lastOutcome ${sweeps.lastOutcome ?? '(none)'}`);
console.log(`# skipped             ${JSON.stringify(sweeps.skipped)}`);
console.log(`# --- since boot (${boot.window ?? 'unknown window'}) ---`);
console.log(`# candidates          ${boot.candidates}   <- DENOMINATOR: engine rows the branch reached`);
console.log(`# restated            ${boot.restated}`);
console.log(`# skips               ${JSON.stringify(boot.skips)}`);
console.log('# --- durable (survives restart) ---');
console.log(`# dataDir             ${durable.dataDir}   logPresent ${durable.logPresent}`);
console.log(`# records             ${durable.count}`);
console.log(`# malformedLines      ${durable.malformedLines}   appendErrors ${durable.appendErrors}`);

if (durable.appendErrors > 0) {
  fail(`${durable.appendErrors} append(s) failed (${durable.lastAppendError}) — the ledger is not write-through, so its emptiness proves nothing`);
}
if (!durable.dataDir) {
  fail('DATA_DIR unset on the host — nothing is being persisted');
}

// The trap this gate exists to name: a restatement that matched NO rows and one
// that matched and agreed publish the same empty ledger. Separate them.
// Corroborate the zero against the book itself. GET only — never
// `POST /api/tradier/positions/sync`, which mutates the book under test.
let cohort = null;
const stateRes = await fetch(`${HOST}/api/state`, { headers: auth });
if (stateRes.ok) {
  const state = await stateRes.json().catch(() => null);
  const rows = state?.openOptions ?? state?.options?.openOptions ?? [];
  const live = rows.filter(r => (r.mode ?? 'demo') === 'live');
  cohort = live.filter(r => !r.importedFromTradier);
  console.log(`# --- book cross-check (GET /api/state) ---`);
  console.log(`# open live rows      ${live.length}   of which engine-opened (!importedFromTradier) ${cohort.length}`);
} else {
  console.log(`# book cross-check unavailable (/api/state ${stateRes.status}) — the zero below is uncorroborated`);
}

const records = durable.restatements ?? [];
if (records.length === 0) {
  // A zero here has two utterly different causes and they must not share an
  // exit code: either the sweep ran and found no engine row (BLIND, 2), or the
  // sweep never reached the census at all (UNREAD, 3).
  if (boot.candidates === 0 && sweeps.reached === 0) {
    const s = sweeps.skipped ?? {};
    if (s.mode > 0 || s.no_client > 0) {
      fail(
        `the live reconcile is DARK — skipped mode=${s.mode} no_client=${s.no_client}. `
        + 'The census branch was never reachable, so its zero says nothing about the restatement.',
      );
    }
    if (s.fetch_failed > 0) {
      fail(
        `Tradier /positions failed ${s.fetch_failed} time(s) and the census was never reached. `
        + 'A broker outage publishes the same zero as "no engine row arrived" — this is unread, not clean.',
      );
    }
    if (s.empty > 0) {
      console.log('\nBLIND — the live account was idle for the whole observed window');
      console.log(`        (${s.empty} sweep(s) skipped as \`empty\`: no open live rows, no in-flight`);
      console.log('        exits or closes), so the network read was never made and the');
      console.log('        restatement branch could not run. Nothing to measure. NOT a pass.');
      process.exit(2);
    }
    fail(
      `the census was never reached and no skip reason was recorded (${JSON.stringify(s)}) — `
      + 'the witness itself is not wired; treat as unread',
    );
  }
  console.log('\nBLIND — no engine-opened live row has been restated.');
  if (boot.candidates === 0) {
    console.log(`        The sweep DID reach the census branch ${sweeps.reached} time(s)`);
    console.log(`        (last ${sweeps.lastReachedAt}), so the instrument is armed and readable —`);
    console.log('        there is simply no engine-opened live row in the book. Pass and fail');
    console.log('        states are byte-identical here. NOT a pass.');
    if (cohort !== null && cohort.length > 0) {
      console.log('');
      console.log(`        ⚠ BUT the book holds ${cohort.length} open engine-opened live row(s)`);
      console.log(`          (${cohort.map(r => r.optionSymbol ?? r.symbol).join(', ')}) that the sweep`);
      console.log('          never matched. That means Tradier /positions is not reporting them');
      console.log('          — expected only transiently (a just-opened row, or one the');
      console.log('          broker-flat sweep is about to close). If it persists across');
      console.log('          reads, the pairing is broken, not idle. Investigate before the');
      console.log('          next grading read; do NOT read this zero as coverage.');
    }
  } else if (boot.skips?.zero_delta > 0) {
    console.log(`        ${boot.skips.zero_delta} row(s) skipped as zero_delta: our mid already`);
    console.log('        equalled broker truth, so the corrected code executed nothing.');
    console.log("        Such a row CANNOT serve as gate A's sample.");
  } else {
    console.log(`        Candidates were reached but all skipped: ${JSON.stringify(boot.skips)}`);
  }
  process.exit(2);
}
census.restatements = records;

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const round = (v, dp) => Number(v.toFixed(dp));

for (const [i, r] of census.restatements.entries()) {
  console.log(`\n--- RESTATEMENT ${i} — ${r.optionSymbol} (${new Date(r.ts).toISOString()}) ---`);
  console.log(`  premiumPaid  ${r.premiumPaidBefore}  ->  ${r.premiumPaidAfter}   (ratio ${r.ratio})`);
  console.log(`  contracts    ${r.contracts}   brokerCostBasis $${r.brokerCostBasisUsd.toFixed(2)}`);

  // 2 — basis lands on broker truth to the cent, and MOVED off the scanner mark.
  const impliedBasis = r.premiumPaidAfter * r.contracts * 100;
  check(
    round(impliedBasis, CENTS) === round(r.brokerCostBasisUsd, CENTS),
    'basis equals broker cost_basis to the cent',
    `$${impliedBasis.toFixed(2)} vs $${r.brokerCostBasisUsd.toFixed(2)}`,
  );
  check(
    round(r.premiumPaidBefore, 6) !== round(r.premiumPaidAfter, 6),
    'basis actually moved off the scanner mark',
    `${r.premiumPaidBefore} -> ${r.premiumPaidAfter}`,
  );

  // 3 — thresholds rescaled, not recomputed: ratios invariant to 10 dp.
  for (const [label, before, after] of [
    ['stopLossPremium / premiumPaid', r.stopRatioBefore, r.stopRatioAfter],
    ['tp1Premium / premiumPaid', r.tp1RatioBefore, r.tp1RatioAfter],
  ]) {
    // A sentinel (0 / Infinity) is legitimate on an unmanaged row and survives
    // the rescale unchanged; NaN on only one side is a real break.
    const bothFinite = Number.isFinite(before) && Number.isFinite(after);
    const ok = bothFinite
      ? round(before, RATIO_DP) === round(after, RATIO_DP)
      : Object.is(before, after);
    check(ok, `${label} unchanged to ${RATIO_DP} dp`, `${before} vs ${after}`);
  }

  // The levels themselves must have moved — equal ratios alone cannot tell a
  // carried schedule from an untouched one.
  check(
    round(r.stopLossPremiumBefore, 8) !== round(r.stopLossPremiumAfter, 8)
      || r.stopLossPremiumBefore === 0,
    'stop level moved with the basis (or is a 0 sentinel)',
    `${r.stopLossPremiumBefore} -> ${r.stopLossPremiumAfter}`,
  );
  if (r.trailingActive) {
    check(
      round(r.trailingStopPremiumBefore, 8) === round(r.trailingStopPremiumAfter, 8),
      'ACTIVE trailing stop left alone (derived from peak, not basis)',
      `${r.trailingStopPremiumBefore} -> ${r.trailingStopPremiumAfter}`,
    );
  }
}

console.log(`\n# graded ${census.restatements.length} restatement(s), ${failures} failed assertion(s)`);
if (failures > 0) { console.log('\nGATE A: FAIL'); process.exit(1); }
console.log('\nGATE A: PASS');
