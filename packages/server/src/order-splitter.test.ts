import { describe, it, expect, beforeEach } from 'vitest';

import {
  resolveOrderSplitConfig,
  planOrderSlices,
  recordOrderSplitOutcome,
  snapshotOrderSplitMetrics,
  resetOrderSplitMetricsForTests,
  DEFAULT_ORDER_SPLIT_MIN_NOTIONAL,
  DEFAULT_ORDER_SPLIT_CHILD_COUNT,
  DEFAULT_ORDER_SPLIT_INTERVAL_MS,
  DEFAULT_ORDER_SPLIT_MAX_PARTICIPATION,
  ORDER_SPLIT_MAX_SLICES,
  type OrderSplitConfig,
} from './order-splitter.js';

// TRA-2050 (parent TRA-2044) — TWAP/participation order splitting for larger
// equity orders. These pin the env-driven config, the PURE slice planner (TWAP
// even split + participation-rate capping + fallbacks + threshold/flag gating),
// and the counted-reason registry.

/** An enabled config with small round numbers for readable slice math. */
function cfg(overrides: Partial<OrderSplitConfig> = {}): OrderSplitConfig {
  return {
    enabled: true,
    strategy: 'twap',
    minNotional: 10_000,
    childCount: 4,
    intervalMs: 60_000,
    maxParticipationRate: 0.1,
    ...overrides,
  };
}

describe('resolveOrderSplitConfig', () => {
  it('defaults to disabled with the shipped defaults when the flag is unset', () => {
    const c = resolveOrderSplitConfig({});
    expect(c.enabled).toBe(false);
    expect(c.strategy).toBe('twap');
    expect(c.minNotional).toBe(DEFAULT_ORDER_SPLIT_MIN_NOTIONAL);
    expect(c.childCount).toBe(DEFAULT_ORDER_SPLIT_CHILD_COUNT);
    expect(c.intervalMs).toBe(DEFAULT_ORDER_SPLIT_INTERVAL_MS);
    expect(c.maxParticipationRate).toBe(DEFAULT_ORDER_SPLIT_MAX_PARTICIPATION);
  });

  it('enables on any truthy flag value', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(resolveOrderSplitConfig({ ENABLE_ORDER_SPLITTING: v }).enabled).toBe(true);
    }
    expect(resolveOrderSplitConfig({ ENABLE_ORDER_SPLITTING: 'off' }).enabled).toBe(false);
    expect(resolveOrderSplitConfig({ ENABLE_ORDER_SPLITTING: '0' }).enabled).toBe(false);
  });

  it('reads the participation strategy (else defaults to twap)', () => {
    expect(resolveOrderSplitConfig({ ORDER_SPLIT_STRATEGY: 'participation' }).strategy).toBe('participation');
    expect(resolveOrderSplitConfig({ ORDER_SPLIT_STRATEGY: 'PARTICIPATION' }).strategy).toBe('participation');
    expect(resolveOrderSplitConfig({ ORDER_SPLIT_STRATEGY: 'vwap' }).strategy).toBe('twap');
    expect(resolveOrderSplitConfig({}).strategy).toBe('twap');
  });

  it('reads numeric overrides and ignores malformed / non-positive values', () => {
    const c = resolveOrderSplitConfig({
      ORDER_SPLIT_MIN_NOTIONAL: '25000',
      ORDER_SPLIT_CHILD_COUNT: '6',
      ORDER_SPLIT_INTERVAL_MS: '30000',
      ORDER_SPLIT_MAX_PARTICIPATION: '0.2',
    });
    expect(c.minNotional).toBe(25_000);
    expect(c.childCount).toBe(6);
    expect(c.intervalMs).toBe(30_000);
    expect(c.maxParticipationRate).toBe(0.2);

    const bad = resolveOrderSplitConfig({
      ORDER_SPLIT_MIN_NOTIONAL: 'abc',
      ORDER_SPLIT_CHILD_COUNT: '-2',
      ORDER_SPLIT_INTERVAL_MS: '0',
      ORDER_SPLIT_MAX_PARTICIPATION: '5', // >1 rejected
    });
    expect(bad.minNotional).toBe(DEFAULT_ORDER_SPLIT_MIN_NOTIONAL);
    expect(bad.childCount).toBe(DEFAULT_ORDER_SPLIT_CHILD_COUNT);
    expect(bad.intervalMs).toBe(DEFAULT_ORDER_SPLIT_INTERVAL_MS);
    expect(bad.maxParticipationRate).toBe(DEFAULT_ORDER_SPLIT_MAX_PARTICIPATION);
  });

  it('floors a fractional child count to at least 1', () => {
    expect(resolveOrderSplitConfig({ ORDER_SPLIT_CHILD_COUNT: '3.9' }).childCount).toBe(3);
    expect(resolveOrderSplitConfig({ ORDER_SPLIT_CHILD_COUNT: '0.5' }).childCount).toBe(1);
  });
});

describe('planOrderSlices — gating (no behavior change today)', () => {
  it('flag off ⇒ a single un-split slice regardless of size', () => {
    const plan = planOrderSlices({ side: 'buy', totalQty: 10_000, referencePrice: 100, config: cfg({ enabled: false }) });
    expect(plan.split).toBe(false);
    expect(plan.reason).toBe('disabled');
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]).toMatchObject({ index: 0, qty: 10_000, scheduledOffsetMs: 0 });
  });

  it('below the notional threshold ⇒ a single slice (inert at today small sizes)', () => {
    // 10 shares × $150 = $1,500 < $10,000 threshold
    const plan = planOrderSlices({ side: 'buy', totalQty: 10, referencePrice: 150, config: cfg() });
    expect(plan.split).toBe(false);
    expect(plan.reason).toBe('below_threshold');
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0].qty).toBe(10);
    expect(plan.notional).toBe(1_500);
  });

  it('invalid qty ⇒ a single defensive slice', () => {
    for (const q of [0, -5, Number.NaN]) {
      const plan = planOrderSlices({ side: 'buy', totalQty: q, referencePrice: 100, config: cfg() });
      expect(plan.split).toBe(false);
      expect(plan.reason).toBe('invalid_qty');
      expect(plan.slices).toHaveLength(1);
      expect(plan.slices[0].qty).toBe(0);
    }
  });
});

describe('planOrderSlices — TWAP', () => {
  it('splits a large order into childCount even slices spaced by intervalMs', () => {
    const plan = planOrderSlices({ side: 'buy', totalQty: 400, referencePrice: 100, config: cfg({ childCount: 4 }) });
    expect(plan.split).toBe(true);
    expect(plan.reason).toBe('split_twap');
    expect(plan.strategy).toBe('twap');
    expect(plan.slices.map((s) => s.qty)).toEqual([100, 100, 100, 100]);
    expect(plan.slices.map((s) => s.scheduledOffsetMs)).toEqual([0, 60_000, 120_000, 180_000]);
  });

  it('loads the integer remainder onto the earliest slices and preserves the total', () => {
    const plan = planOrderSlices({ side: 'buy', totalQty: 403, referencePrice: 100, config: cfg({ childCount: 4 }) });
    expect(plan.slices.map((s) => s.qty)).toEqual([101, 101, 101, 100]);
    expect(plan.slices.reduce((sum, s) => sum + s.qty, 0)).toBe(403);
  });

  it('drops empty slices when childCount exceeds the share count', () => {
    // childCount 40 (< the 50 ceiling) but only 30 shares ⇒ at most one share
    // each, so the plan emits 30 slices, not 40 (no zero-qty stubs).
    const plan = planOrderSlices({ side: 'buy', totalQty: 30, referencePrice: 100, config: cfg({ childCount: 40, minNotional: 1_000 }) });
    expect(plan.slices).toHaveLength(30);
    expect(plan.slices.every((s) => s.qty === 1)).toBe(true);
    expect(plan.slices.reduce((sum, s) => sum + s.qty, 0)).toBe(30);
  });

  it('a childCount of 1 yields a single (unsplit) slice with the config reason', () => {
    const plan = planOrderSlices({ side: 'sell', totalQty: 400, referencePrice: 100, config: cfg({ childCount: 1 }) });
    expect(plan.split).toBe(false);
    expect(plan.reason).toBe('single_slice_config');
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0].qty).toBe(400);
  });
});

describe('planOrderSlices — participation', () => {
  it('caps each child at maxParticipationRate × intervalVolume', () => {
    // cap = floor(10000 × 0.1) = 1000 shares/slice; 3000 shares ⇒ 3 slices
    const plan = planOrderSlices({
      side: 'buy',
      totalQty: 3_000,
      referencePrice: 100,
      intervalVolume: 10_000,
      config: cfg({ strategy: 'participation', maxParticipationRate: 0.1 }),
    });
    expect(plan.split).toBe(true);
    expect(plan.reason).toBe('split_participation');
    expect(plan.strategy).toBe('participation');
    expect(plan.slices).toHaveLength(3);
    expect(plan.slices.map((s) => s.qty)).toEqual([1_000, 1_000, 1_000]);
    expect(plan.slices.map((s) => s.scheduledOffsetMs)).toEqual([0, 60_000, 120_000]);
  });

  it('falls back to the TWAP even split when no interval volume is supplied', () => {
    const plan = planOrderSlices({
      side: 'buy',
      totalQty: 400,
      referencePrice: 100,
      config: cfg({ strategy: 'participation', childCount: 4 }),
    });
    expect(plan.split).toBe(true);
    expect(plan.reason).toBe('participation_no_volume_twap_fallback');
    expect(plan.strategy).toBe('twap');
    expect(plan.slices.map((s) => s.qty)).toEqual([100, 100, 100, 100]);
  });

  it('respects the ORDER_SPLIT_MAX_SLICES ceiling for a huge order / tiny cap', () => {
    // cap = floor(100 × 0.1) = 10 shares/slice; 10_000 shares would need 1000
    // slices but is clamped to ORDER_SPLIT_MAX_SLICES, re-evened across them.
    const plan = planOrderSlices({
      side: 'buy',
      totalQty: 10_000,
      referencePrice: 100,
      intervalVolume: 100,
      config: cfg({ strategy: 'participation', maxParticipationRate: 0.1, minNotional: 1_000 }),
    });
    expect(plan.slices.length).toBe(ORDER_SPLIT_MAX_SLICES);
    expect(plan.slices.reduce((sum, s) => sum + s.qty, 0)).toBe(10_000);
  });
});

describe('order-splitter telemetry registry', () => {
  beforeEach(() => resetOrderSplitMetricsForTests());

  it('starts empty', () => {
    expect(snapshotOrderSplitMetrics()).toEqual({ counts: {}, total: 0 });
  });

  it('keys counters by enabled:reason and tallies scheduled slices for split plans', () => {
    const twap = planOrderSlices({ side: 'buy', totalQty: 400, referencePrice: 100, config: cfg({ childCount: 4 }) });
    recordOrderSplitOutcome(twap, true);
    const below = planOrderSlices({ side: 'buy', totalQty: 5, referencePrice: 100, config: cfg() });
    recordOrderSplitOutcome(below, true);

    const snap = snapshotOrderSplitMetrics();
    expect(snap.counts['enabled:split_twap']).toBe(1);
    expect(snap.counts['enabled:below_threshold']).toBe(1);
    expect(snap.counts['slices_scheduled']).toBe(4);
    // slices_scheduled is a slice tally, NOT a planning-outcome — excluded from total.
    expect(snap.total).toBe(2);
  });

  it('records the disabled bucket under a disabled key', () => {
    const off = planOrderSlices({ side: 'buy', totalQty: 400, referencePrice: 100, config: cfg({ enabled: false }) });
    recordOrderSplitOutcome(off, false);
    expect(snapshotOrderSplitMetrics().counts['disabled:disabled']).toBe(1);
  });
});
