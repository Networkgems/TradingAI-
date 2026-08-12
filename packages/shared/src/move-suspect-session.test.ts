import { describe, it, expect } from 'vitest';
import {
  assessQuotePlausibility,
  isMoveSuspect,
  isMoveSuspectNow,
  isSameImpliedPrevClose,
  advanceMoveSuspectSession,
  type MoveSuspectSessionState,
} from './quote-plausibility.js';

/**
 * TRA-3243 — THE SESSION-SCOPED VERDICT.
 *
 * The defect: `signal-engine.applyQuotes` stamped `moveSuspect` on both branches but
 * latched only on the no-quote one, so the flag survived while the feed was BROKEN
 * and cleared the moment it WORKED. `reports/eod-report.ts` grades the CLOSING
 * snapshot, so a row the feed condemned mid-session was republished in the movers
 * table whenever its ratio fell back under the bar — on a denominator that had not
 * changed.
 *
 * Every sequence below is one of the ticket's own measured pairs, re-derived from
 * the published numbers rather than hand-invented:
 *
 *   AZI  08-06  condemned $2.47   / +144.55%  (prev 1.01002, r 2.4455)
 *               published $1.60   /  +58.42%  (prev 1.00997, r 1.5842)   dPrev 0.00005
 *   RDGT 08-10  condemned $1.639  / +119.77%  (prev 0.74578, r 2.1977)
 *               published $0.9899 /  +32.73%  (prev 0.74580, r 1.3273)   dPrev 0.00002
 *
 * Both directions of control, per the discipline `quote-plausibility.test.ts`
 * already follows: the known-bad must be HELD, and a row that is genuinely clean
 * all session must never acquire the fact.
 */
describe('TRA-3243 advanceMoveSuspectSession — latch the DENOMINATOR, not the ratio', () => {
  const DAY = '2026-08-06';
  const v = (price: number, changePct: number) => assessQuotePlausibility({ price, changePct });

  /** Drive a whole session's ticks through the machine, as `applyQuotes` does. */
  const replay = (ticks: { price: number; changePct: number }[], day = DAY) => {
    let state: MoveSuspectSessionState = {};
    const trail: string[] = [];
    for (const t of ticks) {
      const advanced = advanceMoveSuspectSession(state, v(t.price, t.changePct), day);
      trail.push(advanced.transition);
      state = advanced;
    }
    return { state, trail };
  };

  // ── The two exemplars the ticket was filed on ──────────────────────────────

  it('AZI 08-06: condemned at +144.55%, still condemned at the +58.42% close', () => {
    // POSITIVE CONTROL FIRST — the fixture must CONTAIN what the instrument
    // detects. If the opening tick were not suspect under the deployed rule, the
    // whole sequence would pass with the state machine deleted.
    expect(v(2.47, 144.55).suspect).toBe(true);
    expect(v(2.47, 144.55).ratio).toBeCloseTo(2.4455, 4);
    // ...and the closing tick must be genuinely CLEAN, or this test proves nothing
    // beyond what `isMoveSuspectNow` already did.
    expect(v(1.60, 58.42).suspect).toBe(false);

    const { state, trail } = replay([
      { price: 2.47, changePct: 144.55 },   // intraday — condemned
      { price: 2.10, changePct: 107.92 },   // still over the bar
      { price: 1.60, changePct: 58.42 },    // the close, r = 1.5842
    ]);
    expect(trail).toEqual(['condemned', 'sustained', 'held']);
    expect(state.moveSuspectSession).toBe(true);

    // The whole finding in two assertions: the closing row reads CLEAN
    // instantaneously and SUSPECT as a session fact, and the EOD report samples
    // exactly this row.
    const closingRow = { price: 1.60, changePct: 58.42, moveSuspect: false, ...state };
    expect(isMoveSuspectNow(closingRow)).toBe(false);
    expect(isMoveSuspect(closingRow)).toBe(true);

    // ...and it is held because the DENOMINATOR never moved, which is the reason
    // the ticket gives and the only reason that licenses holding.
    expect(state.moveSuspectPrevClose).toBeCloseTo(1.0100, 3);
    expect(v(1.60, 58.42).impliedPrevClose).toBeCloseTo(1.0100, 3);
  });

  it('RDGT 08-10: condemned at +119.77%, still condemned at the +32.73% close', () => {
    expect(v(1.639, 119.77).suspect).toBe(true);
    expect(v(1.639, 119.77).ratio).toBeCloseTo(2.1977, 4);
    expect(v(0.9899, 32.73).suspect).toBe(false);

    const { state, trail } = replay([
      { price: 1.639, changePct: 119.77 },
      { price: 0.9899, changePct: 32.73 },
    ], '2026-08-10');
    expect(trail).toEqual(['condemned', 'held']);
    expect(isMoveSuspect({ price: 0.9899, changePct: 32.73, ...state })).toBe(true);

    // The ticket quotes the condemned prev as 0.7390 (a `price - change` recovery)
    // and the published one as 0.7458 (a `changePct` recovery). They are the same
    // datum under two recoveries, and the identity band must say so — otherwise the
    // fix would discharge on nothing but which field the feed happened to send.
    expect(isSameImpliedPrevClose(0.7390, 0.7458)).toBe(true);
  });

  // ── The control in the other direction (acceptance criterion 3) ────────────

  it('a row that is genuinely clean all session never acquires the fact', () => {
    // SOXL, verbatim from the 07-29 archived movers table, walked across a session.
    const { state, trail } = replay([
      { price: 109.54, changePct: 0.0 },
      { price: 98.20, changePct: -10.35 },
      { price: 91.99, changePct: -16.02 },
    ]);
    expect(trail).toEqual(['clean', 'clean', 'clean']);
    expect(state.moveSuspectSession).toBe(false);
    expect(state.moveSuspectPrevClose).toBeUndefined();
    expect(isMoveSuspect({ price: 91.99, changePct: -16.02, ...state })).toBe(false);
  });

  it('a large but plausible mover is not swept up — the bar still has to be crossed', () => {
    // IREN / AXTI / ONDS from the same table: double-digit sessions, all clean.
    for (const t of [
      { price: 29.31, changePct: -13.62 },
      { price: 36.97, changePct: -13.54 },
      { price: 6.80, changePct: -13.49 },
    ]) {
      const { state, trail } = replay([t, t, t]);
      expect(trail).toEqual(['clean', 'clean', 'clean']);
      expect(state.moveSuspectSession).toBe(false);
    }
  });

  // ── Discharge: the reason this is not a plain latch ────────────────────────

  it('DISCHARGES when the feed re-derives a materially different prev close', () => {
    // FGMC $8.30: condemned on an unadjusted prev of 3.9400 (r = 2.1066), then the
    // feed adjusts and the same price implies 7.8800. THAT is new information about
    // the datum under suspicion, and it is the only thing that clears the fact.
    const { state, trail } = replay([
      { price: 8.30, changePct: 110.66 },
      { price: 8.30, changePct: 5.33 },
    ]);
    expect(trail).toEqual(['condemned', 'discharged']);
    expect(state.moveSuspectSession).toBe(false);
    expect(isMoveSuspect({ price: 8.30, changePct: 5.33, ...state })).toBe(false);
  });

  it('re-condemns after a discharge — the machine is not one-way', () => {
    const { trail } = replay([
      { price: 8.30, changePct: 110.66 },
      { price: 8.30, changePct: 5.33 },
      { price: 8.30, changePct: 110.66 },
    ]);
    expect(trail).toEqual(['condemned', 'discharged', 'condemned']);
  });

  it('the ANCHOR is never re-based while the fact stands', () => {
    // Three clean-but-same-denominator ticks that each wander a little. If the
    // anchor were re-based per tick the identity band would ratchet, and a
    // genuinely corrected denominator could creep in one quantisation step at a
    // time without ever tripping the discharge test.
    const { state, trail } = replay([
      { price: 2.47, changePct: 144.55 },   // anchor := 1.01002
      { price: 1.60, changePct: 58.42 },
      { price: 1.61, changePct: 59.41 },
      { price: 1.62, changePct: 60.40 },
    ]);
    expect(trail).toEqual(['condemned', 'held', 'held', 'held']);
    expect(state.moveSuspectPrevClose).toBeCloseTo(1.0100, 3);
  });

  // ── Fail-closed and session scoping ────────────────────────────────────────

  it('an UNREADABLE denominator holds the fact — it is not evidence of a corrected one', () => {
    // `price: 0` is the no-quote shape: `assessQuotePlausibility` returns the OK
    // verdict (`suspect:false`, `impliedPrevClose:null`) because availability is not
    // its jurisdiction. A machine that read that as "clean" would let any feed
    // dropout launder a condemned row — TRA-2610's exact defect, one field over.
    expect(v(0, 0).suspect).toBe(false);
    expect(v(0, 0).impliedPrevClose).toBeNull();

    const { state, trail } = replay([
      { price: 2.47, changePct: 144.55 },
      { price: 0, changePct: 0 },
      { price: 1.60, changePct: 58.42 },
    ]);
    expect(trail).toEqual(['condemned', 'unreadable', 'held']);
    expect(state.moveSuspectSession).toBe(true);
    // The anchor survives the dropout, so the row is still DISCHARGE-able after it.
    expect(state.moveSuspectPrevClose).toBeCloseTo(1.0100, 3);
  });

  it('the fact is scoped to ONE ET session and rolls over', () => {
    const condemned = advanceMoveSuspectSession({}, v(2.47, 144.55), '2026-08-06');
    expect(condemned.moveSuspectSession).toBe(true);

    // Same clean row, next session: yesterday's suspicion is a claim about a prev
    // close that is not even in today's arithmetic.
    const next = advanceMoveSuspectSession(condemned, v(1.60, 58.42), '2026-08-07');
    expect(next.transition).toBe('rolled_over');
    expect(next.moveSuspectSession).toBe(false);
    expect(next.moveSuspectSessionDay).toBe('2026-08-07');
  });

  // ── The identity band, stated rather than assumed ──────────────────────────

  it('the identity band absorbs `change` quantisation and nothing larger', () => {
    // 2dp quantisation of `change` wanders the recovered prev by up to +/-0.005, so
    // two reads of a FIXED true prev close can differ by 0.01 with nothing having
    // happened.
    expect(isSameImpliedPrevClose(1.0100, 1.0000)).toBe(true);    // 0.01  — quantisation
    expect(isSameImpliedPrevClose(1.0100, 0.9950)).toBe(true);    // 0.015 — still inside
    // The smallest corporate action in the grid (3:2) moves the denominator 33%,
    // which is orders of magnitude away. The band sits in the GAP between the two
    // populations (TRA-3241: a threshold on the mode of its own population is a
    // coin flip on it).
    expect(isSameImpliedPrevClose(3.9400, 7.8800)).toBe(false);   // 2:1
    expect(isSameImpliedPrevClose(6.0000, 4.0000)).toBe(false);   // 3:2
    // Unreadable on either side is never "the same datum".
    expect(isSameImpliedPrevClose(null, 1.01)).toBe(false);
    expect(isSameImpliedPrevClose(1.01, undefined)).toBe(false);
    expect(isSameImpliedPrevClose(NaN, NaN)).toBe(false);
  });

  it('sub-penny rows cannot discharge, and that is the feed resolution, not a tuning error', () => {
    // RECORDED DELIBERATELY, because the ticket names this partition (FLYYQ hit
    // r >= 2 on 4 of 4 readable sessions) as the reason not to simply latch.
    //
    // Below ~$2 the identity band is dominated by the 2dp `change` quantisation
    // floor, so at $0.02 EVERY candidate denominator is inside it. The machine
    // therefore HOLDS a condemned sub-penny row for the rest of the session. That
    // is truthful rather than convenient: when `change` carries 2dp you genuinely
    // cannot distinguish a prev close of 0.01 from one of 0.02, so "the feed
    // corrected it" is not an observation you are entitled to make. It fails
    // CLOSED, it is session-scoped (the next open rolls it over), and TRA-2379's
    // cost asymmetry says a row losing a badge is the cheap error while a
    // fabrication at #1 is not.
    expect(isSameImpliedPrevClose(0.01, 0.02)).toBe(true);

    const { state, trail } = replay([
      { price: 0.02, changePct: 100 },      // r = 2.000 exactly
      { price: 0.02, changePct: 33.34 },    // r = 1.3334 — clean instantaneously
    ]);
    expect(trail).toEqual(['condemned', 'held']);
    expect(state.moveSuspectSession).toBe(true);
  });
});
