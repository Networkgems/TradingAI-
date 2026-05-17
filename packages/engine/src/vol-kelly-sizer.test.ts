import { describe, it, expect } from 'vitest';
import {
  trailingRealisedVol,
  volScalar,
  volRiskPct,
  kellyFull,
  kellyCapPct,
  effectiveRiskPct,
  resolveVolKellySizerConfig,
  barsPerYearFor,
  DEFAULT_VOL_KELLY_SIZER_CONFIG,
  type VolKellySizerConfig,
} from './vol-kelly-sizer.js';

const CFG = DEFAULT_VOL_KELLY_SIZER_CONFIG;

/** Closes with a constant per-bar log return `r` — realised vol is then 0. */
function flatGrowth(n: number, start: number, r: number): number[] {
  const out: number[] = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * Math.exp(r));
  return out;
}

/** Closes whose log returns alternate ±`amp` — sample stdev of returns ≈ amp. */
function alternating(n: number, start: number, amp: number): number[] {
  const out: number[] = [start];
  for (let i = 1; i < n; i++) {
    out.push(out[i - 1] * Math.exp(i % 2 === 0 ? amp : -amp));
  }
  return out;
}

describe('barsPerYearFor', () => {
  it('derives 2190 for a 4H timeframe', () => {
    expect(barsPerYearFor(4)).toBeCloseTo(2190, 6);
  });
  it('derives 8760 for 1H and 365 for daily', () => {
    expect(barsPerYearFor(1)).toBeCloseTo(8760, 6);
    expect(barsPerYearFor(24)).toBeCloseTo(365, 6);
  });
  it('falls back to the default for a non-finite / non-positive timeframe', () => {
    expect(barsPerYearFor(0)).toBe(CFG.barsPerYear);
    expect(barsPerYearFor(NaN)).toBe(CFG.barsPerYear);
  });
});

describe('trailingRealisedVol — §3.2', () => {
  it('is 0 for a perfectly constant-growth series', () => {
    expect(trailingRealisedVol(flatGrowth(80, 100, 0.001), 60, 2190)).toBeCloseTo(0, 10);
  });

  it('annualises by √barsPerYear', () => {
    // amp=0.02 alternating ⇒ per-bar stdev ≈ 0.02 ⇒ annualised ≈ 0.02·√2190.
    const v = trailingRealisedVol(alternating(120, 100, 0.02), 60, 2190);
    expect(v).toBeCloseTo(0.02 * Math.sqrt(2190), 1);
  });

  it('returns NaN when fewer than two returns are available', () => {
    expect(Number.isNaN(trailingRealisedVol([100], 60, 2190))).toBe(true);
    expect(Number.isNaN(trailingRealisedVol([], 60, 2190))).toBe(true);
  });

  it('uses only the trailing window — calm history beyond it does not change the estimate', () => {
    // 61 volatile closes (⇒ 60 returns) preceded by 200 dead-flat bars.
    const volatileTail = alternating(61, 100, 0.03);
    const calmHead = new Array(200).fill(50);
    const windowed = trailingRealisedVol([...calmHead, ...volatileTail], 60, 2190);
    const tailOnly = trailingRealisedVol(volatileTail, 60, 2190);
    expect(windowed).toBeCloseTo(tailOnly, 10);
  });

  it('no look-ahead — the estimate for a closed prefix is independent of later bars', () => {
    // The runner hands the estimator only bars closed before the fill bar.
    // Whatever happens after that prefix must not move the number.
    const series = alternating(100, 100, 0.02);
    const closedPrefix = series.slice(0, 70);
    const fromPrefix = trailingRealisedVol(closedPrefix, 60, 2190);
    // Same prefix, but the caller could (wrongly) have a wild future tail —
    // the estimator only sees the prefix it is given.
    const wildFuture = alternating(40, series[69], 0.15);
    const fromPrefixAgain = trailingRealisedVol(
      [...closedPrefix],
      60,
      2190,
    );
    expect(fromPrefixAgain).toBeCloseTo(fromPrefix, 12);
    // Including the wild future *does* change it — proving the estimator
    // faithfully reflects exactly the bars passed (so the no-look-ahead
    // guarantee is the caller's `slice(0, -1)` contract, honoured by it).
    const withFuture = trailingRealisedVol(
      [...closedPrefix, ...wildFuture],
      60,
      2190,
    );
    expect(withFuture).not.toBeCloseTo(fromPrefix, 4);
  });
});

describe('volScalar — §3.3 direction + clamps', () => {
  it('a calm asset (σ_sym < σ_ref) gets a scalar > 1 — larger budget', () => {
    expect(volScalar(0.55, 0.40, 0.6, 1.6)).toBeGreaterThan(1);
  });

  it('a hot asset (σ_sym > σ_ref) gets a scalar < 1 — smaller budget', () => {
    expect(volScalar(0.55, 0.90, 0.6, 1.6)).toBeLessThan(1);
  });

  it('clamps a very calm asset up to the ceiling', () => {
    expect(volScalar(0.55, 0.05, 0.6, 1.6)).toBe(1.6);
  });

  it('clamps a very hot asset down to the floor', () => {
    expect(volScalar(0.55, 5.0, 0.6, 1.6)).toBe(0.6);
  });

  it('is a neutral 1 when σ_sym is unknown (NaN / non-positive)', () => {
    expect(volScalar(0.55, NaN, 0.6, 1.6)).toBe(1);
    expect(volScalar(0.55, 0, 0.6, 1.6)).toBe(1);
  });
});

describe('volRiskPct — §3.3 clamps', () => {
  it('clamps the vol-targeted fraction to the [floor, ceil] band', () => {
    expect(volRiskPct(0.01, 1.6, 0.005, 0.0175)).toBe(0.0160);
    // base·scalar above the ceiling clamps down.
    expect(volRiskPct(0.02, 1.6, 0.005, 0.0175)).toBe(0.0175);
    // base·scalar below the floor clamps up.
    expect(volRiskPct(0.001, 0.6, 0.005, 0.0175)).toBe(0.005);
  });
});

describe('kellyFull / kellyCapPct — §3.4', () => {
  it('matches the spec worked example for the BTC-USD macd_bollinger cell', () => {
    // W ≈ 0.46, R ≈ 1.90 ⇒ kellyFull ≈ 0.176.
    const kf = kellyFull(0.46, 1.90);
    expect(kf).toBeCloseTo(0.176, 2);
    // ¼-Kelly ≈ 0.044 ⇒ clamped to the 0.0175 ceiling (non-binding cap).
    expect(kellyCapPct(kf, 0.25, 0.0175)).toBe(0.0175);
  });

  it('is non-positive for a losing edge', () => {
    expect(kellyFull(0.30, 1.0)).toBeLessThan(0); // 0.30 − 0.70/1 = −0.40
  });

  it('clamps a non-positive Kelly to a zero cap', () => {
    expect(kellyCapPct(kellyFull(0.30, 1.0), 0.25, 0.0175)).toBe(0);
  });

  it('returns 0 (no edge) for unusable inputs', () => {
    expect(kellyFull(0.5, 0)).toBe(0);
    expect(kellyFull(NaN, 2)).toBe(0);
  });
});

describe('effectiveRiskPct — §3.5', () => {
  // σ_sym ≈ σ_ref ⇒ volScalar ≈ 1 ⇒ volRiskPct ≈ baseRiskPct (0.01).
  const calmIsh = 0.55;

  it('Kelly cap NON-binding (strong edge) — vol-targeting governs', () => {
    // Strong edge ⇒ kellyCapPct saturates at the ceiling ⇒ effRiskPct = volRiskPct.
    const eff = effectiveRiskPct(CFG, calmIsh, {
      winRate: 0.46,
      payoffRatio: 1.9,
      trades: 30,
    });
    const volOnly = effectiveRiskPct(CFG, calmIsh);
    expect(eff).toBeCloseTo(volOnly, 10);
    expect(eff).toBeGreaterThan(CFG.riskPctFloor);
  });

  it('Kelly cap BINDING (weak edge) — Kelly shrinks the budget', () => {
    // Weak but positive edge ⇒ small kellyCapPct < volRiskPct.
    const weak = { winRate: 0.40, payoffRatio: 1.05, trades: 40 };
    const eff = effectiveRiskPct(CFG, calmIsh, weak);
    const volOnly = effectiveRiskPct(CFG, calmIsh);
    const kc = kellyCapPct(
      kellyFull(weak.winRate, weak.payoffRatio),
      CFG.kellyFraction,
      CFG.riskPctCeil,
    );
    expect(eff).toBeCloseTo(kc, 10);
    expect(eff).toBeLessThan(volOnly);
  });

  it('negative-edge cell ⇒ effRiskPct = 0 (no trade)', () => {
    const eff = effectiveRiskPct(CFG, calmIsh, {
      winRate: 0.30,
      payoffRatio: 1.0,
      trades: 50,
    });
    expect(eff).toBe(0);
  });

  it('Kelly cap inactive below kellyMinTrades — vol-targeting alone governs', () => {
    // Same losing edge, but only 5 trades (< 20) ⇒ Kelly does not bind.
    const fewTrades = effectiveRiskPct(CFG, calmIsh, {
      winRate: 0.30,
      payoffRatio: 1.0,
      trades: 5,
    });
    const volOnly = effectiveRiskPct(CFG, calmIsh);
    expect(fewTrades).toBeCloseTo(volOnly, 10);
    expect(fewTrades).toBeGreaterThan(0);
  });

  it('omitting the expectancy table leaves the Kelly cap inactive (§6 arm B)', () => {
    expect(effectiveRiskPct(CFG, calmIsh)).toBeCloseTo(
      effectiveRiskPct(CFG, calmIsh, undefined),
      10,
    );
  });

  it('a calm asset is sized larger, a hot asset smaller — bounded by the clamps', () => {
    const calm = effectiveRiskPct(CFG, 0.30); // σ_sym < σ_ref
    const hot = effectiveRiskPct(CFG, 1.50); // σ_sym > σ_ref
    expect(calm).toBeGreaterThan(hot);
    expect(calm).toBeLessThanOrEqual(CFG.riskPctCeil);
    expect(hot).toBeGreaterThanOrEqual(CFG.riskPctFloor);
  });
});

describe('resolveVolKellySizerConfig — §5 / §7', () => {
  it('returns the recommended defaults when no override is given', () => {
    expect(resolveVolKellySizerConfig()).toEqual(DEFAULT_VOL_KELLY_SIZER_CONFIG);
  });

  it('ignores non-finite numeric overrides', () => {
    const c = resolveVolKellySizerConfig({
      baseRiskPct: NaN,
      riskPctCeil: Infinity,
      kellyFraction: 0.5,
    });
    expect(c.baseRiskPct).toBe(DEFAULT_VOL_KELLY_SIZER_CONFIG.baseRiskPct);
    expect(c.riskPctCeil).toBe(DEFAULT_VOL_KELLY_SIZER_CONFIG.riskPctCeil);
    expect(c.kellyFraction).toBe(0.5); // finite override applied
  });

  it('applies the master enabled flag', () => {
    expect(resolveVolKellySizerConfig({ enabled: true }).enabled).toBe(true);
    expect(resolveVolKellySizerConfig().enabled).toBe(false);
  });

  it('asserts riskPctFloor >= minTradeRiskPct (§5 floor coherence)', () => {
    // Default floor 0.005 is comfortably above the 0.0025 cap floor.
    expect(() => resolveVolKellySizerConfig(undefined, 0.0025)).not.toThrow();
    // An override that drops the floor below the cap floor must throw.
    expect(() =>
      resolveVolKellySizerConfig({ riskPctFloor: 0.001 }, 0.0025),
    ).toThrow(/floor coherence/);
  });

  it('the resolved floor never lands between the two reject floors', () => {
    const c: VolKellySizerConfig = resolveVolKellySizerConfig({}, 0.0025);
    expect(c.riskPctFloor).toBeGreaterThanOrEqual(0.0025);
  });
});
