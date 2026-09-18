import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_PROMOTION_THRESHOLDS,
  compareToBacktestBasis,
  evaluatePaperGate,
  type BacktestGateMetrics,
  type PromotionDecision,
  type PromotionTradeSample,
} from '@trading-app/shared';
import {
  PROMOTION_DIVERGENCE_CODES,
  PROMOTION_DIVERGENCE_SHADOW_FLAG,
  evaluatePromotionDivergence,
  isPromotionDivergenceMonitorShadowEnabled,
  promotionDivergenceHealth,
  resetPromotionDivergenceCountersForTest,
  runPromotionDivergencePass,
  type PromotionDivergencePassDeps,
} from './promotion-divergence-monitor.js';

// TRA-4661 — standing backtest-vs-forward divergence monitor (shadow).

const DECIDED_AT = '2026-09-01T00:00:00.000Z';
const DECIDED_MS = Date.parse(DECIDED_AT);
const DAY = 86_400_000;

const BASIS: BacktestGateMetrics = { sharpe: 1.4, expectancy: 0.5, profitFactor: 1.8, maxDrawdown: 0.12, tradeCount: 240 };

function decision(overrides: Partial<PromotionDecision> = {}): PromotionDecision {
  return {
    id: 'dec-1',
    strategyId: 'strat_a',
    decidedAt: DECIDED_AT,
    reviewer: 'qt',
    backtestMetrics: BASIS,
    paperMetrics: null,
    ...overrides,
  };
}

/**
 * `n` closed trades, risk distance 1 × qty 1 ⇒ R == pnl. Alternating ±0.2
 * around `meanR` so the series has variance. `slipRatio` sets realized ÷
 * modeled on every trade; `null` leaves slippage uninstrumented.
 */
function trades(n: number, meanR: number, slipRatio: number | null = 1): PromotionTradeSample[] {
  return Array.from({ length: n }, (_, i) => ({
    pnl: meanR + (i % 2 === 0 ? 0.2 : -0.2),
    entryPrice: 10,
    stopLoss: 9,
    quantity: 1,
    openedAt: DECIDED_MS + i * DAY,
    closedAt: DECIDED_MS + i * DAY + 3_600_000,
    ...(slipRatio === null ? {} : { modeledSlippage: 0.02, realizedSlippage: 0.02 * slipRatio }),
  }));
}

const T = DEFAULT_PROMOTION_THRESHOLDS;

describe('TRA-4661 — extraction: the admission gate and the monitor share one comparison', () => {
  it('compareToBacktestBasis reproduces the Stage-2 floor and slippage cap at the ratified 0.5 / 1.5', () => {
    const cmp = compareToBacktestBasis({ expectancy: 0.2, slippageRatio: 1.6 }, BASIS, T);
    expect(cmp.expectancy).toEqual({ diverged: true, floor: 0.25, forward: 0.2, basis: 0.5 });
    expect(cmp.slippage).toEqual({ diverged: true, ratio: 1.6, cap: 1.5 });
    expect(compareToBacktestBasis({ expectancy: 0.25, slippageRatio: 1.5 }, BASIS, T)).toMatchObject({
      expectancy: { diverged: false },
      slippage: { diverged: false },
    });
  });

  it('a non-comparable arm is null, never a clean false', () => {
    expect(compareToBacktestBasis({ expectancy: 1, slippageRatio: null }, null, T)).toEqual({ expectancy: null, slippage: null });
    expect(compareToBacktestBasis({ expectancy: 1, slippageRatio: null }, { expectancy: 0 }, T).expectancy).toBeNull();
  });

  it('evaluatePaperGate still emits the exact overfit / slippage failure strings via the extracted function', () => {
    const paper = { tradeCount: 60, expectancy: 0.2, sharpe: 1.2, profitFactor: 1.5, slippageRatio: 1.6, slippageSampleSize: 60 };
    const ev = evaluatePaperGate(paper, BASIS, T);
    expect(ev.failedChecks).toContain('paper expectancy 0.2 < 0.5× backtest (0.25) — overfit signal');
    expect(ev.failedChecks).toContain('realized slippage 1.6× modeled > 1.5×');
  });

  it('the monitor module does not carry its own copy of either threshold', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'promotion-divergence-monitor.ts'), 'utf-8');
    expect(src).toContain('compareToBacktestBasis(');
    expect(src).not.toMatch(/\b0\.5\s*\*|\*\s*0\.5\b|<=\s*1\.5\b/);
  });
});

describe('TRA-4661 — verdict (positive + negative controls)', () => {
  it('POSITIVE CONTROL — constructed expectancy decay trips expectancy_divergence', () => {
    const v = evaluatePromotionDivergence({ strategyId: 'strat_a', decision: decision(), forward: trades(60, 0.1), thresholds: T });
    expect(v.reasonCodes).toEqual(['expectancy_divergence']);
    expect(v.arms.expectancy).toMatchObject({ state: 'diverged', basis: 0.5, floor: 0.25 });
    expect(v.arms.slippage.state).toBe('clean');
  });

  it('POSITIVE CONTROL — constructed slippage blow-out trips slippage_divergence while profitable', () => {
    const v = evaluatePromotionDivergence({ strategyId: 'strat_a', decision: decision(), forward: trades(60, 0.5, 2), thresholds: T });
    expect(v.reasonCodes).toEqual(['slippage_divergence']);
    expect(v.forward!.expectancy).toBeGreaterThan(0);
  });

  it('both arms diverged ⇒ both codes', () => {
    const v = evaluatePromotionDivergence({ strategyId: 'strat_a', decision: decision(), forward: trades(60, 0.1, 2), thresholds: T });
    expect(v.reasonCodes).toEqual(['expectancy_divergence', 'slippage_divergence']);
  });

  it('NEGATIVE CONTROL — a forward sample on-basis reads no_divergence and nothing else', () => {
    const v = evaluatePromotionDivergence({ strategyId: 'strat_a', decision: decision(), forward: trades(60, 0.5, 1), thresholds: T });
    expect(v.reasonCodes).toEqual(['no_divergence']);
  });

  it('THE TRAP — a tiny, terrible sample is insufficient_population, never a divergence and never no_divergence', () => {
    const v = evaluatePromotionDivergence({ strategyId: 'strat_a', decision: decision(), forward: trades(2, -3), thresholds: T });
    expect(v.reasonCodes).toEqual(['insufficient_population']);
    expect(v.minPopulation).toBe(T.paper.minTradeCount);
    expect(v.arms.expectancy.state).toBe('insufficient_population');
  });

  it('an empty forward sample is insufficient_population', () => {
    const v = evaluatePromotionDivergence({ strategyId: 'strat_a', decision: decision(), forward: [], thresholds: T });
    expect(v.reasonCodes).toEqual(['insufficient_population']);
  });

  it('clean expectancy with an UNGRADED slippage arm does not read no_divergence', () => {
    const v = evaluatePromotionDivergence({ strategyId: 'strat_a', decision: decision(), forward: trades(60, 0.5, null), thresholds: T });
    expect(v.reasonCodes).toEqual(['insufficient_population']);
    expect(v.arms.expectancy.state).toBe('clean');
    expect(v.arms.slippage.state).toBe('insufficient_population');
  });

  it('no sign-off, or a sign-off with no backtest snapshot, is no_admission_basis', () => {
    expect(evaluatePromotionDivergence({ strategyId: 's', decision: null, forward: trades(60, 0.1), thresholds: T }).reasonCodes)
      .toEqual(['no_admission_basis']);
    expect(
      evaluatePromotionDivergence({ strategyId: 's', decision: decision({ backtestMetrics: null }), forward: trades(60, 0.1), thresholds: T })
        .reasonCodes,
    ).toEqual(['no_admission_basis']);
  });

  it('honours a loosened effective threshold rather than the default', () => {
    const loose = { ...T, paper: { ...T.paper, minExpectancyVsBacktestRatio: 0.1 } };
    const v = evaluatePromotionDivergence({ strategyId: 'strat_a', decision: decision(), forward: trades(60, 0.1), thresholds: loose });
    expect(v.arms.expectancy.state).toBe('clean');
  });
});

describe('TRA-4661 — scheduled pass, counters, health', () => {
  beforeEach(() => resetPromotionDivergenceCountersForTest());

  function deps(forwardBy: Record<string, PromotionTradeSample[]>): PromotionDivergencePassDeps & { since: Record<string, number> } {
    const since: Record<string, number> = {};
    return {
      since,
      listRecords: async () => [
        { strategyId: 'diverging', decisions: [decision({ id: 'old', decidedAt: '2026-06-01T00:00:00.000Z' }), decision({ id: 'active' })] },
        { strategyId: 'clean', decisions: [decision()] },
        { strategyId: 'thin', decisions: [decision()] },
        { strategyId: 'never_promoted', decisions: [] },
      ],
      getThresholds: async () => T,
      collectForward: async (strategyId, sinceMs) => {
        since[strategyId] = sinceMs;
        return { samples: forwardBy[strategyId] ?? [], byMode: { demo: (forwardBy[strategyId] ?? []).length }, undated: 0 };
      },
    };
  }

  it('grades only signed-off strategies, from the ACTIVE sign-off, and publishes every code densely', async () => {
    const d = deps({ diverging: trades(60, 0.1), clean: trades(60, 0.5), thin: trades(3, 0.5) });
    const { rows, changed } = await runPromotionDivergencePass(d);
    expect(rows.map((r) => [r.strategyId, r.reasonCodes])).toEqual([
      ['diverging', ['expectancy_divergence']],
      ['clean', ['no_divergence']],
      ['thin', ['insufficient_population']],
    ]);
    expect(changed).toHaveLength(3);
    expect(rows[0]!.decisionId).toBe('active');
    expect(d.since['diverging']).toBe(DECIDED_MS);
    expect(d.since['never_promoted']).toBeUndefined();

    const h = promotionDivergenceHealth({ [PROMOTION_DIVERGENCE_SHADOW_FLAG]: '1' });
    expect(h.byCode.map((r) => r.code)).toEqual([...PROMOTION_DIVERGENCE_CODES]);
    const count = (c: string) => h.byCode.find((r) => r.code === c)!.count;
    expect(count('insufficient_population')).toBe(1);
    expect(count('no_divergence')).toBe(1);
    expect(count('expectancy_divergence')).toBe(1);
    expect(h.passes).toBe(1);

    // A second identical pass accumulates tallies but reports no transitions.
    const again = await runPromotionDivergencePass(d);
    expect(again.changed).toHaveLength(0);
    expect(count('no_divergence')).toBe(1); // h is a snapshot
    expect(promotionDivergenceHealth().byCode.find((r) => r.code === 'no_divergence')!.count).toBe(2);
  });

  it('a failed pass is counted and surfaced, not swallowed as a quiet zero', async () => {
    await expect(
      runPromotionDivergencePass({
        listRecords: async () => { throw new Error('store unreadable'); },
        getThresholds: async () => T,
        collectForward: async () => ({ samples: [], byMode: {}, undated: 0 }),
      }),
    ).rejects.toThrow('store unreadable');
    const h = promotionDivergenceHealth();
    expect(h.failedPasses).toBe(1);
    expect(h.passes).toBe(0);
    expect(h.lastPassError).toBe('store unreadable');
  });

  it('flag is standalone and default OFF; the DARK note says it is not a clean bill', () => {
    expect(isPromotionDivergenceMonitorShadowEnabled({})).toBe(false);
    expect(isPromotionDivergenceMonitorShadowEnabled({ [PROMOTION_DIVERGENCE_SHADOW_FLAG]: 'on' })).toBe(true);
    const h = promotionDivergenceHealth({});
    expect(h.enabled).toBe(false);
    expect(h.shadowOnly).toBe(true);
    expect(h.note).toMatch(/^DARK/);
    expect(h.note).toContain('not a clean bill');
  });
});
