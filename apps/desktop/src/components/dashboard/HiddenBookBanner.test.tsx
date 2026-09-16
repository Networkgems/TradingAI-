// TRA-4502 (parent TRA-4284) — the operator-facing half of "say what you are
// hiding". The first test is the measured defect reproduced through the UI: a
// live-armed account with `viewMode: "demo"`, three breached real-money rows in
// the book that is not on screen. Everything after it exists to keep the fix
// from crying wolf — a banner up every day is a banner nobody reads.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { AccountState, HiddenBookExposure } from '@trading-app/shared';
import { ToastProvider } from '../../lib/toast.tsx';
import { HiddenBookBanner, hiddenBookChipSuffix, hiddenBookStopLine } from './HiddenBookBanner';
import { DashboardHeader } from './DashboardHeader';

function renderWithToast(ui: ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

const ACCOUNT: AccountState = {
  totalEquity: 0,
  availableCash: 0,
  openPositions: [],
  dailyPnl: 0,
};

/** The bqb1 `admin` shape as measured 2026-09-01 (TRA-4284). */
const BREACHED: HiddenBookExposure = {
  book: 'live',
  shownBook: 'demo',
  openOptionRows: 3,
  openPremiumUsd: 358,
  unpricedRows: 0,
  stops: {
    breached: 3,
    actionable: 0,
    inFlight: 0,
    inert: 3,
    unacted: 3,
    indefinite: 3,
    inertReasons: [{ reason: 'close_reject_breaker', count: 3 }],
    releasesAt: null,
    exitPassBlockedBy: null,
  },
  stopsUnavailableReason: null,
};

const QUIET: HiddenBookExposure = {
  book: 'live',
  shownBook: 'demo',
  openOptionRows: 2,
  openPremiumUsd: 691,
  unpricedRows: 0,
  stops: {
    breached: 0,
    actionable: 0,
    inFlight: 0,
    inert: 0,
    unacted: 0,
    indefinite: 0,
    inertReasons: [],
    releasesAt: null,
    exitPassBlockedBy: null,
  },
  stopsUnavailableReason: null,
};

describe('HiddenBookBanner', () => {
  it('escalates a breached hidden LIVE book to a banner-level alert', () => {
    render(<HiddenBookBanner exposure={BREACHED} />);
    const banner = screen.getByTestId('hidden-book-banner');
    // Acceptance 2: banner, and an assistive-tech alert — not a chip.
    expect(banner).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('hidden-book-banner-headline')).toHaveTextContent(
      /3 rows past their stop in the LIVE book/i,
    );
    const detail = screen.getByTestId('hidden-book-banner-detail');
    // Acceptance 1: the count, the dollars, the breach, and the inert REASON —
    // a count alone cannot tell an operator which gate to go clear.
    expect(detail).toHaveTextContent(/3 rows/);
    expect(detail).toHaveTextContent(/\$358\.00/);
    expect(detail).toHaveTextContent(/3 the engine will NOT act on/);
    expect(detail).toHaveTextContent(/close_reject_breaker ×3/);
    expect(detail).toHaveTextContent(/need a human/);
  });

  it('stays silent on a hidden LIVE book whose census reports nothing wrong', () => {
    render(<HiddenBookBanner exposure={QUIET} />);
    expect(screen.queryByTestId('hidden-book-banner')).not.toBeInTheDocument();
  });

  it('stays silent when no override is set (no exposure on the frame)', () => {
    render(<HiddenBookBanner exposure={null} />);
    expect(screen.queryByTestId('hidden-book-banner')).not.toBeInTheDocument();
  });

  it('never banners a hidden DEMO book, however large', () => {
    render(
      <HiddenBookBanner
        exposure={{
          book: 'demo',
          shownBook: 'live',
          openOptionRows: 12,
          openPremiumUsd: 42_000,
          unpricedRows: 0,
          stops: null,
          stopsUnavailableReason: 'hidden_book_is_demo',
        }}
      />,
    );
    expect(screen.queryByTestId('hidden-book-banner')).not.toBeInTheDocument();
  });

  it('banners a hidden LIVE book whose stop census is UNAVAILABLE', () => {
    render(
      <HiddenBookBanner
        exposure={{
          ...BREACHED,
          stops: null,
          stopsUnavailableReason: 'census_failed: boom',
        }}
      />,
    );
    // Blind is not clean: we cannot say the money book is fine.
    expect(screen.getByTestId('hidden-book-banner-detail')).toHaveTextContent(
      /stop census for the hidden LIVE book is unavailable \(census_failed: boom\)/i,
    );
    expect(screen.getByTestId('hidden-book-banner-detail')).toHaveTextContent(/UNVERIFIED/);
  });

  it('says the dollars UNDERSTATE when a row could not be priced', () => {
    render(
      <HiddenBookBanner exposure={{ ...BREACHED, openOptionRows: 4, unpricedRows: 1 }} />,
    );
    expect(screen.getByTestId('hidden-book-banner-detail')).toHaveTextContent(/1 unpriced/);
    expect(screen.getByTestId('hidden-book-banner-detail')).toHaveTextContent(/UNDERSTATES/);
  });

  it('offers no control of its own — the header toggle is the one view write', () => {
    render(<HiddenBookBanner exposure={BREACHED} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('hiddenBookStopLine', () => {
  it('names the cadence blocker when no exit pass reaches the hidden book', () => {
    const line = hiddenBookStopLine({
      ...BREACHED,
      stops: {
        ...BREACHED.stops!,
        breached: 1,
        actionable: 1,
        inert: 0,
        unacted: 1,
        indefinite: 0,
        inertReasons: [],
        exitPassBlockedBy: 'market_closed',
      },
    });
    // TRA-3839 — `inert: 0` is not an all-clear when nothing is running.
    expect(line).toMatch(/1 the engine will NOT act on/);
    expect(line).toMatch(/no exit pass reaches this book \(market_closed\)/);
  });

  it('prefers "needs a human" over a release timestamp when both could apply', () => {
    const line = hiddenBookStopLine({
      ...BREACHED,
      stops: { ...BREACHED.stops!, indefinite: 2, releasesAt: '2026-09-02T00:00:00.000Z' },
    });
    expect(line).toMatch(/2 need a human/);
    expect(line).not.toMatch(/2026-09-02/);
  });

  it('publishes the release horizon when every inert row is on a clock', () => {
    const line = hiddenBookStopLine({
      ...BREACHED,
      stops: { ...BREACHED.stops!, indefinite: 0, releasesAt: '2026-09-02T00:00:00.000Z' },
    });
    expect(line).toMatch(/earliest automatic release 2026-09-02T00:00:00.000Z/);
  });
});

describe('hiddenBookChipSuffix', () => {
  it('states the hidden row count and dollars even when nothing is wrong', () => {
    // Acceptance 1 is a COUNT, not an alarm. This clause is what makes the
    // breached reading legible when it arrives.
    expect(hiddenBookChipSuffix(QUIET)).toBe('2 open LIVE rows ($691.00)');
  });

  it('flags breached and unactionable rows inline', () => {
    expect(hiddenBookChipSuffix(BREACHED)).toBe('3 open LIVE rows ($358.00) · 3 breached, 3 unactionable');
  });

  it('says a hidden LIVE book is flat rather than saying nothing', () => {
    expect(hiddenBookChipSuffix({ ...QUIET, openOptionRows: 0, openPremiumUsd: 0 }))
      .toBe('0 open LIVE rows');
  });

  it('appends nothing when the frame carries no exposure (pre-TRA-4502 server)', () => {
    expect(hiddenBookChipSuffix(undefined)).toBeNull();
    expect(hiddenBookChipSuffix(null)).toBeNull();
  });
});

describe('DashboardHeader — TRA-3910 chip carries the TRA-4502 exposure clause', () => {
  it('keeps the routing statement and adds the exposure statement', () => {
    renderWithToast(
      <DashboardHeader
        token="t" account={ACCOUNT} optionsState={undefined}
        openPositionsCount={0} openOptionsCount={0} optionsDailyLimit={5}
        connected={true} lastTick={Date.now()} autoTradingEnabled={true}
        killSwitchEngaged={false} tradingAgentsEnabled={false}
        accountMode="demo" engineMode="live" liveBrokerArmPinned={true}
        hiddenBookExposure={BREACHED}
        onAccountModeChange={() => {}}
        theme="dark" onToggleTheme={() => {}} isAdmin={false}
        onOpenProfileModal={() => {}} onGoHome={() => {}} onLogout={() => {}}
      />,
    );
    // TRA-3910's statement is unchanged — it was never wrong, only incomplete.
    expect(screen.getByTestId('book-view-banner')).toHaveTextContent(
      /Viewing DEMO book · engine is LIVE/,
    );
    expect(screen.getByTestId('book-view-exposure')).toHaveTextContent(
      /3 open LIVE rows \(\$358\.00\) · 3 breached, 3 unactionable/,
    );
    // The census detail rides the tooltip, so the reasons are reachable from
    // the chip too and not only from the banner.
    expect(screen.getByTestId('book-view-banner')).toHaveAttribute(
      'title',
      expect.stringContaining('close_reject_breaker ×3'),
    );
  });

  it('renders the TRA-3910 chip exactly as before when the frame has no exposure', () => {
    renderWithToast(
      <DashboardHeader
        token="t" account={ACCOUNT} optionsState={undefined}
        openPositionsCount={0} openOptionsCount={0} optionsDailyLimit={5}
        connected={true} lastTick={Date.now()} autoTradingEnabled={true}
        killSwitchEngaged={false} tradingAgentsEnabled={false}
        accountMode="demo" engineMode="live" liveBrokerArmPinned={true}
        onAccountModeChange={() => {}}
        theme="dark" onToggleTheme={() => {}} isAdmin={false}
        onOpenProfileModal={() => {}} onGoHome={() => {}} onLogout={() => {}}
      />,
    );
    expect(screen.getByTestId('book-view-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('book-view-exposure')).not.toBeInTheDocument();
  });

  it('shows no chip at all when the view follows the engine (acceptance 4: feature intact)', () => {
    renderWithToast(
      <DashboardHeader
        token="t" account={ACCOUNT} optionsState={undefined}
        openPositionsCount={0} openOptionsCount={0} optionsDailyLimit={5}
        connected={true} lastTick={Date.now()} autoTradingEnabled={true}
        killSwitchEngaged={false} tradingAgentsEnabled={false}
        accountMode="live" engineMode="live"
        onAccountModeChange={() => {}}
        theme="dark" onToggleTheme={() => {}} isAdmin={false}
        onOpenProfileModal={() => {}} onGoHome={() => {}} onLogout={() => {}}
      />,
    );
    expect(screen.queryByTestId('book-view-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('book-view-exposure')).not.toBeInTheDocument();
  });
});
