import { describe, it, expect } from 'vitest';
import type { OptionChainRow } from '@trading-app/engine';
import { findMispricedOtmContracts } from '@trading-app/engine';
import { OTM_RISK_PARAMS, RV_RISK_PARAMS } from '@trading-app/shared';
import {
  OptionsReplayAccount,
  spreadPayoffPerLot,
  type OpenSpreadCandidate,
} from './options-replay-account.js';
import { estimateSpotFromChain, type ChainDay, type OptionChainSnapshotFile } from './options-chain-store.js';
import { summarizeBucket, summarizeByStructure, maxDrawdown, buildCsv, buildMarkdown } from './options-replay-report.js';
import { replayBucket, runOptionsReplay, DEFAULT_REPLAY_CONFIG } from './run-options-replay.js';

// ── OptionsReplayAccount ────────────────────────────────────────────────────

const SPREAD_CFG = {
  put_write: { budgetRatio: 0.5 },
  call_debit_spread: { budgetRatio: 0.05 },
} as const;

const ACCT_CFG = {
  managedAccountRatio: 0.5,
  optionsDailyTradesLimit: 10,
  otmRiskParams: OTM_RISK_PARAMS,
  rvRiskParams: RV_RISK_PARAMS,
  spreadRiskParams: SPREAD_CFG,
};

const otmRiskOf = () => ({
  trailActivatePct: OTM_RISK_PARAMS.trailActivatePct,
  trailOffsetPct: OTM_RISK_PARAMS.trailOffsetPct,
  partialExitRatio: OTM_RISK_PARAMS.partialExitRatio,
});

function otmCandidate(over: Partial<Parameters<OptionsReplayAccount['openOtm']>[0]> = {}) {
  return {
    symbol: 'AAPL',
    optionSymbol: 'AAPL260619C00200000',
    optionType: 'call' as const,
    strike: 200,
    expiration: '2026-06-19',
    mark: 1.0,
    classification: 'cheap' as const,
    ...over,
  };
}

describe('OptionsReplayAccount sizing', () => {
  it('sizes OTM contracts = floor(equity × mr × budgetRatio / (mark × 100))', () => {
    // 10000 × 0.5 × 0.025 = $125 budget. mark $0.30 → $30/contract → 4 contracts.
    const acct = new OptionsReplayAccount({ initialEquity: 10_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    const out = acct.openOtm(otmCandidate({ mark: 0.3 }));
    expect(out.reason).toBe('opened');
    expect(out.position?.contracts).toBe(4);
  });

  it('reports zero_size when the budget cannot afford a single contract', () => {
    // 2000 × 0.5 × 0.025 = $25 budget. mark $1.00 → $100/contract → 0 contracts.
    const acct = new OptionsReplayAccount({ initialEquity: 2_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    const out = acct.openOtm(otmCandidate({ mark: 1.0 }));
    expect(out.reason).toBe('zero_size');
    expect(out.position).toBeNull();
    expect(acct.getOpenPositions()).toHaveLength(0);
  });

  it('rejects a duplicate OCC symbol', () => {
    const acct = new OptionsReplayAccount({ initialEquity: 50_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    expect(acct.openOtm(otmCandidate({ mark: 0.5 })).reason).toBe('opened');
    expect(acct.openOtm(otmCandidate({ mark: 0.5 })).reason).toBe('duplicate');
  });

  it('enforces the daily entries cap', () => {
    const acct = new OptionsReplayAccount({
      initialEquity: 50_000,
      ...ACCT_CFG,
      optionsDailyTradesLimit: 2,
    });
    acct.startDay('2026-05-01');
    expect(acct.openOtm(otmCandidate({ optionSymbol: 'A1', mark: 0.5 })).reason).toBe('opened');
    expect(acct.openOtm(otmCandidate({ optionSymbol: 'A2', mark: 0.5 })).reason).toBe('opened');
    expect(acct.openOtm(otmCandidate({ optionSymbol: 'A3', mark: 0.5 })).reason).toBe('daily_cap');
  });

  it('resets the daily cap when a new day starts', () => {
    const acct = new OptionsReplayAccount({
      initialEquity: 50_000,
      ...ACCT_CFG,
      optionsDailyTradesLimit: 1,
    });
    acct.startDay('2026-05-01');
    expect(acct.openOtm(otmCandidate({ optionSymbol: 'A1', mark: 0.5 })).reason).toBe('opened');
    expect(acct.openOtm(otmCandidate({ optionSymbol: 'A2', mark: 0.5 })).reason).toBe('daily_cap');
    acct.startDay('2026-05-02');
    expect(acct.openOtm(otmCandidate({ optionSymbol: 'A3', mark: 0.5 })).reason).toBe('opened');
  });
});

describe('OptionsReplayAccount exits', () => {
  it('closes a position at the hard stop loss', () => {
    const acct = new OptionsReplayAccount({ initialEquity: 50_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    const opened = acct.openOtm(otmCandidate({ mark: 1.0 })).position!;
    // OTM SL = 20% → stop at $0.80. Drop the mark below it.
    acct.startDay('2026-05-02');
    acct.markAndCheckExits('2026-05-02', new Map([[opened.optionSymbol, 0.5]]), otmRiskOf);
    const closed = acct.getClosedPositions();
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('stop_loss');
    // Loss = (0.80 − 1.00) × contracts × 100.
    expect(closed[0].pnl).toBeLessThan(0);
  });

  it('takes a partial profit at TP1 and trails the remainder', () => {
    const acct = new OptionsReplayAccount({ initialEquity: 100_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    // budget 100000 × 0.5 × 0.025 = $1250; mark $1 → $100/contract → 12 contracts.
    const opened = acct.openOtm(otmCandidate({ mark: 1.0 })).position!;
    expect(opened.contracts).toBe(12);
    acct.startDay('2026-05-02');
    // OTM TP1 = +50% → $1.50. Mark jumps to $1.60.
    acct.markAndCheckExits('2026-05-02', new Map([[opened.optionSymbol, 1.6]]), otmRiskOf);
    const open = acct.getOpenPositions();
    expect(open).toHaveLength(1);
    expect(open[0].tp1Hit).toBe(true);
    expect(open[0].contractsRemaining).toBeLessThan(12);
  });

  it('force-closes a contract once its expiration is past', () => {
    const acct = new OptionsReplayAccount({ initialEquity: 50_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    const opened = acct.openOtm(otmCandidate({ expiration: '2026-05-02', mark: 1.0 })).position!;
    acct.startDay('2026-05-03');
    // No mark for the OCC symbol → expires worthless at $0.
    acct.expireOrForceCloseDueContracts('2026-05-03', new Map());
    const closed = acct.getClosedPositions();
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('expired');
    expect(closed[0].pnl).toBeLessThan(0);
    expect(opened.contracts).toBeGreaterThan(0);
  });
});

// ── TRA-800 defined-risk structures (put-write + call debit spread) ──────────

describe('spreadPayoffPerLot', () => {
  const putLeg = [{ action: 'sell' as const, optionType: 'put' as const, strike: 100, expiration: '2026-05-15' }];

  it('put-write keeps the full credit above the strike (max profit)', () => {
    // credit 300, maxLoss (100-3)*100 = 9700, maxProfit 300.
    expect(spreadPayoffPerLot(putLeg, 300, 9700, 300, 110)).toBe(300);
  });

  it('put-write loses credit-minus-intrinsic when assigned ITM (partial loss)', () => {
    // spot 98.5 → put intrinsic 1.5 → 300 − 150 = 150.
    expect(spreadPayoffPerLot(putLeg, 300, 9700, 300, 98.5)).toBe(150);
  });

  it('put-write is clamped to its defined max loss at the floor', () => {
    // spot 0 → intrinsic 100 → 300 − 10000 = −9700 (== −maxLoss, already at band).
    expect(spreadPayoffPerLot(putLeg, 300, 9700, 300, 0)).toBe(-9700);
  });

  it('call debit spread caps profit at width − debit', () => {
    const legs = [
      { action: 'buy' as const, optionType: 'call' as const, strike: 100, expiration: '2026-05-15' },
      { action: 'sell' as const, optionType: 'call' as const, strike: 105, expiration: '2026-05-15' },
    ];
    // debit 3 → netUsd −300, maxLoss 300, maxProfit 200.
    expect(spreadPayoffPerLot(legs, -300, 300, 200, 110)).toBe(200); // both ITM → max profit
    expect(spreadPayoffPerLot(legs, -300, 300, 200, 95)).toBe(-300); // both OTM → max loss
    expect(spreadPayoffPerLot(legs, -300, 300, 200, 102)).toBe(-100); // long-only ITM → partial loss
  });
});

function putWriteCandidate(over: Partial<OpenSpreadCandidate> = {}): OpenSpreadCandidate {
  return {
    symbol: 'XYZ',
    strategy: 'put_write',
    legs: [{ action: 'sell', optionType: 'put', strike: 100, expiration: '2026-05-15' }],
    netUsd: 300,
    maxLossUsd: 9700,
    maxProfitUsd: 300,
    breakevens: [97],
    expiration: '2026-05-15',
    spot: 105,
    classification: 'put_write',
    ...over,
  };
}

function callDebitSpreadCandidate(over: Partial<OpenSpreadCandidate> = {}): OpenSpreadCandidate {
  return {
    symbol: 'XYZ',
    strategy: 'call_debit_spread',
    legs: [
      { action: 'buy', optionType: 'call', strike: 100, expiration: '2026-05-15' },
      { action: 'sell', optionType: 'call', strike: 105, expiration: '2026-05-15' },
    ],
    netUsd: -300,
    maxLossUsd: 300,
    maxProfitUsd: 200,
    breakevens: [103],
    expiration: '2026-05-15',
    spot: 100,
    classification: 'call_debit_spread',
    ...over,
  };
}

describe('OptionsReplayAccount put-write structure', () => {
  it('sizes off the per-structure budget and reserves the capped capital-at-risk', () => {
    // budget = 100000 × 0.5 × 0.5 = $25k; maxLoss/lot $9700 → 2 lots.
    const acct = new OptionsReplayAccount({ initialEquity: 100_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    const out = acct.openSpread(putWriteCandidate());
    expect(out.reason).toBe('opened');
    expect(out.position?.contracts).toBe(2);
    expect(out.position?.isCombo).toBe(true);
    // Reserved capital = 2 × 9700 = 19400 → equity unchanged, cash debited.
    expect(acct.getRealizedPnl()).toBe(0);
  });

  it('settles at max profit when the put expires worthless above the strike', () => {
    const acct = new OptionsReplayAccount({ initialEquity: 100_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    acct.openSpread(putWriteCandidate());
    acct.startDay('2026-05-15');
    acct.settleSpreads('2026-05-15', new Map([['XYZ', 110]]));
    const closed = acct.getClosedPositions();
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('settled');
    expect(closed[0].pnl).toBe(600); // 2 lots × $300 max profit
    expect(acct.getRealizedPnl()).toBe(600);
  });

  it('books the capped max loss when no spot is known at expiry', () => {
    const acct = new OptionsReplayAccount({ initialEquity: 100_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    acct.openSpread(putWriteCandidate());
    acct.startDay('2026-05-15');
    acct.settleSpreads('2026-05-15', new Map()); // no spot → max loss
    const closed = acct.getClosedPositions();
    expect(closed[0].pnl).toBe(-19_400); // 2 lots × −$9700
    expect(closed[0].exitReason).toBe('settled');
  });

  it('takes a partial profit when assigned slightly ITM', () => {
    const acct = new OptionsReplayAccount({ initialEquity: 100_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    acct.openSpread(putWriteCandidate());
    acct.startDay('2026-05-15');
    acct.settleSpreads('2026-05-15', new Map([['XYZ', 98.5]]));
    expect(acct.getClosedPositions()[0].pnl).toBe(300); // 2 lots × $150
  });

  it('dedups an already-open structure key', () => {
    const acct = new OptionsReplayAccount({ initialEquity: 100_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    expect(acct.openSpread(putWriteCandidate()).reason).toBe('opened');
    expect(acct.openSpread(putWriteCandidate()).reason).toBe('duplicate');
  });
});

describe('OptionsReplayAccount call-debit-spread structure', () => {
  it('sizes off the debit max-loss and settles at max profit deep ITM', () => {
    // budget = 100000 × 0.5 × 0.05 = $2500; maxLoss/lot $300 → 8 lots.
    const acct = new OptionsReplayAccount({ initialEquity: 100_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    const out = acct.openSpread(callDebitSpreadCandidate());
    expect(out.position?.contracts).toBe(8);
    acct.startDay('2026-05-15');
    acct.settleSpreads('2026-05-15', new Map([['XYZ', 110]]));
    expect(acct.getClosedPositions()[0].pnl).toBe(1600); // 8 × $200 max profit
  });

  it('books max loss when both legs expire OTM', () => {
    const acct = new OptionsReplayAccount({ initialEquity: 100_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    acct.openSpread(callDebitSpreadCandidate());
    acct.startDay('2026-05-15');
    acct.settleSpreads('2026-05-15', new Map([['XYZ', 95]]));
    expect(acct.getClosedPositions()[0].pnl).toBe(-2400); // 8 × −$300 debit
  });

  it('is never managed per tick (markAndCheckExits skips combos)', () => {
    const acct = new OptionsReplayAccount({ initialEquity: 100_000, ...ACCT_CFG });
    acct.startDay('2026-05-01');
    const pos = acct.openSpread(callDebitSpreadCandidate()).position!;
    // Even if a mark for the synthetic combo symbol leaks in, it is ignored.
    acct.markAndCheckExits('2026-05-02', new Map([[pos.optionSymbol, 0.01]]), () => ({
      trailActivatePct: 0.25,
      trailOffsetPct: 0.15,
      partialExitRatio: 0.5,
    }));
    expect(acct.getOpenPositions()).toHaveLength(1);
    expect(acct.getClosedPositions()).toHaveLength(0);
  });
});

describe('summarizeByStructure', () => {
  it('reports expectancy, win-rate, Sharpe, and max-DD per structure', () => {
    const closed = [
      { signalType: 'put_write', pnl: 300, closedAtDay: '2026-05-15' },
      { signalType: 'put_write', pnl: -100, closedAtDay: '2026-05-16' },
      { signalType: 'put_write', pnl: 200, closedAtDay: '2026-05-17' },
      { signalType: 'call_debit_spread', pnl: -300, closedAtDay: '2026-05-15' },
    ] as unknown as Parameters<typeof summarizeByStructure>[0];
    const stats = summarizeByStructure(closed);
    const pw = stats.find((s) => s.structure === 'put_write')!;
    expect(pw.trades).toBe(3);
    expect(pw.winners).toBe(2);
    expect(pw.winRate).toBeCloseTo(2 / 3, 5);
    expect(pw.totalPnl).toBe(400);
    expect(pw.expectancy).toBeCloseTo(400 / 3, 5);
    expect(pw.maxDrawdown).toBe(100); // peak 300 → trough 200 after the −100 trade
    expect(pw.sharpe).not.toBe(0);
    const cds = stats.find((s) => s.structure === 'call_debit_spread')!;
    expect(cds.trades).toBe(1);
    expect(cds.sharpe).toBe(0); // < 2 trades → undefined Sharpe → 0
  });
});

// ── estimateSpotFromChain ───────────────────────────────────────────────────

describe('estimateSpotFromChain', () => {
  it('recovers the spot via put-call parity at the ATM strike', () => {
    const rows: OptionChainRow[] = [
      { optionSymbol: 'C95', underlying: 'X', optionType: 'call', strike: 95, expiration: '2026-06-19', bid: 7.0, ask: 7.2 },
      { optionSymbol: 'P95', underlying: 'X', optionType: 'put', strike: 95, expiration: '2026-06-19', bid: 2.0, ask: 2.2 },
      { optionSymbol: 'C100', underlying: 'X', optionType: 'call', strike: 100, expiration: '2026-06-19', bid: 4.0, ask: 4.2 },
      { optionSymbol: 'P100', underlying: 'X', optionType: 'put', strike: 100, expiration: '2026-06-19', bid: 4.0, ask: 4.2 },
    ];
    // At K=100 call mid == put mid → spot ≈ 100.
    const spot = estimateSpotFromChain(rows);
    expect(spot).toBeGreaterThan(95);
    expect(spot).toBeLessThan(105);
  });

  it('returns null when no paired call/put exists', () => {
    const rows: OptionChainRow[] = [
      { optionSymbol: 'C100', underlying: 'X', optionType: 'call', strike: 100, expiration: '2026-06-19', bid: 4.0, ask: 4.2 },
    ];
    expect(estimateSpotFromChain(rows)).toBeNull();
  });
});

// ── report ──────────────────────────────────────────────────────────────────

describe('maxDrawdown', () => {
  it('measures the largest peak-to-trough drop', () => {
    const curve = [
      { day: 'd1', equity: 1000, cash: 1000, openPositions: 0 },
      { day: 'd2', equity: 1200, cash: 1200, openPositions: 0 },
      { day: 'd3', equity: 900, cash: 900, openPositions: 0 },
      { day: 'd4', equity: 1100, cash: 1100, openPositions: 0 },
    ];
    const dd = maxDrawdown(curve);
    expect(dd.dollars).toBe(300); // 1200 → 900
    expect(dd.pct).toBeCloseTo(0.25, 5);
  });
});

describe('summarizeBucket', () => {
  it('aggregates win rate, P&L, and per-classification hit-rate', () => {
    const closed = [
      { classification: 'cheap', signalType: 'otm_mispricing', pnl: 100 },
      { classification: 'cheap', signalType: 'relative_value', pnl: -50 },
      { classification: 'below_intrinsic', signalType: 'relative_value', pnl: 200 },
    ] as unknown as Parameters<typeof summarizeBucket>[0]['closed'];
    const result = summarizeBucket({
      startingEquity: 10_000,
      managedAccountRatio: 0.5,
      closed,
      equityCurve: [
        { day: 'd1', equity: 10_000, cash: 10_000, openPositions: 0 },
        { day: 'd2', equity: 10_250, cash: 10_250, openPositions: 0 },
      ],
      skippedZeroSize: 4,
    });
    expect(result.trades).toBe(3);
    expect(result.winners).toBe(2);
    expect(result.winRate).toBeCloseTo(2 / 3, 5);
    expect(result.totalPnl).toBe(250);
    expect(result.pnlPct).toBeCloseTo(0.025, 5);
    expect(result.skippedZeroSize).toBe(4);
    expect(result.otmTrades).toBe(1);
    expect(result.rvTrades).toBe(2);
    const cheap = result.byClassification.find((c) => c.classification === 'cheap')!;
    expect(cheap.trades).toBe(2);
    expect(cheap.hitRate).toBeCloseTo(0.5, 5);
  });
});

describe('report serialization', () => {
  const buckets = [
    summarizeBucket({
      startingEquity: 2000,
      managedAccountRatio: 0.5,
      closed: [],
      equityCurve: [{ day: 'd1', equity: 2000, cash: 2000, openPositions: 0 }],
      skippedZeroSize: 7,
    }),
  ];

  it('builds a CSV with a header and a bucket row', () => {
    const csv = buildCsv(buckets);
    expect(csv.split('\n')[0]).toContain('startingEquity');
    expect(csv).toContain('bucket,2000');
  });

  it('builds a markdown summary that names the empty bucket', () => {
    const md = buildMarkdown({ buckets, daysReplayed: 5, symbolsCount: 3, generatedAt: 0 });
    expect(md).toContain('# Option-chain replay backtest — TRA-376');
    expect(md).toContain('sizing collapsed to 0 contracts');
  });
});

// ── end-to-end replay ───────────────────────────────────────────────────────

/**
 * Build a chain with a deliberately cheap OTM call: a 10%-OTM call carrying a
 * fat 60% smvVol (so the Black-Scholes theo is rich) but quoted at a thin
 * $0.80 mark — `(mark − theo)/theo` lands well below the −15% cheap threshold.
 */
function cheapOtmChain(recordedAt: number): OptionChainRow[] {
  const expiration = '2026-06-19';
  const rows: OptionChainRow[] = [];
  // A spread of strikes so the scanner has a chain to work with.
  for (const strike of [105, 110, 115, 120]) {
    rows.push({
      optionSymbol: `AAPL260619C00${strike}000`,
      underlying: 'AAPL',
      optionType: 'call',
      strike,
      expiration,
      bid: 0.75,
      ask: 0.85,
      last: 0.8,
      volume: 500,
      openInterest: 800,
      smvVol: 0.6,
    });
  }
  void recordedAt;
  return rows;
}

function makeChainDay(date: string, recordedAt: number): ChainDay {
  const file: OptionChainSnapshotFile = {
    symbol: 'AAPL',
    spot: 100,
    recordedAt,
    expirations: ['2026-06-19'],
    rows: cheapOtmChain(recordedAt),
  };
  return { date, bySymbol: new Map([['AAPL', file]]) };
}

describe('runOptionsReplay end-to-end', () => {
  // 2026-05-15 recordedAt — ~35 days to the 2026-06-19 expiration.
  const recordedAt = Date.parse('2026-05-15T19:55:00Z');

  it('fires a cheap OTM entry once the chain has a cheap candidate', () => {
    // Sanity-check the fixture actually produces a cheap candidate.
    const otm = findMispricedOtmContracts(cheapOtmChain(recordedAt), 100, { now: recordedAt });
    expect(otm.some((c) => c.classification === 'cheap')).toBe(true);

    const days: ChainDay[] = [
      makeChainDay('2026-05-15', recordedAt),
      makeChainDay('2026-05-18', recordedAt + 3 * 86_400_000),
    ];
    const result = replayBucket(days, 50_000, DEFAULT_REPLAY_CONFIG);
    expect(result.trades + result.byClassification.length).toBeGreaterThan(0);
    expect(result.startingEquity).toBe(50_000);
  });

  it('produces one BucketResult per configured equity bucket', () => {
    const days: ChainDay[] = [makeChainDay('2026-05-15', recordedAt)];
    const buckets = runOptionsReplay(days, DEFAULT_REPLAY_CONFIG);
    expect(buckets.map((b) => b.startingEquity)).toEqual([2000, 5000, 10000]);
  });

  it('skips entries at $2k where sizing collapses but fires them at $10k', () => {
    const days: ChainDay[] = [
      makeChainDay('2026-05-15', recordedAt),
      makeChainDay('2026-05-18', recordedAt + 3 * 86_400_000),
    ];
    const small = replayBucket(days, 2000, DEFAULT_REPLAY_CONFIG);
    const large = replayBucket(days, 25_000, DEFAULT_REPLAY_CONFIG);
    // $2k OTM budget = 2000 × 0.5 × 0.025 = $25 < $80/contract → every candidate skipped.
    expect(small.trades).toBe(0);
    expect(small.skippedZeroSize).toBeGreaterThan(0);
    // $25k OTM budget = 25000 × 0.5 × 0.025 = $312 → ≥3 contracts → entry fires.
    expect(large.trades).toBeGreaterThan(0);
  });

  it('handles an empty data set without throwing', () => {
    expect(runOptionsReplay([], DEFAULT_REPLAY_CONFIG)).toHaveLength(3);
  });
});

// ── TRA-800 end-to-end: structures replayed on a captured-chain fixture ───────

/**
 * A chain carrying priceable calls AND puts around `spot` so both the put-write
 * and the call-debit-spread modelers can build a structure. Strikes step by 5.
 */
function structureChain(spot: number, expiration: string): OptionChainRow[] {
  const rows: OptionChainRow[] = [];
  for (const strike of [90, 95, 100, 105, 110]) {
    // Crude monotone marks: deeper-ITM calls richer, deeper-ITM puts richer.
    const callMid = Math.max(0.5, spot - strike + 3);
    const putMid = Math.max(0.5, strike - spot + 3);
    rows.push({
      optionSymbol: `XYZ${expiration.replace(/-/g, '')}C${strike}`,
      underlying: 'XYZ', optionType: 'call', strike, expiration,
      bid: callMid - 0.1, ask: callMid + 0.1, last: callMid, volume: 200, openInterest: 400,
    });
    rows.push({
      optionSymbol: `XYZ${expiration.replace(/-/g, '')}P${strike}`,
      underlying: 'XYZ', optionType: 'put', strike, expiration,
      bid: putMid - 0.1, ask: putMid + 0.1, last: putMid, volume: 200, openInterest: 400,
    });
  }
  return rows;
}

function structureDay(date: string, spot: number, expiration: string, recordedAt: number): ChainDay {
  const file: OptionChainSnapshotFile = {
    symbol: 'XYZ', spot, recordedAt, expirations: [expiration], rows: structureChain(spot, expiration),
  };
  return { date, bySymbol: new Map([['XYZ', file]]) };
}

describe('runOptionsReplay structures end-to-end (TRA-800)', () => {
  const exp = '2026-05-29';
  const t0 = Date.parse('2026-05-15T19:55:00Z');

  it('produces a per-structure BucketResult for put-write and call-debit-spread', () => {
    const days: ChainDay[] = [
      structureDay('2026-05-15', 100, exp, t0),               // put-write opens; no trend yet
      structureDay('2026-05-18', 102, exp, t0 + 3 * 86_400_000), // rising → call spread opens
      structureDay('2026-05-29', 108, exp, t0 + 14 * 86_400_000), // expiry → both settle
    ];
    const result = replayBucket(days, 100_000, DEFAULT_REPLAY_CONFIG);

    const pw = result.byStructure.find((s) => s.structure === 'put_write');
    const cds = result.byStructure.find((s) => s.structure === 'call_debit_spread');
    expect(pw).toBeDefined();
    expect(cds).toBeDefined();
    // Both structures settled (no open combos left at the tail).
    expect(pw!.trades).toBeGreaterThanOrEqual(1);
    expect(cds!.trades).toBeGreaterThanOrEqual(1);
    // Each BucketResult structure block carries the four required metrics.
    for (const s of [pw!, cds!]) {
      expect(Number.isFinite(s.expectancy)).toBe(true);
      expect(Number.isFinite(s.winRate)).toBe(true);
      expect(Number.isFinite(s.sharpe)).toBe(true);
      expect(Number.isFinite(s.maxDrawdown)).toBe(true);
    }
    // Rising tape to expiry → both structures land profitable here.
    expect(pw!.totalPnl).toBeGreaterThan(0);
    expect(cds!.totalPnl).toBeGreaterThan(0);
  });

  it('gates the call debit spread on the rising-spot trend filter', () => {
    // Falling tape on day 2 → trend filter fails → no call-debit-spread entry.
    const days: ChainDay[] = [
      structureDay('2026-05-15', 100, exp, t0),
      structureDay('2026-05-18', 96, exp, t0 + 3 * 86_400_000), // falling
      structureDay('2026-05-29', 96, exp, t0 + 14 * 86_400_000),
    ];
    const result = replayBucket(days, 100_000, DEFAULT_REPLAY_CONFIG);
    expect(result.byStructure.find((s) => s.structure === 'call_debit_spread')).toBeUndefined();
    // The put-write (no trend gate) still trades.
    expect(result.byStructure.find((s) => s.structure === 'put_write')).toBeDefined();
  });
});
