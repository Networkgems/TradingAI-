// TRA-4779 — Setup Scoring & Confidence Calibration.
//
// Every control here discriminates: for each fail-closed rule there is a test
// whose PASS depends on the rule and whose mutant (zero-fill a missing cost,
// mean-shift instead of per-row charge, decide wins on gross, split OOS by
// input order, show confidence below the floor) fails it. A green suite where
// pass and fail read identically is the recurring bug this repo documents —
// the assertions below are chosen so the known mutants read RED.

import { describe, it, expect } from 'vitest';
import {
  calibrateSetups,
  confidenceFor,
  rankSetups,
  wilson95,
  DEFAULT_SETUP_CALIBRATION_CONFIG,
  type SetupOutcomeRecord,
} from './setup-calibration.js';
import { buildTradeOpportunityCard, CALIBRATION_NOT_RUN_REASON } from './trade-opportunity-card.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

const T0 = Date.parse('2026-06-01T14:00:00Z');
const STEP = 60_000;

function rec(i: number, overrides: Partial<SetupOutcomeRecord> = {}): SetupOutcomeRecord {
  return {
    setupKey: 'orb_breakout',
    closedAt: T0 + i * STEP,
    grossR: 1.1,
    costR: 0.1,
    costSource: 'sampled',
    predictedRR: null,
    predictedWinProb: null,
    regime: null,
    ...overrides,
  };
}

/** Win ⇒ net +1.0, loss ⇒ net −1.0, both with a real 0.1R charge. */
function outcome(i: number, win: boolean, overrides: Partial<SetupOutcomeRecord> = {}): SetupOutcomeRecord {
  return rec(i, { grossR: win ? 1.1 : -0.9, ...overrides });
}

/** n rows with a stationary win-loss pattern (period 3: w, w, l → rate 2/3). */
function stablePattern(n: number, overrides: Partial<SetupOutcomeRecord> = {}): SetupOutcomeRecord[] {
  return Array.from({ length: n }, (_, i) => outcome(i, i % 3 !== 2, overrides));
}

describe('the ≥30-instance acceptance floor', () => {
  it('29 admitted instances: not calibrated, in belowFloor, confidence null naming the floor', () => {
    const index = calibrateSetups(stablePattern(29));
    const setup = index.setups['orb_breakout']!;
    expect(setup.pooled.n).toBe(29);
    expect(setup.pooled.calibrated).toBe(false);
    expect(index.summary.belowFloor).toEqual({ orb_breakout: 29 });
    expect(index.summary.calibrated).toEqual([]);
    const { confidence, reasons } = confidenceFor(index, 'orb_breakout');
    expect(confidence).toBeNull();
    expect(reasons.join(' ')).toContain('instance floor');
  });

  it('30 stable instances: calibrated AND validated — confidence is real', () => {
    const index = calibrateSetups(stablePattern(30));
    const setup = index.setups['orb_breakout']!;
    expect(setup.pooled.calibrated).toBe(true);
    expect(setup.oos.attempted).toBe(true);
    expect(setup.oos.testN).toBe(9);
    expect(setup.oos.validated).toBe(true);
    expect(index.summary.calibrated).toEqual(['orb_breakout']);
    expect(index.summary.validated).toEqual(['orb_breakout']);
    expect(confidenceFor(index, 'orb_breakout').confidence).not.toBeNull();
  });
});

describe('costs are charged per row, inside the fold (TRA-4578)', () => {
  it('a cost charged to a SUBSET of rows moves the SE, not just the mean', () => {
    // Same gross everywhere; the charge lands on alternating rows.
    const subsetCharged = calibrateSetups(
      Array.from({ length: 30 }, (_, i) => rec(i, { grossR: 1.0, costR: i % 2 === 0 ? 1.0 : 0 })),
    ).setups['orb_breakout']!.pooled;
    // Control: the SAME total charge applied uniformly (the mean-shift mutant).
    const uniformCharged = calibrateSetups(
      Array.from({ length: 30 }, (_, i) => rec(i, { grossR: 1.0, costR: 0.5 })),
    ).setups['orb_breakout']!.pooled;

    // Identical means…
    expect(subsetCharged.meanNetR).toBeCloseTo(0.5, 10);
    expect(uniformCharged.meanNetR).toBeCloseTo(0.5, 10);
    // …but the subset charge carries dispersion the mean-shift erases.
    expect(uniformCharged.sdNetR).toBeCloseTo(0, 10);
    expect(subsetCharged.sdNetR!).toBeGreaterThan(0.4);
    expect(subsetCharged.lowerCI95NetR!).toBeLessThan(uniformCharged.lowerCI95NetR! - 0.1);
  });

  it('a row without a costSource is EXCLUDED and counted — never charged zero', () => {
    const charged = stablePattern(30);
    const uncharged = Array.from({ length: 5 }, (_, i) =>
      rec(100 + i, { grossR: 100, costR: null, costSource: null }),
    );
    const index = calibrateSetups([...charged, ...uncharged]);
    const setup = index.setups['orb_breakout']!;
    // The 100-gross rows did NOT enter any statistic…
    expect(setup.pooled.n).toBe(30);
    expect(setup.pooled.meanGrossR!).toBeLessThan(2);
    // …and their exclusion is loud, not silent.
    expect(setup.excluded.unchargedCost).toBe(5);
    expect(index.summary.excludedTotals.unchargedCost).toBe(5);
    expect(index.summary.recordsSeen).toBe(35);
    expect(index.summary.recordsAdmitted).toBe(30);
  });

  it('non-finite grossR / costR / closedAt each increment their own counter', () => {
    const index = calibrateSetups([
      rec(0, { grossR: null }),
      rec(1, { costR: Number.NaN }),
      rec(2, { closedAt: Number.NaN }),
      rec(3),
    ]);
    const setup = index.setups['orb_breakout']!;
    expect(setup.excluded).toEqual({
      nonFiniteGrossR: 1,
      nonFiniteCostR: 1,
      unchargedCost: 0,
      nonFiniteClosedAt: 1,
    });
    expect(setup.pooled.n).toBe(1);
  });

  it('a win is decided on NET R: a gross winner eaten by costs is a loss', () => {
    const index = calibrateSetups([rec(0, { grossR: 0.3, costR: 0.4 })]);
    const cell = index.setups['orb_breakout']!.pooled;
    expect(cell.meanGrossR).toBeCloseTo(0.3, 10);
    expect(cell.meanNetR).toBeCloseTo(-0.1, 10);
    expect(cell.wins).toBe(0); // the gross-win mutant reads 1 here
  });
});

describe('interval arithmetic', () => {
  it('Wilson 95% at 15/30 matches the known value', () => {
    const ci = wilson95(15, 30)!;
    expect(ci[0]).toBeCloseTo(0.3315, 3);
    expect(ci[1]).toBeCloseTo(0.6685, 3);
  });

  it('degenerate inputs return null, not a fabricated interval', () => {
    expect(wilson95(0, 0)).toBeNull();
    expect(wilson95(5, 3)).toBeNull();
  });
});

describe('out-of-sample validation is chronological', () => {
  it('a regime change hidden by input shuffling is still caught: split is by closedAt', () => {
    // First 28 (by TIME) all win, last 12 all lose — then shuffle the array.
    const rows = Array.from({ length: 40 }, (_, i) => outcome(i, i < 28));
    const shuffled = [...rows].sort((a, b) => (a.closedAt % 7) - (b.closedAt % 7));
    const index = calibrateSetups(shuffled);
    const setup = index.setups['orb_breakout']!;
    expect(setup.pooled.calibrated).toBe(true); // floor cleared…
    expect(setup.oos.trainWinRate).toBeCloseTo(1.0, 10);
    expect(setup.oos.testWinRate).toBeCloseTo(0.0, 10);
    expect(setup.oos.winRateStable).toBe(false);
    expect(setup.oos.validated).toBe(false); // …but the held-out tail collapsed
    const { confidence, reasons } = confidenceFor(index, 'orb_breakout');
    expect(confidence).toBeNull();
    expect(reasons.join(' ')).toContain('outside train Wilson');
  });

  it('a stated 95% on a 2/3 setup fails the OOS honesty band; a stated 65% passes', () => {
    const dishonest = calibrateSetups(stablePattern(45, { predictedWinProb: 0.95 }));
    const d = dishonest.setups['orb_breakout']!;
    expect(d.oos.oosCalibrationGap!).toBeGreaterThan(0.25);
    expect(d.oos.oosCalibrationGapOk).toBe(false);
    expect(d.oos.validated).toBe(false);
    expect(confidenceFor(dishonest, 'orb_breakout').confidence).toBeNull();

    const honest = calibrateSetups(stablePattern(45, { predictedWinProb: 0.65 }));
    const h = honest.setups['orb_breakout']!;
    expect(h.oos.oosCalibrationGapOk).toBe(true);
    expect(h.oos.validated).toBe(true);
    expect(confidenceFor(honest, 'orb_breakout').confidence).not.toBeNull();
  });

  it('records with no stated probability skip the gap check without failing it', () => {
    const setup = calibrateSetups(stablePattern(45)).setups['orb_breakout']!;
    expect(setup.oos.oosCalibrationGap).toBeNull();
    expect(setup.oos.oosCalibrationGapOk).toBeNull();
    expect(setup.oos.validated).toBe(true);
  });
});

describe('the displayed confidence is conservative and measured', () => {
  it('displayWinRatePct is the Wilson LOWER bound, strictly below the point estimate', () => {
    const index = calibrateSetups(stablePattern(45));
    const { confidence } = confidenceFor(index, 'orb_breakout');
    expect(confidence).not.toBeNull();
    expect(confidence!.winRate).toBeCloseTo(2 / 3, 2);
    expect(confidence!.displayWinRatePct).toBe(Math.round(confidence!.winRateCI95[0] * 100));
    expect(confidence!.displayWinRatePct).toBeLessThan(Math.round(confidence!.winRate * 100));
    expect(confidence!.validated).toBe(true);
    expect(confidence!.expectancyNetR).toBeGreaterThan(0);
    expect(confidence!.lowerCI95NetR).toBeLessThan(confidence!.expectancyNetR);
  });
});

describe('market regime conditioning', () => {
  /** 40 'trend' rows at 3/4 win, 40 'chop' rows at 1/4, interleaved in time. */
  function regimeRecords(): SetupOutcomeRecord[] {
    const rows: SetupOutcomeRecord[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(outcome(2 * i, i % 4 !== 3, { regime: 'trend' }));
      rows.push(outcome(2 * i + 1, i % 4 === 0, { regime: 'chop' }));
    }
    return rows;
  }

  it('a calibrated+validated regime cell wins over pooled, and is stamped', () => {
    const index = calibrateSetups(regimeRecords());
    const trend = confidenceFor(index, 'orb_breakout', 'trend').confidence!;
    expect(trend.basis).toBe('regime');
    expect(trend.regime).toBe('trend');
    expect(trend.n).toBe(40);
    expect(trend.winRate).toBeCloseTo(0.75, 10);
    const chop = confidenceFor(index, 'orb_breakout', 'chop').confidence!;
    expect(chop.winRate).toBeCloseTo(0.25, 10);
    // Same setup, no regime: the pooled number, stamped pooled.
    const pooled = confidenceFor(index, 'orb_breakout', null).confidence!;
    expect(pooled.basis).toBe('pooled');
    expect(pooled.winRate).toBeCloseTo(0.5, 10);
  });

  it('an unknown or under-floor regime falls back to pooled with the reason named', () => {
    const withThin = [
      ...regimeRecords(),
      ...Array.from({ length: 6 }, (_, i) => outcome(200 + i, i % 2 === 0, { regime: 'squeeze' })),
    ];
    const index = calibrateSetups(withThin);
    const unknown = confidenceFor(index, 'orb_breakout', 'never_seen');
    expect(unknown.confidence!.basis).toBe('pooled');
    expect(unknown.reasons.join(' ')).toContain("no instances in regime 'never_seen'");
    const thin = confidenceFor(index, 'orb_breakout', 'squeeze');
    expect(thin.confidence!.basis).toBe('pooled');
    expect(thin.reasons.join(' ')).toContain('squeeze');
  });
});

describe('ranking is by net expectancy lower bound, floor-gated', () => {
  it('uncalibrated setups rank below every calibrated one no matter how shiny the mean', () => {
    const records = [
      ...Array.from({ length: 30 }, (_, i) => rec(i, { setupKey: 'steady', grossR: 0.3 })), // net 0.2
      ...Array.from({ length: 30 }, (_, i) => rec(i, { setupKey: 'better', grossR: 0.6 })), // net 0.5
      ...Array.from({ length: 5 }, (_, i) => rec(i, { setupKey: 'lottery', grossR: 5.1 })), // net 5, n=5
    ];
    const ranked = rankSetups(calibrateSetups(records));
    expect(ranked.map((r) => r.setupKey)).toEqual(['better', 'steady', 'lottery']);
    expect(ranked[0]!.score).toBeCloseTo(0.5, 10);
    expect(ranked[2]!.score).toBeNull();
    expect(ranked[2]!.calibrated).toBe(false);
    expect(ranked[2]!.meanNetR).toBeCloseTo(5.0, 10); // the shiny mean is visible, just not rank
  });
});

describe('realized R/R vs predicted', () => {
  it('per-row realized/predicted ratio, formed only where predicted RR is real', () => {
    const index = calibrateSetups(
      Array.from({ length: 30 }, (_, i) =>
        rec(i, { grossR: 1.1, costR: 0.1, predictedRR: i < 20 ? 2.0 : null }),
      ),
    );
    const cell = index.setups['orb_breakout']!.pooled;
    expect(cell.nPredictedRR).toBe(20);
    expect(cell.meanPredictedRR).toBeCloseTo(2.0, 10);
    expect(cell.nRealizedOverPredictedRR).toBe(20);
    expect(cell.meanRealizedOverPredictedRR).toBeCloseTo(0.5, 10); // realized 1.0 vs promised 2.0
  });
});

describe('empty and unknown inputs', () => {
  it('no records: empty index, zeroed summary, reasoned null lookup', () => {
    const index = calibrateSetups([]);
    expect(index.setups).toEqual({});
    expect(index.summary.setupCount).toBe(0);
    expect(index.summary.recordsSeen).toBe(0);
    const { confidence, reasons } = confidenceFor(index, 'anything');
    expect(confidence).toBeNull();
    expect(reasons.join(' ')).toContain('no historical instances');
  });
});

describe('card wiring — the reserved confidence slot (TRA-4649 → TRA-4779)', () => {
  const NOW = Date.parse('2026-09-17T15:00:00Z');
  function otmSignal(): OtmMispricingSignal {
    return {
      id: 'sig-otm-1',
      symbol: 'SPY',
      type: 'otm_mispricing',
      side: 'buy',
      entryPrice: 0.5,
      stopLoss: 0.3,
      takeProfit: 1.0,
      riskRewardRatio: 2.5,
      timestamp: NOW - 5 * 60_000,
      mode: 'demo',
      optionSymbol: 'SPY261023C00700000',
      optionType: 'call',
      strike: 700,
      expiration: new Date(NOW + 35 * 86_400_000).toISOString().slice(0, 10),
      mark: 0.5,
      theo: 0.65,
      mispricingPct: -0.2308,
      delta: 0.1,
      bid: 0.48,
      ask: 0.52,
    };
  }
  const ctxBase = {
    now: NOW,
    sizing: { managedEquity: 50_000, riskPerTrade: 0.01 },
    optionLiquidity: { openInterest: 500, volume: 120, marketPhase: 'rth' as const },
  };

  it('no calibration in the context ⇒ confidence null (pre-TRA-4779 behavior unchanged)', () => {
    expect(buildTradeOpportunityCard(otmSignal(), ctxBase).confidence).toBeNull();
  });

  it('a validated cell for the signal type populates the slot; an under-floor one does not', () => {
    const validated = calibrateSetups(stablePattern(45, { setupKey: 'otm_mispricing' }));
    const card = buildTradeOpportunityCard(otmSignal(), { ...ctxBase, calibration: validated });
    expect(card.confidence).not.toBeNull();
    expect(card.confidence!.setupKey).toBe('otm_mispricing');
    expect(card.confidence!.validated).toBe(true);

    const thin = calibrateSetups(stablePattern(10, { setupKey: 'otm_mispricing' }));
    expect(
      buildTradeOpportunityCard(otmSignal(), { ...ctxBase, calibration: thin }).confidence,
    ).toBeNull();
  });

  it('confidence rides the regime cell when the context states the current regime', () => {
    const rows: SetupOutcomeRecord[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(outcome(2 * i, i % 4 !== 3, { setupKey: 'otm_mispricing', regime: 'trend' }));
      rows.push(outcome(2 * i + 1, i % 4 === 0, { setupKey: 'otm_mispricing', regime: 'chop' }));
    }
    const index = calibrateSetups(rows);
    const card = buildTradeOpportunityCard(otmSignal(), {
      ...ctxBase,
      calibration: index,
      currentRegime: 'trend',
    });
    expect(card.confidence!.basis).toBe('regime');
    expect(card.confidence!.winRate).toBeCloseTo(0.75, 10);
  });

  // ── TRA-4788 — calibrationStatus: 'never ran' and 'floor not cleared' are
  // different facts and must never collapse into the same bare null. On the
  // live build (no index has ever been constructed) the truthful value is
  // 'not_run'; a build that read 'below_floor' there would be asserting a
  // measurement that never happened.

  it("TRA-4788 — absent index ⇒ 'not_run' with the fixed non-empty reason: no rows folded, no floor tested", () => {
    const card = buildTradeOpportunityCard(otmSignal(), ctxBase);
    expect(card.confidence).toBeNull();
    expect(card.calibrationStatus).toBe('not_run');
    expect(card.calibrationReasons).toEqual([CALIBRATION_NOT_RUN_REASON]);
  });

  it("TRA-4788 — present-but-short index ⇒ 'below_floor'; confidence stays null, never 0 or a prior", () => {
    const thin = calibrateSetups(stablePattern(10, { setupKey: 'otm_mispricing' }));
    const card = buildTradeOpportunityCard(otmSignal(), { ...ctxBase, calibration: thin });
    expect(card.confidence).toBeNull();
    expect(card.calibrationStatus).toBe('below_floor');
    expect(card.calibrationReasons!.join(' ')).toContain('instance floor');
  });

  it("TRA-4788 — an index with no rows for THIS setup ⇒ 'no_instances'", () => {
    const otherSetupOnly = calibrateSetups(stablePattern(45)); // orb_breakout rows only
    const card = buildTradeOpportunityCard(otmSignal(), { ...ctxBase, calibration: otherSetupOnly });
    expect(card.confidence).toBeNull();
    expect(card.calibrationStatus).toBe('no_instances');
    expect(card.calibrationReasons!.join(' ')).toContain('no historical instances');
  });

  it("TRA-4788 — floor cleared but the held-out tail collapsed ⇒ 'oos_failed', not 'below_floor'", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      outcome(i, i < 28, { setupKey: 'otm_mispricing' }),
    );
    const card = buildTradeOpportunityCard(otmSignal(), {
      ...ctxBase,
      calibration: calibrateSetups(rows),
    });
    expect(card.confidence).toBeNull();
    expect(card.calibrationStatus).toBe('oos_failed');
  });

  it("TRA-4788 — a validated cell ⇒ 'calibrated' with the verdict attached", () => {
    const validated = calibrateSetups(stablePattern(45, { setupKey: 'otm_mispricing' }));
    const card = buildTradeOpportunityCard(otmSignal(), { ...ctxBase, calibration: validated });
    expect(card.calibrationStatus).toBe('calibrated');
    expect(card.confidence).not.toBeNull();
  });
});

describe('config surface', () => {
  it('the shipped floor is the acceptance floor: 30', () => {
    expect(DEFAULT_SETUP_CALIBRATION_CONFIG.minInstances).toBe(30);
  });
});
