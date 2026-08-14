#!/usr/bin/env node
/**
 * TRA-3713 — SLOT LOSS: a routine that MISSES its cron slot and is replayed hours later
 * by a restart backlog drain, into a window whose reasoning has already expired.
 *
 * Split out of TRA-3625. This is the defect that made TRA-3625's acceptance fail even
 * though every one of its fixes was correct.
 *
 * WHAT HAPPENED, MEASURED
 * -----------------------
 * Carrier `e7ccfe59` (TRA-3619 leg 1) was scheduled for 2026-08-13T21:50Z. It did not
 * fire in its slot. It fired at 2026-08-14T00:21:25.309Z — 2h31m LATE — in the same
 * 00:21Z restart drain that also replayed `31a25426` and `5293f29f`.
 *
 * ⭐ A LATE REPLAY IS WORSE THAN A MISSED FIRE. The carrier's body carried TIME-SCOPED
 * reasoning: "the TRA-3625 embargo row holds 20:00-21:45Z, so deploy at 21:50Z once it
 * lifts". Replayed at 00:21Z that sentence is not merely stale, it is MISLEADING — it
 * describes a hold that no longer exists and a slot that no longer matters. The embargo
 * row, the Gate-4 refusal and the repointed pins were all correct and all irrelevant,
 * because the carrier meant to consume them arrived after the window closed.
 *
 * WHY NOTHING ELSE CATCHES IT
 * ---------------------------
 *   check:deploy-train-window  grades the OUTCOME — is the ordered commit live NOW. A
 *                              carrier that fires 3h late but whose commit rides someone
 *                              else's boot reads SATISFIED.
 *   check:routine-dispatch     grades the DISPATCH TAIL — did the fire produce a run.
 *                              A late run is a run.
 *   check:carrier-dispatch     grades whether anybody was WOKEN, not WHEN.
 *
 * None of them reads the gap between the trigger's intended slot and
 * `lastRun.triggeredAt`, so slot loss is invisible to every instrument we own. It was
 * found by grading one night by hand.
 *
 * ⛔⛔ THE INTENDED SLOT IS NOT READABLE AFTER THE FACT — THAT IS THE HARD PART.
 * `trigger.nextRunAt` has already rolled forward by the time anybody looks: to tomorrow
 * on a daily, and to 2027 on a date-pinned one-shot (`e7ccfe59` reads
 * `nextRunAt: 2027-08-13T21:50Z` for a fire that was due on 2026-08-13). Nothing on the
 * routine, the trigger or the run records the slot the fire was FOR. The slot is
 * RE-DERIVED by evaluating the cron BACKWARDS from `triggeredAt` in the trigger's own
 * timezone — see `scripts/lib/cron-slot.mjs`, which fails closed on every expression it
 * cannot read rather than guessing one.
 *
 * ⛔ THE TIMEZONE IS PART OF THE ANSWER. Crons are evaluated in the trigger's `timezone`
 * and the fleet mixes them — `e7ccfe59` is ET, `5293f29f` is UTC. A UTC-only evaluator
 * gets ET rows wrong by four hours, which is the same order of magnitude as the lateness
 * being measured, so the error would not look like a bug: it would look like a slightly
 * different lateness. Control `TZ` pins that directly.
 *
 * WHAT THE FAIL THRESHOLD IS — DESIGN QUESTION 2, ANSWERED
 * -------------------------------------------------------
 * ⭐ THE THRESHOLD THAT MATTERS IS NOT A NUMBER. What made 00:21Z harmful was not that
 * it was 151 minutes after 21:50Z; it was that the reasoning the body carried had
 * EXPIRED by then. Where a carrier declares its window as data — the `deadline` of the
 * ```deploy-order block that TRA-3533 already made mandatory — this check grades against
 * THAT and not against a guessed constant:
 *
 *   WINDOW_EXPIRED   late AND `triggeredAt` is past the order's own `deadline`.
 *                    THE INCIDENT. Its own exit code (5), because "it ran on reasoning
 *                    that had already expired" is a different event from "it ran late".
 *   SLOT_LOST_       late, but the order's `deadline` still held when it fired. A lost
 *   WINDOW_HELD      slot, and still a finding — but not the incident.
 *
 * The numeric band is the FALLBACK for rows with no declared window, and is deliberately
 * two-sided so it cannot be read as a single magic constant:
 *
 *   ON_TIME   lag <= --on-time-sec  (default 300s). Measured: `fc05a69f` fired 18s after
 *             its 20:30:00Z slot. Drain latency of this size is normal and silent.
 *   DRIFT     between the two. REPORTED, never a finding — a band that fails on 6
 *             minutes would fire on ordinary scheduler jitter and be muted within a week.
 *   SLOT_LOST lag >= --fail-min (default 60m). Measured: the three replayed rows are
 *             2h31m, 2h41m and 2h31m. Nothing observed lies between 18s and 2h31m, so
 *             the boundary is NOT derivable from the data — it is a declared default,
 *             printed on every run, and that is exactly why the declared-window path
 *             above outranks it wherever a window exists.
 *
 * ⛔⛔ A RESTART DRAIN IS ONE EVENT, NOT N FINDINGS. The 00:21Z drain replayed three
 * routines within 19 SECONDS of each other. Reporting three findings prescribes three
 * repairs for one process gap and buries the subject. Rows whose fires cluster inside
 * `--drain-window-sec` (default 120) and number at least `--drain-min` (default 3) are
 * reported as ONE `RESTART_DRAIN` with its members listed. They stay findings — a lost
 * slot is lost either way — but the banner names ONE subject.
 *
 * THE EXCLUSIONS — AND WHY A ZERO-EXCLUSION RUN IS A BLIND RUN
 * -----------------------------------------------------------
 * Pre-registered in the ticket: the 2026-08-13 night gives three known-LATE rows and a
 * population of on-time fires, and a detector that does not SEPARATE those groups is not
 * measuring slot loss. Both groups are pinned as controls, in both directions.
 *
 * ⛔⛔ ONE OF THE THREE PRE-REGISTERED LATE ROWS IS STRUCTURALLY UNGRADEABLE, and finding
 * that out is most of what this check is worth. `31a25426` fired at 00:21:37.795Z in the
 * same drain — and its `triggers` array is **EMPTY** and its `lastRun.triggerId` is
 * **null**. The trigger was retired after the fire (the standing remedy for the 2027
 * zombie `nextRunAt` that check:spent-oneshot files), and it took the cron expression
 * with it. There is no cron to evaluate backwards, so THE SLOT CANNOT BE RE-DERIVED AT
 * ALL. That row is `SLOT_UNREADABLE`: not clean, not late, its own state, printed in
 * full. A detector that quietly dropped it would report 2 of the 3 known rows and read
 * as if it had swept everything.
 *
 * ⛔ `triggerId: null` IS NEVER RESOLVED BY GUESSING. Where a routine has exactly one
 * schedule trigger it is tempting to assume the run came from it. That is an inference,
 * not a record — and on a PRIMARY+RETRY pair (TRA-3603) it is wrong half the time, in a
 * direction that invents lateness. It fails closed.
 *
 * ⛔ EXCLUSIONS ARE PRINTED IN FULL AT EVERY VERDICT INCLUDING CLEAN, with counts by
 * cause. This check's entire history is states that read identically in pass and fail.
 *
 * ⛔ ZERO GRADED ROWS IS BLIND, NEVER CLEAN (exit 3).
 *
 * ⛔ UNGRADED (exit 4) is NOT "clean with caveats": it is raised when no finding was
 * produced but at least one row that IS a deploy train could not have its slot read. The
 * urgent class being unmeasurable is not the same event as the urgent class being fine.
 *
 * ⛔ NAMED BLIND SPOT, printed every run: the routines LIST route carries ONE run per
 * routine (`lastRun`, the newest). A routine whose newest fire was on time HIDES an
 * older lost slot. Same cap as check:carrier-dispatch and check:deploy-train-window, and
 * it is a cap, not a sweep.
 *
 * ⛔ ARCHIVED ROUTINES ARE IN THE POPULATION. 163 of 197 carriers sit on archived
 * routines because a one-shot's own prose orders it to archive itself as step 1 — and
 * the self-archiving deploy trains are exactly the urgent case. `e7ccfe59` is archived.
 * An `active`-only filter here would hide the founding fixture.
 *
 * EXIT CODES — precedence BLIND > WINDOW_EXPIRED > SLOT_LOST > UNGRADED > CLEAN
 *   0  CLEAN           every graded fire landed in its slot (or inside the drift band)
 *   1  SLOT_LOST       at least one fire lost its slot, window intact or undeclared
 *   2  usage / config error
 *   3  BLIND           controls failed, population unreadable, or zero rows graded
 *   4  UNGRADED        no findings, but a deploy train's slot could not be re-derived
 *   5  WINDOW_EXPIRED  a fire executed past its own declared deadline — THE INCIDENT
 *
 * USAGE
 *   node scripts/check-slot-loss.mjs                 # controls + live sweep
 *   node scripts/check-slot-loss.mjs --selftest      # controls only, no live sweep
 *   node scripts/check-slot-loss.mjs --window-days=14 --fail-min=90
 *   node scripts/check-slot-loss.mjs --routine=e7ccfe59   # grade one row end to end
 */

import { parseDeployOrder, classifyCarrier } from './lib/deploy-order.mjs';
import { attributeSlot } from './lib/cron-slot.mjs';

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;
export const EXIT_BLIND = 3;
export const EXIT_UNGRADED = 4;
export const EXIT_WINDOW_EXPIRED = 5;

const DEFAULTS = {
  windowDays: 7,
  onTimeSec: 300,
  failMin: 60,
  lookbackDays: 400,
  drainWindowSec: 120,
  drainMin: 3,
};

// Verdicts that are FINDINGS. Everything else is either a graded pass or an exclusion.
export const FINDING_VERDICTS = new Set([
  'SLOT_LOST',
  'SLOT_LOST_WINDOW_HELD',
  'WINDOW_EXPIRED',
  'ORDER_DEADLINE_BEFORE_SLOT',
  'FIRED_EARLY',
]);

// Verdicts that mean "this fire was measured against its slot". Exclusions are NOT here,
// and the difference is what makes a zero-exclusion claim auditable.
export const GRADED_VERDICTS = new Set(['ON_TIME', 'DRIFT', ...FINDING_VERDICTS]);

export const EXCLUSION_VERDICTS = new Set(['NO_RUN', 'OUT_OF_WINDOW', 'NOT_SCHEDULED', 'SLOT_UNREADABLE', 'SLOT_UNATTRIBUTABLE']);

/** Exclusions that mean "this row's slot could not be established" — the class that makes a train UNGRADED. */
const UNMEASURED_VERDICTS = new Set(['SLOT_UNREADABLE', 'SLOT_UNATTRIBUTABLE']);

// ─────────────────────────────────────────────────────────────────────────────
// THE PURE CORE. No I/O below this line until the live shell.
// ─────────────────────────────────────────────────────────────────────────────

/** "2h 31m" — a lateness that has to be readable at a glance in a report line. */
export function humanGap(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0 && m === 0) return `${s}s`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const short = (s) => (typeof s === 'string' ? s.slice(0, 8) : String(s));

/**
 * Grade ONE routine row from the list route against its own intended slot.
 *
 * @param {object} routine  a row exactly as the routines LIST route serves it
 * @param {object} opts     { nowMs, windowDays, onTimeSec, failMin, lookbackDays }
 * @returns {object} { id, title, verdict, ... } — total; every path names its reason.
 */
export function gradeRoutine(routine, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const base = {
    id: routine?.id,
    title: routine?.title ?? '(untitled)',
    status: routine?.status,
    assigneeAgentId: routine?.assigneeAgentId ?? null,
    carrier: classifyCarrier(routine?.description).kind,
  };

  const run = routine?.lastRun;
  if (!run) return { ...base, verdict: 'NO_RUN', detail: 'routine has never dispatched a run' };

  const firedMs = Date.parse(run.triggeredAt);
  if (!Number.isFinite(firedMs)) {
    // ⛔ INCLUDED, never dropped — the sibling checks' recency rule. An unreadable fire
    // instant is the most unmeasurable a row can be, and dropping it reads as clean.
    return {
      ...base,
      verdict: 'SLOT_UNREADABLE',
      cause: 'unreadable triggeredAt',
      detail: `lastRun.triggeredAt is ${JSON.stringify(run.triggeredAt)}`,
    };
  }
  base.firedIso = new Date(firedMs).toISOString();
  base.firedMs = firedMs;

  if (Number.isFinite(o.nowMs) && firedMs < o.nowMs - o.windowDays * 86400000) {
    return { ...base, verdict: 'OUT_OF_WINDOW', detail: `newest fire is older than the ${o.windowDays}d window` };
  }

  if (run.source !== 'schedule') {
    // A manual or API fire has no slot to miss. Saying nothing about it is correct;
    // saying it was ON TIME would be a claim about a schedule that was never consulted.
    return { ...base, verdict: 'NOT_SCHEDULED', detail: `lastRun.source = ${JSON.stringify(run.source)} — no slot was intended` };
  }

  const triggers = Array.isArray(routine?.triggers) ? routine.triggers : [];
  if (!run.triggerId) {
    return {
      ...base,
      verdict: 'SLOT_UNREADABLE',
      cause: 'run carries no triggerId',
      detail:
        `lastRun.triggerId is null and the routine holds ${triggers.length} trigger(s) — the cron that produced this fire is not recorded. ` +
        'Refusing to attribute it to a surviving trigger: that is an inference, and on a PRIMARY+RETRY pair it is wrong in the direction that invents lateness.',
    };
  }

  const trigger = triggers.find((t) => t?.id === run.triggerId);
  if (!trigger) {
    return {
      ...base,
      verdict: 'SLOT_UNREADABLE',
      cause: 'trigger retired after the fire',
      detail:
        `lastRun.triggerId ${short(run.triggerId)} is not among the routine's ${triggers.length} surviving trigger(s) — ` +
        'it was deleted after the fire (the standing remedy for the 2027 zombie nextRunAt), and it took its cron expression with it.',
    };
  }
  base.triggerId = trigger.id;
  base.triggerLabel = trigger.label ?? null;
  base.cron = trigger.cronExpression ?? null;
  base.tz = trigger.timezone ?? null;

  if (trigger.kind !== 'schedule' || !trigger.cronExpression) {
    return {
      ...base,
      verdict: 'SLOT_UNREADABLE',
      cause: 'trigger is not a cron schedule',
      detail: `trigger kind=${JSON.stringify(trigger.kind)} cronExpression=${JSON.stringify(trigger.cronExpression)}`,
    };
  }

  // ⛔⛔ THE FLOOR IS THE ROUTINE'S OWN `createdAt`. A routine cannot have missed a slot
  // it was never armed for, and a cron evaluated backwards past its creation invents
  // one every time. Measured: `618de42d` (created 2026-08-13T15:45Z, weekly Mondays)
  // grades against the Monday of 2026-08-11 and reads "72h late" — a number manufactured
  // out of calendar arithmetic that looks exactly like a real missed weekly slot.
  const createdMs = Date.parse(routine?.createdAt);
  const nextRunMs = Date.parse(trigger.nextRunAt);
  const slot = attributeSlot(trigger.cronExpression, trigger.timezone, firedMs, {
    lookbackDays: o.lookbackDays,
    notBeforeMs: Number.isFinite(createdMs) ? createdMs : undefined,
    nextRunAtMs: Number.isFinite(nextRunMs) ? nextRunMs : undefined,
    earlyToleranceMs: o.onTimeSec * 1000,
  });
  if (!slot.ok) {
    // ⛔ ITS OWN STATE, and NOT a lateness. An off-cron dispatch that belongs to no slot
    // is a real thing the fleet does; reporting it as "24h early" or "8735h late" would
    // be inventing a number in order to have one.
    const unreadable = /timezone|cron|cap|5 cron fields/i.test(slot.error);
    return {
      ...base,
      verdict: unreadable ? 'SLOT_UNREADABLE' : 'SLOT_UNATTRIBUTABLE',
      cause: unreadable ? 'cron not evaluable' : 'fire belongs to no slot this routine was armed for',
      detail: slot.error,
    };
  }
  base.slotIso = new Date(slot.slotMs).toISOString();
  base.slotMs = slot.slotMs;
  base.direction = slot.direction;
  base.lagMs = slot.direction === 'late' ? slot.deltaMs : -slot.deltaMs;

  const parsedOrder = parseDeployOrder(routine?.description);
  const order = parsedOrder.ok ? parsedOrder.order : null;
  if (order) base.order = { commit: short(order.commit), host: order.host, deadline: order.deadline };

  const offBy = slot.deltaMs > o.onTimeSec * 1000;

  // ⛔ A FIRE CAN PRECEDE THE SLOT IT CONSUMED, and that is the MIRROR of this ticket's
  // defect, not a rounding error: a carrier dispatched before its window OPENS runs on
  // reasoning that has not yet become true, exactly as a late one runs on reasoning that
  // has stopped being true. This branch is reached ONLY when `nextRunAt` has moved past
  // the slot, i.e. the scheduler itself says it was spent — never on a distance
  // comparison, which is what turned three late weekly replays into "early" fires.
  if (slot.direction === 'early') {
    if (!offBy) return { ...base, verdict: 'ON_TIME', detail: `fired ${humanGap(slot.deltaMs)} before its ${base.slotIso} slot` };
    return {
      ...base,
      verdict: 'FIRED_EARLY',
      detail: `fired ${humanGap(slot.deltaMs)} BEFORE the ${base.slotIso} slot it consumed — the window this body reasons about had not opened yet`,
    };
  }

  const late = offBy;

  // An order whose deadline precedes its own cron slot can NEVER be met, even by a fire
  // that lands perfectly. That is an authoring defect, not slot loss, and it is graded
  // before the lateness bands so it cannot masquerade as one.
  if (order && order.deadlineMs < slot.slotMs) {
    return {
      ...base,
      verdict: 'ORDER_DEADLINE_BEFORE_SLOT',
      detail: `the order's deadline ${order.deadline} is BEFORE this trigger's own slot ${base.slotIso} — an on-time fire could not have met it`,
    };
  }

  if (!late) return { ...base, verdict: 'ON_TIME', detail: `fired ${humanGap(base.lagMs)} after its ${base.slotIso} slot` };

  if (order && firedMs > order.deadlineMs) {
    return {
      ...base,
      verdict: 'WINDOW_EXPIRED',
      detail:
        `fired ${humanGap(base.lagMs)} after its ${base.slotIso} slot, and ${humanGap(firedMs - order.deadlineMs)} PAST its own ` +
        `${order.deadline} deadline — the body's time-scoped reasoning had already expired when it ran`,
    };
  }

  if (base.lagMs < o.failMin * 60000) {
    return { ...base, verdict: 'DRIFT', detail: `fired ${humanGap(base.lagMs)} after its ${base.slotIso} slot — inside the ${o.failMin}m band` };
  }

  if (order) {
    return {
      ...base,
      verdict: 'SLOT_LOST_WINDOW_HELD',
      detail: `fired ${humanGap(base.lagMs)} after its ${base.slotIso} slot, but still inside its ${order.deadline} deadline`,
    };
  }

  return {
    ...base,
    verdict: 'SLOT_LOST',
    detail: `fired ${humanGap(base.lagMs)} after its ${base.slotIso} slot; the body declares no deadline, so whether its reasoning still held is UNKNOWABLE from data`,
  };
}

/**
 * Group findings whose fires cluster in time into ONE drain event.
 *
 * ⛔ Byte-adjacent fire times across unrelated routines are ONE PROCESS EVENT (a restart
 * backlog drain), not N independent faults. Prescribing N repairs for one process gap is
 * the failure mode; the members stay findings and the SUBJECT becomes the drain.
 *
 * @returns {{ clusters: Array<{firstMs,lastMs,members:object[]}>, singles: object[] }}
 */
export function clusterDrains(findings, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rows = findings.filter((f) => Number.isFinite(f.firedMs)).sort((a, b) => a.firedMs - b.firedMs);
  const unclusterable = findings.filter((f) => !Number.isFinite(f.firedMs));

  const groups = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && r.firedMs - last[last.length - 1].firedMs <= o.drainWindowSec * 1000) last.push(r);
    else groups.push([r]);
  }

  const clusters = [];
  const singles = [...unclusterable];
  for (const g of groups) {
    if (g.length >= o.drainMin) clusters.push({ firstMs: g[0].firedMs, lastMs: g[g.length - 1].firedMs, members: g });
    else singles.push(...g);
  }
  return { clusters, singles };
}

/**
 * Roll a graded population up into ONE verdict + exit code.
 *
 * Precedence BLIND > WINDOW_EXPIRED > SLOT_LOST > UNGRADED > CLEAN, and each state is
 * reachable — the controls assert that, because a lattice with an unreachable rung is a
 * lattice that has quietly collapsed into a constant.
 */
export function summarise(rows) {
  const graded = rows.filter((r) => GRADED_VERDICTS.has(r.verdict));
  const findings = rows.filter((r) => FINDING_VERDICTS.has(r.verdict));
  const excluded = rows.filter((r) => EXCLUSION_VERDICTS.has(r.verdict));
  const unreadableTrains = rows.filter((r) => UNMEASURED_VERDICTS.has(r.verdict) && r.carrier === 'train');

  if (graded.length === 0) {
    return {
      verdict: 'BLIND',
      exit: EXIT_BLIND,
      graded,
      findings,
      excluded,
      unreadableTrains,
      reason: `0 of ${rows.length} row(s) could be graded against a slot — an empty measurement, not a clean board`,
    };
  }
  if (findings.some((f) => f.verdict === 'WINDOW_EXPIRED')) {
    return { verdict: 'WINDOW_EXPIRED', exit: EXIT_WINDOW_EXPIRED, graded, findings, excluded, unreadableTrains };
  }
  if (findings.length > 0) {
    return { verdict: 'SLOT_LOST', exit: EXIT_FINDINGS, graded, findings, excluded, unreadableTrains };
  }
  if (unreadableTrains.length > 0) {
    return { verdict: 'UNGRADED', exit: EXIT_UNGRADED, graded, findings, excluded, unreadableTrains };
  }
  return { verdict: 'CLEAN', exit: EXIT_CLEAN, graded, findings, excluded, unreadableTrains };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS — run on EVERY invocation, not only under --selftest.
//
// The population is PRE-REGISTERED in TRA-3713 so the detector cannot be graded on an
// empty cohort: three known-LATE rows from the 2026-08-13 00:21Z drain, and a known
// ON-TIME fire (`fc05a69f`, 18s after its slot). Every fixture below is the real shape
// the live list route served on 2026-08-14, field for field.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-08-14T06:00:00.000Z');

/** A routine row in the shape the LIST route serves. */
function fixture({ id, title = 'fixture', description = '', triggers = [], run = null, status = 'archived', createdAt = '2020-01-01T00:00:00.000Z' }) {
  return { id, title, status, description, createdAt, assigneeAgentId: 'agent-1', triggers, lastRun: run };
}

const trig = (id, cronExpression, timezone, extra = {}) => ({
  id,
  kind: 'schedule',
  label: null,
  enabled: true,
  cronExpression,
  timezone,
  ...extra,
});

const run = (triggerId, triggeredAt, extra = {}) => ({
  triggerId,
  source: 'schedule',
  status: 'completed',
  triggeredAt,
  ...extra,
});

const orderBlock = (commit, deadline) => `\n\`\`\`deploy-order\ncommit: ${commit}\nhost: tradingai-bqb1\ndeadline: ${deadline}\n\`\`\`\n`;

export function runControls() {
  const out = [];
  const check = (name, actual, ok) => out.push({ name, ok: Boolean(ok), actual });
  const g = (r, opts) => gradeRoutine(r, { nowMs: NOW, ...opts });

  // ── THE PRE-REGISTERED LATE COHORT ─────────────────────────────────────────
  // ⛔ These three are the ONLY reason this detector can claim to measure anything.
  const e7 = g(
    fixture({
      id: 'e7ccfe59',
      title: 'TRA-3619 leg 1: deploy 229af6d to bqb1 post-close',
      description: 'Deploy the re-derived origin/main TIP to bqb1 with scripts/render-redeploy.mjs.',
      triggers: [trig('300ec486', '50 17 13 8 *', 'America/New_York', { nextRunAt: '2027-08-13T21:50:00.000Z' })],
      run: run('300ec486', '2026-08-14T00:21:25.309Z'),
    }),
  );
  check(
    'PRE-REGISTERED LATE — e7ccfe59: slot re-derived as 21:50Z from a cron whose nextRunAt has rolled to 2027',
    { verdict: e7.verdict, slot: e7.slotIso, lag: humanGap(e7.lagMs) },
    e7.verdict === 'SLOT_LOST' && e7.slotIso === '2026-08-13T21:50:00.000Z' && e7.lagMs === 9085309,
  );

  const f52 = g(
    fixture({
      id: '5293f29f',
      title: 'TRA-2220 give-back recorder liveness watch',
      status: 'active',
      description: 'Read the tripwire and comment. <!-- deploy-order: none -->',
      triggers: [trig('e39890dc', '40 21 * * 1-5', 'UTC')],
      run: run('e39890dc', '2026-08-14T00:21:19.151Z'),
    }),
  );
  check(
    'PRE-REGISTERED LATE — 5293f29f: a UTC-timezone trigger, slot 21:40Z, 2h41m late',
    { verdict: f52.verdict, slot: f52.slotIso, lag: humanGap(f52.lagMs) },
    f52.verdict === 'SLOT_LOST' && f52.slotIso === '2026-08-13T21:40:00.000Z' && f52.lagMs === 9679151,
  );

  // ⛔⛔ THE ROW THAT CANNOT BE GRADED. Same drain, same lateness — and its triggers array
  // is EMPTY, so the slot is unrecoverable. It must be its OWN state: not clean, not late.
  const f31 = g(
    fixture({
      id: '31a25426',
      title: 'TRA-3387 leg 1: deploy 48a0883',
      description: 'Deploy 48a0883 to bqb1 via scripts/render-redeploy.mjs.',
      triggers: [],
      run: run(null, '2026-08-14T00:21:37.795Z'),
    }),
  );
  check(
    'PRE-REGISTERED LATE BUT UNGRADEABLE — 31a25426 fired in the same drain with triggers:[] and triggerId:null',
    { verdict: f31.verdict, cause: f31.cause, carrier: f31.carrier },
    f31.verdict === 'SLOT_UNREADABLE' && f31.cause === 'run carries no triggerId' && f31.carrier === 'train',
  );
  check(
    'NEGATIVE — that ungradeable row is NOT reported as ON_TIME and NOT counted as graded',
    { verdict: f31.verdict, graded: GRADED_VERDICTS.has(f31.verdict) },
    f31.verdict !== 'ON_TIME' && !GRADED_VERDICTS.has(f31.verdict),
  );

  // ── THE PRE-REGISTERED ON-TIME COHORT ──────────────────────────────────────
  const fc = g(
    fixture({
      id: 'fc05a69f',
      title: 'TRA-3547 deploy 8713331 to bqb1 after RTH',
      description: 'Deploy 8713331 to bqb1 with scripts/render-redeploy.mjs after RTH.',
      triggers: [trig('8ef8eab8', '30 16 * * 1-5', 'America/New_York')],
      run: run('8ef8eab8', '2026-08-13T20:30:18.251Z'),
    }),
  );
  check(
    'PRE-REGISTERED ON TIME — fc05a69f fired 18s after its 20:30:00Z slot and is SILENT',
    { verdict: fc.verdict, slot: fc.slotIso, lagMs: fc.lagMs },
    fc.verdict === 'ON_TIME' && fc.slotIso === '2026-08-13T20:30:00.000Z' && fc.lagMs === 18251,
  );
  check(
    'SEPARATION — the pre-registered LATE and ON-TIME groups land in different verdicts',
    { late: [e7.verdict, f52.verdict], onTime: fc.verdict },
    e7.verdict !== fc.verdict && f52.verdict !== fc.verdict,
  );

  // ── THE TIMEZONE ARM ───────────────────────────────────────────────────────
  // ⛔ Identical cron + identical fire, ET vs UTC. If the tz is ever defaulted or
  // ignored, THIS is the control that catches it — and the error it catches is 4h, the
  // same magnitude as the lateness being measured.
  const tzUtc = g(
    fixture({
      id: 'tz-utc',
      triggers: [trig('t', '50 17 13 8 *', 'UTC')],
      run: run('t', '2026-08-14T00:21:25.309Z'),
    }),
  );
  check(
    'TZ — the SAME cron and fire graded in UTC yields a DIFFERENT slot than in ET (the tz is read, not assumed)',
    { et: e7.slotIso, utc: tzUtc.slotIso },
    tzUtc.slotIso === '2026-08-13T17:50:00.000Z' && tzUtc.slotIso !== e7.slotIso,
  );
  const tzMissing = g(
    fixture({
      id: 'tz-missing',
      triggers: [trig('t', '50 17 13 8 *', null)],
      run: run('t', '2026-08-14T00:21:25.309Z'),
    }),
  );
  check(
    'TZ FAILS CLOSED — a trigger with no timezone is UNREADABLE, never silently graded as UTC',
    { verdict: tzMissing.verdict, detail: tzMissing.detail },
    tzMissing.verdict === 'SLOT_UNREADABLE' && /timezone/i.test(tzMissing.detail),
  );

  // ── THE DECLARED-WINDOW ARM — paired, one variable apart ───────────────────
  const expired = g(
    fixture({
      id: 'win-expired',
      description: `Deploy once the embargo lifts.${orderBlock('229af6d', '2026-08-13T22:30:00Z')}`,
      triggers: [trig('t', '50 17 13 8 *', 'America/New_York')],
      run: run('t', '2026-08-14T00:21:25.309Z'),
    }),
  );
  check(
    'WINDOW POSITIVE — a late fire PAST its own deploy-order deadline is WINDOW_EXPIRED (the incident)',
    { verdict: expired.verdict },
    expired.verdict === 'WINDOW_EXPIRED',
  );
  const held = g(
    fixture({
      id: 'win-held',
      description: `Deploy once the embargo lifts.${orderBlock('229af6d', '2026-08-14T06:00:00Z')}`,
      triggers: [trig('t', '50 17 13 8 *', 'America/New_York')],
      run: run('t', '2026-08-14T00:21:25.309Z'),
    }),
  );
  check(
    'WINDOW NEGATIVE — the SAME lateness with a deadline that still HELD is SLOT_LOST_WINDOW_HELD, not the incident',
    { verdict: held.verdict, lagMs: held.lagMs },
    held.verdict === 'SLOT_LOST_WINDOW_HELD' && held.lagMs === expired.lagMs,
  );
  check(
    'WINDOW — the two differ by exactly ONE variable: the deadline instant',
    { expired: expired.verdict, held: held.verdict, sameLag: held.lagMs === expired.lagMs },
    expired.verdict !== held.verdict && held.lagMs === expired.lagMs,
  );
  const inverted = g(
    fixture({
      id: 'win-inverted',
      description: `Deploy.${orderBlock('229af6d', '2026-08-13T20:00:00Z')}`,
      triggers: [trig('t', '50 17 13 8 *', 'America/New_York')],
      run: run('t', '2026-08-13T21:50:02.000Z'),
    }),
  );
  check(
    'WINDOW AUTHORING — a deadline BEFORE the trigger’s own slot is its own finding, not slot loss',
    { verdict: inverted.verdict },
    inverted.verdict === 'ORDER_DEADLINE_BEFORE_SLOT',
  );

  // ── THE NUMERIC BAND, both sides ───────────────────────────────────────────
  const justUnder = g(
    fixture({
      id: 'band-under',
      triggers: [trig('t', '30 16 * * 1-5', 'America/New_York')],
      run: run('t', '2026-08-13T21:29:00.000Z'), // 59m after the 20:30Z slot
    }),
  );
  const justOver = g(
    fixture({
      id: 'band-over',
      triggers: [trig('t', '30 16 * * 1-5', 'America/New_York')],
      run: run('t', '2026-08-13T21:31:00.000Z'), // 61m after the 20:30Z slot
    }),
  );
  check(
    'BAND — 59m after the slot is DRIFT (reported, not a finding); 61m is SLOT_LOST. The band has two sides.',
    { under: justUnder.verdict, over: justOver.verdict },
    justUnder.verdict === 'DRIFT' && justOver.verdict === 'SLOT_LOST' && !FINDING_VERDICTS.has('DRIFT'),
  );
  const onTimeEdge = g(
    fixture({
      id: 'band-ontime',
      triggers: [trig('t', '30 16 * * 1-5', 'America/New_York')],
      run: run('t', '2026-08-13T20:34:00.000Z'), // 240s
    }),
  );
  check(
    'BAND — a 4m drain latency is ON_TIME, so ordinary scheduler jitter cannot put a floor under the verdict',
    { verdict: onTimeEdge.verdict },
    onTimeEdge.verdict === 'ON_TIME',
  );

  // ── THE OTHER EXCLUSIONS ───────────────────────────────────────────────────
  const manual = g(
    fixture({
      id: 'manual',
      triggers: [trig('t', '30 16 * * 1-5', 'America/New_York')],
      run: run('t', '2026-08-14T00:21:00.000Z', { source: 'manual' }),
    }),
  );
  check(
    'EXCLUSION — a MANUAL fire has no slot to miss and is NOT_SCHEDULED, never "on time"',
    { verdict: manual.verdict },
    manual.verdict === 'NOT_SCHEDULED',
  );
  const stale = g(
    fixture({
      id: 'stale',
      triggers: [trig('t', '30 16 * * 1-5', 'America/New_York')],
      run: run('t', '2026-06-01T20:30:00.000Z'),
    }),
  );
  check('EXCLUSION — a fire older than the window is OUT_OF_WINDOW', { verdict: stale.verdict }, stale.verdict === 'OUT_OF_WINDOW');
  const noRun = g(fixture({ id: 'norun', triggers: [trig('t', '30 16 * * 1-5', 'UTC')], run: null }));
  check('EXCLUSION — a routine that has never dispatched is NO_RUN', { verdict: noRun.verdict }, noRun.verdict === 'NO_RUN');
  const badTs = g(
    fixture({
      id: 'badts',
      triggers: [trig('t', '30 16 * * 1-5', 'UTC')],
      run: run('t', 'not-a-date'),
    }),
  );
  check(
    'EXCLUSION FAILS OPEN INTO THE POPULATION — an unreadable triggeredAt is UNREADABLE, never dropped as OUT_OF_WINDOW',
    { verdict: badTs.verdict, cause: badTs.cause },
    badTs.verdict === 'SLOT_UNREADABLE' && badTs.cause === 'unreadable triggeredAt',
  );
  const retired = g(
    fixture({
      id: 'retired',
      triggers: [trig('other', '30 16 * * 1-5', 'UTC')],
      run: run('gone', '2026-08-14T00:21:00.000Z'),
    }),
  );
  check(
    'EXCLUSION — a run whose trigger was RETIRED after the fire is UNREADABLE, and is NOT attributed to a surviving sibling',
    { verdict: retired.verdict, cause: retired.cause },
    retired.verdict === 'SLOT_UNREADABLE' && retired.cause === 'trigger retired after the fire',
  );
  const bothFields = g(
    fixture({
      id: 'domdow',
      triggers: [trig('t', '0 12 13 * 1', 'UTC')],
      run: run('t', '2026-08-14T00:21:00.000Z'),
    }),
  );
  check(
    'CRON FAILS CLOSED — dom AND dow both restricted is UNREADABLE (Vixie ORs, others AND; the row does not say which)',
    { verdict: bothFields.verdict },
    bothFields.verdict === 'SLOT_UNREADABLE',
  );

  // ── THE SIGN OF THE ERROR, AND THE CREATION FLOOR ──────────────────────────
  // ⛔ Both arms are REAL ROWS the first live sweep got WRONG. A one-sided backward
  // solver cannot produce a lateness of the wrong sign — it produces a confident,
  // enormous, wrong one, and 72h on a weekly cron reads exactly like a real missed slot.
  const offCron = g(
    fixture({
      id: 'd038b618',
      title: 'TRA-3712 one-shot (QADesigner arm)',
      status: 'active',
      createdAt: '2026-08-13T11:06:05.512Z',
      triggers: [trig('815ca5ec', '45 21 14 8 *', 'America/New_York', { nextRunAt: '2026-08-15T01:45:00.000Z' })],
      run: run('815ca5ec', '2026-08-14T01:20:56.442Z'),
    }),
  );
  check(
    'UNATTRIBUTABLE — d038b618 fired while its ONLY slot was still armed and its routine did not exist at the previous one: no lateness is asserted at all',
    { verdict: offCron.verdict, cause: offCron.cause },
    offCron.verdict === 'SLOT_UNATTRIBUTABLE' && offCron.lagMs === undefined,
  );
  const preCreation = g(
    fixture({
      id: '618de42d',
      title: 'TRA-2937 close-out monitor (WEEKLY Mondays)',
      status: 'active',
      createdAt: '2026-08-13T15:45:30.194Z',
      triggers: [trig('44157733', '40 21 * * 1', 'America/New_York', { nextRunAt: '2026-08-18T01:40:00.000Z' })],
      run: run('44157733', '2026-08-14T01:40:09.111Z'),
    }),
  );
  check(
    'CREATION FLOOR — a slot that PREDATES the routine’s own createdAt is never graded; 618de42d is not "72h late" for a Monday it did not exist for',
    { verdict: preCreation.verdict, lagMs: preCreation.lagMs },
    preCreation.verdict === 'SLOT_UNATTRIBUTABLE' && preCreation.lagMs === undefined,
  );

  // ⛔⛔ THE ARM THAT KILLED THE NEAREST-SLOT RULE. A weekly replay more than half a week
  // late is NEARER to the next slot than to the one it missed. All three of these real
  // rows were graded "3d 7m early" by a distance comparison; `nextRunAt` still points AT
  // the 08-14 slot, which proves it was never consumed and the fire is a LATE replay.
  const weeklyReplay = g(
    fixture({
      id: '81928e50',
      title: 'TRA-971 weekly review',
      status: 'active',
      createdAt: '2026-06-19T13:08:02.561Z',
      triggers: [trig('t', '30 16 * * 5', 'America/New_York', { nextRunAt: '2026-08-14T20:30:00.000Z' })],
      run: run('t', '2026-08-11T13:30:39.298Z'),
    }),
    { windowDays: 30 },
  );
  check(
    'NEXTRUNAT IS THE EVIDENCE — a weekly replay nearer to the NEXT slot is still LATE off the one it missed, because nextRunAt shows the next is still armed',
    { verdict: weeklyReplay.verdict, slot: weeklyReplay.slotIso, lag: humanGap(weeklyReplay.lagMs) },
    weeklyReplay.verdict === 'SLOT_LOST' && weeklyReplay.slotIso === '2026-08-07T20:30:00.000Z',
  );
  const trueEarly = g(
    fixture({
      id: 'true-early',
      title: 'the SAME row whose nextRunAt has moved PAST the 08-14 slot',
      status: 'active',
      createdAt: '2026-08-10T00:00:00.000Z',
      triggers: [trig('t', '30 16 * * 5', 'America/New_York', { nextRunAt: '2026-08-21T20:30:00.000Z' })],
      run: run('t', '2026-08-14T18:00:00.000Z'),
    }),
  );
  check(
    'FIRED_EARLY — reached ONLY when nextRunAt has moved BEYOND the slot, i.e. the scheduler says it was spent',
    { verdict: trueEarly.verdict, slot: trueEarly.slotIso },
    trueEarly.verdict === 'FIRED_EARLY' && trueEarly.slotIso === '2026-08-14T20:30:00.000Z',
  );
  const preCreationOld = g(
    fixture({
      id: '618de42d-old',
      title: 'the SAME row, created a month earlier',
      status: 'active',
      createdAt: '2026-07-01T00:00:00.000Z',
      triggers: [trig('44157733', '40 21 * * 1', 'America/New_York')],
      run: run('44157733', '2026-08-14T01:40:09.111Z'),
    }),
  );
  check(
    'CREATION FLOOR NEGATIVE — the SAME row created a month earlier DOES grade against its 08-11 Monday, so the floor suppresses a slot rather than the finding',
    { verdict: preCreationOld.verdict, slot: preCreationOld.slotIso },
    preCreationOld.verdict === 'SLOT_LOST' && preCreationOld.slotIso === '2026-08-11T01:40:00.000Z',
  );
  const earlySeconds = g(
    fixture({
      id: 'early-jitter',
      createdAt: '2026-08-01T00:00:00.000Z',
      triggers: [trig('t', '30 16 * * 1-5', 'America/New_York')],
      run: run('t', '2026-08-13T20:29:58.000Z'), // 2s BEFORE the slot
    }),
  );
  check(
    'SIGN NEGATIVE — a fire 2s ahead of its slot is ON_TIME, not FIRED_EARLY; the early band has the same tolerance as the late one',
    { verdict: earlySeconds.verdict },
    earlySeconds.verdict === 'ON_TIME',
  );

  // ── THE DRAIN CLUSTER ──────────────────────────────────────────────────────
  const drainRows = [e7, f52, g(
    fixture({
      id: 'drain-3',
      triggers: [trig('t', '40 21 * * 1-5', 'UTC')],
      run: run('t', '2026-08-14T00:21:30.000Z'),
    }),
  )];
  const clustered = clusterDrains(drainRows);
  check(
    'DRAIN — three lost slots inside 19s are ONE RESTART_DRAIN event, not three independent findings',
    { clusters: clustered.clusters.length, members: clustered.clusters[0]?.members.length, singles: clustered.singles.length },
    clustered.clusters.length === 1 && clustered.clusters[0].members.length === 3 && clustered.singles.length === 0,
  );
  const spread = clusterDrains([
    { ...e7, firedMs: Date.parse('2026-08-14T00:21:25Z') },
    { ...f52, firedMs: Date.parse('2026-08-14T03:00:00Z') },
    { ...e7, id: 'x', firedMs: Date.parse('2026-08-14T05:00:00Z') },
  ]);
  check(
    'DRAIN NEGATIVE — three lost slots HOURS apart are NOT one event; they stay three findings',
    { clusters: spread.clusters.length, singles: spread.singles.length },
    spread.clusters.length === 0 && spread.singles.length === 3,
  );

  // ── THE VERDICT LATTICE ────────────────────────────────────────────────────
  check(
    'ZERO GRADED ROWS IS BLIND, NEVER CLEAN — a population of pure exclusions exits 3',
    summarise([f31, manual, stale]),
    summarise([f31, manual, stale]).exit === EXIT_BLIND,
  );
  check(
    'PRECEDENCE — one WINDOW_EXPIRED outranks any number of SLOT_LOST rows',
    summarise([fc, e7, f52, expired]).verdict,
    summarise([fc, e7, f52, expired]).exit === EXIT_WINDOW_EXPIRED,
  );
  check(
    'PRECEDENCE — findings outrank an unreadable train (SLOT_LOST beats UNGRADED)',
    summarise([fc, e7, f31]).verdict,
    summarise([fc, e7, f31]).exit === EXIT_FINDINGS,
  );
  check(
    'UNGRADED — no findings but a DEPLOY TRAIN whose slot could not be read is exit 4, NOT clean',
    summarise([fc, f31]).verdict,
    summarise([fc, f31]).exit === EXIT_UNGRADED,
  );
  check(
    'UNGRADED NEGATIVE — an unreadable NON-train row does not downgrade a clean board',
    summarise([fc, tzMissing]).verdict,
    summarise([fc, tzMissing]).exit === EXIT_CLEAN && tzMissing.carrier !== 'train',
  );
  check('CLEAN — an on-time-only population is exit 0', summarise([fc, onTimeEdge]).verdict, summarise([fc, onTimeEdge]).exit === EXIT_CLEAN);

  // ⛔ A ONE-SIDED SUITE RUBBER-STAMPS A JAMMED DETECTOR. If a refactor collapses the
  // lattice into a constant, every arm above can still pass while a rung became
  // unreachable. Assert the suite REACHES every verdict and every exit code.
  const reachedVerdicts = new Set(
    [
      e7, f52, f31, fc, tzUtc, tzMissing, expired, held, inverted, justUnder, justOver, onTimeEdge,
      manual, stale, noRun, badTs, retired, bothFields, offCron, preCreation, preCreationOld,
      earlySeconds, weeklyReplay, trueEarly,
    ].map((r) => r.verdict),
  );
  const allVerdicts = [...GRADED_VERDICTS, ...EXCLUSION_VERDICTS];
  const missingVerdicts = allVerdicts.filter((v) => !reachedVerdicts.has(v));
  check(
    `COVERAGE — the control suite reaches all ${allVerdicts.length} verdicts; an unreached rung is a collapsed lattice`,
    { missing: missingVerdicts },
    missingVerdicts.length === 0,
  );
  const reachedExits = new Set(
    [summarise([f31]), summarise([fc, e7, f52, expired]), summarise([fc, e7]), summarise([fc, f31]), summarise([fc])].map((s) => s.exit),
  );
  const missingExits = [EXIT_CLEAN, EXIT_FINDINGS, EXIT_BLIND, EXIT_UNGRADED, EXIT_WINDOW_EXPIRED].filter((e) => !reachedExits.has(e));
  check('COVERAGE — every exit code in the lattice is reachable', { missing: missingExits }, missingExits.length === 0);

  return out;
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
const numFlag = (name, fallback) => {
  const v = flag(name);
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** ⛔ TRAP 1 of check:spent-oneshot: the routines route returns a BARE ARRAY. A filter that matches nothing reads exactly like a clean tree. */
function unwrapRoutines(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.routines)) return body.routines;
  if (Array.isArray(body?.data)) return body.data;
  return null;
}

const VERDICT_TAG = {
  WINDOW_EXPIRED: '[WINDOW EXPIRED — ran on reasoning that had already expired]',
  SLOT_LOST: '[SLOT LOST]',
  SLOT_LOST_WINDOW_HELD: '[SLOT LOST — window still held]',
  ORDER_DEADLINE_BEFORE_SLOT: '[ORDER UNMEETABLE — deadline precedes the slot]',
  FIRED_EARLY: '[FIRED EARLY — ran before its window opened]',
};

function printRow(r) {
  console.log(`[slot]   ${VERDICT_TAG[r.verdict] ?? `[${r.verdict}]`}  ${short(r.id)}  ${String(r.title).slice(0, 92)}`);
  console.log(`[slot]     ${r.detail}`);
  if (r.cron) console.log(`[slot]     cron ${JSON.stringify(r.cron)} (${r.tz}) · fired ${r.firedIso} · routine ${r.status} · carrier ${r.carrier}`);
}

async function main() {
  const controls = runControls();
  const bad = controls.filter((c) => !c.ok);
  for (const c of controls) console.log(`[slot] control ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
  if (bad.length > 0) {
    console.log('');
    console.log(`[slot] VERDICT = BLIND — ${bad.length} control(s) failed. The detector is broken, so its`);
    console.log('[slot] silence is worth nothing and no live verdict is printed.');
    for (const c of bad) console.log(`[slot]   FAILED: ${c.name}\n[slot]     got ${JSON.stringify(c.actual)}`);
    return EXIT_BLIND;
  }
  console.log(`[slot] ${controls.length}/${controls.length} controls pass, both directions.`);
  console.log('');

  if (flag('selftest')) {
    console.log('[slot] --selftest: controls only, no live sweep.');
    return EXIT_CLEAN;
  }

  const base = String(process.env.PAPERCLIP_API_URL || '').replace(/\/$/, '').replace(/\/api$/, '');
  const key = process.env.PAPERCLIP_API_KEY;
  const company = process.env.PAPERCLIP_COMPANY_ID;
  if (!base || !key || !company) {
    console.error('[slot] ERROR — PAPERCLIP_API_URL / PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID required.');
    return EXIT_ERROR;
  }

  const opts = {
    nowMs: Date.now(),
    windowDays: numFlag('window-days', DEFAULTS.windowDays),
    onTimeSec: numFlag('on-time-sec', DEFAULTS.onTimeSec),
    failMin: numFlag('fail-min', DEFAULTS.failMin),
    lookbackDays: numFlag('lookback-days', DEFAULTS.lookbackDays),
    drainWindowSec: numFlag('drain-window-sec', DEFAULTS.drainWindowSec),
    drainMin: numFlag('drain-min', DEFAULTS.drainMin),
  };

  let body;
  try {
    const res = await fetch(`${base}/api/companies/${company}/routines`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    console.log(`[slot] VERDICT = BLIND — the routines route is unreadable: ${err.message}`);
    console.log('[slot] An unreachable route is not an empty finding list.');
    return EXIT_BLIND;
  }

  const routines = unwrapRoutines(body);
  if (routines === null) {
    console.log('[slot] VERDICT = BLIND — the routines route served a shape this check does not recognise');
    console.log('[slot] (expected a bare array, or {routines}, or {data}). A filter that matches nothing reads as CLEAN.');
    return EXIT_BLIND;
  }
  if (routines.length === 0) {
    console.log('[slot] VERDICT = BLIND — the routines route served 0 rows.');
    return EXIT_BLIND;
  }

  const scope = typeof flag('routine') === 'string' ? flag('routine') : null;
  const population = scope ? routines.filter((r) => String(r?.id ?? '').startsWith(scope)) : routines;
  if (scope && population.length === 0) {
    console.log(`[slot] ERROR — no routine id starts with ${JSON.stringify(scope)}.`);
    return EXIT_ERROR;
  }

  const rows = population.map((r) => gradeRoutine(r, opts));
  const s = summarise(rows);

  console.log(
    `[slot] swept ${population.length} routine row(s)${scope ? ` (scoped to ${scope})` : ''} · window ${opts.windowDays}d on lastRun.triggeredAt` +
      ` · on-time <= ${opts.onTimeSec}s · fail >= ${opts.failMin}m`,
  );
  console.log(`[slot] graded ${s.graded.length} · excluded ${s.excluded.length} · findings ${s.findings.length}`);
  console.log('[slot] ⛔ NAMED BLIND SPOT: the list route carries ONE run per routine (lastRun, the newest).');
  console.log('[slot]   A routine whose newest fire was on time HIDES an older lost slot. This is a cap, not a sweep.');
  console.log('');

  // ⛔ EXCLUSIONS ARE PRINTED AT EVERY VERDICT INCLUDING CLEAN. A zero-exclusion run is a
  // blind run, not a clean one, and neither can be rated without the denominator.
  const byCause = new Map();
  for (const r of s.excluded) {
    const k = r.verdict === 'SLOT_UNREADABLE' ? `SLOT_UNREADABLE / ${r.cause}` : r.verdict;
    byCause.set(k, (byCause.get(k) ?? 0) + 1);
  }
  console.log(`[slot] EXCLUSIONS — ${s.excluded.length} row(s) not graded against a slot:`);
  if (byCause.size === 0) {
    console.log('[slot]   (none) — ⛔ a zero-exclusion sweep over a live fleet is a reason to distrust the');
    console.log('[slot]   population filter, not a reason to trust the verdict.');
  }
  for (const [k, n] of [...byCause.entries()].sort((a, b) => b[1] - a[1])) console.log(`[slot]   ${String(n).padStart(4)}  ${k}`);
  if (s.unreadableTrains.length > 0) {
    console.log('');
    console.log(`[slot] ⛔ ${s.unreadableTrains.length} of those are DEPLOY TRAINS whose slot could not be re-derived —`);
    console.log('[slot]   the urgent class, unmeasurable. Listed in full:');
    for (const r of s.unreadableTrains) {
      console.log(`[slot]     ${short(r.id)}  ${String(r.title).slice(0, 88)}`);
      console.log(`[slot]       ${r.cause} — ${r.detail}`);
    }
  }
  console.log('');

  const drift = s.graded.filter((r) => r.verdict === 'DRIFT');
  if (drift.length > 0) {
    console.log(`[slot] DRIFT — ${drift.length} fire(s) between ${opts.onTimeSec}s and ${opts.failMin}m late. Reported, not findings:`);
    for (const r of drift) console.log(`[slot]   ${short(r.id)}  ${humanGap(r.lagMs)} after ${r.slotIso}  ${String(r.title).slice(0, 70)}`);
    console.log('');
  }

  if (s.findings.length > 0) {
    const { clusters, singles } = clusterDrains(s.findings, opts);
    for (const c of clusters) {
      console.log(
        `[slot] ⛔ RESTART_DRAIN — ${c.members.length} lost slots replayed inside ${humanGap(c.lastMs - c.firstMs)} ` +
          `(${new Date(c.firstMs).toISOString()} → ${new Date(c.lastMs).toISOString()}).`,
      );
      console.log('[slot]   ONE process event, not ' + c.members.length + ' independent faults. The subject is the drain.');
      for (const r of c.members) printRow(r);
      console.log('');
    }
    if (singles.length > 0) {
      console.log(`[slot] ${singles.length} lost slot(s) that do NOT cluster into a drain:`);
      for (const r of singles) printRow(r);
      console.log('');
    }
  }

  switch (s.verdict) {
    case 'BLIND':
      console.log(`[slot] VERDICT = BLIND — ${s.reason}.`);
      return EXIT_BLIND;
    case 'WINDOW_EXPIRED':
      console.log(`[slot] VERDICT = WINDOW_EXPIRED — ${s.findings.filter((f) => f.verdict === 'WINDOW_EXPIRED').length} fire(s) executed`);
      console.log('[slot] PAST their own declared deadline. Their bodies’ time-scoped reasoning had already expired.');
      console.log('[slot] Repair: the ORDER must be re-issued against a live window — a late carrier must not be');
      console.log('[slot] re-run as written, because the embargo/freeze sentence it carries describes a hold that');
      console.log('[slot] no longer exists.');
      return EXIT_WINDOW_EXPIRED;
    case 'SLOT_LOST':
      console.log(`[slot] VERDICT = SLOT_LOST — ${s.findings.length} fire(s) missed their slot by >= ${opts.failMin}m.`);
      console.log('[slot] None of them landed past a DECLARED deadline, so whether their reasoning still held is');
      console.log('[slot] unknowable from data — which is itself the finding on any row carrying no deploy-order block.');
      return EXIT_FINDINGS;
    case 'UNGRADED':
      console.log(`[slot] VERDICT = UNGRADED — no lost slot among the ${s.graded.length} graded row(s), but`);
      console.log(`[slot] ${s.unreadableTrains.length} deploy train(s) could not be graded at all. The urgent class being`);
      console.log('[slot] unmeasurable is NOT the urgent class being fine.');
      return EXIT_UNGRADED;
    default:
      console.log(`[slot] VERDICT = CLEAN — all ${s.graded.length} graded fire(s) landed in their slot or inside the drift band,`);
      console.log(`[slot] and every deploy train in the population had a re-derivable slot. ${s.excluded.length} row(s) excluded, listed above.`);
      return EXIT_CLEAN;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[slot] ERROR', err?.stack || err);
    process.exit(EXIT_BLIND);
  });
