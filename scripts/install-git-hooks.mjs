#!/usr/bin/env node
// TRA-3695 — arm the pre-push gate in this clone.
//
// `core.hooksPath` is LOCAL git config: it is not committed, so a hook file sitting in
// `.githooks/` is inert until something points git at it. That "something" is this script,
// wired to the root `prepare` lifecycle so `pnpm install` arms it. A gate that has to be
// installed by hand is a gate that is not installed.
//
// It is deliberately quiet and non-fatal in the places where it must not break anything:
//   - not a git worktree (a tarball, a Docker COPY, Render's own checkout) -> skip, exit 0
//   - `core.hooksPath` already points somewhere ELSE -> report LOUDLY and exit 0, because
//     silently stealing another tool's hooks path is worse than not arming
// Whether the gate is actually armed is asserted by `pnpm check:deploy-build --verify-hook`,
// which is where the failure belongs — this script's job is to arm, not to grade.
//
// Usage:
//   node scripts/install-git-hooks.mjs           # arm
//   node scripts/install-git-hooks.mjs --check   # report only, never write
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_PATH = '.githooks';
const HOOKS = ['pre-push', 'pre-commit'];

const checkOnly = process.argv.includes('--check');

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim() };
}

const inRepo = git(['rev-parse', '--git-dir']);
if (inRepo.code !== 0) {
  console.log('[install-git-hooks] not a git worktree — nothing to arm.');
  process.exit(0);
}

const dir = join(REPO_ROOT, HOOKS_PATH);
if (!existsSync(dir)) {
  console.log(`[install-git-hooks] ${HOOKS_PATH}/ is missing — nothing to arm.`);
  process.exit(0);
}

const current = git(['config', '--get', 'core.hooksPath']).out;
if (current && current !== HOOKS_PATH) {
  console.warn(`[install-git-hooks] core.hooksPath is already \`${current}\`, not \`${HOOKS_PATH}\`.`);
  console.warn('[install-git-hooks] LEAVING IT ALONE — but the TRA-3695 pre-push build gate is NOT armed.');
  console.warn(`[install-git-hooks] Either move your hooks into ${HOOKS_PATH}/ or run: git config core.hooksPath ${HOOKS_PATH}`);
  process.exit(0);
}

if (current === HOOKS_PATH) {
  console.log(`[install-git-hooks] core.hooksPath already \`${HOOKS_PATH}\` — gate armed.`);
} else if (checkOnly) {
  console.log(`[install-git-hooks] core.hooksPath is <unset> — gate NOT armed (--check, not writing).`);
} else {
  const set = git(['config', 'core.hooksPath', HOOKS_PATH]);
  if (set.code !== 0) {
    console.warn('[install-git-hooks] could not set core.hooksPath — gate NOT armed.');
    process.exit(0);
  }
  // Re-READ it. Asserting on the write's exit code is not asserting on the state.
  const back = git(['config', '--get', 'core.hooksPath']).out;
  if (back !== HOOKS_PATH) {
    console.warn(`[install-git-hooks] set core.hooksPath but it reads back as \`${back || '<unset>'}\` — gate NOT armed.`);
    process.exit(0);
  }
  console.log(`[install-git-hooks] armed: core.hooksPath = ${HOOKS_PATH}`);
}

// The exec bit only matters where git honours it, and `core.filemode` is usually false on
// Windows. Set it best-effort so a POSIX clone whose checkout dropped the mode still runs.
if (!checkOnly) {
  for (const h of HOOKS) {
    const p = join(dir, h);
    if (!existsSync(p)) {
      console.warn(`[install-git-hooks] ${HOOKS_PATH}/${h} is missing.`);
      continue;
    }
    try {
      chmodSync(p, 0o755);
    } catch {
      /* not fatal — git on Windows runs the hook regardless */
    }
  }
}
