import { describe, it, expect } from 'vitest';
import {
  computeOpenOptionMark,
  parseOpenOptionMarkFile,
  openOptionMarkUsdByDate,
  resolveOpenOptionMarkDelta,
} from './tradier-eod-option-mark.js';
import {
  shapeLiveRecordedRow,
  STOCK_LEG_BASIS_INERT,
  STOCK_LEG_BASIS_PROBE_DISAGREES,
  STOCK_LEG_PROBE_MARK_DIFFERENCED,
  STOCK_LEG_PROBE_MARK_NOT_MEASURED,
} from './eod-row-backfill.js';

/**
 * TRA-3954 — the stock-leg probe gains its unrealized-mark operand.
 *
 * Fixture is the TRA-3951 Tradier reconcile of account 6YB80154, to the cent:
 *
 *   2026-08-14 close  1143.96, nothing open                 mark       0
 *   2026-08-17 close   946.60, 4 contracts bought 691.44, marked 494.08 → unrealized −197.36
 *   2026-08-18 close   750.16, all closed, realized −393.92 (optionsDaily −393)
 *
 * The three-operand probe read −197.36 on 08-17 (RED) and +196.56 on 08-18
 * (RED) while no trade was missed. With the mark differenced both reconcile.
 */
const CAPTURED_AT = '2026-08-17T21:00:11.000Z';

describe('TRA-3954 — computeOpenOptionMark', () => {
  it('reproduces the TRA-3951 08-17 figure to the cent: 494.08 marked − 691.44 cost = −197.36', () => {
    const r = computeOpenOptionMark({
      balance: { optionLongValue: 494.08, optionShortValue: 0, openPl: -197.36 },
      positions: {
        ok: true,
        // 4 contracts; premiumPaid is per-share, so 691.44 / 4 / 100 = 1.7286.
        positions: [{ contracts: 4, premiumPaid: 1.7286 }],
      },
      capturedAt: CAPTURED_AT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.marketValueUsd).toBeCloseTo(494.08, 2);
    expect(r.snapshot.costBasisUsd).toBeCloseTo(691.44, 2);
    expect(r.snapshot.unrealizedUsd).toBeCloseTo(-197.36, 2);
    expect(r.snapshot.positionCount).toBe(1);
    expect(r.snapshot.brokerOpenPlUsd).toBeCloseTo(-197.36, 2);
  });

  it('an EMPTY book is a real 0, not a non-measurement', () => {
    const r = computeOpenOptionMark({
      balance: { optionLongValue: 0, optionShortValue: 0 },
      positions: { ok: true, positions: [] },
      capturedAt: CAPTURED_AT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.unrealizedUsd).toBe(0);
    expect(r.snapshot.positionCount).toBe(0);
    expect(r.snapshot.brokerOpenPlUsd).toBeNull();
  });

  it('every failure is NAMED, and none of them is a 0', () => {
    const positions = { ok: true as const, positions: [{ contracts: 4, premiumPaid: 1.7286 }] };
    expect(computeOpenOptionMark({ balance: null, positions, capturedAt: CAPTURED_AT }))
      .toMatchObject({ ok: false, reason: 'no-balance' });
    expect(computeOpenOptionMark({ balance: {}, positions, capturedAt: CAPTURED_AT }))
      .toMatchObject({ ok: false, reason: 'no-option-long-value' });
    // A short leg: the positions parser is long-only, so the basis would be
    // incomplete and the number wrong by exactly the short side. Refuse.
    expect(computeOpenOptionMark({
      balance: { optionLongValue: 494.08, optionShortValue: -120 },
      positions,
      capturedAt: CAPTURED_AT,
    })).toMatchObject({ ok: false, reason: 'short-option-value-present' });
    expect(computeOpenOptionMark({
      balance: { optionLongValue: 494.08 },
      positions: { ok: false, detail: 'HTTP 502' },
      capturedAt: CAPTURED_AT,
    })).toMatchObject({ ok: false, reason: 'positions-unreadable', detail: 'HTTP 502' });
    expect(computeOpenOptionMark({
      balance: { optionLongValue: 494.08 },
      positions: { ok: true, positions: [{ contracts: 0, premiumPaid: 1 }] },
      capturedAt: CAPTURED_AT,
    })).toMatchObject({ ok: false, reason: 'position-cost-basis-invalid' });
  });
});

describe('TRA-3954 — the file round-trips and malformed entries are dropped, not zeroed', () => {
  it('parses what it wrote and drops a half-entry', () => {
    const good = {
      marketValueUsd: 494.08, costBasisUsd: 691.44, unrealizedUsd: -197.36,
      positionCount: 1, brokerOpenPlUsd: null, capturedAt: CAPTURED_AT,
    };
    const parsed = parseOpenOptionMarkFile({
      '2026-08-17': good,
      '2026-08-18': { unrealizedUsd: 0 }, // missing the operands it was computed from
      'not-a-date': good,
      '2026-08-19': 'garbage',
    });
    expect(Object.keys(parsed)).toEqual(['2026-08-17']);
    expect(parsed['2026-08-17']).toEqual(good);
    expect(openOptionMarkUsdByDate(parsed)).toEqual({ '2026-08-17': -197.36 });
  });
});

describe('TRA-3954 — resolveOpenOptionMarkDelta', () => {
  const marks = { '2026-08-14': 0, '2026-08-17': -197.36, '2026-08-18': 0 };
  it('differences over the equity span (prevDate, date]', () => {
    expect(resolveOpenOptionMarkDelta(marks, '2026-08-17', '2026-08-14'))
      .toEqual({ markUsd: -197.36, deltaUsd: -197.36 });
    expect(resolveOpenOptionMarkDelta(marks, '2026-08-18', '2026-08-17'))
      .toEqual({ markUsd: 0, deltaUsd: 197.36 });
  });
  it('an absent PRIOR endpoint is NOT MEASURED, never 0 — the first session after the capture ships', () => {
    expect(resolveOpenOptionMarkDelta({ '2026-08-17': -197.36 }, '2026-08-17', '2026-08-14'))
      .toEqual({ markUsd: -197.36, deltaUsd: null });
    expect(resolveOpenOptionMarkDelta(marks, '2026-08-17', null))
      .toEqual({ markUsd: -197.36, deltaUsd: null });
    expect(resolveOpenOptionMarkDelta(undefined, '2026-08-17', '2026-08-14'))
      .toEqual({ markUsd: null, deltaUsd: null });
  });
});

describe('TRA-3954 — shapeLiveRecordedRow with the fourth operand', () => {
  const balanceByDate = { '2026-08-14': 1_143.96, '2026-08-17': 946.6, '2026-08-18': 750.16 };
  const marks = { '2026-08-14': 0, '2026-08-17': -197.36, '2026-08-18': 0 };

  it('08-17: an overnight position reconciles to INERT — the branch that had never fired live', () => {
    const r = shapeLiveRecordedRow({
      date: '2026-08-17',
      optionsDailyPnl: 0,
      balanceByDate,
      override: { prevDate: '2026-08-14', prevBalance: 1_143.96, netCashFlow: 0, combinedPnl: -197.36 },
      optionMarkUsdByDate: marks,
    });
    expect(r.openOptionMarkUsd).toBeCloseTo(-197.36, 2);
    expect(r.openOptionMarkDeltaUsd).toBeCloseTo(-197.36, 2);
    expect(r.stockLegProbeMarkBasis).toBe(STOCK_LEG_PROBE_MARK_DIFFERENCED);
    // (946.60 − 1143.96) − 0 − (−197.36) − 0 = 0.00
    expect(r.stockLegProbeUsd).toBeCloseTo(0, 2);
    expect(r.stockLegBasis).toBe(STOCK_LEG_BASIS_INERT);
  });

  it('08-18: the reversal reconciles too, differenced against optionsDaily (the Tradier-correct side)', () => {
    // Tradier realized −393.92; the row carries optionsDaily −393 (cents lost
    // to the journal's rounding). The residual is that rounding, under $1.
    const r = shapeLiveRecordedRow({
      date: '2026-08-18',
      optionsDailyPnl: -393,
      balanceByDate,
      override: { prevDate: '2026-08-17', prevBalance: 946.6, netCashFlow: 0, combinedPnl: -196.44 },
      optionMarkUsdByDate: marks,
    });
    // (750.16 − 946.60) − (−393) − (+197.36) − 0 = −0.80
    expect(r.openOptionMarkDeltaUsd).toBeCloseTo(197.36, 2);
    expect(r.stockLegProbeUsd).toBeCloseTo(-0.8, 2);
    expect(r.stockLegBasis).toBe(STOCK_LEG_BASIS_INERT);
  });

  it('WITHOUT the prior mark the probe falls back to three operands, says so, and stays RED', () => {
    // The pre-TRA-3954 reading, reproduced: the operand is absent, the probe
    // still honestly reports −197.36 booked to no realized leg, and the row
    // STAMPS that the mark was not differenced rather than assuming 0.
    const r = shapeLiveRecordedRow({
      date: '2026-08-17',
      optionsDailyPnl: 0,
      balanceByDate,
      override: { prevDate: '2026-08-14', prevBalance: 1_143.96, netCashFlow: 0, combinedPnl: -197.36 },
      optionMarkUsdByDate: { '2026-08-17': -197.36 },
    });
    expect(r.openOptionMarkUsd).toBeCloseTo(-197.36, 2);
    expect(r.openOptionMarkDeltaUsd).toBeNull();
    expect(r.stockLegProbeMarkBasis).toBe(STOCK_LEG_PROBE_MARK_NOT_MEASURED);
    expect(r.stockLegProbeUsd).toBeCloseTo(-197.36, 2);
    expect(r.stockLegBasis).toBe(STOCK_LEG_BASIS_PROBE_DISAGREES);
  });

  it('the FAIL branch is still satisfiable with the operand present: a real unbooked move stays RED', () => {
    // Same overnight position, but the close is $100 lower than the mark
    // explains — something unbooked moved the account.
    const r = shapeLiveRecordedRow({
      date: '2026-08-17',
      optionsDailyPnl: 0,
      balanceByDate: { ...balanceByDate, '2026-08-17': 846.6 },
      override: { prevDate: '2026-08-14', prevBalance: 1_143.96, netCashFlow: 0, combinedPnl: -297.36 },
      optionMarkUsdByDate: marks,
    });
    expect(r.stockLegProbeMarkBasis).toBe(STOCK_LEG_PROBE_MARK_DIFFERENCED);
    expect(r.stockLegProbeUsd).toBeCloseTo(-100, 2);
    expect(r.stockLegBasis).toBe(STOCK_LEG_BASIS_PROBE_DISAGREES);
  });

  it('callers that pass no mark map are byte-identical to before, plus the not-measured stamp', () => {
    const r = shapeLiveRecordedRow({
      date: '2026-08-17',
      optionsDailyPnl: 0,
      balanceByDate,
      override: { prevDate: '2026-08-14', prevBalance: 1_143.96, netCashFlow: 0, combinedPnl: -197.36 },
    });
    expect(r.openOptionMarkUsd).toBeNull();
    expect(r.openOptionMarkDeltaUsd).toBeNull();
    expect(r.stockLegProbeMarkBasis).toBe(STOCK_LEG_PROBE_MARK_NOT_MEASURED);
    expect(r.stockLegProbeUsd).toBeCloseTo(-197.36, 2);
  });
});
