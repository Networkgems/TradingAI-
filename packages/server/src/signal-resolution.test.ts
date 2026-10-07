// TRA-5275 — signal accuracy was structurally unmeasured: 2,615 signals over
// three sessions, zero ever resolved. These tests pin the resolver's honesty
// contract in BOTH directions: determinable outcomes must advance the resolved
// counter, and a signal with no determinable outcome must stay unresolved — a
// force-resolve-everything implementation fails the negative controls below.
import { describe, expect, it } from 'vitest';

import type { DailySignalRecord } from './reports/eod-report.js';
import { resolveSignalOutcomes, type SignalOutcomeSource } from './signal-resolution.js';
import { SignalEngine } from './signal-engine.js';
import type { OptionPosition, Position } from '@trading-app/shared';

function sig(id: string, over: Partial<DailySignalRecord> = {}): DailySignalRecord {
  return { id, symbol: 'AAPL', type: 'relative_value', firedAt: 1_000, ...over };
}

describe('resolveSignalOutcomes (TRA-5275)', () => {
  it('resolves a win by exact signalId with an R multiple from defined risk', () => {
    const signals = [sig('s1')];
    const sources: SignalOutcomeSource[] = [
      { signalId: 's1', closedAt: 2_000, pnl: 120, riskUsd: 60 },
    ];
    const summary = resolveSignalOutcomes(signals, sources);
    expect(summary).toEqual({ scanned: 1, resolved: 1, alreadyResolved: 0, unresolved: 0 });
    expect(signals[0].outcome).toBe('win');
    expect(signals[0].rr).toBe(2);
  });

  it('resolves a loss on pnl <= 0 (tie books as loss, matching the demo-equity annotator)', () => {
    const signals = [sig('neg'), sig('tie')];
    resolveSignalOutcomes(signals, [
      { signalId: 'neg', closedAt: 2_000, pnl: -40, riskUsd: 40 },
      { signalId: 'tie', closedAt: 2_000, pnl: 0, riskUsd: 40 },
    ]);
    expect(signals[0].outcome).toBe('loss');
    expect(signals[1].outcome).toBe('loss');
  });

  // THE negative control the issue demands: an undeterminable outcome must
  // still report unresolved. An implementation that force-resolves everything
  // to make the counter move fails here.
  it('NEGATIVE CONTROL — a signal with no closed row stays unresolved', () => {
    const signals = [sig('traded'), sig('reject-path')];
    const summary = resolveSignalOutcomes(signals, [
      { signalId: 'traded', closedAt: 2_000, pnl: 10, riskUsd: 10 },
    ]);
    expect(summary.resolved).toBe(1);
    expect(summary.unresolved).toBe(1);
    expect(signals[1].outcome).toBeUndefined();
    expect(signals[1].rr).toBeUndefined();
  });

  it('a still-open row vetoes its signal — a partial close must not grade early', () => {
    const signals = [sig('s1')];
    const summary = resolveSignalOutcomes(signals, [
      { signalId: 's1', closedAt: 2_000, pnl: 50, riskUsd: 25 },   // TP1 slice
      { signalId: 's1' },                                           // remainder still open
    ]);
    expect(summary.resolved).toBe(0);
    expect(signals[0].outcome).toBeUndefined();
  });

  it('a closed row without a finite pnl cannot say win or loss', () => {
    const signals = [sig('s1')];
    resolveSignalOutcomes(signals, [{ signalId: 's1', closedAt: 2_000 }]);
    expect(signals[0].outcome).toBeUndefined();
  });

  it('nets multiple closed rows for one signal (TP1 partial + terminal slice)', () => {
    const signals = [sig('s1')];
    resolveSignalOutcomes(signals, [
      { signalId: 's1', closedAt: 2_000, pnl: 80, riskUsd: 50 },
      { signalId: 's1', closedAt: 3_000, pnl: -30, riskUsd: 50 },
    ]);
    expect(signals[0].outcome).toBe('win');
    expect(signals[0].rr).toBe(0.5); // |80 − 30| / (50 + 50)
  });

  it('is idempotent — a repeat pass reports alreadyResolved and rewrites nothing', () => {
    const signals = [sig('s1')];
    const sources: SignalOutcomeSource[] = [{ signalId: 's1', closedAt: 2_000, pnl: 10, riskUsd: 20 }];
    resolveSignalOutcomes(signals, sources);
    const rr = signals[0].rr;
    const second = resolveSignalOutcomes(signals, sources);
    expect(second).toEqual({ scanned: 1, resolved: 0, alreadyResolved: 1, unresolved: 0 });
    expect(signals[0].rr).toBe(rr);
  });
});

// The SHIPPED path: the engine's own getReportSnapshot() must perform the join
// over its persisted books — this is exactly the backfill seam, since rows
// fired under a build that never resolved anything re-enter through
// importTradeSnapshot and must resolve on the first post-deploy read.
describe('SignalEngine.getReportSnapshot resolves signal outcomes from the closed books (TRA-5275)', () => {
  function engineWith(input: {
    dailySignals: DailySignalRecord[];
    closedPositions?: Position[];
    openPositions?: Position[];
    closedOptions?: OptionPosition[];
  }): SignalEngine {
    const engine = new SignalEngine();
    engine.importTradeSnapshot({
      closedPositions: input.closedPositions ?? [],
      recentSignals: [],
      dailySignals: input.dailySignals,
      positionSignalType: [],
      account: {
        cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0,
        openPositions: input.openPositions ?? [],
      },
      options: {
        openOptions: [], closedOptions: input.closedOptions ?? [], optionsPnl: 0,
        dailyCount: 0, currentDayKey: '2026-10-06', cash: 25_000, equity: 25_000,
      },
    } as unknown as Parameters<SignalEngine['importTradeSnapshot']>[0]);
    return engine;
  }

  function equityClose(signalId: string, pnl: number): Position {
    return {
      id: `pos-${signalId}`, symbol: 'AAPL', side: 'buy', signalType: 'momentum',
      signalId, entryPrice: 100, quantity: 2, stopLoss: 95, takeProfit: 110,
      openedAt: 1_500, closedAt: 2_000, pnl, mode: 'demo',
    } as unknown as Position;
  }

  function optionClose(signalId: string, pnl: number): OptionPosition {
    return {
      id: `opt-${signalId}`, symbol: 'TSLA', signalId, signalType: 'relative_value',
      contracts: 1, premiumPaid: 1.5, openedAt: 1_500, closedAt: 2_500, pnl,
      mode: 'demo',
    } as unknown as OptionPosition;
  }

  it('resolves equity and option signals by id and leaves reject-path rows unresolved', () => {
    const engine = engineWith({
      dailySignals: [
        sig('eq-1', { symbol: 'AAPL', type: 'momentum' }),
        sig('op-1', { symbol: 'TSLA' }),
        // Reject-path record: the scanner fired it, nothing ever opened.
        sig('rv-reject', { symbol: 'TSLA' }),
      ],
      closedPositions: [equityClose('eq-1', 75)],
      closedOptions: [optionClose('op-1', -60)],
    });

    const rows = engine.getReportSnapshot().dailySignals;
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get('eq-1')?.outcome).toBe('win');
    expect(byId.get('eq-1')?.rr).toBe(7.5); // 75 / (|100−95| × 2)
    expect(byId.get('op-1')?.outcome).toBe('loss');
    expect(byId.get('op-1')?.rr).toBe(0.4); // 60 / (1.5 × 1 × 100)
    // Negative control on the shipped path.
    expect(byId.get('rv-reject')?.outcome).toBeUndefined();
  });

  it('does not resolve a signal whose position is still open', () => {
    const open = {
      id: 'pos-live', symbol: 'NVDA', side: 'buy', signalType: 'momentum',
      signalId: 'eq-open', entryPrice: 50, quantity: 1, stopLoss: 48,
      takeProfit: 55, openedAt: 1_500, mode: 'demo',
    } as unknown as Position;
    const engine = engineWith({
      dailySignals: [sig('eq-open', { symbol: 'NVDA', type: 'momentum' })],
      openPositions: [open],
    });
    expect(engine.getReportSnapshot().dailySignals[0].outcome).toBeUndefined();
  });
});
