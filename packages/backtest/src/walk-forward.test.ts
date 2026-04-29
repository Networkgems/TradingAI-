import { describe, it, expect } from 'vitest';
import { buildWindows } from './walk-forward.js';

describe('buildWindows', () => {
  it('produces non-overlapping train/test slices when step = testBars (default)', () => {
    const windows = buildWindows(300, 60, 30);
    // Each origin = i*30, valid while origin + 60 + 30 ≤ 300 → origin ≤ 210 → 8 windows.
    expect(windows).toHaveLength(8);
    expect(windows[0]).toEqual({ trainStart: 0, trainEnd: 60, testStart: 60, testEnd: 90 });
    expect(windows[1]).toEqual({ trainStart: 30, trainEnd: 90, testStart: 90, testEnd: 120 });
    expect(windows[windows.length - 1].testEnd).toBeLessThanOrEqual(300);
  });

  it('returns no windows when the series is shorter than train+test', () => {
    expect(buildWindows(50, 60, 30)).toEqual([]);
    expect(buildWindows(89, 60, 30)).toEqual([]);
    expect(buildWindows(90, 60, 30)).toHaveLength(1);
  });

  it('honours custom step size', () => {
    const windows = buildWindows(300, 60, 30, 60);
    // origin advances by 60: 0, 60, 120, 180, 210 (210+60+30=300 ✓), 240+60+30=330 ✗
    expect(windows.map(w => w.trainStart)).toEqual([0, 60, 120, 180]);
  });

  it('keeps train and test windows contiguous (test starts at trainEnd)', () => {
    const windows = buildWindows(500, 100, 50);
    for (const w of windows) {
      expect(w.testStart).toBe(w.trainEnd);
      expect(w.trainEnd - w.trainStart).toBe(100);
      expect(w.testEnd - w.testStart).toBe(50);
    }
  });
});
