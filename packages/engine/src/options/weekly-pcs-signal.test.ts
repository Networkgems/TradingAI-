import { describe, it, expect } from 'vitest';
import {
  selectWeeklyPcs,
  settleWeeklyPcs,
  WEEKLY_PCS_DEFAULTS,
  type PcsPutQuote,
} from './weekly-pcs-signal.js';

// A synthetic QQQ put chain around a $500 spot. IVs are set so BS deltas span
// the OTM range; strikes are $1-wide (QQQ weeklies). bid/ask are realistic
// vertical-friendly quotes (short leg richer than the long wing).
function qqqPuts(spot: number): PcsPutQuote[] {
  const rows: PcsPutQuote[] = [];
  for (let k = spot - 60; k <= spot; k += 1) {
    // Deeper OTM → cheaper premium; a smile so far strikes carry a touch more IV.
    const otm = spot - k;
    const iv = 0.16 + otm * 0.0015;
    const mid = Math.max(0.05, 6 - otm * 0.09);
    rows.push({
      strike: k,
      optionType: 'put',
      bid: Number((mid - 0.05).toFixed(2)),
      ask: Number((mid + 0.05).toFixed(2)),
      smvVol: iv,
    });
  }
  return rows;
}

describe('selectWeeklyPcs', () => {
  it('selects a ~10-15Δ short put with a real 25-wide long wing and positive credit', () => {
    const sig = selectWeeklyPcs({ spot: 500, dteDays: 7, puts: qqqPuts(500) });
    expect(sig).not.toBeNull();
    const s = sig!;
    // Short delta lands inside the configured band.
    expect(s.shortDelta).toBeGreaterThanOrEqual(WEEKLY_PCS_DEFAULTS.shortPutDeltaBand[0]);
    expect(s.shortDelta).toBeLessThanOrEqual(WEEKLY_PCS_DEFAULTS.shortPutDeltaBand[1]);
    // 25-wide, defined risk, positive credit.
    expect(s.longStrike).toBe(s.shortStrike - 25);
    expect(s.width).toBe(25);
    expect(s.credit).toBeGreaterThan(0);
    expect(s.riskDollars).toBeCloseTo((25 - s.credit) * 100, 6);
    expect(s.entryCommission).toBeCloseTo(2 * 0.65, 6);
    expect(s.shortStrike).toBeLessThan(500); // OTM put
  });

  it('picks the strike closest to the target delta within the band', () => {
    const sig = selectWeeklyPcs({ spot: 500, dteDays: 7, puts: qqqPuts(500) })!;
    // Nudge the target up and the selected short strike should move (closer to ATM).
    const higher = selectWeeklyPcs({
      spot: 500,
      dteDays: 7,
      puts: qqqPuts(500),
      params: { ...WEEKLY_PCS_DEFAULTS, shortPutDeltaTarget: 0.15 },
    })!;
    expect(higher.shortStrike).toBeGreaterThanOrEqual(sig.shortStrike);
  });

  it('returns null when no put falls inside the delta band', () => {
    // Only deep-OTM (near-zero delta) strikes present.
    const puts = qqqPuts(500).filter((p) => p.strike <= 445);
    const sig = selectWeeklyPcs({ spot: 500, dteDays: 7, puts });
    expect(sig).toBeNull();
  });

  it('returns null when the long wing 25 below is missing from the chain', () => {
    const full = qqqPuts(500);
    const short = selectWeeklyPcs({ spot: 500, dteDays: 7, puts: full })!;
    const holed = full.filter((p) => p.strike !== short.shortStrike - 25);
    expect(selectWeeklyPcs({ spot: 500, dteDays: 7, puts: holed })).toBeNull();
  });

  it('returns null on a non-positive net credit (long ask ≥ short bid)', () => {
    const puts = qqqPuts(500).map((p) => ({ ...p, bid: 0.05, ask: 5 }));
    expect(selectWeeklyPcs({ spot: 500, dteDays: 7, puts })).toBeNull();
  });

  it('ignores call rows and rows with no usable IV', () => {
    const puts = qqqPuts(500);
    const polluted: PcsPutQuote[] = [
      ...puts,
      { strike: 480, optionType: 'call', bid: 3, ask: 3.1, smvVol: 0.2 },
      { strike: 470, optionType: 'put', bid: 1, ask: 1.1 }, // no IV
    ];
    const sig = selectWeeklyPcs({ spot: 500, dteDays: 7, puts: polluted });
    expect(sig).not.toBeNull();
    expect(sig!.shortStrike).toBeLessThan(500);
  });
});

describe('settleWeeklyPcs', () => {
  const sig = selectWeeklyPcs({ spot: 500, dteDays: 7, puts: qqqPuts(500) })!;

  it('keeps the full credit and pays no close comm when it expires worthless', () => {
    const s = settleWeeklyPcs(sig, 505); // spot well above short strike
    expect(s.spreadValueAtExpiry).toBe(0);
    expect(s.breached).toBe(false);
    expect(s.maxLoss).toBe(false);
    expect(s.pnl).toBeCloseTo(sig.credit * 100 - sig.entryCommission, 6);
    expect(s.R).toBeGreaterThan(0);
  });

  it('realizes a defined max loss when settled at/below the long strike', () => {
    const s = settleWeeklyPcs(sig, sig.longStrike - 5);
    expect(s.maxLoss).toBe(true);
    expect(s.breached).toBe(true);
    expect(s.spreadValueAtExpiry).toBe(sig.width);
    const expected = (sig.credit - sig.width) * 100 - sig.entryCommission - 2 * 0.65;
    expect(s.pnl).toBeCloseTo(expected, 6);
    // Loss is bounded to ~ −1R (plus commissions), never worse.
    expect(s.R).toBeGreaterThan(-1.2);
    expect(s.R).toBeLessThan(0);
  });

  it('settles a partial breach between the strikes (cash intrinsic)', () => {
    const mid = sig.shortStrike - sig.width / 2;
    const s = settleWeeklyPcs(sig, mid);
    expect(s.breached).toBe(true);
    expect(s.maxLoss).toBe(false);
    expect(s.spreadValueAtExpiry).toBeCloseTo(sig.width / 2, 6);
    expect(s.pnl).toBeLessThan(sig.credit * 100);
  });
});
