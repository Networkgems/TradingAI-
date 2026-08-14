#!/usr/bin/env node
// tra3699-shallow-hold-repro.mjs — TRA-3699 (residual of TRA-3678)
//
// The commit-hold gate in render-redeploy.mjs (Gate 2) FAILED OPEN on a shallow
// checkout: `gitCarries` collapsed `merge-base --is-ancestor` exit 1 into a confident
// "the target does NOT carry the held commit", the hold did not apply, and the deploy
// to the live-money host PROCEEDED — while the gate printed clean.
//
// The pure decision is controlled in both directions by the table in
// tra2325-embargo-gate-check.mjs. THIS script controls the other half, which no table
// can reach: that the real git path, on a real grafted repository, actually produces
// the input that table grades. It builds the repro from scratch and runs the SHIPPED
// bytes of render-redeploy.mjs inside it.
//
// ⚠ A `--depth=N` CLONE IS NOT THE REPRO. There the held object is simply ABSENT and the
// existing `gitHasCommit` screen already returns null (BLIND) for the right reason — the
// arm would pass without the fix and prove nothing. The real shape is OBJECT PRESENT,
// PATH CUT:  git clone --depth=1  THEN  git fetch --depth=1 origin <held-sha>.
// A positive control must CONTAIN what it detects, so ARM 0 below asserts the graft is
// genuinely in that state (both shas resolve, ancestry still exits 1) before grading.
//
// Arms:
//   0  the repro is faithful         — both objects present, --is-ancestor exits 1 anyway
//   1  AC1  grafted shallow, target genuinely DOES carry the held commit -> REFUSE (BLIND)
//   1b THE DEFECT, on the pre-fix bytes at PRE_FIX_REV                   -> CLEAR (permits)
//   2  AC2  a genuine non-carry on the COMPLETE clone                    -> PERMIT
//   2b the complete clone answers CARRIES for arm 1's exact pair (the graft is the only
//      difference between arms 1 and 2 — without this, arm 1 could be a true negative)
//
//   node scripts/tra3699-shallow-hold-repro.mjs [--keep]
//   exit 0 = every arm as expected · 1 = an arm failed · 2 = could not build the repro

import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// The graft builder moved to lib in TRA-3721 so the sibling suite
// (tra3721-shallow-ancestry-repro.mjs) grades the SAME repro, not a re-typed imitation.
import {
  REPO_ROOT,
  gitOut,
  pickPair,
  buildGraft,
  graftDetail,
  stageScripts,
  ANCESTRY_LIB,
} from './lib/shallow-graft-repro.mjs';

const KEEP = process.argv.includes('--keep');

// The bytes that carried the defect. Pinned by REV, not by prose, so arm 1b runs the real
// pre-fix implementation rather than a re-typed imitation of it. af0a6f2f is the tip this
// fix was written against; scripts/render-redeploy.mjs there is the unfixed gitCarries.
const PRE_FIX_REV = 'af0a6f2f22765220471c0230767aa477f2bf2095';

const bail = msg => {
  console.error(`[tra3699] CANNOT RUN: ${msg}`);
  process.exit(2);
};

const results = [];
const arm = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  console.log(`       ${detail}`);
};

// ── Pick the pair. TARGET must genuinely CARRY HELD on the complete clone, or arm 1
// is testing a true negative and would pass without the fix. ───────────────────
let TARGET, HELD;
try {
  ({ target: TARGET, held: HELD } = pickPair({ depth: 50 }));
} catch (e) {
  bail(e.message);
}

console.log('[tra3699] shallow-graft repro for the render-redeploy commit-hold gate (Gate 2)');
console.log(`[tra3699]   held   ${HELD}`);
console.log(`[tra3699]   target ${TARGET}  (must CARRY held on a complete clone)\n`);

// A hold row that is ACTIVE. COMMIT_HOLDS ships self-expiring rows and every one of them
// has spent, so the live table cannot exercise this gate at all — inject instead of
// waiting for someone to add a hold.
const HOLD_UNTIL = new Date(Date.now() + 86_400_000).toISOString();
const HOLD_TABLE = [
  {
    commit: HELD,
    until: HOLD_UNTIL,
    ticket: 'TRA-3699 (synthetic hold, repro only)',
    why: 'synthetic — exists so the gate has something to hold',
  },
];

const root = mkdtempSync(join(process.env.TRA3699_SCRATCH ?? tmpdir(), 'tra3699-'));
const cleanup = () => {
  if (KEEP) {
    console.log(`\n[tra3699] --keep: repro left at ${root}`);
    return;
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* best effort */
  }
};

try {
  // ── Build the grafted shallow clone ────────────────────────────────────────
  let graft, facts;
  try {
    ({ graft, facts } = buildGraft(root, { target: TARGET, held: HELD }));
  } catch (e) {
    bail(e.message);
  }

  // ── ARM 0 — is the repro the thing it claims to be? ────────────────────────
  arm(
    'ARM 0 — the repro is the OBJECT-PRESENT / PATH-CUT state, not a plain --depth clone',
    facts.faithful,
    graftDetail(facts),
  );
  if (!facts.faithful) bail('the repro did not reach the grafted state; grading it would prove nothing');

  // ── ARM 1 — the FIXED bytes, in the grafted clone. Must REFUSE. ────────────
  // Copy this working tree's scripts in, so the arm grades the bytes being shipped rather
  // than whatever the clone happened to check out. `ANCESTRY_LIB` is the grader itself,
  // which render-redeploy.mjs imports since TRA-3721 — omit it and the arm does not run.
  stageScripts(graft, [
    'scripts/render-redeploy.mjs',
    'scripts/lib/auth-secret-predicate.mjs',
    ...ANCESTRY_LIB,
  ]);

  const runGate = async scriptPath => {
    const mod = await import(pathToFileURL(scriptPath).href);
    const state = mod.commitHoldState(new Date(), mod.resolveTarget('main', TARGET), HOLD_TABLE);
    return { verdict: state.verdict, why: state.why };
  };

  const fixed = await runGate(join(graft, 'scripts', 'render-redeploy.mjs'));
  arm(
    'ARM 1 (AC1) — grafted shallow, target genuinely CARRIES the held commit: gate must REFUSE',
    fixed.verdict === 'BLIND',
    `verdict=${fixed.verdict} (want BLIND; CLEAR is the defect — the hold silently lifts and the deploy ships)` +
      (fixed.why ? `\n       why=${fixed.why}` : ''),
  );

  // ── ARM 1b — the PRE-FIX bytes, same clone. Must show the defect. ──────────
  // Without this the suite cannot tell "the fix works" from "the repro never bit".
  const preFix = gitOut(['show', `${PRE_FIX_REV}:scripts/render-redeploy.mjs`]);
  if (preFix === null) {
    arm(
      `ARM 1b — the DEFECT reproduces on the pre-fix bytes (${PRE_FIX_REV.slice(0, 8)})`,
      false,
      `UNAVAILABLE: ${PRE_FIX_REV.slice(0, 8)}:scripts/render-redeploy.mjs is not in this checkout. ` +
        'Run `git fetch origin --unshallow`. Reported as a FAIL, not skipped: an uncontrolled fix arm is not evidence.',
    );
  } else {
    const preFixPath = join(graft, 'scripts', 'render-redeploy-prefix.mjs');
    writeFileSync(preFixPath, preFix);
    const before = await runGate(preFixPath);
    arm(
      `ARM 1b — the DEFECT reproduces on the pre-fix bytes (${PRE_FIX_REV.slice(0, 8)})`,
      before.verdict === 'CLEAR',
      `verdict=${before.verdict} (want CLEAR — that IS the bug: gate 6 permits a deploy carrying a held commit)`,
    );
  }

  // ── ARM 2 (AC2) — a genuine non-carry on the COMPLETE clone must still PERMIT ──
  // Both directions controlled: a gate that refuses everything is not a gate, and after a
  // fix that turns negatives into BLIND, "refuses everything" is the obvious way to fail.
  const here = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'render-redeploy.mjs')).href);
  const genuineNonCarry = here.commitHoldState(new Date(), here.resolveTarget('main', HELD), [
    { ...HOLD_TABLE[0], commit: TARGET, ticket: 'TRA-3699 (synthetic, reversed)' },
  ]);
  arm(
    'ARM 2 (AC2) — complete clone, a genuine non-carry: gate must PERMIT',
    genuineNonCarry.verdict === 'CLEAR',
    `held=${TARGET.slice(0, 12)} target=${HELD.slice(0, 12)} (the older commit cannot contain the newer) -> ` +
      `verdict=${genuineNonCarry.verdict} (want CLEAR; BLIND here would mean the gate is jammed shut and nobody can ship)`,
  );

  // ── ARM 2b — the graft is the ONLY difference between arm 1 and arm 2 ──────
  const sameOnComplete = here.commitHoldState(new Date(), here.resolveTarget('main', TARGET), HOLD_TABLE);
  arm(
    'ARM 2b — arm 1\'s exact pair on the COMPLETE clone reads CARRIES',
    sameOnComplete.verdict === 'CARRIES',
    `verdict=${sameOnComplete.verdict} (want CARRIES — this is what proves arm 1 was a HELD deploy being let ` +
      'through, not an honest negative)',
  );
} finally {
  cleanup();
}

const bad = results.filter(r => !r.ok);
console.log('');
console.log(`[tra3699] ${results.length - bad.length}/${results.length} arms as expected`);
if (bad.length) {
  console.error(`[tra3699] FAIL — ${bad.map(r => r.name.split(' —')[0]).join(', ')}`);
  process.exit(1);
}
console.log('[tra3699] PASS — a grafted-shallow held commit is REFUSED, and a genuine non-carry still ships.');
process.exit(0);
