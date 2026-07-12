import { describe, it, expect } from 'vitest';
import {
  computeCatalystScore,
  computeDirectionalLean,
  NEWS_CATALYST_METHOD,
  EARNINGS_IV_CRUSH_TAG,
  CATALYST_FRESHNESS_MAX_MINUTES,
} from './index.js';
import type { CatalystScoreInput, DirectionalLeanInput } from './index.js';

function catalyst(partial: Partial<CatalystScoreInput> = {}): CatalystScoreInput {
  return {
    netScore: 0.6,
    tilt: 'bullish',
    rvolZ: 1.5,
    gapPct: 4,
    freshHeadlineCount: 2,
    freshnessMinutes: 30,
    ...partial,
  };
}

describe('computeCatalystScore (§4 D1)', () => {
  it('is pure, bounded [0,1], and tags the method', () => {
    const a = computeCatalystScore(catalyst());
    const b = computeCatalystScore(catalyst());
    expect(a).toEqual(b);
    expect(a.method).toBe(NEWS_CATALYST_METHOD);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(1);
  });

  it('applies the exact §4 weights on normalised components', () => {
    // rvolZ 1.5/3=0.5, gap 4/8=0.5, headlines 2/4=0.5, sentimentMag 0.6.
    const r = computeCatalystScore(catalyst());
    expect(r.components).toEqual({ sentimentMag: 0.6, rvolZ: 0.5, gapMag: 0.5, headlineDensity: 0.5 });
    // 0.45*0.6 + 0.30*0.5 + 0.15*0.5 + 0.10*0.5 = 0.27+0.15+0.075+0.05 = 0.545
    expect(r.score).toBeCloseTo(0.545, 6);
  });

  it('zeroes sentiment magnitude when the tilt is neutral', () => {
    const r = computeCatalystScore(catalyst({ tilt: 'neutral', netScore: 0.9 }));
    expect(r.components.sentimentMag).toBe(0);
  });

  it('clamps rvolZ, gap and headline density at the saturation caps', () => {
    const r = computeCatalystScore(catalyst({ rvolZ: 99, gapPct: -50, freshHeadlineCount: 40 }));
    expect(r.components.rvolZ).toBe(1);
    expect(r.components.gapMag).toBe(1); // |−50| clamped to 8 → 1
    expect(r.components.headlineDensity).toBe(1);
  });

  it('gates freshness at 6h', () => {
    expect(computeCatalystScore(catalyst({ freshnessMinutes: CATALYST_FRESHNESS_MAX_MINUTES })).fresh).toBe(true);
    expect(computeCatalystScore(catalyst({ freshnessMinutes: CATALYST_FRESHNESS_MAX_MINUTES + 1 })).fresh).toBe(false);
  });

  it('demotes + tags a name with earnings within one session', () => {
    const r = computeCatalystScore(catalyst({ earningsInDays: 1 }));
    expect(r.demoted).toBe(true);
    expect(r.tags).toContain(EARNINGS_IV_CRUSH_TAG);
    const clean = computeCatalystScore(catalyst({ earningsInDays: 5 }));
    expect(clean.demoted).toBe(false);
    expect(clean.tags).toHaveLength(0);
  });
});

function lean(partial: Partial<DirectionalLeanInput> = {}): DirectionalLeanInput {
  return {
    sentimentTilt: 'bullish',
    pcrContrarian: 'bullish',
    oiQuadrant: 'strong',
    oiPriceDirection: 'up',
    trendState: 'up',
    ivRank: 30,
    ...partial,
  };
}

describe('computeDirectionalLean (§4 D2)', () => {
  it('buckets a fully-aligned bullish name to CALL with the exact blend', () => {
    const r = computeDirectionalLean(lean());
    // 0.40*1 + 0.25*1 + 0.25*1 + 0.10*1 = 1.0
    expect(r.directional).toBeCloseTo(1.0, 6);
    expect(r.verdict).toBe('CALL');
    expect(r.agreement).toEqual({ agree: 4, total: 4 });
    expect(r.confidence).toBe(10);
    expect(r.band).toBe('High');
    expect(r.method).toBe(NEWS_CATALYST_METHOD);
  });

  it('buckets a fully-aligned bearish name to PUT', () => {
    const r = computeDirectionalLean(
      lean({ sentimentTilt: 'bearish', pcrContrarian: 'bearish', oiQuadrant: 'weak', oiPriceDirection: 'down', trendState: 'down' }),
    );
    expect(r.directional).toBeCloseTo(-1.0, 6);
    expect(r.verdict).toBe('PUT');
  });

  it('returns NO-TRADE inside the ±0.25 band', () => {
    // sentiment neutral, pcr null, oi null, trend up → 0.10 only.
    const r = computeDirectionalLean(
      lean({ sentimentTilt: 'neutral', pcrContrarian: null, oiQuadrant: null, oiPriceDirection: null, trendState: 'up' }),
    );
    expect(r.directional).toBeCloseTo(0.1, 6);
    expect(r.verdict).toBe('NO-TRADE');
  });

  it('dampens the weakening (unwind) OI quadrant by the price leg', () => {
    const up = computeDirectionalLean(lean({ oiQuadrant: 'weakening', oiPriceDirection: 'up' }));
    expect(up.components.oiQuadrant).toBe(0.5);
    const down = computeDirectionalLean(lean({ oiQuadrant: 'weakening', oiPriceDirection: 'down' }));
    expect(down.components.oiQuadrant).toBe(-0.5);
  });

  it('picks structure from IV-Rank without moving direction', () => {
    expect(computeDirectionalLean(lean({ ivRank: 60 })).structure).toBe('spread');
    expect(computeDirectionalLean(lean({ ivRank: 20 })).structure).toBe('single-leg');
    expect(computeDirectionalLean(lean({ ivRank: 40 })).structure).toBe('either');
    expect(computeDirectionalLean(lean({ ivRank: null })).structure).toBe('either');
    // direction is identical across all IV-Rank values
    expect(computeDirectionalLean(lean({ ivRank: 60 })).verdict).toBe(
      computeDirectionalLean(lean({ ivRank: 20 })).verdict,
    );
  });

  it('lowers confidence when inputs disagree', () => {
    // bullish sentiment vs bearish pcr + bearish oi → conflicted, weak net.
    const r = computeDirectionalLean(
      lean({ sentimentTilt: 'bullish', pcrContrarian: 'bearish', oiQuadrant: 'weak', oiPriceDirection: 'down', trendState: 'unknown' }),
    );
    // 0.40 − 0.25 − 0.25 + 0 = −0.10 → NO-TRADE, low confidence
    expect(r.directional).toBeCloseTo(-0.1, 6);
    expect(r.verdict).toBe('NO-TRADE');
    expect(r.band).toBe('Low');
  });
});
