import { describe, expect, it } from 'vitest';
import {
  validateCloseQty,
  validateEmail,
  validateLimitPrice,
  validatePassword,
  validatePasswordConfirm,
} from './validation';

describe('validateEmail', () => {
  it('rejects an empty value', () => {
    expect(validateEmail('   ')).toBe('Email is required.');
  });

  it('rejects a malformed address', () => {
    expect(validateEmail('not-an-email')).toBe('Enter a valid email address.');
    expect(validateEmail('a@b')).toBe('Enter a valid email address.');
    expect(validateEmail('a b@c.com')).toBe('Enter a valid email address.');
  });

  it('accepts a well-formed address', () => {
    expect(validateEmail('trader@example.com')).toBeNull();
    expect(validateEmail('  trader@example.co.uk  ')).toBeNull();
  });
});

describe('validatePassword', () => {
  it('rejects an empty password', () => {
    expect(validatePassword('')).toBe('Password is required.');
  });

  it('accepts any non-empty password when not requiring strength', () => {
    expect(validatePassword('short')).toBeNull();
  });

  it('enforces the 8-character minimum when requireStrong is set', () => {
    expect(validatePassword('short', true)).toBe('Password must be at least 8 characters.');
    expect(validatePassword('longenough', true)).toBeNull();
  });
});

describe('validatePasswordConfirm', () => {
  it('rejects an empty confirmation', () => {
    expect(validatePasswordConfirm('secret123', '')).toBe('Please confirm your password.');
  });

  it('rejects a mismatch', () => {
    expect(validatePasswordConfirm('secret123', 'secret124')).toBe('Passwords do not match.');
  });

  it('accepts a match', () => {
    expect(validatePasswordConfirm('secret123', 'secret123')).toBeNull();
  });
});

describe('validateLimitPrice', () => {
  it('rejects empty, zero, negative and non-numeric prices', () => {
    expect(validateLimitPrice('')).toBe('Limit price must be greater than 0.');
    expect(validateLimitPrice('0')).toBe('Limit price must be greater than 0.');
    expect(validateLimitPrice('-1.5')).toBe('Limit price must be greater than 0.');
    expect(validateLimitPrice('abc')).toBe('Limit price must be greater than 0.');
  });

  it('accepts a positive price', () => {
    expect(validateLimitPrice('1.25')).toBeNull();
  });
});

describe('validateCloseQty', () => {
  it('rejects values outside 1..contractsRemaining', () => {
    expect(validateCloseQty('0', 5)).toBe('Qty must be between 1 and 5.');
    expect(validateCloseQty('6', 5)).toBe('Qty must be between 1 and 5.');
    expect(validateCloseQty('', 5)).toBe('Qty must be between 1 and 5.');
  });

  it('rejects fractional quantities', () => {
    expect(validateCloseQty('2.5', 5)).toBe('Qty must be between 1 and 5.');
  });

  it('accepts a whole number within range', () => {
    expect(validateCloseQty('1', 5)).toBeNull();
    expect(validateCloseQty('5', 5)).toBeNull();
  });
});
