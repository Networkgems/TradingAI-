import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordWheelBookSnapshot,
  clearWheelBookSnapshot,
  buildWheelPromotionGateSummary,
} from './wheel-promotion-gate-store.js';
import { clearWheelIvDecisions } from './wheel-iv-entry-filter.js';
import type { WheelBookPosition } from './wheel-vol-stress-harness.js';

const csp: WheelBookPosition = {
  symbol: 'SPY', kind: 'cash_secured_put', contracts: 1, shares: 0,
  strike: 100, spot: 105, creditPerShare: 1.5, costBasisPerShare: 0, atmIv: 0.2, dte: 30,
};

describe('buildWheelPromotionGateSummary', () => {
  beforeEach(() => {
    clearWheelBookSnapshot();
    clearWheelIvDecisions();
  });

  it('reports an empty book (pending gate) when no snapshot has been recorded', () => {
    const s = buildWheelPromotionGateSummary({ now: 1_000, ivFilterEnabled: false });
    expect(s.bookSnapshotAgeMs).toBeNull();
    expect(s.stress.positionCount).toBe(0);
    expect(s.gate.promotionEligible).toBe(false);
    expect(s.ivFilterEnabled).toBe(false);
  });

  it('re-prices the recorded book under the stress suite', () => {
    recordWheelBookSnapshot([csp], 1_000_000, 1_000);
    const s = buildWheelPromotionGateSummary({ now: 1_000, ivFilterEnabled: true });
    expect(s.bookSnapshotAgeMs).toBe(0);
    expect(s.stress.positionCount).toBe(1);
    expect(s.stress.definedRiskBreachCount).toBe(0); // CSP holds defined risk
    expect(s.ivFilterEnabled).toBe(true);
    expect(s.ivEntries.enabled).toBe(true);
  });

  it('treats a stale snapshot (past the TTL) as an empty book', () => {
    recordWheelBookSnapshot([csp], 1_000_000, 0);
    const s = buildWheelPromotionGateSummary({ now: 60 * 60_000 }); // 1h later, past 30m TTL
    expect(s.bookSnapshotAgeMs).toBeNull();
    expect(s.stress.positionCount).toBe(0);
  });
});
