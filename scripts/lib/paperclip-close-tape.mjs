/**
 * TRA-3372 — the CLOSE tape: who closed a routine's execution issue, and who
 * owned it at that instant.
 *
 * WHY THIS EXISTS
 * ---------------
 * `check:routine-dispatch` grades a dispatch tail `EXECUTION_ISSUE_ABANDONED`
 * when the dispatch SUCCEEDED and the issue it spawned was later moved to
 * blocked/cancelled, and it routes that finding to the ROUTINE OWNER. That is
 * the right default — the routine is theirs — but the sentence the owner reads
 * is "your spawned issue was closed non-done", and on 2026-08-12 that landed on
 * an owner (QuantTrader, TRA-3372) who did not write two of the three closes:
 * the 08-12 mass-strand cleanup did, on issues that the platform's own
 * strand-recovery had already re-homed AWAY from them first.
 *
 * The owner had to reconstruct all of that by hand, from the activity log,
 * before they could answer a yes/no question. The facts that make the finding
 * actionable — the CLOSING ACTOR and the ASSIGNEE AT CLOSE — are two joins
 * away from a check that already holds a Postgres connection for the pause
 * tape, so it should carry them.
 *
 * WHAT THIS TAPE IS — verified against the running platform's own DB on
 * 2026-08-13 (TRA-3195 / TRA-3196 / TRA-3203, the three TRA-3372 rows):
 *
 *   `activity_log` action `issue.updated`, entity_type `issue`, entity_id = the
 *   issue id. ⛔ Unlike `agent.updated` (which records the KEY and never the
 *   VALUE — see paperclip-pause-tape.mjs), `issue.updated` details carry BOTH
 *   the new value AND a `_previous` block. So status and assignee transitions
 *   are recoverable EXACTLY, not inferred.
 *
 *   The ACTOR is `actor_type`/`actor_id`, NOT `agent_id`. `agent_id` is NULL on
 *   every `system` and `user` write (measured: 867 system + 572 local-board
 *   rows on this company), so reading the actor off `agent_id` alone reports
 *   "nobody" for exactly the writes an owner most needs named — including the
 *   platform's own strand-recovery, which is the true writer of many closes.
 *
 * ⛔⛔ THE HOLE THAT FORCES BACKWARD REPLAY
 * `recovery.reconcile_stranded_assigned_issue` RE-HOMES the issue — it sets the
 * assignee to `recoveryOwnerAgentId` — and it does **not** log an
 * `assigneeAgentId` key at all. A forward replay that only followed
 * `assigneeAgentId` would therefore miss every recovery re-home and report the
 * ORIGINAL owner as the assignee at close, which is the precise error this
 * whole file exists to stop.
 *
 * So the assignee at close is replayed BACKWARD from the issue's CURRENT
 * assignee (read live from the `issues` row), undoing each later write from the
 * "before" value that write recorded:
 *   - a plain `issue.updated` carrying `assigneeAgentId` → `_previous.assigneeAgentId`
 *   - a `recovery.*` row carrying `recoveryOwnerAgentId` → `previousOwnerAgentId`
 * Every other row is a no-op for the assignee. A write that MOVED the assignee
 * but recorded no readable "before" value yields UNKNOWN for the whole replay.
 *
 * Cross-check that validated the model on live data (TRA-3196): the recovery
 * row at 2026-08-11T18:53:59Z re-homed to `d492a648` while logging no
 * `assigneeAgentId`, and the next EXPLICIT assignee write, 33h later, recorded
 * `_previous.assigneeAgentId = d492a648`. The two independent readings agree.
 *
 * ⛔ EVERY FAILURE PATH IS UNKNOWN, NEVER "the owner did it". An unreadable
 * tape, a missing close row, an ambiguous replay: all return UNKNOWN with a
 * reason. UNKNOWN is not the benign value — it means the finding still has to
 * be reconstructed by hand, which is the status quo this improves on, not a
 * regression past it.
 */

import { loadPgClient, DEFAULT_DB_URL } from './paperclip-pause-tape.mjs';

/** What a close attribution can conclude. */
export const CLOSE_ATTRIBUTION = {
  RESOLVED: 'RESOLVED',
  UNKNOWN: 'UNKNOWN',
};

/** The activity_log action the close tape is built from. */
export const CLOSE_ACTION = 'issue.updated';

/** A readable tape with no issues in it. */
export function emptyCloseTape(over = {}) {
  return { ok: true, issues: new Map(), source: 'synthetic', ...over };
}

/** An unreadable tape. Every attribution against it is UNKNOWN. */
export function blindCloseTape(reason) {
  return { ok: false, reason: String(reason || 'unspecified'), issues: new Map(), source: null };
}

const UNKNOWN = (why) => ({
  attribution: CLOSE_ATTRIBUTION.UNKNOWN,
  closedAt: null,
  closedByActorType: null,
  closedByActorId: null,
  assigneeAtCloseAgentId: null,
  why,
});

/**
 * Did this row's `details` state a status TRANSITION (as opposed to restating
 * the status it already had)?
 *
 * Two writers, two shapes:
 *   - the ordinary PATCH records `{status, _previous:{status}}` and OMITS
 *     `_previous.status` entirely when the status did not move;
 *   - `recovery.*` records `{status, previousStatus}` flat.
 * A row carrying `status` with NO readable previous is NOT treated as a
 * transition — restating the current status is the common case (measured on
 * TRA-3196, twice), and treating it as a close would attribute the close to
 * whoever touched the issue last.
 */
export function statusTransitionOf(details) {
  if (!details || typeof details !== 'object') return null;
  const to = typeof details.status === 'string' ? details.status : null;
  if (!to) return null;
  const prevBlock = details._previous && typeof details._previous === 'object' ? details._previous : null;
  const from =
    typeof details.previousStatus === 'string'
      ? details.previousStatus
      : prevBlock && typeof prevBlock.status === 'string'
        ? prevBlock.status
        : null;
  if (from === null) return null;
  if (from === to) return null;
  return { from, to };
}

/**
 * What did this row do to the assignee, and what was the value BEFORE it?
 *
 * Returns `null` for a row that did not move the assignee, `{before}` when the
 * pre-write value is recoverable, and `{ambiguous:true}` when the row plainly
 * moved it but recorded no readable "before".
 */
export function assigneeRewindOf(details) {
  if (!details || typeof details !== 'object') return null;
  const prevBlock = details._previous && typeof details._previous === 'object' ? details._previous : null;

  // The platform's strand recovery. It re-homes WITHOUT logging assigneeAgentId.
  if (typeof details.source === 'string' && details.source.startsWith('recovery.')) {
    const to = details.recoveryOwnerAgentId ?? null;
    if (to === null) return null; // it did not re-home
    if (!('previousOwnerAgentId' in details)) return { ambiguous: true };
    const before = details.previousOwnerAgentId ?? null;
    return before === to ? null : { before };
  }

  if (!('assigneeAgentId' in details)) return null;
  const to = details.assigneeAgentId ?? null;
  if (!prevBlock || !('assigneeAgentId' in prevBlock)) return { ambiguous: true };
  const before = prevBlock.assigneeAgentId ?? null;
  return before === to ? null : { before };
}

/**
 * Attribute one issue's close from its own rows.
 *
 * @param {object} entry `{ rows, currentStatus, currentAssigneeAgentId }` where
 *   `rows` are that issue's `issue.updated` activity rows in ASCENDING time
 *   order, each `{ atMs, actorType, actorId, agentId, details }`.
 * @param {string} closedStatus the non-`done` status the run reported
 *   (`blocked` / `cancelled`) — taken from the dispatcher's own failureReason,
 *   never guessed.
 */
export function attributeClose(entry, closedStatus) {
  if (!entry) return UNKNOWN('the close tape carries no rows for this issue');
  const rows = Array.isArray(entry.rows) ? entry.rows : null;
  if (rows === null) return UNKNOWN('the close tape entry carries no `rows` array');

  // ⛔ The close is the LAST transition INTO the status the dispatcher named.
  // Last, not first: an issue can be re-blocked, and the tail the check graded
  // is the newest one. If the dispatcher named a status the tape never
  // transitions into, say so — do not silently fall back to "the last write".
  let close = null;
  for (const r of rows) {
    const t = statusTransitionOf(r.details);
    if (t && t.to === closedStatus) close = r;
  }
  if (!close) {
    return UNKNOWN(
      `no \`issue.updated\` row records a transition INTO \`${closedStatus}\` ` +
        `(${rows.length} row(s) read) — the close predates this company's activity_log, or a writer ` +
        'moved the status without recording a previous value',
    );
  }

  // Rewind the assignee from NOW back to the close instant.
  if (!('currentAssigneeAgentId' in entry)) {
    return UNKNOWN('the issue row carried no current assignee to rewind from');
  }
  let assignee = entry.currentAssigneeAgentId ?? null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r.atMs <= close.atMs) break;
    const rw = assigneeRewindOf(r.details);
    if (!rw) continue;
    if (rw.ambiguous) {
      return {
        attribution: CLOSE_ATTRIBUTION.UNKNOWN,
        closedAt: new Date(close.atMs).toISOString(),
        closedByActorType: close.actorType ?? null,
        closedByActorId: close.actorId ?? null,
        assigneeAtCloseAgentId: null,
        why:
          `the closing actor is known, but a later write at ${new Date(r.atMs).toISOString()} moved the ` +
          'assignee without recording a previous value, so the assignee AT CLOSE cannot be replayed',
      };
    }
    assignee = rw.before;
  }

  return {
    attribution: CLOSE_ATTRIBUTION.RESOLVED,
    closedAt: new Date(close.atMs).toISOString(),
    closedByActorType: close.actorType ?? null,
    closedByActorId: close.actorId ?? null,
    assigneeAtCloseAgentId: assignee,
    why: null,
  };
}

/** Look one issue up in a tape, honouring an unreadable tape. */
export function attributeCloseFromTape(tape, issueId, closedStatus) {
  if (!tape || tape.ok !== true) {
    return UNKNOWN(`the close tape is unreadable — ${tape?.reason || 'no tape was supplied'}`);
  }
  if (!issueId) return UNKNOWN('the run recorded no linked issue id');
  return attributeClose(tape.issues?.get(String(issueId)), closedStatus);
}

/**
 * Read the close tape for a bounded set of issues.
 *
 * ⛔ SELECT ONLY. The server owns this database.
 * ⛔ Bounded by construction: the caller passes the linked issue ids of the
 *    EXECUTION_ISSUE_ABANDONED findings only (three, on the founding run), so
 *    this never becomes a company-wide activity scan.
 */
export async function readCloseTapeFromPostgres(opts = {}) {
  const companyId = opts.companyId;
  if (!companyId) return blindCloseTape('no companyId was supplied to the close-tape reader');

  const issueIds = [...new Set((opts.issueIds || []).filter(Boolean).map(String))];
  if (issueIds.length === 0) return emptyCloseTape({ source: 'activity_log@postgres (no rows requested)' });

  const { Client, tried } = await loadPgClient(opts.pgModulePath);
  if (!Client) {
    return blindCloseTape(
      `the \`pg\` driver could not be resolved (tried: ${tried.join(', ') || 'nothing'}) — ` +
        'set PAPERCLIP_PG_MODULE to its path',
    );
  }

  const client = new Client({ connectionString: opts.connectionString || DEFAULT_DB_URL });
  try {
    await client.connect();
  } catch (err) {
    return blindCloseTape(`could not connect to the platform database — ${err?.message || err}`);
  }

  try {
    const issues = new Map();

    const cur = await client.query(
      'select id, identifier, status, assignee_agent_id from issues where id = any($1::uuid[])',
      [issueIds],
    );
    for (const r of cur.rows || []) {
      issues.set(String(r.id), {
        identifier: r.identifier || null,
        currentStatus: r.status || null,
        currentAssigneeAgentId: r.assignee_agent_id ? String(r.assignee_agent_id) : null,
        rows: [],
      });
    }

    const acts = await client.query(
      `select entity_id, actor_type, actor_id, agent_id, created_at, details
         from activity_log
        where company_id = $1
          and entity_type = 'issue'
          and action = $2
          and entity_id = any($3::text[])
        order by created_at asc`,
      [companyId, CLOSE_ACTION, issueIds],
    );
    for (const r of acts.rows || []) {
      const entry = issues.get(String(r.entity_id));
      if (!entry) continue; // an activity row for an issue the issues table no longer has
      const atMs = Date.parse(new Date(r.created_at).toISOString());
      if (!Number.isFinite(atMs)) continue;
      entry.rows.push({
        atMs,
        actorType: r.actor_type ? String(r.actor_type) : null,
        actorId: r.actor_id ? String(r.actor_id) : null,
        agentId: r.agent_id ? String(r.agent_id) : null,
        details: r.details || null,
      });
    }

    return { ok: true, issues, source: 'activity_log@postgres', issueCount: issues.size };
  } catch (err) {
    return blindCloseTape(`the close-tape query failed — ${err?.message || err}`);
  } finally {
    try {
      await client.end();
    } catch {
      /* closing is best-effort; it cannot change a verdict */
    }
  }
}
