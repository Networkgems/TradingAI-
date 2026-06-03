import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import {
  __resetPromotionStoreForTests,
  deriveBacktestGateMetrics,
  registerBacktestReport,
  recordSignoff,
  hasSignoff,
  getEffectiveThresholds,
  mergeThresholds,
  getStrategyRecord,
  PromotionValidationError,
} from './promotion-store.js';
import { DEFAULT_PROMOTION_THRESHOLDS } from '@trading-app/shared';
import type { BacktestResult } from '@trading-app/backtest';

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
