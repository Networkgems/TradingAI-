#!/usr/bin/env node
// tra3722-shallow-false-red-repro.mjs — TRA-3722 (AC3 residual of TRA-3699), FAIL-CLOSED half
//
// Four graders collapsed an UNREADABLE ancestry answer into a CONDEMNATION. Nothing shipped
// that should not have — these fail CLOSED — but each one reds a build that is fine, which
// costs a re-derivation and teaches a reader to route around the gate. That is exactly how
// TRA-3678 spent six sessions as a permanently-red pin nobody believed.
//
//   1. scripts/check-rv-sleeve-live.mjs        leg 4  — dead()  (exit 1) instead of blind() (3)
//   2. scripts/tra2407-fold-scope-verify.mjs   deployVerdict — MISSING (exit 2) instead of UNKNOWN (3)
//   3. scripts/tra3057-verify.mjs              leg 1  — a bare `catch { contains = false }`; had
//                                                       NO cannot-tell state at all until this fix
//   4. scripts/tra2342-interlock-live-check.mjs the THREE LIVE arms — FAIL "Deploy it before
//                                                       arming" against a build that carries it
//
// Graded against the SAME grafted repository state the two sibling suites build — the builder
// is shared (scripts/lib/shallow-graft-repro.mjs) precisely so the three cannot drift into
// grading different things.
//
// ⚠ A `--depth=N` CLONE IS NOT THE REPRO — see the header of lib/shallow-graft-repro.mjs.
// ARM 0 is the positive control on the control.
//
// TWO THINGS ARE GRADED PER SUBJECT, because either alone is weak:
//   · the ROUTING — `--ancestry-probe` prints the state that subject's own decision function
//     reaches. Each probe calls the SAME function the real call site does, so this is the
//     mapping that was wrong, not the shared grader underneath it.
//   · the EXIT CODE — the subject is then run END TO END inside the graft against a local
//     fixture host, and must exit NON-GREEN with the cannot-tell code. AC1 says the state
//     must be "verified to be non-green, not a silent skip"; only this arm can say that.
//
// BOTH DIRECTIONS, not just the new one (AC2). After a change that turns negatives into
// BLIND, "blind on everything" is the obvious way to fail and it would pass a one-sided
// suite. Every grafted arm therefore has a COMPLETE-CLONE twin that must still ANSWER — and
// a genuine non-ancestor there must still read ABSENT, not BLIND.
//
//   node scripts/tra3722-shallow-false-red-repro.mjs [--keep]
//   exit 0 = every arm as expected · 1 = an arm failed · 2 = could not build the repro

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REPO_ROOT,
  gitOut,
  pickPair,
  buildGraft,
  graftDetail,
  stageScripts,
  ANCESTRY_LIB,
} from './lib/shallow-graft-repro.mjs';

const KEEP = process.argv.includes('--keep');

// The bytes that carried the defect, pinned by REV so the pre-fix arms quote the real
// implementation rather than a re-typed imitation of it. 0270b255 is the tip TRA-3722 was
// written against, where all four of these sites still manufactured a false RED.
const PRE_FIX_REV = '0270b255b3e77b24995ff4d4ef3f99f1958f6383';

const bail = msg => {
  console.error(`[tra3722] CANNOT RUN: ${msg}`);
  process.exit(2);
};

const results = [];
const arm = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  console.log(`       ${detail}`);
};

const node = (args, cwd, env) =>
  spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...env } });

const firstToken = r => `${r.stdout ?? ''}`.trim().split(/\s+/)[0] ?? '';

// ── The four subjects, as data ───────────────────────────────────────────────
//
// `alreadyHadBlind` is AC4: state per file whether the cannot-tell branch was ALREADY there
// (a one-line routing change) or had to be ADDED (a new state, which deserves its own
// control). It is carried here rather than in prose so the closing comment cannot drift
// away from the code.
//
// `preFixRule` is quoted from the SHIPPED pre-fix source, and `replay` is that rule as a
// function of git's exit code. The arm asserts the literal is genuinely present at
// PRE_FIX_REV before replaying it, so it cannot quietly become a control over a rule nobody
// ever shipped. These four cannot be driven end-to-end at PRE_FIX_REV the way tra2342's
// --self-test could be: none of them had an `--ancestry-probe` seam before this fix, and
// they all do network I/O at module load.
const SUBJECTS = [
  {
    key: 'rv-sleeve',
    script: 'scripts/check-rv-sleeve-live.mjs',
    // 07ea3b1 (TRA-1677). Pinned in the file with no flag to override it, so it must be an
    // OBJECT in the graft or leg 4's own rev-parse screen bails before the ancestry row.
    fix: '07ea3b1c442932ed4a0602df56d22d0fcfe55b66',
    tokens: { carries: 'contains', absent: 'absent', blind: 'blind' },
    alreadyHadBlind: true, // blind() existed and said the right thing; only the routing was wrong
    hostFlag: '--host',
    blindExit: 3, // BLIND
    falseRedExit: 1, // DEAD — "no RV outcome row from this build is real"
    preFixRule: 'if (anc.status !== 0 && anc.status !== 1) blind(',
    replay: rc => (rc !== 0 && rc !== 1 ? 'blind' : rc !== 0 ? 'absent' : 'contains'),
  },
  {
    key: 'tra2407',
    script: 'scripts/tra2407-fold-scope-verify.mjs',
    fix: '5f15579fce2e8d8279ed61b02348bca7d856a3c1',
    tokens: { carries: 'CONTAINS', absent: 'MISSING', blind: 'UNKNOWN' },
    alreadyHadBlind: true, // UNKNOWN already existed; the graft landed in MISSING
    hostFlag: '--host',
    extraArgs: t => [`--fix-sha=${t.fix}`],
    blindExit: 3, // BLIND
    falseRedExit: 2, // UNDEPLOYED
    preFixRule: "return err && err.status === 1 ? 'MISSING' : 'UNKNOWN';",
    replay: rc => (rc === 1 ? 'MISSING' : rc === 0 ? 'CONTAINS' : 'UNKNOWN'),
  },
  {
    key: 'tra3057',
    script: 'scripts/tra3057-verify.mjs',
    fix: 'f045ed5fcd588093b16d1511da1321a07061f1f9',
    tokens: { carries: 'contains', absent: 'absent', blind: 'BLIND' },
    alreadyHadBlind: false, // NO cannot-tell state existed — exit 3 is new in this fix
    hostFlag: '--host',
    blindExit: 3, // BLIND (new)
    falseRedExit: 1, // NOT PROVEN — leg 1 failed
    // The bare catch. Quoted with its `try` line so the literal cannot match the unrelated
    // `let contains = false;` initialiser three lines above it.
    preFixRule: '    } catch {\n      contains = false;\n    }',
    replay: rc => (rc === 0 ? 'contains' : 'absent'), // EVERY non-zero read as "not live"
  },
  {
    key: 'tra2342',
    script: 'scripts/tra2342-interlock-live-check.mjs',
    fix: 'ffe656c3d84d7f850eb1d5a6c2f14f5562ebd594',
    tokens: { carries: 'PASS', absent: 'FAIL', blind: 'BLIND' },
    alreadyHadBlind: false, // record() had PASS/FAIL/SKIP; BLIND + exit 2 are new here
    hostFlag: '--base',
    blindExit: 2, // CANNOT RUN
    falseRedExit: 1, // NOT PROVEN — "do NOT set TRADIER_ENV=production"
    preFixRule: '    ancestryOk = true;\n  } catch {\n    ancestryOk = false;\n  }',
    replay: rc => (rc === 0 ? 'PASS' : 'FAIL'),
  },
];

// tra2342 reaches for two more pinned commits after the ANCESTRY arm; without them as
// OBJECTS its own cat-file screens bail first and the end-to-end arm would grade the wrong
// screen. The --self-test control shas are along for the same reason.
const TRA2342_EXTRA_SHAS = [
  '86a5a05299b15727c5dff0eae87aef879ee6b1d7', // THIRD_PATH_COMMIT
  '387e8516e832d06bd75aa734aa7ef114ef25eab8', // UNIVERSE_COMMIT
];

// ── A local fixture host, so the end-to-end arms need no network ─────────────
// It serves only what the four subjects read before they reach their ancestry row, and it
// reports `commit` = the graft's TARGET — a commit that genuinely CARRIES every pinned fix
// on a complete clone. That is the whole point: the box is fine, and the grader must not
// say otherwise just because it cannot see the path.
//
// ⚠ IT RUNS IN ITS OWN PROCESS, AND THAT IS NOT AN OPTIMISATION. Hosting it in THIS process
// deadlocks: `spawnSync` blocks the parent's event loop, so the server can never accept the
// subject's connection, every request times out, and the subject exits on its NETWORK blind
// — which for three of these four subjects is the SAME exit code as the ancestry blind. The
// first cut of this harness printed 23/23 PASS that way while measuring nothing. Arm 0d and
// the `blind-shallow` marker below exist so that cannot recur silently.
const FIXTURE_SRC = liveSha => `
import { createServer } from 'node:http';
const LIVE = ${JSON.stringify(liveSha)};
const body = path => {
  if (path.startsWith('/api/health/version'))
    return { commit: LIVE, commitShort: LIVE.slice(0, 8), startedAt: '2026-08-14T00:00:00.000Z', pid: 1 };
  // Legs 1-3 of rv-sleeve must PASS, or the run dies before leg 4's ancestry. deltaBand
  // admits the 0.45 selector floor and there is no legacy shortDeltaBand key.
  if (path.startsWith('/api/health/entry-greeks-gate'))
    return { build: { commit: LIVE }, enabled: true, flag: 'ENTRY_GREEKS_GATE_ENABLED',
             config: { deltaBand: [0.45, 1] }, evaluated: 0, admitted: 0 };
  if (path.startsWith('/api/health/execution-quality-kpi')) return { issue: 'TRA-1981', kpi: { decayRatio: null } };
  if (path.startsWith('/api/health/execution-quality')) return { issue: 'TRA-2046', telemetry: {} };
  if (path.startsWith('/__ping')) return { ok: true };
  return null;
};
const server = createServer((req, res) => {
  const payload = body(req.url ?? '');
  res.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload ?? { error: 'not a fixture route' }));
});
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

function startFixtureHost(root, liveSha) {
  const path = join(root, 'fixture-host.mjs');
  writeFileSync(path, FIXTURE_SRC(liveSha));
  const child = spawn(process.execPath, [path], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fixture host did not report a port within 20s')), 20_000);
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      const m = buf.match(/PORT (\d+)/);
      if (m) {
        clearTimeout(t);
        resolve({ child, base: `http://127.0.0.1:${m[1]}` });
      }
    });
    child.on('error', e => {
      clearTimeout(t);
      reject(e);
    });
  });
}

let TARGET, HELD;
try {
  ({ target: TARGET, held: HELD } = pickPair({ depth: 50 }));
} catch (e) {
  bail(e.message);
}

console.log('[tra3722] shallow-graft repro for the four FALSE-RED ancestry graders');
console.log(`[tra3722]   held   ${HELD}`);
console.log(`[tra3722]   target ${TARGET}  (must CARRY held on a complete clone)\n`);

// Every subject's pinned fix must be a real ancestor of TARGET on THIS complete clone, or
// the grafted arm below would be grading a true negative and would pass without any fix.
for (const s of SUBJECTS) {
  const rc = spawnSync('git', ['merge-base', '--is-ancestor', s.fix, TARGET], { cwd: REPO_ROOT }).status;
  if (rc !== 0) {
    bail(
      `${s.key}'s pinned fix ${s.fix.slice(0, 8)} is NOT an ancestor of ${TARGET.slice(0, 8)} on this COMPLETE clone ` +
        `(rc=${rc}). The grafted arm would then be a true negative and would pass without the fix.`,
    );
  }
}

const root = mkdtempSync(join(process.env.TRA3722_SCRATCH ?? process.env.TRA3699_SCRATCH ?? tmpdir(), 'tra3722-'));
const cleanup = () => {
  if (KEEP) {
    console.log(`\n[tra3722] --keep: repro left at ${root}`);
    return;
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* best effort */
  }
};

let fixture;
try {
  // ── Build the grafted shallow clone ──────────────────────────────────────
  let graft, facts;
  const extraShas = [...SUBJECTS.map(s => s.fix), ...TRA2342_EXTRA_SHAS];
  try {
    ({ graft, facts } = buildGraft(root, { target: TARGET, held: HELD, extraShas }));
  } catch (e) {
    bail(e.message);
  }

  // ── ARM 0 — is the repro the thing it claims to be? ──────────────────────
  arm(
    'ARM 0 — the repro is the OBJECT-PRESENT / PATH-CUT state, not a plain --depth clone',
    facts.faithful,
    graftDetail(facts),
  );
  if (!facts.faithful) bail('the repro did not reach the grafted state; grading it would prove nothing');

  // ── ARM 0b — every pinned fix commit RESOLVES inside the graft ───────────
  // Without this an arm could pass because the subject's missing-object screen fired, which
  // is a DIFFERENT defect with a different remedy and one the shipped code already handles.
  const missing = extraShas.filter(
    sha => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: graft }).status !== 0,
  );
  arm(
    "ARM 0b — every subject's pinned commit RESOLVES inside the graft (object present, path cut)",
    missing.length === 0,
    missing.length === 0
      ? `all ${extraShas.length} present — so the arms below cannot pass merely because a missing-object screen fired`
      : `MISSING: ${missing.map(s => s.slice(0, 8)).join(', ')} — the arms below would grade the wrong screen`,
  );

  // ── ARM 0c — each pinned fix is STILL unreachable-by-path in the graft ───
  // The positive control must CONTAIN what it detects. `fetch --depth=1` of the fix commit
  // could in principle have pulled enough history to make ancestry answerable again; if it
  // did, the arms below would be measuring nothing.
  const notCut = SUBJECTS.filter(
    s => spawnSync('git', ['merge-base', '--is-ancestor', s.fix, TARGET], { cwd: graft }).status !== 1,
  );
  arm(
    'ARM 0c — every pinned fix still exits 1 (the trap) against the target INSIDE the graft',
    notCut.length === 0,
    notCut.length === 0
      ? `4/4 subjects sit on the exact ambiguity: object present, --is-ancestor rc=1, and the answer is YES on a complete clone`
      : `NOT CUT: ${notCut.map(s => s.key).join(', ')} — those arms would prove nothing`,
  );

  stageScripts(graft, [...SUBJECTS.map(s => s.script), ...ANCESTRY_LIB]);

  try {
    fixture = await startFixtureHost(root, TARGET);
  } catch (e) {
    bail(`could not start the fixture host: ${e.message}`);
  }

  // ── ARM 0d — the fixture host is reachable FROM A SUBPROCESS ─────────────
  // The control on the control for arm B. Three of these four subjects exit on a NETWORK
  // blind with the SAME code as their ancestry blind, so an unreachable fixture makes every
  // arm B pass while measuring nothing — which is exactly what the first cut of this harness
  // did (the server was hosted in this process, and spawnSync blocks its event loop).
  const ping = node(
    ['-e', `fetch(process.argv[1]+'/__ping').then(r=>{console.log('HTTP '+r.status);process.exit(0)},e=>{console.log('ERR '+e.message);process.exit(1)})`, fixture.base],
    graft,
  );
  arm(
    'ARM 0d — the fixture host answers a SUBPROCESS (without this, every arm B passes on a network blind)',
    ping.status === 0 && `${ping.stdout ?? ''}`.includes('HTTP 200'),
    `${`${ping.stdout ?? ''}`.trim() || '(no output)'} at ${fixture.base} — arm B is only evidence if this passes`,
  );

  for (const s of SUBJECTS) {
    const staged = join(graft, ...s.script.split('/'));
    const shipped = join(REPO_ROOT, ...s.script.split('/'));
    const extra = s.extraArgs ? s.extraArgs(s) : [];

    // ── A. ROUTING, grafted: the subject's own decision must reach cannot-tell ──
    const gr = node([staged, `--ancestry-probe=${s.fix}:${TARGET}`], graft);
    arm(
      `[${s.key}] A — grafted, target genuinely CARRIES the fix: routing must reach ${s.tokens.blind}`,
      firstToken(gr) === s.tokens.blind,
      `got "${firstToken(gr) || '(no output)'}" want "${s.tokens.blind}" · exit=${gr.status} — ` +
        `"${s.tokens.absent}" is the false RED this ticket is about`,
    );

    // ── B (AC1). EXIT CODE, grafted end-to-end: non-green, and the RIGHT non-green ──
    // A routing token proves the branch was reached; only a real run proves the branch is
    // not a silent skip. The fixture host reports a live SHA that CARRIES the fix.
    //
    // ⚠ THE EXIT CODE ALONE IS NOT ENOUGH. rv-sleeve, tra2407 and tra3057 all exit 3 on an
    // UNREACHABLE HOST too, and tra2342 exits 2 — so a broken fixture would pass this arm on
    // a network blind. The run must ALSO name `blind-shallow`, which only the ancestry path
    // can print. (Arm 0d is the other half of that guard.)
    const e2e = node([staged, `${s.hostFlag}=${fixture.base}`, ...extra], graft);
    const e2eOut = `${e2e.stderr ?? ''}\n${e2e.stdout ?? ''}`;
    const namedShallow = e2eOut.includes('blind-shallow');
    arm(
      `[${s.key}] B (AC1) — grafted END-TO-END must exit ${s.blindExit} (cannot-tell) AND name blind-shallow`,
      e2e.status === s.blindExit && namedShallow,
      `exit=${e2e.status} want=${s.blindExit} (0 would be a fail-OPEN; ${s.falseRedExit} is the false RED that ` +
        `condemns a build carrying the fix) · named blind-shallow=${namedShallow}` +
        `${namedShallow ? '' : ' <-- WITHOUT THIS THE EXIT CODE PROVES NOTHING: the host may simply be unreachable'}` +
        `\n       ${e2eOut
          .split('\n')
          .map(l => l.trim())
          .filter(l => /blind-shallow/.test(l))
          .slice(0, 1)
          .join(' ') || '(no blind-shallow line printed)'}`,
    );

    // ── C (AC2). The same fixed bytes on the COMPLETE clone must still ANSWER ──
    // "Blind on everything" is the obvious way to fail this fix, and it would pass A and B.
    const co = node([shipped, `--ancestry-probe=${s.fix}:${TARGET}`], REPO_ROOT);
    arm(
      `[${s.key}] C (AC2) — COMPLETE clone, same pair: must answer ${s.tokens.carries}, NOT ${s.tokens.blind}`,
      firstToken(co) === s.tokens.carries,
      `got "${firstToken(co) || '(no output)'}" want "${s.tokens.carries}" — the graft is the ONLY difference ` +
        'between this and arm A, so A was a real answer being lost, not a true negative',
    );

    // ── D (AC2). A GENUINE non-ancestor on the complete clone must still read ABSENT ──
    // This is the direction a "refuse everything" regression would break. TARGET cannot be
    // contained by the older HELD.
    const no = node([shipped, `--ancestry-probe=${TARGET}:${HELD}`], REPO_ROOT);
    arm(
      `[${s.key}] D (AC2) — COMPLETE clone, a genuine non-ancestor must still read ${s.tokens.absent}`,
      firstToken(no) === s.tokens.absent,
      `held=${TARGET.slice(0, 12)} target=${HELD.slice(0, 12)} (the newer commit cannot be contained by the older) ` +
        `-> got "${firstToken(no) || '(no output)'}" want "${s.tokens.absent}" · "${s.tokens.blind}" here would mean ` +
        'the gate now refuses everything, which passes arms A-C and is useless',
    );

    // ── E. The DEFECT reproduces on the pre-fix bytes, quoted from the shipped source ──
    // Without this the suite cannot tell "the fix works" from "the repro never bit".
    const preSrc = gitOut(['show', `${PRE_FIX_REV}:${s.script}`]);
    const rulePresent = typeof preSrc === 'string' && preSrc.includes(s.preFixRule);
    const replayed = rulePresent ? s.replay(facts.graftRc) : undefined;
    arm(
      `[${s.key}] E — the pre-fix rule is real at ${PRE_FIX_REV.slice(0, 8)}, and replays to "${s.tokens.absent}" on this graft`,
      rulePresent && replayed === s.tokens.absent,
      rulePresent
        ? `rule found verbatim · replayed against the MEASURED graft rc=${facts.graftRc} -> "${replayed}" ` +
          `(want "${s.tokens.absent}" — a confident condemnation on a question git never answered; arm A is the ` +
          'same input through the fixed bytes)'
        : `RULE NOT FOUND at ${PRE_FIX_REV.slice(0, 8)}:${s.script} — this arm would be a control over a rule ` +
          'nobody shipped. Reported as a FAIL, not skipped.',
    );
  }
} finally {
  if (fixture) fixture.child.kill();
  cleanup();
}

// AC4 — which files got a ROUTING change and which got a NEW STATE, printed from the table
// above so it cannot drift away from the code.
console.log('');
console.log('[tra3722] cannot-tell branch provenance (AC4):');
for (const s of SUBJECTS) {
  console.log(
    `[tra3722]   ${s.key.padEnd(10)} ${s.alreadyHadBlind ? 'ALREADY THERE — one-line routing change' : 'ADDED — a new state, controlled by arm B'}`,
  );
}

const bad = results.filter(r => !r.ok);
console.log('');
console.log(`[tra3722] ${results.length - bad.length}/${results.length} arms as expected`);
if (bad.length) {
  console.error(`[tra3722] FAIL — ${bad.map(r => r.name.split(' —')[0]).join(', ')}`);
  process.exit(1);
}
console.log(
  '[tra3722] PASS — on a grafted clone all four graders reach a NON-GREEN cannot-tell state instead of ' +
    'condemning a build that carries the fix, and all four still answer BOTH ways on a complete clone.',
);
process.exit(0);
