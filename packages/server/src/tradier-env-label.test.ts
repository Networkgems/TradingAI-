import { describe, it, expect } from 'vitest';
import { isRecognizedTradierEnvLabel, redactTradierEnvLabel } from './tradier-env-label.js';

describe('tradier-env-label (TRA-2163 credential-leak guard)', () => {
  describe('isRecognizedTradierEnvLabel', () => {
    it('accepts the two known labels', () => {
      expect(isRecognizedTradierEnvLabel('production')).toBe(true);
      expect(isRecognizedTradierEnvLabel('sandbox')).toBe(true);
    });
    it('trims surrounding whitespace before matching', () => {
      expect(isRecognizedTradierEnvLabel('  production  ')).toBe(true);
    });
    it('rejects unset / empty / unknown values', () => {
      expect(isRecognizedTradierEnvLabel(undefined)).toBe(false);
      expect(isRecognizedTradierEnvLabel('')).toBe(false);
      expect(isRecognizedTradierEnvLabel('prod')).toBe(false);
      expect(isRecognizedTradierEnvLabel('PRODUCTION')).toBe(false);
    });
    it('rejects a token-shaped value (the bqb1 misconfiguration)', () => {
      // 28-char opaque token, byte-shape of a real Tradier API token.
      expect(isRecognizedTradierEnvLabel('cvABcd1234EFgh5678IJkl9012MN')).toBe(false);
    });
  });

  describe('redactTradierEnvLabel', () => {
    it('returns null for unset / empty', () => {
      expect(redactTradierEnvLabel(undefined)).toBeNull();
      expect(redactTradierEnvLabel('   ')).toBeNull();
    });
    it('passes through a recognized label verbatim (trimmed)', () => {
      expect(redactTradierEnvLabel('production')).toBe('production');
      expect(redactTradierEnvLabel(' sandbox ')).toBe('sandbox');
    });
    it('NEVER emits a mis-set token — returns the fixed redaction marker', () => {
      const token = 'cvABcd1234EFgh5678IJkl9012MN';
      const out = redactTradierEnvLabel(token);
      expect(out).toBe('<redacted:unrecognized-value>');
      expect(out).not.toContain(token);
    });
    it('redacts any other unrecognized string', () => {
      expect(redactTradierEnvLabel('prod')).toBe('<redacted:unrecognized-value>');
    });
  });
});
