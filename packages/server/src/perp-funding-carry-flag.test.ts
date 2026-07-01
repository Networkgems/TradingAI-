import { describe, it, expect } from 'vitest';
import {
  isPerpFundingCarryEnabled,
  resolvePerpCarryConfig,
  resolvePerpCarryWatchlist,
  PERP_FUNDING_CARRY_FLAG,
  PERP_CARRY_DEFAULT_MIN_NET_APR,
  PERP_CARRY_DEFAULT_FEE_BPS_ROUNDTRIP,
  PERP_CARRY_DEFAULT_BORROW_APR,
  PERP_CARRY_DEFAULT_WATCHLIST,
} from './perp-funding-carry-flag.js';

// TRA-1216 — the observe-only flag + threshold/watchlist resolution. Invariant #1
// (default OFF ⇒ zero cost/IO) hinges on the flag reading false unless explicitly
// armed, and the resolvers must fall back to the spec defaults for any bad env so
// a fat-finger can't invert the carry math or empty the watchlist.

describe('isPerpFundingCarryEnabled', () => {
  it('is OFF by default (unset env)', () => {
    expect(isPerpFundingCarryEnabled({})).toBe(false);
  });

  it('accepts 1/true/yes/on (case/space-insensitive), rejects everything else', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      expect(isPerpFundingCarryEnabled({ [PERP_FUNDING_CARRY_FLAG]: v })).toBe(true);
    }
    for (const v of ['0', 'false', 'off', 'no', '', 'enabled']) {
      expect(isPerpFundingCarryEnabled({ [PERP_FUNDING_CARRY_FLAG]: v })).toBe(false);
    }
  });
});

describe('resolvePerpCarryConfig', () => {
  it('returns the spec defaults when unset', () => {
    expect(resolvePerpCarryConfig({})).toEqual({
      minNetApr: PERP_CARRY_DEFAULT_MIN_NET_APR,
      feeBpsRoundTrip: PERP_CARRY_DEFAULT_FEE_BPS_ROUNDTRIP,
      borrowApr: PERP_CARRY_DEFAULT_BORROW_APR,
    });
  });

  it('applies valid overrides', () => {
    const cfg = resolvePerpCarryConfig({
      PERP_CARRY_MIN_NET_APR: '0.1',
      PERP_CARRY_FEE_BPS_ROUNDTRIP: '30',
      PERP_CARRY_BORROW_APR: '0.02',
    });
    expect(cfg).toEqual({ minNetApr: 0.1, feeBpsRoundTrip: 30, borrowApr: 0.02 });
  });

  it('falls back to defaults on non-finite / negative env', () => {
    const cfg = resolvePerpCarryConfig({
      PERP_CARRY_MIN_NET_APR: 'abc',
      PERP_CARRY_FEE_BPS_ROUNDTRIP: '-5',
      PERP_CARRY_BORROW_APR: 'NaN',
    });
    expect(cfg).toEqual({
      minNetApr: PERP_CARRY_DEFAULT_MIN_NET_APR,
      feeBpsRoundTrip: PERP_CARRY_DEFAULT_FEE_BPS_ROUNDTRIP,
      borrowApr: PERP_CARRY_DEFAULT_BORROW_APR,
    });
  });
});

describe('resolvePerpCarryWatchlist', () => {
  it('defaults to the liquid INTX majors', () => {
    expect(resolvePerpCarryWatchlist({})).toEqual(PERP_CARRY_DEFAULT_WATCHLIST);
  });

  it('parses, upper-cases, and de-dups a comma/space list', () => {
    expect(
      resolvePerpCarryWatchlist({ PERP_CARRY_WATCHLIST: 'btc-perp-intx, eth-perp-intx  btc-perp-intx' }),
    ).toEqual(['BTC-PERP-INTX', 'ETH-PERP-INTX']);
  });

  it('falls back to defaults on an empty/whitespace override', () => {
    expect(resolvePerpCarryWatchlist({ PERP_CARRY_WATCHLIST: '   ' })).toEqual(
      PERP_CARRY_DEFAULT_WATCHLIST,
    );
  });
});
