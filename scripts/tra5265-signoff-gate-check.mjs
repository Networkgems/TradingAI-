#!/usr/bin/env node
// tra5265-signoff-gate-check.mjs — TRA-5265
//
// Discrimination suite for the DEPLOY SIGN-OFF gate (render-redeploy.mjs exit 11).
//
// THE DEFECT. 2026-10-07 9abf167f (TRA-5118, "sign-off at deploy time") went live as the PARENT
// of an unrelated fix, 3m10s before the sign-off was posted. No gate asked whether anything in
// live..target had an unmet authorization.
//
// ⛔ A predicate-only suite stays green if somebody deletes the call site out of main() (TRA-2262:
// verify the EDGE, not the node). So the load-bearing arms SPAWN the shipped render-redeploy.mjs
// inside a throwaway shared clone whose ops/deploy-signoffs.json is the arm's fixture, preloaded
// with the read-only Render stub (it throws on any POST — a stubbed run cannot deploy).
// Every REFUSE arm has a PROCEED twin that differs only by the grant, and the suite FAILS if an
// arm class is never reached.
//
//   node scripts/tra5265-signoff-gate-check.mjs     exit 0 = all arms pass · 1 = an arm failed

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSignoffs, signoffState, signoffBlocks } from './lib/signoff-gate.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(REPO, 'scripts');
const STUB = new URL('./lib/tra2387-render-api-stub.mjs', import.meta.url).href;

// The 2026-10-07 incident, verbatim.
const PASSENGER = '9abf167f815eace4e09e59d07ef1afb3857b6e39';
const LIVE = '365d94ec7dedfa56437077350347a2a47dd1678e';
const TARGET = '1348fd28c08221c86217a2492384a7001535a6ba';
const REQ = { sha: PASSENGER, ticket: 'TRA-5260', why: 'TRA-5118 changes published totals' };
const GRANT = { sha: PASSENGER, ticket: 'TRA-5260', decision: 'approve', by: 'CEO', ref: 'c1', at: '2026-10-07T01:19:53Z' };
const doc = (requires, grants) => JSON.stringify({ requires, grants });

const git = (args, cwd = REPO) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const isAnc = (a, b) => {
  const r = git(['merge-base', '--is-ancestor', a, b]);
  return r.status === 0 ? true : r.status === 1 ? false : null;
};
const haveReplay = [PASSENGER, LIVE, TARGET].every(s => git(['cat-file', '-e', `${s}^{commit}`]).status === 0);

let failed = 0;
const reached = new Set();
function arm(cls, name, ok, detail = '') {
  reached.add(cls);
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${cls}] ${name}${ok ? '' : `\n      ${detail}`}`);
  if (!ok) failed++;
}

// ── predicate arms (real git ancestry over the real incident shas) ─────────────────────────
const ok = (requires, grants) => ({ verdict: 'OK', requires, grants, why: null });
if (haveReplay) {
  const st = (read, live = { sha: LIVE }) => signoffState(read, { target: { sha: TARGET }, live }, isAnc);
  let s = st(ok([REQ], []));
  arm('refuse', 'AC1/AC4 replay 365d94ec..1348fd28, 9abf167f unsigned → UNMET naming sha + ticket',
    s.verdict === 'UNMET' && s.unmet[0]?.sha === PASSENGER && s.unmet[0]?.ticket === 'TRA-5260', JSON.stringify(s));
  s = st(ok([REQ], [GRANT]));
  arm('proceed', 'AC2 same range, approve granted → CLEAR', s.verdict === 'CLEAR' && s.inRange === 1, JSON.stringify(s));
  s = st(ok([REQ], [GRANT, { ...GRANT, decision: 'decline' }]));
  arm('refuse', 'a decline keeps the gate shut even beside an approve', s.verdict === 'UNMET' && s.unmet[0].state === 'DECLINED', JSON.stringify(s));
  s = st(ok([REQ], []), { sha: null });
  arm('refuse', 'live unreadable → assume the passenger ships (UNMET)', s.verdict === 'UNMET', JSON.stringify(s));
  s = st(ok([REQ], []), { sha: TARGET });
  arm('proceed', 'sha already serving (not in live..target) → inert', s.verdict === 'CLEAR' && s.inRange === 0, JSON.stringify(s));
  s = signoffState(ok([REQ], []), { target: { sha: LIVE }, live: { sha: LIVE } }, isAnc);
  arm('proceed', 'target does not carry the sha → inert', s.verdict === 'CLEAR', JSON.stringify(s));
  s = signoffState(ok([REQ], []), { target: { sha: TARGET }, live: { sha: LIVE } }, () => null);
  arm('blind', 'ancestry unanswerable → BLIND, not clear', s.verdict === 'BLIND', JSON.stringify(s));
} else {
  console.log('NOTE  incident shas not in this checkout — replay arms SKIPPED (not green); fetch origin to run them');
  failed++;
}

// ── reader arms: the BLIND class ────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'tra5265-'));
try {
  const readWith = text => {
    mkdirSync(join(tmp, 'r', 'ops'), { recursive: true });
    if (text === null) rmSync(join(tmp, 'r', 'ops', 'deploy-signoffs.json'), { force: true });
    else writeFileSync(join(tmp, 'r', 'ops', 'deploy-signoffs.json'), text);
    return readSignoffs(join(tmp, 'r'));
  };
  const cases = [
    ['AC3 unparseable JSON', '{ not json'],
    ['file MISSING (deletion must not disarm)', null],
    ['no `grants` array', JSON.stringify({ requires: [] })],
    ['requires row missing `why`', doc([{ sha: PASSENGER, ticket: 'TRA-1' }], [])],
    ['short (prefix) sha', doc([{ ...REQ, sha: '9abf167f' }], [])],
    ['grant with bad decision', doc([REQ], [{ ...GRANT, decision: 'maybe' }])],
  ];
  for (const [name, text] of cases) {
    const r = readWith(text);
    arm('blind', `${name} → BLIND`, r.verdict === 'BLIND' && signoffBlocks(signoffState(r, { target: { sha: TARGET }, live: { sha: LIVE } }, isAnc).verdict), JSON.stringify(r));
  }
  const good = readWith(doc([REQ], [GRANT]));
  arm('proceed', 'well-formed registry reads OK', good.verdict === 'OK', JSON.stringify(good));
  const shipped = readSignoffs(REPO);
  arm('proceed', 'the SHIPPED ops/deploy-signoffs.json parses', shipped.verdict === 'OK', JSON.stringify(shipped));

  // ── EDGE arms: spawn the real main() in a throwaway shared clone ───────────────────────────
  if (haveReplay) {
    const clone = join(tmp, 'clone');
    const c = git(['clone', '--quiet', '--shared', '--no-checkout', REPO, clone], tmp);
    if (c.status !== 0) {
      arm('edge', 'could not build the throwaway clone', false, c.stderr);
    } else {
      mkdirSync(join(clone, 'scripts', 'lib'), { recursive: true });
      mkdirSync(join(clone, 'ops'), { recursive: true });
      for (const f of readdirSync(SCRIPTS)) if (f.endsWith('.mjs')) copyFileSync(join(SCRIPTS, f), join(clone, 'scripts', f));
      for (const f of readdirSync(join(SCRIPTS, 'lib'))) if (f.endsWith('.mjs')) copyFileSync(join(SCRIPTS, 'lib', f), join(clone, 'scripts', 'lib', f));
      copyFileSync(join(REPO, 'package.json'), join(clone, 'package.json'));
      writeFileSync(join(clone, 'ops', 'deploy-hold.json'), '{"holds":[]}');
      const bqb1 = { id: 'srv-d7mb7rr7uimc73ev0chg', name: 'TradingAI-', slug: 'tradingai-bqb1', branch: 'main' };
      const spawnDeploy = registry => {
        if (registry === null) rmSync(join(clone, 'ops', 'deploy-signoffs.json'), { force: true });
        else writeFileSync(join(clone, 'ops', 'deploy-signoffs.json'), registry);
        return spawnSync(
          process.execPath,
          ['--import', STUB, join(clone, 'scripts', 'render-redeploy.mjs'), `--commit=${TARGET}`, '--dry-run',
            '--force-rth-override=tra5265 control', '--force-embargo-override=tra5265 control'],
          {
            cwd: clone,
            encoding: 'utf8',
            env: {
              ...process.env,
              RENDER_API_KEY: 'rnd_stub',
              RENDER_SERVICE_ID: bqb1.id,
              TRA2387_STUB: JSON.stringify({
                service: bqb1,
                envVars: [{ key: 'AUTH_SECRET', value: 'x'.repeat(48) }, { key: 'NODE_ENV', value: 'production' }],
                health: { commit: LIVE, startedAt: '2026-10-07T00:54:30.836Z' },
                deploys: [],
              }),
            },
          },
        );
      };
      let r = spawnDeploy(doc([REQ], []));
      arm('refuse', 'EDGE: unsigned passenger in range → real main() exits 11 naming sha + ticket',
        r.status === 11 && r.stderr.includes(PASSENGER.slice(0, 12)) && r.stderr.includes('TRA-5260'), `status=${r.status}\n${r.stderr.slice(-600)}`);
      r = spawnDeploy(doc([REQ], [GRANT]));
      arm('proceed', 'EDGE twin: same range, granted → NOT exit 11 and prints the signoff line',
        r.status !== 11 && /signoff : 1 registered/.test(r.stdout), `status=${r.status}\n${r.stdout.slice(-400)}\n${r.stderr.slice(-400)}`);
      r = spawnDeploy('{ not json');
      arm('blind', 'EDGE: unparseable registry → real main() exits 11 BLIND', r.status === 11 && /BLIND/.test(r.stderr), `status=${r.status}\n${r.stderr.slice(-400)}`);
      r = spawnDeploy(null);
      arm('blind', 'EDGE: registry deleted → real main() exits 11 BLIND', r.status === 11 && /BLIND/.test(r.stderr), `status=${r.status}\n${r.stderr.slice(-400)}`);
      const ov = spawnSync(process.execPath, ['--import', STUB, join(clone, 'scripts', 'render-redeploy.mjs'), `--commit=${TARGET}`, '--dry-run',
        '--force-rth-override=x', '--force-embargo-override=x', '--override-signoff=no ticket named here'],
        { cwd: clone, encoding: 'utf8', env: { ...process.env, RENDER_API_KEY: 'rnd_stub', RENDER_SERVICE_ID: bqb1.id, TRA2387_STUB: JSON.stringify({ service: bqb1, envVars: [{ key: 'AUTH_SECRET', value: 'x'.repeat(48) }], health: { commit: LIVE }, deploys: [] }) } });
      arm('refuse', 'override that names no ticket is refused (exit 2)', ov.status === 2 && /NAME a ticket/.test(ov.stderr), `status=${ov.status}\n${ov.stderr.slice(-300)}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── wiring: the gate must sit between the rollback gate and the cadence gate ────────────────
const src = readFileSync(join(SCRIPTS, 'render-redeploy.mjs'), 'utf8');
const iRoll = src.indexOf('process.exit(8);');
const i11 = src.indexOf('process.exit(11);');
const iCad = src.indexOf('process.exit(10);');
arm('edge', 'source order: exit 8 < exit 11 < exit 10 (gate cannot be moved off the live path silently)',
  iRoll > 0 && i11 > iRoll && iCad > i11, `8@${iRoll} 11@${i11} 10@${iCad}`);

for (const cls of ['refuse', 'proceed', 'blind', 'edge']) {
  if (!reached.has(cls)) { console.log(`FAIL  arm class "${cls}" was never reached — the suite proves nothing`); failed++; }
}
console.log(failed ? `\n${failed} FAILED` : '\nall arms pass');
process.exit(failed ? 1 : 0);
