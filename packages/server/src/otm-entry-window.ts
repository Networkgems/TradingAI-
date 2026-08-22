/**
 * TRA-3942 (parent TRA-3927, board card `a29b2db8` accepted 2026-08-22T04:18Z) —
 * WHEN the `single_leg_otm` sleeve is allowed to OPEN.
 *
 * ## What the tape said (finding F1)
 *
 * 15 of 17 live OTM entries filled **13:35–13:51Z** — the first ~20 minutes of
 * the session. That is the widest-spread, highest-IV-crush window of the day,
 * and it is not where the scanner was *aimed*: it is where the scanner *lands*,
 * because the overnight gap is the largest mispricing print on the chain and
 * `|mispricingPct|` is what the nominator ranks on. The sleeve was therefore
 * systematically reacting to the gap rather than to a confirmed intraday
 * structure, and paying the open's spread for the privilege.
 *
 * The board's remedy is a TIME gate, not a threshold: new OTM buys are refused
 * outside two ET windows —
 *
 *   • **10:15–11:30 ET** — after the opening range has resolved and the auction
 *     imbalance has cleared, while the day still has a session left to run;
 *   • **15:00–15:45 ET** — the afternoon trend leg, stopping 15 minutes before
 *     the close so an entry is never taken into the closing auction.
 *
 * Under EDT those are 14:15–15:30Z and 19:00–19:45Z, which is how the ticket
 * writes them. ⚠️ **They are ET windows, not UTC ones.** For the ~4 months a
 * year the session opens at 14:30Z instead of 13:30Z, the same two windows are
 * 15:15–16:30Z and 20:00–20:45Z. Nothing here stores a UTC offset: the verdict
 * is taken against the ET wall clock via {@link formatEtClock} /
 * {@link parseEtClockParts} (the TRA-2498 house helper, which is the only ET
 * reader in this repo that is stable across the h23/h24 ICU split), so DST is
 * handled by the tz database and never by an offset constant. A hard-coded
 * `-4` would silently move both windows an hour off the session on the first
 * Sunday in November — the exact class of defect `etWallClockToUtcMs` was
 * written for.
 *
 * ## Scope — ENTRY ONLY, and BOTH BOOKS
 *
 * This gate sits on the OPEN. It has no exit surface at all: nothing in
 * `checkExits`, in the harness-owned stops, or in any close path imports this
 * module, and that is a load-bearing property, not an accident. A time gate
 * that could also suppress an exit would convert a spread-hygiene rule into an
 * unbounded-loss rule — a row stopped out at 09:45 ET would be *held* instead.
 * (AC1's last clause, and the `does not export an exit predicate` test.)
 *
 * It applies to the PAPER book and the LIVE book alike. Paper is the mirror the
 * desk grades the live sleeve against; gating one and not the other makes the
 * mirror lie about the population it is mirroring.
 *
 * ## Fail direction
 *
 * CLOSED, in both of its two directions:
 *
 *   • an ET clock that cannot be read ⇒ REFUSE (`clockReadable: false`). We
 *     cannot prove the entry is inside a window, and the cost of a wrong refusal
 *     is one skipped scan; the cost of a wrong admit is the defect this ticket
 *     exists to remove.
 *   • a malformed `OTM_ENTRY_WINDOWS_ET` ⇒ the DEFAULTS (the board's ruling),
 *     with `source: 'env_invalid'` so the typo is visible on the wire rather
 *     than silently widening the sleeve to the whole session.
 *
 * Widening is spellable — `OTM_ENTRY_WINDOWS_ET=00:00-24:00` admits everything —
 * but only deliberately, and the effective windows are published on
 * `/api/health/options-live` so the state is read off the wire and never
 * inferred from a deploy SHA.
 */

import { formatEtClock, parseEtClockParts, etDateKey, etWallClockToUtcMs } from './et-clock.js';

/**
 * One admission window, as MINUTES PAST ET MIDNIGHT, half-open `[startMin,
 * endMin)`.
 *
 * Half-open is deliberate: an entry stamped exactly 11:30:00 ET is REFUSED.
 * The windows are written in the ticket as `10:15-11:30`, and both readings are
 * defensible in prose, so the tie is broken toward the tighter one — a boundary
 * fill is the least informative fill in the window and the direction of the
 * whole ticket is "fewer, better-timed entries".
 */
export interface OtmEntryWindow {
  startMin: number;
  endMin: number;
}

/** Where the effective windows came from. `env_invalid` makes a typo loud. */
export type OtmEntryWindowSource = 'default' | 'env' | 'env_invalid';

export interface OtmEntryWindowResolution {
  windows: readonly OtmEntryWindow[];
  source: OtmEntryWindowSource;
  /** The raw env string, trimmed, when one was set — for the health surface. */
  raw: string | null;
}

/** The env key. ET wall clock, `HH:MM-HH:MM[,HH:MM-HH:MM…]`. */
export const OTM_ENTRY_WINDOWS_VALUE = 'OTM_ENTRY_WINDOWS_ET';

/**
 * The board's ruling: 10:15–11:30 ET and 15:00–15:45 ET.
 * (615 = 10×60+15, 690 = 11×60+30, 900 = 15×60, 945 = 15×60+45.)
 */
export const OTM_ENTRY_WINDOWS_DEFAULT: readonly OtmEntryWindow[] = Object.freeze([
  Object.freeze({ startMin: 10 * 60 + 15, endMin: 11 * 60 + 30 }),
  Object.freeze({ startMin: 15 * 60, endMin: 15 * 60 + 45 }),
]) as readonly OtmEntryWindow[];

/**
 * The LOW-CARDINALITY reason code for a refusal (AC2). Folding on the prose
 * `reason` yields one bucket per decision and answers nothing; this is the
 * countable axis, and it is the string that appears in `rejectionsByGate` on
 * the OTM scan path and as `reasonCode` on the `entry_window` live-enforce gate.
 */
export const OTM_ENTRY_WINDOW_CLOSED_CODE = 'entry_window_closed';

/** Minutes-past-midnight → `HH:MM`. `1440` renders as `24:00`. */
export function formatEtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** `[{615,690},{900,945}]` → `10:15-11:30,15:00-15:45`. */
export function formatOtmEntryWindows(windows: readonly OtmEntryWindow[]): string {
  return windows.map((w) => `${formatEtMinutes(w.startMin)}-${formatEtMinutes(w.endMin)}`).join(',');
}

/** Parse one `HH:MM` into minutes past midnight, or `null`. `24:00` ⇒ 1440. */
function parseHhMm(token: string): number | null {
  const m = token.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
  const total = hour * 60 + minute;
  if (total > 24 * 60) return null;
  return total;
}

/**
 * Resolve the effective entry windows (TRA-3942).
 *
 * Accepts `HH:MM-HH:MM` pairs, comma separated, ET wall clock. Any malformed
 * token voids the WHOLE string — a partially-honoured list is a config that
 * means something nobody wrote — and resolves to the defaults with
 * `source: 'env_invalid'`.
 *
 * Windows are returned sorted by start. Overlap is not an error (the predicate
 * is an OR over the list), but an empty list IS: it would refuse every entry
 * forever, which is a disarm dressed as a window, and it resolves to
 * `env_invalid` instead.
 */
export function resolveOtmEntryWindows(
  env: NodeJS.ProcessEnv = process.env,
): OtmEntryWindowResolution {
  const rawValue = env[OTM_ENTRY_WINDOWS_VALUE];
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return { windows: OTM_ENTRY_WINDOWS_DEFAULT, source: 'default', raw: null };
  }
  const raw = rawValue.trim();
  const invalid = (): OtmEntryWindowResolution => ({
    windows: OTM_ENTRY_WINDOWS_DEFAULT,
    source: 'env_invalid',
    raw,
  });
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) return invalid();
  const windows: OtmEntryWindow[] = [];
  for (const part of parts) {
    const halves = part.split('-');
    if (halves.length !== 2) return invalid();
    const startMin = parseHhMm(halves[0]);
    const endMin = parseHhMm(halves[1]);
    if (startMin === null || endMin === null) return invalid();
    // Non-positive width is a typo, not a window: `[x, x)` admits nothing and a
    // reversed pair means the operator meant something else entirely.
    if (endMin <= startMin) return invalid();
    windows.push({ startMin, endMin });
  }
  windows.sort((a, b) => a.startMin - b.startMin);
  return { windows, source: 'env', raw };
}

/** The verdict for one candidate entry instant. */
export interface OtmEntryWindowVerdict {
  /** TRUE ⇒ the sleeve may open right now. */
  open: boolean;
  /** ET minutes past midnight at the decision instant; `null` if unreadable. */
  etMinutes: number | null;
  /** FALSE ⇒ the ET wall clock could not be parsed; the verdict is a fail-closed refusal. */
  clockReadable: boolean;
  /** The window that admitted the entry, when one did. */
  window: OtmEntryWindow | null;
  /** Prose reason, present only on a refusal. */
  reason: string | null;
  /** {@link OTM_ENTRY_WINDOW_CLOSED_CODE}, present only on a refusal. */
  reasonCode: string | null;
}

/**
 * Is the OTM ENTRY window open at `at`?
 *
 * PURE except for the ET rendering, and exported so AC1 can be proved on
 * instants rather than only through a live scan. `at` is the decision instant,
 * NOT a session date — a Saturday returns whatever its wall clock says, because
 * this gate is one cut among many and the trading-calendar question is owned
 * upstream (the scan does not run when the market is shut).
 */
export function otmEntryWindowVerdict(
  at: Date | number,
  resolution: OtmEntryWindowResolution = resolveOtmEntryWindows(),
): OtmEntryWindowVerdict {
  const date = at instanceof Date ? at : new Date(at);
  const parts = Number.isFinite(date.getTime()) ? parseEtClockParts(formatEtClock(date)) : null;
  const spec = formatOtmEntryWindows(resolution.windows);
  if (!parts) {
    return {
      open: false,
      etMinutes: null,
      clockReadable: false,
      window: null,
      reason:
        'OTM entry window (TRA-3942): the ET wall clock could not be read, so the entry cannot be '
        + `proved inside [${spec} ET] — fail-closed`,
      reasonCode: OTM_ENTRY_WINDOW_CLOSED_CODE,
    };
  }
  const etMinutes = parts.hour * 60 + parts.minute;
  const window = resolution.windows.find(
    (w) => etMinutes >= w.startMin && etMinutes < w.endMin,
  ) ?? null;
  if (window) {
    return { open: true, etMinutes, clockReadable: true, window, reason: null, reasonCode: null };
  }
  return {
    open: false,
    etMinutes,
    clockReadable: true,
    window: null,
    reason:
      `OTM entry window (TRA-3942): ${formatEtMinutes(etMinutes)} ET is outside the admitted `
      + `entry windows [${spec} ET] (source ${resolution.source}) — entry refused, exits unaffected`,
    reasonCode: OTM_ENTRY_WINDOW_CLOSED_CODE,
  };
}

/**
 * TRA-3953 (parent TRA-3942) — the OTM churn-brake, as a named constant.
 *
 * The `runOtmScan` dedup swallows a repeat nomination of the same OCC for an
 * hour so a chain that stays cheap across ~51 sweeps records ~1 verdict rather
 * than 51. That is deliberate and it stays. See
 * {@link otmDedupeSuppressionEndMs} for the one token it does NOT hold for the
 * full hour.
 */
export const OTM_DEDUPE_CHURN_BRAKE_MS = 60 * 60_000;

/**
 * TRA-3953 — the epoch-ms instant at which an entry window NEXT opens strictly
 * after `at`, or `null` if it cannot be resolved.
 *
 * ET, via the tz database, for the reason the whole module exists: the next
 * open is a WALL-CLOCK event, and `at + k` arithmetic against a stored offset
 * moves it an hour on the first Sunday in November.
 *
 * Searches today's ET calendar date and the next two, which is enough for any
 * window list: the ET date of `at + 24h` is not always `date(at) + 1` (a
 * fall-back day is 25 hours long and can return the SAME key), so the third
 * probe is what guarantees the following day is covered rather than assumed.
 * Duplicate keys are collapsed, so the cost is at most three date resolutions.
 *
 * Fails to `null` — never to a plausible-looking guess — when the ET clock is
 * unreadable. The caller's fallback is the unmodified 60-minute brake, i.e. a
 * broken clock buys today's behaviour, not a disarmed dedup.
 */
export function nextOtmEntryWindowOpenMs(
  at: Date | number,
  resolution: OtmEntryWindowResolution = resolveOtmEntryWindows(),
): number | null {
  const atMs = at instanceof Date ? at.getTime() : at;
  if (!Number.isFinite(atMs)) return null;
  let best: number | null = null;
  const seen = new Set<string>();
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const dateKey = etDateKey(atMs + dayOffset * 24 * 60 * 60_000);
    if (seen.has(dateKey)) continue;
    seen.add(dateKey);
    for (const w of resolution.windows) {
      // `24:00` is spellable as an END (`00:00-24:00`) but never as an open.
      if (w.startMin >= 24 * 60) continue;
      const open = etWallClockToUtcMs(dateKey, Math.floor(w.startMin / 60), w.startMin % 60);
      if (open === null || !Number.isFinite(open)) continue;
      if (open <= atMs) continue;
      if (best === null || open < best) best = open;
    }
  }
  return best;
}

/**
 * TRA-3953 — when the OTM dedup token written by `signal` stops suppressing.
 *
 * ## The defect this exists to remove
 *
 * TRA-3942's window reject parks the refused signal in `recentSignals` — the
 * house churn-brake pattern, so the refusal is on the feed and not only in the
 * log. But `recentSignals` is also the dedup ring, and the dedup matched on
 * `type` + `optionSymbol` and nothing else. **A refusal therefore wrote a
 * 60-minute admission token for the OCC it refused.** The suppressed
 * re-nomination `continue`s before it ever reaches the window check again, so
 * the OCC's first admissible retry was `first refusal + 60 min` — not "the
 * moment the window opens".
 *
 * Measured against the board's windows (10:15–11:30 and 15:00–15:45 ET): an OCC
 * first nominated at 10:14 ET lost 59 of the morning window's 75 minutes, and
 * one first nominated at 14:59 ET missed the entire 45-minute afternoon window
 * for that day. The gate narrowed the very window it was built to open.
 *
 * ## Why only the WINDOW token
 *
 * Every other cut on this path — the live universe, the delta ceiling/floor,
 * the cost bar — refuses a candidate that was **never tradeable**. Holding its
 * token for the full hour costs nothing, because nothing about the candidate
 * changes inside that hour. The window refuses a candidate that becomes
 * tradeable **minutes later**, on a schedule we already know exactly. Same
 * write, different consequence — so only this one token gets the shorter life,
 * at `min(t + 60 min, next window open)`.
 *
 * Everything else about the refusal write is unchanged: same `unshift`, same
 * alert, same `dailySignals` record, same `entry_window.evaluated` denominator.
 * And the brake is NOT disarmed — an OCC held out of window all session still
 * records a handful of verdicts, not one per sweep, because each refusal writes
 * a fresh token and the next open is at most one brake-length away.
 */
export function otmDedupeSuppressionEndMs(
  signal: { timestamp: number; signalSkipReasonCode?: string },
  resolution: OtmEntryWindowResolution = resolveOtmEntryWindows(),
): number {
  const churnBrakeEnd = signal.timestamp + OTM_DEDUPE_CHURN_BRAKE_MS;
  if (signal.signalSkipReasonCode !== OTM_ENTRY_WINDOW_CLOSED_CODE) return churnBrakeEnd;
  const nextOpen = nextOtmEntryWindowOpenMs(signal.timestamp, resolution);
  if (nextOpen === null) return churnBrakeEnd;
  return Math.min(churnBrakeEnd, nextOpen);
}

/**
 * The UTC rendering of the windows AT A GIVEN INSTANT, for the health surface.
 *
 * Deliberately computed rather than stored. It is the field that PROVES the DST
 * handling from outside: a grader reading in July sees `14:15-15:30`, the same
 * grader reading in January sees `15:15-16:30`, and the ET spec above it has not
 * moved. A stored UTC constant would read identically in both and would be wrong
 * in one of them.
 *
 * Returns `null` per window whose ET→UTC conversion cannot be resolved, rather
 * than a plausible-looking wrong number.
 */
export function otmEntryWindowsUtcAt(
  windows: readonly OtmEntryWindow[],
  at: Date | number = Date.now(),
): (string | null)[] {
  const date = at instanceof Date ? at : new Date(at);
  const parts = parseEtClockParts(formatEtClock(date));
  if (!parts) return windows.map(() => null);
  // The UTC offset in force on this ET day, in minutes: (UTC wall) − (ET wall).
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const etMinutes = parts.hour * 60 + parts.minute;
  // Fold onto (−720, 720] so a reading that straddles UTC midnight is correct.
  let offset = utcMinutes - etMinutes;
  if (offset > 720) offset -= 1440;
  if (offset <= -720) offset += 1440;
  return windows.map(
    (w) => `${formatEtMinutes((w.startMin + offset + 1440) % 1440)}Z`
      + `-${formatEtMinutes((w.endMin + offset + 1440) % 1440)}Z`,
  );
}
