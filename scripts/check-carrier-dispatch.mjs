#!/usr/bin/env node
/**
 * TRA-3529 — detector for the CARRIER THAT WAS NEVER WORKED: a routine fires,
 * the platform records a run and creates the linked issue, and then no agent is
 * ever woken on it. The routine looks fired by every proxy a sweep checks, and
 * produced zero work.
 *
 * WHAT THE SHAPE IS
 * -----------------
 * `bb11cef4` fired at 2026-08-13T06:30:33Z and created TRA-3513 — a DEPLOY
 * ORDER. It sat `todo`, never picked up, for three hours. The deploy it ordered
 * did land, but from an unrelated path; nothing behind that box was stranded by
 * luck, not by design. Two of the five carriers measured that morning were
 * deploy trains. ⛔ A deploy train that reliably creates an unactioned ticket is
 * not a deploy train.
 *
 * WHY THE SIBLING CHECK CANNOT SEE IT — AND WHY THIS IS A SEPARATE FILE
 * --------------------------------------------------------------------
 * `check:routine-dispatch` (TRA-2331) grades the DISPATCH TAIL: did the fire
 * produce a run? This grades what happens AFTER a successful dispatch: did the
 * issue that run created ever get picked up? Different population, different
 * route, different owner routing — so it is deliberately not bolted onto that
 * check, whose FLEET semantics are a claim about the dispatcher alone.
 *
 * ⛔ `issue_created` IS IN THAT CHECK'S `RUN_SUCCESS` SET, and correctly so for
 * its own subject. It means an issue exists. It says nothing about whether
 * anybody was woken on it.
 *
 * ⛔⛔ RUN `status` MEASURES ISSUE CLOSURE, NOT EXECUTION. A run sits at
 * `issue_created` until its linked issue reaches a terminal status. Measured on
 * 2026-08-13: `bb11cef4`'s run flipped `issue_created` -> `completed` with
 * `completedAt=09:32:16.930Z` AT THE INSTANT a human-driven sweep closed
 * TRA-3513 by hand — no work happened in between, and the carrier's `startedAt`
 * is null to this day. So `completed` on a routine run does not mean the routine
 * did anything; it means somebody eventually closed the issue. Any dispatch
 * health check keyed on run `status` is reading the wrong variable.
 *
 * THE DISCRIMINATOR — AND THE TWO THAT LOOK LIKE IT AND ARE NOT
 * -------------------------------------------------------------
 * `issue.startedAt` — stamped when an agent runtime CHECKS THE ISSUE OUT, and
 * accompanied by `executionLockedAt` / `checkoutRunId` / `executionRunId`. It is
 * the platform's own record that a wake happened. On 2026-08-13, 840 of the
 * company's 877 routine-spawned issues carried one.
 *
 *  ⛔ NOT `assigneeAgentId`. TRA-3529 filed this as "assignee is blank across the
 *    whole population, worked or not". It is not: TRA-3513 reads
 *    `assigneeAgentId=d3355d6d` (LeadDev) on `GET /api/issues/{id}`, exactly as
 *    its routine specified, and 873 of 877 carriers carry one. What IS null on
 *    an unworked carrier is the checkout quartet above. The routine propagated
 *    its assignee correctly; nobody was woken.
 *
 *  ⛔ NOT "zero comments". That was TRA-3529's stated discriminator and it HEALS
 *    WITHOUT A DISPATCH: a sweep that closes the carrier from some other issue's
 *    run writes a comment on the way past. TRA-3493 / TRA-3511 / TRA-3513 each
 *    read `done` with one comment by 09:39Z on 2026-08-13 and `startedAt` STILL
 *    NULL — never dispatched, and invisible to a comment-count check from the
 *    moment somebody tidied up. It is a lagging proxy that fails toward CLEAN.
 *
 * THE TRAPS — each measured against the live API on 2026-08-13, each with a
 * positive control in `--selftest` that CONTAINS the thing it detects
 * ------------------------------------------------------------------------
 *  1. ⛔⛔ `lastRun.linkedIssue` ON THE LIST ROUTE HAS NO `startedAt` KEY. It
 *     carries exactly `id · identifier · priority · status · title · updatedAt`
 *     — measured on all 197 carriers. A check that read `linkedIssue.startedAt`
 *     would find `undefined` on every row and brand THE ENTIRE COMPANY never
 *     dispatched. This is the `recentRuns` trap (TRA-2331 trap 1) and the
 *     `blockedByIssueIds` trap (TRA-2364) on a third relation, and the defence
 *     is the same: ASSERT THE KEY IS PRESENT, never read a falsy value as data.
 *     So this check FANS OUT to `GET /api/issues/{id}`, which does serve it, and
 *     exits BLIND for any row where the key is absent.
 *
 *  2. ⛔⛔ ARCHIVED ROUTINES CARRY MOST OF THE CARRIERS — 163 of 197, against 34
 *     on active ones. A one-shot's own prose routinely orders it to ARCHIVE
 *     ITSELF as step 1 and then do the work, so the population restricted to
 *     `status === 'active'` (which is the right population for the sibling
 *     check, whose subject is a FUTURE schedule) is the wrong one here and would
 *     hide 83% of carriers — including exactly the self-archiving deploy
 *     one-shots that are the urgent case. Routine status is NOT filtered here.
 *
 *  3. ⛔ A TERMINAL CARRIER IS NOT PROOF OF WORK. See the `startedAt` note above:
 *     three of the five carriers in the founding cohort reached `done` without
 *     ever being dispatched. `CARRIER_SWEPT_UNWORKED` is a FINDING, not a pass —
 *     the fire's order was discharged by somebody else's judgement, out of band,
 *     and under `skip_missed` nothing replays the slot.
 *
 *  4. ⛔ AN UNDATED CARRIER IS TREATED AS OLD ENOUGH TO PAGE. A carrier whose
 *     `createdAt` will not parse cannot be aged, and demoting it to "probably
 *     just fired" is how a real one hides. Fail towards paging.
 *
 *  5. ⛔ A RUN WITH NO `linkedIssueId` IS NOT A HEALTHY MEMBER OF THIS
 *     POPULATION — it is not a member at all. `failed` / `skipped` /
 *     `coalesced` runs never created a carrier, and grading them here would
 *     manufacture a pass rate out of rows whose subject belongs to
 *     `check:routine-dispatch`. Excluded, and the exclusion is counted and
 *     printed.
 *
 *  6. ⛔ ZERO GRADED ROWS IS BLIND, NOT CLEAN. "no carrier was abandoned" and
 *     "no carrier was looked at" render identically, and this detector's whole
 *     subject is a state that looks healthy.
 *
 * ⛔ WHAT THIS CHECK DELIBERATELY DOES NOT DO — AND WHAT IT THEREFORE MISSES
 * It grades ONE carrier per routine: `lastRun`, the newest. The list route
 * serves that in a single call and does not serve run history (`recentRuns` is
 * absent — TRA-2331 trap 1). So on a routine that fires hourly, a worked newest
 * carrier HIDES an abandoned older one. This is a real, named blind spot, not a
 * silent cap: the count of routines whose history was not read is printed on
 * every run. Widening it needs a paged `/runs` enumeration and a bounded fan-out
 * budget; do not approximate it here.
 *
 * NAMING THE SUBJECT — why concentration is computed before anything is asserted
 * -----------------------------------------------------------------------------
 * TRA-3529 framed this as a fault in ROUTINE DISPATCH. The control refutes that.
 * Measured across every issue created on 2026-08-13 after 01:00Z:
 *
 *     assignee     origin              n   never-started   rate
 *     LeadDev      manual             24        16          67%
 *     LeadDev      routine_execution   8         5          62%
 *     CTO          manual             15         1           7%
 *     CTO          routine_execution   3         0           0%
 *     QuantTrader  manual              9         0           0%
 *     CFO          manual              4         0           0%
 *
 * The never-started rate is ~the same for manual and routine-spawned work WITHIN
 * an assignee, and ~zero for every other assignee REGARDLESS of origin. The
 * variable is the ASSIGNEE'S QUEUE, not the origin: LeadDev held 109 open issues
 * and took 37 new ones that day. The cohort in the founding ticket looked
 * routine-specific because it was selected routine-only.
 *
 * ⛔ So a banner here may not assert "the dispatcher" merely because several
 * carriers are abandoned. Findings concentrated on ONE assignee are that agent's
 * QUEUE — routable to the owner and the board, and NOT a platform claim. Only a
 * spread across the roster leaves the dispatcher as the remaining subject. This
 * is the TRA-3487 lesson (a burst of paused owners is one condition whose
 * subject is the OWNER) applied one level further out.
 *
 * VERDICTS / EXIT CODES
 *   0  CLEAN      — population non-empty, every graded carrier was dispatched
 *   1  FINDINGS   — abandoned carriers, routable to their assignees
 *   2  SYSTEMIC   — one condition, and the report NAMES which: QUEUE (all on one
 *                   assignee) or DISPATCHER (spread across the roster)
 *   3  BLIND      — the population or a row is untrustworthy. NOT a pass.
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
/**
 * A carrier younger than this is a dispatch in flight, not an abandoned one.
 * The founding cohort was 3.0h–8.4h old at the read; 90 min is comfortably
 * clear of a normal wake and still catches an overnight deploy train before its
 * window closes.
 */
const GRACE_MS = Number(argOf('grace-min', 90)) * 60 * 1000;
/** Findings older than this are the residue of a past event, not a live page. */
const RECENT_WINDOW_MS = Number(argOf('recent-window-min', 24 * 60)) * 60 * 1000;
/** A single assignee holding at least this share of findings owns the condition. */
const CONCENTRATION_SHARE = Number(argOf('concentration-share', 0.8));
const SYSTEMIC_MIN_FINDINGS = Number(argOf('systemic-min-findings', 3));
const SYSTEMIC_MIN_ASSIGNEES = Number(argOf('systemic-min-assignees', 3));

/* ------------------------------------------------------------------ *
 * COHORT ARM (TRA-3535) — the roster-wide population
 * ------------------------------------------------------------------ */

/**
 * ⭐ WHY A SECOND ARM AT ALL (TRA-3535, board ruling on TRA-3532 item 6).
 *
 * The routine arm above grades carriers-by-routine and reports QUEUE STARVATION
 * — a claim about an AGENT'S WHOLE QUEUE. But the evidence for that claim lives
 * in the MANUAL slice, which a routine-rooted population structurally cannot
 * reach: on 2026-08-13, 17 of LeadDev's 22 starved rows were manually created,
 * i.e. 77% of the cohort the banner is about. Those 17 were counted BY HAND
 * twice (TRA-3529, then TRA-3532). A load-bearing number with no instrument
 * gets re-hand-counted every time the question is asked.
 *
 * So this arm changes the POPULATION, not the predicate: every issue created in
 * the window, partitioned by (assigneeAgentId, originKind). The discriminator is
 * unchanged and deliberately so — `startedAt`, with executionLockedAt /
 * checkoutRunId / executionRunId as corroboration. Run `status` and
 * zero-comments both fail toward CLEAN and are not used here either.
 *
 * ⛔⛔ THIS IS A LIVE INSTRUMENT AND IT CANNOT BE RUN BACKWARDS. The starved
 * population HEALS: re-measured 2026-09-22, the very cohort that read 68% at
 * 2026-08-13T10:00Z now reads 10%, because 15 of LeadDev's starved rows (13 of
 * them manual) were picked up AFTER the read. The rows did not turn out to have
 * been fine — they were dispatched late, and `startedAt` records only THAT it
 * happened, never that it was late. So a retrospective query over an old window
 * systematically under-reports, and the 08-13 hand-count is NOT reproducible by
 * pointing this check at 08-13. Grade the window that is open NOW; use
 * `--cohort-since` only to inspect, never to re-litigate a past verdict.
 */

/**
 * 72h, not the 24h the routine arm uses for recency.
 *
 * A 24h window ending at a quiet hour is EMPTY — measured 2026-09-22T19:26Z, all
 * 12 issues created that day were <4 min old and inside grace, so a 24h cohort
 * graded 0 rows and the only honest verdict was BLIND. A default that reads
 * BLIND on an ordinary quiet afternoon is a default that gets muted. 72h holds a
 * population (n=34 at the same instant) and still reads LIVE: a queue starving
 * at 68% is not hidden by widening to three days.
 */
const COHORT_WINDOW_MS = Number(argOf('cohort-window-hours', 72)) * 3600 * 1000;
const COHORT_SINCE = argOf('cohort-since', null);
const ISSUE_PAGE = Number(argOf('issue-page', 200));
const ISSUE_PAGE_CAP = Number(argOf('issue-page-cap', 60));

/**
 * ⛔ A RATE OVER A HANDFUL OF ROWS IS NOT A RATE. Measured live at 72h on
 * 2026-09-22, CFO reads 25% off 1 starved row out of 4 — arithmetically the
 * worst rate on the board and evidentially nothing. Without a floor on n, the
 * concentration test fires on whoever happened to be assigned two issues.
 */
const COHORT_MIN_ASSIGNEE_N = Number(argOf('cohort-min-assignee-n', 8));

/**
 * ⛔⛔ CALIBRATED ON THE MEASURED SPREAD, NOT ON ZERO (TRA-3535 correction 2).
 *
 * TRA-3532 carried "every other assignee sits at ~0%". That is false: CTO's
 * manual never-start rate in the same cohort was 18% (3/17), not 7%. A threshold
 * calibrated against ~0 fires on an ordinary busy queue the following week — the
 * detector convicts the next agent who has a slow day, gets argued with once,
 * and is muted.
 *
 * The measured 08-13 spread is LeadDev 67% (22/33) against a pooled rest of
 * 10.5% (4/38) — a 6.4x separation, not a step off zero. Both conditions are
 * required, and each one alone is wrong:
 *   · FLOOR alone convicts a whole board having a bad week.
 *   · MULTIPLE alone convicts 12% against a rest that happens to sit at 4%.
 * Against the live 2026-09-22 board (top open-starved rate 8.3%) both are
 * comfortably silent; against 08-13 both fire with margin.
 */
const COHORT_RATE_FLOOR = Number(argOf('cohort-rate-floor', 0.35));
const COHORT_RATE_MULTIPLE = Number(argOf('cohort-rate-multiple', 2.5));

export const VERDICT_EXIT = { CLEAN: 0, FINDINGS: 1, SYSTEMIC: 2, BLIND: 3 };

/** Terminal issue statuses — reached, but NOT necessarily by being worked. */
export const TERMINAL_ISSUE_STATUSES = new Set(['done', 'cancelled']);

export const FINDING_STATES = new Set([
  'CARRIER_UNWORKED',
  'CARRIER_SWEPT_UNWORKED',
  'CARRIER_CANCELLED_UNWORKED',
]);

/**
 * ⛔ A CANCELLED carrier is a finding that is NOT evidence of starvation.
 *
 * `cancelled` is somebody DELIBERATELY RETIRING the order — on this board it is
 * the disposition of every retired routine ("DO NOT UN-ARCHIVE ... RETIRED"),
 * and 5 of the 18 findings on the first live run were exactly that. The slot was
 * still lost and `skip_missed` will not replay it, so it stays reported at exit
 * 1. But counting a deliberate retirement as an abandoned queue is how a
 * detector earns its mute: it would put a permanent floor of ~5 findings under
 * every future run and drag the concentration maths toward whoever retired the
 * most routines. Held out of the systemic test for the same reason the sibling
 * check holds out `EXECUTION_ISSUE_ABANDONED` (TRA-2331).
 */
export const SYSTEMIC_STATES = new Set(['CARRIER_UNWORKED', 'CARRIER_SWEPT_UNWORKED']);

/* ------------------------------------------------------------------ *
 * Predicate
 * ------------------------------------------------------------------ */

/**
 * Classify one carrier.
 *
 * @param {object} run   the routine's `lastRun`
 * @param {object} issue the carrier, read from `GET /api/issues/{id}` — NOT from
 *   `lastRun.linkedIssue`, which does not serve `startedAt` (trap 1).
 */
export function classifyCarrier(run, issue, { graceMs = GRACE_MS, nowMs } = {}) {
  // Trap 1. The KEY, not the value. `undefined` here means we asked a route that
  // does not serve this relation — which is not the same as "never dispatched",
  // and on the list route it is the reading for EVERY row.
  if (!issue || typeof issue !== 'object') {
    return { state: 'BLIND', detail: 'carrier issue could not be read at all' };
  }
  if (!('startedAt' in issue)) {
    return {
      state: 'BLIND',
      detail:
        'carrier row carries no `startedAt` KEY — the route did not serve the relation. ' +
        '(`lastRun.linkedIssue` on the routines LIST route drops it exactly this way, on every row; ' +
        'do not read an absent key as "never dispatched".)',
    };
  }

  const createdAt = issue.createdAt || run?.triggeredAt || null;
  const createdMs = Date.parse(createdAt || '');
  // Trap 4 — an undated carrier is aged as INFINITELY OLD, so it pages rather
  // than hiding behind the grace window.
  const ageMs = Number.isFinite(createdMs) ? nowMs - createdMs : Infinity;

  if (issue.startedAt) {
    return { state: 'CARRIER_WORKED', detail: `dispatched at ${issue.startedAt}`, ageMs, createdAt };
  }

  if (ageMs <= graceMs) {
    return {
      state: 'CARRIER_PENDING',
      detail: `created ${Math.round(ageMs / 60000)} min ago — inside the ${Math.round(graceMs / 60000)} min grace window`,
      ageMs,
      createdAt,
    };
  }

  // Trap 3 — terminal is not worked. Split it out so the report can say which
  // of the two shapes it is, because they route differently: an OPEN one is a
  // live order nobody has taken, a CLOSED one is an order somebody discharged
  // out of band and which no proxy will ever flag again.
  if (issue.status === 'cancelled') {
    return {
      state: 'CARRIER_CANCELLED_UNWORKED',
      detail:
        'the carrier was CANCELLED without ever being dispatched — a deliberate retirement, not a starved ' +
        'queue. The slot is still gone and nothing replays it, but this is NOT evidence of an abandoned ' +
        'queue and is held out of the systemic test.',
      ageMs,
      createdAt,
    };
  }

  if (TERMINAL_ISSUE_STATUSES.has(issue.status)) {
    return {
      state: 'CARRIER_SWEPT_UNWORKED',
      detail:
        `reached \`${issue.status}\` WITHOUT EVER BEING DISPATCHED (startedAt null) — closed out of band by ` +
        'another run, not worked. ⛔ Run `status` and comment count both read healthy on this row.',
      ageMs,
      createdAt,
    };
  }

  return {
    state: 'CARRIER_UNWORKED',
    detail:
      `still \`${issue.status}\` ${(ageMs / 3600000).toFixed(1)}h after the fire and NEVER DISPATCHED ` +
      '(startedAt / executionLockedAt / checkoutRunId all null) — the routine fired, the order exists, ' +
      'and nobody was woken on it.',
    ageMs,
    createdAt,
  };
}

/* ------------------------------------------------------------------ *
 * The sweep — transport injected so the controls drive the whole pipeline,
 * enumeration guards included.
 * ------------------------------------------------------------------ */

export async function sweep(transport, opts = {}) {
  const limit = opts.routineLimit ?? ROUTINE_LIMIT;
  const graceMs = opts.graceMs ?? GRACE_MS;
  const recentWindowMs = opts.recentWindowMs ?? RECENT_WINDOW_MS;
  // Injected by the controls so the age axis is testable against a fixed clock.
  // A detector whose verdict depends on wall-time cannot have a control.
  const nowMs = opts.nowMs ?? Date.now();

  const { routines, blind: enumBlind, probe } = await enumerateRoutines(transport.getRoutines, { limit });
  if (enumBlind) return { verdict: 'BLIND', blind: enumBlind, findings: [], graded: 0, routineCount: 0 };

  // Trap 2 — routine `status` is NOT filtered. A self-archiving one-shot is the
  // single most important member of this population.
  const population = [];
  let noCarrier = 0;
  let noLastRunKey = 0;
  for (const r of routines) {
    if (!r) continue;
    if (!('lastRun' in r)) {
      // The relation is absent, not empty. Same shape as trap 1 one level up.
      noLastRunKey += 1;
      continue;
    }
    const run = r.lastRun;
    // Trap 5 — no carrier means not a member, not a healthy member.
    if (!run || !run.linkedIssueId) {
      noCarrier += 1;
      continue;
    }
    population.push({ routine: r, run });
  }

  if (noLastRunKey > 0) {
    return {
      verdict: 'BLIND',
      blind:
        `${noLastRunKey} routine row(s) carried no \`lastRun\` KEY — the route did not serve the relation, ` +
        'and an absent key is not "never fired". The population cannot be derived from this route.',
      findings: [],
      graded: 0,
      routineCount: routines.length,
    };
  }

  // Trap 6. Zero graded rows is BLIND, never CLEAN.
  if (population.length === 0) {
    return {
      verdict: 'BLIND',
      blind:
        `0 of ${routines.length} routines carry a last run with a linked carrier issue — ` +
        '"no carrier was abandoned" and "no carrier was looked at" are the same reading, and this ' +
        'detector exists for states that look healthy',
      findings: [],
      graded: 0,
      routineCount: routines.length,
      noCarrier,
    };
  }

  const findings = [];
  const blindRows = [];
  const tally = {};
  for (const { routine, run } of population) {
    let issue = null;
    let readError = null;
    try {
      issue = await transport.getIssue(run.linkedIssueId);
    } catch (err) {
      readError = err?.message || String(err);
    }

    const c = readError
      ? { state: 'BLIND', detail: `carrier issue read failed — ${readError}` }
      : classifyCarrier(run, issue, { graceMs, nowMs });

    tally[c.state] = (tally[c.state] || 0) + 1;

    if (c.state === 'BLIND') {
      blindRows.push({
        id: routine.id,
        title: routine.title,
        carrierId: run.linkedIssueId,
        reason: c.detail,
      });
      continue;
    }
    if (!FINDING_STATES.has(c.state)) continue;

    findings.push({
      routineId: routine.id,
      short: String(routine.id).slice(0, 8),
      routineStatus: routine.status || null,
      title: routine.title,
      // ⛔ The ASSIGNEE OF THE CARRIER, not of the routine. The routine names who
      // it wants; the issue records who actually holds it, and it is the issue's
      // queue that starved.
      assigneeAgentId: issue.assigneeAgentId || routine.assigneeAgentId || null,
      carrier: issue.identifier || run.linkedIssueId,
      carrierId: run.linkedIssueId,
      carrierStatus: issue.status || null,
      carrierPriority: issue.priority || null,
      runStatus: run.status || null,
      // The two fields that make this check necessary, carried verbatim so the
      // report can show that both of them read HEALTHY on a finding.
      runCompletedAt: run.completedAt || null,
      triggeredAt: run.triggeredAt || null,
      createdAt: c.createdAt || null,
      state: c.state,
      detail: c.detail,
      ageMs: Number.isFinite(c.ageMs) ? c.ageMs : null,
      // ⛔ An UNDATED carrier is treated as RECENT. Fail towards paging.
      recent: !Number.isFinite(c.ageMs) ? true : c.ageMs <= recentWindowMs,
    });
  }

  if (blindRows.length > 0) {
    return {
      verdict: 'BLIND',
      blind: `${blindRows.length} carrier(s) could not be classified`,
      blindRows,
      findings,
      graded: population.length,
      routineCount: routines.length,
      noCarrier,
      tally,
      probe,
    };
  }

  // SYSTEMIC is a claim about NOW, so it is computed over recent findings only —
  // and only over the states that are evidence FOR it. A deliberate retirement
  // is not.
  // ⛔ Two different recency sets, and conflating them is a bug in both
  // directions: `recentAll` decides whether this is residue (a recent
  // CANCELLED finding is still recent), `recentFindings` decides the systemic
  // subject (a retirement is not evidence for it).
  const recentAll = findings.filter((f) => f.recent);
  const recentFindings = recentAll.filter((f) => SYSTEMIC_STATES.has(f.state));
  const byAssignee = new Map();
  for (const f of recentFindings) {
    const k = f.assigneeAgentId || 'UNASSIGNED';
    byAssignee.set(k, (byAssignee.get(k) || 0) + 1);
  }
  const ranked = [...byAssignee.entries()].sort((a, b) => b[1] - a[1]);
  const topAssignee = ranked[0] || null;
  const topShare = topAssignee ? topAssignee[1] / recentFindings.length : 0;

  // ⛔ ORDER MATTERS. Concentration is tested FIRST: a pile of findings on one
  // assignee is that agent's QUEUE, and calling it a dispatcher fault is the
  // exact misdiagnosis this check was written to prevent.
  const queueCondition =
    recentFindings.length >= SYSTEMIC_MIN_FINDINGS && topAssignee !== null && topShare >= CONCENTRATION_SHARE;
  const dispatcherCondition =
    !queueCondition && recentFindings.length >= SYSTEMIC_MIN_FINDINGS && byAssignee.size >= SYSTEMIC_MIN_ASSIGNEES;

  const dated = findings.map((f) => f.ageMs).filter((v) => typeof v === 'number');
  const newestFindingAgeMs = dated.length ? Math.min(...dated) : null;

  return {
    verdict:
      findings.length === 0 ? 'CLEAN' : queueCondition || dispatcherCondition ? 'SYSTEMIC' : 'FINDINGS',
    blind: null,
    subject: queueCondition ? 'QUEUE' : dispatcherCondition ? 'DISPATCHER' : null,
    findings,
    graded: population.length,
    routineCount: routines.length,
    noCarrier,
    tally,
    byAssignee: Object.fromEntries(ranked),
    topAssignee: topAssignee ? topAssignee[0] : null,
    topAssigneeCount: topAssignee ? topAssignee[1] : 0,
    topShare,
    recentCount: recentFindings.length,
    recentAllCount: recentAll.length,
    unworkedOpenCount: findings.filter((f) => f.state === 'CARRIER_UNWORKED').length,
    sweptCount: findings.filter((f) => f.state === 'CARRIER_SWEPT_UNWORKED').length,
    cancelledCount: findings.filter((f) => f.state === 'CARRIER_CANCELLED_UNWORKED').length,
    residueOnly: findings.length > 0 && recentAll.length === 0,
    recentWindowMs,
    graceMs,
    newestFindingAgeMs,
    // The named blind spot: one carrier per routine was graded, so a worked
    // newest carrier hides an abandoned older one. Printed, never silent.
    historyUnread: population.length,
    probe,
  };
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

export function renderReport(r, names = {}) {
  const out = [];
  const nm = (id) =>
    id && id !== 'UNASSIGNED' ? names[String(id).slice(0, 8)] || String(id).slice(0, 8) : 'UNASSIGNED';
  const hrs = (ms) => (ms === null || ms === undefined ? '?' : `${(ms / 3600000).toFixed(1)}h`);

  out.push(`TRA-3529 routine-carrier dispatch — verdict ${r.verdict}`);
  out.push(
    `  routines read: ${r.routineCount ?? 0} · carrying a carrier (GRADED): ${r.graded ?? 0}` +
      (r.noCarrier ? ` · no carrier (excluded): ${r.noCarrier}` : ''),
  );
  if (r.tally) out.push(`  carrier states: ${Object.entries(r.tally).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (r.verdict === 'BLIND') {
    out.push('');
    out.push(`  BLIND — ${r.blind}`);
    for (const b of r.blindRows || []) {
      out.push(`    ${String(b.id).slice(0, 8)}  ${b.title || ''} — ${b.reason}`);
    }
    out.push('  A BLIND run is NOT a pass. Do not read it as "no carrier was abandoned".');
    return out;
  }

  if (r.findings.length === 0) {
    out.push('');
    out.push(`  CLEAN — all ${r.graded} graded carriers were dispatched to an agent.`);
    out.push(
      `  ⛔ ONE carrier per routine (the newest) was graded. On a routine that fires often, a worked ` +
        `newest carrier HIDES an abandoned older one; ${r.historyUnread} routines had no run history read.`,
    );
    return out;
  }

  out.push('');
  out.push(
    `  ${r.findings.length} of ${r.graded} carriers were NEVER DISPATCHED ` +
      `(${r.recentAllCount ?? r.recentCount} inside the ${hrs(r.recentWindowMs)} recency window, of which ` +
      `${r.recentCount} count toward the systemic test; newest ${hrs(r.newestFindingAgeMs)} old; ` +
      `grace ${Math.round(r.graceMs / 60000)} min):`,
  );
  for (const f of [...r.findings].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    out.push(
      `    ${f.short}  ${nm(f.assigneeAgentId).padEnd(12)} ${f.state}` +
        `  [${f.recent ? 'RECENT' : 'residue'} ${hrs(f.ageMs)}]`,
    );
    out.push(`              carrier ${f.carrier} (${f.carrierStatus}/${f.carrierPriority}) — ${(f.title || '').slice(0, 78)}`);
    out.push(
      `              routine ${f.routineStatus} · run.status=${f.runStatus}` +
        (f.runCompletedAt ? ` completedAt=${f.runCompletedAt}` : '') +
        `  <- ⛔ this is what a run-status check reads`,
    );
    out.push(`              ${f.detail}`);
  }

  if (r.verdict === 'SYSTEMIC' && r.subject === 'QUEUE') {
    out.push('');
    out.push(
      `  QUEUE STARVATION — ${r.topAssigneeCount} of ${r.recentCount} recent findings ` +
        `(${(r.topShare * 100).toFixed(0)}%) are carriers assigned to ${nm(r.topAssignee)}. This is ONE ` +
        `condition, not ${r.topAssigneeCount} routines to repair. ⛔ Do not file a ticket per routine.`,
    );
    out.push(
      '  SUBJECT: THAT AGENT\'S QUEUE — and that is asserted, not assumed: the findings concentrate on a ' +
        'single assignee, so the dispatcher is NOT the remaining subject. Per TRA-3529 the same agent\'s ' +
        'MANUALLY-created issues starve at the same rate, which is what rules out an origin-specific fault. ' +
        '⛔ Route it to that owner and the board (capacity / re-home / re-assign), NOT to the platform.',
    );
  } else if (r.verdict === 'SYSTEMIC' && r.subject === 'DISPATCHER') {
    out.push('');
    out.push(
      `  DISPATCH-WIDE — ${r.recentCount} recent findings span ${Object.keys(r.byAssignee).length} distinct ` +
        'assignees with no single owner above the concentration floor. This is ONE condition and the ' +
        'DISPATCHER is the remaining subject: no one queue explains it.',
    );
    out.push(
      '  ⛔ Before acting on that: confirm the spread is not just several busy queues at once. The claim ' +
        'this banner makes is only as good as the assignee split printed below.',
    );
  }

  out.push('');
  out.push(`  findings by assignee: ${Object.entries(r.byAssignee).map(([k, v]) => `${nm(k)}=${v}`).join(' ') || '(none recent)'}`);

  if (r.sweptCount > 0) {
    out.push('');
    out.push(
      `  ${r.sweptCount} of the findings are CARRIER_SWEPT_UNWORKED — the carrier reached a TERMINAL status ` +
        'without ever being dispatched: closed out of band by another run. ⛔ These are the ones no other ' +
        'instrument can ever see again — the run reads `completed`, the issue reads `done`, and the comment ' +
        'a sweep left on the way past defeats a zero-comment check. The slot is gone; `skip_missed` does ' +
        'not replay it.',
    );
  }

  if (r.cancelledCount > 0) {
    out.push('');
    out.push(
      `  ${r.cancelledCount} of the findings are CARRIER_CANCELLED_UNWORKED — the carrier was CANCELLED ` +
        'without ever being dispatched. That is a DELIBERATE RETIREMENT, not a starved queue: the slot is ' +
        'gone and nothing replays it, but it is NOT evidence of an abandoned queue and is excluded from the ' +
        'systemic test. ⛔ Do not route these anywhere — they are already dispositioned.',
    );
  }

  if (r.residueOnly) {
    out.push('');
    out.push(
      `  RESIDUE ONLY — every finding above predates the ${hrs(r.recentWindowMs)} window; the newest is ` +
        `${hrs(r.newestFindingAgeMs)} old. Report it, do NOT re-escalate it as a live event.`,
    );
    out.push('  ⛔ It is still not CLEAN. Those orders were never executed and nothing will replay them.');
  }

  out.push('');
  out.push(
    `  ⛔ ONE carrier per routine (the newest) was graded — ${r.historyUnread} routines had no run history ` +
      'read, so an abandoned OLDER carrier behind a worked newest one is NOT counted above.',
  );
  return out;
}

/* ================================================================== *
 * COHORT ARM — issues-by-origin across the whole roster (TRA-3535)
 * ================================================================== */

/**
 * ⛔ The four fields are NOT redundant and the OR is deliberate.
 *
 * `startedAt` is the discriminator; the other three are corroboration, and the
 * predicate is "none of the four is set". Reading `startedAt` alone would brand
 * a row never-dispatched when the platform holds an execution lock on it — which
 * is a row being worked RIGHT NOW. Fail toward CLEAN on an individual row and
 * toward paging on the population is the wrong way round; the population floor
 * is enforced separately, below.
 */
export const DISPATCH_FIELDS = ['startedAt', 'executionLockedAt', 'checkoutRunId', 'executionRunId'];

export const COHORT_FINDING_STATES = new Set([
  'ISSUE_UNDISPATCHED_OPEN',
  'ISSUE_UNDISPATCHED_SWEPT',
  'ISSUE_UNDISPATCHED_CANCELLED',
]);

/**
 * ⛔⛔ ONLY THE OPEN ONES COUNT TOWARD THE HEADLINE (TRA-3535 correction 1).
 *
 * never-checked-out is NOT never-handled. 6 of the 25 never-dispatched rows in
 * the 08-13 cohort were already CLOSED — TRA-3493/3511/3513 graded by replay,
 * TRA-3521/3520 `done`, TRA-3528 a cancelled probe. Folding those into the
 * headline over-reports by ~24% and would have made LeadDev's live figure 21
 * rather than the true never-dispatched-AND-still-open 17.
 *
 * This is the same partition the routine arm already makes with
 * CARRIER_SWEPT_UNWORKED / CARRIER_CANCELLED_UNWORKED; the manual slice needed
 * it for the same reason. They stay REPORTED — an order discharged out of band
 * is still an order nobody was woken on — and stay OUT of the rate.
 */
export const COHORT_SYSTEMIC_STATES = new Set(['ISSUE_UNDISPATCHED_OPEN']);

/**
 * Classify one issue on the dispatch axis.
 *
 * @param {object} issue a row as the issues LIST route serves it. ⛔ Verified
 *   2026-09-22 to carry `startedAt` / `originKind` / `executionLockedAt` /
 *   `checkoutRunId` / `executionRunId` with values IDENTICAL to the single-issue
 *   GET — unlike `lastRun.linkedIssue`, which drops `startedAt` entirely (trap 1
 *   on the routine arm). ⛔ That is true of the FULL row only: `?view=compact`
 *   nulls fields the full GET has, so this arm must never request it.
 */
export function classifyIssueDispatch(issue, { graceMs = GRACE_MS, nowMs } = {}) {
  if (!issue || typeof issue !== 'object') {
    return { state: 'BLIND', detail: 'issue row could not be read at all' };
  }
  // Trap 1, one level out. The KEY, not the value — an absent key means the
  // route did not serve the relation, which is not "never dispatched".
  for (const f of DISPATCH_FIELDS) {
    if (!(f in issue)) {
      return {
        state: 'BLIND',
        detail:
          `issue row carries no \`${f}\` KEY — the route did not serve the relation. An absent key is ` +
          'not a null. (`?view=compact` and `lastRun.linkedIssue` both drop fields exactly this way.)',
      };
    }
  }
  if (!('originKind' in issue)) {
    return {
      state: 'BLIND',
      detail: 'issue row carries no `originKind` KEY — this arm partitions BY origin and cannot grade it',
    };
  }

  const createdMs = Date.parse(issue.createdAt || '');
  // Undated is aged INFINITELY OLD — it pages rather than hiding behind grace.
  const ageMs = Number.isFinite(createdMs) ? nowMs - createdMs : Infinity;
  const dispatched = DISPATCH_FIELDS.find((f) => issue[f]);

  if (dispatched) {
    return {
      state: 'ISSUE_DISPATCHED',
      detail: `dispatched — ${dispatched}=${issue[dispatched]}`,
      ageMs,
      via: dispatched,
    };
  }

  if (ageMs <= graceMs) {
    return {
      state: 'ISSUE_PENDING',
      detail: `created ${Math.round(ageMs / 60000)} min ago — inside the ${Math.round(graceMs / 60000)} min grace window`,
      ageMs,
    };
  }

  if (issue.status === 'cancelled') {
    return {
      state: 'ISSUE_UNDISPATCHED_CANCELLED',
      detail:
        'CANCELLED without ever being dispatched — a deliberate retirement. Reported, but held OUT of the ' +
        'rate: it is not a starved queue and it is already dispositioned.',
      ageMs,
    };
  }
  if (TERMINAL_ISSUE_STATUSES.has(issue.status)) {
    return {
      state: 'ISSUE_UNDISPATCHED_SWEPT',
      detail:
        `reached \`${issue.status}\` without ever being dispatched — discharged out of band, not worked. ` +
        'Reported, but held OUT of the rate: never-checked-out is NOT never-handled.',
      ageMs,
    };
  }
  return {
    state: 'ISSUE_UNDISPATCHED_OPEN',
    detail:
      `still \`${issue.status}\` ${(ageMs / 3600000).toFixed(1)}h after creation and NEVER DISPATCHED ` +
      '(startedAt / executionLockedAt / checkoutRunId / executionRunId all null) — a live order nobody ' +
      'has been woken on.',
    ageMs,
  };
}

/**
 * Grade every issue created in the window, partitioned by (assignee, origin).
 */
export async function sweepCohort(transport, opts = {}) {
  const graceMs = opts.graceMs ?? GRACE_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.cohortWindowMs ?? COHORT_WINDOW_MS;
  const pageSize = opts.issuePage ?? ISSUE_PAGE;
  const pageCap = opts.issuePageCap ?? ISSUE_PAGE_CAP;
  const sinceIso = opts.cohortSince ?? COHORT_SINCE;
  const sinceMs = sinceIso ? Date.parse(sinceIso) : nowMs - windowMs;

  if (!Number.isFinite(sinceMs)) {
    return { arm: 'COHORT', verdict: 'BLIND', blind: `--cohort-since is not a parseable date: ${sinceIso}` };
  }

  // ⛔⛔ THE LIST ROUTE HAS NO createdAfter FILTER and its ordering is NOT
  // createdAt — measured 2026-09-22, offset 0 starts at TRA-3926 and offset 200
  // at TRA-1662. So there is NO early exit: pages cannot be stopped at the first
  // row older than the window without silently dropping members. Enumerate the
  // whole board and filter in memory.
  const all = [];
  let pages = 0;
  let truncated = false;
  for (;;) {
    if (pages >= pageCap) {
      truncated = true;
      break;
    }
    let batch;
    try {
      batch = await transport.getIssues({ limit: pageSize, offset: pages * pageSize });
    } catch (err) {
      return {
        arm: 'COHORT',
        verdict: 'BLIND',
        blind: `issue enumeration failed at offset ${pages * pageSize} — ${err?.message || err}`,
      };
    }
    if (!Array.isArray(batch)) {
      return {
        arm: 'COHORT',
        verdict: 'BLIND',
        blind: `issues route did not return an array at offset ${pages * pageSize} — the population is unreadable`,
      };
    }
    pages += 1;
    all.push(...batch);
    if (batch.length < pageSize) break;
  }

  // ⛔ Truncation is BLIND, never a partial pass. A capped enumeration cannot
  // tell "nobody is starved" from "the starved rows are on the page we skipped".
  if (truncated) {
    return {
      arm: 'COHORT',
      verdict: 'BLIND',
      blind:
        `issue enumeration hit the ${pageCap}-page cap (${all.length} rows) without exhausting the route — ` +
        'the population is incomplete and an incomplete population cannot clear anybody. Raise --issue-page-cap.',
      cohortSize: all.length,
    };
  }

  // A duplicate id across pages means the underlying ordering shifted mid-walk.
  const seenIds = new Set();
  let dupes = 0;
  for (const r of all) {
    if (!r || !r.id) continue;
    if (seenIds.has(r.id)) dupes += 1;
    seenIds.add(r.id);
  }

  const inWindow = all.filter((r) => {
    const t = Date.parse(r?.createdAt || '');
    return Number.isFinite(t) && t >= sinceMs;
  });

  const rows = [];
  const blindRows = [];
  const tally = {};
  for (const issue of inWindow) {
    const c = classifyIssueDispatch(issue, { graceMs, nowMs });
    tally[c.state] = (tally[c.state] || 0) + 1;
    if (c.state === 'BLIND') {
      blindRows.push({ id: issue?.id, identifier: issue?.identifier, reason: c.detail });
      continue;
    }
    rows.push({
      id: issue.id,
      identifier: issue.identifier || issue.id,
      title: issue.title || '',
      status: issue.status || null,
      priority: issue.priority || null,
      assigneeAgentId: issue.assigneeAgentId || null,
      originKind: issue.originKind || 'unknown',
      createdAt: issue.createdAt || null,
      state: c.state,
      detail: c.detail,
      ageMs: Number.isFinite(c.ageMs) ? c.ageMs : null,
    });
  }

  if (blindRows.length > 0) {
    return {
      arm: 'COHORT',
      verdict: 'BLIND',
      blind: `${blindRows.length} issue row(s) could not be classified on the dispatch axis`,
      blindRows,
      cohortSize: all.length,
      inWindow: inWindow.length,
    };
  }

  // ⛔ GRADED excludes rows inside grace: a dispatch in flight is not a graded
  // row, and counting it as a healthy denominator DILUTES the rate toward CLEAN.
  const graded = rows.filter((r) => r.state !== 'ISSUE_PENDING');
  const pending = rows.length - graded.length;

  // Trap 6, inherited. Zero graded rows is BLIND, never CLEAN.
  if (graded.length === 0) {
    return {
      arm: 'COHORT',
      verdict: 'BLIND',
      blind:
        `0 gradeable issues were created in the ${(windowMs / 3600000).toFixed(0)}h window ` +
        `(${rows.length} in window, ${pending} still inside the ${Math.round(graceMs / 60000)} min grace). ` +
        '"nobody is starved" and "nobody was looked at" are the same reading.',
      cohortSize: all.length,
      inWindow: inWindow.length,
      pending,
      tally,
    };
  }

  const findings = graded.filter((r) => COHORT_FINDING_STATES.has(r.state));
  const starvedOpen = graded.filter((r) => COHORT_SYSTEMIC_STATES.has(r.state));

  // (assignee, origin) — the partition the ruling asked for, reported in full so
  // the "and every other assignee sits at ~0%" half of the claim is MEASURED.
  const cells = new Map();
  for (const r of graded) {
    const k = `${r.assigneeAgentId || 'UNASSIGNED'}\u0000${r.originKind}`;
    const cell = cells.get(k) || { assigneeAgentId: r.assigneeAgentId || 'UNASSIGNED', originKind: r.originKind, n: 0, starvedOpen: 0, swept: 0, cancelled: 0 };
    cell.n += 1;
    if (r.state === 'ISSUE_UNDISPATCHED_OPEN') cell.starvedOpen += 1;
    if (r.state === 'ISSUE_UNDISPATCHED_SWEPT') cell.swept += 1;
    if (r.state === 'ISSUE_UNDISPATCHED_CANCELLED') cell.cancelled += 1;
    cells.set(k, cell);
  }

  // The systemic test folds ORIGINS TOGETHER per assignee. That is the whole
  // point of the ruling: the claim is about a QUEUE, and a queue does not care
  // which door an issue came through.
  const byAssignee = new Map();
  for (const r of graded) {
    const k = r.assigneeAgentId || 'UNASSIGNED';
    const a = byAssignee.get(k) || { assigneeAgentId: k, n: 0, starvedOpen: 0 };
    a.n += 1;
    if (r.state === 'ISSUE_UNDISPATCHED_OPEN') a.starvedOpen += 1;
    byAssignee.set(k, a);
  }
  const roster = [...byAssignee.values()].map((a) => ({ ...a, rate: a.n ? a.starvedOpen / a.n : 0 }));

  // ⛔ UNASSIGNED IS NOT AN AGENT AND MUST NOT BE THE SUBJECT. An unassigned row
  // is never-dispatched BY CONSTRUCTION — there is no queue for it to starve in.
  // Measured 2026-09-22 it sits at 100% (1/1) and would win every concentration
  // test forever. Reported as its own class; excluded from the roster maths.
  const eligible = roster
    .filter((a) => a.assigneeAgentId !== 'UNASSIGNED' && a.n >= COHORT_MIN_ASSIGNEE_N)
    .sort((a, b) => b.rate - a.rate || b.starvedOpen - a.starvedOpen);
  const unassigned = roster.find((a) => a.assigneeAgentId === 'UNASSIGNED') || null;
  const underpowered = roster.filter((a) => a.assigneeAgentId !== 'UNASSIGNED' && a.n < COHORT_MIN_ASSIGNEE_N);

  const top = eligible[0] || null;
  // Pooled rest — rows, not a mean of rates. A mean of per-agent rates lets an
  // agent with 2 rows swing the baseline as hard as one with 200.
  const restN = eligible.slice(1).reduce((s, a) => s + a.n, 0);
  const restStarved = eligible.slice(1).reduce((s, a) => s + a.starvedOpen, 0);
  const restRate = restN ? restStarved / restN : 0;

  const spreadMeasured = eligible.length >= 2;
  const queueCondition = Boolean(
    top &&
      spreadMeasured &&
      top.starvedOpen >= SYSTEMIC_MIN_FINDINGS &&
      top.rate >= COHORT_RATE_FLOOR &&
      top.rate >= COHORT_RATE_MULTIPLE * restRate,
  );
  // DISPATCHER is the remaining subject only when the floor is cleared BROADLY —
  // no one queue explains it. Tested second, and only if QUEUE did not fire.
  const broad = eligible.filter((a) => a.rate >= COHORT_RATE_FLOOR && a.starvedOpen >= SYSTEMIC_MIN_FINDINGS);
  const dispatcherCondition = !queueCondition && broad.length >= SYSTEMIC_MIN_ASSIGNEES;

  return {
    arm: 'COHORT',
    verdict:
      findings.length === 0 ? 'CLEAN' : queueCondition || dispatcherCondition ? 'SYSTEMIC' : 'FINDINGS',
    blind: null,
    subject: queueCondition ? 'QUEUE' : dispatcherCondition ? 'DISPATCHER' : null,
    sinceIso: new Date(sinceMs).toISOString(),
    windowMs,
    graceMs,
    retrospective: Boolean(sinceIso),
    cohortSize: all.length,
    duplicateIds: dupes,
    inWindow: inWindow.length,
    graded: graded.length,
    pending,
    tally,
    findings,
    starvedOpenCount: starvedOpen.length,
    sweptCount: graded.filter((r) => r.state === 'ISSUE_UNDISPATCHED_SWEPT').length,
    cancelledCount: graded.filter((r) => r.state === 'ISSUE_UNDISPATCHED_CANCELLED').length,
    cells: [...cells.values()].sort((a, b) => b.starvedOpen - a.starvedOpen || b.n - a.n),
    roster: roster.sort((a, b) => b.rate - a.rate),
    eligible,
    underpowered,
    unassigned,
    top,
    topRate: top ? top.rate : 0,
    restRate,
    restN,
    restStarved,
    spreadMeasured,
    rateFloor: COHORT_RATE_FLOOR,
    rateMultiple: COHORT_RATE_MULTIPLE,
    minAssigneeN: COHORT_MIN_ASSIGNEE_N,
  };
}

export function renderCohortReport(r, names = {}) {
  const out = [];
  const nm = (id) =>
    id && id !== 'UNASSIGNED' ? names[String(id).slice(0, 8)] || String(id).slice(0, 8) : 'UNASSIGNED';
  const pct = (v) => `${(v * 100).toFixed(1)}%`;

  out.push(`TRA-3535 roster-wide issue dispatch (ALL ORIGINS) — verdict ${r.verdict}`);
  if (r.verdict === 'BLIND') {
    out.push('');
    out.push(`  BLIND — ${r.blind}`);
    for (const b of r.blindRows || []) out.push(`    ${b.identifier || b.id} — ${b.reason}`);
    out.push('  A BLIND run is NOT a pass. Do not read it as "no queue is starved".');
    return out;
  }

  out.push(
    `  window: issues created since ${r.sinceIso} (${(r.windowMs / 3600000).toFixed(0)}h) · ` +
      `board read: ${r.cohortSize} rows · in window: ${r.inWindow} · GRADED: ${r.graded} ` +
      `(${r.pending} inside the ${Math.round(r.graceMs / 60000)} min grace, excluded from the denominator)`,
  );
  if (r.duplicateIds) out.push(`  ⚠ ${r.duplicateIds} duplicate id(s) across pages — the list ordering shifted mid-walk.`);
  out.push(`  states: ${Object.entries(r.tally).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  out.push('');
  out.push('  (assignee x originKind) — starvedOpen is the HEADLINE class; swept/cxl are reported, not rated:');
  out.push(`    ${'assignee'.padEnd(13)}${'originKind'.padEnd(26)}${'n'.padStart(4)}${'starvedOpen'.padStart(13)}${'rate'.padStart(8)}${'swept'.padStart(7)}${'cxl'.padStart(5)}`);
  for (const c of r.cells) {
    out.push(
      `    ${nm(c.assigneeAgentId).padEnd(13)}${String(c.originKind).padEnd(26)}${String(c.n).padStart(4)}` +
        `${String(c.starvedOpen).padStart(13)}${pct(c.n ? c.starvedOpen / c.n : 0).padStart(8)}` +
        `${String(c.swept).padStart(7)}${String(c.cancelled).padStart(5)}`,
    );
  }

  out.push('');
  out.push(`  per-assignee (origins folded — a queue does not care which door an issue came through):`);
  for (const a of r.roster) {
    const tag =
      a.assigneeAgentId === 'UNASSIGNED'
        ? '  <- NOT AN AGENT: undispatched by construction, excluded from the maths'
        : a.n < r.minAssigneeN
          ? `  <- n<${r.minAssigneeN}, underpowered: reported, not eligible to be the subject`
          : '';
    out.push(`    ${nm(a.assigneeAgentId).padEnd(13)} n=${String(a.n).padStart(4)}  starvedOpen=${String(a.starvedOpen).padStart(3)}  rate=${pct(a.rate).padStart(7)}${tag}`);
  }

  if (r.verdict === 'SYSTEMIC' && r.subject === 'QUEUE') {
    out.push('');
    out.push(
      `  QUEUE STARVATION — ${nm(r.top.assigneeAgentId)} holds ${r.top.starvedOpen} never-dispatched OPEN ` +
        `issues of ${r.top.n} created in the window (${pct(r.topRate)}) against a pooled rest of ` +
        `${r.restStarved}/${r.restN} (${pct(r.restRate)}) — a ${(r.restRate ? r.topRate / r.restRate : Infinity).toFixed(1)}x separation.`,
    );
    out.push(
      `  ⭐ MEASURED ACROSS ALL ORIGINS, so the "every other assignee sits near zero" half of the claim is ` +
        'now a measurement and not an assertion — read the per-assignee table above, which is the evidence.',
    );
    out.push(
      `  SUBJECT: THAT AGENT'S QUEUE. The findings concentrate on one assignee ACROSS ORIGINS — manual and ` +
        'routine-spawned alike — so an origin-specific fault is ruled out by the partition, and the ' +
        'dispatcher is NOT the remaining subject. ⛔ Route it to that owner and the board ' +
        '(capacity / re-home / re-assign), NOT to the platform. ⛔ Do not file a ticket per starved issue.',
    );
  } else if (r.verdict === 'SYSTEMIC' && r.subject === 'DISPATCHER') {
    out.push('');
    out.push(
      `  DISPATCH-WIDE — ${r.eligible.filter((a) => a.rate >= r.rateFloor).length} distinct assignees are above the ` +
        `${pct(r.rateFloor)} floor with no single owner explaining it. The DISPATCHER is the remaining subject.`,
    );
    out.push('  ⛔ Confirm the spread is not simply several busy queues at once before routing it.');
  } else if (r.findings.length > 0) {
    out.push('');
    out.push(
      `  ${r.findings.length} never-dispatched row(s) — ${r.starvedOpenCount} OPEN (the headline class), ` +
        `${r.sweptCount} swept closed, ${r.cancelledCount} cancelled. NOT systemic: ` +
        (r.top
          ? `top eligible queue is ${nm(r.top.assigneeAgentId)} at ${pct(r.topRate)} ` +
            `(floor ${pct(r.rateFloor)}, needs >=${r.rateMultiple}x the pooled rest of ${pct(r.restRate)}, ` +
            `and >=${SYSTEMIC_MIN_FINDINGS} starved rows; it has ${r.top.starvedOpen}).`
          : `no assignee cleared the n>=${r.minAssigneeN} floor, so no queue is eligible to be the subject.`),
    );
  } else {
    out.push('');
    out.push(`  CLEAN — all ${r.graded} graded issues across every origin were dispatched to an agent.`);
  }

  if (r.sweptCount > 0 || r.cancelledCount > 0) {
    out.push('');
    out.push(
      `  ⛔ ${r.sweptCount + r.cancelledCount} never-dispatched row(s) are CLOSED (${r.sweptCount} swept / ` +
        `${r.cancelledCount} cancelled) and are PARTITIONED OUT of the rate above. never-checked-out is NOT ` +
        'never-handled — folding them in over-reported the 08-13 headline by ~24% (21 vs the true 17).',
    );
  }

  if (r.underpowered.length > 0) {
    out.push('');
    out.push(
      `  ⛔ ${r.underpowered.length} assignee(s) held fewer than ${r.minAssigneeN} rows and cannot be the ` +
        'subject: a rate over a handful of rows is not a rate. Their rows are still in the denominator of ' +
        'the pooled rest; they just cannot be convicted by it.',
    );
  }
  if (r.unassigned) {
    out.push(
      `  ⛔ ${r.unassigned.starvedOpen} of ${r.unassigned.n} UNASSIGNED row(s) are undispatched — by ` +
        'construction, not by starvation. There is no queue for an unassigned issue to starve in.',
    );
  }
  if (!r.spreadMeasured) {
    out.push('');
    out.push(
      `  ⛔ Fewer than 2 eligible assignees — the cross-assignee SPREAD is unmeasured, so the concentration ` +
        'test is suppressed. A "concentration" over one queue is not a concentration.',
    );
  }

  out.push('');
  out.push(
    `  ⛔⛔ THIS ARM CANNOT BE RUN BACKWARDS. The starved population HEALS: the 08-13 cohort that read 68% ` +
      'live now re-reads 10%, because 15 of those rows were dispatched AFTER the read and `startedAt` ' +
      'records only THAT it happened, never that it was late. Grade the window that is open NOW.',
  );
  if (r.retrospective) {
    out.push(
      '  ⚠ --cohort-since was supplied: this is a RETROSPECTIVE read and it UNDER-REPORTS by construction. ' +
        'Inspect with it; never re-litigate a past verdict with it.',
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const NOW = Date.parse('2026-08-13T10:00:00.000Z');
const H = 3600000;

/** A carrier issue as `GET /api/issues/{id}` serves it. */
function issueRow(id, over = {}) {
  return {
    id,
    identifier: id.toUpperCase(),
    status: 'done',
    priority: 'high',
    assigneeAgentId: 'agent-a',
    createdAt: new Date(NOW - 4 * H).toISOString(),
    startedAt: new Date(NOW - 3.5 * H).toISOString(),
    ...over,
  };
}

function routineRow(id, over = {}) {
  return {
    id,
    title: `routine ${id}`,
    status: 'active',
    assigneeAgentId: 'agent-a',
    triggers: [],
    lastRun: {
      id: `${id}-run`,
      status: 'completed',
      triggeredAt: new Date(NOW - 4 * H).toISOString(),
      completedAt: new Date(NOW - 3 * H).toISOString(),
      linkedIssueId: `${id}-issue`,
      ...(over.lastRun || {}),
    },
    ...(() => {
      const o = { ...over };
      delete o.lastRun;
      return o;
    })(),
  };
}

/** A board with `n` healthy filler rows so a single finding is not systemic. */
function boardOf(rows, filler = 8) {
  const pad = [];
  for (let i = 0; i < filler; i += 1) pad.push(routineRow(`pad-${i}`));
  return [...rows, ...pad];
}

function transportOf(rows, issues = {}) {
  return {
    getRoutines: async () => rows,
    getIssue: async (id) => {
      if (Object.prototype.hasOwnProperty.call(issues, id)) {
        const v = issues[id];
        if (v instanceof Error) throw v;
        return v;
      }
      return issueRow(id);
    },
  };
}

const CASES = [
  {
    name: 'every carrier dispatched => CLEAN',
    rows: boardOf([]),
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`);
      assert(r.graded === 8, `expected 8 graded, got ${r.graded}`);
      assert(r.tally.CARRIER_WORKED === 8, JSON.stringify(r.tally));
    },
  },
  {
    name: 'CARRIER_UNWORKED — open carrier, startedAt null, past grace => finding',
    rows: boardOf([routineRow('r-open', { lastRun: { status: 'issue_created', completedAt: null } })]),
    issues: { 'r-open-issue': issueRow('r-open-issue', { status: 'todo', startedAt: null }) },
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.findings.length === 1, `expected 1 finding, got ${r.findings.length}`);
      assert(r.findings[0].state === 'CARRIER_UNWORKED', r.findings[0].state);
    },
  },
  {
    name:
      '⛔⛔ TRAP 3 — the TRA-3513 row: run `completed`, issue `done`, startedAt STILL NULL => finding, ' +
      'not a pass (run status measures CLOSURE, not execution)',
    rows: boardOf([
      routineRow('r-swept', {
        lastRun: { status: 'completed', completedAt: '2026-08-13T09:32:16.930Z' },
      }),
    ]),
    issues: { 'r-swept-issue': issueRow('r-swept-issue', { status: 'done', startedAt: null }) },
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.findings[0].state === 'CARRIER_SWEPT_UNWORKED', r.findings[0].state);
      assert(r.findings[0].runStatus === 'completed', 'the healthy-looking run status is carried into the report');
      assert(r.sweptCount === 1, `sweptCount=${r.sweptCount}`);
    },
  },
  {
    name:
      '⛔⛔ TRAP 1 — the LIST route payload (id/identifier/priority/status/title/updatedAt, NO startedAt ' +
      'key) => BLIND, never "never dispatched"',
    rows: boardOf([routineRow('r-listshape')]),
    issues: {
      // The exact 6-key payload measured on all 197 live carriers. The positive
      // control CONTAINS the thing it detects: no `startedAt` key at all.
      'r-listshape-issue': {
        id: 'r-listshape-issue',
        identifier: 'TRA-9999',
        priority: 'high',
        status: 'todo',
        title: 'as the list route serves it',
        updatedAt: '2026-08-13T09:00:00.000Z',
      },
    },
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/startedAt/.test(r.blindRows[0].reason), r.blindRows[0].reason);
      assert(r.findings.length === 0, 'a BLIND row must not also be reported as a finding');
    },
  },
  {
    name: 'CARRIER_PENDING — startedAt null but inside the grace window => not yet a finding',
    rows: boardOf([
      routineRow('r-young', {
        lastRun: { status: 'issue_created', triggeredAt: new Date(NOW - 0.5 * H).toISOString(), completedAt: null },
      }),
    ]),
    issues: {
      'r-young-issue': issueRow('r-young-issue', {
        status: 'todo',
        startedAt: null,
        createdAt: new Date(NOW - 0.5 * H).toISOString(),
      }),
    },
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`);
      assert(r.tally.CARRIER_PENDING === 1, JSON.stringify(r.tally));
    },
  },
  {
    name: '⛔ TRAP 4 — an UNDATED carrier ages as infinitely old => finding, never hidden by the grace window',
    rows: boardOf([routineRow('r-undated', { lastRun: { status: 'issue_created', triggeredAt: null, completedAt: null } })]),
    issues: {
      'r-undated-issue': issueRow('r-undated-issue', { status: 'todo', startedAt: null, createdAt: null }),
    },
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.findings[0].state === 'CARRIER_UNWORKED', r.findings[0].state);
      assert(r.findings[0].ageMs === null, 'an undated finding reports a null age, not a fabricated one');
      assert(r.findings[0].recent === true, 'an undated finding must fail towards paging');
    },
  },
  {
    name:
      '⛔⛔ TRAP 2 — an ARCHIVED routine\'s carrier IS graded (163 of 197 live carriers sit on archived ' +
      'routines; a self-archiving deploy one-shot is the urgent case)',
    rows: boardOf([
      routineRow('r-arch', {
        status: 'archived',
        lastRun: { status: 'issue_created', completedAt: null },
      }),
    ]),
    issues: { 'r-arch-issue': issueRow('r-arch-issue', { status: 'todo', startedAt: null }) },
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS, got ${r.verdict}`);
      assert(r.findings.length === 1, `archived routine's carrier must be graded; got ${r.findings.length}`);
      assert(r.findings[0].routineStatus === 'archived', r.findings[0].routineStatus);
      assert(r.graded === 9, `expected 9 graded (archived NOT filtered), got ${r.graded}`);
    },
  },
  {
    name: '⛔ TRAP 5 — a run with NO linkedIssueId is EXCLUDED, not counted as a healthy carrier',
    rows: boardOf([
      routineRow('r-nocarrier', { lastRun: { status: 'failed', linkedIssueId: null, completedAt: null } }),
    ]),
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`);
      assert(r.graded === 8, `excluded row must not be graded; graded=${r.graded}`);
      assert(r.noCarrier === 1, `noCarrier=${r.noCarrier}`);
    },
  },
  {
    name: '⛔ TRAP 6 — zero graded rows => BLIND, never CLEAN',
    rows: [routineRow('r-only', { lastRun: { status: 'failed', linkedIssueId: null, completedAt: null } })],
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/0 of 1 routines/.test(r.blind), r.blind);
    },
  },
  {
    name: 'a row that carries no `lastRun` KEY => BLIND (absent relation, not "never fired")',
    rows: boardOf([
      (() => {
        const x = routineRow('r-nokey');
        delete x.lastRun;
        return x;
      })(),
    ]),
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/lastRun/.test(r.blind), r.blind);
    },
  },
  {
    name: 'a carrier read that THROWS => BLIND for that row, never a silent pass',
    rows: boardOf([routineRow('r-throws')]),
    issues: { 'r-throws-issue': new Error('HTTP 500 on /api/issues/r-throws-issue') },
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/HTTP 500/.test(r.blindRows[0].reason), r.blindRows[0].reason);
    },
  },
  {
    name:
      '⛔⛔ QUEUE STARVATION — 4 findings all on ONE assignee => SYSTEMIC with subject QUEUE, ' +
      'NOT a dispatcher claim (the TRA-3529 misdiagnosis this check exists to prevent)',
    rows: boardOf(
      [0, 1, 2, 3].map((i) =>
        routineRow(`r-q${i}`, {
          assigneeAgentId: 'agent-busy',
          lastRun: { status: 'issue_created', completedAt: null },
        }),
      ),
    ),
    issues: Object.fromEntries(
      [0, 1, 2, 3].map((i) => [
        `r-q${i}-issue`,
        issueRow(`r-q${i}-issue`, { status: 'todo', startedAt: null, assigneeAgentId: 'agent-busy' }),
      ]),
    ),
    expect: (r) => {
      assert(r.verdict === 'SYSTEMIC', `expected SYSTEMIC, got ${r.verdict}`);
      assert(r.subject === 'QUEUE', `expected subject QUEUE, got ${r.subject}`);
      assert(r.topAssignee === 'agent-busy', r.topAssignee);
      assert(r.topShare === 1, `topShare=${r.topShare}`);
      const rep = renderReport(r).join('\n');
      assert(/QUEUE STARVATION/.test(rep), 'the report must name the queue as the subject');
      assert(!/DISPATCH-WIDE/.test(rep), 'it must NOT also assert a dispatcher fault');
    },
  },
  {
    name: 'DISPATCH-WIDE — findings spread across 3 assignees, none dominant => SYSTEMIC subject DISPATCHER',
    rows: boardOf(
      ['a', 'b', 'c'].map((s) =>
        routineRow(`r-w${s}`, {
          assigneeAgentId: `agent-${s}`,
          lastRun: { status: 'issue_created', completedAt: null },
        }),
      ),
    ),
    issues: Object.fromEntries(
      ['a', 'b', 'c'].map((s) => [
        `r-w${s}-issue`,
        issueRow(`r-w${s}-issue`, { status: 'todo', startedAt: null, assigneeAgentId: `agent-${s}` }),
      ]),
    ),
    expect: (r) => {
      assert(r.verdict === 'SYSTEMIC', `expected SYSTEMIC, got ${r.verdict}`);
      assert(r.subject === 'DISPATCHER', `expected subject DISPATCHER, got ${r.subject}`);
      const rep = renderReport(r).join('\n');
      assert(/DISPATCH-WIDE/.test(rep), 'the report must name the dispatcher as the subject');
      assert(!/QUEUE STARVATION/.test(rep), 'it must NOT also assert a queue condition');
    },
  },
  {
    name:
      '⛔ CARRIER_CANCELLED_UNWORKED — a deliberately RETIRED carrier is a finding but NOT evidence for ' +
      'the systemic test (5 of the 18 on the first live run were retirements)',
    rows: boardOf(
      [0, 1, 2, 3].map((i) =>
        routineRow(`r-ret${i}`, {
          status: 'archived',
          assigneeAgentId: 'agent-busy',
          lastRun: { status: 'failed', completedAt: null },
        }),
      ),
    ),
    issues: Object.fromEntries(
      [0, 1, 2, 3].map((i) => [
        `r-ret${i}-issue`,
        issueRow(`r-ret${i}-issue`, { status: 'cancelled', startedAt: null, assigneeAgentId: 'agent-busy' }),
      ]),
    ),
    expect: (r) => {
      // Four abandoned carriers on ONE assignee would be a QUEUE condition if
      // they were starved. They were retired, so the verdict must NOT escalate.
      assert(r.verdict === 'FINDINGS', `expected FINDINGS (never SYSTEMIC), got ${r.verdict}`);
      assert(r.subject === null, `expected no systemic subject, got ${r.subject}`);
      assert(r.cancelledCount === 4, `cancelledCount=${r.cancelledCount}`);
      assert(r.recentCount === 0, `retirements must not count toward the systemic test; recentCount=${r.recentCount}`);
      assert(r.residueOnly === false, 'they are recent, so this is not residue — only the SUBJECT is excluded');
      const rep = renderReport(r).join('\n');
      assert(/DELIBERATE RETIREMENT/.test(rep), rep);
      assert(!/QUEUE STARVATION/.test(rep), 'a pile of retirements must not manufacture a queue verdict');
    },
  },
  {
    name: 'RESIDUE ONLY — every finding predates the recency window => stays exit 1, never re-escalated',
    rows: boardOf(
      [0, 1, 2, 3].map((i) =>
        routineRow(`r-old${i}`, {
          assigneeAgentId: 'agent-busy',
          lastRun: { status: 'issue_created', completedAt: null },
        }),
      ),
    ),
    issues: Object.fromEntries(
      [0, 1, 2, 3].map((i) => [
        `r-old${i}-issue`,
        issueRow(`r-old${i}-issue`, {
          status: 'todo',
          startedAt: null,
          assigneeAgentId: 'agent-busy',
          createdAt: new Date(NOW - 100 * H).toISOString(),
        }),
      ]),
    ),
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `expected FINDINGS (not SYSTEMIC), got ${r.verdict}`);
      assert(r.residueOnly === true, 'residueOnly must be set');
      assert(r.recentCount === 0, `recentCount=${r.recentCount}`);
      const rep = renderReport(r).join('\n');
      assert(/RESIDUE ONLY/.test(rep), rep);
      assert(/still not CLEAN/.test(rep), 'residue must not be laundered into a pass');
    },
  },
];

/* ------------------------------------------------------------------ *
 * COHORT ARM controls — BOTH DIRECTIONS on every invocation.
 *
 * ⭐ The ruling's `Control` clause is the reason these are paired: "a
 * concentration detector that has only ever been shown firing cannot
 * distinguish a starved queue from a busy one." So every firing control here has
 * a NEAR-MISS twin built from the SAME generator, differing only in the variable
 * under test — and the calibration twin (`known-good` below) is built from the
 * REAL MEASURED SPREAD of 2026-08-13, not from zero.
 * ------------------------------------------------------------------ */

/** An issue row as the issues LIST route serves it (full row, never compact). */
function cohortIssue(id, over = {}) {
  return {
    id,
    identifier: String(id).toUpperCase(),
    title: `issue ${id}`,
    status: 'todo',
    priority: 'medium',
    assigneeAgentId: 'agent-a',
    originKind: 'manual',
    createdAt: new Date(NOW - 6 * H).toISOString(),
    startedAt: new Date(NOW - 5 * H).toISOString(),
    executionLockedAt: null,
    checkoutRunId: null,
    executionRunId: null,
    ...over,
  };
}

/**
 * Build `n` rows for one (assignee, origin) cell, `starved` of them never
 * dispatched. Both the firing and the silent control come out of this one
 * generator, so the only thing that differs between them is the RATE.
 */
function cell(assignee, originKind, n, starved, over = {}) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const bad = i < starved;
    rows.push(
      cohortIssue(`${assignee}-${originKind}-${i}`, {
        assigneeAgentId: assignee,
        originKind,
        ...(bad ? { startedAt: null, executionLockedAt: null, checkoutRunId: null, executionRunId: null } : {}),
        ...over,
      }),
    );
  }
  return rows;
}

function cohortTransport(rows, { pageSize = 200, fail = null } = {}) {
  return {
    getIssues: async ({ limit, offset }) => {
      if (fail) throw fail;
      const size = Math.min(limit, pageSize);
      return rows.slice(offset, offset + size);
    },
  };
}

/**
 * THE MEASURED 2026-08-13 SPREAD, reconstructed from the TRA-3532 ruling's own
 * table with correction 2 applied (CTO is 18%, NOT ~0%).
 *   LeadDev  manual 25 / 17 starved · routine 8 / 5 starved  => 22/33 = 67%
 *   CTO      manual 17 /  3 starved · routine 3 / 0          =>  3/20 = 15%
 *   others   all origins 18 / 1                              =>  1/18 =  6%
 */
const SPREAD_0813 = [
  ...cell('leaddev', 'manual', 25, 17),
  ...cell('leaddev', 'routine_execution', 8, 5),
  ...cell('cto', 'manual', 17, 3),
  ...cell('cto', 'routine_execution', 3, 0),
  ...cell('cfo', 'manual', 10, 1),
  ...cell('quant', 'manual', 8, 0),
];

const COHORT_CASES = [
  {
    name: 'KNOWN-BAD (the 08-13 cohort, all origins) => SYSTEMIC/QUEUE, and the MANUAL slice is IN it',
    rows: SPREAD_0813,
    expect: (r) => {
      assert(r.verdict === 'SYSTEMIC', `expected SYSTEMIC, got ${r.verdict} (${r.blind || ''})`);
      assert(r.subject === 'QUEUE', `expected QUEUE, got ${r.subject}`);
      assert(r.top.assigneeAgentId === 'leaddev', `top=${r.top.assigneeAgentId}`);
      assert(r.top.starvedOpen === 22, `expected 22 starved-open, got ${r.top.starvedOpen}`);
      // ⭐ THE WHOLE POINT OF TRA-3535: the manual slice is instrumented, so the
      // 17 rows that were hand-counted twice are now MEASURED.
      const man = r.cells.find((c) => c.assigneeAgentId === 'leaddev' && c.originKind === 'manual');
      assert(man && man.starvedOpen === 17, `manual cell must carry the 17 hand-counted rows, got ${man && man.starvedOpen}`);
      const rep = renderCohortReport(r).join('\n');
      assert(/QUEUE STARVATION/.test(rep), rep);
      assert(/NOT to the platform/.test(rep), 'must keep routing it away from the dispatcher');
      assert(/Do not file a ticket per starved issue/.test(rep), 'must keep the no-ticket-per-row rule');
    },
  },
  {
    name:
      'KNOWN-GOOD (a BUSY board at the measured live spread, top 8.3%) => must stay SILENT — ' +
      'the control the ruling asked for: a busy queue is not a starved one',
    rows: [
      ...cell('leaddev', 'manual', 30, 2),
      ...cell('leaddev', 'routine_execution', 12, 1),
      ...cell('cto', 'manual', 24, 2),
      ...cell('cfo', 'manual', 12, 1),
      ...cell('quant', 'manual', 10, 0),
    ],
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `a busy board must NOT be SYSTEMIC, got ${r.verdict}`);
      assert(r.subject === null, `subject must be null, got ${r.subject}`);
      assert(r.starvedOpenCount === 6, `expected 6 starved-open, got ${r.starvedOpenCount}`);
    },
  },
  {
    name:
      '⛔⛔ CALIBRATION (TRA-3535 correction 2) — CTO alone at the REAL 18%, not the asserted ~0%, ' +
      'must NOT fire. A threshold calibrated on zero convicts this board next week.',
    rows: [
      ...cell('cto', 'manual', 17, 3),
      ...cell('leaddev', 'manual', 20, 0),
      ...cell('cfo', 'manual', 10, 0),
    ],
    expect: (r) => {
      assert(r.verdict !== 'SYSTEMIC', `18% must not be systemic, got ${r.verdict}/${r.subject}`);
      assert(Math.abs(r.top.rate - 3 / 17) < 1e-9, `top rate should be 3/17, got ${r.top.rate}`);
      assert(r.top.rate < r.rateFloor, `3/17=${r.top.rate} must sit BELOW the ${r.rateFloor} floor`);
    },
  },
  {
    name:
      '⛔ CALIBRATION, other side — a HIGH rate over a small pooled rest must still clear the MULTIPLE, ' +
      'not just the floor (floor alone convicts a board having a bad week)',
    rows: [
      ...cell('leaddev', 'manual', 20, 8), // 40% — clears the floor
      ...cell('cto', 'manual', 20, 7), // 35% — the rest is just as bad
      ...cell('cfo', 'manual', 20, 7),
    ],
    expect: (r) => {
      assert(r.top.rate >= r.rateFloor, 'top must clear the floor for this control to mean anything');
      assert(r.verdict === 'SYSTEMIC', `expected SYSTEMIC, got ${r.verdict}`);
      // Nobody is concentrated — the board as a whole is starving, so the
      // subject must flip to DISPATCHER rather than convict the top queue.
      assert(r.subject === 'DISPATCHER', `expected DISPATCHER (no concentration), got ${r.subject}`);
    },
  },
  {
    name:
      '⛔⛔ CORRECTION 1 — closed-without-dispatch is PARTITIONED OUT of the headline ' +
      '(never-checked-out is not never-handled)',
    rows: [
      ...cell('leaddev', 'manual', 8, 8, { status: 'done' }),
      ...cell('leaddev', 'routine_execution', 4, 4, { status: 'cancelled' }),
      ...cell('cto', 'manual', 20, 0),
      ...cell('cfo', 'manual', 10, 0),
    ],
    expect: (r) => {
      assert(r.starvedOpenCount === 0, `headline must be 0, got ${r.starvedOpenCount}`);
      assert(r.sweptCount === 8, `expected 8 swept, got ${r.sweptCount}`);
      assert(r.cancelledCount === 4, `expected 4 cancelled, got ${r.cancelledCount}`);
      assert(r.verdict === 'FINDINGS', `must still REPORT them, got ${r.verdict}`);
      assert(r.verdict !== 'SYSTEMIC', 'closed rows must never drive the systemic test');
      assert(r.top.rate === 0, `leaddev rate must be 0 on the headline class, got ${r.top.rate}`);
      const rep = renderCohortReport(r).join('\n');
      assert(/PARTITIONED OUT/.test(rep), rep);
    },
  },
  {
    name: '⛔ TRAP 1 at cohort level — a row missing the `startedAt` KEY is BLIND, never "never dispatched"',
    rows: (() => {
      const rows = [...cell('cto', 'manual', 10, 0)];
      const bad = { ...cohortIssue('compact-row') };
      delete bad.startedAt; // exactly what ?view=compact does
      rows.push(bad);
      return rows;
    })(),
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/startedAt/.test(r.blindRows[0].reason), r.blindRows[0].reason);
    },
  },
  {
    name: '⛔ an absent `originKind` KEY is BLIND — this arm partitions BY origin',
    rows: (() => {
      const rows = [...cell('cto', 'manual', 10, 0)];
      const bad = { ...cohortIssue('no-origin') };
      delete bad.originKind;
      rows.push(bad);
      return rows;
    })(),
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/originKind/.test(r.blindRows[0].reason), r.blindRows[0].reason);
    },
  },
  {
    name:
      '⛔ a row inside GRACE is a dispatch in flight — excluded from the denominator, ' +
      'NOT counted as a healthy row (counting it dilutes the rate toward CLEAN)',
    rows: [
      ...cell('leaddev', 'manual', 10, 10, { createdAt: new Date(NOW - 10 * 60000).toISOString() }),
      ...cell('cto', 'manual', 10, 0),
    ],
    expect: (r) => {
      assert(r.pending === 10, `expected 10 pending, got ${r.pending}`);
      assert(r.graded === 10, `graded must exclude the in-flight rows, got ${r.graded}`);
      assert(r.verdict === 'CLEAN', `expected CLEAN, got ${r.verdict}`);
      assert(r.roster.every((a) => a.assigneeAgentId !== 'leaddev'), 'in-flight rows must not enter the roster');
    },
  },
  {
    name: '⛔ TRAP 6 — zero gradeable rows in the window is BLIND, never CLEAN (the live 24h reading)',
    // ⛔ ORDERING: `starved` must be 6, not 0. A row created 5 min ago that IS
    // dispatched is a GRADED row, not a pending one — the grace window only
    // applies to a row with nothing set, because grace exists to excuse a
    // dispatch still in flight, not to un-read one that already landed. A
    // fixture of dispatched-inside-grace rows reads CLEAN, correctly.
    rows: cell('cto', 'manual', 6, 6, { createdAt: new Date(NOW - 5 * 60000).toISOString() }),
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/same reading/.test(r.blind), r.blind);
    },
  },
  {
    name: '⛔ UNASSIGNED sits at 100% BY CONSTRUCTION and must never become the subject',
    rows: [
      ...cell('cto', 'manual', 20, 0),
      ...cell('cfo', 'manual', 10, 0),
      ...cohortIssueBatch(6),
    ],
    expect: (r) => {
      assert(r.unassigned && r.unassigned.starvedOpen === 6, JSON.stringify(r.unassigned));
      assert(r.verdict !== 'SYSTEMIC', `UNASSIGNED must not drive SYSTEMIC, got ${r.verdict}`);
      assert(r.top.assigneeAgentId !== 'UNASSIGNED', `top must not be UNASSIGNED, got ${r.top.assigneeAgentId}`);
      const rep = renderCohortReport(r).join('\n');
      assert(/NOT AN AGENT/.test(rep), rep);
    },
  },
  {
    name: '⛔ an UNDERPOWERED queue (the live CFO 1-of-4 = 25%) cannot be convicted by a rate',
    rows: [
      ...cell('cfo', 'manual', 4, 1),
      ...cell('cto', 'manual', 20, 1),
      ...cell('leaddev', 'manual', 20, 0),
    ],
    expect: (r) => {
      assert(r.verdict !== 'SYSTEMIC', `n=4 must not be convicted, got ${r.verdict}`);
      assert(r.underpowered.some((a) => a.assigneeAgentId === 'cfo'), JSON.stringify(r.underpowered));
      assert(r.top.assigneeAgentId !== 'cfo', `cfo must not be eligible, got ${r.top.assigneeAgentId}`);
    },
  },
  {
    name: '⛔ a TRUNCATED enumeration is BLIND — an incomplete population cannot clear anybody',
    rows: cell('cto', 'manual', 60, 0),
    opts: { issuePage: 10, issuePageCap: 2 },
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/page cap/.test(r.blind), r.blind);
    },
  },
  {
    name: '⛔ a failed enumeration is BLIND, not CLEAN',
    rows: [],
    transportOpts: { fail: new Error('HTTP 503') },
    expect: (r) => {
      assert(r.verdict === 'BLIND', `expected BLIND, got ${r.verdict}`);
      assert(/503/.test(r.blind), r.blind);
    },
  },
  {
    name:
      '⛔ fewer than 2 eligible assignees => the SPREAD is unmeasured and concentration is SUPPRESSED ' +
      '(a "concentration" over one queue is not a concentration)',
    rows: cell('leaddev', 'manual', 20, 15),
    expect: (r) => {
      assert(r.spreadMeasured === false, 'spread must read unmeasured');
      assert(r.verdict !== 'SYSTEMIC', `must not convict on a single-queue board, got ${r.verdict}`);
      const rep = renderCohortReport(r).join('\n');
      assert(/SPREAD is unmeasured/.test(rep), rep);
    },
  },
];

/** `n` unassigned rows, never dispatched — undispatched by construction. */
function cohortIssueBatch(n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(
      cohortIssue(`unassigned-${i}`, {
        assigneeAgentId: null,
        startedAt: null,
        executionLockedAt: null,
        checkoutRunId: null,
        executionRunId: null,
      }),
    );
  }
  return rows;
}

async function selftest() {
  let pass = 0;
  const seen = new Set();
  for (const c of CASES) {
    try {
      const r = await sweep(transportOf(c.rows, c.issues || {}), { nowMs: NOW });
      seen.add(r.verdict);
      c.expect(r);
      console.log(`ok    ${c.name}`);
      pass += 1;
    } catch (err) {
      console.log(`FAIL  ${c.name}\n        ${err.message}`);
    }
  }

  console.log('');
  console.log('-- COHORT ARM (TRA-3535) — roster-wide, all origins --');
  const cohortSeen = new Set();
  for (const c of COHORT_CASES) {
    try {
      const r = await sweepCohort(cohortTransport(c.rows, c.transportOpts || {}), {
        nowMs: NOW,
        cohortWindowMs: 72 * H,
        ...(c.opts || {}),
      });
      cohortSeen.add(r.verdict);
      c.expect(r);
      console.log(`ok    ${c.name}`);
      pass += 1;
    } catch (err) {
      console.log(`FAIL  ${c.name}\n        ${err.message}`);
    }
  }

  // ⭐ THE PAIRING IS ITSELF A CONTROL. If the cohort arm ever reaches only one
  // of SYSTEMIC / CLEAN-or-FINDINGS, it has not been shown to DISCRIMINATE — it
  // has only been shown firing, which is the exact failure the ruling named.
  try {
    assert(cohortSeen.has('SYSTEMIC'), 'no cohort control ever reached SYSTEMIC — the detector is unproven firing');
    assert(
      cohortSeen.has('CLEAN') || cohortSeen.has('FINDINGS'),
      'no cohort control ever stayed SILENT — a detector shown only firing cannot tell a starved queue from a busy one',
    );
    assert(cohortSeen.has('BLIND'), 'no cohort control ever reached BLIND — the unreadable population is ungraded');
    console.log('ok    GLOBAL — the cohort arm was proven in BOTH directions (fires AND stays silent)');
    pass += 1;
  } catch (err) {
    console.log(`FAIL  GLOBAL both-directions control\n        ${err.message}`);
  }

  // GLOBAL — this script must never write. A detector that can mutate the board
  // it grades is one bad predicate away from being the incident.
  try {
    const src = await (await import('node:fs/promises')).readFile(new URL(import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function sweep'));
    assert(
      !/\b(method\s*:\s*['"`](POST|PATCH|PUT|DELETE)|fetch\([^)]*method)/i.test(body),
      'a mutating HTTP verb appears in the sweep path',
    );
    console.log('ok    GLOBAL — the sweep path performs no writes');
    pass += 1;
  } catch (err) {
    console.log(`FAIL  GLOBAL read-only control\n        ${err.message}`);
  }

  const total = CASES.length + COHORT_CASES.length + 2;
  console.log('');
  console.log(`${pass}/${total} controls pass`);
  console.log(`  routine arm verdicts reachable: ${[...seen].sort().join(', ')}`);
  console.log(`  cohort  arm verdicts reachable: ${[...cohortSeen].sort().join(', ')}`);
  for (const v of ['CLEAN', 'FINDINGS', 'SYSTEMIC', 'BLIND']) {
    if (!seen.has(v)) console.log(`WARN  routine-arm verdict ${v} was never reached by any control`);
    if (!cohortSeen.has(v)) console.log(`WARN  cohort-arm verdict ${v} was never reached by any control`);
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
    // ⛔ TRAP 1 — the SINGLE-ISSUE route, never `lastRun.linkedIssue`. That
    // embedded object serves six keys and `startedAt` is not among them.
    getIssue: async (id) => get(`${BASE}/api/issues/${id}`),
    // ⛔⛔ THE FULL ROW, NEVER `?view=compact`. Verified 2026-09-22 against the
    // single-issue GET on TRA-3535: the full list row's `startedAt`,
    // `originKind`, `executionLockedAt`, `checkoutRunId` and `executionRunId`
    // are IDENTICAL to the single GET, so this arm needs no fan-out. `compact`
    // nulls fields the full GET has, which would brand the whole board starved.
    getIssues: async ({ limit, offset }) =>
      unwrap(await get(`${BASE}/api/companies/${CO}/issues?limit=${limit}&offset=${offset}`), 'issues'),
  };
}

async function main() {
  if (argv.includes('--selftest')) return selftest();

  const transport = liveTransport();
  // routine | cohort | both. Default `both`: the routine arm reports QUEUE
  // STARVATION, and after TRA-3535 the evidence for that claim lives in the
  // cohort arm. Running one without the other is how the number got
  // hand-counted twice.
  const arm = String(argOf('arm', 'both'));
  const runRoutine = arm === 'both' || arm === 'routine';
  const runCohort = arm === 'both' || arm === 'cohort';

  const result = runRoutine
    ? await sweep(transport, { routineLimit: ROUTINE_LIMIT })
    : { verdict: 'CLEAN', findings: [], graded: 0, skipped: true };
  const cohort = runCohort ? await sweepCohort(transport) : null;

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
          issue: 'TRA-3529',
          checkedAt: new Date().toISOString(),
          verdict: result.verdict,
          subject: result.subject,
          blind: result.blind,
          routineCount: result.routineCount,
          graded: result.graded,
          noCarrier: result.noCarrier,
          tally: result.tally,
          byAssignee: result.byAssignee,
          topAssignee: result.topAssignee,
          topShare: result.topShare,
          recentCount: result.recentCount,
          recentAllCount: result.recentAllCount,
          unworkedOpenCount: result.unworkedOpenCount,
          sweptCount: result.sweptCount,
          cancelledCount: result.cancelledCount,
          residueOnly: result.residueOnly,
          graceMs: result.graceMs,
          recentWindowMs: result.recentWindowMs,
          newestFindingAgeMs: result.newestFindingAgeMs,
          historyUnread: result.historyUnread,
          findings: result.findings,
          blindRows: result.blindRows,
          cohort,
        },
        null,
        2,
      ),
    );
  } else {
    if (runRoutine) for (const l of renderReport(result, names)) console.log(l);
    if (runCohort) {
      if (runRoutine) console.log('');
      for (const l of renderCohortReport(cohort, names)) console.log(l);
    }
  }

  // ⛔ THE WORST ARM WINS, and BLIND outranks everything including a zero count.
  // Folding two arms into one exit code by taking the better of them would let a
  // CLEAN routine slice launder a starved manual slice — which is the exact
  // blind spot TRA-3535 exists to close.
  const codes = [];
  if (runRoutine) codes.push(VERDICT_EXIT[result.verdict] ?? 3);
  if (runCohort) codes.push(VERDICT_EXIT[cohort.verdict] ?? 3);
  if (codes.includes(VERDICT_EXIT.BLIND)) return VERDICT_EXIT.BLIND;
  return Math.max(...codes, 0);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('ERROR', err?.stack || err);
    process.exit(3);
  });
