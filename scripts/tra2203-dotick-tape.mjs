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

// The logs API rate-limits a long pagination walk. A full RTH session is ~30+
// pages and reliably trips a 429 partway through; the old behaviour was to
// exit(2) mid-walk, which is loud but throws away everything already paged and
// makes the deciding read un-runnable. Back off and retry instead — and keep
// failing closed on a non-retryable status.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchRetry(url, opts, label) {
  let waitMs = 5_000;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, opts);
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt <= 8) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : waitMs;
      process.stderr.write(`\n[tape] ${label} ${res.status} — backing off ${Math.round(pause / 1000)}s `
        + `(attempt ${attempt}/8)\n`);
      await sleep(pause);
      waitMs = Math.min(waitMs * 2, 60_000);
      continue;
    }
    return res;
  }
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
    const res = await fetchRetry(url, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
    }, 'logs API');
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

// ── Restart contamination (TRA-2205) ─────────────────────────────────────────
// Several doTick sinks are throttled off a `lastXAt` member that initialises to
// 0, so `Date.now() - 0 >= INTERVAL` is TRUE on the first tick of every process
// and they ALL fire at boot regardless of how wide their interval is. The worst
// is `sma200-scan` (4 h interval): it emits 5 fires — one per engine — inside
// ~35 s of every boot, up to 42.7 s each, then goes silent for four hours.
//
// A window that starts at a boot therefore measures the BOOT TRANSIENT and
// reports it as if it were the steady state. That is not hypothetical: TRA-2205
// opened on "sma200-scan is 72% of doTick", measured over 23 minutes that began
// 31 s after a deploy. Boot-excluded, over a warm window on the same process,
// sma200-scan's share is ZERO.
//
// So: find the boots, and always show the grade with them removed.
const BOOT_TRANSIENT_MS = 120_000;

async function pullBoots(from, to) {
  // Widen the left edge: a deploy that finished shortly BEFORE the window still
  // projects its transient INTO it.
  const since = new Date(new Date(from).getTime() - BOOT_TRANSIENT_MS).toISOString();
  const url = `${API}/services/${SERVICE_ID}/deploys?limit=50`;
  const res = await fetchRetry(url, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
  }, 'deploys API');
  if (!res.ok) {
    console.error(`[tape] deploys API ${res.status} — cannot detect restarts; `
      + 'grading WITHOUT boot exclusion. Treat a dominant sma200-scan with suspicion.');
    return null;
  }
  const body = await res.json();
  return body
    .map(e => e.deploy ?? e)
    // `finishedAt` is when the new process is serving — the boot instant.
    .filter(d => d.finishedAt && d.finishedAt >= since && d.finishedAt <= to)
    .map(d => ({ id: d.id, at: d.finishedAt, commit: (d.commit?.id ?? '').slice(0, 7),
                 trigger: d.trigger ?? d.details?.trigger ?? '?' }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
}

// ⛔ A DEPLOY IS NOT THE ONLY THING THAT BOOTS THIS PROCESS (TRA-2203, 07-24).
// The memory watchdog self-restarts on a sustained event-loop block (pm2
// relaunch, not a Render deploy), and `POST /api/admin/restart` does the same.
// NEITHER writes a deploy record — so a deploys-only boot detector reports
// "steady state ✓" over a window containing several boot transients.
// MEASURED on 2026-07-24 RTH: FIVE watchdog trips (5.8s / 14.4s / 13.5s / 12.8s
// / 12.7s event-loop blocks), of which only TWO left a deploy record. The other
// three were invisible to the check that exists to see exactly this.
// So pull the trip lines too, and union them into the boot set.
async function pullWatchdogRestarts(from, to) {
  const since = new Date(new Date(from).getTime() - BOOT_TRANSIENT_MS).toISOString();
  const url = `${API}/logs?ownerId=${OWNER_ID}&resource=${SERVICE_ID}`
    + `&text=${encodeURIComponent('self-restarting')}`
    + `&startTime=${encodeURIComponent(since)}&endTime=${encodeURIComponent(to)}&limit=100`;
  const res = await fetchRetry(url, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
  }, 'logs API (watchdog)');
  if (!res.ok) {
    console.error(`[tape] watchdog-trip probe ${res.status} — self-restarts NOT detected; `
      + 'boot exclusion covers deploys only.');
    return null;
  }
  const body = await res.json();
  // ⚠️ Each trip surfaces on MORE THAN ONE line (the trip itself, then the
  // relaunched process re-reporting it as `lastTrip`), so the raw line count
  // over-counts restarts. Do NOT dedup on the `max lag NNNNms` value: two
  // genuinely distinct restarts 16 min apart carried the SAME lag on 07-24
  // (the second line was the new process echoing the previous trip), so a
  // dedup-by-lag silently DELETES a real boot. Cluster by TIME instead — lines
  // within CLUSTER_MS are one restart; anything further apart is another.
  const CLUSTER_MS = 90_000;
  const lines = (body.logs ?? [])
    .map(l => {
      let rec;
      try { rec = JSON.parse(l.message); } catch { rec = { detail: String(l.message) }; }
      const detail = rec.detail ?? rec.msg ?? '';
      return { id: l.id, at: l.timestamp, lag: /max lag (\d+)ms/.exec(detail)?.[1] ?? '?' };
    })
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const out = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && new Date(l.at).getTime() - new Date(last.at).getTime() <= CLUSTER_MS) continue;
    out.push({ id: l.id, at: l.at, commit: 'watchdog', trigger: `self-restart lag=${l.lag}ms` });
  }
  return out;
}

// Is the checkExits hoist ARMED? Decides whether the parent-doTick hourly table
// is an exit-latency curve or merely a tick-cost curve. Unauth route.
async function pullExitArm() {
  try {
    const res = await fetch('https://tradingai-bqb1.onrender.com/api/health/exit-cadence',
      { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const b = await res.json();
    const modes = [...new Set((b.engines ?? []).map(e => e.mode))].sort();
    return {
      enabled: !!b.enabled,
      engineCount: b.engineCount ?? 0,
      armedEngineCount: b.armedEngineCount ?? 0,
      modes: modes.length ? `mode=${modes.join('+')}` : 'mode unknown',
      p99Under30s: b.p99Under30s ?? null,
      maxExitIntervalMs: b.maxExitIntervalMs ?? null,
    };
  } catch { return null; }
}

const inBootWindow = (ts, boots) => boots.some(b => {
  const d = new Date(ts).getTime() - new Date(b.at).getTime();
  return d >= 0 && d <= BOOT_TRANSIENT_MS;
});

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

// Grade a record set by the GLOBAL ratio. Returns null when the set carries no
// parent records (no denominator) — the caller decides whether that is fatal.
function grade(recs) {
  const byPhase = new Map();
  for (const r of recs) {
    if (!byPhase.has(r.phase)) byPhase.set(r.phase, []);
    byPhase.get(r.phase).push(r.durationMs);
  }
  const parent = byPhase.get(PARENT) ?? [];
  if (!parent.length) return null;
  const parentSum = sum(parent);
  const subs = [...byPhase.entries()]
    .filter(([k]) => k !== PARENT && k.startsWith(`${PARENT}.`))
    .map(([k, v]) => ({ phase: k, ...stats(v), share: (sum(v) / parentSum) * 100 }))
    .sort((a, b) => b.sumS - a.sumS);
  const namedSum = sum(subs.map(s => s.sumS));
  return {
    byPhase, subs,
    p: stats(parent),
    residual: 100 - (namedSum / (parentSum / 1000)) * 100,
  };
}

(async () => {
  console.error(`[tape] window ${FROM} -> ${TO}`);
  const recs = await pullTape(FROM, TO);
  if (!recs.length) {
    console.error('BLIND: zero phase-timing records in the window.');
    process.exit(3);
  }

  const arm = await pullExitArm();
  const deployBoots = await pullBoots(FROM, TO);
  const selfRestarts = await pullWatchdogRestarts(FROM, TO);
  // Union, then collapse anything within 90 s — a watchdog trip that ALSO
  // produced a deploy record (two of five did on 07-24) must count once.
  const boots = (deployBoots || selfRestarts)
    ? [...(deployBoots ?? []), ...(selfRestarts ?? [])]
        .sort((a, b) => (a.at < b.at ? -1 : 1))
        .filter((b, i, all) => i === 0
          || new Date(b.at).getTime() - new Date(all[i - 1].at).getTime() > 90_000)
    : null;
  const warmRecs = boots && boots.length
    ? recs.filter(r => !inBootWindow(r.ts, boots))
    : recs;

  const main = grade(recs);
  if (!main) {
    console.error(`BLIND: no '${PARENT}' records — cannot form a denominator.`);
    process.exit(3);
  }
  const { byPhase, subs, p, residual } = main;

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

  // Hourly parent buckets — this IS the exit-latency curve.
  const hourly = new Map();
  for (const r of recs) {
    if (r.phase !== PARENT) continue;
    const h = String(r.ts).slice(11, 13);
    if (!hourly.has(h)) hourly.set(h, []);
    hourly.get(h).push(r.durationMs);
  }

  const warm = warmRecs.length === recs.length ? null : grade(warmRecs);

  if (has('--json')) {
    console.log(JSON.stringify({
      window: { from: FROM, to: TO }, blind,
      exitHoistArm: arm ?? 'unreadable',
      parent: { phase: PARENT, ...p }, residualPct: residual, subs,
      hourly: [...hourly.entries()].sort().map(([h, v]) => ({ hourUTC: h, ...stats(v) })),
      restarts: boots ?? 'undetected',
      bootExcluded: warm
        ? { parent: { phase: PARENT, ...warm.p }, residualPct: warm.residual, subs: warm.subs }
        : null,
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
  // ⛔ THE PROXY IS SEVERED ON AN ARMED BUILD (TRA-2203, 07-24).
  // "doTick duration IS the exit-evaluation interval" held only because exits
  // ran INSIDE the tick and interval fires coalesced into it. TRA-2200 hoisted
  // checkExits onto its own timer; wherever that is ARMED, this table is a
  // tick-cost curve and NOT an exit-latency curve, and quoting it as one
  // understates a fixed book or overstates a healthy one. Read the arm state
  // and say which curve this is — never print the identity unconditionally.
  if (arm === null) {
    console.log('doTick by UTC hour  [arm state UNREADABLE — do NOT quote this as exit latency]:');
  } else if (arm.enabled && arm.armedEngineCount > 0) {
    console.log(`doTick by UTC hour — TICK-COST curve ONLY. The exit hoist is ARMED `
      + `(${arm.armedEngineCount}/${arm.engineCount} engines,`);
    console.log(`  ${arm.modes}), so exit latency for those engines is NOT this table — read it off`);
    console.log(`  /api/health/exit-cadence. It REMAINS the exit-latency curve for any UNARMED engine.`);
  } else {
    console.log('Exit-latency curve (parent doTick by UTC hour) — hoist DISARMED, so interval == tick duration:');
  }
  for (const [h, v] of [...hourly.entries()].sort()) {
    const s = stats(v);
    console.log(`  ${h}Z  n=${String(s.n).padStart(4)}  p50 ${s.p50.toFixed(1).padStart(6)}s  `
      + `p90 ${s.p90.toFixed(1).padStart(6)}s  max ${s.max.toFixed(1).padStart(6)}s`);
  }
  console.log('');
  console.log('Tail owners (weight max + p90, not sum — the tail is what delays a tick):');
  for (const s of [...subs].sort((a, b) => b.max - a.max).slice(0, 3)) {
    console.log(`  ${s.phase}  max ${s.max.toFixed(1)}s  p90 ${s.p90.toFixed(1)}s  share ${s.share.toFixed(1)}%`);
  }
  // ── Restart contamination (TRA-2205) ───────────────────────────────────────
  console.log('');
  if (boots === null) {
    console.log('RESTARTS: could not be read — the grade above may contain boot transients.');
  } else if (boots.length === 0) {
    console.log('RESTARTS: none in this window — the grade above is steady-state. ✓');
  } else {
    console.log(`RESTARTS: ${boots.length} boot(s) inside this window (deploys UNION watchdog`);
    console.log(`          self-restarts — a self-restart leaves NO deploy record). Every throttled`);
    console.log(`          sink fires on the first tick of a new process regardless of its`);
    console.log(`          interval, so the ${BOOT_TRANSIENT_MS / 1000}s after each boot is a TRANSIENT, not steady state:`);
    for (const b of boots) console.log(`            ${b.at}  ${b.commit || '???????'}  trigger=${b.trigger}`);
    const dropped = recs.length - warmRecs.length;
    console.log(`          ${dropped} of ${recs.length} phase records (${((dropped / recs.length) * 100).toFixed(1)}%) fall in a boot transient.`);
    console.log('');
    if (!warm) {
      console.log('  BOOT-EXCLUDED GRADE: no doTick records survive — this window is ALL boot.');
      console.log('  ⇒ it measures a restart, not a session. Do NOT quote its shares.');
    } else {
      console.log('  BOOT-EXCLUDED GRADE (the one to quote):');
      console.log(`    ${PARENT.padEnd(38)} n=${String(warm.p.n).padStart(5)}  sum ${warm.p.sumS.toFixed(1)}s  `
        + `p50 ${warm.p.p50.toFixed(1)}s  p90 ${warm.p.p90.toFixed(1)}s  max ${warm.p.max.toFixed(1)}s`);
      for (const s of warm.subs.slice(0, 6)) {
        console.log(`      ${s.phase.replace(`${PARENT}.`, '').padEnd(36)} `
          + `${s.share.toFixed(1).padStart(6)}%  max ${s.max.toFixed(1).padStart(6)}s  p90 ${s.p90.toFixed(1).padStart(6)}s`);
      }
      console.log(`      ${'UNATTRIBUTED'.padEnd(36)} ${warm.residual.toFixed(1).padStart(6)}%`);
      // Name the sinks whose share the boot transient inflated most.
      const moved = subs.map(s => {
        const w = warm.subs.find(x => x.phase === s.phase);
        return { phase: s.phase, from: s.share, to: w ? w.share : 0 };
      }).filter(m => m.from - m.to > 1).sort((a, b) => (b.from - b.to) - (a.from - a.to));
      if (moved.length) {
        console.log('');
        console.log('    Shares INFLATED by the boot transient (all-window -> boot-excluded):');
        for (const m of moved.slice(0, 4)) {
          console.log(`      ${m.phase.replace(`${PARENT}.`, '').padEnd(36)} `
            + `${m.from.toFixed(1)}%  ->  ${m.to.toFixed(1)}%`);
        }
      }
    }
  }

  console.log('');
  console.log('NOTE: shares are the GLOBAL ratio Sigma(sub)/Sigma(doTick). Per-tick containment');
  console.log('      is NOT computed and must not be — >=5 concurrent engines with no engine id');
  console.log('      on the phase record make it over-count by roughly the concurrency factor.');
})();
