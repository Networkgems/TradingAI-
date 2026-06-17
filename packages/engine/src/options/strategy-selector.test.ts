import { describe, it, expect } from 'vitest';
import {
  selectStrategyKind,
  selectShadowOptionSignal,
  isLiquid,
  DEFAULT_SELECTOR_PARAMS,
  type ContractQuote,
  type OptionTrend,
  type StrategySelectorInput,
} from './strategy-selector.js';

// ---------------------------------------------------------------------------
// 1. Gate matrix (IVR × trend × breakout → structure). The acceptance-critical
//    artifact: every cell of the decision table is pinned here.
// ---------------------------------------------------------------------------

describe('selectStrategyKind (gate matrix)', () => {
  it('stands down when IV-rank is unknown (null / NaN)', () => {
    expect(selectStrategyKind(null, 'up', true).kind).toBe('stand_down');
    expect(selectStrategyKind(NaN, 'up', true).kind).toBe('stand_down');
  });

  describe('high IVR (>= 50) → short premium by trend', () => {
    it('trend up → bull put spread', () => {
      expect(selectStrategyKind(50, 'up', false).kind).toBe('bull_put_spread');
      expect(selectStrategyKind(85, 'up', false).kind).toBe('bull_put_spread');
    });
    it('trend down → bear call spread', () => {
      expect(selectStrategyKind(50, 'down', false).kind).toBe('bear_call_spread');
      expect(selectStrategyKind(72, 'down', false).kind).toBe('bear_call_spread');
    });
    it('range-bound → iron condor', () => {
      expect(selectStrategyKind(60, 'range', false).kind).toBe('iron_condor');
    });
    it('short-premium ignores the breakout flag', () => {
      expect(selectStrategyKind(80, 'up', true).kind).toBe('bull_put_spread');
    });
  });

  describe('low IVR (<= 25) → debit spread only on a breakout', () => {
    it('breakout → debit spread', () => {
      expect(selectStrategyKind(25, 'up', true).kind).toBe('debit_spread');
      expect(selectStrategyKind(10, 'down', true).kind).toBe('debit_spread');
    });
    it('no breakout → stand down', () => {
      expect(selectStrategyKind(25, 'up', false).kind).toBe('stand_down');
      expect(selectStrategyKind(10, 'range', false).kind).toBe('stand_down');
    });
  });

  describe('mid IVR dead-zone (25 < IVR < 50) → stand down', () => {
    it('stands down regardless of trend or breakout', () => {
      const trends: OptionTrend[] = ['up', 'down', 'range'];
      for (const t of trends) {
        expect(selectStrategyKind(26, t, false).kind).toBe('stand_down');
        expect(selectStrategyKind(49, t, true).kind).toBe('stand_down');
      }
    });
  });

  it('respects custom IVR thresholds', () => {
    const p = { ...DEFAULT_SELECTOR_PARAMS, shortPremiumMinIvr: 70, longPremiumMaxIvr: 15 };
    expect(selectStrategyKind(60, 'up', false, p).kind).toBe('stand_down'); // below 70
    expect(selectStrategyKind(70, 'up', false, p).kind).toBe('bull_put_spread');
    expect(selectStrategyKind(15, 'up', true, p).kind).toBe('debit_spread');
    expect(selectStrategyKind(16, 'up', true, p).kind).toBe('stand_down');
  });
});

// ---------------------------------------------------------------------------
// 2. Liquidity filter (mandatory)
// ---------------------------------------------------------------------------

function quote(over: Partial<ContractQuote>): ContractQuote {
  return {
    optionSymbol: 'X',
    optionType: 'put',
    strike: 100,
    delta: -0.23,
    bid: 1.0,
    ask: 1.05,
    openInterest: 1000,
    ...over,
  };
}

describe('isLiquid', () => {
  it('passes a tight-spread, high-OI contract', () => {
    expect(isLiquid(quote({}))).toBe(true);
  });
  it('rejects thin open interest', () => {
    expect(isLiquid(quote({ openInterest: 10 }))).toBe(false);
  });
  it('rejects a wide bid/ask spread', () => {
    expect(isLiquid(quote({ bid: 1.0, ask: 1.4 }))).toBe(false); // 36% > 10%
  });
  it('rejects a contract with no two-sided market', () => {
    expect(isLiquid(quote({ bid: 0, ask: 1.0 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Full selector — structure construction, gates, and the no-route invariant
// ---------------------------------------------------------------------------

/**
 * A dense, liquid chain of calls + puts in $1 strikes around `spot`, priced with
 * intrinsic value + a flat time premium so marks are monotone in moneyness
 * (closer-to-money strikes are worth more) and verticals net a real credit/debit.
 */
function chain(spot: number): ContractQuote[] {
  const rows: ContractQuote[] = [];
  const liquid = (mid: number) => ({ bid: mid * 0.98, ask: mid * 1.02, openInterest: 1000 });
  // Extrinsic value peaks ATM and decays with distance from the money, so a
  // closer-to-money short leg is always richer than its further-OTM long wing.
  const extrinsic = (k: number) => Math.max(0.3, 2.0 - 0.08 * Math.abs(k - spot));
  for (let k = spot - 20; k <= spot + 20; k += 1) {
    // crude monotone delta proxy: |delta| shrinks as strike moves OTM.
    const callDelta = Math.max(0.02, Math.min(0.98, 0.5 - (k - spot) * 0.04));
    const putDelta = -Math.max(0.02, Math.min(0.98, 0.5 + (k - spot) * 0.04));
    const callMid = Math.max(spot - k, 0) + extrinsic(k);
    const putMid = Math.max(k - spot, 0) + extrinsic(k);
    rows.push({ optionSymbol: `C${k}`, optionType: 'call', strike: k, delta: callDelta, ...liquid(callMid) });
    rows.push({ optionSymbol: `P${k}`, optionType: 'put', strike: k, delta: putDelta, ...liquid(putMid) });
  }
  return rows;
}

function baseInput(over: Partial<StrategySelectorInput>): StrategySelectorInput {
  const spot = 100;
  return {
    symbol: 'SPY',
    spot,
    ivRank: 60,
    trend: 'up',
    highConvictionBreakout: false,
    atr: 3,
    support: 96,
    resistance: 104,
    expiration: '2026-08-21',
    daysToExpiry: 38,
    contracts: chain(spot),
    earningsBeforeExpiry: false,
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

describe('selectShadowOptionSignal', () => {
  it('stands down when the gate matrix says no (no emit)', () => {
    const r = selectShadowOptionSignal(baseInput({ ivRank: 35 }));
    expect(r.decision).toBe('stand_down');
  });

  it('builds a bull put spread (high IVR, trend up): sell + buy puts, defined risk', () => {
    const r = selectShadowOptionSignal(baseInput({ ivRank: 60, trend: 'up' }));
    expect(r.decision).toBe('signal');
    if (r.decision !== 'signal') return;
    expect(r.signal.strategy).toBe('bull_put_spread');
    expect(r.signal.legs).toHaveLength(2);
    expect(r.signal.legs.every((l) => l.optionType === 'put')).toBe(true);
    expect(r.signal.legs.find((l) => l.action === 'sell')).toBeTruthy();
    expect(r.signal.legs.find((l) => l.action === 'buy')).toBeTruthy();
    // short strike sits above the protective long strike for a put credit spread
    const short = r.signal.legs.find((l) => l.action === 'sell')!;
    const long = r.signal.legs.find((l) => l.action === 'buy')!;
    expect(short.strike).toBeGreaterThan(long.strike);
    // short delta inside the 16–30 band
    expect(r.signal.shortDelta!).toBeGreaterThanOrEqual(0.16);
    expect(r.signal.shortDelta!).toBeLessThanOrEqual(0.3);
    expect(r.signal.netCredit!).toBeGreaterThan(0);
    expect(r.signal.sizingIntent.maxLossPerSpread).toBeGreaterThan(0);
  });

  it('builds a bear call spread (high IVR, trend down)', () => {
    const r = selectShadowOptionSignal(baseInput({ ivRank: 60, trend: 'down' }));
    expect(r.decision).toBe('signal');
    if (r.decision !== 'signal') return;
    expect(r.signal.strategy).toBe('bear_call_spread');
    expect(r.signal.legs.every((l) => l.optionType === 'call')).toBe(true);
    const short = r.signal.legs.find((l) => l.action === 'sell')!;
    const long = r.signal.legs.find((l) => l.action === 'buy')!;
    expect(short.strike).toBeLessThan(long.strike);
  });

  it('builds an iron condor (high IVR, range): four legs, both types', () => {
    const r = selectShadowOptionSignal(baseInput({ ivRank: 60, trend: 'range' }));
    expect(r.decision).toBe('signal');
    if (r.decision !== 'signal') return;
    expect(r.signal.strategy).toBe('iron_condor');
    expect(r.signal.legs).toHaveLength(4);
    expect(r.signal.legs.some((l) => l.optionType === 'put')).toBe(true);
    expect(r.signal.legs.some((l) => l.optionType === 'call')).toBe(true);
    expect(r.signal.netCredit!).toBeGreaterThan(0);
  });

  it('builds a debit spread (low IVR + breakout, trend up): net debit > 0', () => {
    const r = selectShadowOptionSignal(baseInput({ ivRank: 20, trend: 'up', highConvictionBreakout: true }));
    expect(r.decision).toBe('signal');
    if (r.decision !== 'signal') return;
    expect(r.signal.strategy).toBe('debit_spread');
    expect(r.signal.legs.every((l) => l.optionType === 'call')).toBe(true);
    expect(r.signal.netDebit!).toBeGreaterThan(0);
    expect(r.signal.netCredit).toBeNull();
  });

  it('hard-gates a new short under the min-DTE floor', () => {
    const r = selectShadowOptionSignal(baseInput({ ivRank: 60, trend: 'up', daysToExpiry: 18 }));
    expect(r.decision).toBe('no_structure');
    expect(r.kind).toBe('bull_put_spread');
  });

  it('rejects DTE outside the 30–45 entry window', () => {
    expect(selectShadowOptionSignal(baseInput({ daysToExpiry: 60 })).decision).toBe('no_structure');
    expect(selectShadowOptionSignal(baseInput({ daysToExpiry: 28 })).decision).toBe('no_structure');
  });

  it('blocks LONG premium through earnings (hard gate), but not short premium', () => {
    const longThruEarnings = selectShadowOptionSignal(
      baseInput({ ivRank: 20, trend: 'up', highConvictionBreakout: true, earningsBeforeExpiry: true }),
    );
    expect(longThruEarnings.decision).toBe('no_structure');
    // a short-premium structure is NOT blocked by the long-premium earnings gate
    const shortThruEarnings = selectShadowOptionSignal(
      baseInput({ ivRank: 60, trend: 'up', earningsBeforeExpiry: true }),
    );
    expect(shortThruEarnings.decision).toBe('signal');
  });

  it('returns no_structure (never throws / never routes) when the chain is illiquid', () => {
    const illiquid = chain(100).map((c) => ({ ...c, openInterest: 5 }));
    const r = selectShadowOptionSignal(baseInput({ contracts: illiquid }));
    expect(r.decision).toBe('no_structure');
  });

  it('returns no_structure when ATR is unavailable', () => {
    const r = selectShadowOptionSignal(baseInput({ atr: 0 }));
    expect(r.decision).toBe('no_structure');
  });

  it('produces only plain data — no order side effects (shadow invariant)', () => {
    const r = selectShadowOptionSignal(baseInput({ ivRank: 60, trend: 'up' }));
    // The result is a serialisable plain object; there is no execution handle.
    expect(() => JSON.stringify(r)).not.toThrow();
    expect(r.decision === 'signal' ? 'strategy' in r.signal : true).toBe(true);
  });
});
