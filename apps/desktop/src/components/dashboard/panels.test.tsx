// TRA-422 — component tests for the dashboard panels extracted from the
// Dashboard.tsx / CryptoDashboard.tsx decomposition. Each panel is rendered in
// isolation; panels that call useToast are wrapped in <ToastProvider>. fetch is
// stubbed so the watchlist/close mutations never hit the network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import type {
  Position, TradeSignal, AccountState, NewsItem, CryptoSymbolState,
} from '@trading-app/shared';
import { ToastProvider } from '../../lib/toast.tsx';
import type { SymbolState } from '../../types/app';
import { NewsPanel } from './NewsPanel';
import { StockWatchlistPanel } from './StockWatchlistPanel';
import { StockSignalsPanel } from './StockSignalsPanel';
import { StockPositionsPanel } from './StockPositionsPanel';
import { StockOptionsPanel } from './StockOptionsPanel';
import { CryptoWatchlistPanel } from './CryptoWatchlistPanel';
import { CryptoSignalsPanel } from './CryptoSignalsPanel';
import { CryptoPositionsPanel } from './CryptoPositionsPanel';
import { DashboardHeader } from './DashboardHeader';

// Render a panel inside the ToastProvider its useToast() call requires.
function renderWithToast(ui: ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

const symbol = (over: Partial<SymbolState> = {}): SymbolState => ({
  symbol: 'NVDA', price: 100, volume: 2_000_000, change: 1.5, changePct: 1.5,
  lastUpdated: Date.now(), quoteStatus: 'ok', ...over,
});

const cryptoSymbol = (over: Partial<CryptoSymbolState> = {}): CryptoSymbolState => ({
  symbol: 'ETH-USD', price: 3000, volume: 5_000_000, change: 12, changePct: 0.4,
  lastUpdated: Date.now(), quoteStatus: 'ok', ...over,
});

const position = (over: Partial<Position> = {}): Position => ({
  id: 'p1', symbol: 'NVDA', side: 'buy', signalType: 'momentum',
  entryPrice: 100, quantity: 10, stopLoss: 95, takeProfit: 120,
  openedAt: Date.now(), ...over,
});

const signal = (over: Partial<TradeSignal> = {}): TradeSignal => ({
  id: 's1', symbol: 'NVDA', type: 'momentum', side: 'buy',
  entryPrice: 100, stopLoss: 95, takeProfit: 120, riskRewardRatio: 4,
  timestamp: Date.now(), ...over,
});

const account: AccountState = {
  totalEquity: 10_000, availableCash: 5_000, openPositions: [], dailyPnl: 42,
};

beforeEach(() => {
  // The mutation panels POST on user actions; keep them off the network.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NewsPanel (TRA-422)', () => {
  it('shows the loading copy when there is no news', () => {
    render(<NewsPanel news={[]} loadingText="Loading market news…" />);
    expect(screen.getByText('Loading market news…')).toBeInTheDocument();
  });

  it('renders a card per news item (capped at 10)', () => {
    const news: NewsItem[] = Array.from({ length: 12 }, (_, i) => ({
      title: `Headline ${i}`, url: `https://example.com/${i}`,
      source: 'Test', publishedAt: new Date().toISOString(),
    }));
    render(<NewsPanel news={news} loadingText="Loading…" />);
    expect(screen.getByText('Headline 0')).toBeInTheDocument();
    expect(screen.getByText('Headline 9')).toBeInTheDocument();
    expect(screen.queryByText('Headline 10')).not.toBeInTheDocument();
  });
});

describe('StockWatchlistPanel (TRA-422)', () => {
  it('renders a row per watchlist symbol', () => {
    renderWithToast(<StockWatchlistPanel token="t" symbols={[symbol(), symbol({ symbol: 'AAPL' })]} />);
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
  });

  it('rejects an invalid symbol without firing a request', async () => {
    renderWithToast(<StockWatchlistPanel token="t" symbols={[]} />);
    await userEvent.type(screen.getByPlaceholderText('Add symbol (e.g. NVDA)'), 'TOOLONG');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/Invalid symbol/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('StockSignalsPanel (TRA-422)', () => {
  it('shows the empty scanning message when there are no signals', () => {
    renderWithToast(
      <StockSignalsPanel token="t" signals={[]} symbols={[symbol()]} marketReview={undefined} />,
    );
    expect(screen.getByText(/engine is scanning/)).toBeInTheDocument();
  });

  it('renders a signal card with side and symbol', () => {
    renderWithToast(
      <StockSignalsPanel token="t" signals={[signal()]} symbols={[symbol()]} marketReview={undefined} />,
    );
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.getByText('BUY')).toBeInTheDocument();
  });
});

describe('StockPositionsPanel (TRA-422)', () => {
  it('shows the empty state when there are no positions', () => {
    renderWithToast(
      <StockPositionsPanel
        token="t" openPositions={[]} closedPositions={[]} symbols={[]}
        accountMode="demo" tradierEnv="production"
      />,
    );
    expect(screen.getByText(/No open positions/)).toBeInTheDocument();
  });

  it('renders an open position row with a Close button', () => {
    renderWithToast(
      <StockPositionsPanel
        token="t" openPositions={[position()]} closedPositions={[]} symbols={[symbol()]}
        accountMode="demo" tradierEnv="production"
      />,
    );
    expect(screen.getByText('Open Positions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  // TRA-503 — Tradier equity sync mirrors the Options pattern: hidden in demo,
  // shown in live (regardless of env).
  it('hides the Tradier sync button in demo mode', () => {
    renderWithToast(
      <StockPositionsPanel
        token="t" openPositions={[]} closedPositions={[]} symbols={[]}
        accountMode="demo" tradierEnv="production"
      />,
    );
    expect(screen.queryByRole('button', { name: /Sync Tradier/ })).not.toBeInTheDocument();
  });

  it('shows the Tradier sync button in live mode (production env)', () => {
    renderWithToast(
      <StockPositionsPanel
        token="t" openPositions={[]} closedPositions={[]} symbols={[]}
        accountMode="live" tradierEnv="production"
      />,
    );
    expect(screen.getByRole('button', { name: /Sync Tradier production positions/ })).toBeInTheDocument();
  });

  it('shows the Tradier sync button in live mode (sandbox env)', () => {
    renderWithToast(
      <StockPositionsPanel
        token="t" openPositions={[]} closedPositions={[]} symbols={[]}
        accountMode="live" tradierEnv="sandbox"
      />,
    );
    expect(screen.getByRole('button', { name: /Sync Tradier sandbox positions/ })).toBeInTheDocument();
  });
});

describe('StockOptionsPanel (TRA-422)', () => {
  it('shows the Relative Value empty state when there are no option positions', () => {
    renderWithToast(
      <StockOptionsPanel
        token="t" tradierEnv="sandbox" accountMode="demo" account={undefined}
        optionsState={undefined} openOptions={[]} closedOptions={[]} optionsDailyLimit={5}
      />,
    );
    expect(screen.getByText(/Relative Value/)).toBeInTheDocument();
  });

  // TRA-503 — Demo doesn't route through Tradier, so the manual sync import
  // has nothing to pull. Hide the button there.
  it('hides the Tradier sync button in demo mode', () => {
    renderWithToast(
      <StockOptionsPanel
        token="t" tradierEnv="sandbox" accountMode="demo" account={undefined}
        optionsState={undefined} openOptions={[]} closedOptions={[]} optionsDailyLimit={5}
      />,
    );
    expect(screen.queryByRole('button', { name: /Sync Tradier/ })).not.toBeInTheDocument();
  });

  it('shows the Tradier sync button in live mode (sandbox env)', () => {
    renderWithToast(
      <StockOptionsPanel
        token="t" tradierEnv="sandbox" accountMode="live" account={undefined}
        optionsState={undefined} openOptions={[]} closedOptions={[]} optionsDailyLimit={5}
      />,
    );
    expect(screen.getByRole('button', { name: /Sync Tradier sandbox positions/ })).toBeInTheDocument();
  });

  it('shows the Tradier sync button in live mode (production env)', () => {
    renderWithToast(
      <StockOptionsPanel
        token="t" tradierEnv="production" accountMode="live" account={undefined}
        optionsState={undefined} openOptions={[]} closedOptions={[]} optionsDailyLimit={5}
      />,
    );
    expect(screen.getByRole('button', { name: /Sync Tradier production positions/ })).toBeInTheDocument();
  });
});

describe('CryptoWatchlistPanel (TRA-422)', () => {
  it('rejects a symbol that is not in XXX-USD form', async () => {
    renderWithToast(<CryptoWatchlistPanel token="t" symbols={[]} />);
    await userEvent.type(screen.getByPlaceholderText('Add symbol (e.g. ETH-USD)'), 'ETH');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/XXX-USD/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('CryptoSignalsPanel (TRA-422)', () => {
  it('renders a signal card', () => {
    renderWithToast(
      <CryptoSignalsPanel token="t" signals={[signal({ symbol: 'ETH-USD' })]} symbols={[cryptoSymbol()]} />,
    );
    expect(screen.getByText('ETH-USD')).toBeInTheDocument();
    expect(screen.getByText('BUY')).toBeInTheDocument();
  });
});

describe('CryptoPositionsPanel (TRA-422)', () => {
  it('shows the empty state when there are no positions', () => {
    renderWithToast(
      <CryptoPositionsPanel token="t" openPositions={[]} closedPositions={[]} symbols={[]} liveSkips={[]} />,
    );
    expect(screen.getByText(/No open positions/)).toBeInTheDocument();
  });

  it('renders Leverage / Liquidation columns only when a perp is open', () => {
    const { rerender } = renderWithToast(
      <CryptoPositionsPanel
        token="t" openPositions={[position({ symbol: 'ETH-USD' })]} closedPositions={[]}
        symbols={[cryptoSymbol()]} liveSkips={[]}
      />,
    );
    expect(screen.queryByText('Leverage')).not.toBeInTheDocument();
    rerender(
      <ToastProvider>
        <CryptoPositionsPanel
          token="t"
          openPositions={[position({ symbol: 'ETH-USD', productType: 'perp', leverage: 3, liquidationPrice: 80 })]}
          closedPositions={[]} symbols={[cryptoSymbol()]} liveSkips={[]}
        />
      </ToastProvider>,
    );
    expect(screen.getByText('Leverage')).toBeInTheDocument();
    expect(screen.getByText('Liquidation')).toBeInTheDocument();
  });
});

describe('DashboardHeader (TRA-422)', () => {
  it('renders the account stat group', () => {
    renderWithToast(
      <DashboardHeader
        token="t" account={account} optionsState={undefined}
        openPositionsCount={0} openOptionsCount={0} optionsDailyLimit={5}
        connected={true} lastTick={Date.now()} autoTradingEnabled={true}
        accountMode="demo" onAccountModeChange={() => {}}
        theme="dark" onToggleTheme={() => {}} isAdmin={false}
        onOpenProfileModal={() => {}} onGoHome={() => {}} onLogout={() => {}}
      />,
    );
    expect(screen.getByText('Equity')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop Trading/ })).toBeInTheDocument();
  });

  // TRA-475 — the options pill in the header reads today's options P&L,
  // not the cumulative realized number. The bug the issue filed against
  // was the pill showing yesterday's cumulative (e.g. −$19,471 with no
  // option closes today). Lock in the new contract: render `dailyOptionsPnl`
  // and prefer it over the cumulative `optionsPnl` when both are present.
  it('renders Daily Opts P&L from optionsState.dailyOptionsPnl, not cumulative optionsPnl', () => {
    renderWithToast(
      <DashboardHeader
        token="t" account={account}
        optionsState={{
          openOptions: [], closedOptions: [],
          // Cumulative realized = a big negative; pill must IGNORE it.
          optionsPnl: -19_471,
          // Today's P&L = a small loss the engine is reporting fresh.
          dailyOptionsPnl: -91.99,
          optionsCash: 64_224.32, dailyOptionsCount: 1,
        }}
        openPositionsCount={0} openOptionsCount={3} optionsDailyLimit={10}
        connected={true} lastTick={Date.now()} autoTradingEnabled={true}
        accountMode="live" onAccountModeChange={() => {}}
        theme="dark" onToggleTheme={() => {}} isAdmin={false}
        onOpenProfileModal={() => {}} onGoHome={() => {}} onLogout={() => {}}
      />,
    );
    expect(screen.getByText('Daily Opts P&L')).toBeInTheDocument();
    // The new value renders; the cumulative does not appear in the header.
    expect(screen.getByText(/−\$91\.99|-\$91\.99/)).toBeInTheDocument();
    expect(screen.queryByText(/19,471/)).not.toBeInTheDocument();
  });

  // TRA-475 back-compat: a server snapshot that pre-dates `dailyOptionsPnl`
  // (e.g. older deploy still in flight while the desktop updates) must not
  // render `$NaN` or crash; falls back to the cumulative `optionsPnl` until
  // the server upgrades.
  it('falls back to optionsPnl when dailyOptionsPnl is missing from the server payload', () => {
    renderWithToast(
      <DashboardHeader
        token="t" account={account}
        optionsState={{
          openOptions: [], closedOptions: [],
          optionsPnl: 12.50,
          // dailyOptionsPnl intentionally omitted — simulates legacy server.
          optionsCash: 25_000, dailyOptionsCount: 0,
        }}
        openPositionsCount={0} openOptionsCount={0} optionsDailyLimit={10}
        connected={true} lastTick={Date.now()} autoTradingEnabled={true}
        accountMode="demo" onAccountModeChange={() => {}}
        theme="dark" onToggleTheme={() => {}} isAdmin={false}
        onOpenProfileModal={() => {}} onGoHome={() => {}} onLogout={() => {}}
      />,
    );
    expect(screen.getByText('Daily Opts P&L')).toBeInTheDocument();
    expect(screen.getByText(/\$12\.50/)).toBeInTheDocument();
  });
});
