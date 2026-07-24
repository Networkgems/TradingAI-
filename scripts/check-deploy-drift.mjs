#!/usr/bin/env node
// check-deploy-drift.mjs — TRA-2229
//
// "Merged" is being read as "deployed", and nothing contradicts it.
//
// `tradingai-bqb1` has `autoDeploy=no` / `autoDeployTrigger=off` (the launch-window
// pin, TRA-1653/TRA-1665 — see docs/runbook.md §2). That is deliberate, and it means
// the steady state is: a merge to `origin/main` ships NOTHING. The last deploy Render
// fired from a commit hook was 2026-07-12 (`c495294`); every deploy since has been an
// explicit REST trigger.
//
// The failure this guards is not the pin — it is that the pin is INVISIBLE:
//
//   * Render never says "autoDeploy did not fire". There is no event for a
//     non-event.
//   * `/api/health/version` reports a SHA with total confidence whether it is the
//     tip of `main` or eleven commits behind it. **A stale build reads IDENTICALLY
//     to a current one** unless you independently know what `origin/main` is.
//   * So every grader who merges, sees green, and then measures, is measuring the
//     PREVIOUS build — and gets a number that looks exactly like a real one.
//
// TRA-2214 sat undeployed while it was the named blocker on a regrade. It was caught
// on TRA-2227 only because that issue happened to re-derive the live SHA by hand,
// three merges later. This turns that hand-check into one number.
//
// Usage:
//   node scripts/check-deploy-drift.mjs                 # re-derive origin/main, curl live
//   node scripts/check-deploy-drift.mjs --no-fetch      # skip `git fetch` (see BLIND below)
//   node scripts/check-deploy-drift.mjs --host=https://…    # another deployment
//   node scripts/check-deploy-drift.mjs --live=<sha>    # grade a SHA you already have
//
// Exit codes — FAILS CLOSED:
//   0  CURRENT  — live is exactly origin/main. Merged == deployed. Measure away.
//   1  STALE    — live is behind origin/main by N commits, which are NAMED below.
//                 Anything measured now is measuring the older build.
//   1  DIVERGED — live is not on origin/main at all (hotfix branch, or a force-push
//                 rewrote history under it). Behind AND ahead are both reported.
//   3  BLIND    — a leg could not be READ: health route unreachable, no commit in
//                 the payload, the SHA is unknown to this checkout, or the fetch
//                 failed. NEVER a pass. "I could not check" is not "it is current",
//                 and a stale local `origin/main` would otherwise MANUFACTURE a
//                 CURRENT verdict by matching an equally stale live build.

import { spawnSync } from 'node:child_process';

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const valOf = name => {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};

const NO_FETCH = has('--no-fetch');
const HOST = (valOf('--host') ?? process.env.DRIFT_HOST ?? DEFAULT_HOST).replace(/\/+$/, '');
const LIVE_ARG = valOf('--live');
const BASE_REF = valOf('--base') ?? 'origin/main';
const TIMEOUT_MS = Number(valOf('--timeout-ms') ?? 25_000);

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function blind(msg) {
  console.error(`[deploy-drift] BLIND: ${msg}`);
  console.error('[deploy-drift] A leg could not be READ. This is never a pass — a stale');
  console.error('[deploy-drift] build and a current one are indistinguishable from here.');
  process.exit(3);
}

// ── Leg 1: what is actually RUNNING. Ask the process, not the deploy record. ──
// The Render deploy list can say `live` for a build the process has since been
// restarted off of; `/api/health/version` is the running pid's own answer.
async function readLiveCommit() {
  if (LIVE_ARG) return { commit: LIVE_ARG, startedAt: null, source: '--live argument' };

  const url = `${HOST}/api/health/version`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    blind(`GET ${url} failed: ${err?.message ?? err}`);
  }
  if (!res.ok) blind(`GET ${url} returned HTTP ${res.status}`);

  let body;
  try {
    body = await res.json();
  } catch (err) {
    blind(`GET ${url} did not return JSON: ${err?.message ?? err}`);
  }

  const commit = body?.commit;
  // `commitSource` distinguishes a real git SHA from a placeholder. A build that
  // could not read its own SHA reports something — do not grade it as a commit.
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(commit)) {
    blind(
      `${url} carried no usable commit (commit=${JSON.stringify(commit)}, ` +
        `commitSource=${JSON.stringify(body?.commitSource)}). ` +
        'An absent SHA cannot be graded as up-to-date.',
    );
  }
  return { commit, startedAt: body?.startedAt ?? null, source: url };
}

const live = await readLiveCommit();

// ── Leg 2: what SHOULD be running. Re-derive; a recalled tip is the failure mode. ──
if (!NO_FETCH) {
  const f = git(['fetch', 'origin', '--quiet']);
  if (!f.ok) blind(`git fetch origin failed: ${f.err || 'unknown error'} — origin/main may be stale`);
}

const baseRev = git(['rev-parse', `${BASE_REF}^{commit}`]);
if (!baseRev.ok) blind(`cannot resolve '${BASE_REF}': ${baseRev.err || 'unknown rev'}`);
const base = baseRev.out;

const liveRev = git(['rev-parse', `${live.commit}^{commit}`]);
if (!liveRev.ok) {
  blind(
    `the LIVE commit ${live.commit} is unknown to this checkout ` +
      `(${liveRev.err || 'unknown rev'}). It may predate a fetch, or live may be running ` +
      'a build that was never pushed here. Either way the distance is UNKNOWN, not zero.',
  );
}
const liveSha = liveRev.out;

const shortLive = liveSha.slice(0, 8);
const shortBase = base.slice(0, 8);

const behindR = git(['rev-list', '--count', `${liveSha}..${base}`]);
const aheadR = git(['rev-list', '--count', `${base}..${liveSha}`]);
if (!behindR.ok || !aheadR.ok) blind('git rev-list could not count the distance');
const behind = Number(behindR.out);
const ahead = Number(aheadR.out);
if (!Number.isFinite(behind) || !Number.isFinite(ahead)) blind('distance did not parse as a number');

const liveWhen = git(['log', '-1', '--format=%cI', liveSha]);
const baseWhen = git(['log', '-1', '--format=%cI', base]);

const W = Math.max(BASE_REF.length, 'live'.length);
console.log(`[deploy-drift] ${'host'.padEnd(W)} : ${HOST}`);
console.log(`[deploy-drift] ${'live'.padEnd(W)} : ${shortLive}  ${liveWhen.ok ? liveWhen.out : '?'}`);
if (live.startedAt) console.log(`[deploy-drift] ${' '.repeat(W)}   process started ${live.startedAt}`);
console.log(`[deploy-drift] ${BASE_REF.padEnd(W)} : ${shortBase}  ${baseWhen.ok ? baseWhen.out : '?'}`);
console.log(`[deploy-drift] ${BASE_REF} was RE-DERIVED via fetch${NO_FETCH ? ' — SKIPPED (--no-fetch)' : ''}.`);
console.log('');

// ── The one number. ──────────────────────────────────────────────────────────
// It carries its verdict inline: a DIVERGED host is 0 behind, and a bare `DRIFT = 0`
// scanned out of context would read as CURRENT — the exact "pass and fail look the
// same" failure this script exists to end.
const verdict = ahead > 0 ? 'DIVERGED' : behind > 0 ? 'STALE' : 'CURRENT';
console.log(`[deploy-drift] DRIFT = ${behind}${ahead > 0 ? ` behind, ${ahead} ahead` : ''}  → ${verdict}`);
console.log('');

if (behind === 0 && ahead === 0) {
  console.log(`[deploy-drift] CURRENT — live is exactly ${BASE_REF}. Merged == deployed.`);
  process.exit(0);
}

if (ahead > 0) {
  console.error(`[deploy-drift] DIVERGED — live ${shortLive} is NOT on ${BASE_REF}.`);
  console.error(`[deploy-drift] It is ${behind} behind and ${ahead} ahead — a hotfix branch`);
  console.error('[deploy-drift] (docs/runbook.md §2 "Emergency hotfix"), or history moved');
  console.error('[deploy-drift] under it. Land the live commits on main before grading.');
} else {
  console.error(`[deploy-drift] STALE — live is ${behind} commit(s) BEHIND ${BASE_REF}.`);
}

// NAME the commits. "N behind" is a number someone can talk themselves past; the
// subject lines are what make it land, because the ticket you just merged is in
// the list. This is the difference between an alarm and a statistic.
const missing = git(['log', '--format=%h %s', `${liveSha}..${base}`]);
if (missing.ok && missing.out) {
  console.error('');
  console.error('[deploy-drift] MERGED BUT NOT RUNNING:');
  for (const line of missing.out.split('\n')) console.error(`[deploy-drift]   ✗ ${line}`);
}

console.error('');
console.error('[deploy-drift] Anything measured against this host right now is measuring');
console.error('[deploy-drift] the OLDER build, and the numbers will look completely normal.');
console.error('[deploy-drift] autoDeploy is OFF by design on bqb1 (TRA-1653 pin) — a push');
console.error('[deploy-drift] deploys NOTHING. Deploy explicitly, by commit id:');
console.error('[deploy-drift]   node scripts/check-deploy-floor.mjs        # floor first');
console.error(`[deploy-drift]   RENDER_API_KEY=… node scripts/render-redeploy.mjs --commit=${base}`);
process.exit(1);
