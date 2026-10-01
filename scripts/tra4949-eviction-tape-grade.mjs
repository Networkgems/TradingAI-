#!/usr/bin/env node
/**
 * TRA-4949 AC4 (carried over from TRA-4898 AC3) — grade the eviction that the
 * `tape/` overage made CERTAIN at the next market-day boundary.
 *
 * On 2026-09-28 bqb1's `tape/` pool stood at 20,497,082 B against a 16,777,216 B
 * cap (122.2%, over by 3,719,866 B). The pool is only reclaimed by the next
 * market day's first EOD write, so that write HAD to evict. This reads the
 * Render tape for it and asserts three things about the eviction:
 *
 *   1. `evictedFrom` names `book`/`root`/`mode` on every entry (TRA-4898's
 *      attribution — a pool-level count cannot answer whose session went).
 *   2. `prunedLive: 0` — there was ~20.1 MiB of non-live against a 3.7 MiB
 *      overage, so the real-money reservation had no reason to be exhausted.
 *   3. NO `TRA-4898 a REAL-MONEY (live) ledger file was evicted` line anywhere
 *      in the window.
 *
 * ⚠️ RENDER ENCODES ZERO MATCHES AND A WRONG `resource=` IDENTICALLY — both are
 * `logs: null`. So every verdict here is fenced by three controls, and a control
 * that fails exits BLIND (3) rather than reporting a zero it cannot distinguish
 * from a misaddressed query:
 *
 *   C1 retention  — the window starts inside the 7-day floor.
 *   C2 unfiltered — a bare pull over the window returns lines at all.
 *   C3 needles    — a needle LIFTED FROM INSIDE the window matches, and an
 *                   impossible needle returns 0. One without the other proves
 *                   nothing: a positive alone cannot rule out a filter that
 *                   matches everything, and a negative alone cannot rule out a
 *                   query that matches nothing.
 *
 * Exit: 0 PASS · 1 FAIL (a real defect in the eviction) · 2 usage · 3 BLIND.
 * BLIND > FAIL > PASS — "could not check" and "checked and it is fine" must
 * never share an exit code.
 *
 * Usage:
 *   RENDER_API_KEY=… node scripts/tra4949-eviction-tape-grade.mjs \
 *     [--start=2026-09-29T00:30:00Z] [--end=2026-09-29T02:30:00Z] [--json]
 */

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
// `/v1/logs` REQUIRES `ownerId` — it answers `400 {"message":"ownerId is
// required"}` without it, which is at least a loud failure rather than the
// `logs: null` every other addressing mistake collapses into.
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
const RETENTION_DAYS = 7;

const EVICTION_NEEDLE = 'TRA-4156 per-directory ledger budget exceeded';
const LIVE_EVICTION_NEEDLE = 'a REAL-MONEY (live) ledger file was evicted';
/** Cannot occur: no code path emits it. C3's negative arm. */
const IMPOSSIBLE_NEEDLE = 'TRA-0000 zzz-this-string-is-not-in-any-log-line-zzz';

if (!KEY) {
  console.error('BLIND: no RENDER_API_KEY — this is a HOLD, not a pass');
  process.exit(3);
}

// ── args ─────────────────────────────────────────────────────────────────────
// Match NEGATIVELY (TRA-4420): an unrecognised token is an error, never a silent
// default, or the run grades a window the operator did not ask for.
const args = new Map();
for (const raw of process.argv.slice(2)) {
  if (raw === '--json') { args.set('json', '1'); continue; }
  const m = /^--([a-z-]+)=(.*)$/.exec(raw);
  if (!m) {
    console.error(`unrecognised argument: ${raw} (values attach with "=")`);
    process.exit(2);
  }
  args.set(m[1], m[2]);
}

// Default window: the 2026-09-29T01:00Z boundary named in TRA-4949 AC4, with an
// hour either side so a late fan-out is still inside it.
const START = args.get('start') ?? '2026-09-29T00:30:00Z';
const END = args.get('end') ?? '2026-09-29T02:30:00Z';
for (const [label, v] of [['start', START], ['end', END]]) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) {
    console.error(`--${label} must be an ISO instant WITH SECONDS and a trailing Z (got ${v})`);
    process.exit(2);
  }
}
if (!(START < END)) {
  console.error(`--start must precede --end (got ${START} .. ${END})`);
  process.exit(2);
}

function blind(msg) {
  console.error(`BLIND: ${msg}`);
  process.exit(3);
}

async function pull({ text = null, limit = 200, startTime, endTime }) {
  const u = new URL('https://api.render.com/v1/logs');
  // `resource` is SINGULAR; `resources=` is a different, wrong param that
  // returns the same `logs: null` a zero-match query does.
  u.searchParams.set('resource', SERVICE);
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', startTime);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('direction', 'forward');
  if (text !== null) u.searchParams.set('text', text);
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(u, {
      headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
    });
    if (r.ok) {
      const j = await r.json();
      // `logs: null` is Render's zero. Anything else non-array is a shape change
      // we must not silently read as zero.
      if (j.logs !== null && !Array.isArray(j.logs)) {
        throw new Error(`logs field is neither null nor an array (${typeof j.logs})`);
      }
      return { lines: j.logs ?? [], hasMore: j.hasMore === true };
    }
    // Loki 502/503s on wide spans; an aborted read is an UNDERCOUNT, not a zero.
    if (![429, 502, 503].includes(r.status)) {
      throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
  }
  throw new Error('exhausted retries against the logs API');
}

const nowMs = Date.now();
const problems = [];
const out = { window: { start: START, end: END }, service: SERVICE, controls: {}, findings: {} };

// ── C1 retention ─────────────────────────────────────────────────────────────
const retentionFloor = new Date(nowMs - RETENTION_DAYS * 864e5).toISOString();
const insideRetention = START > retentionFloor;
out.controls.retention = { floor: retentionFloor, pass: insideRetention };
console.log(`C1 retention   : start=${START} floor=${retentionFloor} -> ${insideRetention ? 'PASS' : 'FAIL'}`);
if (!insideRetention) {
  blind(`window starts before the ${RETENTION_DAYS}-day retention floor; it would truncate SILENTLY as logs:null`);
}

// Slice into <=6h chunks — Loki 502s on multi-day spans.
const slices = [];
for (let t = new Date(START); t < new Date(END); ) {
  const next = new Date(Math.min(t.getTime() + 6 * 36e5, new Date(END).getTime()));
  slices.push([
    t.toISOString().replace(/\.\d+Z$/, 'Z'),
    next.toISOString().replace(/\.\d+Z$/, 'Z'),
  ]);
  t = next;
}

let bareLines = [];
try {
  for (const [s, e] of slices) {
    const bare = await pull({ startTime: s, endTime: e, limit: 50 });
    bareLines.push(...bare.lines);
  }
} catch (err) {
  blind(`unfiltered pull threw: ${err.message}`);
}

// ── C2 unfiltered ────────────────────────────────────────────────────────────
out.controls.unfiltered = { lines: bareLines.length, pass: bareLines.length > 0 };
console.log(`C2 unfiltered  : ${bareLines.length} line(s) over the window -> ${bareLines.length > 0 ? 'PASS' : 'FAIL'}`);
if (bareLines.length === 0) {
  blind('an unfiltered pull over this window returned NOTHING — the service/window addressing is wrong, or the box was dark; either way a filtered zero below would be unreadable');
}

// ── C3 needles ───────────────────────────────────────────────────────────────
// The positive needle is LIFTED FROM INSIDE the window: a token off a line the
// unfiltered pull just returned. A needle chosen a priori could be absent for
// honest reasons and would collapse into the same `logs: null`.
const sample = bareLines.map((l) => String(l.message ?? '')).find((m) => m.length > 24);
if (!sample) blind('no unfiltered line long enough to lift a positive needle from');
const liftedTokens = sample.match(/[A-Za-z][A-Za-z0-9_-]{5,}/g) ?? [];
const lifted = liftedTokens.find((t) => t.length >= 6);
if (!lifted) blind(`could not lift a needle token out of the sampled line: ${sample.slice(0, 120)}`);

let liftedHits = 0;
let impossibleHits = 0;
try {
  for (const [s, e] of slices) {
    liftedHits += (await pull({ text: lifted, startTime: s, endTime: e, limit: 5 })).lines.length;
    impossibleHits += (await pull({ text: IMPOSSIBLE_NEEDLE, startTime: s, endTime: e, limit: 5 })).lines.length;
  }
} catch (err) {
  blind(`needle controls threw: ${err.message}`);
}
const needlesPass = liftedHits > 0 && impossibleHits === 0;
out.controls.needles = { lifted, liftedHits, impossibleHits, pass: needlesPass };
console.log(`C3 needles     : lifted="${lifted}" -> ${liftedHits} hit(s); impossible -> ${impossibleHits} hit(s) -> ${needlesPass ? 'PASS' : 'FAIL'}`);
if (!needlesPass) {
  blind(`the text filter is not discriminating (lifted=${liftedHits}, impossible=${impossibleHits}); a filtered zero below would be meaningless`);
}

// ── the subject ──────────────────────────────────────────────────────────────
let evictionLines = [];
let liveLines = [];
let truncated = false;
try {
  for (const [s, e] of slices) {
    const ev = await pull({ text: EVICTION_NEEDLE, startTime: s, endTime: e, limit: 200 });
    if (ev.hasMore) truncated = true;
    evictionLines.push(...ev.lines);
    const lv = await pull({ text: LIVE_EVICTION_NEEDLE, startTime: s, endTime: e, limit: 200 });
    if (lv.hasMore) truncated = true;
    liveLines.push(...lv.lines);
  }
} catch (err) {
  blind(`subject pull threw: ${err.message}`);
}
if (truncated) blind('the subject pull reported hasMore — the reading is an UNDERCOUNT, not a census');

/** Pull the JSON object out of a structured log line, if it is one. */
function parseMeta(raw) {
  const s = String(raw ?? '');
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

const evictions = evictionLines.map((l) => ({
  ts: l.timestamp,
  raw: String(l.message ?? ''),
  meta: parseMeta(l.message),
}));

out.findings.evictionLines = evictions.length;
out.findings.liveEvictionLines = liveLines.length;
console.log(`\nSUBJECT        : ${evictions.length} eviction line(s), ${liveLines.length} real-money line(s)`);

if (evictions.length === 0) {
  // NOT a pass and NOT blind: the controls above prove the read works, so this
  // is a real, readable fact — the certain eviction did not happen. Either the
  // boundary did not run, or something reclaimed the overage first. Both are
  // findings, and both belong to a human.
  problems.push(
    `no "${EVICTION_NEEDLE}" line in ${START}..${END}, but the controls all PASS. ` +
    'A 3.72 MiB overage against a 16 MiB cap made an eviction certain at this boundary, ' +
    'so either the boundary did not run or the overage was reclaimed by some other path.',
  );
}

// 1 — attribution: every entry names book/root/mode.
for (const e of evictions) {
  const from = e.meta?.evictedFrom;
  if (!Array.isArray(from)) {
    problems.push(`${e.ts} dir=${e.meta?.dir ?? '?'}: evictedFrom is absent or not an array`);
    continue;
  }
  if (from.length === 0 && (e.meta?.prunedForAggregate ?? 0) > 0) {
    problems.push(`${e.ts} dir=${e.meta?.dir}: pruned ${e.meta.prunedForAggregate} file(s) with an EMPTY evictedFrom`);
  }
  for (const entry of from) {
    for (const k of ['book', 'root', 'mode']) {
      if (typeof entry?.[k] !== 'string' || entry[k].length === 0) {
        problems.push(`${e.ts} dir=${e.meta?.dir}: an evictedFrom entry is missing "${k}" (${JSON.stringify(entry).slice(0, 160)})`);
      }
    }
  }
}

// 2 — prunedLive: 0 on every line.
for (const e of evictions) {
  const pl = e.meta?.prunedLive;
  if (pl === undefined) {
    problems.push(`${e.ts} dir=${e.meta?.dir ?? '?'}: prunedLive is ABSENT (an unstamped 0 is not a measured 0)`);
  } else if (pl !== 0) {
    problems.push(`${e.ts} dir=${e.meta?.dir}: prunedLive=${pl} — the real-money reservation was EXHAUSTED`);
  }
}

// 3 — no real-money eviction line at all.
if (liveLines.length > 0) {
  problems.push(
    `${liveLines.length} "TRA-4898 a REAL-MONEY (live) ledger file was evicted" line(s) in the window: ` +
    liveLines.map((l) => l.timestamp).join(', '),
  );
}

// Informational: TRA-4949's own new fields, when the window postdates the fix.
const triggers = evictions.map((e) => e.meta?.sweepTrigger).filter(Boolean);
out.findings.sweepTriggers = triggers;
if (triggers.length > 0) {
  console.log(`sweepTrigger   : ${triggers.join(', ')}`);
} else {
  console.log('sweepTrigger   : absent on every line — this window PREDATES the TRA-4949 deploy (informational, not graded)');
}

for (const e of evictions) {
  const m = e.meta ?? {};
  console.log(
    `  ${e.ts} dir=${m.dir} pruned=${m.prunedForAggregate} prunedLive=${m.prunedLive} ` +
    `bytesAfter=${m.bytesAfter}/${m.maxBytes} books=${m.evictedFromBooks} omitted=${m.evictedFromOmitted} ` +
    `liveInPool=${m.liveFilesInPool}`,
  );
}

if (args.has('json')) console.log(`\n${JSON.stringify({ ...out, problems }, null, 2)}`);

if (problems.length > 0) {
  console.error(`\nFAIL (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nPASS — eviction attributed per book/root/mode, prunedLive 0, no real-money eviction.');
process.exit(0);
