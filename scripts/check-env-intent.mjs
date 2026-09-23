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
//   node scripts/check-env-intent.mjs --stored-fixture=<file>
//                                                        # arm the env-list leg from a saved
//                                                        # Render env-var list (controls)
//
// Exit codes — FAILS CLOSED:
//   0  MATCH     — envIntent graded on-box (`applies:true`) and every lever
//                  matches its manifest intent. The optional Render env-list arm
//                  (below), when ON, also resolved every lever's STORED value to
//                  its manifest intent.
//   1  MISMATCH  — at least one lever disagrees with the manifest: either IN
//                  FORCE (the route leg: effective != intended) or STAGED (the
//                  env-list leg: the stored set resolves to something else, so
//                  the next boot bakes in a value the manifest does not intend).
//                  Both are named, and a STAGED row says so in as many words so
//                  it can never be read as an in-force arm.
//   2  usage     — unrecognized argument (nothing was graded).
//   3  BLIND     — could not read a leg: route unreachable/non-200, payload has
//                  no `envIntent` (the running build predates TRA-4474),
//                  `applies` is not true (the box cannot prove it is the
//                  production host the manifest is about), or — with the
//                  env-list arm ON — a stored value that cannot be RESOLVED
//                  (unknown lever, non-string value, or a local resolver that
//                  disagrees with the shipped one). "Could not check" is
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
//
// TRA-4803 — this leg used to grade PRESENCE only, and only for levers intended
// at a non-`off` value. For an `intended:'off'` lever it graded NOTHING: not
// presence, not value. So a stored `ENABLE_OPTION_LIVE_OTM=1` that no deploy had
// applied yet was invisible to BOTH legs — the route correctly reported the
// boot-time `off`, and this leg skipped the row — and the checker exited 0 MATCH
// on a box with a re-arm staged in its env. It now resolves EVERY lever's stored
// value the way its consumer does and grades that against the manifest.
//
// Why "not in force yet" is not "nothing to report": THE NEXT BOOT NEED NOT BE A
// DEPLOY. The pm2 memory watchdog's self-restart writes no deploy record at all
// (TRA-2203/TRA-2261) and `check:deploy-drift` reads CURRENT straight through
// one, so a staged arm can come into force with no deploy event anywhere, at a
// moment nobody chose. The gap between the env write and the boot that bakes it
// in is exactly where a warning is free. Asymmetry matters too: presence-only
// grading caught a DISARM of a safety lever early but not an ARM of a trading
// lever, and only the second one spends money.
//
// Two invariants this leg must keep (both easy to lose in an edit):
//   • ABSENT stays OK for an `intended:'off'` lever. Absent resolves to `off`,
//     which IS the intent — `ENABLE_ORDER_QUOTE_GUARD`, `ENABLE_OPTION_LIVE_RV
//     _LONG` and `ENABLE_OPTION_LIVE_DIRECTIONAL` all read `(key absent)` on the
//     live box. A permanently red gate gets muted, and a muted gate and a
//     deleted gate end in the same place.
//   • An unresolvable stored value is BLIND, never MATCH.

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
const KNOWN = ['--host', '--fixture', '--timeout-ms', '--render-service', '--stored-fixture'];
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
const STORED_FIXTURE = valOf('--stored-fixture');
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

// ── Resolving a STORED value ─────────────────────────────────────────────────
// The route publishes each lever's READING, not its predicate, so grading the
// stored set needs the predicate here. A local copy graded against a local
// literal agrees with itself, so each copy below is (a) a faithful port of the
// named shipped symbol, and (b) RE-VERIFIED against the shipped bytes on every
// single run — see `crossCheckAgainstShipped`. The intents themselves are still
// never copied: they come off the wire from the manifest the box published.
//
// Port of `flagOn` (packages/server/src/option-exec-flag.ts:25) and of the
// byte-identical `isTruthyEnv` (order-quote-guard.ts:67). Note it is TOTAL:
// every non-listed string — absent, empty, 'false', 'maybe' — is OFF. That is
// deliberate in the shipped code (default-safe), so there is no "unparseable
// value" tier for a flag; the unresolvable tier below is about levers this
// script does not know, not about values it does not like.
const flagOn = (raw) =>
  typeof raw === 'string' && ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());

// One row per manifest lever. `reads` is every env key the resolver consults —
// a lever can be a function of more than one (the quote guard is), and each one
// is validated before the resolver runs.
const STORED_RESOLVERS = {
  // durability.ts:183 — `=== 'refuse'`, everything else observes.
  DURABILITY_POLICY: {
    reads: ['DURABILITY_POLICY'],
    resolve: (env) => ((env['DURABILITY_POLICY'] ?? '').trim().toLowerCase() === 'refuse' ? 'refuse' : 'observe'),
  },
  // order-quote-guard.ts:84 — TWO keys. Off unless the primary is truthy; then
  // `enforce`/`shadow` on the second. For the `intended:'off'` grade only the
  // primary can decide, so a stale second key cannot manufacture a finding.
  ENABLE_ORDER_QUOTE_GUARD: {
    reads: ['ENABLE_ORDER_QUOTE_GUARD', 'ORDER_QUOTE_GUARD_ENFORCE'],
    resolve: (env) =>
      !flagOn(env['ENABLE_ORDER_QUOTE_GUARD']) ? 'off' : flagOn(env['ORDER_QUOTE_GUARD_ENFORCE']) ? 'enforce' : 'shadow',
  },
  // option-exec-flag.ts:1521 / :1390 / :1449 — plain `flagOn`, mapped on/off by
  // the manifest row itself (env-intent.ts:74/80/87).
  ENABLE_OPTION_LIVE_OTM: {
    reads: ['ENABLE_OPTION_LIVE_OTM'],
    resolve: (env) => (flagOn(env['ENABLE_OPTION_LIVE_OTM']) ? 'on' : 'off'),
  },
  ENABLE_OPTION_LIVE_RV_LONG: {
    reads: ['ENABLE_OPTION_LIVE_RV_LONG'],
    resolve: (env) => (flagOn(env['ENABLE_OPTION_LIVE_RV_LONG']) ? 'on' : 'off'),
  },
  ENABLE_OPTION_LIVE_DIRECTIONAL: {
    reads: ['ENABLE_OPTION_LIVE_DIRECTIONAL'],
    resolve: (env) => (flagOn(env['ENABLE_OPTION_LIVE_DIRECTIONAL']) ? 'on' : 'off'),
  },
};

/** Resolve one lever against the stored set, or say why it cannot be resolved. */
function resolveStored(lever, storedEnv) {
  const row = STORED_RESOLVERS[lever.key];
  if (!row) {
    return {
      why: `no stored resolver for '${lever.key}' — the manifest grew a lever this checker cannot resolve, so the stored set was NOT graded for it`,
    };
  }
  for (const k of row.reads) {
    const v = storedEnv[k];
    if (v !== undefined && typeof v !== 'string') {
      return { why: `stored '${k}' is ${v === null ? 'null' : typeof v}, not a string — cannot resolve '${lever.key}'` };
    }
  }
  return { effective: row.resolve(storedEnv) };
}

/**
 * The copy above, graded against the shipped original — for free, every run.
 * Wherever the stored value of a lever's own key is byte-identical to the `raw`
 * the route reported, the RUNNING PROCESS has already resolved that exact string
 * and published the answer. If the local port disagrees with it, the port is
 * stale and every verdict it produces is void ⇒ BLIND, never a grade.
 */
function crossCheckAgainstShipped(lever, storedEnv, storedEffective) {
  const storedRaw = storedEnv[lever.key];
  const routeRaw = lever.raw ?? undefined;
  if (storedRaw !== routeRaw) return null; // no observed pair for this lever this run
  if (storedEffective === lever.effective) return null;
  // The one benign way this can fire without a stale port: a MULTI-key lever
  // whose auxiliary key changed in the stored set since boot. For the quote
  // guard that requires its primary key to be truthy, which is itself a finding
  // this run would report — so reading BLIND there is correct, not noise.
  return (
    `local resolver disagrees with the shipped one for ${lever.key}: the running build resolved raw ` +
    `${JSON.stringify(lever.raw)} to '${lever.effective}', this script resolves the identical stored value to ` +
    `'${storedEffective}' — the port in check-env-intent.mjs is stale`
  );
}

// ── Leg 2 (optional arm): the STORED env-var list, resolved the way each
// lever's own consumer resolves it and graded against the manifest the route
// itself published (so this script carries no second copy of the INTENTS).
async function readStoredEnv() {
  if (STORED_FIXTURE) {
    console.log(`[env-intent] env-list arm: ON (fixture ${STORED_FIXTURE} — NOT the live service)`);
    try {
      return { armed: true, rows: JSON.parse(readFileSync(STORED_FIXTURE, 'utf8')), from: `fixture ${STORED_FIXTURE}` };
    } catch (e) {
      blind(`--stored-fixture unreadable: ${e.message}`);
    }
  }
  const key = process.env.RENDER_API_KEY;
  if (!key) {
    console.log('[env-intent] env-list arm: OFF (no RENDER_API_KEY in the environment) — the stored');
    console.log('[env-intent]   set was NOT graded; an unapplied wipe or a STAGED arm stays invisible');
    console.log('[env-intent]   until the next boot bakes it in.');
    return { armed: false };
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
  return { armed: true, rows: await res.json(), from: SERVICE_ID };
}

async function gradeStoredEnv(levers) {
  const read = await readStoredEnv();
  if (!read.armed) return { armed: false, mismatches: [], notes: [] };
  const storedEnv = Object.create(null);
  for (const r of Array.isArray(read.rows) ? read.rows : []) {
    const k = r?.envVar?.key ?? r?.key;
    if (typeof k === 'string') storedEnv[k] = r?.envVar?.value ?? r?.value;
  }
  if (!STORED_FIXTURE) {
    console.log(`[env-intent] env-list arm: ON (${Object.keys(storedEnv).length} stored keys read from ${read.from})`);
  }

  const mismatches = [];
  const notes = [];
  for (const lever of levers) {
    const { effective: storedEffective, why } = resolveStored(lever, storedEnv);
    if (why !== undefined) blind(`env-list arm was ON but ${why} (fail closed — unresolvable is never a match)`);

    const stale = crossCheckAgainstShipped(lever, storedEnv, storedEffective);
    if (stale) blind(stale);

    const rawShown = storedEnv[lever.key] === undefined ? 'key ABSENT' : `stored '${storedEnv[lever.key]}'`;
    if (storedEffective === lever.intended) {
      // Includes the case the arm must never break: an `intended:'off'` lever
      // with no stored key at all. Absent resolves to `off`, which IS the intent.
      if (lever.effective !== lever.intended) {
        notes.push(
          `${lever.key}: the stored set (${rawShown}) already resolves to the intended '${lever.intended}' — ` +
            `the fix is STAGED and the route's '${lever.effective}' is the pre-boot value.`,
        );
      }
      continue;
    }
    if (storedEffective === lever.effective) continue; // in force; the route leg names it

    mismatches.push(
      `${lever.key}: STAGED (${rawShown} resolves '${storedEffective}', not the intended '${lever.intended}' — ` +
        `NOT YET IN FORCE, the effective value is still '${lever.effective}'). The next boot bakes it in, and a ` +
        `boot need not be a deploy (TRA-2203/TRA-2261), so this is as actionable as a wipe.`,
    );
  }
  return { armed: true, mismatches, notes };
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
  .map((l) => `${l.key}: IN FORCE — intended '${l.intended}', effective '${l.effective}' (key ${l.present ? `present, raw '${l.raw}'` : 'ABSENT — the default is deciding'})`);

const arm = await gradeStoredEnv(intent.levers);
const all = [...routeMismatches, ...arm.mismatches];

console.log(`[env-intent] graded ${intent.levers.length} lever(s) from ${source}`);
for (const l of intent.levers) {
  console.log(`[env-intent]   ${l.matches === true ? 'ok  ' : 'FAIL'} ${l.key}: intended '${l.intended}', effective '${l.effective}'${l.present ? '' : ' (key absent)'}`);
}
for (const n of arm.notes) console.log(`[env-intent]   note ${n}`);

if (all.length > 0) {
  console.error(`[env-intent] MISMATCH — ${all.length} lever(s) disagree with packages/server/src/env-intent.ts:`);
  for (const m of all) console.error(`[env-intent]   ${m}`);
  console.error('[env-intent] Either the env was wiped/changed (restore the key, then apply per TRA-3724:');
  console.error('[env-intent] single-key upsert + render-redeploy --commit=<sha already serving>), or the');
  console.error('[env-intent] posture legitimately changed — then the manifest edit IS the audit trail.');
  console.error('[env-intent] A STAGED row is not in force YET. Fix the STORED value; do not wait for the');
  console.error('[env-intent] boot to prove it, and do not close it by editing the manifest to agree — for');
  console.error('[env-intent] ENABLE_OPTION_LIVE_OTM that row carries a board sign-off (TRA-4750 item 5).');
  process.exit(1);
}
console.log(
  arm.armed
    ? '[env-intent] MATCH — every lever at its manifest-intended value, EFFECTIVE and STORED.'
    : '[env-intent] MATCH — every lever at its manifest-intended value (EFFECTIVE only; env-list arm OFF).',
);
process.exit(0);
