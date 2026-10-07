import { describe, it, expect } from 'vitest';
import type { OptionChainRow } from '@trading-app/engine';
import { blackScholesPrice } from '@trading-app/engine';
import {
  EMPTY_STATE,
  assessCoreAccountFit,
  closeLimitDebit,
  decideCoreExit,
  pickCoreExpiration,
  planCoreEntry,
  putAbsDelta,
  summarizeCorePaper,
  weekdaysBetween,
  type CorePaperPosition,
  type CorePaperState,
} from './core-paper.js';

const NOW = Date.parse('2026-10-06T19:30:00Z'); // Tue 15:30 ET
const EXP = '2026-11-10'; // ~35 DTE
const SPOT = 670;

function putChain(iv = 0.18): OptionChainRow[] {
  const rows: OptionChainRow[] = [];
  const T = (Date.parse(`${EXP}T00:00:00Z`) - NOW) / 86_400_000 / 365;
  for (let k = 560; k <= 680; k += 1) {
    // A little skew so lower strikes carry more vol, like the real surface.
    const vol = iv + (SPOT - k) * 0.0015;
    const fair = blackScholesPrice({ spot: SPOT, strike: k, timeToExpiryYears: T, riskFreeRate: 0.04, volatility: Math.max(0.05, vol), optionType: 'put' });
    if (fair < 0.05) continue;
    rows.push({
      optionSymbol: `SPY261110P${String(k * 1000).padStart(8, '0')}`, underlying: 'SPY', optionType: 'put',
      strike: k, expiration: EXP, bid: Math.round((fair - 0.01) * 100) / 100, ask: Math.round((fair + 0.01) * 100) / 100,
      openInterest: 5000, volume: 100,
    });
  }
  return rows;
}

describe('pickCoreExpiration', () => {
  it('takes the listing nearest 35 DTE inside [28, 45]', () => {
    expect(pickCoreExpiration(['2026-10-16', '2026-11-06', '2026-11-13', '2026-12-18'], NOW)).toBe('2026-11-13');
    expect(pickCoreExpiration(['2026-10-16', '2026-12-31'], NOW)).toBeNull();
  });
});

describe('weekdaysBetween', () => {
  it('counts weekdays after the start day', () => {
    const fri = Date.parse('2026-10-02T19:30:00Z');
    expect(weekdaysBetween(fri, NOW)).toBe(2); // Mon, Tue
  });
});

describe('planCoreEntry', () => {
  it('picks the first strike at or below 16Δ and the strike $5 below it', () => {
    const r = planCoreEntry({ state: EMPTY_STATE, expiration: EXP, chain: putChain(), spot: SPOT, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.shortDelta).toBeLessThanOrEqual(0.16);
    expect(r.plan.long.strike).toBe(r.plan.short.strike - 5);
    // One strike nearer the money must be above 16Δ — i.e. this is the FIRST one.
    const above = putChain().find((c) => c.strike === r.plan.short.strike + 1)!;
    expect(putAbsDelta(above, SPOT, NOW, 0.04)!.absDelta).toBeGreaterThan(0.16);
    expect(r.plan.limitCredit).toBeLessThanOrEqual(r.plan.midCredit);
    expect(r.plan.limitCredit).toBeGreaterThanOrEqual(r.plan.naturalCredit - 1e-9);
  });

  it('respects max open and the 5-trading-day cadence', () => {
    const open = (id: string): CorePaperPosition => ({
      id, underlying: 'SPY', expiration: EXP, shortSymbol: 'a', longSymbol: 'b', shortStrike: 640, longStrike: 635,
      modelCredit: 1, limitCredit: 1, fillCredit: 1, openOrderId: '1', closeOrderId: null, closeReason: null,
      closeDebit: null, status: 'open', openedAt: 0, closedAt: null,
    });
    const full: CorePaperState = { version: 1, positions: [open('1'), open('2')], lastEntryAt: null };
    expect(planCoreEntry({ state: full, expiration: EXP, chain: putChain(), spot: SPOT, now: NOW })).toMatchObject({ ok: false, reason: 'max_open' });
    const recent: CorePaperState = { version: 1, positions: [], lastEntryAt: NOW - 2 * 86_400_000 };
    expect(planCoreEntry({ state: recent, expiration: EXP, chain: putChain(), spot: SPOT, now: NOW })).toMatchObject({ ok: false, reason: 'cadence' });
  });

  it('refuses a missing wing and a too-small credit', () => {
    const chain = putChain();
    const r0 = planCoreEntry({ state: EMPTY_STATE, expiration: EXP, chain, spot: SPOT, now: NOW });
    if (!r0.ok) throw new Error('fixture');
    const noWing = chain.filter((c) => c.strike !== r0.plan.short.strike - 5);
    expect(planCoreEntry({ state: EMPTY_STATE, expiration: EXP, chain: noWing, spot: SPOT, now: NOW }))
      .toMatchObject({ ok: false, reason: 'no_long_strike' });
    expect(planCoreEntry({ state: EMPTY_STATE, expiration: EXP, chain, spot: SPOT, now: NOW, minCredit: 99 }))
      .toMatchObject({ ok: false, reason: 'credit_too_small' });
  });
});

describe('decideCoreExit', () => {
  const p = { expiration: EXP, fillCredit: 1.0, modelCredit: 1.0 };
  it('50% take profit, 2× stop, 21-DTE exit, else hold', () => {
    expect(decideCoreExit(p, 0.5, NOW)).toBe('take_profit');
    expect(decideCoreExit(p, 3.0, NOW)).toBe('stop_loss');
    expect(decideCoreExit(p, 0.9, NOW)).toBeNull();
    expect(decideCoreExit(p, 0.9, Date.parse('2026-10-21T19:30:00Z'))).toBe('time_exit');
  });
  it('stop pays up to the natural', () => {
    expect(closeLimitDebit(3.0, 3.2, 'stop_loss')).toBe(3.2);
    expect(closeLimitDebit(0.5, 0.6, 'take_profit')).toBe(0.51);
  });
});

describe('summarizeCorePaper', () => {
  it('scores closed trades against the fill credit', () => {
    const base = {
      underlying: 'SPY', expiration: EXP, shortSymbol: 'a', longSymbol: 'b', shortStrike: 640, longStrike: 635,
      limitCredit: 1, openOrderId: '1', closeOrderId: '2', status: 'closed' as const, openedAt: 0, closedAt: 1,
    };
    const s = summarizeCorePaper({
      version: 1, lastEntryAt: null,
      positions: [
        { ...base, id: 'w', modelCredit: 1.0, fillCredit: 0.98, closeDebit: 0.49, closeReason: 'take_profit' },
        { ...base, id: 'l', modelCredit: 1.0, fillCredit: 1.0, closeDebit: 3.0, closeReason: 'stop_loss' },
      ],
    });
    expect(s.closed).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.totalPnlUsd).toBeCloseTo(49 - 200);
    expect(s.meanEntrySlippage).toBeCloseTo(-0.01);
  });
});

describe('assessCoreAccountFit', () => {
  it('a $400 cash level-2 account is not ready, with every reason named', () => {
    const f = assessCoreAccountFit({ accountType: 'cash', totalEquity: 400, optionLevel: 2 });
    expect(f.verdict).toBe('not_ready');
    expect(f.reasons).toHaveLength(3);
  });
  it('margin, $2k+, level 3 is ready', () => {
    expect(assessCoreAccountFit({ accountType: 'margin', totalEquity: 2500, optionLevel: 3 }).verdict).toBe('ready');
  });
});
