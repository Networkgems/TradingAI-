#!/usr/bin/env node
/**
 * TRA-3541 — the DRAIN for the `blocked` + empty-`blockedBy` recovery-strand cohort.
 *
 * BOARD RULING (CEO, 2026-08-13): "the mass-strand is now a daily event, not an
 * incident. Hand-draining every 12h is not a fix." Detection is owned and live
 * (TRA-3537 / TRA-3363 / TRA-3451). Nothing owned the WRITE. This does.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is NOT a second detector. It does not re-implement the cohort predicate,
 * the shape grading, the pending-card guard, or the repair derivation — it
 * imports `sweep()` from `check-blocked-empty.mjs` and executes the
 * `finding.repair` that detector already emits as `RESTORE-PATCH 1/2` and
 * `2/2`. That import is the whole point: a drain with its own copy of the
 * predicate silently repairs a DIFFERENT population than the one being graded,
 * and the two drift apart on the first edit to either. One predicate, one
 * cohort, two readers.
 *
 * THE THREE WRITES, IN THIS ORDER, PER ROW
 * ----------------------------------------
 *   1. POST /comments            the audit trail
 *   2. PATCH {"status":"todo"}
 *   3. PATCH {"assigneeAgentId": returnOwnerAgentId}      <-- LAST, always
 *
 * The order is not stylistic. Assignment is ONE-WAY: the moment a row leaves
 * this actor's authorization boundary, both the status PATCH and the comment
 * come back `403 {"error":"Issue is outside this actor's authorization
 * boundary"}` (measured repeatedly; see the CFO hand-back on TRA-3397). So the
 * comment must be written while the row is still ours, and the assignee write
 * must be the last thing we ever do to it.
 *
 * ⛔ NEVER `done`. `todo` is queue-visible AND still counts as an unresolved
 * blocker upstream, so parents stay correctly blocked and no unrun work is
 * destroyed. `done` destroys it.
 *
 * ⛔ NEVER re-send `blockedByIssueIds`. There is no open anchor left, and an
 * empty write-key list reproduces the unroutable born-blocked state this whole
 * cohort IS. Both bans are enforced on the request body itself
 * (`gradeWriteBody`), not on the rendered report — a report control cannot see
 * what a future edit actually sends.
 *
 * THE BOUNDARY IS WHY THIS ARM CANNOT BE THE ONLY ARM
 * --------------------------------------------------
 * The recovery reconciler re-homes each stranded row to the owner's BOSS, so a
 * mass-strand lands spread across several queues, and repair is assignee-scoped
 * — rank does not lift it (the CFO, top role, got 403 on a plain status PATCH
 * of two CTO-owned findings). No single seat can drain the company. Whether a
 * given cross-owner write 403s has no predictor anyone here has found across
 * ~11 measurements, so this script does not try to predict it: it ATTEMPTS the
 * write and branches on the result. A row that 403s is reported as FOREIGN with
 * its owner named, and exits non-zero. Draining those is the other seats' twin
 * arm, not a retry loop here.
 *
 * VERDICTS — and why "nothing to do" is not a pass
 * -----------------------------------------------
 *   0  VACUOUS    the cohort was EMPTY. NOTHING WAS EXERCISED. This verdict is
 *                 deliberately not called CLEAN and never prints that word: a
 *                 drain that ran over zero rows has produced no evidence that
 *                 it drains, and a run of green VACUOUS logs must never be read
 *                 back as "the automation works". Armed is not observing.
 *   0  DRAINED    >=1 row planned, every one written AND verified by re-read.
 *   1  REMAINDER  shape-1 rows this arm did not drain: ineligible, held for a
 *                 card, excluded, or FOREIGN. Someone still has to act, so this
 *                 must not be green. This is also the arm that falsifies the
 *                 `stranded_assigned_issue` kind gate (see below).
 *   2  FAILED     a write threw, or a write returned 2xx and the re-read shows
 *                 it did not stick. Present-but-wrong is not repaired.
 *   3  BLIND      the sweep could not prove it saw the whole population. Not a
 *                 pass. Outranks everything.
 *
 * THE ONE FALSIFIABLE RISK, STATED UP FRONT
 * -----------------------------------------
 * `deriveRepair` gates on `recoveryKind === 'stranded_assigned_issue'`. The
 * CFO's hand-back describes the 2026-08-12 mass-strand as "all `acpx_turn_failed`
 * / `issue_continuation_needed`" — which reconciles with the gate only if those
 * are the recovery `cause` and the failure string, with `kind` still
 * `stranded_assigned_issue` (that is what a live payload carried on TRA-2102).
 * It could not be re-measured when this shipped: the cohort was 0/91 on
 * 2026-08-13, a real zero on a field present in the schema. So the kind is
 * REPORTED VERBATIM on every ineligible row and any such row exits REMAINDER.
 * If the gate is wrong, the first real fire says so in one line and exits 1. It
 * cannot read green.
 *
 * USAGE
 *   node scripts/drain-blocked-empty.mjs                  # dry run, writes nothing
 *   node scripts/drain-blocked-empty.mjs --apply          # the drain
 *   node scripts/drain-blocked-empty.mjs --json
 *   node scripts/drain-blocked-empty.mjs --selftest       # positive + negative controls
 *   node scripts/drain-blocked-empty.mjs --apply --only=TRA-1234    # one row (control use)
 *
 * Auth: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.
 */

import { pathToFileURL } from 'node:url';
import { sweep, SHAPE, SEVERITY, renderReport } from './check-blocked-empty.mjs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
};

export const DRAIN_EXIT = {
  VACUOUS: 0,
  DRAINED: 0,
  REMAINDER: 1,
  FAILED: 2,
  BLIND: 3,
};

/**
 * The carve-out, expressed as a RULE rather than as a list of identifiers.
 *
 * Today it catches exactly one row — TRA-382, assigned to the departed agent
 * 2fc6fe3b, a standing human-only exception (TRA-1627) re-confirmed still
 * blocked and still assigned on 2026-08-13. It is deliberately NOT written as
 * `identifier === 'TRA-382'`. A membership list is a suppression list: it keeps
 * suppressing after the reason expires, and nothing here would notice the day
 * 2fc6fe3b came back or the row got re-homed to a live agent.
 *
 * The rule is the reason itself: an assignee who is off-roster (or absent) is
 * outside EVERY agent's authorization boundary, so both the comment and the
 * PATCH 403 for everyone including the top role. No agent can drain it, so it
 * is a human/board write by construction — and the moment such a row gains a
 * live on-roster assignee, it stops matching and drains normally with no edit
 * here.
 */
export function carveOut(f) {
  if (f.severity === SEVERITY.UNREPAIRABLE_OFF_ROSTER) {
    return (
      `assignee \`${f.assigneeAgentId}\` is not in this company's agent roster -- outside EVERY agent's ` +
      'authorization boundary, so no agent can PATCH or even comment. HUMAN/BOARD write (TRA-1627). ' +
      'This is a rule, not a row: it stops applying by itself if the assignee returns to the roster.'
    );
  }
  if (f.severity === SEVERITY.UNREPAIRABLE_UNASSIGNED) {
    return 'no assignee at all -- no agent is inside its boundary. HUMAN/BOARD write.';
  }
  return null;
}

export const ACTION = {
  DRAIN: 'DRAIN',
  SKIP_EXCLUDED: 'SKIP_EXCLUDED',
  SKIP_SHAPE_2: 'SKIP_SHAPE_2',
  SKIP_INELIGIBLE: 'SKIP_INELIGIBLE',
  SKIP_NOT_SELECTED: 'SKIP_NOT_SELECTED',
};

/* ------------------------------------------------------------------ *
 * The write-body guard — graded on what we SEND
 * ------------------------------------------------------------------ */

/**
 * Pure. Every request body goes through this before it reaches the network, and
 * a rejection THROWS rather than skipping the row: a body this function does
 * not recognise means the caller changed and the change was not reviewed here.
 *
 * Exactly two verbs are legal, matching the two the detector is allowed to
 * print (its SANCTIONED_VERB whitelist). Anything else — a third key, a
 * `done`, a blocker-key write, a merged one-shot body — is a defect.
 */
export function gradeWriteBody(step, body) {
  const bad = (why) => ({ ok: false, why: `${step}: ${why}` });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body is not an object');
  const keys = Object.keys(body);

  // The ban that outranks the rest. Checked FIRST and independently of the
  // step, so it holds even if a future step is added above.
  if (keys.some((k) => /^blocked(By|ByIssueIds|Ids)?$/i.test(k) || /blockedByIssueIds/i.test(k))) {
    return bad(
      'carries a blocker write-key. There is no open anchor left and an empty write-key list reproduces the ' +
        'unroutable born-blocked state this cohort IS. Never re-send it.',
    );
  }

  if (step === 'status') {
    if (keys.length !== 1 || keys[0] !== 'status') return bad(`expected exactly {"status"}, got {${keys.join(',')}}`);
    if (body.status === 'done') {
      return bad('would write `done`, which DESTROYS unrun work. The restore is `todo` and only `todo`.');
    }
    if (body.status !== 'todo') {
      return bad(
        `would write \`${body.status}\`. Only \`todo\` is sanctioned: \`in_progress\` is what the reconciler mints ` +
          'strands FROM, so a literal restore re-strands the leaf on the next pass.',
      );
    }
    return { ok: true };
  }

  if (step === 'assignee') {
    if (keys.length !== 1 || keys[0] !== 'assigneeAgentId') {
      return bad(`expected exactly {"assigneeAgentId"}, got {${keys.join(',')}}`);
    }
    if (!body.assigneeAgentId || typeof body.assigneeAgentId !== 'string') {
      return bad('assigneeAgentId is empty — the return owner would be a guess');
    }
    return { ok: true };
  }

  if (step === 'comment') {
    if (typeof body.body !== 'string' || !body.body.trim()) return bad('comment body is empty');
    // Comments are ASCII-only on this platform; a smart quote or an em dash
    // lands as mojibake in the permanent audit trail.
    const nonAscii = body.body.match(/[^\x20-\x7E\n\r\t]/g);
    if (nonAscii) return bad(`comment body carries ${nonAscii.length} non-ASCII character(s): ${nonAscii.join('')}`);
    return { ok: true };
  }

  return bad('unknown write step');
}

/** The audit comment. ASCII only, and written BEFORE the row leaves our boundary. */
export function drainComment(f, runId) {
  const rep = f.repair;
  return (
    `Automated strand drain (TRA-3541). This row was \`blocked\` with an EMPTY \`blockedBy\` and carried an ` +
    `active \`${f.recoveryKind}\` recovery action, which is the platform's terminal-run recovery writing the ` +
    `block -- no agent ever intended an anchor. That state fails the TRA-1272 STRAND TEST and raises no blocker ` +
    `wake, so nothing drains it on its own.\n\n` +
    `Read live immediately before this write: status \`blocked\`, \`blockedBy\` empty, pendingInteractions 0 ` +
    `(a KNOWN zero, not an unread route), \`evidence.previousStatus\` \`${rep.restoredFrom}\`, ` +
    `\`returnOwnerAgentId\` \`${rep.assigneeAgentId}\`.\n\n` +
    `Repair applied, the same two-step run by hand 47 times on 2026-08-12:\n` +
    `- PATCH status -> \`todo\` (NOT \`done\`: \`todo\` is queue-visible and still counts as an unresolved ` +
    `blocker upstream, so any parent stays correctly blocked and no unrun work is destroyed)\n` +
    `- PATCH assigneeAgentId -> \`${rep.assigneeAgentId}\` (the returnOwnerAgentId off the recovery payload, ` +
    `NOT the current assignee -- the reconciler re-homed this row to a boss)\n` +
    `- \`blockedByIssueIds\` deliberately NOT re-sent.\n\n` +
    `No content judgement was made on the underlying work; the strand is cleared and the ticket is yours. ` +
    `Commented before the reassign because assignment is one-way.\n\n` +
    `Drained by scripts/drain-blocked-empty.mjs${runId ? ` (run ${runId})` : ''}.`
  );
}

/* ------------------------------------------------------------------ *
 * The plan — pure
 * ------------------------------------------------------------------ */

/**
 * Turn a sweep result into a per-row plan. Pure, so the whole cohort decision
 * is testable without a transport.
 *
 * Shape 2 (`blocked` behind blockers that are all closed) is OUT OF SCOPE by
 * ruling, and is skipped explicitly rather than by omission — an unmentioned
 * exclusion reads as "there were none".
 */
export function planDrain(result, { only = null, exclude = carveOut } = {}) {
  const selected = only ? new Set(only.map((s) => String(s).trim()).filter(Boolean)) : null;
  const rows = [];

  for (const f of result.findings || []) {
    const ident = f.identifier || f.id;
    if (selected && !selected.has(ident)) {
      rows.push({ f, action: ACTION.SKIP_NOT_SELECTED, why: `--only was given and does not name ${ident}` });
      continue;
    }
    const carved = exclude(f);
    if (carved) {
      rows.push({ f, action: ACTION.SKIP_EXCLUDED, why: carved });
      continue;
    }
    if (f.shape !== SHAPE.EMPTY_BLOCKED_BY) {
      rows.push({
        f,
        action: ACTION.SKIP_SHAPE_2,
        why:
          'shape 2 (every blocker closed) is a different class with a different repair, and TRA-3541 scopes this ' +
          'drain to the EMPTY-blockedBy recovery-strand cohort only. Detection owns it (TRA-3537).',
      });
      continue;
    }
    const rep = f.repair || { eligible: false, why: 'no repair was derived' };
    if (!rep.eligible) {
      rows.push({
        f,
        action: ACTION.SKIP_INELIGIBLE,
        // The recovery kind is carried VERBATIM: this is the line that
        // falsifies the `stranded_assigned_issue` gate if it is wrong.
        why: `recoveryKind=\`${f.recoveryKind || 'none'}\` cause=\`${f.recoveryCause || 'none'}\` -- ${rep.why}`,
      });
      continue;
    }
    rows.push({ f, action: ACTION.DRAIN, why: rep.why });
  }

  const by = (a) => rows.filter((r) => r.action === a);
  return {
    rows,
    drain: by(ACTION.DRAIN),
    counts: {
      findings: (result.findings || []).length,
      shape1: (result.findings || []).filter((f) => f.shape === SHAPE.EMPTY_BLOCKED_BY).length,
      drain: by(ACTION.DRAIN).length,
      excluded: by(ACTION.SKIP_EXCLUDED).length,
      shape2: by(ACTION.SKIP_SHAPE_2).length,
      ineligible: by(ACTION.SKIP_INELIGIBLE).length,
      notSelected: by(ACTION.SKIP_NOT_SELECTED).length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The execution — one row
 * ------------------------------------------------------------------ */

export const OUTCOME = {
  DRAINED: 'DRAINED',
  PLANNED: 'PLANNED',
  FOREIGN: 'FOREIGN',
  WRITE_FAILED: 'WRITE_FAILED',
  NOT_VERIFIED: 'NOT_VERIFIED',
};

const isBoundary403 = (err) => /\b403\b/.test(String(err?.message || err)) || /authorization boundary/i.test(String(err?.message || err));

/**
 * Execute the repair on ONE row, or plan it if `apply` is false.
 *
 * Every step records what it SENT, so the controls can assert the bodies and
 * the ORDER rather than trusting the prose above them.
 *
 * ⛔ A 403 stops this row dead. It does not fall through to the next step: a
 * half-written row (status flipped, assignee not) is strictly worse than an
 * untouched one, because it leaves queue-visible work homed on the wrong agent
 * with no recovery action left to name the right one.
 */
export async function drainRow(transport, row, { apply = false, runId = null } = {}) {
  const f = row.f;
  const rep = f.repair;
  const steps = [];
  const send = async (step, fn, body) => {
    const graded = gradeWriteBody(step, body);
    if (!graded.ok) {
      // Not a skip. The caller built a body this file does not sanction, which
      // is a code defect, and continuing would write it.
      throw new Error(`REFUSED to send an unsanctioned ${step} body -- ${graded.why}`);
    }
    steps.push({ step, body, sent: apply });
    if (!apply) return null;
    return fn();
  };

  try {
    await send('comment', () => transport.postComment(f.id, { body: drainComment(f, runId) }), {
      body: drainComment(f, runId),
    });
    await send('status', () => transport.patchIssue(f.id, { status: rep.status }), { status: rep.status });
    await send('assignee', () => transport.patchIssue(f.id, { assigneeAgentId: rep.assigneeAgentId }), {
      assigneeAgentId: rep.assigneeAgentId,
    });
  } catch (err) {
    if (isBoundary403(err)) {
      return {
        outcome: OUTCOME.FOREIGN,
        steps,
        why:
          `403 outside this actor's authorization boundary on the \`${steps[steps.length - 1]?.step || 'first'}\` ` +
          `step. This row is currently assigned to ${f.assigneeName || f.assigneeAgentId || 'nobody'} and only that ` +
          'seat can drain it. Rank does not lift the boundary and there is no predictor for it -- this is the twin ' +
          "arm's row, not a retry.",
      };
    }
    return { outcome: OUTCOME.WRITE_FAILED, steps, why: String(err?.message || err) };
  }

  if (!apply) return { outcome: OUTCOME.PLANNED, steps, why: 'dry run -- nothing was sent' };

  // Verify by VALUE, not by the 2xx. A PATCH that returns 200 and does not
  // stick is the failure mode a status-code check cannot see.
  let after;
  try {
    after = await transport.getIssue(f.id);
  } catch (err) {
    return {
      outcome: OUTCOME.NOT_VERIFIED,
      steps,
      why: `both writes returned ok but the re-read threw (${String(err?.message || err)}) -- the repair is UNPROVEN`,
    };
  }
  const problems = [];
  if (after.status !== rep.status) problems.push(`status is \`${after.status}\`, expected \`${rep.status}\``);
  if (after.assigneeAgentId !== rep.assigneeAgentId) {
    problems.push(`assigneeAgentId is \`${after.assigneeAgentId}\`, expected \`${rep.assigneeAgentId}\``);
  }
  // The blocker key must be untouched and still empty. If something re-populated
  // it, the row was not drained, it was re-blocked, and reporting DRAINED would
  // be a false green.
  if (!Object.prototype.hasOwnProperty.call(after, 'blockedBy')) {
    problems.push("the re-read carries no 'blockedBy' key, so the drain cannot be verified (absent is not empty)");
  } else if (Array.isArray(after.blockedBy) && after.blockedBy.length !== 0) {
    problems.push(`blockedBy is no longer empty (${after.blockedBy.length} entr(ies)) -- this row was re-blocked`);
  }
  if (problems.length) return { outcome: OUTCOME.NOT_VERIFIED, steps, why: problems.join('; ') };

  return { outcome: OUTCOME.DRAINED, steps, why: `verified by re-read: \`${after.status}\` -> ${rep.assigneeAgentId}` };
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

/**
 * The exit code answers exactly one question: IS THERE WORK NOBODY IS COMING FOR?
 *
 * Two of the skip classes always have a named owner, and they are PERMANENT
 * classes, not incidents:
 *
 *   SKIP_EXCLUDED  an off-roster/unassigned row. Owned by the human board by
 *                  construction (no agent can write it), and re-derived from
 *                  the rule on every fire.
 *   SKIP_SHAPE_2   the silent all-blockers-closed class. Owned by detection
 *                  (TRA-3537) and routed per row (TRA-3539).
 *
 * If those raised the exit code, this routine would exit 1 every single day on
 * a board with nothing wrong, and a daily red is a daily red that gets tuned
 * out. They are ACKNOWLEDGED: never suppressed from the report — every fire
 * prints them with the reason, so the carve-out stays auditable — but they do
 * not colour the verdict.
 *
 * INELIGIBLE and FOREIGN do raise it. An ineligible row means the repair gate
 * rejected something in the cohort (including the case where the
 * `stranded_assigned_issue` kind gate is simply wrong), and a FOREIGN row means
 * a real strand is sitting on a seat whose twin arm has not drained it. Both
 * need a person.
 */
export function verdictFor({ blind, plan, results }) {
  if (blind) return 'BLIND';
  const bad = results.filter((r) => r.outcome === OUTCOME.WRITE_FAILED || r.outcome === OUTCOME.NOT_VERIFIED);
  if (bad.length) return 'FAILED';
  const unowned = plan.counts.ineligible + results.filter((r) => r.outcome === OUTCOME.FOREIGN).length;
  if (unowned > 0) return 'REMAINDER';
  // ⛔ The whole point of a separate verdict here. An empty cohort exercised
  // NOTHING; folding it into a success verdict is how a fleet of green logs
  // gets read back as "the drain works".
  if (plan.counts.drain === 0) return 'VACUOUS';
  return 'DRAINED';
}

export async function run(transport, opts = {}) {
  const apply = !!opts.apply;
  const result = await sweep(transport, opts);
  if (result.verdict === 'BLIND') {
    return { verdict: 'BLIND', blind: result.blind, sweep: result, plan: null, results: [], apply };
  }
  const plan = planDrain(result, { only: opts.only || null });

  const results = [];
  for (const row of plan.drain) {
    // Deliberately serial. These are writes against a live board; a fan-out
    // buys nothing on a cohort this size and makes a partial failure harder to
    // read back.
    const r = await drainRow(transport, row, { apply, runId: opts.runId || null });
    results.push({ ...r, identifier: row.f.identifier || row.f.id, id: row.f.id, repair: row.f.repair });
  }

  return {
    verdict: verdictFor({ blind: null, plan, results }),
    blind: null,
    sweep: result,
    plan,
    results,
    apply,
  };
}

export function renderDrain(out) {
  const L = [];
  L.push('');
  L.push('TRA-3541  blocked + EMPTY blockedBy -- recovery-strand DRAIN');
  L.push('='.repeat(72));
  if (out.verdict === 'BLIND') {
    L.push(`BLIND  ${out.blind}`);
    L.push('       No count is reported and nothing was written. "0 found" and "0 looked at" render');
    L.push('       identically, so a blind sweep must never authorise a write.');
    return L;
  }

  const c = out.plan.counts;
  L.push(`mode      ${out.apply ? 'APPLY (writing)' : 'DRY RUN (nothing sent)'}`);
  L.push(`scanned   ${out.sweep.scanned} issue(s), ${out.sweep.itemReads} blocked row(s) hydrated`);
  L.push(`cohort    ${c.shape1} shape-1 (empty blockedBy) of ${c.findings} strand finding(s)`);
  L.push(
    `plan      ${c.drain} drainable | ${c.ineligible} ineligible | ${c.excluded} excluded | ` +
      `${c.shape2} shape-2 (out of scope)${c.notSelected ? ` | ${c.notSelected} not selected` : ''}`,
  );
  L.push('');

  if (out.verdict === 'VACUOUS') {
    L.push('VACUOUS   NO DRAINABLE ROW EXISTED. Nothing was exercised, so this run is NOT evidence that');
    L.push('          the drain works -- it is evidence that there was nothing to drain. Armed is not');
    L.push('          observing. The write path is covered by --selftest until a real strand appears.');
    if (c.excluded + c.shape2 > 0) {
      L.push(`          (${c.excluded + c.shape2} acknowledged row(s) below have named owners and do not colour this.)`);
    }
  }

  for (const r of out.results) {
    const mark =
      r.outcome === OUTCOME.DRAINED ? 'DRAINED ' : r.outcome === OUTCOME.PLANNED ? 'WOULD   ' : `${r.outcome} `;
    L.push(`${mark} ${r.identifier}  -> todo, assignee ${r.repair.assigneeAgentId}`);
    L.push(`         ${r.why}`);
    for (const s of r.steps) L.push(`         ${s.sent ? 'sent' : 'plan'} ${s.step}  ${JSON.stringify(s.body).slice(0, 120)}`);
  }

  const skipped = out.plan.rows.filter((r) => r.action !== ACTION.DRAIN);
  if (skipped.length) {
    L.push('');
    L.push('NOT DRAINED -- each of these still needs someone:');
    for (const r of skipped) {
      L.push(`  ${r.action}  ${r.f.identifier || r.f.id}  (assignee ${r.f.assigneeName || r.f.assigneeAgentId || 'none'})`);
      L.push(`         ${r.why}`);
    }
  }

  const foreign = out.results.filter((x) => x.outcome === OUTCOME.FOREIGN);
  if (foreign.length) {
    L.push('');
    L.push(`FOREIGN  ${foreign.length} row(s) are outside this seat's boundary. Repair is assignee-scoped and rank`);
    L.push('         does not lift it, so these drain from the OWNER\'s arm of this same routine, by seat.');
  }

  L.push('');
  L.push(`verdict   ${out.verdict}  (exit ${DRAIN_EXIT[out.verdict]})`);
  return L;
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

const AGENT_SELF = 'agent-cto';
const AGENT_BACK = 'agent-qt';

/** A blocked+empty row carrying a live stranded_assigned_issue payload. */
const strandRow = (id, ident, { kind = 'stranded_assigned_issue', previousStatus = 'in_progress', returnOwner = AGENT_BACK, assignee = AGENT_SELF } = {}) => ({
  id,
  identifier: ident,
  title: `strand ${ident}`,
  status: 'blocked',
  assigneeAgentId: assignee,
  parentId: null,
  blockedBy: [],
  activeRecoveryAction: {
    kind,
    cause: 'issue_continuation_needed',
    status: 'active',
    attemptCount: 1,
    returnOwnerAgentId: returnOwner,
    previousOwnerAgentId: returnOwner,
    lastAttemptAt: '2026-08-12T11:39:00.000Z',
    createdAt: '2026-08-12T11:39:00.000Z',
    evidence: { previousStatus },
  },
});

/** `blocked` behind blockers that are ALL closed -- shape 2, out of scope. */
const shape2Row = (id, ident) => ({
  id,
  identifier: ident,
  title: `shape2 ${ident}`,
  status: 'blocked',
  assigneeAgentId: AGENT_SELF,
  parentId: null,
  blockedBy: [{ id: 'g1', identifier: 'TRA-7001', status: 'done', assigneeAgentId: AGENT_SELF }],
  activeRecoveryAction: null,
});

/**
 * A transport over a fake board that RECORDS every write and can be told to
 * 403, to lie (2xx that does not stick), or to refuse reads.
 */
function fakeTransport(rows, { pending = {}, on403 = null, lieOnPatch = false, total = 2350 } = {}) {
  const writes = [];
  const byId = new Map(rows.map((r) => [r.id, JSON.parse(JSON.stringify(r))]));
  const filler = Array.from({ length: total - rows.length }, (_, i) => ({
    id: `f${i}`,
    identifier: `TRA-F${i}`,
    status: 'done',
    parentId: null,
    assigneeAgentId: AGENT_SELF,
  }));
  const all = [...rows.map((r) => ({ ...r, blockedBy: undefined })), ...filler].map((r) => {
    const { blockedBy: _dropped, ...rest } = r; // the LIST route omits blockedBy
    return rest;
  });

  return {
    writes,
    listAgents: async () => [
      { id: AGENT_SELF, name: 'CTO', role: 'cto' },
      { id: AGENT_BACK, name: 'QuantTrader', role: 'quant' },
    ],
    getIssuesPage: async ({ limit, offset }) => all.slice(offset, offset + limit),
    getIssue: async (id) => {
      const r = byId.get(id);
      if (!r) throw new Error(`no such issue ${id}`);
      return JSON.parse(JSON.stringify(r));
    },
    getComments: async () => [],
    getInteractions: async (id) => Array.from({ length: pending[id] || 0 }, () => ({ status: 'pending' })),
    postComment: async (id, body) => {
      if (on403 === 'comment') throw new Error('HTTP 403 — {"error":"Issue is outside this actor\'s authorization boundary"}');
      writes.push({ verb: 'POST', id, body });
      return { ok: true };
    },
    patchIssue: async (id, body) => {
      if (on403 === 'status' && body.status) {
        throw new Error('HTTP 403 — {"error":"Issue is outside this actor\'s authorization boundary"}');
      }
      if (on403 === 'assignee' && body.assigneeAgentId) {
        throw new Error('HTTP 403 — {"error":"Issue is outside this actor\'s authorization boundary"}');
      }
      writes.push({ verb: 'PATCH', id, body });
      if (!lieOnPatch) Object.assign(byId.get(id), body);
      return { ok: true };
    },
  };
}

const CONTROLS = [
  {
    name: 'POSITIVE — an eligible strand drains: comment, then status, then assignee LAST, then verified by re-read',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')]),
    apply: true,
    assert: (out, t) => {
      const verbs = t.writes.map((w) => `${w.verb} ${JSON.stringify(w.body)}`);
      return (
        out.verdict === 'DRAINED' &&
        out.results.length === 1 &&
        out.results[0].outcome === OUTCOME.DRAINED &&
        t.writes.length === 3 &&
        verbs[0].startsWith('POST') &&
        verbs[1] === 'PATCH {"status":"todo"}' &&
        verbs[2] === `PATCH {"assigneeAgentId":"${AGENT_BACK}"}`
      );
    },
    detail: (out, t) => `${t.writes.length} write(s): ${t.writes.map((w) => `${w.verb} ${Object.keys(w.body).join('+')}`).join(' -> ')}`,
  },
  {
    name: 'VACUOUS — an empty cohort is its OWN verdict, exit 0, and the report never says CLEAN',
    build: () => fakeTransport([]),
    apply: true,
    assert: (out, t) =>
      out.verdict === 'VACUOUS' &&
      DRAIN_EXIT[out.verdict] === 0 &&
      t.writes.length === 0 &&
      !/\bCLEAN\b/.test(renderDrain(out).join('\n')) &&
      /NOT evidence/.test(renderDrain(out).join('\n')) &&
      /Armed is not/.test(renderDrain(out).join('\n')),
    detail: (out) => `verdict ${out.verdict}, 0 rows exercised`,
  },
  {
    name: 'DRY RUN — the default sends NOTHING, and still names the two writes it would make',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')]),
    apply: false,
    assert: (out, t) =>
      t.writes.length === 0 &&
      out.results.length === 1 &&
      out.results[0].outcome === OUTCOME.PLANNED &&
      out.results[0].steps.map((s) => s.step).join(',') === 'comment,status,assignee' &&
      out.results[0].steps.every((s) => s.sent === false),
    detail: (out, t) => `${t.writes.length} write(s) sent; steps planned: ${out.results[0].steps.map((s) => s.step).join(',')}`,
  },
  {
    name: 'NEVER done — the status body is `todo` even when evidence.previousStatus is `done`',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001', { previousStatus: 'done' })]),
    apply: true,
    // `deriveRepair` restores from evidence but WRITES todo; this asserts the
    // wire body, not the derivation, because the wire is what destroys work.
    assert: (out, t) => {
      const statusWrites = t.writes.filter((w) => w.body.status);
      return statusWrites.length === 1 && statusWrites[0].body.status === 'todo' && out.results[0].repair.restoredFrom === 'done';
    },
    detail: (out, t) => `restoredFrom=${out.results[0]?.repair?.restoredFrom}, wrote ${JSON.stringify(t.writes.find((w) => w.body.status)?.body)}`,
  },
  {
    name: 'NEVER a blocker key — gradeWriteBody REFUSES any body carrying blockedByIssueIds, on every step',
    unit: () => {
      const a = gradeWriteBody('status', { status: 'todo', blockedByIssueIds: [] });
      const b = gradeWriteBody('assignee', { assigneeAgentId: 'x', blockedBy: [] });
      const c = gradeWriteBody('status', { status: 'done' });
      const d = gradeWriteBody('status', { status: 'in_progress' });
      const e = gradeWriteBody('status', { status: 'todo' });
      return {
        ok:
          !a.ok && /blocker write-key/.test(a.why) &&
          !b.ok && /blocker write-key/.test(b.why) &&
          !c.ok && /DESTROYS unrun work/.test(c.why) &&
          !d.ok && /re-strands the leaf/.test(d.why) &&
          e.ok,
        detail: 'blockedByIssueIds refused, blockedBy refused, done refused, in_progress refused, todo allowed',
      };
    },
  },
  {
    name: 'NEVER non-ASCII — an em dash in the audit comment is refused before it reaches the thread',
    unit: () => {
      const bad = gradeWriteBody('comment', { body: 'drained — see TRA-3541' });
      const good = gradeWriteBody('comment', { body: 'drained -- see TRA-3541' });
      return { ok: !bad.ok && /non-ASCII/.test(bad.why) && good.ok, detail: bad.why };
    },
  },
  {
    name: 'The REAL comment body this script ships is ASCII-clean (the template itself is under control)',
    unit: () => {
      const f = {
        identifier: 'TRA-8001',
        recoveryKind: 'stranded_assigned_issue',
        repair: { restoredFrom: 'in_progress', assigneeAgentId: AGENT_BACK, status: 'todo' },
      };
      const g = gradeWriteBody('comment', { body: drainComment(f, 'run-1') });
      return { ok: g.ok, detail: g.ok ? 'template is ASCII' : g.why };
    },
  },
  {
    name: 'PENDING CARD — a live interaction blocks the drain (demoting a leaf holding a card buries a decision)',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')], { pending: { s1: 1 } }),
    apply: true,
    assert: (out, t) =>
      t.writes.length === 0 &&
      out.verdict === 'REMAINDER' &&
      DRAIN_EXIT[out.verdict] === 1 &&
      out.plan.counts.ineligible === 1 &&
      /pending interactions: 1/.test(out.plan.rows[0].why),
    detail: (out) => out.plan.rows[0].why.slice(0, 90),
  },
  {
    name: 'UNKNOWN CARD — an interaction route that throws is NOT zero, so the row is left alone',
    build: () => {
      const t = fakeTransport([strandRow('s1', 'TRA-8001')]);
      t.getInteractions = async () => {
        throw new Error('boom');
      };
      return t;
    },
    apply: true,
    assert: (out, t) => t.writes.length === 0 && out.verdict === 'REMAINDER' && /UNKNOWN \(route unread\)/.test(out.plan.rows[0].why),
    detail: (out) => out.plan.rows[0].why.slice(0, 90),
  },
  {
    name: 'FOREIGN — a 403 on the status step STOPS the row; the assignee write is never attempted',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')], { on403: 'status' }),
    apply: true,
    assert: (out, t) =>
      out.verdict === 'REMAINDER' &&
      out.results[0].outcome === OUTCOME.FOREIGN &&
      // the comment landed (still ours at that point), the status 403'd, and
      // NOTHING assignee-shaped was sent -- a half-written row is worse than none
      t.writes.filter((w) => w.body.assigneeAgentId).length === 0,
    detail: (out, t) => `${t.writes.length} write(s) landed; outcome ${out.results[0].outcome}`,
  },
  {
    name: 'FOREIGN — a 403 on the very first write (the comment) is reported as boundary, not as a failure',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')], { on403: 'comment' }),
    apply: true,
    assert: (out, t) => out.results[0].outcome === OUTCOME.FOREIGN && t.writes.length === 0 && out.verdict === 'REMAINDER',
    detail: (out) => out.results[0].why.slice(0, 90),
  },
  {
    name: 'THE LIE — a PATCH that returns 2xx and does not STICK is FAILED, not DRAINED (verified by value)',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')], { lieOnPatch: true }),
    apply: true,
    assert: (out) =>
      out.verdict === 'FAILED' &&
      DRAIN_EXIT[out.verdict] === 2 &&
      out.results[0].outcome === OUTCOME.NOT_VERIFIED &&
      /status is `blocked`/.test(out.results[0].why),
    detail: (out) => out.results[0].why.slice(0, 110),
  },
  {
    name: 'RE-BLOCKED — a row whose blockedBy came back non-empty after the write is NOT a drain',
    build: () => {
      const t = fakeTransport([strandRow('s1', 'TRA-8001')]);
      const inner = t.getIssue;
      t.getIssue = async (id) => {
        const r = await inner(id);
        if (r.status === 'todo') r.blockedBy = [{ id: 'x', identifier: 'TRA-9', status: 'todo' }];
        return r;
      };
      return t;
    },
    apply: true,
    assert: (out) => out.verdict === 'FAILED' && /re-blocked/.test(out.results[0].why),
    detail: (out) => out.results[0].why.slice(0, 110),
  },
  {
    name: 'KIND GATE — a strand whose recoveryKind is NOT stranded_assigned_issue is left alone AND the kind is printed verbatim',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001', { kind: 'successful_run_missing_state' })]),
    apply: true,
    // This is the falsifier for the one assumption this script could not
    // re-measure at ship time. It must exit 1, never 0.
    assert: (out, t) =>
      t.writes.length === 0 &&
      out.verdict === 'REMAINDER' &&
      DRAIN_EXIT[out.verdict] === 1 &&
      /recoveryKind=`successful_run_missing_state`/.test(out.plan.rows[0].why),
    detail: (out) => out.plan.rows[0].why.slice(0, 110),
  },
  {
    name: 'NO RETURN OWNER — a stranded row with no returnOwnerAgentId is routed, never drained to a guess',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001', { returnOwner: null })]),
    apply: true,
    assert: (out, t) => t.writes.length === 0 && out.verdict === 'REMAINDER' && /NO `returnOwnerAgentId`/.test(out.plan.rows[0].why),
    detail: (out) => out.plan.rows[0].why.slice(0, 110),
  },
  {
    name: 'SHAPE 2 is out of scope, is skipped EXPLICITLY, and is ACKNOWLEDGED (owned by TRA-3537, so it does not colour the exit)',
    build: () => fakeTransport([shape2Row('s2', 'TRA-8002')]),
    apply: true,
    assert: (out, t) =>
      t.writes.length === 0 &&
      out.plan.counts.shape2 === 1 &&
      out.verdict === 'VACUOUS' &&
      // acknowledged means "not red", NEVER "not printed"
      /SKIP_SHAPE_2/.test(renderDrain(out).join('\n')),
    detail: (out) => `shape2=${out.plan.counts.shape2}, verdict ${out.verdict}, still printed`,
  },
  {
    name: 'CARVE-OUT is a RULE, not a row — an OFF-ROSTER assignee is never drained, and the reason is printed every fire',
    build: () => fakeTransport([strandRow('s1', 'TRA-382', { assignee: '2fc6fe3b-departed' })]),
    apply: true,
    assert: (out, t) =>
      t.writes.length === 0 &&
      out.plan.counts.excluded === 1 &&
      out.verdict === 'VACUOUS' &&
      /not in this company's agent roster/.test(out.plan.rows[0].why) &&
      /TRA-382/.test(renderDrain(out).join('\n')),
    detail: (out) => out.plan.rows[0].why.slice(0, 90),
  },
  {
    name: 'CARVE-OUT EXPIRES BY ITSELF — the same row with a LIVE on-roster assignee is drained, no edit required',
    build: () => fakeTransport([strandRow('s1', 'TRA-382', { assignee: AGENT_SELF })]),
    apply: true,
    // The control that a membership list could never pass. This is what stops
    // the carve-out outliving its reason.
    assert: (out, t) => out.verdict === 'DRAINED' && out.plan.counts.excluded === 0 && t.writes.length === 3,
    detail: (out) => `verdict ${out.verdict}, excluded ${out.plan.counts.excluded}`,
  },
  {
    name: 'ACKNOWLEDGED vs UNOWNED — a board carrying BOTH exits 1 on the ineligible row, not on the acknowledged ones',
    build: () =>
      fakeTransport([
        shape2Row('s2', 'TRA-8002'),
        strandRow('s3', 'TRA-8003', { assignee: '2fc6fe3b-departed' }),
        strandRow('s4', 'TRA-8004', { kind: 'missing_disposition' }),
      ]),
    apply: true,
    assert: (out, t) => {
      const rendered = renderDrain(out).join('\n');
      return (
        out.verdict === 'REMAINDER' &&
        DRAIN_EXIT[out.verdict] === 1 &&
        out.plan.counts.ineligible === 1 &&
        out.plan.counts.excluded === 1 &&
        out.plan.counts.shape2 === 1 &&
        t.writes.length === 0 &&
        // all three printed, only one of them red
        ['TRA-8002', 'TRA-8003', 'TRA-8004'].every((i) => rendered.includes(i))
      );
    },
    detail: (out) => `ineligible ${out.plan.counts.ineligible} (red) + excluded ${out.plan.counts.excluded} + shape2 ${out.plan.counts.shape2} (acknowledged) => ${out.verdict}`,
  },
  {
    name: 'MIXED BOARD — one drainable, one ineligible: the drainable one is written and the verdict is still REMAINDER',
    build: () =>
      fakeTransport([strandRow('s1', 'TRA-8001'), strandRow('s2', 'TRA-8002', { kind: 'missing_disposition' })]),
    apply: true,
    assert: (out, t) =>
      out.verdict === 'REMAINDER' &&
      out.plan.counts.drain === 1 &&
      out.plan.counts.ineligible === 1 &&
      t.writes.length === 3 &&
      t.writes.every((w) => w.id === 's1'),
    detail: (out, t) => `drained ${out.plan.counts.drain}, ineligible ${out.plan.counts.ineligible}, writes ${t.writes.length}`,
  },
  {
    name: 'BLIND — a capped enumeration authorises NO write and exits 3 (0 found and 0 looked at render alike)',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')]),
    apply: true,
    opts: { maxPages: 1 },
    assert: (out, t) => out.verdict === 'BLIND' && DRAIN_EXIT[out.verdict] === 3 && t.writes.length === 0,
    detail: (out, t) => `${out.blind}; ${t.writes.length} write(s)`,
  },
  {
    name: '--only restricts the write to the named row and skips the rest EXPLICITLY',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001'), strandRow('s2', 'TRA-8002')]),
    apply: true,
    opts: { only: ['TRA-8002'] },
    assert: (out, t) =>
      t.writes.length === 3 && t.writes.every((w) => w.id === 's2') && out.plan.counts.notSelected === 1,
    detail: (out, t) => `wrote to ${[...new Set(t.writes.map((w) => w.id))].join(',')}, notSelected ${out.plan.counts.notSelected}`,
  },
  {
    name: 'ORDER IS LOAD-BEARING — reversing it (assignee before status) would 403 the status write, so it is asserted, not assumed',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')]),
    apply: true,
    assert: (out) => {
      const steps = out.results[0].steps.map((s) => s.step);
      return steps.indexOf('comment') === 0 && steps.indexOf('status') < steps.indexOf('assignee') && steps.length === 3;
    },
    detail: (out) => out.results[0].steps.map((s) => s.step).join(' -> '),
  },
];

async function selftest() {
  let failed = 0;
  const seenVerdicts = new Set();
  const seenOutcomes = new Set();

  for (const c of CONTROLS) {
    let ok = false;
    let detail = '';
    try {
      if (c.unit) {
        const r = c.unit();
        ok = r.ok;
        detail = r.detail;
      } else {
        const t = c.build();
        const out = await run(t, { apply: c.apply, ...(c.opts || {}) });
        seenVerdicts.add(out.verdict);
        for (const r of out.results) seenOutcomes.add(r.outcome);
        ok = c.assert(out, t);
        detail = c.detail ? c.detail(out, t) : '';
      }
    } catch (err) {
      detail = String(err?.stack || err);
    }
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.name}${detail ? `\n        ${detail}` : ''}`);
  }

  // Arm-reachability. A suite whose controls all exercise one branch proves one
  // branch. Every verdict and every row outcome must be REACHED by some case,
  // or the suite is smaller than it looks.
  const wantVerdicts = ['VACUOUS', 'DRAINED', 'REMAINDER', 'FAILED', 'BLIND'];
  const wantOutcomes = [OUTCOME.DRAINED, OUTCOME.PLANNED, OUTCOME.FOREIGN, OUTCOME.NOT_VERIFIED];
  for (const [label, want, seen] of [
    ['verdict', wantVerdicts, seenVerdicts],
    ['row outcome', wantOutcomes, seenOutcomes],
  ]) {
    const missing = want.filter((v) => !seen.has(v));
    if (missing.length) failed += 1;
    console.log(
      `${missing.length ? 'FAIL' : 'ok  '}  every ${label} arm is reachable: ${want.join(', ')}` +
        (missing.length ? `\n        NEVER REACHED: ${missing.join(', ')}` : ''),
    );
  }

  console.log(`\n${CONTROLS.length + 2 - failed}/${CONTROLS.length + 2} controls pass`);
  return failed === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * Live transport
 * ------------------------------------------------------------------ */

/**
 * Exported so the LIVE write path can be exercised against a real row.
 *
 * The controls above run `drainRow` over a fake transport, which proves the
 * bodies, the order and the fail-closed branches — but a fake transport cannot
 * prove that the real PATCH verb, auth header and re-read actually work from
 * this seat. That gap was closed once by running the real `drainRow` through
 * this transport against a throwaway row (TRA-3543, 2026-08-13); see the
 * TRA-3541 thread for the tape.
 */
export function liveTransport() {
  const raw = String(process.env.PAPERCLIP_API_URL || '').replace(/\/+$/, '');
  const BASE = argOf('base', raw.replace(/\/api$/, ''));
  const KEY = process.env.PAPERCLIP_API_KEY;
  const CO = argOf('company', process.env.PAPERCLIP_COMPANY_ID);
  if (!BASE || !KEY || !CO) {
    throw new Error('PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must all be set');
  }
  const headers = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
  const runId = process.env.PAPERCLIP_RUN_ID || null;
  const json = async (method, url, body) => {
    const res = await fetch(url, {
      method,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        ...(runId ? { 'X-Paperclip-Run-Id': runId } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${method} ${url} -- ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
  const get = async (url) => {
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url} -- ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
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
    getComments: async (id) => unwrap(await get(`${BASE}/api/issues/${id}/comments`), 'comments'),
    getInteractions: async (id) => unwrap(await get(`${BASE}/api/issues/${id}/interactions`), 'interactions'),
    postComment: async (id, body) => json('POST', `${BASE}/api/issues/${id}/comments`, body),
    patchIssue: async (id, body) => json('PATCH', `${BASE}/api/issues/${id}`, body),
  };
}

async function main() {
  if (argv.includes('--selftest')) return selftest();

  const apply = argv.includes('--apply');
  const only = argOf('only', null);
  const out = await run(liveTransport(), {
    apply,
    only: only ? String(only).split(',') : null,
    runId: process.env.PAPERCLIP_RUN_ID || null,
    limit: Number(argOf('limit', 1000)),
    maxPages: Number(argOf('max-pages', 50)),
    concurrency: Number(argOf('concurrency', 8)),
  });

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          issue: 'TRA-3541',
          checkedAt: new Date().toISOString(),
          apply: out.apply,
          verdict: out.verdict,
          blind: out.blind,
          counts: out.plan ? out.plan.counts : null,
          results: out.results.map((r) => ({
            identifier: r.identifier,
            outcome: r.outcome,
            why: r.why,
            assignedTo: r.repair?.assigneeAgentId || null,
          })),
          notDrained: out.plan
            ? out.plan.rows.filter((r) => r.action !== ACTION.DRAIN).map((r) => ({ identifier: r.f.identifier, action: r.action, why: r.why }))
            : [],
        },
        null,
        2,
      ),
    );
  } else {
    for (const l of renderDrain(out)) console.log(l);
    if (argv.includes('--with-detector-report')) for (const l of renderReport(out.sweep)) console.log(l);
  }
  return DRAIN_EXIT[out.verdict] ?? 3;
}

const IS_ENTRYPOINT = (() => {
  try {
    return !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return true;
  }
})();

if (IS_ENTRYPOINT) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('ERROR', err?.stack || err);
      process.exit(3);
    });
}
