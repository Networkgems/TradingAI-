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
    // TRA-4585 — CHEAP is a MEASUREMENT. Its sibling cases below are the absence
    // of one, and they must not land on this token.
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

// ── TRA-4585 (parent TRA-4222) ──────────────────────────────────────────────
//
// `scoreAndSelect` used to read:
//
//     else if (c.price == null || c.price < minPrice) dropReason = 'below_min_price';
//
// so a market-data outage was filed under the price screen. On 2026-08-31 that
// rejected SPY, DIA, TSLA, NFLX, AVGO, ORCL, CRM, ADBE, MSTR, COIN, QCOM, AMD,
// INTC and PYPL as "below min price" — 14 drops, against 1 across the 25 prior
// sessions — and the session entered the forward-test cohort as an ordinary
// 0-catalyst day. Spotting it required the reader to already know that SPY is
// not a penny stock.

describe('scoreAndSelect — a missing quote is not a cheap stock (TRA-4585)', () => {
  it('separates no_quote from below_min_price across every unusable price shape', () => {
    const { scored } = scoreAndSelect([
      candidate({ symbol: 'NULLP', price: null }),
      candidate({ symbol: 'ZEROP', price: 0 }),
      candidate({ symbol: 'NEGP', price: -1 }),
      candidate({ symbol: 'NANP', price: Number.NaN }),
      candidate({ symbol: 'INFP', price: Number.POSITIVE_INFINITY }),
      candidate({ symbol: 'CHEAP', price: 3 }),
      candidate({ symbol: 'GOOD', price: 100 }),
    ]);
    const reason = (s: string) => scored.find((r) => r.symbol === s)?.dropReason;

    // `0` and `-1` are the load-bearing half: the 2026-08-31 feed returned nulls
    // AND zeros, and under a bare `price == null` split the zeros fall straight
    // through to `0 < minPrice` and reproduce the bug on that part of the
    // population. `NaN` is its own trap — BOTH `< minPrice` and `>= minPrice`
    // are false for it, so it silently passes the price screen entirely.
    expect(reason('NULLP')).toBe('no_quote');
    expect(reason('ZEROP')).toBe('no_quote');
    expect(reason('NEGP')).toBe('no_quote');
    expect(reason('NANP')).toBe('no_quote');
    expect(reason('INFP')).toBe('no_quote');

    // …and the real price screen is untouched.
    expect(reason('CHEAP')).toBe('below_min_price');
    expect(reason('GOOD')).toBeNull();
  });

  it('reproduces 2026-08-31: fourteen mega-caps, zero of them below the floor', () => {
    // The exact cohort the outage rejected. Under the old line every one of
    // these read `below_min_price`; the assertion that matters is that NONE of
    // them does now, because none of them was ever priced.
    const outage = ['SPY', 'DIA', 'TSLA', 'NFLX', 'AVGO', 'ORCL', 'CRM', 'ADBE',
                    'MSTR', 'COIN', 'QCOM', 'AMD', 'INTC', 'PYPL'];
    const { chosen, scored } = scoreAndSelect(
      outage.map((symbol) => candidate({ symbol, price: null })),
    );

    expect(chosen).toEqual([]);
    expect(scored).toHaveLength(14);
    expect(scored.every((s) => s.dropReason === 'no_quote')).toBe(true);
    expect(scored.some((s) => s.dropReason === 'below_min_price')).toBe(false);
  });

  it('checks the quote BEFORE the floor, so a 0 can never read as cheap', () => {
    // Ordering is as load-bearing as the split. If `< minPrice` were evaluated
    // first, `0 < 5` wins and the outage is reported as a penny stock again.
    const { scored } = scoreAndSelect([candidate({ symbol: 'ZEROP', price: 0 })], {
      minPrice: 5,
    });
    expect(scored[0].dropReason).toBe('no_quote');
  });

  it('still lets the earlier hard gates win over a missing quote', () => {
    // `not_tradable` / `hidden` are checked first and stay first: an unpriced
    // name we would never trade anyway is not evidence of a feed outage, and
    // must not inflate the degraded population.
    const { scored } = scoreAndSelect(
      [
        candidate({ symbol: 'HID', price: null }),
        candidate({ symbol: 'NOPE', price: null }),
      ],
      { hidden: new Set(['HID']), tradable: (s) => s !== 'NOPE' },
    );
    const reason = (s: string) => scored.find((r) => r.symbol === s)?.dropReason;
    expect(reason('HID')).toBe('hidden');
    expect(reason('NOPE')).toBe('not_tradable');
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
