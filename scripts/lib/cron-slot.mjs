/**
 * BACKWARD cron evaluation — "what slot was this fire SUPPOSED to be?" (TRA-3713)
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * The intended slot of a fire is NOT READABLE AFTER THE FACT. `trigger.nextRunAt` has
 * already rolled forward by the time anybody looks — to tomorrow on a daily, and to
 * 2027 on a date-pinned one-shot (`e7ccfe59` carries `nextRunAt: 2027-08-13T21:50Z` for
 * a fire that was meant to happen on 2026-08-13). Nothing on the routine, the trigger or
 * the run records the slot the fire was FOR. The only way back to it is to evaluate the
 * cron expression BACKWARDS from `lastRun.triggeredAt`, in the trigger's own timezone.
 *
 * ⛔ THE TIMEZONE IS PART OF THE ANSWER, NOT A DETAIL. Routine crons are evaluated in the
 * trigger's `timezone` and the fleet mixes them: `e7ccfe59` is `50 17 13 8 *` in
 * `America/New_York` (= 21:50Z) while `5293f29f` is `40 21 * * 1-5` in `UTC` (= 21:40Z).
 * A UTC-only evaluator gets the first one wrong by four hours — which is the same order
 * of magnitude as the lateness being measured, so it would not read as a bug, it would
 * read as a slightly different lateness. There is a control pinned on exactly that.
 *
 * ⛔ FAILS CLOSED, ALWAYS. Every path that cannot produce an answer returns
 * `{ ok: false, error }` and NEVER a best guess. A wrong slot does not produce a wrong
 * number, it produces a confident accusation against whoever owns the routine.
 *
 * NO DEPENDENCY. The repo has zero runtime deps by design (`package.json` `dependencies`
 * is `{}`), so this is hand-rolled against `Intl.DateTimeFormat`, which is the only
 * timezone database Node ships.
 */

// ─────────────────────────────────────────────────────────────────────────────
// TIMEZONE PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

const FMT_CACHE = new Map();

function formatterFor(timeZone) {
  let f = FMT_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    FMT_CACHE.set(timeZone, f);
  }
  return f;
}

/** Is this string a timezone Node's ICU actually knows? An unknown one THROWS, and a throw here would read as a crash rather than as BLIND. */
export function isKnownTimeZone(timeZone) {
  try {
    formatterFor(timeZone).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant, in a zone. */
export function partsIn(timeZone, ms) {
  const out = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  // ⛔ `hour12: false` still renders midnight as `24` on some ICU builds. Left alone that
  // makes 00:0x compare as LATER than every slot in the day, which silently pushes the
  // derivation back a whole day — a 24h error that looks like a plausible lateness.
  if (out.hour === 24) out.hour = 0;
  return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

/** The zone's UTC offset, in ms, AT a given instant (so DST is handled by lookup, never by a table). */
function offsetMsAt(timeZone, ms) {
  const p = partsIn(timeZone, ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * A wall-clock time in a zone → the UTC instant, or a NAMED refusal.
 *
 * ⛔ THE ROUND-TRIP CHECK IS LOAD-BEARING. On a spring-forward day the requested local
 * time DOES NOT EXIST (2026-03-08 in America/New_York goes 01:00 → 03:00, so 02:00 is
 * not a time). Without the check the two-pass offset solve returns a neighbouring
 * instant and the caller believes a slot occurred that never did. On a fall-back day the
 * local time exists TWICE; this returns the FIRST (earlier) occurrence, deterministically.
 *
 * @returns {{ ok: true, ms: number } | { ok: false, error: string }}
 */
export function wallToUtc(timeZone, y, mo, d, h, mi) {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = target - offsetMsAt(timeZone, target);
  guess = target - offsetMsAt(timeZone, guess);

  const back = partsIn(timeZone, guess);
  if (back.y !== y || back.mo !== mo || back.d !== d || back.h !== h || back.mi !== mi) {
    // Try one hour earlier/later before concluding it does not exist: the two-pass solve
    // can land on the wrong side of a transition when the slot is inside the shifted hour.
    for (const nudge of [-3600000, 3600000]) {
      const alt = guess + nudge;
      const p = partsIn(timeZone, alt);
      if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi) return { ok: true, ms: alt };
    }
    return {
      ok: false,
      error: `local time ${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')} does not exist in ${timeZone} (DST gap)`,
    };
  }
  return { ok: true, ms: guess };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON PARSING
// ─────────────────────────────────────────────────────────────────────────────

const BOUNDS = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7], // 0 and 7 are both Sunday
};

function parseField(raw, name) {
  const [lo, hi] = BOUNDS[name];
  const set = new Set();
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return { ok: false, error: `${name} field ${JSON.stringify(part)} is not a form this evaluator supports` };
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(step) || step < 1) return { ok: false, error: `${name} step ${JSON.stringify(m[2])} is not >= 1` };

    let from;
    let to;
    if (m[1] === '*') {
      from = lo;
      to = hi;
    } else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-').map(Number);
      from = a;
      to = b;
    } else {
      from = Number(m[1]);
      to = m[2] === undefined ? from : hi;
    }
    if (from < lo || to > hi || from > to) {
      return { ok: false, error: `${name} range ${JSON.stringify(m[1])} is outside ${lo}-${hi}` };
    }
    for (let v = from; v <= to; v += step) set.add(v);
  }
  if (set.size === 0) return { ok: false, error: `${name} field ${JSON.stringify(raw)} matches nothing` };
  return { ok: true, set };
}

/**
 * A 5-field cron expression → matchable sets, or a NAMED refusal.
 *
 * ⛔ NAMED MONTHS/DAYS (`JAN`, `MON`) AND `@daily`-STYLE MACROS ARE REFUSED, NOT GUESSED.
 * None are in use on this fleet today; the day one appears, this must report that it
 * cannot read the row rather than quietly derive a slot from a field it mis-parsed.
 *
 * ⛔ dom AND dow BOTH RESTRICTED IS REFUSED. Vixie cron ORs them ("13th OR a Monday");
 * several other implementations AND them. Nothing in the routine row says which one the
 * platform's scheduler is, and the two answers can be DAYS apart. There is no such row
 * on the fleet today, and inventing a semantics for the first one would be inventing the
 * lateness too.
 */
export function parseCron(expr) {
  if (typeof expr !== 'string' || expr.trim() === '') return { ok: false, error: 'empty cron expression' };
  const raw = expr.trim();
  if (raw.startsWith('@')) return { ok: false, error: `macro cron ${JSON.stringify(raw)} is not supported — refusing rather than guessing` };
  if (/[A-Za-z]/.test(raw)) return { ok: false, error: `named month/day cron ${JSON.stringify(raw)} is not supported — refusing rather than guessing` };

  const f = raw.split(/\s+/);
  if (f.length !== 5) return { ok: false, error: `expected 5 cron fields, got ${f.length} in ${JSON.stringify(raw)}` };

  const names = ['minute', 'hour', 'dom', 'month', 'dow'];
  const fields = {};
  for (let i = 0; i < 5; i += 1) {
    const p = parseField(f[i], names[i]);
    if (!p.ok) return p;
    fields[names[i]] = p.set;
  }
  // 7 and 0 are the same day; normalise so the dow test is a single lookup.
  if (fields.dow.has(7)) fields.dow.add(0);

  const domRestricted = !f[2].startsWith('*');
  const dowRestricted = !f[4].startsWith('*');
  if (domRestricted && dowRestricted) {
    return {
      ok: false,
      error: `cron ${JSON.stringify(raw)} restricts BOTH day-of-month and day-of-week — Vixie ORs them, other implementations AND them, and the routine row does not say which this scheduler is`,
    };
  }

  return { ok: true, cron: { raw, ...fields, domRestricted, dowRestricted } };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BACKWARD SOLVE
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LOOKBACK_DAYS = 400; // an annual one-shot's previous slot is up to a year back
const CONVERSION_CAP = 200_000; // a printed refusal, never a silent truncation

/**
 * The nearest cron slot on ONE side of an instant.
 *
 * ⛔ CANDIDATES ARE RANKED BY INSTANT, NOT BY WALL CLOCK. On a fall-back day a LATER
 * local time can be an EARLIER instant (01:45 EDT precedes 01:30 EST), so a
 * wall-clock-ordered scan with an early `continue` skips a slot that really happened.
 * Every candidate in a matching day is converted, and the extreme one on the requested
 * side wins.
 *
 * @param {'before'|'after'} side  `before` = latest slot <= atMs; `after` = earliest >= atMs
 * @returns {{ ok: true, slotMs: number, daysAway: number } | { ok: false, error: string }}
 */
function solveSlot(cronExpr, timeZone, atMs, side, opts = {}) {
  const horizonDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  if (!Number.isFinite(atMs)) return { ok: false, error: 'unreadable fire instant' };

  const tz = typeof timeZone === 'string' && timeZone !== '' ? timeZone : null;
  if (!tz) return { ok: false, error: 'trigger carries no timezone — refusing to assume UTC' };
  if (!isKnownTimeZone(tz)) return { ok: false, error: `timezone ${JSON.stringify(tz)} is unknown to this runtime's ICU` };

  const parsed = parseCron(cronExpr);
  if (!parsed.ok) return parsed;
  const { minute, hour, dom, month, dow, domRestricted, dowRestricted } = parsed.cron;

  const hours = [...hour].sort((a, b) => a - b);
  const minutes = [...minute].sort((a, b) => a - b);
  const at = partsIn(tz, atMs);
  const step = side === 'before' ? -1 : 1;
  let conversions = 0;

  for (let off = 0; off <= horizonDays; off += 1) {
    const day = new Date(Date.UTC(at.y, at.mo - 1, at.d) + step * off * 86400000);
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const wd = day.getUTCDay();

    if (!month.has(mo)) continue;
    // Exactly one of the two day fields can be restricted (parseCron refuses both), so
    // there is no OR/AND ambiguity left to resolve here.
    if (domRestricted && !dom.has(d)) continue;
    if (dowRestricted && !dow.has(wd)) continue;

    let best = null;
    for (const h of hours) {
      for (const mi of minutes) {
        conversions += 1;
        if (conversions > CONVERSION_CAP) {
          return { ok: false, error: `cron ${JSON.stringify(parsed.cron.raw)} exceeded the ${CONVERSION_CAP}-candidate cap before resolving a slot` };
        }
        const w = wallToUtc(tz, y, mo, d, h, mi);
        if (!w.ok) continue; // a slot inside a DST gap never occurred
        if (side === 'before' ? w.ms > atMs : w.ms < atMs) continue;
        if (best === null || (side === 'before' ? w.ms > best : w.ms < best)) best = w.ms;
      }
    }
    if (best !== null) return { ok: true, slotMs: best, daysAway: off };
  }

  return {
    ok: false,
    error: `no cron slot for ${JSON.stringify(parsed.cron.raw)} (${tz}) within ${horizonDays}d ${side} ${new Date(atMs).toISOString()}`,
  };
}

/** The LATEST cron slot at or before an instant. */
export function previousSlotAtOrBefore(cronExpr, timeZone, atMs, opts = {}) {
  return solveSlot(cronExpr, timeZone, atMs, 'before', opts);
}

/**
 * The EARLIEST cron slot at or after an instant.
 *
 * ⛔ NEEDED BECAUSE A FIRE CAN PRECEDE ITS OWN SLOT. Measured 2026-08-14 on `d038b618`:
 * a one-shot cron `45 21 14 8 *` (ET) whose `nextRunAt` is still 2026-08-15T01:45Z was
 * dispatched at 2026-08-14T01:20:56Z — 24h24m BEFORE the slot it exists for. Solving
 * only backwards answers that with the PREVIOUS year's slot and reports "8735h late",
 * against a routine that did not exist in 2025. A one-sided solver cannot produce a
 * lateness of the wrong sign; it produces a confident, enormous, wrong one.
 */
export function nextSlotAtOrAfter(cronExpr, timeZone, atMs, opts = {}) {
  return solveSlot(cronExpr, timeZone, atMs, 'after', opts);
}

/**
 * THE INTENDED SLOT — which slot this fire was FOR.
 *
 * ⛔⛔ "THE NEAREST SLOT" IS THE WRONG RULE, AND IT IS WRONG IN THE DIRECTION THAT
 * ERASES THE DEFECT. On a WEEKLY cron a replay more than half a week late is nearer to
 * the NEXT slot than to the one it missed, so a nearest-slot rule reports it as an EARLY
 * fire — a lost slot laundered into a harmless-looking one. Measured on the first live
 * sweep: `81928e50`, `a986323e` and `f28ea628` (all `30 16 * * 5` ET, all replayed by
 * the 2026-08-11T13:30Z drain) were 3d17h LATE off their 08-07 Friday slot, and the
 * nearest-slot rule called all three "3d7h early" against 08-14.
 *
 * ⭐ THE SCHEDULER ALREADY RECORDS THE ANSWER: `trigger.nextRunAt`. If it still points AT
 * the next slot, that slot has NOT been consumed, so this fire cannot be it — the fire
 * belongs to a PAST slot. All three rows above carry `nextRunAt: 2026-08-14T20:30Z`,
 * which settles it as data rather than as a distance comparison. A future slot is only
 * admissible when `nextRunAt` has moved BEYOND it, i.e. the scheduler says it was spent.
 *
 * ⛔⛔ `notBeforeMs` IS THE ROUTINE'S OWN `createdAt`, AND IT IS LOAD-BEARING. A routine
 * cannot have missed a slot it was never armed for. Without the floor, `618de42d`
 * (created 2026-08-13T15:45Z, weekly Mondays) grades against the Monday of 2026-08-11
 * and reports 72h of lateness for a window that closed two days before it existed — an
 * accusation manufactured out of calendar arithmetic, and the most plausible-looking
 * wrong answer available here, because 72h on a weekly cron reads exactly like a real
 * missed slot.
 *
 * ⛔ WHEN NEITHER SIDE IS ADMISSIBLE THE FIRE IS UNATTRIBUTABLE, AND THAT IS AN ANSWER.
 * `d038b618` was dispatched 2026-08-14T01:20:56Z while its only slot (2026-08-15T01:45Z)
 * was still armed and its routine did not exist at the previous one. Something fired it
 * OFF-CRON. Naming that is correct; turning it into "24h early" or "8735h late" is
 * inventing a lateness to have a number to report.
 *
 * @param {object} opts { notBeforeMs, nextRunAtMs, lookbackDays }
 * @returns {{ ok: true, slotMs, direction: 'late'|'early', deltaMs, prevMs, nextMs } | { ok: false, error: string }}
 */
export function attributeSlot(cronExpr, timeZone, atMs, opts = {}) {
  const prev = previousSlotAtOrBefore(cronExpr, timeZone, atMs, opts);
  const next = nextSlotAtOrAfter(cronExpr, timeZone, atMs, opts);

  // A parse/timezone refusal is identical on both sides; surface it once, not as "no slot".
  if (!prev.ok && !next.ok) return prev;

  const floor = Number.isFinite(opts.notBeforeMs) ? opts.notBeforeMs : -Infinity;
  const prevMs = prev.ok && prev.slotMs >= floor ? prev.slotMs : null;
  const nextMs = next.ok ? next.slotMs : null;

  // A fire a few seconds AHEAD of a slot is that slot, unambiguously — sub-tolerance
  // jitter is not an attribution question, and routing it through the rules below would
  // hand it to the PREVIOUS occurrence and report a full cadence of lateness.
  const tol = Number.isFinite(opts.earlyToleranceMs) ? opts.earlyToleranceMs : 0;
  if (nextMs !== null && nextMs - atMs <= tol) {
    return { ok: true, slotMs: nextMs, direction: 'early', deltaMs: nextMs - atMs, prevMs, nextMs };
  }

  // Otherwise a future slot counts ONLY if the scheduler has moved past it — a
  // still-armed slot is not one this fire consumed.
  const consumedNext = nextMs !== null && Number.isFinite(opts.nextRunAtMs) && opts.nextRunAtMs > nextMs;

  if (prevMs !== null && !(consumedNext && nextMs - atMs < atMs - prevMs)) {
    return { ok: true, slotMs: prevMs, direction: 'late', deltaMs: atMs - prevMs, prevMs, nextMs };
  }
  if (consumedNext) return { ok: true, slotMs: nextMs, direction: 'early', deltaMs: nextMs - atMs, prevMs, nextMs };
  if (prevMs !== null) return { ok: true, slotMs: prevMs, direction: 'late', deltaMs: atMs - prevMs, prevMs, nextMs };

  const why = [];
  if (prev.ok) why.push(`the last slot before it (${new Date(prev.slotMs).toISOString()}) PREDATES the routine's own creation`);
  else why.push(prev.error);
  if (nextMs !== null) {
    why.push(
      `the next slot (${new Date(nextMs).toISOString()}) is still ARMED` +
        `${Number.isFinite(opts.nextRunAtMs) ? ` (nextRunAt ${new Date(opts.nextRunAtMs).toISOString()})` : ' (nextRunAt unreadable)'}` +
        ', so this fire did not consume it',
    );
  }
  return { ok: false, error: `no slot this fire can be attributed to — ${why.join('; ')}` };
}
