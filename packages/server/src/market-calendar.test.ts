/**
 * TRA-4478 — fixtures for the exchange calendar.
 *
 * ⛔ Every date in here is written as a LITERAL, independently of the
 * generator's rules. A fixture that re-derives its expectation from the code
 * under test agrees with itself no matter what the code does; the generator's
 * own `--selftest` grades the rules, and this file grades the SHIPPED bundle
 * against dates checked off the exchange's published schedule.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  calendarCoverage,
  calendarCoversDate,
  calendarEntryGate,
  calendarFallbackCount,
  calendarFallbackDates,
  calendarFreshness,
  earlyCloseName,
  exchangeClosureName,
  isEarlyClose,
  isSessionDateOptimistic,
  resolveSessionDate,
  sessionCloseEtMinute,
  sessionOpenEtMinute,
  __resetCalendarFallbackCounter,
  CALENDAR_RUNWAY_WARN_DAYS,
  EARLY_CLOSE_ET_MINUTE,
  RTH_CLOSE_ET_MINUTE,
  RTH_OPEN_ET_MINUTE,
} from './market-calendar.js';
import { isMarketDayIso, isMarketOpen, previousMarketDayIso } from './scheduler.js';
import { DailyRiskGovernor } from './signal-engine.js';

beforeEach(() => {
  __resetCalendarFallbackCounter();
});

describe('coverage', () => {
  it('covers 2027 — the year the hand-typed table stopped at', () => {
    const cov = calendarCoverage();
    expect(cov.years).toContain(2027);
    expect(cov.start <= '2025-01-01').toBe(true);
    expect(cov.end >= '2027-12-31').toBe(true);
  });

  it('carries at least five years of runway past today', () => {
    // The whole defect was a table that ran out. A bundle that only just
    // reaches the present would reproduce it next January.
    const today = new Date().toISOString().slice(0, 10);
    const fresh = calendarFreshness(today);
    expect(fresh.status).toBe('fresh');
    expect(fresh.runwayDays).toBeGreaterThan(5 * 365);
  });

  it('reports coverage for a date inside the bundle and not for one outside', () => {
    expect(calendarCoversDate('2027-06-15')).toBe(true);
    expect(calendarCoversDate('1999-06-15')).toBe(false);
    expect(calendarCoversDate('2099-06-15')).toBe(false);
    expect(calendarCoversDate('not-a-date')).toBe(false);
  });

  it('⛔ the coverage FLOOR reaches the historical fixtures, not just "now"', () => {
    // A calendar that starts at the present refuses every past date, so a
    // replay run or a fixture pinned to a past instant halts. Caught during
    // TRA-4478 by `sma200-capital-gate.test.ts`, whose clock is 2024-06-04.
    expect(calendarCoversDate('2024-06-04')).toBe(true);
    expect(calendarEntryGate('2024-06-04').allowEntry).toBe(true); // a Tuesday
    expect(calendarCoverage().start <= '2024-01-01').toBe(true);
  });

  it('respects the two historical rule changes it now reaches back past', () => {
    // Emitting a holiday for a year before it existed mis-dates the fold in
    // exactly the same way as missing one after — and is quieter, because
    // nobody re-reads a 2019 fixture.
    expect(exchangeClosureName('2022-06-20')).toBe('Juneteenth National Independence Day');
    expect(resolveSessionDate('2021-06-18')).toBe('session'); // no Juneteenth before 2022
    expect(exchangeClosureName('2021-06-18')).toBeNull();
    // 2022-01-01 was a Saturday ⇒ no New Year's holiday; the NYSE traded
    // Friday 2021-12-31.
    expect(resolveSessionDate('2021-12-31')).toBe('session');
  });
});

describe('2027 holidays — the first miss', () => {
  // Published NYSE 2027 closures, transcribed by hand.
  const CLOSED_2027 = [
    '2027-01-01', // New Year's Day (Friday) — THE first miss
    '2027-01-18', // MLK Day
    '2027-02-15', // Washington's Birthday
    '2027-03-26', // Good Friday
    '2027-05-31', // Memorial Day
    '2027-06-18', // Juneteenth observed (Jun 19 is a Saturday)
    '2027-07-05', // Independence Day observed (Jul 4 is a Sunday)
    '2027-09-06', // Labor Day
    '2027-11-25', // Thanksgiving
    '2027-12-24', // Christmas observed (Dec 25 is a Saturday)
  ];

  it.each(CLOSED_2027)('%s is a closure, not a session', date => {
    expect(resolveSessionDate(date)).toBe('non_session');
    expect(exchangeClosureName(date)).not.toBeNull();
    expect(isMarketDayIso(date)).toBe(false);
  });

  it('2027-01-01 specifically — a Friday that the old weekday fallback called a market day', () => {
    // Regression pin for the exact incident. The old predicate was
    //   !MARKET_HOLIDAYS.has(d) && weekday   ⇒ true for a 2027 Friday.
    expect(new Date(Date.UTC(2027, 0, 1)).getUTCDay()).toBe(5); // it IS a Friday
    expect(isMarketDayIso('2027-01-01')).toBe(false);
    expect(exchangeClosureName('2027-01-01')).toBe("New Year's Day");
  });

  it('lists exactly those ten and no more for 2027', () => {
    const found: string[] = [];
    for (let t = Date.UTC(2027, 0, 1); t <= Date.UTC(2027, 11, 31); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (exchangeClosureName(d) !== null) found.push(d);
    }
    expect(found).toEqual(CLOSED_2027);
  });

  it('an ordinary 2027 weekday is still a session', () => {
    expect(resolveSessionDate('2027-01-04')).toBe('session'); // Monday
    expect(isMarketDayIso('2027-01-04')).toBe(true);
  });
});

describe('weekend observation rules', () => {
  it('Saturday holiday rolls BACK to the Friday', () => {
    // 2027-12-25 is a Saturday ⇒ observed Friday 2027-12-24.
    expect(new Date(Date.UTC(2027, 11, 25)).getUTCDay()).toBe(6);
    expect(exchangeClosureName('2027-12-24')).toBe('Christmas Day');
    expect(resolveSessionDate('2027-12-23')).toBe('session');
  });

  it('Sunday holiday rolls FORWARD to the Monday', () => {
    // 2027-07-04 is a Sunday ⇒ observed Monday 2027-07-05.
    expect(new Date(Date.UTC(2027, 6, 4)).getUTCDay()).toBe(0);
    expect(exchangeClosureName('2027-07-05')).toBe('Independence Day');
  });

  it('⛔ New Year on a SATURDAY is not observed at all — neither Friday nor Monday', () => {
    // The one exception to the roll-back rule, and the one a naive
    // implementation gets wrong. 2028-01-01 is a Saturday.
    expect(new Date(Date.UTC(2028, 0, 1)).getUTCDay()).toBe(6);
    expect(exchangeClosureName('2027-12-31')).toBeNull();
    expect(exchangeClosureName('2028-01-03')).toBeNull();
    expect(resolveSessionDate('2027-12-31')).toBe('session'); // Friday, open
    expect(resolveSessionDate('2028-01-03')).toBe('session'); // Monday, open
  });

  it('does not leak an observed date into the neighbouring year bundle', () => {
    // A per-year generator can lose a date at the seam. Every closure the
    // bundle carries must sit inside its own year.
    for (const year of calendarCoverage().years) {
      for (let t = Date.UTC(year, 0, 1); t <= Date.UTC(year, 11, 31); t += 86_400_000) {
        const d = new Date(t).toISOString().slice(0, 10);
        const dow = new Date(t).getUTCDay();
        if (exchangeClosureName(d) !== null) {
          expect(`${d} dow=${dow}`).toBe(`${d} dow=${dow}`);
          expect(dow === 0 || dow === 6).toBe(false); // never a weekend
        }
      }
    }
  });
});

describe('early closes', () => {
  it('the Friday after Thanksgiving closes at 13:00 ET', () => {
    expect(earlyCloseName('2027-11-26')).toBe('Day after Thanksgiving');
    expect(sessionCloseEtMinute('2027-11-26')).toBe(EARLY_CLOSE_ET_MINUTE);
    expect(sessionCloseEtMinute('2027-11-26')).toBe(13 * 60);
    // It is still a SESSION — just a short one.
    expect(resolveSessionDate('2027-11-26')).toBe('session');
    expect(isMarketDayIso('2027-11-26')).toBe(true);
    expect(sessionOpenEtMinute('2027-11-26')).toBe(RTH_OPEN_ET_MINUTE);
  });

  it('Christmas Eve on a weekday closes at 13:00 ET', () => {
    expect(earlyCloseName('2029-12-24')).toBe('Christmas Eve'); // a Monday
    expect(sessionCloseEtMinute('2029-12-24')).toBe(EARLY_CLOSE_ET_MINUTE);
  });

  it('July 3 on a weekday closes at 13:00 ET', () => {
    expect(earlyCloseName('2029-07-03')).toBe('Day before Independence Day'); // a Tuesday
    expect(sessionCloseEtMinute('2029-07-03')).toBe(EARLY_CLOSE_ET_MINUTE);
  });

  it('an ordinary session closes at 16:00 ET', () => {
    expect(isEarlyClose('2027-11-24')).toBe(false);
    expect(sessionCloseEtMinute('2027-11-24')).toBe(RTH_CLOSE_ET_MINUTE);
  });

  it('⛔ a full closure is never ALSO an early close', () => {
    // 2026-07-03 is the observed Independence Day, not a half day; 2027-12-24
    // is the observed Christmas. A naive "Jul 3 / Dec 24 are early closes" rule
    // marks both, and a caller reading `sessionCloseEtMinute` would then think
    // a shut exchange was open until 13:00.
    expect(exchangeClosureName('2026-07-03')).not.toBeNull();
    expect(earlyCloseName('2026-07-03')).toBeNull();
    expect(sessionCloseEtMinute('2026-07-03')).toBeNull();
    expect(exchangeClosureName('2027-12-24')).not.toBeNull();
    expect(earlyCloseName('2027-12-24')).toBeNull();
  });

  it('a weekend July 3 is not an early close', () => {
    expect(new Date(Date.UTC(2027, 6, 3)).getUTCDay()).toBe(6); // Saturday
    expect(earlyCloseName('2027-07-03')).toBeNull();
    expect(sessionCloseEtMinute('2027-07-03')).toBeNull();
  });

  it('a non-session date has no close time at all rather than a default one', () => {
    expect(sessionCloseEtMinute('2027-01-01')).toBeNull(); // holiday
    expect(sessionCloseEtMinute('2027-01-02')).toBeNull(); // Saturday
  });
});

describe('DST boundaries', () => {
  // The calendar is ET-date keyed and carries no UTC offsets, so a DST
  // transition must not move a session date. These are the 2027 transitions:
  // spring forward 2027-03-14, fall back 2027-11-07 (both Sundays).
  it('the spring-forward Sunday is not a session and the days either side are', () => {
    expect(resolveSessionDate('2027-03-12')).toBe('session'); // Fri before
    expect(resolveSessionDate('2027-03-14')).toBe('non_session'); // Sunday
    expect(resolveSessionDate('2027-03-15')).toBe('session'); // Mon after
  });

  it('the fall-back Sunday is not a session and the days either side are', () => {
    expect(resolveSessionDate('2027-11-05')).toBe('session'); // Fri before
    expect(resolveSessionDate('2027-11-07')).toBe('non_session'); // Sunday
    expect(resolveSessionDate('2027-11-08')).toBe('session'); // Mon after
  });

  it('day-of-week derivation is host-timezone-independent across a transition', () => {
    // Derived at UTC midnight, so a host in any zone reads the same day. This
    // is the TRA-3267 shape: two halves of a predicate disagreeing about the
    // day. Assert the DATE-ONLY value never shifts.
    for (const d of ['2027-03-13', '2027-03-14', '2027-03-15', '2027-11-06', '2027-11-07', '2027-11-08']) {
      expect(resolveSessionDate(d)).toBe(resolveSessionDate(d));
    }
    expect(previousMarketDayIso('2027-03-15')).toBe('2027-03-12');
    expect(previousMarketDayIso('2027-11-08')).toBe('2027-11-05');
  });
});

describe('asset classes', () => {
  it('options share the equities calendar', () => {
    expect(resolveSessionDate('2027-01-01', 'options')).toBe('non_session');
    expect(resolveSessionDate('2027-01-04', 'options')).toBe('session');
    expect(sessionCloseEtMinute('2027-11-26', 'options')).toBe(EARLY_CLOSE_ET_MINUTE);
  });

  it('crypto has NO exchange calendar — every day is a session', () => {
    expect(resolveSessionDate('2027-01-01', 'crypto')).toBe('session'); // NYSE holiday
    expect(resolveSessionDate('2027-01-02', 'crypto')).toBe('session'); // Saturday
    expect(resolveSessionDate('2099-01-01', 'crypto')).toBe('session'); // outside coverage
    expect(isEarlyClose('2027-11-26', 'crypto')).toBe(false);
    expect(sessionCloseEtMinute('2027-11-26', 'crypto')).toBeNull();
  });

  it('crypto entries are NOT gated by a stale NYSE bundle', () => {
    const gate = calendarEntryGate('2099-01-01', 'crypto');
    expect(gate.allowEntry).toBe(true);
    expect(gate.reason).toBeNull();
  });
});

describe('stale-calendar refusal', () => {
  it('⛔ an out-of-coverage date refuses ENTRY', () => {
    const gate = calendarEntryGate('2099-06-15');
    expect(gate.allowEntry).toBe(false);
    expect(gate.freshness).toBe('stale');
    expect(gate.session).toBe('uncovered');
    expect(gate.reason).toContain('makes NO statement');
  });

  it('⛔ it never refuses an EXIT', () => {
    for (const d of ['2099-06-15', 'garbage', '2027-01-01', '2027-01-04']) {
      expect(calendarEntryGate(d).allowExit).toBe(true);
    }
  });

  it('⛔ an unreadable date fails CLOSED, not open', () => {
    const gate = calendarEntryGate('garbage');
    expect(gate.allowEntry).toBe(false);
    expect(gate.freshness).toBe('unreadable');
    expect(calendarFreshness('garbage').status).toBe('unreadable');
    // "could not check" and "checked and it is covered" must not share a value
    expect(calendarFreshness('garbage').status).not.toBe('fresh');
  });

  it('a covered SESSION date allows entry', () => {
    const gate = calendarEntryGate('2027-01-04');
    expect(gate.allowEntry).toBe(true);
    expect(gate.freshness).toBe('fresh');
    expect(gate.reason).toBeNull();
  });

  it('a covered NON-session date refuses entry, but distinguishably from a stale one', () => {
    const gate = calendarEntryGate('2027-01-01');
    expect(gate.allowEntry).toBe(false);
    expect(gate.freshness).toBe('fresh'); // the CALENDAR is fine
    expect(gate.session).toBe('non_session'); // the EXCHANGE is shut
    expect(gate.reason).toContain("New Year's Day");
  });

  it('warns before the cliff rather than at it', () => {
    const end = calendarCoverage().end;
    const endMs = Date.parse(`${end}T00:00:00Z`);
    const inside = new Date(endMs - (CALENDAR_RUNWAY_WARN_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const warn = calendarFreshness(inside);
    expect(warn.status).toBe('expiring');
    // Expiring is still COVERED: it must not refuse entry, only nag.
    expect(calendarEntryGate(inside).freshness).toBe('expiring');
    const dayAfter = new Date(endMs + 86_400_000).toISOString().slice(0, 10);
    expect(calendarFreshness(dayAfter).status).toBe('stale');
    expect(calendarEntryGate(dayAfter).allowEntry).toBe(false);
  });
});

describe('the optimistic fallback is loud, not silent', () => {
  it('an uncovered weekday still reads as a session for EVIDENCE folds', () => {
    // Failing this closed would drop every row fleet-wide — the TRA-3267
    // incident shape. The safe direction here is the opposite of the entry
    // gate's, which is exactly why they are separate functions.
    expect(new Date(Date.UTC(2099, 5, 15)).getUTCDay()).toBe(1); // Monday
    expect(isSessionDateOptimistic('2099-06-15')).toBe(true);
    expect(isMarketDayIso('2099-06-15')).toBe(true);
  });

  it('an uncovered weekend still reads as a non-session', () => {
    expect(new Date(Date.UTC(2099, 5, 13)).getUTCDay()).toBe(6);
    expect(isSessionDateOptimistic('2099-06-13')).toBe(false);
  });

  it('every fallback is COUNTED, so an out-of-coverage host can never be quiet about it', () => {
    expect(calendarFallbackCount()).toBe(0);
    isSessionDateOptimistic('2099-06-15');
    isSessionDateOptimistic('2099-06-16');
    isSessionDateOptimistic('2099-06-15'); // repeat — counts the DATE, not the call
    expect(calendarFallbackCount()).toBe(2);
    expect(calendarFallbackDates()).toEqual(['2099-06-15', '2099-06-16']);
  });

  it('a COVERED date never increments the counter', () => {
    isSessionDateOptimistic('2027-01-01');
    isSessionDateOptimistic('2027-01-04');
    expect(calendarFallbackCount()).toBe(0);
  });

  it('a malformed date is not a session and is not counted as a fallback', () => {
    expect(isSessionDateOptimistic('garbage')).toBe(false);
    expect(calendarFallbackCount()).toBe(0);
  });
});

describe('isMarketOpen honours the early close', () => {
  // ⛔ `vi.setSystemTime` WITHOUT `useFakeTimers()` freezes `Date.now()` and
  // hangs any deadline loop, so the pair is mandatory here.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // 2027-11-26 is the Friday after Thanksgiving — a 13:00 ET close. November
  // is EST (UTC-5), so 12:59 ET = 17:59Z and 13:00 ET = 18:00Z.
  it('is open at 12:59 ET on a half day', () => {
    vi.setSystemTime(new Date(Date.UTC(2027, 10, 26, 17, 59, 0)));
    expect(isMarketOpen()).toBe(true);
  });

  it('⛔ is SHUT at 13:00 ET on a half day — it used to claim three more hours', () => {
    vi.setSystemTime(new Date(Date.UTC(2027, 10, 26, 18, 0, 0)));
    expect(isMarketOpen()).toBe(false);
  });

  it('is still open at 15:59 ET on an ORDINARY day', () => {
    // Wednesday 2027-11-24, same week, same DST offset — the control that
    // proves the case above is about the early close and not about November.
    vi.setSystemTime(new Date(Date.UTC(2027, 10, 24, 20, 59, 0)));
    expect(isMarketOpen()).toBe(true);
  });

  it('is shut at 16:00 ET on an ordinary day', () => {
    vi.setSystemTime(new Date(Date.UTC(2027, 10, 24, 21, 0, 0)));
    expect(isMarketOpen()).toBe(false);
  });

  it('is shut all day on a 2027 holiday', () => {
    vi.setSystemTime(new Date(Date.UTC(2027, 0, 1, 16, 0, 0))); // 11:00 ET New Year's Day
    expect(isMarketOpen()).toBe(false);
  });
});

describe('the risk governor is actually WIRED to the gate', () => {
  // Without these, `calendarEntryGate` is a correct function nobody calls —
  // the shape where a fix ships and the defect stays live. The governor takes
  // an injected clock, so no fake timers are needed: the ET date is driven by
  // the `now` the constructor is handed.
  const at = (isoInstant: string) => new DailyRiskGovernor(() => new Date(isoInstant));

  it('⛔ halts on an out-of-coverage ET date, with a distinguishable halt kind', () => {
    const gov = at('2099-06-15T14:00:00Z');
    expect(gov.isHalted()).toBe(true);
    expect(gov.getHaltKind()).toBe('calendar_stale');
    expect(gov.getHaltReason()).toContain('makes NO statement');
  });

  it('does NOT halt on a covered date', () => {
    const gov = at('2027-01-04T14:00:00Z');
    expect(gov.isHalted()).toBe(false);
    expect(gov.getHaltKind()).toBeNull();
    expect(gov.describeCalendarFreshness().status).toBe('fresh');
  });

  it('the gate is EQUITY/OPTIONS-only — the crypto halt path is untouched', () => {
    // `isHaltedExcludingFeedStale` is the leg crypto consults. A stale NYSE
    // bundle must not stop a 24/7 book that has no exchange calendar at all.
    const gov = at('2099-06-15T14:00:00Z');
    expect(gov.isHalted()).toBe(true);
    expect(gov.isHaltedExcludingFeedStale()).toBe(false);
  });

  it('reads the INJECTED clock, not the ambient one', () => {
    // A gate that read `new Date()` would return the same verdict for both of
    // these, and would silently disagree with every other day-keyed decision
    // made in the same tick.
    expect(at('2099-06-15T14:00:00Z').describeCalendarFreshness().asOf).toBe('2099-06-15');
    expect(at('2027-01-04T14:00:00Z').describeCalendarFreshness().asOf).toBe('2027-01-04');
  });

  it('uses the ET date, not the UTC one, at the evening boundary', () => {
    // 2036-01-01T02:00Z is 21:00 ET on 2035-12-31 — the last covered day. A
    // UTC-keyed gate would halt here; an ET-keyed one must not.
    const gov = at('2036-01-01T02:00:00Z');
    expect(gov.describeCalendarFreshness().asOf).toBe('2035-12-31');
    expect(gov.isHalted()).toBe(false);
  });

  it('self-clears the moment the date moves back inside coverage', () => {
    // The remedy is shipping a wider bundle, not clearing a latch. Prove there
    // is no latch: two governors, same process, opposite verdicts.
    expect(at('2099-06-15T14:00:00Z').isHalted()).toBe(true);
    expect(at('2027-01-04T14:00:00Z').isHalted()).toBe(false);
  });
});

describe('scheduler consumers keep their old behaviour on covered dates', () => {
  it('reproduces the retired hand-typed 2025/2026 table exactly', () => {
    // The generator's positive control, re-asserted against the SHIPPED bundle:
    // a rewrite that quietly dropped or moved a date would pass every test
    // above and still mis-date two years of existing evidence.
    const HAND = [
      '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
      '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
      '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    ];
    const found: string[] = [];
    for (let t = Date.UTC(2025, 0, 1); t <= Date.UTC(2026, 11, 31); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (exchangeClosureName(d) !== null) found.push(d);
    }
    expect(found).toEqual(HAND);
    for (const d of HAND) expect(isMarketDayIso(d)).toBe(false);
  });

  it('previousMarketDayIso skips a 2027 holiday it previously walked straight through', () => {
    // 2027-01-01 is a Friday holiday, so the session before Monday 2027-01-04
    // is Thursday 2026-12-31 — not the Friday. Under the old table this
    // returned '2027-01-01' and the continuity check compared across a closure.
    expect(previousMarketDayIso('2027-01-04')).toBe('2026-12-31');
  });
});
