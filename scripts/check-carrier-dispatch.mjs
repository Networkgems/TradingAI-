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

  const total = CASES.length + 1;
  console.log('');
  console.log(`${pass}/${total} controls pass; verdicts reachable: ${[...seen].sort().join(', ')}`);
  for (const v of ['CLEAN', 'FINDINGS', 'SYSTEMIC', 'BLIND']) {
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
    // ⛔ TRAP 1 — the SINGLE-ISSUE route, never `lastRun.linkedIssue`. That
    // embedded object serves six keys and `startedAt` is not among them.
    getIssue: async (id) => get(`${BASE}/api/issues/${id}`),
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
