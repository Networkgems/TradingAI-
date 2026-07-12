import { describe, it, expect } from 'vitest';
import { scoreAndSelect, mapNewsToCandidates, type CatalystCandidate } from './news-catalyst-source.js';
import type { NewsItem } from '@trading-app/shared';

const NOW = Date.parse('2026-06-02T14:00:00.000Z');
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function candidate(partial: Partial<CatalystCandidate> & { symbol: string }): CatalystCandidate {
  return {
    netScore: 0.6,
    tilt: 'bullish',
    freshHeadlineCount: 3,
    freshnessMinutes: 30,
    rvolZ: 2,
    gapPct: 4,
    price: 100,
    avgDollarVol: 5_000_000,
    earningsInDays: null,
    ...partial,
  };
}

describe('scoreAndSelect (§4 D1 eligibility + cap)', () => {
  it('chooses eligible names ranked by score, capped at the top-N', () => {
    const cands = [
      candidate({ symbol: 'AAA', netScore: 0.9 }),
      candidate({ symbol: 'BBB', netScore: 0.3 }),
      candidate({ symbol: 'CCC', netScore: 0.6 }),
    ];
    const { chosen } = scoreAndSelect(cands, { cap: 2 });
    expect(chosen.map((c) => c.symbol)).toEqual(['AAA', 'CCC']);
    // BBB ranked out by the cap → recorded as below_cap
  });

  it('drops names failing each hard-eligibility gate with a reason', () => {
    const { scored } = scoreAndSelect(
      [
        candidate({ symbol: 'CHEAP', price: 3 }),
        candidate({ symbol: 'THIN', avgDollarVol: 1000 }),
        candidate({ symbol: 'STALE', freshnessMinutes: 999 }),
        candidate({ symbol: 'FLAT', tilt: 'neutral' }),
        candidate({ symbol: 'ERN', earningsInDays: 1 }),
        candidate({ symbol: 'HID' }),
      ],
      { hidden: new Set(['HID']) },
    );
    const reason = (s: string) => scored.find((r) => r.symbol === s)?.dropReason;
    expect(reason('CHEAP')).toBe('below_min_price');
    expect(reason('THIN')).toBe('below_liquidity');
    expect(reason('STALE')).toBe('stale');
    expect(reason('FLAT')).toBe('neutral_tilt');
    expect(reason('ERN')).toBe('earnings_demote');
    expect(reason('HID')).toBe('hidden');
  });

  it('records every candidate (chosen + dropped) for the ledger', () => {
    const { chosen, scored } = scoreAndSelect([
      candidate({ symbol: 'GOOD' }),
      candidate({ symbol: 'CHEAP', price: 1 }),
    ]);
    expect(scored).toHaveLength(2);
    expect(chosen).toHaveLength(1);
    expect(scored.every((s) => typeof s.score.score === 'number')).toBe(true);
  });
});

describe('mapNewsToCandidates', () => {
  function item(title: string, ageMin = 30): NewsItem {
    return {
      title,
      url: `https://x/${encodeURIComponent(title)}`,
      source: 'Wire',
      publishedAt: minAgo(ageMin),
    };
  }

  it('maps headlines onto universe tickers via ticker + alias', () => {
    const news = [
      item('NVDA surges after earnings beat'),
      item('Apple unveils record buyback'),
      item('Unrelated market chatter'),
    ];
    const cands = mapNewsToCandidates(news, NOW, ['NVDA', 'AAPL', 'TSLA']);
    const syms = cands.map((c) => c.symbol).sort();
    expect(syms).toContain('NVDA');
    expect(syms).toContain('AAPL');
    expect(syms).not.toContain('TSLA');
  });

  it('counts only fresh (<6h) headlines toward density', () => {
    const news = [item('NVDA surges', 30), item('NVDA rallies again', 60), item('NVDA gained last week', 20 * 60)];
    const [c] = mapNewsToCandidates(news, NOW, ['NVDA']);
    expect(c.freshHeadlineCount).toBe(2);
  });
});
