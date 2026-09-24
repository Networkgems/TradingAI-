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

import {
  grade, classifyTrigger, loadAcks, ackFor, parseArgs, EXIT,
  resolveAckLedger, probeGit, parseLedgerText, LEDGER_REL, ACK_REF,
} from '../check-deploy-origin.mjs';

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
    assert.equal(parseArgs(['--acks-from=worktree']).usage, undefined);
    assert.match(parseArgs(['--acks-from', 'worktree']).usage ?? '', /needs its value attached/);
  });

  // ── the ledger resolver, at the table level (TRA-4868) ──────────────────────────────
  // git is STUBBED here so every failure mode is reachable without manufacturing one. The
  // real-git arms live in runCallSite(); neither replaces the other — this half proves the
  // predicate, that half proves main() hands it the right file.
  const BLOB_MAIN = 'd99028df000000000000000000000000000abcd1';
  const MAIN_LEDGER = JSON.stringify({
    acks: [
      { deployId: 'dep-m', issue: 'TRA-4845', reviewedAt: '2026-09-24T00:00:00Z', why: 'adjudicated' },
    ],
  });
  const WORKTREE_LEDGER = JSON.stringify({
    acks: [
      { deployId: 'dep-m', issue: 'TRA-4845', reviewedAt: '2026-09-24T00:00:00Z', why: 'adjudicated' },
      { deployId: 'dep-UNCOMMITTED', issue: 'TRA-9999', reviewedAt: '2026-09-24T00:00:00Z', why: 'only in my checkout' },
    ],
  });
  const gitMap = (over = {}) => ({
    'rev-parse --show-toplevel': '/repo\n',
    'rev-parse HEAD': '9582420af8eb7518f56546667390fadd960bfdc7\n',
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'fetch --quiet origin main': '',
    'rev-parse origin/main': '0ba141c882be07be6bc3fed1070390ac13a1908b\n',
    'rev-list --count HEAD..origin/main': '172\n',
    [`rev-parse origin/main:${LEDGER_REL}`]: `${BLOB_MAIN}\n`,
    [`cat-file blob ${BLOB_MAIN}`]: MAIN_LEDGER,
    [`status --porcelain -- ${LEDGER_REL}`]: ` M ${LEDGER_REL}\n`,
    [`hash-object ${LEDGER_REL}`]: '1e3a98c8000000000000000000000000000abcd2\n',
    ...over,
  });
  const fakeGit = (map) => (args) => {
    const key = args.join(' ');
    if (!Object.prototype.hasOwnProperty.call(map, key)) return { ok: false, status: 128, stdout: '', stderr: `no stub for \`git ${key}\`` };
    const hit = map[key];
    if (hit === null) return { ok: false, status: 1, stdout: '', stderr: `\`git ${key}\` refused` };
    return { ok: true, status: 0, stdout: hit, stderr: '' };
  };
  const resolve = (mode, over = {}, extra = {}) =>
    resolveAckLedger({
      mode,
      repo: '/repo',
      runGit: fakeGit(gitMap(over)),
      exists: () => true,
      readFile: () => WORKTREE_LEDGER,
      ...extra,
    });

  check('resolver: the DEFAULT grades origin/main\'s blob, NOT the working tree\'s copy', () => {
    const r = resolve('origin');
    assert.equal(r.blind, null, r.blind ?? '');
    assert.deepEqual(r.acks.map((a) => a.deployId), ['dep-m'], 'the worktree copy carries a second ack; it must not be here');
    assert.deepEqual(r.committedAcks.map((a) => a.deployId), ['dep-m']);
    assert.equal(r.label, `${ACK_REF}:${LEDGER_REL}`);
  });

  check('resolver: provenance names the repo, HEAD, the behind-count, the fetch and the dirty flag', () => {
    const line = resolve('origin').lines.join('\n');
    assert.match(line, /HEAD 9582420a \(main\)/);
    assert.match(line, /172 commit\(s\) behind origin\/main/);
    assert.match(line, /fetch=ok/);
    assert.match(line, /DIRTY vs HEAD/);
    assert.match(line, /DIFFERS from origin\/main's and was IGNORED/);
  });

  check('resolver: a FAILED git fetch is BLIND, and the same map with a working fetch is not (one variable)', () => {
    const bad = resolve('origin', { 'fetch --quiet origin main': null });
    assert.match(bad.blind ?? '', /git fetch origin main.{0,40}failed/i);
    assert.match(bad.blind ?? '', /BLIND, not a footnote/);
    assert.equal(resolve('origin').blind, null, 'the partner must be clean, or the arm above proves nothing');
  });

  check('resolver: an unresolvable origin/main:<ledger> is BLIND, never "no acknowledgements"', () => {
    const r = resolve('origin', { [`rev-parse origin/main:${LEDGER_REL}`]: null });
    assert.match(r.blind ?? '', /does not resolve/);
    assert.deepEqual(r.acks, []);
  });

  check('resolver: NOT a git checkout is BLIND in origin mode — an unreadable provenance is not a clean one', () => {
    const r = resolve('origin', { 'rev-parse --show-toplevel': null });
    assert.match(r.blind ?? '', /is not a git checkout/);
  });

  check('resolver: a ledger blob that does not parse is BLIND, not an empty ledger', () => {
    const r = resolve('origin', { [`cat-file blob ${BLOB_MAIN}`]: '{not json' });
    assert.match(r.blind ?? '', /does not parse as JSON/);
  });

  check('resolver: worktree mode marks an ack origin/main does NOT carry, and ackFor then REFUSES it', () => {
    const r = resolve('worktree');
    assert.equal(r.blind, null, r.blind ?? '');
    assert.equal(r.acks.length, 2);
    assert.equal(ackFor('dep-m', r.acks)?.invalid, undefined, 'the committed one still applies');
    assert.match(ackFor('dep-UNCOMMITTED', r.acks)?.invalid ?? '', /exists ONLY in the graded working-tree ledger/);
    assert.match(r.lines.join('\n'), /1 ack\(s\) present ONLY here and therefore INERT \[dep-UNCOMMITTED\]/);
  });

  check('resolver: worktree mode is BLIND when origin/main is unreadable — it could not tell committed from not', () => {
    const r = resolve('worktree', { [`cat-file blob ${BLOB_MAIN}`]: null });
    assert.match(r.blind ?? '', /UNCOMMITTED ack cannot be told from a committed one/);
  });

  check('resolver: --acks=<path> needs NO git at all, and is labelled an OVERRIDE', () => {
    const tmp = path.join(os.tmpdir(), `acks-explicit-${Date.now()}.json`);
    fs.writeFileSync(tmp, MAIN_LEDGER, 'utf8');
    try {
      const r = resolveAckLedger({ mode: 'path', explicitPath: tmp, repo: os.tmpdir(), runGit: fakeGit({}) });
      assert.equal(r.blind, null, r.blind ?? '');
      assert.deepEqual(r.acks.map((a) => a.deployId), ['dep-m']);
      assert.match(r.lines.join('\n'), /OVERRIDE --acks=/);
      assert.match(r.lines.join('\n'), /not a git checkout/, 'and it must SAY no cross-check was possible');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  check('resolver: --no-acks resolves to nothing and never touches git', () => {
    let called = 0;
    const r = resolveAckLedger({ mode: 'none', repo: '/repo', runGit: () => { called += 1; return { ok: false, status: 1, stdout: '', stderr: 'x' }; } });
    assert.equal(called, 0);
    assert.deepEqual(r.acks, []);
    assert.equal(r.blind, null);
  });

  check('probeGit records EVERY failure it hits rather than letting a field read as a benign default', () => {
    const p = probeGit({ repo: '/repo', runGit: fakeGit(gitMap({ 'rev-parse HEAD': null, 'rev-list --count HEAD..origin/main': null })) });
    assert.equal(p.head, null);
    assert.equal(p.behind, null, 'an unreadable behind-count must be null, never 0');
    assert.equal(p.errors.length, 2);
  });

  check('parseLedgerText and loadAcks agree — one parser, so a blob and a file cannot be judged differently', () => {
    const tmp = path.join(os.tmpdir(), `acks-agree-${Date.now()}.json`);
    fs.writeFileSync(tmp, '{"acks": "nope"}', 'utf8');
    try {
      assert.match(parseLedgerText('{"acks": "nope"}', 'X').blind ?? '', /no `acks` array/);
      assert.match(loadAcks(tmp).blind ?? '', /no `acks` array/);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  check('grade: committedAcks NAMES a stale alarm and can NEVER clear one', () => {
    const wire = {
      deploys: [liveRow(), dep({ id: 'dep-m', trigger: 'manual' })],
      committedAcks: [{ deployId: 'dep-m', issue: 'TRA-4845', reviewedAt: '2026-09-24T00:00:00Z', why: 'adjudicated' }],
    };
    const g = grade(base(wire));
    assert.equal(g.verdict, 'BYPASS', 'the COMMITTED ledger is a diagnosis, not an ack — it must not clear the exit code');
    assert.equal(g.counts.unacked, 1);
    assert.equal(g.counts.staleAlarms, 1);
    assert.equal(g.rows.find((r) => r.id === 'dep-m').staleAck.issue, 'TRA-4845');
    // one variable: with the ack actually IN the graded ledger there is nothing stale
    const clean = grade(base({ ...wire, acks: wire.committedAcks }));
    assert.equal(clean.verdict, 'CLEAN');
    assert.equal(clean.counts.staleAlarms, 0);
  });

  return out;
}

// ── call-site arms: the SHIPPED main(), offline ──────────────────────────────────────
function spawnArm({ stub, args = [], env = {}, script = SCRIPT }) {
  const r = spawnSync(process.execPath, ['--import', `file://${STUB.replace(/\\/g, '/')}`, script, ...args], {
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
  // ⛔ TRA-4868 — the default ack ledger is now `git show origin/main:…`, so a bare run does
  // a `git fetch` and ~8 further git calls. Every arm below that is not ABOUT the ledger
  // therefore says `--no-acks`, which resolves to nothing and touches git zero times: the
  // suite stays OFFLINE, hermetic and fast. It also removes a hidden dependency these arms
  // already had — they used to read the SHIPPED ledger, so acking a deploy the fixture uses
  // would silently have changed what they were testing.
  const NOACKS = '--no-acks';
  // Still needed by the one arm that asserts --acks= and --acks-from= cannot be combined.
  const EMPTY_ACKS = path.join(os.tmpdir(), `deploy-origin-empty-acks-${process.pid}.json`);
  fs.writeFileSync(EMPTY_ACKS, JSON.stringify({ acks: [] }), 'utf8');

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
    const r = spawnArm({ stub: { deploys: [synthLive], events: [], health }, args: [...WIN, NOACKS] });
    assert.equal(r.code, EXIT.CLEAN, r.out.slice(-800));
    assert.match(r.out, /does NOT prove render-redeploy\.mjs/, 'a green whose limits are only in the header is a green that gets over-read');
  });

  check('call site — an UNKNOWN trigger ⇒ BLIND, not CLEAN', () => {
    const odd = { deploy: { id: 'dep-odd', commit: { id: LIVE }, status: 'deactivated', trigger: 'teleported', createdAt: '2026-09-22T00:00:00Z' }, cursor: null };
    const r = spawnArm({ stub: { deploys: [synthLive, odd], events: [], health }, args: [...WIN, NOACKS] });
    assert.equal(r.code, EXIT.BLIND, r.out.slice(-800));
  });

  check('call site — the health route is DOWN ⇒ BLIND (the history cannot be bound)', () => {
    const r = spawnArm({ stub: { deploys: [synthLive], events: [], health: null }, args: [...WIN, NOACKS] });
    assert.equal(r.code, EXIT.BLIND, r.out.slice(-800));
  });

  check('call site — the deploys route 503s ⇒ BLIND', () => {
    const r = spawnArm({ stub: { deploys: null, deploysStatus: 503, events: [], health }, args: [...WIN, NOACKS] });
    assert.equal(r.code, EXIT.BLIND, r.out.slice(-800));
  });

  check('call site — the EVENTS route 503s but deploys read fine ⇒ the classification still grades', () => {
    const manual = { deploy: { id: 'dep-m', commit: { id: LIVE }, status: 'deactivated', trigger: 'manual', createdAt: '2026-09-22T00:00:00Z' }, cursor: null };
    const r = spawnArm({ stub: { deploys: [synthLive, manual], events: null, eventsStatus: 503, health }, args: [...WIN, NOACKS] });
    assert.equal(r.code, EXIT.BYPASS, r.out.slice(-800));
    assert.match(r.out, /attribution leg UNREAD/, 'an UNREAD arm must be printed with its reason, never silently absent');
  });

  check('call site — no RENDER_API_KEY ⇒ BLIND, never 0', () => {
    const r = spawnArm({ stub: { deploys: [synthLive], events: [], health }, args: [...WIN, NOACKS], env: { RENDER_API_KEY: '' } });
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

  // ── the entry guard (TRA-4821) ──────────────────────────────────────────────────────
  //
  // Grading a shipped blob means writing it somewhere else under some other name. If the
  // entry test keys on the NAME, that copy runs main() zero times and exits 0 having
  // printed nothing — which reads exactly like CLEAN. These two arms differ in ONE
  // variable: the entry predicate. The RENAMED-COPY arm must reach the same verdict as
  // ARM 0 above; the partner replays the OLD name-keyed predicate over the SAME bytes and
  // asserts it is silent, so this pair fails if the hazard it documents ever stops being
  // real (an arm that can only pass is not a control).
  const renamedCopy = (transform) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-origin-entry-'));
    const dst = path.join(dir, 'graded-blob.mjs');
    const src = fs.readFileSync(SCRIPT, 'utf8');
    fs.writeFileSync(dst, transform ? transform(src) : src, 'utf8');
    return { dir, dst };
  };

  check('call site — the script RENAMED (graded as a blob) STILL RUNS: exit 1 + the deploy named, never a silent 0', () => {
    const { dir, dst } = renamedCopy();
    const tmp = path.join(dir, 'acks-empty.json');
    fs.writeFileSync(tmp, JSON.stringify({ acks: [] }), 'utf8');
    try {
      const r = spawnArm({ script: dst, stub: { deploys: [synthLive, ...fixture.deploys], events: fixture.events, health }, args: [...WIN, `--acks=${tmp}`] });
      assert.notEqual(r.out.trim(), '', 'a detector that prints NOTHING and exits 0 is the failure this arm exists for');
      assert.equal(r.code, EXIT.BYPASS, r.out.slice(-1200));
      assert.ok(r.out.includes('dep-daj21q7qj5pc73bvbul0'), 'the renamed copy must reach the same report as ARM 0');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  check('call site — the OLD name-keyed predicate over the SAME bytes IS silent+0 (the hazard is real, one variable)', () => {
    const OLD = "if (process.argv[1]?.endsWith('check-deploy-origin.mjs')) {";
    const { dir, dst } = renamedCopy((src) => {
      const i = src.lastIndexOf('if (isEntrypoint) {');
      assert.notEqual(i, -1, 'the shipped entry guard must still be `if (isEntrypoint) {` — this arm rewrites it by hand');
      return `${src.slice(0, i)}${OLD}${src.slice(i + 'if (isEntrypoint) {'.length)}`;
    });
    const tmp = path.join(dir, 'acks-empty.json');
    fs.writeFileSync(tmp, JSON.stringify({ acks: [] }), 'utf8');
    try {
      const r = spawnArm({ script: dst, stub: { deploys: [synthLive, ...fixture.deploys], events: fixture.events, health }, args: [...WIN, `--acks=${tmp}`] });
      assert.equal(r.code, EXIT.CLEAN, 'the old predicate exited non-zero — then it was not the defect this fix names');
      assert.equal(r.out.trim(), '', 'the old predicate printed something — then it was not silent and this pair proves nothing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── the ack LEDGER's provenance (TRA-4868) ──────────────────────────────────────────
  //
  // These arms are NOT stubbed at the git layer. Each one builds a REAL throwaway repo —
  // an `upstream` with a committed ledger, a `clone` of it carrying this very script — and
  // lets the shipped `resolveAckLedger` run real `git fetch` / `git show` against it. A
  // table-only pass here would prove nothing: the defect was never a wrong predicate, it
  // was WHICH FILE main() handed to the predicate. Offline throughout (origin is a path).
  const ACK_ROW = (deployId) => ({ deployId, issue: 'TRA-4845', reviewedAt: '2026-09-24T00:00:00Z', why: 'control fixture' });
  const F4 = ['dep-daj21q7qj5pc73bvbul0', 'dep-daj2nhbm8hqs73enqj00', 'dep-daj9nl1594qs73bbhcg0', 'dep-dao939egekts73bbv9cg'];

  const gitIn = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `git ${args.join(' ')} in ${cwd} → ${r.stderr ?? r.error?.message ?? ''}`);
    return r.stdout ?? '';
  };
  const rmTree = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* a tmp dir git left read-only objects in; the arms never depend on cleanup */ }
  };

  function ledgerRepo({ mainAcks, worktreeAcks = null }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-origin-ledger-'));
    const upstream = path.join(dir, 'upstream');
    const clone = path.join(dir, 'clone');
    fs.mkdirSync(path.join(upstream, 'ops'), { recursive: true });
    gitIn(dir, 'init', '--quiet', upstream);
    // Set the branch BEFORE the first commit — `--initial-branch` is too new to rely on.
    gitIn(upstream, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    gitIn(upstream, 'config', 'user.email', 'controls@example.invalid');
    gitIn(upstream, 'config', 'user.name', 'deploy-origin controls');
    gitIn(upstream, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(upstream, LEDGER_REL), `${JSON.stringify({ acks: mainAcks }, null, 2)}\n`, 'utf8');
    gitIn(upstream, 'add', '-A');
    gitIn(upstream, 'commit', '--quiet', '-m', 'ledger');
    gitIn(dir, 'clone', '--quiet', upstream, clone);
    fs.mkdirSync(path.join(clone, 'scripts'), { recursive: true });
    const script = path.join(clone, 'scripts', 'check-deploy-origin.mjs');
    fs.copyFileSync(SCRIPT, script);
    if (worktreeAcks) fs.writeFileSync(path.join(clone, LEDGER_REL), `${JSON.stringify({ acks: worktreeAcks }, null, 2)}\n`, 'utf8');
    return { dir, upstream, clone, script };
  }

  const STUB4 = () => ({ deploys: [synthLive, ...fixture.deploys], events: fixture.events, health });

  // ONE repo, graded twice. The two arms below differ by exactly one thing — which ledger
  // main() was pointed at — so they MUST share a subject; rebuilding it per arm would let
  // them drift apart and quietly stop being a pair.
  const STALE = ledgerRepo({ mainAcks: F4.map(ACK_ROW), worktreeAcks: F4.slice(0, 3).map(ACK_ROW) });

  check('LEDGER — a ledger MISSING an ack main carries: the DEFAULT grades origin/main ⇒ CLEAN', () => {
    const r = spawnArm({ script: STALE.script, stub: STUB4(), args: WIN });
    assert.equal(r.code, EXIT.CLEAN, r.out.slice(-1800));
    assert.match(r.out, /source {2}origin\/main:ops\/deploy-origin-acks\.json {2}blob [0-9a-f]{8} {2}4 ack\(s\)/, 'the SOURCE and its blob must be printed');
    assert.match(r.out, /repo {4}.+HEAD [0-9a-f]{8}.+commit\(s\) behind origin\/main {2}fetch=ok/, 'repo, HEAD and behind-count must be printed');
    assert.match(r.out, /DIFFERS from origin\/main's and was IGNORED/, 'a working copy that differs must be NAMED as ignored, not silently skipped');
  });

  check('LEDGER — ONE variable: the SAME repo graded --acks-from=worktree ⇒ BYPASS, naming STALENESS as the cause', () => {
    const r = spawnArm({ script: STALE.script, stub: STUB4(), args: [...WIN, '--acks-from=worktree'] });
    assert.equal(r.code, EXIT.BYPASS, r.out.slice(-1800));
    assert.ok(r.out.includes('dep-dao939egekts73bbv9cg'), 'the deploy the stale ledger lost must be named');
    assert.match(r.out, /STALE LEDGER/, 'a settled deploy re-raised by a stale ledger must be labelled STALE, not re-adjudicated (TRA-4836)');
    assert.match(r.out, /stale-ledger=1/, 'and the count must be on the summary line beside the others');
    assert.match(r.out, /1 ack\(s\) origin\/main carries that this ledger LACKS \[dep-dao939egekts73bbv9cg\]/);
  });

  rmTree(STALE.dir);

  check('LEDGER — ⛔ THE EXPENSIVE DIRECTION: an ack that exists ONLY in the working tree must NOT read CLEAN', () => {
    const R = ledgerRepo({ mainAcks: F4.slice(0, 3).map(ACK_ROW), worktreeAcks: F4.map(ACK_ROW) });
    try {
      const w = spawnArm({ script: R.script, stub: STUB4(), args: [...WIN, '--acks-from=worktree'] });
      assert.notEqual(w.code, EXIT.CLEAN, 'an UNCOMMITTED ack bought a green — that is exactly the defect TRA-4868 names');
      assert.equal(w.code, EXIT.BYPASS, w.out.slice(-1800));
      assert.match(w.out, /1 ack\(s\) present ONLY here and therefore INERT \[dep-dao939egekts73bbv9cg\]/);
      assert.match(w.out, /exists ONLY in the graded working-tree ledger/, 'and it must say WHY that ack did not apply');
      const d = spawnArm({ script: R.script, stub: STUB4(), args: WIN });
      assert.equal(d.code, EXIT.BYPASS, 'the default never saw the uncommitted ack at all');
    } finally {
      rmTree(R.dir);
    }
  });

  check('LEDGER — the one-variable PARTNER: the same worktree ledger, with main carrying all four ⇒ CLEAN', () => {
    const R = ledgerRepo({ mainAcks: F4.map(ACK_ROW), worktreeAcks: F4.map(ACK_ROW) });
    try {
      const w = spawnArm({ script: R.script, stub: STUB4(), args: [...WIN, '--acks-from=worktree'] });
      assert.equal(w.code, EXIT.CLEAN, w.out.slice(-1800));
      assert.match(w.out, /0 ack\(s\) present ONLY here/, 'nothing is uncommitted here — only whether main carries it moved');
    } finally {
      rmTree(R.dir);
    }
  });

  check('LEDGER — a FAILED `git fetch` reads BLIND (3), never CLEAN (one variable: origin reachable or not)', () => {
    const R = ledgerRepo({ mainAcks: F4.map(ACK_ROW) });
    try {
      const ok = spawnArm({ script: R.script, stub: STUB4(), args: WIN });
      assert.equal(ok.code, EXIT.CLEAN, ok.out.slice(-1500));
      // THE variable. `origin/main` still resolves locally, so the fetch is the only thing
      // that moved — a stale ref that silently grades an old ledger is the whole ticket.
      gitIn(R.clone, 'remote', 'set-url', 'origin', path.join(R.dir, 'no-such-upstream'));
      const gone = spawnArm({ script: R.script, stub: STUB4(), args: WIN });
      assert.equal(gone.code, EXIT.BLIND, gone.out.slice(-1800));
      assert.match(gone.out, /git fetch origin main.{0,40}failed/i, 'BLIND must name the fetch, not just refuse');
      assert.match(gone.out, /PROVENANCE UNREADABLE/);
    } finally {
      rmTree(R.dir);
    }
  });

  check('LEDGER — --acks-from with an unknown value is exit 2 NAMING it, never a silent fall-back', () => {
    const r = spawnArm({ stub: { deploys: [synthLive], events: [], health }, args: [...WIN, '--acks-from=upstream'] });
    assert.equal(r.code, EXIT.USAGE, r.out.slice(-800));
    assert.ok(r.out.includes('--acks-from=upstream'), 'the offender must be named');
  });

  check('LEDGER — --acks= together with --acks-from= is exit 2 (two answers to "which ledger" is not an answer)', () => {
    const r = spawnArm({ stub: { deploys: [synthLive], events: [], health }, args: [...WIN, `--acks=${EMPTY_ACKS}`, '--acks-from=origin'] });
    assert.equal(r.code, EXIT.USAGE, r.out.slice(-800));
  });

  rmTree(EMPTY_ACKS);
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
