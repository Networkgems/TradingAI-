#!/usr/bin/env node
// TRA-3723 / TRA-3737 — grade the LIVE fleet bound on bqb1, pinned to the build
// that served it. This is the READER half; the judgement lives in
// `scripts/lib/fleet-bound-grade.mjs` so it can be controlled offline.
//
// The defect: `B_i = min(φ · availableCash_i , A)` bounds each BOOK. Nothing
// bounds the SUM, and three files' comments said otherwise. φ = 0.4858 is
// 750/1,543.96 — a board authorization over the fleet capital measured on ONE
// NIGHT — so `Σ B_i ≤ A` holds only while `Σ E_i ≤ A/φ`. Past that the fleet
// fails open. The filing predicted the trigger would be a DEPOSIT. It was not:
// on 2026-08-20 the basis drifted on its own, A tightened to $500 (TRA-3827),
// and the live grade went `breach` at Σ B_i $558.68 with the OTM sleeve ARMED.
//
// This reads the live rows and takes the sum nobody was taking.
//
//   pnpm check:fleet-bound                    # 0 CLEAN · 1 BREACH · 2 usage · 3 BLIND
//   pnpm check:fleet-bound -- --json
//   node scripts/tra3723-fleet-bound-live.mjs --expect-commit=<shortSha>
//   node scripts/tra3723-fleet-bound-live.mjs --fixture=scripts/fixtures/<capture>.json
//
// EXIT CODES — "could not check" never shares a code with "checked and fine":
//   0 CLEAN     Σ B_i ≤ A (or over by no more than the disclosed φ 4th-place slack)
//   1 BREACH    Σ B_i > A + slack — the fleet fail-open, live
//   2 usage
//   3 BLIND     unreachable, unparseable, un-wired, or the pin did not match
//   3 UNBOUND   Σ B_i fits, but TRA-3879's `φ_eff = min(φ, A/Σ E_i)` did NOT bind on
//               this reading (unusable or PARTIAL fleet read), so the fit is a
//               coincidence of today's balances and the sum is unbounded again
//   Precedence BLIND > BREACH > CLEAN; UNBOUND only ever upgrades a CLEAN.
//
// ⚠ PIN ON `build.commitShort` + `build.startedAt`, NEVER `build.pid`: pid moved
// 73 → 73 → 72 across two real deploys, so it does not discriminate a restart and
// is misleading in both directions (TRA-3718). And read `/api/health/options-live`
// for `build` — plain `/api/health` carries no `build` block at all.
//
// ⚠ This is a DETECTOR. A `1` means the authorization is ALREADY exceeded on the
// live host. Nothing in the order path consults it and nothing was stopped.

import fs from 'node:fs';
import { gradeFleetBound, EXIT } from './lib/fleet-bound-grade.mjs';

const BASE = process.env.BQB1_BASE ?? 'https://tradingai-bqb1.onrender.com';
const FEE_SLIPPAGE = `${BASE}/api/health/live-options-fee-slippage`;
const OPTIONS_LIVE = `${BASE}/api/health/options-live`;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const expectCommit = (args.find(a => a.startsWith('--expect-commit=')) ?? '').split('=')[1] ?? null;
const fixture = (args.find(a => a.startsWith('--fixture=')) ?? '').split('=')[1] ?? null;
if (args.some(a => a === '-h' || a === '--help')) {
  console.log('usage: node scripts/tra3723-fleet-bound-live.mjs [--expect-commit=<shortSha>] [--fixture=<file>] [--json]');
  process.exit(EXIT.USAGE);
}

function blind(msg, extra = {}) {
  if (asJson) console.log(JSON.stringify({ verdict: 'BLIND', reason: msg, ...extra }, null, 2));
  else console.error(`BLIND — ${msg}`);
  process.exit(EXIT.BLIND);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

let live;
let fee;
if (fixture) {
  // Replay a captured reading. Used by the control suite and to re-grade a past
  // capture; it is NOT a live reading and says so in the source line below.
  try {
    const cap = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    ({ live, fee } = cap);
  } catch (err) {
    blind(`could not read fixture ${fixture}: ${err.message}`);
  }
} else {
  try {
    // `build` FIRST and from options-live, so every number below is attributable
    // to a named build. An unpinned reading of a money host is not evidence.
    [live, fee] = await Promise.all([getJson(OPTIONS_LIVE), getJson(FEE_SLIPPAGE)]);
  } catch (err) {
    blind(`could not read bqb1: ${err.message}`);
  }
}

const { verdict, code, out } = gradeFleetBound({
  live,
  fee,
  expectCommit,
  measuredAt: new Date().toISOString(),
});
out.source = fixture ? `FIXTURE ${fixture} (replay, NOT a live reading)` : BASE;

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else if (verdict === 'BLIND') {
  console.error(`BLIND — ${out.reason}`);
} else {
  // UNBOUND goes to stderr with the rest of the detail still on stdout: it is not
  // a pass, and a non-pass that prints only to stdout gets skimmed past.
  if (verdict === 'UNBOUND') console.error(`UNBOUND — ${out.reason}`);
  else console.log(`${verdict} — ${out.reason}`);
  console.log(`  source  ${out.source}`);
  console.log(`  build   ${out.build.commitShort} startedAt ${out.build.startedAt} (pid ${out.build.pid} — NOT a restart discriminator)`);
  console.log(`  arm     otmArmed=${out.arm.otmArmed} otmFlagOn=${out.arm.otmFlagOn} windowOpen=${out.arm.windowOpen} until ${out.arm.testUntilIso}`);
  console.log(`  A       $${out.fleetCapUsd}   phi ${out.fleetRiskFraction}   basis $${out.fleetCapitalBasisUsd ?? 'n/a'}`);
  for (const b of out.armedBooks) {
    console.log(`  book    ${b.book}: B_i $${b.capUsd}  (E_i $${b.availableCashUsd}, openRows ${b.openRows} — flatness is not headroom)`);
  }
  console.log(`  SUM     $${out.sumBookCapUsd.toFixed(2)}   [${out.gradeSource}]`);
  console.log(`  cover   ${out.coverage.armedBooksCovered}/${out.coverage.eligibleBooks} of the arm`);
  // ⭐ Print this on EVERY verdict, including CLEAN. "Σ B_i fits" and "the bound
  // that makes it fit is in force" are two different claims, and the whole point
  // of TRA-3737 §2 is that the second one was never being asked.
  const bif = out.boundInForce ?? {};
  const bifLabel = bif.inForce === true ? 'YES' : bif.inForce === false ? 'NO' : 'not published (pre-TRA-3879 build)';
  console.log(`  bound   in force: ${bifLabel}   [sizing: ${(bif.sizingReasons ?? []).map(r => r ?? 'absent').join(', ') || 'n/a'}]`);
  if (bif.inForce !== true) console.log(`          ${bif.reason}`);
  // TRA-3881 — say WHICH capital instrument governs, and never print a stale
  // negative headroom without the label that says it is stale. The old escalation
  // checklist quoted `fleetCapitalHeadroomUsd` flat, and after TRA-3879 that field
  // reads −$120.81 on a perfectly healthy fleet — on every reading, forever.
  const fc = out.fleetCapital ?? {};
  console.log(`  capital $${fc.fleetCapitalUsd ?? 'n/a'}   governing bound: ${fc.governing ?? 'n/a'}`);
  console.log(
    `          fitted A/phi: ceiling $${fc.fittedCeilingUsd ?? 'withheld'} headroom $${fc.fittedHeadroomUsd ?? 'withheld'}`
    + `   |   sized phi_eff*SumE: max SumB $${fc.sizedMaxSumUsd ?? 'n/a'} headroom $${fc.sizedHeadroomUsd ?? 'n/a'}`,
  );
  if (fc.doNotEscalate) console.log(`          ${fc.doNotEscalate}`);
  if (out.partial) console.log(`  ${out.partial}`);
}
process.exit(code);
