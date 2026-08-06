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

/**
 * TRA-2689 — ET calendar date of an epoch-ms instant as `YYYY-MM-DD`.
 *
 * Lives here rather than being re-derived at the call site for the reason
 * `csp-report-collector.ts` already gives: an inline
 * `toLocaleDateString('en-CA', …)` forks the house ET helper, and the fork is
 * invisible until the two disagree. `en-CA` is the house idiom for this format
 * (`scheduler.ts`, `options-chain-recorder.ts`, `pnl-tracker.ts`); unlike the
 * hour, the *date* rendering carries no h23/h24 hazard, because the midnight
 * ambiguity is in the hour field only.
 *
 * NOTE this is a CALENDAR date, not a trading session: a Saturday instant
 * returns Saturday, and 20:00 ET on a trading day returns that day even though
 * the session has closed. Callers that need session semantics must say so.
 */
export function etDateKey(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * TRA-3116 — the UTC instant of an ET wall-clock time on an ET calendar date.
 *
 * The inverse of {@link etDateKey}, and it exists because the tape's coverage
 * stamp has to name the session window it is measuring against. The house had
 * only a hard-coded `13:30Z open / 20:00Z close` (exit-cadence-snapshot.ts),
 * which is EDT spelled as a constant: it is silently wrong for the ~4 months a
 * year the session opens at 14:30Z, and a coverage number that is an hour off
 * is worse than none because it grades a full session as partial (or, in
 * November, a partial one as full).
 *
 * Resolved by fixed point rather than by a DST table: guess the instant as if
 * ET were UTC, render THAT guess back in ET to read the offset actually in
 * force there, and re-guess. Two passes, because the first correction can land
 * on the other side of a transition; the loop exits early once it is stable.
 * Returns `null` on a malformed date key rather than a plausible-looking wrong
 * number — the caller publishes coverage as unknown instead.
 */
export function etWallClockToUtcMs(
  dateKey: string,
  hour: number,
  minute: number,
): number | null {
  const m = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute, 0, 0);
  if (!Number.isFinite(naive)) return null;
  let guess = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    const rendered = formatEtClock(new Date(guess)).match(/(\d+)\/(\d+)\/(\d+),\s+(\d+):(\d+)/);
    if (!rendered) return null;
    // The ET wall clock at `guess`, re-encoded as if it were UTC. The delta
    // between that and `guess` IS the UTC offset in force at `guess`.
    const wallAsUtc = Date.UTC(
      Number(rendered[3]),
      Number(rendered[1]) - 1,
      Number(rendered[2]),
      Number(rendered[4]) % 24,
      Number(rendered[5]),
      0,
      0,
    );
    const next = naive - (wallAsUtc - guess);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}
