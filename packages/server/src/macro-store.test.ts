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
});
