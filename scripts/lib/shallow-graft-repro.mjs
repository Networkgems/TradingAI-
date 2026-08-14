// shallow-graft-repro.mjs — build the OBJECT-PRESENT / PATH-CUT repository state (TRA-3721)
//
// Extracted verbatim from scripts/tra3699-shallow-hold-repro.mjs so a second suite
// (tra3721-shallow-ancestry-repro.mjs) grades the SAME repro rather than a re-typed
// imitation of it. If the two harnesses drift, one of them stops being evidence.
//
// ⚠ A `--depth=N` CLONE IS NOT THE REPRO. There the held object is simply ABSENT and every
// existing `cat-file -e` screen already returns BLIND for the right reason — the arm would
// pass without the fix and prove nothing. The real shape is OBJECT PRESENT, PATH CUT:
//     git clone --depth=1 file://…   THEN   git fetch --depth=1 origin <each sha>
// `assertFaithful` below is the positive control on the control: it refuses to hand back a
// graft that is not in that state.

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const git = (args, cwd = REPO_ROOT) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 });
export const gitOut = (args, cwd = REPO_ROOT) => {
  const r = git(args, cwd);
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
};

// Pick the pair the whole repro turns on. TARGET must genuinely CARRY HELD on the complete
// clone, or the grafted arm is testing a true negative and would pass without any fix.
// Throws with a ready-made "cannot run" message rather than returning a half-built state.
export function pickPair({ depth = 50 } = {}) {
  const target = gitOut(['rev-parse', 'HEAD^{commit}']);
  if (!target) throw new Error('cannot resolve HEAD — is this the TradingAI repo?');
  const held = gitOut(['rev-parse', `HEAD~${depth}^{commit}`]);
  if (!held) {
    throw new Error(
      `cannot resolve HEAD~${depth}; this checkout is too short to build the repro. Run \`git fetch origin --unshallow\`.`,
    );
  }
  if (gitOut(['rev-parse', '--is-shallow-repository']) !== 'false') {
    throw new Error(
      'this checkout is itself SHALLOW, so the complete-clone control arm has nothing to control against. ' +
        'Run `git fetch origin --unshallow`.',
    );
  }
  return { target, held };
}

// Build the grafted clone under `root`. Returns { graft, facts } where `facts` is what
// ARM 0 grades.
// `extraShas` are fetched at depth 1 alongside the pair. They exist so a suite can put the
// commits a SUBJECT SCRIPT pins (tra2342's three pre-fix control builds) into the graft as
// OBJECTS. Without them the subject's own `cat-file -e` screens bail first and the arm never
// reaches the ancestry row it is supposed to be grading — which would make the fixed and the
// pre-fix bytes exit identically for entirely the wrong reason.
export function buildGraft(root, { target, held, extraShas = [], name = 'grafted' }) {
  const commonDir = gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) throw new Error("cannot locate this repo's git dir");
  // --depth is silently IGNORED for a plain local path; the file:// transport is what makes
  // git actually cut the history.
  const src = pathToFileURL(commonDir).href;
  const graft = join(root, name);

  const clone = git(['clone', '--quiet', '--depth=1', '--no-tags', src, graft], root);
  if (clone.status !== 0) throw new Error(`git clone --depth=1 failed: ${clone.stderr ?? clone.error?.message}`);
  // Fetch each sha at depth 1: the OBJECT lands, the path between them does not.
  for (const sha of [target, held, ...extraShas]) {
    const f = git(['fetch', '--quiet', '--depth=1', 'origin', sha], graft);
    if (f.status !== 0) {
      throw new Error(`git fetch --depth=1 origin ${sha.slice(0, 12)} failed: ${f.stderr ?? f.error?.message}`);
    }
  }

  const facts = {
    isShallow: gitOut(['rev-parse', '--is-shallow-repository'], graft) === 'true',
    heldPresent: git(['cat-file', '-e', `${held}^{commit}`], graft).status === 0,
    targetPresent: git(['cat-file', '-e', `${target}^{commit}`], graft).status === 0,
    graftRc: git(['merge-base', '--is-ancestor', held, target], graft).status,
    mergeBase: gitOut(['merge-base', held, target], graft),
  };
  facts.faithful = facts.isShallow && facts.heldPresent && facts.targetPresent && facts.graftRc === 1;
  return { graft, facts };
}

export function graftDetail(facts) {
  return (
    `shallow=${facts.isShallow}  held object present=${facts.heldPresent}  ` +
    `target object present=${facts.targetPresent}  --is-ancestor rc=${facts.graftRc} (1 = the trap)  ` +
    `merge-base=${facts.mergeBase === null || facts.mergeBase === '' ? '(empty)' : facts.mergeBase}`
  );
}

// Copy THIS working tree's scripts into the graft, so the arms grade the bytes being
// shipped rather than whatever the shallow clone happened to check out.
//
// ⚠ Every import the staged script reaches for must be staged too. Missing one does not
// produce a quiet wrong answer — it produces ERR_MODULE_NOT_FOUND — but it does mean the arm
// did not run, so the list is written next to the harness that depends on it.
export function stageScripts(graft, relPaths) {
  for (const rel of relPaths) {
    const dst = join(graft, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), dst);
  }
}

// The transitive closure of what an ancestry-grading script needs inside the graft.
export const ANCESTRY_LIB = ['scripts/lib/shallow-ancestry.mjs'];
