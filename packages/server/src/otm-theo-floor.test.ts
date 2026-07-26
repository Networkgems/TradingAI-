import { describe, it, expect } from 'vitest';
import { applyTheoFloor, OTM_PANEL_THEO_FLOOR } from './otm-theo-floor.js';

/**
 * TRA-2341 fixtures are the LIVE 2026-07-25T23:40Z reads off bqb1 (SPY 738.93,
 * 2026-08-31 expiry) that the ticket tabulates, plus the control symbols from
 * the same sweep. The point of pinning real numbers is that the artifact rows
 * are ARITHMETICALLY CORRECT — `(0.095 − 0.000128) / 0.000128` really is 741.
 * Nothing in the suite could previously tell a working ranking from a broken
 * one, because there is no wrong sum to catch. The failing state has to be
 * asserted at the ranking/projection layer, which is what these do.
 */

/** The three worst SPY rows from the ticket's table. */
const SPY_ARTIFACTS = [
  { optionSymbol: 'SPY260831P00420000', mark: 0.095, theo: 0.000128, mispricingPct: 742.157 },
  { optionSymbol: 'SPY260831P00425000', mark: 0.095, theo: 0.000195, mispricingPct: 485.008 },
  { optionSymbol: 'SPY260831P00430000', mark: 0.105, theo: 0.000295, mispricingPct: 354.624 },
];

/** Genuine reads that must survive the floor — NVDA -27.3%, AAPL +14.9%. */
const REAL_READS = [
  { optionSymbol: 'NVDA260831C00200000', mark: 1.42, theo: 1.9522, mispricingPct: -0.2726 },
  { optionSymbol: 'AAPL260831C00260000', mark: 0.87, theo: 0.757, mispricingPct: 0.149 },
];

describe('applyTheoFloor — TRA-2341 denominator guard', () => {
  it('suppresses the SPY underflow rows and keeps the genuine reads', () => {
    // Rank order as the scanner emits it: |mispricingPct| descending, so every
    // artifact sits ABOVE every real read. This is the defect — a limit=15
    // slice of this list is 100% artifact.
    const ranked = [...SPY_ARTIFACTS, ...REAL_READS];

    const result = applyTheoFloor(ranked, OTM_PANEL_THEO_FLOOR);

    expect(result.kept.map((c) => c.optionSymbol)).toEqual([
      'NVDA260831C00200000',
      'AAPL260831C00260000',
    ]);
    expect(result.suppressed).toBe(3);
    expect(result.floor).toBe(0.01);
    expect(result.maxSuppressedMispricingPct).toBeCloseTo(742.157, 3);
  });

  it('the whole default SPY panel is suppressed — 15 of 15 (the reported symptom)', () => {
    // Every row in the live SPY panel had theo below a tick; the ticket reports
    // the smallest ratio in the table as >= +1100%, i.e. theo <= mark/12.
    const spyPanel = Array.from({ length: 15 }, (_, i) => ({
      optionSymbol: `SPY260831P00${420 + i * 5}000`,
      mark: 0.095 + i * 0.008,
      theo: 0.000128 * (i + 1),
      mispricingPct: (0.095 + i * 0.008) / (0.000128 * (i + 1)) - 1,
    }));
    // Guard the fixture itself: if these ever stop being sub-tick the test
    // below would pass for the wrong reason.
    expect(spyPanel.every((c) => c.theo < OTM_PANEL_THEO_FLOOR)).toBe(true);

    const result = applyTheoFloor(spyPanel, OTM_PANEL_THEO_FLOOR);

    expect(result.kept).toHaveLength(0);
    expect(result.suppressed).toBe(15);
    // The panel must be able to SAY how absurd the discarded reads were rather
    // than rendering an empty table that reads like a thin chain.
    expect(result.maxSuppressedMispricingPct).toBeGreaterThan(700);
  });

  it('preserves rank order among the kept rows', () => {
    const ranked = [
      SPY_ARTIFACTS[0],
      REAL_READS[0],
      SPY_ARTIFACTS[1],
      REAL_READS[1],
    ];
    const result = applyTheoFloor(ranked, OTM_PANEL_THEO_FLOOR);
    expect(result.kept.map((c) => c.optionSymbol)).toEqual([
      'NVDA260831C00200000',
      'AAPL260831C00260000',
    ]);
  });

  it('keeps a contract sitting exactly ON the floor', () => {
    const onFloor = [{ optionSymbol: 'X', theo: 0.01, mispricingPct: 8.5 }];
    expect(applyTheoFloor(onFloor, OTM_PANEL_THEO_FLOOR).kept).toHaveLength(1);
  });

  it('floor of 0 disables the guard — the raw pre-TRA-2341 projection', () => {
    const ranked = [...SPY_ARTIFACTS, ...REAL_READS];
    const result = applyTheoFloor(ranked, 0);
    expect(result.kept).toHaveLength(5);
    expect(result.floor).toBe(0);
    expect(result.suppressed).toBe(0);
    expect(result.maxSuppressedMispricingPct).toBeNull();
  });

  it('a non-finite floor degrades to the legacy projection, not an empty table', () => {
    // `?minTheo=abc` -> Number('abc') is NaN. Every comparison against NaN is
    // false, so a naive `theo >= floor` would suppress EVERYTHING and the panel
    // would report a healthy scan of a thin chain. It must degrade the other way.
    const ranked = [...SPY_ARTIFACTS, ...REAL_READS];
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY * 0, -1]) {
      const result = applyTheoFloor(ranked, bad);
      expect(result.kept).toHaveLength(5);
      expect(result.floor).toBe(0);
    }
  });

  it('fails closed on a non-finite theo', () => {
    // An un-priced contract has no meaningful ratio at all, so it belongs on
    // the suppressed side of a DENOMINATOR guard — not admitted past it.
    const broken = [
      { optionSymbol: 'NAN', theo: Number.NaN, mispricingPct: Number.NaN },
      ...REAL_READS,
    ];
    const result = applyTheoFloor(broken, OTM_PANEL_THEO_FLOOR);
    expect(result.kept.map((c) => c.optionSymbol)).toEqual([
      'NVDA260831C00200000',
      'AAPL260831C00260000',
    ]);
    expect(result.suppressed).toBe(1);
    // A NaN ratio must not poison the reported max.
    expect(result.maxSuppressedMispricingPct).toBeNull();
  });

  it('empty input is a clean pass, not a suppression', () => {
    const result = applyTheoFloor([], OTM_PANEL_THEO_FLOOR);
    expect(result.kept).toHaveLength(0);
    expect(result.suppressed).toBe(0);
    expect(result.maxSuppressedMispricingPct).toBeNull();
  });
});
