// TRA-422 — component tests for the dashboard panels extracted from the
// Dashboard.tsx / CryptoDashboard.tsx decomposition. Each panel is rendered in
// isolation; panels that call useToast are wrapped in <ToastProvider>. fetch is
// stubbed so the watchlist/close mutations never hit the network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import type {
  Position, TradeSignal, AccountState, NewsItem, CryptoSymbolState, AccountSettings, OptionPosition,
} from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import { ToastProvider } from '../../lib/toast.tsx';
import type { SymbolState } from '../../types/app';
import { NewsPanel } from './NewsPanel';
import { StockWatchlistPanel } from './StockWatchlistPanel';
import { StockSignalsPanel } from './StockSignalsPanel';
import { StockPositionsPanel } from './StockPositionsPanel';
import { StockOptionsPanel } from './StockOptionsPanel';
import { OptionsAlertsPanel } from './OptionsAlertsPanel';
import { CryptoWatchlistPanel } from './CryptoWatchlistPanel';
import { CryptoSignalsPanel } from './CryptoSignalsPanel';
import { CryptoPositionsPanel } from './CryptoPositionsPanel';
import { DashboardHeader } from './DashboardHeader';
import { DashboardFooter } from './DashboardFooter';
import { AccountSummaryCard } from './AccountSummaryCard';
import { KillSwitchButton } from './KillSwitchButton';
import { TradingAgentsButton } from './TradingAgentsButton';
import { HaltBanner } from './HaltBanner';
import { LiveCredentialsBanner } from './LiveCredentialsBanner';
import { PromotionGatePanel } from './PromotionGatePanel';
import { DEFAULT_PROMOTION_THRESHOLDS } from '@trading-app/shared';
import { HealthPanel } from './HealthPanel';
import { VersionChip, formatUptime } from './VersionChip';

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

// TRA-711 — minimal OptionPosition for the StockOptionsPanel footer test.
const optionPos = (over: Partial<OptionPosition> = {}): OptionPosition => ({
  id: 'o1', symbol: 'NVDA', optionType: 'call', strike: 100, expiration: '2026-07-17',
  contracts: 1, contractsRemaining: 1, premiumPaid: 1.0, currentPremium: 1.0,
  tp1Premium: 1.25, tp1Hit: false, stopLossPremium: 0.75, peakPremium: 1.0,
  trailingActive: false, trailingStopPremium: 0, underlyingEntryPrice: 100,
  openedAt: Date.now(), signalId: 's1', signalType: 'momentum', ...over,
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

  // ── TRA-3390 (impl child of TRA-2628) — AC5, on the rendered DOM ────────────
  //
  // "A positive control must contain what it detects": the fixture holds real
  // non-USD rows (`005930.KS` at 255500 KRW, `AZN.L` at 11714 GBp) rather than a
  // synthetic placeholder, and both directions are asserted — a renderer that
  // simply stopped printing money would pass the first assertion alone.
  it('renders a foreign listing WITHOUT `$`, and a USD row WITH it', () => {
    const { container } = renderWithToast(
      <StockWatchlistPanel
        token="t"
        symbols={[
          symbol({ symbol: '005930.KS', price: 255500, change: -12000, changePct: -4.48, currency: 'KRW' }),
          symbol({ symbol: 'AZN.L', price: 11714, change: 220, changePct: 1.91, currency: 'GBX' }),
          symbol({ symbol: 'AAPL', price: 211.2, change: 1.2, changePct: 0.57, currency: 'USD' }),
        ]}
      />,
    );
    const rowText = (sym: string) =>
      [...container.querySelectorAll('tr')].find(tr => tr.textContent?.includes(sym))!.textContent!;

    expect(rowText('005930.KS')).not.toContain('$');
    expect(rowText('005930.KS')).toContain('255,500.00 KRW');
    expect(rowText('AZN.L')).not.toContain('$');
    // Pence stay pence — not silently divided by 100 into pounds.
    expect(rowText('AZN.L')).toContain('11,714.00 GBX');
    // The other direction, same table, same render.
    expect(rowText('AAPL')).toContain('$211.20');
  });

  it('renders a row whose currency is UNKNOWN with no symbol at all — not `$`', () => {
    const { container } = renderWithToast(
      <StockWatchlistPanel token="t" symbols={[symbol({ symbol: 'STOOQ', price: 12.5 })]} />,
    );
    const row = [...container.querySelectorAll('tr')].find(tr => tr.textContent?.includes('STOOQ'))!;
    expect(row.textContent).not.toContain('$');
    expect(row.textContent).toContain('12.50');
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

  // TRA-3390 — a signal's entry/stop/target are levels in the SYMBOL's quote
  // currency. The live `ENR.DE` buy (EUR, `mode: "live"`) rendered as `$165.70`.
  it('renders a EUR signal card without `$`, and a USD one with it', () => {
    const { container } = renderWithToast(
      <StockSignalsPanel
        token="t"
        signals={[
          signal({ id: 'eur', symbol: 'ENR.DE', entryPrice: 165.70, stopLoss: 139.11, takeProfit: 218.89 }),
          signal({ id: 'usd', symbol: 'NVDA' }),
        ]}
        symbols={[
          symbol({ symbol: 'ENR.DE', price: 165.70, currency: 'EUR' }),
          symbol({ symbol: 'NVDA', currency: 'USD' }),
        ]}
        marketReview={undefined}
      />,
    );
    const cardText = (sym: string) =>
      [...container.querySelectorAll('.signal-card')].find(c => c.textContent?.includes(sym))!.textContent!;

    expect(cardText('ENR.DE')).not.toContain('$');
    expect(cardText('ENR.DE')).toContain('165.70 EUR');
    expect(cardText('ENR.DE')).toContain('139.11 EUR');
    expect(cardText('ENR.DE')).toContain('218.89 EUR');
    // The other direction.
    expect(cardText('NVDA')).toContain('$100.00');
  });

  it('renders a signal card with side and symbol', () => {
    renderWithToast(
      <StockSignalsPanel token="t" signals={[signal()]} symbols={[symbol()]} marketReview={undefined} />,
    );
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.getByText('BUY')).toBeInTheDocument();
  });

  // TRA-819 — QADesigner Signals-tab smoke. The sma200_pullback live entry is
  // gated off until it passes the TRA-817 OOS capital gate; it must still render
  // as display-only context, and nothing in the SMA-200 category may imply it
  // opens a position. Locks the corrected copy so the old "pullbacks are
  // trade-enabled" claim can't silently come back.
  it('renders sma200_pullback as display-only context with no trade-enabled / position language', () => {
    const pullback: TradeSignal = {
      ...signal({
        id: 'sma1',
        symbol: 'AAPL',
        type: 'sma200_pullback',
        context: 'continuation — pullback-to-200 bounce',
      }),
      rsi: 60,
      distAtr: 1.5,
      trendQuality: true,
      goldenCross: true,
      liveSkipReason:
        'display-only: sma200_pullback is not registered in the TRA-817 capital-gate manifest (no out-of-sample pass)',
    } as TradeSignal;

    renderWithToast(
      <StockSignalsPanel token="t" signals={[pullback]} symbols={[symbol({ symbol: 'AAPL' })]} marketReview={undefined} />,
    );

    // The display-only SMA-200 card still renders with its context label.
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText(/pullback-to-200 bounce/)).toBeInTheDocument();
    // The category note states display-only, not trade-enabled.
    expect(screen.getByText(/no position opens until the OOS capital gate passes/)).toBeInTheDocument();
    // The old, now-false copy must NOT appear anywhere on the tab.
    expect(screen.queryByText(/trade-enabled/)).not.toBeInTheDocument();
    // The SMA-200 card carries no Target / R:R chips (a position would).
    expect(screen.queryByText('Target')).not.toBeInTheDocument();
    expect(screen.queryByText('R:R')).not.toBeInTheDocument();
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

  // TRA-711 — the footer "Total Options P&L" previously read the engine's
  // cumulative mode-scoped realized total (`optionsState.optionsPnl`). Sitting
  // directly under the open-positions table, it contradicted every visible row:
  // the board screenshot showed open positions summing to +$41.50 while the
  // footer read −$79.50 of stale realized closes. Lock in the new contract:
  // the footer equals the sum of the per-row P&L the user can see — open
  // unrealized `(mark − paid) × contractsRemaining × 100` (+ partial realized)
  // plus today's closed realized — and IGNORES the cumulative number.
  it('renders Total Options P&L from the visible rows, not the cumulative optionsPnl', () => {
    renderWithToast(
      <StockOptionsPanel
        token="t" tradierEnv="production" accountMode="live" account={undefined}
        optionsState={{
          // Cumulative realized = a big negative the board flagged as "wrong".
          optionsPnl: -79.50,
          dailyOptionsPnl: 41.50,
          optionsCash: 1_000, dailyOptionsCount: 2,
          openOptions: [], closedOptions: [],
        }}
        openOptions={[
          // +$34.00 unrealized: (1.85 − 1.51) × 1 × 100
          optionPos({ id: 'o1', symbol: 'RIOT', optionType: 'call', premiumPaid: 1.51, currentPremium: 1.85, contracts: 1, contractsRemaining: 1 }),
          // −$15.00 unrealized: (0.38 − 0.43) × 3 × 100
          optionPos({ id: 'o2', symbol: 'MSFT', optionType: 'call', premiumPaid: 0.43, currentPremium: 0.38, contracts: 3, contractsRemaining: 3 }),
        ]}
        // +$22.50 realized from a position closed today.
        closedOptions={[
          optionPos({ id: 'o3', symbol: 'AAPL', optionType: 'put', premiumPaid: 0.50, currentPremium: 0.95, contracts: 1, contractsRemaining: 0, pnl: 22.50, closedAt: Date.now() }),
        ]}
        optionsDailyLimit={5}
      />,
    );
    // 34.00 − 15.00 + 22.50 = +41.50 — matches the visible rows.
    expect(screen.getByText(/\+\$41\.50/)).toBeInTheDocument();
    // The stale cumulative number must NOT appear in the footer.
    expect(screen.queryByText(/-\$79\.50|−\$79\.50/)).not.toBeInTheDocument();
  });

  // TRA-1125 — Open Option Positions is hoisted to the top of the tab so the
  // live book is the first thing the user sees, above the Closed Today table.
  it('renders Open Option Positions above the Closed Today table', () => {
    renderWithToast(
      <StockOptionsPanel
        token="t" tradierEnv="sandbox" accountMode="demo" account={undefined}
        optionsState={undefined}
        openOptions={[optionPos({ id: 'o1', symbol: 'RIOT', optionType: 'call', premiumPaid: 1.51, currentPremium: 1.85, contracts: 1, contractsRemaining: 1 })]}
        closedOptions={[optionPos({ id: 'o3', symbol: 'AAPL', optionType: 'put', premiumPaid: 0.50, currentPremium: 0.95, contracts: 1, contractsRemaining: 0, pnl: 22.50, closedAt: Date.now() })]}
        optionsDailyLimit={5}
      />,
    );
    const open = screen.getByText('Open Option Positions');
    const closed = screen.getByText(/Closed Today/);
    // DOCUMENT_POSITION_FOLLOWING (4) means `closed` comes after `open`.
    expect(open.compareDocumentPosition(closed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// TRA-4282 — the open table previously had NO failing direction on either of
// the two facts that matter on a breached real-money row: the Trail/SL cell
// was red whenever a stop EXISTED (a +30% winner rendered identically to a row
// through its stop), and `closeRejectCount` — the latch that stops the engine
// staging any exit — had zero occurrences in apps/desktop/src. These tests pin
// the instrument in the direction it failed on 2026-09-01 (three live rows
// below their stops, latched 3/3, all reading OPEN with an unannotated Close).
describe('StockOptionsPanel breach + latch instrumentation (TRA-4282)', () => {
  const renderOpen = (rows: OptionPosition[]) => renderWithToast(
    <StockOptionsPanel
      token="t" tradierEnv="production" accountMode="live" account={undefined}
      optionsState={undefined} openOptions={rows} closedOptions={[]} optionsDailyLimit={5}
    />,
  );

  it('marks a breached stop red with a "breached" label (engine basis: mid ≤ stop)', () => {
    renderOpen([optionPos({
      id: 'b1', symbol: 'KO', premiumPaid: 2.0, currentPremium: 0.95,
      stopLossPremium: 1.464, tp1Premium: 2.5,
    })]);
    const cell = screen.getByText('$1.46 (SL · breached)');
    expect(cell.closest('td')!.className).toContain('red');
  });

  it('does NOT mark a set-but-unbreached stop red — red must mean breached, not "a stop exists"', () => {
    // The planted value the old cell could not distinguish: +30% winner, stop set.
    renderOpen([optionPos({
      id: 'b2', symbol: 'KO', premiumPaid: 2.0, currentPremium: 2.6,
      stopLossPremium: 1.464, tp1Premium: 2.5,
    })]);
    const cell = screen.getByText('$1.46 (SL)');
    expect(cell.closest('td')!.className).not.toContain('red');
    expect(screen.queryByText(/breached/)).not.toBeInTheDocument();
  });

  it('grades a trailing stop against the trail premium', () => {
    renderOpen([optionPos({
      id: 'b3', symbol: 'NOK', premiumPaid: 2.0, currentPremium: 0.9,
      stopLossPremium: 0.5, tp1Premium: 2.5, trailingActive: true, trailingStopPremium: 1.0,
    })]);
    const cell = screen.getByText('$1.00 (trail · breached)');
    expect(cell.closest('td')!.className).toContain('red');
  });

  it('grades a dark mid as set, never breached — no reading is not a low reading', () => {
    renderOpen([optionPos({
      id: 'b4', symbol: 'KO', premiumPaid: 2.0, currentPremium: 0,
      stopLossPremium: 1.464, tp1Premium: 2.5,
    })]);
    expect(screen.getByText('$1.46 (SL)')).toBeInTheDocument();
    expect(screen.queryByText(/breached/)).not.toBeInTheDocument();
  });

  it('renders a latched row as LATCHED 3/3 with the reason, never OPEN', () => {
    renderOpen([optionPos({
      id: 'l1', symbol: 'KO', premiumPaid: 2.0, currentPremium: 0.95,
      stopLossPremium: 1.464, tp1Premium: 2.5, closeRejectCount: 3,
      exitBreakerTrip: { breaker: 'close_reject', at: 1756668000000, causeClass: 'broker_refusal', count: 3 },
    })]);
    const status = screen.getByText('LATCHED 3/3');
    expect(status.closest('td')!.className).toContain('red');
    expect(status.closest('td')!.getAttribute('title')).toMatch(/broker_refusal/);
    expect(screen.getByText(/close rejected ×3/)).toBeInTheDocument();
    expect(screen.queryByText('OPEN')).not.toBeInTheDocument();
  });

  it('shows "indefinite" when the latch carries no release instant (today\'s live shape)', () => {
    renderOpen([optionPos({
      id: 'l2', symbol: 'KO', premiumPaid: 2.0, currentPremium: 0.95,
      stopLossPremium: 1.464, tp1Premium: 2.5, closeRejectCount: 3,
    })]);
    expect(screen.getByText(/indefinite/)).toBeInTheDocument();
    expect(screen.queryByText(/retest/)).not.toBeInTheDocument();
  });

  it('shows the half-open release instant instead of "indefinite" once TRA-4266 stamps one', () => {
    renderOpen([optionPos({
      id: 'l3', symbol: 'KO', premiumPaid: 2.0, currentPremium: 0.95,
      stopLossPremium: 1.464, tp1Premium: 2.5, closeRejectCount: 3,
      closeRejectProbeNotBeforeMs: Date.now() + 5 * 60_000,
    })]);
    expect(screen.getByText(/retest/)).toBeInTheDocument();
    expect(screen.queryByText(/indefinite/)).not.toBeInTheDocument();
  });

  it('does NOT latch below the cap — closeRejectCount 2 still reads OPEN with a plain Close', () => {
    renderOpen([optionPos({
      id: 'l4', symbol: 'KO', premiumPaid: 2.0, currentPremium: 0.95,
      stopLossPremium: 1.464, tp1Premium: 2.5, closeRejectCount: 2,
    })]);
    expect(screen.getByText('OPEN')).toBeInTheDocument();
    expect(screen.queryByText(/LATCHED/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('annotates the Close button on a latched row without disabling it', () => {
    renderOpen([optionPos({
      id: 'l5', symbol: 'KO', premiumPaid: 2.0, currentPremium: 0.95,
      stopLossPremium: 1.464, tp1Premium: 2.5, closeRejectCount: 3,
    })]);
    const btn = screen.getByRole('button', { name: 'Close (latched)' });
    expect(btn).toBeEnabled();
    expect(btn.getAttribute('title')).toMatch(/latched/i);
  });

  it('the latch annotation instructs nothing — recovery instructions belong to the row\'s server-composed notice (TRA-4224)', () => {
    // On imported row a2f9c8cd the old fixed sentence ("close … with the Close
    // button") can be false; the close route's gates decide. The UI label must
    // describe the state only, never repeat an instruction the route may refuse.
    renderOpen([optionPos({
      id: 'l6', symbol: 'NOK', premiumPaid: 2.0, currentPremium: 0.425,
      stopLossPremium: 0.456, tp1Premium: 2.5, closeRejectCount: 3,
      importedFromTradier: true,
    })]);
    const btn = screen.getByRole('button', { name: 'Close (latched)' });
    expect(btn.getAttribute('title')).not.toMatch(/close (this position )?manually|on Tradier/i);
    const status = screen.getByText('LATCHED 3/3');
    expect(status.closest('td')!.getAttribute('title')).not.toMatch(/close (this position )?manually|with the Close button/i);
  });
});

describe('OptionsAlertsPanel (TRA-1125)', () => {
  const alertsBody = JSON.stringify({
    chainDates: ['2026-06-24', '2026-06-25'],
    symbolsDiffed: ['NVDA'],
    counts: { new_expiry: 0, new_strike: 0, iv_move: 1, target_hit: 0, stop_hit: 0 },
    alerts: [{ kind: 'iv_move', severity: 'info', symbol: 'NVDA', message: 'IV +12% vs prior chain', dedupKey: 'k1' }],
  });

  // The alert table is noisy, so it must start collapsed: the heading shows but
  // the per-alert detail stays hidden until the user expands it.
  it('collapses the alert table by default and shows a count badge', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(alertsBody, { status: 200 }))));
    renderWithToast(<OptionsAlertsPanel token="t" />);
    // Header renders once the first load resolves.
    await waitFor(() => expect(screen.getByText('Options Alerts')).toBeInTheDocument());
    // Collapsed: the count badge is visible but the alert detail row is not.
    expect(screen.getByText('1 info')).toBeInTheDocument();
    expect(screen.queryByText(/IV \+12% vs prior chain/)).not.toBeInTheDocument();
  });

  // TRA-4501 — the collapsed header must split action from info. The live feed
  // had 3 stop hits behind ~1960 IV moves, and the old header rendered a single
  // muted `(1963)`. Against that render this test fails: there is no
  // `3 action` element at all.
  it('splits the collapsed count into action vs info, with the action count styled by severity (TRA-4501)', async () => {
    const stop = (i: number) => ({ kind: 'stop_hit', severity: 'action', symbol: `S${i}`, message: `stop ${i}`, dedupKey: `s${i}` });
    const iv = (i: number) => ({ kind: 'iv_move', severity: 'info', symbol: `I${i}`, message: `iv ${i}`, dedupKey: `i${i}` });
    const mixed = JSON.stringify({
      chainDates: ['2026-09-09', '2026-09-10'],
      symbolsDiffed: [],
      counts: { new_expiry: 0, new_strike: 0, iv_move: 5, target_hit: 0, stop_hit: 3 },
      alerts: [stop(1), stop(2), stop(3), iv(1), iv(2), iv(3), iv(4), iv(5)],
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(mixed, { status: 200 }))));
    renderWithToast(<OptionsAlertsPanel token="t" />);
    await waitFor(() => expect(screen.getByText('Options Alerts')).toBeInTheDocument());
    const action = screen.getByText('3 action');
    expect(action).not.toHaveClass('muted');
    expect(action).toHaveClass('red');
    expect(screen.getByText('5 info')).toBeInTheDocument();
    expect(screen.queryByText('(8)')).not.toBeInTheDocument();
  });

  it('an all-info feed shows no action count (TRA-4501 control)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(alertsBody, { status: 200 }))));
    renderWithToast(<OptionsAlertsPanel token="t" />);
    await waitFor(() => expect(screen.getByText('Options Alerts')).toBeInTheDocument());
    expect(screen.getByText('1 info')).toHaveClass('muted');
    expect(screen.queryByText(/action/)).not.toBeInTheDocument();
  });

  it('reveals the alert table when the expand chevron is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(alertsBody, { status: 200 }))));
    renderWithToast(<OptionsAlertsPanel token="t" />);
    await waitFor(() => expect(screen.getByText('Options Alerts')).toBeInTheDocument());
    await userEvent.click(screen.getByTitle('Expand options alerts'));
    expect(screen.getByText(/IV \+12% vs prior chain/)).toBeInTheDocument();
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
        connected={true} lastTick={Date.now()} autoTradingEnabled={true} killSwitchEngaged={false} tradingAgentsEnabled={false}
        accountMode="demo" onAccountModeChange={() => {}}
        theme="dark" onToggleTheme={() => {}} isAdmin={false}
        onOpenProfileModal={() => {}} onGoHome={() => {}} onLogout={() => {}}
      />,
    );
    // TRA-725 — equity/Daily P&L moved to the DashboardFooter; the header's
    // account stat group now leads with the open-Positions count.
    expect(screen.getByText('Positions')).toBeInTheDocument();
    // TRA-704 — connection badge reads "CONNECTED" (was "LIVE") so it can't be
    // confused with the DEMO/LIVE real-money account-mode toggle.
    expect(screen.getByText('CONNECTED')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop Trading/ })).toBeInTheDocument();
  });

  // TRA-725 — daily P&L moved out of the header to the bottom DashboardFooter.
  // Lock that in: neither the equity "Daily P&L" nor the options "Daily Opts
  // P&L" chip renders in the header anymore.
  it('no longer renders the daily P&L chips in the header (relocated to footer)', () => {
    renderWithToast(
      <DashboardHeader
        token="t" account={account}
        optionsState={{
          openOptions: [], closedOptions: [],
          optionsPnl: -19_471, dailyOptionsPnl: -91.99,
          optionsCash: 64_224.32, dailyOptionsCount: 1,
        }}
        openPositionsCount={0} openOptionsCount={3} optionsDailyLimit={10}
        connected={true} lastTick={Date.now()} autoTradingEnabled={true} killSwitchEngaged={false} tradingAgentsEnabled={false}
        accountMode="live" onAccountModeChange={() => {}}
        theme="dark" onToggleTheme={() => {}} isAdmin={false}
        onOpenProfileModal={() => {}} onGoHome={() => {}} onLogout={() => {}}
      />,
    );
    expect(screen.queryByText('Daily P&L')).not.toBeInTheDocument();
    expect(screen.queryByText('Daily Opts P&L')).not.toBeInTheDocument();
    // The non-P&L stats stay in the header.
    expect(screen.getByText('Positions')).toBeInTheDocument();
    expect(screen.getByText('Options')).toBeInTheDocument();
  });
});

describe('DashboardFooter (TRA-725)', () => {
  it('renders the relocated equity Daily P&L with a "% Today" delta', () => {
    render(
      <DashboardFooter
        account={{ ...account, totalEquity: 10_042, dailyPnl: 42 }}
        optionsState={undefined}
      />,
    );
    expect(screen.getByText('Daily P&L')).toBeInTheDocument();
    // 42 on a 10,000 start-of-day equity ⇒ +0.42% Today.
    expect(screen.getByText(/\+\$42\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\+0\.42%\) Today/)).toBeInTheDocument();
  });

  // TRA-1228 — the realized figure prefers the row-summed `dailyRealizedOptionsPnl`
  // (never the cumulative `optionsPnl`), and the open MTM shows as a SEPARATE
  // "Open Opts P&L (unrealized)" figure so the two are no longer conflated.
  it('renders realized (row-sum) and unrealized options P&L as distinct figures', () => {
    render(
      <DashboardFooter
        account={account}
        optionsState={{
          openOptions: [], closedOptions: [],
          optionsPnl: -19_471, dailyOptionsPnl: -91.99,
          dailyRealizedOptionsPnl: 58.39, openOptionsUnrealizedPnl: -150.38,
          optionsCash: 64_224.32, dailyOptionsCount: 1,
        }}
      />,
    );
    // Realized pill reads the row-sum, not the blended dailyOptionsPnl and not
    // the cumulative optionsPnl.
    expect(screen.getByText('Daily Opts P&L (realized)')).toBeInTheDocument();
    expect(screen.getByText(/\+\$58\.39/)).toBeInTheDocument();
    // Unrealized shows separately.
    expect(screen.getByText('Open Opts P&L (unrealized)')).toBeInTheDocument();
    expect(screen.getByText(/-\$150\.38/)).toBeInTheDocument();
    // Neither the blended pill value nor the cumulative total leaks in.
    expect(screen.queryByText(/-\$91\.99/)).not.toBeInTheDocument();
    expect(screen.queryByText(/19,471/)).not.toBeInTheDocument();
  });

  // Back-compat: state without the split figures falls back to dailyOptionsPnl
  // for the realized pill and hides the unrealized figure entirely.
  it('falls back to dailyOptionsPnl and hides the unrealized pill for legacy state', () => {
    render(
      <DashboardFooter
        account={account}
        optionsState={{
          openOptions: [], closedOptions: [],
          optionsPnl: -19_471, dailyOptionsPnl: -91.99,
          optionsCash: 64_224.32, dailyOptionsCount: 1,
        }}
      />,
    );
    expect(screen.getByText('Daily Opts P&L (realized)')).toBeInTheDocument();
    expect(screen.getByText(/-\$91\.99/)).toBeInTheDocument();
    expect(screen.queryByText('Open Opts P&L (unrealized)')).not.toBeInTheDocument();
  });

  // Back-compat: a legacy snapshot without `dailyOptionsPnl` falls back to the
  // cumulative `optionsPnl` rather than rendering $NaN.
  it('falls back to optionsPnl when dailyOptionsPnl is missing', () => {
    render(
      <DashboardFooter
        account={account}
        optionsState={{
          openOptions: [], closedOptions: [],
          optionsPnl: 12.50, optionsCash: 25_000, dailyOptionsCount: 0,
        }}
      />,
    );
    expect(screen.getByText(/\+\$12\.50/)).toBeInTheDocument();
  });
});

describe('AccountSummaryCard (TRA-725)', () => {
  it('renders Tradier-parity fields when the live balance carries them', () => {
    render(
      <AccountSummaryCard
        account={{
          ...account, totalEquity: 816.35, availableCash: 225.35,
          optionBuyingPower: 0.06, settledFunds: 200.06,
          stockLongValue: 1, optionLongValue: 590, optionShortValue: 0,
        }}
        accountMode="live"
      />,
    );
    expect(screen.getByText('Account Summary')).toBeInTheDocument();
    // TRA-949 — the card reconciles to Total Value and reads buying power off
    // the broker balance ("Available Funds"), with per-asset-class market values.
    expect(screen.getByText('Total Value')).toBeInTheDocument();
    expect(screen.getByText('Available Funds')).toBeInTheDocument();
    expect(screen.getByText('Long Option Value')).toBeInTheDocument();
    // $816.35 Total Value and $590.00 Long Option Value come straight off the snapshot.
    expect(screen.getByText('$816.35')).toBeInTheDocument();
    expect(screen.getByText('$590.00')).toBeInTheDocument();
  });

  it('degrades live-only fields to "—" in demo (no broker balance)', () => {
    render(
      <AccountSummaryCard
        account={{ ...account, totalEquity: 10_000, availableCash: 5_000 }}
        accountMode="demo"
      />,
    );
    // Total Value / Cash still render; the live-only per-asset-class rows
    // (Long Stock, Long Option, Short Option Value) degrade to "—" in demo.
    expect(screen.getByText('Long Stock Value')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('renders nothing without an account snapshot', () => {
    const { container } = render(
      <AccountSummaryCard account={undefined} accountMode="demo" />,
    );
    expect(container).toBeEmptyDOMElement();
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

  // TRA-798 — the banner is rendered on both dashboards; `market` scopes it so
  // the crypto warning lives on the Crypto dashboard and the Tradier warning on
  // the Stocks dashboard, instead of every page surfacing every market's creds.
  it('market="crypto" surfaces only Coinbase fields, ignoring blank Tradier creds', () => {
    const broken: AccountSettings = {
      ...liveFullCreds(),
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
      liveApiKeyCrypto: '',
      liveApiSecretCrypto: '',
    };
    render(<LiveCredentialsBanner settings={broken} market="crypto" onOpenSettings={() => {}} />);
    expect(screen.getByText(/Coinbase API key/)).toBeInTheDocument();
    expect(screen.queryByText(/Tradier production API token/)).not.toBeInTheDocument();
  });

  it('market="stocks" surfaces only Tradier fields, ignoring blank Coinbase creds', () => {
    const broken: AccountSettings = {
      ...liveFullCreds(),
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
      liveApiKeyCrypto: '',
      liveApiSecretCrypto: '',
    };
    render(<LiveCredentialsBanner settings={broken} market="stocks" onOpenSettings={() => {}} />);
    expect(screen.getByText(/Tradier production API token/)).toBeInTheDocument();
    expect(screen.queryByText(/Coinbase API key/)).not.toBeInTheDocument();
  });

  it('market="crypto" renders nothing when only Tradier creds are blank', () => {
    const broken: AccountSettings = {
      ...liveFullCreds(),
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
    };
    const { container } = render(
      <LiveCredentialsBanner settings={broken} market="crypto" onOpenSettings={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
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

  // TRA-2246 — the "Clear halt" button POSTs reset-halt, which clears ONLY the
  // daily circuit-breaker. It must be offered for a daily_breaker halt…
  it('shows the "Clear halt" button for a daily_breaker halt', () => {
    render(
      <HaltBanner
        halted={true}
        reason="3 consecutive losses — no new entries for the day"
        haltKind="daily_breaker"
        onClearHalt={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Clear halt/i })).toBeInTheDocument();
    expect(screen.queryByTestId('halt-daylatched-note')).not.toBeInTheDocument();
  });

  // …but NOT for a day-latched book give-back / session-stop halt, where reset-halt
  // is a no-op (the reported bug). Those show a "lifts next day" note instead.
  it('hides "Clear halt" and shows a lifts-next-day note for a book give-back halt', () => {
    render(
      <HaltBanner
        halted={true}
        reason="Book give-back cap — surrendered >40% of the day's +$89 peak (floor +$53); no new entries for the day"
        haltKind="book_giveback"
        onClearHalt={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Clear halt/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('halt-daylatched-note')).toHaveTextContent(/next trading day/i);
  });

  it('also hides "Clear halt" for a session-stop halt', () => {
    render(
      <HaltBanner
        halted={true}
        reason="Book session stop — net-negative after being up ≥ 0.50% of book equity; no new entries for the day"
        haltKind="session_stop"
        onClearHalt={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Clear halt/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('halt-daylatched-note')).toBeInTheDocument();
  });

  // Backward-compat: an older server sends no haltKind → prior !isKillSwitch behavior.
  it('still shows "Clear halt" when haltKind is absent (legacy server)', () => {
    render(<HaltBanner halted={true} reason="Daily drawdown limit hit" onClearHalt={() => {}} />);
    expect(screen.getByRole('button', { name: /Clear halt/i })).toBeInTheDocument();
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

// TRA-544 — the "Trading Agents" banner toggle. Confirms both flip directions
// gate behind a confirm dialog and POST the runtime flag to the engine.
describe('TradingAgentsButton (TRA-544)', () => {
  it('renders the idle label when off and the ON label when enabled', () => {
    const { rerender } = renderWithToast(<TradingAgentsButton token="t" enabled={false} />);
    expect(screen.getByRole('button', { name: /Trading Agents$/ })).toBeInTheDocument();
    rerender(<ToastProvider><TradingAgentsButton token="t" enabled={true} /></ToastProvider>);
    expect(screen.getByRole('button', { name: /Trading Agents ON/ })).toBeInTheDocument();
  });

  it('does NOT POST when the confirm dialog is dismissed (mode-switch guard)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderWithToast(<TradingAgentsButton token="t" enabled={false} />);
    await userEvent.click(screen.getByRole('button', { name: /Trading Agents$/ }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs { enabled: true } after confirm and flips to ON', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const onToggled = vi.fn();
    renderWithToast(<TradingAgentsButton token="t" enabled={false} onToggled={onToggled} />);
    await userEvent.click(screen.getByRole('button', { name: /Trading Agents$/ }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/trading\/trading-agents$/);
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ enabled: true });
    expect(onToggled).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('button', { name: /Trading Agents ON/ })).toBeInTheDocument();
  });

  it('switching OFF also confirms, then POSTs { enabled: false }', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    renderWithToast(<TradingAgentsButton token="t" enabled={true} />);
    await userEvent.click(screen.getByRole('button', { name: /Trading Agents ON/ }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ enabled: false });
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

describe('HealthPanel (TRA-539)', () => {
  const build = {
    version: '0.0.0', commit: 'a'.repeat(40), commitShort: 'aaaaaaaaaaaa', branch: 'main',
    buildTime: '2026-06-03T00:00:00.000Z', commitSource: 'env' as const,
    nodeVersion: 'v20.0.0', pid: 1234, startedAt: '2026-06-03T00:00:00.000Z', uptimeSec: 3661,
  };

  // A clean GREEN snapshot the way /api/health/live returns it.
  const green = {
    status: 'green', mode: 'demo', broker: { env: 'sandbox', authOk: true, missingCredentials: [] },
    autoTradingEnabled: true, tradingHalted: false, haltReason: null, marketOpen: false,
    feed: { trackedSymbols: 5, freshSymbols: 5, staleSymbols: 0, neverQuoted: 0, lastTickAgeSec: 10, stale: false },
    issues: [], build, time: '2026-06-03T12:00:00.000Z',
  };

  // RED: live with missing broker creds + market-open feed stale.
  const red = {
    status: 'red', mode: 'live', broker: { env: 'production', authOk: false, missingCredentials: ['liveTradierToken'] },
    autoTradingEnabled: false, tradingHalted: true, haltReason: 'Kill switch engaged', marketOpen: true,
    feed: { trackedSymbols: 4, freshSymbols: 0, staleSymbols: 4, neverQuoted: 0, lastTickAgeSec: 420, stale: true },
    issues: [
      'Live mode but broker credentials missing: liveTradierToken',
      'Market open but data feed is stale (0/4 symbols fresh)',
      'Trading halted: Kill switch engaged',
    ],
    build, time: '2026-06-03T12:00:00.000Z',
  };

  function stubHealth(payload: unknown) {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))));
  }

  it('renders the GREEN banner with a clear no-issues message and build panel', async () => {
    stubHealth(green);
    render(<HealthPanel token="t" />);
    const banner = await screen.findByTestId('health-banner');
    expect(banner).toHaveTextContent('GREEN');
    expect(screen.getByText(/the live trading path is healthy/i)).toBeInTheDocument();
    // Build panel surfaces the running commit verbatim.
    expect(screen.getByText('aaaaaaaaaaaa')).toBeInTheDocument();
  });

  it('renders the RED banner and the API issues list verbatim', async () => {
    stubHealth(red);
    render(<HealthPanel token="t" />);
    const banner = await screen.findByTestId('health-banner');
    expect(banner).toHaveTextContent('RED');
    // Every API issue string is surfaced, worst-first, not recomputed.
    expect(screen.getByText('Live mode but broker credentials missing: liveTradierToken')).toBeInTheDocument();
    expect(screen.getByText('Market open but data feed is stale (0/4 symbols fresh)')).toBeInTheDocument();
    // Missing-credential names are surfaced in the broker panel.
    expect(screen.getByText('liveTradierToken')).toBeInTheDocument();
    // Halt reason from the trading-state panel.
    expect(screen.getByText('Kill switch engaged')).toBeInTheDocument();
  });

  it('surfaces an error when the live-health endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 503 }))));
    render(<HealthPanel token="t" />);
    expect(await screen.findByText(/Could not load live health/)).toBeInTheDocument();
  });
});

describe('VersionChip (TRA-539)', () => {
  const build = {
    version: '0.0.0', commit: 'b'.repeat(40), commitShort: 'bbbbbbbbbbbb', branch: 'main',
    buildTime: '2026-06-03T00:00:00.000Z', commitSource: 'env' as const,
    nodeVersion: 'v20.0.0', pid: 99, startedAt: '2026-06-03T00:00:00.000Z', uptimeSec: 120,
  };

  it('formatUptime renders compact human durations', () => {
    expect(formatUptime(45)).toBe('45s');
    expect(formatUptime(125)).toBe('2m 5s');
    expect(formatUptime(3661)).toBe('1h 1m');
    expect(formatUptime(90_000)).toBe('1d 1h');
    expect(formatUptime(-1)).toBe('—');
  });

  it('shows the running commit short SHA from /api/health/version', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(build), { status: 200 }))));
    render(<VersionChip />);
    expect(await screen.findByText('bbbbbbbbbbbb')).toBeInTheDocument();
  });

  it('falls back to a "build ?" chip when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    render(<VersionChip />);
    expect(await screen.findByText('build ?')).toBeInTheDocument();
  });

  // TRA-545 — a healthy fetch that returns a non-OK status (e.g. a stale
  // binary 500ing on /api/health/version) is a different failure than an
  // unreachable server, so the chip shows a distinct "build !" label.
  it('shows a "build !" chip when the build endpoint returns a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('boom', { status: 500 }))));
    render(<VersionChip />);
    const chip = await screen.findByText('build !');
    expect(chip).toBeInTheDocument();
    expect(chip.getAttribute('title')).toContain('HTTP 500');
  });

  // TRA-545 — a failed first load must not look permanent: the chip retries on
  // a short backoff and recovers to the running SHA without a page reload.
  it('retries after a transient failure and recovers the running commit', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(new Response(JSON.stringify(build), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      render(<VersionChip />);
      // First load rejects → unreachable chip.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('build ?')).toBeInTheDocument();
      // Backoff fires the retry (RETRY_BASE_MS = 2s), which succeeds.
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(screen.getByText('bbbbbbbbbbbb')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
