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
 *     deadline: 2026-08-13T13:24:00Z
 *     ```
 *
 * `deadline` MUST be an absolute UTC instant ending in `Z`. A bare local time is
 * REJECTED rather than silently interpreted — routine crons are evaluated in ET and the
 * windows are written in UTC, and that is exactly the mix that produces a confidently
 * wrong deadline. ⛔ AND IT MUST NAME AN INSTANT THE SANCTIONED PATH CAN ACT AT: this
 * example used to read `13:25:00Z`, the FIRST frozen instant of the weekday RTH freeze,
 * and 4 of 5 live orders copied exactly that as house style (TRA-5052). 13:24Z is the
 * honest weekday boundary; the freeze is open all weekend, and most trains want a
 * post-close deadline rather than a boundary-tight one anyway. A deadline inside the
 * freeze grades UNMEETABLE_WINDOW (exit 7), never CLEAN and never STRANDED.
 * A carrier that a human would call a deploy train and that carries no
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
 * mode of a grader over other people's artefacts is to convict them. If any control fails
 * the run exits 6 HARNESS — its own code, outranking every live verdict — and the live
 * sweep still runs and still prints, labelled PROVISIONAL (TRA-4977 AC4, reasoned below).
 *
 * POPULATION — TWO ARMS, and a NAMED limitation printed every run
 * ---------------------------------------------------------------
 * ARM 1, ROUTINE-BORN: `lastRun.linkedIssueId` on the routines list route, i.e. ONE
 * carrier per routine, the newest. A worked newer carrier hides an abandoned older one.
 * Deploy trains are one-shots whose own prose archives them at step 1, so a deploy-train
 * routine has essentially one carrier in its life. Closing that entirely means paging
 * `/api/routines/{id}/runs` per routine, which is NOT implemented here — do not read the
 * printed limit as "there is a flag for that".
 *
 * ARM 2, HAND-FILED (TRA-4984): any issue on the board, via the PAGED issue list.
 *
 * ⛔ ARM 1 ALONE EXCLUDED AN ENTIRE CLASS OF CARRIER BY CONSTRUCTION, AND IT WAS THE
 * CLASS THAT MATTERS MOST. TRA-4942 ordered a commit onto the REAL-MONEY host, by hand,
 * with a real deadline and a syntactically perfect block — and was not a candidate, so
 * the sweep reported nothing about it however often it ran. A human hand-files a deploy
 * precisely when the decision is too consequential to automate. Arm 1's named limit was
 * about WHICH routine-born carrier you see; this was a larger hole of a different kind.
 *
 * It survived six weeks because the sweep was exiting 3 (BLIND) on its own controls the
 * whole time, which reads as "known-bad instrument". Generalisable: A BROKEN DETECTOR
 * HIDES ITS OWN COVERAGE GAPS — every verdict is already untrustworthy, so nobody gets as
 * far as asking whether the POPULATION was right. Repairing the controls is what exposed
 * this one.
 *
 * ⛔ ARM 2 FAILS CLOSED IN TWO PLACES, AND BOTH REFUSALS ARE THE SAME SENTENCE: "0
 * carriers found" IS NOT "the board is clean".
 *   · the ENUMERATION. `GET /api/companies/{c}/issues` caps at 1000 rows and an IGNORED
 *     `offset` returns a full page too, so exhaustiveness is proved by the deduped union
 *     GROWING (`enumerateIssues`). Any failure is a BLIND reason string, never an empty
 *     set.
 *   · the DESCRIPTION. The list route truncates `description` at ~1200 chars on 2735 of
 *     3000 rows (91.2%, measured 2026-10-02), and `classifyCarrier` on a cut body does
 *     not fail — it returns NOT_TRAIN, which is SILENT. So every in-window carrier is
 *     RE-READ with a full `GET /api/issues/{id}`, a still-truncated body is BLIND, and the
 *     read cost is bounded by `--issue-cap` which goes BLIND rather than grading a prefix.
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
 *   node scripts/check-deploy-train-window.mjs --issue-cap=400
 *       # the ceiling on in-window carriers RE-READ in full. Above it the verdict is
 *       # BLIND, never a silently graded prefix.
 *   node scripts/check-deploy-train-window.mjs --json
 *   node scripts/check-deploy-train-window.mjs --selftest      # controls only
 *   node scripts/check-deploy-train-window.mjs --live=<sha>    # grade a SHA you hold
 *   node scripts/check-deploy-train-window.mjs --host=https://…
 *   node scripts/check-deploy-train-window.mjs --render-key=… --render-service=srv-…
 *       # the TIMING arm. Off by default only in the sense that it needs a key: with
 *       # RENDER_API_KEY + RENDER_SERVICE_ID in the environment it arms itself, and
 *       # whether it is on or off is PRINTED with its reason, never left to inference.
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
 *   5  LATE      — every order is live NOW, but at least one of them did not become live
 *                  until AFTER its deadline. Distinct from 1 because nothing is stranded
 *                  and distinct from 0 because the window was missed — which is the
 *                  literal subject of this ticket, and the state 2026-08-13 was in.
 *   6  HARNESS    — MY OWN CONTROLS FAILED (TRA-4977 AC4). See below: this is the
 *                  instrument reporting itself broken, which is a DIFFERENT message to a
 *                  DIFFERENT person than "I cannot grade your deploy", and the live scan
 *                  still runs and still prints underneath it.
 *   7  UNMEETABLE — at least one live order's deadline names an instant the sanctioned
 *                  deploy path itself REFUSES (inside the RTH freeze, or a dated
 *                  embargo), so the order was never meetable at its own boundary
 *                  (TRA-5052). An authoring defect, not an incident: it must not read
 *                  as green (the old PENDING did, right up to the deadline) and it must
 *                  not page as STRANDED (which the old grading did the minute after) —
 *                  it needs a different person to do a different thing: re-issue the
 *                  order with a reachable deadline.
 *
 * Precedence when several apply: HARNESS > BLIND > STRANDED > UNMEETABLE > LATE >
 * UNGRADED > CLEAN. A broken instrument outranks everything it says, a blind leg
 * outranks a clean one, a stranded order outranks a missed window, and both outrank a
 * backlog.
 *
 * ⛔ WHY A CONTROL FAILURE GETS ITS OWN CODE AND NO LONGER SILENCES THE LIVE SCAN (TRA-4977
 * AC4) — THE DECISION, AND BOTH HALVES OF IT
 * Until now a failing control `return`ed exit 3 BEFORE the live sweep ran, so ONE STALE
 * FIXTURE SILENCED THE PRODUCTION ALARM FOR EVERY CARRIER IN THE COMPANY, and the operator
 * could not tell "my test harness rotted" from "I cannot grade your deploy" — same exit
 * code, and in the first case not one word about the board.
 *
 *   KEPT: fail-closed. A control failure is still non-zero, it still OUTRANKS every live
 *   verdict including STRANDED, and the live rows printed under it are labelled
 *   PROVISIONAL. That ordering is not a formality — the detector's expensive direction is
 *   the false accusation (it grades other people's deploys), so a STRANDED produced by an
 *   instrument that cannot pass its own controls must not page as an incident.
 *
 *   CHANGED: it is exit 6, not 3, and the sweep RUNS ANYWAY. A broken fixture is a defect
 *   in THIS FILE, owned by whoever last edited it; a BLIND live leg is an operational fact
 *   about a checkout or a host. Routing both to one code routed them to one reader, and
 *   the historical cost is on the record: the controls sat red for six weeks, read as
 *   "known-bad instrument", and the six weeks of unprinted live scans are what let the
 *   population hole (TRA-4984) go unnoticed underneath them. Printing the scan is how a
 *   rotted harness stops also being a blackout.
 *
 * ⛔ A ROTTED HARNESS IS NOW CAUGHT BEFORE ANYONE RUNS THE SWEEP (TRA-4977 AC5). This
 * script's `--selftest` is in root `pretest`, beside `check:stale-js` and
 * `check:arg-guard`, so a control that goes stale fails the test suite for whoever broke
 * it instead of waiting for a carrier owner to run the detector by hand four days later.
 * The LIVE sweep is deliberately NOT in `pretest` — it is a multi-minute network scan —
 * which is exactly why the two needed separate exit codes first.
 */

import { spawnSync } from 'node:child_process';
import { gradedAncestry as libGradedAncestry, blindReason } from './lib/shallow-ancestry.mjs';
// TRA-4984: the hand-filed arm's population. The guard it carries is the whole reason it
// is a library — `GET /api/companies/{c}/issues` caps at 1000 rows and an IGNORED `offset`
// returns a FULL page, so a one-shot read is 42% of the board reported as all of it.
import { enumerateIssues } from './lib/paperclip-enumeration.mjs';

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;
export const EXIT_BLIND = 3;
export const EXIT_UNGRADED = 4;
export const EXIT_LATE = 5;
export const EXIT_HARNESS = 6;
export const EXIT_UNMEETABLE = 7;

/**
 * THE ONE PLACE THE RUN'S EXIT CODE IS DECIDED (TRA-4977 AC4). Pure, so the precedence is
 * gradeable in both directions rather than asserted in a comment.
 *
 * `controlsFailed` outranks `liveExit` unconditionally, INCLUDING over EXIT_FINDINGS. The
 * live rows are still computed and still printed — the point is that they arrive labelled,
 * not suppressed — but a verdict from an instrument that fails its own controls cannot be
 * allowed to page as an incident, because this detector's expensive direction is the false
 * accusation of someone else's deploy.
 */
export function finalExit({ controlsFailed, liveExit }) {
  return controlsFailed > 0 ? EXIT_HARNESS : liveExit;
}

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';

// The `host` field a deploy-order block names. It is the ONRENDER HOSTNAME, not the
// Render service's own name — the service reads `TradingAI-` in the API, which is why
// the timing arm cannot resolve a service by matching that string and binds by live-SHA
// identity instead (see `bindDeployHistory`).
const ORDER_HOST = 'tradingai-bqb1';

// Only these two ever served bytes. `build_failed` / `update_failed` / `canceled` /
// `*_in_progress` are deploys that existed and did NOT put the commit on the box, and
// counting one of them as "the commit was live by then" is the single most attractive
// wrong answer available to this arm.
const SERVED_STATUSES = new Set(['live', 'deactivated']);

// ⛔ `/api/health` carries NO `build` block. The commit lives on the options-live route.
const HEALTH_PATH = '/api/health/options-live';

// ─────────────────────────────────────────────────────────────────────────────
// THE PURE CORE. No I/O below this line until the live shell.
// ─────────────────────────────────────────────────────────────────────────────

// ⛔ THE CARRIER PREDICATE MOVED TO `scripts/lib/deploy-order.mjs` (TRA-3713) and is
// re-exported here UNCHANGED, so this file's public surface and all 21 of its controls
// are exactly what they were. It had to move because `check-slot-loss.mjs` needs the
// same `deadline` field and the same train/not-train split, and CANNOT import them from
// this file: `main()` is called at MODULE SCOPE below, so an import would run a full
// live grade and `process.exit()` the importer — the trap named in `gradeAncestry`'s
// comment, and the reason `scripts/lib/paperclip-enumeration.mjs` exists.
//
// ⛔ `import` + `export`, NOT `export … from`: a re-export creates NO LOCAL BINDING, so
// the bare `export … from` spelling would leave every in-file call site an undefined
// reference — and that failure surfaces as a ReferenceError at grade time, on the live
// sweep, not at load.
import {
  findOrderBlocks,
  parseDeployOrder,
  lineOrdersDeploy,
  classifyCarrier,
  gradeDeadlineGates,
} from './lib/deploy-order.mjs';
export { findOrderBlocks, parseDeployOrder, lineOrdersDeploy, classifyCarrier, gradeDeadlineGates };

// TRA-5052: the deadline-window gates. The predicates and the tables are THE EXECUTOR'S
// OWN — imported from scripts/render-redeploy.mjs rather than re-derived, because a
// second copy of 13:25–20:00Z is a second thing to get backwards (TRA-2313 is two of us
// reading the one freeze annotation backwards). The import is safe: render-redeploy's
// main() is gated on `invokedDirectly`, and scripts/tra2325-embargo-gate-check.mjs
// already imports it for the same predicates.
import {
  freezeState,
  embargoState,
  activeCadenceCeiling,
  EMBARGOES,
  CADENCE_CEILINGS,
} from './render-redeploy.mjs';

/**
 * The LIVE wiring of the deadline gates: the real predicates over the real tables. It is
 * `gradeCarrier`'s DEFAULT, not an opt-in — a live call site that forgets to pass it
 * still grades the window, and the UNMEETABLE controls run through this same chain, so a
 * planted mutation that drops the freeze check (in the predicate, this wiring, or
 * `gradeCarrier`'s use of it) turns them red.
 */
export function defaultDeadlineGates(deadlineMs) {
  return gradeDeadlineGates(deadlineMs, {
    freezeState,
    embargoState,
    activeCadenceCeiling,
    embargoes: EMBARGOES,
    cadenceCeilings: CADENCE_CEILINGS,
  });
}

/**
 * THE ANCESTRY PREDICATE, total over the three states ancestry actually has.
 *
 * TRA-3740: Rewritten to use the canonical shallow-aware ancestry grader from
 * scripts/lib/shallow-ancestry.mjs. A shallow clone makes `merge-base --is-ancestor`
 * return exit 1 both for "genuinely not an ancestor" and "the path was grafted away",
 * which are byte-identical. The old knownSha screens were necessary but NOT sufficient
 * (both objects can be present while the path between them is cut). A graft falling
 * through to 'absent' here manufactured STRANDED against a train that was obeyed on time.
 *
 * ⛔ TRA-4942: `ancestryOracle` IS THE CONTROLS' ONLY SEAM, AND THE TRA-3740 REWRITE CUT IT.
 * That rewrite replaced the injected `isAncestor` with a direct `libGradedAncestry` call —
 * correct for production (the library is the shallow-aware remedy) but it made this function
 * read the REAL repository unconditionally. The controls grade synthetic SHAs
 * (`65fdb95aaa…`, `deadbeef…`, live `c44a8900…`) that exist in NO checkout by construction,
 * so every one of them came back `answer: null` ⇒ `blind` ⇒ `VERDICT = BLIND, 11 controls
 * failed` — in EVERY checkout, shallow or not, since the rewrite. Measured 2026-10-01 in a
 * checkout with `is-shallow-repository = false` where the real carrier SHAs resolve fine, so
 * the standing diagnosis ("the TRA-3740 shallow condition in this checkout") was wrong on
 * both counts: not shallow, not checkout-local.
 *
 * The seam is therefore re-opened as a SEPARATE, OPTIONAL parameter rather than by honouring
 * `knownSha`/`isAncestor` again — reviving those screens would re-introduce the graft hole
 * TRA-3740 closed (both objects can be present while the path between them is cut). The
 * default IS the library, and no production call site passes an oracle.
 *
 * ⛔ TRA-4977 AC3: IT RETURNS THE LIBRARY'S OWN `verdict` ALONGSIDE THE STATE, AND THAT IS NOT
 * COSMETIC. The old signature returned the bare string `'blind'`, so the caller had nothing to
 * print and wrote the cause in by hand: `shallow checkout or unknown sha`. The library had
 * already MEASURED which of the two it was (`gradedAncestry` runs `rev-parse
 * --is-shallow-repository` on every negative and distinguishes `blind-shallow` /
 * `blind-missing-object` / `blind-unrelated` / `blind-no-sha` / `blind-undecidable`) — the grader
 * threw the answer away and then guessed it. Measured 2026-10-01 in a checkout where
 * `--is-shallow-repository` is **false**: the printed detail named a shallow clone as a candidate
 * cause of its own blindness, the first triage spent itself on clone depth, and the real cause
 * (synthetic control SHAs) was in the string's other half all along. A detector that
 * misattributes its own blindness costs a triage every time it fires, so the cause is now
 * REPORTED, never asserted — and an oracle that supplies no verdict reads `NOT MEASURED` rather
 * than borrowing a plausible one.
 *
 * @param {(held: string, target: string) => {answer: boolean|null, verdict?: string}} [ancestryOracle]
 * @returns {{ state: 'present'|'absent'|'blind', verdict: string|null }}
 */
export function gradeAncestry({ commit, liveSha, ancestryOracle = libGradedAncestry }) {
  // The library function is the canonical remedy (TRA-3699, TRA-3721).
  // It handles object presence, shallow detection, and unrelated-graph detection.
  const { answer, verdict } = ancestryOracle(commit, liveSha);
  const v = typeof verdict === 'string' && verdict !== '' ? verdict : null;
  if (answer === true) return { state: 'present', verdict: v };
  if (answer === false) return { state: 'absent', verdict: v };
  return { state: 'blind', verdict: v }; // answer === null
}

/**
 * The one sentence a BLIND row prints about WHY it is blind. It is the library's own graded
 * verdict wherever there is one; where there is not, it says so in those words.
 *
 * ⛔ The absent-verdict branch is a NAMED STATE, not a fallback to the plausible cause. Listing
 * "shallow, or a missing object, or git failed" when nothing was measured is the behaviour AC3
 * removed: it reads as a diagnosis, sends the reader to the wrong place, and is indistinguishable
 * in the output from a cause that WAS measured.
 */
export function ancestryBlindDetail(verdict) {
  if (typeof verdict !== 'string' || verdict === '') {
    return 'cause NOT MEASURED — the ancestry oracle returned no verdict to attribute it to';
  }
  return `${verdict}: ${blindReason(verdict)}`;
}

/** "3h 12m" — for a lateness that has to be read at a glance in a report line. */
export function humanGap(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0 && m === 0) return `${s}s`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * THE TIMING ARM — "was it live BY THE DEADLINE", which is a different question from
 * "is it live NOW" and is the one this whole ticket is about. On 2026-08-13 both deploy
 * orders were satisfied HOURS LATE by an unrelated path; an ancestry-only pass calls
 * that a healthy train.
 *
 * Pure: the Render deploy history is injected as plain rows, so both directions carry a
 * control. Every read is `{ commit, status, finishedAt }`.
 *
 * ⛔ IT FAILS TO `unread`, NEVER TO `late`. This arm grades OTHER PEOPLE'S deploys, so
 * its expensive direction is the false accusation, and there are three separate ways to
 * arrive at "I did not see an on-time deploy" that are NOT "there wasn't one":
 *
 *   1. HISTORY THAT STARTS AFTER THE DEADLINE. A truncated page cannot distinguish "no
 *      on-time deploy" from "the on-time deploy is one page further back". Coverage is
 *      asserted (the oldest served row must be at or before the deadline), not assumed.
 *   2. A PRE-DEADLINE DEPLOY WHOSE COMMIT THIS CHECKOUT DOES NOT KNOW. Ancestry against
 *      it is unanswerable, and an unanswerable ancestry inside the window is exactly
 *      where an on-time carrier would hide.
 *   3. NOTHING IN HISTORY CARRIES THE COMMIT AT ALL, while ancestry says it is live now
 *      — i.e. the carrying deploy is outside the fetched window.
 *
 * @returns {{ timing: 'on_time'|'late'|'unread', timingDetail: string }}
 */
export function gradeTiming({ order, deploys, knownSha, ancestryOracle = libGradedAncestry, historyHost = null }) {
  if (historyHost && order?.host && order.host !== historyHost) {
    return {
      timing: 'unread',
      timingDetail: `order targets ${order.host}; the deploy history read is ${historyHost} — another service's history cannot time this order`,
    };
  }
  if (!Array.isArray(deploys) || deploys.length === 0) {
    return { timing: 'unread', timingDetail: 'no Render deploy history was read' };
  }

  const served = deploys
    .map((d) => ({ commit: d?.commit, status: d?.status, finishedMs: Date.parse(d?.finishedAt) }))
    .filter((d) => SERVED_STATUSES.has(d.status) && Number.isFinite(d.finishedMs));
  if (served.length === 0) {
    return { timing: 'unread', timingDetail: 'the deploy history contains no deploy that ever served' };
  }

  // TRA-3740: Use shallow-aware ancestry. A graft makes `isAncestor` return false for
  // "path was cut" and "genuinely not an ancestor" identically, so a bare `.ok` can
  // turn a pre-deadline deploy unknown to a shallow checkout into timing='unread'
  // instead of timing='on_time', which then lets a stranded verdict through.
  //
  // ⛔ THE ASK IS PER DISTINCT COMMIT, AND ONLY WHERE A VERDICT TURNS ON IT. Every ask
  // spawns git (~400ms measured on Windows) and the history cap is 600 rows, so the naive
  // `served.filter(carries)` cost MINUTES PER GRADED CARRIER. That was survivable only
  // while the routine-born population yielded ~one graded carrier; once TRA-4984 widened
  // the population to hand-filed carriers the sweep stopped reaching a verdict at all, and
  // a detector nobody can afford to run is a detector that does not run. BOTH reductions
  // below are ANSWER-IDENTICAL, not approximations:
  //   · 580 served rows carry 503 DISTINCT commits (measured 2026-10-02). A re-deploy of
  //     the same commit cannot have a different ancestry, so the answer is cached by commit.
  //   · the full `carrying` list is read only by the two branches BELOW the on_time return,
  //     so it is built LAZILY. A healthy on-time train never asks about one post-deadline
  //     deploy.
  //
  // ⚠ AND NO TIME-BASED PRE-FILTER, THOUGH IT IS THE TEMPTING ONE. "A deploy that served
  // before the ordered commit's own committer date cannot carry it" would cut ~500 asks to
  // ~10 — and is REJECTED: a committer date is rewritable and skew-prone, and one forged
  // LATE would skip the genuinely-carrying deploy and turn an ON TIME train into LATE.
  // That is a false accusation, which this file names as the expensive direction.
  const carryCache = new Map();
  const carries = (d) => {
    if (typeof d.commit !== 'string') return false;
    if (carryCache.has(d.commit)) return carryCache.get(d.commit);
    const { answer } = ancestryOracle(order.commit, d.commit);
    const v = answer === true; // null (blind/shallow) fails closed to false
    carryCache.set(d.commit, v);
    return v;
  };
  const byTime = (a, b) => a.finishedMs - b.finishedMs;

  // ⛔ THIS STAYS AN ASCENDING SCAN OVER EVERY PRE-DEADLINE ROW. `onTime[0]` is the
  // EARLIEST carrying deploy at or before the deadline, and that instant IS the evidence
  // the verdict is quoted on. Scanning newest-first and stopping at the first hit would be
  // ONE ask instead of hundreds, and would quote a later instant than the proof — a
  // cheaper verdict backed by weaker evidence than the one the carrier was graded on.
  // (Filtering by deadline BEFORE asking is free and commutes.)
  const onTime = served
    .filter((d) => d.finishedMs <= order.deadlineMs)
    .filter(carries)
    .sort(byTime);
  if (onTime.length > 0) {
    return {
      timing: 'on_time',
      timingDetail: `serving by ${new Date(onTime[0].finishedMs).toISOString()} (deploy of ${short(onTime[0].commit)}), before the ${order.deadline} deadline`,
    };
  }

  const oldestServed = Math.min(...served.map((d) => d.finishedMs));
  if (oldestServed > order.deadlineMs) {
    return {
      timing: 'unread',
      timingDetail: `deploy history reaches back only to ${new Date(oldestServed).toISOString()}, AFTER the ${order.deadline} deadline — an on-time deploy would be invisible, so LATE cannot be asserted`,
    };
  }

  const blindPreDeadline = served.filter(
    (d) => d.finishedMs <= order.deadlineMs && !(typeof d.commit === 'string' && knownSha(d.commit)),
  );
  if (blindPreDeadline.length > 0) {
    return {
      timing: 'unread',
      timingDetail: `${blindPreDeadline.length} deploy(s) that served before the deadline carry commits unknown to this checkout — ancestry unanswerable in exactly the window an on-time carrier would occupy`,
    };
  }

  // Only the two branches from here down read the whole list, so this is where it is built.
  const carrying = served.filter(carries).sort(byTime);
  if (carrying.length === 0) {
    return {
      timing: 'unread',
      timingDetail: 'the commit is live now, but no deploy in the fetched history carries it — the carrying deploy is outside the window',
    };
  }

  return {
    timing: 'late',
    timingDetail: `first served ${new Date(carrying[0].finishedMs).toISOString()}, ${humanGap(carrying[0].finishedMs - order.deadlineMs)} AFTER the ${order.deadline} deadline (deploy of ${short(carrying[0].commit)})`,
  };
}

/**
 * Grade ONE carrier. Pure: every read is injected.
 *
 * `finding` is reserved for STRANDED — the incident. `ungraded` is the migration backlog:
 * a carrier this check could not see into. They are separate fields because they carry
 * separate exit codes, and collapsing them lets a backlog of eighteen bury one incident.
 *
 * TRA-5052: the deadline is graded against the GATES THE SANCTIONED EXECUTOR WILL APPLY,
 * not only against the clock. An unmet order whose deadline the executor REFUSES (RTH
 * freeze, dated embargo) is UNMEETABLE_WINDOW — `unmeetable`, its own exit code (7),
 * never `finding` — because a deadline that was never reachable through the sanctioned
 * path is a badly written order, not a stranded deploy, and the two want different
 * people doing different things. A gate whose answer needs state this run cannot read
 * (an active CADENCE_CEILINGS row: the quota is deploy history) grades BLIND, never
 * "meetable". A SATISFIED order keeps its verdict — the bytes are on the box — and the
 * window defect is carried as a printed `windowNote` instead: all four live 13:25Z
 * orders were satisfied early, by habit, and re-paging settled history would train the
 * alarm into noise.
 *
 * @returns {{ verdict, finding: boolean, unmeetable: boolean, ungraded: boolean, timing: 'unread'|'n/a', detail: string }}
 *   verdict ∈ SATISFIED | PENDING | STRANDED | UNMEETABLE_WINDOW | UNGRADEABLE | AMBIGUOUS | NOT_TRAIN | BLIND
 */
export function gradeCarrier({ description, nowMs, liveSha, knownSha, ancestryOracle = libGradedAncestry, deploys = null, historyHost = null, deadlineGates = defaultDeadlineGates }) {
  const cls = classifyCarrier(description);
  if (cls.kind === 'not-train') {
    return { verdict: 'NOT_TRAIN', finding: false, unmeetable: false, late: false, ungraded: false, timing: 'n/a', detail: cls.reason, span: cls.span };
  }
  if (cls.kind === 'ambiguous') {
    return {
      verdict: 'AMBIGUOUS',
      finding: false,
      unmeetable: false,
      late: false,
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
      unmeetable: false,
      late: false,
      ungraded: true,
      timing: 'n/a',
      detail: `${parsed.error} — SUSPECTED train: add the block if it is one, or the \`deploy-order: none\` marker if it is not`,
      span: cls.span,
    };
  }

  const { order } = parsed;
  const { state: ancestry, verdict: ancestryVerdict } = gradeAncestry({ commit: order.commit, liveSha, ancestryOracle });
  if (ancestry === 'blind') {
    return {
      verdict: 'BLIND',
      finding: false,
      unmeetable: false,
      late: false,
      ungraded: false,
      timing: 'n/a',
      detail: `ancestry unanswerable for ${short(order.commit)} against live ${short(liveSha)} — ${ancestryBlindDetail(ancestryVerdict)}`,
      order,
      span: cls.span,
    };
  }

  // TRA-5052: grade the INSTANT THE DEADLINE NAMES against the executor's own gates. A
  // non-function injection reads `unread` (fail closed), the same as the lib's own guard.
  const gates = typeof deadlineGates === 'function'
    ? deadlineGates(order.deadlineMs)
    : { gate: 'unread', detail: 'no deadline-gate predicate injected — "could not check the gate" is not "the gate is open"' };

  const pastDeadline = nowMs >= order.deadlineMs;
  if (ancestry === 'present') {
    // ⛔ Live NOW is not live BY THE DEADLINE. Without the Render history arm this
    // cannot tell a train that ran on time from one whose commit arrived hours late on
    // somebody else's deploy — which is exactly the 2026-08-13 case. Say so.
    let timing = 'n/a';
    let timingDetail = null;
    if (pastDeadline) {
      if (Array.isArray(deploys)) {
        ({ timing, timingDetail } = gradeTiming({ order, deploys, knownSha, ancestryOracle, historyHost }));
      } else {
        timing = 'unread';
        timingDetail = 'no Render deploy history read — pass --render-key or set RENDER_API_KEY to add the timing arm';
      }
    }
    return {
      verdict: 'SATISFIED',
      finding: false,
      unmeetable: false,
      // A missed window is NOT a stranded order: the bytes are on the box. It gets its
      // own flag and its own exit code so it can neither page as an incident nor hide
      // inside a pass.
      late: timing === 'late',
      ungraded: false,
      timing,
      timingDetail,
      // The bytes are on the box, so a gate defect in the deadline is writer-side
      // hygiene, PRINTED but never paged — see the TRA-5052 block in the docblock.
      windowNote: gates.gate === 'open' ? null : gates.detail,
      detail: `${short(order.commit)} is an ancestor of live ${short(liveSha)}`,
      order,
      span: cls.span,
    };
  }

  // The order is NOT met. Before the clock is consulted at all, ask whether the deadline
  // was ever an instant the sanctioned path would act at — PENDING-then-STRANDED on a
  // frozen deadline converts an authoring error into a page (TRA-5052).
  if (gates.gate === 'refused') {
    return {
      verdict: 'UNMEETABLE_WINDOW',
      finding: false,
      unmeetable: true,
      late: false,
      ungraded: false,
      timing: 'n/a',
      detail:
        `${short(order.commit)} is NOT live and the ${order.deadline} deadline ${pastDeadline ? 'has PASSED' : 'is ahead'} — but ` +
        `${gates.detail}. An order whose deadline the sanctioned path refuses is a BADLY WRITTEN ORDER, not a stranded ` +
        'deploy: re-issue it with a reachable deadline (13:24Z is the honest weekday boundary; post-close and weekend ' +
        'instants are open) instead of paging the executor.',
      order,
      span: cls.span,
    };
  }
  if (gates.gate === 'unread') {
    return {
      verdict: 'BLIND',
      finding: false,
      unmeetable: false,
      late: false,
      ungraded: false,
      timing: 'n/a',
      detail: `cannot decide whether the ${order.deadline} deadline is reachable through the sanctioned path — ${gates.detail}`,
      order,
      span: cls.span,
    };
  }

  if (!pastDeadline) {
    return {
      verdict: 'PENDING',
      finding: false,
      unmeetable: false,
      late: false,
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
    unmeetable: false,
    late: false,
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
// THE SECOND POPULATION ARM — HAND-FILED CARRIERS (TRA-4984)
//
// ⛔ A ROUTINE-BORN POPULATION CANNOT SEE THE CARRIERS THAT MATTER MOST.
// Until this arm existed the only gradeable carriers were issues born from a routine
// fire (`lastRun.linkedIssueId`). TRA-4942 — a deploy order on the REAL-MONEY host, with
// a real deadline and a syntactically perfect `deploy-order` block — was filed BY HAND by
// LeadDev off its parent, and was therefore outside the population BY CONSTRUCTION. The
// repaired detector was re-run against it and still reported nothing, because the row was
// never a candidate. A human hand-files a deploy when the decision is too consequential
// to automate, so the excluded class was exactly the consequential one.
//
// It stayed invisible for six weeks because the sweep was exiting 3 (BLIND) on its own
// controls the whole time. Generalisable: A BROKEN DETECTOR HIDES ITS OWN COVERAGE GAPS,
// because every verdict it emits is already untrustworthy, so nobody gets as far as
// asking whether the POPULATION was right.
// ─────────────────────────────────────────────────────────────────────────────

export const CLASS_ROUTINE = 'routine-born';
export const CLASS_HAND_FILED = 'hand-filed';

/**
 * The issue arm's recency stamp. Pure so it can carry a control.
 *
 * ⛔ IT IS `updatedAt`, NOT `createdAt`, AND THAT IS NOT INTERCHANGEABLE. The routine arm
 * keys on `lastRun.triggeredAt` because a routine-born carrier is born WITH its order. A
 * hand-filed order can be EDITED INTO an old row — which is a live order on an old
 * ticket — and keying on `createdAt` would exclude it for the age of its ticket rather
 * than the age of its order. `updatedAt` is the inclusive key; `createdAt` is only the
 * fallback for a row that somehow carries no update stamp; and `firedSince` INCLUDES an
 * unreadable one, so a malformed timestamp still cannot delete a carrier from the sweep.
 */
export function issueRecencyStamp(row) {
  if (row == null || typeof row !== 'object') return null;
  if (typeof row.updatedAt === 'string' && row.updatedAt !== '') return row.updatedAt;
  if (typeof row.createdAt === 'string' && row.createdAt !== '') return row.createdAt;
  return null;
}

/**
 * ⛔ THE ISSUE-LIST ROUTE TRUNCATES `description`, AND THE CARRIER PREDICATE IS A SEARCH
 * OVER THE WHOLE BODY. A CUT BODY DOES NOT FAIL — IT CLASSIFIES `NOT_TRAIN`, SILENTLY.
 *
 * Measured 2026-10-02 against the live board, all 3000+ rows paged: `descriptionTruncated`
 * is an explicit boolean on every list row, and it is `true` on **2735 of 3000 (91.2%)**,
 * cut between 1200 and 1205 characters. So the widened arm CANNOT grade off the list rows
 * it enumerates: it must re-read each in-window candidate with a full
 * `GET /api/issues/{id}` and then PROVE the body it is about to grade was whole.
 *
 * Grading a truncated description is the SAME CLASS OF DEFECT as the population hole this
 * ticket closes — a silent absence that reads as a clean bill of health — so it is BLIND,
 * never `NOT_TRAIN`. (TRA-4942's own block sits at offset 359 and would have survived the
 * cut, which is precisely why this guard needs a CONTROL and not a demonstration: the one
 * carrier we can point at does not exercise it.)
 *
 * The full GET omits the flag entirely rather than returning `false`, so the test is
 * `=== true` and an ABSENT flag is readable. A `description` that is not a string is
 * unreadable, which is not the same as empty.
 */
export function readableDescription(issue) {
  if (issue == null || typeof issue !== 'object') {
    return { ok: false, reason: 'carrier row is not an object — and an absent body classifies NOT_TRAIN, i.e. silent' };
  }
  if (issue.descriptionTruncated === true) {
    const n = typeof issue.description === 'string' ? issue.description.length : 0;
    return {
      ok: false,
      reason:
        `description TRUNCATED at ${n} chars (\`descriptionTruncated: true\`) — a \`deploy-order\` block past the ` +
        'cut reads NOT_TRAIN, so this row is BLIND. Re-read it with a full GET /api/issues/{id}.',
    };
  }
  if (typeof issue.description !== 'string') {
    return {
      ok: false,
      reason: `description is ${issue.description === null ? 'null' : typeof issue.description} — unreadable, which is NOT "empty, therefore not a train"`,
    };
  }
  return { ok: true, description: issue.description };
}

/**
 * Grade one carrier from its ISSUE OBJECT rather than from a bare description string, so
 * the truncation guard above sits on the only path a live row can take. Both arms —
 * routine-born and hand-filed — go through this; the routine arm was reading full GETs
 * already, and routing it here costs nothing and closes the same hole if that ever changes.
 */
export function gradeCarrierRow({ issue, ...rest }) {
  const readable = readableDescription(issue);
  if (!readable.ok) {
    return { verdict: 'BLIND', finding: false, unmeetable: false, late: false, ungraded: false, timing: 'n/a', detail: readable.reason, span: null };
  }
  return gradeCarrier({ description: readable.description, ...rest });
}

/**
 * Fold the two arms into one population, keyed on the issue id.
 *
 * ⛔ A ROW REACHABLE BOTH WAYS IS GRADED ONCE, AND THE ROUTINE LABEL SURVIVES. A routine
 * fire is a stronger provenance than "it is on the board": it carries the `triggeredAt`
 * the recency filter was designed around, and the routine id a reader needs to go find
 * the schedule. Letting the issue arm overwrite it would turn every routine-born carrier
 * into an anonymous hand-filed one the moment the second arm shipped — a widening that
 * DESTROYS information is not a widening.
 *
 * Returns `{ carriers, counts }`. `counts.both` is the overlap and is PRINTED: if it ever
 * reaches zero while the routine arm is non-empty, the two arms are reading disjoint
 * boards and one of them is wrong.
 */
export function mergeCarriers(routineBorn, issueBorn) {
  const byId = new Map();
  for (const c of routineBorn || []) {
    if (!c || !c.issueId) continue;
    byId.set(c.issueId, { ...c, carrierClass: CLASS_ROUTINE });
  }
  const routineOnly = byId.size;
  let both = 0;
  for (const c of issueBorn || []) {
    if (!c || !c.issueId) continue;
    const prior = byId.get(c.issueId);
    if (prior) {
      both += 1;
      byId.set(c.issueId, { ...prior, bothArms: true });
      continue;
    }
    byId.set(c.issueId, { ...c, carrierClass: CLASS_HAND_FILED });
  }
  const carriers = [...byId.values()];
  return {
    carriers,
    counts: {
      routine: routineOnly,
      handFiled: carriers.filter((c) => c.carrierClass === CLASS_HAND_FILED).length,
      both,
      total: carriers.length,
    },
  };
}

/**
 * ⛔ THE GIT ORACLE IS MEMOISED FOR THE RUN. THIS IS A WALL-CLOCK FIX, NOT A SEMANTIC ONE,
 * AND WITHOUT IT THE WIDENED SWEEP DOES NOT FINISH.
 *
 * `gradeTiming` asks the ancestry oracle once per SERVED DEPLOY — the history cap is 600 —
 * for EVERY graded carrier, and every ask spawns `git`. At the ~200ms a spawn costs on
 * Windows that is 2-4 MINUTES PER GRADED CARRIER. It was survivable only because the
 * routine-born population yielded about one graded carrier; the widened population
 * (TRA-4984) runs the same loop over the hand-filed carriers too, and the first live run
 * of this change ran >15 minutes without printing a verdict. A detector nobody can afford
 * to run is a detector that does not run.
 *
 * Memoising is SOUND, not a shortcut: git ancestry between two FIXED objects cannot change
 * inside one process. Nothing in this file fetches, and `git fetch --unshallow` — the
 * remedy the BLIND text prints — happens BETWEEN runs, so a cached `null` can never
 * outlive the checkout state that produced it.
 *
 * ⚠ IT IS A CACHE OVER `libGradedAncestry` AND MUST NEVER BECOME A SECOND ORACLE. The
 * whole TRA-3740 fix was that a bare `merge-base --is-ancestor .ok` collapses "path was
 * grafted away" into "not an ancestor"; a hand-rolled fast path here would re-open that
 * by the back door. The control below pins both halves: the answer is the library's,
 * byte-for-byte, and the library is asked ONCE per pair.
 */
export function memoizeOracle(oracle) {
  const cache = new Map();
  return (a, b) => {
    const k = `${a}\u0000${b}`;
    if (cache.has(k)) return cache.get(k);
    const v = oracle(a, b);
    cache.set(k, v);
    return v;
  };
}

/** Same reasoning for `knownSha`, which `gradeTiming` also asks per served deploy. */
export function memoizePredicate(fn) {
  const cache = new Map();
  return (s) => {
    if (cache.has(s)) return cache.get(s);
    const v = fn(s);
    cache.set(s, v);
    return v;
  };
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

// TRA-4942: the graders take an ancestry ORACLE, not an `isAncestor` boolean, because the
// library answer is three-state. This stub reproduces exactly that: a definite answer only
// when BOTH objects are fixtures, `null` (blind) otherwise — which is what makes the
// "a pre-deadline deploy whose commit is UNKNOWN to the checkout" control a real negative
// rather than an artefact of the fixture SHAs being absent from the real repo.
const stubOracle = (a, b) =>
  stubKnown(a) && stubKnown(b) ? { answer: stubAncestor(a, b) } : { answer: null };

const orderBlock = (commit, deadline) =>
  ['```deploy-order', `commit: ${commit}`, 'host: tradingai-bqb1', `deadline: ${deadline}`, '```'].join('\n');

const CONTROLS = [
  {
    name: 'POSITIVE — a passed deadline with the commit ABSENT from live grades STRANDED',
    run: () =>
      expect(
        gradeCarrier({
          description: `Deploy to bqb1 before the open.\n\n${orderBlock(NOT_IN_LIVE, '2026-08-13T11:00:00Z')}`,
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
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
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
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
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
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
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
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
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
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
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
        }),
        (r) => r.verdict === 'PENDING' && r.finding === false,
      ),
  },
  // ── TRA-5052: the deadline-window gates ───────────────────────────────────
  // The freeze controls run through the DEFAULT wiring — the REAL `freezeState` and
  // tables imported from render-redeploy.mjs. That is the mutation detector the ticket
  // demands: drop the freeze check anywhere in the chain (the lib predicate, the
  // wiring, or gradeCarrier's use of it) and the POSITIVE below reads PENDING/STRANDED
  // instead of UNMEETABLE_WINDOW, i.e. red. The fixture dates are in the past, and
  // EMBARGOES/CADENCE_CEILINGS rows are only ever written for future windows, so the
  // real tables cannot drift under these fixtures.
  {
    name: 'UNMEETABLE POSITIVE — a WEEKDAY deadline at 13:25:00Z (the FIRST frozen instant) is UNMEETABLE_WINDOW both before and after it passes: it neither idles as PENDING nor pages as STRANDED',
    run: () =>
      expect(
        [
          gradeCarrier({ description: orderBlock(NOT_IN_LIVE, '2026-10-02T13:25:00Z'), nowMs: Date.parse('2026-10-02T10:00:00Z'), liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle }),
          gradeCarrier({ description: orderBlock(NOT_IN_LIVE, '2026-10-02T13:25:00Z'), nowMs: Date.parse('2026-10-02T14:00:00Z'), liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle }),
        ],
        (r) =>
          r[0].verdict === 'UNMEETABLE_WINDOW' && r[0].finding === false && r[0].unmeetable === true &&
          r[1].verdict === 'UNMEETABLE_WINDOW' && r[1].finding === false && r[1].unmeetable === true,
      ),
  },
  {
    name: 'UNMEETABLE NEGATIVE — the SAME 13:25:00Z instant on a SATURDAY is OPEN and grades normally: PENDING ahead, STRANDED past (a blanket "reject 13:25Z" is wrong, and so is a day-blind one)',
    run: () =>
      expect(
        [
          gradeCarrier({ description: orderBlock(NOT_IN_LIVE, '2026-10-03T13:25:00Z'), nowMs: Date.parse('2026-10-03T10:00:00Z'), liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle }),
          gradeCarrier({ description: orderBlock(NOT_IN_LIVE, '2026-10-03T13:25:00Z'), nowMs: Date.parse('2026-10-03T14:00:00Z'), liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle }),
        ],
        (r) => r[0].verdict === 'PENDING' && r[1].verdict === 'STRANDED' && r[1].finding === true,
      ),
  },
  {
    name: 'UNMEETABLE BOUNDARY — 13:24:00Z on a weekday is the LAST OPEN MINUTE and grades normally: the freeze is closed-AT 13:25Z (TRA-2313 is that annotation read backwards)',
    run: () =>
      expect(
        gradeCarrier({ description: orderBlock(NOT_IN_LIVE, '2026-10-02T13:24:00Z'), nowMs: Date.parse('2026-10-02T14:00:00Z'), liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle }),
        (r) => r.verdict === 'STRANDED' && r.unmeetable !== true,
      ),
  },
  {
    name: 'UNMEETABLE does NOT reopen a SATISFIED order — the bytes are on the box, so a frozen deadline is a printed windowNote, never a page (all four live 13:25Z orders were satisfied early, by habit)',
    run: () =>
      expect(
        gradeCarrier({ description: orderBlock(IN_LIVE, '2026-10-02T13:25:00Z'), nowMs: Date.parse('2026-10-02T14:00:00Z'), liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle }),
        (r) => r.verdict === 'SATISFIED' && r.unmeetable !== true && typeof r.windowNote === 'string' && r.windowNote.includes('RTH freeze'),
      ),
  },
  {
    name: 'UNMEETABLE — a deadline inside a dated EMBARGOES row is refused the same way (the exit-5 gate), graded off a planted table through the real embargoState',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(NOT_IN_LIVE, '2026-10-06T21:00:00Z'),
          nowMs: Date.parse('2026-10-06T22:30:00Z'), liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
          deadlineGates: (ms) => gradeDeadlineGates(ms, {
            freezeState, embargoState, activeCadenceCeiling,
            embargoes: [{ from: '2026-10-06T20:30:00Z', to: '2026-10-06T22:00:00Z', ticket: 'TRA-5052 control fixture' }],
            cadenceCeilings: [],
          }),
        }),
        (r) => r.verdict === 'UNMEETABLE_WINDOW' && r.finding === false && r.detail.includes('embargo'),
      ),
  },
  {
    name: 'UNMEETABLE FAILS CLOSED — a deadline covered by an active CADENCE_CEILINGS row is BLIND (the quota is deploy history this run cannot read), never "meetable" and never STRANDED',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(NOT_IN_LIVE, '2026-10-06T21:00:00Z'),
          nowMs: Date.parse('2026-10-06T22:30:00Z'), liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
          deadlineGates: (ms) => gradeDeadlineGates(ms, {
            freezeState, embargoState, activeCadenceCeiling,
            embargoes: [],
            cadenceCeilings: [{ from: '2026-10-05T20:00:00Z', to: '2026-10-09T20:00:00Z', ticket: 'TRA-5052 control fixture', max: 1 }],
          }),
        }),
        (r) => r.verdict === 'BLIND' && r.finding === false && r.detail.includes('CADENCE_CEILINGS'),
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
  // ── the timing arm ────────────────────────────────────────────────────────
  // The arm that answers the question the ticket is actually about. Its POSITIVE
  // direction must be able to reach LATE, and its three fail-closed directions must
  // each be able to refuse it, or "0 late" is a statement about the instrument.
  {
    name: 'TIMING POSITIVE — the only carrying deploy served AFTER the deadline grades LATE (exit 5, not stranded)',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(IN_LIVE, '2026-08-13T11:00:00Z'),
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
          deploys: [
            { commit: LIVE, status: 'live', finishedAt: '2026-08-13T11:45:00Z' },
            { commit: NOT_IN_LIVE, status: 'deactivated', finishedAt: '2026-08-13T09:00:00Z' },
          ],
        }),
        (r) => r.verdict === 'SATISFIED' && r.timing === 'late' && r.late === true && r.finding === false,
      ),
  },
  {
    name: 'TIMING NEGATIVE — a carrying deploy that served BEFORE the deadline is ON TIME and silent',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(IN_LIVE, '2026-08-13T11:00:00Z'),
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
          deploys: [
            { commit: LIVE, status: 'live', finishedAt: '2026-08-13T10:30:00Z' },
            { commit: NOT_IN_LIVE, status: 'deactivated', finishedAt: '2026-08-13T09:00:00Z' },
          ],
        }),
        (r) => r.verdict === 'SATISFIED' && r.timing === 'on_time' && r.late === false,
      ),
  },
  {
    name: 'TIMING FAILS CLOSED — history that starts AFTER the deadline is UNREAD, never LATE',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(IN_LIVE, '2026-08-13T11:00:00Z'),
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
          deploys: [{ commit: LIVE, status: 'live', finishedAt: '2026-08-13T11:45:00Z' }],
        }),
        (r) => r.timing === 'unread' && r.late === false,
      ),
  },
  {
    name: 'TIMING FAILS CLOSED — a pre-deadline deploy whose commit is UNKNOWN to the checkout is UNREAD, never LATE',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(IN_LIVE, '2026-08-13T11:00:00Z'),
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
          deploys: [
            { commit: LIVE, status: 'live', finishedAt: '2026-08-13T11:45:00Z' },
            { commit: 'facefeed'.repeat(5), status: 'deactivated', finishedAt: '2026-08-13T10:00:00Z' },
          ],
        }),
        (r) => r.timing === 'unread' && r.late === false,
      ),
  },
  {
    name: 'TIMING — a BUILD_FAILED deploy of the commit before the deadline is NOT "it was live by then"',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(IN_LIVE, '2026-08-13T11:00:00Z'),
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
          deploys: [
            { commit: LIVE, status: 'build_failed', finishedAt: '2026-08-13T10:00:00Z' },
            { commit: NOT_IN_LIVE, status: 'deactivated', finishedAt: '2026-08-13T09:30:00Z' },
            { commit: LIVE, status: 'live', finishedAt: '2026-08-13T11:45:00Z' },
          ],
        }),
        (r) => r.timing === 'late',
      ),
  },
  {
    name: 'TIMING — an order for a DIFFERENT host is UNREAD against this history, not graded off it',
    run: () =>
      expect(
        gradeCarrier({
          description: ['```deploy-order', `commit: ${IN_LIVE}`, 'host: some-other-service', 'deadline: 2026-08-13T11:00:00Z', '```'].join('\n'),
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
          historyHost: 'tradingai-bqb1',
          deploys: [{ commit: LIVE, status: 'live', finishedAt: '2026-08-13T11:45:00Z' }],
        }),
        (r) => r.timing === 'unread' && r.late === false,
      ),
  },
  {
    name: 'TIMING — with NO history injected a passed deadline is still UNREAD (the arm is off, not OK)',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(IN_LIVE, '2026-08-13T11:00:00Z'),
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
        }),
        (r) => r.timing === 'unread' && r.late === false,
      ),
  },
  {
    name: 'POPULATION — a carrier with no deploy mention at all is NOT_TRAIN and silent',
    run: () =>
      expect(
        gradeCarrier({
          description: 'Re-check the journal cross-tab and post the numbers.',
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
        }),
        (r) => r.verdict === 'NOT_TRAIN' && r.finding === false,
      ),
  },

  // ── the widened population: HAND-FILED carriers (TRA-4984) ────────────────
  // Both directions, because the whole failure being fixed is that an entire class of
  // carrier was SILENT. A widening proved only in the positive direction would be half
  // proved: it would say the arm can SEE a hand-filed strand and nothing about whether it
  // stays QUIET on a hand-filed order that was obeyed — and over other people's artefacts
  // the expensive direction is the false accusation.
  {
    name: 'POPULATION WIDENED POSITIVE — a HAND-FILED carrier (no routine) with a passed deadline and an ABSENT commit grades STRANDED',
    run: () =>
      expect(
        gradeCarrierRow({
          issue: {
            identifier: 'TRA-HAND-1',
            description: `Deploy to bqb1 before the open.\n\n${orderBlock(NOT_IN_LIVE, '2026-08-13T11:00:00Z')}`,
            descriptionTruncated: false,
          },
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
        }),
        (r) => r.verdict === 'STRANDED' && r.finding === true,
      ),
  },
  {
    name: 'POPULATION WIDENED NEGATIVE — the same HAND-FILED carrier whose commit IS live is SATISFIED and silent',
    run: () =>
      expect(
        gradeCarrierRow({
          issue: {
            identifier: 'TRA-HAND-2',
            description: `Deploy to bqb1 before the open.\n\n${orderBlock(IN_LIVE, '2026-08-13T11:00:00Z')}`,
            descriptionTruncated: false,
          },
          nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
        }),
        (r) => r.verdict === 'SATISFIED' && r.finding === false && r.late === false && r.ungraded === false,
      ),
  },
  {
    name: 'POPULATION FAILS CLOSED — a TRUNCATED description is BLIND, never NOT_TRAIN (the list route cuts 91% of rows at ~1200 chars)',
    run: () => {
      // The block is pushed past the cut, exactly as the list route delivers it: the
      // visible prefix contains no deploy mention at all, so the UNGUARDED reading of
      // this row is `NOT_TRAIN` — silent, and indistinguishable from a clean board.
      const whole = `${'Background. '.repeat(120)}\n\n${orderBlock(NOT_IN_LIVE, '2026-08-13T11:00:00Z')}`;
      const cut = whole.slice(0, 1200);
      const unguarded = gradeCarrier({ description: cut, nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle });
      const guarded = gradeCarrierRow({
        issue: { identifier: 'TRA-HAND-3', description: cut, descriptionTruncated: true },
        nowMs: T0, liveSha: LIVE, knownSha: stubKnown, ancestryOracle: stubOracle,
      });
      return expect(
        { cutHidesTheBlock: !cut.includes('```deploy-order'), unguarded: unguarded.verdict, guarded: guarded.verdict, guardedFinding: guarded.finding },
        (r) => r.cutHidesTheBlock === true && r.unguarded === 'NOT_TRAIN' && r.guarded === 'BLIND' && r.guardedFinding === false,
      );
    },
  },
  {
    name: 'POPULATION FAILS CLOSED — an ABSENT truncation flag (the full GET omits it) is READABLE, not BLIND',
    run: () =>
      expect(
        [
          readableDescription({ description: 'no deploys here' }),
          readableDescription({ description: null, descriptionTruncated: false }),
          readableDescription(null),
        ],
        (r) => r[0].ok === true && r[1].ok === false && r[2].ok === false,
      ),
  },
  {
    name: 'POPULATION MERGE — a carrier reachable BOTH ways is graded ONCE and keeps its routine label',
    run: () =>
      expect(
        mergeCarriers(
          [{ routine: 'aaaaaaaa', issueId: 'i1', firedAt: '2026-08-13T06:30:00Z' }],
          [{ issueId: 'i1', firedAt: '2026-08-12T00:00:00Z' }, { issueId: 'i2', firedAt: '2026-08-13T09:00:00Z' }],
        ),
        (r) =>
          r.carriers.length === 2 &&
          r.counts.both === 1 &&
          r.counts.handFiled === 1 &&
          r.carriers.find((c) => c.issueId === 'i1').carrierClass === CLASS_ROUTINE &&
          r.carriers.find((c) => c.issueId === 'i1').routine === 'aaaaaaaa' &&
          r.carriers.find((c) => c.issueId === 'i1').firedAt === '2026-08-13T06:30:00Z' &&
          r.carriers.find((c) => c.issueId === 'i2').carrierClass === CLASS_HAND_FILED,
      ),
  },
  {
    name: 'POPULATION MERGE — the issue arm can CONTRIBUTE a carrier the routine arm cannot reach at all (the TRA-4942 shape)',
    run: () =>
      expect(mergeCarriers([], [{ issueId: 'hand', firedAt: '2026-08-13T09:00:00Z' }]), (r) => r.counts.total === 1 && r.counts.handFiled === 1 && r.counts.both === 0),
  },
  {
    name: 'MEMO — the memoised oracle returns the UNDERLYING answer unchanged (incl. a blind `null`) and asks it ONCE per pair',
    run: () => {
      let calls = 0;
      const counted = (a, b) => {
        calls += 1;
        return stubOracle(a, b);
      };
      const memo = memoizeOracle(counted);
      const pairs = [[IN_LIVE, LIVE], [NOT_IN_LIVE, LIVE], ['unknown-sha', LIVE]];
      const first = pairs.map(([a, b]) => memo(a, b));
      const second = pairs.map(([a, b]) => memo(a, b));
      const third = pairs.map(([a, b]) => stubOracle(a, b));
      let predCalls = 0;
      const memoPred = memoizePredicate((s) => {
        predCalls += 1;
        return stubKnown(s);
      });
      const preds = [memoPred(LIVE), memoPred(LIVE), memoPred('nope'), memoPred('nope')];
      return expect(
        { calls, answers: first.map((r) => r.answer), stable: JSON.stringify(first) === JSON.stringify(second), matchesRaw: JSON.stringify(first) === JSON.stringify(third), predCalls, preds },
        (r) =>
          r.calls === 3 &&
          r.answers[0] === true &&
          r.answers[1] === false &&
          r.answers[2] === null &&
          r.stable === true &&
          r.matchesRaw === true &&
          r.predCalls === 2 &&
          JSON.stringify(r.preds) === JSON.stringify([true, true, false, false]),
      );
    },
  },
  {
    name: 'POPULATION RECENCY — the issue arm keys on `updatedAt`, falls back to `createdAt`, and an unreadable stamp is INCLUDED',
    run: () =>
      expect(
        [
          issueRecencyStamp({ updatedAt: '2026-08-13T06:30:00Z', createdAt: '2026-07-01T00:00:00Z' }),
          issueRecencyStamp({ createdAt: '2026-07-01T00:00:00Z' }),
          issueRecencyStamp({}),
          firedSince(issueRecencyStamp({}), T0),
          // An order EDITED INTO an old ticket: created long before the window, updated
          // inside it. `createdAt` keying would drop it; `updatedAt` keeps it.
          firedSince(issueRecencyStamp({ createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-08-13T06:30:00Z' }), T0 - 864e5),
        ],
        (r) => r[0] === '2026-08-13T06:30:00Z' && r[1] === '2026-07-01T00:00:00Z' && r[2] === null && r[3] === true && r[4] === true,
      ),
  },

  // ── TRA-4977 AC3: the BLIND row REPORTS its cause, it does not assert one ──────────────
  {
    name: 'BLIND ATTRIBUTION — a MISSING-OBJECT blind says so and does NOT name a shallow clone',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(NOT_IN_LIVE, '2026-08-13T11:00:00Z'),
          nowMs: T0,
          liveSha: LIVE,
          knownSha: stubKnown,
          ancestryOracle: () => ({ answer: null, verdict: 'blind-missing-object' }),
        }),
        // The negative half is the one that matters: the old string named a shallow clone on
        // EVERY blind, in a checkout where `--is-shallow-repository` is false, and the first
        // triage went looking at clone depth.
        (r) =>
          r.verdict === 'BLIND' &&
          r.detail.includes('blind-missing-object') &&
          r.detail.includes('not in this checkout') &&
          !/shallow/i.test(r.detail),
      ),
  },
  {
    name: 'BLIND ATTRIBUTION — a SHALLOW blind names the shallow clone and the --unshallow remedy',
    run: () =>
      expect(
        gradeCarrier({
          description: orderBlock(NOT_IN_LIVE, '2026-08-13T11:00:00Z'),
          nowMs: T0,
          liveSha: LIVE,
          knownSha: stubKnown,
          ancestryOracle: () => ({ answer: null, verdict: 'blind-shallow' }),
        }),
        (r) => r.verdict === 'BLIND' && /SHALLOW/.test(r.detail) && r.detail.includes('--unshallow'),
      ),
  },
  {
    name: 'BLIND ATTRIBUTION FAILS HONEST — an oracle with NO verdict reads `NOT MEASURED`, it does not borrow a cause',
    run: () =>
      expect(
        [
          gradeCarrier({
            description: orderBlock(NOT_IN_LIVE, '2026-08-13T11:00:00Z'),
            nowMs: T0,
            liveSha: LIVE,
            knownSha: stubKnown,
            ancestryOracle: () => ({ answer: null }),
          }),
          ancestryBlindDetail(''),
        ],
        (r) =>
          r[0].verdict === 'BLIND' &&
          r[0].detail.includes('NOT MEASURED') &&
          !/shallow/i.test(r[0].detail) &&
          r[1].includes('NOT MEASURED'),
      ),
  },
  {
    name: 'BLIND ATTRIBUTION — `gradeAncestry` PASSES THE VERDICT THROUGH on all three states, not just the blind one',
    run: () =>
      expect(
        [
          gradeAncestry({ commit: IN_LIVE, liveSha: LIVE, ancestryOracle: () => ({ answer: true, verdict: 'carries' }) }),
          gradeAncestry({ commit: NOT_IN_LIVE, liveSha: LIVE, ancestryOracle: () => ({ answer: false, verdict: 'not-carried' }) }),
          gradeAncestry({ commit: NOT_IN_LIVE, liveSha: LIVE, ancestryOracle: () => ({ answer: null, verdict: 'blind-unrelated' }) }),
          gradeAncestry({ commit: NOT_IN_LIVE, liveSha: LIVE, ancestryOracle: () => ({ answer: null }) }),
        ],
        (r) =>
          r[0].state === 'present' && r[0].verdict === 'carries' &&
          r[1].state === 'absent' && r[1].verdict === 'not-carried' &&
          r[2].state === 'blind' && r[2].verdict === 'blind-unrelated' &&
          // An absent verdict is NULL, never a string that could be printed as a cause.
          r[3].state === 'blind' && r[3].verdict === null,
      ),
  },

  // ── TRA-4977 AC4: a rotted harness and an ungradeable deploy are different messages ────
  {
    name: 'HARNESS vs BLIND — a failing control exits 6 and OUTRANKS every live verdict, including STRANDED',
    run: () =>
      expect(
        [
          finalExit({ controlsFailed: 1, liveExit: EXIT_CLEAN }),
          finalExit({ controlsFailed: 1, liveExit: EXIT_FINDINGS }),
          finalExit({ controlsFailed: 11, liveExit: EXIT_BLIND }),
          // …and with the harness intact it is TRANSPARENT: every live code passes through
          // unchanged, so the new leg cannot mask a real grade.
          finalExit({ controlsFailed: 0, liveExit: EXIT_CLEAN }),
          finalExit({ controlsFailed: 0, liveExit: EXIT_FINDINGS }),
          finalExit({ controlsFailed: 0, liveExit: EXIT_BLIND }),
          finalExit({ controlsFailed: 0, liveExit: EXIT_LATE }),
          finalExit({ controlsFailed: 0, liveExit: EXIT_UNGRADED }),
          finalExit({ controlsFailed: 0, liveExit: EXIT_ERROR }),
          finalExit({ controlsFailed: 0, liveExit: EXIT_UNMEETABLE }),
          finalExit({ controlsFailed: 1, liveExit: EXIT_UNMEETABLE }),
        ],
        (r) =>
          r[0] === EXIT_HARNESS && r[1] === EXIT_HARNESS && r[2] === EXIT_HARNESS &&
          r[3] === EXIT_CLEAN && r[4] === EXIT_FINDINGS && r[5] === EXIT_BLIND &&
          r[6] === EXIT_LATE && r[7] === EXIT_UNGRADED && r[8] === EXIT_ERROR &&
          r[9] === EXIT_UNMEETABLE && r[10] === EXIT_HARNESS,
      ),
  },
  {
    name: 'HARNESS vs BLIND — the codes are DISTINCT and none shares another\'s (sharing one was the AC4 defect; UNMEETABLE joining STRANDED or CLEAN would be TRA-5052\'s)',
    run: () =>
      expect(
        [EXIT_CLEAN, EXIT_FINDINGS, EXIT_ERROR, EXIT_BLIND, EXIT_UNGRADED, EXIT_LATE, EXIT_HARNESS, EXIT_UNMEETABLE],
        (r) => new Set(r).size === r.length && EXIT_HARNESS !== EXIT_BLIND && EXIT_HARNESS !== EXIT_CLEAN && EXIT_UNMEETABLE !== EXIT_FINDINGS && EXIT_UNMEETABLE !== EXIT_CLEAN,
      ),
  },
];

function expect(actual, pred) {
  return pred(actual) ? { ok: true, actual } : { ok: false, actual };
}

/**
 * ⭐ THE NEGATIVE CONTROL FOR AC4 ITSELF, AND IT CANNOT BE A PURE ONE.
 *
 * `finalExit` is unit-graded above, but the defect AC4 names was never in the precedence —
 * it was in the WIRING: a `return EXIT_BLIND` that fired before the live sweep was reached.
 * A pure control over the precedence function cannot see that, and would have passed
 * throughout the six weeks the alarm was dark. So the only honest control plants a REAL
 * failing control and observes the whole process:
 *
 *   node scripts/check-deploy-train-window.mjs --selftest --plant-control-failure   # exit 6
 *   node scripts/check-deploy-train-window.mjs --plant-control-failure              # exit 6,
 *       # AND the live carrier rows are printed underneath, which is the half that regressed.
 *
 * It is a FLAG, deliberately not an environment variable: a flag cannot leak in from a
 * parent process or a CI secret store and silently sabotage a real sweep, and the planted
 * row prints under its own screaming name so no reader can mistake the run for a clean one.
 */
const PLANTED_FAILURE = {
  name: '⚠ PLANTED FAILURE (--plant-control-failure) — this run is a NEGATIVE CONTROL, not a grade',
  run: () => expect('planted', () => false),
};

export function runControls() {
  const rows = flag('plant-control-failure') ? [...CONTROLS, PLANTED_FAILURE] : CONTROLS;
  return rows.map((c) => {
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
/** The timing column, rendered so `on time` and `unread` can never be read as the same thing. */
const timingTag = (r) => {
  if (r.timing === 'late') return '  [LATE — window MISSED]';
  if (r.timing === 'on_time') return '  [ON TIME]';
  if (r.timing === 'unread') return '  [timing UNREAD]';
  return '';
};

// ⛔ BOTH ARE MEMOISED PER PROCESS, and the memo is a CACHE over the real thing — see
// `memoizeOracle`. `gradeTiming` asks each of these once per served deploy (cap 600) for
// every graded carrier; un-memoised, the widened sweep spends minutes per carrier inside
// `git` spawns and never reaches a verdict. Ancestry between two fixed objects cannot
// change inside one process, and `--unshallow` is a BETWEEN-runs remedy.
const knownShaCache = new Map();
const knownSha = (s) => {
  if (knownShaCache.has(s)) return knownShaCache.get(s);
  const v = git(['cat-file', '-e', `${s}^{commit}`]).ok;
  knownShaCache.set(s, v);
  return v;
};
const liveOracle = memoizeOracle(libGradedAncestry);

/**
 * Seed `knownShaCache` for MANY commits in ONE git spawn.
 *
 * `gradeTiming` asks `knownSha` once per pre-deadline served deploy — up to 600 — and a
 * spawn is the whole cost, so one-at-a-time is ~500 process creations for a question
 * `cat-file --batch-check` answers in a single pipe.
 *
 * ⛔ IT IS A PREWARM, NOT A REPLACEMENT, AND A FAILURE HERE CHANGES NO VERDICT. Anything
 * the batch cannot answer is simply left out of the cache and falls through to the
 * per-commit `cat-file -e` above, which is the path all the controls pin. A batch that
 * errors out, times out, or returns a short/garbled stream therefore costs latency and
 * nothing else — the one thing an optimisation on a fail-closed instrument must not do is
 * become a second source of truth.
 */
function prewarmKnownSha(shas) {
  const want = [...new Set(shas.filter((s) => typeof s === 'string' && /^[0-9a-f]{7,40}$/i.test(s)))].filter((s) => !knownShaCache.has(s));
  if (want.length === 0) return { asked: 0, seeded: 0 };
  const r = spawnSync('git', ['cat-file', '--batch-check'], {
    input: want.map((s) => `${s}^{commit}`).join('\n') + '\n',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return { asked: want.length, seeded: 0 };
  const out = r.stdout.split('\n');
  let seeded = 0;
  for (let i = 0; i < want.length && i < out.length; i += 1) {
    const fields = out[i].trim().split(/\s+/);
    // `<sha> commit <size>` on a hit; `<name> missing` / `… ambiguous` otherwise. Anything
    // that is not an unambiguous `commit` is left UNSEEDED rather than cached as false, so
    // the authoritative per-commit probe still gets to answer it.
    if (fields[1] === 'commit') {
      knownShaCache.set(want[i], true);
      seeded += 1;
    } else if (fields[1] === 'missing') {
      knownShaCache.set(want[i], false);
      seeded += 1;
    }
  }
  return { asked: want.length, seeded };
}
// ⛔ There is deliberately NO `isAncestor` here. A bare `merge-base --is-ancestor .ok` is the
// graft hole TRA-3740 closed, and leaving one defined invites a call site to pass it as the
// oracle. The production graders take the default `ancestryOracle` — the shallow-aware
// library — and the only thing that ever overrides it is the control stub (TRA-4942).

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

/** Counts rows that needed a retry, so transport flakiness is PRINTED, not smoothed away. */
const retryTally = { retried: 0, attempts: 0 };

/**
 * ⛔ A TRANSIENT READ FAILURE MUST NOT SPEND THE WHOLE RUN'S VERDICT.
 *
 * The widened population (TRA-4984) turned one issue read into ~215 of them, and at that
 * volume a bare `fetch failed` — a dropped keep-alive, not a refusal — showed up on 4 of
 * 215 rows on the first live run. Fail-closed is right, so each of those became a BLIND
 * row and `BLIND` outranks everything: ONE flaky socket discarded a sweep in which five
 * real orders had just been graded.
 *
 * That is precisely how this detector got into the state the ticket describes. It exited 3
 * for six weeks, BLIND came to read as "known-bad instrument", and nobody looked past it to
 * notice the population was wrong. An instrument that cries BLIND on ordinary transport
 * noise trains its readers to ignore it, and then its real refusals are worth nothing.
 *
 * So the read is RETRIED a bounded number of times and the retries are COUNTED AND
 * PRINTED. A row that fails every attempt is still BLIND — the guarantee is unchanged;
 * what changes is that BLIND now means "this row could not be read", not "a packet was
 * dropped once".
 */
async function getJsonRetrying(url, headers, { attempts = 3, baseDelayMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const v = await getJson(url, headers);
      if (i > 0) retryTally.retried += 1;
      return v;
    } catch (err) {
      lastErr = err;
      retryTally.attempts += 1;
      // A 4xx is a REFUSAL and will refuse identically next time; only retry transport
      // faults and 5xx. Retrying an auth failure would just triple the latency of a
      // verdict that is already decided.
      if (/^HTTP 4\d\d /.test(String(err?.message))) break;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr;
}

const RENDER_API = 'https://api.render.com/v1';
const RENDER_PAGE = 100;
const RENDER_MAX_PAGES = 6; // 600 deploys — a printed cap, and a short history is UNREAD anyway.

/**
 * Read Render's deploy history for the service, and PROVE it is the history of the box
 * whose live SHA we just graded against.
 *
 * ⛔ THE BINDING IS NOT A NAME MATCH. A deploy-order block names the ONRENDER HOSTNAME
 * (`tradingai-bqb1`); the Render service's own `name` is `TradingAI-`, and
 * `GET /v1/services?name=tradingai-bqb1` returns []. So a service resolved by string
 * would silently be nobody's, and a service id taken on faith from an env var could be
 * some other box entirely — whose history would then produce a confident, wrong LATE
 * against another team's deploy. The identity test used instead is: the newest deploy
 * with status `live` in this history must carry EXACTLY the SHA the health route just
 * served. If it does not, the arm stays OFF and every timing reads UNREAD.
 */
async function bindDeployHistory({ key, serviceId, liveSha }) {
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  const rows = [];
  let cursor = null;
  let pages = 0;
  while (pages < RENDER_MAX_PAGES) {
    const url = `${RENDER_API}/services/${serviceId}/deploys?limit=${RENDER_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await getJson(url, headers);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const item of page) {
      const d = item?.deploy;
      if (!d) continue;
      rows.push({ commit: d?.commit?.id, status: d?.status, finishedAt: d?.finishedAt ?? null });
    }
    pages += 1;
    cursor = page[page.length - 1]?.cursor ?? null;
    if (!cursor || page.length < RENDER_PAGE) break;
  }
  if (rows.length === 0) return { ok: false, reason: 'the deploys route returned no rows' };

  const newestLive = rows.find((r) => r.status === 'live');
  if (!newestLive) {
    return { ok: false, reason: `no deploy with status \`live\` in the newest ${rows.length} rows — cannot bind this history to the box` };
  }
  if (newestLive.commit !== liveSha) {
    return {
      ok: false,
      reason: `service ${serviceId}'s newest live deploy is ${short(newestLive.commit)} but the health route served ${short(liveSha)} — this history is not this box's, so no timing is asserted`,
    };
  }
  const oldest = rows
    .map((r) => Date.parse(r.finishedAt))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)[0];
  return {
    ok: true,
    rows,
    pages,
    cappedAt: pages >= RENDER_MAX_PAGES,
    oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString() : 'unknown',
  };
}

/**
 * The whole live leg, returning the exit code it would have been in isolation. Split out of
 * `main` by TRA-4977 AC4 so that a FAILING CONTROL no longer `return`s ahead of it: the
 * harness verdict and the carrier verdict are now computed independently and combined by
 * `finalExit`, instead of the first one suppressing the second.
 */
async function liveSweep() {
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

  // ── the timing arm ─────────────────────────────────────────────────────────
  // Off is a NAMED state with its reason printed, never silence: this arm is the only
  // thing that separates "the train ran" from "the commit turned up eventually", and a
  // reader who cannot see that it was off will read UNREAD as OK.
  let deploys = null;
  const renderKey = typeof flag('render-key') === 'string' ? flag('render-key') : process.env.RENDER_API_KEY;
  const renderService = typeof flag('render-service') === 'string' ? flag('render-service') : process.env.RENDER_SERVICE_ID;
  if (!renderKey || !renderService) {
    console.log('[train] timing arm OFF — no RENDER_API_KEY / RENDER_SERVICE_ID (or --render-key / --render-service).');
    console.log('[train]   Every SATISFIED past its deadline will read `timing UNREAD`, which is NOT "on time".');
  } else {
    try {
      const bound = await bindDeployHistory({ key: renderKey, serviceId: renderService, liveSha });
      if (!bound.ok) {
        console.log(`[train] timing arm OFF — ${bound.reason}`);
      } else {
        deploys = bound.rows;
        const warm = prewarmKnownSha(bound.rows.map((d) => d.commit));
        console.log(
          `[train] timing arm ON — ${bound.rows.length} deploy records over ${bound.pages} page(s), back to ${bound.oldest};` +
            ` history bound to live ${short(liveSha)} by its newest \`live\` deploy.`,
        );
        console.log(`[train]   object-existence prewarm: ${warm.seeded}/${warm.asked} distinct deploy commits resolved in ONE \`cat-file --batch-check\`.`);
        if (bound.cappedAt) {
          console.log(`[train]   ⛔ page cap ${RENDER_MAX_PAGES} hit — history may be truncated. An order whose deadline`);
          console.log('[train]   predates the oldest record above is reported UNREAD, never on-time and never LATE.');
        }
      }
    } catch (err) {
      console.log(`[train] timing arm OFF — Render history unreadable: ${err.message}`);
    }
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
    const g = gradeCarrierRow({ issue, nowMs: Date.now(), liveSha, knownSha, ancestryOracle: liveOracle, deploys, historyHost: ORDER_HOST });
    console.log(`[train] single issue ${issue?.identifier || ident} — ${issue?.title || ''}`);
    console.log(`[train]   VERDICT = ${g.verdict}${timingTag(g)}`);
    console.log(`[train]   ${g.detail}`);
    if (g.timingDetail) console.log(`[train]   timing: ${g.timingDetail}`);
    if (g.windowNote) console.log(`[train]   window: ${g.windowNote}`);
    if (g.span) console.log(`[train]   span: ${g.span}`);
    if (g.verdict === 'BLIND') return EXIT_BLIND;
    if (g.finding) return EXIT_FINDINGS;
    if (g.unmeetable) return EXIT_UNMEETABLE;
    if (g.late) return EXIT_LATE;
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

  // Kept separate from `nowMs`: that one is the instant every DEADLINE is graded against
  // and must not drift, this one is only the stopwatch for the printed cost.
  const populationStartedMs = Date.now();

  // ── ARM 1: routine-born carriers ───────────────────────────────────────────
  const routineCarriers = [];
  for (const r of routines) {
    const id = r?.lastRun?.linkedIssueId;
    if (id) {
      routineCarriers.push({ routine: String(r.id).slice(0, 8), issueId: id, firedAt: r?.lastRun?.triggeredAt ?? null });
    }
  }
  if (routineCarriers.length === 0) {
    console.log('[train] VERDICT = BLIND — 0 routine-born carriers across ' + routines.length + ' routines.');
    console.log('[train] A population arm that cannot be non-empty cannot license a clean verdict.');
    return EXIT_BLIND;
  }

  // ── ARM 2: HAND-FILED carriers — the whole board (TRA-4984) ────────────────
  // ⛔ THIS ARM FAILS CLOSED, AND "0 CARRIERS FOUND" IS THE READING IT MUST REFUSE. An
  // issue-list read that silently returns an empty or truncated set is THE SAME DEFECT
  // this arm exists to fix: a population that cannot contain the carrier, reported as a
  // clean board. `enumerateIssues` returns a `blind` REASON STRING rather than a boolean
  // for exactly that — the route caps at 1000 rows and an IGNORED `offset` returns a full
  // page too, so exhaustiveness is proved by the deduped union GROWING, never by page 2
  // being non-empty.
  const getIssuesPage = ({ limit, offset }) => getJsonRetrying(`${base}/api/companies/${company}/issues?limit=${limit}&offset=${offset}`, auth);
  let boardRows;
  let enumPages;
  try {
    const en = await enumerateIssues(getIssuesPage);
    if (en.blind) {
      console.log(`[train] VERDICT = BLIND — the issue-side population could not be enumerated: ${en.blind}`);
      console.log('[train] A population read that returns an empty set is not "no hand-filed carriers".');
      return EXIT_BLIND;
    }
    boardRows = en.issues;
    enumPages = en.pages;
  } catch (err) {
    console.log(`[train] VERDICT = BLIND — the issue-side population is unreadable: ${err.message}`);
    console.log('[train] An unreachable list route is not an empty finding list.');
    return EXIT_BLIND;
  }
  if (!Array.isArray(boardRows) || boardRows.length === 0) {
    console.log('[train] VERDICT = BLIND — the issue list enumerated to 0 rows. A board with no issues and');
    console.log('[train] an unread route are the same reading, and the empty one hides every hand-filed carrier.');
    return EXIT_BLIND;
  }

  const issueCarriers = boardRows
    .filter((r) => r && r.id)
    .map((r) => ({ issueId: r.id, identifier: r.identifier, firedAt: issueRecencyStamp(r), listTruncated: r.descriptionTruncated === true }));

  console.log(
    `[train] issue arm: ${boardRows.length} board rows enumerated over ${enumPages.length} page(s)` +
      ` (offset proved honoured: ${enumPages.map((p) => `+${p.added}`).join(' ')}).`,
  );

  const { carriers: allCarriers, counts } = mergeCarriers(routineCarriers, issueCarriers);
  console.log(
    `[train] population arms MERGED: ${counts.routine} routine-born, ${counts.handFiled} reachable ONLY via the` +
      ` issue list (hand-filed), ${counts.both} reachable BOTH ways and graded ONCE.`,
  );
  if (counts.both === 0) {
    console.log('[train]   ⛔ the two arms OVERLAP IN NOTHING — a routine-born carrier is by definition an issue');
    console.log('[train]   on this board, so a zero overlap means one arm is reading a different board. Suspect it.');
  }

  const carrierIds = allCarriers.filter((c) => firedSince(c.firedAt, sinceMs));
  const excluded = allCarriers.length - carrierIds.length;
  console.log(`[train] population: ${carrierIds.length} carriers stamped since ${sinceLabel}; ${excluded} older EXCLUDED.`);
  if (excluded > 0) {
    console.log('[train]   (not a silent cap — settled history predates the `deploy-order` rule and cannot');
    console.log('[train]    strand anything now. Re-run with --all to grade the backlog anyway.)');
  }
  if (carrierIds.length === 0) {
    console.log('[train] VERDICT = BLIND — the recency window contains no carriers at all, so a clean');
    console.log('[train] result would only prove the window is empty. Widen --since.');
    return EXIT_BLIND;
  }

  // ⛔ THE CAP IS PRINTED AND IT IS BLIND, NEVER A TRUNCATION. The widened arm costs one
  // full `GET /api/issues/{id}` per in-window carrier, because the list route's
  // description is cut at ~1200 chars on 91% of rows (see `readableDescription`) and the
  // carrier predicate searches the whole body. Silently grading the first N would
  // re-introduce, one layer down, the exact silent-absence defect being fixed here.
  const capRaw = flag('issue-cap');
  const cap = typeof capRaw === 'string' && capRaw !== '' ? Number(capRaw) : 1500;
  if (!Number.isFinite(cap) || cap <= 0) {
    console.error(`[train] ERROR — unusable --issue-cap=${capRaw}`);
    return EXIT_ERROR;
  }
  if (carrierIds.length > cap) {
    console.log(`[train] VERDICT = BLIND — ${carrierIds.length} in-window carriers exceeds the full-read cap of ${cap}.`);
    console.log('[train] Grading a prefix would be a silent partial population, which is the defect this arm closed.');
    console.log('[train] Narrow with --since=…, or raise --issue-cap deliberately.');
    return EXIT_BLIND;
  }

  const rows = [];
  const READ_CONCURRENCY = 6;
  const queue = [...carrierIds];
  const readOne = async (c) => {
    let issue;
    try {
      issue = await getJsonRetrying(`${base}/api/issues/${c.issueId}`, auth);
    } catch (err) {
      rows.push({ ...c, identifier: c.identifier || c.issueId, verdict: 'BLIND', finding: false, late: false, ungraded: false, detail: `carrier unreadable: ${err.message}` });
      return;
    }
    const g = gradeCarrierRow({ issue, nowMs, liveSha, knownSha, ancestryOracle: liveOracle, deploys, historyHost: ORDER_HOST });
    rows.push({ ...c, identifier: issue?.identifier || c.identifier || c.issueId, status: issue?.status, startedAt: issue?.startedAt ?? null, ...g });
  };
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        await readOne(c);
      }
    }),
  );
  // The reads are concurrent, so `rows` arrives in completion order. Sort it, or two runs
  // over an unchanged board print the same findings in a different order and cannot be
  // diffed against each other — which is how a reader checks whether anything MOVED.
  rows.sort((a, b) => String(b.firedAt ?? '').localeCompare(String(a.firedAt ?? '')) || String(a.identifier).localeCompare(String(b.identifier)));

  const reReads = carrierIds.filter((c) => c.listTruncated).length;
  console.log(
    `[train] ${rows.length} carriers RE-READ in full (${reReads} of them came back TRUNCATED on the list route,` +
      ' so the list description could not have been graded).',
  );
  // The grade's own cost, PRINTED. It is dominated by git spawns inside the timing arm —
  // one ancestry ask per distinct served deploy commit per GRADED carrier — so it scales
  // with the widened population, and an operator who sees a multi-minute run should be
  // able to read why rather than suspect a hang. Narrowing `--since` reduces the carriers;
  // it does not reduce the per-carrier history the timing arm walks.
  console.log(`[train] population+grade cost: ${((Date.now() - populationStartedMs) / 1000).toFixed(1)}s wall, ${knownShaCache.size} distinct commits probed for existence.`);
  if (retryTally.attempts > 0) {
    console.log(
      `[train]   transport: ${retryTally.attempts} failed read(s) retried, ${retryTally.retried} of them recovered.` +
        ' A row that never read is BLIND below; a retried one was read and graded normally.',
    );
  }

  // ── report ─────────────────────────────────────────────────────────────────
  const trains = rows.filter((r) => r.verdict !== 'NOT_TRAIN');
  const stranded = rows.filter((r) => r.finding);
  const unmeetable = rows.filter((r) => r.unmeetable);
  const late = rows.filter((r) => r.late);
  const ungraded = rows.filter((r) => r.ungraded);
  const graded = trains.filter((r) => !r.ungraded && r.verdict !== 'BLIND');
  const blind = rows.filter((r) => r.verdict === 'BLIND');

  if (flag('json')) {
    console.log(
      JSON.stringify(
        { liveSha, timingArm: deploys != null, population: counts, carriers: rows.length, trains: trains.length, stranded, unmeetable, late, ungraded, blind },
        null,
        2,
      ),
    );
  }

  // The provenance is PRINTED per row, not just counted: "which carriers can this check
  // see" is the subject of TRA-4984, and a reader who cannot tell a routine-born row from
  // a hand-filed one cannot tell whether the widened arm contributed anything.
  const provenance = (r) =>
    r.carrierClass === CLASS_HAND_FILED
      ? 'HAND-FILED        '
      : `routine ${r.routine}${r.bothArms ? '*' : ' '}`;
  const line = (r) => {
    console.log(`[train]   ${r.verdict.padEnd(11)} ${String(r.identifier).padEnd(10)} ${provenance(r)}  stamped ${r.firedAt ?? 'unknown'}`);
    console.log(`[train]       ${r.detail}${timingTag(r)}`);
    if (r.timingDetail) console.log(`[train]       timing: ${r.timingDetail}`);
    if (r.windowNote) console.log(`[train]       window: ${r.windowNote}`);
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

  // ⛔ A BLIND ROW MUST BE NAMED, NOT COUNTED. Before TRA-4984 the final verdict said
  // "N carrier(s) could not be read at all" and printed nothing further, so the one thing
  // a BLIND exit cannot tell you was WHICH carrier it could not see — i.e. the reader has
  // to re-run the sweep by hand to learn what the sweep already knew. That is the same
  // shape as the population hole: information the instrument holds and does not publish.
  if (blind.length > 0) {
    console.log('');
    console.log(`[train] ── BLIND (${blind.length}) — carriers this run could NOT read, named so they can be chased ──`);
    for (const r of blind) line(r);
  }

  console.log('');
  console.log('[train] ⛔ NAMED LIMIT, printed every run — WHICH CARRIER CLASSES ARE IN SCOPE (TRA-4984):');
  console.log('[train]    IN SCOPE, two arms, merged and deduped by issue id:');
  console.log('[train]      1. ROUTINE-BORN — `lastRun.linkedIssueId` on the routines list route.');
  console.log('[train]      2. HAND-FILED — ANY issue on the board, via the paged issue list. This is the');
  console.log('[train]         class a human reaches for when a deploy is too consequential to automate,');
  console.log('[train]         and before TRA-4984 it was outside the population BY CONSTRUCTION: the');
  console.log('[train]         real-money order on TRA-4942 could not be graded by this check at all.');
  console.log('[train]    WHAT IS STILL A LIMIT:');
  console.log('[train]      · arm 1 still reads ONE carrier per routine, the newest, so a worked newer');
  console.log('[train]        carrier hides an abandoned older one. It now matters less, because arm 2');
  console.log('[train]        reaches that older carrier anyway whenever it is inside the window.');
  console.log('[train]      · arm 2 is bounded by RECENCY, keyed on the issue\'s own `updatedAt`. An order');
  console.log('[train]        edited into an old ticket IS in scope (the edit moves the stamp); a carrier');
  console.log('[train]        untouched since before the window is not. `--all` grades the whole board.');
  console.log('[train]      · the list route CUTS `description` at ~1200 chars on ~91% of rows, so every');
  console.log('[train]        in-window carrier is RE-READ in full and a still-truncated body is BLIND,');
  console.log('[train]        never NOT_TRAIN. That costs one GET per carrier and is capped at');
  console.log('[train]        --issue-cap (BLIND above it, never a silently graded prefix).');
  console.log('[train]      · a `*` after a routine id means the row is reachable by BOTH arms.');
  console.log('[train] ⛔ SATISFIED means the commit is live NOW. Whether it was live BY THE DEADLINE is the');
  if (deploys == null) {
    console.log('[train]    separate `timing` column, and on this run the arm was OFF — every timing is UNREAD,');
    console.log('[train]    which is not "on time". Set RENDER_API_KEY / RENDER_SERVICE_ID to measure it.');
  } else {
    console.log(`[train]    separate \`timing\` column, measured on this run against ${deploys.length} Render deploy records.`);
  }

  // Precedence: a blind leg outranks a clean one, a stranded order outranks a missed
  // window, and both outrank a backlog. An unmeetable order sits between them: it is a
  // live defect (unlike LATE's settled history) but not an incident (unlike STRANDED).
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
  if (unmeetable.length > 0) {
    console.log(`[train] VERDICT = UNMEETABLE_WINDOW — ${unmeetable.length} unmet order(s) name a deadline the sanctioned`);
    console.log('[train] deploy path itself REFUSES (RTH freeze / dated embargo). Nothing is stranded and this must');
    console.log('[train] not page: it is an AUTHORING defect (TRA-5052) — re-issue each order with a reachable');
    console.log('[train] deadline. 13:24Z is the honest weekday boundary; the freeze is open post-close and all');
    console.log('[train] weekend, so most trains do not need a boundary-tight deadline at all.');
    return EXIT_UNMEETABLE;
  }
  if (late.length > 0) {
    console.log(`[train] VERDICT = LATE — ${late.length} order(s) are live, but did not become live until AFTER`);
    console.log('[train] their deadline. Nothing is stranded, so this is not a page — but the window the');
    console.log('[train] one-shot exists to hit was MISSED, and an ancestry-only pass calls that healthy.');
    return EXIT_LATE;
  }
  if (ungraded.length > 0) {
    console.log(`[train] VERDICT = UNGRADED — 0 stranded and 0 late among the ${graded.length} order(s) this check could`);
    console.log(`[train] measure, and ${ungraded.length} suspected carrier(s) it could not. NOT a clean bill of health:`);
    if (graded.length === 0) {
      console.log('[train] with 0 graded orders a "no stranded deploys" result is a statement about the');
      console.log('[train] instrument, not about the board.');
    } else {
      console.log('[train] the un-graded rows are un-measured, not measured-and-fine — a stranded order');
      console.log('[train] hiding in one of them is indistinguishable from this output.');
    }
    return EXIT_UNGRADED;
  }
  console.log(`[train] VERDICT = CLEAN — all ${graded.length} graded deploy order(s) SATISFIED or legitimately PENDING,`);
  console.log('[train] and no suspected carrier is unannotated.');
  return EXIT_CLEAN;
}

async function main() {
  // The instrument is graded before anything it says can be believed — but no longer
  // INSTEAD of saying it. See the AC4 block in the header: a control failure is a defect in
  // this file, a BLIND live leg is a fact about a checkout or a host, and collapsing them
  // into one exit code meant one stale fixture blacked out the alarm for the whole company.
  const controls = runControls();
  const badControls = controls.filter((c) => !c.ok);
  for (const c of controls) console.log(`[train] control ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
  if (badControls.length > 0) {
    console.log('');
    console.log(`[train] HARNESS = BROKEN — ${badControls.length} of ${controls.length} control(s) failed. Everything this run says`);
    console.log('[train] about the board below is PROVISIONAL: a grader that cannot pass its own controls');
    console.log('[train] must not convict somebody else\'s deploy. Fix the fixtures, then re-read.');
    for (const c of badControls) console.log(`[train]   FAILED: ${c.name}\n[train]     got ${JSON.stringify(c.actual)}`);
  } else {
    console.log(`[train] ${controls.length}/${controls.length} controls pass, both directions.`);
  }
  console.log('');

  if (flag('selftest')) {
    console.log('[train] --selftest: controls only, no live sweep.');
    return finalExit({ controlsFailed: badControls.length, liveExit: EXIT_CLEAN });
  }

  // ⛔ The sweep runs even with a broken harness, and a THROW inside it must not be allowed
  // to erase the harness verdict either — that is the same suppression in the other
  // direction.
  let liveExit;
  try {
    liveExit = await liveSweep();
  } catch (err) {
    console.error('[train] ERROR in the live sweep', err?.stack || err);
    liveExit = EXIT_BLIND;
  }

  const code = finalExit({ controlsFailed: badControls.length, liveExit });
  if (badControls.length > 0) {
    console.log('');
    console.log(`[train] VERDICT = HARNESS BROKEN (exit ${EXIT_HARNESS}) — ${badControls.length} control(s) failed, named above.`);
    console.log(`[train] The live sweep ran anyway and would have exited ${liveExit} on its own; read that as`);
    console.log('[train] PROVISIONAL, not as a grade. "My fixtures rotted" and "I cannot grade your deploy"');
    console.log('[train] are different messages to different people, so they no longer share exit 3.');
  }
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[train] ERROR', err?.stack || err);
    process.exit(EXIT_BLIND);
  });
