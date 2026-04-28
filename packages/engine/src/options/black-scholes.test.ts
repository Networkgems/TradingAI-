import { describe, it, expect } from 'vitest';
import { blackScholesPrice, blackScholesDelta, daysToExpiration } from './black-scholes.js';

describe('blackScholesPrice', () => {
  it('matches a known textbook ATM call (Hull example)', () => {
    // S=42, K=40, r=0.10, σ=0.20, T=0.5 → ~4.7594 (Hull)
    const price = blackScholesPrice({
      spot: 42,
      strike: 40,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.1,
      volatility: 0.2,
      optionType: 'call',
    });
    expect(price).toBeCloseTo(4.7594, 3);
  });

  it('matches the corresponding put via put-call parity', () => {
    // Same Hull example → put ≈ 0.8086
    const price = blackScholesPrice({
      spot: 42,
      strike: 40,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.1,
      volatility: 0.2,
      optionType: 'put',
    });
    expect(price).toBeCloseTo(0.8086, 3);
  });

  it('returns intrinsic value at expiry', () => {
    expect(
      blackScholesPrice({
        spot: 105,
        strike: 100,
        timeToExpiryYears: 0,
        riskFreeRate: 0.05,
        volatility: 0.3,
        optionType: 'call',
      }),
    ).toBe(5);
    expect(
      blackScholesPrice({
        spot: 95,
        strike: 100,
        timeToExpiryYears: 0,
        riskFreeRate: 0.05,
        volatility: 0.3,
        optionType: 'put',
      }),
    ).toBe(5);
  });

  it('OTM call has lower price than ATM call', () => {
    const atm = blackScholesPrice({
      spot: 100, strike: 100, timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045, volatility: 0.3, optionType: 'call',
    });
    const otm = blackScholesPrice({
      spot: 100, strike: 110, timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045, volatility: 0.3, optionType: 'call',
    });
    expect(otm).toBeLessThan(atm);
    expect(otm).toBeGreaterThan(0);
  });

  it('handles zero volatility by returning discounted intrinsic of the forward', () => {
    const price = blackScholesPrice({
      spot: 100, strike: 100, timeToExpiryYears: 1,
      riskFreeRate: 0.05, volatility: 0, optionType: 'call',
    });
    // forward = 100 * e^0.05 ≈ 105.13 → intrinsic 5.13 → discounted ≈ 4.877
    expect(price).toBeCloseTo(4.877, 2);
  });
});

describe('blackScholesDelta', () => {
  it('ATM call delta is ~0.5', () => {
    const delta = blackScholesDelta({
      spot: 100, strike: 100, timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045, volatility: 0.3, optionType: 'call',
    });
    expect(delta).toBeGreaterThan(0.5);  // slight skew above 0.5 for non-zero r
    expect(delta).toBeLessThan(0.6);
  });

  it('deep OTM put delta approaches 0', () => {
    const delta = blackScholesDelta({
      spot: 100, strike: 50, timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045, volatility: 0.3, optionType: 'put',
    });
    expect(Math.abs(delta)).toBeLessThan(0.01);
  });

  it('deep ITM call delta approaches 1', () => {
    const delta = blackScholesDelta({
      spot: 200, strike: 100, timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045, volatility: 0.3, optionType: 'call',
    });
    expect(delta).toBeGreaterThan(0.99);
  });
});

describe('daysToExpiration', () => {
  it('returns roughly 30 days for an expiry one month out', () => {
    const now = Date.parse('2024-01-15T12:00:00Z');
    const days = daysToExpiration('2024-02-14', now);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('returns 0 for past expirations', () => {
    const now = Date.parse('2024-06-01T00:00:00Z');
    expect(daysToExpiration('2024-01-01', now)).toBe(0);
  });

  it('returns 0 for malformed dates instead of throwing', () => {
    expect(daysToExpiration('not-a-date', Date.now())).toBe(0);
  });
});
