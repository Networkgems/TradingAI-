import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import type { AgentScoreReport } from '@trading-app/backtest';
import { buildIvRankCoverage, type ForwardTestReport } from './options-forward-test.js';
import {
  SCORECARD_MIN_SAMPLE,
  classifySample,
  poolProposalScores,
  parseProposalsArtifact,
  buildProposalsScorecard,
  buildAiIdeasScorecard,
  buildEngineScorecard,
  loadProposalsScorecard,
} from './engine-scorecard.js';

function scoreReport(over: Partial<AgentScoreReport> = {}): AgentScoreReport {
  return {
    agent: { totalSignals: 20, winningSignals: 12, winRate: 0.6, avgRR: 0.4 },
    baseline: { totalSignals: 25, winningSignals: 12, winRate: 0.48, avgRR: 0.1 },
    edgeVsBaseline: { winRateDelta: 0.12, avgRDelta: 0.3 },
    horizonBars: 20,
    routableCount: 20,
    totalRecommendations: 40,
    ...over,
  };
}

function forwardReport(totals: Partial<ForwardTestReport['totals']> = {}): ForwardTestReport {
  return {
    generatedAt: 0,
    asOfDate: '2026-06-25',
    chainsDir: '/data/option-chains',
    totals: {
      surfaced: 50,
      resolved: 35,
      open: 10,
      awaitingData: 0,
      noData: 0,
      excluded: 5,
      excludedCostUneconomic: 0,
      avgCostEfficiencyRatio: 0.05,
      wins: 21,
      losses: 12,
      scratches: 2,
      hitRate: 0.6,
      expectancyUsd: 12.5,
      expectancyR: 0.18,
      expectancyNetUsd: 8.1,
      expectancyNetR: 0.11,
      profitFactor: 1.4,
      avgPredictedPop: 0.58,
      popCalibrationGap: 0.02,
      avgCalibratedPop: 0.6,
      popCalibrationGapCalibrated: 0.0,
      maxLossBreaches: 0,
      weeksWithResolved: 9,
      weeksPositiveExpectancy: 7,
      weeksPositiveExpectancyNet: 6,
      ...totals,
    },
    weeks: [],
    decomposition: {
      asOfDate: '2026-06-25',
      n: 0,
      overall: {
        key: 'overall',
        n: 0,
        grossR: null,
        netR: null,
        meanPop: null,
        hitRate: null,
        popCalibrationGap: null,
        meanCreditWidth: null,
      },
      byStructure: [],
      byDteBucket: [],
      byIvRankBucket: [],
      byTicker: [],
      // TRA-2206 — build the empty-cohort coverage block rather than inlining it,
      // so this fixture tracks the shape instead of pinning a stale literal.
      ivRankCoverage: buildIvRankCoverage([]),
      note: 'test',
    },
    popCalibration: {
      mode: 'flat',
      n: 0,
      minFitN: 43,
      haircut: 0.15,
      avgStatedPop: null,
      avgCalibratedPop: null,
      hitRate: null,
      rawGap: null,
      calibratedGap: null,
      knots: [],
      note: 'test',
    },
    methodology: 'test',
  };
}

describe('classifySample', () => {
  it('labels below half-floor as insufficient', () => {
    const s = classifySample(5);
    expect(s.label).toBe('insufficient');
    expect(s.sufficient).toBe(false);
    expect(s.minSample).toBe(SCORECARD_MIN_SAMPLE);
  });

  it('labels between half-floor and floor as thin', () => {
    expect(classifySample(20).label).toBe('thin');
    expect(classifySample(20).sufficient).toBe(false);
  });

  it('labels at/above floor as adequate + sufficient', () => {
    const s = classifySample(SCORECARD_MIN_SAMPLE);
    expect(s.label).toBe('adequate');
    expect(s.sufficient).toBe(true);
  });
});

describe('poolProposalScores', () => {
  it('pools win-rate exactly from per-symbol win counts and weights avg-R by n', () => {
    const a = scoreReport({
      agent: { totalSignals: 10, winningSignals: 6, winRate: 0.6, avgRR: 0.5 },
      baseline: { totalSignals: 10, winningSignals: 4, winRate: 0.4, avgRR: 0.1 },
    });
    const b = scoreReport({
      agent: { totalSignals: 30, winningSignals: 12, winRate: 0.4, avgRR: 0.1 },
      baseline: { totalSignals: 30, winningSignals: 9, winRate: 0.3, avgRR: 0.0 },
    });
    const pooled = poolProposalScores([a, b]);
    // agent: 18 wins / 40 = 0.45; avgR = (0.5*10 + 0.1*30)/40 = 8/40 = 0.2
    expect(pooled.agent).toEqual({ n: 40, winRate: 0.45, avgR: 0.2 });
    // baseline: 13/40 = 0.325; avgR = (0.1*10 + 0*30)/40 = 0.025
    expect(pooled.baseline.winRate).toBe(0.325);
    expect(pooled.baseline.avgR).toBe(0.025);
    expect(pooled.edgeVsBaseline.winRateDelta).toBe(0.125);
    expect(pooled.edgeVsBaseline.avgRDelta).toBe(0.175);
    expect(pooled.horizonBars).toBe(20);
    expect(pooled.totalRecommendations).toBe(80);
  });

  it('returns null metrics for an empty pool', () => {
    const pooled = poolProposalScores([]);
    expect(pooled.agent).toEqual({ n: 0, winRate: null, avgR: null });
    expect(pooled.edgeVsBaseline).toEqual({ winRateDelta: null, avgRDelta: null });
    expect(pooled.horizonBars).toBe(null);
  });
});

describe('parseProposalsArtifact', () => {
  it('extracts scoring blocks + window from a TRA-797 artifact shape', () => {
    const raw = {
      generatedWindow: { start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z' },
      validations: {
        'BTC-USD': { scoring: scoreReport() },
        'ETH-USD': { scoring: scoreReport() },
      },
    };
    const parsed = parseProposalsArtifact(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.reports).toHaveLength(2);
    expect(parsed!.window).toEqual({ start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z' });
  });

  it('returns null when no scoring blocks are present', () => {
    expect(parseProposalsArtifact({ validations: {} })).toBeNull();
    expect(parseProposalsArtifact({ validations: { X: { scoring: { junk: 1 } } } })).toBeNull();
    expect(parseProposalsArtifact(null)).toBeNull();
    expect(parseProposalsArtifact({})).toBeNull();
  });
});

describe('buildAiIdeasScorecard', () => {
  it('maps forward-test totals onto the AI Ideas side with a resolved-count sample', () => {
    const card = buildAiIdeasScorecard(forwardReport());
    expect(card.engine).toBe('ai-ideas');
    expect(card.available).toBe(true);
    expect(card.resolved).toBe(35);
    expect(card.hitRate).toBe(0.6);
    expect(card.expectancyNetR).toBe(0.11);
    expect(card.popCalibrationGap).toBe(0.02);
    expect(card.sample.sufficient).toBe(true); // 35 >= 30
  });

  it('flags a thin resolved sample', () => {
    const card = buildAiIdeasScorecard(forwardReport({ resolved: 3, hitRate: 1, wins: 3 }));
    expect(card.sample.label).toBe('insufficient');
    expect(card.sample.sufficient).toBe(false);
  });
});

describe('buildEngineScorecard comparison note', () => {
  it('never implies a winner when a sample is below the floor', () => {
    const proposals = buildProposalsScorecard(
      { reports: [scoreReport({ agent: { totalSignals: 5, winningSignals: 4, winRate: 0.8, avgRR: 1 } })], window: null },
      'test',
    );
    const aiIdeas = buildAiIdeasScorecard(forwardReport());
    const card = buildEngineScorecard(proposals, aiIdeas);
    expect(card.comparison.bothSamplesSufficient).toBe(false);
    expect(card.comparison.note).toMatch(/no engine is more\/less accurate/i);
  });

  it('stays winner-free even when both samples clear', () => {
    const proposals = buildProposalsScorecard({ reports: [scoreReport()], window: null }, 'test');
    const aiIdeas = buildAiIdeasScorecard(forwardReport());
    const card = buildEngineScorecard(proposals, aiIdeas);
    expect(card.comparison.bothSamplesSufficient).toBe(false); // proposals n=20 < 30
    expect(card.comparison.note).not.toMatch(/winner/i);
  });

  it('reports no-data on both engines distinctly', async () => {
    const proposals = await loadProposalsScorecard(['/nonexistent/x.json']); // unavailable
    const aiIdeas = buildAiIdeasScorecard(forwardReport({ resolved: 0, hitRate: null, wins: 0 }));
    const card = buildEngineScorecard(proposals, aiIdeas);
    expect(card.comparison.note).toMatch(/no out-of-sample data on either engine/i);
  });
});

describe('loadProposalsScorecard', () => {
  it('degrades to unavailable when no artifact exists', async () => {
    const card = await loadProposalsScorecard(['/nonexistent/path/x.json']);
    expect(card.available).toBe(false);
    expect(card.sample.n).toBe(0);
    expect(card.source).toMatch(/no persisted OOS|could not|no agent scoring/i);
  });

  it('loads + pools a real artifact file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
    try {
      const file = join(dir, 'tra797.json');
      writeFileSync(
        file,
        JSON.stringify({
          generatedWindow: { start: 's', end: 'e' },
          validations: { 'BTC-USD': { scoring: scoreReport() } },
        }),
      );
      const card = await loadProposalsScorecard([file]);
      expect(card.available).toBe(true);
      expect(card.agent.n).toBe(20);
      expect(card.generatedWindow).toEqual({ start: 's', end: 'e' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
