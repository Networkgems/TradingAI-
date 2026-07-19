import { describe, it, expect, beforeEach } from 'vitest';

import {
  resolveOrderQuoteGuardConfig,
  computeMarketableLimit,
  evaluateQuoteFreshness,
  recordOrderGuardOutcome,
  snapshotOrderGuardMetrics,
  resetOrderGuardMetricsForTests,
  DEFAULT_ORDER_MAX_SLIPPAGE,
  DEFAULT_ORDER_MAX_QUOTE_AGE_MS,
} from './order-quote-guard.js';

// TRA-2045 — order-time quote-freshness + max-slippage guard. These pin the two
// PURE decision functions (the limit-price math and the age gate) plus the
// env-driven config resolution and the counted-reason registry.

describe('resolveOrderQuoteGuardConfig', () => {
  it('defaults to mode=off with the shipped defaults when the flag is unset', () => {
    const cfg = resolveOrderQuoteGuardConfig({});
    expect(cfg.mode).toBe('off');
    expect(cfg.maxSlippage).toBe(DEFAULT_ORDER_MAX_SLIPPAGE);
    expect(cfg.maxQuoteAgeMs).toBe(DEFAULT_ORDER_MAX_QUOTE_AGE_MS);
  });

  it('enters shadow mode when enabled but not enforcing', () => {
    const cfg = resolveOrderQuoteGuardConfig({ ENABLE_ORDER_QUOTE_GUARD: 'true' });
    expect(cfg.mode).toBe('shadow');
  });

  it('enters enforce mode only when both flags are truthy', () => {
    expect(
      resolveOrderQuoteGuardConfig({ ENABLE_ORDER_QUOTE_GUARD: '1', ORDER_QUOTE_GUARD_ENFORCE: 'yes' }).mode,
    ).toBe('enforce');
    // enforce flag alone (guard disabled) stays off — enforce can't bypass the kill switch
    expect(resolveOrderQuoteGuardConfig({ ORDER_QUOTE_GUARD_ENFORCE: 'true' }).mode).toBe('off');
  });

  it('reads slippage / age overrides and ignores non-positive values', () => {
    const cfg = resolveOrderQuoteGuardConfig({
      ENABLE_ORDER_QUOTE_GUARD: 'on',
      ORDER_MAX_SLIPPAGE: '0.01',
      ORDER_MAX_QUOTE_AGE_MS: '2000',
    });
    expect(cfg.maxSlippage).toBe(0.01);
    expect(cfg.maxQuoteAgeMs).toBe(2000);

    const bad = resolveOrderQuoteGuardConfig({
      ENABLE_ORDER_QUOTE_GUARD: 'on',
      ORDER_MAX_SLIPPAGE: '-1',
      ORDER_MAX_QUOTE_AGE_MS: '0',
    });
    expect(bad.maxSlippage).toBe(DEFAULT_ORDER_MAX_SLIPPAGE);
    expect(bad.maxQuoteAgeMs).toBe(DEFAULT_ORDER_MAX_QUOTE_AGE_MS);
  });
});

describe('computeMarketableLimit — buy side', () => {
  it('clamps to the fresh ask when the ask is within the slippage budget', () => {
    // signal 100, 50bps cap = 100.5, ask 100.2 < cap ⇒ pay the ask (marketable)
    const r = computeMarketableLimit({ side: 'buy', signalPrice: 100, ask: 100.2, maxSlippage: 0.005 });
    expect(r.limitPrice).toBeCloseTo(100.2, 10);
    expect(r.slippageCapPrice).toBeCloseTo(100.5, 10);
    expect(r.touchPrice).toBe(100.2);
    expect(r.marketable).toBe(true);
    expect(r.clampedToTouch).toBe(true);
  });

  it('caps at the max-slippage price when the ask has run past the budget', () => {
    // ask 101 > cap 100.5 ⇒ sit at the cap; will not cross (non-marketable)
    const r = computeMarketableLimit({ side: 'buy', signalPrice: 100, ask: 101, maxSlippage: 0.005 });
    expect(r.limitPrice).toBeCloseTo(100.5, 10);
    expect(r.marketable).toBe(false);
    expect(r.clampedToTouch).toBe(false);
  });

  it('never exceeds the ask even with a generous budget', () => {
    // cap 105 but ask only 100.1 ⇒ no point bidding above the ask
    const r = computeMarketableLimit({ side: 'buy', signalPrice: 100, ask: 100.1, maxSlippage: 0.05 });
    expect(r.limitPrice).toBeCloseTo(100.1, 10);
    expect(r.marketable).toBe(true);
  });

  it('falls back to the slippage cap when no ask is available', () => {
    const r = computeMarketableLimit({ side: 'buy', signalPrice: 100, maxSlippage: 0.005 });
    expect(r.limitPrice).toBeCloseTo(100.5, 10);
    expect(r.touchPrice).toBeNull();
    expect(r.marketable).toBe(false);
  });

  it('treats a negative maxSlippage as zero budget (limit = signal, clamped to ask)', () => {
    const r = computeMarketableLimit({ side: 'buy', signalPrice: 100, ask: 100.2, maxSlippage: -0.01 });
    expect(r.slippageCapPrice).toBeCloseTo(100, 10);
    expect(r.limitPrice).toBeCloseTo(100, 10); // min(ask 100.2, cap 100)
    expect(r.marketable).toBe(false);
  });
});

describe('computeMarketableLimit — sell side', () => {
  it('clamps to the fresh bid when the bid clears the slippage floor', () => {
    // signal 100, 50bps floor = 99.5, bid 99.8 ≥ floor ⇒ hit the bid (marketable)
    const r = computeMarketableLimit({ side: 'sell', signalPrice: 100, bid: 99.8, maxSlippage: 0.005 });
    expect(r.limitPrice).toBeCloseTo(99.8, 10);
    expect(r.slippageCapPrice).toBeCloseTo(99.5, 10);
    expect(r.touchPrice).toBe(99.8);
    expect(r.marketable).toBe(true);
    expect(r.clampedToTouch).toBe(true);
  });

  it('floors at the max-slippage price when the bid has dropped past the budget', () => {
    // bid 99 < floor 99.5 ⇒ sit at the floor; will not cross (non-marketable)
    const r = computeMarketableLimit({ side: 'sell', signalPrice: 100, bid: 99, maxSlippage: 0.005 });
    expect(r.limitPrice).toBeCloseTo(99.5, 10);
    expect(r.marketable).toBe(false);
  });

  it('falls back to the slippage floor when no bid is available', () => {
    const r = computeMarketableLimit({ side: 'sell', signalPrice: 100, maxSlippage: 0.005 });
    expect(r.limitPrice).toBeCloseTo(99.5, 10);
    expect(r.touchPrice).toBeNull();
    expect(r.marketable).toBe(false);
  });
});

describe('evaluateQuoteFreshness', () => {
  const maxQuoteAgeMs = 5_000;

  it('passes a fresh quote', () => {
    const v = evaluateQuoteFreshness({ quoteTimeMs: 1_000_000, nowMs: 1_003_000, maxQuoteAgeMs });
    expect(v.fresh).toBe(true);
    expect(v.ageMs).toBe(3_000);
    expect(v.reason).toBeUndefined();
  });

  it('rejects a stale quote with the counted reason', () => {
    const v = evaluateQuoteFreshness({ quoteTimeMs: 1_000_000, nowMs: 1_008_000, maxQuoteAgeMs });
    expect(v.fresh).toBe(false);
    expect(v.ageMs).toBe(8_000);
    expect(v.reason).toBe('stale_quote');
  });

  it('rejects a missing timestamp with missing_quote_timestamp', () => {
    expect(evaluateQuoteFreshness({ nowMs: 1_000_000, maxQuoteAgeMs }).reason).toBe('missing_quote_timestamp');
    expect(evaluateQuoteFreshness({ quoteTimeMs: 0, nowMs: 1_000_000, maxQuoteAgeMs }).reason).toBe('missing_quote_timestamp');
    expect(evaluateQuoteFreshness({ quoteTimeMs: Number.NaN, nowMs: 1_000_000, maxQuoteAgeMs }).reason).toBe('missing_quote_timestamp');
  });

  it('treats a slightly-ahead broker clock (negative age) as fresh, not stale', () => {
    const v = evaluateQuoteFreshness({ quoteTimeMs: 1_000_500, nowMs: 1_000_000, maxQuoteAgeMs });
    expect(v.fresh).toBe(true);
    expect(v.ageMs).toBe(-500);
  });

  it('passes exactly at the boundary and fails one ms past it', () => {
    expect(evaluateQuoteFreshness({ quoteTimeMs: 0, nowMs: 5_000, maxQuoteAgeMs }).fresh).toBe(false); // 0 ts is treated as missing
    expect(evaluateQuoteFreshness({ quoteTimeMs: 1, nowMs: 5_001, maxQuoteAgeMs }).fresh).toBe(true); // age 5000 == threshold
    expect(evaluateQuoteFreshness({ quoteTimeMs: 1, nowMs: 5_002, maxQuoteAgeMs }).fresh).toBe(false); // age 5001 > threshold
  });
});

describe('order guard counters', () => {
  beforeEach(() => resetOrderGuardMetricsForTests());

  it('accumulates since-boot counts keyed by engine:mode:outcome', () => {
    recordOrderGuardOutcome('equity', 'passed', 'enforce');
    recordOrderGuardOutcome('equity', 'passed', 'enforce');
    recordOrderGuardOutcome('equity', 'stale_quote', 'enforce');
    recordOrderGuardOutcome('options', 'missing_quote_timestamp', 'shadow');

    const snap = snapshotOrderGuardMetrics();
    expect(snap.counts['equity:enforce:passed']).toBe(2);
    expect(snap.counts['equity:enforce:stale_quote']).toBe(1);
    expect(snap.counts['options:shadow:missing_quote_timestamp']).toBe(1);
    expect(snap.total).toBe(4);
  });
});
