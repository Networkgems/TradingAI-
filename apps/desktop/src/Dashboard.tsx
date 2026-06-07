// TRA-422 — Stocks dashboard composition root. The 1,468-line monolith this
// file used to be was split into panel components under
// `components/dashboard/` plus the `useStockEngine` / `useStockOptionClose`
// hooks; this file now only owns the tab + profile-modal state and wires the
// pieces together. Behaviour (toast feedback, focus-trapped close drawer, sort
// hooks, backoff/validation libs from TRA-419) carries through unchanged.
import { useEffect, useState } from 'react';
import type { LiveCredentialField } from '@trading-app/shared';
import { HTTP_URL } from './server-url';
import {
  consumeBrokerDeepLink,
  OPEN_BROKER_SETTINGS_EVENT,
} from './lib/onboarding-deep-link';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { CalendarTab } from './CalendarTab.tsx';
import type { Theme } from './components/ThemeToggle';
import { DashboardHeader } from './components/dashboard/DashboardHeader';
import { TabBar } from './components/dashboard/TabBar';
import { ProfileModals } from './components/dashboard/ProfileModals';
import type { ProfileModal } from './components/dashboard/ProfileModals';
import { StockWatchlistPanel } from './components/dashboard/StockWatchlistPanel';
import { StockSignalsPanel } from './components/dashboard/StockSignalsPanel';
import { StockPositionsPanel } from './components/dashboard/StockPositionsPanel';
import { StockOptionsPanel } from './components/dashboard/StockOptionsPanel';
import { AiOptionsIdeasPanel } from './components/dashboard/AiOptionsIdeasPanel';
import { NewsPanel } from './components/dashboard/NewsPanel';
import { LiveCredentialsBanner } from './components/dashboard/LiveCredentialsBanner';
import { HaltBanner } from './components/dashboard/HaltBanner';
import { HealthPanel } from './components/dashboard/HealthPanel';
import { DashboardTour } from './components/onboarding/CoachMarkTour';
import { useStockEngine } from './hooks/useStockEngine';

// TRA-600 — 'ideas' is the new "AI Options Ideas" surface (Phase 3 of TRA-595).
type StockTab = 'watchlist' | 'signals' | 'positions' | 'options' | 'ideas' | 'news' | 'calendar' | 'health';

export default function Dashboard({ token, onLogout, onGoHome, onActivity, theme, onToggleTheme }: { token: string; onLogout: () => void; onGoHome: () => void; onActivity?: () => void; theme: Theme; onToggleTheme: () => void }) {
  const [tab, setTab] = useState<StockTab>('watchlist');
  const [profileModal, setProfileModal] = useState<ProfileModal | null>(null);
  // TRA-506 — the banner deep-links into Settings with a specific input
  // focused. Tracked here so the modal can read it on open and clear it
  // on close, without leaking the focus hint into the URL.
  const [focusCredField, setFocusCredField] = useState<LiveCredentialField | null>(null);

  // TRA-565 — onboarding "Open broker settings" deep-link. Open Settings when
  // a breadcrumb is pending on mount (the dashboard was just mounted by the
  // wizard) or when an already-mounted dashboard receives the event.
  useEffect(() => {
    function openBrokerSettings() {
      setProfileModal('settings');
    }
    if (consumeBrokerDeepLink()) openBrokerSettings();
    const onEvent = () => {
      consumeBrokerDeepLink();
      openBrokerSettings();
    };
    window.addEventListener(OPEN_BROKER_SETTINGS_EVENT, onEvent);
    return () => window.removeEventListener(OPEN_BROKER_SETTINGS_EVENT, onEvent);
  }, []);

  const {
    state, connected, news, isAdmin,
    accountMode, setAccountMode, tradierEnv, optionsDailyLimit,
    accountSettings, applyAccountSettings,
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
        killSwitchEngaged={accountSettings?.globalKillSwitchEngaged ?? false}
        tradingAgentsEnabled={state?.tradingAgentsEnabled ?? accountSettings?.tradingAgentsEnabled ?? false}
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
        onClose={() => { setProfileModal(null); setFocusCredField(null); }}
        token={token}
        httpUrl={HTTP_URL}
        context="stocks"
        isAdmin={isAdmin}
        onModeChange={setAccountMode}
        onSettingsSaved={applyAccountSettings}
        onLogout={onLogout}
        focusCredField={focusCredField}
      />

      {/* TRA-506 — persistent guardrail when the user is live but a required
          broker credential is empty. Renders nothing in demo or when every
          required cred is filled. */}
      <LiveCredentialsBanner
        settings={accountSettings}
        onOpenSettings={(field) => { setFocusCredField(field); setProfileModal('settings'); }}
      />

      {/* TRA-535 — halt banner. `tradingHalted`/`haltReason` from /api/state
          reflect the TRA-526 kill switch (reason takes precedence over the
          daily circuit-breakers) and update live over the WebSocket. */}
      <HaltBanner halted={state?.tradingHalted ?? false} reason={state?.haltReason ?? null} />

      {/* TRA-690 — grouped nav: the core trading workflow (Watchlist → Signals →
          Positions → Options → AI Ideas) stays flat; reference/utility surfaces
          (News, Calendar, Health) collapse into a "More ▾" dropdown so the bar
          stays clean as features are added. The Calendar coach-mark anchor
          (TRA-569 design §3.3) rides on the More trigger so the tour's last stop
          still resolves to a visible element. */}
      <TabBar
        active={tab}
        onSelect={setTab}
        moreTour="calendar"
        primary={[
          // TRA-569 — Signals/Positions coach-mark anchors point at their tabs.
          { id: 'watchlist', label: `Watchlist (${symbols.length})` },
          { id: 'signals', label: `Signals (${signals.length})`, dataTour: 'signals' },
          { id: 'positions', label: `Positions (${openPositions.length})`, dataTour: 'positions' },
          { id: 'options', label: `Options (${openOptions.length})` },
          // TRA-600 — event-aware "AI Options Ideas" surface (Phase 3 of TRA-595).
          { id: 'ideas', label: 'AI Ideas', title: 'Ranked, defined-risk options ideas with earnings/Fed event context — paper entry only' },
        ]}
        more={[
          { id: 'news', label: `News (${news.length})` },
          { id: 'calendar', label: 'Calendar' },
          // TRA-539 — live reliability dashboard (TRA-528 /api/health/live).
          { id: 'health', label: 'Health' },
        ]}
      />

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
          <StockPositionsPanel
            token={token}
            openPositions={openPositions}
            closedPositions={closedPositions}
            symbols={symbols}
            accountMode={accountMode}
            tradierEnv={tradierEnv}
          />
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

        {/* TRA-600 — the AI Options Ideas tab reads its own /api/options/ideas
            feed (lands with C4) and falls back to a clearly-labelled preview
            until then, so it renders without waiting for the engine snapshot. */}
        {tab === 'ideas' && (
          <AiOptionsIdeasPanel token={token} />
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

        {/* TRA-539 — the Health tab reads its own `/api/health/live` endpoint
            and is independent of the WebSocket engine snapshot, so it renders
            without waiting for `state` (the surface that diagnoses a dead Live
            session must work even when the engine feed is the thing that's
            broken). */}
        {tab === 'health' && (
          <HealthPanel token={token} />
        )}
       </ErrorBoundary>
      </main>

      {/* TRA-569 (TRA-410 C2) — coach-mark tour. Self-contained: starts on the
          replay event (profile menu) or the first-run autostart breadcrumb.
          Renders nothing until then. */}
      <DashboardTour />
    </div>
  );
}
