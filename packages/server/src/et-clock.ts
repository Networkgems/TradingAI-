/**
 * TRA-2498 — the single ET wall-clock hour/minute helper, normalised so that
 * midnight is hour **0** on every runtime.
 *
 * ## Why this module exists
 *
 * Rendering ET time with a bare `hour12: false` is **not** portable. The hour
 * cycle it selects is ICU/Node-version dependent, and the two cycles disagree
 * on exactly one value — midnight:
 *
 * ```
 * new Date('2026-07-27T04:00:33Z')           // 00:00 ET
 *   .toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, … })
 *
 *   Node 20.19.0 (the prod runtime) → "07/27/2026, 24:00"   ← h24
 *   Node 22.14.0 (CI / dev)         → "07/27/2026, 00:00"   ← h23
 * ```
 *
 * A caller that regex-parses the hour therefore reads **24** for the whole
 * 00:00–00:59 ET window on prod. Every `hour >= N` gate silently passes at
 * midnight, which is how the 21:00 ET archive came to fire at 00:00 ET every
 * day and then dedup-suppress its own real evening fire (`lastArchiveDate` is
 * stamped with the already-new ET date). See TRA-2498 for the prod tape.
 *
 * ## The two layers
 *
 * 1. `formatEtClock` pins `hourCycle: 'h23'` explicitly, so the *formatter*
 *    emits `00` on both runtimes. Note this must NOT be combined with
 *    `hour12` — `hour12` takes precedence over `hourCycle` and would put us
 *    right back on the version-dependent path.
 * 2. `parseEtClockParts` folds the hour with `% 24` anyway, so a `24` that
 *    reaches the parser from any source still lands on `0`.
 *
 * Belt-and-braces is deliberate and matches the house idiom already used by
 * `parity-reconcile.ts` (`hourCycle: 'h23'` + `% 24`) and
 * `tradier/stocks-client.ts` (explicit `'24'` → `'00'` normalisation). The
 * failure mode is silent and only reproduces on a runtime CI does not run, so
 * one layer is not worth trusting.
 *
 * ## Testing note
 *
 * A test that feeds a real `Date` through the real formatter passes on Node 22
 * whether or not this normalisation exists — it cannot tell the fixed world
 * from the broken one. That is why the parse step is exported separately: it
 * takes a **string**, so `parseEtClockParts('07/27/2026, 24:00')` pins the
 * midnight contract on every Node version. That test is the regression lock;
 * the formatter test only guards the `hourCycle` option.
 */

/** ET wall-clock hour (0–23) and minute (0–59). */
export interface EtClockParts {
  hour: number;
  minute: number;
}

/**
 * `en-US` ET rendering with an explicit `h23` hour cycle — `MM/DD/YYYY, HH:MM`.
 * Deliberately omits `hour12`, which would override `hourCycle`.
 */
const ET_CLOCK_FORMAT: Intl.DateTimeFormatOptions = {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

/** Render `date` as ET `MM/DD/YYYY, HH:MM` with a version-stable hour cycle. */
export function formatEtClock(date: Date): string {
  return date.toLocaleString('en-US', ET_CLOCK_FORMAT);
}

/**
 * Parse an ET `MM/DD/YYYY, HH:MM` rendering into numeric parts, folding hour
 * 24 (h24 midnight) to 0. Returns `null` when the string does not parse.
 */
export function parseEtClockParts(rendered: string): EtClockParts | null {
  const match = rendered.match(/(\d+)\/(\d+)\/(\d+),\s+(\d+):(\d+)/);
  if (!match) return null;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // h24 renders midnight as 24:00–24:59; fold it onto 00:00–00:59.
  return { hour: hour % 24, minute };
}

/**
 * Current (or `date`'s) ET hour and minute, with midnight as hour 0.
 *
 * Falls back to `{ hour: 0, minute: 0 }` if the rendering cannot be parsed —
 * the same conservative default the previous inline parsers used. Every gate
 * in the codebase is of the form `hour >= N`, so hour 0 fails closed.
 */
export function etClockParts(date: Date = new Date()): EtClockParts {
  return parseEtClockParts(formatEtClock(date)) ?? { hour: 0, minute: 0 };
}

/** Current (or `date`'s) ET hour, 0–23. Convenience wrapper over `etClockParts`. */
export function etHour(date: Date = new Date()): number {
  return etClockParts(date).hour;
}
