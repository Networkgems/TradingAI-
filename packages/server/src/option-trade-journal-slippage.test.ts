import { describe, it, expect } from 'vitest';
import {
  summarizeOptionTradeJournal,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';

// TRA-1600 (deliverable D) — measured mark-vs-fill slippage decomposition.

function baseOpen(over: Partial<OptionTradeJournalRecord>): OptionTradeJournalRecord {
  return {
    id: over.id ?? 'x',
    openTs: 1,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    mode: 'demo',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 40,
    atRiskUsd: 100,
    outcome: 'OPEN',
    ...over,
  };
}

describe('summarizeOptionTradeJournal — slippage rollup (TRA-1600 D)', () => {
  it('reports an empty, all-null rollup when no row carries a measurement', () => {
    const { slippage } = summarizeOptionTradeJournal([baseOpen({ id: 'a' })]);
    expect(slippage.entrySampled).toBe(0);
    expect(slippage.exitSampled).toBe(0);
    expect(slippage.roundTripSampled).toBe(0);
    expect(slippage.avgEntrySlippageUsd).toBeNull();
    expect(slippage.avgRoundTripCostR).toBeNull();
    expect(slippage.totalSlippageUsd).toBe(0);
  });

  it('averages entry slippage over ALL rows carrying it (open + closed), in USD and R', () => {
    const rows: OptionTradeJournalRecord[] = [
      baseOpen({ id: 'a', atRiskUsd: 100, entrySlippageUsd: 5 }), // 0.05R
      baseOpen({ id: 'b', atRiskUsd: 200, entrySlippageUsd: 20 }), // 0.10R
      baseOpen({ id: 'c' }), // unmeasured — must NOT drag the mean toward 0
    ];
    const { slippage } = summarizeOptionTradeJournal(rows);
    expect(slippage.entrySampled).toBe(2);
    expect(slippage.avgEntrySlippageUsd).toBeCloseTo(12.5, 10); // (5+20)/2
    expect(slippage.avgEntrySlippageR).toBeCloseTo(0.075, 10); // (0.05+0.10)/2
  });

  it('computes round-trip cost R only over rows with BOTH sides measured', () => {
    const rows: OptionTradeJournalRecord[] = [
      // full round trip: entry 4 + exit 6 = 10 / 100 = 0.10R
      baseOpen({
        id: 'a',
        atRiskUsd: 100,
        outcome: 'WIN',
        entrySlippageUsd: 4,
        exitSlippageUsd: 6,
        realizedR: 0.5,
      }),
      // entry-only (still open) — counts for entry, not exit/roundtrip
      baseOpen({ id: 'b', atRiskUsd: 100, entrySlippageUsd: 8 }),
      // closed but exit-only measurement
      baseOpen({
        id: 'c',
        atRiskUsd: 50,
        outcome: 'LOSS',
        exitSlippageUsd: 5, // 0.10R exit
        realizedR: -1,
      }),
    ];
    const { slippage } = summarizeOptionTradeJournal(rows);
    expect(slippage.entrySampled).toBe(2); // a, b
    expect(slippage.exitSampled).toBe(2); // a, c
    expect(slippage.roundTripSampled).toBe(1); // a only
    expect(slippage.avgRoundTripCostR).toBeCloseTo(0.1, 10);
    // a exit 6/100 = 0.06, c exit 5/50 = 0.10 → mean 0.08
    expect(slippage.avgExitSlippageR).toBeCloseTo(0.08, 10);
    // total measured USD = entry(4+8) + exit(6+5) = 23
    expect(slippage.totalSlippageUsd).toBeCloseTo(23, 10);
  });

  it('ignores rows with a non-positive at-risk basis (no divide-by-zero R)', () => {
    const rows: OptionTradeJournalRecord[] = [
      baseOpen({ id: 'a', atRiskUsd: 0, entrySlippageUsd: 5 }),
      baseOpen({ id: 'b', atRiskUsd: -10, entrySlippageUsd: 5 }),
    ];
    const { slippage } = summarizeOptionTradeJournal(rows);
    expect(slippage.entrySampled).toBe(0);
    expect(slippage.avgEntrySlippageR).toBeNull();
  });
});
