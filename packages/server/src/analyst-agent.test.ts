import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Candle, MarketReviewGates } from '@trading-app/shared';
import type { BacktestGateMetrics } from '@trading-app/shared';
import type { BacktestExecutor, ConfigSnapshot } from './hypothesis-pipeline.js';
import {
  listPromotionItems,
  setHypothesisQueueFileForTests,
} from './hypothesis-pipeline.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import {
  isAnalystAgentEnabled,
  buildPremarketPlan,
  buildReflection,
  deriveHypotheses,
  buildPostmarketReview,
  runPostmarketReview,
  persistAnalystPlan,
  readAnalystPlan,
  buildAnalystHealth,
  setAnalystDataDirForTests,
  analystEtDate,
  scoreSymbol,
  type AnalystPlan,
  type AnalystReflection,
  type AnalystTunable,
} from './analyst-agent.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GATES: MarketReviewGates = {
  orbLongs: true,
  orbShorts: false,
  meanReversionTilt: false,
  breakoutsEnabled: true,
  sizingMultiplier: 1,
  trendState: 'up',
};

let ts = 1_700_000_000_000;
function candle(o: number, h: number, l: number, c: number): Candle {
  ts += 86_400_000;
  return { symbol: 'X', timestamp: ts, open: o, high: h, low: l, close: c, volume: 1000 };
}

/**
 * Double-bottom series that twice tests a ~100 support zone (wide legs so the
 * fractal finder registers strict pivots) and closes just above the level — a
 * high-proximity reversal candidate.
 */
function nearLevelSeries(): Candle[] {
  const closes = [
    112, 110, 108, 106, 104, 102, 100, 102, 104, 106, 108, 106, 104, 102, 100.3, 101, 100.6,
  ];
  let prev = closes[0];
  const out: Candle[] = [];
  for (const c of closes) {
    out.push(candle(prev, c + 0.6, c - 0.6, c));
    prev = c;
  }
  return out;
}

/** Flat, featureless series far from any level. */
function flatSeries(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 18; i++) out.push(candle(200, 200.5, 199.5, 200));
  return out;
}

const PASS_METRICS: BacktestGateMetrics = {
  sharpe: 1.4,
  expectancy: 0.22,
  profitFactor: 1.6,
  maxDrawdown: 0.12,
  tradeCount: 180,
};
function fixedExecutor(m: BacktestGateMetrics = PASS_METRICS): BacktestExecutor {
  return async () => m;
}

const BASE_CONFIG: ConfigSnapshot = {
  RV: { riskPerTradePct: 0.01, rsiOversold: 25, atrStopMultiplier: 1.5 },
};

const TUNABLES: AnalystTunable[] = [
  { key: 'weak_setup', kind: 'gate', path: 'RV.rsiOversold', tighten: { op: 'mul', value: 0.9 }, nudge: { op: 'mul', value: 1.1 } },
  { key: 'strong_setup', kind: 'sleeve', path: 'RV.riskPerTradePct', tighten: { op: 'mul', value: 0.9 }, nudge: { op: 'mul', value: 1.1 } },
];

/** Build N closed demo journal rows for a structure with a given win count. */
function rows(structure: string, n: number, wins: number, r = 1): OptionTradeJournalRecord[] {
  const out: OptionTradeJournalRecord[] = [];
  for (let i = 0; i < n; i++) {
    const win = i < wins;
    out.push({
      id: `${structure}-${i}`,
      openTs: 1,
      closeTs: 2,
      symbol: 'AMD',
      structure,
      mode: 'demo',
      ivRank: 40,
      trend: 'up',
      sentiment: 0,
      entryDelta: 0.5,
      entryDte: 30,
      atRiskUsd: 100,
      outcome: win ? 'WIN' : 'LOSS',
      realizedPnlUsd: win ? r * 100 : -100,
      realizedR: win ? r : -1,
      exitReason: win ? 'tp1' : 'stop',
      holdDays: 1,
    });
  }
  return out;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'analyst-'));
  setAnalystDataDirForTests(tmp);
  setHypothesisQueueFileForTests(join(tmp, 'queue.jsonl'));
});
afterEach(() => {
  setAnalystDataDirForTests(null);
  setHypothesisQueueFileForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});

// ── Flag ─────────────────────────────────────────────────────────────────────

describe('isAnalystAgentEnabled', () => {
  it('defaults OFF and honours truthy strings', () => {
    expect(isAnalystAgentEnabled({})).toBe(false);
    expect(isAnalystAgentEnabled({ ENABLE_ANALYST_AGENT: 'false' })).toBe(false);
    expect(isAnalystAgentEnabled({ ENABLE_ANALYST_AGENT: '1' })).toBe(true);
    expect(isAnalystAgentEnabled({ ENABLE_ANALYST_AGENT: 'on' })).toBe(true);
  });
});

// ── Pre-market ranking ───────────────────────────────────────────────────────

describe('ranking', () => {
  it('ranks an at-the-level reversal candidate above a flat, far-from-level symbol', () => {
    const { plan, block } = buildPremarketPlan({
      date: '2026-06-22',
      now: 1,
      regime: 'green',
      regimeRationale: 'trend up',
      gates: GATES,
      gapRisk: false,
      symbols: [
        { symbol: 'flat', candles: flatSeries() },
        { symbol: 'amd', candles: nearLevelSeries() },
      ],
    });
    expect(plan.watchlist[0].symbol).toBe('AMD');
    expect(plan.watchlist[0].rank).toBeGreaterThan(plan.watchlist[1].rank);
    // The published block leads with the top-ranked symbol.
    expect(block.leaders[0]).toBe('AMD');
    expect(block.regimeLabel).toBe('green');
  });

  it('caps the watchlist at MAX_PLAN_SYMBOLS', () => {
    const symbols = Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}`, candles: flatSeries() }));
    const { plan } = buildPremarketPlan({
      date: '2026-06-22', now: 1, regime: 'green', regimeRationale: '', gates: GATES, gapRisk: false, symbols,
    });
    expect(plan.watchlist.length).toBe(15);
  });

  it('inverts trend-align in a red regime (downtrend scores higher)', () => {
    const up = scoreSymbol(nearLevelSeries(), 'red', 'up').trendAlignScore;
    // A clean downtrend series.
    let p = 120;
    const down: Candle[] = [];
    for (let i = 0; i < 25; i++) { p -= 1; down.push(candle(p + 1, p + 1.5, p - 0.5, p)); }
    const dn = scoreSymbol(down, 'red', 'up').trendAlignScore;
    expect(dn).toBeGreaterThan(up);
  });
});

// ── Reflection aggregation ───────────────────────────────────────────────────

describe('buildReflection', () => {
  it('aggregates per-setup win-rate + expectancy over closed demo rows only', () => {
    const journal = [
      ...rows('orb_long', 5, 1), // 20% win-rate
      ...rows('breakout', 5, 4), // 80% win-rate
      { ...rows('orb_long', 1, 0)[0], id: 'open-1', outcome: 'OPEN' as const }, // ignored (open)
    ];
    const refl = buildReflection('2026-06-22', 'green', journal, null);
    expect(refl.totalClosed).toBe(10);
    const orb = refl.bySetup.find((s) => s.key === 'orb_long')!;
    const brk = refl.bySetup.find((s) => s.key === 'breakout')!;
    expect(orb.trades).toBe(5);
    expect(orb.winRate).toBeCloseTo(0.2);
    expect(brk.winRate).toBeCloseTo(0.8);
    expect(refl.byRegime[0].key).toBe('green');
  });

  it('computes plan adherence from planned-symbol wins', () => {
    const plan: AnalystPlan = {
      date: '2026-06-22', generatedAt: 1, regime: 'green', regimeRationale: '', gapRisk: false,
      gates: GATES, watchlist: [{ symbol: 'AMD', rank: 1, proximityScore: 1, reversalScore: 0, trendAlignScore: 0, support: null, resistance: null, nearestKeyLevel: null, reversal: { score: 0, confirmed: false, side: null, entry: null, stop: null, target: null, rr: null } }],
    };
    const refl = buildReflection('2026-06-22', 'green', rows('orb_long', 4, 3), plan);
    expect(refl.planAdherence).toBeCloseTo(0.75);
  });
});

// ── Hypothesis rules ─────────────────────────────────────────────────────────

function reflectionWith(bySetup: AnalystReflection['bySetup']): AnalystReflection {
  return { date: '2026-06-22', regime: 'green', totalClosed: 99, byRegime: [], bySetup, planAdherence: null, narrative: 'n' };
}

describe('deriveHypotheses', () => {
  it('R1 fires on a weak gate (win-rate < 40%, N >= 5) with a tighten delta', () => {
    const refl = buildReflection('2026-06-22', 'green', rows('weak_setup', 6, 1), null);
    const out = deriveHypotheses(refl, TUNABLES, BASE_CONFIG, 1);
    const r1 = out.find((e) => e.rule === 'R1')!;
    expect(r1).toBeTruthy();
    expect(r1.hypothesis.target.path).toBe('RV.rsiOversold');
    expect(r1.hypothesis.proposedDelta).toEqual({ op: 'mul', value: 0.9 });
    expect(r1.hypothesis.source).toBe('reflection');
  });

  it('R2 fires on a strong signal (win-rate > 60% & expectancy > 0, N >= 5) as a signal_weight nudge', () => {
    const refl = buildReflection('2026-06-22', 'green', rows('strong_setup', 6, 5), null);
    const out = deriveHypotheses(refl, TUNABLES, BASE_CONFIG, 1);
    const r2 = out.find((e) => e.rule === 'R2')!;
    expect(r2).toBeTruthy();
    expect(r2.hypothesis.target.kind).toBe('signal_weight');
    expect(r2.hypothesis.proposedDelta).toEqual({ op: 'mul', value: 1.1 });
  });

  it('R3 fallback guarantees >=1 no-op re-validation when neither R1 nor R2 fires', () => {
    // A sparse day: one setup, 2 trades — below N>=5, no rule qualifies.
    const refl = buildReflection('2026-06-22', 'green', rows('weak_setup', 2, 1), null);
    const out = deriveHypotheses(refl, TUNABLES, BASE_CONFIG, 1);
    expect(out.length).toBe(1);
    expect(out[0].rule).toBe('R3');
    // No-op set to the CURRENT value of the target path.
    expect(out[0].hypothesis.proposedDelta.op).toBe('set');
    expect(out[0].hypothesis.proposedDelta.value).toBe(25); // rsiOversold current
  });

  it('R3 still emits when no setup matches a tunable (uses first numeric leaf)', () => {
    const refl = reflectionWith([
      { key: 'unmapped', trades: 2, wins: 1, losses: 1, scratches: 0, winRate: 0.5, expectancy: 0 },
    ]);
    const out = deriveHypotheses(refl, [], BASE_CONFIG, 1);
    expect(out.length).toBe(1);
    expect(out[0].rule).toBe('R3');
    expect(out[0].hypothesis.proposedDelta.op).toBe('set');
  });
});

// ── Pipeline acceptance ──────────────────────────────────────────────────────

describe('runPostmarketReview', () => {
  it('produces a reflection + enqueues every emitted hypothesis (the pipeline accepts them)', async () => {
    const journal = [...rows('weak_setup', 6, 1), ...rows('strong_setup', 6, 5)];
    const { review, queued } = await runPostmarketReview({
      date: '2026-06-22', now: 1, regime: 'green', rows: journal, plan: null,
      baseConfig: BASE_CONFIG, tunables: TUNABLES,
      pipeline: { baseConfig: BASE_CONFIG, runBacktest: fixedExecutor() },
    });
    expect(queued).toBeGreaterThanOrEqual(1);
    expect(review.hypotheses.length).toBe(queued);
    const items = await listPromotionItems();
    expect(items.length).toBe(queued);
    // Everything is queued pending_ratification — nothing auto-applied (invariant).
    expect(items.every((i) => i.status === 'pending_ratification')).toBe(true);
    // The review artifact is persisted.
    expect(existsSync(join(tmp, 'analyst-review-2026-06-22.json'))).toBe(true);
  });

  it('R3 alone guarantees a queued hypothesis on a sparse day (Acceptance #2)', async () => {
    const { queued } = await runPostmarketReview({
      date: '2026-06-22', now: 1, regime: 'green', rows: rows('weak_setup', 1, 0), plan: null,
      baseConfig: BASE_CONFIG, tunables: TUNABLES,
      pipeline: { baseConfig: BASE_CONFIG, runBacktest: fixedExecutor() },
    });
    expect(queued).toBe(1);
  });
});

// ── Persistence + health ─────────────────────────────────────────────────────

describe('persistence + health', () => {
  it('persists the plan idempotently (first write per date wins)', async () => {
    const { plan } = buildPremarketPlan({
      date: '2026-06-22', now: 1, regime: 'green', regimeRationale: '', gates: GATES, gapRisk: false,
      symbols: [{ symbol: 'amd', candles: nearLevelSeries() }],
    });
    expect(await persistAnalystPlan(plan)).toBe(true);
    expect(await persistAnalystPlan({ ...plan, regime: 'red' })).toBe(false); // idempotent skip
    const onDisk = await readAnalystPlan('2026-06-22');
    expect(onDisk?.regime).toBe('green');
  });

  it('health reports plan/review freshness + today-only hypothesis count', async () => {
    const now = Date.parse('2026-06-22T20:00:00Z');
    const today = analystEtDate(now);
    const { plan } = buildPremarketPlan({
      date: today, now, regime: 'green', regimeRationale: '', gates: GATES, gapRisk: false,
      symbols: [{ symbol: 'amd', candles: nearLevelSeries() }],
    });
    await persistAnalystPlan(plan);
    await runPostmarketReview({
      date: today, now, regime: 'green', rows: rows('weak_setup', 1, 0), plan, baseConfig: BASE_CONFIG,
      tunables: TUNABLES, pipeline: { baseConfig: BASE_CONFIG, runBacktest: fixedExecutor() },
    });
    const health = await buildAnalystHealth(now, true);
    expect(health.enabled).toBe(true);
    expect(health.lastPlanDate).toBe(today);
    expect(health.watchlistCount).toBe(1);
    expect(health.lastReviewDate).toBe(today);
    expect(health.hypothesesQueuedToday).toBe(1);
    // A read on a later day shows zero queued-today.
    const tomorrow = Date.parse('2026-06-23T20:00:00Z');
    expect((await buildAnalystHealth(tomorrow, true)).hypothesesQueuedToday).toBe(0);
  });

  it('writes a well-formed plan JSON artifact', async () => {
    const { plan } = buildPremarketPlan({
      date: '2026-06-22', now: 1, regime: 'green', regimeRationale: '', gates: GATES, gapRisk: true,
      symbols: [{ symbol: 'amd', candles: nearLevelSeries() }],
    });
    await persistAnalystPlan(plan);
    const raw = JSON.parse(readFileSync(join(tmp, 'analyst-plan-2026-06-22.json'), 'utf-8'));
    expect(raw.gapRisk).toBe(true);
    expect(Array.isArray(raw.watchlist)).toBe(true);
  });
});
