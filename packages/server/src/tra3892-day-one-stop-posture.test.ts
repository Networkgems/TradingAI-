/**
 * TRA-3892 — premium held under a DECORATIVE day-1 stop.
 *
 * Positive control = the 2026-08-20 ***0154 pair: `XLF260925C00057500` 1ct
 * @1.08 (13:35:30Z) and `BAC260925C00063000` 1ct @1.65 (13:36:23Z), both
 * `sleeve: single_leg_otm`, $273.00 of premium. For ~7 hours NEITHER was
 * breached, so `liveStopActionability` read 0/0/0 over them — correctly. This
 * summary must read $273 over the same rows at the same instant, and must
 * CONTAIN the later breach (one row through its stop at 20:33Z) without the
 * figure changing, because the premium at risk did not change when the mark did.
 *
 * The rows below are the shape of those two fills; the `mark`s are chosen, not
 * measured, because the mark must not matter to this figure.
 */
import { describe, expect, it } from 'vitest';
import type { OptionPosition } from '@trading-app/shared';
import {
  summarizeDayOneStopPosture,
  mergeDayOneStopPosture,
  summarizeLiveStopActionability,
  blindDayOneStopPosture,
} from './options-account.js';

const XLF_OPENED = Date.UTC(2026, 7, 20, 13, 35, 30, 535);
const BAC_OPENED = Date.UTC(2026, 7, 20, 13, 36, 23, 573);
/** Mid-session, hours before the breach. */
const NOON = Date.UTC(2026, 7, 20, 16, 0, 0);
/** The 20:33Z read on which one row was through its stop. */
const POST_CLOSE = Date.UTC(2026, 7, 20, 20, 33, 5);
const RELEASE_ISO = '2026-08-21T00:00:00.000Z';

function otmRow(
  id: string,
  premiumPaid: number,
  openedAt: number,
  overrides: Partial<OptionPosition> = {},
): OptionPosition {
  return {
    id,
    symbol: id,
    optionSymbol: `${id}-occ`,
    optionType: 'call',
    strike: 0,
    expiration: '2026-09-25',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid,
    currentPremium: premiumPaid,
    tp1Premium: premiumPaid * 1.5,
    tp1Hit: false,
    stopLossPremium: premiumPaid * 0.8, // OTM_OPTIONS_SL_PCT 0.20
    peakPremium: premiumPaid,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 0,
    openedAt,
    signalId: `sig-${id}`,
    signalType: 'otm_mispricing',
    mode: 'live',
    ...overrides,
  };
}

const xlf = (o: Partial<OptionPosition> = {}) => otmRow('XLF', 1.08, XLF_OPENED, o);
const bac = (o: Partial<OptionPosition> = {}) => otmRow('BAC', 1.65, BAC_OPENED, o);

describe('TRA-3892 positive control — the 2026-08-20 pair, BEFORE the breach', () => {
  it('reads $273 under a full-premium basis while liveStopActionability reads a clean 0', () => {
    const rows = [xlf(), bac()];
    const posture = summarizeDayOneStopPosture(rows, { holdLiveOptionsOvernightForPdt: true, now: NOON });
    expect(posture).toEqual({
      stopBasis: 'full_premium',
      rows: 2,
      premiumAtRiskUsd: 273,
      premiumBySleeveUsd: { otm_mispricing: 273 },
      releasesAt: RELEASE_ISO,
    });
    // The counter a reader reaches for was RIGHT to read 0: nothing was breached.
    const act = summarizeLiveStopActionability(rows, {
      brokerMirroring: true,
      autoManageImportedTradierOptions: true,
      actOnAdoptedBrokerRows: false,
      holdLiveOptionsOvernightForPdt: true,
      swingHoldOptions: false,
      openingRangeGuardMin: 15, // TRA-3902 — shipped default; NOON is outside the window
      now: NOON,
    });
    expect(act.breached).toBe(0);
    expect(act.inert).toBe(0);
  });

  it('CONTAINS the 20:33Z breach: one row through its stop changes actionability, NOT this figure', () => {
    const rows = [xlf({ currentPremium: 0.80 }), bac()]; // XLF through 0.864
    const act = summarizeLiveStopActionability(rows, {
      brokerMirroring: true,
      autoManageImportedTradierOptions: true,
      actOnAdoptedBrokerRows: false,
      holdLiveOptionsOvernightForPdt: true,
      swingHoldOptions: false,
      openingRangeGuardMin: 15, // TRA-3902 — shipped default; NOON is outside the window
      now: POST_CLOSE,
    });
    expect(act).toMatchObject({ breached: 1, actionable: 0, inert: 1, byReason: { pdt_hold_today: 1 }, releasesAt: RELEASE_ISO });
    const posture = summarizeDayOneStopPosture(rows, { holdLiveOptionsOvernightForPdt: true, now: POST_CLOSE });
    expect(posture.premiumAtRiskUsd).toBe(273);
    expect(posture.rows).toBe(2);
  });

  it('the premium is ENTRY basis: a mark move in either direction leaves it untouched', () => {
    const up = summarizeDayOneStopPosture([xlf({ currentPremium: 2.5 })], { holdLiveOptionsOvernightForPdt: true, now: NOON });
    const down = summarizeDayOneStopPosture([xlf({ currentPremium: 0.05 })], { holdLiveOptionsOvernightForPdt: true, now: NOON });
    expect(up.premiumAtRiskUsd).toBe(108);
    expect(down.premiumAtRiskUsd).toBe(108);
  });

  it('a working exit does NOT shrink it — the premium is at risk until the fill', () => {
    const p = summarizeDayOneStopPosture(
      [xlf({ pendingExit: { orderId: 1, kind: 'sl', contracts: 1, stagedAt: NOON } as never })],
      { holdLiveOptionsOvernightForPdt: true, now: NOON },
    );
    expect(p.premiumAtRiskUsd).toBe(108);
  });
});

describe('TRA-3892 release — the hold is a UTC-day key', () => {
  it('one second past 00:00Z the same rows contribute nothing', () => {
    const p = summarizeDayOneStopPosture([xlf(), bac()], {
      holdLiveOptionsOvernightForPdt: true,
      now: Date.UTC(2026, 7, 21, 0, 0, 1),
    });
    expect(p).toEqual({ stopBasis: 'full_premium', rows: 0, premiumAtRiskUsd: 0, premiumBySleeveUsd: {}, releasesAt: null });
  });
});

describe('TRA-3892 negative controls', () => {
  it('a DEMO row opened today is out of scope', () => {
    const p = summarizeDayOneStopPosture([xlf({ mode: 'demo' }), xlf({ mode: undefined, id: 'legacy' })], {
      holdLiveOptionsOvernightForPdt: true,
      now: NOON,
    });
    expect(p.rows).toBe(0);
  });

  it('a live row opened YESTERDAY is out of scope even if it is breached', () => {
    const p = summarizeDayOneStopPosture(
      [xlf({ openedAt: Date.UTC(2026, 7, 19, 15, 0, 0), currentPremium: 0.5 })],
      { holdLiveOptionsOvernightForPdt: true, now: NOON },
    );
    expect(p.rows).toBe(0);
  });

  it('a closed row is out of scope', () => {
    const p = summarizeDayOneStopPosture([xlf({ closedAt: NOON - 1 })], { holdLiveOptionsOvernightForPdt: true, now: NOON });
    expect(p.rows).toBe(0);
  });

  it('with the PDT knob OFF an OTM row is NOT held — and so is not counted', () => {
    const p = summarizeDayOneStopPosture([xlf()], { holdLiveOptionsOvernightForPdt: false, now: NOON });
    expect(p.rows).toBe(0);
  });
});

describe('TRA-3892 Q3 — the hole is signalType-blind (directional and RV share it)', () => {
  it('a directional row under the PDT knob is counted the same as OTM', () => {
    const p = summarizeDayOneStopPosture([xlf({ signalType: 'atm_directional' as never })], {
      holdLiveOptionsOvernightForPdt: true,
      now: NOON,
    });
    expect(p.premiumBySleeveUsd).toEqual({ atm_directional: 108 });
  });

  it('an RV row is held by the SWING rule even with the PDT knob off — doubly decorative', () => {
    const p = summarizeDayOneStopPosture([bac({ signalType: 'relative_value' })], {
      holdLiveOptionsOvernightForPdt: false,
      now: NOON,
    });
    expect(p).toMatchObject({ rows: 1, premiumAtRiskUsd: 165, premiumBySleeveUsd: { relative_value: 165 } });
  });
});

describe('TRA-3892 fleet fold and blind twin', () => {
  it('sums premium across books and keeps the earliest release', () => {
    const a = summarizeDayOneStopPosture([xlf()], { holdLiveOptionsOvernightForPdt: true, now: NOON });
    const b = summarizeDayOneStopPosture([bac({ signalType: 'relative_value' })], { holdLiveOptionsOvernightForPdt: true, now: NOON });
    const flat = summarizeDayOneStopPosture([], { holdLiveOptionsOvernightForPdt: true, now: NOON });
    expect(mergeDayOneStopPosture([a, b, flat])).toEqual({
      stopBasis: 'full_premium',
      rows: 2,
      premiumAtRiskUsd: 273,
      premiumBySleeveUsd: { otm_mispricing: 108, relative_value: 165 },
      releasesAt: RELEASE_ISO,
    });
  });

  it('the blind twin NULLs every measured field — blind must never read as flat', () => {
    expect(blindDayOneStopPosture()).toEqual({
      stopBasis: 'full_premium',
      rows: null,
      premiumAtRiskUsd: null,
      premiumBySleeveUsd: null,
      releasesAt: null,
    });
  });
});
