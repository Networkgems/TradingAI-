#!/usr/bin/env node
/**
 * TRA-4049 — SLOT LOSS: an `active` routine that silently stopped serving the
 * cron slots it promises, while every forward-looking field still reads armed.
 *
 * WHAT HAPPENED
 * -------------
 * Measured live 2026-08-26: **28 of 43 active routines had not fired since
 * 2026-08-16 or earlier, and every single one reported a FUTURE `nextRunAt`.**
 * The scheduler was not down — 15 routines fired on 08-25/08-26, including the
 * hygiene detector `efd820ff`. A bimodal split with no discriminator in any
 * field the board can read.
 *
 * WHY NOTHING WE ALREADY RUN COULD SEE IT
 * ---------------------------------------
 * ⛔ `nextRunAt` IS A PROMISE, NOT A RECORD. It is recomputed forward whether
 * or not the slot it describes was ever served, so a routine that has missed
 * 60 consecutive fires is byte-for-byte identical, on that field, to one that
 * fired an hour ago. There is no field anywhere that says "this has not run in
 * ten days".
 *
 * The three instruments we already own each grade a DIFFERENT axis and none of
 * them grades this one:
 *
 *   check:routine-dispatch (TRA-2331)  the DISPATCH TAIL — did the LAST fire
 *                                      produce a run? Silent on the slots
 *                                      between fires. Its own header says so:
 *                                      "It does NOT evaluate the cron
 *                                      expression, so it does not count MISSED
 *                                      slots... Missed-slot counting is a
 *                                      separate, harder instrument; do not
 *                                      bolt an approximation onto this one."
 *                                      ⬅ THIS FILE IS THAT INSTRUMENT.
 *   check:spent-oneshot (TRA-3008)     the FORWARD PROMISE — is `nextRunAt` on
 *                                      a date-pinned cron a slot that already
 *                                      went by?
 *   check:carrier-dispatch (TRA-3529)  what happens AFTER a good dispatch.
 *
 * So the graded quantity here is FIRES SINCE LAST EXPECTED SLOT, derived from
 * the cron expression, per trigger. That is the only quantity that can
 * distinguish "armed" from "observing" for a routine, and it is the same
 * discipline as `check:deploy-drift`: a promise is not a measurement, and
 * "could not check" must never share an exit code with "checked and it is
 * fine".
 *
 * THE TRAPS — each one cost us a wrong reading on TRA-4041/TRA-4049, each has
 * a control in `--selftest`
 * ------------------------------------------------------------------------
 *  1. ⛔⛔ A DISABLED TRIGGER IS NOT A LOST SLOT. Routine `7d30dcfc` is
 *     `status: active` with `trigger.enabled: false` — deliberately armed but
 *     not firing (it is the donor of the canonical RESTING DISPOSITION block).
 *     It appeared in the TRA-4049 cohort of 28 as a pure false positive. The
 *     population here is `enabled: true` schedule triggers ONLY.
 *
 *  2. ⛔⛔ A `skipped` OR `coalesced` RUN IS A SERVED SLOT. The scheduler did
 *     its job; the concurrency policy declined the work. Counting those as
 *     losses would brand every healthy `coalesce_if_active` routine. They are
 *     served, and reported on their own line as SUPPRESSED — because a routine
 *     that ONLY ever coalesces is off in practice even though no slot was
 *     lost, and that distinction is the whole reason this file separates them
 *     instead of folding them into one number.
 *
 *  3. ⛔⛔ A TRUNCATED RUN HISTORY IS BLIND, NOT CLEAN. `/runs` paginates. If
 *     the page came back full AND its oldest row is newer than the window
 *     start, the early slots are UNOBSERVED — and an unobserved slot rendered
 *     as "no run found" is a manufactured accusation. That reads BLIND.
 *
 *  4. ⛔⛔ A CATCH-UP FLUSH SERVES A SLOT LATE, AND LATE IS NOT LOST. On
 *     2026-08-16T13:41Z **23 routines fired within ~2 minutes** despite
 *     unrelated crons — a boot-time flush, confirmed against
 *     `runtime-info.json` (`startedAt` 2026-08-26T02:06:32Z lines up exactly
 *     with the three routines that fired at 02:07). A naive ±5min match calls
 *     every one of those slots lost. Runs are assigned to slots GREEDILY —
 *     each run credits the newest still-unserved slot at or before it, within
 *     `--max-late` — so a flush is credited for the slot it replays and the
 *     other nine days still read LOST.
 *
 *  5. ⛔ THE VIXIE dom/dow RULE. When BOTH day-of-month and day-of-week are
 *     restricted, a slot matches if EITHER matches (not both). Getting this
 *     backwards silently deletes expected slots, which turns loss into clean —
 *     the direction that cannot be allowed to fail quietly.
 *
 *  6. ⛔ DST. Slots are enumerated as REAL UTC INSTANTS formatted into the
 *     trigger's zone, so a spring-forward slot simply does not exist and is
 *     never counted lost. A fall-back repeated hour is DEDUPED to one slot —
 *     the conservative direction, since implementations disagree and we must
 *     not manufacture a loss out of a clock artifact.
 *
 *  7. ⛔ AN EMPTY POPULATION IS UNMEASURED, NOT CLEAN. Zero graded routines
 *     exits BLIND. (Same reason `check:deploy-drift` fails closed.)
 *
 *  8. ⛔ SLOTS BEFORE THE TRIGGER EXISTED ARE NOT LOSSES. The window is
 *     clamped to the routine's `createdAt`, so a routine armed yesterday is
 *     not billed for last week.
 *
 * VERDICTS — precedence BLIND > SLOT_LOSS > CLEAN
 *   0 CLEAN      every graded trigger served every expected slot in the window
 *   1 SLOT_LOSS  at least one trigger has >= --min-lost unserved expected slots
 *   2 usage
 *   3 BLIND      unparseable cron, unknown timezone, truncated history,
 *                transport failure, or an empty population
 *
 * USAGE
 *   pnpm check:slot-loss
 *   pnpm check:slot-loss -- --days=14 --json
 *   pnpm check:slot-loss:controls
 */

const argv = process.argv.slice(2);
const argOf = (name, fallback = undefined) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const numArg = (name, fallback) => {
  const raw = argOf(name);
  if (raw === undefined || raw === true) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* Defaults. All overridable so a caller can widen the window without editing. */
const DEFAULT_DAYS = 14;
/** A slot due within this of `now` has not had a fair chance to fire yet. */
const DEFAULT_GRACE_MIN = 20;
/** How late a run may arrive and still be credited with the slot (catch-up flush). */
const DEFAULT_MAX_LATE_MIN = 6 * 60;
/** A run may lead its slot by this much (scheduler clock skew / early claim). */
const EARLY_TOLERANCE_MIN = 2;
/** Below this, a single ragged slot is noise, not a finding. */
const DEFAULT_MIN_LOST = 2;
/** Page size asked of /runs. Full page + oldest-inside-window => BLIND. */
const DEFAULT_RUN_LIMIT = 200;
/** Refuses to enumerate a pathological cron (e.g. `* * * * *` over 90 days). */
const MAX_SLOTS_PER_TRIGGER = 20_000;

const VERDICT_EXIT = { CLEAN: 0, SLOT_LOSS: 1, BLIND: 3 };

/* ==================================================================
 * Cron
 * ================================================================== */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOWS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

class CronUnsupported extends Error {}

/**
 * Expand one cron field into a Set of integers.
 * Supports: star, `?`, `n`, `a-b`, `a-b/s`, star-slash-step, `n/s`, lists, and the
 * three-letter month/day names. Anything else — `L`, `W`, `#`, a sixth field —
 * throws, and the caller turns that into BLIND. There is no "best effort"
 * branch on purpose: a cron we half-understand produces expected slots that do
 * not exist, and those render as losses.
 */
function expandField(raw, min, max, names) {
  const src = String(raw ?? '').trim();
  if (!src) throw new CronUnsupported('empty field');
  if (/[LW#]/i.test(src)) throw new CronUnsupported(`unsupported cron syntax "${src}"`);

  const out = new Set();
  for (const part of src.split(',')) {
    const piece = part.trim();
    if (!piece) throw new CronUnsupported(`empty list element in "${src}"`);

    let body = piece;
    let step = 1;
    const slash = piece.indexOf('/');
    if (slash !== -1) {
      body = piece.slice(0, slash);
      const stepRaw = piece.slice(slash + 1);
      step = Number(stepRaw);
      if (!Number.isInteger(step) || step < 1) throw new CronUnsupported(`bad step "${piece}"`);
    }

    const token = (t) => {
      const s = String(t).trim().toUpperCase();
      if (/^\d+$/.test(s)) return Number(s);
      if (names) {
        const idx = names.indexOf(s);
        if (idx !== -1) return idx + (names === MONTHS ? 1 : 0);
      }
      throw new CronUnsupported(`unrecognised value "${t}" in "${src}"`);
    };

    let lo;
    let hi;
    if (body === '*' || body === '?') {
      lo = min;
      hi = max;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-');
      lo = token(a);
      hi = token(b);
    } else {
      lo = token(body);
      hi = slash === -1 ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new CronUnsupported(`bad range "${piece}"`);
    if (lo < min || hi > max || lo > hi) throw new CronUnsupported(`range "${piece}" outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (!out.size) throw new CronUnsupported(`field "${src}" matches nothing`);
  return out;
}

export function parseCron(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    throw new CronUnsupported(`expected 5 cron fields, got ${fields.length} in ${JSON.stringify(expression)}`);
  }
  const [m, h, dom, mon, dow] = fields;
  const dowSet = expandField(dow, 0, 7, DOWS);
  // Both 0 and 7 mean Sunday.
  if (dowSet.has(7)) dowSet.add(0);
  return {
    minute: expandField(m, 0, 59, null),
    hour: expandField(h, 0, 23, null),
    dom: expandField(dom, 1, 31, null),
    month: expandField(mon, 1, 12, MONTHS),
    dow: dowSet,
    // ⛔ Vixie: when BOTH dom and dow are restricted the day matches on EITHER.
    domRestricted: !/^[*?]$/.test(String(dom).trim()),
    dowRestricted: !/^[*?]$/.test(String(dow).trim()),
  };
}

/* ==================================================================
 * Timezone-correct slot enumeration
 * ================================================================== */

const FORMATTERS = new Map();
function formatterFor(timeZone) {
  let f = FORMATTERS.get(timeZone);
  if (!f) {
    // Throws RangeError on an unknown zone — the caller turns that into BLIND.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    FORMATTERS.set(timeZone, f);
  }
  return f;
}

function localPartsAt(ms, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    dow: DOWS.indexOf(String(get('weekday')).toUpperCase()),
  };
}

function dayMatches(cron, p) {
  const dm = cron.dom.has(p.day);
  const dw = cron.dow.has(p.dow);
  if (cron.domRestricted && cron.dowRestricted) return dm || dw;
  if (cron.domRestricted) return dm;
  if (cron.dowRestricted) return dw;
  return true;
}

/**
 * Every instant in [fromMs, toMs] whose local wall-clock in `timeZone` matches
 * `cron`, deduped by local wall-clock so a fall-back repeated hour yields one
 * slot, not two.
 *
 * Enumerating real instants (rather than generating local times and converting
 * back) is what makes this DST-correct by construction: a spring-forward slot
 * has no instant, so it is never expected and never counted lost.
 *
 * Cost control: the zone offset is resolved once per UTC hour, not per minute.
 */
function enumerateSlots(cron, timeZone, fromMs, toMs) {
  const slots = [];
  if (!(toMs > fromMs)) return slots;

  const seen = new Set();
  const startHour = Math.floor(fromMs / HOUR) * HOUR;

  for (let hourStart = startHour; hourStart <= toMs; hourStart += HOUR) {
    const base = localPartsAt(hourStart, timeZone);
    // Offsets are whole minutes in every real zone, so the local minute of
    // `hourStart + k` is `base.minute + k` — no re-format needed per minute.
    for (let k = 0; k < 60; k += 1) {
      const ms = hourStart + k * MIN;
      if (ms < fromMs || ms > toMs) continue;
      const minute = (base.minute + k) % 60;
      if (!cron.minute.has(minute)) continue;
      // Crossing a local hour boundary inside this UTC hour (offsets like
      // +05:30 / +05:45) changes hour/day/dow, so re-resolve for candidates.
      const p = base.minute + k < 60 ? base : localPartsAt(ms, timeZone);
      if (!cron.hour.has(p.hour)) continue;
      if (!cron.month.has(p.month)) continue;
      if (!dayMatches(cron, p)) continue;
      const key = `${p.year}-${p.month}-${p.day}T${p.hour}:${minute}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(ms);
      if (slots.length > MAX_SLOTS_PER_TRIGGER) {
        throw new CronUnsupported(
          `cron yields more than ${MAX_SLOTS_PER_TRIGGER} slots in the window — narrow --days`,
        );
      }
    }
  }
  return slots;
}

/* ==================================================================
 * Grading
 * ================================================================== */

/** Run statuses that prove the SCHEDULER served the slot. */
const SERVED_STATUSES = new Set([
  'received',
  'issue_created',
  'running',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'coalesced',
  'suppressed',
]);
/** Served, but the concurrency policy or a gate declined the work. Trap 2. */
const SUPPRESSED_STATUSES = new Set(['skipped', 'coalesced', 'suppressed']);

/**
 * Greedy right-to-left assignment: walk runs newest-first and credit each to
 * the newest still-unserved slot at or before it (within maxLate). This is
 * what makes a catch-up flush (trap 4) credit exactly the slots it replays
 * instead of one slot or all of them.
 */
function assignRunsToSlots(slots, runs, { maxLateMs, earlyMs }) {
  const served = new Map(); // slotMs -> run
  const ordered = [...slots].sort((a, b) => a - b);
  const byNewest = [...runs].sort((a, b) => b.at - a.at);
  const taken = new Set();

  for (const run of byNewest) {
    let best = -1;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const slot = ordered[i];
      if (taken.has(slot)) continue;
      if (run.at + earlyMs < slot) continue; // run predates this slot
      if (run.at - slot > maxLateMs) break; // and every earlier slot too
      best = i;
      break;
    }
    if (best !== -1) {
      taken.add(ordered[best]);
      served.set(ordered[best], run);
    }
  }
  return served;
}

function gradeTrigger({ routine, trigger, runs, now, windowStartMs, graceMs, maxLateMs, minLost }) {
  const label = trigger.label || trigger.id || '(unlabelled)';
  const base = {
    routineId: routine.id,
    routineShort: String(routine.id ?? '').slice(0, 8),
    routineTitle: routine.title ?? '',
    assigneeAgentId: routine.assigneeAgentId ?? null,
    triggerId: trigger.id ?? null,
    triggerLabel: label,
    cronExpression: trigger.cronExpression ?? null,
    timezone: trigger.timezone ?? null,
    nextRunAt: trigger.nextRunAt ?? null,
    lastFiredAt: trigger.lastFiredAt ?? null,
  };

  if (!trigger.cronExpression) {
    return { ...base, state: 'BLIND', reason: 'schedule trigger carries no cronExpression' };
  }
  // ⛔ TRA-1673: an omitted `timezone` silently DEFAULTS TO UTC server-side, so
  // reading it as UTC here would agree with the scheduler. It is still recorded
  // as an assumption in the row, never hidden.
  const timeZone = trigger.timezone || 'UTC';
  let cron;
  try {
    cron = parseCron(trigger.cronExpression);
    formatterFor(timeZone); // RangeError on an unknown zone
  } catch (err) {
    return {
      ...base,
      state: 'BLIND',
      reason: `${err instanceof CronUnsupported ? 'cron' : 'timezone'}: ${err.message}`,
    };
  }

  // Trap 8 — never bill a trigger for slots that predate it.
  const bornMs = Date.parse(trigger.createdAt ?? routine.createdAt ?? '') || 0;
  const fromMs = Math.max(windowStartMs, bornMs);
  const toMs = now - graceMs;

  let slots;
  try {
    slots = enumerateSlots(cron, timeZone, fromMs, toMs);
  } catch (err) {
    return { ...base, state: 'BLIND', reason: `cron: ${err.message}` };
  }

  if (!slots.length) {
    return {
      ...base,
      state: 'NO_SLOTS_DUE',
      expected: 0,
      lost: 0,
      windowStart: new Date(fromMs).toISOString(),
    };
  }

  const mine = runs
    .filter((r) => (r.triggerId ? r.triggerId === trigger.id : runs.every((x) => !x.triggerId)))
    .filter((r) => SERVED_STATUSES.has(String(r.status)))
    .map((r) => ({ at: Date.parse(r.triggeredAt ?? r.createdAt ?? ''), status: String(r.status) }))
    .filter((r) => Number.isFinite(r.at));

  // Trap 3 — a full page whose oldest row lands inside the window means the
  // early slots are UNOBSERVED. Not clean, not lost: BLIND.
  if (runs.truncated) {
    const oldest = runs.length ? Math.min(...runs.map((r) => Date.parse(r.triggeredAt ?? r.createdAt ?? '') || Infinity)) : Infinity;
    if (oldest > fromMs) {
      return {
        ...base,
        state: 'BLIND',
        reason:
          `run history truncated at ${runs.length} rows; oldest run ` +
          `${Number.isFinite(oldest) ? new Date(oldest).toISOString() : 'n/a'} is inside the window ` +
          `(from ${new Date(fromMs).toISOString()}) — early slots unobserved`,
      };
    }
  }

  const served = assignRunsToSlots(slots, mine, { maxLateMs, earlyMs: EARLY_TOLERANCE_MIN * MIN });
  const lostSlots = slots.filter((s) => !served.has(s));
  const suppressed = [...served.values()].filter((r) => SUPPRESSED_STATUSES.has(r.status)).length;

  const state = lostSlots.length >= minLost ? 'SLOT_LOSS' : lostSlots.length > 0 ? 'RAGGED' : 'SERVED';
  return {
    ...base,
    state,
    windowStart: new Date(fromMs).toISOString(),
    expected: slots.length,
    servedCount: served.size,
    suppressedCount: suppressed,
    lost: lostSlots.length,
    firstLostAt: lostSlots.length ? new Date(lostSlots[0]).toISOString() : null,
    lastLostAt: lostSlots.length ? new Date(lostSlots[lostSlots.length - 1]).toISOString() : null,
    lastServedAt: served.size ? new Date(Math.max(...served.keys())).toISOString() : null,
  };
}

export async function sweep(transport, opts = {}) {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? DEFAULT_DAYS;
  const graceMs = (opts.graceMin ?? DEFAULT_GRACE_MIN) * MIN;
  const maxLateMs = (opts.maxLateMin ?? DEFAULT_MAX_LATE_MIN) * MIN;
  const minLost = opts.minLost ?? DEFAULT_MIN_LOST;
  const windowStartMs = now - days * DAY;

  let routines;
  try {
    routines = await transport.getRoutines();
  } catch (err) {
    return { verdict: 'BLIND', blind: [{ reason: `routine list unreadable: ${err.message}` }], rows: [], now, days };
  }
  if (!Array.isArray(routines)) {
    return { verdict: 'BLIND', blind: [{ reason: 'routine list did not deserialise to an array' }], rows: [], now, days };
  }

  const rows = [];
  for (const routine of routines) {
    if (String(routine?.status) !== 'active') continue;
    const triggers = Array.isArray(routine.triggers) ? routine.triggers : null;
    if (!triggers) {
      rows.push({
        routineId: routine.id,
        routineShort: String(routine.id ?? '').slice(0, 8),
        routineTitle: routine.title ?? '',
        state: 'BLIND',
        reason: '`triggers` key absent on the routine row — cannot enumerate schedules',
      });
      continue;
    }
    // Trap 1 — enabled schedule triggers only.
    const live = triggers.filter((t) => String(t?.kind) === 'schedule' && t?.enabled === true);
    if (!live.length) continue;

    let runs;
    try {
      runs = await transport.getRuns(routine.id);
    } catch (err) {
      rows.push({
        routineId: routine.id,
        routineShort: String(routine.id ?? '').slice(0, 8),
        routineTitle: routine.title ?? '',
        state: 'BLIND',
        reason: `run history unreadable: ${err.message}`,
      });
      continue;
    }

    for (const trigger of live) {
      rows.push(gradeTrigger({ routine, trigger, runs, now, windowStartMs, graceMs, maxLateMs, minLost }));
    }
  }

  const blind = rows.filter((r) => r.state === 'BLIND');
  const findings = rows.filter((r) => r.state === 'SLOT_LOSS');
  const graded = rows.filter((r) => r.state !== 'BLIND');

  // Trap 7 — an empty census is unmeasured, not clean.
  let verdict;
  if (!graded.length) verdict = 'BLIND';
  else if (blind.length) verdict = 'BLIND';
  else if (findings.length) verdict = 'SLOT_LOSS';
  else verdict = 'CLEAN';

  if (!graded.length && !blind.length) {
    blind.push({ state: 'BLIND', reason: 'no active routine carries an enabled schedule trigger — population empty' });
  }

  return {
    verdict,
    now,
    days,
    windowStart: new Date(windowStartMs).toISOString(),
    minLost,
    maxLateMin: maxLateMs / MIN,
    routineCount: routines.length,
    gradedCount: graded.length,
    rows,
    blind,
    findings,
    tally: rows.reduce((acc, r) => ((acc[r.state] = (acc[r.state] || 0) + 1), acc), {}),
  };
}

/* ================================================================== */

function renderReport(result, names = {}) {
  const out = [];
  const who = (id) => names[String(id ?? '').slice(0, 8)] || String(id ?? '').slice(0, 8) || '?';
  out.push(`check:slot-loss (TRA-4049) — ${result.verdict}`);
  out.push(
    `  window ${result.windowStart} .. now (${result.days}d) · ` +
      `graded ${result.gradedCount} trigger(s) across ${result.routineCount} routine(s) · ` +
      `min-lost ${result.minLost} · max-late ${result.maxLateMin}min`,
  );
  out.push(`  tally ${JSON.stringify(result.tally)}`);

  if (result.findings?.length) {
    out.push('');
    out.push(`  SLOT LOSS — ${result.findings.length} trigger(s) stopped serving their cron:`);
    for (const f of [...result.findings].sort((a, b) => b.lost - a.lost)) {
      out.push(
        `    ${f.routineShort}  LOST ${f.lost}/${f.expected}  ` +
          `last served ${f.lastServedAt ?? 'NEVER'}  owner ${who(f.assigneeAgentId)}`,
      );
      out.push(`        cron ${JSON.stringify(f.cronExpression)} ${f.timezone ?? '(UTC assumed)'} — ${f.routineTitle}`);
      out.push(`        first lost ${f.firstLostAt} · last lost ${f.lastLostAt} · nextRunAt claims ${f.nextRunAt}`);
    }
  }

  const ragged = result.rows?.filter((r) => r.state === 'RAGGED') ?? [];
  if (ragged.length) {
    out.push('');
    out.push(`  RAGGED — ${ragged.length} trigger(s) below the --min-lost=${result.minLost} bar (not a finding):`);
    for (const r of ragged) out.push(`    ${r.routineShort}  lost ${r.lost}/${r.expected}  ${r.routineTitle.slice(0, 60)}`);
  }

  const supp = result.rows?.filter((r) => r.suppressedCount > 0 && r.state !== 'SLOT_LOSS') ?? [];
  if (supp.length) {
    out.push('');
    out.push('  SUPPRESSED — slot served, work declined by the concurrency policy (trap 2):');
    for (const r of supp) {
      out.push(`    ${r.routineShort}  ${r.suppressedCount}/${r.servedCount} served slots coalesced/skipped  ${r.routineTitle.slice(0, 50)}`);
    }
  }

  if (result.blind?.length) {
    out.push('');
    out.push(`  BLIND — ${result.blind.length} row(s) could not be graded (never green):`);
    for (const b of result.blind) out.push(`    ${b.routineShort ?? '(fleet)'}  ${b.reason}`);
  }

  if (result.verdict === 'CLEAN') out.push('\n  Every graded trigger served every expected slot in the window.');
  return out;
}

/* ==================================================================
 * Controls
 * ================================================================== */

const T_NOW = Date.parse('2026-08-26T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function fakeTransport(routines, runsByRoutine = {}, opts = {}) {
  return {
    getRoutines: async () => {
      if (opts.listThrows) throw new Error(opts.listThrows);
      return routines;
    },
    getRuns: async (id) => {
      if (opts.runsThrows) throw new Error(opts.runsThrows);
      const rows = runsByRoutine[id] ?? [];
      rows.truncated = Boolean(opts.truncated);
      return rows;
    },
  };
}

/** A daily 13:00Z routine that has been alive for a month. */
function dailyRoutine(over = {}) {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    status: 'active',
    title: 'daily 13:00Z fixture',
    assigneeAgentId: 'cccccccc-0000-0000-0000-000000000001',
    createdAt: '2026-07-01T00:00:00Z',
    concurrencyPolicy: 'coalesce_if_active',
    triggers: [
      {
        id: 'tttttttt-0000-0000-0000-000000000001',
        kind: 'schedule',
        enabled: true,
        cronExpression: '0 13 * * *',
        timezone: 'UTC',
        createdAt: '2026-07-01T00:00:00Z',
        nextRunAt: '2026-08-26T13:00:00.000Z',
        lastFiredAt: '2026-08-16T13:41:00.000Z',
      },
    ],
    ...over,
  };
}

/** One `completed` run at every 13:00Z slot in the window. */
function fullyServedRuns(days = 20, status = 'completed') {
  const rows = [];
  for (let d = 1; d <= days; d += 1) {
    const at = Date.parse('2026-08-26T13:00:00Z') - d * DAY;
    rows.push({ triggerId: 'tttttttt-0000-0000-0000-000000000001', status, triggeredAt: iso(at) });
  }
  return rows;
}

const CONTROLS = [
  {
    name: 'CLEAN — every daily slot served',
    expect: 'CLEAN',
    build: () => fakeTransport([dailyRoutine()], { [dailyRoutine().id]: fullyServedRuns() }),
  },
  {
    name: 'SLOT_LOSS — THE INCIDENT: fired 08-16, silent since, nextRunAt still future',
    expect: 'SLOT_LOSS',
    build: () =>
      fakeTransport([dailyRoutine()], {
        [dailyRoutine().id]: [
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-08-16T13:41:00Z' },
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-08-15T13:00:00Z' },
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-08-14T13:00:00Z' },
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-08-13T13:00:00Z' },
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-08-12T13:00:00Z' },
        ],
      }),
    assert: (r) => r.findings[0]?.lost >= 8 || `expected >=8 lost slots, got ${r.findings[0]?.lost}`,
  },
  {
    name: 'trap 1 — a DISABLED trigger is not a lost slot (routine 7d30dcfc)',
    expect: 'BLIND',
    note: 'population empty => BLIND, and critically NOT SLOT_LOSS',
    build: () => {
      const r = dailyRoutine();
      r.triggers[0].enabled = false;
      return fakeTransport([r], {});
    },
  },
  {
    name: 'trap 2 — `coalesced` and `skipped` runs SERVE their slot',
    expect: 'CLEAN',
    build: () => fakeTransport([dailyRoutine()], { [dailyRoutine().id]: fullyServedRuns(20, 'coalesced') }),
    assert: (r) => (r.rows[0].suppressedCount > 0 ? true : 'suppressed slots were not counted on their own line'),
  },
  {
    name: 'trap 3 — a TRUNCATED run history is BLIND, not a loss',
    expect: 'BLIND',
    build: () =>
      fakeTransport(
        [dailyRoutine()],
        {
          [dailyRoutine().id]: [
            { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-08-25T13:00:00Z' },
          ],
        },
        { truncated: true },
      ),
    assert: (r) => (/truncated/.test(r.blind[0]?.reason ?? '') ? true : 'blind reason did not name truncation'),
  },
  {
    name: 'trap 4 — a CATCH-UP FLUSH credits the slot it replays, not all of them',
    expect: 'SLOT_LOSS',
    build: () =>
      fakeTransport([dailyRoutine()], {
        [dailyRoutine().id]: [
          // The 08-16T13:41Z burst: 41 minutes late for the 13:00Z slot.
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-08-16T13:41:00Z' },
        ],
      }),
    assert: (r) => {
      const row = r.findings[0];
      if (!row) return 'expected a finding';
      // 08-16 must be credited as served even though the run is 41 min late.
      return row.lastServedAt === '2026-08-16T13:00:00.000Z'
        ? true
        : `late run did not credit its own slot (lastServedAt=${row.lastServedAt})`;
    },
  },
  {
    name: 'trap 5 — Vixie dom/dow: `0 13 1 * MON` matches the 1st OR any Monday',
    expect: 'CLEAN',
    build: () => {
      const r = dailyRoutine();
      r.triggers[0].cronExpression = '0 13 1 * MON';
      // Slots in the 14d window: Mondays 08-17, 08-24 (08-01 is outside).
      return fakeTransport([r], {
        [r.id]: [
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-08-17T13:00:00Z' },
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-08-24T13:00:00Z' },
        ],
      });
    },
    assert: (r) => (r.rows[0].expected === 2 ? true : `expected 2 Vixie slots, got ${r.rows[0].expected}`),
  },
  {
    name: 'trap 6 — an ET routine is enumerated in its own zone, not UTC',
    expect: 'CLEAN',
    build: () => {
      const r = dailyRoutine();
      r.triggers[0].cronExpression = '30 8 * * *';
      r.triggers[0].timezone = 'America/New_York'; // 12:30Z in EDT
      const rows = [];
      for (let d = 1; d <= 20; d += 1) {
        rows.push({
          triggerId: 'tttttttt-0000-0000-0000-000000000001',
          status: 'completed',
          triggeredAt: iso(Date.parse('2026-08-26T12:30:00Z') - d * DAY),
        });
      }
      return fakeTransport([r], { [r.id]: rows });
    },
  },
  {
    name: 'trap 7 — an empty population is BLIND, never CLEAN',
    expect: 'BLIND',
    build: () => fakeTransport([], {}),
  },
  {
    name: 'trap 8 — a routine born yesterday is not billed for last week',
    expect: 'CLEAN',
    build: () => {
      const r = dailyRoutine({ createdAt: '2026-08-25T00:00:00Z' });
      r.triggers[0].createdAt = '2026-08-25T00:00:00Z';
      return fakeTransport([r], {
        [r.id]: [
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-08-25T13:00:00Z' },
        ],
      });
    },
    assert: (r) => (r.rows[0].expected === 1 ? true : `expected 1 in-life slot, got ${r.rows[0].expected}`),
  },
  {
    name: 'BLIND — an unparseable cron is never green',
    expect: 'BLIND',
    build: () => {
      const r = dailyRoutine();
      r.triggers[0].cronExpression = '0 13 L * *';
      return fakeTransport([r], { [r.id]: [] });
    },
  },
  {
    name: 'BLIND — an unknown timezone is never green',
    expect: 'BLIND',
    build: () => {
      const r = dailyRoutine();
      r.triggers[0].timezone = 'Mars/Olympus_Mons';
      return fakeTransport([r], { [r.id]: [] });
    },
  },
  {
    name: 'BLIND — the `triggers` key ABSENT is not "no triggers" (TRA-2364 shape)',
    expect: 'BLIND',
    build: () => {
      const r = dailyRoutine();
      delete r.triggers;
      return fakeTransport([r], {});
    },
  },
  {
    name: 'BLIND — transport failure fails closed',
    expect: 'BLIND',
    build: () => fakeTransport([dailyRoutine()], {}, { listThrows: 'ECONNREFUSED' }),
  },
  {
    name: 'BLIND — an unreadable run history for one routine is not a clean fleet',
    expect: 'BLIND',
    build: () => fakeTransport([dailyRoutine()], {}, { runsThrows: 'HTTP 500' }),
  },
  {
    name: 'a `paused` routine is out of population (only `active` is graded)',
    expect: 'BLIND',
    note: 'population empty => BLIND',
    build: () => fakeTransport([dailyRoutine({ status: 'paused' })], {}),
  },
];

async function selftest() {
  let pass = 0;
  const seen = new Set();
  for (const c of CONTROLS) {
    const result = await sweep(c.build(), { now: T_NOW, days: DEFAULT_DAYS });
    seen.add(result.verdict);
    let ok = result.verdict === c.expect;
    let detail = ok ? '' : `verdict ${result.verdict}, expected ${c.expect}`;
    if (ok && c.assert) {
      const a = c.assert(result);
      if (a !== true) {
        ok = false;
        detail = String(a);
      }
    }
    if (ok) pass += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${c.note ? `  [${c.note}]` : ''}${detail ? ` — ${detail}` : ''}`);
  }
  console.log(`\n${pass}/${CONTROLS.length} controls pass; verdicts reachable: ${[...seen].sort().join(', ')}`);
  for (const v of ['CLEAN', 'SLOT_LOSS', 'BLIND']) {
    if (!seen.has(v)) console.log(`WARN  verdict ${v} was never reached by any control`);
  }
  return pass === CONTROLS.length ? 0 : 1;
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
  const runLimit = numArg('run-limit', DEFAULT_RUN_LIMIT);
  const get = async (url) => {
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url} — ${text.slice(0, 160)}`);
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
    getRoutines: async () => unwrap(await get(`${BASE}/api/companies/${CO}/routines`), 'routines'),
    getRuns: async (id) => {
      const rows = unwrap(await get(`${BASE}/api/routines/${id}/runs?limit=${runLimit}`), 'runs');
      if (!Array.isArray(rows)) throw new Error('run history did not deserialise to an array');
      // Trap 3 — the page came back full, so there may be older rows we cannot see.
      rows.truncated = rows.length >= runLimit;
      return rows;
    },
  };
}

async function main() {
  if (argv.includes('--help')) {
    console.log(
      [
        'check:slot-loss (TRA-4049) — grade FIRES SINCE LAST EXPECTED SLOT per routine, from the cron.',
        '',
        '  --days=N        lookback window (default 14)',
        '  --grace=N       minutes a slot gets before it is judged (default 20)',
        '  --max-late=N    minutes a run may lag its slot and still credit it (default 360)',
        '  --min-lost=N    lost slots before a trigger is a finding (default 2)',
        '  --run-limit=N   /runs page size; a full page inside the window reads BLIND (default 200)',
        '  --json          machine-readable',
        '  --selftest      run the controls',
        '',
        '  0 CLEAN · 1 SLOT_LOSS · 2 usage · 3 BLIND;  BLIND > SLOT_LOSS > CLEAN',
      ].join('\n'),
    );
    return 2;
  }
  if (argv.includes('--selftest')) return selftest();

  const transport = liveTransport();
  const result = await sweep(transport, {
    days: numArg('days', DEFAULT_DAYS),
    graceMin: numArg('grace', DEFAULT_GRACE_MIN),
    maxLateMin: numArg('max-late', DEFAULT_MAX_LATE_MIN),
    minLost: numArg('min-lost', DEFAULT_MIN_LOST),
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
    console.log(JSON.stringify({ issue: 'TRA-4049', checkedAt: new Date().toISOString(), ...result }, null, 2));
  } else {
    for (const l of renderReport(result, names)) console.log(l);
  }
  return VERDICT_EXIT[result.verdict] ?? 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('ERROR', err?.stack || err);
    process.exit(3);
  });
