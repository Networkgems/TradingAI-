/**
 * TRA-4992 (parent TRA-4945) — feed the OPTIONS chandelier a position-timeframe
 * ATR, behind `CHANDELIER_ATR_TIMEFRAME`, DEFAULT OFF.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `EXIT_CHANDELIER_ATR_MULT = 3.0` is Chande's chandelier constant, specified
 * against a DAILY ATR. The options path fed it `atr(shadowCandleCache)` where
 * that cache is `resampleCandles(minuteBars, 5 * 60_000)`, so the trail
 * half-width was three SEVENTY-MINUTE ranges. A unit error against the
 * constant's own specification, not a tuning preference — which is why the
 * repair is the INPUT and never the multiplier.
 *
 * ── What this suite refuses to let pass ─────────────────────────────────────
 *
 * Three of these ACs exist because a plausible implementation of the other two
 * would be unobservable or would move something out of scope:
 *
 *  • AC2 — `EXIT_CHANDELIER_ATR_MULT` is ALSO consumed by the live-equity broker
 *    stop-leg ratchet. A test, not an assurance.
 *  • AC3 — no silent fallback to the 5m ATR on a cold daily cache. A fallback
 *    makes the flag's effect unobservable, which defeats flagging it at all.
 *  • AC5 — ships dark and stays dark.
 *
 * ⚠️ EVERY env-flip assertion here carries a POSITIVE CONTROL in the same test:
 * proof that the flag was genuinely live in the process at the moment the
 * subject was measured. Without one, "the equity stop did not move" is satisfied
 * just as well by an env var that was never read — the assertion would pass for
 * a STRONGER reason than the predicate under test, and so prove nothing about
 * it. That is the trap this ticket's parent chain has been caught by before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  EXIT_CHANDELIER_ATR_MULT,
  EXIT_CHANDELIER_ATR_MULT_HIGHBETA,
  EXIT_CHANDELIER_HIGHBETA_ATRPCT,
  DEFAULT_ACCOUNT_SETTINGS,
} from '@trading-app/shared';
// ⚠ STATIC, not a lazy `await import` inside the helper. `signal-engine.ts` is a
// very large module and its first load took ~5s, which blew the default 5000ms
// test timeout on whichever test happened to run first — a failure that reads as
// a defect in that test's subject and moves when the file is reordered. A
// top-level import pays the cost once, during collection.
import { SignalEngine } from './signal-engine.js';
import { atr, atrPct, chandelierMultiplier, chandelierStop, stopModifyDecision } from '@trading-app/engine';
import {
  resolveChandelierAtrTimeframe,
  CHANDELIER_ATR_TIMEFRAME_VALUE,
  CHANDELIER_ATR_TIMEFRAME_DEFAULT,
} from './exit-risk-rules-flag.js';
import {
  CHANDELIER_ATR_PERIOD,
  SHADOW_CANDLE_TIMEFRAME_MS,
  DAILY_CANDLE_TIMEFRAME_MS,
  resolveChandelierTrailParams,
  measureCandleTimeframeMs,
} from './option-chandelier-trail.js';
import { setDailyBars, __resetMarketDataDailyCacheForTest } from './market-data-daily-cache.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A constant-true-range series: every bar spans `range` around `close`, so
 * `atr()` returns exactly `range` and `atrPct()` exactly `range / close` at any
 * depth. Deliberately degenerate — the subject here is WHICH series is read, and
 * a series whose ATR is a round number makes "which one answered" unambiguous.
 */
function flatSeries(
  symbol: string,
  bars: number,
  spacingMs: number,
  range: number,
  close: number,
  startAt = Date.parse('2026-01-05T14:30:00Z'),
): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < bars; i += 1) {
    out.push({
      symbol,
      timestamp: startAt + i * spacingMs,
      open: close,
      high: close + range / 2,
      low: close - range / 2,
      close,
      volume: 1_000 + i,
    });
  }
  return out;
}

const SYM = 'AAPL';
const SPOT = 100;

/**
 * The 5m arm: a 0.5-wide 5-minute range on a $100 name. `atrPct` 0.005, an
 * order of magnitude under the 0.05 high-beta threshold — which is the whole
 * point of AC4: on this series the 3.5 multiplier is effectively unreachable.
 */
const FIVE_MIN_RANGE = 0.5;
/**
 * The daily arm: an 8.00-wide DAILY range on the same $100 name. `atrPct` 0.08,
 * ABOVE the 0.05 threshold, so the high-beta branch resolves. Both numbers are
 * ordinary for a single name — the point is that one series says 0.5% and the
 * other says 8% about the SAME underlying, because they measure different
 * things, and `3.0 ×` them is two different stops.
 */
const DAILY_RANGE = 8;

const fiveMin = (): Candle[] => flatSeries(SYM, 480, SHADOW_CANDLE_TIMEFRAME_MS, FIVE_MIN_RANGE, SPOT);
const daily = (): Candle[] => flatSeries(SYM, 260, DAILY_CANDLE_TIMEFRAME_MS, DAILY_RANGE, SPOT);

let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env[CHANDELIER_ATR_TIMEFRAME_VALUE];
  delete process.env[CHANDELIER_ATR_TIMEFRAME_VALUE];
  __resetMarketDataDailyCacheForTest();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[CHANDELIER_ATR_TIMEFRAME_VALUE];
  else process.env[CHANDELIER_ATR_TIMEFRAME_VALUE] = savedFlag;
  __resetMarketDataDailyCacheForTest();
});

// ── The fixtures' own preconditions ─────────────────────────────────────────
//
// Asserted FIRST and separately: every AC below is a comparison between the two
// series, and if they happened to agree the comparisons would pass vacuously.

describe('TRA-4992 fixture preconditions — the two series genuinely disagree', () => {
  it('the 5m and daily ATRs differ by more than an order of magnitude, and only one is high-beta', () => {
    const a5 = atr(fiveMin(), CHANDELIER_ATR_PERIOD);
    const ad = atr(daily(), CHANDELIER_ATR_PERIOD);
    expect(a5).toBeCloseTo(FIVE_MIN_RANGE, 6);
    expect(ad).toBeCloseTo(DAILY_RANGE, 6);
    expect(ad! / a5!).toBeGreaterThan(10);

    // 3.0 × each: a 1.5-wide trail vs a 24-wide trail on a $100 name. The
    // measured consequence of the unit error, in one line.
    expect(EXIT_CHANDELIER_ATR_MULT * a5!).toBeCloseTo(1.5, 6);
    expect(EXIT_CHANDELIER_ATR_MULT * ad!).toBeCloseTo(24, 6);

    const p5 = atrPct(fiveMin(), CHANDELIER_ATR_PERIOD)!;
    const pd = atrPct(daily(), CHANDELIER_ATR_PERIOD)!;
    expect(p5).toBeLessThan(EXIT_CHANDELIER_HIGHBETA_ATRPCT);
    expect(pd).toBeGreaterThan(EXIT_CHANDELIER_HIGHBETA_ATRPCT);
  });

  it('measured spacing distinguishes the two series, and the daily one is NOT the nominal constant', () => {
    expect(measureCandleTimeframeMs(fiveMin())).toBe(SHADOW_CANDLE_TIMEFRAME_MS);
    // This fixture is a synthetic gap-free calendar grid, so it measures
    // exactly. A REAL daily series carries weekend/holiday gaps and only
    // normally lands here (1-day deltas outnumber weekend ones ~4:1 under the
    // LOWER MEDIAN) — which is why `DAILY_CANDLE_TIMEFRAME_MS` is documented
    // NOMINAL and nothing in prod gates on equality with it.
    expect(measureCandleTimeframeMs(daily())).toBe(DAILY_CANDLE_TIMEFRAME_MS);
    // The discrimination that IS robust: the two scales are ~288x apart, so a
    // daily read can never be mistaken for a 5m one.
    expect(DAILY_CANDLE_TIMEFRAME_MS / SHADOW_CANDLE_TIMEFRAME_MS).toBe(288);
  });
});

// ── AC1 — the resolver ──────────────────────────────────────────────────────

describe('TRA-4992 AC1 — resolveChandelierAtrTimeframe', () => {
  it('defaults to shadow_5m (today\'s behaviour) with source `default`', () => {
    expect(resolveChandelierAtrTimeframe({})).toEqual({ timeframe: 'shadow_5m', source: 'default' });
    expect(CHANDELIER_ATR_TIMEFRAME_DEFAULT).toBe('shadow_5m');
  });

  it('treats blank and whitespace-only as absent, never as a selection', () => {
    for (const raw of ['', '   ', '\t', '\n']) {
      expect(resolveChandelierAtrTimeframe({ [CHANDELIER_ATR_TIMEFRAME_VALUE]: raw }))
        .toEqual({ timeframe: 'shadow_5m', source: 'default' });
    }
  });

  it('selects `daily` on the exact token, case- and space-insensitively', () => {
    for (const raw of ['daily', 'DAILY', 'Daily', '  daily  ']) {
      expect(resolveChandelierAtrTimeframe({ [CHANDELIER_ATR_TIMEFRAME_VALUE]: raw }))
        .toEqual({ timeframe: 'daily', source: 'env' });
    }
  });

  it('accepts `shadow_5m` explicitly, distinguishing it from absence via `source`', () => {
    expect(resolveChandelierAtrTimeframe({ [CHANDELIER_ATR_TIMEFRAME_VALUE]: 'shadow_5m' }))
      .toEqual({ timeframe: 'shadow_5m', source: 'env' });
  });

  it('⛔ an INVALID value resolves to the OLD behaviour and says `env_invalid` — it never arms the repair', () => {
    // Every one of these is a plausible way to try to spell "daily" and get it
    // wrong. An ungraded exit input must not be reachable by a typo, and the
    // typo must be loud rather than silent: `env_invalid` is the one reading on
    // the health route that is a standing action item.
    for (const raw of ['dayly', 'day', '1d', '1D', 'daily_bars', 'DAILY ATR', '86400000', 'true', '1', '5m']) {
      expect(resolveChandelierAtrTimeframe({ [CHANDELIER_ATR_TIMEFRAME_VALUE]: raw }))
        .toEqual({ timeframe: 'shadow_5m', source: 'env_invalid' });
    }
  });

  it('is the OPPOSITE fail direction to resolveOtmSleeveExitRule, deliberately', () => {
    // There, the default IS the board's ruling and the legacy path is the
    // hazard. Here, the DEFAULT is the defect and the new input is UNGRADED, so
    // the safe fallback is the status quo. Pinned because the two resolvers sit
    // next to each other and "make them consistent" is the tempting wrong edit.
    expect(resolveChandelierAtrTimeframe({ [CHANDELIER_ATR_TIMEFRAME_VALUE]: 'garbage' }).timeframe)
      .toBe(CHANDELIER_ATR_TIMEFRAME_DEFAULT);
  });
});

// ── AC1 / AC3 / AC4 — the producer, driven for real ─────────────────────────
//
// These drive `SignalEngine.buildOptionExitRisk` itself through a private cast
// (the idiom `market-data-candle-cache.test.ts` already uses) rather than
// re-spelling its selection here. A re-spelling would assert what this file
// believes instead of what the producer does — the same vacuity AC3's counter
// exists to kill one level down.

type EnginePriv = {
  buildOptionExitRisk: () => {
    underlyingAtrBySymbol: Map<string, number>;
    underlyingAtrPctBySymbol?: Map<string, number>;
    underlyingAtrSourceBySymbol?: Map<string, { period: number; timeframeMs: number | null; bars: number; series: string }>;
    underlyingAtrInertBySymbol?: Map<string, string>;
  } | undefined;
  shadowCandleCache: Map<string, Candle[]>;
  optionsAccount: { getState: () => { openOptions: Array<{ symbol: string; legs?: unknown[] }> } };
};

/**
 * One open single-leg option on {@link SYM}, with whichever series the caller
 * warmed. Returns the producer's output.
 *
 * `openOptions` is stubbed rather than opened through `openOptionFromCandidate`:
 * the subject is the ATR SELECTION, and a real open drags in entry gates, a
 * clock and a journal, every one of which can fail the test for a reason that
 * has nothing to do with the timeframe.
 */
function runProducer(opts: { warm5m: boolean; warmDaily: boolean }) {
  const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' }) as unknown as EnginePriv;

  engine.shadowCandleCache.clear();
  if (opts.warm5m) engine.shadowCandleCache.set(SYM, fiveMin());
  if (opts.warmDaily) setDailyBars(SYM, daily());

  engine.optionsAccount.getState = () => ({ openOptions: [{ symbol: SYM }] });
  return engine.buildOptionExitRisk();
}

describe('TRA-4992 AC1 — the producer reads the SELECTED series', () => {
  it('flag UNSET ⇒ the 5m ATR, series `shadow_5m`, measured spacing 300000 (today\'s behaviour, unchanged)', () => {
    const out = runProducer({ warm5m: true, warmDaily: true });
    expect(out).toBeDefined();
    expect(out!.underlyingAtrBySymbol.get(SYM)).toBeCloseTo(FIVE_MIN_RANGE, 6);
    const src = out!.underlyingAtrSourceBySymbol?.get(SYM);
    expect(src?.series).toBe('shadow_5m');
    expect(src?.timeframeMs).toBe(SHADOW_CANDLE_TIMEFRAME_MS);
    expect(src?.period).toBe(CHANDELIER_ATR_PERIOD);
    // The daily store was WARM and was still not read. That is what makes this
    // a statement about selection rather than about availability.
    expect(out!.underlyingAtrBySymbol.get(SYM)).not.toBeCloseTo(DAILY_RANGE, 6);
    expect(out!.underlyingAtrInertBySymbol?.size ?? 0).toBe(0);
  });

  it('flag `daily` ⇒ the DAILY ATR, series `daily`, measured spacing 86400000', () => {
    process.env[CHANDELIER_ATR_TIMEFRAME_VALUE] = 'daily';
    const out = runProducer({ warm5m: true, warmDaily: true });
    expect(out).toBeDefined();
    expect(out!.underlyingAtrBySymbol.get(SYM)).toBeCloseTo(DAILY_RANGE, 6);
    const src = out!.underlyingAtrSourceBySymbol?.get(SYM);
    expect(src?.series).toBe('daily');
    expect(src?.timeframeMs).toBe(DAILY_CANDLE_TIMEFRAME_MS);
    // The 5m cache was warm too, so this is selection, not fallback.
    expect(out!.underlyingAtrBySymbol.get(SYM)).not.toBeCloseTo(FIVE_MIN_RANGE, 6);
  });

  it('⛔ an INVALID flag value leaves the producer on the 5m series (the repair is NOT armed by a typo)', () => {
    process.env[CHANDELIER_ATR_TIMEFRAME_VALUE] = 'dayly';
    const out = runProducer({ warm5m: true, warmDaily: true });
    expect(out!.underlyingAtrBySymbol.get(SYM)).toBeCloseTo(FIVE_MIN_RANGE, 6);
    expect(out!.underlyingAtrSourceBySymbol?.get(SYM)?.series).toBe('shadow_5m');
  });

  it('`series` and the MEASURED spacing move together — the pair catches "flag flipped, input did not"', () => {
    process.env[CHANDELIER_ATR_TIMEFRAME_VALUE] = 'daily';
    const out = runProducer({ warm5m: true, warmDaily: true });
    const src = out!.underlyingAtrSourceBySymbol?.get(SYM);
    // `series: 'daily'` with a spacing still at 300000 is the exact reading that
    // would mean the selector flipped and the cache did not. It must be
    // impossible, and the two fields are published precisely so it is visible.
    expect(src?.series).toBe('daily');
    expect(src?.timeframeMs).not.toBe(SHADOW_CANDLE_TIMEFRAME_MS);
  });
});

describe('TRA-4992 AC3 — fail CLOSED on a cold daily cache, with NO 5m fallback', () => {
  it('⛔ cold daily store + flag `daily` ⇒ NO ATR served, and emphatically NOT the 5m one', () => {
    process.env[CHANDELIER_ATR_TIMEFRAME_VALUE] = 'daily';
    // The 5m cache is WARM. This is the whole test: the fallback is available
    // and must not be taken. A fallback here would make the flag's effect
    // unobservable — the row would trail at noise width while the route
    // published `daily`.
    const out = runProducer({ warm5m: true, warmDaily: false });
    expect(out).toBeDefined();
    expect(out!.underlyingAtrBySymbol.has(SYM)).toBe(false);
    expect(out!.underlyingAtrBySymbol.get(SYM)).toBeUndefined();
    // No provenance stamped either: a row with no ATR has no series to claim.
    expect(out!.underlyingAtrSourceBySymbol?.has(SYM) ?? false).toBe(false);
    // And the refusal is ATTRIBUTED, which is what keeps it out of the
    // `no_spot_or_atr` (feed-outage) cell downstream.
    expect(out!.underlyingAtrInertBySymbol?.get(SYM)).toBe('cold_daily_atr');
  });

  it('the input object still EXISTS when every symbol is inert', () => {
    process.env[CHANDELIER_ATR_TIMEFRAME_VALUE] = 'daily';
    const out = runProducer({ warm5m: true, warmDaily: false });
    // Returning `undefined` here would make the exit pass count the row
    // `no_exit_risk` — "the exit-risk master is off", a STRUCTURAL zero — when
    // the master is on and the real reason is this cold cache. It would also
    // drop `openingRangeGuardMin`, silently widening the TRA-3217 suppression
    // window for the premium-trail and profit-lock legs, which are out of this
    // ticket's scope. The chandelier is still inert: the ATR map is empty.
    expect(out).toBeDefined();
    expect(out!.underlyingAtrBySymbol.size).toBe(0);
    expect(out!.underlyingAtrInertBySymbol?.size).toBe(1);
  });

  it('a cold 5m cache on the DEFAULT flag is NOT attributed to the repair', () => {
    // The pre-existing `no_spot_or_atr` behaviour. The new cell counts the
    // FLAG's cost of admission and nothing else, so a daily-store warm-up can
    // never be confused with a feed outage and vice versa.
    const out = runProducer({ warm5m: false, warmDaily: true });
    expect(out?.underlyingAtrBySymbol.has(SYM) ?? false).toBe(false);
    expect(out?.underlyingAtrInertBySymbol?.size ?? 0).toBe(0);
  });
});

describe('TRA-4992 AC4 — the high-beta threshold moves with the input', () => {
  it('⭐ the SAME underlying resolves 3.0 on the 5m series and 3.5 on the daily one', () => {
    // AC4's required assertion: flipping the flag changes WHICH multiplier a
    // fixed high-volatility series resolves to. Both multipliers come from
    // `chandelierMultiplier`, the engine's own comparison, never a re-spelling
    // of `atrPct > 0.05` in this file.
    const shadow = runProducer({ warm5m: true, warmDaily: true });
    const shadowPct = shadow!.underlyingAtrPctBySymbol?.get(SYM);
    expect(chandelierMultiplier(shadowPct)).toBeCloseTo(EXIT_CHANDELIER_ATR_MULT, 6);

    process.env[CHANDELIER_ATR_TIMEFRAME_VALUE] = 'daily';
    const dailyOut = runProducer({ warm5m: true, warmDaily: true });
    const dailyPct = dailyOut!.underlyingAtrPctBySymbol?.get(SYM);
    expect(chandelierMultiplier(dailyPct)).toBeCloseTo(EXIT_CHANDELIER_ATR_MULT_HIGHBETA, 6);

    // Not merely different numbers — the branch flipped on one underlying.
    expect(chandelierMultiplier(dailyPct)).not.toBeCloseTo(chandelierMultiplier(shadowPct), 6);
  });

  it('the trail width therefore moves through TWO paths at once, not one', () => {
    // Worth pinning because it is the part most likely to be mis-stated when
    // someone sizes the forward test: the daily flip multiplies the ATR AND
    // promotes the multiplier, so the width ratio is NOT just ATR_d / ATR_5m.
    const a5 = atr(fiveMin(), CHANDELIER_ATR_PERIOD)!;
    const ad = atr(daily(), CHANDELIER_ATR_PERIOD)!;
    const p5 = atrPct(fiveMin(), CHANDELIER_ATR_PERIOD)!;
    const pd = atrPct(daily(), CHANDELIER_ATR_PERIOD)!;

    const width5 = chandelierMultiplier(p5) * a5;
    const widthD = chandelierMultiplier(pd) * ad;
    expect(width5).toBeCloseTo(1.5, 6);   // 3.0 × 0.5
    expect(widthD).toBeCloseTo(28, 6);    // 3.5 × 8   ← not 3.0 × 8 = 24
    // The width ratio STRICTLY exceeds the ATR ratio: the extra factor is the
    // multiplier promotion, which an ATR-only estimate would miss.
    expect(widthD / width5).toBeGreaterThan(ad / a5);
  });

  it('the published params state which timeframe the threshold is calibrated for', () => {
    // AC4 asks for this explicitly: the 0.05 constant does NOT move with the
    // flag, so the surface has to say what it was calibrated against or a
    // reader cannot tell whether it is meaningful on the selected series.
    expect(resolveChandelierTrailParams({}).highBetaAtrPctCalibratedFor).toBe('daily');
    expect(resolveChandelierTrailParams({}).highBetaAtrPct).toBe(EXIT_CHANDELIER_HIGHBETA_ATRPCT);
  });
});

// ── AC2 — the live-equity path is untouched ─────────────────────────────────

describe('TRA-4992 AC2 — the live-equity broker stop-leg ratchet does not move', () => {
  /**
   * The equity ratchet's own arithmetic, exactly as `trailLiveEquityStops`
   * performs it (`signal-engine.ts`): ATR off `this.candleCache` — its OWN
   * minute-bar cache, never `underlyingAtrBySymbol` — then `chandelierStop`,
   * then `stopModifyDecision`.
   */
  function equityRatchet() {
    const candles = flatSeries('MSFT', 400, 60_000, 0.8, 300);
    const a = atr(candles)!;
    const ap = atrPct(candles)!;
    const side = 'buy' as const;
    const desiredStop = chandelierStop({
      side,
      initialStop: 290,
      extremeSinceEntry: 310,
      atr: a,
      atrPct: Number.isFinite(ap) ? ap : undefined,
      prevTrailStop: 295,
    });
    const decision = stopModifyDecision({
      side, brokerStop: 295, desiredStop, minTick: 0.01,
    });
    return { atr: a, desiredStop, decision };
  }

  it('⭐ driven with the flag set to `daily`, `desiredStop` is UNCHANGED — with a positive control', () => {
    const before = equityRatchet();

    process.env[CHANDELIER_ATR_TIMEFRAME_VALUE] = 'daily';

    // ⚠️ POSITIVE CONTROL, in this test and at this instant. Without it,
    // "unchanged" is also what you get from an env var nothing reads, and the
    // assertion would hold for a stronger reason than the one under test.
    expect(resolveChandelierAtrTimeframe().timeframe).toBe('daily');
    const opt = runProducer({ warm5m: true, warmDaily: true });
    expect(opt!.underlyingAtrSourceBySymbol?.get(SYM)?.series).toBe('daily');
    expect(opt!.underlyingAtrBySymbol.get(SYM)).toBeCloseTo(DAILY_RANGE, 6);

    // The flag is live, the OPTIONS path moved — and the equity path did not.
    const after = equityRatchet();
    expect(after.desiredStop).toBe(before.desiredStop);
    expect(after.atr).toBe(before.atr);
    expect(after.decision).toEqual(before.decision);
  });

  it('the equity ratchet\'s ATR is a different number from the daily chandelier ATR', () => {
    // So "unchanged" is not an accident of the two paths happening to agree.
    const eq = equityRatchet();
    expect(eq.atr).not.toBeCloseTo(DAILY_RANGE, 6);
    expect(eq.atr).not.toBeCloseTo(FIVE_MIN_RANGE, 6);
  });

  it('the multiplier is SHARED while the input is not — which is why this AC exists', () => {
    // `EXIT_CHANDELIER_ATR_MULT` is one constant consumed by two callers. The
    // repair had to change the options caller's INPUT precisely because
    // changing the constant would have moved the broker stop-leg ratchet on
    // real money. Pinned as the reason, not just the fact.
    expect(EXIT_CHANDELIER_ATR_MULT).toBe(3.0);
    const eq = equityRatchet();
    expect(eq.desiredStop).toBeCloseTo(310 - EXIT_CHANDELIER_ATR_MULT * eq.atr, 6);
  });
});

// ── AC5 — ships dark ────────────────────────────────────────────────────────

describe('TRA-4992 AC5 — the published surface still reads 5m with the flag unset', () => {
  it('⭐ `resolveChandelierTrailParams({})` publishes supertrend_shadow_5m / 300000 / source default', () => {
    // This is the assertion the post-deploy re-GET of
    // /api/health/option-swing-exits -> chandelier mirrors. Deploy with the flag
    // unset and the route must still read 5m; anything else means it shipped
    // armed.
    const p = resolveChandelierTrailParams({});
    expect(p.atrSeries).toBe('supertrend_shadow_5m');
    expect(p.atrTimeframeMs).toBe(SHADOW_CANDLE_TIMEFRAME_MS);
    expect(p.atrTimeframeMs).toBe(300_000);
    expect(p.atrTimeframe).toEqual({
      timeframe: 'shadow_5m',
      source: 'default',
      envKey: CHANDELIER_ATR_TIMEFRAME_VALUE,
    });
    // AC5 is about the INPUT only — the multiplier was never in scope.
    expect(p.atrMult).toBe(EXIT_CHANDELIER_ATR_MULT);
    expect(p.atrMultHighBeta).toBe(EXIT_CHANDELIER_ATR_MULT_HIGHBETA);
    expect(p.atrPeriod).toBe(CHANDELIER_ATR_PERIOD);
  });

  it('publishes the daily selection when armed, so the arm is readable without a redeploy diff', () => {
    const p = resolveChandelierTrailParams({ [CHANDELIER_ATR_TIMEFRAME_VALUE]: 'daily' });
    expect(p.atrSeries).toBe('daily_bars');
    expect(p.atrTimeframeMs).toBe(DAILY_CANDLE_TIMEFRAME_MS);
    expect(p.atrTimeframe.source).toBe('env');
  });

  it('⛔ a MISSPELLED arm publishes the old series AND flags the typo', () => {
    // The failure mode this route exists to make visible: an operator believes
    // the repair is armed, the box is running the defect. `atrSeries` says what
    // is running; `source: env_invalid` says somebody meant otherwise.
    const p = resolveChandelierTrailParams({ [CHANDELIER_ATR_TIMEFRAME_VALUE]: 'dayly' });
    expect(p.atrSeries).toBe('supertrend_shadow_5m');
    expect(p.atrTimeframeMs).toBe(SHADOW_CANDLE_TIMEFRAME_MS);
    expect(p.atrTimeframe.source).toBe('env_invalid');
  });
});
