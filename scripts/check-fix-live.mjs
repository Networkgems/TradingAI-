#!/usr/bin/env node
// check-fix-live.mjs — TRA-2644
//
// "IS THE FIX RUNNING?" — the question `check:deploy-drift` CANNOT answer.
//
// THE DEFECT THIS EXISTS TO KILL
// -----------------------------
// TRA-2644's A1 was written as a conjunction:
//
//     "Deploy a commit at or after `ec05639` … Confirm `pnpm check:deploy-drift`
//      reads 0/CURRENT."
//
// and routine `e0c00f4e`'s C0 turned that into a grading GATE: "drift must read
// 0/CURRENT AND the live SHA must be `ec05639` or a descendant, else the fix is
// NOT deployed — grade NOTHING." Those two conditions are not equivalent, and on
// 2026-07-30T11:2xZ they DISAGREED:
//
//     live 6153420  →  contains ec05639          →  the fix IS running
//     drift         →  3 / STALE                 →  C0 says "NOT deployed"
//
// C0 would have reported a fix that had been live and continuously running for
// nearly seven hours as undeployed, graded nothing, and re-parked the leaf. And it
// would do it EVERY fire: `drift` measures the whole company's merge rate against
// one box, so on any weekday with active merges it is never 0 at 01:45Z. A gate
// keyed to it is a gate that never opens.
//
// Drift is DEPLOY HYGIENE — "is anything merged not yet running", a fleet concern
// owned by whoever merged. Ancestry is FIX PRESENCE — "is MY change in the bytes
// being executed", the only condition a post-deploy grade actually rests on. This
// script answers the second one and nothing else.
//
// THE SECOND HOLE: A POINT-IN-TIME SHA READ CANNOT SEE A ROLLBACK
// --------------------------------------------------------------
// Ancestry against the CURRENT live SHA proves the fix is running NOW. It says
// nothing about the window a session was recorded over. bqb1 took 16 explicit
// deploys between 04:34Z and 10:57Z on 2026-07-30 — one every ~24 minutes. If any
// one of them had rolled back to a pre-fix build mid-session, the EOD row for that
// session is a MIXTURE of two writers, and reading it green would clear a fix that
// was only partly exercised — while every point-in-time probe before and after
// still reads PRESENT.
//
// So `--window-start` grades the WINDOW, not the instant: every build that held
// `live` during it must contain the commit. This is the arm that makes a session
// grade trustworthy, and it is the reason this is not a one-line `git merge-base`.
//
// FAILS CLOSED
// ------------
// A shallow checkout is the trap: `git merge-base` cannot answer ancestry for a
// commit outside the shallow window, and its non-zero exit is INDISTINGUISHABLE
// from an honest "not an ancestor". Both would read as ABSENT — a false red that
// looks exactly like a real one. Every SHA is therefore existence-checked with
// `git cat-file -e` FIRST, and an unknown one exits BLIND with the `--unshallow`
// remedy named. Same for an unreachable health route or a payload with no commit.
//
// USAGE
//   node scripts/check-fix-live.mjs --commit=ec05639
//   node scripts/check-fix-live.mjs --commit=ec05639 --window-start=2026-07-30T13:30:00Z
//   node scripts/check-fix-live.mjs --commit=ec05639 --host=https://…
//   node scripts/check-fix-live.mjs --commit=ec05639 --live=<sha>   # grade a SHA you hold
//   node scripts/check-fix-live.mjs --selftest                      # both-direction controls
//
// EXIT CODES — every verdict is PRINTED before any return, so a caller that reads
// stdout is never at the mercy of which axis happened to win the exit code (the
// TRA-2642 lesson: a multi-axis checker's exit code cannot carry the verdict).
// Ranked RED > NOT MEASURED > GREEN:
//   0  PRESENT      — the live build contains the commit. If --window-start was
//                     given, every build live during the window contained it too.
//   1  ABSENT       — the live build does NOT contain the commit. Not deployed.
//   2  CONTAMINATED — the live build contains it, but a build that did NOT was
//                     live at some point inside --window-start..now. Any session
//                     recorded over that window spans two writers: DO NOT grade it.
//   3  BLIND        — could not read a leg. Never a pass.

import { spawnSync } from 'node:child_process';
import { gradedAncestry as libGradedAncestry } from './lib/shallow-ancestry.mjs';

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
const BQB1_SERVICE_ID = 'srv-d7mb7rr7uimc73ev0chg';
const TIMEOUT_MS = 45_000;

const EXIT_PRESENT = 0;
const EXIT_ABSENT = 1;
const EXIT_CONTAMINATED = 2;
const EXIT_BLIND = 3;

/**
 * THE PREDICATE, pure and total over the three states ancestry actually has.
 *
 * TRA-3740: Rewritten to use the canonical shallow-aware ancestry grader from
 * scripts/lib/shallow-ancestry.mjs. A shallow clone makes `merge-base --is-ancestor`
 * return exit 1 both for "genuinely not an ancestor" and "the path was grafted away",
 * which are byte-identical. The old knownSha screens were necessary but NOT sufficient
 * (both objects can be present while the path between them is cut).
 *
 * @returns {'present'|'absent'|'blind'}
 */
export function gradeAncestry({ commit, liveSha, knownSha, isAncestor }) {
  // The library function is the canonical remedy (TRA-3699, TRA-3721, TRA-3740).
  // It handles object presence, shallow detection, and unrelated-graph detection.
  const { answer } = libGradedAncestry(commit, liveSha);
  if (answer === true) return 'present';
  if (answer === false) return 'absent';
  return 'blind'; // answer === null
}

/**
 * THE WINDOW ARM. `deploys` is Render's list for the service, each entry
 * `{ sha, startedAt, endedAt }` — `endedAt` null meaning "still live".
 *
 * A build is IN the window iff it held `live` for any part of it, i.e. its
 * live-span overlaps `[windowStart, now)`. Overlap, not containment: the build
 * running when the window OPENED wrote the first rows of the session and is the
 * one most likely to be the stale one, so a containment test would skip exactly
 * the case that matters.
 *
 * @returns {{ verdict: 'clean'|'contaminated'|'blind', offenders: Array }}
 */
export function gradeWindow({ deploys, windowStartMs, nowMs, containsFix }) {
  if (!Array.isArray(deploys) || deploys.length === 0) {
    return { verdict: 'blind', offenders: [] };
  }
  const overlapping = deploys.filter(d => {
    const start = Date.parse(d.startedAt);
    if (!Number.isFinite(start)) return false;
    const end = d.endedAt == null ? nowMs : Date.parse(d.endedAt);
    if (!Number.isFinite(end)) return false;
    return start < nowMs && end > windowStartMs;
  });
  if (overlapping.length === 0) return { verdict: 'blind', offenders: [] };
  const offenders = overlapping.filter(d => containsFix(d.sha) !== true);
  return { verdict: offenders.length > 0 ? 'contaminated' : 'clean', offenders };
}

/**
 * Render returns deploys newest-first with a single `finishedAt` per deploy. A
 * build's live-span runs from its OWN finish to the finish of the deploy that
 * superseded it — which is the entry ABOVE it in that ordering. Cancelled and
 * failed deploys never held `live` and must not be treated as superseding
 * anything, or a cancelled build would be credited with ending a real one's span.
 */
export function toLiveSpans(deploys) {
  const held = deploys
    .filter(d => d.status === 'live' || d.status === 'deactivated')
    .filter(d => d.finishedAt && d.sha)
    .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
  return held.map((d, i) => ({
    sha: d.sha,
    startedAt: d.finishedAt,
    endedAt: i + 1 < held.length ? held[i + 1].finishedAt : null,
  }));
}

// ── selftest ────────────────────────────────────────────────────────────────
if (process.argv.includes('--selftest')) {
  const fail = [];
  const t = (name, got, want) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) fail.push(`${name}: got ${g}, want ${w}`);
    else console.log(`  ok  ${name}`);
  };
  const known = () => true;
  console.log('gradeAncestry — both directions:');
  t('present when ancestor', gradeAncestry({ commit: 'a', liveSha: 'b', knownSha: known, isAncestor: () => true }), 'present');
  t('absent when not ancestor', gradeAncestry({ commit: 'a', liveSha: 'b', knownSha: known, isAncestor: () => false }), 'absent');
  t('blind on unknown commit (shallow)', gradeAncestry({ commit: 'a', liveSha: 'b', knownSha: s => s !== 'a', isAncestor: () => false }), 'blind');
  t('blind on unknown live sha', gradeAncestry({ commit: 'a', liveSha: 'b', knownSha: s => s !== 'b', isAncestor: () => true }), 'blind');
  t('blind on missing live sha', gradeAncestry({ commit: 'a', liveSha: null, knownSha: known, isAncestor: () => true }), 'blind');

  console.log('gradeWindow — both directions:');
  const W = Date.parse('2026-07-30T13:30:00Z');
  const NOW = Date.parse('2026-07-30T21:00:00Z');
  const good = { sha: 'newbuild', startedAt: '2026-07-30T04:36:04Z', endedAt: null };
  t('clean when the only overlapping build has the fix',
    gradeWindow({ deploys: [good], windowStartMs: W, nowMs: NOW, containsFix: () => true }).verdict, 'clean');
  t('contaminated when an overlapping build lacks it',
    gradeWindow({ deploys: [good], windowStartMs: W, nowMs: NOW, containsFix: () => false }).verdict, 'contaminated');
  t('blind on an empty deploy list',
    gradeWindow({ deploys: [], windowStartMs: W, nowMs: NOW, containsFix: () => true }).verdict, 'blind');
  // The build that was live when the window OPENED must be graded (overlap, not containment).
  const straddler = { sha: 'old', startedAt: '2026-07-30T04:00:00Z', endedAt: '2026-07-30T14:00:00Z' };
  t('straddling build IS graded',
    gradeWindow({ deploys: [straddler], windowStartMs: W, nowMs: NOW, containsFix: s => s !== 'old' }).offenders.map(o => o.sha), ['old']);
  // A build that ended BEFORE the window opened is irrelevant and must not fire.
  const earlier = { sha: 'ancient', startedAt: '2026-07-29T04:00:00Z', endedAt: '2026-07-30T02:00:00Z' };
  t('build ending before the window is ignored',
    gradeWindow({ deploys: [earlier, good], windowStartMs: W, nowMs: NOW, containsFix: s => s !== 'ancient' }).verdict, 'clean');

  console.log('toLiveSpans — supersession:');
  const spans = toLiveSpans([
    { sha: 'newer', status: 'live', finishedAt: '2026-07-30T10:59:11Z' },
    { sha: 'cancelled', status: 'canceled', finishedAt: '2026-07-30T09:00:00Z' },
    { sha: 'older', status: 'deactivated', finishedAt: '2026-07-30T04:36:04Z' },
  ]);
  t('cancelled deploy excluded', spans.map(s => s.sha), ['older', 'newer']);
  t('older span ends at newer finish', spans[0].endedAt, '2026-07-30T10:59:11Z');
  t('newest span is open', spans[1].endedAt, null);

  if (fail.length) {
    console.error(`\nSELFTEST FAILED (${fail.length}):`);
    for (const f of fail) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('\nselftest: all controls pass, both directions.');
  process.exit(0);
}

// ── live run ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const valOf = name => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const HOST = (valOf('host') || DEFAULT_HOST).replace(/\/+$/, '');
const COMMIT = valOf('commit');
const LIVE_OVERRIDE = valOf('live');
const WINDOW_START = valOf('window-start');
const SERVICE_ID = valOf('service') || BQB1_SERVICE_ID;

const blind = msg => {
  console.log(`[fix-live] VERDICT = BLIND — ${msg}`);
  console.log('[fix-live] BLIND is NOT a pass. Nothing is graded.');
  process.exit(EXIT_BLIND);
};

if (!COMMIT) {
  blind('no --commit=<sha> given. There is no default on purpose: a default is how ' +
        'a grader ends up confidently confirming the wrong fix.');
}

const git = args => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const knownSha = sha => git(['cat-file', '-e', `${sha}^{commit}`]).ok;
const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b]).ok;
const shortOf = sha => (git(['rev-parse', '--short', sha]).out || String(sha).slice(0, 8));

async function liveSha() {
  if (LIVE_OVERRIDE) return LIVE_OVERRIDE;
  let res;
  try {
    res = await fetch(`${HOST}/api/health/version`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    blind(`GET ${HOST}/api/health/version failed: ${err?.message || err}`);
  }
  if (!res.ok) blind(`GET ${HOST}/api/health/version returned HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch (err) {
    blind(`/api/health/version did not return JSON: ${err?.message || err}`);
  }
  if (!body?.commit) blind('/api/health/version carried no `commit` — cannot establish what is running');
  return body.commit;
}

const live = await liveSha();

console.log(`[fix-live] host   : ${HOST}`);
console.log(`[fix-live] commit : ${shortOf(COMMIT)}  (the fix under grade)`);
console.log(`[fix-live] live   : ${shortOf(live)}`);

if (git(['rev-parse', '--is-shallow-repository']).out === 'true') {
  console.log('[fix-live] note   : this checkout is SHALLOW. Ancestry is only answerable inside');
  console.log('[fix-live]          the shallow window; an unknown SHA below exits BLIND, not ABSENT.');
}

const ancestry = gradeAncestry({ commit: COMMIT, liveSha: live, knownSha, isAncestor });

if (ancestry === 'blind') {
  const missing = [COMMIT, live].filter(s => !knownSha(s)).map(shortOf);
  blind(`SHA unknown to this checkout: ${missing.join(', ')}. ` +
        'Run `git fetch origin --unshallow` (or `git fetch origin <sha>`) and re-run. ' +
        'This is deliberately NOT reported as ABSENT: a shallow miss and a genuine ' +
        'absence produce the same git exit code, and guessing between them is how a ' +
        'working fix gets re-opened.');
}

// ARM 1's verdict is printed BEFORE the window arm runs, so it is on the record
// whatever the window arm decides to do with the exit code.
if (ancestry === 'absent') {
  console.log('');
  console.log(`[fix-live] VERDICT = ABSENT — the live build does NOT contain ${shortOf(COMMIT)}.`);
  console.log('[fix-live] The fix is NOT running. Grade nothing off this host.');
  console.log('[fix-live] bqb1 has autoDeploy OFF (TRA-1653): a push deploys NOTHING. Deploy by commit:');
  console.log('[fix-live]   node scripts/check-deploy-floor.mjs');
  console.log(`[fix-live]   RENDER_API_KEY=… node scripts/render-redeploy.mjs --commit=${COMMIT}`);
  process.exit(EXIT_ABSENT);
}

console.log('');
console.log(`[fix-live] ARM 1 (fix presence, NOW) = PRESENT — live contains ${shortOf(COMMIT)}.`);
console.log('[fix-live]   Note this is INDEPENDENT of `check:deploy-drift`. Drift measures whether');
console.log('[fix-live]   anything ELSE merged is unshipped — a fleet hygiene number that is');
console.log('[fix-live]   routinely non-zero on a weekday and must never gate a fix grade.');

if (!WINDOW_START) {
  console.log('');
  console.log('[fix-live] ARM 2 (window integrity) = NOT MEASURED — no --window-start given.');
  console.log('[fix-live]   ARM 1 proves the fix is running NOW; it does NOT prove it ran for the');
  console.log('[fix-live]   whole session you are about to grade. Pass --window-start=<ISO> to');
  console.log('[fix-live]   check every build that held `live` across that span.');
  console.log('');
  console.log('[fix-live] VERDICT = PRESENT');
  process.exit(EXIT_PRESENT);
}

const windowStartMs = Date.parse(WINDOW_START);
if (!Number.isFinite(windowStartMs)) blind(`--window-start=${WINDOW_START} is not a parseable ISO instant`);

const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) {
  console.log('');
  console.log('[fix-live] ARM 2 (window integrity) = NOT MEASURED — RENDER_API_KEY is not set,');
  console.log('[fix-live]   so the deploy history is unreadable. A rollback inside the window');
  console.log('[fix-live]   would be INVISIBLE here. Treat the session grade as provisional.');
  console.log('');
  console.log('[fix-live] VERDICT = PRESENT (window NOT MEASURED)');
  process.exit(EXIT_PRESENT);
}

let deploys;
try {
  const res = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/deploys?limit=40`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) blind(`Render deploys API returned HTTP ${res.status}`);
  const raw = await res.json();
  deploys = (Array.isArray(raw) ? raw : []).map(it => {
    const d = it.deploy ?? it;
    return { sha: d?.commit?.id ?? null, status: d?.status ?? null, finishedAt: d?.finishedAt ?? null };
  });
} catch (err) {
  blind(`could not read the Render deploy history: ${err?.message || err}`);
}

const spans = toLiveSpans(deploys);
const nowMs = Date.now();
// TRA-3740: Use shallow-aware ancestry. A bare `isAncestor` can return false both for
// "not an ancestor" and "shallow graft", which would mark a window-build as contaminated
// when it genuinely carries the fix but this checkout is shallow.
const containsFix = sha => {
  if (!sha) return null;
  const { answer } = libGradedAncestry(COMMIT, sha);
  return answer; // true/false/null — null (blind) is not provably clean
};
const win = gradeWindow({ deploys: spans, windowStartMs, nowMs, containsFix });

console.log('');
console.log(`[fix-live] ARM 2 (window integrity) — builds that held \`live\` since ${WINDOW_START}:`);
const overlapping = spans.filter(s => {
  const st = Date.parse(s.startedAt);
  const en = s.endedAt == null ? nowMs : Date.parse(s.endedAt);
  return st < nowMs && en > windowStartMs;
});
for (const s of overlapping) {
  const c = containsFix(s.sha);
  const mark = c === true ? 'has fix ' : c === null ? 'UNKNOWN ' : 'NO FIX  ';
  console.log(`[fix-live]   ${mark} ${String(s.sha).slice(0, 8)}  live ${s.startedAt} → ${s.endedAt ?? 'now'}`);
}

if (win.verdict === 'blind') {
  blind(`no build could be shown to have held \`live\` across ${WINDOW_START}..now — ` +
        'the history is too short or unparseable. The window is UNGRADED.');
}

if (win.verdict === 'contaminated') {
  console.log('');
  console.log(`[fix-live] VERDICT = CONTAMINATED — ${win.offenders.length} build(s) without ${shortOf(COMMIT)}`);
  console.log('[fix-live] held `live` inside the window. Any session recorded over it spans TWO');
  console.log('[fix-live] writers, so its EOD row is a mixture and CANNOT clear or condemn the fix.');
  console.log('[fix-live] Re-grade on the next window that is clean end to end.');
  process.exit(EXIT_CONTAMINATED);
}

console.log('');
console.log(`[fix-live] ARM 2 = CLEAN — all ${overlapping.length} build(s) across the window contain the fix.`);
console.log('[fix-live] VERDICT = PRESENT');
process.exit(EXIT_PRESENT);
