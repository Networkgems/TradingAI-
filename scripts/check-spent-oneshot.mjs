#!/usr/bin/env node
/**
 * TRA-3008 — detector for the ANNUAL-CRON ZOMBIE: a date-pinned one-shot that
 * has already fired, silently re-armed twelve months out, and still reads as
 * live scheduled coverage on every census.
 *
 * WHAT THE SHAPE IS
 * -----------------
 * A one-shot is written as a cron with the day and month pinned and NO YEAR
 * FIELD — `0 21 30 7 *` is "21:00 on 30 July", not "21:00 on 30 July 2026".
 * Cron has no year, so after the single intended fire the scheduler simply
 * recomputes the next slot: 2027-07-30T21:00Z. The routine stays
 * `status: active` with an `enabled` trigger and a `nextRunAt` in the future,
 * which is byte-for-byte the predicate `check:phantom-rest` (TRA-2422) clears a
 * leaf as monitored on, and the same one `check:routine-dispatch` (TRA-2331)
 * takes as its population.
 *
 * ⛔ A SPENT ONE-SHOT IS INDISTINGUISHABLE FROM ARMED COVERAGE ON THE BOARD.
 * That is the whole bug. Its fire is used up; nothing will run for ~12 months;
 * and every instrument we own reports it as scheduled.
 *
 * Measured 2026-08-05T23:50Z across 202 routines (41 active + armed): EIGHT
 * rows held an enabled trigger more than 120 days out. Two of them were graders
 * whose verdicts were never delivered — `c0ca474e` (TRA-2519 sentiment
 * partition) and `589334bc` (TRA-2477 supertrend wall-clock) — both dispatched
 * 2026-08-02T00:06Z, both died on `"Agent is not invokable in its current
 * state"`, both left `linkedIssueId: null`, so neither left ANY trace on the
 * issue it was meant to grade. TRA-2477 then sat `in_review` behind a routine
 * that would not speak again until July 2027.
 *
 * WHY `check:routine-dispatch` CANNOT SEE THIS
 * -------------------------------------------
 * That check grades the DISPATCH TAIL — did the last fire run? A spent one-shot
 * can have a perfectly `completed` last run (`48c5e5ee`, `63218280`,
 * `03a7b11f` all do). Its tail is healthy. It is the FORWARD promise that is a
 * lie, and a tail verdict cannot reach it. The two checks are complements:
 * TRA-2331 asks "did the fires stop dying?", this one asks "is the next fire
 * inside any horizon a human would call coverage?".
 *
 * THE PREDICATE
 * -------------
 * Population = every routine with `status: 'active'` AND at least one trigger
 * that is `enabled` with `kind: 'schedule'` — deliberately the same population
 * as `check:routine-dispatch`, so the two grade the same claim from both ends.
 *
 * For each armed trigger:
 *
 *   NEAR              `nextRunAt` within the horizon (default 120 days). This
 *                     is real coverage; say nothing about it.
 *   SPENT_ONESHOT     `nextRunAt` beyond the horizon AND `lastFiredAt` is set.
 *                     FINDING — it fired, and the slot it re-armed is a year
 *                     away. The single strongest signal in the set.
 *   FAR_NEVER_FIRED   `nextRunAt` beyond the horizon and it has NEVER fired.
 *                     FINDING — either a mis-entered cron or a routine whose
 *                     owner is gone (`e1b97e28`, assignee departed, next fire
 *                     2027-06-30, last run failed 2026-05-19).
 *
 * and roll that up per routine:
 *
 *   COVERAGE_LOST     EVERY armed trigger is beyond the horizon. Whatever this
 *                     routine was watching is unwatched, and the board says
 *                     otherwise.
 *   RESIDUAL_ZOMBIE   at least one armed trigger is still NEAR. Coverage is
 *                     intact; the spent trigger is dead weight that will fire
 *                     once, a year from now, with no one expecting it.
 *                     `41c0c68d` is exactly this: a spent 2026-08-05 one-shot
 *                     riding alongside a live weekly Friday review.
 *
 * THE TRAPS — each measured against the live API on 2026-08-05, each with a
 * control in `--selftest`
 * ------------------------------------------------------------------------
 *  1. ⛔⛔ THE ROUTINES ROUTE RETURNS A BARE ARRAY. The first run of this
 *     census read `body.routines` — `undefined` on a bare array — filtered it
 *     to nothing, and reported **`0` zombies against a company that had eight**.
 *     A FILTER THAT MATCHES NOTHING READS EXACTLY LIKE A CLEAN TREE. The unwrap
 *     here accepts array | {routines} | {data} and NOTHING else, and the row
 *     count actually graded is printed on every run.
 *
 *  2. ⛔ ZERO ROWS SCANNED IS BLIND, NOT CLEAN — the direct consequence of
 *     trap 1, and the only defence that survives the next shape change. An
 *     empty population exits 3 and never prints a verdict.
 *
 *  3. ⛔⛔ ARCHIVING A ROUTINE DOES NOT DISABLE ITS TRIGGER. Measured on
 *     `c0ca474e` minutes after I archived it: `status: 'archived'`, and the
 *     trigger STILL reads `enabled: true`, `nextRunAt: 2027-07-31T00:10Z`. A
 *     check keyed on `trigger.enabled` alone therefore reports every routine
 *     ever archived, forever, and the real findings drown. `status === 'active'`
 *     is the discriminator and it is not optional. (It also means archiving IS a
 *     sufficient remedy — but ONLY on a COVERAGE_LOST row. See trap 8.)
 *
 *  8. ⛔⛔ THE REMEDY IS NOT THE SAME FOR THE TWO VERDICTS, AND PRINTING THE
 *     WRONG ONE DESTROYS LIVE COVERAGE (TRA-3018). This report used to emit
 *     "Remedy: ARCHIVE the routine" unconditionally on any non-CLEAN verdict —
 *     six lines after telling the reader that a RESIDUAL_ZOMBIE row still has
 *     `nearCount` live arms. Archiving takes those arms down with the spent one,
 *     which is exactly the distinction the RESIDUAL_ZOMBIE / COVERAGE_LOST split
 *     was built to make; the remedy line threw it away. It was live-relevant:
 *     `41c0c68d` held a spent annual one-shot AND the weekly Friday TRA-2879
 *     disarm review, and archiving it would have silently retired an active
 *     live-sleeve tripwire. The remedy is now derived PER FINDING:
 *       COVERAGE_LOST   → archive the routine (nothing live is on it)
 *       RESIDUAL_ZOMBIE → disable the SPENT TRIGGER ONLY, by id:
 *                         `PATCH /api/routine-triggers/{triggerId} {"enabled":false}`
 *                         ⛔ the nested `/api/routines/{rid}/triggers/{tid}`
 *                            spelling is 404. The FLAT route is the one that works.
 *                         ⛔ `enabled:false` does NOT clear `nextRunAt` — the
 *                            trigger keeps its 2027 slot after a successful
 *                            write. READ BACK `enabled`, never `nextRunAt`. This
 *                            check goes clean because it filters the population
 *                            on `enabled === true` BEFORE it looks at the
 *                            horizon; a census keyed on horizon alone will still
 *                            flag the row.
 *
 *  4. ⛔ `nextRunAt` AND `lastFiredAt` LIVE ON `triggers[]`, NOT THE ROUTINE
 *     ROOT (TRA-2422 trap 2). A root-level read of either returns `undefined`
 *     on a perfectly armed routine — and `undefined > horizon` is `false`, so
 *     the bug reads as CLEAN.
 *
 *  5. ⛔ A MISSING OR UNPARSEABLE `nextRunAt` ON AN ENABLED TRIGGER IS BLIND,
 *     NOT NEAR. "no next run" is the most spent a trigger can possibly be;
 *     absorbing it into the healthy branch inverts the check on its worst case.
 *
 *  6. ⛔ NON-SCHEDULE AND DISABLED TRIGGERS ARE NOT ARMING. A webhook trigger
 *     has no slot; a disabled one fires never. Excluded from the population
 *     rather than counted as healthy members of it.
 *
 *  7. ⛔ A SECOND, NEARER TRIGGER IS REAL COVERAGE. Reporting `41c0c68d` as
 *     "unwatched" because one of its two arms is spent would be a false breach,
 *     and false breaches are how a check gets ignored. Hence the two-tier
 *     roll-up.
 *
 * WHY 120 DAYS
 * ------------
 * The horizon separates "annual re-arm" from "genuinely long cadence". The
 * longest legitimate cadence on this board is quarterly (~92 days), and every
 * observed zombie sits at ~365 days. 120 days is the widest bar that still
 * catches all eight and cannot clip a quarterly. Tunable with `--horizon-days`;
 * widening it can only ever shrink the finding set, so a caller cannot use it
 * to manufacture one.
 *
 * VERDICTS / EXIT CODES
 *   0  CLEAN             — population non-empty, every armed trigger fires inside the horizon
 *   0  ACKNOWLEDGED_ONLY — every remaining finding is in the acknowledgement ledger. File NOTHING.
 *   1  FINDINGS          — spent arms exist, but every affected routine still has live coverage
 *   2  COVERAGE_LOST     — at least one routine's ONLY arms are beyond the horizon
 *   3  BLIND             — the population or a row is untrustworthy. NOT a pass.
 *
 * BLIND outranks everything, including a zero count.
 *
 * ⛔ WHY AN ACKNOWLEDGEMENT LEDGER EXISTS (TRA-3017)
 * -------------------------------------------------
 * This check is armed DAILY (routine `efd820ff`), and the prose it runs under
 * says "file ONE issue on exit != 0". Two of the coverage-lost rows CANNOT be
 * repaired by the agent running the check: routine writes follow the ASSIGNEE
 * and 403 across agents, and `e1b97e28`'s assignee has DEPARTED, so no agent on
 * this board can archive it at all — it needs a BOARD re-home. Left alone, the
 * daily fire mints a duplicate issue for the same two rows every morning until
 * someone archives the checker. That is the failure mode this check's own
 * sibling (`check:strands`) already warns about in prose: a checker that files
 * on every fire becomes noise, and the noise is what gets it retired.
 *
 * The ledger (`scripts/spent-oneshot-acknowledged.json`, HAND-EDITED ONLY)
 * SUPPRESSES THE EXIT CODE AND NOTHING ELSE:
 *   · acknowledged rows are still printed IN FULL on every run, under their own
 *     heading — the ledger can never make a finding invisible;
 *   · every entry must name a live `trackedBy` issue and a `reason`. An entry
 *     missing either is IGNORED and warned about — an acknowledgement with no
 *     owner is a deletion with extra steps;
 *   · an entry is pinned to the `cronExpression` + `nextRunAt` of EVERY spent
 *     trigger on the row. Re-arm it, move its slot, or grow a second spent
 *     trigger and the pin stops matching, so the row is a LIVE finding again;
 *   · an entry that matches nothing is reported as STALE_ACK. It is not
 *     exit-bearing (by construction it is suppressing nothing), but it is loud.
 *   · an unreadable or unparseable ledger degrades to ZERO acknowledgements,
 *     never to "everything is acknowledged" — the failure direction is MORE
 *     filing, not less.
 *
 * This script performs GETs and NOTHING else.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enumerateRoutines } from './lib/paperclip-enumeration.mjs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
};

const HORIZON_DAYS = Number(argOf('horizon-days', 120));
const ROUTINE_LIMIT = Number(argOf('routine-limit', 500));

export const VERDICT_EXIT = { CLEAN: 0, ACKNOWLEDGED_ONLY: 0, FINDINGS: 1, COVERAGE_LOST: 2, BLIND: 3 };

export const ACK_PATH = argOf('ack-file', fileURLToPath(new URL('./spent-oneshot-acknowledged.json', import.meta.url)));

/* ------------------------------------------------------------------ *
 * Acknowledgement ledger
 * ------------------------------------------------------------------ */

/**
 * Read the hand-edited ledger. NEVER throws: an unreadable or malformed file
 * degrades to zero acknowledgements (⇒ more filing, never less) plus a loud
 * warning. Entries missing `trackedBy` or `reason` are dropped the same way.
 */
export function loadAcknowledgements(path = ACK_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { acks: [], warnings: [`acknowledgement ledger unreadable (${err.code || err.message}) — treating as ZERO acknowledgements`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { acks: [], warnings: [`acknowledgement ledger is not valid JSON (${err.message}) — treating as ZERO acknowledgements`] };
  }
  return parseAcknowledgements(parsed);
}

/** The validator half of {@link loadAcknowledgements}, split out so the controls can drive it. */
export function parseAcknowledgements(parsed) {
  const warnings = [];
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.acknowledged) ? parsed.acknowledged : null;
  if (rows === null) {
    return { acks: [], warnings: ['acknowledgement ledger has no `acknowledged` array — treating as ZERO acknowledgements'] };
  }
  const acks = [];
  for (const [i, r] of rows.entries()) {
    if (!r || typeof r.routineId !== 'string' || !r.routineId) {
      warnings.push(`ledger entry #${i} has no routineId — IGNORED`);
      continue;
    }
    // An acknowledgement with no owner is a deletion with extra steps.
    if (!r.trackedBy || !r.reason) {
      warnings.push(`ledger entry ${r.routineId.slice(0, 8)} is missing trackedBy and/or reason — IGNORED (it suppresses nothing)`);
      continue;
    }
    if (!Array.isArray(r.spent) || r.spent.length === 0) {
      warnings.push(`ledger entry ${r.routineId.slice(0, 8)} has no pinned \`spent\` triggers — IGNORED (an unpinned ack never expires)`);
      continue;
    }
    acks.push({ ...r, used: false });
  }
  return { acks, warnings };
}

const sig = (t) => `${t.cronExpression ?? null}@${t.nextRunAt ?? null}`;

/**
 * A ledger entry covers a finding only if EVERY spent trigger currently on the
 * row was pinned in the entry. Grow a new spent arm, or let the slot move, and
 * the pin stops matching — the row becomes live again on its own.
 */
export function ackFor(finding, acks) {
  for (const a of acks) {
    if (a.routineId !== finding.routineId) continue;
    const pinned = new Set(a.spent.map(sig));
    if (finding.spent.every((s) => pinned.has(sig(s)))) {
      a.used = true;
      return a;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Predicate
 * ------------------------------------------------------------------ */

/** Enabled schedule triggers only. Trap 6. */
export function armedTriggers(routine) {
  const triggers = routine.triggers;
  if (!Array.isArray(triggers)) return null; // caller turns this into BLIND
  return triggers.filter((t) => t && t.enabled === true && t.kind === 'schedule');
}

/**
 * Classify ONE armed trigger against the horizon.
 * Returns { state, detail, daysOut } — state is NEAR / SPENT_ONESHOT /
 * FAR_NEVER_FIRED / BLIND.
 */
export function classifyTrigger(trigger, { nowMs, horizonDays = HORIZON_DAYS }) {
  // Trap 5. Absent is not near.
  if (!('nextRunAt' in trigger)) {
    return { state: 'BLIND', detail: 'trigger carries no `nextRunAt` key — the route did not serve the field' };
  }
  if (trigger.nextRunAt == null || trigger.nextRunAt === '') {
    return {
      state: 'BLIND',
      detail:
        'enabled schedule trigger with a null `nextRunAt` — an armed trigger with no next slot is the most spent ' +
        'state there is; it is never a pass',
    };
  }
  const nextMs = Date.parse(trigger.nextRunAt);
  if (!Number.isFinite(nextMs)) {
    return { state: 'BLIND', detail: `unparseable nextRunAt ${JSON.stringify(trigger.nextRunAt)}` };
  }

  const daysOut = (nextMs - nowMs) / 86_400_000;
  if (daysOut <= horizonDays) return { state: 'NEAR', daysOut };

  const fired = typeof trigger.lastFiredAt === 'string' && trigger.lastFiredAt !== '';
  return fired
    ? {
        state: 'SPENT_ONESHOT',
        daysOut,
        detail:
          `fired ${trigger.lastFiredAt} and re-armed ${daysOut.toFixed(0)}d out ` +
          `(cron ${JSON.stringify(trigger.cronExpression ?? null)} has no year field)`,
      }
    : {
        state: 'FAR_NEVER_FIRED',
        daysOut,
        detail:
          `never fired, next slot ${daysOut.toFixed(0)}d out ` +
          `(cron ${JSON.stringify(trigger.cronExpression ?? null)})`,
      };
}

/** Roll one routine's armed triggers up into a routine-level verdict. */
export function classifyRoutine(routine, { nowMs, horizonDays = HORIZON_DAYS }) {
  const armed = armedTriggers(routine);
  if (armed === null) {
    return { state: 'BLIND', detail: 'row carries no `triggers` array — the route did not serve the relation' };
  }
  if (armed.length === 0) return { state: 'NOT_IN_POPULATION' };

  const graded = armed.map((t) => ({ trigger: t, ...classifyTrigger(t, { nowMs, horizonDays }) }));
  const blind = graded.filter((g) => g.state === 'BLIND');
  if (blind.length) {
    return { state: 'BLIND', detail: blind.map((b) => b.detail).join(' · '), triggers: graded };
  }

  const far = graded.filter((g) => g.state === 'SPENT_ONESHOT' || g.state === 'FAR_NEVER_FIRED');
  if (far.length === 0) return { state: 'HEALTHY', triggers: graded };

  const near = graded.filter((g) => g.state === 'NEAR');
  // Trap 7 — a nearer arm on the same routine IS coverage.
  return {
    state: near.length ? 'RESIDUAL_ZOMBIE' : 'COVERAGE_LOST',
    triggers: graded,
    far,
    nearCount: near.length,
  };
}

/* ------------------------------------------------------------------ *
 * Sweep
 * ------------------------------------------------------------------ */

export async function sweep(
  transport,
  { routineLimit = ROUTINE_LIMIT, horizonDays = HORIZON_DAYS, nowMs = Date.now(), acks = [], ackWarnings = [] } = {},
) {
  const { routines, blind: enumBlind, probe } = await enumerateRoutines(transport.getRoutines, { limit: routineLimit });
  if (enumBlind) {
    return { verdict: 'BLIND', blind: enumBlind, routineCount: 0, graded: 0, findings: [], acknowledged: [], staleAcks: [], ackWarnings, blindRows: [], tally: {} };
  }

  const findings = [];
  const blindRows = [];
  const tally = { HEALTHY: 0, RESIDUAL_ZOMBIE: 0, COVERAGE_LOST: 0, BLIND: 0 };
  let graded = 0;

  for (const r of routines) {
    // Trap 3 — an archived routine keeps its enabled trigger and its 2027
    // nextRunAt forever. `status` is the discriminator, not `enabled`.
    if (r.status !== 'active') continue;
    const verdict = classifyRoutine(r, { nowMs, horizonDays });
    if (verdict.state === 'NOT_IN_POPULATION') continue;
    graded += 1;
    tally[verdict.state] = (tally[verdict.state] ?? 0) + 1;

    const row = {
      id: String(r.id).slice(0, 8),
      routineId: r.id,
      title: r.title,
      assigneeAgentId: r.assigneeAgentId ?? null,
      state: verdict.state,
    };
    if (verdict.state === 'BLIND') blindRows.push({ ...row, detail: verdict.detail });
    else if (verdict.state !== 'HEALTHY') {
      findings.push({
        ...row,
        nearCount: verdict.nearCount,
        lastRunStatus: r.lastRun ? (r.lastRun.status ?? null) : null,
        spent: verdict.far.map((f) => ({
          state: f.state,
          // Trap 8 — the surgical remedy PATCHes a trigger BY ID. A finding that
          // cannot name the id can only be repaired with the blunt instrument.
          triggerId: f.trigger.id ?? null,
          label: f.trigger.label ?? null,
          cronExpression: f.trigger.cronExpression ?? null,
          timezone: f.trigger.timezone ?? null,
          nextRunAt: f.trigger.nextRunAt,
          lastFiredAt: f.trigger.lastFiredAt ?? null,
          lastResult: f.trigger.lastResult ?? null,
          daysOut: Math.round(f.daysOut),
          detail: f.detail,
        })),
      });
    }
  }

  // Trap 2. Zero graded rows is BLIND, and it is the exact way this census
  // failed the first time it was run.
  if (graded === 0) {
    return {
      verdict: 'BLIND',
      blind:
        `${routines.length} routines enumerated but ZERO were active with an enabled schedule trigger. ` +
        'An empty population and a broken predicate render identically, and the empty one always reads CLEAN. ' +
        'Re-derive the predicate before trusting this.',
      routineCount: routines.length,
      graded: 0,
      findings: [],
      acknowledged: [],
      staleAcks: [],
      ackWarnings,
      blindRows,
      tally,
      probe,
    };
  }

  // Ledger pass. Suppresses the EXIT CODE only — every acknowledged row is
  // still returned and still printed.
  const live = [];
  const acknowledged = [];
  for (const f of findings) {
    const a = ackFor(f, acks);
    if (a) acknowledged.push({ ...f, acknowledgedBy: { trackedBy: a.trackedBy, reason: a.reason, acknowledgedAt: a.acknowledgedAt ?? null } });
    else live.push(f);
  }
  const staleAcks = acks.filter((a) => !a.used).map((a) => ({ routineId: a.routineId, trackedBy: a.trackedBy }));

  let verdict = 'CLEAN';
  if (blindRows.length) verdict = 'BLIND';
  else if (live.some((f) => f.state === 'COVERAGE_LOST')) verdict = 'COVERAGE_LOST';
  else if (live.length) verdict = 'FINDINGS';
  else if (acknowledged.length) verdict = 'ACKNOWLEDGED_ONLY';

  return {
    verdict,
    blind: null,
    routineCount: routines.length,
    graded,
    findings: live,
    acknowledged,
    staleAcks,
    ackWarnings,
    blindRows,
    tally,
    probe,
    horizonDays,
  };
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

export function renderReport(result, names = {}) {
  const out = [];
  const who = (id) => (id ? names[String(id).slice(0, 8)] || String(id).slice(0, 8) : '(unassigned)');
  out.push(`check:spent-oneshot — TRA-3008 · horizon ${result.horizonDays ?? HORIZON_DAYS}d`);
  out.push(`  routines enumerated : ${result.routineCount}`);
  out.push(`  active + armed      : ${result.graded}`);
  if (result.blind) {
    out.push('');
    out.push(`VERDICT: BLIND — ${result.blind}`);
    return out;
  }
  out.push(
    `  tally               : healthy ${result.tally.HEALTHY ?? 0} · residual ${result.tally.RESIDUAL_ZOMBIE ?? 0} ` +
      `· coverage-lost ${result.tally.COVERAGE_LOST ?? 0} · blind ${result.tally.BLIND ?? 0}`,
  );
  out.push(`  of those, acknowledged: ${(result.acknowledged ?? []).length} (printed below; suppresses the EXIT CODE only)`);
  out.push('');
  for (const w of result.ackWarnings ?? []) out.push(`⚠️  LEDGER  ${w}`);
  if ((result.ackWarnings ?? []).length) out.push('');
  for (const f of result.findings) {
    out.push(`${f.state === 'COVERAGE_LOST' ? '⛔' : '⚠️ '} ${f.id}  ${who(f.assigneeAgentId)}  ${f.title}`);
    for (const s of f.spent) {
      out.push(`      ${s.state}  next ${s.nextRunAt} (${s.daysOut}d)  cron ${s.cronExpression} ${s.timezone ?? ''}`);
      out.push(`      ${s.detail}`);
      if (s.lastResult) out.push(`      last result: ${s.lastResult}`);
    }
    if (f.state === 'RESIDUAL_ZOMBIE') out.push(`      ${f.nearCount} nearer arm(s) still cover this routine.`);
    out.push('');
  }
  for (const b of result.blindRows) out.push(`BLIND  ${b.id}  ${who(b.assigneeAgentId)}  ${b.title}\n      ${b.detail}`);

  if ((result.acknowledged ?? []).length) {
    out.push('── ACKNOWLEDGED (real findings, already owned elsewhere — DO NOT FILE) ──');
    for (const f of result.acknowledged) {
      out.push(`   ${f.state === 'COVERAGE_LOST' ? '⛔' : '⚠️ '} ${f.id}  ${who(f.assigneeAgentId)}  ${f.title}`);
      for (const s of f.spent) out.push(`        ${s.state}  next ${s.nextRunAt} (${s.daysOut}d)  cron ${s.cronExpression} ${s.timezone ?? ''}`);
      out.push(`        tracked by ${f.acknowledgedBy.trackedBy} — ${f.acknowledgedBy.reason}`);
    }
    out.push('');
  }
  for (const s of result.staleAcks ?? []) {
    out.push(`⚠️  STALE_ACK  ${s.routineId.slice(0, 8)} (tracked by ${s.trackedBy}) matched no finding — the row is fixed or re-armed. Trim the ledger.`);
  }
  if ((result.staleAcks ?? []).length) out.push('');

  out.push(`VERDICT: ${result.verdict}`);
  if (result.verdict === 'ACKNOWLEDGED_ONLY') {
    out.push('Every remaining finding is in scripts/spent-oneshot-acknowledged.json with a live owner. File NOTHING.');
    out.push('This is exit 0 because the repair is already owned, NOT because coverage is intact — read the block above.');
  }
  if (result.verdict !== 'CLEAN' && result.verdict !== 'ACKNOWLEDGED_ONLY' && result.verdict !== 'BLIND') {
    out.push(...remedyLines(result.findings ?? []));
  }
  return out;
}

export const ARCHIVE_REMEDY = 'ARCHIVE the routine';
export const SURGICAL_REMEDY = 'PATCH /api/routine-triggers/{triggerId}';

/**
 * Trap 8 (TRA-3018). The remedy is derived PER FINDING from its own verdict —
 * never printed once for the whole run.
 *
 * ⛔ The archive line must NEVER appear on a run whose only findings are
 * RESIDUAL_ZOMBIE: those rows have live arms and archiving takes them down. The
 * `--selftest` controls assert both directions, and mutate this function back to
 * the unconditional v1 text to prove they discriminate.
 */
export function remedyLines(findings) {
  const out = [];
  const lost = findings.filter((f) => f.state === 'COVERAGE_LOST');
  const residual = findings.filter((f) => f.state === 'RESIDUAL_ZOMBIE');

  if (lost.length) {
    out.push(`Remedy · COVERAGE_LOST (${lost.length} row(s)): ${ARCHIVE_REMEDY}.`);
    out.push('      Every armed trigger on these rows is beyond the horizon, so archiving retires nothing live.');
    out.push('      Trap 3 — the trigger keeps `enabled:true` and its 2027 nextRunAt afterwards; that is fine once `status !== "active"`.');
    for (const f of lost) out.push(`      archive ${f.id}  ${f.title}`);
  }

  if (residual.length) {
    const near = residual.reduce((n, f) => n + (f.nearCount ?? 0), 0);
    if (lost.length) out.push('');
    out.push(`Remedy · RESIDUAL_ZOMBIE (${residual.length} row(s)): ⛔ DO NOT ARCHIVE THESE.`);
    out.push(`      ${near} nearer arm(s) across them are LIVE coverage and archiving takes those down with the spent one`);
    out.push('      (41c0c68d held a spent annual one-shot AND the weekly TRA-2879 disarm review — TRA-3018).');
    out.push(`      Disable the SPENT TRIGGER ONLY:  ${SURGICAL_REMEDY}  {"enabled": false}  → 200`);
    out.push('      ⛔ the nested /api/routines/{routineId}/triggers/{triggerId} spelling is 404. Use the FLAT route.');
    for (const f of residual) {
      for (const s of f.spent) {
        out.push(
          s.triggerId
            ? `      disable trigger ${s.triggerId}  (${f.id} ${f.title} — ${s.state}, next ${s.nextRunAt})`
            : `      ⚠️  ${f.id} ${f.title}: this route served no trigger id — re-GET /api/routines/${f.routineId} for it. DO NOT fall back to archiving.`,
        );
      }
    }
    out.push('      ⛔ `enabled:false` does NOT clear `nextRunAt` — the trigger still reads its far slot after a successful');
    out.push('      write. READ BACK `enabled`, never `nextRunAt`. This check clears the row because it filters on');
    out.push('      `enabled === true` before the horizon; any census keyed on horizon alone will still flag it.');
  }

  out.push("Routine writes follow the ASSIGNEE and 403 across agents — relay a carrier, do not sweep another owner's row.");
  return out;
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

const NOW = Date.parse('2026-08-05T23:50:00Z');
const SPENT_TRIGGER_ID = '11111111-spent-trigger';
const NEAR_TRIGGER_ID = '22222222-near-trigger';
const far = (over = {}) => ({
  id: 'aaaaaaaa-0000-0000-0000-000000000000',
  status: 'active',
  title: 'far',
  assigneeAgentId: 'agent-1',
  triggers: [
    {
      id: SPENT_TRIGGER_ID,
      kind: 'schedule',
      enabled: true,
      cronExpression: '0 21 30 7 *',
      timezone: 'UTC',
      nextRunAt: '2027-07-30T21:00:00.000Z',
      lastFiredAt: '2026-08-02T00:06:25.499Z',
      lastResult: 'Execution failed',
      ...over,
    },
  ],
  lastRun: { status: 'failed' },
});

const CASES = [
  {
    name: 'SPENT_ONESHOT — fired once, re-armed 359d out (589334bc verbatim)',
    routines: [far()],
    expect: { verdict: 'COVERAGE_LOST', findings: 1 },
  },
  {
    name: 'FAR_NEVER_FIRED — 2027 slot, never fired (e1b97e28 shape)',
    routines: [far({ nextRunAt: '2027-06-30T17:17:00.000Z', lastFiredAt: null, lastResult: null })],
    expect: { verdict: 'COVERAGE_LOST', findings: 1, state: 'FAR_NEVER_FIRED' },
  },
  {
    name: 'TRAP 7 — a nearer arm on the same routine is real coverage (41c0c68d)',
    routines: [
      {
        ...far(),
        triggers: [
          far().triggers[0],
          {
            id: NEAR_TRIGGER_ID,
            kind: 'schedule',
            enabled: true,
            cronExpression: '15 17 * * 5',
            timezone: 'America/New_York',
            nextRunAt: '2026-08-07T21:15:00.000Z',
            lastFiredAt: null,
          },
        ],
      },
    ],
    expect: { verdict: 'FINDINGS', findings: 1, state: 'RESIDUAL_ZOMBIE' },
  },
  {
    name: 'TRAP 3 — an ARCHIVED routine keeps enabled:true + a 2027 nextRunAt and must NOT be a finding (c0ca474e)',
    routines: [{ ...far(), status: 'archived' }, { ...far(), id: 'bbbbbbbb', triggers: [{ ...far().triggers[0], nextRunAt: '2026-08-06T21:00:00.000Z' }] }],
    expect: { verdict: 'CLEAN', findings: 0, graded: 1 },
  },
  {
    name: 'TRAP 6 — a disabled trigger and a webhook trigger are not arming',
    routines: [
      { ...far(), triggers: [{ ...far().triggers[0], enabled: false }] },
      { ...far(), id: 'cccccccc', triggers: [{ ...far().triggers[0], kind: 'webhook' }] },
      { ...far(), id: 'dddddddd', triggers: [{ ...far().triggers[0], nextRunAt: '2026-08-06T21:00:00.000Z' }] },
    ],
    expect: { verdict: 'CLEAN', findings: 0, graded: 1 },
  },
  {
    name: 'TRAP 5 — an enabled trigger with a null nextRunAt is BLIND, never NEAR',
    routines: [far({ nextRunAt: null })],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 4 — nextRunAt read off the ROUTINE ROOT is absent on the trigger => BLIND',
    routines: [
      {
        ...far(),
        nextRunAt: '2027-07-30T21:00:00.000Z',
        triggers: [{ kind: 'schedule', enabled: true, cronExpression: '0 21 30 7 *', lastFiredAt: '2026-08-02T00:06:25Z' }],
      },
    ],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'CLEAN — a live weekly routine inside the horizon',
    routines: [
      {
        ...far(),
        triggers: [
          {
            kind: 'schedule',
            enabled: true,
            cronExpression: '15 17 * * 5',
            timezone: 'America/New_York',
            nextRunAt: '2026-08-07T21:15:00.000Z',
            lastFiredAt: '2026-07-31T21:15:00.000Z',
          },
        ],
      },
    ],
    expect: { verdict: 'CLEAN', findings: 0 },
  },
  {
    name: 'TRAP 1/2 — the ACTUAL census bug: the route returns a BARE ARRAY and the filter read `.routines`',
    // Simulates what the first census run did: unwrap to undefined -> [] -> a
    // clean-looking zero. The population must come back BLIND, not CLEAN.
    routines: [],
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'TRAP 2 — 202 routines, none active+armed => BLIND on graded=0, not CLEAN',
    routines: Array.from({ length: 202 }, (_, i) => ({ ...far(), id: `e${i}`, status: 'paused' })),
    expect: { verdict: 'BLIND', graded: 0 },
  },

  /* --- acknowledgement ledger (TRA-3017) --------------------------- */
  {
    name: 'ACK — a pinned, owned entry moves a COVERAGE_LOST row to ACKNOWLEDGED_ONLY (exit 0, file nothing)',
    routines: [far()],
    ledger: [{ routineId: far().id, spent: [{ cronExpression: '0 21 30 7 *', nextRunAt: '2027-07-30T21:00:00.000Z' }], trackedBy: 'TRA-3015', reason: 'owner boundary' }],
    expect: { verdict: 'ACKNOWLEDGED_ONLY', findings: 0, acknowledged: 1 },
  },
  {
    name: 'ACK EXPIRES — the row re-armed to a slot the ledger never pinned, so it is LIVE again',
    routines: [far({ nextRunAt: '2028-07-30T21:00:00.000Z' })],
    ledger: [{ routineId: far().id, spent: [{ cronExpression: '0 21 30 7 *', nextRunAt: '2027-07-30T21:00:00.000Z' }], trackedBy: 'TRA-3015', reason: 'owner boundary' }],
    expect: { verdict: 'COVERAGE_LOST', findings: 1, acknowledged: 0 },
  },
  {
    name: 'ACK EXPIRES — a SECOND spent arm appears that the ledger never pinned => LIVE again',
    routines: [
      {
        ...far(),
        triggers: [
          far().triggers[0],
          { kind: 'schedule', enabled: true, cronExpression: '0 9 1 1 *', timezone: 'UTC', nextRunAt: '2027-01-01T09:00:00.000Z', lastFiredAt: null },
        ],
      },
    ],
    ledger: [{ routineId: far().id, spent: [{ cronExpression: '0 21 30 7 *', nextRunAt: '2027-07-30T21:00:00.000Z' }], trackedBy: 'TRA-3015', reason: 'owner boundary' }],
    expect: { verdict: 'COVERAGE_LOST', findings: 1, acknowledged: 0 },
  },
  {
    name: 'ACK IS ROW-SCOPED — an entry for one routine must not cover an identical-looking NEW one',
    routines: [far(), { ...far(), id: 'ffffffff-0000-0000-0000-000000000000' }],
    ledger: [{ routineId: far().id, spent: [{ cronExpression: '0 21 30 7 *', nextRunAt: '2027-07-30T21:00:00.000Z' }], trackedBy: 'TRA-3015', reason: 'owner boundary' }],
    expect: { verdict: 'COVERAGE_LOST', findings: 1, acknowledged: 1 },
  },
  {
    name: 'ACK WITHOUT AN OWNER IS IGNORED — no trackedBy/reason means it suppresses nothing',
    routines: [far()],
    ledger: [{ routineId: far().id, spent: [{ cronExpression: '0 21 30 7 *', nextRunAt: '2027-07-30T21:00:00.000Z' }] }],
    expect: { verdict: 'COVERAGE_LOST', findings: 1, acknowledged: 0, ackWarnings: 1 },
  },
  {
    name: 'ACK WITHOUT A PIN IS IGNORED — an unpinned entry would never expire',
    routines: [far()],
    ledger: [{ routineId: far().id, trackedBy: 'TRA-3015', reason: 'owner boundary' }],
    expect: { verdict: 'COVERAGE_LOST', findings: 1, acknowledged: 0, ackWarnings: 1 },
  },
  {
    name: 'STALE_ACK — the ledger entry matched nothing (row archived/repaired); reported, never exit-bearing',
    routines: [{ ...far(), status: 'archived' }, { ...far(), id: 'bbbbbbbb', triggers: [{ ...far().triggers[0], nextRunAt: '2026-08-06T21:00:00.000Z' }] }],
    ledger: [{ routineId: far().id, spent: [{ cronExpression: '0 21 30 7 *', nextRunAt: '2027-07-30T21:00:00.000Z' }], trackedBy: 'TRA-3015', reason: 'owner boundary' }],
    expect: { verdict: 'CLEAN', findings: 0, acknowledged: 0, staleAcks: 1 },
  },
  {
    name: 'ACK CANNOT SUPPRESS BLIND — a BLIND row outranks a fully acknowledged population',
    routines: [far({ nextRunAt: null })],
    ledger: [{ routineId: far().id, spent: [{ cronExpression: '0 21 30 7 *', nextRunAt: '2027-07-30T21:00:00.000Z' }], trackedBy: 'TRA-3015', reason: 'owner boundary' }],
    expect: { verdict: 'BLIND' },
  },
];

/* --- trap 8: the REMEDY LINE itself is an instrument (TRA-3018) ----- *
 *
 * The v1 report printed "ARCHIVE the routine" on every non-CLEAN verdict, six
 * lines after announcing that a RESIDUAL_ZOMBIE row still had live arms. These
 * controls grade the remedy TEXT end-to-end through renderReport, in both
 * directions, and the last one MUTATES the remedy back to v1 to prove they can
 * actually fail. A control that passes against the defect it grades is not a
 * control.
 */

const residualRoutine = () => ({
  ...far(),
  id: 'cccccccc-0000-0000-0000-000000000000',
  title: 'spent annual one-shot RIDING A LIVE WEEKLY REVIEW (41c0c68d shape)',
  triggers: [
    far().triggers[0],
    {
      id: NEAR_TRIGGER_ID,
      kind: 'schedule',
      enabled: true,
      cronExpression: '15 17 * * 5',
      timezone: 'America/New_York',
      nextRunAt: '2026-08-07T21:15:00.000Z',
      lastFiredAt: null,
    },
  ],
});
const lostRoutine = () => ({ ...far(), title: 'only arm is spent (589334bc shape)' });

/** Re-render a result with the remedy block swapped — the mutation hook. */
const renderWith = (result, remedyFn) => {
  const lines = renderReport(result);
  const cut = lines.indexOf(`VERDICT: ${result.verdict}`);
  return [...lines.slice(0, cut + 1), ...remedyFn(result.findings)].join('\n');
};

/** The v1 remedy, verbatim. Only ever used as a mutation. */
const REMEDY_V1 = () => [
  'Remedy: ARCHIVE the routine (trap 3 — that is enough; the trigger stays enabled and it does not matter).',
  "Routine writes follow the ASSIGNEE and 403 across agents — relay a carrier, do not sweep another owner's row.",
];

const assertResidual = (text) => {
  const p = [];
  if (text.includes(ARCHIVE_REMEDY)) p.push('⛔ told the reader to ARCHIVE a row that still holds live arms');
  if (!text.includes(SURGICAL_REMEDY)) p.push('no surgical trigger-PATCH remedy offered');
  if (!text.includes(SPENT_TRIGGER_ID)) p.push('the spent trigger id was never named, so the remedy is not actionable');
  if (text.includes(NEAR_TRIGGER_ID)) p.push('⛔ named the LIVE trigger as something to disable');
  if (!/enabled.*does NOT clear/i.test(text)) p.push('did not warn that enabled:false leaves nextRunAt standing');
  return p;
};

const REMEDY_CASES = [
  {
    name: 'REMEDY — RESIDUAL_ZOMBIE gets the SURGICAL fix and NEVER the archive line (TRA-3018 §1)',
    routines: [residualRoutine()],
    verdict: 'FINDINGS',
    assert: assertResidual,
  },
  {
    name: 'REMEDY — COVERAGE_LOST still gets ARCHIVE, and is not sent hunting a trigger',
    routines: [lostRoutine()],
    verdict: 'COVERAGE_LOST',
    assert: (text) => {
      const p = [];
      if (!text.includes(ARCHIVE_REMEDY)) p.push('the archive remedy was lost for the row it IS correct for');
      if (text.includes(SURGICAL_REMEDY)) p.push('sent a coverage-lost row on a needless trigger hunt');
      return p;
    },
  },
  {
    name: 'REMEDY — a MIXED run prints BOTH, each scoped to its own rows (the case v1 got wrong)',
    routines: [residualRoutine(), lostRoutine()],
    verdict: 'COVERAGE_LOST',
    assert: (text) => {
      const p = [...assertResidual(text.split('Remedy · RESIDUAL_ZOMBIE')[1] ?? '')];
      if (!text.includes(ARCHIVE_REMEDY)) p.push('the archive remedy vanished on a mixed run');
      const archiveBlock = text.split('Remedy · RESIDUAL_ZOMBIE')[0];
      if (!archiveBlock.includes('archive aaaaaaaa')) p.push('the archive list did not name the coverage-lost row');
      if (archiveBlock.includes('archive cccccccc')) p.push('⛔ the archive list named the RESIDUAL_ZOMBIE row');
      return p;
    },
  },
  {
    name: 'REMEDY — the surgical line rejects the 404 nested spelling and names the flat route',
    routines: [residualRoutine()],
    verdict: 'FINDINGS',
    assert: (text) => {
      const p = [];
      if (!text.includes('/api/routine-triggers/')) p.push('flat route absent');
      if (!/404/.test(text)) p.push('did not warn the nested spelling 404s');
      return p;
    },
  },
];

async function remedyControls() {
  let pass = 0;
  let residualResult = null;
  for (const c of REMEDY_CASES) {
    const ledger = parseAcknowledgements({ acknowledged: [] });
    const result = await sweep(
      { getRoutines: async () => c.routines },
      { horizonDays: HORIZON_DAYS, nowMs: NOW, acks: ledger.acks, ackWarnings: ledger.warnings },
    );
    if (c.verdict === 'FINDINGS' && !residualResult) residualResult = result;
    const problems = result.verdict !== c.verdict ? [`verdict ${result.verdict} != ${c.verdict}`] : c.assert(renderReport(result).join('\n'));
    if (problems.length) console.log(`FAIL  ${c.name}\n        ${problems.join('; ')}`);
    else {
      console.log(`ok    ${c.name}`);
      pass += 1;
    }
  }

  // MUTATION control. Put the v1 remedy back and the RESIDUAL_ZOMBIE control
  // must FAIL — otherwise it is not grading anything.
  try {
    const killed = assertResidual(renderWith(residualResult, REMEDY_V1));
    if (!killed.length) throw new Error('the v1 unconditional "ARCHIVE the routine" remedy PASSED the residual control — the control is inert');
    console.log(`ok    MUTATION — restoring the v1 remedy fails the residual control (${killed.length} problem(s) raised)`);
    pass += 1;
  } catch (err) {
    console.log(`FAIL  MUTATION control\n        ${err.message}`);
  }
  return pass;
}

async function selftest() {
  let pass = 0;
  const seen = new Set();
  for (const c of CASES) {
    const transport = { getRoutines: async () => c.routines };
    const ledger = parseAcknowledgements({ acknowledged: c.ledger ?? [] });
    let result;
    try {
      result = await sweep(transport, { horizonDays: HORIZON_DAYS, nowMs: NOW, acks: ledger.acks, ackWarnings: ledger.warnings });
    } catch (err) {
      console.log(`FAIL  ${c.name}\n        threw ${err.message}`);
      continue;
    }
    seen.add(result.verdict);
    const problems = [];
    if (result.verdict !== c.expect.verdict) problems.push(`verdict ${result.verdict} != ${c.expect.verdict}`);
    if (c.expect.findings !== undefined && result.findings.length !== c.expect.findings) {
      problems.push(`findings ${result.findings.length} != ${c.expect.findings}`);
    }
    if (c.expect.graded !== undefined && result.graded !== c.expect.graded) {
      problems.push(`graded ${result.graded} != ${c.expect.graded}`);
    }
    if (c.expect.state && result.findings[0]?.state !== c.expect.state && result.findings[0]?.spent?.[0]?.state !== c.expect.state) {
      problems.push(`state ${result.findings[0]?.state}/${result.findings[0]?.spent?.[0]?.state} != ${c.expect.state}`);
    }
    for (const [k, label] of [['acknowledged', 'acknowledged'], ['staleAcks', 'staleAcks'], ['ackWarnings', 'ackWarnings']]) {
      if (c.expect[k] !== undefined && (result[k] ?? []).length !== c.expect[k]) {
        problems.push(`${label} ${(result[k] ?? []).length} != ${c.expect[k]}`);
      }
    }
    if (problems.length) console.log(`FAIL  ${c.name}\n        ${problems.join('; ')}`);
    else {
      console.log(`ok    ${c.name}`);
      pass += 1;
    }
  }

  // GLOBAL control: the module must never issue a write verb.
  try {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL(import.meta.url), 'utf8'));
    const bad = /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i.exec(src);
    if (bad) throw new Error(`write verb ${bad[1]} present`);
    console.log('ok    GLOBAL read-only control (no write verb in this file)');
    pass += 1;
  } catch (err) {
    console.log(`FAIL  GLOBAL read-only control\n        ${err.message}`);
  }

  // GLOBAL control: an UNREADABLE ledger must degrade to ZERO acknowledgements
  // (⇒ more filing), never to "everything is acknowledged".
  try {
    const missing = loadAcknowledgements(`${ACK_PATH}.does-not-exist`);
    if (missing.acks.length !== 0) throw new Error('a missing ledger produced acknowledgements');
    if (missing.warnings.length !== 1) throw new Error('a missing ledger did not warn');
    const junk = parseAcknowledgements({ nope: true });
    if (junk.acks.length !== 0 || junk.warnings.length !== 1) throw new Error('a malformed ledger did not degrade to zero + warn');
    console.log('ok    GLOBAL ledger fails OPEN (unreadable/malformed => zero acks + a warning, never blanket suppression)');
    pass += 1;
  } catch (err) {
    console.log(`FAIL  GLOBAL ledger fail-open control\n        ${err.message}`);
  }

  // GLOBAL control: the SHIPPED ledger is well-formed. A hand-edit typo that
  // drops `trackedBy` would otherwise silently un-suppress (or, worse, ship an
  // ownerless suppression) with nothing to say so.
  //
  // ⛔ AN EMPTY COHORT IS NOT AN INERT LEDGER. This control used to assert
  // `acks.length > 0` under the banner "the file is present but inert" — so it
  // went RED at the exact moment its subject was REPAIRED. It did on 2026-09-09
  // (TRA-1621): the last entry, the departed-agent orphan e1b97e28, left the
  // population for real when a board operator paused the routine ROOT, and
  // trimming the now-STALE_ACK entry failed the control. Every genuinely inert
  // shape — a renamed/absent `acknowledged` key, an entry with no routineId, no
  // `trackedBy`/`reason`, or no `spent` pin — is ALREADY a warning out of
  // parseAcknowledgements, so `warnings.length` is the real inertness detector
  // and the count assertion was only ever able to fire on the success state.
  // Proven below by mutating the shipped file rather than asserting a count.
  try {
    const shipped = loadAcknowledgements();
    if (shipped.warnings.length) throw new Error(`shipped ledger warns: ${shipped.warnings.join(' · ')}`);
    for (const a of shipped.acks) {
      if (!/^TRA-\d+$/.test(a.trackedBy)) throw new Error(`entry ${a.routineId.slice(0, 8)} trackedBy ${JSON.stringify(a.trackedBy)} is not an issue identifier`);
    }
    // MUTATION: the shipped file's own bytes, with the array key renamed, must
    // still be caught. This is what "present but inert" actually means, and it
    // holds whether the cohort is empty or full.
    const shippedRaw = JSON.parse(readFileSync(ACK_PATH, 'utf8'));
    const { acknowledged, ...renamed } = shippedRaw;
    const inert = parseAcknowledgements(renamed);
    if (inert.warnings.length !== 1 || inert.acks.length !== 0) {
      throw new Error('renaming the shipped ledger\'s `acknowledged` key did not read as inert');
    }
    // MUTATION: an entry stripped of its owner must be IGNORED and warn. Vacuous
    // on an empty cohort, so it is driven off a synthetic row in that case —
    // never skipped, because "no entries" must not silently mean "not tested".
    const owner = { ...(shipped.acks[0] ?? { routineId: 'synthetic-row', spent: [{ cronExpression: '0 0 1 1 *', nextRunAt: '2027-01-01T00:00:00.000Z' }] }), trackedBy: undefined };
    const ownerless = parseAcknowledgements({ acknowledged: [owner] });
    if (ownerless.acks.length !== 0 || ownerless.warnings.length !== 1) {
      throw new Error('an ownerless entry was not dropped with a warning');
    }
    const cohort = shipped.acks.length === 0
      ? 'cohort EMPTY — nothing is being suppressed (the repaired state, not an inert file)'
      : `${shipped.acks.length} entries, each pinned and owned`;
    console.log(`ok    GLOBAL shipped ledger well-formed (${cohort}); inert-shape mutations still caught`);
    pass += 1;
  } catch (err) {
    console.log(`FAIL  GLOBAL shipped-ledger control\n        ${err.message}`);
  }

  pass += await remedyControls();

  const total = CASES.length + 3 + REMEDY_CASES.length + 1;
  console.log('');
  console.log(`${pass}/${total} controls pass; verdicts reachable: ${[...seen].sort().join(', ')}`);
  for (const v of ['CLEAN', 'ACKNOWLEDGED_ONLY', 'FINDINGS', 'COVERAGE_LOST', 'BLIND']) {
    if (!seen.has(v)) console.log(`WARN  verdict ${v} was never reached by any control`);
  }
  return pass === total ? 0 : 1;
}

/* ================================================================== */

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
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url} — ${text.slice(0, 160)}`);
    return JSON.parse(text);
  };
  // Trap 1 — accept a bare array FIRST. That is what this route actually
  // returns, and reading `.routines` off it is the bug this check was born from.
  const unwrap = (b, key) => {
    if (Array.isArray(b)) return b;
    if (b && Array.isArray(b[key])) return b[key];
    if (b && Array.isArray(b.data)) return b.data;
    return null;
  };
  return {
    listAgents: async () => unwrap(await get(`${BASE}/api/companies/${CO}/agents`), 'agents') || [],
    getRoutines: async ({ limit, offset }) =>
      unwrap(await get(`${BASE}/api/companies/${CO}/routines?limit=${limit}&offset=${offset}`), 'routines'),
  };
}

async function main() {
  if (argv.includes('--selftest')) return selftest();

  const transport = liveTransport();
  const ledger = loadAcknowledgements();
  const result = await sweep(transport, {
    routineLimit: ROUTINE_LIMIT,
    horizonDays: HORIZON_DAYS,
    acks: ledger.acks,
    ackWarnings: ledger.warnings,
  });

  let names = {};
  try {
    for (const a of await transport.listAgents()) {
      if (a && a.id) names[String(a.id).slice(0, 8)] = a.name || a.nameKey || String(a.id).slice(0, 8);
    }
  } catch {
    names = {}; // cosmetic only — never changes the verdict
  }

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          issue: 'TRA-3008',
          checkedAt: new Date().toISOString(),
          horizonDays: HORIZON_DAYS,
          verdict: result.verdict,
          blind: result.blind,
          routineCount: result.routineCount,
          graded: result.graded,
          tally: result.tally,
          findings: result.findings,
          acknowledged: result.acknowledged,
          staleAcks: result.staleAcks,
          ackWarnings: result.ackWarnings,
          blindRows: result.blindRows,
        },
        null,
        2,
      ),
    );
  } else {
    for (const l of renderReport(result, names)) console.log(l);
  }
  return VERDICT_EXIT[result.verdict] ?? 3;
}

if (!argv.includes('--import-only')) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('ERROR', err?.stack || err);
      process.exit(3);
    });
}
