#!/usr/bin/env node
// TRA-4468 — reconstruct an issue's status history from the Paperclip audit feed.
//
// Answers "what status was this issue in at instant T?" reproducibly, which neither
// `blockedTransitionAt` nor a naive read of /api/issues/{id}/activity can do.
//
//   node scripts/tra4468-status-history.mjs <issueId|TRA-xxxx> [...]
//   node scripts/tra4468-status-history.mjs --at 2026-09-09T21:30:00Z <issueId> [...]
//   node scripts/tra4468-status-history.mjs --audit          # self-check the 3 event shapes
//
// Env: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID
//
// Method and the measurements behind it: docs/issue-status-history-TRA-4468.md

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAW = (process.env.PAPERCLIP_API_URL || '').replace(/\/$/, '');
const BASE = RAW.endsWith('/api') ? RAW.slice(0, -4) : RAW;
const KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY = process.env.PAPERCLIP_COMPANY_ID;

// The company activity route hard-caps at 500 rows and silently ignores
// offset/cursor/action/from, so 500 is a real ceiling, not a page size.
const ACTIVITY_CAP = 500;

const CREATE_ACTIONS = new Set(['issue.created', 'issue.child_created']);

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Pull an issue's audit rows. Prefers the company route because it is the only
 * one whose truncation bound is knowable: `/api/issues/{id}/activity` takes no
 * limit parameter at all, so a caller cannot tell a short feed from a capped one.
 * Both routes serve the same table; entityId is honoured on the company route.
 */
async function activity(issueId) {
  if (COMPANY) {
    const rows = await api(
      `/api/companies/${COMPANY}/activity?entityId=${issueId}&limit=${ACTIVITY_CAP}`,
    );
    if (Array.isArray(rows)) {
      return { rows, truncated: rows.length >= ACTIVITY_CAP };
    }
  }
  return { rows: await api(`/api/issues/${issueId}/activity`), truncated: null };
}

/**
 * Extract a status transition from one audit row.
 *
 * Three distinct shapes carry one; keying on only the first — the obvious one —
 * loses every system/recovery-driven transition and every creation, which is what
 * made the history look absent in the first place.
 */
export function transitionOf(event) {
  const d = event?.details || {};
  const changed = d.changes?.status;
  if (changed) {
    return { at: event.createdAt, from: changed.from ?? null, to: changed.to, via: 'patch' };
  }
  // System/recovery writes record no `changes` block at all.
  if (d.previousStatus != null && d.status != null && d.previousStatus !== d.status) {
    return {
      at: event.createdAt,
      from: d.previousStatus,
      to: d.status,
      via: `system:${d.source || d.recoveryCause || event.action}`,
    };
  }
  if (CREATE_ACTIONS.has(event.action) && d.status != null) {
    return { at: event.createdAt, from: null, to: d.status, via: 'created' };
  }
  return null;
}

/**
 * Reconstruct the ordered status timeline.
 *
 * The checkout that moves an issue to `in_progress` writes no audit row at all
 * (measured: 472 of 476 pickups leave no trace on the feed), so the replay is
 * patched from `startedAt`, which the platform never clears and never re-stamps.
 */
export function timeline(issue, events) {
  const t = events
    .map(transitionOf)
    .filter(Boolean)
    .sort((a, b) => a.at.localeCompare(b.at));

  const started = issue.startedAt;
  if (started) {
    const covers = t.some((x) => x.to === 'in_progress' && Math.abs(Date.parse(x.at) - Date.parse(started)) < 3000);
    if (!covers) {
      // Slot the pickup in at startedAt, inheriting whatever the replay said just before it.
      const prior = [...t].reverse().find((x) => x.at <= started);
      t.push({ at: started, from: prior ? prior.to : null, to: 'in_progress', via: 'startedAt(inferred)' });
      t.sort((a, b) => a.at.localeCompare(b.at));
    }
  }

  // The row's current status is ground truth; if the replay disagrees, say so
  // rather than silently trusting a reconstruction.
  const replayed = t.length ? t[t.length - 1].to : null;
  return { transitions: t, replayed, actual: issue.status, agrees: replayed === issue.status };
}

export function statusAt(tl, instant) {
  const ts = Date.parse(instant);
  let cur = null;
  for (const x of tl.transitions) {
    if (Date.parse(x.at) <= ts) cur = x.to;
    else break;
  }
  return cur;
}

/** Blocked intervals, derived from transitions — never from the `blockedTransitionAt` field. */
export function blockedIntervals(tl) {
  const out = [];
  let open = null;
  for (const x of tl.transitions) {
    if (x.to === 'blocked' && open == null) open = x.at;
    else if (x.to !== 'blocked' && open != null) {
      out.push([open, x.at]);
      open = null;
    }
  }
  if (open != null) out.push([open, null]);
  return out;
}

async function resolveIssue(ref) {
  if (/^[0-9a-f-]{36}$/i.test(ref)) return api(`/api/issues/${ref}`);
  const list = await api(`/api/companies/${COMPANY}/issues?view=compact`);
  const hit = list.find((x) => x.identifier?.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new Error(`no issue matching ${ref} in the reachable list`);
  return api(`/api/issues/${hit.id}`); // compact rows null out blockedTransitionAt
}

async function main() {
  const argv = process.argv.slice(2);
  let at = null;
  const refs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--at') at = argv[++i];
    else refs.push(argv[i]);
  }
  if (!refs.length) {
    console.error('usage: tra4468-status-history.mjs [--at <ISO>] <issueId|TRA-xxxx>...');
    process.exit(2);
  }

  for (const ref of refs) {
    const issue = await resolveIssue(ref);
    const { rows, truncated } = await activity(issue.id);
    const tl = timeline(issue, rows);

    console.log(`\n=== ${issue.identifier}  ${issue.title.slice(0, 70)}`);
    console.log(`    status=${issue.status} startedAt=${issue.startedAt || '-'} completedAt=${issue.completedAt || '-'}`);
    console.log(`    blockedTransitionAt=${issue.blockedTransitionAt || 'null'}  <- path-dependent, DO NOT key on it`);
    if (truncated) console.log(`    !! feed hit the ${ACTIVITY_CAP}-row cap — history may be incomplete`);
    for (const x of tl.transitions) {
      console.log(`    ${x.at}  ${String(x.from ?? '(new)').padEnd(12)} -> ${String(x.to).padEnd(12)} [${x.via}]`);
    }
    const bi = blockedIntervals(tl);
    console.log(`    blocked intervals: ${bi.length ? bi.map(([a, b]) => `${a}..${b || 'open'}`).join(', ') : 'none'}`);
    if (!tl.agrees) console.log(`    !! replay ended at ${tl.replayed} but the row reads ${tl.actual} — unlogged transition remains`);
    if (at) console.log(`    status at ${at}: ${statusAt(tl, at) ?? '(before first recorded event)'}`);
  }
}

// Identity-first entry test (TRA-4867). The URL-comparison arm this used to lead with never
// bound on Windows — `file://C:/…` is two slashes, `import.meta.url` is three — so the guard
// was carried entirely by the NAME, and a copy graded under any other name evaluated the
// module, called nothing, printed nothing and exited 0. The `endsWith` arm stays OR'd in so
// this is never LESS permissive than what shipped. Same shape as
// `scripts/check-journal-stale-opens.mjs` and `scripts/check-deploy-origin.mjs`.
const isEntrypoint = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    if (fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url))) return true;
  } catch { /* unreadable argv[1] — fall through to the name test */ }
  return argv1.endsWith('tra4468-status-history.mjs');
})();

if (isEntrypoint) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
