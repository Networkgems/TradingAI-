#!/usr/bin/env node
/**
 * TRA-2331 — detector for the SILENT DISPATCH DEATH: an `active` routine whose
 * schedule still promises a future fire while every actual dispatch is failing.
 *
 * WHAT THE SHAPE IS
 * -----------------
 * TRA-2331's grade is produced by routine `7c3af47e` firing after each RTH
 * close. That routine is the issue's ONLY live continuation path, and the
 * issue's own no-op clock runs ~59 sessions (≈3 months). So the failure that
 * matters is not "a fire found nothing" — it is "the fires stopped", and on
 * this board those two render IDENTICALLY: both leave the parent silent.
 *
 * Measured 2026-08-05 across the company's 40 active scheduled routines:
 * **16 of them had `lastRun.status === 'failed'` with
 * `failureReason: "Agent is not invokable in its current state"`**, spanning
 * all five roster agents (CTO 8, LeadDev 4, QuantTrader 2, CEO 1, CFO 1).
 * Every one of those 16 was, at that same moment, `status: active` with an
 * `enabled` trigger and a `nextRunAt` in the future.
 *
 * WHY NOTHING WE ALREADY RUN CAN SEE IT
 * -------------------------------------
 * `check:phantom-rest` (TRA-2422) clears a leaf as monitored on exactly that
 * predicate: routine `active` + trigger `enabled` + `nextRunAt` in the future.
 *
 * ⛔ `nextRunAt` IS A PROMISE, NOT A RECORD. It is recomputed from the cron
 * expression and moves forward whether or not the fire it describes ever
 * dispatched. A forward-looking field cannot witness a backward-looking
 * failure, so a routine that has failed every dispatch for a week is
 * byte-for-byte identical, on that predicate, to one that ran perfectly.
 * The discriminator is the RUN HISTORY, and nothing read it until this check.
 *
 * (Same shape one level up from TRA-2422 itself: that one caught "leaf claims a
 * monitor, routine does not exist"; this one catches "routine exists and is
 * armed, and its dispatches are dying". And it is the generalisation of
 * TRA-2836, where the TRA-2242 accrual runner sat frozen with this exact
 * `failureReason` and was found only by hand.)
 *
 * THE PREDICATE
 * -------------
 * Population = every routine with `status: 'active'` AND at least one trigger
 * that is `enabled` with `kind: 'schedule'`. That is deliberately the same set
 * `check:phantom-rest` treats as a live continuation path — this check grades
 * the claim that check makes.
 *
 * For each, classify the DISPATCH TAIL:
 *
 *   PENDING_FIRST_FIRE  no enabled trigger has ever fired (`lastFiredAt` null
 *                       on all of them) and `lastRun` is null. Healthy — a
 *                       routine armed today for a slot that has not come round
 *                       yet. Two of today's 40 are exactly this.
 *   HEALTHY             `lastRun.status` is a success state and no enabled
 *                       trigger fired later than it.
 *   LAST_DISPATCH_FAILED  `lastRun.status === 'failed'`. FINDING; carries
 *                       `failureReason` verbatim.
 *   FIRE_WITHOUT_RUN    a trigger's `lastFiredAt` is materially newer than the
 *                       newest recorded run (or a trigger has fired and
 *                       `lastRun` is null). FINDING — ⛔ A FIRED TRIGGER IS NOT
 *                       A RUN (TRA-2314, where the 21:00 ET archive fire was
 *                       proven on tape while its writes died on ENOSPC).
 *
 * ⛔ WHAT THIS CHECK DELIBERATELY DOES NOT DO
 * It does NOT evaluate the cron expression, so it does not count MISSED slots.
 * That needs a timezone-correct cron enumerator, and a half-right one would
 * manufacture findings on every DST boundary and every `31 7 *` one-shot. The
 * tail verdict above needs no cron at all and is not corrupted by a truncated
 * history, which is why it is the graded axis. Missed-slot counting is a
 * separate, harder instrument; do not bolt an approximation onto this one.
 *
 * THE TRAPS — each measured against the live API on 2026-08-05, each with a
 * control in `--selftest`
 * ------------------------------------------------------------------------
 *  1. ⛔⛔ THE LIST ROUTE DOES NOT POPULATE `recentRuns`. On
 *     `GET /api/companies/{id}/routines` the key is ABSENT — not `[]` —
 *     on all 187 rows, while `GET /api/routines/{id}` returns it populated.
 *     A check written as `(r.recentRuns || []).length === 0` therefore brands
 *     EVERY routine in the company as never-dispatched. This is the
 *     `blockedByIssueIds` trap (TRA-2364) on a different relation, and the
 *     defence is the same: assert the KEY IS PRESENT, never `|| []`.
 *
 *     What the list route DOES carry is `lastRun` — the full newest run object,
 *     key present on all 40 active rows — which is the entire tail verdict in
 *     one call. So this check reads the list and nothing else: no per-routine
 *     fan-out, and no dependence on the relation the list drops.
 *
 *  2. ⛔ `lastRun` IS NOT FILTERED TO SUCCESSES. 16 of today's 40 carry a
 *     `failed` one. A check that assumed `lastRun` meant "last GOOD run" would
 *     read the entire outage as healthy.
 *
 *  3. ⛔ AN UNKNOWN `lastRun.status` IS NOT A PASS. The live set is
 *     `completed` / `issue_created` / `failed`. A status this script has never
 *     seen exits BLIND for that row rather than falling through the success
 *     branch — a new terminal state must not be silently absorbed as healthy.
 *
 *  4. ⛔ A ZERO-ROW POPULATION IS BLIND, NOT CLEAN. "no armed routines are
 *     failing" and "no armed routines were looked at" render identically, and
 *     this detector's whole subject is a state that looks healthy. The count of
 *     rows actually graded is printed on every run and zero is a hard BLIND.
 *
 *  5. ⛔ `nextRunAt` LIVES ON `triggers[]`, NOT THE ROUTINE ROOT (TRA-2422
 *     trap 2), and so does `lastFiredAt`. A root-level read of either returns
 *     `undefined` on a perfectly armed routine.
 *
 *  6. ⛔ NON-SCHEDULE AND DISABLED TRIGGERS ARE NOT ARMING. A webhook trigger
 *     has no slot to miss; a disabled one fires never. Both are excluded from
 *     the population rather than counted as healthy members of it.
 *
 * FLEET VS ROUTINE — why there are two finding exit codes
 * ------------------------------------------------------
 * `LAST_DISPATCH_FAILED` on one routine is a routine to repair. The same
 * verdict on 16 routines across 5 different assignees is NOT 16 repairs — it is
 * one platform condition, and filing 16 tickets against it is how the real
 * cause gets buried. Exit 2 fires when findings span >= 3 distinct assignees or
 * >= 25% of the population, and says so in the report.
 *
 * VERDICTS / EXIT CODES
 *   0  CLEAN        — population non-empty, every armed routine's tail is healthy
 *   1  FINDINGS     — per-routine dispatch failures, routable to their owners
 *   2  FLEET        — the failures span the roster; treat as one platform condition
 *   3  BLIND        — the population or a row is untrustworthy. NOT a pass.
 *
 * BLIND outranks everything, including a zero count.
 *
 * This script performs GETs and NOTHING else.
 */

import { enumerateRoutines } from './lib/paperclip-enumeration.mjs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
};

const ROUTINE_LIMIT = Number(argOf('routine-limit', 500));
/** A trigger firing this much later than the newest run is a run that never happened. */
const FIRE_RUN_SLACK_MS = Number(argOf('fire-run-slack-ms', 5 * 60 * 1000));
const FLEET_MIN_ASSIGNEES = Number(argOf('fleet-min-assignees', 3));
const FLEET_MIN_SHARE = Number(argOf('fleet-min-share', 0.25));

export const VERDICT_EXIT = { CLEAN: 0, FINDINGS: 1, FLEET: 2, BLIND: 3 };

/** Terminal run states this script knows how to read. Trap 3. */
export const RUN_SUCCESS = new Set(['completed', 'issue_created']);
export const RUN_FAILURE = new Set(['failed']);
/** In-flight states — a dispatch that is still running is not yet a verdict. */
export const RUN_PENDING = new Set(['pending', 'queued', 'running', 'in_progress', 'dispatched']);

/* ------------------------------------------------------------------ *
 * Predicate
 * ------------------------------------------------------------------ */

/** Enabled schedule triggers only. Trap 6. */
export function armedTriggers(routine) {
  const triggers = routine.triggers;
  if (!Array.isArray(triggers)) return null; // caller turns this into BLIND
  return triggers.filter((t) => t && t.enabled === true && t.kind === 'schedule');
}

/**
 * Classify one routine's dispatch tail.
 *
 * Returns { state, detail } where `state` is one of PENDING_FIRST_FIRE /
 * HEALTHY / IN_FLIGHT / LAST_DISPATCH_FAILED / FIRE_WITHOUT_RUN / BLIND.
 */
export function classifyDispatch(routine, triggers, { slackMs = FIRE_RUN_SLACK_MS } = {}) {
  // Trap 1. The KEY, not the value. `undefined` here means we asked a route
  // that does not serve this relation, which is not the same as "never ran".
  if (!('lastRun' in routine)) {
    return {
      state: 'BLIND',
      detail:
        'row carries no `lastRun` key — the route did not serve the relation. ' +
        '(The list route drops `recentRuns` exactly this way; do not read an absent key as "never dispatched".)',
    };
  }

  const fires = triggers.map((t) => t.lastFiredAt).filter((v) => typeof v === 'string' && v);
  const newestFireMs = fires.length ? Math.max(...fires.map((v) => Date.parse(v))) : null;
  if (newestFireMs !== null && !Number.isFinite(newestFireMs)) {
    return { state: 'BLIND', detail: `unparseable trigger lastFiredAt among [${fires.join(', ')}]` };
  }

  const lastRun = routine.lastRun;

  if (lastRun === null || lastRun === undefined) {
    // Never dispatched. Healthy ONLY if nothing has fired either.
    if (newestFireMs === null) {
      return { state: 'PENDING_FIRST_FIRE', detail: 'armed, no trigger has fired yet' };
    }
    return {
      state: 'FIRE_WITHOUT_RUN',
      detail: `a trigger fired at ${new Date(newestFireMs).toISOString()} and no run was recorded at all`,
      firedAt: new Date(newestFireMs).toISOString(),
    };
  }

  const status = lastRun.status;
  const triggeredAt = lastRun.triggeredAt;
  const runMs = Date.parse(triggeredAt);
  if (!Number.isFinite(runMs)) {
    return { state: 'BLIND', detail: `lastRun.triggeredAt is not a timestamp: ${JSON.stringify(triggeredAt)}` };
  }

  // Trap 3 — resolve the status BEFORE the fire/run comparison, so an unknown
  // state can never reach a success branch.
  if (RUN_FAILURE.has(status)) {
    return {
      state: 'LAST_DISPATCH_FAILED',
      detail: lastRun.failureReason || '(no failureReason recorded)',
      triggeredAt,
      failureReason: lastRun.failureReason || null,
    };
  }
  if (RUN_PENDING.has(status)) {
    return { state: 'IN_FLIGHT', detail: `newest dispatch is still ${status}`, triggeredAt };
  }
  if (!RUN_SUCCESS.has(status)) {
    return {
      state: 'BLIND',
      detail: `unknown lastRun.status ${JSON.stringify(status)} — a state this check has never seen is not a pass`,
      triggeredAt,
    };
  }

  // Success — but only if the newest FIRE is accounted for by it.
  if (newestFireMs !== null && newestFireMs - runMs > slackMs) {
    return {
      state: 'FIRE_WITHOUT_RUN',
      detail:
        `a trigger fired at ${new Date(newestFireMs).toISOString()}, ` +
        `${Math.round((newestFireMs - runMs) / 60000)} min after the newest recorded run (${triggeredAt})`,
      firedAt: new Date(newestFireMs).toISOString(),
      triggeredAt,
    };
  }

  return { state: 'HEALTHY', detail: `newest dispatch ${status} at ${triggeredAt}`, triggeredAt };
}

const FINDING_STATES = new Set(['LAST_DISPATCH_FAILED', 'FIRE_WITHOUT_RUN']);

/* ------------------------------------------------------------------ *
 * The sweep — transport injected so the controls drive the whole pipeline,
 * enumeration guards included.
 * ------------------------------------------------------------------ */

export async function sweep(transport, opts = {}) {
  const limit = opts.routineLimit ?? ROUTINE_LIMIT;
  const slackMs = opts.slackMs ?? FIRE_RUN_SLACK_MS;

  const { routines, blind: enumBlind, probe } = await enumerateRoutines(transport.getRoutines, { limit });
  if (enumBlind) return { verdict: 'BLIND', blind: enumBlind, findings: [], graded: 0, routineCount: 0 };

  const population = [];
  const unreadable = [];
  for (const r of routines) {
    if (!r || r.status !== 'active') continue;
    const trig = armedTriggers(r);
    if (trig === null) {
      // Trap 5/1 again: no `triggers` key at all means the route dropped it.
      unreadable.push({ id: r.id, title: r.title, reason: 'row carries no `triggers` array' });
      continue;
    }
    if (trig.length === 0) continue; // not armed on a schedule; nothing to grade
    population.push({ routine: r, triggers: trig });
  }

  if (unreadable.length > 0) {
    return {
      verdict: 'BLIND',
      blind: `${unreadable.length} active routine(s) carried no \`triggers\` array — the population cannot be derived from this route`,
      findings: [],
      graded: 0,
      routineCount: routines.length,
      unreadable,
    };
  }

  // Trap 4. Zero graded rows is BLIND, never CLEAN.
  if (population.length === 0) {
    return {
      verdict: 'BLIND',
      blind:
        `0 of ${routines.length} routines are active with an enabled schedule trigger — ` +
        '"nothing is failing" and "nothing was looked at" are the same reading, and this detector exists for states that look healthy',
      findings: [],
      graded: 0,
      routineCount: routines.length,
    };
  }

  const findings = [];
  const blindRows = [];
  const tally = {};
  for (const { routine, triggers } of population) {
    const c = classifyDispatch(routine, triggers, { slackMs });
    tally[c.state] = (tally[c.state] || 0) + 1;
    if (c.state === 'BLIND') {
      blindRows.push({ id: routine.id, title: routine.title, reason: c.detail });
      continue;
    }
    if (!FINDING_STATES.has(c.state)) continue;
    findings.push({
      id: routine.id,
      short: String(routine.id).slice(0, 8),
      title: routine.title,
      assigneeAgentId: routine.assigneeAgentId || null,
      parentIssueId: routine.parentIssueId || null,
      state: c.state,
      detail: c.detail,
      failureReason: c.failureReason ?? null,
      triggeredAt: c.triggeredAt ?? null,
      crons: triggers.map((t) => `${t.cronExpression}|${t.timezone}`),
      nextRunAt: triggers.map((t) => t.nextRunAt).filter(Boolean).sort()[0] || null,
    });
  }

  if (blindRows.length > 0) {
    return {
      verdict: 'BLIND',
      blind: `${blindRows.length} armed routine(s) could not be classified`,
      blindRows,
      findings,
      graded: population.length,
      routineCount: routines.length,
      tally,
      probe,
    };
  }

  const assignees = new Set(findings.map((f) => f.assigneeAgentId || 'UNASSIGNED'));
  const share = findings.length / population.length;
  const fleet =
    findings.length > 0 && (assignees.size >= FLEET_MIN_ASSIGNEES || share >= FLEET_MIN_SHARE);

  return {
    verdict: findings.length === 0 ? 'CLEAN' : fleet ? 'FLEET' : 'FINDINGS',
    blind: null,
    findings,
    graded: population.length,
    routineCount: routines.length,
    tally,
    distinctAssignees: assignees.size,
    share,
    probe,
  };
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

export function renderReport(r, names = {}) {
  const out = [];
  const nm = (id) => (id ? names[String(id).slice(0, 8)] || String(id).slice(0, 8) : 'UNASSIGNED');
  out.push(`TRA-2331 routine-dispatch liveness — verdict ${r.verdict}`);
  out.push(`  routines read: ${r.routineCount ?? 0} · armed+scheduled (GRADED): ${r.graded ?? 0}`);
  if (r.tally) out.push(`  tail states: ${Object.entries(r.tally).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (r.verdict === 'BLIND') {
    out.push('');
    out.push(`  BLIND — ${r.blind}`);
    for (const b of r.blindRows || []) out.push(`    ${String(b.id).slice(0, 8)}  ${b.title || ''} — ${b.reason}`);
    for (const u of r.unreadable || []) out.push(`    ${String(u.id).slice(0, 8)}  ${u.title || ''} — ${u.reason}`);
    out.push('  A BLIND run is NOT a pass. Do not read it as "no dispatch failures".');
    return out;
  }

  if (r.findings.length === 0) {
    out.push('');
    out.push(`  CLEAN — every one of the ${r.graded} armed routines has a healthy dispatch tail.`);
    return out;
  }

  out.push('');
  out.push(`  ${r.findings.length} of ${r.graded} armed routines have a broken dispatch tail:`);
  for (const f of r.findings.sort((a, b) => String(a.triggeredAt).localeCompare(String(b.triggeredAt)))) {
    out.push(`    ${f.short}  ${nm(f.assigneeAgentId).padEnd(12)} ${f.state}`);
    out.push(`              ${(f.title || '').slice(0, 90)}`);
    out.push(`              cron ${f.crons.join(' ; ')} · next ${f.nextRunAt || 'null'}`);
    out.push(`              ${f.detail}`);
  }

  if (r.verdict === 'FLEET') {
    out.push('');
    out.push(
      `  FLEET — the failures span ${r.distinctAssignees} distinct assignees ` +
        `(${(r.share * 100).toFixed(0)}% of the armed population). This is ONE platform condition, not ` +
        `${r.findings.length} routines to repair. ⛔ Do not file a ticket per routine.`,
    );
  }
  out.push('');
  out.push(
    '  ⛔ Every routine above still reads `active` + `enabled` + a FUTURE `nextRunAt`, so ' +
      '`check:phantom-rest` counts each of them as a live continuation path. `nextRunAt` is a ' +
      'promise, not a record.',
  );
  return out;
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const FUTURE = '2099-01-01T00:00:00.000Z';

function routineRow(id, over = {}) {
  return {
    id,
    title: `routine ${id}`,
    status: 'active',
    assigneeAgentId: 'agent-a',
    parentIssueId: null,
    triggers: [
      {
        id: `${id}-t`,
        kind: 'schedule',
        enabled: true,
        cronExpression: '45 16 * * 1-5',
        timezone: 'America/New_York',
        nextRunAt: FUTURE,
        lastFiredAt: '2026-08-04T20:45:25.000Z',
      },
    ],
    lastRun: {
      status: 'completed',
      triggeredAt: '2026-08-04T20:45:25.000Z',
      failureReason: null,
    },
    ...over,
  };
}

/** A board with `n` healthy filler rows so a single finding is not a fleet. */
function boardOf(rows, filler = 8) {
  const pad = [];
  for (let i = 0; i < filler; i += 1) pad.push(routineRow(`pad-${i}`));
  return [...rows, ...pad];
}

function transportOf(rows) {
  return { getRoutines: async () => rows };
}

const CASES = [
  {
    name: 'a healthy tail => CLEAN',
    rows: boardOf([]),
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`);
      assert(r.graded === 8, `expected 8 graded, got ${r.graded}`);
    },
  },
  {
    name: 'TRAP 2 — lastRun.status FAILED => finding (lastRun is not filtered to successes)',
    rows: boardOf([
      routineRow('r-fail', {
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:30:55.000Z',
          failureReason: 'Agent is not invokable in its current state',
        },
      }),
    ]),
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.findings.length === 1, `expected 1 finding, got ${r.findings.length}`);
      assert(r.findings[0].state === 'LAST_DISPATCH_FAILED', r.findings[0].state);
      assert(
        r.findings[0].failureReason === 'Agent is not invokable in its current state',
        'failureReason must be carried verbatim, not summarised',
      );
    },
  },
  {
    name: '⛔ a FUTURE nextRunAt does NOT rescue a failed tail (the whole point)',
    rows: boardOf([
      routineRow('r-promise', {
        triggers: [
          {
            kind: 'schedule',
            enabled: true,
            cronExpression: '45 16 * * 1-5',
            timezone: 'America/New_York',
            nextRunAt: FUTURE,
            lastFiredAt: '2026-08-04T20:30:55.000Z',
          },
        ],
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T20:30:55.000Z', failureReason: 'boom' },
      }),
    ]),
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.findings[0].nextRunAt === FUTURE, 'the future promise is reported alongside the finding');
    },
  },
  {
    name: 'PENDING_FIRST_FIRE — armed today, never fired, lastRun null => healthy, not a finding',
    rows: boardOf([
      routineRow('r-new', {
        triggers: [
          { kind: 'schedule', enabled: true, cronExpression: '30 20 * * 1-5', timezone: 'UTC', nextRunAt: FUTURE, lastFiredAt: null },
        ],
        lastRun: null,
      }),
    ]),
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`);
      assert(r.tally.PENDING_FIRST_FIRE === 1, JSON.stringify(r.tally));
    },
  },
  {
    name: 'FIRE_WITHOUT_RUN — a trigger fired and lastRun is null => finding (TRA-2314)',
    rows: boardOf([
      routineRow('r-ghost', {
        triggers: [
          { kind: 'schedule', enabled: true, cronExpression: '0 1 * * *', timezone: 'UTC', nextRunAt: FUTURE, lastFiredAt: '2026-08-04T01:00:00.000Z' },
        ],
        lastRun: null,
      }),
    ]),
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.findings[0].state === 'FIRE_WITHOUT_RUN', r.findings[0].state);
    },
  },
  {
    name: 'FIRE_WITHOUT_RUN — a fire NEWER than the newest run by more than the slack => finding',
    rows: boardOf([
      routineRow('r-lag', {
        triggers: [
          { kind: 'schedule', enabled: true, cronExpression: '0 1 * * *', timezone: 'UTC', nextRunAt: FUTURE, lastFiredAt: '2026-08-04T23:00:00.000Z' },
        ],
        lastRun: { status: 'completed', triggeredAt: '2026-08-03T23:00:00.000Z', failureReason: null },
      }),
    ]),
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.findings[0].state === 'FIRE_WITHOUT_RUN', r.findings[0].state);
    },
  },
  {
    name: 'a fire INSIDE the slack window of its own run is not a finding (the run IS that fire)',
    rows: boardOf([
      routineRow('r-same', {
        triggers: [
          { kind: 'schedule', enabled: true, cronExpression: '0 1 * * *', timezone: 'UTC', nextRunAt: FUTURE, lastFiredAt: '2026-08-04T20:45:25.400Z' },
        ],
        lastRun: { status: 'completed', triggeredAt: '2026-08-04T20:45:25.000Z', failureReason: null },
      }),
    ]),
    expect: (r) => assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`),
  },
  {
    name: 'TRAP 1 — the row carries NO `lastRun` key => BLIND, never "never dispatched"',
    rows: boardOf([(() => { const r = routineRow('r-nokey'); delete r.lastRun; return r; })()]),
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/lastRun/.test(r.blindRows[0].reason), r.blindRows[0].reason);
    },
  },
  {
    name: 'TRAP 1b — the row carries NO `triggers` array => BLIND (population underivable)',
    rows: boardOf([(() => { const r = routineRow('r-notrig'); delete r.triggers; return r; })()]),
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/triggers/.test(r.blind), r.blind);
    },
  },
  {
    name: 'TRAP 3 — an UNKNOWN lastRun.status => BLIND, never absorbed as a success',
    rows: boardOf([routineRow('r-weird', { lastRun: { status: 'quiesced', triggeredAt: '2026-08-04T20:45:25.000Z' } })]),
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/quiesced/.test(r.blindRows[0].reason), r.blindRows[0].reason);
    },
  },
  {
    name: 'an IN-FLIGHT dispatch is neither a pass nor a finding',
    rows: boardOf([routineRow('r-run', { lastRun: { status: 'running', triggeredAt: '2026-08-04T20:45:25.000Z' } })]),
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`);
      assert(r.tally.IN_FLIGHT === 1, JSON.stringify(r.tally));
    },
  },
  {
    name: 'TRAP 6 — a DISABLED trigger is not arming => excluded from the population, not counted healthy',
    rows: boardOf([
      routineRow('r-off', {
        triggers: [{ kind: 'schedule', enabled: false, cronExpression: '0 1 * * *', timezone: 'UTC', nextRunAt: FUTURE, lastFiredAt: null }],
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T01:00:00.000Z', failureReason: 'boom' },
      }),
    ]),
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`);
      assert(r.graded === 8, `disabled row must not be graded; graded=${r.graded}`);
    },
  },
  {
    name: 'TRAP 6b — a WEBHOOK trigger has no slot to miss => excluded',
    rows: boardOf([
      routineRow('r-hook', {
        triggers: [{ kind: 'webhook', enabled: true, nextRunAt: null, lastFiredAt: null }],
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T01:00:00.000Z', failureReason: 'boom' },
      }),
    ]),
    expect: (r) => assert(r.graded === 8, `webhook row must not be graded; graded=${r.graded}`),
  },
  {
    name: 'an ARCHIVED routine is not swept even with a failed tail',
    rows: boardOf([
      routineRow('r-arch', {
        status: 'archived',
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T01:00:00.000Z', failureReason: 'boom' },
      }),
    ]),
    expect: (r) => assert(r.verdict === 'CLEAN' && r.graded === 8, `${r.verdict}/${r.graded}`),
  },
  {
    name: 'FLEET — failures spanning 3 assignees => exit 2, ONE condition not N repairs',
    rows: boardOf(
      ['a', 'b', 'c'].map((s, i) =>
        routineRow(`r-fleet-${i}`, {
          assigneeAgentId: `agent-${s}`,
          lastRun: { status: 'failed', triggeredAt: '2026-08-04T13:12:15.000Z', failureReason: 'Agent is not invokable in its current state' },
        }),
      ),
      20,
    ),
    expect: (r) => {
      assert(r.verdict === 'FLEET', `expected FLEET, got ${r.verdict}`);
      assert(r.distinctAssignees === 3, String(r.distinctAssignees));
      assert(VERDICT_EXIT[r.verdict] === 2, 'FLEET must exit 2');
    },
  },
  {
    name: 'FLEET by SHARE — one owner but a quarter of the fleet => still a platform condition',
    rows: boardOf(
      [0, 1, 2].map((i) =>
        routineRow(`r-share-${i}`, {
          lastRun: { status: 'failed', triggeredAt: '2026-08-04T13:12:15.000Z', failureReason: 'boom' },
        }),
      ),
      6,
    ),
    expect: (r) => assert(r.verdict === 'FLEET', `expected FLEET, got ${r.verdict}`),
  },
  {
    name: 'TRAP 4 — ZERO armed routines => BLIND, never CLEAN ("0 found" vs "0 looked at")',
    rows: [routineRow('r-arch2', { status: 'archived' })],
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/0 of 1/.test(r.blind), r.blind);
    },
  },
  {
    name: 'ENUMERATION — the routines route returns [] => BLIND (shared guard still wired up)',
    rows: [],
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/0 rows/.test(r.blind), r.blind);
    },
  },
];

async function selftest() {
  let pass = 0;
  const seen = new Set();
  for (const c of CASES) {
    try {
      const r = await sweep(transportOf(c.rows), {});
      seen.add(r.verdict);
      c.expect(r);
      // Every board must also render without throwing — a detector nobody can
      // read is a detector nobody runs.
      renderReport(r);
      console.log(`ok    ${c.name}`);
      pass += 1;
    } catch (err) {
      console.log(`FAIL  ${c.name}\n        ${err.message}`);
    }
  }

  // GLOBAL — this script must never emit a write. Assert on its own source.
  try {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL(import.meta.url), 'utf8'),
    );
    const body = src.slice(src.indexOf('import { enumerateRoutines }'));
    assert(!/method:\s*['"](POST|PATCH|PUT|DELETE)/i.test(body), 'a write verb appears in this detector');
    console.log('ok    GLOBAL — the detector performs GETs and nothing else');
    pass += 1;
  } catch (err) {
    console.log(`FAIL  GLOBAL write-verb control\n        ${err.message}`);
  }

  const total = CASES.length + 1;
  console.log('');
  console.log(`${pass}/${total} controls pass; verdicts reachable: ${[...seen].sort().join(', ')}`);
  for (const v of ['CLEAN', 'FINDINGS', 'FLEET', 'BLIND']) {
    if (!seen.has(v)) console.log(`WARN  verdict ${v} was never reached by any control`);
  }
  return pass === total ? 0 : 1;
}

/* ================================================================== */

function liveTransport() {
  const raw = String(process.env.PAPERCLIP_API_URL || '').replace(/\/+$/, '');
  const BASE = argOf('base', raw.replace(/\/api$/, ''));
  const KEY = process.env.PAPERCLIP_API_KEY;
  const CO = argOf('company', process.env.PAPERCLIP_COMPANY_ID);
  if (!BASE || !KEY || !CO) {
    throw new Error('PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must all be set');
  }
  const headers = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
  const get = async (url) => {
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url} — ${text.slice(0, 160)}`);
    return JSON.parse(text);
  };
  const unwrap = (b, key) => {
    if (Array.isArray(b)) return b;
    if (b && Array.isArray(b[key])) return b[key];
    if (b && Array.isArray(b.data)) return b.data;
    return null;
  };
  return {
    listAgents: async () => unwrap(await get(`${BASE}/api/companies/${CO}/agents`), 'agents') || [],
    getRoutines: async ({ limit, offset }) =>
      unwrap(await get(`${BASE}/api/companies/${CO}/routines?limit=${limit}&offset=${offset}`), 'routines'),
  };
}

async function main() {
  if (argv.includes('--selftest')) return selftest();

  const transport = liveTransport();
  const result = await sweep(transport, { routineLimit: ROUTINE_LIMIT });

  let names = {};
  try {
    for (const a of await transport.listAgents()) {
      if (a && a.id) names[String(a.id).slice(0, 8)] = a.name || a.nameKey || String(a.id).slice(0, 8);
    }
  } catch {
    names = {}; // cosmetic only — never changes the verdict
  }

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          issue: 'TRA-2331',
          checkedAt: new Date().toISOString(),
          verdict: result.verdict,
          blind: result.blind,
          routineCount: result.routineCount,
          graded: result.graded,
          tally: result.tally,
          distinctAssignees: result.distinctAssignees,
          findings: result.findings,
          blindRows: result.blindRows,
        },
        null,
        2,
      ),
    );
  } else {
    for (const l of renderReport(result, names)) console.log(l);
  }
  return VERDICT_EXIT[result.verdict] ?? 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('ERROR', err?.stack || err);
    process.exit(3);
  });
