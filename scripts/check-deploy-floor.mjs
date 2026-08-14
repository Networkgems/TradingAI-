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
//   node scripts/check-deploy-floor.mjs --selftest         # both-direction controls
//
// Exit codes — FAILS CLOSED:
//   0  CLEAR  — target is at/above the floor. Deploy THIS id.
//   1  BELOW  — target is under the floor. The window would be un-gradeable.
//   3  BLIND  — a commit could not be READ (unknown rev, no git, detached remote,
//               or a SHALLOW checkout whose graft cut the path — see below).
//               NEVER a pass. "I could not check" is not "it is fine".
//
// ── A SHALLOW checkout cannot answer a NEGATIVE (TRA-3678) ───────────────────
// `git merge-base --is-ancestor A B` exits 1 for "A is not an ancestor of B"
// AND for "the path from A to B was grafted away by a shallow fetch". Same
// code, opposite meanings. `git merge-base A B` prints nothing in the second
// case too, which reads exactly like "unrelated histories".
//
// Both SHAs still RESOLVE in that state, so the usual existence probe
// (`git cat-file -e`) does not catch it — the objects are present; it is the
// history BETWEEN them that is missing.
//
// That is how this gate spent its life red. TRA-3678 measured all seven
// REQUIRED ids as absent and the floor as unreachable against a 256-commit
// shallow workspace, and concluded the mainline had been re-rooted. It had
// not. On a complete clone every one of the seven is an ancestor of
// origin/main and the gate is CLEAR — verified 2026-08-13 on 1ff4fa7b, which
// sits +580 above the floor, as is 606be9e5, the build serving bqb1.
//
// A POSITIVE (exit 0) stays trustworthy on a shallow clone: it is proven by
// objects that are actually present. Only the NEGATIVE has to be re-graded,
// and it re-grades to BLIND — which is what this gate's own header always
// said an unreadable leg was. Reporting BELOW there is reaching a verdict it
// has no standing to reach.

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
const SELFTEST = argv.includes('--selftest');
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

// ── The ancestry decision, as data (TRA-3678) ────────────────────────────────
// Pure, so --selftest can drive it in BOTH directions without needing a repo in
// each shape. `rc` is git's exit from `merge-base --is-ancestor`.
//
// Reads: 'ancestor' | 'not-ancestor' | 'blind-shallow' | 'blind-unrelated' | 'blind-undecidable'
export function gradeAncestry({ rc, isShallow, mergeBaseEmpty }) {
  if (rc !== 0 && rc !== 1) return 'blind-undecidable';
  if (rc === 0) return 'ancestor';            // proven by present objects — trust it even when shallow
  if (isShallow) return 'blind-shallow';      // rc 1 here is indistinguishable from a grafted path
  if (mergeBaseEmpty) return 'blind-unrelated'; // no common ancestor: unsatisfiable, not answered "no"
  return 'not-ancestor';
}

const IS_SHALLOW = git(['rev-parse', '--is-shallow-repository']).out === 'true';

// Returns true when `sha` is an ancestor of `target`; exits BLIND rather than
// returning a negative it cannot stand behind.
function isAncestorOrBlind(sha, target, label) {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', sha, target]);
  const mb = git(['merge-base', sha, target]);
  const verdict = gradeAncestry({
    rc: r.status,
    isShallow: IS_SHALLOW,
    mergeBaseEmpty: !(mb.ok && mb.out),
  });

  if (verdict === 'blind-shallow') {
    blind(
      `this checkout is SHALLOW, and ancestry for ${sha} (${label}) came back negative. ` +
      'A shallow graft and a genuine absence produce the SAME git exit code, so this is ' +
      'reported as unreadable rather than guessed. Run `git fetch origin --unshallow` ' +
      '(or `git fetch origin --deepen=<n>`) and re-run. TRA-3678: guessing here is what ' +
      'made this gate read red against a mainline that satisfies it in full.'
    );
  }
  if (verdict === 'blind-unrelated') {
    blind(
      `${sha} (${label}) and the target share NO common ancestor on a COMPLETE clone. ` +
      'The ancestry test is unsatisfiable, not failed — the floor would have to be ' +
      're-derived against the current mainline before it means anything. Do not read ' +
      'this as BELOW.'
    );
  }
  if (verdict === 'blind-undecidable') {
    blind(`git merge-base --is-ancestor exited ${r.status} for ${sha} (${label}) — could not decide`);
  }
  return verdict === 'ancestor';
}

// ── --selftest: control the grader in BOTH directions ────────────────────────
if (SELFTEST) {
  const cases = [
    // [name, input, expected]
    ['a true ancestor, full clone',            { rc: 0, isShallow: false, mergeBaseEmpty: false }, 'ancestor'],
    ['a true ancestor, SHALLOW clone',         { rc: 0, isShallow: true,  mergeBaseEmpty: false }, 'ancestor'],
    ['a genuine non-ancestor, full clone',     { rc: 1, isShallow: false, mergeBaseEmpty: false }, 'not-ancestor'],
    ['THE TRA-3678 BUG: negative + SHALLOW',   { rc: 1, isShallow: true,  mergeBaseEmpty: true  }, 'blind-shallow'],
    ['negative + shallow, merge-base present', { rc: 1, isShallow: true,  mergeBaseEmpty: false }, 'blind-shallow'],
    ['re-rooted history on a full clone',      { rc: 1, isShallow: false, mergeBaseEmpty: true  }, 'blind-unrelated'],
    ['git could not decide',                   { rc: 128, isShallow: false, mergeBaseEmpty: true }, 'blind-undecidable'],
  ];
  let failed = 0;
  console.log('[deploy-floor] --selftest — the decision must move in BOTH directions:');
  for (const [name, input, expected] of cases) {
    const got = gradeAncestry(input);
    const ok = got === expected;
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} -> ${got}${ok ? '' : `  (expected ${expected})`}`);
  }
  // A table that only ever produced one verdict would pass vacuously.
  const distinct = new Set(cases.map(([, i]) => gradeAncestry(i))).size;
  console.log(`  ${distinct >= 4 ? 'PASS' : 'FAIL'}  the table exercises ${distinct} distinct verdicts (need >= 4)`);
  if (distinct < 4) failed++;
  console.log(failed === 0 ? '[deploy-floor] SELFTEST OK' : `[deploy-floor] SELFTEST FAILED (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
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
if (IS_SHALLOW) {
  console.log('[deploy-floor] note   : this checkout is SHALLOW. A negative ancestry answer is');
  console.log('[deploy-floor]          unreadable here and exits BLIND, never BELOW (TRA-3678).');
}

// ── Assert the floor. `--is-ancestor` cannot answer for a rev it cannot read. ──
const floorRev = git(['rev-parse', `${FLOOR}^{commit}`]);
if (!floorRev.ok) blind(`cannot resolve the floor '${FLOOR}' — is this the right repo?`);

const atOrAboveFloor = isAncestorOrBlind(FLOOR, target, 'the floor');

// ── Report each required commit individually, so a miss NAMES itself. ─────────
const missing = [];
for (const [sha, ticket, consequence] of REQUIRED) {
  const rev = git(['rev-parse', `${sha}^{commit}`]);
  if (!rev.ok) blind(`cannot resolve required commit ${sha} (${ticket})`);
  if (isAncestorOrBlind(sha, target, ticket)) {
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
