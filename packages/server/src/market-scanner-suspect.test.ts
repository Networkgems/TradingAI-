import { describe, it, expect } from 'vitest';
import { isScreenerMoveSuspect, type ScreenerMoveFields } from './market-scanner.js';

/**
 * TRA-2379 — this tests the guard at ITS OWN CALL SITE, not the shared predicate.
 *
 * The distinction matters here more than usual: `market-scanner` does not read
 * `symbolState`, so the `quoteStatus:'suspect'` stamped by
 * `signal-engine.applyQuotes` never reaches it. The scanner re-derives the verdict
 * from the SCREENER's own field names (`regularMarketPrice` /
 * `regularMarketChange` / `regularMarketChangePercent`), and a rename or a typo in
 * that mapping would silently restore the defect while the shared predicate's own
 * suite stayed green. So the field mapping is what is under test.
 */

/** FFAI as a Yahoo screener row would carry it (live values, 2026-07-26). */
const FFAI_SCREENER: ScreenerMoveFields = {
  regularMarketPrice: 6.49,
  regularMarketChange: 6.42,
  regularMarketChangePercent: 8951.61,
};

describe('TRA-2379 market-scanner screener guard', () => {
  it('excludes the FFAI-shaped gainer row', () => {
    expect(isScreenerMoveSuspect('FFAI', FFAI_SCREENER, 'gainer')).toBe(true);
  });

  it('excludes the same shape on the LOSER side (unadjusted forward split)', () => {
    // 10:1 forward split, prev close unadjusted: -90%, which a flat 100% test
    // could never catch.
    const row: ScreenerMoveFields = {
      regularMarketPrice: 5,
      regularMarketChange: -45,
      regularMarketChangePercent: -90,
    };
    expect(isScreenerMoveSuspect('SPLT', row, 'loser')).toBe(true);
  });

  it('keeps a genuine +33.97% microcap gainer', () => {
    const jem: ScreenerMoveFields = {
      regularMarketPrice: 6.35,
      regularMarketChange: 1.61,
      regularMarketChangePercent: 33.97,
    };
    expect(isScreenerMoveSuspect('JEM', jem, 'gainer')).toBe(false);
  });

  it('keeps a genuine -39.60% microcap loser (the largest real mover on the tape)', () => {
    const gsun: ScreenerMoveFields = {
      regularMarketPrice: 0.21,
      regularMarketChange: -0.14,
      regularMarketChangePercent: -39.60,
    };
    expect(isScreenerMoveSuspect('GSUN', gsun, 'loser')).toBe(false);
  });

  it('does not exclude a row the screener gave no price for', () => {
    // A missing price is a screener-shape problem, not an implausible move; the
    // existing `q.symbol && q.quoteType === 'EQUITY'` filter owns that case, and
    // this guard must not start silently dropping rows it cannot judge.
    expect(isScreenerMoveSuspect('NOPX', { regularMarketChangePercent: 12 }, 'gainer')).toBe(false);
  });

  it('reads the percentage when the screener omits the absolute change', () => {
    expect(isScreenerMoveSuspect('FFAI', {
      regularMarketPrice: 6.49,
      regularMarketChangePercent: 8951.61,
    }, 'gainer')).toBe(true);
  });
});
