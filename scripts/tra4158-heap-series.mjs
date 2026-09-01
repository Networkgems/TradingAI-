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
 *   --tape=<path>   default reports/tra4158-heap-series.jsonl
 *   --base=<url>    default https://tradingai-bqb1.onrender.com
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

async function main() {
  if (flag('help') || (!flag('once') && !flag('report'))) {
    console.log('usage: tra4158-heap-series.mjs (--once | --report) [--tape=<path>] [--base=<url>]');
    process.exit(2);
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
