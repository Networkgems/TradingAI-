#!/usr/bin/env node
// tra3442-advisory-grade.mjs — TRA-3442
//
// Grade the `signal.doTick.agents-advisory` bound against the 3-world rule that
// TRA-3442 PRE-REGISTERED (issue comment, 2026-08-13T09:2xZ) — as one command,
// so the verdict is reproducible instead of hand-assembled at each wake.
//
// ── Why this is not "just read the tape" ─────────────────────────────────────
// Two instrument traps make the naive read WRONG in OPPOSITE directions, and
// this script exists because both bit on this ticket:
//
//   1. `recordPhaseDuration` (phase-timing.ts) drops anything under
//      `PHASE_TIMING_SLOW_MS` (unset on bqb1 ⇒ 1000ms). PRE-fix, that floor
//      manufactured a false MODE: `p90 == max` was read as "every invocation
//      takes ~90s" when it only ever meant "of the passes over 1s, all were
//      ~90s". POST-fix it manufactures a false ZERO: a healthy pass is
//      8 symbols × ~130ms ≈ 0.65s, BELOW the floor — so success and
//      "never ran" collapse to the same `n=0` in the tape.
//      ⇒ the tape can NEVER be the denominator. The denominator is the
//      TRA-3514 §4 per-pass census line, which is emitted unconditionally.
//
//   2. The census is `log.INFO`. A positive control built on a `warn` line
//      (e.g. "slow async phase") only proves the logs API answers — it does
//      NOT prove an INFO line from this logger reaches it. So the control here
//      requires an INFO line from `module:"signal-engine"`: the same level,
//      the same module and the same logger as the census. A control must
//      CONTAIN what it detects.
//
// ── The rule (verbatim, pre-registered) ──────────────────────────────────────
//   1. Pin the build that was live FOR THE WINDOW off the Render deploy
//      history — not off /health now. Not an ancestor of the fix ⇒ BLIND.
//   2. Denominator first: zero `pass census (TRA-3514)` lines ⇒ BLIND, NEVER
//      pass. This leg is what stops a false all-clear.
//   3. World A (provider still refusing): failed>=5, complete:false, plus the
//      "LLM failure breaker tripped … (TRA-3442)" warn ⇒ PASS.
//      World B (healthy): complete:true, advised>0, tape max <= 60s ⇒ PASS.
//        ⚠️ stated deviation: AC(a)'s literal "truncation marker proven to have
//        fired" is UNSATISFIABLE at an 8-symbol shortlist (the budget cannot
//        bite a pass that short). The census line is the substituted witness.
//      World C: tape max > 60s ⇒ FAIL.
//   4. Restart continuity binds the TAPE leg only; the census/breaker log lines
//      survive a restart, so a mid-window boot does not void them.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   RENDER_API_KEY=rnd_… node scripts/tra3442-advisory-grade.mjs \
//     --from=2026-08-13T13:30:00Z --to=2026-08-13T20:00:00Z
//   node scripts/tra3442-advisory-grade.mjs --selftest      # controls, no network
//
//   ⚠️ Timestamps need SECONDS. A bare `…T13:30Z` is HTTP 400 at the Render
//      logs API and used to surface as a spurious BLIND; this exits 2 instead.
//
//   Optional, for the BLIND-diagnosis leg (separates "gated off" from "broken"):
//     ADMIN_PASSWORD=… (bqb1 admin) — reads the LIVE `tradingAgentsEnabled`
//     master switch. Absent ⇒ the diagnosis is reported as `unknown`, which
//     never changes the verdict, only its explanation.
//
// ── Exit codes ───────────────────────────────────────────────────────────────
//   0  PASS (World A or World B)
//   1  FAIL (World C — the bound did not hold)
//   2  operator / instrument error (bad args, auth, dead log query) — NO verdict
//   3  BLIND — the sink did not run in the window; no verdict is possible

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const API = 'https://api.render.com/v1';
const OWNER_ID = 'tea-d7macfog4nts73ai6p40';
const SERVICE_ID = 'srv-d7mb7rr7uimc73ev0chg';
const BQB1 = process.env.BQB1_BASE ?? 'https://tradingai-bqb1.onrender.com';

/** The commit that shipped the bound. The graded build must CONTAIN it. */
const FIX_COMMIT = '35e83557';
/** TRA-3442's bar. */
const MAX_MS = 60_000;
/** AGENTS_ADVISORY_BREAK_STREAK — the breaker's consecutive-failure threshold. */
const BREAK_STREAK = 5;
const PHASE = 'signal.doTick.agents-advisory';
const CENSUS_MSG = 'pass census (TRA-3514)';
const BREAKER_MSG = 'LLM failure breaker tripped';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valOf = name => {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};

// ─────────────────────────────────────────────────────────────────────────────
// The verdict function. Pure, so --selftest can control it in BOTH directions
// without a network.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {{census: any[], breakerWitness: number, tapeMaxMs: number|null,
 *          buildContainsFix: boolean|null, gateEnabled: boolean|null}} ev
 */
export function verdict(ev) {
  // Leg 1 — the build. `null` = could not be established (shallow clone missing
  // the commit); that is BLIND, not a pass, because the arm is unknown.
  if (ev.buildContainsFix !== true) {
    return {
      world: 'BLIND',
      exit: 3,
      leg: 'build-pin',
      why: ev.buildContainsFix === false
        ? `the build live for the window does NOT contain ${FIX_COMMIT} — this is the CONTROL arm`
        : `could not establish whether the window's build contains ${FIX_COMMIT}`,
    };
  }
  // Leg 2 — the denominator. This is the leg that refuses a false all-clear.
  if (ev.census.length === 0) {
    const why = ev.gateEnabled === false
      ? 'zero pass-census lines AND the live `tradingAgentsEnabled` master switch reads FALSE '
        + '⇒ the sink is gated off at the source; the zero is a NO-OP, not a healthy pass'
      : 'zero pass-census lines — the advisory sink never reached its census emit in this window';
    return { world: 'BLIND', exit: 3, leg: 'denominator', why };
  }
  // Leg 3 — World C first: a tape breach is a FAIL regardless of which world the
  // census describes. Graded before A/B so a breaker-tripped pass cannot mask it.
  if (ev.tapeMaxMs != null && ev.tapeMaxMs > MAX_MS) {
    return {
      world: 'C', exit: 1, leg: 'tape',
      why: `${PHASE} max ${(ev.tapeMaxMs / 1000).toFixed(1)}s > ${MAX_MS / 1000}s`,
    };
  }
  const worldA = ev.census.filter(c => c.failed >= BREAK_STREAK && c.complete === false);
  if (worldA.length > 0 && ev.breakerWitness > 0) {
    return {
      world: 'A', exit: 0, leg: 'breaker',
      why: `provider still refusing: ${worldA.length} pass(es) with failed>=${BREAK_STREAK} and `
        + `complete:false, and the breaker warn was witnessed ${ev.breakerWitness}x — the sweep `
        + `stood down instead of re-discovering the same systemic refusal per symbol`,
    };
  }
  const worldB = ev.census.filter(c => c.complete === true && c.advised > 0);
  if (worldB.length > 0) {
    return {
      world: 'B', exit: 0, leg: 'census',
      why: `healthy: ${worldB.length} complete pass(es) with advised>0`
        + (ev.tapeMaxMs == null
          ? `, and the phase tape is silent — expected, a bounded pass runs below the 1s tape floor`
          : `, tape max ${(ev.tapeMaxMs / 1000).toFixed(1)}s <= ${MAX_MS / 1000}s`),
    };
  }
  // Census lines exist but match neither shape: a pass that failed under the
  // streak, or was stopped by the budget with nothing advised. Not a pass.
  return {
    world: 'BLIND', exit: 3, leg: 'census-shape',
    why: `${ev.census.length} census line(s) matched neither World A (failed>=${BREAK_STREAK} `
      + `+ breaker witness) nor World B (complete + advised>0) — inspect them by hand`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// --selftest — control the grader in BOTH directions. A grader that only ever
// says PASS on a good fixture is not controlled; each case below asserts the
// verdict FLIPS when the single discriminating field is removed.
// ─────────────────────────────────────────────────────────────────────────────
if (has('--selftest')) {
  const ok = { buildContainsFix: true, gateEnabled: true, tapeMaxMs: null, breakerWitness: 0, census: [] };
  const A = { advised: 0, fellBack: 0, skipped: 0, failed: 5, complete: false };
  const B = { advised: 6, fellBack: 2, skipped: 0, failed: 0, complete: true };
  const cases = [
    ['World A fires on a stood-down pass', { ...ok, census: [A], breakerWitness: 1 }, 'A', 0],
    ['…and FLIPS without the breaker witness', { ...ok, census: [A], breakerWitness: 0 }, 'BLIND', 3],
    ['…and FLIPS if the pass completed', { ...ok, census: [{ ...A, complete: true }], breakerWitness: 1 }, 'BLIND', 3],
    ['World B fires on a healthy complete pass', { ...ok, census: [B] }, 'B', 0],
    ['…and FLIPS with advised:0', { ...ok, census: [{ ...B, advised: 0 }] }, 'BLIND', 3],
    ['World B survives a silent tape (below the 1s floor)', { ...ok, census: [B], tapeMaxMs: null }, 'B', 0],
    ['World C beats a healthy census', { ...ok, census: [B], tapeMaxMs: 94_600 }, 'C', 1],
    ['World C beats a World-A census too', { ...ok, census: [A], breakerWitness: 1, tapeMaxMs: 94_600 }, 'C', 1],
    ['60000ms exactly is NOT a breach', { ...ok, census: [B], tapeMaxMs: 60_000 }, 'B', 0],
    ['60001ms IS a breach', { ...ok, census: [B], tapeMaxMs: 60_001 }, 'C', 1],
    ['empty census is BLIND, never PASS', ok, 'BLIND', 3],
    ['…even with a clean tape', { ...ok, tapeMaxMs: 400 }, 'BLIND', 3],
    ['control arm (build lacks the fix) is BLIND', { ...ok, buildContainsFix: false, census: [B] }, 'BLIND', 3],
    ['unknown build is BLIND', { ...ok, buildContainsFix: null, census: [B] }, 'BLIND', 3],
  ];
  let bad = 0;
  for (const [name, ev, wantWorld, wantExit] of cases) {
    const got = verdict(ev);
    const pass = got.world === wantWorld && got.exit === wantExit;
    if (!pass) bad++;
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name} → ${got.world}/${got.exit}`
      + (pass ? '' : ` (want ${wantWorld}/${wantExit})`));
  }
  // The gate-diagnosis leg must change the EXPLANATION without changing the verdict.
  const gatedOff = verdict({ ...ok, gateEnabled: false });
  const gateUnknown = verdict({ ...ok, gateEnabled: null });
  const diagOk = gatedOff.exit === gateUnknown.exit && gatedOff.why !== gateUnknown.why;
  if (!diagOk) bad++;
  console.log(`${diagOk ? 'ok  ' : 'FAIL'}  the gate read explains BLIND without changing it`);
  console.log(bad === 0 ? `\n${cases.length + 1}/${cases.length + 1} controls pass.` : `\n${bad} CONTROL(S) FAILED.`);
  process.exit(bad === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Live grade.
// ─────────────────────────────────────────────────────────────────────────────
const API_KEY = process.env.RENDER_API_KEY;
if (!API_KEY) { console.error('RENDER_API_KEY is required.'); process.exit(2); }

const FROM = valOf('--from');
const TO = valOf('--to');
if (!FROM || !TO) { console.error('--from=<ISO> and --to=<ISO> are required.'); process.exit(2); }
for (const [flag, v] of [['--from', FROM], ['--to', TO]]) {
  // The seconds are load-bearing: `…T13:30Z` is a 400 at the logs API, and a 400
  // swallowed mid-walk reads as a spurious BLIND. Fail as operator error.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) {
    console.error(`${flag}=${v} needs SECONDS (e.g. 2026-08-13T13:30:00Z).`); process.exit(2);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchRetry(url, label) {
  let waitMs = 5_000;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' } });
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt <= 8) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : waitMs);
      waitMs = Math.min(waitMs * 2, 60_000);
      continue;
    }
    console.error(`${label}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(2);
  }
}

/** Page the logs API backwards over the window, parsing every line as JSON. */
async function pullText(text, keep) {
  const seen = new Map();
  let endTime = TO;
  for (let page = 0; page < 400; page++) {
    const url = `${API}/logs?ownerId=${OWNER_ID}&resource=${SERVICE_ID}`
      + `&text=${encodeURIComponent(text)}`
      + `&startTime=${encodeURIComponent(FROM)}&endTime=${encodeURIComponent(endTime)}&limit=100`;
    const body = await (await fetchRetry(url, `logs text=${text}`)).json();
    const logs = body.logs ?? [];
    let fresh = 0;
    for (const l of logs) {
      if (seen.has(l.id)) continue;
      // TRA-1894 — PARSE the JSON, never grep it.
      let rec; try { rec = JSON.parse(l.message); } catch { continue; }
      const kept = keep(rec);
      if (!kept) continue;
      seen.set(l.id, kept === true ? rec : kept);
      fresh++;
    }
    if (!body.hasMore || !body.nextEndTime || body.nextEndTime === endTime) break;
    if (logs.length === 0 || (fresh === 0 && page > 0)) break;
    endTime = body.nextEndTime;
  }
  return [...seen.values()];
}

/** Leg 1 — the build that was live FOR THE WINDOW, off the deploy history. */
async function pinWindowBuild() {
  const rows = await (await fetchRetry(
    `${API}/services/${SERVICE_ID}/deploys?limit=50`, 'deploys')).json();
  const deploys = rows.map(r => r.deploy ?? r)
    .filter(d => d.finishedAt)
    .map(d => ({ id: d.id, status: d.status, finishedAt: d.finishedAt, createdAt: d.createdAt,
      commit: (d.commit?.id ?? '').slice(0, 12) }))
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  const before = deploys.filter(d => d.finishedAt <= FROM).pop() ?? null;
  const inside = deploys.filter(d => d.finishedAt > FROM && d.createdAt < TO);
  return { before, inside, considered: deploys.length };
}

function ancestry(child, parentCommit) {
  const git = args => {
    try { execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }); return 0; }
    catch (e) { return typeof e.status === 'number' ? e.status : -1; }
  };
  try { execFileSync('git', ['cat-file', '-t', child], { stdio: 'ignore' }); }
  catch { return { known: false, contains: null, fwd: null, rev: null }; }
  const fwd = git(['merge-base', '--is-ancestor', parentCommit, child]);
  // The reverse is the CONTROL. The clone is SHALLOW, which produces false
  // NEGATIVES only — so rc=0 forward proves ancestry, and an rc=0 in BOTH
  // directions would mean the two refs are the same commit, not a proof.
  const rev = git(['merge-base', '--is-ancestor', child, parentCommit]);
  return { known: true, contains: fwd === 0 && rev !== 0, fwd, rev };
}

const out = { ticket: 'TRA-3442', window: { from: FROM, to: TO }, generatedAtWindowEnd: TO };

// ── Leg 1 ────────────────────────────────────────────────────────────────────
const build = await pinWindowBuild();
if (!build.before) { console.error('no deploy finished before the window — cannot pin the arm.'); process.exit(2); }
const anc = ancestry(build.before.commit, FIX_COMMIT);
out.build = {
  windowCommit: build.before.commit,
  deployId: build.before.id,
  finishedAt: build.before.finishedAt,
  deploysFinishingInsideWindow: build.inside.map(d => `${d.id}@${d.finishedAt}`),
  ancestry: anc,
};
console.log(`[1/4] build live for the window: ${build.before.commit} `
  + `(deploy ${build.before.id}, finished ${build.before.finishedAt})`);
if (build.inside.length) {
  console.log(`      ⚠️ ${build.inside.length} deploy(s) overlap the window — the TAPE leg is `
    + `discontinuous; the census/breaker legs survive a restart.`);
}
console.log(`      contains ${FIX_COMMIT}: ${anc.contains} `
  + `(fwd rc=${anc.fwd}, reverse control rc=${anc.rev}${anc.known ? '' : ', commit unknown locally'})`);

// Leg 1 is decisive on its own: a window whose build lacks the fix is the
// CONTROL arm and can never yield a verdict, so stop before paying for the log
// walk. (Measured: the 2026-08-12 control window pages for minutes and then
// still returns BLIND.) `--all-legs` pulls the evidence anyway.
if (anc.known && anc.contains === false && !has('--all-legs')) {
  const v0 = verdict({ census: [], breakerWitness: 0, tapeMaxMs: null, buildContainsFix: false, gateEnabled: null });
  out.verdict = v0;
  console.log(`[--/4] VERDICT: BLIND (no verdict) — leg ${v0.leg}\n      ${v0.why}`
    + `\n      (short-circuited before the log walk; pass --all-legs to pull the evidence anyway)`);
  const p0 = valOf('--json');
  if (p0) { writeFileSync(p0, `${JSON.stringify(out, null, 2)}\n`); console.log(`\nwrote ${p0}`); }
  process.exit(v0.exit);
}

// ── Instrument control (must run BEFORE the denominator is believed) ─────────
// An INFO line from `module:"signal-engine"` — same level, same module, same
// logger as the census. Without this, a zero census is uninterpretable.
const infoControl = await pullText('"level":"info"', r => r.level === 'info' && r.module === 'signal-engine');
out.instrumentControl = { infoSignalEngineLines: infoControl.length, sampleMsg: infoControl[0]?.msg ?? null };
console.log(`[2/4] instrument control: ${infoControl.length} INFO line(s) from module:"signal-engine" `
  + `in the window${infoControl[0] ? ` (e.g. "${infoControl[0].msg}")` : ''}`);
if (infoControl.length === 0) {
  console.error('      the INFO channel is silent — a zero census would be an INSTRUMENT artefact, '
    + 'not an observation. No verdict.');
  process.exit(2);
}

// ── Leg 2 + 3 ────────────────────────────────────────────────────────────────
const census = await pullText('pass census', r => (r.msg ?? '').includes(CENSUS_MSG) ? {
  ts: r.ts, session: r.session, advised: r.advised, fellBack: r.fellBack, skipped: r.skipped,
  failed: r.failed, shortlisted: r.shortlisted, dropped: r.dropped,
  universeOffered: r.universeOffered, complete: r.complete,
} : null);
const breaker = await pullText('failure breaker tripped', r => (r.msg ?? '').includes(BREAKER_MSG));
const tape = await pullText('slow async phase', r =>
  r.module === 'phase-timing' && r.phase === PHASE && typeof r.durationMs === 'number');
const tapeMaxMs = tape.length ? Math.max(...tape.map(t => t.durationMs)) : null;
out.census = census;
out.breakerWitness = breaker.length;
out.tape = { n: tape.length, maxMs: tapeMaxMs };
console.log(`[3/4] denominator: ${census.length} \`${CENSUS_MSG}\` line(s); `
  + `breaker witness ${breaker.length}x; tape n=${tape.length}`
  + `${tapeMaxMs == null ? ' (silent — a bounded pass runs below the 1s floor)' : `, max ${(tapeMaxMs / 1000).toFixed(1)}s`}`);
for (const c of census) {
  console.log(`      ${c.ts} session=${c.session} advised=${c.advised} fellBack=${c.fellBack} `
    + `skipped=${c.skipped} failed=${c.failed} shortlisted=${c.shortlisted} dropped=${c.dropped} `
    + `universeOffered=${c.universeOffered} complete=${c.complete}`);
}

// ── BLIND diagnosis: gated off, or broken? ───────────────────────────────────
let gateEnabled = null;
if (process.env.ADMIN_PASSWORD) {
  try {
    const login = await fetch(`${BQB1}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: process.env.ADMIN_USERNAME ?? 'admin', password: process.env.ADMIN_PASSWORD }),
    });
    const token = (await login.json()).token;
    const s = await (await fetch(`${BQB1}/api/account/settings`, {
      headers: { Authorization: `Bearer ${token}` } })).json();
    const settings = s.settings ?? s;
    gateEnabled = settings.tradingAgentsEnabled === true;
  } catch (err) {
    console.log(`      (gate read failed: ${err instanceof Error ? err.message : String(err)})`);
  }
}
out.gate = { tradingAgentsEnabled: gateEnabled };
console.log(`      live master switch tradingAgentsEnabled = ${gateEnabled === null ? 'unknown' : gateEnabled}`
  + ` ⚠️ read NOW, not during the window`);

// ── Verdict ──────────────────────────────────────────────────────────────────
const v = verdict({
  census, breakerWitness: breaker.length, tapeMaxMs,
  buildContainsFix: anc.known ? anc.contains : null, gateEnabled,
});
out.verdict = v;
console.log(`[4/4] VERDICT: ${v.world === 'BLIND' ? 'BLIND' : `World ${v.world}`} `
  + `(${v.exit === 0 ? 'PASS' : v.exit === 1 ? 'FAIL' : 'no verdict'}) — leg ${v.leg}\n      ${v.why}`);

const jsonPath = valOf('--json');
if (jsonPath) { writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`); console.log(`\nwrote ${jsonPath}`); }
process.exit(v.exit);
