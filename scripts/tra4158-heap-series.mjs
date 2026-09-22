#!/usr/bin/env node
/**
 * TRA-4158 — append-only tape of bqb1's memory levels, and the growth report
 * folded off it.
 *
 * ## Why this exists as well as the in-process tape
 *
 * `heap-census-sampler.ts` keeps a resident 24h ring, which is the better
 * instrument — one post-close read returns the whole session. But it only
 * exists on a build that carries it, and every read of it dies with the
 * process. The two failure modes that matter here are precisely process death
 * (the watchdog self-restarts on a trip; a deploy restarts the box) and, right
 * now, the fact that the live build predates the census entirely.
 *
 * So this polls what the CURRENT live build already publishes —
 * `/api/health/watchdog`, whose `lastSample` carries `heapUsedBytes`, `rssBytes`
 * and `heapPct` — and appends it to a file on disk. A tape that survives the
 * restarts is the only kind that can show the overnight-flat shape across one.
 *
 * ## The `pid` + `startedAt` columns are load-bearing
 *
 * The claim under test is "the heap climbs across a session and does NOT come
 * back down overnight". A restart resets the heap to a few hundred MB, which
 * looks exactly like a release. Every row therefore carries the boot identity,
 * and `--report` SEGMENTS the tape on it: a delta computed across a restart
 * boundary is not a measurement of anything and is refused rather than
 * averaged in.
 *
 * ## Usage
 *
 *   node scripts/tra4158-heap-series.mjs --once            # append one row
 *   node scripts/tra4158-heap-series.mjs --report          # fold the tape
 *   node scripts/tra4158-heap-series.mjs --once --report   # both
 *   node scripts/tra4158-heap-series.mjs --restarts        # boot-lifetime census
 *   --tape=<path>   default reports/tra4158-heap-series.jsonl
 *   --base=<url>    default https://tradingai-bqb1.onrender.com
 *   --since=<iso>   --restarts only: scope the reachability stats to boots
 *                   starting at or after this instant
 *
 * `--restarts` answers a question this ticket cannot skip: AC1 wants two heap
 * reads on ONE boot, ~+1h and ~+8h apart, and whether such a boot exists is a
 * measurement. It folds Render's event stream into boot segments and prints the
 * fraction reaching each uptime. See `reportRestarts` for why a succeeded
 * deploy has to count as a boundary.
 *
 * Exit codes: 0 OK · 2 usage · 3 BLIND (host unreachable / unparseable).
 * BLIND is never 0: "could not measure" and "measured and it is fine" must not
 * share an exit code, or an unreachable host reads as a healthy one.
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DEFAULT_TAPE = resolve(REPO, 'reports/tra4158-heap-series.jsonl');
const DEFAULT_BASE = 'https://tradingai-bqb1.onrender.com';
const MB = 1024 * 1024;

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

const round1 = n => Math.round(n * 10) / 10;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * One row. Everything here is derived from a SINGLE watchdog read, so the
 * levels and the boot identity cannot disagree with each other — re-fetching
 * the build separately is how a row ends up attributing one boot's heap to
 * another boot's pid.
 */
async function readOnce(base) {
  const wd = await fetchJson(`${base}/api/health/watchdog`);
  const w = wd?.watchdog;
  const s = w?.lastSample;
  if (!s || typeof s.heapUsedBytes !== 'number') {
    throw new Error('watchdog.lastSample.heapUsedBytes missing — cannot grade this read');
  }
  const row = {
    atIso: new Date().toISOString(),
    serverTime: wd.time ?? null,
    pid: wd.build?.pid ?? null,
    startedAt: wd.build?.startedAt ?? null,
    commit: wd.build?.commitShort ?? null,
    uptimeSec: wd.build?.uptimeSec ?? null,
    heapUsedMB: round1(s.heapUsedBytes / MB),
    heapLimitMB: round1((s.heapLimitBytes ?? 0) / MB),
    heapPct: typeof s.heapPct === 'number' ? Math.round(s.heapPct * 1000) / 1000 : null,
    rssMB: round1((s.rssBytes ?? 0) / MB),
    externalMB: round1((s.externalBytes ?? 0) / MB),
    arrayBuffersMB: round1((s.arrayBuffersBytes ?? 0) / MB),
    peakRssMB: round1((w.peakRssSinceBoot?.rssBytes ?? 0) / MB),
    // Cumulative since boot. Major-GC total time is the direct test of the
    // "1.6GB old space makes every mark-compact a multi-second pause"
    // hypothesis this ticket is a precondition of (TRA-3660).
    gcMajorCount: w.gc?.byKind?.major?.count ?? null,
    gcMajorTotalMs: w.gc?.byKind?.major?.totalMs ?? null,
    gcMajorMaxMs: w.gc?.byKind?.major?.maxMs ?? null,
    gcMaxPauseMs: w.gc?.maxPause?.durationMs ?? null,
    gcMaxPauseHeapMB: w.gc?.maxPause?.heapUsedMB ?? null,
    // Present only once the TRA-4158 census is deployed; null before that, and
    // the difference is visible in the tape rather than silently absent.
    censusTopName: null,
    censusTopEntries: null,
  };

  // Best-effort: the census route does not exist on builds before this ticket.
  // A 404 here is expected and must not fail the read — but it must also not be
  // mistaken for "the census reported nothing".
  try {
    const hc = await fetchJson(`${base}/api/health/heap-census`);
    const top = hc?.census?.live?.[0];
    if (top) {
      row.censusTopName = top.name;
      row.censusTopEntries = top.entries;
      row.censusSamples = hc.census.samples ?? null;
    }
  } catch {
    /* route absent on this build */
  }
  return row;
}

async function loadTape(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return raw
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * ## The RTH-hours ruler — why wall-clock uptime is the WRONG denominator
 *
 * AC1 as filed asks for two reads "~+1h and ~+8h" of UPTIME. Measured
 * 2026-09-01 over the 26 deaths that carry an rss at trip, `rssMB` at death
 * correlates with wall-clock uptime at r=0.560 and with RTH-hours at r=0.839.
 * The sharpest pair: a 68.15h boot spanning a WEEKEND died at 1703MB, while a
 * 24.50h boot spanning one full session died at 2606MB — 2.8x the uptime, 41%
 * of the RTH exposure, 65% of the RSS.
 *
 * So a weekend boot satisfies "+1h and +8h apart" while carrying ~0 RTH-hours
 * and showing no growth. That is a STRUCTURAL false negative, not bad luck, and
 * an eligibility rule stated in wall-clock hours cannot exclude it. AC1 is
 * therefore restated as **>= 4 RTH-hours apart on ONE boot** and graded here.
 *
 * ⚠️ DIRECTION OF THE ERROR. The calendar below models weekends, the 2026 US
 * market holidays and the three 2026 half-days. Anything it gets wrong
 * OVERSTATES exposure, which would let a thin pair read ELIGIBLE — the
 * permissive direction for a gate. `RTH_CALENDAR_THROUGH` is therefore checked
 * by the fold: past it the calendar degrades to the weekday rule, and the
 * report says so out loud rather than quietly reverting to an upper bound.
 */
const RTH_OPEN_MIN = 13 * 60 + 30; // 13:30Z
const RTH_CLOSE_MIN = 20 * 60; // 20:00Z
const DAY_MS = 86_400_000;

// UTC dates on which the US equity market is CLOSED in 2026 (weekdays only —
// weekend closure is handled by the day-of-week rule and needs no table).
const RTH_HOLIDAYS_2026 = new Set([
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Jr Day
  '2026-02-16', // Washington's Birthday
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed; Jul 4 is a Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day
]);

// Half-days: the close moves to 13:00 ET = 17:00Z. The open does not move.
const RTH_EARLY_CLOSE_2026 = new Map([
  ['2026-07-02', 17 * 60],
  ['2026-11-27', 17 * 60],
  ['2026-12-24', 17 * 60],
]);

const RTH_CALENDAR_THROUGH = Date.parse('2026-12-31T23:59:59Z');

/**
 * Hours of regular trading time inside [startMs, endMs). Pure; no clock read.
 *
 * Returns 0 rather than a negative for an inverted or degenerate interval: a
 * negative exposure would silently cancel a real one when summed.
 */
function rthHoursBetween(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  let total = 0;
  const first = new Date(startMs);
  let dayStart = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  for (; dayStart < endMs; dayStart += DAY_MS) {
    const d = new Date(dayStart);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const key = d.toISOString().slice(0, 10);
    if (RTH_HOLIDAYS_2026.has(key)) continue;
    const closeMin = RTH_EARLY_CLOSE_2026.get(key) ?? RTH_CLOSE_MIN;
    const lo = Math.max(dayStart + RTH_OPEN_MIN * 60_000, startMs);
    const hi = Math.min(dayStart + closeMin * 60_000, endMs);
    if (hi > lo) total += hi - lo;
  }
  return total / 3_600_000;
}

/** AC1's restated threshold: the two reads must straddle >= 4 RTH-hours. */
const AC1_MIN_RTH_HOURS = 4;

/**
 * Grade one boot's reads against the restated AC1.
 *
 * Deliberately keyed on the widest pair WITHIN a boot: a pair spanning a
 * restart is not a measurement of retention at all, which is the same reason
 * `report` segments on `startedAt`.
 */
function ac1Eligibility(segRows) {
  if (!Array.isArray(segRows) || segRows.length < 2) {
    return { eligible: false, rthHours: 0, reason: 'fewer than two reads on this boot' };
  }
  const firstAt = Date.parse(segRows[0].atIso);
  const lastAt = Date.parse(segRows[segRows.length - 1].atIso);
  const rthHours = rthHoursBetween(firstAt, lastAt);
  return {
    eligible: rthHours >= AC1_MIN_RTH_HOURS,
    rthHours,
    reason:
      rthHours >= AC1_MIN_RTH_HOURS
        ? `pair straddles ${rthHours.toFixed(2)} RTH-hours`
        : `pair straddles only ${rthHours.toFixed(2)} RTH-hours (need >= ${AC1_MIN_RTH_HOURS.toFixed(1)})`,
  };
}

/**
 * Fold the tape into one block per BOOT.
 *
 * Segmenting on `startedAt` is the whole point: the defect is "climbs through
 * the session, does not release overnight", and a restart produces a drop that
 * is indistinguishable from a release unless the boundary is respected.
 */
function report(rows) {
  if (rows.length === 0) {
    console.log('[tra4158] tape is empty — nothing to fold.');
    return;
  }
  const segments = [];
  for (const r of rows) {
    const last = segments[segments.length - 1];
    if (last && last.startedAt === r.startedAt) last.rows.push(r);
    else segments.push({ startedAt: r.startedAt, pid: r.pid, commit: r.commit, rows: [r] });
  }

  console.log(`[tra4158] ${rows.length} rows across ${segments.length} boot(s)\n`);
  let bestPair = 0;
  for (const seg of segments) {
    const first = seg.rows[0];
    const last = seg.rows[seg.rows.length - 1];
    const peakHeap = Math.max(...seg.rows.map(r => r.heapUsedMB));
    const peakRss = Math.max(...seg.rows.map(r => r.rssMB));
    console.log(`boot ${seg.startedAt} pid ${seg.pid} commit ${seg.commit} — ${seg.rows.length} read(s)`);
    console.log('  atIso                     uptimeH   rthH  heapMB  heapPct   rssMB  peakRssMB  gcMajor  gcMajorMaxMs');
    for (const r of seg.rows) {
      const upH = r.uptimeSec === null ? '   ?  ' : (r.uptimeSec / 3600).toFixed(2).padStart(6);
      // RTH exposure of this BOOT at the moment of the read — the ruler that
      // correlates with the growth (r=0.839) rather than the one that does not.
      const bootAt = Date.parse(seg.startedAt ?? '');
      const rthH = Number.isFinite(bootAt)
        ? rthHoursBetween(bootAt, Date.parse(r.atIso)).toFixed(2).padStart(5)
        : '    ?';
      console.log(
        `  ${r.atIso}  ${upH}  ${rthH}  ${String(r.heapUsedMB).padStart(6)}  ${String(r.heapPct ?? '?').padStart(6)}` +
          `  ${String(r.rssMB).padStart(6)}  ${String(r.peakRssMB).padStart(9)}` +
          `  ${String(r.gcMajorCount ?? '?').padStart(7)}  ${String(r.gcMajorMaxMs === null ? '?' : round1(r.gcMajorMaxMs)).padStart(12)}`,
      );
    }
    if (seg.rows.length >= 2) {
      const hours = (Date.parse(last.atIso) - Date.parse(first.atIso)) / 3_600_000;
      const ac1 = ac1Eligibility(seg.rows);
      console.log(
        `  Δheap ${round1(last.heapUsedMB - first.heapUsedMB)}MB over ${round1(hours)}h` +
          ` · peak heap ${peakHeap}MB (${round1((peakHeap / (last.heapLimitMB || 1812)) * 100)}% of cap)` +
          ` · peak rss ${peakRss}MB`,
      );
      console.log(`  AC1 pair: ${ac1.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'} — ${ac1.reason}`);
      bestPair = Math.max(bestPair, ac1.rthHours);
    } else {
      console.log('  (single read in this boot — a delta needs two, and one across a restart is not one)');
    }
    console.log('');
  }

  // The tape-level AC1 verdict. Stated as its own line because "no eligible
  // pair exists yet" is the finding — it is what says the measurement is
  // blocked on boot lifetime (TRA-3660), not on someone remembering to poll.
  if (bestPair >= AC1_MIN_RTH_HOURS) {
    console.log(`AC1 EVIDENCE PRESENT — widest in-boot pair straddles ${bestPair.toFixed(2)} RTH-hours.`);
  } else {
    console.log(
      `AC1 EVIDENCE ABSENT — widest in-boot pair straddles ${bestPair.toFixed(2)} RTH-hours,` +
        ` below the ${AC1_MIN_RTH_HOURS.toFixed(1)} the restated AC1 requires.` +
        ' A read pair on a boot that did not survive a session cannot grade retention.',
    );
  }
  const latest = Math.max(...rows.map(r => Date.parse(r.atIso)).filter(Number.isFinite));
  if (latest > RTH_CALENDAR_THROUGH) {
    console.log(
      '⚠️ RTH calendar coverage ends 2026-12-31; later rows are folded on the weekday rule alone,' +
        ' which OVERSTATES exposure (the permissive direction). Extend the holiday table.',
    );
  }
}

/**
 * Fold Render's service events into the census of BOOT SEGMENTS.
 *
 * Why this lives here and not in a notebook: AC1 asks for two heap reads on one
 * boot, at ~+1h and ~+8h. Whether that pair is even OBTAINABLE is a property of
 * how long this service stays up, and that is a measurement, not an assumption.
 * Answering it by hand once produces a number that is stale the next day.
 *
 * Two boundaries, and using only one of them is the trap:
 *
 *  - `server_failed` — the container exited non-zero. This is what a watchdog
 *    self-restart looks like from outside.
 *  - `deploy_ended` with `deployStatus: succeeded` — Render swaps the instance
 *    with NO `server_failed`/`server_available` pair at all. A deploy is
 *    therefore an INVISIBLE boot boundary in the server_* stream, and a fold
 *    that ignores it OVERSTATES lifetimes.
 *
 * The cross-check that this fold is right: the 2026-08-27T13:26 trip reported
 * `uptimeSecAtTrip 88217` (24.505h) from inside the process. Segmenting on
 * server_* alone dates that boot to 2026-08-25T20:15 (41.19h — wrong by 16.7h);
 * counting the 2026-08-26T12:56:02 deploy as a boundary dates it to 24.51h,
 * which matches the process's own clock. Prefer the process clock when present;
 * this fold is what you get when the process is already gone.
 */
function reportRestarts(events, sinceIso) {
  const P = s => Date.parse(s);
  const bounds = [];
  for (const e of events) {
    if (e.type === 'server_available') bounds.push({ at: P(e.timestamp), iso: e.timestamp, kind: 'restart-boot' });
    else if (e.type === 'deploy_ended' && e.details?.deployStatus === 'succeeded')
      bounds.push({ at: P(e.timestamp), iso: e.timestamp, kind: 'deploy' });
    else if (e.type === 'server_failed') bounds.push({ at: P(e.timestamp), iso: e.timestamp, kind: 'CRASH' });
  }
  bounds.sort((a, b) => a.at - b.at);

  const segments = [];
  let cur = null;
  for (const b of bounds) {
    if (b.kind === 'CRASH') {
      if (cur) segments.push({ ...cur, endedBy: 'CRASH', hours: (b.at - cur.at) / 3_600_000 });
      cur = null;
    } else {
      if (cur) segments.push({ ...cur, endedBy: b.kind, hours: (b.at - cur.at) / 3_600_000 });
      cur = b;
    }
  }
  if (cur) segments.push({ ...cur, endedBy: '(still up)', hours: (Date.now() - cur.at) / 3_600_000 });

  const crashes = bounds.filter(b => b.kind === 'CRASH');
  // RTH in UTC. The claim being tested is that this service only ever dies
  // while the market is open; a crash count alone cannot show that.
  const inRth = c => {
    const hhmm = new Date(c.at).toISOString().slice(11, 16);
    return hhmm >= '13:30' && hhmm < '20:00';
  };
  const firstTwoHours = c => {
    const hhmm = new Date(c.at).toISOString().slice(11, 16);
    return hhmm >= '13:30' && hhmm < '15:30';
  };

  const scope = sinceIso ? segments.filter(s => s.iso >= sinceIso) : segments;
  const reachable = h => scope.filter(s => s.hours >= h).length;

  console.log(`[tra4158] ${events.length} events -> ${segments.length} boot segment(s), ${crashes.length} crash(es)`);
  if (sinceIso) console.log(`[tra4158] scoped to boots starting >= ${sinceIso}: ${scope.length}`);
  console.log('');
  console.log('  boot start            started-by     ended-by      lifetime_h');
  for (const s of scope) {
    console.log(
      `  ${s.iso.slice(0, 19)}   ${s.kind.padEnd(13)} ${s.endedBy.padEnd(12)} ${s.hours.toFixed(2).padStart(9)}`,
    );
  }
  console.log('');
  console.log(`  crashes inside RTH 13:30-20:00Z .... ${crashes.filter(inRth).length}/${crashes.length}`);
  console.log(`  crashes in first 2h 13:30-15:30Z ... ${crashes.filter(firstTwoHours).length}/${crashes.length}`);
  console.log('');
  // The AC1 verdict. A snapshot PAIR needs one boot to survive past the late
  // read, so the +8h column is the one that decides whether AC1 as filed can be
  // scheduled at all or only caught opportunistically.
  for (const h of [1, 4, 8, 24]) {
    const n = reachable(h);
    const pct = scope.length ? ((n / scope.length) * 100).toFixed(0) : '0';
    console.log(`  boots reaching +${String(h).padStart(2)}h uptime ... ${n}/${scope.length} (${pct}%)`);
  }
}

/**
 * TRA-4158 `--deaths` — partition the deaths by MODE, which `--restarts` cannot do.
 *
 * Render's event stream emits a bare `server_failed` for every non-zero exit; a
 * watchdog self-restart and a platform SIGKILL are indistinguishable there. The
 * discriminator lives only in the app's own boot lines, which classify the PRIOR
 * process's death:
 *
 *   "prior watchdog self-restart detected on boot"                 -> the watchdog did it
 *   "prior process died WITHOUT a watchdog trip — external kill ..."-> nobody owns it
 *
 * ## Why this does not simply trust those lines
 *
 * They are not mutually exclusive on the live build. The emitter suppressed the
 * second line only when the two breadcrumbs landed within 5s of each other, while
 * the liveness breadcrumb is written every 15s — so half of all graceful
 * self-restarts ALSO announce an external kill. Measured 2026-08-28..09-01: 28
 * deaths, 14 double-classified, ZERO standalone external-kill lines.
 *
 * So this PAIRS the lines by timestamp and reports a death as `external-kill` only
 * when no self-restart line sits beside it. The double-classified count is printed
 * as its own row, because while it is non-zero every mode census off the raw tape
 * is inflated — and reading it as a second death mode is exactly the trap this
 * mode exists to keep a reader out of.
 *
 * The emitter fix ships with this commit; until it is DEPLOYED the pairing here is
 * what makes the tape readable, and after it deploys `doubleClassified` should
 * decay to 0. That decay is the fix's acceptance signal.
 */
const SELF_RESTART_RE = /^prior watchdog self-restart detected on boot/;
const EXTERNAL_KILL_RE = /^prior process died WITHOUT a watchdog trip/;
/** Two lines describing the same death land within a few ms of each other. */
const PAIR_WINDOW_MS = 100;

async function fetchBootClassifications(serviceId, key, ownerId, sinceIso) {
  const endTime = new Date().toISOString();
  const rows = [];
  // Two narrow text queries rather than one broad one: the API's `text` filter is
  // case-insensitive substring, so "WATCHDOG TRIP" also matches the external-kill
  // line's "...WITHOUT a watchdog trip". Classify on the PARSED msg, never on the
  // query that found the line.
  for (const text of ['detected on boot', 'external kill']) {
    const u = new URL('https://api.render.com/v1/logs');
    u.searchParams.set('resource', serviceId);
    u.searchParams.set('ownerId', ownerId);
    u.searchParams.set('startTime', sinceIso);
    u.searchParams.set('endTime', endTime);
    u.searchParams.set('limit', '100'); // MAX 100 — larger returns an error OBJECT at HTTP 200
    u.searchParams.set('text', text);
    const res = await fetch(u, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`logs -> HTTP ${res.status}`);
    const body = await res.json();
    // FAIL CLOSED on a non-array: reading an error object as [] turns "could not
    // measure" into "measured zero deaths", which is the worst possible verdict here.
    if (body.logs !== null && !Array.isArray(body.logs)) {
      throw new Error('logs field is neither null nor an array — refusing to read it as zero');
    }
    // A truncated page is an UNDERCOUNT of deaths. Refuse rather than under-report.
    if (body.hasMore === true) {
      throw new Error(`log page for "${text}" is truncated (hasMore) — narrow --since; an undercount is not a census`);
    }
    for (const line of body.logs ?? []) {
      let msg;
      try {
        msg = JSON.parse(line.message);
      } catch {
        continue; // non-JSON platform line
      }
      const at = Date.parse(msg.ts ?? line.timestamp);
      if (!Number.isFinite(at)) continue;
      if (SELF_RESTART_RE.test(msg.msg ?? '')) {
        rows.push({ at, iso: msg.ts, mode: 'self-restart', reason: msg.reason ?? null, uptimeSecAtTrip: msg.uptimeSecAtTrip ?? null, rssMB: msg.rssMB ?? null, heapUsedMB: msg.heapUsedMB ?? null, lagMaxMs: msg.lagMaxMs ?? null, tripAtMs: msg.atMs ?? null });
      } else if (EXTERNAL_KILL_RE.test(msg.msg ?? '')) {
        rows.push({ at, iso: msg.ts, mode: 'external-kill', reason: null, uptimeSecAtTrip: msg.lastAliveUptimeSec ?? null, rssMB: msg.lastAliveRssMB ?? null, heapUsedMB: null, lagMaxMs: null, tripAtMs: null });
      }
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

/**
 * TRA-4158 (2026-09-22): the self-restart boot line is emitted from the PERSISTED
 * `lastTrip` breadcrumb, which survives deploys — so every deploy boot after a trip
 * re-announces the SAME death. Measured 09-19: 5 of 10 "deaths" were re-reads of one
 * 133s/1830MB record. Dedupe on the trip's own identity: `atMs` when the line carries
 * it (emitter includes it from this commit's deploy onward), else the record tuple —
 * two distinct trips sharing reason+uptimeSec+rss+heap+lagMax is not a real collision.
 * Keep the EARLIEST announcement; report the rest as re-announcements, not deaths.
 */
function dedupeAnnouncements(rows) {
  const seen = new Map();
  let reAnnouncements = 0;
  for (const r of rows.slice().sort((a, b) => a.at - b.at)) {
    const key = r.tripAtMs !== null && r.tripAtMs !== undefined
      ? `atMs:${r.tripAtMs}`
      : `${r.mode}|${r.reason}|${r.uptimeSecAtTrip}|${r.rssMB}|${r.heapUsedMB}|${r.lagMaxMs}`;
    if (seen.has(key)) reAnnouncements += 1;
    else seen.set(key, r);
  }
  return { rows: [...seen.values()], reAnnouncements };
}

function reportDeaths(rawRows, sinceIso) {
  const { rows, reAnnouncements } = dedupeAnnouncements(rawRows);
  const selfRestarts = rows.filter(r => r.mode === 'self-restart');
  const externalKills = rows.filter(r => r.mode === 'external-kill');
  const paired = [];
  const orphans = [];
  for (const kill of externalKills) {
    const beside = selfRestarts.find(s => Math.abs(s.at - kill.at) <= PAIR_WINDOW_MS);
    (beside ? paired : orphans).push(kill);
  }
  // One death per self-restart line, plus any external kill that stands alone.
  const deaths = selfRestarts.length + orphans.length;

  console.log(`[tra4158] boot-time death classification since ${sinceIso}`);
  console.log('');
  console.log('  boot ts                    prior death     reason  uptimeAtTrip   rssMB');
  const attributed = [...selfRestarts, ...orphans].sort((a, b) => a.at - b.at);
  for (const r of attributed) {
    console.log(
      `  ${r.iso}  ${r.mode.padEnd(14)}  ${String(r.reason ?? '-').padEnd(6)}  ${String(r.uptimeSecAtTrip ?? '-').padStart(11)}  ${String(r.rssMB ?? '-').padStart(6)}`,
    );
  }
  console.log('');
  console.log(`  distinct deaths ....................... ${deaths}`);
  console.log(`    watchdog self-restart ............... ${selfRestarts.length}`);
  console.log(`    external kill (unexplained) ......... ${orphans.length}`);
  console.log(`  re-announcements dropped .............. ${reAnnouncements} (deploy boots re-reading the persisted lastTrip)`);
  const reasons = {};
  for (const r of selfRestarts) reasons[r.reason ?? 'null'] = (reasons[r.reason ?? 'null'] ?? 0) + 1;
  console.log(`  watchdog trip reason breakdown ........ ${JSON.stringify(reasons)}`);
  console.log('');
  console.log(`  double-classified (BOTH lines, one death) ${paired.length}/${deaths}`);
  if (paired.length > 0) {
    console.log('    ^ emitter defect, fixed but not yet deployed. Until this reads 0, any');
    console.log('      census that partitions on the raw lines OVERCOUNTS external kills.');
  }
  // An OOM death is exactly what a heap-exhaustion failure looks like from outside,
  // so a standalone external kill is the one observation that would corroborate the
  // heap hypothesis. Say so explicitly rather than leaving a bare zero to be read.
  if (orphans.length === 0) {
    console.log('');
    console.log('  NOTE: zero unexplained kills => no OOM-shaped death in this window.');
    console.log('        Every death here was the watchdog choosing to restart.');
  }
}

/**
 * `--selftest` — controls for the RTH ruler and the AC1 gate.
 *
 * The two that carry the weight are the FALSE-NEGATIVE and FALSE-POSITIVE
 * controls: `weekend-boot-68h` is the real 2026-08-28..08-31 boot that
 * satisfies AC1-as-filed on wall clock and carries 41% of one session's
 * exposure, and `overnight-pair-8h` is a pair 8 wall-clock hours apart that
 * measures nothing. If either passes the gate, the gate is not the ruler this
 * ticket restated it to be.
 */
function selftest() {
  const results = [];
  const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps;
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} ${detail}`);
  };
  const H = iso => Date.parse(iso);

  console.log('[tra4158] --selftest: RTH ruler + AC1 eligibility controls\n');

  const fullSession = rthHoursBetween(H('2026-09-01T13:30:00Z'), H('2026-09-01T20:00:00Z'));
  check('full-session', near(fullSession, 6.5), `${fullSession.toFixed(3)}h (expect 6.500)`);

  const clipped = rthHoursBetween(H('2026-09-01T00:00:00Z'), H('2026-09-02T00:00:00Z'));
  check('clips-to-window', near(clipped, 6.5), `${clipped.toFixed(3)}h over a whole UTC day (expect 6.500)`);

  // The measured contrast this ruler exists for. Both are real boots.
  const weekend = rthHoursBetween(H('2026-08-28T17:23:52Z'), H('2026-08-31T13:33:30Z'));
  check(
    'weekend-boot-68h',
    near(weekend, 2.658, 0.01) && weekend < AC1_MIN_RTH_HOURS,
    `${weekend.toFixed(3)} RTH-h across 68.16 WALL-clock hours — below the ${AC1_MIN_RTH_HOURS}h gate`,
  );
  const fullDay = rthHoursBetween(H('2026-08-26T12:56:02Z'), H('2026-08-27T13:26:17Z'));
  check(
    'session-boot-24h',
    near(fullDay, 6.5) && fullDay >= AC1_MIN_RTH_HOURS,
    `${fullDay.toFixed(3)} RTH-h across 24.51 wall-clock hours — 2.4x the 68h boot's exposure`,
  );

  const weekendOnly = rthHoursBetween(H('2026-08-29T00:00:00Z'), H('2026-08-31T00:00:00Z'));
  check('weekend-is-zero', weekendOnly === 0, `${weekendOnly.toFixed(3)}h Sat+Sun (expect 0)`);

  const laborDay = rthHoursBetween(H('2026-09-07T00:00:00Z'), H('2026-09-08T00:00:00Z'));
  check('holiday-is-zero', laborDay === 0, `${laborDay.toFixed(3)}h on Labor Day 2026-09-07 (expect 0)`);

  const halfDay = rthHoursBetween(H('2026-11-27T00:00:00Z'), H('2026-11-28T00:00:00Z'));
  check('half-day-closes-1700Z', near(halfDay, 3.5), `${halfDay.toFixed(3)}h on 2026-11-27 (expect 3.500)`);

  const inverted = rthHoursBetween(H('2026-09-01T20:00:00Z'), H('2026-09-01T13:30:00Z'));
  check('inverted-is-zero', inverted === 0, `${inverted.toFixed(3)}h (a negative would cancel a real one)`);

  const nan = rthHoursBetween(Number.NaN, H('2026-09-01T20:00:00Z'));
  check('unparseable-is-zero', nan === 0, `${nan.toFixed(3)}h for an unparseable boot stamp`);

  // AC1 gate.
  const row = iso => ({ atIso: iso });
  const single = ac1Eligibility([row('2026-09-01T13:45:00Z')]);
  check('single-read-refused', !single.eligible, single.reason);

  const overnight = ac1Eligibility([row('2026-09-01T20:30:00Z'), row('2026-09-02T04:30:00Z')]);
  check(
    'overnight-pair-8h',
    !overnight.eligible && overnight.rthHours === 0,
    `8 WALL-clock hours, ${overnight.rthHours.toFixed(2)} RTH-h — AC1-as-filed would have PASSED this`,
  );

  const inSession = ac1Eligibility([row('2026-09-01T13:45:00Z'), row('2026-09-01T19:45:00Z')]);
  check('in-session-pair', inSession.eligible && near(inSession.rthHours, 6.0), inSession.reason);

  const exactly4 = ac1Eligibility([row('2026-09-01T13:45:00Z'), row('2026-09-01T17:45:00Z')]);
  check('boundary-is-inclusive', exactly4.eligible, `exactly ${exactly4.rthHours.toFixed(2)} RTH-h must pass (>=)`);

  const justUnder = ac1Eligibility([row('2026-09-01T13:45:00Z'), row('2026-09-01T17:44:00Z')]);
  check('boundary-just-under', !justUnder.eligible, justUnder.reason);

  // Today's actual post-close boot, so the control suite states the live verdict.
  const live = ac1Eligibility([row('2026-09-01T18:04:59.811Z'), row('2026-09-01T23:48:16.025Z')]);
  check(
    'live-boot-2026-09-01',
    !live.eligible && near(live.rthHours, 1.917, 0.01),
    `the 18:04:59Z boot carries ${live.rthHours.toFixed(2)} RTH-h by the close — NOT gradeable`,
  );

  const failed = results.filter(r => !r.ok);
  console.log(`\n[tra4158] ${results.length - failed.length}/${results.length} controls green`);
  return failed.length === 0;
}

async function fetchEvents(serviceId, key, pages = 6) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < pages; i += 1) {
    const url =
      `https://api.render.com/v1/services/${serviceId}/events?limit=100` + (cursor ? `&cursor=${cursor}` : '');
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    for (const row of page) out.push(row.event);
    cursor = page[page.length - 1]?.cursor ?? '';
    if (!cursor) break;
  }
  // The API pages newest-first and pages can overlap at the seam.
  const seen = new Set();
  return out.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

async function main() {
  if (flag('selftest')) {
    process.exit(selftest() ? 0 : 1);
  }

  if (flag('help') || (!flag('once') && !flag('report') && !flag('restarts') && !flag('deaths'))) {
    console.log(
      'usage: tra4158-heap-series.mjs (--once | --report | --restarts | --deaths | --selftest) [--tape=<path>] [--base=<url>]\n' +
        '       --restarts [--since=<iso>] [--pages=<n>]  needs RENDER_API_KEY (+ RENDER_SERVICE_ID or --service=)\n' +
        '       --deaths   [--since=<iso>] [--owner=<id>] partition deaths by mode; needs the same, plus an owner id\n' +
        '       --selftest                               controls for the RTH ruler and the AC1 eligibility gate',
    );
    process.exit(2);
  }

  if (flag('deaths')) {
    const key = process.env.RENDER_API_KEY;
    const serviceId = arg('service', process.env.RENDER_SERVICE_ID);
    const since = arg('since', '') || new Date(Date.now() - 7 * 86_400_000).toISOString();
    if (!key || !serviceId) {
      console.error('[tra4158] BLIND — RENDER_API_KEY and RENDER_SERVICE_ID (or --service=) are required');
      process.exit(3);
    }
    try {
      // The logs API rejects a query with no ownerId (HTTP 400), and the owner is
      // not derivable from the service id, so resolve it rather than hard-code it.
      let ownerId = arg('owner', process.env.RENDER_OWNER_ID ?? '');
      if (!ownerId) {
        const res = await fetch('https://api.render.com/v1/owners?limit=1', {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`owners -> HTTP ${res.status}`);
        ownerId = (await res.json())?.[0]?.owner?.id ?? '';
        if (!ownerId) throw new Error('could not resolve a Render owner id — pass --owner=');
      }
      reportDeaths(await fetchBootClassifications(serviceId, key, ownerId, since), since);
    } catch (err) {
      console.error(`[tra4158] BLIND — ${err instanceof Error ? err.message : String(err)}`);
      process.exit(3);
    }
  }

  if (flag('restarts')) {
    const key = process.env.RENDER_API_KEY;
    const serviceId = arg('service', process.env.RENDER_SERVICE_ID);
    if (!key || !serviceId) {
      // BLIND, not OK: "no crashes found" and "could not ask" must not share an
      // exit code — this whole mode exists to grade an absence.
      console.error('[tra4158] BLIND — RENDER_API_KEY and RENDER_SERVICE_ID (or --service=) are required');
      process.exit(3);
    }
    try {
      const events = await fetchEvents(serviceId, key, Number(arg('pages', '6')));
      reportRestarts(events, arg('since', ''));
    } catch (err) {
      console.error(`[tra4158] BLIND — ${err instanceof Error ? err.message : String(err)}`);
      process.exit(3);
    }
  }

  const tapePath = resolve(arg('tape', DEFAULT_TAPE));
  const base = arg('base', DEFAULT_BASE).replace(/\/$/, '');

  if (flag('once')) {
    let row;
    try {
      row = await readOnce(base);
    } catch (err) {
      console.error(`[tra4158] BLIND — ${err instanceof Error ? err.message : String(err)}`);
      process.exit(3);
    }
    await mkdir(dirname(tapePath), { recursive: true });
    await appendFile(tapePath, `${JSON.stringify(row)}\n`, 'utf8');
    console.log(
      `[tra4158] appended ${row.atIso} pid ${row.pid} uptime ${round1((row.uptimeSec ?? 0) / 3600)}h ` +
        `heap ${row.heapUsedMB}MB (${row.heapPct}) rss ${row.rssMB}MB peakRss ${row.peakRssMB}MB ` +
        `gcMajor ${row.gcMajorCount}/${row.gcMajorMaxMs === null ? '?' : round1(row.gcMajorMaxMs)}ms max`,
    );
  }

  if (flag('report')) report(await loadTape(tapePath));
}

main().catch(err => {
  console.error(`[tra4158] BLIND — ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(3);
});
