import { describe, it, expect } from 'vitest';
import {
  OPTION_EXIT_REASON_TABLE,
  OPTION_SLEEVE_AXIS_FLOOR,
  SLEEVE_CELL_MIN_N,
  classifyOptionExitOwner,
  foldOptionSleeveCells,
  parseEtDayCloseWindow,
  rowClosedInWindow,
  rowCloseEtDay,
  sleeveArchetypeKey,
  sleeveCellPower,
  type OptionSleeveCell,
} from './option-journal-sleeve-cells.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import { UNSPECIFIED_ENTRY_ARCHETYPE } from './option-spread-cost.js';

// 2026-08-03T14:00:00Z — 10:00 ET, mid-session, well away from any boundary.
const T = Date.UTC(2026, 7, 3, 14, 0, 0);

function row(over: Partial<OptionTradeJournalRecord> & { id: string }): OptionTradeJournalRecord {
  return {
    openTs: T - 86_400_000,
    symbol: 'AAPL',
    structure: 'single_leg_directional',
    mode: 'demo',
    ivRank: 40,
    trend: 'up',
    sentiment: 0,
    entryDelta: 0.45,
    entryDte: 35,
    atRiskUsd: 200,
    entryArchetype: 'directional',
    account: 'admin',
    outcome: 'WIN',
    closeTs: T,
    realizedPnlUsd: 20,
    realizedR: 0.1,
    exitReason: 'sl',
    holdDays: 1,
    ...over,
  };
}

/** Find one cell by its three axes — never by index, never by parsing the key. */
function cellOf(
  grid: ReturnType<typeof foldOptionSleeveCells>,
  accountClass: string,
  structure: string,
  entryArchetype: string,
): OptionSleeveCell {
  const found = grid.cells.find(
    (c) =>
      c.accountClass === accountClass
      && c.structure === structure
      && c.entryArchetype === entryArchetype,
  );
  expect(found, `cell ${accountClass}|${structure}|${entryArchetype} must exist`).toBeDefined();
  return found as OptionSleeveCell;
}

describe('TRA-3715 exit-owner table', () => {
  // The whole point of item 3 is that the rule is DATA. If it can drift back to
  // an inline `!==` at a fold site, nothing here holds.
  it('classes manual and take_profit_early as harness and the sleeve exits as strategy', () => {
    expect(classifyOptionExitOwner('manual')).toBe('harness');
    expect(classifyOptionExitOwner('take_profit_early')).toBe('harness');
    for (const strategyReason of [
      'sl',
      'supertrend_flip',
      'time_stop',
      'ma20_close_through',
      'trail',
      'chandelier',
      'profit_lock',
      'book_halt_flat',
    ]) {
      expect(classifyOptionExitOwner(strategyReason)).toBe('strategy');
    }
  });

  // Fail CLOSED. An unrecognised close silently counted as strategy is the exact
  // defect one build later.
  it('classes an absent, blank, or unlisted reason as unknown — never strategy', () => {
    expect(classifyOptionExitOwner(undefined)).toBe('unknown');
    expect(classifyOptionExitOwner(null)).toBe('unknown');
    expect(classifyOptionExitOwner('   ')).toBe('unknown');
    expect(classifyOptionExitOwner('some_exit_path_added_next_week')).toBe('unknown');
    // The repair path is real but its exit is not recoverable, so it is not
    // evidence of strategy behaviour in either direction.
    expect(classifyOptionExitOwner('reconstructed-TRA-3472')).toBe('unknown');
  });

  it('covers every exit reason observed on the live journal', () => {
    // Measured 2026-08-14 against live 0e9f0e8bb4b6, n=2,722 closed rows.
    const observed = [
      'manual',
      'sl',
      'supertrend_flip',
      'time_stop',
      'ma20_close_through',
      'trail',
      'chandelier',
      'book_halt_flat',
      'take_profit_early',
      'profit_lock',
      'reconstructed-TRA-3472',
    ];
    const listed = new Set(OPTION_EXIT_REASON_TABLE.map((r) => r.reason));
    for (const reason of observed) expect(listed.has(reason), `${reason} must be in the table`).toBe(true);
    // Every row carries its own justification — the rule, in words, on the wire.
    for (const rule of OPTION_EXIT_REASON_TABLE) expect(rule.why.length).toBeGreaterThan(20);
    // No duplicate rows: two entries for one reason would make the owner depend
    // on Map insertion order rather than on the table anybody reads.
    expect(listed.size).toBe(OPTION_EXIT_REASON_TABLE.length);
  });
});

describe('TRA-3715 underpowered label', () => {
  it('labels below 20 and only below 20', () => {
    expect(SLEEVE_CELL_MIN_N).toBe(20);
    expect(sleeveCellPower(0)).toBe('UNDERPOWERED');
    expect(sleeveCellPower(19)).toBe('UNDERPOWERED');
    expect(sleeveCellPower(20)).toBe('POWERED');
    expect(sleeveCellPower(21)).toBe('POWERED');
  });

  // The ticket's positive control: a cell that SHOULD be underpowered must
  // actually SAY so, and — the other half, without which the assertion passes on
  // a function that returns UNDERPOWERED unconditionally — a fat cell must not.
  it('a thin cell reports UNDERPOWERED and a fat one does not', () => {
    const thin = Array.from({ length: 19 }, (_, i) => row({ id: `thin${i}` }));
    const thinGrid = foldOptionSleeveCells(thin);
    const thinCell = cellOf(thinGrid, 'desk', 'single_leg_directional', 'directional');
    expect(thinCell.all.n).toBe(19);
    expect(thinCell.all.power).toBe('UNDERPOWERED');
    expect(thinCell.all.underpowered).toBe(true);
    expect(thinCell.strategyExits.power).toBe('UNDERPOWERED');
    expect(thinGrid.underpoweredCells).toContain(thinCell.cell);

    const fat = Array.from({ length: 20 }, (_, i) => row({ id: `fat${i}` }));
    const fatGrid = foldOptionSleeveCells(fat);
    const fatCell = cellOf(fatGrid, 'desk', 'single_leg_directional', 'directional');
    expect(fatCell.all.n).toBe(20);
    expect(fatCell.all.power).toBe('POWERED');
    expect(fatCell.all.underpowered).toBe(false);
    expect(fatGrid.underpoweredCells).not.toContain(fatCell.cell);
  });

  // n=0 must be UNDERPOWERED, not "clean". A zero-sample cell with no label is
  // the absent-cell bug wearing a number.
  it('labels an n=0 cell UNDERPOWERED rather than leaving avgR bare', () => {
    const grid = foldOptionSleeveCells([]);
    const cell = cellOf(grid, 'desk', 'single_leg_directional', 'directional');
    expect(cell.all.n).toBe(0);
    expect(cell.all.avgR).toBeNull();
    expect(cell.all.power).toBe('UNDERPOWERED');
    expect(cell.emptyByConstruction).toBe(true);
  });
});

describe('TRA-3715 accountClass x structure x entryArchetype cells', () => {
  it('emits all three account classes for every axis pair, even at n=0', () => {
    const grid = foldOptionSleeveCells([row({ id: 'a', account: 'admin' })]);
    for (const pair of grid.axisPairs) {
      for (const klass of ['desk', 'fixture', 'unattributed'] as const) {
        cellOf(grid, klass, pair.structure, pair.entryArchetype);
      }
    }
    expect(grid.cells).toHaveLength(3 * grid.axisPairs.length);
    expect(grid.accountClasses).toEqual(['desk', 'fixture', 'unattributed']);
    // Only ONE cell carried a row; every other cell is a published zero.
    expect(grid.emptyCellCount).toBe(grid.cells.length - 1);
  });

  // TRA-3682's shape: a sleeve that stops trading vanishes from every
  // count-derived rollup, and an absent cell reads exactly like a passing one.
  it('emits the declared sleeve floor even when the journal is completely empty', () => {
    const grid = foldOptionSleeveCells([]);
    for (const pair of OPTION_SLEEVE_AXIS_FLOOR) {
      const cell = cellOf(grid, 'desk', pair.structure, pair.entryArchetype);
      expect(cell.all.n).toBe(0);
      expect(cell.emptyByConstruction).toBe(true);
    }
    expect(grid.cells.length).toBe(3 * OPTION_SLEEVE_AXIS_FLOOR.length);
  });

  // The rule TRA-3682/TRA-3709 state and the route did not offer: one structure
  // label carries several sleeves, and they must not pool.
  it('splits one structure label across its archetypes instead of pooling them', () => {
    const grid = foldOptionSleeveCells([
      row({ id: 'r1', structure: 'single_leg_rv', entryArchetype: undefined, realizedR: 1 }),
      row({ id: 'r2', structure: 'single_leg_rv', entryArchetype: 'directional', realizedR: -1 }),
      row({ id: 'r3', structure: 'single_leg_rv', entryArchetype: 'iv-rv-buy-premium', realizedR: 0 }),
    ]);
    expect(cellOf(grid, 'desk', 'single_leg_rv', UNSPECIFIED_ENTRY_ARCHETYPE).all.avgR).toBe(1);
    expect(cellOf(grid, 'desk', 'single_leg_rv', 'directional').all.avgR).toBe(-1);
    expect(cellOf(grid, 'desk', 'single_leg_rv', 'iv-rv-buy-premium').all.avgR).toBe(0);
    // The pooled marginal of those three is 0 — which is the number the old
    // surface published, and it is not any of the three sleeves.
    expect(sleeveArchetypeKey(undefined)).toBe(UNSPECIFIED_ENTRY_ARCHETYPE);
    expect(sleeveArchetypeKey(null)).toBe(UNSPECIFIED_ENTRY_ARCHETYPE);
  });

  it('separates the classes rather than pooling fixture into desk', () => {
    const grid = foldOptionSleeveCells([
      row({ id: 'd1', account: 'admin', realizedR: -0.5, realizedPnlUsd: -100 }),
      row({ id: 'f1', account: 'qa_mirror_1', realizedR: 8, realizedPnlUsd: 1600 }),
      row({ id: 'f2', account: 'qa_mirror_2', realizedR: 8, realizedPnlUsd: 1600 }),
      row({ id: 'u1', account: undefined, realizedR: 0.2, realizedPnlUsd: 40 }),
    ]);
    expect(cellOf(grid, 'desk', 'single_leg_directional', 'directional').all).toMatchObject({
      n: 1,
      avgR: -0.5,
      realizedPnlUsd: -100,
    });
    expect(cellOf(grid, 'fixture', 'single_leg_directional', 'directional').all).toMatchObject({
      n: 2,
      avgR: 8,
      realizedPnlUsd: 3200,
    });
    expect(cellOf(grid, 'unattributed', 'single_leg_directional', 'directional').all.n).toBe(1);
    expect(grid.cellsSumToClosed).toBe(true);
    expect(grid.residual).toBe(0);
  });

  it('counts OPEN rows in total but never in a closed slice', () => {
    const grid = foldOptionSleeveCells([
      row({ id: 'c1' }),
      row({ id: 'o1', outcome: 'OPEN', closeTs: undefined, realizedR: undefined, exitReason: undefined }),
    ]);
    const cell = cellOf(grid, 'desk', 'single_leg_directional', 'directional');
    expect(cell.total).toBe(2);
    expect(cell.open).toBe(1);
    expect(cell.all.n).toBe(1);
    expect(grid.closed).toBe(1);
    expect(grid.cellsSumToClosed).toBe(true);
  });
});

describe('TRA-3715 strategy-vs-harness exit split', () => {
  // The TRA-3709 shape, reproduced in miniature: the harness closes carry the
  // ENTIRE positive baseline, so the sleeve reads +EV pooled and −EV on its own
  // behaviour. Before this split there was no field on the wire separating them.
  it('a sleeve positive on all exits is negative on strategy exits alone', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) =>
        row({ id: `s${i}`, exitReason: 'time_stop', realizedR: -0.1, realizedPnlUsd: -20, outcome: 'LOSS' }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        row({ id: `h${i}`, exitReason: 'manual', realizedR: 0.8, realizedPnlUsd: 160 }),
      ),
    ];
    const cell = cellOf(
      foldOptionSleeveCells(rows),
      'desk',
      'single_leg_directional',
      'directional',
    );
    expect(cell.all.n).toBe(9);
    expect(cell.all.avgR).toBeGreaterThan(0);
    expect(cell.strategyExits.n).toBe(6);
    expect(cell.strategyExits.avgR).toBeLessThan(0);
    expect(cell.harnessExits.n).toBe(3);
    expect(cell.harnessExits.avgR).toBeCloseTo(0.8, 10);
    expect(cell.exitOwnerCountsSumToClosed).toBe(true);
  });

  // The ticket's second positive control: a deliberately MIS-classified exit
  // reason must MOVE the number. Identical economics, only the label differs —
  // if the strategy slice were computed without consulting the table, these two
  // folds would be identical and this test could not fail.
  it('mis-labelling a harness close as a strategy exit moves the strategy number', () => {
    const economics = { realizedR: 5, realizedPnlUsd: 1000 } as const;
    const asHarness = foldOptionSleeveCells([
      row({ id: 'x', exitReason: 'time_stop', realizedR: -1, realizedPnlUsd: -200, outcome: 'LOSS' }),
      row({ id: 'y', exitReason: 'manual', ...economics }),
    ]);
    const misLabelled = foldOptionSleeveCells([
      row({ id: 'x', exitReason: 'time_stop', realizedR: -1, realizedPnlUsd: -200, outcome: 'LOSS' }),
      // Same trade, same P&L, same R — only the exit LABEL is wrong.
      row({ id: 'y', exitReason: 'time_stop', ...economics }),
    ]);
    const a = cellOf(asHarness, 'desk', 'single_leg_directional', 'directional');
    const b = cellOf(misLabelled, 'desk', 'single_leg_directional', 'directional');

    // `all` is blind to the mislabel — which is precisely why grading on it
    // cannot detect the contamination.
    expect(a.all.avgR).toBe(b.all.avgR);
    // The strategy slice is not.
    expect(a.strategyExits.n).toBe(1);
    expect(a.strategyExits.avgR).toBe(-1);
    expect(b.strategyExits.n).toBe(2);
    expect(b.strategyExits.avgR).toBe(2);
    expect(a.strategyExits.avgR).not.toBe(b.strategyExits.avgR);
  });

  it('routes an unlisted reason to unknownExits and names it on the grid', () => {
    const grid = foldOptionSleeveCells([
      row({ id: 'k1', exitReason: 'sl', realizedR: -1, realizedPnlUsd: -200, outcome: 'LOSS' }),
      row({ id: 'u1', exitReason: 'brand_new_exit_path', realizedR: 9, realizedPnlUsd: 1800 }),
    ]);
    const cell = cellOf(grid, 'desk', 'single_leg_directional', 'directional');
    expect(cell.strategyExits.n).toBe(1);
    expect(cell.strategyExits.avgR).toBe(-1);
    expect(cell.unknownExits.n).toBe(1);
    // The +9R / +$1,800 outlier must NOT have leaked into the strategy number.
    expect(cell.strategyExits.realizedPnlUsd).toBe(-200);
    expect(grid.unclassifiedExitReasons).toEqual(['brand_new_exit_path']);
    expect(cell.exitOwnerCountsSumToClosed).toBe(true);
  });

  // `unclassifiedExitReasons` is a table-GAP alarm, not an owner report. A
  // reason the table deliberately owns `unknown` must NOT appear here: it would
  // pin the list permanently non-empty on the live journal (7 rows carry
  // `reconstructed-TRA-3472`), and an alarm that is always on is not an alarm.
  it('leaves unclassifiedExitReasons empty when every reason is on the table', () => {
    const grid = foldOptionSleeveCells([
      row({ id: 'a', exitReason: 'sl' }),
      row({ id: 'b', exitReason: 'manual' }),
      // Table-listed, owner `unknown` — a modelled state, not a gap.
      row({ id: 'c', exitReason: 'reconstructed-TRA-3472' }),
      // An ABSENT reason is likewise a modelled state, not a gap.
      row({ id: 'd', exitReason: undefined }),
    ]);
    expect(grid.unclassifiedExitReasons).toEqual([]);
    const cell = cellOf(grid, 'desk', 'single_leg_directional', 'directional');
    expect(cell.unknownExits.n).toBe(2);
    // …and the alarm still fires for a reason nobody listed.
    const gap = foldOptionSleeveCells([row({ id: 'e', exitReason: 'exit_path_from_the_future' })]);
    expect(gap.unclassifiedExitReasons).toEqual(['exit_path_from_the_future']);
  });

  it('publishes the table it classified with', () => {
    const grid = foldOptionSleeveCells([]);
    expect(grid.exitOwnerTable).toBe(OPTION_EXIT_REASON_TABLE);
    expect(grid.exitOwnerTable.find((r) => r.reason === 'manual')?.owner).toBe('harness');
  });

  it('reports dispersion so a thin mean can carry a CI instead of a point', () => {
    const grid = foldOptionSleeveCells([
      row({ id: 'a', realizedR: 1 }),
      row({ id: 'b', realizedR: -1 }),
    ]);
    const cell = cellOf(grid, 'desk', 'single_leg_directional', 'directional');
    expect(cell.all.avgR).toBe(0);
    // Sample SD (n−1) of {+1, −1} is √2.
    expect(cell.all.sdR).toBeCloseTo(Math.SQRT2, 10);
    expect(cell.all.seR).toBeCloseTo(1, 10);
    // n=1 must report null dispersion, never a fake-confident 0.
    const one = cellOf(
      foldOptionSleeveCells([row({ id: 'only' })]),
      'desk',
      'single_leg_directional',
      'directional',
    );
    expect(one.all.sdR).toBeNull();
    expect(one.all.seR).toBeNull();
  });
});

describe('TRA-3715 ET session-day close window', () => {
  it('resolves an ET day range to inclusive epoch-ms bounds', () => {
    const parsed = parseEtDayCloseWindow('2026-07-27', '2026-08-13');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.window) throw new Error('expected a window');
    // EDT (UTC−4) on both ends: 00:00 ET 07-27 is 04:00Z, and the window closes
    // one millisecond before 00:00 ET 08-14.
    expect(parsed.window.fromMs).toBe(Date.UTC(2026, 6, 27, 4, 0, 0, 0));
    expect(parsed.window.toMs).toBe(Date.UTC(2026, 7, 14, 4, 0, 0, 0) - 1);
    expect(parsed.window.fromInclusive).toBe(true);
    expect(parsed.window.toInclusive).toBe(true);
  });

  // The reason the conversion is done here and not at the call site: a window
  // spanning the DST change has DIFFERENT offsets at its two ends, and a
  // hard-coded −4 (or −5) is silently an hour wrong on one of them.
  it('uses the offset in force at each end across a DST transition', () => {
    // 2026 US DST starts Sunday 2026-03-08.
    const parsed = parseEtDayCloseWindow('2026-03-06', '2026-03-09');
    if (!parsed.ok || !parsed.window) throw new Error('expected a window');
    // EST (UTC−5) at the open…
    expect(parsed.window.fromMs).toBe(Date.UTC(2026, 2, 6, 5, 0, 0, 0));
    // …EDT (UTC−4) at the close.
    expect(parsed.window.toMs).toBe(Date.UTC(2026, 2, 10, 4, 0, 0, 0) - 1);
  });

  it('includes both boundary instants and excludes the millisecond outside', () => {
    const parsed = parseEtDayCloseWindow('2026-08-03', '2026-08-03');
    if (!parsed.ok || !parsed.window) throw new Error('expected a window');
    const w = parsed.window;
    expect(rowClosedInWindow(row({ id: 'lo', closeTs: w.fromMs }), w)).toBe(true);
    expect(rowClosedInWindow(row({ id: 'hi', closeTs: w.toMs }), w)).toBe(true);
    expect(rowClosedInWindow(row({ id: 'before', closeTs: w.fromMs - 1 }), w)).toBe(false);
    expect(rowClosedInWindow(row({ id: 'after', closeTs: w.toMs + 1 }), w)).toBe(false);
    // An OPEN row has no closeTs and is excluded by construction.
    expect(rowClosedInWindow(row({ id: 'open', outcome: 'OPEN', closeTs: undefined }), w)).toBe(false);
  });

  it('returns no window when neither param is supplied', () => {
    const parsed = parseEtDayCloseWindow(undefined, undefined);
    expect(parsed).toEqual({ ok: true, window: null });
  });

  // Fail CLOSED, the same contract the epoch-ms params carry: a half-open or
  // malformed window must never degrade into "select everything".
  it('rejects a half-open, malformed, repeated or inverted window', () => {
    const cases: Array<[unknown, unknown, string]> = [
      ['2026-07-27', undefined, 'et_day_window_incomplete'],
      [undefined, '2026-08-13', 'et_day_window_incomplete'],
      ['2026-07-27', '  ', 'et_day_window_incomplete'],
      ['07/27/2026', '2026-08-13', 'sinceEtDay_not_et_day'],
      ['2026-07-27', '2026-08-13T00:00:00Z', 'untilEtDay_not_et_day'],
      [['2026-07-27', '2026-07-28'], '2026-08-13', 'sinceEtDay_repeated'],
      ['2026-08-13', '2026-07-27', 'et_day_window_inverted'],
    ];
    for (const [since, until, error] of cases) {
      const parsed = parseEtDayCloseWindow(since, until);
      expect(parsed.ok, `${String(since)}..${String(until)} must be rejected`).toBe(false);
      expect((parsed as { error: string }).error).toBe(error);
    }
  });

  it('stamps the ET close day off the row, and null while it is open', () => {
    expect(rowCloseEtDay(row({ id: 'c', closeTs: Date.UTC(2026, 7, 3, 14, 0) }))).toBe('2026-08-03');
    // 01:30Z is still the PREVIOUS ET day (21:30 ET) — the trap a call-site
    // `toISOString().slice(0,10)` walks into.
    expect(rowCloseEtDay(row({ id: 'd', closeTs: Date.UTC(2026, 7, 4, 1, 30) }))).toBe('2026-08-03');
    expect(rowCloseEtDay(row({ id: 'o', outcome: 'OPEN', closeTs: undefined }))).toBeNull();
  });
});
