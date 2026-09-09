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
//   TRA-4145 -> blocked   arms still board-paused; rests on TRA-4229, a REAL blocker
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
import { dirname, join } from 'node:path';
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

const TRA_4229 = '066bd364-c0f1-4008-9912-8cc5a45467db';

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
          notes:
            'TRA-4009 AC4 backfill. AC1 PASSES (09-08 line: capturedAccounts [admin,v0nni], ' +
            'missingAccounts [], fleetSealed true; all 18 prior lines name v0nni as a gap). AC4 ' +
            'FAILS: orderCensus.byAccount has ONLY admin, 0 non-admin rows, and neither 143021643 ' +
            'nor 143197015 appears. Waiting cannot fix it -- the 09-08 capture sealed on orders:0 ' +
            '(tape dark since 09-02, TRA-4350) and the originals sit on days the daily pass never ' +
            'revisits. DO: run captureBrokerOrderDay for (etDay, v0nni) over the 7 blind days that ' +
            'still carry orders -- 08-21, 08-24, 08-25, 08-26, 08-27, 08-28, 09-02. The key is ' +
            '(etDay, account) and (day, v0nni) was NEVER captured, so the admin seal does not ' +
            'block it. Both ids are in the submit ledger => expect engine_placed. If Tradier ' +
            'listOrders() no longer reaches 08-21, that is a real answer: re-cut AC4 to say so, ' +
            'measured not assumed. Post-close only; no ?force=true pre-close.',
        },
      },
    }),
    verify: (r) =>
      r.status === 'in_review' && r.monitorNextCheckAt
        ? null
        : `status=${r.status} monitorNextCheckAt=${r.monitorNextCheckAt}`,
  },
  {
    key: 'TRA-4145',
    id: '133f9e4d-9c01-4ed0-8a1e-96876a0128a2',
    body: '.land-4145.md',
    marker: 'Converting this from a spent monitor to a first-class blocker',
    patch: { status: 'blocked', blockedByIssueIds: [TRA_4229] },
    verify: (r) => {
      const bb = (r.blockedBy || []).map((x) => (typeof x === 'string' ? x : x.id));
      if (r.status !== 'blocked') return `status=${r.status}, wanted blocked`;
      // An empty blockedBy on a `blocked` row IS the strand condition -- refuse to call that landed.
      return bb.includes(TRA_4229) ? null : `blockedBy=[${bb.join(',')}] missing TRA-4229`;
    },
  },
];

async function main() {
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

main().catch((e) => {
  console.error('[land] fatal', e);
  process.exit(3);
});
