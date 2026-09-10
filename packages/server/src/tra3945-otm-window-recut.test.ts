// TRA-3945 — the RE-CUT writer (a ruled restart of the pre-registered sample).
//
// QuantTrader ruled one on 2026-08-25 (comment `a9753fda`): TRA-4006 changed the
// profit-lock exit floor, so closes entered before it belong to a different
// population (TRA-2677), and "no close entered before that timestamp is
// admissible". The ruling was never executed — measured 2026-09-09, fifteen days
// later, because nothing could execute it: the tick stamps `startedAt` exactly
// once and never re-stamps, and the only other writer was a shell script on the
// host's data dir that the verdict owner (an agent) cannot reach.
//
// These cover the writer, the FORWARD-only safety argument that makes a mid-flight
// re-cut defensible, and the wire flag that makes an UNEXECUTED ruling visible.
import { describe, expect, it } from 'vitest';
import {
  OTM_EVALUATION_RULED_RECUTS,
  OTM_EVALUATION_SE_R_MAX,
  applyOtmEvaluationRecut,
  applyOtmEvaluationVerdict,
  buildOtmEvaluationWindowRecord,
  emptyOtmEvaluationWindowState,
  evaluateOtmEvaluationLiveness,
  foldOtmEvaluationWindow,
  otmEvaluationWindowStatus,
  previewOtmEvaluationRecut,
  stepOtmEvaluationWindow,
  tCritical95,
  unexecutedRuledRecuts,
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

const L = evaluateOtmEvaluationLiveness(ALL_TRUE);
const CUT = T0 + 5 * H; // drops closes 1..4 by ENTRY

describe('TRA-3945 re-cut — preview', () => {
  it('folds the candidate population WITHOUT touching the persisted cut', () => {
    const s = opened();
    const rows = Array.from({ length: 8 }, (_, i) => close(i + 1));
    expect(foldOtmEvaluationWindow(rows, s, T0 + 100 * H).n).toBe(8);
    const p = previewOtmEvaluationRecut(rows, s, CUT, T0 + 100 * H);
    expect(p.currentN).toBe(8);
    expect(p.n).toBe(4); // entries T0+5H .. T0+8H
    expect(p.droppedByRecut).toBe(4);
    expect(p.countedEntriesPredatingCandidate).toBe(4);
    expect(p.candidateStartedAt).toBe(new Date(CUT).toISOString());
    // A preview is a READ: the state and the fold are unchanged after it.
    expect(s.startedAt).toBe(T0 - H);
    expect(foldOtmEvaluationWindow(rows, s, T0 + 100 * H).n).toBe(8);
  });
});

describe('TRA-3945 re-cut — the writer', () => {
  it('is MONOTONE: a forward cut can only shrink n, so the bar can only get harder', () => {
    const s = opened();
    const rows = Array.from({ length: 8 }, (_, i) => close(i + 1));
    const before = foldOtmEvaluationWindow(rows, s, T0 + 100 * H);
    const next = applyOtmEvaluationRecut(s, { startedAt: CUT, by: 'QuantTrader', note: 'TRA-3945 re-cut at TRA-4006' }, T0 + 100 * H);
    const after = foldOtmEvaluationWindow(rows, next, T0 + 100 * H);
    expect(after.n).toBeLessThanOrEqual(before.n);
    expect(after.n).toBe(4);
    expect(next.startedAt).toBe(CUT);
    // The PRIOR cut survives, so every earlier filing stays reproducible.
    expect(next.recutHistory?.[0]).toMatchObject({ priorStartedAt: T0 - H, by: 'QuantTrader' });
    expect(next.recutHistory?.[0]?.priorStartBuild?.commit).toBe(PIN.commit);
  });

  it('refuses a backward cut, an equal cut, a future cut, a note with no ticket ref, a virgin window and a graded one', () => {
    const s = opened();
    expect(() => applyOtmEvaluationRecut(s, { startedAt: CUT, by: 'QT', note: 'restart it' }, T0 + 100 * H)).toThrow(/TRA-nnnn/);
    // Backward or equal would ADMIT rows the record already published as refused.
    expect(() => applyOtmEvaluationRecut(s, { startedAt: T0 - 2 * H, by: 'QT', note: 'TRA-3945' }, T0 + 100 * H)).toThrow(/FORWARD only/);
    expect(() => applyOtmEvaluationRecut(s, { startedAt: T0 - H, by: 'QT', note: 'TRA-3945' }, T0 + 100 * H)).toThrow(/FORWARD only/);
    expect(() => applyOtmEvaluationRecut(s, { startedAt: T0 + 200 * H, by: 'QT', note: 'TRA-3945' }, T0 + 100 * H)).toThrow(/future/);
    expect(() => applyOtmEvaluationRecut(emptyOtmEvaluationWindowState(), { startedAt: CUT, by: 'QT', note: 'TRA-3945' }, T0 + 100 * H)).toThrow(/never opened/);
    const graded = applyOtmEvaluationVerdict(s, { status: 'verdict_fail', note: 'TRA-3945 fail', by: 'QuantTrader', acknowledgeUnexecutedRecuts: true }, T0);
    expect(() => applyOtmEvaluationRecut(graded, { startedAt: CUT, by: 'QT', note: 'TRA-3945' }, T0 + 100 * H)).toThrow(/graded window/);
  });

  it('RESETS the extension and the terminal, and PRESERVES the frozen baseline and population cell', () => {
    let s = opened([close(-1, { openTs: T0 - 10 * H, closeTs: T0 - 9 * H })]);
    const noisy = Array.from({ length: 30 }, (_, i) => close(i + 1, { realizedR: i % 2 ? 1 : -1, realizedPnlUsd: i % 2 ? 250 : -250 }));
    s = stepOtmEvaluationWindow(s, L, PIN, noisy, T0 + 100 * H).state;
    expect(s.extension.used).toBe(true);
    const baseline = s.baseline;
    const cell = s.populationCell;
    const next = applyOtmEvaluationRecut(s, { startedAt: CUT, by: 'QuantTrader', note: 'TRA-3945 / TRA-4006 re-cut' }, T0 + 100 * H);
    expect(next.extension).toEqual({ allowed: 1, closes: 15, used: false, usedAt: null });
    expect(next.terminalAt).toBeNull();
    expect(next.baseline).toEqual(baseline);   // never recomputed (the ruling freezes it)
    expect(next.populationCell).toEqual(cell); // the ruling's cell, not a function of the cut
    expect(otmEvaluationWindowStatus(next)).toBe('counting');
  });
});

describe('TRA-3945 re-cut — the ruled-but-unexecuted TRA-4006 restart', () => {
  it('declares itself on the wire, and the SAME computed flag flips once executed', () => {
    expect(OTM_EVALUATION_RULED_RECUTS).toHaveLength(1);
    const ruling = OTM_EVALUATION_RULED_RECUTS[0]!;
    expect(ruling.candidateBuild.commit).toBe('85c788e5cdc91ef75345c943bbcdccb8e809db14');
    expect(ruling.candidateStartedAt).toBe(Date.parse('2026-08-26T04:33:57.910Z'));
    // The live shape read 2026-09-09: cut still 2026-08-23T01:40:43.225Z.
    const live = { ...opened(), startedAt: Date.parse('2026-08-23T01:40:43.225Z') };
    const now = Date.parse('2026-09-09T23:34:23.567Z');
    const rec = buildOtmEvaluationWindowRecord(live, L, true, foldOtmEvaluationWindow([], live, now));
    expect(rec.recut.ruled[0]?.satisfied).toBe(false);
    expect(rec.recut.ruled[0]?.preview).toBeNull(); // not computed by this caller => null, never omitted
    expect(rec.recut.history).toEqual([]);
    expect(rec.recut.monotone).toContain('FORWARD only');
    expect(rec.recut.writer).toContain('confirm=TRA-3945');
    // The one side effect a re-cut CANNOT carry, published rather than left to
    // a reader to spot: TRA-3974's accumulator pin is write-once.
    expect(rec.recut.costAccumulatorPinFollowsRecut).toBe(false);
    expect(rec.recut.costAccumulatorPin).toBeNull(); // no postPin handed in ⇒ null, never omitted
    expect(rec.recut.costAccumulatorPinNote).toContain('SUPERSET');
    const done = applyOtmEvaluationRecut(
      live,
      { startedAt: ruling.candidateStartedAt, build: ruling.candidateBuild, by: 'QuantTrader', note: 'TRA-3945 a9753fda / TRA-4006', priorN: 9 },
      now,
    );
    const rec2 = buildOtmEvaluationWindowRecord(done, L, true, foldOtmEvaluationWindow([], done, now));
    expect(rec2.recut.ruled[0]?.satisfied).toBe(true);
    expect(rec2.recut.currentCut).toBe('2026-08-26T04:33:57.910Z');
    expect(rec2.startBuild?.commit).toBe(ruling.candidateBuild.commit);
    expect(rec2.recut.history[0]).toMatchObject({
      priorStartedAt: '2026-08-23T01:40:43.225Z', priorN: 9, startedAt: '2026-08-26T04:33:57.910Z',
    });
  });

  it('the live population: 5 of the 9 counted closes entered BEFORE the ruled cut, and the blend FLATTERS the arm', () => {
    // The nine counted rows as read off /api/health/option-journal + /api/trades/export
    // on 2026-09-09 (one delta cell, all closed, the 08-24 NVTS cross-book pair
    // already collapsed by the cluster layer). The three v0nni scratches carry the
    // Rs implied by their published `profit_lock` bucket (SUM R +0.0384, net $0.00).
    const row = (openTs: number, sym: string, realizedR: number, atRiskUsd: number, closeTs: number, exitReason: string): Row =>
      close(1, {
        openTs, closeTs, symbol: sym, optionSymbol: `${sym}261002C00012500`, entryDelta: 0.52,
        atRiskUsd, realizedR, realizedPnlUsd: realizedR * atRiskUsd, exitReason,
        id: `${sym}-${openTs}`, brokerOrderId: `${sym}-${openTs}`,
      });
    const cut = Date.parse('2026-08-26T04:33:57.910Z');
    const live = { ...opened(), startedAt: Date.parse('2026-08-23T01:40:43.225Z') };
    const now = Date.parse('2026-09-09T23:34:23.567Z');
    const rows: Row[] = [
      // Entered under the OLD profit-lock constants (arm 1.0 / giveback 1.0):
      row(Date.parse('2026-08-24T14:44:33.832Z'), 'NVTS', 0.003, 139.5, Date.parse('2026-08-25T13:45:23.481Z'), 'profit_lock'),
      row(Date.parse('2026-08-25T14:50:09.447Z'), 'XLF', 0.0027, 111.5, Date.parse('2026-08-26T13:45:30.781Z'), 'profit_lock'),
      row(Date.parse('2026-08-25T14:50:17.491Z'), 'BULL', 0.0299, 66, Date.parse('2026-08-27T15:03:02.117Z'), 'profit_lock'),
      row(Date.parse('2026-08-25T15:26:05.411Z'), 'NVTSB', -0.396, 142, Date.parse('2026-08-28T14:15:52.617Z'), 'sl_otm_premium_pct'),
      row(Date.parse('2026-08-25T19:04:02.944Z'), 'ETHA', -0.0101, 123, Date.parse('2026-08-27T15:12:30.971Z'), 'profit_lock'),
      // Entered after it:
      row(Date.parse('2026-08-28T14:35:55.880Z'), 'KO', -0.381, 179, Date.parse('2026-09-02T17:35:36.497Z'), 'manual'),
      row(Date.parse('2026-08-28T14:36:01.574Z'), 'NOK', -0.553, 71, Date.parse('2026-09-02T17:35:37.046Z'), 'manual'),
      row(Date.parse('2026-09-01T14:46:14.996Z'), 'TTD', 0.0359, 92, Date.parse('2026-09-02T15:33:23.363Z'), 'profit_lock'),
      row(Date.parse('2026-09-01T19:08:14.724Z'), 'SOUN', -0.3243, 51.5, Date.parse('2026-09-02T19:50:34.361Z'), 'sl_daily_close'),
    ];
    const before = foldOtmEvaluationWindow(rows, live, now);
    expect(before.n).toBe(9);
    const p = previewOtmEvaluationRecut(rows, live, cut, now);
    expect(p.currentN).toBe(9);
    expect(p.countedEntriesPredatingCandidate).toBe(5);
    expect(p.n).toBe(4);
    expect(p.droppedByRecut).toBe(5);
    // Direction of the error: the blend FLATTERS the arm. Restating on the ruled
    // population makes the interim mean MORE negative, not less.
    expect(before.avgR!).toBeGreaterThan(p.avgR!);
    expect(p.avgR!).toBeLessThan(-0.3);
    // …and seR rises ABOVE the 0.10 bar, so the restated sample is not a FAIL
    // under the pre-registered rule either — it is below target and unresolved.
    expect(p.seR!).toBeGreaterThan(OTM_EVALUATION_SE_R_MAX);
  });
});

// ── The ORDERING interlock (2026-09-10) ──────────────────────────────────────
//
// The verdict owner's read of 2026-09-09 (`9087cabe`) recommended filing
// `verdict_insufficient_population` at n=9. Compose the two rules already in this
// module and that is a ONE-WAY DOOR: a verdict is once-only, and a graded window
// can never be re-cut, so the terminal would freeze over the very population the
// same owner's 2026-08-25 ruling declared inadmissible — with no remedy on either
// side. Neither rule is wrong; their COMPOSITION is what nothing stated.
describe('TRA-3945 — a verdict is a one-way door over whichever cut is current', () => {
  const CUT_LIVE = Date.parse('2026-08-23T01:40:43.225Z');
  const RULED = Date.parse('2026-08-26T04:33:57.910Z');
  const NOW = Date.parse('2026-09-10T01:00:00.000Z');
  const liveCut = () => ({ ...opened(), startedAt: CUT_LIVE });

  it('REFUSES a verdict while a ruled re-cut is unexecuted, and names both doors', () => {
    const s = liveCut();
    expect(unexecutedRuledRecuts(s)).toHaveLength(1);
    let threw: Error | null = null;
    try {
      applyOtmEvaluationVerdict(s, { status: 'verdict_insufficient_population', note: 'TRA-3945: starved by entry_window', by: 'QuantTrader', atN: 9 }, NOW);
    } catch (e) { threw = e as Error; }
    expect(threw).toBeTruthy();
    expect(threw!.message).toContain('a9753fda');
    expect(threw!.message).toContain('2026-08-26T04:33:57.910Z'); // the cut it would skip
    expect(threw!.message).toContain('2026-08-23T01:40:43.225Z'); // the cut it would freeze
    expect(threw!.message).toMatch(/recut/);                       // door 1: execute it
    expect(threw!.message).toMatch(/acknowledgeUnexecutedRecuts/); // door 2: override
  });

  it('the override stays the grader\'s to take, and the RECORD keeps it forever', () => {
    const v = applyOtmEvaluationVerdict(
      liveCut(),
      { status: 'verdict_insufficient_population', note: 'TRA-3945: starved by entry_window', by: 'QuantTrader', atN: 9, acknowledgeUnexecutedRecuts: true },
      NOW,
    );
    expect(otmEvaluationWindowStatus(v)).toBe('verdict_insufficient_population');
    expect(v.verdict?.acknowledgedUnexecutedRecuts).toHaveLength(1);
    expect(v.verdict?.acknowledgedUnexecutedRecuts?.[0]).toMatchObject({
      candidateStartedAt: '2026-08-26T04:33:57.910Z',
      cutAtVerdict: '2026-08-23T01:40:43.225Z',
    });
    // The override does NOT make the skipped ruling read as executed.
    expect(unexecutedRuledRecuts(v)).toHaveLength(1);
  });

  it('executing the re-cut FIRST clears the refusal with no flag, and files a clean verdict', () => {
    const cut = applyOtmEvaluationRecut(liveCut(), { startedAt: RULED, by: 'QuantTrader', note: 'TRA-3945 / TRA-4006 ruled re-cut a9753fda' }, NOW);
    expect(unexecutedRuledRecuts(cut)).toHaveLength(0);
    const v = applyOtmEvaluationVerdict(cut, { status: 'verdict_insufficient_population', note: 'TRA-3945: starved by entry_window', by: 'QuantTrader', atN: 4 }, NOW);
    expect(v.verdict?.atN).toBe(4);
    // `null`, never omitted: "nothing to acknowledge" and "acknowledged" are
    // opposite facts about how the terminal was reached.
    expect(v.verdict?.acknowledgedUnexecutedRecuts).toBeNull();
  });

  it('the door only swings one way: verdict-then-re-cut is IMPOSSIBLE, re-cut-then-verdict is not', () => {
    const s = liveCut();
    const graded = applyOtmEvaluationVerdict(s, { status: 'verdict_fail', note: 'TRA-3945', by: 'QuantTrader', acknowledgeUnexecutedRecuts: true }, NOW);
    expect(() => applyOtmEvaluationRecut(graded, { startedAt: RULED, by: 'QuantTrader', note: 'TRA-3945 re-cut' }, NOW)).toThrow(/graded window/);
    const other = applyOtmEvaluationRecut(s, { startedAt: RULED, by: 'QuantTrader', note: 'TRA-3945 re-cut' }, NOW);
    expect(() => applyOtmEvaluationVerdict(other, { status: 'verdict_fail', note: 'TRA-3945', by: 'QuantTrader' }, NOW)).not.toThrow();
  });

  it('publishes the block on the wire BEFORE the grader reaches the writer, and it empties on execution', () => {
    const s = liveCut();
    const rec = buildOtmEvaluationWindowRecord(s, L, true, foldOtmEvaluationWindow([], s, NOW));
    expect(rec.verdictWriter.blockedByUnexecutedRecut).toHaveLength(1);
    expect(rec.verdictWriter.blockedByUnexecutedRecut[0]).toMatchObject({
      candidateStartedAt: '2026-08-26T04:33:57.910Z', currentCut: '2026-08-23T01:40:43.225Z',
    });
    expect(rec.verdictWriter.ordering).toContain('BEFORE any verdict');
    expect(rec.verdictWriter.override).toContain('acknowledgeUnexecutedRecuts');
    const cut = applyOtmEvaluationRecut(s, { startedAt: RULED, by: 'QuantTrader', note: 'TRA-3945 re-cut' }, NOW);
    const rec2 = buildOtmEvaluationWindowRecord(cut, L, true, foldOtmEvaluationWindow([], cut, NOW));
    expect(rec2.verdictWriter.blockedByUnexecutedRecut).toEqual([]);
  });
});

// The pre-registered rule keys on a NORMAL interval. At the n this window
// actually reached, that multiplier is not the honest one — so the t interval is
// published BESIDE it, labelled, rather than substituted for it. Re-cutting a
// pre-registered bar mid-window is exactly what this record exists to prevent.
describe('TRA-3945 — the CI multiplier is pre-registered; the small-sample one is descriptive', () => {
  const NOW = Date.parse('2026-09-10T01:00:00.000Z');
  const liveCut = () => ({ ...opened(), startedAt: Date.parse('2026-08-23T01:40:43.225Z') });

  it('keeps lowerCi95 on z=1.96 and publishes the wider Student-t interval beside it', () => {
    const s = liveCut();
    const rows = Array.from({ length: 9 }, (_, i) => close(i + 1, {
      openTs: Date.parse('2026-08-28T14:00:00.000Z') + i * H,
      closeTs: Date.parse('2026-09-02T14:00:00.000Z') + i * H,
    }));
    const readout = foldOtmEvaluationWindow(rows, s, NOW);
    expect(readout.n).toBe(9);
    const inv = buildOtmEvaluationWindowRecord(s, L, true, readout).thresholds.invalidation;
    expect(inv.lowerCi95).toBeCloseTo(readout.avgR! - 1.96 * readout.seR!, 6);
    expect(inv.lowerCi95Method).toContain('z=1.96');
    expect(inv.studentT?.df).toBe(8);
    expect(inv.studentT?.tCritical).toBe(2.306);
    // Strictly wider on BOTH sides — which is the whole point of publishing it.
    expect(inv.studentT!.lower).toBeLessThan(inv.lowerCi95!);
    expect(inv.studentT!.upper).toBeGreaterThan(readout.avgR! + 1.96 * readout.seR!);
    expect(inv.studentT!.note).toContain('DESCRIPTIVE ONLY');
  });

  it('is null below n=2, where there is no df to speak of', () => {
    const s = liveCut();
    const rec = buildOtmEvaluationWindowRecord(s, L, true, foldOtmEvaluationWindow([], s, NOW));
    expect(rec.thresholds.invalidation.studentT).toBeNull();
    expect(tCritical95(1)).toBeNull();
    expect(tCritical95(9)).toBe(2.306);
    expect(tCritical95(4)).toBe(3.182);   // the re-cut sample's multiplier: z+62%
    expect(tCritical95(400)).toBe(1.96);  // past the table, the normal limit
  });
});
