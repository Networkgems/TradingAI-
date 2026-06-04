import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Candle, MarketReview } from '@trading-app/shared';

// TRA-589 — the stale-recompute path calls the live feeds + research store. Stub
// both so `getFreshMarketReview` recomputes deterministically (no network, no
// stray file writes). The pure-helper and store-round-trip suites below never
// touch these modules, so the module-wide mock is inert for them.
vi.mock('./yahoo-feed.js', () => ({
  // A clean 55-bar uptrend: last close clears the +1% trend band → GREEN.
  fetchDailyCandles: vi.fn(async () =>
    Array.from({ length: 55 }, (_, i) => ({
      symbol: '^GSPC',
      timestamp: i * 86_400_000,
      open: 5000 + i * 10,
      high: 5000 + i * 10,
      low: 5000 + i * 10,
      close: 5000 + i * 10,
      volume: 0,
    })),
  ),
  fetchTradierDailyCandles: vi.fn(async () => [] as Candle[]),
  fetchQuote: vi.fn(async (symbol: string) => {
    if (symbol === '^VIX' || symbol === 'VIX') return { price: 13, volume: 0, change: 0, changePct: 0 };
    if (symbol === '^TNX') return { price: 4.0, volume: 0, change: 0, changePct: 0 };
    return null;
  }),
}));

vi.mock('./research-store.js', () => ({
  saveResearchReport: vi.fn(async () => undefined),
}));
import {
  classifyMarketRegime,
  deriveGates,
  normalizeTnx,
  pickSpxTrendCandles,
  resolveTrend,
  simpleMa,
  listMarketReviews,
  getLatestMarketReview,
  getFreshMarketReview,
  isReviewStale,
  defaultReviewKind,
  __resetMarketReviewStoreForTests,
  MA_PERIOD,
  TREND_HYSTERESIS,
  type RegimeInputs,
} from './market-review.js';

// ── pure helpers ─────────────────────────────────────────────────────────────

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    symbol: '^GSPC',
    timestamp: i * 86_400_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
  }));
}

describe('normalizeTnx', () => {
  it('passes through a plain percent yield', () => {
    expect(normalizeTnx(4.31)).toBeCloseTo(4.31);
  });
  it('divides the legacy ×10 convention back to a percent', () => {
    expect(normalizeTnx(42.5)).toBeCloseTo(4.25);
  });
  it('returns null for null / non-finite input', () => {
    expect(normalizeTnx(null)).toBeNull();
    expect(normalizeTnx(Number.NaN)).toBeNull();
  });
});

describe('simpleMa', () => {
  it('averages the last `period` closes', () => {
    expect(simpleMa(candles([1, 2, 3, 4, 5]), 5)).toBeCloseTo(3);
    expect(simpleMa(candles([1, 2, 3, 4, 10]), 2)).toBeCloseTo(7);
  });
  it('returns null when there is not enough history', () => {
    expect(simpleMa(candles([1, 2, 3]), MA_PERIOD)).toBeNull();
  });
  // TRA-472 — the trend filter is a 50-period SMA; confirm `simpleMa` resolves
  // it from exactly `MA_PERIOD` bars and not before.
  it('computes the 50-period trend MA from exactly MA_PERIOD bars', () => {
    expect(MA_PERIOD).toBe(50);
    const closes = Array.from({ length: 50 }, (_, i) => i + 1); // 1..50, mean 25.5
    expect(simpleMa(candles(closes), MA_PERIOD)).toBeCloseTo(25.5);
    expect(simpleMa(candles(closes.slice(1)), MA_PERIOD)).toBeNull(); // 49 bars
  });
});

// ── TRA-472 — ±1% hysteresis trend band ──────────────────────────────────────

describe('resolveTrend (TRA-472 hysteresis band)', () => {
  it('flips to up only once price clears MA·(1 + hysteresis)', () => {
    const ma = 5000;
    const justInsideBand = ma * (1 + TREND_HYSTERESIS) - 1; // still inside
    const clearAbove = ma * (1 + TREND_HYSTERESIS) + 1;
    // inside the band, holding a prior DOWN state → stays down
    expect(resolveTrend(justInsideBand, ma, false).trendUp).toBe(false);
    // clear of the upper band → flips up regardless of prior state
    expect(resolveTrend(clearAbove, ma, false).trendUp).toBe(true);
  });

  it('flips to down only once price clears MA·(1 - hysteresis)', () => {
    const ma = 5000;
    const justInsideBand = ma * (1 - TREND_HYSTERESIS) + 1; // still inside
    const clearBelow = ma * (1 - TREND_HYSTERESIS) - 1;
    // inside the band, holding a prior UP state → stays up
    expect(resolveTrend(justInsideBand, ma, true).trendUp).toBe(true);
    // clear of the lower band → flips down regardless of prior state
    expect(resolveTrend(clearBelow, ma, true).trendUp).toBe(false);
  });

  it('holds the prior state for any price inside the ±1% band', () => {
    const ma = 5000;
    const inBand = ma * 1.005; // +0.5%, inside the band
    expect(resolveTrend(inBand, ma, true).trendUp).toBe(true);
    expect(resolveTrend(inBand, ma, false).trendUp).toBe(false);
    const belowInBand = ma * 0.995; // -0.5%, inside the band
    expect(resolveTrend(belowInBand, ma, true).trendUp).toBe(true);
    expect(resolveTrend(belowInBand, ma, false).trendUp).toBe(false);
  });

  it('cold store: seeds from the plain spx ≥ MA comparison inside the band', () => {
    const ma = 5000;
    // No prior state — inside the band, seed from spx vs MA directly.
    expect(resolveTrend(ma * 1.005, ma, null).trendUp).toBe(true);
    expect(resolveTrend(ma * 0.995, ma, null).trendUp).toBe(false);
    expect(resolveTrend(ma, ma, undefined).trendUp).toBe(true); // spx == MA → up
  });

  it('reports trendKnown=false when the trend feed is dark', () => {
    expect(resolveTrend(null, 5000, true).trendKnown).toBe(false);
    expect(resolveTrend(5000, null, true).trendKnown).toBe(false);
    const dark = resolveTrend(null, null);
    expect(dark.trendUp).toBe(false);
    expect(dark.trendDown).toBe(false);
  });
});

// ── regime classification ───────────────────────────────────────────────────

describe('classifyMarketRegime', () => {
  it('GREEN when SPX above the trend MA, low VIX, rates contained', () => {
    const inputs: RegimeInputs = { spx: 5200, spxTrendMa: 5100, vix: 13.5, tnx: 4.1 };
    expect(classifyMarketRegime(inputs).regime).toBe('green');
  });

  it('RED when SPX is below its trend MA (downtrend)', () => {
    const inputs: RegimeInputs = { spx: 5000, spxTrendMa: 5100, vix: 13, tnx: 4.0 };
    const { regime, rationale } = classifyMarketRegime(inputs);
    expect(regime).toBe('red');
    expect(rationale).toMatch(/downtrend/i);
  });

  it('RED when VIX > 22 even with an uptrend', () => {
    const inputs: RegimeInputs = { spx: 5200, spxTrendMa: 5100, vix: 28, tnx: 4.0 };
    expect(classifyMarketRegime(inputs).regime).toBe('red');
  });

  it('YELLOW when VIX is in the 16–22 mean-reversion band', () => {
    const inputs: RegimeInputs = { spx: 5200, spxTrendMa: 5100, vix: 19, tnx: 4.0 };
    expect(classifyMarketRegime(inputs).regime).toBe('yellow');
  });

  it('YELLOW when the 10Y yield is above 4.50%', () => {
    const inputs: RegimeInputs = { spx: 5200, spxTrendMa: 5100, vix: 13, tnx: 4.7 };
    expect(classifyMarketRegime(inputs).regime).toBe('yellow');
  });

  it('YELLOW (cautious) when the SPX trend feed is unavailable', () => {
    const inputs: RegimeInputs = { spx: null, spxTrendMa: null, vix: 13, tnx: 4.0 };
    const { regime, rationale } = classifyMarketRegime(inputs);
    expect(regime).toBe('yellow');
    expect(rationale).toMatch(/unavailable/i);
  });

  // TRA-472 — a price inside the ±1% hysteresis band holds the prior review's
  // trend state instead of flipping the regime.
  it('holds the prior trend state inside the band (price +0.5% over MA)', () => {
    // spx 0.5% above MA → inside the band, so the prior state decides.
    const inputs: RegimeInputs = { spx: 5025, spxTrendMa: 5000, vix: 13, tnx: 4.0 };
    // prior review was DOWN → still RED despite price > MA.
    expect(classifyMarketRegime(inputs, false).regime).toBe('red');
    // prior review was UP → GREEN, the uptrend is held.
    expect(classifyMarketRegime(inputs, true).regime).toBe('green');
  });

  it('flips the regime once price clears the band', () => {
    // spx 1.5% above MA → clear of the upper band → uptrend even from a
    // prior DOWN state.
    expect(
      classifyMarketRegime({ spx: 5075, spxTrendMa: 5000, vix: 13, tnx: 4.0 }, false).regime,
    ).toBe('green');
    // spx 1.5% below MA → clear of the lower band → downtrend even from a
    // prior UP state.
    expect(
      classifyMarketRegime({ spx: 4925, spxTrendMa: 5000, vix: 13, tnx: 4.0 }, true).regime,
    ).toBe('red');
  });

  it('cold store: seeds the in-band read from the plain spx ≥ MA comparison', () => {
    // No prior state. spx 0.5% above MA, inside the band → seed up → GREEN.
    expect(
      classifyMarketRegime({ spx: 5025, spxTrendMa: 5000, vix: 13, tnx: 4.0 }).regime,
    ).toBe('green');
    // spx 0.5% below MA, inside the band → seed down → RED.
    expect(
      classifyMarketRegime({ spx: 4975, spxTrendMa: 5000, vix: 13, tnx: 4.0 }).regime,
    ).toBe('red');
  });
});

// ── strategy gates ──────────────────────────────────────────────────────────

describe('deriveGates', () => {
  it('GREEN tape: ORB longs on, breakouts on, full sizing', () => {
    const inputs: RegimeInputs = { spx: 5200, spxTrendMa: 5100, vix: 13, tnx: 4.0 };
    const gates = deriveGates('green', inputs);
    expect(gates.orbLongs).toBe(true);
    expect(gates.orbShorts).toBe(false);
    expect(gates.breakoutsEnabled).toBe(true);
    expect(gates.sizingMultiplier).toBe(1.0);
  });

  it('RED downtrend: ORB longs off, ORB shorts on, sizing halved', () => {
    const inputs: RegimeInputs = { spx: 5000, spxTrendMa: 5100, vix: 13, tnx: 4.0 };
    const gates = deriveGates('red', inputs);
    expect(gates.orbLongs).toBe(false);
    expect(gates.orbShorts).toBe(true);
    expect(gates.sizingMultiplier).toBe(0.5);
  });

  it('high VIX disables breakouts and ORB longs', () => {
    const inputs: RegimeInputs = { spx: 5200, spxTrendMa: 5100, vix: 28, tnx: 4.0 };
    const gates = deriveGates('red', inputs);
    expect(gates.breakoutsEnabled).toBe(false);
    expect(gates.orbLongs).toBe(false);
  });

  it('mean-reversion tilt turns on inside the 16–22 VIX band', () => {
    const inputs: RegimeInputs = { spx: 5200, spxTrendMa: 5100, vix: 19, tnx: 4.0 };
    expect(deriveGates('yellow', inputs).meanReversionTilt).toBe(true);
  });

  it('10Y above 4.50% caps sizing at 0.5 even in a YELLOW regime', () => {
    const inputs: RegimeInputs = { spx: 5200, spxTrendMa: 5100, vix: 13, tnx: 4.7 };
    expect(deriveGates('yellow', inputs).sizingMultiplier).toBe(0.5);
  });

  // TRA-469 — trendState records *why* the trend gates resolved so the signal
  // engine can tell a real downtrend apart from a dark feed.
  it('trendState reflects an uptrend / downtrend / unreadable feed', () => {
    expect(
      deriveGates('green', { spx: 5200, spxTrendMa: 5100, vix: 13, tnx: 4.0 }).trendState,
    ).toBe('up');
    expect(
      deriveGates('red', { spx: 5000, spxTrendMa: 5100, vix: 13, tnx: 4.0 }).trendState,
    ).toBe('down');
    expect(
      deriveGates('yellow', { spx: null, spxTrendMa: null, vix: 13, tnx: 4.0 }).trendState,
    ).toBe('unknown');
  });

  // TRA-472 — the ±1% hysteresis band holds the prior trend state, so the ORB
  // gates do not whipsaw on a price that is only marginally over/under the MA.
  it('holds ORB gates inside the band; flips them once price clears it', () => {
    // spx 0.5% above MA → inside the band.
    const inBand: RegimeInputs = { spx: 5025, spxTrendMa: 5000, vix: 13, tnx: 4.0 };
    // prior UP held → ORB longs stay on, shorts off.
    const heldUp = deriveGates('green', inBand, true);
    expect(heldUp.orbLongs).toBe(true);
    expect(heldUp.orbShorts).toBe(false);
    expect(heldUp.trendState).toBe('up');
    // prior DOWN held → ORB longs stay off, shorts on.
    const heldDown = deriveGates('red', inBand, false);
    expect(heldDown.orbLongs).toBe(false);
    expect(heldDown.orbShorts).toBe(true);
    expect(heldDown.trendState).toBe('down');
    // price clears the lower band → downtrend wins regardless of the prior UP.
    const cleared = deriveGates('red', { spx: 4925, spxTrendMa: 5000, vix: 13, tnx: 4.0 }, true);
    expect(cleared.orbLongs).toBe(false);
    expect(cleared.orbShorts).toBe(true);
  });
});

// ── TRA-469 — S&P trend-feed fallback ────────────────────────────────────────

describe('pickSpxTrendCandles (TRA-469 SPY fallback)', () => {
  it('keeps the ^GSPC primary feed when it has enough history', () => {
    // TRA-472 — the window is now MA_PERIOD (50) bars, not 20.
    const primary = candles(Array.from({ length: MA_PERIOD + 5 }, (_, i) => 5000 + i));
    const fallback = candles(Array.from({ length: MA_PERIOD + 5 }, (_, i) => 500 + i));
    const picked = pickSpxTrendCandles(primary, fallback);
    expect(picked.symbol).toBe('^GSPC');
    expect(picked.viaFallback).toBe(false);
    expect(picked.provider).toBe('yahoo');
    expect(picked.candles).toBe(primary);
  });

  it('falls back to SPY (Yahoo) when ^GSPC is short of the trend-MA window', () => {
    const primary = candles([5000, 5010, 5020]); // < MA_PERIOD bars
    const fallback = candles(Array.from({ length: MA_PERIOD + 5 }, (_, i) => 500 + i));
    const picked = pickSpxTrendCandles(primary, fallback);
    expect(picked.symbol).toBe('SPY');
    expect(picked.viaFallback).toBe(true);
    expect(picked.provider).toBe('yahoo');
    expect(picked.candles).toBe(fallback);
  });

  it('returns the longer series (still degrading to null) when both Yahoo feeds are dark', () => {
    const primary = candles([5000, 5010]);
    const fallback = candles([500, 510, 520, 530]);
    const picked = pickSpxTrendCandles(primary, fallback);
    expect(picked.symbol).toBe('SPY');
    expect(simpleMa(picked.candles, MA_PERIOD)).toBeNull();
  });

  // TRA-586 — the non-Yahoo third tier.
  it('falls back to SPY via Tradier when both Yahoo paths are short', () => {
    const primary = candles([5000, 5010, 5020]); // ^GSPC dark (Yahoo)
    const yahooFallback = candles([500, 510]); // SPY/Yahoo dark too
    const tradierFallback = candles(Array.from({ length: MA_PERIOD + 5 }, (_, i) => 500 + i));
    const picked = pickSpxTrendCandles(primary, yahooFallback, tradierFallback);
    expect(picked.symbol).toBe('SPY');
    expect(picked.viaFallback).toBe(true);
    expect(picked.provider).toBe('tradier');
    expect(picked.candles).toBe(tradierFallback);
  });

  it('prefers Yahoo SPY over Tradier SPY when both have enough history', () => {
    const primary = candles([5000]); // ^GSPC dark
    const yahooFallback = candles(Array.from({ length: MA_PERIOD + 5 }, (_, i) => 500 + i));
    const tradierFallback = candles(Array.from({ length: MA_PERIOD + 5 }, (_, i) => 400 + i));
    const picked = pickSpxTrendCandles(primary, yahooFallback, tradierFallback);
    expect(picked.provider).toBe('yahoo');
    expect(picked.candles).toBe(yahooFallback);
  });

  it('keeps the longest series across all three when none reaches the MA window', () => {
    const primary = candles([5000, 5010]);
    const yahooFallback = candles([500, 510, 520]);
    const tradierFallback = candles([400, 410, 420, 430, 440]);
    const picked = pickSpxTrendCandles(primary, yahooFallback, tradierFallback);
    expect(picked.provider).toBe('tradier');
    expect(picked.candles).toBe(tradierFallback);
    expect(simpleMa(picked.candles, MA_PERIOD)).toBeNull();
  });
});

// ── store round-trip ────────────────────────────────────────────────────────

describe('market-review store', () => {
  let tmpRoot: string;
  let storePath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'market-review-test-'));
    storePath = join(tmpRoot, 'market-review.json');
    __resetMarketReviewStoreForTests(storePath);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    __resetMarketReviewStoreForTests(null);
  });

  function review(kind: 'premarket' | 'postmarket', generatedAt: string): MarketReview {
    return {
      id: `${kind}-${generatedAt.slice(0, 10)}`,
      kind,
      date: generatedAt.slice(0, 10),
      generatedAt,
      regime: 'green',
      regimeRationale: 'test',
      indexes: [],
      gates: {
        orbLongs: true,
        orbShorts: false,
        meanReversionTilt: false,
        breakoutsEnabled: true,
        sizingMultiplier: 1,
      },
      source: 'auto',
    };
  }

  it('lists reviews newest-first and scopes getLatest by kind', async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        reviews: [
          review('premarket', '2026-05-15T13:00:00.000Z'),
          review('postmarket', '2026-05-16T01:00:00.000Z'),
          review('premarket', '2026-05-16T13:00:00.000Z'),
        ],
      }),
    );

    const list = await listMarketReviews();
    expect(list.map(r => r.generatedAt)).toEqual([
      '2026-05-16T13:00:00.000Z',
      '2026-05-16T01:00:00.000Z',
      '2026-05-15T13:00:00.000Z',
    ]);

    expect((await getLatestMarketReview())?.generatedAt).toBe('2026-05-16T13:00:00.000Z');
    expect((await getLatestMarketReview('postmarket'))?.kind).toBe('postmarket');
    expect((await getLatestMarketReview('premarket'))?.generatedAt).toBe(
      '2026-05-16T13:00:00.000Z',
    );
  });

  it('returns null when no review has been generated yet', async () => {
    expect(await getLatestMarketReview()).toBeNull();
  });
});

// ── TRA-589 — stale-banner recompute ─────────────────────────────────────────

describe('isReviewStale (TRA-589)', () => {
  // Fixed clock: 2026-06-04 15:00Z = 11:00 ET → today ET is 2026-06-04.
  const now = new Date('2026-06-04T15:00:00.000Z');

  function review(date: string, trendState?: 'up' | 'down' | 'unknown'): MarketReview {
    return {
      id: `premarket-${date}`,
      kind: 'premarket',
      date,
      generatedAt: `${date}T13:00:00.000Z`,
      regime: 'green',
      regimeRationale: 'test',
      indexes: [],
      gates: {
        orbLongs: true,
        orbShorts: false,
        meanReversionTilt: false,
        breakoutsEnabled: true,
        sizingMultiplier: 1,
        trendState,
      },
      source: 'auto',
    };
  }

  it('is stale when there is no review (cold store)', () => {
    expect(isReviewStale(null, now)).toBe(true);
    expect(isReviewStale(undefined, now)).toBe(true);
  });

  it('is stale when the review predates the current ET session', () => {
    expect(isReviewStale(review('2026-06-03', 'up'), now)).toBe(true);
  });

  it('is stale when the trend feed was dark (trendState unknown/absent)', () => {
    expect(isReviewStale(review('2026-06-04', 'unknown'), now)).toBe(true);
    expect(isReviewStale(review('2026-06-04', undefined), now)).toBe(true);
  });

  it('is fresh when current-session with a known trend', () => {
    expect(isReviewStale(review('2026-06-04', 'up'), now)).toBe(false);
    expect(isReviewStale(review('2026-06-04', 'down'), now)).toBe(false);
  });
});

describe('defaultReviewKind (TRA-589)', () => {
  it('is premarket through the trading day and postmarket after the cash close', () => {
    // 13:00Z = 09:00 ET → premarket; 21:00Z = 17:00 ET → postmarket.
    expect(defaultReviewKind(new Date('2026-06-04T13:00:00.000Z'))).toBe('premarket');
    expect(defaultReviewKind(new Date('2026-06-04T21:00:00.000Z'))).toBe('postmarket');
  });
});

describe('getFreshMarketReview (TRA-589 live recompute)', () => {
  let tmpRoot: string;
  let storePath: string;
  // 2026-06-04 15:00Z = 11:00 ET → today ET is 2026-06-04.
  const now = new Date('2026-06-04T15:00:00.000Z');

  function review(date: string, trendState: 'up' | 'down' | 'unknown'): MarketReview {
    return {
      id: `premarket-${date}`,
      kind: 'premarket',
      date,
      generatedAt: `${date}T13:00:00.000Z`,
      regime: trendState === 'unknown' ? 'yellow' : 'green',
      regimeRationale: 'seed',
      indexes: [],
      gates: {
        orbLongs: trendState === 'up',
        orbShorts: trendState === 'down',
        meanReversionTilt: false,
        breakoutsEnabled: true,
        sizingMultiplier: 1,
        trendState,
      },
      source: 'auto',
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = mkdtempSync(join(tmpdir(), 'market-review-fresh-'));
    storePath = join(tmpRoot, 'market-review.json');
    __resetMarketReviewStoreForTests(storePath);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    __resetMarketReviewStoreForTests(null);
  });

  it('serves the persisted review unchanged when it is current and trend-known', async () => {
    const { fetchDailyCandles } = await import('./yahoo-feed.js');
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, reviews: [review('2026-06-04', 'up')] }),
    );
    const served = await getFreshMarketReview(undefined, now);
    expect(served?.regimeRationale).toBe('seed');
    // No live recompute when the persisted review is fresh.
    expect(fetchDailyCandles).not.toHaveBeenCalled();
  });

  it('recomputes live + persists when the persisted review came from a dark feed', async () => {
    const { fetchDailyCandles } = await import('./yahoo-feed.js');
    // Same ET day, but trendState unknown — the TRA-589 stale-banner case.
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, reviews: [review('2026-06-04', 'unknown')] }),
    );
    const served = await getFreshMarketReview(undefined, now);
    expect(fetchDailyCandles).toHaveBeenCalled();
    // Mocked uptrend feed → GREEN with a known up-trend, not the dark default.
    expect(served?.regime).toBe('green');
    expect(served?.gates.trendState).toBe('up');
    expect(served?.regimeRationale).not.toBe('seed');
    // Recompute persisted so the next read is consistent.
    const persisted = await getLatestMarketReview();
    expect(persisted?.regime).toBe('green');
    expect(persisted?.gates.trendState).toBe('up');
  });

  it('recomputes live when the persisted review predates the session', async () => {
    const { fetchDailyCandles } = await import('./yahoo-feed.js');
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, reviews: [review('2026-06-03', 'up')] }),
    );
    const served = await getFreshMarketReview(undefined, now);
    expect(fetchDailyCandles).toHaveBeenCalled();
    // The recompute supersedes the prior-session seed (newer generatedAt).
    expect(served?.regimeRationale).not.toBe('seed');
    expect(served?.regime).toBe('green');
  });

  it('recomputes from a cold store (no review yet)', async () => {
    const served = await getFreshMarketReview(undefined, now);
    expect(served).not.toBeNull();
    expect(served?.regime).toBe('green');
    expect(served?.gates.trendState).toBe('up');
  });
});
