#!/usr/bin/env node
// TRA-3010 — controls for `check-tra3010-gate-a.mjs`.
//
// WHY THIS EXISTS
//
// Against the live box the gate-A checker has only ever taken ONE of its four
// exits: 2 (BLIND). Its entire grading block is behind `records.length > 0`,
// which has never been true, because no engine-opened live row has arrived yet.
// So on the day the row finally lands, previously-unexecuted code decides a gate
// that unblocks TRA-2873 — and a checker that cannot fail reads exactly like a
// checker that passed. That is the recurring defect this whole issue is about,
// one level up again: the instrument itself was never shown to discriminate.
//
// These controls plant fixtures rather than waiting for the book. Each scenario
// drives the REAL script as a child process against a local fixture server via
// `--host=`, so the grading code, the exit codes and the ordering of the guards
// are the ones that will actually run in production — not a reimplementation.
// (Reimplementing the predicate here would grade a copy and prove nothing:
// TRA-2864's "two impls of one rule IS the defect".)
//
// Every FAIL scenario is a single-field mutation off the conforming record, so
// a green here means each assertion is individually load-bearing — not that some
// other assertion happened to catch the mutation.
//
// Usage:  node scripts/check-tra3010-gate-a-selftest.mjs
// Exit:   0 all controls held · 1 a control broke

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// `TRA3010_TARGET` points the harness at a MUTANT copy of the checker. It is the
// control-on-the-control: a scenario set that passes on first run has not yet
// been shown to be able to fail, and "cannot fail" reads identically to "passed".
// Mutate an assertion in a copy, re-run, and the matching scenario must go red.
const TARGET = process.env.TRA3010_TARGET ?? join(HERE, 'check-tra3010-gate-a.mjs');

// Must be >= the checker's own CENSUS_LIVE_SINCE_MS (2026-08-06T00:41:56Z) or
// fill-tape rows fall outside the window it looks at.
const CENSUS_LIVE = Date.parse('2026-08-06T00:41:56Z');
const OPEN_TS = CENSUS_LIVE + 3_600_000;   // an engine fill an hour after
const BOOT_AFTER = new Date(OPEN_TS + 600_000).toISOString();  // restart since
const BOOT_BEFORE = new Date(CENSUS_LIVE + 60_000).toISOString(); // same boot

/**
 * A conforming restatement, derived rather than hand-typed: the thresholds are
 * RESCALED by `broker/ours`, so computing them from the ratio is what makes the
 * "conforming" case genuinely conforming instead of accidentally so.
 */
function goodRecord(over = {}) {
  const before = 0.995;          // scanner NBBO mid — what TradingAI booked
  const after = 1.04;            // Tradier cost_basis / qty / 100
  const contracts = 4;
  const ratio = after / before;
  const stopBefore = before * 0.8;
  const tp1Before = before * 1.5;
  const rec = {
    ts: OPEN_TS + 30_000,
    positionId: 'pos-tra3010-ctl',
    optionSymbol: 'AAPL260904P00280000',
    contracts,
    premiumPaidBefore: before,
    premiumPaidAfter: after,
    ratio,
    brokerCostBasisUsd: after * contracts * 100,
    tp1PremiumBefore: tp1Before,
    tp1PremiumAfter: tp1Before * ratio,
    stopLossPremiumBefore: stopBefore,
    stopLossPremiumAfter: stopBefore * ratio,
    trailingStopPremiumBefore: 0,
    trailingStopPremiumAfter: 0,
    trailingActive: false,
    tp1RatioBefore: tp1Before / before,
    tp1RatioAfter: (tp1Before * ratio) / after,
    stopRatioBefore: stopBefore / before,
    stopRatioAfter: (stopBefore * ratio) / after,
  };
  return { ...rec, ...over };
}

const armedSweeps = {
  window: 'process uptime — resets on restart',
  reached: 31,
  lastReachedAt: '2026-08-06T01:22:20.231Z',
  lastOutcome: 'reached',
  skipped: { mode: 0, no_client: 0, cadence: 23, empty: 0, fetch_failed: 0 },
};
const darkSweeps = (skipped) => ({
  ...armedSweeps,
  reached: 0,
  lastReachedAt: null,
  lastOutcome: 'skipped',
  skipped: { mode: 0, no_client: 0, cadence: 0, empty: 0, fetch_failed: 0, ...skipped },
});
const noSkips = {
  not_live: 0, multi_leg: 0, covered_write: 0,
  in_flight: 0, broker_premium_unusable: 0, zero_delta: 0,
};

/** Default census: armed, readable, and empty — today's real live state. */
function census(over = {}) {
  return {
    env: 'production',
    sweeps: armedSweeps,
    sinceBoot: {
      window: 'process uptime — resets on restart',
      candidates: 0,
      restated: 0,
      skips: { ...noSkips },
    },
    durable: {
      dataDir: '/data',
      logPresent: false,
      count: 0,
      malformedLines: 0,
      appendErrors: 0,
      lastAppendError: null,
      restatements: [],
    },
    ...over,
  };
}

/** A census carrying `records` as a witnessed, durable tape. */
function withRecords(records, over = {}) {
  const c = census(over);
  c.sinceBoot = { ...c.sinceBoot, candidates: records.length, restated: records.length };
  c.durable = { ...c.durable, logPresent: true, count: records.length, restatements: records };
  return c;
}

const importedRow = { mode: 'live', optionSymbol: 'TSLA260911C00555000', importedFromTradier: true };
const engineRow = { mode: 'live', optionSymbol: 'AAPL260904P00280000' };

// ---------------------------------------------------------------------------
// Scenarios. `expect` is the exit code; `must` are substrings that prove it
// exited for the RIGHT reason — an exit 3 raised by the wrong guard is the same
// class of bug as no guard at all.
// ---------------------------------------------------------------------------
const SCENARIOS = [
  // --- exit 0: the path that has NEVER run against the live box -------------
  {
    name: 'PASS — a conforming restatement grades 0',
    fixture: { census: withRecords([goodRecord()]) },
    expect: 0,
    must: ['GATE A: PASS', '0 failed assertion(s)'],
  },
  {
    name: 'PASS — an unmanaged row\'s 0/Infinity ratio sentinels survive the rescale',
    fixture: {
      census: withRecords([goodRecord({
        stopLossPremiumBefore: 0, stopLossPremiumAfter: 0, stopRatioBefore: 0, stopRatioAfter: 0,
        tp1PremiumBefore: Infinity, tp1PremiumAfter: Infinity,
        tp1RatioBefore: Infinity, tp1RatioAfter: Infinity,
      })]),
    },
    expect: 0,
    must: ['GATE A: PASS'],
  },

  // --- exit 1: each assertion proven individually load-bearing --------------
  {
    name: 'FAIL — basis off broker cost_basis by one cent',
    // $416.00 of broker truth against a basis implying $416.04.
    fixture: { census: withRecords([goodRecord({ premiumPaidAfter: 1.0401 })]) },
    expect: 1,
    must: ['FAIL  basis equals broker cost_basis to the cent', 'GATE A: FAIL'],
  },
  {
    name: 'FAIL — basis never moved off the scanner mark (the no-op-match trap)',
    fixture: {
      census: withRecords([goodRecord({
        premiumPaidAfter: 0.995, ratio: 1, brokerCostBasisUsd: 0.995 * 4 * 100,
        stopLossPremiumAfter: 0.995 * 0.8, tp1PremiumAfter: 0.995 * 1.5,
      })]),
    },
    expect: 1,
    must: ['FAIL  basis actually moved off the scanner mark'],
  },
  {
    name: 'FAIL — stop ratio drifts at the 10th dp (recomputed, not rescaled)',
    fixture: { census: withRecords([goodRecord({ stopRatioAfter: 0.8 + 1e-9 })]) },
    expect: 1,
    must: ['FAIL  stopLossPremium / premiumPaid unchanged to 10 dp'],
  },
  {
    name: 'FAIL — tp1 ratio drifts at the 10th dp',
    fixture: { census: withRecords([goodRecord({ tp1RatioAfter: 1.5 + 1e-9 })]) },
    expect: 1,
    must: ['FAIL  tp1Premium / premiumPaid unchanged to 10 dp'],
  },
  {
    name: 'FAIL — ratios equal but the stop level never moved (schedule not carried)',
    // The exact case equal-ratios-alone cannot catch: both ratios are invariant
    // yet the level is frozen at the pre-restatement number.
    fixture: {
      census: withRecords([goodRecord({
        stopLossPremiumAfter: 0.995 * 0.8,
        stopRatioAfter: (0.995 * 0.8) / 1.04,
        stopRatioBefore: (0.995 * 0.8) / 1.04,
      })]),
    },
    expect: 1,
    must: ['FAIL  stop level moved with the basis'],
  },
  {
    name: 'FAIL — an ACTIVE trailing stop was rescaled (it is peak-derived, not basis-derived)',
    fixture: {
      census: withRecords([goodRecord({
        trailingActive: true,
        trailingStopPremiumBefore: 0.9,
        trailingStopPremiumAfter: 0.9 * (1.04 / 0.995),
      })]),
    },
    expect: 1,
    must: ['FAIL  ACTIVE trailing stop left alone'],
  },
  {
    name: 'FAIL — one bad row among two is not laundered by the good one',
    fixture: {
      census: withRecords([
        goodRecord(),
        goodRecord({ optionSymbol: 'SPY260904C00816000', premiumPaidAfter: 1.0401 }),
      ]),
    },
    expect: 1,
    must: ['graded 2 restatement(s)', 'GATE A: FAIL'],
  },

  // --- exit 2: BLIND, and it must NOT be reported as a pass ----------------
  {
    name: 'BLIND — armed and readable, but the book holds no engine row',
    fixture: { census: census(), state: { openOptions: [importedRow] } },
    expect: 2,
    must: ['no engine-opened live row has been restated', 'NOT a pass'],
  },
  {
    name: 'BLIND — a zero_delta match cannot serve as the sample',
    fixture: {
      census: census({
        sinceBoot: { window: 'w', candidates: 1, restated: 0, skips: { ...noSkips, zero_delta: 1 } },
      }),
    },
    expect: 2,
    must: ['skipped as zero_delta', 'CANNOT serve'],
  },
  {
    name: 'BLIND — the live account was genuinely idle all window',
    fixture: { census: census({ sweeps: darkSweeps({ empty: 9 }) }) },
    expect: 2,
    must: ['live account was idle', 'NOT a pass'],
  },
  {
    name: 'BLIND + WARNING — the book holds an engine row the sweep never matched',
    // Zero candidates while our own book shows an engine-opened live row means
    // the pairing is broken, not that the book is idle.
    fixture: { census: census(), state: { openOptions: [importedRow, engineRow] } },
    expect: 2,
    must: ['BUT the book holds 1 open engine-opened live row', 'do NOT read this zero as coverage'],
  },

  // --- exit 3: UNREAD — the states that must never be mistaken for idle ----
  {
    name: 'UNREAD — the live reconcile is dark (mode/no_client)',
    fixture: { census: census({ sweeps: darkSweeps({ mode: 4, no_client: 2 }) }) },
    expect: 3,
    must: ['live reconcile is DARK'],
  },
  {
    name: 'UNREAD — a Tradier outage publishes the same zero as an idle book',
    fixture: { census: census({ sweeps: darkSweeps({ fetch_failed: 3 }) }) },
    expect: 3,
    must: ['Tradier /positions failed 3 time(s)', 'unread, not clean'],
  },
  {
    name: 'UNREAD — the witness itself is not wired (no reach, no skip reason)',
    fixture: { census: census({ sweeps: darkSweeps({}) }) },
    expect: 3,
    must: ['witness itself is not wired'],
  },
  {
    name: 'UNREAD — a host predating the enabling-precondition fix has no sweeps witness',
    fixture: { census: (() => { const c = census(); delete c.sweeps; return c; })() },
    expect: 3,
    must: ['predates the enabling-precondition fix'],
  },
  {
    name: 'UNREAD — a ledger whose appends threw is not an empty ledger',
    fixture: {
      census: census({
        durable: {
          dataDir: '/data', logPresent: false, count: 0, malformedLines: 0,
          appendErrors: 2, lastAppendError: 'ENOSPC', restatements: [],
        },
      }),
    },
    expect: 3,
    must: ['append(s) failed', 'not write-through'],
  },
  {
    name: 'UNREAD — DATA_DIR unset means nothing was ever persisted',
    fixture: {
      census: census({
        durable: {
          dataDir: null, logPresent: false, count: 0, malformedLines: 0,
          appendErrors: 0, lastAppendError: null, restatements: [],
        },
      }),
    },
    expect: 3,
    must: ['DATA_DIR unset'],
  },
  {
    name: 'UNREAD — an engine fill with no restatement and a restart since (laundering)',
    // The a20f4d5 case: since-boot skips wiped, durable tape empty, yet the fill
    // tape proves a row arrived. Idle and unread are NOT the same verdict.
    fixture: {
      version: { startedAt: BOOT_AFTER },
      fills: [{ ts: OPEN_TS, side: 'buy_to_open', origin: 'fill', optionSymbol: 'TSLA260911C00555000' }],
    },
    expect: 3,
    must: ['NO TRACE', 'UNREAD, not idle'],
  },

  // --- controls on the controls: the guards must not false-positive --------
  {
    name: 'CONTROL — a same-boot fill is explained by the skips, so NOT unread',
    fixture: {
      version: { startedAt: BOOT_BEFORE },
      fills: [{ ts: OPEN_TS, side: 'buy_to_open', origin: 'fill', optionSymbol: 'TSLA260911C00555000' }],
    },
    expect: 2,
    must: ['no restatement (this boot — see skips)'],
  },
  {
    name: 'CONTROL — a history_import is not an engine fill and must not trip the tape check',
    fixture: {
      version: { startedAt: BOOT_AFTER },
      fills: [{ ts: OPEN_TS, side: 'buy_to_open', origin: 'history_import', optionSymbol: 'TSLA260911C00555000' }],
    },
    expect: 2,
    must: ['engine opens since census went live   0'],
  },
  {
    name: 'CONTROL — a fill that DID get restated is not counted as unread',
    fixture: {
      version: { startedAt: BOOT_AFTER },
      census: withRecords([goodRecord()]),
      fills: [{ ts: OPEN_TS, side: 'buy_to_open', origin: 'fill', optionSymbol: 'AAPL260904P00280000' }],
    },
    expect: 0,
    must: ['restated', 'GATE A: PASS'],
  },
];

// ---------------------------------------------------------------------------

function startFixtureServer(fixture) {
  const body = {
    version: {
      commit: '0a95c343fb2c26e83ea2d09006216c51ac095232',
      startedAt: '2026-08-06T00:55:44.111Z',
      uptimeSec: 1596,
      nodeVersion: 'v20.19.0',
      ...(fixture.version ?? {}),
    },
    census: fixture.census ?? census(),
    state: fixture.state ?? { openOptions: [importedRow] },
    fills: { records: fixture.fills ?? [] },
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const json = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (path === '/api/health/version') return json(body.version);
    if (path === '/api/auth/login') { req.resume(); return json({ token: 'ctl-token' }); }
    if (path === '/api/options/basis-restatements') return json(body.census);
    if (path === '/api/state') return json(body.state);
    if (path === '/api/health/live-options-fee-slippage') return json(body.fills);
    return json({ error: 'not found' }, 404);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function run(port) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [TARGET, `--host=http://127.0.0.1:${port}`], {
      env: {
        ...process.env,
        TRADING_ADMIN_USERNAME: 'ctl',
        TRADING_ADMIN_PASSWORD: 'ctl',
      },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
}

let failures = 0;
const seenExits = new Set();

console.log('TRA-3010 — gate-A checker controls\n');
console.log(`target: ${TARGET}\n`);

for (const s of SCENARIOS) {
  const { server, port } = await startFixtureServer(s.fixture);
  const { code, out } = await run(port);
  server.close();

  seenExits.add(code);
  const missing = (s.must ?? []).filter(m => !out.includes(m));
  const ok = code === s.expect && missing.length === 0;
  if (!ok) failures += 1;

  console.log(`${ok ? 'PASS' : 'FAIL'}  [exit ${code}, want ${s.expect}]  ${s.name}`);
  if (!ok) {
    for (const m of missing) console.log(`        missing from output: ${JSON.stringify(m)}`);
    console.log(out.split('\n').map(l => `        | ${l}`).join('\n'));
  }
}

// The point of the whole harness: prove the checker can take every exit, not
// just the one the live book happens to produce. A control set that only ever
// observed exit 2 would reproduce the very defect it is here to rule out.
console.log('');
for (const want of [0, 1, 2, 3]) {
  const hit = seenExits.has(want);
  console.log(`${hit ? 'PASS' : 'FAIL'}  exit ${want} is reachable`);
  if (!hit) failures += 1;
}

console.log(`\n${SCENARIOS.length} scenario(s), ${failures} failure(s)`);
if (failures > 0) { console.log('\nCONTROLS: FAIL'); process.exit(1); }
console.log('\nCONTROLS: PASS');
