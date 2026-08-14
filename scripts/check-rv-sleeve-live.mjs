#!/usr/bin/env node
// check-rv-sleeve-live.mjs — TRA-1718
//
// Answers ONE question against the RUNNING build: can `single_leg_rv::rv-long`
// admit a candidate at all, or is it dead by construction?
//
// The pinned build arms the entry-greeks gate with the SHORT-premium PoP band
// ([0.30, 0.40]) while `selectRvLongCandidate` can only ever emit |Δ| >= 0.45
// (RV_LONG_DELTA_FLOOR, TRA-972). Empty intersection: the sleeve admits ZERO
// candidates, ALGEBRAICALLY, and an empty set reads exactly like a hostile tape.
// `07ea3b1` fixes it by passing the RV long's own band at the gate site. The fix
// is HARDCODED IN CODE, not env-driven — so no flag flip substitutes for the
// lift, and any build without `07ea3b1` has a dead sleeve no matter its config.
//
// ── Why this script exists instead of a one-line curl ─────────────────────────
//
// TRA-1718's invalidation clause says: "re-read /api/health/entry-greeks-gate and
// check `shortDeltaBand`". That instrument GOES STALE ON THE VERY BUILD IT IS
// MEANT TO VALIDATE. `07ea3b1` also renames the field — the fixed build reports
//
//     config.deltaBand: [0.45, 1]              ← what the engine ACTUALLY enforces
//     config.shortPremiumDefaultBand: [0.3, 0.4]  ← the library default, inert here
//
// and serves NO `shortDeltaBand` key at all. So a checker looking for
// `shortDeltaBand` reads ABSENT on a healthy build — and an absent key reads as
// fine. It ALSO reads absent on a 404, on a redirect to an error page, and on a
// build so old the route does not exist. Same observation, three states, one of
// them fatal. That is the same bug as the impossible gate.
//
// So: assert POSITIVELY. Prove the band that is actually enforced admits the
// selector's floor. Never infer health from a missing key.
//
// Usage:
//   node scripts/check-rv-sleeve-live.mjs
//   node scripts/check-rv-sleeve-live.mjs --host=https://tradingai-bqb1.onrender.com
//   node scripts/check-rv-sleeve-live.mjs --no-git   # skip the ancestry leg
//
// Exit codes — FAILS CLOSED:
//   0  ALIVE     — gate armed, enforced band admits |Δ| >= 0.45, build has 07ea3b1.
//   1  DEAD      — the sleeve cannot admit a candidate. No RV outcome row is real.
//   2  DISARMED  — gate is OFF: it cannot kill the sleeve, but it is not measuring
//                  one either. TRA-1690's window is NOT running. Not a pass.
//   3  BLIND     — a leg could not be READ. NEVER a pass. "I could not check" is
//                  not "it is fine".

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
const ROUTE = '/api/health/entry-greeks-gate';

// The selector's floor. The gate must admit AT LEAST this, or the sleeve is void.
const RV_LONG_DELTA_FLOOR = 0.45;

// The commit that makes the enforced band the RV long's own (TRA-1677).
const SLEEVE_FIX = '07ea3b1';

import { gradedAncestry, blindReason } from './lib/shallow-ancestry.mjs';

const argv = process.argv.slice(2);
const host = (argv.find(a => a.startsWith('--host='))?.slice('--host='.length) ?? DEFAULT_HOST).replace(/\/$/, '');
const NO_GIT = argv.includes('--no-git');

function blind(msg) {
  console.error(`[rv-sleeve] BLIND: ${msg}`);
  console.error('[rv-sleeve] A leg could not be READ. This is never a pass.');
  process.exit(3);
}

function dead(msg, detail) {
  console.error('');
  console.error(`[rv-sleeve] DEAD — ${msg}`);
  if (detail) console.error(`[rv-sleeve] ${detail}`);
  console.error('[rv-sleeve] `single_leg_rv::rv-long` admits ZERO candidates on this build.');
  console.error('[rv-sleeve] Its empty set reads exactly like a hostile tape. Do NOT grade it:');
  console.error('[rv-sleeve] no RV outcome row from this build is real (TRA-1718).');
  process.exit(1);
}

// ── Leg 4's decision, as a function (TRA-3722) ────────────────────────────────
// `merge-base --is-ancestor` exits 1 both for "the build genuinely lacks 07ea3b1" and
// for "a shallow graft cut the path between them" — same code, no stderr. This file
// already screened statuses OUTSIDE 0/1 into blind(); the remaining `status !== 0` went
// to dead(), which condemns EVERY RV outcome row from a build that carries the fix. The
// blind() branch already said the right thing; only the routing was wrong.
//
// Extracted so the shallow-graft repro (scripts/tra3722-shallow-false-red-repro.mjs) can
// drive THIS FILE'S ROUTING inside a real graft, not merely the shared grader.
//   'contains' -> leg 4 passes · 'absent' -> dead() (1) · 'blind' -> blind() (3)
function sleeveAncestryState(fixSha, liveSha) {
  const { verdict, answer } = gradedAncestry(fixSha, liveSha);
  return { state: answer === true ? 'contains' : answer === false ? 'absent' : 'blind', verdict };
}

// `--ancestry-probe=<fixSha>:<liveSha>` — print leg 4's state and nothing else, then exit.
// Everything below does network I/O at module load, so the repro cannot import this module;
// it runs these SHIPPED BYTES as a subprocess inside a grafted clone. Placed before the
// first fetch on purpose. Prints `contains|absent|blind <verdict>`. Exit 0 = the probe ran
// (the ANSWER is the payload, not the exit code) · 2 = bad usage.
{
  const probe = argv.find(a => a.startsWith('--ancestry-probe='))?.slice('--ancestry-probe='.length);
  if (probe !== undefined) {
    const [fixSha, liveSha] = probe.split(':');
    if (!fixSha || !liveSha) {
      console.error('usage: --ancestry-probe=<fixSha>:<liveSha>');
      process.exit(2);
    }
    const { state, verdict } = sleeveAncestryState(fixSha, liveSha);
    console.log(`${state} ${verdict}`);
    process.exit(0);
  }
}

// ── Leg 1: CURL THE ROUTE. Never grep the route file — a key can arrive via a
// spread, so the source tells you nothing about what the build SERVES. ─────────
let res;
try {
  res = await fetch(`${host}${ROUTE}`, { signal: AbortSignal.timeout(30_000) });
} catch (e) {
  blind(`GET ${host}${ROUTE} failed: ${e?.message ?? e}`);
}
if (!res.ok) blind(`GET ${host}${ROUTE} → HTTP ${res.status}. A non-200 is not a disarmed gate.`);

let body;
try {
  body = await res.json();
} catch (e) {
  blind(`${ROUTE} did not return JSON (${e?.message ?? e}). A landing page is not a health route.`);
}

const commit = body?.build?.commit;
if (typeof commit !== 'string' || commit.length < 7) {
  blind(`${ROUTE} served no build.commit — cannot tell WHICH build answered.`);
}
const shortCommit = commit.slice(0, 7);

console.log(`[rv-sleeve] host   : ${host}`);
console.log(`[rv-sleeve] build  : ${shortCommit}  (read off the RUNNING service, not the board)`);

// ── Leg 2: the legacy key. Its PRESENCE is proof of a pre-fix build. ──────────
// This is the one place an absent key is meaningful — and even here, absence is
// not treated as a pass. It only removes one way of being dead; leg 3 must still
// prove the sleeve alive on its own terms.
const cfg = body?.config;
if (!cfg || typeof cfg !== 'object') blind(`${ROUTE} served no config block.`);

if (Object.prototype.hasOwnProperty.call(cfg, 'shortDeltaBand')) {
  dead(
    `build ${shortCommit} still serves the legacy \`shortDeltaBand\` key.`,
    `That key only exists BEFORE ${SLEEVE_FIX}. The gate is arming the SHORT-premium band ` +
      `(${JSON.stringify(cfg.shortDeltaBand)}) against a selector that emits |Δ| >= ${RV_LONG_DELTA_FLOOR}.`,
  );
}

// ── Leg 3: assert the ENFORCED band POSITIVELY. An absent band is not a pass. ─
const band = cfg.deltaBand;
if (!Array.isArray(band) || band.length !== 2 || !band.every(n => typeof n === 'number' && Number.isFinite(n))) {
  dead(
    `build ${shortCommit} serves no readable \`config.deltaBand\`.`,
    'Cannot PROVE the enforced band admits the selector floor. An unprovable sleeve is a dead one.',
  );
}

const [min, max] = band;
const admitsFloor = min <= RV_LONG_DELTA_FLOOR && RV_LONG_DELTA_FLOOR <= max;

console.log(`[rv-sleeve] band   : [${min}, ${max}]  (the band the ENGINE enforces on the RV long)`);
console.log(`[rv-sleeve] floor  : ${RV_LONG_DELTA_FLOOR}  (selectRvLongCandidate cannot emit below this)`);

if (!admitsFloor) {
  dead(
    `the enforced band [${min}, ${max}] EXCLUDES the selector floor ${RV_LONG_DELTA_FLOOR}.`,
    'Empty intersection: every candidate the selector can emit, this gate rejects.',
  );
}

// ── Leg 4: ancestry. The band could read right on a build that still lacks the
// fix if someone ever makes it config-driven. Assert the commit BY NAME. ───────
if (!NO_GIT) {
  const { spawnSync } = await import('node:child_process');
  const rev = spawnSync('git', ['rev-parse', `${SLEEVE_FIX}^{commit}`], { encoding: 'utf8' });
  if (rev.status !== 0) blind(`cannot resolve ${SLEEVE_FIX} — is this the TradingAI repo?`);

  const known = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`]);
  if (known.status !== 0) {
    blind(
      `the running build ${shortCommit} is not a commit this checkout knows. ` +
        'Fetch, then re-run. An unknown build is not a trusted one.',
    );
  }

  // TRA-3722: the NEGATIVE is re-graded before it is believed. rc 0 still stands on its
  // own — an affirmative is PROVEN by objects that are present, and a graft can only hide
  // history, never invent it.
  const { state, verdict } = sleeveAncestryState(SLEEVE_FIX, commit);
  if (state === 'blind') {
    blind(
      `ancestry for ${SLEEVE_FIX}..${shortCommit} is UNREADABLE (${verdict}) — ${blindReason(verdict)} ` +
        'Reading it as a negative would condemn every RV outcome row from a build that may well ' +
        'CARRY the fix (TRA-3722).',
    );
  }
  if (state === 'absent') {
    dead(
      `the running build ${shortCommit} does NOT contain ${SLEEVE_FIX}.`,
      'The band above cannot be the fixed one. Re-derive the deploy id: node scripts/check-deploy-floor.mjs',
    );
  }
  console.log(`[rv-sleeve]   ✓ ${SLEEVE_FIX}  TRA-1677  is an ancestor of the running build`);
}

// ── Leg 5: is the gate even armed? A dark gate cannot kill the sleeve, but it is
// not measuring one either — and TRA-1690 grades what the gate DID. ───────────
if (body.enabled !== true) {
  console.error('');
  console.error(`[rv-sleeve] DISARMED — ${body.flag ?? 'ENTRY_GREEKS_GATE_ENABLED'} is OFF on ${shortCommit}.`);
  console.error('[rv-sleeve] The sleeve is not gate-killed, but no gate verdict is being recorded,');
  console.error("[rv-sleeve] so TRA-1690's observe window is NOT running. Not a pass.");
  process.exit(2);
}

// ── The loud part: an armed gate that admitted NOTHING is a suspect gate. ─────
// The fixed build ships these counters; report them, because "0 admitted" is the
// exact reading the impossible band produced — the band is right now, so a zero
// here means something ELSE ate the candidates.
const { evaluated, admitted, starving, warning } = body;
if (typeof evaluated === 'number') {
  console.log(`[rv-sleeve] counts : evaluated=${evaluated} admitted=${admitted ?? '?'} (ET day ${body.etDay ?? '?'})`);
}
if (warning) console.log(`[rv-sleeve] WARNING: ${warning}`);

console.log('');
console.log(`[rv-sleeve] ALIVE — ${shortCommit} arms the gate at [${min}, ${max}], which admits the`);
console.log(`[rv-sleeve] selector floor ${RV_LONG_DELTA_FLOOR}. The RV long can admit candidates.`);
if (starving) {
  console.log('[rv-sleeve] ...but it has admitted NONE today on a CORRECT band — suspect the tape or an');
  console.log('[rv-sleeve] UPSTREAM gate, and explain it before grading (see the warning above).');
}
process.exit(0);
