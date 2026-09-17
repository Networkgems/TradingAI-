#!/usr/bin/env node
/**
 * TRA-2392 — positive control for universe-gated promotion logic.
 *
 * A positive control perturbs the code to deliver a known defect, asserts the
 * tests FAIL, then restores and asserts they PASS. If tests stay green through
 * a defect, the control is BLIND — the tests do not discriminate.
 *
 * WHY THIS EXISTS. `packages/server` imports `@trading-app/shared` by package
 * name ⇒ dist, NOT src. Patching `src/promotion-gate.ts` and running the suite
 * exercised the OLD compiled code: all 26 tests stayed green, byte-identically
 * to "the tests do not discriminate" — I was one step from weakening good tests
 * to "fix" them.
 *
 * The control rebuilds shared with `--force`, asserts the perturbation reached
 * `dist` (grep a marker), then grades the verdict. Exits 0=PASS, 1=FAIL, 2=BLIND.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const SHARED_SRC = 'packages/shared/src/symbol-universe.ts';
const SHARED_DIST = 'packages/shared/dist/symbol-universe.js';

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
  } catch (e) {
    return e.stdout;
  }
}

function rebuildShared() {
  console.log('Rebuilding @trading-app/shared with --force...');
  execSync('npx tsc -b packages/shared --force', { stdio: 'inherit' });
}

function assertMarkerInDist(marker) {
  const dist = readFileSync(SHARED_DIST, 'utf-8');
  if (!dist.includes(marker)) {
    console.error(`BLIND: marker "${marker}" not found in ${SHARED_DIST}`);
    console.error('The perturbation did not reach dist. Tests are grading the old code.');
    process.exit(2);
  }
  console.log(`✓ Marker "${marker}" found in dist`);
}

function runTests() {
  const out = exec('npm test -- promotion-universe.test');
  return {
    passed: out.includes('passed'),
    failed: out.includes('failed'),
    output: out,
  };
}

console.log('=== TRA-2392 Positive Control ===\n');

// Baseline: tests should pass on unperturbed code
console.log('1. Baseline: running tests on clean code...');
rebuildShared();
let result = runTests();
if (!result.passed) {
  console.error('FAIL: Tests failed on clean code. Fix the tests first.');
  process.exit(1);
}
console.log('✓ Baseline PASS\n');

// Perturbation 1: Read null/⊤ as permissive (should fail some tests)
console.log('2. Perturbation 1: null/⊤ read as permissive...');
const original = readFileSync(SHARED_SRC, 'utf-8');
const perturbed1 = original.replace(
  'if (b === null) return true;',
  'if (a === null || b === null) return true; // PERTURBED1'
);
writeFileSync(SHARED_SRC, perturbed1);
rebuildShared();
assertMarkerInDist('PERTURBED1');

result = runTests();
if (result.passed && !result.failed) {
  console.error('BLIND: Tests passed with null-permissive defect. They do not discriminate.');
  writeFileSync(SHARED_SRC, original);
  process.exit(2);
}
console.log('✓ Perturbation 1 correctly FAILED\n');

// Restore
writeFileSync(SHARED_SRC, original);
rebuildShared();

// Perturbation 2: Invert subset test (should fail different tests)
console.log('3. Perturbation 2: subset test inverted...');
const perturbed2 = original.replace(
  'return a.every(s => b.includes(s));',
  'return !a.every(s => b.includes(s)); // PERTURBED2'
);
writeFileSync(SHARED_SRC, perturbed2);
rebuildShared();
assertMarkerInDist('PERTURBED2');

result = runTests();
if (result.passed && !result.failed) {
  console.error('BLIND: Tests passed with inverted subset. They do not discriminate.');
  writeFileSync(SHARED_SRC, original);
  process.exit(2);
}
console.log('✓ Perturbation 2 correctly FAILED\n');

// Restore and final pass
writeFileSync(SHARED_SRC, original);
rebuildShared();
result = runTests();
if (!result.passed) {
  console.error('FAIL: Tests failed after restore. The control broke something.');
  process.exit(1);
}

console.log('✓ All perturbations detected, restore PASS');
console.log('\n=== CONTROL PASS ===');
process.exit(0);
