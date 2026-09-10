#!/usr/bin/env node
// TRA-4477 — promotion gate: refuse Pages/release unless CI is green AT THE EXACT
// SHA being promoted, graded by the CI run's own /jobs list, never its conclusion.
//
// THE HAZARD
// ----------
// The external audit (TRA-4473 C4) caught the paired Pages run SUCCEEDING while CI
// was red at the same commit, and `release.yml` carries no lint/typecheck/test job
// at all. "The branch is probably fine" is not a claim about the artifact being
// shipped; the SHA is. And a run *conclusion* alone is not evidence the suite ran —
// TRA-4440's 6.5-week red hid steps that never executed once, so this gate imports
// the SAME job-level grader the CI verdict uses (`gradeJobs` from ci-verdict.mjs):
// every expected job present by name, every one `success`, and the Test step's
// wall-clock above the floor. One grader, two call sites — a copy would drift.
//
// FAIL CLOSED
// -----------
//   - no CI run exists for the SHA        -> BLIND (3). No evidence is not green.
//   - runs exist but none has completed   -> BLIND (3). Wait for CI; do not guess.
//   - completed runs, none green-by-jobs  -> BROKEN (1). The refusal, named.
//   - the API is unreadable               -> BLIND (3), never a pass.
// "Could not check" and "checked and it is fine" never share an exit code.
//
// EXIT  0 VERIFIED-GREEN · 1 BROKEN · 2 usage · 3 BLIND.
// Args attach with `=` (TRA-4420); anything unrecognised is exit 2 naming it.

import { pathToFileURL } from 'node:url';
import { gradeJobs } from './ci-verdict.mjs';

const CLEAN = 0;
const BROKEN = 1;
const USAGE = 2;
const BLIND = 3;

const HEADERS = (token) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' });

async function ghJson(url, token) {
  const res = await fetch(url, { headers: HEADERS(token) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

// fetcher(kind, params) is injectable so the selftest drives the SHIPPED grading
// path with fixture payloads instead of a re-implementation of it.
export async function grade({ repo, sha, workflow, token, fetcher }) {
  const lines = [];
  const fetchRuns = fetcher
    ? () => fetcher('runs', { repo, sha, workflow })
    : () => ghJson(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100`, token);
  const fetchJobs = fetcher
    ? (run) => fetcher('jobs', { run })
    : (run) => ghJson(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, token);

  let runs;
  try {
    runs = (await fetchRuns())?.workflow_runs ?? null;
  } catch (err) {
    return { code: BLIND, lines: [`runs list unreadable (${err.message}) — BLIND`] };
  }
  if (!Array.isArray(runs)) return { code: BLIND, lines: ['runs payload carries no workflow_runs array — BLIND'] };
  if (runs.length === 0) {
    return { code: BLIND, lines: [`NO CI run exists for ${sha} — no evidence is not green — BLIND`] };
  }

  const completed = runs.filter((r) => r.status === 'completed');
  if (completed.length === 0) {
    return { code: BLIND, lines: [`${runs.length} CI run(s) for ${sha}, none completed yet — wait for CI — BLIND`] };
  }

  // Pass iff at least one completed run is green BY ITS JOBS. A red first attempt
  // followed by a green re-run is a pass; a green conclusion whose job list lost
  // the suite is not.
  let sawBlind = false;
  for (const run of completed) {
    lines.push(`run #${run.run_number ?? run.id}: conclusion=${run.conclusion}`);
    if (run.conclusion !== 'success') continue;
    let jobsPayload;
    try {
      jobsPayload = await fetchJobs(run);
    } catch (err) {
      lines.push(`  /jobs unreadable (${err.message}) — this run cannot vouch`);
      sawBlind = true;
      continue;
    }
    const j = gradeJobs(jobsPayload);
    for (const l of j.lines) lines.push(`  ${l}`);
    if (j.code === CLEAN) {
      lines.push(`VERIFIED GREEN at ${sha} by the job list of run #${run.run_number ?? run.id}`);
      return { code: CLEAN, lines };
    }
    if (j.code === BLIND) sawBlind = true;
    lines.push(`  run conclusion is success but the job-level grade refused it (${j.code})`);
  }
  if (sawBlind) {
    lines.push(`no run could be VERIFIED green at ${sha}; at least one was unreadable — BLIND`);
    return { code: BLIND, lines };
  }
  lines.push(`CI is NOT green at ${sha} — refusing the promotion — BROKEN`);
  return { code: BROKEN, lines };
}

// ---------------------------------------------------------------------------
export async function selftest() {
  const { EXPECTED_JOBS, TEST_JOB_NAME, TEST_STEP_NAME } = await import('./ci-verdict.mjs');
  const greenJobs = {
    jobs: Object.entries(EXPECTED_JOBS).map(([id, name]) => ({
      name,
      status: 'completed',
      conclusion: 'success',
      steps:
        name === TEST_JOB_NAME
          ? [{ name: TEST_STEP_NAME, status: 'completed', conclusion: 'success', started_at: '2026-09-09T00:00:00Z', completed_at: '2026-09-09T00:07:30Z' }]
          : [{ name: id, status: 'completed', conclusion: 'success', started_at: '2026-09-09T00:00:00Z', completed_at: '2026-09-09T00:01:00Z' }],
    })),
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const mkFetcher = (runs, jobsByRunId) => (kind, params) => {
    if (kind === 'runs') return runs instanceof Error ? Promise.reject(runs) : Promise.resolve(runs);
    const j = jobsByRunId?.[params.run.id];
    return j instanceof Error ? Promise.reject(j) : Promise.resolve(j);
  };
  const base = { repo: 'o/r', sha: 'deadbeef', workflow: 'ci.yml' };
  const run = (id, status, conclusion) => ({ id, run_number: id, status, conclusion });

  const arms = [
    ['green run, all jobs green -> VERIFIED (0)',
      { fetcher: mkFetcher({ workflow_runs: [run(1, 'completed', 'success')] }, { 1: clone(greenJobs) }) }, CLEAN],
    ['green conclusion but the test job was DROPPED from the run -> BLIND (3)',
      { fetcher: mkFetcher({ workflow_runs: [run(1, 'completed', 'success')] }, { 1: { jobs: clone(greenJobs).jobs.filter((j) => j.name !== TEST_JOB_NAME) } }) }, BLIND],
    ['red run only -> BROKEN (1)',
      { fetcher: mkFetcher({ workflow_runs: [run(1, 'completed', 'failure')] }, {}) }, BROKEN],
    ['red first attempt, green re-run -> VERIFIED (0)',
      { fetcher: mkFetcher({ workflow_runs: [run(2, 'completed', 'success'), run(1, 'completed', 'failure')] }, { 2: clone(greenJobs) }) }, CLEAN],
    ['no runs at all for the SHA -> BLIND (3)',
      { fetcher: mkFetcher({ workflow_runs: [] }, {}) }, BLIND],
    ['runs exist, none completed -> BLIND (3)',
      { fetcher: mkFetcher({ workflow_runs: [run(1, 'in_progress', null)] }, {}) }, BLIND],
    ['runs list unreadable -> BLIND (3)',
      { fetcher: mkFetcher(new Error('HTTP 500'), {}) }, BLIND],
    ['green run but its /jobs unreadable -> BLIND (3)',
      { fetcher: mkFetcher({ workflow_runs: [run(1, 'completed', 'success')] }, { 1: new Error('HTTP 500') }) }, BLIND],
  ];

  let failed = 0;
  for (const [label, extra, want] of arms) {
    let got;
    try { got = (await grade({ ...base, ...extra })).code; } catch (err) { got = `threw: ${err.message}`; }
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want ${want}, got ${got})`);
  }
  if (failed) { console.error(`[require-green-ci] selftest: ${failed}/${arms.length} arms FAILED`); return 1; }
  console.log(`[require-green-ci] selftest: ${arms.length}/${arms.length} arms pass`);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  let sha, repo = process.env.GITHUB_REPOSITORY, workflow = 'ci.yml', doSelftest = false;
  for (const a of args) {
    if (a === '--selftest') doSelftest = true;
    else if (a.startsWith('--sha=')) sha = a.slice('--sha='.length);
    else if (a.startsWith('--repo=')) repo = a.slice('--repo='.length);
    else if (a.startsWith('--workflow=')) workflow = a.slice('--workflow='.length);
    else {
      console.error(`[require-green-ci] unrecognised argument '${a}' — exit 2. Usage: require-green-ci.mjs --sha=<sha> [--repo=<owner/repo>] [--workflow=ci.yml] | --selftest`);
      process.exit(USAGE);
    }
  }
  if (doSelftest) process.exit(await selftest());
  // FULL 40 hex, not an abbreviation: GitHub's `head_sha=` filter is exact-match,
  // so a short sha returns an empty run list — a false "no runs exist" BLIND that
  // names the wrong cause. Both workflow call sites pass full SHAs already.
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) { console.error(`[require-green-ci] --sha=<sha> is REQUIRED and must be the FULL 40-char hex sha (got '${sha ?? ''}'); GitHub's head_sha filter is exact-match and a short sha reads as a false no-runs BLIND`); process.exit(USAGE); }
  if (!repo) { console.error('[require-green-ci] --repo=<owner/repo> or GITHUB_REPOSITORY is required'); process.exit(USAGE); }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) { console.error('[require-green-ci] GITHUB_TOKEN is not set — cannot read CI state — BLIND'); process.exit(BLIND); }

  const { code, lines } = await grade({ repo, sha, workflow, token });
  for (const l of lines) console.log(l);
  const label = { [CLEAN]: 'VERIFIED-GREEN', [BROKEN]: 'BROKEN', [BLIND]: 'BLIND' }[code];
  console.log(`[require-green-ci] ${label} (exit ${code})`);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`[require-green-ci] ${err.stack || err}`); process.exit(BLIND); });
}
