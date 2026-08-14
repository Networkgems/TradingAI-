#!/usr/bin/env node
// tra3441-truncation-witness.mjs — AC-2 for TRA-3441.
//
// AC-1 (`cold-bar-scan` max <= 60s) is necessary and NOT sufficient. A sink can sit
// under its bar because the bound bit, or because the session was quiet — and those
// two worlds are indistinguishable from a percentile. The ticket pre-registered the
// discriminator: "a silent pass is a NO-RUN, not a PASS, until the bound is proven to
// have bitten". `runBudgetedSweep` emits exactly one positive witness on truncation
// (tick-sweep-budget.ts:382), tagged `sink: <mode>:cold-bar-scan`. This reads it.
//
// ── Why the controls are not decoration ──────────────────────────────────────────
// A `text=` query that returns zero lines is ambiguous between "the marker never
// fired" and "this query cannot see anything" (wrong window, wrong resource, expired
// key, the 429 that the tape script has to back off from). So a bare zero MUST NOT be
// reported as an answer. Two controls run against the SAME window and the SAME query
// shape, and a zero is only reported when both are green:
//
//   COVERAGE  — an unfiltered `&limit=5` read must return lines. Proves the window and
//               the resource are readable at all.
//   CONTAINMENT — the marker query is run WITHOUT the sink filter. This is the control
//               that must CONTAIN what it detects: it fires on the same log line, from
//               the same emit site, for sibling sinks (mtf-refresh, otm-scan, …). If it
//               returns lines and the sink-filtered read returns none, the zero is a
//               real fact about cold-bar-scan. If it ALSO returns none, this run is
//               BLIND on the marker as a class and reports exit 3, not a verdict.
//
// Exit codes:  0 WITNESSED (>=1 truncation for the sink) · 1 SILENT (controls green,
//              the bound never bit) · 2 usage · 3 BLIND (a control failed — HOLD)
const API = 'https://api.render.com/v1';
const SERVICE_ID = 'srv-d7mb7rr7uimc73ev0chg';
const MARKER = 'doTick sink truncated by its wall-clock budget';
const SINK_RE = /:cold-bar-scan/;

const argv = process.argv.slice(2);
const valOf = n => { const h = argv.find(a => a.startsWith(`${n}=`)); return h ? h.slice(n.length + 1) : undefined; };
const API_KEY = process.env.RENDER_API_KEY;
if (!API_KEY) { console.error('RENDER_API_KEY is required.'); process.exit(2); }

// Same guard the restart gate ships: the logs API HTTP 400s an instant with no
// SECONDS field, and that 400 would otherwise wear the costume of "nothing found".
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const from = valOf('--from'), to = valOf('--to');
for (const [flag, raw] of [['--from', from], ['--to', to]]) {
  if (!raw || !RFC3339.test(raw) || Number.isNaN(Date.parse(raw))) {
    console.error(`${flag} must be an RFC3339 instant WITH seconds, e.g. 2026-08-13T14:30:00Z`);
    console.error('  (a bare ...T14:30Z is HTTP 400 at the logs API -> every probe fails -> a false zero)');
    process.exit(2);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, label) {
  // The logs API 429s under the paging this window needs; the tape script backs off
  // and so must this, or a rate limit becomes a fake zero.
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' } });
    if (res.status === 429) { const w = 8000 * attempt; console.error(`[${label}] 429 — backing off ${w / 1000}s`); await sleep(w); continue; }
    if (!res.ok) return { ok: false, body: null, status: res.status };
    return { ok: true, body: await res.json(), status: res.status };
  }
  return { ok: false, body: null, status: 429 };
}

const logUrl = extra => `${API}/logs?ownerId=${OWNER}&resource=${SERVICE_ID}`
  + `&startTime=${encodeURIComponent(from)}&endTime=${encodeURIComponent(to)}${extra}`;

const svc = await get(`${API}/services/${SERVICE_ID}`, 'service');
const OWNER = svc.body?.ownerId;
if (!OWNER) { console.error('BLIND — could not resolve ownerId'); process.exit(3); }

// Paginate the marker read to exhaustion; a first page is not a population.
async function pullAll(extra, label) {
  const out = []; let endTime = to; let ok = true;
  for (let page = 1; page <= 40; page++) {
    const r = await get(logUrl(extra) + (page > 1 ? `&endTime=${encodeURIComponent(endTime)}` : ''), label);
    if (!r.ok) { ok = false; break; }
    const logs = r.body?.logs ?? [];
    out.push(...logs);
    if (!r.body?.hasMore || !r.body?.nextEndTime || logs.length === 0) break;
    endTime = r.body.nextEndTime;
  }
  return { ok, lines: out };
}

const coverage = await get(logUrl('&limit=5'), 'coverage');
const coverageLines = coverage.ok ? (coverage.body?.logs ?? []).length : 0;
const marker = await pullAll(`&text=${encodeURIComponent(MARKER)}&limit=100`, 'marker');

if (!coverage.ok || coverageLines === 0) {
  console.log(`BLIND — coverage control failed (ok=${coverage.ok} lines=${coverageLines}). HOLD the grade.`);
  process.exit(3);
}
if (!marker.ok) { console.log('BLIND — marker query failed mid-pagination. HOLD the grade.'); process.exit(3); }

const all = marker.lines;
const forSink = all.filter(l => SINK_RE.test(l.message ?? ''));
const bySink = new Map();
for (const l of all) {
  const m = /"sink":"([^"]+)"/.exec(l.message ?? '');
  const k = m ? m[1] : '(unparsed)';
  bySink.set(k, (bySink.get(k) ?? 0) + 1);
}

console.log(`TRA-3441 truncation witness  ${from} -> ${to}`);
console.log(`  coverage control (unfiltered &limit=5): ${coverageLines} line(s) -> window is readable ✓`);
console.log(`  containment control (marker, ALL sinks): ${all.length} line(s)`);
for (const [k, v] of [...bySink.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${k}  x${v}`);
console.log(`  cold-bar-scan truncations: ${forSink.length}`);
for (const l of forSink.slice(0, 8)) console.log(`      ${l.timestamp}  ${(l.message ?? '').slice(0, 300)}`);

if (forSink.length > 0) { console.log('\nAC-2 WITNESSED — the bound armed and BIT for cold-bar-scan.'); process.exit(0); }
if (all.length === 0) {
  console.log('\nBLIND on the marker as a class — the containment control returned nothing either,');
  console.log('so this cannot tell "cold-bar-scan never truncated" from "the marker is unreadable".');
  process.exit(3);
}
console.log('\nSILENT — controls green, marker fires for OTHER sinks, but never for cold-bar-scan.');
console.log('Per the ticket: a silent pass is a NO-RUN, not a PASS.');
process.exit(1);
