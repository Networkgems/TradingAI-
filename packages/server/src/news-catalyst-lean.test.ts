import { describe, it, expect } from 'vitest';
import {
  assembleNameLean,
  assembleNameLeans,
  strongestLeaders,
  renderLeanMarkdown,
  type NameLeanInput,
} from './news-catalyst-lean.js';

function leanInput(partial: Partial<NameLeanInput> & { symbol: string }): NameLeanInput {
  return {
    sentimentTilt: 'bullish',
    pcrContrarian: 'bullish',
    oiQuadrant: 'strong',
    oiPriceDirection: 'up',
    trendState: 'up',
    ivRank: null,
    ...partial,
  };
}

describe('assembleNameLean (§4 D2)', () => {
  it('carries the Output Contract on a CALL name', () => {
    const nl = assembleNameLean(leanInput({ symbol: 'nvda' }));
    expect(nl.symbol).toBe('NVDA');
    expect(nl.lean.verdict).toBe('CALL');
    expect(nl.notionalBand).toContain('observe');
    expect(nl.thesis).toMatch(/calls favoured/i);
    expect(nl.invalidation).toMatch(/bearish|down/i);
  });

  it('reports "—" notional + watch-only thesis on NO-TRADE', () => {
    const nl = assembleNameLean(
      leanInput({ symbol: 'X', sentimentTilt: 'neutral', pcrContrarian: null, oiQuadrant: null, oiPriceDirection: null, trendState: 'unknown' }),
    );
    expect(nl.lean.verdict).toBe('NO-TRADE');
    expect(nl.notionalBand).toBe('—');
  });
});

describe('assembleNameLeans + strongestLeaders', () => {
  it('ranks by |directional| and seeds only directional leaders', () => {
    const leans = assembleNameLeans([
      leanInput({ symbol: 'STRONG' }),
      leanInput({ symbol: 'FLAT', sentimentTilt: 'neutral', pcrContrarian: null, oiQuadrant: null, oiPriceDirection: null, trendState: 'unknown' }),
      leanInput({ symbol: 'BEAR', sentimentTilt: 'bearish', pcrContrarian: 'bearish', oiQuadrant: 'weak', oiPriceDirection: 'down', trendState: 'down' }),
    ]);
    // STRONG (+1) and BEAR (−1) lead; FLAT (0) last.
    expect(leans[leans.length - 1].symbol).toBe('FLAT');
    expect(strongestLeaders(leans)).toEqual(['STRONG', 'BEAR']);
    expect(strongestLeaders(leans)).not.toContain('FLAT');
  });
});

describe('renderLeanMarkdown', () => {
  it('renders a table with a header + one row per name', () => {
    const md = renderLeanMarkdown(assembleNameLeans([leanInput({ symbol: 'AAPL' })]));
    expect(md).toContain('Catalyst Watchlist — Calls vs Puts');
    expect(md).toContain('| Name | Lean |');
    expect(md).toContain('| AAPL | CALL |');
  });

  it('renders an empty-state note when there are no leans', () => {
    expect(renderLeanMarkdown([])).toContain('No catalyst names');
  });
});
