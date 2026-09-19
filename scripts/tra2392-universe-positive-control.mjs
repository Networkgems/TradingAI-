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
const STORE_SRC = 'packages/server/src/promotion-store.ts';
const STORE_DIST = 'packages/server/dist/promotion-store.js';

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', ...opts });
  } catch (e) {
    return e.stdout;
  }
}

// TRA-4648 — grade via vitest in packages/server directly, NOT the root
// `npm test`: the root pretest chain runs repo-wide selftests that can be (and
// on 2026-09-17 are, TRA-3744/calendar-coverage) red on code this control never
// touches, which fails the baseline and makes the control ungradeable.
function runPromotionTests(file) {
  return exec(`npx vitest run ${file}`, { cwd: 'packages/server' });
}

function rebuildShared() {
  console.log('Rebuilding @trading-app/shared with --force...');
  execSync('npx tsc -b packages/shared --force', { stdio: 'inherit' });
}

function rebuildServer() {
  console.log('Rebuilding @trading-app/server with --force...');
  execSync('npx tsc -b packages/server --force', { stdio: 'inherit' });
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
  const out = runPromotionTests('promotion-universe.test');
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

// Restore and re-test
writeFileSync(SHARED_SRC, original);
rebuildShared();
result = runTests();
if (!result.passed) {
  console.error('FAIL: Tests failed after restore. The control broke something.');
  process.exit(1);
}
console.log('✓ Perturbations 1-2 detected, restore PASS\n');

// Perturbation 3 (RETIRED with TRA-4629): the G conjunct in the crypto
// widening gate (`if (isRatified && isCoveredByG)` in promotion-service.ts)
// was deleted together with the whole crypto axis of the promotion gate —
// there is no crypto universe left to widen, which subsumes the refusal the
// conjunct encoded. The surviving direction-1 surface is the STORE (E has one
// writer, G ⊆ E before the append), graded by perturbations 4-5 below.
console.log('4. Perturbation 3 retired with the crypto axis (TRA-4629) — skipping\n');

// Perturbation 4 (TRA-4648): remove the record-E fallback in recordSignoff, so
// G ⊆ E is once again gated only on the SAME-CALL evidenceUniverse — the exact
// defect TRA-4648 measured (omit E ⇒ arbitrary grant accepted ⇒ canary→majors
// allowed on BTC-only evidence). The AC1 test must go red: with the fallback
// gone, an omitted-E grant hits the fail-closed refusal (a DIFFERENT message
// than the subset refusal the test asserts) and the omitted-both default lands
// G=undefined instead of the record E.
console.log('5. Perturbation 4: record-E fallback removed (same-call E only)...');
const storeOriginal = readFileSync(STORE_SRC, 'utf-8');
// TRA-4690 — post-fix, E is read from the record ONLY; this is the line both
// store perturbations anchor on.
const FALLBACK_LINE =
  'const evidenceUniverse = rec.backtest?.evidenceUniverse ?? undefined;';
if (!storeOriginal.includes(FALLBACK_LINE)) {
  console.error('BLIND: the record-E line was not found in promotion-store.ts.');
  console.error('The control no longer matches the code — fix the control, not the tests.');
  process.exit(2);
}
const perturbed4 = storeOriginal.replace(
  FALLBACK_LINE,
  'const evidenceUniverse = args.evidenceUniverse ?? undefined; // PERTURBED4 - record-E fallback removed'
);
writeFileSync(STORE_SRC, perturbed4);
rebuildServer();
const storeDist = readFileSync(STORE_DIST, 'utf-8');
if (!storeDist.includes('PERTURBED4')) {
  console.error(`BLIND: marker "PERTURBED4" not found in ${STORE_DIST}`);
  console.error('The perturbation did not reach dist. Tests are grading the old code.');
  writeFileSync(STORE_SRC, storeOriginal);
  process.exit(2);
}
console.log('✓ Marker "PERTURBED4" found in dist');

result = runTests();
if (result.passed && !result.failed) {
  console.error('BLIND: Tests passed with the record-E fallback removed. They do not discriminate.');
  writeFileSync(STORE_SRC, storeOriginal);
  process.exit(2);
}
console.log('✓ Perturbation 4 correctly FAILED\n');

// Restore store before perturbation 5
writeFileSync(STORE_SRC, storeOriginal);
rebuildServer();

// Perturbation 5 (TRA-4690): restore call-E precedence over the record — the
// exact measured defect. Two coupled replacements: (a) disable the supplied-E
// refusal guard, (b) make `args.evidenceUniverse` win over the Stage-1 record
// again (`args.evidenceUniverse ?? rec...`). The TRA-4690 test must go red:
// the wide-E sign-off is ACCEPTED instead of refused, the real gate reads
// canary→majors allowed=true off the wide grant, and the latest decision's E
// records evidence Stage 1 never produced.
console.log('6. Perturbation 5: call-E precedence restored (supplied E overrides the record)...');
const GUARD_LINE = 'if (args.evidenceUniverse !== undefined) {';
if (!storeOriginal.includes(GUARD_LINE)) {
  console.error('BLIND: the supplied-E refusal guard was not found in promotion-store.ts.');
  console.error('The control no longer matches the code — fix the control, not the tests.');
  process.exit(2);
}
const perturbed5 = storeOriginal
  .replace(GUARD_LINE, 'if (false) { // PERTURBED5 - supplied-E refusal disabled')
  .replace(
    FALLBACK_LINE,
    'const evidenceUniverse = args.evidenceUniverse ?? rec.backtest?.evidenceUniverse ?? undefined; // PERTURBED5 - call-E precedence restored'
  );
writeFileSync(STORE_SRC, perturbed5);
rebuildServer();
const storeDist5 = readFileSync(STORE_DIST, 'utf-8');
if (!storeDist5.includes('PERTURBED5')) {
  console.error(`BLIND: marker "PERTURBED5" not found in ${STORE_DIST}`);
  console.error('The perturbation did not reach dist. Tests are grading the old code.');
  writeFileSync(STORE_SRC, storeOriginal);
  process.exit(2);
}
console.log('✓ Marker "PERTURBED5" found in dist');

result = runTests();
if (result.passed && !result.failed) {
  console.error('BLIND: Tests passed with call-E precedence restored. They do not discriminate.');
  writeFileSync(STORE_SRC, storeOriginal);
  process.exit(2);
}
console.log('✓ Perturbation 5 correctly FAILED\n');

// Final restore and pass
writeFileSync(STORE_SRC, storeOriginal);
rebuildServer();
const finalResult = runPromotionTests('promotion-service.test');
if (!finalResult.includes('passed')) {
  console.error('FAIL: Tests failed after final restore. The control broke something.');
  process.exit(1);
}

console.log('✓ All perturbations detected, all restores PASS');
console.log('\n=== CONTROL PASS ===');
process.exit(0);
