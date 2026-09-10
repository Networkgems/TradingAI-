#!/usr/bin/env node
/**
 * TRA-4487 (off TRA-4486 ask 3) — detector for the DARK GATE: an open issue
 * that HOLDS other open work down while owning no path by which anything will
 * ever wake it.
 *
 * WHAT THE SHAPE IS, PROVEN BY TRA-3058
 * -------------------------------------
 * A clock-gate leaf deliberately rests `todo` (NOT `blocked` — TRA-3058 is the
 * sanctioned rest for a parked-ready leaf, precisely so it stays out of the
 * STRAND TEST), and its unblock path is a one-shot routine. Then every fire of
 * that routine dies (TRA-3058: all 5 date-pinned fires killed by the
 * 2026-08-06 account spend limit) and the routines are archived. The leaf now
 * falls between BOTH existing issue-side detectors:
 *
 *   - `check:strands` (check-blocked-empty.mjs) keys on status `blocked` with
 *     no open `blockedBy`. A `todo` leaf is skipped BY DESIGN.
 *   - `check:spent-oneshot` (TRA-3008) scans ACTIVE routines. The archived
 *     routines that were this leaf's only wake path are out of scope.
 *
 * Result: TRA-3058 sat 34 days holding TRA-3052 → TRA-3057 → TRA-3110 (a live
 * security ticket) dark, with ZERO recovery actions raised. The deliverable —
 * a 30-day-retention log window — evaporated while it waited. The same sweep
 * (TRA-4486) found TRA-3553 (critical, root of three chains, one stranded
 * since 2026-07-11) and TRA-2918 in the identical shape; both were LeadDev
 * queue-position cases, not dead agents — the shape does not need a dead
 * owner, only a queue that never reaches the row.
 *
 * THE PREDICATE (QuantTrader wording, TRA-4486, verified against the incident)
 * ---------------------------------------------------------------------------
 * Flag any OPEN (non-terminal) issue where ALL FOUR hold:
 *
 *   1. it BLOCKS at least one other OPEN issue        (`blocks[]`, detail GET)
 *   2. its own `blockedBy` is empty or has no open entry       (detail GET)
 *   3. `updatedAt` is older than N days (default 7)     (list projection)
 *   4. no `executionPolicy.monitor` `nextCheckAt` in the FUTURE
 *                                                       (list projection)
 * TRA-3058 satisfied all four for 34 days.
 *
 * Condition 1 is what separates a dark GATE from a merely idle leaf: an idle
 * leaf wastes only itself; a dark gate holds a subtree down. Condition 2 rules
 * out rows with a live `issue_blockers_resolved` wake path. Condition 4 rules
 * out rows correctly parked on a scheduled monitor — a SPENT monitor
 * (`monitorNextCheckAt` null after a fire) is NOT a wake path and does not
 * clear the row. Condition 3 is the debounce: a row someone touched this week
 * has an owner thinking about it.
 *
 * DELIBERATE OVERLAPS — overlap beats a gap, and both are one-way
 * ---------------------------------------------------------------
 *   - A `blocked` row with empty `blockedBy` that also blocks open work and is
 *     stale matches here AND in `check:strands`. Fine: double coverage on the
 *     loud shape, while THIS check alone covers the quiet `todo`/`backlog`/
 *     `in_review` shapes.
 *   - A stale `in_review` row whose monitor is spent matches here AND in
 *     `check:spent-monitor` — but only if it blocks open work AND
 *     `monitorScheduledBy` was ever set; a never-armed `in_review` gate is
 *     invisible to that check and visible to this one.
 *
 * TRAPS — each is a way to print a clean number that is wrong, each has a
 * control in `--selftest`
 * ----------------------------------------------------------------------
 *  1. ⛔ THE LIST PROJECTION DOES NOT SERVE `blocks` OR `blockedBy` (measured
 *     2026-09-10, same result as TRA-4081's measurement of `blockedBy`).
 *     Reading either off a list row yields `undefined`, and `(undefined ?? [])
 *     .filter(...)` is an empty array — which reads as "blocks nothing", i.e.
 *     CLEAN, on every row in the company. Edge conditions are graded ONLY from
 *     a per-row detail GET, and only for rows that survive the cheap list-side
 *     filters (open + stale + unmonitored), so the extra reads stay bounded.
 *  2. ⛔ ZERO ROWS SCANNED IS BLIND, NOT CLEAN. Auth failure, renamed route,
 *     empty company: all render as zero findings over zero rows.
 *  3. ⛔ A ROW MISSING A PREDICATE FIELD IS BLIND, NOT CLEAN. If the
 *     projection drops `updatedAt` or `monitorNextCheckAt`, or a detail GET
 *     stops carrying `blocks`/`blockedBy`, the absent key must not grade as
 *     "fresh" / "no monitor" / "blocks nothing". Absence and value must not
 *     share a verdict.
 *  4. ⛔ AN UNRECOGNISED STATUS IS BLIND — on the row itself AND on a
 *     `blocks[]` entry. Guessing terminal hides gates; guessing open invents
 *     them.
 *  5. ⛔ THE PAGE LOOP ENDS ON A SHORT PAGE, NEVER ON A BELIEVED TOTAL
 *     (TRA-4078: a loop that believed "1800 issues" hid 13 of 38 findings
 *     behind its early stop). Hitting the safety bound is BLIND, not done.
 *  6. ⛔ A FAILED DETAIL GET IS BLIND, NEVER "no edges". Fail closed: an
 *     unreadable candidate is an ungraded one, and BLIND outranks FLAGGED so
 *     one unreadable row cannot be drowned out by nine loud ones.
 *
 * WHAT THE REMEDY IS NOT
 * ----------------------
 * This check ROUTES; it does not repair, and the finding is not "close the
 * row". A dark gate usually guards something real (TRA-3058 guarded a
 * security deliverable). The remedy is owner-shaped: re-derive whether the
 * gate condition still holds, then either finish it, arm a REAL future
 * monitor (`executionPolicy.monitor.nextCheckAt` — one-shot, so re-arm on
 * every fire), or hand it to whoever can. Closing it un-derived converts a
 * dark gate into a shape-2 silent strand on its dependents (see
 * `check:strands` header) — strictly worse.
 *
 * VERDICTS AND EXIT CODES
 * -----------------------
 *   0  CLEAN    — population fully read; zero dark gates.
 *   1  FLAGGED  — at least one dark gate. The incident.
 *   2  USAGE    — bad invocation.
 *   3  BLIND    — the population or a row is untrustworthy. NOT a pass.
 * BLIND > FLAGGED > CLEAN. "Could not check" and "checked and it is fine"
 * must never share an exit code.
 *
 * Usage:
 *   node scripts/check-dark-gates.mjs [--json] [--stale-days=7] [--owner=<agentId>]
 *   node scripts/check-dark-gates.mjs --selftest      # the controls
 *
 * Env: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.
 */

const PAGE_LIMIT = 200;
// Deliberately far above any plausible company size. Hitting it is TRAP 5.
const MAX_PAGES = 200;
const DEFAULT_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

export const VERDICT_EXIT = { CLEAN: 0, FLAGGED: 1, USAGE: 2, BLIND: 3 };

export const NON_TERMINAL = new Set(['todo', 'in_progress', 'in_review', 'blocked', 'backlog']);
export const TERMINAL = new Set(['done', 'cancelled', 'completed', 'closed', 'archived']);

const parseTs = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * First pass — LIST projection only. Returns {state, detail}.
 *   TERMINAL   closed; out of population.
 *   FRESH      open but touched inside the stale window. Not a candidate.
 *   MONITORED  open with a monitor scheduled in the FUTURE — a live wake path.
 *   CANDIDATE  open, stale, no future monitor. Needs the edge GET.
 *   BLIND      ungradeable — trap 3/4.
 */
export function gradeRow(row, now, staleMs) {
  if (!row || typeof row !== 'object') {
    return { state: 'BLIND', detail: 'row is not an object' };
  }
  const id = row.identifier ?? row.id ?? '<no id>';

  // TRAP 4 — an unrecognised status is BLIND, never assumed either way.
  if (typeof row.status !== 'string' || !row.status) {
    return { state: 'BLIND', detail: `${id}: row carries no \`status\`` };
  }
  if (!NON_TERMINAL.has(row.status) && !TERMINAL.has(row.status)) {
    return { state: 'BLIND', detail: `${id}: unrecognised status ${JSON.stringify(row.status)}` };
  }
  if (TERMINAL.has(row.status)) return { state: 'TERMINAL' };

  // Condition 3 — staleness. TRAP 3: an absent/unparseable `updatedAt` is
  // BLIND, not fresh — "never touched" is the stalest a row can possibly be.
  if (!('updatedAt' in row)) {
    return { state: 'BLIND', detail: `${id}: projection carries no \`updatedAt\` key` };
  }
  const updated = parseTs(row.updatedAt);
  if (updated === null) {
    return { state: 'BLIND', detail: `${id}: unparseable updatedAt ${JSON.stringify(row.updatedAt)}` };
  }
  if (now - updated < staleMs) return { state: 'FRESH' };

  // Condition 4 — a monitor scheduled in the FUTURE is a live wake path.
  // TRAP 3 again: only the FUTURE value clears the row. A null (never armed OR
  // spent — indistinguishable here and equally dead) and a PAST value both
  // leave it a candidate. An absent key on a row that DID arm a monitor would
  // hide every spent-monitor gate, so the key itself is demanded.
  if (!('monitorNextCheckAt' in row)) {
    return { state: 'BLIND', detail: `${id}: projection carries no \`monitorNextCheckAt\` key` };
  }
  const next = row.monitorNextCheckAt;
  if (next !== null && next !== undefined) {
    const nextTs = parseTs(next);
    if (nextTs === null) {
      return { state: 'BLIND', detail: `${id}: unparseable monitorNextCheckAt ${JSON.stringify(next)}` };
    }
    if (nextTs > now) return { state: 'MONITORED' };
  }

  return { state: 'CANDIDATE' };
}

/**
 * Second pass — conditions 1 and 2, from ONE detail GET per candidate.
 * Returns {state, detail, openBlocks?}:
 *   FLAGGED           blocks ≥1 open issue AND no open blocker of its own.
 *   BLOCKS_NOTHING    condition 1 fails — idle, but holding nothing down.
 *   LIVE_BLOCKER      condition 2 fails — `issue_blockers_resolved` will wake it.
 *   BLIND             unreadable row / absent edge arrays / ungradeable entry.
 * Fails closed everywhere (TRAP 6).
 */
export async function resolveEdges(getIssue, row) {
  const id = row.identifier ?? row.id;
  let full;
  try {
    full = await getIssue(row.id);
  } catch (err) {
    return { state: 'BLIND', detail: `${id}: detail GET failed: ${err?.message ?? err}` };
  }
  if (!full || typeof full !== 'object') {
    return { state: 'BLIND', detail: `${id}: detail GET returned no object` };
  }

  // Condition 1 — blocks at least one OPEN issue.
  if (!Array.isArray(full.blocks)) {
    return { state: 'BLIND', detail: `${id}: detail GET carries no \`blocks\` array` };
  }
  const openBlocks = [];
  for (const b of full.blocks) {
    if (!b || typeof b.status !== 'string' || !b.status) {
      return { state: 'BLIND', detail: `${id}: a \`blocks\` entry carries no status` };
    }
    if (!NON_TERMINAL.has(b.status) && !TERMINAL.has(b.status)) {
      return { state: 'BLIND', detail: `${id}: blocks entry ${b.identifier ?? b.id} has unrecognised status ${JSON.stringify(b.status)}` };
    }
    if (NON_TERMINAL.has(b.status)) openBlocks.push(b);
  }
  if (openBlocks.length === 0) return { state: 'BLOCKS_NOTHING' };

  // Condition 2 — no open blocker of its own. ⛔ `blockedByIssueIds` is
  // undefined on every GET; `blockedBy` is the served array.
  if (!Array.isArray(full.blockedBy)) {
    return { state: 'BLIND', detail: `${id}: detail GET carries no \`blockedBy\` array` };
  }
  const openBlockedBy = full.blockedBy.filter((b) => b && typeof b.status === 'string' && NON_TERMINAL.has(b.status));
  if (openBlockedBy.length) {
    return { state: 'LIVE_BLOCKER', detail: `${openBlockedBy.length} open blocker(s)` };
  }

  return { state: 'FLAGGED', openBlocks };
}

/**
 * Page to EXHAUSTION. Returns {rows, blind, pages}.
 * TRAP 5 lives here: the loop ends on a SHORT PAGE, never on a believed total.
 */
export async function enumerateIssues(getPage, { limit = PAGE_LIMIT, maxPages = MAX_PAGES } = {}) {
  const byId = new Map();
  let pages = 0;
  for (let offset = 0; pages < maxPages; offset += limit) {
    let page;
    try {
      page = await getPage({ limit, offset });
    } catch (err) {
      return { rows: [], blind: `issues page at offset ${offset} failed: ${err?.message ?? err}`, pages };
    }
    if (!Array.isArray(page)) {
      return { rows: [], blind: `issues page at offset ${offset} was not an array`, pages };
    }
    pages += 1;
    for (const row of page) {
      if (row && row.id) byId.set(row.id, row);
    }
    if (page.length < limit) return { rows: [...byId.values()], blind: null, pages };
  }
  // TRAP 5 — page budget exhausted with full pages still coming: NOT a result.
  return { rows: [], blind: `page loop hit its ${maxPages}-page safety bound without a short page`, pages };
}

export async function run(transport, { owner = null, staleDays = DEFAULT_STALE_DAYS, now = Date.now() } = {}) {
  const staleMs = staleDays * DAY_MS;
  const { rows, blind, pages } = await enumerateIssues(transport.getIssues);
  if (blind) return { verdict: 'BLIND', blind, scanned: 0, pages, candidates: 0, findings: [], blindRows: [] };

  // TRAP 2 — zero rows scanned is BLIND, not CLEAN.
  if (rows.length === 0) {
    return {
      verdict: 'BLIND',
      blind: 'zero issues scanned — an empty population is unmeasured, not clean',
      scanned: 0,
      pages,
      candidates: 0,
      findings: [],
      blindRows: [],
    };
  }

  const blindRows = [];
  const candidates = [];
  for (const row of rows) {
    const g = gradeRow(row, now, staleMs);
    if (g.state === 'BLIND') blindRows.push({ id: row?.identifier ?? row?.id, detail: g.detail });
    else if (g.state === 'CANDIDATE') candidates.push(row);
  }

  // Second pass, candidates only — TRAP 1: the edges exist only on the detail
  // GET, and TRAP 6: an unsupplied/broken transport fails closed.
  const findings = [];
  if (candidates.length && typeof transport.getIssue !== 'function') {
    for (const row of candidates) {
      blindRows.push({ id: row.identifier ?? row.id, detail: `${row.identifier}: candidate needs an edge read and no getIssue transport was supplied` });
    }
  } else {
    for (const row of candidates) {
      const e = await resolveEdges(transport.getIssue, row);
      if (e.state === 'BLIND') blindRows.push({ id: row.identifier ?? row.id, detail: e.detail });
      else if (e.state === 'FLAGGED') {
        findings.push({
          ...row,
          openBlocks: e.openBlocks,
          staleDays: Math.floor((now - Date.parse(row.updatedAt)) / DAY_MS),
        });
      }
    }
  }

  const scoped = owner ? findings.filter((f) => f.assigneeAgentId === owner) : findings;

  let verdict = 'CLEAN';
  if (scoped.length) verdict = 'FLAGGED';
  if (blindRows.length) verdict = 'BLIND'; // outranks everything

  return { verdict, blind: null, scanned: rows.length, pages, candidates: candidates.length, findings: scoped, allFindings: findings, blindRows };
}

export function render(result, { staleDays = DEFAULT_STALE_DAYS } = {}) {
  const out = [];
  out.push(`scanned ${result.scanned} issues over ${result.pages} page(s); ${result.candidates} open+stale(>${staleDays}d)+unmonitored candidate(s) edge-checked`);
  if (result.verdict === 'BLIND') {
    if (result.blind) out.push(`VERDICT: BLIND — ${result.blind}`);
    else out.push(`VERDICT: BLIND — ${result.blindRows.length} row(s) could not be graded`);
    for (const b of result.blindRows) out.push(`  BLIND  ${b.id}  ${b.detail}`);
    return out.join('\n');
  }
  if (result.verdict === 'CLEAN') {
    out.push('VERDICT: CLEAN — no open issue is holding open work dark without a wake path');
    return out.join('\n');
  }

  const byOwner = new Map();
  for (const f of result.findings) {
    const k = f.assigneeAgentId ?? '<unassigned>';
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(f);
  }
  out.push(`VERDICT: FLAGGED — ${result.findings.length} dark gate(s) across ${byOwner.size} owner(s)`);
  out.push('remedy is OWNER-SHAPED: re-derive the gate, then finish it, arm a FUTURE monitor, or route it.');
  out.push('⛔ do NOT close a gate un-derived — that mints a shape-2 silent strand on every dependent below.');
  for (const [ownerId, list] of [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`\n  owner ${ownerId}  (${list.length})`);
    for (const f of list.sort((a, b) => String(a.identifier).localeCompare(String(b.identifier)))) {
      out.push(
        `    ${f.identifier}  ${f.status}  stale=${f.staleDays}d  monitor=${f.monitorNextCheckAt ?? 'none'}` +
          `\n      HOLDS DARK: ${f.openBlocks.map((b) => `${b.identifier}:${b.status}`).join(', ')}` +
          `\n      ${String(f.title ?? '').slice(0, 96)}`,
      );
    }
  }
  return out.join('\n');
}

/* ------------------------------- controls ------------------------------- */

// Frozen clock so the controls cannot rot: "now" is injected, never read.
const NOW = Date.parse('2026-09-10T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();

// The TRA-3058 replica: todo, 34 days untouched, no monitor, blocks one open
// issue (the TRA-3057 stand-in), empty blockedBy. All four predicates hold.
const incidentRow = (over = {}) => ({
  id: 'i-3058',
  identifier: 'TRA-3058',
  status: 'todo',
  updatedAt: daysAgo(34),
  monitorNextCheckAt: null,
  assigneeAgentId: 'agent-leaddev',
  title: 'clock gate: 30-day log-retention window',
  ...over,
});
const incidentDetail = (over = {}) => ({
  id: 'i-3058',
  identifier: 'TRA-3058',
  blocks: [{ id: 'i-3057', identifier: 'TRA-3057', status: 'blocked' }],
  blockedBy: [],
  ...over,
});

const CASES = [
  {
    name: 'THE INCIDENT (positive control) — all four predicates hold => FLAGGED',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail() },
    expect: { verdict: 'FLAGGED', findings: 1 },
  },
  {
    name: 'negative control (acceptance) — same leaf with a FUTURE monitor => CLEAN',
    rows: [incidentRow({ monitorNextCheckAt: new Date(NOW + 2 * DAY_MS).toISOString() })],
    details: { 'i-3058': incidentDetail() },
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'negative control (acceptance) — same leaf blocking NOTHING => CLEAN',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ blocks: [] }) },
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'fresh row (updatedAt inside the window) => CLEAN, no edge GET spent',
    rows: [incidentRow({ updatedAt: daysAgo(2) })],
    details: {}, // an edge GET here would throw — proving the cheap filter ran first
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'a LIVE open blocker of its own => CLEAN (issue_blockers_resolved will wake it)',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ blockedBy: [{ id: 'x', identifier: 'TRA-9', status: 'in_progress' }] }) },
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'blocks only CLOSED issues => CLEAN (nothing is held dark)',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ blocks: [{ id: 'x', identifier: 'TRA-9', status: 'done' }] }) },
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'blockedBy holds only CLOSED entries (the shape a close creates) => still FLAGGED',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ blockedBy: [{ id: 'x', identifier: 'TRA-9', status: 'done' }] }) },
    expect: { verdict: 'FLAGGED', findings: 1 },
  },
  {
    name: 'a SPENT monitor (null after firing) is NOT a wake path => FLAGGED',
    rows: [incidentRow({ monitorNextCheckAt: null, monitorScheduledBy: 'assignee', monitorAttemptCount: 3 })],
    details: { 'i-3058': incidentDetail() },
    expect: { verdict: 'FLAGGED', findings: 1 },
  },
  {
    name: 'a PAST monitorNextCheckAt is not "in the future" => FLAGGED',
    rows: [incidentRow({ monitorNextCheckAt: daysAgo(1) })],
    details: { 'i-3058': incidentDetail() },
    expect: { verdict: 'FLAGGED', findings: 1 },
  },
  {
    name: 'TERMINAL row matching everything else => CLEAN (population is OPEN issues)',
    rows: [incidentRow({ status: 'done' })],
    details: { 'i-3058': incidentDetail() },
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'TRAP 2 — zero rows scanned => BLIND, not CLEAN',
    rows: [],
    details: {},
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 4 — unrecognised status => BLIND, never guessed',
    rows: [incidentRow({ status: 'snoozed' })],
    details: {},
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 3 — projection dropped updatedAt => BLIND, never "fresh"',
    rows: [(() => { const r = incidentRow(); delete r.updatedAt; return r; })()],
    details: {},
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 3 — projection dropped monitorNextCheckAt => BLIND, never "no monitor"',
    rows: [(() => { const r = incidentRow(); delete r.monitorNextCheckAt; return r; })()],
    details: {},
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 1/3 — detail GET carries no blocks array => BLIND, never "blocks nothing"',
    rows: [incidentRow()],
    details: { 'i-3058': (() => { const d = incidentDetail(); delete d.blocks; return d; })() },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 3 — detail GET carries no blockedBy array => BLIND',
    rows: [incidentRow()],
    details: { 'i-3058': (() => { const d = incidentDetail(); delete d.blockedBy; return d; })() },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 4 — a blocks entry with no status => BLIND',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ blocks: [{ id: 'x', identifier: 'TRA-9' }] }) },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 6 — detail GET fails => BLIND, never waved through',
    rows: [incidentRow()],
    details: {}, // getIssue throws on a missing id
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'BLIND outranks FLAGGED — one ungradeable row beats a real finding',
    rows: [incidentRow(), incidentRow({ id: 'i-2', identifier: 'TRA-2', status: 'zzz' })],
    details: { 'i-3058': incidentDetail() },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 5 — the census must not stop at a believed total (4019 rows, finding at index 4000)',
    rows: (() => {
      const rows = Array.from({ length: 4019 }, (_, i) => ({
        id: `f-${i}`,
        identifier: `TRA-${i}`,
        status: 'todo',
        updatedAt: daysAgo(1), // fresh => no edge GET needed
        monitorNextCheckAt: null,
      }));
      rows[4000] = incidentRow({ id: 'i-3058', identifier: 'TRA-3058' });
      return rows;
    })(),
    details: { 'i-3058': incidentDetail() },
    expect: { verdict: 'FLAGGED', findings: 1 },
  },
  {
    name: 'TRAP 5 — a page source that never returns a short page => BLIND, not DONE',
    rows: null, // signals the endless-page transport below
    details: {},
    expect: { verdict: 'BLIND' },
  },
];

async function selftest() {
  let failed = 0;
  for (const c of CASES) {
    const transport =
      c.rows === null
        ? { getIssues: async ({ limit }) => Array.from({ length: limit }, (_, i) => ({ id: `x${Math.random()}${i}`, identifier: 'TRA-X', status: 'todo', updatedAt: daysAgo(1), monitorNextCheckAt: null })) }
        : {
            getIssues: async ({ limit, offset }) => c.rows.slice(offset, offset + limit),
            getIssue: async (id) => {
              if (!(id in c.details)) throw new Error(`unexpected detail GET for ${id}`);
              return c.details[id];
            },
          };
    const res = await run(transport, { now: NOW });
    const okVerdict = res.verdict === c.expect.verdict;
    const okCount = c.expect.findings === undefined || res.findings.length === c.expect.findings;
    const ok = okVerdict && okCount;
    if (!ok) failed += 1;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      got verdict=${res.verdict} findings=${res.findings.length}` +
        (ok ? '' : `  EXPECTED verdict=${c.expect.verdict} findings=${c.expect.findings ?? '*'}`),
    );
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} controls pass`);
  return failed === 0 ? 0 : 1;
}

/* --------------------------------- main --------------------------------- */

function argOf(name, dflt = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();

  const staleDays = Number(argOf('stale-days', DEFAULT_STALE_DAYS));
  if (!Number.isFinite(staleDays) || staleDays <= 0) {
    console.error(`USAGE: --stale-days must be a positive number, got ${argOf('stale-days')}`);
    return VERDICT_EXIT.USAGE;
  }

  const RAW = process.env.PAPERCLIP_API_URL ?? '';
  const BASE = RAW.replace(/\/$/, '').replace(/\/api$/, '');
  const KEY = process.env.PAPERCLIP_API_KEY;
  const CO = process.env.PAPERCLIP_COMPANY_ID;
  if (!BASE || !KEY || !CO) {
    console.error('FATAL: PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must all be set.');
    console.error('Refusing to report a zero we did not measure.');
    return VERDICT_EXIT.BLIND;
  }

  const auth = { headers: { Authorization: `Bearer ${KEY}` } };
  const transport = {
    getIssues: async ({ limit, offset }) => {
      const r = await fetch(`${BASE}/api/companies/${CO}/issues?limit=${limit}&offset=${offset}`, auth);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    getIssue: async (id) => {
      const r = await fetch(`${BASE}/api/issues/${id}`, auth);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  };

  const result = await run(transport, { owner: argOf('owner'), staleDays });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 1));
  else console.log(render(result, { staleDays }));
  return VERDICT_EXIT[result.verdict] ?? VERDICT_EXIT.BLIND;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`FATAL: ${err?.stack ?? err}`);
      process.exit(VERDICT_EXIT.BLIND);
    });
}
