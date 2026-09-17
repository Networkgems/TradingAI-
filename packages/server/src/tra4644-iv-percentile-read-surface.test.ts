// TRA-4644 (parent TRA-4413, item 2) — IV PERCENTILE published beside IV RANK
// on the OTM/RV nomination read surface.
//
// What this file covers (the pieces the existing suites don't):
//   1. The coverage classifier + since-boot counters behind the
//      `ivPercentileCoverage` block on /api/health/options-ideas-decomposition.
//   2. The read-only-carrier property: `ivPercentile` on a research symbol must
//      NOT move the batch cache key — the model never sees the field, so it
//      must not bust (or fail to share) a cached slate.
// The feed/fusion carry itself is asserted in options-ideas-feed.test.ts and
// options-research-input.test.ts beside the existing ivRank assertions.
import { describe, it, expect, beforeEach } from 'vitest';
import { optionsResearchBatchKey, type OptionsResearchInput } from '@trading-app/agents';
import {
  classifyIvPercentileCoverage,
  recordIvPercentileCoverage,
  ivPercentileCoverageHealth,
  resetIvPercentileCoverageForTest,
  IV_PERCENTILE_COVERAGE_CODES,
} from './iv-percentile-coverage.js';

describe('classifyIvPercentileCoverage (TRA-4644)', () => {
  it('no usable ATM IV is the chain feed state, never a store-coverage claim', () => {
    // Depth is irrelevant here — neither statistic was even attempted.
    expect(classifyIvPercentileCoverage(null, null, 0)).toBe('no_atm_iv');
    expect(classifyIvPercentileCoverage(null, null, 40)).toBe('no_atm_iv');
  });

  it('a returned percentile is covered', () => {
    expect(classifyIvPercentileCoverage(0.32, 61.5, 40)).toBe('covered');
    expect(classifyIvPercentileCoverage(0.32, 0, 40)).toBe('covered'); // 0 is a real percentile
  });

  it('null with a warm-but-thin window is insufficient_history (self-heals)', () => {
    expect(classifyIvPercentileCoverage(0.32, null, 1)).toBe('insufficient_history');
    expect(classifyIvPercentileCoverage(0.32, null, 19)).toBe('insufficient_history');
    // Depth >= floor but the percentile still refused (non-finite rows were
    // filtered below the floor) — still an insufficient USABLE window.
    expect(classifyIvPercentileCoverage(0.32, null, 25)).toBe('insufficient_history');
  });

  it('null with zero depth is uncovered (unloaded store or never-recorded symbol)', () => {
    expect(classifyIvPercentileCoverage(0.32, null, 0)).toBe('uncovered');
  });
});

describe('ivPercentileCoverage counters + health block (TRA-4644)', () => {
  beforeEach(() => resetIvPercentileCoverageForTest());

  it('publishes a DENSE covered/insufficient/uncovered/no-atm-iv split with shares', () => {
    recordIvPercentileCoverage('AAPL', 'covered', { ivRank: 40, ivPercentile: 55 });
    recordIvPercentileCoverage('MSFT', 'covered', { ivRank: 62, ivPercentile: 71 });
    recordIvPercentileCoverage('RIG', 'insufficient_history', { ivRank: null, ivPercentile: null });
    recordIvPercentileCoverage('XYZ', 'uncovered', { ivRank: null, ivPercentile: null });

    const h = ivPercentileCoverageHealth();
    expect(h.issue).toBe('TRA-4644');
    expect(h.evaluated).toBe(4);
    // Dense over the vocabulary — absent is not zero (TRA-4154 trap).
    expect(h.byCode.map((r) => r.code)).toEqual([...IV_PERCENTILE_COVERAGE_CODES]);
    const by = Object.fromEntries(h.byCode.map((r) => [r.code, r]));
    expect(by['covered']!.count).toBe(2);
    expect(by['covered']!.share).toBeCloseTo(0.5, 6);
    expect(by['insufficient_history']!.count).toBe(1);
    expect(by['uncovered']!.count).toBe(1);
    expect(by['no_atm_iv']!.count).toBe(0);
    expect(by['no_atm_iv']!.share).toBe(0);
    expect(h.lastSymbol).toBe('XYZ');
    expect(h.lastCoveredSymbol).toBe('MSFT');
    expect(h.minIvSamples).toBe(20);
  });

  it('empty counters publish null shares, not fabricated zeros over a zero denominator', () => {
    const h = ivPercentileCoverageHealth();
    expect(h.evaluated).toBe(0);
    for (const row of h.byCode) expect(row.share).toBeNull();
    expect(h.lastEvaluatedAt).toBeNull();
  });

  it('counts the flat-window disagreement (percentile present, rank null)', () => {
    // The one direction the two statistics can disagree on presence: a flat
    // trailing window (max === min) nulls the RANK while the PERCENTILE holds.
    recordIvPercentileCoverage('FLAT', 'covered', { ivRank: null, ivPercentile: 50 });
    recordIvPercentileCoverage('AAPL', 'covered', { ivRank: 40, ivPercentile: 55 });
    expect(ivPercentileCoverageHealth().flatWindowRankNull).toBe(1);
  });
});

describe('ivPercentile is a read-only carrier on the research input (TRA-4644)', () => {
  const input = (ivPercentile: number | null | undefined): OptionsResearchInput => ({
    asOf: Date.parse('2026-09-17T14:00:00Z'),
    symbols: [
      {
        symbol: 'AAPL',
        spot: 195,
        ivRank: 68,
        ...(ivPercentile !== undefined ? { ivPercentile } : {}),
        nextEarningsInDays: 20,
        daysToFOMC: 9,
        macroEventsNearby: ['CPI in 2d'],
        newsSentiment: 0.12,
        candidates: [
          {
            optionSymbol: 'AAPL260101C00200000',
            optionType: 'call',
            strike: 200,
            expiration: '2026-01-01',
            daysToExpiration: 35,
            mark: 4.2,
            ivUsed: 0.31,
            delta: 0.42,
            classification: 'cheap',
            mispricingPct: -0.2,
            source: 'relative_value',
          },
        ],
      },
    ],
  });

  it('does NOT move the batch cache key — the model never sees it', () => {
    // A field excluded from the prompt payload must be excluded from the key:
    // otherwise two identical prompts stop sharing a cached slate (and a future
    // edit folding it into the key would silently smuggle it toward the model).
    const absent = optionsResearchBatchKey(input(undefined));
    expect(optionsResearchBatchKey(input(83))).toBe(absent);
    expect(optionsResearchBatchKey(input(12))).toBe(absent);
    expect(optionsResearchBatchKey(input(null))).toBe(absent);
    // Control: a field the model DOES see moves the key.
    const moved = input(83);
    (moved.symbols[0] as { ivRank: number | null }).ivRank = 5;
    expect(optionsResearchBatchKey(moved)).not.toBe(absent);
  });
});
