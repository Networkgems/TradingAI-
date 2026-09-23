#!/usr/bin/env node
/**
 * TRA-2364 / TRA-2617 — detector for the two `blocked`-leaf STRAND shapes.
 *
 * There are TWO ways a `blocked` issue can be holding an edge that nothing will
 * ever resolve, and they need OPPOSITE amounts of noise to find.
 *
 * SHAPE 1 — `blocked` + EMPTY `blockedBy`  (TRA-2364, the original)
 * ----------------------------------------------------------------
 * An issue at `status: "blocked"` whose `blockedBy` array is empty carries no
 * edge that anything can ever resolve. The board treats it as a leaf with no
 * unmet dependency and auto-flips it back to `in_progress` — so the "hold" is
 * a hold that silently expires, and whatever the issue was parked for resumes
 * unattended.
 *
 * SHAPE 2 — `blocked` + EVERY `blockedBy` entry CLOSED  (TRA-2617, added later)
 * ----------------------------------------------------------------------------
 * When an issue closes, every issue in its `blocks` array that was `blocked`
 * STAYS `blocked` — now with a blocker list in which every entry is `done` or
 * `cancelled`. `blocked` does NOT auto-flip when a blocker closes; somebody has
 * to move it by hand, and nobody is told to.
 *
 * ⛔ THE ASYMMETRY IS THE WHOLE POINT, and it is why this shape went unreported
 * for so long by BOTH the CTO fire and the CFO sweep:
 *
 *     SHAPE 1 is LOUD.   An empty `blockedBy` raises `stranded_assigned_issue`;
 *                        the platform wakes somebody. It also auto-flips, so the
 *                        issue stays visible even if nobody acts.
 *     SHAPE 2 is SILENT. NO recovery wake. NO monitor. NO auto-flip. And it was
 *                        invisible to THIS detector, because the old predicate
 *                        was `blockedBy.length === 0` and shape 2's array is not
 *                        empty — it is full of tombstones.
 *
 * The quiet failure is the one that needs the instrument. A green run of the
 * empty-only predicate was a 100%-confident all-clear on a board carrying three
 * live shape-2 strands (measured 2026-07-30T01:1xZ, CEO; two survived to
 * 02:5xZ). That is precisely the "a failing state that renders identically to a
 * passing one" case this file exists to refuse, so the differential control
 * `strandClassMissControl()` below pins it: the OLD predicate must report ZERO
 * on a board where the new one reports the planted strand.
 *
 * Shape 2 is graded from the `status` the item route inlines on each `blockedBy`
 * entry (measured on TRA-2305: entries carry id/identifier/title/status/
 * priority/assignee). An entry with NO `status` key is UNREADABLE, never
 * "closed" — absent is not closed, exactly as absent is not empty.
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
 * on an issue whose `blockedBy` is `[]` (measured on TRA-2331). `blockerAttention`
 * is printed here as context and is NEVER allowed to suppress a finding.
 *
 *   ⛔⛔ This includes the cheap-and-strictly-better substitute
 *   `unresolvedBlockerCount == 0`, routed in on TRA-2622 as catching BOTH shapes
 *   with zero misses over the whole `blocked` population. It DOES agree on
 *   today's board — I reproduced that: 81 blocked of 2625 issues, both
 *   predicates return exactly TRA-2305/TRA-2420/TRA-382. But the same sweep
 *   measures the rollup EXCEEDING the open-`blockedBy` count on 11 of 81 rows
 *   and falling below it on 0, so it is `#open blockedBy + #open descendants`
 *   with a one-directional inflation term. The three strands agreed only
 *   because they happened to carry no open descendants at that instant. TRA-1648
 *   is the live counterexample in waiting: rollup `4` over 3 `done` + 2 open
 *   blockers, so the moment those two close it is a shape-2 strand reading `2`
 *   and the substitute goes silent — on a stalled SUBTREE, the most expensive
 *   kind. `rollupMaskControl()` below pins this as a differential, because the
 *   prose warning that was already here did not prevent the substitution from
 *   being routed in as validated.
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
 * So: this script emits no ANCHOR-BEARING repair PATCH, ever. What it emits
 * instead is an ANCHOR VERDICT — every rollup candidate resolved against the
 * parent chain and every descendant/self/ancestor/closed one struck out. When
 * nothing survives, the true and actionable message is "no valid anchor: every
 * unresolved blocker in the rollup is a descendant", and that is what it prints.
 * The rollup COUNT is still printed: work really is parked downstream. Only the
 * anchor suggestion had to go.
 *
 *   ⚠ AMENDED, ONE COHORT ONLY (TRA-3451). The rule above is about a GUESSED
 *   restore. It does not reach a `stranded_assigned_issue` row, because there
 *   the restore target is READ, not guessed: the recovery payload carries
 *   `evidence.previousStatus` AND `returnOwnerAgentId` — the two values the CTO
 *   and CEO typed by hand 31 times on 2026-08-12 with zero judgement calls. For
 *   that cohort exactly (and only when the interaction route confirmed ZERO
 *   pending cards) the report emits the restore:
 *
 *        PATCH {"status":"todo"}                    ← never `done`; `todo` is
 *                                                     queue-visible AND still
 *                                                     counts upstream
 *
 *   It NEVER re-sends the write-only blocker key: there is no open anchor, and
 *   an empty write-key list reproduces the born-blocked state. The generic
 *   shape-1 no-repair rule is untouched — the discriminator is `restore target:
 *   KNOWN` vs `NONE`, which this script already computes. `deriveRepair()` is
 *   the branch; the global control now allows ONLY that one verb and still
 *   forbids the blocker key everywhere.
 *
 *   ⛔ AMENDED AGAIN (TRA-4041, MEASURED 2026-08-26). This block used to print a
 *   SECOND step — `PATCH {"assigneeAgentId": returnOwner}` — annotated "LAST; it
 *   is one-way". Both halves of that annotation were wrong, and the recipe as
 *   printed could not be executed by anybody:
 *
 *     · The predicted wall was a 403 from the assignee boundary. The REAL wall is
 *       `409 {"error":"Issue run ownership conflict"}`, and it is not the
 *       boundary at all — minting a live status on a strand SPAWNS A RUN, which
 *       takes the issue checkout lock. `checkoutRunId` goes null -> set on the
 *       step-1 PATCH; from that instant `actorRunId` no longer matches and every
 *       further PATCH on that row 409s.
 *     · So the prescribed ORDER is the one order that guarantees step 2 fails.
 *       The CFO ran it on 6 rows: step 1 succeeded 6/6, step 2 409'd 6/6.
 *     · And there is no order that works. Assignee-first hands the row away
 *       while it is still `blocked` + empty — still a strand — and 403s you out
 *       of fixing it. Status-first locks you out with the 409.
 *
 *   The second step was never load-bearing. Step 1 ALONE fully clears the
 *   strand: `activeRecoveryAction` went `stranded_assigned_issue:active` -> null
 *   on all 6 rows, and it is null on all four re-read here (TRA-3748/3755/3786/
 *   3758). So the recipe is ONE step. The return owner is still READ and still
 *   printed — as a NOTE for the platform, never as an agent-runnable verb.
 *
 *   ⚠ The step-1 PATCH does not always STORE `todo`: on a row a run picks up
 *   immediately it reads back `in_progress` (TRA-3758). That is fine and it is
 *   why the pass predicate is `activeRecoveryAction == null`, NOT `status ===
 *   'todo'` — the strand is the recovery action, not the status word.
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
 * ⛔ THE WAKE SUPPRESSION HAS AN EXPIRY (TRA-3451). A finding whose recovery
 * action is `active` with a `wake_owner` policy used to be annotated "platform
 * wake ALREADY ACTIVE … Do NOT file a duplicate" and dropped from the routing
 * table, unconditionally. The DETECTION was always right — the row is graded
 * shape 1 and printed either way — but the reporting rule then converted a
 * correct detection into a non-filing, and that is how this event recurred
 * three times (TRA-3105 62 rows, TRA-3365/TRA-3366, 2026-08-12's 47) with the
 * detector green-by-suppression every time.
 *
 * The premise "an active wake_owner action is a live continuation path" was
 * falsified at scale on 2026-08-12: 47 `stranded_assigned_issue` actions minted
 * in three bursts, ALL still `status: active` at `attemptCount: 1` when the
 * sweep read them — the oldest 13h old — and ZERO drained on their own; all 47
 * were cleared by hand. An active wake that has not advanced in 13h is not a
 * continuation path. It IS the strand.
 *
 * So the suppression is AGE-GATED: it applies only while the wake is FRESH AND
 * ADVANCING. "Advancing" is read off `lastAttemptAt` (an `attemptCount` bump
 * writes it), so a 13h-old action that retried five minutes ago still
 * suppresses, and a 3h-old one stuck at attempt 1 does not. Past the bound the
 * row is FILED and says why: "wake ACTIVE but STALE @ Nh, attemptCount 1 — not
 * draining". An action with NO readable timestamp is treated as STALE, not
 * fresh: the suppression must not be strongest exactly where we read least.
 *
 * The bound (`WAKE_STALE_AFTER_MS`) MUST stay well under the sweep interval.
 * The sweep that consumes this runs twice daily; a bound at or above ~12h means
 * a wake minted just after fire N is still "fresh" at fire N+1 and the board
 * goes silent for a whole cycle — the exact hole this replaces.
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
 * THE RESTORE TARGET — a VALUE with provenance, never a command (TRA-2617)
 * ------------------------------------------------------------------------
 * Every finding now carries the status it should be moved to, and WHY that
 * value was arrived at, so each owner is not left reconstructing intent alone.
 * Four provenances, in strict precedence:
 *
 *   FROM_EVIDENCE   `activeRecoveryAction.evidence.previousStatus` — the status
 *                   the leaf held before the run died. This makes shape 1 a
 *                   RESTORE rather than a judgement call (CFO, TRA-2617).
 *   GATE_SATISFIED  shape 2, every blocker `done` ⇒ `todo`. The gate really was
 *                   met; the work is actionable now.
 *   GATE_VOID       shape 2, but ≥1 blocker was `cancelled`. A cancelled gate did
 *                   NOT deliver what the dependent was waiting for, so the
 *                   dependent's own premise may be void. NO target is emitted —
 *                   this one needs a human read, and quietly saying `todo` here
 *                   would resurrect work whose reason was withdrawn.
 *   NONE            nothing supports a target. Re-derive.
 *
 * ⛔ AND ONE OVERRIDE THAT OUTRANKS ALL FOUR: a leaf holding a LIVE PENDING
 * INTERACTION rests at `in_review`, never `todo`. Measured the hard way on
 * TRA-2598 during this very issue: it was routed to me as "PATCH it to `todo`"
 * off an accurate 01:1xZ read, but by 02:4xZ the work had shipped (13968e8) and
 * the leaf was `in_review` behind a pending `request_confirmation`. Demoting it
 * to `todo` would have re-opened finished work AND buried a live decision
 * request that a human was expected to answer. So: pending card ⇒ `in_review`,
 * and the report prints the value that was overridden.
 *
 * ⛔ Fail closed on this override. If the interaction route cannot be read we do
 * NOT get to assume there is no card — an unreadable thread suppresses any
 * DEMOTING target and says so. The guard must not be weakest exactly where we
 * read least (same rule as the cause branch above).
 *
 * ⛔ The target is rendered as `restore target: <status>` — a value and a
 * reason. It is NEVER rendered as a PATCH, and the global control still asserts
 * that no report anywhere emits a copy-pasteable write (TRA-2396).
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
 *
 * The paged, offset-proving enumerator now lives in
 * `scripts/lib/paperclip-enumeration.mjs` so a second detector
 * (`check-phantom-rest.mjs`, TRA-2422) could share the guard instead of
 * re-implementing it. It could not simply `import` THIS file: `main()` runs at
 * module scope here, so an import would perform a live sweep and exit the
 * importer. Behaviour is unchanged and the selftest below still exercises it
 * through this re-export.
 * ------------------------------------------------------------------ */

export { enumerateIssues } from './lib/paperclip-enumeration.mjs';
import { enumerateIssues } from './lib/paperclip-enumeration.mjs';
import { pathToFileURL } from 'node:url';

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
const OWNER_LINK = /Recovery owner:\s*\[([^\]]+)\]\([^)]*agents\/([^)/\s]+)\)/;

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

/* ------------------------------------------------------------------ *
 * The two strand shapes (TRA-2617)
 * ------------------------------------------------------------------ */

export const SHAPE = {
  /** `blocked`, `blockedBy: []`. Loud: raises a recovery wake, auto-flips. */
  EMPTY_BLOCKED_BY: 'EMPTY_BLOCKED_BY',
  /** `blocked`, blockers present, every one of them closed. SILENT: no wake, no flip. */
  ALL_BLOCKERS_CLOSED: 'ALL_BLOCKERS_CLOSED',
};

/**
 * Grade one `blockedBy` array. Pure.
 *
 * Three outcomes, and the third is the one that keeps this honest:
 *   { shape: EMPTY_BLOCKED_BY }        nothing in the array
 *   { shape: ALL_BLOCKERS_CLOSED }     every entry `done`/`cancelled`
 *   { shape: null }                    ≥1 entry still open — a LEGAL rest, stay silent
 *   { unreadable: '…' }                an entry carries no `status` key
 *
 * ⛔ The unreadable arm is load-bearing. If entries ever stop carrying `status`,
 * `b.status in CLOSED` is false for every entry, every board reads as a legal
 * rest, and this whole class silently stops being detected — the exact failure
 * that shipped the empty-only predicate. Absent is not closed.
 */
export function gradeBlockerSet(blockedBy, label = 'issue') {
  const list = Array.isArray(blockedBy) ? blockedBy : [];
  if (list.length === 0) {
    return { shape: SHAPE.EMPTY_BLOCKED_BY, closed: [], open: [], cancelled: [] };
  }

  const missing = list.filter((b) => !b || !Object.prototype.hasOwnProperty.call(b, 'status'));
  if (missing.length) {
    return {
      unreadable:
        `${label}: ${missing.length} of ${list.length} blockedBy entr(ies) carry no 'status' key — the ` +
        `all-blockers-closed class cannot be graded. Absent is not closed.`,
    };
  }

  const closed = list.filter((b) => CLOSED_STATUSES.has(String(b.status)));
  const open = list.filter((b) => !CLOSED_STATUSES.has(String(b.status)));
  const cancelled = list.filter((b) => String(b.status) === 'cancelled');

  if (open.length > 0) return { shape: null, closed, open, cancelled };
  return { shape: SHAPE.ALL_BLOCKERS_CLOSED, closed, open, cancelled };
}

/* ------------------------------------------------------------------ *
 * The platform wake — a suppression with an EXPIRY (TRA-3451)
 *
 * See the header. An `active` `wake_owner` recovery action suppresses ROUTING
 * (never detection) only while it is fresh AND advancing. Everything else
 * files.
 * ------------------------------------------------------------------ */

/**
 * How long an unadvanced `active` wake may still be called a continuation path.
 *
 * ⛔ Do not raise this to "safely" above the observed drain time. It is bounded
 * ABOVE by the sweep interval, not below by platform latency: the twice-daily
 * sweep is the reader, so a bound ≥ ~12h means a wake minted right after one
 * fire is still "fresh" at the next one and nothing is ever filed. 2h is well
 * under the 13h non-drain measured on 2026-08-12 and well under half a cycle.
 * A false FILE costs one extra row in a report; a false SUPPRESS costs a
 * silent board, which is the defect this constant exists to fix.
 */
export const WAKE_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

const hoursOf = (ms) => (ms === null || ms === undefined ? null : Math.round((ms / 3600000) * 10) / 10);

/**
 * Grade the platform wake attached to a recovery action. Pure; `nowMs` is
 * injected so the controls can pin both branches instead of racing the clock.
 *
 * Returns `null` when there is no live wake at all (no recovery, not `active`,
 * or no `wake_owner` policy) — i.e. nobody is coming for this one.
 *
 * `suppresses` is the ONLY field the routing table may read. `stale` is the
 * reason, and both are printed.
 */
export function gradeWake(recovery, nowMs) {
  if (!recovery || recovery.status !== 'active') return null;
  const policy = recovery.wakePolicy || null;
  if (!policy || policy.type !== 'wake_owner') return null;

  const ownerAgentId = policy.ownerAgentId || recovery.ownerAgentId || null;
  const attemptCount = Number.isFinite(recovery.attemptCount) ? recovery.attemptCount : null;
  // The ADVANCE stamp, not the birth stamp. `attemptCount` bumps write
  // `lastAttemptAt`, so this is the stateless equivalent of "did attemptCount
  // increase since the previous fire" — and it is strictly better, because it
  // needs no memory of the previous fire to answer.
  const lastAdvanceAt = recovery.lastAttemptAt || recovery.updatedAt || recovery.createdAt || null;
  const advanceMs = lastAdvanceAt ? Date.parse(lastAdvanceAt) : NaN;

  if (!Number.isFinite(advanceMs) || !Number.isFinite(nowMs)) {
    // Fail LOUD, in the filing direction. An unreadable stamp cannot establish
    // that the wake is advancing, and the whole bug was a suppression that did
    // not have to prove anything.
    return {
      ownerAgentId,
      attemptCount,
      lastAdvanceAt,
      ageMs: null,
      ageHours: null,
      stale: true,
      suppresses: false,
      why:
        'no readable advance timestamp on the recovery action — freshness could NOT be established, so the ' +
        'suppression does not apply. Absent is not fresh.',
    };
  }

  const ageMs = nowMs - advanceMs;
  const stale = ageMs > WAKE_STALE_AFTER_MS;
  return {
    ownerAgentId,
    attemptCount,
    lastAdvanceAt,
    ageMs,
    ageHours: hoursOf(ageMs),
    stale,
    suppresses: !stale,
    why: stale
      ? `wake ACTIVE but STALE @ ${hoursOf(ageMs)}h since its last attempt` +
        `${attemptCount === null ? '' : `, attemptCount ${attemptCount}`} — not draining. ` +
        'An active action that has not advanced is not a continuation path, it IS the strand ' +
        '(measured 2026-08-12: 47 of 47 sat active at attempt 1, oldest 13h, zero drained).'
      : `wake ACTIVE and fresh @ ${hoursOf(ageMs)}h since its last attempt` +
        `${attemptCount === null ? '' : `, attemptCount ${attemptCount}`} — inside the ` +
        `${hoursOf(WAKE_STALE_AFTER_MS)}h bound, so the owner really is being poked right now.`,
  };
}

/* ------------------------------------------------------------------ *
 * Restore target — a value + provenance. Never a command.
 * ------------------------------------------------------------------ */

export const RESTORE = {
  FROM_EVIDENCE: 'FROM_EVIDENCE',
  GATE_SATISFIED: 'GATE_SATISFIED',
  GATE_VOID: 'GATE_VOID',
  HOLD_FOR_CARD: 'HOLD_FOR_CARD',
  NONE: 'NONE',
};

/** Statuses that would DEMOTE a leaf, i.e. the ones the pending-card guard must veto. */
const DEMOTING = new Set(['todo', 'backlog']);

/**
 * Where the CFO's deterministic restore lives. Read defensively through both
 * the documented path and a couple of neighbours: this is reported from the
 * CFO's sweep rather than measured here (no blocked issue on the board carried
 * a live `activeRecoveryAction` at the time this was written, 2026-07-30T02:5xZ),
 * so a wrong single path would silently degrade to "no evidence" forever.
 */
export function previousStatusFrom(item) {
  const ra = (item && item.activeRecoveryAction) || null;
  if (!ra) return null;
  const ev = ra.evidence || ra.details || null;
  const v = (ev && (ev.previousStatus || ev.priorStatus)) || ra.previousStatus || null;
  return typeof v === 'string' && v ? v : null;
}

/**
 * Decide the status this leaf should be moved to. Pure.
 *
 * `pendingInteractions` is a COUNT, or `null` meaning "the route could not be
 * read". null is NOT zero — it suppresses any demoting target rather than
 * asserting there is no card.
 */
export function deriveRestoreTarget({ item, blockers, pendingInteractions }) {
  const previousStatus = previousStatusFrom(item);

  let target = null;
  let provenance = RESTORE.NONE;
  let why = '';

  if (previousStatus) {
    target = previousStatus;
    provenance = RESTORE.FROM_EVIDENCE;
    why =
      `activeRecoveryAction.evidence.previousStatus = \`${previousStatus}\` — the status this leaf held ` +
      'before the run died. This is a RESTORE, not a judgement call.';
  } else if (blockers.shape === SHAPE.ALL_BLOCKERS_CLOSED && blockers.cancelled.length > 0) {
    provenance = RESTORE.GATE_VOID;
    why =
      `NO target emitted: ${blockers.cancelled.length} blocker(s) were CANCELLED ` +
      `(${blockers.cancelled.map((b) => b.identifier || b.id).join(', ')}), not completed. A cancelled gate ` +
      'never delivered what this issue was waiting for, so its own premise may be void — parking it to ' +
      '`todo` would resurrect work whose reason was withdrawn. Read it and decide.';
  } else if (blockers.shape === SHAPE.ALL_BLOCKERS_CLOSED) {
    target = 'todo';
    provenance = RESTORE.GATE_SATISFIED;
    why =
      `every blocker is \`done\` (${blockers.closed.map((b) => b.identifier || b.id).join(', ')}) — the gate ` +
      'was genuinely satisfied, so this is actionable work, not a per-fire spawn. `todo` keeps it counting ' +
      'as an unresolved blocker for anything upstream, so nothing is lost by parking it.';
  } else {
    why =
      'no `evidence.previousStatus` and no satisfied gate to derive from — re-derive what this issue ' +
      'waits on today, or `todo` if the answer is nothing.';
  }

  // ⛔ The override. A pending card outranks every derivation above.
  if (pendingInteractions === null) {
    if (target && DEMOTING.has(target)) {
      return {
        target: null,
        provenance: RESTORE.NONE,
        overrode: { target, provenance },
        why:
          `target \`${target}\` SUPPRESSED: the interaction route could not be read, so the absence of a live ` +
          'pending card was never established. An unreadable thread is not an empty one — check ' +
          '/interactions by hand before demoting this leaf. ' +
          `(suppressed derivation: ${why})`,
      };
    }
    return { target, provenance, overrode: null, why: `${why} (pending-card check unavailable — verify before demoting)` };
  }

  if (pendingInteractions > 0) {
    return {
      target: 'in_review',
      provenance: RESTORE.HOLD_FOR_CARD,
      overrode: target ? { target, provenance } : null,
      why:
        `${pendingInteractions} LIVE PENDING interaction(s) on this issue. A leaf holding a card rests at ` +
        '`in_review` — it has a real continuation path. ' +
        (target && DEMOTING.has(target)
          ? `This OVERRIDES the derived \`${target}\`, which would have re-opened the work AND buried a decision ` +
            'a human is expected to answer (measured on TRA-2598, TRA-2617).'
          : 'Derivation agreed or was empty; the card settles it either way.'),
    };
  }

  return { target, provenance, overrode: null, why };
}

/* ------------------------------------------------------------------ *
 * The repair — emitted for ONE cohort, where the target is READ (TRA-3451)
 * ------------------------------------------------------------------ */

/**
 * Pure. Decide whether this finding's repair is mechanical, and what it is.
 *
 * ELIGIBLE requires all four, and every one of them is a READ, not a guess:
 *
 *   1. `recoveryKind === 'stranded_assigned_issue'` — the platform's own
 *      terminal-run recovery wrote this `blocked`. No agent intended an anchor.
 *   2. `restoreTarget.provenance === FROM_EVIDENCE` — the payload carried
 *      `evidence.previousStatus`, so the leaf's prior state is known.
 *   3. `returnOwnerAgentId` (or `previousOwnerAgentId`) is present — the real
 *      owner is NAMED in the payload; we are not inferring it from the thread.
 *   4. `pendingInteractions === 0` — KNOWN zero, never `null`. The repair
 *      demotes to `todo`, and demoting a leaf that holds a live card buries a
 *      decision a human is expected to answer (TRA-2598). Unknown ⇒ no repair.
 *
 * ⛔ The written status is `todo`, NOT the `previousStatus` that was read.
 * `in_progress` is what the recovery reconciler mints strands FROM: restoring
 * it hands back a leaf with no live run, which the next reconciler pass
 * re-blocks. `todo` is queue-visible AND still counts as an unresolved blocker
 * upstream, so nothing is lost. And never `done` — that discards the work.
 *
 * ⛔ There is NO assignee write (TRA-4041). `assigneeAgentId` is still returned
 * here — it is a READ off the payload and the report names it — but it is not a
 * step. The status PATCH spawns a run that takes the issue checkout lock, so
 * every subsequent PATCH on that row returns `409 Issue run ownership conflict`
 * (measured 6/6). Step 1 alone clears the strand; step 2 was unexecutable and
 * unnecessary.
 */
/**
 * Is this row a routine spawn whose non-terminal rest is SUPPRESSING its own
 * routine? (TRA-4041)
 *
 * Measured 2026-08-26: 28 of 43 active routines last fired 2026-08-16 or
 * earlier while every one of them reported a FUTURE `nextRunAt`. Of the 15 still
 * firing, ZERO have a non-terminal latest leaf; 8 of the 28 frozen ones do. On
 * `concurrencyPolicy: coalesce_if_active` (all three drain arms) a fire that
 * lands while the previous execution issue is still open COALESCES into it
 * instead of running, so one leaf left at `todo` or `in_progress` silently
 * stops the routine — and `nextRunAt` keeps advancing, which is why a census
 * reads it as armed.
 *
 * The sting: `todo` is the RIGHT restore for a durable strand and the WRONG one
 * for a per-fire spawn. Restoring a drain leaf to `todo` disables the drain. The
 * routines' own RESTING DISPOSITION block already rules on this — "per-fire
 * spawn (originKind: routine_execution) that blocks nothing -> status done" —
 * and the drain, which knows nothing about routine spawns, writes `todo` to
 * everything.
 *
 * Not only `coalesce_if_active`. TRA-4058's origin routine 82daa7b2 is
 * `skip_if_active`, where the later fire is DROPPED rather than merged — same
 * end state, one degree worse, because a coalesced fire at least runs once.
 * The rule keys on the SHAPE of the row, not on the policy, so it catches both
 * without having to read the routine at all.
 *
 * ⛔ THIS PREDICATE NOW AUTHORISES A WRITE (TRA-4063, 2026-08-26). It was a
 * report-only class for exactly one day, on the reasoning that widening an
 * unattended writer to send `done` was the routine owner's call. The 08-26T12:30Z
 * drain fire settled that: it planned `-> todo` for TRA-4058 and only a hand
 * catch stopped it, so the report-only version was strictly worse than no class
 * at all — it named the harm in the log while the sibling script did it. The
 * drain consumes THIS function (`drain-blocked-empty.mjs`), so there is one
 * predicate and two readers, and `done` is unreachable for any row it rejects.
 *
 * Conservative on both unknowns: an absent `blocks` key reads as "gates
 * something" (do not touch), never as empty, and an absent `originKind` reads as
 * "not known to be durable either" — the drain refuses BOTH statuses on those
 * rows rather than falling back to the generic one.
 */
export function suppressesOwnRoutine(f) {
  return f.originKind === 'routine_execution' && f.blocksKnown === true && f.blocksIdentifiers.length === 0;
}

/**
 * Discharge evidence for a `done` restore (TRA-4817, CFO ask 2026-09-23).
 *
 * A suppressing-leaf `done` is warranted by the CLASS (a per-fire spawn that
 * gates nothing must not rest non-terminal) — but WHAT the close records
 * depends on whether the fire's work actually discharged. TRA-4804 is the live
 * case: the fire's owner published the verdict at 22:47:56Z, the cascade
 * re-parked the leaf at 22:48:22Z — 26 seconds later — so only the terminal
 * status PATCH was lost with the run, and `done` buried nothing. The old print
 * asserted "already terminal" off nothing; the payload's `previousStatus`
 * (`in_progress`, `completedAt: null`) contradicted it. This function reads
 * the thread so the report can CITE the evidence instead of asserting it.
 *
 * Pure, and deliberately modest: it names the newest non-system comment and
 * where it sits relative to the recovery park. Whether that comment IS the
 * fire's published verdict is the assignee's judgement — the report hands them
 * the pointer, it does not grade verdict-ness.
 */
export function deriveDischargeEvidence({ comments, commentsError, recovery }) {
  if (commentsError) return { state: 'UNREAD', detail: commentsError };
  if (!Array.isArray(comments)) return { state: 'UNREAD', detail: 'the comment route returned a non-array' };
  const newest = comments
    .filter((c) => c && !c.deletedAt && !isSystemAuthored(c))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  if (!newest) return { state: 'NONE' };
  const parkAt = recovery && recovery.createdAt ? Date.parse(recovery.createdAt) : NaN;
  const at = newest.createdAt ? Date.parse(newest.createdAt) : NaN;
  let beforePark = null;
  let gapText = null;
  if (Number.isFinite(parkAt) && Number.isFinite(at)) {
    beforePark = at <= parkAt;
    const gapS = Math.round(Math.abs(parkAt - at) / 1000);
    gapText = gapS < 120 ? `${gapS}s` : `${Math.round(gapS / 60)}min`;
  }
  return {
    state: 'FOUND',
    at: newest.createdAt || '?',
    authorAgentId: newest.authorAgentId || null,
    beforePark,
    gapText,
  };
}

export function deriveRepair(f) {
  const no = (why) => ({ eligible: false, status: null, assigneeAgentId: null, restoredFrom: null, why });

  if (f.recoveryKind !== 'stranded_assigned_issue') {
    return no(
      `restore target is not mechanically known for recovery kind \`${f.recoveryKind || 'none'}\` — the generic ` +
        'rule stands (TRA-2396): routing is this detector\'s job and the anchor is the assignee\'s to re-derive.',
    );
  }
  if (!f.recoveryReturnOwnerAgentId) {
    return no(
      'a `stranded_assigned_issue` row, but NO `returnOwnerAgentId` in the payload — the second step would be a ' +
        'guess at who owns it. Route it instead.',
    );
  }
  // Ordered BEFORE the provenance test on purpose: a live card REWRITES the
  // restore target to `in_review`, so testing provenance first would report
  // "no evidence.previousStatus" on a row that plainly carried one.
  if (f.pendingInteractions !== 0) {
    return no(
      `pending interactions: ${f.pendingInteractions === null ? 'UNKNOWN (route unread)' : f.pendingInteractions} — ` +
        'the repair demotes to `todo` and a leaf holding a live card rests at `in_review`. Unknown is not zero.',
    );
  }
  const rt = f.restoreTarget || {};
  if (rt.provenance !== RESTORE.FROM_EVIDENCE || !rt.target) {
    return no(
      'a `stranded_assigned_issue` row, but the payload carried no `evidence.previousStatus` — the restore ' +
        `target is ${rt.target ? `\`${rt.target}\` from ${rt.provenance}` : 'NONE'}, which is a derivation, not a read.`,
    );
  }
  return {
    eligible: true,
    status: 'todo',
    assigneeAgentId: f.recoveryReturnOwnerAgentId,
    restoredFrom: rt.target,
    why:
      `ELIGIBILITY was read off the payload: \`evidence.previousStatus\` = \`${rt.target}\` and returnOwnerAgentId ` +
      'are both present. The read is a PRECONDITION, not the write — the printed status is DERIVED: `todo` for a ' +
      'dead run (writing back the read `in_progress` re-mints the strand the repair is clearing), `done` only for ' +
      'a suppressing leaf. Never describe the printed target as "read off previousStatus": measured 2026-09-23 it ' +
      'matched the payload 0/4, by design (TRA-4817).',
  };
}

/**
 * Grade ONE item-route payload.
 *
 * `null` means "not in the shape". A string reason on `.unreadable` means the
 * payload could not be graded at all — which is BLIND, not clean.
 */
export function classifyIssue(item, roster, { graph = null, now = null } = {}) {
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
  // TWO shapes, not one. The old predicate here was `blockedBy.length > 0 =>
  // return null`, which made shape 2 (every blocker closed) structurally
  // undetectable — the array is not empty, it is full of tombstones.
  const blockers = gradeBlockerSet(blockedBy, item.identifier || item.id);
  if (blockers.unreadable) return { unreadable: blockers.unreadable };
  if (!blockers.shape) return null; // ≥1 open blocker — legitimately held, stay silent.

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
    // WHICH strand shape. Shape 2 is the silent one — no recovery wake, no
    // monitor, no auto-flip — so it is reported first in the render.
    shape: blockers.shape,
    // The gate(s) that buried a shape-2 leaf, with the identifier of the issue
    // whose close stranded it. This is the feedback loop: the closer is the one
    // who needs to start sweeping `blocks` on close.
    closedBlockers: blockers.closed.map((b) => ({
      identifier: b.identifier || b.id || null,
      status: b.status || null,
      assigneeAgentId: b.assigneeAgentId || null,
    })),
    cancelledBlockerCount: blockers.cancelled.length,
    // What this leaf itself gates. A shape-2 strand that blocks something else
    // is not one stalled issue, it is a stalled subtree (TRA-2305 -> TRA-2268).
    blocksIdentifiers: Array.isArray(item.blocks)
      ? item.blocks.map((b) => `${b.identifier || b.id}${b.status ? `:${b.status}` : ''}`)
      : [],
    // ⛔ ABSENT IS NOT EMPTY. `blocksIdentifiers` falls back to `[]` on a payload
    // that carries no `blocks` key at all, so it alone cannot answer "does this
    // gate anything?" — and the suppressing-leaf rule below turns on exactly
    // that question. Keep the two readable apart (TRA-4041).
    blocksKnown: Array.isArray(item.blocks),
    // Read for the suppressing-leaf rule. `routine_execution` is a per-fire
    // spawn; anything else is durable work.
    originKind: item.originKind || null,
    // ⛔ ABSENT IS NOT `manual`, exactly as absent is not empty one field up.
    // `originKind || null` collapses "the route did not send the key" into
    // "the value is null", and the drain writes a DIFFERENT status per class
    // (TRA-4063), so the two have to stay readable apart at the decision.
    originKnown: Object.prototype.hasOwnProperty.call(item, 'originKind') && !!item.originKind,
    // WHICH routine spawned it. Not a classification input — the class is
    // decided by `originKind` + `blocks` off this same payload — but the drain
    // has to NAME the routine it is keeping alive, and a report that says
    // "some routine" is not auditable.
    originId: item.originId || null,
    // Filled in by sweep() once the interaction route has been read. A finding
    // that never got there keeps `null` (= unknown), which SUPPRESSES any
    // demoting target rather than asserting there is no card.
    pendingInteractions: null,
    restoreTarget: null,
    // Filled in by sweep() for suppressing leaves only — the `done` restore must
    // cite its discharge evidence, never assert it (TRA-4817). null = not scanned.
    discharge: null,
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
    recoveryAttemptCount: recovery && Number.isFinite(recovery.attemptCount) ? recovery.attemptCount : null,
    // The agent the recovery action says the issue belongs BACK to. This is the
    // second half of the mechanical repair (TRA-3451) and it is a READ: the
    // platform names it on the payload. `previousOwnerAgentId` is the same value
    // on every row measured so far; it is a fallback, not an inference.
    recoveryReturnOwnerAgentId: recovery ? recovery.returnOwnerAgentId || recovery.previousOwnerAgentId || null : null,
    // TRA-4832 — the OWNERSHIP half of the same write. The recovery service's
    // `escalateStrandedAssignedIssue` writes `status: "blocked"` AND
    // `assigneeAgentId: recoveryAction.ownerAgentId ?? <previous assignee>` in
    // ONE `issuesSvc.update` (re-read in the live platform build 2026-09-23),
    // so "why is this blocked" and "why am I suddenly 403 on it" are ONE
    // incident — and the transfer only happens when the action carries an
    // `ownerAgentId`, so both arms genuinely occur and both must be printable.
    recoveryActionId: recovery ? recovery.id || null : null,
    recoveryActionOwnerAgentId: recovery ? recovery.ownerAgentId || null : null,
    // ⛔ THREE-state. `true`/`false` only when the pre-strand owner is READABLE
    // off the payload; an absent `returnOwnerAgentId`/`previousOwnerAgentId` is
    // `null` = UNKNOWN — possibly laundered by a hand PATCH that omitted the
    // assignee (TRA-3196; that field is not writable through the issue API, so
    // the corruption is uncorrectable). Absent is not "unchanged".
    ownershipTransferred:
      recovery && (recovery.returnOwnerAgentId || recovery.previousOwnerAgentId)
        ? (recovery.returnOwnerAgentId || recovery.previousOwnerAgentId) !== assigneeAgentId
        : null,
    // Whether anyone is ALREADY being woken for this. Both are findings — the
    // shape is the defect either way — but only a row with no live wake needs a
    // fresh one, and filing against a live one is a duplicate wake on an owner
    // the platform is already poking. Do not remediate overload with a fan-out.
    //
    // ⛔ "Live" is AGE-GATED (TRA-3451). This field says an active wake_owner
    // action EXISTS; `platformWake.suppresses` says whether it is still
    // advancing. Only the second may remove a row from the routing table — the
    // unconditional read is what went silent on 47 rows.
    platformWakeOwnerAgentId:
      recovery && recovery.status === 'active' && recovery.wakePolicy && recovery.wakePolicy.type === 'wake_owner'
        ? recovery.wakePolicy.ownerAgentId || recovery.ownerAgentId || null
        : null,
    platformWake: gradeWake(recovery, Number.isFinite(now) ? now : Date.now()),
    // Filled in by sweep() once the restore target and the interaction count are
    // known — both are inputs to the eligibility test.
    repair: null,
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

export async function sweep({ getIssuesPage, getIssue, listAgents, getComments, getInteractions }, opts = {}) {
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
  // One clock for the whole sweep, injectable so the wake-age controls pin a
  // branch instead of racing the wall clock.
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
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
      const graded = classifyIssue(item, roster, { graph, now: nowMs });
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
      // A suppressing leaf gets its thread read EVEN under a live recovery
      // action: its restore prints `done`, and a `done` must cite discharge
      // evidence from the thread, never assert it off the payload (TRA-4817).
      const settledWithoutRead = entry.item.activeRecoveryAction && !suppressesOwnRoutine(entry.graded);
      if (settledWithoutRead) {
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
      if (suppressesOwnRoutine(entry.graded)) {
        entry.graded.discharge = deriveDischargeEvidence({
          comments,
          commentsError,
          recovery: entry.item.activeRecoveryAction || null,
        });
      }
    }),
  );

  // Restore target. One interaction GET per FINDING (not per blocked issue, not
  // on a clean board) — because a leaf holding a live card rests at `in_review`
  // and must never be handed a `todo` target (TRA-2598).
  //
  // ⛔ Fail closed: a route that throws, or no transport at all, leaves
  // `pendingInteractions: null` — UNKNOWN, which suppresses a demoting target.
  // It must not read as "no card".
  await Promise.all(
    hits.map(async (entry) => {
      let pending = null;
      if (typeof getInteractions === 'function') {
        try {
          const list = await getInteractions(entry.graded.id);
          if (Array.isArray(list)) pending = list.filter((x) => x && x.status === 'pending').length;
        } catch {
          pending = null; // stays UNKNOWN on purpose
        }
      }
      const blockers = gradeBlockerSet(entry.item.blockedBy, entry.graded.identifier || entry.graded.id);
      entry.graded.pendingInteractions = pending;
      entry.graded.restoreTarget = deriveRestoreTarget({
        item: entry.item,
        blockers,
        pendingInteractions: pending,
      });
      // Strictly last: eligibility reads BOTH the restore target and the
      // interaction count, so it cannot be computed in classifyIssue().
      entry.graded.repair = deriveRepair(entry.graded);
    }),
  );

  const findings = hits.map((e) => e.graded);

  // An item read we could not grade is a hole in the population, exactly like
  // a dropped page. Fail closed.
  const blind = unreadable.length
    ? `${unreadable.length} of ${blockedRows.length} blocked issue(s) could not be graded through the item route`
    : null;

  // Shape 2 first WITHIN each severity: it is the silent one, so it is the one a
  // reader skimming a long report must not miss.
  const shapeRank = (f) => (f.shape === SHAPE.ALL_BLOCKERS_CLOSED ? 0 : 1);
  findings.sort(
    (a, b) =>
      String(a.severity).localeCompare(String(b.severity)) ||
      shapeRank(a) - shapeRank(b) ||
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
    // TRA-4832 — who is READING this report. The resolve-restore verb is only
    // executable by the recovery action's own owner (or the current assignee /
    // board — `assertRecoveryActionAuthority` in the platform's issues routes,
    // re-read 2026-09-23), so the render prints it only when the runner IS that
    // owner. `null` = unknown runner = never print an executable verb.
    runnerAgentId: opts.runnerAgentId || null,
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
    L.push('CLEAN  no issue is `blocked` with an empty blockedBy, and none is `blocked` behind');
    L.push('       a blocker set in which every entry is already closed.');
    L.push('       Scoped to this instant only. BOTH shapes re-appear on their own: shape 1 on');
    L.push('       whatever is `in_progress` at the next session-limit event, shape 2 the next');
    L.push('       time anybody closes a gate without sweeping its `blocks`. Re-run; do not');
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

  const nEmpty = result.findings.filter((f) => f.shape === SHAPE.EMPTY_BLOCKED_BY).length;
  const nClosed = result.findings.filter((f) => f.shape === SHAPE.ALL_BLOCKERS_CLOSED).length;
  L.push(`${result.verdict}  ${result.findings.length} stranded \`blocked\` leaf/leaves.`);
  L.push(`   ${String(nEmpty).padStart(3)}  shape 1  EMPTY blockedBy       (LOUD — raises a recovery wake, auto-flips)`);
  L.push(`   ${String(nClosed).padStart(3)}  shape 2  ALL blockers CLOSED  (SILENT — no wake, no monitor, no auto-flip)`);
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
      const shapeLabel =
        f.shape === SHAPE.ALL_BLOCKERS_CLOSED ? 'shape 2 ALL-BLOCKERS-CLOSED (SILENT)' : 'shape 1 EMPTY-blockedBy (loud)';
      L.push(`   ${String(f.identifier || f.id).padEnd(10)} ${String(f.priority || '').padEnd(8)} ${who}   [${shapeLabel}]`);
      L.push(`     ${String(f.title || '').slice(0, 120)}`);
      if (f.shape === SHAPE.ALL_BLOCKERS_CLOSED) {
        const gates = (f.closedBlockers || [])
          .map((b) => `${b.identifier}:${b.status}`)
          .join(', ');
        L.push(`     buried by  ${gates || '(none listed)'}  — closing that gate is what stranded this leaf`);
        if (f.blocksIdentifiers && f.blocksIdentifiers.length) {
          L.push(
            `     ⚠ this leaf itself BLOCKS ${f.blocksIdentifiers.join(', ')} — a stalled SUBTREE, not one issue`,
          );
        }
      }
      const rt = f.restoreTarget || { target: null, provenance: RESTORE.NONE, why: 'not computed' };
      L.push(
        `     restore target: ${rt.target ? `\`${rt.target}\`` : 'NONE'}  (${rt.provenance})` +
          (rt.overrode ? `  [overrides \`${rt.overrode.target}\` from ${rt.overrode.provenance}]` : ''),
      );
      L.push(`       ${rt.why}`);
      L.push(
        `     pending interactions: ${
          f.pendingInteractions === null ? 'UNKNOWN (route unread — do not assume none)' : f.pendingInteractions
        }`,
      );
      const wakeOwner = f.platformWakeOwnerAgentId
        ? (result.roster.get(f.platformWakeOwnerAgentId) || {}).name || f.platformWakeOwnerAgentId
        : null;
      L.push(
        `     blockerAttention=${f.blockerAttentionState || 'null'}/${f.blockerAttentionReason || 'null'} (context only)` +
          `  recovery=${f.recoveryKind || 'none'}${f.recoveryCause ? `/${f.recoveryCause}` : ''}` +
          `${f.recoveryStatus ? `:${f.recoveryStatus}` : ''}${f.recoveryAt ? ` @ ${f.recoveryAt}` : ''}`,
      );
      const wake = f.platformWake || null;
      if (!wakeOwner) {
        L.push('     no platform wake — nobody is coming for this one unless it is routed.');
      } else if (wake && wake.suppresses) {
        L.push(`     platform wake ACTIVE and ADVANCING -> ${wakeOwner}. Do NOT file a duplicate; the owner is being poked.`);
        L.push(`       ${wake.why}`);
      } else {
        L.push(
          `     platform wake ACTIVE but STALE -> ${wakeOwner}` +
            `${wake && wake.ageHours !== null ? ` @ ${wake.ageHours}h` : ''}` +
            `${wake && wake.attemptCount !== null ? `, attemptCount ${wake.attemptCount}` : ''}` +
            ' — NOT draining. FILE IT.',
        );
        L.push(`       ${wake ? wake.why : 'freshness could not be established'}`);
      }
      // The repair. Emitted ONLY where the restore target and the owner were both
      // READ off the recovery payload (TRA-3451); every other row keeps the
      // generic no-command rule (TRA-2396) and prints the reason it kept it.
      const rep = f.repair || null;
      if (rep && rep.eligible) {
        const back = (result.roster.get(rep.assigneeAgentId) || {}).name || rep.assigneeAgentId;
        // TRA-4574 — ONE PREDICATE, TWO READERS, and they used to DISAGREE.
        // `deriveRepair` hardcodes `todo`; the drain overrides it to `done` for the
        // suppressing-leaf class (`drain-blocked-empty.mjs`, the positive test ordered
        // BEFORE `deriveRepair`). This emitter consumed `rep.status` raw, so on those
        // rows it printed `{"status":"todo"}` — and then the SUPPRESSING LEAF block a
        // few lines below called that exact write "actively harmful". An operator
        // obeying this routine's own "RUN THEM AS PRINTED" mandate switched the
        // routine off. Measured 2026-09-16: 11 of 30 findings carried the marker.
        // The emitter now mirrors the drain's ordering, so there is one disposition.
        const repStatus = suppressesOwnRoutine(f) ? 'done' : rep.status;
        L.push('     repair KNOWN (stranded_assigned_issue) — ONE step, and one step only:');
        L.push(`       RESTORE-PATCH 1/1  PATCH /api/issues/${f.id} {"status":"${repStatus}"}`);
        L.push(`       ${rep.why}`);
        if (repStatus === 'done') {
          L.push(
            '       `done`, NOT the generic `todo`: this row is a SUPPRESSING LEAF (see the block below) and `todo` ' +
              'there keeps its own routine off. This is the drain\'s disposition for the class, printed here so the ' +
              'command and the block below cannot disagree.',
          );
          // TRA-4817 — a `done` restore CITES its discharge evidence; it never
          // asserts "already terminal" off a payload whose previousStatus says
          // the opposite (measured: `in_progress` + completedAt null on the row
          // whose work HAD in fact discharged, 26s before the park).
          const d = f.discharge || { state: 'UNREAD', detail: 'discharge scan did not run on this row' };
          if (d.state === 'FOUND') {
            const who = (result.roster.get(d.authorAgentId) || {}).name || d.authorAgentId || 'a user';
            L.push(
              `       discharge evidence IN-THREAD: newest non-system comment by ${who} @ ${d.at}` +
                (d.beforePark === true
                  ? ` — ${d.gapText} BEFORE the recovery park`
                  : d.beforePark === false
                    ? ' — AFTER the recovery park'
                    : '') +
                '. Read it before landing the PATCH: if it is the fire\'s published verdict, only the terminal ' +
                'status write was lost with the run and this `done` buries nothing.',
            );
          } else {
            L.push(
              `       ⚠ NO discharge evidence found in-thread (${
                d.state === 'UNREAD' ? `thread UNREAD: ${d.detail}` : 'no non-system comment exists at all'
              }) — this \`done\` rests on the CLASS RULE alone, not on any claim the work finished. If the fire's ` +
                'read never happened, the closing comment must record NOT RUN, so the `done` does not impersonate ' +
                'a completed read (TRA-4817).',
            );
          }
        } else {
          L.push(
            `       \`${repStatus}\`, never \`done\` and never the read \`${rep.restoredFrom}\`: todo is queue-visible AND ` +
              'still counts as an unresolved blocker upstream, while in_progress is what the reconciler mints strands FROM.',
          );
        }
        L.push(
          '       Do NOT re-send the WRITE-ONLY blocker key: there is no open anchor, and an empty write-key list ' +
            'reproduces the born-blocked state.',
        );
        L.push(
          `       VERIFY by re-read on \`activeRecoveryAction == null\`, NOT on \`status === "${repStatus}"\`. The strand ` +
            'IS the recovery action; on a row a run picks up at once the status reads back `in_progress` and that is ' +
            'still a clean drain (TRA-4041, TRA-3758).',
        );
        L.push(
          `       NOTE, not a step — returnOwnerAgentId on the payload is \`${rep.assigneeAgentId}\` (${back}). This ` +
            'file used to print a second PATCH restoring it. DO NOT RUN ONE: the status PATCH above spawns a run that ' +
            'takes the issue checkout lock, so any further PATCH on this row returns 409 Issue run ownership conflict ' +
            '(measured 6/6, TRA-4041). The re-home is the platform\'s to make, not an agent verb.',
        );
      } else if (rep) {
        L.push(`     no repair command (the TRA-2396 rule stands here): ${rep.why}`);
      }
      // TRA-4041 — the class that disables the automation that would fix it.
      if (suppressesOwnRoutine(f)) {
        L.push(
          '     ⛔ SUPPRESSING LEAF — this is a `routine_execution` spawn that gates nothing, resting non-terminal. ' +
            'On `coalesce_if_active` every later fire of its routine COALESCES into it instead of running, so that ' +
            'routine is OFF while still reporting a future nextRunAt. Measured 2026-08-26: 28/43 active routines ' +
            'last fired 08-16 or earlier; 0 of the 15 still firing have a non-terminal leaf.',
        );
        L.push(
          `       Correct disposition is \`done\`, NOT \`todo\` (the routines' own RESTING DISPOSITION block: "per-fire ` +
            'spawn that blocks nothing -> done"). Restoring a spawn to `todo` is what keeps its routine off. This is ' +
            'the ONE row class where the generic restore is actively harmful.',
        );
        L.push(
          '       WRITTEN BY THE DRAIN as of TRA-4063 (2026-08-26). Until then this line said "not written, ' +
            'deliberately" and the drain planned `todo` for this class with no discrimination at all -- so the ' +
            'fire of 2026-08-26T12:30Z planned `-> todo` for TRA-4058, the per-fire spawn of the `skip_if_active` ' +
            'TRA-4017 armed-liveness detector, which would have switched that detector OFF. The `done` authority ' +
            'is scoped to THIS class and to nothing else, and both unknowns (no `originKind`, unreadable `blocks`) ' +
            'refuse to write at all rather than fall back to `todo`.',
        );
      }
      // The cause branch and the anchor verdict. Both are here because both were
      // getting improvised into filings (TRA-2396): the cause asserted from a
      // guess, the anchor lifted from a rollup that only ever samples descendants.
      L.push(`     cause: ${causeSentence(f, result.roster)}`);
      // TRA-4832 — the OWNERSHIP column. The recovery write that set `blocked`
      // is ALSO an assignee write (one `issuesSvc.update` in the platform's
      // `escalateStrandedAssignedIssue`, re-read 2026-09-23), so every
      // RECOVERY-BLOCKED hit names both sides. Three arms on purpose: an
      // instrument that cannot show the NEGATIVE (not transferred) or the
      // UNREADABLE (possibly laundered) is the failure mode this company keeps
      // paying for.
      if (f.cause === CAUSE.RECOVERY_BLOCKED) {
        const nameOf = (id) => (id ? `${(result.roster.get(id) || {}).name || 'OFF-ROSTER'} <${id}>` : 'none');
        if (f.ownershipTransferred === true) {
          L.push(
            `     ownership: TRANSFERRED by the recovery write — current assignee ${nameOf(f.assigneeAgentId)} vs ` +
              `pre-strand owner ${nameOf(f.recoveryReturnOwnerAgentId)}. Status and assignee were ONE write, so ` +
              '"why is it blocked" and "why is the old owner 403 on it" are ONE incident.',
          );
        } else if (f.ownershipTransferred === false) {
          L.push(
            `     ownership: NOT transferred — assignee ${nameOf(f.assigneeAgentId)} is still the pre-strand owner ` +
              'named by returnOwnerAgentId. No ownership change is visible on this payload.',
          );
        } else {
          L.push(
            '     ownership: pre-strand owner UNREADABLE — no returnOwnerAgentId/previousOwnerAgentId on the payload. ' +
              'Absent is NOT "unchanged": a hand repair that wrote status without the assignee launders the field ' +
              'permanently (TRA-3196 — it is not writable through the issue API), and a discharged action leaves ' +
              'no payload at all.',
          );
        }
        // The hand-back verb (measured TRA-4474; handler re-read 2026-09-23:
        // `POST /issues/:id/recovery-actions/resolve`, outcome `restored` +
        // sourceIssueStatus `todo` writes status AND assigneeAgentId back to
        // returnOwnerAgentId in one transaction, recorded outcome
        // `handed_back`). It is printed ONLY when the RUNNER of this sweep is
        // the recovery action's own owner — for anyone else it is a 403, and
        // an unexecutable command in a report is how TRA-2383 happened.
        if (
          result.runnerAgentId &&
          f.recoveryActionOwnerAgentId &&
          result.runnerAgentId === f.recoveryActionOwnerAgentId &&
          f.recoveryActionId &&
          f.recoveryReturnOwnerAgentId
        ) {
          if (f.pendingInteractions === 0) {
            L.push('     hand-back (YOU are the recovery owner — this verb is yours to run):');
            L.push(`       POST /api/issues/${f.id}/recovery-actions/resolve`);
            L.push(
              `         {"actionId":"${f.recoveryActionId}","outcome":"restored","sourceIssueStatus":"todo"}`,
            );
            L.push(
              `       Comment on the issue FIRST, then resolve. Writes assigneeAgentId back to ` +
                `${nameOf(f.recoveryReturnOwnerAgentId)} atomically with the status (activity: ` +
                'issue.recovery_action_resolved, outcome handed_back). Grade success on assigneeAgentId ' +
                'CHANGING — never on activeRecoveryAction going null, which reads identically for ' +
                'never-stranded, recovered, and cleared-but-still-dead.',
            );
          } else {
            L.push(
              `     hand-back verb withheld: pending interactions ${
                f.pendingInteractions === null ? 'UNKNOWN (route unread)' : f.pendingInteractions
              } — resolving to \`todo\` demotes a leaf that may hold a live card (TRA-2598). Unknown is not zero.`,
            );
          }
        } else if (f.ownershipTransferred === true) {
          L.push(
            '     hand-back exists but is NOT yours to run: POST .../recovery-actions/resolve is scoped to the ' +
              'recovery owner / current assignee / board. Do NOT repair with a bare status write — one that omits ' +
              'the assignee launders returnOwnerAgentId permanently (TRA-3196; 112 of 176 rows in the TRA-3479 census).',
          );
        }
      }
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
  //
  // ⛔ The suppression predicate is `platformWake.suppresses`, NOT the mere
  // existence of an active wake (TRA-3451). A wake that has not advanced past
  // the bound routes like any other finding — it is the strand, not a path.
  const suppressed = (f) => Boolean(f.platformWake && f.platformWake.suppresses);
  const routable = (bySeverity.get(SEVERITY.ROUTE_TO_ASSIGNEE) || []).filter((f) => !suppressed(f));
  const alreadyWoken = (bySeverity.get(SEVERITY.ROUTE_TO_ASSIGNEE) || []).filter(suppressed);
  const staleWakes = routable.filter((f) => f.platformWakeOwnerAgentId);
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
  if (staleWakes.length) {
    L.push(`STALE WAKES  ${staleWakes.length} of the routable rows above carry an \`active\` wake_owner recovery`);
    L.push(`             action that has NOT advanced inside the ${hoursOf(WAKE_STALE_AFTER_MS)}h bound. They are routed ON PURPOSE.`);
    L.push('             An active action stuck at its first attempt is not a continuation path — measured');
    L.push('             2026-08-12: 47 of 47 sat `active` at attemptCount 1, oldest 13h, and ZERO drained on');
    L.push('             their own. Suppressing these is how the board went silent through three of these events:');
    for (const f of staleWakes) {
      const w = (result.roster.get(f.platformWakeOwnerAgentId) || {}).name || f.platformWakeOwnerAgentId;
      const wk = f.platformWake || {};
      L.push(
        `   ${f.identifier || f.id}  wake -> ${w}` +
          `${wk.ageHours !== null && wk.ageHours !== undefined ? `, stale ${wk.ageHours}h` : ', age UNREADABLE'}` +
          `${wk.attemptCount !== null && wk.attemptCount !== undefined ? `, attemptCount ${wk.attemptCount}` : ''}`,
      );
    }
    L.push('');
  }
  if (alreadyWoken.length) {
    L.push('do NOT route  a live recovery action is already waking the owner on these AND it is still');
    L.push(`              advancing (inside the ${hoursOf(WAKE_STALE_AFTER_MS)}h bound). They are still findings — the empty array`);
    L.push('              is still an auto-flip risk — but a fresh child issue here is a duplicate wake,');
    L.push('              not a remedy. Re-run after the bound: if it has not advanced by then it FILES.');
    for (const f of alreadyWoken) {
      const w = (result.roster.get(f.platformWakeOwnerAgentId) || {}).name || f.platformWakeOwnerAgentId;
      const wk = f.platformWake || {};
      L.push(
        `   ${f.identifier || f.id}  (platform is waking ${w}` +
          `${wk.ageHours !== null && wk.ageHours !== undefined ? `, last advance ${wk.ageHours}h ago` : ''})`,
      );
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

  // The prevention half. Shape 2 has a named, cheap, upstream cause — somebody
  // closed a gate — so the report says whose habit produces it, not just who has
  // to clean it up.
  if (nClosed) {
    const closers = new Map();
    for (const f of result.findings) {
      for (const b of f.closedBlockers || []) {
        if (!b.identifier) continue;
        const k = b.assigneeAgentId ? (result.roster.get(b.assigneeAgentId) || {}).name || b.assigneeAgentId : 'unknown';
        if (!closers.has(k)) closers.set(k, new Set());
        closers.get(k).add(b.identifier);
      }
    }
    L.push('PREVENTION  shape 2 is created by a CLOSE, and only ever by a close. The gates that');
    L.push('            buried the leaves above, by whoever closed them:');
    for (const [who, ids] of closers) L.push(`   ${who}  ->  ${[...ids].join(', ')}`);
    L.push('');
    L.push('            The discipline, as the LAST step of every close:');
    L.push('              1. read the issue\'s `blocks` array BEFORE you PATCH it to done/cancelled;');
    L.push('              2. for each entry still `blocked`, re-read that dependent\'s `blockedBy`;');
    L.push('              3. if yours was its last open blocker, park the dependent in the same');
    L.push('                 breath — `todo` if your issue completed, a READ if it was cancelled.');
    L.push('            A `todo` leaf still counts as an unresolved blocker upstream, so parking');
    L.push('            it costs nothing. Leaving it `blocked` costs everything: no wake, no');
    L.push('            monitor, no auto-flip, and this detector is the only thing that sees it.');
    L.push('');
  }

  L.push('reminder  repair is ASSIGNEE-SCOPED: a plain {"status":…} PATCH from outside the');
  L.push('          boundary is 403, and so is POST /comments. Route via a child issue');
  L.push('          (POST /api/issues/{parent}/children with assigneeAgentId).');
  L.push('          ⛔ Do NOT anchor a child onto its own parent to satisfy "blocked needs a');
  L.push('          blocker" — that is a 2-cycle neither side can break. `todo` is the correct');
  L.push('          disposition for a parked-ready leaf.');
  L.push('');
  const repairable = result.findings.filter((f) => f.repair && f.repair.eligible);
  L.push('no ANCHOR-BEARING repair command is emitted, on purpose (TRA-2396). The rollup field that');
  L.push('used to supply the anchor samples DESCENDANTS, so an edge built from it is a guaranteed');
  L.push('2-cycle — worse than the empty array, because an empty blockedBy at least auto-flips');
  L.push('and stays visible. A wrong repair command is worse output than none: routing is this');
  L.push('detector\'s job, and the anchor is the assignee\'s to re-derive. Paste the `cause:` line');
  L.push('as-is when you file — it is branched on the marker, not guessed.');
  L.push('');
  // ⚠ Do NOT write the row-level sentinel into this prose. The controls assert
  // its ABSENCE on every board that emits no repair, so a mention here would
  // green four negative controls by accident.
  L.push(
    `ONE cohort is exempt (TRA-3451): ${repairable.length} row(s) above carry a restore command. They are ` +
      '`stranded_assigned_issue`',
  );
  L.push('rows whose ELIGIBILITY was read off the recovery payload (`evidence.previousStatus`');
  L.push('present + `returnOwnerAgentId` named), with the interaction route confirming ZERO');
  L.push('pending cards. The printed TARGET is DERIVED, not read: `todo` for a dead run,');
  L.push('`done` only for a suppressing leaf, with its discharge evidence cited beside it.');
  L.push('(TRA-4817: the old text claimed the target was read off `previousStatus`; measured');
  L.push('2026-09-23 it matched 0/4, because matching it would re-mint the strand.) Every');
  L.push('other row keeps the rule above and prints the reason it kept it.');
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
  {
    ignoreOffset = false,
    stripBlockedByKey = false,
    comments = {},
    commentsThrow = false,
    noCommentTransport = false,
    interactions = {},
    interactionsThrow = false,
    noInteractionTransport = false,
  } = {},
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
  if (!noInteractionTransport) {
    t.getInteractions = async (id) => {
      if (interactionsThrow) throw new Error('HTTP 403 on the interaction route');
      return interactions[id] || [];
    };
  }
  return t;
}

/**
 * A shape-2 strand: `blocked`, blockers PRESENT, every one of them closed.
 * `gate` is the list of [identifier, status, closerAgentId] tuples that buried it.
 */
const buried = (id, ident, assignee, gate = [['TRA-7001', 'done', 'agent-cto']], extra = {}) => ({
  list: { id, identifier: ident, title: `buried ${ident}`, status: 'blocked', assigneeAgentId: assignee },
  item: {
    id,
    identifier: ident,
    title: `buried ${ident}`,
    status: 'blocked',
    priority: 'high',
    assigneeAgentId: assignee,
    blockedBy: gate.map(([identifier, status, closer]) => ({
      id: `blk-${identifier}`,
      identifier,
      status,
      assigneeAgentId: closer || 'agent-cto',
    })),
    blocks: [],
    ...extra,
  },
});

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
 * The 2026-08-12 cohort, verbatim in shape from a live `stranded_assigned_issue`
 * payload (recovery action fc93ac5d on TRA-2102): `attemptCount`,
 * `lastAttemptAt`, `returnOwnerAgentId`/`previousOwnerAgentId` and
 * `evidence.previousStatus` are all real fields, not invented for the fixture.
 *
 * The bursts that day minted at 11:39Z and were still `active` at attempt 1
 * when the sweep read them ~13h later, so the defaults reproduce exactly that.
 */
const MINTED_AT = '2026-08-12T11:39:00.000Z';
const NOW_STALE = Date.parse('2026-08-12T22:30:00.000Z'); // 10.9h after the mint
const NOW_FRESH = Date.parse('2026-08-12T12:00:00.000Z'); // 21m after the mint

const recoveryStrand = (
  id,
  ident,
  assignee,
  {
    kind = 'stranded_assigned_issue',
    status = 'active',
    attemptCount = 1,
    createdAt = MINTED_AT,
    lastAttemptAt = null,
    wakeOwner = 'agent-cfo',
    returnOwner = 'agent-cto',
    previousStatus = 'in_progress',
    actionId = 'ra-fixture',
  } = {},
) =>
  stranded(id, ident, assignee, {
    activeRecoveryAction: {
      id: actionId,
      kind,
      cause: kind,
      status,
      ownerAgentId: wakeOwner,
      previousOwnerAgentId: returnOwner,
      returnOwnerAgentId: returnOwner,
      evidence: previousStatus ? { previousStatus, sourceIdentifier: ident } : { sourceIdentifier: ident },
      wakePolicy: { type: 'wake_owner', reason: 'source_scoped_recovery_action', ownerAgentId: wakeOwner },
      attemptCount,
      lastAttemptAt: lastAttemptAt || createdAt,
      createdAt,
      updatedAt: lastAttemptAt || createdAt,
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
    //
    // ⚠ TRA-3451 pinned the clock here. The annotation is now the FRESH branch
    // of an age gate, so a control that let the wall clock decide would silently
    // become a test of the STALE branch the day after it was written — and the
    // fresh branch, which is the one that still suppresses, would be untested.
    expectAnnotation: true,
    opts: { now: Date.parse('2026-07-26T06:40:00.000Z') }, // 16m after the mint
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
              attemptCount: 1,
              lastAttemptAt: '2026-07-26T06:24:12.346Z',
              createdAt: '2026-07-26T06:24:12.346Z',
            },
          }),
        ]),
      ),
    assert: (r) => {
      const out = renderReport(r).join('\n');
      const f = r.findings[0];
      return (
        r.findings.length === 1 &&
        f.severity === SEVERITY.ROUTE_TO_ASSIGNEE &&
        f.recoveryKind === 'missing_disposition' &&
        f.platformWakeOwnerAgentId === 'agent-qt' &&
        // fresh => the suppression still applies, and it is the ONLY thing it
        // may do: annotate and de-route.
        f.platformWake.stale === false &&
        f.platformWake.suppresses === true &&
        /platform wake ACTIVE and ADVANCING/.test(out) &&
        /do NOT route/.test(out) &&
        !/routing {2}one child issue per OWNER/.test(out) &&
        // and the annotation must NOT have removed it from the report
        out.includes('TRA-8050')
      );
    },
  },
  {
    // ⛔ THE TRA-3451 CASE. This is the hole the whole ticket exists to close:
    // the predicate detected all 47 rows on 2026-08-12 and the REPORTING rule
    // then de-routed every one of them, so the board read green three events
    // running. A control that only covers the fresh case above re-greens it.
    name: 'TRA-3451 — an ACTIVE wake_owner STALE at attemptCount 1 => FILED and ROUTED, never a do-not-route annotation',
    expect: 'FINDINGS',
    opts: { now: NOW_STALE },
    build: () => transportFor(fakeBoard([recoveryStrand('s1', 'TRA-8600', 'agent-cfo')])),
    assert: (r) => {
      const out = renderReport(r).join('\n');
      const f = r.findings[0];
      return (
        r.findings.length === 1 &&
        f.platformWakeOwnerAgentId === 'agent-cfo' && // the wake IS active…
        f.platformWake.stale === true && // …and it is NOT a continuation path
        f.platformWake.suppresses === false &&
        f.platformWake.attemptCount === 1 &&
        f.platformWake.ageHours > 10 &&
        /platform wake ACTIVE but STALE/.test(out) &&
        /attemptCount 1/.test(out) &&
        /STALE WAKES {2}1 of the routable rows/.test(out) &&
        // the load-bearing half: it is in the ROUTING table, not the do-not-route list
        /routing {2}one child issue per OWNER/.test(out) &&
        !/do NOT route/.test(out)
      );
    },
  },
  {
    name: 'TRA-3451 — a 13h-old wake that RETRIED 10m ago still suppresses (the gate is ADVANCE, not birth)',
    expect: 'FINDINGS',
    opts: { now: NOW_STALE },
    build: () =>
      transportFor(
        fakeBoard([
          recoveryStrand('s1', 'TRA-8610', 'agent-cfo', {
            createdAt: '2026-08-12T09:00:00.000Z',
            lastAttemptAt: '2026-08-12T22:20:00.000Z',
            attemptCount: 4,
          }),
        ]),
      ),
    assert: (r) => {
      const out = renderReport(r).join('\n');
      const w = r.findings[0].platformWake;
      return (
        r.findings.length === 1 &&
        w.stale === false &&
        w.suppresses === true &&
        w.attemptCount === 4 &&
        w.ageHours < 1 &&
        /platform wake ACTIVE and ADVANCING/.test(out) &&
        /do NOT route/.test(out)
      );
    },
  },
  {
    // The other half of the ADVANCE gate's control, and what NOW_FRESH exists
    // for (TRA-3846): a wake minted 21m ago at attempt 1, advance stamp = birth.
    // The case above proves a recent RETRY suppresses on an old mint; this one
    // proves a recent MINT suppresses on its own — without it, a regression
    // that pages on every newborn recovery action (age < bound on BOTH stamps)
    // has no control that goes red.
    name: 'TRA-3451 — a wake minted 21m ago (attempt 1) is fresh and suppresses: the sweep must not page on a newborn recovery action',
    expect: 'FINDINGS',
    opts: { now: NOW_FRESH },
    build: () => transportFor(fakeBoard([recoveryStrand('s1', 'TRA-8615', 'agent-cfo')])),
    assert: (r) => {
      const out = renderReport(r).join('\n');
      const w = r.findings[0].platformWake;
      return (
        r.findings.length === 1 &&
        w.stale === false &&
        w.suppresses === true &&
        w.attemptCount === 1 &&
        w.ageHours < 1 &&
        /platform wake ACTIVE and ADVANCING/.test(out) &&
        /do NOT route/.test(out)
      );
    },
  },
  {
    name: 'TRA-3451 — an active wake with NO readable advance stamp is STALE, never fresh (absent is not fresh)',
    expect: 'FINDINGS',
    opts: { now: NOW_STALE },
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8620', 'agent-cfo', {
            activeRecoveryAction: {
              kind: 'stranded_assigned_issue',
              status: 'active',
              ownerAgentId: 'agent-cfo',
              wakePolicy: { type: 'wake_owner', ownerAgentId: 'agent-cfo' },
              attemptCount: 1,
            },
          }),
        ]),
      ),
    assert: (r) => {
      const out = renderReport(r).join('\n');
      const w = r.findings[0].platformWake;
      return (
        w.stale === true &&
        w.suppresses === false &&
        w.ageMs === null &&
        /Absent is not fresh/.test(out) &&
        /routing {2}one child issue per OWNER/.test(out)
      );
    },
  },
  {
    name: 'TRA-4041 REPAIR — previousStatus + returnOwnerAgentId both READ => ONE RESTORE-PATCH, and the assignee step is ABSENT',
    note: 'was the two-step recipe; step 2 409d 6/6 on the run lock',
    expect: 'FINDINGS',
    opts: { now: NOW_STALE },
    build: () => transportFor(fakeBoard([recoveryStrand('s1', 'TRA-8630', 'agent-cfo', { returnOwner: 'agent-qt' })])),
    assert: (r) => {
      const out = renderReport(r).join('\n');
      const f = r.findings[0];
      return (
        f.repair.eligible === true &&
        f.repair.status === 'todo' &&
        // still READ off the payload — it is printed as a note, just never as a verb
        f.repair.assigneeAgentId === 'agent-qt' &&
        f.repair.restoredFrom === 'in_progress' &&
        f.recoveryReturnOwnerAgentId === 'agent-qt' &&
        /RESTORE-PATCH 1\/1 {2}PATCH \/api\/issues\/s1 \{"status":"todo"\}/.test(out) &&
        // EXACTLY one step. A 2/2 line, or any second RESTORE-PATCH, is the defect.
        out.split('\n').filter((l) => /RESTORE-PATCH/.test(l)).length === 1 &&
        !/RESTORE-PATCH 2\//.test(out) &&
        // the unexecutable verb, pinned as ABSENT anywhere in the report
        !/PATCH \/api\/issues\/\S+ \{"assigneeAgentId"/.test(out) &&
        // the owner is still NAMED, as prose
        /returnOwnerAgentId on the payload is `agent-qt`/.test(out) &&
        /409 Issue run ownership conflict/.test(out) &&
        // the verify predicate is the recovery action, not the status word
        /activeRecoveryAction == null/.test(out) &&
        // the two ways to get the status wrong, both pinned as ABSENT
        !/\{"status":"done"\}/.test(out) &&
        !/\{"status":"in_progress"\}/.test(out)
      );
    },
  },
  {
    name: 'TRA-3451 REPAIR — the GENERIC shape-1 row (no evidence.previousStatus) still gets NO command, rule untouched',
    expect: 'FINDINGS',
    opts: { now: NOW_STALE },
    build: () => transportFor(fakeBoard([stranded('s1', 'TRA-8640', 'agent-cto')])),
    assert: (r) => {
      const out = renderReport(r).join('\n');
      const f = r.findings[0];
      return (
        f.repair.eligible === false &&
        f.restoreTarget.provenance === RESTORE.NONE &&
        !/RESTORE-PATCH/.test(out) &&
        /no repair command \(the TRA-2396 rule stands here\)/.test(out)
      );
    },
  },
  {
    name: 'TRA-3451 REPAIR — a LIVE pending card blocks the repair (todo would bury a decision, TRA-2598)',
    expect: 'FINDINGS',
    opts: { now: NOW_STALE },
    build: () =>
      transportFor(fakeBoard([recoveryStrand('s1', 'TRA-8650', 'agent-cfo')]), {
        interactions: { s1: [{ id: 'i1', status: 'pending', kind: 'request_confirmation' }] },
      }),
    assert: (r) => {
      const out = renderReport(r).join('\n');
      const f = r.findings[0];
      return (
        f.pendingInteractions === 1 &&
        f.restoreTarget.provenance === RESTORE.HOLD_FOR_CARD &&
        f.repair.eligible === false &&
        /rests at `in_review`/.test(f.repair.why) &&
        !/RESTORE-PATCH/.test(out)
      );
    },
  },
  {
    name: 'TRA-3451 REPAIR — an UNREADABLE interaction route blocks the repair too (unknown is not zero)',
    expect: 'FINDINGS',
    opts: { now: NOW_STALE },
    build: () =>
      transportFor(fakeBoard([recoveryStrand('s1', 'TRA-8660', 'agent-cfo')]), { interactionsThrow: true }),
    assert: (r) => {
      const f = r.findings[0];
      return (
        f.pendingInteractions === null &&
        f.repair.eligible === false &&
        /UNKNOWN \(route unread\)/.test(f.repair.why) &&
        !/RESTORE-PATCH/.test(renderReport(r).join('\n'))
      );
    },
  },
  {
    name: 'TRA-3451 REPAIR — a known target but NO returnOwnerAgentId => routed, not repaired (the owner would be a guess)',
    expect: 'FINDINGS',
    opts: { now: NOW_STALE },
    build: () => transportFor(fakeBoard([recoveryStrand('s1', 'TRA-8670', 'agent-cfo', { returnOwner: null })])),
    assert: (r) => {
      const f = r.findings[0];
      return (
        f.recoveryReturnOwnerAgentId === null &&
        f.restoreTarget.provenance === RESTORE.FROM_EVIDENCE &&
        f.repair.eligible === false &&
        /NO `returnOwnerAgentId`/.test(f.repair.why) &&
        !/RESTORE-PATCH/.test(renderReport(r).join('\n'))
      );
    },
  },
  {
    // TRA-4832 — the ownership column, TRANSFERRED arm. The recovery write is
    // status + assignee in ONE update, so the row lands on the RECOVERY OWNER's
    // queue while returnOwnerAgentId still names the pre-strand owner. The
    // runner here IS the recovery owner, so the hand-back verb prints —
    // executable, with the real actionId — and it is a POST, not a blocker
    // write, so the global no-repair-PATCH invariant must survive it.
    name: 'TRA-4832 OWNERSHIP — transferred arm: both owners NAMED, and the hand-back verb prints for the recovery owner',
    expect: 'FINDINGS',
    opts: { now: NOW_STALE, runnerAgentId: 'agent-cfo' },
    build: () =>
      transportFor(
        fakeBoard([
          recoveryStrand('s1', 'TRA-8710', 'agent-cfo', {
            wakeOwner: 'agent-cfo',
            returnOwner: 'agent-cto',
            actionId: 'ra-4832-t',
          }),
        ]),
      ),
    assert: (r) => {
      const out = renderReport(r).join('\n');
      const f = r.findings[0];
      return (
        f.ownershipTransferred === true &&
        f.recoveryActionOwnerAgentId === 'agent-cfo' &&
        f.recoveryReturnOwnerAgentId === 'agent-cto' &&
        /ownership: TRANSFERRED/.test(out) &&
        /current assignee CFO <agent-cfo>/.test(out) &&
        /pre-strand owner CTO <agent-cto>/.test(out) &&
        /hand-back \(YOU are the recovery owner/.test(out) &&
        /POST \/api\/issues\/s1\/recovery-actions\/resolve/.test(out) &&
        /\{"actionId":"ra-4832-t","outcome":"restored","sourceIssueStatus":"todo"\}/.test(out) &&
        /assigneeAgentId CHANGING/.test(out) &&
        // the POST is not a blocker write — the standing invariant survives it
        assertNoRepairCommand(out)
      );
    },
  },
  {
    // TRA-4832 — the NOT-transferred arm plus the UNREADABLE arm. An
    // instrument that cannot show a NEGATIVE is the recurring failure mode:
    // "transferred" must be distinguishable from "unchanged" AND from
    // "cannot tell" (laundered returnOwnerAgentId, TRA-3196). And a runner who
    // is NOT the recovery owner never gets an executable resolve verb.
    name: 'TRA-4832 OWNERSHIP — not-transferred + unreadable arms: the negative prints, and a non-owner runner gets NO verb',
    expect: 'FINDINGS',
    opts: { now: NOW_STALE, runnerAgentId: 'agent-qt' },
    build: () =>
      transportFor(
        fakeBoard([
          recoveryStrand('s2', 'TRA-8711', 'agent-cto', { wakeOwner: 'agent-cfo', returnOwner: 'agent-cto' }),
          recoveryStrand('s3', 'TRA-8712', 'agent-cfo', { returnOwner: null }),
        ]),
      ),
    assert: (r) => {
      const out = renderReport(r).join('\n');
      const byIdent = Object.fromEntries(r.findings.map((f) => [f.identifier, f]));
      return (
        r.findings.length === 2 &&
        byIdent['TRA-8711'].ownershipTransferred === false &&
        byIdent['TRA-8712'].ownershipTransferred === null &&
        /ownership: NOT transferred/.test(out) &&
        /ownership: pre-strand owner UNREADABLE/.test(out) &&
        !/recovery-actions\/resolve/.test(out)
      );
    },
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

  /* ---------------- SHAPE 2 — the silent strand (TRA-2617) ---------------- */

  {
    // The headline case. Measured live: TRA-2476 closed 23:05Z -> stranded
    // TRA-2305; TRA-2552 closed 01:08Z -> stranded TRA-2420 and TRA-2598.
    name: 'SHAPE 2 — `blocked` behind a blocker set where EVERY entry is `done` => FINDINGS (this is the class the old predicate could not see)',
    expect: 'FINDINGS',
    build: () =>
      transportFor(
        fakeBoard([
          held('h1', 'TRA-8100', 'agent-cto'), // a legal rest must stay silent alongside it
          buried('b1', 'TRA-8101', 'agent-cto', [['TRA-8199', 'done', 'agent-qt']]),
        ]),
      ),
    assert: (r) =>
      r.findings.length === 1 &&
      r.findings[0].identifier === 'TRA-8101' &&
      r.findings[0].shape === SHAPE.ALL_BLOCKERS_CLOSED &&
      r.findings[0].closedBlockers[0].identifier === 'TRA-8199',
  },
  {
    // The negative half of the same predicate. One open blocker among closed ones
    // is a LEGAL rest — if this fired, the detector would flag 78 of the 81
    // blocked issues on the real board.
    name: 'SHAPE 2 negative — one OPEN blocker among two closed => silent (a legal rest is not a strand)',
    expect: 'CLEAN',
    build: () =>
      transportFor(
        fakeBoard([
          buried('b1', 'TRA-8102', 'agent-cto', [
            ['TRA-8198', 'done', 'agent-cto'],
            ['TRA-8199', 'cancelled', 'agent-cto'],
            ['TRA-8197', 'in_progress', 'agent-cto'],
          ]),
        ]),
      ),
    assert: (r) => r.findings.length === 0,
  },
  {
    // ⛔ Absent is not closed. If entries ever stop carrying `status`, the naive
    // `status in CLOSED` test is false everywhere and the whole class silently
    // stops being detected. That must be BLIND, not CLEAN.
    name: 'SHAPE 2 — a blockedBy entry carrying NO `status` key => BLIND, never a silent all-clear',
    expect: 'BLIND',
    build: () => {
      const b = buried('b1', 'TRA-8103', 'agent-cto');
      delete b.item.blockedBy[0].status;
      return transportFor(fakeBoard([b]));
    },
    assert: (r) => r.unreadable.length === 1 && /Absent is not closed/.test(r.unreadable[0]) && r.findings.length === 0,
  },
  {
    name: 'SHAPE 2 — a strand that itself BLOCKS something is reported as a stalled SUBTREE (TRA-2305 -> TRA-2268)',
    expect: 'FINDINGS',
    build: () =>
      transportFor(
        fakeBoard([
          buried('b1', 'TRA-8104', 'agent-cto', [['TRA-8199', 'done', 'agent-cto']], {
            blocks: [{ id: 'd1', identifier: 'TRA-8105', status: 'blocked' }],
          }),
        ]),
      ),
    assert: (r) =>
      r.findings[0].blocksIdentifiers.join() === 'TRA-8105:blocked' && /stalled SUBTREE/.test(renderReport(r).join('\n')),
  },

  /* ---------------- RESTORE TARGET (TRA-2617) ---------------- */

  {
    name: 'RESTORE — a satisfied gate (all blockers `done`) => target `todo`, provenance GATE_SATISFIED',
    expect: 'FINDINGS',
    build: () => transportFor(fakeBoard([buried('b1', 'TRA-8110', 'agent-cto', [['TRA-8199', 'done', 'agent-cto']])])),
    assert: (r) => r.findings[0].restoreTarget.target === 'todo' && r.findings[0].restoreTarget.provenance === RESTORE.GATE_SATISFIED,
  },
  {
    // A CANCELLED gate never delivered what the dependent waited for, so `todo`
    // would resurrect work whose reason was withdrawn. Emit NO target.
    name: 'RESTORE — a CANCELLED blocker => GATE_VOID, and NO target is emitted (do not resurrect withdrawn work)',
    expect: 'FINDINGS',
    build: () => transportFor(fakeBoard([buried('b1', 'TRA-8111', 'agent-cto', [['TRA-8199', 'cancelled', 'agent-cto']])])),
    assert: (r) =>
      r.findings[0].restoreTarget.target === null &&
      r.findings[0].restoreTarget.provenance === RESTORE.GATE_VOID &&
      /premise may be void/.test(r.findings[0].restoreTarget.why),
  },
  {
    // The CFO's deterministic repair: the restore target is READ, not guessed.
    name: 'RESTORE — activeRecoveryAction.evidence.previousStatus => target is a RESTORE, provenance FROM_EVIDENCE',
    expect: 'FINDINGS',
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8112', 'agent-cto', {
            activeRecoveryAction: {
              kind: 'stranded_assigned_issue',
              evidence: { previousStatus: 'in_progress' },
              createdAt: '2026-07-26T02:01:14.000Z',
            },
          }),
        ]),
      ),
    assert: (r) =>
      r.findings[0].restoreTarget.target === 'in_progress' &&
      r.findings[0].restoreTarget.provenance === RESTORE.FROM_EVIDENCE &&
      /RESTORE, not a judgement call/.test(r.findings[0].restoreTarget.why),
  },
  {
    // ⛔ THE TRA-2598 CASE. This issue (TRA-2617) was routed to me with a
    // correct 01:1xZ read and the instruction "PATCH it to `todo`". By the time
    // I ran it, the work had shipped and the leaf sat `in_review` behind a
    // pending request_confirmation. `todo` would have re-opened finished work
    // AND buried a live decision a human was expected to answer.
    name: 'RESTORE — a LIVE PENDING interaction OVERRIDES a `todo` target with `in_review` (the TRA-2598 trap)',
    expect: 'FINDINGS',
    build: () =>
      transportFor(fakeBoard([buried('b1', 'TRA-8113', 'agent-cto', [['TRA-8199', 'done', 'agent-cto']])]), {
        interactions: { b1: [{ id: 'x1', kind: 'request_confirmation', status: 'pending' }] },
      }),
    assert: (r) => {
      const rt = r.findings[0].restoreTarget;
      return (
        rt.target === 'in_review' &&
        rt.provenance === RESTORE.HOLD_FOR_CARD &&
        rt.overrode &&
        rt.overrode.target === 'todo' &&
        /overrides `todo`/.test(renderReport(r).join('\n'))
      );
    },
  },
  {
    // A RESOLVED card is not a live continuation path — the override must key on
    // `pending`, or every issue that ever held a card becomes un-parkable.
    name: 'RESTORE — a RESOLVED (non-pending) interaction does NOT override => target stays `todo`',
    expect: 'FINDINGS',
    build: () =>
      transportFor(fakeBoard([buried('b1', 'TRA-8114', 'agent-cto', [['TRA-8199', 'done', 'agent-cto']])]), {
        interactions: { b1: [{ id: 'x1', kind: 'request_confirmation', status: 'accepted' }] },
      }),
    assert: (r) => r.findings[0].pendingInteractions === 0 && r.findings[0].restoreTarget.target === 'todo',
  },
  {
    // ⛔ Fail closed. An unread interaction route is not an empty one — the guard
    // must not be weakest exactly where we read least.
    name: 'RESTORE — the interaction GET throws => the DEMOTING target is SUPPRESSED, not silently kept',
    expect: 'FINDINGS',
    build: () =>
      transportFor(fakeBoard([buried('b1', 'TRA-8115', 'agent-cto', [['TRA-8199', 'done', 'agent-cto']])]), {
        interactionsThrow: true,
      }),
    assert: (r) => {
      const f = r.findings[0];
      return (
        f.pendingInteractions === null &&
        f.restoreTarget.target === null &&
        f.restoreTarget.overrode.target === 'todo' &&
        /never established/.test(f.restoreTarget.why)
      );
    },
  },
  {
    name: 'RESTORE — no interaction transport at all => same suppression (an unchecked card is not an absent one)',
    expect: 'FINDINGS',
    build: () =>
      transportFor(fakeBoard([buried('b1', 'TRA-8116', 'agent-cto', [['TRA-8199', 'done', 'agent-cto']])]), {
        noInteractionTransport: true,
      }),
    assert: (r) => r.findings[0].pendingInteractions === null && r.findings[0].restoreTarget.target === null,
  },
  {
    // A NON-demoting target survives an unreadable interaction route: restoring
    // `in_progress` does not bury a card, so suppressing it would be pointless
    // strictness that leaves the owner with nothing.
    name: 'RESTORE — an unreadable card route does NOT suppress a non-demoting target (`in_progress` buries nothing)',
    expect: 'FINDINGS',
    build: () =>
      transportFor(
        fakeBoard([
          stranded('s1', 'TRA-8117', 'agent-cto', {
            activeRecoveryAction: { kind: 'stranded_assigned_issue', evidence: { previousStatus: 'in_progress' } },
          }),
        ]),
        { interactionsThrow: true },
      ),
    assert: (r) => r.findings[0].restoreTarget.target === 'in_progress' && r.findings[0].restoreTarget.overrode === null,
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
 * The TRA-2617 differential — the one that makes the second class load-bearing
 * rather than decorative.
 *
 * `naiveMissControl` above proves PAGING matters by running the sweep everyone
 * actually writes. This proves the PREDICATE matters the same way: it runs the
 * OLD predicate (`blockedBy.length === 0`, verbatim, reimplemented here so it
 * cannot drift with the file) against a board carrying a shape-2 strand, and
 * shows it reports a clean bill of health.
 *
 * Without this, "the new detector found 1" is unfalsifiable — it never
 * demonstrates that the shipped detector would have found 0. That is exactly
 * what happened on the real board: an empty-only sweep returned CLEAN at
 * 2026-07-30T01:1xZ while three live strands sat in the population.
 */
async function strandClassMissControl() {
  const board = fakeBoard([
    held('h1', 'TRA-8100', 'agent-cto'),
    buried('b1', 'TRA-8190', 'agent-cto', [['TRA-8199', 'done', 'agent-cto']]),
  ]);
  const t = transportFor(board);
  const roster = new Map(ROSTER.map((a) => [a.id, a]));

  // The OLD predicate, frozen in place.
  const oldPredicate = (item) =>
    item &&
    Object.prototype.hasOwnProperty.call(item, 'blockedBy') &&
    item.status === 'blocked' &&
    (Array.isArray(item.blockedBy) ? item.blockedBy : []).length === 0;

  const allRows = board.rows.filter((r) => r.status === 'blocked');
  const oldHits = [];
  for (const row of allRows) if (oldPredicate(await t.getIssue(row.id))) oldHits.push(row.identifier);

  const now = await sweep(t);
  const newHits = now.findings.map((f) => f.identifier);
  const ok =
    oldHits.length === 0 &&
    now.verdict === 'FINDINGS' &&
    newHits.length === 1 &&
    newHits[0] === 'TRA-8190' &&
    roster.size > 0;
  return {
    ok,
    detail:
      `old empty-only predicate found ${oldHits.length} across all ${allRows.length} blocked row(s); ` +
      `two-class detector found ${newHits.length} (${newHits.join(', ') || 'none'})`,
  };
}

/**
 * The TRA-2622 differential — why this file grades the SHAPE and not
 * `blockerAttention.unresolvedBlockerCount == 0`.
 *
 * That one-predicate substitute was routed in as strictly better and cheaper:
 * measured over all 82 `blocked` issues it returned exactly the 4 known
 * strands, "zero false positives, zero misses". I re-measured the whole
 * population (81 `blocked` of 2625 issues, deep-GET each) and reproduced the
 * agreement — both predicates return exactly TRA-2305, TRA-2420, TRA-382.
 *
 * The agreement is a COINCIDENCE OF THE BOARD, not a property of the predicate,
 * and the same measurement shows why:
 *
 *     count == #open blockedBy   70 / 81
 *     count  >  #open blockedBy  11 / 81   <- rollup counts NON-blockedBy work
 *     count  <  #open blockedBy   0 / 81   <- never under-counts
 *
 * So `unresolvedBlockerCount` is `#open blockedBy + #open descendants`, and the
 * inflation term is one-directional. On 11 live issues it is already >= 1. The
 * strands agreed only because all three happened to carry zero open
 * descendants at that instant — the predicate was UNFALSIFIED by that board,
 * not validated by it.
 *
 * The counterexample is live and one close away. TRA-1648 reads
 * `unresolvedBlockerCount: 4` over `blockedBy` = 3 `done` + 2 open, i.e. an
 * inflation term of +2 sitting alongside already-closed blockers. When those
 * two blockers close it becomes a textbook shape-2 strand whose rollup reads
 * `2`, and the substitute predicate goes silent on it. That is the worst
 * available failure mode: a strand with open descendants is precisely a stalled
 * SUBTREE (the TRA-2305 -> TRA-2268 shape), so the masking is strongest exactly
 * where the strand is most expensive.
 *
 * This control freezes the substitute predicate in place and shows it reporting
 * a clean board over two planted strands the shape detector finds. Prose saying
 * "never grade it off the rollup" is what this file already had; it did not stop
 * the substitution from being routed in as validated.
 */
async function rollupMaskControl() {
  const board = fakeBoard([
    // Shape 2 with a descendant term: every blocker `done`, rollup still 2.
    buried('m1', 'TRA-8290', 'agent-cto', [['TRA-8299', 'done', 'agent-cto']], rollup(2, 'TRA-8295')),
    // Shape 1 with a descendant term — the read measured on TRA-2331:
    // `blockedBy: []` and `unresolvedBlockerCount: 1`.
    stranded('m2', 'TRA-8291', 'agent-cfo', rollup(1, 'TRA-8296')),
  ]);
  const t = transportFor(board);

  // The substitute predicate, frozen here so it cannot drift with the file.
  const rollupPredicate = (item) =>
    item &&
    item.status === 'blocked' &&
    (item.blockerAttention || {}).unresolvedBlockerCount === 0;

  const allRows = board.rows.filter((r) => r.status === 'blocked');
  const rollupHits = [];
  for (const row of allRows) if (rollupPredicate(await t.getIssue(row.id))) rollupHits.push(row.identifier);

  const now = await sweep(t);
  const shapeHits = now.findings.map((f) => f.identifier).sort();
  const ok =
    rollupHits.length === 0 &&
    now.verdict === 'FINDINGS' &&
    shapeHits.join(',') === 'TRA-8290,TRA-8291';
  return {
    ok,
    detail:
      `substitute rollup predicate (unresolvedBlockerCount === 0) found ${rollupHits.length} across all ` +
      `${allRows.length} blocked row(s); shape detector found ${shapeHits.length} (${shapeHits.join(', ') || 'none'}) ` +
      '— one shape-1 and one shape-2 strand, each masked by a descendant term of the kind measured on 11/81 live rows',
  };
}

/**
 * The invariant that outranks every individual case: NO rendering of ANY board
 * may contain a copy-pasteable `blockedByIssueIds` write. TRA-2383 shipped one
 * inside a report that also argued against running it — prose loses to
 * copy-paste, so the string must simply never be emitted.
 *
 * TRA-3451 narrows it rather than dropping it. TRA-4041 narrows it again, to
 * exactly ONE verb, on a line carrying the `RESTORE-PATCH` sentinel, with the
 * blocker key still banned EVERYWHERE including on that line:
 *
 *   {"status":"todo"}                — never `done`, never a raw previousStatus
 *
 * `{"assigneeAgentId":"<id>"}` was the second sanctioned verb until 2026-08-26.
 * It is now BANNED, and the ban is the point of this control rather than a
 * tidy-up: printing it emitted a recipe whose second step 409'd 6 times out of 6
 * (`Issue run ownership conflict` — the step-1 PATCH spawns a run that takes the
 * issue checkout lock). An unexecutable printed step is worse than no step, so
 * a future edit that re-introduces it must go red HERE, in the suite, and not in
 * somebody's hands at 06:15Z. The step counter is pinned to `1/1` for the same
 * reason: `2/2` cannot be printed without failing.
 *
 * Any other `PATCH /api/issues` anywhere in any report, or any sanctioned line
 * whose body is not that one verb, fails the suite. The sentinel is what keeps
 * this a whitelist instead of a hole.
 */
const RESTORE_PATCH_LINE = /^\s*RESTORE-PATCH /;
const SANCTIONED_VERB = /^\s*RESTORE-PATCH 1\/1 {2}PATCH \/api\/issues\/\S+ \{"status":"todo"\}(\s|$)/;

function assertNoRepairCommand(rendered) {
  if (/blockedByIssueIds/.test(rendered)) return false;
  const lines = String(rendered).split('\n');
  const sanctioned = lines.filter((l) => RESTORE_PATCH_LINE.test(l));
  const rest = lines.filter((l) => !RESTORE_PATCH_LINE.test(l)).join('\n');
  if (/PATCH \/api\/issues/.test(rest)) return false;
  return sanctioned.every((l) => SANCTIONED_VERB.test(l));
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

  // TRA-4041 SUPPRESSING LEAF. Both directions, and both unknowns pinned to the
  // SAFE side: an absent `blocks` key must never be read as "gates nothing".
  const sup = [
    [{ originKind: 'routine_execution', blocksKnown: true, blocksIdentifiers: [] }, true, 'spawn, gates nothing'],
    [{ originKind: 'manual', blocksKnown: true, blocksIdentifiers: [] }, false, 'durable work is never this class'],
    [
      { originKind: 'routine_execution', blocksKnown: true, blocksIdentifiers: ['TRA-1:todo'] },
      false,
      'a spawn that GATES something is not a free `done`',
    ],
    [
      { originKind: 'routine_execution', blocksKnown: false, blocksIdentifiers: [] },
      false,
      'absent `blocks` key is UNKNOWN, not empty',
    ],
    [{ originKind: null, blocksKnown: true, blocksIdentifiers: [] }, false, 'unknown origin is not a spawn'],
  ];
  const supOk = sup.every(([f, want]) => suppressesOwnRoutine(f) === want);
  if (!supOk) failed += 1;
  console.log(
    `${supOk ? 'ok  ' : 'FAIL'}  TRA-4041 SUPPRESSING LEAF — a routine_execution spawn that gates nothing is named; ` +
      'every other shape, and both unknowns, are NOT\n' +
      `        ${sup.map(([, w, why]) => `${w ? 'YES' : 'no '} ${why}`).join(' | ')}`,
  );

  // TRA-4041 NEGATIVE CONTROL. The whitelist above only proves the CURRENT
  // report is clean. This proves the whitelist would REFUSE the exact string
  // this ticket deleted — otherwise a regex that accidentally matched
  // everything would read green on both halves.
  const reintroduced =
    '     repair KNOWN (stranded_assigned_issue):\n' +
    '       RESTORE-PATCH 1/1  PATCH /api/issues/s1 {"status":"todo"}\n' +
    '       RESTORE-PATCH 2/2  PATCH /api/issues/s1 {"assigneeAgentId":"agent-qt"}   # -> QuantTrader\n';
  const twoTwo =
    '       RESTORE-PATCH 1/2  PATCH /api/issues/s1 {"status":"todo"}\n';
  const rejects = !assertNoRepairCommand(reintroduced) && !assertNoRepairCommand(twoTwo);
  if (!rejects) failed += 1;
  console.log(
    `${rejects ? 'ok  ' : 'FAIL'}  TRA-4041 NEGATIVE — the whitelist REFUSES a re-introduced assignee PATCH, and refuses a \`n/2\` step counter\n` +
      '        (the step that returned 409 Issue run ownership conflict 6/6 on 2026-08-26)',
  );

  // TRA-4574 — THE TWO READERS MUST AGREE. `deriveRepair` hardcodes `todo` and the
  // drain overrides it to `done` for the suppressing-leaf class. Until this control
  // existed the REPORT consumed `rep.status` raw, so on exactly those rows it printed
  // `{"status":"todo"}` and then, four lines lower, called that write "actively
  // harmful". The whole selftest was green through it (44/44) because nothing rendered
  // an ELIGIBLE row that was ALSO a suppressing leaf — the two halves were only ever
  // exercised apart. Measured live 2026-09-16: 11 of 30 findings carried both.
  const supRepair = await (async () => {
    const row = recoveryStrand('s1', 'TRA-8640', 'agent-cto', { returnOwner: 'agent-qt' });
    row.item.originKind = 'routine_execution';
    row.item.blocks = []; // KNOWN-empty: gates nothing. Absent would be UNKNOWN, a different arm.
    const r = await sweep(transportFor(fakeBoard([row])), { now: NOW_STALE });
    const out = renderReport(r).join('\n');
    const f = r.findings[0];
    const cmd = out.split('\n').filter((l) => /RESTORE-PATCH/.test(l));
    return {
      ok:
        suppressesOwnRoutine(f) === true &&
        f.repair.eligible === true &&
        // the shared predicate still reports the GENERIC target; only the emitter overrides
        f.repair.status === 'todo' &&
        cmd.length === 1 &&
        /PATCH \/api\/issues\/s1 \{"status":"done"\}/.test(cmd[0]) &&
        !/\{"status":"todo"\}/.test(out) &&
        /SUPPRESSING LEAF/.test(out) &&
        // and the prose must not still be arguing for the opposite write
        !/`todo`, never `done`/.test(out) &&
        // TRA-4817 — an EMPTY thread means the `done` must SAY it rests on the
        // class rule alone, and must not assert the work finished.
        f.discharge && f.discharge.state === 'NONE' &&
        /NO discharge evidence found in-thread/.test(out) &&
        /rests on the CLASS RULE alone/.test(out) &&
        // and the report must never claim the target was read off the payload
        !/restore target and return owner were both READ/.test(out),
      detail: cmd[0] ? cmd[0].trim() : 'NO RESTORE-PATCH EMITTED',
    };
  })();
  if (!supRepair.ok) failed += 1;
  console.log(
    `${supRepair.ok ? 'ok  ' : 'FAIL'}  TRA-4574 — an ELIGIBLE row that is ALSO a SUPPRESSING LEAF prints \`done\`, not the generic \`todo\`\n` +
      `        ${supRepair.detail}\n` +
      '        (the emitter mirrors the drain; a `todo` here switches the row\'s own routine OFF — 11/30 live rows on 2026-09-16)',
  );

  // TRA-4817 — the TRA-4804 shape, replayed as a fixture. The payload says
  // `previousStatus: in_progress` (NOT terminal), yet the fire's owner published
  // a verdict in-thread 30s before the recovery park. The `done` print must CITE
  // that comment (author + timestamp + where it sits relative to the park), and
  // must not assert "already terminal" — the claim the payload contradicts and
  // the CFO measured false 4/4 on 2026-09-23.
  const supDischarge = await (async () => {
    const row = recoveryStrand('s1', 'TRA-8641', 'agent-cto', { returnOwner: 'agent-qt' });
    row.item.originKind = 'routine_execution';
    row.item.blocks = [];
    const r = await sweep(
      transportFor(fakeBoard([row]), {
        comments: {
          s1: [
            // the platform's own recovery notice — system-authored, must NOT count
            { id: 'c2', authorType: 'system', createdAt: '2026-08-12T11:39:01.000Z', body: 'terminal run recovery moved this issue' },
            { id: 'c1', authorAgentId: 'agent-qt', createdAt: '2026-08-12T11:38:30.000Z', body: 'postmarket verdict: NO-TRADE, book flat, queue 0 pending' },
          ],
        },
      }),
      { now: NOW_STALE },
    );
    const out = renderReport(r).join('\n');
    const f = r.findings[0];
    const d = f.discharge || {};
    return {
      ok:
        d.state === 'FOUND' &&
        d.authorAgentId === 'agent-qt' &&
        d.beforePark === true &&
        d.gapText === '30s' &&
        /discharge evidence IN-THREAD: newest non-system comment by QuantTrader @ 2026-08-12T11:38:30\.000Z — 30s BEFORE the recovery park/.test(out) &&
        // the system recovery notice, though NEWER, was not promoted to evidence
        !/11:39:01/.test(out) &&
        !/NO discharge evidence/.test(out) &&
        !/already terminal/.test(out),
      detail: `state=${d.state} author=${d.authorAgentId} beforePark=${d.beforePark} gap=${d.gapText}`,
    };
  })();
  if (!supDischarge.ok) failed += 1;
  console.log(
    `${supDischarge.ok ? 'ok  ' : 'FAIL'}  TRA-4817 — a \`done\` restore CITES its in-thread discharge evidence (the TRA-4804 26s shape), and a system recovery notice never counts as one\n` +
      `        ${supDischarge.detail}`,
  );

  const miss = await naiveMissControl();
  if (!miss.ok) failed += 1;
  console.log(
    `${miss.ok ? 'ok  ' : 'FAIL'}  TRAP 1b — the un-paginated sweep MISSES the planted shape (paging is load-bearing)\n` +
      `        ${miss.detail}`,
  );

  const classMiss = await strandClassMissControl();
  if (!classMiss.ok) failed += 1;
  console.log(
    `${classMiss.ok ? 'ok  ' : 'FAIL'}  TRA-2617 — the OLD empty-only predicate MISSES the shape-2 strand (the second class is load-bearing)\n` +
      `        ${classMiss.detail}`,
  );

  const rollupMask = await rollupMaskControl();
  if (!rollupMask.ok) failed += 1;
  console.log(
    `${rollupMask.ok ? 'ok  ' : 'FAIL'}  TRA-2622 — the ROLLUP substitute (unresolvedBlockerCount === 0) MISSES both strand shapes when a descendant inflates the count\n` +
      `        ${rollupMask.detail}`,
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
  // + naive-miss, strand-class-miss and rollup-mask differentials + the global
  // no-command invariant.
  const total = CASES.length + 4;
  console.log(`\n${total - failed}/${total} controls pass; verdicts reachable: ${[...reachable].sort().join(', ')}`);
  if (missing.length) {
    console.log(`FAIL  no control exercises: ${missing.join(', ')}`);
    failed += 1;
  }

  // Same rule one level down: the cause branch and the anchor verdict each need
  // every arm reachable, or a wired-shut branch passes as a working one.
  const causeArms = new Set([CAUSE.RECOVERY_BLOCKED, CAUSE.DROPPED_EDGE_INFERRED, CAUSE.UNKNOWN]);
  const anchorArms = new Set([ANCHOR.ALL_DESCENDANTS, ANCHOR.ALL_INELIGIBLE, ANCHOR.CANDIDATE_UNVERIFIED, ANCHOR.NO_CANDIDATES]);
  // Both strand shapes and every restore provenance must be reachable, for the
  // same reason: a class nothing exercises is a class that can be wired shut
  // without a single control going red. Shape 2 spent its whole life in that
  // state — undetectable, and no control could tell.
  const shapeArms = new Set([SHAPE.EMPTY_BLOCKED_BY, SHAPE.ALL_BLOCKERS_CLOSED]);
  const restoreArms = new Set([
    RESTORE.FROM_EVIDENCE,
    RESTORE.GATE_SATISFIED,
    RESTORE.GATE_VOID,
    RESTORE.HOLD_FOR_CARD,
    RESTORE.NONE,
  ]);
  const seenCause = new Set();
  const seenAnchor = new Set();
  const seenShape = new Set();
  const seenRestore = new Set();
  for (const c of CASES) {
    try {
      const r = await sweep(c.build(), c.opts || {});
      for (const f of r.findings) {
        seenCause.add(f.cause);
        if (f.anchor) seenAnchor.add(f.anchor.verdict);
        if (f.shape) seenShape.add(f.shape);
        if (f.restoreTarget) seenRestore.add(f.restoreTarget.provenance);
      }
    } catch {
      /* the case-level loop above already reported it */
    }
  }
  for (const [label, needed, seen] of [
    ['cause', causeArms, seenCause],
    ['anchor', anchorArms, seenAnchor],
    ['shape', shapeArms, seenShape],
    ['restore', restoreArms, seenRestore],
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
    // FINDINGS only. A throw leaves pendingInteractions UNKNOWN, which suppresses
    // a demoting restore target — do not "helpfully" coerce a failure to [].
    getInteractions: async (id) => unwrap(await get(`${BASE}/api/issues/${id}/interactions`), 'interactions'),
  };
}

async function main() {
  if (argv.includes('--selftest')) return selftest();

  const result = await sweep(liveTransport(), {
    limit: PAGE_LIMIT,
    maxPages: MAX_PAGES,
    concurrency: CONCURRENCY,
    // TRA-4832 — who is running this sweep. Gates whether the hand-back verb is
    // printed as executable; unset = never.
    runnerAgentId: argOf('runner', process.env.PAPERCLIP_AGENT_ID || null),
  });
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

/**
 * ENTRY GUARD (TRA-3541).
 *
 * `main()` used to run at module scope, which made this file un-importable: an
 * `import` performed a live company-wide sweep and then `process.exit()`ed the
 * importer. That is why `enumerateIssues` had to be lifted out to `./lib/` for a
 * second reader to share it.
 *
 * The DRAIN (`scripts/drain-blocked-empty.mjs`) needs more than the enumeration:
 * it has to write to EXACTLY the cohort this detector reports, executing the
 * `RESTORE-PATCH` pair `deriveRepair()` already derives. A drain carrying its
 * own copy of the predicate would silently repair a DIFFERENT population than
 * the one being graded, and the two would drift on the first edit to either. So
 * it imports `sweep()` itself, and this guard is what makes that safe.
 *
 * Run as a script, behaviour is unchanged; `--selftest` is the control for that
 * claim (43/43 before this guard, 43/43 after).
 */
const IS_ENTRYPOINT = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    // Cannot tell. Fall back to the OLD behaviour (run), never to silence: a
    // detector that quietly does nothing is the one failure this file exists
    // to prevent.
    return true;
  }
})();

if (IS_ENTRYPOINT) {
  // `process.exit()` inside a try skips the finally; return the code instead and
  // exit once, at the top.
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('ERROR', err?.stack || err);
      process.exit(3);
    });
}
