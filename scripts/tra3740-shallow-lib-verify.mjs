#!/usr/bin/env node
// tra3740-shallow-lib-verify.mjs — Direct test of the shallow-ancestry lib (TRA-3740)
//
// Verifies that scripts/lib/shallow-ancestry.mjs properly detects shallow grafts and returns
// `answer: null` (blind) instead of `false` (confident negative). This is the canonical remedy
// all 5 fixed call sites now use.
//
// ARM 0: graft fidelity (both objects present, path cut, rc=1)
// ARM 1: grafted clone → gradedAncestry returns answer=null (AC1)
// ARM 2: complete clone → gradedAncestry returns answer=true (AC2 - both directions)
//
//   node scripts/tra3740-shallow-lib-verify.mjs [--keep]
//   exit 0 = all arms pass · 1 = a failure · 2 = cannot build repro

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  REPO_ROOT,
  pickPair,
  buildGraft,
  graftDetail,
  stageScripts,
  ANCESTRY_LIB,
} from './lib/shallow-graft-repro.mjs';

const KEEP = process.argv.includes('--keep');

const bail = msg => {
  console.error(`[tra3740-lib] CANNOT RUN: ${msg}`);
  process.exit(2);
};

const results = [];
const arm = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`       ${detail}`);
};

const node = (args, cwd) =>
  spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 30_000 });

// ── ARM 0: Build and verify the graft ───────────────────────────────────────
console.log('[tra3740-lib] ARM 0 — graft fidelity');
const { target, held } = pickPair({ depth: 50 });
const root = mkdtempSync(join(tmpdir(), 'tra3740-lib-'));
const { graft, facts } = buildGraft(root, { target, held });

console.log(`  graft: ${graft}`);
console.log(`  ${graftDetail(facts)}`);

if (!facts.faithful) {
  bail(`graft not faithful. ${graftDetail(facts)}`);
}
arm('graft-faithful', true, graftDetail(facts));

// ── ARM 1: Grafted clone → answer=null (BLIND) ──────────────────────────────
console.log('\n[tra3740-lib] ARM 1 — grafted clone: gradedAncestry must return null');
stageScripts(graft, ANCESTRY_LIB);

const testGrafted = `
import { gradedAncestry } from './scripts/lib/shallow-ancestry.mjs';
const result = gradedAncestry('${held}', '${target}');
console.log(JSON.stringify(result));
`;
writeFileSync(join(graft, 'test-grafted.mjs'), testGrafted);
const rGrafted = node(['test-grafted.mjs'], graft);

if (rGrafted.status !== 0) {
  arm('grafted-exec', false, `exit ${rGrafted.status}: ${rGrafted.stderr}`);
} else {
  try {
    const result = JSON.parse(rGrafted.stdout.trim());
    const ok = result.answer === null && result.verdict.startsWith('blind-');
    arm('grafted-answer-null', ok,
      `answer=${result.answer}, verdict=${result.verdict} (expect answer=null, verdict=blind-*)`);
  } catch (e) {
    arm('grafted-parse', false, `could not parse: ${rGrafted.stdout}`);
  }
}

// ── ARM 2: Complete clone → answer=true (healthy path still works) ──────────
console.log('\n[tra3740-lib] ARM 2 — complete clone: must still answer true');

const testComplete = `
import { gradedAncestry } from './scripts/lib/shallow-ancestry.mjs';
const result = gradedAncestry('${held}', '${target}');
console.log(JSON.stringify(result));
`;
writeFileSync(join(REPO_ROOT, 'test-complete.mjs'), testComplete);
const rComplete = node(['test-complete.mjs'], REPO_ROOT);

if (rComplete.status !== 0) {
  arm('complete-exec', false, `exit ${rComplete.status}: ${rComplete.stderr}`);
} else {
  try {
    const result = JSON.parse(rComplete.stdout.trim());
    const ok = result.answer === true && result.verdict === 'carries';
    arm('complete-answer-true', ok,
      `answer=${result.answer}, verdict=${result.verdict} (expect answer=true, verdict=carries)`);
  } catch (e) {
    arm('complete-parse', false, `could not parse: ${rComplete.stdout}`);
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
if (!KEEP) {
  rmSync(root, { recursive: true, force: true });
  console.log(`\n[tra3740-lib] cleaned ${root}`);
} else {
  console.log(`\n[tra3740-lib] keeping ${root} (--keep)`);
}

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n[tra3740-lib] ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\nFailed arms:');
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  - ${r.name}: ${r.detail}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
