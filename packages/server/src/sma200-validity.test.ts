// TRA-3688 — S-1 env resolution guard + S-3 void verdicts.
import { describe, it, expect } from 'vitest';
import {
  resolveSma200PullbackMaxDistAtr,
  SMA200_PULLBACK_MAX_DIST_ATR_DEFAULT,
  resolveSma200PullbackTimeCapBars,
  SMA200_PULLBACK_TIME_CAP_BARS_DEFAULT,
  sma200PullbackExitModel,
  sma200VoidVerdict,
  SMA200_DRIFT_VOID_ATR,
  sma200SweepVerdict,
  sma200SweepStarved,
} from './sma200-validity.js';

describe('resolveSma200PullbackMaxDistAtr (TRA-3440-guarded parse, TRA-4411 finite default)', () => {
  it('AC1 — a truly ABSENT var means the sweep-ratified finite default, 3.0', () => {
    expect(SMA200_PULLBACK_MAX_DIST_ATR_DEFAULT).toBe(3.0);
    expect(resolveSma200PullbackMaxDistAtr({})).toBe(3.0);
  });

  it('AC1 — blank / whitespace resolve DARK (Infinity): an explicit value we could not use never falls to 3.0', () => {
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '' })).toBe(Infinity);
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '   ' })).toBe(Infinity);
  });

  it('AC1 — garbage means DARK, never 0 and never 3.0 — Number("") is 0 and a 0 gate rejects every signal silently', () => {
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: 'abc' })).toBe(Infinity);
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: 'NaN' })).toBe(Infinity);
  });

  it('AC1 — non-positive values are refused as a config, not honored as a reject-all (and never 3.0)', () => {
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '0' })).toBe(Infinity);
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '-2' })).toBe(Infinity);
  });

  it('AC2 — an explicit env var overrides in BOTH directions', () => {
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '2.0' })).toBe(2.0);
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '4.5' })).toBe(4.5);
  });

  it('AC2 — SMA200_PULLBACK_MAX_DIST_ATR=Infinity restores the old dark gate: the flip is reversible by config without a deploy', () => {
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: 'Infinity' })).toBe(Infinity);
  });
});

// TRA-4617 AC4 — BOTH arms of the env parse: an explicit value is honoured,
// and blank/garbage resolves to the ruled 60, never 0 (`Number('')` is 0, and
// a 0-bar time cap would declare every signal expired at birth).
describe('resolveSma200PullbackTimeCapBars (TRA-4617, TRA-3440-guarded parse)', () => {
  it('an absent var means the ruled default, 60', () => {
    expect(SMA200_PULLBACK_TIME_CAP_BARS_DEFAULT).toBe(60);
    expect(resolveSma200PullbackTimeCapBars({})).toBe(60);
  });

  it('AC4 arm 1 — an explicit SMA200_PULLBACK_TIME_CAP_BARS=20 is honoured', () => {
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: '20' })).toBe(20);
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: '120' })).toBe(120);
  });

  it('AC4 arm 2 — blank / whitespace resolves to 60, never 0', () => {
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: '' })).toBe(60);
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: '   ' })).toBe(60);
  });

  it('AC4 arm 2 — garbage resolves to 60, never 0', () => {
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: 'abc' })).toBe(60);
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: 'NaN' })).toBe(60);
  });

  it('non-positive values are refused as a config: 0 and negatives resolve to 60', () => {
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: '0' })).toBe(60);
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: '-5' })).toBe(60);
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: '0.4' })).toBe(60);
  });

  it('there is NO dark arm — Infinity would mean "no cap", an exit model nobody ruled, so it resolves to 60', () => {
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: 'Infinity' })).toBe(60);
  });

  it('a fractional bar count is floored to a whole bar', () => {
    expect(resolveSma200PullbackTimeCapBars({ SMA200_PULLBACK_TIME_CAP_BARS: '20.9' })).toBe(20);
  });
});

describe('sma200PullbackExitModel (TRA-4617 / TRA-3688 S-2b stamp)', () => {
  it('carries the ruled literals: structural stop + time cap, takeProfit null BY RULING, provenance named', () => {
    expect(sma200PullbackExitModel(60)).toEqual({
      kind: 'structural_stop_time_capped',
      stopBasis: 'sma200_minus_1atr',
      timeCapBars: 60,
      takeProfit: null,
      ruledBy: 'TRA-3688 S-2b',
    });
  });
});

describe('sma200VoidVerdict (S-3)', () => {
  const sig = { entryPrice: 100, atr14: 4, barTimestamp: 1_000 };

  it('S-3a — void on bar rollover: a newer daily bar exists for the symbol', () => {
    expect(sma200VoidVerdict(sig, { latestBarTs: 2_000 })).toBe('bar_rollover');
  });

  it('S-3a — the signal\'s own bar is NOT a rollover (same-day scan must not void it)', () => {
    expect(sma200VoidVerdict(sig, { latestBarTs: 1_000 })).toBeNull();
  });

  it('S-3b — void on drift beyond 0.5 × ATR14 from the recorded entry, either direction', () => {
    const bound = SMA200_DRIFT_VOID_ATR * sig.atr14; // 2.0
    expect(sma200VoidVerdict(sig, { lastPrice: 100 + bound + 0.01 })).toBe('price_drift');
    expect(sma200VoidVerdict(sig, { lastPrice: 100 - bound - 0.01 })).toBe('price_drift');
    // AT the bound is not beyond it.
    expect(sma200VoidVerdict(sig, { lastPrice: 100 + bound })).toBeNull();
  });

  it('S-3a outranks S-3b when both would void (rollover carries the weight)', () => {
    expect(sma200VoidVerdict(sig, { latestBarTs: 2_000, lastPrice: 200 })).toBe('bar_rollover');
  });

  it('degrades safely on legacy rows: no atr14 ⇒ no drift verdict, no barTimestamp ⇒ no rollover verdict', () => {
    expect(sma200VoidVerdict({ entryPrice: 100, atr14: NaN as number, barTimestamp: undefined }, {
      latestBarTs: 2_000, lastPrice: 200,
    })).toBeNull();
  });

  it('a dark / broken quote (non-finite, 0) never voids — TRA-3440: a dark feed is not a low reading', () => {
    expect(sma200VoidVerdict(sig, { lastPrice: NaN })).toBeNull();
    expect(sma200VoidVerdict(sig, { lastPrice: 0 })).toBeNull();
  });
});

describe('sma200SweepVerdict (TRA-4457 — what an empty signal feed may mean)', () => {
  const base = {
    considered: 751, evaluated: 0,
    starvedBreakerOpen: 0, starvedShortHistory: 0, fetchFailed: 0,
  };

  it('BLIND: the whole sweep was starved by an open Yahoo breaker — the measured 2026-09-09 bqb1 shape', () => {
    // fetchDailyCandles returns [] without issuing a request while the global
    // rate-limit flag is set, so every symbol falls out of the < 250-bar guard.
    expect(sma200SweepVerdict({ ...base, starvedBreakerOpen: 751 })).toBe('BLIND');
  });

  it('SWEPT with zero fires: a HEALTHY quiet market — the arm that separates quiet from starved', () => {
    // This is the load-bearing control. `evaluated > 0` and nothing fired is a
    // real "no setup today"; grading on `fired` instead would call it BLIND and
    // re-create the exact ambiguity this verdict exists to remove.
    expect(sma200SweepVerdict({ ...base, evaluated: 745, starvedShortHistory: 6 })).toBe('SWEPT');
  });

  it('SWEPT: one scored symbol is enough — the feed is interpretable even if most of the sweep starved', () => {
    expect(sma200SweepVerdict({ ...base, evaluated: 1, starvedBreakerOpen: 750 })).toBe('SWEPT');
  });

  it('NO_UNIVERSE is NOT folded into BLIND — an empty watchlist is a different fault with a different remedy', () => {
    expect(sma200SweepVerdict({ ...base, considered: 0 })).toBe('NO_UNIVERSE');
  });

  it('a short-history starve with the breaker CLOSED is still BLIND when nothing scored, but is attributed separately', () => {
    const census = { ...base, considered: 3, starvedShortHistory: 3 };
    expect(sma200SweepVerdict(census)).toBe('BLIND');
    expect(census.starvedBreakerOpen).toBe(0); // not blamed on the feed
  });

  it('sma200SweepStarved totals every unscored cause', () => {
    expect(sma200SweepStarved({
      considered: 10, evaluated: 4,
      starvedBreakerOpen: 3, starvedShortHistory: 2, fetchFailed: 1,
    })).toBe(6);
  });
});
