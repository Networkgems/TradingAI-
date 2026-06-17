import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import {
  __resetPromotionStoreForTests,
  deriveBacktestGateMetrics,
  registerBacktestReport,
  registerOptimizationVerdict,
  recordSignoff,
  hasSignoff,
  getEffectiveThresholds,
  mergeThresholds,
  getStrategyRecord,
  recordPaperAccrual,
  settlePaperAccrual,
  getPaperAccruals,
  getStrategyPaperMetrics,
  PromotionValidationError,
} from './promotion-store.js';
import { DEFAULT_PROMOTION_THRESHOLDS, evaluateBacktestGate } from '@trading-app/shared';
import type { BacktestResult, OptimizationReport, OptimizationVerdict } from '@trading-app/backtest';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'promo-store-'));
  __resetPromotionStoreForTests(join(dir, 'promotion-gate.json'));
});

afterEach(() => {
  __resetPromotionStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

// Minimal BacktestResult-shaped object; only the picked fields matter here.
function report(over: Partial<BacktestResult> = {}): BacktestResult {
  return {
    sharpeRatio: 1.3,
    expectancy: 0.2,
    profitFactor: 1.6,
    maxDrawdown: 0.12,
    totalTrades: 130,
    ...over,
  } as BacktestResult;
}

describe('deriveBacktestGateMetrics — picks metrics off a computed report', () => {
  it('maps report fields to gate metrics', () => {
    const m = deriveBacktestGateMetrics(report());
    expect(m).toEqual({ sharpe: 1.3, expectancy: 0.2, profitFactor: 1.6, maxDrawdown: 0.12, tradeCount: 130 });
  });

  it('rejects a report missing a numeric field (anti hand-entry)', () => {
    expect(() => deriveBacktestGateMetrics(report({ sharpeRatio: undefined as unknown as number }))).toThrow(
      PromotionValidationError,
    );
  });
});

describe('registerBacktestReport + persistence', () => {
  it('persists derived metrics and survives a cache reset (round-trips from disk)', async () => {
    await registerBacktestReport({ strategyId: 'bb_fade', report: report(), reportId: 'TRA-405', registeredBy: 'qt' });
    __resetPromotionStoreForTests(join(dir, 'promotion-gate.json'));
    const rec = await getStrategyRecord('bb_fade');
    expect(rec?.backtest?.metrics.sharpe).toBe(1.3);
    expect(rec?.backtest?.reportId).toBe('TRA-405');
    expect(rec?.backtest?.registeredBy).toBe('qt');
  });
});

describe('registerOptimizationVerdict — TRA-541 Stage-1 from a TRA-540 verdict', () => {
  // The validated TRA-540 reversal report: verdict.pass === false (the OOS
  // guard battery is red) yet its headline Sharpe (1.247) is "strong". This is
  // the exact gaming case the gate must refuse.
  function loadReport(name: string): OptimizationReport {
    const here = dirname(fileURLToPath(import.meta.url));
    const p = join(here, '..', '..', 'backtest', 'reports', name);
    return JSON.parse(readFileSync(p, 'utf-8')) as OptimizationReport;
  }

  it('ingests verdict.backtestMetrics 1:1 and stores the pass flag + blessed params', async () => {
    const report = loadReport('tra540-reversal-BTC-USD.json');
    const rec = await registerOptimizationVerdict({
      strategyId: 'reversal',
      verdict: report.verdict,
      reportId: 'tra540-reversal-BTC-USD',
      registeredBy: 'qt',
    });
    // 1:1 mapping, no renaming.
    expect(rec.backtest?.metrics.sharpe).toBe(report.verdict.backtestMetrics.sharpe);
    expect(rec.backtest?.metrics.tradeCount).toBe(report.verdict.backtestMetrics.tradeCount);
    expect(rec.backtest?.verdict?.pass).toBe(report.verdict.pass);
    expect(rec.backtest?.blessedParams).toEqual(report.verdict.blessedParams);

    __resetPromotionStoreForTests(join(dir, 'promotion-gate.json'));
    const reloaded = await getStrategyRecord('reversal');
    expect(reloaded?.backtest?.verdict?.pass).toBe(false);
    expect(reloaded?.backtest?.blessedParams).toBeTruthy();
  });

  it('a verdict.pass=false report with strong metrics FAILS the Stage-1 leg', async () => {
    const report = loadReport('tra540-reversal-BTC-USD.json');
    expect(report.verdict.pass).toBe(false);
    expect(report.verdict.backtestMetrics.sharpe).toBeGreaterThan(1.0); // headline looks strong
    await registerOptimizationVerdict({
      strategyId: 'reversal',
      verdict: report.verdict,
      reportId: 'tra540-reversal-BTC-USD',
      registeredBy: 'qt',
    });
    const rec = await getStrategyRecord('reversal');
    const stage1 = evaluateBacktestGate(rec!.backtest!.metrics, DEFAULT_PROMOTION_THRESHOLDS, rec!.backtest!.verdict);
    expect(stage1.state).toBe('fail');
    expect(stage1.failedChecks.join(' ')).toMatch(/verdict FAIL/);
  });

  it('a verdict.pass=true report PASSES the Stage-1 leg', async () => {
    // Synthesize a pass=true verdict (the curated real reports both legitimately
    // FAIL; here we exercise the green path).
    const verdict: OptimizationVerdict = {
      pass: true,
      guards: { G1: { pass: true, value: 0.8 }, G2: { pass: true, value: 0.97 }, G3: { pass: true, value: 0.2 },
        G4: { pass: true, value: 500 }, G5: { pass: true, value: 0.9 }, G6: { pass: true, value: 0.3 } },
      blessedParams: { strategy: 'reversal', label: 'rsiOverbought=70,lookback=5' },
      backtestMetrics: { sharpe: 1.4, expectancy: 0.25, profitFactor: 1.7, maxDrawdown: 0.1, tradeCount: 120 },
    };
    await registerOptimizationVerdict({ strategyId: 'reversal', verdict, reportId: 'synthetic-pass', registeredBy: 'qt' });
    const rec = await getStrategyRecord('reversal');
    const stage1 = evaluateBacktestGate(rec!.backtest!.metrics, DEFAULT_PROMOTION_THRESHOLDS, rec!.backtest!.verdict);
    expect(stage1.state).toBe('pass');
  });

  it('rejects a verdict missing the pass flag (anti hand-entry)', async () => {
    await expect(
      registerOptimizationVerdict({
        strategyId: 'reversal',
        verdict: { backtestMetrics: { sharpe: 1 } } as unknown as OptimizationVerdict,
        reportId: 'bad',
        registeredBy: 'qt',
      }),
    ).rejects.toThrow(PromotionValidationError);
  });
});

describe('recordSignoff — Stage 3 audit', () => {
  it('appends a decision and marks the strategy signed off', async () => {
    expect(await hasSignoff('bb_fade')).toBe(false);
    const d = await recordSignoff({
      strategyId: 'bb_fade',
      reviewer: 'QuantTrader',
      backtestMetrics: deriveBacktestGateMetrics(report()),
      paperMetrics: null,
    });
    expect(d.reviewer).toBe('QuantTrader');
    expect(d.id).toBeTruthy();
    expect(await hasSignoff('bb_fade')).toBe(true);
  });

  it('requires a rationale when threshold overrides are applied (loosen-only audit)', async () => {
    await expect(
      recordSignoff({
        strategyId: 'bb_fade',
        reviewer: 'QuantTrader',
        backtestMetrics: null,
        paperMetrics: null,
        thresholdOverrides: { paper: { ...DEFAULT_PROMOTION_THRESHOLDS.paper, minTradeCount: 30 } },
      }),
    ).rejects.toThrow(/rationale is required/);
  });

  it('records overrides with a rationale and applies them to effective thresholds', async () => {
    await recordSignoff({
      strategyId: 'bb_fade',
      reviewer: 'QuantTrader',
      backtestMetrics: null,
      paperMetrics: null,
      thresholdOverrides: { paper: { ...DEFAULT_PROMOTION_THRESHOLDS.paper, minTradeCount: 30 } },
      rationale: 'Lower paper count: liquid majors, faster fill cadence — QT 2026-06.',
    });
    const eff = await getEffectiveThresholds('bb_fade');
    expect(eff.paper.minTradeCount).toBe(30);
    // untouched thresholds keep the v1 default
    expect(eff.backtest.minSharpe).toBe(1.0);
  });
});

describe('mergeThresholds', () => {
  it('returns base unchanged when no override', () => {
    expect(mergeThresholds(DEFAULT_PROMOTION_THRESHOLDS)).toEqual(DEFAULT_PROMOTION_THRESHOLDS);
  });
  it('deep-merges per-stage overrides', () => {
    const merged = mergeThresholds(DEFAULT_PROMOTION_THRESHOLDS, {
      backtest: { ...DEFAULT_PROMOTION_THRESHOLDS.backtest, minSharpe: 1.5 },
    });
    expect(merged.backtest.minSharpe).toBe(1.5);
    expect(merged.paper.minTradeCount).toBe(50);
  });
});

// TRA-913 (TRA-908 Phase C) — options paper-accrual ledger.
describe('paper accruals — Phase C options bridge Stage-2 source', () => {
  const SID = 'option:bull_put_spread';

  it('records an open accrual (no pnl) and surfaces it without minting metrics', async () => {
    await recordPaperAccrual({ strategyId: SID, id: 'pos-1', openedAtMs: 1_000, entryRiskUsd: 320, note: 'bps' });
    const accruals = await getPaperAccruals(SID);
    expect(accruals).toHaveLength(1);
    expect(accruals[0]!.pnl).toBeUndefined();
    // Open accrual → no realized trade → Stage-2 metrics are null (missing).
    expect(await getStrategyPaperMetrics(SID)).toBeNull();
    // Recording also registers the strategy so it surfaces on the overview.
    expect(await getStrategyRecord(SID)).toBeDefined();
  });

  it('settles an accrual with realized P&L and computes Stage-2 metrics (R = pnl / entryRisk)', async () => {
    await recordPaperAccrual({ strategyId: SID, id: 'p1', openedAtMs: 0, entryRiskUsd: 100 });
    await recordPaperAccrual({ strategyId: SID, id: 'p2', openedAtMs: 0, entryRiskUsd: 100 });
    const oneYear = 365.25 * 24 * 60 * 60 * 1_000;
    await settlePaperAccrual({ strategyId: SID, id: 'p1', pnl: 50, closedAtMs: oneYear * 0.5 });
    await settlePaperAccrual({ strategyId: SID, id: 'p2', pnl: -30, closedAtMs: oneYear });

    const m = await getStrategyPaperMetrics(SID);
    expect(m).not.toBeNull();
    expect(m!.tradeCount).toBe(2);
    // R: +50/100 = +0.5 and −30/100 = −0.3 → expectancy = +0.1.
    expect(m!.expectancy).toBeCloseTo(0.1, 6);
    expect(m!.profitFactor).toBeCloseTo(50 / 30, 6);
  });

  it('is idempotent on re-recording the same opened position (no double count)', async () => {
    await recordPaperAccrual({ strategyId: SID, id: 'p1', openedAtMs: 0, entryRiskUsd: 100 });
    await settlePaperAccrual({ strategyId: SID, id: 'p1', pnl: 25, closedAtMs: 10 });
    // A retry of the open record must NOT wipe the realized settlement.
    await recordPaperAccrual({ strategyId: SID, id: 'p1', openedAtMs: 0, entryRiskUsd: 100 });
    const accruals = await getPaperAccruals(SID);
    expect(accruals).toHaveLength(1);
    expect(accruals[0]!.pnl).toBe(25);
  });

  it('returns null settling an unknown accrual and rejects bad inputs', async () => {
    expect(await settlePaperAccrual({ strategyId: SID, id: 'nope', pnl: 1, closedAtMs: 1 })).toBeNull();
    await expect(
      recordPaperAccrual({ strategyId: SID, id: 'x', openedAtMs: 0, entryRiskUsd: 0 }),
    ).rejects.toThrow(PromotionValidationError);
  });
});
