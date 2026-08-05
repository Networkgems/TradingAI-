/**
 * TRA-2890 (parent TRA-2873, mark axis) — one valuation source for the live
 * options screen.
 *
 * The TRA-2873 screenshots had THREE valuations of the same three contracts on
 * screen at once:
 *
 *   Tradier positions view (last trade)          $418.00   ← self-consistent
 *   TradingAI Options panel / Book Premium (mid) $439.00
 *   Tradier /balances `long_option_value`,
 *     mirrored into our Account Summary          $524.00   ← stale off-hours
 *
 * THE CALL: display surfaces value an OPEN LIVE position at the broker-tape
 * LAST TRADE (`OptionPosition.lastMark`, applied via the single shared rule
 * `displayOptionMark`), and the live Account Summary option rows derive from
 * the same book instead of mirroring `/balances`. Cost basis already
 * reconciles to broker `cost_basis` (TRA-2889), so live Gain/Loss equals
 * Tradier's positions view by construction: value $418.00, basis $464.00,
 * G/L −$46.00 = −9.91%. The RISK ENGINE — stops, trailing, the give-back
 * peak (`dailyOptionsPnl`), IV solves, close-limit defaults — stays on the
 * NBBO mid: a stale print on an illiquid contract must never fire or
 * suppress a real-money stop (and one bad sample must never latch the
 * monotonic book peak, TRA-2927).
 *
 * The discriminator this file pins: after the display marks land, the
 * DISPLAY figures move to last-trade while `dailyOptionsPnl` (the governor
 * basis) still reads the MID book. A broken split — display leaking into the
 * governor — makes the `dailyOptionsPnl` assertion fail at −$46 instead of
 * −$25.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import { computePortfolioGreeks } from './reports/portfolio-greeks.js';
import { displayOptionMark } from '@trading-app/shared';
import type { OtmMispricingSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// 10:00 ET on Tuesday 2026-08-04 — inside the trading window, ~31 DTE.
const TRADING_TIME = Date.parse('2026-08-04T14:00:00Z');

/** The three live contracts from the TRA-2873 screenshots. */
const BOOK = [
  {
    label: 'AAPL 2026-09-04 $280 P',
    optionSymbol: 'AAPL260904P00280000',
    underlying: 'AAPL',
    optionType: 'put' as const,
    strike: 280,
    contracts: 4,
    scannerMark: 0.995,
    /** Tradier `cost_basis / qty / 100`. */
    brokerCostPerShare: 1.04,
    /** Our NBBO mid at the screenshot instant. */
    midMark: 0.965,
    /** Tradier's positions-view per-share value (last trade). */
    lastTrade: 0.86,
    spot: 333.43,
  },
  {
    label: 'SPY 2026-09-04 $816 C',
    optionSymbol: 'SPY260904C00816000',
    underlying: 'SPY',
    optionType: 'call' as const,
    strike: 816,
    contracts: 4,
    scannerMark: 0.075,
    brokerCostPerShare: 0.08,
    midMark: 0.095,
    lastTrade: 0.13,
    spot: 741.69,
  },
  {
    label: 'SPY 2026-09-04 $820 C',
    optionSymbol: 'SPY260904C00820000',
    underlying: 'SPY',
    optionType: 'call' as const,
    strike: 820,
    contracts: 2,
    scannerMark: 0.065,
    brokerCostPerShare: 0.08,
    midMark: 0.075,
    lastTrade: 0.11,
    spot: 741.69,
  },
];

function buildSignal(o: (typeof BOOK)[number]): OtmMispricingSignal {
  return {
    id: `sig-${o.optionSymbol}`,
    symbol: o.underlying,
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: o.scannerMark,
    stopLoss: o.scannerMark * 0.8,
    takeProfit: o.scannerMark * 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: o.optionSymbol,
    optionType: o.optionType,
    strike: o.strike,
    expiration: '2026-09-04',
    mark: o.scannerMark,
    theo: o.scannerMark * 1.3,
    mispricingPct: -0.23,
    delta: o.optionType === 'put' ? -0.5 : 0.5,
  };
}

function buildBrokerPosition(o: (typeof BOOK)[number]): TradierOpenOptionPosition {
  return {
    optionSymbol: o.optionSymbol,
    underlying: o.underlying,
    optionType: o.optionType,
    strike: o.strike,
    expiration: '2026-09-04',
    contracts: o.contracts,
    premiumPaid: o.brokerCostPerShare,
    acquiredAt: TRADING_TIME,
  };
}

/**
 * Open the live 3-position book, restate cost basis to broker truth
 * (TRA-2889), and pin each row's MID at the screenshot value — the state the
 * board captured, immediately before the display marks land.
 */
function openScreenshotBook(acct: PaperOptionsAccount): void {
  for (const o of BOOK) {
    const pos = acct.openOptionFromCandidate(
      buildSignal(o), 'live', 50_000, o.spot, undefined, o.contracts,
    );
    expect(pos, `${o.label} failed to open`).not.toBeNull();
  }
  acct.reconcileTradierPositions(BOOK.map(buildBrokerPosition));
  const bySymbol = new Map(acct.getState().openOptions.map(p => [p.optionSymbol, p]));
  for (const o of BOOK) {
    bySymbol.get(o.optionSymbol)!.currentPremium = o.midMark;
  }
}

function lastTradeMap(): Map<string, number> {
  return new Map(BOOK.map(o => [o.optionSymbol, o.lastTrade]));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('displayOptionMark — the one display-mark rule', () => {
  const base = { mode: 'live' as const, closedAt: undefined, currentPremium: 0.965, lastMark: 0.86 };

  it('values an OPEN LIVE row with a fresh last trade at the last trade', () => {
    expect(displayOptionMark(base)).toBeCloseTo(0.86, 10);
  });

  it('falls back to the mid when the tape has never printed', () => {
    expect(displayOptionMark({ ...base, lastMark: undefined })).toBeCloseTo(0.965, 10);
    expect(displayOptionMark({ ...base, lastMark: 0 })).toBeCloseTo(0.965, 10);
    expect(displayOptionMark({ ...base, lastMark: Number.NaN })).toBeCloseTo(0.965, 10);
  });

  it('ignores lastMark on demo rows — the paper book fills at the mid', () => {
    expect(displayOptionMark({ ...base, mode: 'demo' })).toBeCloseTo(0.965, 10);
    // Legacy rows with no mode stamp route to demo.
    expect(displayOptionMark({ ...base, mode: undefined })).toBeCloseTo(0.965, 10);
  });

  it('ignores lastMark on CLOSED rows — currentPremium there is the exit fill', () => {
    expect(displayOptionMark({ ...base, closedAt: TRADING_TIME })).toBeCloseTo(0.965, 10);
  });
});

describe('refreshLiveDisplayMarks — stamping the broker tape onto the book', () => {
  it('sets lastMark on live rows without touching the risk-engine mark', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    openScreenshotBook(acct);

    acct.refreshLiveDisplayMarks(lastTradeMap());

    for (const o of BOOK) {
      const row = acct.getState().openOptions.find(p => p.optionSymbol === o.optionSymbol)!;
      expect(row.lastMark, o.label).toBeCloseTo(o.lastTrade, 10);
      // The risk-engine mark is untouched.
      expect(row.currentPremium, o.label).toBeCloseTo(o.midMark, 10);
    }
  });

  it('ignores non-positive prints and keeps the previous print when a contract is absent', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    openScreenshotBook(acct);
    acct.refreshLiveDisplayMarks(lastTradeMap());

    const aapl = BOOK[0];
    acct.refreshLiveDisplayMarks(new Map([[aapl.optionSymbol, 0]]));
    const afterZero = acct.getState().openOptions.find(p => p.optionSymbol === aapl.optionSymbol)!;
    expect(afterZero.lastMark).toBeCloseTo(aapl.lastTrade, 10);

    // A tick where only SPY chains refreshed: AAPL keeps its print — "no print
    // this tick" is not "the last trade stopped existing".
    acct.refreshLiveDisplayMarks(new Map([[BOOK[1].optionSymbol, 0.14]]));
    const untouched = acct.getState().openOptions.find(p => p.optionSymbol === aapl.optionSymbol)!;
    expect(untouched.lastMark).toBeCloseTo(aapl.lastTrade, 10);
    const refreshed = acct.getState().openOptions.find(p => p.optionSymbol === BOOK[1].optionSymbol)!;
    expect(refreshed.lastMark).toBeCloseTo(0.14, 10);
  });
});

describe('TRA-2890 — the live screen reconciles with Tradier positions view', () => {
  it('reproduces the screenshot: $439 mid book reads $418 on display, G/L −$46.00 = −9.91%', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    openScreenshotBook(acct);

    // Pre-fix state: display == mid book == $439, the middle row of the table.
    expect(acct.getOptionMarketValueForMode('live').longValue).toBeCloseTo(439, 6);

    acct.refreshLiveDisplayMarks(lastTradeMap());

    // Account Summary "Long Option Value" == Tradier positions view.
    expect(acct.getOptionMarketValueForMode('live').longValue).toBeCloseTo(418, 6);

    // Display unrealized == broker Gain/Loss to the cent, and the percentage
    // is the exact tile the board screenshotted.
    const display = acct.getStateForMode('live').openOptionsUnrealizedPnl!;
    expect(display).toBeCloseTo(-46, 6);
    const costBasis = BOOK.reduce((s, o) => s + o.brokerCostPerShare * o.contracts * 100, 0);
    expect(costBasis).toBeCloseTo(464, 6);
    expect((display / costBasis) * 100).toBeCloseTo(-9.91, 1);
  });

  it('Book Premium / allocation notional value the live book at the display mark', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    openScreenshotBook(acct);
    acct.refreshLiveDisplayMarks(lastTradeMap());

    const greeks = computePortfolioGreeks(
      acct.getStateForMode('live').openOptions,
      () => undefined,
    );
    expect(greeks.netNotional).toBeCloseTo(418, 6);
    const byName = new Map(greeks.byName.map(b => [b.key, b.notional]));
    expect(byName.get('AAPL')).toBeCloseTo(0.86 * 4 * 100, 6);
    expect(byName.get('SPY')).toBeCloseTo(0.13 * 4 * 100 + 0.11 * 2 * 100, 6);
  });

  it('DISCRIMINATOR: the give-back basis (dailyOptionsPnl) stays on the MID book', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    openScreenshotBook(acct);
    acct.refreshLiveDisplayMarks(lastTradeMap());

    const state = acct.getStateForMode('live');
    // Display: last-trade book vs broker basis = −$46.
    expect(state.openOptionsUnrealizedPnl).toBeCloseTo(-46, 6);
    // Governor basis: mid book vs broker basis = 439 − 464 = −$25. If the
    // display mark ever leaks into the risk path, this reads −46 and the
    // split is broken — that is the failure this assertion exists to catch.
    expect(state.dailyOptionsPnl).toBeCloseTo(-25, 6);
  });

  it('a live row the tape never priced still displays at the mid (no vacuous $0)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    openScreenshotBook(acct);
    // Only the two SPY contracts print; AAPL never trades after hours.
    acct.refreshLiveDisplayMarks(new Map(BOOK.slice(1).map(o => [o.optionSymbol, o.lastTrade])));

    // AAPL at mid (0.965 × 4 × 100 = 386) + SPY at last (52 + 22).
    expect(acct.getOptionMarketValueForMode('live').longValue).toBeCloseTo(386 + 52 + 22, 6);
  });
});
