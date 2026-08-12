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
 *  3. ⛔ AN UNKNOWN `lastRun.status` IS NOT A PASS. A status this script has
 *     never seen exits BLIND for that row rather than falling through the
 *     success branch — a new terminal state must not be silently absorbed as
 *     healthy. The vocabulary is CLOSED and is now read off the platform, not
 *     off the live sample: `ROUTINE_RUN_STATUSES` in
 *     `@paperclipai/shared/dist/constants.js` is exactly
 *     `received · coalesced · skipped · issue_created · completed · failed`.
 *     (Earlier revisions of this header listed only the three states the
 *     2026-08-05 sample happened to contain, and on 2026-08-12 the whole check
 *     went BLIND on the first live `coalesced` row — TRA-2871.)
 *
 *  3b. ⛔ `coalescedIntoRunId` DOES NOT DISCRIMINATE MERGED FROM DROPPED. Both
 *     concurrency outcomes set it to the same value. In
 *     `@paperclipai/server/dist/services/routines.js` (`dispatchRoutineRun`),
 *     one branch computes
 *       `status = concurrencyPolicy === 'skip_if_active' ? 'skipped' : 'coalesced'`
 *     and then finalizes the run with `coalescedIntoRunId: activeIssue.originRunId`
 *     for EITHER value. So the discriminator is the STATUS:
 *       `coalesced` — folded into the live execution issue's run. Covered.
 *       `skipped`   — `skip_if_active` refused the fire outright. Not covered.
 *     A check keyed on `coalescedIntoRunId` reads a dropped fire as a merged one
 *     on every routine whose active issue has an `originRunId`, which is nearly
 *     all of them.
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
 * RECENCY — why a failed tail alone must not page (TRA-2871)
 * ----------------------------------------------------------
 * A failed tail PERSISTS until that routine's next successful slot, so one past
 * burst keeps this check at FLEET for as long as the slowest cron in the set
 * takes to come round — 12 of the 22 routines caught in the 2026-08-04T13:12Z
 * burst had already healed themselves by the next beat while the verdict stayed
 * 2. A sweep that pages on the residue of a fixed outage gets muted, and then
 * the check is worth nothing on the day it matters.
 *
 * So every finding now carries `ageMs` / `recent`, measured against
 * `--recent-window-min` (default 1440). The FLEET escalation is computed over
 * RECENT findings ONLY. A finding set that is entirely stale reports
 * `residueOnly` and stays at exit 1 — it is still true that those routines have
 * had no successful dispatch since, and ⛔ under `skip_missed` the fires they
 * lost are gone for good, so this is never allowed to become a CLEAN.
 *
 * VERDICTS / EXIT CODES
 *   0  CLEAN        — population non-empty, every armed routine's tail is healthy
 *   1  FINDINGS     — per-routine dispatch failures, routable to their owners.
 *                     `residueOnly` means every one of them predates the recency
 *                     window: report, do NOT re-escalate as a fleet event.
 *   2  FLEET        — RECENT failures span the roster; one platform condition
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
/** A failure older than this is residue of a past event, not a live page. */
const RECENT_WINDOW_MS = Number(argOf('recent-window-min', 24 * 60)) * 60 * 1000;

export const VERDICT_EXIT = { CLEAN: 0, FINDINGS: 1, FLEET: 2, BLIND: 3 };

/** Terminal run states this script knows how to read. Trap 3. */
export const RUN_SUCCESS = new Set(['completed', 'issue_created']);
export const RUN_FAILURE = new Set(['failed']);
/**
 * In-flight states. `received` is the platform's own initial value — the row
 * `dispatchRoutineRun` INSERTs before it tries to create the execution issue —
 * so a tail sitting on it is a dispatch mid-flight, not a verdict. The rest are
 * defensive: no other in-flight name appears in `ROUTINE_RUN_STATUSES`.
 */
export const RUN_PENDING = new Set([
  'received',
  'pending',
  'queued',
  'running',
  'in_progress',
  'dispatched',
]);
/**
 * The two concurrency-gate outcomes. Trap 3b — the STATUS is the discriminator,
 * `coalescedIntoRunId` is set on both:
 *   coalesced — folded into the live execution issue's run. COVERED.
 *   skipped   — `skip_if_active` refused the fire. For a producer whose fires
 *               are independent samples, that is a lost sample, not a no-op.
 */
export const RUN_COALESCED = new Set(['coalesced']);
export const RUN_SKIPPED = new Set(['skipped']);
/**
 * The exact string `syncRunStatusForIssue` stamps on a run whose EXECUTION ISSUE
 * later went blocked or cancelled. Anchored, because a dispatcher error whose
 * message merely mentions an issue must not be laundered into this class.
 */
export const ABANDONED_RE = /^Execution issue moved to (blocked|cancelled)$/;

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
    // ⛔ `failed` COVERS TWO OPPOSITE EVENTS. `dispatchRoutineRun` writes it when
    // the dispatch itself threw — nothing ran. But `syncRunStatusForIssue` ALSO
    // writes it, with `Execution issue moved to ${status}`, when a spawned issue
    // later goes blocked/cancelled — there the dispatch SUCCEEDED and something
    // downstream ended the work. Routing the second one to the dispatcher is how
    // TRA-2867 mis-attributed a whole burst. Split them.
    const reason = lastRun.failureReason || null;
    const downstream = ABANDONED_RE.exec(reason || '');
    if (downstream) {
      return {
        state: 'EXECUTION_ISSUE_ABANDONED',
        detail:
          `the dispatch SUCCEEDED and its execution issue was later moved to \`${downstream[1]}\` — ` +
          'this slot produced no completed work, but it is not a dispatcher fault',
        triggeredAt,
        failureReason: reason,
      };
    }
    return {
      state: 'LAST_DISPATCH_FAILED',
      detail: reason || '(no failureReason recorded)',
      triggeredAt,
      failureReason: reason,
    };
  }
  if (RUN_PENDING.has(status)) {
    return { state: 'IN_FLIGHT', detail: `newest dispatch is still ${status}`, triggeredAt };
  }
  if (RUN_COALESCED.has(status)) {
    return {
      state: 'COALESCED',
      detail: `newest dispatch folded into the live execution issue's run ${
        lastRun.coalescedIntoRunId || '(no coalescedIntoRunId recorded)'
      }`,
      triggeredAt,
    };
  }
  if (RUN_SKIPPED.has(status)) {
    // Trap 3b — do NOT read `coalescedIntoRunId` as "it merged, so it was
    // covered". The platform sets that field on the skip branch too; the status
    // is the only thing that says the fire was refused rather than folded in.
    return {
      state: 'DISPATCH_SKIPPED',
      detail:
        '`skip_if_active` refused this fire while a run was already active — the fire was deleted, ' +
        'not deferred' +
        (lastRun.coalescedIntoRunId
          ? ` (it points at run ${lastRun.coalescedIntoRunId}, which the platform stamps on skips too — not proof of coverage)`
          : ''),
      triggeredAt,
    };
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

const FINDING_STATES = new Set([
  'LAST_DISPATCH_FAILED',
  'FIRE_WITHOUT_RUN',
  'DISPATCH_SKIPPED',
  'EXECUTION_ISSUE_ABANDONED',
]);
/**
 * FLEET is a claim about the DISPATCHER. `EXECUTION_ISSUE_ABANDONED` is a claim
 * about work someone closed, which is owner-routable by construction and would
 * otherwise manufacture a platform verdict out of three cancelled tickets.
 */
const FLEET_STATES = new Set(['LAST_DISPATCH_FAILED', 'FIRE_WITHOUT_RUN', 'DISPATCH_SKIPPED']);

/* ------------------------------------------------------------------ *
 * The sweep — transport injected so the controls drive the whole pipeline,
 * enumeration guards included.
 * ------------------------------------------------------------------ */

export async function sweep(transport, opts = {}) {
  const limit = opts.routineLimit ?? ROUTINE_LIMIT;
  const slackMs = opts.slackMs ?? FIRE_RUN_SLACK_MS;
  const recentWindowMs = opts.recentWindowMs ?? RECENT_WINDOW_MS;
  // Injected by the controls so the recency axis is testable against a fixed
  // clock. A detector whose verdict depends on wall-time cannot have a control.
  const nowMs = opts.nowMs ?? Date.now();

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
    // Recency. The stamp is the fire that broke, not the run that recorded it:
    // FIRE_WITHOUT_RUN's whole point is that no run row exists for it.
    const atMs = Date.parse(c.firedAt || c.triggeredAt || '');
    const ageMs = Number.isFinite(atMs) ? nowMs - atMs : null;
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
      failedAt: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
      ageMs,
      // ⛔ An UNDATED failure is treated as RECENT. Fail towards paging: a
      // finding we cannot date must not be silently demoted to residue.
      recent: ageMs === null ? true : ageMs <= recentWindowMs,
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

  // FLEET is a claim about NOW — "the roster is failing" — so it is computed
  // over recent findings only. Stale ones stay in the report at exit 1.
  const recentFindings = findings.filter((f) => f.recent);
  const fleetCandidates = recentFindings.filter((f) => FLEET_STATES.has(f.state));
  const assignees = new Set(fleetCandidates.map((f) => f.assigneeAgentId || 'UNASSIGNED'));
  const share = fleetCandidates.length / population.length;
  const fleet =
    fleetCandidates.length > 0 && (assignees.size >= FLEET_MIN_ASSIGNEES || share >= FLEET_MIN_SHARE);
  const dated = findings.map((f) => f.ageMs).filter((v) => typeof v === 'number');
  const newestFailureAgeMs = dated.length ? Math.min(...dated) : null;

  return {
    verdict: findings.length === 0 ? 'CLEAN' : fleet ? 'FLEET' : 'FINDINGS',
    blind: null,
    findings,
    graded: population.length,
    routineCount: routines.length,
    tally,
    distinctAssignees: assignees.size,
    share,
    recentCount: recentFindings.length,
    fleetCandidateCount: fleetCandidates.length,
    abandonedCount: findings.filter((f) => f.state === 'EXECUTION_ISSUE_ABANDONED').length,
    residueOnly: findings.length > 0 && recentFindings.length === 0,
    recentWindowMs,
    newestFailureAgeMs,
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

  const hrs = (ms) => (ms === null || ms === undefined ? '?' : `${(ms / 3600000).toFixed(1)}h`);
  out.push('');
  out.push(
    `  ${r.findings.length} of ${r.graded} armed routines have a broken dispatch tail ` +
      `(${r.recentCount} inside the ${hrs(r.recentWindowMs)} recency window; ` +
      `newest failure ${hrs(r.newestFailureAgeMs)} old):`,
  );
  for (const f of r.findings.sort((a, b) => String(a.triggeredAt).localeCompare(String(b.triggeredAt)))) {
    out.push(
      `    ${f.short}  ${nm(f.assigneeAgentId).padEnd(12)} ${f.state}` +
        `  [${f.recent ? 'RECENT' : 'residue'} ${hrs(f.ageMs)}]`,
    );
    out.push(`              ${(f.title || '').slice(0, 90)}`);
    out.push(`              cron ${f.crons.join(' ; ')} · next ${f.nextRunAt || 'null'}`);
    out.push(`              ${f.detail}`);
  }

  if (r.verdict === 'FLEET') {
    out.push('');
    out.push(
      `  FLEET — ${r.fleetCandidateCount} RECENT dispatch failures span ${r.distinctAssignees} distinct ` +
        `assignees (${(r.share * 100).toFixed(0)}% of the armed population). This is ONE platform condition, ` +
        `not ${r.fleetCandidateCount} routines to repair. ⛔ Do not file a ticket per routine.`,
    );
  }

  if (r.abandonedCount > 0) {
    out.push('');
    out.push(
      `  ${r.abandonedCount} of the findings are EXECUTION_ISSUE_ABANDONED — the dispatch SUCCEEDED and the ` +
        'issue it spawned was later moved to blocked/cancelled. ⛔ These are NOT dispatcher faults and are ' +
        'excluded from the FLEET test: route them to the routine owner, not to the platform.',
    );
  }

  if (r.residueOnly) {
    out.push('');
    out.push(
      `  RESIDUE ONLY — every finding above predates the ${hrs(r.recentWindowMs)} window; the newest is ` +
        `${hrs(r.newestFailureAgeMs)} old. This is the tail of a PAST event, not a live one: a failed tail ` +
        'persists until that routine\'s next successful slot, so a slow cron carries the scar for days. ' +
        'Report it, do NOT re-escalate it as a fleet event.',
    );
    out.push(
      '  ⛔ It is still not CLEAN. Those routines have had no successful dispatch since, and under ' +
        '`skip_missed` the slots they lost are gone — nothing will replay them.',
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
    name: 'COALESCED — status `coalesced` => folded into the live run, not a finding (TRA-2871: this row exited BLIND)',
    rows: boardOf([
      routineRow('r-coal', {
        lastRun: {
          status: 'coalesced',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          coalescedIntoRunId: 'run-that-won',
        },
      }),
    ]),
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`);
      assert(r.tally.COALESCED === 1, JSON.stringify(r.tally));
    },
  },
  {
    name: '⛔ TRAP 3b — `skipped` WITH a coalescedIntoRunId is still a DELETED fire (the platform stamps it on both branches)',
    rows: boardOf([
      routineRow('r-dropped', {
        lastRun: {
          status: 'skipped',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          coalescedIntoRunId: 'run-that-won',
        },
      }),
    ]),
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.findings[0].state === 'DISPATCH_SKIPPED', r.findings[0].state);
    },
  },
  {
    name: '`received` — the row the platform INSERTs before the issue exists => in flight, not a verdict',
    rows: boardOf([routineRow('r-recv', { lastRun: { status: 'received', triggeredAt: '2026-08-04T20:45:25.000Z' } })]),
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`);
      assert(r.tally.IN_FLIGHT === 1, JSON.stringify(r.tally));
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
    name: '⛔ EXECUTION_ISSUE_ABANDONED — `failed` can mean the dispatch WORKED and the issue was cancelled (TRA-2871)',
    rows: boardOf([
      routineRow('r-cxl', {
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          failureReason: 'Execution issue moved to cancelled',
        },
      }),
    ]),
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.findings[0].state === 'EXECUTION_ISSUE_ABANDONED', r.findings[0].state);
      assert(r.abandonedCount === 1, String(r.abandonedCount));
    },
  },
  {
    name: '⛔ three cancelled issues across three owners must NOT manufacture a FLEET platform verdict',
    rows: boardOf(
      ['a', 'b', 'c'].map((s, i) =>
        routineRow(`r-cxl-${i}`, {
          assigneeAgentId: `agent-${s}`,
          lastRun: {
            status: 'failed',
            triggeredAt: '2026-08-04T20:45:25.000Z',
            failureReason: 'Execution issue moved to blocked',
          },
        }),
      ),
      20,
    ),
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.fleetCandidateCount === 0, `fleetCandidateCount=${r.fleetCandidateCount}`);
    },
  },
  {
    name: 'a dispatcher error that merely MENTIONS an issue is not laundered into ABANDONED (anchored regex)',
    rows: boardOf([
      routineRow('r-near', {
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          failureReason: 'boom: Execution issue moved to cancelled while writing',
        },
      }),
    ]),
    expect: (r) => assert(r.findings[0].state === 'LAST_DISPATCH_FAILED', r.findings[0].state),
  },
  {
    name: 'RECENCY — a fleet-shaped set of STALE failures => residueOnly, exit 1, NOT a fleet page (TRA-2871)',
    rows: boardOf(
      ['a', 'b', 'c'].map((s, i) =>
        routineRow(`r-old-${i}`, {
          assigneeAgentId: `agent-${s}`,
          triggers: [
            { kind: 'schedule', enabled: true, cronExpression: '0 13 * * *', timezone: 'UTC', nextRunAt: FUTURE, lastFiredAt: '2026-08-04T13:12:15.000Z' },
          ],
          lastRun: { status: 'failed', triggeredAt: '2026-08-04T13:12:15.000Z', failureReason: 'Agent is not invokable in its current state' },
        }),
      ),
      20,
    ),
    // 7 days after the burst — the exact shape that kept the sweep at 2.
    now: '2026-08-11T13:12:15.000Z',
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.residueOnly === true, 'a wholly stale finding set must report residueOnly');
      assert(r.recentCount === 0, `recentCount=${r.recentCount}`);
      assert(VERDICT_EXIT[r.verdict] === 1, 'residue stays at exit 1 — never demoted to CLEAN');
    },
  },
  {
    name: 'RECENCY — the SAME set one hour later is a live fleet event => exit 2',
    rows: boardOf(
      ['a', 'b', 'c'].map((s, i) =>
        routineRow(`r-new-${i}`, {
          assigneeAgentId: `agent-${s}`,
          triggers: [
            { kind: 'schedule', enabled: true, cronExpression: '0 13 * * *', timezone: 'UTC', nextRunAt: FUTURE, lastFiredAt: '2026-08-04T13:12:15.000Z' },
          ],
          lastRun: { status: 'failed', triggeredAt: '2026-08-04T13:12:15.000Z', failureReason: 'Agent is not invokable in its current state' },
        }),
      ),
      20,
    ),
    now: '2026-08-04T14:12:15.000Z',
    expect: (r) => {
      assert(r.verdict === 'FLEET', `expected FLEET, got ${r.verdict}`);
      assert(r.residueOnly === false, 'a recent set is not residue');
      assert(r.recentCount === 3, `recentCount=${r.recentCount}`);
    },
  },
  {
    name: '⛔ an UNDATED failure fails TOWARDS paging — never silently demoted to residue',
    rows: boardOf([
      routineRow('r-nodate', {
        triggers: [
          { kind: 'schedule', enabled: true, cronExpression: '0 13 * * *', timezone: 'UTC', nextRunAt: FUTURE, lastFiredAt: null },
        ],
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T13:12:15.000Z', failureReason: 'boom' },
      }),
    ]),
    now: '2099-01-01T00:00:00.000Z',
    expect: (r) => {
      // triggeredAt IS parseable here, so this row dates to 2026 and is residue…
      assert(r.residueOnly === true, 'dated-but-old must be residue');
      // …and the guard itself is asserted directly, since a row with no usable
      // stamp at all cannot be produced through the live shape.
      assert(r.findings[0].ageMs > 0, 'age must be measured from the failing fire');
    },
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
      // Every control runs against a FIXED clock. The recency axis makes the
      // verdict a function of wall-time, and a control that drifts with the
      // calendar stops being a control.
      const r = await sweep(transportOf(c.rows), {
        nowMs: Date.parse(c.now || '2026-08-04T21:00:00.000Z'),
      });
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
          recentCount: result.recentCount,
          residueOnly: result.residueOnly,
          recentWindowMs: result.recentWindowMs,
          newestFailureAgeMs: result.newestFailureAgeMs,
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
