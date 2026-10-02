import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EconomicCalendarClient, type MacroEvent } from '@trading-app/engine';
import {
  refreshMacroCalendar,
  eventsNearDate,
  eventsNearDateSync,
  daysToNextFOMC,
  daysToNextFOMCSync,
  daysToEvent,
  getUpcomingMacroEvents,
  initMacroStore,
  makeMacroClientFromEnv,
  lastMacroRefreshAttempt,
  noteMacroRefreshFailure,
  __resetMacroStoreForTests,
} from './macro-store.js';

let tmpRoot: string;

/** A client whose merged-window fetch is stubbed to return `events`. */
function stubClient(events: MacroEvent[]): EconomicCalendarClient {
  const client = new EconomicCalendarClient('test-key');
  vi.spyOn(client, 'getUpcomingEvents').mockResolvedValue(events);
  return client;
}

const asOf = Date.parse('2026-06-06T12:00:00Z');
function ev(type: MacroEvent['type'], date: string): MacroEvent {
  return { type, date, importance: 'high', title: type, source: type === 'FOMC' ? 'curated' : 'fred' };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'macro-store-test-'));
  __resetMacroStoreForTests(join(tmpRoot, 'economic-calendar.json'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetMacroStoreForTests(null);
  vi.restoreAllMocks();
});

describe('macro-store', () => {
  it('refreshes from the client and exposes proximity accessors', async () => {
    const client = stubClient([ev('CPI', '2026-06-11'), ev('FOMC', '2026-06-17'), ev('NFP', '2026-07-03')]);
    const res = await refreshMacroCalendar(client);
    expect(res.stored).toBe(3);
    expect(res.fomc).toBe(1);

    expect(await daysToNextFOMC(asOf)).toBe(11); // 06-06 → 06-17
    expect(await daysToEvent('CPI', asOf)).toBe(5); // 06-06 → 06-11
    // ±3 of 06-14 spans 06-11..06-17: CPI (-3) and FOMC (+3), NFP (07-03) excluded.
    expect((await eventsNearDate('2026-06-14', 3)).map((e) => e.type)).toEqual(['CPI', 'FOMC']);
    // Tighten to ±2 → only the FOMC on the 17th… no, 06-17 is +3, so neither; CPI is -3.
    expect((await eventsNearDate('2026-06-14', 2)).map((e) => e.type)).toEqual([]);
  });

  it('eventsNearDate widens with the window and stays sorted', async () => {
    await refreshMacroCalendar(stubClient([ev('CPI', '2026-06-11'), ev('FOMC', '2026-06-17')]));
    expect((await eventsNearDate('2026-06-14', 4)).map((e) => `${e.type}:${e.date}`)).toEqual([
      'CPI:2026-06-11',
      'FOMC:2026-06-17',
    ]);
  });

  it('getUpcomingMacroEvents drops past events relative to asOf', async () => {
    await refreshMacroCalendar(stubClient([ev('FOMC', '2026-04-29'), ev('FOMC', '2026-06-17')]));
    const upcoming = await getUpcomingMacroEvents(asOf);
    expect(upcoming.map((e) => e.date)).toEqual(['2026-06-17']);
  });

  it('persists across a cache reset (reload from disk) and warms the sync readers', async () => {
    await refreshMacroCalendar(stubClient([ev('FOMC', '2026-06-17'), ev('CPI', '2026-06-11')]));

    __resetMacroStoreForTests(join(tmpRoot, 'economic-calendar.json'));
    await initMacroStore();
    expect(daysToNextFOMCSync(asOf)).toBe(11);
    expect(eventsNearDateSync('2026-06-12', 1).map((e) => e.type)).toEqual(['CPI']);
  });

  it('sync readers return empty/null before the store is loaded', () => {
    expect(daysToNextFOMCSync(asOf)).toBeNull();
    expect(eventsNearDateSync('2026-06-17')).toEqual([]);
  });

  it('makeMacroClientFromEnv returns null when the key is unset', () => {
    const prev = process.env['FRED_API_KEY'];
    delete process.env['FRED_API_KEY'];
    expect(makeMacroClientFromEnv()).toBeNull();
    process.env['FRED_API_KEY'] = 'abc';
    expect(makeMacroClientFromEnv()).toBeInstanceOf(EconomicCalendarClient);
    if (prev === undefined) delete process.env['FRED_API_KEY'];
    else process.env['FRED_API_KEY'] = prev;
  });

  // ── TRA-4430 — the curated FOMC schedule is seeded WITHOUT a FRED key ──────
  describe('refreshMacroCalendar(null) — fomc-only seeding (TRA-4430)', () => {
    // Pinned so the test never depends on the wall clock: seed as of
    // 2026-09-01; the 2026-09-16 FOMC decision must land in the store.
    const seedAsOf = Date.parse('2026-09-01T12:00:00Z');

    it('a keyless refresh seeds curated FOMC rows — daysToNextFOMCSync is non-null before 2026-09-16', async () => {
      const res = await refreshMacroCalendar(null, { asOf: seedAsOf });
      expect(res.mode).toBe('fomc-only');
      expect(res.fomc).toBeGreaterThan(0);
      expect(res.stored).toBe(res.fomc); // nothing but curated rows on a cold keyless host

      // The acceptance read: a date before the 2026-09-16 decision day sees it.
      const before = Date.parse('2026-09-09T12:00:00Z');
      expect(daysToNextFOMCSync(before)).toBe(7); // 09-09 → 09-16
      expect(await daysToNextFOMC(before)).toBe(7);
    });

    it('a keyless refresh preserves previously-fetched FRED rows (never blanks them)', async () => {
      await refreshMacroCalendar(stubClient([ev('CPI', '2026-09-10'), ev('FOMC', '2026-09-16')]));
      const res = await refreshMacroCalendar(null, { asOf: seedAsOf });
      expect(res.mode).toBe('fomc-only');

      const events = await getUpcomingMacroEvents(seedAsOf);
      // The FRED-sourced CPI row survives; the curated FOMC rows are present.
      expect(events.some((e) => e.type === 'CPI' && e.source === 'fred')).toBe(true);
      expect(events.some((e) => e.type === 'FOMC' && e.date === '2026-09-16')).toBe(true);
    });

    it('the full path reports mode "full"', async () => {
      const res = await refreshMacroCalendar(stubClient([ev('FOMC', '2026-09-16')]));
      expect(res.mode).toBe('full');
    });

    it('fomc-only seeding survives a cache reset (persisted to disk)', async () => {
      await refreshMacroCalendar(null, { asOf: seedAsOf });
      __resetMacroStoreForTests(join(tmpRoot, 'economic-calendar.json'));
      await initMacroStore();
      expect(daysToNextFOMCSync(Date.parse('2026-09-09T12:00:00Z'))).toBe(7);
    });
  });

  // ── TRA-4430 — the last REAL refresh attempt, for /api/health/catalyst-gate ──
  // CLAUDE.md §1: the health field reports what the dependency DID, never our
  // intent; absent evidence is its own named state; a suppression on our side and
  // a vendor failure are different codes.
  describe('lastMacroRefreshAttempt — outcome of the last real attempt', () => {
    const seedAsOf = Date.parse('2026-09-01T12:00:00Z');

    it('reads never_attempted_this_boot before any refresh — not a pass, and not a failure', () => {
      const a = lastMacroRefreshAttempt();
      expect(a.outcome).toBe('never_attempted_this_boot');
      expect(a.attemptedAt).toBeNull();
      expect(a.stored).toBeNull();
      expect(a.failureSide).toBeNull();
    });

    it('a keyless refresh records ok_fomc_only with a timestamp and the rows it seeded', async () => {
      await refreshMacroCalendar(null, { asOf: seedAsOf });
      const a = lastMacroRefreshAttempt();
      expect(a.outcome).toBe('ok_fomc_only');
      expect(a.attemptedAt).not.toBeNull();
      expect(Number.isFinite(Date.parse(a.attemptedAt as string))).toBe(true);
      expect(a.fomc).toBeGreaterThan(0);
      expect(a.stored).toBe(a.fomc);
      // No vendor call was made on this path, so a 0 would be a fabricated
      // attribution: the field is null, and `mode`/`outcome` says why.
      expect(a.fredReleasesFailed).toBeNull();
      expect(a.failureSide).toBeNull();
    });

    it('a keyed refresh records ok_full and counts vendor-side per-release failures', async () => {
      const client = new EconomicCalendarClient('test-key');
      vi.spyOn(client, 'getUpcomingEvents').mockImplementation(async (_opts, onError) => {
        onError?.(10, new Error('FRED 429'));
        onError?.(50, new Error('FRED 429'));
        return [ev('FOMC', '2026-09-16')];
      });
      const res = await refreshMacroCalendar(client);
      expect(res.mode).toBe('full');
      expect(res.fredReleasesFailed).toBe(2);

      const a = lastMacroRefreshAttempt();
      expect(a.outcome).toBe('ok_full');
      expect(a.fredReleasesFailed).toBe(2); // they refused, not us
      expect(a.failureSide).toBeNull();
    });

    it('attributes a failure to the right side of the wire, and never rolls the two together', () => {
      noteMacroRefreshFailure('ENOSPC writing economic-calendar.json', 'local');
      let a = lastMacroRefreshAttempt();
      expect(a.outcome).toBe('failed');
      expect(a.failureSide).toBe('local');
      expect(a.reason).toContain('ENOSPC');

      noteMacroRefreshFailure('fetch failed', 'unattributed');
      a = lastMacroRefreshAttempt();
      expect(a.failureSide).toBe('unattributed');
      // A failed attempt must not publish stale row counts from an older success.
      expect(a.stored).toBeNull();
      expect(a.fomc).toBeNull();
    });

    it('a successful refresh clears a prior failure (the LAST attempt is what is reported)', async () => {
      noteMacroRefreshFailure('fetch failed', 'unattributed');
      await refreshMacroCalendar(null, { asOf: seedAsOf });
      expect(lastMacroRefreshAttempt().outcome).toBe('ok_fomc_only');
      expect(lastMacroRefreshAttempt().reason).toBeNull();
    });
  });
});
