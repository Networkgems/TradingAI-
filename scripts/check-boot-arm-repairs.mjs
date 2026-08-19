#!/usr/bin/env node
// check-boot-arm-repairs.mjs — TRA-3810 (parent TRA-3809 → grandparent TRA-2649)
//
// THE FALSIFIABLE SIGNATURE: a DURABLE record of an attempt to demote the pinned
// real-money operator off the board-ratified live-broker arm.
//
// ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
// Someone attempted to stand down the live real-money arm on bqb1 at
// 2026-08-16T18:42:20.569Z. The entire observable footprint was one `log.warn` line (on
// a log surface the board/desk cannot read) and `bootArmWriteRepairs`, a since-boot
// counter. NO alarm read either. It became visible only because the TRA-2649 daily
// boot-arm guard's step 5 forces the counter into its report and a human read it.
//
// ── WHY THIS IS NOT `bootArmWriteRepairs > 0` ────────────────────────────────
// That counter is a SINCE-BOOT DELTA and is broken as an alarm basis in BOTH directions:
//
//   • `0` reads IDENTICALLY for "the write path is clean" and "the write path has never
//     been exercised". The 2026-08-13 guard fire (TRA-3549) recorded `0`; that was never
//     evidence the TRA-2649 fix worked. The 08-16 non-zero was the first actual proof.
//   • A REDEPLOY ZEROES IT, so an alarm on it self-clears on every deploy and the
//     observability window is bounded by the current process lifetime.
//
// So it pins OFF exactly when it matters and can never separate "no attempt" from "not
// looking". This grader is bound to `bootArmRepairLedger` — the durable, append-only
// record under DATA_DIR — and NOT to the counter. The counter is printed as a liveness
// cross-check of the current process and never colours the verdict.
//
// ── WHY THERE ARE FOUR EXITS FOR THREE STATES ────────────────────────────────
// The ledger's three states are `attempts_recorded` / `no_attempt_observed` /
// `instrument_blind`. `no_attempt_observed` splits here, because an absence is only a
// pass if it was measured over a real window: the ledger publishes `observingSinceMs`
// (earliest per-boot observation marker), and a zero-attempt read whose window is null or
// shorter than `--min-window-days` is an assertion about nothing. It exits NOT MEASURED,
// not CLEAN. Without that split a freshly-wiped ledger — the exact post-redeploy state
// that made the old counter useless — would read green on its first second of life.
//
// PRECEDENCE: ATTEMPTS > BLIND > NOT MEASURED > CLEAN. Attempts outrank blindness because
// a positive is true whatever the coverage is; blindness bounds what an ABSENCE proves.
// Ranking blind first would let a stray `appendErrors` demote a real live-money demotion
// attempt into a plumbing complaint.
//
// ── ACKNOWLEDGEMENTS (TRA-3852) ──────────────────────────────────────────────
// `retentionDays` is 180 and the grade was `attempts > 0 → exit 1`, so ONE settled event
// pinned the alarm ON for half a year. The 2026-08-17 event (TRA-3833) did exactly that:
// every daily fire from 2026-08-19 would have shouted ATTEMPTS about an already-fixed
// cause, and the sixth recurrence of the boot-arm family would have arrived inside that
// noise. An alarm nobody can read is not an alarm.
//
// An ack pins ONE event and self-voids. It is deliberately built to LOOSEN the pass in the
// narrowest possible way while TIGHTENING the fail:
//   • Identity, never class. Matched on exact `at` + `origin` + `repaired` SET +
//     `bodyFields.length`. A NEW attempt has a different timestamp and still exits 1, even
//     if it is the same writer doing the same thing.
//   • `fixCommit` must be an ANCESTOR OF THE SERVING COMMIT. Roll the fix back and every
//     ack it underwrites goes void and the event alarms again — a rollback the old
//     unconditional exit 1 could not have distinguished from the steady state.
//   • Undeterminable ancestry (no git, unknown sha, no serving commit) does NOT apply the
//     ack. Fail closed.
//   • Acked events are still PRINTED in full, every fire. An ack changes the exit code and
//     nothing else; the record is never erased.
//   • `events.length !== attempts` (truncation/retention) means the un-acked ones cannot be
//     enumerated, so no ack can clear the ledger. Fail closed.
//   • An all-acked ledger is asserting an ABSENCE of NEW attempts, so it falls through into
//     the blindness and window-floor checks that guard every other absence here. A blind or
//     unmeasured instrument can never reach the acknowledged pass.
//
// USAGE
//   node scripts/check-boot-arm-repairs.mjs                    # grade live bqb1
//   node scripts/check-boot-arm-repairs.mjs --host=https://…   # grade another service
//   node scripts/check-boot-arm-repairs.mjs --payload=f.json   # grade a saved pull
//   node scripts/check-boot-arm-repairs.mjs --min-window-days=7
//   node scripts/check-boot-arm-repairs.mjs --acks=path.json   # default: scripts/boot-arm-repair-acks.json
//   node scripts/check-boot-arm-repairs.mjs --no-acks          # grade as if nothing were acked
//   node scripts/check-boot-arm-repairs.mjs --serving-commit=<sha>   # required with --payload
//   node scripts/check-boot-arm-repairs.mjs --selftest         # controls, all directions
//
// EXIT CODES — every verdict is PRINTED before any return, so a caller reading stdout is
// never at the mercy of which axis won the exit code (the TRA-2642 lesson).
//   0  CLEAN        — zero attempts, instrument sound, over a window ≥ the floor.
//                     The ONLY pass, and the only one with a non-empty denominator.
//                     Also the verdict ATTEMPTS-ACKNOWLEDGED: history on record, every
//                     event pinned to a settled issue whose fix is STILL SERVING, and no
//                     new one since — over a real window, on a sound instrument.
//   1  ATTEMPTS     — ≥ 1 durable demotion attempt on record that is not acknowledged (or
//                     whose ack has gone void). THE alarm.
//   2  NOT MEASURED — instrument sound, zero attempts, but the observation window is
//                     absent or shorter than the floor. Vacuous. Never a pass.
//   3  BLIND        — the record cannot be trusted (not hydrated / ephemeral DATA_DIR /
//                     swallowed appends / arm not eligible), or the probe is unreachable
//                     or predates the TRA-3810 field. Never a pass.

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
const TIMEOUT_MS = 45_000;
const DEFAULT_MIN_WINDOW_DAYS = 1;

const EXIT_CLEAN = 0;
const EXIT_ATTEMPTS = 1;
const EXIT_NOT_MEASURED = 2;
const EXIT_BLIND = 3;

/** Human-readable expansion of each blind reason the ledger can publish. */
const BLIND_REASON_TEXT = {
  not_hydrated:
    'no boot hydrate ran — the ledger is memory-only and NOTHING is durable.',
  ephemeral_data_dir:
    'DATA_DIR resolves inside the build bundle, so every row evaporates on the next '
    + 'redeploy. This degrades the ledger back into the since-boot counter it replaces. '
    + 'The fix is DATA_DIR=/data on the service (TRA-1719), not code.',
  append_errors:
    'at least one append THREW and was swallowed — the record is incomplete, so any '
    + 'count below is a LOWER BOUND.',
  arm_not_eligible:
    'the live-broker arm is not eligible on this service (or eligibility was not '
    + 'reported). `applyLiveBrokerArm` then returns [] unconditionally, so NO repair can '
    + 'ever be recorded and an empty ledger is empty BY CONSTRUCTION. Same vacuity trap '
    + 'as check-boot-arm.mjs control 3.',
};

const ACK_REQUIRED_KEYS = ['at', 'origin', 'repaired', 'bodyFieldCount', 'issue', 'fixCommit'];

/** Identity of ONE ledger event. Deliberately includes the timestamp: acks never generalise. */
function eventFingerprint(e) {
  const repaired = Array.isArray(e?.repaired) ? [...e.repaired].sort() : [];
  const bodyFieldCount = Array.isArray(e?.bodyFields) ? e.bodyFields.length : 0;
  return JSON.stringify([String(e?.at ?? ''), String(e?.origin ?? ''), repaired, bodyFieldCount]);
}

function ackFingerprint(a) {
  const repaired = Array.isArray(a?.repaired) ? [...a.repaired].sort() : [];
  return JSON.stringify([String(a?.at ?? ''), String(a?.origin ?? ''), repaired, Number(a?.bodyFieldCount)]);
}

/**
 * Decide which acks actually apply. `isFixServing(sha)` returns true / false / null, where
 * null means "could not determine" — which does NOT apply the ack. Every rejection path
 * here is reported by the caller; an ack is never silently dropped.
 */
export function classifyAcks(events, acks, isFixServing) {
  const byFingerprint = new Map();
  for (const e of events) byFingerprint.set(eventFingerprint(e), e);

  const applied = new Set();   // fingerprints cleared
  const accepted = [];         // { ack, event }
  const malformed = [];        // { ack, why }
  const voided = [];           // { ack, why } — matched an event but the fix is not serving
  const orphaned = [];         // { ack } — well-formed, fix serving, but no such event

  for (const ack of acks) {
    const missing = ACK_REQUIRED_KEYS.filter((k) => ack?.[k] === undefined || ack?.[k] === null);
    if (missing.length > 0 || !Array.isArray(ack.repaired) || !Number.isFinite(Number(ack.bodyFieldCount))) {
      malformed.push({ ack, why: missing.length > 0 ? `missing ${missing.join(', ')}` : 'repaired must be an array and bodyFieldCount a number' });
      continue;
    }
    const serving = isFixServing(String(ack.fixCommit));
    if (serving !== true) {
      voided.push({
        ack,
        why: serving === false
          ? `fixCommit ${ack.fixCommit} is NOT an ancestor of the serving commit — the fix ROLLED BACK`
          : `could not determine whether fixCommit ${ack.fixCommit} is in the serving build`,
      });
      continue;
    }
    const fp = ackFingerprint(ack);
    const event = byFingerprint.get(fp);
    if (!event) { orphaned.push({ ack }); continue; }
    applied.add(fp);
    accepted.push({ ack, event });
  }
  return { applied, accepted, malformed, voided, orphaned };
}

/**
 * Pure grader. `payload` is the parsed `/api/health/options-live` body, or null when the
 * fetch itself failed. Returns { exit, verdict, lines[] } — the selftest drives this
 * EXACT function, so a control can never pass against a different code path than live.
 *
 * `opts.acks` / `opts.isFixServing` carry the TRA-3852 acknowledgement ledger; omitting
 * them grades exactly as the pre-TRA-3852 guard did (nothing acknowledged).
 */
export function gradeBootArmRepairs(payload, opts = {}) {
  const minWindowDays = opts.minWindowDays ?? DEFAULT_MIN_WINDOW_DAYS;
  const acks = Array.isArray(opts.acks) ? opts.acks : [];
  const isFixServing = typeof opts.isFixServing === 'function' ? opts.isFixServing : () => null;
  const lines = [];

  if (payload == null || typeof payload !== 'object') {
    lines.push('BLIND — no readable /api/health/options-live payload.');
    lines.push('  This is NOT a pass. An unreachable probe proves nothing about the arm.');
    return { exit: EXIT_BLIND, verdict: 'BLIND', lines };
  }

  const ledger = payload.bootArmRepairLedger;
  if (ledger == null || typeof ledger !== 'object' || typeof ledger.state !== 'string') {
    lines.push('BLIND — payload carries no `bootArmRepairLedger.state`.');
    lines.push(`  saw bootArmRepairLedger=${JSON.stringify(ledger)}`);
    lines.push('  Almost certainly a build older than TRA-3810. DO NOT fall back to');
    lines.push('  `bootArmWriteRepairs` here: it is a since-boot delta that a redeploy');
    lines.push(`  zeroes (this probe reports ${JSON.stringify(payload.bootArmWriteRepairs)}), so a 0`);
    lines.push('  from it would be a false clean — the exact defect TRA-3810 exists to fix.');
    return { exit: EXIT_BLIND, verdict: 'BLIND', lines };
  }

  const state = ledger.state;
  const attempts = Number(ledger.attempts ?? 0);
  const blindReasons = Array.isArray(ledger.blindReasons) ? ledger.blindReasons : [];
  const events = Array.isArray(ledger.events) ? ledger.events : [];
  const durability = ledger.durability ?? {};
  const observingDays = ledger.observingDays;

  lines.push(`state                   ${state}`);
  lines.push(`attempts                ${attempts}  ${JSON.stringify(ledger.attemptsByOrigin ?? {})}`);
  lines.push(`observingSince          ${ledger.observingSinceMs == null ? '(none)' : new Date(ledger.observingSinceMs).toISOString()}`);
  lines.push(`observingDays           ${observingDays == null ? '(null — window unmeasured)' : observingDays} (floor ${minWindowDays})`);
  lines.push(`observationBoots        ${ledger.observationBoots ?? '(absent)'}`);
  lines.push(`retentionDays           ${ledger.retentionDays ?? '(absent)'}`);
  lines.push(`durability.dataDir      ${durability.dataDir ?? '(null)'}`);
  lines.push(`durability.ephemeral    ${durability.ephemeral}`);
  lines.push(`durability.hydrated     ${durability.hydratedRecords} rows (${durability.hydratedRepairs} repairs)`);
  lines.push(`durability.appendErrors ${durability.appendErrors}`);
  lines.push(`blindReasons            ${JSON.stringify(blindReasons)}`);
  // Printed, never graded — see the header. A cross-check of THIS process only.
  lines.push(`(cross-check) bootArmWriteRepairs=${JSON.stringify(payload.bootArmWriteRepairs)} `
    + `lastWriteRepairAt=${JSON.stringify(payload.bootArmLastWriteRepairAt)}`);

  // ── 1. ATTEMPTS. An UNACKNOWLEDGED attempt outranks everything, blindness included. ──
  const ackReport = classifyAcks(events, acks, isFixServing);
  let acknowledgedPass = false;

  if (ackReport.malformed.length > 0 || ackReport.voided.length > 0 || ackReport.orphaned.length > 0) {
    lines.push('');
    lines.push('ACK LEDGER — entries that did NOT clear anything (an ack is never dropped silently):');
    for (const { ack, why } of ackReport.malformed) {
      lines.push(`  MALFORMED  ${JSON.stringify(ack).slice(0, 160)}`);
      lines.push(`             ${why}`);
    }
    for (const { ack, why } of ackReport.voided) {
      lines.push(`  VOID       ${ack.at} (${ack.issue ?? 'no issue'}) — ${why}`);
    }
    for (const { ack } of ackReport.orphaned) {
      lines.push(`  ORPHANED   ${ack.at} (${ack.issue}) matches NO event in this ledger.`);
      lines.push('             Either the event aged past retentionDays, or this ack was written');
      lines.push('             against a fingerprint that never existed. Reconcile it by hand —');
      lines.push('             an ack for nothing is a claim nobody checked.');
    }
  }

  if (state === 'attempts_recorded' || attempts > 0) {
    const enumerable = events.length === attempts;
    const unacked = events.filter((e) => !ackReport.applied.has(eventFingerprint(e)));
    acknowledgedPass = enumerable && unacked.length === 0 && attempts > 0;

    lines.push('');
    if (acknowledgedPass) {
      lines.push(`ATTEMPTS-ACKNOWLEDGED — ${attempts} DURABLE attempt(s) on record, every one pinned`);
      lines.push('  to a settled issue whose fix is STILL IN THE SERVING BUILD, and none since. The');
      lines.push('  history stands and is reprinted below in full; only the exit code is cleared.');
    } else {
      lines.push(`ATTEMPTS — ${attempts} DURABLE attempt(s) to demote the pinned real-money operator`);
      lines.push('  off the board-ratified live-broker arm. The arm held (it re-converges before');
      lines.push(`  the persist), but something tried, and ${unacked.length} of them is/are UNACKNOWLEDGED.`);
    }
    lines.push('');
    for (const e of events.slice(0, 20)) {
      const ro = e.requestOrigin;
      const hit = ackReport.accepted.find((a) => a.event === e);
      lines.push(`  ${e.at}  origin=${e.origin}  repaired=${JSON.stringify(e.repaired)}`
        + `  bodyFields=${JSON.stringify(e.bodyFields ?? [])}`
        + `${e.survivedRestart ? '  [SURVIVED A RESTART]' : ''}`);
      if (ro) {
        lines.push(`      via ${ro.route ?? '(no route)'}  referer=${ro.refererOrigin ?? '(none)'}`
          + `  ua=${ro.userAgentFamily ?? '(none)'}`);
      } else if (e.origin === 'boot') {
        lines.push('      no request behind it — the boot-arm found the PERSISTED operator already');
        lines.push('      demoted. Something reached DISK by a path that is not the settings PUT.');
      }
      lines.push(hit
        ? `      ACKNOWLEDGED by ${hit.ack.issue} (fix ${hit.ack.fixCommit}, verified in the serving build)`
        : '      UNACKNOWLEDGED — this one needs attribution.');
    }
    if (events.length > 20) lines.push(`  … and ${events.length - 20} older event(s), see the raw payload.`);
    lines.push('');
    lines.push(`  distinct request origins: ${ledger.distinctRequestOrigins ?? '(absent)'}`);
    lines.push('  > 1 means MORE THAN ONE writer — do not close on a single attribution.');

    if (!enumerable) {
      lines.push('');
      lines.push(`  ⚠ attempts=${attempts} but only ${events.length} event(s) are enumerable, so the`);
      lines.push('  unlisted ones CANNOT be acknowledged. No ack can clear this ledger while the');
      lines.push('  count and the list disagree.');
    }
    if (blindReasons.length > 0) {
      lines.push('');
      lines.push(`  ⚠ the instrument is ALSO blind (${JSON.stringify(blindReasons)}), so ${attempts} is a`);
      lines.push('  LOWER BOUND, not the count. Fix the blindness before believing the number.');
    }

    if (!acknowledgedPass) return { exit: EXIT_ATTEMPTS, verdict: 'ATTEMPTS', lines };
    // Every recorded attempt is settled, so what is left is an ABSENCE claim about NEW
    // attempts — and an absence only passes here if it was actually measured. Fall through
    // into the same blindness and window-floor gates that guard CLEAN.
  }

  // ── 2. BLIND. Zero attempts, but the zero is not readable as a measurement. ──
  if (state === 'instrument_blind' || blindReasons.length > 0) {
    lines.push('');
    lines.push('BLIND — zero attempts on record, but this instrument could not have recorded one.');
    lines.push('  A zero here is NOT a pass; it is the absence of a measurement.');
    for (const r of blindReasons) {
      lines.push(`    • ${r}: ${BLIND_REASON_TEXT[r] ?? '(unrecognized reason — treat as blind)'}`);
    }
    if (blindReasons.length === 0) {
      lines.push('    • (the ledger reported instrument_blind with no reasons — grade as blind anyway)');
    }
    return { exit: EXIT_BLIND, verdict: 'BLIND', lines };
  }

  // ── 3. Sound instrument, no UNACKNOWLEDGED attempts. Is the window real? ──
  if (state !== 'no_attempt_observed' && !acknowledgedPass) {
    lines.push('');
    lines.push(`BLIND — unrecognized state ${JSON.stringify(state)}. A grader that does not`);
    lines.push('  understand its own input must not emit a pass.');
    return { exit: EXIT_BLIND, verdict: 'BLIND', lines };
  }

  const absenceSubject = acknowledgedPass ? 'zero NEW attempts' : 'zero attempts';

  if (observingDays == null) {
    lines.push('');
    lines.push(`NOT MEASURED — ${absenceSubject}, but \`observingDays\` is null: no observation marker`);
    lines.push('  is on record, so there is no window over which the absence is asserted. This is');
    lines.push('  an assertion about nothing. Expect it to clear on the next boot, which writes');
    lines.push('  the marker; if it persists, the marker append is failing silently.');
    return { exit: EXIT_NOT_MEASURED, verdict: 'NOT MEASURED', lines };
  }

  if (Number(observingDays) < minWindowDays) {
    lines.push('');
    lines.push(`NOT MEASURED — ${absenceSubject} over only ${observingDays}d, under the ${minWindowDays}d floor.`);
    lines.push('  A ledger that started watching moments ago has seen nothing BECAUSE it has');
    lines.push('  barely looked, which is exactly the post-redeploy state that made the old');
    lines.push('  since-boot counter useless. Not a pass; re-read after the floor elapses.');
    return { exit: EXIT_NOT_MEASURED, verdict: 'NOT MEASURED', lines };
  }

  lines.push('');
  if (acknowledgedPass) {
    lines.push(`ATTEMPTS-ACKNOWLEDGED — ${attempts} settled attempt(s) and zero NEW ones across`);
    lines.push(`  ${observingDays} day(s) of continuous observation (${ledger.observationBoots} process lifetime(s)), on a`);
    lines.push('  NON-ephemeral path, with an ELIGIBLE arm and no swallowed appends. This is a pass');
    lines.push('  ONLY because each recorded event names a settled issue whose fix is still an');
    lines.push('  ancestor of the serving commit — roll one back and this goes red again.');
    return { exit: EXIT_CLEAN, verdict: 'ATTEMPTS-ACKNOWLEDGED', lines };
  }
  lines.push(`CLEAN — zero durable demotion attempts across ${observingDays} day(s) of continuous`);
  lines.push(`  observation (${ledger.observationBoots} process lifetime(s)), on a NON-ephemeral path,`);
  lines.push('  with an ELIGIBLE arm and no swallowed appends. The denominator is real: this');
  lines.push('  green would have gone red had an attempt occurred, and it survives a restart.');
  return { exit: EXIT_CLEAN, verdict: 'CLEAN', lines };
}

function report(result) {
  for (const l of result.lines) console.log(l);
  console.log('');
  console.log(`VERDICT: ${result.verdict} (exit ${result.exit})`);
  return result.exit;
}

// ── selftest ────────────────────────────────────────────────────────────────
if (process.argv.includes('--selftest')) {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-08-17T00:00:00.000Z');

  /** A SOUND, long-observing, zero-attempt ledger — the shape a real CLEAN has. */
  const soundLedger = (over = {}) => ({
    state: 'no_attempt_observed',
    blindReasons: [],
    events: [],
    attempts: 0,
    attemptsByOrigin: { settings_write: 0, boot: 0 },
    distinctRequestOrigins: 0,
    lastAttemptAt: null,
    observingSinceMs: now - 60 * DAY,
    observingDays: 60,
    observationBoots: 47,
    retentionDays: 180,
    durability: {
      dataDir: '/data',
      ephemeral: false,
      hydratedRecords: 47,
      hydratedRepairs: 0,
      appendErrors: 0,
      lastAppendError: null,
    },
    ...over,
  });

  /** The literal 2026-08-16 bqb1 event, as this ledger would have recorded it. */
  const theIncident = {
    ts: Date.parse('2026-08-16T18:42:20.569Z'),
    at: '2026-08-16T18:42:20.569Z',
    origin: 'settings_write',
    repaired: ['mode'],
    bodyFields: ['mode'],
    requestOrigin: {
      route: 'PUT /api/account/settings',
      refererOrigin: 'https://tradingai-bqb1.onrender.com',
      userAgentFamily: 'browser:chrome',
    },
    survivedRestart: true,
  };

  const wrap = (ledger, extra = {}) => ({
    bootArmEligible: true,
    bootArmWriteRepairs: 0,
    bootArmLastWriteRepairAt: null,
    bootArmRepairLedger: ledger,
    ...extra,
  });

  const controls = [
    // 1 — TEETH. The real incident, read back AFTER a restart. Must be RED.
    ['1 teeth: the 2026-08-16 demotion attempt, surviving a restart',
      wrap(soundLedger({
        state: 'attempts_recorded',
        events: [theIncident],
        attempts: 1,
        attemptsByOrigin: { settings_write: 1, boot: 0 },
        distinctRequestOrigins: 1,
        lastAttemptAt: theIncident.ts,
        durability: { ...soundLedger().durability, hydratedRepairs: 1, hydratedRecords: 48 },
      }),
      // The counter reads 0 — a REDEPLOY zeroed it. The grader must go red anyway;
      // this is the whole point of the ticket in one control.
      { bootArmWriteRepairs: 0 }),
      EXIT_ATTEMPTS],

    // 2 — the NON-VACUOUS green. Sound instrument, real window, nothing seen.
    ['2 green: zero attempts over a 60d measured window', wrap(soundLedger()), EXIT_CLEAN],

    // 3 — THE VACUITY CONTROL, and the reason this grader exists. A freshly-wiped
    //     ledger has seen nothing because it has not looked. Must NOT be green.
    ['3 vacuity: zero attempts with NO observation window',
      wrap(soundLedger({ observingSinceMs: null, observingDays: null, observationBoots: 0 })),
      EXIT_NOT_MEASURED],

    // 4 — same, but a window shorter than the floor.
    ['4 vacuity: zero attempts over 0d (booted moments ago)',
      wrap(soundLedger({ observingSinceMs: now - 600_000, observingDays: 0, observationBoots: 1 })),
      EXIT_NOT_MEASURED],

    // 5 — THE DURABILITY CONTROL. An ephemeral path makes this ledger no better than
    //     the counter it replaces, so it must never read green.
    ['5 blind: ephemeral DATA_DIR',
      wrap(soundLedger({
        state: 'instrument_blind',
        blindReasons: ['ephemeral_data_dir'],
        durability: { ...soundLedger().durability, dataDir: '/app/packages/server/data', ephemeral: true },
      })),
      EXIT_BLIND],

    // 6 — the arm is disarmed ⇒ no repair can EVER be recorded here.
    ['6 blind: arm not eligible (empty ledger BY CONSTRUCTION)',
      wrap(soundLedger({ state: 'instrument_blind', blindReasons: ['arm_not_eligible'] })),
      EXIT_BLIND],

    // 7 — a swallowed append means the zero is incomplete, not clean.
    ['7 blind: swallowed appends',
      wrap(soundLedger({
        state: 'instrument_blind',
        blindReasons: ['append_errors'],
        durability: { ...soundLedger().durability, appendErrors: 3, lastAppendError: 'ENOSPC' },
      })),
      EXIT_BLIND],

    // 8 — no hydrate ⇒ memory-only.
    ['8 blind: not hydrated',
      wrap(soundLedger({
        state: 'instrument_blind',
        blindReasons: ['not_hydrated'],
        durability: { ...soundLedger().durability, dataDir: null, ephemeral: true },
      })),
      EXIT_BLIND],

    // 9 — PRECEDENCE. Attempts + blindness must still be RED, not downgraded to a
    //     plumbing complaint. A positive is true whatever the coverage is.
    ['9 precedence: an attempt on a BLIND instrument is still ATTEMPTS',
      wrap(soundLedger({
        state: 'attempts_recorded',
        blindReasons: ['append_errors'],
        events: [theIncident],
        attempts: 1,
        attemptsByOrigin: { settings_write: 1, boot: 0 },
        durability: { ...soundLedger().durability, appendErrors: 2 },
      })),
      EXIT_ATTEMPTS],

    // 10 — a boot-origin repair (something demoted the operator DURABLY) is equally red.
    ['10 teeth: a boot-origin repair',
      wrap(soundLedger({
        state: 'attempts_recorded',
        events: [{ ts: now, at: '2026-08-17T00:00:00.000Z', origin: 'boot', repaired: ['mode'], bodyFields: [], requestOrigin: null, survivedRestart: false }],
        attempts: 1,
        attemptsByOrigin: { settings_write: 0, boot: 1 },
      })),
      EXIT_ATTEMPTS],

    // 11 — a pre-TRA-3810 build must be BLIND, and must NOT fall back to the counter.
    ['11 blind: build predates the ledger field',
      { bootArmEligible: true, bootArmWriteRepairs: 0, bootArmLastWriteRepairAt: null },
      EXIT_BLIND],

    // 12 — unreachable probe.
    ['12 blind: no payload at all', null, EXIT_BLIND],

    // 13 — an unrecognized state must not be smoothed into a pass.
    ['13 blind: unrecognized state', wrap(soundLedger({ state: 'probably_fine' })), EXIT_BLIND],
  ];

  // ── TRA-3852 acknowledgement controls ─────────────────────────────────────
  // Control 1 above ALREADY pins the floor: the incident with NO acks passes no options
  // and must stay RED. Everything here is about not letting an ack become a mute button.
  const attemptsLedger = (over = {}) => soundLedger({
    state: 'attempts_recorded',
    events: [theIncident],
    attempts: 1,
    attemptsByOrigin: { settings_write: 1, boot: 0 },
    distinctRequestOrigins: 1,
    lastAttemptAt: theIncident.ts,
    durability: { ...soundLedger().durability, hydratedRepairs: 1, hydratedRecords: 48 },
    ...over,
  });
  const goodAck = {
    at: '2026-08-16T18:42:20.569Z',
    origin: 'settings_write',
    repaired: ['mode'],
    bodyFieldCount: 1,
    issue: 'TRA-3833',
    fixCommit: '0ce7226',
  };
  const SERVING = () => true;
  const ROLLED_BACK = () => false;
  const UNKNOWN = () => null;
  // A second attempt of the SAME SHAPE, one day later. The ack must not reach it.
  const copycat = { ...theIncident, ts: theIncident.ts + DAY, at: '2026-08-17T18:42:20.569Z' };

  const ackControls = [
    ['14 ack: settled event, fix in the serving build → cleared',
      wrap(attemptsLedger()), EXIT_CLEAN, { acks: [goodAck], isFixServing: SERVING }],

    // THE tightening. Today an unconditional exit 1 could not tell a rollback from steady
    // state; an ack that self-voids on rollback can.
    ['15 ack VOID: the fix rolled out of the serving build → RED again',
      wrap(attemptsLedger()), EXIT_ATTEMPTS, { acks: [goodAck], isFixServing: ROLLED_BACK }],

    ['16 ack VOID: ancestry undeterminable → fails CLOSED',
      wrap(attemptsLedger()), EXIT_ATTEMPTS, { acks: [goodAck], isFixServing: UNKNOWN }],

    // Identity, never class: same writer, same body, same repaired field, new timestamp.
    ['17 ack is per-EVENT: an identical-shaped NEW attempt still alarms',
      wrap(attemptsLedger({ events: [theIncident, copycat], attempts: 2, lastAttemptAt: copycat.ts })),
      EXIT_ATTEMPTS, { acks: [goodAck], isFixServing: SERVING }],

    // An all-acked ledger asserts an ABSENCE of new attempts, so coverage now binds it.
    ['18 acked + blind instrument → BLIND, not a pass',
      wrap(attemptsLedger({ blindReasons: ['append_errors'], durability: { ...soundLedger().durability, appendErrors: 2 } })),
      EXIT_BLIND, { acks: [goodAck], isFixServing: SERVING }],

    ['19 acked + no observation window → NOT MEASURED, not a pass',
      wrap(attemptsLedger({ observingSinceMs: null, observingDays: null, observationBoots: 0 })),
      EXIT_NOT_MEASURED, { acks: [goodAck], isFixServing: SERVING }],

    // The count and the list disagree ⇒ the unlisted attempts are unackable.
    ['20 acked but attempts > enumerable events → RED',
      wrap(attemptsLedger({ attempts: 2, attemptsByOrigin: { settings_write: 2, boot: 0 } })),
      EXIT_ATTEMPTS, { acks: [goodAck], isFixServing: SERVING }],

    ['21 malformed ack (no fixCommit) clears nothing',
      wrap(attemptsLedger()), EXIT_ATTEMPTS,
      { acks: [{ ...goodAck, fixCommit: undefined }], isFixServing: SERVING }],

    ['22 wrong-shape ack (bodyFieldCount off by one) clears nothing',
      wrap(attemptsLedger()), EXIT_ATTEMPTS,
      { acks: [{ ...goodAck, bodyFieldCount: 61 }], isFixServing: SERVING }],

    // An ack pointing at nothing must not quietly disappear — but a zero-attempt ledger is
    // still CLEAN, because the ack cleared no alarm to begin with.
    ['23 orphaned ack on a clean ledger is reported, not fatal',
      wrap(soundLedger()), EXIT_CLEAN, { acks: [goodAck], isFixServing: SERVING }],
  ];

  let failed = 0;
  for (const [name, payload, want] of controls) {
    const got = gradeBootArmRepairs(payload, { minWindowDays: DEFAULT_MIN_WINDOW_DAYS }).exit;
    const ok = got === want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  control ${name} → exit ${got} (want ${want})`);
  }
  for (const [name, payload, want, ackOpts] of ackControls) {
    const got = gradeBootArmRepairs(payload, { minWindowDays: DEFAULT_MIN_WINDOW_DAYS, ...ackOpts }).exit;
    const ok = got === want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  control ${name} → exit ${got} (want ${want})`);
  }

  // Text controls — the RED must NAME the event, or nobody can act on it.
  const textChecks = [
    ['names the incident timestamp',
      gradeBootArmRepairs(controls[0][1]), '2026-08-16T18:42:20.569Z'],
    ['names the restart survival',
      gradeBootArmRepairs(controls[0][1]), 'SURVIVED A RESTART'],
    ['names the request route',
      gradeBootArmRepairs(controls[0][1]), 'PUT /api/account/settings'],
    ['refuses to fall back to the counter on an old build',
      gradeBootArmRepairs(controls[10][1]), 'would be a false clean'],
    ['names the DATA_DIR fix for an ephemeral path',
      gradeBootArmRepairs(controls[4][1]), 'DATA_DIR=/data'],
    ['discloses the lower-bound caveat when blind AND holding an attempt',
      gradeBootArmRepairs(controls[8][1]), 'LOWER BOUND'],
    // The acked pass must still SHOW the history — an ack that hides the event would be
    // worse than the pinned alarm it replaces.
    ['still prints the acked event and names its settling issue',
      gradeBootArmRepairs(ackControls[0][1], ackControls[0][3]), 'ACKNOWLEDGED by TRA-3833'],
    ['still prints the acked event timestamp on the pass',
      gradeBootArmRepairs(ackControls[0][1], ackControls[0][3]), '2026-08-16T18:42:20.569Z'],
    ['names a rolled-back fix as the reason the ack went void',
      gradeBootArmRepairs(ackControls[1][1], ackControls[1][3]), 'ROLLED BACK'],
    ['marks the un-acked copycat attempt as UNACKNOWLEDGED',
      gradeBootArmRepairs(ackControls[3][1], ackControls[3][3]), 'UNACKNOWLEDGED'],
    ['reports an orphaned ack rather than swallowing it',
      gradeBootArmRepairs(ackControls[9][1], ackControls[9][3]), 'ORPHANED'],
    ['the acked pass declares its own precondition',
      gradeBootArmRepairs(ackControls[0][1], ackControls[0][3]), 'ancestor of the serving commit'],
  ];
  for (const [name, result, want] of textChecks) {
    const ok = result.lines.join('\n').includes(want);
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  text "${name}" → says ${JSON.stringify(want)}`);
  }

  // The floor is a knob, and a knob that does nothing is a lie. Pin both directions.
  {
    const l = wrap(soundLedger({ observingDays: 3, observingSinceMs: now - 3 * DAY }));
    const lax = gradeBootArmRepairs(l, { minWindowDays: 1 }).exit;
    const strict = gradeBootArmRepairs(l, { minWindowDays: 7 }).exit;
    const ok = lax === EXIT_CLEAN && strict === EXIT_NOT_MEASURED;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  knob "--min-window-days moves the verdict" → 1d:${lax} 7d:${strict}`);
  }

  console.log('');
  if (failed > 0) {
    console.log(`selftest: ${failed} control(s) FAILED — this guard is not trustworthy.`);
    process.exit(1);
  }
  console.log('selftest: all controls pass (teeth, non-vacuous green, vacuity, durability, precedence, blind).');
  process.exit(0);
}

// ── live path ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const hostArg = args.find((a) => a.startsWith('--host='))?.slice('--host='.length);
const payloadArg = args.find((a) => a.startsWith('--payload='))?.slice('--payload='.length);
const windowArg = args.find((a) => a.startsWith('--min-window-days='))?.slice('--min-window-days='.length);
const host = (hostArg ?? DEFAULT_HOST).replace(/\/$/, '');
const minWindowDays = windowArg === undefined ? DEFAULT_MIN_WINDOW_DAYS : Number(windowArg);

if (!Number.isFinite(minWindowDays) || minWindowDays < 0) {
  console.log(`--min-window-days=${windowArg} is not a non-negative number.`);
  process.exit(EXIT_BLIND);
}

// ── acknowledgement ledger (TRA-3852) ───────────────────────────────────────
const ackPathArg = args.find((a) => a.startsWith('--acks='))?.slice('--acks='.length);
const noAcks = args.includes('--no-acks');
const servingCommitArg = args.find((a) => a.startsWith('--serving-commit='))?.slice('--serving-commit='.length);

let acks = [];
if (!noAcks) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const defaultAckPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'boot-arm-repair-acks.json');
  const ackPath = ackPathArg ?? defaultAckPath;
  try {
    const parsed = JSON.parse(readFileSync(ackPath, 'utf-8'));
    acks = Array.isArray(parsed) ? parsed : (parsed.acks ?? []);
    console.log(`acks:   ${ackPath} (${acks.length} entr${acks.length === 1 ? 'y' : 'ies'})`);
  } catch (err) {
    // A missing file is the normal empty case. An unreadable one must NOT be, because a
    // silently-empty ack list still grades correctly (RED) — but a silently-empty list that
    // was supposed to hold entries would hide that they stopped being checked.
    if (ackPathArg || err.code !== 'ENOENT') console.log(`acks:   could not read ${ackPath}: ${err.message} — grading with NO acknowledgements`);
    acks = [];
  }
} else {
  console.log('acks:   --no-acks — grading as if nothing were acknowledged');
}

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
    if (!res.ok) console.log(`probe returned HTTP ${res.status}`);
    else payload = await res.json();
  } catch (err) {
    console.log(`probe unreachable: ${err.message}`);
  }
}
// Resolve the commit the service is actually SERVING, then answer ancestry from the local
// checkout. Anything unknown here answers `null`, which applies no ack.
let servingCommit = servingCommitArg ?? null;
if (acks.length > 0 && !servingCommit && !payloadArg) {
  try {
    const res = await fetch(`${host}/api/health/version`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) servingCommit = (await res.json()).commit ?? null;
  } catch { /* leave null — acks will not apply */ }
}
if (acks.length > 0) {
  console.log(`serving: ${servingCommit ?? '(unknown — no ack can apply)'}`);
}

const { spawnSync } = await import('node:child_process');
const { fileURLToPath: toPath } = await import('node:url');
const nodePath = await import('node:path');
const repoRoot = nodePath.resolve(nodePath.dirname(toPath(import.meta.url)), '..');

const ancestryCache = new Map();
const isFixServing = (sha) => {
  if (!servingCommit) return null;
  const key = `${sha}..${servingCommit}`;
  if (ancestryCache.has(key)) return ancestryCache.get(key);
  let answer = null;
  try {
    const probe = spawnSync('git', ['merge-base', '--is-ancestor', sha, servingCommit], { encoding: 'utf-8', cwd: repoRoot });
    // 0 = ancestor, 1 = not an ancestor, anything else (unknown sha, no repo) = cannot tell.
    if (probe.error == null && (probe.status === 0 || probe.status === 1)) answer = probe.status === 0;
  } catch { answer = null; }
  ancestryCache.set(key, answer);
  return answer;
};

console.log('');
process.exit(report(gradeBootArmRepairs(payload, { minWindowDays, acks, isFixServing })));
