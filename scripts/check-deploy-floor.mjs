#!/usr/bin/env node
// check-deploy-floor.mjs — TRA-1715
//
// The bqb1 pin lift names a COMMIT ID (TRA-1665: "deploy by commit id, never
// deploy latest"). This asserts the id is at or above the OBSERVABILITY FLOOR.
//
// Below the floor the delta-ceiling measurement window (TRA-1690) is not
// *wrong* — it is UN-GRADEABLE, and an un-gradeable window reads exactly like a
// healthy one. The integrity and durability assertions do not FAIL on an older
// build; their keys are simply ABSENT, and an absent key reads as fine. The
// window opens, runs for weeks, and is thrown away at n=40.
//
// The trap is the MIDDLE of the range, which is exactly where a cautious soak
// lands: "stop short of the newest commit" is how you pick a target if you do
// not know this table. TRA-1672 carried `bbd15b7` in its title for a week —
// 18 commits below the floor, missing all six required fixes.
//
//   FLOOR (ef30c4c) lacks nothing. Every id below it lacks at least one of:
//     0ea97b7  TRA-1689  per-sleeve ceiling — else RV's knob moves OTM's band
//     1f87e35  TRA-1682  archetype re-key   — else 3 scanners pool under 1 label
//     f0cf9b8  TRA-1691  structure!=sleeve  — else the rollup pools 3 scanners
//     3a1e70e  TRA-1703  reboot ledger      — else a reboot launders breach rows
//     2b6556f  TRA-1707  null sentinel      — else a live bar publishes as 0.00
//     847d601  TRA-1681  corrupt-line skip  — else a lost row reads as a clean load
//
// A remembered id is the failure mode, so the default target is RE-DERIVED from
// origin/main at call time and then checked against the floor. Pass an explicit
// --target only when you mean to pin one, and it gets the same check.
//
// Usage:
//   node scripts/check-deploy-floor.mjs                    # re-derive origin/main
//   node scripts/check-deploy-floor.mjs --target=<commit>  # check a named id
//   node scripts/check-deploy-floor.mjs --no-fetch         # skip `git fetch`
//
// Exit codes — FAILS CLOSED:
//   0  CLEAR  — target is at/above the floor. Deploy THIS id.
//   1  BELOW  — target is under the floor. The window would be un-gradeable.
//   3  BLIND  — a commit could not be READ (unknown rev, no git, detached remote).
//               NEVER a pass. "I could not check" is not "it is fine".

import { spawnSync } from 'node:child_process';

const FLOOR = 'ef30c4c';

// Each required commit, with what an id lacking it silently does to the window.
//
// 07ea3b1 is an ancestor of the floor, so the floor check alone already implies
// it. It is asserted BY NAME anyway: it is TRA-1718's stated invalidation, and
// "implied by the floor" is precisely the kind of inference that goes stale the
// day someone moves the floor. An id without it does not merely mis-measure the
// RV long — the sleeve admits ZERO candidates by construction (the selector
// emits |delta| >= 0.45 into a gate that admits <= 0.40; empty intersection),
// and an empty set reads exactly like a hostile tape.
const REQUIRED = [
  ['07ea3b1', 'TRA-1677', 'the RV long entry gate is algebraically impossible — sleeve admits 0, forever'],
  ['0ea97b7', 'TRA-1689', "one sleeve's ceiling knob moves another sleeve's measured band"],
  ['1f87e35', 'TRA-1682', "the demo directional opener wears the RV long's journal label"],
  ['f0cf9b8', 'TRA-1691', 'the rollup keys on structure, pooling three scanners as one cohort'],
  ['3a1e70e', 'TRA-1703', 'a reboot launders every observed breach into a phantom admit'],
  ['2b6556f', 'TRA-1707', 'a ceiling-first day publishes a LIVE bar as 0.00R / admitRate 0'],
  ['847d601', 'TRA-1681', "the journal's corrupt-line skip is silent, so a lost row reads clean"],
];

const argv = process.argv.slice(2);
const NO_FETCH = argv.includes('--no-fetch');
const targetArg = argv.find(a => a.startsWith('--target='))?.slice('--target='.length);

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function blind(msg) {
  console.error(`[deploy-floor] BLIND: ${msg}`);
  console.error('[deploy-floor] A leg could not be READ. This is never a pass.');
  process.exit(3);
}

// ── Resolve the target. Default: RE-DERIVE, never recall. ─────────────────────
if (!targetArg && !NO_FETCH) {
  const f = git(['fetch', 'origin', '--quiet']);
  if (!f.ok) blind(`git fetch origin failed: ${f.err || 'unknown error'}`);
}

const targetRef = targetArg ?? 'origin/main';
const resolved = git(['rev-parse', `${targetRef}^{commit}`]);
if (!resolved.ok) blind(`cannot resolve target '${targetRef}': ${resolved.err || 'unknown rev'}`);

const target = resolved.out;
const shortTarget = target.slice(0, 7);
const subject = git(['log', '-1', '--format=%s', target]);

console.log(`[deploy-floor] target : ${target}  (${targetRef})`);
if (subject.ok) console.log(`[deploy-floor]          ${subject.out}`);
console.log(`[deploy-floor] floor  : ${FLOOR}`);
if (!targetArg) {
  console.log('[deploy-floor] target was RE-DERIVED from origin/main, not recalled.');
}

// ── Assert the floor. `--is-ancestor` cannot answer for a rev it cannot read. ──
const floorRev = git(['rev-parse', `${FLOOR}^{commit}`]);
if (!floorRev.ok) blind(`cannot resolve the floor '${FLOOR}' — is this the right repo?`);

const floorOk = spawnSync('git', ['merge-base', '--is-ancestor', FLOOR, target]);
if (floorOk.status !== 0 && floorOk.status !== 1) {
  blind(`git merge-base --is-ancestor exited ${floorOk.status} (could not decide)`);
}
const atOrAboveFloor = floorOk.status === 0;

// ── Report each required commit individually, so a miss NAMES itself. ─────────
const missing = [];
for (const [sha, ticket, consequence] of REQUIRED) {
  const rev = git(['rev-parse', `${sha}^{commit}`]);
  if (!rev.ok) blind(`cannot resolve required commit ${sha} (${ticket})`);
  const r = spawnSync('git', ['merge-base', '--is-ancestor', sha, target]);
  if (r.status !== 0 && r.status !== 1) blind(`ancestry undecidable for ${sha} (${ticket})`);
  if (r.status === 0) {
    console.log(`[deploy-floor]   ✓ ${sha}  ${ticket}`);
  } else {
    console.log(`[deploy-floor]   ✗ ${sha}  ${ticket}  → ${consequence}`);
    missing.push([sha, ticket, consequence]);
  }
}

if (!atOrAboveFloor || missing.length > 0) {
  console.error('');
  console.error(`[deploy-floor] BELOW FLOOR — ${shortTarget} is not at or above ${FLOOR}.`);
  const behind = git(['rev-list', '--count', `${target}..${FLOOR}`]);
  if (behind.ok) console.error(`[deploy-floor] It is ${behind.out} commit(s) behind the floor.`);
  console.error('[deploy-floor] Deploying it does NOT make the observe window fail loudly.');
  console.error('[deploy-floor] The keys above are ABSENT, not false — the window reads HEALTHY');
  console.error('[deploy-floor] and is discarded at n=40, having cost the weeks it ran.');
  console.error('[deploy-floor] Lift to ef30c4c or a descendant, or hold the window CLOSED.');
  process.exit(1);
}

const ahead = git(['rev-list', '--count', `${FLOOR}..${target}`]);
console.log('');
console.log(`[deploy-floor] CLEAR — ${shortTarget} is at/above the floor (+${ahead.ok ? ahead.out : '?'}).`);
console.log(`[deploy-floor] Deploy THIS id by commit id (TRA-1665): ${target}`);
process.exit(0);
