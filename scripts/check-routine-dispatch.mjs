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
 * ⛔⛔ WHICH SUBJECT THAT CONDITION IS ABOUT — TRA-3487
 * ----------------------------------------------------
 * Until TRA-3487 this check had NO concept of an owner pause (`grep -i pause`
 * over the whole file returned zero hits) and its FLEET banner asserted, in
 * fixed prose, "This is ONE platform condition" — a claim about THE DISPATCHER.
 *
 * Per TRA-2871 that subject is usually WRONG. `INVOKABLE_AGENT_STATUSES` is
 * `{active, idle, running, error}` — read off `@paperclipai/shared/dist/
 * agent-eligibility.js`, and note `running` IS invokable — so the message
 * "Agent is not invokable in its current state" can NEVER mean "busy". It is
 * emitted only for `paused` / `terminated` / `pending_approval` / out-of-enum.
 * The 2026-08-04T13:12Z burst was 100% roster coverage of PAUSED agents.
 *
 * So the banner was right that it was ONE condition and named the wrong
 * subject, handing the next responder a pre-committed "platform fault" verdict
 * twice a day. TRA-2867 and TRA-2871 each took exactly that wrong turn.
 *
 * Every `LAST_DISPATCH_FAILED` is now resolved against the durable pause tape
 * (`scripts/lib/paperclip-pause-tape.mjs`) AT THE FAILURE INSTANT, and splits:
 *
 *   OWNER_PAUSED         the assignee was `paused` when the dispatch died.
 *   OWNER_TERMINATED     the assignee was `terminated`. (Live on this board:
 *                        `e1b97e28`'s assignee `2fc6fe3b` is terminated, which
 *                        is why no agent can archive it — it needs a BOARD
 *                        re-home, not a dispatcher repair.)
 *   OWNER_STATE_UNKNOWN  attribution could not be completed. See below.
 *
 * All three are STILL FINDINGS — those slots produced no completed work — but
 * they are held OUT of the FLEET test exactly the way
 * `EXECUTION_ISSUE_ABANDONED` already was, because they are owner/board
 * routable and not claims about the dispatcher. The banner now NAMES the
 * subject it is asserting instead of asserting "platform" unconditionally, and
 * a roster-wide pause burst prints an OWNER-side banner instead.
 *
 * ⛔ WHY ATTRIBUTION FAILS CLOSED
 * `resume` writes `{status:'idle', pauseReason:null, pausedAt:null}` — it
 * ERASES the evidence, so reading the agent row proves nothing (TRA-2867 cited
 * exactly such a read as proof the agents were fine). And `PATCH /agents/:id`
 * accepts `status:'paused'` while logging only `agent.updated` with
 * `{changedTopLevelKeys:['status']}` — THE KEY, NEVER THE VALUE. A resolver
 * that ignored that would print INVOKABLE for a PATCH-paused owner, which
 * reads byte-identically to a true negative. So an unreadable tape, a window
 * that does not reach the failure, or a status-touching PATCH all resolve
 * UNKNOWN. ⛔ UNKNOWN IS NEVER THE BENIGN VALUE.
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
 * had no successful dispatch since, so this is never allowed to become a CLEAN.
 *
 * ⛔ TRA-3372 — this file used to add "and under `skip_missed` those fires are
 * gone for good". Do not put that back. `skip_missed` is the CRON catch-up
 * policy; it is not the only path to a fire. Measured 2026-08-13 on the three
 * TRA-3372 routines: each missed BOTH its 07-31 and 08-07 on-slot fire and BOTH
 * were replayed OFF-CRON by a restart backlog drain (2026-08-02T00:08Z and
 * 2026-08-11T13:30Z), one of which ran to completion. This check reads the TAIL,
 * not the schedule ledger, so it cannot tell a lost slot from a replayed one —
 * and telling a responder the work is gone is how they re-run work that ran.
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
 * ⛔ A per-finding OWNER_STATE_UNKNOWN does NOT promote the run to BLIND. BLIND
 * returns early and would suppress every other finding in the report, so an
 * unattributable row would silence the rows that ARE attributable. It stays a
 * finding at exit 1, is named in the report, and — because it is not in
 * FLEET_STATES — can never be counted as evidence for a dispatcher claim.
 *
 * This script performs GETs and read-only SELECTs, and NOTHING else.
 */

import { enumerateRoutines } from './lib/paperclip-enumeration.mjs';
import {
  OWNER_STATE,
  blindTape,
  emptyTape,
  readPauseTapeFromPostgres,
  resolveOwnerStateAt,
  DEFAULT_DB_URL,
} from './lib/paperclip-pause-tape.mjs';
import {
  CLOSE_ATTRIBUTION,
  attributeCloseFromTape,
  blindCloseTape,
  emptyCloseTape,
  readCloseTapeFromPostgres,
} from './lib/paperclip-close-tape.mjs';

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
        // ⛔ TRA-3372 — the status is taken from the DISPATCHER'S OWN sentence,
        // never from the issue's status now. The issue can have moved on since
        // (TRA-3196 was re-blocked and re-homed 33h after the close it is
        // graded on), and attributing the close to the newest write would name
        // the wrong actor entirely.
        closedStatus: downstream[1],
        linkedIssueId: lastRun.linkedIssueId || lastRun.linkedIssue?.id || null,
        linkedIssueIdentifier: lastRun.linkedIssue?.identifier || null,
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

/**
 * The owner-attributed splits of `LAST_DISPATCH_FAILED`. Findings, all three —
 * the slot produced no completed work either way — but NOT dispatcher claims.
 * (⛔ Not "the slot is gone": see the header, TRA-3372.)
 */
export const OWNER_ATTRIBUTED_STATES = new Set([
  'OWNER_PAUSED',
  'OWNER_TERMINATED',
  'OWNER_STATE_UNKNOWN',
]);

const FINDING_STATES = new Set([
  'LAST_DISPATCH_FAILED',
  'FIRE_WITHOUT_RUN',
  'DISPATCH_SKIPPED',
  'EXECUTION_ISSUE_ABANDONED',
  ...OWNER_ATTRIBUTED_STATES,
]);
/**
 * FLEET is a claim about the DISPATCHER, so a state may only appear here if the
 * dispatcher is the REMAINING subject once everything else has been ruled out.
 *
 * `EXECUTION_ISSUE_ABANDONED` is a claim about work someone closed, which is
 * owner-routable by construction and would otherwise manufacture a platform
 * verdict out of three cancelled tickets.
 *
 * ⛔ TRA-3487: the three OWNER_* states are held out for the same reason and it
 * is the whole point of that ticket — a burst of paused owners is ONE
 * condition whose subject is the OWNER, and letting it reach this set is how
 * the banner came to assert a dispatcher fault twice a day. OWNER_STATE_UNKNOWN
 * is held out too: an attribution we could not complete is not evidence FOR the
 * dispatcher.
 */
const FLEET_STATES = new Set(['LAST_DISPATCH_FAILED', 'FIRE_WITHOUT_RUN', 'DISPATCH_SKIPPED']);

/**
 * Re-attribute a `LAST_DISPATCH_FAILED` against the pause tape.
 *
 * ⛔ Resolved at the FAILURE INSTANT (`triggeredAt`), never at now — the owner
 * has almost always been resumed by the time anyone reads the report, and
 * `resume` erases `pausedAt`/`pauseReason` outright.
 */
export function attributeOwnerState(classified, { assigneeAgentId, tape }) {
  if (classified.state !== 'LAST_DISPATCH_FAILED') return classified;

  const atMs = Date.parse(classified.triggeredAt || '');
  const { state, why } = resolveOwnerStateAt(tape, assigneeAgentId, atMs);

  if (state === OWNER_STATE.PAUSED) {
    return {
      ...classified,
      state: 'OWNER_PAUSED',
      ownerState: state,
      ownerWhy: why,
      detail:
        `the OWNER WAS PAUSED when this dispatch died — ${why}. The dispatcher did what it was told; ` +
        'an agent in `paused` is not invokable, so this slot was destroyed at the gate. ' +
        `⛔ Route to the owner/board, NOT the platform. (dispatcher said: ${JSON.stringify(classified.failureReason)})`,
    };
  }
  if (state === OWNER_STATE.TERMINATED) {
    return {
      ...classified,
      state: 'OWNER_TERMINATED',
      ownerState: state,
      ownerWhy: why,
      detail:
        `the OWNER WAS TERMINATED when this dispatch died — ${why}. No agent can repair this routine: ` +
        'it needs a BOARD re-home to a live assignee. ' +
        `(dispatcher said: ${JSON.stringify(classified.failureReason)})`,
    };
  }
  if (state === OWNER_STATE.UNKNOWN) {
    return {
      ...classified,
      state: 'OWNER_STATE_UNKNOWN',
      ownerState: state,
      ownerWhy: why,
      detail:
        `⛔ THE OWNER'S STATE AT THE FAILURE INSTANT COULD NOT BE RESOLVED — ${why}. ` +
        'This is NOT "the owner was fine" and NOT a dispatcher fault: it is an unfinished attribution, ' +
        `and it is excluded from the FLEET test for that reason. (dispatcher said: ${JSON.stringify(classified.failureReason)})`,
    };
  }

  // INVOKABLE — the owner was up, so the dispatcher IS the remaining subject.
  return { ...classified, ownerState: state, ownerWhy: why };
}

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

  // ⛔ TRA-3487 — the owner-pause tape. A transport that cannot serve one
  // yields a BLIND tape, and every dispatch failure it should have explained
  // becomes OWNER_STATE_UNKNOWN. It must NOT fall through to the old behaviour,
  // because "attribution is broken" and "the owner was not paused" would then
  // render identically — the exact defect class this ticket is about.
  let tape;
  try {
    tape = transport.getPauseTape
      ? await transport.getPauseTape()
      : blindTape('this transport has no `getPauseTape` reader');
  } catch (err) {
    tape = blindTape(`the pause-tape reader threw — ${err?.message || err}`);
  }

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
    const c = attributeOwnerState(classifyDispatch(routine, triggers, { slackMs }), {
      assigneeAgentId: routine.assigneeAgentId || null,
      tape,
    });
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
      ownerState: c.ownerState ?? null,
      ownerWhy: c.ownerWhy ?? null,
      failureReason: c.failureReason ?? null,
      closedStatus: c.closedStatus ?? null,
      linkedIssueId: c.linkedIssueId ?? null,
      linkedIssueIdentifier: c.linkedIssueIdentifier ?? null,
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

  // ⛔ TRA-3372 — the CLOSE tape. `EXECUTION_ISSUE_ABANDONED` is routed to the
  // ROUTINE OWNER, and the sentence they read is "your spawned issue was closed
  // non-done". On the founding run two of the three closes were written by the
  // 08-12 mass-strand cleanup, on issues the platform's strand-recovery had
  // already re-homed AWAY from that owner — so the owner had to reconstruct the
  // actor and the ownership by hand from the activity log before they could
  // answer. Carry both. Bounded to the abandoned rows' linked issues only.
  const abandoned = findings.filter((f) => f.state === 'EXECUTION_ISSUE_ABANDONED');
  let closeTape = emptyCloseTape({ source: 'no abandoned findings to attribute' });
  if (abandoned.length > 0) {
    try {
      closeTape = transport.getCloseTape
        ? await transport.getCloseTape(abandoned.map((f) => f.linkedIssueId).filter(Boolean))
        : blindCloseTape('this transport has no `getCloseTape` reader');
    } catch (err) {
      closeTape = blindCloseTape(`the close-tape reader threw — ${err?.message || err}`);
    }
    for (const f of abandoned) {
      const a = attributeCloseFromTape(closeTape, f.linkedIssueId, f.closedStatus);
      f.closeAttribution = a.attribution;
      f.closedAt = a.closedAt;
      f.closedByActorType = a.closedByActorType;
      f.closedByActorId = a.closedByActorId;
      f.assigneeAtCloseAgentId = a.assigneeAtCloseAgentId;
      f.closeWhy = a.why;
      // ⛔ The whole point. `true` means the row is being routed to somebody who
      // did not own the issue when it died, so "was this intentional?" is a
      // question they CANNOT answer from their own record. `null` (not `false`)
      // whenever the attribution did not resolve — an unfinished read must not
      // render as "yes, it was yours".
      f.ownerHeldIssueAtClose =
        a.attribution === CLOSE_ATTRIBUTION.RESOLVED
          ? (a.assigneeAtCloseAgentId || null) === (f.assigneeAgentId || null)
          : null;
    }
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

  // ⛔ TRA-3487 — the OWNER-side aggregate, computed on exactly the same axes as
  // the dispatcher one so "roster-wide" means the same thing for both subjects.
  // Without this a pause burst simply vanishes from the report: it is excluded
  // from FLEET, and nothing else would have said the roster went down at once.
  const pausedFindings = recentFindings.filter((f) => f.state === 'OWNER_PAUSED');
  const pausedAssignees = new Set(pausedFindings.map((f) => f.assigneeAgentId || 'UNASSIGNED'));
  const pausedShare = pausedFindings.length / population.length;
  const ownerPauseBurst =
    pausedFindings.length > 0 &&
    (pausedAssignees.size >= FLEET_MIN_ASSIGNEES || pausedShare >= FLEET_MIN_SHARE);

  return {
    verdict: findings.length === 0 ? 'CLEAN' : fleet ? 'FLEET' : 'FINDINGS',
    blind: null,
    findings,
    tape: { ok: tape?.ok === true, reason: tape?.ok === true ? null : tape?.reason || null, source: tape?.source || null },
    ownerPausedCount: findings.filter((f) => f.state === 'OWNER_PAUSED').length,
    ownerTerminatedCount: findings.filter((f) => f.state === 'OWNER_TERMINATED').length,
    ownerUnknownCount: findings.filter((f) => f.state === 'OWNER_STATE_UNKNOWN').length,
    ownerPauseBurst,
    ownerPauseBurstAssignees: pausedAssignees.size,
    ownerPauseBurstShare: pausedShare,
    graded: population.length,
    routineCount: routines.length,
    tally,
    distinctAssignees: assignees.size,
    share,
    recentCount: recentFindings.length,
    fleetCandidateCount: fleetCandidates.length,
    abandonedCount: abandoned.length,
    closeTape: {
      ok: closeTape?.ok === true,
      reason: closeTape?.ok === true ? null : closeTape?.reason || null,
      source: closeTape?.source || null,
    },
    // Rows routed to an owner who did not hold the issue when it was closed.
    misroutedCloseCount: abandoned.filter((f) => f.ownerHeldIssueAtClose === false).length,
    unattributedCloseCount: abandoned.filter((f) => f.ownerHeldIssueAtClose === null).length,
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
    // ⛔ TRA-3372 — WHO closed it and WHO owned it then. Printed on every
    // abandoned row, including the ones we could not attribute: an owner who
    // sees nothing here cannot tell "it was you" from "we did not look".
    if (f.state === 'EXECUTION_ISSUE_ABANDONED') {
      const issue = f.linkedIssueIdentifier || (f.linkedIssueId ? String(f.linkedIssueId).slice(0, 8) : 'unknown issue');
      if (f.closeAttribution === 'RESOLVED') {
        const actor =
          f.closedByActorType === 'agent'
            ? nm(f.closedByActorId)
            : `${f.closedByActorType || 'unknown'}:${f.closedByActorId || '?'}`;
        out.push(
          `              close: ${issue} -> \`${f.closedStatus}\` at ${f.closedAt} ` +
            `by ${actor} · assignee at close: ${nm(f.assigneeAtCloseAgentId)}`,
        );
        if (f.ownerHeldIssueAtClose === false) {
          out.push(
            `              ⛔ THIS ROW IS ROUTED TO ${nm(f.assigneeAgentId)} AS THE ROUTINE OWNER, BUT THE ISSUE ` +
              `WAS ${nm(f.assigneeAtCloseAgentId)}'S WHEN IT CLOSED — they cannot answer ` +
              '"was this intentional?" from their own record. Ask the closer, not the routine owner.',
          );
        }
      } else {
        out.push(
          `              close: ${issue} -> \`${f.closedStatus}\` — ⛔ ACTOR/OWNERSHIP UNATTRIBUTED: ${f.closeWhy || 'no reason recorded'}. ` +
            'This is NOT "the routine owner closed it".',
        );
      }
    }
  }

  if (r.verdict === 'FLEET') {
    out.push('');
    // ⛔ TRA-3487 — NAME THE SUBJECT. This banner used to assert "ONE platform
    // condition" unconditionally, which is a claim about the DISPATCHER that
    // the check had no means to test. It may only be made about failures whose
    // owner was proven INVOKABLE at the failure instant.
    out.push(
      `  FLEET — ${r.fleetCandidateCount} RECENT dispatch failures span ${r.distinctAssignees} distinct ` +
        `assignees (${(r.share * 100).toFixed(0)}% of the armed population). This is ONE condition, ` +
        `not ${r.fleetCandidateCount} routines to repair. ⛔ Do not file a ticket per routine.`,
    );
    out.push(
      '  SUBJECT: THE DISPATCHER — and that is asserted, not assumed: every failure counted above was ' +
        'resolved against the durable pause tape (`activity_log` agent.paused/agent.resumed/agent.terminated) ' +
        'AT ITS FAILURE INSTANT, and its owner was invokable. Owner-paused, owner-terminated and ' +
        'unattributable failures are excluded from this count.',
    );
    if (r.ownerUnknownCount > 0) {
      out.push(
        `  ⚠️ ${r.ownerUnknownCount} further failure(s) could NOT be attributed (OWNER_STATE_UNKNOWN). They ` +
          'are not evidence for the dispatcher and are not counted above — but they mean this subject ' +
          'attribution is INCOMPLETE. Read those rows before acting on this banner.',
      );
    }
  }

  // ⛔ TRA-3487 — the owner-side counterpart. A roster-wide pause is ALSO one
  // condition; it is just not the dispatcher's. Per TRA-2871 it is in fact the
  // MOST COMMON cause of a roster-wide burst, so it gets equal billing.
  if (r.ownerPauseBurst) {
    out.push('');
    out.push(
      `  OWNER PAUSE BURST — ${r.ownerPausedCount} of the findings are OWNER_PAUSED, spanning ` +
        `${r.ownerPauseBurstAssignees} distinct assignees (${(r.ownerPauseBurstShare * 100).toFixed(0)}% of ` +
        'the armed population). This is ONE condition and ⛔ ITS SUBJECT IS THE OWNER, NOT THE DISPATCHER: ' +
        'those agents were `paused` at the instant their dispatches died, and a paused agent is not ' +
        'invokable by construction.',
    );
    out.push(
      '  ⛔ Do NOT file this against the platform, and do not file one ticket per routine. Route it to the ' +
        'owner/board. ⚠️ Do NOT assert the slots are gone: `skip_missed` is the cron policy, but an ' +
        'off-cron restart backlog drain replays missed fires anyway (measured, TRA-3372) and this check ' +
        'cannot see which happened.',
    );
  } else if (r.ownerPausedCount > 0) {
    out.push('');
    out.push(
      `  ${r.ownerPausedCount} of the findings are OWNER_PAUSED — the assignee was paused when the dispatch ` +
        'died. ⛔ NOT dispatcher faults, and excluded from the FLEET test: route them to the owner/board.',
    );
  }

  if (r.ownerTerminatedCount > 0) {
    out.push('');
    out.push(
      `  ${r.ownerTerminatedCount} of the findings are OWNER_TERMINATED — the assignee no longer exists as a ` +
        'live agent. ⛔ NO agent can repair these: the routine needs a BOARD re-home to a live assignee. ' +
        'Excluded from the FLEET test.',
    );
  }

  if (r.ownerUnknownCount > 0) {
    out.push('');
    out.push(
      `  ⛔ ${r.ownerUnknownCount} of the findings are OWNER_STATE_UNKNOWN — this check could NOT establish ` +
        'whether the owner was paused when the dispatch died. ' +
        (r.tape && r.tape.ok === false ? `The pause tape itself is unreadable: ${r.tape.reason}. ` : '') +
        'UNKNOWN IS NOT "the owner was fine" and is NOT a dispatcher fault. It is an unfinished attribution, ' +
        'it is excluded from the FLEET test, and it is not CLEAN.',
    );
  }

  if (r.abandonedCount > 0) {
    out.push('');
    out.push(
      `  ${r.abandonedCount} of the findings are EXECUTION_ISSUE_ABANDONED — the dispatch SUCCEEDED and the ` +
        'issue it spawned was later moved to blocked/cancelled. ⛔ These are NOT dispatcher faults and are ' +
        'excluded from the FLEET test: route them to the routine owner, not to the platform.',
    );
    // ⛔ TRA-3372 — "route to the routine owner" is the DEFAULT, not a finding
    // about who acted. Say so out loud whenever the tape disagrees with it.
    if (r.misroutedCloseCount > 0) {
      out.push(
        `  ⛔ ${r.misroutedCloseCount} of them were closed while the issue belonged to SOMEBODY ELSE. ` +
          'The routine owner is the right place to ask "do you still want this slot", but they are the ' +
          'WRONG place to ask "why did you close it" — the per-row `close:` line names the actual actor.',
      );
    }
    if (r.unattributedCloseCount > 0) {
      out.push(
        `  ⛔ ${r.unattributedCloseCount} of them could not be attributed at all` +
          (r.closeTape?.ok === false ? ` — the close tape is unreadable: ${r.closeTape.reason}` : '') +
          '. An unattributed close is NOT an owner-written close.',
      );
    }
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
      '  ⛔ It is still not CLEAN. Those routines have had no successful dispatch since. ' +
        '⚠️ This check CANNOT tell you whether the lost slot was replayed: ' +
        '"`skip_missed` means the slot is gone" is the CRON policy, and it is not the only path to a fire — ' +
        'measured on 2026-08-13 (TRA-3372), routines 81928e50/a986323e/f28ea628 each missed BOTH the 07-31 ' +
        'and 08-07 on-slot fires and BOTH were replayed off-cron by a restart backlog drain, one of which ' +
        'completed. Read the run history before re-running anything by hand.',
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

/**
 * @param {object[]} rows
 * @param {object} [tape] the pause tape. Defaults to a READABLE, EMPTY tape —
 *   "the tape works and nobody was ever paused" — so the pre-TRA-3487 controls
 *   keep asserting exactly what they asserted before. ⛔ It is deliberately not
 *   `blindTape()`: a default of "unreadable" would flip every existing
 *   LAST_DISPATCH_FAILED control to UNKNOWN and hide a real regression behind
 *   a fixture choice.
 */
function transportOf(rows, tape, closeTape) {
  const t = { getRoutines: async () => rows, getPauseTape: async () => tape ?? emptyTape() };
  // ⛔ Deliberately absent unless a case supplies one, so the DEFAULT for every
  // pre-TRA-3372 control is "no close reader" — which must render as
  // UNATTRIBUTED, never as an owner-written close.
  if (closeTape) t.getCloseTape = async () => closeTape;
  return t;
}

/**
 * A close tape for one issue. `rows` are `issue.updated` details in ascending
 * order, given as `[isoTime, actorType, actorId, details]`.
 */
function closeTapeOf(issueId, { currentAssigneeAgentId, rows }) {
  return {
    ok: true,
    source: 'synthetic',
    issues: new Map([
      [
        issueId,
        {
          currentAssigneeAgentId,
          rows: rows.map(([iso, actorType, actorId, details]) => ({
            atMs: at(iso),
            actorType,
            actorId,
            agentId: actorType === 'agent' ? actorId : null,
            details,
          })),
        },
      ],
    ]),
  };
}

/** A tape carrying `events`, covering everything since the epoch. */
function tapeOf(events, over = {}) {
  return emptyTape({ events, ...over });
}

const at = (s) => Date.parse(s);

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
      // ⛔ TRA-3372 — no close reader on this (pre-existing) transport, so the
      // attribution must come back UNATTRIBUTED and SAY so. The failure mode
      // being fenced is a silent omission reading as "the owner closed it".
      assert(r.findings[0].ownerHeldIssueAtClose === null, String(r.findings[0].ownerHeldIssueAtClose));
      assert(r.unattributedCloseCount === 1, String(r.unattributedCloseCount));
      const text = renderReport(r).join('\n');
      assert(/ACTOR\/OWNERSHIP UNATTRIBUTED/.test(text), 'an unattributed close must be printed as such');
      assert(/NOT "the routine owner closed it"/.test(text), text.slice(0, 600));
    },
  },
  {
    /**
     * The founding case, TRA-3372: TRA-3195 was cancelled by CFO during the
     * 08-12 mass-strand cleanup, on an issue the platform's strand recovery had
     * already re-homed off QuantTrader. The check routes to the routine owner
     * (QT) and the sentence it prints is "your spawned issue was closed" — so
     * QT had to reconstruct the actor by hand before they could answer.
     */
    name: '⛔ TRA-3372 — a close written by a THIRD PARTY is NAMED, and the mis-routing is called out',
    rows: boardOf([
      routineRow('r-3372', {
        assigneeAgentId: 'agent-qt',
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          failureReason: 'Execution issue moved to cancelled',
          linkedIssueId: 'issue-3195',
          linkedIssue: { id: 'issue-3195', identifier: 'TRA-3195', status: 'cancelled' },
        },
      }),
    ]),
    closeTape: closeTapeOf('issue-3195', {
      currentAssigneeAgentId: 'agent-cfo',
      rows: [
        // The strand recovery re-homes WITHOUT logging `assigneeAgentId`.
        [
          '2026-08-04T20:50:00.000Z',
          'system',
          'system',
          {
            source: 'recovery.reconcile_stranded_assigned_issue',
            status: 'blocked',
            previousStatus: 'in_progress',
            previousOwnerAgentId: 'agent-qt',
            recoveryOwnerAgentId: 'agent-cfo',
          },
        ],
        // ...and the cleanup cancels it an hour later.
        [
          '2026-08-04T20:55:00.000Z',
          'agent',
          'agent-cfo',
          { status: 'cancelled', _previous: { status: 'blocked' } },
        ],
      ],
    }),
    expect: (r) => {
      const f = r.findings.find((x) => x.short === 'r-3372');
      assert(f.closeAttribution === 'RESOLVED', `${f.closeAttribution} — ${f.closeWhy}`);
      assert(f.closedByActorId === 'agent-cfo', String(f.closedByActorId));
      assert(f.closedAt === '2026-08-04T20:55:00.000Z', String(f.closedAt));
      // ⛔ THE HOLE: the re-home logged no `assigneeAgentId`, so a forward
      // replay would still say `agent-qt` here. It must say `agent-cfo`.
      assert(f.assigneeAtCloseAgentId === 'agent-cfo', String(f.assigneeAtCloseAgentId));
      assert(f.ownerHeldIssueAtClose === false, String(f.ownerHeldIssueAtClose));
      assert(r.misroutedCloseCount === 1, String(r.misroutedCloseCount));
      const text = renderReport(r).join('\n');
      assert(/assignee at close: agent-cf/.test(text), text.slice(0, 800));
      assert(/WRONG place to ask "why did you close it"/.test(text), text.slice(0, 900));
    },
  },
  {
    name: '⛔ TRA-3372 — a close the ROUTINE OWNER did write must NOT be flagged as mis-routed',
    rows: boardOf([
      routineRow('r-own', {
        assigneeAgentId: 'agent-qt',
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          failureReason: 'Execution issue moved to cancelled',
          linkedIssueId: 'issue-own',
          linkedIssue: { id: 'issue-own', identifier: 'TRA-9001', status: 'cancelled' },
        },
      }),
    ]),
    closeTape: closeTapeOf('issue-own', {
      currentAssigneeAgentId: 'agent-qt',
      rows: [
        ['2026-08-04T20:55:00.000Z', 'agent', 'agent-qt', { status: 'cancelled', _previous: { status: 'todo' } }],
      ],
    }),
    expect: (r) => {
      const f = r.findings.find((x) => x.short === 'r-own');
      assert(f.ownerHeldIssueAtClose === true, String(f.ownerHeldIssueAtClose));
      assert(r.misroutedCloseCount === 0, String(r.misroutedCloseCount));
      assert(r.unattributedCloseCount === 0, String(r.unattributedCloseCount));
      const text = renderReport(r).join('\n');
      assert(!/WRONG place to ask/.test(text), 'an owner-written close must not be flagged as mis-routed');
    },
  },
  {
    /**
     * ⛔ The close is the transition INTO the status the DISPATCHER named, not
     * the newest write. TRA-3196 was re-blocked and re-homed 33h after the
     * close its run was graded on; taking the last row would name the wrong
     * actor and the wrong owner, with nothing in the output to reveal it.
     */
    name: '⛔ TRA-3372 — a later write RESTATING the same status must not steal the attribution',
    rows: boardOf([
      routineRow('r-restate', {
        assigneeAgentId: 'agent-qt',
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          failureReason: 'Execution issue moved to blocked',
          linkedIssueId: 'issue-3196',
          linkedIssue: { id: 'issue-3196', identifier: 'TRA-3196', status: 'blocked' },
        },
      }),
    ]),
    closeTape: closeTapeOf('issue-3196', {
      currentAssigneeAgentId: 'agent-qt',
      rows: [
        [
          '2026-08-04T20:50:00.000Z',
          'system',
          'system',
          {
            source: 'recovery.reconcile_stranded_assigned_issue',
            status: 'blocked',
            previousStatus: 'in_progress',
            previousOwnerAgentId: 'agent-qt',
            recoveryOwnerAgentId: 'agent-ceo',
          },
        ],
        // Restates `blocked` — `_previous` carries NO status, so nothing moved.
        [
          '2026-08-04T20:56:00.000Z',
          'agent',
          'agent-ceo',
          { status: 'blocked', _previous: { blockedByIssueIds: [] }, blockedByIssueIds: ['x'] },
        ],
        // The re-home back to QT, long after.
        [
          '2026-08-04T20:58:00.000Z',
          'agent',
          'agent-ceo',
          { status: 'blocked', assigneeAgentId: 'agent-qt', _previous: { assigneeAgentId: 'agent-ceo' } },
        ],
      ],
    }),
    expect: (r) => {
      const f = r.findings.find((x) => x.id === 'r-restate');
      assert(f.closedAt === '2026-08-04T20:50:00.000Z', `took the wrong row: ${f.closedAt}`);
      assert(f.closedByActorType === 'system', String(f.closedByActorType));
      assert(f.assigneeAtCloseAgentId === 'agent-ceo', String(f.assigneeAtCloseAgentId));
      assert(f.ownerHeldIssueAtClose === false, String(f.ownerHeldIssueAtClose));
    },
  },
  {
    /**
     * ⛔ THE MUTATION THAT SURVIVED. The two controls above both happen to have
     * the recovery row BEFORE the close, so the backward replay never has to
     * undo one — disabling the recovery branch entirely left them both green.
     * This is the case that reaches it: a recovery re-home AFTER the close,
     * which logs no `assigneeAgentId` and would otherwise be replayed as a
     * no-op, reporting the CURRENT owner as the owner at close.
     */
    name: '⛔ TRA-3372 — a recovery re-home AFTER the close must be REWOUND (it logs no assigneeAgentId)',
    rows: boardOf([
      routineRow('r-rewind', {
        assigneeAgentId: 'agent-qt',
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          failureReason: 'Execution issue moved to cancelled',
          linkedIssueId: 'issue-rw',
          linkedIssue: { id: 'issue-rw', identifier: 'TRA-9004', status: 'cancelled' },
        },
      }),
    ]),
    closeTape: closeTapeOf('issue-rw', {
      // Where it sits NOW — the recovery below put it here.
      currentAssigneeAgentId: 'agent-cfo',
      rows: [
        ['2026-08-04T20:50:00.000Z', 'agent', 'agent-qt', { status: 'cancelled', _previous: { status: 'todo' } }],
        [
          '2026-08-04T20:55:00.000Z',
          'system',
          'system',
          {
            source: 'recovery.reconcile_stranded_assigned_issue',
            previousOwnerAgentId: 'agent-qt',
            recoveryOwnerAgentId: 'agent-cfo',
          },
        ],
      ],
    }),
    expect: (r) => {
      const f = r.findings.find((x) => x.id === 'r-rewind');
      assert(f.closeAttribution === 'RESOLVED', `${f.closeAttribution} — ${f.closeWhy}`);
      // ⛔ Not `agent-cfo`. The owner DID hold it at the close; the recovery
      // moved it afterwards. Flagging this as mis-routed would be a false
      // accusation in the opposite direction.
      assert(f.assigneeAtCloseAgentId === 'agent-qt', String(f.assigneeAtCloseAgentId));
      assert(f.ownerHeldIssueAtClose === true, String(f.ownerHeldIssueAtClose));
      assert(r.misroutedCloseCount === 0, String(r.misroutedCloseCount));
    },
  },
  {
    name: '⛔ TRA-3372 — a later assignee move with NO recorded "before" => UNKNOWN owner, actor still named',
    rows: boardOf([
      routineRow('r-ambig', {
        assigneeAgentId: 'agent-qt',
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          failureReason: 'Execution issue moved to cancelled',
          linkedIssueId: 'issue-am',
          linkedIssue: { id: 'issue-am', identifier: 'TRA-9005', status: 'cancelled' },
        },
      }),
    ]),
    closeTape: closeTapeOf('issue-am', {
      currentAssigneeAgentId: 'agent-cfo',
      rows: [
        ['2026-08-04T20:50:00.000Z', 'agent', 'agent-cfo', { status: 'cancelled', _previous: { status: 'todo' } }],
        // Moved the assignee and recorded no previous value.
        ['2026-08-04T20:55:00.000Z', 'agent', 'agent-ceo', { assigneeAgentId: 'agent-cfo', _previous: {} }],
      ],
    }),
    expect: (r) => {
      const f = r.findings.find((x) => x.id === 'r-ambig');
      assert(f.closeAttribution === 'UNKNOWN', String(f.closeAttribution));
      // The actor survives — it is the assignee replay that failed, not the close.
      assert(f.closedByActorId === 'agent-cfo', String(f.closedByActorId));
      assert(f.assigneeAtCloseAgentId === null, String(f.assigneeAtCloseAgentId));
      assert(f.ownerHeldIssueAtClose === null, String(f.ownerHeldIssueAtClose));
      assert(r.unattributedCloseCount === 1, String(r.unattributedCloseCount));
    },
  },
  {
    name: '⛔ TRA-3372 — an UNREADABLE close tape must yield UNATTRIBUTED, never "the owner closed it"',
    rows: boardOf([
      routineRow('r-blindclose', {
        assigneeAgentId: 'agent-qt',
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          failureReason: 'Execution issue moved to cancelled',
          linkedIssueId: 'issue-x',
          linkedIssue: { id: 'issue-x', identifier: 'TRA-9002', status: 'cancelled' },
        },
      }),
    ]),
    closeTape: blindCloseTape('the pg driver could not be resolved'),
    expect: (r) => {
      const f = r.findings.find((x) => x.id === 'r-blindclose');
      assert(f.closeAttribution === 'UNKNOWN', String(f.closeAttribution));
      assert(f.ownerHeldIssueAtClose === null, String(f.ownerHeldIssueAtClose));
      assert(r.misroutedCloseCount === 0, String(r.misroutedCloseCount));
      assert(r.unattributedCloseCount === 1, String(r.unattributedCloseCount));
      const text = renderReport(r).join('\n');
      assert(/close tape is unreadable/.test(text), 'the report must NAME why the attribution failed');
      assert(/pg driver could not be resolved/.test(text), text.slice(0, 900));
    },
  },
  {
    name: '⛔ TRA-3372 — a close OLDER than the tape must be UNKNOWN, not attributed to the nearest row',
    rows: boardOf([
      routineRow('r-floor', {
        assigneeAgentId: 'agent-qt',
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:45:25.000Z',
          failureReason: 'Execution issue moved to cancelled',
          linkedIssueId: 'issue-f',
          linkedIssue: { id: 'issue-f', identifier: 'TRA-9003', status: 'cancelled' },
        },
      }),
    ]),
    // The tape has rows, but none transitions INTO `cancelled`.
    closeTape: closeTapeOf('issue-f', {
      currentAssigneeAgentId: 'agent-cfo',
      rows: [
        ['2026-08-04T20:56:00.000Z', 'agent', 'agent-cfo', { status: 'cancelled', _previous: { priority: 'low' } }],
      ],
    }),
    expect: (r) => {
      const f = r.findings.find((x) => x.short === 'r-floor');
      assert(f.closeAttribution === 'UNKNOWN', String(f.closeAttribution));
      assert(f.assigneeAtCloseAgentId === null, String(f.assigneeAtCloseAgentId));
      assert(/transition INTO/.test(f.closeWhy || ''), String(f.closeWhy));
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

  /* ---------------- TRA-3487 — owner attribution ---------------- */

  {
    name: '⛔ TRA-3487 #1 — owner PAUSED at the failure instant => OWNER_PAUSED, held OUT of the FLEET test',
    rows: boardOf([
      routineRow('r-paused', {
        assigneeAgentId: 'agent-p',
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T13:12:30.000Z',
          failureReason: 'Agent is not invokable in its current state',
        },
      }),
    ]),
    tape: tapeOf([{ agentId: 'agent-p', kind: 'paused', atMs: at('2026-08-04T13:11:00.000Z') }]),
    expect: (r) => {
      assert(r.findings.length === 1, `expected 1 finding, got ${r.findings.length}`);
      assert(r.findings[0].state === 'OWNER_PAUSED', r.findings[0].state);
      assert(r.ownerPausedCount === 1, `ownerPausedCount=${r.ownerPausedCount}`);
      assert(r.fleetCandidateCount === 0, `a paused owner must not be a FLEET candidate (got ${r.fleetCandidateCount})`);
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(/OWNER WAS PAUSED/.test(r.findings[0].detail), r.findings[0].detail);
    },
  },
  {
    name: '⛔ TRA-3487 — DISCRIMINATOR: owner paused but RESUMED before the failure => stays LAST_DISPATCH_FAILED',
    rows: boardOf([
      routineRow('r-resumed', {
        assigneeAgentId: 'agent-p',
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T20:50:00.000Z',
          failureReason: 'Agent is not invokable in its current state',
        },
      }),
    ]),
    tape: tapeOf([
      { agentId: 'agent-p', kind: 'paused', atMs: at('2026-08-04T13:11:00.000Z') },
      { agentId: 'agent-p', kind: 'resumed', atMs: at('2026-08-04T20:32:00.000Z') },
    ]),
    expect: (r) => {
      // Without this the resolver could be hard-wired to PAUSED and #1 would
      // still pass. The pause is REAL and on the tape — it just ended first.
      assert(r.findings[0].state === 'LAST_DISPATCH_FAILED', r.findings[0].state);
      assert(r.findings[0].ownerState === 'INVOKABLE', String(r.findings[0].ownerState));
    },
  },
  {
    name: '⛔ TRA-3487 — a pause AFTER the failure instant must not be back-dated onto it',
    rows: boardOf([
      routineRow('r-later', {
        assigneeAgentId: 'agent-p',
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T13:00:00.000Z', failureReason: 'boom' },
      }),
    ]),
    tape: tapeOf([{ agentId: 'agent-p', kind: 'paused', atMs: at('2026-08-04T18:00:00.000Z') }]),
    expect: (r) => assert(r.findings[0].state === 'LAST_DISPATCH_FAILED', r.findings[0].state),
  },
  {
    name: '⛔ TRA-3487 #2 — pause tape UNREADABLE => OWNER_STATE_UNKNOWN, never HEALTHY and never a dispatcher fault',
    rows: boardOf([
      routineRow('r-blindtape', {
        assigneeAgentId: 'agent-p',
        lastRun: {
          status: 'failed',
          triggeredAt: '2026-08-04T13:12:30.000Z',
          failureReason: 'Agent is not invokable in its current state',
        },
      }),
    ]),
    tape: blindTape('the `pg` driver could not be resolved'),
    expect: (r) => {
      assert(r.findings.length === 1, `an unattributable failure is still a FINDING (got ${r.findings.length})`);
      assert(r.findings[0].state === 'OWNER_STATE_UNKNOWN', r.findings[0].state);
      assert(r.verdict !== 'CLEAN', 'UNKNOWN is never CLEAN');
      assert(r.fleetCandidateCount === 0, 'an unattributed failure is not evidence for the dispatcher');
      assert(r.tape.ok === false, 'the report must carry the tape failure');
      assert(/pg. driver/.test(renderReport(r).join('\n')), 'the report must NAME why attribution failed');
    },
  },
  {
    name: '⛔ TRA-3487 — transport with NO pause-tape reader at all => UNKNOWN, not the old behaviour',
    rows: boardOf([
      routineRow('r-notape', {
        assigneeAgentId: 'agent-p',
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T13:12:30.000Z', failureReason: 'boom' },
      }),
    ]),
    // Bypasses transportOf's healthy default entirely — this is the shape a
    // caller wired before TRA-3487 would present.
    transport: (rows) => ({ getRoutines: async () => rows }),
    expect: (r) => assert(r.findings[0].state === 'OWNER_STATE_UNKNOWN', r.findings[0].state),
  },
  {
    name: '⛔⛔ TRA-3487 — an `agent.updated` PATCH touching `status` => UNKNOWN (the platform logs the KEY, not the VALUE)',
    rows: boardOf([
      routineRow('r-patched', {
        assigneeAgentId: 'agent-p',
        lastRun: { status: 'failed', triggeredAt: '2026-08-12T06:00:00.000Z', failureReason: 'boom' },
        triggers: [
          { kind: 'schedule', enabled: true, cronExpression: '0 6 * * *', timezone: 'UTC', nextRunAt: FUTURE, lastFiredAt: '2026-08-12T06:00:00.000Z' },
        ],
      }),
    ]),
    now: '2026-08-12T12:00:00.000Z',
    tape: tapeOf([
      // The owner was resumed long ago — so WITHOUT the patch this is INVOKABLE.
      { agentId: 'agent-p', kind: 'resumed', atMs: at('2026-08-04T20:32:00.000Z') },
      // `PATCH /agents/:id` accepts `status:'paused'` and logs only
      // `{changedTopLevelKeys:['status']}`. This is a REAL row on this company
      // (2026-08-12T04:47:17.629Z, agent 671785a4).
      { agentId: 'agent-p', kind: 'status_patch', atMs: at('2026-08-12T04:47:17.629Z') },
    ]),
    expect: (r) => {
      assert(r.findings[0].state === 'OWNER_STATE_UNKNOWN', r.findings[0].state);
      assert(/never the value/i.test(r.findings[0].detail), r.findings[0].detail);
    },
  },
  {
    name: '⛔ TRA-3487 #2b — tape coverage floor is AFTER the failure => UNKNOWN, not "no pause found"',
    rows: boardOf([
      routineRow('r-short', {
        assigneeAgentId: 'agent-p',
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T13:12:30.000Z', failureReason: 'boom' },
      }),
    ]),
    // The exact shape the API-only read would have produced: a 3.4h window that
    // does not reach the failure. Zero events found — which must NOT read as
    // "the owner was never paused".
    tape: tapeOf([], { floorMs: at('2026-08-04T18:00:00.000Z') }),
    expect: (r) => {
      assert(r.findings[0].state === 'OWNER_STATE_UNKNOWN', r.findings[0].state);
      assert(/PREDATES/.test(r.findings[0].detail), r.findings[0].detail);
    },
  },
  {
    name: '⛔ TRA-3487 — owner TERMINATED => OWNER_TERMINATED, held out of FLEET (needs a BOARD re-home)',
    rows: boardOf([
      routineRow('r-dead-owner', {
        assigneeAgentId: 'agent-gone',
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T13:12:30.000Z', failureReason: 'boom' },
      }),
    ]),
    tape: tapeOf([{ agentId: 'agent-gone', kind: 'terminated', atMs: at('2026-06-07T01:43:16.957Z') }]),
    expect: (r) => {
      assert(r.findings[0].state === 'OWNER_TERMINATED', r.findings[0].state);
      assert(r.ownerTerminatedCount === 1, String(r.ownerTerminatedCount));
      assert(r.fleetCandidateCount === 0, 'a terminated owner is not a dispatcher fault');
      assert(/BOARD re-home/.test(renderReport(r).join('\n')), 'the report must name the remedy');
    },
  },
  {
    name: '⛔ TRA-3487 — an UNASSIGNED routine cannot be attributed => UNKNOWN, not INVOKABLE',
    rows: boardOf([
      routineRow('r-noowner', {
        assigneeAgentId: null,
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T13:12:30.000Z', failureReason: 'boom' },
      }),
    ]),
    expect: (r) => assert(r.findings[0].state === 'OWNER_STATE_UNKNOWN', r.findings[0].state),
  },
  {
    name: '⛔⛔ TRA-3487 #3 — ROSTER-WIDE PAUSE BURST => the "ONE platform condition" dispatcher banner must NOT print',
    rows: boardOf(
      ['a', 'b', 'c', 'd'].map((k) =>
        routineRow(`r-burst-${k}`, {
          assigneeAgentId: `agent-${k}`,
          lastRun: {
            status: 'failed',
            triggeredAt: '2026-08-04T13:12:30.000Z',
            failureReason: 'Agent is not invokable in its current state',
          },
        }),
      ),
    ),
    // The 2026-08-04T13:12Z burst, in miniature: 100% roster coverage of paused
    // agents. 4 findings over 12 armed = 33% and 4 distinct assignees, so this
    // WOULD trip both FLEET thresholds if the owner state were ignored.
    tape: tapeOf(
      ['a', 'b', 'c', 'd'].map((k) => ({
        agentId: `agent-${k}`,
        kind: 'paused',
        atMs: at('2026-08-04T13:11:00.000Z'),
      })),
    ),
    expect: (r) => {
      const text = renderReport(r).join('\n');
      assert(r.verdict === 'FINDINGS', `expected FINDINGS (owner-routable), got ${r.verdict}`);
      assert(r.ownerPausedCount === 4, String(r.ownerPausedCount));
      assert(r.ownerPauseBurst === true, 'the burst must be recognised as ONE owner-side condition');
      assert(!/ONE platform condition/.test(text), 'the dispatcher banner must not print for a pause burst');
      assert(!/SUBJECT: THE DISPATCHER/.test(text), 'the dispatcher must not be named as the subject');
      assert(/OWNER PAUSE BURST/.test(text), 'the owner-side banner must print instead');
      assert(/ITS SUBJECT IS THE OWNER/.test(text), text.slice(0, 400));
    },
  },
  {
    name: '⛔ TRA-3487 — REGRESSION: a real dispatcher burst with provably invokable owners STILL reaches FLEET',
    rows: boardOf(
      ['a', 'b', 'c', 'd'].map((k) =>
        routineRow(`r-real-${k}`, {
          assigneeAgentId: `agent-${k}`,
          lastRun: { status: 'failed', triggeredAt: '2026-08-04T20:50:00.000Z', failureReason: 'ECONNREFUSED' },
        }),
      ),
    ),
    tape: tapeOf(
      ['a', 'b', 'c', 'd'].map((k) => ({
        agentId: `agent-${k}`,
        kind: 'resumed',
        atMs: at('2026-08-04T20:32:00.000Z'),
      })),
    ),
    expect: (r) => {
      const text = renderReport(r).join('\n');
      assert(r.verdict === 'FLEET', `expected FLEET, got ${r.verdict}`);
      assert(r.fleetCandidateCount === 4, String(r.fleetCandidateCount));
      assert(/SUBJECT: THE DISPATCHER/.test(text), 'FLEET must NAME the subject it asserts');
    },
  },
  {
    name: '⛔ TRA-3487 — a FLEET burst alongside unattributable rows must DISCLOSE the incomplete attribution',
    rows: boardOf([
      ...['a', 'b', 'c'].map((k) =>
        routineRow(`r-mix-${k}`, {
          assigneeAgentId: `agent-${k}`,
          lastRun: { status: 'failed', triggeredAt: '2026-08-04T20:50:00.000Z', failureReason: 'ECONNREFUSED' },
        }),
      ),
      routineRow('r-mix-unknown', {
        assigneeAgentId: 'agent-z',
        lastRun: { status: 'failed', triggeredAt: '2026-08-04T20:50:00.000Z', failureReason: 'ECONNREFUSED' },
      }),
    ]),
    tape: tapeOf([
      ...['a', 'b', 'c'].map((k) => ({ agentId: `agent-${k}`, kind: 'resumed', atMs: at('2026-08-04T20:32:00.000Z') })),
      { agentId: 'agent-z', kind: 'status_patch', atMs: at('2026-08-04T20:40:00.000Z') },
    ]),
    expect: (r) => {
      const text = renderReport(r).join('\n');
      assert(r.verdict === 'FLEET', `expected FLEET, got ${r.verdict}`);
      assert(r.ownerUnknownCount === 1, String(r.ownerUnknownCount));
      assert(/attribution is INCOMPLETE/.test(text), 'the banner must disclose the unattributed rows');
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
      const r = await sweep(c.transport ? c.transport(c.rows) : transportOf(c.rows, c.tape, c.closeTape), {
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

  // GLOBAL — the pause tape reads the platform's OWN database. It must SELECT
  // and nothing else; the server owns that DB.
  try {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./lib/paperclip-pause-tape.mjs', import.meta.url), 'utf8');
    const sql = src.match(/client\.query\(\s*(`[^`]*`|'[^']*')/g) || [];
    assert(sql.length > 0, 'no SQL found in the pause-tape reader — the control cannot be checked');
    for (const s of sql) {
      assert(
        /^\s*(`|')\s*select\b/i.test(s.replace(/client\.query\(\s*/, '')),
        `a non-SELECT statement appears in the pause-tape reader: ${s.slice(0, 80)}`,
      );
    }
    assert(
      !/\b(insert|update|delete|drop|alter|truncate|create)\s+(into|from|table|set)\b/i.test(src),
      'a write statement appears in the pause-tape reader',
    );
    console.log(`ok    GLOBAL — the pause tape SELECTs and nothing else (${sql.length} statements checked)`);
    pass += 1;
  } catch (err) {
    console.log(`FAIL  GLOBAL pause-tape read-only control\n        ${err.message}`);
  }

  // GLOBAL — ⛔ TRA-3372 — the close tape reads the same platform-owned DB.
  try {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./lib/paperclip-close-tape.mjs', import.meta.url), 'utf8');
    const sql = src.match(/client\.query\(\s*(`[^`]*`|'[^']*')/g) || [];
    assert(sql.length > 0, 'no SQL found in the close-tape reader — the control cannot be checked');
    for (const s of sql) {
      assert(
        /^\s*(`|')\s*select\b/i.test(s.replace(/client\.query\(\s*/, '')),
        `a non-SELECT statement appears in the close-tape reader: ${s.slice(0, 80)}`,
      );
    }
    assert(
      !/\b(insert|update|delete|drop|alter|truncate|create)\s+(into|from|table|set)\b/i.test(src),
      'a write statement appears in the close-tape reader',
    );
    console.log(`ok    GLOBAL — the close tape SELECTs and nothing else (${sql.length} statements checked)`);
    pass += 1;
  } catch (err) {
    console.log(`FAIL  GLOBAL close-tape read-only control\n        ${err.message}`);
  }

  const total = CASES.length + 3;
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
    // ⛔ TRA-3487 — read from Postgres, NOT from `/api/.../activity`. Measured
    // on that route: the `action` filter is SILENTLY IGNORED (a query for
    // `agent.paused` returns the newest unfiltered rows), and `limit=1000`
    // yields 500 rows covering ~3.4h. Both failures are invisible in the
    // response, which would make a short/wrong window read as "no pause found".
    getPauseTape: async () =>
      readPauseTapeFromPostgres({
        companyId: CO,
        connectionString: argOf('pause-db', process.env.PAPERCLIP_DB_URL || DEFAULT_DB_URL),
        pgModulePath: process.env.PAPERCLIP_PG_MODULE || null,
      }),
    // ⛔ TRA-3372 — same database, same reason. `/api/.../activity` cannot
    // serve a 22h-old close: it caps at ~500 rows (~3.4h) and its `action`
    // filter is ignored. Bounded to the abandoned findings' linked issues.
    getCloseTape: async (issueIds) =>
      readCloseTapeFromPostgres({
        companyId: CO,
        issueIds,
        connectionString: argOf('pause-db', process.env.PAPERCLIP_DB_URL || DEFAULT_DB_URL),
        pgModulePath: process.env.PAPERCLIP_PG_MODULE || null,
      }),
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
          tape: result.tape,
          closeTape: result.closeTape,
          abandonedCount: result.abandonedCount,
          misroutedCloseCount: result.misroutedCloseCount,
          unattributedCloseCount: result.unattributedCloseCount,
          ownerPausedCount: result.ownerPausedCount,
          ownerTerminatedCount: result.ownerTerminatedCount,
          ownerUnknownCount: result.ownerUnknownCount,
          ownerPauseBurst: result.ownerPauseBurst,
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
