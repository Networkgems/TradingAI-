// TRA-3980 — arm the fleet-concentration sampling routine, then GRADE it.
//
// ⛔ THE CLAUSE IS NOT INHERITED. A routine created without the TRA-1272
// resting-disposition block strands its per-fire leaf `in_progress` and raises
// a `successful_run_missing_state` against the CFO queue every heartbeat. This
// script copies the block VERBATIM off routine `7d30dcfc` — it does not
// hand-write a substitute (routine `1d1b80cc` shipped one whose no-op branch
// said "leave `in_progress`", which is the exact loop the clause exists to
// kill).
//
// ⛔ AND INLINE `triggers` ARE SILENTLY DROPPED ON CREATE. They go up on their
// own route, with an explicit `timezone` — the trigger route DEFAULTS TO UTC,
// so "cron is evaluated in ET" is true only of triggers created WITH the field,
// and the same cron text is a different instant without it. The echo's
// `nextRunAt` is the oracle, never the cron text.
//
// Exit 0 armed and graded · 1 graded FAIL · 3 BLIND.
const API = (process.env.PAPERCLIP_API_URL ?? '').replace(/\/$/, '').replace(/\/api$/, '');
const KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY = process.env.PAPERCLIP_COMPANY_ID;
const SELF = process.env.PAPERCLIP_AGENT_ID;
const ISSUE = process.env.PAPERCLIP_TASK_ID;
const CLAUSE_SOURCE = '7d30dcfc-eeb5-4396-b850-7e03217385fb';

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const blind = m => { console.error(`BLIND — ${m}`); process.exit(3); };
const get = async p => {
  const r = await fetch(`${API}${p}`, { headers: H });
  // ⛔ CHECK THE CODE BEFORE PARSING: a 5xx here can wrap a DIFFERENT routine's
  // perfectly parseable payload (TRA-2940).
  if (!r.ok) blind(`GET ${p} -> ${r.status}`);
  return r.json();
};
const post = async (p, body) => {
  const r = await fetch(`${API}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};

if (!API || !KEY || !COMPANY || !SELF) blind('PAPERCLIP_* env incomplete');

// ── 1. Lift the clause VERBATIM ──────────────────────────────────────────────
const list = await get(`/api/companies/${COMPANY}/routines`);
const arr = Array.isArray(list) ? list : (list.routines ?? list.data ?? list.items ?? []);
const src = arr.find(r => r.id === CLAUSE_SOURCE);
if (!src) blind(`clause source routine ${CLAUSE_SOURCE} not in the company list`);
const d = src.description ?? '';
const i = d.indexOf('--- RESTING DISPOSITION');
const e = d.indexOf('--- END RESTING DISPOSITION ---');
if (i < 0 || e < 0) blind('clause markers absent on the source routine');
const CLAUSE = d.slice(i, e + '--- END RESTING DISPOSITION ---'.length);
if (!CLAUSE.includes('STRAND TEST') || !CLAUSE.includes('WRITE-ONLY')) {
  blind('lifted clause is missing STRAND TEST or WRITE-ONLY — refusing to ship the v1 text');
}
console.log(`# clause lifted verbatim: ${CLAUSE.length} chars`);

const TITLE = 'TRA-3980 fleet-concentration tape — pinned sample (open / mid / post-close)';

const PROMPT = `Take ONE pinned fleet-concentration sample for TRA-3980's observation window.

FIRST ACTION IS TO READ THE CLOCK. The scheduler's timestamp is a REQUEST, not a
guarantee — two fires have been delivered in one flush 2.5h post-close before. If
this fire arrives more than 45 minutes after its slot, record the sample with the
slot it ACTUALLY lands in (or \`adhoc\`) and say so; do not label a 22:30Z read
\`open\`.

In the trading-app workspace:

    node scripts/tra3980-fleet-concentration-sample.mjs --slot=<open|mid|post>

Slots: 09:35 ET = open · 12:30 ET = mid · 16:15 ET = post. The script pins
\`build.commit\` + \`build.pid\` + \`startedAt\` on BOTH sides of its own probe and
appends exactly one JSONL line to \`evidence/tra3980/fleet-concentration-tape.jsonl\`.

Exit codes: 0 sample written · 1 UNDEPLOYED (\`fleetConcentration\` absent — the
fold is merged as a9347d26 and the live build predates it; the window has NOT
started) · 3 BLIND (pin moved / route unreadable — a refusal line was still
written, which is the point).

THEN COMMIT AND PUSH THE TAPE. A week of observation that lives only in a
heartbeat's scrollback is not a week of observation:

    git add evidence/tra3980/fleet-concentration-tape.jsonl && git commit && git push origin main

Then render the running total:

    node scripts/tra3980-fleet-concentration-report.mjs

WHAT THIS ROUTINE MUST NOT DO: it places no order, writes no env, changes no
gate and proposes no ceiling value. It is a read-only probe plus an append.

WHEN THE TAPE REACHES 5 OBSERVED SESSIONS (the report prints "AC1 met"), post the
rendered report to TRA-3703 as TRA-3980 AC4 requires, stating whether the
distribution supports a ceiling WITHOUT proposing a value, then close TRA-3980
and ARCHIVE THIS ROUTINE.

${CLAUSE}`;

// ── 2. Create ────────────────────────────────────────────────────────────────
// ⛔ `title`, not `name` (`name` is a 400), and `assigneeAgentId` is REQUIRED —
// without it the create is a 403 wearing a capability face over a schema fault.
const created = await post(`/api/companies/${COMPANY}/routines`, {
  title: TITLE,
  description: PROMPT,
  assigneeAgentId: SELF,
  parentIssueId: ISSUE,
  status: 'active',
});
if (created.status !== 201 && created.status !== 200) {
  blind(`create -> ${created.status} ${JSON.stringify(created.body).slice(0, 500)}`);
}
const rid = created.body?.id ?? created.body?.routine?.id;
if (!rid) blind(`create returned no id: ${JSON.stringify(created.body).slice(0, 300)}`);
console.log(`# created routine ${rid}`);

// ── 3. Triggers, on their own route, with an EXPLICIT timezone ───────────────
const SLOTS = [
  { cron: '35 9 * * 1-5', slot: 'open' },
  { cron: '30 12 * * 1-5', slot: 'mid' },
  { cron: '15 16 * * 1-5', slot: 'post' },
];
for (const s of SLOTS) {
  const t = await post(`/api/routines/${rid}/triggers`, {
    kind: 'schedule',
    cronExpression: s.cron,
    timezone: 'America/New_York',
    enabled: true,
  });
  console.log(`# trigger ${s.slot} (${s.cron} ET) -> ${t.status}`);
  if (t.status >= 400) console.log(`  ${JSON.stringify(t.body).slice(0, 300)}`);
}

// ── 4. GRADE IT OFF A RE-GET. A self-report is not the write ─────────────────
const back = await get(`/api/routines/${rid}`);
const desc = back.description ?? '';
const trig = Array.isArray(back.triggers) ? back.triggers : [];
const checks = [
  ['clause: STRAND TEST present', desc.includes('STRAND TEST')],
  ['clause: WRITE-ONLY present', desc.includes('WRITE-ONLY')],
  ['clause: END marker present', desc.includes('--- END RESTING DISPOSITION ---')],
  ['no v1 "leave in_progress" branch', !/leave\s+`?in_progress`?/i.test(desc)],
  ['3 schedule triggers', trig.filter(t => t.kind === 'schedule').length === 3],
  ['every trigger enabled', trig.length > 0 && trig.every(t => t.enabled === true)],
  ['every trigger in ET', trig.length > 0 && trig.every(t => t.timezone === 'America/New_York')],
  // ⛔ `nextRunAt` lives on the TRIGGER; it is null on the routine root, so a
  // grader that reads it there scores an armed routine as disarmed.
  ['every trigger has nextRunAt', trig.length > 0 && trig.every(t => !!t.nextRunAt)],
  ['status active', back.status === 'active'],
];
let bad = 0;
for (const [id, ok] of checks) { if (!ok) bad += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}`); }
for (const t of trig) {
  console.log(`  trigger ${t.id} kind=${t.kind} cron=${t.cronExpression} tz=${t.timezone} `
    + `enabled=${t.enabled} nextRunAt=${t.nextRunAt}`);
}
console.log(`\n${checks.length - bad}/${checks.length} criteria pass. routine=${rid}`);
process.exit(bad > 0 ? 1 : 0);
