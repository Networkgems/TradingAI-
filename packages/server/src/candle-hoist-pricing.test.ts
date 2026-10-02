import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import type { RetainerRow } from './heap-retainer-census.js';
import {
  FILED_ROSTER,
  PROXY_CALIBRATION,
  priceCandleHoist,
  type PriceCandleHoistOptions,
} from './candle-hoist-pricing.js';

function bars(symbol: string, count: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      symbol,
      timestamp: 1_700_000_000_000 + i * 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1_000 + i,
    });
  }
  return out;
}

function store(entries: number, depth = 80): () => Iterable<[string, Candle[]]> {
  const map = new Map<string, Candle[]>();
  for (let i = 0; i < entries; i += 1) map.set(`S${i}`, bars(`S${i}`, depth));
  return () => map.entries();
}

function row(name: string, entries: number, owners = 1): RetainerRow {
  return { name, kind: 'map', owners, entries, maxEntries: entries, nested: null, note: null };
}

/**
 * A `heapUsed` that reports a fixed delta per arm, so the arithmetic under test
 * is the MODEL and not the host's GC. `perArmBytes` is consumed one entry per
 * arm; the last value repeats.
 */
function fakeHeap(perArmBytes: readonly number[]): () => number {
  let level = 1_000_000;
  let call = 0;
  return () => {
    const i = Math.floor(call / 2);
    const isAfter = call % 2 === 1;
    call += 1;
    if (isAfter) {
      level += perArmBytes[Math.min(i, perArmBytes.length - 1)];
      return level;
    }
    return level;
  };
}

/** 400 per-engine entries against a 100-key union = PERFECT sharing at N=4. */
function perfectSharingAtFour(overrides: Partial<PriceCandleHoistOptions> = {}): PriceCandleHoistOptions {
  // counterfactual = proxyEntries x factor, so pick the proxy that lands on 400.
  const proxyEntries = Math.round(400 / PROXY_CALIBRATION.factor);
  return {
    rows: [
      row('marketData.minuteCandles', 100),
      row(PROXY_CALIBRATION.row, proxyEntries, 4),
      row('signalEngine.symbolState', 400, 4),
    ],
    population: 4,
    entries: store(50),
    heapUsed: fakeHeap([8_000_000]),
    arms: 3,
    ...overrides,
  };
}

describe('TRA-4986 AC4 — pricing the candle hoist instead of folding heap across a roster change', () => {
  it('prices the MEASURED saving at the current population from bytes/entry x duplicate entries', () => {
    const p = priceCandleHoist(perfectSharingAtFour());
    expect(p.refusal).toBeNull();
    expect(p.unionEntries).toBe(100);
    expect(p.counterfactualEntries).toBeCloseTo(400, 0);
    expect(p.duplicateEntries).toBeCloseTo(300, 0);
    expect(p.population).toBe(4);
    // 3 arms x 8 MB over (50 entries x replicas) copies each.
    const replicas = p.cost.replicas;
    expect(p.bytesPerEntry).toBe(Math.round(8_000_000 / (50 * replicas)));
    // The published saving must be the product of the two published factors.
    // Compared with a tolerance because the factors are rounded for publication
    // and the product is computed off the unrounded ones — asserting equality on
    // the rounded product would be asserting the rounding, not the model.
    expect(p.savingBytes! / (p.duplicateEntries! * p.bytesPerEntry!)).toBeCloseTo(1, 3);
    expect(p.savingMB).toBeCloseTo(p.savingBytes! / 1048576, 1);
  });

  it('reads sharingEfficiency 1.0 when every engine held an identical key set', () => {
    const p = priceCandleHoist(perfectSharingAtFour());
    // Σ=400 over N=4 with a 100-key union is exactly the perfect ceiling.
    expect(p.sharingEfficiency).toBeCloseTo(1, 2);
  });

  it('reads sharingEfficiency BELOW 1 when the universes only partly overlap, and the projection falls with it', () => {
    const proxyEntries = Math.round(400 / PROXY_CALIBRATION.factor);
    const partial = priceCandleHoist({
      ...perfectSharingAtFour(),
      rows: [row('marketData.minuteCandles', 250), row(PROXY_CALIBRATION.row, proxyEntries, 4)],
    });
    const perfect = priceCandleHoist(perfectSharingAtFour());
    expect(partial.sharingEfficiency).toBeLessThan(0.9);
    expect(partial.sharingEfficiency).toBeCloseTo(150 / 300, 2);
    // The projection must inherit the shortfall rather than quietly assuming
    // perfect duplication at 68 — the naive `(N-1) x one copy` model would not.
    expect(partial.projection!.duplicateEntries!).toBeLessThan(perfect.projection!.duplicateEntries!);
    expect(
      partial.projection!.duplicateEntries!
        / (partial.sharingEfficiency! * FILED_ROSTER.candleCacheEntries * (1 - 1 / 68)),
    ).toBeCloseTo(1, 3);
  });

  it('labels the 68-roster arm a PROJECTION and names its one unmeasured input', () => {
    const p = priceCandleHoist(perfectSharingAtFour());
    expect(p.projection!.label).toContain('PROJECTION');
    expect(p.projection!.atPopulation).toBe(68);
    expect(p.projection!.unmeasuredInput).toContain('|union| at 68 engines');
    // And it is a strictly different number from the measured one, so a reader
    // cannot mistake which they are holding.
    expect(p.projection!.bytes).toBeGreaterThan(p.savingBytes!);
  });

  it('REFUSES on a cold store — and publishes null, not a 0-byte saving', () => {
    const p = priceCandleHoist({ ...perfectSharingAtFour(), entries: store(0) });
    expect(p.refusal).toBe('store_cold');
    expect(p.savingBytes).toBeNull();
    expect(p.bytesPerEntry).toBeNull();
    expect(p.refusalDetail).toContain('13:30Z');
  });

  it('REFUSES a thin sample rather than averaging one outlier', () => {
    const p = priceCandleHoist({ ...perfectSharingAtFour(), entries: store(3) });
    expect(p.refusal).toBe('sample_too_small');
    expect(p.savingBytes).toBeNull();
  });

  it('REFUSES when the hoisted store row is absent — which is also AC2 failing', () => {
    const p = priceCandleHoist({
      ...perfectSharingAtFour(),
      rows: [row(PROXY_CALIBRATION.row, 400, 4)],
    });
    expect(p.refusal).toBe('store_row_absent');
    expect(p.refusalDetail).toContain('AC2');
  });

  it('REFUSES when the counterfactual proxy row is absent', () => {
    const p = priceCandleHoist({
      ...perfectSharingAtFour(),
      rows: [row('marketData.minuteCandles', 100)],
    });
    expect(p.refusal).toBe('proxy_row_absent');
  });

  it('REFUSES an unreadable population and does NOT treat it as 1', () => {
    const p = priceCandleHoist({ ...perfectSharingAtFour(), population: null });
    expect(p.refusal).toBe('population_unreadable');
    expect(p.population).toBeNull();
    expect(p.sharingEfficiency).toBeNull();
  });

  it('REFUSES an arm that measured <= 0 bytes instead of quietly dropping it', () => {
    const p = priceCandleHoist({
      ...perfectSharingAtFour(),
      heapUsed: fakeHeap([8_000_000, -2_000_000, 8_000_000]),
    });
    expect(p.refusal).toBe('arm_non_positive');
    expect(p.bytesPerEntry).toBeNull();
    // The arms stay published: the refusal has to be auditable from the payload.
    expect(p.arms).toHaveLength(3);
    expect(p.arms.some((a) => a.bytes <= 0)).toBe(true);
  });

  it('REFUSES arms that disagree by more than 2x, where the median would still have printed', () => {
    const p = priceCandleHoist({
      ...perfectSharingAtFour(),
      heapUsed: fakeHeap([4_000_000, 8_000_000, 40_000_000]),
    });
    expect(p.refusal).toBe('arms_disagree');
    expect(p.bytesPerEntry).toBeNull();
    expect(p.arms).toHaveLength(3);
  });

  it('accepts arms inside the agreement band', () => {
    const p = priceCandleHoist({
      ...perfectSharingAtFour(),
      heapUsed: fakeHeap([8_000_000, 9_000_000, 10_000_000]),
    });
    expect(p.refusal).toBeNull();
    // Median of the three, not the mean and not the max.
    expect(p.bytesPerEntry).toBe(Math.round(9_000_000 / (50 * p.cost.replicas)));
  });

  it('REFUSES a proxy that has fallen below the measured union rather than printing a negative saving', () => {
    const p = priceCandleHoist({
      ...perfectSharingAtFour(),
      rows: [row('marketData.minuteCandles', 500), row(PROXY_CALIBRATION.row, 100, 4)],
    });
    expect(p.refusal).toBe('proxy_below_union');
    expect(p.savingBytes).toBeNull();
    // bytesPerEntry was measurable and is still published — the invalid input is
    // the proxy, and saying which one broke is the point.
    expect(p.bytesPerEntry).not.toBeNull();
  });

  it('keeps the proxy calibration a RATIO of two same-roster totals, so it encodes no population', () => {
    // The lesson of this ticket's own `bound: 6800` defect. Both totals were
    // measured at 68 engines, so the population divides out.
    expect(PROXY_CALIBRATION.factor).toBeCloseTo(6608 / 6800, 6);
    expect(PROXY_CALIBRATION.population).toBe(68);
    // Doubling BOTH totals (i.e. the same fleet at twice the roster) must not
    // move the calibration.
    expect((2 * 6608) / (2 * 6800)).toBeCloseTo(PROXY_CALIBRATION.factor, 6);
  });

  it('measures candles-per-entry rather than assuming the 80 literal', () => {
    const p = priceCandleHoist({ ...perfectSharingAtFour(), entries: store(50, 40) });
    expect(p.candlesPerEntry).toBeCloseTo(40, 1);
    expect(p.bytesPerCandle).toBeCloseTo(p.bytesPerEntry! / 40, 0);
  });

  it('bounds its own cost: the sample is capped and the store is never fully walked', () => {
    const p = priceCandleHoist({ ...perfectSharingAtFour(), entries: store(5_000), sampleEntries: 25 });
    expect(p.cost.sampleEntries).toBe(25);
    expect(p.arms.every((a) => a.entriesCopied === 25 * p.cost.replicas)).toBe(true);
  });

  it('skips empty series when sampling — an empty array would price an entry at ~0', () => {
    const map = new Map<string, Candle[]>();
    for (let i = 0; i < 10; i += 1) map.set(`E${i}`, []);
    for (let i = 0; i < 10; i += 1) map.set(`F${i}`, bars(`F${i}`, 80));
    const p = priceCandleHoist({ ...perfectSharingAtFour(), entries: () => map.entries() });
    expect(p.refusal).toBeNull();
    expect(p.cost.sampleEntries).toBe(10);
    expect(p.candlesPerEntry).toBeCloseTo(80, 1);
  });
});

describe('TRA-4986 AC4 — the measurement runs against the REAL store shape', () => {
  it('measures a positive bytes/entry on the live heap with no injected heapUsed', () => {
    // The one case that exercises `process.memoryUsage()` for real. Asserted as
    // a band rather than a value: the point is that the instrument returns a
    // plausible per-candle size on this host, not that V8 is deterministic.
    const p = priceCandleHoist({ ...perfectSharingAtFour(), heapUsed: undefined, arms: 3 });
    if (p.refusal !== null) {
      // A GC inside an arm is a legitimate outcome and must refuse, not flake.
      expect(['arm_non_positive', 'arms_disagree']).toContain(p.refusal);
      return;
    }
    expect(p.bytesPerCandle).toBeGreaterThan(20);
    expect(p.bytesPerCandle).toBeLessThan(500);
    expect(p.savingBytes).toBeGreaterThan(0);
  });
});
