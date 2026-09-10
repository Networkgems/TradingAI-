// TRA-3945 — the SUCCESSOR writer (re-register the pre-registration over a fresh sample).
//
// The verdict owner's standing call (TRA-4342, 2026-09-04) is "RE-REGISTER a fresh
// window at the un-hold — never resume n=9 across a regime gap"; the CFO's sequence on
// TRA-4376 ends the same way, and the un-hold went live 2026-09-10 (TRA-4520). Nothing
// could write it: the window id was a constant, the loader discarded any other id, a
// verdict froze the tick, and a graded window refuses a re-cut.
//
// These cover the TERMINAL-only precondition (a successor must never stand in for a
// grade), the fresh stamp, ruling scope, the persisted chain, and the loader.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OTM_EVALUATION_RULED_RECUTS,
  applyOtmEvaluationRecut,
  applyOtmEvaluationSuccessor,
  applyOtmEvaluationVerdict,
  buildOtmEvaluationWindowRecord,
  emptyOtmEvaluationWindowState,
  evaluateOtmEvaluationLiveness,
  foldOtmEvaluationWindow,
  isOtmEvaluationWindowId,
  loadOtmEvaluationWindowState,
  nextOtmEvaluationWindowId,
  otmEvaluationWindowStatus,
  ruledRecutsFor,
  saveOtmEvaluationWindowState,
  setOtmEvaluationWindowFileForTests,
  stepOtmEvaluationWindow,
  unexecutedRuledRecuts,
  type OtmEvaluationBuildPin,
  type OtmEvaluationLivenessInputs,
  type OtmEvaluationWindowState,
} from './otm-evaluation-window.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

const T0 = Date.UTC(2026, 7, 24, 13, 30);
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
const PIN2: OtmEvaluationBuildPin = {
  commit: 'b5c76cc1c492a688434b6e1729b144d156a07e17', commitShort: 'b5c76cc1c492', pid: 76, startedAt: '2026-09-10T21:12:11.986Z',
};

const ALL_TRUE: OtmEvaluationLivenessInputs = {
  liveOtmArmed: true,
  liveOtmRouting: true,
  otmSleeveExitRule: { rule: 'trail', chandelierRetired: true },
  otmEntryWindows: { refusalDedupe: { windowRefusalExpiresAtNextOpen: true } },
  liveDayOneStopPosture: { otmDayOneStop: { armed: true, release: { released: true } } },
  otmContractFloor: { invalidKeys: [], bandIntersectsSelector: true, deltaBand: [0.50, 0.55], selectorBand: [0.50, 0.55] },
};
const L = evaluateOtmEvaluationLiveness(ALL_TRUE);

function opened(records: Row[] = []): OtmEvaluationWindowState {
  return stepOtmEvaluationWindow(emptyOtmEvaluationWindowState(), L, PIN, records, T0 - H, ALL_TRUE.otmContractFloor).state;
}

/** w1 opened, its RULED re-cut executed (so the interlock is satisfied), and graded. */
function gradedW1(rows: Row[], now: number): OtmEvaluationWindowState {
  const ruled = OTM_EVALUATION_RULED_RECUTS[0]!.candidateStartedAt;
  // The fixture opens before the ruled candidate so the ruled cut is FORWARD.
  const s = { ...opened(rows), startedAt: ruled - 10 * H };
  const cut = applyOtmEvaluationRecut(s, { startedAt: ruled, by: 'QuantTrader', note: 'TRA-3945 ruled re-cut a9753fda' }, now);
  const n = foldOtmEvaluationWindow(rows, cut, now).n;
  return applyOtmEvaluationVerdict(cut, { status: 'verdict_insufficient_population', note: 'TRA-4376: starved by entry_window hold', by: 'QuantTrader', atN: n }, now);
}

const RULED = OTM_EVALUATION_RULED_RECUTS[0]!.candidateStartedAt;
const NOW = RULED + 400 * H;
/** Rows around the ruled cut: 3 enter before it, 4 after. */
function rowsAroundRuled(): Row[] {
  return Array.from({ length: 7 }, (_, i) => close(i + 1, { openTs: RULED + (i - 3) * H + 1, closeTs: RULED + (i - 3) * H + 2 * H }));
}

describe('TRA-3945 successor — window id family', () => {
  it('accepts the family and increments', () => {
    expect(isOtmEvaluationWindowId('otm-joint-arm-w1')).toBe(true);
    expect(isOtmEvaluationWindowId('otm-joint-arm-w12')).toBe(true);
    expect(isOtmEvaluationWindowId('otm-joint-arm')).toBe(false);
    expect(isOtmEvaluationWindowId(null)).toBe(false);
    expect(nextOtmEvaluationWindowId('otm-joint-arm-w1')).toBe('otm-joint-arm-w2');
    expect(nextOtmEvaluationWindowId('otm-joint-arm-w9')).toBe('otm-joint-arm-w10');
    expect(() => nextOtmEvaluationWindowId('nope')).toThrow(/not an evaluation window id/);
  });
});

describe('TRA-3945 successor — the precondition is TERMINAL', () => {
  it('refuses a LIVE window: a successor must never stand in for a grade', () => {
    const rows = rowsAroundRuled();
    const s = opened(rows);
    expect(otmEvaluationWindowStatus(s)).toBe('counting');
    expect(() => applyOtmEvaluationSuccessor(s, rows, { by: 'QuantTrader', note: 'TRA-4376 re-register' }, NOW)).toThrow(/not terminal/);
  });

  it('refuses a note with no ticket reference and a window that never opened', () => {
    const rows = rowsAroundRuled();
    const g = gradedW1(rows, NOW);
    expect(() => applyOtmEvaluationSuccessor(g, rows, { by: 'QT', note: 're-register' }, NOW)).toThrow(/TRA-nnnn/);
    expect(() => applyOtmEvaluationSuccessor(emptyOtmEvaluationWindowState(), rows, { by: 'QT', note: 'TRA-3945' }, NOW)).toThrow(/never opened/);
  });

  it('accepts the code terminal (inconclusive_terminal) as well as a written verdict', () => {
    const rows = rowsAroundRuled();
    const s = { ...opened(rows), terminalAt: NOW - H };
    expect(otmEvaluationWindowStatus(s)).toBe('inconclusive_terminal');
    const next = applyOtmEvaluationSuccessor(s, rows, { by: 'QuantTrader', note: 'TRA-3945 re-register' }, NOW);
    expect(next.windowId).toBe('otm-joint-arm-w2');
  });
});

describe('TRA-3945 successor — the new window', () => {
  it('is born ARMED with nothing inherited but the pre-registration, and keeps w1 verbatim', () => {
    const rows = rowsAroundRuled();
    const g = gradedW1(rows, NOW);
    const next = applyOtmEvaluationSuccessor(g, rows, { by: 'QuantTrader', note: 'TRA-4376 re-register at the un-hold' }, NOW);

    expect(next.windowId).toBe('otm-joint-arm-w2');
    expect(otmEvaluationWindowStatus(next)).toBe('armed');
    expect(next.startedAt).toBeNull();
    expect(next.verdict).toBeNull();
    expect(next.baseline).toBeNull();
    expect(next.populationCell).toBeNull();
    expect(next.recutHistory).toEqual([]);
    expect(next.extension.used).toBe(false);

    expect(next.predecessors).toHaveLength(1);
    const p = next.predecessors![0]!;
    expect(p.windowId).toBe('otm-joint-arm-w1');
    expect(p.startedAt).toBe(RULED);
    expect(p.verdict?.status).toBe('verdict_insufficient_population');
    expect(p.verdict?.atN).toBe(4);
    expect(p.finalReadout.n).toBe(4);
    expect(p.recutHistory).toHaveLength(1);
    expect(p.baseline).toEqual(g.baseline);
    expect(p.populationCell).toEqual(g.populationCell);
    expect(p.retiredAt).toBe(NOW);
    expect(p.retiredBy).toBe('QuantTrader');
    expect(p.retiredNote).toMatch(/TRA-4376/);
  });

  it('records a close that landed between the verdict and the successor, not silently', () => {
    const rows = rowsAroundRuled();
    const g = gradedW1(rows, NOW);
    const late = close(50, { openTs: NOW + H, closeTs: NOW + 2 * H });
    const next = applyOtmEvaluationSuccessor(g, [...rows, late], { by: 'QuantTrader', note: 'TRA-4376' }, NOW + 3 * H);
    const p = next.predecessors![0]!;
    expect(p.verdict?.atN).toBe(4);
    expect(p.finalReadout.n).toBe(5); // the fold does not stop at the verdict - both are kept
  });

  it('stamps ITSELF on the next all-true tick and counts only closes entered after that stamp', () => {
    const rows = rowsAroundRuled();
    const g = gradedW1(rows, NOW);
    const w2 = applyOtmEvaluationSuccessor(g, rows, { by: 'QuantTrader', note: 'TRA-4376' }, NOW);
    const STAMP = NOW + 60_000;
    const stamped = stepOtmEvaluationWindow(w2, L, PIN2, rows, STAMP, ALL_TRUE.otmContractFloor);
    expect(stamped.changed).toBe(true);
    expect(stamped.state.startedAt).toBe(STAMP);
    expect(stamped.state.startBuild).toEqual(PIN2);
    expect(stamped.state.baseline?.frozen).toBe(true);
    expect(stamped.state.populationCell?.frozen).toBe(true);
    expect(otmEvaluationWindowStatus(stamped.state)).toBe('counting');

    // Every w1 close entered before the stamp: n 0. A post-stamp close counts.
    expect(foldOtmEvaluationWindow(rows, stamped.state, STAMP + H).n).toBe(0);
    const fresh = close(60, { openTs: STAMP + H, closeTs: STAMP + 3 * H });
    expect(foldOtmEvaluationWindow([...rows, fresh], stamped.state, STAMP + 4 * H).n).toBe(1);
  });

  it('does not stamp while the predicate is false (born armed, not counting)', () => {
    const rows = rowsAroundRuled();
    const w2 = applyOtmEvaluationSuccessor(gradedW1(rows, NOW), rows, { by: 'QuantTrader', note: 'TRA-4376' }, NOW);
    const off = evaluateOtmEvaluationLiveness({ ...ALL_TRUE, liveOtmRouting: false });
    const s = stepOtmEvaluationWindow(w2, off, PIN2, rows, NOW + 60_000, ALL_TRUE.otmContractFloor).state;
    expect(s.startedAt).toBeNull();
    expect(otmEvaluationWindowStatus(s)).toBe('armed');
  });

  it('chains: w2 graded -> w3 keeps BOTH predecessors in order', () => {
    const rows = rowsAroundRuled();
    const w2 = applyOtmEvaluationSuccessor(gradedW1(rows, NOW), rows, { by: 'QuantTrader', note: 'TRA-4376' }, NOW);
    const w2open = stepOtmEvaluationWindow(w2, L, PIN2, rows, NOW + 60_000, ALL_TRUE.otmContractFloor).state;
    const w2graded = applyOtmEvaluationVerdict(w2open, { status: 'verdict_insufficient_population', note: 'TRA-3945 w2', by: 'QuantTrader', atN: 0 }, NOW + 2 * H);
    const w3 = applyOtmEvaluationSuccessor(w2graded, rows, { by: 'QuantTrader', note: 'TRA-3945 w3' }, NOW + 3 * H);
    expect(w3.windowId).toBe('otm-joint-arm-w3');
    expect(w3.predecessors!.map((p) => p.windowId)).toEqual(['otm-joint-arm-w1', 'otm-joint-arm-w2']);
  });
});

describe('TRA-3945 successor — ruled re-cuts stay with the window they were ruled on', () => {
  it('the w1 ruling does not bind, block or preview a successor', () => {
    expect(ruledRecutsFor('otm-joint-arm-w1')).toHaveLength(OTM_EVALUATION_RULED_RECUTS.length);
    expect(ruledRecutsFor('otm-joint-arm-w2')).toHaveLength(0);
    // Even a successor whose cut sits BEFORE the w1 candidate is not held by it.
    const w2 = { ...emptyOtmEvaluationWindowState(), windowId: 'otm-joint-arm-w2', startedAt: RULED - 100 * H };
    expect(unexecutedRuledRecuts(w2)).toHaveLength(0);
    expect(() => applyOtmEvaluationVerdict(w2, { status: 'verdict_fail', note: 'TRA-3945', by: 'QuantTrader' }, NOW)).not.toThrow();
    // ...while the same cut on w1 is still refused (the interlock is intact).
    const w1 = { ...w2, windowId: 'otm-joint-arm-w1' };
    expect(unexecutedRuledRecuts(w1)).toHaveLength(1);
  });
});

describe('TRA-3945 successor — the wire', () => {
  it('publishes the writer, availability, next id and the predecessor chain', () => {
    const rows = rowsAroundRuled();
    const live = opened(rows);
    const liveRec = buildOtmEvaluationWindowRecord(live, L, true, foldOtmEvaluationWindow(rows, live, NOW), undefined, null, null);
    expect(liveRec.successor.available).toBe(false);
    expect(liveRec.successor.nextWindowId).toBe('otm-joint-arm-w2');
    expect(liveRec.successor.predecessors).toEqual([]);
    expect(liveRec.recut.ruled).toHaveLength(OTM_EVALUATION_RULED_RECUTS.length);

    const g = gradedW1(rows, NOW);
    expect(buildOtmEvaluationWindowRecord(g, L, true, foldOtmEvaluationWindow(rows, g, NOW), undefined, null, null).successor.available).toBe(true);

    const w2 = applyOtmEvaluationSuccessor(g, rows, { by: 'QuantTrader', note: 'TRA-4376' }, NOW);
    const rec = buildOtmEvaluationWindowRecord(w2, L, true, foldOtmEvaluationWindow(rows, w2, NOW), undefined, null, null);
    expect(rec.windowId).toBe('otm-joint-arm-w2');
    expect(rec.status).toBe('armed');
    expect(rec.recut.ruled).toEqual([]);
    expect(rec.verdictWriter.blockedByUnexecutedRecut).toEqual([]);
    expect(rec.successor.nextWindowId).toBe('otm-joint-arm-w3');
    expect(rec.successor.predecessors).toHaveLength(1);
    expect(rec.successor.predecessors[0]!.windowId).toBe('otm-joint-arm-w1');
    expect(rec.successor.predecessors[0]!.finalReadout.n).toBe(4);
    expect(rec.successor.predecessors[0]!.retiredAt).toBe(new Date(NOW).toISOString());
  });
});

describe('TRA-3945 successor — persistence', () => {
  let dir: string | null = null;
  afterEach(() => {
    setOtmEvaluationWindowFileForTests(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('a successor file SURVIVES a restart (the old loader discarded it and a tick would have saved an empty w1 over it)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tra3945-succ-'));
    const file = join(dir, 'otm-evaluation-window.json');
    setOtmEvaluationWindowFileForTests(file);
    const rows = rowsAroundRuled();
    const w2 = applyOtmEvaluationSuccessor(gradedW1(rows, NOW), rows, { by: 'QuantTrader', note: 'TRA-4376' }, NOW);
    await saveOtmEvaluationWindowState(w2);
    setOtmEvaluationWindowFileForTests(file); // drops the cache = a restart
    const loaded = await loadOtmEvaluationWindowState();
    expect(loaded.windowId).toBe('otm-joint-arm-w2');
    expect(loaded.predecessors).toHaveLength(1);
    expect(loaded.predecessors![0]!.verdict?.status).toBe('verdict_insufficient_population');
  });

  it('still refuses a file outside the family', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tra3945-succ-'));
    const file = join(dir, 'otm-evaluation-window.json');
    setOtmEvaluationWindowFileForTests(file);
    await saveOtmEvaluationWindowState({ ...emptyOtmEvaluationWindowState(), windowId: 'something-else', startedAt: T0 });
    setOtmEvaluationWindowFileForTests(file);
    const loaded = await loadOtmEvaluationWindowState();
    expect(loaded.windowId).toBe('otm-joint-arm-w1');
    expect(loaded.startedAt).toBeNull();
  });
});
