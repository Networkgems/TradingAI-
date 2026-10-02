// TRA-4991 (AC4) — TEACH `sleeveCells` THE TRA-3217 PROVENANCE SPLIT.
//
// TRA-3217 split one `chandelier` label into five AT THE FIRE SITE precisely so
// one label could not cover several mechanisms. `OPTION_EXIT_REASON_TABLE` never
// learned the split, so three of the four variants that have occurred fell
// through to `unknownExits` and out of every sleeve grade. Live
// `unclassifiedExitReasons` read:
//
//   ["broker_reconcile","chandelier_daily_close","chandelier_restarted",
//    "chandelier_spot_seeded","sl_daily_close","sl_otm_premium_pct"]
//
// with lifetime counts `chandelier` 288 and 1 each of the three chandelier
// variants. A split made at the write site and dropped at the read site is a
// split that exists in the log and nowhere a grader can see it.
//
// What is asserted:
//   1. all three classify `strategy` and leave `unclassifiedExitReasons`;
//   2. they stay SEPARATELY FOLDABLE — ⛔ collapsing them into one bucket would
//      undo TRA-3217 at the fold;
//   3. the fold's own integrity checks still hold (`cellsSumToClosed`,
//      `exitOwnerCountsSumToClosed`, `residual` 0);
//   4. AC5 — the bare `chandelier` count is UNMOVED by the three new rows;
//   5. the reasons the ticket did NOT scope are still loud, and the fifth
//      chandelier label (`chandelier_deferred_breach`, TRA-3217's
//      structural-break canary) is deliberately still unlisted.
import { describe, it, expect } from 'vitest';
import {
  OPTION_EXIT_REASON_TABLE,
  classifyOptionExitOwner,
  foldOptionSleeveCells,
} from './option-journal-sleeve-cells.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

const T = Date.UTC(2026, 9, 1, 14, 0, 0);

/** The three labels AC4 scopes, and the one it deliberately leaves off. */
const SPLIT_REASONS = ['chandelier_daily_close', 'chandelier_restarted', 'chandelier_spot_seeded'] as const;
const CANARY_REASON = 'chandelier_deferred_breach';

function row(over: Partial<OptionTradeJournalRecord> & { id: string }): OptionTradeJournalRecord {
  return {
    openTs: T - 86_400_000,
    symbol: 'AAPL',
    structure: 'single_leg_otm',
    mode: 'live',
    ivRank: 40,
    trend: 'up',
    sentiment: 0,
    entryDelta: 0.18,
    entryDte: 30,
    atRiskUsd: 200,
    account: 'admin',
    outcome: 'LOSS',
    closeTs: T,
    realizedPnlUsd: -20,
    realizedR: -0.1,
    exitReason: 'chandelier',
    holdDays: 1,
    ...over,
  };
}

/** The desk cell for `single_leg_otm` — the one a sleeve grade is read from. */
function otmDeskCell(rows: OptionTradeJournalRecord[]) {
  const grid = foldOptionSleeveCells(rows);
  const cell = grid.cells.find(
    (c) => c.accountClass === 'desk' && c.structure === 'single_leg_otm',
  );
  expect(cell, 'the desk single_leg_otm cell must exist').toBeDefined();
  return { grid, cell: cell! };
}

describe('TRA-4991 AC4 — the chandelier provenance split classifies as strategy', () => {
  it('each of the three variants is owned `strategy`, not `unknown`', () => {
    for (const reason of SPLIT_REASONS) {
      expect(classifyOptionExitOwner(reason), reason).toBe('strategy');
    }
    // The base label is untouched.
    expect(classifyOptionExitOwner('chandelier')).toBe('strategy');
  });

  it('they leave `unclassifiedExitReasons`, and land in `strategyExits` rather than `unknownExits`', () => {
    const rows = SPLIT_REASONS.map((reason, i) => row({ id: `r${i}`, exitReason: reason }));
    const { grid, cell } = otmDeskCell(rows);

    expect(grid.unclassifiedExitReasons).toEqual([]);
    expect(cell.strategyExits.n).toBe(3);
    expect(cell.unknownExits.n).toBe(0);
    expect(cell.harnessExits.n).toBe(0);
    // The fold's own integrity, re-checked: a classification change must not
    // lose or duplicate a row.
    expect(cell.exitOwnerCountsSumToClosed).toBe(true);
    expect(grid.cellsSumToClosed).toBe(true);
    expect(grid.residual).toBe(0);
    expect(grid.closed).toBe(3);
  });

  it('⛔ each stays SEPARATELY FOLDABLE — collapsing them would undo TRA-3217', () => {
    // Two of one variant so a collapse into a single bucket is detectable by
    // count as well as by key.
    const rows = [
      row({ id: 'a', exitReason: 'chandelier' }),
      row({ id: 'b', exitReason: 'chandelier' }),
      row({ id: 'c', exitReason: 'chandelier_daily_close' }),
      row({ id: 'd', exitReason: 'chandelier_restarted' }),
      row({ id: 'e', exitReason: 'chandelier_restarted' }),
      row({ id: 'f', exitReason: 'chandelier_spot_seeded' }),
    ];
    const { cell } = otmDeskCell(rows);

    const byReason = new Map(cell.byExitReason.map((s) => [s.exitReason, s]));
    // FOUR distinct entries, not one bucket of six. This is the assertion that
    // goes red if somebody "simplifies" the table by mapping the variants onto
    // `chandelier`.
    expect([...byReason.keys()].filter((k) => k.startsWith('chandelier')).sort()).toEqual([
      'chandelier', 'chandelier_daily_close', 'chandelier_restarted', 'chandelier_spot_seeded',
    ]);
    expect(byReason.get('chandelier')!.closed).toBe(2);
    expect(byReason.get('chandelier_daily_close')!.closed).toBe(1);
    expect(byReason.get('chandelier_restarted')!.closed).toBe(2);
    expect(byReason.get('chandelier_spot_seeded')!.closed).toBe(1);
    for (const key of ['chandelier', ...SPLIT_REASONS]) {
      expect(byReason.get(key)!.owner, key).toBe('strategy');
    }
    // …and all six are in the strategy slice, which is what the split being
    // learned actually buys: before this, four of the six were invisible to a
    // sleeve grade.
    expect(cell.strategyExits.n).toBe(6);
    expect(cell.unknownExits.n).toBe(0);
  });

  it('AC5 — the bare `chandelier` count is UNMOVED by the three new rows', () => {
    // The published guard is "bare-`chandelier` lifetime count is still 288 after
    // deploy". Its mechanism is what this pins: the fold keys `byExitReason` on
    // the reason STRING, so adding table rows for three other strings cannot
    // move the bare label's count in either direction.
    const bare = Array.from({ length: 7 }, (_, i) => row({ id: `bare${i}`, exitReason: 'chandelier' }));
    const mixed = [...bare, ...SPLIT_REASONS.map((reason, i) => row({ id: `v${i}`, exitReason: reason }))];

    const bareOnly = otmDeskCell(bare).cell.byExitReason.find((s) => s.exitReason === 'chandelier')!;
    const withVariants = otmDeskCell(mixed).cell.byExitReason.find((s) => s.exitReason === 'chandelier')!;
    expect(withVariants.closed).toBe(bareOnly.closed);
    expect(withVariants.closed).toBe(7);
    expect(withVariants.realizedPnlUsd).toBeCloseTo(bareOnly.realizedPnlUsd, 9);
  });
});

describe('TRA-4991 AC4 — what is deliberately still loud', () => {
  it('the TRA-3217 canary `chandelier_deferred_breach` is NOT on the table, so its first fire is loud', () => {
    // The bookkeeping consumes `chandelierBreachedWhileSuppressed` on every
    // unsuppressed tick BEFORE the fire branch can read it, so a non-zero count
    // of this label means the TRA-3217 veto is structurally broken — not that
    // the policy chose to fire. Lifetime count is 0, so leaving it off does not
    // pin `unclassifiedExitReasons` permanently non-empty (which is why
    // `reconstructed-TRA-3472` IS listed), and leaving it off is what makes its
    // first ever occurrence visible on that list instead of folded quietly into
    // a strategy slice.
    expect(OPTION_EXIT_REASON_TABLE.some((r) => r.reason === CANARY_REASON)).toBe(false);
    expect(classifyOptionExitOwner(CANARY_REASON)).toBe('unknown');
    const { grid, cell } = otmDeskCell([row({ id: 'canary', exitReason: CANARY_REASON })]);
    expect(grid.unclassifiedExitReasons).toEqual([CANARY_REASON]);
    expect(cell.unknownExits.n).toBe(1);
    expect(cell.strategyExits.n).toBe(0);
  });

  it('the reasons this ticket did not scope are STILL unclassified (not quietly swept in)', () => {
    // `broker_reconcile`, `sl_daily_close` and `sl_otm_premium_pct` were on the
    // same live `unclassifiedExitReasons` list. AC4 names only the chandelier
    // family, and classifying the others in passing would be a judgement nobody
    // reviewed — so they stay loud.
    const others = ['broker_reconcile', 'sl_daily_close', 'sl_otm_premium_pct'];
    const { grid } = otmDeskCell(others.map((reason, i) => row({ id: `o${i}`, exitReason: reason })));
    expect(grid.unclassifiedExitReasons).toEqual([...others].sort());
  });

  it('the table has exactly one row per reason (no duplicate key shadowing an owner)', () => {
    const reasons = OPTION_EXIT_REASON_TABLE.map((r) => r.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    // …and every row carries a `why`: the rule is DATA, on the wire, and a blank
    // one publishes a classification with no argument behind it.
    for (const r of OPTION_EXIT_REASON_TABLE) {
      expect(r.why.trim().length, r.reason).toBeGreaterThan(20);
    }
  });
});
