#!/usr/bin/env node
// tra2325-embargo-gate-check.mjs — TRA-2325 / TRA-2322
//
// Discrimination suite for the two deploy gates in render-redeploy.mjs:
//   1. the daily RTH freeze, now opened DEPLOY_LEAD_MIN early (13:25Z, not 13:30Z),
//      because a deploy CREATED at 13:29Z BOOTS the box inside RTH;
//   2. the dated EMBARGO table (Mon 2026-07-27 13:25Z–21:00Z for the bqb1 hold; the close
//      side was extended from 20:20Z on 2026-07-26 — TRA-2306, see render-redeploy.mjs).
//
// A gate that refuses everything is not a gate, so every REFUSE case here is paired
// with a PROCEED case that differs by the one variable under test. A suite where the
// PROCEED cases cannot go green would rubber-stamp a permanently-jammed guard.
//
//   node scripts/tra2325-embargo-gate-check.mjs
//   exit 0 = all cases pass · 1 = a case failed

import {
  freezeState,
  embargoState,
  commitHoldState,
  resolveTarget,
  EMBARGOES,
  COMMIT_HOLDS,
  DEPLOY_LEAD_MIN,
  FREEZE_OPEN_MIN,
  FREEZE_CLOSE_MIN,
} from './render-redeploy.mjs';

const at = iso => new Date(iso);

// The decision render-redeploy.mjs makes for the SOAK HOST with no override flags.
// Embargo is checked first there, so it is checked first here.
const verdict = now => {
  if (embargoState(now).active) return 'REFUSE_EMBARGO';
  if (freezeState(now).frozen) return 'REFUSE_FREEZE';
  return 'PROCEED';
};

const CASES = [
  // ── The edges TRA-2325 named, on the embargoed Monday ────────────────────────
  ['2026-07-27T13:20:00Z', 'PROCEED', 'Mon 13:20Z — pre-open and pre-embargo: the ticket says this slot is fine'],
  ['2026-07-27T13:24:59Z', 'PROCEED', 'Mon 13:24:59Z — last clear instant before the embargo'],
  ['2026-07-27T13:25:00Z', 'REFUSE_EMBARGO', 'Mon 13:25:00Z sharp — embargo opens, half-open [from,to)'],
  ['2026-07-27T13:29:00Z', 'REFUSE_EMBARGO', 'Mon 13:29Z — the exact hole: old gate said exit 0, box boots in RTH'],
  ['2026-07-27T17:00:00Z', 'REFUSE_EMBARGO', 'Mon 17:00Z — mid-RTH, routine 0a9e7abc fires here'],
  ['2026-07-27T20:00:00Z', 'REFUSE_EMBARGO', 'Mon 20:00:00Z — the bell; old gate was FULLY OPEN from here'],
  ['2026-07-27T20:19:59Z', 'REFUSE_EMBARGO', 'Mon 20:19:59Z — still held'],

  // ── Close side, EXTENDED to 21:00Z on 2026-07-26 (CTO, TRA-2306) ─────────────
  // The old row closed at 20:20Z — the exact instant 0bb90f24 (TRA-2306) and dcedeb43
  // (TRA-2171) fire, and 5 min before the TRA-1648 soak check this embargo names. A deploy
  // CREATED at 20:20:00Z BOOTS ~2-3 min later, inside all of them: the created-vs-boots gap
  // DEPLOY_LEAD_MIN fixes on the open side, left unfixed on the close side.
  ['2026-07-27T20:20:00Z', 'REFUSE_EMBARGO', 'Mon 20:20:00Z sharp — 0bb90f24 (TRA-2306) + dcedeb43 fire HERE; was PROCEED'],
  ['2026-07-27T20:25:00Z', 'REFUSE_EMBARGO', 'Mon 20:25Z — 7d30dcfc TRA-1648 soak check, the read this embargo names'],
  ['2026-07-27T20:30:00Z', 'REFUSE_EMBARGO', 'Mon 20:30Z — f97baf3b TRA-2339 run check'],
  ['2026-07-27T20:45:00Z', 'REFUSE_EMBARGO', 'Mon 20:45Z — 7c3af47e TRA-2331 / e3e69d35 TRA-1585 grades'],
  ['2026-07-27T20:59:59Z', 'REFUSE_EMBARGO', 'Mon 20:59:59Z — last held instant'],
  ['2026-07-27T21:00:00Z', 'PROCEED', 'Mon 21:00:00Z sharp — embargo clear, half-open [from,to)'],
  ['2026-07-27T22:00:00Z', 'PROCEED', 'Mon 22:00Z — post-embargo, post-close'],

  // ── The daily freeze on an UN-embargoed weekday (the lead-time fix, isolated) ─
  ['2026-07-28T13:19:00Z', 'PROCEED', 'Tue 13:19Z — pre-open, outside the lead buffer'],
  ['2026-07-28T13:24:59Z', 'PROCEED', 'Tue 13:24:59Z — last clear instant before the freeze'],
  ['2026-07-28T13:25:00Z', 'REFUSE_FREEZE', 'Tue 13:25:00Z — freeze opens 5 min early (this is the fix)'],
  ['2026-07-28T13:29:00Z', 'REFUSE_FREEZE', 'Tue 13:29Z — the boot lands in RTH; old gate returned exit 0'],
  ['2026-07-28T13:30:00Z', 'REFUSE_FREEZE', 'Tue 13:30Z — RTH proper'],
  ['2026-07-28T19:59:59Z', 'REFUSE_FREEZE', 'Tue 19:59:59Z — last frozen instant'],
  ['2026-07-28T20:00:00Z', 'PROCEED', 'Tue 20:00:00Z — freeze closes at the bell, no late buffer'],

  // ── Weekend / off-hours: the freeze must NOT fire (direction control, TRA-2313) ─
  ['2026-07-25T17:00:00Z', 'PROCEED', 'Sat 17:00Z — weekend, clock inside RTH: freeze must NOT fire'],
  ['2026-07-26T17:00:00Z', 'PROCEED', 'Sun 17:00Z — weekend, clock inside RTH: freeze must NOT fire'],
  ['2026-07-27T02:00:00Z', 'PROCEED', 'Mon 02:00Z — weekday, pre-open, before the embargo'],
];

// ── The COMMIT HOLD (TRA-2306 / TRA-2355) ────────────────────────────────────
// A gate on WHAT ships, not WHEN. It is checked before the two time gates in
// render-redeploy.mjs because it fires while the calendar is wide open — which is the
// entire hole it was added to close: from the instant 204f298 landed on main until the
// embargo opens Mon 13:25Z, ~33 hours, every gate read PROCEED and the branch tip was
// the held commit.
//
// `carries` is injected, so these cases exercise the predicate without touching git or the
// network. HELD/CLEAN/UNKNOWN below stand for the three answers the real gitCarries gives.
const HELD = '204f2984896d62447d6a480c7f7c346b5071a5f6';
const holdVerdict = (now, target) => {
  const s = commitHoldState(at(now), target);
  return s.verdict === 'CLEAR' ? 'PROCEED' : `REFUSE_HOLD_${s.verdict}`;
};

// A target that carries the held commit / one that predates it / one we cannot test.
const carrying = sha => ({ sha, source: 'test', carries: h => h === HELD });
const clean = sha => ({ sha, source: 'test', carries: () => false });
const untestable = sha => ({ sha, source: 'test', carries: () => null });
const unresolved = { sha: null, source: 'test', error: 'ls-remote failed', carries: () => null };

const HOLD_CASES = [
  // While the hold is live — the ~33h window in which BOTH time gates said PROCEED.
  ['2026-07-26T04:45:00Z', carrying(HELD), 'REFUSE_HOLD_CARRIES', 'Sun 04:45Z — the hole: weekend, no embargo, tip IS the held commit'],
  ['2026-07-26T04:45:00Z', clean('88a072e'), 'PROCEED', 'Sun 04:45Z — SAME instant, a commit predating the hold: must NOT be refused'],
  ['2026-07-27T02:00:00Z', carrying('deadbee'), 'REFUSE_HOLD_CARRIES', 'Mon 02:00Z pre-open — a LATER commit that carries it is held too'],
  ['2026-07-27T13:20:00Z', carrying(HELD), 'REFUSE_HOLD_CARRIES', 'Mon 13:20Z — the slot the embargo deliberately leaves open'],
  ['2026-07-27T13:20:00Z', clean('408f06a'), 'PROCEED', 'Mon 13:20Z — same slot, clean commit: the pre-open window still works'],

  // Fails CLOSED. An unresolvable tip is not evidence of a clean tip.
  ['2026-07-26T04:45:00Z', unresolved, 'REFUSE_HOLD_BLIND', 'tip unresolvable (ls-remote down) — must refuse, not assume clean'],
  ['2026-07-26T04:45:00Z', untestable('c0ffee'), 'REFUSE_HOLD_BLIND', 'object missing from checkout — "cannot tell" is not "no"'],

  // SELF-EXPIRY. Without these the suite would pass a permanently-jammed gate.
  ['2026-07-27T21:00:00Z', carrying(HELD), 'PROCEED', 'Mon 21:00:00Z sharp — hold spent, the held commit ships (half-open)'],
  ['2026-07-27T21:00:00Z', unresolved, 'PROCEED', 'Mon 21:00:00Z — no active hold, so BLIND cannot fire either'],
  ['2026-07-28T09:00:00Z', carrying(HELD), 'PROCEED', 'Tue — expired row is inert, left in place as a record'],
];

let pass = 0;
const failures = [];
for (const [iso, target, expected, why] of HOLD_CASES) {
  const got = holdVerdict(iso, target);
  if (got === expected) {
    pass += 1;
    console.log(`  ok   ${iso}  ${got.padEnd(20)} ${why}`);
  } else {
    failures.push({ iso, expected, got, why });
    console.log(`  FAIL ${iso}  expected ${expected}, got ${got}  — ${why}`);
  }
}

const holdProduced = new Set(HOLD_CASES.map(([iso, target]) => holdVerdict(iso, target)));
const holdMissing = ['PROCEED', 'REFUSE_HOLD_CARRIES', 'REFUSE_HOLD_BLIND'].filter(v => !holdProduced.has(v));

for (const [iso, expected, why] of CASES) {
  const got = verdict(at(iso));
  if (got === expected) {
    pass += 1;
    console.log(`  ok   ${iso}  ${got.padEnd(15)} ${why}`);
  } else {
    failures.push({ iso, expected, got, why });
    console.log(`  FAIL ${iso}  expected ${expected}, got ${got}  — ${why}`);
  }
}

// Reachability: a suite in which one verdict never appears has not exercised that branch,
// and its greens would mean nothing (a jammed-open or jammed-shut gate passes a one-sided
// suite). Assert all three verdicts are actually produced.
const produced = new Set(CASES.map(([iso]) => verdict(at(iso))));
const missing = ['PROCEED', 'REFUSE_FREEZE', 'REFUSE_EMBARGO'].filter(v => !produced.has(v));

// ── LIVE arm (--live) ────────────────────────────────────────────────────────
// The cases above inject `carries`, so they prove the PREDICATE discriminates — they do
// not prove the real resolver reaches git, nor that the guard refuses TODAY'S actual tip.
// A suite of fakes passing while the live path is broken is exactly the reads-identically
// failure this repo keeps hitting. Opt-in because it needs the network.
//   node scripts/tra2325-embargo-gate-check.mjs --live
if (process.argv.includes('--live')) {
  console.log('');
  console.log('live    : resolving the real origin/main tip and re-running the gate against it');
  const liveTarget = resolveTarget('main', undefined);
  const live = commitHoldState(new Date(), liveTarget);
  console.log(`  tip     : ${liveTarget.sha ?? '(unresolved)'}  [${liveTarget.source}]`);
  if (liveTarget.error) console.log(`  error   : ${liveTarget.error}`);
  console.log(`  verdict : ${live.verdict}${live.hold ? ` (${live.hold.ticket})` : ''}`);
  const active = COMMIT_HOLDS.filter(h => Date.now() < Date.parse(h.until));
  if (active.length && live.verdict === 'CLEAR') {
    console.log('  note    : a hold is active and the current tip does NOT carry it — deploying tip is allowed.');
  }
  // Negative control: the SAME live resolver against a commit that predates every hold must
  // come back CLEAR. Without it, a resolver jammed at "CARRIES" would look like a working guard.
  const control = commitHoldState(new Date(), resolveTarget('main', '408f06a5ef819564c7b144673cda0c59024675af'));
  console.log(`  control : 408f06a5 (predates every hold) -> ${control.verdict}  ${control.verdict === 'CLEAR' ? 'ok' : 'FAIL — guard is jammed shut'}`);
  if (control.verdict !== 'CLEAR') {
    console.error('[tra2325] FAIL: the live resolver refuses a commit that carries no hold — jammed shut.');
    process.exit(1);
  }
}

const TOTAL = CASES.length + HOLD_CASES.length;
const allMissing = [...missing, ...holdMissing];

console.log('');
console.log(`freeze  : ${FREEZE_OPEN_MIN}–${FREEZE_CLOSE_MIN} UTC min-of-day (lead ${DEPLOY_LEAD_MIN} min)`);
console.log(`embargos: ${EMBARGOES.length} row(s) — ${EMBARGOES.map(e => `${e.from}→${e.to}`).join(', ')}`);
console.log(
  `holds   : ${COMMIT_HOLDS.length} row(s) — ${COMMIT_HOLDS.map(h => `${h.commit.slice(0, 7)}→${h.until} (${h.ticket})`).join(', ')}`,
);
console.log(`cases   : ${pass}/${TOTAL} pass`);
console.log(`verdicts: reached ${[...new Set([...produced, ...holdProduced])].sort().join(', ')}`);

if (allMissing.length) {
  console.error(`[tra2325] FAIL: verdict(s) never reached by any case: ${allMissing.join(', ')} — suite is one-sided.`);
  process.exit(1);
}
if (failures.length) {
  console.error(`[tra2325] FAIL: ${failures.length} case(s) failed.`);
  process.exit(1);
}
console.log('[tra2325] PASS — all three gates discriminate, and every verdict is reachable.');
process.exit(0);
