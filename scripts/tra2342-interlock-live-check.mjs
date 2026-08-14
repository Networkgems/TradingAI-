#!/usr/bin/env node
// TRA-2342 — prove the TRA-2336 live-crypto interlock is LIVE (ancestry + call site),
// not merely merged, BEFORE anyone sets `TRADIER_ENV=production`.
//
// WHY THIS EXISTS AS A SCRIPT AND NOT A COMMENT. The proof is only true of the build
// that is running at the instant of the arming step. A comment saying "verified on
// 2026-07-26" is a claim about a build that a single pinned deploy can replace
// (TRA-2197 / TRA-2308 / TRA-2262 — three rungs of the same ladder). So the durable
// form of "we checked" is a re-runnable checker, run again immediately before the
// env write.
//
// WHAT IT CHECKS
//   1. ANCESTRY  — `ffe656c` is an ancestor of the SHA the box actually reports.
//                  SHA-equality is the WRONG test: the live build will legitimately
//                  be a descendant.
//   2. CALL SITE — the EDGE out of the LIVE tree, not the working copy. Ancestry and
//                  `ls-tree` both survive a revert of the *caller*, which leaves the
//                  module live, orphaned and unreachable. We require BOTH the import
//                  and the guard call, and require the guard to sit inside
//                  `shouldBootArmLiveCrypto` before any account-derived condition.
//   3. CARRIER   — `LIVE_CRYPTO_BOOT_ARM` is not positively set on the service.
//                  (Only with RENDER_API_KEY; skipped, and reported as SKIPPED, without.)
//   4. TRA-2351  — the two edges the QA grading of TRA-2343 found OPEN. This script
//                  is the gate on `TRADIER_ENV=production`, so every precondition on
//                  that step belongs here rather than in a second script nobody runs:
//                    a. the crypto-start route gates through `evaluateLiveCryptoStartGate`.
//                       It used to hand the general gate a snapshot carrying the
//                       PERSISTED mode while authorizing a LIVE start from the request
//                       body, so the gate graded DEMO, allowed it, and the route
//                       persisted an UNGRADED live-crypto arm.
//                    b. `createUserContext` calls `shouldBootDisarmLiveCrypto`. Check 2
//                       above proves a boot cannot CREATE the arm — it does NOT prove a
//                       boot cannot INHERIT one, because the caller short-circuits on
//                       `cryptoAutoTradingEnabledLive !== true` and never reaches the
//                       guard. (a) is a writer of exactly such an arm.
//   5. TRA-2348  — the universe rule. Everything above governs whether live crypto is
//                  ARMED; this governs WHAT UNIVERSE it may trade once it is. Every
//                  shipped live crypto preset enables the same single strategy (`dca`)
//                  and differs only in symbol universe, so swapping the canary preset
//                  for `crypto_core` is a ~130x widening with an EMPTY roster delta —
//                  invisible to checks 1-4 and to TRA-2343. It belongs on the same
//                  gate for the same reason (a) does: the arming step is the last
//                  moment anyone looks.
//
// `--post-arm=<iso>` additionally runs the TRA-2342 step-3 post-condition against
// /api/health/crypto-live. See POST-ARM below.
//
// `--crypto-arm` promotes the check-5 (TRA-2348) results from NOTICE to hard FAIL.
// Pass it whenever the action being authorized is arming LIVE CRYPTO rather than
// the equity `TRADIER_ENV=production` step. It is implied automatically whenever
// the crypto arm is already reachable (carrier ON, or carrier unreadable). See the
// severity note at check 5 — the scoping is deliberate.
//
// FAIL-CLOSED. Every unknown is a FAIL, never a pass: an unfetched SHA, an
// unreachable host and a malformed payload all exit non-zero. A checker that goes
// quiet when it cannot see is the TRA-1695 failure (a guard that cannot tell "I am
// broken" from "subject is fine").
//
// Exit codes: 0 = interlock LIVE. 1 = a check FAILED. 2 = the checker could not run.

import { execFileSync } from 'node:child_process';
// TRA-3721 — the shared shallow-graft ancestry grader (TRA-3699 / TRA-3678 remedy shape).
import { gradedAncestry, blindReason, isShallowCheckout } from './lib/shallow-ancestry.mjs';

const INTERLOCK_COMMIT = 'ffe656c3d84d7f850eb1d5a6c2f14f5562ebd594';
const INTERLOCK_TICKET = 'TRA-2336';
const ENGINE_PATH = 'packages/server/src/signal-engine.ts';
const FLAG_MODULE = 'packages/server/src/live-crypto-boot-arm-flag.ts';
const GUARD_SYMBOL = 'isLiveCryptoBootArmEnabled';
const CARRIER_KEY = 'LIVE_CRYPTO_BOOT_ARM';

// TRA-2351 — the third path, and the inherited-arm gap in the check above.
const THIRD_PATH_COMMIT = '86a5a05299b15727c5dff0eae87aef879ee6b1d7';
const ROUTES_PATH = 'packages/server/src/index.ts';
const USER_CONTEXT_PATH = 'packages/server/src/user-context.ts';
const START_GATE_SYMBOL = 'evaluateLiveCryptoStartGate';
const DISARM_SYMBOL = 'shouldBootDisarmLiveCrypto';

/**
 * The TRA-2351 edges, read out of an arbitrary tree so `--self-test` can run the
 * same predicates against the pre-fix build. Returns one {name, ok, detail} per
 * edge; `ok === false` on an unreadable file, never a silent pass.
 */
function tra2351Edges(tree) {
  const read = path => {
    try {
      return git(['show', `${tree}:${path}`]);
    } catch {
      return '';
    }
  };

  // (a) The ROUTE edge. Ancestry and ls-tree both survive a revert of the CALLER,
  // which would leave `evaluateLiveCryptoStartGate` exported, live and unreachable
  // while the route went back to composing its own snapshot — the TRA-2262 shape.
  // So we require the call, and require it NOT to be the old hand-composed form.
  const routes = read(ROUTES_PATH);
  const startRoute = routes.match(/app\.post\(\s*'\/api\/crypto\/trading\/start'[\s\S]*?\n\}\);/);
  const routeBody = startRoute ? startRoute[0] : '';
  const usesNamedGate = routeBody.includes(`${START_GATE_SYMBOL}(`);
  const composesOwn = /evaluateLiveTransitionGate\s*\(\s*username\s*,\s*updated/.test(routeBody);

  // (b) The BOOT-DISARM edge, in the caller — the guard itself living in
  // signal-engine.ts proves nothing if createUserContext stopped calling it.
  const ctx = read(USER_CONTEXT_PATH);
  const importsDisarm = new RegExp(`\\b${DISARM_SYMBOL}\\b`).test(ctx.split('\n').slice(0, 60).join('\n'));
  const callsDisarm = new RegExp(`${DISARM_SYMBOL}\\s*\\(`).test(ctx);

  return [
    {
      name: `TRA-2351 — crypto-start route gates through ${START_GATE_SYMBOL}`,
      ok: !!routeBody && usesNamedGate && !composesOwn,
      detail: !routeBody
        ? `could not locate the POST /api/crypto/trading/start handler in ${ROUTES_PATH}`
        : usesNamedGate && !composesOwn
          ? `${START_GATE_SYMBOL}(username, settings) called in the handler`
          : composesOwn
            ? 'the handler hands its OWN snapshot to evaluateLiveTransitionGate — a live start from a demo-persisted operator is UNGATED.'
            : `the handler does not call ${START_GATE_SYMBOL} — the live crypto start is UNGATED.`,
    },
    {
      name: `TRA-2351 — createUserContext calls ${DISARM_SYMBOL}`,
      ok: !!ctx && importsDisarm && callsDisarm,
      detail: !ctx
        ? `${USER_CONTEXT_PATH} is absent from the tree`
        : importsDisarm && callsDisarm
          ? `${DISARM_SYMBOL} imported and invoked — an INHERITED arm meets the carrier`
          : 'the boot-disarm caller is missing — an arm already set short-circuits past the interlock and is INHERITED by this boot.',
    },
  ];
}
// TRA-2348 — the universe rule, one level finer than the TRA-2343 roster delta.
const UNIVERSE_COMMIT = '387e8516e832d06bd75aa734aa7ef114ef25eab8';
const PROMOTION_SERVICE_PATH = 'packages/server/src/promotion-service.ts';
const SHARED_INDEX_PATH = 'packages/shared/src/index.ts';
const UNIVERSE_SYMBOL = 'widenedBeyondRatifiedUniverse';
const ALLOWLIST_SYMBOL = 'LIVE_RATIFIED_CRYPTO_PRESETS';
const UNRATIFIED_PRESET = 'crypto_core';

/**
 * TRA-2348 — read out of an arbitrary tree, same shape as {@link tra2351Edges}, so
 * `--self-test` can run the identical predicates against the real pre-fix build.
 */
function tra2348Edges(tree) {
  const read = path => {
    try {
      return git(['show', `${tree}:${path}`]);
    } catch {
      return '';
    }
  };

  // (a) The CALL SITE inside the gate. The function being exported/defined proves
  // nothing — ancestry and `ls-tree` both survive a revert of the CALLER (TRA-2262).
  // And the ORDERING is load-bearing: the defect produces an EMPTY roster delta by
  // construction, so a call placed after the `strategies.length === 0` early return
  // could never fire. We require the call AND that the early return consults the
  // universe result.
  const svc = read(PROMOTION_SERVICE_PATH);
  const fn = svc.match(/export async function evaluateLiveTransitionGate\s*\([\s\S]*?\n\}/);
  const body = fn ? fn[0] : '';
  const callsUniverse = body.includes(`${UNIVERSE_SYMBOL}(`);
  const earlyReturn = body.match(/if\s*\(\s*strategies\.length === 0[\s\S]{0,160}?\)/);
  const returnGuarded = !!earlyReturn && /universeBlocks\.size/.test(earlyReturn[0]);

  // (b) The ALLOWLIST itself. A live tree that carries the call but an allowlist
  // widened to include `crypto_core` has the rule present and inert — the same
  // "orphaned but live" shape, one layer down. Compare QUOTED ENTRIES exactly:
  // 'crypto_core_live_majors' CONTAINS the substring 'crypto_core', so a substring
  // test would report the un-ratified preset present on a correct allowlist.
  const shared = read(SHARED_INDEX_PATH);
  const decl = shared.match(
    new RegExp(`export const ${ALLOWLIST_SYMBOL}[^=]*=\\s*\\[([\\s\\S]*?)\\]`),
  );
  const entries = decl ? [...decl[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
  const allowlistOk = entries.length > 0 && !entries.includes(UNRATIFIED_PRESET);

  return [
    {
      name: `TRA-2348 — ${UNIVERSE_SYMBOL} is called inside evaluateLiveTransitionGate`,
      ok: !!body && callsUniverse && returnGuarded,
      detail: !body
        ? `could not locate evaluateLiveTransitionGate in ${PROMOTION_SERVICE_PATH}`
        : !callsUniverse
          ? `the gate does not call ${UNIVERSE_SYMBOL} — a preset swap that widens the live universe is UNGATED (roster delta {dca} → {dca} is empty).`
          : returnGuarded
            ? `${UNIVERSE_SYMBOL}() called and consulted before the empty-delta early return`
            : 'the call is present but the `strategies.length === 0` early return does not consult it — the check can never fire on the very save it exists for.',
    },
    {
      name: `TRA-2348 — ${ALLOWLIST_SYMBOL} excludes '${UNRATIFIED_PRESET}'`,
      ok: allowlistOk,
      detail: !decl
        ? `${ALLOWLIST_SYMBOL} is absent from ${SHARED_INDEX_PATH} — there is no ratified-universe record to compare against.`
        : allowlistOk
          ? `allowlist = [${entries.join(', ')}]`
          : `'${UNRATIFIED_PRESET}' is ON the allowlist — the ~395-pair universe QuantTrader ruled NO-GO on (TRA-1304) would be authorized. Adding it needs a fresh live-money sign-off.`,
    },
  ];
}

const SERVICE_ID = process.env['RENDER_SERVICE_ID'] || 'srv-d7mb7rr7uimc73ev0chg';

const argv = process.argv.slice(2);
const valOf = name => {
  const hit = argv.find(a => a === name || a.startsWith(`${name}=`));
  return hit ? (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '') : undefined;
};
const BASE = (valOf('--base') || process.env['BQB1_BASE'] || 'https://tradingai-bqb1.onrender.com').replace(/\/$/, '');
const POST_ARM = valOf('--post-arm');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  const tag = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}\n       ${detail}`);
};

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function bail(msg) {
  console.error(`[tra2342] CANNOT RUN: ${msg}`);
  process.exit(2);
}

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45_000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// A PASS is only worth what the FAIL is worth. `--self-test` runs the two git-side
// predicates against 29cbb9a0 — the build bqb1 was actually running before the
// interlock was deployed, so it genuinely CONTAINS the condition being detected
// (no import, no guard) rather than being a synthetic fixture. Both must come back
// NEGATIVE; if either reports positive, this checker cannot see the hazard and its
// PASS above means nothing.
const PRE_INTERLOCK_SHA = '29cbb9a0fe885614e7b59eb34613e8a466dd11e3';

function selfTest() {
  console.log(`[tra2342] --self-test: every predicate must go NEGATIVE on the real build that PRECEDED the fix it checks`);
  console.log(`[tra2342]              interlock predicates → ${PRE_INTERLOCK_SHA.slice(0, 8)} · TRA-2351 predicates → f2f6360 · TRA-2348 predicates → 832dc92\n`);
  try {
    git(['cat-file', '-e', `${PRE_INTERLOCK_SHA}^{commit}`]);
  } catch {
    bail(`${PRE_INTERLOCK_SHA.slice(0, 8)} is not in this clone; cannot self-test. Run \`git fetch origin\`.`);
  }
  // ⚠ THE NEGATIVE CONTROL IS THE ONE THING THAT MUST NOT GUESS (TRA-3721).
  // This row asserts `ancestry === false` against a build that PRECEDES the interlock, and
  // that row is what licenses the main arm's PASS ("SELF-TEST OK" below). The old code was
  // `try { … } catch { ancestry = false }` — on a SHALLOW/grafted checkout the catch fires
  // unconditionally, so the row went green without the predicate having discriminated
  // anything at all. A positive control must CONTAIN what it detects; on a graft that one
  // contained nothing, and it is the standing pre-condition on the `TRADIER_ENV` write and
  // on arming live crypto.
  //
  // So: grade the negative, and treat "cannot tell" as CANNOT RUN (exit 2), never as a pass.
  // A self-test that cannot tell whether it discriminated has not run.
  const { verdict: ancestryVerdict, answer: ancestry } = gradedAncestry(INTERLOCK_COMMIT, PRE_INTERLOCK_SHA);
  if (ancestry === null) {
    bail(
      `the self-test's ANCESTRY negative control is UNREADABLE (${ancestryVerdict}) — ${blindReason(ancestryVerdict)}\n` +
        `           \`merge-base --is-ancestor ${INTERLOCK_COMMIT.slice(0, 8)} ${PRE_INTERLOCK_SHA.slice(0, 8)}\` returns the SAME\n` +
        '           exit code for "genuinely not an ancestor" and for "the path was grafted away", so reading it\n' +
        '           as a clean negative would print SELF-TEST OK on a control that discriminated nothing.\n' +
        '           This is CANNOT RUN, not a FAIL and emphatically not a PASS.',
    );
  }
  let engine = '';
  try {
    engine = git(['show', `${PRE_INTERLOCK_SHA}:${ENGINE_PATH}`]);
  } catch { /* absent counts as no edge */ }
  const hasImport = new RegExp(`^import\\s*\\{[^}]*\\b${GUARD_SYMBOL}\\b`, 'm').test(engine);
  const fn = engine.match(/export function shouldBootArmLiveCrypto\s*\([\s\S]*?\n\}/);
  const hasGuard = !!fn && fn[0].includes(`${GUARD_SYMBOL}(`);

  // TRA-2351 — its own negative control, against its own real pre-fix build.
  // `f2f6360` is the TRA-2343 roster-delta fix: the build QA graded, which
  // CONTAINS the third path (the route composes its own snapshot; there is no
  // boot-disarm). 29cbb9a0 would work too, but a control should sit as close to
  // the fix as possible — an older build can go negative for unrelated reasons.
  const PRE_THIRD_PATH_SHA = 'f2f63601522bdf0c9eaf4af323021fabb31db0d7';
  let thirdPathEdges;
  try {
    git(['cat-file', '-e', `${PRE_THIRD_PATH_SHA}^{commit}`]);
    thirdPathEdges = tra2351Edges(PRE_THIRD_PATH_SHA);
  } catch {
    bail(`${PRE_THIRD_PATH_SHA.slice(0, 8)} is not in this clone; cannot self-test the TRA-2351 predicates. Run \`git fetch origin\`.`);
  }

  // TRA-2348 — its own negative control, against ITS own real pre-fix build:
  // 832dc92, the commit immediately preceding the universe rule. It carries the
  // TRA-2343 roster delta and the TRA-2351 named entry point, so it goes negative
  // ONLY on the universe predicates — which is what makes it a control for this
  // rule rather than for the whole chain.
  const PRE_UNIVERSE_SHA = '832dc92428dd75ca24f789fac694bbed01fd5fd7';
  let universeEdges;
  try {
    git(['cat-file', '-e', `${PRE_UNIVERSE_SHA}^{commit}`]);
    universeEdges = tra2348Edges(PRE_UNIVERSE_SHA);
  } catch {
    bail(`${PRE_UNIVERSE_SHA.slice(0, 8)} is not in this clone; cannot self-test the TRA-2348 predicates. Run \`git fetch origin\`.`);
  }

  const checks = [
    ['ancestry reports NOT-an-ancestor', ancestry === false],
    ['import edge reports ABSENT', hasImport === false],
    ['guard call reports ABSENT (function exists but is unguarded)', hasGuard === false && !!fn],
    ...thirdPathEdges.map(e => [`${e.name} reports ABSENT on ${PRE_THIRD_PATH_SHA.slice(0, 7)}`, e.ok === false]),
    ...universeEdges.map(e => [`${e.name} reports ABSENT on ${PRE_UNIVERSE_SHA.slice(0, 7)}`, e.ok === false]),
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
    if (!ok) bad++;
  }
  console.log('');
  if (bad) {
    console.error('[tra2342] SELF-TEST FAILED — this checker cannot detect a missing interlock. Its PASS is meaningless.');
    process.exit(1);
  }
  console.log('[tra2342] SELF-TEST OK — the predicates go negative on a build that lacks the interlock.');
  process.exit(0);
}

async function main() {
  if (argv.includes('--self-test')) selfTest();
  console.log(`[tra2342] interlock ${INTERLOCK_TICKET} / commit ${INTERLOCK_COMMIT.slice(0, 7)}`);
  console.log(`[tra2342] host      ${BASE}\n`);

  // ---- read the SHA the box actually reports -------------------------------
  let live;
  try {
    const v = await getJson(`${BASE}/api/health/version`);
    live = typeof v?.commit === 'string' ? v.commit.trim() : '';
    if (!/^[0-9a-f]{40}$/i.test(live)) bail(`/api/health/version returned no usable commit: ${JSON.stringify(v?.commit)}`);
    console.log(`[tra2342] live SHA  ${live}  (startedAt ${v.startedAt}, pid ${v.pid})\n`);
  } catch (e) {
    bail(`could not read ${BASE}/api/health/version — ${e.message}. An unreachable host is NOT a pass.`);
  }

  // ---- the checker must be able to see both commits -------------------------
  for (const [sha, what] of [[INTERLOCK_COMMIT, 'the interlock commit'], [live, 'the LIVE commit']]) {
    try {
      git(['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      bail(`${what} ${sha.slice(0, 8)} is not in this clone. Run \`git fetch origin\` and re-run. An absent object is NOT a pass.`);
    }
  }

  // ---- 1. ANCESTRY ----------------------------------------------------------
  let ancestryOk = false;
  try {
    git(['merge-base', '--is-ancestor', INTERLOCK_COMMIT, live]);
    ancestryOk = true;
  } catch {
    ancestryOk = false;
  }
  record(
    'ANCESTRY — ffe656c is an ancestor of the live SHA',
    ancestryOk,
    ancestryOk
      ? `${INTERLOCK_COMMIT.slice(0, 7)} ⊆ ${live.slice(0, 8)}`
      : `${live.slice(0, 8)} does NOT contain ${INTERLOCK_COMMIT.slice(0, 7)}. The interlock is NOT live. Deploy it before arming.`,
  );

  // ---- 2. CALL SITE, read out of the LIVE tree ------------------------------
  let engine = '';
  try {
    engine = git(['show', `${live}:${ENGINE_PATH}`]);
  } catch {
    record('CALL SITE — edge out of the LIVE tree', false, `${ENGINE_PATH} is absent from the live tree ${live.slice(0, 8)}.`);
  }

  if (engine) {
    const hasImport = new RegExp(`^import\\s*\\{[^}]*\\b${GUARD_SYMBOL}\\b`, 'm').test(engine);
    // The guard must be inside shouldBootArmLiveCrypto, and BEFORE any account-derived
    // condition — the whole point is that no persisted state can reach the arm.
    const fn = engine.match(/export function shouldBootArmLiveCrypto\s*\([\s\S]*?\n\}/);
    const body = fn ? fn[0] : '';
    const guardIdx = body.indexOf(`${GUARD_SYMBOL}(`);
    const settingsIdx = body.search(/settings\.\w|isLiveBrokerOperator\(/);
    const hasGuard = guardIdx !== -1;
    const guardFirst = hasGuard && (settingsIdx === -1 || guardIdx < settingsIdx);

    record(
      'CALL SITE — import edge in the LIVE tree',
      hasImport,
      hasImport ? `import { ${GUARD_SYMBOL} } present in ${ENGINE_PATH}` : `no import of ${GUARD_SYMBOL} — module is orphaned/unreachable.`,
    );
    record(
      'CALL SITE — guard invoked inside shouldBootArmLiveCrypto',
      hasGuard && !!body,
      body
        ? hasGuard
          ? `${GUARD_SYMBOL}(env) called in shouldBootArmLiveCrypto`
          : 'shouldBootArmLiveCrypto exists but does NOT call the guard — the caller was reverted.'
        : 'could not locate shouldBootArmLiveCrypto in the live tree.',
    );
    record(
      'CALL SITE — guard precedes every account-derived condition',
      guardFirst,
      guardFirst
        ? 'guard is the first predicate; no persisted state can reach the arm'
        : 'guard runs AFTER an account-derived check — persisted state can short-circuit ahead of it.',
    );

    let hasModule = false;
    try {
      hasModule = git(['ls-tree', '-r', '--name-only', live, '--', FLAG_MODULE]).trim() === FLAG_MODULE;
    } catch { /* fall through as false */ }
    record('CALL SITE — flag module present in the LIVE tree', hasModule, hasModule ? FLAG_MODULE : `${FLAG_MODULE} missing from ${live.slice(0, 8)}`);
  }

  // ---- 4. TRA-2351 — the third path, and the inherited-arm gap ---------------
  let thirdPathAncestry = false;
  try {
    git(['cat-file', '-e', `${THIRD_PATH_COMMIT}^{commit}`]);
    try {
      git(['merge-base', '--is-ancestor', THIRD_PATH_COMMIT, live]);
      thirdPathAncestry = true;
    } catch { /* not an ancestor */ }
    record(
      `TRA-2351 — ${THIRD_PATH_COMMIT.slice(0, 7)} is an ancestor of the live SHA`,
      thirdPathAncestry,
      thirdPathAncestry
        ? `${THIRD_PATH_COMMIT.slice(0, 7)} ⊆ ${live.slice(0, 8)}`
        : `${live.slice(0, 8)} does NOT contain ${THIRD_PATH_COMMIT.slice(0, 7)}. The crypto-start bypass is OPEN. Deploy it before arming.`,
    );
    for (const e of tra2351Edges(live)) record(e.name, e.ok, e.detail);
  } catch {
    record(
      `TRA-2351 — ${THIRD_PATH_COMMIT.slice(0, 7)} is an ancestor of the live SHA`,
      false,
      `${THIRD_PATH_COMMIT.slice(0, 8)} is not in this clone. Run \`git fetch origin\`. An absent object is NOT a pass.`,
    );
  }

  // ---- 3. CARRIER not positively set ---------------------------------------
  let carrierOn = false;
  const renderKey = process.env['RENDER_API_KEY'];
  if (!renderKey) {
    record('CARRIER — LIVE_CRYPTO_BOOT_ARM not positively set', null, 'RENDER_API_KEY absent — carrier NOT verified. Check it by hand before arming.');
    // An unread carrier is an unknown, and this script treats unknowns as hazards
    // — so the TRA-2348 tier below escalates rather than softening.
    carrierOn = true;
  } else {
    try {
      const r = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars?limit=100`, {
        headers: { Authorization: `Bearer ${renderKey}`, Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const rows = (await r.json()).map(x => x.envVar ?? x);
      const hit = rows.find(x => x?.key === CARRIER_KEY);
      const raw = hit?.value;
      // Mirrors flagOn() in live-crypto-boot-arm-flag.ts.
      const on = typeof raw === 'string' && ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
      record(
        'CARRIER — LIVE_CRYPTO_BOOT_ARM not positively set',
        !on,
        on ? `${CARRIER_KEY}=${JSON.stringify(raw)} — the arm is ENABLED. This is a real-money crypto arm.` : hit ? `${CARRIER_KEY}=${JSON.stringify(raw)} → OFF` : `${CARRIER_KEY} absent → OFF (compiled default)`,
      );
      carrierOn = on;
    } catch (e) {
      record('CARRIER — LIVE_CRYPTO_BOOT_ARM not positively set', false, `could not read the service env: ${e.message}`);
      carrierOn = true; // unread ⇒ treated as reachable, same as the no-key branch
    }
  }

  // ---- 5. TRA-2348 — the UNIVERSE the arm may trade -------------------------
  //
  // SEVERITY IS SCOPED ON PURPOSE, and this is the part to read before editing.
  // Checks 1–4 all guard "live crypto must not be ARMED", which is a genuine
  // precondition of `TRADIER_ENV=production` (that write force-writes mode:'live',
  // which is what makes an arm reachable at all). TRA-2348 is different in kind:
  // it bounds the UNIVERSE a crypto arm may trade ONCE ARMED. With the carrier OFF
  // and checks 1–4 passing, no arm can be created or inherited, so failing the
  // equity go-live step on a crypto-universe rule would be a FALSE BLOCKER on the
  // critical path (TRA-1648/TRA-1575) — the shape that turns a safety control into
  // something people route around.
  //
  // So it escalates with reachability rather than being softened: a HARD FAIL when
  // the crypto arm is reachable (carrier ON, carrier UNREADABLE, or `--crypto-arm`
  // passed by someone actually authorizing live crypto), and a loud NOTICE that is
  // named in the verdict line otherwise. A NOTICE is not a pass, and it is not a
  // SKIP either: the predicate RAN and came back negative. Do not "simplify" this
  // into an unconditional check — read the paragraph above first.
  const cryptoArmReachable = carrierOn || argv.includes('--crypto-arm');
  const notices = [];
  const recordUniverse = (name, ok, detail) => {
    if (ok || cryptoArmReachable) return record(name, ok, detail);
    notices.push({ name, detail });
    console.log(`[NOTE] ${name}\n       ${detail}`);
  };

  let universeAncestry = false;
  try {
    git(['cat-file', '-e', `${UNIVERSE_COMMIT}^{commit}`]);
    try {
      git(['merge-base', '--is-ancestor', UNIVERSE_COMMIT, live]);
      universeAncestry = true;
    } catch { /* not an ancestor */ }
    recordUniverse(
      `TRA-2348 — ${UNIVERSE_COMMIT.slice(0, 7)} is an ancestor of the live SHA`,
      universeAncestry,
      universeAncestry
        ? `${UNIVERSE_COMMIT.slice(0, 7)} ⊆ ${live.slice(0, 8)}`
        : `${live.slice(0, 8)} does NOT contain ${UNIVERSE_COMMIT.slice(0, 7)}. On this build a live preset swap to the ~395-pair universe is UNGATED (roster delta {dca} → {dca} is empty). LIVE CRYPTO MUST NOT BE ARMED until it is deployed.`,
    );
    for (const e of tra2348Edges(live)) recordUniverse(e.name, e.ok, e.detail);
  } catch {
    recordUniverse(
      `TRA-2348 — ${UNIVERSE_COMMIT.slice(0, 7)} is an ancestor of the live SHA`,
      false,
      `${UNIVERSE_COMMIT.slice(0, 8)} is not in this clone. Run \`git fetch origin\`. An absent object is NOT a pass.`,
    );
  }

  // ---- POST-ARM (TRA-2342 step 3) ------------------------------------------
  // Only meaningful on the boot that FOLLOWS the env write. Requires mode==='live':
  // without it the equity boot-arm never ran, the crypto arm was never reached, and
  // `liveCryptoAutoTradingEnabled:false` is false for the boring reason — a marker
  // that was already satisfied before the action (TRA-2308).
  if (POST_ARM !== undefined) {
    const writtenAt = Date.parse(POST_ARM);
    if (!Number.isFinite(writtenAt)) bail('--post-arm needs the ISO timestamp of the TRADIER_ENV write, e.g. --post-arm=2026-07-28T13:00:00Z');
    try {
      const h = await getJson(`${BASE}/api/health/crypto-live`);
      const started = Date.parse(h?.build?.startedAt ?? '');
      const fresh = Number.isFinite(started) && started > writtenAt;
      record('POST-ARM — container booted AFTER the env write', fresh, `startedAt ${h?.build?.startedAt} vs write ${new Date(writtenAt).toISOString()}`);
      record(
        'POST-ARM — mode is live (proves the arming path was actually entered)',
        h?.mode === 'live',
        h?.mode === 'live' ? 'mode=live' : `mode=${h?.mode} — the equity boot-arm did NOT run, so this read does not exercise the interlock. NOT a pass.`,
      );
      record(
        'POST-ARM — liveCryptoAutoTradingEnabled is false (the interlock HELD)',
        h?.liveCryptoAutoTradingEnabled === false,
        h?.liveCryptoAutoTradingEnabled === false ? 'liveCryptoAutoTradingEnabled=false' : 'LIVE CRYPTO IS ARMED — unset TRADIER_ENV and disarm immediately.',
      );
      console.log(`       (liveCryptoBrokerConfigured=${h?.liveCryptoBrokerConfigured} is EXPECTED true — creds are deliberately retained per TRA-2336 and are not the arm.)`);
    } catch (e) {
      bail(`could not read ${BASE}/api/health/crypto-live — ${e.message}`);
    }
  }

  // ---- verdict --------------------------------------------------------------
  const failed = results.filter(r => r.ok === false);
  const skipped = results.filter(r => r.ok === null);
  console.log('');
  if (failed.length) {
    // TRA-2348 — name the REMEDY that matches the failure. A universe failure does
    // not mean "do not set TRADIER_ENV"; it means "do not arm live crypto on this
    // build". Emitting the wrong remedy is how a refusal reads as a deadlock and
    // gets routed around (TRA-2351 hit exactly this with the empty-roster text).
    const universeFailed = failed.filter(f => f.name.startsWith('TRA-2348'));
    const interlockFailed = failed.filter(f => !f.name.startsWith('TRA-2348'));
    console.error(`[tra2342] NOT PROVEN — ${failed.length} check(s) FAILED.`);
    if (interlockFailed.length) {
      console.error('          INTERLOCK — do NOT set TRADIER_ENV=production:');
      for (const f of interlockFailed) console.error(`          - ${f.name}`);
    }
    if (universeFailed.length) {
      console.error(`          UNIVERSE (TRA-2348) — do NOT arm live crypto on this build; deploy ${UNIVERSE_COMMIT.slice(0, 7)} first:`);
      for (const f of universeFailed) console.error(`          - ${f.name}`);
      if (!interlockFailed.length) {
        console.error('          (the equity TRADIER_ENV=production step is NOT blocked by these — every interlock check above passed.)');
      }
    }
    process.exit(1);
  }
  console.log(`[tra2342] INTERLOCK LIVE — ${results.length - skipped.length} check(s) passed${skipped.length ? `, ${skipped.length} SKIPPED (see above)` : ''}.`);
  if (skipped.length) console.log('[tra2342] a SKIPPED check is not a passed check.');
  if (notices.length) {
    console.log(`[tra2342] ${notices.length} NOTICE(s) — the equity arming step is clear, but LIVE CRYPTO MUST NOT BE ARMED on this build:`);
    for (const n of notices) console.log(`          - ${n.name}`);
    console.log('[tra2342] re-run with --crypto-arm before authorizing live crypto; these become hard FAILs there.');
  }
  process.exit(0);
}

main().catch(e => bail(e?.stack ?? String(e)));
