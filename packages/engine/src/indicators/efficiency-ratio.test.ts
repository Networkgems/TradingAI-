import { describe, it, expect } from 'vitest';
import { efficiencyRatio } from './efficiency-ratio.js';

describe('efficiencyRatio', () => {
  it('returns null when there are fewer than period+1 closes', () => {
    expect(efficiencyRatio([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10)).toBeNull();
  });

  it('returns null for a flat series (zero path length)', () => {
    expect(efficiencyRatio(Array(20).fill(100), 10)).toBeNull();
  });

  it('returns ~1 for a perfectly straight monotonic move', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i); // net == path
    const er = efficiencyRatio(closes, 10);
    expect(er).not.toBeNull();
    expect(er!).toBeCloseTo(1, 9);
  });

  it('returns ~0 for a pure back-and-forth (net ≈ 0, path large)', () => {
    // Oscillate 100,101,100,101,... — over an even window net == 0.
    const closes = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const er = efficiencyRatio(closes, 10);
    expect(er).not.toBeNull();
    expect(er!).toBeCloseTo(0, 9);
  });

  it('gives a mid value for a noisy-but-net-positive move', () => {
    // Net +5 over the window but with retracements so path > net.
    const closes = [100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105];
    const er = efficiencyRatio(closes, 10)!;
    expect(er).toBeGreaterThan(0);
    expect(er).toBeLessThan(1);
  });

  it('only uses the trailing period+1 closes', () => {
    // Leading noise should not affect the last-10-step window.
    const noisy = [50, 200, 10, 300];
    const clean = Array.from({ length: 11 }, (_, i) => 100 + i);
    expect(efficiencyRatio([...noisy, ...clean], 10)).toBeCloseTo(1, 9);
  });

  it('returns null for a non-integer or non-positive period', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(efficiencyRatio(closes, 0)).toBeNull();
    expect(efficiencyRatio(closes, 3.5)).toBeNull();
  });
});
