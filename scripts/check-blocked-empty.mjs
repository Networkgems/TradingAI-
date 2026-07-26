#!/usr/bin/env node
/**
 * TRA-2364 — detector for the `blocked` + EMPTY `blockedBy` board shape.
 *
 * WHAT THE SHAPE IS
 * -----------------
 * An issue at `status: "blocked"` whose `blockedBy` array is empty carries no
 * edge that anything can ever resolve. The board treats it as a leaf with no
 * unmet dependency and auto-flips it back to `in_progress` — so the "hold" is
 * a hold that silently expires, and whatever the issue was parked for resumes
 * unattended.
 *
 * WHY IT KEEPS COMING BACK (TRA-2360 / TRA-2362, measured twice)
 * -------------------------------------------------------------
 * We cannot fix the cause here. Paperclip's terminal-run recovery path writes
 * `status: blocked` onto whatever is `in_progress` when a run dies on
 * `acpx_turn_failed` ("You've hit your session limit"), and **that write sets
 * no blocker array**. It fired 2026-07-25T20:3xZ (recovery owner CTO) and
 * 2026-07-26T02:0xZ (recovery owner CFO). It is platform behaviour, not this
 * repo, and it will fire again on whatever is `in_progress` next time.
 *
 * So this is the instrument, not the fix. It is deliberately a CHECKER and not
 * a dated green: a clean run today says nothing about the board after the next
 * session-limit event. Run it again rather than citing a past run.
 *
 * ⛔ Key it on the SHAPE, never on the recovery action. TRA-2331 was in this
 * state with `activeRecoveryAction: null` — a second, unrelated route in.
 *
 * ⛔ And never grade it off `blockerAttention`. That rollup counts open
 * CHILDREN, which the anchor does not, so it reads `unresolvedBlockerCount: 1`
 * on an issue whose `blockedBy` is `[]` (measured on TRA-2331). It over-reports
 * as readily as it under-reports. `blockerAttention` is printed here as
 * context and is NEVER allowed to suppress a finding.
 *
 * ⛔⛔ AND NEVER LET IT NAME THE ANCHOR (TRA-2396). The same rollup exposes
 * `sampleBlockerIdentifier`, and it is STRUCTURALLY INCAPABLE of yielding a
 * legal one: it samples open DESCENDANTS, and a descendant can never be a valid
 * `blockedByIssueIds` value for its own ancestor — that edge is a 2-cycle, which
 * is strictly WORSE than the empty array it replaces (an empty `blockedBy`
 * auto-flips and stays visible; a cycle is a permanent hold neither side can
 * break). The first live routing this detector produced (TRA-2383) carried a
 * copy-pasteable PATCH built on that field, alongside four lines of prose
 * warning not to run it. Prose does not survive a copy-paste.
 *
 * So: this script emits NO repair PATCH, ever. What it emits instead is an
 * ANCHOR VERDICT — every rollup candidate resolved against the parent chain and
 * every descendant/self/ancestor/closed one struck out. When nothing survives,
 * the true and actionable message is "no valid anchor: every unresolved blocker
 * in the rollup is a descendant", and that is what it prints. The rollup COUNT
 * is still printed: work really is parked downstream. Only the anchor
 * suggestion had to go.
 *
 * ⛔ THE CAUSE IS A BRANCH, NOT A SENTENCE (TRA-2396). Two different writers
 * produce `blocked` + empty, and they need OPPOSITE repairs:
 *
 *   RECOVERY-BLOCKED  Paperclip's terminal-run recovery wrote the status. There
 *                     was never an intended anchor, so there is nothing to
 *                     restore — re-derive what the issue waits on TODAY.
 *   DROPPED-EDGE      an agent PATCHed `{"blockedBy":[…],"status":"blocked"}`;
 *                     the `status` half landed and the blocker half was silently
 *                     discarded (TRA-2365 / TRA-2304). Here an intended anchor
 *                     DOES exist and is worth restoring.
 *
 * TRA-2383 asserted DROPPED-EDGE in the indicative on a case that was
 * RECOVERY-BLOCKED — a confident sentence bolted onto a correctly detected
 * number. The marker is cheap: `activeRecoveryAction`, or once discharged a
 * SYSTEM-AUTHORED comment carrying `acpx_turn_failed` / `Recovery action:` /
 * `Recovery owner:`. So we branch on it instead of guessing.
 *
 *   ⛔ The authorship gate is load-bearing, not decoration. Agents QUOTE
 *   `acpx_turn_failed` in their own comments constantly (TRA-2396's own body
 *   does), so a marker regex without `authorType === 'system'` brands every
 *   thread that merely discusses recovery as RECOVERY-BLOCKED. Controlled.
 *
 *   ⛔ And an UNREAD comment thread is not an absent marker. A failed comment
 *   GET yields cause UNKNOWN, never DROPPED-EDGE — otherwise the inference
 *   would be strongest exactly where we read least.
 *
 * THE TWO SILENT READS THIS SCRIPT EXISTS TO SURVIVE
 * --------------------------------------------------
 *   1. `GET /api/companies/{c}/issues` CAPS AT 1000 ROWS and `offset` DOES
 *      paginate. The company has ~2350 issues. One unpaginated call reports 46
 *      blocked; the full set is 82. A one-page sweep silently misses ~44% of
 *      the population and reports a clean bill of health on the half it never
 *      read. ⛔ Do NOT probe pagination by checking that page 2 is non-empty —
 *      an IGNORED `offset` returns a full page too (`?search=` on this same
 *      route is silently ignored, so the prior is real). We assert the deduped
 *      union GREW; a full page that adds zero new ids is an ignored offset and
 *      exits BLIND.
 *
 *   2. The issue-LIST route carries NO `blockedBy` KEY AT ALL. A list-route
 *      sweep therefore reads "0 blockers" on EVERY issue in the company and
 *      returns a 100% confident false all-clear — or, read the other way, flags
 *      the entire board. Every `blocked` hit is re-read through the ITEM route,
 *      and we assert the key is PRESENT on the payload (`'blockedBy' in item`)
 *      rather than trusting `(item.blockedBy || []).length === 0`, which cannot
 *      tell "no blockers" from "you asked the wrong route".
 *
 * WHY IT ROUTES INSTEAD OF REPAIRING
 * ----------------------------------
 * Board repair is ASSIGNEE-SCOPED. The CFO holds the top role (`role: ceo`,
 * `reportsTo: null`) and still got `403 {"error":"Issue is outside this
 * actor's authorization boundary"}` on a plain `{"status":…}` PATCH of the two
 * issues in the set that were not theirs. The 403 covers the COMMENT route
 * too, so you cannot even nudge the owner in place. ⇒ a sweep can only ROUTE,
 * never heal, and an issue whose assignee is off-roster or absent is
 * unrepairable by EVERY agent — its own severity class, needing a human.
 *
 * This script is READ-ONLY. It performs GETs and nothing else.
 *
 * VERDICTS / EXIT CODES
 *   0  CLEAN                     — enumeration trustworthy, zero issues in the shape
 *   1  FINDINGS                  — every finding has a live roster assignee to route to
 *   2  FINDINGS_UNREPAIRABLE     — at least one finding no agent can repair (human needed)
 *   3  BLIND                     — the enumeration itself is untrustworthy. NOT a pass.
 *
 * BLIND outranks everything: a detector that cannot prove it saw the whole
 * population must never report a count, because "0 found" and "0 looked at"
 * render identically.
 *
 * USAGE
 *   node scripts/check-blocked-empty.mjs
 *   node scripts/check-blocked-empty.mjs --json
 *   node scripts/check-blocked-empty.mjs --selftest     # positive + negative controls
 *
 * Auth: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.
 */

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

export const VERDICT_EXIT = {
  CLEAN: 0,
  FINDINGS: 1,
  FINDINGS_UNREPAIRABLE: 2,
  BLIND: 3,
};

/* ------------------------------------------------------------------ *
 * Enumeration
 * ------------------------------------------------------------------ */

/**
 * Page the issue-list route to exhaustion, proving as we go that `offset` is
 * actually honoured.
 *
 * Returns { issues, pages, blind } — `blind` is a REASON STRING, never a
 * boolean, so the caller can print why the population is untrustworthy.
 */
export async function enumerateIssues(getIssuesPage, { limit = PAGE_LIMIT, maxPages = MAX_PAGES } = {}) {
  const byId = new Map();
  const pages = [];

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit;
    const rows = await getIssuesPage({ limit, offset });
    if (!Array.isArray(rows)) {
      return { issues: [], pages, blind: `list route returned a non-array at offset=${offset}` };
    }

    const before = byId.size;
    for (const row of rows) if (row && row.id) byId.set(row.id, row);
    const added = byId.size - before;
    pages.push({ offset, returned: rows.length, added });

    // A short page is the honest terminator.
    if (rows.length < limit) return { issues: [...byId.values()], pages, blind: null };

    // A FULL page that adds nothing new means `offset` was ignored and we are
    // re-reading page 0 forever. Emptiness would have been the safe failure;
    // this one looks like data.
    if (added === 0) {
      return {
        issues: [],
        pages,
        blind:
          `list route ignored offset: offset=${offset} returned a full page of ${rows.length} ` +
          `rows and added 0 new ids. The population cannot be enumerated through this route.`,
      };
    }
  }

  // Hit the page cap with full pages still coming. Say so — do not truncate in
  // silence and report a count computed off a partial board.
  return {
    issues: [],
    pages,
    blind: `page cap (${maxPages}) reached with full pages still returning; enumeration is truncated`,
  };
}

/* ------------------------------------------------------------------ *
 * The parent graph — built from the SAME enumeration, zero extra reads
 *
 * The issue-LIST route omits `blockedBy` but it DOES carry `parentId`, so the
 * whole ancestry of every issue in the company is already in hand by the time
 * we grade anything. That is what makes descendant-filtering cheap enough to be
 * unconditional.
 * ------------------------------------------------------------------ */

export function buildGraph(issues) {
  const byId = new Map();
  const byIdentifier = new Map();
  const parentOf = new Map();
  for (const row of Array.isArray(issues) ? issues : []) {
    if (!row || !row.id) continue;
    byId.set(row.id, row);
    if (row.identifier) byIdentifier.set(row.identifier, row);
    parentOf.set(row.id, row.parentId || null);
  }
  return { byId, byIdentifier, parentOf };
}

/**
 * Walk `id` upwards. Returns the ancestor ids, nearest first.
 *
 * `parentOf.get()` returning `undefined` (id not in the enumeration) and `null`
 * (a real root) are DIFFERENT facts, and the caller must not conflate them — an
 * id we never enumerated has an UNKNOWN chain, not an empty one. Callers here
 * check membership first. The `seen` guard is because a malformed parent cycle
 * would otherwise spin forever.
 */
export function ancestorChain(graph, id, maxDepth = 64) {
  const out = [];
  const seen = new Set([id]);
  let cur = graph.parentOf.get(id) || null;
  while (cur && !seen.has(cur) && out.length < maxDepth) {
    out.push(cur);
    seen.add(cur);
    cur = graph.parentOf.get(cur) || null;
  }
  return out;
}

export const ANCHOR = {
  /** No graph was supplied — say so. An unanalysed candidate is NOT an eligible one. */
  NO_GRAPH: 'NO_GRAPH',
  /** The rollup named nobody. Nothing to strike out, nothing to propose. */
  NO_CANDIDATES: 'NO_CANDIDATES',
  /** Every candidate is a descendant. THE message: "no valid anchor". */
  ALL_DESCENDANTS: 'ALL_DESCENDANTS',
  /** Struck out for mixed reasons (descendant + closed + unresolvable). */
  ALL_INELIGIBLE: 'ALL_INELIGIBLE',
  /**
   * Something survived the filter. Deliberately NOT called "ELIGIBLE": surviving
   * the graph test proves only that the edge would not be a cycle. It says
   * nothing about whether that issue is what the subject actually waits on, and
   * on a RECOVERY-BLOCKED subject there was no intended anchor to be right about.
   */
  CANDIDATE_UNVERIFIED: 'CANDIDATE_UNVERIFIED',
};

const CLOSED_STATUSES = new Set(['done', 'cancelled']);

/**
 * Resolve and filter the rollup's anchor candidates for one subject.
 *
 * Pure. Returns { verdict, count, candidates[], message } — never a PATCH, never
 * a command, and never a bare identifier the caller could mistake for one.
 */
export function classifyAnchor(item, graph) {
  const att = item.blockerAttention || null;
  const count = att && Number.isFinite(att.unresolvedBlockerCount) ? att.unresolvedBlockerCount : null;
  const named = [att ? att.sampleBlockerIdentifier : null, att ? att.sampleStalledBlockerIdentifier : null].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  );

  if (!graph) {
    return {
      verdict: ANCHOR.NO_GRAPH,
      count,
      candidates: named.map((identifier) => ({ identifier, reason: 'UNANALYSED' })),
      message:
        'anchor NOT analysed — no parent graph was available, so no candidate could be tested for ' +
        'descendancy. Unanalysed is not eligible; re-derive the dependency by hand.',
    };
  }

  if (!named.length) {
    return {
      verdict: ANCHOR.NO_CANDIDATES,
      count,
      candidates: [],
      message:
        'no anchor candidate is even named by the rollup. Re-derive what this issue waits on today; ' +
        'if the answer is nothing, `todo` is the correct disposition for a parked-ready leaf.',
    };
  }

  const candidates = named.map((identifier) => {
    const row = graph.byIdentifier.get(identifier) || null;
    if (!row) {
      return {
        identifier,
        id: null,
        reason: 'UNRESOLVED_IDENTIFIER',
        detail: 'not present in the enumeration — its ancestry cannot be tested, so it cannot be cleared',
      };
    }
    if (row.id === item.id) {
      return { identifier, id: row.id, reason: 'SELF', detail: 'is the subject itself' };
    }
    const candidateAncestors = ancestorChain(graph, row.id);
    if (candidateAncestors.includes(item.id)) {
      const parent = graph.byId.get(row.parentId || '');
      return {
        identifier,
        id: row.id,
        reason: 'DESCENDANT',
        detail:
          `is a DESCENDANT of the subject (parent ${parent ? parent.identifier || parent.id : row.parentId})` +
          ' — that edge is a 2-cycle, worse than the empty array',
      };
    }
    if (ancestorChain(graph, item.id).includes(row.id)) {
      return {
        identifier,
        id: row.id,
        reason: 'ANCESTOR',
        detail: 'is an ANCESTOR of the subject — reported, not proposed; the open child already carries the wait',
      };
    }
    if (CLOSED_STATUSES.has(String(row.status))) {
      return {
        identifier,
        id: row.id,
        reason: 'CLOSED',
        detail: `is \`${row.status}\` — an inert blocker READS like a repair and resolves nothing`,
      };
    }
    return { identifier, id: row.id, reason: 'SURVIVES', detail: `status \`${row.status}\`, not in the subject's subtree` };
  });

  const survivors = candidates.filter((c) => c.reason === 'SURVIVES');
  if (survivors.length) {
    return {
      verdict: ANCHOR.CANDIDATE_UNVERIFIED,
      count,
      candidates,
      message:
        `${survivors.map((c) => c.identifier).join(', ')} would not be a cycle — that is ALL this proves. ` +
        'It is not evidence the subject waits on it. Re-derive the dependency, then write the edge ' +
        'yourself with the documented write field; this tool emits no repair command (TRA-2396).',
    };
  }

  const allDescendants = candidates.every((c) => c.reason === 'DESCENDANT');
  return {
    verdict: allDescendants ? ANCHOR.ALL_DESCENDANTS : ANCHOR.ALL_INELIGIBLE,
    count,
    candidates,
    message: allDescendants
      ? 'NO VALID ANCHOR: every unresolved blocker in the rollup is a DESCENDANT of the subject. ' +
        'There is nothing here to anchor onto — re-derive the dependency, or use `todo` (the open ' +
        'children already carry the wait upstream).'
      : 'NO VALID ANCHOR: every candidate the rollup named is struck out (see reasons above). ' +
        're-derive the dependency from scratch.',
  };
}

/* ------------------------------------------------------------------ *
 * Cause branch — RECOVERY-BLOCKED vs DROPPED-EDGE
 * ------------------------------------------------------------------ */

export const CAUSE = {
  RECOVERY_BLOCKED: 'RECOVERY_BLOCKED',
  DROPPED_EDGE_INFERRED: 'DROPPED_EDGE_INFERRED',
  UNKNOWN: 'UNKNOWN',
};

const RECOVERY_MARKER = /acpx_turn_failed|Recovery action:|Recovery owner:|terminal run recovery/i;
const MOVED_TO_BLOCKED = /moving it to\s*`?blocked`?/i;
// The owner arrives as a markdown link: `Recovery owner: [CFO](/TRA/agents/<id>)`.
// The id segment is matched as "whatever is left in the path", NOT as a uuid — a
// uuid-shaped pattern silently captured nothing on a non-uuid id and the branch
// lost its owner name while still reading as a clean RECOVERY-BLOCKED.
const OWNER_LINK = /Recovery owner:\s*\[([^\]]+)\]\([^)]*agents\/([^)\/\s]+)\)/;

/**
 * ⛔ The authorship gate. `authorType === 'system'` is the real signal; the
 * both-ids-null fallback covers a schema that stops sending the field. An
 * AGENT-authored comment quoting the recovery text is NOT a marker — that is the
 * whole trap (see header), and it is controlled.
 */
function isSystemAuthored(c) {
  if (!c || typeof c !== 'object') return false;
  if (typeof c.authorType === 'string') return c.authorType === 'system';
  return !c.authorAgentId && !c.authorUserId;
}

/**
 * Pure. `commentsError` is a REASON STRING — an unread thread must land on
 * UNKNOWN, never on the dropped-edge inference.
 */
export function gradeCause({ item, comments, commentsError }) {
  const recovery = item.activeRecoveryAction || null;
  if (recovery) {
    return {
      cause: CAUSE.RECOVERY_BLOCKED,
      via: 'activeRecoveryAction',
      evidence:
        `activeRecoveryAction ${recovery.kind || '?'}${recovery.cause ? `/${recovery.cause}` : ''}` +
        `${recovery.status ? `:${recovery.status}` : ''}${recovery.createdAt ? ` @ ${recovery.createdAt}` : ''}`,
      recoveryOwnerAgentId: recovery.ownerAgentId || recovery.returnOwnerAgentId || null,
      recoveryOwnerName: null,
    };
  }

  if (commentsError) {
    return { cause: CAUSE.UNKNOWN, via: 'comment thread unreadable', evidence: commentsError };
  }
  if (!Array.isArray(comments)) {
    return {
      cause: CAUSE.UNKNOWN,
      via: 'comment thread unreadable',
      evidence: 'the comment route returned a non-array; absence of a marker was never established',
    };
  }

  const live = comments.filter((c) => c && !c.deletedAt);
  const marker = live
    .filter((c) => isSystemAuthored(c) && RECOVERY_MARKER.test(String(c.body || '')))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];

  if (marker) {
    const body = String(marker.body || '');
    const owner = OWNER_LINK.exec(body);
    return {
      cause: CAUSE.RECOVERY_BLOCKED,
      via: 'system-authored recovery comment',
      evidence:
        `system comment @ ${marker.createdAt || '?'}` +
        `${MOVED_TO_BLOCKED.test(body) ? ' states it moved the issue to `blocked`' : ' carries the recovery markers'}`,
      // Don't overclaim the branch we just fixed someone else for overclaiming.
      // A live `activeRecoveryAction` is present tense; a DISCHARGED one leaves
      // only a comment, and the item route carries no status-change audit — so an
      // agent re-block after that comment is consistent with everything we can see.
      hedge:
        'read from the comment thread, not from a status audit trail: an agent re-block AFTER that ' +
        'comment cannot be excluded. Re-deriving the dependency is the correct move either way.',
      recoveryOwnerAgentId: owner ? owner[2] : null,
      recoveryOwnerName: owner ? owner[1] : null,
    };
  }

  return {
    cause: CAUSE.DROPPED_EDGE_INFERRED,
    via: `no marker in ${live.length} readable comment(s)`,
    evidence:
      'no activeRecoveryAction and no SYSTEM-authored recovery comment. A dropped-blocker PATCH ' +
      '(the read-field / write-field blocker split — see TRA-2365 / TRA-2304 for the field names) ' +
      'is a PLAUSIBLE cause — an INFERENCE, not a read. Hedge it or confirm it from the run trail ' +
      'before asserting it.',
    recoveryOwnerAgentId: null,
    recoveryOwnerName: null,
  };
}

/* ------------------------------------------------------------------ *
 * Classification — pure, so it can be controlled in both directions
 * ------------------------------------------------------------------ */

export const SEVERITY = {
  UNREPAIRABLE_UNASSIGNED: 'UNREPAIRABLE_UNASSIGNED',
  UNREPAIRABLE_OFF_ROSTER: 'UNREPAIRABLE_OFF_ROSTER',
  ROUTE_TO_ASSIGNEE: 'ROUTE_TO_ASSIGNEE',
};

/**
 * Grade ONE item-route payload.
 *
 * `null` means "not in the shape". A string reason on `.unreadable` means the
 * payload could not be graded at all — which is BLIND, not clean.
 */
export function classifyIssue(item, roster, { graph = null } = {}) {
  if (!item || typeof item !== 'object') {
    return { unreadable: 'item payload was not an object' };
  }
  // THE load-bearing assert. Without it, a route that omits the key reads as
  // "zero blockers" on every issue and this detector flags the whole board.
  if (!Object.prototype.hasOwnProperty.call(item, 'blockedBy')) {
    return {
      unreadable:
        `${item.identifier || item.id}: payload carries no 'blockedBy' key — wrong route or a schema change. ` +
        `Absent is not empty.`,
    };
  }
  if (item.status !== 'blocked') return null;

  const blockedBy = Array.isArray(item.blockedBy) ? item.blockedBy : [];
  if (blockedBy.length > 0) return null; // legitimately held — stay silent.

  const assigneeAgentId = item.assigneeAgentId || null;
  const agent = assigneeAgentId ? roster.get(assigneeAgentId) : null;

  let severity;
  if (!assigneeAgentId && !item.assigneeUserId) severity = SEVERITY.UNREPAIRABLE_UNASSIGNED;
  else if (assigneeAgentId && !agent) severity = SEVERITY.UNREPAIRABLE_OFF_ROSTER;
  else severity = SEVERITY.ROUTE_TO_ASSIGNEE;

  const recovery = item.activeRecoveryAction || null;

  return {
    id: item.id,
    identifier: item.identifier || null,
    title: item.title || null,
    priority: item.priority || null,
    severity,
    assigneeAgentId,
    assigneeUserId: item.assigneeUserId || null,
    assigneeName: agent ? agent.name : null,
    assigneeRole: agent ? agent.role : null,
    updatedAt: item.updatedAt || null,
    // Context ONLY. Never allowed to suppress a finding: this rollup counts
    // open children, which the anchor does not, so it reads "covered" on
    // issues carrying nothing that stops the auto-flip.
    blockerAttentionState: item.blockerAttention ? item.blockerAttention.state : null,
    blockerAttentionReason: item.blockerAttention ? item.blockerAttention.reason : null,
    // Genuine signal — work IS parked downstream — so it is printed. What it can
    // never do is name the anchor (TRA-2396); that goes through classifyAnchor,
    // which strikes every descendant out and emits no PATCH either way.
    rollupUnresolvedCount:
      item.blockerAttention && Number.isFinite(item.blockerAttention.unresolvedBlockerCount)
        ? item.blockerAttention.unresolvedBlockerCount
        : null,
    parentId: item.parentId || null,
    anchor: classifyAnchor(item, graph),
    // Filled in by sweep() once the comment thread has been read — a finding that
    // never got there keeps cause UNKNOWN rather than defaulting to an inference.
    cause: CAUSE.UNKNOWN,
    causeVia: 'comment thread not read',
    causeEvidence: null,
    causeHedge: null,
    recoveryOwnerAgentId: null,
    recoveryOwnerName: null,
    // The upstream tell: a batch sharing one stamp is ONE platform event, not
    // N owners forgetting to anchor. Check this before blaming anybody.
    //
    // ⚠️ There is more than one route into the shape, so this is REPORTED and
    // never used as the predicate. Measured so far: `stranded_assigned_issue`
    // (session limit, TRA-2360), `missing_disposition` /
    // `successful_run_missing_state` (a run that SUCCEEDED but recorded no
    // disposition, TRA-2377), and no recovery action at all (TRA-2331).
    recoveryKind: recovery ? recovery.kind : null,
    recoveryCause: recovery ? recovery.cause || null : null,
    recoveryStatus: recovery ? recovery.status || null : null,
    recoveryAt: recovery ? recovery.createdAt || recovery.updatedAt || null : null,
    // Whether anyone is ALREADY being woken for this. An active recovery action
    // with a `wake_owner` policy is a live continuation path; a finding with
    // none has nobody coming for it. Both are findings — the shape is the
    // defect either way — but only the second needs a fresh wake, and filing
    // one against the first is a duplicate wake on an owner the platform is
    // already poking. Do not remediate overload with a fan-out.
    platformWakeOwnerAgentId:
      recovery && recovery.status === 'active' && recovery.wakePolicy && recovery.wakePolicy.type === 'wake_owner'
        ? recovery.wakePolicy.ownerAgentId || recovery.ownerAgentId || null
        : null,
  };
}

export function verdictFor({ blind, findings }) {
  if (blind) return 'BLIND';
  if (findings.length === 0) return 'CLEAN';
  const unrepairable = findings.some(
    (f) => f.severity === SEVERITY.UNREPAIRABLE_UNASSIGNED || f.severity === SEVERITY.UNREPAIRABLE_OFF_ROSTER,
  );
  return unrepairable ? 'FINDINGS_UNREPAIRABLE' : 'FINDINGS';
}

/* ------------------------------------------------------------------ *
 * The sweep — transport injected so the controls can drive the WHOLE
 * pipeline (pagination + item route + classification), not just the
 * predicate. A control over the predicate alone would not have caught
 * either of the two silent reads above, because both live in the plumbing.
 * ------------------------------------------------------------------ */

export async function sweep({ getIssuesPage, getIssue, listAgents, getComments }, opts = {}) {
  const agents = await listAgents();
  const roster = new Map((Array.isArray(agents) ? agents : []).map((a) => [a.id, a]));

  const { issues, pages, blind: enumBlind } = await enumerateIssues(getIssuesPage, opts);
  if (enumBlind) {
    return { verdict: 'BLIND', blind: enumBlind, pages, roster, scanned: 0, itemReads: 0, findings: [], unreadable: [] };
  }

  // Free: the list route omits `blockedBy` but carries `parentId`, so the whole
  // company's ancestry is already paid for by the enumeration above.
  const graph = buildGraph(issues);

  const blockedRows = issues.filter((i) => i.status === 'blocked');

  const hits = [];
  const unreadable = [];
  const concurrency = Math.max(1, Number(opts.concurrency || CONCURRENCY));
  let cursor = 0;

  const worker = async () => {
    while (cursor < blockedRows.length) {
      const row = blockedRows[cursor++];
      let item;
      try {
        item = await getIssue(row.id);
      } catch (err) {
        unreadable.push(`${row.identifier || row.id}: item GET threw — ${err?.message || err}`);
        continue;
      }
      const graded = classifyIssue(item, roster, { graph });
      if (graded && graded.unreadable) unreadable.push(graded.unreadable);
      else if (graded) hits.push({ graded, item });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, blockedRows.length || 1) }, worker));

  // Cause branch. One comment GET per FINDING — not per blocked issue and not on
  // a clean board — and only when `activeRecoveryAction` has already been
  // discharged, since a live one settles the branch on its own.
  //
  // A thread we cannot read stays UNKNOWN. This is precisely the step where an
  // inference would otherwise get promoted to an assertion (TRA-2383 asserted
  // DROPPED-EDGE on a RECOVERY-BLOCKED issue, TRA-2396).
  await Promise.all(
    hits.map(async (entry) => {
      let comments = null;
      let commentsError = null;
      if (entry.item.activeRecoveryAction) {
        // settled without a read
      } else if (typeof getComments !== 'function') {
        commentsError = 'no comment transport was supplied — the recovery marker could not be checked';
      } else {
        try {
          comments = await getComments(entry.graded.id);
        } catch (err) {
          commentsError = `comment GET threw — ${err?.message || err}`;
        }
      }
      const c = gradeCause({ item: entry.item, comments, commentsError });
      Object.assign(entry.graded, {
        cause: c.cause,
        causeVia: c.via,
        causeEvidence: c.evidence,
        causeHedge: c.hedge || null,
        recoveryOwnerAgentId: c.recoveryOwnerAgentId || null,
        recoveryOwnerName: c.recoveryOwnerName || null,
      });
    }),
  );

  const findings = hits.map((e) => e.graded);

  // An item read we could not grade is a hole in the population, exactly like
  // a dropped page. Fail closed.
  const blind = unreadable.length
    ? `${unreadable.length} of ${blockedRows.length} blocked issue(s) could not be graded through the item route`
    : null;

  findings.sort(
    (a, b) =>
      String(a.severity).localeCompare(String(b.severity)) ||
      String(a.identifier).localeCompare(String(b.identifier), undefined, { numeric: true }),
  );

  return {
    verdict: verdictFor({ blind, findings }),
    blind,
    pages,
    roster,
    scanned: issues.length,
    itemReads: blockedRows.length,
    findings,
    unreadable,
  };
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

/**
 * The one sentence a filer should paste, per finding — generated, not improvised.
 *
 * This exists because the failure mode on TRA-2383 was not the detection. It was
 * the PROSE an agent wrote around a correct number: an inferred cause stated in
 * the indicative, in the body AND in the title. So the tool now writes that
 * sentence itself, in the branch the data supports.
 */
export function causeSentence(f, roster) {
  const owner = f.recoveryOwnerName
    ? f.recoveryOwnerName
    : f.recoveryOwnerAgentId
      ? (roster && roster.get(f.recoveryOwnerAgentId) || {}).name || f.recoveryOwnerAgentId
      : null;
  if (f.cause === CAUSE.RECOVERY_BLOCKED) {
    return (
      'RECOVERY-BLOCKED: the `blocked` status was written by Paperclip\'s terminal-run recovery ' +
      `(${f.causeEvidence}), not by an agent PATCH. NO anchor was ever intended, so there is nothing ` +
      'to restore — re-derive what this issue waits on TODAY.' +
      (owner ? ` Recovery owner: ${owner}.` : '') +
      (f.causeHedge ? ` ⚠ ${f.causeHedge}` : '')
    );
  }
  if (f.cause === CAUSE.DROPPED_EDGE_INFERRED) {
    return `DROPPED-EDGE (INFERENCE, ${f.causeVia}): ${f.causeEvidence}`;
  }
  return `CAUSE UNKNOWN (${f.causeVia}): ${f.causeEvidence} — do NOT write the dropped-edge narrative; its absence was never established.`;
}

export function renderReport(result) {
  const L = [];
  const totalReturned = result.pages.reduce((a, p) => a + p.returned, 0);
  L.push(
    `enumeration  ${result.pages.length} page(s), ${totalReturned} row(s) returned, ` +
      `${result.scanned} distinct issue(s) after de-dupe`,
  );
  for (const p of result.pages) L.push(`  offset=${String(p.offset).padStart(5)}  returned=${String(p.returned).padStart(5)}  new=${p.added}`);

  if (result.verdict === 'BLIND') {
    L.push('');
    L.push(`BLIND  ${result.blind}`);
    for (const u of result.unreadable.slice(0, 20)) L.push(`       ${u}`);
    if (result.unreadable.length > 20) L.push(`       … and ${result.unreadable.length - 20} more`);
    L.push('');
    L.push('This is NOT a clean board. It is an unread one — "0 found" and "0 looked at"');
    L.push('render identically, so no count is reported.');
    return L;
  }

  L.push(`item reads   ${result.itemReads} blocked issue(s) re-read through GET /api/issues/{id}`);
  L.push('');

  if (result.findings.length === 0) {
    L.push('CLEAN  no issue is `blocked` with an empty blockedBy.');
    L.push('       Scoped to this instant only — the recovery path re-creates the shape on');
    L.push('       whatever is `in_progress` at the next session-limit event. Re-run; do not');
    L.push('       cite this run.');
    return L;
  }

  const bySeverity = new Map();
  for (const f of result.findings) {
    if (!bySeverity.has(f.severity)) bySeverity.set(f.severity, []);
    bySeverity.get(f.severity).push(f);
  }

  const order = [SEVERITY.UNREPAIRABLE_UNASSIGNED, SEVERITY.UNREPAIRABLE_OFF_ROSTER, SEVERITY.ROUTE_TO_ASSIGNEE];
  const HEADLINE = {
    [SEVERITY.UNREPAIRABLE_UNASSIGNED]: 'UNREPAIRABLE — no assignee. No agent is inside its boundary. HUMAN/BOARD WRITE.',
    [SEVERITY.UNREPAIRABLE_OFF_ROSTER]:
      'UNREPAIRABLE — assignee is not in this company\'s agent roster. No agent can PATCH or even COMMENT. HUMAN/BOARD WRITE.',
    [SEVERITY.ROUTE_TO_ASSIGNEE]: 'ROUTE — only the assignee can repair this. Route it to them; do not try to fix it yourself (403).',
  };

  L.push(`${result.verdict}  ${result.findings.length} issue(s) are \`blocked\` with an EMPTY blockedBy.`);
  L.push('');

  for (const sev of order) {
    const rows = bySeverity.get(sev);
    if (!rows || !rows.length) continue;
    L.push(`── ${sev} (${rows.length}) ─────────────────────────────────`);
    L.push(`   ${HEADLINE[sev]}`);
    for (const f of rows) {
      const who = f.assigneeName
        ? `${f.assigneeName} (${f.assigneeRole})`
        : f.assigneeUserId
          ? `user:${f.assigneeUserId}`
          : f.assigneeAgentId
            ? `OFF-ROSTER agent ${f.assigneeAgentId}`
            : 'UNASSIGNED';
      L.push(`   ${String(f.identifier || f.id).padEnd(10)} ${String(f.priority || '').padEnd(8)} ${who}`);
      L.push(`     ${String(f.title || '').slice(0, 120)}`);
      const wakeOwner = f.platformWakeOwnerAgentId
        ? (result.roster.get(f.platformWakeOwnerAgentId) || {}).name || f.platformWakeOwnerAgentId
        : null;
      L.push(
        `     blockerAttention=${f.blockerAttentionState || 'null'}/${f.blockerAttentionReason || 'null'} (context only)` +
          `  recovery=${f.recoveryKind || 'none'}${f.recoveryCause ? `/${f.recoveryCause}` : ''}` +
          `${f.recoveryStatus ? `:${f.recoveryStatus}` : ''}${f.recoveryAt ? ` @ ${f.recoveryAt}` : ''}`,
      );
      L.push(
        wakeOwner
          ? `     platform wake ALREADY ACTIVE -> ${wakeOwner}. Do NOT file a duplicate; the owner is being poked.`
          : `     no platform wake — nobody is coming for this one unless it is routed.`,
      );
      // The cause branch and the anchor verdict. Both are here because both were
      // getting improvised into filings (TRA-2396): the cause asserted from a
      // guess, the anchor lifted from a rollup that only ever samples descendants.
      L.push(`     cause: ${causeSentence(f, result.roster)}`);
      const rollup =
        f.rollupUnresolvedCount === null || f.rollupUnresolvedCount === undefined
          ? 'n/a'
          : String(f.rollupUnresolvedCount);
      L.push(`     rollup unresolvedBlockerCount=${rollup} (real signal: work parked DOWNSTREAM — never an anchor source)`);
      const anchor = f.anchor || { verdict: ANCHOR.NO_GRAPH, candidates: [], message: 'not analysed' };
      L.push(`     anchor ${anchor.verdict}: ${anchor.message}`);
      for (const c of anchor.candidates || []) {
        L.push(`       - ${c.identifier} ${c.reason}${c.detail ? ` — ${c.detail}` : ''}`);
      }
    }
    L.push('');
  }

  // Routing table. Repair is assignee-scoped, so the actionable unit is the
  // OWNER, not the issue — and one child issue per owner, never a fan-out of
  // N wakes (the failure mode that caused this shape is session-limit load).
  const routable = (bySeverity.get(SEVERITY.ROUTE_TO_ASSIGNEE) || []).filter((f) => !f.platformWakeOwnerAgentId);
  const alreadyWoken = (bySeverity.get(SEVERITY.ROUTE_TO_ASSIGNEE) || []).filter((f) => f.platformWakeOwnerAgentId);
  if (routable.length) {
    const byOwner = new Map();
    for (const f of routable) {
      const k = `${f.assigneeName} <${f.assigneeAgentId}>`;
      if (!byOwner.has(k)) byOwner.set(k, []);
      byOwner.get(k).push(f.identifier || f.id);
    }
    L.push('routing  one child issue per OWNER (not per issue — N simultaneous wakes is the');
    L.push('         same session-limit pressure that writes this shape in the first place):');
    for (const [owner, ids] of byOwner) L.push(`   ${owner}  ->  ${ids.join(', ')}`);
    L.push('');
  }
  if (alreadyWoken.length) {
    L.push('do NOT route  a live recovery action is already waking the owner on these. They are');
    L.push('              still findings — the empty array is still an auto-flip risk — but a');
    L.push('              fresh child issue here is a duplicate wake, not a remedy:');
    for (const f of alreadyWoken) {
      const w = (result.roster.get(f.platformWakeOwnerAgentId) || {}).name || f.platformWakeOwnerAgentId;
      L.push(`   ${f.identifier || f.id}  (platform is waking ${w})`);
    }
    L.push('');
  }

  // Batch tell.
  const stamps = new Map();
  for (const f of result.findings) {
    if (!f.recoveryAt) continue;
    const bucket = f.recoveryAt.slice(0, 16); // minute
    stamps.set(bucket, (stamps.get(bucket) || 0) + 1);
  }
  const batches = [...stamps.entries()].filter(([, n]) => n > 1);
  if (batches.length) {
    L.push('upstream  findings sharing one recovery stamp = ONE platform event, not N owner lapses:');
    for (const [stamp, n] of batches.sort((a, b) => b[1] - a[1])) L.push(`   ${stamp}Z  ${n} issue(s)`);
    L.push('');
  }

  L.push('reminder  repair is ASSIGNEE-SCOPED: a plain {"status":…} PATCH from outside the');
  L.push('          boundary is 403, and so is POST /comments. Route via a child issue');
  L.push('          (POST /api/issues/{parent}/children with assigneeAgentId).');
  L.push('          ⛔ Do NOT anchor a child onto its own parent to satisfy "blocked needs a');
  L.push('          blocker" — that is a 2-cycle neither side can break. `todo` is the correct');
  L.push('          disposition for a parked-ready leaf.');
  L.push('');
  L.push('no repair command is emitted, on purpose (TRA-2396). The rollup field that used to');
  L.push('supply the anchor samples DESCENDANTS, so an edge built from it is a guaranteed');
  L.push('2-cycle — worse than the empty array, because an empty blockedBy at least auto-flips');
  L.push('and stays visible. A wrong repair command is worse output than none: routing is this');
  L.push('detector\'s job, and the anchor is the assignee\'s to re-derive. Paste the `cause:` line');
  L.push('as-is when you file — it is branched on the marker, not guessed.');
  return L;
}

/* ------------------------------------------------------------------ *
 * Controls
 *
 * Bidirectional on purpose. A control that only proves the detector FIRES
 * cannot tell a fix from the bug; a control that only proves it stays quiet
 * cannot tell a working detector from a wired-shut one. And both of this
 * script's real hazards live in the PLUMBING, not the predicate — so every
 * case below drives the full `sweep()`, transport and all.
 * ------------------------------------------------------------------ */

const ROSTER = [
  { id: 'agent-cto', name: 'CTO', role: 'cto' },
  { id: 'agent-cfo', name: 'CFO', role: 'ceo' },
  { id: 'agent-qt', name: 'QuantTrader', role: 'researcher' },
];

/** Build a synthetic board big enough that paging is load-bearing. */
function fakeBoard(planted, { total = 2350 } = {}) {
  const rows = [];
  for (let i = 0; i < total; i += 1) {
    rows.push({
      id: `filler-${i}`,
      identifier: `TRA-${9000 + i}`,
      title: `filler ${i}`,
      status: i % 7 === 0 ? 'done' : 'todo',
      assigneeAgentId: 'agent-cto',
    });
  }
  // Plant the specimens near the END so a one-page sweep cannot see them.
  // This is the whole point of the positive control: a fixture whose shape
  // sits inside the first 1000 rows would go green on a broken enumerator.
  rows.splice(total - 5, 0, ...planted.map((p) => ({ ...p.list })));
  const items = new Map(planted.map((p) => [p.item.id, p.item]));
  return { rows, items };
}

function transportFor(
  board,
  { ignoreOffset = false, stripBlockedByKey = false, comments = {}, commentsThrow = false, noCommentTransport = false } = {},
) {
  const t = {
    listAgents: async () => ROSTER,
    getIssuesPage: async ({ limit, offset }) => {
      const start = ignoreOffset ? 0 : offset;
      return board.rows.slice(start, start + limit);
    },
    getIssue: async (id) => {
      const item = board.items.get(id);
      if (!item) return { id, identifier: id, status: 'blocked', blockedBy: [], assigneeAgentId: 'agent-cto' };
      if (stripBlockedByKey) {
        const { blockedBy: _dropped, ...rest } = item;
        return rest;
      }
      return item;
    },
  };
  if (!noCommentTransport) {
    t.getComments = async (id) => {
      if (commentsThrow) throw new Error('HTTP 403 on the comment route');
      return comments[id] || [];
    };
  }
  return t;
}

/** A system-authored recovery comment, verbatim in shape from TRA-2310 comment 6. */
const sysRecoveryComment = (at = '2026-07-25T20:45:12.831Z', ownerName = 'CFO', ownerId = 'agent-cfo') => ({
  id: `c-${at}`,
  authorType: 'system',
  authorAgentId: null,
  authorUserId: null,
  createdAt: at,
  body:
    'Paperclip automatically retried continuation for this assigned `in_progress` issue during terminal run ' +
    "recovery, but it still has no live execution path. Latest retry failure: `acpx_turn_failed` - Internal " +
    "error: You've hit your session limit. Moving it to `blocked` so it is visible for intervention.\n" +
    `- Recovery action: \`1a8e6fee-4947-424e-9d45-2ac55db3e320\`\n- Recovery owner: [${ownerName}](/TRA/agents/${ownerId})`,
});

/**
 * An AGENT comment that QUOTES the recovery text — the trap. Agents discuss
 * `acpx_turn_failed` constantly (TRA-2396's own body does), so a marker regex
 * without the authorship gate reads this as a system write.
 */
const agentQuotingRecovery = (at = '2026-07-26T06:01:26.217Z') => ({
  id: `c-agent-${at}`,
  authorType: 'agent',
  authorAgentId: 'agent-cfo',
  authorUserId: null,
  createdAt: at,
  body:
    'CFO — triage. Note for the record: the cluster of `blocked` issues on 07-25 came from ' +
    '`acpx_turn_failed` recovery writes. Recovery owner: CFO on those. This issue is NOT one of them.',
});

const held = (id, ident, assignee) => ({
  list: { id, identifier: ident, title: `held ${ident}`, status: 'blocked', assigneeAgentId: assignee },
  item: {
    id,
    identifier: ident,
    title: `held ${ident}`,
    status: 'blocked',
    priority: 'medium',
    assigneeAgentId: assignee,
    blockedBy: [{ id: 'other', identifier: 'TRA-1', status: 'todo' }],
  },
});

const stranded = (id, ident, assignee, extra = {}) => ({
  list: { id, identifier: ident, title: `stranded ${ident}`, status: 'blocked', assigneeAgentId: assignee },
  item: {
    id,
    identifier: ident,
    title: `stranded ${ident}`,
    status: 'blocked',
    priority: 'high',
    assigneeAgentId: assignee,
    blockedBy: [],
    activeRecoveryAction: { kind: 'stranded_assigned_issue', createdAt: '2026-07-26T02:01:14.000Z' },
    ...extra,
  },
});

/**
 * A non-blocked issue planted only so the parent GRAPH has something in it. It
 * is never itself a finding (status !== 'blocked'), which is the point: the
 * descendant test has to work off the enumeration, not off the findings.
 */
const relative = (id, ident, { parentId = null, status = 'todo', assignee = 'agent-cto' } = {}) => ({
  list: { id, identifier: ident, title: `relative ${ident}`, status, assigneeAgentId: assignee, parentId },
  item: { id, identifier: ident, title: `relative ${ident}`, status, assigneeAgentId: assignee, parentId, blockedBy: [] },
});

const rollup = (unresolvedBlockerCount, sampleBlockerIdentifier, extra = {}) => ({
  blockerAttention: {
    state: 'needs_attention',
    reason: 'attention_required',
    unresolvedBlockerCount,
    sampleBlockerIdentifier,
    ...extra,
  },
});

const CASES = [
  {
    name: 'known-GOOD board: 3 blocked issues, all with real blockers => CLEAN (detector stays SILENT)',
    expect: 'CLEAN',
    build: () => transportFor(fakeBoard([held('h1', 'TRA-8001', 'agent-cto'), held('h2', 'TRA-8002', 'agent-cfo'), held('h3', 'TRA-8003', 'agent-qt')])),
    assert: (r) => r.findings.length === 0 && r.scanned > 1000,
  },
  {
    name: 'POSITIVE CONTROL: the shape is present, planted PAST row 1000 => FINDINGS, found by identifier',
    expect: 'FINDINGS',
    build: () => transportFor(fakeBoard([held('h1', 'TRA-8001', 'agent-cto'), stranded('s1', 'TRA-8010', 'agent-cto'), stranded('s2', 'TRA-8011', 'agent-cfo')])),
    assert: (r) =>
      r.findings.length === 2 &&
      r.findings.every((f) => f.severity === SEVERITY.ROUTE_TO_ASSIGNEE) &&
      r.findings.map((f) => f.identifier).sort().join(',') === 'TRA-8010,TRA-8011',
  },
  {
    name: 'off-roster assignee + unassigned => FINDINGS_UNREPAIRABLE, each its own severity',
    expect: 'FINDINGS_UNREPAIRABLE',
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8010', 'agent-cto'),
          stranded('s2', 'TRA-8020', 'agent-ghost'),
          stranded('s3', 'TRA-8030', null),
        ]),
      ),
    assert: (r) => {
      const bySev = Object.fromEntries(r.findings.map((f) => [f.identifier, f.severity]));
      return (
        r.findings.length === 3 &&
        bySev['TRA-8010'] === SEVERITY.ROUTE_TO_ASSIGNEE &&
        bySev['TRA-8020'] === SEVERITY.UNREPAIRABLE_OFF_ROSTER &&
        bySev['TRA-8030'] === SEVERITY.UNREPAIRABLE_UNASSIGNED
      );
    },
  },
  {
    name: 'blockerAttention says "covered" over an EMPTY blockedBy => STILL a finding (grade the shape, not the rollup)',
    expect: 'FINDINGS',
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8040', 'agent-qt', {
            blockerAttention: { state: 'covered', reason: 'active_child', unresolvedBlockerCount: 1, sampleBlockerIdentifier: 'TRA-2339' },
          }),
        ]),
      ),
    assert: (r) => r.findings.length === 1 && r.findings[0].blockerAttentionState === 'covered',
  },
  {
    name: 'TRAP 1 — list route IGNORES offset (full page, zero new ids) => BLIND, never CLEAN',
    expect: 'BLIND',
    build: () => transportFor(fakeBoard([stranded('s1', 'TRA-8010', 'agent-cto')]), { ignoreOffset: true }),
    assert: (r) => /ignored offset/.test(r.blind) && r.findings.length === 0,
  },
  {
    name: 'TRAP 2 — item route carries NO blockedBy key => BLIND, never "all clear" and never "all flagged"',
    expect: 'BLIND',
    build: () =>
      transportFor(fakeBoard([held('h1', 'TRA-8001', 'agent-cto'), stranded('s1', 'TRA-8010', 'agent-cto')]), {
        stripBlockedByKey: true,
      }),
    assert: (r) => r.unreadable.length > 0 && /blockedBy/.test(r.unreadable[0]) && r.findings.length === 0,
  },
  {
    name: 'a THIRD route in (missing_disposition) with a live wake_owner recovery => STILL a finding, flagged do-not-route',
    expect: 'FINDINGS',
    // Measured live on TRA-2377, 2026-07-26T06:24Z: a run that SUCCEEDED but
    // recorded no disposition. Keying the detector on the recovery KIND would
    // have missed it, and the active wake must annotate the row without ever
    // suppressing it — the empty array is an auto-flip risk regardless of who
    // is being poked.
    expectAnnotation: true,
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8050', 'agent-qt', {
            activeRecoveryAction: {
              kind: 'missing_disposition',
              cause: 'successful_run_missing_state',
              status: 'active',
              ownerAgentId: 'agent-qt',
              wakePolicy: { type: 'wake_owner', ownerAgentId: 'agent-qt' },
              createdAt: '2026-07-26T06:24:12.346Z',
            },
          }),
        ]),
      ),
    assert: (r) =>
      r.findings.length === 1 &&
      r.findings[0].severity === SEVERITY.ROUTE_TO_ASSIGNEE &&
      r.findings[0].recoveryKind === 'missing_disposition' &&
      r.findings[0].platformWakeOwnerAgentId === 'agent-qt' &&
      // and the annotation must NOT have removed it from the report
      renderReport(r).join('\n').includes('TRA-8050'),
  },
  {
    name: 'a RESOLVED recovery action does NOT count as a live wake (status must be active)',
    expect: 'FINDINGS',
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8060', 'agent-qt', {
            activeRecoveryAction: {
              kind: 'missing_disposition',
              status: 'resolved',
              wakePolicy: { type: 'wake_owner', ownerAgentId: 'agent-qt' },
              createdAt: '2026-07-26T06:24:12.346Z',
            },
          }),
        ]),
      ),
    assert: (r) => r.findings.length === 1 && r.findings[0].platformWakeOwnerAgentId === null,
  },
  {
    // ⛔ THE TRA-2396 CASE, and the one that was previously a SILENT WRONG ANSWER:
    // the rollup names a candidate, the candidate is a CHILD of the subject, and
    // the old report had nothing to say about it — so the filer improvised a PATCH
    // that would have created a 2-cycle. Per the standing rule, that failing state
    // read identically to the passing one.
    name: 'ANCHOR — every rollup blocker is a DESCENDANT => "no valid anchor", and NO PATCH is emitted',
    expect: 'FINDINGS',
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8070', 'agent-cto', rollup(1, 'TRA-8071')),
          relative('c1', 'TRA-8071', { parentId: 's1' }),
        ]),
      ),
    assert: (r) => {
      const f = r.findings.find((x) => x.identifier === 'TRA-8070');
      const out = renderReport(r).join('\n');
      return (
        r.findings.length === 1 &&
        f.anchor.verdict === ANCHOR.ALL_DESCENDANTS &&
        f.anchor.candidates.length === 1 &&
        f.anchor.candidates[0].reason === 'DESCENDANT' &&
        f.rollupUnresolvedCount === 1 && // the COUNT still prints — it is real signal
        /no valid anchor/i.test(out) &&
        !/blockedByIssueIds/.test(out)
      );
    },
  },
  {
    // A GRANDCHILD, so the test cannot pass by comparing `parentId` one hop.
    name: 'ANCHOR — a GRANDCHILD is a descendant too (the chain is walked, not one hop)',
    expect: 'FINDINGS',
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8072', 'agent-cto', rollup(1, 'TRA-8074')),
          relative('c1', 'TRA-8073', { parentId: 's1' }),
          relative('c2', 'TRA-8074', { parentId: 'c1' }),
        ]),
      ),
    assert: (r) => r.findings[0].anchor.verdict === ANCHOR.ALL_DESCENDANTS,
  },
  {
    name: 'ANCHOR — a NON-descendant candidate survives, but is labelled UNVERIFIED and still gets no PATCH',
    expect: 'FINDINGS',
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8075', 'agent-cto', rollup(1, 'TRA-8076')),
          relative('p1', 'TRA-8076', { parentId: null }),
        ]),
      ),
    assert: (r) => {
      const f = r.findings[0];
      const out = renderReport(r).join('\n');
      return (
        f.anchor.verdict === ANCHOR.CANDIDATE_UNVERIFIED &&
        f.anchor.candidates[0].reason === 'SURVIVES' &&
        !/blockedByIssueIds/.test(out) &&
        /UNVERIFIED/.test(out)
      );
    },
  },
  {
    name: 'ANCHOR — a `done` candidate is struck out (an inert blocker READS like a repair)',
    expect: 'FINDINGS',
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8077', 'agent-cto', rollup(1, 'TRA-8078')),
          relative('p1', 'TRA-8078', { parentId: null, status: 'done' }),
        ]),
      ),
    assert: (r) =>
      r.findings[0].anchor.verdict === ANCHOR.ALL_INELIGIBLE && r.findings[0].anchor.candidates[0].reason === 'CLOSED',
  },
  {
    name: 'CAUSE — a live activeRecoveryAction => RECOVERY-BLOCKED, "no anchor was ever intended" (no comment read needed)',
    expect: 'FINDINGS',
    build: () => transportFor(fakeBoard([stranded('s1', 'TRA-8080', 'agent-cto')])),
    assert: (r) => {
      const f = r.findings[0];
      return (
        f.cause === CAUSE.RECOVERY_BLOCKED &&
        f.causeVia === 'activeRecoveryAction' &&
        /NO anchor was ever intended/.test(causeSentence(f, r.roster)) &&
        // present tense, from the item route itself — this arm needs no hedge
        f.causeHedge === null
      );
    },
  },
  {
    // TRA-2310's actual history: the recovery action was discharged, and the only
    // surviving evidence is the system comment it left behind.
    name: 'CAUSE — a DISCHARGED recovery, evidenced only by the SYSTEM comment => RECOVERY-BLOCKED, owner named',
    expect: 'FINDINGS',
    build: () =>
      transportFor(fakeBoard([stranded('s1', 'TRA-8081', 'agent-cto', { activeRecoveryAction: null })]), {
        comments: { s1: [sysRecoveryComment('2026-07-25T20:45:12.831Z', 'CFO', 'agent-cfo')] },
      }),
    assert: (r) => {
      const f = r.findings[0];
      return (
        f.cause === CAUSE.RECOVERY_BLOCKED &&
        f.causeVia === 'system-authored recovery comment' &&
        f.recoveryOwnerName === 'CFO' &&
        /Recovery owner: CFO/.test(causeSentence(f, r.roster)) &&
        // ...and THIS arm is a thread read, so it must carry the hedge the live
        // arm does not. Same verdict, different confidence — say which.
        /cannot be excluded/.test(causeSentence(f, r.roster))
      );
    },
  },
  {
    // ⛔ The authorship gate. Without it the marker regex fires on any thread that
    // merely TALKS about recovery, and the branch inverts.
    name: 'CAUSE — an AGENT comment QUOTING `acpx_turn_failed` is NOT a marker => DROPPED-EDGE, and hedged',
    expect: 'FINDINGS',
    build: () =>
      transportFor(fakeBoard([stranded('s1', 'TRA-8082', 'agent-cto', { activeRecoveryAction: null })]), {
        comments: { s1: [agentQuotingRecovery()] },
      }),
    assert: (r) => {
      const f = r.findings[0];
      const s = causeSentence(f, r.roster);
      return f.cause === CAUSE.DROPPED_EDGE_INFERRED && /INFERENCE/.test(s) && /PLAUSIBLE/.test(s);
    },
  },
  {
    name: 'CAUSE — a DELETED system marker does not count (deletedAt) => DROPPED-EDGE, hedged',
    expect: 'FINDINGS',
    build: () =>
      transportFor(fakeBoard([stranded('s1', 'TRA-8083', 'agent-cto', { activeRecoveryAction: null })]), {
        comments: { s1: [{ ...sysRecoveryComment(), deletedAt: '2026-07-26T00:00:00.000Z' }] },
      }),
    assert: (r) => r.findings[0].cause === CAUSE.DROPPED_EDGE_INFERRED,
  },
  {
    // ⛔ An UNREAD thread is not an absent marker. Fail closed on the NARRATIVE:
    // the inference must not be strongest exactly where we read least.
    name: 'CAUSE — the comment GET throws (403) => CAUSE UNKNOWN, never the dropped-edge narrative',
    expect: 'FINDINGS',
    build: () =>
      transportFor(fakeBoard([stranded('s1', 'TRA-8084', 'agent-cto', { activeRecoveryAction: null })]), {
        commentsThrow: true,
      }),
    assert: (r) => {
      const f = r.findings[0];
      const s = causeSentence(f, r.roster);
      return f.cause === CAUSE.UNKNOWN && /CAUSE UNKNOWN/.test(s) && !/DROPPED-EDGE/.test(s);
    },
  },
  {
    name: 'CAUSE — no comment transport at all => CAUSE UNKNOWN (an unchecked marker is not an absent one)',
    expect: 'FINDINGS',
    build: () =>
      transportFor(fakeBoard([stranded('s1', 'TRA-8085', 'agent-cto', { activeRecoveryAction: null })]), {
        noCommentTransport: true,
      }),
    assert: (r) => r.findings[0].cause === CAUSE.UNKNOWN,
  },
  {
    name: 'TRAP 1c — truncating the enumeration at the page cap => BLIND, never a count off a partial board',
    expect: 'BLIND',
    build: () => transportFor(fakeBoard([stranded('s1', 'TRA-8010', 'agent-cto')])),
    opts: { maxPages: 1 },
    assert: (r) => /page cap/.test(r.blind) && r.findings.length === 0,
  },
];

/**
 * TRAP 1b — the differential that makes the paging load-bearing rather than
 * decorative: run the sweep everyone actually writes (ONE unpaginated call,
 * classify what came back) against the same board, and show it reports a clean
 * bill of health on a board that contains the shape.
 *
 * Without this, "the paged sweep found 1" is unfalsifiable — it never
 * demonstrates that the un-paged one would have found 0.
 */
async function naiveMissControl() {
  const board = fakeBoard([stranded('s1', 'TRA-8010', 'agent-cto')]);
  const t = transportFor(board);
  const roster = new Map(ROSTER.map((a) => [a.id, a]));

  // The naive sweep: one page, no offset loop.
  const onePage = await t.getIssuesPage({ limit: PAGE_LIMIT, offset: 0 });
  const naive = [];
  for (const row of onePage.filter((r) => r.status === 'blocked')) {
    const g = classifyIssue(await t.getIssue(row.id), roster);
    if (g && !g.unreadable) naive.push(g);
  }

  const paged = await sweep(t);
  const ok = naive.length === 0 && paged.verdict === 'FINDINGS' && paged.findings.length === 1;
  return {
    ok,
    detail: `naive one-page sweep found ${naive.length} (rows seen: ${onePage.length}); paged sweep found ${paged.findings.length} of ${paged.scanned}`,
  };
}

/**
 * The invariant that outranks every individual case: NO rendering of ANY board
 * may contain a copy-pasteable `blockedByIssueIds` write. TRA-2383 shipped one
 * inside a report that also argued against running it — prose loses to
 * copy-paste, so the string must simply never be emitted.
 */
function assertNoRepairCommand(rendered) {
  return !/blockedByIssueIds/.test(rendered) && !/PATCH \/api\/issues/.test(rendered);
}

async function selftest() {
  let failed = 0;
  let renderedAll = '';
  for (const c of CASES) {
    let got = 'THREW';
    let ok = false;
    let detail = '';
    try {
      const r = await sweep(c.build(), c.opts || {});
      got = r.verdict;
      renderedAll += `${renderReport(r).join('\n')}\n`;
      ok = got === c.expect && c.assert(r);
      if (got !== c.expect) detail = `verdict ${got} != ${c.expect}`;
      else if (!ok) detail = 'verdict matched but the assertion on the payload failed';
    } catch (err) {
      detail = String(err?.stack || err);
    }
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.note ? `  [${c.note}]` : ''}${ok ? '' : `\n        ${detail}`}`);
  }

  const noCmd = assertNoRepairCommand(renderedAll);
  if (!noCmd) failed += 1;
  console.log(
    `${noCmd ? 'ok  ' : 'FAIL'}  GLOBAL — no rendering of ANY control board emits a copy-pasteable repair PATCH\n` +
      `        (checked the concatenated report of every case above for 'blockedByIssueIds' / 'PATCH /api/issues')`,
  );

  const miss = await naiveMissControl();
  if (!miss.ok) failed += 1;
  console.log(
    `${miss.ok ? 'ok  ' : 'FAIL'}  TRAP 1b — the un-paginated sweep MISSES the planted shape (paging is load-bearing)\n` +
      `        ${miss.detail}`,
  );

  // Reachability: a control set that cannot produce every verdict is not a
  // control set, it is a rubber stamp with an alarm attached.
  //
  // ⛔ Asserted as COVERAGE, never as a count. The number of controls only ever
  // grows, so a pinned "8 controls pass" goes stale the next time someone adds
  // one — pin the DIRECTIONS that must be reachable instead.
  const reachable = new Set(CASES.map((c) => c.expect));
  const need = ['CLEAN', 'FINDINGS', 'FINDINGS_UNREPAIRABLE', 'BLIND'];
  const missing = need.filter((v) => !reachable.has(v));
  const total = CASES.length + 2; // + the naive-miss differential + the global no-command invariant
  console.log(`\n${total - failed}/${total} controls pass; verdicts reachable: ${[...reachable].sort().join(', ')}`);
  if (missing.length) {
    console.log(`FAIL  no control exercises: ${missing.join(', ')}`);
    failed += 1;
  }

  // Same rule one level down: the cause branch and the anchor verdict each need
  // every arm reachable, or a wired-shut branch passes as a working one.
  const causeArms = new Set([CAUSE.RECOVERY_BLOCKED, CAUSE.DROPPED_EDGE_INFERRED, CAUSE.UNKNOWN]);
  const anchorArms = new Set([ANCHOR.ALL_DESCENDANTS, ANCHOR.ALL_INELIGIBLE, ANCHOR.CANDIDATE_UNVERIFIED, ANCHOR.NO_CANDIDATES]);
  const seenCause = new Set();
  const seenAnchor = new Set();
  for (const c of CASES) {
    try {
      const r = await sweep(c.build(), c.opts || {});
      for (const f of r.findings) {
        seenCause.add(f.cause);
        if (f.anchor) seenAnchor.add(f.anchor.verdict);
      }
    } catch {
      /* the case-level loop above already reported it */
    }
  }
  for (const [label, needed, seen] of [
    ['cause', causeArms, seenCause],
    ['anchor', anchorArms, seenAnchor],
  ]) {
    const gaps = [...needed].filter((v) => !seen.has(v));
    if (gaps.length) {
      console.log(`FAIL  no control reaches these ${label} arms: ${gaps.join(', ')}`);
      failed += 1;
    } else {
      console.log(`ok    every ${label} arm is reachable: ${[...seen].sort().join(', ')}`);
    }
  }
  if (failed) console.log('\nThe detector is NOT trustworthy while a control is red.');
  return failed ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Live transport
 * ------------------------------------------------------------------ */

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
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url} — ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  // These routes have returned both a bare array and an envelope; unwrap
  // defensively but NEVER coerce a miss to [] — an empty array here would be
  // indistinguishable from a clean board.
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
    getIssue: async (id) => get(`${BASE}/api/issues/${id}`),
    // Read for FINDINGS only, and only once `activeRecoveryAction` has been
    // discharged. A throw here lands on cause UNKNOWN, never on the dropped-edge
    // inference — do not "helpfully" coerce a failure to [].
    getComments: async (id) => unwrap(await get(`${BASE}/api/issues/${id}/comments`), 'comments'),
  };
}

async function main() {
  if (argv.includes('--selftest')) return selftest();

  const result = await sweep(liveTransport(), { limit: PAGE_LIMIT, maxPages: MAX_PAGES, concurrency: CONCURRENCY });
  const lines = renderReport(result);

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          issue: 'TRA-2364 (detector) + TRA-2396 (cause branch / anchor filter)',
          checkedAt: new Date().toISOString(),
          verdict: result.verdict,
          blind: result.blind,
          scanned: result.scanned,
          itemReads: result.itemReads,
          pages: result.pages,
          findings: result.findings,
          unreadable: result.unreadable,
        },
        null,
        2,
      ),
    );
  } else {
    for (const l of lines) console.log(l);
  }
  return VERDICT_EXIT[result.verdict] ?? 3;
}

// `process.exit()` inside a try skips the finally; return the code instead and
// exit once, at the top.
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('ERROR', err?.stack || err);
    process.exit(3);
  });
