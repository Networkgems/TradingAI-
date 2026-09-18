/**
 * TRA-4706 — deterministic grades for the TRA-4570/4626 swing scanners, the
 * fusion composite, and the engine pass wiring. Replaces the `Math.random`
 * fixtures of `scripts/swing-scanner-mock-test.mjs` (which failed 2 of 3).
 *
 * ⛔ Every NEGATIVE fixture is paired with a MUTATION ARM: the same fixture with
 * only the gate it is named for relaxed through config must FIRE. A negative
 * that stays null with its own gate relaxed is being rejected by some other
 * branch, and proves nothing about the one it names.
 */
import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import { scanPanicReversal, wingSkew } from './panic-reversal-scanner.js';
import { scanMomentumBreakoutIvLag } from './momentum-breakout-iv-lag-scanner.js';
import { scanPostEarningsIvCrush, findEarningsReaction } from './post-earnings-iv-crush-scanner.js';
import { scanAndRankSwingSignals, calculateCompositeScore } from './swing-signal-fusion.js';
import { runSwingSignalPass, type SwingPassDeps } from './swing-signal-pass.js';
import { underlyingRiskReward, barDay } from './swing-scanner-common.js';

const DAY = 86_400_000;
/** 2026-09-18 15:00Z — every DTE below is measured from here. */
const AS_OF = Date.UTC(2026, 8, 18, 15, 0);
/** ~35 DTE from AS_OF: inside every scanner's band. */
const EXPIRY = '2026-10-23';

/** Daily bars from closes; the LAST bar is the session before AS_OF. */
function dailyBars(closes: number[], opts: { volumes?: number[]; opens?: number[]; highs?: number[] } = {}): Candle[] {
  const n = closes.length;
  return closes.map((close, i) => {
    const open = opts.opens?.[i] ?? close;
    return {
      symbol: 'X',
      timestamp: Date.UTC(2026, 8, 17, 13, 30) - (n - 1 - i) * DAY,
      open,
      high: opts.highs?.[i] ?? Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      close,
      volume: opts.volumes?.[i] ?? 1_000_000,
    };
  });
}

/** One-expiry chain, strikes 85%–115% of spot. `putWingSlope` lifts put IV as strikes go OTM. */
function chain(spot: number, opts: { baseIv?: number; putWingSlope?: number; bid?: number; ask?: number } = {}): OptionChainRow[] {
  const base = opts.baseIv ?? 0.30;
  const rows: OptionChainRow[] = [];
  for (let pct = 85; pct <= 115; pct++) {
    const strike = Math.round(spot * pct) / 100;
    for (const optionType of ['call', 'put'] as const) {
      const wing = optionType === 'put' && strike < spot ? (opts.putWingSlope ?? 0) * (1 - strike / spot) : 0;
      rows.push({
        optionSymbol: `X${EXPIRY}${optionType[0]}${strike}`,
        underlying: 'X',
        optionType,
        strike,
        expiration: EXPIRY,
        bid: opts.bid ?? 1.0,
        ask: opts.ask ?? 1.1,
        midIv: base + wing,
      });
    }
  }
  return rows;
}

// ── Panic reversal ────────────────────────────────────────────────────────────

/** Uptrend to a peak, a 5-bar drop of `drop` per bar, then two bounce bars. */
function panicBars(drop: number, bounce: [number, number] = [1.2, 1.0]): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i <= 104; i++) closes.push(100 + 0.2 * i); // peak 120.8 at 104
  for (let i = 0; i < 5; i++) closes.push(closes[closes.length - 1] - drop);
  closes.push(closes[closes.length - 1] + bounce[0]);
  closes.push(closes[closes.length - 1] + bounce[1]);
  return dailyBars(closes);
}

function panicInput(bars: Candle[]) {
  const spot = bars[bars.length - 1].close;
  return {
    symbol: 'X',
    candles: bars,
    optionChain: chain(spot, { baseIv: 0.33, putWingSlope: 2.4 }),
    ivRank: 75,
    currentPrice: spot,
    atr: 2.5,
    asOf: AS_OF,
  };
}

describe('scanPanicReversal (daily bars)', () => {
  it('POSITIVE: a ≥5% peak-to-trough drop, a bounce, RSI ≥ 35, wing skew ⇒ an OTM call', () => {
    const sig = scanPanicReversal(panicInput(panicBars(1.7)));
    expect(sig).not.toBeNull();
    expect(sig!.recentDeclinePct).toBeLessThanOrEqual(-5);
    expect(sig!.bouncePct).toBeGreaterThan(0);
    expect(sig!.rsi).toBeGreaterThanOrEqual(35);
    expect(sig!.optionType).toBe('call');
    expect(sig!.strike).toBeGreaterThan(sig!.underlyingPrice);
    expect(sig!.delta).toBeGreaterThanOrEqual(0.25);
    expect(sig!.delta).toBeLessThanOrEqual(0.40);
  });

  it('NEGATIVE: a 2% drawdown is not a panic — and relaxing ONLY minDeclinePct makes it fire', () => {
    const input = panicInput(panicBars(0.5, [0.5, 0.5]));
    expect(scanPanicReversal(input)).toBeNull();
    // mutation arm: the named gate is the only thing standing in the way
    expect(scanPanicReversal(input, { minDeclinePct: 1.5 })).not.toBeNull();
  });

  it('NEGATIVE: no bounce yet (trough is the latest bar) — relaxing minDeclinePct cannot rescue it', () => {
    const closes: number[] = [];
    for (let i = 0; i <= 104; i++) closes.push(100 + 0.2 * i);
    for (let i = 0; i < 7; i++) closes.push(closes[closes.length - 1] - 1.2);
    const input = panicInput(dailyBars(closes));
    expect(scanPanicReversal(input)).toBeNull();
    expect(scanPanicReversal(input, { minDeclinePct: 0.1, minRsi: 0, maxSupportDistanceAtr: 99 })).toBeNull();
  });

  it('wing skew reads the WINGS: ATM put/call IVs equal by parity still show the put wing premium', () => {
    const rows = chain(100, { baseIv: 0.30, putWingSlope: 2.4 });
    const atmPut = rows.find((r) => r.optionType === 'put' && r.strike === 100)!;
    const atmCall = rows.find((r) => r.optionType === 'call' && r.strike === 100)!;
    expect(atmPut.midIv! / atmCall.midIv!).toBeCloseTo(1.0, 6); // the old measurement
    expect(wingSkew(rows, 100, { dteMin: 25, dteMax: 60 }, AS_OF)).toBeCloseTo(0.42 / 0.30, 6);
    // No wings at all ⇒ unreadable (null), never a neutral 1.0
    expect(wingSkew([atmPut, atmCall], 100, { dteMin: 25, dteMax: 60 }, AS_OF)).toBeNull();
  });
});

// ── Momentum breakout ─────────────────────────────────────────────────────────

/** 110 flat bars at 100, 9 rising bars to ~104, then a breakout bar to 110 on 3.5x volume. */
function breakoutBars(opts: { lastHigh?: number; lastClose?: number } = {}): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < 110; i++) closes.push(100);
  for (let i = 1; i <= 9; i++) closes.push(100 + (4 * i) / 9);
  closes.push(opts.lastClose ?? 110);
  const volumes = closes.map((_, i) => (i === closes.length - 1 ? 3_500_000 : 1_000_000));
  const highs = closes.map((c, i) => (i === closes.length - 1 ? (opts.lastHigh ?? 110.5) : c * 1.003));
  return dailyBars(closes, { volumes, highs });
}

function momentumInput(bars: Candle[], ivPercentile = 30) {
  const spot = bars[bars.length - 1].close;
  return {
    symbol: 'X',
    candles: bars,
    optionChain: chain(spot),
    ivPercentile,
    currentPrice: spot,
    avgVolume: 1_000_000,
    asOf: AS_OF,
  };
}

describe('scanMomentumBreakoutIvLag (daily bars)', () => {
  it('POSITIVE: spot clears the PRIOR 100-bar high on volume with IV still low ⇒ an OTM call', () => {
    const sig = scanMomentumBreakoutIvLag(momentumInput(breakoutBars()));
    expect(sig).not.toBeNull();
    expect(sig!.side).toBe('buy');
    expect(sig!.optionType).toBe('call');
    expect(sig!.breakoutLevel).toBeLessThan(sig!.underlyingPrice);
    expect(sig!.volumeRatio).toBeCloseTo(3.5, 6);
  });

  it('the breakout level EXCLUDES the latest bar: a breakout bar whose own high is above spot still fires', () => {
    // The first cut took the high over a window INCLUDING this bar ⇒ resistance 112 > spot 110 ⇒ never a breakout.
    const sig = scanMomentumBreakoutIvLag(momentumInput(breakoutBars({ lastHigh: 112 })));
    expect(sig).not.toBeNull();
    expect(sig!.breakoutLevel).toBeLessThan(110);
  });

  it('NEGATIVE: IV percentile 70 has already repriced — and relaxing ONLY maxIvPercentile makes it fire', () => {
    const input = momentumInput(breakoutBars(), 70);
    expect(scanMomentumBreakoutIvLag(input)).toBeNull();
    expect(scanMomentumBreakoutIvLag(input, { maxIvPercentile: 80 })).not.toBeNull();
  });

  it('NEGATIVE: average volume — and relaxing ONLY minVolumeRatio makes it fire', () => {
    // Built so the momentum score clears 70 WITHOUT the volume term (a 22% run,
    // 9/9 up closes, RS 90): the first cut of this fixture was ALSO rejected by
    // the momentum-score gate, and this mutation arm is what caught it.
    const bars = breakoutBars({ lastClose: 122, lastHigh: 122.5 });
    bars[bars.length - 1] = { ...bars[bars.length - 1], volume: 1_200_000 };
    const input = { ...momentumInput(bars), relativeStrength: 90 };
    expect(scanMomentumBreakoutIvLag(input)).toBeNull();
    expect(scanMomentumBreakoutIvLag(input, { minVolumeRatio: 1.1 })).not.toBeNull();
  });
});

// ── Post-earnings IV crush ────────────────────────────────────────────────────

/** 116 flat bars at 100, a reaction session gapping `gapPct`, then 3 bars drifting `drift` each. */
function earningsBars(gapPct: number, drift: number, sessionsAfter = 3): Candle[] {
  const closes: number[] = [];
  const opens: number[] = [];
  const n = 120;
  const gapIdx = n - 1 - sessionsAfter;
  for (let i = 0; i < gapIdx; i++) { closes.push(100); opens.push(100); }
  const gapOpen = 100 * (1 + gapPct / 100);
  opens.push(gapOpen);
  closes.push(gapOpen + drift);
  while (closes.length < n) {
    const prev = closes[closes.length - 1];
    opens.push(prev);
    closes.push(prev + drift);
  }
  return dailyBars(closes, { opens });
}

function earningsInput(bars: Candle[], sessionsAfter = 3) {
  const spot = bars[bars.length - 1].close;
  return {
    symbol: 'X',
    candles: bars,
    optionChain: chain(spot, { baseIv: 0.28 }),
    ivPercentile: 20,
    earningsDate: barDay(bars[bars.length - 1 - sessionsAfter]),
    currentPrice: spot,
    asOf: AS_OF,
  };
}

describe('scanPostEarningsIvCrush (daily bars + earnings date)', () => {
  it('POSITIVE continuation: +8% gap held, IV crushed ⇒ an OTM call, gap measured off the pre-earnings close', () => {
    const sig = scanPostEarningsIvCrush(earningsInput(earningsBars(8, 1)));
    expect(sig).not.toBeNull();
    expect(sig!.setupType).toBe('continuation');
    expect(sig!.trendDirection).toBe('bullish');
    expect(sig!.optionType).toBe('call');
    expect(sig!.gapPercent).toBeCloseTo(8, 6);
    expect(sig!.daysSinceEarnings).toBe(3);
    expect(sig!.stopLoss).toBe(100); // gap fill = the pre-earnings close
  });

  it('POSITIVE reversal: a +8% gap that FILLS below the pre-earnings close ⇒ an OTM put', () => {
    const sig = scanPostEarningsIvCrush(earningsInput(earningsBars(8, -4)));
    expect(sig).not.toBeNull();
    expect(sig!.setupType).toBe('reversal');
    expect(sig!.optionType).toBe('put');
    expect(sig!.stopLoss).toBeCloseTo(108, 6); // reclaiming the gap open invalidates
  });

  it('the reaction session is found from the date for an AFTER-CLOSE report (gap on the NEXT bar)', () => {
    const bars = earningsBars(8, 1);
    const amcDate = barDay(bars[bars.length - 5]); // the session before the gap
    expect(findEarningsReaction(bars, amcDate)).toEqual({ idx: bars.length - 4, gapPct: expect.closeTo(8, 6) });
  });

  it('NEGATIVE: a 3% gap is not an earnings shock — and relaxing ONLY minGapPct makes it fire', () => {
    const input = earningsInput(earningsBars(3, 1));
    expect(scanPostEarningsIvCrush(input)).toBeNull();
    expect(scanPostEarningsIvCrush(input, { minGapPct: 2 })).not.toBeNull();
  });

  it('NEGATIVE: the report was 8 sessions ago — and relaxing ONLY maxDaysSinceEarnings makes it fire', () => {
    const input = earningsInput(earningsBars(8, 0.5, 8), 8);
    expect(scanPostEarningsIvCrush(input)).toBeNull();
    expect(scanPostEarningsIvCrush(input, { maxDaysSinceEarnings: 10 })).not.toBeNull();
  });
});

// ── R:R in one unit ───────────────────────────────────────────────────────────

describe('riskRewardRatio is measured in UNDERLYING dollars only', () => {
  it('equals (target − spot) / (spot − stop) and does not move when the option premium does', () => {
    const cheap = scanMomentumBreakoutIvLag(momentumInput(breakoutBars()))!;
    const rich = scanMomentumBreakoutIvLag({
      ...momentumInput(breakoutBars()),
      optionChain: chain(110, { bid: 9.0, ask: 9.5 }),
    })!;
    const expected = (cheap.takeProfit - cheap.underlyingPrice) / (cheap.underlyingPrice - cheap.stopLoss);
    expect(cheap.riskRewardRatio).toBeCloseTo(expected, 9);
    expect(rich.entryPrice).toBeGreaterThan(cheap.entryPrice * 5);
    // The pre-TRA-4706 formula (target − premium) / (premium − stop) moves with the premium.
    expect(rich.riskRewardRatio).toBe(cheap.riskRewardRatio);
  });

  it('a stop on the wrong side of spot is malformed (null), not a huge ratio', () => {
    expect(underlyingRiskReward(100, 101, 110, 'bullish')).toBeNull();
    expect(underlyingRiskReward(100, 95, 110, 'bullish')).toBeCloseTo(2, 9);
    expect(underlyingRiskReward(100, 105, 90, 'bearish')).toBeCloseTo(2, 9);
  });
});

// ── Fusion ────────────────────────────────────────────────────────────────────

describe('fusion composite', () => {
  const W = {
    technical: 0.15, momentum: 0.15, meanReversion: 0.10, relativeStrength: 0.15,
    ivRv: 0.15, ivSkew: 0.15, otmMispricing: 0.10, liquidity: 0.05,
  };

  it('unmeasured (null) dimensions carry no weight — a flat 50 placeholder would drag 80s to 65', () => {
    const measured = { technical: 80, momentum: 80, meanReversion: null, relativeStrength: null, ivRv: null, ivSkew: null, otmMispricing: 80, liquidity: 80 };
    expect(calculateCompositeScore(measured, W)).toBeCloseTo(80, 9);
    const placeholder = { ...measured, meanReversion: 50, relativeStrength: 50, ivRv: 50, ivSkew: 50 };
    expect(calculateCompositeScore(placeholder, W)).toBeLessThan(70);
  });

  it('each clean setup survives the default 60 cut (the parked build emitted nothing)', () => {
    const panic = panicInput(panicBars(1.7));
    const mom = momentumInput(breakoutBars());
    const earn = earningsInput(earningsBars(8, 1));
    const runs = [
      scanAndRankSwingSignals({ ...panic, ivPercentile: 80 }),
      scanAndRankSwingSignals(mom),
      scanAndRankSwingSignals({ ...earn, ivRank: 10 }),
    ];
    expect(runs.map((r) => r.ranked.map((c) => c.signal.type))).toEqual([
      ['panic_reversal'], ['momentum_breakout_iv_lag'], ['post_earnings_iv_crush'],
    ]);
    for (const r of runs) expect(r.ranked[0].score).toBeGreaterThanOrEqual(60);
    // Nothing here supplies relative strength or realized vol, and only the panic
    // setup measures skew / mean reversion: those cells must be null, not a 50.
    const [p, m, e] = runs.map((r) => r.ranked[0].breakdown);
    expect([p.relativeStrength, p.ivRv]).toEqual([null, null]);
    for (const b of [m, e]) {
      expect([b.relativeStrength, b.ivRv, b.ivSkew, b.meanReversion]).toEqual([null, null, null, null]);
    }
  });
});

// ── Engine pass wiring ────────────────────────────────────────────────────────

/** The shape the pre-TRA-4706 wiring fed: ~6.15 RTH sessions of 5m bars (480), overnight gaps included. */
function fiveMinuteSeries(): Candle[] {
  const out: Candle[] = [];
  let day = Date.UTC(2026, 8, 9, 13, 30);
  while (out.length < 480) {
    const dow = new Date(day).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      for (let k = 0; k < 78 && out.length < 480; k++) {
        const c = 100 + out.length * 0.01;
        out.push({ symbol: 'X', timestamp: day + k * 300_000, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 10_000 });
      }
    }
    day += DAY;
  }
  return out;
}

function passDeps(bars: readonly Candle[], over: Partial<SwingPassDeps> = {}): SwingPassDeps {
  const spot = bars[bars.length - 1]?.close ?? 100;
  return {
    getChain: async () => ({ spot, rows: chain(spot, { baseIv: 0.33, putWingSlope: 2.4 }) }),
    readDailyBars: () => bars,
    atmIv: () => 0.33,
    ivRank: () => 75,
    ivPercentile: () => 80,
    recentEarnings: () => ({ state: 'none' }),
    asOf: AS_OF,
    ...over,
  };
}

describe('runSwingSignalPass — what the engine feeds the scanners', () => {
  it('scores a DAILY series and publishes the candidate with a per-cause summary', async () => {
    const { candidates, summary } = await runSwingSignalPass(['X'], passDeps(panicBars(1.7)));
    expect(candidates.map((c) => c.signal.type)).toEqual(['panic_reversal']);
    expect(summary).toMatchObject({
      symbolsConsidered: 1, symbolsScored: 1, dailySeriesUnreadable: 0,
      emittedByType: { panic_reversal: 1, momentum_breakout_iv_lag: 0, post_earnings_iv_crush: 0 },
      ranked: 1, earnings: { recent: 0, none: 1, unreadable: 0 },
    });
  });

  it('REFUSES the 5m shape (480 bars ≈ 8.6 days): counted unreadable, never scored as swing structure', async () => {
    const bars = fiveMinuteSeries();
    expect(bars.length).toBe(480); // clears any bar-COUNT floor
    const span = bars[bars.length - 1].timestamp - bars[0].timestamp;
    expect(span).toBeGreaterThan(7 * DAY); // …and spans more than a week of wall clock
    const { candidates, summary } = await runSwingSignalPass(['X'], passDeps(bars));
    expect(candidates).toEqual([]);
    expect(summary.dailySeriesUnreadable).toBe(1);
    expect(summary.symbolsScored).toBe(0);
  });

  it('passes the store’s recent earnings date through ⇒ the post-earnings scanner fires live', async () => {
    const bars = earningsBars(8, 1);
    const date = barDay(bars[bars.length - 4]);
    const deps = passDeps(bars, {
      getChain: async () => ({ spot: bars[bars.length - 1].close, rows: chain(bars[bars.length - 1].close, { baseIv: 0.28 }) }),
      ivPercentile: () => 20,
      ivRank: () => 10,
      recentEarnings: () => ({ state: 'recent', date }),
    });
    const { summary } = await runSwingSignalPass(['X'], deps);
    expect(summary.emittedByType.post_earnings_iv_crush).toBe(1);
    expect(summary.earnings.recent).toBe(1);
    // …and a dark calendar is counted as such, not as "no recent earnings"
    const dark = await runSwingSignalPass(['X'], { ...deps, recentEarnings: () => ({ state: 'unreadable' }) });
    expect(dark.summary.earnings).toEqual({ recent: 0, none: 0, unreadable: 1 });
    expect(dark.summary.emittedByType.post_earnings_iv_crush).toBe(0);
  });

  it('splits chain / IV / series failures into their own buckets', async () => {
    const good = panicBars(1.7);
    const deps = passDeps(good, {
      readDailyBars: (s) => (s === 'EMPTY' ? [] : good),
      getChain: async (s) => (s === 'NOCHAIN' ? null : { spot: 114.5, rows: chain(114.5) }),
      ivPercentile: (s) => (s === 'NOIV' ? null : 80),
    });
    const { summary } = await runSwingSignalPass(['EMPTY', 'NOCHAIN', 'NOIV', 'OK'], deps);
    expect(summary).toMatchObject({ dailySeriesUnreadable: 1, chainUnreadable: 1, ivUnreadable: 1, symbolsScored: 1 });
  });
});

// ── TRA-4720: relative strength reaches the scanners ONLY under its flag ─────

/** Strip the per-signal `randomUUID` so two runs of the same input compare byte-for-byte. */
function stable<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (k, x) => (k === 'id' ? '<id>' : x)));
}

describe('TRA-4720 — flag OFF: both scanners receive `undefined`, never a placeholder 50', () => {
  const momentumDeps = (over: Partial<SwingPassDeps> = {}) => {
    const bars = breakoutBars();
    const spot = bars[bars.length - 1].close;
    return passDeps(bars, { getChain: async () => ({ spot, rows: chain(spot) }), ivPercentile: () => 30, ...over });
  };
  const earningsDeps = (over: Partial<SwingPassDeps> = {}) => {
    const bars = earningsBars(8, 1);
    const spot = bars[bars.length - 1].close;
    return passDeps(bars, {
      getChain: async () => ({ spot, rows: chain(spot, { baseIv: 0.28 }) }),
      ivPercentile: () => 20,
      ivRank: () => 10,
      recentEarnings: () => ({ state: 'recent', date: barDay(bars[bars.length - 4]) }),
      ...over,
    });
  };

  it('momentum: no RS dep (flag OFF) ⇒ the gate is skipped and the signal still fires', async () => {
    const off = await runSwingSignalPass(['X'], momentumDeps());
    expect(off.summary.emittedByType.momentum_breakout_iv_lag).toBe(1);
    // …which PROVES the input was undefined: a supplied 50 is refused by the >=80 gate
    const fifty = await runSwingSignalPass(['X'], momentumDeps({ relativeStrength: () => 50 }));
    expect(fifty.summary.emittedByType.momentum_breakout_iv_lag).toBe(0);
    // the fusion breakdown still reads it as unmeasured, not 50
    const mom = off.candidates.find((c) => c.signal.type === 'momentum_breakout_iv_lag');
    expect(mom?.breakdown.relativeStrength).toBeNull();
  });

  it('post-earnings: no RS dep (flag OFF) ⇒ the continuation check is skipped and the signal still fires', async () => {
    const off = await runSwingSignalPass(['X'], earningsDeps());
    expect(off.summary.emittedByType.post_earnings_iv_crush).toBe(1);
    const fifty = await runSwingSignalPass(['X'], earningsDeps({ relativeStrength: () => 50 }));
    expect(fifty.summary.emittedByType.post_earnings_iv_crush).toBe(0); // 50 < 70 continuation floor
  });

  it('byte-identity: no dep ≡ a dep that answers `undefined` (unmeasured under the flag), on both scanners', async () => {
    for (const mk of [momentumDeps, earningsDeps]) {
      const off = await runSwingSignalPass(['X'], mk());
      const unmeasured = await runSwingSignalPass(['X'], mk({ relativeStrength: () => undefined }));
      expect(stable(unmeasured)).toEqual(stable(off));
    }
  });

  it('flag ON with a measured value: it reaches the scanner gate and the breakdown', async () => {
    const on = await runSwingSignalPass(['X'], momentumDeps({ relativeStrength: () => 92 }));
    expect(on.summary.emittedByType.momentum_breakout_iv_lag).toBe(1);
    const mom = on.candidates.find((c) => c.signal.type === 'momentum_breakout_iv_lag');
    expect(mom?.breakdown.relativeStrength).toBe(92);
  });
});
