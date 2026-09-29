// TRA-OTM-UNBLOCK — a structural zero on the DEMO OTM entry path.
//
// The TRA-4894 real-fill arm is ANDed onto the tape verdict. A demo row is
//    never a broker fill, so on the DEMO branch `nRealFill >= 40` can never
//    hold and every demo OTM candidate refuses as
//    `insufficient_real_fill_evidence`, forever. The demo branch now decides on
//    the pooled arm (`requireRealFill: false`); live keeps the conjunction.

import { describe, expect, it } from 'vitest';
import {
  buildTapeExpectancyTable,
  tapeExpectancyVerdict,
} from './option-tape-expectancy.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import type { CostGateConfig } from './option-cost-gate.js';

const OTM = 'single_leg_otm';
const T0 = 1_700_000_000_000;
const BAR: CostGateConfig = {
  optionsCost: { commissionR: 0.0036, makerAdjustedSpreadCrossR: 0.235 },
  equityCost: { commissionR: 0, makerAdjustedSpreadCrossR: 0.02 },
  safetyMarginR: 0.2,
  optionsMinGrossR: 0.3,
};

/** A closed demo (mid-booked, NOT broker-fill) OTM row. `realizedR` is premium R. */
function demoRow(delta: number, realizedR: number): OptionTradeJournalRecord {
  return {
    structure: OTM,
    outcome: realizedR >= 0 ? 'WIN' : 'LOSS',
    entryDelta: delta,
    realizedR,
    closeTs: T0,
    mode: 'demo',
    contracts: 1,
  } as unknown as OptionTradeJournalRecord;
}

/** n rows alternating around `mean` (premium R) with a small spread. */
function cell(delta: number, mean: number, n = 60, d = 0.05): OptionTradeJournalRecord[] {
  return Array.from({ length: n }, (_, i) => demoRow(delta, mean + (i % 2 === 0 ? d : -d)));
}

describe('tapeExpectancyVerdict — requireRealFill', () => {
  const table = buildTapeExpectancyTable(
    [...cell(0.52, 0.3), ...cell(0.35, -0.2)],
    { windowDays: null, nowMs: T0, config: BAR },
  );

  it('DEFAULT (live posture): a strong mid-booked cell with 0 real fills refuses on the real-fill arm', () => {
    const v = tapeExpectancyVerdict({ structure: OTM, delta: 0.52 }, table, BAR);
    expect(v.admit).toBe(false);
    expect(v.reasonCode).toBe('insufficient_real_fill_evidence');
    expect(v.nRealFill).toBe(0);
  });

  it('DEMO (requireRealFill:false): the same cell admits on the pooled arm', () => {
    const v = tapeExpectancyVerdict({ structure: OTM, delta: 0.52 }, table, BAR, {
      requireRealFill: false,
    });
    expect(v.lowerCI95!).toBeGreaterThanOrEqual(v.barR);
    expect(v.admit).toBe(true);
    expect(v.reasonCode).toBeNull();
  });

  it('DEMO does not rescue a measured loser', () => {
    const v = tapeExpectancyVerdict({ structure: OTM, delta: 0.35 }, table, BAR, {
      requireRealFill: false,
    });
    expect(v.admit).toBe(false);
    expect(v.reasonCode).toBe('gross_negative');
  });

  it('DEMO does not rescue an unmeasured cell', () => {
    const v = tapeExpectancyVerdict({ structure: OTM, delta: 0.25 }, table, BAR, {
      requireRealFill: false,
    });
    expect(v.admit).toBe(false);
    expect(v.reasonCode).toBe('insufficient_evidence');
  });
});
