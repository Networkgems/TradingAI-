/**
 * TRA-918 (TRA-908 Phase D) — unit tests for the Phase-A signal-driven option
 * backtest + paper-accrual harness. Covers acceptance #3 (a–e):
 *   (a) each of the four structures' payoff at expiry,
 *   (b) the 50%-profit take fires and closes at the right level,
 *   (c) the 21-DTE time stop,
 *   (d) theta/vega aggregation sign convention,
 *   (e) R-multiple expectancy = P&L / entry-defined-risk.
 * Plus acceptance #1 (deterministic/seedless) and #2 (gate-report shape).
 */

import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { DEFAULT_SELECTOR_PARAMS, type ShadowOptionSignal } from '@trading-app/engine';
import {
  OptionsReplayAccount,
  DEFAULT_SPREAD_MANAGEMENT,
  type OptionsReplayAccountConfig,
  type ReplayPosition,
} from './options-replay-account.js';
import { modelSignalStructure } from './options-replay-structures.js';
import {
  replayPhaseABucket,
  buildPhaseAGateReport,
  validateGateReportShape,
  computeBacktestGateMetrics,
  portfolioGreeksForDay,
  defaultPhaseAConfig,
  type PhaseABucketResult,
} from './options-replay-phasea.js';
import { DEFAULT_SPREAD_RISK_PARAMS } from './run-options-replay.js';
import { buildSyntheticChain } from './synthetic-chain.js';
import type { ChainDay, OptionChainSnapshotFile } from './options-chain-store.js';

const DAY_MS = 86_400_000;
const NO_COST = { perLegSlippage: 0, commissionPerContract: 0 };

function makeAccount(equity = 10_000): OptionsReplayAccount {
  const cfg: OptionsReplayAccountConfig = {
    initialEquity: equity,
    managedAccountRatio: 1,
    optionsDailyTradesLimit: 100,
    otmRiskParams: { budgetRatio: 0, tp1Pct: 1, slPct: 1, trailActivatePct: 1, trailOffsetPct: 0, partialExitRatio: 0 } as never,
    rvRiskParams: { budgetRatio: 0, tp1Pct: 1, slPct: 1, trailActivatePct: 1, trailOffsetPct: 0, partialExitRatio: 0 } as never,
    spreadRiskParams: {}, // empty → 0.02 fallback (forces 1 lot at these maxlosses/equity)
  };
  return new OptionsReplayAccount(cfg);
}

/** Build a minimal Phase-A signal (only the fields the modeler reads need be real). */
function signal(
  strategy: ShadowOptionSignal['strategy'],
  legs: Array<{ action: 'buy' | 'sell'; optionType: 'call' | 'put'; strike: number; mark: number }>,
  widthPoints: number,
  expiration = '2026-02-01',
): ShadowOptionSignal {
  return {
    symbol: 'SPY',
    timestamp: 0,
    strategy,
    legs: legs.map((l) => ({ ...l, delta: 0, optionSymbol: `SPY|${l.optionType}|${l.strike}` })),
    expiration,
    daysToExpiry: 31,
    shortDelta: 0.23,
    netCredit: null,
    netDebit: null,
    widthPoints,
    sizingIntent: { maxLossPerSpread: 0, riskFraction: 0.02 },
    rationale: 'test',
  };
}

// ── (a) Four structures' payoff at expiry ───────────────────────────────────

describe('TRA-918 G2 — structure payoff at expiry', () => {
  // Each row: signal, [spotAtExpiry, expectedPerLotPnl] for the max-profit and
  // max-loss legs of the payoff. Marks chosen so credit/debit = 1 / width math
  // is exact (slippage + commission zeroed).
  const cases: Array<{
    name: string;
    sig: ShadowOptionSignal;
    points: Array<[number, number]>;
    band: { maxLoss: number; maxProfit: number };
  }> = [
    {
      name: 'bull_put_spread',
      sig: signal('bull_put_spread', [
        { action: 'sell', optionType: 'put', strike: 100, mark: 2 },
        { action: 'buy', optionType: 'put', strike: 95, mark: 1 },
      ], 5),
      points: [[110, 100], [90, -400]],
      band: { maxLoss: 400, maxProfit: 100 },
    },
    {
      name: 'bear_call_spread',
      sig: signal('bear_call_spread', [
        { action: 'sell', optionType: 'call', strike: 100, mark: 2 },
        { action: 'buy', optionType: 'call', strike: 105, mark: 1 },
      ], 5),
      points: [[90, 100], [110, -400]],
      band: { maxLoss: 400, maxProfit: 100 },
    },
    {
      name: 'iron_condor',
      sig: signal('iron_condor', [
        { action: 'sell', optionType: 'put', strike: 95, mark: 1.5 },
        { action: 'buy', optionType: 'put', strike: 90, mark: 0.5 },
        { action: 'sell', optionType: 'call', strike: 105, mark: 1.5 },
        { action: 'buy', optionType: 'call', strike: 110, mark: 0.5 },
      ], 5),
      points: [[100, 200], [85, -300]],
      band: { maxLoss: 300, maxProfit: 200 },
    },
    {
      name: 'debit_spread',
      sig: signal('debit_spread', [
        { action: 'buy', optionType: 'call', strike: 100, mark: 3 },
        { action: 'sell', optionType: 'call', strike: 105, mark: 1 },
      ], 5),
      points: [[110, 300], [95, -200]],
      band: { maxLoss: 200, maxProfit: 300 },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: defined-risk band + expiry settlement`, () => {
      const cand = modelSignalStructure(c.sig, NO_COST);
      expect(cand).not.toBeNull();
      expect(cand!.maxLossUsd).toBeCloseTo(c.band.maxLoss, 6);
      expect(cand!.maxProfitUsd).toBeCloseTo(c.band.maxProfit, 6);

      for (const [spotAtExpiry, expectedPerLot] of c.points) {
        const acct = makeAccount();
        acct.startDay('2026-01-01');
        const out = acct.openSpread({ ...cand!, spot: 100 });
        expect(out.reason).toBe('opened');
        const lots = out.position!.contracts;
        acct.startDay('2026-02-01');
        acct.settleSpreads('2026-02-01', new Map([['SPY', spotAtExpiry]]));
        const closed = acct.getClosedPositions();
        expect(closed).toHaveLength(1);
        expect(closed[0]!.pnl).toBeCloseTo(expectedPerLot * lots, 4);
      }
    });
  }
});

// ── (b) 50%-profit take ─────────────────────────────────────────────────────

describe('TRA-918 G3 — 50%-profit take', () => {
  it('closes a credit spread at take_profit when ≥50% of max profit is captured', () => {
    // Bull put: entry credit 1.0 → max profit 100. Mid-life mids short 0.6 /
    // long 0.2 → cost-to-close 0.4 ⇒ pnl 60 ≥ 0.5×100 ⇒ TP fires.
    const sig = signal('bull_put_spread', [
      { action: 'sell', optionType: 'put', strike: 100, mark: 2 },
      { action: 'buy', optionType: 'put', strike: 95, mark: 1 },
    ], 5, '2026-04-01');
    const cand = modelSignalStructure(sig, NO_COST)!;
    const acct = makeAccount();
    acct.startDay('2026-01-01');
    const lots = acct.openSpread({ ...cand, spot: 100 }).position!.contracts;

    const mids = new Map<number, number>([[100, 0.6], [95, 0.2]]);
    const manageDay = '2026-01-15';
    acct.markAndManageSpreads(
      manageDay,
      Date.parse(`${manageDay}T00:00:00Z`),
      (_sym, leg) => mids.get(leg.strike) ?? null,
      DEFAULT_SPREAD_MANAGEMENT,
    );

    const closed = acct.getClosedPositions();
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('take_profit');
    expect(closed[0]!.pnl).toBeCloseTo(60 * lots, 4);
  });
});

// ── (c) 21-DTE time stop ────────────────────────────────────────────────────

describe('TRA-918 G3 — 21-DTE time stop', () => {
  it('closes at time_stop when ≤21 DTE and neither TP nor stop fired', () => {
    // Credit 1.0 → max profit 100. Mid-life mids short 0.9 / long 0.1 ⇒
    // cost-to-close 0.8, pnl 20 (< 50 no TP; 80 < 2×100 no stop). At 14 DTE the
    // time stop books the current mark.
    const sig = signal('bull_put_spread', [
      { action: 'sell', optionType: 'put', strike: 100, mark: 2 },
      { action: 'buy', optionType: 'put', strike: 95, mark: 1 },
    ], 5, '2026-03-01');
    const cand = modelSignalStructure(sig, NO_COST)!;
    const acct = makeAccount();
    acct.startDay('2026-01-01');
    const lots = acct.openSpread({ ...cand, spot: 100 }).position!.contracts;

    const mids = new Map<number, number>([[100, 0.9], [95, 0.1]]);
    const manageDay = '2026-02-15'; // 14 DTE to 2026-03-01
    acct.markAndManageSpreads(
      manageDay,
      Date.parse(`${manageDay}T00:00:00Z`),
      (_sym, leg) => mids.get(leg.strike) ?? null,
      DEFAULT_SPREAD_MANAGEMENT,
    );

    const closed = acct.getClosedPositions();
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('time_stop');
    expect(closed[0]!.pnl).toBeCloseTo(20 * lots, 4);
  });

  it('does NOT fire the time stop while DTE is above the floor', () => {
    const sig = signal('bull_put_spread', [
      { action: 'sell', optionType: 'put', strike: 100, mark: 2 },
      { action: 'buy', optionType: 'put', strike: 95, mark: 1 },
    ], 5, '2026-06-01');
    const cand = modelSignalStructure(sig, NO_COST)!;
    const acct = makeAccount();
    acct.startDay('2026-01-01');
    acct.openSpread({ ...cand, spot: 100 });
    const mids = new Map<number, number>([[100, 0.9], [95, 0.1]]);
    const manageDay = '2026-02-15'; // ~106 DTE
    acct.markAndManageSpreads(
      manageDay,
      Date.parse(`${manageDay}T00:00:00Z`),
      (_sym, leg) => mids.get(leg.strike) ?? null,
      DEFAULT_SPREAD_MANAGEMENT,
    );
    expect(acct.getClosedPositions()).toHaveLength(0);
    expect(acct.getOpenPositions()).toHaveLength(1);
  });
});

// ── (d) theta/vega aggregation sign convention ──────────────────────────────

describe('TRA-918 G4 — portfolio greeks sign convention', () => {
  const ivByLeg = (symbol: string, legs: Array<{ optionType: string; strike: number; expiration: string }>) => {
    const m = new Map<string, number>();
    for (const l of legs) m.set(`${symbol.toUpperCase()}|${l.optionType}|${l.strike}|${l.expiration}`, 0.3);
    return m;
  };

  it('short-premium (credit) structure rolls up to +theta / −vega', () => {
    const sig = signal('bull_put_spread', [
      { action: 'sell', optionType: 'put', strike: 95, mark: 2 },
      { action: 'buy', optionType: 'put', strike: 90, mark: 1 },
    ], 5, '2026-01-31');
    const cand = modelSignalStructure(sig, NO_COST)!;
    const acct = makeAccount();
    acct.startDay('2026-01-01');
    acct.openSpread({ ...cand, spot: 100 });
    const open = acct.getOpenPositions();
    const g = portfolioGreeksForDay(
      '2026-01-01',
      open,
      new Map([['SPY', 100]]),
      ivByLeg('SPY', open[0]!.legs!),
      0.045,
    );
    expect(g.openSpreads).toBe(1);
    expect(g.netTheta).toBeGreaterThan(0);
    expect(g.netVega).toBeLessThan(0);
  });

  it('long-premium (debit) structure rolls up to −theta / +vega', () => {
    const sig = signal('debit_spread', [
      { action: 'buy', optionType: 'call', strike: 100, mark: 3 },
      { action: 'sell', optionType: 'call', strike: 105, mark: 1 },
    ], 5, '2026-01-31');
    const cand = modelSignalStructure(sig, NO_COST)!;
    const acct = makeAccount();
    acct.startDay('2026-01-01');
    acct.openSpread({ ...cand, spot: 100 });
    const open = acct.getOpenPositions();
    const g = portfolioGreeksForDay(
      '2026-01-01',
      open,
      new Map([['SPY', 100]]),
      ivByLeg('SPY', open[0]!.legs!),
      0.045,
    );
    expect(g.netTheta).toBeLessThan(0);
    expect(g.netVega).toBeGreaterThan(0);
  });
});

// ── (e) R-multiple expectancy ───────────────────────────────────────────────

describe('TRA-918 G5 — R-multiple expectancy = P&L / entry defined risk', () => {
  it('expectancy is the mean of per-trade P&L ÷ entry defined risk', () => {
    const closed = [
      { pnl: 100, maxLossPerLot: 200, contracts: 1, closedAtDay: '2026-01-02' }, // R = +0.5
      { pnl: -200, maxLossPerLot: 200, contracts: 1, closedAtDay: '2026-01-03' }, // R = -1.0
    ] as unknown as ReplayPosition[];
    const m = computeBacktestGateMetrics(closed, 10_000);
    expect(m.tradeCount).toBe(2);
    expect(m.expectancy).toBeCloseTo(-0.25, 6); // mean(0.5, -1.0)
    expect(m.profitFactor).toBeCloseTo(0.5, 6); // 100 / 200
    expect(m.maxDrawdown).toBeGreaterThan(0);
  });

  it('R uses contracts in the defined-risk denominator', () => {
    const closed = [
      { pnl: 300, maxLossPerLot: 200, contracts: 3, closedAtDay: '2026-01-02' }, // risk 600, R = +0.5
    ] as unknown as ReplayPosition[];
    const m = computeBacktestGateMetrics(closed, 10_000);
    expect(m.expectancy).toBeCloseTo(0.5, 6);
  });
});

// ── Fill realism: slippage + commission shrink edge ─────────────────────────

describe('TRA-918 — fill realism', () => {
  it('per-leg slippage + commission reduce a credit and are recorded', () => {
    const sig = signal('bull_put_spread', [
      { action: 'sell', optionType: 'put', strike: 100, mark: 2 },
      { action: 'buy', optionType: 'put', strike: 95, mark: 1 },
    ], 5);
    const ideal = modelSignalStructure(sig, NO_COST)!;
    const real = modelSignalStructure(sig, { perLegSlippage: 0.05, commissionPerContract: 0.65 })!;
    // Credit drops (slippage on both legs + commission), so max profit < ideal.
    expect(real.maxProfitUsd).toBeLessThan(ideal.maxProfitUsd);
    expect(real.modeledSlippageUsd).toBeGreaterThan(0);
  });
});

// ── (#2) gate-report shape + (#1) determinism ───────────────────────────────

function syntheticDays(): ChainDay[] {
  const baseMs = Date.parse('2026-01-01T00:00:00Z');
  const bars: Candle[] = [];
  for (let i = 0; i < 50; i += 1) {
    const close = 100 * (1 + 0.003 * i); // gentle deterministic uptrend
    bars.push({ symbol: 'SPY', timestamp: baseMs + i * DAY_MS, open: close, high: close, low: close, close, volume: 1_000_000 });
  }
  const days: ChainDay[] = [];
  for (let i = 21; i < bars.length; i += 1) {
    const file = buildSyntheticChain('SPY', bars.slice(0, i + 1));
    if (!file) continue;
    // Force a high IV-rank so the short-premium gate engages on the uptrend.
    (file as { ivRank: number | null }).ivRank = 60;
    const day: ChainDay = {
      date: new Date(file.recordedAt).toISOString().slice(0, 10),
      bySymbol: new Map<string, OptionChainSnapshotFile>([['SPY', file as unknown as OptionChainSnapshotFile]]),
    };
    days.push(day);
  }
  return days;
}

describe('TRA-918 — Phase-A replay: deterministic + gate-report shape', () => {
  const days = syntheticDays();
  const cfg = defaultPhaseAConfig(DEFAULT_SELECTOR_PARAMS, DEFAULT_SPREAD_RISK_PARAMS, 10_000);

  it('produces a reproducible (seedless) result on identical input', () => {
    const a = replayPhaseABucket(days, 10_000, cfg);
    const b = replayPhaseABucket(days, 10_000, cfg);
    const strip = (r: PhaseABucketResult) => JSON.stringify({ closed: r.closed, greeks: r.greeksSeries, slip: r.modeledSlippageTotal });
    expect(strip(a)).toBe(strip(b));
  });

  it('emits a gate-report that validates against BacktestGateMetrics + PaperGateMetrics shapes', () => {
    const bucket = replayPhaseABucket(days, 10_000, cfg);
    const report = buildPhaseAGateReport(bucket, 'synthetic');
    expect(validateGateReportShape(report)).toEqual([]);
    // Synthetic backtest carries no forward paper data.
    expect(report.mode).toBe('synthetic');
    expect(report.paperAccrual.mode).toBe('synthetic');
    expect(report.paperAccrual.pooled.sharpe).toBeNull();
    expect(report.paperAccrual.pooled.tradeCount).toBe(0);
    // The pooled block is finite + well-formed even when no trade fires.
    expect(Number.isFinite(report.pooled.expectancy)).toBe(true);
    expect(report.pooled.maxDrawdown).toBeGreaterThanOrEqual(0);
  });
});
