#!/usr/bin/env node
// Stage-and-land for the 2026-09-09T00:0xZ CTO monitor-drain beat.
//
// WHY THIS EXISTS. That beat was an `on_demand` board wake: `contextSnapshot.issueId` is absent,
// so every issue write 403s with `cross_issue_influence_run_context_required`. Probed exactly once
// (the `X-Paperclip-Run-Id` header the error body recommends is a KNOWN TRAP -- it has been
// re-measured 5 times now and never works). All four gradings below were completed against the
// live host during that beat; only the writes are deferred.
//
// RUN THIS FROM THE NEXT ISSUE-BOUND WAKE.
//
// It lands four dispositions, each of which was measured, not assumed:
//   TRA-4241 -> done      AC4 PASS (closeSupersedes 3/1/2, witnessed_other_order refusal)
//   TRA-4350 -> done      AC1 PASS (ran_and_declined / 112594 / entry_window_closed)
//   TRA-4009 -> in_review AC4 FAILS on real bytes; re-armed to run the v0nni backfill
//   TRA-4145 -> in_review arms still board-paused; monitor re-armed for after the 09-18 freeze
//
// ALL FOUR LANDED 2026-09-09 from the TRA-4431 stalled-review sweep leaf, three of them verbatim
// as staged. TRA-4145 did NOT: it was staged `blocked` on TRA-4229, TRA-4229 closed `done` at
// 13:32Z (~40 min before this batch ran), and the PATCH was correctly refused 422. It was re-graded
// by hand in that same beat and the row here now records what actually landed, so a re-run
// verifies rather than re-posts. See assertStagedBlockersStillOpen() for the guard that stops the
// next batch being refused the same way.
//
// IDEMPOTENCE. Guarded by a marker string searched in each issue's EXISTING comments -- never by a
// local flag file, which cannot see a comment that landed from a different checkout. The guard
// FAILS CLOSED: if the comment list cannot be read, that row is skipped rather than double-posted.
// (TRA-4357's first draft shipped a guard that failed OPEN; do not repeat it.)
//
// ONE PATCH PER ROW, carrying comment AND status together. A status PATCH spawns a run that holds
// the checkout lock, so a SECOND PATCH against the same row 409s. Do not split these.
//
// Not an unattended executor: it runs only when a heartbeat wakes the agent.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derive the repo root from THIS FILE, never from $PAPERCLIP_WORKSPACE_CWD -- on some seats that
// variable points at an empty `_default` directory and both halves fail silently.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BASE = (process.env.PAPERCLIP_API_URL || '').replace(/\/$/, '').replace(/\/api$/, '');
const KEY = process.env.PAPERCLIP_API_KEY;
if (!BASE || !KEY) {
  console.error('[land] PAPERCLIP_API_URL / PAPERCLIP_API_KEY missing');
  process.exit(3);
}
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// (TRA-4229 was the staged blocker for TRA-4145. It closed `done` 2026-09-09T13:32Z, the staged
// edge was refused 422, and that row now rests in a monitor instead -- see the row and
// assertStagedBlockersStillOpen() below. The id is deliberately gone: nothing should reference it.)

/**
 * Server-side cap on `executionPolicy.monitor.notes` (zod `too_big`, maximum 500), measured
 * 2026-09-09 when TRA-4009's 850-char note came back HTTP 400 while its neighbours came back 403.
 *
 * This is checked BEFORE any network call, against every row, because the failure it prevents is
 * order-dependent and therefore easy to never see: the 400 only became visible because the three
 * 403 rows did not abort the loop. On a wake where the writes are permitted, a long note fails a
 * single row in the middle of a batch whose other rows have already landed -- which reads as a
 * partial success rather than as a bug in this file.
 */
const MONITOR_NOTES_MAX = 500;

/** Throw on any monitor note that the server would reject, naming the row and the overflow. */
function assertMonitorNotesFit(rows) {
  const bad = [];
  for (const row of rows) {
    const patch = typeof row.patch === 'function' ? row.patch() : row.patch;
    const notes = patch?.executionPolicy?.monitor?.notes;
    if (typeof notes === 'string' && notes.length > MONITOR_NOTES_MAX) {
      bad.push(`${row.key}: notes ${notes.length} chars, ${notes.length - MONITOR_NOTES_MAX} over`);
    }
  }
  if (bad.length) {
    console.error(`[land] REFUSING TO RUN -- monitor notes exceed ${MONITOR_NOTES_MAX}:`);
    for (const b of bad) console.error(`  ${b}`);
    console.error('[land] Move the detail into the row\'s comment body; keep the note as the order.');
    process.exit(2);
  }
}

/**
 * A staged `blockedByIssueIds` edge carries the world-state of the beat that GRADED it, and a
 * blocker is the part of that state most likely to have moved by the time the batch lands.
 *
 * Measured 2026-09-09: this file staged TRA-4145 -> `blocked` on TRA-4229 during the 00:0xZ
 * on_demand beat, while TRA-4229 was open. TRA-4229 closed `done` at 13:32:18Z. The batch ran at
 * ~14:1xZ and the row came back
 *   HTTP 422 {"error":"Entering blocked requires unresolved blockers, ..."}
 * -- the platform being right and the staged grade being stale. The other three rows, none of
 * which asserted a relationship to another live row, landed clean.
 *
 * So: re-read every blocker target immediately before the batch and refuse if any has gone
 * terminal. FAILS CLOSED -- an unreadable target refuses too, because "I could not check" and
 * "I checked and it is open" must not share an outcome. Refusing here is strictly better than
 * being refused by the server: it names the row and the resolved blocker rather than leaving a
 * bare 422 in the middle of a batch whose other rows have already landed.
 */
async function assertStagedBlockersStillOpen(rows) {
  const TERMINAL = new Set(['done', 'cancelled']);
  const bad = [];
  for (const row of rows) {
    const patch = typeof row.patch === 'function' ? row.patch() : row.patch;
    for (const blockerId of patch?.blockedByIssueIds ?? []) {
      let blocker;
      try {
        const res = await fetch(`${BASE}/api/issues/${blockerId}`, { headers: H });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        blocker = await res.json();
      } catch (e) {
        bad.push(`${row.key}: blocker ${blockerId} unreadable (${e.message}) -- cannot confirm it is open`);
        continue;
      }
      if (TERMINAL.has(blocker.status)) {
        bad.push(
          `${row.key}: blocker ${blocker.identifier ?? blockerId} is ${blocker.status}, not open -- ` +
            'the staged grade is stale; re-grade this row by hand',
        );
      }
    }
  }
  if (bad.length) {
    console.error('[land] REFUSING TO RUN -- a staged blocker edge is no longer valid:');
    for (const b of bad) console.error(`  ${b}`);
    console.error('[land] A `blocked` row whose blockers are all resolved IS the strand condition.');
    process.exit(2);
  }
}

/** Next occurrence of 21:05Z that is at least 30 min out, so a late run never arms the past. */
function nextPostClose() {
  const now = Date.now();
  for (let d = 0; d < 8; d++) {
    const t = new Date(now);
    t.setUTCDate(t.getUTCDate() + d);
    t.setUTCHours(21, 5, 0, 0);
    const dow = t.getUTCDay();
    if (dow !== 0 && dow !== 6 && t.getTime() - now > 30 * 60 * 1000) return t.toISOString();
  }
  return new Date(now + 24 * 3600 * 1000).toISOString();
}

const ROWS = [
  {
    key: 'TRA-4241',
    id: 'fdb38a76-2218-4d79-96e3-88ccff9dbc0b',
    body: '.land-4241.md',
    marker: 'AC4 GRADED PASS on the live build',
    patch: { status: 'done' },
    verify: (r) => (r.status === 'done' ? null : `status=${r.status}, wanted done`),
  },
  {
    key: 'TRA-4350',
    id: '002177f7-50ce-4506-85ae-2685b0554a09',
    body: '.land-4350.md',
    marker: 'AC1 GRADED PASS. Terminal read as the monitor ordered',
    patch: { status: 'done' },
    verify: (r) => (r.status === 'done' ? null : `status=${r.status}, wanted done`),
  },
  {
    key: 'TRA-4009',
    id: '891a8e02-7142-4483-9d2a-bc25ab47b0c7',
    body: '.land-4009.md',
    marker: 'it needs a per-account BACKFILL',
    patch: () => ({
      status: 'in_review',
      executionPolicy: {
        monitor: {
          nextCheckAt: nextPostClose(),
          scheduledBy: 'assignee',
          recoveryPolicy: 'wake_owner',
          // MUST stay under MONITOR_NOTES_MAX. The v1 note here was 850 chars and the server
          // rejects at 500 (`too_big` on executionPolicy.monitor.notes) -- so this row would have
          // failed on a correct issue-bound wake too, not just on the on_demand beat that found
          // it. The reasoning it used to carry is not lost: it is the comment body .land-4009.md,
          // which lands in the same PATCH and has no such cap. Note = the ORDER; body = the case.
          notes:
            'TRA-4009 AC4 backfill. AC4 FAILS: orderCensus.byAccount holds admin only, 0 ' +
            'non-admin rows. Waiting cannot fix it -- the originals sit on days the daily pass ' +
            'never revisits. DO: run captureBrokerOrderDay for (etDay, v0nni) over the 7 blind ' +
            'days still carrying orders: 08-21, 08-24, 08-25, 08-26, 08-27, 08-28, 09-02. Key is ' +
            '(etDay, account), so the admin seal does not block it. If listOrders() cannot reach ' +
            '08-21, re-cut AC4 to say so. Post-close only; no ?force=true.',
        },
      },
    }),
    verify: (r) =>
      r.status === 'in_review' && r.monitorNextCheckAt
        ? null
        : `status=${r.status} monitorNextCheckAt=${r.monitorNextCheckAt}`,
  },
  {
    // RE-GRADED BY HAND 2026-09-09T14:1xZ from the TRA-4431 sweep leaf, after the staged
    // `blocked`-on-TRA-4229 patch below was refused 422 (TRA-4229 had closed `done` at 13:32Z).
    // The wait is real but now has a DATE: the board froze all 41 routines and 2 seats through
    // 2026-09-18, so this rests in a monitor -- disposition (1) of TRA-4073 -- not on a blocker.
    // Kept in the batch so a re-run VERIFIES the landed state instead of re-posting it.
    key: 'TRA-4145',
    id: '133f9e4d-9c01-4ed0-8a1e-96876a0128a2',
    body: '.land-4145.md',
    marker: 'AC4 still ungradeable -- but the reason CHANGED today',
    patch: {
      status: 'in_review',
      executionPolicy: {
        monitor: {
          nextCheckAt: '2026-09-21T14:00:00.000Z',
          scheduledBy: 'assignee',
          recoveryPolicy: 'wake_owner',
          notes:
            'TRA-4145 AC4. Board froze all 41 routines + 2 seats through 2026-09-18 (TRA-4229 ' +
            'ruling, 09-09T14:07Z), so arms 9cff4e6f/02abcd1b/db971fb9 stay paused; last fires ' +
            '08-28, pre-fix 7465ba6d. On wake: if any arm fired post-fix, grade the exit code ' +
            '(0 DRAINED, or VACUOUS with zero refusals = pass; exit 2 on a refusal reopens). If ' +
            'still paused, check the freeze was not extended before re-arming again.',
        },
      },
    },
    verify: (r) =>
      r.status === 'in_review' && r.monitorNextCheckAt
        ? null
        : `status=${r.status} monitorNextCheckAt=${r.monitorNextCheckAt}`,
  },
];

async function main() {
  assertMonitorNotesFit(ROWS);
  await assertStagedBlockersStillOpen(ROWS);

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of ROWS) {
    console.log(`\n== ${row.key} ==`);

    // --- idempotence guard, FAILS CLOSED -------------------------------------------------
    let already;
    try {
      const res = await fetch(`${BASE}/api/issues/${row.id}/comments?limit=100`, { headers: H });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      const list = Array.isArray(d) ? d : d.comments || d.data || [];
      already = list.some((c) => (c.body || c.comment || '').includes(row.marker));
    } catch (e) {
      console.log(`  SKIP: cannot read comments (${e.message}) -- refusing to risk a double post`);
      failed++;
      continue;
    }

    if (already) {
      console.log('  comment already present; verifying disposition only');
    } else {
      const body = readFileSync(join(REPO_ROOT, row.body), 'utf8');
      const patch = typeof row.patch === 'function' ? row.patch() : row.patch;
      const payload = { ...patch, comment: body };
      const res = await fetch(`${BASE}/api/issues/${row.id}`, {
        method: 'PATCH',
        headers: H,
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) {
        console.log(`  PATCH FAILED HTTP ${res.status}: ${text.slice(0, 300)}`);
        failed++;
        continue;
      }
      console.log(`  PATCH ok (HTTP ${res.status})`);
      posted++;
    }

    // --- verify on the STORED row, never on the string we sent ---------------------------
    const vres = await fetch(`${BASE}/api/issues/${row.id}`, { headers: H });
    const r = await vres.json();
    const problem = row.verify(r);
    if (problem) {
      console.log(`  VERIFY FAILED: ${problem}`);
      failed++;
    } else {
      console.log(`  VERIFY ok: status=${r.status} activeRecoveryAction=${r.activeRecoveryAction ? 'YES' : 'null'}`);
      if (already) skipped++;
    }
  }

  console.log(`\n[land] posted=${posted} already=${skipped} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}

// Run ONLY when executed directly. A bare top-level `main()` means any `import()` of this file --
// including one meant merely to read ROWS or re-measure a note length -- fires the whole batch of
// live PATCHes as a side effect. That happened on 2026-09-09 while measuring the note overflow.
// The batch is idempotent so nothing was double-posted, but on a wake where writes ARE permitted
// the same slip lands four real dispositions that nobody decided to land in that beat.
const INVOKED_DIRECTLY =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (INVOKED_DIRECTLY) {
  main().catch((e) => {
    console.error('[land] fatal', e);
    process.exit(3);
  });
}

export { ROWS, assertMonitorNotesFit, assertStagedBlockersStillOpen, MONITOR_NOTES_MAX };
