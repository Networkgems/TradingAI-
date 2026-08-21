#!/usr/bin/env node
// TRA-3800 — census the bqb1 log tape: WHAT is on it, at WHAT rate, and how much
// of it is emitted while the US equity market is CLOSED.
//
// The question from the filing is "why are we getting all this on a Sunday". That
// is answerable only as a RATE over a KNOWN window, broken down by emitter — a
// screenshot of 40 lines cannot distinguish "one noisy minute" from "this is the
// steady state", and those two have completely different remediations.
//
// ── Why this is not a cosmetic ticket ──────────────────────────────────────────
// Node writes `process.stdout`/`stderr` SYNCHRONOUSLY to a pipe on Linux, which is
// how Render captures container output. While the collector keeps up each write
// costs microseconds; when it stalls, the 64 KiB pipe buffer fills and the next
// write blocks the WHOLE PROCESS — no timers, no I/O callbacks, no HTTP accept.
// That is the TRA-3660 mechanism. So log volume is an event-loop-latency risk on
// the box that is about to route real money, independent of any billing question.
//
// ── The controls (a zero here must mean "did not fire") ────────────────────────
// Render encodes ZERO MATCHES as `logs: null`, and a wrong `resource=` returns the
// SAME `logs: null`. A bare zero therefore carries no information. Every run
// re-proves the reader is live and the filter is neither dead-shut nor broken-open
// before any number below it is allowed to mean anything.
//
// ── Usage ─────────────────────────────────────────────────────────────────────
//   RENDER_API_KEY=… node scripts/tra3800-log-census.mjs
//   RENDER_API_KEY=… node scripts/tra3800-log-census.mjs --minutes=15 --json=out.json
//
// Exit codes:
//   0  censused cleanly       2  usage/arg error
//   3  BLIND — reader or filter failed a control; NEVER report a number from this

import { writeFileSync } from 'node:fs';

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
const HOST = process.env.HOST_BASE ?? 'https://tradingai-bqb1.onrender.com';

if (!KEY) { console.error('no RENDER_API_KEY — BLIND, this is a HOLD'); process.exit(3); }

const args = process.argv.slice(2);
let minutes = 10;
let jsonOut = null;
for (const a of args) {
  const m = /^--minutes=(\d+)$/.exec(a);
  const j = /^--json=(.+)$/.exec(a);
  if (m) minutes = Number(m[1]);
  else if (j) jsonOut = j[1];
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
if (!(minutes > 0 && minutes <= 120)) { console.error('--minutes must be 1..120'); process.exit(2); }

// ── Window ────────────────────────────────────────────────────────────────────
// Anchored on wall-clock (we want the CURRENT steady state), but clipped to the
// running process: a window that predates this boot would census a different
// build's emitters and silently mix two populations.
const vr = await fetch(`${HOST}/api/health/version`).catch((e) => ({ ok: false, err: e }));
if (!vr.ok) { console.error(`version route unreachable — BLIND (${vr.status ?? vr.err})`); process.exit(3); }
const ver = await vr.json();
const bootMs = Date.parse(ver.startedAt);
const nowMs = Date.now();
const wantStart = nowMs - minutes * 60_000;
const startMs = Math.max(wantStart, bootMs + 30_000); // +30s: skip boot-time chatter
const START = new Date(startMs).toISOString();
const END = new Date(nowMs).toISOString();
const windowMin = (nowMs - startMs) / 60_000;
if (windowMin < 1) { console.error(`window collapsed to ${windowMin.toFixed(2)} min (fresh boot?) — BLIND`); process.exit(3); }

console.log(`live commit ${ver.commitShort ?? ver.commit}  booted ${ver.startedAt}  uptime ${ver.uptimeSec}s`);
console.log(`window ${START} -> ${END}  (${windowMin.toFixed(1)} min)  service ${SERVICE}`);
if (startMs > wantStart) console.log(`  (clipped to this boot; asked for ${minutes} min)`);
console.log('');

// Render returns the NEWEST `limit` lines inside [startTime, endTime] and paginates
// BACKWARD: `nextEndTime` is the timestamp of the oldest line it just gave you, so
// the next page is the same window with `endTime` moved back to it. `startTimeCursor`
// does not exist on this endpoint — reading a page-1-only result as the total is how
// a 6x undercount gets published as a census.
async function pull({ text = null, limit = 100, endTime = END } = {}) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);           // NOT `resource[]=`
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', START);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit));        // MAX 100 — larger 200s with an error OBJECT
  if (text !== null) u.searchParams.set('text', text);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (r.status === 429) throw new Error('429 rate limited — an aborted read is an UNDERCOUNT, not a zero');
  if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  // FAIL CLOSED on a non-array: `?limit=200` returns an error OBJECT at HTTP 200,
  // and `Array.isArray ? d : []` would read 100 lines as 0.
  if (j.logs !== null && !Array.isArray(j.logs)) {
    throw new Error(`logs field is neither null nor an array (${typeof j.logs}) — refusing to read it as zero`);
  }
  return { lines: j.logs ?? [], hasMore: j.hasMore === true, nextEndTime: j.nextEndTime ?? null };
}

// ── Controls ──────────────────────────────────────────────────────────────────
const c1 = await pull({ limit: 5 });
console.log(`CONTROL 1 (no text filter)     : ${c1.lines.length} line(s) — reader ${c1.lines.length > 0 ? 'LIVE' : 'BLIND'}`);
if (c1.lines.length === 0) { console.error('reader returned 0 unfiltered — BLIND, this is a HOLD'); process.exit(3); }

// CONTROL 2 must not hardcode its needle. It used to probe with
// 'exit evaluation interval exceeded', chosen because it fired 134x/min — and then
// TRA-3800 suppressed exactly that string, so on 2026-08-21 a healthy box reported
// `filter SUSPECT` and the control became a permanent false alarm out of hours.
// ONE CHECK'S REMEDY DESTROYED ANOTHER CHECK'S EVIDENCE. Any hardcoded needle decays
// the same way, so calibrate off a line CONTROL 1 just returned: that line is known
// to exist inside this exact window, so a working `text=` MUST return at least one.
// ⚠️ Render splits `text=` on commas, so a needle containing one silently becomes a
// multi-term query — token on letters only and it cannot happen.
function pickNeedle(lines) {
  let best = null;
  for (const l of lines) {
    const msg = String(l.message ?? '');
    for (const tok of msg.split(/[^A-Za-z]+/)) {
      if (tok.length >= 8 && (best === null || tok.length > best.tok.length)) best = { tok, msg };
    }
  }
  return best;
}
const needle = pickNeedle(c1.lines);
if (needle === null) {
  console.log('CONTROL 2 (calibrated text=)   : UNCALIBRATED — no >=8-char alpha token in the CONTROL 1 sample');
} else {
  const c2 = await pull({ text: needle.tok, limit: 5 });
  // A hit that does not contain the needle is the filter answering a different
  // question — count only lines that actually carry it.
  const hits = c2.lines.filter((l) => String(l.message ?? '').includes(needle.tok)).length;
  console.log(`CONTROL 2 (calibrated text=)   : ${hits} line(s) for "${needle.tok}" — filter ${hits > 0 ? 'WORKS' : 'SUSPECT'}`);
  if (hits === 0) console.error(`  ** a token lifted from a line inside this window matched nothing — text= is not filtering, treat every per-family zero below as UNREAD **`);
}

const c3 = await pull({ text: 'tra3800-needle-that-cannot-exist', limit: 5 });
console.log(`CONTROL 3 (absent needle)      : ${c3.lines.length} line(s) — expect 0 ${c3.lines.length === 0 ? 'OK' : '** FILTER BROKEN OPEN **'}`);
if (c3.lines.length > 0) { console.error('an impossible needle matched — filter is broken open, HOLD'); process.exit(3); }
console.log('');

// ── Drain the window ──────────────────────────────────────────────────────────
// Page until exhausted. `hasMore` true at the end means the census is a FLOOR and
// must be labelled as one — an undercount reported as a total is the whole class
// of bug this file exists to avoid.
// Dedupe on (timestamp, message): `nextEndTime` is INCLUSIVE of the oldest line
// already returned, so consecutive pages overlap by at least one line.
const seen = new Set();
const all = [];
let endCursor = END;
let pages = 0;
let truncated = false;
for (;;) {
  const p = await pull({ limit: 100, endTime: endCursor });
  for (const l of p.lines) {
    const k = `${l.timestamp}|${l.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(l);
  }
  pages += 1;
  if (!p.hasMore || !p.nextEndTime || p.nextEndTime === endCursor) { truncated = p.hasMore; break; }
  endCursor = p.nextEndTime;
  if (pages >= 400) { truncated = true; break; }   // 40k lines — hard stop, labelled
}
console.log(`drained ${all.length} line(s) over ${pages} page(s)${truncated ? '  ** TRUNCATED — every number below is a FLOOR **' : ''}`);
console.log('');

// ── Classify ──────────────────────────────────────────────────────────────────
// Families are ordered; first match wins. `other` must stay small, otherwise the
// taxonomy is hiding the actual driver behind a residual bucket.
const FAMILIES = [
  ['exit-cadence warn',        (m) => m.includes('exit evaluation interval exceeded')],
  ['yahoo unmatched_symbols',  (m) => m.includes('un-servable by the primary feed')],
  ['yahoo chartQuote retry',   (m) => m.includes('chartQuote(') && m.includes('failed')],
  ['yahoo fetchQuotes failed', (m) => m.includes('fetchQuotes:') && m.includes('failed')],
  ['stooq non-OK status',      (m) => m.includes('quote fetch returned non-OK status')],
  ['quote move suspect',       (m) => m.includes('quote move flagged suspect')],
  ['slow async phase',         (m) => m.includes('slow async phase')],
  ['slow sync phase',          (m) => m.includes('slow sync phase') || m.includes('event loop blocked')],
];

const counts = new Map();
const samples = new Map();
for (const l of all) {
  const msg = String(l.message ?? '');
  const fam = FAMILIES.find(([, p]) => p(msg))?.[0] ?? 'other';
  counts.set(fam, (counts.get(fam) ?? 0) + 1);
  if (!samples.has(fam)) samples.set(fam, msg.slice(0, 150));
}

const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
const total = all.length;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

console.log(`${pad('family', 28)} ${lpad('lines', 7)} ${lpad('%', 6)} ${lpad('/min', 8)}`);
console.log('-'.repeat(53));
for (const [fam, n] of rows) {
  console.log(`${pad(fam, 28)} ${lpad(n, 7)} ${lpad((100 * n / total).toFixed(1), 6)} ${lpad((n / windowMin).toFixed(1), 8)}`);
}
console.log('-'.repeat(53));
console.log(`${pad('TOTAL', 28)} ${lpad(total, 7)} ${lpad('100.0', 6)} ${lpad((total / windowMin).toFixed(1), 8)}`);
console.log('');
console.log(`projected: ${Math.round(total / windowMin * 60).toLocaleString()} lines/hour · ${Math.round(total / windowMin * 1440).toLocaleString()} lines/day at this rate`);
if (truncated) console.log('** the projection is a FLOOR — the window was truncated **');
console.log('');
for (const [fam, s] of samples) console.log(`  ${pad(fam, 28)} e.g. ${s}`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({
    window: { start: START, end: END, minutes: windowMin, truncated },
    live: { commit: ver.commitShort ?? ver.commit, startedAt: ver.startedAt },
    total, perMin: total / windowMin,
    families: Object.fromEntries(rows),
  }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
