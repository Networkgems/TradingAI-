// TRA-997 — production backtest executor tests.
//
// Drives the REAL executor (real BacktestRunner, real config mapping, real
// pooling) over a DETERMINISTIC synthetic 4H crypto series injected via the
// `candleLoader` seam — so the test needs no on-disk cache and no network, yet
// exercises the same code path production runs. Covers: a hand-authored
// hypothesis flowing through `runHypothesis` with the real executor (the issue's
// acceptance), input-purity (same config+window ⇒ same metrics), and that a
// config delta actually reaches the per-symbol `BacktestConfig`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { syntheticCryptoSeries, type BacktestConfig, type BacktestResult } from '@trading-app/backtest';
import {
  makeBacktestExecutor,
  buildBacktestConfig,
  poolGateMetrics,
  RV_CRYPTO_MAJORS_BASE_CONFIG,
  SLEEVE_SPECS,
} from './backtest-executor.js';
import {
  makeHypothesis,
  runHypothesis,
  applyHypothesis,
  DEFAULT_BACKTEST_WINDOW,
  setHypothesisQueueFileForTests,
  type BacktestWindow,
} from './hypothesis-pipeline.js';

// A deterministic 4H series (240-min bars) generated per symbol from a seed.
// Real prices ⇒ real trades ⇒ a real metrics row, with zero IO.
function syntheticLoader(window: BacktestWindow) {
  return (symbol: string) => {
    const seed = 100 + symbol.length + symbol.charCodeAt(0);
    // ~110 days of 4H bars per symbol — enough to warm the indicators and book
    // trades, small enough to keep the 6-symbol run fast.
    return syntheticCryptoSeries(110, symbol, 100 + (symbol.charCodeAt(0) % 50), 240, seed)
      .filter(c => c.timestamp >= window.startMs && c.timestamp <= window.endMs);
  };
}

// Real 6-symbol backtests are not instant; give the runner-backed tests headroom.
const RUN_TIMEOUT_MS = 30_000;

// Window that brackets the synthetic series (it starts at 2026-01-01).
const WINDOW: BacktestWindow = {
  symbols: DEFAULT_BACKTEST_WINDOW.symbols,
  startMs: Date.UTC(2025, 0, 1),
  endMs: Date.UTC(2027, 0, 1),
};

let tmpFile: string;
let seq = 0;
beforeEach(() => {
  seq += 1;
  tmpFile = join(tmpdir(), `hyp-exec-${process.pid}-${seq}.jsonl`);
  setHypothesisQueueFileForTests(tmpFile);
});
afterEach(async () => {
  setHypothesisQueueFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('config mapping (ConfigSnapshot → BacktestConfig)', () => {
  it('maps RV crypto-majors leaves onto the per-symbol BacktestConfig', () => {
    const sleeve = SLEEVE_SPECS[0];
    const cfg = buildBacktestConfig(sleeve, RV_CRYPTO_MAJORS_BASE_CONFIG, 'BTC-USD', WINDOW);
    expect(cfg.strategyType).toBe('mean_reversion');
    expect(cfg.symbol).toBe('BTC-USD');
    expect(cfg.startDate).toBe(WINDOW.startMs);
    expect(cfg.endDate).toBe(WINDOW.endMs);
    expect(cfg.meanReversionRiskPct).toBe(0.0075);
    expect(cfg.feeBps).toBe(60);
    expect(cfg.meanReversionOpts?.bbPeriod).toBe(20);
    expect(cfg.meanReversionOpts?.rsiOversold).toBe(25);
  });

  it('a single-leaf hypothesis delta reaches the built config', () => {
    const h = makeHypothesis({
      target: { kind: 'gate', path: 'RV_CRYPTO_MAJORS.bbMultiplier' },
      proposedDelta: { op: 'set', value: 2.5 },
      rationale: 'widen entry band',
      source: 'human',
      createdAt: 1_700_000_000_000,
    });
    const applied = applyHypothesis(RV_CRYPTO_MAJORS_BASE_CONFIG, h);
    const cfg = buildBacktestConfig(SLEEVE_SPECS[0], applied.config, 'ETH-USD', WINDOW);
    expect(cfg.meanReversionOpts?.bbMultiplier).toBe(2.5);
    // Base config untouched (apply works on an isolated clone).
    expect((RV_CRYPTO_MAJORS_BASE_CONFIG.RV_CRYPTO_MAJORS as Record<string, number>).bbMultiplier).toBe(2);
  });
});

describe('poolGateMetrics', () => {
  it('returns a zero row for an empty book', () => {
    expect(poolGateMetrics([], WINDOW)).toEqual({
      sharpe: 0,
      expectancy: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      tradeCount: 0,
    });
  });

  it('pools per-trade R into a finite, shaped metrics row', () => {
    const mk = (rs: number[]): BacktestResult =>
      ({ tradeRsNet: rs } as unknown as BacktestResult);
    const m = poolGateMetrics([mk([0.5, -0.3, 1.2]), mk([-0.5, 0.4])], WINDOW);
    expect(m.tradeCount).toBe(5);
    expect(Number.isFinite(m.expectancy)).toBe(true);
    expect(Number.isFinite(m.sharpe)).toBe(true);
    expect(m.profitFactor).toBeGreaterThan(0);
    expect(m.maxDrawdown).toBeGreaterThanOrEqual(0);
  });
});

describe('makeBacktestExecutor (real runner over synthetic candles)', () => {
  it('emits a real BacktestGateMetrics row', async () => {
    const exec = makeBacktestExecutor({ candleLoader: syntheticLoader(WINDOW) });
    const applied = applyHypothesis(RV_CRYPTO_MAJORS_BASE_CONFIG, baseHyp());
    const metrics = await exec(applied, WINDOW);
    expect(metrics).toMatchObject({
      sharpe: expect.any(Number),
      expectancy: expect.any(Number),
      profitFactor: expect.any(Number),
      maxDrawdown: expect.any(Number),
      tradeCount: expect.any(Number),
    });
    for (const k of ['sharpe', 'expectancy', 'profitFactor', 'maxDrawdown', 'tradeCount'] as const) {
      expect(Number.isFinite(metrics[k])).toBe(true);
    }
    expect(metrics.tradeCount).toBeGreaterThan(0);
  }, RUN_TIMEOUT_MS);

  it('is pure w.r.t. inputs — same config+window ⇒ identical metrics', async () => {
    const exec = makeBacktestExecutor({ candleLoader: syntheticLoader(WINDOW) });
    const applied = applyHypothesis(RV_CRYPTO_MAJORS_BASE_CONFIG, baseHyp());
    const a = await exec(applied, WINDOW);
    const b = await exec(applied, WINDOW);
    expect(a).toEqual(b);
  }, RUN_TIMEOUT_MS);

  it('runs each universe symbol through the runner with mapped configs', async () => {
    const seen: BacktestConfig[] = [];
    const spyRunner = {
      run: async (cfg: BacktestConfig): Promise<BacktestResult> => {
        seen.push(cfg);
        return { tradeRsNet: [0.2, -0.1] } as unknown as BacktestResult;
      },
    };
    const exec = makeBacktestExecutor({ candleLoader: syntheticLoader(WINDOW), runner: spyRunner });
    await exec(applyHypothesis(RV_CRYPTO_MAJORS_BASE_CONFIG, baseHyp()), WINDOW);
    expect(seen.length).toBe(SLEEVE_SPECS[0].universe.length);
    expect(seen.every(c => c.strategyType === 'mean_reversion')).toBe(true);
  });
});

describe('acceptance — hand-authored hypothesis through runHypothesis + real executor', () => {
  it('grades a real hypothesis end-to-end and persists the evidence row', async () => {
    const h = makeHypothesis({
      target: { kind: 'gate', path: 'RV_CRYPTO_MAJORS.rsiOversold' },
      proposedDelta: { op: 'set', value: 30 },
      rationale: 'reflect routine: RV majors entered too deep, loosen oversold gate',
      source: 'reflection',
      createdAt: 1_700_000_000_000,
    });
    const item = await runHypothesis(
      h,
      {
        baseConfig: RV_CRYPTO_MAJORS_BASE_CONFIG,
        runBacktest: makeBacktestExecutor({ candleLoader: syntheticLoader(WINDOW) }),
        window: WINDOW,
      },
      1_700_000_100_000,
    );
    // A real metrics row is attached and the item is graded (pass or fail — the
    // point is a real backtest ran and produced finite evidence).
    expect(item.metrics.tradeCount).toBeGreaterThan(0);
    expect(Number.isFinite(item.metrics.expectancy)).toBe(true);
    expect(['pending_ratification', 'gate_failed']).toContain(item.status);
    expect(item.baseline).toBe(25);
    expect(item.applied).toBe(30);
  }, RUN_TIMEOUT_MS);
});

function baseHyp() {
  return makeHypothesis({
    target: { kind: 'gate', path: 'RV_CRYPTO_MAJORS.rsiOversold' },
    proposedDelta: { op: 'set', value: 30 },
    rationale: 'baseline hypothesis for executor tests',
    source: 'reflection',
    createdAt: 1_700_000_000_000,
  });
}
