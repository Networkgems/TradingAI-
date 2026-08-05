/**
 * TRA-2693 — the detector for "a REAL option position is open and nothing is
 * evaluating its exits".
 *
 * `checkExits`'s per-position mode filter (TRA-231) is correct and stays: a
 * demo-mode tick must not close a real broker position out from under the user.
 * But its skip was a bare `continue` with no log line, so a `mode: live`
 * position held while the engine sits in demo had its SL / TP1 / trailing stop /
 * ATR chandelier / profit-lock silently not evaluated, with no detector
 * anywhere. `getModeSkippedLiveOptionSymbols()` is what the engine alerts on.
 *
 * Both directions are asserted on purpose. A control that only proves the
 * detector CAN fire cannot tell a strand from the normal case, and the normal
 * case here is loud: a live engine skips every demo row on every tick, so a
 * detector that counted those would page constantly and train the operator to
 * ignore it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

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
    theo: 1.30,
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

function account(): PaperOptionsAccount {
  return new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
}

describe('TRA-2693 — unmanaged live option detector', () => {
  it('KNOWN-BAD: a demo-mode pass over a live position reports it as skipped', () => {
    const acct = account();
    const live = acct.openOptionFromCandidate(buildSignal(), 'live');
    expect(live).not.toBeNull();
    expect(live!.mode).toBe('live');

    // The strand: the engine has fallen back to demo (boot-arm miss, manual
    // flip, operator rewrite — the detector does not care which) while the real
    // position is still open at the broker.
    acct.checkExits(new Map([['AAPL', 200]]), new Map([['AAPL240705C00200000', 1.0]]), 'demo');

    expect(acct.getModeSkippedLiveOptionSymbols()).toEqual(['AAPL240705C00200000']);
  });

  it('KNOWN-GOOD: a live-mode pass over the same live position reports nothing', () => {
    const acct = account();
    acct.openOptionFromCandidate(buildSignal(), 'live');

    acct.checkExits(new Map([['AAPL', 200]]), new Map([['AAPL240705C00200000', 1.0]]), 'live');

    expect(acct.getModeSkippedLiveOptionSymbols()).toEqual([]);
  });

  it('KNOWN-GOOD: a live-mode pass skipping DEMO rows reports nothing', () => {
    // The mirror case, and the one that decides whether this alert is usable.
    // A live engine skips the whole paper book on every single tick; folding
    // those into the count would make the alert fire always and mean nothing.
    const acct = account();
    acct.openOptionFromCandidate(buildSignal(), 'demo');

    acct.checkExits(new Map([['AAPL', 200]]), new Map([['AAPL240705C00200000', 1.0]]), 'live');

    expect(acct.getModeSkippedLiveOptionSymbols()).toEqual([]);
  });

  it('the reading is per-pass, not a latch — a demo pass then a live pass clears it', () => {
    // Without the clear at the top of `checkExits` the array is a fossil: the
    // operator repairs the mode, the engine resumes managing the position, and
    // the detector keeps paging about a strand that ended.
    const acct = account();
    acct.openOptionFromCandidate(buildSignal(), 'live');
    const prices = new Map([['AAPL', 200]]);
    const marks = new Map([['AAPL240705C00200000', 1.0]]);

    acct.checkExits(prices, marks, 'demo');
    expect(acct.getModeSkippedLiveOptionSymbols()).toHaveLength(1);

    acct.checkExits(prices, marks, 'live');
    expect(acct.getModeSkippedLiveOptionSymbols()).toEqual([]);
  });

  it('reports EVERY skipped live position, not just the first', () => {
    const acct = account();
    acct.openOptionFromCandidate(buildSignal(), 'live');
    acct.openOptionFromCandidate(
      buildSignal({ id: 'sig-2', symbol: 'TSLA', optionSymbol: 'TSLA240705C00560000', strike: 560 }),
      'live',
    );

    acct.checkExits(new Map([['AAPL', 200], ['TSLA', 560]]), new Map(), 'demo');

    expect([...acct.getModeSkippedLiveOptionSymbols()].sort()).toEqual([
      'AAPL240705C00200000',
      'TSLA240705C00560000',
    ]);
  });
});
