import { describe, it, expect } from 'vitest';
import {
  computeStrategyIntrospection,
  computePerformanceStats,
  optionJournalToStrategyRows,
  type StrategyTradeRow,
} from './strategy-introspection.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

// TRA-995 — the self-awareness layer: per-strategy attribution (P&L, expectancy,
// Sharpe, win-rate, by regime) + an edge-decay detector on a degrading strategy.

function row(
  strategy: string,
  closeTs: number,
  realizedR: number,
  regime: StrategyTradeRow['regime'] = 'trend_up',
): StrategyTradeRow {
  return { strategy, closeTs, realizedR, realizedPnlUsd: realizedR * 100, regime };
}

describe('computePerformanceStats', () => {
  it('returns null stats on an empty set', () => {
    const s = computePerformanceStats([]);
    expect(s.trades).toBe(0);
    expect(s.expectancy).toBeNull();
    expect(s.sharpe).toBeNull();
    expect(s.winRate).toBeNull();
  });

  it('computes expectancy, win-rate and Sharpe', () => {
    const rows = [row('s', 1, 2), row('s', 2, -1), row('s', 3, 2), row('s', 4, -1)];
    const s = computePerformanceStats(rows);
    expect(s.trades).toBe(4);
    expect(s.expectancy).toBeCloseTo(0.5, 6); // (2-1+2-1)/4
    expect(s.winRate).toBe(0.5);
    expect(s.realizedPnlUsd).toBeCloseTo(200, 6);
    expect(s.sharpe).not.toBeNull();
    expect(s.sharpe!).toBeGreaterThan(0);
  });

  it('returns null Sharpe when variance is zero', () => {
    const rows = [row('s', 1, 1), row('s', 2, 1)];
    expect(computePerformanceStats(rows).sharpe).toBeNull();
  });
});

describe('computeStrategyIntrospection — attribution', () => {
  it('attributes P&L per strategy and breaks down by regime', () => {
    const rows = [
      row('alpha', 1, 1, 'trend_up'),
      row('alpha', 2, 1, 'range'),
      row('beta', 3, -1, 'high_vol'),
    ];
    const out = computeStrategyIntrospection(rows);
    const alpha = out.strategies.find((s) => s.strategy === 'alpha')!;
    expect(alpha.trades).toBe(2);
    expect(alpha.realizedPnlUsd).toBeCloseTo(200, 6);
    expect(alpha.byRegime.map((r) => r.regime).sort()).toEqual(['range', 'trend_up']);
    // strategies sorted by trade count desc
    expect(out.strategies[0].strategy).toBe('alpha');
  });
});

describe('computeStrategyIntrospection — edge-decay detector', () => {
  const opts = { recentWindow: 5, minWindowTrades: 5 };

  it('flags a strategy whose previously-positive edge has turned negative', () => {
    const rows: StrategyTradeRow[] = [];
    // baseline: 5 winners (+1.5R)
    for (let i = 0; i < 5; i++) rows.push(row('decayer', i, 1.5));
    // recent: 5 losers (−1R)
    for (let i = 0; i < 5; i++) rows.push(row('decayer', 100 + i, -1));
    const out = computeStrategyIntrospection(rows, opts);
    const flag = out.edgeDecay.find((e) => e.strategy === 'decayer')!;
    expect(flag.degrading).toBe(true);
    expect(flag.baselineExpectancy).toBeCloseTo(1.5, 6);
    expect(flag.recentExpectancy).toBeCloseTo(-1, 6);
    expect(out.degradingStrategies).toContain('decayer');
  });

  it('flags a strategy whose edge has merely eroded below half of baseline', () => {
    const rows: StrategyTradeRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(row('fader', i, 2)); // baseline +2R
    for (let i = 0; i < 5; i++) rows.push(row('fader', 100 + i, 0.5)); // recent +0.5R < 1R
    const out = computeStrategyIntrospection(rows, opts);
    expect(out.edgeDecay.find((e) => e.strategy === 'fader')!.degrading).toBe(true);
  });

  it('does NOT flag a strategy whose edge is intact', () => {
    const rows: StrategyTradeRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(row('steady', i, 1.0));
    for (let i = 0; i < 5; i++) rows.push(row('steady', 100 + i, 1.2));
    const out = computeStrategyIntrospection(rows, opts);
    const flag = out.edgeDecay.find((e) => e.strategy === 'steady')!;
    expect(flag.degrading).toBe(false);
    expect(out.degradingStrategies).not.toContain('steady');
  });

  it('does NOT flag with too few trades to judge', () => {
    const rows = [row('thin', 1, 2), row('thin', 2, -2), row('thin', 3, -2)];
    const out = computeStrategyIntrospection(rows, opts);
    expect(out.edgeDecay.find((e) => e.strategy === 'thin')!.degrading).toBe(false);
  });

  it('does NOT flag a never-profitable strategy (nothing to decay from)', () => {
    const rows: StrategyTradeRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(row('loser', i, -1));
    for (let i = 0; i < 5; i++) rows.push(row('loser', 100 + i, -1.5));
    const out = computeStrategyIntrospection(rows, opts);
    expect(out.edgeDecay.find((e) => e.strategy === 'loser')!.degrading).toBe(false);
  });
});

describe('optionJournalToStrategyRows adapter', () => {
  it('keeps only closed rows and maps trend → regime', () => {
    const records: OptionTradeJournalRecord[] = [
      {
        id: '1',
        openTs: 1,
        symbol: 'AAPL',
        structure: 'bull_put',
        mode: 'demo',
        ivRank: 50,
        trend: 'up',
        sentiment: null,
        entryDelta: 0.3,
        entryDte: 30,
        atRiskUsd: 100,
        outcome: 'WIN',
        closeTs: 5,
        realizedPnlUsd: 80,
        realizedR: 0.8,
        exitReason: 'tp1',
        holdDays: 4,
      },
      {
        id: '2',
        openTs: 2,
        symbol: 'MSFT',
        structure: 'single_leg_rv',
        mode: 'demo',
        ivRank: 20,
        trend: 'down',
        sentiment: null,
        entryDelta: 0.5,
        entryDte: 20,
        atRiskUsd: 200,
        outcome: 'OPEN', // still open — dropped
      },
    ];
    const rows = optionJournalToStrategyRows(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ strategy: 'bull_put', realizedR: 0.8, regime: 'trend_up' });
  });
});
