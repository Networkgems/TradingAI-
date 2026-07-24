#!/usr/bin/env node
// tra2203-dotick-tape.mjs — TRA-2203 / TRA-2171
//
// Read an RTH session's `signal.doTick` phase tape off the Render logs API and
// grade which awaited sink owns the tick, so the phase-2 bound is picked from a
// measurement instead of a guess.
//
// ── Why this is a script and not a shell pipeline ─────────────────────────────
// The Thursday 2026-07-23 read was done ad hoc and hit three traps that are easy
// to hit again and hard to notice. All three are handled here:
//
//   1. GRADE BY GLOBAL RATIO, NEVER BY PER-TICK CONTAINMENT. bqb1 runs AT LEAST
//      FIVE engines concurrently and the phase log line carries no engine/
//      correlation id, so "which sub-phase spans sit inside this tick's span"
//      vacuums up the other engines' sub-phases. On Thursday that produced
//      shares of 192% / 266% / 297% on the largest ticks — arithmetically
//      impossible.
//        The count was "THREE" here until TRA-2205 measured it. `sma200-scan`
//      stamps its throttle BEFORE awaiting, so one engine can fire it at most
//      once per SMA200_SCAN_INTERVAL_MS (4 h) — yet every process boot emits
//      EXACTLY FIVE fires inside ~35 s (four independent boots, 2026-07-23
//      23:17Z / 23:27Z / 23:29Z and 07-24 00:15Z, same duration signature each
//      time). n fires in one throttle window is a lower bound on n engines.
//      ⇒ the per-tick over-count factor is ~5, not ~3. The global ratio is
//      immune to the count either way, which is exactly why it is the only
//      thing this script computes — but do not quote "three" downstream.
//      Sigma(sub) / Sigma(doTick) is contamination-free because every engine's
//      seconds land in BOTH numerator and denominator. This script only ever
//      computes the global ratio, and refuses to emit a per-tick attribution.
//
//   2. PAGINATE TO EXHAUSTION. The API caps a page and walks backwards via
//      `nextEndTime`. Stopping at the first page silently truncates the tape,
//      and the truncation looks exactly like a quiet session.
//
//   3. PARSE THE MESSAGE JSON, DO NOT GREP IT (TRA-1894). Each log line's
//      `message` is a JSON document; `phase` and `durationMs` are read as fields.
//
// ── The blindness check ──────────────────────────────────────────────────────
// A collector that silently records nothing is worse than no collector: it looks
// like an instrument right up until you need it. Before grading, this script
// asserts the labels it EXPECTS to exist are actually present in the tape, and
// exits 3 (BLIND) if the headline sink is missing — that means the build under
// measurement predates the label, so the "unattributed %" would be a fact about
// the instrument, not about the system. It never prints a verdict in that case.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   RENDER_API_KEY=rnd_… node scripts/tra2203-dotick-tape.mjs \
//     --from=2026-07-24T13:30:00Z --to=2026-07-24T20:05:00Z
//
//   --from / --to   window, ISO8601. Default: today's RTH (13:30–20:05Z).
//   --json          emit the grade as JSON instead of a table.
//   --allow-blind   grade anyway with the blindness caveat stamped on the output.
//
// ── Exit codes ───────────────────────────────────────────────────────────────
//   0  graded
//   2  usage / auth / API error
//   3  BLIND — the expected labels are absent from the tape; no verdict emitted

const API = 'https://api.render.com/v1';
const OWNER_ID = 'tea-d7macfog4nts73ai6p40';
const SERVICE_ID = 'srv-d7mb7rr7uimc73ev0chg';

// The coarse parent. Its wall duration IS the exit-evaluation interval: interval
// fires COALESCE into an in-flight tick (`if (this.tickRunning) return
// this.activeTick`), and checkExits runs once per tick — so this distribution is
// the exit-latency curve, not merely a tick-cost curve.
const PARENT = 'signal.doTick';

// TRA-2203 named the last unlabelled awaits. `quote-batch` is the blindness
// canary: it is the only UNCONDITIONAL whole-universe fan-out in the tick, so if
// the tape has doTick lines but no quote-batch lines, the build under measurement
// predates the label and the residual is an instrument artefact.
const CANARY = 'signal.doTick.quote-batch';

const argv = process.argv.slice(2);
const valOf = name => {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};
const has = f => argv.includes(f);

const API_KEY = process.env.RENDER_API_KEY;
if (!API_KEY) {
  console.error('RENDER_API_KEY is required.');
  process.exit(2);
}

function defaultWindow() {
  const d = new Date();
  const day = d.toISOString().slice(0, 10);
  return [`${day}T13:30:00Z`, `${day}T20:05:00Z`];
}
const [defFrom, defTo] = defaultWindow();
const FROM = valOf('--from') ?? defFrom;
const TO = valOf('--to') ?? defTo;

async function pullTape(from, to) {
  const seen = new Map();
  let endTime = to;
  let pages = 0;
  for (;;) {
    const url = `${API}/logs?ownerId=${OWNER_ID}&resource=${SERVICE_ID}`
      + `&text=${encodeURIComponent('slow async phase')}`
      + `&startTime=${encodeURIComponent(from)}&endTime=${encodeURIComponent(endTime)}&limit=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      console.error(`logs API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      process.exit(2);
    }
    const body = await res.json();
    const logs = body.logs ?? [];
    pages++;
    let fresh = 0;
    for (const l of logs) {
      if (seen.has(l.id)) continue;
      let rec;
      // TRA-1894 — PARSE the JSON, never grep it.
      try { rec = JSON.parse(l.message); } catch { continue; }
      if (rec.module !== 'phase-timing' || rec.kind !== 'async') continue;
      if (typeof rec.durationMs !== 'number' || typeof rec.phase !== 'string') continue;
      seen.set(l.id, { phase: rec.phase, durationMs: rec.durationMs, ts: rec.ts });
      fresh++;
    }
    process.stderr.write(`\r[tape] page ${pages}  records ${seen.size}   `);
    // Exhaustion: the API walks backwards via nextEndTime. Stop when it says so,
    // or when a page yields nothing new (a defensive stall guard — without it a
    // non-advancing cursor spins forever and looks like a hang).
    if (!body.hasMore || !body.nextEndTime || body.nextEndTime === endTime) break;
    if (logs.length === 0 || (fresh === 0 && pages > 1)) break;
    endTime = body.nextEndTime;
    if (pages > 2000) break;
  }
  process.stderr.write('\n');
  return [...seen.values()];
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const sum = a => a.reduce((x, y) => x + y, 0);
const f1 = n => (n / 1000).toFixed(1);

function stats(durs) {
  return {
    n: durs.length,
    sumS: sum(durs) / 1000,
    p50: pct(durs, 50) / 1000,
    p90: pct(durs, 90) / 1000,
    max: Math.max(0, ...durs) / 1000,
  };
}

(async () => {
  console.error(`[tape] window ${FROM} -> ${TO}`);
  const recs = await pullTape(FROM, TO);
  if (!recs.length) {
    console.error('BLIND: zero phase-timing records in the window.');
    process.exit(3);
  }

  const byPhase = new Map();
  for (const r of recs) {
    if (!byPhase.has(r.phase)) byPhase.set(r.phase, []);
    byPhase.get(r.phase).push(r.durationMs);
  }

  const parent = byPhase.get(PARENT) ?? [];
  if (!parent.length) {
    console.error(`BLIND: no '${PARENT}' records — cannot form a denominator.`);
    process.exit(3);
  }
  const parentSum = sum(parent);

  const blind = !byPhase.has(CANARY);
  if (blind && !has('--allow-blind')) {
    console.error('');
    console.error(`BLIND: '${CANARY}' is absent from the tape.`);
    console.error('  The build under measurement predates TRA-2203, so the');
    console.error('  unattributed residual would describe the INSTRUMENT, not the');
    console.error('  system. Re-run against a session on 834f4e9 or later, or pass');
    console.error('  --allow-blind to grade anyway with the caveat stamped on.');
    process.exit(3);
  }

  const subs = [...byPhase.entries()]
    .filter(([k]) => k !== PARENT && k.startsWith(`${PARENT}.`))
    .map(([k, v]) => ({ phase: k, ...stats(v), share: (sum(v) / parentSum) * 100 }))
    .sort((a, b) => b.sumS - a.sumS);

  const namedSum = sum(subs.map(s => s.sumS));
  const residual = 100 - (namedSum / (parentSum / 1000)) * 100;
  const p = stats(parent);

  // Hourly parent buckets — this IS the exit-latency curve.
  const hourly = new Map();
  for (const r of recs) {
    if (r.phase !== PARENT) continue;
    const h = String(r.ts).slice(11, 13);
    if (!hourly.has(h)) hourly.set(h, []);
    hourly.get(h).push(r.durationMs);
  }

  if (has('--json')) {
    console.log(JSON.stringify({
      window: { from: FROM, to: TO }, blind,
      parent: { phase: PARENT, ...p }, residualPct: residual, subs,
      hourly: [...hourly.entries()].sort().map(([h, v]) => ({ hourUTC: h, ...stats(v) })),
    }, null, 2));
    return;
  }

  console.log('');
  console.log(`doTick tape  ${FROM} -> ${TO}${blind ? '   [BLIND — pre-TRA-2203 build]' : ''}`);
  console.log('');
  console.log('phase                                     n        sum(s)   p50     p90     max     share');
  console.log('-'.repeat(96));
  console.log(`${PARENT.padEnd(40)} ${String(p.n).padStart(6)} ${f1(p.sumS * 1000).padStart(11)} `
    + `${p.p50.toFixed(1).padStart(7)} ${p.p90.toFixed(1).padStart(7)} ${p.max.toFixed(1).padStart(7)}   (denominator)`);
  for (const s of subs) {
    console.log(`  ${s.phase.replace(`${PARENT}.`, '').padEnd(38)} ${String(s.n).padStart(6)} `
      + `${f1(s.sumS * 1000).padStart(11)} ${s.p50.toFixed(1).padStart(7)} ${s.p90.toFixed(1).padStart(7)} `
      + `${s.max.toFixed(1).padStart(7)} ${s.share.toFixed(1).padStart(7)}%`);
  }
  console.log('-'.repeat(96));
  console.log(`  ${'UNATTRIBUTED'.padEnd(38)} ${''.padStart(6)} ${''.padStart(11)} `
    + `${''.padStart(7)} ${''.padStart(7)} ${''.padStart(7)} ${residual.toFixed(1).padStart(7)}%`);
  console.log('');
  console.log('Exit-latency curve (parent doTick by UTC hour) — interval == tick duration:');
  for (const [h, v] of [...hourly.entries()].sort()) {
    const s = stats(v);
    console.log(`  ${h}Z  n=${String(s.n).padStart(4)}  p50 ${s.p50.toFixed(1).padStart(6)}s  `
      + `p90 ${s.p90.toFixed(1).padStart(6)}s  max ${s.max.toFixed(1).padStart(6)}s`);
  }
  console.log('');
  console.log('Tail owners (weight max + p90, not sum — the tail is what delays exits):');
  for (const s of [...subs].sort((a, b) => b.max - a.max).slice(0, 3)) {
    console.log(`  ${s.phase}  max ${s.max.toFixed(1)}s  p90 ${s.p90.toFixed(1)}s  share ${s.share.toFixed(1)}%`);
  }
  console.log('');
  console.log('NOTE: shares are the GLOBAL ratio Sigma(sub)/Sigma(doTick). Per-tick containment');
  console.log('      is NOT computed and must not be — >=5 concurrent engines with no engine id');
  console.log('      on the phase record make it over-count by roughly the concurrency factor.');
})();
