#!/usr/bin/env node
// TRA-4398 — refuse a commit whose INDEX carries a revert of a landed commit.
//
// THE HAZARD
// ----------
// Paperclip runs share one checkout per project (PAPERCLIP_WORKSPACE_STRATEGY=
// project_primary — by design, not a misconfiguration). The index and the working tree
// are therefore shared mutable state: on 2026-09-08 a concurrent run left 19 files
// STAGED at their pre-TRA-4241 content (byte-identical to `ea14ec7c`, +163/−1582 lines
// against HEAD) while HEAD carried TRA-4241. A `git commit -a` at that moment would have
// silently reverted TRA-4241's supersede refusal on the real-money host. Nothing in
// `git status` or `git diff --cached --stat` distinguishes that state from ordinary
// staged work — the file list and line counts look healthy.
//
// THE CHECK
// ---------
// For every path staged as MODIFIED, compare the staged blob against every version that
// path has had in the ancestry of HEAD. If the staged content byte-matches a STRICTLY
// OLDER ancestor's version while differing from HEAD's, the index is about to commit a
// revert of a landed commit — refuse, and name the path, the matching commit, and the
// landed commit being undone. An INTENTIONAL revert says so: set
// GIT_ALLOW_STAGED_REVERT=1 (the finding is still printed, as ALLOWED).
//
// Fails CLOSED (the check:deploy-build BLIND convention): a git read that errors is
// exit 3, never a pass. "Could not check" and "checked and it is fine" never share an
// exit code.
//
// SCOPE — what this does NOT catch, on purpose:
//   - shape (2) of TRA-4398 (index reset to HEAD's copies under an `--amend`): that
//     content matches HEAD, not an older ancestor. The remedy for that shape is the
//     documented safe verb (`git commit -- <paths>`), CLAUDE.md § shared checkout.
//   - staged DELETIONS: a delete always "matches" every pre-addition ancestor, so
//     flagging it would fire on every legitimate delete. Deletes are loud in
//     `git status`; content-matching modifications are the silent shape.
//   - an unborn HEAD (no commits yet): nothing has landed, so nothing can be reverted —
//     CLEAN by construction, not BLIND.
//
// Runs from `.githooks/pre-commit` (armed by `pnpm hooks:install`, same TRA-3695
// mechanism as pre-push). During a path-limited `git commit -- <paths>` git exports
// GIT_INDEX_FILE pointing at the temporary index actually being committed, and every
// git read here inherits it — so the subject is always the index that will become the
// commit, in every commit mode.
//
// Usage:
//   node scripts/check-staged-revert.mjs             # grade the index
//   node scripts/check-staged-revert.mjs --hook      # same, hook phrasing on refusal
//   node scripts/check-staged-revert.mjs --selftest  # controls in a throwaway repo
// Exit: 0 CLEAN · 1 REVERT STAGED · 2 usage · 3 BLIND;  BLIND > REVERT > CLEAN
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TAG = '[check-staged-revert]';
// Bounded ancestry walk per path. A stale staged base is minutes-to-days old, not
// hundreds of revisions; the cap keeps a hot file from making every commit crawl. A
// match beyond the cap is out of detection scope (stated, not silent) — the cap is a
// scope choice, not an inability, so exhausting it is CLEAN for that path, not BLIND.
const ANCESTRY_CAP = 500;

const argv = process.argv.slice(2);
if (argv.some((a) => a !== '--hook' && a !== '--selftest')) {
  console.error(`${TAG} usage: check-staged-revert.mjs [--hook|--selftest]`);
  process.exit(2);
}
const hookMode = argv.includes('--hook');

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts });
  return {
    code: r.status,
    out: (r.stdout ?? '').replace(/\r\n/g, '\n'),
    err: (r.stderr ?? '').trim(),
    failed: r.error != null || r.status == null,
  };
}

function blind(msg) {
  console.error(`${TAG} BLIND — ${msg}`);
  console.error(`${TAG} could not determine whether the index is safe; refusing (exit 3).`);
  process.exit(3);
}

function gradeIndex(cwd) {
  // Distinguish "no repo" (BLIND — cannot check) from "repo with unborn HEAD" (CLEAN —
  // nothing landed). A failed `rev-parse HEAD` alone conflates the two, in the fail-OPEN
  // direction; selftest control 5 exists to keep them apart.
  const inRepo = git(['rev-parse', '--git-dir'], { cwd });
  if (inRepo.failed || inRepo.code !== 0) return { verdict: 'BLIND', detail: 'not a git repository (or git did not run)' };
  const head = git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd });
  if (head.failed) return { verdict: 'BLIND', detail: 'git did not run' };
  if (head.code !== 0) {
    // Unborn HEAD: no landed commit exists, so no revert of one can be staged.
    return { verdict: 'CLEAN', findings: [], note: 'unborn HEAD — nothing landed to revert' };
  }

  const diff = git(['diff', '--cached', '--name-status', '-z', 'HEAD'], { cwd });
  if (diff.failed || diff.code !== 0) return { verdict: 'BLIND', detail: `git diff --cached failed: ${diff.err}` };

  // -z stream: STATUS \0 path \0 [newpath \0 for R/C]
  const tok = diff.out.split('\0').filter((t) => t.length > 0);
  const modified = [];
  for (let i = 0; i < tok.length; ) {
    const status = tok[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      modified.push(tok[i + 2]); // grade the destination path's staged content
      i += 3;
    } else {
      if (status.startsWith('M')) modified.push(tok[i + 1]);
      i += 2;
    }
  }
  if (modified.length === 0) return { verdict: 'CLEAN', findings: [] };

  const findings = [];
  for (const path of modified) {
    const staged = git(['rev-parse', '-q', '--verify', `:0:${path}`], { cwd });
    if (staged.failed) return { verdict: 'BLIND', detail: `git did not run for :0:${path}` };
    if (staged.code !== 0) continue; // not in index at stage 0 (e.g. conflict) — nothing gradeable
    const stagedBlob = staged.out.trim();

    const headBlobR = git(['rev-parse', '-q', '--verify', `HEAD:${path}`], { cwd });
    if (headBlobR.failed) return { verdict: 'BLIND', detail: `git did not run for HEAD:${path}` };
    const headBlob = headBlobR.code === 0 ? headBlobR.out.trim() : null;
    if (headBlob === stagedBlob) continue; // no staged change for this path

    // Every commit in HEAD's ancestry that touched this path, newest first.
    const revs = git(['rev-list', `--max-count=${ANCESTRY_CAP}`, 'HEAD', '--', path], { cwd });
    if (revs.failed || revs.code !== 0) return { verdict: 'BLIND', detail: `git rev-list failed for ${path}: ${revs.err}` };
    const commits = revs.out.split('\n').filter(Boolean);

    let prevTouch = null; // the newest touching commit already seen (i.e. the one whose blob the next-older version was superseded BY)
    for (const c of commits) {
      const blobR = git(['rev-parse', '-q', '--verify', `${c}:${path}`], { cwd });
      if (blobR.failed) return { verdict: 'BLIND', detail: `git did not run for ${c}:${path}` };
      const blob = blobR.code === 0 ? blobR.out.trim() : null;
      if (blob !== null && blob === stagedBlob && blob !== headBlob) {
        // Strictly-older check: the version at `c` was superseded by a later landed
        // commit (prevTouch if we saw one, else HEAD itself changed the path since).
        findings.push({ path, matches: c, undoes: prevTouch ?? 'HEAD', stagedBlob });
        break;
      }
      prevTouch = c;
    }
  }

  if (findings.length === 0) return { verdict: 'CLEAN', findings };
  return { verdict: 'REVERT', findings };
}

function report(result, cwd) {
  if (result.verdict === 'BLIND') blind(result.detail);
  if (result.verdict === 'CLEAN') {
    console.log(`${TAG} CLEAN — no staged path byte-matches an older ancestor of HEAD.${result.note ? ` (${result.note})` : ''}`);
    return 0;
  }
  const allowed = process.env.GIT_ALLOW_STAGED_REVERT === '1';
  console.error(`${TAG} ${allowed ? 'ALLOWED (GIT_ALLOW_STAGED_REVERT=1)' : 'REFUSING'} — the index carries a revert of landed work:`);
  for (const f of result.findings) {
    console.error(`${TAG}   ${f.path}`);
    console.error(`${TAG}     staged content is byte-identical to ${f.matches.slice(0, 8)}:${f.path} — a version STRICTLY OLDER than HEAD's.`);
    console.error(`${TAG}     committing this undoes the landed change from ${f.undoes === 'HEAD' ? 'HEAD' : f.undoes.slice(0, 8)}.`);
  }
  if (allowed) return 0;
  console.error(`${TAG} In this shared checkout a concurrent run can stage a stale base under you (TRA-4398).`);
  console.error(`${TAG} If this revert is INTENTIONAL, say so: GIT_ALLOW_STAGED_REVERT=1 git commit ...`);
  if (hookMode) console.error(`${TAG} Otherwise: restore the paths from HEAD (git restore --staged --worktree -- <path>), re-apply your edit, and commit path-limited: git commit -- <paths>.`);
  return 1;
}

// ---------------------------------------------------------------------------- selftest
function selftest() {
  const results = [];
  const sh = (cwd, args, env) => {
    const r = spawnSync(process.execPath, [process.argv[1], ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`selftest git ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  const mkRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tra4398-'));
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'config', 'user.email', 'selftest@local');
    g(dir, 'config', 'user.name', 'selftest');
    g(dir, 'config', 'core.autocrlf', 'false');
    return dir;
  };
  const expect = (name, got, want) => {
    const ok = got === want;
    results.push({ name, ok, got, want });
    console.log(`${TAG} ${ok ? 'PASS' : 'FAIL'} ${name} (exit ${got}, want ${want})`);
  };

  // Control 1 — THE INCIDENT: stage the exact pre-HEAD version of a file. Must refuse.
  {
    const dir = mkRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const refusedCloseSupersedes = false; // v1\n');
    g(dir, 'add', 'a.ts'); g(dir, 'commit', '-q', '-m', 'v1');
    writeFileSync(join(dir, 'a.ts'), 'export const refusedCloseSupersedes = true; // v2 — landed fix\n');
    g(dir, 'add', 'a.ts'); g(dir, 'commit', '-q', '-m', 'v2');
    writeFileSync(join(dir, 'a.ts'), 'export const refusedCloseSupersedes = false; // v1\n'); // stale base restaged
    g(dir, 'add', 'a.ts');
    expect('staged-revert-of-landed-commit → 1', sh(dir, []).code, 1);
    // Control 1b — the same state, acknowledged. Must pass, saying ALLOWED.
    const r = sh(dir, [], { GIT_ALLOW_STAGED_REVERT: '1' });
    expect('same, GIT_ALLOW_STAGED_REVERT=1 → 0', r.code, 0);
    rmSync(dir, { recursive: true, force: true });
  }

  // Control 2 — genuinely new staged content. Must pass.
  {
    const dir = mkRepo();
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(dir, 'add', 'a.ts'); g(dir, 'commit', '-q', '-m', 'v1');
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    g(dir, 'add', 'a.ts'); g(dir, 'commit', '-q', '-m', 'v2');
    writeFileSync(join(dir, 'a.ts'), 'v3 — new content\n');
    g(dir, 'add', 'a.ts');
    expect('new-content-staged → 0', sh(dir, []).code, 0);
    rmSync(dir, { recursive: true, force: true });
  }

  // Control 3 — brand-new file staged (no ancestor has the path). Must pass.
  {
    const dir = mkRepo();
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(dir, 'add', 'a.ts'); g(dir, 'commit', '-q', '-m', 'v1');
    writeFileSync(join(dir, 'b.ts'), 'brand new\n');
    g(dir, 'add', 'b.ts');
    expect('new-file-staged → 0', sh(dir, []).code, 0);
    rmSync(dir, { recursive: true, force: true });
  }

  // Control 4 — unborn HEAD with staged content. Nothing landed ⇒ CLEAN.
  {
    const dir = mkRepo();
    writeFileSync(join(dir, 'a.ts'), 'first ever\n');
    g(dir, 'add', 'a.ts');
    expect('unborn-HEAD → 0', sh(dir, []).code, 0);
    rmSync(dir, { recursive: true, force: true });
  }

  // Control 5 — BLIND: not a git repository. "Could not check" must be 3, never 0.
  {
    const dir = mkdtempSync(join(tmpdir(), 'tra4398-norepo-'));
    expect('not-a-repo → 3 (BLIND, fails closed)', sh(dir, []).code, 3);
    rmSync(dir, { recursive: true, force: true });
  }

  // Control 6 — oscillation: v1 → v2 → v1(landed) → stage v2's content. The staged blob
  // matches an older ancestor AND differs from HEAD ⇒ this is a revert of the landed
  // return-to-v1 and must refuse. (Guards the "prevTouch" attribution logic.)
  {
    const dir = mkRepo();
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(dir, 'add', 'a.ts'); g(dir, 'commit', '-q', '-m', 'v1');
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    g(dir, 'add', 'a.ts'); g(dir, 'commit', '-q', '-m', 'v2');
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(dir, 'add', 'a.ts'); g(dir, 'commit', '-q', '-m', 'back to v1 (landed)');
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    g(dir, 'add', 'a.ts');
    expect('re-stage-superseded-version → 1', sh(dir, []).code, 1);
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`${TAG} selftest: ${results.length - failed.length}/${results.length} controls pass`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (argv.includes('--selftest')) {
  selftest();
} else {
  const result = gradeIndex(process.cwd());
  process.exit(report(result, process.cwd()));
}
