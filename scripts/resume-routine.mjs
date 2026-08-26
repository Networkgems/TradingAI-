#!/usr/bin/env node
/**
 * TRA-4064 — the WRITE half of the armed-liveness detector. Resumes a paused
 * routine burst-free, and VERIFIES BY READ-BACK rather than by the 200.
 *
 * WHAT WENT WRONG, AND WHY A 200 IS NOT EVIDENCE
 * ----------------------------------------------
 * A burst-free resume is two writes, in this order:
 *
 *   step 1  PATCH /api/routine-triggers/{id}   — recomputes `nextRunAt` forward
 *                                                off NOW, discarding the stale
 *                                                slot so the routine does not
 *                                                fire a backlog on restore
 *   step 2  PATCH /api/routines/{id}           — {"status":"active"}
 *
 * The ORDER IS CORRECT and this script keeps it. The defect is that the pair is
 * NOT ATOMIC, and the intermediate state is invisible to every liveness
 * heuristic we own except one.
 *
 * On 2026-08-26 routine `ec0f4a75` (TRA-2945 give-back mark bound) was left in
 * exactly that intermediate state by this seat: step 1 landed at 10:54:50Z,
 * step 2 never ran. Ten days dark, and it read:
 *
 *     status:     "paused"      <-- the ONLY field that was wrong
 *     enabled:    true
 *     nextRunAt:  2026-08-26T20:45:00.000Z   <-- IN THE FUTURE, hours out
 *     cron:       45 16 * * 1-5  America/New_York
 *
 * ⛔⛔ THE HALF-FINISHED RESTORE READS GREENER THAN THE UNTOUCHED FAILURE.
 * Every OTHER instance of this defect carried a stale PAST `nextRunAt`, so a
 * census could catch it with a "clock is behind" heuristic. Step 1 destroys
 * that signal: it recomputes the promise forward to a real, plausible cron
 * boundary. The row then reads green on `enabled` and green on `nextRunAt`, and
 * fires ZERO times, because the dispatcher selects `routines.status = 'active'`
 * and nothing else. Doing HALF the repair is worse than doing NONE of it — it
 * launders the evidence.
 *
 * ⛔ `nextRunAt` IS A PROMISE, NOT A RECORD (the standing trap, TRA-2331 /
 * TRA-4049). It advances whether or not any fire ever dispatched. It cannot
 * witness a resume and is never read here as one.
 *
 * THE GUARD
 * ---------
 * Success is a FRESH GET after the writes, asserting ALL of:
 *
 *   A  routine.status === 'active'          the dispatcher's actual predicate
 *   B  the target trigger is enabled        step 1 must not have disarmed it
 *   C  its nextRunAt parses and is FUTURE   a past promise = a burst on restore
 *   D  the routine is still assigned to us  a mid-run re-home invalidates B/C
 *
 * A 2xx on either PATCH is NOT success. The platform is measured to return 200
 * on a status PATCH that does not stick (see the status-PATCH run-lock note in
 * `drain:strands`), so the response body is never the witness — only a
 * subsequent independent GET is.
 *
 * IDEMPOTENCE / RESUMING A HALF-FINISHED RESTORE
 * ----------------------------------------------
 * The common invocation is the one that fixes `ec0f4a75`: step 1 is ALREADY
 * DONE and its output is correct, and re-patching the trigger would just
 * recompute the same boundary for no reason. So step 1 is SKIPPED when the
 * trigger's `nextRunAt` is already in the future — reported as SKIPPED_FUTURE,
 * never silently. Pass `--force-trigger` to patch it anyway.
 *
 * ⛔ BURST SAFETY IS MEASURED, NOT ASSUMED. If, after all writes, `nextRunAt`
 * is in the PAST and `catchUpPolicy` is not `skip_missed`, the routine will
 * flush a backlog the moment it goes active. That exits BURST_RISK (5) — a
 * distinct code, because "it resumed and will stampede" must never share an
 * exit with "it resumed cleanly".
 *
 * OWNERSHIP
 * ---------
 * `PATCH /api/routines/{id}` returns 403 `Agents can only manage routines
 * assigned to themselves` for every actor but the owner, INCLUDING `role: ceo`.
 * There is no fleet-wide resume and rank does not lift it. A routine owned by
 * an off-roster (departed) agent cannot be resumed or archived by any
 * in-company seat at all and needs a platform operator — that is reported as
 * FORBIDDEN (4), with the measured error text, so the escalation carries an
 * observation instead of an inference.
 *
 * EXIT CODES  0 RESUMED · 1 NOT_VERIFIED · 2 usage · 3 BLIND · 4 FORBIDDEN ·
 *             5 BURST_RISK
 * Precedence  BLIND > FORBIDDEN > BURST_RISK > NOT_VERIFIED > RESUMED
 *
 * A read that cannot be taken is BLIND, never a pass. An unreachable API, an
 * unparseable body, or a routine id that does not resolve all exit 3 — "could
 * not check" and "checked and it is fine" must never share an exit code.
 *
 * USAGE
 *   node scripts/resume-routine.mjs --routine=<uuid> [--trigger=<uuid>]
 *                                   [--force-trigger] [--dry-run] [--json]
 *   node scripts/resume-routine.mjs --selftest
 */

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
};

export const EXIT = {
  RESUMED: 0,
  NOT_VERIFIED: 1,
  USAGE: 2,
  BLIND: 3,
  FORBIDDEN: 4,
  BURST_RISK: 5,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trap (TRA-3008 trap 1, same route family): the routines route returns a BARE
 * ARRAY on the list endpoint. The single-routine GET returns an object, but the
 * trigger list has been seen under both `triggers` and a bare array, so unwrap
 * defensively and NEVER let "shape I did not expect" degrade into "empty".
 */
export function triggersOf(routine) {
  if (!routine || typeof routine !== 'object') return null;
  if (Array.isArray(routine.triggers)) return routine.triggers;
  if (Array.isArray(routine.routineTriggers)) return routine.routineTriggers;
  return null;
}

/** Schedule triggers only. A manual/webhook trigger has no clock to burst. */
export function scheduleTriggers(triggers) {
  return (triggers || []).filter((t) => t && (t.kind === undefined || t.kind === 'schedule'));
}

export function isFuture(iso, nowMs) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > nowMs;
}

/**
 * The read-back predicate. Pure, so `--selftest` can pin every branch without
 * touching the network. Returns {ok, failures[], burstRisk}.
 */
export function verifyResumed(routine, targetTriggerId, nowMs, expectedOwnerId) {
  const failures = [];
  if (!routine || typeof routine !== 'object') {
    return { ok: false, failures: ['read-back returned no routine object'], burstRisk: false };
  }

  // A — the dispatcher's actual predicate, and the ONLY field that was wrong on
  // the founding fixture. Never inferred from `enabled` or `nextRunAt`.
  if (routine.status !== 'active') {
    failures.push(`status is "${routine.status}", expected "active" (the dispatcher selects on this field and nothing else)`);
  }

  // D — a mid-run re-home makes B and C claims about somebody else's routine.
  if (expectedOwnerId && routine.assigneeAgentId && routine.assigneeAgentId !== expectedOwnerId) {
    failures.push(`assigneeAgentId is ${routine.assigneeAgentId}, expected ${expectedOwnerId} (re-homed mid-repair)`);
  }

  const triggers = triggersOf(routine);
  if (triggers === null) {
    failures.push('routine carries no readable triggers array (shape change) — cannot verify the clock');
    return { ok: false, failures, burstRisk: false };
  }

  const target = targetTriggerId
    ? triggers.find((t) => t && t.id === targetTriggerId)
    : scheduleTriggers(triggers)[0];

  if (!target) {
    failures.push(
      targetTriggerId
        ? `trigger ${targetTriggerId} is absent from the read-back`
        : 'routine has no schedule trigger to verify',
    );
    return { ok: false, failures, burstRisk: false };
  }

  // B — step 1 must not have disarmed the thing it was meant to re-time.
  if (target.enabled !== true) {
    failures.push(`trigger ${target.id} reads enabled:${target.enabled} — an active routine with a disabled trigger still fires zero times`);
  }

  // C — a past promise means the dispatcher's catch-up policy decides what
  // happens next, which is the burst question below.
  const future = isFuture(target.nextRunAt, nowMs);
  if (!future) {
    failures.push(`trigger ${target.id} nextRunAt "${target.nextRunAt}" is absent, unparseable, or in the PAST`);
  }

  // Burst is a SEPARATE axis from correctness: the routine may be perfectly
  // resumed and still stampede. skip_missed is the only policy that makes a
  // past nextRunAt safe.
  const burstRisk = !future && routine.catchUpPolicy !== 'skip_missed';

  return { ok: failures.length === 0, failures, burstRisk };
}

/* ================================================================== */

async function run(transport, opts) {
  const {
    routineId,
    triggerId = null,
    forceTrigger = false,
    dryRun = false,
    expectedOwnerId = null,
    now = Date.now(),
  } = opts;

  const steps = [];
  const emit = (step, outcome, detail) => steps.push({ step, outcome, detail });

  let before;
  try {
    before = await transport.getRoutine(routineId);
  } catch (err) {
    return { code: EXIT.BLIND, verdict: 'BLIND', reason: `could not read routine ${routineId}: ${err.message}`, steps };
  }
  if (!before || typeof before !== 'object' || !before.id) {
    return { code: EXIT.BLIND, verdict: 'BLIND', reason: `routine ${routineId} did not resolve to a routine object`, steps };
  }

  emit('read-before', 'OK', `status=${before.status} assignee=${before.assigneeAgentId} catchUp=${before.catchUpPolicy}`);

  if (before.status === 'archived') {
    // Archived is TERMINAL and deliberately ignored by the detector. Resuming
    // one is almost always a mistake, and is never this script's job.
    return {
      code: EXIT.USAGE,
      verdict: 'USAGE',
      reason: `routine ${routineId} is archived — that is a terminal disposition, not a paused one. Refusing to resume it.`,
      steps,
    };
  }

  const beforeTriggers = triggersOf(before);
  if (beforeTriggers === null) {
    return { code: EXIT.BLIND, verdict: 'BLIND', reason: 'routine carries no readable triggers array', steps };
  }
  const target = triggerId
    ? beforeTriggers.find((t) => t && t.id === triggerId)
    : scheduleTriggers(beforeTriggers)[0];
  if (!target) {
    return {
      code: EXIT.BLIND,
      verdict: 'BLIND',
      reason: triggerId ? `trigger ${triggerId} not found on routine` : 'routine has no schedule trigger',
      steps,
    };
  }

  // ---- step 1: re-time the clock, but only if it actually needs it ----
  const clockAlreadyForward = isFuture(target.nextRunAt, now);
  if (clockAlreadyForward && !forceTrigger) {
    emit(
      'step1-trigger',
      'SKIPPED_FUTURE',
      `nextRunAt ${target.nextRunAt} is already in the future — re-patching would recompute the same boundary. (--force-trigger overrides.)`,
    );
  } else if (dryRun) {
    emit('step1-trigger', 'DRY_RUN', `would PATCH trigger ${target.id} to re-time the clock forward`);
  } else {
    try {
      await transport.patchTrigger(target.id, { enabled: true });
      emit('step1-trigger', 'PATCHED', `trigger ${target.id} re-timed (2xx — NOT yet evidence)`);
    } catch (err) {
      if (/\b403\b/.test(err.message)) {
        return { code: EXIT.FORBIDDEN, verdict: 'FORBIDDEN', reason: `trigger PATCH refused: ${err.message}`, steps };
      }
      return { code: EXIT.BLIND, verdict: 'BLIND', reason: `trigger PATCH failed: ${err.message}`, steps };
    }
  }

  // ---- step 2: the write that was dropped on the founding fixture ----
  if (before.status === 'active') {
    emit('step2-status', 'ALREADY_ACTIVE', 'routine root was already active — nothing to write');
  } else if (dryRun) {
    emit('step2-status', 'DRY_RUN', `would PATCH routine ${routineId} {"status":"active"}`);
  } else {
    try {
      await transport.patchRoutine(routineId, { status: 'active' });
      emit('step2-status', 'PATCHED', '{"status":"active"} accepted (2xx — NOT yet evidence)');
    } catch (err) {
      if (/\b403\b/.test(err.message)) {
        return {
          code: EXIT.FORBIDDEN,
          verdict: 'FORBIDDEN',
          reason:
            `routine PATCH refused: ${err.message}\n` +
            'Routine management is owner-only for every in-company role including ceo. ' +
            'If the assignee is off-roster this needs a platform operator, not another seat.',
          steps,
        };
      }
      return { code: EXIT.BLIND, verdict: 'BLIND', reason: `routine PATCH failed: ${err.message}`, steps };
    }
  }

  if (dryRun) {
    return { code: EXIT.USAGE, verdict: 'DRY_RUN', reason: 'dry run — no writes issued, nothing verified', steps };
  }

  // ---- the guard: an INDEPENDENT read-back. The 200s above prove nothing. ----
  let after;
  try {
    after = await transport.getRoutine(routineId);
  } catch (err) {
    return {
      code: EXIT.BLIND,
      verdict: 'BLIND',
      reason: `writes issued but the read-back FAILED (${err.message}) — the routine may be half-restored; re-run this script`,
      steps,
    };
  }

  const check = verifyResumed(after, target.id, Date.now(), expectedOwnerId);
  const afterTrigger = (triggersOf(after) || []).find((t) => t && t.id === target.id) || {};
  emit(
    'read-back',
    check.ok ? 'VERIFIED' : 'FAILED',
    `status=${after.status} enabled=${afterTrigger.enabled} nextRunAt=${afterTrigger.nextRunAt}`,
  );

  if (!check.ok) {
    return {
      code: EXIT.NOT_VERIFIED,
      verdict: 'NOT_VERIFIED',
      reason: `read-back did not confirm the resume:\n  - ${check.failures.join('\n  - ')}`,
      steps,
      after,
    };
  }
  if (check.burstRisk) {
    return {
      code: EXIT.BURST_RISK,
      verdict: 'BURST_RISK',
      reason: `routine is active but nextRunAt is in the past under catchUpPolicy="${after.catchUpPolicy}" — it will flush a backlog`,
      steps,
      after,
    };
  }
  return {
    code: EXIT.RESUMED,
    verdict: 'RESUMED',
    reason: `verified by read-back: status=active, trigger ${target.id} enabled with nextRunAt ${afterTrigger.nextRunAt} (future); catchUp=${after.catchUpPolicy}`,
    steps,
    after,
  };
}

/* ================================================================== */

function liveTransport() {
  const raw = String(process.env.PAPERCLIP_API_URL || '').replace(/\/+$/, '');
  const BASE = argOf('base', raw.replace(/\/api$/, ''));
  const KEY = process.env.PAPERCLIP_API_KEY;
  if (!BASE || !KEY) throw new Error('PAPERCLIP_API_URL and PAPERCLIP_API_KEY must both be set');
  const headers = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
  const runId = process.env.PAPERCLIP_RUN_ID;
  if (runId) headers['X-Paperclip-Run-Id'] = runId;

  const req = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${method} ${path} — ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    // ⛔ routine read/write are NOT company-scoped (inverted from create).
    getRoutine: (id) => req('GET', `/api/routines/${id}`),
    patchRoutine: (id, body) => req('PATCH', `/api/routines/${id}`, body),
    patchTrigger: (id, body) => req('PATCH', `/api/routine-triggers/${id}`, body),
  };
}

/* ---------------------------- controls ---------------------------- */

const NOW = Date.parse('2026-08-26T13:00:00.000Z');
const FUTURE = '2026-08-26T20:45:00.000Z';
const PAST = '2026-08-16T20:45:00.000Z';
const OWNER = '671785a4-3b29-4185-a458-dfca8529e896';
const TRIG = '02416398-29ea-42c0-a592-6e25266f20ec';

const fixture = (over = {}) => ({
  id: 'ec0f4a75-7684-4b14-ac7f-6650eb29923d',
  status: 'active',
  assigneeAgentId: OWNER,
  catchUpPolicy: 'skip_missed',
  triggers: [{ id: TRIG, kind: 'schedule', enabled: true, nextRunAt: FUTURE }],
  ...over,
});
const withTrigger = (over) => fixture({ triggers: [{ id: TRIG, kind: 'schedule', enabled: true, nextRunAt: FUTURE, ...over }] });

async function selftest() {
  const cases = [];
  const t = (name, got, want) => cases.push({ name, pass: JSON.stringify(got) === JSON.stringify(want), got, want });

  // --- the founding fixture, both directions ---
  t(
    'THE INCIDENT: paused root with a FUTURE nextRunAt is NOT verified',
    verifyResumed(fixture({ status: 'paused' }), TRIG, NOW, OWNER).ok,
    false,
  );
  t(
    'the same row after step 2 verifies',
    verifyResumed(fixture(), TRIG, NOW, OWNER).ok,
    true,
  );
  // The whole point: every field except status reads green on the incident row.
  t(
    'incident row fails ONLY on status (one failure, naming status)',
    verifyResumed(fixture({ status: 'paused' }), TRIG, NOW, OWNER).failures.length === 1 &&
      /status is "paused"/.test(verifyResumed(fixture({ status: 'paused' }), TRIG, NOW, OWNER).failures[0]),
    true,
  );

  // --- status is the discriminator and is never inferred ---
  t('enabled+future does NOT rescue a paused root', verifyResumed(fixture({ status: 'paused' }), TRIG, NOW, OWNER).ok, false);
  t('archived root is not verified', verifyResumed(fixture({ status: 'archived' }), TRIG, NOW, OWNER).ok, false);

  // --- trigger arm ---
  t('active root + DISABLED trigger is not verified', verifyResumed(withTrigger({ enabled: false }), TRIG, NOW, OWNER).ok, false);
  t('past nextRunAt is not verified', verifyResumed(withTrigger({ nextRunAt: PAST }), TRIG, NOW, OWNER).ok, false);
  t('unparseable nextRunAt is not verified', verifyResumed(withTrigger({ nextRunAt: 'soon' }), TRIG, NOW, OWNER).ok, false);
  t('null nextRunAt is not verified', verifyResumed(withTrigger({ nextRunAt: null }), TRIG, NOW, OWNER).ok, false);

  // --- burst axis is independent of correctness ---
  t(
    'past clock + skip_missed = no burst risk',
    verifyResumed(fixture({ catchUpPolicy: 'skip_missed', triggers: [{ id: TRIG, enabled: true, nextRunAt: PAST }] }), TRIG, NOW, OWNER).burstRisk,
    false,
  );
  t(
    'past clock + run_missed = BURST RISK',
    verifyResumed(fixture({ catchUpPolicy: 'run_missed', triggers: [{ id: TRIG, enabled: true, nextRunAt: PAST }] }), TRIG, NOW, OWNER).burstRisk,
    true,
  );
  t('future clock is never a burst risk', verifyResumed(fixture({ catchUpPolicy: 'run_missed' }), TRIG, NOW, OWNER).burstRisk, false);

  // --- ownership / re-home ---
  t('re-homed mid-repair is not verified', verifyResumed(fixture({ assigneeAgentId: 'dead-beef' }), TRIG, NOW, OWNER).ok, false);
  t('no expected owner supplied = ownership not asserted', verifyResumed(fixture({ assigneeAgentId: 'dead-beef' }), TRIG, NOW, null).ok, true);

  // --- shape changes fail CLOSED, never to a pass ---
  t('missing triggers array is not verified', verifyResumed({ id: 'x', status: 'active' }, TRIG, NOW, OWNER).ok, false);
  t('absent target trigger is not verified', verifyResumed(fixture(), 'no-such-trigger', NOW, OWNER).ok, false);
  t('null routine is not verified', verifyResumed(null, TRIG, NOW, OWNER).ok, false);
  t('triggersOf accepts bare-array shape change', triggersOf({ routineTriggers: [] }), []);
  t('triggersOf returns null (not []) on shape change', triggersOf({ id: 'x' }), null);

  // --- live-ish transport controls: step 1 skip, and the 403 route ---
  const calls = [];
  const stub = (over = {}) => ({
    getRoutine: async () => fixture({ status: 'paused' }),
    patchTrigger: async (id) => { calls.push(`trigger:${id}`); return {}; },
    patchRoutine: async (id, b) => { calls.push(`routine:${id}:${b.status}`); return {}; },
    ...over,
  });

  calls.length = 0;
  let r = await run(
    { ...stub(), getRoutine: async () => (calls.includes('routine:ec0f4a75-7684-4b14-ac7f-6650eb29923d:active') ? fixture() : fixture({ status: 'paused' })) },
    { routineId: 'ec0f4a75-7684-4b14-ac7f-6650eb29923d', triggerId: TRIG, expectedOwnerId: OWNER, now: NOW },
  );
  t('END-TO-END: half-finished restore resumes and verifies', r.code, EXIT.RESUMED);
  t('END-TO-END: step 1 was SKIPPED (clock already forward)', calls.some((c) => c.startsWith('trigger:')), false);
  t('END-TO-END: step 2 DID run', calls.includes('routine:ec0f4a75-7684-4b14-ac7f-6650eb29923d:active'), true);

  // ⛔ a 200 that does not stick must read NOT_VERIFIED, never RESUMED
  r = await run(stub(), { routineId: 'r', triggerId: TRIG, expectedOwnerId: OWNER, now: NOW });
  t('a 200 that does NOT stick reads NOT_VERIFIED, not RESUMED', r.code, EXIT.NOT_VERIFIED);

  r = await run(
    stub({ patchRoutine: async () => { throw new Error('HTTP 403 on PATCH — Agents can only manage routines assigned to themselves'); } }),
    { routineId: 'r', triggerId: TRIG, now: NOW },
  );
  t('owner-only 403 reads FORBIDDEN, not BLIND', r.code, EXIT.FORBIDDEN);

  r = await run(stub({ getRoutine: async () => { throw new Error('HTTP 500'); } }), { routineId: 'r', now: NOW });
  t('unreadable routine is BLIND, never a pass', r.code, EXIT.BLIND);

  r = await run(stub({ getRoutine: async () => fixture({ status: 'archived' }) }), { routineId: 'r', now: NOW });
  t('archived routine is REFUSED, not resumed', r.code, EXIT.USAGE);

  let n = 0;
  r = await run(
    stub({ getRoutine: async () => (n++ === 0 ? fixture({ status: 'paused' }) : (() => { throw new Error('HTTP 502'); })()) }),
    { routineId: 'r', triggerId: TRIG, now: NOW },
  );
  t('a failed READ-BACK is BLIND (may be half-restored), never RESUMED', r.code, EXIT.BLIND);

  let pass = 0;
  for (const c of cases) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (!c.pass) console.log(`        got ${JSON.stringify(c.got)}  want ${JSON.stringify(c.want)}`);
    if (c.pass) pass += 1;
  }
  console.log(`\n${pass}/${cases.length} controls pass`);
  return pass === cases.length ? 0 : 1;
}

/* ================================================================== */

async function main() {
  if (argv.includes('--selftest')) return selftest();

  const routineId = argOf('routine', null);
  if (!routineId || !UUID_RE.test(routineId)) {
    // ⛔ short 8-char routine ids return 500, not 404 — always the full UUID.
    console.error('usage: node scripts/resume-routine.mjs --routine=<full-uuid> [--trigger=<uuid>] [--force-trigger] [--dry-run] [--json]');
    if (routineId) console.error(`\n"${routineId}" is not a full UUID. Short ids return HTTP 500, not 404.`);
    return EXIT.USAGE;
  }

  const result = await run(liveTransport(), {
    routineId,
    triggerId: argOf('trigger', null),
    forceTrigger: argv.includes('--force-trigger'),
    dryRun: argv.includes('--dry-run'),
    expectedOwnerId: argOf('owner', process.env.PAPERCLIP_AGENT_ID || null),
  });

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ issue: 'TRA-4064', routineId, checkedAt: new Date().toISOString(), ...result }, null, 2));
  } else {
    console.log(`resume-routine ${routineId}`);
    for (const s of result.steps) console.log(`  [${s.outcome}] ${s.step} — ${s.detail}`);
    console.log(`\n${result.verdict} (exit ${result.code})`);
    console.log(result.reason);
  }
  return result.code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`BLIND — ${err.stack || err.message}`);
    process.exit(EXIT.BLIND);
  });
