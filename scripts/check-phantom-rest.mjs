#!/usr/bin/env node
/**
 * TRA-2422 — detector for the PHANTOM REST: a non-terminal issue with no live
 * continuation path of any kind.
 *
 * WHAT THE SHAPE IS
 * -----------------
 * An agent parks a leaf at `in_review` "behind a monitor", and the monitor is
 * never created. The leaf then reads EXACTLY like a healthy one: `in_review`,
 * no error, no orphan, no stranded flag, no recovery action. It simply never
 * wakes, and the one-shot session it was armed for is lost.
 *
 * The CTO found five of their own leaves in this state on 2026-07-26
 * (TRA-2262 / TRA-2294 / TRA-2305 / TRA-2322 / TRA-2355) and filed TRA-2422.
 *
 * WHY NOTHING WE ALREADY RUN CAN SEE IT
 * -------------------------------------
 * The twice-daily resting-disposition clause audit and the platform's
 * `missing_disposition` detector both operate on ROUTINES THAT EXIST. They
 * answer "does this routine carry the clause?". They cannot answer "does this
 * leaf have any routine at all", so a leaf whose declared monitor was never
 * written is invisible to both. Same shape as
 * `paperclip-routine-trigger-is-a-second-write` one level up: that rule caught
 * "routine exists, trigger does not"; this one catches "leaf declares a
 * monitor, routine does not exist".
 *
 * The blast radius is not proportional to the count. These monitors grade
 * in-memory counters that reset at boot, on weekday-only sessions. The sampling
 * unit is a TRADING SESSION, so a missed fire is not a delayed answer — it is a
 * week of lost statistical power (TRA-2294 is at n=1 in 5 retained sessions).
 *
 * THE PREDICATE
 * -------------
 * For every non-terminal issue (`todo` / `in_progress` / `in_review` /
 * `blocked`), assert AT LEAST ONE live continuation path:
 *
 *   PARKED_READY      status is `todo` — parked-ready is a legal rest; it still
 *                     counts as an unresolved blocker upstream.
 *   LIVE_RUN          a run is attached right now (`activeRun` / `checkoutRunId`).
 *   LINKED_ROUTINE    a routine with `parentIssueId === issue.id`, `status:
 *                     active`, and a trigger that is `enabled` with a non-null
 *                     `nextRunAt` IN THE FUTURE.
 *   PLATFORM_MONITOR  `monitorNextCheckAt` in the future — the platform's own
 *                     wake, scheduled by the assignee. 7 in_review leaves rest
 *                     on this today; omitting it invents 7 false findings.
 *   OPEN_BLOCKER      a `blockedBy` entry whose own status is not done/cancelled.
 *   OPEN_INTERACTION  an interaction at status `pending` whose
 *                     `continuationPolicy` is not `none`.
 *
 * Nothing matches ⇒ report it. ⛔ DO NOT AUTO-PARK. The right repair is almost
 * always "arm the monitor that was promised", and only the owner knows what it
 * was supposed to run. This script performs GETs and NOTHING else, and a
 * control below asserts that no rendering of any board emits a copy-pasteable
 * status PATCH. Prose does not survive a copy-paste (TRA-2396).
 *
 * THE TRAPS — every one of these was MEASURED against the live API on
 * 2026-07-26, and each has a control in `--selftest`
 * ------------------------------------------------------------------------
 *  1. ⛔ `blockedByIssueIds` IS WRITE-ONLY. It is `undefined` on every GET. A
 *     check of the form "`blockedByIssueIds` is empty" reports ZERO blockers for
 *     EVERY issue in the company and brands all 75 `blocked` leaves stranded.
 *     Read `blockedBy` (objects with `identifier` + `status`), and assert the
 *     KEY IS PRESENT (`'blockedBy' in item`) rather than trusting
 *     `(item.blockedBy || []).length === 0` — that cannot tell "no blockers"
 *     from "you asked the wrong route". Do not substitute
 *     `blockerAttention.unresolvedBlockerCount` either: it counts open
 *     DESCENDANTS and over-reports as readily as it under-reports (TRA-2364).
 *
 *  2. ⛔ `nextRunAt` LIVES ON `triggers[]`, NOT ON THE ROUTINE ROOT. A
 *     root-level read returns nothing on a perfectly armed routine, which reads
 *     identically to a triggerless one.
 *
 *  3. ⛔ ROUTINES MUST BE READ AT EVERY STATUS, THEN FILTERED. 98 of the
 *     company's 143 routines are `archived` and 2 are `paused`. An archived
 *     routine at the right minute is not coverage — `002011a2` sits at Mon
 *     20:35Z archived and would have matched a naive time-based scan for
 *     TRA-2355.
 *
 *  4. ⛔ THE ROUTINES ROUTE IGNORES BOTH `limit` AND `offset` (measured:
 *     `?limit=50` and `?limit=250&offset=100` both return the identical 143
 *     rows). So exhaustiveness CANNOT be proven by paging it. See
 *     `enumerateRoutines` for what we assert instead — and note the failure
 *     direction: a truncated routine list invents PHANTOM RESTS on leaves that
 *     are perfectly well monitored, which is the fastest way to get a detector
 *     ignored.
 *
 *  5. ⛔⛔ `parentIssueId === issue.id`, APPLIED LITERALLY, IS THE WRONG
 *     PREDICATE ON THIS BOARD. It is the right predicate for "will the platform
 *     wake THIS leaf", but the dominant real-world arming pattern here is a
 *     routine whose TITLE names the leaf while `parentIssueId` is null —
 *     `20d3357e` (TRA-2242), `7c3af47e` (TRA-2331), `f812e08d` (TRA-2377),
 *     `0d84ed70` (TRA-2356). Four of the five leaves this check would otherwise
 *     have reported today are covered that way, and they are among the most
 *     load-bearing live watches in the company. So a title-linked routine does
 *     NOT clear the leaf — it DOWNGRADES it to its own class, UNLINKED_MONITOR:
 *     the fire will happen, but it will not wake this leaf and will not
 *     re-disposition it. Reporting those four as PHANTOM_REST would be crying
 *     wolf on 4 of 5 findings.
 *
 *     ⛔ And the match must be on the TITLE, not the description. `bc9621b5`
 *     (the deploy train) names TRA-2242 in its body while monitoring nothing
 *     about it. A description grep confers coverage on every identifier a long
 *     routine happens to mention.
 *
 *  6. ⛔ AN EXPIRED INTERACTION READS LIKE AN INTERACTION. Live statuses are
 *     `pending` / `accepted` / `rejected` / `answered` / `expired`; only
 *     `pending` is open. And one pending interaction on this board carries
 *     `continuationPolicy: "none"` — pending forever, waking nobody.
 *
 *  7. ⛔ AN 8-HEX SCAN FOR DECLARED ROUTINE IDS MATCHES INSIDE A UUID. The
 *     first version of the advisory below reported TRA-1659 as declaring a
 *     routine `24ab8b77` that does not exist. It does not exist because it is
 *     not an id: it is the tail of `45453555-80ed-4065-96d6-24ab8b77cbcc`,
 *     a routine that exists and is named right there in the same line. Full
 *     UUIDs are consumed first and short ids require non-hex, non-dash
 *     boundaries on both sides.
 *
 * VERDICTS / EXIT CODES
 *   0  CLEAN                  — enumeration trustworthy, every non-terminal
 *                               issue has a live path
 *   1  FINDINGS               — every finding has a live roster assignee to route to
 *   2  FINDINGS_UNREPAIRABLE  — at least one finding no agent can repair (the
 *                               assignee is unset or off-roster; needs a human)
 *   3  BLIND                  — the enumeration itself is untrustworthy. NOT a pass.
 *
 * BLIND outranks everything, including a zero count: "0 found" and "0 looked
 * at" render identically, and this detector's whole subject is a state that
 * looks healthy.
 *
 * ADVISORY (never changes the exit code): DECLARED_ROUTINE_MISSING — the issue
 * body names a routine id that resolves to no routine at any status. This is
 * the most direct read of TRA-2422's own sentence, but it is a regex over prose
 * and an 8-hex token is also the shape of a short commit sha, so it is printed
 * for a human to judge and is never allowed to move the verdict.
 *
 * USAGE
 *   node scripts/check-phantom-rest.mjs
 *   node scripts/check-phantom-rest.mjs --json
 *   node scripts/check-phantom-rest.mjs --selftest      # both-direction controls
 *   node scripts/check-phantom-rest.mjs --now=2026-07-27T00:00:00Z
 *
 * Auth: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.
 */

import { enumerateIssues } from './lib/paperclip-enumeration.mjs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
};

const PAGE_LIMIT = Number(argOf('limit', 1000));
const MAX_PAGES = Number(argOf('max-pages', 50));
const CONCURRENCY = Number(argOf('concurrency', 8));
const ROUTINE_LIMIT = Number(argOf('routine-limit', 500));

export const VERDICT_EXIT = {
  CLEAN: 0,
  FINDINGS: 1,
  FINDINGS_UNREPAIRABLE: 2,
  BLIND: 3,
};

/** Statuses that need no continuation path — the work is over. */
export const TERMINAL_STATUSES = new Set(['done', 'cancelled']);
/**
 * `backlog` is deliberately NOT swept. It is the company's parking lot, it is
 * not "resting behind" anything, and nobody declared a monitor for it. Sweeping
 * it would bury 5 real findings under 29 by-design ones.
 */
export const SWEPT_STATUSES = new Set(['todo', 'in_progress', 'in_review', 'blocked']);

export const PATH = {
  PARKED_READY: 'PARKED_READY',
  LIVE_RUN: 'LIVE_RUN',
  LINKED_ROUTINE: 'LINKED_ROUTINE',
  PLATFORM_MONITOR: 'PLATFORM_MONITOR',
  OPEN_BLOCKER: 'OPEN_BLOCKER',
  OPEN_INTERACTION: 'OPEN_INTERACTION',
};

export const FINDING = {
  /** Nothing is coming. No routine anywhere even names this issue. */
  PHANTOM_REST: 'PHANTOM_REST',
  /**
   * A live routine is TITLED for this issue but is not attached to it. It will
   * fire; it will not wake this leaf, and nothing will re-disposition it.
   */
  UNLINKED_MONITOR: 'UNLINKED_MONITOR',
};

const isFuture = (iso, nowMs) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > nowMs;
};

/* ------------------------------------------------------------------ *
 * Routine liveness — the whole point is that every NO here reads exactly
 * like a YES on the routine root.
 * ------------------------------------------------------------------ */

/**
 * Is this routine going to fire again?
 *
 * Returns { live, reason } — the reason is kept even on the true branch so the
 * report can say WHICH trigger it is resting on, and so a control can assert we
 * rejected a near-miss for the RIGHT cause rather than by accident.
 */
export function routineLiveness(routine, nowMs) {
  if (!routine) return { live: false, reason: 'no routine' };
  if (routine.status !== 'active') return { live: false, reason: `status=${routine.status ?? 'null'}` };

  // TRAP 2. `routine.nextRunAt` is not a field; reading it yields undefined on
  // an armed routine and on a triggerless one alike.
  const triggers = Array.isArray(routine.triggers) ? routine.triggers : [];
  if (triggers.length === 0) return { live: false, reason: 'no triggers[] (a root nextRunAt is not arming)' };

  const armed = triggers.filter((t) => t && t.enabled === true && t.nextRunAt);
  if (armed.length === 0) return { live: false, reason: 'no trigger is enabled with a nextRunAt' };

  const future = armed.filter((t) => isFuture(t.nextRunAt, nowMs));
  if (future.length === 0) {
    return { live: false, reason: `every nextRunAt is in the past (${armed.map((t) => t.nextRunAt).join(', ')})` };
  }

  future.sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
  return { live: true, reason: `next fire ${future[0].nextRunAt}`, nextRunAt: future[0].nextRunAt };
}

/**
 * Does this routine's TITLE name this identifier?
 *
 * Bounded on both sides so `TRA-900` does not match inside `TRA-9001` and
 * `TRA-9001` does not match inside `TRA-90012`. Title only — see trap 5.
 */
export function titleNames(title, identifier) {
  if (!title || !identifier) return false;
  const esc = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${esc}(?![A-Za-z0-9-])`).test(title);
}

/**
 * Index the routine population once: linked-by-parent, titled-by-identifier,
 * and the live subset. Pure — the caller supplies both routines and the
 * identifiers in play.
 */
export function indexRoutines(routines, identifiers, nowMs) {
  const byParent = new Map();
  const titled = new Map();
  const live = [];
  const stale = [];

  for (const r of Array.isArray(routines) ? routines : []) {
    if (!r || !r.id) continue;
    const liveness = routineLiveness(r, nowMs);
    if (!liveness.live) {
      if (r.status === 'active') stale.push({ routine: r, reason: liveness.reason });
      continue;
    }
    live.push({ routine: r, liveness });
    if (r.parentIssueId) {
      if (!byParent.has(r.parentIssueId)) byParent.set(r.parentIssueId, []);
      byParent.get(r.parentIssueId).push({ routine: r, liveness });
    }
  }

  for (const ident of identifiers) {
    const hits = live.filter((e) => titleNames(e.routine.title, ident));
    if (hits.length) titled.set(ident, hits);
  }

  return { byParent, titled, live, stale };
}

/* ------------------------------------------------------------------ *
 * Declared-routine references (advisory)
 * ------------------------------------------------------------------ */

const UUID_RE = /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/gi;
const SHORT_RE = /(?<![0-9a-f-])[0-9a-f]{8}(?![0-9a-f-])/gi;

/**
 * Pull routine ids out of prose that talks about routines.
 *
 * TRAP 7: full UUIDs are consumed FIRST and removed from the window before the
 * short-id pass, otherwise the last 8 hex of a UUID is harvested as a separate
 * — and always missing — routine id.
 */
export function extractDeclaredRoutineRefs(text) {
  const out = new Map();
  const body = String(text || '');
  for (const m of body.matchAll(/routines?\b[^\n]{0,90}/gi)) {
    const window = m[0];
    for (const u of window.match(UUID_RE) || []) out.set(u.toLowerCase(), { kind: 'uuid', token: u.toLowerCase(), context: window.trim() });
    const rest = window.replace(UUID_RE, ' ');
    for (const s of rest.match(SHORT_RE) || []) {
      const tok = s.toLowerCase();
      if (!out.has(tok)) out.set(tok, { kind: 'short', token: tok, context: window.trim() });
    }
  }
  return [...out.values()];
}

export function resolveDeclaredRefs(refs, routines) {
  const full = new Set((routines || []).map((r) => String(r.id || '').toLowerCase()));
  const short = new Set([...full].map((id) => id.slice(0, 8)));
  return refs.filter((ref) => (ref.kind === 'uuid' ? !full.has(ref.token) : !short.has(ref.token)));
}

/* ------------------------------------------------------------------ *
 * Classification of ONE issue
 * ------------------------------------------------------------------ */

/**
 * @param issue  the LIST-route row (status, monitorNextCheckAt, activeRun, …)
 * @param item   the ITEM-route payload, or null if it was not read/failed
 * @param interactions array, or null if not read/failed
 *
 * Returns { paths[], finding, unreadable, notes[] }. `unreadable` is a reason
 * string: an issue we could not fully read is NEVER a finding and NEVER a pass.
 */
export function classifyIssue({ issue, item, interactions, index, nowMs }) {
  const paths = [];
  const notes = [];

  if (issue.status === 'todo') paths.push({ path: PATH.PARKED_READY, detail: 'todo — parked-ready is a legal rest' });

  const run = issue.activeRun || item?.activeRun || null;
  if (run || issue.checkoutRunId || item?.checkoutRunId) {
    paths.push({ path: PATH.LIVE_RUN, detail: run?.status ? `run ${run.id?.slice(0, 8)} ${run.status}` : 'checkout held' });
  }

  for (const entry of index.byParent.get(issue.id) || []) {
    paths.push({
      path: PATH.LINKED_ROUTINE,
      detail: `${entry.routine.id.slice(0, 8)} "${entry.routine.title}" — ${entry.liveness.reason}`,
    });
  }

  if (isFuture(issue.monitorNextCheckAt || item?.monitorNextCheckAt, nowMs)) {
    paths.push({
      path: PATH.PLATFORM_MONITOR,
      detail: `monitorNextCheckAt ${issue.monitorNextCheckAt || item?.monitorNextCheckAt}` +
        (issue.monitorScheduledBy ? ` (by ${issue.monitorScheduledBy})` : ''),
    });
  }

  // TRAP 1. The LIST route carries no `blockedBy` key at all, so this can only
  // be graded off the ITEM route, and only once we have proved the key exists.
  if (item) {
    if (!('blockedBy' in item)) {
      return {
        paths,
        finding: null,
        unreadable:
          'item route returned no `blockedBy` key — the route shape changed. ' +
          '`(item.blockedBy || []).length === 0` would have read this as "no blockers".',
        notes,
      };
    }
    const open = (item.blockedBy || []).filter((b) => b && !TERMINAL_STATUSES.has(b.status));
    if (open.length) {
      paths.push({ path: PATH.OPEN_BLOCKER, detail: open.map((b) => `${b.identifier}(${b.status})`).join(', ') });
    } else if ((item.blockedBy || []).length) {
      // An inert blocker READS like a repair (TRA-2396).
      notes.push(`all ${item.blockedBy.length} blockedBy entries are closed — inert, not coverage`);
    }
  }

  if (Array.isArray(interactions)) {
    const open = interactions.filter(
      (i) => i && i.status === 'pending' && i.continuationPolicy && i.continuationPolicy !== 'none',
    );
    if (open.length) {
      paths.push({ path: PATH.OPEN_INTERACTION, detail: open.map((i) => `${i.kind}/${i.status}`).join(', ') });
    } else if (interactions.length) {
      const why = interactions.map((i) => `${i.kind}/${i.status}/${i.continuationPolicy}`).join(', ');
      notes.push(`interactions present but none open: ${why}`);
    }
  }

  if (paths.length) return { paths, finding: null, unreadable: null, notes };

  const titled = index.titled.get(issue.identifier) || [];
  if (titled.length) {
    return {
      paths,
      finding: {
        cls: FINDING.UNLINKED_MONITOR,
        detail: titled
          .map((e) => `${e.routine.id.slice(0, 8)} "${e.routine.title}" (parentIssueId=${e.routine.parentIssueId ?? 'null'}) — ${e.liveness.reason}`)
          .join(' | '),
      },
      unreadable: null,
      notes,
    };
  }

  return { paths, finding: { cls: FINDING.PHANTOM_REST, detail: 'no routine anywhere names this issue' }, unreadable: null, notes };
}

/* ------------------------------------------------------------------ *
 * Enumeration of the routine population
 * ------------------------------------------------------------------ */

/** Counts that are indistinguishable from a silent server-side cap. */
const ROUND_CAPS = new Set([25, 50, 100, 200, 250, 500, 1000, 2000]);

/**
 * The routines route ignores `limit` AND `offset` (trap 4), so it cannot be
 * paged and exhaustiveness cannot be proved the way the issue list proves it.
 * What we CAN do is refuse the two readings that would be indistinguishable
 * from a truncated one:
 *
 *   - an EMPTY list. A company with no routines and a route that returned
 *     nothing render identically, and the empty reading turns every leaf on the
 *     board into a finding.
 *   - a count that is exactly a round cap. 143 is not a cap; 250 is.
 *
 * and one positive check: read it twice at DIFFERENT limits. If the smaller
 * read comes back shorter, the route honours `limit` after all — in which case
 * the larger read may itself have been truncated by the server and we say so
 * rather than guessing.
 */
export async function enumerateRoutines(getRoutines, { limit = ROUTINE_LIMIT } = {}) {
  const big = await getRoutines({ limit, offset: 0 });
  if (!Array.isArray(big)) return { routines: [], blind: 'routines route returned a non-array' };
  if (big.length === 0) {
    return { routines: [], blind: 'routines route returned 0 rows — a company with no routines and an unread route are the same reading, and the empty one flags every leaf' };
  }
  if (ROUND_CAPS.has(big.length)) {
    return { routines: [], blind: `routines route returned exactly ${big.length} rows — indistinguishable from a silent cap at ${big.length}` };
  }

  const probeLimit = Math.max(1, Math.floor(big.length / 2));
  const small = await getRoutines({ limit: probeLimit, offset: 0 });
  if (!Array.isArray(small)) return { routines: [], blind: 'routines route returned a non-array on the limit probe' };
  if (small.length < big.length) {
    return {
      routines: [],
      blind:
        `routines route HONOURS limit (limit=${probeLimit} returned ${small.length} of ${big.length}) — it did not on ` +
        `2026-07-26, so paging semantics have changed and the limit=${limit} read may itself be truncated. ` +
        'Re-derive the enumeration before trusting a count.',
    };
  }

  return { routines: big, blind: null, probe: { limit, probeLimit, big: big.length, small: small.length } };
}

/* ------------------------------------------------------------------ *
 * The sweep — transport injected so the controls drive the WHOLE pipeline
 * (both enumerations + item route + interactions + classification), not just
 * the predicate. Every trap above lives in the plumbing, not the predicate.
 * ------------------------------------------------------------------ */

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function sweep(
  { getIssuesPage, getRoutines, getIssue, getInteractions, listAgents },
  opts = {},
) {
  const nowMs = opts.nowMs ?? Date.now();
  const agents = await listAgents();
  const roster = new Map((Array.isArray(agents) ? agents : []).map((a) => [a.id, a]));

  const { issues, pages, blind: enumBlind } = await enumerateIssues(getIssuesPage, opts);
  if (enumBlind) return blindResult(enumBlind, { pages });

  const { routines, blind: routineBlind, probe } = await enumerateRoutines(getRoutines, opts);
  if (routineBlind) return blindResult(routineBlind, { pages, scanned: issues.length });

  const swept = issues.filter((x) => SWEPT_STATUSES.has(x.status));
  const index = indexRoutines(routines, swept.map((x) => x.identifier), nowMs);

  const findings = [];
  const unreadable = [];
  const advisories = [];
  let itemReads = 0;
  let interactionReads = 0;

  const results = await mapLimit(swept, opts.concurrency ?? CONCURRENCY, async (issue) => {
    // Cheap paths first, from data already in hand — an issue cleared here
    // costs zero extra reads.
    const cheap = classifyIssue({ issue, item: null, interactions: null, index, nowMs });
    if (cheap.paths.length) return { issue, res: cheap };

    let item = null;
    let interactions = null;
    try {
      item = await getIssue(issue.id);
      itemReads += 1;
    } catch (err) {
      return { issue, res: { paths: [], finding: null, unreadable: `item route failed: ${err?.message || err}`, notes: [] } };
    }
    try {
      interactions = await getInteractions(issue.id);
      interactionReads += 1;
    } catch (err) {
      return {
        issue,
        res: { paths: [], finding: null, unreadable: `interactions route failed: ${err?.message || err}`, notes: [] },
      };
    }
    return { issue, res: classifyIssue({ issue, item, interactions, index, nowMs }) };
  });

  for (const { issue, res } of results) {
    if (res.unreadable) {
      unreadable.push({ identifier: issue.identifier, status: issue.status, reason: res.unreadable });
      continue;
    }
    if (!res.finding) continue;
    const assignee = issue.assigneeAgentId ? roster.get(issue.assigneeAgentId) : null;
    findings.push({
      identifier: issue.identifier,
      id: issue.id,
      status: issue.status,
      title: issue.title,
      cls: res.finding.cls,
      detail: res.finding.detail,
      notes: res.notes,
      assigneeAgentId: issue.assigneeAgentId || null,
      assigneeName: assignee?.name || null,
      routable: Boolean(assignee),
      alsoBlockedEmptyShape: issue.status === 'blocked',
    });
  }

  // Advisory pass — free, the list route carries `description`.
  for (const issue of swept) {
    const missing = resolveDeclaredRefs(extractDeclaredRoutineRefs(issue.description), routines);
    for (const ref of missing) {
      advisories.push({ identifier: issue.identifier, status: issue.status, token: ref.token, kind: ref.kind, context: ref.context });
    }
  }

  // A zero count over a partially-read population is the forbidden reading.
  if (findings.length === 0 && unreadable.length > 0) {
    return blindResult(
      `0 findings over ${swept.length} swept issues, but ${unreadable.length} could not be read — ` +
        'a clean bill of health computed off unread rows is exactly this detector\'s subject',
      { pages, scanned: swept.length, unreadable, itemReads, interactionReads },
    );
  }

  const verdict = findings.length === 0
    ? 'CLEAN'
    : findings.some((f) => !f.routable)
      ? 'FINDINGS_UNREPAIRABLE'
      : 'FINDINGS';

  return {
    verdict,
    blind: null,
    pages,
    scanned: swept.length,
    population: issues.length,
    routineCount: routines.length,
    routineProbe: probe,
    liveRoutines: index.live.length,
    staleActiveRoutines: index.stale,
    itemReads,
    interactionReads,
    findings,
    unreadable,
    advisories,
    roster,
  };
}

function blindResult(blind, extra = {}) {
  return {
    verdict: 'BLIND',
    blind,
    pages: [],
    scanned: 0,
    findings: [],
    unreadable: [],
    advisories: [],
    itemReads: 0,
    interactionReads: 0,
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * Report. Routes; never repairs. No status PATCH is emitted for any board —
 * asserted by a global control.
 * ------------------------------------------------------------------ */

export function renderReport(r) {
  const L = [];
  L.push('TRA-2422 — PHANTOM REST sweep (a non-terminal issue with no live continuation path)');
  L.push('');

  if (r.verdict === 'BLIND') {
    L.push('VERDICT: BLIND — the enumeration is untrustworthy. This is NOT a pass.');
    L.push(`  ${r.blind}`);
    if (r.unreadable?.length) for (const u of r.unreadable) L.push(`  unread: ${u.identifier} (${u.status}) — ${u.reason}`);
    return L;
  }

  L.push(
    `population ${r.population} issues · swept ${r.scanned} non-terminal · ` +
      `routines ${r.routineCount} (${r.liveRoutines} live) · item reads ${r.itemReads} · interaction reads ${r.interactionReads}`,
  );
  L.push('');

  if (r.verdict === 'CLEAN') {
    L.push('VERDICT: CLEAN — every swept issue has at least one live continuation path.');
  } else {
    L.push(`VERDICT: ${r.verdict} — ${r.findings.length} issue(s) resting on nothing.`);
    L.push('');
    for (const cls of [FINDING.PHANTOM_REST, FINDING.UNLINKED_MONITOR]) {
      const set = r.findings.filter((f) => f.cls === cls);
      if (!set.length) continue;
      L.push(
        cls === FINDING.PHANTOM_REST
          ? `${cls} (${set.length}) — nothing is coming. No routine anywhere names these.`
          : `${cls} (${set.length}) — a live routine is TITLED for these but is not attached to them.` +
            ' It will fire; it will not wake the leaf, and nothing will re-disposition it.',
      );
      for (const f of set) {
        L.push(`  ${f.identifier} [${f.status}] ${f.title?.slice(0, 88) ?? ''}`);
        L.push(`      owner: ${f.assigneeName || f.assigneeAgentId || 'UNASSIGNED'}${f.routable ? '' : '  ⛔ NOT REPAIRABLE BY ANY AGENT — needs a human'}`);
        L.push(`      ${f.detail}`);
        for (const n of f.notes) L.push(`      note: ${n}`);
        if (f.alsoBlockedEmptyShape) L.push('      note: status=blocked — cross-check `pnpm check:blocked-empty` for the anchor verdict');
      }
      L.push('');
    }
    L.push('REPAIR IS THE OWNER\'S CALL. Do NOT auto-park these: the usual fix is to arm the');
    L.push('monitor that was promised, and only the owner knows what it was supposed to run.');
    L.push('');
  }

  if (r.staleActiveRoutines?.length) {
    L.push(`ACTIVE ROUTINES THAT WILL NOT FIRE (${r.staleActiveRoutines.length}) — status=active reads like armed:`);
    for (const s of r.staleActiveRoutines) L.push(`  ${s.routine.id.slice(0, 8)} "${s.routine.title?.slice(0, 70)}" — ${s.reason}`);
    L.push('');
  }

  if (r.advisories?.length) {
    L.push(`ADVISORY — issue bodies naming a routine id that resolves to nothing (${r.advisories.length}).`);
    L.push('An 8-hex token is also the shape of a short commit sha. Judge these by hand; they do not move the verdict.');
    for (const a of r.advisories) L.push(`  ${a.identifier} [${a.status}] ${a.token} — "${a.context.slice(0, 100)}"`);
    L.push('');
  }

  if (r.unreadable?.length) {
    L.push(`UNREADABLE (${r.unreadable.length}) — neither a finding nor a pass:`);
    for (const u of r.unreadable) L.push(`  ${u.identifier} (${u.status}) — ${u.reason}`);
    L.push('');
  }

  return L;
}

/* ================================================================== *
 * Controls
 * ================================================================== */

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const FUTURE = '2026-07-27T20:50:00.000Z';
const PAST = '2026-07-20T20:50:00.000Z';

const ROSTER = [
  { id: 'agent-cto', name: 'CTO' },
  { id: 'agent-cfo', name: 'CFO' },
];

const issueRow = (identifier, over = {}) => ({
  id: `id-${identifier}`,
  identifier,
  title: `${identifier} title`,
  status: 'in_review',
  assigneeAgentId: 'agent-cto',
  description: '',
  monitorNextCheckAt: null,
  monitorScheduledBy: null,
  activeRun: null,
  checkoutRunId: null,
  parentId: null,
  ...over,
});

const routineRow = (id, over = {}) => ({
  id,
  title: 'a routine',
  status: 'active',
  parentIssueId: null,
  triggers: [{ id: `${id}-t`, enabled: true, cronExpression: '50 16 * * 1', nextRunAt: FUTURE }],
  ...over,
});

/**
 * Board -> transport. `items` maps issue id to the ITEM-route payload; anything
 * absent gets a default payload carrying an EMPTY-BUT-PRESENT `blockedBy`.
 */
function transportFor({
  issues,
  // An EMPTY routine list is itself a BLIND verdict (trap 4b), so every board
  // that is not specifically testing that carries one unrelated routine.
  routines = [routineRow('r-unrelated', { title: 'an unrelated watch' })],
  items = {},
  interactions = {},
  routineRoute,
  issueRoute,
  agents = ROSTER,
}) {
  return {
    listAgents: async () => agents,
    getIssuesPage: issueRoute || (async ({ offset }) => (offset === 0 ? issues : [])),
    getRoutines: routineRoute || (async () => routines),
    getIssue: async (id) => {
      const override = items[id];
      if (override === 'throw') throw new Error('HTTP 403 — outside this actor\'s authorization boundary');
      const base = issues.find((x) => x.id === id) || { id };
      return { ...base, blockedBy: [], ...(override || {}) };
    },
    getInteractions: async (id) => interactions[id] || [],
  };
}

const CASES = [
  {
    name: 'THE SHAPE — in_review, no routine, no monitor, no interaction, no blockers => PHANTOM_REST',
    build: () => transportFor({ issues: [issueRow('TRA-9001')], routines: [routineRow('r-unrelated')] }),
    expect: (r) => {
      assert(r.verdict === 'FINDINGS', `verdict ${r.verdict}`);
      assert(r.findings.length === 1 && r.findings[0].cls === FINDING.PHANTOM_REST, 'expected one PHANTOM_REST');
    },
  },
  {
    name: 'a LINKED, active, future-triggered routine => CLEAN',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routines: [routineRow('r-linked', { parentIssueId: 'id-TRA-9001' })],
      }),
    expect: (r) => assert(r.verdict === 'CLEAN', `verdict ${r.verdict}`),
  },
  {
    name: 'TRAP 3 — the linked routine is ARCHIVED (right minute, wrong status) => still a finding',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routines: [routineRow('r-arch', { parentIssueId: 'id-TRA-9001', status: 'archived' })],
      }),
    expect: (r) => assert(r.findings.length === 1, 'archived routine must not confer coverage'),
  },
  {
    name: 'TRAP 3b — the linked routine is PAUSED => still a finding',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routines: [routineRow('r-paused', { parentIssueId: 'id-TRA-9001', status: 'paused' })],
      }),
    expect: (r) => assert(r.findings.length === 1, 'paused routine must not confer coverage'),
  },
  {
    name: 'TRAP 2 — nextRunAt on the ROUTINE ROOT with triggers:[] => still a finding',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routines: [routineRow('r-root', { parentIssueId: 'id-TRA-9001', triggers: [], nextRunAt: FUTURE })],
      }),
    expect: (r) => assert(r.findings.length === 1, 'a root-level nextRunAt is not arming'),
  },
  {
    name: 'TRAP 2b — the trigger exists but enabled:false => still a finding',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routines: [
          routineRow('r-off', { parentIssueId: 'id-TRA-9001', triggers: [{ enabled: false, nextRunAt: FUTURE }] }),
        ],
      }),
    expect: (r) => assert(r.findings.length === 1, 'a disabled trigger is not arming'),
  },
  {
    name: 'TRAP 2c — the trigger is enabled but nextRunAt is null => still a finding',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routines: [routineRow('r-null', { parentIssueId: 'id-TRA-9001', triggers: [{ enabled: true, nextRunAt: null }] }),
        ],
      }),
    expect: (r) => assert(r.findings.length === 1, 'a null nextRunAt is not arming'),
  },
  {
    name: 'an ELAPSED schedule (active + enabled + nextRunAt in the PAST) => finding, and named as stale',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routines: [routineRow('r-past', { parentIssueId: 'id-TRA-9001', triggers: [{ enabled: true, nextRunAt: PAST }] }),
        ],
      }),
    expect: (r) => {
      assert(r.findings.length === 1, 'an elapsed trigger is not coverage');
      assert(r.staleActiveRoutines.length === 1, 'an active-but-dead routine must be surfaced');
    },
  },
  {
    name: 'TRAP 5 — a live routine TITLED for the leaf but parentIssueId=null => UNLINKED_MONITOR, not PHANTOM_REST',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routines: [routineRow('r-titled', { title: 'TRA-9001 post-close grade', parentIssueId: null })],
      }),
    expect: (r) => {
      assert(r.findings.length === 1, 'expected one finding');
      assert(r.findings[0].cls === FINDING.UNLINKED_MONITOR, `expected UNLINKED_MONITOR, got ${r.findings[0].cls}`);
    },
  },
  {
    name: 'TRAP 5b — the identifier appears only in the routine DESCRIPTION => NO coverage (PHANTOM_REST)',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routines: [routineRow('r-desc', { title: 'deploy train', description: 'ships TRA-9001 and TRA-9002' })],
      }),
    expect: (r) => assert(r.findings[0].cls === FINDING.PHANTOM_REST, 'a description mention is not a monitor'),
  },
  {
    name: 'TRAP 5c — prefix collision: a routine titled TRA-900 does not cover TRA-9001 (nor 9001 -> 90012)',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001'), issueRow('TRA-90012')],
        routines: [routineRow('r-900', { title: 'TRA-900 grade' })],
      }),
    expect: (r) => {
      assert(r.findings.length === 2, `expected both to remain findings, got ${r.findings.length}`);
      assert(r.findings.every((f) => f.cls === FINDING.PHANTOM_REST), 'prefix match must not confer coverage');
    },
  },
  {
    name: 'TRAP 1 — blockedByIssueIds is undefined on GET while blockedBy carries an OPEN entry => NOT a finding',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001', { status: 'blocked' })],
        items: { 'id-TRA-9001': { blockedBy: [{ identifier: 'TRA-1', status: 'in_progress' }], blockedByIssueIds: undefined } },
      }),
    expect: (r) => assert(r.verdict === 'CLEAN', 'an open blockedBy entry is a continuation path'),
  },
  {
    name: 'an INERT blocker (every blockedBy entry done/cancelled) => still a finding, and said so',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001', { status: 'blocked' })],
        items: { 'id-TRA-9001': { blockedBy: [{ identifier: 'TRA-1', status: 'done' }] } },
      }),
    expect: (r) => {
      assert(r.findings.length === 1, 'a closed blocker is not a live path');
      assert(r.findings[0].notes.some((n) => /inert/.test(n)), 'must explain why the blocker did not count');
    },
  },
  {
    name: 'a PENDING interaction with a wake policy => CLEAN',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        interactions: { 'id-TRA-9001': [{ kind: 'request_confirmation', status: 'pending', continuationPolicy: 'wake_assignee' }] },
      }),
    expect: (r) => assert(r.verdict === 'CLEAN', `verdict ${r.verdict}`),
  },
  {
    name: 'TRAP 6 — an EXPIRED interaction reads like an interaction => still a finding',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        interactions: { 'id-TRA-9001': [{ kind: 'request_confirmation', status: 'expired', continuationPolicy: 'wake_assignee' }] },
      }),
    expect: (r) => {
      assert(r.findings.length === 1, 'expired is not open');
      assert(r.findings[0].notes.some((n) => /expired/.test(n)), 'must say the interaction was there but closed');
    },
  },
  {
    name: 'TRAP 6b — a PENDING interaction with continuationPolicy:none wakes nobody => still a finding',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        interactions: { 'id-TRA-9001': [{ kind: 'ask_user_questions', status: 'pending', continuationPolicy: 'none' }] },
      }),
    expect: (r) => assert(r.findings.length === 1, 'pending + no continuation is not a wake'),
  },
  {
    name: 'a future PLATFORM MONITOR => CLEAN (7 live leaves rest on this; omitting it invents 7 findings)',
    build: () => transportFor({ issues: [issueRow('TRA-9001', { monitorNextCheckAt: FUTURE, monitorScheduledBy: 'assignee' })] }),
    expect: (r) => assert(r.verdict === 'CLEAN', `verdict ${r.verdict}`),
  },
  {
    name: 'a PAST platform monitor => finding (an elapsed check is not a pending one)',
    build: () => transportFor({ issues: [issueRow('TRA-9001', { monitorNextCheckAt: PAST })] }),
    expect: (r) => assert(r.findings.length === 1, 'an elapsed monitorNextCheckAt is not coverage'),
  },
  {
    name: 'status=todo with nothing attached => PARKED_READY, never a finding',
    build: () => transportFor({ issues: [issueRow('TRA-9001', { status: 'todo' })] }),
    expect: (r) => assert(r.verdict === 'CLEAN', 'todo is a legal rest'),
  },
  {
    name: 'a LIVE RUN attached => CLEAN (this run is a continuation by definition)',
    build: () => transportFor({ issues: [issueRow('TRA-9001', { status: 'in_progress', activeRun: { id: 'run-1', status: 'running' } })] }),
    expect: (r) => assert(r.verdict === 'CLEAN', `verdict ${r.verdict}`),
  },
  {
    name: 'backlog and done are NOT swept',
    build: () =>
      transportFor({ issues: [issueRow('TRA-9001', { status: 'backlog' }), issueRow('TRA-9002', { status: 'done' })] }),
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `verdict ${r.verdict}`);
      assert(r.scanned === 0, `swept ${r.scanned}, expected 0`);
    },
  },
  {
    name: 'an UNASSIGNED / off-roster owner on a finding => FINDINGS_UNREPAIRABLE (needs a human)',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001', { assigneeAgentId: null }), issueRow('TRA-9002', { assigneeAgentId: 'agent-gone' })],
      }),
    expect: (r) => {
      assert(r.verdict === 'FINDINGS_UNREPAIRABLE', `verdict ${r.verdict}`);
      assert(r.findings.every((f) => !f.routable), 'both must be flagged unrepairable');
    },
  },
  {
    name: 'TRAP 4 — the routines route returns exactly the requested limit and ignores offset => BLIND',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routineRoute: async ({ limit }) => Array.from({ length: Math.min(limit, 500) }, (_, i) => routineRow(`r-${i}`)),
      }),
    expect: (r) => assert(r.verdict === 'BLIND', `verdict ${r.verdict} — a capped routine list invents phantoms`),
  },
  {
    name: 'TRAP 4b — the routines route returns [] => BLIND, never "every leaf is a phantom"',
    build: () => transportFor({ issues: [issueRow('TRA-9001')], routineRoute: async () => [] }),
    expect: (r) => assert(r.verdict === 'BLIND', `verdict ${r.verdict}`),
  },
  {
    name: 'TRAP 4c — the routines route starts HONOURING limit => BLIND (paging semantics changed)',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        routineRoute: async ({ limit }) => Array.from({ length: Math.min(limit, 143) }, (_, i) => routineRow(`r-${i}`)),
      }),
    expect: (r) => assert(r.verdict === 'BLIND', `verdict ${r.verdict}`),
  },
  {
    name: 'TRAP 1b — the ITEM route carries no blockedBy key at all => BLIND, never a pass and never a flag',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001', { status: 'blocked' })],
        items: { 'id-TRA-9001': { blockedByIssueIds: undefined, blockedBy: undefined } },
        routines: [routineRow('r-x')],
      }),
    // the default item payload spreads `blockedBy: []` first, so blow it away
    // by handing back a payload that genuinely lacks the key
    expectSetup: true,
    expect: (r) => assert(r.verdict === 'BLIND', `verdict ${r.verdict}`),
  },
  {
    name: 'the ISSUE list route ignores offset => BLIND (shared enumerator guard still wired up)',
    build: () =>
      transportFor({
        issues: [],
        issueRoute: async ({ limit }) => Array.from({ length: limit }, (_, i) => issueRow(`TRA-${i}`)),
      }),
    opts: { limit: 5, maxPages: 4 },
    expect: (r) => assert(r.verdict === 'BLIND', `verdict ${r.verdict}`),
  },
  {
    name: 'an UNREADABLE candidate with zero findings => BLIND, never CLEAN',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001')],
        items: { 'id-TRA-9001': 'throw' },
        routines: [routineRow('r-titled', { title: 'TRA-9001 watch' })],
      }),
    expect: (r) => assert(r.verdict === 'BLIND', `verdict ${r.verdict}`),
  },
  {
    name: 'TRAP 7 — an 8-hex tail INSIDE a UUID is not a missing routine',
    build: () =>
      transportFor({
        issues: [
          issueRow('TRA-9001', {
            monitorNextCheckAt: FUTURE,
            description: 'The executor is now routine `45453555-80ed-4065-96d6-24ab8b77cbcc`',
          }),
        ],
        routines: [routineRow('45453555-80ed-4065-96d6-24ab8b77cbcc')],
      }),
    expect: (r) => assert(r.advisories.length === 0, `expected no advisory, got ${JSON.stringify(r.advisories)}`),
  },
  {
    name: 'ADVISORY — a declared routine id that resolves to nothing is reported, and does NOT move the verdict',
    build: () =>
      transportFor({
        issues: [issueRow('TRA-9001', { monitorNextCheckAt: FUTURE, description: 'armed on routine `deadbeef`' })],
        routines: [routineRow('r-x')],
      }),
    expect: (r) => {
      assert(r.verdict === 'CLEAN', `advisory must not change the verdict (got ${r.verdict})`);
      assert(r.advisories.length === 1 && r.advisories[0].token === 'deadbeef', 'expected the declared id to be reported');
    },
  },
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * The naive predicate the ticket proposed verbatim — `parentIssueId` only, no
 * title tier, no platform monitor. Kept as a CONTROL so the divergence is
 * measured rather than argued.
 */
function naivePredicate(issues, routines, nowMs) {
  const linked = new Set(routines.filter((r) => routineLiveness(r, nowMs).live && r.parentIssueId).map((r) => r.parentIssueId));
  return issues.filter((x) => SWEPT_STATUSES.has(x.status) && x.status !== 'todo' && !linked.has(x.id));
}

async function selftest() {
  let pass = 0;
  const seen = new Set();
  const renders = [];

  for (const c of CASES) {
    let t = c.build();
    if (c.name.startsWith('TRAP 1b')) {
      // A payload that genuinely lacks the key — the default builder always
      // spreads one in, and this control is precisely about its absence.
      t = { ...t, getIssue: async (id) => ({ id, identifier: 'TRA-9001', status: 'blocked' }) };
    }
    const r = await sweep(t, { nowMs: NOW, ...(c.opts || {}) });
    seen.add(r.verdict);
    renders.push(renderReport(r).join('\n'));
    try {
      c.expect(r);
      console.log(`ok    ${c.name}`);
      pass += 1;
    } catch (err) {
      console.log(`FAIL  ${c.name}\n        ${err.message}`);
    }
  }

  // GLOBAL — the ticket is explicit: report, do not auto-park. A repair command
  // in the output would be copy-pasted regardless of the prose around it.
  const all = renders.join('\n');
  const banned = /PATCH \/api\/issues|"status"\s*:\s*"(todo|backlog|done)"/;
  if (banned.test(all)) {
    console.log('FAIL  GLOBAL — a rendering emitted a copy-pasteable status PATCH');
  } else {
    console.log('ok    GLOBAL — no rendering of ANY control board emits an auto-park PATCH');
    pass += 1;
  }

  // DIVERGENCE — the ticket's literal predicate vs this one, on a board shaped
  // like the live one: four title-linked watches and one true phantom.
  const board = [
    issueRow('TRA-2242', { status: 'blocked' }),
    issueRow('TRA-2331', { status: 'blocked' }),
    issueRow('TRA-2377', { status: 'blocked' }),
    issueRow('TRA-2356'),
    issueRow('TRA-382', { status: 'blocked' }),
  ];
  const boardRoutines = [
    routineRow('20d3357e', { title: 'TRA-2242 marketable-MTM accrual watch' }),
    routineRow('7c3af47e', { title: 'TRA-2331 armed-demo grade' }),
    routineRow('f812e08d', { title: 'TRA-2377 ask 2 - publish parity-reconcile' }),
    routineRow('0d84ed70', { title: 'TRA-2356 one-shot - verify suppression' }),
    routineRow('e1b97e28', { title: 'Run option-chain replay - TRA-381 retry', description: 'TRA-382 chains' }),
  ];
  const naive = naivePredicate(board, boardRoutines, NOW);
  const r = await sweep(transportFor({ issues: board, routines: boardRoutines }), { nowMs: NOW });
  const hard = r.findings.filter((f) => f.cls === FINDING.PHANTOM_REST);
  if (naive.length === 5 && r.findings.length === 5 && hard.length === 1 && hard[0].identifier === 'TRA-382') {
    console.log('ok    DIVERGENCE — the ticket\'s literal `parentIssueId` predicate calls all 5 phantoms;');
    console.log('        this one separates 4 UNLINKED_MONITOR from the 1 true PHANTOM_REST (TRA-382)');
    pass += 1;
  } else {
    console.log(
      `FAIL  DIVERGENCE — naive ${naive.length}, findings ${r.findings.length}, hard ${hard.length} (${hard.map((f) => f.identifier).join(',')})`,
    );
  }

  const total = CASES.length + 2;
  console.log('');
  console.log(`${pass}/${total} controls pass; verdicts reachable: ${[...seen].sort().join(', ')}`);
  for (const v of ['CLEAN', 'FINDINGS', 'FINDINGS_UNREPAIRABLE', 'BLIND']) {
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
  // NEVER coerce a miss to [] — an empty array is indistinguishable from a
  // clean board here, and on the routines route it flags the entire company.
  const unwrap = (b, key) => {
    if (Array.isArray(b)) return b;
    if (b && Array.isArray(b[key])) return b[key];
    if (b && Array.isArray(b.data)) return b.data;
    return null;
  };
  return {
    listAgents: async () => unwrap(await get(`${BASE}/api/companies/${CO}/agents`), 'agents') || [],
    getIssuesPage: async ({ limit, offset }) =>
      unwrap(await get(`${BASE}/api/companies/${CO}/issues?limit=${limit}&offset=${offset}`), 'issues'),
    getRoutines: async ({ limit, offset }) =>
      unwrap(await get(`${BASE}/api/companies/${CO}/routines?limit=${limit}&offset=${offset}`), 'routines'),
    getIssue: async (id) => get(`${BASE}/api/issues/${id}`),
    getInteractions: async (id) => unwrap(await get(`${BASE}/api/issues/${id}/interactions`), 'interactions'),
  };
}

async function main() {
  if (argv.includes('--selftest')) return selftest();

  const nowArg = argOf('now', null);
  const nowMs = nowArg ? Date.parse(nowArg) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`--now is not a parseable timestamp: ${nowArg}`);

  const result = await sweep(liveTransport(), {
    limit: PAGE_LIMIT,
    maxPages: MAX_PAGES,
    concurrency: CONCURRENCY,
    routineLimit: ROUTINE_LIMIT,
    nowMs,
  });

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          issue: 'TRA-2422',
          checkedAt: new Date(nowMs).toISOString(),
          verdict: result.verdict,
          blind: result.blind,
          population: result.population,
          scanned: result.scanned,
          routineCount: result.routineCount,
          liveRoutines: result.liveRoutines,
          itemReads: result.itemReads,
          interactionReads: result.interactionReads,
          findings: result.findings,
          staleActiveRoutines: (result.staleActiveRoutines || []).map((s) => ({ id: s.routine.id, title: s.routine.title, reason: s.reason })),
          advisories: result.advisories,
          unreadable: result.unreadable,
        },
        null,
        2,
      ),
    );
  } else {
    for (const l of renderReport(result)) console.log(l);
  }
  return VERDICT_EXIT[result.verdict] ?? 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('ERROR', err?.stack || err);
    process.exit(3);
  });
