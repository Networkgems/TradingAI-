#!/usr/bin/env node
// TRA-3723 — grade the LIVE fleet bound on bqb1, pinned to the build that served it.
//
// The defect: `B_i = min(φ · availableCash_i , A)` bounds each BOOK. Nothing
// bounds the SUM, and three files' comments said otherwise. φ = 0.4858 is
// 750/1,543.96 — the board authorization over the fleet capital measured on ONE
// NIGHT — so `Σ B_i ≤ A` holds only while `Σ E_i ≤ A/φ = $1,543.85`. Past that
// the fleet fails open, and the trigger is a DEPOSIT.
//
// This reads the live rows and takes the sum nobody was taking.
//
//   node scripts/tra3723-fleet-bound-live.mjs
//   node scripts/tra3723-fleet-bound-live.mjs --expect-commit=<shortSha>
//   node scripts/tra3723-fleet-bound-live.mjs --json
//
// EXIT CODES — "could not check" never shares a code with "checked and fine":
//   0 CLEAN     Σ B_i ≤ A (or over by no more than the disclosed φ 4th-place slack)
//   1 BREACH    Σ B_i > A + slack — the fleet fail-open, live
//   2 usage
//   3 BLIND     unreachable, unparseable, un-wired, or the pin did not match
//   Precedence BLIND > BREACH > CLEAN.
//
// ⚠ PIN ON `build.commitShort` + `build.startedAt`, NEVER `build.pid`: pid 76
// survived the whole 2026-08-14 redeploy, so it does not discriminate a restart
// (TRA-3718). And read `/api/health/options-live` for `build` — plain
// `/api/health` carries no `build` block at all.
//
// ⚠ This is a DETECTOR. A `1` means the authorization is ALREADY exceeded on the
// live host. Nothing in the order path consults it and nothing was stopped.

const BASE = process.env.BQB1_BASE ?? 'https://tradingai-bqb1.onrender.com';
const FEE_SLIPPAGE = `${BASE}/api/health/live-options-fee-slippage`;
const OPTIONS_LIVE = `${BASE}/api/health/options-live`;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const expectCommit = (args.find(a => a.startsWith('--expect-commit=')) ?? '').split('=')[1] ?? null;
if (args.some(a => a === '-h' || a === '--help')) {
  console.log('usage: node scripts/tra3723-fleet-bound-live.mjs [--expect-commit=<shortSha>] [--json]');
  process.exit(2);
}

function blind(msg, extra = {}) {
  if (asJson) console.log(JSON.stringify({ verdict: 'BLIND', reason: msg, ...extra }, null, 2));
  else console.error(`BLIND — ${msg}`);
  process.exit(3);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

let live;
let fee;
try {
  // `build` FIRST and from options-live, so every number below is attributable
  // to a named build. An unpinned reading of a money host is not evidence.
  [live, fee] = await Promise.all([getJson(OPTIONS_LIVE), getJson(FEE_SLIPPAGE)]);
} catch (err) {
  blind(`could not read bqb1: ${err.message}`);
}

const build = live?.build ?? null;
if (!build?.commitShort || !build?.startedAt) {
  blind('no build.commitShort / build.startedAt on /api/health/options-live — cannot pin the reading', { build });
}
if (expectCommit && build.commitShort !== expectCommit) {
  blind(
    `pin MISMATCH: expected commitShort ${expectCommit}, host is serving ${build.commitShort} `
    + `(startedAt ${build.startedAt}). The change is NOT deployed — do not read this as a pass.`,
    { build },
  );
}

// The route grades itself as of TRA-3723. Prefer the server's verdict, because
// that is the artifact the ticket is about; fall back to summing the rows so an
// OLD build (which serves `aggregateExposure` but no `aggregateFleetBound`) is
// still gradeable rather than blind — that fallback IS the pre-fix control.
const served = fee?.aggregateFleetBound ?? null;
const rows = Array.isArray(fee?.aggregateExposure) ? fee.aggregateExposure : null;
if (!served && !rows) blind('neither aggregateFleetBound nor aggregateExposure is wired on this build');

const armed = (rows ?? []).filter(r => r?.liveEntryGateOpen === true);
const localSum = Math.round(armed.reduce((s, r) => s + Math.round((r.capUsd ?? 0) * 100), 0)) / 100;
const A = fee?.aggregateCapUsd ?? null;

const out = {
  measuredAt: new Date().toISOString(),
  build: { commitShort: build.commitShort, startedAt: build.startedAt, pid: build.pid },
  pidIsNotARestartDiscriminator: true, // TRA-3718 — pid 76 survived the 08-14 redeploy
  // ⚠ THE EFFECTIVE ARM IS `arm.otmArmed` ON THE FEE-SLIPPAGE ROUTE. It does
  // NOT exist on /api/health/options-live — that route has no `arm` object at
  // all, and its three `…Armed` top-level fields (`liveOtmArmed`,
  // `liveRvLongArmed`, `liveDirectionalArmed`) are not the arm the order site
  // consults (TRA-3689). Reading `live.arm.otmArmed` here yields `null`, which
  // reads exactly like "disarmed" and is not.
  arm: {
    otmArmed: fee?.arm?.otmArmed ?? null,
    otmFlagOn: fee?.arm?.otmFlagOn ?? null,
    windowOpen: fee?.arm?.windowOpen ?? null,
    testUntilIso: fee?.arm?.testUntilIso ?? null,
    otmRoutingOnOptionsLive: live?.liveOtmRouting ?? null,
  },
  fleetCapUsd: A,
  fleetRiskFraction: fee?.fleetRiskFraction ?? null,
  fleetCapitalBasisUsd: fee?.fleetCapitalBasisUsd ?? null,
  armedBooks: armed.map(r => ({ book: r.book, capUsd: r.capUsd, availableCashUsd: r.availableCashUsd })),
  sumBookCapUsd: localSum,
  servedGrade: served,
  gradeSource: served ? 'server (TRA-3723 build)' : 'client fallback sum (pre-TRA-3723 build)',
};

let code = 0;
let verdict;
if (served) {
  verdict = served.verdict === 'blind' ? 'BLIND' : served.verdict === 'breach' ? 'BREACH' : 'CLEAN';
  code = verdict === 'BLIND' ? 3 : verdict === 'BREACH' ? 1 : 0;
  out.reason = served.reason;
} else if (typeof A !== 'number' || !(A > 0)) {
  verdict = 'BLIND';
  code = 3;
  out.reason = 'no usable aggregateCapUsd on this build';
} else {
  // Pre-fix build: allow the same capital-scaled φ slack the server uses, so
  // the disclosed 5c does not read as the defect.
  const capital = armed.reduce(
    (s, r) => s + (Number.isFinite(r.availableCashUsd) ? Math.round(r.availableCashUsd * 100) : 0), 0,
  ) / 100;
  const slack = Math.round(1e-4 * capital * 100) / 100;
  const overage = Math.max(0, Math.round((localSum - A) * 100) / 100);
  verdict = overage > slack ? 'BREACH' : 'CLEAN';
  code = verdict === 'BREACH' ? 1 : 0;
  out.reason = `client sum $${localSum.toFixed(2)} vs A $${A.toFixed(2)} (slack $${slack.toFixed(2)})`;
}
out.verdict = verdict;

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`${verdict} — ${out.reason}`);
  console.log(`  build   ${build.commitShort} startedAt ${build.startedAt} (pid ${build.pid} — NOT a restart discriminator)`);
  console.log(`  arm     otmArmed=${out.arm.otmArmed} otmFlagOn=${out.arm.otmFlagOn} windowOpen=${out.arm.windowOpen} until ${out.arm.testUntilIso}`);
  console.log(`  A       $${A}   phi ${out.fleetRiskFraction}   basis $${out.fleetCapitalBasisUsd ?? 'n/a'}`);
  for (const b of out.armedBooks) {
    console.log(`  book    ${b.book}: B_i $${b.capUsd}  (E_i $${b.availableCashUsd})`);
  }
  console.log(`  SUM     $${localSum.toFixed(2)}   [${out.gradeSource}]`);
}
process.exit(code);
