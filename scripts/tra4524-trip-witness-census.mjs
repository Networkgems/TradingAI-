#!/usr/bin/env node
// TRA-4524 AC4 — per-trip `yield-preempt@` witness census, read off the Render log tape.
//
// AC4 asks: over >=3 RTH sessions after the gate ships, is there any block trip whose
// witnesses show the MULTI-ENGINE FIFO SIGNATURE, and what is the yield-preempt max per
// trip, before vs after. The since-boot counters cannot answer that (a trip restarts the
// box and every restart wipes them), so this reads the tape, which survives.
//
// THE SIGNATURE (trip #14, 2026-09-10T16:43:42Z): N engines co-resumed in one check
// phase, each queued a pacer yield at the ms it finished its slice, and they resumed
// FIFO once the whole block drained ⇒ >=2 `yield-preempt@` witnesses inside the trip's
// window whose durations DESCEND in record order (the longest wait records first) and
// are spaced ~one slice apart. A single witness is a foreign-block witness, not the
// summing defect.
//
// Under the gate a held resume records `yield-wait@` (async), never `yield-preempt@`,
// so a post-deploy trip carrying the signature is a real regression, not the fix's own
// bookkeeping.
//
// ASYMMETRY: zero trips in a window is not evidence the defect is gone unless the
// window's controls pass (reader live, text filter calibrated). Exit: 0 read ·
// 3 BLIND · 2 usage.

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
if (!KEY) { console.error('no RENDER_API_KEY — BLIND'); process.exit(3); }

let START = null;
let END = null;
let PRE_MS = 15_000;
for (const a of process.argv.slice(2)) {
  let m;
  if ((m = /^--start=(.+)$/.exec(a))) START = m[1];
  else if ((m = /^--end=(.+)$/.exec(a))) END = m[1];
  else if ((m = /^--pre-ms=(\d+)$/.exec(a))) PRE_MS = Number(m[1]);
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
if (!START || !END || !START.endsWith('Z') || !END.endsWith('Z')) {
  console.error('usage: --start=<ISO Z> --end=<ISO Z> [--pre-ms=15000]'); process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pull({ text = null, limit = 100, startTime = START, endTime = END } = {}) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', startTime);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit)); // MAX 100
  if (text !== null) u.searchParams.set('text', text);
  for (let attempt = 0; ; attempt += 1) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
    if (r.status === 429) {
      // An aborted read is an UNDERCOUNT, never a zero ⇒ back off, then fail loud.
      if (attempt >= 5) throw new Error('429 persisted after 5 backoffs — refusing to report a partial read');
      await sleep(20_000 * (attempt + 1));
      continue;
    }
    if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (j.logs !== null && !Array.isArray(j.logs)) throw new Error('logs field neither null nor array — refusing to read as zero');
    return { lines: j.logs ?? [], hasMore: j.hasMore === true, nextEndTime: j.nextEndTime ?? null };
  }
}

async function drain(opts, maxPages = 40) {
  const out = [];
  let endTime = opts.endTime ?? END;
  for (let p = 0; p < maxPages; p += 1) {
    const page = await pull({ ...opts, endTime });
    out.push(...page.lines);
    if (!page.hasMore || !page.nextEndTime || page.nextEndTime === endTime) return { lines: out, complete: true };
    endTime = page.nextEndTime;
  }
  return { lines: out, complete: false };
}

const msgOf = (l) => String(l.message ?? '');
function field(msg, key) {
  const m = new RegExp(`"?${key}"?\\s*[:=]\\s*"?([^",}\\s]+)`).exec(msg);
  return m ? m[1] : null;
}

console.log(`window ${START} -> ${END}   service ${SERVICE}   pre-ms ${PRE_MS}`);

// Controls, in-window.
const c1 = await pull({ limit: 5 });
if (c1.lines.length === 0) { console.error('CONTROL 1: 0 unfiltered lines in window — BLIND'); process.exit(3); }
const c3 = await pull({ text: 'tra4524-needle-that-cannot-exist', limit: 5 });
if (c3.lines.length > 0) { console.error('CONTROL 3: impossible needle matched — filter broken open, BLIND'); process.exit(3); }
console.log(`controls: reader LIVE (${c1.lines.length}), absent-needle 0 OK`);

// Trips: both the self-restart line and the observe-only line.
// Tokens must be SELECTIVE: `tripped` also matches every breaker line (the Yahoo-breaker
// storm), which blew the page cap on 09-10 and undercounted. `starved` is unique to the
// self-restart line; `observe` covers the observe-only line.
const tripDrain = await drain({ text: 'starved' });
const tripDrain2 = await drain({ text: 'observe' });
const trips = [...tripDrain.lines, ...tripDrain2.lines]
  .filter((l) => /WATCHDOG TRIP|watchdog tripped but restart disabled/.test(msgOf(l)))
  .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
const tripsComplete = tripDrain.complete && tripDrain2.complete;
console.log(`trips in window: ${trips.length}${tripsComplete ? '' : ` (PAGE CAP HIT on ${tripDrain.complete ? 'observe' : 'starved'} — UNDERCOUNT)`}`);

// Engines that queued their yields at the SAME instant (the start of the block) resume
// with durations equal to within a few ms and in arbitrary order among themselves, so a
// strict `<=` test false-negatives the 09-10T16:50:32Z trip (6318, 6318, 6319, ...). A
// false negative here makes AC4 pass vacuously, so ties are tolerated and the staircase
// (a drop of >= STEP_MS between consecutive witnesses) is counted and printed.
//
// The staircase is graded on the LONGEST CONTIGUOUS non-increasing run, not the whole
// series: a 15s window can hold TWO co-resume blocks back to back (09-09T15:33:52Z,
// 13916→1078 then 4172→1143), and a foreign witness can lead the staircase
// (09-09T16:38:44Z, `reversalShadowLabel` 13592 then 13743→1136). A whole-series test
// reads both as `no`. MIN_STEPS 2 ⇒ at least three distinct engine slots.
const TIE_MS = 50;
const STEP_MS = 200;
const MIN_STEPS = 2;
function bestStaircase(series) {
  let best = 0;
  let cur = 0;
  for (let i = 1; i < series.length; i += 1) {
    if (series[i].ms > series[i - 1].ms + TIE_MS) { cur = 0; continue; }
    if (series[i - 1].ms - series[i].ms >= STEP_MS) cur += 1;
    if (cur > best) best = cur;
  }
  return best;
}
let signatureTrips = 0;
let unreadTrips = 0;
for (const t of trips) {
  const tMs = Date.parse(t.timestamp);
  const from = new Date(tMs - PRE_MS).toISOString();
  const to = new Date(tMs + 1_000).toISOString();
  const w = await drain({ text: 'synchronous', startTime: from, endTime: to }, 10);
  const witnesses = w.lines
    .filter((l) => msgOf(l).includes('slow synchronous phase held the event loop'))
    .map((l) => ({ ts: l.timestamp, phase: field(msgOf(l), 'phase'), ms: Number(field(msgOf(l), 'durationMs')) }))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const preempt = witnesses.filter((x) => String(x.phase).startsWith('yield-preempt@'));
  const steps = bestStaircase(preempt);
  const signature = steps >= MIN_STEPS;
  if (signature) signatureTrips += 1;
  // ZERO sync witnesses is BLIND, not clean: every 09-08 trip reads 0 because the
  // `yield-preempt` meter (`1fa511fd`) only went live 09-09. Grading those `no` would
  // pad the BEFORE row with clean-looking trips nobody could see into.
  const unread = witnesses.length === 0;
  if (unread) unreadTrips += 1;
  const maxPre = preempt.reduce((m, x) => Math.max(m, x.ms), 0);
  const top = witnesses.slice().sort((a, b) => b.ms - a.ms)[0] ?? null;
  console.log(
    `TRIP ${t.timestamp} lagMax=${field(msgOf(t), 'lagMaxMs')} heapMB=${field(msgOf(t), 'heapUsedMB')}` +
    ` | sync witnesses ${witnesses.length}, yield-preempt ${preempt.length} (max ${maxPre}ms, ${steps} steps)` +
    ` | largest ${top ? `${top.phase} ${top.ms}ms` : 'none'} | FIFO-signature ${unread ? 'UNREAD (0 sync witnesses)' : signature ? 'YES' : 'no'}` +
    `${w.complete ? '' : ' (WITNESS PAGE CAP)'}`,
  );
  if (preempt.length > 0) console.log(`   preempt series: ${preempt.map((x) => `${x.ms}@${String(x.phase).slice(14)}`).join(' ')}`);
}
// AC3 — the exit-cadence tail over the same window. `exceeded` is alpha-only because
// Render splits `text=` on commas; the phrase is matched client side.
const exitDrain = await drain({ text: 'exceeded' }, 60);
const exitWarns = exitDrain.lines.filter((l) => msgOf(l).includes('exit evaluation interval exceeded')).length;
console.log(`exit evaluation interval exceeded: ${exitWarns}${exitDrain.complete ? '' : ' (PAGE CAP HIT — UNDERCOUNT)'}`);

console.log(`SUMMARY trips=${trips.length} fifoSignature=${signatureTrips} unread=${unreadTrips} exitWarns=${exitWarns}` +
  `${tripsComplete && exitDrain.complete ? '' : ' (undercount)'}`);
