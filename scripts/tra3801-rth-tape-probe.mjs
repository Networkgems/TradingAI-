#!/usr/bin/env node
// TRA-3801 step 4 — the RTH positive control, read off the LOG TAPE instead of the
// since-boot counters.
//
// WHY NOT THE COUNTERS. The ticket's step-4 predicate is
// `sum(engines[].rth.intervalHistogram) > 0` on the SAME boot that spanned RTH.
// bqb1 was redeployed at 2026-08-21T20:12:29Z (commit 4e10132, TRA-3926's train),
// 12 minutes after the close and ~29s after this ticket's monitor was due. Every
// since-boot counter was wiped by that restart, so the boot that actually saw
// today's session no longer exists to be read. The ticket's own rule for that is
// UNREAD, not PASS.
//
// The Render log tape SURVIVES the restart. It is a strictly STRONGER instrument
// than the counter for the question step 4 asks:
//
//   counter  `rth.intervalHistogram > 0`  ⇒ region === 'rth' was reached.
//   tape     a `exit evaluation interval exceeded` line inside RTH
//            ⇒ region === 'rth' was reached AND `intervalMs >= EXIT_INTERVAL_LOG_MS`
//              AND the emit branch actually wrote to stdout.
//
// (signal-engine.ts:5132 — the emit arm is `region === 'rth' && intervalMs >= 20_000`;
// the histogram at :5096 is incremented on `region === 'rth'` alone, with no
// threshold. So the tape hit implies the histogram hit, never the reverse.)
//
// ASYMMETRY — read the exit codes, not the number:
//   hits > 0  ⇒ PASS. The suppression is not over-broad; the line is rare-but-present.
//   hits == 0 ⇒ NOT a fail. It is consistent with "no RTH interval cleared 20s today",
//              which is the healthy tail of a hoist running at ~10s cadence. Reported
//              as INCONCLUSIVE (exit 5) so it can never be typed up as either verdict.
//
// Controls are scoped to the SAME window as the target: a reader that is live NOW
// says nothing about a window 7 hours back, and Render encodes zero-matches and a
// wrong `resource=` identically as `logs: null`.
//
// Exit: 0 PASS · 3 BLIND (a control failed) · 5 INCONCLUSIVE · 2 usage

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';

if (!KEY) { console.error('no RENDER_API_KEY — BLIND, this is a HOLD'); process.exit(3); }

let START = '2026-08-21T13:30:00Z';
let END = '2026-08-21T20:00:00Z';
for (const a of process.argv.slice(2)) {
  const s = /^--start=(.+)$/.exec(a); const e = /^--end=(.+)$/.exec(a);
  if (s) START = s[1]; else if (e) END = e[1];
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
if (!START.endsWith('Z') || !END.endsWith('Z')) { console.error('window must be UTC (trailing Z)'); process.exit(2); }

const PHRASE = 'exit evaluation interval exceeded';
const TOKEN = 'exceeded'; // alpha-only: Render splits `text=` on commas

async function pull({ text = null, limit = 100, endTime = END } = {}) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', START);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit)); // MAX 100 — 200 returns an error OBJECT at HTTP 200
  if (text !== null) u.searchParams.set('text', text);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (r.status === 429) throw new Error('429 rate limited — an aborted read is an UNDERCOUNT, not a zero');
  if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (j.logs !== null && !Array.isArray(j.logs)) {
    throw new Error(`logs field is neither null nor an array (${typeof j.logs}) — refusing to read it as zero`);
  }
  return { lines: j.logs ?? [], hasMore: j.hasMore === true, nextEndTime: j.nextEndTime ?? null };
}

console.log(`window ${START} -> ${END}   service ${SERVICE}`);
console.log('');

// ── Controls, inside the target window ────────────────────────────────────────
const c1 = await pull({ limit: 20 });
console.log(`CONTROL 1 (no text filter, in-window) : ${c1.lines.length} line(s) — reader ${c1.lines.length > 0 ? 'LIVE' : 'BLIND'}`);
if (c1.lines.length === 0) { console.error('the window itself returned 0 unfiltered lines — retention or window wrong. BLIND.'); process.exit(3); }

function pickNeedle(lines) {
  let best = null;
  for (const l of lines) {
    const msg = String(l.message ?? '');
    for (const tok of msg.split(/[^A-Za-z]+/)) {
      if (tok.length >= 8 && tok !== TOKEN && (best === null || tok.length > best.length)) best = tok;
    }
  }
  return best;
}
const needle = pickNeedle(c1.lines);
if (needle === null) { console.error('CONTROL 2 UNCALIBRATED — no >=8-char alpha token in the sample. BLIND.'); process.exit(3); }
const c2 = await pull({ text: needle, limit: 5 });
const c2hits = c2.lines.filter((l) => String(l.message ?? '').includes(needle)).length;
console.log(`CONTROL 2 (calibrated text=)          : ${c2hits} line(s) for "${needle}" — filter ${c2hits > 0 ? 'WORKS' : 'SUSPECT'}`);
if (c2hits === 0) { console.error('a token lifted from a line inside this window matched nothing — text= is dead-shut. BLIND.'); process.exit(3); }

const c3 = await pull({ text: 'tra3801-needle-that-cannot-exist', limit: 5 });
console.log(`CONTROL 3 (absent needle)             : ${c3.lines.length} line(s) — expect 0 ${c3.lines.length === 0 ? 'OK' : '** BROKEN OPEN **'}`);
if (c3.lines.length > 0) { console.error('an impossible needle matched — filter is broken open. BLIND.'); process.exit(3); }
console.log('');

// ── Target: drain `exceeded` across the window, phrase-match client side ───────
let endCursor = END;
let pages = 0;
let scanned = 0;
const hits = [];
while (pages < 60) {
  const p = await pull({ text: TOKEN, limit: 100, endTime: endCursor });
  pages += 1;
  scanned += p.lines.length;
  for (const l of p.lines) {
    if (String(l.message ?? '').includes(PHRASE)) hits.push(l);
  }
  if (!p.hasMore || !p.nextEndTime || p.nextEndTime === endCursor) break;
  endCursor = p.nextEndTime;
}
console.log(`drained ${pages} page(s), ${scanned} line(s) carrying "${TOKEN}"`);
console.log(`TARGET  "${PHRASE}" inside RTH : ${hits.length} line(s)`);
console.log('');

if (hits.length > 0) {
  const sorted = hits.slice().sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  console.log('first:', sorted[0].timestamp, String(sorted[0].message).slice(0, 260));
  console.log('last :', sorted[sorted.length - 1].timestamp, String(sorted[sorted.length - 1].message).slice(0, 260));
  console.log('');
  console.log('VERDICT: PASS — the emit branch is reachable AND was exercised inside RTH.');
  console.log('  region === \'rth\' was reached (implied), intervalMs cleared 20s, and the line was written.');
  process.exit(0);
}

console.log('VERDICT: INCONCLUSIVE — zero emitted lines inside RTH.');
console.log('  This does NOT show the suppression is over-broad: the emit arm additionally requires');
console.log('  intervalMs >= 20_000, and an in-hours hoist running at its ~10s cadence clears that');
console.log('  only in the tail. Absence here is consistent with a healthy box. The discriminating');
console.log('  read is `sum(engines[].rth.intervalHistogram) > 0` on a boot that SPANS an RTH session.');
process.exit(5);
