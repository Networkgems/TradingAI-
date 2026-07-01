import { describe, it, expect } from 'vitest';
import {
  isCryptoRegimeEnabled,
  resolveCryptoRegimeConfig,
  resolveCryptoRegimeWatchlist,
  CRYPTO_REGIME_FLAG,
  CRYPTO_REGIME_DEFAULT_WATCHLIST,
} from './crypto-regime-flag.js';
import { CRYPTO_REGIME_DEFAULTS } from '@trading-app/engine';
import { DEMO_FLAG_ALLOWLIST } from './demo-flags.js';

// TRA-1220 — the observe-only flag + threshold/watchlist resolution. Invariant #1
// (default OFF ⇒ zero cost/IO) hinges on the flag reading false unless armed, and
// the resolvers must fall back to the spec defaults for any bad env so a
// fat-finger can't invert the vote or empty the watchlist.

describe('isCryptoRegimeEnabled', () => {
  it('is OFF by default (unset env)', () => {
    expect(isCryptoRegimeEnabled({})).toBe(false);
  });

  it('accepts 1/true/yes/on (case/space-insensitive), rejects everything else', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      expect(isCryptoRegimeEnabled({ [CRYPTO_REGIME_FLAG]: v })).toBe(true);
    }
    for (const v of ['0', 'false', 'off', 'no', '', 'enabled']) {
      expect(isCryptoRegimeEnabled({ [CRYPTO_REGIME_FLAG]: v })).toBe(false);
    }
  });

  it('is on the DEMO_FLAG_ALLOWLIST for file-override on the self-host', () => {
    expect(DEMO_FLAG_ALLOWLIST).toContain(CRYPTO_REGIME_FLAG);
  });
});

describe('resolveCryptoRegimeConfig', () => {
  it('returns the engine spec defaults when unset', () => {
    expect(resolveCryptoRegimeConfig({})).toEqual(CRYPTO_REGIME_DEFAULTS);
  });

  it('applies valid overrides', () => {
    const cfg = resolveCryptoRegimeConfig({
      CRYPTO_REGIME_ADX_PERIOD: '20',
      CRYPTO_REGIME_ADX_TREND_MIN: '30',
      CRYPTO_REGIME_CHOP_TREND_MAX: '40',
      CRYPTO_REGIME_ER_TREND_MIN: '0.35',
      CRYPTO_REGIME_MIN_TREND_VOTES: '3',
      CRYPTO_REGIME_MIN_BARS: '80',
    });
    expect(cfg.adxPeriod).toBe(20);
    expect(cfg.adxTrendMin).toBe(30);
    expect(cfg.chopTrendMax).toBe(40);
    expect(cfg.erTrendMin).toBe(0.35);
    expect(cfg.minTrendVotes).toBe(3);
    expect(cfg.minBars).toBe(80);
  });

  it('falls back to defaults on non-finite / out-of-range env', () => {
    const cfg = resolveCryptoRegimeConfig({
      CRYPTO_REGIME_ADX_PERIOD: '0', // period must be ≥ 1
      CRYPTO_REGIME_ADX_TREND_MIN: '-5', // negative → invalid
      CRYPTO_REGIME_ER_TREND_MIN: 'abc',
      CRYPTO_REGIME_MIN_TREND_VOTES: '4', // out of 1..3 range
      CRYPTO_REGIME_CHOP_PERIOD: '2.5', // non-integer period
    });
    expect(cfg.adxPeriod).toBe(CRYPTO_REGIME_DEFAULTS.adxPeriod);
    expect(cfg.adxTrendMin).toBe(CRYPTO_REGIME_DEFAULTS.adxTrendMin);
    expect(cfg.erTrendMin).toBe(CRYPTO_REGIME_DEFAULTS.erTrendMin);
    expect(cfg.minTrendVotes).toBe(CRYPTO_REGIME_DEFAULTS.minTrendVotes);
    expect(cfg.chopPeriod).toBe(CRYPTO_REGIME_DEFAULTS.chopPeriod);
  });
});

describe('resolveCryptoRegimeWatchlist', () => {
  it('defaults to the 12 liquid majors (TRA-1211 universe)', () => {
    expect(resolveCryptoRegimeWatchlist({})).toEqual(CRYPTO_REGIME_DEFAULT_WATCHLIST);
    expect(CRYPTO_REGIME_DEFAULT_WATCHLIST).toHaveLength(12);
  });

  it('parses, upper-cases, and de-dups a comma/space list', () => {
    expect(
      resolveCryptoRegimeWatchlist({ CRYPTO_REGIME_WATCHLIST: 'btc-usd, eth-usd  btc-usd' }),
    ).toEqual(['BTC-USD', 'ETH-USD']);
  });

  it('falls back to defaults on an empty/whitespace override', () => {
    expect(resolveCryptoRegimeWatchlist({ CRYPTO_REGIME_WATCHLIST: '   ' })).toEqual(
      CRYPTO_REGIME_DEFAULT_WATCHLIST,
    );
  });
});
