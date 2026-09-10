#!/usr/bin/env node
// check-env-intent-controls.mjs — TRA-4474
//
// The checker is an instrument too. Before trusting its green, prove what a
// broken world looks like through it: each control below feeds it a fixture of
// a known state and asserts the EXACT exit code. A control that cannot fail is
// not a control.
//
// Exit: 0 all controls hold · 1 a control landed on the wrong exit code.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHECKER = join(import.meta.dirname, 'check-env-intent.mjs');
const dir = mkdtempSync(join(tmpdir(), 'env-intent-controls-'));

const lever = (key, intended, effective, present = true) => ({
  key,
  intended,
  raw: present ? effective : null,
  present,
  effective,
  matches: effective === intended,
  provenance: 'control fixture',
});

const GOOD = {
  policy: 'refuse',
  envIntent: {
    source: 'packages/server/src/env-intent.ts',
    applies: true,
    nodeEnv: 'production',
    levers: [
      lever('DURABILITY_POLICY', 'refuse', 'refuse'),
      lever('ENABLE_ORDER_QUOTE_GUARD', 'off', 'off', false),
    ],
    mismatches: [],
    ok: true,
  },
};

// THE INCIDENT: the key wiped, the default deciding, effective != intended.
const WIPED = structuredClone(GOOD);
WIPED.policy = 'observe';
WIPED.envIntent.levers[0] = lever('DURABILITY_POLICY', 'refuse', 'observe', false);
WIPED.envIntent.mismatches = ['DURABILITY_POLICY'];
WIPED.envIntent.ok = false;

// The pre-TRA-4474 build: effective-only payload, no second term at all.
const PRE_4474 = { policy: 'observe', violations: [], unmeasured: [] };

// A box that cannot prove it is production: graded nothing, must not pass.
const UNGRADED = structuredClone(GOOD);
UNGRADED.envIntent.applies = false;
UNGRADED.envIntent.nodeEnv = null;
UNGRADED.envIntent.levers = UNGRADED.envIntent.levers.map((l) => ({ ...l, matches: null }));
UNGRADED.envIntent.ok = null;

const cases = [
  { name: 'CLEAN — armed as ruled', body: GOOD, want: 0 },
  { name: 'BROKEN — the incident (key wiped, default deciding)', body: WIPED, want: 1 },
  { name: 'BLIND — running build publishes no envIntent', body: PRE_4474, want: 3 },
  { name: 'BLIND — box cannot prove it is production (applies:false)', body: UNGRADED, want: 3 },
];

let failed = 0;
for (const [i, c] of cases.entries()) {
  const file = join(dir, `c${i}.json`);
  writeFileSync(file, JSON.stringify(c.body));
  const r = spawnSync(process.execPath, [CHECKER, `--fixture=${file}`], {
    encoding: 'utf8',
    // The env-list arm must stay OFF in controls: a real key here would grade
    // the real service against a fixture's lever list.
    env: { ...process.env, RENDER_API_KEY: '' },
  });
  const got = r.status;
  const ok = got === c.want;
  if (!ok) failed++;
  console.log(`[controls] ${ok ? 'PASS' : 'FAIL'} — ${c.name}: want exit ${c.want}, got ${got}`);
  if (!ok) console.log((r.stdout + r.stderr).trim().split('\n').map((l) => `           ${l}`).join('\n'));
}

// Usage control: an unrecognized flag must be exit 2, never a silent grade.
{
  const r = spawnSync(process.execPath, [CHECKER, '--fixtuer=typo.json'], { encoding: 'utf8' });
  const ok = r.status === 2;
  if (!ok) failed++;
  console.log(`[controls] ${ok ? 'PASS' : 'FAIL'} — usage: unrecognized flag: want exit 2, got ${r.status}`);
}

rmSync(dir, { recursive: true, force: true });
if (failed > 0) {
  console.error(`[controls] ${failed} control(s) FAILED — the checker cannot be trusted until they hold.`);
  process.exit(1);
}
console.log('[controls] all controls hold.');
