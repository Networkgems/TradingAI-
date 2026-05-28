// TRA-422 — Stocks dashboard composition root. The 1,468-line monolith this
// file used to be was split into panel components under
// `components/dashboard/` plus the `useStockEngine` / `useStockOptionClose`
// hooks; this file now only owns the tab + profile-modal state and wires the
// pieces together. Behaviour (toast feedback, focus-trapped close drawer, sort
// hooks, backoff/validation libs from TRA-419) carries through unchanged.
import { useState } from 'react';
import { HTTP_URL } from './server-url';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { CalendarTab } from './CalendarTab.tsx';
import type { Theme } from './components/ThemeToggle';
import { DashboardHeader } from './components/dashboard/DashboardHeader';
import { ProfileModals } from './components/dashboard/ProfileModals';
import type { ProfileModal } from './components/dashboard/ProfileModals';
import { StockWatchlistPanel } from './components/dashboard/StockWatchlistPanel';
import { StockSignalsPanel } from './components/dashboard/StockSignalsPanel';
import { StockPositionsPanel } from './components/dashboard/StockPositionsPanel';
import { StockOptionsPanel } from './components/dashboard/StockOptionsPanel';
import { NewsPanel } from './components/dashboard/NewsPanel';
import { useStockEngine } from './hooks/useStockEngine';

type StockTab = 'watchlist' | 'signals' | 'positions' | 'options' | 'news' | 'calendar';

export default function Dashboard({ token, onLogout, onGoHome, onActivity, theme, onToggleTheme }: { token: string; onLogout: () => void; onGoHome: () => void; onActivity?: () => void; theme: Theme; onToggleTheme: () => void }) {
  const [tab, setTab] = useState<StockTab>('watchlist');
  const [profileModal, setProfileModal] = useState<ProfileModal | null>(null);

  const {
    state, connected, news, isAdmin,
    accountMode, setAccountMode, tradierEnv, optionsDailyLimit, applyAccountSettings,
  } = useStockEngine(token, tab, onLogout, onActivity);

  const account = state?.account;
  const signals = state?.signals ?? [];
  const symbols = state?.symbols ?? [];
  const openPositions = account?.openPositions ?? [];
  // TRA-238 — closed trades stay visible in the Positions/Options tabs until
  // the 9:00 PM ET archive sweep clears them server-side.
  const closedPositions = state?.closedPositions ?? [];
  const optionsState = state?.options;
  const openOptions = optionsState?.openOptions ?? [];
  const closedOptions = optionsState?.closedOptions ?? [];
  const autoTradingEnabled = state?.autoTradingEnabled ?? true;

  return (
    <div className="app">
      <DashboardHeader
        token={token}
        account={account}
        optionsState={optionsState}
        openPositionsCount={openPositions.length}
        openOptionsCount={openOptions.length}
        optionsDailyLimit={optionsDailyLimit}
        connected={connected}
        lastTick={state?.lastTick}
        autoTradingEnabled={autoTradingEnabled}
        accountMode={accountMode}
        onAccountModeChange={setAccountMode}
        theme={theme}
        onToggleTheme={onToggleTheme}
        isAdmin={isAdmin}
        onOpenProfileModal={setProfileModal}
        onGoHome={onGoHome}
        onLogout={onLogout}
      />

      <ProfileModals
        which={profileModal}
        onClose={() => setProfileModal(null)}
        token={token}
        httpUrl={HTTP_URL}
        context="stocks"
        isAdmin={isAdmin}
        onModeChange={setAccountMode}
        onSettingsSaved={applyAccountSettings}
        onLogout={onLogout}
      />

      <nav className="tabs">
        {/* TRA-503 — Positions tab is shown in every account/env so Live + Tradier
            Production matches Demo. The earlier TRA-326 carve-out hid it on
            Live+Production. */}
        {(['watchlist', 'signals', 'positions', 'options'] as const).map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'watchlist' ? `Watchlist (${symbols.length})` :
             t === 'signals' ? `Signals (${signals.length})` :
             t === 'positions' ? `Positions (${openPositions.length})` :
             `Options (${openOptions.length})`}
          </button>
        ))}
        <button className={`tab ${tab === 'news' ? 'active' : ''}`} onClick={() => setTab('news')}>
          {`News (${news.length})`}
        </button>
        <button className={`tab ${tab === 'calendar' ? 'active' : ''}`} onClick={() => setTab('calendar')}>
          Calendar
        </button>
      </nav>

      <main className="content">
       {/* TRA-398 — per-tab error boundary. `key={tab}` remounts it on tab
           switch so a render crash in one tab cannot white-screen the app. */}
       <ErrorBoundary key={tab} label={`stocks:${tab}`} variant="panel">
        {!state && (
          <div className="loading">
            <div className="spinner" />
            <p>Connecting to trading engine…</p>
          </div>
        )}

        {state && tab === 'watchlist' && (
          <StockWatchlistPanel token={token} symbols={symbols} />
        )}

        {state && tab === 'signals' && (
          <StockSignalsPanel token={token} signals={signals} symbols={symbols} marketReview={state.marketReview} />
        )}

        {state && tab === 'positions' && (
          <StockPositionsPanel token={token} openPositions={openPositions} closedPositions={closedPositions} symbols={symbols} />
        )}

        {state && tab === 'options' && (
          <StockOptionsPanel
            token={token}
            tradierEnv={tradierEnv}
            accountMode={accountMode}
            account={account}
            optionsState={optionsState}
            openOptions={openOptions}
            closedOptions={closedOptions}
            optionsDailyLimit={optionsDailyLimit}
          />
        )}

        {tab === 'news' && (
          <NewsPanel news={news} loadingText="Loading market news…" />
        )}

        {tab === 'calendar' && (
          <CalendarTab
            token={token}
            httpUrl={HTTP_URL}
            mode={
              accountMode === 'demo'
                ? 'demo'
                : tradierEnv === 'production' ? 'live' : 'sandbox'
            }
          />
        )}
       </ErrorBoundary>
      </main>
    </div>
  );
}
