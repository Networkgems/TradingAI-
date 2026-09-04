#!/usr/bin/env node
// tra2387-auth-secret-gate-check.mjs — TRA-2387 (residual of TRA-2315)
//
// Discrimination suite for the FOURTH gate in render-redeploy.mjs: the live AUTH_SECRET
// value check. TRA-2315 fixed the predicate (0f9e89e); TRA-2387 is the invocation, and an
// invocation nobody grades is the same shape of nothing as a predicate nobody calls.
//
// WHAT THIS SUITE HAS TO PROVE, in both directions:
//   1. the gate FIRES on every unusable value — including the whitespace-only case that
//      the pre-0f9e89e predicate reported as PASS;
//   2. the gate STAYS SILENT on a usable value, and on a service that legitimately has no
//      AUTH_SECRET at all. A one-directional suite passes a gate jammed shut, and a gate
//      jammed shut here blocks every deploy of every service in the account;
//   3. it FAILS CLOSED on an unreadable API — a Render outage must not permit the deploy
//      the gate exists to stop;
//   4. an ABSENT key is severity-scoped: a refusal on bqb1 (which reads the secret), N/A
//      elsewhere. A new check whose severity is not scoped to reachability false-blocks
//      somebody else's critical path (TRA-2348).
//
//   node scripts/tra2387-auth-secret-gate-check.mjs          (offline, no network)
//   node scripts/tra2387-auth-secret-gate-check.mjs --live   (+ read bqb1's real value)
//   exit 0 = all cases pass · 1 = a case failed

import {
  authSecretGateState,
  authSecretBlocks,
  AUTH_SECRET_REQUIRED_ON,
  ENV_WRITE_CAVEAT_SHORT,
} from './render-redeploy.mjs';
import {
  classifyAuthSecret,
  legacyNonEmptyPredicate_DO_NOT_USE,
} from './lib/auth-secret-predicate.mjs';
import { spawnSync } from 'node:child_process';
// ⛔ fileURLToPath, never `new URL(...).pathname` — on Windows that yields "/C:/Users/…",
// which spawn cannot resolve and which fails as `status: null` (a spawn error), i.e. it
// looks exactly like "the script crashed" rather than "the path was malformed".
import { fileURLToPath } from 'node:url';

// A probe shaped exactly like fetchEnvVarProbe's return value. `rows` are Render env-var
// rows AFTER the {envVar:…} unwrap.
const probe = (rows, extra = {}) => ({ rows, truncated: false, ...extra });
const withSecret = value => probe([{ key: 'PORT', value: '4000' }, { key: 'AUTH_SECRET', value }]);
const noSecret = () => probe([{ key: 'PORT', value: '4000' }, { key: 'DATA_DIR', value: '/data' }]);

const REQUIRED = { keyRequired: true }; // bqb1 — render.yaml declares AUTH_SECRET here
const NOT_REQUIRED = { keyRequired: false }; // any other service in the account

const CASES = [
  // ── FIRES: the values that make resolveAuthSecret() throw in production ──────
  [withSecret(''), REQUIRED, 'UNUSABLE', 'EMPTY — the literal TRA-2296 P1 state on bqb1'],
  [
    withSecret(' '),
    REQUIRED,
    'UNUSABLE',
    'WHITESPACE-ONLY (one space) — reported PASS before 0f9e89e; THE case TRA-2315 existed for',
  ],
  [withSecret('   \t \n '), REQUIRED, 'UNUSABLE', 'whitespace-only, mixed — a dashboard field cleared to blanks'],
  [withSecret('\n'), REQUIRED, 'UNUSABLE', 'a bare newline — the shell-heredoc accident'],
  [noSecret(), REQUIRED, 'UNUSABLE', 'ABSENT on a service that READS it — the host will not boot'],

  // ── STAYS SILENT: a gate that refuses everything is not a gate ───────────────
  [withSecret('s3cr3t-value-of-real-length'), REQUIRED, 'CLEAR', 'a real secret — must PROCEED'],
  [withSecret('x'), REQUIRED, 'CLEAR', 'one non-blank char — weak, but the server accepts it, so the gate must too'],
  [
    withSecret(' padded-but-real '),
    REQUIRED,
    'CLEAR',
    'surrounding blanks with real content — trim() leaves content, server accepts',
  ],
  [
    withSecret('AUTH_SECRET'),
    REQUIRED,
    'CLEAR',
    'value that happens to equal the key name — the gate grades the VALUE, not a name match',
  ],

  // ── Severity scoped to reachability (TRA-2348) ───────────────────────────────
  [
    noSecret(),
    NOT_REQUIRED,
    'NOT_APPLICABLE',
    'ABSENT on a service that never had it — must NOT block an unrelated deploy',
  ],
  [
    withSecret(''),
    NOT_REQUIRED,
    'UNUSABLE',
    'PRESENT-but-blank off-bqb1 — somebody set that key on purpose, so blanking it still refuses',
  ],
  [
    withSecret(' '),
    NOT_REQUIRED,
    'UNUSABLE',
    'whitespace-only off-bqb1 — same, and this is the half the old predicate missed',
  ],

  // ── FAILS CLOSED. Every one of these would be a green light on a broken read ──
  [
    { rows: null, truncated: false, error: '401 Unauthorized' },
    REQUIRED,
    'BLIND',
    'API rejected the read — an outage must not permit the deploy it hides',
  ],
  [
    { rows: null, truncated: false, error: 'GET …/env-vars threw: fetch failed' },
    REQUIRED,
    'BLIND',
    'network threw — same',
  ],
  [{ rows: 'not-an-array', truncated: false }, REQUIRED, 'BLIND', 'response was not a list'],
  [undefined, REQUIRED, 'BLIND', 'the probe never ran at all'],
  [
    probe([{ key: 'PORT', value: '4000' }], { truncated: true }),
    REQUIRED,
    'BLIND',
    'TRUNCATED enumeration, no AUTH_SECRET seen — absence is a fact about the pagination',
  ],
  [
    probe([{ key: 'PORT', value: '4000' }], { truncated: true }),
    NOT_REQUIRED,
    'BLIND',
    'truncated off-bqb1 too — a capped read must not resolve to the reassuring N/A either',
  ],
  [
    probe([{ key: 'AUTH_SECRET' }]),
    REQUIRED,
    'BLIND',
    "row present with NO `value` key — must not collapse to '' and claim EMPTY",
  ],
  [probe([{ key: 'AUTH_SECRET', value: null }]), REQUIRED, 'BLIND', 'value is null, not a string — ungradable'],
  [probe([{ key: 'AUTH_SECRET', value: 42 }]), REQUIRED, 'BLIND', 'value is a number — ungradable'],

  // ── A truncated page that DID contain the row is decidable, both ways ────────
  // Truncation only blinds an ABSENCE. If the row is in the rows we read, we have the value.
  [
    probe([{ key: 'AUTH_SECRET', value: 'real-secret' }], { truncated: true }),
    REQUIRED,
    'CLEAR',
    'truncated but the row WAS read — a usable value is still a usable value',
  ],
  [
    probe([{ key: 'AUTH_SECRET', value: ' ' }], { truncated: true }),
    REQUIRED,
    'UNUSABLE',
    'truncated but the row WAS read — and it is blank',
  ],
];

let pass = 0;
const failures = [];
for (const [p, opts, expected, why] of CASES) {
  const got = authSecretGateState(p, opts).verdict;
  if (got === expected) {
    pass += 1;
    console.log(`  ok   ${got.padEnd(15)} ${why}`);
  } else {
    failures.push({ expected, got, why });
    console.log(`  FAIL expected ${expected}, got ${got}  — ${why}`);
  }
}

// ── Reachability: every verdict must be produced by some case ─────────────────
// Without this, a gate jammed at one verdict passes a suite that only ever asserts that
// verdict. All four are load-bearing: CLEAR (deploys work), UNUSABLE (the hazard),
// BLIND (fail-closed), NOT_APPLICABLE (no false-block off bqb1).
const produced = new Set(CASES.map(([p, opts]) => authSecretGateState(p, opts).verdict));
const missing = ['CLEAR', 'UNUSABLE', 'BLIND', 'NOT_APPLICABLE'].filter(v => !produced.has(v));

// ── Exit-code mapping ────────────────────────────────────────────────────────
// The verdict only matters via authSecretBlocks(), which is the expression main() evaluates
// to decide exit 7. Grade it directly rather than trusting that the two agree.
const BLOCK_EXPECT = { CLEAR: false, NOT_APPLICABLE: false, UNUSABLE: true, BLIND: true };
const blockErrors = Object.entries(BLOCK_EXPECT).filter(([v, want]) => authSecretBlocks(v) !== want);
for (const [v, want] of Object.entries(BLOCK_EXPECT)) {
  console.log(`  ${authSecretBlocks(v) === want ? 'ok  ' : 'FAIL'} blocks(${v.padEnd(14)}) = ${authSecretBlocks(v)} (want ${want})`);
}
// An unknown verdict must NOT block — otherwise a future verdict name silently jams the
// gate shut on every deploy. (The predicate returns only the four above; this pins that
// adding a fifth is a decision somebody has to make on purpose.)
const unknownBlocks = authSecretBlocks('SOMETHING_NEW');

// ── DIRECTION CONTROL: would this suite catch a revert of the TRA-2315 fix? ───
// The whole reason the gate is worth invoking is that the OLD predicate — `(v ?? '').length
// === 0`, still exported as legacyNonEmptyPredicate_DO_NOT_USE — calls ' ' healthy. A suite
// that passes against both the fix and the bug has verified nothing (TRA-1787), so assert
// the disagreement mechanically instead of hand-reverting the file and remembering to put
// it back.
const REVERT_WITNESSES = [' ', '  ', '\n', '\t'];
const revertRows = REVERT_WITNESSES.map(v => ({
  value: JSON.stringify(v),
  gate: authSecretGateState(withSecret(v), REQUIRED).verdict,
  fixed: classifyAuthSecret(v).usable,
  legacy: legacyNonEmptyPredicate_DO_NOT_USE(v),
}));
const revertBroken = revertRows.filter(r => !(r.gate === 'UNUSABLE' && r.fixed === false && r.legacy === true));
console.log('');
console.log('direction control — values on which the reverted predicate would flip the gate:');
for (const r of revertRows) {
  console.log(
    `  ${r.gate === 'UNUSABLE' && r.legacy ? 'ok  ' : 'FAIL'} ${r.value.padEnd(6)} gate=${r.gate.padEnd(9)} ` +
      `fixed.usable=${String(r.fixed).padEnd(5)} legacy.nonEmpty=${r.legacy}  ` +
      `${r.legacy && !r.fixed ? '(a revert turns this REFUSE into a green deploy)' : ''}`,
  );
}
// And the mirror half: on values where the two predicates AGREE, the gate must not be
// claiming a discrimination it does not have.
const AGREE_WITNESSES = ['', 'real-secret'];
const agreeRows = AGREE_WITNESSES.map(v => ({
  value: JSON.stringify(v),
  gate: authSecretGateState(withSecret(v), REQUIRED).verdict,
  fixed: classifyAuthSecret(v).usable,
  legacy: legacyNonEmptyPredicate_DO_NOT_USE(v),
}));
const agreeBroken = agreeRows.filter(r => r.fixed !== r.legacy || r.gate !== (r.fixed ? 'CLEAR' : 'UNUSABLE'));
for (const r of agreeRows) {
  console.log(
    `  ${agreeBroken.includes(r) ? 'FAIL' : 'ok  '} ${r.value.padEnd(14)} gate=${r.gate.padEnd(9)} ` +
      `both predicates agree (usable=${r.fixed}) — the revert is invisible here, as expected`,
  );
}

// ── CALL-SITE arm: does main() actually INVOKE the gate? ──────────────────────
// This is the arm that grades TRA-2387's actual subject. TRA-2315 shipped a correct
// predicate that NOTHING CALLED, and every predicate-level case above would have stayed
// green in that world — a fix can be present, live, and orphaned (TRA-2262: verify the
// EDGE, not the node). So run the REAL script, end to end, against a stubbed Render API and
// grade its EXIT CODE and OUTPUT.
//
// Offline and unable to deploy: the stub throws on any POST, and every case passes --dry-run.
// `--import` takes an ESM SPECIFIER, so it gets the file:// URL — a bare Windows path
// ("C:\…") is not a valid specifier and fails inside the ESM loader. The script argument
// below is the opposite: a filesystem path, because that is what spawn resolves.
const E2E_STUB = new URL('./lib/tra2387-render-api-stub.mjs', import.meta.url).href;
// The live service as the platform actually reports it (re-measured 2026-08-14): `name` is
// `TradingAI-`, `slug` is `tradingai-bqb1`, and the slug is what the onrender hostname
// tracks. This stub used to carry the SLUG in the `name` field — a fixture that lies about
// the platform in exactly the direction TRA-3719/3736/3743 keep biting. The bqb1 cases
// below passed anyway because `isSoakHost` also disjuncts on `id`; that is the id arm
// carrying a dead name arm, not the name arm working.
const BQB1 = {
  id: 'srv-d7mb7rr7uimc73ev0chg',
  name: 'TradingAI-',
  slug: 'tradingai-bqb1',
  branch: 'main',
};
const OTHER = { id: 'srv-someothersvc', name: 'tradingai-scratch', slug: 'tradingai-scratch', branch: 'main' };
const PORT = { key: 'PORT', value: '4000' };
// A sha that is not a commit in any checkout: makes the commit-hold gate resolve without a
// network round-trip, so these cases stay offline. Whatever it decides is downstream of the
// gate under test and is only ever asserted as "not 7".
const NO_SUCH_SHA = '--commit=0000000000000000000000000000000000000000';

const E2E = [
  {
    why: 'bqb1 + AUTH_SECRET=" " -> REFUSED 7. The whitespace case, through the real main().',
    stub: { service: BQB1, envVars: [PORT, { key: 'AUTH_SECRET', value: ' ' }] },
    args: ['--dry-run'],
    code: 7,
    stderrHas: ['REFUSED', 'WHITESPACE-ONLY'],
  },
  {
    why: 'bqb1 + AUTH_SECRET absent -> REFUSED 7 (the key is declared on this service)',
    stub: { service: BQB1, envVars: [PORT] },
    args: ['--dry-run'],
    code: 7,
    stderrHas: ['REFUSED', 'absent'],
  },
  {
    why: 'bqb1 + env-var read 500 -> REFUSED 7, BLIND. An outage must not permit the deploy.',
    stub: { service: BQB1, envVars: null, envVarsStatus: 500 },
    args: ['--dry-run'],
    code: 7,
    stderrHas: ['REFUSED', 'BLIND'],
  },
  {
    why: 'bqb1 + env-var read 401 -> REFUSED 7, not exit 2. A bad read is a BLIND gate, not a usage error.',
    stub: { service: BQB1, envVars: null, envVarsStatus: 401 },
    args: ['--dry-run'],
    code: 7,
    stderrHas: ['BLIND'],
  },
  {
    // Requirement #2 of the ticket, and the reason this gate has its own flag: one reason
    // must not buy two decisions. Authorisation to deploy inside RTH says nothing about
    // booting a process that throws.
    why: 'bqb1 + blank secret + --force-RTH-override -> STILL 7. The wrong override must not open this gate.',
    stub: { service: BQB1, envVars: [PORT, { key: 'AUTH_SECRET', value: ' ' }] },
    args: ['--dry-run', '--force-rth-override=deploying inside RTH on purpose'],
    code: 7,
    stderrHas: ['REFUSED'],
  },
  {
    why: 'bqb1 + blank secret + --force-embargo-override -> STILL 7. Same, for the embargo flag.',
    stub: { service: BQB1, envVars: [PORT, { key: 'AUTH_SECRET', value: ' ' }] },
    args: ['--dry-run', '--force-embargo-override=board said so'],
    code: 7,
    stderrHas: ['REFUSED'],
  },
  {
    why: 'bqb1 + blank secret + --force-auth-secret-override="reason" -> NOT 7, and the reason is recorded',
    stub: { service: BQB1, envVars: [PORT, { key: 'AUTH_SECRET', value: ' ' }] },
    args: ['--dry-run', NO_SUCH_SHA, '--force-auth-secret-override=NODE_ENV is not production here'],
    codeNot: 7,
    stderrHas: ['WARNING', 'NODE_ENV is not production here'],
  },
  {
    why: 'the override with an EMPTY reason is a usage error (2), not a free pass',
    stub: { service: BQB1, envVars: [PORT, { key: 'AUTH_SECRET', value: ' ' }] },
    args: ['--dry-run', NO_SUCH_SHA, '--force-auth-secret-override='],
    code: 2,
    stderrHas: ['requires a non-empty reason'],
  },
  {
    // The PROCEED direction. A gate that only ever refuses is not a gate, and this case is
    // also where ticket requirement #3 is graded: the caveat must print in the NORMAL
    // output, not only in a refusal.
    why: 'other service + real secret -> exit 0, prints the auth line AND the env-write caveat',
    stub: { service: OTHER, envVars: [PORT, { key: 'AUTH_SECRET', value: 'a-real-secret-value' }] },
    args: ['--dry-run'],
    code: 0,
    // Two different obligations, deliberately graded by two different kinds of string:
    //
    //   ENV_WRITE_CAVEAT_SHORT — the IMPORTED CONSTANT, never a copy of its text. This
    //     grades only "the caveat reached stdout", which is this suite's business. Its
    //     WORDING is TRA-3724's business, so a reword must not be able to fail this case.
    //     The previous version pinned the literal `service_updated`; TRA-3724 rewrote the
    //     caveat (an ENV-VAR write produces no deploy on this host, so the old claim was a
    //     category error), the literal survived only in comments, and `pnpm pretest` — hence
    //     `pnpm test` — exited 1 on main for every developer until TRA-3744.
    //
    //   'PATCH /services' — a deliberate CONTENT anchor, and the one thing `service_updated`
    //     was really standing for: that the caveat still discloses the settings-write escape
    //     hatch, the one verb here that can still redeploy from the branch tip unguarded.
    //     Dropping that disclosure is the reword this case must go red on. Keep it narrow and
    //     keep it a verb — do not grow this into a second copy of the paragraph.
    stdoutHas: ['auth    : AUTH_SECRET present', 'it does not guard the WRITE', ENV_WRITE_CAVEAT_SHORT, 'PATCH /services'],
  },
  {
    why: 'other service + no AUTH_SECRET at all -> exit 0. Severity is scoped: no false-block.',
    stub: { service: OTHER, envVars: [PORT] },
    args: ['--dry-run'],
    code: 0,
    stdoutHas: ['gate N/A on this service'],
  },
];

const SCRIPT = fileURLToPath(new URL('./render-redeploy.mjs', import.meta.url));
const e2eFailures = [];
console.log('');
console.log('call-site arm — the REAL main(), stubbed Render API, --dry-run (nothing is deployed):');
for (const c of E2E) {
  const r = spawnSync(
    process.execPath,
    ['--import', E2E_STUB, SCRIPT, ...c.args],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        RENDER_API_KEY: 'stub-key-not-a-real-credential',
        RENDER_SERVICE_ID: c.stub.service.id,
        TRA2387_STUB: JSON.stringify(c.stub),
      },
    },
  );
  const problems = [];
  if (c.code !== undefined && r.status !== c.code) problems.push(`exit ${r.status}, expected ${c.code}`);
  if (c.codeNot !== undefined && r.status === c.codeNot) problems.push(`exit ${r.status}, expected anything but ${c.codeNot}`);
  for (const s of c.stderrHas ?? []) if (!(r.stderr ?? '').includes(s)) problems.push(`stderr missing "${s}"`);
  for (const s of c.stdoutHas ?? []) if (!(r.stdout ?? '').includes(s)) problems.push(`stdout missing "${s}"`);
  if (problems.length === 0) {
    console.log(`  ok   exit ${String(r.status).padEnd(2)} ${c.why}`);
  } else {
    e2eFailures.push({ why: c.why, problems });
    console.log(`  FAIL ${c.why}\n         ${problems.join('\n         ')}`);
    if (r.stderr) console.log(`         stderr: ${r.stderr.split('\n')[0]}`);
  }
}
// Reachability on the EXIT CODES, not just the verdicts: if no case in this arm ever
// produced 7, the arm would be asserting nothing about the refusal it exists to prove.
const e2eCodes = new Set(E2E.filter(c => c.code !== undefined).map(c => c.code));
const e2eCodesMissing = [0, 2, 7].filter(v => !e2eCodes.has(v));

// ── LIVE arm (--live) ────────────────────────────────────────────────────────
// The cases above inject the probe, so they prove the PREDICATE discriminates. They do not
// prove the real fetch reaches Render, finds the row, or that TODAY'S value is usable —
// and a suite of fakes passing while the live path is broken is the reads-identically
// failure this repo keeps paying for. Opt-in because it needs RENDER_API_KEY.
let liveFailed = false;
if (process.argv.includes('--live')) {
  console.log('');
  const SRV = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
  if (!process.env.RENDER_API_KEY) {
    console.error('[tra2387] FAIL: --live needs RENDER_API_KEY (never commit it).');
    liveFailed = true;
  } else {
    // Re-implemented rather than imported: fetchEnvVarProbe is intentionally module-private
    // in render-redeploy.mjs (it is not a gate predicate). Keep this in step with it.
    const rows = [];
    let cursor;
    let error;
    let truncated = false;
    for (let page = 0; page < 20; page += 1) {
      const q = new URLSearchParams({ limit: '100' });
      if (cursor) q.set('cursor', cursor);
      const r = await fetch(`https://api.render.com/v1/services/${SRV}/env-vars?${q}`, {
        headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' },
      }).catch(e => ({ ok: false, status: 0, statusText: String(e?.message ?? e), text: async () => '' }));
      if (!r.ok) {
        error = `${r.status} ${r.statusText} ${await r.text().catch(() => '')}`.trim();
        break;
      }
      const json = await r.json();
      if (!Array.isArray(json)) {
        error = `response was ${typeof json}, expected an array`;
        break;
      }
      for (const e of json) rows.push(e?.envVar ?? e);
      if (json.length < 100) break;
      cursor = json[json.length - 1]?.cursor;
      if (!cursor) {
        truncated = true;
        break;
      }
    }
    const liveProbe = error ? { rows: null, truncated: false, error } : { rows, truncated };
    const live = authSecretGateState(liveProbe, {
      keyRequired: AUTH_SECRET_REQUIRED_ON.has(SRV),
    });
    console.log(`live    : ${SRV} — ${rows.length} env var(s) read${truncated ? ' (TRUNCATED)' : ''}`);
    console.log(`  verdict: ${live.verdict}${live.detail ? ` — ${live.detail}` : ''}${live.why ? ` (${live.why})` : ''}`);
    console.log(`  blocks : ${authSecretBlocks(live.verdict)}`);

    // ⛔ An assertion suite is VACUOUSLY GREEN on the empty collection: "no error and not
    // UNUSABLE" is also what a run that read zero rows looks like. Require positive
    // evidence that the row was actually seen before treating this arm as informative.
    const sawRow = Array.isArray(liveProbe.rows) && liveProbe.rows.some(v => v?.key === 'AUTH_SECRET');
    if (!sawRow && live.verdict !== 'BLIND') {
      console.error('[tra2387] FAIL: the live arm did not read an AUTH_SECRET row, so its verdict is not evidence.');
      liveFailed = true;
    }
    // Negative control on the LIVE fetch: the same rows, with the value replaced by a
    // known-blank, must come back UNUSABLE. Without it, a fetch jammed at CLEAR (e.g. a
    // proxy returning placeholder values) reads exactly like a healthy host.
    if (sawRow) {
      const spiked = liveProbe.rows.map(v => (v?.key === 'AUTH_SECRET' ? { ...v, value: ' ' } : v));
      const control = authSecretGateState({ rows: spiked, truncated: liveProbe.truncated }, { keyRequired: true });
      console.log(
        `  control: same rows with AUTH_SECRET=" " -> ${control.verdict}  ` +
          `${control.verdict === 'UNUSABLE' ? 'ok' : 'FAIL — the live path cannot see a blank secret'}`,
      );
      if (control.verdict !== 'UNUSABLE') liveFailed = true;
    }
  }
}

console.log('');
console.log(`required-on: ${[...AUTH_SECRET_REQUIRED_ON].join(', ')} (render.yaml declares AUTH_SECRET on bqb1 only)`);
console.log(`cases   : ${pass}/${CASES.length} predicate · ${E2E.length - e2eFailures.length}/${E2E.length} call-site`);
console.log(`verdicts: reached ${[...produced].sort().join(', ')}`);

let bad = failures.length > 0;
if (e2eFailures.length) {
  console.error(
    `[tra2387] FAIL: ${e2eFailures.length} call-site case(s) failed — the predicate may be correct but ` +
      'render-redeploy.mjs is not behaving as though it invokes it.',
  );
  bad = true;
}
if (e2eCodesMissing.length) {
  console.error(`[tra2387] FAIL: the call-site arm never asserts exit code(s) ${e2eCodesMissing.join(', ')} — it is one-sided.`);
  bad = true;
}
if (missing.length) {
  console.error(`[tra2387] FAIL: verdict(s) never reached by any case: ${missing.join(', ')} — suite is one-sided.`);
  bad = true;
}
if (blockErrors.length) {
  console.error(
    `[tra2387] FAIL: authSecretBlocks() disagrees with the intended exit-7 mapping on: ${blockErrors
      .map(([v]) => v)
      .join(', ')}.`,
  );
  bad = true;
}
if (unknownBlocks) {
  console.error('[tra2387] FAIL: authSecretBlocks() blocks on an UNKNOWN verdict — a new verdict name would jam the gate shut.');
  bad = true;
}
if (revertBroken.length) {
  console.error(
    '[tra2387] FAIL: the direction control does not hold — this suite would pass against a reverted ' +
      `TRA-2315 predicate on: ${revertBroken.map(r => r.value).join(', ')}.`,
  );
  bad = true;
}
if (agreeBroken.length) {
  console.error(`[tra2387] FAIL: predicate disagreement on values where both should agree: ${agreeBroken.map(r => r.value).join(', ')}.`);
  bad = true;
}
if (failures.length) console.error(`[tra2387] FAIL: ${failures.length} case(s) failed.`);
if (liveFailed) console.error('[tra2387] FAIL: the --live arm did not verify.');
if (bad || liveFailed) process.exit(1);

console.log(
  '[tra2387] PASS — the AUTH_SECRET gate fires on every unusable value (including the ' +
    'whitespace case), stays silent on usable ones and off-path services, fails CLOSED on an ' +
    'unreadable API, and would go RED against a reverted TRA-2315 predicate.',
);
process.exit(0);
