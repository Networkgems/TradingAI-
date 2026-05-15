import { describe, it, expect } from 'vitest';
import type { OptionChainRow } from '@trading-app/engine';
import { findMispricedOtmContracts } from '@trading-app/engine';
import { OTM_RISK_PARAMS, RV_RISK_PARAMS } from '@trading-app/shared';
import { OptionsReplayAccount } from './options-replay-account.js';
import { estimateSpotFromChain, type ChainDay, type OptionChainSnapshotFile } from './options-chain-store.js';
import { summarizeBucket, maxDrawdown, buildCsv, buildMarkdown } from './options-replay-report.js';
import { replayBucket, runOptionsReplay, DEFAULT_REPLAY_CONFIG } from './run-options-replay.js';

// ── OptionsReplayAccount ────────────────────────────────────────────────────

const ACCT_CFG = {
  managedAccountRatio: 0.5,
  optionsDailyTradesLimit: 10,
  otmRiskParams: OTM_RISK_PARAMS,
  rvRiskParams: RV_RISK_PARAMS,
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
