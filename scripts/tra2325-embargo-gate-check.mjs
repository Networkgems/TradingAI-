#!/usr/bin/env node
// tra2325-embargo-gate-check.mjs — TRA-2325 / TRA-2322
//
// Discrimination suite for the two deploy gates in render-redeploy.mjs:
//   1. the daily RTH freeze, now opened DEPLOY_LEAD_MIN early (13:25Z, not 13:30Z),
//      because a deploy CREATED at 13:29Z BOOTS the box inside RTH;
//   2. the dated EMBARGO table (Mon 2026-07-27 13:25Z–20:20Z for the bqb1 hold).
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
  EMBARGOES,
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
  ['2026-07-27T20:19:59Z', 'REFUSE_EMBARGO', 'Mon 20:19:59Z — still held, the 20:15Z monitor read is upstream'],
  ['2026-07-27T20:20:00Z', 'PROCEED', 'Mon 20:20:00Z sharp — embargo clear, routine dcedeb43 may ship'],
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

let pass = 0;
const failures = [];
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

console.log('');
console.log(`freeze  : ${FREEZE_OPEN_MIN}–${FREEZE_CLOSE_MIN} UTC min-of-day (lead ${DEPLOY_LEAD_MIN} min)`);
console.log(`embargos: ${EMBARGOES.length} row(s) — ${EMBARGOES.map(e => `${e.from}→${e.to}`).join(', ')}`);
console.log(`cases   : ${pass}/${CASES.length} pass`);
console.log(`verdicts: reached ${[...produced].sort().join(', ')}`);

if (missing.length) {
  console.error(`[tra2325] FAIL: verdict(s) never reached by any case: ${missing.join(', ')} — suite is one-sided.`);
  process.exit(1);
}
if (failures.length) {
  console.error(`[tra2325] FAIL: ${failures.length} case(s) failed.`);
  process.exit(1);
}
console.log('[tra2325] PASS — both gates discriminate, and every verdict is reachable.');
process.exit(0);
