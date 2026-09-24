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
 * `finding.repair` that detector already emits as `RESTORE-PATCH 1/1`. That
 * import is the whole point: a drain with its own copy of the predicate
 * silently repairs a DIFFERENT population than the one being graded, and the
 * two drift apart on the first edit to either. One predicate, one cohort, two
 * readers.
 *
 * THE ONE WRITE PER ROW (TRA-4043)
 * --------------------------------
 *   1. PATCH {"status": <-- CLASS-DEPENDENT, "comment": <the audit trail>}
 *
 * Until 2026-09-24 this was two writes — POST /comments first (while the row
 * was still ours: once a row leaves this actor's authorization boundary, both
 * writes 403; see the CFO hand-back on TRA-3397), then the status PATCH. Two
 * writes per row halves the row ceiling under the per-run cross-issue write
 * budget (THE BUDGET, below), and the ordering carried a race of its own: the
 * comment POST can mint the run lock that 409s the status PATCH behind it.
 * The platform PATCH accepts a `comment` string alongside `status` (verified
 * live 2026-09-24 — the TRA-4043 assignment comment itself was delivered that
 * way), so both land in ONE atomic write: there is no order left for a budget
 * cut-off or a lock to truncate mid-row (Defect 2 of TRA-4043 is structurally
 * unreachable), and a row costs exactly one unit of budget.
 *
 * ⛔ THERE IS NO THIRD WRITE (TRA-4041, MEASURED 2026-08-26). Until 2026-08-26
 * this file sent `PATCH {"assigneeAgentId": returnOwnerAgentId}` as step 3,
 * annotated "LAST, always -- assignment is ONE-WAY". That step could not
 * succeed, from here or from anywhere:
 *
 *   The status PATCH in step 2 MINTS A LIVE STATUS, and minting one SPAWNS A RUN
 *   that takes the issue checkout lock. `checkoutRunId` goes null -> set on the
 *   step-2 write. From that instant this actor's `actorRunId` no longer matches
 *   the row's `executionRunId`, so step 3 returns
 *   `409 {"error":"Issue run ownership conflict"}` -- 6 attempts, 6 409s, run
 *   by hand by the CFO across all six of their rows.
 *
 * That 409 is NOT the authorization boundary, and `isBoundary403` never matched
 * it, so a row this script had ALREADY REPAIRED fell through to `WRITE_FAILED`
 * and coloured the fire exit 2 FAILED. The order that was documented as
 * load-bearing was in fact the order that guaranteed a false red on every
 * successful drain.
 *
 * And no other order exists. Assignee-first hands the row away while it is
 * still `blocked` + empty -- still a strand -- and 403s us out of ever fixing
 * it. Status-first locks us out with the 409. The step was also never needed:
 * step 2 ALONE clears the strand (`activeRecoveryAction`
 * `stranded_assigned_issue:active` -> null, 6/6). The re-home to
 * `returnOwnerAgentId` is the platform's to make. This file READS that id, names
 * it in the audit comment, and does not write it.
 *
 * THE BUDGET (TRA-4043, MEASURED 2026-08-26)
 * ------------------------------------------
 * A single heartbeat run may make at most 20 cross-issue writes; attempt 21
 * returns HTTP 429 `cross_issue_influence_cap_exceeded` (enforce mode since
 * 2026-08-11 — two days BEFORE this drainer shipped). The 2026-08-26 CEO-arm
 * fire measured it first: cohort 27, plan 26 drainable, 6 drained, 1 truncated
 * mid-row, 19 never attempted — and the 19 were reported WRITE_FAILED, a
 * fabricated finding about healthy rows that coloured the fire exit 2 FAILED
 * and polluted the cohort the next fire read.
 *
 * This file is budget-aware:
 *   - ONE write per row (the combined PATCH above), so the row ceiling is
 *     cap minus writes the surrounding run already spent;
 *   - a row that would exceed the budget is NOT ATTEMPTED: outcome
 *     NOT_ATTEMPTED_BUDGET, zero network calls, EXCLUDED from the failure
 *     count entirely;
 *   - an actual 429 from the platform is AUTHORITATIVE (the local counter can
 *     only see what this script spent, not what the surrounding heartbeat run
 *     spent before it — probes and status PATCHes elsewhere in the run count
 *     too): the rejected row and every row after it go NOT_ATTEMPTED_BUDGET.
 *     Nothing is half-written, because the row's single write either landed
 *     or it did not;
 *   - the fire's verdict is DEFERRED (exit 1): a healthy fire that drained
 *     its budget's worth and cleanly deferred the rest, per the platform's own
 *     remedy text ("the budget resets per run"). Not a failure — and not green
 *     either, because rows remain for the next fire.
 * `--budget` overrides the cap (default 20); `--budget-spent` declares writes
 * the surrounding run already made before invoking this script.
 *
 * A separate 403, `cross_issue_influence_run_context_required`, is TRANSIENT
 * early-run state, not a permission verdict (TRA-4299: a byte-identical retry
 * succeeded minutes later in the same run). It is retried once after a short
 * delay (`--run-context-retry-ms`, default 3000); if it persists the row is
 * RUN_CONTEXT_DEFERRED (colours REMAINDER, exit 1) — never FOREIGN, never
 * FAILED — and after two consecutive such rows the rest of the plan is
 * deferred without further attempts.
 *
 * THE ROW CLASS DECIDES THE STATUS (TRA-4063, MEASURED 2026-08-26)
 * ---------------------------------------------------------------
 * Until 2026-08-26 this file wrote `todo` to every drainable row and the banner
 * here read "⛔ NEVER `done`". That was right for durable work and WRONG for one
 * class, and the wrong direction switches detectors off:
 *
 *   DURABLE STRAND   real work the reconciler blocked. -> `todo`. `done`
 *                    destroys unrun work and stays banned on this class.
 *   SUPPRESSING LEAF a per-fire routine spawn (`originKind: routine_execution`)
 *                    that gates nothing. -> `done`. Under BOTH
 *                    `skip_if_active` and `coalesce_if_active`, a fire landing
 *                    while the previous execution issue is still open is
 *                    dropped or merged, so a leaf left NON-TERMINAL silently
 *                    switches its own routine OFF -- while `nextRunAt` keeps
 *                    advancing and every census keeps reading it ARMED.
 *                    `todo` IS non-terminal. Draining a drain leaf to `todo`
 *                    disables the drain (TRA-4041).
 *
 * This is not a theoretical widening. The fire of 2026-08-26T12:30Z planned
 * `-> todo` for TRA-4058, the per-fire spawn of routine 82daa7b2 "TRA-4017
 * armed-liveness detector", `status: active`, `concurrencyPolicy:
 * skip_if_active`, `blocks: []`. It would have switched a live sibling detector
 * off, on this same seat. It did not happen only because a human read the dry
 * run before `--apply` (TRA-4063).
 *
 * ⛔ THE `done` AUTHORITY IS SCOPED TO THAT ONE CLASS AND ENFORCED ON THE WIRE.
 * `gradeWriteBody` takes the class and refuses `done` for anything else -- and
 * refuses `todo` FOR a suppressing leaf, because writing the generic status onto
 * this class is the defect, not a lesser outcome. It also refuses BOTH when no
 * class is supplied: a caller that forgets to classify must not inherit the old
 * default, which is exactly how this bug survived.
 *
 * ⛔ BOTH UNKNOWNS REFUSE TO WRITE. A row with no `originKind`, or a
 * `routine_execution` row whose `blocks` key is absent (absent is not empty),
 * cannot be told apart from the class it must not be given. It is reported
 * UNCLASSIFIABLE, nothing is sent, and it colours REMAINDER. Falling back to
 * `todo` on an unclassifiable row is the failure this ticket is about.
 *
 * ⛔ ONE PREDICATE, TWO READERS. The class comes from `suppressesOwnRoutine()`
 * imported from the detector -- the same rule the report prints. A drain with
 * its own copy classifies a different population than the one being graded, and
 * the two drift on the first edit to either.
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
 *   1  DEFERRED   the per-run cross-issue write budget ran out (TRA-4043).
 *                 Every drained row is verified, every deferred row got ZERO
 *                 writes and is still inside the detector cohort; the next
 *                 fire continues with a fresh budget. Healthy, but not green.
 *   2  FAILED     a write threw, or a write returned 2xx and the re-read shows
 *                 it did not stick. Present-but-wrong is not repaired.
 *                 Budget exhaustion is NEVER this (TRA-4043): a 429 cap
 *                 rejection means the write did not happen, which is a
 *                 different fact from a write that failed.
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
 *   node scripts/drain-blocked-empty.mjs --apply --budget=20 --budget-spent=3
 *
 * Auth: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.
 */

import { pathToFileURL } from 'node:url';
import { sweep, SHAPE, SEVERITY, renderReport, suppressesOwnRoutine } from './check-blocked-empty.mjs';

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
  // TRA-4043 — budget ran out. Shares exit 1 with REMAINDER (work remains for
  // a next actor) but is its own verdict word: the remaining rows are healthy
  // and owned by the NEXT fire, not by a person.
  DEFERRED: 1,
  FAILED: 2,
  BLIND: 3,
};

// TRA-4043 — the platform's per-run cross-issue write cap, enforce mode since
// 2026-08-11. One combined PATCH per row (comment + status in one body) costs
// one unit; reads are free.
export const BUDGET_DEFAULT_CAP = 20;

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
  // TRA-4063 — the class could not be decided, so NEITHER status is safe.
  SKIP_UNCLASSIFIABLE: 'SKIP_UNCLASSIFIABLE',
};

/* ------------------------------------------------------------------ *
 * The row class — which status this row gets (TRA-4063)
 * ------------------------------------------------------------------ */

export const ROW_CLASS = {
  DURABLE_STRAND: 'DURABLE_STRAND',
  SUPPRESSING_LEAF: 'SUPPRESSING_LEAF',
  UNCLASSIFIABLE: 'UNCLASSIFIABLE',
};

/** Statuses a row can rest at without its own routine treating it as still open. */
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

/**
 * Decide the class, and with it the ONE status this row may be written.
 *
 * Pure, and deliberately reads nothing but the sweep finding: the class must not
 * depend on a second network read, or an unreachable routines route becomes a
 * third unknown and the safe branch swallows the cohort. The origin routine IS
 * fetched later, but only to NAME it in the audit trail — never to decide this.
 *
 * The three answers are not symmetric. `todo` on a suppressing leaf switches a
 * routine off silently; `done` on a durable strand destroys unrun work loudly.
 * Neither is recoverable by the next fire, so an ambiguous row gets neither.
 */
export function classifyDisposition(f) {
  const originKind = f.originKind || null;
  const blocksKnown = f.blocksKnown === true;

  if (suppressesOwnRoutine(f)) {
    return {
      klass: ROW_CLASS.SUPPRESSING_LEAF,
      status: 'done',
      why:
        `originKind=\`routine_execution\` and \`blocks\` was READ and is EMPTY -- this is a per-fire spawn that ` +
        'gates nothing. Its routine treats a NON-TERMINAL leaf as still running (skip_if_active drops the next ' +
        'fire, coalesce_if_active merges into it), so the generic `todo` restore would leave the routine OFF while ' +
        'nextRunAt keeps advancing and every census reads it ARMED. Resting disposition for this class is `done` ' +
        '(TRA-4041 / TRA-4063). Terminal rest is the CLASS rule; whether the fire\'s read actually discharged is ' +
        'cited from the thread, never asserted off the payload (TRA-4817).',
    };
  }

  // Ordered AFTER the positive test on purpose. `suppressesOwnRoutine` already
  // requires `blocksKnown`, so a spawn with an unreadable `blocks` key falls
  // through to here rather than being silently graded durable.
  if (!originKind) {
    return {
      klass: ROW_CLASS.UNCLASSIFIABLE,
      status: null,
      why:
        'the payload carries NO `originKind` (absent or null), so this row cannot be told apart from a routine ' +
        'spawn. Writing `todo` on a spawn switches its routine off and writing `done` on durable work destroys it, ' +
        'so NEITHER is sent. Measured 2026-08-26: the item route populates this field (`manual`, ' +
        '`routine_execution`, `task_watchdog_product_bug` all observed live), so a null here is a real unknown on ' +
        'this row, not a uniformly unread field.',
    };
  }
  if (originKind === 'routine_execution' && !blocksKnown) {
    return {
      klass: ROW_CLASS.UNCLASSIFIABLE,
      status: null,
      why:
        'a `routine_execution` spawn whose `blocks` key is ABSENT. Absent is not empty: this row may be gating a ' +
        'subtree, in which case `done` buries it, or it may be gating nothing, in which case `todo` switches its ' +
        'routine off. The one thing that decides between them could not be read, so nothing is sent.',
    };
  }

  return {
    klass: ROW_CLASS.DURABLE_STRAND,
    status: 'todo',
    why:
      `originKind=\`${originKind}\` -- durable work, not a per-fire spawn` +
      (originKind === 'routine_execution' ? ` (it is a spawn, but it GATES ${f.blocksIdentifiers.join(', ')})` : '') +
      '. `todo` is queue-visible AND still counts as an unresolved blocker upstream, so any parent stays correctly ' +
      'blocked and no unrun work is destroyed.',
  };
}

/* ------------------------------------------------------------------ *
 * The write-body guard — graded on what we SEND
 * ------------------------------------------------------------------ */

/**
 * Pure. Every request body goes through this before it reaches the network, and
 * a rejection THROWS rather than skipping the row: a body this function does
 * not recognise means the caller changed and the change was not reviewed here.
 *
 * The one sanctioned wire body is the `drain` step: a PATCH carrying exactly
 * `status` + `comment` (TRA-4043 — one atomic cross-issue write per row). It
 * is graded by composing the two single-purpose graders below, which survive
 * as units so the class gate and the ASCII gate stay independently pinned.
 * Anything else — a third key, a blocker-key write, an assignee write — is a
 * defect.
 *
 * TRA-4063 — the sanctioned STATUS is class-dependent, so the class is an
 * argument, not an assumption. The three status branches are mutually
 * exclusive on purpose:
 *
 *   klass omitted           `todo` AND `done` both refused. A caller that did
 *                           not classify does not get the old default.
 *   DURABLE_STRAND          `todo` only. `done` destroys unrun work.
 *   SUPPRESSING_LEAF        `done` only. `todo` is NON-TERMINAL and leaves the
 *                           spawn's own routine switched off, which is the
 *                           whole defect -- so it is an ERROR here, not a
 *                           merely-suboptimal write.
 */
export function gradeWriteBody(step, body, { klass = null } = {}) {
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

  // TRA-4041: the `assignee` step is REFUSED, not merely unused. Deleting the
  // call site alone would let a future edit re-add it silently; this makes the
  // re-add throw at the send, and go red in the controls. Checked BEFORE the
  // per-step branches so that smuggling the key onto the status body fails with
  // THIS reason, not with a generic arity complaint that hides the why.
  if (step === 'assignee' || keys.includes('assigneeAgentId')) {
    return bad(
      'writes `assigneeAgentId`. That step is BANNED (TRA-4041): the status PATCH spawns a run that takes the ' +
        'issue checkout lock, so this write returns `409 Issue run ownership conflict` -- 6/6, measured ' +
        '2026-08-26 -- on a row the status PATCH had ALREADY repaired. It is unexecutable in either order and it ' +
        'was never load-bearing: the status write alone clears the strand. The re-home is the platform\'s.',
    );
  }

  // TRA-4043 — the combined wire body: exactly {status, comment}, graded by
  // composing the two single-purpose graders so neither gate loosens. The
  // blocker-key and assignee bans above already ran against the full key set.
  if (step === 'drain') {
    if (keys.length !== 2 || !keys.includes('status') || !keys.includes('comment')) {
      return bad(`expected exactly {"status","comment"} (TRA-4043 one-write body), got {${keys.join(',')}}`);
    }
    const c = gradeWriteBody('comment', { body: body.comment }, { klass });
    if (!c.ok) return bad(c.why);
    const s = gradeWriteBody('status', { status: body.status }, { klass });
    if (!s.ok) return bad(s.why);
    return { ok: true };
  }

  if (step === 'status') {
    if (keys.length !== 1 || keys[0] !== 'status') return bad(`expected exactly {"status"}, got {${keys.join(',')}}`);

    // TRA-4063 — refused BEFORE either per-class branch, so a caller that
    // skipped classification cannot inherit the pre-4063 default. The old
    // default was `todo` for everything, and that default is the bug.
    if (klass !== ROW_CLASS.DURABLE_STRAND && klass !== ROW_CLASS.SUPPRESSING_LEAF) {
      return bad(
        `carries no row class (got \`${klass || 'none'}\`), and the sanctioned status DEPENDS on it (TRA-4063): ` +
          '`todo` for a DURABLE_STRAND, `done` for a SUPPRESSING_LEAF. Guessing either way switches a routine off ' +
          'or destroys unrun work, so an unclassified row is not written at all.',
      );
    }

    if (klass === ROW_CLASS.SUPPRESSING_LEAF) {
      if (body.status === 'done') return { ok: true };
      return bad(
        `would write \`${body.status}\` on a SUPPRESSING LEAF. Only \`done\` is sanctioned for this class: a ` +
          'per-fire `routine_execution` spawn that gates nothing is treated by its own routine as STILL RUNNING ' +
          'while it rests non-terminal, so `todo` leaves that routine OFF with nextRunAt still advancing. This is ' +
          'an error, not a lesser write -- it is the exact defect TRA-4063 was filed for.',
      );
    }

    if (body.status === 'done') {
      return bad(
        'would write `done` on a DURABLE_STRAND, which DESTROYS unrun work. The restore is `todo` and only `todo`. ' +
          '`done` is reachable ONLY for a SUPPRESSING_LEAF (TRA-4063), where terminal rest is the class rule.',
      );
    }
    if (body.status !== 'todo') {
      return bad(
        `would write \`${body.status}\`. Only \`todo\` is sanctioned: \`in_progress\` is what the reconciler mints ` +
          'strands FROM, so a literal restore re-strands the leaf on the next pass.',
      );
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

/**
 * TRA-4145 — ASCII-fold EXTERNALLY-SOURCED text at the interpolation site.
 *
 * A routine title is written by whoever named the routine; nobody naming one
 * knows they are writing into a body `gradeWriteBody` grades ASCII-only. On
 * 2026-08-27 an em dash in an origin title made the drain refuse its OWN
 * audit comment, and because the comment goes first the row got NEITHER
 * write — the exact suppressing-leaf outcome the drain exists to clear. The
 * fix is here, not in the guard: mojibake in a permanent audit trail is the
 * thing the guard exists to stop, so it stays exactly as strict.
 *
 * Common typographic characters fold to their ASCII spelling; anything else
 * above 0x7E becomes a printed `(U+XXXX)` escape, so the trail still says
 * WHAT was there rather than dropping it.
 */
const ASCII_FOLD_MAP = new Map([
  ['—', '--'], // em dash -- the measured offender (TRA-4083 / TRA-4089)
  ['–', '--'], // en dash
  ['‘', "'"], // left single quote
  ['’', "'"], // right single quote / apostrophe
  ['“', '"'], // left double quote
  ['”', '"'], // right double quote
  ['…', '...'], // ellipsis
  [' ', ' '], // no-break space
]);

export function asciiFold(s) {
  if (typeof s !== 'string') return s;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x20 && cp <= 0x7e) || ch === '\n' || ch === '\r' || ch === '\t') {
      out += ch;
      continue;
    }
    const mapped = ASCII_FOLD_MAP.get(ch);
    out += mapped !== undefined ? mapped : `(U+${cp.toString(16).toUpperCase().padStart(4, '0')})`;
  }
  return out;
}

/** A per-body fold that REMEMBERS whether it changed anything, so the body can say so. */
const foldTracker = () => {
  const fold = (s) => {
    const out = asciiFold(s);
    if (out !== s) fold.changed = true;
    return out;
  };
  fold.changed = false;
  return fold;
};

const FOLD_NOTE =
  'NOTE (TRA-4145): non-ASCII characters in externally-sourced text above (routine title or platform field ' +
  'values) were ASCII-FOLDED at the interpolation site, because this platform grades comment bodies ASCII-only. ' +
  'The live records are unmodified; unmapped characters are printed as (U+XXXX) escapes.';

/**
 * Render the ORIGIN ROUTINE sentence for a suppressing leaf (TRA-4063).
 *
 * `origin` is a best-effort read. It is NEVER a classification input -- the
 * class was already decided off the issue payload -- so an unread routine
 * degrades this sentence to UNREAD and changes no write. It must still be
 * printed either way: "the routine this write is keeping alive" is the single
 * fact that makes a `done` on an automated writer auditable after the fact.
 *
 * TRA-4145 — every field of `origin` is externally controlled text and is
 * folded HERE, at the interpolation site. The policy BRANCH below still reads
 * the raw value: folding is display-only and must never steer a comparison.
 */
export function originSentence(f, origin) {
  const fold = foldTracker();
  const id = fold(f.originId || '(no originId on the payload)');
  let s;
  if (!origin) {
    s =
      `Origin routine \`${id}\` -- UNREAD (the routines route was not queried or did not answer). The class was ` +
      'decided from this issue\'s own `originKind` + `blocks`, which is why an unread routine does not change the ' +
      'write. Its concurrencyPolicy is therefore UNKNOWN here, and under BOTH known policies (skip_if_active, ' +
      'coalesce_if_active) a non-terminal leaf suppresses the next fire.';
  } else if (origin.unread) {
    s = `Origin routine \`${id}\` -- UNREAD: ${fold(origin.unread)}. Same note as above: the class did not depend on it.`;
  } else {
    s =
      `Origin routine \`${id}\` = "${fold(origin.title || '(untitled)')}", status \`${fold(origin.status || 'unknown')}\`, ` +
      `concurrencyPolicy \`${fold(origin.concurrencyPolicy || 'unknown')}\`, owner \`${fold(origin.assigneeAgentId || 'none')}\`. ` +
      'That policy is why this row gets `done`: a fire landing while THIS execution issue is still open is ' +
      (origin.concurrencyPolicy === 'skip_if_active'
        ? 'DROPPED outright'
        : origin.concurrencyPolicy === 'coalesce_if_active'
          ? 'MERGED into it instead of running'
          : 'suppressed') +
      ', so resting this leaf non-terminal switches that routine OFF while its nextRunAt keeps advancing.';
  }
  return fold.changed ? `${s} [${FOLD_NOTE}]` : s;
}

/**
 * The discharge sentence for a suppressing-leaf `done` (TRA-4817).
 *
 * A `done` on this class is warranted by the CLASS, but what the close RECORDS
 * depends on whether the fire's work discharged -- and that is read from the
 * thread by sweep() (`f.discharge`), never asserted off the payload. TRA-4804:
 * the payload said `previousStatus: in_progress` / `completedAt: null` while
 * the fire's owner had published the verdict 26s before the recovery park;
 * "already terminal" was a false claim, the thread held the true one. The
 * fixtures (and any caller outside sweep) may hand an `f` with no `discharge`
 * key at all -- that degrades to the not-scanned arm, never a throw.
 */
export function dischargeSentence(f, fold = (x) => x) {
  const d = f.discharge || null;
  if (d && d.state === 'FOUND') {
    return (
      `Discharge evidence IN-THREAD: newest non-system comment by \`${fold(String(d.authorAgentId || 'a user'))}\` ` +
      `at ${fold(String(d.at))}` +
      (d.beforePark === true
        ? ` (${fold(String(d.gapText))} BEFORE the recovery park)`
        : d.beforePark === false
          ? ' (AFTER the recovery park)'
          : '') +
      '. If that comment is the fire\'s published verdict, only the terminal status write was lost with the run ' +
      'and this `done` buries nothing. Cited, not asserted: the payload\'s own previousStatus is non-terminal and ' +
      'proves nothing either way (TRA-4817).'
    );
  }
  const why = !d
    ? 'the discharge scan did not run on this row'
    : d.state === 'UNREAD'
      ? `thread UNREAD: ${fold(String(d.detail || 'no detail'))}`
      : 'no non-system comment exists in the thread';
  return (
    `NO discharge evidence to cite (${why}) -- this \`done\` rests on the CLASS RULE alone, NOT on any claim the ` +
    'work finished. If the fire\'s read never happened, this close records NOT RUN, not a completed read (TRA-4817).'
  );
}

/**
 * The audit comment. ASCII only, and written BEFORE the row leaves our boundary.
 *
 * TRA-4145 — platform-sourced field values (`recoveryKind`, `originKind`,
 * `evidence.previousStatus`, agent ids) are folded at their interpolation
 * sites, same as the origin routine fields: they are the same shape of risk
 * as the title, just not yet the measured offender.
 */
export function drainComment(f, runId, disp = null, origin = null) {
  const rep = f.repair;
  const d = disp || classifyDisposition(f);
  const fold = foldTracker();
  const withFoldNote = (body) => (fold.changed ? `${body}\n\n${FOLD_NOTE}` : body);
  if (d.klass === ROW_CLASS.SUPPRESSING_LEAF) {
    return withFoldNote(
      `Automated strand drain (TRA-3541), SUPPRESSING LEAF branch (TRA-4041 / TRA-4063). This row was \`blocked\` ` +
      `with an EMPTY \`blockedBy\` and carried an active \`${fold(f.recoveryKind)}\` recovery action, which is the ` +
      `platform's terminal-run recovery writing the block -- no agent ever intended an anchor.\n\n` +
      `CLASS: SUPPRESSING LEAF. ${d.why}\n\n` +
      `${originSentence(f, origin)}\n\n` +
      `Read live immediately before this write: status \`blocked\`, \`blockedBy\` empty, \`blocks\` READ and EMPTY ` +
      `(absent would NOT have counted), \`originKind\` \`${fold(f.originKind)}\`, pendingInteractions 0 (a KNOWN zero, ` +
      `not an unread route), \`evidence.previousStatus\` \`${fold(rep.restoredFrom)}\`, \`returnOwnerAgentId\` ` +
      `\`${fold(rep.assigneeAgentId)}\`.\n\n` +
      `Repair applied -- ONE write (TRA-4041):\n` +
      `- PATCH status -> \`done\`. THIS IS THE \`done\` BRANCH, taken deliberately and taken only for this class. ` +
      `The generic restore for this cohort is \`todo\`, and \`todo\` here would be the defect: it is non-terminal, ` +
      `so the origin routine would keep treating this fire as live and would never run again.\n` +
      `- ${dischargeSentence(f, fold)}\n` +
      `- \`blockedByIssueIds\` deliberately NOT re-sent.\n` +
      `- assigneeAgentId deliberately NOT written. The recovery payload names \`${fold(rep.assigneeAgentId)}\` as the ` +
      `returnOwnerAgentId; the status write above spawns a run that takes this issue's checkout lock, so any ` +
      `further PATCH returns 409 Issue run ownership conflict (6/6, measured). The re-home is the platform's.\n\n` +
      `If this classification is wrong, the recoverable direction is to reopen this row -- not to re-drain it. ` +
      `This comment rides in the SAME PATCH as the status write (TRA-4043): one atomic cross-issue write, so a budget cut-off can never leave this row half-written.\n\n` +
      `Drained by scripts/drain-blocked-empty.mjs${runId ? ` (run ${runId})` : ''}.`
    );
  }
  return withFoldNote(
    `Automated strand drain (TRA-3541). This row was \`blocked\` with an EMPTY \`blockedBy\` and carried an ` +
    `active \`${fold(f.recoveryKind)}\` recovery action, which is the platform's terminal-run recovery writing the ` +
    `block -- no agent ever intended an anchor. That state fails the TRA-1272 STRAND TEST and raises no blocker ` +
    `wake, so nothing drains it on its own.\n\n` +
    `Read live immediately before this write: status \`blocked\`, \`blockedBy\` empty, pendingInteractions 0 ` +
    `(a KNOWN zero, not an unread route), \`evidence.previousStatus\` \`${fold(rep.restoredFrom)}\`, ` +
    `\`returnOwnerAgentId\` \`${fold(rep.assigneeAgentId)}\`.\n\n` +
    `Repair applied -- ONE write (TRA-4041):\n` +
    `- PATCH status -> \`todo\` (NOT \`done\`: \`todo\` is queue-visible and still counts as an unresolved ` +
    `blocker upstream, so any parent stays correctly blocked and no unrun work is destroyed)\n` +
    `- \`blockedByIssueIds\` deliberately NOT re-sent.\n` +
    `- assigneeAgentId deliberately NOT written. The recovery payload names \`${fold(rep.assigneeAgentId)}\` as the ` +
    `returnOwnerAgentId, and until 2026-08-26 this drain PATCHed it as a second step. That step cannot succeed: ` +
    `the status write above spawns a run that takes this issue's checkout lock, so any further PATCH returns ` +
    `409 Issue run ownership conflict (6/6, measured). It is also unnecessary -- the status write alone clears ` +
    `the recovery action. If this row is homed on the wrong seat, that re-home is the platform's to make.\n\n` +
    `No content judgement was made on the underlying work; the strand is cleared and the ticket is queue-visible ` +
    `again. This comment rides in the SAME PATCH as the status write (TRA-4043): one atomic cross-issue write, so a budget cut-off can never leave this row half-written.\n\n` +
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
    // TRA-4063 — the LAST gate before a row becomes writable, and the only one
    // that decides WHICH status it gets. A row the class cannot decide leaves
    // here, unwritten, and colours the exit.
    const disp = classifyDisposition(f);
    if (disp.klass === ROW_CLASS.UNCLASSIFIABLE) {
      rows.push({ f, action: ACTION.SKIP_UNCLASSIFIABLE, disp, why: disp.why });
      continue;
    }
    rows.push({ f, action: ACTION.DRAIN, disp, why: `${rep.why}\n           class ${disp.klass}: ${disp.why}` });
  }

  const by = (a) => rows.filter((r) => r.action === a);
  const drainRows = by(ACTION.DRAIN);
  return {
    rows,
    drain: drainRows,
    counts: {
      findings: (result.findings || []).length,
      shape1: (result.findings || []).filter((f) => f.shape === SHAPE.EMPTY_BLOCKED_BY).length,
      drain: drainRows.length,
      excluded: by(ACTION.SKIP_EXCLUDED).length,
      shape2: by(ACTION.SKIP_SHAPE_2).length,
      ineligible: by(ACTION.SKIP_INELIGIBLE).length,
      notSelected: by(ACTION.SKIP_NOT_SELECTED).length,
      // Broken out rather than folded into `drain`: a fire that dispositioned
      // five routine spawns is a different event from one that restored five
      // strands, and a single count renders them identically.
      unclassifiable: by(ACTION.SKIP_UNCLASSIFIABLE).length,
      suppressingLeaf: drainRows.filter((r) => r.disp.klass === ROW_CLASS.SUPPRESSING_LEAF).length,
      durableStrand: drainRows.filter((r) => r.disp.klass === ROW_CLASS.DURABLE_STRAND).length,
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
  // TRA-4041 — a live run holds the row's checkout lock. Ours, not foreign;
  // transient, not a rejection. Retryable by the NEXT fire, not by this one.
  RUN_LOCKED: 'RUN_LOCKED',
  // TRA-4063 — the class could not be decided, so no status is safe. Its own
  // outcome and not WRITE_FAILED: nothing was rejected, nothing was attempted.
  UNCLASSIFIABLE: 'UNCLASSIFIABLE',
  // TRA-4043 — the per-run cross-issue write budget was (or would have been)
  // exhausted, so this row got ZERO writes. NOT a failure of any kind: the row
  // is healthy, still blocked+empty, still inside the detector cohort, and the
  // budget resets per run so the NEXT fire drains it. Folding this into
  // WRITE_FAILED is the fabricated-finding defect this ticket was filed for.
  NOT_ATTEMPTED_BUDGET: 'NOT_ATTEMPTED_BUDGET',
  // TRA-4299 — 403 cross_issue_influence_run_context_required is transient
  // early-run state, not a permission verdict. Retried once; if it persists,
  // this outcome. Not FOREIGN (the row may well be ours) and not FAILED
  // (nothing landed, nothing broke) — the next fire retries with context.
  RUN_CONTEXT_DEFERRED: 'RUN_CONTEXT_DEFERRED',
};

// TRA-4299 — checked BEFORE the boundary test, because `isBoundary403` matches
// any "403" and this 403 is transient run state, not a permission verdict.
const isRunContext403 = (err) => /cross_issue_influence_run_context_required/i.test(String(err?.message || err));

// TRA-4043 — the per-run cross-issue write cap. Matched on the error code, with
// the human text as fallback; a bare 429 without either is NOT assumed to be
// the cap (a different throttle must not silently defer the cohort).
const isBudgetCap429 = (err) => {
  const s = String(err?.message || err);
  return /cross_issue_influence_cap_exceeded/i.test(s) || (/\b429\b/.test(s) && /cross-issue write budget/i.test(s));
};

const isBoundary403 = (err) =>
  !isRunContext403(err) &&
  (/\b403\b/.test(String(err?.message || err)) || /authorization boundary/i.test(String(err?.message || err)));

/**
 * TRA-4041. `409 Issue run ownership conflict` is a THIRD thing, and it must not
 * be folded into either of the other two.
 *
 * It is not the authorization boundary (403) -- the row IS ours, and no twin arm
 * on another seat can drain it either, so reporting FOREIGN would send it to a
 * queue that cannot help. And it is not WRITE_FAILED in the useful sense of "the
 * write was rejected": it means a live run holds this row's checkout lock right
 * now, which the NEXT fire will very likely not hit. Distinct outcome, its own
 * sentence, and it colours REMAINDER (somebody should look) rather than FAILED.
 */
const isRunLock409 = (err) => {
  const s = String(err?.message || err);
  return /\b409\b/.test(s) || /run ownership conflict/i.test(s);
};

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
export async function drainRow(
  transport,
  row,
  { apply = false, runId = null, budget = null, runContextRetryMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  const f = row.f;
  const rep = f.repair;
  const disp = row.disp || classifyDisposition(f);
  const steps = [];

  // TRA-4063 — belt and braces. `planDrain` already routed UNCLASSIFIABLE rows
  // away from here, but `drainRow` is exported and callable directly, and the
  // one thing this class must never do is fall through to a default status.
  if (disp.klass === ROW_CLASS.UNCLASSIFIABLE || !disp.status) {
    return { outcome: OUTCOME.UNCLASSIFIABLE, steps, disp, why: disp.why };
  }

  // TRA-4043 — the budget gate, BEFORE any network call for this row. A row
  // that cannot afford its single write is not attempted at all: zero writes,
  // zero reads, a distinct outcome, and NO entry in the failure count. The
  // dry run is exempt on purpose: it sends nothing, so it plans the whole
  // cohort regardless of budget.
  if (apply && budget && (budget.exhausted || budget.spent + 1 > budget.cap)) {
    return {
      outcome: OUTCOME.NOT_ATTEMPTED_BUDGET,
      steps,
      disp,
      why:
        `not attempted: the per-run cross-issue write budget is ` +
        `${budget.exhausted ? 'exhausted (a live 429 said so)' : `spent (${budget.spent}/${budget.cap} attempts counted)`} ` +
        'and this row costs 1 write. Nothing was sent -- the row is untouched, still blocked+empty, still inside ' +
        'the detector cohort. The budget resets per run, so the next fire drains it (TRA-4043).',
    };
  }

  // Best-effort, and BEFORE the comment so the audit trail can name it. Failing
  // this read is not failing the row: the class was decided off the issue
  // payload, so an unreachable routines route degrades one sentence and nothing
  // else. Pinned that way deliberately -- a report read that can veto a write
  // is a fourth unknown, and unknowns here refuse to write.
  let origin = null;
  if (disp.klass === ROW_CLASS.SUPPRESSING_LEAF && f.originId && typeof transport.getRoutine === 'function') {
    try {
      const r = await transport.getRoutine(f.originId);
      const body = r && r.routine ? r.routine : r;
      origin = body
        ? {
            title: body.title || body.name || null,
            status: body.status || null,
            concurrencyPolicy: body.concurrencyPolicy || null,
            assigneeAgentId: body.assigneeAgentId || null,
          }
        : { unread: 'the routines route returned nothing' };
    } catch (err) {
      origin = { unread: String(err?.message || err).slice(0, 160) };
    }
  }

  // TRA-4043 — ONE write: the comment rides in the same PATCH as the status,
  // so the row either drains whole or is untouched. It still mints a live
  // status, spawns a run and takes the checkout lock (TRA-4041), so nothing
  // may follow it.
  const wireBody = { status: disp.status, comment: drainComment(f, runId, disp, origin) };
  const graded = gradeWriteBody('drain', wireBody, { klass: disp.klass });
  if (!graded.ok) {
    // Not a skip. The caller built a body this file does not sanction, which
    // is a code defect, and continuing would write it.
    throw new Error(`REFUSED to send an unsanctioned drain body -- ${graded.why}`);
  }
  steps.push({ step: 'drain', body: wireBody, sent: apply });

  if (apply) {
    let err = null;
    // One bounded retry, for the TRA-4299 transient 403 only.
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      // Attempts are counted, not just landings: whether the platform bills a
      // refused write is unmeasured, and UNDERSTATING spend is the failure
      // mode that manufactured 19 fabricated WRITE_FAILED rows on 2026-08-26.
      // The live 429 below is authoritative in both directions.
      if (budget) budget.spent += 1;
      try {
        await transport.patchIssue(f.id, wireBody);
        err = null;
        break;
      } catch (e) {
        err = e;
        if (isBudgetCap429(e)) {
          if (budget) {
            budget.spent -= 1; // the rejected write did not land, so it did not spend
            budget.exhausted = true;
          }
          return {
            outcome: OUTCOME.NOT_ATTEMPTED_BUDGET,
            steps,
            disp,
            why:
              "the platform returned 429 cross_issue_influence_cap_exceeded on this row's single write: the " +
              'surrounding run had already spent the cross-issue budget (a local counter cannot see writes made ' +
              'before this script started). The write was REJECTED whole, not half-applied -- the row is untouched, ' +
              'still inside the detector cohort, and drains on the next fire with a fresh budget (TRA-4043).',
          };
        }
        if (isRunContext403(e) && attempt === 0) {
          await sleep(runContextRetryMs);
          continue;
        }
        break;
      }
    }
    if (err) {
      if (isRunContext403(err)) {
        return {
          outcome: OUTCOME.RUN_CONTEXT_DEFERRED,
          steps,
          disp,
          why:
            '403 cross_issue_influence_run_context_required on the drain write, twice (one bounded retry after ' +
            `${runContextRetryMs}ms). This is TRANSIENT early-run state, not a permission verdict (TRA-4299: a ` +
            'byte-identical retry succeeded minutes later in the same run), so it is NOT reported FOREIGN and NOT a ' +
            'write failure. Nothing landed; the next fire retries with run context established.',
        };
      }
      if (isRunLock409(err)) {
        return {
          outcome: OUTCOME.RUN_LOCKED,
          steps,
          disp,
          why:
            '409 Issue run ownership conflict on the drain write -- a live run already holds this row\'s checkout ' +
            'lock, so this actor\'s run id does not match its executionRunId. The row IS ours (this is not the 403 ' +
            'boundary and no other seat\'s arm can take it), and nothing was half-written: the single combined write ' +
            'was rejected whole. Leave it: the next fire runs against a row whose run has ended.',
        };
      }
      if (isBoundary403(err)) {
        return {
          outcome: OUTCOME.FOREIGN,
          steps,
          disp,
          why:
            '403 outside this actor\'s authorization boundary on the drain write. This row is currently assigned ' +
            `to ${f.assigneeName || f.assigneeAgentId || 'nobody'} and only that seat can drain it. Rank does not ` +
            "lift the boundary and there is no predictor for it -- this is the twin arm's row, not a retry. Nothing " +
            'was half-written: the single combined write was rejected whole.',
        };
      }
      return { outcome: OUTCOME.WRITE_FAILED, steps, disp, why: String(err?.message || err) };
    }
  }

  if (!apply) {
    return {
      outcome: OUTCOME.PLANNED,
      steps,
      disp,
      why: `dry run -- nothing was sent. Class ${disp.klass}, would write \`${disp.status}\``,
    };
  }

  // Verify by VALUE, not by the 2xx. A PATCH that returns 200 and does not
  // stick is the failure mode a status-code check cannot see.
  let after;
  try {
    after = await transport.getIssue(f.id);
  } catch (err) {
    return {
      outcome: OUTCOME.NOT_VERIFIED,
      steps,
      disp,
      why: `both writes returned ok but the re-read threw (${String(err?.message || err)}) -- the repair is UNPROVEN`,
    };
  }
  const problems = [];
  // ⛔ TRA-4041 — the pass predicate is `status != blocked AND
  // activeRecoveryAction == null`, NOT `status === 'todo'`.
  //
  // The strand IS the recovery action; the status word is only its symptom. And
  // the write does not reliably STORE `todo`: on a row the queue picks up
  // immediately the re-read comes back `in_progress` (TRA-3758, live). Asserting
  // the literal `todo` would have called that row NOT_VERIFIED and coloured the
  // fire FAILED over a drain that worked. What must never be true afterwards is
  // that the row is still `blocked`, or still carries a live recovery action.
  if (after.status === 'blocked') {
    problems.push(`status is \`${after.status}\`, expected anything but \`blocked\` (asked for \`${disp.status}\`)`);
  }
  // TRA-4063 — and for a SUPPRESSING LEAF that is not enough. The point of the
  // `done` branch is TERMINALITY: the origin routine treats any non-terminal
  // leaf as still running. A row that read back `todo` or `in_progress` here
  // would clear the recovery action and leave the routine off -- a green drain
  // over an unfixed defect, which is the failure this whole class is about. So
  // this class asserts the LITERAL terminal status, unlike the durable one
  // where a queue pickup to `in_progress` is a clean drain (TRA-3758).
  if (disp.klass === ROW_CLASS.SUPPRESSING_LEAF && !TERMINAL_STATUSES.has(after.status)) {
    problems.push(
      `SUPPRESSING LEAF read back \`${after.status}\`, which is NOT terminal (${[...TERMINAL_STATUSES].join('/')}). ` +
        'The strand may have cleared, but the origin routine still sees an open execution issue and stays OFF. ' +
        'Terminality IS the repair for this class, so a non-terminal read-back is NOT a drain',
    );
  }
  if (!Object.prototype.hasOwnProperty.call(after, 'activeRecoveryAction')) {
    problems.push(
      "the re-read carries no 'activeRecoveryAction' key, so the drain cannot be verified -- absent is not cleared",
    );
  } else if (after.activeRecoveryAction && after.activeRecoveryAction.status !== 'resolved') {
    problems.push(
      `activeRecoveryAction is STILL live (\`${after.activeRecoveryAction.kind}\`` +
        `${after.activeRecoveryAction.status ? `:${after.activeRecoveryAction.status}` : ''}) -- the status moved but ` +
        'the strand did not clear, which is the one failure a status-only check cannot see',
    );
  }
  // NOT verified: assigneeAgentId. Nothing here writes it any more (TRA-4041),
  // so asserting the return owner would fail every genuinely drained row.
  // The blocker key must be untouched and still empty. If something re-populated
  // it, the row was not drained, it was re-blocked, and reporting DRAINED would
  // be a false green.
  if (!Object.prototype.hasOwnProperty.call(after, 'blockedBy')) {
    problems.push("the re-read carries no 'blockedBy' key, so the drain cannot be verified (absent is not empty)");
  } else if (Array.isArray(after.blockedBy) && after.blockedBy.length !== 0) {
    problems.push(`blockedBy is no longer empty (${after.blockedBy.length} entr(ies)) -- this row was re-blocked`);
  }
  if (problems.length) return { outcome: OUTCOME.NOT_VERIFIED, steps, disp, why: problems.join('; ') };

  return {
    outcome: OUTCOME.DRAINED,
    steps,
    disp,
    why:
      `verified by re-read: status \`${after.status}\`, activeRecoveryAction null. Class ${disp.klass}, wrote ` +
      `\`${disp.status}\`${disp.klass === ROW_CLASS.SUPPRESSING_LEAF ? ' (the TRA-4063 `done` branch, taken)' : ''}. ` +
      `Return owner ${rep.assigneeAgentId} was READ and NOT written (TRA-4041).`,
  };
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
  // TRA-4043 — NOT_ATTEMPTED_BUDGET is deliberately absent from this filter.
  // A budget-deferred row got zero writes against zero boundaries; folding it
  // into the failure count is the fabricated-finding defect this exit table
  // exists to prevent.
  const bad = results.filter((r) => r.outcome === OUTCOME.WRITE_FAILED || r.outcome === OUTCOME.NOT_VERIFIED);
  if (bad.length) return 'FAILED';
  // RUN_LOCKED joins FOREIGN here rather than FAILED (TRA-4041): nothing was
  // half-written and nothing is broken, but a row was not drained and the next
  // fire has to pick it up, so it must not read as a clean DRAINED either.
  // TRA-4063 — UNCLASSIFIABLE joins them for the same reason. A row whose class
  // could not be decided is a row nobody has drained, and the SAFE refusal is
  // only safe if it is also LOUD: a silent skip would read as a clean fire on a
  // board that still has the strand.
  // TRA-4299 — RUN_CONTEXT_DEFERRED joins them too: transient, nothing landed,
  // but the rows are undrained and must not read green.
  const unowned =
    plan.counts.ineligible +
    plan.counts.unclassifiable +
    results.filter(
      (r) =>
        r.outcome === OUTCOME.FOREIGN ||
        r.outcome === OUTCOME.RUN_LOCKED ||
        r.outcome === OUTCOME.UNCLASSIFIABLE ||
        r.outcome === OUTCOME.RUN_CONTEXT_DEFERRED,
    ).length;
  if (unowned > 0) return 'REMAINDER';
  // TRA-4043 — after FAILED and REMAINDER, so a fire that both drained and
  // deferred reads DEFERRED (still exit 1), and a fire with real failures
  // still reads FAILED. Deferred rows have a named owner -- the NEXT fire --
  // which is why this outranks nothing above it.
  if (results.some((r) => r.outcome === OUTCOME.NOT_ATTEMPTED_BUDGET)) return 'DEFERRED';
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

  // TRA-4043 — one shared budget for the whole fire. `spentBefore` is what the
  // surrounding heartbeat run already spent (the cap is per RUN, not per
  // script); `spent` counts this script's attempts on top of it.
  const spentBefore = Number(opts.budgetSpent ?? 0);
  const budget = {
    cap: Number(opts.budgetCap ?? BUDGET_DEFAULT_CAP),
    spentBefore,
    spent: spentBefore,
    exhausted: false,
  };

  const results = [];
  // TRA-4299 — two consecutive persistent run-context refusals mean the run
  // context is simply absent; further attempts spend budget for nothing.
  let consecutiveRunContext = 0;
  for (const row of plan.drain) {
    // Deliberately serial. These are writes against a live board; a fan-out
    // buys nothing on a cohort this size and makes a partial failure harder to
    // read back.
    let r;
    if (consecutiveRunContext >= 2) {
      r = {
        outcome: OUTCOME.RUN_CONTEXT_DEFERRED,
        steps: [],
        disp: row.disp,
        why:
          'not attempted: the two preceding rows were both refused 403 cross_issue_influence_run_context_required ' +
          '(each retried once), so run context is absent for this run and further attempts spend budget for ' +
          'nothing. Transient (TRA-4299); the next fire retries with context established.',
      };
    } else {
      r = await drainRow(transport, row, {
        apply,
        runId: opts.runId || null,
        budget,
        runContextRetryMs: opts.runContextRetryMs ?? 3000,
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
      });
    }
    consecutiveRunContext = r.outcome === OUTCOME.RUN_CONTEXT_DEFERRED ? consecutiveRunContext + 1 : 0;
    results.push({
      ...r,
      identifier: row.f.identifier || row.f.id,
      id: row.f.id,
      repair: row.f.repair,
      // TRA-4063 — carried so the report can NAME the routine each `done` keeps
      // alive without re-reading the sweep.
      originId: row.f.originId || null,
      originKind: row.f.originKind || null,
    });
  }

  return {
    verdict: verdictFor({ blind: null, plan, results }),
    blind: null,
    sweep: result,
    plan,
    results,
    apply,
    budget,
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
      `${c.shape2} shape-2 (out of scope)${c.notSelected ? ` | ${c.notSelected} not selected` : ''}` +
      `${c.unclassifiable ? ` | ${c.unclassifiable} UNCLASSIFIABLE` : ''}`,
  );
  // TRA-4063 — printed on EVERY fire, including the fires where it is 0. The
  // split is the thing that was missing when the drain planned `-> todo` for a
  // live detector's spawn, and a count that only appears when it is non-zero
  // teaches nobody to look for it.
  L.push(
    `class     ${c.durableStrand} DURABLE STRAND -> todo | ${c.suppressingLeaf} SUPPRESSING LEAF -> done ` +
      `(TRA-4063: a routine_execution spawn gating nothing; todo would leave its routine OFF)`,
  );
  // TRA-4043 — printed on EVERY fire, including the ones nowhere near the cap.
  // The 2026-08-26 fire had no line like this, which is how a hard 6-row
  // ceiling stayed invisible until it manufactured 20 fake write failures.
  if (out.budget) {
    const b = out.budget;
    L.push(
      `budget    per-run cross-issue cap ${b.cap} | ${b.spentBefore} declared pre-spent | 1 write/row -> ` +
        `row ceiling ${Math.max(0, b.cap - b.spentBefore)} | ` +
        (out.apply
          ? `${b.spent - b.spentBefore} attempt(s) counted this fire${b.exhausted ? ' | CAP HIT (live 429)' : ''}`
          : 'dry run, nothing spent'),
    );
  }
  L.push('');

  if (out.verdict === 'DEFERRED') {
    const n = out.results.filter((r) => r.outcome === OUTCOME.NOT_ATTEMPTED_BUDGET).length;
    L.push(`DEFERRED  ${n} row(s) received ZERO writes because the per-run cross-issue write budget ran out.`);
    L.push('          This is a HEALTHY fire, not a failure (TRA-4043): every drained row above is verified,');
    L.push('          every deferred row is untouched and still inside the detector cohort, and the budget');
    L.push('          resets per run -- the next fire continues where this one stopped. Deferred rows are');
    L.push('          NOT write failures and are excluded from the failure count.');
  }

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
    // ⛔ The target status is READ off the row's class, never spelled here.
    // This line was the literal string "-> todo" until TRA-4063, which meant a
    // report control could assert the drain's own intent and still be blind to
    // the one row where that intent was wrong.
    const klass = r.disp ? r.disp.klass : 'UNKNOWN';
    const target = r.disp && r.disp.status ? r.disp.status : 'NOTHING';
    L.push(
      `${mark} ${r.identifier}  -> ${target}  [${klass}]  ` +
        `(return owner ${r.repair.assigneeAgentId} READ, not written -- TRA-4041)`,
    );
    L.push(`         ${r.why}`);
    for (const s of r.steps) L.push(`         ${s.sent ? 'sent' : 'plan'} ${s.step}  ${JSON.stringify(s.body).slice(0, 120)}`);
  }

  // TRA-4063 — the SUPPRESSING LEAF roll-up. Named as a class, with the routine
  // each write is keeping alive, because "an automated writer sent `done`" is
  // the line a reader must be able to find without reconstructing it from the
  // per-row bodies above.
  const leaves = out.results.filter((r) => r.disp && r.disp.klass === ROW_CLASS.SUPPRESSING_LEAF);
  if (leaves.length) {
    L.push('');
    L.push(`SUPPRESSING LEAF  ${leaves.length} row(s) took the \`done\` branch, NOT \`todo\` (TRA-4041 / TRA-4063).`);
    L.push('         Each is a per-fire `routine_execution` spawn whose `blocks` was READ and is EMPTY. Resting one');
    L.push('         non-terminal switches its OWN routine off while nextRunAt keeps advancing and every census');
    L.push('         reads it ARMED. On 2026-08-26T12:30Z this drain planned `-> todo` for TRA-4058, the spawn of');
    L.push('         the `skip_if_active` TRA-4017 armed-liveness detector; only a hand catch stopped it.');
    for (const r of leaves) {
      L.push(`         ${r.identifier}  origin routine ${r.originId || r.repair?.originId || '(none on payload)'}`);
    }
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

const ROUTINE_ID = '82daa7b2-fake';

/**
 * A blocked+empty row carrying a live stranded_assigned_issue payload.
 *
 * TRA-4063 — `originKind` and `blocks` are now part of the DEFAULT shape,
 * because they are part of the live shape: measured 2026-08-26, the item route
 * populates `originKind` on every row (`manual`, `routine_execution` and
 * `task_watchdog_product_bug` all observed) and carries `blocks` as an array.
 * A fake that omitted them made every control take the UNCLASSIFIABLE branch,
 * which would have hidden the drain path behind a suite that still read green.
 * The unknowns are exercised by controls that pass `originKind: undefined` /
 * `blocks: undefined` EXPLICITLY, so the absence is the case under test rather
 * than an accident of the fixture.
 */
const strandRow = (
  id,
  ident,
  {
    kind = 'stranded_assigned_issue',
    previousStatus = 'in_progress',
    returnOwner = AGENT_BACK,
    assignee = AGENT_SELF,
    originKind = 'manual',
    originId = null,
    blocks = [],
    // ⛔ NOT `originKind: undefined`. A JS default parameter fires on
    // `undefined`, so passing it would silently hand the fixture back the
    // DEFAULT `manual` -- the control would read green while testing the exact
    // opposite of the absent-key case it names. Caught by this suite on the
    // first run (TRA-4063). The omission has to be its own flag.
    omitOriginKind = false,
    omitBlocks = false,
  } = {},
) => ({
  id,
  identifier: ident,
  title: `strand ${ident}`,
  status: 'blocked',
  assigneeAgentId: assignee,
  parentId: null,
  blockedBy: [],
  ...(omitOriginKind ? {} : { originKind }),
  originId,
  ...(omitBlocks ? {} : { blocks }),
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
  originKind: 'manual',
  originId: null,
  blocks: [],
  blockedBy: [{ id: 'g1', identifier: 'TRA-7001', status: 'done', assigneeAgentId: AGENT_SELF }],
  activeRecoveryAction: null,
});

/**
 * A transport over a fake board that RECORDS every write and can be told to
 * 403, to lie (2xx that does not stick), or to refuse reads.
 */
function fakeTransport(
  rows,
  {
    pending = {},
    on403 = null,
    on409 = null,
    lieOnPatch = false,
    keepRecovery = false,
    total = 2350,
    routineUnread = false,
    // TRA-4145 — lets a control serve an origin routine whose TITLE carries
    // non-ASCII text, the externally-controlled input that made the drain
    // refuse its own audit body on 2026-08-27.
    routineTitle = 'TRA-4017 armed-liveness detector -- paused routines that read falsely ARMED',
    // TRA-4063 — model a queue that picks the row up and flips it, per
    // TRA-3758. On a DURABLE strand that is still a clean drain; on a
    // SUPPRESSING LEAF it means the leaf never went terminal and the routine is
    // still off, which must NOT read as DRAINED.
    flipTo = null,
    // TRA-4043 — after this many writes have LANDED, every further write
    // attempt 429s with the live cap body. Models the platform's per-run
    // cross-issue budget, which counts the whole run, not just this script.
    capAt = null,
    // TRA-4299 — the first N write attempts throw the transient run-context
    // 403, then attempts succeed. Infinity models a run that never gets
    // context.
    runContext403Times = 0,
  } = {},
) {
  // TRA-4041 — ids whose checkout lock has been taken by the run the status
  // PATCH spawned. Once in here, every further PATCH on that row 409s.
  const locked = new Set();
  const written = new Set();
  const writes = [];
  // TRA-4043 / TRA-4299 — attempts vs landings. `writes` records only what
  // LANDED; `stats.attempts` counts every try, which is what the budget and
  // the retry controls assert on.
  const stats = { attempts: 0 };
  let runContextLeft = runContext403Times;
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
    stats,
    listAgents: async () => [
      { id: AGENT_SELF, name: 'CTO', role: 'cto' },
      { id: AGENT_BACK, name: 'QuantTrader', role: 'quant' },
    ],
    getIssuesPage: async ({ limit, offset }) => all.slice(offset, offset + limit),
    getIssue: async (id) => {
      const r = byId.get(id);
      if (!r) throw new Error(`no such issue ${id}`);
      const copy = JSON.parse(JSON.stringify(r));
      if (flipTo && written.has(id)) copy.status = flipTo;
      return copy;
    },
    // TRA-4063 — the routines route, modelled with the two fields the audit
    // trail names. It is deliberately allowed to THROW: the class must not
    // depend on it, and the control that proves it degrades to UNREAD without
    // changing the write is the one that pins that.
    getRoutine: async (id) => {
      if (routineUnread) throw new Error(`HTTP 500 on GET /api/routines/${id}`);
      return {
        id,
        title: routineTitle,
        status: 'active',
        concurrencyPolicy: 'skip_if_active',
        assigneeAgentId: AGENT_SELF,
      };
    },
    getComments: async () => [],
    getInteractions: async (id) => Array.from({ length: pending[id] || 0 }, () => ({ status: 'pending' })),
    postComment: async (id, body) => {
      if (on403 === 'comment') throw new Error('HTTP 403 — {"error":"Issue is outside this actor\'s authorization boundary"}');
      writes.push({ verb: 'POST', id, body });
      return { ok: true };
    },
    patchIssue: async (id, body) => {
      stats.attempts += 1;
      // TRA-4299 — the transient early-run refusal, thrown before anything
      // else because that is when it happens live.
      if (runContextLeft > 0) {
        runContextLeft -= 1;
        throw new Error(
          'HTTP 403 on PATCH -- {"error":"Cross-issue influence requires an established run context",' +
            '"details":{"code":"cross_issue_influence_run_context_required"}}',
        );
      }
      if (on403 === 'status' && body.status) {
        throw new Error('HTTP 403 — {"error":"Issue is outside this actor\'s authorization boundary"}');
      }
      // TRA-4043 — the per-run cap, on LANDED writes across the whole fake.
      if (capAt != null && writes.length >= capAt) {
        throw new Error(
          'HTTP 429 on PATCH -- {"error":"This run has spent its cross-issue write budget (Per-run cross-issue ' +
            `cap of ${capAt} writes)","details":{"code":"cross_issue_influence_cap_exceeded","cap":${capAt},` +
            `"count":${writes.length + 1},"mode":"enforce"}}`,
        );
      }
      // TRA-4041 — model the run lock the live platform actually takes. The
      // FIRST status PATCH sets checkoutRunId; every PATCH after it on the same
      // row 409s. This is not decoration: it is what made the old third step
      // unexecutable, and without it in the fake, a re-added assignee write
      // would pass the controls exactly as it used to.
      if (locked.has(id) || (on409 === 'status' && body.status)) {
        throw new Error(
          'HTTP 409 — {"error":"Issue run ownership conflict","details":{"checkoutRunId":"a9424370",' +
            '"executionRunId":"a9424370","actorRunId":"d1e6e234"}}',
        );
      }
      writes.push({ verb: 'PATCH', id, body });
      if (body.status) {
        locked.add(id);
        written.add(id);
        // …and clear the recovery action, which is what the status write really
        // does and what the drain is verified on.
        if (!lieOnPatch && !keepRecovery) byId.get(id).activeRecoveryAction = null;
      }
      if (!lieOnPatch) {
        // `comment` is a write verb on the PATCH (TRA-4043), not an issue
        // field -- the live platform appends it to the thread, so the fake
        // must not materialize it onto the row.
        const { comment: _comment, ...fields } = body;
        Object.assign(byId.get(id), fields);
      }
      return { ok: true };
    },
  };
}

const CONTROLS = [
  {
    name: 'POSITIVE — an eligible strand drains in ONE combined write: PATCH {status,comment} (TRA-4043). No POST, no third key, no third write (TRA-4041)',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')]),
    apply: true,
    assert: (out, t) => {
      const w = t.writes[0];
      return (
        out.verdict === 'DRAINED' &&
        out.results.length === 1 &&
        out.results[0].outcome === OUTCOME.DRAINED &&
        t.writes.length === 1 &&
        w.verb === 'PATCH' &&
        Object.keys(w.body).sort().join(',') === 'comment,status' &&
        w.body.status === 'todo' &&
        typeof w.body.comment === 'string' &&
        /TRA-3541/.test(w.body.comment) &&
        // the banned step, pinned as never sent
        t.writes.every((x) => !('assigneeAgentId' in x.body))
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
    name: 'DRY RUN — the default sends NOTHING, and still names the one combined write it would make',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')]),
    apply: false,
    assert: (out, t) =>
      t.writes.length === 0 &&
      t.stats.attempts === 0 &&
      out.results.length === 1 &&
      out.results[0].outcome === OUTCOME.PLANNED &&
      out.results[0].steps.map((s) => s.step).join(',') === 'drain' &&
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
      const D = { klass: ROW_CLASS.DURABLE_STRAND };
      const a = gradeWriteBody('status', { status: 'todo', blockedByIssueIds: [] }, D);
      const b = gradeWriteBody('assignee', { assigneeAgentId: 'x', blockedBy: [] }, D);
      const c = gradeWriteBody('status', { status: 'done' }, D);
      const d = gradeWriteBody('status', { status: 'in_progress' }, D);
      const e = gradeWriteBody('status', { status: 'todo' }, D);
      // The blocker-key ban outranks the class gate: it must still fire on a
      // SUPPRESSING LEAF body, where `done` is otherwise legal.
      const g = gradeWriteBody('status', { status: 'done', blockedByIssueIds: [] }, { klass: ROW_CLASS.SUPPRESSING_LEAF });
      return {
        ok:
          !a.ok && /blocker write-key/.test(a.why) &&
          !b.ok && /blocker write-key/.test(b.why) &&
          !c.ok && /DESTROYS unrun work/.test(c.why) &&
          !d.ok && /re-strands the leaf/.test(d.why) &&
          !g.ok && /blocker write-key/.test(g.why) &&
          e.ok,
        detail:
          'blockedByIssueIds refused, blockedBy refused, done-on-durable refused, in_progress refused, ' +
          'blocker key still refused on the SUPPRESSING LEAF body, todo allowed',
      };
    },
  },
  {
    // TRA-4063, direction 1 of 2 at the wire. The class is what makes `done`
    // legal, so it has to be impossible to reach `done` without one.
    name: 'TRA-4063 CLASS GATE — `done` is reachable ONLY for a SUPPRESSING_LEAF, and `todo` is REFUSED for one',
    unit: () => {
      const noClass = gradeWriteBody('status', { status: 'todo' });
      const noClassDone = gradeWriteBody('status', { status: 'done' });
      const leafDone = gradeWriteBody('status', { status: 'done' }, { klass: ROW_CLASS.SUPPRESSING_LEAF });
      const leafTodo = gradeWriteBody('status', { status: 'todo' }, { klass: ROW_CLASS.SUPPRESSING_LEAF });
      const durTodo = gradeWriteBody('status', { status: 'todo' }, { klass: ROW_CLASS.DURABLE_STRAND });
      const durDone = gradeWriteBody('status', { status: 'done' }, { klass: ROW_CLASS.DURABLE_STRAND });
      const bogus = gradeWriteBody('status', { status: 'done' }, { klass: 'SOMETHING_ELSE' });
      return {
        ok:
          // an unclassified caller gets NEITHER status -- no inherited default
          !noClass.ok && /carries no row class/.test(noClass.why) &&
          !noClassDone.ok && /carries no row class/.test(noClassDone.why) &&
          !bogus.ok && /carries no row class/.test(bogus.why) &&
          // both directions of the real gate
          leafDone.ok &&
          !leafTodo.ok && /Only `done` is sanctioned for this class/.test(leafTodo.why) &&
          durTodo.ok &&
          !durDone.ok && /DESTROYS unrun work/.test(durDone.why),
        detail:
          'no-class: todo AND done both refused | SUPPRESSING_LEAF: done ok, todo REFUSED | ' +
          'DURABLE_STRAND: todo ok, done REFUSED',
      };
    },
  },
  {
    // TRA-4063, the classifier itself. Both directions and BOTH unknowns, on
    // the pure function, so the branches are pinned independently of any
    // transport that might not reach them.
    name: 'TRA-4063 CLASSIFIER — spawn-gating-nothing => done; durable => todo; both unknowns => NEITHER',
    unit: () => {
      const c = (o) => classifyDisposition({ blocksIdentifiers: [], ...o });
      const leaf = c({ originKind: 'routine_execution', blocksKnown: true, blocksIdentifiers: [] });
      const durable = c({ originKind: 'manual', blocksKnown: true, blocksIdentifiers: [] });
      const watchdog = c({ originKind: 'task_watchdog_product_bug', blocksKnown: true, blocksIdentifiers: [] });
      // a spawn that DOES gate something is durable: it has a dependent, so
      // `done` would bury it and `todo` correctly re-queues it
      const gating = c({ originKind: 'routine_execution', blocksKnown: true, blocksIdentifiers: ['TRA-1:todo'] });
      // unknown 1 -- no originKind at all
      const noOrigin = c({ originKind: null, blocksKnown: true, blocksIdentifiers: [] });
      // unknown 2 -- a spawn whose `blocks` key was ABSENT (absent is not empty)
      const noBlocks = c({ originKind: 'routine_execution', blocksKnown: false, blocksIdentifiers: [] });
      return {
        ok:
          leaf.klass === ROW_CLASS.SUPPRESSING_LEAF && leaf.status === 'done' &&
          durable.klass === ROW_CLASS.DURABLE_STRAND && durable.status === 'todo' &&
          watchdog.klass === ROW_CLASS.DURABLE_STRAND && watchdog.status === 'todo' &&
          gating.klass === ROW_CLASS.DURABLE_STRAND && gating.status === 'todo' &&
          noOrigin.klass === ROW_CLASS.UNCLASSIFIABLE && noOrigin.status === null &&
          /NO `originKind`/.test(noOrigin.why) &&
          noBlocks.klass === ROW_CLASS.UNCLASSIFIABLE && noBlocks.status === null &&
          /Absent is not empty/.test(noBlocks.why),
        detail:
          `spawn/gates-nothing=${leaf.status} | manual=${durable.status} | watchdog=${watchdog.status} | ` +
          `spawn/gates-something=${gating.status} | no-originKind=${noOrigin.status} | no-blocks=${noBlocks.status}`,
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
    name: 'The REAL comment bodies this script ships are ASCII-clean — BOTH templates (durable and suppressing leaf)',
    unit: () => {
      const base = {
        identifier: 'TRA-8001',
        recoveryKind: 'stranded_assigned_issue',
        blocksIdentifiers: [],
        repair: { restoredFrom: 'in_progress', assigneeAgentId: AGENT_BACK, status: 'todo' },
      };
      const durable = { ...base, originKind: 'manual', blocksKnown: true };
      const leaf = { ...base, originKind: 'routine_execution', blocksKnown: true, originId: ROUTINE_ID };
      const a = gradeWriteBody('comment', { body: drainComment(durable, 'run-1') });
      // TRA-4063 — and the leaf template in BOTH of its origin states: named,
      // and UNREAD. A template that is only ASCII-clean on the happy path
      // lands mojibake in the permanent audit trail on the day the route 500s.
      const named = drainComment(leaf, 'run-1', classifyDisposition(leaf), {
        title: 'TRA-4017 armed-liveness detector',
        status: 'active',
        concurrencyPolicy: 'skip_if_active',
        assigneeAgentId: AGENT_SELF,
      });
      const b = gradeWriteBody('comment', { body: named });
      const c = gradeWriteBody('comment', { body: drainComment(leaf, 'run-1', classifyDisposition(leaf), { unread: 'HTTP 500' }) });
      const d = gradeWriteBody('comment', { body: drainComment(leaf, 'run-1', classifyDisposition(leaf), null) });
      return {
        ok:
          a.ok && b.ok && c.ok && d.ok &&
          // the leaf body must SAY it took the done branch and NAME the routine
          /SUPPRESSING LEAF/.test(named) &&
          /`done` BRANCH, taken deliberately/.test(named) &&
          named.includes(ROUTINE_ID) &&
          /concurrencyPolicy `skip_if_active`/.test(named) &&
          // ...and must not claim `todo` anywhere as its own write
          !/PATCH status -> `todo`/.test(named),
        detail: a.ok && b.ok && c.ok && d.ok ? 'both templates ASCII; leaf names class, routine and policy' : (a.why || b.why || c.why || d.why),
      };
    },
  },
  {
    // TRA-4145 — the origin routine's TITLE is externally controlled text.
    // On 2026-08-27 an em dash in one made the drain refuse its OWN audit
    // body, and because the comment goes first the row got NEITHER write.
    name: 'TRA-4145 ASCII FOLD — a non-ASCII origin title folds at the interpolation site; the guard itself did NOT widen',
    unit: () => {
      const leaf = {
        identifier: 'TRA-8002',
        recoveryKind: 'stranded_assigned_issue',
        blocksIdentifiers: [],
        repair: { restoredFrom: 'in_progress', assigneeAgentId: AGENT_BACK, status: 'todo' },
        originKind: 'routine_execution',
        blocksKnown: true,
        originId: ROUTINE_ID,
      };
      // The title is an EXPLICIT field, never `title: undefined` -- a JS
      // default parameter fires on undefined and would hand the control an
      // ASCII default, making it read green against the wrong input. The
      // string is the live d8ec9395 title that broke the 2026-08-27 fire,
      // extended per TRA-4146 with a curly-quoted word and a non-Latin
      // character so all three adversarial classes ride through the COMPOSED
      // body, not just the asciiFold unit table.
      const origin = {
        title: 'TRA-2134 SANDBOX multi-strategy options runner (CSP/CC/long) — ‘pinned’ 样本 $0 notional',
        status: 'active',
        concurrencyPolicy: 'always_enqueue',
        assigneeAgentId: AGENT_SELF,
      };
      const body = drainComment(leaf, 'run-1', classifyDisposition(leaf), origin);
      const graded = gradeWriteBody('comment', { body });
      // Negative control: the raw title alone must STILL be refused. The fix
      // sanitizes the interpolation, it does not relax the guard.
      const rawStillRefused = gradeWriteBody('comment', { body: origin.title });
      const foldTable =
        asciiFold('—') === '--' &&
        asciiFold('–') === '--' &&
        asciiFold('‘x’') === "'x'" &&
        asciiFold('“x”') === '"x"' &&
        asciiFold('a…') === 'a...' &&
        asciiFold('a b') === 'a b' &&
        // anything unmapped becomes a printed escape, never a silent drop
        asciiFold('⚠') === '(U+26A0)' &&
        asciiFold('\u{1F600}') === '(U+1F600)';
      return {
        ok:
          graded.ok &&
          // the three adversarial classes each land in their FOLDED spelling
          // on the sanitized path (TRA-4146): em dash, curly quotes, and the
          // non-Latin characters as printed escapes -- never a silent drop
          /\(CSP\/CC\/long\) -- 'pinned' \(U\+6837\)\(U\+672C\) \$0 notional/.test(body) &&
          // ...and the SANITIZED body still carries the two facts the audit
          // trail exists for: the routine id and its concurrencyPolicy
          body.includes(ROUTINE_ID) &&
          /concurrencyPolicy `always_enqueue`/.test(body) &&
          // ...and the body SAYS a fold happened, so the trail records the
          // title was transformed rather than silently altered
          /ASCII-FOLDED/.test(body) &&
          !rawStillRefused.ok && /non-ASCII/.test(rawStillRefused.why) &&
          foldTable,
        detail: graded.ok
          ? 'folded body grades ok, states the fold, raw title still refused, fold table pinned'
          : graded.why,
      };
    },
  },
  {
    // TRA-4145 at the transport — acceptance shape 1: a DRY RUN over a cohort
    // whose suppressing leaf has a non-ASCII origin title plans BOTH writes
    // and refuses NOTHING. Before the fix this exact case exited WRITE_FAILED
    // ("REFUSED to send an unsanctioned comment body") without sending a byte.
    name: 'TRA-4145 END TO END — dry run over a leaf whose origin title carries U+2014 plans the combined drain write with NO refusal',
    build: () =>
      fakeTransport(
        [strandRow('s1', 'TRA-8001', { originKind: 'routine_execution', originId: ROUTINE_ID })],
        { routineTitle: 'TRA-2134 SANDBOX multi-strategy options runner (CSP/CC/long) — $0 notional' },
      ),
    apply: false,
    assert: (out, t) =>
      t.writes.length === 0 &&
      out.results.length === 1 &&
      out.results[0].outcome === OUTCOME.PLANNED &&
      out.results[0].steps.map((s) => s.step).join(',') === 'drain' &&
      /ASCII-FOLDED/.test(out.results[0].steps[0].body.comment) &&
      !/—/.test(out.results[0].steps[0].body.comment),
    detail: (out) =>
      `outcome ${out.results[0]?.outcome}, steps ${out.results[0]?.steps.map((s) => s.step).join(',') || 'none'}: ${out.results[0]?.why || ''}`,
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
    name: 'FOREIGN — a boundary 403 on the single combined write leaves the row with ZERO writes (atomic, TRA-4043) and reads REMAINDER, not FAILED',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')], { on403: 'status' }),
    apply: true,
    assert: (out, t) =>
      out.verdict === 'REMAINDER' &&
      out.results[0].outcome === OUTCOME.FOREIGN &&
      // nothing landed at all -- with the combined write there is no
      // comment-landed-then-status-403 half state left to worry about
      t.writes.length === 0 &&
      t.writes.filter((w) => w.body.assigneeAgentId).length === 0,
    detail: (out, t) => `${t.writes.length} write(s) landed; outcome ${out.results[0].outcome}`,
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
    assert: (out, t) => out.verdict === 'DRAINED' && out.plan.counts.excluded === 0 && t.writes.length === 1,
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
      t.writes.length === 1 &&
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
      t.writes.length === 1 && t.writes.every((w) => w.id === 's2') && out.plan.counts.notSelected === 1,
    detail: (out, t) => `wrote to ${[...new Set(t.writes.map((w) => w.id))].join(',')}, notSelected ${out.plan.counts.notSelected}`,
  },
  {
    name: 'TRA-4043 ATOMIC ROW — exactly ONE step, `drain`, carrying comment AND status together: no order exists for a budget cut-off to truncate',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')]),
    apply: true,
    assert: (out, t) => {
      const steps = out.results[0].steps.map((s) => s.step);
      return (
        steps.length === 1 &&
        steps[0] === 'drain' &&
        !steps.includes('assignee') &&
        t.stats.attempts === 1 &&
        t.writes.length === 1
      );
    },
    detail: (out) => out.results[0].steps.map((s) => s.step).join(' -> '),
  },
  {
    // The control this ticket exists for. If someone re-adds the third write,
    // THIS is what stops it -- at the request body, before the transport.
    name: 'TRA-4041 BANNED STEP — gradeWriteBody REFUSES any assignee write, by step name AND by key',
    unit: () => {
      const D = { klass: ROW_CLASS.DURABLE_STRAND };
      const a = gradeWriteBody('assignee', { assigneeAgentId: AGENT_BACK }, D);
      const b = gradeWriteBody('status', { status: 'todo', assigneeAgentId: AGENT_BACK }, D);
      const c = gradeWriteBody('status', { status: 'todo' }, D);
      // the ban outranks the TRA-4063 class gate too, on the class where `done`
      // is legal -- an assignee key must not ride in on the new branch
      const d = gradeWriteBody('status', { status: 'done', assigneeAgentId: AGENT_BACK }, { klass: ROW_CLASS.SUPPRESSING_LEAF });
      return {
        ok:
          !a.ok && /409 Issue run ownership conflict/.test(a.why) &&
          !b.ok && /409 Issue run ownership conflict/.test(b.why) &&
          !d.ok && /409 Issue run ownership conflict/.test(d.why) &&
          c.ok,
        detail:
          'assignee step refused, assignee key smuggled onto the status body refused, still refused on the ' +
          'SUPPRESSING LEAF body, plain status allowed',
      };
    },
  },
  {
    // The negative control for the fake itself. Without a run lock in the
    // transport, the deleted third step would still pass every control here --
    // which is exactly how it survived from 2026-08-13 to 2026-08-26.
    name: 'TRA-4041 THE FAKE HAS TEETH — the status PATCH takes the run lock, so a SECOND PATCH on that row 409s',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')]),
    apply: true,
    assert: async (out, t) => {
      let second = 'NO THROW';
      try {
        await t.patchIssue('s1', { status: 'todo' });
      } catch (err) {
        second = String(err.message);
      }
      return out.verdict === 'DRAINED' && /409/.test(second) && /run ownership conflict/.test(second);
    },
    detail: () => 'a post-drain PATCH on the drained row throws 409, as the live platform does',
  },
  {
    name: 'TRA-4041 RUN_LOCKED — a 409 on the combined write is its OWN outcome: not FOREIGN (no twin arm helps), not FAILED',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')], { on409: 'status' }),
    apply: true,
    assert: (out, t) =>
      out.results[0].outcome === OUTCOME.RUN_LOCKED &&
      out.verdict === 'REMAINDER' &&
      DRAIN_EXIT[out.verdict] === 1 &&
      /live run already holds/.test(out.results[0].why) &&
      // the single write was rejected whole -- ZERO writes, nothing half-written
      t.writes.length === 0,
    detail: (out) => out.results[0].why.slice(0, 100),
  },
  {
    name: 'TRA-4041 VERIFY — the status moved but activeRecoveryAction is STILL live => NOT_VERIFIED, never DRAINED',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')], { keepRecovery: true }),
    apply: true,
    assert: (out) =>
      out.verdict === 'FAILED' &&
      out.results[0].outcome === OUTCOME.NOT_VERIFIED &&
      /activeRecoveryAction is STILL live/.test(out.results[0].why),
    detail: (out) => out.results[0].why.slice(0, 110),
  },
  {
    // THE control this ticket exists for, end to end, over the exact live shape
    // of TRA-4058: a per-fire spawn of an active skip_if_active detector,
    // gating nothing, resting blocked+empty. Before TRA-4063 this row was
    // planned `-> todo`, which switches that detector OFF.
    name: 'TRA-4063 SUPPRESSING LEAF — a routine_execution spawn gating nothing is written `done`, NEVER `todo`',
    build: () =>
      fakeTransport([strandRow('s1', 'TRA-4058', { originKind: 'routine_execution', originId: ROUTINE_ID, blocks: [] })]),
    apply: true,
    assert: (out, t) => {
      const rendered = renderDrain(out).join('\n');
      const w = t.writes.find((x) => x.body.status);
      return (
        out.verdict === 'DRAINED' &&
        out.results[0].outcome === OUTCOME.DRAINED &&
        out.results[0].disp.klass === ROW_CLASS.SUPPRESSING_LEAF &&
        t.writes.length === 1 &&
        // the write itself -- `done`, and NOT `todo`, with the audit comment
        // riding in the same body (TRA-4043)
        w.body.status === 'done' &&
        out.plan.counts.suppressingLeaf === 1 &&
        out.plan.counts.durableStrand === 0 &&
        // the class is NAMED in the report, with the routine it keeps alive
        /SUPPRESSING LEAF/.test(rendered) &&
        /-> done {2}\[SUPPRESSING_LEAF\]/.test(rendered) &&
        rendered.includes(ROUTINE_ID) &&
        // ...and the ledger says which branch it took
        /`done` BRANCH, taken deliberately/.test(w.body.comment) &&
        /concurrencyPolicy `skip_if_active`/.test(w.body.comment)
      );
    },
    detail: (out, t) =>
      `class ${out.results[0].disp.klass}, wrote ${JSON.stringify(t.writes.find((w) => w.body.status)?.body)}`,
  },
  {
    // The negative direction, on the SAME transport. Without it, a classifier
    // that returned SUPPRESSING_LEAF for everything would pass the control
    // above and destroy every strand it touched.
    name: 'TRA-4063 NEGATIVE — a durable `manual` strand still gets `todo`, and `done` is never sent for it',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001', { originKind: 'manual', blocks: [] })]),
    apply: true,
    assert: (out, t) =>
      out.verdict === 'DRAINED' &&
      out.results[0].disp.klass === ROW_CLASS.DURABLE_STRAND &&
      t.writes.find((w) => w.body.status).body.status === 'todo' &&
      out.plan.counts.durableStrand === 1 &&
      out.plan.counts.suppressingLeaf === 0 &&
      t.writes.every((w) => w.body.status !== 'done'),
    detail: (out, t) =>
      `class ${out.results[0].disp.klass}, wrote ${JSON.stringify(t.writes.find((w) => w.body.status)?.body)}`,
  },
  {
    // A spawn WITH a dependent. The discriminator is `blocks`, not
    // `originKind` alone, and this is the row that proves the drain reads it.
    name: 'TRA-4063 A SPAWN THAT GATES SOMETHING is durable — `done` would bury the dependent, so it gets `todo`',
    build: () =>
      fakeTransport([
        strandRow('s1', 'TRA-8001', {
          originKind: 'routine_execution',
          originId: ROUTINE_ID,
          blocks: [{ id: 'd1', identifier: 'TRA-9001', status: 'todo' }],
        }),
      ]),
    apply: true,
    assert: (out, t) =>
      out.results[0].disp.klass === ROW_CLASS.DURABLE_STRAND &&
      t.writes.find((w) => w.body.status).body.status === 'todo' &&
      /it GATES TRA-9001:todo/.test(out.results[0].disp.why),
    detail: (out) => out.results[0].disp.why.slice(0, 120),
  },
  {
    // UNKNOWN 1 of 2. Pinned to the SAFE side: no write at all, and LOUD.
    name: 'TRA-4063 UNKNOWN — a row with NO originKind is written NEITHER status, and colours REMAINDER',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001', { omitOriginKind: true })]),
    apply: true,
    assert: (out, t) => {
      const rendered = renderDrain(out).join('\n');
      return (
        t.writes.length === 0 &&
        out.verdict === 'REMAINDER' &&
        DRAIN_EXIT[out.verdict] === 1 &&
        out.plan.counts.unclassifiable === 1 &&
        out.plan.counts.drain === 0 &&
        /SKIP_UNCLASSIFIABLE/.test(rendered) &&
        /NO `originKind`/.test(rendered)
      );
    },
    detail: (out) => `${out.verdict}, unclassifiable=${out.plan.counts.unclassifiable}, 0 writes`,
  },
  {
    // UNKNOWN 2 of 2. The dangerous one: this row LOOKS like a spawn, and the
    // one field that would tell us whether `done` buries a subtree is absent.
    name: 'TRA-4063 UNKNOWN — a routine_execution row whose `blocks` key is ABSENT is written NEITHER status',
    build: () =>
      fakeTransport([
        strandRow('s1', 'TRA-8001', { originKind: 'routine_execution', originId: ROUTINE_ID, omitBlocks: true }),
      ]),
    apply: true,
    assert: (out, t) =>
      t.writes.length === 0 &&
      out.verdict === 'REMAINDER' &&
      out.plan.counts.unclassifiable === 1 &&
      /Absent is not empty/.test(out.plan.rows[0].why),
    detail: (out) => out.plan.rows[0].why.slice(0, 110),
  },
  {
    // The verify direction for the new class. `done` is only a repair if it
    // STUCK as terminal -- a leaf that reads back `todo` cleared the strand and
    // left the routine off, which is a green log over the unfixed defect.
    name: 'TRA-4063 VERIFY — a SUPPRESSING LEAF that reads back NON-TERMINAL is NOT_VERIFIED, never DRAINED',
    build: () =>
      fakeTransport(
        [strandRow('s1', 'TRA-4058', { originKind: 'routine_execution', originId: ROUTINE_ID, blocks: [] })],
        { flipTo: 'in_progress' },
      ),
    apply: true,
    assert: (out) =>
      out.verdict === 'FAILED' &&
      DRAIN_EXIT[out.verdict] === 2 &&
      out.results[0].outcome === OUTCOME.NOT_VERIFIED &&
      /NOT terminal/.test(out.results[0].why) &&
      /stays OFF/.test(out.results[0].why),
    detail: (out) => out.results[0].why.slice(0, 130),
  },
  {
    // ...and the SAME flip on a DURABLE row is still a clean drain (TRA-3758).
    // Without this pair, the assertion above could just be "always require
    // done" and nobody would notice it had re-broken the durable class.
    name: 'TRA-4063 VERIFY — the SAME `in_progress` read-back on a DURABLE row is still DRAINED (TRA-3758 stands)',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001', { originKind: 'manual' })], { flipTo: 'in_progress' }),
    apply: true,
    assert: (out) => out.verdict === 'DRAINED' && out.results[0].outcome === OUTCOME.DRAINED,
    detail: (out) => out.results[0].why.slice(0, 110),
  },
  {
    // The routine read is REPORT-ONLY. If it could veto, an unreachable
    // routines route would become a third unknown and silently shrink the
    // cohort -- so it must degrade to UNREAD and ship the same status.
    name: 'TRA-4063 ORIGIN READ IS NOT A GATE — a routines route that 500s still writes `done`, and says UNREAD',
    build: () =>
      fakeTransport(
        [strandRow('s1', 'TRA-4058', { originKind: 'routine_execution', originId: ROUTINE_ID, blocks: [] })],
        { routineUnread: true },
      ),
    apply: true,
    assert: (out, t) => {
      const w = t.writes.find((x) => x.body.status);
      return (
        out.verdict === 'DRAINED' &&
        w.body.status === 'done' &&
        /UNREAD/.test(w.body.comment) &&
        /HTTP 500/.test(w.body.comment)
      );
    },
    detail: () => 'routine unread => comment says UNREAD, the `done` write is unchanged',
  },
  {
    // TRA-3758, live: the write does not always STORE `todo`.
    name: 'TRA-4041 VERIFY — a row the queue picks up reads back `in_progress`; recovery cleared => still DRAINED',
    build: () => {
      const t = fakeTransport([strandRow('s1', 'TRA-8001')]);
      const inner = t.getIssue;
      t.getIssue = async (id) => {
        const r = await inner(id);
        if (r.status === 'todo') r.status = 'in_progress';
        return r;
      };
      return t;
    },
    apply: true,
    assert: (out) =>
      out.verdict === 'DRAINED' &&
      out.results[0].outcome === OUTCOME.DRAINED &&
      /status `in_progress`/.test(out.results[0].why),
    detail: (out) => out.results[0].why.slice(0, 110),
  },
  {
    // TRA-4043, the wire gate for the combined body. Composed of the two
    // existing graders, so every ban they carry must survive composition.
    name: 'TRA-4043 DRAIN BODY GATE — the combined body is exactly {status,comment}; every existing ban survives composition',
    unit: () => {
      const D = { klass: ROW_CLASS.DURABLE_STRAND };
      const good = gradeWriteBody('drain', { status: 'todo', comment: 'drained -- see TRA-3541' }, D);
      const leafGood = gradeWriteBody('drain', { status: 'done', comment: 'leaf rest' }, { klass: ROW_CLASS.SUPPRESSING_LEAF });
      const ascii = gradeWriteBody('drain', { status: 'todo', comment: 'drained — em dash' }, D);
      const smuggle = gradeWriteBody('drain', { status: 'todo', comment: 'x', assigneeAgentId: 'a' }, D);
      const blocker = gradeWriteBody('drain', { status: 'todo', comment: 'x', blockedByIssueIds: [] }, D);
      const wrongStatus = gradeWriteBody('drain', { status: 'done', comment: 'x' }, D);
      const noClass = gradeWriteBody('drain', { status: 'todo', comment: 'x' });
      const missing = gradeWriteBody('drain', { status: 'todo' }, D);
      return {
        ok:
          good.ok &&
          leafGood.ok &&
          !ascii.ok && /non-ASCII/.test(ascii.why) &&
          !smuggle.ok && /409 Issue run ownership conflict/.test(smuggle.why) &&
          !blocker.ok && /blocker write-key/.test(blocker.why) &&
          !wrongStatus.ok && /DESTROYS unrun work/.test(wrongStatus.why) &&
          !noClass.ok && /carries no row class/.test(noClass.why) &&
          !missing.ok && /expected exactly/.test(missing.why),
        detail:
          'good todo+comment ok, leaf done+comment ok | refused: non-ASCII comment, smuggled assignee, ' +
          'blocker key, done-on-durable, no class, missing comment',
      };
    },
  },
  {
    // TRA-4043 Defect 1, the reservation. 25 drainable rows against a cap of
    // 20: exactly 20 drain, 5 are NOT ATTEMPTED with zero network calls, and
    // the verdict is DEFERRED -- not FAILED, and none of the 5 in the failure
    // count. This is the 2026-08-26 fire shape, fixed.
    name: 'TRA-4043 BUDGET RESERVATION — 25 drainable vs cap 20: 20 drained, 5 NOT_ATTEMPTED_BUDGET with ZERO writes, verdict DEFERRED exit 1',
    build: () => fakeTransport(Array.from({ length: 25 }, (_, i) => strandRow(`s${i + 1}`, `TRA-81${String(i + 1).padStart(2, '0')}`))),
    apply: true,
    opts: { budgetCap: 20, budgetSpent: 0 },
    assert: (out, t) => {
      const drained = out.results.filter((r) => r.outcome === OUTCOME.DRAINED);
      const deferred = out.results.filter((r) => r.outcome === OUTCOME.NOT_ATTEMPTED_BUDGET);
      const rendered = renderDrain(out).join('\n');
      return (
        out.verdict === 'DEFERRED' &&
        DRAIN_EXIT[out.verdict] === 1 &&
        drained.length === 20 &&
        deferred.length === 5 &&
        t.writes.length === 20 &&
        t.stats.attempts === 20 &&
        // the deferred rows never even built a step, let alone sent one
        deferred.every((r) => r.steps.length === 0) &&
        // and none of them leaked into a failure class
        out.results.every((r) => r.outcome !== OUTCOME.WRITE_FAILED && r.outcome !== OUTCOME.NOT_VERIFIED) &&
        /DEFERRED/.test(rendered) &&
        /NOT write failures/.test(rendered) &&
        /row ceiling 20/.test(rendered)
      );
    },
    detail: (out, t) => `verdict ${out.verdict}: ${t.writes.length} landed, ${out.results.filter((r) => r.outcome === OUTCOME.NOT_ATTEMPTED_BUDGET).length} deferred, ${t.stats.attempts} attempts`,
  },
  {
    // TRA-4043 — the live 429 outranks the local counter: the surrounding run
    // can have spent budget this script never saw. The rejected row and every
    // row after it defer; the rejected row is NOT half-written (atomic write)
    // and NOT a write failure.
    name: 'TRA-4043 AUTHORITATIVE 429 — a live cap rejection defers the row AND the rest of the plan without further attempts; never FAILED',
    build: () => fakeTransport(Array.from({ length: 4 }, (_, i) => strandRow(`s${i + 1}`, `TRA-820${i + 1}`)), { capAt: 2 }),
    apply: true,
    opts: { budgetCap: 20, budgetSpent: 0 },
    assert: (out, t) => {
      const outcomes = out.results.map((r) => r.outcome);
      return (
        out.verdict === 'DEFERRED' &&
        outcomes.join(',') ===
          [OUTCOME.DRAINED, OUTCOME.DRAINED, OUTCOME.NOT_ATTEMPTED_BUDGET, OUTCOME.NOT_ATTEMPTED_BUDGET].join(',') &&
        t.writes.length === 2 &&
        // rows 1,2 attempted and landed; row 3 attempted and 429'd; row 4 was
        // gated locally off the authoritative signal -- no fourth attempt
        t.stats.attempts === 3 &&
        /live 429 said so|cross_issue_influence_cap_exceeded/.test(out.results[3].why) &&
        /REJECTED whole/.test(out.results[2].why)
      );
    },
    detail: (out, t) => `outcomes ${out.results.map((r) => r.outcome).join(',')}; ${t.stats.attempts} attempts, ${t.writes.length} landed`,
  },
  {
    // TRA-4043 — the cap is per RUN, not per script. A caller that already
    // spent 19 writes this heartbeat gets a 1-row ceiling here, not 20.
    name: 'TRA-4043 --budget-spent — 19 pre-spent of cap 20 leaves a 1-row ceiling: 1 drained, 2 deferred',
    build: () => fakeTransport(Array.from({ length: 3 }, (_, i) => strandRow(`s${i + 1}`, `TRA-830${i + 1}`))),
    apply: true,
    opts: { budgetCap: 20, budgetSpent: 19 },
    assert: (out, t) =>
      out.verdict === 'DEFERRED' &&
      out.results.filter((r) => r.outcome === OUTCOME.DRAINED).length === 1 &&
      out.results.filter((r) => r.outcome === OUTCOME.NOT_ATTEMPTED_BUDGET).length === 2 &&
      t.writes.length === 1 &&
      t.stats.attempts === 1 &&
      /row ceiling 1/.test(renderDrain(out).join('\n')),
    detail: (out, t) => `${t.writes.length} landed, ${out.results.filter((r) => r.outcome === OUTCOME.NOT_ATTEMPTED_BUDGET).length} deferred`,
  },
  {
    // TRA-4299 — the transient trap. A 403 run_context_required on the first
    // attempt is retried once and the retry lands: the row DRAINS, and is
    // never misread as FOREIGN (which would send it to a twin arm that does
    // not exist).
    name: 'TRA-4299 TRANSIENT 403 — run_context_required on attempt 1 is retried and the retry drains the row; not FOREIGN',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')], { runContext403Times: 1 }),
    apply: true,
    opts: { runContextRetryMs: 0 },
    assert: (out, t) =>
      out.verdict === 'DRAINED' &&
      out.results[0].outcome === OUTCOME.DRAINED &&
      t.stats.attempts === 2 &&
      t.writes.length === 1,
    detail: (out, t) => `outcome ${out.results[0].outcome} after ${t.stats.attempts} attempts (1 refused, 1 landed)`,
  },
  {
    // TRA-4299 — and when the context never arrives: each row gets one retry,
    // two consecutive refusals trip the breaker and the rest of the plan is
    // deferred without spending budget on attempts that cannot land. REMAINDER,
    // never FOREIGN, never FAILED.
    name: 'TRA-4299 PERSISTENT 403 — run context absent all run: RUN_CONTEXT_DEFERRED rows, breaker after 2, verdict REMAINDER not FAILED/FOREIGN',
    build: () => fakeTransport(Array.from({ length: 3 }, (_, i) => strandRow(`s${i + 1}`, `TRA-840${i + 1}`)), { runContext403Times: Infinity }),
    apply: true,
    opts: { runContextRetryMs: 0 },
    assert: (out, t) =>
      out.verdict === 'REMAINDER' &&
      out.results.every((r) => r.outcome === OUTCOME.RUN_CONTEXT_DEFERRED) &&
      out.results.every((r) => r.outcome !== OUTCOME.FOREIGN && r.outcome !== OUTCOME.WRITE_FAILED) &&
      // rows 1 and 2: two attempts each; row 3: breaker, zero attempts
      t.stats.attempts === 4 &&
      t.writes.length === 0 &&
      /not attempted/.test(out.results[2].why),
    detail: (out, t) => `${t.stats.attempts} attempts across 3 rows (breaker held row 3 back), verdict ${out.verdict}`,
  },
];

async function selftest() {
  let failed = 0;
  const seenVerdicts = new Set();
  const seenOutcomes = new Set();
  // TRA-4063 — the classes get their own reachability set. A suite in which
  // every control happens to run over durable rows proves the durable branch
  // and nothing else, which is precisely the state this file was in the day it
  // planned `-> todo` for a live detector's spawn.
  const seenClasses = new Set();

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
        for (const r of out.results) {
          seenOutcomes.add(r.outcome);
          if (r.disp) seenClasses.add(r.disp.klass);
        }
        for (const r of out.plan ? out.plan.rows : []) if (r.disp) seenClasses.add(r.disp.klass);
        ok = await c.assert(out, t);
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
  const wantVerdicts = ['VACUOUS', 'DRAINED', 'REMAINDER', 'DEFERRED', 'FAILED', 'BLIND'];
  const wantOutcomes = [
    OUTCOME.DRAINED,
    OUTCOME.PLANNED,
    OUTCOME.FOREIGN,
    OUTCOME.NOT_VERIFIED,
    OUTCOME.RUN_LOCKED,
    OUTCOME.NOT_ATTEMPTED_BUDGET,
    OUTCOME.RUN_CONTEXT_DEFERRED,
  ];
  const wantClasses = [ROW_CLASS.DURABLE_STRAND, ROW_CLASS.SUPPRESSING_LEAF, ROW_CLASS.UNCLASSIFIABLE];
  for (const [label, want, seen] of [
    ['verdict', wantVerdicts, seenVerdicts],
    ['row outcome', wantOutcomes, seenOutcomes],
    ['row class', wantClasses, seenClasses],
  ]) {
    const missing = want.filter((v) => !seen.has(v));
    if (missing.length) failed += 1;
    console.log(
      `${missing.length ? 'FAIL' : 'ok  '}  every ${label} arm is reachable: ${want.join(', ')}` +
        (missing.length ? `\n        NEVER REACHED: ${missing.join(', ')}` : ''),
    );
  }

  console.log(`\n${CONTROLS.length + 3 - failed}/${CONTROLS.length + 3} controls pass`);
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
    // TRA-4063 — report-only, and the FULL uuid off `originId`. The short-id
    // form of this route 500s; the uuid form answered 200 with `title`,
    // `status`, `concurrencyPolicy` and `assigneeAgentId` when measured
    // 2026-08-26 against routine 82daa7b2. Nothing here is a write gate: if it
    // throws, the audit comment says UNREAD and the same status still ships.
    getRoutine: async (id) => get(`${BASE}/api/routines/${id}`),
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
    // TRA-4043 — the per-run cross-issue write budget. `--budget-spent` is for
    // a caller that already made cross-issue writes in this same heartbeat run
    // before invoking the drain (the cap is per RUN, not per script).
    budgetCap: Number(argOf('budget', BUDGET_DEFAULT_CAP)),
    budgetSpent: Number(argOf('budget-spent', 0)),
    runContextRetryMs: Number(argOf('run-context-retry-ms', 3000)),
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
          budget: out.budget || null,
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
