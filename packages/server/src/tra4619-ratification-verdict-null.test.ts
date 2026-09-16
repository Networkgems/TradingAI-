// TRA-4619 (ruling B on TRA-4606) — the UNKNOWN ratification verdict renders as
// `null`, not the string `'unstamped'`.
//
// ── WHY THIS FILE EXISTS, AND WHY IT ASSERTS Boolean() ───────────────────────
// The bug was never the VALUE, it was the TRUTHINESS. `'unstamped'` is a
// non-empty string, so every one of these passed against the defective build:
//
//     expect(s.matchesLive).toBe('unstamped');       // passed
//     expect(s.matchesLive).not.toBe(true);          // passed
//     expect(s.matchesLive).not.toBe(false);         // passed
//
// …while `if (s.matchesLive) { /* authorized */ }` PASSED ON AN UNSTAMPED BAR and
// `if (!s.matchesLive) { /* alarm */ }` silently SKIPPED it. The published `note`
// said "This is NOT a pass" in English while the field said the opposite in
// JavaScript. A test suite that only ever asserts the value is therefore BLIND to
// the entire defect — which is why every unstamped branch below asserts
// `Boolean(...)` and an actual `? :` branch, not just the value.
//
// `resolveLiveOtmUniverseRatification` / `resolveNumericRatification` are PURE
// (env is an argument), so these are real reads of the shipped functions rather
// than assertions against a local copy of the literal.

import { describe, expect, it } from 'vitest';

import {
  foldRatificationVerdicts,
  resolveLiveOtmUniverseRatification,
  resolveNumericRatification,
  type RatificationVerdict,
} from './ratification-stamp.js';

const LIVE_UNIVERSE = { restricted: true, symbols: ['AAPL', 'SPY'] as const };

describe('TRA-4619 — an UNSTAMPED ratification verdict is null, and null is FALSY', () => {
  describe('resolveLiveOtmUniverseRatification (the universe stamp)', () => {
    it('renders null on an ABSENT var, and it does not authorize', () => {
      const s = resolveLiveOtmUniverseRatification(LIVE_UNIVERSE, {});
      expect(s.matchesLive).toBeNull();
      // ⭐ THE defect. Not implied by the line above.
      expect(Boolean(s.matchesLive)).toBe(false);
      expect(s.matchesLive ? 'AUTHORIZED' : 'NOT-AUTHORIZED').toBe('NOT-AUTHORIZED');
      // …and the `if (!x) alarm` idiom now FIRES rather than skipping.
      expect(!s.matchesLive).toBe(true);
      // AC-4: `reason` is the self-describing token, bijective with `null`.
      expect(s.reason).toBe('unstamped');
      expect(s.note).toMatch(/NOT a pass/);
    });

    it('renders null on a BLANK var — blank is absent, not an empty ratified set', () => {
      const s = resolveLiveOtmUniverseRatification(LIVE_UNIVERSE, {
        OPTION_LIVE_OTM_UNIVERSE_RATIFIED: '   ',
      });
      expect(s.matchesLive).toBeNull();
      expect(Boolean(s.matchesLive)).toBe(false);
      expect(s.reason).toBe('unstamped');
      expect(s.ratifiedSymbols).toBeNull();
    });

    // AC-4 — the two not-`true` states must NOT be folded together.
    it('a SET-but-unparseable stamp stays FALSE with reason `unparseable`, never null', () => {
      const s = resolveLiveOtmUniverseRatification(LIVE_UNIVERSE, {
        OPTION_LIVE_OTM_UNIVERSE_RATIFIED: ',,,',
      });
      expect(s.matchesLive).toBe(false);
      expect(s.matchesLive).not.toBeNull();
      expect(s.reason).toBe('unparseable');
    });

    it('still renders true on a real match — the flip did not break the pass path', () => {
      const s = resolveLiveOtmUniverseRatification(LIVE_UNIVERSE, {
        OPTION_LIVE_OTM_UNIVERSE_RATIFIED: 'SPY, AAPL',
      });
      expect(s.matchesLive).toBe(true);
      expect(s.reason).toBe('match');
    });
  });

  describe('resolveNumericRatification (the cap / margin stamps)', () => {
    const resolve = (env: NodeJS.ProcessEnv) =>
      resolveNumericRatification('CAP_RATIFIED', 'CAP_RATIFIED_BY', 'per-entry cap (USD)', 350, env);

    it('renders null on an ABSENT var, and it does not authorize', () => {
      const s = resolve({});
      expect(s.matchesLive).toBeNull();
      expect(Boolean(s.matchesLive)).toBe(false);
      expect(s.matchesLive ? 'AUTHORIZED' : 'NOT-AUTHORIZED').toBe('NOT-AUTHORIZED');
      expect(!s.matchesLive).toBe(true);
      expect(s.reason).toBe('unstamped');
      expect(s.ratifiedValue).toBeNull();
      expect(s.note).toMatch(/NOT a pass/);
    });

    it('renders null on a BLANK var — not a zero ratified value', () => {
      const s = resolve({ CAP_RATIFIED: '  ' });
      expect(s.matchesLive).toBeNull();
      expect(Boolean(s.matchesLive)).toBe(false);
      expect(s.reason).toBe('unstamped');
      expect(s.ratifiedValue).toBeNull();
    });

    it('a SET-but-non-numeric stamp stays FALSE with reason `unparseable`, never null', () => {
      const s = resolve({ CAP_RATIFIED: 'yes' });
      expect(s.matchesLive).toBe(false);
      expect(s.matchesLive).not.toBeNull();
      expect(s.reason).toBe('unparseable');
    });

    it('still renders true on a real match', () => {
      const s = resolve({ CAP_RATIFIED: '350.00' });
      expect(s.matchesLive).toBe(true);
      expect(s.reason).toBe('match');
    });
  });

  describe('foldRatificationVerdicts — precedence UNCHANGED, empty is null', () => {
    it('an EMPTY input is null: "nothing to check" is not a pass', () => {
      expect(foldRatificationVerdicts([])).toBeNull();
      expect(Boolean(foldRatificationVerdicts([]))).toBe(false);
    });

    it('[true, null] => null — a partial ratification is NOT a pass', () => {
      expect(foldRatificationVerdicts([true, null])).toBeNull();
      expect(Boolean(foldRatificationVerdicts([true, null]))).toBe(false);
    });

    it('[false, null] => FALSE — a real mismatch OUTRANKS an unknown', () => {
      // The precedence assertion. A fold "simplified" into returning the first
      // non-`true` verdict it encounters would return `null` here and demote a
      // live mismatch to an unknown.
      expect(foldRatificationVerdicts([false, null])).toBe(false);
      expect(foldRatificationVerdicts([null, false])).toBe(false);
    });

    it('[true, true] => true — the only input that authorizes', () => {
      expect(foldRatificationVerdicts([true, true])).toBe(true);
      expect(Boolean(foldRatificationVerdicts([true, true]))).toBe(true);
    });

    it('never yields a TRUTHY non-`true` value on any tri-state combination', () => {
      // Exhaustive over the 3^2 pairs plus the singletons and the empty input:
      // the property the defect violated is "truthy ⇒ authorized". Asserted as a
      // property rather than case-by-case so a future fourth state cannot slip a
      // truthy sentinel back in without failing here.
      const states: RatificationVerdict[] = [true, false, null];
      const inputs: RatificationVerdict[][] = [[]];
      for (const a of states) {
        inputs.push([a]);
        for (const b of states) inputs.push([a, b]);
      }
      for (const input of inputs) {
        const out = foldRatificationVerdicts(input);
        // TRUTHINESS FIRST, deliberately. Ordered ahead of the value check so that
        // under a regression THIS is the assertion that fires and names the real
        // defect ("expected true to be false" on a truthy unknown), rather than a
        // value mismatch shadowing it.
        if (out !== true) {
          expect(Boolean(out)).toBe(false);
        }
        expect([true, false, null]).toContain(out);
      }
    });
  });
});
