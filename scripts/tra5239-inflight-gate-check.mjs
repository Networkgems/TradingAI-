#!/usr/bin/env node
// tra5239-inflight-gate-check.mjs — TRA-5239
//
// Discrimination suite for the IN-FLIGHT deploy gate (render-redeploy.mjs exit 12).
//
// THE DEFECT. 2026-10-07 00:31/00:43/00:44Z, three deploys through this very script, every gate
// green, no override: c3a2d337 (live) -> 365d94ec (tip, +7 commits) -> a SAME-SHA c3a2d337
// env-apply created 37s after it. Had the duplicate booted last, bqb1 would have rolled back 7
// commits with --allow-rollback never consulted. Gate 4 grades a target against what is serving
// at gate time, and at 00:44:06Z c3a2d337 WAS serving, so no per-deploy predicate can see it.
// Render happened to cancel the duplicate; that is not a gate we own.
//
// Arms: (1) REPLAY of the real triple, (2) PAIRS one variable apart, (3) the CALL SITE — the
// shipped main() spawned under the read-only Render stub (a predicate suite stays green if
// main() stops calling the gate; TRA-2262).
//
//   node scripts/tra5239-inflight-gate-check.mjs     exit 0 = all arms pass · 1 = an arm failed

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflightState, inflightBlocks, inflightOverrideNamesTicket } from './render-redeploy.mjs';

const SCRIPT = fileURLToPath(new URL('./render-redeploy.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const STUB = new URL('./lib/tra2387-render-api-stub.mjs', import.meta.url).href;

let failed = 0;
const reached = new Set();
const arm = (cls, label, ok, detail = '') => {
  reached.add(cls);
  if (ok) console.log(`  ok   ${cls.padEnd(8)} ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL ${cls.padEnd(8)} ${label}${detail ? `\n         ${detail}` : ''}`);
  }
};

// Render's list shape: { deploy, cursor }. Ids, times and 12-char shas are the real 10-07 rows.
const entry = (id, commit, status, createdAt) => ({ deploy: { id, commit: { id: commit }, status, createdAt }, cursor: id });
const D1 = (status = 'live') => entry('dep-db2p5snlk1mc7387ue50', 'c3a2d337c20b', status, '2026-10-07T00:31:46.530Z');
const D2 = status => entry('dep-db2pbccs728c73a563ng', '365d94ec7ded', status, '2026-10-07T00:43:29.725Z');
const D3 = status => entry('dep-db2pblk8ig0s73fcu5b0', 'c3a2d337c20b', status, '2026-10-07T00:44:06.537Z');

const verdict = rows => inflightState({ history: { rows } }).verdict;

// ── 1. REPLAY ─────────────────────────────────────────────────────────────────────────────
// History as it stood at each instant.
arm('clear', '00:43:29Z — only D1 (live) exists: the tip deploy is free to go', verdict([D1()]) === 'CLEAR');
const at0044 = inflightState({ history: { rows: [D2('build_in_progress'), D1()] } });
arm('refuse', '00:44:06Z — D2 still building: the same-SHA duplicate is REFUSED, naming D2',
  at0044.verdict === 'IN_FLIGHT' && at0044.inflight.length === 1 && at0044.inflight[0].id === 'dep-db2pbccs728c73a563ng',
  JSON.stringify(at0044));
arm('clear', '00:46:41Z+ — D2 live, D1 deactivated: settled again, a deploy may proceed',
  verdict([D2('live'), D1('deactivated')]) === 'CLEAR');
arm('clear', 'D3 as recorded (canceled) is settled and does not wedge the gate',
  verdict([D3('canceled'), D2('live'), D1('deactivated')]) === 'CLEAR');

// ── 2. PAIRS ──────────────────────────────────────────────────────────────────────────────
for (const st of ['created', 'queued', 'build_in_progress', 'update_in_progress', 'pre_deploy_in_progress']) {
  arm('refuse', `status ${st} blocks`, verdict([D2(st), D1()]) === 'IN_FLIGHT');
}
arm('refuse', 'an UNRECOGNISED status blocks (fail closed, not waved through)', verdict([D2('some_future_state'), D1()]) === 'IN_FLIGHT');
arm('refuse', 'a row with no status blocks', verdict([{ deploy: { id: 'dep-x', createdAt: '2026-10-07T00:00:00Z' } }]) === 'IN_FLIGHT');
for (const st of ['live', 'deactivated', 'build_failed', 'update_failed', 'pre_deploy_failed', 'canceled']) {
  arm('clear', `status ${st} is settled`, verdict([D2(st)]) === 'CLEAR');
}
arm('blind', 'unreadable list is BLIND', inflightState({ history: { rows: null, error: 'GET 503' } }).verdict === 'BLIND');
arm('blind', 'missing history is BLIND', inflightState({ history: null }).verdict === 'BLIND');
arm('blind', 'BLIND blocks like IN_FLIGHT; CLEAR does not', inflightBlocks('BLIND') && inflightBlocks('IN_FLIGHT') && !inflightBlocks('CLEAR'));
arm('refuse', 'override must name a ticket', !inflightOverrideNamesTicket('because I said so') && inflightOverrideNamesTicket('TRA-5239 superseding'));

// ── 3. CALL SITE — the shipped main() under the read-only stub ────────────────────────────
const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
const BQB1 = { id: 'srv-d7mb7rr7uimc73ev0chg', name: 'TradingAI-', slug: 'tradingai-bqb1', branch: 'main' };
// The freeze/embargo overrides are inert unless those gates are live, so the arms grade the same
// thing at 15:00Z and 22:00Z. Same-SHA target (= live) is the sharp edge under test.
const QUIET = ['--force-embargo-override=TRA-5239 e2e control, POSTs nothing', '--force-rth-override=TRA-5239 e2e control, POSTs nothing'];
const spawnMain = (extra, deploysCfg) => {
  const r = spawnSync(process.execPath, ['--import', STUB, SCRIPT, `--commit=${HEAD}`, '--dry-run', ...QUIET, ...extra], {
    encoding: 'utf8',
    timeout: 90000,
    env: {
      ...process.env,
      RENDER_API_KEY: 'stub-key-not-a-real-credential',
      RENDER_SERVICE_ID: BQB1.id,
      TRA2387_STUB: JSON.stringify({
        service: BQB1,
        envVars: [{ key: 'PORT', value: '4000' }, { key: 'AUTH_SECRET', value: 'a-real-secret-value' }],
        health: { commit: HEAD, commitSource: 'git', startedAt: '2026-10-07T00:00:00.000Z' },
        ...deploysCfg,
      }),
    },
  });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const detail = r => `status=${r.status}\n${r.err.split('\n').slice(0, 6).join('\n')}`;
const reachedPost = r => /refusing to serve a POST/.test(r.err);

let r = spawnMain([], { deploys: [D2('build_in_progress'), D1()] });
arm('edge', 'EDGE: same-SHA env-apply with a deploy building ⇒ real main() exits 12',
  r.status === 12 && r.err.includes('IN FLIGHT') && r.err.includes('dep-db2pbccs728c73a563ng') && !reachedPost(r), detail(r));
r = spawnMain([], { deploys: [D2('live'), D1('deactivated')] });
arm('edge', 'EDGE: the same run with the deploy settled ⇒ exit 0, would POST',
  r.status === 0 && r.out.includes('no other deploy in flight') && r.out.includes('would POST'), detail(r));
r = spawnMain([], { deploys: null, deploysStatus: 503 });
arm('edge', 'EDGE: deploy list unreadable (503) ⇒ exit 12 BLIND',
  r.status === 12 && r.err.includes('BLIND') && r.err.includes('503'), detail(r));
r = spawnMain(['--force-concurrent-deploy=TRA-5239 e2e control, not a real deploy'], { deploys: [D2('build_in_progress'), D1()] });
arm('edge', 'EDGE: --force-concurrent-deploy="TRA-#### why" proceeds and is echoed',
  r.status === 0 && r.err.includes('OVERRIDING THE IN-FLIGHT GATE') && r.err.includes('TRA-5239 e2e control') && r.out.includes('OVERRIDDEN'), detail(r));
r = spawnMain(['--force-concurrent-deploy=because I said so'], { deploys: [D2('build_in_progress'), D1()] });
arm('edge', 'EDGE: override naming no ticket ⇒ exit 2', r.status === 2 && r.err.includes('NAME a ticket'), detail(r));

// ── wiring: the gate sits after the cadence gate and before the freeze, on the live path ──
const src = readFileSync(SCRIPT, 'utf8');
const i10 = src.indexOf('process.exit(10);');
const i12 = src.indexOf('process.exit(12);');
const i4 = src.indexOf('process.exit(4);');
arm('edge', 'source order: exit 10 < exit 12 < exit 4 (gate cannot be moved off the live path silently)',
  i10 > 0 && i12 > i10 && i4 > i12, `10@${i10} 12@${i12} 4@${i4}`);

for (const cls of ['refuse', 'clear', 'blind', 'edge']) {
  if (!reached.has(cls)) {
    console.log(`FAIL  arm class "${cls}" was never reached — the suite proves nothing`);
    failed += 1;
  }
}
console.log(failed ? `\n${failed} FAILED` : '\nall arms pass');
process.exit(failed ? 1 : 0);
