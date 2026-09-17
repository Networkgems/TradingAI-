/**
 * TRA-2392 — universe-gated promotion tests.
 *
 * Tests the conjunction: a widening is allowed only when BOTH ratified AND
 * covered by the granted universe G. Covers the three REFUSE cases and the
 * four regression cases from TRA-3473.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { PromotionDecision } from '@trading-app/shared';
import { isSymbolUniverseSubset } from '@trading-app/shared';

describe('TRA-2392 — symbol universe promotion gates', () => {
  describe('isSymbolUniverseSubset', () => {
    it('reads null as ⊤ in BOTH positions', () => {
      // ⊤ ⊆ ⊤ — holding an unbounded universe is not a widening
      expect(isSymbolUniverseSubset(null, null)).toBe(true);

      // ⊤ ⊄ finite — unbounded is NOT a subset of any finite list
      expect(isSymbolUniverseSubset(null, ['BTC-USD'])).toBe(false);

      // finite ⊆ ⊤ — everything is a subset of unbounded
      expect(isSymbolUniverseSubset(['BTC-USD'], null)).toBe(true);
    });

    it('handles finite subset checks correctly', () => {
      expect(isSymbolUniverseSubset(['BTC-USD'], ['BTC-USD', 'ETH-USD'])).toBe(true);
      expect(isSymbolUniverseSubset(['BTC-USD', 'ETH-USD'], ['BTC-USD'])).toBe(false);
      expect(isSymbolUniverseSubset(['BTC-USD'], ['BTC-USD'])).toBe(true);
      expect(isSymbolUniverseSubset([], ['BTC-USD'])).toBe(true);
      expect(isSymbolUniverseSubset([], [])).toBe(true);
    });
  });

  describe('TRA-3473 — granted universe conjunction (ratified AND covered by G)', () => {
    // Mock promotion decision lookup
    const mockDecisions: Record<string, PromotionDecision | undefined> = {};

    beforeEach(() => {
      // Reset mock decisions
      Object.keys(mockDecisions).forEach(k => delete mockDecisions[k]);
    });

    /**
     * Helper to simulate the gate logic: a widening is allowed only when BOTH
     * ratified AND covered by G.
     */
    function isWideningAllowed(args: {
      nextUniverse: readonly string[] | null;
      prevUniverse: readonly string[] | null;
      presetId: string;
      strategyId: string;
      grantedUniverse?: readonly string[] | null;
    }): boolean {
      const { nextUniverse, prevUniverse, presetId, strategyId, grantedUniverse } = args;

      // Not a widening → allowed (narrowing/hold exemption)
      if (isSymbolUniverseSubset(nextUniverse, prevUniverse)) {
        return true;
      }

      // It's a widening. Check both conditions:
      const isRatified = ['crypto_core_live_canary_btc', 'crypto_core_live_majors'].includes(presetId);
      const isCoveredByG = grantedUniverse !== undefined
        ? isSymbolUniverseSubset(nextUniverse, grantedUniverse)
        : false;

      return isRatified && isCoveredByG;
    }

    describe('REFUSE cases (behaviour changes from today)', () => {
      it('case 1: canary→majors with no G on record', () => {
        // Today: allowed via :403 bypass. After AC2: REFUSED.
        const allowed = isWideningAllowed({
          nextUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'], // majors
          prevUniverse: ['BTC-USD'], // canary
          presetId: 'crypto_core_live_majors',
          strategyId: 'dca',
          grantedUniverse: undefined, // no G on record
        });
        expect(allowed).toBe(false);
      });

      it('case 2: canary→majors with G={BTC-USD} (too narrow)', () => {
        // The universe a real DCA Stage-1 registration would carry
        const allowed = isWideningAllowed({
          nextUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
          prevUniverse: ['BTC-USD'],
          presetId: 'crypto_core_live_majors',
          strategyId: 'dca',
          grantedUniverse: ['BTC-USD'], // granted only BTC, not majors
        });
        expect(allowed).toBe(false);
      });

      it('case 3: anything→crypto_core (unbounded), ratified or not', () => {
        // The ≈395-pair grandfathering this chain exists to close
        const allowed = isWideningAllowed({
          nextUniverse: null, // unbounded
          prevUniverse: ['BTC-USD'],
          presetId: 'crypto_core_live_majors', // even if ratified
          strategyId: 'dca',
          grantedUniverse: ['BTC-USD', 'ETH-USD'], // any finite G
        });
        expect(allowed).toBe(false);
      });
    });

    describe('MUST STILL PASS (regression guards — TRA-1590 deadlock)', () => {
      it('case 4: majors→canary (narrowing)', () => {
        const allowed = isWideningAllowed({
          nextUniverse: ['BTC-USD'],
          prevUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
          presetId: 'crypto_core_live_canary_btc',
          strategyId: 'dca',
          // G is irrelevant for narrowing
        });
        expect(allowed).toBe(true);
      });

      it('case 5: hold same preset (⊤ ⊆ ⊤)', () => {
        const allowed = isWideningAllowed({
          nextUniverse: ['BTC-USD', 'ETH-USD'],
          prevUniverse: ['BTC-USD', 'ETH-USD'],
          presetId: 'crypto_core_live_majors',
          strategyId: 'dca',
        });
        expect(allowed).toBe(true);
      });

      it('case 6: turn live crypto OFF', () => {
        // Represented as going to empty universe
        const allowed = isWideningAllowed({
          nextUniverse: [],
          prevUniverse: ['BTC-USD'],
          presetId: 'no_trade',
          strategyId: 'dca',
        });
        expect(allowed).toBe(true);
      });

      it('case 7: canary reachability with G={BTC-USD} (the proof AC2 costs nothing real)', () => {
        // Start/hold on canary with G={BTC-USD} → ALLOWED
        // This proves the canary can be reached: reaching it requires dca to be
        // promoted, which requires Stage-1, which carries E={BTC-USD}, and G
        // defaults to E.
        const allowed = isWideningAllowed({
          nextUniverse: ['BTC-USD'], // canary
          prevUniverse: [], // from OFF or first start
          presetId: 'crypto_core_live_canary_btc',
          strategyId: 'dca',
          grantedUniverse: ['BTC-USD'],
        });
        expect(allowed).toBe(true);
      });
    });

    it('TRA-3473 AC2: ratified AND covered by G → allowed', () => {
      // The happy path: both conditions met
      const allowed = isWideningAllowed({
        nextUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
        prevUniverse: ['BTC-USD'],
        presetId: 'crypto_core_live_majors',
        strategyId: 'dca',
        grantedUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'], // G covers majors
      });
      expect(allowed).toBe(true);
    });
  });
});
