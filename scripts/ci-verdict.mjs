#!/usr/bin/env node
// TRA-4477 — the CI verdict: ONE required status computed over INDEPENDENT jobs,
// graded by the run's own /jobs step list, never by the run conclusion.
//
// THE HAZARD (measured, not inferred)
// -----------------------------------
// TRA-4440: `main` was red for 6.5 weeks — runs #1063 through #1777 — behind a
// fail-fast step 7 of a single sequential `ts-checks` job. Steps 8-17 (deploy-build
// gate + controls, cycles, build, prover, typecheck, lint, and the whole 9,084-test
// suite) NEVER EXECUTED ONCE in that window, and the run *conclusion* — the only
// thing most readers ever look at — said exactly as much as it says today. The
// external audit (TRA-4473 C4) inferred the same hazard from one snapshot.
//
// So this verdict grades TWO independent surfaces and fails closed on both:
//
//   1. `needs.*.result` for every expected job id — a skipped or cancelled job is a
//      FAILURE here, never a pass. (A skipped job is precisely the 6.5-week bug.)
//   2. the run's own /jobs listing — every expected job must be PRESENT by display
//      name with conclusion `success`, and the test job's `Test` step must have
//      actually consumed wall-clock time. A 9,084-test suite that "passed" in under
//      TEST_STEP_FLOOR_SECONDS did not run; that green is the silent kind.
//
// Surface 2 exists because surface 1 cannot see a job that was silently DROPPED
// from the workflow file: `needs` only lists what the YAML still names. A renamed
// or deleted job makes this verdict BLIND (3), never green.
//
// EXIT CODES  0 CLEAN · 1 BROKEN · 2 usage · 3 BLIND;  BLIND > BROKEN > CLEAN.
// "Could not check" and "checked and it is fine" never share an exit code
// (TRA-3695). The mutation controls are `--selftest`, run in CI on every fire —
// a gate nobody has ever seen refuse is not a measured gate.

import { pathToFileURL } from 'node:url';

// Job ids (needs keys) -> display names (the /jobs `name` field). Rename a job in
// ci.yml without updating this map and the verdict goes BLIND, which is the point:
// the map IS the claim about what a complete run contains.
export const EXPECTED_JOBS = {
  'rust-lint': 'Rust lint (cargo clippy)',
  guards: 'Guards (stale-js / data-dir / cycles / deploy-build gate / prover)',
  lint: 'Lint (eslint)',
  typecheck: 'Typecheck (tsc)',
  test: 'Test (vitest)',
};

export const TEST_JOB_NAME = EXPECTED_JOBS.test;
export const TEST_STEP_NAME = 'Test';
// Floor, not a target: pretest alone (guard scripts + three package builds) takes
// minutes. If the measured duration is under this, the suite did not run and the
// green is manufactured.
export const TEST_STEP_FLOOR_SECONDS = 60;

const CLEAN = 0;
const BROKEN = 1;
const USAGE = 2;
const BLIND = 3;

// precedence BLIND > BROKEN > CLEAN
function worse(a, b) {
  const rank = { [BLIND]: 2, [BROKEN]: 1, [CLEAN]: 0 };
  return (rank[b] ?? 0) > (rank[a] ?? 0) ? b : a;
}

// Surface 1: the `needs` context serialized by the workflow (`toJson(needs)`).
export function gradeNeeds(needs) {
  const lines = [];
  let code = CLEAN;
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    return { code: BLIND, lines: ['[needs] payload is not an object — BLIND'] };
  }
  for (const id of Object.keys(EXPECTED_JOBS)) {
    const entry = needs[id];
    const result = entry && typeof entry === 'object' ? entry.result : undefined;
    if (result === undefined) {
      lines.push(`[needs] expected job '${id}' is ABSENT from the needs context — BLIND`);
      code = worse(code, BLIND);
    } else if (result === 'success') {
      lines.push(`[needs] ${id}: success`);
    } else {
      // 'failure', 'cancelled' and 'skipped' all land here. Skipped is the
      // TRA-4440 state itself and must never read as pass.
      lines.push(`[needs] ${id}: ${result} — BROKEN`);
      code = worse(code, BROKEN);
    }
  }
  return { code, lines };
}

function stepSeconds(step) {
  if (!step?.started_at || !step?.completed_at) return null;
  const ms = Date.parse(step.completed_at) - Date.parse(step.started_at);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

// Surface 2: the run's /jobs payload ({ jobs: [...] }). `selfName` (the verdict
// job's own display name) is excluded — it is in_progress while grading itself.
export function gradeJobs(payload, selfName = 'CI verdict') {
  const lines = [];
  let code = CLEAN;
  const jobs = payload?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { code: BLIND, lines: ['[jobs] /jobs payload carries no jobs array — BLIND'] };
  }
  const byName = new Map(jobs.map((j) => [j.name, j]));
  for (const [id, name] of Object.entries(EXPECTED_JOBS)) {
    const job = byName.get(name);
    if (!job) {
      lines.push(`[jobs] expected job '${name}' (${id}) is ABSENT from this run — the workflow silently dropped it — BLIND`);
      code = worse(code, BLIND);
      continue;
    }
    lines.push(`[jobs] ${name}: status=${job.status} conclusion=${job.conclusion}`);
    for (const step of job.steps ?? []) {
      const secs = stepSeconds(step);
      lines.push(`         step '${step.name}': ${step.conclusion ?? step.status}${secs !== null ? ` (${secs.toFixed(1)}s)` : ''}`);
    }
    if (job.conclusion !== 'success') {
      lines.push(`[jobs] ${name}: conclusion '${job.conclusion}' — BROKEN`);
      code = worse(code, BROKEN);
    }
  }
  // The load-bearing step check: the suite must have RUN, not merely the job passed.
  const testJob = byName.get(TEST_JOB_NAME);
  if (testJob) {
    const step = (testJob.steps ?? []).find((s) => s.name === TEST_STEP_NAME);
    if (!step) {
      lines.push(`[jobs] '${TEST_JOB_NAME}' carries no step named '${TEST_STEP_NAME}' — BLIND`);
      code = worse(code, BLIND);
    } else if (step.conclusion !== 'success') {
      lines.push(`[jobs] step '${TEST_STEP_NAME}': conclusion '${step.conclusion}' — BROKEN`);
      code = worse(code, BROKEN);
    } else {
      const secs = stepSeconds(step);
      if (secs === null) {
        lines.push(`[jobs] step '${TEST_STEP_NAME}' has no readable duration — BLIND`);
        code = worse(code, BLIND);
      } else if (secs < TEST_STEP_FLOOR_SECONDS) {
        lines.push(`[jobs] step '${TEST_STEP_NAME}' completed in ${secs.toFixed(1)}s < floor ${TEST_STEP_FLOOR_SECONDS}s — a suite this size cannot finish that fast; this green is manufactured — BROKEN`);
        code = worse(code, BROKEN);
      } else {
        lines.push(`[jobs] step '${TEST_STEP_NAME}': ${secs.toFixed(1)}s >= floor ${TEST_STEP_FLOOR_SECONDS}s`);
      }
    }
  }
  void selfName; // excluded implicitly: it is simply not in EXPECTED_JOBS
  return { code, lines };
}

async function fetchAllJobs(repo, runId, token) {
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) throw new Error(`GET /jobs page ${page}: HTTP ${res.status}`);
    const body = await res.json();
    jobs.push(...(body.jobs ?? []));
    if (jobs.length >= (body.total_count ?? 0) || (body.jobs ?? []).length === 0) break;
  }
  return { jobs };
}

// ---------------------------------------------------------------------------
// selftest — mutation controls. Each arm plants a defect and requires the gate
// to refuse it with the exact code; the all-green arm requires it to pass. Both
// directions, because a gate hardwired to refuse passes every one-sided control.
export function selftest() {
  const green = Object.fromEntries(Object.keys(EXPECTED_JOBS).map((k) => [k, { result: 'success' }]));
  const jobsGreen = {
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

  const arms = [
    ['needs: all success -> CLEAN', () => gradeNeeds(green).code, CLEAN],
    ['needs: one failure -> BROKEN', () => gradeNeeds({ ...green, test: { result: 'failure' } }).code, BROKEN],
    // skipped is the TRA-4440 state; it must never read as pass
    ['needs: one skipped -> BROKEN', () => gradeNeeds({ ...green, test: { result: 'skipped' } }).code, BROKEN],
    ['needs: one cancelled -> BROKEN', () => gradeNeeds({ ...green, guards: { result: 'cancelled' } }).code, BROKEN],
    ['needs: expected job absent -> BLIND', () => { const n = { ...green }; delete n.lint; return gradeNeeds(n).code; }, BLIND],
    ['needs: garbage payload -> BLIND', () => gradeNeeds(null).code, BLIND],
    ['needs: extra unknown job does not break -> CLEAN', () => gradeNeeds({ ...green, extra: { result: 'failure' } }).code, CLEAN],
    ['jobs: all green -> CLEAN', () => gradeJobs(clone(jobsGreen)).code, CLEAN],
    ['jobs: test job dropped from the run -> BLIND', () => { const p = clone(jobsGreen); p.jobs = p.jobs.filter((j) => j.name !== TEST_JOB_NAME); return gradeJobs(p).code; }, BLIND],
    ['jobs: a job red -> BROKEN', () => { const p = clone(jobsGreen); p.jobs[0].conclusion = 'failure'; return gradeJobs(p).code; }, BROKEN],
    ['jobs: Test step under the duration floor -> BROKEN', () => { const p = clone(jobsGreen); const t = p.jobs.find((j) => j.name === TEST_JOB_NAME); t.steps[0].completed_at = '2026-09-09T00:00:10Z'; return gradeJobs(p).code; }, BROKEN],
    ['jobs: Test step absent -> BLIND', () => { const p = clone(jobsGreen); p.jobs.find((j) => j.name === TEST_JOB_NAME).steps = []; return gradeJobs(p).code; }, BLIND],
    ['jobs: Test step skipped -> BROKEN', () => { const p = clone(jobsGreen); p.jobs.find((j) => j.name === TEST_JOB_NAME).steps[0].conclusion = 'skipped'; return gradeJobs(p).code; }, BROKEN],
    ['jobs: empty payload -> BLIND', () => gradeJobs({}).code, BLIND],
  ];

  let failed = 0;
  for (const [label, fn, want] of arms) {
    let got;
    try { got = fn(); } catch (err) { got = `threw: ${err.message}`; }
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want ${want}, got ${got})`);
  }
  if (failed) { console.error(`[ci-verdict] selftest: ${failed}/${arms.length} arms FAILED`); return 1; }
  console.log(`[ci-verdict] selftest: ${arms.length}/${arms.length} arms pass`);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  // TRA-4420 — arguments match a closed set; anything unrecognised is exit 2
  // naming the offender, never silently ignored.
  for (const a of args) {
    if (a !== '--selftest') { console.error(`[ci-verdict] unrecognised argument '${a}' — exit 2. Usage: ci-verdict.mjs [--selftest]`); process.exit(USAGE); }
  }
  if (args.includes('--selftest')) process.exit(selftest());

  const raw = process.env.NEEDS_JSON;
  if (!raw) { console.error('[ci-verdict] NEEDS_JSON is not set — run from the workflow with NEEDS_JSON: ${{ toJson(needs) }}'); process.exit(USAGE); }
  let needs;
  try { needs = JSON.parse(raw); } catch { needs = null; }
  const n = gradeNeeds(needs);
  for (const l of n.lines) console.log(l);

  let j = { code: BLIND, lines: ['[jobs] not fetched'] };
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) {
    j = { code: BLIND, lines: ['[jobs] GITHUB_TOKEN/GITHUB_REPOSITORY/GITHUB_RUN_ID missing — cannot read the /jobs surface — BLIND'] };
  } else {
    try {
      j = gradeJobs(await fetchAllJobs(GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN));
    } catch (err) {
      j = { code: BLIND, lines: [`[jobs] /jobs unreadable (${err.message}) — BLIND, never green`] };
    }
  }
  for (const l of j.lines) console.log(l);

  const code = worse(n.code, j.code);
  const label = { [CLEAN]: 'CLEAN', [BROKEN]: 'BROKEN', [BLIND]: 'BLIND' }[code];
  console.log(`[ci-verdict] verdict: ${label} (exit ${code})`);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`[ci-verdict] ${err.stack || err}`); process.exit(BLIND); });
}
