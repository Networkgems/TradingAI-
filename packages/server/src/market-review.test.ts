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
  pickTrendCandles,
  resolveTrend,
  resolveCompositeTrend,
  buildTrendMemory,
  renderTrendNote,
  applyCompositeGateClause,
  fmtSignedPct,
  simpleMa,
  listMarketReviews,
  getLatestMarketReview,
  getFreshMarketReview,
  isReviewStale,
  defaultReviewKind,
  computeWeekendGapRisk,
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

// ── TRA-2197 — composite trend gate, dwell lock, truthful note ───────────────

/**
 * The 2026-07-23 close, pinned verbatim from the `GET /api/market-review/latest`
 * payload that surfaced the defect. `^GSPC` sits 0.85% UNDER its 50-DMA — inside
 * the ±1% band, so the old single-index gate held `up` and printed
 * `Above 50-DMA (7471.79, ±1% band)` beside `value: 7408.30` — while `^NDX`, the
 * index the engine's mega-cap-tech universe actually tracks, was 3.67% under its
 * own MA and outside any band.
 */
const JUL23: RegimeInputs = {
  spx: 7408.2998046875,
  spxTrendMa: 7471.79302734375,
  ndx: 28454.81,
  ndxTrendMa: 29538.6,
  vix: 13,
  tnx: 4.0,
};

describe('TRA-2197 — composite ^GSPC/^NDX trend gate', () => {
  // AC 4 — the fixture that must NOT produce `orbLongs: true`.
  it('2026-07-23 fixture: does not enable ORB longs (^NDX binds at -3.67%)', () => {
    // The prior review said `up` — exactly the state the old gate inherited
    // through the band. The NDX leg must override it anyway.
    const memory = { states: { '^GSPC': 'up' as const, '^NDX': 'up' as const } };
    const gates = deriveGates('yellow', JUL23, memory);
    expect(gates.orbLongs).toBe(false);
    expect(gates.trendState).toBe('down');
    expect(gates.trendBindingSymbol).toBe('^NDX');
    // …and the regime the same inputs classify to is RED, not YELLOW.
    expect(classifyMarketRegime(JUL23, memory).regime).toBe('red');
  });

  // AC 3 — the fold is to the WEAKER leg, in both directions.
  it('folds to the weaker leg: `up` only when every readable index is up', () => {
    const up: RegimeInputs = {
      spx: 5100,
      spxTrendMa: 5000,
      ndx: 20400,
      ndxTrendMa: 20000,
      vix: 13,
      tnx: 4.0,
    };
    expect(deriveGates('green', up).trendState).toBe('up');
    // ^GSPC strongly up, ^NDX clearly below its band → composite down.
    const gates = deriveGates('green', { ...up, ndx: 19600 }); // -2% vs its MA
    expect(gates.trendState).toBe('down');
    expect(gates.orbLongs).toBe(false);
    expect(gates.orbShorts).toBe(true);
    expect(gates.trendBindingSymbol).toBe('^NDX');
    // Symmetrically: a weak ^GSPC binds when IT is the laggard.
    const inverse = deriveGates('green', { ...up, spx: 4900 });
    expect(inverse.trendState).toBe('down');
    expect(inverse.trendBindingSymbol).toBe('^GSPC');
  });

  it('a dark leg is skipped, not fatal — the readable leg still gates', () => {
    const gates = deriveGates('green', {
      spx: 5100,
      spxTrendMa: 5000,
      ndx: null,
      ndxTrendMa: null,
      vix: 13,
      tnx: 4.0,
    });
    expect(gates.trendState).toBe('up');
    expect(gates.trendBindingSymbol).toBe('^GSPC');
    expect(gates.trendComponents?.find(c => c.symbol === '^NDX')?.state).toBe('unknown');
    // Every leg dark → unknown, exactly as before TRA-2197.
    const allDark = deriveGates('yellow', { spx: null, spxTrendMa: null, vix: 13, tnx: 4.0 });
    expect(allDark.trendState).toBe('unknown');
    expect(allDark.trendBindingSymbol).toBeNull();
  });

  it('back-compat: a bare `prevTrendUp` boolean still seeds the ^GSPC leg', () => {
    const inBand: RegimeInputs = { spx: 4975, spxTrendMa: 5000, vix: 13, tnx: 4.0 };
    expect(deriveGates('green', inBand, true).trendState).toBe('up');
    expect(deriveGates('green', inBand, false).trendState).toBe('down');
  });
});

// AC 2 — the state cannot flip twice in one session on a sub-band oscillation.
describe('TRA-2197 — same-session dwell lock', () => {
  const MA = 7471.79302734375;
  const SESSION = '2026-07-24';

  /**
   * Replay a price path the way production does: derive gates, fold them into
   * the {@link buildTrendMemory} the next review threads back in, repeat. This
   * exercises the real persistence round-trip, not a hand-built memory object.
   */
  function replay(path: number[], sessionDates: string[], seed: 'up' | 'down' = 'up') {
    let memory = buildTrendMemory(
      { orbLongs: false, orbShorts: false, meanReversionTilt: false, breakoutsEnabled: true, sizingMultiplier: 1, trendState: seed },
      sessionDates[0],
    );
    const states: Array<'up' | 'down' | 'unknown'> = [];
    path.forEach((px, i) => {
      const inputs: RegimeInputs = { spx: px, spxTrendMa: MA, vix: 13, tnx: 4.0 };
      const gates = deriveGates('green', inputs, { ...memory, sessionDate: sessionDates[i] });
      states.push(gates.trendState ?? 'unknown');
      memory = buildTrendMemory(gates, sessionDates[i]);
    });
    return states;
  }

  it('crosses the -1% floor three times in one session and flips exactly once', () => {
    // floor = MA*0.99 = 7397.08. Every rebound stays INSIDE the band, so the
    // oscillation is strictly smaller than the band width.
    const path = [7420, 7390, 7420, 7385, 7425, 7396, 7430];
    const states = replay(
      path,
      path.map(() => SESSION),
    );
    expect(states).toEqual(['up', 'down', 'down', 'down', 'down', 'down', 'down']);
    const transitions = states.filter((s, i) => i > 0 && s !== states[i - 1]).length;
    expect(transitions).toBe(1);
  });

  it('refuses the up-flip in-session even on a violent reversal clear of the +1% band', () => {
    // Down through the floor, then a 2%+ intraday rip clear of the upper band.
    const path = [7420, 7380, 7560];
    const states = replay(
      path,
      path.map(() => SESSION),
    );
    expect(states).toEqual(['up', 'down', 'down']);
  });

  it('releases the lock at the session boundary (no expiry sweep needed)', () => {
    const states = replay([7420, 7380, 7560, 7560], [SESSION, SESSION, SESSION, '2026-07-27']);
    expect(states).toEqual(['up', 'down', 'down', 'up']);
  });

  it('never blocks the restrictive direction — `→ down` is always immediate', () => {
    // Seeded down, ripped up clear of the band, then straight back below the
    // floor in the SAME session: the down flip must land.
    const states = replay([7560, 7380], [SESSION, SESSION], 'down');
    expect(states).toEqual(['up', 'down']);
  });

  it('buildTrendMemory degrades a pre-TRA-2197 review to a seeded ^GSPC leg', () => {
    const legacy = buildTrendMemory(
      { orbLongs: true, orbShorts: false, meanReversionTilt: false, breakoutsEnabled: true, sizingMultiplier: 1, trendState: 'up' },
      SESSION,
    );
    expect(legacy.states).toEqual({ '^GSPC': 'up' });
    expect(legacy.sessionDate).toBe(SESSION);
    // …and a cold store stays cold rather than inventing a state.
    expect(buildTrendMemory(null, SESSION).states).toEqual({});
  });
});

// AC 1 — the note must state the true signed distance, never "Above 50-DMA".
describe('TRA-2197 — truthful trend prose', () => {
  function noteFor(
    inputs: RegimeInputs,
    symbol: string,
    memory?: Parameters<typeof resolveCompositeTrend>[1],
  ): string {
    const composite = resolveCompositeTrend(inputs, memory);
    const component = composite.components.find(c => c.symbol === symbol)!;
    return renderTrendNote(component, composite.reads[symbol], 'Feed unavailable.');
  }

  it('a below-MA close held by tolerance says so, and never says "Above"', () => {
    const note = noteFor(JUL23, '^GSPC', { states: { '^GSPC': 'up', '^NDX': 'up' } });
    expect(note).not.toMatch(/Above 50-DMA/i);
    expect(note).toContain('-0.85%');
    expect(note).toContain('7471.79');
    expect(note).toMatch(/HELD `up` by tolerance/);
    expect(note).toMatch(/not confirmed by price/);
  });

  it('a leg clear of the band is described as confirmed, not held', () => {
    const note = noteFor({ spx: 5100, spxTrendMa: 5000, vix: 13, tnx: 4.0 }, '^GSPC');
    expect(note).toContain('+2.00%');
    expect(note).toMatch(/confirmed uptrend/);
    expect(note).not.toMatch(/tolerance/);
    // The NDX 2026-07-23 leg, 3.67% under water, reads as a confirmed downtrend.
    expect(noteFor(JUL23, '^NDX')).toMatch(/-3\.67% vs 50-DMA .*confirmed downtrend/);
  });

  it('surfaces the dwell lock in the prose when it suppressed an up-flip', () => {
    const note = noteFor({ spx: 7560, spxTrendMa: 7471.79302734375, vix: 13, tnx: 4.0 }, '^GSPC', {
      states: { '^GSPC': 'down' },
      downFlipDates: { '^GSPC': '2026-07-24' },
      sessionDate: '2026-07-24',
    });
    expect(note).toMatch(/dwell lock/i);
  });

  it('a dark leg renders the dark note, not a fabricated distance', () => {
    expect(noteFor({ spx: null, spxTrendMa: null, vix: 13, tnx: 4.0 }, '^GSPC')).toBe(
      'Feed unavailable.',
    );
  });

  it('fmtSignedPct always carries an explicit sign', () => {
    expect(fmtSignedPct(-0.0085)).toBe('-0.85%');
    expect(fmtSignedPct(0.0142)).toBe('+1.42%');
    expect(fmtSignedPct(0)).toBe('+0.00%');
    expect(fmtSignedPct(null)).toBe('n/a');
  });

  it('the composite clause quotes the SAME gates object the engine consumes', () => {
    const gates = deriveGates('red', JUL23, { states: { '^GSPC': 'up', '^NDX': 'up' } });
    const readings = applyCompositeGateClause(
      [
        { symbol: '^GSPC', label: 'S&P 500', value: JUL23.spx, trendMa: JUL23.spxTrendMa, note: 'x', trendState: 'up' },
        { symbol: '^NDX', label: 'Nasdaq 100', value: JUL23.ndx ?? null, trendMa: JUL23.ndxTrendMa ?? null, note: 'y', trendState: 'down' },
        { symbol: '^VIX', label: 'VIX', value: 13, trendMa: null, note: 'z' },
      ],
      gates,
    );
    // Appended exactly once, on the leading trend leg.
    expect(readings[0].note).toContain('ORB longs OFF');
    expect(readings[0].note).toContain('^NDX binds at -3.67%');
    expect(readings[1].note).toBe('y');
    expect(readings[2].note).toBe('z');
  });
});

// TRA-2197 — the ^NDX leg reuses the identical index → ETF → Tradier cascade.
describe('pickTrendCandles (TRA-2197 symbol-parameterised)', () => {
  it('prefers the index feed, then the ETF proxy, then Tradier', () => {
    const full = candles(Array.from({ length: MA_PERIOD }, (_, i) => 20000 + i));
    expect(pickTrendCandles('^NDX', 'QQQ', full, [], []).symbol).toBe('^NDX');
    expect(pickTrendCandles('^NDX', 'QQQ', [], full, []).symbol).toBe('QQQ');
    expect(pickTrendCandles('^NDX', 'QQQ', [], full, []).viaFallback).toBe(true);
    expect(pickTrendCandles('^NDX', 'QQQ', [], [], full).provider).toBe('tradier');
  });

  it('keeps the longest series when no source has MA_PERIOD bars', () => {
    expect(pickTrendCandles('^NDX', 'QQQ', candles([1]), candles([1, 2, 3]), []).candles).toHaveLength(3);
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

describe('computeWeekendGapRisk (TRA-950)', () => {
  it('flags a Friday review (weekend gap ahead) and not a mid-week one', () => {
    // 2026-06-19 is a Friday; 14:00Z = 10:00 ET keeps the ET date on Friday.
    expect(computeWeekendGapRisk(new Date('2026-06-19T14:00:00.000Z'))).toBe(true);
    // 2026-06-17 is a Wednesday.
    expect(computeWeekendGapRisk(new Date('2026-06-17T14:00:00.000Z'))).toBe(false);
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

  // TRA-3436 — the prior session's `kind` must NOT survive the date roll.
  //
  // Measured on bqb1: at 00:01 ET on 2026-08-12 the store held the previous
  // evening's `postmarket-2026-08-11`. It was stale ONLY because the ET date had
  // rolled — and the old `persisted?.kind ?? defaultReviewKind(now)` chain read
  // its `kind` off that very review, minting `postmarket-2026-08-12` from
  // pre-dawn data and publishing it as "Post-Market Review — 2026-08-12", 16
  // hours before the close it was dated for.
  //
  // The assertion is on the KIND the recompute chose, because that is what the
  // headline and the report id are built from. `vi.setSystemTime` pins the clock
  // so `generateMarketReview`'s own `new Date()` agrees with the `now` we pass;
  // only `Date` is faked so the awaited store I/O still settles.
  it('derives the kind from the clock, not from the stale prior-session review', async () => {
    const priorPostmarket: MarketReview = {
      ...review('2026-06-03', 'up'),
      id: 'postmarket-2026-06-03',
      kind: 'postmarket',
      generatedAt: '2026-06-04T01:00:00.000Z', // 21:00 ET on 06-03
    };
    writeFileSync(storePath, JSON.stringify({ version: 1, reviews: [priorPostmarket] }));

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now); // 15:00Z = 11:00 ET on 06-04 — mid-session, pre-close
      const served = await getFreshMarketReview(undefined, now);
      // Pre-close ⇒ `defaultReviewKind` says premarket. Inheriting `postmarket`
      // here is the defect: it would stamp a mid-session read post-market.
      expect(served?.kind).toBe('premarket');
      expect(served?.id).toBe('premarket-2026-06-04');
    } finally {
      vi.useRealTimers();
    }
  });

  // The other direction, so the fix is not just "always premarket": after the
  // cash close the clock must pick `postmarket` even though the stale review it
  // is replacing is a premarket one. Without this, a test asserting only the
  // case above passes for a hard-coded constant.
  it('derives postmarket from the clock after the cash close', async () => {
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, reviews: [review('2026-06-03', 'up')] }), // premarket
    );

    const afterClose = new Date('2026-06-04T21:00:00.000Z'); // 17:00 ET
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(afterClose);
      const served = await getFreshMarketReview(undefined, afterClose);
      expect(served?.kind).toBe('postmarket');
      expect(served?.id).toBe('postmarket-2026-06-04');
    } finally {
      vi.useRealTimers();
    }
  });
});
