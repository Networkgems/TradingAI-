// TRA-5061 (parent TRA-4992) — THE SIDE-BY-SIDE ATR SHADOW.
//
// ── What this file is answering ─────────────────────────────────────────────
// TRA-4992 shipped `CHANDELIER_ATR_TIMEFRAME` dark. Arming it is a board call,
// and the board cannot grade it from the flag: measured 2026-10-02 on live bqb1
// `104bc8ed`, the live exit hoist read `disarmed` (0 of 3 engines) and every
// book was flat, so the flag earns no rows until something arms. The shadow
// resolves BOTH trails on every ratchet the exit pass already performs and
// publishes both, with only the selected one deciding.
//
// ── What is asserted ────────────────────────────────────────────────────────
//  AC1  DURABLE, not since-boot. A simulated reboot (ledger cleared, same
//       DATA_DIR) still reads the earlier sessions, and the next observation
//       ADDS to the stored total instead of regressing it. Plus `armedAt`, so a
//       zero can be dated rather than mistaken for a long never.
//  AC2  the ELIGIBLE DENOMINATOR. `rowsSeen` partitions exactly into
//       `observations + pairAbsent + Σ rowsSkipped`; a skip-only pass publishes
//       every rate as `vacuous` with a NULL value, never a `0`; and the shadow's
//       `rowsSeen` AGREES with the TRA-4991 census's after a REAL `checkExits`
//       pass — which is the guarantee that replaces the forwarding this module
//       deliberately does not do (it would close an ESM cycle).
//  AC3  PER BOOK, never pooled. Live and demo accrue separately and `all` is
//       the fold, not the source.
//  AC4  BOTH RESOLUTIONS, not just both widths: the multiplier each arm
//       resolved and the `atrPct` that resolved it, the counterfactual
//       `no_daily_atr` rate on a cold daily store, and — the number an
//       ATR-ratio estimate of the flip gets wrong — the HALF-WIDTH ratio
//       through both of TRA-4992's paths at once.
//  AC5  labelled NON-EVIDENCE for P&L in the payload itself.
//  CONTROLS — the shadow's arms are the ENGINE's own numbers (not a
//       re-derivation), its min-bars gate is the producer's, and the 0.05
//       threshold is strict (`>`), which matters because QuantTrader measured
//       the real daily median at 0.0529, i.e. AT the cut.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { atr, atrPct, chandelierMultiplier } from '@trading-app/engine';
import {
  EXIT_CHANDELIER_ATR_MULT,
  EXIT_CHANDELIER_ATR_MULT_HIGHBETA,
  EXIT_CHANDELIER_HIGHBETA_ATRPCT,
  type Candle,
  type OtmMispricingSignal,
} from '@trading-app/shared';
import { PaperOptionsAccount, type OptionExitRiskInput } from './options-account.js';
import {
  CHANDELIER_ATR_PERIOD,
  SHADOW_CANDLE_TIMEFRAME_MS,
  measureCandleTimeframeMs,
  resetChandelierRatchetLedgerForTests,
  summarizeChandelierRatchets,
  type OptionChandelierAtrSource,
} from './option-chandelier-trail.js';
import {
  CHANDELIER_ATR_SHADOW_MIN_BARS,
  buildChandelierAtrShadowArm,
  noteChandelierAtrShadow,
  noteChandelierAtrShadowSkip,
  resetChandelierAtrShadowLedgerForTests,
  summarizeChandelierAtrShadow,
  type ChandelierAtrShadowPair,
} from './tra5061-chandelier-atr-shadow.js';
import {
  SHADOW_FLUSH_INTERVAL_MS,
  readChandelierAtrShadowDurable,
  resetChandelierAtrShadowStoreForTests,
  setChandelierAtrShadowDataDir,
} from './tra5061-chandelier-atr-shadow-store.js';

const SESSION_1 = Date.parse('2024-06-04T14:00:00Z'); // 10:00 ET Tuesday
const ET_DAY_1 = '2024-06-04';

/**
 * A candle series with a CONSTANT true range, so `atr` and `atrPct` are exact
 * rather than approximate.
 *
 * With `high = close + range/2`, `low = close - range/2` and every close equal,
 * each bar's true range is exactly `range` (the two gap terms collapse to
 * `range/2`), so `ATR(14) === range` and `atrPct === range / close`. That lets
 * a test pin a multiplier branch by construction instead of by tuning.
 */
function series(bars: number, range: number, close: number, tfMs: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < bars; i += 1) {
    out.push({
      symbol: 'AAPL',
      timestamp: SESSION_1 - (bars - 1 - i) * tfMs,
      open: close,
      high: close + range / 2,
      low: close - range / 2,
      close,
      volume: 1_000,
    });
  }
  return out;
}

const DAY_MS = 86_400_000;

/** 5m series: ATR 0.2 on a 200 close ⇒ atrPct 0.001, far BELOW the 0.05 cut ⇒ 3.0. */
const FIVE_M_BASE = (): Candle[] => series(480, 0.2, 200, SHADOW_CANDLE_TIMEFRAME_MS);
/** daily series: ATR 20 on a 200 close ⇒ atrPct 0.10, ABOVE the 0.05 cut ⇒ 3.5. */
const DAILY_HIGH_BETA = (): Candle[] => series(60, 20, 200, DAY_MS);
/** daily series: ATR 4 on a 200 close ⇒ atrPct 0.02, BELOW the cut ⇒ 3.0. */
const DAILY_BASE = (): Candle[] => series(60, 4, 200, DAY_MS);

function pair(
  fiveM: Candle[] | undefined,
  daily: Candle[] | undefined,
  decidedBy: 'shadow_5m' | 'daily' = 'shadow_5m',
): ChandelierAtrShadowPair {
  return {
    shadow5m: buildChandelierAtrShadowArm(fiveM, 'shadow_5m', measureCandleTimeframeMs),
    daily: buildChandelierAtrShadowArm(daily, 'daily', measureCandleTimeframeMs),
    decidedBy,
  };
}

let dir: string;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(SESSION_1);
  dir = await mkdtemp(join(tmpdir(), `tra5061-${process.pid}-`));
  resetChandelierAtrShadowStoreForTests();
  setChandelierAtrShadowDataDir(dir);
  resetChandelierAtrShadowLedgerForTests(SESSION_1);
  resetChandelierRatchetLedgerForTests(SESSION_1);
});

afterEach(async () => {
  vi.useRealTimers();
  setChandelierAtrShadowDataDir(null);
  await rm(dir, { recursive: true, force: true });
});

describe('TRA-5061 AC4 — both RESOLUTIONS, not just both widths', () => {
  it('publishes each arm\'s multiplier and the atrPct that resolved it', () => {
    const p = pair(FIVE_M_BASE(), DAILY_HIGH_BETA());

    // The 5m arm: a 0.1% 70-minute range. Nowhere near the 0.05 cut.
    expect(p.shadow5m.atrValue).toBeCloseTo(0.2, 9);
    expect(p.shadow5m.atrPctValue).toBeCloseTo(0.001, 9);
    expect(p.shadow5m.multiplier).toBe(EXIT_CHANDELIER_ATR_MULT);
    expect(p.shadow5m.halfWidthUsd).toBeCloseTo(0.6, 9);
    expect(p.shadow5m.timeframeMs).toBe(SHADOW_CANDLE_TIMEFRAME_MS);

    // The daily arm on the SAME underlying: 10% daily ATR ⇒ the 3.5 branch.
    expect(p.daily.atrValue).toBeCloseTo(20, 9);
    expect(p.daily.atrPctValue).toBeCloseTo(0.1, 9);
    expect(p.daily.multiplier).toBe(EXIT_CHANDELIER_ATR_MULT_HIGHBETA);
    expect(p.daily.halfWidthUsd).toBeCloseTo(70, 9);
    expect(p.daily.timeframeMs).toBe(DAY_MS);

    noteChandelierAtrShadow('demo', p);
    const t = summarizeChandelierAtrShadow('shadow_5m').byBook.demo.lifetime;
    expect(t.observations).toBe(1);
    expect(t.daily.highBeta).toBe(1);
    expect(t.daily.base).toBe(0);
    expect(t.shadow5m.base).toBe(1);
    expect(t.shadow5m.highBeta).toBe(0);
    // The 3.0 → 3.5 promotion, made directly observable: this is TRA-4992's
    // SECOND path, the one an ATR-ratio estimate of the flip cannot see.
    expect(t.multiplierDisagreements).toBe(1);
  });

  it('the HALF-WIDTH ratio is larger than the ATR ratio — the two-path correction', () => {
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    const { readings } = summarizeChandelierAtrShadow('shadow_5m').byBook.demo;

    const atrRatio = 20 / 0.2; // 100x — the estimate built from the ATR scale alone
    const trueRatio = (EXIT_CHANDELIER_ATR_MULT_HIGHBETA * 20) / (EXIT_CHANDELIER_ATR_MULT * 0.2);
    expect(trueRatio).toBeCloseTo(116.6667, 3);
    expect(readings.meanWidthRatio.value).toBeCloseTo(trueRatio, 6);
    // ⛔ The load-bearing inequality. A sizing prior derived from the ATR ratio
    // UNDERSTATES the flip, because the multiplier moves in the same flip.
    expect(readings.meanWidthRatio.value!).toBeGreaterThan(atrRatio);
    expect(readings.multiplierDisagreementRate.value).toBe(1);
  });

  it('a cold daily store yields the COUNTERFACTUAL no_daily_atr rate, and NO split reading', () => {
    // The daily store holds 3 bars for this underlying — cold.
    const p = pair(FIVE_M_BASE(), series(3, 20, 200, DAY_MS));
    expect(p.daily.unavailable).toBe('cold_series');
    expect(p.daily.atrValue).toBeNull();
    expect(p.daily.multiplier).toBeNull();
    expect(p.daily.halfWidthUsd).toBeNull();
    // The 5m arm is unaffected — this is a per-series fact, not a feed outage.
    expect(p.shadow5m.unavailable).toBeNull();

    noteChandelierAtrShadow('demo', p);
    const { lifetime, readings } = summarizeChandelierAtrShadow('shadow_5m').byBook.demo;
    expect(lifetime.daily.coldSeries).toBe(1);
    expect(lifetime.daily.resolved).toBe(0);

    // THE HEADLINE: 1 of 1 ratchets would have had no daily level.
    expect(readings.dailyColdRate.value).toBe(1);
    expect(readings.dailyColdRate.denominator).toBe(1);
    expect(readings.dailyColdRate.vacuous).toBe(false);

    // ⛔ And the split is NOT reported as 0. The daily arm resolved no
    // multiplier at all, so a `0` high-beta share would be a fabricated reading
    // about volatility over an empty denominator.
    expect(readings.dailyHighBetaShare.value).toBeNull();
    expect(readings.dailyHighBetaShare.vacuous).toBe(true);
    expect(readings.dailyHighBetaShare.denominator).toBe(0);
    // Likewise the width ratio: undefined when either arm is missing.
    expect(readings.meanWidthRatio.value).toBeNull();
    expect(readings.meanWidthRatio.vacuous).toBe(true);
  });

  it('a daily arm BELOW the cut resolves 3.0 — the split is two-sided, not a constant', () => {
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_BASE()));
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    const { lifetime, readings } = summarizeChandelierAtrShadow('shadow_5m').byBook.demo;
    expect(lifetime.daily.resolved).toBe(2);
    expect(lifetime.daily.base).toBe(1);
    expect(lifetime.daily.highBeta).toBe(1);
    expect(readings.dailyHighBetaShare.value).toBe(0.5);
    expect(readings.dailyHighBetaShare.denominatorIs).toContain('daily.resolved');
    // The 5m control: the branch stays unreached on today's shipped series.
    expect(readings.shadow5mHighBetaShare.value).toBe(0);
    expect(lifetime.daily.minAtrPct).toBeCloseTo(0.02, 9);
    expect(lifetime.daily.maxAtrPct).toBeCloseTo(0.1, 9);
  });
});

describe('TRA-5061 AC2 — the eligible denominator', () => {
  it('rowsSeen partitions into observations + pairAbsent + skips', () => {
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    noteChandelierAtrShadow('demo', undefined); // a hand-built input: no shadow map
    noteChandelierAtrShadowSkip('demo', 'multi_leg');
    noteChandelierAtrShadowSkip('demo', 'retired');
    noteChandelierAtrShadowSkip('demo', 'no_daily_atr');

    const t = summarizeChandelierAtrShadow('shadow_5m').byBook.demo.lifetime;
    const skipped = Object.values(t.rowsSkipped).reduce((a, b) => a + b, 0);
    expect(t.observations).toBe(1);
    expect(t.pairAbsent).toBe(1);
    expect(skipped).toBe(3);
    expect(t.rowsSeen).toBe(t.observations + t.pairAbsent + skipped);
    expect(t.rowsSeen).toBe(5);
    expect(t.rowsSkipped.multi_leg).toBe(1);
    expect(t.rowsSkipped.retired).toBe(1);
    expect(t.rowsSkipped.no_daily_atr).toBe(1);
  });

  it('a skip-only pass reports every rate VACUOUS with a null value, never 0', () => {
    noteChandelierAtrShadowSkip('demo', 'retired');
    noteChandelierAtrShadowSkip('demo', 'multi_leg');
    const { lifetime, readings } = summarizeChandelierAtrShadow('shadow_5m').byBook.demo;
    expect(lifetime.rowsSeen).toBe(2);
    expect(lifetime.observations).toBe(0);
    for (const r of Object.values(readings)) {
      expect(r.value).toBeNull();
      expect(r.vacuous).toBe(true);
    }
    // ⛔ The whole point: "the daily trail was never reachable" and "there were
    // no rows" must not read the same.
    expect(lifetime.rowsSkipped.retired).toBe(1);
  });

  it('an untouched book reports a DATED zero — 0 sessions, armedAt set', () => {
    const s = summarizeChandelierAtrShadow('shadow_5m');
    expect(s.byBook.live.lifetime.rowsSeen).toBe(0);
    expect(s.byBook.live.sessionsWithObservations).toBe(0);
    expect(s.byBook.live.sessions).toEqual([]);
    // Without this a 90-second-old store reads identically to a ten-session never.
    expect(s.durable.armedAt).toBe(SESSION_1);
    expect(s.durable.etDays).toBe(0);
  });
});

describe('TRA-5061 AC2 — the shadow census AGREES with the TRA-4991 census', () => {
  // This is the assertion that replaces forwarding `noteChandelierAtrShadowSkip`
  // from inside `noteChandelierRowSkipped` (which would close an ESM cycle). A
  // future sixth skip site that lands in one census and misses the other fails
  // HERE, against a real exit pass rather than against a comment.
  const UATR = 4;

  function buildOtmSignal(): OtmMispricingSignal {
    return {
      id: 'sig-5061',
      symbol: 'AAPL',
      type: 'otm_mispricing',
      side: 'buy',
      entryPrice: 1.0,
      stopLoss: 0.75,
      takeProfit: 1.5,
      riskRewardRatio: 2,
      timestamp: SESSION_1,
      optionSymbol: 'AAPL240705C00200000',
      optionType: 'call',
      strike: 200,
      expiration: '2024-07-05',
      mark: 1.0,
      theo: 1.3,
      mispricingPct: -0.23,
      delta: 0.18,
    };
  }

  const ATR_SOURCE: OptionChandelierAtrSource = {
    period: CHANDELIER_ATR_PERIOD,
    timeframeMs: SHADOW_CANDLE_TIMEFRAME_MS,
    series: 'shadow_5m',
    bars: 480,
  };

  function risk(over: Partial<OptionExitRiskInput> = {}): OptionExitRiskInput {
    return {
      underlyingAtrBySymbol: new Map([['AAPL', UATR]]),
      underlyingAtrSourceBySymbol: new Map([['AAPL', ATR_SOURCE]]),
      underlyingAtrShadowBySymbol: new Map([
        ['AAPL', pair(FIVE_M_BASE(), DAILY_HIGH_BETA())],
      ]),
      ...over,
    };
  }

  it('both censuses see the same rowsSeen after a real checkExits pass', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildOtmSignal(), 'demo', undefined, 200, {
      ivRank: 18,
      trend: 'up' as const,
      sentiment: null,
      riskThrottleMultiplier: 1,
      riskThrottleDecided: 1,
      riskThrottleSizingPath: 'options_single_leg' as const,
    });
    expect(pos).not.toBeNull();
    const sym = pos!.optionSymbol!;
    const opts = { otmSleeveExitRule: 'chandelier' } as const;

    acct.checkExits(new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo', opts, undefined, risk());

    const trail = summarizeChandelierRatchets().byMode.demo;
    const shadow = summarizeChandelierAtrShadow('shadow_5m').byBook.demo.lifetime;

    // NON-VACUITY FIRST: a pass that evaluated no row would make the agreement
    // below trivially true, which is the failure this guard is written against.
    expect(trail.rowsSeen).toBeGreaterThan(0);
    expect(trail.rowsSeen).toBe(shadow.rowsSeen);
    expect(trail.ratchets).toBe(shadow.observations);
    for (const [reason, n] of Object.entries(trail.skipped)) {
      expect(shadow.rowsSkipped[reason as keyof typeof trail.skipped]).toBe(n);
    }
    // And the pair reached the census: the daily counterfactual is populated
    // off a REAL ratchet, not a hand-noted one.
    expect(shadow.daily.highBeta).toBe(1);
    expect(shadow.pairAbsent).toBe(0);
  });

  it('a pass whose input carries no shadow map counts pairAbsent, not an observation', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildOtmSignal(), 'demo', undefined, 200, {
      ivRank: 18,
      trend: 'up' as const,
      sentiment: null,
      riskThrottleMultiplier: 1,
      riskThrottleDecided: 1,
      riskThrottleSizingPath: 'options_single_leg' as const,
    });
    const sym = pos!.optionSymbol!;
    acct.checkExits(
      new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo',
      { otmSleeveExitRule: 'chandelier' } as const, undefined,
      risk({ underlyingAtrShadowBySymbol: undefined }),
    );
    const shadow = summarizeChandelierAtrShadow('shadow_5m').byBook.demo.lifetime;
    expect(shadow.pairAbsent).toBe(1);
    expect(shadow.observations).toBe(0);
    // A version skew must not read as a quiet book.
    expect(shadow.rowsSeen).toBe(1);
  });
});

describe('TRA-5061 AC3 — per book, never pooled', () => {
  it('live and demo accrue separately and `all` is the fold', () => {
    noteChandelierAtrShadow('live', pair(FIVE_M_BASE(), DAILY_BASE()));
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));

    const s = summarizeChandelierAtrShadow('shadow_5m');
    expect(s.byBook.live.lifetime.observations).toBe(1);
    expect(s.byBook.demo.lifetime.observations).toBe(2);
    expect(s.all.lifetime.observations).toBe(3);

    // ⛔ The reading that a pooled census would destroy: demo is 100% high-beta
    // on the daily arm, live is 0%. A blended 67% would be a number about
    // nothing, and on this fleet the demo book is the only one accruing.
    expect(s.byBook.demo.readings.dailyHighBetaShare.value).toBe(1);
    expect(s.byBook.live.readings.dailyHighBetaShare.value).toBe(0);
    expect(s.byBook.live.lifetime.daily.highBeta).toBe(0);
  });
});

describe('TRA-5061 AC1 — durable, not since-boot', () => {
  it('survives a reboot and the next observation ADDS to the stored total', () => {
    // Three observations, each past the flush interval so each lands on disk.
    for (let i = 0; i < 3; i += 1) {
      vi.setSystemTime(SESSION_1 + i * (SHADOW_FLUSH_INTERVAL_MS + 1_000));
      noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    }
    expect(summarizeChandelierAtrShadow('shadow_5m').byBook.demo.lifetime.observations).toBe(3);

    // ── THE REBOOT ──────────────────────────────────────────────────────────
    // Process state gone, DATA_DIR unchanged. A since-boot counter reads 0 here
    // — which is exactly what the live surface published on the morning this
    // shipped, because the process had booted after the prior close (TRA-4343).
    resetChandelierAtrShadowLedgerForTests(SESSION_1);
    resetChandelierAtrShadowStoreForTests();

    const afterBoot = summarizeChandelierAtrShadow('shadow_5m').byBook.demo;
    expect(afterBoot.lifetime.observations).toBe(3);
    expect(afterBoot.lifetime.daily.highBeta).toBe(3);
    expect(afterBoot.sessionsWithObservations).toBe(1);
    expect(afterBoot.sessions[0]!.etDay).toBe(ET_DAY_1);

    // ── AND THE SEED, which is what makes the snapshots exact ───────────────
    // The fresh ledger must CONTINUE the day, not restart it. Without the disk
    // seed this next note would write a snapshot of `observations: 1` over a
    // stored 3 — a silent regression, the same undercount shape the durable
    // twin exists to remove.
    vi.setSystemTime(SESSION_1 + 4 * (SHADOW_FLUSH_INTERVAL_MS + 1_000));
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    expect(summarizeChandelierAtrShadow('shadow_5m').byBook.demo.lifetime.observations).toBe(4);

    // And the file holds history, not an overwrite.
    const durable = readChandelierAtrShadowDurable();
    const day = durable.days.find((d) => d.etDay === ET_DAY_1 && d.book === 'demo')!;
    expect(day.counters.observations).toBe(4);
    expect(day.snapshots).toBeGreaterThan(1);
    expect(durable.lines).toBe(durable.parsed); // no damaged lines
    expect(durable.droppedAtCap).toBe(0);
  });

  it('counts are partitioned by ET day, so a rate over sessions is derivable', () => {
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    // Next ET day.
    vi.setSystemTime(Date.parse('2024-06-05T14:00:00Z'));
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), series(3, 20, 200, DAY_MS)));

    const block = summarizeChandelierAtrShadow('shadow_5m').byBook.demo;
    expect(block.sessionsWithObservations).toBe(2);
    expect(block.sessions.map((s) => s.etDay)).toEqual([ET_DAY_1, '2024-06-05']);
    expect(block.lifetime.observations).toBe(2);
    // `today` is the second day only — the lifetime total is NOT today's.
    expect(block.today.observations).toBe(1);
    expect(block.today.daily.coldSeries).toBe(1);
    // The pre-registered accrual stop is quotable off this instrument.
    expect(summarizeChandelierAtrShadow('shadow_5m').preRegistered).toMatchObject({
      abandonDailyFlipIfDailyColdRateAbove: 0.25,
      abandonShadowIfObservationsBelow: 20,
      overEtSessions: 10,
    });
  });

  it('a milestone flushes immediately; a routine change inside the window is throttled', () => {
    // First observation is a milestone ⇒ on disk at once.
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    const afterFirst = readChandelierAtrShadowDurable().days.length;
    expect(afterFirst).toBe(1);
    const linesAfterFirst = readChandelierAtrShadowDurable().lines;

    // A second identical observation moves only counts whose milestones already
    // fired, inside the interval ⇒ no new line.
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    expect(readChandelierAtrShadowDurable().lines).toBe(linesAfterFirst);
    // ...but the in-memory ledger is ahead, and the summary folds it in, so the
    // throttle is invisible to a reader.
    expect(summarizeChandelierAtrShadow('shadow_5m').byBook.demo.lifetime.observations).toBe(2);

    // Past the interval, the snapshot catches up.
    vi.setSystemTime(SESSION_1 + SHADOW_FLUSH_INTERVAL_MS + 1_000);
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    expect(readChandelierAtrShadowDurable().lines).toBeGreaterThan(linesAfterFirst);
    const day = readChandelierAtrShadowDurable().days[0]!;
    expect(day.counters.observations).toBe(3);
  });

  it('with no DATA_DIR the instrument still runs, and says the durable half is absent', () => {
    setChandelierAtrShadowDataDir(null);
    resetChandelierAtrShadowLedgerForTests(SESSION_1);
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), DAILY_HIGH_BETA()));
    const s = summarizeChandelierAtrShadow('shadow_5m');
    // The since-boot half keeps working — an unset dir must not blind the route.
    expect(s.byBook.demo.lifetime.observations).toBe(1);
    // ...and it is legible as boot-scoped, never as a dated never.
    expect(s.durable.dataDir).toBeNull();
    expect(s.durable.armedAt).toBeNull();
    expect(s.durable.ephemeral).toBe(true);
  });
});

describe('TRA-5061 AC5 — labelled non-evidence for P&L', () => {
  it('the payload carries the evidence class and what it is NOT evidence for', () => {
    const s = summarizeChandelierAtrShadow('shadow_5m');
    expect(s.evidenceClass).toBe('reachability_only');
    expect(s.notEvidenceFor).toContain('crossedR');
    expect(s.notEvidenceFor).toContain('REAL FILLS');
    expect(s.issue).toBe('TRA-5061');
  });

  it('decidedBy names the arm that actually set the level', () => {
    expect(summarizeChandelierAtrShadow('shadow_5m').decidedBy).toBe('shadow_5m');
    expect(summarizeChandelierAtrShadow('daily').decidedBy).toBe('daily');
    const p = pair(FIVE_M_BASE(), DAILY_HIGH_BETA(), 'daily');
    expect(p.decidedBy).toBe('daily');
  });
});

describe('TRA-5061 controls — the shadow is the ENGINE\'s own arithmetic', () => {
  it('an arm reproduces atr / atrPct / chandelierMultiplier exactly', () => {
    const s = DAILY_HIGH_BETA();
    const arm = buildChandelierAtrShadowArm(s, 'daily', measureCandleTimeframeMs);
    // ⛔ Not "close to" — the SAME calls. This is what makes the unselected
    // column trustworthy: it is not a re-derivation of the trail's arithmetic.
    expect(arm.atrValue).toBe(atr(s, CHANDELIER_ATR_PERIOD));
    expect(arm.atrPctValue).toBe(atrPct(s, CHANDELIER_ATR_PERIOD));
    expect(arm.multiplier).toBe(chandelierMultiplier(arm.atrPctValue ?? undefined));
    expect(arm.halfWidthUsd).toBe(arm.multiplier! * arm.atrValue!);
    expect(arm.bars).toBe(s.length);
  });

  it('the min-bars gate is the producer\'s own 15', () => {
    expect(CHANDELIER_ATR_SHADOW_MIN_BARS).toBe(15);
    const justShort = series(CHANDELIER_ATR_SHADOW_MIN_BARS - 1, 4, 200, DAY_MS);
    const justEnough = series(CHANDELIER_ATR_SHADOW_MIN_BARS, 4, 200, DAY_MS);
    expect(buildChandelierAtrShadowArm(justShort, 'daily', measureCandleTimeframeMs).unavailable)
      .toBe('cold_series');
    expect(buildChandelierAtrShadowArm(justEnough, 'daily', measureCandleTimeframeMs).unavailable)
      .toBeNull();
    // An absent series is cold, with bars 0 — never a fabricated spacing.
    const missing = buildChandelierAtrShadowArm(undefined, 'daily', measureCandleTimeframeMs);
    expect(missing.unavailable).toBe('cold_series');
    expect(missing.bars).toBe(0);
    expect(missing.timeframeMs).toBeNull();
  });

  it('the 0.05 threshold is STRICT — atrPct exactly at the cut resolves 3.0', () => {
    // This matters because QuantTrader measured the real daily median at
    // 0.0529, i.e. essentially AT the cut (TRA-3241's "threshold at the mode"
    // shape). Which side the boundary falls on is a 17% width difference.
    const atCut = series(60, EXIT_CHANDELIER_HIGHBETA_ATRPCT * 200, 200, DAY_MS);
    const arm = buildChandelierAtrShadowArm(atCut, 'daily', measureCandleTimeframeMs);
    expect(arm.atrPctValue).toBeCloseTo(EXIT_CHANDELIER_HIGHBETA_ATRPCT, 9);
    expect(arm.multiplier).toBe(EXIT_CHANDELIER_ATR_MULT);

    const justOver = series(60, EXIT_CHANDELIER_HIGHBETA_ATRPCT * 200 * 1.01, 200, DAY_MS);
    expect(buildChandelierAtrShadowArm(justOver, 'daily', measureCandleTimeframeMs).multiplier)
      .toBe(EXIT_CHANDELIER_ATR_MULT_HIGHBETA);
  });

  it('a series with bars but no positive ATR is attributed separately from cold', () => {
    const flat = series(60, 0, 200, DAY_MS); // zero range ⇒ ATR 0, not positive
    const arm = buildChandelierAtrShadowArm(flat, 'daily', measureCandleTimeframeMs);
    expect(arm.unavailable).toBe('no_positive_atr');
    noteChandelierAtrShadow('demo', pair(FIVE_M_BASE(), flat));
    const t = summarizeChandelierAtrShadow('shadow_5m').byBook.demo.lifetime;
    expect(t.daily.noPositiveAtr).toBe(1);
    expect(t.daily.coldSeries).toBe(0);
  });
});
