#!/usr/bin/env node
// Stage-and-land for the 2026-09-09T15:5xZ CTO AC5-tape beat (issue 12726290, TRA-4357).
//
// WHY THIS EXISTS. That beat was an `on_demand` board wake: `contextSnapshot.issueId` is absent,
// so every issue write 403s `cross_issue_influence_run_context_required`. Probed exactly ONCE with
// the real payload (the `X-Paperclip-Run-Id` header the 403 body recommends is a KNOWN TRAP --
// re-measured 6 times now and it has never worked; do not spend a second probe on it).
//
// The GRADING was completed against the live host during that beat and is not deferred -- only the
// write is. 204 polls, 0 errors, 43 distinct OTM cycles, single boot `a187fc14` / pid 52 /
// startedAt 2026-09-09T15:34:12.095Z. The sample was the perishable half: RTH closes 20:00Z and
// this box restarts several times a day. Re-running this script does NOT re-measure and MUST NOT
// be read as a fresh grade -- the comment it posts is a transcript of 15:56Z-16:12Z.
//
// RUN THIS FROM THE NEXT ISSUE-BOUND WAKE.
//
// It lands ONE disposition:
//   12726290 -> in_review + re-armed monitor
//       AC5 read FAIL (best 10-consecutive window 6/10; AC5 needs 8). The verdict itself is
//       QuantTrader's -- the ticket says "I will grade this; do not close on my behalf" -- so this
//       posts the tape and the arithmetic and deliberately writes NO verdict into the status.
//
// WHY in_review AND NOT done/blocked. The monitor that woke this issue at 2026-09-09T14:31Z fired
// and nothing re-armed it, leaving the exact stranded leaf CLAUDE.md describes: `in_review` with
// `monitorNextCheckAt == null` and `executionState.monitor.status == "triggered"`, owned by nobody
// and reading compliant to every status query. `blocked` is wrong -- there is no first-class
// blocker and `blocked` with an empty `blockedBy` IS the strand condition (TRA-3058/TRA-4060).
// So it rests in a monitor, which is the sanctioned resting state for a timed wait.

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

const ISSUE_ID = '12726290-bd16-4b4c-8f76-3b4e3306f46b';

// Idempotence marker. Searched in the issue's EXISTING comments, never tracked in a local flag
// file -- a flag file cannot see a comment that landed from a different checkout. Must be a string
// that appears in the posted body and nowhere else on the issue.
const MARKER = 'AC5\'s sample is on the tape and it does NOT pass';

// Server-side cap on `executionPolicy.monitor.notes` is 500 (zod `too_big`, measured 2026-09-09
// when an 850-char note came back HTTP 400 while its neighbours came back 403). Checked BEFORE any
// network call, because the failure is order-dependent and therefore easy to never see.
const MONITOR_NOTES_MAX = 500;

const NOTES = [
  'Awaiting QuantTrader\'s AC5 grade. Tape posted 2026-09-09 (43 OTM cycles, build a187fc14).',
  'My read is FAIL: best 10-consecutive window is 6/10 under 10% no_spot; AC5 needs 8. I did not',
  'write a verdict into the status -- AC5 is QuantTrader\'s by the ticket. If it is still ungraded',
  'at this check, take the AC4 source-state stamp (record quote-breaker state on the scan-cycle',
  'record so a blind cycle is separable from a strategy decline) and re-ping QuantTrader.',
].join(' ');

if (NOTES.length > MONITOR_NOTES_MAX) {
  console.error(`[land] monitor notes ${NOTES.length} > ${MONITOR_NOTES_MAX}; trim before running`);
  process.exit(3);
}

// Re-check inside Thursday's RTH (13:30-20:00Z), late enough that QuantTrader has had a full
// session with the tape. Bare local times are rejected everywhere in this repo -- always `Z`.
const NEXT_CHECK_AT = '2026-09-10T17:00:00.000Z';

async function main() {
  const body = readFileSync(join(REPO_ROOT, 'docs', 'tra4357-ac5-tape-20260909.md'), 'utf8');

  if (!body.includes(MARKER)) {
    console.error('[land] MARKER not present in the artifact -- the guard would never fire. Abort.');
    process.exit(3);
  }

  // FAIL CLOSED: if the comment list cannot be read, skip rather than risk a double-post.
  // (An earlier draft of a sibling script shipped a guard that failed OPEN; do not repeat it.)
  let existing;
  try {
    const r = await fetch(`${BASE}/api/issues/${ISSUE_ID}/comments?limit=100`, { headers: H });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    existing = j.comments || j.data || j;
    if (!Array.isArray(existing)) throw new Error('unexpected comment list shape');
  } catch (err) {
    console.error(`[land] could not read comments (${err.message}) -- SKIPPING, not posting.`);
    process.exit(4);
  }

  if (existing.some(c => String(c.body || c.comment || '').includes(MARKER))) {
    console.log('[land] already landed (marker found). Nothing to do.');
    return;
  }

  // ONE PATCH carrying comment AND status together. A status PATCH spawns a run that holds the
  // checkout lock, so a SECOND PATCH against the same row 409s. Do not split these.
  const payload = {
    status: 'in_review',
    comment: body,
    executionPolicy: {
      monitor: {
        nextCheckAt: NEXT_CHECK_AT,
        scheduledBy: 'assignee',
        notes: NOTES,
        recoveryPolicy: 'wake_owner',
      },
    },
  };

  const r = await fetch(`${BASE}/api/issues/${ISSUE_ID}`, {
    method: 'PATCH', headers: H, body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`[land] PATCH failed HTTP ${r.status}: ${text.slice(0, 400)}`);
    process.exit(1);
  }

  // Verify on the STORED state, never on the status string we sent -- a PATCH can return 200 and
  // not store what you sent. The monitor is the thing that must be real here.
  const v = await fetch(`${BASE}/api/issues/${ISSUE_ID}`, { headers: H }).then(x => x.json());
  const iss = v.issue || v;
  const armed = iss.monitorNextCheckAt;
  console.log(`[land] landed. status=${iss.status} monitorNextCheckAt=${armed}`);
  if (!armed) {
    console.error('[land] WARNING: monitor did NOT arm. The leaf is stranded again -- fix by hand.');
    process.exit(1);
  }
}

main().catch(err => { console.error('[land] fatal', err); process.exit(1); });
