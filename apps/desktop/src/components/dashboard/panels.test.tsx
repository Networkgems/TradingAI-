// TRA-422 — component tests for the dashboard panels extracted from the
// Dashboard.tsx / CryptoDashboard.tsx decomposition. Each panel is rendered in
// isolation; panels that call useToast are wrapped in <ToastProvider>. fetch is
// stubbed so the watchlist/close mutations never hit the network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import type {
  Position, TradeSignal, AccountState, NewsItem, CryptoSymbolState, AccountSettings,
} from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
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
import { KillSwitchButton } from './KillSwitchButton';
import { HaltBanner } from './HaltBanner';
import { LiveCredentialsBanner } from './LiveCredentialsBanner';
import { PromotionGatePanel } from './PromotionGatePanel';
import { DEFAULT_PROMOTION_THRESHOLDS } from '@trading-app/shared';

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
        connected={true} lastTick={Date.now()} autoTradingEnabled={true} killSwitchEngaged={false}
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
        connected={true} lastTick={Date.now()} autoTradingEnabled={true} killSwitchEngaged={false}
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
        connected={true} lastTick={Date.now()} autoTradingEnabled={true} killSwitchEngaged={false}
        accountMode="demo" onAccountModeChange={() => {}}
        theme="dark" onToggleTheme={() => {}} isAdmin={false}
        onOpenProfileModal={() => {}} onGoHome={() => {}} onLogout={() => {}}
      />,
    );
    expect(screen.getByText('Daily Opts P&L')).toBeInTheDocument();
    expect(screen.getByText(/\$12\.50/)).toBeInTheDocument();
  });
});

// TRA-506 — banner is the user-visible half of the guardrail. The server
// rejects bad saves, but the user the issue captured already had a stale
// "live + sandbox + empty production creds" snapshot persisted; the banner
// is what surfaces that state on every dashboard render so the user can't
// keep assuming live is running.
describe('LiveCredentialsBanner (TRA-506)', () => {
  // Helpers so each test pins exactly one state condition. `liveFullCreds`
  // mirrors the validator test fixture so the panels and server suites
  // agree on what "fully configured" looks like.
  function liveFullCreds(): AccountSettings {
    return {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradierEnvOptions: 'production',
      liveApiKeyOptionsProduction: 'prod-token',
      liveAccountIdOptionsProduction: 'VA123',
      liveApiKeyCrypto: 'cb-key',
      liveApiSecretCrypto: 'cb-secret',
    };
  }

  it('renders nothing while settings are still loading (null prop)', () => {
    const { container } = render(<LiveCredentialsBanner settings={null} onOpenSettings={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing in demo mode even when every live cred is blank', () => {
    const demoBlank: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
      liveApiKeyCrypto: '',
      liveApiSecretCrypto: '',
    };
    const { container } = render(<LiveCredentialsBanner settings={demoBlank} onOpenSettings={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing in live mode when every required cred is filled', () => {
    const { container } = render(
      <LiveCredentialsBanner settings={liveFullCreds()} onOpenSettings={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a warning when live + Tradier production creds are blank, calling onOpenSettings with the first missing field', async () => {
    // Mirrors the exact state from the issue's reporter snapshot: live mode
    // selected, production env selected, both production creds blank.
    const broken: AccountSettings = {
      ...liveFullCreds(),
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
    };
    const onOpenSettings = vi.fn();
    render(<LiveCredentialsBanner settings={broken} onOpenSettings={onOpenSettings} />);
    expect(screen.getByTestId('live-credentials-banner')).toBeInTheDocument();
    expect(screen.getByText(/Tradier production API token/)).toBeInTheDocument();
    expect(screen.getByText(/Tradier production account ID/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Open settings/ }));
    expect(onOpenSettings).toHaveBeenCalledWith('liveApiKeyOptionsProduction');
  });

  it('renders a warning when live + Coinbase creds are blank', () => {
    const broken: AccountSettings = {
      ...liveFullCreds(),
      liveApiKeyCrypto: '',
      liveApiSecretCrypto: '',
    };
    render(<LiveCredentialsBanner settings={broken} onOpenSettings={() => {}} />);
    expect(screen.getByTestId('live-credentials-banner')).toBeInTheDocument();
    expect(screen.getByText(/Coinbase API key/)).toBeInTheDocument();
    expect(screen.getByText(/Coinbase API secret/)).toBeInTheDocument();
  });
});

// TRA-535 — operator-facing surface for the TRA-526 global kill switch.
describe('HaltBanner (TRA-535)', () => {
  it('renders nothing when not halted', () => {
    const { container } = render(<HaltBanner halted={false} reason={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces the halt reason when halted', () => {
    render(<HaltBanner halted={true} reason="Global kill switch engaged — quarter-end freeze" />);
    expect(screen.getByTestId('halt-banner')).toBeInTheDocument();
    expect(screen.getByText(/no new entries/)).toBeInTheDocument();
    expect(screen.getByText(/quarter-end freeze/)).toBeInTheDocument();
  });

  it('falls back to a default message when halted with no reason', () => {
    render(<HaltBanner halted={true} reason={null} />);
    expect(screen.getByText(/Global kill switch engaged/)).toBeInTheDocument();
  });
});

describe('KillSwitchButton (TRA-535)', () => {
  it('renders the idle label when not engaged and the ON label when engaged', () => {
    const { rerender } = renderWithToast(<KillSwitchButton token="t" engaged={false} />);
    expect(screen.getByRole('button', { name: /Kill Switch$/ })).toBeInTheDocument();
    rerender(<ToastProvider><KillSwitchButton token="t" engaged={true} /></ToastProvider>);
    expect(screen.getByRole('button', { name: /Kill Switch ON/ })).toBeInTheDocument();
  });

  it('does NOT POST when the confirm dialog is dismissed (fat-finger guard)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderWithToast(<KillSwitchButton token="t" engaged={false} />);
    await userEvent.click(screen.getByRole('button', { name: /Kill Switch$/ }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs { engaged: true, reason } after confirm + reason prompt, then flips to ON', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'prompt').mockReturnValue('end-of-day freeze');
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const onToggled = vi.fn();
    renderWithToast(<KillSwitchButton token="t" engaged={false} onToggled={onToggled} />);
    await userEvent.click(screen.getByRole('button', { name: /Kill Switch$/ }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/trading\/kill-switch$/);
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ engaged: true, reason: 'end-of-day freeze' });
    expect(onToggled).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('button', { name: /Kill Switch ON/ })).toBeInTheDocument();
  });

  it('releases without a confirm prompt and POSTs { engaged: false }', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderWithToast(<KillSwitchButton token="t" engaged={true} />);
    await userEvent.click(screen.getByRole('button', { name: /Kill Switch ON/ }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ engaged: false });
  });
});

// TRA-537 — Promotion-Gate status panel. fetch is stubbed to serve the
// `/api/promotion/status` payload so the panel renders without a live server.
describe('PromotionGatePanel (TRA-537)', () => {
  // A passing strategy: every stage clears, so canGoLive is true.
  const readyEntry = {
    record: {
      strategyId: 'tra405_validated',
      backtest: { reportId: 'TRA-405', registeredAt: '2026-05-01T00:00:00.000Z', registeredBy: 'quant' },
      decisions: [{ reviewer: 'quanttrader', decidedAt: '2026-05-20T00:00:00.000Z' }],
    },
    status: {
      strategyId: 'tra405_validated',
      backtest: {
        state: 'pass',
        metrics: { sharpe: 1.4, expectancy: 0.22, profitFactor: 1.8, maxDrawdown: 0.12, tradeCount: 240 },
        failedChecks: [],
      },
      paper: {
        state: 'pass',
        tradeCount: 80,
        metrics: { tradeCount: 80, expectancy: 0.18, sharpe: 1.1, profitFactor: 1.6, slippageRatio: 1.1, slippageSampleSize: 80 },
        failedChecks: [],
      },
      signoff: 'present',
      canGoLive: true,
      blockedReasons: [],
    },
    thresholds: DEFAULT_PROMOTION_THRESHOLDS,
  };

  // A blocked strategy: paper trade count is short and there is no sign-off.
  const blockedEntry = {
    record: { strategyId: 'bb_fade_sol_doge', backtest: null, decisions: [] },
    status: {
      strategyId: 'bb_fade_sol_doge',
      backtest: { state: 'missing', metrics: null, failedChecks: ['no backtest report registered'] },
      paper: {
        state: 'fail',
        tradeCount: 12,
        metrics: { tradeCount: 12, expectancy: 0.05, sharpe: 0.4, profitFactor: 1.1, slippageRatio: null, slippageSampleSize: 0 },
        failedChecks: ['paper trade count 12 < 50'],
      },
      signoff: 'absent',
      canGoLive: false,
      blockedReasons: [
        'Stage 1 (backtest) missing: no backtest report registered',
        'Stage 2 (paper) fail: paper trade count 12 < 50',
        'Stage 3 (sign-off) absent: no promotion_decision on record',
      ],
    },
    thresholds: DEFAULT_PROMOTION_THRESHOLDS,
  };

  function stubStatus(payload: unknown) {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))));
  }

  it('renders a card per strategy with the API-computed metrics and verdicts', async () => {
    stubStatus({ strategies: [readyEntry, blockedEntry] });
    render(<PromotionGatePanel token="t" />);

    // Ready strategy: READY badge + the API's computed Sharpe value verbatim.
    expect(await screen.findByText('READY FOR LIVE')).toBeInTheDocument();
    expect(screen.getByText('1.4')).toBeInTheDocument(); // backtest sharpe, not recomputed
    expect(screen.getByText(/Signed off by/)).toBeInTheDocument();

    // Blocked strategy: BLOCKED badge is present alongside the ready one.
    expect(screen.getByText('BLOCKED')).toBeInTheDocument();
  });

  it('shows which gate failed and why for a blocked strategy', async () => {
    stubStatus({ strategies: [blockedEntry] });
    render(<PromotionGatePanel token="t" />);

    expect(await screen.findByText('BLOCKED')).toBeInTheDocument();
    expect(screen.getByText("Why this strategy can't go live")).toBeInTheDocument();
    // Each blocked reason from the API is surfaced verbatim.
    expect(screen.getByText('Stage 2 (paper) fail: paper trade count 12 < 50')).toBeInTheDocument();
    expect(screen.getByText('Stage 3 (sign-off) absent: no promotion_decision on record')).toBeInTheDocument();
    // Missing-stage placeholders render rather than crashing on null metrics.
    expect(screen.getByText('No backtest report registered.')).toBeInTheDocument();
  });

  it('shows an empty state when no strategies are registered', async () => {
    stubStatus({ strategies: [] });
    render(<PromotionGatePanel token="t" />);
    expect(await screen.findByText(/No strategies are registered/)).toBeInTheDocument();
  });

  it('surfaces an error when the status endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))));
    render(<PromotionGatePanel token="t" />);
    expect(await screen.findByText(/Could not load promotion status/)).toBeInTheDocument();
  });
});
