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
//   --dump=FILE     write the raw {phase,durationMs,ts} records to FILE as JSON.
//                   The tape pull is ~60 pages and rate-limits partway through, so
//                   re-pulling the same closed window just to re-cut the numbers
//                   costs minutes and burns quota. Dump once, re-analyse offline.
//                   Records are pre-boot-exclusion; `boots` is dumped alongside so
//                   a downstream cut can apply the SAME exclusion this script does.
//
// ── Exit codes ───────────────────────────────────────────────────────────────
//   0  graded
//   2  usage / auth / API error
//   3  BLIND — the expected labels are absent from the tape; no verdict emitted

import { writeFileSync } from 'node:fs';
// TRA-2261 — the boot set is no longer this script's private business. The union
// (deploys ∪ container deaths ∪ watchdog boot echoes), its fail-closed contract
// and its line classifier live in ONE module so every "did the box restart?"
// consumer answers from the same sources. See scripts/lib/render-boot-set.mjs.
import { pullBootSet, formatBootSet } from './lib/render-boot-set.mjs';

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

// ⛔ A DEPLOY IS NOT THE ONLY THING THAT BOOTS THIS PROCESS, AND THIS SCRIPT NO
// LONGER OWNS THAT PROBLEM (TRA-2261). A watchdog self-restart is a pm2 relaunch
// and writes NO deploy record; `POST /api/admin/restart` takes the same path. The
// union of all three witnesses, the log-line classifier that separates a TRIP from
// a BOOT ECHO from a SUPPRESSED non-event, and the fail-closed contract now live in
// scripts/lib/render-boot-set.mjs, which is exercised by a discrimination suite
// against the verbatim 2026-07-24 API bytes.
//
// TWO THINGS THIS SWAP FIXES IN THIS SCRIPT SPECIFICALLY:
//   * the local version treated EVERY line matching `text=self-restarting` as a boot
//     candidate, so the 20:03:28Z `watchdog trip SUPPRESSED during boot grace` line —
//     which is the watchdog DECLINING to restart — was counted as a boot;
//   * it kept a deploys-only fallback when the log probe failed, which is the exact
//     fail-open the union exists to remove.

// Is the checkExits hoist ARMED? Decides whether the parent-doTick hourly table
// is an exit-latency curve or merely a tick-cost curve. Unauth route.
//
// ⛔ THIS IS A READ OF *NOW*, AND THE TAPE IS A READ OF *THEN*. The health route
// describes the process answering the request, which on a box that restarts ~6×
// a session is usually NOT the process that produced the window. Caught by the
// regression control: grading the 07-23 tape stamped it "hoist ARMED", which is
// flatly false — the arm landed 07-24 12:39Z. So carry `startedAt` and refuse to
// apply the arm state to a window the running process did not live through.
//
// ⛔⛔ TRA-2645 — AND IT USED TO READ THE *WRONG POPULATION*. This function read
// `b.enabled` / `b.armedEngineCount`, which were an OR and a SUM over a
// MIXED-MODE fleet: 57 armed demo engines plus the one `mode=live` book routed
// to production Tradier ***0154 published `enabled: true, armedEngineCount: 57`
// while the only engine that carries money read `timerArmed: false`. The branch
// below then printed "the exit hoist is ARMED" — fleet-wide arming reported as
// coverage — about a live book with no exit timer at all.
//
// The route is now partitioned by book (`partitionedBy: 'mode'`, `books.live` /
// `books.demo`) and there is no unscoped `enabled` left. This reads BOTH books
// and FAILS CLOSED on the marker's absence: a pre-TRA-2645 payload cannot answer
// the per-book question, and its pooled `enabled` must not be substituted for
// one.
async function pullExitArm() {
  try {
    const res = await fetch('https://tradingai-bqb1.onrender.com/api/health/exit-cadence',
      { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const b = await res.json();
    const modes = [...new Set((b.engines ?? []).map(e => e.mode))].sort();
    // FAIL CLOSED on a pre-TRA-2645 build. `partitionedBy` is absent there, and
    // so is `books`; the fields that DO exist are pooled across books and are
    // not this question's answer. `undefined` must not read as "fine".
    const partitioned = b.partitionedBy === 'mode' && b.books && typeof b.books === 'object';
    const live = partitioned ? b.books.live : null;
    const demo = partitioned ? b.books.demo : null;
    return {
      partitioned,
      // Per book, and NULL when that book is blind (not resident / unreadable
      // `mode` / non-boolean `timerArmed`). Null is "I cannot see it", which is
      // a different fact from `false` and must never be printed as one.
      liveEnabled: live ? live.enabled : null,
      liveVerdict: live ? live.verdict : null,
      liveBlind: live ? !!live.blind : null,
      liveBlindReason: live ? live.blindReason : null,
      liveArmedEngineCount: live ? live.armedEngineCount : null,
      liveEngineCount: b.liveEngineCount ?? null,
      liveGradeable: live ? live.gradeable : null,
      liveP99Under30s: live ? live.p99Under30s : null,
      demoEnabled: demo ? demo.enabled : null,
      demoVerdict: demo ? demo.verdict : null,
      demoBlind: demo ? !!demo.blind : null,
      demoArmedEngineCount: demo ? demo.armedEngineCount : null,
      demoEngineCount: b.demoEngineCount ?? null,
      demoGradeable: demo ? demo.gradeable : null,
      demoP99Under30s: demo ? demo.p99Under30s : null,
      unknownModeEngineCount: b.unknownModeEngineCount ?? null,
      engineCount: b.engineCount ?? 0,
      modes: modes.length ? `mode=${modes.join('+')}` : 'mode unknown',
      // TRA-2269 — `p99Under30s` is meaningless without the population it was
      // computed over and without the route's own refusal flag. `window` is
      // absent on any build before TRA-2269, and there it is a LIFETIME-scoped
      // ratio contaminated by closed-market intervals; carry it through
      // explicitly rather than letting `undefined` read as "fine".
      window: b.window ?? 'lifetime_pre_tra2269',
      partitionedBy: b.partitionedBy ?? 'pooled_pre_tra2645',
      maxExitIntervalMs: b.maxExitIntervalMs ?? null,
      // The instant this reading describes. Compared against the window below.
      readAt: b.time ?? null,
      startedAt: b.build?.startedAt ?? null,
    };
  } catch { return null; }
}

/** TRA-2645 — one book's arm state as a printable clause. Blind is never "disarmed". */
function armClause(book, enabled, armedCount, engineCount, verdict) {
  if (enabled === null || enabled === undefined) {
    return `${book}: UNREADABLE (verdict=${verdict ?? 'n/a'}) — NOT "disarmed"`;
  }
  return `${book}: ${enabled ? 'ARMED' : 'DISARMED'} (${armedCount}/${engineCount} engines, verdict=${verdict})`;
}

/**
 * TRA-2645 — WHICH CURVE IS THE hourly doTick table? Pure, exported and
 * controlled (`--selftest`) rather than inline, for the reason the whole ticket
 * exists: the branch it replaces (`arm.enabled && arm.armedEngineCount > 0`)
 * was ALSO one line of unexercised inline logic, and it spent days printing
 * "the exit hoist is ARMED" about a live book that had no exit timer.
 *
 * Tags, in evaluation order — the first four are all REFUSALS and none of them
 * may be reported as "disarmed":
 *   unreadable      — the route did not answer at all.
 *   pooled_build    — pre-TRA-2645 payload: `enabled` is an OR over both books.
 *   window_mismatch — the answering process booted AFTER the graded window.
 *   book_unreadable — a book is blind (not resident / bad `mode` / bad `timerArmed`).
 *   armed           — at least one book has a live timer ⇒ tick-cost curve for it.
 *   disarmed        — BOTH books readable and neither armed ⇒ exit-latency curve.
 */
export function classifyExitArmCurve(arm, to) {
  if (arm === null || arm === undefined) return 'unreadable';
  if (!arm.partitioned) return 'pooled_build';
  if (!(arm.startedAt && arm.startedAt <= to)) return 'window_mismatch';
  if (arm.liveEnabled === true || arm.demoEnabled === true) return 'armed';
  // Ordered AFTER `armed` on purpose: a readable ARMED book is a fact worth
  // printing even when the other book is blind, and the printed clause names
  // the blind one anyway. A blind book only decides the verdict when nothing
  // is armed — where the alternative would be to call it "disarmed".
  if (arm.liveEnabled == null || arm.demoEnabled == null) return 'book_unreadable';
  return 'disarmed';
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

/**
 * TRA-2645 — `--selftest`: control the curve classifier in BOTH directions.
 *
 * The branch this replaces was one inline line, and the reason it published
 * "the exit hoist is ARMED" over an unhoisted live book for days is that
 * nothing ever ran it against a fleet where the two books disagreed. The
 * known-bad here CONTAINS what the instrument detects (a 57-demo-armed /
 * 1-live-unarmed fleet — the verbatim 2026-07-30T04:19:56Z bqb1 shape), and the
 * known-good is a genuinely all-disarmed fleet that must NOT be reported as
 * armed. Exit 0 = every control holds, 1 = the suite failed.
 */
function runSelfTest() {
  const WINDOW_TO = '2026-07-30T20:00:00Z';
  const BOOTED_BEFORE = '2026-07-30T13:00:00Z';
  const BOOTED_AFTER = '2026-07-30T21:00:00Z';
  const base = {
    partitioned: true, startedAt: BOOTED_BEFORE,
    liveEnabled: false, demoEnabled: false,
    liveArmedEngineCount: 0, demoArmedEngineCount: 0,
    liveEngineCount: 1, demoEngineCount: 57,
    liveVerdict: 'disarmed', demoVerdict: 'disarmed',
  };
  const cases = [
    // ── The defect itself. Pre-fix this returned "armed" via the pooled OR and
    //    printed fleet-wide arming as coverage over a live book with no timer.
    ['THE BUG: 57 demo ARMED + 1 live UNARMED must not be a single "armed" verdict',
      { ...base, demoEnabled: true, demoArmedEngineCount: 57, demoVerdict: 'bounded' }, 'armed'],
    // ...and the printed clause must say the live book is DISARMED, not inherit
    // the fleet's answer. This is the assertion the old code could not make.
    ['...and the live clause reads DISARMED',
      null, null,
      () => armClause('live', false, 0, 1, 'disarmed').includes('DISARMED')],
    ['KNOWN-GOOD: both books disarmed => disarmed (the instrument can still say so)',
      base, 'disarmed'],
    ['KNOWN-GOOD: live armed => armed', { ...base, liveEnabled: true, liveArmedEngineCount: 1, liveVerdict: 'bounded' }, 'armed'],
    // ── The four refusals. None of these may be reported as "disarmed".
    ['REFUSAL: route unreadable', null, 'unreadable'],
    ['REFUSAL: pre-TRA-2645 pooled build (no `partitionedBy`)', { ...base, partitioned: false }, 'pooled_build'],
    ['REFUSAL: answering process booted AFTER the window', { ...base, startedAt: BOOTED_AFTER }, 'window_mismatch'],
    ['REFUSAL: no `startedAt` at all', { ...base, startedAt: null }, 'window_mismatch'],
    ['REFUSAL: live book BLIND (no mode=live engine) is NOT "disarmed"',
      { ...base, liveEnabled: null, liveArmedEngineCount: null, liveEngineCount: 0, liveVerdict: 'no_engine_in_book' },
      'book_unreadable'],
    ['REFUSAL: live book BLIND on unreadable `timerArmed` is NOT "disarmed"',
      { ...base, liveEnabled: null, liveVerdict: 'unreadable_arm_state' }, 'book_unreadable'],
    ['REFUSAL: unreadable `mode` blinds both books', { ...base, liveEnabled: null, demoEnabled: null, liveVerdict: 'unreadable_partition', demoVerdict: 'unreadable_partition' }, 'book_unreadable'],
    // A blind book must not SUPPRESS a readable armed one — the printed clause
    // names the blind book, so refusing here would lose a real fact.
    ['a BLIND demo book beside an ARMED live book still reads armed',
      { ...base, liveEnabled: true, liveArmedEngineCount: 1, liveVerdict: 'bounded', demoEnabled: null, demoVerdict: 'no_engine_in_book' },
      'armed'],
    // And the clause never launders a null into "DISARMED".
    ['a null `enabled` prints UNREADABLE, never DISARMED', null, null,
      () => {
        const s = armClause('live', null, null, 0, 'no_engine_in_book');
        return s.includes('UNREADABLE') && !s.includes('DISARMED');
      }],
  ];
  let failed = 0;
  for (const [name, arm, want, predicate] of cases) {
    const ok = predicate ? predicate() : classifyExitArmCurve(arm, WINDOW_TO) === want;
    if (!ok) {
      failed += 1;
      const got = predicate ? 'predicate false' : classifyExitArmCurve(arm, WINDOW_TO);
      console.log(`  FAIL  ${name}\n        wanted ${want ?? 'true'}, got ${got}`);
    } else {
      console.log(`  ok    ${name}`);
    }
  }
  console.log('');
  console.log(failed === 0
    ? `TRA-2645 curve-classifier controls: ${cases.length}/${cases.length} hold.`
    : `TRA-2645 curve-classifier controls: ${failed} of ${cases.length} FAILED.`);
  return failed === 0 ? 0 : 1;
}

(async () => {
  if (has('--selftest')) {
    process.exit(runSelfTest());
  }
  console.error(`[tape] window ${FROM} -> ${TO}`);
  const recs = await pullTape(FROM, TO);
  if (!recs.length) {
    console.error('BLIND: zero phase-timing records in the window.');
    process.exit(3);
  }

  const arm = await pullExitArm();
  // Widen the left edge by the transient width: a boot that lands just BEFORE the
  // window still projects its transient INTO it, so `bootsWithPreWindow` — not the
  // in-window count — is what the exclusion pass must use.
  const bootSet = await pullBootSet({
    from: FROM, to: TO, preWindowMs: BOOT_TRANSIENT_MS,
    serviceId: SERVICE_ID, ownerId: OWNER_ID, apiKey: API_KEY, api: API,
  });
  // FAIL CLOSED: a blind boot set yields `null`, which prints "could not be read"
  // below and NEVER a boot-excluded grade. There is deliberately no fallback to the
  // deploy list — the fallback is the bug (TRA-2261).
  const boots = bootSet.blind ? null : bootSet.bootsWithPreWindow.map(b => ({
    at: b.at, commit: b.srcs.includes('DEPLOY') ? 'deploy' : 'watchdog',
    trigger: b.labels.join(' + '),
  }));
  if (bootSet.blind) console.error(`[tape] boot set BLIND — ${bootSet.blindReasons.join('; ')}`);
  const warmRecs = boots && boots.length
    ? recs.filter(r => !inBootWindow(r.ts, boots))
    : recs;

  // Dump BEFORE the blindness gate: a blind tape is exactly the one you want to
  // inspect by hand, and re-pulling it costs another full paginated walk.
  const dumpTo = valOf('--dump');
  if (dumpTo) {
    writeFileSync(dumpTo, JSON.stringify({
      window: { from: FROM, to: TO },
      bootTransientMs: BOOT_TRANSIENT_MS,
      boots: boots ?? null,
      records: recs,
    }, null, 1));
    process.stderr.write(`[tape] dumped ${recs.length} raw records -> ${dumpTo}\n`);
  }

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
      bootSet: {
        blind: bootSet.blind, blindReasons: bootSet.blindReasons,
        bootCount: bootSet.bootCount, invisibleToDeploys: bootSet.invisibleToDeploys,
        boots: bootSet.bootsWithPreWindow, trips: bootSet.trips, suppressed: bootSet.suppressed,
      },
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
  // The live read only describes THIS window if the process answering it was
  // already running when the window closed. Otherwise it is a fact about a
  // later process and must not be applied backwards.
  //
  // TRA-2645 — AND IT IS ANSWERED PER BOOK. The old branch here was
  // `arm.enabled && arm.armedEngineCount > 0`, an OR/SUM over a mixed-mode
  // fleet, so 57 armed demo engines made this print "the exit hoist is ARMED"
  // over a live book that had no exit timer. The live book gets its own line
  // because it is the only one that carries money, and a book we cannot read is
  // reported as UNREADABLE, never as DISARMED.
  const curve = classifyExitArmCurve(arm, TO);
  const bookLines = () => {
    console.log(`    ${armClause('live', arm.liveEnabled, arm.liveArmedEngineCount, arm.liveEngineCount, arm.liveVerdict)}`);
    console.log(`    ${armClause('demo', arm.demoEnabled, arm.demoArmedEngineCount, arm.demoEngineCount, arm.demoVerdict)}`);
    if (arm.liveBlindReason) console.log(`    live: ${arm.liveBlindReason}`);
  };
  if (curve === 'unreadable') {
    console.log('doTick by UTC hour  [arm state UNREADABLE — do NOT quote this as exit latency]:');
  } else if (curve === 'pooled_build') {
    console.log(`doTick by UTC hour  [PRE-TRA-2645 BUILD — the exit-cadence route answering this probe`);
    console.log(`  has no \`partitionedBy: "mode"\` marker, so its \`enabled\`/\`armedEngineCount\` are an OR`);
    console.log(`  and a SUM over a MIXED-MODE fleet (57 demo + 1 live on bqb1). That cannot say whether`);
    console.log(`  the LIVE book's hoist was armed, and substituting the pooled value is the defect`);
    console.log(`  TRA-2645 fixed. Establish the per-book arm state another way before quoting this.]`);
  } else if (curve === 'window_mismatch') {
    console.log(`doTick by UTC hour  [WHICH CURVE THIS IS, IS UNKNOWN. The live exit-cadence read`);
    console.log(`  describes a process that booted ${arm.startedAt} — AFTER this window closed, so it`);
    console.log(`  says nothing about whether the hoist was armed then. Establish the arm state for the`);
    console.log(`  window from that session's own evidence before calling this exit latency.]`);
  } else if (curve === 'armed') {
    console.log(`doTick by UTC hour — TICK-COST curve for any ARMED engine, exit-latency curve for any`);
    console.log(`  UNARMED one. Arm state BY BOOK (${arm.modes}):`);
    bookLines();
    console.log(`  Exit latency for an ARMED book is NOT this table — read books.<book> off`);
    console.log(`  /api/health/exit-cadence. ⛔ Never quote the demo book's number about the live one.`);
  } else if (curve === 'book_unreadable') {
    console.log(`doTick by UTC hour  [AT LEAST ONE BOOK IS UNREADABLE — do NOT quote this as exit latency]:`);
    bookLines();
  } else {
    console.log('Exit-latency curve (parent doTick by UTC hour) — hoist DISARMED on BOTH books, so interval == tick duration:');
    bookLines();
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
  console.log(formatBootSet(bootSet));
  if (boots === null) {
    console.log('  ⇒ the grade above may contain boot transients. Do NOT read this as steady state.');
  } else if (boots.length === 0) {
    console.log('  ⇒ the grade above is steady-state. ✓');
  } else {
    console.log(`          Every throttled sink fires on the first tick of a new process regardless`);
    console.log(`          of its interval, so the ${BOOT_TRANSIENT_MS / 1000}s after each boot is a TRANSIENT, not`);
    console.log(`          steady state:`);
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
