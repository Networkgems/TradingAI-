#!/usr/bin/env node
// TRA-2298 — drives every control mode through the QA instrument and asserts
// the instrument reacted the way it is supposed to. This is the test OF the
// test: it fails if the verifier stays green on a state it claims to detect.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4299;
const BASE = `http://localhost:${PORT}`;

// What each control MUST produce. `mustFailContain` names a substring that has
// to appear among the red legs — so a mode cannot pass its control by going red
// for an unrelated reason.
const CONTROLS = [
  { mode: 'prefix', wantExit: 1, mustFailContain: ['x-powered-by absent', 'x-frame-options', 'WILDCARD'] },
  { mode: 'outage', wantExit: 1, mustFailContain: ['THIS CONSUMER IS NOW BLOCKED'] },
  { mode: 'promiscuous', wantExit: 1, mustFailContain: ['https://evil.example'] },
  { mode: 'hsts-plain', wantExit: 1, mustFailContain: ['force-upgrade'] },
  { mode: 'fixed', wantExit: 0, mustFailContain: [] },
];

function runNode(args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { ...opts });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const results = [];

for (const c of CONTROLS) {
  const srv = spawn(process.execPath, ['scripts/tra2298-qa-control-server.mjs', `--mode=${c.mode}`, `--port=${PORT}`], { stdio: 'ignore' });
  await sleep(700);
  const { code, out } = await runNode(['scripts/tra2298-qa-reverify.mjs', `--base=${BASE}`]);
  srv.kill();
  await sleep(250);

  const reds = out.split('\n').filter((l) => l.startsWith('[FAIL]'));
  const missing = c.mustFailContain.filter((needle) => !reds.some((r) => r.includes(needle)));
  const exitOk = code === c.wantExit;
  const ok = exitOk && missing.length === 0;

  results.push({ mode: c.mode, code, wantExit: c.wantExit, redCount: reds.length, missing, ok });
  console.log(`${ok ? 'CONTROL OK ' : 'CONTROL BAD'}  mode=${c.mode.padEnd(12)} exit=${code} (want ${c.wantExit})  redLegs=${reds.length}${missing.length ? `  MISSING DETECTION: ${missing.join(', ')}` : ''}`);
}

// Unreachable host must be BLIND (3) — never a pass. A checker that cannot
// reach its subject and prints PASS is worse than no checker.
const dead = await runNode(['scripts/tra2298-qa-reverify.mjs', '--base=http://localhost:4998']);
const deadOk = dead.code === 3;
console.log(`${deadOk ? 'CONTROL OK ' : 'CONTROL BAD'}  mode=unreachable   exit=${dead.code} (want 3)`);
results.push({ mode: 'unreachable', code: dead.code, wantExit: 3, ok: deadOk });

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} controls behaved as required.`);
if (bad.length) {
  console.log('THE INSTRUMENT IS NOT TRUSTWORTHY — these controls did not react:');
  for (const b of bad) console.log(`  ✗ ${b.mode}: exit ${b.code}, wanted ${b.wantExit}${b.missing?.length ? `, missing ${b.missing.join(', ')}` : ''}`);
  process.exit(1);
}
console.log('Every control reacted. The green run against prod is meaningful.');
