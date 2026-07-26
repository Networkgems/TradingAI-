#!/usr/bin/env node
// TRA-2399 — a POPULATED-BOOK control server for `tra2335-feasibility-check.mjs --live`.
//
// ⚠️⚠️ WHY THIS EXISTS, AND WHAT IT IS AND IS NOT ⚠️⚠️
//
//   AC3 needs the two directions to be demonstrably DISTINGUISHABLE end-to-end, not just
//   in the unit suite: the empty book must exit 4, a populated one must exit 0, through
//   the SAME CLI, over a real socket. The empty direction is easy — any freshly-booted
//   server is one. The populated direction is not: as of 2026-07-26 there is no server
//   anywhere running R1 over a non-empty book. bqb1 sits at `408f06a5`, which predates
//   `b7fdbd8` and publishes no `sleeveFeasibility` at all, and a local server resolves
//   nothing without recorded option chains (`data/option-chains` is empty here).
//
//   So this serves `/api/health/live-capital-gate` and `/api/health/version` with a
//   payload computed by THE REAL GATE — `evaluateLiveCapitalGate` out of
//   `packages/server/dist`, over the shared R1 fixture book in
//   `gate-sleeve-blocking-fixtures.ts`. The sleeve decomposition, the weights, the
//   `blocking` flags and the `blockingSleeves` projection are all produced by
//   `gate-feasibility.ts` itself, not typed here.
//
//   ⚠️ WHAT IS SYNTHETIC IS THE BOOK, exactly as in this script's own documented
//   RECONSTRUCTION mode. This is a control for the INSTRUMENT, and it may not be quoted
//   as a statement about any live book. It prints a `commit` of `CONTROL-SERVER-NOT-A-BUILD`
//   for that reason — a control that stamps a plausible SHA is the artefact TRA-2399 is
//   about, one layer down.
//
//   node scripts/lib/tra2399-populated-gate-server.mjs            # serve on :4399
//   node scripts/lib/tra2399-populated-gate-server.mjs --port=N
//   node scripts/lib/tra2399-populated-gate-server.mjs --empty    # the vacuous direction
//   node scripts/lib/tra2399-populated-gate-server.mjs --self-test # both, then exit
//
// Requires `pnpm build` (or `pnpm typecheck`) first — it imports from dist/.

import { createServer } from 'http';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const dist = join(repo, 'packages', 'server', 'dist');
const argv = process.argv.slice(2);
const portArg = argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.slice('--port='.length) : 4399);
const SELF_TEST = argv.includes('--self-test');

const load = (f) => import(new URL(`file://${join(dist, f)}`).href);
const { buildForwardTestReport } = await load('options-forward-test.js');
const { evaluateLiveCapitalGate, LIVE_CAPITAL_GATE } = await load('live-capital-gate.js');
const { debitWinner, creditAtCeiling, BAR } = await load('gate-sleeve-blocking-fixtures.js');

// A MIXED book: 12 debit verticals that clear the bar + 35 credit verticals that cannot
// reach it at any hit rate. That is the TRA-2353 shape — an infeasible sleeve averaged
// into a book-level verdict — and it is what makes `byStructure` / `byPremiumDirection`
// partition into more than one sleeve, which is the whole point of a populated control.
const populatedBook = () => [
  ...Array.from({ length: 12 }, (_, i) => debitWinner(i)),
  ...Array.from({ length: 35 }, (_, i) => creditAtCeiling(100 + i)),
];

function gatePayload({ empty }) {
  const outcomes = empty ? [] : populatedBook();
  const report = buildForwardTestReport(outcomes, { asOf: Date.parse('2026-02-23T16:00:00Z') });
  const gate = evaluateLiveCapitalGate(report, { ...LIVE_CAPITAL_GATE, minExpectancyR: BAR });
  // Shaped exactly like index.ts's route, INCLUDING its `feasibility` overlay: the route
  // does not pass `gate.feasibility` straight through — it grafts `ceilingGrossR`,
  // `ceilingGrossRPriced`, `avgCostR` and `ceilingSources` on from `report.totals`. A
  // control that skipped that would print `undefined` where a real server prints the
  // reward provenance, and a control whose output differs from the thing it stands in
  // for is a control you have to remember not to trust. (`sleeveFeasibility` IS a
  // whole-object pass-through there — see the comment above it in index.ts.)
  return {
    asOfDate: '2026-02-23',
    passed: gate.passed,
    summary: gate.summary,
    note: gate.note,
    criteria: gate.criteria,
    feasibility: {
      ...gate.feasibility,
      ceilingGrossR: report.totals.ceilingGrossR,
      ceilingGrossRPriced: report.totals.ceilingGrossRPriced,
      avgCostR: report.totals.avgCostR,
      ceilingSources: report.totals.ceilingSourceCounts,
    },
    sleeveFeasibility: gate.sleeveFeasibility,
  };
}

const versionPayload = {
  version: '0.0.0',
  // ⛔ DELIBERATELY NOT A SHA. See the header.
  commit: 'CONTROL-SERVER-NOT-A-BUILD',
  commitShort: 'CONTROL',
  branch: 'tra2399-control',
  commitSource: 'tra2399-control-server',
};

// ⚠️ `spawnSync` DEADLOCKS here: the control server runs on THIS event loop, so a
// synchronous child that fetches from it can never be answered. Async spawn only.
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { encoding: 'utf8' });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (status) => resolve({ status, out }));
  });
}

function serve({ empty, port }) {
  const server = createServer((req, res) => {
    const path = String(req.url ?? '').split('?')[0];
    const body =
      path === '/api/health/version'
        ? versionPayload
        : path === '/api/health/live-capital-gate'
          ? gatePayload({ empty })
          : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'not found' }));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (SELF_TEST) {
  // ── BOTH DIRECTIONS, END TO END, THROUGH THE REAL CLI ─────────────────────
  //
  // ⚠️ THE POPULATED LEG IS THE LOAD-BEARING ONE. "the empty book exits 4" is also what
  // you observe from a checker that exits 4 on everything; without a demonstrated 0 next
  // to it, exit 4 has no preimage and this control proves nothing.
  const CHECK = join(repo, 'scripts', 'tra2335-feasibility-check.mjs');
  const results = [];
  for (const [label, empty, want] of [
    ['POPULATED book (12 debit + 35 credit)', false, 0],
    ['EMPTY book (bookN=0, sleeves: [])', true, 4],
  ]) {
    const port = PORT + (empty ? 1 : 0);
    const server = await serve({ empty, port });
    const r = await run('node', [CHECK, '--live', `--base=http://127.0.0.1:${port}`]);
    server.close();
    console.log(`\n${'═'.repeat(78)}\n══ ${label} — expect EXIT ${want}\n${'═'.repeat(78)}`);
    console.log(r.out.trimEnd());
    console.log(`EXIT=${r.status}`);
    results.push({ label, want, got: r.status, ok: r.status === want });
  }
  const failed = results.filter((x) => !x.ok);
  console.log(
    `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} directions correct — ` +
      results.map((x) => `${x.label.split(' ')[0]}=${x.got}(want ${x.want})`).join(' · '),
  );
  if (failed.length === 0) {
    console.log(
      '   The pass state and the ungraded state are DISTINGUISHABLE on the exit code, which\n' +
        '   is the property TRA-2399 found missing. Neither leg is a statement about any book.',
    );
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

const empty = argv.includes('--empty');
await serve({ empty, port: PORT });
console.log(
  `TRA-2399 control server on http://127.0.0.1:${PORT} — ${empty ? 'EMPTY' : 'POPULATED'} book.\n` +
    `  node scripts/tra2335-feasibility-check.mjs --live --base=http://127.0.0.1:${PORT}`,
);
