#!/usr/bin/env node
// TRA-3052 — pull today's bqb1 server log tail for `component: 'stale-working-exit'`.
//
// WHY THIS EXISTS
// ---------------
// `withdrawStaleWorkingExit` guard 1 (`signal-engine.ts:6989` on the graded build
// `7a53176`) leaves a PARTIALLY FILLED working exit alone and returns without
// touching `cleared` or `held`. From outside that presents as
// `aged latch + cleared:0 + held:0` — byte-for-byte the pre-fix TRA-2956
// signature. On build `7a53176` NOTHING on the wire carries `exec_quantity`
// (verified by call graph; `OptionPendingExit` has no fill accounting, and
// `/api/health/execution-quality`'s `partialFills{}` only ever sees the maker
// walk, never a staged exit). So the server log is the ONLY discriminator.
//
// FAIL-CLOSED — THE POINT OF THE CONTROL QUERY
// --------------------------------------------
// An empty result has two causes that mean opposite things:
//   • the log stream was reachable and no guard-1 event occurred  → REAL zero
//   • the query, auth, or stream was blind                        → UNMEASURED
// Reading the second as the first is exactly the trap that makes a false red
// look confirmed. So every run also issues an UNFILTERED control query over the
// same window. Zero matches is only reported as a real zero when the control
// proves the stream was alive. Otherwise the verdict is UNMEASURED and the
// exit code is non-zero.
//
// Usage:
//   RENDER_API_KEY=… node scripts/tra3052-stale-exit-tail.mjs [--start=ISO] [--end=ISO] [--json]

const API = 'https://api.render.com/v1';
const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const asJson = argv.includes('--json');
// `--match=` exists so the rendering path can be self-tested against a component
// that is actually chatty. A puller only ever exercised on an empty result is a
// puller nobody has proven can print a line.
const MATCH = arg('match') ?? 'stale-working-exit';

if (!KEY) {
  console.error('FATAL: RENDER_API_KEY is not set. Refusing to report a zero we did not measure.');
  process.exit(3);
}

// Default window: today's RTH in UTC (13:30–20:00Z), clamped to now.
const now = new Date();
const day = now.toISOString().slice(0, 10);
const start = arg('start') ?? `${day}T13:25:00Z`;
const endRaw = arg('end') ?? `${day}T20:05:00Z`;
const end = new Date(endRaw) > now ? now.toISOString() : endRaw;

async function fetchPage(startTime, endTime, text) {
  const u = new URL(`${API}/logs`);
  u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('resource', SERVICE);
  u.searchParams.set('startTime', startTime);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', '100');
  if (text) u.searchParams.set('text', text);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Page backwards through the window. Render returns nextStartTime/nextEndTime
// with nextEndTime walking earlier; stop when it stops advancing so a server
// that pins the cursor cannot spin us forever.
async function fetchAll(text, cap = 40) {
  const out = [];
  let s = start;
  let e = end;
  for (let i = 0; i < cap; i++) {
    const page = await fetchPage(s, e, text);
    out.push(...(page.logs ?? []));
    if (!page.hasMore || !page.nextEndTime) break;
    if (page.nextEndTime === e) break;
    e = page.nextEndTime;
    if (page.nextStartTime) s = page.nextStartTime;
  }
  return out;
}

const decode = (l) => {
  try {
    return JSON.parse(l.message);
  } catch {
    return null;
  }
};

let matched, control, err = null;
try {
  matched = await fetchAll(MATCH);
  control = await fetchAll(null, 1); // one page is enough to prove liveness
} catch (e) {
  err = e;
}

if (err) {
  console.error(`QUERY FAILED: ${err.message}`);
  console.error('VERDICT: UNMEASURED — the log stream was not readable. This is NOT evidence of zero.');
  process.exit(3);
}

// Dedupe + sort ascending by real timestamp.
const seen = new Set();
const rows = matched
  .filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
  .map((l) => ({ raw: l, rec: decode(l) }))
  .filter((x) => x.rec && x.rec.component === MATCH)
  .sort((a, b) => (a.rec.ts < b.rec.ts ? -1 : 1));

const streamAlive = control.length > 0;

console.log(`window      : ${start}  ->  ${end}`);
console.log(`service     : ${SERVICE}`);
console.log(`control hits: ${control.length} (proves the log stream was readable)`);
console.log(`matched     : ${rows.length} line(s) with component='${MATCH}'`);
console.log('');

if (rows.length === 0) {
  if (!streamAlive) {
    console.log('VERDICT: UNMEASURED');
    console.log('  The control query also returned nothing, so the stream was blind over this');
    console.log('  window. A zero here is not a real zero. Do NOT read this as "no partial fill".');
    process.exit(3);
  }
  console.log('VERDICT: REAL ZERO — stream was alive, no stale-working-exit line was emitted.');
  console.log('  Guard 1 never fired. An aged latch in this window is NOT a partial fill.');
  process.exit(0);
}

const tally = {};
for (const { rec } of rows) {
  const k =
    typeof rec.execQuantity === 'number' && rec.execQuantity > 0
      ? 'guard1_partialFill'
      : /WITHDRAWN/.test(rec.msg)
        ? 'cleared'
        : /THREW/.test(rec.msg)
          ? 'withdrawFailed_threw'
          : /NOT CONFIRMED/.test(rec.msg)
            ? 'withdrawFailed_unconfirmed'
            : /live client vanished/.test(rec.msg)
              ? 'clientUnavailable'
              : 'other';
  tally[k] = (tally[k] ?? 0) + 1;
}

console.log('OUTCOME TALLY');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
console.log('');
console.log('LINES (ascending)');
for (const { rec } of rows) {
  const bits = [
    rec.ts,
    `[${rec.level}]`,
    rec.mode ?? '?',
    rec.optionSymbol ?? '?',
    `qty=${rec.qty ?? '?'}`,
    `age=${rec.ageMinutes ?? '?'}m`,
    `order=${rec.order ?? '?'}`,
  ];
  if (rec.execQuantity !== undefined) bits.push(`execQuantity=${rec.execQuantity}`);
  if (rec.execQuantityAfterCancel !== undefined) bits.push(`execQtyAfterCancel=${rec.execQuantityAfterCancel}`);
  if (rec.statusAfterCancel !== undefined) bits.push(`statusAfterCancel=${rec.statusAfterCancel}`);
  console.log(`  ${bits.join('  ')}`);
  console.log(`      ${rec.msg}`);
}

console.log('');
const g1 = tally.guard1_partialFill ?? 0;
if (g1 > 0) {
  console.log(`VERDICT: GUARD-1 PARTIAL FILL PRESENT (${g1} line(s), execQuantity > 0).`);
  console.log('  An aged latch with cleared:0 / held:0 is the fix DECLINING CORRECTLY, not a regression.');
} else {
  console.log('VERDICT: NO GUARD-1 PARTIAL FILL — stale-working-exit ran, but never on a partially filled order.');
  console.log('  The guard-1 alternative to a FAIL_PRE_FIX is ruled OUT for this window.');
}

if (asJson) {
  console.log('\nTRA3052_JSON ' + JSON.stringify({
    window: { start, end },
    controlHits: control.length,
    matched: rows.length,
    tally,
    guard1PartialFill: g1,
    verdict: g1 > 0 ? 'GUARD1_PARTIAL_FILL_PRESENT' : 'NO_GUARD1_PARTIAL_FILL',
    lines: rows.map((r) => r.rec),
  }));
}
