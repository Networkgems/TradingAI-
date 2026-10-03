// TRA-5035 — an entry drought must ALARM, not be discoverable.
//
// The TRA-5014 incident, as a fixture: the desk paper book's last
// `single_leg_directional` entry was 2026-09-22, and on 2026-10-01 the drought
// was SEVEN market sessions (09-23, 24, 25, 28, 29, 30, 10-01) — which a
// calendar-day count would have read as 9, and which NO surface read at all.
//
// What is asserted:
//   1. the incident fixture reads EXACTLY 7, not 9;
//   2. a never-entered cell reads null/null, never 0 (absent must not read clean);
//   3. fixture QA rows do not shorten the desk cell's drought (req 5);
//   4. weekend + holiday boundaries count sessions, not days (req 1);
//   5. the roster is rows ∪ canonical floor (req 3), for all three classes;
//   6. the fold is pure over (rows, now) — no boot state (req 4).
import { describe, it, expect } from 'vitest';
import {
  ENTRY_DROUGHT_SESSIONS_COUNTED,
  entryDroughtSessions,
  foldOptionEntryDrought,
} from './option-entry-drought.js';
import { etWallClockToUtcMs } from './et-clock.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

/** An epoch-ms instant inside the RTH of an ET session day. */
function etMs(day: string, hour = 10, minute = 30): number {
  const ms = etWallClockToUtcMs(day, hour, minute);
  if (ms === null) throw new Error(`unresolvable ET day ${day}`);
  return ms;
}

function row(over: Partial<OptionTradeJournalRecord> & { id: string }): OptionTradeJournalRecord {
  return {
    openTs: etMs('2026-09-22'),
    symbol: 'AAPL',
    structure: 'single_leg_directional',
    entryArchetype: 'directional',
    mode: 'demo',
    ivRank: 40,
    trend: 'up',
    sentiment: 0,
    entryDelta: 0.35,
    entryDte: 30,
    atRiskUsd: 200,
    account: 'admin', // classifies desk
    outcome: 'LOSS',
    closeTs: etMs('2026-09-22', 15, 45),
    realizedPnlUsd: -20,
    realizedR: -0.1,
    exitReason: 'sl',
    holdDays: 1,
    ...over,
  };
}

/** The desk `single_leg_directional` cell — the TRA-5014 cell under test. */
function deskDirectionalCell(rows: OptionTradeJournalRecord[], nowMs: number) {
  const block = foldOptionEntryDrought(rows, nowMs);
  const cell = block.cells.find(
    (c) => c.accountClass === 'desk' && c.structure === 'single_leg_directional',
  );
  expect(cell, 'the desk single_leg_directional cell must exist').toBeDefined();
  return { block, cell: cell! };
}

const ASOF_1001 = etMs('2026-10-01', 16, 0);

describe('TRA-5035 — entryDroughtSessions counts market sessions, not calendar days', () => {
  it('the TRA-5014 incident window reads EXACTLY 7 (09-23..10-01), not the calendar 9', () => {
    expect(entryDroughtSessions('2026-09-22', '2026-10-01')).toBe(7);
  });

  it('a Friday last-entry read on the following Monday is 1, not 3', () => {
    // 2026-09-25 is a Friday, 2026-09-28 the following Monday.
    expect(entryDroughtSessions('2026-09-25', '2026-09-28')).toBe(1);
  });

  it('a holiday is not a session: Fri 2026-09-04 read on Tue 09-08 is 1 (Labor Day 09-07 skipped)', () => {
    expect(entryDroughtSessions('2026-09-04', '2026-09-08')).toBe(1);
  });

  it('an entry on asOfEtDay itself reads 0', () => {
    expect(entryDroughtSessions('2026-10-01', '2026-10-01')).toBe(0);
  });

  it('a weekend asOf day adds no session beyond Friday', () => {
    // Thu 10-01 → Sat 10-03: only Fri 10-02 is a session.
    expect(entryDroughtSessions('2026-10-01', '2026-10-03')).toBe(1);
  });
});

describe('TRA-5035 — the fold: the incident fixture', () => {
  it('desk × single_leg_directional with last entry 09-22 reads 7 as of 10-01', () => {
    const { block, cell } = deskDirectionalCell([row({ id: 'incident' })], ASOF_1001);
    expect(block.asOfEtDay).toBe('2026-10-01');
    expect(cell.lastEntryEtDay).toBe('2026-09-22');
    expect(cell.consecutiveSessionsWithoutEntry).toBe(7);
    expect(cell.consecutiveSessionsWithoutEntry).not.toBe(9);
    expect(cell.everEntered).toBe(true);
    expect(cell.entriesTotal).toBe(1);
    expect(cell.sessionsCounted).toBe(ENTRY_DROUGHT_SESSIONS_COUNTED);
  });

  it('the LATEST entry wins — an older entry does not lengthen the drought', () => {
    const rows = [
      row({ id: 'old', openTs: etMs('2026-09-10') }),
      row({ id: 'new', openTs: etMs('2026-09-22') }),
    ];
    const { cell } = deskDirectionalCell(rows, ASOF_1001);
    expect(cell.lastEntryEtDay).toBe('2026-09-22');
    expect(cell.consecutiveSessionsWithoutEntry).toBe(7);
    expect(cell.entriesTotal).toBe(2);
  });

  it('an OPEN row is still an ENTRY — the drought is on the entry axis', () => {
    const rows = [
      row({ id: 'closed-old', openTs: etMs('2026-09-10') }),
      row({
        id: 'open-new',
        openTs: etMs('2026-09-22'),
        outcome: 'OPEN',
        closeTs: undefined,
        realizedPnlUsd: undefined,
        realizedR: undefined,
        exitReason: undefined,
      }),
    ];
    const { cell } = deskDirectionalCell(rows, ASOF_1001);
    expect(cell.lastEntryEtDay).toBe('2026-09-22');
    expect(cell.consecutiveSessionsWithoutEntry).toBe(7);
  });
});

describe('TRA-5035 req 2 — a never-entered cell is null/null, NEVER 0', () => {
  it('a floor cell with no rows publishes lastEntryEtDay null and consecutiveSessionsWithoutEntry null', () => {
    const block = foldOptionEntryDrought([], ASOF_1001);
    for (const cell of block.cells) {
      expect(cell.everEntered).toBe(false);
      expect(cell.lastEntryEtDay).toBeNull();
      // The whole point: null, not 0 — a zero reads as "entered today".
      expect(cell.consecutiveSessionsWithoutEntry).toBeNull();
      expect(cell.entriesTotal).toBe(0);
    }
  });
});

describe('TRA-5035 req 5 — fixture rows must not shorten the desk drought', () => {
  it('fixture bull_put entries on 09-30/10-01 leave the desk cell at 7 and land in their own cell', () => {
    const rows = [
      row({ id: 'desk-last', openTs: etMs('2026-09-22') }),
      // The two hand-written QA rows the ticket names, on the drought's own days.
      row({
        id: 'qa-1',
        account: 'qa_tra2490_inv_1785285303',
        structure: 'bull_put',
        openTs: etMs('2026-09-30'),
      }),
      row({
        id: 'qa-2',
        account: 'ctoverify_tra2439a',
        structure: 'bull_put',
        openTs: etMs('2026-10-01'),
      }),
    ];
    const { block, cell } = deskDirectionalCell(rows, ASOF_1001);
    expect(cell.consecutiveSessionsWithoutEntry).toBe(7);

    const fixtureCell = block.cells.find(
      (c) => c.accountClass === 'fixture' && c.structure === 'bull_put',
    );
    expect(fixtureCell).toBeDefined();
    expect(fixtureCell!.lastEntryEtDay).toBe('2026-10-01');
    expect(fixtureCell!.consecutiveSessionsWithoutEntry).toBe(0);
    expect(fixtureCell!.entriesTotal).toBe(2);

    // And a DESK bull_put cell is not manufactured by the fixture rows: if it
    // exists at all (floor or observed), it carries no fixture entry.
    const deskBullPut = block.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'bull_put',
    );
    if (deskBullPut) expect(deskBullPut.entriesTotal).toBe(0);
  });
});

describe('TRA-5035 req 3 — the roster is rows ∪ the canonical floor', () => {
  it('floor structures appear for ALL THREE classes even over an empty journal', () => {
    const block = foldOptionEntryDrought([], ASOF_1001);
    for (const klass of ['desk', 'fixture', 'unattributed'] as const) {
      for (const structure of ['single_leg_directional', 'single_leg_otm', 'single_leg_rv']) {
        expect(
          block.cells.some((c) => c.accountClass === klass && c.structure === structure),
          `${klass}|${structure} must be emitted at zero rows`,
        ).toBe(true);
      }
    }
  });

  it('an observed structure OUTSIDE the floor still gets a cell', () => {
    const block = foldOptionEntryDrought(
      [row({ id: 'x', structure: 'iron_condor', openTs: etMs('2026-09-22') })],
      ASOF_1001,
    );
    const cell = block.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'iron_condor',
    );
    expect(cell).toBeDefined();
    expect(cell!.consecutiveSessionsWithoutEntry).toBe(7);
  });
});

describe('TRA-5035 req 4 — no boot state: pure over (rows, now)', () => {
  it('two folds over the same rows are identical — a boot-after-close process publishes the same drought', () => {
    const rows = [row({ id: 'incident' })];
    expect(foldOptionEntryDrought(rows, ASOF_1001)).toEqual(
      foldOptionEntryDrought(rows, ASOF_1001),
    );
  });

  it('an undatable openTs is COUNTED as undatedRows, never silently dropped', () => {
    const block = foldOptionEntryDrought(
      [row({ id: 'bad', openTs: Number.NaN })],
      ASOF_1001,
    );
    expect(block.undatedRows).toBe(1);
    const cell = block.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'single_leg_directional',
    );
    expect(cell!.entriesTotal).toBe(0);
    expect(cell!.lastEntryEtDay).toBeNull();
  });
});
