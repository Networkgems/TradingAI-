import { describe, it, expect } from 'vitest';
import type { OptionPosition } from '@trading-app/shared';
import { computePortfolioGreeks } from './portfolio-greeks.js';

// Fixed clock + ~35-DTE expiry so the BS solve is deterministic across runs.
const NOW = Date.parse('2026-01-01T15:00:00Z');
const EXP = '2026-02-05';

function mkOption(over: Partial<OptionPosition>): OptionPosition {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    symbol: 'AAPL',
    optionSymbol: 'AAPL260205C00100000',
    optionType: 'call',
    strike: 100,
    expiration: EXP,
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 3.0,
    currentPremium: 3.44, // ≈ σ 0.30 ATM 35d → IV solves cleanly
    tp1Premium: 4,
    tp1Hit: false,
    stopLossPremium: 2,
    peakPremium: 3.44,
    trailingActive: false,
    trailingStopPremium: 3.6,
    underlyingEntryPrice: 100,
    openedAt: NOW,
    signalType: 'relative_value',
    mode: 'demo',
    ...over,
  } as OptionPosition;
}

const spot = (prices: Record<string, number>) => (s: string) => prices[s.toUpperCase()];

describe('computePortfolioGreeks', () => {
  it('returns a zeroed rollup for an empty book', () => {
    const g = computePortfolioGreeks([], spot({}), { now: NOW });
    expect(g.positionsTotal).toBe(0);
    expect(g.positionsValued).toBe(0);
    expect(g.netDelta).toBe(0);
    expect(g.netNotional).toBe(0);
    expect(g.byName).toEqual([]);
    expect(g.bySector).toEqual([]);
  });

  it('nets a single long call into positive delta/gamma/vega and negative theta', () => {
    const pos = mkOption({ symbol: 'AAPL', strike: 100 });
    const g = computePortfolioGreeks([pos], spot({ AAPL: 100 }), { now: NOW });
    expect(g.positionsTotal).toBe(1);
    expect(g.positionsValued).toBe(1);
    // 2 contracts × 100 shares, ATM delta ~0.55 → ~110 equivalent shares.
    expect(g.netDelta).toBeGreaterThan(50);
    expect(g.netGamma).toBeGreaterThan(0);
    expect(g.netVega).toBeGreaterThan(0);
    expect(g.thetaDollarsPerDay).toBeLessThan(0); // long premium bleeds theta
    // notional = currentPremium 3.44 × 2 × 100 = 688.
    expect(g.netNotional).toBeCloseTo(688, 2);
    expect(g.byName[0]!.key).toBe('AAPL');
    expect(g.bySector[0]!.key).toBe('Technology');
  });

  it('TRA-931: falls back to underlyingEntryPrice when the live spot resolver is blind', () => {
    // SPCX-style: off-watchlist underlying never enters the quote tape, so the
    // resolver returns nothing — but the position persisted an entry spot, so
    // Greeks are still valued rather than reading a blind 0.
    const pos = mkOption({ symbol: 'SPCX', underlyingEntryPrice: 100 });
    const g = computePortfolioGreeks([pos], spot({}), { now: NOW });
    expect(g.positionsTotal).toBe(1);
    expect(g.positionsValued).toBe(1);
    expect(g.netDelta).toBeGreaterThan(0);
    expect(g.netVega).toBeGreaterThan(0);
    expect(g.greeksUnvaluedReasons).toBeUndefined();
  });

  it('TRA-931: counts no_spot only when neither the resolver nor an entry price prices it', () => {
    const pos = mkOption({ symbol: 'SPCX', underlyingEntryPrice: 0 });
    const g = computePortfolioGreeks([pos], spot({}), { now: NOW });
    expect(g.positionsTotal).toBe(1);
    expect(g.positionsValued).toBe(0);
    expect(g.netDelta).toBe(0);
    expect(g.netNotional).toBeCloseTo(688, 2);
    expect(g.greeksUnvaluedReasons).toEqual({ no_spot: 1 });
  });

  it('TRA-931: prefers the live resolver over the entry-price fallback when both exist', () => {
    // Entry spot 100 (ATM, delta ~0.55) vs live spot 90 (OTM call, lower delta).
    // The mark still solves at 90 (intrinsic 0 < mark), so the live spot — not
    // the stale entry spot — must drive a strictly smaller delta.
    const atm = mkOption({ symbol: 'AAPL', underlyingEntryPrice: 100 });
    const gEntry = computePortfolioGreeks([atm], spot({}), { now: NOW });
    const gLive = computePortfolioGreeks([atm], spot({ AAPL: 90 }), { now: NOW });
    expect(gEntry.netDelta).toBeGreaterThan(0);
    expect(gLive.netDelta).toBeGreaterThan(0);
    expect(gLive.netDelta).toBeLessThan(gEntry.netDelta);
  });

  it('counts a multi-leg combo as notional-only (capital at risk), no Greeks', () => {
    const combo = mkOption({
      symbol: 'MSFT',
      optionSymbol: 'COMBO:MSFT:bull_put_spread:...',
      premiumPaid: 1.5, // per-share reserved capital
      currentPremium: 1.5,
      contracts: 1,
      contractsRemaining: 1,
      legs: [
        { action: 'sell', optionType: 'put', strike: 400, expiration: EXP } as never,
        { action: 'buy', optionType: 'put', strike: 395, expiration: EXP } as never,
      ],
    });
    const g = computePortfolioGreeks([combo], spot({ MSFT: 410 }), { now: NOW });
    expect(g.positionsTotal).toBe(1);
    expect(g.positionsValued).toBe(0);
    expect(g.netNotional).toBeCloseTo(150, 2); // 1.5 × 1 × 100
    expect(g.bySector[0]!.key).toBe('Technology');
    // TRA-931 — the combo gap is benign, not a spot/IV blind spot.
    expect(g.greeksUnvaluedReasons).toEqual({ multi_leg_combo: 1 });
  });

  it('aggregates allocation by name and sector and sorts by notional desc', () => {
    const aapl = mkOption({ symbol: 'AAPL', currentPremium: 5, contracts: 2, contractsRemaining: 2 }); // 1000
    const msft = mkOption({ symbol: 'MSFT', currentPremium: 3, contracts: 1, contractsRemaining: 1 }); // 300
    const spy = mkOption({ symbol: 'SPY', currentPremium: 2, contracts: 1, contractsRemaining: 1 });   // 200
    const g = computePortfolioGreeks(
      [msft, aapl, spy],
      spot({ AAPL: 100, MSFT: 100, SPY: 100 }),
      { now: NOW },
    );
    expect(g.netNotional).toBeCloseTo(1500, 2);
    // By name: AAPL (1000) > MSFT (300) > SPY (200).
    expect(g.byName.map(b => b.key)).toEqual(['AAPL', 'MSFT', 'SPY']);
    expect(g.byName[0]!.pctOfBook).toBeCloseTo(1000 / 1500, 4);
    // By sector: Technology (AAPL+MSFT = 1300) > Index (SPY = 200).
    expect(g.bySector.map(b => b.key)).toEqual(['Technology', 'Index']);
    expect(g.bySector[0]!.notional).toBeCloseTo(1300, 2);
    expect(g.bySector[0]!.positions).toBe(2);
    // pctOfBook across sectors sums to ~1.
    expect(g.bySector.reduce((s, b) => s + b.pctOfBook, 0)).toBeCloseTo(1, 6);
  });
});
