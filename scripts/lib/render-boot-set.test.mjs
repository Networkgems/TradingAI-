// Discrimination suite for the shared boot-set detector (TRA-2261).
//
// EVERY BYTE BELOW IS REAL. `__fixtures__/bqb1-2026-07-24.json` is the verbatim response payload of
// four Render API reads against tradingai-bqb1 for Fri 2026-07-24 — the session that produced the
// finding. Nothing here is a hand-written approximation of a log line, because the whole class of bug
// under test is "the line does not say what I remember it saying".
//
// The `L-OLD-*` cases are REGRESSION CONTROLS: they replay the naive expressions this detector
// replaces and assert they still get the WRONG answer. A suite that passes on a clean board and also
// passes on a broken one has not verified anything — these are what make a green run mean the fix
// holds rather than that the instrument went blind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildBootSet, classifyWatchdogLine, distinctTrips, assertContinuous, BOOT_CLUSTER_MS,
} from './render-boot-set.mjs';

const FX = JSON.parse(readFileSync(
  fileURLToPath(new URL('./__fixtures__/bqb1-2026-07-24.json', import.meta.url)), 'utf8'));

// The RTH window the TRA-1648 soak leg and the TRA-2213 clean-RTH precondition both grade.
const RTH = { from: '2026-07-24T13:30:00.000Z', to: '2026-07-24T20:00:00.000Z' };
// The window TRA-2203's doTick tape read — the one a deploys-only detector called steady state.
const TAPE = { from: '2026-07-24T19:50:00.000Z', to: '2026-07-24T20:05:00.000Z' };

const live = (w, over = {}) => buildBootSet({
  ...w,
  watchdogLines: FX.logs,
  watchdogOk: true,
  coverageLineCount: FX.coverageLineCount,
  coverageOk: true,
  deploys: FX.deploys,
  deploysOk: true,
  events: FX.events,
  eventsOk: true,
  ...over,
});

const line = (msg) => FX.logs.find(l => JSON.parse(l.message).msg.includes(msg));
const TRIP_1956 = line('WATCHDOG TRIP');
const BOOT_1956 = FX.logs.find(l => l.timestamp.startsWith('2026-07-24T19:56:45'));
const BOOT_1559 = FX.logs.find(l => l.timestamp.startsWith('2026-07-24T15:59:44'));
const BOOT_1615 = FX.logs.find(l => l.timestamp.startsWith('2026-07-24T16:15:25'));
const SUPPRESSED_2003 = line('suppressed');

// ── L: line classification ──────────────────────────────────────────────────────────────────────

test('L1 the dying process\'s line is a TRIP', () => {
  assert.equal(classifyWatchdogLine(TRIP_1956).kind, 'TRIP');
});

test('L2 the boot echo is a BOOT, not a trip — the process logging it is already alive', () => {
  assert.equal(classifyWatchdogLine(BOOT_1956).kind, 'BOOT');
});

test('L3 "watchdog trip SUPPRESSED" is not a TRIP — this is the trap', () => {
  assert.equal(classifyWatchdogLine(SUPPRESSED_2003).kind, 'SUPPRESSED');
});

test('L4 …and not a BOOT either: nothing restarted', () => {
  assert.notEqual(classifyWatchdogLine(SUPPRESSED_2003).kind, 'BOOT');
});

test('L5 an unrecognised msg is UNCLASSIFIED so the caller goes BLIND, never buckets it', () => {
  const unknown = { timestamp: '2026-07-24T20:30:00.000Z', message: JSON.stringify({
    level: 'warn', msg: 'watchdog entered some future mode nobody has written a rule for',
    detail: 'self-restarting before the platform hard-kill' }) };
  assert.equal(classifyWatchdogLine(unknown).kind, 'UNCLASSIFIED');
});

test('L6 a non-JSON line does not throw and is not silently a boot', () => {
  const raw = { timestamp: '2026-07-24T20:31:00.000Z', message: 'plain text mentioning self-restarting' };
  assert.ok(['UNCLASSIFIED', 'TRIP', 'SUPPRESSED'].includes(classifyWatchdogLine(raw).kind));
});

test('L7 lag/rss come from the FIELDS when present, not re-parsed out of prose', () => {
  const c = classifyWatchdogLine(BOOT_1956);
  assert.equal(c.lag, 14395);
  assert.equal(c.rss, 1932);
});

test('L8 the trip line DOES carry lagMaxMs — and the prose fallback still works without it', () => {
  // Written first as "trip lines carry no lagMaxMs", copied from an older hand-written fixture. The
  // real bytes say otherwise (`defaultOnTrip` logs `lagMaxMs`), and the suite caught it on contact.
  // That is the entire reason this fixture is a verbatim API response and not a reconstruction.
  assert.equal(classifyWatchdogLine(TRIP_1956).lag, 14395);
  const noField = { timestamp: '2026-07-24T19:56:36.569Z', message: JSON.stringify({
    msg: 'WATCHDOG TRIP — self-restarting to clear starved event loop',
    detail: 'single event-loop block: max lag 14395ms >= 4000ms — self-restarting' }) };
  assert.equal(classifyWatchdogLine(noField).lag, '14395');
});

test('L9 two boots sharing an IDENTICAL (lag,rss) 16 min apart are TWO boots', () => {
  const both = [BOOT_1559, BOOT_1615].map(classifyWatchdogLine);
  assert.equal(both.filter(l => l.kind === 'BOOT').length, 2);
  assert.equal(both[0].lag, both[1].lag);
  assert.equal(both[0].rss, both[1].rss);
});

test('L10 TRIP COUNT applies the OPPOSITE rule: identical (lag,rss) collapse to one incident', () => {
  const replayed = [TRIP_1956, { ...TRIP_1956, timestamp: '2026-07-24T19:57:00.000Z' }];
  assert.equal(distinctTrips(replayed.map(classifyWatchdogLine)).length, 1);
});

test('L11 distinctTrips ignores BOOT and SUPPRESSED lines entirely', () => {
  const notTrips = [BOOT_1559, BOOT_1615, BOOT_1956, SUPPRESSED_2003].map(classifyWatchdogLine);
  assert.equal(distinctTrips(notTrips).length, 0);
});

test('L12 the real 07-24 filter response is 5 BOOT + 3 TRIP + 1 SUPPRESSED, nothing unclassified', () => {
  const all = FX.logs.map(classifyWatchdogLine);
  assert.equal(all.filter(l => l.kind === 'BOOT').length, 5);
  assert.equal(all.filter(l => l.kind === 'TRIP').length, 3);
  assert.equal(all.filter(l => l.kind === 'SUPPRESSED').length, 1);
  assert.equal(all.filter(l => l.kind === 'UNCLASSIFIED').length, 0);
  // 9 lines. Counting them is how "6 boots / 4 self-restarts" got filed.
  assert.equal(FX.logs.length, 9);
});

// ── B: the boot set ─────────────────────────────────────────────────────────────────────────────

test('B1 the real 07-24 RTH window is 4 boots, 2 of them invisible to the deploys API', () => {
  const r = live(RTH);
  assert.equal(r.blind, false, r.blindReasons.join('; '));
  assert.equal(r.bootCount, 4);
  assert.equal(r.invisibleToDeploys, 2);
  // Two deploy boots, each collapsing with its own watchdog echo ~9 s later; then two boots that
  // ONLY the event stream and the watchdog echo saw.
  assert.deepEqual(r.boots.map(b => [...b.srcs].sort().join('+')),
    ['DEPLOY+WATCHDOG', 'DEPLOY+WATCHDOG', 'EVENT+WATCHDOG', 'EVENT+WATCHDOG']);
});

test('B2 the incident rate is a DIFFERENT number from the boot count: 2 trips, 4 boots', () => {
  const r = live(RTH);
  assert.equal(r.trips.length, 2);
  assert.deepEqual(r.trips.map(t => t.lag), [14395, 13531]);
  assert.equal(r.bootCount, 4);
});

test('B3 POSITIVE CONTROL — over the doTick tape window a deploys-only detector sees ZERO and the '
  + 'union sees three; that window is ~50% boot transient', () => {
  const deploysOnly = FX.deploys
    .filter(d => d.finishedAt >= TAPE.from && d.finishedAt <= TAPE.to);
  assert.equal(deploysOnly.length, 0, 'the false all-clear the old check emitted');

  const r = live(TAPE);
  assert.equal(r.blind, false, r.blindReasons.join('; '));
  assert.equal(r.bootCount, 3);
  assert.equal(r.invisibleToDeploys, 3, 'every boot in this window is invisible to the deploys API');
  assert.equal(assertContinuous(r).verdict, 'RESTARTED');
});

test('B4 the 20:03:28Z SUPPRESSED line is reported but is NOT a boot', () => {
  const r = live(TAPE);
  assert.equal(r.suppressed.length, 1);
  assert.ok(!r.boots.some(b => b.at.startsWith('2026-07-24T20:03')));
});

test('B5 a boot just OUTSIDE the left edge is surfaced for transient exclusion but never counted', () => {
  const r = live({ from: '2026-07-24T16:16:00.000Z', to: '2026-07-24T16:30:00.000Z' }, { preWindowMs: 120_000 });
  assert.equal(r.bootCount, 0);
  assert.equal(r.bootsWithPreWindow.length, 1);
  assert.equal(r.bootsWithPreWindow[0].inWindow, false);
  assert.ok(r.bootsWithPreWindow[0].at.startsWith('2026-07-24T16:15'));
});

// ── F: fail closed ──────────────────────────────────────────────────────────────────────────────

test('F1 an unreadable watchdog probe BLINDS the detector — it does NOT fall back to the deploys API', () => {
  const r = live(RTH, { watchdogOk: false, watchdogLines: [] });
  assert.equal(r.blind, true);
  assert.equal(r.bootCount, null, 'a blind detector must not hand back a number that reads as a measurement');
  assert.equal(assertContinuous(r).verdict, 'BLIND');
});

test('F2 zero lines from the UNFILTERED coverage probe means the stream is unreadable, not quiet', () => {
  const r = live(RTH, { watchdogLines: [], coverageLineCount: 0 });
  assert.equal(r.blind, true);
  assert.match(r.blindReasons.join(' '), /unreadable, not quiet/);
});

test('F3 …and with the coverage probe answering, an empty filter response is an OBSERVED zero', () => {
  const r = live({ from: '2026-07-24T17:00:00.000Z', to: '2026-07-24T18:00:00.000Z' });
  assert.equal(r.blind, false, r.blindReasons.join('; '));
  assert.equal(r.bootCount, 0);
  assert.equal(assertContinuous(r).verdict, 'CONTINUOUS');
});

test('F4 one unclassifiable line blinds the whole leg', () => {
  const r = live(RTH, { watchdogLines: [...FX.logs, { timestamp: '2026-07-24T14:00:00.000Z',
    message: JSON.stringify({ msg: 'watchdog did something new', detail: 'self-restarting' }) }] });
  assert.equal(r.blind, true);
  assert.match(r.blindReasons.join(' '), /fit no known shape/);
});

test('F5 a deploys page that does not reach back past the window open is BLIND, not clean', () => {
  const r = live(RTH, { deploys: FX.deploys.filter(d => d.finishedAt > RTH.from) });
  assert.equal(r.blind, true);
  assert.match(r.blindReasons.join(' '), /deploys page did not reach back/);
});

test('F6 an events page that does not reach back past the window open is BLIND, not clean', () => {
  const r = live(RTH, { events: FX.events.filter(e => e.timestamp > RTH.from) });
  assert.equal(r.blind, true);
  assert.match(r.blindReasons.join(' '), /events page did not reach back/);
});

// ── F7-F10 (TRA-2294): the events read is TIME-BOUNDED, so coverage is a different question ───────
//
// F6 above is the rule for an UNBOUNDED `?limit=N` read: "is the oldest thing I hold older than the
// window?" That rule is wrong for a `?startTime=&endTime=` read, and wrong in the FAIL-CLOSED
// direction, which is why it went unnoticed: it blinded three of the five prior RTH sessions on
// 2026-07-25, i.e. exactly the historical sessions a recurrence question is made of. The two rules
// are both correct and are selected by WHICH QUESTION THE CALLER ASKED — never inferred.

test('F7 a bounded events read that covers the window is NOT blind, even with no event older than it', () => {
  // The false blind, verbatim: a service quiet before the bell holds nothing older than `from`.
  const quiet = FX.events.filter(e => e.timestamp > RTH.from);
  const r = live(RTH, { events: quiet, eventsQueryFrom: RTH.from });
  assert.equal(r.blind, false, r.blindReasons.join(' | '));
  assert.equal(r.bootCount, 4);
  assert.equal(r.invisibleToDeploys, 2);
});

test('F8 a bounded events read that STARTS after the window open is BLIND', () => {
  const r = live(RTH, { events: FX.events, eventsQueryFrom: '2026-07-24T15:00:00.000Z' });
  assert.equal(r.blind, true);
  assert.match(r.blindReasons.join(' '), /startTime AFTER the window open/);
});

test('F9 a bounded events read that came back SATURATED is BLIND', () => {
  const r = live(RTH, { events: FX.events, eventsQueryFrom: RTH.from, eventsTruncated: true });
  assert.equal(r.blind, true);
  assert.match(r.blindReasons.join(' '), /SATURATED/);
});

test('F10 a truncated watchdog page is BLIND — a lower-bound trip count reads as clean', () => {
  const r = live(RTH, { watchdogTruncated: true });
  assert.equal(r.blind, true);
  assert.match(r.blindReasons.join(' '), /watchdog log page was TRUNCATED/);
  assert.equal(r.bootCount, null);
});

test('F11 the pre-window edge, not `from`, is what a bounded events query must reach back to', () => {
  // preWindowMs pushes the left edge earlier; a query that only reaches `from` no longer covers it.
  const r = live({ ...RTH, preWindowMs: 120_000 }, { events: FX.events, eventsQueryFrom: RTH.from });
  assert.equal(r.blind, true);
  assert.match(r.blindReasons.join(' '), /startTime AFTER the window open/);
});

// ── L-OLD: regression controls. These assert the OLD expressions still get the WRONG answer. ─────

test('L-OLD-a the naive /WATCHDOG TRIP/i DOES match the suppressed line — the bug is still visible', () => {
  const msg = JSON.parse(SUPPRESSED_2003.message).msg;
  assert.equal(/WATCHDOG TRIP/i.test(msg), true);
});

test('L-OLD-b a (lag,rss) dedupe over the BOOT set DOES delete one of the two real boots', () => {
  const seen = new Set();
  const kept = [BOOT_1559, BOOT_1615].map(classifyWatchdogLine)
    .filter(b => { const k = `${b.lag}|${b.rss}`; if (seen.has(k)) return false; seen.add(k); return true; });
  assert.equal(kept.length, 1, '2 real boots -> 1: the deletion is real');
});

test('L-OLD-c keying deploy boots on the `deploy_started` EVENT reproduces the phantom 6 boots / 4 '
  + 'invisible — the exact wrong number this ticket was filed with', () => {
  // ~100 s separates `deploy_started` from the boot, which is WIDER than the 90 s cluster, so each
  // deploy's own boot echo fails to collapse into it and is counted as a second, phantom, "invisible"
  // boot. A WRONG NUMBER THAT REPRODUCES IS NOT CONFIRMED — IT MAY BE THE SAME BUG RUNNING TWICE.
  const startedAsDeploys = FX.events
    .filter(e => e.type === 'deploy_started')
    .map(e => ({ id: e.details.deployId, finishedAt: e.timestamp, createdAt: '2026-07-12T00:00:00Z' }));
  const r = live(RTH, { deploys: startedAsDeploys });
  assert.equal(r.bootCount, 6);
  assert.equal(r.invisibleToDeploys, 4);

  // …and the fix, on the same bytes, is 4 / 2. One field apart.
  const fixed = live(RTH);
  assert.equal(fixed.bootCount, 4);
  assert.equal(fixed.invisibleToDeploys, 2);
});

test('L-OLD-d the cluster is wider than a trip→echo gap and narrower than a deploy_started→boot gap', () => {
  const tripToEcho = new Date(BOOT_1956.timestamp) - new Date(TRIP_1956.timestamp);
  const startedToEcho = new Date(BOOT_1559.timestamp)
    - new Date(FX.events.find(e => e.timestamp.startsWith('2026-07-24T15:58:03')).timestamp);
  assert.ok(tripToEcho < BOOT_CLUSTER_MS, 'a trip and its own boot echo must collapse');
  assert.ok(startedToEcho > BOOT_CLUSTER_MS, 'which is exactly why deploy_started cannot be the key');
});

test('L-OLD-e the unbounded coverage rule, applied to a bounded read, still FALSE-BLINDS a good window', () => {
  // TRA-2294. The shipped detector judged a `?limit=100` newest-first page, so it asked "is the
  // oldest event I hold older than the window open?". Keep asking that of a time-bounded read and a
  // perfectly covered quiet session is BLIND — the answer that HOLDS a gate rather than passing it,
  // which is why this cost three sessions of history and no alarm. Encode the wrong answer, not just
  // the right one: a suite that only asserts the fix cannot tell you the fix is still load-bearing.
  const quiet = FX.events.filter(e => e.timestamp > RTH.from);
  const old = live(RTH, { events: quiet });                                // no eventsQueryFrom
  assert.equal(old.blind, true);
  assert.match(old.blindReasons.join(' '), /events page did not reach back/);
  assert.equal(old.bootCount, null);

  // …and the fix, on the same bytes, reads the window.
  const fixed = live(RTH, { events: quiet, eventsQueryFrom: RTH.from });
  assert.equal(fixed.blind, false);
  assert.equal(fixed.bootCount, 4);
});
