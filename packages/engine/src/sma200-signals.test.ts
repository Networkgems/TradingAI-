import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { atr } from './indicators/atr.js';
import { rsi } from './indicators/rsi.js';
import {
  evaluateSma200,
  smaSeries,
  SMA200_MIN_BARS,
} from './sma200-signals.js';

const DAY = 86_400_000;

/**
 * Build a daily candle series from an explicit close array. Highs/lows sit
 * `spread` either side of the close; open defaults to the prior close. A
 * `volumes` array (same length) overrides the default per-bar volume.
 */
function buildSeries(
  closes: number[],
  opts: {
    spread?: number;
    volumes?: number[];
    opens?: number[];
    highs?: number[];
    lows?: number[];
  } = {},
): Candle[] {
  const spread = opts.spread ?? 1;
  return closes.map((close, i) => {
    const open = opts.opens?.[i] ?? (i > 0 ? closes[i - 1] : close);
    const high = opts.highs?.[i] ?? Math.max(open, close) + spread;
    const low = opts.lows?.[i] ?? Math.min(open, close) - spread;
    return {
      symbol: 'TEST',
      timestamp: i * DAY,
      open,
      high,
      low,
      close,
      volume: opts.volumes?.[i] ?? 1_000_000,
    };
  });
}

/** Constant-close series of `n` bars at `price`. */
function flat(n: number, price: number): number[] {
  return new Array<number>(n).fill(price);
}

describe('smaSeries', () => {
  it('is NaN before the period fills, then the trailing mean', () => {
    const s = smaSeries([1, 2, 3, 4, 5], 3);
    expect(s[0]).toBeNaN();
    expect(s[1]).toBeNaN();
    expect(s[2]).toBeCloseTo(2); // (1+2+3)/3
    expect(s[3]).toBeCloseTo(3); // (2+3+4)/3
    expect(s[4]).toBeCloseTo(4); // (3+4+5)/3
  });

  it('returns all-NaN when shorter than the period', () => {
    expect(smaSeries([1, 2], 5).every(Number.isNaN)).toBe(true);
  });
});

describe('evaluateSma200 — guardrails & insufficient data', () => {
  it('rejects series shorter than the minimum bar count', () => {
    const res = evaluateSma200('TEST', buildSeries(flat(SMA200_MIN_BARS - 1, 100)));
    expect(res.indicators).toBeNull();
    expect(res.signals).toHaveLength(0);
    expect(res.rejectReason).toMatch(/daily bars/);
  });

  it('flags sub-$3 micro-caps as failing the liquidity floor', () => {
    const res = evaluateSma200('TEST', buildSeries(flat(260, 2)));
    expect(res.indicators).not.toBeNull();
    expect(res.liquidityOk).toBe(false);
    expect(res.signals).toHaveLength(0);
  });

  it('fails the liquidity floor when 20d avg dollar volume is under $5M', () => {
    // price $10, volume 100k → $1M/day average dollar volume.
    const res = evaluateSma200('TEST', buildSeries(flat(260, 10), { volumes: flat(260, 100_000) }));
    expect(res.indicators?.avgDollarVol20).toBeCloseTo(1_000_000);
    expect(res.liquidityOk).toBe(false);
  });

  it('passes the liquidity floor at price ≥ $3 and ≥ $5M dollar volume', () => {
    const res = evaluateSma200('TEST', buildSeries(flat(260, 10), { volumes: flat(260, 1_000_000) }));
    expect(res.liquidityOk).toBe(true);
  });
});

describe('evaluateSma200 — indicator math', () => {
  it('computes SMA200/SMA50/ATR/RSI/AvgVol/RVOL/dist_atr on a flat series', () => {
    const closes = flat(250, 100);
    const volumes = flat(250, 1_000_000);
    volumes[249] = 2_000_000; // today prints double the usual volume
    const res = evaluateSma200('TEST', buildSeries(closes, { spread: 1, volumes }));
    const ind = res.indicators!;
    expect(ind.sma200).toBeCloseTo(100);
    expect(ind.sma50).toBeCloseTo(100);
    expect(ind.sma200Rising).toBe(false); // flat ⇒ not strictly rising
    expect(ind.atr14).toBeCloseTo(2); // true range is a constant 2
    expect(ind.rsi14).toBeCloseTo(100); // no losses on a flat series
    // avgVol20 = (19×1.0M + 2.0M) / 20 = 1.05M
    expect(ind.avgVol20).toBeCloseTo(1_050_000);
    expect(ind.rvol).toBeCloseTo(2_000_000 / 1_050_000);
    expect(ind.distAtr).toBeCloseTo(0); // close sits exactly on SMA200
  });

  it('matches the standalone atr() / rsi() helpers', () => {
    // gentle uptrend so RSI and ATR are non-degenerate
    const closes = Array.from({ length: 260 }, (_, i) => 50 + i * 0.1);
    const candles = buildSeries(closes, { spread: 0.5 });
    const res = evaluateSma200('TEST', candles);
    expect(res.indicators!.atr14).toBeCloseTo(atr(candles, 14)!);
    expect(res.indicators!.rsi14).toBeCloseTo(rsi(closes, 14));
  });

  it('reports SMA200 rising when recent closes outrun older ones', () => {
    // 130 bars low, then 130 bars higher ⇒ SMA200 slope positive
    const closes = [...flat(130, 80), ...flat(130, 120)];
    const res = evaluateSma200('TEST', buildSeries(closes));
    expect(res.indicators!.sma200Rising).toBe(true);
  });
});

describe('evaluateSma200 — Signal 1 trend/quality filter', () => {
  it('flags uptrend-quality when close > SMA200 (rising) and close > SMA50', () => {
    // step up: 100 bars @ 75, then 159 bars @ 105, final bar 110 so today's
    // close clears SMA50 (which sits at 105) rather than merely matching it.
    const closes = [...flat(100, 75), ...flat(159, 105), 110];
    const res = evaluateSma200('TEST', buildSeries(closes));
    expect(res.trendQuality).toBe(true);
  });

  it('does not flag trend-quality when price is below SMA200', () => {
    // step down: 100 bars @ 120, then 160 bars @ 80 ⇒ price below SMA200
    const closes = [...flat(100, 120), ...flat(160, 80)];
    const res = evaluateSma200('TEST', buildSeries(closes));
    expect(res.trendQuality).toBe(false);
    expect(res.signals).toHaveLength(0);
  });
});

/**
 * Signal 2 v2 fixture (TRA-458) — an established uptrend (200-SMA rising well
 * above the 2.0% slope gate, price above both MAs) that prints a sharp 4-bar
 * pullback whose low wicks down toward the 200-SMA, then a decisive up-close
 * that finishes above the highs of *both* prior bars (the v2 trigger).
 *
 * `opts.flattenSlope` lifts an early-base slab so the 200-SMA's trailing
 * 20-bar slope drops under the 2.0% gate — without touching the pullback
 * shape, trend-quality, hold or trigger. `opts.maskTrigger` towers the t-1
 * bar's high over today's close so the decisive-up-close trigger cannot fire.
 */
function pullbackSeries(
  opts: { flattenSlope?: boolean; maskTrigger?: boolean; spread?: number } = {},
): Candle[] {
  // 100 bars @ 70, then a 144-bar grind up ⇒ rising SMA200 well below price.
  const base = flat(100, 70);
  const ramp = Array.from({ length: 144 }, (_, i) => 90 + i * 0.13); // 90 → ~108.6
  // Tail: a 4-bar pullback in the closes, then today's decisive up-close.
  const tail = [107, 104, 101, 99, 98, 108];
  const closes = [...base, ...ramp, ...tail]; // 250 bars
  // Lift an early-base slab (indices 30–46, clear of every trailing window
  // except the t-20 200-SMA) so the 20-bar slope falls under the 2.0% gate.
  if (opts.flattenSlope) {
    for (let i = 30; i <= 46; i++) closes[i] = 95;
  }
  // The t-1 bar wicks its low down to the 200-SMA (≈ 92) — the pullback touch.
  const lows: number[] = [];
  lows[closes.length - 2] = 91;
  // Mask the trigger: the t-1 bar's high towers above today's close.
  const highs: number[] = [];
  if (opts.maskTrigger) highs[closes.length - 2] = 112;
  // TRA-3688 — a wider per-bar spread inflates ATR(14) without moving any
  // close, which lowers dist_atr on the same fire-bar shape: spread 1 ⇒
  // dist_atr ≈ 4.20 (the reject arm), spread 4 ⇒ ≈ 1.66 (the admit arm).
  return buildSeries(closes, { spread: opts.spread ?? 1, lows, highs });
}

describe('evaluateSma200 — Signal 2 v2 pullback-to-200 bounce', () => {
  it('fires a continuation long on a decisive up-close above both prior highs', () => {
    const candles = pullbackSeries();
    const res = evaluateSma200('TEST', candles);
    const sig = res.signals.find(s => s.kind === 'sma200_pullback');
    expect(sig).toBeDefined();
    expect(sig!.label).toMatch(/continuation/);
    expect(sig!.trendQuality).toBe(true);
    // stop = SMA200 − 1.0 × ATR
    const ind = res.indicators!;
    expect(sig!.stop).toBeCloseTo(ind.sma200 - ind.atr14);
    expect(sig!.entry).toBeCloseTo(candles[candles.length - 1].close);
    // the v2 trigger: today's close cleared the highs of both prior bars.
    const t = candles.length - 1;
    expect(candles[t].close).toBeGreaterThan(candles[t - 1].high);
    expect(candles[t].close).toBeGreaterThan(candles[t - 2].high);
  });

  it('does not fire when the 200-SMA 20-bar slope is under the 2.0% gate', () => {
    const candles = pullbackSeries({ flattenSlope: true });
    const res = evaluateSma200('TEST', candles);
    // trend-quality still holds — the slope-strength gate is the only block.
    expect(res.trendQuality).toBe(true);
    expect(res.signals.find(s => s.kind === 'sma200_pullback')).toBeUndefined();
  });

  it('does not fire without a decisive up-close above both prior bars highs', () => {
    const candles = pullbackSeries({ maskTrigger: true });
    const res = evaluateSma200('TEST', candles);
    // trend-quality + slope gate both hold — only the trigger fails.
    expect(res.trendQuality).toBe(true);
    expect(res.signals.find(s => s.kind === 'sma200_pullback')).toBeUndefined();
  });

  it('does not fire when the symbol is not uptrend-quality', () => {
    // same pullback shape but on a downtrending base ⇒ Signal 1 false
    const base = [...flat(100, 130), ...flat(130, 100)];
    const tail = [99, 97, 95, 93, 95, 97, 99, 101, 103, 105];
    const closes = [...base, ...tail].slice(0, 260);
    const res = evaluateSma200('TEST', buildSeries(closes, { spread: 1.5 }));
    expect(res.signals.find(s => s.kind === 'sma200_pullback')).toBeUndefined();
  });
});

// TRA-3688 — C1 record-the-ruler fields + the S-1 max-dist entry gate.
describe('evaluateSma200 — TRA-3688 C1 ruler fields', () => {
  it('stamps atr14 / stopAtr / stopBasis / maxDistAtr on a pullback, with both AC3 identities', () => {
    const candles = pullbackSeries();
    const res = evaluateSma200('TEST', candles);
    const sig = res.signals.find(s => s.kind === 'sma200_pullback')!;
    const ind = res.indicators!;
    // AC2 shape — finite and positive, not merely non-null (a NaN passes a
    // null check and lands in the permissive branch, TRA-3440).
    expect(Number.isFinite(sig.atr14) && sig.atr14 > 0).toBe(true);
    expect(Number.isFinite(sig.stopAtr) && sig.stopAtr > 0).toBe(true);
    expect(sig.atr14).toBeCloseTo(ind.atr14, 10);
    expect(sig.stopBasis).toBe('sma200_minus_1atr');
    // Gate dark by default ⇒ the stamped regime is Infinity.
    expect(sig.maxDistAtr).toBe(Infinity);
    // AC3, both equalities. The first (stopAtr = distAtr + 1) can pass even
    // with a wrong atr14; only the second ((entry − stop) / atr14 = stopAtr)
    // separates a correct ruler from a plausible-but-wrong one.
    expect(Math.abs(sig.stopAtr - (sig.distAtr + 1.0))).toBeLessThan(1e-6);
    expect(Math.abs((sig.entry - sig.stop) / sig.atr14 - sig.stopAtr)).toBeLessThan(1e-3);
  });

  it('stamps the ruler on a reclaim too — stopAtr is the MEASURED distance (no +1 identity)', () => {
    const { candles } = reclaimSeries();
    const res = evaluateSma200('TEST', candles);
    const sig = res.signals.find(s => s.kind === 'sma200_reclaim')!;
    expect(Number.isFinite(sig.atr14) && sig.atr14 > 0).toBe(true);
    expect(sig.stopBasis).toBe('min_swinglow_sma200_minus_1p5atr');
    expect(sig.maxDistAtr).toBe(Infinity);
    // AC3's second (load-bearing) equality holds for the reclaim as well.
    expect(Math.abs((sig.entry - sig.stop) / sig.atr14 - sig.stopAtr)).toBeLessThan(1e-3);
  });
});

describe('evaluateSma200 — TRA-3688 S-1 max-dist gate (ships DARK)', () => {
  // AC4 requires BOTH arms: a gate exercised only on its reject arm proves
  // nothing. spread 1 puts the fire bar ≈ 4.2 ATRs over the 200-SMA (the
  // NBIS/KOPN shape — a momentum breakout wearing a pullback's clothes);
  // spread 4 puts the SAME bar shape ≈ 1.66 ATRs over.
  it('MAX_DIST_ATR = 2.0 REJECTS a fire bar with dist_atr ≈ 4.2', () => {
    const candles = pullbackSeries();
    // Control: the identical series fires with the gate dark…
    const ungated = evaluateSma200('TEST', candles);
    const fired = ungated.signals.find(s => s.kind === 'sma200_pullback');
    expect(fired).toBeDefined();
    expect(fired!.distAtr).toBeGreaterThan(2.0);
    expect(fired!.distAtr).toBeCloseTo(4.2, 0);
    // …so the gate is the ONLY thing standing between this bar and the feed.
    const gated = evaluateSma200('TEST', candles, { pullbackMaxDistAtr: 2.0 });
    expect(gated.signals.find(s => s.kind === 'sma200_pullback')).toBeUndefined();
  });

  it('MAX_DIST_ATR = 2.0 ADMITS a fire bar with dist_atr ≈ 1.66, stamped with the gate value', () => {
    const candles = pullbackSeries({ spread: 4 });
    const res = evaluateSma200('TEST', candles, { pullbackMaxDistAtr: 2.0 });
    const sig = res.signals.find(s => s.kind === 'sma200_pullback');
    expect(sig).toBeDefined();
    expect(sig!.distAtr).toBeLessThan(2.0);
    expect(sig!.distAtr).toBeCloseTo(1.66, 1);
    expect(sig!.maxDistAtr).toBe(2.0);
    // The stop stays STRUCTURAL under the gate — reject-not-clamp.
    const ind = res.indicators!;
    expect(sig!.stop).toBeCloseTo(ind.sma200 - ind.atr14);
  });

  it('the shipped default (no opts) is byte-identical to an explicit Infinity — zero behavior change', () => {
    const candles = pullbackSeries();
    const dflt = evaluateSma200('TEST', candles);
    const inf = evaluateSma200('TEST', candles, { pullbackMaxDistAtr: Infinity });
    expect(dflt.signals).toEqual(inf.signals);
    expect(dflt.signals.length).toBeGreaterThan(0);
  });

  it('a non-positive or non-finite gate value means DARK, never reject-everything (TRA-3440 guard)', () => {
    const candles = pullbackSeries();
    for (const bad of [0, -1, NaN]) {
      const res = evaluateSma200('TEST', candles, { pullbackMaxDistAtr: bad });
      expect(res.signals.find(s => s.kind === 'sma200_pullback')).toBeDefined();
    }
  });

  it('does not gate the reclaim (S-1 is pullback-only)', () => {
    const { candles } = reclaimSeries();
    const res = evaluateSma200('TEST', candles, { pullbackMaxDistAtr: 0.001 });
    expect(res.signals.find(s => s.kind === 'sma200_reclaim')).toBeDefined();
  });
});

/**
 * Signal 3 fixture — a long basing range that sits below an (elevated) 200-SMA
 * and reclaims it on a volume surge. The base chops in an 88–98 band so the
 * reclaim bar does not blow out the 15-bar range (basing stays intact).
 */
function reclaimSeries(): { candles: Candle[]; volumes: number[] } {
  // 140 bars @ 106 hold the SMA200 up near ~99.
  const base = flat(140, 106);
  // 109 bars chopping in a tight 88–98 triangle — every bar below the SMA200.
  const grind = Array.from({ length: 109 }, (_, i) => {
    const phase = i % 10;
    return phase <= 5 ? 88 + 2 * phase : 88 + 2 * (10 - phase);
  });
  // Reclaim day: first close back above the 200-SMA in months.
  const closes = [...base, ...grind, 100]; // 250 bars
  const volumes = flat(closes.length, 1_000_000);
  volumes[closes.length - 1] = 2_500_000; // RVOL ≈ 2.3 on the reclaim bar
  return { candles: buildSeries(closes, { spread: 1, volumes }), volumes };
}

describe('evaluateSma200 — Signal 3 200-SMA reclaim reversal', () => {
  it('fires a trend-change swing with a volume-confirmed reclaim', () => {
    const { candles } = reclaimSeries();
    const res = evaluateSma200('TEST', candles);
    const sig = res.signals.find(s => s.kind === 'sma200_reclaim');
    expect(sig).toBeDefined();
    expect(res.indicators!.rvol).toBeGreaterThanOrEqual(1.5);
    expect(sig!.entry).toBeCloseTo(candles[candles.length - 1].close);
    expect(sig!.label).toMatch(/reclaim/);
  });

  it('does not fire the reclaim without the volume confirmation', () => {
    const { candles } = reclaimSeries();
    // overwrite the reclaim bar's volume so RVOL < 1.5
    const flatVol = candles.map((c, i) =>
      i === candles.length - 1 ? { ...c, volume: 1_000_000 } : c,
    );
    const res = evaluateSma200('TEST', flatVol);
    expect(res.signals.find(s => s.kind === 'sma200_reclaim')).toBeUndefined();
  });

  it('does not fire the reclaim when there was no prior down regime', () => {
    // price was already above its SMA200 the whole time ⇒ no reclaim
    const closes = [...flat(130, 90), ...flat(129, 110), 112].slice(0, 260);
    const volumes = flat(closes.length, 1_000_000);
    volumes[closes.length - 1] = 3_000_000;
    const res = evaluateSma200('TEST', buildSeries(closes, { volumes }));
    expect(res.signals.find(s => s.kind === 'sma200_reclaim')).toBeUndefined();
  });
});
