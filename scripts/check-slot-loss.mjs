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
 *  9. ⛔⛔ A SLOT SERVED PAST `--max-late` IS **LATE**, NOT LOST, AND THE TWO
 *     NEED DIFFERENT REPAIRS. Trap 4 got the principle right and then put the
 *     bar in the wrong place: with ONE bar, every slot beyond it falls into
 *     LOST, which is "no run exists" — an accusation against the routine — when
 *     the truth is "a run exists, the dispatcher was slow", which is an
 *     observation about the scheduler and needs NOTHING done to the routine.
 *     Measured 2026-10-01 (TRA-4958, QuantTrader on TRA-4953): at the 6h
 *     default, **66 of 180 reported losses (36.7%) across 11 of 12 routines**
 *     were lateness artifacts — including this checker's own carrier routine
 *     `efd820ff`, which held the largest absolute loss count in its own report.
 *     `11ff643f` was the extreme (7 of 10 reported losses phantom) only because
 *     its cron is WEEKLY: one slot a week means a one-day lag always clears a
 *     six-hour bar with no on-time neighbours to dilute it. It was routed to an
 *     owner as a dead routine while it was in fact firing and accruing. There
 *     are now TWO bars and THREE outcomes — SERVED / LATE_SERVED / LOST — and
 *     LATE_DISPATCH carries its own exit code so neither hides behind the other.
 *
 * 10. ⛔⛔ `lastServedAt` IS WINDOW-SCOPED, SO ITS NULL IS NOT "NEVER FIRED".
 *     `served` is keyed only on slots INSIDE the lookback, so a routine whose
 *     last credited slot predates `--days` renders null — and that null used to
 *     print as the word `NEVER`, which reads as the universal. Same routine,
 *     same runs, same bar: `--days=14` printed "last served NEVER" while
 *     `--days=90` printed `2026-07-20T13:00:00Z`. That string carried into a
 *     filed issue as "the accrual is not accruing" about a routine sitting at
 *     89/100. The universal is the RUN-ROW COUNT, which is window-free; the
 *     renderer prints that and the two are never collapsed again.
 *
 * THE DARKNESS ARM (TRA-5055, off the TRA-5053 ruling)
 * ----------------------------------------------------
 * A scheduler-dark window used to show up here only as N routines each
 * independently "losing slots" — N symptoms, no cause, and TRA-5053 had to
 * reason its way back to the single incident in prose. Worse, every number a
 * routine's own fire history can produce about the darkness is wrong by
 * construction: a routine's fires are a lagging, coarse PROXY for scheduler
 * availability (TRA-5053's on-cron fire reported 89.08h bounded [77.0, 89.1]
 * for a darkness that is 86.06h measurable to the second — 89.08h is the
 * ROUTINE INTER-FIRE GAP, a different quantity with a different name).
 *
 * So darkness is derived from the two surfaces that can actually see it:
 *
 *   1. `heartbeat_runs` — the whole-process liveness tape (heartbeats,
 *      monitors AND routines), read off the LIST route's timestamps only.
 *      ⛔ The list route STRIPS `contextSnapshot` (`source: None`); grading
 *      anything off that field here is reading a surface known to be blank.
 *      ⛔ `limit` caps at 1000 and `offset`/`page`/`before` are IGNORED, so
 *      for history past the 1000-row window the tape is EXTENDED from
 *      `data/run-logs/<companyId>/<agentId>/<runId>.ndjson` first-line `ts`
 *      (measured 2026-10-04: the API window reached back only 11.7 days and
 *      could not see the 09-21 occurrence; the ndjson arm reproduced it to
 *      within 4 minutes — tick-source skew, run-row createdAt vs first log
 *      byte).
 *   2. Host boot/shutdown events (System log Ids 6005 boot / 6006 clean
 *      shutdown / 6008 unexpected / 1074 initiated / 109 kernel-power), to
 *      split each gap into HOST-DOWN vs HOST-UP-BUT-SERVER-DARK. That split
 *      is the whole actionable content of a dark window: host-down belongs
 *      to the auto-start fix (TRA-5105), host-up-dark belongs to whatever
 *      did not start the server. An unreadable event log reads
 *      NOT MEASURED on the split — never zero, never a guess — and the gap
 *      itself is still reported.
 *
 * ⛔ THE BAR IS 12h AND IT COMES FROM THE MEASURED DISTRIBUTION, NOT TASTE.
 * On 2026-10-04 the healthy band of the merged tape showed natural quiet of
 * up to 8.3h (overnight host sleep, which writes no 6005/6006 pair), while
 * the smallest real occurrence on record is 17.1h (TRA-4141). 720min splits
 * the two populations with ~4h of margin in both directions. Lowering it
 * past ~500min brands every quiet night DARK_WINDOW, which is how a
 * detector stops being read.
 *
 * VERDICTS — precedence BLIND > DARK_WINDOW > SLOT_LOSS > LATE_DISPATCH > CLEAN
 *   0 CLEAN          every graded trigger served every expected slot in the window
 *   1 SLOT_LOSS      at least one trigger has >= --min-lost slots with NO run at
 *                    either bar — a dispatch failure
 *   2 usage
 *   3 BLIND          unparseable cron, unknown timezone, truncated history,
 *                    transport failure, an empty population, or an empty/
 *                    unreadable liveness tape
 *   4 LATE_DISPATCH  no dispatch failure, but >= --min-lost slots on some trigger
 *                    were served only past --max-late. NOT a broken routine and
 *                    NOT green: the repair is to the dispatcher (trap 9).
 *   5 DARK_WINDOW    the liveness tape itself has a hole over --dark-gap: the
 *                    scheduler was dark for EVERYTHING, whether or not any
 *                    routine was due. Outranks SLOT_LOSS because it is the
 *                    single cause the per-routine rows are symptoms of; those
 *                    rows still print underneath, nothing is swallowed.
 *
 * USAGE
 *   pnpm check:slot-loss
 *   pnpm check:slot-loss -- --days=14 --json
 *   pnpm check:slot-loss -- --late-ceiling=2160
 *   pnpm check:slot-loss -- --dark-gap=720
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
/**
 * Second bar (trap 9, TRA-4958). A run arriving between `--max-late` and this
 * is credited as LATE_SERVED, not counted LOST.
 *
 * 72h, from the measured dispatch-lateness distribution rather than taste: on
 * 2026-10-01 routine `11ff643f`'s ten fires landed at 19s, 18s, 13.1h, 23.9h,
 * 24.2h, 24.5h, 28.8h, 30.1h, 30.4h and 74.3h past their crons — only the two
 * 19s/18s fires clear the 6h bar above, which is why eight healthy dispatches
 * read as losses. 72h covers a weekend-long scheduler outage and still refuses
 * the 74.3h outlier.
 *
 * ⛔ Do NOT "fix" chronic lateness by raising `--max-late` instead. That buys a
 * false negative with the false positive: at a 36h bar `11ff643f` reads a
 * healthy 9/12 and BURIES its real 2026-08-17 / 08-24 outage. The two bars have
 * to stay separate so a dispatch failure and a late dispatch keep different
 * exit codes and different repairs.
 */
const DEFAULT_LATE_CEILING_MIN = 72 * 60;
/** A run may lead its slot by this much (scheduler clock skew / early claim). */
const EARLY_TOLERANCE_MIN = 2;
/** Below this, a single ragged slot is noise, not a finding. */
const DEFAULT_MIN_LOST = 2;
/**
 * Page size asked of /runs. Full page + oldest-inside-window => BLIND.
 *
 * Set to 1000 based on a 2026-08-27 census: across all 280 routines (1197 run
 * rows total, oldest 2026-05-02), the largest single history was 71 rows and no
 * page came back full. Server-side retention appears unbounded as measured, so
 * trap-3 BLIND paths only arm on truly pathological routines.
 */
const DEFAULT_RUN_LIMIT = 1000;
/** Refuses to enumerate a pathological cron (e.g. `* * * * *` over 90 days). */
const MAX_SLOTS_PER_TRIGGER = 20_000;

const VERDICT_EXIT = { CLEAN: 0, SLOT_LOSS: 1, BLIND: 3, LATE_DISPATCH: 4, DARK_WINDOW: 5 };

/**
 * Darkness bar (TRA-5055). See the header: 12h sits between the measured
 * healthy-band maximum (8.3h overnight host sleep) and the smallest real
 * occurrence (17.1h, TRA-4141).
 */
const DEFAULT_DARK_GAP_MIN = 12 * 60;
/** heartbeat-runs list cap — `offset`/`page`/`before` are IGNORED server-side. */
const HEARTBEAT_LIMIT = 1000;

/** One combined verdict for the exit code; every arm's rows still print. */
const VERDICT_PRECEDENCE = ['BLIND', 'DARK_WINDOW', 'SLOT_LOSS', 'LATE_DISPATCH', 'CLEAN'];
export function combineVerdicts(...verdicts) {
  // An unknown verdict ANYWHERE fails closed — checking only "is some known
  // verdict present" would let ('WAT', 'CLEAN') read CLEAN, the quiet-green
  // direction this whole file exists to refuse.
  if (verdicts.some((v) => !VERDICT_PRECEDENCE.includes(v))) return 'BLIND';
  for (const v of VERDICT_PRECEDENCE) if (verdicts.includes(v)) return v;
  return 'BLIND';
}

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
 *
 * TWO PASSES (trap 9, TRA-4958). Pass 1 credits runs inside `maxLateMs` —
 * SERVED. Pass 2 then offers the LEFTOVER runs to the LEFTOVER slots out to
 * `lateCeilingMs` — LATE_SERVED: a run demonstrably exists for that slot, it
 * just arrived past the bar. Over-crediting is structurally impossible: each
 * run index is consumed at most once and each slot is taken at most once, and
 * because pass 1 runs first a run always covers its OWN slot before it can be
 * spent on an older one.
 */
function assignRunsToSlots(slots, runs, { maxLateMs, earlyMs, lateCeilingMs = maxLateMs }) {
  const ordered = [...slots].sort((a, b) => a - b);
  const byNewest = [...runs].sort((a, b) => b.at - a.at);
  const taken = new Set();
  const consumed = new Set();

  const pass = (ceilingMs, sink) => {
    for (let ri = 0; ri < byNewest.length; ri += 1) {
      if (consumed.has(ri)) continue;
      const run = byNewest[ri];
      let best = -1;
      for (let i = ordered.length - 1; i >= 0; i -= 1) {
        const slot = ordered[i];
        if (taken.has(slot)) continue;
        if (run.at + earlyMs < slot) continue; // run predates this slot
        if (run.at - slot > ceilingMs) break; // and every earlier slot too
        best = i;
        break;
      }
      if (best !== -1) {
        taken.add(ordered[best]);
        consumed.add(ri);
        sink.set(ordered[best], run);
      }
    }
  };

  const served = new Map(); // slotMs -> run, within maxLate
  const lateServed = new Map(); // slotMs -> run, past maxLate but inside the ceiling
  pass(maxLateMs, served);
  if (lateCeilingMs > maxLateMs) pass(lateCeilingMs, lateServed);
  return { served, lateServed };
}

function gradeTrigger({ routine, trigger, runs, now, windowStartMs, graceMs, maxLateMs, lateCeilingMs, minLost }) {
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

  const { served, lateServed } = assignRunsToSlots(slots, mine, {
    maxLateMs,
    earlyMs: EARLY_TOLERANCE_MIN * MIN,
    lateCeilingMs: lateCeilingMs ?? maxLateMs,
  });
  // A slot is LOST only if NO run exists for it at either bar (trap 9).
  const lostSlots = slots.filter((s) => !served.has(s) && !lateServed.has(s));
  const lateSlots = slots.filter((s) => lateServed.has(s));
  const credited = [...served.keys(), ...lateServed.keys()];
  const suppressed = [...served.values(), ...lateServed.values()].filter((r) =>
    SUPPRESSED_STATUSES.has(r.status),
  ).length;

  // Determine clamping status (TRA-4167).
  let clampedBy = 'none';
  let firstLostCensored = false;
  if (lostSlots.length > 0) {
    const firstLost = lostSlots[0];
    const servedBeforeFirstLost = credited.some((s) => s < firstLost);

    // Birth clamp: the routine didn't exist before this window, and the first
    // expected slot is at/near its birth.
    if (fromMs === bornMs && bornMs > windowStartMs) {
      clampedBy = 'birth';
    }
    // Window clamp: the window opened after birth, AND no slots were served
    // before the first lost slot (i.e., we can't see the transition).
    else if (fromMs === windowStartMs && windowStartMs > bornMs && !servedBeforeFirstLost) {
      clampedBy = 'window';
      firstLostCensored = true;
    }
    // Otherwise: observed transition (we can see slots served, then stopped).
  }

  // Precedence inside a row: a genuine dispatch failure outranks chronic
  // lateness, which outranks a single ragged slot. Every count is carried on
  // the row either way, so neither hides behind the other (trap 9).
  const state =
    lostSlots.length >= minLost
      ? 'SLOT_LOSS'
      : lateSlots.length >= minLost
        ? 'LATE_DISPATCH'
        : lostSlots.length > 0
          ? 'RAGGED'
          : 'SERVED';
  const lateMinutes = [...lateServed.entries()].map(([slot, run]) => (run.at - slot) / MIN);
  return {
    ...base,
    state,
    windowStart: new Date(fromMs).toISOString(),
    windowStartMs: fromMs,
    bornMs,
    expected: slots.length,
    servedCount: served.size,
    suppressedCount: suppressed,
    lost: lostSlots.length,
    lostSlotMs: lostSlots.slice(),
    clampedBy,
    firstLostCensored,
    firstLostAt: lostSlots.length ? new Date(lostSlots[0]).toISOString() : null,
    lastLostAt: lostSlots.length ? new Date(lostSlots[lostSlots.length - 1]).toISOString() : null,
    lastServedAt: served.size ? new Date(Math.max(...served.keys())).toISOString() : null,
    // --- trap 9 fields (TRA-4958) ---
    lateCount: lateSlots.length,
    firstLateAt: lateSlots.length ? new Date(lateSlots[0]).toISOString() : null,
    lastLateAt: lateSlots.length ? new Date(lateSlots[lateSlots.length - 1]).toISOString() : null,
    maxLateObservedMin: lateMinutes.length ? Math.round(Math.max(...lateMinutes)) : null,
    /** Credited at EITHER bar — the honest "has this slot had a run" answer. */
    lastCreditedAt: credited.length ? new Date(Math.max(...credited)).toISOString() : null,
    /**
     * ⛔ `lastServedAt`/`lastCreditedAt` are WINDOW-SCOPED: they are computed
     * from slots inside the lookback only, so null means "no slot credited in
     * THIS window" and NEVER "this trigger has never fired". These two fields
     * are the universal, and the renderer must use them instead (trap 10).
     */
    runRowCount: mine.length,
    lastRunAt: mine.length ? new Date(Math.max(...mine.map((r) => r.at))).toISOString() : null,
  };
}

export async function sweep(transport, opts = {}) {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? DEFAULT_DAYS;
  const graceMs = (opts.graceMin ?? DEFAULT_GRACE_MIN) * MIN;
  const maxLateMs = (opts.maxLateMin ?? DEFAULT_MAX_LATE_MIN) * MIN;
  const lateCeilingMs = Math.max(maxLateMs, (opts.lateCeilingMin ?? DEFAULT_LATE_CEILING_MIN) * MIN);
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
      rows.push(
        gradeTrigger({ routine, trigger, runs, now, windowStartMs, graceMs, maxLateMs, lateCeilingMs, minLost }),
      );
    }
  }

  const blind = rows.filter((r) => r.state === 'BLIND');
  const findings = rows.filter((r) => r.state === 'SLOT_LOSS');
  const lateRows = rows.filter((r) => r.state === 'LATE_DISPATCH');
  const graded = rows.filter((r) => r.state !== 'BLIND');

  // Trap 7 — an empty census is unmeasured, not clean.
  let verdict;
  if (!graded.length) verdict = 'BLIND';
  else if (blind.length) verdict = 'BLIND';
  else if (findings.length) verdict = 'SLOT_LOSS';
  else if (lateRows.length) verdict = 'LATE_DISPATCH';
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
    lateCeilingMin: lateCeilingMs / MIN,
    routineCount: routines.length,
    gradedCount: graded.length,
    rows,
    blind,
    findings,
    lateRows,
    tally: rows.reduce((acc, r) => ((acc[r.state] = (acc[r.state] || 0) + 1), acc), {}),
  };
}

/* ==================================================================
 * Darkness (TRA-5055) — scheduler-dark windows off the liveness tape
 * ================================================================== */

/**
 * Find every hole over `darkGapMs` in the merged liveness tape that overlaps
 * [fromMs, toMs]. Windows are reported at their TRUE bounds (a gap that opened
 * before the lookback is still the gap it is); overlap with the lookback is
 * the admission test. A trailing hole against `toMs` (= now) is an ONGOING
 * dark window — the most actionable shape of all, so it must not wait for the
 * recovery tick that would close it.
 *
 * ⛔ A tape that opens AFTER `fromMs` leaves [fromMs, tapeStart) UNOBSERVED.
 * That span is named on the result and printed — it is an alarm, not a pass
 * (CLAUDE.md: absent evidence is its own state). It is not folded into a
 * window: a retention edge is not evidence of darkness either.
 */
export function deriveDarkWindows(ticksMs, { fromMs, toMs, darkGapMs }) {
  const ticks = [...new Set((ticksMs ?? []).filter((t) => Number.isFinite(t) && t <= toMs))].sort(
    (a, b) => a - b,
  );
  if (!ticks.length) {
    return { state: 'BLIND', reason: 'liveness tape empty — darkness unmeasurable', windows: [] };
  }
  const tapeStartMs = ticks[0];
  const windows = [];
  const push = (startMs, endMs, ongoing) => {
    const gapMs = endMs - startMs;
    if (gapMs <= darkGapMs) return;
    if (endMs < fromMs || startMs > toMs) return; // no overlap with the lookback
    windows.push({ startMs, endMs, gapMs, ongoing });
  };
  for (let i = 1; i < ticks.length; i += 1) push(ticks[i - 1], ticks[i], false);
  push(ticks[ticks.length - 1], toMs, true);
  return {
    state: 'OK',
    windows,
    tapeStartMs,
    tapeEndMs: ticks[ticks.length - 1],
    tickCount: ticks.length,
    unobservedMs: Math.max(0, tapeStartMs - fromMs),
  };
}

/**
 * Split one dark window into HOST-DOWN vs HOST-UP-BUT-SERVER-DARK off the
 * System event log. Down intervals are bracketed 6006 (clean shutdown) ->
 * 6005 (event log start = boot); 1074/109/6008 corroborate but do not
 * bracket — 6008's own TimeCreated is stamped at the NEXT boot, so it cannot
 * date when a crash took the host down.
 *
 *   events == null  => the log was unreadable: the split is NOT MEASURED
 *                      (hostDownMs null), never a fabricated zero.
 *   a 6005 with no prior 6006 => a crash boot: the down-start is unknowable,
 *                      so the split is kept but marked confidence 'partial'.
 *                      The conservative reading stands: unbracketed time
 *                      counts as HOST-UP-DARK, i.e. we never use a crash to
 *                      excuse the server side.
 */
export function splitGapByHostEvents(win, events) {
  if (!Array.isArray(events)) {
    return { hostDownMs: null, hostUpDarkMs: null, boots: null, confidence: 'NOT_MEASURED' };
  }
  const sorted = [...events]
    .filter((e) => Number.isFinite(e?.t))
    .sort((a, b) => a.t - b.t);
  const downs = [];
  let openDown = null;
  let partial = false;
  for (const e of sorted) {
    if (e.id === 6006) {
      if (openDown == null) openDown = e.t;
    } else if (e.id === 6005) {
      if (openDown != null) {
        downs.push([openDown, e.t]);
        openDown = null;
      } else if (e.t > win.startMs && e.t < win.endMs) {
        partial = true; // crash boot inside the window — down-start unknown
      }
    }
  }
  // A shutdown never followed by a boot: down through the end of evidence.
  if (openDown != null) downs.push([openDown, win.endMs]);

  let hostDownMs = 0;
  for (const [a, b] of downs) {
    hostDownMs += Math.max(0, Math.min(b, win.endMs) - Math.max(a, win.startMs));
  }
  const boots = sorted.filter((e) => e.id === 6005 && e.t > win.startMs && e.t < win.endMs).length;
  return {
    hostDownMs,
    hostUpDarkMs: win.gapMs - hostDownMs,
    boots,
    confidence: partial ? 'partial' : 'bracketed',
  };
}

/** Grade the darkness arm: windows + splits -> verdict + rows. */
export function gradeDarkness(tape, events, { fromMs, toMs, darkGapMs }) {
  const derived = deriveDarkWindows(tape, { fromMs, toMs, darkGapMs });
  if (derived.state === 'BLIND') {
    return { verdict: 'BLIND', reason: derived.reason, windows: [], unobservedMs: null };
  }
  const windows = derived.windows.map((w) => ({
    ...w,
    ...splitGapByHostEvents(w, events),
    start: new Date(w.startMs).toISOString(),
    end: new Date(w.endMs).toISOString(),
    gapHours: +(w.gapMs / HOUR).toFixed(2),
  }));
  return {
    verdict: windows.length ? 'DARK_WINDOW' : 'CLEAN',
    windows,
    darkGapMin: darkGapMs / MIN,
    tapeStart: new Date(derived.tapeStartMs).toISOString(),
    tapeEnd: new Date(derived.tapeEndMs).toISOString(),
    tickCount: derived.tickCount,
    unobservedMs: derived.unobservedMs,
    hostEventsRead: Array.isArray(events),
  };
}

/**
 * TRA-5258 — attribute each LOST slot to the dark span that actually contains
 * it. The old footer asserted every per-routine loss was a symptom of "this
 * single cause", which is false whenever a loss predates or falls between the
 * spans (2b3b32bc's 964h gap starts a month before the earliest span). Losses
 * outside every span are reported as their own UNATTRIBUTED bucket, never
 * folded into the newest span.
 */
export function attributeLosses(findings, windows) {
  const perWindow = windows.map(() => 0);
  let unattributed = 0;
  let total = 0;
  let unknown = 0;
  for (const f of findings || []) {
    if (!Array.isArray(f.lostSlotMs)) {
      unknown += f.lost || 0; // absent evidence is its own state, not "unattributed"
      continue;
    }
    for (const t of f.lostSlotMs) {
      total++;
      const i = windows.findIndex((w) => t >= w.startMs && t <= w.endMs);
      if (i >= 0) perWindow[i]++;
      else unattributed++;
    }
  }
  return { perWindow, unattributed, total, unknown };
}

function renderDarkReport(dark, { fromMs, days }, findings = []) {
  const out = [];
  out.push('');
  if (dark.verdict === 'BLIND') {
    out.push(`  DARKNESS ARM — BLIND: ${dark.reason}`);
    return out;
  }
  const h = (ms) => `${(ms / HOUR).toFixed(2)}h`;
  out.push(
    `  DARKNESS ARM — ${dark.verdict} · tape ${dark.tickCount} tick(s) ${dark.tapeStart} .. ${dark.tapeEnd} · bar ${dark.darkGapMin}min`,
  );
  if (dark.unobservedMs > 0) {
    out.push(
      `    ⚠ tape opens ${h(dark.unobservedMs)} AFTER the requested --days=${days} window start ` +
        `(${new Date(fromMs).toISOString()}) — that span is UNOBSERVED, not clean`,
    );
  }
  if (!dark.hostEventsRead) {
    out.push('    ⚠ host event log unreadable — every split below is NOT MEASURED, the gaps stand');
  }
  for (const w of dark.windows) {
    const split =
      w.hostDownMs == null
        ? 'split NOT MEASURED'
        : `host DOWN ${h(w.hostDownMs)} (${w.boots} boot(s)) · host UP server dark ${h(w.hostUpDarkMs)}` +
          (w.confidence === 'partial' ? ' · ⚠ crash boot inside — down-start unknown, split partial' : '');
    out.push(`    DARK ${w.gapHours}h  ${w.start} -> ${w.end}${w.ongoing ? '  ⚠ ONGOING' : ''}`);
    out.push(`        ${split}`);
  }
  if (dark.windows.length) {
    const at = attributeLosses(findings, dark.windows);
    out.push(`    LOST-SLOT ATTRIBUTION (${at.total} lost slot(s) across ${findings.length} finding(s)):`);
    dark.windows.forEach((w, i) => out.push(`      ${at.perWindow[i]} inside ${w.start} -> ${w.end}`));
    out.push(
      `      ${at.unattributed} UNATTRIBUTED (inside NO dark span above - a different cause, e.g. a scheduler freeze; do not read as these spans' symptoms)`,
    );
    if (at.unknown) out.push(`      ${at.unknown} NOT MEASURED (finding carried no slot list)`);
  }
  return out;
}

/* ================================================================== */

function renderReport(result, names = {}) {
  const out = [];
  const who = (id) => names[String(id ?? '').slice(0, 8)] || String(id ?? '').slice(0, 8) || '?';
  out.push(`check:slot-loss (TRA-4049) — ${result.verdict}`);
  out.push(
    `  window ${result.windowStart} .. now (${result.days}d) · ` +
      `graded ${result.gradedCount} trigger(s) across ${result.routineCount} routine(s) · ` +
      `min-lost ${result.minLost} · max-late ${result.maxLateMin}min · late-ceiling ${result.lateCeilingMin}min`,
  );
  out.push(`  tally ${JSON.stringify(result.tally)}`);

  /**
   * ⛔ trap 10 (TRA-4958). `lastCreditedAt` is WINDOW-SCOPED, so its null is
   * "no slot credited in this window" and NOT "never fired" — the word NEVER
   * used to be printed here and read as the universal, which sent a correct
   * `lost: 2` to the wrong owner with the wrong diagnosis. The run-row count is
   * the universal; print that instead and never collapse the two.
   */
  const credit = (f) => {
    if (f.lastCreditedAt) return `last served ${f.lastCreditedAt}`;
    if (!f.runRowCount) return 'no run row has EVER existed for this trigger';
    return `no slot credited in window (${f.runRowCount} run row(s) exist, newest ${f.lastRunAt})`;
  };
  const lateTail = (f) =>
    f.lateCount
      ? ` · +${f.lateCount} LATE-SERVED (worst +${f.maxLateObservedMin}min, inside the ${result.lateCeilingMin}min ceiling)`
      : '';

  if (result.findings?.length) {
    out.push('');
    out.push(`  SLOT LOSS (at --days=${result.days}) — ${result.findings.length} trigger(s) stopped serving their cron:`);
    out.push('    (LOST = no run exists for the slot at EITHER bar. Late-but-served slots are NOT counted here.)');
    for (const f of [...result.findings].sort((a, b) => b.lost - a.lost)) {
      out.push(
        `    ${f.routineShort}  LOST ${f.lost}/${f.expected}  ` +
          `${credit(f)}  owner ${who(f.assigneeAgentId)}${lateTail(f)}`,
      );
      out.push(`        cron ${JSON.stringify(f.cronExpression)} ${f.timezone ?? '(UTC assumed)'} — ${f.routineTitle}`);

      // Render firstLostAt based on clamp status (TRA-4167).
      let firstLostLine;
      if (f.clampedBy === 'window' && f.firstLostCensored) {
        firstLostLine = `        first lost >= ${f.firstLostAt}  (WINDOW EDGE at --days=${result.days} -- true onset is EARLIER; widen --days)`;
      } else if (f.clampedBy === 'birth') {
        const bornAt = f.bornMs ? new Date(f.bornMs).toISOString() : 'unknown';
        firstLostLine = `        first lost ${f.firstLostAt}  (SINCE BIRTH ${bornAt})`;
      } else {
        // Observed transition: served, then stopped.
        const context = f.lastCreditedAt ? ` (observed: served through ${f.lastCreditedAt})` : '';
        firstLostLine = `        first lost ${f.firstLostAt}${context}`;
      }
      out.push(`${firstLostLine} · last lost ${f.lastLostAt} · nextRunAt claims ${f.nextRunAt}`);
    }
  }

  if (result.lateRows?.length) {
    out.push('');
    out.push(
      `  LATE DISPATCH — ${result.lateRows.length} trigger(s) whose slots DID get a run, past the ` +
        `${result.maxLateMin}min bar:`,
    );
    out.push('    NOT a lost slot and NOT a broken routine — nothing on these rows needs re-arming.');
    out.push('    This is a SCHEDULER-LATENESS datum: the repair is to the dispatcher, not the trigger.');
    for (const f of [...result.lateRows].sort((a, b) => b.lateCount - a.lateCount)) {
      out.push(
        `    ${f.routineShort}  LATE ${f.lateCount}/${f.expected}  ` +
          `worst +${f.maxLateObservedMin}min  owner ${who(f.assigneeAgentId)}` +
          (f.lost ? `  (+${f.lost} genuinely lost, below the --min-lost=${result.minLost} bar)` : ''),
      );
      out.push(`        cron ${JSON.stringify(f.cronExpression)} ${f.timezone ?? '(UTC assumed)'} — ${f.routineTitle}`);
      out.push(`        first late ${f.firstLateAt} · last late ${f.lastLateAt} · ${credit(f)}`);
    }
  }

  const ragged = result.rows?.filter((r) => r.state === 'RAGGED') ?? [];
  if (ragged.length) {
    out.push('');
    out.push(`  RAGGED — ${ragged.length} trigger(s) below the --min-lost=${result.minLost} bar (not a finding):`);
    for (const r of ragged) {
      out.push(`    ${r.routineShort}  lost ${r.lost}/${r.expected}${lateTail(r)}  ${r.routineTitle.slice(0, 60)}`);
    }
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
  {
    name: 'TRA-4167 outcome CENSORED — window-clamped, no pre-loss slots served',
    expect: 'SLOT_LOSS',
    build: () => {
      const r = dailyRoutine({ createdAt: '2026-06-01T00:00:00Z' });
      r.triggers[0].createdAt = '2026-06-01T00:00:00Z';
      // Losing every slot for 30 days; graded at --days=14.
      return fakeTransport([r], { [r.id]: [] });
    },
    assert: (r) => {
      const f = r.findings[0];
      if (!f) return 'expected a finding';
      if (f.clampedBy !== 'window') return `expected clampedBy='window', got ${f.clampedBy}`;
      if (!f.firstLostCensored) return 'expected firstLostCensored=true';
      return true;
    },
  },
  {
    name: 'TRA-4167 outcome UNCENSORED — observed onset with last served slot',
    expect: 'SLOT_LOSS',
    build: () => {
      const r = dailyRoutine({ createdAt: '2026-06-01T00:00:00Z' });
      r.triggers[0].createdAt = '2026-06-01T00:00:00Z';
      // Served daily for 20 days, then silent for 10 days; graded at --days=14.
      const runs = [];
      for (let d = 10; d <= 25; d += 1) {
        const at = Date.parse('2026-08-26T13:00:00Z') - d * DAY;
        runs.push({ triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: iso(at) });
      }
      return fakeTransport([r], { [r.id]: runs });
    },
    assert: (r) => {
      const f = r.findings[0];
      if (!f) return 'expected a finding';
      if (f.clampedBy !== 'none') return `expected clampedBy='none' (observed), got ${f.clampedBy}`;
      if (f.firstLostCensored) return 'expected firstLostCensored=false for an observed onset';
      if (!f.lastServedAt) return 'expected lastServedAt to be populated for an observed onset';
      return true;
    },
  },
  {
    name: 'TRA-4167 outcome BIRTH-CLAMPED — born inside window, losing from first slot',
    expect: 'SLOT_LOSS',
    build: () => {
      const r = dailyRoutine({ createdAt: '2026-08-24T00:00:00Z' });
      r.triggers[0].createdAt = '2026-08-24T00:00:00Z';
      // Born 2026-08-24, expected slots at 13:00Z on 08-24 and 08-25, never served; graded at --days=14.
      // This gives 2 lost slots, meeting the minLost=2 threshold.
      return fakeTransport([r], { [r.id]: [] });
    },
    assert: (r) => {
      const f = r.findings[0];
      if (!f) return 'expected a finding';
      if (f.clampedBy !== 'birth') return `expected clampedBy='birth', got ${f.clampedBy}`;
      if (f.firstLostCensored) return 'expected firstLostCensored=false for a birth clamp';
      return true;
    },
  },

  /* ---- trap 9 / trap 10, TRA-4958 ------------------------------------- */
  {
    name: 'trap 9 — every slot served +7h is LATE_DISPATCH, never SLOT_LOSS',
    expect: 'LATE_DISPATCH',
    note: 'the 36.7% phantom-loss cohort: a run EXISTS for each slot, past the 6h bar',
    build: () => {
      const r = dailyRoutine();
      // One run 7h after every 13:00Z slot in the window — outside --max-late=6h,
      // and far from the NEXT slot (17h early), so pass 1 can credit none of them.
      const runs = [];
      for (let d = 1; d <= 14; d += 1) {
        const slot = Date.parse('2026-08-26T13:00:00Z') - d * DAY;
        runs.push({
          triggerId: 'tttttttt-0000-0000-0000-000000000001',
          status: 'completed',
          triggeredAt: iso(slot + 7 * HOUR),
        });
      }
      return fakeTransport([r], { [r.id]: runs });
    },
    assert: (r) => {
      const row = r.rows[0];
      if (row.state !== 'LATE_DISPATCH') return `expected state LATE_DISPATCH, got ${row.state}`;
      if (row.lost !== 0) return `a slot with a run must not be LOST (lost=${row.lost})`;
      if (row.lateCount !== row.expected) return `expected all ${row.expected} slots late, got ${row.lateCount}`;
      if (row.maxLateObservedMin !== 420) return `expected worst lateness 420min, got ${row.maxLateObservedMin}`;
      return true;
    },
  },
  {
    name: 'trap 9 — the SAME fixture at a single bar regresses to 14 phantom losses',
    expect: 'SLOT_LOSS',
    note: 'pins WHICH change rescues the cohort: collapse the ceiling onto --max-late and the bug is back',
    opts: { lateCeilingMin: DEFAULT_MAX_LATE_MIN },
    build: () => {
      const r = dailyRoutine();
      const runs = [];
      for (let d = 1; d <= 14; d += 1) {
        const slot = Date.parse('2026-08-26T13:00:00Z') - d * DAY;
        runs.push({
          triggerId: 'tttttttt-0000-0000-0000-000000000001',
          status: 'completed',
          triggeredAt: iso(slot + 7 * HOUR),
        });
      }
      return fakeTransport([r], { [r.id]: runs });
    },
    assert: (r) => {
      const f = r.findings[0];
      if (!f) return 'expected a finding';
      if (f.lateCount !== 0) return 'with one bar there is no LATE bucket to fall into';
      return f.lost === f.expected ? true : `expected all ${f.expected} slots lost, got ${f.lost}`;
    },
  },
  {
    name: 'trap 9 — SLOT_LOSS OUTRANKS LATE_DISPATCH, and both counts survive on the row',
    expect: 'SLOT_LOSS',
    note: 'a real dispatch failure must not be downgraded by late neighbours (nor hide them)',
    build: () => {
      const r = dailyRoutine();
      const runs = [];
      // 08-12..08-23 served +7h (late); 08-24 and 08-25 get no run at all.
      for (let d = 3; d <= 14; d += 1) {
        const slot = Date.parse('2026-08-26T13:00:00Z') - d * DAY;
        runs.push({
          triggerId: 'tttttttt-0000-0000-0000-000000000001',
          status: 'completed',
          triggeredAt: iso(slot + 7 * HOUR),
        });
      }
      return fakeTransport([r], { [r.id]: runs });
    },
    assert: (r) => {
      const f = r.findings[0];
      if (!f) return 'expected a finding';
      if (f.lost !== 2) return `expected exactly the 2 runless slots lost, got ${f.lost}`;
      if (f.lateCount !== 12) return `expected 12 late-served slots carried on the row, got ${f.lateCount}`;
      return true;
    },
  },
  {
    name: 'trap 9 — the late ceiling REFUSES an outlier: +30h credits, +80h stays LOST',
    expect: 'SLOT_LOSS',
    note: 'the 11ff643f weekly shape — the ceiling must not become a blanket amnesty',
    opts: { minLost: 1 },
    build: () => {
      const r = dailyRoutine();
      r.triggers[0].cronExpression = '0 13 * * 1'; // Mondays: 08-17 and 08-24 in window
      return fakeTransport([r], {
        [r.id]: [
          // 08-17 slot + 80h — BEYOND the 72h ceiling, so genuinely unserved.
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: iso(Date.parse('2026-08-17T13:00:00Z') + 80 * HOUR) },
          // 08-24 slot + 30h — inside the ceiling, so LATE and not a loss.
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: iso(Date.parse('2026-08-24T13:00:00Z') + 30 * HOUR) },
        ],
      });
    },
    assert: (r) => {
      const f = r.findings[0];
      if (!f) return 'expected a finding';
      if (f.expected !== 2) return `expected 2 Monday slots, got ${f.expected}`;
      if (f.lost !== 1) return `expected the +80h slot LOST, got lost=${f.lost}`;
      if (f.lateCount !== 1) return `expected the +30h slot LATE, got lateCount=${f.lateCount}`;
      if (f.firstLostAt !== '2026-08-17T13:00:00.000Z') return `wrong slot blamed: ${f.firstLostAt}`;
      return true;
    },
  },
  {
    name: 'trap 10 — out-of-window runs render the RUN-ROW COUNT, never the word NEVER',
    expect: 'SLOT_LOSS',
    note: 'the exact 11ff643f mis-report: --days=14 printed "last served NEVER" for a routine that had fired',
    build: () => {
      const r = dailyRoutine({ createdAt: '2026-07-01T00:00:00Z' });
      // The only run row predates the 14d window entirely.
      return fakeTransport([r], {
        [r.id]: [
          { triggerId: 'tttttttt-0000-0000-0000-000000000001', status: 'completed', triggeredAt: '2026-07-20T13:00:00Z' },
        ],
      });
    },
    assert: (r) => {
      const f = r.findings[0];
      if (!f) return 'expected a finding';
      if (f.lastCreditedAt !== null) return 'no slot in this window can be credited by a 07-20 run';
      if (f.runRowCount !== 1) return `expected runRowCount=1 (the universal), got ${f.runRowCount}`;
      if (f.lastRunAt !== '2026-07-20T13:00:00.000Z') return `expected lastRunAt off the run row, got ${f.lastRunAt}`;
      const text = renderReport(r).join('\n');
      if (/NEVER/.test(text)) return 'the word NEVER is still printed for a window-scoped null';
      if (!/1 run row\(s\) exist, newest 2026-07-20/.test(text)) return 'report does not state the run-row count';
      return true;
    },
  },
  {
    name: 'trap 10 — a trigger with ZERO run rows DOES earn the universal claim',
    expect: 'SLOT_LOSS',
    note: 'the honest "never" must stay sayable, or the fix trades one false reading for another',
    build: () => fakeTransport([dailyRoutine()], { 'aaaaaaaa-0000-0000-0000-000000000001': [] }),
    assert: (r) => {
      const f = r.findings[0];
      if (!f) return 'expected a finding';
      if (f.runRowCount !== 0) return `expected runRowCount=0, got ${f.runRowCount}`;
      const text = renderReport(r).join('\n');
      return /no run row has EVER existed for this trigger/.test(text)
        ? true
        : 'a genuinely never-fired trigger must say so';
    },
  },
];

/* ---- darkness controls (TRA-5055) ----------------------------------- */

const D_NOW = Date.parse('2026-10-04T12:00:00Z');
const D_FROM = D_NOW - 14 * DAY;
const DARK_GAP = DEFAULT_DARK_GAP_MIN * MIN;

/** Ticks every 30min across the window, minus holes given as [startIso, endIso]. */
function tapeWithHoles(holes = []) {
  const ticks = [];
  for (let t = D_FROM; t <= D_NOW; t += 30 * MIN) {
    const inHole = holes.some(([a, b]) => t > Date.parse(a) && t < Date.parse(b));
    if (!inHole) ticks.push(t);
  }
  for (const [a, b] of holes) {
    ticks.push(Date.parse(a), Date.parse(b)); // exact hole edges are real ticks
  }
  return ticks;
}

const DARK_CONTROLS = [
  {
    name: 'dark CLEAN — a fully ticking tape has no window',
    run: () => {
      const d = gradeDarkness(tapeWithHoles(), [], { fromMs: D_FROM, toMs: D_NOW, darkGapMs: DARK_GAP });
      return d.verdict === 'CLEAN' || `expected CLEAN, got ${d.verdict}`;
    },
  },
  {
    name: 'TRA-5258 — a lost slot outside every dark span is UNATTRIBUTED, never folded into a span; no slot list reads NOT MEASURED',
    run: () => {
      const W = [{ startMs: 1000, endMs: 2000 }];
      const at = attributeLosses([{ lost: 3, lostSlotMs: [500, 1500, 3000] }, { lost: 4 }], W);
      if (at.perWindow[0] !== 1) return `expected 1 inside the span, got ${at.perWindow[0]}`;
      if (at.unattributed !== 2) return `expected 2 unattributed, got ${at.unattributed}`;
      return at.unknown === 4 || `expected 4 NOT MEASURED, got ${at.unknown}`;
    },
  },
  {
    name: 'bar placement — 8.3h (measured overnight-sleep max) is NOT a window at the default bar',
    run: () => {
      const d = gradeDarkness(
        tapeWithHoles([['2026-09-24T01:57:00Z', '2026-09-24T10:15:00Z']]),
        [],
        { fromMs: D_FROM, toMs: D_NOW, darkGapMs: DARK_GAP },
      );
      return d.verdict === 'CLEAN' || `the healthy band must not read dark (got ${d.verdict})`;
    },
  },
  {
    name: 'bar placement — 17.1h (the smallest REAL occurrence, TRA-4141) IS a window',
    run: () => {
      const d = gradeDarkness(
        tapeWithHoles([['2026-09-24T01:00:00Z', '2026-09-24T18:06:00Z']]),
        [],
        { fromMs: D_FROM, toMs: D_NOW, darkGapMs: DARK_GAP },
      );
      if (d.verdict !== 'DARK_WINDOW') return `expected DARK_WINDOW, got ${d.verdict}`;
      const w = d.windows[0];
      if (w.start !== '2026-09-24T01:00:00.000Z' || w.end !== '2026-09-24T18:06:00.000Z') {
        return `window mis-dated: ${w.start} -> ${w.end}`;
      }
      return true;
    },
  },
  {
    name: 'THE BACK-FILED 09-21 OCCURRENCE — 32.9h gap splits 25.71h down / 7.18h up-dark off one boot',
    run: () => {
      // The real merged-tape edges and the real System-log events (2026-10-04 read).
      const a = Date.parse('2026-09-21T10:30:07.674Z');
      const b = Date.parse('2026-09-22T19:23:16.299Z');
      const d = gradeDarkness(
        [...tapeWithHoles(), a, b].filter((t) => t < Date.parse('2026-09-21T10:30:08Z') || t > Date.parse('2026-09-22T19:23:16Z')),
        [
          { t: Date.parse('2026-09-21T11:01:23Z'), id: 1074 },
          { t: Date.parse('2026-09-21T11:01:45Z'), id: 6006 },
          { t: Date.parse('2026-09-21T11:01:50Z'), id: 109 },
          { t: Date.parse('2026-09-22T12:44:08Z'), id: 6005 },
        ],
        { fromMs: Date.parse('2026-09-15T00:00:00Z'), toMs: D_NOW, darkGapMs: DARK_GAP },
      );
      const w = d.windows.find((x) => x.startMs === a);
      if (!w) return 'the 09-21 window was not found';
      if (Math.abs(w.gapMs / HOUR - 32.89) > 0.02) return `gap ${w.gapHours}h, expected ~32.89h`;
      if (Math.abs(w.hostDownMs / HOUR - 25.71) > 0.02) return `hostDown ${(w.hostDownMs / HOUR).toFixed(2)}h, expected ~25.71h`;
      if (w.boots !== 1) return `expected 1 boot, got ${w.boots}`;
      if (Math.abs((w.hostDownMs + w.hostUpDarkMs - w.gapMs)) > 1) return 'split does not sum to the gap';
      if (w.confidence !== 'bracketed') return `expected bracketed, got ${w.confidence}`;
      return true;
    },
  },
  {
    name: 'window A shape — a ~100%-host-down gap does NOT exercise the up-dark branch',
    run: () => {
      const a = Date.parse('2026-09-25T20:35:06Z');
      const b = Date.parse('2026-09-27T22:10:24Z');
      const w = { startMs: a, endMs: b, gapMs: b - a };
      const s = splitGapByHostEvents(w, [
        { t: Date.parse('2026-09-25T20:37:39Z'), id: 6006 },
        { t: Date.parse('2026-09-27T22:06:29Z'), id: 6005 },
      ]);
      if (s.hostDownMs / w.gapMs < 0.99) return `expected ~all down, got ${(s.hostDownMs / w.gapMs * 100).toFixed(1)}%`;
      return s.boots === 1 || `expected 1 boot, got ${s.boots}`;
    },
  },
  {
    name: 'window B shape — six boots, down intervals sum, up-dark branch exercised (the branch A cannot test)',
    run: () => {
      // The real 09-28 -> 10-01 event tape, verbatim from the System log
      // (2026-10-04 read). The measured split — 58.91h down / 27.05h up-dark —
      // reproduces TRA-5055's "~26.93h host-up-dark" prose figure to within
      // tick-source skew on the gap edges, which is the verification the issue
      // asked for: window A alone cannot exercise this branch.
      const a = Date.parse('2026-09-28T01:17:52.199Z');
      const b = Date.parse('2026-10-01T15:15:27.153Z');
      const w = { startMs: a, endMs: b, gapMs: b - a };
      const ev = [
        ['2026-09-28T01:22:41Z', 6006], ['2026-09-28T01:23:21Z', 6005],
        ['2026-09-28T08:59:08Z', 6006], ['2026-09-28T12:46:00Z', 6005],
        ['2026-09-28T14:54:54Z', 6006], ['2026-09-28T20:20:20Z', 6005],
        ['2026-09-28T20:57:52Z', 6006], ['2026-09-28T23:27:00Z', 6005],
        ['2026-09-29T00:10:45Z', 6006], ['2026-09-29T00:11:45Z', 6005],
        ['2026-09-29T16:01:48Z', 6006], ['2026-10-01T15:13:11Z', 6005],
      ].map(([t, id]) => ({ t: Date.parse(t), id }));
      const s = splitGapByHostEvents(w, ev);
      if (s.boots !== 6) return `expected 6 boots, got ${s.boots}`;
      if (s.hostUpDarkMs < 6 * HOUR) return 'the up-dark branch was not exercised';
      if (Math.abs(s.hostDownMs + s.hostUpDarkMs - w.gapMs) > 1) return 'split does not sum to the gap';
      if (Math.abs(s.hostDownMs / HOUR - 58.91) > 0.02) return `hostDown ${(s.hostDownMs / HOUR).toFixed(2)}h, expected ~58.91h`;
      if (Math.abs(s.hostUpDarkMs / HOUR - 27.05) > 0.02) return `upDark ${(s.hostUpDarkMs / HOUR).toFixed(2)}h, expected ~27.05h`;
      return true;
    },
  },
  {
    name: 'split NOT MEASURED — a null event tape yields null, never a fabricated zero',
    run: () => {
      const s = splitGapByHostEvents({ startMs: 0, endMs: DAY, gapMs: DAY }, null);
      if (s.hostDownMs !== null || s.hostUpDarkMs !== null) return 'split must be null when unmeasured';
      return s.confidence === 'NOT_MEASURED' || `expected NOT_MEASURED, got ${s.confidence}`;
    },
  },
  {
    name: 'no events in range — host up throughout, the WHOLE gap is server-dark',
    run: () => {
      const s = splitGapByHostEvents({ startMs: 0, endMs: DAY, gapMs: DAY }, []);
      if (s.hostDownMs !== 0) return `expected 0 down, got ${s.hostDownMs}`;
      return s.hostUpDarkMs === DAY || 'up-dark must equal the gap';
    },
  },
  {
    name: 'crash boot — a 6005 with no bracketing 6006 reads confidence partial, not a guess',
    run: () => {
      const s = splitGapByHostEvents(
        { startMs: 0, endMs: DAY, gapMs: DAY },
        [{ t: 12 * HOUR, id: 6005 }],
      );
      return s.confidence === 'partial' || `expected partial, got ${s.confidence}`;
    },
  },
  {
    name: 'ONGOING — a tape that stopped 20h ago is a live dark window ending at now',
    run: () => {
      const ticks = tapeWithHoles().filter((t) => t < D_NOW - 20 * HOUR);
      const d = gradeDarkness(ticks, [], { fromMs: D_FROM, toMs: D_NOW, darkGapMs: DARK_GAP });
      if (d.verdict !== 'DARK_WINDOW') return `expected DARK_WINDOW, got ${d.verdict}`;
      const w = d.windows[d.windows.length - 1];
      if (!w.ongoing) return 'the trailing hole must read ongoing';
      return w.endMs === D_NOW || 'an ongoing window ends at now';
    },
  },
  {
    name: 'empty tape — BLIND, never CLEAN',
    run: () => {
      const d = gradeDarkness([], [], { fromMs: D_FROM, toMs: D_NOW, darkGapMs: DARK_GAP });
      return d.verdict === 'BLIND' || `expected BLIND, got ${d.verdict}`;
    },
  },
  {
    name: 'short tape — the pre-tape span reads UNOBSERVED, named, not folded into a window',
    run: () => {
      const ticks = tapeWithHoles().filter((t) => t > D_FROM + 5 * DAY);
      const d = gradeDarkness(ticks, [], { fromMs: D_FROM, toMs: D_NOW, darkGapMs: DARK_GAP });
      if (d.verdict !== 'CLEAN') return `a retention edge is not darkness (got ${d.verdict})`;
      return d.unobservedMs >= 5 * DAY - HOUR || `unobserved span not named (${d.unobservedMs})`;
    },
  },
  {
    name: 'precedence — DARK_WINDOW outranks SLOT_LOSS, BLIND outranks both, late stays below loss',
    run: () => {
      if (combineVerdicts('SLOT_LOSS', 'DARK_WINDOW') !== 'DARK_WINDOW') return 'DARK_WINDOW must outrank SLOT_LOSS';
      if (combineVerdicts('DARK_WINDOW', 'BLIND') !== 'BLIND') return 'BLIND must outrank DARK_WINDOW';
      if (combineVerdicts('CLEAN', 'CLEAN') !== 'CLEAN') return 'two CLEANs are CLEAN';
      if (combineVerdicts('LATE_DISPATCH', 'CLEAN') !== 'LATE_DISPATCH') return 'LATE must survive a clean arm';
      if (combineVerdicts('WAT', 'CLEAN') !== 'BLIND') return 'an unknown verdict must fail closed';
      return true;
    },
  },
];

async function selftest() {
  let pass = 0;
  const seen = new Set();
  for (const c of CONTROLS) {
    const result = await sweep(c.build(), { now: T_NOW, days: DEFAULT_DAYS, ...(c.opts || {}) });
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
  let darkPass = 0;
  for (const c of DARK_CONTROLS) {
    let ok;
    let detail = '';
    try {
      const r = c.run();
      ok = r === true;
      if (!ok) detail = String(r);
    } catch (err) {
      ok = false;
      detail = String(err?.message ?? err);
    }
    if (ok) darkPass += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${detail ? ` — ${detail}` : ''}`);
  }

  const total = CONTROLS.length + DARK_CONTROLS.length;
  console.log(`\n${pass + darkPass}/${total} controls pass; verdicts reachable: ${[...seen].sort().join(', ')}`);
  for (const v of ['CLEAN', 'SLOT_LOSS', 'LATE_DISPATCH', 'BLIND']) {
    if (!seen.has(v)) console.log(`WARN  verdict ${v} was never reached by any control`);
  }
  return pass + darkPass === total ? 0 : 1;
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
    companyId: CO,
    listAgents: async () => unwrap(await get(`${BASE}/api/companies/${CO}/agents`), 'agents') || [],
    getRoutines: async () => unwrap(await get(`${BASE}/api/companies/${CO}/routines`), 'routines'),
    getRuns: async (id) => {
      const rows = unwrap(await get(`${BASE}/api/routines/${id}/runs?limit=${runLimit}`), 'runs');
      if (!Array.isArray(rows)) throw new Error('run history did not deserialise to an array');
      // Trap 3 — the page came back full, so there may be older rows we cannot see.
      rows.truncated = rows.length >= runLimit;
      return rows;
    },
    /**
     * The whole-process liveness tape (TRA-5055). Timestamps ONLY — the list
     * route strips `contextSnapshot`, so nothing else on these rows may be
     * graded. `offset`/`page`/`before` are ignored server-side; history past
     * this window comes from the ndjson arm below.
     */
    getHeartbeatTicks: async () => {
      const rows = unwrap(
        await get(`${BASE}/api/companies/${CO}/heartbeat-runs?limit=${HEARTBEAT_LIMIT}`),
        'heartbeatRuns',
      );
      if (!Array.isArray(rows)) throw new Error('heartbeat-runs did not deserialise to an array');
      return rows.map((r) => Date.parse(r?.createdAt ?? '')).filter(Number.isFinite);
    },
  };
}

/**
 * Extend the liveness tape past the heartbeat-runs 1000-row cap from the
 * local run logs: `data/run-logs/<companyId>/<agentId>/<runId>.ndjson`. Each
 * file's FIRST line carries `{"ts": ...}` — one liveness tick per run, read
 * off the first 300 bytes so 2k files stay cheap. Unreadable dir or files
 * return what could be read; the caller's coverage line names what the tape
 * actually spans, so a short ndjson arm cannot silently read as clean.
 */
async function readRunLogTicks(dir) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ticks = [];
  let agents;
  try {
    agents = fs.readdirSync(dir);
  } catch {
    return { ticks, readable: false };
  }
  const buf = Buffer.alloc(300);
  for (const agent of agents) {
    const ad = path.join(dir, agent);
    let files;
    try {
      if (!fs.statSync(ad).isDirectory()) continue;
      files = fs.readdirSync(ad);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.ndjson')) continue;
      try {
        const fd = fs.openSync(path.join(ad, f), 'r');
        const n = fs.readSync(fd, buf, 0, 300, 0);
        fs.closeSync(fd);
        const m = buf.toString('utf8', 0, n).match(/"ts":"([^"]+)"/);
        if (m) {
          const t = Date.parse(m[1]);
          if (Number.isFinite(t)) ticks.push(t);
        }
      } catch {
        /* one unreadable file is not a blind tape */
      }
    }
  }
  return { ticks, readable: true };
}

/**
 * Host boot/shutdown tape off the System event log, for the down/up-dark
 * split. Any failure returns null, which `splitGapByHostEvents` renders as
 * NOT MEASURED — the one thing this must never do is fabricate a split.
 */
async function readHostEvents(sinceMs) {
  const { execFile } = await import('node:child_process');
  const since = new Date(sinceMs).toISOString();
  // ⛔ Zero matching events is a TERMINATING error on Get-WinEvent, and it is
  // a truthful reading ("no boot/shutdown in range" => host up throughout),
  // NOT the unreadable-log case. The two must map to [] and null respectively.
  const ps =
    `try { $e = @(Get-WinEvent -FilterHashtable @{LogName='System'; Id=6005,6006,6008,1074,109; ` +
    `StartTime=[datetime]::Parse('${since}').ToLocalTime()} -ErrorAction Stop) } catch { ` +
    `if ($_.Exception.Message -match 'No events were found') { $e = @() } else { exit 1 } }; ` +
    `if ($e.Count -eq 0) { '[]' } else { ` +
    `ConvertTo-Json @($e | ForEach-Object { @{ t = $_.TimeCreated.ToUniversalTime().ToString('o'); id = $_.Id } }) -Compress }`;
  const out = await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
  if (out == null) return null;
  try {
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const events = rows
      .map((r) => ({ t: Date.parse(r?.t ?? ''), id: Number(r?.id) }))
      .filter((e) => Number.isFinite(e.t) && Number.isFinite(e.id));
    return events;
  } catch {
    return null;
  }
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
        '  --late-ceiling=N  minutes past --max-late a run still credits its slot as',
        '                  LATE_SERVED rather than LOST (default 4320 = 72h)',
        '  --min-lost=N    lost slots before a trigger is a finding (default 2)',
        '  --run-limit=N   /runs page size; a full page inside the window reads BLIND (default 1000)',
        '  --dark-gap=N    minutes of liveness-tape silence that reads DARK_WINDOW (default 720;',
        '                  the bar sits between 8.3h measured overnight quiet and the 17.1h',
        '                  smallest real occurrence — see header before moving it)',
        '  --run-logs-dir=P  ndjson run-log root for tape history past the 1000-row API cap',
        '                  (default <home>/.paperclip/instances/default/data/run-logs/<companyId>)',
        '  --no-host-split do not read the Windows event log (splits read NOT MEASURED)',
        '  --json          machine-readable',
        '  --selftest      run the controls',
        '',
        '  0 CLEAN · 1 SLOT_LOSS · 2 usage · 3 BLIND · 4 LATE_DISPATCH · 5 DARK_WINDOW;',
        '  BLIND > DARK_WINDOW > SLOT_LOSS > LATE_DISPATCH > CLEAN',
      ].join('\n'),
    );
    return 2;
  }
  if (argv.includes('--selftest')) return selftest();

  const transport = liveTransport();
  const days = numArg('days', DEFAULT_DAYS);
  const result = await sweep(transport, {
    days,
    graceMin: numArg('grace', DEFAULT_GRACE_MIN),
    maxLateMin: numArg('max-late', DEFAULT_MAX_LATE_MIN),
    lateCeilingMin: numArg('late-ceiling', DEFAULT_LATE_CEILING_MIN),
    minLost: numArg('min-lost', DEFAULT_MIN_LOST),
  });

  /* ---- darkness arm (TRA-5055) ---- */
  const now = result.now;
  const fromMs = now - days * DAY;
  const darkGapMs = numArg('dark-gap', DEFAULT_DARK_GAP_MIN) * MIN;
  let dark;
  try {
    const apiTicks = await transport.getHeartbeatTicks();
    const os = await import('node:os');
    const path = await import('node:path');
    const defaultLogDir = path.join(
      os.homedir(),
      '.paperclip', 'instances', 'default', 'data', 'run-logs',
      String(transport.companyId),
    );
    const logDirArg = argOf('run-logs-dir');
    const logDir = typeof logDirArg === 'string' ? logDirArg : defaultLogDir;
    const ndjson = await readRunLogTicks(logDir);
    const tape = [...apiTicks, ...ndjson.ticks];
    // The split's event query starts 8d before the window so a down interval
    // that opened before the lookback still brackets.
    const events = argv.includes('--no-host-split') ? null : await readHostEvents(fromMs - 8 * DAY);
    dark = gradeDarkness(tape, events, { fromMs, toMs: now, darkGapMs });
    dark.apiTickCount = apiTicks.length;
    dark.apiTapeTruncated = apiTicks.length >= HEARTBEAT_LIMIT;
    dark.ndjsonArm = ndjson.readable ? `${ndjson.ticks.length} tick(s) from ${logDir}` : `UNREADABLE: ${logDir}`;
  } catch (err) {
    // The tape being unreadable is not a clean scheduler (fail closed).
    dark = { verdict: 'BLIND', reason: `liveness tape unreadable: ${err.message}`, windows: [] };
  }

  const overall = combineVerdicts(result.verdict, dark.verdict);

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
        { issue: 'TRA-4049/TRA-5055', checkedAt: new Date().toISOString(), overall, darkness: dark, ...result },
        null,
        2,
      ),
    );
  } else {
    for (const l of renderReport(result, names)) console.log(l);
    for (const l of renderDarkReport(dark, { fromMs, days }, result.findings || [])) console.log(l);
    console.log(`\n  OVERALL ${overall} (routines ${result.verdict} · darkness ${dark.verdict})`);
  }
  return VERDICT_EXIT[overall] ?? 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('ERROR', err?.stack || err);
    process.exit(3);
  });
