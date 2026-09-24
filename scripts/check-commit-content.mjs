#!/usr/bin/env node
// TRA-4398 — verify a commit BY CONTENT, never by stat.
//
// THE HAZARD
// ----------
// On 2026-09-08 an index reset by a concurrent run (this checkout is shared —
// PAPERCLIP_WORKSPACE_STRATEGY=project_primary) made `git commit --amend` commit HEAD's
// copies of 7 of 9 files that had been verified staged seconds earlier. `git show --stat`
// on the resulting commit looked COMPLETELY healthy — right file list, right line counts —
// because a stat describes the diff's shape, not whose content is in it. The only read
// that caught it was `git show <sha>:<file> | grep <marker>`. This script is that read,
// checked in, so "did my change actually land in the commit I think it landed in" is one
// verb instead of a remembered incantation.
//
// A marker is a string that exists ONLY in your intended new content — an identifier you
// added, a distinctive literal. Asserting it present in `<rev>:<file>` proves the commit
// carries YOUR version, not a stale base another run staged or an index reset restored.
//
// Fails CLOSED (the check:deploy-build BLIND convention): an unresolvable rev, a file
// absent from the commit, or a git failure is BLIND (exit 3), never a pass — "could not
// check" and "checked and it is fine" must never share an exit code.
//
// Usage:
//   pnpm check:commit-content --rev=<sha> --expect=<marker>:<file> [--expect=...]
//   pnpm check:commit-content --selftest
//
// `--expect` splits at the LAST `:` — markers may contain colons, repo-relative paths
// here do not. Repeat `--expect` for multiple assertions; ALL must hold.
// Exit: 0 PRESENT (all markers found) · 1 ABSENT · 2 usage · 3 BLIND;  BLIND > ABSENT > PRESENT
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TAG = '[check-commit-content]';
const argv = process.argv.slice(2);

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').trim(), failed: r.error != null || r.status == null };
}

function usage(msg) {
  if (msg) console.error(`${TAG} ${msg}`);
  console.error(`${TAG} usage: check-commit-content.mjs --rev=<sha> --expect=<marker>:<file> [--expect=...] | --selftest`);
  process.exit(2);
}

function grade(cwd, rev, expects) {
  const resolved = git(['rev-parse', '-q', '--verify', `${rev}^{commit}`], { cwd });
  if (resolved.failed) return { verdict: 'BLIND', detail: 'git did not run' };
  if (resolved.code !== 0) return { verdict: 'BLIND', detail: `rev \`${rev}\` does not resolve to a commit here (fetch first?)` };
  const sha = resolved.out.trim();

  const rows = [];
  for (const { marker, file } of expects) {
    const show = git(['show', `${sha}:${file}`], { cwd });
    if (show.failed) return { verdict: 'BLIND', detail: `git did not run for ${sha.slice(0, 8)}:${file}` };
    if (show.code !== 0) return { verdict: 'BLIND', detail: `\`${file}\` is not in commit ${sha.slice(0, 8)} — cannot grade its content` };
    rows.push({ marker, file, present: show.out.includes(marker) });
  }
  return { verdict: rows.every((r) => r.present) ? 'PRESENT' : 'ABSENT', sha, rows };
}

function run() {
  let rev = null;
  const expects = [];
  for (const a of argv) {
    if (a.startsWith('--rev=')) rev = a.slice('--rev='.length);
    else if (a.startsWith('--expect=')) {
      const spec = a.slice('--expect='.length);
      const cut = spec.lastIndexOf(':');
      if (cut <= 0 || cut === spec.length - 1) usage(`bad --expect \`${spec}\` — need <marker>:<file>`);
      expects.push({ marker: spec.slice(0, cut), file: spec.slice(cut + 1) });
    } else usage(`unknown argument \`${a}\``);
  }
  if (!rev || expects.length === 0) usage('need --rev and at least one --expect');

  const result = grade(process.cwd(), rev, expects);
  if (result.verdict === 'BLIND') {
    console.error(`${TAG} BLIND — ${result.detail}`);
    console.error(`${TAG} could not verify the commit's content; refusing to report a grade (exit 3).`);
    process.exit(3);
  }
  for (const r of result.rows) {
    console.log(`${TAG} ${r.present ? 'PRESENT' : 'ABSENT '} ${result.sha.slice(0, 8)}:${r.file} — marker \`${r.marker}\``);
  }
  if (result.verdict === 'ABSENT') {
    console.error(`${TAG} ABSENT — the commit does NOT carry the expected content. A healthy \`git show --stat\` is not evidence (TRA-4398).`);
    process.exit(1);
  }
  console.log(`${TAG} PRESENT — all ${result.rows.length} marker(s) found in commit ${result.sha.slice(0, 8)}.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------- selftest
function selftest() {
  const results = [];
  const sh = (cwd, args) => spawnSync(process.execPath, [process.argv[1], ...args], { cwd, encoding: 'utf8' }).status;
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`selftest git ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  const expect = (name, got, want) => {
    const ok = got === want;
    results.push(ok);
    console.log(`${TAG} ${ok ? 'PASS' : 'FAIL'} ${name} (exit ${got}, want ${want})`);
  };

  const dir = mkdtempSync(join(tmpdir(), 'tra4398-content-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'selftest@local');
  g(dir, 'config', 'user.name', 'selftest');
  writeFileSync(join(dir, 'a.ts'), 'export const refusedCloseSupersedes = true;\n');
  g(dir, 'add', 'a.ts');
  g(dir, 'commit', '-q', '-m', 'v1');

  // 1 — marker present in the commit. PRESENT.
  expect('marker-present → 0', sh(dir, ['--rev=HEAD', '--expect=refusedCloseSupersedes:a.ts']), 0);
  // 2 — THE INCIDENT CONTROL: file is in the commit, stat would look fine, marker absent. ABSENT.
  expect('marker-absent → 1', sh(dir, ['--rev=HEAD', '--expect=myBrandNewSymbol:a.ts']), 1);
  // 3 — unresolvable rev. BLIND, never a pass.
  expect('bad-rev → 3', sh(dir, ['--rev=deadbeefcafe', '--expect=x:a.ts']), 3);
  // 4 — file not in the commit. BLIND: "could not grade" is not "graded fine".
  expect('missing-file → 3', sh(dir, ['--rev=HEAD', '--expect=x:nope.ts']), 3);
  // 5 — usage errors are their own code.
  expect('no-args → 2', sh(dir, []), 2);
  // 6 — marker containing colons (split is at the LAST colon).
  writeFileSync(join(dir, 'b.ts'), 'const t = "a:b:c";\n');
  g(dir, 'add', 'b.ts');
  g(dir, 'commit', '-q', '-m', 'v2');
  expect('colon-marker → 0', sh(dir, ['--rev=HEAD', '--expect=a:b:c:b.ts']), 0);

  rmSync(dir, { recursive: true, force: true });
  const pass = results.filter(Boolean).length;
  console.log(`${TAG} selftest: ${pass}/${results.length} controls pass`);
  process.exit(pass === results.length ? 0 : 1);
}

if (argv.includes('--selftest')) selftest();
else run();
