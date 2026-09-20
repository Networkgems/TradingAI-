import { describe, it, expect } from 'vitest';
import { DEFAULT_MAKER_WALK_CONFIG, type MakerWalkConfig } from './option-maker-config.js';
import {
  ladderRungRecoveries,
  requiredFillRate,
  summarizeLadderCeiling,
  beginShadowChase,
  advanceShadowChase,
  activeRung,
  summarizeShadowRecovery,
  buildRecoveryVerdicts,
  BREAKEVEN_MAKER_RECOVERY,
  type ShadowChaseEvent,
} from './option-maker-shadow.js';

const CFG: MakerWalkConfig = DEFAULT_MAKER_WALK_CONFIG;

describe('ladder ceiling — the geometry that decides without any fill data', () => {
  it('recovery at rung f is exactly 1 − f, INDEPENDENT of how wide the spread is', () => {
    // The load-bearing identity of TRA-1662. A rung placed f of the way from mid
    // to ask pays f × halfSpread, so it recovers (1 − f) of the raw cross — no
    // matter whether the book is 2 ticks wide or 200.
    const narrow = ladderRungRecoveries({ bid: 1.0, ask: 1.04 }, CFG); // hs = 2 ticks
    const wide = ladderRungRecoveries({ bid: 1.0, ask: 3.0 }, CFG); // hs = 100 ticks
    expect(narrow).not.toBeNull();
    expect(wide).not.toBeNull();

    for (const [i, f] of [0.25, 0.5, 0.75, 1.0].entries()) {
      const rung = i + 1; // rungs 1..4 (rung 0 is the mid+1¢ bias step)
      expect(narrow![rung]!.recoveryPct).toBeCloseTo(1 - f, 10);
      expect(wide![rung]!.recoveryPct).toBeCloseTo(1 - f, 10);
    }
  });

  it('rung 0 (mid + 1 tick) is the ONLY rung whose recovery depends on spread width', () => {
    // 1 − tick/halfSpread. A wide book recovers nearly everything at mid+1¢;
    // a 2-tick book recovers only half.
    const wide = ladderRungRecoveries({ bid: 1.0, ask: 3.0 }, CFG)!; // hs = $1.00 = 100 ticks
    expect(wide[0]!.recoveryPct).toBeCloseTo(1 - 0.01 / 1.0, 10); // 99%

    const narrow = ladderRungRecoveries({ bid: 1.0, ask: 1.04 }, CFG)!; // hs = $0.02 = 2 ticks
    expect(narrow[0]!.recoveryPct).toBeCloseTo(1 - 0.01 / 0.02, 10); // 50%
  });

  it('a one-sided or zero-width quote yields no ladder (never a free recovery)', () => {
    expect(ladderRungRecoveries({ bid: 0, ask: 1.2 }, CFG)).toBeNull();
    expect(ladderRungRecoveries({ bid: 1.2, ask: 1.2 }, CFG)).toBeNull();
  });

  it('requiredFillRate inverts the unknown, and returns null when unreachable', () => {
    // Need 40% recovery from a rung that pays 80% when it fills, zero-slip tail:
    // p = 0.40 / 0.80 = 50%.
    expect(requiredFillRate(0.4, 0.8)).toBeCloseTo(0.5, 10);
    // A target above what the rung can earn at a 100% fill is geometrically
    // impossible — no fill rate rescues it.
    expect(requiredFillRate(0.9, 0.75)).toBeNull();
    // A negative tail (the ask ran away) RAISES the required fill rate.
    expect(requiredFillRate(0.4, 0.8, -0.2)!).toBeGreaterThan(requiredFillRate(0.4, 0.8)!);
  });

  it('OTM: the 73.6% breakeven is unreachable past rung 1 — it must fill at mid+1¢', () => {
    // Typical measured OTM book: spread ≈ 5.88% of a ~$2.00 mark ⇒ hs ≈ $0.059 ≈ 6 ticks.
    const quotes = Array.from({ length: 200 }, () => ({ bid: 1.941, ask: 2.059 }));
    const ceiling = summarizeLadderCeiling(
      'single_leg_otm',
      quotes,
      CFG,
      BREAKEVEN_MAKER_RECOVERY['single_leg_otm']!,
    )!;

    // Rung 0 CAN clear it (1 − 1/5.9 ≈ 83%) but rung 1 caps at 75% < 73.6%… barely
    // clears; rung 2 (50%) and beyond cannot. That is the whole finding: OTM's
    // breakeven lives entirely in the top two rungs of the ladder.
    expect(ceiling.rungs[2]!.requiredFillRateForBreakeven).toBeNull(); // 50% < 73.6% ⇒ impossible
    expect(ceiling.rungs[3]!.requiredFillRateForBreakeven).toBeNull(); // 25% ⇒ impossible
    expect(ceiling.rungs[4]!.requiredFillRateForBreakeven).toBeNull(); // 0% (the ask) ⇒ impossible

    // And even at rung 0 it needs a punishing fill rate.
    expect(ceiling.rungs[0]!.requiredFillRateForBreakeven!).toBeGreaterThan(0.85);
    expect(ceiling.breakevenGeometricallyImpossible).toBe(false);
    expect(ceiling.avgHalfSpreadTicks).toBeCloseTo(5.9, 1);
  });

  it('RV: the 30.8% breakeven is reachable from the top three rungs', () => {
    // RV book: spread ≈ 4.00% of mark ⇒ hs = 2% of mark. At a $2.00 mark, hs = $0.04 = 4 ticks.
    const quotes = Array.from({ length: 200 }, () => ({ bid: 1.96, ask: 2.04 }));
    const ceiling = summarizeLadderCeiling(
      'single_leg_rv',
      quotes,
      CFG,
      BREAKEVEN_MAKER_RECOVERY['single_leg_rv']!,
    )!;

    expect(ceiling.breakevenGeometricallyImpossible).toBe(false);
    // rung 0 pays 75% (1 − 1/4) ⇒ needs only ~41% fills; rung 1 pays 75% ⇒ same;
    // rung 2 pays 50% ⇒ needs ~62%. All plausible.
    expect(ceiling.rungs[0]!.requiredFillRateForBreakeven!).toBeLessThan(0.5);
    expect(ceiling.rungs[2]!.requiredFillRateForBreakeven!).toBeLessThan(0.7);
    // The last rung IS the ask — it recovers nothing, so it can never carry breakeven.
    expect(ceiling.rungs[4]!.requiredFillRateForBreakeven).toBeNull();
  });

  it('flags a target that no rung can reach as geometrically impossible', () => {
    // A 2-tick half-spread book. Best rung recovers 75%, so a 90% target is
    // unreachable at ANY fill rate on ANY rung.
    const quotes = Array.from({ length: 10 }, () => ({ bid: 1.0, ask: 1.04 }));
    const ceiling = summarizeLadderCeiling('tight', quotes, CFG, 0.9)!;
    expect(ceiling.maxAchievableRecoveryPct).toBeCloseTo(0.75, 10);
    expect(ceiling.breakevenGeometricallyImpossible).toBe(true);
    expect(ceiling.rungs.every((r) => r.requiredFillRateForBreakeven === null)).toBe(true);
  });

  it('production ladder is NON-MONOTONIC on books tighter than 4 ticks of half-spread', () => {
    // Documenting a real property of `buildWalkLimits`, surfaced by this
    // measurement. Rung 0 is `mid + min(tick, halfSpread)`; rung 1 is
    // `mid + 0.25 × halfSpread`. When halfSpread < 4 ticks the tick-bias step is
    // the MORE aggressive of the two, so the walk steps UP then RETREATS — it is
    // not a monotone march toward the ask, and rung 0 is not the least aggressive
    // rung. Consequence for this measurement: `maxAchievableRecoveryPct` must be
    // the max over rungs, never assumed to be rung 0.
    const hs = 0.02; // 2 ticks
    const rungs = ladderRungRecoveries({ bid: 1.0, ask: 1.0 + 2 * hs }, CFG)!;
    expect(rungs[0]!.limitUsd).toBeGreaterThan(rungs[1]!.limitUsd); // steps DOWN at rung 1
    expect(rungs[0]!.recoveryPct).toBeLessThan(rungs[1]!.recoveryPct); // ⇒ recovers LESS
    // On a book wider than 4 ticks the usual ordering holds.
    const wide = ladderRungRecoveries({ bid: 1.0, ask: 2.0 }, CFG)!;
    expect(wide[0]!.recoveryPct).toBeGreaterThan(wide[1]!.recoveryPct);
  });
});

describe('shadow chase — forward capture', () => {
  const open = (bid: number, ask: number, ts = 1_000) =>
    beginShadowChase(
      {
        side: 'open',
        structure: 'single_leg_rv',
        mode: 'demo',
        symbol: 'AAPL',
        expiration: '2026-07-17',
        optionSymbol: 'AAPL260717C00200000',
        contracts: 2,
        bid,
        ask,
      },
      CFG,
      ts,
    );

  it('drops a one-sided quote rather than booking it as a free chase', () => {
    expect(open(0, 1.2)).toBeNull();
    expect(open(1.2, 1.2)).toBeNull();
  });

  it('materialises the PRODUCTION ladder off the decision quote', () => {
    const s = open(1.0, 2.0)!; // mid 1.50, hs 0.50
    expect(s.decisionMid).toBeCloseTo(1.5, 10);
    expect(s.rawCrossUsd).toBeCloseTo(0.5, 10);
    // mid+1¢, then 25/50/75/100% of the way to the ask.
    expect(s.limits.map((l) => Number(l.toFixed(4)))).toEqual([1.51, 1.625, 1.75, 1.875, 2.0]);
  });

  it('mirrors the ladder through the mid for a sell-to-close', () => {
    const s = beginShadowChase(
      {
        side: 'close',
        structure: 'single_leg_rv',
        mode: 'demo',
        symbol: 'AAPL',
        expiration: '2026-07-17',
        optionSymbol: 'AAPL260717C00200000',
        contracts: 1,
        bid: 1.0,
        ask: 2.0,
      },
      CFG,
      0,
    )!;
    // Reflection of [1.51, 1.625, 1.75, 1.875, 2.0] about mid=1.50.
    expect(s.limits.map((l) => Number(l.toFixed(4)))).toEqual([1.49, 1.375, 1.25, 1.125, 1.0]);
  });

  it('walks the rungs in wall-clock at stepWaitMs', () => {
    const s = open(1.0, 2.0, 0)!;
    expect(activeRung(s, 0)).toBe(0);
    expect(activeRung(s, 29_999)).toBe(0);
    expect(activeRung(s, 30_000)).toBe(1);
    expect(activeRung(s, 120_000)).toBe(4);
    expect(activeRung(s, 150_000)).toBeNull(); // exhausted
  });

  it('rests while the ask stays above the limit, and fills AT the limit when it comes to us', () => {
    const s = open(1.0, 2.0, 0)!; // rung 0 limit = 1.51
    expect(advanceShadowChase(s, { bid: 1.0, ask: 2.0 }, 1_000)).toBeNull(); // ask 2.00 > 1.51 → rest
    expect(advanceShadowChase(s, { bid: 1.0, ask: 1.6 }, 2_000)).toBeNull(); // 1.60 > 1.51 → rest

    const ev = advanceShadowChase(s, { bid: 1.4, ask: 1.5 }, 3_000)!; // 1.50 ≤ 1.51 → FILL
    expect(ev.result).toBe('filled');
    expect(ev.rung).toBe(0);
    // We rest at 1.51, so we pay 1.51 — NOT the better prevailing 1.50. A resting
    // limit order does not receive price improvement.
    expect(ev.realizedCrossUsd).toBeCloseTo(0.01, 10);
    expect(ev.recoveryPct).toBeCloseTo(1 - 0.01 / 0.5, 10); // 98%
    expect(ev.realizedCrossTotalUsd).toBeCloseTo(0.01 * 2 * 100, 10);
    expect(ev.timeToFillMs).toBe(3_000);
    expect(ev.polls).toBe(3);
  });

  it('prices the chase-to-taker tail at the PREVAILING ask — negative recovery when the market ran away', () => {
    const s = open(1.0, 2.0, 0)!;
    // Ladder exhausts at 150s. The ask has run from 2.00 → 2.40 while we rested.
    const ev = advanceShadowChase(s, { bid: 1.9, ask: 2.4 }, 150_000)!;
    expect(ev.result).toBe('exhausted_to_taker');
    // We now pay 2.40 vs a decision mid of 1.50 ⇒ 0.90 cross vs a 0.50 raw cross.
    expect(ev.realizedCrossUsd).toBeCloseTo(0.9, 10);
    expect(ev.recoveryPct).toBeCloseTo(1 - 0.9 / 0.5, 10); // −80%: WORSE than crossing at t0
    expect(ev.recoveryPct).toBeLessThan(0);
  });

  it('a flat tail costs exactly the cross we declined — recovery 0, not a free pass', () => {
    const s = open(1.0, 2.0, 0)!;
    const ev = advanceShadowChase(s, { bid: 1.0, ask: 2.0 }, 150_000)!;
    expect(ev.result).toBe('exhausted_to_taker');
    expect(ev.recoveryPct).toBeCloseTo(0, 10);
  });

  it('abandons (rather than flatters) a chase whose touch went dark at exhaustion', () => {
    const s = open(1.0, 2.0, 0)!;
    const ev = advanceShadowChase(s, { bid: 0, ask: 0 }, 150_000)!;
    expect(ev.result).toBe('abandoned');
  });
});

describe('rollup — survivorship honesty', () => {
  const ev = (o: Partial<ShadowChaseEvent>): ShadowChaseEvent => ({
    ts: 1,
    side: 'open',
    structure: 'single_leg_rv',
    mode: 'demo',
    optionSymbol: 'X',
    result: 'filled',
    rawCrossUsd: 0.5,
    realizedCrossUsd: 0.1,
    recoveryPct: 0.8,
    realizedCrossTotalUsd: 10,
    polls: 1,
    ...o,
  });

  it('separates the flattering fills-only mean from the tail-aware expectancy', () => {
    // 3 fills recovering 80%, 1 exhausted chase that paid DOUBLE the raw cross (−100%).
    const events = [
      ev({}),
      ev({}),
      ev({}),
      ev({ result: 'exhausted_to_taker', realizedCrossUsd: 1.0, recoveryPct: -1.0 }),
    ];
    const [stat] = summarizeShadowRecovery(events);

    expect(stat!.attempts).toBe(4);
    expect(stat!.fills).toBe(3);
    expect(stat!.makerFillRate).toBeCloseTo(0.75, 10);
    // The survivorship-biased number the issue warns about: a rosy 80%…
    expect(stat!.avgRecoveryPctOnFills).toBeCloseTo(0.8, 10);
    // …while the honest expectancy is (0.8·3 + −1.0) / 4 = 35%.
    expect(stat!.avgRecoveryPctAllAttempts).toBeCloseTo(0.35, 10);
    expect(stat!.avgRecoveryPctAllAttempts!).toBeLessThan(stat!.avgRecoveryPctOnFills!);

    // The unfilled leg, priced: it paid 0.50/share MORE than crossing at decision time.
    expect(stat!.tail.count).toBe(1);
    expect(stat!.tail.avgRecoveryPct).toBeCloseTo(-1.0, 10);
    expect(stat!.tail.avgExcessVsImmediateCrossUsd).toBeCloseTo(0.5, 10);
  });

  it('excludes abandoned chases from every statistic (measurement failure, not an outcome)', () => {
    const [stat] = summarizeShadowRecovery([ev({}), ev({ result: 'abandoned', recoveryPct: 0 })]);
    expect(stat!.attempts).toBe(1);
    expect(stat!.fills).toBe(1);
    expect(stat!.makerFillRate).toBe(1);
  });

  it('splits by structure and side', () => {
    const stats = summarizeShadowRecovery([
      ev({ structure: 'single_leg_rv', side: 'open' }),
      ev({ structure: 'single_leg_otm', side: 'open' }),
      ev({ structure: 'single_leg_rv', side: 'close' }),
    ]);
    expect(stats.map((s) => `${s.structure}|${s.side}`)).toEqual([
      'single_leg_otm|open',
      'single_leg_rv|close',
      'single_leg_rv|open',
    ]);
  });

  it('reports the recovery distribution, not just the mean', () => {
    const events = [-1.0, 0, 0.5, 0.75, 0.98].map((r) =>
      ev({ recoveryPct: r, result: r < 0 ? 'exhausted_to_taker' : 'filled' }),
    );
    const [stat] = summarizeShadowRecovery(events);
    expect(stat!.p50RecoveryPct).toBeCloseTo(0.5, 10);
    expect(stat!.p10RecoveryPct!).toBeLessThan(stat!.p50RecoveryPct!);
    expect(stat!.p90RecoveryPct!).toBeGreaterThan(stat!.p50RecoveryPct!);
  });

  describe('verdict assembly — an ungraded cell must not read as a graded one', () => {
    // The defect this suite exists to kill, measured on bqb1 build 50671745 on
    // 2026-09-20: `verdicts` was built by INTERSECTING the measured structures
    // with the breakeven table. The table keyed the dead `single_leg_rv` sleeve
    // and carried no `directional` entry, so the live primary cell (n=353) was
    // dropped and the payload showed a one-row table that looked complete.

    it('grades the live primary cell `directional` instead of silently dropping it', () => {
      const verdicts = buildRecoveryVerdicts(
        summarizeShadowRecovery([
          ev({ structure: 'directional', side: 'open', recoveryPct: -0.1156 }),
        ]),
      );
      const d = verdicts.find((v) => v.structure === 'directional');
      expect(d).toBeDefined();
      expect(d!.state).toBe('graded');
      expect(d!.attempts).toBe(1);
      expect(d!.coversItsOwnSpread).toBe(false);
      // …and it is honest that the bar is a carried prior, not a re-derivation.
      expect(d!.breakevenBasis).toBe('carried_prior');
    });

    it('reports a breakeven sleeve with NO attempts as `no_measurement`, never as 0% or absent', () => {
      // TRA-1662, in as many words: "a structure cell that comes back empty is
      // not a recovery rate of zero — it is no measurement."
      const verdicts = buildRecoveryVerdicts(
        summarizeShadowRecovery([ev({ structure: 'single_leg_otm', side: 'open' })]),
      );
      const rv = verdicts.find((v) => v.structure === 'single_leg_rv');
      expect(rv).toBeDefined();
      expect(rv!.state).toBe('no_measurement');
      expect(rv!.attempts).toBe(0);
      // The load-bearing assertion: no verdict, and crucially NOT `false`/`true`.
      expect(rv!.coversItsOwnSpread).toBeNull();
      expect(rv!.measuredRecoveryPctAllAttempts).toBeNull();
    });

    it('surfaces a measured sleeve with no breakeven entry as `ungraded_no_breakeven`', () => {
      // A new sleeve must never go invisible just because nobody added its bar.
      const verdicts = buildRecoveryVerdicts(
        summarizeShadowRecovery([ev({ structure: 'vertical_spread', side: 'open' })]),
      );
      const v = verdicts.find((x) => x.structure === 'vertical_spread');
      expect(v).toBeDefined();
      expect(v!.state).toBe('ungraded_no_breakeven');
      expect(v!.attempts).toBe(1);
      expect(v!.breakevenRecoveryPct).toBeNull();
      expect(v!.coversItsOwnSpread).toBeNull();
    });

    it('only ever passes a sleeve that genuinely clears its bar', () => {
      // Positive control: without this, every assertion above is satisfied by a
      // function that hardcodes `coversItsOwnSpread: false`.
      const pass = buildRecoveryVerdicts(
        summarizeShadowRecovery([
          ev({ structure: 'single_leg_otm', side: 'open', recoveryPct: 0.9 }),
        ]),
      ).find((v) => v.structure === 'single_leg_otm');
      expect(pass!.state).toBe('graded');
      expect(pass!.coversItsOwnSpread).toBe(true);

      const fail = buildRecoveryVerdicts(
        summarizeShadowRecovery([
          ev({ structure: 'single_leg_otm', side: 'open', recoveryPct: 0.7 }),
        ]),
      ).find((v) => v.structure === 'single_leg_otm');
      expect(fail!.coversItsOwnSpread).toBe(false);
    });

    it('ignores close-side rows — the breakeven bars are open-side cross', () => {
      const verdicts = buildRecoveryVerdicts(
        summarizeShadowRecovery([ev({ structure: 'directional', side: 'close' })]),
      );
      expect(verdicts.find((v) => v.structure === 'directional')!.state).toBe('no_measurement');
    });
  });
});
