#!/usr/bin/env node
// tra2613-auth-secret-check1-grade.mjs — TRA-2613 (implementation child of TRA-2403)
//
// Discrimination suite for CHECK 1 of scripts/tra2296-auth-secret-check.mjs: the live
// AUTH_SECRET *value* read.
//
// THE DEFECT THIS GRADES. Check 1 used to read `authVar.value ?? ''`, which collapses
// "the API returned an AUTH_SECRET row with no `value` key" into "the value is the empty
// string" — and then printed `present but EMPTY` and exited 1 FAIL. That is a confident,
// specific claim about the secret made out of a read failure. `authSecretGateState` in
// render-redeploy.mjs already decided this (`'value' in row` ⇒ BLIND); TRA-2613 ports the
// decision so the two scripts cannot disagree about what an unreadable value means.
//
// WHY THE SUITE HAS TO BE TWO-SIDED. A one-sided suite — "the missing-key arm exits 3" —
// passes a script JAMMED AT BLIND, which reads green while the instrument is useless. Every
// arm below therefore asserts BOTH the exit code AND a content anchor in the message, and
// the refusing arms (exit 1) are load-bearing: they are what proves the script still grades.
//
// The subject is the REAL script's main(), spawned end-to-end against the TRA-2387 Render
// API stub — not an extracted predicate. TRA-2387's own subject was a correct predicate that
// nothing invoked; grading a predicate here would reproduce that failure one level up.
// In every arm check 1 exits BEFORE the script reaches /deploys, /owners, /logs or
// pullBootSet, so the stub needs no extension.
//
//   node scripts/tra2613-auth-secret-check1-grade.mjs
//   exit 0 = every arm passed · 1 = an arm failed
//
// Offline by construction: the stub replaces globalThis.fetch and refuses every POST, and
// RENDER_API_KEY is a dummy string that never reaches a real host.

import { spawnSync } from 'node:child_process';
// ⛔ fileURLToPath, never `new URL(...).pathname` — on Windows that yields "/C:/Users/…",
// which spawn cannot resolve and fails as `status: null`, i.e. it looks exactly like "the
// script crashed" rather than "the path was malformed". (Same note as TRA-2387's suite.)
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./tra2296-auth-secret-check.mjs', import.meta.url));
const STUB = new URL('./lib/tra2387-render-api-stub.mjs', import.meta.url).href;
const CWD = fileURLToPath(new URL('..', import.meta.url));

const SERVICE = { id: 'srv-stub', name: 'stub-service', branch: 'main' };
const REAL_LOOKING_SECRET = 'k7Qp2xR9vL4mN8sT1wY6zB3cD5eF0gH2'; // 32 chars, not a credential

// `--since` is passed on every arm so that a run which gets PAST check 1 does not go on to
// read /deploys (unstubbed). It changes nothing about check 1 itself, which runs first.
const SINCE = '--since=2026-01-01T00:00:00.000Z';

// A page of filler rows, used only by the truncation arm. 100 rows == the limit the script
// asks for, which is the shape it cannot prove it reached the end of.
const fillerPage = n => Array.from({ length: n }, (_, i) => ({ key: `FILLER_${i}`, value: 'x' }));

const ARMS = [
  {
    name: 'row present, NO `value` key — the TRA-2403 defect',
    envVars: [{ key: 'PORT', value: '4000' }, { key: 'AUTH_SECRET' }],
    code: 3,
    has: ['BLIND', 'no `value` key', 'NOT READ'],
    hasNot: ['present but EMPTY'],
    why: 'the value was not read; saying EMPTY here is a false claim about the secret',
  },
  {
    name: 'row present, value is null — not gradeable by a string predicate',
    envVars: [{ key: 'AUTH_SECRET', value: null }],
    code: 3,
    has: ['BLIND', 'null', 'not a string'],
    hasNot: ['present but EMPTY'],
    why: 'same collapse via a different shape — `null ?? ""` used to read as EMPTY too',
  },
  {
    name: 'WHITESPACE-ONLY value — THE arm that proves the script is not jammed at BLIND',
    envVars: [{ key: 'AUTH_SECRET', value: ' ' }],
    code: 1,
    has: ['FAIL', 'AUTH_SECRET'],
    hasNot: ['BLIND'],
    why: 'resolveAuthSecret() trims, so " " is unset in prod — this must still be a graded FAIL',
  },
  {
    name: 'genuinely BLANK value — the literal bqb1 P1 state',
    envVars: [{ key: 'AUTH_SECRET', value: '' }],
    code: 1,
    has: ['FAIL', 'AUTH_SECRET'],
    hasNot: ['BLIND'],
    why: 'the read succeeded and the value really is empty; EMPTY is a true statement here',
  },
  {
    name: 'no AUTH_SECRET row at all, short page — a provable absence',
    envVars: [{ key: 'PORT', value: '4000' }, { key: 'DATA_DIR', value: '/data' }],
    code: 1,
    has: ['FAIL', 'AUTH_SECRET'],
    hasNot: ['BLIND'],
    why: 'unchanged from before TRA-2613 — classifyAuthSecret(null); the list was not capped',
  },
  {
    name: 'no AUTH_SECRET row, FULL page — a capped enumeration cannot prove an absence',
    envVars: fillerPage(100),
    code: 3,
    has: ['BLIND', 'pagination'],
    hasNot: ['FAIL —'],
    why: 'the optional truncation half, taken: same disease as the missing-key case, one row over',
  },
  {
    name: 'a usable value FLOWS PAST check 1 — the gate is not jammed shut',
    envVars: [{ key: 'AUTH_SECRET', value: REAL_LOOKING_SECRET }],
    // ⛔ Assert on the `env AUTH_SECRET :` line and on the ABSENCE of a verdict, NOT on the
    // exit code. Past check 1 the run dies on the unstubbed /owners request, and that crash
    // also exits 1 — the same code as a genuine refusal, so the exit code cannot separate
    // "check 1 passed it through" from "check 1 failed it". `finish()` is the only thing that
    // prints `VERDICT:`, so no VERDICT line == check 1 never terminated the run. (The line
    // reads `present, length 32`, not `[SET]` — the script deliberately suppresses the shape
    // suffix on a usable value, so anchoring on the literal word SET would fail a correct run.)
    has: ['env AUTH_SECRET : present, length 32'],
    hasNot: ['VERDICT:', 'BLIND —', 'FAIL —'],
    why: 'a suite with no passing arm cannot tell a working check from one that refuses everything',
  },
  {
    name: 'the env-var READ ITSELF fails (500) — pre-existing BLIND, must not regress',
    envVars: null,
    envVarsStatus: 500,
    code: 3,
    has: ['BLIND', 'cannot read env vars'],
    hasNot: ['present but EMPTY'],
    why: 'line 83 already routed this correctly; the port must not disturb it',
  },
];

let failed = 0;
console.log('TRA-2613 — check 1 of tra2296-auth-secret-check.mjs, stubbed Render API, offline.\n');

for (const arm of ARMS) {
  const stub = { service: SERVICE, envVars: arm.envVars, envVarsStatus: arm.envVarsStatus };
  const r = spawnSync(process.execPath, ['--import', STUB, SCRIPT, SINCE, `--service=${SERVICE.id}`], {
    cwd: CWD,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      RENDER_API_KEY: 'stub-key-not-a-real-credential',
      TRA2387_STUB: JSON.stringify(stub),
    },
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const problems = [];
  if (r.error) problems.push(`spawn error: ${r.error.message}`);
  if (arm.code !== undefined && r.status !== arm.code) problems.push(`exit ${r.status}, expected ${arm.code}`);
  if (arm.codeNot !== undefined && r.status === arm.codeNot) problems.push(`exit ${r.status}, expected anything but ${arm.codeNot}`);
  for (const s of arm.has ?? []) if (!text.includes(s)) problems.push(`message is missing ${JSON.stringify(s)}`);
  for (const s of arm.hasNot ?? []) if (text.includes(s)) problems.push(`message must NOT contain ${JSON.stringify(s)}`);

  if (problems.length) {
    failed += 1;
    console.log(`✗ ${arm.name}`);
    console.log(`    why it matters: ${arm.why}`);
    for (const p of problems) console.log(`    ${p}`);
    console.log(`    --- observed (exit ${r.status}) ---`);
    for (const line of text.trim().split('\n').slice(-8)) console.log(`    | ${line}`);
  } else {
    const verdict = (text.match(/^VERDICT: (.*)$/m)?.[1] ?? text.trim().split('\n').pop() ?? '').slice(0, 96);
    console.log(`✓ exit ${String(r.status).padStart(2)}  ${arm.name}`);
    console.log(`          ${verdict}`);
  }
}

console.log('');
if (failed) {
  console.log(`FAIL — ${failed}/${ARMS.length} arm(s) failed.`);
  process.exit(1);
}
console.log(`PASS — ${ARMS.length}/${ARMS.length} arms. Unreadable ⇒ BLIND(3); unusable-but-read ⇒ FAIL(1); usable ⇒ flows past check 1.`);
