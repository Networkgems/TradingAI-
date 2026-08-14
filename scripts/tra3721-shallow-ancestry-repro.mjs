#!/usr/bin/env node
// tra3721-shallow-ancestry-repro.mjs — TRA-3721 (AC3 residual of TRA-3699), FAIL-OPEN half
//
// Two more ancestry graders collapsed an UNREADABLE answer into a PERMISSION. Both are
// graded here against the SAME grafted repository state tra3699-shallow-hold-repro.mjs
// builds — the builder is shared (scripts/lib/shallow-graft-repro.mjs) precisely so the two
// suites cannot drift into grading different things.
//
//   1. scripts/tra2342-interlock-live-check.mjs — the `--self-test` NEGATIVE CONTROL.
//      The worse of the two: it does not merely mis-answer, it manufactures the green that
//      licenses the checker's other answers. The row asserts `ancestry === false` against a
//      build that PRECEDES the interlock; the old `catch { ancestry = false }` fires
//      unconditionally on a graft, so the row passed without discriminating anything and the
//      script printed "SELF-TEST OK". That sentence is the licence for the main arm's PASS,
//      and this checker is the standing pre-condition on the `TRADIER_ENV` write and on
//      arming live crypto. A positive control must CONTAIN what it detects; on a graft that
//      one contained nothing.
//
//   2. scripts/tra2306-ceiling-grade.mjs — the second, name-independent TRA-2355 detector.
//      It guarded every exit status EXCEPT `1`, which is where the graft lands. `readBuild`
//      emits a note for `true` and for `null` and NOTHING for `false`, so a grafted checkout
//      reported "TRA-2355 is not in the live build" in silence and left the PASS direction open.
//
// ⚠ A `--depth=N` CLONE IS NOT THE REPRO — see the header of lib/shallow-graft-repro.mjs.
// ARM 0 is the positive control on the control.
//
// BOTH DIRECTIONS, not just the new one. After a change that turns negatives into BLIND,
// "refuses everything" is the obvious way to fail, so every fixed arm has a complete-clone
// twin that must still answer.
//
//   node scripts/tra3721-shallow-ancestry-repro.mjs [--keep]
//   exit 0 = every arm as expected · 1 = an arm failed · 2 = could not build the repro

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

// The bytes that carried the defect, pinned by REV so the pre-fix arms run the real
// implementation rather than a re-typed imitation of it. 12305eba is the TRA-3699 fix — the
// tip TRA-3721 was written against, where BOTH of these two sites were still fail-open.
const PRE_FIX_REV = '12305eba78df5e00886a95beb8a2d5e0506a2e00';

// The commits tra2342's --self-test pins. They must be present as OBJECTS in the graft or the
// script's own `cat-file -e` screens bail at exit 2 first, and the fixed and pre-fix arms
// would then exit identically for entirely the wrong reason.
const TRA2342_CONTROL_SHAS = [
  'ffe656c3d84d7f850eb1d5a6c2f14f5562ebd594', // INTERLOCK_COMMIT
  '29cbb9a0fe885614e7b59eb34613e8a466dd11e3', // PRE_INTERLOCK_SHA
  'f2f63601522bdf0c9eaf4af323021fabb31db0d7', // PRE_THIRD_PATH_SHA
  '832dc92428dd75ca24f789fac694bbed01fd5fd7', // PRE_UNIVERSE_SHA
];

// The pre-fix rule in tra2306, quoted from the shipped source rather than remembered. ARM 4
// asserts this literal is actually present at PRE_FIX_REV before replaying it, so the arm
// cannot quietly become a control over a rule nobody ever shipped.
const TRA2306_PRE_FIX_RULE = 'e?.status === 1 ? false : null';

const bail = msg => {
  console.error(`[tra3721] CANNOT RUN: ${msg}`);
  process.exit(2);
};

const results = [];
const arm = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  console.log(`       ${detail}`);
};

const node = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180_000 });

let TARGET, HELD;
try {
  ({ target: TARGET, held: HELD } = pickPair({ depth: 50 }));
} catch (e) {
  bail(e.message);
}

console.log('[tra3721] shallow-graft repro for the two FAIL-OPEN ancestry graders');
console.log(`[tra3721]   held   ${HELD}`);
console.log(`[tra3721]   target ${TARGET}  (must CARRY held on a complete clone)\n`);

const root = mkdtempSync(join(process.env.TRA3721_SCRATCH ?? process.env.TRA3699_SCRATCH ?? tmpdir(), 'tra3721-'));
const cleanup = () => {
  if (KEEP) {
    console.log(`\n[tra3721] --keep: repro left at ${root}`);
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
    ({ graft, facts } = buildGraft(root, { target: TARGET, held: HELD, extraShas: TRA2342_CONTROL_SHAS }));
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

  // ── ARM 0b — tra2342's own control commits are PRESENT in the graft ────────
  // Without this, ARM 1 could pass because the script bailed on a missing object — which is a
  // DIFFERENT defect with a different remedy, and one the shipped code already handles.
  const missing = TRA2342_CONTROL_SHAS.filter(
    sha => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: graft }).status !== 0,
  );
  arm(
    "ARM 0b — tra2342's four pinned control commits RESOLVE inside the graft",
    missing.length === 0,
    missing.length === 0
      ? `all 4 present (${TRA2342_CONTROL_SHAS.map(s => s.slice(0, 8)).join(', ')}) — so ARM 1 cannot pass ` +
        'merely because the existing missing-object screen fired'
      : `MISSING: ${missing.map(s => s.slice(0, 8)).join(', ')} — the arms below would grade the wrong screen`,
  );

  // Stage the bytes being SHIPPED, so the arms grade those and not whatever the shallow clone
  // happened to check out. The lib is what both subjects import since this fix.
  stageScripts(graft, [
    'scripts/tra2342-interlock-live-check.mjs',
    'scripts/tra2306-ceiling-grade.mjs',
    ...ANCESTRY_LIB,
  ]);

  // ── ARM 1 (AC4) — tra2342 --self-test in the graft must FAIL, not go green ─
  // "For tra2342 specifically: assert the self-test FAILS (exit non-zero) when run inside the
  // grafted clone. That is the whole finding."
  const fixed2342 = node([join(graft, 'scripts', 'tra2342-interlock-live-check.mjs'), '--self-test'], graft);
  const said2342Ok = `${fixed2342.stdout ?? ''}`.includes('SELF-TEST OK');
  arm(
    'ARM 1 (AC4) — tra2342 --self-test inside the grafted clone must EXIT NON-ZERO (cannot run)',
    fixed2342.status !== 0 && !said2342Ok,
    `exit=${fixed2342.status} (want 2 = CANNOT RUN; 0 is the defect) · printed "SELF-TEST OK"=${said2342Ok}\n` +
      `       stderr: ${(`${fixed2342.stderr ?? ''}`.trim().split('\n')[0] || '(none)')}`,
  );

  // ── ARM 1b — the DEFECT reproduces on the pre-fix bytes, same clone ────────
  // Without this the suite cannot tell "the fix works" from "the repro never bit".
  const pre2342 = gitOut(['show', `${PRE_FIX_REV}:scripts/tra2342-interlock-live-check.mjs`]);
  if (pre2342 === null) {
    arm(
      `ARM 1b — the DEFECT reproduces on the pre-fix bytes (${PRE_FIX_REV.slice(0, 8)})`,
      false,
      `UNAVAILABLE: ${PRE_FIX_REV.slice(0, 8)}:scripts/tra2342-interlock-live-check.mjs is not in this checkout. ` +
        'Run `git fetch origin --unshallow`. Reported as a FAIL, not skipped: an uncontrolled fix arm is not evidence.',
    );
  } else {
    const pre2342Path = join(graft, 'scripts', 'tra2342-interlock-live-check-prefix.mjs');
    writeFileSync(pre2342Path, pre2342);
    const before = node([pre2342Path, '--self-test'], graft);
    const beforeSaidOk = `${before.stdout ?? ''}`.includes('SELF-TEST OK');
    arm(
      `ARM 1b — the DEFECT reproduces on the pre-fix bytes (${PRE_FIX_REV.slice(0, 8)})`,
      before.status === 0 && beforeSaidOk,
      `exit=${before.status} printed "SELF-TEST OK"=${beforeSaidOk} (want exit 0 + OK — that IS the bug: the ` +
        'negative control went green on a graft without discriminating anything, and that sentence licenses ' +
        "the checker's PASS on the TRADIER_ENV / live-crypto gate)",
    );
  }

  // ── ARM 2 (AC2) — the same fixed bytes on the COMPLETE clone must still GO GREEN ──
  // A self-test that refuses everywhere is not a self-test.
  const onComplete = node([join(REPO_ROOT, 'scripts', 'tra2342-interlock-live-check.mjs'), '--self-test'], REPO_ROOT);
  arm(
    'ARM 2 (AC2) — tra2342 --self-test on the COMPLETE clone must still EXIT 0 (green)',
    onComplete.status === 0 && `${onComplete.stdout ?? ''}`.includes('SELF-TEST OK'),
    `exit=${onComplete.status} (want 0; non-zero here would mean the fix jammed the gate shut and the ` +
      '`TRADIER_ENV` pre-condition can never be satisfied)',
  );

  // ── ARM 3 — tra2306's build detector in the graft must read `null`, not `false` ──
  const probe = `--ancestry-probe=${HELD}:${TARGET}`;
  const grafted2306 = node([join(graft, 'scripts', 'tra2306-ceiling-grade.mjs'), probe], graft);
  const graftedAnswer = `${grafted2306.stdout ?? ''}`.trim();
  arm(
    'ARM 3 — tra2306 build detector, grafted shallow, target genuinely CARRIES held: must read null (BLIND)',
    grafted2306.status === 0 && graftedAnswer.startsWith('null'),
    `answer=${graftedAnswer || '(no output)'} exit=${grafted2306.status} (want "null blind-shallow"; "false" is the ` +
      'defect — it silently reports "TRA-2355 is not in the live build" and leaves the PASS direction open)',
  );

  // ── ARM 3b (AC2) — a genuine non-carry on the COMPLETE clone must still read false ──
  const genuineNo = node(
    [join(REPO_ROOT, 'scripts', 'tra2306-ceiling-grade.mjs'), `--ancestry-probe=${TARGET}:${HELD}`],
    REPO_ROOT,
  );
  const genuineNoAnswer = `${genuineNo.stdout ?? ''}`.trim();
  arm(
    'ARM 3b (AC2) — complete clone, a genuine non-ancestor must still read false (not BLIND)',
    genuineNoAnswer.startsWith('false'),
    `held=${TARGET.slice(0, 12)} target=${HELD.slice(0, 12)} (the older commit cannot contain the newer) -> ` +
      `answer=${genuineNoAnswer || '(no output)'} (want "false not-carried"; null here would mean every grade ` +
      'defers forever)',
  );

  // ── ARM 3c — arm 3's exact pair on the COMPLETE clone reads true ───────────
  // This is what proves ARM 3 was an UNREADABLE negative and not an honest one.
  const sameOnComplete = node(
    [join(REPO_ROOT, 'scripts', 'tra2306-ceiling-grade.mjs'), `--ancestry-probe=${HELD}:${TARGET}`],
    REPO_ROOT,
  );
  const sameAnswer = `${sameOnComplete.stdout ?? ''}`.trim();
  arm(
    "ARM 3c — arm 3's exact pair on the COMPLETE clone reads true (carries)",
    sameAnswer.startsWith('true'),
    `answer=${sameAnswer || '(no output)'} (want "true carries" — the graft is the ONLY difference between ` +
      'ARM 3 and this, so ARM 3 was a real answer being lost, not a true negative)',
  );

  // ── ARM 4 — the pre-fix tra2306 RULE, quoted from the shipped bytes, replayed ──
  // tra2306's main body does network I/O at module load and its detector is not exported at
  // PRE_FIX_REV, so the pre-fix bytes cannot be driven end-to-end the way tra2342's can. What
  // IS controlled: the literal rule is confirmed present in the shipped pre-fix source, and it
  // is then replayed against the rc ARM 0 MEASURED on the real graft.
  const pre2306 = gitOut(['show', `${PRE_FIX_REV}:scripts/tra2306-ceiling-grade.mjs`]);
  const rulePresent = typeof pre2306 === 'string' && pre2306.includes(TRA2306_PRE_FIX_RULE);
  const replayed = rulePresent ? (facts.graftRc === 1 ? false : null) : undefined;
  arm(
    `ARM 4 — the pre-fix tra2306 rule \`${TRA2306_PRE_FIX_RULE}\` is real, and returns FALSE on this graft`,
    rulePresent && replayed === false,
    rulePresent
      ? `found verbatim at ${PRE_FIX_REV.slice(0, 8)}:scripts/tra2306-ceiling-grade.mjs · replayed against the ` +
        `MEASURED graft rc=${facts.graftRc} -> ${replayed} (want false — a confident "absent" on a question git ` +
        'never answered; ARM 3 is the same input through the fixed bytes)'
      : `NOT FOUND at ${PRE_FIX_REV.slice(0, 8)} — this arm would be a control over a rule nobody shipped. ` +
        'Reported as a FAIL, not skipped.',
  );
} finally {
  cleanup();
}

const bad = results.filter(r => !r.ok);
console.log('');
console.log(`[tra3721] ${results.length - bad.length}/${results.length} arms as expected`);
if (bad.length) {
  console.error(`[tra3721] FAIL — ${bad.map(r => r.name.split(' —')[0]).join(', ')}`);
  process.exit(1);
}
console.log(
  '[tra3721] PASS — on a grafted clone tra2342 REFUSES to certify itself and tra2306 reads BLIND, ' +
    'and both still answer on a complete clone.',
);
process.exit(0);
