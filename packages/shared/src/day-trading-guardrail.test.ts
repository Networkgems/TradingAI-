// TRA-598 (TRA-595 C3) — the central no-day-trading config + pure decision
// helpers. Proves the documented defaults, the 0DTE/short-dated rejection at
// both idea-gen and order time, and the same-session round-trip block (with the
// next-session close allowed so we never trap a position).
import { describe, it, expect } from 'vitest';
import {
  DAY_TRADING_GUARDRAIL,
  checkEntryDte,
  checkIdeaDte,
  checkDiscretionaryClose,
  checkEquitySwingClose,
  tradingDaysBetween,
  EQUITY_SWING_GUARDRAIL,
  dteFromExpiration,
  isSameSession,
  sessionDayKey,
  type DayTradingGuardrailConfig,
} from './day-trading-guardrail.js';

const NOW = Date.parse('2026-06-08T15:00:00Z'); // a Monday, mid-session

describe('DAY_TRADING_GUARDRAIL defaults', () => {
  it('ships the documented thresholds: 7-day entry floor, 21-day idea floor, no same-session round trips', () => {
    expect(DAY_TRADING_GUARDRAIL.minEntryDteDays).toBe(7);
    expect(DAY_TRADING_GUARDRAIL.minIdeaDteDays).toBe(21);
    expect(DAY_TRADING_GUARDRAIL.blockSameSessionRoundTrip).toBe(true);
    expect(DAY_TRADING_GUARDRAIL.minHoldingPeriodMs).toBe(0);
  });

  it('keeps the entry floor at or below the idea floor (backstop never stricter than idea-gen)', () => {
    expect(DAY_TRADING_GUARDRAIL.minEntryDteDays).toBeLessThanOrEqual(DAY_TRADING_GUARDRAIL.minIdeaDteDays);
  });
});

describe('dteFromExpiration', () => {
  it('counts whole calendar days; same-day expiry is 0DTE', () => {
    expect(dteFromExpiration('2026-06-08', NOW)).toBe(0);
    expect(dteFromExpiration('2026-06-09', NOW)).toBe(1);
    expect(dteFromExpiration('2026-07-17', NOW)).toBe(39);
  });
  it('returns null for an unparseable expiration', () => {
    expect(dteFromExpiration('not-a-date', NOW)).toBeNull();
  });
});

describe('checkEntryDte (order-time floor)', () => {
  it('blocks a 0DTE entry', () => {
    const v = checkEntryDte(0);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/no day trading/i);
  });
  it('blocks a sub-threshold (e.g. 3 DTE) entry', () => {
    expect(checkEntryDte(3).allowed).toBe(false);
  });
  it('allows an entry at or beyond the floor', () => {
    expect(checkEntryDte(7).allowed).toBe(true);
    expect(checkEntryDte(39).allowed).toBe(true);
  });
  it('blocks an entry with no resolvable DTE', () => {
    expect(checkEntryDte(Number.NaN).allowed).toBe(false);
  });
});

describe('checkIdeaDte (idea-gen floor)', () => {
  it('blocks a 0DTE idea and a sub-swing (14 DTE) idea', () => {
    expect(checkIdeaDte(0).allowed).toBe(false);
    expect(checkIdeaDte(14).allowed).toBe(false);
  });
  it('allows a swing-window idea', () => {
    expect(checkIdeaDte(21).allowed).toBe(true);
    expect(checkIdeaDte(45).allowed).toBe(true);
  });
});

describe('checkDiscretionaryClose (same-session round-trip block)', () => {
  it('rejects closing a position opened in the same session', () => {
    const openedAt = Date.parse('2026-06-08T13:35:00Z');
    const closeAt = Date.parse('2026-06-08T19:50:00Z'); // same UTC day
    const v = checkDiscretionaryClose(openedAt, closeAt);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/no day trading/i);
  });

  it('allows closing on a later session (no trap)', () => {
    const openedAt = Date.parse('2026-06-08T19:50:00Z');
    const closeAt = Date.parse('2026-06-09T13:35:00Z'); // next UTC day
    expect(checkDiscretionaryClose(openedAt, closeAt).allowed).toBe(true);
  });

  it('honors a minimum holding period across sessions when configured', () => {
    const cfg: DayTradingGuardrailConfig = {
      ...DAY_TRADING_GUARDRAIL,
      blockSameSessionRoundTrip: false,
      minHoldingPeriodMs: 60 * 60_000, // 1h
    };
    const openedAt = Date.parse('2026-06-08T23:50:00Z');
    const closeAt = Date.parse('2026-06-09T00:10:00Z'); // 20m later, next UTC day
    expect(checkDiscretionaryClose(openedAt, closeAt, cfg).allowed).toBe(false);
  });

  it('can be disabled by config', () => {
    const cfg: DayTradingGuardrailConfig = { ...DAY_TRADING_GUARDRAIL, blockSameSessionRoundTrip: false };
    const openedAt = Date.parse('2026-06-08T13:35:00Z');
    const closeAt = Date.parse('2026-06-08T19:50:00Z');
    expect(checkDiscretionaryClose(openedAt, closeAt, cfg).allowed).toBe(true);
  });
});

describe('TRA-952 equity swing holding-period floor', () => {
  it('ships the documented defaults: same-session block + 2-trading-day floor', () => {
    expect(EQUITY_SWING_GUARDRAIL.blockSameSessionRoundTrip).toBe(true);
    expect(EQUITY_SWING_GUARDRAIL.minHoldingTradingDays).toBe(2);
  });

  it('counts trading days excluding weekends (Fri-open / Mon-close = 1)', () => {
    const friOpen = Date.parse('2026-06-12T14:00:00Z'); // Friday
    const monClose = Date.parse('2026-06-15T14:00:00Z'); // Monday
    expect(tradingDaysBetween(friOpen, monClose)).toBe(1);
  });

  it('counts a full Mon→Thu hold as 3 trading days', () => {
    const monOpen = Date.parse('2026-06-08T14:00:00Z'); // Monday
    const thuClose = Date.parse('2026-06-11T14:00:00Z'); // Thursday
    expect(tradingDaysBetween(monOpen, thuClose)).toBe(3);
  });

  it('blocks a same-session equity round trip', () => {
    const openedAt = Date.parse('2026-06-08T13:35:00Z');
    const closeAt = Date.parse('2026-06-08T19:50:00Z'); // same UTC day
    const v = checkEquitySwingClose(openedAt, closeAt);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/no day trading/i);
  });

  it('blocks a discretionary close inside the 2-trading-day floor (next-session close)', () => {
    const monOpen = Date.parse('2026-06-08T14:00:00Z'); // Monday
    const tueClose = Date.parse('2026-06-09T14:00:00Z'); // Tuesday — only 1 trading day
    expect(checkEquitySwingClose(monOpen, tueClose).allowed).toBe(false);
  });

  it('allows a close once the 2-trading-day floor is met', () => {
    const monOpen = Date.parse('2026-06-08T14:00:00Z'); // Monday
    const wedClose = Date.parse('2026-06-10T14:00:00Z'); // Wednesday — 2 trading days
    expect(checkEquitySwingClose(monOpen, wedClose).allowed).toBe(true);
  });
});

describe('session helpers', () => {
  it('buckets by UTC calendar day', () => {
    expect(sessionDayKey(NOW)).toBe('2026-06-08');
    expect(isSameSession(NOW, Date.parse('2026-06-08T23:00:00Z'))).toBe(true);
    expect(isSameSession(NOW, Date.parse('2026-06-09T01:00:00Z'))).toBe(false);
  });
});
