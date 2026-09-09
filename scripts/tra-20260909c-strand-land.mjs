#!/usr/bin/env node
// Stage-and-land: repair the FIVE stranded rows on the CTO seat, measured 2026-09-09T16:2xZ.
//
// WHY THIS EXISTS. That beat was an `on_demand` board wake (`invocationSource: on_demand`,
// `triggerDetail: manual`, `contextSnapshot.issueId` absent), so every issue write 403s
// `cross_issue_influence_run_context_required`. Measured once this beat, via the real payload of
// the sibling script `tra-20260909b-land.mjs` -- that is the FIFTH independent measurement of this
// boundary. The `X-Paperclip-Run-Id` header the 403 body recommends is a KNOWN TRAP; do not spend
// a probe on it.
//
// The MEASUREMENT is complete and is not deferred -- only the write is. Unlike the AC5 tape in the
// sibling script, this measurement is NOT perishable: it reads issue rows, which are durable
// (class B). Re-running this script therefore re-reads nothing and asserts nothing about "now" --
// it lands the dispositions decided at 16:2xZ on 2026-09-09. If a row has moved on its own since,
// the per-row marker guard skips it, and a moved row is a good outcome, not a conflict.
//
// RUN THIS FROM THE NEXT ISSUE-BOUND WAKE (any heartbeat whose run carries contextSnapshot.issueId).
//
// ---------------------------------------------------------------------------------------------
// WHAT WAS MEASURED. 15 open rows on the CTO seat. Six were stranded, in three distinct shapes:
//
//   shape 1 -- `blocked` with an EMPTY `blockedBy`. This is the strand condition itself, named in
//              AGENTS.md and CLAUDE.md. All three also already carry an `activeRecoveryAction`,
//              i.e. the platform's recovery machinery is raising against them every heartbeat.
//                TRA-4356, TRA-4358, TRA-4433
//              TRA-4358 and TRA-4433 did not get there by anyone's decision: their newest comment
//              is Paperclip's own terminal-run-recovery text ("still has no live execution path.
//              Moving it to `blocked` so it is visible for intervention"). That is the platform
//              parking a row, not a first-class blocker. `todo` is the sanctioned rest for a row
//              with no live continuation that must stay assigned (TRA-3058).
//
//   shape 2 -- `in_review` with NO monitor, NO interaction and no typed reviewer. Nothing will
//              ever wake these; both `blocks` a downstream row, so they are not merely idle, they
//              are holding other work down.
//                TRA-2685 (blocks TRA-2038:backlog), TRA-4094 (blocks TRA-4084:blocked)
//
//   shape 3 -- `in_review` with a SPENT monitor (`monitorNextCheckAt == null` &&
//              `executionState.monitor.status == "triggered"`).
//                TRA-4357 -- owned by the sibling script tra-20260909b-land.mjs, NOT this one.
//
// ⚠️ CORRECTS A PRIOR MEASUREMENT. The memory note "CTO in_review queue is board-blocked, not
// stranded -- 18/18 carry a pending interaction" was true when written and is NOT true now:
// TRA-2685 and TRA-4094 both return `interactions: []`. The rule it encodes -- GET /interactions
// before calling an in_review row a strand -- is still right, and is exactly how these two were
// separated from the board-blocked population. It was applied here; they failed it.
//
// ---------------------------------------------------------------------------------------------
// WRITE BUDGET. The cross-issue cap is 20 writes per run and a status+comment PATCH spends 2.
// Five rows = 10. The sibling AC5 script spends 2 more. 12 of 20 if both run in the same
// heartbeat, which is intended and safe. Rows are ordered most-consequential first so that a cap
// hit (or a 409) truncates the tail rather than the head.

// TRA-4440 — the repo-root derivation (and the `node:fs`/`node:path`/`node:url` imports
// that fed it) is gone: nothing in this script reads a file. Every row below is built
// inline and posted over the API, so the seat-dependent $PAPERCLIP_WORKSPACE_CWD hazard
// the old comment warned about cannot arise here.

const BASE = (process.env.PAPERCLIP_API_URL || '').replace(/\/$/, '').replace(/\/api$/, '');
const KEY = process.env.PAPERCLIP_API_KEY;
if (!BASE || !KEY) {
  console.error('[strand-land] PAPERCLIP_API_URL / PAPERCLIP_API_KEY missing');
  process.exit(3);
}
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// Server-side cap on `executionPolicy.monitor.notes` is 500 (zod `too_big`, measured 2026-09-09
// when an 850-char note came back HTTP 400 while its neighbours came back 403). Checked BEFORE any
// network call, because the failure is order-dependent and therefore easy to never see.
const MONITOR_NOTES_MAX = 500;

// ASCII ONLY in every body and note below. Em-dashes and arrows mojibake through the Windows
// shell on this seat, and issue comments are append-only -- a mangled one cannot be edited out.

const ROWS = [
  {
    key: 'TRA-4433',
    id: 'b4fdafb9-f5b0-4a68-8d55-bd6f90fea8e9',
    // Head of the list: it is the newest strand (parked 2026-09-09T14:24Z, same day) AND its
    // subject is monitor co-arming, so leaving it stranded is self-referentially bad.
    status: 'todo',
    marker: 'Re-dispositioned todo: parked by terminal-run recovery, not by a blocker',
    body: [
      'Re-dispositioned todo: parked by terminal-run recovery, not by a blocker.',
      '',
      'Measured on the CTO seat 2026-09-09T16:2xZ, as part of a sweep of all 15 open rows.',
      '',
      'State found: `status: blocked`, `blockedBy: []`, `blocks: []`, `interactions: 0`, and a live',
      '`activeRecoveryAction` (e1738759). The newest comment on the row is the platform\'s own text:',
      '"Paperclip automatically retried continuation for this assigned `in_progress` issue during',
      'terminal run recovery, but it still has no live execution path. Moving it to `blocked` so it',
      'is visible for intervention."',
      '',
      'So nobody decided this was blocked. The platform parked it because its run died, and the',
      'park landed on `blocked` with an empty `blockedBy` -- which is the strand condition itself',
      '(AGENTS.md; TRA-3058, TRA-4060). A row in that state reads as legitimately waiting to every',
      'status query while being owned by nobody, and it raises a recovery action against the CFO',
      'queue every heartbeat until a human re-dispositions it by hand.',
      '',
      '`todo`, still assigned to CTO, is the sanctioned rest for a row that has real work left and',
      'no live continuation path. The work itself is unchanged and is stated in the description:',
      'the TRA-4432 re-arm co-armed 10 monitors on one instant, and that needs unpicking.',
    ].join('\n'),
  },
  {
    key: 'TRA-4094',
    id: 'e0694880-54f1-45f6-82c5-66c2e1cbdb9e',
    // Second: it is holding TRA-4084 in `blocked`, so its inertness propagates.
    status: 'in_review',
    marker: 'Monitor armed: this row had no wake path at all and is holding TRA-4084 down',
    nextCheckAt: '2026-09-11T15:00:00.000Z',
    notes: [
      'Durable-fix row for TRA-4084, silent since 2026-08-27 and holding TRA-4084 in blocked.',
      'At this check: either land the write-side cap (the read-side hole is already located --',
      'buildPaperclipTaskMarkdown, two sites, in the serving build) and close both rows, or',
      'hand it to a named reviewer. Do not re-arm a third time without changing something.',
    ].join(' '),
    body: [
      'Monitor armed: this row had no wake path at all and is holding TRA-4084 down.',
      '',
      'Measured on the CTO seat 2026-09-09T16:2xZ, as part of a sweep of all 15 open rows.',
      '',
      'State found: `status: in_review`, `monitorNextCheckAt: null`, no `executionState.monitor` at',
      'all, `interactions: 0`, `blockedBy: []`, and `blocks: [TRA-4084:blocked]`. Last activity was',
      '2026-08-27T14:07Z -- 13 days.',
      '',
      'The check that matters here is the interactions read, because the CTO in_review queue has',
      'historically been board-blocked rather than stranded (18/18 carried a pending interaction',
      'when that was last measured). This row does NOT: the list comes back empty. So there is no',
      'reviewer, no card, and no monitor -- nothing that can ever wake it -- and it is the blocker',
      'on TRA-4084, which is itself sitting in `blocked` waiting for it.',
      '',
      'Resting it in a monitor rather than flipping it to `todo` because the substantive work is',
      'reported done and the open question is a review/land decision, not implementation. The',
      'read-side hole was already located in the SERVING build (`@paperclipai/server@2026.824.1`,',
      '`dist/services/heartbeat.js`): `buildPaperclipTaskMarkdown`, two unbounded sites. The inline',
      'wake payload was already bounded (8 comments / 4,000 chars / 12,000 total).',
      '',
      'Monitor set for 2026-09-11T15:00Z. The note on it names the exit condition: land the',
      'write-side cap and close both rows, or hand it to a named reviewer -- and do not re-arm a',
      'third time without changing something, which is how a monitor turns into a loop.',
    ].join('\n'),
  },
  {
    key: 'TRA-4356',
    id: '085e2c0d-0fcc-46fa-8dfa-815df269a40e',
    status: 'todo',
    marker: 'Re-dispositioned todo: blocked with an empty blockedBy is the strand condition',
    body: [
      'Re-dispositioned todo: blocked with an empty blockedBy is the strand condition.',
      '',
      'Measured on the CTO seat 2026-09-09T16:2xZ, as part of a sweep of all 15 open rows.',
      '',
      'State found: `status: blocked`, `blockedBy: []`, `blocks: []`, `interactions: 0`, and a live',
      '`activeRecoveryAction` (38ad9f77). Last activity 2026-09-08T13:13Z.',
      '',
      'There is no first-class blocker on this row and no named unblock owner, so `blocked` is the',
      'wrong rest and is actively harmful: it is indistinguishable from a legitimate wait to every',
      'status query, and it raises a recovery action every heartbeat. A gate with real work left and',
      'no live continuation rests `todo` and stays assigned (TRA-3058).',
      '',
      'The work is NOT blocked on anyone. QADesigner\'s carry from TRA-4141 (2026-09-08) confirmed',
      'independently that the remedy -- `PATCH /api/routine-triggers/{id}` with the cron the trigger',
      'already has, forcing re-derivation of `nextRunAt` -- is fire-free, which was the property',
      'that actually mattered, since several of the dead cohort are window-scoped (class A) reads',
      'that a spurious fire would have corrupted. So the repair is cleared to run.',
      '',
      'Two constraints carried forward for whoever picks this up, both already measured:',
      '  1. `PATCH /api/routine-triggers/{id}` is ASSIGNEE-SCOPED. These are LeadDev-seat triggers,',
      '     so the CTO seat will 403 on them. Reassignment is operator-only. Route via',
      '     request_board_approval rather than bouncing the ticket between agents.',
      '  2. Re-arming the clock does NOT prove liveness. A `todo`/non-terminal leaf disables its own',
      '     routine under coalesce_if_active while `nextRunAt` keeps advancing, so check leaf',
      '     terminality too, and verify in the trigger\'s OWN timezone field -- it is not always ET.',
    ].join('\n'),
  },
  {
    key: 'TRA-4358',
    id: '7452d97c-a3b0-46bf-b729-bf9c5709d10b',
    status: 'todo',
    marker: 'Re-dispositioned todo: parked by terminal-run recovery on 2026-09-04',
    body: [
      'Re-dispositioned todo: parked by terminal-run recovery on 2026-09-04, not by a blocker.',
      '',
      'Measured on the CTO seat 2026-09-09T16:2xZ, as part of a sweep of all 15 open rows.',
      '',
      'State found: `status: blocked`, `blockedBy: []`, `blocks: []`, `interactions: 0`, and a live',
      '`activeRecoveryAction` (e3a487b2). The only comment on the row is the platform\'s own',
      'terminal-run-recovery text; the row has been inert for 5 days.',
      '',
      'Same shape as TRA-4433: the platform parked a dead run onto `blocked`, and `blocked` with an',
      'empty `blockedBy` is the strand condition, not a wait. `todo` and still assigned.',
      '',
      'The underlying defect is unchanged and is worth restating because it is a correctness bug in',
      'a published artifact, not housekeeping: the TRA-4248.1 trades export omits 5 of 32 live',
      'journal rows, and the omission is not random -- it lands on both of the most consequential',
      'rows. Any number computed off that export is wrong until this is fixed.',
    ].join('\n'),
  },
  {
    key: 'TRA-2685',
    id: '63ac5cd6-8a4c-47fd-8578-be8417ad35fa',
    // Last: it is a genuine external wait with a named owner, so it is the least urgent of the
    // five -- it only needs a wake path, not a decision.
    status: 'in_review',
    marker: 'Monitor armed: correct external wait, but nothing was going to wake it',
    nextCheckAt: '2026-09-16T14:00:00.000Z',
    notes: [
      'Waiting on the operator to pay the GitHub Actions bill (board ruling via TRA-4426,',
      'interaction 9029c021, answered 2026-09-09T13:44Z). No agent action until payment lands.',
      'At this check: probe whether Actions has started ANY job since 2026-07-26. If yes, unblock',
      'and release TRA-2038. If no, re-arm and say so on the row -- do not let it go silent again.',
    ].join(' '),
    body: [
      'Monitor armed: correct external wait, but nothing was going to wake it.',
      '',
      'Measured on the CTO seat 2026-09-09T16:2xZ, as part of a sweep of all 15 open rows.',
      '',
      'State found: `status: in_review`, `monitorNextCheckAt: null`, no `executionState.monitor`,',
      '`interactions: 0`, `blocks: [TRA-2038:backlog]`.',
      '',
      'The DISPOSITION here is right and is not being changed. The board ruled via TRA-4426',
      '(interaction 9029c021, answered 2026-09-09T13:44Z) that the operator will fix the GitHub',
      'Actions billing themselves; the card stays open on the operator and no agent acts until',
      'payment lands. That is a real external wait with a named owner.',
      '',
      'What was missing is the wake path. The interaction that carried the ruling lives on TRA-4426,',
      'not here, so this row had nothing scheduled against it and no card of its own -- it would',
      'have sat silent indefinitely while holding TRA-2038, and re-reading it would have shown a',
      'legitimate-looking in_review the whole time.',
      '',
      'Monitor set for 2026-09-16T14:00Z, one week out, which is the right cadence for a payment we',
      'do not control. The standing caveat stays attached to everything downstream: GitHub Actions',
      'has started NO job since 2026-07-26, so "CI green" is NO SIGNAL on this repo until it does.',
      'That is the part most likely to be misread by anyone reasoning about the 137 unbuilt commits.',
    ].join('\n'),
  },
];

// ---------------------------------------------------------------------------------------------
// Pre-flight, all of it BEFORE any network call. These are the failures that are easy to never
// see, because they only bite on the row that happens to be patched last.
for (const r of ROWS) {
  if (r.status === 'in_review') {
    if (!r.nextCheckAt) {
      console.error(`[strand-land] ${r.key}: in_review with no monitor is the state being repaired.`);
      process.exit(3);
    }
    if (!/Z$/.test(r.nextCheckAt)) {
      console.error(`[strand-land] ${r.key}: nextCheckAt must end in Z, got ${r.nextCheckAt}`);
      process.exit(3);
    }
    if (r.notes.length > MONITOR_NOTES_MAX) {
      console.error(`[strand-land] ${r.key}: notes ${r.notes.length} > ${MONITOR_NOTES_MAX}; trim it`);
      process.exit(3);
    }
  }
  if (!r.body.includes(r.marker)) {
    console.error(`[strand-land] ${r.key}: marker absent from body -- the guard would never fire.`);
    process.exit(3);
  }
  // eslint-disable-next-line no-control-regex
  const nonAscii = r.body.match(/[^\x00-\x7F]/);
  if (nonAscii) {
    console.error(`[strand-land] ${r.key}: non-ASCII ${JSON.stringify(nonAscii[0])} in body; it will mojibake.`);
    process.exit(3);
  }
}

async function landOne(row) {
  // FAIL CLOSED: if the comment list cannot be read, skip rather than risk a double-post onto an
  // append-only thread. (A sibling script once shipped a guard that failed OPEN; not again.)
  let existing;
  try {
    const r = await fetch(`${BASE}/api/issues/${row.id}/comments?limit=100`, { headers: H });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    existing = j.comments || j.data || j;
    if (!Array.isArray(existing)) throw new Error('unexpected comment list shape');
  } catch (err) {
    console.error(`[strand-land] ${row.key}: could not read comments (${err.message}) -- SKIPPING.`);
    return 'skipped';
  }

  if (existing.some(c => String(c.body || c.comment || '').includes(row.marker))) {
    console.log(`[strand-land] ${row.key}: already landed (marker found).`);
    return 'already';
  }

  // ONE PATCH carrying comment AND status together. A status PATCH spawns a run that holds the
  // checkout lock, so a SECOND PATCH against the same row 409s. Do not split these.
  const payload = { status: row.status, comment: row.body };
  if (row.nextCheckAt) {
    payload.executionPolicy = {
      monitor: {
        nextCheckAt: row.nextCheckAt,
        scheduledBy: 'assignee',
        notes: row.notes,
        recoveryPolicy: 'wake_owner',
      },
    };
  }

  const res = await fetch(`${BASE}/api/issues/${row.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[strand-land] ${row.key}: PATCH failed HTTP ${res.status}: ${text.slice(0, 300)}`);
    return 'failed';
  }

  // Verify on the STORED state, never on the status string we sent -- a PATCH can return 200 and
  // not store what you sent. Verify on activeRecoveryAction clearing, which is the thing that
  // actually distinguishes a repaired row from one that merely reports a new status.
  const v = await fetch(`${BASE}/api/issues/${row.id}`, { headers: H }).then(x => x.json());
  const iss = v.issue || v;
  const armed = iss.monitorNextCheckAt;
  const recov = iss.activeRecoveryAction ? 'PRESENT' : 'null';
  console.log(`[strand-land] ${row.key}: landed. status=${iss.status} monitor=${armed || '-'} activeRecoveryAction=${recov}`);

  if (row.nextCheckAt && !armed) {
    console.error(`[strand-land] ${row.key}: WARNING monitor did NOT arm -- still stranded, fix by hand.`);
    return 'failed';
  }
  if (iss.status !== row.status) {
    console.error(`[strand-land] ${row.key}: WARNING stored status ${iss.status} != requested ${row.status}.`);
    return 'failed';
  }
  return 'landed';
}

async function main() {
  const tally = { landed: 0, already: 0, skipped: 0, failed: 0 };
  for (const row of ROWS) {
    // Sequential, never Promise.all: the write cap is counted per run and a burst of parallel
    // PATCHes makes a cap hit land on an arbitrary subset rather than on the tail.
    const outcome = await landOne(row);
    tally[outcome] += 1;
    if (outcome === 'failed') {
      // Two consecutive failures of the same control-plane write is the stop rule. One failure
      // here is already enough to stop the LOOP, because the likely causes -- write cap reached,
      // run lock held -- get worse with every further attempt, not better.
      console.error('[strand-land] stopping the loop after a failure; re-run to pick up the tail.');
      break;
    }
  }
  console.log(`[strand-land] tally ${JSON.stringify(tally)}`);
  // Non-zero only when something is genuinely unrepaired, so this is safe to chain.
  if (tally.failed > 0 || tally.skipped > 0) process.exit(1);
}

main().catch(err => { console.error('[strand-land] fatal', err); process.exit(1); });
