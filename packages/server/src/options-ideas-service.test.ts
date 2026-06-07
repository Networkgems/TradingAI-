import { describe, it, expect } from 'vitest';
import type { OptionChainRow } from '@trading-app/engine';
import { inferSpotFromRows, buildIdeasFeed } from './options-ideas-service.js';

const EXP = '2026-07-17';
const row = (optionType: 'call' | 'put', strike: number, bid: number, ask: number): OptionChainRow => ({
  optionSymbol: `${optionType}${strike}`,
  underlying: 'X',
  optionType,
  strike,
  expiration: EXP,
  bid,
  ask,
});

describe('inferSpotFromRows (put-call parity)', () => {
  it('recovers spot from the near-ATM strike', () => {
    // At K=100: C=5, P=4 → S ≈ 100 + (5 - 4) = 101
    const rows = [
      row('call', 100, 4.9, 5.1),
      row('put', 100, 3.9, 4.1),
      row('call', 110, 1.0, 1.2),
      row('put', 90, 0.9, 1.1),
    ];
    expect(inferSpotFromRows(rows)).toBeCloseTo(101, 4);
  });

  it('returns null when no strike has both a call and put mid', () => {
    expect(inferSpotFromRows([row('call', 100, 4.9, 5.1)])).toBeNull();
  });
});

describe('buildIdeasFeed non-live fallbacks', () => {
  const origKey = process.env['ANTHROPIC_API_KEY'];
  const origClaude = process.env['CLAUDE_API_KEY'];
  function clearKeys() {
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['CLAUDE_API_KEY'];
  }
  function restoreKeys() {
    if (origKey != null) process.env['ANTHROPIC_API_KEY'] = origKey;
    if (origClaude != null) process.env['CLAUDE_API_KEY'] = origClaude;
  }

  it('returns a labelled non-live feed when no LLM key is configured', async () => {
    clearKeys();
    try {
      const feed = await buildIdeasFeed({ client: null, symbols: ['MSFT'], noCache: true });
      expect(feed.source).toBe('non_live');
      expect(feed.ideas).toHaveLength(0);
      expect(feed.note).toMatch(/api key/i);
      expect(feed.noDayTrading.enforced).toBe(true);
    } finally {
      restoreKeys();
    }
  });

  it('returns a labelled non-live feed when a key exists but no Tradier client', async () => {
    clearKeys();
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-not-used';
    try {
      const feed = await buildIdeasFeed({ client: null, symbols: ['MSFT'], noCache: true });
      expect(feed.source).toBe('non_live');
      expect(feed.note).toMatch(/tradier/i);
    } finally {
      clearKeys();
      restoreKeys();
    }
  });
});
