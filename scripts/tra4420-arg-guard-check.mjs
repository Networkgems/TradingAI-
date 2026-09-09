#!/usr/bin/env node
// tra4420-arg-guard-check.mjs — TRA-4420
//
// Discrimination suite for the ARGUMENT GUARD in render-redeploy.mjs (Gate −2).
//
// THE DEFECT. Every flag in that script was looked up POSITIVELY, so any argument it did
// not recognise was silently ignored and the run proceeded as a real deploy of the branch
// TIP. Measured 2026-09-09 on the live money host: `node scripts/render-redeploy.mjs
// --help` printed no usage and triggered `dep-dagcbqp5efls73ac5d40` on bqb1. Nothing was
// harmed because the tip happened to be the commit TRA-4419 had ordered — luck, not design.
// The expensive instances are `--commmit=<sha>` (typo) and `--commit <sha>` (space), which
// read as "no --commit given" and shipped the tip INSTEAD OF the sha the operator named.
//
// ⛔ WHY THE ARMS BELOW ARE REAL INVOCATIONS AND NOT AN INJECTED TABLE. classifyArgs() is
// exported and is graded here, but a predicate suite is exactly the shape of nothing this
// defect already was: the predicate that would have caught `--help` did not exist, and the
// thing that made it a deploy was that NOTHING ENUMERATED ARGV IN main(). A table-only suite
// stays green if somebody deletes the call site out of main(), which is the only thing that
// makes this real. (Same reasoning as check:deploy-gates:shallow-repro and TRA-2262: verify
// the EDGE, not the node.) So the load-bearing arms spawn the SHIPPED BYTES.
//
// ⛔ AND WHY THOSE SPAWNS CANNOT DEPLOY. Two independent reasons, both structural:
//   1. every spawned case is preloaded with lib/tra2387-render-api-stub.mjs, which THROWS on
//      any POST — a stubbed run cannot become a real one;
//   2. the discriminating arms assert on the MESSAGE, not only the exit code, because exit 2
//      is shared with "RENDER_API_KEY is required". Asserting the code alone would pass
//      against the pre-fix bytes for the wrong reason.
//
// DIRECTION CONTROL, without which this suite proves nothing: a script hardwired to refuse
// everything would pass every REFUSE arm. So each refusal is paired with a PROCEED arm that
// differs by one character, and the suite FAILS if any arm class is never reached.
//
//   node scripts/tra4420-arg-guard-check.mjs
//   exit 0 = all arms pass · 1 = an arm failed

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
// ⛔ fileURLToPath, never `new URL(...).pathname` — on Windows that yields "/C:/Users/…",
// which spawn cannot resolve and which fails as `status: null`, i.e. it looks exactly like
// "the script crashed" rather than "the path was malformed".
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { KNOWN_ARGS, classifyArgs, renderUsage } from './render-redeploy.mjs';

const SCRIPT = fileURLToPath(new URL('./render-redeploy.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
// `--import` takes an ESM SPECIFIER, so it gets the file:// URL. The script argument below
// is the opposite: a filesystem path, because that is what spawn resolves.
const STUB = new URL('./lib/tra2387-render-api-stub.mjs', import.meta.url).href;

// The live service as the platform reports it (TRA-3743): `name` is `TradingAI-`, `slug` is
// `tradingai-bqb1`. Kept faithful so these arms exercise the same isSoakHost path a real run
// does. A sha that is not a commit in any checkout keeps the commit-hold gate offline;
// whatever it decides is downstream of the guard under test and is never asserted here.
const BQB1 = { id: 'srv-d7mb7rr7uimc73ev0chg', name: 'TradingAI-', slug: 'tradingai-bqb1', branch: 'main' };
// ⚠️ The PROCEED arms run against a NON-soak service, exactly as tra2387's do, and for the
// same reason: on bqb1 the stale-pin rollback gate (TRA-3625) reads the LIVE health route,
// which the stub does not serve, so every proceed arm would exit 8 BLIND — a refusal from a
// gate three layers downstream of the one under test. That would make this suite grade the
// network instead of the guard. The guard itself is host-agnostic: it runs before any
// service is resolved, which is why the REFUSE arms can stay on the faithful bqb1 fixture.
const OTHER = { id: 'srv-someothersvc', name: 'tradingai-scratch', slug: 'tradingai-scratch', branch: 'main' };
const NO_SUCH_SHA = '0000000000000000000000000000000000000000';
const ENV_OK = [{ key: 'PORT', value: '4000' }, { key: 'AUTH_SECRET', value: 'a-real-secret-value' }];

// ── Arm 1: the spawned bytes ─────────────────────────────────────────────────
// `class` is the reachability bucket; see the one-sidedness check at the bottom.
const E2E = [
  {
    // THE INCIDENT, run as an invocation. Exit 0 here is only reachable through the help
    // branch: with the API key present but the stub POST-refusing, the pre-fix bytes reach
    // the deploy and die in the stub, and with no key they exit 2. A green 0 that also
    // printed usage is the fix and nothing else is.
    why: '--help exits 0, PRINTS USAGE, deploys nothing — the 2026-09-09 incident',
    args: ['--help'],
    code: 0,
    class: 'help',
    stdoutHas: ['USAGE', '--commit=<sha>', 'It deploys nothing'],
    stdoutLacks: ['deploy  :'],
  },
  {
    why: '-h is the same read',
    args: ['-h'],
    code: 0,
    class: 'help',
    stdoutHas: ['USAGE'],
  },
  {
    // Help must survive being asked for BY somebody who mistyped, or the refusal has no exit.
    why: '--help wins over a bad flag: usage still prints, exit 0',
    args: ['--help', '--commmit=deadbeef'],
    code: 0,
    class: 'help',
    stdoutHas: ['USAGE'],
  },

  {
    // THE ONE THAT COSTS BYTES. Pre-fix this deployed the tip and exited 0.
    why: "--commmit=<sha> (typo, two m's) is REFUSED 2 and names the offender",
    args: [`--commmit=${NO_SUCH_SHA}`],
    code: 2,
    class: 'refuse',
    stderrHas: ['REFUSED (usage)', '--commmit', 'NOTHING WAS DEPLOYED', 'Did you mean `--commit`?'],
    // Discriminates against the pre-fix bytes, which also exit 2 — for the missing key.
    stderrLacks: ['RENDER_API_KEY'],
  },
  {
    why: '--commit <sha> (space, not =) is REFUSED 2 and says values attach with =',
    args: ['--commit', NO_SUCH_SHA],
    code: 2,
    class: 'refuse',
    stderrHas: ['REFUSED (usage)', "with an '='"],
    stderrLacks: ['RENDER_API_KEY'],
  },
  {
    why: '--commit= (empty value) is REFUSED 2 — indistinguishable from not saying it',
    args: ['--commit='],
    code: 2,
    class: 'refuse',
    stderrHas: ['REFUSED (usage)', 'empty value'],
  },
  {
    why: '--commit given twice is REFUSED 2 — array order must not pick what ships',
    args: [`--commit=${NO_SUCH_SHA}`, '--commit=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    code: 2,
    class: 'refuse',
    stderrHas: ['REFUSED (usage)', 'more than once'],
  },
  {
    // The worst shape on the list: `has()` compares for EQUALITY, so this did NOT enable
    // --dry-run. The operator asking for a rehearsal armed a real deploy.
    why: '--dry-run=true is REFUSED 2 — it did NOT enable --dry-run, it armed a real deploy',
    args: [`--commit=${NO_SUCH_SHA}`, '--dry-run=true'],
    code: 2,
    class: 'refuse',
    stderrHas: ['REFUSED (usage)', 'takes no value'],
  },
  {
    why: 'a bare positional is REFUSED 2',
    args: [NO_SUCH_SHA],
    code: 2,
    class: 'refuse',
    stderrHas: ['REFUSED (usage)', 'positional'],
  },
  {
    why: 'no target at all is REFUSED 2 — the bare origin/main-tip default is retired',
    args: ['--dry-run'],
    code: 2,
    class: 'refuse',
    stderrHas: ['REFUSED (usage)', 'no deploy target', '--tip'],
  },
  {
    why: '--commit and --tip together is REFUSED 2 — they disagree about what ships',
    args: [`--commit=${NO_SUCH_SHA}`, '--tip', '--dry-run'],
    code: 2,
    class: 'refuse',
    stderrHas: ['REFUSED (usage)', 'disagree'],
  },

  {
    // THE ARM THAT STOPS A HARDWIRED REFUSAL PASSING. One character different from the typo
    // case above, and it must go all the way through the guard INTO THE DEPLOY BODY — the
    // ticket's third control: "--commit=<sha> still deploys that exact sha". Asserting the
    // rendered `commitId` is as close to that as an offline arm can get, and it is the part
    // that matters: the sha the operator typed is the sha in the request.
    why: '--commit=<sha> --dry-run PROCEEDS, and THAT EXACT SHA reaches the deploy body',
    args: [`--commit=${NO_SUCH_SHA}`, '--dry-run'],
    service: OTHER,
    code: 0,
    class: 'proceed',
    stdoutHas: [`"commitId":"${NO_SUCH_SHA}"`, 'would POST'],
    stderrLacks: ['REFUSED (usage)'],
  },
  {
    why: '--tip PROCEEDS past the guard — the capability is kept, it just has to be said',
    args: ['--tip', '--dry-run'],
    service: OTHER,
    // Deliberately NOT asserting exit 0: resolving the tip needs `git ls-remote origin`, so
    // pinning a code here would make this arm grade the network. What is under test is that
    // the guard ADMITS --tip, which `codeNot: 2` + the absent usage refusal says exactly.
    codeNot: 2,
    class: 'proceed',
    stderrLacks: ['REFUSED (usage)'],
  },
  {
    // Bare override flags are admitted by the guard ON PURPOSE: each gate refuses its own
    // with the specific message naming what a reason must contain (and, for --override-hold,
    // the ticket). Promoting them to a generic usage error here would replace a good message
    // with a worse one, so the guard must NOT treat a bare override as malformed.
    why: 'an override flag written BARE is admitted by the guard (its own gate owns that refusal)',
    args: [`--commit=${NO_SUCH_SHA}`, '--dry-run', '--force-rth-override'],
    service: OTHER,
    code: 0,
    class: 'proceed',
    stderrLacks: ['REFUSED (usage)'],
  },
  {
    why: 'the full documented invocation with a reasoned override PROCEEDS through the guard',
    args: [
      `--commit=${NO_SUCH_SHA}`,
      '--dry-run',
      '--clear-cache',
      '--force-rth-override=TRA-4420 control arm, not a real deploy',
    ],
    service: OTHER,
    code: 0,
    class: 'proceed',
    stdoutHas: ['clear-cache'],
    stderrLacks: ['REFUSED (usage)'],
  },
];

const runScript = (scriptPath, args, service) =>
  spawnSync(process.execPath, ['--import', STUB, scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      RENDER_API_KEY: 'stub-key-not-a-real-credential',
      RENDER_SERVICE_ID: service.id,
      TRA2387_STUB: JSON.stringify({ service, envVars: ENV_OK }),
    },
  });

// ── Arm 0: THE NEGATIVE CONTROL — do the PRE-FIX bytes still bite? ───────────
// Without this, every arm below could go green because the repro stopped reproducing, and a
// suite that passes against both the fix and the bug has verified nothing (TRA-1787; the
// same reasoning as tra3699's ARM 1b, which re-runs its own pre-fix rev).
//
// It reconstitutes `a187fc14:scripts/render-redeploy.mjs` — the bytes that were live on the
// day of the incident — and asserts they REACH `POST /services/{id}/deploys`. Only the stub
// stops them, which is the whole finding: on 2026-09-09 nothing stopped them and bqb1 got
// `dep-dagcbqp5efls73ac5d40`. It runs from scripts/ so its `./lib/…` imports resolve, and is
// deleted in a finally.
const PRE_FIX_REV = 'a187fc14';
const PRE_FIX_PATH = fileURLToPath(new URL('./.tra4420-prefix.tmp.mjs', import.meta.url));
const PRE_FIX_VECTORS = [
  ['--help', 'the literal 2026-09-09 invocation'],
  [`--commmit=${NO_SUCH_SHA}`, "the two-m typo — deploys the TIP, not the named sha"],
];
const control = [];
console.log(`arm 0 — negative control: the PRE-FIX bytes (${PRE_FIX_REV}) must still reach the deploy POST:`);
{
  const show = spawnSync('git', ['show', `${PRE_FIX_REV}:scripts/render-redeploy.mjs`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (show.status !== 0 || !show.stdout) {
    // ⛔ Not a pass. "Could not check" and "checked and it is fine" must never share an
    // outcome — the same rule the deploy-build gate is built on.
    control.push(`could not read ${PRE_FIX_REV}:scripts/render-redeploy.mjs from this checkout (shallow clone?)`);
    console.log(`  FAIL ${control[0]}`);
  } else {
    try {
      writeFileSync(PRE_FIX_PATH, show.stdout);
      for (const [arg, why] of PRE_FIX_VECTORS) {
        const pre = runScript(PRE_FIX_PATH, [arg], OTHER);
        const reached = /refusing to serve a POST/.test(pre.stderr ?? '');
        if (reached) {
          console.log(`  ok   pre-fix \`${arg}\` REACHED the deploy POST — ${why}`);
        } else {
          control.push(`pre-fix \`${arg}\` no longer reaches the POST, so the arms below prove nothing`);
          console.log(`  FAIL pre-fix \`${arg}\` did not reach the POST (exit ${pre.status}) — the repro has stopped biting`);
        }
      }
    } finally {
      rmSync(PRE_FIX_PATH, { force: true });
    }
  }
}

let e2ePass = 0;
const e2eFailures = [];
console.log('');
console.log('arm 1 — the SHIPPED BYTES of render-redeploy.mjs, stubbed Render API (every POST throws):');
for (const c of E2E) {
  const r = runScript(SCRIPT, c.args, c.service ?? BQB1);
  const out = r.stdout ?? '';
  const err = r.stderr ?? '';
  const problems = [];
  if (c.code !== undefined && r.status !== c.code) problems.push(`exit ${r.status}, expected ${c.code}`);
  if (c.codeNot !== undefined && r.status === c.codeNot) problems.push(`exit ${r.status}, expected anything but ${c.codeNot}`);
  for (const s of c.stdoutHas ?? []) if (!out.includes(s)) problems.push(`stdout missing "${s}"`);
  for (const s of c.stderrHas ?? []) if (!err.includes(s)) problems.push(`stderr missing "${s}"`);
  for (const s of c.stdoutLacks ?? []) if (out.includes(s)) problems.push(`stdout unexpectedly contains "${s}"`);
  for (const s of c.stderrLacks ?? []) if (err.includes(s)) problems.push(`stderr unexpectedly contains "${s}"`);
  // Nothing may ever reach the POST. The stub throws there, so this is belt AND braces.
  if (/refusing to serve a POST/.test(err)) problems.push('REACHED THE DEPLOY POST — the stub had to stop it');
  if (problems.length === 0) {
    e2ePass += 1;
    console.log(`  ok   exit ${String(r.status).padEnd(2)} ${c.why}`);
  } else {
    e2eFailures.push({ why: c.why, problems });
    console.log(`  FAIL ${c.why}\n         ${problems.join('\n         ')}`);
    if (err) console.log(`         stderr[0]: ${err.split('\n')[0]}`);
  }
}

// ── Arm 2: the predicate, for the shapes it is cheap to enumerate ────────────
// Secondary by design (see the header). It exists to pin the classification of shapes the
// spawn arm would only cover redundantly.
//
// Graded on the SET OF PROBLEM KINDS, not a count. Note that every malformed target also
// yields `no-target`, and that is the right diagnosis rather than noise: an operator who
// typed `--commmit=<sha>` has both a flag this script does not know AND no statement of what
// to ship, and the second is the one that used to silently resolve to the branch tip.
const CASES = [
  [['--commit=abc'], [], 'the canonical invocation'],
  [['--tip'], [], 'the explicit tip opt-in'],
  [['--tip', '--dry-run', '--clear-cache'], [], 'tip + both no-value flags'],
  [['--commit=abc', '--force-rth-override'], [], 'bare override flag — the GATE owns that refusal'],
  [['--commit=abc', '--force-rth-override=why'], [], 'override with a reason'],
  [['--commit=abc', '--override-hold=TRA-1 why'], [], 'reason containing a space'],
  [['--commmit=abc'], ['no-target', 'unknown'], "the two-m typo — THE incident's expensive sibling"],
  [['--comit=abc'], ['no-target', 'unknown'], 'the dropped-m typo'],
  [['--commit', 'abc'], ['missing-value', 'no-target', 'positional'], 'the space form'],
  [['--commit='], ['empty-value', 'no-target'], 'empty value'],
  [['--commit=   '], ['empty-value', 'no-target'], 'whitespace-only value'],
  [['--commit=a', '--commit=b'], ['duplicate'], 'duplicate — first wins, silently, pre-fix'],
  [['--dry-run=true'], ['no-target', 'unexpected-value'], 'no-value flag given a value'],
  [['-commit=abc'], ['no-target', 'unknown'], 'single dash'],
  [['abc'], ['no-target', 'positional'], 'bare positional'],
  [[], ['no-target'], 'no arguments at all — the old silent-tip default'],
  [['--tip', '--commit=abc'], ['conflicting-target'], 'both targets'],
  [['--clear-cache'], ['no-target'], 'options but no target'],
];
let predPass = 0;
const predFailures = [];
const kindsSeen = new Set();
console.log('');
console.log('arm 2 — classifyArgs() over the shapes, graded on the KINDS produced:');
for (const [argv, want, why] of CASES) {
  const got = [...new Set(classifyArgs(argv).problems.map(p => p.kind))].sort();
  for (const k of got) kindsSeen.add(k);
  const ok = got.join(',') === [...want].sort().join(',');
  if (ok) {
    predPass += 1;
    console.log(`  ok   [${got.join(' ')}]`.padEnd(52) + `${JSON.stringify(argv)}  ${why}`);
  } else {
    predFailures.push({ argv, want, got, why });
    console.log(`  FAIL [${got.join(' ')}] want [${want.join(' ')}]  ${JSON.stringify(argv)}  ${why}`);
  }
}
// Reachability: a kind the table never produces is a branch nothing grades.
const ALL_KINDS = [
  'unknown',
  'positional',
  'duplicate',
  'unexpected-value',
  'missing-value',
  'empty-value',
  'conflicting-target',
  'no-target',
];
const kindsMissing = ALL_KINDS.filter(k => !kindsSeen.has(k));
// --help must never be turned into a refusal by the company it keeps.
const helpCases = [['--help'], ['-h'], ['--help', '--nonsense'], ['--help', '--commit=a', '--tip']];
for (const argv of helpCases) {
  const ok = classifyArgs(argv).help === true;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} help=true  ${JSON.stringify(argv)}`);
  if (!ok) predFailures.push({ argv, want: 'help', got: 'no help', why: 'help must win' });
}

// ── Arm 3: the table cannot drift away from the code that reads it ───────────
// A flag added to main()'s parsing but not to KNOWN_ARGS would be REJECTED BY ITS OWN
// SCRIPT the first time anyone used it — the guard turning into the defect's mirror image.
// So read the source and assert every flag literal it actually looks up is in the table.
const SRC = readFileSync(SCRIPT, 'utf8');
const known = new Set(KNOWN_ARGS.flatMap(k => [k.flag, k.alias].filter(Boolean)));
const readFlags = new Set();
for (const m of SRC.matchAll(/(?:has|valOf)\('(--[a-z0-9-]+)'\)/g)) readFlags.add(m[1]);
for (const m of SRC.matchAll(/a === '(--[a-z0-9-]+)'/g)) readFlags.add(m[1]);
const undeclared = [...readFlags].filter(f => !known.has(f));
console.log('');
console.log(`arm 3 — flags parsed by the script: ${[...readFlags].sort().join(' ')}`);
console.log(`         KNOWN_ARGS:                ${[...known].sort().join(' ')}`);
console.log(`  ${undeclared.length === 0 ? 'ok   no drift' : `FAIL parsed-but-undeclared: ${undeclared.join(', ')}`}`);
// And the mirror: usage must document every flag the table declares, or --help is a lie.
const usage = renderUsage();
const undocumented = [...known].filter(f => !usage.includes(f));
console.log(`  ${undocumented.length === 0 ? 'ok   usage documents every declared flag' : `FAIL undocumented: ${undocumented.join(', ')}`}`);

// ── One-sidedness ────────────────────────────────────────────────────────────
// A suite that only ever asserts refusals rubber-stamps a script hardwired to refuse, which
// is a worse outage than the bug: it takes the only deploy path to the money host offline.
const classes = new Set(E2E.map(c => c.class));
const missingClasses = ['help', 'refuse', 'proceed'].filter(c => !classes.has(c));

console.log('');
console.log(`arms    : ${e2ePass}/${E2E.length} invocation · ${predPass}/${CASES.length} predicate`);

let bad = false;
if (control.length) {
  console.error(
    `[tra4420] FAIL: the negative control did not hold — ${control.join('; ')}. ` +
      'Every arm below would pass against the unfixed script, so this run is not evidence.',
  );
  bad = true;
}
if (e2eFailures.length) {
  console.error(
    `[tra4420] FAIL: ${e2eFailures.length} invocation arm(s) failed — the predicate may be correct but ` +
      'render-redeploy.mjs is not behaving as though main() calls it.',
  );
  bad = true;
}
if (predFailures.length) {
  console.error(`[tra4420] FAIL: ${predFailures.length} predicate case(s) failed.`);
  bad = true;
}
if (undeclared.length) {
  console.error(
    `[tra4420] FAIL: ${undeclared.join(', ')} is parsed by render-redeploy.mjs but missing from KNOWN_ARGS — ` +
      'the guard would refuse a flag the script itself supports.',
  );
  bad = true;
}
if (undocumented.length) {
  console.error(`[tra4420] FAIL: --help does not document ${undocumented.join(', ')}.`);
  bad = true;
}
if (missingClasses.length) {
  console.error(`[tra4420] FAIL: no invocation arm exercises: ${missingClasses.join(', ')} — the suite is one-sided.`);
  bad = true;
}
if (kindsMissing.length) {
  console.error(`[tra4420] FAIL: problem kind(s) never produced by any case: ${kindsMissing.join(', ')} — nothing grades that branch.`);
  bad = true;
}
if (bad) process.exit(1);

console.log(
  '[tra4420] PASS — --help prints usage and exits 0 without deploying; a mistyped, space-formed, ' +
    'empty, duplicated or unknown argument is REFUSED (exit 2) naming the offender; a correct ' +
    '--commit=<sha> still carries that exact sha into the deploy body; and the branch tip now ' +
    'requires an explicit --tip.',
);
process.exit(0);
