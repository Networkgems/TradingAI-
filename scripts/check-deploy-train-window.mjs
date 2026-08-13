#!/usr/bin/env node
/**
 * check-deploy-train-window.mjs — TRA-3533
 *
 * A deploy one-shot fires, creates a carrier issue that ORDERS a deploy inside a
 * window, and then nobody is woken on it. TRA-3493 sat 5.4h, TRA-3511 3.4h, both on
 * 2026-08-13, both `startedAt` null. They were dispositioned by hand from an unrelated
 * run, by someone reading the prose and re-deriving the ancestry. Nothing was stranded
 * — because an unrelated deploy path happened to carry the same commits. That was luck.
 *
 * WHAT THIS GRADES, AND WHY IT IS NOT THE SIBLING CHECK
 * -----------------------------------------------------
 * `check:carrier-dispatch` (TRA-3529) grades the DISPATCH: was anybody ever woken on
 * the carrier? That is the right question about the queue, and it is the WRONG question
 * about the deploy. A carrier can be picked up promptly and the deploy still be refused;
 * a carrier can be abandoned entirely and the commit still be live, carried by another
 * path. Dispatch is a PROXY. This grades the OUTCOME: is the ordered commit in the bytes
 * the live host is executing?
 *
 * ⭐ THE POINT OF GRADING THE OUTCOME IS THAT IT DOES NOT REQUIRE THE CARRIER TO HAVE
 * BEEN WORKED. A lateness check written INTO the carrier's own prose — "fail loudly if
 * you are reading this past T" — is structurally blind, because it only runs if somebody
 * runs the carrier, which is the exact event whose absence is the defect. The detector
 * cannot live inside the thing that did not happen.
 *
 * ⛔ WHAT THIS DOES NOT DO, STATED SO A GREEN IS NOT OVER-READ
 * It answers "is the ordered commit live NOW". It does NOT answer "was it live BY THE
 * DEADLINE" — that needs Render's deploy history (RENDER_API_KEY) to reconstruct the
 * live-spans, and this check deliberately does not guess at it. A carrier whose deadline
 * has passed and whose commit IS live is reported `SATISFIED (timing unread)`, never a
 * bare pass: the commit may have arrived hours late on somebody else's deploy, which is
 * precisely what happened on 2026-08-13. Pass `--render-key` (or set RENDER_API_KEY) to
 * add the timing arm. Without it the timing column reads UNREAD, not OK.
 *
 * ⛔ AND WHY THE FIX IS NOT "LET THE ROUTINE DEPLOY DIRECTLY"
 * `tradingai-bqb1` runs `autoDeploy=no` / `autoDeployTrigger=off` ON PURPOSE (the
 * launch-window pin, TRA-1653/TRA-1665). The steady state is that a merge to
 * origin/main ships NOTHING, and a human or agent decides each deploy. The queue
 * dependency this ticket is about is that posture observed one layer down. Any fix that
 * gives the trains an unattended executor re-creates autoDeploy through the back door
 * and hands the live money-adjacent host a standing automated write during go-live week
 * — the four gates in `scripts/render-redeploy.mjs` (RTH freeze 4, embargo 5, held
 * commit 6, unusable AUTH_SECRET 7) exist because an ungated deploy took the box down.
 * So the remediation is DETECTION, not automation, and the detection has to be
 * out-of-band. That is this file.
 *
 * THE MACHINE-READABLE ORDER (the template rule)
 * ----------------------------------------------
 * Nothing on the board records WHAT a deploy train ordered or BY WHEN, as data. It is
 * prose, which is why the 08-13 disposition had to be a human re-derivation. A deploy
 * train's carrier description must therefore carry exactly one fenced block:
 *
 *     ```deploy-order
 *     commit: 65fdb95
 *     host: tradingai-bqb1
 *     deadline: 2026-08-13T13:25:00Z
 *     ```
 *
 * `deadline` MUST be an absolute UTC instant ending in `Z`. A bare local time is
 * REJECTED rather than silently interpreted — routine crons are evaluated in ET and the
 * windows are written in UTC, and that is exactly the mix that produces a confidently
 * wrong deadline. A carrier that a human would call a deploy train and that carries no
 * parseable block is `UNGRADEABLE` — NON-ZERO (exit 4), never a pass. That is the only
 * thing that makes the template rule bite: an author who skips the block gets a visible
 * un-graded row, not silence.
 *
 * A carrier that MENTIONS deploying but orders none opts out explicitly with the marker
 *     <!-- deploy-order: none -->
 * on its own. There is no way to leave the population by accident.
 *
 * ⛔ CLASSIFICATION GRADES THE PREDICATE, NOT A LABEL. "Is this a deploy train?" is
 * decided by asking whether the body ORDERS a deploy — and a line whose deploy mention
 * sits inside a PROHIBITION or a RETRACTION ("never deploy during the freeze", "this
 * supersedes the earlier order") is not an order. A substring grep cannot tell USE from
 * MENTION, and a correct retraction is REQUIRED to quote the order it kills. So the
 * verdict is 3-way — TRAIN / NOT_TRAIN / AMBIGUOUS — the matched span is PRINTED, and
 * AMBIGUOUS (mentions deploys, every mention negated) is carried as UN-GRADED, costing a
 * human one glance, rather than dropped silently from the population.
 *
 * CONTROLS
 * --------
 * Both directions, and they run on EVERY invocation, not only under --selftest. A
 * one-directional control is half a control: proving the detector can SEE a stranded
 * order says nothing about whether it stays SILENT on a satisfied one, and the failure
 * mode of a grader over other people's artefacts is to convict them. If any control
 * fails, the instrument is BLIND (exit 3) and no verdict is printed.
 *
 * POPULATION — a NAMED limitation, printed every run
 * --------------------------------------------------
 * Carriers come from `lastRun.linkedIssueId` on the routines list route, i.e. ONE
 * carrier per routine, the newest. A worked newer carrier hides an abandoned older one.
 * For THIS population that is close to complete and the reason is structural, not a
 * shrug: deploy trains are one-shots whose own prose archives them at step 1, so a
 * deploy-train routine has essentially one carrier in its life. It is still a limit and
 * it is still printed on every run. Closing it entirely means paging
 * `/api/routines/{id}/runs` per routine, which is NOT implemented here — do not read the
 * printed limit as "there is a flag for that".
 *
 * ⛔ RECENCY IS PART OF THE SUBJECT, AND IT IS NOT A SILENT CAP
 * The subject is "is a deploy order AT RISK OF BEING STRANDED RIGHT NOW". A carrier that
 * fired on 2026-07-24 is settled history: its deploy either landed or stopped mattering
 * weeks ago, and re-grading it now produces an alarm nobody can act on. The first
 * unfiltered run of this check flagged 53 carriers, essentially all of them closed July
 * one-shots that predate the `deploy-order` block entirely — a detector that flags
 * everything discriminates nothing, and branding fifty settled tickets UNGRADEABLE for
 * not carrying a field that did not exist when they were written is an accusation, not a
 * finding. So the default population is carriers whose routine fired in the last
 * `--since` window (7 days), keyed on `lastRun.triggeredAt`, and the number excluded is
 * PRINTED with its reason on every run. `--all` grades the whole history when you
 * actually want the backlog. A row with no readable `triggeredAt` is INCLUDED, never
 * dropped: an unreadable timestamp must not be able to remove a carrier from the sweep.
 *
 * Usage:
 *   node scripts/check-deploy-train-window.mjs
 *   node scripts/check-deploy-train-window.mjs --since=2026-08-01T00:00:00Z
 *   node scripts/check-deploy-train-window.mjs --all      # include settled history
 *   node scripts/check-deploy-train-window.mjs --json
 *   node scripts/check-deploy-train-window.mjs --selftest      # controls only
 *   node scripts/check-deploy-train-window.mjs --live=<sha>    # grade a SHA you hold
 *   node scripts/check-deploy-train-window.mjs --host=https://…
 *
 * ⛔ THE PROSE CLASSIFIER IS A HINT, NOT THE VERDICT — AND ITS FALSE POSITIVES ARE THE
 * EXPENSIVE DIRECTION
 * Only a `deploy-order` block makes a carrier GRADEABLE. Prose that looks like a deploy
 * order merely makes it SUSPECTED. Measured on the first live run (2026-08-13, 58 recent
 * carriers): 18 suspected, and several are plainly NOT trains — TRA-3413 says "if you
 * find yourself about to redeploy bqb1, STOP", TRA-3398 quotes a dated embargo, TRA-3157
 * and TRA-3153 discuss an `EMBARGOES` row. A grader over other people's artefacts fails
 * toward CONVICTING them, so SUSPECTED is reported as "this may be a train — add the
 * block, or add the opt-out marker", never as "your routine is defective".
 *
 * ⇒ THEREFORE THE TWO STATES GET TWO EXIT CODES. A single stranded deploy is an
 * incident; eighteen un-annotated carriers are a migration backlog. Folding them into
 * one number buries the incident under the backlog, which is how a real alarm gets
 * trained into noise.
 *
 * Exit codes — FAILS CLOSED:
 *   0  CLEAN     — every graded order is SATISFIED or legitimately PENDING, and nothing
 *                  is suspected-but-unannotated.
 *   1  STRANDED  — at least one order whose deadline PASSED with its commit NOT in the
 *                  live build. THE INCIDENT. This is the only code that should page.
 *   2  usage / auth / API error.
 *   3  BLIND     — a control failed, the population could not be read, or the live SHA
 *                  is unreadable/unknown to this checkout. NEVER a pass: "I could not
 *                  check" is not "nothing is stranded".
 *   4  UNGRADED  — no stranded order, but N carriers carry no machine-readable order, so
 *                  the sweep could not see them. Non-zero on purpose (it must not read
 *                  as green) and distinct from 1 on purpose (it is not an incident).
 *
 * Precedence when several apply: BLIND > STRANDED > UNGRADED > CLEAN. A blind leg
 * outranks a clean one, and an incident outranks a backlog.
 */

import { spawnSync } from 'node:child_process';

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;
export const EXIT_BLIND = 3;
export const EXIT_UNGRADED = 4;

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';

// ⛔ `/api/health` carries NO `build` block. The commit lives on the options-live route.
const HEALTH_PATH = '/api/health/options-live';

// ─────────────────────────────────────────────────────────────────────────────
// THE PURE CORE. No I/O below this line until the live shell.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deploy mention is an ORDER only if it is not inside a prohibition or a retraction.
 * Both lists are matched per-LINE, because a body that both orders a deploy and quotes
 * the freeze rule is normal and must still classify as TRAIN.
 */
const ORDER_PATTERNS = [
  /render-redeploy\.mjs/i,
  /\/v1\/services\/[^\s`'"]*\/deploys/i,
  /\bre-?deploy\b[^.\n]{0,90}\b(bqb1|tradingai-bqb1|srv-[a-z0-9]+)\b/i,
  /\bdeploy\b[^.\n]{0,90}\b(bqb1|tradingai-bqb1|srv-[a-z0-9]+)\b/i,
  /\b(bqb1|tradingai-bqb1)\b[^.\n]{0,90}\bre-?deploy\b/i,
];

const NEGATION_PATTERNS = [
  /\b(do not|do NOT|don't|never|must not|shall not|cannot|can't|no longer|refus\w*|forbidden|prohibit\w*|instead of|rather than|deprecated|superseded|supersedes|retract\w*|withdrawn|is not an order|not an order)\b/i,
];

const OPT_OUT_MARKER = /<!--\s*deploy-order:\s*none\s*-->/i;

/**
 * Is a deploy mention on this line an ORDER, or is it being quoted in order to be
 * forbidden? Exported so the controls can pin it directly.
 */
export function lineOrdersDeploy(line) {
  if (!ORDER_PATTERNS.some((re) => re.test(line))) return false;
  if (NEGATION_PATTERNS.some((re) => re.test(line))) return false;
  return true;
}

/**
 * 3-way classification with the matched span carried out, so a finding can be resolved
 * by reading the line rather than by trusting the label.
 *
 * @returns {{ kind: 'train'|'not-train'|'ambiguous', span: string|null, reason: string }}
 */
export function classifyCarrier(description) {
  const body = typeof description === 'string' ? description : '';

  // The block IS the order. It short-circuits the prose predicate in both directions:
  // it promotes a body whose wording the patterns would miss, and it gives an author a
  // way to settle a false AMBIGUOUS without arguing with a regex.
  if (findOrderBlocks(body).length > 0) {
    return { kind: 'train', span: '```deploy-order block present', reason: 'explicit deploy-order block' };
  }

  if (OPT_OUT_MARKER.test(body)) {
    return { kind: 'not-train', span: null, reason: 'explicit `deploy-order: none` opt-out' };
  }

  const lines = body.split(/\r?\n/);
  const ordering = lines.filter((l) => lineOrdersDeploy(l));
  if (ordering.length > 0) {
    return { kind: 'train', span: ordering[0].trim().slice(0, 200), reason: 'prose orders a deploy' };
  }

  const mentions = lines.filter((l) => ORDER_PATTERNS.some((re) => re.test(l)));
  if (mentions.length > 0) {
    // Every mention was negated. That is USUALLY a retraction or a quoted freeze rule
    // and genuinely not a train — but a substring grep cannot prove which, and dropping
    // it silently is the fail-open. One human glance at the printed span settles it.
    return {
      kind: 'ambiguous',
      span: mentions[0].trim().slice(0, 200),
      reason: 'mentions deploying, every mention inside a prohibition or retraction',
    };
  }

  return { kind: 'not-train', span: null, reason: 'no deploy mention' };
}

/** Every ```deploy-order fenced block in a body, as raw inner text. */
export function findOrderBlocks(body) {
  const out = [];
  const re = /^[ \t]*(?:```|~~~)[ \t]*deploy-order[ \t]*\r?\n([\s\S]*?)^[ \t]*(?:```|~~~)[ \t]*$/gim;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

/**
 * Parse THE order. Fails closed and NAMES the missing field: a half-parsed order that
 * defaults its deadline is worse than no order at all, because it grades.
 *
 * @returns {{ ok: true, order: {commit,host,deadlineMs,deadline} } | { ok: false, error: string }}
 */
export function parseDeployOrder(description) {
  const body = typeof description === 'string' ? description : '';
  const blocks = findOrderBlocks(body);
  if (blocks.length === 0) return { ok: false, error: 'no ```deploy-order block' };
  if (blocks.length > 1) {
    return { ok: false, error: `${blocks.length} deploy-order blocks — which one is the order?` };
  }

  const fields = {};
  for (const line of blocks[0].split(/\r?\n/)) {
    const m = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (m) fields[m[1].toLowerCase()] = m[2];
  }

  const missing = ['commit', 'host', 'deadline'].filter((k) => !fields[k]);
  if (missing.length > 0) return { ok: false, error: `deploy-order missing: ${missing.join(', ')}` };

  const commit = fields.commit.replace(/^`|`$/g, '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    return { ok: false, error: `deploy-order commit is not a sha: ${JSON.stringify(commit)}` };
  }

  // ⛔ MUST end in Z. Routine crons are evaluated in ET and these windows are written in
  // UTC; a bare `2026-08-13T13:25:00` would be read as local time by Date.parse on some
  // runtimes and as UTC on others, and both answers look equally confident.
  const deadline = fields.deadline.trim();
  if (!/Z$/.test(deadline)) {
    return { ok: false, error: `deadline must be an absolute UTC instant ending in Z, got ${JSON.stringify(deadline)}` };
  }
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) return { ok: false, error: `unparseable deadline ${JSON.stringify(deadline)}` };

  return { ok: true, order: { commit, host: fields.host.trim(), deadline, deadlineMs } };
}

/**
 * THE ANCESTRY PREDICATE, total over the three states ancestry actually has.
 *
 * `knownSha` MUST be consulted BEFORE `isAncestor`: a shallow clone answers "is X an
 * ancestor of Y" with the same non-zero exit whether the answer is no or the question is
 * unanswerable, so folding them together turns a blind checkout into a confident false
 * STRANDED — i.e. into an accusation.
 *
 * Deliberately a local copy of `check-fix-live.mjs`'s `gradeAncestry` rather than an
 * import: that file calls its main at MODULE SCOPE, so importing it would run a full
 * live grade and `process.exit()` this process (the trap `scripts/lib/
 * paperclip-enumeration.mjs` was extracted to survive).
 *
 * @returns {'present'|'absent'|'blind'}
 */
export function gradeAncestry({ commit, liveSha, knownSha, isAncestor }) {
  if (!commit || !liveSha) return 'blind';
  if (!knownSha(commit)) return 'blind';
  if (!knownSha(liveSha)) return 'blind';
  return isAncestor(commit, liveSha) ? 'present' : 'absent';
}

/**
 * Grade ONE carrier. Pure: every read is injected.
 *
 * `finding` is reserved for STRANDED — the incident. `ungraded` is the migration backlog:
 * a carrier this check could not see into. They are separate fields because they carry
 * separate exit codes, and collapsing them lets a backlog of eighteen bury one incident.
 *
 * @returns {{ verdict, finding: boolean, ungraded: boolean, timing: 'unread'|'n/a', detail: string }}
 *   verdict ∈ SATISFIED | PENDING | STRANDED | UNGRADEABLE | AMBIGUOUS | NOT_TRAIN | BLIND
 */
export function gradeCarrier({ description, nowMs, liveSha, knownSha, isAncestor, hasTimingArm = false }) {
  const cls = classifyCarrier(description);
  if (cls.kind === 'not-train') {
    return { verdict: 'NOT_TRAIN', finding: false, ungraded: false, timing: 'n/a', detail: cls.reason, span: cls.span };
  }
  if (cls.kind === 'ambiguous') {
    return {
      verdict: 'AMBIGUOUS',
      finding: false,
      ungraded: true,
      timing: 'n/a',
      detail: `${cls.reason} — probably not a train, but a grep cannot prove which, so it is not dropped silently`,
      span: cls.span,
    };
  }

  const parsed = parseDeployOrder(description);
  if (!parsed.ok) {
    return {
      verdict: 'UNGRADEABLE',
      finding: false,
      ungraded: true,
      timing: 'n/a',
      detail: `${parsed.error} — SUSPECTED train: add the block if it is one, or the \`deploy-order: none\` marker if it is not`,
      span: cls.span,
    };
  }

  const { order } = parsed;
  const ancestry = gradeAncestry({ commit: order.commit, liveSha, knownSha, isAncestor });
  if (ancestry === 'blind') {
    return {
      verdict: 'BLIND',
      finding: false,
      ungraded: false,
      timing: 'n/a',
      detail: `ancestry unanswerable for ${short(order.commit)} against live ${short(liveSha)} — shallow checkout or unknown sha`,
      order,
      span: cls.span,
    };
  }

  const pastDeadline = nowMs >= order.deadlineMs;
  if (ancestry === 'present') {
    // ⛔ Live NOW is not live BY THE DEADLINE. Without the Render history arm this
    // cannot tell a train that ran on time from one whose commit arrived hours late on
    // somebody else's deploy — which is exactly the 2026-08-13 case. Say so.
    const timing = pastDeadline && !hasTimingArm ? 'unread' : 'n/a';
    return {
      verdict: 'SATISFIED',
      finding: false,
      ungraded: false,
      timing,
      detail: `${short(order.commit)} is an ancestor of live ${short(liveSha)}`,
      order,
      span: cls.span,
    };
  }

  if (!pastDeadline) {
    return {
      verdict: 'PENDING',
      finding: false,
      ungraded: false,
      timing: 'n/a',
      detail: `${short(order.commit)} not yet live; deadline ${order.deadline} is still ahead`,
      order,
      span: cls.span,
    };
  }

  return {
    verdict: 'STRANDED',
    finding: true,
    ungraded: false,
    timing: 'n/a',
    detail: `deadline ${order.deadline} PASSED and ${short(order.commit)} is NOT an ancestor of live ${short(liveSha)}`,
    order,
    span: cls.span,
  };
}

const short = (s) => (typeof s === 'string' ? s.slice(0, 8) : String(s));

/**
 * The recency filter, pure so it can carry a control.
 *
 * ⛔ An UNREADABLE `triggeredAt` is INCLUDED. The filter's job is to drop settled
 * history, and a missing timestamp is not evidence of age — letting it exclude a row
 * would mean a malformed run could delete itself from the sweep, which is the exact
 * fail-open this whole file exists to refuse.
 */
export function firedSince(triggeredAt, sinceMs) {
  if (sinceMs == null) return true;
  const t = Date.parse(triggeredAt);
  if (!Number.isFinite(t)) return true;
  return t >= sinceMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS — both directions, run on EVERY invocation.
// ─────────────────────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-08-13T12:00:00Z');
const LIVE = 'c44a890030c68af93014c1b92e73919b1ae61aa7';
const IN_LIVE = '65fdb95aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOT_IN_LIVE = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const stubKnown = (s) => [LIVE, IN_LIVE, NOT_IN_LIVE].includes(s);
const stubAncestor = (a, b) => b === LIVE && a === IN_LIVE;

const orderBlock = (commit, deadline) =>
  ['```deploy-order', `commit: ${commit}`, 'host: tradingai-bqb1', `deadline: ${deadline}`, '```'].join('\n');

const CONTROLS = [
  {
    name: 'POSITIVE — a passed deadline with the commit ABSENT from live grades STRANDED',
    run: () =>
      expect(
        gradeCarrier({
          description: `Deploy to bqb1 before the open.\n\n${orderBlock(NOT_IN_LIVE, '2026-08-13T11:00:00Z')}`,
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, isAncestor: stubAncestor,
        }),
        (r) => r.verdict === 'STRANDED' && r.finding === true,
      ),
  },
  {
    name: 'NEGATIVE — the same order with the commit PRESENT in live is SILENT (no finding)',
    run: () =>
      expect(
        gradeCarrier({
          description: `Deploy to bqb1 before the open.\n\n${orderBlock(IN_LIVE, '2026-08-13T11:00:00Z')}`,
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, isAncestor: stubAncestor,
        }),
        (r) => r.verdict === 'SATISFIED' && r.finding === false,
      ),
  },
  {
    name: 'NEGATIVE — a SATISFIED order whose deadline has passed reports timing UNREAD, not OK',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(IN_LIVE, '2026-08-13T11:00:00Z'),
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, isAncestor: stubAncestor,
        }),
        (r) => r.verdict === 'SATISFIED' && r.timing === 'unread',
      ),
  },
  {
    name: 'USE-vs-MENTION — a RETRACTION quoting the order it kills is NOT classified as a train',
    run: () =>
      expect(
        classifyCarrier(
          'RETRACTED. Any earlier text telling you to run `node scripts/render-redeploy.mjs` against\n' +
            'bqb1 is superseded and must not be executed.\n' +
            'Never deploy to tradingai-bqb1 during the 13:25-20:00Z freeze.',
        ),
        (r) => r.kind !== 'train',
      ),
  },
  {
    name: 'USE-vs-MENTION — a real order that ALSO quotes the freeze rule IS still a train',
    run: () =>
      expect(
        classifyCarrier(
          'Run `node scripts/render-redeploy.mjs --commit=65fdb95` against bqb1 after the close.\n' +
            'Do not deploy to tradingai-bqb1 inside the 13:25-20:00Z RTH freeze.',
        ),
        (r) => r.kind === 'train',
      ),
  },
  {
    name: 'ADOPTION LEVER — a prose train with NO order block is UNGRADED (exit 4), NOT stranded (exit 1)',
    run: () =>
      expect(
        gradeCarrier({
          description: 'One-shot: post-RTH deploy 65fdb95 to bqb1 via scripts/render-redeploy.mjs.',
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, isAncestor: stubAncestor,
        }),
        // The two buckets must be DISJOINT. If `finding` ever went true here, a migration
        // backlog of eighteen would report as eighteen stranded deploys and the exit code
        // that means "incident" would stop meaning anything.
        (r) => r.verdict === 'UNGRADEABLE' && r.ungraded === true && r.finding === false,
      ),
  },
  {
    name: 'FAILS CLOSED — a commit UNKNOWN to this checkout is BLIND, never STRANDED',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock('abc1234', '2026-08-13T11:00:00Z'),
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, isAncestor: stubAncestor,
        }),
        (r) => r.verdict === 'BLIND' && r.finding === false,
      ),
  },
  {
    name: 'FAILS CLOSED — a deadline with no Z is REJECTED, not silently read as local time',
    run: () => expect(parseDeployOrder(orderBlock(IN_LIVE, '2026-08-13T11:00:00')), (r) => r.ok === false),
  },
  {
    name: 'FAILS CLOSED — TWO order blocks is an error, not "take the first"',
    run: () =>
      expect(
        parseDeployOrder(`${orderBlock(IN_LIVE, '2026-08-13T11:00:00Z')}\n${orderBlock(NOT_IN_LIVE, '2026-08-13T11:00:00Z')}`),
        (r) => r.ok === false,
      ),
  },
  {
    name: 'NOT-YET — an unmet order whose deadline is AHEAD is PENDING, not a finding',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(NOT_IN_LIVE, '2026-08-13T23:00:00Z'),
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, isAncestor: stubAncestor,
        }),
        (r) => r.verdict === 'PENDING' && r.finding === false,
      ),
  },
  {
    name: 'OPT-OUT — an explicit `deploy-order: none` marker leaves the population on the record',
    run: () =>
      expect(
        classifyCarrier('Discuss the deploy to bqb1 with the CTO.\n<!-- deploy-order: none -->'),
        (r) => r.kind === 'not-train',
      ),
  },
  {
    name: 'RECENCY — a fire inside the window is IN, one before it is OUT',
    run: () => expect([firedSince('2026-08-13T06:30:00Z', T0 - 864e5), firedSince('2026-07-24T20:40:00Z', T0 - 864e5)], (r) => r[0] === true && r[1] === false),
  },
  {
    name: 'RECENCY FAILS OPEN INTO THE POPULATION — an unreadable triggeredAt is INCLUDED',
    run: () => expect([firedSince(null, T0), firedSince('not-a-date', T0)], (r) => r[0] === true && r[1] === true),
  },
  {
    name: 'POPULATION — a carrier with no deploy mention at all is NOT_TRAIN and silent',
    run: () =>
      expect(
        gradeCarrier({
          description: 'Re-check the journal cross-tab and post the numbers.',
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, isAncestor: stubAncestor,
        }),
        (r) => r.verdict === 'NOT_TRAIN' && r.finding === false,
      ),
  },
];

function expect(actual, pred) {
  return pred(actual) ? { ok: true, actual } : { ok: false, actual };
}

export function runControls() {
  return CONTROLS.map((c) => {
    let res;
    try {
      res = c.run();
    } catch (err) {
      res = { ok: false, actual: `threw ${err?.message || err}` };
    }
    return { name: c.name, ok: res.ok, actual: res.actual };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE SHELL
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const knownSha = (s) => git(['cat-file', '-e', `${s}^{commit}`]).ok;
const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b]).ok;

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

async function main() {
  // The instrument is graded before anything it says can be believed.
  const controls = runControls();
  const badControls = controls.filter((c) => !c.ok);
  for (const c of controls) console.log(`[train] control ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
  if (badControls.length > 0) {
    console.log('');
    console.log(`[train] VERDICT = BLIND — ${badControls.length} control(s) failed. The detector is broken,`);
    console.log('[train] so its silence is worth nothing and no carrier verdict is printed.');
    for (const c of badControls) console.log(`[train]   FAILED: ${c.name}\n[train]     got ${JSON.stringify(c.actual)}`);
    return EXIT_BLIND;
  }
  console.log(`[train] ${controls.length}/${controls.length} controls pass, both directions.`);
  console.log('');

  if (flag('selftest')) {
    console.log('[train] --selftest: controls only, no live sweep.');
    return EXIT_CLEAN;
  }

  const base = String(process.env.PAPERCLIP_API_URL || '').replace(/\/$/, '').replace(/\/api$/, '');
  const key = process.env.PAPERCLIP_API_KEY;
  const company = process.env.PAPERCLIP_COMPANY_ID;
  if (!base || !key || !company) {
    console.error('[train] ERROR — PAPERCLIP_API_URL / PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID required.');
    return EXIT_ERROR;
  }
  const auth = { Authorization: `Bearer ${key}` };

  // ── the live SHA ───────────────────────────────────────────────────────────
  let liveSha = flag('live');
  if (typeof liveSha !== 'string' || liveSha === '') {
    const host = typeof flag('host') === 'string' ? flag('host') : DEFAULT_HOST;
    try {
      const health = await getJson(`${host}${HEALTH_PATH}`);
      liveSha = health?.build?.commit;
      if (!liveSha) {
        console.log(`[train] VERDICT = BLIND — ${host}${HEALTH_PATH} served no build.commit.`);
        return EXIT_BLIND;
      }
      console.log(`[train] live build  ${short(liveSha)}  pid ${health?.build?.pid}  booted ${health?.build?.startedAt}`);
    } catch (err) {
      console.log(`[train] VERDICT = BLIND — could not read the live build: ${err.message}`);
      console.log('[train] An unreachable host is not an empty finding list.');
      return EXIT_BLIND;
    }
  }
  if (!knownSha(liveSha)) {
    console.log(`[train] VERDICT = BLIND — live sha ${short(liveSha)} is unknown to this checkout.`);
    console.log('[train] Every ancestry answer would be unanswerable, which reads as STRANDED. Fetch first.');
    return EXIT_BLIND;
  }

  // ── single-issue mode ──────────────────────────────────────────────────────
  // ⭐ THE CONTROLS ABOVE PROVE THE PREDICATE ON SYNTHETIC STRINGS. They say nothing
  // about whether the LIVE path — fetch a real issue, find the block in a real
  // description, grade it against a real SHA — works at all. Until some carrier on the
  // board carries a block, the sweep can only ever report what it CANNOT see, and a
  // detector that has never once produced a GRADED row is not known to be able to.
  // `--issue` is how that end-to-end path gets exercised against a real issue.
  if (typeof flag('issue') === 'string') {
    const ident = flag('issue');
    let issue;
    try {
      issue = await getJson(`${base}/api/issues/${ident}`, auth);
    } catch (err) {
      console.error(`[train] ERROR reading ${ident}: ${err.message}`);
      return EXIT_ERROR;
    }
    const g = gradeCarrier({ description: issue?.description, nowMs: Date.now(), liveSha, knownSha, isAncestor });
    console.log(`[train] single issue ${issue?.identifier || ident} — ${issue?.title || ''}`);
    console.log(`[train]   VERDICT = ${g.verdict}${g.timing === 'unread' ? '  [timing UNREAD]' : ''}`);
    console.log(`[train]   ${g.detail}`);
    if (g.span) console.log(`[train]   span: ${g.span}`);
    if (g.verdict === 'BLIND') return EXIT_BLIND;
    if (g.finding) return EXIT_FINDINGS;
    if (g.ungraded) return EXIT_UNGRADED;
    return EXIT_CLEAN;
  }

  // ── the population ─────────────────────────────────────────────────────────
  let routines;
  try {
    routines = await getJson(`${base}/api/companies/${company}/routines?limit=500`, auth);
  } catch (err) {
    console.error(`[train] ERROR reading routines: ${err.message}`);
    return EXIT_ERROR;
  }
  if (!Array.isArray(routines) || routines.length === 0) {
    console.log('[train] VERDICT = BLIND — the routines route returned no rows.');
    return EXIT_BLIND;
  }

  const nowMs = Date.now();

  // ── recency: the subject is orders that can still strand, not settled history ──
  let sinceMs = null;
  let sinceLabel = 'ALL history (--all)';
  if (!flag('all')) {
    const raw = flag('since');
    if (typeof raw === 'string' && raw !== '') {
      sinceMs = Date.parse(raw);
      if (!Number.isFinite(sinceMs)) {
        console.error(`[train] ERROR — unparseable --since=${raw}`);
        return EXIT_ERROR;
      }
    } else {
      sinceMs = nowMs - 7 * 864e5;
    }
    sinceLabel = new Date(sinceMs).toISOString();
  }

  const allCarriers = [];
  for (const r of routines) {
    const id = r?.lastRun?.linkedIssueId;
    if (id) {
      allCarriers.push({ routine: String(r.id).slice(0, 8), issueId: id, firedAt: r?.lastRun?.triggeredAt ?? null });
    }
  }
  if (allCarriers.length === 0) {
    console.log('[train] VERDICT = BLIND — 0 carriers across ' + routines.length + ' routines.');
    console.log('[train] A population that cannot be non-empty cannot license a clean verdict.');
    return EXIT_BLIND;
  }

  const carrierIds = allCarriers.filter((c) => firedSince(c.firedAt, sinceMs));
  const excluded = allCarriers.length - carrierIds.length;
  console.log(`[train] population: ${carrierIds.length} carriers fired since ${sinceLabel}; ${excluded} older EXCLUDED.`);
  if (excluded > 0) {
    console.log('[train]   (not a silent cap — settled history predates the `deploy-order` rule and cannot');
    console.log('[train]    strand anything now. Re-run with --all to grade the backlog anyway.)');
  }
  if (carrierIds.length === 0) {
    console.log('[train] VERDICT = BLIND — the recency window contains no carriers at all, so a clean');
    console.log('[train] result would only prove the window is empty. Widen --since.');
    return EXIT_BLIND;
  }

  const rows = [];
  for (const c of carrierIds) {
    let issue;
    try {
      issue = await getJson(`${base}/api/issues/${c.issueId}`, auth);
    } catch (err) {
      rows.push({ ...c, identifier: c.issueId, verdict: 'BLIND', finding: false, detail: `carrier unreadable: ${err.message}` });
      continue;
    }
    const g = gradeCarrier({ description: issue?.description, nowMs, liveSha, knownSha, isAncestor });
    rows.push({ ...c, identifier: issue?.identifier || c.issueId, status: issue?.status, startedAt: issue?.startedAt ?? null, ...g });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  const trains = rows.filter((r) => r.verdict !== 'NOT_TRAIN');
  const stranded = rows.filter((r) => r.finding);
  const ungraded = rows.filter((r) => r.ungraded);
  const graded = trains.filter((r) => !r.ungraded && r.verdict !== 'BLIND');
  const blind = rows.filter((r) => r.verdict === 'BLIND');

  if (flag('json')) {
    console.log(JSON.stringify({ liveSha, carriers: rows.length, trains: trains.length, stranded, ungraded, blind }, null, 2));
  }

  const line = (r) => {
    const timing = r.timing === 'unread' ? '  [timing UNREAD]' : '';
    console.log(`[train]   ${r.verdict.padEnd(11)} ${String(r.identifier).padEnd(10)} routine ${r.routine}  fired ${r.firedAt ?? 'unknown'}`);
    console.log(`[train]       ${r.detail}${timing}`);
    if (r.span && r.verdict !== 'SATISFIED') console.log(`[train]       span: ${r.span}`);
  };

  console.log('');
  console.log(`[train] ${carrierIds.length} carriers read, ${trains.length} in the deploy population, ${graded.length} GRADED against a machine-readable order.`);

  console.log('');
  console.log(`[train] ── GRADED (${graded.length}) — these carry a \`deploy-order\` block and were measured ──`);
  if (graded.length === 0) {
    console.log('[train]   (none — no carrier on the board carries the block yet. Until one does, this');
    console.log('[train]   check can only report what it CANNOT see, which is the state below.)');
  }
  for (const r of graded) line(r);

  console.log('');
  console.log(`[train] ── UN-GRADED (${ungraded.length}) — SUSPECTED trains this check could not see into ──`);
  console.log('[train]   Not an accusation: the prose classifier has known false positives, and every');
  console.log('[train]   row below predates the rule. Resolve by adding the `deploy-order` block if it');
  console.log('[train]   IS a train, or the `<!-- deploy-order: none -->` marker if it is not.');
  for (const r of ungraded) line(r);

  console.log('');
  console.log('[train] ⛔ NAMED LIMIT, printed every run: carriers come from `lastRun` on the routines');
  console.log('[train]    list route, i.e. ONE per routine, the newest. A worked newer carrier hides an');
  console.log('[train]    abandoned older one. Deploy trains are one-shots that archive themselves at');
  console.log('[train]    step 1, so they have ~one carrier each — close to complete here, still a limit.');
  console.log('[train] ⛔ SATISFIED means the commit is live NOW, not that it was live BY THE DEADLINE.');
  console.log('[train]    The timing arm needs Render deploy history and is UNREAD, not OK.');

  // Precedence: a blind leg outranks a clean one, and an incident outranks a backlog.
  console.log('');
  if (blind.length > 0) {
    console.log(`[train] VERDICT = BLIND — ${blind.length} carrier(s) could not be read at all.`);
    return EXIT_BLIND;
  }
  if (stranded.length > 0) {
    console.log(`[train] VERDICT = STRANDED — ${stranded.length} deploy order(s) past deadline and NOT live.`);
    console.log('[train] This is the incident this check exists for. Each is named above with its commit.');
    return EXIT_FINDINGS;
  }
  if (ungraded.length > 0) {
    console.log(`[train] VERDICT = UNGRADED — 0 stranded among the ${graded.length} order(s) this check could`);
    console.log(`[train] measure, and ${ungraded.length} suspected carrier(s) it could not. NOT a clean bill of health:`);
    console.log('[train] with 0 graded orders a "no stranded deploys" result is a statement about the');
    console.log('[train] instrument, not about the board.');
    return EXIT_UNGRADED;
  }
  console.log(`[train] VERDICT = CLEAN — all ${graded.length} graded deploy order(s) SATISFIED or legitimately PENDING,`);
  console.log('[train] and no suspected carrier is unannotated.');
  return EXIT_CLEAN;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[train] ERROR', err?.stack || err);
    process.exit(EXIT_BLIND);
  });
