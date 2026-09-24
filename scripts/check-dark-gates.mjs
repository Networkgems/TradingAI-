#!/usr/bin/env node
/**
 * TRA-4487 (off TRA-4486 ask 3) — detector for the DARK GATE: an open issue
 * that HOLDS other open work down while owning no path by which anything will
 * ever wake it. Amended by TRA-4848: it now grades ALL FIVE resting paths and
 * splits the verdict DARK vs STALE-PATH.
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
 * security ticket) dark, with ZERO recovery actions raised.
 *
 * THE FIVE RESTING PATHS (TRA-4848 — the founding predicate graded path 1 only)
 * -----------------------------------------------------------------------------
 * A row is resting SAFELY iff at least one of these is live:
 *
 *   1. `executionPolicy.monitor` with a FUTURE `nextCheckAt`   (list projection)
 *   2. an OPEN entry in `blockedBy` (issue_blockers_resolved)      (detail GET)
 *   3. a PENDING interaction — ⚠️ read from `/api/issues/{id}/interactions`,
 *      NEVER off the issue GET: the issue payload OMITS the `interactions` key
 *      entirely, so a presence-test there reads absent-key as zero (TRA-4848
 *      ask 2). A pending card with `continuationPolicy: wake_assignee` wakes on
 *      acceptance AND rejection; only expiry does not wake.
 *   4. `reviewAttention.state == "covered"`                        (detail GET)
 *   5. a non-null `activeRecoveryAction` (platform recovery owns it) (detail GET)
 *
 * On 2026-09-24 the path-1-only predicate printed "NO wake path at all" against
 * 5 rows of which at least 3 held a pending `wake_assignee` interaction with no
 * expiry — paths 3 and 4 were live the whole time (TRA-3100: a 49-day-old
 * `human_only` board card no agent can re-create). Same defect class as the
 * 2026-09-04 parked-close audit that was wrong on 2 of 3 rows for the same
 * reason (TRA-4078/TRA-4084). The printed claim is exactly the premise that
 * licenses the un-derived close the same report forbids — so the claim is now
 * DERIVED, never assumed from a subset of the paths.
 *
 * DARK vs STALE-PATH (TRA-4848 ask 3) — the remedy differs
 * --------------------------------------------------------
 *   DARK        no path of any kind is live. "NO wake path at all" is TRUE.
 *               Remedy: the row needs a wake path (finish it, arm a FUTURE
 *               monitor, or route it).
 *   STALE-PATH  a live path exists (pending card / covered review / recovery)
 *               but the row is >N days untouched — e.g. its only path is a
 *               stale, maybe-unanswerable `human_only` card. Still worth
 *               surfacing; the remedy is ESCALATION to whoever can actually
 *               answer (the card age and `effectiveResolverPolicy` are printed
 *               so the reader can see who that is). ⛔ NOT a license to close,
 *               and NOT a license to re-post the card: a replacement ask
 *               auto-expires the prior one and EXPIRY DOES NOT WAKE — reposting
 *               trades a live path for a silent one.
 *
 * Conditions kept from the founding predicate: the row must BLOCK ≥1 open
 * issue (`blocks[]`, detail GET — an idle leaf wastes only itself; a gate
 * holds a subtree down) and be >N days stale (`updatedAt`, default 7).
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
 *     stops carrying `blocks`/`blockedBy`/`reviewAttention`/
 *     `activeRecoveryAction` (all four are ALWAYS serialized today — absence
 *     is a shape change, not a value), the absent key must not grade as a
 *     value. Absence and value must not share a verdict.
 *  4. ⛔ AN UNRECOGNISED STATUS IS BLIND — on the row itself AND on a
 *     `blocks[]` entry. Guessing terminal hides gates; guessing open invents
 *     them.
 *  5. ⛔ THE PAGE LOOP ENDS ON A SHORT PAGE, NEVER ON A BELIEVED TOTAL
 *     (TRA-4078: a loop that believed "1800 issues" hid 13 of 38 findings
 *     behind its early stop). Hitting the safety bound is BLIND, not done.
 *  6. ⛔ A FAILED DETAIL GET IS BLIND, NEVER "no edges". Fail closed: an
 *     unreadable candidate is an ungraded one, and BLIND outranks DARK so
 *     one unreadable row cannot be drowned out by nine loud ones.
 *  7. ⛔ A FAILED INTERACTIONS GET IS "A CARD EXISTS", NEVER "no card"
 *     (TRA-4848 ask 1). The expensive direction is printing DARK — the
 *     close-licensing claim — off a route error. The row grades STALE-PATH
 *     with `pending interactions: UNREAD` printed, so the degradation is
 *     visible and non-green (exit 4), and a systemic route failure cannot
 *     manufacture a single false "no wake path at all".
 *
 * WHAT THE REMEDY IS NOT
 * ----------------------
 * This check ROUTES; it does not repair, and the finding is not "close the
 * row". A dark gate usually guards something real (TRA-3058 guarded a
 * security deliverable). Closing it un-derived converts a dark gate into a
 * shape-2 silent strand on its dependents (see `check:strands` header) —
 * strictly worse.
 *
 * VERDICTS AND EXIT CODES
 * -----------------------
 *   0  CLEAN       — population fully read; zero findings of either class.
 *   1  DARK        — ≥1 row with NO live path. The incident. Pages.
 *   2  USAGE       — bad invocation.
 *   3  BLIND       — the population or a row is untrustworthy. NOT a pass.
 *   4  STALE_PATH  — no DARK row, but ≥1 row resting on a live-but-stale path.
 *                    Escalation work, not a page — and not green.
 * BLIND > DARK > STALE_PATH > CLEAN. "Could not check" and "checked and it is
 * fine" must never share an exit code.
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

export const VERDICT_EXIT = { CLEAN: 0, DARK: 1, USAGE: 2, BLIND: 3, STALE_PATH: 4 };

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
 *   MONITORED  open with a monitor scheduled in the FUTURE — resting path 1.
 *   CANDIDATE  open, stale, no future monitor. Needs the detail-side paths.
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

  // Staleness. TRAP 3: an absent/unparseable `updatedAt` is BLIND, not fresh —
  // "never touched" is the stalest a row can possibly be.
  if (!('updatedAt' in row)) {
    return { state: 'BLIND', detail: `${id}: projection carries no \`updatedAt\` key` };
  }
  const updated = parseTs(row.updatedAt);
  if (updated === null) {
    return { state: 'BLIND', detail: `${id}: unparseable updatedAt ${JSON.stringify(row.updatedAt)}` };
  }
  if (now - updated < staleMs) return { state: 'FRESH' };

  // Resting path 1 — a monitor scheduled in the FUTURE is a live wake path.
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
 * Second pass — resting paths 2–5, from ONE detail GET plus ONE interactions
 * GET per candidate. Returns {state, detail?, ...}:
 *   DARK              blocks ≥1 open issue AND no path of any kind is live.
 *   STALE_PATH        blocks ≥1 open issue, no monitor/blocker, but path 3/4/5
 *                     is live. Carries pendingInteractions ('UNREAD' on a route
 *                     error — TRAP 7), cards[], reviewAttentionState,
 *                     recoveryAction, livePaths[].
 *   BLOCKS_NOTHING    idle, but holding nothing down. Out of population.
 *   LIVE_BLOCKER      path 2 live — `issue_blockers_resolved` will wake it.
 *   BLIND             unreadable row / absent keys / ungradeable entry.
 * Fails closed everywhere (TRAPs 6 and 7).
 */
export async function resolveEdges(getIssue, getInteractions, row, now) {
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

  // Blocks at least one OPEN issue — what makes it a gate rather than a leaf.
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

  // Resting path 2 — an open blocker of its own. ⛔ `blockedByIssueIds` is
  // undefined on every GET; `blockedBy` is the served array.
  if (!Array.isArray(full.blockedBy)) {
    return { state: 'BLIND', detail: `${id}: detail GET carries no \`blockedBy\` array` };
  }
  const openBlockedBy = full.blockedBy.filter((b) => b && typeof b.status === 'string' && NON_TERMINAL.has(b.status));
  if (openBlockedBy.length) {
    return { state: 'LIVE_BLOCKER', detail: `${openBlockedBy.length} open blocker(s)` };
  }

  // Resting paths 4 and 5 — both keys are ALWAYS serialized on the detail GET
  // (state "none" / null when nothing is present), so an absent key is a shape
  // change and BLIND (TRAP 3), never a value.
  if (!('reviewAttention' in full)) {
    return { state: 'BLIND', detail: `${id}: detail GET carries no \`reviewAttention\` key` };
  }
  if (!('activeRecoveryAction' in full)) {
    return { state: 'BLIND', detail: `${id}: detail GET carries no \`activeRecoveryAction\` key` };
  }
  const reviewAttentionState = full.reviewAttention && typeof full.reviewAttention === 'object' ? full.reviewAttention.state ?? null : null;
  const reviewCovered = reviewAttentionState === 'covered';
  const recoveryAction = full.activeRecoveryAction ?? null;

  // Resting path 3 — pending interactions, from the ROUTE (TRA-4848 ask 2: the
  // issue payload omits the `interactions` key entirely; a presence-test there
  // reads absent-key as zero). TRAP 7: a route error is "a card exists", never
  // "no card" — DARK off an unread route is the close-licensing false claim.
  let pendingInteractions;
  let cards = [];
  let interactionsNote = null;
  if (typeof getInteractions !== 'function') {
    pendingInteractions = 'UNREAD';
    interactionsNote = 'no interactions transport supplied — fail-closed as a live card';
  } else {
    try {
      const list = await getInteractions(row.id);
      if (!Array.isArray(list)) throw new Error('interactions route did not return an array');
      // A malformed entry fails closed in the same direction: counted pending.
      const pending = list.filter((x) => !x || typeof x.status !== 'string' || x.status === 'pending');
      pendingInteractions = pending.length;
      cards = pending.map((x) => ({
        id: x?.id ?? '<no id>',
        kind: x?.kind ?? '<no kind>',
        ageDays: parseTs(x?.createdAt) === null ? null : Math.floor((now - parseTs(x.createdAt)) / DAY_MS),
        effectiveResolverPolicy: x?.effectiveResolverPolicy ?? '<unread>',
        continuationPolicy: x?.continuationPolicy ?? '<unread>',
      }));
    } catch (err) {
      pendingInteractions = 'UNREAD';
      interactionsNote = `interactions GET failed (${err?.message ?? err}) — fail-closed as a live card`;
    }
  }
  const interactionsLive = pendingInteractions === 'UNREAD' || pendingInteractions > 0;

  const livePaths = [];
  if (interactionsLive) livePaths.push('pending-interaction');
  if (reviewCovered) livePaths.push('reviewAttention-covered');
  if (recoveryAction) livePaths.push('activeRecoveryAction');

  const base = {
    openBlocks,
    pendingInteractions,
    cards,
    interactionsNote,
    reviewAttentionState,
    recoveryAction: recoveryAction ? recoveryAction.kind ?? recoveryAction.type ?? 'present' : null,
    livePaths,
  };
  if (livePaths.length) return { state: 'STALE_PATH', ...base };
  return { state: 'DARK', ...base };
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
      const e = await resolveEdges(transport.getIssue, transport.getInteractions, row, now);
      if (e.state === 'BLIND') blindRows.push({ id: row.identifier ?? row.id, detail: e.detail });
      else if (e.state === 'DARK' || e.state === 'STALE_PATH') {
        findings.push({
          ...row,
          classification: e.state,
          openBlocks: e.openBlocks,
          pendingInteractions: e.pendingInteractions,
          cards: e.cards,
          interactionsNote: e.interactionsNote,
          reviewAttentionState: e.reviewAttentionState,
          recoveryAction: e.recoveryAction,
          livePaths: e.livePaths,
          staleDays: Math.floor((now - Date.parse(row.updatedAt)) / DAY_MS),
        });
      }
    }
  }

  const scoped = owner ? findings.filter((f) => f.assigneeAgentId === owner) : findings;

  // BLIND > DARK > STALE_PATH > CLEAN.
  let verdict = 'CLEAN';
  if (scoped.some((f) => f.classification === 'STALE_PATH')) verdict = 'STALE_PATH';
  if (scoped.some((f) => f.classification === 'DARK')) verdict = 'DARK';
  if (blindRows.length) verdict = 'BLIND'; // outranks everything

  return { verdict, blind: null, scanned: rows.length, pages, candidates: candidates.length, findings: scoped, allFindings: findings, blindRows };
}

function renderFindingRow(f, out) {
  const label = f.classification === 'DARK' ? 'DARK      ' : 'STALE-PATH';
  out.push(
    `    ${label}  ${f.identifier}  ${f.status}  stale=${f.staleDays}d  monitor=${f.monitorNextCheckAt ?? 'none'}` +
      `\n      HOLDS DARK: ${f.openBlocks.map((b) => `${b.identifier}:${b.status}`).join(', ')}`,
  );
  // TRA-4848 ask 4 — printed on EVERY row, matching check:strands, so the next
  // reader can audit the verdict without re-deriving it.
  const pi =
    f.pendingInteractions === 'UNREAD'
      ? `UNREAD (${f.interactionsNote})`
      : String(f.pendingInteractions);
  out.push(`      pending interactions: ${pi} · reviewAttention: ${f.reviewAttentionState ?? 'unread'} · recovery: ${f.recoveryAction ?? 'none'}`);
  for (const c of f.cards) {
    out.push(`        card ${c.id}  ${c.kind}  age=${c.ageDays === null ? '?' : `${c.ageDays}d`}  resolver=${c.effectiveResolverPolicy}  continuation=${c.continuationPolicy}`);
  }
  out.push(`      ${String(f.title ?? '').slice(0, 96)}`);
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

  const darks = result.findings.filter((f) => f.classification === 'DARK');
  const stale = result.findings.filter((f) => f.classification === 'STALE_PATH');
  out.push(
    result.verdict === 'DARK'
      ? `VERDICT: DARK — ${darks.length} gate(s) with NO live resting path (all five paths derived), plus ${stale.length} STALE-PATH row(s)`
      : `VERDICT: STALE-PATH — ${stale.length} gate(s) resting on a live path that has not moved in >${staleDays}d; zero DARK rows`,
  );
  out.push('remedy is OWNER-SHAPED and differs by class:');
  out.push('  DARK       needs a wake path — re-derive the gate, then finish it, arm a FUTURE monitor, or route it.');
  out.push('  STALE-PATH has a live path (card/review/recovery) — escalate to whoever can actually answer it.');
  out.push('             Do NOT re-post a pending card: a replacement auto-expires the prior one and EXPIRY DOES NOT WAKE.');
  out.push('⛔ do NOT close a gate un-derived — that mints a shape-2 silent strand on every dependent below.');

  const byOwner = new Map();
  for (const f of result.findings) {
    const k = f.assigneeAgentId ?? '<unassigned>';
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(f);
  }
  for (const [ownerId, list] of [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`\n  owner ${ownerId}  (${list.length})`);
    for (const f of list.sort((a, b) => String(a.identifier).localeCompare(String(b.identifier)))) {
      renderFindingRow(f, out);
    }
  }
  return out.join('\n');
}

/* ------------------------------- controls ------------------------------- */

// Frozen clock so the controls cannot rot: "now" is injected, never read.
const NOW = Date.parse('2026-09-10T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();

// The TRA-3058 replica: todo, 34 days untouched, no monitor, blocks one open
// issue (the TRA-3057 stand-in), empty blockedBy, no interaction/review/
// recovery path. All predicates for DARK hold.
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
  reviewAttention: { state: 'none', paths: [], reason: null },
  activeRecoveryAction: null,
  ...over,
});
// The TRA-3100 replica (the TRA-4848 incident): same gate shape, but a pending
// `human_only` board card with no expiry has been live the whole time.
const pendingCard = (over = {}) => ({
  id: 'int-1',
  kind: 'request_confirmation',
  status: 'pending',
  createdAt: daysAgo(35),
  continuationPolicy: 'wake_assignee',
  effectiveResolverPolicy: 'human_only',
  ...over,
});

const CASES = [
  {
    name: 'THE TRA-3058 INCIDENT (positive control) — no path of any kind => DARK',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail() },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'DARK', findings: 1 },
  },
  {
    name: 'THE TRA-4848 INCIDENT (positive control) — pending human_only card => STALE-PATH, never "no wake path"',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail() },
    interactions: { 'i-3058': [pendingCard()] },
    expect: { verdict: 'STALE_PATH', findings: 1 },
  },
  {
    name: 'TRA-4848 ask 2 — a bogus `interactions` key on the detail GET is IGNORED; the route (1 pending) wins => STALE-PATH',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ interactions: [] }) },
    interactions: { 'i-3058': [pendingCard()] },
    expect: { verdict: 'STALE_PATH', findings: 1 },
  },
  {
    name: 'a RESOLVED card is not a path => DARK',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail() },
    interactions: { 'i-3058': [pendingCard({ status: 'accepted' })] },
    expect: { verdict: 'DARK', findings: 1 },
  },
  {
    name: 'reviewAttention.state == "covered" (path 4) => STALE-PATH',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ reviewAttention: { state: 'covered', paths: [], reason: 'x' } }) },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'STALE_PATH', findings: 1 },
  },
  {
    name: 'non-null activeRecoveryAction (path 5) => STALE-PATH',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ activeRecoveryAction: { kind: 'successful_run_missing_state' } }) },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'STALE_PATH', findings: 1 },
  },
  {
    name: 'TRAP 7 — interactions route ERRORS => "a card exists": STALE-PATH with UNREAD, never DARK',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail() },
    interactions: {}, // getInteractions throws on a missing id
    expect: { verdict: 'STALE_PATH', findings: 1 },
  },
  {
    name: 'TRAP 7 — interactions route returns a non-array => STALE-PATH with UNREAD, never DARK',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail() },
    interactions: { 'i-3058': { items: [] } },
    expect: { verdict: 'STALE_PATH', findings: 1 },
  },
  {
    name: 'DARK outranks STALE_PATH — one of each => verdict DARK, both findings kept',
    rows: [incidentRow(), incidentRow({ id: 'i-2', identifier: 'TRA-2' })],
    details: { 'i-3058': incidentDetail(), 'i-2': incidentDetail({ id: 'i-2', identifier: 'TRA-2' }) },
    interactions: { 'i-3058': [], 'i-2': [pendingCard()] },
    expect: { verdict: 'DARK', findings: 2 },
  },
  {
    name: 'negative control (acceptance) — same leaf with a FUTURE monitor => CLEAN',
    rows: [incidentRow({ monitorNextCheckAt: new Date(NOW + 2 * DAY_MS).toISOString() })],
    details: { 'i-3058': incidentDetail() },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'negative control (acceptance) — same leaf blocking NOTHING => CLEAN',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ blocks: [] }) },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'fresh row (updatedAt inside the window) => CLEAN, no edge GET spent',
    rows: [incidentRow({ updatedAt: daysAgo(2) })],
    details: {}, // an edge GET here would throw — proving the cheap filter ran first
    interactions: {},
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'a LIVE open blocker of its own => CLEAN (issue_blockers_resolved will wake it)',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ blockedBy: [{ id: 'x', identifier: 'TRA-9', status: 'in_progress' }] }) },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'blocks only CLOSED issues => CLEAN (nothing is held dark)',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ blocks: [{ id: 'x', identifier: 'TRA-9', status: 'done' }] }) },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'blockedBy holds only CLOSED entries (the shape a close creates) => still DARK',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ blockedBy: [{ id: 'x', identifier: 'TRA-9', status: 'done' }] }) },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'DARK', findings: 1 },
  },
  {
    name: 'a SPENT monitor (null after firing) is NOT a wake path => DARK',
    rows: [incidentRow({ monitorNextCheckAt: null, monitorScheduledBy: 'assignee', monitorAttemptCount: 3 })],
    details: { 'i-3058': incidentDetail() },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'DARK', findings: 1 },
  },
  {
    name: 'a PAST monitorNextCheckAt is not "in the future" => DARK',
    rows: [incidentRow({ monitorNextCheckAt: daysAgo(1) })],
    details: { 'i-3058': incidentDetail() },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'DARK', findings: 1 },
  },
  {
    name: 'TERMINAL row matching everything else => CLEAN (population is OPEN issues)',
    rows: [incidentRow({ status: 'done' })],
    details: { 'i-3058': incidentDetail() },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'TRAP 2 — zero rows scanned => BLIND, not CLEAN',
    rows: [],
    details: {},
    interactions: {},
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 4 — unrecognised status => BLIND, never guessed',
    rows: [incidentRow({ status: 'snoozed' })],
    details: {},
    interactions: {},
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 3 — projection dropped updatedAt => BLIND, never "fresh"',
    rows: [(() => { const r = incidentRow(); delete r.updatedAt; return r; })()],
    details: {},
    interactions: {},
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 3 — projection dropped monitorNextCheckAt => BLIND, never "no monitor"',
    rows: [(() => { const r = incidentRow(); delete r.monitorNextCheckAt; return r; })()],
    details: {},
    interactions: {},
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 1/3 — detail GET carries no blocks array => BLIND, never "blocks nothing"',
    rows: [incidentRow()],
    details: { 'i-3058': (() => { const d = incidentDetail(); delete d.blocks; return d; })() },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 3 — detail GET carries no blockedBy array => BLIND',
    rows: [incidentRow()],
    details: { 'i-3058': (() => { const d = incidentDetail(); delete d.blockedBy; return d; })() },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 3 — detail GET carries no reviewAttention key => BLIND, never "not covered"',
    rows: [incidentRow()],
    details: { 'i-3058': (() => { const d = incidentDetail(); delete d.reviewAttention; return d; })() },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 3 — detail GET carries no activeRecoveryAction key => BLIND, never "no recovery"',
    rows: [incidentRow()],
    details: { 'i-3058': (() => { const d = incidentDetail(); delete d.activeRecoveryAction; return d; })() },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 4 — a blocks entry with no status => BLIND',
    rows: [incidentRow()],
    details: { 'i-3058': incidentDetail({ blocks: [{ id: 'x', identifier: 'TRA-9' }] }) },
    interactions: { 'i-3058': [] },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 6 — detail GET fails => BLIND, never waved through',
    rows: [incidentRow()],
    details: {}, // getIssue throws on a missing id
    interactions: { 'i-3058': [] },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'BLIND outranks DARK — one ungradeable row beats a real finding',
    rows: [incidentRow(), incidentRow({ id: 'i-2', identifier: 'TRA-2', status: 'zzz' })],
    details: { 'i-3058': incidentDetail() },
    interactions: { 'i-3058': [] },
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
    interactions: { 'i-3058': [] },
    expect: { verdict: 'DARK', findings: 1 },
  },
  {
    name: 'TRAP 5 — a page source that never returns a short page => BLIND, not DONE',
    rows: null, // signals the endless-page transport below
    details: {},
    interactions: {},
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
            getInteractions: async (id) => {
              if (!(id in c.interactions)) throw new Error(`interactions route error for ${id}`);
              return c.interactions[id];
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
    // TRA-4848 ask 2 — the ROUTE, never the issue payload (which omits the key).
    getInteractions: async (id) => {
      const r = await fetch(`${BASE}/api/issues/${id}/interactions`, auth);
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
