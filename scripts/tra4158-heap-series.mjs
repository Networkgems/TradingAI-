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
  for (const seg of segments) {
    const first = seg.rows[0];
    const last = seg.rows[seg.rows.length - 1];
    const peakHeap = Math.max(...seg.rows.map(r => r.heapUsedMB));
    const peakRss = Math.max(...seg.rows.map(r => r.rssMB));
    console.log(`boot ${seg.startedAt} pid ${seg.pid} commit ${seg.commit} — ${seg.rows.length} read(s)`);
    console.log('  atIso                     uptimeH  heapMB  heapPct   rssMB  peakRssMB  gcMajor  gcMajorMaxMs');
    for (const r of seg.rows) {
      const upH = r.uptimeSec === null ? '   ?  ' : (r.uptimeSec / 3600).toFixed(2).padStart(6);
      console.log(
        `  ${r.atIso}  ${upH}  ${String(r.heapUsedMB).padStart(6)}  ${String(r.heapPct ?? '?').padStart(6)}` +
          `  ${String(r.rssMB).padStart(6)}  ${String(r.peakRssMB).padStart(9)}` +
          `  ${String(r.gcMajorCount ?? '?').padStart(7)}  ${String(r.gcMajorMaxMs === null ? '?' : round1(r.gcMajorMaxMs)).padStart(12)}`,
      );
    }
    if (seg.rows.length >= 2) {
      const hours = (Date.parse(last.atIso) - Date.parse(first.atIso)) / 3_600_000;
      console.log(
        `  Δheap ${round1(last.heapUsedMB - first.heapUsedMB)}MB over ${round1(hours)}h` +
          ` · peak heap ${peakHeap}MB (${round1((peakHeap / (last.heapLimitMB || 1812)) * 100)}% of cap)` +
          ` · peak rss ${peakRss}MB`,
      );
    } else {
      console.log('  (single read in this boot — a delta needs two, and one across a restart is not one)');
    }
    console.log('');
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
        rows.push({ at, iso: msg.ts, mode: 'self-restart', reason: msg.reason ?? null, uptimeSecAtTrip: msg.uptimeSecAtTrip ?? null, rssMB: msg.rssMB ?? null });
      } else if (EXTERNAL_KILL_RE.test(msg.msg ?? '')) {
        rows.push({ at, iso: msg.ts, mode: 'external-kill', reason: null, uptimeSecAtTrip: msg.lastAliveUptimeSec ?? null, rssMB: msg.lastAliveRssMB ?? null });
      }
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

function reportDeaths(rows, sinceIso) {
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
  if (flag('help') || (!flag('once') && !flag('report') && !flag('restarts') && !flag('deaths'))) {
    console.log(
      'usage: tra4158-heap-series.mjs (--once | --report | --restarts | --deaths) [--tape=<path>] [--base=<url>]\n' +
        '       --restarts [--since=<iso>] [--pages=<n>]  needs RENDER_API_KEY (+ RENDER_SERVICE_ID or --service=)\n' +
        '       --deaths   [--since=<iso>] [--owner=<id>] partition deaths by mode; needs the same, plus an owner id',
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
