/**
 * TRA-4478 — the single exchange-calendar interface.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * `scheduler.ts` carried `MARKET_HOLIDAYS`, a hand-typed `Set` of 2025 and 2026
 * dates, and `isMarketDayIso` fell through to a bare weekday check for anything
 * else. There were ZERO `2027-` dates anywhere in non-test server source, so
 * from **2027-01-01** (a Friday) every NYSE holiday would have read as an
 * ordinary trading day. Early closes were not modelled at all.
 *
 * The scheduling half of that is the loud half — the broker refuses an order on
 * a closed day. The quiet half is the damage this module actually exists to
 * stop: the SAME calendar keys EOD, risk-day and every per-ET-day fold, so a
 * wrong session boundary silently mis-dates the rows the live-capital promotion
 * gate reads. A promotion decision computed off a mis-dated fold looks
 * completely ordinary. (cf. TRA-4154 on per-ET-day rolls, and TRA-3267, where
 * the two halves of the session predicate disagreed about what day it was and
 * dropped every Friday EOD row fleet-wide.)
 *
 * ── The shape of the fix ────────────────────────────────────────────────────
 *
 * Exchange policy is DATA, generated from the observance rules by
 * `scripts/gen-nyse-calendar.mjs` into `data/nyse-calendar.generated.ts`, and
 * consumed through this one interface. Extending coverage is a re-run of the
 * generator, not a typing exercise, and `pnpm check:calendar-coverage` fails
 * long before the runway does.
 *
 * ⛔ COVERAGE HAS TWO EDGES AND BOTH ARE LOAD-BEARING. The bundle reaches back
 * to 2015, not to "now": a calendar starting at the present refuses every
 * historical date, so a replay run or a fixture pinned to a past instant reads
 * as uncovered and halts. That is not hypothetical — the first cut of this
 * module started at 2025 and turned `sma200-capital-gate.test.ts` (clock:
 * 2024-06-04) red. Reaching back also means reaching past two rule changes
 * (Juneteenth from 2022, MLK from 1998); see `EFFECTIVE_FROM` in the generator.
 *
 * ⛔ THE THREE-VALUED RESULT IS THE POINT. {@link resolveSessionDate} returns
 * `'uncovered'` — never a boolean — for a date outside the bundle. "The
 * calendar says this is a trading day" and "the calendar has no opinion and I
 * guessed from the day of week" must not share a value; that identity is the
 * defect this ticket is about. Callers that need a boolean pick their own
 * failure direction explicitly:
 *
 *   • ENTRY (opening risk) fails CLOSED — {@link calendarEntryGate}. An
 *     out-of-coverage date, or a calendar that cannot be resolved, refuses new
 *     entries. A calendar outage must never OPEN trading.
 *   • EXITS are never gated. Closing risk you already hold must not depend on
 *     the exchange calendar being current; a stale calendar that trapped you in
 *     a position would be strictly worse than the bug it guards against.
 *   • EVIDENCE (session-keyed folds, EOD writes) keeps the weekday fallback —
 *     see {@link isSessionDateOptimistic}. Failing those closed would drop every
 *     row fleet-wide, which is precisely the TRA-3267 incident shape. The
 *     fallback is instead COUNTED ({@link calendarFallbackCount}) and logged
 *     once per date, so it can never be silent.
 *
 * ── Asset classes ───────────────────────────────────────────────────────────
 *
 * Equities and options share the NYSE calendar: an option on a US equity does
 * not trade when its underlying's exchange is closed, and OCC holidays track
 * NYSE holidays. Crypto has NO exchange calendar — it is 24/7/365 — so it is
 * modelled as always-session and is deliberately exempt from the coverage gate.
 * A stale NYSE bundle is not a reason to stop trading Coinbase.
 */

import {
  NYSE_CALENDAR_VERSION,
  NYSE_CALENDAR_COVERAGE_START,
  NYSE_CALENDAR_COVERAGE_END,
  NYSE_CALENDAR_YEARS,
} from './data/nyse-calendar.generated.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'market-calendar' });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Which exchange calendar a caller is asking about.
 *
 * `equities` and `options` resolve to the SAME NYSE bundle — see the header.
 * They are distinct members anyway so a caller's intent is legible at the call
 * site and so a future divergence (an options-only holiday) has somewhere to
 * live without touching every caller.
 */
export type MarketAssetClass = 'equities' | 'options' | 'crypto';

/** Three-valued session verdict. See the ⛔ note in the module header. */
export type SessionResolution =
  /** The calendar covers this date and it is a trading session. */
  | 'session'
  /** The calendar covers this date and it is NOT a session (weekend or closure). */
  | 'non_session'
  /** ⛔ The calendar makes no statement about this date. NOT a verdict. */
  | 'uncovered';

/** Regular-session open, ET minutes past midnight (09:30). */
export const RTH_OPEN_ET_MINUTE = 9 * 60 + 30;
/** Regular-session close, ET minutes past midnight (16:00). */
export const RTH_CLOSE_ET_MINUTE = 16 * 60;
/** Early-close session close, ET minutes past midnight (13:00). */
export const EARLY_CLOSE_ET_MINUTE = 13 * 60;

// ── the bundle, indexed ──────────────────────────────────────────────────────

interface YearIndex {
  closures: Map<string, string>;
  earlyCloses: Map<string, string>;
}

const BY_YEAR: ReadonlyMap<number, YearIndex> = (() => {
  const m = new Map<number, YearIndex>();
  for (const y of NYSE_CALENDAR_YEARS) {
    m.set(y.year, {
      closures: new Map(y.closures.map(([d, n]) => [d, n])),
      earlyCloses: new Map(y.earlyCloses.map(([d, n]) => [d, n])),
    });
  }
  return m;
})();

/** The generated bundle's identity, so a live host can report WHICH calendar it runs. */
export const MARKET_CALENDAR_VERSION = NYSE_CALENDAR_VERSION;

export interface CalendarCoverage {
  version: string;
  /** First ET date the bundle makes a statement about, inclusive. */
  start: string;
  /** Last ET date the bundle makes a statement about, inclusive. */
  end: string;
  years: number[];
  /** Full closures across the whole bundle. */
  closureCount: number;
  /** 13:00 ET sessions across the whole bundle. */
  earlyCloseCount: number;
}

export function calendarCoverage(): CalendarCoverage {
  let closureCount = 0;
  let earlyCloseCount = 0;
  for (const y of NYSE_CALENDAR_YEARS) {
    closureCount += y.closures.length;
    earlyCloseCount += y.earlyCloses.length;
  }
  return {
    version: MARKET_CALENDAR_VERSION,
    start: NYSE_CALENDAR_COVERAGE_START,
    end: NYSE_CALENDAR_COVERAGE_END,
    years: NYSE_CALENDAR_YEARS.map(y => y.year),
    closureCount,
    earlyCloseCount,
  };
}

/**
 * Does the bundle make a statement about `dateIso`?
 *
 * A malformed date is NOT covered — "I could not parse it" and "it is outside
 * the bundle" both mean the calendar has no opinion, and both must fail entry
 * closed rather than fall through to a guess.
 */
export function calendarCoversDate(dateIso: string): boolean {
  if (!ISO_DATE.test(dateIso)) return false;
  const year = Number(dateIso.slice(0, 4));
  return BY_YEAR.has(year);
}

// ── closures and early closes ────────────────────────────────────────────────

function yearIndex(dateIso: string): YearIndex | null {
  if (!ISO_DATE.test(dateIso)) return null;
  return BY_YEAR.get(Number(dateIso.slice(0, 4))) ?? null;
}

/** 0=Sun … 6=Sat for a date-only value, parsed at UTC midnight so it is tz-independent. */
function isoDayOfWeek(dateIso: string): number {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isWeekend(dateIso: string): boolean {
  const dow = isoDayOfWeek(dateIso);
  return dow === 0 || dow === 6;
}

/**
 * The NYSE closure name for `dateIso`, or `null`.
 *
 * ⛔ `null` here means "not a listed closure", which for an UNCOVERED date is
 * indistinguishable from "the calendar has no opinion". Do not build a session
 * predicate on this — use {@link resolveSessionDate}, which separates the two.
 */
export function exchangeClosureName(dateIso: string): string | null {
  return yearIndex(dateIso)?.closures.get(dateIso) ?? null;
}

/** The 13:00 ET early-close name for `dateIso`, or `null`. Same ⛔ caveat as above. */
export function earlyCloseName(dateIso: string): string | null {
  return yearIndex(dateIso)?.earlyCloses.get(dateIso) ?? null;
}

/** Is `dateIso` a 13:00 ET early close? False for uncovered dates. */
export function isEarlyClose(dateIso: string, assetClass: MarketAssetClass = 'equities'): boolean {
  if (assetClass === 'crypto') return false;
  return earlyCloseName(dateIso) !== null;
}

// ── the session predicate ────────────────────────────────────────────────────

/**
 * Three-valued session verdict for `dateIso`. THE primary entry point.
 *
 * Crypto is always `'session'`: it has no exchange calendar, so there is no
 * coverage to be outside of.
 */
export function resolveSessionDate(
  dateIso: string,
  assetClass: MarketAssetClass = 'equities',
): SessionResolution {
  if (assetClass === 'crypto') return ISO_DATE.test(dateIso) ? 'session' : 'uncovered';
  if (!calendarCoversDate(dateIso)) return 'uncovered';
  if (isWeekend(dateIso)) return 'non_session';
  return exchangeClosureName(dateIso) === null ? 'session' : 'non_session';
}

/** How many distinct uncovered dates have fallen through to the weekday guess. */
let fallbackDates = new Set<string>();

/** Distinct uncovered dates that have taken the optimistic fallback since boot. */
export function calendarFallbackCount(): number {
  return fallbackDates.size;
}

/** Uncovered dates that have taken the optimistic fallback since boot, ascending. */
export function calendarFallbackDates(): string[] {
  return [...fallbackDates].sort();
}

/** Test-only: clear the fallback counter between cases. */
export function __resetCalendarFallbackCounter(): void {
  fallbackDates = new Set<string>();
}

/**
 * The EVIDENCE-side boolean: is `dateIso` a session, guessing from the day of
 * week when the calendar has no opinion?
 *
 * ⚠️ Named `Optimistic` on purpose. On an uncovered date this returns `true`
 * for any weekday, INCLUDING one that is really a holiday. That is the correct
 * direction for session-keyed folds and EOD writes — failing them closed would
 * drop every row fleet-wide (TRA-3267) — and the WRONG direction for anything
 * that opens risk, which must use {@link calendarEntryGate} instead.
 *
 * Every fallback is counted and logged once per date, so an out-of-coverage
 * host is never silent about it. (A suppression must ship a counter.)
 */
export function isSessionDateOptimistic(
  dateIso: string,
  assetClass: MarketAssetClass = 'equities',
): boolean {
  const res = resolveSessionDate(dateIso, assetClass);
  if (res !== 'uncovered') return res === 'session';
  if (!ISO_DATE.test(dateIso)) return false;
  if (!fallbackDates.has(dateIso)) {
    fallbackDates.add(dateIso);
    log.error('exchange calendar does not cover this date — falling back to a weekday guess', {
      date: dateIso,
      assetClass,
      calendarVersion: MARKET_CALENDAR_VERSION,
      coverageEnd: NYSE_CALENDAR_COVERAGE_END,
      distinctUncoveredDates: fallbackDates.size,
      remedy: 'raise COVERAGE_END_YEAR in scripts/gen-nyse-calendar.mjs and re-run it',
    });
  }
  return !isWeekend(dateIso);
}

/**
 * Minutes past ET midnight at which `dateIso`'s session closes, or `null` when
 * it is not a session (or the calendar has no opinion — `'uncovered'` never
 * yields a close time, because guessing one is how an early close gets missed).
 *
 * Crypto never closes and returns `null`; a caller wanting "is crypto open" is
 * asking the wrong question of this module.
 */
export function sessionCloseEtMinute(
  dateIso: string,
  assetClass: MarketAssetClass = 'equities',
): number | null {
  if (assetClass === 'crypto') return null;
  if (resolveSessionDate(dateIso, assetClass) !== 'session') return null;
  return isEarlyClose(dateIso, assetClass) ? EARLY_CLOSE_ET_MINUTE : RTH_CLOSE_ET_MINUTE;
}

/** Minutes past ET midnight at which `dateIso`'s session opens (always 09:30), or `null`. */
export function sessionOpenEtMinute(
  dateIso: string,
  assetClass: MarketAssetClass = 'equities',
): number | null {
  if (assetClass === 'crypto') return null;
  return resolveSessionDate(dateIso, assetClass) === 'session' ? RTH_OPEN_ET_MINUTE : null;
}

// ── the freshness alarm ──────────────────────────────────────────────────────

/** How close to the coverage cliff the alarm starts warning. */
export const CALENDAR_RUNWAY_WARN_DAYS = 180;

export type CalendarFreshnessStatus =
  /** Covered, with more than {@link CALENDAR_RUNWAY_WARN_DAYS} of runway left. */
  | 'fresh'
  /** Covered, but the cliff is inside the warning horizon. Extend the bundle. */
  | 'expiring'
  /** ⛔ The active date is outside coverage. Entries fail closed. */
  | 'stale'
  /** ⛔ The active date could not be parsed. Entries fail closed. */
  | 'unreadable';

export interface CalendarFreshness {
  status: CalendarFreshnessStatus;
  asOf: string;
  version: string;
  coverageStart: string;
  coverageEnd: string;
  /** Whole days from `asOf` to `coverageEnd`. Negative once past the cliff; `null` if unreadable. */
  runwayDays: number | null;
  statement: string;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * Grade the bundle's coverage of `asOfIso`.
 *
 * ⛔ FAILS CLOSED. An unparseable date reads `'unreadable'`, never `'fresh'`.
 * "Could not check" and "checked and it is covered" must not share a value.
 */
export function calendarFreshness(asOfIso: string): CalendarFreshness {
  const base = {
    asOf: asOfIso,
    version: MARKET_CALENDAR_VERSION,
    coverageStart: NYSE_CALENDAR_COVERAGE_START,
    coverageEnd: NYSE_CALENDAR_COVERAGE_END,
  };
  if (!ISO_DATE.test(asOfIso)) {
    return {
      ...base,
      status: 'unreadable',
      runwayDays: null,
      statement: `Active date '${asOfIso}' is not a YYYY-MM-DD ET date; the calendar cannot be graded against it.`,
    };
  }
  const runwayDays = daysBetween(asOfIso, NYSE_CALENDAR_COVERAGE_END);
  if (!calendarCoversDate(asOfIso) || asOfIso < NYSE_CALENDAR_COVERAGE_START || asOfIso > NYSE_CALENDAR_COVERAGE_END) {
    return {
      ...base,
      status: 'stale',
      runwayDays,
      statement:
        `Exchange calendar ${MARKET_CALENDAR_VERSION} covers ${NYSE_CALENDAR_COVERAGE_START}..${NYSE_CALENDAR_COVERAGE_END} ` +
        `and makes NO statement about ${asOfIso}. New entries are refused; exits are unaffected. ` +
        `Remedy: raise COVERAGE_END_YEAR in scripts/gen-nyse-calendar.mjs, re-run it, ship.`,
    };
  }
  if (runwayDays <= CALENDAR_RUNWAY_WARN_DAYS) {
    return {
      ...base,
      status: 'expiring',
      runwayDays,
      statement:
        `Exchange calendar ${MARKET_CALENDAR_VERSION} still covers ${asOfIso}, but only ${runwayDays} day(s) of ` +
        `runway remain (ends ${NYSE_CALENDAR_COVERAGE_END}). Extend it before the cliff, not after.`,
    };
  }
  return {
    ...base,
    status: 'fresh',
    runwayDays,
    statement:
      `Exchange calendar ${MARKET_CALENDAR_VERSION} covers ${asOfIso} with ${runwayDays} day(s) of runway ` +
      `(through ${NYSE_CALENDAR_COVERAGE_END}).`,
  };
}

export interface CalendarEntryGate {
  /** May the caller OPEN new risk on this date, as far as the calendar is concerned? */
  allowEntry: boolean;
  /** Always `true`. The calendar never traps a caller in a position. */
  allowExit: true;
  freshness: CalendarFreshnessStatus;
  /** `'session' | 'non_session' | 'uncovered'` for the graded date. */
  session: SessionResolution;
  assetClass: MarketAssetClass;
  /** Null when `allowEntry` is true. Never null when it is false. */
  reason: string | null;
}

/**
 * ⛔ THE FAIL-CLOSED ENTRY GATE. An exchange-calendar outage must never OPEN
 * trading, so an uncovered or unreadable active date refuses new entries.
 *
 * `allowExit` is hard-coded `true` and is not a field a caller may flip: a
 * stale calendar that stopped you closing a position would be strictly worse
 * than the mis-dating it exists to prevent.
 *
 * Crypto is exempt — it has no exchange calendar, so it can have no stale one.
 * Its entries are governed by the ordinary risk breakers, not by this.
 *
 * NOTE this gate refuses entry on a NON-SESSION covered date too (a weekend or
 * a holiday). That is not the calendar-freshness leg — it is the ordinary
 * "the exchange is shut" leg — and the two are distinguishable via `freshness`
 * and `session` rather than collapsed into the single boolean.
 */
export function calendarEntryGate(
  asOfIso: string,
  assetClass: MarketAssetClass = 'equities',
): CalendarEntryGate {
  if (assetClass === 'crypto') {
    return {
      allowEntry: true,
      allowExit: true,
      freshness: 'fresh',
      session: 'session',
      assetClass,
      reason: null,
    };
  }
  const fresh = calendarFreshness(asOfIso);
  const session = resolveSessionDate(asOfIso, assetClass);
  if (fresh.status === 'stale' || fresh.status === 'unreadable') {
    return {
      allowEntry: false,
      allowExit: true,
      freshness: fresh.status,
      session,
      assetClass,
      reason: fresh.statement,
    };
  }
  if (session !== 'session') {
    const name = exchangeClosureName(asOfIso);
    return {
      allowEntry: false,
      allowExit: true,
      freshness: fresh.status,
      session,
      assetClass,
      reason: name
        ? `${asOfIso} is an NYSE closure (${name}) — no new ${assetClass} entries.`
        : `${asOfIso} is not an NYSE session — no new ${assetClass} entries.`,
    };
  }
  return {
    allowEntry: true,
    allowExit: true,
    freshness: fresh.status,
    session,
    assetClass,
    reason: null,
  };
}
