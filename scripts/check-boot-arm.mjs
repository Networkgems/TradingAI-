#!/usr/bin/env node
// check-boot-arm.mjs — TRA-2649
//
// THE FALSIFIABLE SIGNATURE: `bootArmEligible: true` AND `bootArmDrift` NON-EMPTY.
//
// That pair is a contradiction the route's own doc says must never hold: "`bootArmDrift`
// … should be EMPTY on a healthy prod boot, because `createUserContext` repairs them at
// startup; a non-empty list here means the repair could not run (or something rewrote the
// operator after boot)." It needs no credentials to read — `/api/health/options-live` is
// unauthenticated and secrets-free — which is the whole point: the board and desk cannot
// log in to bqb1, so the only regression guard that can actually run is one built on this
// probe.
//
// WHAT IT CAUGHT (2026-07-30, bqb1)
// ---------------------------------
//     bootArmEligible          TRUE
//     bootArmDrift             ["mode"]
//     optionsBrokerConfigured  FALSE      ← the board-ratified options arm, INERT
//
// Root cause, from the Render logs: the boot-arm CONVERGED correctly at 05:38:26Z
// (`repaired:["mode"]`, `mode:"live"`, persist logged OK), and a later request-scoped
// `saveSettings` demoted `mode` back to `demo` — at 04:49:18Z and again at 12:36:25Z.
// The demoting writes carry a request `traceId`; the boot write does not. That is the
// discriminator, and it is invisible from outside, which is why this guard grades the
// STATE and the fix (TRA-2649) makes the CAUSE self-naming via `bootArmRanAt` /
// `bootArmPersistError` / `bootArmWriteRepairs`.
//
// WHY "drift is empty" IS NOT THE PREDICATE — THE VACUITY TRAP
// -----------------------------------------------------------
// `resolveLiveBrokerArmDrift` returns [] IMMEDIATELY when `shouldBootArmLiveEquity` is
// false. So on any service where the arm is disarmed — a sandbox box, or bqb1 itself
// after someone clears `LIVE_EQUITY_BOOT_USER` — `bootArmDrift` is [] BY CONSTRUCTION
// and a naive "drift is empty ⇒ pass" reads GREEN off a cohort of zero. The guard would
// then be satisfiable by disarming the very thing it exists to protect.
//
// So `bootArmEligible: false` is NOT MEASURED, never a pass. Control 3 in `--selftest`
// pins that direction, and it is the control that matters: without it this script's
// green is unfalsifiable.
//
// USAGE
//   node scripts/check-boot-arm.mjs                       # grade live bqb1
//   node scripts/check-boot-arm.mjs --host=https://…      # grade another service
//   node scripts/check-boot-arm.mjs --payload=file.json   # grade a saved pull
//   node scripts/check-boot-arm.mjs --selftest            # controls, both directions
//
// EXIT CODES — every verdict is PRINTED before any return, so a caller reading stdout is
// never at the mercy of which axis won the exit code (the TRA-2642 lesson: a multi-axis
// checker's exit code cannot carry the verdict). Ranked RED > NOT MEASURED > GREEN:
//   0  ARMED        — eligible AND drift empty. The ratified arm is converged.
//   1  DRIFTED      — eligible AND drift non-empty. THE regression. Options arm inert.
//   2  NOT MEASURED — the arm is not eligible here, so drift is [] vacuously and this
//                     service cannot be graded. Never a pass.
//   3  BLIND        — could not read the probe, or it predates the TRA-2649 fields.
//                     Never a pass.

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
const TIMEOUT_MS = 45_000;

const EXIT_ARMED = 0;
const EXIT_DRIFTED = 1;
const EXIT_NOT_MEASURED = 2;
const EXIT_BLIND = 3;

/**
 * Pure grader. `payload` is the parsed `/api/health/options-live` body, or null when the
 * fetch itself failed. Returns { exit, verdict, lines[] } — the selftest drives this
 * EXACT function, so a control can never pass against a different code path than live.
 */
export function gradeBootArm(payload) {
  const lines = [];
  if (payload == null || typeof payload !== 'object') {
    lines.push('BLIND — no readable /api/health/options-live payload.');
    lines.push('  This is NOT a pass. An unreachable probe proves nothing about the arm.');
    return { exit: EXIT_BLIND, verdict: 'BLIND', lines };
  }

  const eligible = payload.bootArmEligible;
  const drift = payload.bootArmDrift;

  // Fields absent ⇒ the deploy predates the probe, or the route changed shape. Either
  // way we cannot grade — and must not read "undefined is not non-empty" as green.
  if (typeof eligible !== 'boolean' || !Array.isArray(drift)) {
    lines.push('BLIND — payload lacks `bootArmEligible` (boolean) and/or `bootArmDrift` (array).');
    lines.push(`  saw bootArmEligible=${JSON.stringify(eligible)} bootArmDrift=${JSON.stringify(drift)}`);
    lines.push('  Likely a build older than TRA-1652, or a changed route contract. Not a pass.');
    return { exit: EXIT_BLIND, verdict: 'BLIND', lines };
  }

  lines.push(`operator                ${payload.operator ?? '(absent)'}`);
  lines.push(`mode                    ${payload.mode ?? '(absent)'}`);
  lines.push(`bootArmEligible         ${eligible}`);
  lines.push(`bootArmDrift            ${JSON.stringify(drift)}`);
  lines.push(`optionsBrokerConfigured ${payload.optionsBrokerConfigured ?? '(absent)'}`);

  if (!eligible) {
    lines.push('');
    lines.push('NOT MEASURED — the live-broker arm is not eligible on this service.');
    lines.push('  `resolveLiveBrokerArmDrift` short-circuits to [] when `shouldBootArmLiveEquity`');
    lines.push('  is false, so the empty drift above is VACUOUS — it is not evidence of health.');
    lines.push('  Eligibility needs: the LIVE_EQUITY_BOOT_USER pin naming this operator,');
    lines.push('  TRADIER_ENV=production, and resolvable production Tradier creds.');
    lines.push(`  bootArmPinConfigured=${payload.bootArmPinConfigured} serviceTradierEnv=${payload.serviceTradierEnv}`);
    lines.push('  Grade a service where the arm is armed, or this guard grades nothing.');
    return { exit: EXIT_NOT_MEASURED, verdict: 'NOT MEASURED', lines };
  }

  if (drift.length === 0) {
    lines.push('');
    lines.push('ARMED — eligible and fully converged. `bootArmDrift` is empty on an ELIGIBLE');
    lines.push('  operator, which is the non-vacuous green.');
    if (Number(payload.bootArmWriteRepairs) > 0) {
      lines.push('');
      lines.push(`  NOTE: bootArmWriteRepairs=${payload.bootArmWriteRepairs} (last ${payload.bootArmLastWriteRepairAt}).`);
      lines.push('  The arm is converged because the TRA-2649 write-path repair CAUGHT a demoting');
      lines.push('  settings write. Something is still trying to disarm the operator — find it.');
    }
    return { exit: EXIT_ARMED, verdict: 'ARMED', lines };
  }

  // ── The regression. Name the cause from the TRA-2649 fields. ──
  lines.push('');
  lines.push(`DRIFTED — bootArmEligible is TRUE and bootArmDrift is ${JSON.stringify(drift)}.`);
  lines.push('  Every precondition for the arm holds and the arm did not take. The');
  lines.push('  board-ratified live arm is INERT: live signals generate and nothing routes.');
  lines.push('');

  const ranAt = payload.bootArmRanAt;
  const persistError = payload.bootArmPersistError;
  if (ranAt === undefined) {
    lines.push('  CAUSE: unknown — this build predates the TRA-2649 attribution fields');
    lines.push('  (`bootArmRanAt` / `bootArmPersistError`). Deploy the fix to get a cause here,');
    lines.push('  or read the Render logs for `boot-arm` and `saveSettings: persisted`.');
  } else if (ranAt === null) {
    lines.push('  CAUSE: the boot-arm NEVER RAN for this operator on this boot. The user');
    lines.push('  context was materialised without `createUserContext`, or has not been built');
    lines.push('  yet. Check the boot sequence / `initAllUserContexts`.');
  } else if (persistError != null) {
    lines.push(`  CAUSE: the boot-arm ran at ${ranAt} and the force-persist THREW:`);
    lines.push(`    ${persistError}`);
    lines.push('  The engine is Live in memory while the persisted operator stays demoted.');
    lines.push('  Logged at ERROR since TRA-2649 — check disk/db health for the settings row.');
  } else {
    lines.push(`  CAUSE: the boot-arm ran CLEAN at ${ranAt} (repaired ${JSON.stringify(payload.bootArmRepairedAtBoot)},`);
    lines.push('  no persist error) and the operator was REWRITTEN AFTERWARDS. This is the');
    lines.push('  TRA-2649 signature. Look for a request-scoped `saveSettings: persisted` line');
    lines.push('  with `mode:"demo"` and a `traceId` — the boot write carries no traceId.');
    lines.push(`  bootArmWriteRepairs=${payload.bootArmWriteRepairs ?? '(absent)'} — if 0 with the fix`);
    lines.push('  deployed, the rewriter is NOT the settings PUT; widen the search.');
  }
  return { exit: EXIT_DRIFTED, verdict: 'DRIFTED', lines };
}

function report(result) {
  for (const l of result.lines) console.log(l);
  console.log('');
  console.log(`VERDICT: ${result.verdict} (exit ${result.exit})`);
  return result.exit;
}

// ── selftest ────────────────────────────────────────────────────────────────
if (process.argv.includes('--selftest')) {
  const base = {
    operator: 'admin',
    bootArmPinConfigured: true,
    serviceTradierEnv: 'production',
    optionsBrokerConfigured: false,
  };
  const controls = [
    // 1 — TEETH. The literal bqb1 payload of 2026-07-30T05:2xZ. Must be RED.
    ['1 teeth: the TRA-2649 payload (eligible + drift ["mode"])',
      { ...base, mode: 'demo', bootArmEligible: true, bootArmDrift: ['mode'] }, EXIT_DRIFTED],
    // 2 — GREEN, non-vacuous: eligible AND converged.
    ['2 green: eligible and converged',
      { ...base, mode: 'live', bootArmEligible: true, bootArmDrift: [], optionsBrokerConfigured: true }, EXIT_ARMED],
    // 3 — THE VACUITY CONTROL. Disarming the arm must NOT read green. Without this
    //     control the guard is satisfiable by turning off the thing it protects.
    ['3 vacuity: NOT eligible + empty drift must NOT be green',
      { ...base, mode: 'demo', bootArmEligible: false, bootArmDrift: [] }, EXIT_NOT_MEASURED],
    // 4 — old build / changed contract must be BLIND, not green.
    ['4 blind: fields absent',
      { ...base, mode: 'demo' }, EXIT_BLIND],
    // 5 — unreachable probe must be BLIND, not green.
    ['5 blind: no payload at all', null, EXIT_BLIND],
    // 6 — drift on a non-`mode` field is equally a regression.
    ['6 teeth: drift on liveTradierEnvOptions (the TRA-1652 shape)',
      { ...base, mode: 'live', bootArmEligible: true, bootArmDrift: ['liveTradierEnvOptions'] }, EXIT_DRIFTED],
  ];

  // Cause-attribution controls — same RED exit, but the NAMED cause must differ.
  const causes = [
    ['rewritten after boot', { bootArmRanAt: '2026-07-30T05:38:26.537Z', bootArmPersistError: null, bootArmRepairedAtBoot: ['mode'] }, 'REWRITTEN AFTERWARDS'],
    ['persist threw', { bootArmRanAt: '2026-07-30T05:38:26.537Z', bootArmPersistError: 'EROFS: read-only file system' }, 'force-persist THREW'],
    ['arm never ran', { bootArmRanAt: null, bootArmPersistError: null }, 'NEVER RAN'],
    ['pre-fix build', {}, 'predates the TRA-2649 attribution fields'],
  ];

  let failed = 0;
  for (const [name, payload, want] of controls) {
    const got = gradeBootArm(payload).exit;
    const ok = got === want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  control ${name} → exit ${got} (want ${want})`);
  }
  for (const [name, extra, wantText] of causes) {
    const r = gradeBootArm({ ...base, mode: 'demo', bootArmEligible: true, bootArmDrift: ['mode'], ...extra });
    const text = r.lines.join('\n');
    const ok = r.exit === EXIT_DRIFTED && text.includes(wantText);
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  cause "${name}" → names ${JSON.stringify(wantText)}`);
  }
  console.log('');
  if (failed > 0) {
    console.log(`selftest: ${failed} control(s) FAILED — this guard is not trustworthy.`);
    process.exit(1);
  }
  console.log('selftest: all controls pass, both directions (teeth, green, vacuity, blind, causes).');
  process.exit(0);
}

// ── live path ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const hostArg = args.find(a => a.startsWith('--host='))?.slice('--host='.length);
const payloadArg = args.find(a => a.startsWith('--payload='))?.slice('--payload='.length);
const host = (hostArg ?? DEFAULT_HOST).replace(/\/$/, '');

let payload = null;
if (payloadArg) {
  try {
    const { readFileSync } = await import('node:fs');
    payload = JSON.parse(readFileSync(payloadArg, 'utf-8'));
    console.log(`source: ${payloadArg} (saved payload)`);
  } catch (err) {
    console.log(`could not read --payload=${payloadArg}: ${err.message}`);
  }
} else {
  const url = `${host}/api/health/options-live`;
  console.log(`source: ${url}`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      console.log(`probe returned HTTP ${res.status}`);
    } else {
      payload = await res.json();
    }
  } catch (err) {
    console.log(`probe unreachable: ${err.message}`);
  }
}
console.log('');
process.exit(report(gradeBootArm(payload)));
