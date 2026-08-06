#!/usr/bin/env node
// TRA-3060 STEP 2 — QUANTIFY THE DELTA BEFORE COMMITTING TO IT.
//
// For each of the last N RTH sessions: `bootCount` OLD (three witnesses) vs NEW (plus the
// external-kill line), and how many of the NEW boots no original witness saw.
//
// ⭐ BOTH ARMS RUN OFF ONE FETCH. The two calls to `buildBootSet` get byte-identical payloads and
// differ in exactly one input, so a moved number can only be the change. (A/B against two separate
// pulls would race the log stream and make a 0 look like a 1 or the reverse.)
//
// ⭐⭐⭐ AND THE INSTRUMENT IS CONTROLLED IN BOTH DIRECTIONS BEFORE ANY SESSION IS READ. A run that
// prints "delta 0" on 10/10 sessions is worthless unless this same comparator has been shown to
// print a NON-zero on a world that contains one — otherwise the zeros measure my comparator, not the
// box. Rows PC1/PC2 below do that, and the script `exit 4`s if either fails.
import { buildBootSet, assertContinuous } from './lib/render-boot-set.mjs';

const API = 'https://api.render.com/v1';
const KEY = process.env.RENDER_API_KEY;
const SVC = process.env.RENDER_SERVICE_ID || 'srv-d7mb7rr7uimc73ev0chg';
if (!KEY) { console.error('RENDER_API_KEY unset'); process.exit(3); }
const rh = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: rh });
    if (r.ok) return { ok: true, body: await r.json() };
    last = `HTTP ${r.status}`;
    // A 503 is transient on NARROW windows too and a 429 is a deep-page artefact. Both are HELD.
    if (r.status !== 503 && r.status !== 429) break;
    await sleep(1500 * (i + 1));
  }
  return { ok: false, body: null, why: last };
}

// ── the known-good / known-bad pair, run FIRST ───────────────────────────────────────────────────
const mkKill = (at) => ({ timestamp: at, message: JSON.stringify({ msg: 'prior process died WITHOUT a watchdog trip — external kill (SIGKILL 137 / health-check SIGTERM) suspected' }) });
const base = { from: '2026-08-03T13:30:00Z', to: '2026-08-03T20:00:00Z', coverageLineCount: 9, deploys: [{ finishedAt: '2026-08-03T10:00:00Z' }], events: [], eventsQueryFrom: '2026-08-03T13:30:00Z' };
const pcNone = buildBootSet({ ...base });
const pcOne = buildBootSet({ ...base, externalKillLines: [mkKill('2026-08-03T15:00:00Z')] });
const PC1 = pcNone.bootCount === 0;                                  // known-good: silent without one
const PC2 = pcOne.bootCount === 1 && pcOne.seenOnlyByExternalKill === 1; // known-bad: fires with one
console.log(`PC1 no external-kill line -> bootCount ${pcNone.bootCount} (want 0)  ${PC1 ? 'PASS' : 'FAIL'}`);
console.log(`PC2 one external-kill line -> bootCount ${pcOne.bootCount}, seenOnlyByExternalKill `
  + `${pcOne.seenOnlyByExternalKill} (want 1/1)  ${PC2 ? 'PASS' : 'FAIL'}`);
if (!PC1 || !PC2) { console.error('\nCOMPARATOR IS BLIND — its zeros would measure itself. Refusing to grade.'); process.exit(4); }

// ── sessions ─────────────────────────────────────────────────────────────────────────────────────
const N = Number(process.argv.find(a => a.startsWith('--sessions='))?.split('=')[1] ?? 10);
const END = process.argv.find(a => a.startsWith('--end='))?.split('=')[1] ?? '2026-08-06';
const sessions = [];
for (let d = new Date(`${END}T00:00:00Z`); sessions.length < N; d = new Date(d.getTime() - 86400000)) {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) continue;
  const day = d.toISOString().slice(0, 10);
  if (day >= END) continue; // today's session has not closed; a partial window is not a session
  sessions.push(day);
}
sessions.reverse();

const svc = await get(`${API}/services/${SVC}`);
const owner = svc.body?.ownerId;
if (!owner) { console.error('could not resolve ownerId'); process.exit(3); }
console.log(`\nservice=${SVC} owner=${owner}  sessions=${sessions.length}`);

const WD_LIMIT = 100, EK_LIMIT = 100, EV_LIMIT = 100;
// ⛔⭐⭐⭐ `--window=full` EXISTS BECAUSE THE RTH SAMPLE IS STRUCTURALLY EMPTY OF THIS POPULATION.
// `render-redeploy.mjs` FREEZES deploys inside 13:25–20:00Z, and a boot is what emits this line, so
// every external-kill line on this box lands OUTSIDE RTH by construction: measured 08-01..08-06,
// 39 lines, ZERO of them in an RTH window. A delta of 0 taken over RTH-only windows is therefore a
// fact about the DEPLOY SCHEDULE, not about the witness — the gate would be graded on a sample that
// cannot contain the thing it is grading. Full days are where the population actually lives.
const FULL = process.argv.includes('--window=full');
console.log(`window = ${FULL ? 'FULL DAY 00:00–23:59:59Z' : 'RTH 13:30–20:00Z'}\n`);
const rows = [];
for (const day of sessions) {
  const from = FULL ? `${day}T00:00:00Z` : `${day}T13:30:00Z`;
  const to = FULL ? `${day}T23:59:59Z` : `${day}T20:00:00Z`;
  const logUrl = (extra) => `${API}/logs?ownerId=${owner}&resource=${SVC}`
    + `&startTime=${encodeURIComponent(from)}&endTime=${encodeURIComponent(to)}&direction=backward${extra}`;
  const [wd, cov, dep, ev, ek] = await Promise.all([
    get(logUrl(`&text=${encodeURIComponent('self-restarting')}&limit=${WD_LIMIT}`)),
    get(logUrl('&limit=5')),
    get(`${API}/services/${SVC}/deploys?limit=50`),
    get(`${API}/services/${SVC}/events?limit=${EV_LIMIT}&startTime=${encodeURIComponent(from)}&endTime=${encodeURIComponent(to)}`),
    get(logUrl(`&text=${encodeURIComponent('external kill')}&limit=${EK_LIMIT}`)),
  ]);
  const arr = (b, k) => (Array.isArray(b) ? b : b?.[k] ?? []);
  const wdLogs = wd.body?.logs ?? [];
  const ekLogs = ek.body?.logs ?? [];
  const events = arr(ev.body, 'events');
  const shared = {
    from, to,
    watchdogLines: wdLogs.map(l => ({ timestamp: l.timestamp, message: String(l.message ?? '') })),
    watchdogOk: wd.ok,
    watchdogTruncated: wd.ok && (wd.body?.hasMore === true || wdLogs.length >= WD_LIMIT),
    coverageLineCount: (cov.body?.logs ?? []).length,
    coverageOk: cov.ok,
    deploys: arr(dep.body, 'deploys'), deploysOk: dep.ok,
    events, eventsOk: ev.ok, eventsQueryFrom: from, eventsTruncated: events.length >= EV_LIMIT,
  };
  const ekIn = {
    externalKillLines: ekLogs.map(l => ({ timestamp: l.timestamp, message: String(l.message ?? '') })),
    externalKillOk: ek.ok,
    externalKillTruncated: ek.ok && (ek.body?.hasMore === true || ekLogs.length >= EK_LIMIT),
  };
  const oldR = buildBootSet({ ...shared });
  const newR = buildBootSet({ ...shared, ...ekIn });
  rows.push({ day, ekLines: ekLogs.length, ekNull: ek.body?.logs === null, ekOk: ek.ok, oldR, newR });
  await sleep(500);
}

const f = (v) => (v === null ? 'BLIND' : String(v));
console.log('session     ekLines  bootCount(old)  bootCount(new)  delta  onlyByExtKill  verdict(old)->verdict(new)');
let anyDelta = 0, blindSessions = 0;
for (const r of rows) {
  const o = r.oldR.bootCount, n = r.newR.bootCount;
  const delta = (o === null || n === null) ? '—' : n - o;
  if (typeof delta === 'number' && delta !== 0) anyDelta++;
  if (o === null || n === null) blindSessions++;
  const vo = assertContinuous(r.oldR).verdict, vn = assertContinuous(r.newR).verdict;
  console.log(`${r.day}  ${String(r.ekLines).padStart(7)}  ${f(o).padStart(14)}  ${f(n).padStart(14)}  `
    + `${String(delta).padStart(5)}  ${f(r.newR.seenOnlyByExternalKill).padStart(13)}  ${vo} -> ${vn}`
    + (vo !== vn ? '   *** VERDICT MOVED ***' : ''));
  if (r.newR.blind) console.log(`             blind: ${r.newR.blindReasons.join(' | ').slice(0, 150)}`);
}
console.log(`\nsessions=${rows.length}  blind=${blindSessions}  sessions with a NON-ZERO delta = ${anyDelta}`);
console.log(anyDelta === 0
  ? 'VERDICT: the fourth witness adds NOTHING over this sample — `pullBootSet` is CORRECT to leave it\n'
    + '         unfetched. Expected: it can only add a boot when `<DATA_DIR>/watchdog-last-trip.json`\n'
    + '         is absent, and on this box that file has existed since the first trip.'
  : 'VERDICT: the fourth witness MOVES the boot count. That contradicts the TRA-3060 measurement, so\n'
    + '         the breadcrumb predicate has changed (disk replaced? DATA_DIR unset? fresh service?).\n'
    + '         RE-DERIVE every gate that reads bootCount BEFORE arming the fetch in pullBootSet.');
// ⚠️ A zero here is only meaningful for windows that CONTAIN the population. Run `--window=full`:
// deploys are RTH-frozen, so every external-kill line on this box lands OUTSIDE 13:30–20:00Z.
if (anyDelta === 0 && rows.every(r => r.ekLines === 0)) {
  console.log('\n⚠️  BUT EVERY WINDOW HELD ZERO EXTERNAL-KILL LINES — this run graded a sample that could\n'
    + '    not have contained the thing it grades. Re-run with --window=full before quoting the zero.');
}
