#!/usr/bin/env node
/**
 * TRA-4081 (off TRA-4078) — detector for the SPENT ISSUE MONITOR: a non-terminal
 * issue whose one-shot `executionPolicy.monitor` has already fired, and which
 * therefore will never wake again on its own.
 *
 * WHAT THE SHAPE IS
 * -----------------
 * `executionPolicy.monitor` is one-shot by explicit construction. On fire —
 * from the scheduler OR from the owner's own `POST /monitor/check-now` —
 * `buildIssueMonitorTriggeredPatch` sets `monitorNextCheckAt: null`, increments
 * `monitorAttemptCount`, and `stripMonitorFromExecutionPolicy` DELETES the
 * monitor block. There is no interval and no default re-arm.
 *
 * ⛔ THE PLATFORM'S OWN GUARD CANNOT SEE THIS. `invalid_issue_disposition` runs
 * only on the TRANSITION INTO `in_review` — never on the fire path. So the
 * platform moves an issue into exactly the state its own guard refuses to let
 * an agent create, and raises no recovery action for it. Measured live
 * 2026-08-26: `activeRecoveryAction` was null on 38 of 38 such rows.
 *
 * Net effect: the row reads `in_review` to every status query and to the board
 * view, and is owned by nobody. The oldest in the 2026-08-26 census had been
 * sitting that way for 24 days.
 *
 * IT DOES NOT ONLY STRAND ITS OWN ROW. TRA-3827 sat spent from 2026-08-20 while
 * `blocks` held TRA-3824, which the platform had auto-paused to `blocked`
 * with "it will continue automatically when that work is done." It would not.
 * Both rows were dark for six days. A spent monitor silently freezes the whole
 * dependent subtree behind it, which is why `blocksOpen` is reported per row.
 *
 * WHY THIS IS NOT `check:spent-oneshot` (TRA-3008)
 * -----------------------------------------------
 * That one grades spent one-shot ROUTINE CRONS — a date-pinned cron with no
 * year field that re-armed twelve months out. Different population (routines,
 * not issues), different fields, different failure. They are complements: that
 * check asks "is the next FIRE inside any horizon a human would call
 * coverage?", this one asks "did a fire already happen and leave the row with
 * no path at all?".
 *
 * THE PREDICATE
 * -------------
 * A row is SPENT when ALL FOUR hold:
 *
 *   1. `status` is NON-TERMINAL          (todo | in_progress | in_review |
 *                                         blocked | backlog)
 *   2. `monitorScheduledBy` is set       — a monitor was armed at some point
 *   3. `monitorNextCheckAt IS NULL`      — nothing is scheduled now
 *   4. `monitorAttemptCount > 0`         — and that is because it FIRED
 *
 * Condition 4 is what separates this from "never armed". Conditions 2+4
 * together are what separate it from "armed and still pending".
 *
 * All four fields are served by the LIST projection, so this is one paged read.
 *
 * TRAPS — every one of these is a way to report a clean number that is wrong
 * -------------------------------------------------------------------------
 *  1. ⛔ A PAGE LOOP THAT STOPS AT AN ASSUMED TOTAL UNDER-REPORTS, AND READS
 *     GREEN WHILE DOING IT. This is not hypothetical: the TRA-4078 census was
 *     taken as "all 1800 issues paged, not sampled" and reported 25 rows. The
 *     company holds 4019 issues. The true count was 38 — thirteen stranded rows
 *     invisible behind a page loop that stopped early. We page to EXHAUSTION
 *     (a short page ends it) and never to a number anybody believed in advance.
 *
 *  2. ⛔ ZERO ROWS SCANNED IS BLIND, NOT CLEAN. An auth failure, a renamed
 *     route or an empty company all produce zero findings over zero rows, and
 *     that is indistinguishable from a healthy company unless we refuse it.
 *
 *  3. ⛔ A ROW MISSING ANY PREDICATE FIELD IS BLIND, NOT CLEAN. If the list
 *     projection ever drops `monitorAttemptCount`, `undefined > 0` is `false`
 *     and every stranded row in the company silently becomes a pass. The
 *     absence of the field and the value zero must not share a verdict.
 *
 *  4. ⛔ AN UNRECOGNISED STATUS IS BLIND. Guessing that a new status is
 *     terminal hides rows; guessing it is non-terminal invents them. Neither
 *     guess is cheaper than saying so.
 *
 *  5. ⛔ THE SAFETY BOUND ON THE PAGE LOOP IS BLIND, NOT DONE. If we hit it we
 *     did not finish paging, which is trap 1 wearing a different hat.
 *
 * VERDICTS AND EXIT CODES
 * -----------------------
 *   0  CLEAN     — the population was fully read and holds no spent monitors.
 *   1  FINDINGS  — at least one spent monitor. The incident.
 *   2  USAGE     — bad invocation.
 *   3  BLIND     — the population or a row is untrustworthy. NOT a pass.
 *
 * BLIND outranks FINDINGS outranks CLEAN. "Could not check" and "checked and
 * it is fine" must never share an exit code.
 *
 * Usage:
 *   node scripts/check-spent-monitor.mjs [--json] [--owner=<agentId>]
 *   node scripts/check-spent-monitor.mjs --selftest      # the controls
 *
 * Env: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.
 */

const PAGE_LIMIT = 200;
// Deliberately far above any plausible company size. Hitting it is TRAP 5.
const MAX_PAGES = 200;

export const VERDICT_EXIT = { CLEAN: 0, FINDINGS: 1, USAGE: 2, BLIND: 3 };

export const NON_TERMINAL = new Set(['todo', 'in_progress', 'in_review', 'blocked', 'backlog']);
export const TERMINAL = new Set(['done', 'cancelled', 'completed', 'closed', 'archived']);

/** Grade a single row. Returns {state, detail}. */
export function gradeRow(row) {
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

  // TRAP 3 — absence of a predicate field is BLIND, never the value zero.
  // `monitorScheduledBy` is the arm marker. A row that never armed one simply
  // has it null/absent, and that is a legitimate HEALTHY, so it is checked
  // FIRST and its absence is not blind. The other two are only meaningful on a
  // row that DID arm, so they are only demanded once we know one was armed.
  const scheduledBy = row.monitorScheduledBy ?? null;
  if (scheduledBy === null || scheduledBy === undefined || scheduledBy === '') {
    return { state: 'HEALTHY' };
  }

  if (!('monitorNextCheckAt' in row)) {
    return { state: 'BLIND', detail: `${id}: armed monitor but no \`monitorNextCheckAt\` key in the projection` };
  }
  if (!('monitorAttemptCount' in row)) {
    return { state: 'BLIND', detail: `${id}: armed monitor but no \`monitorAttemptCount\` key in the projection` };
  }

  const next = row.monitorNextCheckAt;
  const attempts = row.monitorAttemptCount;

  if (attempts !== null && typeof attempts !== 'number') {
    return { state: 'BLIND', detail: `${id}: monitorAttemptCount is ${JSON.stringify(attempts)}, not a number` };
  }

  // Still armed — something is scheduled. Healthy.
  if (next !== null && next !== undefined) return { state: 'HEALTHY' };

  // Armed at some point, nothing scheduled now, and it never fired: the arm was
  // cleared some other way (cancelled, superseded). Not this defect.
  if (!(Number(attempts) > 0)) return { state: 'HEALTHY' };

  // The monitor is spent. But a row that is `blocked` behind a REAL, still-open
  // blocker has a live wake path anyway — `issue_blockers_resolved` fires for
  // it — so the burnt monitor is irrelevant and paging its owner is noise. We
  // cannot decide that here: the LIST projection does not serve `blockedBy`.
  // Hand it to the caller to resolve with one extra GET, and never guess.
  if (row.status === 'blocked') return { state: 'SPENT_NEEDS_EDGE_CHECK' };

  return { state: 'SPENT' };
}

/**
 * Second pass, only over `blocked` rows: does a real open blocker exist?
 * Returns 'HEALTHY' (a live edge), 'SPENT' (empty or fully-closed blockedBy —
 * the silent shape-2 strand), or 'BLIND'. Fails closed: an unreadable row is
 * BLIND, never waved through as healthy.
 */
export async function resolveBlockedEdge(getIssue, row) {
  let full;
  try {
    full = await getIssue(row.id);
  } catch (err) {
    return { state: 'BLIND', detail: `${row.identifier}: blocked-row GET failed: ${err?.message ?? err}` };
  }
  if (!full || typeof full !== 'object') {
    return { state: 'BLIND', detail: `${row.identifier}: blocked-row GET returned no object` };
  }
  if (!Array.isArray(full.blockedBy)) {
    return { state: 'BLIND', detail: `${row.identifier}: GET carries no \`blockedBy\` array` };
  }
  const open = full.blockedBy.filter((b) => b && !TERMINAL.has(b.status));
  if (open.length) return { state: 'HEALTHY', detail: `${open.length} open blocker(s)` };
  return { state: 'SPENT', detail: full.blockedBy.length ? 'every blocker closed — shape-2 strand' : 'empty blockedBy' };
}

/**
 * Page to EXHAUSTION. Returns {rows, blind, pages}.
 * TRAP 1 lives here: the loop ends on a SHORT PAGE, never on a believed total.
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
      // Dedupe by id: the list ordering is not guaranteed stable across pages,
      // so the same row can legitimately appear twice. Counting it twice would
      // inflate a finding; dropping the page would deflate one.
      if (row && row.id) byId.set(row.id, row);
    }
    if (page.length < limit) return { rows: [...byId.values()], blind: null, pages };
  }
  // TRAP 5 — we ran out of page budget, so we did NOT finish. Not a result.
  return { rows: [], blind: `page loop hit its ${maxPages}-page safety bound without a short page`, pages };
}

export async function run(transport, { owner = null } = {}) {
  const { rows, blind, pages } = await enumerateIssues(transport.getIssues);
  if (blind) return { verdict: 'BLIND', blind, scanned: 0, pages, findings: [], blindRows: [] };

  // TRAP 2 — zero rows scanned is BLIND, not CLEAN.
  if (rows.length === 0) {
    return {
      verdict: 'BLIND',
      blind: 'zero issues scanned — an empty population is unmeasured, not clean',
      scanned: 0,
      pages,
      findings: [],
      blindRows: [],
    };
  }

  const findings = [];
  const blindRows = [];
  const needEdgeCheck = [];
  for (const row of rows) {
    const g = gradeRow(row);
    if (g.state === 'BLIND') blindRows.push({ id: row?.identifier ?? row?.id, detail: g.detail });
    else if (g.state === 'SPENT') findings.push(row);
    else if (g.state === 'SPENT_NEEDS_EDGE_CHECK') needEdgeCheck.push(row);
  }

  // Second pass over the `blocked` subset only — small, and it is the
  // difference between paging an owner about a row they parked correctly and
  // paging them about one that is genuinely stopped.
  const parkedWithEdge = [];
  if (needEdgeCheck.length) {
    if (typeof transport.getIssue !== 'function') {
      // Fail closed: we cannot tell a parked row from a strand, so say so.
      for (const row of needEdgeCheck) {
        blindRows.push({ id: row.identifier ?? row.id, detail: `${row.identifier}: blocked row needs a blockedBy read and no getIssue transport was supplied` });
      }
    } else {
      for (const row of needEdgeCheck) {
        const e = await resolveBlockedEdge(transport.getIssue, row);
        if (e.state === 'BLIND') blindRows.push({ id: row.identifier ?? row.id, detail: e.detail });
        else if (e.state === 'SPENT') findings.push(row);
        else parkedWithEdge.push({ id: row.identifier ?? row.id, detail: e.detail });
      }
    }
  }

  const scoped = owner ? findings.filter((f) => f.assigneeAgentId === owner) : findings;

  let verdict = 'CLEAN';
  if (scoped.length) verdict = 'FINDINGS';
  if (blindRows.length) verdict = 'BLIND'; // outranks everything

  return { verdict, blind: null, scanned: rows.length, pages, findings: scoped, allFindings: findings, blindRows, parkedWithEdge };
}

export function render(result) {
  const out = [];
  out.push(`scanned ${result.scanned} issues over ${result.pages} page(s)`);
  if (result.parkedWithEdge?.length) {
    out.push(
      `note: ${result.parkedWithEdge.length} blocked row(s) also hold a spent monitor but have a REAL open blocker,` +
        ` so they wake via issue_blockers_resolved and are not counted: ` +
        result.parkedWithEdge.map((p) => p.id).join(', '),
    );
  }
  if (result.verdict === 'BLIND') {
    if (result.blind) out.push(`VERDICT: BLIND — ${result.blind}`);
    else out.push(`VERDICT: BLIND — ${result.blindRows.length} row(s) could not be graded`);
    for (const b of result.blindRows) out.push(`  BLIND  ${b.id}  ${b.detail}`);
    return out.join('\n');
  }
  if (result.verdict === 'CLEAN') {
    out.push('VERDICT: CLEAN — no non-terminal issue is resting on a spent monitor');
    return out.join('\n');
  }

  const byOwner = new Map();
  for (const f of result.findings) {
    const k = f.assigneeAgentId ?? '<unassigned>';
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(f);
  }
  out.push(`VERDICT: FINDINGS — ${result.findings.length} spent monitor(s) across ${byOwner.size} owner(s)`);
  for (const [ownerId, list] of [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`\n  owner ${ownerId}  (${list.length})`);
    for (const f of list.sort((a, b) => String(a.identifier).localeCompare(String(b.identifier)))) {
      const blocksOpen = (f.blocks ?? []).filter((b) => b && !TERMINAL.has(b.status)).length;
      out.push(
        `    ${f.identifier}  ${f.status}  attempts=${f.monitorAttemptCount}` +
          `  lastFired=${f.monitorLastTriggeredAt ?? '?'}` +
          (blocksOpen ? `  FREEZES ${blocksOpen} open dependent(s)` : '') +
          `\n      ${String(f.title ?? '').slice(0, 96)}`,
      );
    }
  }
  return out.join('\n');
}

/* ------------------------------- controls ------------------------------- */

const CONTROLS = [
  {
    name: 'the incident — spent monitor on a non-terminal row',
    rows: [{ id: '1', identifier: 'TRA-1', status: 'in_review', monitorScheduledBy: 'assignee', monitorNextCheckAt: null, monitorAttemptCount: 3 }],
    expect: { verdict: 'FINDINGS', findings: 1 },
  },
  {
    name: 'still armed — nextCheckAt set is HEALTHY, not spent',
    rows: [{ id: '1', identifier: 'TRA-1', status: 'in_review', monitorScheduledBy: 'assignee', monitorNextCheckAt: '2026-09-01T00:00:00Z', monitorAttemptCount: 3 }],
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'armed but never fired — attemptCount 0 is HEALTHY, not spent',
    rows: [{ id: '1', identifier: 'TRA-1', status: 'in_review', monitorScheduledBy: 'assignee', monitorNextCheckAt: null, monitorAttemptCount: 0 }],
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'TERMINAL row with a spent monitor is not a finding — it stopped on purpose',
    rows: [{ id: '1', identifier: 'TRA-1', status: 'done', monitorScheduledBy: 'assignee', monitorNextCheckAt: null, monitorAttemptCount: 3 }],
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'TRAP 3 — projection dropped monitorAttemptCount => BLIND, never CLEAN',
    rows: [{ id: '1', identifier: 'TRA-1', status: 'in_review', monitorScheduledBy: 'assignee', monitorNextCheckAt: null }],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 3 — projection dropped monitorNextCheckAt => BLIND',
    rows: [{ id: '1', identifier: 'TRA-1', status: 'in_review', monitorScheduledBy: 'assignee', monitorAttemptCount: 3 }],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 4 — unrecognised status => BLIND, never guessed terminal',
    rows: [{ id: '1', identifier: 'TRA-1', status: 'snoozed', monitorScheduledBy: 'assignee', monitorNextCheckAt: null, monitorAttemptCount: 3 }],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 2 — zero rows scanned => BLIND, not CLEAN',
    rows: [],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'BLIND outranks FINDINGS — one ungradeable row beats a real finding',
    rows: [
      { id: '1', identifier: 'TRA-1', status: 'in_review', monitorScheduledBy: 'assignee', monitorNextCheckAt: null, monitorAttemptCount: 3 },
      { id: '2', identifier: 'TRA-2', status: 'zzz', monitorScheduledBy: 'assignee', monitorNextCheckAt: null, monitorAttemptCount: 1 },
    ],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'a row that never armed a monitor is HEALTHY, and its absent fields are NOT blind',
    rows: [{ id: '1', identifier: 'TRA-1', status: 'in_progress' }],
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'TRAP 1 — the census must not stop at a believed total (4019 rows, finding on the last page)',
    // 4019 rows; the ONLY spent row is at index 4000 — past where a loop that
    // believed "1800 issues" would have stopped. This is the TRA-4078 miss.
    rows: Array.from({ length: 4019 }, (_, i) => ({
      id: String(i),
      identifier: `TRA-${i}`,
      status: 'in_review',
      monitorScheduledBy: i === 4000 ? 'assignee' : null,
      monitorNextCheckAt: null,
      monitorAttemptCount: i === 4000 ? 2 : 0,
    })),
    expect: { verdict: 'FINDINGS', findings: 1 },
  },
  {
    name: 'TRAP 5 — a page source that never returns a short page => BLIND, not DONE',
    rows: null, // signals the endless-page transport below
    expect: { verdict: 'BLIND' },
  },
];

async function selftest() {
  let failed = 0;
  for (const c of CONTROLS) {
    const transport =
      c.rows === null
        ? { getIssues: async ({ limit }) => Array.from({ length: limit }, (_, i) => ({ id: `x${Math.random()}${i}`, identifier: 'TRA-X', status: 'todo' })) }
        : {
            getIssues: async ({ limit, offset }) => c.rows.slice(offset, offset + limit),
          };
    const res = await run(transport);
    const okVerdict = res.verdict === c.expect.verdict;
    const okCount = c.expect.findings === undefined || res.findings.length === c.expect.findings;
    const ok = okVerdict && okCount;
    if (!ok) failed += 1;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      got verdict=${res.verdict} findings=${res.findings.length}` +
        (ok ? '' : `  EXPECTED verdict=${c.expect.verdict} findings=${c.expect.findings ?? '*'}`),
    );
  }
  console.log(`\n${CONTROLS.length - failed}/${CONTROLS.length} controls pass`);
  return failed === 0 ? 0 : 1;
}

/* --------------------------------- main --------------------------------- */

function argOf(name, dflt = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();

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

  const result = await run(transport, { owner: argOf('owner') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 1));
  else console.log(render(result));
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
