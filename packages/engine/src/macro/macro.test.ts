import { describe, it, expect } from 'vitest';
import {
  parseFredReleaseDates,
  eventsNearDate,
  nextEventOfType,
  daysToNextFOMC,
  fomcEvents,
  FOMC_MEETINGS,
  EconomicCalendarClient,
  type MacroEvent,
} from './macro-client.js';

const CPI_META = { type: 'CPI' as const, importance: 'high' as const, title: 'CPI (Consumer Price Index)' };

describe('parseFredReleaseDates', () => {
  it('parses release_dates rows and tags them with the supplied metadata', () => {
    const payload = {
      release_dates: [
        { release_id: 10, date: '2026-06-11' },
        { release_id: 10, date: '2026-07-15' },
      ],
    };
    const events = parseFredReleaseDates(payload, CPI_META);
    expect(events).toEqual([
      { type: 'CPI', date: '2026-06-11', importance: 'high', title: CPI_META.title, source: 'fred' },
      { type: 'CPI', date: '2026-07-15', importance: 'high', title: CPI_META.title, source: 'fred' },
    ]);
  });

  it('drops rows with a missing or malformed date and tolerates junk payloads', () => {
    const payload = {
      release_dates: [
        { release_id: 10, date: '2026-06-11' },
        { release_id: 10, date: 'not-a-date' },
        { release_id: 10 },
        null,
        42,
      ],
    };
    expect(parseFredReleaseDates(payload, CPI_META)).toHaveLength(1);
    expect(parseFredReleaseDates(null, CPI_META)).toEqual([]);
    expect(parseFredReleaseDates({}, CPI_META)).toEqual([]);
    expect(parseFredReleaseDates({ release_dates: 'x' }, CPI_META)).toEqual([]);
  });
});

describe('eventsNearDate', () => {
  const events: MacroEvent[] = [
    { type: 'CPI', date: '2026-06-10', importance: 'high', title: 'CPI', source: 'fred' },
    { type: 'FOMC', date: '2026-06-17', importance: 'high', title: 'FOMC', source: 'curated' },
    { type: 'NFP', date: '2026-07-03', importance: 'high', title: 'NFP', source: 'fred' },
  ];

  it('returns events within ±window days of the anchor, sorted ascending', () => {
    const near = eventsNearDate(events, '2026-06-14', 3);
    expect(near.map((e) => e.type)).toEqual(['FOMC']); // 17th is 3 days out; 10th is 4 days back
  });

  it('is inclusive at the window boundary and widens with the window', () => {
    expect(eventsNearDate(events, '2026-06-14', 4).map((e) => e.type)).toEqual(['CPI', 'FOMC']);
    expect(eventsNearDate(events, '2026-06-17', 0).map((e) => e.type)).toEqual(['FOMC']);
  });

  it('returns [] for an unparseable anchor date', () => {
    expect(eventsNearDate(events, 'garbage')).toEqual([]);
  });
});

describe('nextEventOfType / daysToNextFOMC', () => {
  const asOf = Date.parse('2026-06-06T12:00:00Z');
  const events: MacroEvent[] = [
    { type: 'FOMC', date: '2026-04-29', importance: 'high', title: 'past FOMC', source: 'curated' },
    { type: 'CPI', date: '2026-06-11', importance: 'high', title: 'CPI', source: 'fred' },
    { type: 'FOMC', date: '2026-06-17', importance: 'high', title: 'FOMC', source: 'curated' },
    { type: 'FOMC', date: '2026-07-29', importance: 'high', title: 'later FOMC', source: 'curated' },
  ];

  it('picks the soonest not-yet-past event of the requested type', () => {
    expect(nextEventOfType(events, 'FOMC', asOf)?.date).toBe('2026-06-17');
    expect(nextEventOfType(events, 'CPI', asOf)?.date).toBe('2026-06-11');
  });

  it('considers all types when no type is given', () => {
    expect(nextEventOfType(events, null, asOf)?.date).toBe('2026-06-11');
  });

  it('computes whole calendar days to the next FOMC', () => {
    // 2026-06-06 → 2026-06-17 is 11 days.
    expect(daysToNextFOMC(events, asOf)).toBe(11);
  });

  it('returns null when no event of the type remains upcoming', () => {
    const onlyPast: MacroEvent[] = [
      { type: 'FOMC', date: '2020-01-01', importance: 'high', title: 'old', source: 'curated' },
    ];
    expect(nextEventOfType(onlyPast, 'FOMC', asOf)).toBeNull();
    expect(daysToNextFOMC(onlyPast, asOf)).toBeNull();
  });
});

describe('FOMC_MEETINGS coverage (TRA-4430)', () => {
  it('carries 8 decision days per year for every year 2021–2026, sorted and unique', () => {
    const byYear = new Map<string, number>();
    for (const date of FOMC_MEETINGS) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const year = date.slice(0, 4);
      byYear.set(year, (byYear.get(year) ?? 0) + 1);
    }
    // The Fed schedules 8 regular meetings a year; unscheduled notation votes
    // are deliberately excluded (not ex-ante ⇒ lookahead in a backtest).
    for (const year of ['2021', '2022', '2023', '2024', '2025', '2026']) {
      expect(byYear.get(year)).toBe(8);
    }
    expect(FOMC_MEETINGS.length).toBe(48);
    expect([...FOMC_MEETINGS]).toEqual([...new Set(FOMC_MEETINGS)].sort());
  });
});

describe('fomcEvents', () => {
  it('emits high-importance curated FOMC rows', () => {
    const evs = fomcEvents();
    expect(evs.length).toBeGreaterThan(0);
    for (const ev of evs) {
      expect(ev.type).toBe('FOMC');
      expect(ev.importance).toBe('high');
      expect(ev.source).toBe('curated');
      expect(ev.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('EconomicCalendarClient.getUpcomingEvents', () => {
  const asOf = Date.parse('2026-06-06T12:00:00Z');

  it('merges curated FOMC with fetched releases, filtered to the window and sorted', async () => {
    const client = new EconomicCalendarClient('test-key');
    // Stub the per-release fetch to return one CPI date inside the window.
    (client as unknown as { fetchRelease: typeof client.fetchRelease }).fetchRelease = async (meta) =>
      meta.type === 'CPI'
        ? [{ type: 'CPI', date: '2026-06-11', importance: 'high', title: 'CPI', source: 'fred' }]
        : [];

    const events = await client.getUpcomingEvents({ asOf, fromDays: 0, toDays: 30 });
    // CPI (06-11) and the 06-17 FOMC fall in the 30-day window; 07-29 FOMC does not.
    expect(events.map((e) => `${e.type}:${e.date}`)).toEqual(['CPI:2026-06-11', 'FOMC:2026-06-17']);
    // Sorted ascending.
    expect(events).toEqual([...events].sort((a, b) => a.date.localeCompare(b.date)));
  });

  it('keeps FOMC rows and reports release errors when a fetch fails', async () => {
    const client = new EconomicCalendarClient('test-key');
    (client as unknown as { fetchRelease: typeof client.fetchRelease }).fetchRelease = async () => {
      throw new Error('boom');
    };
    const errors: number[] = [];
    const events = await client.getUpcomingEvents({ asOf, toDays: 30 }, (id) => errors.push(id));
    expect(errors.length).toBe(3); // all three FRED releases reported
    expect(events.every((e) => e.type === 'FOMC')).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });
});
