#!/usr/bin/env node
// TRA-2361 AC5 — the MONOTONICITY DIFFERENTIAL for rule R1.
//
// ⚠️⚠️ WHY THIS SCRIPT EXISTS AND A GREEN SUITE DOES NOT REPLACE IT ⚠️⚠️
//
//   The whole safety argument for R1 is `passed′ ≤ passed` POINTWISE: adding a conjunct
//   to a conjunction is monotone non-increasing, so the change can only ever CLOSE a
//   capital path, never open one. That is a claim about the RELATION BETWEEN TWO BUILDS.
//   A suite that runs on the NEW build cannot see it, however green — and a code read
//   agreeing with it is exactly the evidence AC5 refuses.
//
//   So: check the pre-fix `live-capital-gate.ts` out of git, compile it beside the current
//   one, run BOTH over the IDENTICAL fixture set, and cross-tabulate old→new. Assert
//     • ZERO `false → true` cells      — the safety property, and
//     • AT LEAST ONE `true → false`    — or the change is inert and the matrix proves nothing.
//
//   Usage:
//     node scripts/tra2361-monotonicity-matrix.mjs
//     node scripts/tra2361-monotonicity-matrix.mjs --pre-fix=<sha>
//     node scripts/tra2361-monotonicity-matrix.mjs --keep      # leave the temp file
//     node scripts/tra2361-monotonicity-matrix.mjs --simulate-blind=after-write|after-build
//
//   Exit codes (fails CLOSED — an unrunnable differential is never a pass):
//     0 OK · 1 FAIL (the property does not hold) · 3 BLIND (could not run it; NOT a pass)
//
// ⚠️ THE TEMP FILE IS THE HAZARD THIS SCRIPT MANAGES FOR YOU. A stray `.ts`/`.js` sibling
// in `packages/server/src/` shadows the real source and turns the suite GREEN AGAINST CODE
// YOU ARE NOT SHIPPING (repo CLAUDE.md; `pnpm check:stale-js` — which only sees compiler
// OUTPUT, so it is by construction blind to the `.ts` sibling this script creates). The
// checkout is written under a `_tra2361_` prefix and removed in the `finally` below, which
// runs on EVERY path — OK, FAIL and BLIND alike — because `blind()` THROWS a sentinel
// rather than calling `process.exit()`. The only `process.exit()` reachable once the temp
// file can exist is the LAST statement in this file — the one other exit is argument
// validation, which runs before anything is written. (TRA-2372: it used to be inside
// `blind()`, which is called from deep inside the `try`, and
// `process.exit()` skips `finally`, so every BLIND run stranded a PRE-R1 copy of the
// capital gate in `src/` — untracked but NOT gitignored, and compiled into `dist/` by the
// next build. If you add an early exit anywhere above, you reintroduce that bug.)
//
// ⚠️ THE BUILD IS `tsc -b --force`, DELIBERATELY. `tsc -b` is incremental and records the
// temp file in `packages/server/tsconfig.tsbuildinfo`; cleanup deletes the emit but not
// that record, so the SECOND run and every run after it found the project "up to date",
// skipped the emit, and exited BLIND. An instrument that works exactly once is a dated
// green wearing a checker's clothes. `--force` costs ~20s and buys a repeatable answer.
// The repeat-run and cleanup properties are themselves asserted, in both directions, by
// `scripts/tra2372-monotonicity-prover-controls.mjs`.

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const argv = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const KEEP = argv.includes('--keep');
const preFixArg = argv.find((a) => a.startsWith('--pre-fix='));

// Test-only hook. The natural BLIND paths that strand the temp file are the ones that fire
// AFTER it is written (a failed build, a missing emit), and none of them can be provoked on
// demand from a clean tree — `--pre-fix=<sha with R1>` blinds on the sanity check BEFORE the
// write, so it cannot see the cleanup bug at all. Without a hook here, the assertion "the
// BLIND path cleans up" has no reachable subject and is vacuous. (TRA-2372.)
const SIMULATE_BLIND_STAGES = ['after-write', 'after-build'];
const simulateArg = argv.find((a) => a.startsWith('--simulate-blind='));
const SIMULATE_BLIND = simulateArg ? simulateArg.slice('--simulate-blind='.length) : null;
if (SIMULATE_BLIND !== null && !SIMULATE_BLIND_STAGES.includes(SIMULATE_BLIND)) {
  // Fail LOUD, not silently-disabled: a typo'd stage that no-op'd would turn the control
  // into an assertion about a run that never blinded.
  console.error(
    `--simulate-blind=${SIMULATE_BLIND} is not a stage. Use one of: ${SIMULATE_BLIND_STAGES.join(', ')}`,
  );
  process.exit(2);
}

// The commit `live-capital-gate.ts` was last at BEFORE R1 landed (TRA-2353's own commit).
// Overridable, because the useful question after a few merges is "vs whatever is live",
// not "vs the sha I hard-coded".
const PRE_FIX_DEFAULT = '88a072e';
const PRE_FIX = preFixArg ? preFixArg.slice('--pre-fix='.length) : PRE_FIX_DEFAULT;

const SRC = join(repo, 'packages', 'server', 'src');
const DIST = join(repo, 'packages', 'server', 'dist');
const TEMP_TS = join(SRC, '_tra2361_old_gate_TEMP.ts');
const TEMP_ARTIFACTS = [
  TEMP_TS,
  join(DIST, '_tra2361_old_gate_TEMP.js'),
  join(DIST, '_tra2361_old_gate_TEMP.d.ts'),
  join(DIST, '_tra2361_old_gate_TEMP.js.map'),
  join(DIST, '_tra2361_old_gate_TEMP.d.ts.map'),
];

// ⚠️ THROWS. Do not "simplify" this back to `process.exit(3)` — that skips the `finally`
// and strands the temp gate copy in `src/` (TRA-2372). Every call site below already
// relies on `blind()` not returning, and a throw satisfies that just as well as an exit.
class BlindError extends Error {}
const blind = (msg) => {
  throw new BlindError(msg);
};

function cleanup() {
  for (const f of TEMP_ARTIFACTS) {
    try {
      if (existsSync(f)) rmSync(f, { force: true });
    } catch (err) {
      console.error(`   ⚠️ could not remove ${f}: ${err?.message ?? err}`);
    }
  }
}

let exitCode = 0;
try {
  // ── 1. the pre-fix build, straight out of git ──────────────────────────────
  let oldSource;
  try {
    oldSource = execFileSync(
      'git',
      ['show', `${PRE_FIX}:packages/server/src/live-capital-gate.ts`],
      { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    blind(`git show ${PRE_FIX}:packages/server/src/live-capital-gate.ts failed — ${err?.message ?? err}`);
  }
  // A one-line sanity check that we really got the PRE-fix file. If the sha already
  // contains R1 the differential would compare a build against itself and print a
  // flawless, meaningless matrix — the "differential shows no difference ⇒ suspect the
  // knob" trap, with the knob being the sha.
  if (oldSource.includes('sleeveBlocking')) {
    blind(
      `${PRE_FIX} ALREADY CONTAINS the R1 conjunct (\`sleeveBlocking\`) — this would compare a build against itself. Pass --pre-fix=<sha before R1>.`,
    );
  }
  if (!oldSource.includes('evaluateLiveCapitalGate')) {
    blind(`${PRE_FIX}'s live-capital-gate.ts does not export evaluateLiveCapitalGate`);
  }

  if (!existsSync(SRC)) blind(`${SRC} does not exist — run this from the repo`);

  // Clear any artifact a previously-stranded run left behind BEFORE the build. Otherwise a
  // leftover `dist/_tra2361_old_gate_TEMP.js` from some earlier sha satisfies the emit check
  // below and the differential silently compares the working tree against THAT, not against
  // PRE_FIX. After this point, a TEMP artifact in `dist/` can only have come from this run.
  cleanup();

  mkdirSync(dirname(TEMP_TS), { recursive: true });
  writeFileSync(
    TEMP_TS,
    `// GENERATED BY scripts/tra2361-monotonicity-matrix.mjs — DO NOT COMMIT.\n` +
      `// Verbatim \`packages/server/src/live-capital-gate.ts\` at ${PRE_FIX}.\n` +
      `// If you are reading this in a committed tree, the script's cleanup did not run:\n` +
      `// delete it (\`pnpm check:stale-js\` will not catch a .ts sibling).\n` +
      oldSource,
    'utf8',
  );
  if (SIMULATE_BLIND === 'after-write') blind('--simulate-blind=after-write (test hook)');

  // ── 2. compile both, together, so they see the SAME dependency versions ────
  console.log(`── TRA-2361 · monotonicity differential ──────────────────────────`);
  console.log(`  pre-fix build : ${PRE_FIX}`);
  console.log(`  building packages/server (tsc -b --force) …`);
  try {
    // `--force` is load-bearing, not belt-and-braces. See the header: incremental `tsc -b`
    // remembers the temp file in tsconfig.tsbuildinfo, which cleanup does not (and should
    // not) rewrite, so from the second run onward it declares the project up to date and
    // never emits the artifact the differential needs. Composite builds key on CONTENT, so
    // `touch` does not bust it either — `--force` is the only cheap deterministic option
    // that does not leave a stale emit in the tree.
    execFileSync('npx', ['tsc', '-b', '--force'], {
      cwd: join(repo, 'packages', 'server'),
      encoding: 'utf8',
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    blind(`tsc -b --force failed:\n${err?.stdout ?? ''}${err?.stderr ?? err?.message ?? err}`);
  }
  if (SIMULATE_BLIND === 'after-build') blind('--simulate-blind=after-build (test hook)');

  const load = async (f) => {
    const p = join(DIST, f);
    if (!existsSync(p)) blind(`${p} was not emitted by the build`);
    return import(pathToFileURL(p).href);
  };
  const oldGate = await load('_tra2361_old_gate_TEMP.js');
  const newGate = await load('live-capital-gate.js');
  const { buildForwardTestReport } = await load('options-forward-test.js');
  const { BAR, MONOTONICITY_CASES } = await load('gate-sleeve-blocking-fixtures.js');

  const CRITERIA = { ...newGate.LIVE_CAPITAL_GATE, minExpectancyR: BAR };
  const AS_OF = Date.parse('2026-02-23T16:00:00.000Z');

  // ── 3. run BOTH over the IDENTICAL inputs ─────────────────────────────────
  //
  // ⚠️ The report is built ONCE per case and handed to both gates. Building it twice
  // would be two populations that must agree — and this script's entire value is that
  // the only difference between the two columns is the gate.
  const cells = { tt: 0, tf: 0, ft: 0, ff: 0 };
  const promoted = [];
  const demoted = [];
  const rowsOut = [];
  for (const c of MONOTONICITY_CASES()) {
    const report = buildForwardTestReport(c.outcomes, { asOf: AS_OF });
    const before = oldGate.evaluateLiveCapitalGate(report, CRITERIA).passed;
    const after = newGate.evaluateLiveCapitalGate(report, CRITERIA).passed;
    if (before && after) {
      cells.tt += 1;
    } else if (before && !after) {
      cells.tf += 1;
      demoted.push(c.key);
    } else if (!before && after) {
      cells.ft += 1;
      promoted.push(c.key);
    } else {
      cells.ff += 1;
    }
    rowsOut.push({ key: c.key, n: report.totals.resolved, before, after, what: c.what });
  }

  console.log('');
  console.log(`  ${'fixture'.padEnd(38)} ${'n'.padStart(3)}  old → new`);
  console.log(`  ${'-'.repeat(38)} ${'-'.repeat(3)}  ${'-'.repeat(14)}`);
  for (const r of rowsOut) {
    const arrow = r.before === r.after ? ' ' : r.before ? '⛔' : '🚨';
    console.log(
      `  ${r.key.padEnd(38)} ${String(r.n).padStart(3)}  ${String(r.before).padEnd(5)} → ${String(r.after).padEnd(5)} ${arrow}`,
    );
  }
  console.log('');
  console.log('  TRANSITION MATRIX (old passed → new passed)');
  console.log('                   new=true   new=false');
  console.log(`    old=true       ${String(cells.tt).padStart(8)}   ${String(cells.tf).padStart(9)}`);
  console.log(`    old=false      ${String(cells.ft).padStart(8)}   ${String(cells.ff).padStart(9)}`);
  console.log('');
  if (demoted.length) console.log(`  true → false (R1 closed these): ${demoted.join(', ')}`);
  if (promoted.length) console.log(`  false → true (MUST BE EMPTY):   ${promoted.join(', ')}`);

  const problems = [];
  if (cells.ft !== 0) {
    problems.push(
      `${cells.ft} \`false → true\` cell(s): ${promoted.join(', ')}. The change OPENED a capital path the pre-fix gate refused — this is NOT monotone and must not ship.`,
    );
  }
  if (cells.tf < 1) {
    problems.push(
      'ZERO `true → false` cells — the change is INERT over this fixture set, so the matrix proves nothing. Either R1 is not wired, or no fixture reaches it.',
    );
  }
  if (rowsOut.length < 2) problems.push('fewer than 2 fixtures — a matrix over one case is not a matrix');
  if (!rowsOut.some((r) => r.before === false)) {
    problems.push(
      'every fixture PASSED under the old build, so a `false → true` cell was structurally unreachable and the safety assertion above is vacuous.',
    );
  }

  if (problems.length) {
    console.error(`\n❌ FAIL — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`   · ${p}`);
    exitCode = 1;
  } else {
    console.log(
      `\n✅ OK — passed′ ≤ passed pointwise over ${rowsOut.length} fixtures: ZERO false→true, ${cells.tf} true→false.` +
        `\n   The R1 conjunct can only ever CLOSE a capital path, never open one.` +
        `\n   ⚠️ This is a statement about ${PRE_FIX} → the working tree. Re-run it after any rebase.`,
    );
  }
} catch (err) {
  // Both arms are BLIND (3), never FAIL (1): "the differential could not be run" and "the
  // property does not hold" are different claims, and only the second one is a finding.
  // An unexpected throw is squarely the first, so it must not be reported as the second.
  if (err instanceof BlindError) {
    console.error(`\n⚠️  BLIND — ${err.message}\n   This is NOT a pass: the monotonicity property is UNPROVEN.`);
  } else {
    console.error(
      `\n⚠️  BLIND — the differential threw before it could conclude:\n${err?.stack ?? err}` +
        `\n   This is NOT a pass: the monotonicity property is UNPROVEN.`,
    );
  }
  exitCode = 3;
} finally {
  if (KEEP) {
    console.error(`\n⚠️ --keep: ${TEMP_TS} was LEFT IN PLACE. Delete it before committing — a stray sibling in src/ shadows the source.`);
  } else {
    cleanup();
    const stragglers = TEMP_ARTIFACTS.filter((f) => existsSync(f));
    if (stragglers.length) {
      console.error(`\n❌ CLEANUP FAILED — these must be deleted by hand:\n   ${stragglers.join('\n   ')}`);
      exitCode = exitCode || 1;
    }
  }
}
process.exit(exitCode);
