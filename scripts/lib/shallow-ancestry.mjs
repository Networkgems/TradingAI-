// shallow-ancestry.mjs — the ONE graded answer to "does B contain A?" (TRA-3721)
//
// THE DEFECT, once, so no call site has to re-derive it.
// `git merge-base --is-ancestor A B` exits **1** for two different facts:
//   (a) B genuinely does not contain A, and
//   (b) the path between them was grafted away by a shallow clone.
// They are byte-identical — same exit code, no stderr, no warning. A `cat-file -e`
// existence probe does NOT screen it: in the grafted state BOTH shas resolve; it is
// the history BETWEEN them that is missing. A shallow checkout is the default shape
// of a fresh CI or agent workspace, so this is the ordinary case, not the exotic one.
//
// Only the NEGATIVE is re-graded. rc 0 stays trustworthy while shallow: an affirmative
// answer is PROVEN by objects that are present, and a graft can only ever hide history,
// never invent it.
//
// This module exists because the same remedy had already been written twice — as
// `gradeAncestry` in check-deploy-floor.mjs (TRA-3678, 0096adf3) and as `gradeCarries`
// in render-redeploy.mjs (TRA-3699, 12305eba) — and two more call sites were still
// fail-open (TRA-3721). Three copies of a predicate is how one of them drifts back.
// render-redeploy.mjs re-exports these names so its own callers (and the
// tra2325-embargo-gate-check.mjs control table) keep working unchanged.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `..` twice: this file lives in scripts/lib/. Anchoring on the module rather than on
// `process.cwd()` is what lets the repro copy these bytes into a grafted clone and have
// them measure THAT clone (which is the whole point of the harness).
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function git(args, timeout = 20000) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout });
}

export function gitHasCommit(sha) {
  return git(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
}

// The three ways an ancestry question comes back unanswerable. Written once, because a
// BLIND that only names the two OBVIOUS causes sends the reader looking for a missing
// object when the real answer is `git fetch --unshallow` (TRA-3699).
export const BLIND_ANCESTRY_CAUSES =
  'the object is missing from this checkout, or this checkout is SHALLOW so a negative ' +
  'ancestry answer is unreadable here (TRA-3699 — run `git fetch origin --unshallow`), or git failed';

// Pure so a control suite can drive every row without a git repo
// (tra2325-embargo-gate-check.mjs). Same shape as `gradeAncestry` in
// check-deploy-floor.mjs, which is the sibling remedy for the same defect.
//
// ⚠ The row order is the whole design: rc 0 is answered BEFORE the shallow screen, and
// the shallow screen sits BEFORE `mergeBaseEmpty`. On a graft `merge-base` is also empty,
// so testing that first would mis-attribute every grafted negative to "unrelated graphs"
// and send the reader after a re-derived floor instead of `--unshallow`.
export function gradeCarries({ rc, isShallow, mergeBaseEmpty }) {
  if (rc !== 0 && rc !== 1) return 'blind-undecidable'; // git errored; never "not an ancestor"
  if (rc === 0) return 'carries'; // proven by present objects — trust it even when shallow
  if (isShallow) return 'blind-shallow'; // indistinguishable from a grafted-away path
  if (mergeBaseEmpty) return 'blind-unrelated'; // disconnected graphs: unsatisfiable, not answered "no"
  return 'not-carried';
}

// true / false / null, from the verdict. Exported with the grader so the mapping cannot
// drift away from it — the whole defect was a `false` standing in for a blind.
// Anything that is not one of the two ANSWERS is null, so a new blind- verdict added
// above lands on "cannot tell" by default rather than on a permission.
export function carriesFromVerdict(verdict) {
  if (verdict === 'carries') return true;
  if (verdict === 'not-carried') return false;
  return null;
}

// Cached: it is one git call and cannot change inside a run.
let shallowCache;
export function isShallowCheckout() {
  if (shallowCache === undefined) {
    const r = git(['rev-parse', '--is-shallow-repository']);
    // An unreadable answer is treated as SHALLOW on purpose: it makes the negative
    // unreadable rather than trusted, which is the fail-closed direction here.
    shallowCache = r.status !== 0 || (r.stdout ?? '').trim() !== 'false';
  }
  return shallowCache;
}

// Test seam for the control suites only.
export function __resetShallowCache() {
  shallowCache = undefined;
}

// THE call site every grader should use: run the real git commands and return the graded
// answer, so nobody re-implements the "which extra probes, in which order" part.
//
//   { verdict, answer }   answer: true = target carries held · false = it genuinely does
//                         not · null = CANNOT TELL (caller must refuse, void or defer —
//                         never permit).
//
// The extra probes are only ever paid on a NEGATIVE: the ordinary "yes it carries it"
// path stays one git call.
export function gradedAncestry(heldSha, targetSha) {
  if (!heldSha || !targetSha) {
    return { verdict: 'blind-no-sha', answer: null };
  }
  // A present-object screen is necessary but NOT sufficient — see the header. It is kept
  // because it produces a better message for the plain `--depth=N` case, where the object
  // really is absent.
  if (!gitHasCommit(heldSha) || !gitHasCommit(targetSha)) {
    return { verdict: 'blind-missing-object', answer: null };
  }
  const r = git(['merge-base', '--is-ancestor', heldSha, targetSha]);
  const isShallow = r.status === 1 ? isShallowCheckout() : false;
  const mergeBaseEmpty =
    r.status === 1 && !isShallow ? (git(['merge-base', heldSha, targetSha]).stdout ?? '').trim() === '' : false;
  const verdict = gradeCarries({ rc: r.status, isShallow, mergeBaseEmpty });
  return { verdict, answer: carriesFromVerdict(verdict) };
}

// One sentence naming WHICH blind it was, for the message a refusing caller prints.
export function blindReason(verdict) {
  switch (verdict) {
    case 'blind-shallow':
      return 'this checkout is SHALLOW, so a NEGATIVE ancestry answer is indistinguishable from a ' +
        'grafted-away path (TRA-3721/TRA-3699). Run `git fetch origin --unshallow` and re-run.';
    case 'blind-unrelated':
      return 'the two commits share NO common ancestor on a complete clone — the ancestry test is ' +
        'unsatisfiable, not failed. Do not read it as a negative.';
    case 'blind-missing-object':
      return 'one of the commits is not in this checkout. Run `git fetch origin`.';
    case 'blind-no-sha':
      return 'no SHA to test against.';
    default:
      return `git could not decide the ancestry (${BLIND_ANCESTRY_CAUSES}).`;
  }
}
