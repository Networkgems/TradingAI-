import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

// TRA-2233 — marketable(bid) valuation on the demo/paper book. These cover the
// account-level wiring: the new realizable state field, the DARK give-back basis
// switch, and demo close fills at the bid. The pure kernel is covered separately
// in marketable-open-mtm.test.ts.

// Inside an ET trading window (Tuesday 10:00 ET) so the open predicate passes.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-1',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    mark: 1.0,
    theo: 1.3,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Open a demo OTM call (6 contracts @ premiumPaid 1.0) and mark it to `mark`
 * via a non-triggering checkExits tick (1.0 < mark < TP1 1.50, > SL 0.80).
 */
function openAndMark(
  mark: number,
  config: ConstructorParameters<typeof PaperOptionsAccount>[0] = {},
): { acct: PaperOptionsAccount; id: string } {
  const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5, ...config });
  const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'demo', undefined, 200);
  expect(pos).not.toBeNull();
  expect(pos!.contracts).toBeGreaterThan(0);
  // Mark it via a tick that neither hits TP1 (1.50) nor the SL (0.80).
  acct.checkExits(new Map(), new Map([[pos!.optionSymbol!, mark]]), 'demo');
  expect(acct.getState().openOptions[0].currentPremium).toBeCloseTo(mark, 6);
  return { acct, id: pos!.id };
}

describe('openOptionsRealizablePnl (marketable MTM state field)', () => {
  it('haircuts the MID unrealized to the bid using the modeled fraction', () => {
    const { acct } = openAndMark(1.2, { marketableOpenMtm: { halfSpreadFrac: 0.1 } });
    const s = acct.getStateForMode('demo');
    // MID: (1.20 − 1.0) × 6 × 100 = 120.
    expect(s.openOptionsUnrealizedPnl).toBeCloseTo(120, 6);
    // Bid 1.20·(1−0.1)=1.08 → (1.08 − 1.0) × 6 × 100 = 48.
    expect(s.openOptionsRealizablePnl).toBeCloseTo(48, 6);
  });

  it('is computed even when the marketable BASIS flag is OFF (display reference)', () => {
    const { acct } = openAndMark(1.2, { marketableOpenMtm: { enabled: false, halfSpreadFrac: 0.1 } });
    const s = acct.getStateForMode('demo');
    expect(s.openOptionsRealizablePnl).toBeCloseTo(48, 6);
    expect(acct.getMarketableOpenMtmConfig().enabled).toBe(false);
  });

  it('equals the MID figure when the modeled fraction is 0', () => {
    const { acct } = openAndMark(1.2, { marketableOpenMtm: { halfSpreadFrac: 0 } });
    const s = acct.getStateForMode('demo');
    expect(s.openOptionsRealizablePnl).toBeCloseTo(s.openOptionsUnrealizedPnl!, 6);
  });
});

describe('give-back basis switch (dailyOptionsPnl)', () => {
  it('flag OFF → dailyOptionsPnl uses the MID open MTM (unchanged behavior)', () => {
    const { acct } = openAndMark(1.2, { marketableOpenMtm: { enabled: false, halfSpreadFrac: 0.1 } });
    // No realized today; daily = open MTM at MID = 120.
    expect(acct.getStateForMode('demo').dailyOptionsPnl).toBeCloseTo(120, 6);
  });

  it('flag ON → dailyOptionsPnl uses the marketable (bid) open MTM', () => {
    const { acct } = openAndMark(1.2, { marketableOpenMtm: { enabled: true, halfSpreadFrac: 0.1 } });
    // Daily = marketable open MTM = 48. This is the number the book give-back
    // peak reads via SignalEngine.computeBookMark — coordinating with TRA-2131.
    expect(acct.getStateForMode('demo').dailyOptionsPnl).toBeCloseTo(48, 6);
  });

  it('updateConfig can arm/disarm the basis at runtime', () => {
    const { acct } = openAndMark(1.2, { marketableOpenMtm: { enabled: false, halfSpreadFrac: 0.1 } });
    expect(acct.getStateForMode('demo').dailyOptionsPnl).toBeCloseTo(120, 6);
    acct.updateConfig({ marketableOpenMtm: { enabled: true, halfSpreadFrac: 0.1 } });
    expect(acct.getStateForMode('demo').dailyOptionsPnl).toBeCloseTo(48, 6);
  });
});

describe('demo close fills at the marketable bid', () => {
  it('flag ON → a manual close realizes at the bid, not the mid', () => {
    const { acct, id } = openAndMark(1.2, { marketableOpenMtm: { enabled: true, halfSpreadFrac: 0.1 } });
    const closed = acct.closeOption(id);
    expect(closed).not.toBeNull();
    // Bid 1.08 → (1.08 − 1.0) × 6 × 100 = 48.
    expect(closed!.pnl).toBeCloseTo(48, 6);
    expect(closed!.currentPremium).toBeCloseTo(1.08, 6);
  });

  it('flag OFF → a manual close still realizes at the mid (demoSlippagePct 0)', () => {
    const { acct, id } = openAndMark(1.2, { marketableOpenMtm: { enabled: false, halfSpreadFrac: 0.1 } });
    const closed = acct.closeOption(id);
    expect(closed).not.toBeNull();
    expect(closed!.pnl).toBeCloseTo(120, 6);
    expect(closed!.currentPremium).toBeCloseTo(1.2, 6);
  });

  it('flag ON but the legacy demoSlippagePct is superseded, not stacked', () => {
    const { acct, id } = openAndMark(1.2, {
      demoSlippagePct: 0.05,
      marketableOpenMtm: { enabled: true, halfSpreadFrac: 0.1 },
    });
    const closed = acct.closeOption(id);
    // Marketable bid 1.08 wins — NOT 1.20·(1−0.05)·(1−0.1). Single haircut.
    expect(closed!.currentPremium).toBeCloseTo(1.08, 6);
  });
});

describe('defaults', () => {
  it('is DARK by default (no config) — MID everywhere, realizable at the default fraction', () => {
    const { acct } = openAndMark(1.2);
    expect(acct.getMarketableOpenMtmConfig().enabled).toBe(false);
    const s = acct.getStateForMode('demo');
    // Basis stays MID.
    expect(s.dailyOptionsPnl).toBeCloseTo(120, 6);
    // Realizable uses the default measured fraction 0.134 → bid 1.20·0.866=1.0392
    // → (1.0392 − 1.0) × 6 × 100 = 23.52.
    expect(s.openOptionsRealizablePnl).toBeCloseTo(23.52, 4);
  });
});
