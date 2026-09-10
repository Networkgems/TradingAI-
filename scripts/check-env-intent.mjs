#!/usr/bin/env node
// check-env-intent.mjs — TRA-4474
//
// An env lever can silently vanish, and a health route that publishes only the
// EFFECTIVE value cannot say so: `"policy":"observe"` on a box we armed reads
// byte-identical to `"policy":"observe"` on a box we never armed.
// `DURABILITY_POLICY=refuse` (armed+verified 2026-07-17, TRA-2002) was absent by
// 2026-09-10 and the money host booted fail-open for ~50 days with every
// instrument green.
//
// The fix has two halves. `/api/health/durability` now publishes `envIntent` —
// the repo-compiled intended value of every production lever beside the value
// the process actually resolved (packages/server/src/env-intent.ts). This
// script is the half that EXITS NON-ZERO on the gap.
//
// Usage:
//   node scripts/check-env-intent.mjs                    # grade the live box
//   node scripts/check-env-intent.mjs --host=https://…   # another deployment
//   node scripts/check-env-intent.mjs --fixture=<file>   # grade a saved payload (controls)
//
// Exit codes — FAILS CLOSED:
//   0  MATCH     — envIntent graded on-box (`applies:true`) and every lever
//                  matches its manifest intent. The optional Render env-list arm
//                  (below), when ON, also found every graded key as intended.
//   1  MISMATCH  — at least one lever's effective value disagrees with the
//                  manifest, each one named with intended vs effective.
//   2  usage     — unrecognized argument (nothing was graded).
//   3  BLIND     — could not read a leg: route unreachable/non-200, payload has
//                  no `envIntent` (the running build predates TRA-4474), or
//                  `applies` is not true (the box cannot prove it is the
//                  production host the manifest is about). "Could not check" is
//                  never "matches" — an old build reading green here would be
//                  the exact silent state this exists to kill.
//
// ── The optional env-list arm ────────────────────────────────────────────────
// The route proves what the PROCESS resolved at its last boot. An env write that
// has not been applied by a deploy yet (TRA-3724: env writes do not auto-deploy)
// is invisible to it in BOTH directions. When RENDER_API_KEY is present the
// checker also reads the service's env-var list and grades the STORED values
// against the manifest, so a wipe is caught before the next boot bakes it in.
// The arm's ON/OFF state is always PRINTED WITH ITS REASON — UNREAD is never OK.

import { readFileSync } from 'node:fs';

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
// bqb1. The Render service `name` is different ("TradingAI-"), so resolve by id,
// never by name (a name lookup returns [] and would grade some other service).
const DEFAULT_SERVICE_ID = 'srv-d7mb7rr7uimc73ev0chg';

const argv = process.argv.slice(2);
const valOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};
const KNOWN = ['--host', '--fixture', '--timeout-ms', '--render-service'];
for (const a of argv) {
  const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
  if (!KNOWN.includes(name)) {
    // TRA-4420 posture: an unrecognized flag must never be silently ignored.
    console.error(`[env-intent] usage: unrecognized argument '${a}' (values attach with =). Known: ${KNOWN.join(', ')}`);
    process.exit(2);
  }
}

const HOST = (valOf('--host') ?? DEFAULT_HOST).replace(/\/+$/, '');
const FIXTURE = valOf('--fixture');
const TIMEOUT_MS = Number(valOf('--timeout-ms') ?? 25_000);
const SERVICE_ID = valOf('--render-service') ?? process.env.RENDER_SERVICE_ID ?? DEFAULT_SERVICE_ID;

function blind(msg) {
  console.error(`[env-intent] BLIND: ${msg}`);
  console.error('[env-intent] A leg could not be READ. Never a pass — an unreadable intent');
  console.error('[env-intent] and a matching one are indistinguishable from here.');
  process.exit(3);
}

async function readDurabilityPayload() {
  if (FIXTURE) {
    try {
      return { body: JSON.parse(readFileSync(FIXTURE, 'utf8')), source: `fixture ${FIXTURE}` };
    } catch (e) {
      blind(`fixture unreadable: ${e.message}`);
    }
  }
  const url = `${HOST}/api/health/durability`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    blind(`${url} unreachable: ${e.message}`);
  }
  if (!res.ok) blind(`${url} returned HTTP ${res.status}`);
  try {
    return { body: await res.json(), source: url };
  } catch (e) {
    blind(`${url} body is not JSON: ${e.message}`);
  }
}

// ── Leg 2 (optional arm): the STORED env-var list, graded against the manifest
// the route itself published (so this script carries no second copy of the
// intents — a local copy graded against a local literal agrees with itself).
async function gradeStoredEnv(levers) {
  const key = process.env.RENDER_API_KEY;
  if (!key) {
    console.log('[env-intent] env-list arm: OFF (no RENDER_API_KEY in the environment) — the stored');
    console.log('[env-intent]   set was NOT graded; an unapplied wipe stays invisible until next boot.');
    return { armed: false, mismatches: [] };
  }
  const url = `https://api.render.com/v1/services/${SERVICE_ID}/env-vars?limit=100`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    blind(`env-list arm was ON but ${url} unreachable: ${e.message} (fail closed, TRA-2387 shape)`);
  }
  if (!res.ok) blind(`env-list arm was ON but env-var list returned HTTP ${res.status} (fail closed)`);
  const rows = await res.json();
  const stored = new Map(
    (Array.isArray(rows) ? rows : []).map((r) => [r?.envVar?.key ?? r?.key, r?.envVar?.value ?? r?.value]),
  );
  const mismatches = [];
  for (const lever of levers) {
    const value = stored.get(lever.key);
    // The stored list is graded on PRESENCE-vs-intent in the simple form the
    // incident took: a lever the manifest intends at a non-default value must
    // EXIST in the stored set. (`intended:'off'` levers are allowed absent —
    // absent is their intended state; the route leg already grades an armed one.)
    if (lever.intended !== 'off' && value === undefined) {
      mismatches.push(`${lever.key}: intended '${lever.intended}' but the key is ABSENT from the stored env set`);
    }
  }
  console.log(`[env-intent] env-list arm: ON (${stored.size} stored keys read from ${SERVICE_ID})`);
  return { armed: true, mismatches };
}

const { body, source } = await readDurabilityPayload();
const intent = body?.envIntent;
if (intent === undefined || intent === null) {
  blind(`payload from ${source} has no envIntent block — the running build predates TRA-4474, so intent is UNPUBLISHED there`);
}
if (intent.applies !== true) {
  blind(`envIntent.applies=${JSON.stringify(intent.applies)} (nodeEnv=${JSON.stringify(intent.nodeEnv)}) — the box cannot prove it is the production host this manifest is about`);
}
if (!Array.isArray(intent.levers) || intent.levers.length === 0) {
  blind('envIntent.levers is empty/absent — nothing was graded');
}

const routeMismatches = intent.levers
  .filter((l) => l.matches !== true)
  .map((l) => `${l.key}: intended '${l.intended}', effective '${l.effective}' (key ${l.present ? `present, raw '${l.raw}'` : 'ABSENT — the default is deciding'})`);

const arm = await gradeStoredEnv(intent.levers);
const all = [...routeMismatches, ...arm.mismatches];

console.log(`[env-intent] graded ${intent.levers.length} lever(s) from ${source}`);
for (const l of intent.levers) {
  console.log(`[env-intent]   ${l.matches === true ? 'ok  ' : 'FAIL'} ${l.key}: intended '${l.intended}', effective '${l.effective}'${l.present ? '' : ' (key absent)'}`);
}

if (all.length > 0) {
  console.error(`[env-intent] MISMATCH — ${all.length} lever(s) disagree with packages/server/src/env-intent.ts:`);
  for (const m of all) console.error(`[env-intent]   ${m}`);
  console.error('[env-intent] Either the env was wiped/changed (restore the key, then apply per TRA-3724:');
  console.error('[env-intent] single-key upsert + render-redeploy --commit=<sha already serving>), or the');
  console.error('[env-intent] posture legitimately changed — then the manifest edit IS the audit trail.');
  process.exit(1);
}
console.log('[env-intent] MATCH — every lever at its manifest-intended value.');
process.exit(0);
