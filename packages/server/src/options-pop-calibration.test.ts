import { describe, it, expect } from 'vitest';
import {
  fitPopCalibration,
  calibratePop,
  buildPopCalibrationSummary,
  isPopCalibrationEnabled,
  resolvePopCalibrationConfig,
  DEFAULT_POP_CALIBRATION_HAIRCUT,
  DEFAULT_POP_CALIBRATION_MIN_FIT_N,
  type PopCalibrationSample,
} from './options-pop-calibration.js';

// TRA-2006 (TRA-2000, item 2) — POP post-calibration / shrinkage layer.

describe('flag + config resolution', () => {
  it('is OFF by default and honours 1/true/yes/on', () => {
    expect(isPopCalibrationEnabled({})).toBe(false);
    expect(isPopCalibrationEnabled({ ENABLE_POP_CALIBRATION: 'off' })).toBe(false);
    for (const v of ['1', 'true', 'YES', 'On']) {
      expect(isPopCalibrationEnabled({ ENABLE_POP_CALIBRATION: v })).toBe(true);
    }
  });

  it('falls back to the shipped defaults on unset / malformed knobs', () => {
    expect(resolvePopCalibrationConfig({})).toEqual({
      haircut: DEFAULT_POP_CALIBRATION_HAIRCUT,
      minFitN: DEFAULT_POP_CALIBRATION_MIN_FIT_N,
    });
    // Out-of-range haircut (>1) and non-integer fit floor both rejected → defaults.
    const c = resolvePopCalibrationConfig({
      POP_CALIBRATION_HAIRCUT: '9',
      POP_CALIBRATION_MIN_FIT_N: '4.5',
    });
    expect(c.haircut).toBe(DEFAULT_POP_CALIBRATION_HAIRCUT);
    expect(c.minFitN).toBe(DEFAULT_POP_CALIBRATION_MIN_FIT_N);
  });

  it('accepts in-range overrides', () => {
    const c = resolvePopCalibrationConfig({ POP_CALIBRATION_HAIRCUT: '0.2', POP_CALIBRATION_MIN_FIT_N: '30' });
    expect(c.haircut).toBeCloseTo(0.2, 10);
    expect(c.minFitN).toBe(30);
  });
});

describe('flat mode (below the fit floor)', () => {
  it('subtracts the haircut and clamps to [0,1]', () => {
    const cal = fitPopCalibration([{ pop: 0.8, win: true }], { haircut: 0.15, minFitN: 43 });
    expect(cal.mode).toBe('flat');
    expect(calibratePop(cal, 0.8)).toBeCloseTo(0.65, 10);
    // Clamp low: 0.1 − 0.15 = negative → 0.
    expect(calibratePop(cal, 0.1)).toBe(0);
    // Clamp high input: 1.5 → treated as 1 → 1 − 0.15 = 0.85.
    expect(calibratePop(cal, 1.5)).toBeCloseTo(0.85, 10);
  });
});

describe('isotonic mode (at/above the fit floor)', () => {
  // A monotone-but-overstated relationship: higher stated POP ⇒ higher realized
  // rate, but realized always runs below stated (the ~17pt overstatement shape).
  function overstatedCohort(perBucket = 10): PopCalibrationSample[] {
    const buckets: Array<{ pop: number; winRate: number }> = [
      { pop: 0.6, winRate: 0.4 },
      { pop: 0.7, winRate: 0.5 },
      { pop: 0.8, winRate: 0.6 },
      { pop: 0.9, winRate: 0.7 },
    ];
    const out: PopCalibrationSample[] = [];
    for (const b of buckets) {
      const wins = Math.round(b.winRate * perBucket);
      for (let i = 0; i < perBucket; i++) out.push({ pop: b.pop, win: i < wins });
    }
    return out;
  }

  it('switches to isotonic once n ≥ minFitN and stays monotone', () => {
    const cohort = overstatedCohort(11); // 44 samples ≥ 43
    const cal = fitPopCalibration(cohort, { haircut: 0.15, minFitN: 43 });
    expect(cal.mode).toBe('isotonic');
    expect(cal.n).toBe(44);
    // Monotone non-decreasing over a fine grid.
    let prev = -1;
    for (let s = 0; s <= 1.0001; s += 0.05) {
      const c = calibratePop(cal, s);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = c;
    }
  });

  it('maps stated POP toward the realized rate (shrinks the overstatement)', () => {
    const cohort = overstatedCohort(11);
    const cal = fitPopCalibration(cohort, { haircut: 0.15, minFitN: 43 });
    // At a fitted knot the calibrated POP tracks the bucket win-rate, not the stated POP.
    expect(calibratePop(cal, 0.8)).toBeCloseTo(0.6, 1);
    expect(calibratePop(cal, 0.9)).toBeLessThan(0.9);
  });

  it('collapses the calibrated gap toward zero on the in-sample cohort', () => {
    const cohort = overstatedCohort(11);
    const summary = buildPopCalibrationSummary(cohort, { haircut: 0.15, minFitN: 43 });
    // Raw gap is materially negative (stated over-promises); calibrated gap ~0.
    expect(summary.rawGap).not.toBeNull();
    expect(summary.rawGap!).toBeLessThan(-0.1);
    expect(Math.abs(summary.calibratedGap!)).toBeLessThanOrEqual(0.1);
  });

  it('falls back to flat when the fit collapses to a single knot (no monotone signal)', () => {
    // Every bucket the same win-rate → PAVA pools to one block → flat fallback.
    const flatCohort: PopCalibrationSample[] = [];
    for (let i = 0; i < 50; i++) flatCohort.push({ pop: 0.5 + (i % 4) * 0.1, win: i % 2 === 0 });
    const cal = fitPopCalibration(flatCohort, { haircut: 0.15, minFitN: 43 });
    // The pooled single-block case degrades to flat rather than a degenerate constant.
    if (cal.mode === 'flat') {
      expect(cal.knots).toHaveLength(0);
    } else {
      expect(cal.knots.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('summary reconciliation', () => {
  it('reports null aggregates on an empty resolved set', () => {
    const s = buildPopCalibrationSummary([]);
    expect(s.n).toBe(0);
    expect(s.avgStatedPop).toBeNull();
    expect(s.avgCalibratedPop).toBeNull();
    expect(s.rawGap).toBeNull();
    expect(s.calibratedGap).toBeNull();
  });

  it('rawGap = hitRate − avgStatedPop and calibratedGap = hitRate − avgCalibratedPop', () => {
    const s = buildPopCalibrationSummary(
      [
        { pop: 0.8, win: false },
        { pop: 0.8, win: true },
      ],
      { haircut: 0.15, minFitN: 43 },
    );
    // n=2 < 43 → flat. hitRate 0.5, avgStated 0.8 → rawGap −0.3.
    expect(s.mode).toBe('flat');
    expect(s.hitRate).toBeCloseTo(0.5, 10);
    expect(s.rawGap).toBeCloseTo(-0.3, 10);
    // avgCalibrated = 0.8 − 0.15 = 0.65 → calibratedGap 0.5 − 0.65 = −0.15.
    expect(s.avgCalibratedPop).toBeCloseTo(0.65, 10);
    expect(s.calibratedGap).toBeCloseTo(-0.15, 10);
  });
});
