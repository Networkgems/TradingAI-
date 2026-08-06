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

// ── L13–L17 (TRA-3049): the use-vs-mention quarantine, asserted in BOTH directions ──────────────
//
// These two lines are NOT in the 07-24 fixture, because they are the shapes the shipped acquisition
// axes cannot see (no "self-restarting" in the payload, and level=warn). They are verbatim from
// `packages/server/src/event-loop-watchdog.ts` — :961 and :245 — which is the only honest source for
// a line no query returns. L-OLD-c below pins that the naive expression still mis-scores both.
const EXTKILL = {
  timestamp: '2026-08-05T15:20:00.000000000Z',
  message: JSON.stringify({
    level: 'warn', module: 'event-loop-watchdog',
    msg: 'prior process died WITHOUT a watchdog trip — external kill (SIGKILL 137 / health-check SIGTERM) suspected',
    lastAliveUptimeSec: 1721, lastAliveRssMB: 1204, lastAliveLagMaxMs: 41,
  }),
};
const BREADCRUMB_ERR = {
  timestamp: '2026-08-05T15:16:53.700000000Z',
  message: JSON.stringify({
    level: 'warn', module: 'event-loop-watchdog',
    msg: 'failed to persist watchdog trip breadcrumb', err: 'EACCES: permission denied',
  }),
};
// The OTHER error-level trip wording (`event-loop-watchdog.ts:1149`) and it is a genuine USE — the
// watchdog really tripped, only the restart action was disabled. It MUST keep scoring TRIP. This is
// the arm that catches a quarantine which over-reaches, and it is the line a careless tightening
// would swallow first.
const OBSERVE_ONLY = {
  timestamp: '2026-08-05T15:41:00.000000000Z',
  message: JSON.stringify({
    level: 'error', module: 'event-loop-watchdog', msg: 'watchdog tripped but restart disabled — observe-only',
    reason: 'lag', rssMB: 1502, lagMaxMs: 9001,
    detail: 'single event-loop block: max lag 9001ms >= 4000ms — self-restarting before the platform hard-kill',
  }),
};

test('L13 ARM A — "prior process died WITHOUT a watchdog trip" is NOT a TRIP, from the classifier '
  + 'itself with no pre-filter in front of it', () => {
  assert.equal(classifyWatchdogLine(EXTKILL).kind, 'EXTERNAL_KILL');
});

test('L14 ARM B — a real trip still scores TRIP under BOTH of its wordings (a quarantine that '
  + 'swallows the real trip is worse than the bug it fixes)', () => {
  assert.equal(classifyWatchdogLine(TRIP_1956).kind, 'TRIP');
  assert.equal(classifyWatchdogLine(OBSERVE_ONLY).kind, 'TRIP');
});

test('L15 ARM A — "failed to persist watchdog trip breadcrumb" is NOT a TRIP: the subject is a FILE '
  + 'WRITE, and it carries no lag/rss so it would dedupe to a PHANTOM SECOND incident', () => {
  assert.equal(classifyWatchdogLine(BREADCRUMB_ERR).kind, 'BREADCRUMB_ERROR');
  const beside = [BREADCRUMB_ERR, TRIP_1956].map(classifyWatchdogLine);
  assert.equal(distinctTrips(beside).length, 1);   // 1, not 2
});

test('L16 distinctTrips counts the uses and none of the mentions — 2 mentions + 2 uses is 2 '
  + 'incidents, not 0 and not 4', () => {
  const slice = [EXTKILL, BREADCRUMB_ERR, TRIP_1956, OBSERVE_ONLY].map(classifyWatchdogLine);
  assert.equal(distinctTrips([EXTKILL, BREADCRUMB_ERR].map(classifyWatchdogLine)).length, 0);
  assert.equal(distinctTrips(slice).length, 2);
});

test('L17 the quarantined kinds are NAMED, not UNCLASSIFIED — a known non-incident must not BLIND '
  + 'the caller (that trades a false RED for a false HELD)', () => {
  for (const l of [EXTKILL, BREADCRUMB_ERR]) {
    assert.notEqual(classifyWatchdogLine(l).kind, 'UNCLASSIFIED');
  }
  // Both fixtures sit INSIDE this window, so `trips: 0` is a real observation and not an artifact of
  // the span filter — `distinctTrips` is applied to the in-span slice.
  const r = buildBootSet({
    from: '2026-08-05T13:30:00.000Z', to: '2026-08-05T20:00:00.000Z',
    watchdogLines: [EXTKILL, BREADCRUMB_ERR], watchdogOk: true,
    coverageLineCount: FX.coverageLineCount, coverageOk: true,
    deploys: FX.deploys, deploysOk: true, events: FX.events, eventsOk: true,
  });
  assert.equal(r.unclassified.length, 0);   // named ⇒ no blind reason is raised for them
  assert.equal(r.trips.length, 0);          // in-span, and still not incidents
  assert.ok(!r.blindReasons.some(x => /fit no known shape/.test(x)));
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

// ── K (TRA-3060): the FOURTH witness — the external-kill line as a boot candidate ───────────────
//
// `__fixtures__/bqb1-2026-08-04-external-kill.json` is the verbatim payload of four Render reads over
// 2026-08-04T20:30–20:45Z. It holds TWO real boots, each one witnessed THREE ways within ~5 s:
// a watchdog BOOT echo, an external-kill line ~1 ms later, and a deploy `finishedAt` ~3 s later.
// That is the overlap the ticket demanded be proven, on bytes rather than on a hand-built pair.
const FXK = JSON.parse(readFileSync(
  fileURLToPath(new URL('./__fixtures__/bqb1-2026-08-04-external-kill.json', import.meta.url)), 'utf8'));
const KW = { from: '2026-08-04T20:30:00.000Z', to: '2026-08-04T20:45:00.000Z' };
const kill = (over = {}) => buildBootSet({
  ...KW,
  watchdogLines: FXK.watchdogLogs, watchdogOk: true,
  coverageLineCount: 5, coverageOk: true,
  deploys: FXK.deploys, deploysOk: true,
  events: FXK.events, eventsOk: true, eventsQueryFrom: KW.from,
  ...over,
});

test('K1 ARM A — an external-kill line with NO other witness IS a boot, and is reported as one no '
  + 'original witness saw', () => {
  const r = buildBootSet({
    ...KW,
    watchdogLines: [], watchdogOk: true,
    externalKillLines: [FXK.externalKillLogs[0]], externalKillOk: true,
    coverageLineCount: 5, coverageOk: true,
    deploys: [{ finishedAt: '2026-07-30T07:57:18.097Z' }], deploysOk: true,
    events: [], eventsOk: true, eventsQueryFrom: KW.from,
  });
  assert.equal(r.blind, false);
  assert.equal(r.bootCount, 1);
  assert.deepEqual(r.boots[0].srcs, ['EXTERNAL_KILL']);
  assert.equal(r.seenOnlyByExternalKill, 1);
});

test('K2 ARM B — the identical world WITHOUT the line is silent. A detector that fires either way '
  + 'discriminates nothing', () => {
  const r = buildBootSet({
    ...KW,
    watchdogLines: [], watchdogOk: true,
    externalKillLines: [], externalKillOk: true,
    coverageLineCount: 5, coverageOk: true,
    deploys: [{ finishedAt: '2026-07-30T07:57:18.097Z' }], deploysOk: true,
    events: [], eventsOk: true, eventsQueryFrom: KW.from,
  });
  assert.equal(r.blind, false);
  assert.equal(r.bootCount, 0);
  assert.equal(r.seenOnlyByExternalKill, 0);
});

test('K3 THE TRAP — 2 boots seen by 3 witnesses each is 2 boots, NOT 4 and NOT 6. The failing '
  + 'direction here is an OVER-count, which is the defect this module exists to prevent', () => {
  const withKill = kill({ externalKillLines: FXK.externalKillLogs, externalKillOk: true });
  assert.equal(withKill.blind, false);
  assert.equal(withKill.bootCount, 2);
  // Every boot carries all three accounts of itself — that is what proves the collapse happened
  // rather than that the candidates were silently dropped on the floor.
  for (const b of withKill.boots) {
    assert.deepEqual([...b.srcs].sort(), ['DEPLOY', 'EXTERNAL_KILL', 'WATCHDOG']);
  }
  assert.equal(withKill.sources.externalKill.candidates, 2, 'both candidates were BUILT…');
  assert.equal(withKill.seenOnlyByExternalKill, 0, '…and both were absorbed, not counted twice');
});

test('K4 …and the collapse is the 90 s CLUSTER doing the work, not the emitter\'s own 5 s '
  + 'suppression — which lives on a build this reader may not be running', () => {
  // Same verbatim line, moved to +60 s (inside the cluster) and +120 s (outside it). The emitter
  // suppresses its own duplicate at >5 s, so if that suppression is what we were relying on, BOTH
  // of these would be single boots. Only the first is.
  const echoAt = FXK.watchdogLogs[0].timestamp;
  const shift = (ms) => [{ ...FXK.externalKillLogs[0], timestamp: new Date(new Date(echoAt).getTime() + ms).toISOString() }];
  const inside = kill({ watchdogLines: [FXK.watchdogLogs[0]], externalKillLines: shift(60_000), deploys: [{ finishedAt: '2026-07-30T07:57:18.097Z' }] });
  const outside = kill({ watchdogLines: [FXK.watchdogLogs[0]], externalKillLines: shift(120_000), deploys: [{ finishedAt: '2026-07-30T07:57:18.097Z' }] });
  assert.equal(inside.bootCount, 1, '60 s apart -> one boot, two witnesses');
  assert.equal(outside.bootCount, 2, '120 s apart -> two boots: the cluster, not the server, decides');
  assert.ok(60_000 < BOOT_CLUSTER_MS && 120_000 > BOOT_CLUSTER_MS);
});

test('K5 DEFAULT-INERT — omitting the new input reproduces the pre-TRA-3060 answer byte for byte. '
  + 'This is the pin that says no shipped consumer moved', () => {
  const before = live(RTH);
  assert.equal(before.bootCount, 4);
  assert.equal(before.invisibleToDeploys, 2);
  assert.equal(before.blind, false);
  assert.equal(before.blindReasons.length, 0);
  assert.equal(before.seenOnlyByExternalKill, 0);
  // …and on the 08-04 window too: supplying the lines changes NOTHING about the count. This is the
  // measured finding (delta 0 over every readable session), asserted rather than remembered.
  assert.equal(kill().bootCount, kill({ externalKillLines: FXK.externalKillLogs }).bootCount);
});

test('K6 a line on the external-kill read that is NOT an external kill BLINDS — the filter or the '
  + 'emitter has drifted, and a drifted acquisition must not quietly return fewer boots', () => {
  const r = kill({ externalKillLines: [TRIP_1956], externalKillOk: true });
  assert.equal(r.blind, true);
  assert.match(r.blindReasons.join(' '), /did not classify as EXTERNAL_KILL \(TRIP\)/);
  assert.equal(r.bootCount, null);
});

test('K7 an unreadable or truncated external-kill read BLINDS rather than reporting a lower bound — '
  + 'a lower bound reads as "clean"', () => {
  const failed = kill({ externalKillLines: [], externalKillOk: false });
  assert.equal(failed.blind, true);
  assert.match(failed.blindReasons.join(' '), /external-kill log probe .* FAILED/);
  const truncated = kill({ externalKillLines: FXK.externalKillLogs, externalKillOk: true, externalKillTruncated: true });
  assert.equal(truncated.blind, true);
  assert.match(truncated.blindReasons.join(' '), /external-kill log page was TRUNCATED/);
});

test('K8 THE MEASURED REDUNDANCY, pinned on real bytes: every external-kill line in the fixture has '
  + 'a BOOT echo within the cluster. That is WHY the delta is zero, and it stops being true the day '
  + 'the trip breadcrumb is absent', () => {
  const echoes = FXK.watchdogLogs.map(classifyWatchdogLine).filter(l => l.kind === 'BOOT');
  const kills = FXK.externalKillLogs.map(classifyWatchdogLine);
  assert.equal(kills.length, 2);
  assert.ok(kills.every(k => k.kind === 'EXTERNAL_KILL'));
  for (const k of kills) {
    const near = echoes.filter(e => Math.abs(new Date(e.at) - new Date(k.at)) <= BOOT_CLUSTER_MS);
    assert.equal(near.length, 1, `${k.at} must have exactly one echo inside the cluster`);
    // Measured 0.476–4.688 ms across all 39 lines of the 08-01..08-06 population — the same boot.
    assert.ok(Math.abs(new Date(near[0].at) - new Date(k.at)) < 5_000);
  }
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

test('L-OLD-f (TRA-3049) the naive /WATCHDOG TRIP/i DOES match BOTH quarantined lines — the bugs '
  + 'stay visible, so a green run means the fix holds rather than that the suite went blind', () => {
  for (const l of [EXTKILL, BREADCRUMB_ERR]) {
    assert.equal(/WATCHDOG TRIP/i.test(JSON.parse(l.message).msg), true);
  }
  // …and the load-bearing direction: the quarantine regex must NOT match a line asserting a trip.
  for (const l of [TRIP_1956, OBSERVE_ONLY]) {
    assert.equal(/without a watchdog trip/i.test(JSON.parse(l.message).msg), false);
  }
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
