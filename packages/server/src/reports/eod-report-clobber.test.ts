import { describe, it, expect } from 'vitest';
import { wouldClobberSettledReport } from './eod-report.js';

// TRA-1398 — a post-archive regeneration of TODAY (e.g. a Render redeploy after
// 21:00 ET re-fires runDailyCloseForAllUsers, or a state refresh recomputes the
// day) produces an EMPTY report because archiveClosedTrades() already emptied
// the in-memory ledger. It must NOT overwrite the settled non-empty file — that
// is what zeroed Richard's demo calendar cell after a starting-equity edit.

const EMPTY = { totalTrades: 0, trades: [], realizedPnl: 0, optionsPnl: 0 };
const settledOptions = {
  trades: [],
  totalTrades: 0,
  realizedPnl: 0,
  optionsPnl: 483.52,
  combinedPnl: 483.52,
};
const settledStock = {
  trades: [{ symbol: 'NVDA' }],
  totalTrades: 1,
  realizedPnl: -126.21,
  optionsPnl: -1403.3,
  combinedPnl: -1529.51,
};

describe('TRA-1398 — wouldClobberSettledReport', () => {
  it('BLOCKS an empty regeneration over a settled options-only cell (Richard Wed +$483.52)', () => {
    expect(wouldClobberSettledReport(EMPTY, settledOptions)).toBe(true);
  });

  it('BLOCKS an empty regeneration over a settled cell that has closed trades', () => {
    expect(wouldClobberSettledReport(EMPTY, settledStock)).toBe(true);
  });

  it('ALLOWS the first empty write of a genuine no-trade day (no existing file)', () => {
    expect(wouldClobberSettledReport(EMPTY, null)).toBe(false);
    expect(wouldClobberSettledReport(EMPTY, undefined)).toBe(false);
  });

  it('ALLOWS an empty write over an existing already-empty cell (idempotent no-op)', () => {
    const emptyOnDisk = {
      trades: [],
      totalTrades: 0,
      realizedPnl: 0,
      optionsPnl: 0,
      combinedPnl: 0,
    };
    expect(wouldClobberSettledReport(EMPTY, emptyOnDisk)).toBe(false);
  });

  it('ALLOWS a non-empty regeneration to upgrade a settled cell (trades booked later)', () => {
    const richer = { totalTrades: 2, trades: [{}, {}], realizedPnl: 50, optionsPnl: 0 };
    expect(wouldClobberSettledReport(richer, settledOptions)).toBe(false);
  });

  it('treats options-only P&L as content even when there are zero stock trades', () => {
    // Guards against a naive `trades.length`-only check: the options sleeve
    // books realized P&L with an empty stock `trades` array.
    expect(wouldClobberSettledReport(EMPTY, { trades: [], totalTrades: 0, optionsPnl: 12.5 })).toBe(true);
  });

  it('does not block when the new report itself carries realized P&L but no trade rows', () => {
    // A report with optionsPnl but empty `trades` is NOT the empty-clobber case.
    const nextWithOptions = { totalTrades: 0, trades: [], realizedPnl: 0, optionsPnl: 200 };
    expect(wouldClobberSettledReport(nextWithOptions, settledOptions)).toBe(false);
  });
});
