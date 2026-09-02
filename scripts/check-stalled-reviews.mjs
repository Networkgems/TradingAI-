#!/usr/bin/env node
/**
 * TRA-4301 (off TRA-4078) — standing detector for the STALLED REVIEW: a
 * non-terminal issue the platform itself has concluded has NO live wake path.
 *
 * THE PREDICATE IS THE PLATFORM'S, NOT OURS
 * -----------------------------------------
 * TRA-4078 asked the vendor to build a detector for issues resting on a spent
 * one-shot monitor. They already built the hard half: `reviewAttention.state`
 * is computed by the read model and served on every issue read AND every list
 * page. Values, measured live 2026-09-02 over all 4206 company issues:
 *
 *   none     — no review-shaped wait at all
 *   covered  — a wait exists and something will fire for it
 *   stalled  — a wait exists and NOTHING will fire for it   <- the incident
 *
 * `stalled` is strictly better than the raw monitor-column predicate that
 * `check:spent-monitor` (TRA-4081) grades:
 *
 *   - raw predicate: 27 rows, with FALSE POSITIVES — it flagged TRA-2636
 *     (`todo`, woken by a live routine with a real `nextRunAt`) and 3 `blocked`
 *     rows carrying genuine open blockers (`blockerAttention.state ==
 *     "covered"`).
 *   - `stalled`: 15 rows, all `in_review`, all with zero live paths — and it
 *     caught TRA-3942, which the raw predicate MISSED (`monitorScheduledBy`
 *     set, `attemptCount` 0, `nextCheckAt` null: a monitor scheduled and then
 *     vanished without ever firing).
 *
 * `check:spent-monitor` stays as the raw-column cross-check; THIS check is the
 * standing sweep. Manual drains do not hold: TRA-4079/4080/4081 all closed
 * with verified 0-row pass tests on 2026-08-26 and the company count was back
 * to 27 seven days later (~3.4 rows/day regrowth).
 *
 * THE GRACE WINDOW — noise is the failure mode of a pager
 * -------------------------------------------------------
 * A row is only ALARMED when it has been stalled for longer than the grace
 * window (default 24h) measured from `monitorLastTriggeredAt`. 8 of the 15
 * rows in the 2026-09-02 census landed within a single hour of one sweep;
 * their owners had not had a heartbeat yet. Alarming on those manufactures
 * noise and trains people to ignore the alarm. Rows inside grace are still
 * REPORTED (verdict GRACE, exit 4 — not clean, not paged), because a sweep
 * that reads 0 while 8 rows churn underneath is the silent-green shape this
 * repo exists to kill.
 *
 * ⚠️ A stalled row with NO readable fire timestamp is graded AGED, not fresh
 * and not BLIND — age-unknown must fail toward the alarm, because the one row
 * we know of in that shape (TRA-3942) had been dark for days.
 *
 * THE AGE DISTRIBUTION IS THE REPORT, NOT THE COUNT
 * -------------------------------------------------
 * The count is dominated by fresh churn; the aged tail is the actual harm
 * (12 of today's 15 were dark 6+ days). So the distribution is always printed,
 * and rows sharing an IDENTICAL fire timestamp are called out as a cluster:
 * 8 of today's aged rows share `2026-08-27T13:23:15.305Z` to the millisecond —
 * the TRA-4141 scheduler burst consuming 8 one-shot issue monitors five
 * seconds before it replayed 28 routines. A cluster means a platform event,
 * not 8 separate owner mistakes.
 *
 * WHAT AN OWNER DOES WITH A FINDING — exactly three legal dispositions
 * --------------------------------------------------------------------
 *   1. re-arm:  PATCH the issue with `executionPolicy.monitor.nextCheckAt`
 *   2. close:   `done` / `cancelled` if the wait is actually over
 *   3. block:   set a real `blockedByIssueIds` edge to a live blocker
 * Anything else (a comment, a status shuffle) leaves the row exactly as dark.
 * Field table and source trace: docs/agent-issue-monitor-TRA-4073.md.
 *
 * TRAPS (inherited from check-spent-monitor.mjs, TRA-4081 — see there for the
 * incident behind each): (1) page to EXHAUSTION, never to a believed total;
 * (2) zero rows scanned is BLIND, not clean; (3) a non-terminal row with no
 * readable `reviewAttention.state` is BLIND, not clean — if the projection
 * drops the field, every stalled row silently becomes a pass; (4) an
 * unrecognised status OR an unrecognised attention state is BLIND, never
 * guessed; (5) hitting the page-loop safety bound is BLIND, not done.
 *
 * VERDICTS AND EXIT CODES
 * -----------------------
 *   0  CLEAN    — full census, no stalled row anywhere.
 *   1  STALLED  — at least one stalled row OLDER than the grace window. Page.
 *   2  USAGE    — bad invocation.
 *   3  BLIND    — the population or a row is untrustworthy. NOT a pass.
 *   4  GRACE    — stalled rows exist but ALL are inside the grace window.
 *                 Not clean, not paged; expect the next sweep to decide.
 *
 * Precedence: BLIND > STALLED > GRACE > CLEAN.
 *
 * Usage:
 *   node scripts/check-stalled-reviews.mjs [--json] [--owner=<agentId>] [--grace-hours=24]
 *   node scripts/check-stalled-reviews.mjs --selftest      # the controls
 *
 * Env: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.
 */

const PAGE_LIMIT = 200;
// Deliberately far above any plausible company size. Hitting it is TRAP 5.
const MAX_PAGES = 200;
const DEFAULT_GRACE_HOURS = 24;

export const VERDICT_EXIT = { CLEAN: 0, STALLED: 1, USAGE: 2, BLIND: 3, GRACE: 4 };

export const NON_TERMINAL = new Set(['todo', 'in_progress', 'in_review', 'blocked', 'backlog']);
export const TERMINAL = new Set(['done', 'cancelled', 'completed', 'closed', 'archived']);
const ATTENTION_STATES = new Set(['none', 'covered', 'stalled']);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Grade a single row. Returns {state, detail, ageMs?}. */
export function gradeRow(row, nowMs, graceMs) {
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

  // TRAP 3 — the predicate field must be READ, never defaulted. If the
  // projection drops `reviewAttention`, `undefined !== 'stalled'` would turn
  // every stranded row in the company into a pass.
  const attention = row.reviewAttention;
  if (!attention || typeof attention !== 'object') {
    return { state: 'BLIND', detail: `${id}: non-terminal row carries no \`reviewAttention\` object` };
  }
  const state = attention.state;
  if (typeof state !== 'string' || !ATTENTION_STATES.has(state)) {
    return { state: 'BLIND', detail: `${id}: unrecognised reviewAttention.state ${JSON.stringify(state)}` };
  }
  if (state !== 'stalled') return { state: 'HEALTHY' };

  // Stalled. Fresh or aged? Age-unknown fails TOWARD the alarm (TRA-3942:
  // a monitor scheduled-then-vanished has no fire timestamp and had been
  // dark for days).
  const firedAt = Date.parse(row.monitorLastTriggeredAt ?? '');
  if (Number.isNaN(firedAt)) return { state: 'STALLED_AGED', ageMs: null };
  const ageMs = nowMs - firedAt;
  if (ageMs < graceMs) return { state: 'STALLED_FRESH', ageMs };
  return { state: 'STALLED_AGED', ageMs };
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
      // Dedupe by id: list ordering is not guaranteed stable across pages.
      if (row && row.id) byId.set(row.id, row);
    }
    if (page.length < limit) return { rows: [...byId.values()], blind: null, pages };
  }
  // TRAP 5 — we ran out of page budget, so we did NOT finish. Not a result.
  return { rows: [], blind: `page loop hit its ${maxPages}-page safety bound without a short page`, pages };
}

export function ageBucket(ageMs) {
  if (ageMs === null) return 'age-unknown';
  if (ageMs < DAY_MS) return '<24h';
  if (ageMs < 3 * DAY_MS) return '24h-3d';
  if (ageMs < 6 * DAY_MS) return '3d-6d';
  return '6d+';
}

export async function run(transport, { owner = null, nowMs = Date.now(), graceMs = DEFAULT_GRACE_HOURS * 3600_000 } = {}) {
  const { rows, blind, pages } = await enumerateIssues(transport.getIssues);
  if (blind) return { verdict: 'BLIND', blind, scanned: 0, pages, aged: [], fresh: [], blindRows: [] };

  // TRAP 2 — zero rows scanned is BLIND, not CLEAN.
  if (rows.length === 0) {
    return {
      verdict: 'BLIND',
      blind: 'zero issues scanned — an empty population is unmeasured, not clean',
      scanned: 0,
      pages,
      aged: [],
      fresh: [],
      blindRows: [],
    };
  }

  const aged = [];
  const fresh = [];
  const blindRows = [];
  for (const row of rows) {
    const g = gradeRow(row, nowMs, graceMs);
    if (g.state === 'BLIND') blindRows.push({ id: row?.identifier ?? row?.id, detail: g.detail });
    else if (g.state === 'STALLED_AGED') aged.push({ row, ageMs: g.ageMs });
    else if (g.state === 'STALLED_FRESH') fresh.push({ row, ageMs: g.ageMs });
  }

  const scope = (list) => (owner ? list.filter((f) => f.row.assigneeAgentId === owner) : list);
  const scopedAged = scope(aged);
  const scopedFresh = scope(fresh);

  let verdict = 'CLEAN';
  if (scopedFresh.length) verdict = 'GRACE';
  if (scopedAged.length) verdict = 'STALLED';
  if (blindRows.length) verdict = 'BLIND'; // outranks everything

  return {
    verdict,
    blind: null,
    scanned: rows.length,
    pages,
    aged: scopedAged,
    fresh: scopedFresh,
    allAged: aged,
    allFresh: fresh,
    blindRows,
  };
}

function fmtAge(ageMs) {
  if (ageMs === null) return 'age UNKNOWN (no fire timestamp — graded aged)';
  const d = ageMs / DAY_MS;
  return d >= 1 ? `${d.toFixed(1)}d` : `${(ageMs / 3600_000).toFixed(1)}h`;
}

export function render(result) {
  const out = [];
  out.push(`scanned ${result.scanned} issues over ${result.pages} page(s)`);
  if (result.verdict === 'BLIND') {
    if (result.blind) out.push(`VERDICT: BLIND — ${result.blind}`);
    else out.push(`VERDICT: BLIND — ${result.blindRows.length} row(s) could not be graded`);
    for (const b of result.blindRows) out.push(`  BLIND  ${b.id}  ${b.detail}`);
    return out.join('\n');
  }
  if (result.verdict === 'CLEAN') {
    out.push('VERDICT: CLEAN — no non-terminal issue reads reviewAttention.state == "stalled"');
    return out.join('\n');
  }

  const all = [...result.aged, ...result.fresh];

  // The distribution IS the report — the count is dominated by fresh churn.
  const buckets = new Map([['<24h', 0], ['24h-3d', 0], ['3d-6d', 0], ['6d+', 0], ['age-unknown', 0]]);
  for (const f of all) buckets.set(ageBucket(f.ageMs), (buckets.get(ageBucket(f.ageMs)) ?? 0) + 1);
  out.push(`age distribution (since monitorLastTriggeredAt): ` + [...buckets.entries()].filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join('  '));

  // Identical fire timestamps = one platform event, not N owner mistakes.
  const byStamp = new Map();
  for (const f of all) {
    const s = f.row.monitorLastTriggeredAt ?? null;
    if (!s) continue;
    if (!byStamp.has(s)) byStamp.set(s, []);
    byStamp.get(s).push(f.row.identifier ?? f.row.id);
  }
  for (const [stamp, ids] of byStamp) {
    if (ids.length >= 3) {
      out.push(`⚠️ CLUSTER: ${ids.length} rows share fire timestamp ${stamp} to the millisecond — a scheduler event (cf. TRA-4141), not individual owner error: ${ids.join(', ')}`);
    }
  }

  if (result.verdict === 'GRACE') {
    out.push(`VERDICT: GRACE — ${result.fresh.length} stalled row(s), ALL inside the grace window; owners have not had a heartbeat yet. Not clean; next sweep decides.`);
  } else {
    out.push(`VERDICT: STALLED — ${result.aged.length} row(s) stalled past grace (+${result.fresh.length} in grace)`);
  }

  const byOwner = new Map();
  for (const f of result.aged) {
    const k = f.row.assigneeAgentId ?? '<unassigned>';
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(f);
  }
  for (const [ownerId, list] of [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`\n  owner ${ownerId}  (${list.length} aged) — route ONE item to this owner naming the three legal dispositions:`);
    out.push(`    (1) re-arm executionPolicy.monitor.nextCheckAt  (2) close  (3) real blockedByIssueIds — see docs/agent-issue-monitor-TRA-4073.md`);
    for (const f of list.sort((a, b) => String(a.row.identifier).localeCompare(String(b.row.identifier)))) {
      out.push(
        `    ${f.row.identifier}  ${f.row.status}  ${fmtAge(f.ageMs)}  lastFired=${f.row.monitorLastTriggeredAt ?? '?'}` +
          `\n      ${String(f.row.title ?? '').slice(0, 96)}`,
      );
    }
  }
  if (result.fresh.length) {
    out.push(`\n  in grace (report-only, no page): ` + result.fresh.map((f) => `${f.row.identifier}(${fmtAge(f.ageMs)})`).join(', '));
  }
  return out.join('\n');
}

/* ------------------------------- controls ------------------------------- */

const NOW = Date.parse('2026-09-02T12:00:00Z');
const GRACE = DEFAULT_GRACE_HOURS * 3600_000;
const stalledRow = (over) => ({
  id: '1', identifier: 'TRA-1', status: 'in_review',
  reviewAttention: { state: 'stalled' },
  monitorLastTriggeredAt: '2026-08-27T13:23:15.305Z', // 6d old => aged
  ...over,
});

const CONTROLS = [
  {
    name: 'the incident — stalled row aged past grace => STALLED',
    rows: [stalledRow({})],
    expect: { verdict: 'STALLED', aged: 1 },
  },
  {
    name: 'stalled but fresh (fired 1h ago) => GRACE, not STALLED and not CLEAN',
    rows: [stalledRow({ monitorLastTriggeredAt: '2026-09-02T11:00:00Z' })],
    expect: { verdict: 'GRACE', aged: 0 },
  },
  {
    name: 'stalled with NO fire timestamp (the TRA-3942 shape) => AGED, fails toward the alarm',
    rows: [stalledRow({ monitorLastTriggeredAt: null })],
    expect: { verdict: 'STALLED', aged: 1 },
  },
  {
    name: 'covered is HEALTHY — a live wake path exists (the raw-predicate false positive)',
    rows: [stalledRow({ reviewAttention: { state: 'covered' } })],
    expect: { verdict: 'CLEAN', aged: 0 },
  },
  {
    name: 'none is HEALTHY',
    rows: [stalledRow({ reviewAttention: { state: 'none' } })],
    expect: { verdict: 'CLEAN', aged: 0 },
  },
  {
    name: 'TERMINAL row is never graded — it stopped on purpose',
    rows: [stalledRow({ status: 'done' })],
    expect: { verdict: 'CLEAN', aged: 0 },
  },
  {
    name: 'TRAP 3 — projection dropped reviewAttention => BLIND, never CLEAN',
    rows: [{ id: '1', identifier: 'TRA-1', status: 'in_review' }],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 4a — unrecognised reviewAttention.state => BLIND, never guessed',
    rows: [stalledRow({ reviewAttention: { state: 'snoozed' } })],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 4b — unrecognised status => BLIND',
    rows: [stalledRow({ status: 'zzz' })],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 2 — zero rows scanned => BLIND, not CLEAN',
    rows: [],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'BLIND outranks STALLED — one ungradeable row beats a real finding',
    rows: [stalledRow({}), { id: '2', identifier: 'TRA-2', status: 'in_review' }],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 1 — census must not stop at a believed total (4206 rows, finding on the last page)',
    rows: Array.from({ length: 4206 }, (_, i) =>
      i === 4200
        ? stalledRow({ id: String(i), identifier: `TRA-${i}` })
        : { id: String(i), identifier: `TRA-${i}`, status: 'done' },
    ),
    expect: { verdict: 'STALLED', aged: 1 },
  },
  {
    name: 'TRAP 5 — a page source that never returns a short page => BLIND, not DONE',
    rows: null, // signals the endless-page transport below
    expect: { verdict: 'BLIND' },
  },
  {
    name: '--owner scoping — a finding owned by someone else does not page this owner',
    rows: [stalledRow({ assigneeAgentId: 'other-agent' })],
    owner: 'me',
    expect: { verdict: 'CLEAN', aged: 0 },
  },
];

async function selftest() {
  let failed = 0;
  for (const c of CONTROLS) {
    const transport =
      c.rows === null
        ? { getIssues: async ({ limit }) => Array.from({ length: limit }, (_, i) => ({ id: `x${Math.random()}${i}`, identifier: 'TRA-X', status: 'todo', reviewAttention: { state: 'none' } })) }
        : { getIssues: async ({ limit, offset }) => c.rows.slice(offset, offset + limit) };
    const res = await run(transport, { owner: c.owner ?? null, nowMs: NOW, graceMs: GRACE });
    const okVerdict = res.verdict === c.expect.verdict;
    const okCount = c.expect.aged === undefined || res.aged.length === c.expect.aged;
    const ok = okVerdict && okCount;
    if (!ok) failed += 1;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      got verdict=${res.verdict} aged=${res.aged.length}` +
        (ok ? '' : `  EXPECTED verdict=${c.expect.verdict} aged=${c.expect.aged ?? '*'}`),
    );
  }
  console.log(`\n${CONTROLS.length - failed}/${CONTROLS.length} controls pass`);
  return failed === 0 ? 0 : VERDICT_EXIT.STALLED;
}

/* --------------------------------- main --------------------------------- */

function argOf(name, dflt = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();

  const graceHours = Number(argOf('grace-hours', String(DEFAULT_GRACE_HOURS)));
  if (!Number.isFinite(graceHours) || graceHours < 0) {
    console.error(`USAGE: --grace-hours must be a non-negative number, got ${argOf('grace-hours')}`);
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
  };

  const result = await run(transport, { owner: argOf('owner'), graceMs: graceHours * 3600_000 });
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
