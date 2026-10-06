#!/usr/bin/env node
// tra5180-deploy-post-body-check.mjs — TRA-5180
//
// Discrimination suite for the deploy-POST RESPONSE handling in render-redeploy.mjs.
//
// THE DEFECT. `api()` unconditionally `JSON.parse`d the response body. On 2026-10-05T20:06Z
// the TRA-5175 deploy POST succeeded — Render's history shows dep-db206j569bns73dppih0,
// commit cd053d3c, trigger `api`, created by that invocation — but the 2xx response came
// back EMPTY, the parse threw, and the script exited 2: the REFUSAL family, whose documented
// remedy is "fix the arguments and re-run". A re-run is a SECOND real deploy of the money
// host. The only thing that stopped a double-deploy was the operator reading the deploy
// history by hand before retrying.
//
// THE RULE UNDER TEST: "deploy created, confirmation lost" and "deploy refused" must never
// share an exit code (the BROKEN-vs-BLIND separation, again). Concretely:
//   · 2xx + parseable body            → exit 0, deploy line printed        (CONFIRMED)
//   · 2xx + empty body, history MATCH → exit 0, confirmed from the history (CONFIRMED late)
//   · 2xx + empty body, no match/read → exit EXIT_TRIGGERED_UNCONFIRMED (11), NOT 2
//   · non-2xx (empty body or not)     → exit 2, says Render REFUSED and no deploy exists
//
// ⛔ WHY THE LOAD-BEARING ARMS SPAWN THE SHIPPED BYTES. The incident was not a wrong
// predicate — it was main()'s call site doing no classification at all. A table-only suite
// over classifyDeployPostResponse() stays green if somebody re-inlines `await api(...)` at
// the POST, which is the exact regression this guards against (TRA-2262: verify the EDGE).
//
// ⛔ WHY THOSE SPAWNS CANNOT DEPLOY. Every case is preloaded with
// lib/tra2387-render-api-stub.mjs, which replaces globalThis.fetch wholesale — nothing
// reaches a network under any config. The TRA-5180 `deployPost` stub key serves a canned
// LOCAL Response for the deploy POST route only; absent that key every POST still throws.
//
//   node scripts/tra5180-deploy-post-body-check.mjs
//   exit 0 = all arms pass · 1 = an arm failed
//
// Gate on the VERDICT banner, not only the exit code: this runner's own failure exit (1) is
// not any of the exit codes under test, but a wrapper that swallows codes still reads text.

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EXIT_TRIGGERED_UNCONFIRMED,
  UNCONFIRMED_MATCH_WINDOW_MS,
  classifyDeployPostResponse,
  confirmDeployAgainstHistory,
  renderUsage,
} from './render-redeploy.mjs';

const SCRIPT = fileURLToPath(new URL('./render-redeploy.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STUB = new URL('./lib/tra2387-render-api-stub.mjs', import.meta.url).href;

// Same non-soak fixture as tra4420's PROCEED arms, for the same reason: on bqb1 the
// freeze/embargo/rollback/cadence gates would refuse for reasons three layers downstream of
// the response handling under test. The POST path is host-agnostic.
const OTHER = { id: 'srv-someothersvc', name: 'tradingai-scratch', slug: 'tradingai-scratch', branch: 'main' };
const NO_SUCH_SHA = '0000000000000000000000000000000000000000';
const OTHER_SHA = 'ffffffffffffffffffffffffffffffffffffffff';
const ENV_OK = [{ key: 'PORT', value: '4000' }, { key: 'AUTH_SECRET', value: 'a-real-secret-value' }];

const historyRow = (sha, createdAt = new Date().toISOString()) => [
  { deploy: { id: 'dep-ctl-5180', status: 'queued', createdAt, commit: { id: sha } }, cursor: 'c1' },
];

const failures = [];
const check = (why, cond, detail = '') => {
  if (cond) {
    console.log(`  ok   ${why}`);
  } else {
    failures.push(why);
    console.log(`  FAIL ${why}${detail ? `\n         ${detail}` : ''}`);
  }
};

// ── Arm 0: THE NEGATIVE CONTROL — do the PRE-FIX bytes still bite? ───────────
// af6f5cba is the last rev whose api() parsed unconditionally. Against the SAME stub config
// the fixed bytes pass with, it must still die in JSON.parse and exit 2 — the incident. If
// it stops biting, every green below is evidence about nothing (TRA-1787).
const PRE_FIX_REV = 'af6f5cba';
const PRE_FIX_PATH = fileURLToPath(new URL('./.tra5180-prefix.tmp.mjs', import.meta.url));

const runScript = (scriptPath, stubCfg, extraArgs = []) =>
  spawnSync(
    process.execPath,
    ['--import', STUB, scriptPath, `--commit=${NO_SUCH_SHA}`, ...extraArgs],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        RENDER_API_KEY: 'stub-key-not-a-real-credential',
        RENDER_SERVICE_ID: OTHER.id,
        TRA2387_STUB: JSON.stringify({ service: OTHER, envVars: ENV_OK, ...stubCfg }),
      },
    },
  );

console.log(`arm 0 — negative control: the PRE-FIX bytes (${PRE_FIX_REV}) exit 2 on an empty 2xx — the incident:`);
{
  const show = spawnSync('git', ['show', `${PRE_FIX_REV}:scripts/render-redeploy.mjs`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (show.status !== 0 || !show.stdout) {
    // ⛔ Not a pass: "could not check" must never read as "checked and it is fine".
    check(`read ${PRE_FIX_REV}:scripts/render-redeploy.mjs from this checkout`, false, 'git show failed (shallow clone?)');
  } else {
    try {
      writeFileSync(PRE_FIX_PATH, show.stdout);
      const pre = runScript(PRE_FIX_PATH, { deployPost: { status: 201, body: '' }, deploys: historyRow(NO_SUCH_SHA) });
      check(
        'pre-fix bytes exit 2 with the JSON.parse stack on an ACCEPTED empty-body POST',
        pre.status === 2 && /Unexpected end of JSON input/.test(pre.stderr ?? ''),
        `exit ${pre.status}; stderr[0]: ${(pre.stderr ?? '').split('\n')[0]}`,
      );
    } finally {
      rmSync(PRE_FIX_PATH, { force: true });
    }
  }
}

// ── Arm 1: the pure classifier — the ticket's three controls, plus the edges ─
console.log('');
console.log('arm 1 — classifyDeployPostResponse / confirmDeployAgainstHistory (pure, no spawn):');
{
  const a = classifyDeployPostResponse({ ok: true, status: 201, bodyText: '' });
  check('empty-body-on-201 → CREATED_UNCONFIRMED', a.kind === 'CREATED_UNCONFIRMED' && /201/.test(a.why), JSON.stringify(a));

  const b = classifyDeployPostResponse({ ok: false, status: 500, statusText: 'Internal Server Error', bodyText: '' });
  check('empty-body-on-500 → REFUSED, status in the detail', b.kind === 'REFUSED' && /500/.test(b.detail), JSON.stringify(b));

  const c = classifyDeployPostResponse({
    ok: true,
    status: 201,
    bodyText: JSON.stringify({ deploy: { id: 'dep-x', status: 'queued' } }),
  });
  check('valid JSON on 201 → CONFIRMED (the current path)', c.kind === 'CONFIRMED' && c.json?.deploy?.id === 'dep-x', JSON.stringify(c));

  const d = classifyDeployPostResponse({ ok: true, status: 200, bodyText: '<html>gateway</html>' });
  check('unparseable 2xx body → CREATED_UNCONFIRMED, never a throw', d.kind === 'CREATED_UNCONFIRMED', JSON.stringify(d));

  const now = Date.now();
  const m1 = confirmDeployAgainstHistory(historyRow(NO_SUCH_SHA, new Date(now - 30_000).toISOString()), NO_SUCH_SHA, now);
  check('history: newest row matches sha inside the window → confirmed', m1.confirmed === true && m1.row.id === 'dep-ctl-5180', JSON.stringify(m1));

  const m2 = confirmDeployAgainstHistory(historyRow(OTHER_SHA), NO_SUCH_SHA, now);
  check('history: newest row carries a DIFFERENT commit → not confirmed', m2.confirmed === false && /not the requested/.test(m2.why), JSON.stringify(m2));

  const m3 = confirmDeployAgainstHistory(
    historyRow(NO_SUCH_SHA, new Date(now - UNCONFIRMED_MATCH_WINDOW_MS - 60_000).toISOString()),
    NO_SUCH_SHA,
    now,
  );
  check('history: matching sha but OUTSIDE the window (an earlier same-SHA deploy) → not confirmed', m3.confirmed === false && /EARLIER/.test(m3.why), JSON.stringify(m3));

  const m4 = confirmDeployAgainstHistory([], NO_SUCH_SHA, now);
  check('history: zero rows → not confirmed, says so', m4.confirmed === false && /no rows/.test(m4.why), JSON.stringify(m4));

  const m5 = confirmDeployAgainstHistory(historyRow(NO_SUCH_SHA), null, now);
  check('history: unresolved target sha → not confirmed (never a vacuous match)', m5.confirmed === false, JSON.stringify(m5));
}

// ── Arm 2: the SHIPPED BYTES, end-to-end through the stub ────────────────────
console.log('');
console.log('arm 2 — the shipped bytes: POST response → exit code, offline via the deployPost stub key:');
{
  // The incident shape, repaired: accepted empty body, history names this very deploy.
  const r1 = runScript(SCRIPT, { deployPost: { status: 201, body: '' }, deploys: historyRow(NO_SUCH_SHA) });
  check(
    'empty 201 + matching history → exit 0, confirmed from the deploy history, re-run warning printed',
    r1.status === 0 &&
      /confirmed from the deploy history/.test(r1.stdout ?? '') &&
      /DO NOT RE-RUN/.test(r1.stderr ?? ''),
    `exit ${r1.status}; stdout tail: ${(r1.stdout ?? '').trim().split('\n').pop()}; stderr[0]: ${(r1.stderr ?? '').split('\n')[0]}`,
  );

  // Accepted empty body, history shows someone ELSE's deploy newest → 11, never 2, never 0.
  const r2 = runScript(SCRIPT, { deployPost: { status: 201, body: '' }, deploys: historyRow(OTHER_SHA) });
  check(
    `empty 201 + mismatched history → exit ${EXIT_TRIGGERED_UNCONFIRMED} TRIGGERED-UNCONFIRMED`,
    r2.status === EXIT_TRIGGERED_UNCONFIRMED && /TRIGGERED-UNCONFIRMED/.test(r2.stderr ?? ''),
    `exit ${r2.status}; stderr[0]: ${(r2.stderr ?? '').split('\n')[0]}`,
  );

  // Accepted empty body, the confirmation READ fails → still 11. An unreadable history must
  // not demote "a deploy probably exists" back into the refusal family.
  const r3 = runScript(SCRIPT, { deployPost: { status: 201, body: '' }, deploys: null, deploysStatus: 503 });
  check(
    `empty 201 + unreadable history → exit ${EXIT_TRIGGERED_UNCONFIRMED}, never 2`,
    r3.status === EXIT_TRIGGERED_UNCONFIRMED && /TRIGGERED-UNCONFIRMED/.test(r3.stderr ?? ''),
    `exit ${r3.status}; stderr[0]: ${(r3.stderr ?? '').split('\n')[0]}`,
  );

  // Non-2xx with an empty body STAYS a refusal, with the HTTP status printed.
  const r4 = runScript(SCRIPT, { deployPost: { status: 500, body: '' } });
  check(
    'empty 500 → exit 2, says Render REFUSED with the status, no unconfirmed language',
    r4.status === 2 &&
      /→ 500/.test(r4.stderr ?? '') &&
      /REFUSED the request/.test(r4.stderr ?? '') &&
      !/TRIGGERED-UNCONFIRMED/.test(r4.stderr ?? ''),
    `exit ${r4.status}; stderr[0]: ${(r4.stderr ?? '').split('\n')[0]}`,
  );

  // The current/normal path: a parseable body still prints the deploy line and exits 0.
  const r5 = runScript(SCRIPT, {
    deployPost: { status: 201, body: JSON.stringify({ deploy: { id: 'dep-ctl-5180', status: 'queued' } }) },
  });
  check(
    'valid JSON 201 → exit 0, deploy line from the RESPONSE, no history fallback used',
    r5.status === 0 &&
      /deploy  : dep-ctl-5180 — queued/.test(r5.stdout ?? '') &&
      !/confirmed from the deploy history/.test(r5.stdout ?? ''),
    `exit ${r5.status}; stdout tail: ${(r5.stdout ?? '').trim().split('\n').pop()}`,
  );
}

// ── Arm 3: the contract — codes distinct, usage says what 11 means ───────────
console.log('');
console.log('arm 3 — the exit-code contract and the usage text:');
{
  const documented = [0, 2, 4, 5, 6, 7, 8, 9, 10];
  check(
    `EXIT_TRIGGERED_UNCONFIRMED (${EXIT_TRIGGERED_UNCONFIRMED}) collides with no refusal/usage code`,
    !documented.includes(EXIT_TRIGGERED_UNCONFIRMED),
  );
  const usage = renderUsage();
  check('usage documents exit 11 as TRIGGERED-UNCONFIRMED', /11 {2}TRIGGERED-UNCONFIRMED/.test(usage));
  check('usage carries the re-run guard (read the history before any retry)', /Do NOT re-run on exit 11/.test(usage));
}

console.log('');
if (failures.length === 0) {
  console.log('[tra5180] VERDICT: PASS — refused (2), confirmed (0) and triggered-unconfirmed (11) are three different answers.');
  process.exit(0);
} else {
  console.error(`[tra5180] VERDICT: FAIL — ${failures.length} arm(s): ${failures.join(' · ')}`);
  process.exit(1);
}
