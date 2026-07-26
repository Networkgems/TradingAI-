#!/usr/bin/env node
// TRA-2361 — BOTH-DIRECTIONS CONTROL for the new `--live` assertions in
// scripts/tra2335-feasibility-check.mjs.
//
// A green from an instrument whose RED branch nobody has seen is not evidence. This
// stands up a local server that serves a REAL gate payload (computed from the shipped
// fixtures through the shipped code, not hand-written JSON), points `--live` at it, and
// then MUTATES the payload one field at a time to confirm each new assertion actually
// fires. Known-good must exit 0; each known-bad must exit 1.
//
// ⚠️ The known-good payload CONTAINS a blocking sleeve. A control built on a payload with
// no block could not tell "the coherence checks work" from "they never run".
//
//   node scripts/tra2361-prover-controls.mjs          # after `pnpm --filter @trading-app/server build`
//   VERBOSE=1 node scripts/tra2361-prover-controls.mjs
//
// Exit 0 = every assertion has a demonstrated RED branch and the known-good is GREEN.
// Exit 1 = some assertion cannot fire (blind) or fires when it must not (false alarm).
// Exit 3 = dist/ is not built, so nothing was graded — NOT a pass.

import { createServer } from 'http';
// ⚠️ ASYNC spawn, not execFileSync: this process IS the server the child fetches from, and
// execFileSync blocks its own event loop — so the child's request never gets answered and
// both sides hang. (Cost me one 7-minute timeout that looked like a prover bug.)
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repo = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(repo, 'packages', 'server', 'dist');
if (!existsSync(join(DIST, 'live-capital-gate.js'))) {
  // Fail CLOSED: an unbuilt tree grades nothing, and "no controls ran" must never read
  // like "all controls passed".
  console.error(
    `\n⚠️  BLIND — ${DIST} is not built, so NO control ran. This is NOT a pass.` +
      `\n   Run: pnpm --filter @trading-app/server build`,
  );
  process.exit(3);
}
const load = (f) => import(pathToFileURL(join(DIST, f)).href);

const { buildForwardTestReport } = await load('options-forward-test.js');
const { evaluateLiveCapitalGate, LIVE_CAPITAL_GATE } = await load('live-capital-gate.js');
const { BAR, MONOTONICITY_CASES } = await load('gate-sleeve-blocking-fixtures.js');

const c = MONOTONICITY_CASES().find((x) => x.key === 'known-bad-25pct-infeasible-sleeve');
const report = buildForwardTestReport(c.outcomes, { asOf: Date.parse('2026-02-23T16:00:00.000Z') });
const gate = evaluateLiveCapitalGate(report, { ...LIVE_CAPITAL_GATE, minExpectancyR: BAR });

// Mirror exactly what index.ts publishes on the route (the whitelist for `criteria`, the
// whole-object pass-through for `sleeveFeasibility`).
const basePayload = () => ({
  passed: gate.passed,
  asOfDate: gate.asOfDate,
  summary: gate.summary,
  criteria: gate.criteria.map((x) => ({
    name: x.name,
    description: x.description,
    required: x.required,
    actual: x.actual,
    pass: x.pass,
    status: x.status,
    barR: x.barR ?? null,
    ceilingR: x.ceilingR ?? null,
    feasibilityNote: x.feasibilityNote ?? null,
  })),
  feasibility: {
    ...gate.feasibility,
    ceilingGrossR: report.totals.ceilingGrossR,
    ceilingGrossRPriced: report.totals.ceilingGrossRPriced,
    avgCostR: report.totals.avgCostR,
    ceilingSources: report.totals.ceilingSourceCounts,
  },
  sleeveFeasibility: gate.sleeveFeasibility,
});

const clone = (o) => JSON.parse(JSON.stringify(o));

const CASES = [
  { name: 'KNOWN-GOOD (contains a live block, fully coherent)', expect: 0, mutate: (p) => p },
  {
    name: 'partition broken — one sleeve DROPPED (sum(n) !== bookN)',
    expect: 1,
    mutate: (p) => {
      p.sleeveFeasibility.byStructure.sleeves = p.sleeveFeasibility.byStructure.sleeves.filter(
        (s) => !s.blocking,
      );
      p.sleeveFeasibility.byStructure.blockingSleeves = [];
      return p;
    },
  },
  {
    name: '`blocking` flag stripped from every sleeve',
    expect: 1,
    mutate: (p) => {
      for (const a of [p.sleeveFeasibility.byStructure, p.sleeveFeasibility.byPremiumDirection]) {
        for (const s of a.sleeves) delete s.blocking;
      }
      return p;
    },
  },
  {
    name: '`weight` stripped from every sleeve',
    expect: 1,
    mutate: (p) => {
      for (const a of [p.sleeveFeasibility.byStructure, p.sleeveFeasibility.byPremiumDirection]) {
        for (const s of a.sleeves) delete s.weight;
      }
      return p;
    },
  },
  {
    name: '`blockingSleeves` DISAGREES with the per-sleeve flags',
    expect: 1,
    mutate: (p) => {
      p.sleeveFeasibility.byStructure.blockingSleeves = [];
      return p;
    },
  },
  {
    name: '`blockingSleeves` array missing entirely',
    expect: 1,
    mutate: (p) => {
      delete p.sleeveFeasibility.byStructure.blockingSleeves;
      return p;
    },
  },
  {
    name: 'a sleeve blocks but criterion 3 reads FAIL (payload contradicts itself)',
    expect: 1,
    mutate: (p) => {
      const c3 = p.criteria.find((x) => x.name === 'positive_expectancy');
      c3.status = 'FAIL';
      return p;
    },
  },
  {
    name: 'a sleeve blocks but the HEADLINE names none of the offenders',
    expect: 1,
    mutate: (p) => {
      p.summary = 'INFEASIBLE — live capital stays gated. Unmet: positive_expectancy.';
      return p;
    },
  },
  {
    name: '`sleeveFeasibility` dropped entirely (the TRA-2335 whitelist trap)',
    expect: 1,
    mutate: (p) => {
      delete p.sleeveFeasibility;
      return p;
    },
  },
];

let payload = basePayload();
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/api/health/version')) {
    res.end(JSON.stringify({ commit: 'LOCALCONTROL' }));
    return;
  }
  res.end(JSON.stringify(payload));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
for (const t of CASES) {
  payload = t.mutate(clone(basePayload()));
  const code = await new Promise((resolve) => {
    const child = spawn(
      'node',
      [join(repo, 'scripts', 'tra2335-feasibility-check.mjs'), '--live', `--base=${base}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (c) => {
      if (process.env.VERBOSE) console.log(out);
      resolve(c);
    });
  });
  const ok = code === t.expect;
  if (!ok) failures += 1;
  console.log(`${ok ? '✅' : '❌'} exit ${code} (expected ${t.expect})  —  ${t.name}`);
}
server.close();
console.log(failures === 0 ? '\n✅ ALL CONTROLS PASS — every new assertion has a demonstrated RED branch.' : `\n❌ ${failures} control(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
