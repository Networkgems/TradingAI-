// TRA-3945 — the pre-registered OTM joint-arm evaluation window.
//
// AC2: 17 synthetic closes incl. a double-listed pair produce n=16, not 17.
// AC3: avgR/seR consume the journal's `realizedR` (TRA-375 basis) with sample
//      sd (n−1) — pinned against a hand computation.
// AC4: `startedAt` is stamped only when the liveness predicate reads all-true
//      (all five wire clauses), pinned to the build that read it, never
//      re-stamped; a later false clause PAUSES and refuses entries in the span.
import { describe, expect, it } from 'vitest';
import {
  OTM_EVALUATION_TARGET_CLOSES,
  applyOtmEvaluationVerdict,
  buildOtmEvaluationWindowRecord,
  emptyOtmEvaluationWindowState,
  evaluateOtmEvaluationLiveness,
  foldOtmEvaluationWindow,
  otmEvaluationStats,
  otmEvaluationWindowStatus,
  resolveOtmEvaluationPopulationCell,
  stepOtmEvaluationWindow,
  type OtmEvaluationBuildPin,
  type OtmEvaluationLivenessInputs,
} from './otm-evaluation-window.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

const T0 = Date.UTC(2026, 7, 24, 13, 30); // 2026-08-24T13:30Z
const H = 3_600_000;

type Row = OptionTradeJournalRecord & { brokerOrderId?: string | number | null };

function close(i: number, over: Partial<Row> = {}): Row {
  const r = (i % 3 === 0 ? -0.4 : 0.3) + i * 0.01;
  const atRiskUsd = 250;
  return {
    id: `row-${i}`,
    openTs: T0 + i * H,
    closeTs: T0 + i * H + 2 * H,
    symbol: 'XLF',
    optionSymbol: `XLF261016C0004${(50 + i).toString().padStart(4, '0')}`,
    structure: 'single_leg_otm',
    mode: 'live',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.52,
    entryDte: 30,
    atRiskUsd,
    outcome: r > 0 ? 'WIN' : 'LOSS',
    realizedPnlUsd: r * atRiskUsd,
    realizedR: r,
    exitReason: i % 2 === 0 ? 'trail' : 'otm_day_one_premium_stop',
    holdDays: 0.1,
    brokerOrderId: 1000 + i,
    ...over,
  };
}

const PIN: OtmEvaluationBuildPin = {
  commit: '3b241a61a35719aba289292ddf94d5028c5191f6', commitShort: '3b241a61a357', pid: 73, startedAt: '2026-08-22T20:38:53.636Z',
};

const ALL_TRUE: OtmEvaluationLivenessInputs = {
  liveOtmArmed: true,
  liveOtmRouting: true,
  otmSleeveExitRule: { rule: 'trail', chandelierRetired: true },
  otmEntryWindows: { refusalDedupe: { windowRefusalExpiresAtNextOpen: true } },
  liveDayOneStopPosture: { otmDayOneStop: { armed: true, release: { released: true } } },
  otmContractFloor: { invalidKeys: [], bandIntersectsSelector: true, deltaBand: [0.50, 0.55], selectorBand: [0.50, 0.55] },
};

function opened(records: Row[] = []) {
  const s0 = emptyOtmEvaluationWindowState();
  const liveness = evaluateOtmEvaluationLiveness(ALL_TRUE);
  return stepOtmEvaluationWindow(s0, liveness, PIN, records, T0 - H, ALL_TRUE.otmContractFloor).state;
}

describe('TRA-3945 liveness predicate (AC4 — the wire names QuantTrader corrected)', () => {
  it('reads all-true only when every clause is === true', () => {
    expect(evaluateOtmEvaluationLiveness(ALL_TRUE).allTrue).toBe(true);
  });

  it('bqb1 3b241a61 as read 2026-08-22T21:5xZ: bandIntersectsSelector=false ⇒ NOT all-true, record stays armed', () => {
    const l = evaluateOtmEvaluationLiveness({
      ...ALL_TRUE,
      otmContractFloor: { invalidKeys: [], bandIntersectsSelector: false },
    });
    expect(l.allTrue).toBe(false);
    expect(l.falseClauses).toEqual(['contractFloor']);
    const s = stepOtmEvaluationWindow(emptyOtmEvaluationWindowState(), l, PIN, [], T0).state;
    expect(s.startedAt).toBeNull();
    expect(otmEvaluationWindowStatus(s)).toBe('armed');
  });

  it('an armed-but-parked sleeve (liveOtmRouting=false) does not open the window', () => {
    const l = evaluateOtmEvaluationLiveness({ ...ALL_TRUE, liveOtmRouting: false });
    expect(l.routing).toBe(false);
    expect(l.allTrue).toBe(false);
  });

  it('an absent / null rule object reads FALSE, never unknown-so-fine', () => {
    expect(evaluateOtmEvaluationLiveness({ ...ALL_TRUE, otmSleeveExitRule: null }).trailExit).toBe(false);
    expect(evaluateOtmEvaluationLiveness({ ...ALL_TRUE, liveDayOneStopPosture: { otmDayOneStop: null } }).dayOneStop).toBe(false);
    expect(evaluateOtmEvaluationLiveness({ ...ALL_TRUE, otmContractFloor: null }).contractFloor).toBe(false);
    expect(evaluateOtmEvaluationLiveness({ ...ALL_TRUE, otmEntryWindows: {} }).entryWindow).toBe(false);
    expect(evaluateOtmEvaluationLiveness({ ...ALL_TRUE, otmContractFloor: { invalidKeys: ['OTM_FLOOR_X'], bandIntersectsSelector: true } }).contractFloor).toBe(false);
  });

  it('dayOneStop needs BOTH armed and release.released', () => {
    const l = evaluateOtmEvaluationLiveness({
      ...ALL_TRUE,
      liveDayOneStopPosture: { otmDayOneStop: { armed: true, release: { released: false } } },
    });
    expect(l.dayOneStop).toBe(false);
  });
});

describe('TRA-3945 AC4 — the stamp', () => {
  it('stamps startedAt + startBuild at the first all-true tick and freezes the baseline', () => {
    const pre = [close(-5, { brokerOrderId: 1 }), close(-4, { brokerOrderId: 2 }), close(-3, { brokerOrderId: 2 })]; // last two = double-listed
    const s = opened(pre);
    expect(s.startedAt).toBe(T0 - H);
    expect(s.startBuild).toEqual(PIN);
    expect(s.baseline?.frozen).toBe(true);
    expect(s.baseline?.n).toBe(2);
    expect(otmEvaluationWindowStatus(s)).toBe('counting');
  });

  it('never re-stamps: a later tick on a different build keeps the original pin', () => {
    const s1 = opened();
    const pin2 = { ...PIN, commit: 'deadbeef'.repeat(5), pid: 74 };
    const s2 = stepOtmEvaluationWindow(s1, evaluateOtmEvaluationLiveness(ALL_TRUE), pin2, [], T0 + H).state;
    expect(s2.startedAt).toBe(s1.startedAt);
    expect(s2.startBuild).toEqual(PIN);
    expect(s2.lastTickBuild).toEqual(pin2);
  });

  it('while armed the baseline is a live PREVIEW (frozen:false) with numbers, not a placeholder', () => {
    const l = evaluateOtmEvaluationLiveness({ ...ALL_TRUE, otmContractFloor: { invalidKeys: [], bandIntersectsSelector: false } });
    const s = stepOtmEvaluationWindow(emptyOtmEvaluationWindowState(), l, PIN, [close(-2), close(-1)], T0, ALL_TRUE.otmContractFloor).state;
    expect(s.baseline).toMatchObject({ frozen: false, n: 2 });
    expect(typeof s.baseline?.avgR).toBe('number');
    expect(typeof s.baseline?.seR).toBe('number');
  });

  it('a clause flipping false on a later tick PAUSES; entries inside the span are refused as rulesetPaused', () => {
    const s1 = opened();
    const off = evaluateOtmEvaluationLiveness({ ...ALL_TRUE, otmSleeveExitRule: { rule: 'chandelier', chandelierRetired: false } });
    const s2 = stepOtmEvaluationWindow(s1, off, PIN, [], T0).state;
    expect(otmEvaluationWindowStatus(s2)).toBe('paused');
    expect(s2.buildDrift).toHaveLength(1);
    expect(s2.buildDrift[0]).toMatchObject({ from: T0, to: null, falseClauses: ['trailExit'] });
    const s3 = stepOtmEvaluationWindow(s2, evaluateOtmEvaluationLiveness(ALL_TRUE), PIN, [], T0 + 3 * H).state;
    expect(otmEvaluationWindowStatus(s3)).toBe('counting');
    expect(s3.buildDrift[0]?.to).toBe(T0 + 3 * H);
    expect(s3.startedAt).toBe(s1.startedAt);
    // entry at T0+1h (inside the span) is refused; entry at T0+4h counts
    const rows = [close(1), close(4)];
    const r = foldOtmEvaluationWindow(rows, s3, T0 + 10 * H);
    expect(r.n).toBe(1);
    expect(r.excludedCloses.reasons.rulesetPaused).toBe(1);
  });
});

describe('TRA-3945 AC2 — dedupe', () => {
  it('17 synthetic closes incl. a double-listed pair produce n=16, not 17', () => {
    const s = opened();
    const rows: Row[] = [];
    for (let i = 1; i <= 16; i++) rows.push(close(i));
    // the 17th is the SAME fill as row 7, listed under a second strategy label
    rows.push(close(7, { id: 'row-7-import', structure: 'tradier_import', brokerOrderId: 1007 }));
    expect(rows).toHaveLength(17);
    const r = foldOtmEvaluationWindow(rows, s, T0 + 100 * H);
    expect(r.n).toBe(16);
    expect(r.excludedCloses.reasons.dedupeDuplicate).toBe(1);
    expect(r.excludedCloses.n).toBe(1);
  });

  it('falls back to optionSymbol|closeTs when brokerOrderId is null, and the fallback is COUNTED but VISIBLE', () => {
    const s = opened();
    const a = close(1, { brokerOrderId: null });
    const dup = close(1, { id: 'row-1-import', structure: 'tradier_import', brokerOrderId: null });
    const r = foldOtmEvaluationWindow([a, dup, close(2)], s, T0 + 100 * H);
    expect(r.n).toBe(2);
    expect(r.excludedCloses.reasons.dedupeDuplicate).toBe(1);
    expect(r.excludedCloses.reasons.brokerOrderIdNull).toBe(1);
    expect(r.excludedCloses.brokerOrderIdNullCounted).toBe(true);
    expect(r.excludedCloses.n).toBe(1); // the visibility counter is not an exclusion
  });

  it('entry-side eligibility: a close whose entry predates startedAt is refused however it exits', () => {
    const s = opened();
    const r = foldOtmEvaluationWindow([close(-2, { closeTs: T0 + 5 * H }), close(1)], s, T0 + 100 * H);
    expect(r.n).toBe(1);
    expect(r.excludedCloses.reasons.entryPredatesStart).toBe(1);
  });

  it('demo rows and non-OTM live rows are refused under their own reasons', () => {
    const s = opened();
    const r = foldOtmEvaluationWindow(
      [close(1, { mode: 'demo' }), close(2, { structure: 'single_leg_rv' }), close(3)],
      s, T0 + 100 * H,
    );
    expect(r.n).toBe(1);
    expect(r.excludedCloses.reasons.notLive).toBe(1);
    expect(r.excludedCloses.reasons.notOtm).toBe(1);
  });

  it('before the stamp nothing counts (n=0) and the thresholds are already on the wire (AC1)', () => {
    const l = evaluateOtmEvaluationLiveness({ ...ALL_TRUE, otmContractFloor: { invalidKeys: [], bandIntersectsSelector: false } });
    const s = stepOtmEvaluationWindow(emptyOtmEvaluationWindowState(), l, PIN, [close(1)], T0).state;
    const readout = foldOtmEvaluationWindow([close(1)], s, T0 + 100 * H);
    const rec = buildOtmEvaluationWindowRecord(s, l, false, readout);
    expect(rec.status).toBe('armed');
    expect(rec.n).toBe(0);
    expect(rec.startedAt).toBeNull();
    expect(rec.nominationBandIntersects).toBe(false);
    expect(rec.targetCloses).toBe(30);
    expect(rec.thresholds).toMatchObject({ seRMax: 0.1, passIf: 'avgR > 0 && seR < 0.10', failIf: 'avgR <= 0 && seR < 0.10', terminalAt: 45 });
    expect(rec.verdictOwner).toBe('QuantTrader');
    expect(rec.ruleRef).toBe('TRA-375');
  });
});

describe('TRA-3945 AC3 — R basis and seR', () => {
  it('consumes realizedR (= realizedPnlUsd / atRiskUsd) and uses sample sd (n−1)', () => {
    const rs = [0.5, -0.25, 1.0, -0.5].map((realizedR) => ({ realizedR, realizedPnlUsd: realizedR * 250 }));
    const s = otmEvaluationStats(rs);
    const mean = 0.1875;
    const ss = rs.reduce((a, r) => a + (r.realizedR - mean) ** 2, 0);
    const seHand = Math.sqrt(ss / 3) / Math.sqrt(4);
    expect(s.n).toBe(4);
    expect(s.avgR).toBeCloseTo(mean, 5);
    expect(s.seR).toBeCloseTo(seHand, 5); // published at 6 dp
    expect(s.winRate).toBe(0.5);
    expect(s.netUsd).toBeCloseTo(187.5, 6);
  });

  it('the fold never recomputes R from a different basis: realizedR on the row is what it averages', () => {
    const s = opened();
    const rows = [close(1, { realizedR: 2, realizedPnlUsd: 10 }), close(2, { realizedR: -1, realizedPnlUsd: 500 })];
    const r = foldOtmEvaluationWindow(rows, s, T0 + 100 * H);
    expect(r.avgR).toBe(0.5);
    expect(r.netUsd).toBe(510);
  });

  it('seR is null below n=2 rather than 0', () => {
    expect(otmEvaluationStats([{ realizedR: 0.3, realizedPnlUsd: 75 }]).seR).toBeNull();
  });
});

describe('TRA-3945 extension + verdict', () => {
  function noisy(n: number): Row[] {
    // alternating ±1R ⇒ sd 1 ⇒ seR = 1/√n ≥ 0.1 for n ≤ 100 — never conclusive
    return Array.from({ length: n }, (_, i) => close(i + 1, { realizedR: i % 2 ? 1 : -1, realizedPnlUsd: i % 2 ? 250 : -250 }));
  }
  function tight(n: number): Row[] {
    // all +0.2R ⇒ sd 0 ⇒ seR 0 < 0.1, avgR > 0 ⇒ pass criteria
    return Array.from({ length: n }, (_, i) => close(i + 1, { realizedR: 0.2, realizedPnlUsd: 50 }));
  }

  it('at 30 inconclusive closes the extension fires ONCE; at 45 it goes inconclusive_terminal', () => {
    let s = opened();
    const L = evaluateOtmEvaluationLiveness(ALL_TRUE);
    s = stepOtmEvaluationWindow(s, L, PIN, noisy(30), T0 + 100 * H).state;
    expect(s.extension.used).toBe(true);
    expect(otmEvaluationWindowStatus(s)).toBe('extended');
    expect(foldOtmEvaluationWindow(noisy(30), s, T0 + 100 * H).closesRemaining).toBe(15);
    s = stepOtmEvaluationWindow(s, L, PIN, noisy(45), T0 + 200 * H).state;
    expect(otmEvaluationWindowStatus(s)).toBe('inconclusive_terminal');
    expect(s.terminalAt).toBe(T0 + 200 * H);
    // no second extension, ever
    const again = stepOtmEvaluationWindow(s, L, PIN, noisy(60), T0 + 300 * H).state;
    expect(again.extension.usedAt).toBe(s.extension.usedAt);
    expect(otmEvaluationWindowStatus(again)).toBe('inconclusive_terminal');
  });

  it('pass criteria met publishes `criteria`, NOT a verdict status — the code never pronounces', () => {
    let s = opened();
    s = stepOtmEvaluationWindow(s, evaluateOtmEvaluationLiveness(ALL_TRUE), PIN, tight(OTM_EVALUATION_TARGET_CLOSES), T0 + 100 * H).state;
    const r = foldOtmEvaluationWindow(tight(30), s, T0 + 100 * H);
    expect(r.criteria).toBe('pass_criteria_met');
    expect(otmEvaluationWindowStatus(s)).toBe('counting');
  });

  it('a verdict is a hand-run carrying a ticket reference, and refuses one without', () => {
    const s = opened();
    expect(() => applyOtmEvaluationVerdict(s, { status: 'verdict_fail', note: 'dropped it', by: 'QuantTrader' }, T0)).toThrow(/TRA-nnnn/);
    const v = applyOtmEvaluationVerdict(s, { status: 'verdict_fail', note: 'TRA-3945 verdict: avgR<=0, seR<0.1', by: 'QuantTrader' }, T0);
    expect(otmEvaluationWindowStatus(v)).toBe('verdict_fail');
    // a verdict freezes the state machine
    const after = stepOtmEvaluationWindow(v, evaluateOtmEvaluationLiveness({ ...ALL_TRUE, liveOtmRouting: false }), PIN, [], T0 + H);
    expect(after.changed).toBe(false);
    expect(otmEvaluationWindowStatus(after.state)).toBe('verdict_fail');
    expect(() => applyOtmEvaluationVerdict(emptyOtmEvaluationWindowState(), { status: 'verdict_pass', note: 'TRA-3945', by: 'QuantTrader' }, T0)).toThrow(/never opened/);
  });
});

describe('TRA-3945 population cell (QuantTrader scope note 88ccac56 — ONE delta cell, never pooled)', () => {
  const LIVE_BQB1_0822: OtmEvaluationLivenessInputs['otmContractFloor'] = {
    invalidKeys: [], bandIntersectsSelector: false, deltaBand: [0.25, 0.40], selectorBand: [0.50, 0.55],
  };

  it('bqb1 e78b11c5 today: floor [0.25,0.40] ∩ selector [0.50,0.55) = ∅ ⇒ no cell, no stamp, record armed with populationCell null', () => {
    expect(resolveOtmEvaluationPopulationCell(LIVE_BQB1_0822)).toBeNull();
    const l = evaluateOtmEvaluationLiveness({ ...ALL_TRUE, otmContractFloor: LIVE_BQB1_0822 });
    const s = stepOtmEvaluationWindow(emptyOtmEvaluationWindowState(), l, PIN, [close(1)], T0, LIVE_BQB1_0822).state;
    expect(s.startedAt).toBeNull();
    expect(s.populationCell).toBeNull();
  });

  it('option B: cell [0.50,0.55) frozen at the stamp; 0.495 admitted by tolerance, 0.30 refused as outsideDeltaCell', () => {
    const s = opened();
    expect(s.populationCell).toMatchObject({ deltaAbsMin: 0.5, deltaAbsMax: 0.55, frozen: true, pooledCellsForbidden: true });
    const rows = [
      close(1, { entryDelta: 0.52 }),
      close(2, { entryDelta: -0.495 }),
      close(3, { entryDelta: 0.30 }),
      close(4, { entryDelta: 0.56 }),
      close(5, { entryDelta: Number.NaN }),
    ];
    const r = foldOtmEvaluationWindow(rows, s, T0 + 100 * H);
    expect(r.n).toBe(2);
    expect(r.excludedCloses.reasons.outsideDeltaCell).toBe(2);
    expect(r.excludedCloses.reasons.entryDeltaUnknown).toBe(1);
    expect(r.excludedCloses.n).toBe(3);
  });

  it('option A: cell [0.25,0.40]; a 0.52 entry is refused — the two cells are never pooled', () => {
    const floorA: OtmEvaluationLivenessInputs['otmContractFloor'] = {
      invalidKeys: [], bandIntersectsSelector: true, deltaBand: [0.25, 0.40], selectorBand: [0.25, 0.41],
    };
    const l = evaluateOtmEvaluationLiveness({ ...ALL_TRUE, otmContractFloor: floorA });
    const s = stepOtmEvaluationWindow(emptyOtmEvaluationWindowState(), l, PIN, [], T0 - H, floorA).state;
    expect(s.populationCell).toMatchObject({ deltaAbsMin: 0.25, deltaAbsMax: 0.4, frozen: true });
    const r = foldOtmEvaluationWindow([close(1, { entryDelta: 0.52 }), close(2, { entryDelta: 0.33 })], s, T0 + 100 * H);
    expect(r.n).toBe(1);
    expect(r.excludedCloses.reasons.outsideDeltaCell).toBe(1);
  });

  it('the cell is a preview while armed and the invalidation thresholds are on the wire', () => {
    const floorPreview: OtmEvaluationLivenessInputs['otmContractFloor'] = {
      invalidKeys: [], bandIntersectsSelector: true, deltaBand: [0.50, 0.55], selectorBand: [0.50, 0.55],
    };
    const l = evaluateOtmEvaluationLiveness({ ...ALL_TRUE, liveOtmRouting: false, otmContractFloor: floorPreview });
    const s = stepOtmEvaluationWindow(emptyOtmEvaluationWindowState(), l, PIN, [], T0, floorPreview).state;
    expect(s.populationCell).toMatchObject({ frozen: false, frozenAt: null, deltaAbsMin: 0.5 });
    const rec = buildOtmEvaluationWindowRecord(s, l, true, foldOtmEvaluationWindow([], s, T0));
    expect(rec.thresholds.invalidation).toMatchObject({ barR: 0.485, tapeCellAdvertisedR: 1.47, lowerCi95: null });
    expect(rec.populationCell?.frozen).toBe(false);
  });
});
