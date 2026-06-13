import { describe, it, expect } from 'vitest';
import { PASSED_LIVE_ENTRIES, isLiveEntryGatePassed } from './capital-gate-manifest.js';

describe('capital-gate-manifest', () => {
  it('ships with an empty allow-list (no strategy has cleared the OOS gate)', () => {
    expect(PASSED_LIVE_ENTRIES).toHaveLength(0);
  });

  it('gates tsmom_majors OFF until a quant PASS registers it (TRA-821)', () => {
    // The candidate is built + validated under TRA-821 but must NOT be live-
    // entry permitted until QuantTrader registers a keeper-gate PASS. The gate
    // is closed by default, so the crypto candidate is display-only.
    expect(isLiveEntryGatePassed('tsmom_majors')).toBe(false);
  });

  it('gates the stock candidates OFF too (sma200_*) — generic by strategy id', () => {
    expect(isLiveEntryGatePassed('sma200_pullback')).toBe(false);
    expect(isLiveEntryGatePassed('sma200_reclaim')).toBe(false);
  });

  it('returns false for any unknown strategy id (closed by default)', () => {
    expect(isLiveEntryGatePassed('definitely_not_a_strategy')).toBe(false);
  });
});
