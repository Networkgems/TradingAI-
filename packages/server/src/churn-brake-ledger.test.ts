// TRA-1481 (parent TRA-1408) — churn-brake telemetry ledger tests.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearChurnBrakeLedger,
  recordChurnBrakeOpen,
  recordChurnBrakeOpenRejected,
  recordChurnBrakeDcaHalt,
  summarizeChurnBrake,
} from './churn-brake-ledger.js';

describe('churn-brake-ledger', () => {
  beforeEach(() => clearChurnBrakeLedger());

  it('starts empty', () => {
    const s = summarizeChurnBrake();
    expect(s.opensRejected).toBe(0);
    expect(s.dcaAddsHalted).toBe(0);
    expect(s.dcaAddsHaltedByLeg).toEqual({ equity: 0, option: 0 });
    expect(s.trackedSymbols).toBe(0);
    expect(s.openCountsBySymbol).toEqual([]);
    expect(s.lastOpenRejectAt).toBeNull();
    expect(s.lastDcaHaltAt).toBeNull();
    expect(s.recent).toEqual([]);
  });

  it('counts per-name session opens and normalizes the symbol', () => {
    recordChurnBrakeOpen('ampg', '2026-07-08');
    recordChurnBrakeOpen('AMPG', '2026-07-08');
    recordChurnBrakeOpen('gis', '2026-07-08');
    const s = summarizeChurnBrake();
    expect(s.trackedSymbols).toBe(2);
    const ampg = s.openCountsBySymbol.find((r) => r.symbol === 'AMPG');
    expect(ampg).toEqual({ symbol: 'AMPG', etDay: '2026-07-08', count: 2 });
    // busiest-first ordering
    expect(s.openCountsBySymbol[0]!.symbol).toBe('AMPG');
  });

  it('resets a name`s open count at the ET-day roll (same-session semantics)', () => {
    recordChurnBrakeOpen('AMPG', '2026-07-08');
    recordChurnBrakeOpen('AMPG', '2026-07-08');
    recordChurnBrakeOpen('AMPG', '2026-07-09'); // new session → reset to 1
    const ampg = summarizeChurnBrake().openCountsBySymbol.find((r) => r.symbol === 'AMPG');
    expect(ampg).toEqual({ symbol: 'AMPG', etDay: '2026-07-09', count: 1 });
  });

  it('records opens rejected by the cap with per-symbol counts + last timestamp', () => {
    recordChurnBrakeOpenRejected('AMPG', 3, 3, 1000);
    recordChurnBrakeOpenRejected('AMPG', 4, 3, 2000);
    recordChurnBrakeOpenRejected('GIS', 3, 3, 3000);
    const s = summarizeChurnBrake();
    expect(s.opensRejected).toBe(3);
    expect(s.opensRejectedBySymbol[0]).toEqual({ symbol: 'AMPG', count: 2 });
    expect(s.lastOpenRejectAt).toBe(3000);
    const rej = s.recent.filter((e) => e.kind === 'open_rejected');
    expect(rej).toHaveLength(3);
    expect(rej[0]).toMatchObject({ symbol: 'AMPG', detail: '3/3' });
  });

  it('records DCA halts split by leg', () => {
    recordChurnBrakeDcaHalt('RIVN', 'equity', -120.5, 1000);
    recordChurnBrakeDcaHalt('AMPG', 'option', -30.25, 2000);
    recordChurnBrakeDcaHalt('AMPG', 'option', -31, 3000);
    const s = summarizeChurnBrake();
    expect(s.dcaAddsHalted).toBe(3);
    expect(s.dcaAddsHaltedByLeg).toEqual({ equity: 1, option: 2 });
    expect(s.lastDcaHaltAt).toBe(3000);
    const halts = s.recent.filter((e) => e.kind === 'dca_halted');
    expect(halts).toHaveLength(3);
    expect(halts[0]).toMatchObject({ symbol: 'RIVN', leg: 'equity', detail: '-120.50' });
  });

  it('caps the recent-events tail at 50 while totals stay complete', () => {
    for (let i = 0; i < 60; i++) recordChurnBrakeOpenRejected('SPY', i, 3, i);
    const s = summarizeChurnBrake();
    expect(s.opensRejected).toBe(60);
    expect(s.recent).toHaveLength(50);
  });
});
