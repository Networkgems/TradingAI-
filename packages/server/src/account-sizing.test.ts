import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CoinbaseAccountBalance, CoinbaseOrderClient } from '@trading-app/engine';
import { RiskManager } from '@trading-app/engine';
import { PaperAccount } from './paper-account.js';
import { CryptoPaperAccount } from './crypto-account.js';
import { CryptoLiveAccount } from './crypto-live-account.js';

/**
 * TRA-2034 — fidelity lever L2. Pins the live/paper account sizing path to the
 * SAME engine `RiskManager.sizeFromStop` the backtest runner uses
 * (`packages/backtest/src/runner.ts:176,430`). If the account layer ever
 * regrows a bespoke risk→qty formula, these fixtures diverge and fail.
 *
 * `runnerSize` reconstructs the runner's exact call: `new RiskManager(account,
 * { fractionalQuantity })` on a default account (managedAccountRatio 0.5 ==
 * MANAGED_ACCOUNT_RATIO, riskPerTrade 1% == DEFAULT_RISK_PER_TRADE), no
 * per-call risk override — so the reference IS the backtest's sizer.
 */
function runnerSize(
  equity: number,
  entryPrice: number,
  stopPrice: number,
  fractionalQuantity: boolean,
): number {
  const risk = new RiskManager(
    { totalEquity: equity, availableCash: equity, openPositions: [], dailyPnl: 0 },
    { fractionalQuantity },
  );
  return risk.sizeFromStop(entryPrice, stopPrice);
}

// (equity, entry, stop) fixtures. The first three keep the risk-budget sizing
// binding (notional cap inert); the last drives a tight stop so the TRA-178
// notional cap binds — proving it now runs on the account book identically to
// the runner.
const STOCK_FIXTURES: Array<[number, number, number]> = [
  [100_000, 100, 95],   // dist 5  → floor(500/5)=100 shares
  [25_000, 49.5, 48.0], // dist 1.5
  [250_000, 320.4, 300.1],
  [100_000, 100, 99.99], // dist 0.01 → risk qty 50_000, notional cap 500 binds
];

const CRYPTO_FIXTURES: Array<[number, number, number]> = [
  [25_000, 30_000, 29_700], // dist 300
  [25_000, 100, 95],
  [50_000, 2_500.25, 2_450.1],
  [25_000, 30_000, 29_999], // dist 1 → tight stop, notional cap binds
];

describe('TRA-2034 account sizing == engine RiskManager (backtest parity)', () => {
  it('PaperAccount.sizeFromStop matches the runner on stock fixtures', () => {
    for (const [equity, entry, stop] of STOCK_FIXTURES) {
      const acc = new PaperAccount({ initialEquity: equity });
      expect(acc.sizeFromStop(entry, stop)).toBe(runnerSize(equity, entry, stop, false));
    }
  });

  it('CryptoPaperAccount.sizeFromStop matches the runner on crypto fixtures', () => {
    for (const [equity, entry, stop] of CRYPTO_FIXTURES) {
      const acc = new CryptoPaperAccount(equity);
      expect(acc.sizeFromStop(entry, stop)).toBe(runnerSize(equity, entry, stop, true));
    }
  });

  it('CryptoLiveAccount.sizeFromStop matches the runner on crypto fixtures', async () => {
    for (const [equity, entry, stop] of CRYPTO_FIXTURES) {
      const acc = await liveAccountWithEquity(equity);
      expect(acc.sizeFromStop(entry, stop)).toBe(runnerSize(equity, entry, stop, true));
    }
  });

  it('respects a per-user riskPerTrade override identically to the runner', () => {
    // A 2% risk budget must scale sizing 2× vs the 1% baseline for both the
    // account and the reference sizer (RiskManager riskPct override).
    const acc = new PaperAccount({ initialEquity: 100_000, riskPerTrade: 0.02 });
    const risk = new RiskManager({
      totalEquity: 100_000, availableCash: 100_000, openPositions: [], dailyPnl: 0,
    });
    expect(acc.sizeFromStop(100, 95)).toBe(risk.sizeFromStop(100, 95, { riskPct: 0.02 }));
  });
});

// ── minimal Coinbase stub so CryptoLiveAccount can rollup a USD-only balance ──
class FakeCoinbaseClient {
  listAccounts = vi.fn<() => Promise<CoinbaseAccountBalance[]>>();
  placeMarketOrder = vi.fn();
  closeFuturesPosition = vi.fn();
  getOrder = vi.fn();
  getProductPrices = vi.fn(async () => new Map());
  getProducts = vi.fn(async () => new Map());
  listProducts = vi.fn(async () => []);
  listPortfolios = vi.fn(async () => []);
  listFuturesPositions = vi.fn(async () => []);
  getProductBook = vi.fn(async () => ({}));
}

async function liveAccountWithEquity(usd: number): Promise<CryptoLiveAccount> {
  const coinbase = new FakeCoinbaseClient();
  coinbase.listAccounts.mockResolvedValue([
    {
      uuid: 'usd', name: 'USD Wallet', currency: 'USD',
      available_balance: { value: String(usd), currency: 'USD' },
      hold: { value: '0', currency: 'USD' },
    },
  ]);
  const account = new CryptoLiveAccount(
    coinbase as unknown as CoinbaseOrderClient,
    { sleep: async () => {} },
  );
  await account.refreshBalance();
  return account;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
