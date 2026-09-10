import { describe, it, expect } from 'vitest';
import {
  buildStockLegProbeReadOperands,
  datedOptionTradeFeesOverSpan,
  ledgerOpenOptionBasisAt,
  resolveOptionBasisShift,
  sumBrokerFeesOverSpan,
  type ProbeJournalLot,
} from './stock-leg-probe-operands.js';
import { reconcilePnl } from './pnl-reconciliation.js';
import { shapeLiveRecordedRow } from './eod-row-backfill.js';
import {
  patchEodReportOptionsPnl,
  planOptionsDailyPnlRestatements,
  isJournalAuthoritativeSource,
} from './options-daily-pnl-source.js';
import type { DailySnapshot } from './pnl-tracker.js';
import type { JournalDayCloses } from './pnl-reconciliation.js';

/**
 * TRA-4506 — the stock-leg probe's missing operands. Every figure below is the
 * live bqb1 row or journal lot as read 2026-09-10 on build c54f1e735967, and the
 * broker side is CFO's reconciliation against Tradier ***0154 (TRA-4245).
 */

const ET = (iso: string): number => Date.parse(iso);
const etDate = (ts: number): string =>
  new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// admin's live lots around the RIG re-buy, exactly as the journal holds them.
// Note lot B's `openTs`: the reconciler mint copied it off lot A (08-21 14:04),
// though the desk actually bought it on 08-24.
const RIG_A: ProbeJournalLot = {
  mode: 'live', optionSymbol: 'RIG260925C00006000', contracts: 1,
  openTs: ET('2026-08-21T14:04:00-04:00'), closeTs: ET('2026-08-24T11:15:00-04:00'),
  entryFillPremium: 0.33, pnlBasis: 'broker-fill', feesUsd: 0.24, atRiskUsd: 33,
};
const RIG_B: ProbeJournalLot = {
  mode: 'live', optionSymbol: 'RIG260925C00006000', contracts: 1,
  openTs: ET('2026-08-21T14:04:00-04:00'), closeTs: ET('2026-08-26T09:45:00-04:00'),
  entryBasisPremium: 0.22, atRiskUsd: 22, atRiskBasis: 'fill',
};
const NVTS125_ADMIN: ProbeJournalLot = {
  mode: 'live', optionSymbol: 'NVTS261002C00012500', contracts: 1,
  openTs: ET('2026-08-24T10:44:00-04:00'), closeTs: ET('2026-08-25T09:45:00-04:00'),
  entryFillPremium: 1.51, pnlBasis: 'broker-fill', feesUsd: 0.63, atRiskUsd: 139.5,
};
const NVTS13: ProbeJournalLot = {
  mode: 'live', optionSymbol: 'NVTS261002C00013000', contracts: 1,
  openTs: ET('2026-08-25T11:26:00-04:00'), closeTs: ET('2026-08-28T10:15:00-04:00'),
  entryBasisPremium: 1.45, entryFillPremium: 1.45, pnlBasis: 'broker-fill', feesUsd: 0.24, atRiskUsd: 142,
};
const ETHA: ProbeJournalLot = {
  mode: 'live', optionSymbol: 'ETHA261002C00019000', contracts: 1,
  openTs: ET('2026-08-25T15:04:00-04:00'), closeTs: ET('2026-08-27T11:12:00-04:00'),
  entryBasisPremium: 1.28, entryFillPremium: 1.28, pnlBasis: 'broker-fill', feesUsd: 0.24, atRiskUsd: 123,
};
const ADMIN_LOTS = [RIG_A, RIG_B, NVTS125_ADMIN, NVTS13, ETHA];

// Tradier's `/positions` cost basis at each close: RIG averaged to
// (33 + 22) / 2 = 27.50 on the remaining contract after the re-buy-while-held.
const ADMIN_MARKS = {
  '2026-08-24': { costBasisUsd: 27.5 + 151, positionCount: 2 },
  '2026-08-25': { costBasisUsd: 27.5 + 145 + 128, positionCount: 3 },
  '2026-08-26': { costBasisUsd: 145 + 128, positionCount: 2 },
};

describe('TRA-4506 AC1 — the broker-fee operand', () => {
  const events = [
    { date: '2026-09-03', type: 'fee', amount: -10 },
    { date: '2026-09-03', type: 'ach', amount: 500 },
    { date: '2026-09-02', type: 'fee', amount: -3 },
  ];
  it('sums only NON-capital events, over the half-open span the flow uses', () => {
    expect(sumBrokerFeesOverSpan(events, '2026-09-02', '2026-09-03')).toBe(-10);
    // The anchor day's own fee is already in the prior balance.
    expect(sumBrokerFeesOverSpan(events, '2026-09-03', '2026-09-04')).toBe(0);
  });
});

describe('TRA-4506 AC3 — the mark basis shift', () => {
  it('prices the ledger on the lot, judged open by ET date (the mint openTs is 3 days early)', () => {
    expect(ledgerOpenOptionBasisAt(ADMIN_LOTS, '2026-08-25', etDate)).toEqual({
      ok: true, costUsd: 22 + 145 + 128, symbolCount: 3,
    });
  });

  it('reads −5.50 on 08-26, the day the averaged lot left the book, and 0 while it was held', () => {
    expect(resolveOptionBasisShift(ADMIN_MARKS, ADMIN_LOTS, '2026-08-25', '2026-08-24', etDate))
      .toEqual({ shiftUsd: 0, reason: null });
    expect(resolveOptionBasisShift(ADMIN_MARKS, ADMIN_LOTS, '2026-08-26', '2026-08-25', etDate))
      .toEqual({ shiftUsd: -5.5, reason: null });
  });

  it('refuses rather than publish a lot\'s whole cost as a "shift" when the populations differ', () => {
    const marks = { ...ADMIN_MARKS, '2026-08-25': { costBasisUsd: 300.5, positionCount: 4 } };
    expect(resolveOptionBasisShift(marks, ADMIN_LOTS, '2026-08-26', '2026-08-25', etDate))
      .toEqual({ shiftUsd: null, reason: 'position-count-mismatch' });
  });

  it('never prices a lot off the broker blend or the pre-trade mid', () => {
    const blend: ProbeJournalLot = { ...RIG_B, entryBasisPremium: undefined, atRiskBasis: 'mark' };
    expect(resolveOptionBasisShift(ADMIN_MARKS, [RIG_A, blend, NVTS125_ADMIN, NVTS13, ETHA],
      '2026-08-26', '2026-08-25', etDate)).toEqual({ shiftUsd: null, reason: 'lot-unpriced' });
  });
});

// v0nni's lots around 2026-08-25: one exit, two entries — the only 3-fill day.
const V0NNI_LOTS: ProbeJournalLot[] = [
  { mode: 'live', optionSymbol: 'NVTS261002C00012500', contracts: 1,
    openTs: ET('2026-08-24T10:25:00-04:00'), closeTs: ET('2026-08-25T09:45:00-04:00'),
    entryFillPremium: 1.54, pnlBasis: 'broker-fill', feesUsd: 0.66 },
  { mode: 'live', optionSymbol: 'XLF260930C00058000', contracts: 1,
    openTs: ET('2026-08-25T10:50:00-04:00'), closeTs: ET('2026-08-26T09:45:00-04:00'),
    entryBasisPremium: 1.16, pnlBasis: 'broker-fill', feesUsd: 0.7 },
  { mode: 'live', optionSymbol: 'BULL261002C00009000', contracts: 1,
    openTs: ET('2026-08-25T10:50:00-04:00'), closeTs: ET('2026-08-27T11:03:00-04:00'),
    entryBasisPremium: 0.71, pnlBasis: 'broker-fill', feesUsd: 0.7 },
];

describe('TRA-4506 AC4 — the dated trade-fee operand', () => {
  it('dates each fill\'s share of the round-trip fee on the fill\'s own day', () => {
    // NVTS exit 0.33 + XLF entry 0.35 + BULL entry 0.35.
    expect(datedOptionTradeFeesOverSpan(V0NNI_LOTS, '2026-08-24', '2026-08-25', etDate))
      .toEqual({ feeUsd: -1.03, reason: null });
  });

  it('allocates a lot\'s fees exactly once across its life', () => {
    let total = 0;
    for (const [a, b] of [['2026-08-21', '2026-08-24'], ['2026-08-24', '2026-08-25'],
      ['2026-08-25', '2026-08-26'], ['2026-08-26', '2026-08-27']]) {
      total += datedOptionTradeFeesOverSpan(V0NNI_LOTS, a, b, etDate).feeUsd ?? NaN;
    }
    expect(Math.round(total * 100) / 100).toBe(-2.06);
  });

  it('is all-or-nothing: a fill with no measured fee makes the span NOT MEASURED, not smaller', () => {
    expect(datedOptionTradeFeesOverSpan(ADMIN_LOTS, '2026-08-25', '2026-08-26', etDate))
      .toEqual({ feeUsd: null, reason: 'lot-fees-unmeasured' });
  });
});

/** A live broker-shaped row as the writer stamped it (pre-TRA-4506: no fee key). */
const liveRow = (date: string, over: Partial<DailySnapshot>): DailySnapshot => ({
  date,
  openingEquity: 0,
  closingEquity: 0,
  openingEquityBasis: 'broker-prev-eod-balance',
  closingEquityBasis: 'broker-eod-balance',
  dailyPnl: 0,
  optionsPnl: 0,
  optionsDailyPnl: 0,
  optionsDailyPnlSource: 'journal',
  combinedPnl: 0,
  netCashFlowUsd: 0,
  stockLegBasis: 'zero-probe-agrees',
  stockLegProbeUsd: 0,
  trades: 0,
  ...over,
});

describe('TRA-4506 — the three RED dates on the route, re-read', () => {
  it('admin 2026-09-03: the $10 fee is an operand, the residual is −0.12', () => {
    const rows = [
      liveRow('2026-09-02', { closingEquity: 438.06 }),
      liveRow('2026-09-03', {
        openingEquity: 438.06, closingEquity: 427.94, combinedPnl: -10.12,
        stockLegBasis: 'zero-probe-disagrees', stockLegProbeUsd: -10.12,
        openOptionMarkUsd: 0, openOptionMarkDeltaUsd: 0,
      }),
    ];
    const ops = buildStockLegProbeReadOperands({
      dates: rows.map(r => r.date),
      cashEvents: [{ date: '2026-09-03', type: 'fee', amount: -10 }],
      marks: { '2026-09-02': { costBasisUsd: 0, positionCount: 0 }, '2026-09-03': { costBasisUsd: 0, positionCount: 0 } },
      lots: [],
      etDate,
    });
    const r = reconcilePnl(rows, new Map(), null, null, null, null, null, null, 'live', null, ops);
    const d = r.days.find(x => x.date === '2026-09-03')!;
    expect(d.stockLegProbeRowUsd).toBe(-10.12);
    expect(d.stockLegProbeBrokerFeeUsd).toBe(-10);
    expect(d.stockLegProbeUsd).toBe(-0.12);
    expect(r.stockLegProbeOffendingDates).not.toContain('2026-09-03');
  });

  it('never books the fee twice: a v1-era flow already carrying it, or a writer that stamped it', () => {
    const ops = buildStockLegProbeReadOperands({
      dates: ['2026-09-02', '2026-09-03'],
      cashEvents: [{ date: '2026-09-03', type: 'fee', amount: -10 }],
      marks: null,
      lots: null,
      etDate,
    });
    const v1 = reconcilePnl([
      liveRow('2026-09-02', {}),
      liveRow('2026-09-03', { netCashFlowUsd: -10, stockLegProbeUsd: -0.12 }),
    ], new Map(), null, null, null, null, null, null, 'live', null, ops);
    expect(v1.days[1].stockLegProbeBrokerFeeUsd).toBeNull();
    expect(v1.days[1].stockLegProbeUsd).toBe(-0.12);
    const stamped = reconcilePnl([
      liveRow('2026-09-02', {}),
      liveRow('2026-09-03', { stockLegProbeBrokerFeeUsd: -10, stockLegProbeUsd: -0.12 }),
    ], new Map(), null, null, null, null, null, null, 'live', null, ops);
    expect(stamped.days[1].stockLegProbeBrokerFeeUsd).toBe(-10);
    expect(stamped.days[1].stockLegProbeUsd).toBe(-0.12);
  });

  it('admin 2026-08-26: restated to the journal lot and re-marked on it, reads −0.17', () => {
    const rows = [
      liveRow('2026-08-24', { openOptionMarkUsd: -20.5 }),
      liveRow('2026-08-25', { openOptionMarkUsd: -13.5, openOptionMarkDeltaUsd: 7, stockLegProbeUsd: -0.43 }),
      // As the boot restatement leaves it: optionsDaily moved −15.24 → −7, the
      // writer's probe (stamped off −15.24) untouched.
      liveRow('2026-08-26', {
        openingEquity: 625.13, closingEquity: 604.96, combinedPnl: -20.17,
        optionsDailyPnl: -7, optionsDailyPnlSource: 'journal-restated',
        optionsDailyPnlBeforeRestatement: -15.24, optionsDailyPnlRestatedBy: 'TRA-4506',
        openOptionMarkUsd: -21, openOptionMarkDeltaUsd: -7.5,
        stockLegBasis: 'zero-probe-disagrees', stockLegProbeUsd: 2.57,
      }),
    ];
    const ops = buildStockLegProbeReadOperands({
      dates: rows.map(r => r.date), cashEvents: [], marks: ADMIN_MARKS, lots: ADMIN_LOTS, etDate,
    });
    const r = reconcilePnl(rows, new Map(), null, null, null, null, null, null, 'live', null, ops);
    const d = r.days.find(x => x.date === '2026-08-26')!;
    expect(d.optionsDaily).toBe(-7);
    expect(d.optionsDailyPnlBeforeRestatement).toBe(-15.24);
    expect(d.openOptionMarkBasisShiftUsd).toBe(-5.5);
    // RIG lot B's exit fee is unmeasured (an unrestated import), so AC4 abstains.
    expect(d.stockLegProbeTradeFeeUsd).toBeNull();
    expect(d.stockLegProbeTradeFeeReason).toBe('lot-fees-unmeasured');
    expect(d.stockLegProbeUsd).toBe(-0.17);
    expect(r.stockLegProbeOffendingDates).not.toContain('2026-08-26');
    // The day the lot was HELD across is untouched by the shift.
    expect(r.days.find(x => x.date === '2026-08-25')!.openOptionMarkBasisShiftUsd).toBe(0);
  });

  it('v0nni 2026-08-25: three fills of fee dust are an operand, the residual is −0.31', () => {
    const rows = [
      liveRow('2026-08-24', { openOptionMarkUsd: -14 }),
      liveRow('2026-08-25', {
        openingEquity: 385.56, closingEquity: 397.22, combinedPnl: 11.66, optionsDailyPnl: -5,
        openOptionMarkUsd: 4, openOptionMarkDeltaUsd: 18,
        stockLegBasis: 'zero-probe-disagrees', stockLegProbeUsd: -1.34,
      }),
    ];
    const ops = buildStockLegProbeReadOperands({
      dates: rows.map(r => r.date), cashEvents: [], marks: null, lots: V0NNI_LOTS, etDate,
    });
    const r = reconcilePnl(rows, new Map(), null, null, null, null, null, null, 'live', null, ops);
    const d = r.days[1];
    expect(d.stockLegProbeTradeFeeUsd).toBe(-1.03);
    expect(d.openOptionMarkBasisShiftReason).toBe('mark-not-captured');
    expect(d.stockLegProbeUsd).toBe(-0.31);
    expect(r.stockLegProbeOffendingDates).toEqual([]);
  });

  it('never manufactures a probe on a row the writer did not measure', () => {
    const ops = buildStockLegProbeReadOperands({
      dates: ['2026-09-02', '2026-09-03'],
      cashEvents: [{ date: '2026-09-03', type: 'fee', amount: -10 }],
      marks: null, lots: [], etDate,
    });
    const r = reconcilePnl([
      liveRow('2026-09-02', {}),
      liveRow('2026-09-03', { stockLegProbeUsd: null, stockLegBasis: 'zero-probe-not-measured' }),
    ], new Map(), null, null, null, null, null, null, 'live', null, ops);
    expect(r.days[1].stockLegProbeUsd).toBeNull();
  });
});

describe('TRA-4506 AC1 — the writer stamps the fee operand', () => {
  const base = {
    date: '2026-09-03',
    optionsDailyPnl: 0,
    balanceByDate: { '2026-09-02': 438.06, '2026-09-03': 427.94 },
    optionMarkUsdByDate: { '2026-09-02': 0, '2026-09-03': 0 },
  };
  it('subtracts it from the probe and writes it beside the probe', () => {
    const r = shapeLiveRecordedRow({
      ...base,
      override: { prevDate: '2026-09-02', prevBalance: 438.06, netCashFlow: 0, combinedPnl: -10.12, brokerFeeUsd: -10 },
    });
    expect(r.stockLegProbeBrokerFeeUsd).toBe(-10);
    expect(r.stockLegProbeUsd).toBe(-0.12);
    expect(r.stockLegBasis).toBe('zero-probe-agrees');
  });
  it('writes the key as `null` when the record could not type the fee', () => {
    const r = shapeLiveRecordedRow({
      ...base,
      override: { prevDate: '2026-09-02', prevBalance: 438.06, netCashFlow: 0, combinedPnl: -10.12 },
    });
    expect('stockLegProbeBrokerFeeUsd' in r).toBe(true);
    expect(r.stockLegProbeBrokerFeeUsd).toBeNull();
    expect(r.stockLegProbeUsd).toBe(-10.12);
  });
});

describe('TRA-4506 AC2 — the named restatement', () => {
  const census = new Map<string, JournalDayCloses>([
    ['2026-08-26', { closes: 1, partialCloses: 0, realizedPnlUsd: -7.000000000000001 }],
  ]);
  const row = (over: Partial<DailySnapshot> = {}): DailySnapshot =>
    liveRow('2026-08-26', { optionsDailyPnl: -15.24, ...over });

  it('applies only while the row holds `before` AND the journal states `after`', () => {
    expect(planOptionsDailyPnlRestatements('admin', [row()], census)).toEqual({
      apply: [{ date: '2026-08-26', before: -15.24, after: -7, ticket: 'TRA-4506' }],
      refused: [],
    });
    expect(planOptionsDailyPnlRestatements('v0nni', [row()], census).apply).toEqual([]);
  });

  it('refuses a row someone else moved, and a journal that no longer agrees', () => {
    expect(planOptionsDailyPnlRestatements('admin', [row({ optionsDailyPnl: -12 })], census).refused)
      .toEqual([{ date: '2026-08-26', ticket: 'TRA-4506', reason: 'row-moved' }]);
    const moved = new Map([['2026-08-26', { closes: 1, partialCloses: 0, realizedPnlUsd: -7.24 }]]);
    expect(planOptionsDailyPnlRestatements('admin', [row()], moved).refused)
      .toEqual([{ date: '2026-08-26', ticket: 'TRA-4506', reason: 'journal-disagrees' }]);
  });

  it('is silent once applied, and the restated row stays journal-authoritative', () => {
    const done = row({ optionsDailyPnl: -7, optionsDailyPnlSource: 'journal-restated' });
    expect(planOptionsDailyPnlRestatements('admin', [done], census)).toEqual({ apply: [], refused: [] });
    expect(isJournalAuthoritativeSource('journal-restated')).toBe(true);
  });

  it('re-books a broker-override report\'s options leg WITHOUT touching its broker combinedPnl', () => {
    const report = {
      optionsPnl: -15.24, realizedPnl: 0, combinedPnl: -20.17, pnlSource: 'tradier-balance',
      markdown: '| Options P&L | -15.24 |\n| **Combined P&L** | **-20.17** |',
    };
    const p = patchEodReportOptionsPnl(report, -7);
    expect(p.optionsPnl).toBe(-7);
    expect(p.combinedPnl).toBe(-20.17);
    expect(p.markdown).toBe('| Options P&L | -7.00 |\n| **Combined P&L** | **-20.17** |');
    // An engine-sourced report still recomputes, exactly as before.
    expect(patchEodReportOptionsPnl({ ...report, pnlSource: undefined }, -7).combinedPnl).toBe(-7);
  });
});
