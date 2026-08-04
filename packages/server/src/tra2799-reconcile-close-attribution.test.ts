import { describe, it, expect } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OptionPosition } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// ─── TRA-2799 follow-up: does the reconcile close's ESTIMATE actually get
//     restated to broker truth?
//
// `closeBrokerFlatPosition` books realized P&L off the last known mark and its
// docblock states the estimate is restated later, "exactly as it does for the
// imported branch's `recordImportedFill` estimate".
//
// The imported branch's restatement is not automatic — it works because
// `recordImportedFill` routes through `applyRealtimeImportedPnl`, which ALSO
// records the amount into `realtimeImportedPnlByDate`. The EOD reconcile then
// computes `netAdded = brokerTruth − consumeRealtimeImportedPnl()` and only
// adds the difference (`index.ts`, TRA-367 comment).
//
// `closeBrokerFlatPosition` calls `closeOption`, whose engine-row branch books
// via `bookRealizedPnl` and never touches that map. These tests pin what that
// means for the dollars on the three rows this ticket was filed about.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const AGED = TRADING_TIME - 6 * 60 * 60 * 1000;

function buildTradierPosition(
  overrides: Partial<TradierOpenOptionPosition> = {},
): TradierOpenOptionPosition {
  return {
    optionSymbol: 'QQQ260515C00500000',
    underlying: 'QQQ',
    optionType: 'call',
    strike: 500,
    expiration: '2026-05-15',
    contracts: 1,
    premiumPaid: 1.6,
    acquiredAt: TRADING_TIME,
    ...overrides,
  };
}

/** The SPY 820C row from the ticket: 2 contracts, paid 0.07, marked 0.44. */
function engineRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'opt-spy-820c',
    symbol: 'SPY',
    optionSymbol: 'SPY260904C00820000',
    optionType: 'call',
    strike: 820,
    expiration: '2026-09-04',
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 0.07,
    currentPremium: 0.44,
    tp1Premium: 0.14,
    tp1Hit: false,
    stopLossPremium: 0.035,
    peakPremium: 0.44,
    trailingActive: true,
    trailingStopPremium: 0.69,
    underlyingEntryPrice: 640,
    openedAt: AGED,
    signalId: 'sig-otm-1',
    signalType: 'otm_mispricing',
    mode: 'live',
    tradierEnv: 'production',
    ...overrides,
  } as OptionPosition;
}

function seed(rows: OptionPosition[]) {
  const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
  acct.importSnapshot({
    openOptions: rows,
    closedOptions: [],
    optionsPnl: 0,
    optionsPnlByMode: { demo: 0, live: 0 },
    dailyCount: 1,
    currentDayKey: '2026-08-04',
    cash: 20_000,
    equity: 25_000,
  });
  return acct;
}

describe('TRA-2799 follow-up — reconcile-close P&L attribution', () => {
  it('books the mark as realized live P&L (+$74 on the SPY 820C row)', () => {
    const acct = seed([engineRow()]);
    const closed = acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');
    expect(closed).not.toBeNull();
    // (0.44 − 0.07) × 2 × 100 = +$74.00 booked into the LIVE realized bucket.
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(74, 5);
    // Paper cash credited at the mark: 0.44 × 2 × 100 = $88 for a position the
    // broker was not holding, against $14 of premium actually debited at open.
    expect(acct.getStateForMode('live').optionsCash).toBeCloseTo(20_000 + 88, 5);
  });

  it('registers the estimate in the realtime map so the EOD reconcile can subtract it', () => {
    const acct = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(74, 5);

    // This map is exactly what `index.ts` drains into `realtimeOffset` before
    // computing `netAdded = brokerTruth − realtimeOffset`. It must carry the
    // estimate; an empty map is the defect (nothing to subtract).
    let offset = 0;
    for (const v of acct.consumeRealtimeImportedPnl().values()) offset += v;
    expect(offset).toBeCloseTo(74, 5);
  });

  it('CONTROL registering does not double-book the live bucket', () => {
    const acct = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');
    // Recorded for dedupe, but the bucket moved exactly once.
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(74, 5);
  });

  it('broker closed it out-of-band: EOD restates to broker truth (no double-count)', () => {
    const acct = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');

    // EOD: Tradier history reports the real fill for this contract, say +$70.
    const brokerTruth = 70;
    let offset = 0;
    for (const v of acct.consumeRealtimeImportedPnl().values()) offset += v;
    const netAdded = brokerTruth - offset; // index.ts TRA-367
    acct.addReconciledTradierPnl(netAdded);

    // Broker truth alone: estimate($74) + (70 − 74) = $70. Before the fix this
    // was $144 — the full broker total stacked on an unsubtracted estimate.
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(brokerTruth, 5);
  });

  it('the open never filled at the broker: EOD backs the estimate out to $0', () => {
    const acct = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');

    // A mirror that never really filled (a cause the fix names) leaves NO
    // Tradier history row, so the EOD reconcile adds nothing at all.
    let offset = 0;
    for (const v of acct.consumeRealtimeImportedPnl().values()) offset += v;
    const netAdded = 0 - offset;
    if (netAdded !== 0) acct.addReconciledTradierPnl(netAdded);

    // netAdded = 0 − 74 = −74 backs the estimate out. Before the fix the
    // offset was 0, so +$74 of profit on a contract that never existed stood
    // permanently with no path that could remove it.
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(0, 5);
  });

  // Totals here are computed from (mark − premiumPaid) × contracts × 100 using
  // the premiums/marks as displayed. The dashboard showed +$74 / +$186 / +$374
  // (~$634); the arithmetic off the two-decimal premiums gives +$74 / +$184 /
  // +$372 = $630, the small gap being display rounding of the premium column.
  // Either way the order of magnitude is the point: ~$630 of realized P&L
  // booked against contracts the broker was not holding.
  it('scaled to the three rows on the ticket: ~$630 of unbacked realized P&L', () => {
    const acct = seed([
      engineRow(), // +$74.00
      engineRow({
        id: 'opt-spy-816c',
        optionSymbol: 'SPY260904C00816000',
        strike: 816,
        contracts: 4,
        contractsRemaining: 4,
        premiumPaid: 0.08,
        currentPremium: 0.54, // (0.54−0.08)×4×100 = +$184.00
      }),
      engineRow({
        id: 'opt-aapl-280p',
        symbol: 'AAPL',
        optionSymbol: 'AAPL260904P00280000',
        optionType: 'put',
        strike: 280,
        contracts: 4,
        contractsRemaining: 4,
        premiumPaid: 1.0,
        currentPremium: 1.93, // (1.93−1.00)×4×100 = +$372.00
      }),
    ]);
    for (const id of ['opt-spy-820c', 'opt-spy-816c', 'opt-aapl-280p']) {
      expect(acct.closeBrokerFlatPosition(id, 'broker flat')).not.toBeNull();
    }
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(74 + 184 + 372, 5);
    // All of it is registered for EOD restatement, so none of it can strand.
    let offset = 0;
    for (const v of acct.consumeRealtimeImportedPnl().values()) offset += v;
    expect(offset).toBeCloseTo(74 + 184 + 372, 5);
  });

  it('the two-sweep + age guards behave as documented (sanity, not the defect)', () => {
    const acct = seed([engineRow()]);
    const unrelated = [buildTradierPosition()];
    // First sweep: absence recorded, row kept.
    acct.reconcileTradierPositions(unrelated, 'live');
    expect(acct.getStateForMode('live').openOptions.some(o => o.id === 'opt-spy-820c')).toBe(true);
    // Second consecutive miss closes it.
    acct.reconcileTradierPositions(unrelated, 'live');
    expect(acct.getStateForMode('live').openOptions.some(o => o.id === 'opt-spy-820c')).toBe(false);
  });
});
