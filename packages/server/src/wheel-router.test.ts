import { describe, it, expect } from 'vitest';
import {
  blackScholesPrice,
  daysToExpiration,
  type OptionChainRow,
} from '@trading-app/engine';
import { scanShortPremiumFromSnapshot, type ShortPremiumScanResult } from './short-premium-scanner.js';
import {
  WHEEL_QUALITY_UNIVERSE,
  DEFAULT_WHEEL_GUARDS,
  isWheelUniverseSymbol,
  selectWheelCsp,
  selectWheelCoveredCall,
  isAtOrPastExpiry,
  planExpirySettlement,
  planLotGuard,
} from './wheel-router.js';

// TRA-1977 — the PURE wheel selector + cycle planner that routes the observe-only
// short-premium scan (TRA-1292) into the TRA-1966/1976 wheel primitives under the
// SHADOW/paper flag. These prove the decision logic in isolation: the routing
// full-pass gate (finite ivRank >= 50, in-universe), CSP/CC leg extraction, the
// cost-basis floor, expiry settlement (assign vs worthless), and the TRA-1322
// tail guards — no account, no engine.

const NOW = Date.parse('2024-01-15T15:00:00Z');
const EXP = '2024-02-15'; // ~31 DTE
const T = daysToExpiration(EXP, NOW) / 365;
const SPOT = 100;
const CALM_CLOSES = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? 0.1 : -0.1));

function row(underlying: string, strike: number, optionType: 'call' | 'put', iv = 0.4): OptionChainRow {
  const mark = blackScholesPrice({
    spot: SPOT,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: 0.045,
    volatility: iv,
    optionType,
  });
  const halfSpread = Math.max(mark * 0.02, 0.01);
  return {
    optionSymbol: `${underlying}${strike}${optionType[0]!.toUpperCase()}`,
    underlying,
    optionType,
    strike,
    expiration: EXP,
    bid: mark - halfSpread,
    ask: mark + halfSpread,
    last: mark,
    volume: 500,
    openInterest: 2000,
    smvVol: iv,
    midIv: iv,
  };
}

function ladder(underlying: string): OptionChainRow[] {
  const strikes = [82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 118];
  return strikes.flatMap((k) => [row(underlying, k, 'put'), row(underlying, k, 'call')]);
}

/** A full-pass in-universe scan result (finite ivRank >= 50, VRP-positive, candidates present). */
function scan(underlying: string, ivRank: number | null): ShortPremiumScanResult {
  return scanShortPremiumFromSnapshot(
    { symbol: underlying, spot: SPOT, expiration: EXP, rows: ladder(underlying) },
    CALM_CLOSES,
    ivRank,
    { now: NOW },
  );
}

describe('wheel-router — universe', () => {
  it('WHEEL_QUALITY_UNIVERSE mirrors the TRA-1322 quality names', () => {
    expect([...WHEEL_QUALITY_UNIVERSE]).toEqual([
      'SPY', 'QQQ', 'DIA', 'IWM', 'XLF', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'AVGO',
    ]);
  });

  it('membership is case-insensitive and rejects off-universe names', () => {
    expect(isWheelUniverseSymbol('aapl')).toBe(true);
    expect(isWheelUniverseSymbol(' NVDA ')).toBe(true);
    expect(isWheelUniverseSymbol('GME')).toBe(false);
  });
});

describe('wheel-router — CSP selection (routing full-pass gate)', () => {
  it('routes the short put leg of the best put-credit-spread on a full pass', () => {
    const csp = selectWheelCsp(scan('AAPL', 60));
    expect(csp).not.toBeNull();
    expect(csp!.symbol).toBe('AAPL');
    expect(csp!.strike).toBeLessThan(SPOT); // OTM put
    expect(csp!.creditPerShare).toBeGreaterThan(0);
    expect(csp!.optionSymbol).toContain('AAPL');
  });

  it('never routes the honest-unknown observe-only case (ivRank null)', () => {
    // The scan still surfaces candidates (observe-only), but routing requires the
    // finite >= 50 full pass — the "live emits only on full pass" half of SHADOW.
    const result = scan('AAPL', null);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(selectWheelCsp(result)).toBeNull();
  });

  it('never routes a sub-floor rank', () => {
    // A finite rank below 50 stands the scan down entirely (no candidates).
    expect(selectWheelCsp(scan('AAPL', 40))).toBeNull();
  });

  it('never routes an off-universe symbol even on a full pass', () => {
    expect(selectWheelCsp(scan('GME', 60))).toBeNull();
  });
});

describe('wheel-router — covered-call selection (cost-basis floor)', () => {
  it('routes the short call leg when its strike clears the cost-basis floor', () => {
    const cc = selectWheelCoveredCall(scan('MSFT', 60), 90);
    expect(cc).not.toBeNull();
    expect(cc!.strike).toBeGreaterThanOrEqual(90);
    expect(cc!.strike).toBeGreaterThan(SPOT); // OTM call
    expect(cc!.creditPerShare).toBeGreaterThan(0);
  });

  it('refuses a call strike below the cost basis (guard #1 — no locked loss)', () => {
    // Floor above every OTM call strike in the ladder → nothing qualifies.
    expect(selectWheelCoveredCall(scan('MSFT', 60), 1_000)).toBeNull();
  });

  it('does not route a covered call on the unknown-rank observe case', () => {
    expect(selectWheelCoveredCall(scan('MSFT', null), 90)).toBeNull();
  });
});

describe('wheel-router — expiry detection & settlement', () => {
  it('is at/past expiry only on or after the expiration day', () => {
    expect(isAtOrPastExpiry(EXP, Date.parse('2024-02-14T15:00:00Z'))).toBe(false);
    expect(isAtOrPastExpiry(EXP, Date.parse('2024-02-15T15:00:00Z'))).toBe(true);
    expect(isAtOrPastExpiry(EXP, Date.parse('2024-02-20T15:00:00Z'))).toBe(true);
    expect(isAtOrPastExpiry('not-a-date', NOW)).toBe(false);
  });

  it('assigns an ITM cash-secured put, expires an OTM one worthless', () => {
    expect(planExpirySettlement('cash_secured_put', 95, 90)).toEqual({ kind: 'assigned' });
    expect(planExpirySettlement('cash_secured_put', 95, 100)).toEqual({ kind: 'expired_worthless' });
    // ATM is treated as OTM (strict inequality, matches the backtest).
    expect(planExpirySettlement('cash_secured_put', 95, 95)).toEqual({ kind: 'expired_worthless' });
  });

  it('calls away an ITM covered call, expires an OTM one worthless', () => {
    expect(planExpirySettlement('covered_call', 105, 110)).toEqual({ kind: 'assigned' });
    expect(planExpirySettlement('covered_call', 105, 100)).toEqual({ kind: 'expired_worthless' });
    expect(planExpirySettlement('covered_call', 105, 105)).toEqual({ kind: 'expired_worthless' });
  });
});

describe('wheel-router — tail guards (TRA-1322)', () => {
  const lot = (over: Partial<{ costBasisPerShare: number; ccCount: number; hasOpenCoveredCall: boolean }> = {}) => ({
    costBasisPerShare: 100,
    ccCount: 0,
    hasOpenCoveredCall: false,
    ...over,
  });

  it('stock-stop fires when spot falls to/through cost basis · (1 − 15%)', () => {
    expect(planLotGuard(lot(), 85, DEFAULT_WHEEL_GUARDS)).toBe('stock_stop'); // exactly at floor
    expect(planLotGuard(lot(), 84, DEFAULT_WHEEL_GUARDS)).toBe('stock_stop');
    expect(planLotGuard(lot(), 86, DEFAULT_WHEEL_GUARDS)).toBeNull();
  });

  it('stock-stop needs a finite positive mark to engage', () => {
    expect(planLotGuard(lot(), Number.NaN, DEFAULT_WHEEL_GUARDS)).toBeNull();
    expect(planLotGuard(lot(), 0, DEFAULT_WHEEL_GUARDS)).toBeNull();
  });

  it('max-window liquidation fires only after the cycle cap with no open call', () => {
    expect(planLotGuard(lot({ ccCount: 3 }), 100, DEFAULT_WHEEL_GUARDS)).toBe('max_window_liquidation');
    expect(planLotGuard(lot({ ccCount: 2 }), 100, DEFAULT_WHEEL_GUARDS)).toBeNull();
    // A call still open against the lot defers the max-window liquidation.
    expect(planLotGuard(lot({ ccCount: 3, hasOpenCoveredCall: true }), 100, DEFAULT_WHEEL_GUARDS)).toBeNull();
  });

  it('the stock-stop takes priority over the max-window guard', () => {
    expect(planLotGuard(lot({ ccCount: 3 }), 80, DEFAULT_WHEEL_GUARDS)).toBe('stock_stop');
  });
});
