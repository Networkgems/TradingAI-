#!/usr/bin/env node
// tra2294-trip-recurrence.mjs — "does the end-of-session watchdog trip cluster RECUR?", asked over
// several RTH sessions at once, with the readability control that makes each session's ZERO mean
// something.
//
// TRA-2294 (child of TRA-2261). The parent shipped `check-restarts.mjs`, which answers "did the box
// boot?" honestly. This asks the different question "did the watchdog TRIP?" — and a trip count has a
// failure mode the boot count does not:
//
//   ⭐⭐⭐ A TRIP COUNT OF ZERO IS ONLY A FACT ABOUT THE WORLD IF A TRIP WOULD HAVE BEEN *RETAINED*.
//
// Measured 2026-07-25 against bqb1: on 07-20 and 07-21 the retained log stream carries ONLY
// `level:"error"` structured lines — every `warn` and `info` line from those sessions is gone, while
// 07-22 onward carries all three. Search those days for the watchdog's boot banner
// (`event-loop watchdog started`, log.info) or its boot echo (`prior watchdog self-restart detected
// on boot`, log.warn) and you get nothing, on days the server provably booted 2 and 4 times. Read
// that as "the watchdog never ran" and you have invented a finding out of a log-level.
//
// The trip line itself is `log.error` (event-loop-watchdog.ts `defaultOnTrip`), so it survives on
// every day in the retained window — but you only know that because you checked. This script checks,
// per session, and refuses to report a zero it cannot stand behind.
//
// ── The three legs, and what each one is worth ───────────────────────────────────────────────────
//   TRIP   `log.error` — readable iff the session retained ANY error-level structured line.
//   ECHO   `log.warn`  — the boot witness `check-restarts.mjs` uses. Dead on an error-only session.
//   BANNER `log.info`  — `event-loop watchdog started`. Dead on an error-only session, which is why
//                        its absence CANNOT be read as "the watchdog was disabled".
//
// A boot count does not depend on the echo leg alone: `Trading server running` is a plain
// `console.log` from index.ts, emitted once per app boot, and it is format- and level-independent.
// It is used here as an INDEPENDENT control on the boot set — on 07-20…07-24 it matched
// check-restarts.mjs exactly (2, 4, 0, 1, 4).
//
// ── Usage ────────────────────────────────────────────────────────────────────────────────────────
//   RENDER_API_KEY=rnd_… node scripts/tra2294-trip-recurrence.mjs --days=2026-07-20,…,2026-07-24
//   RENDER_API_KEY=rnd_… node scripts/tra2294-trip-recurrence.mjs --days=2026-07-27 --json
//
// ── Exit codes ───────────────────────────────────────────────────────────────────────────────────
//   0  every requested session was READABLE on the trip leg and reported a trip count
//   1  at least one session had trips
//   3  at least one session was UNREADABLE on the trip leg — its zero is not a zero. HOLD.
import { classifyWatchdogLine, distinctTrips } from './lib/render-boot-set.mjs';

const OWNER_ID = 'tea-d7macfog4nts73ai6p40';
const SERVICE_ID = 'srv-d7mb7rr7uimc73ev0chg';
const API = 'https://api.render.com/v1';

const argv = process.argv.slice(2);
const valOf = n => { const h = argv.find(a => a.startsWith(`${n}=`)); return h ? h.slice(n.length + 1) : undefined; };

const API_KEY = process.env.RENDER_API_KEY;
if (!API_KEY) { console.error('RENDER_API_KEY is required.'); process.exit(2); }

const days = (valOf('--days') ?? new Date().toISOString().slice(0, 10)).split(',').map(s => s.trim()).filter(Boolean);
const openUtc = valOf('--open') ?? '13:30:00Z';
const closeUtc = valOf('--close') ?? '20:00:00Z';
const serviceId = valOf('--service') ?? SERVICE_ID;
const ownerId = valOf('--owner') ?? OWNER_ID;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The logs route rate-limits hard (429) when a sweep asks several questions per day. Back off rather
// than letting a 429 masquerade as a source that "failed" — a retried read is data, a dropped one is
// blindness, and this script's whole point is not confusing the two.
async function logQuery(from, to, text, limit = 100) {
  const url = `${API}/logs?ownerId=${ownerId}&resource=${serviceId}`
    + `&startTime=${encodeURIComponent(from)}&endTime=${encodeURIComponent(to)}&limit=${limit}`
    + (text ? `&text=${encodeURIComponent(text)}` : '');
  for (let attempt = 0; attempt < 8; attempt++) {
    let r;
    try { r = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' } }); }
    catch { await sleep(2_000); continue; }
    if (r.status === 429) { await sleep(5_000); continue; }
    if (!r.ok) return { ok: false, logs: [], hasMore: false };
    const b = await r.json();
    // ⚠️ `logs: null` on this route means NO MATCH, not "unreadable" — verified 2026-07-25 with a
    // nonsense `text=` filter over a provably readable window (also null) and with a `text=doTick`
    // positive control on a day whose `self-restarting` query is null. Coercing it to [] is correct;
    // what makes the resulting zero honest is the readability control below, not this line.
    return { ok: true, logs: b.logs ?? [], hasMore: b.hasMore === true };
  }
  return { ok: false, logs: [], hasMore: false };
}

const results = [];
for (const day of days) {
  const from = `${day}T${openUtc}`;
  const to = `${day}T${closeUtc}`;

  const trips = await logQuery(from, to, 'self-restarting');
  await sleep(1_200);
  // THE CONTROL. An error-level structured line in this session proves the level a trip is logged at
  // survived retention here. Without one, a zero on the trip leg is a fact about the log stream.
  const errors = await logQuery(from, to, '"level":"error"');
  await sleep(1_200);
  // Independent boot witness: format- and level-independent, so it holds on an error-only session.
  const boots = await logQuery(from, to, 'Trading server running');
  await sleep(1_200);
  const coverage = await logQuery(from, to, null, 5);

  const classified = trips.logs.map(l => classifyWatchdogLine({ timestamp: l.timestamp, message: String(l.message ?? '') }));
  const distinct = distinctTrips(classified);
  const suppressed = classified.filter(l => l.kind === 'SUPPRESSED');
  const unclassified = classified.filter(l => l.kind === 'UNCLASSIFIED');

  const reasons = [];
  if (!trips.ok) reasons.push('the self-restarting query FAILED');
  if (trips.ok && trips.hasMore) reasons.push('the self-restarting page was TRUNCATED — the trip count is a lower bound');
  if (!coverage.ok || coverage.logs.length === 0) reasons.push('the unfiltered coverage probe is empty — the stream is unreadable, not quiet');
  if (!errors.ok) reasons.push('the error-level readability control FAILED');
  else if (errors.logs.length === 0 && distinct.length === 0) {
    reasons.push('NO error-level structured line survived this session, so a WATCHDOG TRIP (log.error) '
      + 'would not have survived either — this zero is a fact about the log stream, not the box');
  }
  if (unclassified.length) reasons.push(`${unclassified.length} watchdog line(s) fit no known shape`);

  results.push({
    day,
    window: { from, to },
    tripLegReadable: reasons.length === 0,
    unreadableReasons: reasons,
    // ⛔ null, never 0, when the leg is unreadable. `0` is the value that gets quoted as "clean".
    distinctTrips: reasons.length === 0 ? distinct.length : null,
    trips: distinct.map(t => ({ at: t.at, lagMs: t.lag, rssMB: t.rss })),
    suppressed: suppressed.map(t => ({ at: t.at })),
    // Reported ALWAYS, because the boot control does not depend on the trip leg being readable.
    appBootBanners: boots.ok ? boots.logs.length : null,
    errorLevelLines: errors.ok ? errors.logs.length : null,
    // ⚠️ NOT a blind flag. On an error-only session these are dead by log-level alone, and reading
    // their absence as "the watchdog was disabled" is the exact inference this script exists to stop.
    echoLines: classified.filter(l => l.kind === 'BOOT').length,
  });
}

if (argv.includes('--json')) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  for (const r of results) {
    const n = r.distinctTrips;
    console.log(`${r.day} ${r.window.from.slice(11)}→${r.window.to.slice(11)}  `
      + `TRIPS=${n === null ? 'UNREADABLE' : n}  appBoots=${r.appBootBanners}  errorLines=${r.errorLevelLines}  echoes=${r.echoLines}`);
    for (const t of r.trips) console.log(`    trip ${t.at} lag=${t.lagMs}ms rss=${t.rssMB}MB`);
    for (const s of r.suppressed) console.log(`    suppressed-during-boot-grace ${s.at} (restarted NOTHING)`);
    for (const why of r.unreadableReasons) console.log(`    ⛔ ${why}`);
  }
}

const anyUnreadable = results.some(r => !r.tripLegReadable);
const anyTrips = results.some(r => r.distinctTrips > 0);
process.exit(anyUnreadable ? 3 : anyTrips ? 1 : 0);
