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

// `armCells` — the TRA-3080 retained per-ET-day arm ledger. Passed explicitly
// (never derived from `scans`) so a scenario can put the two axes in DISAGREEMENT:
// since-boot counters at zero after a restart, retained desk×live cell still
// present. That is the whole point of the retained axis, and it is unreachable
// if the fixture ties the two together.
const rvScan = (scans, armCells = []) => ({
  ok: true,
  enabled: true,
  armByEtDay: armCells.length ? [{ etDay: ET_DAY, cells: armCells }] : [],
  armRetentionDays: 30,
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
    // THE BELL. Same shape as ENGINE-SILENT below — open, nothing on any axis —
    // but two minutes in, when the retained arm cell (written on the first RTH
    // tick), the RV scan counter and the chain fetch have all simply not happened
    // yet. Without the floor this publishes exit 2, a DEFECT, against a healthy
    // box. The ENGINE-SILENT case below is the SAME fixture at T+45 and must still
    // go red, which is what stops the floor from being a blanket excuse.
    name: 'EARLY-SESSION — 13:32Z, two minutes past the bell, nothing has ticked yet',
    routes: { time: `${ET_DAY}T13:32:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: true, scans: 0 },
    expect: { zero: 'EARLY-SESSION', exit: 3, has: ['NOT attributable'], absent: ['DEFECT', 'REAL NEGATIVE', '⇒ PASS'] },
  },
  {
    name: 'ENGINE-SILENT — 14:15Z, open, NOTHING scanned',
    routes: { time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: true, scans: 0 },
    expect: { zero: 'ENGINE-SILENT', exit: 2, has: ['DEFECT', 'must NOT be reported'], absent: ['⇒ PASS'] },
  },
  {
    name: 'BLIND — restart AFTER the open, counter STILL zero',
    routes: { time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T13:55:00.000Z`, open: true, scans: 0 },
    // Without this guard a mid-session restart forges ENGINE-SILENT (a DEFECT)
    // out of a healthy session, because scanCountSinceBoot resets to 0.
    expect: { zero: 'BLIND', exit: 3, has: ['a reset is indistinguishable from a silent engine'], absent: ['DEFECT', '⇒ PASS'] },
  },
  {
    // THE RETAINED AXIS (TRA-3080 `armByEtDay`). Same restart as the case above —
    // since-boot counters at zero, boot AFTER the open — but the per-ET-day arm
    // ledger, which lives on disk and survives the reboot, still carries today's
    // desk×live cell. That cell is written at signal-engine.ts:6254, inside
    // `isStockMarketOpen()` and BELOW the `runOtmScan` call in the same doTick, so
    // it is positive proof a LIVE DESK engine ticked past the OTM scan site today.
    // Without it this session grades BLIND — no verdict — on the ~70%-likely
    // restart path. `disposition: live_arm_off` is deliberate: the recorder sits
    // ABOVE the directional flag gates, so the cell exists even though that
    // sleeve's live arm is off. Nothing here depends on the directional arm.
    name: 'STARVED-UPSTREAM — restart after the open, since-boot ZERO, RETAINED desk×live cell present',
    routes: {
      time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T13:55:00.000Z`, open: true, scans: 0,
      armCells: [{ accountClass: 'desk', mode: 'live', disposition: 'live_arm_off', reachable: false, books: 3, ticks: 812, boots: 2, firstAt: Date.parse(`${ET_DAY}T13:30:16Z`), lastAt: Date.parse(`${ET_DAY}T14:12:40Z`) }],
    },
    expect: { zero: 'STARVED-UPSTREAM', exit: 4, has: ['retained desk×live cell PRESENT', 'REAL NEGATIVE'], absent: ['BLIND', 'DEFECT', '⇒ PASS'] },
  },
  {
    // THE SCOPING GUARD. Same restart, and the retained ledger DOES carry cells for
    // today — but only for the 60 fixture demo books, which say nothing about
    // whether a live desk engine ran. Widening the cell lookup to "any cell" would
    // turn a genuinely unattributable zero into a published REAL NEGATIVE, so this
    // must stay BLIND.
    name: 'BLIND — retained cells exist today but ONLY for the fixture/demo class',
    routes: {
      time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T13:55:00.000Z`, open: true, scans: 0,
      armCells: [{ accountClass: 'fixture', mode: 'demo', disposition: 'armed_demo', reachable: true, books: 60, ticks: 45708, boots: 2, firstAt: Date.parse(`${ET_DAY}T13:30:16Z`), lastAt: Date.parse(`${ET_DAY}T14:12:40Z`) }],
    },
    expect: { zero: 'BLIND', exit: 3, has: ['retained desk×live cell ABSENT'], absent: ['REAL NEGATIVE', 'DEFECT', '⇒ PASS'] },
  },
  {
    // The PAIR to the case above, and the one bqb1 will most likely actually be
    // in at 14:15Z: it booted 13x in 7.8h today, so a restart inside the grading
    // window is ~70% likely — but by T+45 the engine has ticked again since that
    // restart. A NON-ZERO counter is positive proof the engine ran; the zero is
    // then attributable exactly as on a clean boot. Guarding on the boot time
    // ALONE (the old ordering) discarded that proof and returned BLIND, i.e. no
    // verdict, on the most probable healthy state of the session.
    name: 'STARVED-UPSTREAM — restart after the open, but the engine DID tick since',
    routes: { time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T13:55:00.000Z`, open: true, scans: 3 },
    expect: { zero: 'STARVED-UPSTREAM', exit: 4, has: ['REAL NEGATIVE', 'UPSTREAM of the nominator'], absent: ['BLIND', '⇒ PASS'] },
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
  {
    // ⛔ THE REGRESSION. This is the VERBATIM cost_bar shape of the first live RTH
    // read, 2026-08-13T13:54Z. Six blocks are `band_deauthorized` — the mandate's
    // ratified de-authorized [0.00,0.20) band declining exactly as TRA-3392 ordered
    // — and they are STAMPED, to `0.00-0.10`. The armed cell is absent because it
    // was never reached, not because a stamp was lost. The old grader keyed off the
    // mere PRESENCE of `band_deauthorized` in the aggregated `byReason` and
    // published DEFECT/"the grade is VOID" against a perfectly healthy ledger.
    // 7 blocked = 6 + 1 stamped, 0 unexplained ⇒ FAIL (criterion not met), never DEFECT.
    name: 'RECONCILES — band_deauthorized from ANOTHER cell is not a lost stamp',
    routes: {
      time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: true, scans: 7,
      costBar: {
        evaluated: 7, blocked: 7, blockRate: 1,
        byCell: [
          { cell: 'single_leg_otm::0.00-0.10', evaluated: 6, blocked: 6 },
          { cell: 'single_leg_otm::0.20-0.30', evaluated: 1, blocked: 1 },
        ],
        byBook: [{ book: 'admin', evaluated: 4, blocked: 4 }, { book: 'v0nni', evaluated: 1, blocked: 1 }],
        byReason: [
          { reasonCode: 'band_deauthorized', blocked: 6, share: 0.8571 },
          { reasonCode: 'shortfall_gte_0.50', blocked: 1, share: 0.1429 },
        ],
      },
    },
    expect: {
      zero: 'GRADEABLE',
      exit: 2,
      has: ['FAIL        C3 verdict', 'ledger RECONCILES', 'recorded ZERO evaluations', 'UNDECIDABLE'],
      absent: ['DEFECT', 'the grade is VOID', '⇒ PASS'],
    },
  },
  {
    // THE VACUITY GUARD for the control above. Same session, but now the ledger
    // really DOES drop a stamp: 7 blocked, only 6 stamped, and the 7th is
    // `gross_negative` — a code that cannot exist without a |delta| bucket, so it
    // cannot be the cell-free case either. One unexplained block ⇒ DEFECT must
    // still fire. Without this, the fix above could be "never report DEFECT".
    name: 'LOST STAMP — an unexplained block still reports DEFECT',
    routes: {
      time: `${ET_DAY}T14:15:00Z`, boot: `${ET_DAY}T08:46:37.823Z`, open: true, scans: 7,
      costBar: {
        evaluated: 7, blocked: 7, blockRate: 1,
        byCell: [{ cell: 'single_leg_otm::0.00-0.10', evaluated: 6, blocked: 6 }],
        byBook: [{ book: 'admin', evaluated: 4, blocked: 4 }, { book: 'v0nni', evaluated: 1, blocked: 1 }],
        byReason: [
          { reasonCode: 'band_deauthorized', blocked: 6, share: 0.857 },
          { reasonCode: 'gross_negative', blocked: 1, share: 0.143 },
        ],
      },
    },
    expect: {
      zero: 'GRADEABLE',
      exit: 2,
      has: ['DEFECT', '1 of 7 block(s) are stamped to NO cell', 'the grade is VOID'],
      absent: ['ledger RECONCILES', '⇒ PASS'],
    },
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
          : url.endsWith('/rv-scan') ? rvScan(r.scans, r.armCells)
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
