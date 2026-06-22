import { describe, it, expect } from 'vitest';
import type { AttributionRecord } from './external-intel.js';
import type { PromotionItem, Hypothesis } from './hypothesis-pipeline.js';
import type { BacktestGateMetrics } from '@trading-app/shared';
import {
  computeSourceQualityWeights,
  sourceWeightFor,
  passRatePosteriorMean,
  DEFAULT_SOURCE_QUALITY_PARAMS,
} from './source-quality-scorer.js';

// ── Seeded log builders ──────────────────────────────────────────────────────

let seq = 0;

/** An attribution row tying `hypothesisId` to `sourceKey`. */
function attr(sourceKey: string, hypothesisId: string, over: Partial<AttributionRecord> = {}): AttributionRecord {
  seq += 1;
  return {
    hypothesisId,
    sourceKey,
    itemId: `item-${seq}`,
    url: `https://example.test/${seq}`,
    createdAt: seq,
    promptVersion: 'intel-extract-v1',
    ...over,
  };
}

function metrics(): BacktestGateMetrics {
  return {
    expectancy: 0.2,
    sharpe: 1.5,
    profitFactor: 1.4,
    maxDrawdown: 0.1,
    tradeCount: 80,
  } as BacktestGateMetrics;
}

/** A graded queue item for `hypothesisId` with a known G0 pass/fail + status. */
function item(
  hypothesisId: string,
  pass: boolean,
  status: PromotionItem['status'] = pass ? 'pending_ratification' : 'gate_failed',
): PromotionItem {
  const hypothesis: Hypothesis = {
    id: hypothesisId,
    target: { kind: 'sleeve', path: 'RV_CRYPTO_MAJORS.riskPerTradePct' },
    proposedDelta: { op: 'add', value: 0.001 },
    rationale: 'seed',
    source: 'external',
    createdAt: 1,
  };
  return {
    hypothesis,
    baseline: 0.01,
    applied: 0.011,
    metrics: metrics(),
    grade: { pass, failedChecks: pass ? [] : ['expectancy 0R ≤ 0R'], score: pass ? 200 : -1 },
    status,
    queuedAt: 1,
  };
}

/** N graded hypotheses for one source: `passes` pass G0, the rest fail. */
function gradedSource(
  sourceKey: string,
  n: number,
  passes: number,
): { attribution: AttributionRecord[]; items: PromotionItem[] } {
  const attribution: AttributionRecord[] = [];
  const items: PromotionItem[] = [];
  for (let i = 0; i < n; i++) {
    const id = `hyp-${sourceKey}-${i}`;
    attribution.push(attr(sourceKey, id));
    items.push(item(id, i < passes));
  }
  return { attribution, items };
}

// ── Beta posterior mean ──────────────────────────────────────────────────────

describe('passRatePosteriorMean', () => {
  it('is exactly the baseline with no evidence and shrinks small samples toward it', () => {
    expect(passRatePosteriorMean(0, 0, 0.5, 2)).toBe(0.5);
    // 1/1 = 100% raw, but the posterior mean is pulled toward 0.5 ⇒ 2/3.
    expect(passRatePosteriorMean(1, 1, 0.5, 2)).toBeCloseTo(2 / 3, 10);
    // all-fail of 5 ⇒ (0+1)/(5+2) = 1/7, below baseline.
    expect(passRatePosteriorMean(0, 5, 0.5, 2)).toBeCloseTo(1 / 7, 10);
  });

  it('converges on the raw rate as evidence accrues', () => {
    const small = passRatePosteriorMean(4, 5, 0.5, 2); // 6/7 ≈ 0.857
    const big = passRatePosteriorMean(40, 50, 0.5, 2); // 41/52 ≈ 0.788
    // Both above baseline; the larger sample sits closer to the raw 0.8.
    expect(small).toBeGreaterThan(0.5);
    expect(big).toBeGreaterThan(0.5);
    expect(Math.abs(big - 0.8)).toBeLessThan(Math.abs(small - 0.8));
  });
});

// ── Core fold ────────────────────────────────────────────────────────────────

describe('computeSourceQualityWeights', () => {
  it('joins attribution against the queue and counts gate outcomes per source', () => {
    const good = gradedSource('reddit:r/good', 8, 6); // 6/8 pass
    const bad = gradedSource('reddit:r/bad', 8, 1); // 1/8 pass
    const w = computeSourceQualityWeights(
      [...good.attribution, ...bad.attribution],
      [...good.items, ...bad.items],
    );

    expect(w.generatedFrom).toEqual({ attributions: 16, sources: 2, graded: 16 });
    const g = w.bySource.find(s => s.sourceKey === 'reddit:r/good')!;
    const b = w.bySource.find(s => s.sourceKey === 'reddit:r/bad')!;
    expect(g.graded).toBe(8);
    expect(g.g0Pass).toBe(6);
    expect(g.g0Fail).toBe(2);
    expect(g.gatePassRate).toBeCloseTo(0.75, 10);
    // A consistently-gated source gains weight; a failing one self-deweights.
    expect(g.weight).toBeGreaterThan(1);
    expect(b.weight).toBeLessThan(1);
    // bySource is ranked by weight desc.
    expect(w.bySource[0].sourceKey).toBe('reddit:r/good');
  });

  it('dedups (source, hypothesis): re-surfacing the same idea is one vote', () => {
    const id = 'hyp-shared';
    const attribution = [
      attr('reddit:r/x', id, { itemId: 'a' }),
      attr('reddit:r/x', id, { itemId: 'b' }),
      attr('reddit:r/x', id, { itemId: 'c' }),
    ];
    const w = computeSourceQualityWeights(attribution, [item(id, true)]);
    const s = w.bySource[0];
    expect(s.hypotheses).toBe(1);
    expect(s.graded).toBe(1);
    expect(s.g0Pass).toBe(1);
  });

  it('min-sample guard holds: a source stays neutral (1.0) until N ≥ minSamples', () => {
    const k = DEFAULT_SOURCE_QUALITY_PARAMS.minSamples;
    const below = gradedSource('reddit:r/new', k - 1, k - 1); // all pass, but under guard
    const at = gradedSource('reddit:r/proven', k, k); // all pass, at guard

    const w = computeSourceQualityWeights(
      [...below.attribution, ...at.attribution],
      [...below.items, ...at.items],
    );
    const newS = w.bySource.find(s => s.sourceKey === 'reddit:r/new')!;
    const proven = w.bySource.find(s => s.sourceKey === 'reddit:r/proven')!;

    expect(newS.confident).toBe(false);
    expect(newS.weight).toBe(1);
    expect(newS.gatePassRate).toBe(1); // still REPORTS the rate, just doesn't act on it
    expect(proven.confident).toBe(true);
    expect(proven.weight).toBeGreaterThan(1);
  });

  it('counts attributed-but-ungraded hypotheses in `hypotheses` but not `graded`', () => {
    const graded = 'hyp-graded';
    const pending = 'hyp-pending';
    const attribution = [attr('reddit:r/x', graded), attr('reddit:r/x', pending)];
    // Only the graded one has a queue row.
    const w = computeSourceQualityWeights(attribution, [item(graded, true)]);
    const s = w.bySource[0];
    expect(s.hypotheses).toBe(2);
    expect(s.graded).toBe(1);
    expect(w.generatedFrom.graded).toBe(1);
  });

  it('rolls up board ratified/rejected decisions on the gate-passers', () => {
    const attribution = [
      attr('reddit:r/x', 'h1'),
      attr('reddit:r/x', 'h2'),
      attr('reddit:r/x', 'h3'),
    ];
    const items = [
      item('h1', true, 'ratified'),
      item('h2', true, 'rejected'),
      item('h3', true, 'pending_ratification'),
    ];
    const s = computeSourceQualityWeights(attribution, items).bySource[0];
    expect(s.g0Pass).toBe(3);
    expect(s.ratified).toBe(1);
    expect(s.rejected).toBe(1);
  });

  it('monotonically deweights a confident source as failures accrue', () => {
    // Start at the guard with a passing mix, then append failures one at a time.
    const base = gradedSource('reddit:r/decaying', 10, 8); // 8/10 pass, confident
    const attribution = [...base.attribution];
    const items = [...base.items];

    const weights: number[] = [];
    for (let i = 0; i < 4; i++) {
      const w = computeSourceQualityWeights(attribution, items);
      weights.push(w.bySource[0].weight);
      // Append one more FAILING hypothesis from the same source.
      const id = `hyp-fail-${i}`;
      attribution.push(attr('reddit:r/decaying', id));
      items.push(item(id, false));
    }

    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThan(weights[i - 1]);
    }
  });

  it('sourceWeightFor is neutral for unknown / sub-guard sources', () => {
    const w = computeSourceQualityWeights([], []);
    expect(sourceWeightFor(w, 'reddit:r/never-seen')).toBe(1);

    const sub = gradedSource('reddit:r/tiny', 2, 2);
    const w2 = computeSourceQualityWeights(sub.attribution, sub.items);
    expect(sourceWeightFor(w2, 'reddit:r/tiny')).toBe(1);
  });
});
