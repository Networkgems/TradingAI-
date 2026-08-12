// TRA-2554 acceptance item 2 — the MEASURED guard-OFF-vs-ON delta on the
// `GET /api/reports/desk` fold, run PRE-DEPLOY against the live class census.
//
// The CTO's acceptance on this ticket is not a roster reading: it is
// "`GET /api/reports/desk` totals compared cell by cell, guard OFF vs guard ON;
// acceptance is `delta == 0`, or every moved cell named and justified". A count
// cannot discharge that — `unrecognisedDeskAccountCount` reads a clean `0`
// whether or not the inversion would drop the 2,192 account-less rows, because
// a row with no account can never BE an unrecognised account.
//
// So this runs the SHIPPED fold (`buildJournalCalendarCells`, the one
// `/api/reports/desk` calls) twice over a corpus whose CLASS CENSUS is the live
// journal's, and diffs every cell. The census is the real one, read from
// `GET /api/admin/desk-roster` on live `eb1dcf0c8a6f` at 2026-08-12T13:49:52Z:
//
//   rowsScanned 2698 · rowsWithoutAccount 2192 · journalAccountCount 60
//   roster: admin 101 · Richard 50 · enock 7   (158 rows)
//   testAccountCount 57                        (348 rows)
//   unrecognisedDeskAccounts []                (0 rows)   partitions: true
//
// 2192 + 158 + 348 = 2698, so the reconstruction accounts for every live row.
// Only the class MEMBERSHIP is taken from live (the test-classified accounts are
// not named by that route, by design — it anonymises); the classifier source
// behind it is byte-identical to this checkout's (`git diff eb1dcf0 HEAD --
// packages/server/src/test-accounts.ts` is empty), so each account's class is
// the live one and only the per-class row counts are needed here.
//
// ⚠ `delta == 0` is worthless without a control that MOVED. The last test
// injects ONE unrecognised book and asserts the same harness reports a moved
// cell — otherwise a fold that silently returned the same map either way would
// read exactly like a clean pass.

import { describe, it, expect } from 'vitest';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import { buildJournalCalendarCells } from './reports/desk-calendar.js';
import { foldDeskRows } from './test-accounts.js';

/** Live census, `GET /api/admin/desk-roster` @ 2026-08-12T13:49:52.762Z, build `eb1dcf0c8a6f`. */
const LIVE = {
  rowsScanned: 2698,
  rowsWithoutAccount: 2192,
  roster: [
    { account: 'admin', rowCount: 101 },
    { account: 'Richard', rowCount: 50 }, // capital R, exactly as live stamps it
    { account: 'enock', rowCount: 7 },
  ],
  testAccountCount: 57,
  testRowCount: 348, // 2698 - 2192 - 158
  unrecognisedAccounts: [] as string[],
} as const;

// Five ET market days at 14:00 ET (18:00Z), so every close lands on a session
// day and `isMarketDayIso` retracts none of them (TRA-3298).
const CLOSE_DAYS = [
  Date.UTC(2026, 6, 15, 18), Date.UTC(2026, 6, 16, 18), Date.UTC(2026, 6, 17, 18),
  Date.UTC(2026, 6, 20, 18), Date.UTC(2026, 6, 21, 18),
];

let seq = 0;
function row(account: string | undefined): OptionTradeJournalRecord {
  const i = seq++;
  const closeTs = CLOSE_DAYS[i % CLOSE_DAYS.length];
  return {
    id: `r${i}`,
    symbol: 'SPY',
    account,
    outcome: i % 3 === 0 ? 'LOSS' : 'WIN',
    // Distinct per row and never zero, so ANY row entering or leaving a cell
    // moves that cell's `combinedPnl` — no two rows can cancel out.
    realizedPnlUsd: Number((((i % 41) + 1) * (i % 3 === 0 ? -1.07 : 1.13)).toFixed(2)),
    realizedR: 0.25,
    openTs: closeTs - 3_600_000,
    closeTs,
  } as unknown as OptionTradeJournalRecord;
}

/** The live corpus, reconstructed class-for-class and row-for-row. */
function liveCorpus(extra: OptionTradeJournalRecord[] = []): OptionTradeJournalRecord[] {
  seq = 0;
  const rows: OptionTradeJournalRecord[] = [];
  for (let i = 0; i < LIVE.rowsWithoutAccount; i += 1) rows.push(row(undefined));
  for (const r of LIVE.roster) {
    for (let i = 0; i < r.rowCount; i += 1) rows.push(row(r.account));
  }
  // 348 rows spread over 57 test-classified books, matching `testAccountCount`.
  for (let i = 0; i < LIVE.testRowCount; i += 1) {
    rows.push(row(`qa_live_fixture_${i % LIVE.testAccountCount}`));
  }
  return [...rows, ...extra];
}

const OFF = { ...process.env, DESK_FOLD_ALLOWLIST: '' };
const ON = { ...process.env, DESK_FOLD_ALLOWLIST: '1' };

/** Fold to desk cells under an explicit mode, then flatten to a comparable shape. */
function cells(rows: OptionTradeJournalRecord[], env: NodeJS.ProcessEnv) {
  // `buildJournalCalendarCells` reads `process.env`; pin the flag around the
  // call rather than mutating the classifier, so this exercises the SHIPPED
  // route path and not a test-only branch.
  const prev = process.env.DESK_FOLD_ALLOWLIST;
  if (env.DESK_FOLD_ALLOWLIST) process.env.DESK_FOLD_ALLOWLIST = env.DESK_FOLD_ALLOWLIST;
  else delete process.env.DESK_FOLD_ALLOWLIST;
  try {
    const map = buildJournalCalendarCells(rows, 1_786_000_000_000);
    return [...map.entries()]
      .map(([date, cell]) => ({
        date,
        totalTrades: cell.totalTrades,
        combinedPnl: Number(cell.combinedPnl.toFixed(2)),
        winners: cell.winners,
        losers: cell.losers,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } finally {
    if (prev === undefined) delete process.env.DESK_FOLD_ALLOWLIST;
    else process.env.DESK_FOLD_ALLOWLIST = prev;
  }
}

describe('TRA-2554 — desk fold OFF vs ON, over the live class census', () => {
  it('reconstructs the live census exactly (2698 rows, 4 classes)', () => {
    const fold = foldDeskRows(liveCorpus(), { env: OFF });
    expect(fold.census).toEqual({
      unattributed: LIVE.rowsWithoutAccount,
      roster: 158,
      test: LIVE.testRowCount,
      unrecognised: LIVE.unrecognisedAccounts.length,
    });
    const total = Object.values(fold.census).reduce((a, b) => a + b, 0);
    expect(total).toBe(LIVE.rowsScanned);
  });

  // THE acceptance. Cell by cell, not totals.
  it('DELTA == 0 on every desk cell — no cell moved, none dropped, none added', () => {
    const corpus = liveCorpus();
    const off = cells(corpus, OFF);
    const on = cells(corpus, ON);
    expect(on.map((c) => c.date)).toEqual(off.map((c) => c.date)); // no cell appeared or vanished
    expect(on).toEqual(off); // …and every field of every cell is identical
    // and the fold says WHY it is zero: nothing was in the moved class.
    const armed = foldDeskRows(corpus, { env: ON });
    expect(armed.unrecognisedRowsDropped).toBe(0);
    expect(armed.unrecognisedAccounts).toEqual([]);
  });

  it('keeps all 2,192 account-less rows in the fold with the guard ON', () => {
    const armed = foldDeskRows(liveCorpus(), { env: ON });
    expect(armed.kept.filter((r) => !r.account).length).toBe(LIVE.rowsWithoutAccount);
    // the naive inversion would have left 158 desk rows out of 506 attributed
    // ones and dropped 81% of the journal; assert the kept total instead of the
    // absence of a crash
    expect(armed.kept.length).toBe(LIVE.rowsWithoutAccount + 158);
  });

  it('keeps `Richard` — the capital-R book a case-sensitive allowlist would drop', () => {
    const armed = foldDeskRows(liveCorpus(), { env: ON });
    expect(armed.kept.filter((r) => r.account === 'Richard').length).toBe(50);
  });

  // POSITIVE CONTROL — the delta above is only evidence if this harness can see
  // a move at all. One unvouched book, three closes, and the same comparison
  // must go non-zero AND name the book.
  it('CONTROL: one unrecognised book moves cells, and is named — so `delta == 0` is not vacuous', () => {
    const intruder = [row('newdesk_2026'), row('newdesk_2026'), row('newdesk_2026')];
    const corpus = liveCorpus(intruder);
    const off = cells(corpus, OFF);
    const on = cells(corpus, ON);
    expect(on).not.toEqual(off);
    const moved = off.filter((c, i) => JSON.stringify(c) !== JSON.stringify(on[i]));
    expect(moved.length).toBeGreaterThan(0);
    const armed = foldDeskRows(corpus, { env: ON });
    expect(armed.unrecognisedRowsDropped).toBe(3);
    expect(armed.unrecognisedAccounts).toEqual(['newdesk_2026']);
    // …and with the guard OFF that same book is silently IN the board number,
    // which is the defect this ticket closes.
    expect(foldDeskRows(corpus, { env: OFF }).kept.filter((r) => r.account === 'newdesk_2026').length)
      .toBe(3);
  });
});
