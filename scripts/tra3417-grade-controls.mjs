// TRA-3417 — POSITIVE CONTROLS for the acceptance grader.
//
// WHY: a pre-open dry run of `tra3417-grade.mjs` exercises exactly ONE of its
// five zero-states (PRE-OPEN) and exits 3. The branch that actually fires at
// 14:15Z — 45 minutes after the open, with the market live — has never once
// run. "It printed the right answer at 11:15Z" is not evidence that it prints
// the right answer at 14:15Z; those are different code paths, and the whole
// reason this grader exists is that a zero read the same in three states.
//
// So: serve crafted health payloads from a local host, point the grader's
// `HOST_BASE` at it, and assert the ZERO-STATE, the per-criterion verdicts and
// the EXIT CODE for every branch. A control that cannot fail proves nothing, so
// each scenario also pins the exit code, not just the printed text.
//
//   node scripts/tra3417-grade-controls.mjs
//   → 0 all controls passed · 1 a control FAILED (the grader is wrong)

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GRADER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tra3417-grade.mjs');
const ET_DAY = '2026-08-13';
const OPEN = `${ET_DAY}T13:30:00Z`;

// ── payload fixtures, shaped from the REAL 2026-08-13 live reads ────────────
const version = (startedAt) => ({
  version: '0.0.0',
  commit: 'c44a890030c68af93014c1b92e73919b1ae61aa7',
  commitShort: 'c44a890030c6',
  nodeVersion: 'v20.19.0',
  pid: 76,
  startedAt,
  uptimeSec: 8924,
});

const GATE_KEYS = {
  evaluated: 0, blocked: 0, blockRate: 0, byScope: [], byReason: [],
  blockedUnclassified: 0, byBook: [], byCell: [], bySelection: [],
  costRQuantiles: null, netEdgeShadow: null,
};
const otherGates = ['spread', 'otm_delta_floor', 'universe', 'entry_delta_ceiling', 'entry_delta_ceiling_shadow', 'aggregate_cap']
  .map((gate) => ({ gate, ...GATE_KEYS }));

const gates = ({ time, costBar = {}, armed = true }) => ({
  ok: true,
  time,
  etDay: ET_DAY,
  arm: {
    admissibleStrike: { issue: 'TRA-3401', flag: 'ENABLE_OTM_ADMISSIBLE_STRIKE_SELECT', armed, band: { min: 0.5, max: 0.55 } },
    universe: { var: 'OPTION_LIVE_OTM_UNIVERSE', restricted: true, symbols: ['AAPL', 'SPY', 'QQQ', 'PLTR', 'TSLA', 'GIS', 'TFC', 'MO', 'VZ', 'UPS'], source: 'env' },
  },
  decisionsRecorded: 2571,
  byGate: [{ gate: 'cost_bar', ...GATE_KEYS, ...costBar }, ...otherGates],
  durability: { ephemeral: false, hydratedRecords: 2571 },
  lastDecisionAt: Date.parse('2026-08-12T19:58:15.297Z'),
});

const pipeline = (marketOpen) => ({
  ok: true,
  demoEngineCount: 2,
  engines: [
    { mode: 'demo', marketOpen, blockedBy: marketOpen ? null : 'market_closed' },
    { mode: 'demo', marketOpen, blockedBy: marketOpen ? null : 'market_closed' },
  ],
});

const rvScan = (scans) => ({
  ok: true,
  enabled: true,
  verdict: scans > 0 ? 'ran' : 'armed_but_never_ran',
  scanCountSinceBoot: scans,
  dataSource: { provider: 'tradier-chain', keyPresent: true, lastFetchOkAt: scans > 0 ? '2026-08-13T13:31:02.000Z' : null, lastFetchError: null },
  paths: [
    { path: 'directional', enabled: true, instrumented: true, scanCountSinceBoot: scans, lastScanAt: scans > 0 ? '2026-08-13T13:31:00.000Z' : null },
    { path: 'rv_scan', enabled: false, instrumented: true, scanCountSinceBoot: 0, lastScanAt: null },
  ],
});

// ── the scenarios ───────────────────────────────────────────────────────────
// `expect.zero` is the ZERO-STATE line; `expect.exit` the process code;
// `expect.has` substrings that MUST appear; `expect.absent` ones that must NOT.
const SCENARIOS = [
  {
    name: 'PRE-OPEN — 11:15Z, market shut',
    routes: { time: `${ET_DAY}T11:15:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: false, scans: 0 },
    expect: { zero: 'PRE-OPEN', exit: 3, has: ['UNGRADEABLE C2 nominator'], absent: ['REAL-NEGATIVE', 'DEFECT'] },
  },
  {
    name: 'STARVED-UPSTREAM — 14:15Z, open, engine ticked, cost_bar still 0',
    routes: { time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: true, scans: 7 },
    // THE 14:15Z BRANCH. A real negative attributable to the scanner, NOT a pass,
    // NOT benign, and explicitly NOT blamed on the band.
    expect: { zero: 'STARVED-UPSTREAM', exit: 4, has: ['REAL-NEGATIVE C2 nominator', 'REAL NEGATIVE', 'UPSTREAM of the nominator'], absent: ['⇒ PASS', 'pre-open'] },
  },
  {
    name: 'ENGINE-SILENT — 14:15Z, open, NOTHING scanned',
    routes: { time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: true, scans: 0 },
    expect: { zero: 'ENGINE-SILENT', exit: 2, has: ['DEFECT', 'must NOT be reported'], absent: ['⇒ PASS'] },
  },
  {
    name: 'BLIND — restart AFTER the open voids the since-boot control',
    routes: { time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T13:55:00.000Z`, open: true, scans: 0 },
    // Without this guard a mid-session restart forges ENGINE-SILENT (a DEFECT)
    // out of a healthy session, because scanCountSinceBoot resets to 0.
    expect: { zero: 'BLIND', exit: 3, has: ['since-boot scan counters were reset'], absent: ['DEFECT', '⇒ PASS'] },
  },
  {
    name: 'NO-SESSION — 14:15Z but the server says the market never opened',
    routes: { time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: false, scans: 0 },
    expect: { zero: 'NO-SESSION', exit: 3, has: ['holiday/half-day/halt'], absent: ['DEFECT', 'REAL NEGATIVE'] },
  },
  {
    name: 'BLIND — a liveness control is unreachable',
    routes: { time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: true, scans: 7, break: 'options-pipeline' },
    // FAIL-CLOSED: an unreadable control must never resolve to the benign branch.
    expect: { zero: 'BLIND', exit: 3, has: ['CANNOT be attributed'], absent: ['⇒ PASS', 'REAL NEGATIVE'] },
  },
  {
    name: 'GRADEABLE + ADMIT — the nominator reached the gate and cleared it',
    routes: {
      time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: true, scans: 7,
      costBar: {
        evaluated: 12, blocked: 10, blockRate: 0.83,
        byCell: [{ cell: 'single_leg_otm::0.50-0.55', evaluated: 12, blocked: 10 }],
        bySelection: [{ selection: 'in_band', evaluated: 12, blocked: 10 }],
        byBook: [{ book: 'admin', evaluated: 7, blocked: 5 }, { book: 'v0nni', evaluated: 5, blocked: 5 }],
        byReason: [{ reasonCode: 'gross_negative', blocked: 10, share: 1 }],
      },
    },
    // admin has 2 admits ⇒ C4 must demand the FILL TAPE (REVIEW), never assert a trade.
    expect: { zero: 'GRADEABLE', exit: 3, has: ['PASS        C2 nominator', 'ADMITS 2', 'GO TO THE FILL TAPE'], absent: ['pre-open'] },
  },
  {
    name: 'ARM DROPPED — a restart lost the env mid-session',
    routes: { time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: true, scans: 7, armed: false },
    expect: { zero: 'STARVED-UPSTREAM', exit: 2, has: ['FAIL', 'a restart dropped the env'], absent: ['⇒ PASS'] },
  },
];

const runOne = async (sc) => {
  const r = sc.routes;
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (r.break && url.endsWith(r.break)) { res.writeHead(500).end('boom'); return; }
    const body = url.endsWith('/version') ? version(r.boot)
      : url.endsWith('/live-enforce-gates') ? gates({ time: r.time, costBar: r.costBar, armed: r.armed ?? true })
        : url.endsWith('/options-pipeline') ? pipeline(r.open)
          : url.endsWith('/rv-scan') ? rvScan(r.scans)
            : null;
    if (!body) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [GRADER, '--no-logs'], { env: { ...process.env, HOST_BASE: base }, stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '';
    p.stdout.on('data', (d) => { s += d; });
    p.stderr.on('data', (d) => { s += d; });
    p.on('close', (code) => resolve({ code, s }));
  });
  server.close();
  return out;
};

let failed = 0;
for (const sc of SCENARIOS) {
  const { code, s } = await runOne(sc);
  const zeroLine = s.split('\n').find((l) => l.includes('⇒ ZERO-STATE:')) ?? '(no ZERO-STATE line)';
  const problems = [];
  if (!zeroLine.includes(sc.expect.zero)) problems.push(`ZERO-STATE expected ${sc.expect.zero}, got: ${zeroLine.trim()}`);
  if (code !== sc.expect.exit) problems.push(`exit expected ${sc.expect.exit}, got ${code}`);
  for (const h of sc.expect.has ?? []) if (!s.includes(h)) problems.push(`missing required text ${JSON.stringify(h)}`);
  for (const a of sc.expect.absent ?? []) if (s.includes(a)) problems.push(`FORBIDDEN text present ${JSON.stringify(a)}`);
  if (problems.length) {
    failed += 1;
    console.log(`✗ ${sc.name}`);
    for (const p of problems) console.log(`    ${p}`);
    console.log(s.split('\n').map((l) => `      | ${l}`).join('\n'));
  } else {
    console.log(`✓ ${sc.name}  → ${sc.expect.zero}, exit ${code}`);
  }
}
console.log(`\n${SCENARIOS.length - failed}/${SCENARIOS.length} controls passed`);
process.exit(failed ? 1 : 0);
