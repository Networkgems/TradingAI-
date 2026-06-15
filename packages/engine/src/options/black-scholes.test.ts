import { describe, it, expect } from 'vitest';
import { blackScholesPrice, blackScholesDelta, blackScholesGreeks, daysToExpiration } from './black-scholes.js';

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

describe('blackScholesGreeks', () => {
  // Hull example: S=42, K=40, r=0.10, σ=0.20, T=0.5.
  const base = {
    spot: 42,
    strike: 40,
    timeToExpiryYears: 0.5,
    riskFreeRate: 0.1,
    volatility: 0.2,
  } as const;

  it('matches textbook call Greeks (Hull)', () => {
    const g = blackScholesGreeks({ ...base, optionType: 'call' });
    expect(g.delta).toBeCloseTo(0.7791, 3);
    expect(g.gamma).toBeCloseTo(0.0500, 3);
    // vega per 1.00 vol ≈ 8.81 (≈ 0.0881 per vol point).
    expect(g.vega).toBeCloseTo(8.813, 1);
    // per-year theta (negative for long premium) ≈ -4.56.
    expect(g.theta).toBeCloseTo(-4.56, 1);
  });

  it('keeps put gamma/vega equal to the call and theta less negative', () => {
    const call = blackScholesGreeks({ ...base, optionType: 'call' });
    const put = blackScholesGreeks({ ...base, optionType: 'put' });
    expect(put.gamma).toBeCloseTo(call.gamma, 6);
    expect(put.vega).toBeCloseTo(call.vega, 6);
    expect(put.delta).toBeCloseTo(call.delta - 1, 2);
    // No carry on the put's intrinsic discounting → put theta ≈ -0.75 here.
    expect(put.theta).toBeCloseTo(-0.754, 1);
  });

  it('zeroes the higher-order Greeks at/after expiry (T <= 0)', () => {
    const g = blackScholesGreeks({ ...base, timeToExpiryYears: 0, optionType: 'call' });
    expect(g.gamma).toBe(0);
    expect(g.vega).toBe(0);
    expect(g.theta).toBe(0);
  });
});
