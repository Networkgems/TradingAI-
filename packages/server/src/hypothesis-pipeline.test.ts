// TRA-994 — hypothesis → backtest → gated-promotion pipeline tests.
//
// Drives the whole pipe deterministically with an INJECTED backtest executor:
// queued → backtested → G0-graded → ratification item → (accept) demo override
// behind a flag. Also pins the invariants: a failing hypothesis is recorded but
// can never be ratified, and ratification lands in DEMO only (no live path).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import type { BacktestGateMetrics } from '@trading-app/shared';
import {
  makeHypothesis,
  hypothesisId,
  resolveDelta,
  applyHypothesis,
  gradeG0,
  G0_THRESHOLDS,
  runHypothesis,
  listRatificationQueue,
  listPromotionItems,
  ratifyHypothesis,
  demoFlagFor,
  listDemoOverrides,
  setHypothesisQueueFileForTests,
  DEFAULT_BACKTEST_WINDOW,
  type ConfigSnapshot,
  type Hypothesis,
  type BacktestExecutor,
} from './hypothesis-pipeline.js';

// A small config snapshot standing in for the real strategy config tree.
// Narrow view of the test config tree, used to read nested numbers in assertions
// without resorting to `any` (which trips eslint's no-explicit-any under the
// render-build `--max-warnings 0` lint gate).
type TestConfigShape = {
  RV_GATE: { minTrendConfluence: number };
  sleeves: { options: { managedRatio: number } };
};

function baseConfig(): ConfigSnapshot {
  return {
    CONVICTION_DCA: { optionMinAddDelta: 0.35, maxAdds: 2 },
    RV_GATE: { minTrendConfluence: 0.55 },
    sleeves: { options: { managedRatio: 0.5 } },
  };
}

// A passing metric set (clears every G0 threshold) and a failing one.
const PASS_METRICS: BacktestGateMetrics = {
  sharpe: 1.4,
  expectancy: 0.22,
  profitFactor: 1.6,
  maxDrawdown: 0.12,
  tradeCount: 180,
};
const FAIL_METRICS: BacktestGateMetrics = {
  sharpe: 0.4,
  expectancy: -0.05,
  profitFactor: 0.9,
  maxDrawdown: 0.31,
  tradeCount: 40,
};

/** Executor that returns a fixed metric set, ignoring the config (deterministic). */
function fixedExecutor(m: BacktestGateMetrics): BacktestExecutor {
  return async () => m;
}

function hyp(over: Partial<Parameters<typeof makeHypothesis>[0]> = {}): Hypothesis {
  return makeHypothesis({
    target: { kind: 'gate', path: 'RV_GATE.minTrendConfluence' },
    proposedDelta: { op: 'set', value: 0.6 },
    rationale: 'reflect routine flagged weak trend confluence on RV fallbacks',
    source: 'reflection',
    createdAt: 1_700_000_000_000,
    ...over,
  });
}

let tmpFile: string;
let seq = 0;
beforeEach(() => {
  seq += 1;
  tmpFile = join(tmpdir(), `hyp-queue-${process.pid}-${seq}.jsonl`);
  setHypothesisQueueFileForTests(tmpFile);
});
afterEach(async () => {
  setHypothesisQueueFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('hypothesis schema + stable id', () => {
  it('derives a stable id from target+delta+source, ignoring rationale/timestamp', () => {
    const a = hypothesisId({
      target: { kind: 'gate', path: 'RV_GATE.minTrendConfluence' },
      proposedDelta: { op: 'set', value: 0.6 },
      source: 'reflection',
    });
    const b = hypothesisId({
      target: { kind: 'gate', path: 'RV_GATE.minTrendConfluence' },
      proposedDelta: { op: 'set', value: 0.6 },
      source: 'reflection',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^hyp-[0-9a-f]{8}$/);

    // A different delta ⇒ a different id.
    const c = hypothesisId({
      target: { kind: 'gate', path: 'RV_GATE.minTrendConfluence' },
      proposedDelta: { op: 'set', value: 0.7 },
      source: 'reflection',
    });
    expect(c).not.toBe(a);
  });

  it('makeHypothesis stamps the content-derived id', () => {
    const h = hyp();
    expect(h.id).toBe(
      hypothesisId({ target: h.target, proposedDelta: h.proposedDelta, source: h.source }),
    );
  });
});

describe('param-delta application', () => {
  it('resolves set/add/mul against the baseline', () => {
    expect(resolveDelta(0.5, { op: 'set', value: 0.6 })).toBe(0.6);
    expect(resolveDelta(0.5, { op: 'add', value: 0.1 })).toBeCloseTo(0.6, 10);
    expect(resolveDelta(0.5, { op: 'mul', value: 2 })).toBe(1);
  });

  it('applies into an ISOLATED clone, leaving the base config untouched', () => {
    const base = baseConfig();
    const h = hyp({ proposedDelta: { op: 'add', value: 0.05 } });
    const applied = applyHypothesis(base, h);

    expect(applied.baseline).toBe(0.55);
    expect(applied.applied).toBeCloseTo(0.6, 10);
    expect((applied.config as unknown as TestConfigShape).RV_GATE.minTrendConfluence).toBeCloseTo(0.6, 10);
    // Base is pristine.
    expect((base as unknown as TestConfigShape).RV_GATE.minTrendConfluence).toBe(0.55);
  });

  it('reaches nested paths', () => {
    const h = hyp({
      target: { kind: 'sleeve', path: 'sleeves.options.managedRatio' },
      proposedDelta: { op: 'set', value: 0.4 },
    });
    const applied = applyHypothesis(baseConfig(), h);
    expect(applied.baseline).toBe(0.5);
    expect((applied.config as unknown as TestConfigShape).sleeves.options.managedRatio).toBe(0.4);
  });

  it('throws loudly on a target path that is not a finite number', () => {
    const h = hyp({ target: { kind: 'gate', path: 'RV_GATE.doesNotExist' } });
    expect(() => applyHypothesis(baseConfig(), h)).toThrow(/does not resolve to a finite number/);
  });
});

describe('G0 gate grader', () => {
  it('passes a strategy that clears every threshold', () => {
    const g = gradeG0(PASS_METRICS);
    expect(g.pass).toBe(true);
    expect(g.failedChecks).toEqual([]);
  });

  it('fails and names every breached threshold', () => {
    const g = gradeG0(FAIL_METRICS);
    expect(g.pass).toBe(false);
    expect(g.failedChecks.length).toBe(5); // expectancy, sharpe, PF, DD, tradeCount
    expect(g.failedChecks.join(' ')).toMatch(/expectancy/);
    expect(g.failedChecks.join(' ')).toMatch(/maxDrawdown/);
  });

  it('treats flat zero expectancy as a fail (strict > 0)', () => {
    const g = gradeG0({ ...PASS_METRICS, expectancy: G0_THRESHOLDS.minExpectancy });
    expect(g.pass).toBe(false);
    expect(g.failedChecks.join(' ')).toMatch(/expectancy/);
  });

  it('ranks higher expectancy above lower, Sharpe as tiebreak', () => {
    const lowE = gradeG0({ ...PASS_METRICS, expectancy: 0.2, sharpe: 2.0 });
    const highE = gradeG0({ ...PASS_METRICS, expectancy: 0.3, sharpe: 1.0 });
    expect(highE.score).toBeGreaterThan(lowE.score); // expectancy dominates

    const tieA = gradeG0({ ...PASS_METRICS, expectancy: 0.25, sharpe: 1.0 });
    const tieB = gradeG0({ ...PASS_METRICS, expectancy: 0.25, sharpe: 1.5 });
    expect(tieB.score).toBeGreaterThan(tieA.score); // Sharpe breaks the tie
  });
});

describe('end-to-end pipeline', () => {
  it('flows a passing hypothesis: queued → backtested → graded → ratification item → demo override', async () => {
    const h = hyp();
    const item = await runHypothesis(h, {
      baseConfig: baseConfig(),
      runBacktest: fixedExecutor(PASS_METRICS),
    }, 1_700_000_100_000);

    expect(item.status).toBe('pending_ratification');
    expect(item.grade.pass).toBe(true);
    expect(item.baseline).toBe(0.55);
    expect(item.applied).toBe(0.6);
    expect(item.metrics).toEqual(PASS_METRICS);

    // It appears in the ratification queue.
    const queue = await listRatificationQueue();
    expect(queue.map(i => i.hypothesis.id)).toContain(h.id);

    // Board accepts → lands in DEMO config behind an OFF-by-default flag.
    const { item: decided, override } = await ratifyHypothesis({
      hypothesisId: h.id,
      decision: 'accept',
      decidedBy: 'board',
      decidedAt: 1_700_000_200_000,
    });
    expect(decided.status).toBe('ratified');
    expect(override).toBeDefined();
    expect(override!.mode).toBe('demo');
    expect(override!.flag).toBe(demoFlagFor(h));
    expect(override!.applied).toBe(0.6);

    // No longer pending.
    expect((await listRatificationQueue()).map(i => i.hypothesis.id)).not.toContain(h.id);

    // Staged but INERT until the flag is flipped in the environment.
    const offEnv = await listDemoOverrides({} as NodeJS.ProcessEnv);
    expect(offEnv.ratified.map(o => o.hypothesisId)).toContain(h.id);
    expect(offEnv.active).toEqual([]);

    const onEnv = await listDemoOverrides({ [override!.flag]: '1' } as NodeJS.ProcessEnv);
    expect(onEnv.active.map(o => o.hypothesisId)).toContain(h.id);
  });

  it('records a failing hypothesis but refuses to ratify it (invariant 2)', async () => {
    const h = hyp({ proposedDelta: { op: 'set', value: 0.99 } });
    const item = await runHypothesis(h, {
      baseConfig: baseConfig(),
      runBacktest: fixedExecutor(FAIL_METRICS),
    }, 1_700_000_100_000);

    expect(item.status).toBe('gate_failed');
    // Never enters the ratification queue.
    expect((await listRatificationQueue()).map(i => i.hypothesis.id)).not.toContain(h.id);
    // But it IS recorded for the audit trail.
    expect((await listPromotionItems()).map(i => i.hypothesis.id)).toContain(h.id);

    await expect(
      ratifyHypothesis({
        hypothesisId: h.id,
        decision: 'accept',
        decidedBy: 'board',
        decidedAt: 1_700_000_200_000,
      }),
    ).rejects.toThrow(/not pending_ratification/);
  });

  it('is idempotent per hypothesis id across re-runs', async () => {
    const h = hyp();
    const deps = { baseConfig: baseConfig(), runBacktest: fixedExecutor(PASS_METRICS) };
    const first = await runHypothesis(h, deps, 1_700_000_100_000);
    const second = await runHypothesis(h, deps, 1_700_000_300_000);
    expect(second.queuedAt).toBe(first.queuedAt); // unchanged, not re-queued
    expect((await listPromotionItems()).filter(i => i.hypothesis.id === h.id).length).toBe(1);
  });

  it('ranks the ratification queue by expectancy/Sharpe', async () => {
    const hLow = hyp({ proposedDelta: { op: 'set', value: 0.6 } });
    const hHigh = hyp({ proposedDelta: { op: 'set', value: 0.7 } });
    await runHypothesis(hLow, {
      baseConfig: baseConfig(),
      runBacktest: fixedExecutor({ ...PASS_METRICS, expectancy: 0.15 }),
    }, 1_700_000_100_000);
    await runHypothesis(hHigh, {
      baseConfig: baseConfig(),
      runBacktest: fixedExecutor({ ...PASS_METRICS, expectancy: 0.4 }),
    }, 1_700_000_110_000);

    const queue = await listRatificationQueue();
    expect(queue[0].hypothesis.id).toBe(hHigh.id); // higher expectancy ranks first
  });

  it('rejection closes the item without minting an override', async () => {
    const h = hyp();
    await runHypothesis(h, {
      baseConfig: baseConfig(),
      runBacktest: fixedExecutor(PASS_METRICS),
    }, 1_700_000_100_000);

    const { item, override } = await ratifyHypothesis({
      hypothesisId: h.id,
      decision: 'reject',
      decidedBy: 'cto',
      decidedAt: 1_700_000_200_000,
    });
    expect(item.status).toBe('rejected');
    expect(override).toBeUndefined();
    expect((await listDemoOverrides({} as NodeJS.ProcessEnv)).ratified).toEqual([]);
  });

  it('persists across a cache reload (file-backed queue)', async () => {
    const h = hyp();
    await runHypothesis(h, {
      baseConfig: baseConfig(),
      runBacktest: fixedExecutor(PASS_METRICS),
    }, 1_700_000_100_000);
    await ratifyHypothesis({
      hypothesisId: h.id,
      decision: 'accept',
      decidedBy: 'board',
      decidedAt: 1_700_000_200_000,
    });

    // Drop the in-memory cache; the next read folds the JSONL back.
    setHypothesisQueueFileForTests(tmpFile);
    const reloaded = await listDemoOverrides({} as NodeJS.ProcessEnv);
    expect(reloaded.ratified.map(o => o.hypothesisId)).toContain(h.id);
  });
});

describe('defaults', () => {
  it('exposes a standard crypto-majors backtest window', () => {
    expect(DEFAULT_BACKTEST_WINDOW.symbols).toContain('BTC-USD');
    expect(DEFAULT_BACKTEST_WINDOW.startMs).toBeLessThan(DEFAULT_BACKTEST_WINDOW.endMs);
  });
});
