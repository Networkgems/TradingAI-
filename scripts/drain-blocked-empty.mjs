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
 * THE TWO WRITES, IN THIS ORDER, PER ROW
 * --------------------------------------
 *   1. POST /comments            the audit trail
 *   2. PATCH {"status": <-- CLASS-DEPENDENT}   the LAST write this row accepts
 *
 * The comment goes first because it must be written while the row is still ours:
 * the moment a row leaves this actor's authorization boundary, both the status
 * PATCH and the comment come back `403 {"error":"Issue is outside this actor's
 * authorization boundary"}` (measured repeatedly; see the CFO hand-back on
 * TRA-3397).
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
        '(TRA-4041 / TRA-4063). There is no unrun work to destroy: the fire is over, the spawn is its record.',
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
 * Exactly two verbs are legal, matching the two the detector is allowed to
 * print (its SANCTIONED_VERB whitelist). Anything else — a third key, a
 * blocker-key write, a merged one-shot body — is a defect.
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
          '`done` is reachable ONLY for a SUPPRESSING_LEAF (TRA-4063), where there is no unrun work to destroy.',
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
      `so the origin routine would keep treating this finished fire as live and would never run again. There is no ` +
      `unrun work to destroy -- the fire is over and this spawn is its record.\n` +
      `- \`blockedByIssueIds\` deliberately NOT re-sent.\n` +
      `- assigneeAgentId deliberately NOT written. The recovery payload names \`${fold(rep.assigneeAgentId)}\` as the ` +
      `returnOwnerAgentId; the status write above spawns a run that takes this issue's checkout lock, so any ` +
      `further PATCH returns 409 Issue run ownership conflict (6/6, measured). The re-home is the platform's.\n\n` +
      `If this classification is wrong, the recoverable direction is to reopen this row -- not to re-drain it. ` +
      `Commented BEFORE the status write, because the status write is the last one this row accepts.\n\n` +
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
    `again. Commented BEFORE the status write, because the status write is the last one this row accepts.\n\n` +
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
};

const isBoundary403 = (err) => /\b403\b/.test(String(err?.message || err)) || /authorization boundary/i.test(String(err?.message || err));

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
export async function drainRow(transport, row, { apply = false, runId = null } = {}) {
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

  const send = async (step, fn, body) => {
    const graded = gradeWriteBody(step, body, { klass: disp.klass });
    if (!graded.ok) {
      // Not a skip. The caller built a body this file does not sanction, which
      // is a code defect, and continuing would write it.
      throw new Error(`REFUSED to send an unsanctioned ${step} body -- ${graded.why}`);
    }
    steps.push({ step, body, sent: apply });
    if (!apply) return null;
    return fn();
  };

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

  try {
    await send('comment', () => transport.postComment(f.id, { body: drainComment(f, runId, disp, origin) }), {
      body: drainComment(f, runId, disp, origin),
    });
    // The LAST write this row will accept: it mints a live status, which spawns
    // a run, which takes the checkout lock (TRA-4041). Nothing follows it.
    await send('status', () => transport.patchIssue(f.id, { status: disp.status }), { status: disp.status });
  } catch (err) {
    if (isRunLock409(err)) {
      return {
        outcome: OUTCOME.RUN_LOCKED,
        steps,
        disp,
        why:
          `409 Issue run ownership conflict on the \`${steps[steps.length - 1]?.step || 'first'}\` step -- a live run ` +
          'already holds this row\'s checkout lock, so this actor\'s run id does not match its executionRunId. The row ' +
          'IS ours (this is not the 403 boundary and no other seat\'s arm can take it), and nothing was half-written. ' +
          'Leave it: the next fire runs against a row whose run has ended.',
      };
    }
    if (isBoundary403(err)) {
      return {
        outcome: OUTCOME.FOREIGN,
        steps,
        disp,
        why:
          `403 outside this actor's authorization boundary on the \`${steps[steps.length - 1]?.step || 'first'}\` ` +
          `step. This row is currently assigned to ${f.assigneeName || f.assigneeAgentId || 'nobody'} and only that ` +
          'seat can drain it. Rank does not lift the boundary and there is no predictor for it -- this is the twin ' +
          "arm's row, not a retry.",
      };
    }
    return { outcome: OUTCOME.WRITE_FAILED, steps, disp, why: String(err?.message || err) };
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
  const bad = results.filter((r) => r.outcome === OUTCOME.WRITE_FAILED || r.outcome === OUTCOME.NOT_VERIFIED);
  if (bad.length) return 'FAILED';
  // RUN_LOCKED joins FOREIGN here rather than FAILED (TRA-4041): nothing was
  // half-written and nothing is broken, but a row was not drained and the next
  // fire has to pick it up, so it must not read as a clean DRAINED either.
  // TRA-4063 — UNCLASSIFIABLE joins them for the same reason. A row whose class
  // could not be decided is a row nobody has drained, and the SAFE refusal is
  // only safe if it is also LOUD: a silent skip would read as a clean fire on a
  // board that still has the strand.
  const unowned =
    plan.counts.ineligible +
    plan.counts.unclassifiable +
    results.filter(
      (r) => r.outcome === OUTCOME.FOREIGN || r.outcome === OUTCOME.RUN_LOCKED || r.outcome === OUTCOME.UNCLASSIFIABLE,
    ).length;
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
  } = {},
) {
  // TRA-4041 — ids whose checkout lock has been taken by the run the status
  // PATCH spawned. Once in here, every further PATCH on that row 409s.
  const locked = new Set();
  const written = new Set();
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
      if (on403 === 'status' && body.status) {
        throw new Error('HTTP 403 — {"error":"Issue is outside this actor\'s authorization boundary"}');
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
      if (!lieOnPatch) Object.assign(byId.get(id), body);
      return { ok: true };
    },
  };
}

const CONTROLS = [
  {
    name: 'POSITIVE — an eligible strand drains in TWO writes: comment, then status. There is no third write (TRA-4041)',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')]),
    apply: true,
    assert: (out, t) => {
      const verbs = t.writes.map((w) => `${w.verb} ${JSON.stringify(w.body)}`);
      return (
        out.verdict === 'DRAINED' &&
        out.results.length === 1 &&
        out.results[0].outcome === OUTCOME.DRAINED &&
        t.writes.length === 2 &&
        verbs[0].startsWith('POST') &&
        verbs[1] === 'PATCH {"status":"todo"}' &&
        // the banned step, pinned as never sent
        t.writes.every((w) => !('assigneeAgentId' in w.body))
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
      out.results[0].steps.map((s) => s.step).join(',') === 'comment,status' &&
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
    name: 'TRA-4145 END TO END — dry run over a leaf whose origin title carries U+2014 plans comment,status with NO refusal',
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
      out.results[0].steps.map((s) => s.step).join(',') === 'comment,status' &&
      /ASCII-FOLDED/.test(out.results[0].steps[0].body.body) &&
      !/—/.test(out.results[0].steps[0].body.body),
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
    assert: (out, t) => out.verdict === 'DRAINED' && out.plan.counts.excluded === 0 && t.writes.length === 2,
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
      t.writes.length === 2 &&
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
      t.writes.length === 2 && t.writes.every((w) => w.id === 's2') && out.plan.counts.notSelected === 1,
    detail: (out, t) => `wrote to ${[...new Set(t.writes.map((w) => w.id))].join(',')}, notSelected ${out.plan.counts.notSelected}`,
  },
  {
    name: 'ORDER IS LOAD-BEARING — comment FIRST (while the row is still ours), status LAST (it takes the run lock)',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')]),
    apply: true,
    assert: (out) => {
      const steps = out.results[0].steps.map((s) => s.step);
      return steps.length === 2 && steps[0] === 'comment' && steps[1] === 'status' && !steps.includes('assignee');
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
    name: 'TRA-4041 RUN_LOCKED — a 409 on the status step is its OWN outcome: not FOREIGN (no twin arm helps), not FAILED',
    build: () => fakeTransport([strandRow('s1', 'TRA-8001')], { on409: 'status' }),
    apply: true,
    assert: (out, t) =>
      out.results[0].outcome === OUTCOME.RUN_LOCKED &&
      out.verdict === 'REMAINDER' &&
      DRAIN_EXIT[out.verdict] === 1 &&
      /live run already holds/.test(out.results[0].why) &&
      // the comment landed; the status did not; nothing is half-written
      t.writes.length === 1 &&
      t.writes[0].verb === 'POST',
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
      const status = t.writes.find((w) => w.body.status);
      const comment = t.writes.find((w) => w.verb === 'POST');
      return (
        out.verdict === 'DRAINED' &&
        out.results[0].outcome === OUTCOME.DRAINED &&
        out.results[0].disp.klass === ROW_CLASS.SUPPRESSING_LEAF &&
        t.writes.length === 2 &&
        // the write itself -- `done`, and NOT `todo`
        JSON.stringify(status.body) === '{"status":"done"}' &&
        out.plan.counts.suppressingLeaf === 1 &&
        out.plan.counts.durableStrand === 0 &&
        // the class is NAMED in the report, with the routine it keeps alive
        /SUPPRESSING LEAF/.test(rendered) &&
        /-> done {2}\[SUPPRESSING_LEAF\]/.test(rendered) &&
        rendered.includes(ROUTINE_ID) &&
        // ...and the ledger says which branch it took
        /`done` BRANCH, taken deliberately/.test(comment.body.body) &&
        /concurrencyPolicy `skip_if_active`/.test(comment.body.body)
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
      JSON.stringify(t.writes.find((w) => w.body.status).body) === '{"status":"todo"}' &&
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
      JSON.stringify(t.writes.find((w) => w.body.status).body) === '{"status":"todo"}' &&
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
      const comment = t.writes.find((w) => w.verb === 'POST');
      return (
        out.verdict === 'DRAINED' &&
        JSON.stringify(t.writes.find((w) => w.body.status).body) === '{"status":"done"}' &&
        /UNREAD/.test(comment.body.body) &&
        /HTTP 500/.test(comment.body.body)
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
  const wantVerdicts = ['VACUOUS', 'DRAINED', 'REMAINDER', 'FAILED', 'BLIND'];
  const wantOutcomes = [OUTCOME.DRAINED, OUTCOME.PLANNED, OUTCOME.FOREIGN, OUTCOME.NOT_VERIFIED, OUTCOME.RUN_LOCKED];
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
