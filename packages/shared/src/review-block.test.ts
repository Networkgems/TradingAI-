import { describe, it, expect } from 'vitest';
import {
  coerceReviewBlock,
  isReviewBlock,
  validateReviewBlock,
  type ReviewBlock,
} from './review-block.js';

const VALID: ReviewBlock = {
  leaders: ['AAPL', 'NVDA', 'MSFT'],
  invalidationLevels: { AAPL: 308.5, NVDA: 880 },
  gapRisk: true,
  regimeLabel: 'yellow',
};

describe('validateReviewBlock', () => {
  it('accepts a well-formed block', () => {
    expect(validateReviewBlock(VALID)).toEqual([]);
    expect(isReviewBlock(VALID)).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateReviewBlock(null).length).toBeGreaterThan(0);
    expect(validateReviewBlock('nope').length).toBeGreaterThan(0);
    expect(isReviewBlock([])).toBe(false);
  });

  it('flags each malformed field', () => {
    expect(validateReviewBlock({ ...VALID, leaders: [1, 2] })).toContain(
      'leaders: must be an array of strings',
    );
    expect(validateReviewBlock({ ...VALID, invalidationLevels: { AAPL: 'x' } })).toContain(
      'invalidationLevels: every level must be a finite number',
    );
    expect(validateReviewBlock({ ...VALID, invalidationLevels: { AAPL: Infinity } })).toContain(
      'invalidationLevels: every level must be a finite number',
    );
    expect(validateReviewBlock({ ...VALID, gapRisk: 'true' })).toContain('gapRisk: must be a boolean');
    expect(validateReviewBlock({ ...VALID, regimeLabel: 'blue' })).toContain(
      'regimeLabel: must be one of green|yellow|red',
    );
  });
});

describe('coerceReviewBlock', () => {
  it('uppercases + de-dupes leaders and re-keys invalidation levels', () => {
    const block = coerceReviewBlock({
      leaders: ['aapl', 'AAPL', ' nvda ', 'msft'],
      invalidationLevels: { aapl: 308.5, ' nvda ': 880 },
      gapRisk: false,
      regimeLabel: 'green',
    });
    expect(block.leaders).toEqual(['AAPL', 'NVDA', 'MSFT']);
    expect(block.invalidationLevels).toEqual({ AAPL: 308.5, NVDA: 880 });
  });

  it('throws on an invalid block', () => {
    expect(() => coerceReviewBlock({ leaders: 'AAPL' })).toThrow(/invalid ReviewBlock/);
  });

  it('round-trips through JSON unchanged (on-disk form === canonical form)', () => {
    const canonical = coerceReviewBlock(VALID);
    const roundTripped = coerceReviewBlock(JSON.parse(JSON.stringify(canonical)));
    expect(roundTripped).toEqual(canonical);
    // And a second coerce is a no-op (idempotent normalization).
    expect(coerceReviewBlock(roundTripped)).toEqual(canonical);
  });
});
