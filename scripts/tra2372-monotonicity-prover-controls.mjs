#!/usr/bin/env node
// TRA-2372 — CONTROLS for scripts/tra2361-monotonicity-matrix.mjs (the AC5 monotonicity prover).
//
// ⚠️⚠️ WHY THIS EXISTS: A SINGLE GREEN RUN COULD NOT SEE EITHER DEFECT ⚠️⚠️
//
//   The prover shipped with two bugs that a green run is structurally incapable of catching,
//   and both survived review for exactly that reason:
//
//     1. `blind()` called `process.exit(3)` from inside the `try`. `process.exit()` does not
//        run `finally` blocks, so every BLIND exit stranded `_tra2361_old_gate_TEMP.ts` — a
//        PRE-R1 copy of the capital gate — in `packages/server/src/`. Untracked but NOT
//        gitignored (`.gitignore` covers `packages/*/src/**/*.js|.d.ts`, not a bare `.ts`),
//        and `src` is in tsconfig's `include`, so the next `pnpm build` compiled it into
//        `dist/`. `pnpm check:stale-js` cannot see it: that guard detects compiler OUTPUT
//        shadowing a source, and this is a `.ts`.
//     2. `tsc -b` is incremental and recorded the temp file in `tsconfig.tsbuildinfo`.
//        Cleanup deleted the emit but not the record, so run 2 onward found the project
//        "up to date", skipped the emit, and exited BLIND. Composite builds key on CONTENT,
//        so `touch` did not bust it either.
//
//   They compound: the BLIND path was not an edge case, it was what every reviewer after
//   the first one got — and it was precisely the path that stranded the gate copy.
//
//   Neither could produce a false GREEN (the prover fails closed at exit 3), so R1 was never
//   at risk. But an AC5 instrument that runs correctly exactly once is a dated green wearing
//   a checker's clothes, which is the exact failure AC5 was written to prevent. Hence: this
//   file asserts the prover is REPEATABLE and that it CLEANS UP ON THE BLIND PATH.
//
// ⚠️ CONTROL #5 IS THE LOAD-BEARING ONE. "the temp file is absent" is also what you observe
// when the prover never wrote it, so on its own that assertion has no preimage and would
// pass against a script that did nothing. `--keep` is the positive control: it must leave
// the file PRESENT. A run of this script where control #5 is green is a run where the
// absence checks in #2/#3 mean something.
//
//   node scripts/tra2372-monotonicity-prover-controls.mjs
//   VERBOSE=1 node scripts/tra2372-monotonicity-prover-controls.mjs
//
// Costs ~4 forced `tsc -b --force` builds (~90s). Deliberately NOT in `pretest`; it is a
// named CI step, because a check nobody runs is the thing it is trying to prevent.
//
// Exit 0 = the prover is repeatable and leak-free. Exit 1 = some control failed.

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repo = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const PROVER = join(repo, 'scripts', 'tra2361-monotonicity-matrix.mjs');
const SRC_TEMP = join(repo, 'packages', 'server', 'src', '_tra2361_old_gate_TEMP.ts');
const DIST = join(repo, 'packages', 'server', 'dist');
const DIST_TEMPS = [
  '_tra2361_old_gate_TEMP.js',
  '_tra2361_old_gate_TEMP.d.ts',
  '_tra2361_old_gate_TEMP.js.map',
  '_tra2361_old_gate_TEMP.d.ts.map',
].map((f) => join(DIST, f));

const ARTIFACTS = () => [SRC_TEMP, ...DIST_TEMPS];
const resetTree = () => {
  for (const f of ARTIFACTS()) if (existsSync(f)) rmSync(f, { force: true });
};

// ⚠️ Resets BEFORE every run, not just once at the top. Without this, a strand left by
// control N is still sitting there when control N+1 reads the tree, and N+1 goes RED for
// someone else's reason — a misattributed failure that sends the next reader to the wrong
// defect. Each control's `src`/`dist` reading must be caused by that control alone.
const run = (args) => {
  resetTree();
  const r = spawnSync('node', [PROVER, ...args], { cwd: repo, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (process.env.VERBOSE) console.log(out);
  return { code: r.status, out };
};

// The transition matrix block, so "exit 0 twice" is also "graded the SAME population twice".
// A prover that returns 0 from two different matrices is not repeatable in the way AC5 needs.
const matrixOf = (out) => {
  const lines = out.split('\n').map((l) => l.trimEnd());
  const i = lines.findIndex((l) => l.includes('TRANSITION MATRIX'));
  return i === -1 ? null : lines.slice(i, i + 4).join('\n');
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
};
const srcTempState = () => (existsSync(SRC_TEMP) ? 'PRESENT' : 'absent');
const distTempState = () => {
  const present = DIST_TEMPS.filter((f) => existsSync(f));
  return present.length ? `PRESENT (${present.length})` : 'absent';
};

try {
  // Start from a known-clean tree, or control #5's positive result is unattributable.
  // (`run()` also resets before each invocation — see the note there.)
  resetTree();

  // ── 1. THE REPEAT-RUN CONTROL (defect 2) ──────────────────────────────────
  // The whole point. Run A used to pass and run B used to exit 3 BLIND.
  console.log('── running the prover twice (this is the defect-2 control) ────────');
  const a = run([]);
  const b = run([]);
  check(
    'prover exits 0 on TWO CONSECUTIVE runs (was: run 1 = 0, run 2 = 3 BLIND)',
    a.code === 0 && b.code === 0,
    `run A exit ${a.code}, run B exit ${b.code}`,
  );
  const [ma, mb] = [matrixOf(a.out), matrixOf(b.out)];
  check(
    'both runs graded the SAME transition matrix',
    ma !== null && ma === mb,
    ma === null ? 'no TRANSITION MATRIX block in run A output' : `matrix ${ma === mb ? 'identical' : 'DIFFERS'}`,
  );
  check(
    'the OK path leaves no temp artifact behind',
    srcTempState() === 'absent' && distTempState() === 'absent',
    `src ${srcTempState()} · dist ${distTempState()}`,
  );

  // ── 2/3. THE CLEANUP-ON-BLIND CONTROLS (defect 1) ─────────────────────────
  // Both stages blind AFTER the temp file is written, which is the only place the bug was
  // observable. `--pre-fix=<sha with R1>` (control #4) blinds BEFORE the write and therefore
  // could never have detected this — that is how the defect survived.
  for (const stage of ['after-write', 'after-build']) {
    const r = run([`--simulate-blind=${stage}`]);
    check(
      `BLIND at ${stage}: exit 3 AND cleanup ran (was: exit 3, gate copy STRANDED in src/)`,
      r.code === 3 && srcTempState() === 'absent' && distTempState() === 'absent',
      `exit ${r.code} · src ${srcTempState()} · dist ${distTempState()}`,
    );
  }

  // ── 4. the pre-write BLIND still fails closed ─────────────────────────────
  const head = run(['--pre-fix=HEAD']);
  check(
    'pre-write BLIND (--pre-fix=HEAD, sha already contains R1) exits 3, nothing written',
    head.code === 3 && srcTempState() === 'absent',
    `exit ${head.code} · src ${srcTempState()}`,
  );

  // ── 5. POSITIVE CONTROL — the absence checks above must have a preimage ───
  const keep = run(['--keep']);
  const keptSrc = srcTempState();
  check(
    'POSITIVE CONTROL: --keep LEAVES the temp file (proves 1/2/3 can actually fail)',
    keep.code === 0 && keptSrc === 'PRESENT',
    `exit ${keep.code} · src ${keptSrc}`,
  );
  // ...and that what it left really is the pre-R1 gate, so the strand this all guards
  // against is the artifact we think it is.
  if (keptSrc === 'PRESENT') {
    const body = readFileSync(SRC_TEMP, 'utf8');
    check(
      'the artifact under control is the PRE-R1 gate (exports the gate, lacks the R1 conjunct)',
      body.includes('evaluateLiveCapitalGate') && !body.includes('sleeveBlocking'),
      `evaluateLiveCapitalGate=${body.includes('evaluateLiveCapitalGate')} sleeveBlocking=${body.includes('sleeveBlocking')}`,
    );
  }
} finally {
  // This script's own cleanup — same trap it is testing for. Note there is no `process.exit()`
  // above; the only one is the last statement in this file, below the `finally`.
  for (const f of ARTIFACTS()) {
    try {
      if (existsSync(f)) rmSync(f, { force: true });
    } catch (err) {
      console.error(`   ⚠️ could not remove ${f}: ${err?.message ?? err}`);
    }
  }
  const stragglers = ARTIFACTS().filter((f) => existsSync(f));
  if (stragglers.length) {
    console.error(`\n❌ THIS SCRIPT LEAKED — delete by hand:\n   ${stragglers.join('\n   ')}`);
    results.push({ name: 'controls script left the tree clean', ok: false });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\n✅ ALL ${results.length} CONTROLS PASS — the monotonicity prover is repeatable and leaks nothing, and the leak detector has a demonstrated positive.`
    : `\n❌ ${failed.length}/${results.length} control(s) failed: ${failed.map((r) => r.name).join(' · ')}`,
);
process.exit(failed.length === 0 ? 0 : 1);
