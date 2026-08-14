#!/usr/bin/env node
// TRA-3695 — run the DEPLOY'S OWN build command in front of `main`, and refuse the push.
//
// THE HAZARD
// ----------
// `070a188a` (TRA-3589) reached `origin/main` carrying a hard TypeScript error:
//
//   src/tra3589-equity-source-era.test.ts(202,66): error TS18047: 'r.postBaselineEquityGrowth' is possibly 'null'.
//    ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @trading-app/server@0.0.0 build: `tsc -b --force`
//   Exit status 2
//
// Eight further commits landed on top of it, every one un-deployable, until a deploy
// train for the go-live soak path (TRA-3660 -> TRA-1648) died five times in a row at
// 02:00Z. THE DETECTOR WAS A LIVE DEPLOY TO THE MONEY HOST. bqb1 sat 9+ commits behind
// with nobody told (Render emits no event for a deploy that did not happen — TRA-2229
// through a different door), and the break was only observable there, so the bisect was
// walked forward ON bqb1: it briefly served two off-tip mid-train builds (`4ed46445`,
// `87133315`) between 02:15Z and 02:21Z.
//
// THE ASYMMETRY THAT IS THE DEFECT
// --------------------------------
// The ADVISORY check runs pre-deploy and the BLOCKING one runs only at deploy time:
//
//   [render-build] lint reported issues (non-blocking for deploy; fix via CI/pre-commit)
//
// Lint runs in the Render build and shrugs, by design. `pnpm build` — the thing that
// actually gates the deploy — ran nowhere in front of `main`. CI (`.github/workflows/
// ci.yml`) does compile the packages, but it runs ON push to main, which is AFTER the
// commit is on the branch the deploy pulls from. A detector behind the branch is what we
// already had; this is the gate in front of it.
//
// THE SHARP EDGE
// --------------
// `tsc -b --force` TYPE-CHECKS THE `.test.ts` FILES. A test file cannot break the suite
// here — it breaks the BUILD, without ever running. So "tests pass" is not evidence, and
// neither is `pnpm typecheck`, whose project graph is not the graph `packages/server`'s
// build compiles. THIS GATE THEREFORE RUNS NO PROXY. It parses the deploy's own build
// script out of `package.json` and executes those segments verbatim. Nothing about the
// chain is hardcoded here; if the deploy's chain changes, the graded chain changes with
// it, and if it changes SHAPE the gate reads BLIND rather than guessing (exit 3).
//
// WHICH command the deploy runs is itself not knowable from this repo: `render.yaml`
// pins `buildCommand: pnpm install --frozen-lockfile && pnpm run web:build`, while the
// live bqb1 build log prints `[render-build]`, which only `render-build` emits. The two
// are NOT the same chain — `render-build` hardcodes four packages and `web:build` globs
// five (`packages/agents` is in the glob and NOT in the hardcoded list). So this gate
// grades the UNION of every declared deploy chain and does not have to be right about
// which one the dashboard holds. If `render.yaml` ever names a build script that is not
// in DEPLOY_BUILD_SCRIPTS, that is BLIND, not a pass.
//
// THE SUBJECT IS THE COMMIT, NEVER THE WORKING TREE
// -------------------------------------------------
// The default subject is the sha being pushed, built in a throwaway `git worktree` with
// the installed `node_modules` junctioned in. Grading the working tree in place would be
// wrong in BOTH directions: an unstaged fix in the tree passes a broken commit (false
// PASS, the exact failure this ticket exists to close), and an unrelated dirty file fails
// a clean one (false FAIL — and a gate that is red for reasons the author did not cause
// gets `--no-verify`'d on day one, which is the same end state as no gate). Isolation
// costs ~70s and removes both. `--worktree` grades the tree in place for fast local
// iteration and says so loudly; the hook never uses it.
//
// EXIT CODES — four states, on purpose
//   0  CLEAN   the subject commit builds with the deploy's own command
//   1  BROKEN  it does not — THE INCIDENT. This is the only code that should refuse a push.
//   2  usage
//   3  BLIND   the gate could not grade (chain shape unrecognised, worktree failed, ...).
//              Fails CLOSED: the hook refuses on BLIND too, because "could not check" and
//              "checked and it is fine" must never share an exit code.
//   Precedence: BLIND > BROKEN > CLEAN.
//
// USAGE
//   node scripts/check-deploy-build.mjs                # grade HEAD in isolation
//   node scripts/check-deploy-build.mjs --rev=<sha>    # grade any commit
//   node scripts/check-deploy-build.mjs --worktree     # grade the dirty tree in place
//   node scripts/check-deploy-build.mjs --hook         # pre-push mode (reads git's stdin)
//   node scripts/check-deploy-build.mjs --verify-hook  # is the gate actually INSTALLED?
//   node scripts/check-deploy-build.mjs --selftest     # both-direction controls
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXIT_CLEAN = 0;
const EXIT_BROKEN = 1;
const EXIT_USAGE = 2;
const EXIT_BLIND = 3;

// Every script that could be the deploy's build command. See the header: render.yaml and
// the live bqb1 build log disagree, so both are graded and the gate does not have to pick.
const DEPLOY_BUILD_SCRIPTS = ['render-build', 'web:build'];

// The one advisory segment the deploy runs and explicitly does not gate on. It is dropped
// from the graded chain — and the DROP IS ASSERTED, not assumed: if the prefix before the
// first `;` is not this lint-or-echo shape, the script has changed in a way this parser
// does not understand and the gate reads BLIND.
const ADVISORY_PREFIX = /^\s*pnpm\s+lint\s*\|\|\s*echo\b/;

// A graded segment must be a pnpm workspace build invocation. Anything else and we do not
// know how to run it faithfully, so we refuse to guess.
const SEGMENT_SHAPE = /^pnpm\s+(?:-r\s+)?--filter\s+\S+/;

// Junctioned into the throwaway worktree so the isolated build does not need an install.
// Relative depth is preserved, so the `../../../node_modules/.pnpm/...` links pnpm writes
// inside each package resolve back through the root junction.
const NODE_MODULES_DIRS = ['', 'packages/agents', 'packages/backtest', 'packages/engine', 'packages/server', 'packages/shared', 'apps/desktop'];

const HOOK_REL = '.githooks/pre-push';
const HOOKS_PATH = '.githooks';

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? REPO_ROOT, encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

class Blind extends Error {}

// Split a shell command on a top-level delimiter, ignoring anything inside quotes.
//
// A naive `indexOf(';')` is WRONG on the real script and the controls caught it: the
// advisory segment is
//   pnpm lint || echo '[render-build] lint reported issues (non-blocking for deploy; fix ...)'
// and that parenthetical carries a `;` INSIDE the single-quoted echo argument. Cutting
// there produces a "segment" of `fix via CI/pre-commit)'` — which this gate reads as an
// unrunnable shape and refuses on. That is the right failure, but for the wrong reason,
// and a quote-blind parser would eventually cut somewhere that still LOOKS runnable.
function splitTopLevel(cmd, delim) {
  const parts = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    if (cmd.startsWith(delim, i)) {
      parts.push(buf);
      buf = '';
      i += delim.length - 1;
      continue;
    }
    buf += c;
  }
  parts.push(buf);
  if (quote) throw new Blind(`unbalanced ${quote} in build command: ${cmd}`);
  return parts;
}

// ---------------------------------------------------------------------------
// Arm 1 — derive the graded chain FROM THE DEPLOY'S OWN SCRIPTS. Fails closed.
// ---------------------------------------------------------------------------
function deriveChain(pkgJsonPath = join(REPO_ROOT, 'package.json'), renderYamlPath = join(REPO_ROOT, 'render.yaml')) {
  let pkg;
  try {
    pkg = readJson(pkgJsonPath);
  } catch (e) {
    throw new Blind(`cannot read ${pkgJsonPath}: ${e.message}`);
  }
  const scripts = pkg.scripts ?? {};

  // render.yaml must not name a build script we are not grading. This is the drift arm:
  // it is how a future edit that re-points the deploy at some third chain surfaces as
  // BLIND here instead of as a silent blind spot one level down.
  if (existsSync(renderYamlPath)) {
    const yaml = readFileSync(renderYamlPath, 'utf8');
    const m = yaml.match(/^\s*buildCommand:\s*(.+)$/m);
    if (!m) throw new Blind('render.yaml has no `buildCommand:` — cannot confirm what the deploy builds');
    const named = [...m[1].matchAll(/pnpm\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g)]
      .map((x) => x[1])
      .filter((n) => n in scripts);
    if (named.length === 0) throw new Blind(`render.yaml buildCommand names no package.json script: ${m[1].trim()}`);
    for (const n of named) {
      if (!DEPLOY_BUILD_SCRIPTS.includes(n)) {
        throw new Blind(
          `render.yaml buildCommand runs \`${n}\`, which is not in DEPLOY_BUILD_SCRIPTS ` +
            `[${DEPLOY_BUILD_SCRIPTS.join(', ')}] — this gate would grade a chain the deploy does not run`,
        );
      }
    }
  }

  const segments = [];
  const provenance = [];
  for (const name of DEPLOY_BUILD_SCRIPTS) {
    const raw = scripts[name];
    if (typeof raw !== 'string') throw new Blind(`package.json has no \`${name}\` script — the deploy's build command is not where this gate looks`);

    const statements = splitTopLevel(raw, ';');
    let body = raw;
    if (statements.length > 1) {
      // Every statement but the LAST is advisory-or-unknown; each one must be recognised
      // as the known non-blocking lint segment before it is dropped. Anything else and the
      // script does something this gate does not model, which is BLIND.
      for (const s of statements.slice(0, -1)) {
        if (!ADVISORY_PREFIX.test(s)) {
          throw new Blind(`\`${name}\` has an unrecognised statement before its final \`;\`: ${s.trim()}`);
        }
        provenance.push(`${name}: dropped advisory statement \`${s.trim()}\``);
      }
      body = statements[statements.length - 1];
    }

    for (const seg of splitTopLevel(body, '&&').map((s) => s.trim()).filter(Boolean)) {
      if (!SEGMENT_SHAPE.test(seg)) {
        throw new Blind(`\`${name}\` contains a segment this gate cannot run faithfully: \`${seg}\``);
      }
      if (!segments.includes(seg)) segments.push(seg);
    }
  }
  if (segments.length === 0) throw new Blind('derived an empty build chain');
  return { segments, provenance };
}

// ---------------------------------------------------------------------------
// Arm 2 — materialise the subject
// ---------------------------------------------------------------------------
function makeIsolatedSubject(rev) {
  const sha = git(['rev-parse', '--verify', `${rev}^{commit}`]);
  if (sha.code !== 0) throw new Blind(`cannot resolve \`${rev}\`: ${sha.err || 'unknown'}`);

  const dir = mkdtempSync(join(tmpdir(), 'tra3695-deploy-build-'));
  const wt = join(dir, 'subject');
  const add = git(['worktree', 'add', '--detach', wt, sha.out]);
  if (add.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Blind(`git worktree add failed: ${add.err || add.out}`);
  }

  for (const d of NODE_MODULES_DIRS) {
    const target = join(REPO_ROOT, d, 'node_modules');
    if (!existsSync(target)) continue;
    const link = join(wt, d, 'node_modules');
    mkdirSync(dirname(link), { recursive: true });
    try {
      symlinkSync(target, link, 'junction');
    } catch (e) {
      cleanupIsolatedSubject({ dir, wt });
      throw new Blind(`cannot link node_modules for \`${d || '<root>'}\`: ${e.message} — run \`pnpm install\` first`);
    }
  }
  return { dir, wt, sha: sha.out };
}

function cleanupIsolatedSubject(sub) {
  if (!sub) return;
  // Remove the junctions before the tree, so a recursive delete can never walk INTO the
  // real node_modules. `git worktree remove --force` does the right thing here, but the
  // rmSync fallback below must not be given the chance to be wrong.
  for (const d of NODE_MODULES_DIRS) {
    const link = join(sub.wt, d, 'node_modules');
    try {
      if (existsSync(link)) rmSync(link, { recursive: false, force: true });
    } catch {
      /* best effort */
    }
  }
  git(['worktree', 'remove', '--force', sub.wt]);
  try {
    rmSync(sub.dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  git(['worktree', 'prune']);
}

// ---------------------------------------------------------------------------
// Arm 3 — run the chain
// ---------------------------------------------------------------------------
function runChain(segments, cwd, { quiet = false } = {}) {
  for (const seg of segments) {
    if (!quiet) console.log(`[deploy-build] $ ${seg}`);
    const r = spawnSync(seg, { cwd, shell: true, encoding: 'utf8' });
    if (r.status !== 0) {
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      return { ok: false, segment: seg, status: r.status, output: out };
    }
  }
  return { ok: true };
}

// The compiler lines are the only part of a failed build anybody needs. Print those, not
// 400 lines of pnpm banner — a gate whose output has to be scrolled gets skimmed.
function errorLines(output) {
  const lines = output.split(/\r?\n/);
  const hits = lines.filter((l) => /error TS\d+|ERR_PNPM|Exit status|error during build|^\s*✘|error:/i.test(l));
  return (hits.length ? hits : lines.filter(Boolean).slice(-20)).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------
function grade({ rev = 'HEAD', inTree = false, quiet = false } = {}) {
  const { segments, provenance } = deriveChain();
  if (!quiet) {
    console.log('[deploy-build] graded chain, derived from the deploy\'s own scripts:');
    for (const p of provenance) console.log(`[deploy-build]   (${p})`);
    for (const s of segments) console.log(`[deploy-build]   ${s}`);
  }

  if (inTree) {
    const head = git(['rev-parse', '--short', 'HEAD']).out;
    console.log(`[deploy-build] SUBJECT: THE WORKING TREE (HEAD ${head} + whatever is uncommitted). NOT the commit.`);
    const r = runChain(segments, REPO_ROOT, { quiet });
    return { code: r.ok ? EXIT_CLEAN : EXIT_BROKEN, failure: r, subject: `worktree@${head}` };
  }

  let sub;
  try {
    sub = makeIsolatedSubject(rev);
    if (!quiet) console.log(`[deploy-build] SUBJECT: commit ${sub.sha.slice(0, 8)} in an isolated worktree (the tree's dirt cannot reach it)`);
    const r = runChain(segments, sub.wt, { quiet });
    return { code: r.ok ? EXIT_CLEAN : EXIT_BROKEN, failure: r, subject: sub.sha };
  } finally {
    cleanupIsolatedSubject(sub);
  }
}

function report(result) {
  if (result.code === EXIT_CLEAN) {
    console.log(`[deploy-build] CLEAN — ${result.subject} builds with the deploy's own command.`);
    return;
  }
  console.error('');
  console.error('[deploy-build] BROKEN — this does NOT build. The deploy would die on it.');
  console.error(`[deploy-build] subject : ${result.subject}`);
  console.error(`[deploy-build] segment : ${result.failure.segment}`);
  console.error(`[deploy-build] exit    : ${result.failure.status}`);
  console.error('');
  for (const l of errorLines(result.failure.output)) console.error(`    ${l}`);
  console.error('');
}

// ---------------------------------------------------------------------------
// --verify-hook — is the gate INSTALLED? "Installed" is exactly the thing that
// silently is not, so it is measured rather than assumed.
// ---------------------------------------------------------------------------
function verifyHook({ requireConfig = true } = {}) {
  const problems = [];
  const hookFile = join(REPO_ROOT, HOOK_REL);
  if (!existsSync(hookFile)) {
    problems.push(`${HOOK_REL} is missing from the repo`);
  } else {
    // On disk is not the same as in the repo. An untracked hook arms THIS clone and nobody
    // else's, which is the shape of a gate that reads as installed and is not.
    if (git(['ls-files', '--error-unmatch', HOOK_REL]).code !== 0) {
      problems.push(`${HOOK_REL} exists on disk but is NOT tracked by git — no other clone would get it`);
    }
    const body = readFileSync(hookFile, 'utf8');
    if (!body.includes('check-deploy-build.mjs')) problems.push(`${HOOK_REL} does not invoke check-deploy-build.mjs`);
    if (!/--hook\b/.test(body)) problems.push(`${HOOK_REL} does not pass --hook`);
  }

  const pkg = readJson(join(REPO_ROOT, 'package.json'));
  const prepare = pkg.scripts?.prepare ?? '';
  if (!prepare.includes('install-git-hooks')) {
    problems.push('root package.json `prepare` does not run scripts/install-git-hooks.mjs — a fresh clone would not install the gate');
  }

  if (requireConfig) {
    const cfg = git(['config', '--get', 'core.hooksPath']);
    if (cfg.out !== HOOKS_PATH) {
      problems.push(`core.hooksPath is \`${cfg.out || '<unset>'}\`, not \`${HOOKS_PATH}\` — the gate is NOT armed in this clone. Run \`pnpm hooks:install\`.`);
    }
  }

  if (problems.length) {
    console.error('[deploy-build] hook verification FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    return EXIT_BROKEN;
  }
  console.log('[deploy-build] hook verified: committed, wired to `prepare`' + (requireConfig ? ', and armed via core.hooksPath' : ''));
  return EXIT_CLEAN;
}

// ---------------------------------------------------------------------------
// --hook — pre-push
// ---------------------------------------------------------------------------
const ZERO = /^0{40,64}$/;

// `readFileSync(0)` is NOT enough here, and the first live push proved it: git hands the
// hook its ref list on a PIPE, and on Windows a single read of a pipe that is not yet ready
// comes back EMPTY rather than blocking. The gate then fell through to its no-stdin branch
// and graded HEAD. It happened to be the same commit that time, so nothing was missed — but
// the ref filter and the multi-ref loop had silently stopped running, which is a blind spot
// that only shows up on the push where HEAD is not what you are pushing.
//
// So: read to EOF, retrying EAGAIN, and report WHICH path produced the result.
function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  const deadline = Date.now() + 5000;
  for (;;) {
    let n;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN' && Date.now() < deadline) {
        // Busy-wait a beat. A hook has no event loop to yield to before it must answer.
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']);
        continue;
      }
      if (e.code === 'EOF' || e.code === 'EAGAIN') break;
      return { text: chunks.join(''), read: false, reason: `${e.code ?? e.message}` };
    }
    if (n === 0) break;
    chunks.push(buf.toString('utf8', 0, n));
  }
  return { text: chunks.join(''), read: true, reason: '' };
}

function hookMode() {
  const stdin = readStdin();
  const rows = stdin.text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(/\s+/));

  // No stdin (hand-run, or a git that fed us nothing) — grade HEAD rather than wave it
  // through. A gate that no-ops when it cannot read its input is not a gate. Say so out
  // loud, because in this branch the ref filter below is not running.
  const targets = [];
  if (rows.length === 0) {
    console.warn(`[deploy-build] no ref list on stdin${stdin.reason ? ` (${stdin.reason})` : ''} — grading HEAD instead, and NOT filtering by ref.`);
    targets.push({ sha: 'HEAD', remoteRef: '(no stdin — grading HEAD)' });
  } else {
    for (const [, localSha, remoteRef] of rows) {
      if (!localSha || ZERO.test(localSha)) continue; // branch deletion
      if (remoteRef && !/^refs\/heads\/(main|master)$/.test(remoteRef)) {
        console.log(`[deploy-build] skipping ${remoteRef} — this gate stands in front of main.`);
        continue;
      }
      if (!targets.some((t) => t.sha === localSha)) targets.push({ sha: localSha, remoteRef });
    }
  }

  if (targets.length === 0) return EXIT_CLEAN;

  for (const t of targets) {
    console.log(`[deploy-build] TRA-3695 pre-push gate: building ${String(t.sha).slice(0, 8)} with the DEPLOY'S OWN command (~70s).`);
    const result = grade({ rev: t.sha });
    report(result);
    if (result.code !== EXIT_CLEAN) {
      console.error('[deploy-build] PUSH REFUSED. This commit would not deploy, and the money host is not a compiler.');
      console.error('[deploy-build] Fix it and re-push. `git push --no-verify` bypasses this gate and hands you the deploy.');
      return result.code;
    }
  }
  return EXIT_CLEAN;
}

// ---------------------------------------------------------------------------
// --selftest — controls, both directions, on the REAL historical break
// ---------------------------------------------------------------------------
//
// A positive control must CONTAIN what it detects. The subject here is not a synthetic
// plant: it is `070a188a`, the commit that actually broke the deploy, and the assertion is
// that this gate reproduces the Render log's own error text. Its sibling is `1ff4fa7b`,
// the fix, which must read CLEAN — a detector that only ever says BROKEN is not one.
const BREAK_SHA = '070a188a';
const FIX_SHA = '1ff4fa7b';
const BREAK_SIGNATURE = /tra3589-equity-source-era\.test\.ts\(202,66\): error TS18047/;

function selftest() {
  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  console.log('[deploy-build] controls');

  // -- Control 1: the chain derivation is real, and names the command that gates the deploy.
  let derived = null;
  try {
    derived = deriveChain();
    check('derives a chain from the deploy\'s own scripts', true, `${derived.segments.length} segments`);
  } catch (e) {
    check('derives a chain from the deploy\'s own scripts', false, e.message);
  }
  check(
    'the derived chain contains the segment that actually failed the deploy',
    !!derived && derived.segments.some((s) => /--filter\s+@trading-app\/server\s+build/.test(s)),
  );
  check(
    'the advisory lint segment is DROPPED, not graded',
    !!derived && !derived.segments.some((s) => /\blint\b/.test(s)) && derived.provenance.some((p) => /lint/.test(p)),
  );

  // -- Control 2: the parser fails CLOSED. A chain shape it does not understand must read
  // BLIND, never silently grade a shorter chain.
  const tmpDir = mkdtempSync(join(tmpdir(), 'tra3695-parse-'));
  const writeProbe = (scripts) => {
    const p = join(tmpDir, 'package.json');
    writeFileSync(p, JSON.stringify({ scripts }, null, 2));
    return p;
  };
  const blindOn = (scripts, label) => {
    const p = writeProbe(scripts);
    let blind = false;
    let msg = '';
    try {
      deriveChain(p, join(tmpDir, 'no-render.yaml'));
    } catch (e) {
      blind = e instanceof Blind;
      msg = e.message;
    }
    check(label, blind, blind ? '' : `graded instead of reading BLIND${msg ? ` (${msg})` : ''}`);
  };
  blindOn(
    { 'render-build': 'npm run something-else; pnpm --filter @trading-app/server build', 'web:build': 'pnpm --filter desktop vite:build' },
    'an unrecognised advisory prefix reads BLIND',
  );
  blindOn(
    { 'render-build': 'pnpm lint || echo x; rm -rf / && pnpm --filter @trading-app/server build', 'web:build': 'pnpm --filter desktop vite:build' },
    'a segment that is not a pnpm workspace build reads BLIND',
  );
  blindOn({ 'web:build': 'pnpm --filter desktop vite:build' }, 'a MISSING deploy build script reads BLIND');

  // The live `render-build` carries a `;` INSIDE its quoted echo argument ("...for deploy;
  // fix via CI/pre-commit"). A quote-blind split cuts there and loses the whole build chain.
  // This is regression cover for exactly that, pinned to the real string, not a paraphrase.
  {
    const real = 'pnpm lint || echo \'[render-build] lint reported issues (non-blocking for deploy; fix via CI/pre-commit)\'; pnpm --filter @trading-app/shared build && pnpm --filter @trading-app/server build';
    const p = writeProbe({ 'render-build': real, 'web:build': 'pnpm --filter desktop vite:build' });
    let segs = null;
    try {
      segs = deriveChain(p, join(tmpDir, 'no-render.yaml')).segments;
    } catch {
      /* leaves segs null — reported as BLIND by the check below */
    }
    check(
      'a `;` inside the quoted echo does not amputate the build chain',
      !!segs && segs.includes('pnpm --filter @trading-app/shared build') && segs.includes('pnpm --filter @trading-app/server build'),
      segs ? `got [${segs.join(' | ')}]` : 'read BLIND',
    );
  }

  // -- Control 3: a render.yaml pointing at a chain we do not grade reads BLIND. This is
  // the "hole one level down" arm — it is what makes re-pointing the deploy loud.
  {
    const p = writeProbe({ 'render-build': 'pnpm lint || echo x; pnpm --filter @trading-app/server build', 'web:build': 'pnpm --filter desktop vite:build', 'some:other': 'pnpm --filter x build' });
    const ry = join(tmpDir, 'render.yaml');
    writeFileSync(ry, 'services:\n  - name: x\n    buildCommand: pnpm install && pnpm run some:other\n');
    let blind = false;
    try {
      deriveChain(p, ry);
    } catch (e) {
      blind = e instanceof Blind;
    }
    check('render.yaml naming an ungraded build script reads BLIND', blind);
  }
  rmSync(tmpDir, { recursive: true, force: true });

  // -- Control 4: hook verification is load-bearing in BOTH directions.
  check('the committed hook + `prepare` wiring verify', verifyHook({ requireConfig: false }) === EXIT_CLEAN);

  // -- Control 5 (NEGATIVE, on live history): the commit that actually broke the deploy
  // must read BROKEN here, with the Render log's own error.
  const haveHistory = git(['cat-file', '-e', `${BREAK_SHA}^{commit}`]).code === 0 && git(['cat-file', '-e', `${FIX_SHA}^{commit}`]).code === 0;
  if (!haveHistory) {
    check('history controls', false, `${BREAK_SHA}/${FIX_SHA} unreachable — a shallow clone cannot run the live-history controls`);
  } else {
    let broke = null;
    try {
      broke = grade({ rev: BREAK_SHA, quiet: true });
    } catch (e) {
      check(`${BREAK_SHA} reads BROKEN`, false, `BLIND: ${e.message}`);
    }
    if (broke) {
      check(`${BREAK_SHA} (the real break) reads BROKEN`, broke.code === EXIT_BROKEN, `exit ${broke.code}`);
      check(
        'and it reproduces the Render log\'s own error',
        broke.code === EXIT_BROKEN && BREAK_SIGNATURE.test(broke.failure.output),
        broke.code === EXIT_BROKEN ? errorLines(broke.failure.output)[0] ?? '' : '',
      );
    }

    // -- Control 6 (POSITIVE): the fix must read CLEAN. Without this, a gate hardwired to
    // exit 1 would pass every control above.
    let fixed = null;
    try {
      fixed = grade({ rev: FIX_SHA, quiet: true });
    } catch (e) {
      check(`${FIX_SHA} reads CLEAN`, false, `BLIND: ${e.message}`);
    }
    if (fixed) check(`${FIX_SHA} (the fix) reads CLEAN`, fixed.code === EXIT_CLEAN, fixed.code === EXIT_CLEAN ? '' : errorLines(fixed.failure.output)[0] ?? '');
  }

  console.log(failures === 0 ? '[deploy-build] controls: ALL PASS' : `[deploy-build] controls: ${failures} FAILED`);
  return failures === 0 ? EXIT_CLEAN : EXIT_BROKEN;
}

// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const revArg = argv.find((a) => a.startsWith('--rev='));
  const unknown = argv.filter((a) => !['--hook', '--worktree', '--verify-hook', '--selftest', '--quiet'].includes(a) && !a.startsWith('--rev='));
  if (unknown.length) {
    console.error(`usage: check-deploy-build.mjs [--rev=<sha>] [--worktree] [--hook] [--verify-hook] [--selftest]\nunknown: ${unknown.join(' ')}`);
    return EXIT_USAGE;
  }

  try {
    if (has('--selftest')) return selftest();
    if (has('--verify-hook')) return verifyHook();
    if (has('--hook')) return hookMode();
    const result = grade({ rev: revArg ? revArg.slice('--rev='.length) : 'HEAD', inTree: has('--worktree'), quiet: has('--quiet') });
    report(result);
    return result.code;
  } catch (e) {
    if (e instanceof Blind) {
      console.error(`[deploy-build] BLIND — cannot grade, so this is a REFUSAL, not a pass:`);
      console.error(`    ${e.message}`);
      return EXIT_BLIND;
    }
    throw e;
  }
}

process.exit(main());
