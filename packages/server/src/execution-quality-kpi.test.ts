import { describe, it, expect } from 'vitest';
import type { Position } from '@trading-app/shared';
import {
  optionExecutionFills,
  positionExecutionFills,
  buildExecutionQualityKpi,
} from './execution-quality-kpi.js';
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';

function optRec(over: Partial<LiveOptionFillRecord>): LiveOptionFillRecord {
  return {
    mode: 'live',
    ts: 1,
    etDay: '2026-07-17',
    sleeve: 'single_leg_rv',
    optionSymbol: 'AAPL260117C00200000',
    side: 'buy_to_open',
    contracts: 1,
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    filledPrice: null,
    fees: null,
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: null,
    ...over,
  };
}

function pos(over: Partial<Position>): Position {
  return {
    id: 'p1',
    symbol: 'AAPL',
    side: 'buy',
    signalType: 'orb_breakout',
    signalId: 's1',
    entryPrice: 100,
    quantity: 10,
    stopLoss: 95,
    takeProfit: 110,
    openedAt: 1,
    ...over,
  };
}

describe('optionExecutionFills (TRA-1981)', () => {
  it('a BUY filled ABOVE mid paid up → positive realized; modeled = |ask−mid| × contracts × 100', () => {
    // mid 1.00, ask 1.10, filled 1.06, 2 contracts.
    const [f] = optionExecutionFills([
      optRec({ side: 'buy_to_open', contracts: 2, midAtSubmit: 1.0, askAtSubmit: 1.1, filledPrice: 1.06 }),
    ]);
    expect(f.assetClass).toBe('options');
    // realized = (1.06 − 1.00) × 2 × 100 = 12
    expect(f.realizedUsd).toBeCloseTo(12, 6);
    // modeled = |1.10 − 1.00| × 2 × 100 = 20
    expect(f.modeledUsd).toBeCloseTo(20, 6);
  });

  it('a SELL filled BELOW mid gave up edge → positive realized (signed into cost by side)', () => {
    // sell filled 0.94 vs mid 1.00 → gave up 0.06/contract of edge = a cost.
    const [f] = optionExecutionFills([
      optRec({ side: 'sell_to_close', contracts: 1, midAtSubmit: 1.0, askAtSubmit: 1.1, filledPrice: 0.94 }),
    ]);
    // realized = −(0.94 − 1.00) × 1 × 100 = +6
    expect(f.realizedUsd).toBeCloseTo(6, 6);
  });

  it('TRA-1707: a one-sided quote (no ask) leaves modeled null, a missing fill leaves realized null', () => {
    const [noAsk] = optionExecutionFills([optRec({ midAtSubmit: 1.0, filledPrice: 1.05, askAtSubmit: null })]);
    expect(noAsk.realizedUsd).not.toBeNull();
    expect(noAsk.modeledUsd).toBeNull();

    const [noFill] = optionExecutionFills([optRec({ midAtSubmit: 1.0, askAtSubmit: 1.1, filledPrice: null })]);
    expect(noFill.realizedUsd).toBeNull();
    expect(noFill.modeledUsd).not.toBeNull();
  });
});

describe('positionExecutionFills (TRA-1981)', () => {
  it('maps the TRA-536 stamp; a position without it is fully unmeasured (null/null)', () => {
    const fills = positionExecutionFills(
      [
        pos({ realizedSlippage: 3, modeledSlippage: 2 }),
        pos({ id: 'p2' }), // no stamp
      ],
      'equity',
    );
    expect(fills[0]).toMatchObject({ assetClass: 'equity', realizedUsd: 3, modeledUsd: 2 });
    expect(fills[1].realizedUsd).toBeNull();
    expect(fills[1].modeledUsd).toBeNull();
  });
});

describe('buildExecutionQualityKpi (TRA-1981)', () => {
  it('folds all three sources into a per-asset-class KPI', () => {
    const kpi = buildExecutionQualityKpi({
      equityPositions: [pos({ realizedSlippage: 4, modeledSlippage: 2 })],
      cryptoPositions: [pos({ symbol: 'BTC-USD', realizedSlippage: 6, modeledSlippage: 2 })],
      optionRecords: [
        optRec({ side: 'buy_to_open', contracts: 1, midAtSubmit: 1.0, askAtSubmit: 1.1, filledPrice: 1.1 }),
      ],
    });
    expect(kpi.byAssetClass.equity.decayRatio).toBe(2); // 4/2
    expect(kpi.byAssetClass.crypto.decayRatio).toBe(3); // 6/2
    // option realized = (1.10−1.00)×100 = 10, modeled = (1.10−1.00)×100 = 10 → 1.0
    expect(kpi.byAssetClass.options.decayRatio).toBe(1);
    expect(kpi.overall.measured).toBe(3);
  });

  it('an empty source set yields an honest empty KPI (no measured fills)', () => {
    const kpi = buildExecutionQualityKpi({ optionRecords: [] });
    expect(kpi.overall.fills).toBe(0);
    expect(kpi.overall.decayRatio).toBeNull();
  });
});
