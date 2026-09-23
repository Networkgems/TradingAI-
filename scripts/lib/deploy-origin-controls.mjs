// deploy-origin-controls.mjs — TRA-4789
//
// The discrimination suite for `scripts/check-deploy-origin.mjs`.
//
// Two rules it is built to obey, both earned:
//
//  1. EVERY ARM IS A ONE-VARIABLE PAIR. A suite that only asserts CLEAN on clean input
//     rubber-stamps a jammed detector: a `grade()` that returned CLEAN unconditionally
//     would pass half of any one-sided suite. Each REFUSE arm below has a PROCEED partner
//     differing by exactly one field, and the run FAILS if any verdict is never reached.
//
//  2. ⛔ ARM 0 IS A NEGATIVE CONTROL OVER THE REAL INCIDENT BYTES. It replays the verbatim
//     capture in `__fixtures__/bqb1-2026-09-13-dashboard-deploys.json` — the three
//     `trigger: manual` dashboard deploys of 2026-09-13 and the 2026-09-21
//     `service_updated` deploy — through the SHIPPED main() and asserts it still reports
//     BYPASS and still names each one. This suite must not be able to go green because the
//     repro stopped biting.
//
// The call-site arms spawn the real script under `--import tra4789-render-origin-stub.mjs`.
// TRA-4420's defect was never a wrong predicate — it was the absence of a call site — and
// a table-only suite stays green when main() stops calling grade(), stops binding the
// history, or stops loading the acks.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { grade, classifyTrigger, loadAcks, ackFor, parseArgs, EXIT } from '../check-deploy-origin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-deploy-origin.mjs');
const STUB = path.join(REPO, 'scripts', 'lib', 'tra4789-render-origin-stub.mjs');
const FIXTURE = path.join(HERE, '__fixtures__', 'bqb1-2026-09-13-dashboard-deploys.json');

const LIVE = 'c389f286ed15939c7349d0a7ac1079b08fd78e79';
const SINCE = Date.parse('2026-09-01T00:00:00Z');
const NOW = Date.parse('2026-09-23T12:00:00Z');

// ── builders ─────────────────────────────────────────────────────────────────────────
const dep = (o = {}) => ({
  deploy: {
    id: o.id ?? 'dep-base',
    commit: { id: o.sha ?? LIVE },
    status: o.status ?? 'deactivated',
    trigger: 'trigger' in o ? o.trigger : 'api',
    createdAt: o.createdAt ?? '2026-09-20T10:00:00Z',
  },
  cursor: o.cursor ?? null,
});

const liveRow = () => dep({ id: 'dep-live', status: 'live', sha: LIVE, createdAt: '2026-09-22T10:00:00Z' });

const ev = (deployId, t = {}) => ({
  event: {
    type: 'deploy_started',
    details: {
      deployId,
      trigger: {
        clearCache: false,
        deployedByRender: false,
        envUpdated: false,
        firstBuild: false,
        manual: false,
        rollback: false,
        user: { email: 'eetiennecg@gmail.com', id: 'usr-x' },
        ...t,
      },
    },
  },
  cursor: null,
});

const base = (over = {}) => ({
  deploys: [liveRow()],
  events: [],
  sinceMs: SINCE,
  nowMs: NOW,
  acks: [],
  useAcks: true,
  liveSha: LIVE,
  historyComplete: true,
  ...over,
});

// ── table arms ───────────────────────────────────────────────────────────────────────
const ARMS = [];
const arm = (name, input, expect, why) => ARMS.push({ name, input, expect, why });

arm('PROCEED — every row is trigger=api, bound, complete', base({ deploys: [liveRow(), dep({ id: 'dep-a' })] }), 'CLEAN',
  'the partner for every BYPASS arm below');

arm('REFUSE — one row flipped to trigger=manual (THE INCIDENT)', base({ deploys: [liveRow(), dep({ id: 'dep-a', trigger: 'manual' })] }), 'BYPASS',
  'one variable off the arm above');

for (const t of ['deploy_hook', 'new_commit', 'blueprint_sync', 'rollback', 'service_updated', 'service_resumed', 'deployed_by_render', 'other']) {
  arm(`REFUSE — trigger=${t} is a bypass, not a pass`, base({ deploys: [liveRow(), dep({ id: `dep-${t}`, trigger: t })] }), 'BYPASS',
    'only `api` is sanctioned; every other KNOWN value is a gate that did not run');
}

arm('BLIND — an UNKNOWN trigger value is not an `api` trigger', base({ deploys: [liveRow(), dep({ id: 'dep-x', trigger: 'teleported' })] }), 'BLIND',
  'THE load-bearing arm: a value Render adds tomorrow must never read CLEAN');

arm('BLIND — a MISSING trigger field', base({ deploys: [liveRow(), dep({ id: 'dep-x', trigger: undefined })] }), 'BLIND',
  'absent is not `api`');

arm('BLIND — legs DISAGREE: deploy.trigger=api but the event says manual:true',
  base({ deploys: [liveRow(), dep({ id: 'dep-d' })], events: [ev('dep-d', { manual: true })] }), 'BLIND',
  'one of our two readings of Render is wrong and we do not know which');

arm('PROCEED — same rows, event says manual:false (the one-variable partner)',
  base({ deploys: [liveRow(), dep({ id: 'dep-d' })], events: [ev('dep-d', { manual: false })] }), 'CLEAN',
  'agreement is the only thing that changed');

arm('BLIND — legs disagree the other way: trigger=manual but the event says manual:false',
  base({ deploys: [liveRow(), dep({ id: 'dep-d', trigger: 'manual' })], events: [ev('dep-d', { manual: false })] }), 'BLIND',
  'the disagreement check must be symmetric, or it only catches one direction');

arm('PROCEED — trigger=manual WITH an agreeing event is an ordinary BYPASS, not a BLIND',
  base({ deploys: [liveRow(), dep({ id: 'dep-d', trigger: 'manual' })], events: [ev('dep-d', { manual: true })] }), 'BYPASS',
  'agreement must not be confused with innocence');

arm('PROCEED — a manual deploy OUTSIDE the window is excluded',
  base({ deploys: [liveRow(), dep({ id: 'dep-old', trigger: 'manual', createdAt: '2026-08-01T00:00:00Z' })] }), 'CLEAN',
  'partner below');
arm('REFUSE — the same row INSIDE the window',
  base({ deploys: [liveRow(), dep({ id: 'dep-old', trigger: 'manual', createdAt: '2026-09-02T00:00:00Z' })] }), 'BYPASS',
  'only createdAt moved');

arm('BLIND — an unreadable createdAt is INCLUDED, never quietly dropped',
  base({ deploys: [liveRow(), dep({ id: 'dep-bad', trigger: 'manual', createdAt: 'yesterday-ish' })] }), 'BLIND',
  'a mangled date must not be a way out of the population');

arm('BLIND — the newest `live` deploy is not the SHA the health route served',
  base({ deploys: [dep({ id: 'dep-other', status: 'live', sha: 'a'.repeat(40) })] }), 'BLIND',
  'this would otherwise grade ANOTHER service\'s clean history as bqb1\'s');
arm('PROCEED — the same history when the SHAs match',
  base({ deploys: [dep({ id: 'dep-other', status: 'live', sha: LIVE })] }), 'CLEAN',
  'only the sha moved');

arm('BLIND — no deploy with status `live` in the history at all',
  base({ deploys: [dep({ id: 'dep-a' })] }), 'BLIND', 'nothing binds this history to the box');

arm('BLIND — the deploys route returned zero rows',
  base({ deploys: [] }), 'BLIND', 'an unread history is not an empty one');

arm('BLIND — no live SHA (health route unreadable)',
  base({ deploys: [liveRow()], liveSha: null }), 'BLIND', 'without the served sha nothing is bound');

arm('BLIND — paging did not reach back to the window start',
  base({ deploys: [liveRow(), dep({ id: 'dep-a' })], historyComplete: false }), 'BLIND',
  'there is history we did not look at, so silence about it is worth nothing');

arm('PROCEED — a VACUOUS window (bound, readable, zero deploys inside) is CLEAN but flagged',
  base({ deploys: [dep({ id: 'dep-live', status: 'live', sha: LIVE, createdAt: '2026-08-01T00:00:00Z' })] }), 'CLEAN',
  'and `vacuous` must be true — see the extra assert below');

arm('PROCEED — a VALID ack clears the manual deploy from the exit code',
  base({
    deploys: [liveRow(), dep({ id: 'dep-m', trigger: 'manual' })],
    acks: [{ deployId: 'dep-m', issue: 'TRA-4789', reviewedAt: '2026-09-23T00:00:00Z', why: 'adjudicated' }],
  }), 'CLEAN', 'partner for the three ack-refusal arms below');

arm('REFUSE — an ack for a DIFFERENT deploy id does not cover this one',
  base({
    deploys: [liveRow(), dep({ id: 'dep-m', trigger: 'manual' })],
    acks: [{ deployId: 'dep-OTHER', issue: 'TRA-4789', reviewedAt: '2026-09-23T00:00:00Z', why: 'adjudicated' }],
  }), 'BYPASS', 'matching is by IDENTITY, never by class');

arm('REFUSE — an INCOMPLETE ack (no `why`) does not apply, and does not BLIND either',
  base({
    deploys: [liveRow(), dep({ id: 'dep-m', trigger: 'manual' })],
    acks: [{ deployId: 'dep-m', issue: 'TRA-4789', reviewedAt: '2026-09-23T00:00:00Z' }],
  }), 'BYPASS', 'one typo\'d ack must not swallow the unacked count behind a "could not check"');

arm('REFUSE — --no-acks ignores a valid ack (the raw truth)',
  base({
    deploys: [liveRow(), dep({ id: 'dep-m', trigger: 'manual' })],
    acks: [{ deployId: 'dep-m', issue: 'TRA-4789', reviewedAt: '2026-09-23T00:00:00Z', why: 'adjudicated' }],
    useAcks: false,
  }), 'BYPASS', 'the escape hatch must actually escape');

arm('REFUSE — a manual deploy the EVENTS history cannot reach is still a BYPASS',
  base({ deploys: [liveRow(), dep({ id: 'dep-m', trigger: 'manual' })], events: [], eventsReachedMs: Date.parse('2026-09-20T00:00:00Z') }), 'BYPASS',
  'UNREAD attribution must never be upgraded into agreement');

// ── the suite ────────────────────────────────────────────────────────────────────────
function runTable() {
  const results = [];
  for (const a of ARMS) {
    let got;
    try {
      got = grade(a.input);
    } catch (e) {
      results.push({ ok: false, name: a.name, actual: `threw ${e?.message ?? e}` });
      continue;
    }
    results.push({ ok: got.verdict === a.expect, name: a.name, actual: `${got.verdict} (want ${a.expect}) ${got.blind[0] ?? ''}`, verdict: got.verdict });
  }
  return results;
}

function extraAsserts() {
  const out = [];
  const check = (name, fn) => {
    try {
      fn();
      out.push({ ok: true, name });
    } catch (e) {
      out.push({ ok: false, name, actual: e?.message ?? String(e) });
    }
  };

  check('a VACUOUS clean is FLAGGED vacuous, so a zero cannot be read as a quiet week', () => {
    const g = grade(base({ deploys: [dep({ id: 'dep-live', status: 'live', sha: LIVE, createdAt: '2026-08-01T00:00:00Z' })] }));
    assert.equal(g.verdict, 'CLEAN');
    assert.equal(g.vacuous, true);
    assert.equal(g.counts.n, 0);
  });

  check('a BYPASS row carries the actor off the event, and an ABSENT actor reads null not false', () => {
    const g = grade(base({
      deploys: [liveRow(), dep({ id: 'dep-m', trigger: 'manual' }), dep({ id: 'dep-s', trigger: 'service_updated' })],
      events: [ev('dep-m', { manual: true }), { event: { type: 'deploy_started', details: { deployId: 'dep-s', trigger: { manual: false, envUpdated: true } } } }],
    }));
    const m = g.rows.find((r) => r.id === 'dep-m');
    const s = g.rows.find((r) => r.id === 'dep-s');
    assert.equal(m.attribution.actor, 'eetiennecg@gmail.com');
    assert.equal(s.attribution.state, 'read');
    assert.equal(s.attribution.actor, null, 'an absent user must be null, not invented');
    assert.equal(s.attribution.envUpdated, true);
  });

  check('an incomplete ack is reported as a WARNING and the row still counts', () => {
    const g = grade(base({
      deploys: [liveRow(), dep({ id: 'dep-m', trigger: 'manual' })],
      acks: [{ deployId: 'dep-m', issue: 'TRA-4789' }],
    }));
    assert.equal(g.counts.unacked, 1);
    assert.match(g.warnings.join(' '), /missing reviewedAt, why/);
    assert.equal(g.blind.length, 0, 'an incomplete ack must not BLIND the run');
  });

  check('classifyTrigger: api is the ONLY sanctioned value', () => {
    assert.equal(classifyTrigger('api').kind, 'sanctioned');
    for (const t of ['manual', 'deploy_hook', 'new_commit', 'service_updated', 'rollback', 'other']) {
      assert.equal(classifyTrigger(t).kind, 'bypass', t);
    }
    assert.equal(classifyTrigger('API').kind, 'unknown', 'the match is exact — a cased variant is unknown, not sanctioned');
    assert.equal(classifyTrigger('').kind, 'unknown');
    assert.equal(classifyTrigger(null).kind, 'unknown');
  });

  check('ackFor matches on exact deploy id only', () => {
    const acks = [{ deployId: 'dep-m', issue: 'i', reviewedAt: 'r', why: 'w' }];
    assert.ok(ackFor('dep-m', acks));
    assert.equal(ackFor('dep-m2', acks), null);
    assert.equal(ackFor('dep-', acks), null, 'no prefix matching');
  });

  check('loadAcks: missing file is "none", malformed file is BLIND', () => {
    const miss = loadAcks(path.join(os.tmpdir(), `nope-${Date.now()}.json`));
    assert.equal(miss.blind, undefined);
    assert.deepEqual(miss.acks, []);

    const tmp = path.join(os.tmpdir(), `acks-bad-${Date.now()}.json`);
    fs.writeFileSync(tmp, '{not json', 'utf8');
    assert.match(loadAcks(tmp).blind ?? '', /does not parse/);
    fs.writeFileSync(tmp, '{"acks": "nope"}', 'utf8');
    assert.match(loadAcks(tmp).blind ?? '', /no `acks` array/);
    fs.rmSync(tmp, { force: true });
  });

  check('the SHIPPED ack ledger parses and every entry is complete', () => {
    const r = loadAcks(path.join(REPO, 'ops', 'deploy-origin-acks.json'));
    assert.equal(r.blind, undefined, r.blind ?? '');
    for (const a of r.acks) {
      assert.ok(ackFor(a.deployId, r.acks)?.invalid === undefined, `shipped ack ${a.deployId} is incomplete`);
    }
  });

  check('the argument guard matches NEGATIVELY (TRA-4420)', () => {
    assert.equal(parseArgs(['--days=30']).usage, undefined);
    assert.match(parseArgs(['--dayz=30']).usage ?? '', /unrecognised/);
    assert.match(parseArgs(['--days', '30']).usage ?? '', /needs its value attached/);
    assert.match(parseArgs(['--commmit=abc']).usage ?? '', /unrecognised/);
    assert.match(parseArgs(['-x']).usage ?? '', /unrecognised/);
  });

  return out;
}

// ── call-site arms: the SHIPPED main(), offline ──────────────────────────────────────
function spawnArm({ stub, args = [], env = {} }) {
  const r = spawnSync(process.execPath, ['--import', `file://${STUB.replace(/\\/g, '/')}`, SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, RENDER_API_KEY: 'stub-key', TRA4789_STUB: JSON.stringify(stub), ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function runCallSite() {
  const out = [];
  const check = (name, fn) => {
    try {
      fn();
      out.push({ ok: true, name });
    } catch (e) {
      out.push({ ok: false, name, actual: e?.message ?? String(e) });
    }
  };

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  // The fixture rows are all `deactivated` (they are history). Binding needs a current
  // `live` row, so ONE synthetic row is prepended — the incident bytes themselves are
  // untouched.
  const synthLive = { deploy: { id: 'dep-synth-live', commit: { id: LIVE }, status: 'live', trigger: 'api', createdAt: '2026-09-23T10:40:06Z' }, cursor: null };
  const health = { commit: LIVE, startedAt: '2026-09-23T10:42:33.300Z' };
  const WIN = ['--since=2026-09-01T00:00:00Z'];

  check('ARM 0 — the REAL 2026-09-13 bytes through the SHIPPED main() ⇒ BYPASS, all four named', () => {
    const tmp = path.join(os.tmpdir(), `acks-empty-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ acks: [] }), 'utf8');
    const r = spawnArm({ stub: { deploys: [synthLive, ...fixture.deploys], events: fixture.events, health }, args: [...WIN, `--acks=${tmp}`] });
    fs.rmSync(tmp, { force: true });
    assert.equal(r.code, EXIT.BYPASS, r.out.slice(-1200));
    for (const id of ['dep-daj21q7qj5pc73bvbul0', 'dep-daj2nhbm8hqs73enqj00', 'dep-daj9nl1594qs73bbhcg0', 'dep-dao939egekts73bbv9cg']) {
      assert.ok(r.out.includes(id), `the report must NAME ${id}`);
    }
    assert.ok(r.out.includes('eetiennecg@gmail.com'), 'the actor must reach the report — the event DOES carry one');
    assert.match(r.out, /VERDICT = BYPASS/);
  });

  check('ARM 0b — the same bytes with all four ACKED ⇒ CLEAN (the one-variable partner)', () => {
    const tmp = path.join(os.tmpdir(), `acks-full-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({
      acks: ['dep-daj21q7qj5pc73bvbul0', 'dep-daj2nhbm8hqs73enqj00', 'dep-daj9nl1594qs73bbhcg0', 'dep-dao939egekts73bbv9cg']
        .map((deployId) => ({ deployId, issue: 'TRA-4789', reviewedAt: '2026-09-23T00:00:00Z', why: 'control fixture' })),
    }), 'utf8');
    const r = spawnArm({ stub: { deploys: [synthLive, ...fixture.deploys], events: fixture.events, health }, args: [...WIN, `--acks=${tmp}`] });
    fs.rmSync(tmp, { force: true });
    assert.equal(r.code, EXIT.CLEAN, r.out.slice(-1200));
    assert.match(r.out, /VERDICT = CLEAN/);
    assert.ok(r.out.includes('dep-daj21q7qj5pc73bvbul0'), 'an ACKED bypass is still PRINTED — an ack clears the exit code, never the record');
  });

  check('ARM 0c — --no-acks over ARM 0b\'s ledger ⇒ BYPASS again', () => {
    const tmp = path.join(os.tmpdir(), `acks-full2-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({
      acks: ['dep-daj21q7qj5pc73bvbul0', 'dep-daj2nhbm8hqs73enqj00', 'dep-daj9nl1594qs73bbhcg0', 'dep-dao939egekts73bbv9cg']
        .map((deployId) => ({ deployId, issue: 'TRA-4789', reviewedAt: '2026-09-23T00:00:00Z', why: 'control fixture' })),
    }), 'utf8');
    const r = spawnArm({ stub: { deploys: [synthLive, ...fixture.deploys], events: fixture.events, health }, args: [...WIN, `--acks=${tmp}`, '--no-acks'] });
    fs.rmSync(tmp, { force: true });
    assert.equal(r.code, EXIT.BYPASS, r.out.slice(-800));
  });

  check('call site — an all-REST history ⇒ CLEAN, and the report PRINTS the "api ≠ the script ran" caveat', () => {
    const r = spawnArm({ stub: { deploys: [synthLive], events: [], health }, args: WIN });
    assert.equal(r.code, EXIT.CLEAN, r.out.slice(-800));
    assert.match(r.out, /does NOT prove render-redeploy\.mjs/, 'a green whose limits are only in the header is a green that gets over-read');
  });

  check('call site — an UNKNOWN trigger ⇒ BLIND, not CLEAN', () => {
    const odd = { deploy: { id: 'dep-odd', commit: { id: LIVE }, status: 'deactivated', trigger: 'teleported', createdAt: '2026-09-22T00:00:00Z' }, cursor: null };
    const r = spawnArm({ stub: { deploys: [synthLive, odd], events: [], health }, args: WIN });
    assert.equal(r.code, EXIT.BLIND, r.out.slice(-800));
  });

  check('call site — the health route is DOWN ⇒ BLIND (the history cannot be bound)', () => {
    const r = spawnArm({ stub: { deploys: [synthLive], events: [], health: null }, args: WIN });
    assert.equal(r.code, EXIT.BLIND, r.out.slice(-800));
  });

  check('call site — the deploys route 503s ⇒ BLIND', () => {
    const r = spawnArm({ stub: { deploys: null, deploysStatus: 503, events: [], health }, args: WIN });
    assert.equal(r.code, EXIT.BLIND, r.out.slice(-800));
  });

  check('call site — the EVENTS route 503s but deploys read fine ⇒ the classification still grades', () => {
    const manual = { deploy: { id: 'dep-m', commit: { id: LIVE }, status: 'deactivated', trigger: 'manual', createdAt: '2026-09-22T00:00:00Z' }, cursor: null };
    const r = spawnArm({ stub: { deploys: [synthLive, manual], events: null, eventsStatus: 503, health }, args: WIN });
    assert.equal(r.code, EXIT.BYPASS, r.out.slice(-800));
    assert.match(r.out, /attribution leg UNREAD/, 'an UNREAD arm must be printed with its reason, never silently absent');
  });

  check('call site — no RENDER_API_KEY ⇒ BLIND, never 0', () => {
    const r = spawnArm({ stub: { deploys: [synthLive], events: [], health }, args: WIN, env: { RENDER_API_KEY: '' } });
    assert.equal(r.code, EXIT.BLIND, r.out.slice(-800));
  });

  check('call site — an unrecognised argument ⇒ exit 2 NAMING it (never a silent deploy-shaped default)', () => {
    const r = spawnArm({ stub: { deploys: [synthLive], events: [], health }, args: ['--dayz=30'] });
    assert.equal(r.code, EXIT.USAGE, r.out.slice(-800));
    assert.ok(r.out.includes('--dayz=30'), 'the offender must be named');
  });

  check('call site — --help exits 0 and prints usage', () => {
    const r = spawnArm({ stub: {}, args: ['--help'] });
    assert.equal(r.code, EXIT.CLEAN);
    assert.match(r.out, /check-deploy-origin\.mjs/);
  });

  return out;
}

export function runControls() {
  const table = runTable();
  const extra = extraAsserts();
  const callsite = runCallSite();
  const all = [...table, ...extra, ...callsite];

  for (const r of all) console.log(`[deploy-origin] control ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n[deploy-origin]        got: ${r.actual}`}`);

  // ⛔ A one-sided suite rubber-stamps a jammed detector. Assert every verdict was
  // actually REACHED by the table, so a grade() hard-wired to any single answer fails
  // here even if every arm that expects that answer passes.
  const reached = new Set(table.filter((r) => r.ok).map((r) => r.verdict));
  const missing = ['CLEAN', 'BYPASS', 'BLIND'].filter((v) => !reached.has(v));

  const bad = all.filter((r) => !r.ok);
  console.log('');
  console.log(`[deploy-origin] controls: ${all.length - bad.length}/${all.length} ok; verdicts reached: ${[...reached].sort().join(', ') || 'NONE'}`);
  if (missing.length) {
    console.log(`[deploy-origin] CONTROLS FAILED — verdict(s) never reached: ${missing.join(', ')}`);
    return 1;
  }
  if (bad.length) {
    console.log(`[deploy-origin] CONTROLS FAILED — ${bad.length} arm(s) above.`);
    return 1;
  }
  console.log('[deploy-origin] controls PASS — the detector discriminates.');
  return 0;
}
