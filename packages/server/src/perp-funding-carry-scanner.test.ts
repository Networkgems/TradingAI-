import { describe, it, expect, beforeEach } from 'vitest';
import {
  scanFundingCarry,
  recordFundingCarryScan,
  summarizeFundingCarryScans,
  clearFundingCarryScans,
  SHORT_PERP_LIQ_NOTE,
  type FundingObservation,
} from './perp-funding-carry-scanner.js';
import type { PerpCarryConfig } from './perp-funding-carry-flag.js';

// TRA-1216 — the observe-only perp funding-carry scanner (sibling to the TRA-1156
// IV-RV scanner). Proves the carry math (annualization DRIVEN OFF intervalHours,
// net-APR, fee-breakeven horizon), the funding-sign gate (invariant #3), the
// liquidation-risk surfacing (invariant #4), netApr ranking, and the in-memory
// store folding into the redacted /api/health/perp-funding-carry shape with caps
// + TTL. Read-only: nothing here places or sizes an order.

const NOW = Date.parse('2024-01-15T15:00:00Z');

/** Spec defaults (§3): strong tier 0.05, 20 bps round-trip, 0 borrow. */
const CFG: PerpCarryConfig = { minNetApr: 0.05, feeBpsRoundTrip: 20, borrowApr: 0 };

function obs(over: Partial<FundingObservation> = {}): FundingObservation {
  return { productId: 'BTC-PERP-INTX', fundingRate: 0.000012, intervalHours: 1, markPrice: 68000, ...over };
}

describe('scanFundingCarry — carry math', () => {
  it('annualizes hourly funding off intervalHours (spec §2 worked example)', () => {
    const [c] = scanFundingCarry([obs({ fundingRate: 0.000012, intervalHours: 1 })], CFG, NOW);
    expect(c!.sign).toBe('positive');
    expect(c!.fundingApr).toBeCloseTo(0.10512, 6); // 0.000012 × 8760
    expect(c!.netApr).toBeCloseTo(0.10512, 6); // borrow 0
    expect(c!.eligible).toBe(true);
    expect(c!.reason).toBeNull();
    expect(c!.strength).toBe('strong'); // ≥ 0.05
    // daysToFeeBreakeven = 20 / (fundingApr_bps / 365) ≈ 6.95 (spec ≈ 7.0)
    expect(c!.daysToFeeBreakeven).toBeCloseTo(20 / ((0.10512 * 10_000) / 365), 6);
    expect(c!.daysToFeeBreakeven).toBeGreaterThan(6.9);
    expect(c!.daysToFeeBreakeven).toBeLessThan(7.0);
    // invariant #4 — liquidation risk always surfaced, never sized.
    expect(c!.shortPerpLiquidationRisk).toBe(true);
    expect(c!.liqNote).toBe(SHORT_PERP_LIQ_NOTE);
    expect(c!.markPrice).toBe(68000);
    expect(c!.asOf).toBe(new Date(NOW).toISOString());
  });

  it('drives annualization off the PER-OBSERVATION interval — NOT a hardcoded 8h', () => {
    const hourly = scanFundingCarry([obs({ fundingRate: 0.0001, intervalHours: 1 })], CFG, NOW)[0]!;
    const eightHour = scanFundingCarry([obs({ fundingRate: 0.0001, intervalHours: 8 })], CFG, NOW)[0]!;
    expect(hourly.fundingApr).toBeCloseTo(0.876, 6); // × 8760
    expect(eightHour.fundingApr).toBeCloseTo(0.1095, 6); // × 1095
    // If the multiplier were hardcoded these would be equal — they must differ 8×.
    expect(hourly.fundingApr! / eightHour.fundingApr!).toBeCloseTo(8, 6);
  });

  it('tags marginal below the strong tier', () => {
    // rate chosen so fundingApr ≈ 0.02 < 0.05 strong floor.
    const [c] = scanFundingCarry([obs({ fundingRate: 0.02 / 8760, intervalHours: 1 })], CFG, NOW);
    expect(c!.eligible).toBe(true);
    expect(c!.netApr).toBeCloseTo(0.02, 6);
    expect(c!.strength).toBe('marginal');
  });
});

describe('scanFundingCarry — funding-sign gate (invariant #3)', () => {
  it('marks negative funding ineligible but surfaces the signed magnitude', () => {
    const [c] = scanFundingCarry([obs({ fundingRate: -0.00003 })], CFG, NOW);
    expect(c!.eligible).toBe(false);
    expect(c!.reason).toBe('funding_sign_negative');
    expect(c!.sign).toBe('negative');
    expect(c!.fundingRate).toBe(-0.00003); // magnitude never dropped
    expect(c!.strength).toBeNull();
  });

  it('fails closed on missing funding (no phantom positive)', () => {
    const [c] = scanFundingCarry([obs({ fundingRate: null })], CFG, NOW);
    expect(c!.eligible).toBe(false);
    expect(c!.reason).toBe('funding_data_missing');
    expect(c!.sign).toBeNull();
    expect(c!.fundingApr).toBeNull();
    expect(c!.netApr).toBeNull();
  });

  it('marks positive funding that is net-negative after borrow ineligible', () => {
    const [c] = scanFundingCarry([obs({ fundingRate: 0.000001 })], { ...CFG, borrowApr: 0.05 }, NOW);
    expect(c!.sign).toBe('positive');
    expect(c!.eligible).toBe(false);
    expect(c!.reason).toBe('net_apr_negative');
    expect(c!.netApr! < 0).toBe(true);
  });
});

describe('scanFundingCarry — ranking', () => {
  it('ranks eligible by netApr desc, ineligible after', () => {
    const out = scanFundingCarry(
      [
        obs({ productId: 'A-PERP-INTX', fundingRate: 0.00001 }), // lower carry
        obs({ productId: 'B-PERP-INTX', fundingRate: 0.00003 }), // higher carry
        obs({ productId: 'C-PERP-INTX', fundingRate: -0.00002 }), // ineligible
        obs({ productId: 'D-PERP-INTX', fundingRate: null }), // ineligible
      ],
      CFG,
      NOW,
    );
    expect(out.map((c) => c.productId)).toEqual([
      'B-PERP-INTX',
      'A-PERP-INTX',
      'C-PERP-INTX',
      'D-PERP-INTX',
    ]);
    expect(out.slice(0, 2).every((c) => c.eligible)).toBe(true);
    expect(out.slice(2).every((c) => !c.eligible)).toBe(true);
  });

  it('upper-cases the productId', () => {
    const [c] = scanFundingCarry([obs({ productId: 'btc-perp-intx' })], CFG, NOW);
    expect(c!.productId).toBe('BTC-PERP-INTX');
  });
});

describe('funding-carry store / summarizeFundingCarryScans', () => {
  beforeEach(() => clearFundingCarryScans());

  it('folds recorded candidates into the health shape (candidateCount = eligible)', () => {
    const candidates = scanFundingCarry(
      [obs({ productId: 'BTC-PERP-INTX' }), obs({ productId: 'ETH-PERP-INTX', fundingRate: -0.00001 })],
      CFG,
      NOW,
    );
    recordFundingCarryScan(candidates, NOW);
    const summary = summarizeFundingCarryScans(NOW);
    expect(summary.symbolCount).toBe(2); // both surfaced
    expect(summary.candidateCount).toBe(1); // only the eligible one counts
    const top = summary.scans[0]!;
    expect(top.productId).toBe('BTC-PERP-INTX');
    expect(top.eligible).toBe(true);
    expect(top.recordedAt).toBe(new Date(NOW).toISOString());
    expect(typeof top.netApr).toBe('number');
    expect(top.shortPerpLiquidationRisk).toBe(true);
  });

  it('keeps the latest candidate per productId (latest-wins)', () => {
    recordFundingCarryScan(scanFundingCarry([obs({ fundingRate: 0.00002 })], CFG, NOW), NOW);
    recordFundingCarryScan(scanFundingCarry([obs({ fundingRate: -0.00002 })], CFG, NOW), NOW + 1000);
    const summary = summarizeFundingCarryScans(NOW + 1000);
    expect(summary.symbolCount).toBe(1);
    expect(summary.scans[0]!.eligible).toBe(false);
    expect(summary.candidateCount).toBe(0);
  });

  it('ranks eligible by netApr first in the summary', () => {
    recordFundingCarryScan(
      scanFundingCarry(
        [
          obs({ productId: 'AAA-PERP-INTX', fundingRate: 0.00001 }),
          obs({ productId: 'ZZZ-PERP-INTX', fundingRate: 0.00005 }),
        ],
        CFG,
        NOW,
      ),
      NOW,
    );
    expect(summarizeFundingCarryScans(NOW).scans.map((s) => s.productId)).toEqual([
      'ZZZ-PERP-INTX',
      'AAA-PERP-INTX',
    ]);
  });

  it('drops candidates past the 2-hour TTL', () => {
    recordFundingCarryScan(scanFundingCarry([obs()], CFG, NOW), NOW);
    expect(summarizeFundingCarryScans(NOW + 119 * 60_000).symbolCount).toBe(1);
    expect(summarizeFundingCarryScans(NOW + 121 * 60_000).symbolCount).toBe(0);
  });

  it('caps the store so it cannot grow unbounded', () => {
    for (let i = 0; i < 200; i++) {
      recordFundingCarryScan(
        scanFundingCarry([obs({ productId: `P${i}-PERP-INTX` })], CFG, NOW),
        NOW,
      );
    }
    expect(summarizeFundingCarryScans(NOW).symbolCount).toBe(128);
  });
});
