import { describe, it, expect } from 'vitest';
import type { TradeSignal } from '@trading-app/shared';
import {
  PERP_SHORTS_UNIVERSE,
  PERP_SHORTS_TIER2,
  PERP_SHORT_RISK_TIER1,
  PERP_SHORT_RISK_TIER2,
  PERP_SHORT_SINGLE_SYMBOL_CAP,
  PERP_SHORT_SINGLE_SYMBOL_CAP_MAX,
  resolveSingleSymbolShortCap,
  PERP_SHORT_CROSS_STRATEGY_CAP,
  PERP_SHORT_TOTAL_NOTIONAL_CAP,
  FUNDING_GATE_THRESHOLD_PER_HOUR,
  FUNDING_FLIP_INTERVALS,
  SPREAD_GATE_FRACTION,
  OI_GATE_USD,
  VOL_EXPANSION_ATR_RATIO,
  VOL_EXPANSION_BAR_LOOKBACK,
  DAILY_SHORT_CIRCUIT_BREAKER_PCT,
  MAX_CONCURRENT_SHORTS,
  CONSECUTIVE_LOSS_THRESHOLD,
  CONSECUTIVE_LOSS_COOLDOWN_MS,
  SKIP_NOT_IN_UNIVERSE,
  SKIP_MR_OFF_STRATEGY,
  SKIP_FUNDING_TOO_NEGATIVE,
  SKIP_BTC_TREND_UP,
  SKIP_SPREAD_TOO_WIDE,
  SKIP_OI_UNDER_MIN,
  SKIP_TOTAL_SHORT_NOTIONAL,
  SKIP_SINGLE_SYMBOL_CAP,
  SKIP_CROSS_STRATEGY_CAP,
  SKIP_CONSECUTIVE_LOSSES,
  SKIP_MAX_CONCURRENT_SHORTS,
  SKIP_PARKED_1D_DAILY,
  SKIP_PARKED_4H_LAYER12,
  isPerpShortSymbol,
  isTier2PerpShort,
  perpShortRiskFraction,
  evaluateShortFilters,
  evaluateShortNotionalCaps,
  evaluateShortBookCaps,
  symbolShortCooldownActive,
  fundingFlipStopTriggered,
  adverseVolExpansionShortExitTriggered,
  dailyShortCircuitBreakerTripped,
  type ClosedShortTrade,
} from './perp-shorts.js';

/**
 * TRA-261 acceptance criterion: "All five short filters fire in unit tests
 * with structured skip reasons exactly matching the strings above." The
 * verbatim strings are imported from the module under test so the assertion
 * pins the public contract — a typo on either side fails the test.
 */
function shortSignal(symbol: string, overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'sig-test',
    symbol,
    type: 'momentum',
    side: 'sell',
    entryPrice: 100,
    stopLoss: 102,
    takeProfit: 96,
    riskRewardRatio: 2,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('perp shorts spec wiring (TRA-261)', () => {
  describe('skip-reason strings (TRA-255 §5 contract)', () => {
    // Every public skip-reason is asserted byte-exact so a refactor that
    // touches the constants fails fast before drifting from the spec doc.
    it('mirrors the spec strings verbatim', () => {
      expect(SKIP_NOT_IN_UNIVERSE).toBe('shorts disabled — symbol not in perp universe');
      expect(SKIP_MR_OFF_STRATEGY).toBe('shorts off-strategy');
      expect(SKIP_FUNDING_TOO_NEGATIVE).toBe('funding too negative — squeeze risk');
      expect(SKIP_BTC_TREND_UP).toBe('BTC trend up — alt short blocked');
      expect(SKIP_SPREAD_TOO_WIDE).toBe('spread too wide for perp short');
      expect(SKIP_OI_UNDER_MIN).toBe('perp OI under min');
      expect(SKIP_TOTAL_SHORT_NOTIONAL).toBe('total short notional cap');
      expect(SKIP_SINGLE_SYMBOL_CAP).toBe('single-symbol short cap');
      expect(SKIP_CROSS_STRATEGY_CAP).toBe('cross-strategy per-symbol short cap');
      // TRA-261 / TRA-255 §3.1 / §6 — the two book-wide pre-route gates.
      expect(SKIP_CONSECUTIVE_LOSSES).toBe('3 consecutive short losses — symbol cooldown');
      expect(SKIP_MAX_CONCURRENT_SHORTS).toBe('max 3 concurrent shorts');
      // TRA-255 §8.1 r3 — Phase-1 1D timeframe parked after the TRA-266 sweep.
      expect(SKIP_PARKED_1D_DAILY).toBe('parked — failed §8 daily');
      // TRA-255 §4.4 r6 — 4H Layer 1+2 parked pending Layer 3 cascade-leg trigger.
      expect(SKIP_PARKED_4H_LAYER12).toBe('parked — failed §8 4H Layer 1+2');
    });
  });

  describe('universe (TRA-255 §2 / TRA-343)', () => {
    it('contains the Phase-1 majors plus the TRA-343 Coinbase perp expansion', () => {
      expect(PERP_SHORTS_UNIVERSE).toEqual([
        // Phase-1 Tier-1
        'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD',
        // Phase-1 Tier-2
        'DOGE-USD',
        // TRA-343 Tier-2 expansion (rest of the Coinbase perp catalog)
        'AVAX-USD', 'LINK-USD', 'BCH-USD', 'LTC-USD', 'DOT-USD',
        'SHIB-USD', 'SUI-USD', 'XLM-USD',
      ]);
    });

    it('isPerpShortSymbol matches each universe member and rejects non-perp watchlist symbols', () => {
      for (const sym of PERP_SHORTS_UNIVERSE) expect(isPerpShortSymbol(sym)).toBe(true);
      // APT-USD is a watchlist symbol but Coinbase has no APT-PERP listing —
      // shorts on it must still trip SKIP_NOT_IN_UNIVERSE.
      expect(isPerpShortSymbol('APT-USD')).toBe(false);
      expect(isPerpShortSymbol('ADA-USD')).toBe(false);
    });

    it('Tier-2 covers DOGE plus the TRA-343 expansion; Tier-1 majors are not Tier-2', () => {
      expect(PERP_SHORTS_TIER2).toContain('DOGE-USD');
      expect(isTier2PerpShort('DOGE-USD')).toBe(true);
      // TRA-343 — ship the new perps at conservative Tier-2 sizing.
      for (const sym of ['AVAX-USD', 'LINK-USD', 'BCH-USD', 'LTC-USD', 'DOT-USD', 'SHIB-USD', 'SUI-USD', 'XLM-USD']) {
        expect(isTier2PerpShort(sym)).toBe(true);
      }
      expect(isTier2PerpShort('BTC-USD')).toBe(false);
      expect(isTier2PerpShort('ETH-USD')).toBe(false);
      expect(isTier2PerpShort('SOL-USD')).toBe(false);
      expect(isTier2PerpShort('XRP-USD')).toBe(false);
    });

    it('per-trade risk fraction is halved on Tier-2 vs Tier-1', () => {
      expect(perpShortRiskFraction('BTC-USD')).toBe(PERP_SHORT_RISK_TIER1);
      expect(perpShortRiskFraction('ETH-USD')).toBe(PERP_SHORT_RISK_TIER1);
      expect(perpShortRiskFraction('DOGE-USD')).toBe(PERP_SHORT_RISK_TIER2);
      expect(perpShortRiskFraction('LINK-USD')).toBe(PERP_SHORT_RISK_TIER2);
      expect(PERP_SHORT_RISK_TIER1).toBeCloseTo(0.005, 6);
      expect(PERP_SHORT_RISK_TIER2).toBeCloseTo(0.003, 6);
    });
  });

  describe('evaluateShortFilters — five gates (TRA-255 §5)', () => {
    it('returns null on a clean short (no inputs flag any gate)', () => {
      const sig = shortSignal('BTC-USD');
      expect(evaluateShortFilters(sig, {})).toBeNull();
    });

    it('returns null for a long signal regardless of context', () => {
      const longSig = shortSignal('BTC-USD', { side: 'buy' });
      expect(evaluateShortFilters(longSig, {
        fundingRatePerHour: -0.01, // would trip funding for a short
        btcRegime: 'trend_up',
        spreadFraction: 0.05,
        openInterestUsd: 1,
      })).toBeNull();
    });

    // Filter 1 — funding rate too negative
    it('filter 1: funding too negative emits "funding too negative — squeeze risk"', () => {
      const sig = shortSignal('BTC-USD');
      const reason = evaluateShortFilters(sig, {
        fundingRatePerHour: FUNDING_GATE_THRESHOLD_PER_HOUR - 0.0001,
      });
      expect(reason).toBe(SKIP_FUNDING_TOO_NEGATIVE);
    });

    it('filter 1: funding above threshold passes', () => {
      const sig = shortSignal('BTC-USD');
      const reason = evaluateShortFilters(sig, {
        fundingRatePerHour: FUNDING_GATE_THRESHOLD_PER_HOUR + 0.0001,
      });
      expect(reason).toBeNull();
    });

    // Filter 2 — BTC dominance / regime overlay (alts only)
    it('filter 2: BTC trend_up blocks an alt short with "BTC trend up — alt short blocked"', () => {
      const sig = shortSignal('SOL-USD');
      const reason = evaluateShortFilters(sig, { btcRegime: 'trend_up' });
      expect(reason).toBe(SKIP_BTC_TREND_UP);
    });

    it('filter 2: BTC short itself is NOT blocked when BTC is trend_up', () => {
      const sig = shortSignal('BTC-USD');
      const reason = evaluateShortFilters(sig, { btcRegime: 'trend_up' });
      expect(reason).toBeNull();
    });

    it('filter 2: alt short passes when BTC is range / trend_down / flat', () => {
      const sig = shortSignal('ETH-USD');
      expect(evaluateShortFilters(sig, { btcRegime: 'range' })).toBeNull();
      expect(evaluateShortFilters(sig, { btcRegime: 'trend_down' })).toBeNull();
      expect(evaluateShortFilters(sig, { btcRegime: 'flat' })).toBeNull();
      expect(evaluateShortFilters(sig, { btcRegime: 'high_vol' })).toBeNull();
    });

    // Filter 3 — perp spread > 0.10% mid
    it('filter 3: spread above 0.10% emits "spread too wide for perp short"', () => {
      const sig = shortSignal('BTC-USD');
      const reason = evaluateShortFilters(sig, {
        spreadFraction: SPREAD_GATE_FRACTION + 0.0001,
      });
      expect(reason).toBe(SKIP_SPREAD_TOO_WIDE);
    });

    it('filter 3: spread at-or-below 0.10% passes', () => {
      const sig = shortSignal('BTC-USD');
      expect(evaluateShortFilters(sig, { spreadFraction: SPREAD_GATE_FRACTION })).toBeNull();
      expect(evaluateShortFilters(sig, { spreadFraction: 0 })).toBeNull();
    });

    // Filter 4 — OI < $25M
    it('filter 4: OI below $25M emits "perp OI under min"', () => {
      const sig = shortSignal('BTC-USD');
      const reason = evaluateShortFilters(sig, { openInterestUsd: OI_GATE_USD - 1 });
      expect(reason).toBe(SKIP_OI_UNDER_MIN);
    });

    it('filter 4: OI at-or-above $25M passes', () => {
      const sig = shortSignal('BTC-USD');
      expect(evaluateShortFilters(sig, { openInterestUsd: OI_GATE_USD })).toBeNull();
      expect(evaluateShortFilters(sig, { openInterestUsd: OI_GATE_USD * 10 })).toBeNull();
    });

    // Multiplicative ordering — funding > BTC > spread > OI
    it('priority: funding wins over later gates when multiple would trip', () => {
      const sig = shortSignal('SOL-USD');
      const reason = evaluateShortFilters(sig, {
        fundingRatePerHour: -0.001, // trips funding
        btcRegime: 'trend_up',      // would also trip
        spreadFraction: 0.05,       // would also trip
        openInterestUsd: 1,         // would also trip
      });
      expect(reason).toBe(SKIP_FUNDING_TOO_NEGATIVE);
    });

    it('priority: BTC regime wins over spread+OI when funding passes', () => {
      const sig = shortSignal('SOL-USD');
      const reason = evaluateShortFilters(sig, {
        btcRegime: 'trend_up',
        spreadFraction: 0.05,
        openInterestUsd: 1,
      });
      expect(reason).toBe(SKIP_BTC_TREND_UP);
    });

    it('priority: spread wins over OI when funding+BTC pass', () => {
      const sig = shortSignal('SOL-USD');
      const reason = evaluateShortFilters(sig, {
        spreadFraction: 0.05,
        openInterestUsd: 1,
      });
      expect(reason).toBe(SKIP_SPREAD_TOO_WIDE);
    });

    it('best-effort: missing inputs skip their gate (no blow-up)', () => {
      const sig = shortSignal('BTC-USD');
      // Funding undefined, btcRegime undefined, spread undefined, OI undefined.
      expect(evaluateShortFilters(sig, {})).toBeNull();
    });
  });

  describe('evaluateShortNotionalCaps (TRA-255 §6)', () => {
    const baseInputs = {
      totalEquityUsd: 100_000,
      strategyEquityUsd: 50_000,
      candidateShortNotionalUsd: 1_000,
      openShortsThisStrategyThisSymbolUsd: 0,
      openShortsAllStrategiesThisSymbolUsd: 0,
      openShortsTotalUsd: 0,
    };

    it('returns null when all caps are slack', () => {
      expect(evaluateShortNotionalCaps(baseInputs)).toBeNull();
    });

    // Single-symbol cap: 15% of strategy equity
    it('cap 1: trips single-symbol cap when this strategy + symbol breaches 15% strategy equity', () => {
      const reason = evaluateShortNotionalCaps({
        ...baseInputs,
        // 50k strategy * 0.15 = $7,500 limit. Already 7,000 + 1,000 candidate = 8,000.
        openShortsThisStrategyThisSymbolUsd: 7_000,
        candidateShortNotionalUsd: 1_000,
      });
      expect(reason).toBe(SKIP_SINGLE_SYMBOL_CAP);
    });

    // Cross-strategy cap: 20% of total equity
    it('cap 2: trips cross-strategy cap when all strategies + symbol breaches 20% total equity', () => {
      const reason = evaluateShortNotionalCaps({
        ...baseInputs,
        // 100k total * 0.20 = $20,000 limit. Already 19,500 + 1,000 candidate = 20,500.
        openShortsAllStrategiesThisSymbolUsd: 19_500,
        candidateShortNotionalUsd: 1_000,
      });
      expect(reason).toBe(SKIP_CROSS_STRATEGY_CAP);
    });

    // Total cap: 30% of total equity
    it('cap 3: trips total notional cap when whole-book breaches 30% total equity', () => {
      const reason = evaluateShortNotionalCaps({
        ...baseInputs,
        // 100k total * 0.30 = $30,000 limit. Already 29,500 + 1,000 candidate = 30,500.
        openShortsTotalUsd: 29_500,
        candidateShortNotionalUsd: 1_000,
      });
      expect(reason).toBe(SKIP_TOTAL_SHORT_NOTIONAL);
    });

    it('zero equity short-circuits to null (gate is meaningless without an account)', () => {
      const reason = evaluateShortNotionalCaps({
        ...baseInputs,
        totalEquityUsd: 0,
        strategyEquityUsd: 0,
        openShortsTotalUsd: 1_000_000,
      });
      expect(reason).toBeNull();
    });

    it('cap constants match spec §6: 15% / 20% / 30%', () => {
      expect(PERP_SHORT_SINGLE_SYMBOL_CAP).toBeCloseTo(0.15, 6);
      expect(PERP_SHORT_CROSS_STRATEGY_CAP).toBeCloseTo(0.20, 6);
      expect(PERP_SHORT_TOTAL_NOTIONAL_CAP).toBeCloseTo(0.30, 6);
    });

    // TRA-341 — operator-tunable single-symbol cap. The override widens the
    // per-strategy budget without touching the cross-strategy / total caps.
    describe('singleSymbolCapOverride (TRA-341)', () => {
      it('relaxes the single-symbol gate when override is wider than the default', () => {
        // 50k strategy * 0.15 = $7,500 default — would trip with $7,000 + $1,000.
        // Override at 0.25 → $12,500 limit, so the same candidate passes.
        const reason = evaluateShortNotionalCaps({
          ...baseInputs,
          openShortsThisStrategyThisSymbolUsd: 7_000,
          candidateShortNotionalUsd: 1_000,
          singleSymbolCapOverride: 0.25,
        });
        expect(reason).toBeNull();
      });

      it('still trips when the override is wider but the cross-strategy cap is breached', () => {
        // Override at 1.0 lets single-symbol pass freely, but the cross-strategy
        // cap (20% total = $20,000) still bites at $19,500 + $1,000.
        const reason = evaluateShortNotionalCaps({
          ...baseInputs,
          openShortsAllStrategiesThisSymbolUsd: 19_500,
          candidateShortNotionalUsd: 1_000,
          singleSymbolCapOverride: 1.0,
        });
        expect(reason).toBe(SKIP_CROSS_STRATEGY_CAP);
      });

      it('falls back to spec default when override is undefined / non-finite / ≤ 0', () => {
        const baseTrip = {
          ...baseInputs,
          openShortsThisStrategyThisSymbolUsd: 7_000,
          candidateShortNotionalUsd: 1_000,
        };
        // No override → default 0.15 → trips.
        expect(evaluateShortNotionalCaps(baseTrip)).toBe(SKIP_SINGLE_SYMBOL_CAP);
        expect(
          evaluateShortNotionalCaps({ ...baseTrip, singleSymbolCapOverride: NaN }),
        ).toBe(SKIP_SINGLE_SYMBOL_CAP);
        expect(
          evaluateShortNotionalCaps({ ...baseTrip, singleSymbolCapOverride: 0 }),
        ).toBe(SKIP_SINGLE_SYMBOL_CAP);
        expect(
          evaluateShortNotionalCaps({ ...baseTrip, singleSymbolCapOverride: -0.5 }),
        ).toBe(SKIP_SINGLE_SYMBOL_CAP);
      });

      it('clamps override above PERP_SHORT_SINGLE_SYMBOL_CAP_MAX so the gate never silently no-ops', () => {
        // strategyEquity = $50k. Cap clamped to 1.0 → $50k limit. A candidate
        // that would breach $50k still trips, even when the override is 5.0.
        const reason = evaluateShortNotionalCaps({
          ...baseInputs,
          openShortsThisStrategyThisSymbolUsd: 50_000,
          candidateShortNotionalUsd: 1,
          singleSymbolCapOverride: 5.0,
        });
        expect(reason).toBe(SKIP_SINGLE_SYMBOL_CAP);
      });
    });
  });

  describe('resolveSingleSymbolShortCap (TRA-341)', () => {
    it('returns the spec default for unset / non-finite / non-positive inputs', () => {
      expect(resolveSingleSymbolShortCap(undefined)).toBeCloseTo(PERP_SHORT_SINGLE_SYMBOL_CAP, 6);
      expect(resolveSingleSymbolShortCap(NaN)).toBeCloseTo(PERP_SHORT_SINGLE_SYMBOL_CAP, 6);
      expect(resolveSingleSymbolShortCap(Number.POSITIVE_INFINITY)).toBeCloseTo(PERP_SHORT_SINGLE_SYMBOL_CAP, 6);
      expect(resolveSingleSymbolShortCap(0)).toBeCloseTo(PERP_SHORT_SINGLE_SYMBOL_CAP, 6);
      expect(resolveSingleSymbolShortCap(-0.5)).toBeCloseTo(PERP_SHORT_SINGLE_SYMBOL_CAP, 6);
    });

    it('passes through valid in-band overrides untouched', () => {
      expect(resolveSingleSymbolShortCap(0.05)).toBeCloseTo(0.05, 6);
      expect(resolveSingleSymbolShortCap(0.5)).toBeCloseTo(0.5, 6);
      expect(resolveSingleSymbolShortCap(PERP_SHORT_SINGLE_SYMBOL_CAP_MAX)).toBeCloseTo(
        PERP_SHORT_SINGLE_SYMBOL_CAP_MAX,
        6,
      );
    });

    it('clamps overrides above the max so a fat-finger save can never disable the gate', () => {
      expect(resolveSingleSymbolShortCap(2)).toBeCloseTo(PERP_SHORT_SINGLE_SYMBOL_CAP_MAX, 6);
      expect(resolveSingleSymbolShortCap(99)).toBeCloseTo(PERP_SHORT_SINGLE_SYMBOL_CAP_MAX, 6);
    });
  });

  describe('fundingFlipStopTriggered (TRA-255 §7)', () => {
    it('returns false when fewer than the required intervals are present', () => {
      expect(fundingFlipStopTriggered([])).toBe(false);
      expect(fundingFlipStopTriggered([-0.001, -0.001])).toBe(false);
    });

    it('returns true on three consecutive intervals at-or-below threshold', () => {
      const tail = Array(FUNDING_FLIP_INTERVALS).fill(FUNDING_GATE_THRESHOLD_PER_HOUR);
      expect(fundingFlipStopTriggered(tail)).toBe(true);
      // Only the tail matters — earlier values can be anything.
      expect(fundingFlipStopTriggered([0.01, ...tail])).toBe(true);
    });

    it('returns false when any of the last three intervals is above threshold', () => {
      const justBelow = FUNDING_GATE_THRESHOLD_PER_HOUR;
      const above = FUNDING_GATE_THRESHOLD_PER_HOUR + 0.0001;
      expect(fundingFlipStopTriggered([justBelow, above, justBelow])).toBe(false);
    });
  });

  describe('adverseVolExpansionShortExitTriggered (TRA-255 §7)', () => {
    it('returns true when ATR has expanded ≥1.5× and position is at/above entry', () => {
      // Short: currentPrice >= entryPrice means "at break-even or worse".
      const fired = adverseVolExpansionShortExitTriggered({
        currentAtr: 1.5,
        atrLookbackBarsAgo: 1.0,
        currentPrice: 100,
        entryPrice: 100,
      });
      expect(fired).toBe(true);
      // Slightly above the 1.5x ratio still fires.
      expect(adverseVolExpansionShortExitTriggered({
        currentAtr: 2.0,
        atrLookbackBarsAgo: 1.0,
        currentPrice: 105,
        entryPrice: 100,
      })).toBe(true);
    });

    it('returns false when ATR expansion is below the threshold', () => {
      const fired = adverseVolExpansionShortExitTriggered({
        currentAtr: 1.4,
        atrLookbackBarsAgo: 1.0,
        currentPrice: 100,
        entryPrice: 100,
      });
      expect(fired).toBe(false);
    });

    it('returns false when the short is already in profit (price < entry)', () => {
      const fired = adverseVolExpansionShortExitTriggered({
        currentAtr: 2.0,
        atrLookbackBarsAgo: 1.0,
        currentPrice: 95,
        entryPrice: 100,
      });
      expect(fired).toBe(false);
    });

    it('vol expansion threshold matches spec §7: ATR(14) +50% over 5 bars', () => {
      expect(VOL_EXPANSION_ATR_RATIO).toBeCloseTo(1.5, 6);
      expect(VOL_EXPANSION_BAR_LOOKBACK).toBe(5);
    });
  });

  describe('dailyShortCircuitBreakerTripped (TRA-255 §7)', () => {
    it('trips when day P&L is ≤ -2% of total equity', () => {
      expect(dailyShortCircuitBreakerTripped({
        shortPnlTodayUsd: -2_000,
        totalEquityUsd: 100_000,
      })).toBe(true);
      expect(dailyShortCircuitBreakerTripped({
        shortPnlTodayUsd: -2_500,
        totalEquityUsd: 100_000,
      })).toBe(true);
    });

    it('does not trip on a smaller loss', () => {
      expect(dailyShortCircuitBreakerTripped({
        shortPnlTodayUsd: -1_999,
        totalEquityUsd: 100_000,
      })).toBe(false);
    });

    it('does not trip on a green day', () => {
      expect(dailyShortCircuitBreakerTripped({
        shortPnlTodayUsd: 5_000,
        totalEquityUsd: 100_000,
      })).toBe(false);
    });

    it('zero/negative equity is a no-op (avoids false trips on a sentinel value)', () => {
      expect(dailyShortCircuitBreakerTripped({
        shortPnlTodayUsd: -10_000,
        totalEquityUsd: 0,
      })).toBe(false);
    });

    it('threshold matches spec §7: -2%', () => {
      expect(DAILY_SHORT_CIRCUIT_BREAKER_PCT).toBeCloseTo(-0.02, 6);
    });
  });

  describe('evaluateShortBookCaps (TRA-255 §3.1 / §6)', () => {
    it('thresholds match spec §3.1 / §6', () => {
      expect(MAX_CONCURRENT_SHORTS).toBe(3);
      expect(CONSECUTIVE_LOSS_THRESHOLD).toBe(3);
      expect(CONSECUTIVE_LOSS_COOLDOWN_MS).toBe(48 * 60 * 60 * 1000);
    });

    it('returns null on a clean short', () => {
      const sig = shortSignal('BTC-USD');
      expect(evaluateShortBookCaps(sig, {
        openShortCount: 0,
        symbolCooldownActive: false,
      })).toBeNull();
    });

    it('returns null for a long signal regardless of caps', () => {
      const longSig = shortSignal('BTC-USD', { side: 'buy' });
      expect(evaluateShortBookCaps(longSig, {
        openShortCount: 100,
        symbolCooldownActive: true,
      })).toBeNull();
    });

    it('emits SKIP_CONSECUTIVE_LOSSES when the symbol cooldown is active', () => {
      const sig = shortSignal('SOL-USD');
      expect(evaluateShortBookCaps(sig, {
        openShortCount: 0,
        symbolCooldownActive: true,
      })).toBe(SKIP_CONSECUTIVE_LOSSES);
    });

    it('emits SKIP_MAX_CONCURRENT_SHORTS when openShortCount ≥ 3', () => {
      const sig = shortSignal('BTC-USD');
      expect(evaluateShortBookCaps(sig, {
        openShortCount: MAX_CONCURRENT_SHORTS,
        symbolCooldownActive: false,
      })).toBe(SKIP_MAX_CONCURRENT_SHORTS);
      // Strictly above also trips.
      expect(evaluateShortBookCaps(sig, {
        openShortCount: MAX_CONCURRENT_SHORTS + 5,
        symbolCooldownActive: false,
      })).toBe(SKIP_MAX_CONCURRENT_SHORTS);
    });

    it('cooldown beats count cap when both would trip', () => {
      // The cooldown is the more specific diagnosis (the user can recover by
      // waiting 48h or by switching ticker), so we surface it first.
      const sig = shortSignal('SOL-USD');
      expect(evaluateShortBookCaps(sig, {
        openShortCount: 10,
        symbolCooldownActive: true,
      })).toBe(SKIP_CONSECUTIVE_LOSSES);
    });
  });

  describe('symbolShortCooldownActive (TRA-255 §3.1)', () => {
    const NOW = 2_000_000_000_000;
    function loss(symbol: string, closedAt: number, pnl = -10): ClosedShortTrade {
      return { symbol, closedAt, pnlUsd: pnl, side: 'sell' };
    }
    function win(symbol: string, closedAt: number, pnl = 10): ClosedShortTrade {
      return { symbol, closedAt, pnlUsd: pnl, side: 'sell' };
    }

    it('returns false on an empty history', () => {
      expect(symbolShortCooldownActive('BTC-USD', [], NOW)).toBe(false);
    });

    it('returns false when fewer than 3 consecutive losses on the symbol', () => {
      const trades = [loss('BTC-USD', NOW - 1_000), loss('BTC-USD', NOW - 2_000)];
      expect(symbolShortCooldownActive('BTC-USD', trades, NOW)).toBe(false);
    });

    it('returns true on exactly 3 consecutive losses inside the cooldown window', () => {
      const trades = [
        loss('BTC-USD', NOW - 1_000),
        loss('BTC-USD', NOW - 2_000),
        loss('BTC-USD', NOW - 3_000),
      ];
      expect(symbolShortCooldownActive('BTC-USD', trades, NOW)).toBe(true);
    });

    it('returns false when the most recent loss is older than the cooldown window', () => {
      const old = NOW - CONSECUTIVE_LOSS_COOLDOWN_MS - 60_000;
      const trades = [
        loss('BTC-USD', old),
        loss('BTC-USD', old - 1_000),
        loss('BTC-USD', old - 2_000),
      ];
      expect(symbolShortCooldownActive('BTC-USD', trades, NOW)).toBe(false);
    });

    it('a non-loss close BREAKS the streak (consecutive rule)', () => {
      const trades = [
        loss('BTC-USD', NOW - 1_000),
        win('BTC-USD', NOW - 2_000),
        loss('BTC-USD', NOW - 3_000),
        loss('BTC-USD', NOW - 4_000),
      ];
      expect(symbolShortCooldownActive('BTC-USD', trades, NOW)).toBe(false);
    });

    it('only counts shorts on the matching symbol', () => {
      // Three losses on ETH-USD do not put BTC-USD in cooldown.
      const trades = [
        loss('ETH-USD', NOW - 1_000),
        loss('ETH-USD', NOW - 2_000),
        loss('ETH-USD', NOW - 3_000),
      ];
      expect(symbolShortCooldownActive('BTC-USD', trades, NOW)).toBe(false);
      expect(symbolShortCooldownActive('ETH-USD', trades, NOW)).toBe(true);
    });

    it('long closes on the symbol are ignored', () => {
      // Two losing longs interleaved with shorts must not count toward the
      // short streak — the cooldown is short-specific.
      const trades: ClosedShortTrade[] = [
        loss('BTC-USD', NOW - 1_000),
        { symbol: 'BTC-USD', closedAt: NOW - 2_000, pnlUsd: -50, side: 'buy' },
        loss('BTC-USD', NOW - 3_000),
        { symbol: 'BTC-USD', closedAt: NOW - 4_000, pnlUsd: -50, side: 'buy' },
        loss('BTC-USD', NOW - 5_000),
      ];
      expect(symbolShortCooldownActive('BTC-USD', trades, NOW)).toBe(true);
    });
  });
});
