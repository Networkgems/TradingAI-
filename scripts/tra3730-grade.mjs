#!/usr/bin/env node
// TRA-3730 — grade the SELF-DRIVING close-basis restatement against the four
// pre-registered acceptance criteria, on LIVE bytes.
//
// Written as a script rather than a hand-run curl for the reason the ticket
// itself gives: AC1 needs a live option round trip that closes AFTER the deploy
// and then settles, which is a market-hours event that will not have happened by
// the time the code ships. The grade therefore has to be RE-RUNNABLE, by someone
// who is not the author, days later, without re-deriving what the criteria were.
//
// ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────
// A window in which no live option fill settled is **VACUOUS**, and the ticket
// says so explicitly: it must never be recorded as clean. So AC1/AC2 have three
// verdicts, not two, and the vacuous one is non-zero. Same reasoning as
// `check:deploy-build` reading BLIND rather than CLEAN when it cannot see:
// "could not check" and "checked and it is fine" must not share an exit code.
//
// ── AC4, AND WHY THE BUILD PIN IS PART OF THE GRADE ──────────────────────────
// The journal is a `/data` fold held in memory. A same-process re-read re-reads
// MEMORY, not the store, and is vacuous (TRA-3485). So the grade is only valid
// against a build whose `startedAt` differs from the one the change was shipped
// under, and `--since-started-at` makes that an assertion instead of an
// intention. `build.pid` alone is NOT a restart discriminator (TRA-3703) — pid
// 72 has been reused across boots on this host — so `startedAt` + `commitShort`
// are what is compared.
//
// Usage:
//   node scripts/tra3730-grade.mjs
//   node scripts/tra3730-grade.mjs --host=https://tradingai-bqb1.onrender.com \
//        --require-commit=71400070 --since-started-at=2026-08-14T07:37:19.344Z
//
// Exit codes: 0 PASS · 1 FAIL · 2 usage · 3 BLIND (host unreachable / shape
// changed) · 4 VACUOUS (graded, but no settled live close in the window).
// Precedence BLIND > FAIL > VACUOUS > PASS.

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const HOST = (args.get('host') ?? 'https://tradingai-bqb1.onrender.com').replace(/\/$/, '');
const REQUIRE_COMMIT = args.get('require-commit') ?? null;
const SINCE_STARTED_AT = args.get('since-started-at') ?? null;

const P = (...m) => console.log('[tra3730]', ...m);

async function getJson(path) {
  const res = await fetch(`${HOST}${path}`, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

let live;
let journal;
try {
  // `options-live` and NOT `/api/health`: only this route carries the `build`
  // block with `startedAt`, which is the restart discriminator AC4 turns on.
  live = await getJson('/api/health/options-live');
  journal = await getJson('/api/health/option-journal?rows=all');
} catch (err) {
  P('BLIND — could not read the host:', err.message);
  process.exit(3);
}

const build = live?.build;
if (!build?.startedAt || !build?.commitShort) {
  P('BLIND — /api/health/options-live carries no build.startedAt/commitShort; shape changed.');
  process.exit(3);
}
P(`build   : ${build.commitShort} pid ${build.pid} startedAt ${build.startedAt} up ${build.uptimeSec}s`);

let blind = false;
if (REQUIRE_COMMIT && !build.commitShort.startsWith(REQUIRE_COMMIT)) {
  P(`BLIND — live is ${build.commitShort}, expected ${REQUIRE_COMMIT}. Grading a build that does not carry the change measures the OLD code and the numbers look completely ordinary (TRA-2229).`);
  blind = true;
}
// AC4. A same-pid, same-startedAt read is a memory re-read, not a cold replay.
if (SINCE_STARTED_AT && build.startedAt === SINCE_STARTED_AT) {
  P(`BLIND — startedAt is unchanged (${build.startedAt}); this is a same-process re-read of the in-memory fold, which is vacuous (TRA-3485).`);
  blind = true;
} else if (SINCE_STARTED_AT) {
  P(`AC4 PASS — cold replay: startedAt moved ${SINCE_STARTED_AT} -> ${build.startedAt}.`);
}
if (blind) process.exit(3);

const sweep = journal?.closeBasisSweep;
const amends = journal?.closeBasisAmends;
if (!sweep || !amends) {
  P('BLIND — /api/health/option-journal carries no closeBasisSweep/closeBasisAmends; the sweep is not wired into this build.');
  process.exit(3);
}

P(`sweep   : ticks=${sweep.ticks} outcome=${sweep.lastOutcome} lastRunAt=${sweep.lastRunAt} ledgerUsable=${sweep.ledgerUsable} observeOnly=${sweep.observeOnly}`);
P(`counts  : ${JSON.stringify(sweep.counts)}`);
P(`applied : last=${JSON.stringify(sweep.lastApplied)} lifetime=${JSON.stringify(sweep.lifetime)}`);
P(`amends  : total=${amends.total} applied=${amends.applied} refused=${amends.refused} netDeltaUsd=${amends.netDeltaUsd}`);

// The positive zero. `null` is NEVER CHECKED and must not read as clean.
if (sweep.restatableRows?.count === null || sweep.checked !== true) {
  P(`BLIND — the sweep has not enumerated the rows yet (checked=${sweep.checked}, restatableRows.count=${sweep.restatableRows?.count}). The boot kick fires 150s after startedAt; the hourly tick fires at minute 0 ET. Re-run.`);
  process.exit(3);
}

const rows = Array.isArray(journal.rows) ? journal.rows : [];
const liveClosed = rows.filter((r) => r.mode === 'live' && r.outcome !== 'OPEN');
const brokerFill = liveClosed.filter((r) => r.pnlBasis === 'broker-fill');
P(`rows    : ${liveClosed.length} closed live, ${brokerFill.length} on pnlBasis broker-fill`);

const failures = [];
const vacuous = [];

// ── AC2 — the fold accepted every write it was offered ──────────────────────
if (amends.refused !== 0) {
  failures.push(`AC2 FAIL — closeBasisAmends.refused is ${amends.refused}, expected 0. A refusal means a restatement was pointed at a row that is unknown or still OPEN.`);
} else {
  P('AC2 ok  — closeBasisAmends.refused = 0.');
}
if (sweep.lastApplied?.refused !== 0) {
  failures.push(`AC2 FAIL — the last tick recorded ${sweep.lastApplied.refused} fold refusal(s).`);
}

// ── AC3 — an unmeasured-fee row is SKIPPED, not zero-filled ─────────────────
// The check is deliberately two-sided. Counting the skips proves the planner
// refused; it does NOT prove the row was left alone. A zero-fill would ALSO
// produce a skip on the next pass (the row would then read `already_restated`),
// so the load-bearing half is that the row still carries no `pnlBasis`.
const feesPending = sweep.counts?.feesPending ?? 0;
const pendingRows = (sweep.lastRows ?? []).filter((r) => r.skipReason === 'fees_unmeasured');
if (feesPending === 0) {
  P('AC3 n/a — no row is currently waiting on fee measurement. Not a pass and not a fail: the criterion has nothing to grade this tick.');
  vacuous.push('AC3 had no fee-pending row to grade in this window.');
} else {
  const zeroFilled = pendingRows.filter((r) => {
    const row = rows.find((x) => x.id === r.id);
    return row && (row.pnlBasis === 'broker-fill' || row.feesUsd === 0);
  });
  if (zeroFilled.length > 0) {
    failures.push(`AC3 FAIL — ${zeroFilled.length} fee-pending row(s) were zero-filled or stamped broker-fill: ${zeroFilled.map((r) => r.optionSymbol).join(', ')}.`);
  } else {
    P(`AC3 PASS — ${feesPending} row(s) skipped as fees_unmeasured; none carries pnlBasis, none was zero-filled.`);
    for (const r of pendingRows) P(`          held: ${r.optionSymbol} realizedPnlUsd unchanged at ${r.realizedPnlUsdBefore}`);
  }
}

// ── AC1 — a round trip that closed AFTER the ship reads broker-fill, with
//    nobody POSTing the repair route ─────────────────────────────────────────
// The window opens at the deploy, so a row that closed BEFORE it cannot
// discriminate: it would have been restatable at any point and proves nothing
// about self-driving. Pass `--since-started-at` to bound it.
const windowOpensAt = SINCE_STARTED_AT ? Date.parse(SINCE_STARTED_AT) : Date.parse(build.startedAt);
const closedInWindow = liveClosed.filter((r) => Number.isFinite(r.closeTs) && r.closeTs >= windowOpensAt);
if (closedInWindow.length === 0) {
  P(`AC1 VACUOUS — no live option round trip has CLOSED since ${new Date(windowOpensAt).toISOString()}. Recorded as vacuous, never as clean.`);
  vacuous.push('AC1 had no post-ship live close to grade.');
} else {
  const settledUnrestated = closedInWindow.filter(
    (r) => r.pnlBasis !== 'broker-fill' && !pendingRows.some((p) => p.id === r.id),
  );
  if (settledUnrestated.length > 0) {
    failures.push(`AC1 FAIL — ${settledUnrestated.length} row(s) closed post-ship read neither broker-fill nor fees-pending: ${settledUnrestated.map((r) => r.optionSymbol).join(', ')}.`);
  } else {
    const done = closedInWindow.filter((r) => r.pnlBasis === 'broker-fill');
    P(`AC1 PASS — ${closedInWindow.length} post-ship close(s): ${done.length} on broker-fill, ${closedInWindow.length - done.length} correctly awaiting settlement.`);
  }
}

// ── The self-driving claim itself ───────────────────────────────────────────
// Distinct from AC1-3 and the whole point of the ticket: the pass has to have
// RUN, unattended. `ticks > 0` on a box nobody can admin-auth against is the
// evidence, and it is exactly what `closeBasisAmends` alone cannot show.
if (!(sweep.ticks > 0)) {
  failures.push('FAIL — closeBasisSweep.ticks is 0: the sweep is present in the build but has never run.');
} else {
  P(`self-driving ok — ${sweep.ticks} unattended tick(s), no admin token involved.`);
}
if (sweep.observeOnly === true) {
  P('NOTE — CLOSE_BASIS_SWEEP_OBSERVE_ONLY is set: the pass is measuring and deliberately not writing.');
}
if (sweep.ledgerUsable === false) {
  failures.push('FAIL — the fill ledger is not a usable source of broker truth; the pass is measuring but cannot write.');
}

console.log('');
if (failures.length > 0) {
  for (const f of failures) P(f);
  P('VERDICT: FAIL');
  process.exit(1);
}
if (vacuous.length > 0) {
  for (const v of vacuous) P(v);
  P('VERDICT: VACUOUS — the mechanism is live and healthy, but the window carried nothing that could exercise every criterion. Re-run after the next live option round trip settles.');
  process.exit(4);
}
P('VERDICT: PASS — all four criteria graded green on live bytes.');
process.exit(0);
