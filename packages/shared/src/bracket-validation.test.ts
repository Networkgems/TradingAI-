import { describe, it, expect } from 'vitest';
import { validateBracket } from './index.js';

// TRA-520 — regression-lock the protective-bracket sanity check that rejects
// the negative / wrong-side stop & target observed on ASTC and PRFX.
describe('validateBracket', () => {
  describe('valid brackets', () => {
    it('accepts a well-formed long (stop < entry < target)', () => {
      expect(validateBracket('buy', 100, 95, 110)).toEqual({ ok: true });
    });

    it('accepts a well-formed short (target < entry < stop)', () => {
      expect(validateBracket('sell', 100, 105, 90)).toEqual({ ok: true });
    });
  });

  describe('non-positive prices', () => {
    it('rejects a non-positive entry', () => {
      expect(validateBracket('buy', 0, -1, 10).ok).toBe(false);
    });

    it('rejects the ASTC case — long with a negative stop', () => {
      const res = validateBracket('buy', 49.5, -0.215, 148.93);
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/stopLoss/);
    });

    it('rejects the PRFX case — short with a negative target', () => {
      const res = validateBracket('sell', 3.05, 4.64, -0.04);
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/takeProfit/);
    });

    it('rejects non-finite values', () => {
      expect(validateBracket('buy', 100, NaN, 110).ok).toBe(false);
      expect(validateBracket('sell', 100, Infinity, 90).ok).toBe(false);
    });
  });

  describe('wrong-side brackets (all prices positive)', () => {
    it('rejects a long stop at/above entry', () => {
      expect(validateBracket('buy', 100, 100, 110).ok).toBe(false);
      expect(validateBracket('buy', 100, 105, 110).ok).toBe(false);
    });

    it('rejects a long target at/below entry', () => {
      expect(validateBracket('buy', 100, 95, 100).ok).toBe(false);
      expect(validateBracket('buy', 100, 95, 90).ok).toBe(false);
    });

    it('rejects a short stop at/below entry', () => {
      expect(validateBracket('sell', 100, 100, 90).ok).toBe(false);
      expect(validateBracket('sell', 100, 95, 90).ok).toBe(false);
    });

    it('rejects a short target at/above entry', () => {
      expect(validateBracket('sell', 100, 105, 100).ok).toBe(false);
      expect(validateBracket('sell', 100, 105, 110).ok).toBe(false);
    });
  });
});
