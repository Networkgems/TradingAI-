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
export function classifyIssue(item, roster) {
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
    // The upstream tell: a batch sharing one stamp is ONE platform event, not
    // N owners forgetting to anchor. Check this before blaming anybody.
    recoveryKind: recovery ? recovery.kind : null,
    recoveryAt: recovery ? recovery.createdAt || recovery.updatedAt || null : null,
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

export async function sweep({ getIssuesPage, getIssue, listAgents }, opts = {}) {
  const agents = await listAgents();
  const roster = new Map((Array.isArray(agents) ? agents : []).map((a) => [a.id, a]));

  const { issues, pages, blind: enumBlind } = await enumerateIssues(getIssuesPage, opts);
  if (enumBlind) {
    return { verdict: 'BLIND', blind: enumBlind, pages, roster, scanned: 0, itemReads: 0, findings: [], unreadable: [] };
  }

  const blockedRows = issues.filter((i) => i.status === 'blocked');

  const findings = [];
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
      const graded = classifyIssue(item, roster);
      if (graded && graded.unreadable) unreadable.push(graded.unreadable);
      else if (graded) findings.push(graded);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, blockedRows.length || 1) }, worker));

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
      L.push(
        `     blockerAttention=${f.blockerAttentionState || 'null'}/${f.blockerAttentionReason || 'null'} (context only)` +
          `  recovery=${f.recoveryKind || 'none'}${f.recoveryAt ? ` @ ${f.recoveryAt}` : ''}`,
      );
    }
    L.push('');
  }

  // Routing table. Repair is assignee-scoped, so the actionable unit is the
  // OWNER, not the issue — and one child issue per owner, never a fan-out of
  // N wakes (the failure mode that caused this shape is session-limit load).
  const routable = bySeverity.get(SEVERITY.ROUTE_TO_ASSIGNEE) || [];
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

function transportFor(board, { ignoreOffset = false, stripBlockedByKey = false } = {}) {
  return {
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
}

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

async function selftest() {
  let failed = 0;
  for (const c of CASES) {
    let got = 'THREW';
    let ok = false;
    let detail = '';
    try {
      const r = await sweep(c.build(), c.opts || {});
      got = r.verdict;
      ok = got === c.expect && c.assert(r);
      if (got !== c.expect) detail = `verdict ${got} != ${c.expect}`;
      else if (!ok) detail = 'verdict matched but the assertion on the payload failed';
    } catch (err) {
      detail = String(err?.stack || err);
    }
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.note ? `  [${c.note}]` : ''}${ok ? '' : `\n        ${detail}`}`);
  }

  const miss = await naiveMissControl();
  if (!miss.ok) failed += 1;
  console.log(
    `${miss.ok ? 'ok  ' : 'FAIL'}  TRAP 1b — the un-paginated sweep MISSES the planted shape (paging is load-bearing)\n` +
      `        ${miss.detail}`,
  );

  // Reachability: a control set that cannot produce every verdict is not a
  // control set, it is a rubber stamp with an alarm attached.
  const reachable = new Set(CASES.map((c) => c.expect));
  const need = ['CLEAN', 'FINDINGS', 'FINDINGS_UNREPAIRABLE', 'BLIND'];
  const missing = need.filter((v) => !reachable.has(v));
  const total = CASES.length + 1; // + the naive-miss differential
  console.log(`\n${total - failed}/${total} controls pass; verdicts reachable: ${[...reachable].sort().join(', ')}`);
  if (missing.length) {
    console.log(`FAIL  no control exercises: ${missing.join(', ')}`);
    failed += 1;
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
          issue: 'TRA-2364',
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
