/**
 * TRA-3487 — the durable OWNER-PAUSE tape, and the resolver that answers
 * "was this routine's owner invokable at the instant its dispatch failed?"
 *
 * WHY THIS EXISTS
 * ---------------
 * `check:routine-dispatch` graded a `failed` dispatch tail and then asserted,
 * in its FLEET banner, that a roster-wide burst is "ONE platform condition" —
 * a claim about THE DISPATCHER. Per TRA-2871 the most common TRUE cause of
 * such a burst is that the owning agents were **paused**, which is
 * owner/board-routable and not a dispatcher fault at all. The instrument
 * therefore handed the next responder a pre-committed wrong subject twice a
 * day. (TRA-2867 and TRA-2871 both took that wrong turn.)
 *
 * ⛔ WHY THE AGENT ROW CANNOT ANSWER THIS
 * `resume` writes `{status:'idle', pauseReason:null, pausedAt:null,
 * errorReason:null}` — it ERASES the evidence. So "0 of 10 agents are paused
 * and none carries a pauseReason" is EXACTLY what a fleet that was paused for
 * two days looks like once someone resumed it. The current-state read is not
 * weak evidence here, it is ZERO evidence. Only the append-only tape can date
 * a pause, and it must be read at the FAILURE INSTANT, not at now.
 *
 * WHAT THE TAPE IS — verified against the running platform's own source and DB
 * on 2026-08-13, not inferred from API shapes:
 *
 *   `@paperclipai/server/dist/routes/agents.js`
 *     :2484 POST /agents/:id/pause   -> logActivity action `agent.paused`
 *     :2506 POST /agents/:id/resume  -> logActivity action `agent.resumed`
 *   `activity_log` columns: entity_id is TEXT and holds the agent id;
 *   ⛔ `agent_id` is NULL on these rows (it is the ACTOR column), so joining or
 *   filtering on `agent_id` returns nothing at all.
 *
 * ⛔⛔ THE HOLE THAT MAKES THIS FAIL-CLOSED, NOT BEST-EFFORT
 * `PATCH /agents/:id` (`routes/agents.js:2362`) validates with
 * `updateAgentSchema`, which carries `status: z.enum(AGENT_STATUSES).optional()`
 * — and `AGENT_STATUSES` includes `paused`. That route does NOT write
 * `agent.paused`. It writes `agent.updated`, and its `details` come from
 * `summarizeAgentUpdateDetails`, which records ONLY
 * `{changedTopLevelKeys:['status']}` — **the KEY, never the VALUE**.
 *
 * So an agent can be paused by a route that leaves no pause record. Measured on
 * this company 2026-08-13: one such row exists, `2026-08-12T04:47:17.629Z`
 * against agent `671785a4` (CTO), and `agent_config_revisions` — the table the
 * PATCH route populates via `recordRevision` — has **no row at all** whose
 * `changed_keys` contains `status`, so the value is not recoverable from there
 * either. The ambiguity is IRREDUCIBLE from the tape.
 *
 * A resolver that ignored those rows would report `INVOKABLE` for a
 * PATCH-paused owner — byte-identical to a true "the owner was fine", which is
 * precisely the class of defect this whole chain is about. So a status-touching
 * `agent.updated` after the last decisive event forces `UNKNOWN`.
 *
 * ⛔ UNKNOWN IS NEVER THE BENIGN VALUE. It is not `INVOKABLE`, it is not
 * HEALTHY, and it must not be laundered into a dispatcher claim.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

/** What the resolver can conclude about an owner at one instant. */
export const OWNER_STATE = {
  INVOKABLE: 'INVOKABLE',
  PAUSED: 'PAUSED',
  TERMINATED: 'TERMINATED',
  UNKNOWN: 'UNKNOWN',
};

/**
 * The tape's event vocabulary. CLOSED on purpose — an event kind this resolver
 * has never seen resolves UNKNOWN rather than falling through to INVOKABLE.
 *
 *   paused / resumed / terminated — DECISIVE. They state the resulting status.
 *   status_patch                  — INDECISIVE. `agent.updated` touched
 *                                   `status` and the value was never recorded.
 */
export const TAPE_EVENT_KINDS = new Set(['paused', 'resumed', 'terminated', 'status_patch']);

/** The activity_log actions this tape is built from. */
export const TAPE_ACTIONS = ['agent.paused', 'agent.resumed', 'agent.terminated', 'agent.updated'];

const ACTION_TO_KIND = {
  'agent.paused': 'paused',
  'agent.resumed': 'resumed',
  'agent.terminated': 'terminated',
};

/** A readable tape with no events — the "nobody was ever paused" control. */
export function emptyTape(over = {}) {
  return { ok: true, floorMs: 0, events: [], source: 'synthetic', ...over };
}

/** An unreadable tape. Every resolution against it is UNKNOWN. */
export function blindTape(reason) {
  return { ok: false, reason: String(reason || 'unspecified'), events: [], floorMs: null, source: null };
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Resolve the owner's invokability at instant `atMs` from the durable tape.
 *
 * Returns `{ state, why }`. EVERY branch that cannot prove a state returns
 * UNKNOWN with a reason a human can act on — there is deliberately no default
 * that lands on INVOKABLE.
 */
export function resolveOwnerStateAt(tape, agentId, atMs) {
  const unknown = (why) => ({ state: OWNER_STATE.UNKNOWN, why });

  if (!tape || tape.ok !== true) {
    return unknown(`the pause tape is unreadable — ${tape?.reason || 'no tape was supplied'}`);
  }
  if (!Array.isArray(tape.events)) {
    return unknown('the pause tape carries no `events` array');
  }
  if (!Number.isFinite(tape.floorMs)) {
    return unknown('the pause tape reports no coverage floor, so it cannot be shown to reach this failure');
  }
  if (!agentId) {
    return unknown('the routine carries no `assigneeAgentId`, so there is no owner whose state could be resolved');
  }
  if (!Number.isFinite(atMs)) {
    return unknown('the failure carries no parseable timestamp to resolve the owner state against');
  }
  // ⛔ THE WINDOW MUST REACH THE FAILURE. A tape that starts after the event
  // proves nothing about it, and "no events found" would otherwise read exactly
  // like "the owner was never paused".
  if (atMs < tape.floorMs) {
    return unknown(
      `the failure at ${iso(atMs)} PREDATES the tape's coverage floor (${iso(tape.floorMs)}) — ` +
        'no pause could be observed for it either way',
    );
  }

  const mine = tape.events
    .filter((e) => e && e.agentId === agentId && Number.isFinite(e.atMs) && e.atMs <= atMs)
    .sort((a, b) => a.atMs - b.atMs);

  const alien = mine.find((e) => !TAPE_EVENT_KINDS.has(e.kind));
  if (alien) {
    return unknown(
      `the tape carries an event kind this resolver has never seen (${JSON.stringify(alien.kind)}) at ` +
        `${iso(alien.atMs)} — an unrecognised transition is not a pass`,
    );
  }

  // The last event that actually STATES a resulting status.
  let decisive = null;
  for (const e of mine) if (e.kind !== 'status_patch') decisive = e;

  // ⛔ Any status-touching PATCH at or after that point makes the state
  // indeterminate: the platform logged the key and threw the value away.
  // `>=` and not `>` — a patch sharing a timestamp with the decisive event
  // cannot be ordered against it, so it is treated as clobbering it.
  const patch = mine.find(
    (e) => e.kind === 'status_patch' && (decisive === null || e.atMs >= decisive.atMs),
  );
  if (patch) {
    return unknown(
      `an \`agent.updated\` PATCH changed \`status\` at ${iso(patch.atMs)}` +
        (decisive ? ` (after the last decisive ${decisive.kind} at ${iso(decisive.atMs)})` : '') +
        ' and the platform records only the CHANGED KEY, never the value — `summarizeAgentUpdateDetails` ' +
        'writes `{changedTopLevelKeys:["status"]}`, and `agent_config_revisions` does not track `status` ' +
        'at all. The owner may or may not have been paused; the tape cannot say.',
    );
  }

  if (decisive === null) {
    return {
      state: OWNER_STATE.INVOKABLE,
      why:
        `no pause/resume/terminate event exists for this owner at or before ${iso(atMs)}, ` +
        `and the tape covers back to ${iso(tape.floorMs)}`,
    };
  }
  if (decisive.kind === 'paused') {
    return {
      state: OWNER_STATE.PAUSED,
      why: `owner was PAUSED at ${iso(decisive.atMs)} and had not resumed by the failure at ${iso(atMs)}`,
    };
  }
  if (decisive.kind === 'terminated') {
    return {
      state: OWNER_STATE.TERMINATED,
      why: `owner was TERMINATED at ${iso(decisive.atMs)}, before the failure at ${iso(atMs)}`,
    };
  }
  return {
    state: OWNER_STATE.INVOKABLE,
    why: `owner's newest transition before the failure was a RESUME at ${iso(decisive.atMs)}`,
  };
}

/* ------------------------------------------------------------------ *
 * The live reader — SELECTs only.
 * ------------------------------------------------------------------ */

/**
 * The API cannot serve this tape, and that is measured, not assumed (TRA-3487):
 *   - `GET /api/companies/{id}/activity?action=agent.paused` returns the newest
 *     UNFILTERED rows. The `action` filter is SILENTLY IGNORED.
 *   - `limit=1000` yields 500 rows, covering ~3.4h on this company. A pause
 *     older than that is invisible.
 * So the durable read is the platform's own Postgres, which is on this box.
 */
export const DEFAULT_DB_URL = 'postgres://paperclip:paperclip@127.0.0.1:54329/paperclip';

/**
 * `pg` is not a dependency of this repo, so it is resolved from wherever the
 * platform itself installed it. Every failure path returns null and the caller
 * turns that into a BLIND tape — never into "no pauses found".
 */
async function loadPgClient(explicit) {
  const tried = [];

  // ⛔ `pg` is CommonJS and ships as a DIRECTORY. `import('file:///…/node_modules/pg')`
  // therefore throws ERR_UNSUPPORTED_DIR_IMPORT — ESM does no directory/`main`
  // resolution for file: URLs. Measured 2026-08-13: the first cut of this
  // resolver used dynamic import and reported "driver could not be resolved"
  // against a path that plainly existed, which would have degraded every live
  // attribution to UNKNOWN for a reason that had nothing to do with the tape.
  // `createRequire` does the CJS resolution properly.
  const req = createRequire(import.meta.url);
  const attempt = (spec) => {
    tried.push(spec);
    try {
      const m = req(spec);
      return m?.Client || m?.default?.Client || null;
    } catch {
      return null;
    }
  };

  if (explicit) {
    const c = attempt(explicit);
    if (c) return { Client: c, tried };
  }
  const bare = attempt('pg');
  if (bare) return { Client: bare, tried };

  // The npx cache the platform runs out of.
  const roots = [
    path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx'),
    path.join(os.homedir(), '.npm', '_npx'),
  ];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const candidate = path.join(root, e, 'node_modules', 'pg');
      if (!fs.existsSync(candidate)) continue;
      const c = attempt(candidate);
      if (c) return { Client: c, tried };
    }
  }
  return { Client: null, tried };
}

/**
 * Read the durable pause tape for one company.
 *
 * ⛔ SELECT ONLY. The server owns this database.
 */
export async function readPauseTapeFromPostgres(opts = {}) {
  const companyId = opts.companyId;
  if (!companyId) return blindTape('no companyId was supplied to the pause-tape reader');

  const { Client, tried } = await loadPgClient(opts.pgModulePath);
  if (!Client) {
    return blindTape(
      `the \`pg\` driver could not be resolved (tried: ${tried.join(', ') || 'nothing'}) — ` +
        'set PAPERCLIP_PG_MODULE to its path',
    );
  }

  const client = new Client({ connectionString: opts.connectionString || DEFAULT_DB_URL });
  try {
    await client.connect();
  } catch (err) {
    return blindTape(`could not connect to the platform database — ${err?.message || err}`);
  }

  try {
    // The coverage floor is the company's FIRST activity row: before it, this
    // company has no tape at all and a silent "no events" would be a lie.
    const floorRes = await client.query(
      'select min(created_at) as floor from activity_log where company_id = $1',
      [companyId],
    );
    const floorRaw = floorRes?.rows?.[0]?.floor ?? null;
    const floorMs = floorRaw === null ? NaN : Date.parse(new Date(floorRaw).toISOString());
    if (!Number.isFinite(floorMs)) {
      return blindTape(`the company has no activity_log rows at all, so there is no pause tape to read`);
    }

    const rows = await client.query(
      `select action, entity_id, created_at, details
         from activity_log
        where company_id = $1
          and action = any($2::text[])
        order by created_at asc`,
      [companyId, TAPE_ACTIONS],
    );

    const events = [];
    for (const r of rows.rows || []) {
      const atMs = Date.parse(new Date(r.created_at).toISOString());
      const agentId = r.entity_id ? String(r.entity_id) : null;
      if (!agentId || !Number.isFinite(atMs)) continue;

      const kind = ACTION_TO_KIND[r.action];
      if (kind) {
        events.push({ agentId, kind, atMs });
        continue;
      }
      // `agent.updated` — only interesting when it touched `status`.
      // ⛔ Unreadable details count AS ambiguous: we cannot rule status out.
      const keys = r.details && Array.isArray(r.details.changedTopLevelKeys)
        ? r.details.changedTopLevelKeys
        : null;
      if (keys === null || keys.includes('status')) {
        events.push({ agentId, kind: 'status_patch', atMs });
      }
    }

    return {
      ok: true,
      floorMs,
      events,
      source: 'activity_log@postgres',
      eventCount: events.length,
    };
  } catch (err) {
    return blindTape(`the pause-tape query failed — ${err?.message || err}`);
  } finally {
    try {
      await client.end();
    } catch {
      /* closing is best-effort; it cannot change a verdict */
    }
  }
}
