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
//
// `--post-arm=<iso>` additionally runs the TRA-2342 step-3 post-condition against
// /api/health/crypto-live. See POST-ARM below.
//
// FAIL-CLOSED. Every unknown is a FAIL, never a pass: an unfetched SHA, an
// unreachable host and a malformed payload all exit non-zero. A checker that goes
// quiet when it cannot see is the TRA-1695 failure (a guard that cannot tell "I am
// broken" from "subject is fine").
//
// Exit codes: 0 = interlock LIVE. 1 = a check FAILED. 2 = the checker could not run.

import { execFileSync } from 'node:child_process';

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
  console.log(`[tra2342]              interlock predicates → ${PRE_INTERLOCK_SHA.slice(0, 8)} · TRA-2351 predicates → f2f6360\n`);
  try {
    git(['cat-file', '-e', `${PRE_INTERLOCK_SHA}^{commit}`]);
  } catch {
    bail(`${PRE_INTERLOCK_SHA.slice(0, 8)} is not in this clone; cannot self-test. Run \`git fetch origin\`.`);
  }
  let ancestry;
  try {
    git(['merge-base', '--is-ancestor', INTERLOCK_COMMIT, PRE_INTERLOCK_SHA]);
    ancestry = true;
  } catch {
    ancestry = false;
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

  const checks = [
    ['ancestry reports NOT-an-ancestor', ancestry === false],
    ['import edge reports ABSENT', hasImport === false],
    ['guard call reports ABSENT (function exists but is unguarded)', hasGuard === false && !!fn],
    ...thirdPathEdges.map(e => [`${e.name} reports ABSENT on ${PRE_THIRD_PATH_SHA.slice(0, 7)}`, e.ok === false]),
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
  const renderKey = process.env['RENDER_API_KEY'];
  if (!renderKey) {
    record('CARRIER — LIVE_CRYPTO_BOOT_ARM not positively set', null, 'RENDER_API_KEY absent — carrier NOT verified. Check it by hand before arming.');
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
    } catch (e) {
      record('CARRIER — LIVE_CRYPTO_BOOT_ARM not positively set', false, `could not read the service env: ${e.message}`);
    }
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
    console.error(`[tra2342] INTERLOCK NOT PROVEN — ${failed.length} check(s) FAILED. Do NOT set TRADIER_ENV=production.`);
    for (const f of failed) console.error(`          - ${f.name}`);
    process.exit(1);
  }
  console.log(`[tra2342] INTERLOCK LIVE — ${results.length - skipped.length} check(s) passed${skipped.length ? `, ${skipped.length} SKIPPED (see above)` : ''}.`);
  if (skipped.length) console.log('[tra2342] a SKIPPED check is not a passed check.');
  process.exit(0);
}

main().catch(e => bail(e?.stack ?? String(e)));
