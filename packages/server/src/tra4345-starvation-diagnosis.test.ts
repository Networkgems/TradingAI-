// TRA-4345 (parent TRA-3945, filed by QuantTrader off TRA-4342) — the record's
// starvation diagnosis must (AC1) name the gate actually blocking, (AC2)
// self-declare staleness by recomputing the accused gate's state at read time,
// and (AC3) refuse to publish an ETA divided off a historical rate when the
// entry gate is structurally shut. All additive and read-only (AC4): the fold,
// the predicate, `n`, `excludedCloses`, the population cell, the verdict state
// machine and `targetCloses` are untouched — asserted below by building the
// same record under opposite accrual states.
import { describe, expect, it } from 'vitest';
import {
  OTM_EVALUATION_TARGET_CLOSES,
  assessOtmEntryAccrual,
  buildOtmEvaluationWindowRecord,
  emptyOtmEvaluationWindowState,
  evaluateOtmEvaluationLiveness,
  foldOtmEvaluationWindow,
  otmEvaluationCadence,
  type OtmEvaluationWindowState,
} from './otm-evaluation-window.js';
import { OTM_ENTRY_WINDOWS_VALUE, resolveOtmEntryWindows } from './otm-entry-window.js';

/** The live standdown (TRA-4217 card ec5ba87f): a 60s pre-market window. */
const HOLD = assessOtmEntryAccrual(
  resolveOtmEntryWindows({ [OTM_ENTRY_WINDOWS_VALUE]: '03:00-03:01' } as NodeJS.ProcessEnv),
);
/** The board's default windows, which do intersect RTH. */
const OPEN = assessOtmEntryAccrual(resolveOtmEntryWindows({} as NodeJS.ProcessEnv));

const stamped = (): OtmEvaluationWindowState => ({
  ...emptyOtmEvaluationWindowState(),
  startedAt: Date.UTC(2026, 7, 24, 12, 0), // 08:00 ET Mon 08-24, before the close
});

const record = (accrual: typeof HOLD | null) => {
  const st = stamped();
  const l = evaluateOtmEvaluationLiveness({});
  const now = Date.UTC(2026, 8, 4, 2, 12);
  return buildOtmEvaluationWindowRecord(st, l, null, foldOtmEvaluationWindow([], st, now), undefined, accrual);
};

describe('TRA-4345 AC3 — accrual is derived from the effective entry windows, at read time', () => {
  it('a window that never intersects 09:30-16:00 ET cannot accrue; the reason is machine-greppable', () => {
    expect(HOLD).toEqual({
      canAccrue: false,
      cannotAccrueReason: 'entry_window_never_intersects_rth',
      entryWindowsEt: '03:00-03:01',
      entryWindowsSource: 'env',
    });
    expect(OPEN.canAccrue).toBe(true);
    expect(OPEN.cannotAccrueReason).toBeNull();
    expect(OPEN.entryWindowsSource).toBe('default');
  });

  it('intersection honours the half-open bounds on both sides', () => {
    const at = (spec: string) => assessOtmEntryAccrual(
      resolveOtmEntryWindows({ [OTM_ENTRY_WINDOWS_VALUE]: spec } as NodeJS.ProcessEnv),
    ).canAccrue;
    expect(at('09:00-09:30')).toBe(false); // ends AT the open — [09:00,09:30) never touches [09:30,16:00)
    expect(at('16:00-17:00')).toBe(false); // starts AT the close
    expect(at('15:59-16:30')).toBe(true);  // one live minute inside the session is enough
    expect(at('09:00-09:31')).toBe(true);
    expect(at('03:00-03:01,10:15-11:30')).toBe(true); // an OR over the list
  });

  it('a zero FORWARD rate nulls the projection even when the historical average is positive', () => {
    const s = stamped();
    const wedPreOpen = Date.UTC(2026, 7, 26, 12, 0); // Mon+Tue complete => 2 sessions
    const held = otmEvaluationCadence(s, 1, wedPreOpen, HOLD);
    // the historical average is still published — only the ETA divided off it is refused
    expect(held?.closesPerSession).toBe(0.5);
    expect(held?.canAccrue).toBe(false);
    expect(held?.cannotAccrueReason).toBe('entry_window_never_intersects_rth');
    expect(held?.projectedSessionsToTarget).toBeNull();
    // same read with an RTH-intersecting window: the fd917f86 arithmetic is unchanged
    const open = otmEvaluationCadence(s, 1, wedPreOpen, OPEN);
    expect(open?.canAccrue).toBe(true);
    expect(open?.projectedSessionsToTarget).toBe(58);
    // a reached target owes no accrual: 0, not null, under the hold
    expect(otmEvaluationCadence(s, OTM_EVALUATION_TARGET_CLOSES, wedPreOpen, HOLD)?.projectedSessionsToTarget).toBe(0);
  });

  it('an unreadable accrual fails CLOSED for the ETA (no number off an unreadable gate)', () => {
    const c = otmEvaluationCadence(stamped(), 1, Date.UTC(2026, 7, 26, 12, 0), null);
    expect(c?.canAccrue).toBe(false);
    expect(c?.cannotAccrueReason).toBe('entry_window_state_unreadable');
    expect(c?.projectedSessionsToTarget).toBeNull();
  });
});

describe('TRA-4345 AC1+AC2 — the diagnosis names its gate and self-declares staleness', () => {
  it('AC1: observed accuses the ENTRY gate and exonerates capital', () => {
    const ip = record(HOLD).insufficientPopulation;
    expect(ip.observed).toContain('ENTRY GATE');
    expect(ip.observed).toContain('entry_window blocked 607/607');
    expect(ip.observed).toContain('ec5ba87f');
    expect(ip.observed).toContain('Capital is NOT binding');
    expect(ip.observed).not.toContain('$6.74'); // the superseded 08-26 capital figure is gone
    expect(ip.observedAt).toBe('2026-09-04T02:12:00Z');
    expect(ip.observedGate).toBe('entry_window');
  });

  it('AC2: still-blocking is computed from live gate state — true under the hold, false once cleared, null when unreadable (never false)', () => {
    const held = record(HOLD).insufficientPopulation;
    expect(held.observedGateStillBlocking).toBe(true);
    expect(held.stale).toBe(false);

    const cleared = record(OPEN).insufficientPopulation;
    expect(cleared.observedGateStillBlocking).toBe(false);
    expect(cleared.stale).toBe(true); // the supersession is ON THE WIRE, not re-derived by hand

    const unreadable = record(null).insufficientPopulation;
    expect(unreadable.observedGateStillBlocking).toBeNull();
    expect(unreadable.stale).toBeNull();
  });

  it('the record publishes the accrual it computed against, and the cadence carries it', () => {
    const rec = record(HOLD);
    expect(rec.entryAccrual).toEqual(HOLD);
    expect(rec.cadence?.canAccrue).toBe(false);
    expect(rec.cadence?.projectedSessionsToTarget).toBeNull();
  });
});

describe('TRA-4345 AC4 — additive and read-only', () => {
  it('the fold, the count, the exclusions and the target are identical under opposite accrual states', () => {
    const a = record(HOLD);
    const b = record(OPEN);
    expect(a.n).toBe(b.n);
    expect(a.excludedCloses).toEqual(b.excludedCloses);
    expect(a.targetCloses).toBe(b.targetCloses);
    expect(a.populationCell).toEqual(b.populationCell);
    expect(a.status).toBe(b.status);
    expect(a.thresholds).toEqual(b.thresholds);
  });
});
