// TRA-422 — Stocks dashboard composition root. The 1,468-line monolith this
// file used to be was split into panel components under
// `components/dashboard/` plus the `useStockEngine` / `useStockOptionClose`
// hooks; this file now only owns the tab + profile-modal state and wires the
// pieces together. Behaviour (toast feedback, focus-trapped close drawer, sort
// hooks, backoff/validation libs from TRA-419) carries through unchanged.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
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
import { DashboardFooter } from './components/dashboard/DashboardFooter';
import { TabBar } from './components/dashboard/TabBar';
import { ProfileModals } from './components/dashboard/ProfileModals';
import type { ProfileModal } from './components/dashboard/ProfileModals';
import { StockWatchlistPanel } from './components/dashboard/StockWatchlistPanel';
import { StockSignalsPanel } from './components/dashboard/StockSignalsPanel';
import { SwingSignalsPanel } from './components/dashboard/SwingSignalsPanel';
import { PendingProposalsPanel } from './components/dashboard/PendingProposalsPanel';
import { StockPositionsPanel } from './components/dashboard/StockPositionsPanel';
import { StockOptionsPanel } from './components/dashboard/StockOptionsPanel';
import { AiOptionsIdeasPanel } from './components/dashboard/AiOptionsIdeasPanel';
import { OtmMispricingPanel } from './components/dashboard/OtmMispricingPanel';
import { NewsPanel } from './components/dashboard/NewsPanel';
import { LiveCredentialsBanner } from './components/dashboard/LiveCredentialsBanner';
import { HaltBanner } from './components/dashboard/HaltBanner';
import { HiddenBookBanner } from './components/dashboard/HiddenBookBanner';
import { HealthPanel } from './components/dashboard/HealthPanel';
import { PromotionGatePanel } from './components/dashboard/PromotionGatePanel';
import { ValidationProgressPanel } from './components/dashboard/ValidationProgressPanel';
import { DiagnosticsView } from './components/dashboard/DiagnosticsView';
import type { DiagnosticsItem } from './components/dashboard/DiagnosticsView';
import { AccountSummaryCard } from './components/dashboard/AccountSummaryCard';
import { DashboardTour } from './components/onboarding/CoachMarkTour';
import { useStockEngine } from './hooks/useStockEngine';

// TRA-4729 (design TRA-4733) — two top-level views. `overview` is the primary
// screen and holds exactly five panels: Account/Risk, Proposals, Open
// Positions, OTM Mispricing, Validation Progress. Every other surface — the
// old flat tabs (Watchlist, Signals, Swing, AI Ideas, Calendar, News, Health,
// …) — moved behind `diagnostics`. Moved, not deleted: each is still one click
// away in the Diagnostics sidebar, rendered by the same component as before.
type StockView = 'overview' | 'diagnostics';
// TRA-600 'ideas' · TRA-161 'otm' · TRA-4626 'swing' · TRA-539 'health' ·
// TRA-1158 'calendar' — the pre-TRA-4729 tab ids, now Diagnostics sub-panels.
type DiagnosticsTab =
  | 'health' | 'validation' | 'promotion'
  | 'watchlist' | 'signals' | 'swing' | 'positions'
  | 'ideas' | 'otm'
  | 'calendar' | 'news';

export default function Dashboard({ token, onLogout, onGoHome, onActivity, theme, onToggleTheme }: { token: string; onLogout: () => void; onGoHome: () => void; onActivity?: () => void; theme: Theme; onToggleTheme: () => void }) {
  const [view, setView] = useState<StockView>('overview');
  // Spec §6 Q1 — Health is the default Diagnostics sub-panel.
  const [diagTab, setDiagTab] = useState<DiagnosticsTab>('health');
  // `useStockEngine` refreshes settings whenever this key changes, exactly as
  // it did on every old tab switch.
  const tab = view === 'overview' ? 'overview' : diagTab;
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
    accountMode, setAccountMode, engineMode, liveBrokerArmPinned, tradierEnv, optionsDailyLimit,
    accountSettings, applyAccountSettings,
  } = useStockEngine(token, tab, onLogout, onActivity);

  const account = state?.account;
  const signals = state?.signals ?? [];
  const swingSignals = state?.swingSignals ?? [];
  const symbols = state?.symbols ?? [];
  const openPositions = account?.openPositions ?? [];
  // TRA-238 — closed trades stay visible in the Positions/Options tabs until
  // the 9:00 PM ET archive sweep clears them server-side.
  const closedPositions = state?.closedPositions ?? [];
  const optionsState = state?.options;
  const openOptions = optionsState?.openOptions ?? [];
  const closedOptions = optionsState?.closedOptions ?? [];
  const autoTradingEnabled = state?.autoTradingEnabled ?? true;
  const killSwitchEngaged = accountSettings?.globalKillSwitchEngaged ?? false;

  // Engine-snapshot panels show the same "connecting" state the old tabs did
  // until the first WebSocket frame lands; the self-fetching ones (Health,
  // Validation, Promotion, AI Ideas, OTM, News, Calendar) render without it.
  const needsState = (node: () => ReactNode) => () => state ? node() : (
    <div className="loading">
      <div className="spinner" />
      <p>Connecting to trading engine…</p>
    </div>
  );

  const diagnosticsItems: DiagnosticsItem<DiagnosticsTab>[] = [
    // TRA-539 — reads its own /api/health/live, independent of the engine feed,
    // so the surface that diagnoses a dead session works when the feed is dead.
    { id: 'health', section: 'Core', label: 'Health', render: () => <HealthPanel token={token} /> },
    { id: 'validation', section: 'Core', label: 'Validation Progress', render: () => <ValidationProgressPanel token={token} /> },
    { id: 'promotion', section: 'Core', label: 'Promotion Gate', render: () => <PromotionGatePanel token={token} /> },
    { id: 'watchlist', section: 'Market & signals', label: `Watchlist (${symbols.length})`, render: needsState(() => <StockWatchlistPanel token={token} symbols={symbols} />) },
    { id: 'signals', section: 'Market & signals', label: `Signals (${signals.length})`, render: needsState(() => state && <StockSignalsPanel token={token} signals={signals} symbols={symbols} marketReview={state.marketReview} lastScanAt={state.lastScanAt} marketOpen={state.marketOpen} />) },
    // TRA-4626 — swing signal fusion engine candidates (ranked 0-100).
    { id: 'swing', section: 'Market & signals', label: `Swing (${swingSignals.length})`, title: 'Ranked swing trade options signals with composite scoring — observe-only', render: needsState(() => state && <SwingSignalsPanel swingSignals={swingSignals} summary={state.swingScanSummary} />) },
    { id: 'positions', section: 'Market & signals', label: `Equity positions (${openPositions.length})`, render: needsState(() => (
      <StockPositionsPanel
        token={token}
        account={account}
        openPositions={openPositions}
        closedPositions={closedPositions}
        symbols={symbols}
        accountMode={accountMode}
        tradierEnv={tradierEnv}
      />
    )) },
    // TRA-600 — event-aware "AI Options Ideas" (Phase 3 of TRA-595).
    { id: 'ideas', section: 'Options', label: 'AI Ideas', title: 'Ranked, defined-risk options ideas with earnings/Fed event context — paper entry only', render: () => <AiOptionsIdeasPanel token={token} /> },
    // TRA-161 — read-only OTM scan; also on the Overview.
    { id: 'otm', section: 'Options', label: 'Mispriced OTM', title: 'Out-of-the-money contracts whose mark diverges most from Black-Scholes theo — research only, no order entry', render: () => <OtmMispricingPanel token={token} symbols={symbols} /> },
    { id: 'calendar', section: 'Reports & feeds', label: 'Calendar', dataTour: 'calendar', title: 'Daily P&L calendar and per-day EOD reports', render: () => (
      <CalendarTab
        token={token}
        httpUrl={HTTP_URL}
        // TRA-1604 — gate the firm-wide Desk calendar to admin accounts.
        isAdmin={isAdmin}
        mode={
          accountMode === 'demo'
            ? 'demo'
            : tradierEnv === 'production' ? 'live' : 'sandbox'
        }
      />
    ) },
    { id: 'news', section: 'Reports & feeds', label: `News (${news.length})`, render: () => <NewsPanel news={news} loadingText="Loading market news…" /> },
  ];

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
        killSwitchEngaged={killSwitchEngaged}
        tradingAgentsEnabled={state?.tradingAgentsEnabled ?? accountSettings?.tradingAgentsEnabled ?? false}
        tradingAgentsGatingEnabled={state?.tradingAgentsGatingEnabled ?? accountSettings?.tradingAgentsGatingEnabled ?? false}
        accountMode={accountMode}
        engineMode={engineMode}
        liveBrokerArmPinned={liveBrokerArmPinned}
        hiddenBookExposure={state?.hiddenBookExposure ?? null}
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
        market="stocks"
        onOpenSettings={(field) => { setFocusCredField(field); setProfileModal('settings'); }}
      />

      {/* TRA-535 — halt banner. `tradingHalted`/`haltReason` from /api/state
          reflect the TRA-526 kill switch (reason takes precedence over the
          daily circuit-breakers) and update live over the WebSocket.
          TRA-895 — pass `isKillSwitch` so daily-circuit-breaker halts show
          a "Clear halt" button while kill-switch halts do not. */}
      <HaltBanner
        halted={state?.tradingHalted ?? false}
        reason={state?.haltReason ?? null}
        isKillSwitch={accountSettings?.globalKillSwitchEngaged ?? false}
        haltKind={state?.haltKind ?? null}
        onClearHalt={async () => {
          await fetch(`${HTTP_URL}/api/trading/reset-halt`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
        }}
      />

      {/* TRA-4502 (parent TRA-4284) — a `viewMode` override is hiding a book
          with breached real-money rows in it. Banner-level, beside the two
          above, because every PANEL on this screen is rendering the other book
          and none of them can say so. Renders nothing unless the hidden book is
          the LIVE one and something in it needs an operator. */}
      <HiddenBookBanner exposure={state?.hiddenBookExposure ?? null} />

      {/* TRA-4729 — two views. The old flat bar (TRA-690 grouping, TRA-1158
          Calendar promotion) is now the Diagnostics sidebar below.
          Coach-mark anchors (TRA-569): `signals` rides on the Diagnostics tab,
          which is where Signals now lives; `positions` on the Overview's
          positions section; `calendar` on its sidebar item. */}
      <TabBar
        active={view}
        onSelect={setView}
        primary={[
          { id: 'overview', label: 'Overview', title: 'Account & risk, proposals, open positions, OTM mispricing, validation progress' },
          { id: 'diagnostics', label: 'Diagnostics', dataTour: 'signals', title: 'Watchlist, signals, swing, AI ideas, calendar, news, health and every other panel' },
        ]}
      />

      <main className="content">
       {/* TRA-398 — per-view error boundary. `key={view}` remounts it on switch
           so a render crash in one view cannot white-screen the app. The
           Diagnostics view adds its own per-panel boundary inside. */}
       <ErrorBoundary key={view} label={`stocks:${view}`} variant="panel">
        {view === 'overview' && !state && (
          <div className="loading">
            <div className="spinner" />
            <p>Connecting to trading engine…</p>
          </div>
        )}

        {view === 'overview' && state && (
          <div className="dashboard-primary">
            <div className="dashboard-primary__top-row">
              {/* 1 — Account / Risk. Equity breakdown plus the caps and the
                  kill-switch STATE. The kill-switch BUTTON stays in the header
                  (always visible): a second instance here would keep its own
                  local state and could disagree with the first. */}
              <section className="dashboard-primary__card" aria-label="Account and risk">
                <h3>Account / Risk</h3>
                <AccountSummaryCard account={account} accountMode={accountMode} />
                <dl className="dashboard-primary__risk">
                  <div>
                    <dt>Options today</dt>
                    <dd className={optionsState && optionsState.dailyOptionsCount >= optionsDailyLimit ? 'red' : ''}>
                      {optionsState ? `${optionsState.dailyOptionsCount}/${optionsDailyLimit}` : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Kill switch</dt>
                    <dd className={killSwitchEngaged ? 'red' : ''}>{killSwitchEngaged ? 'ENGAGED' : 'Off'}</dd>
                  </div>
                  <div>
                    <dt>Trading</dt>
                    <dd className={state.tradingHalted ? 'red' : ''}>{state.tradingHalted ? 'HALTED' : 'Running'}</dd>
                  </div>
                </dl>
              </section>

              {/* 2 — Proposals (approve / reject). */}
              <section className="dashboard-primary__card" aria-label="Proposals">
                <PendingProposalsPanel token={token} accountMode={accountMode} />
              </section>

              {/* 5 — Validation Progress (spec §1.2 puts it in the top row). */}
              <section className="dashboard-primary__card" aria-label="Validation progress">
                <ValidationProgressPanel token={token} />
              </section>
            </div>

            {/* 3 — Open positions. The live sleeve is options, so the options
                book always shows; the equity table joins it whenever the equity
                book has anything open. Both stay available in full under
                Diagnostics. */}
            <section className="dashboard-primary__full-width" aria-label="Open positions">
              <h3 data-tour="positions">Open Positions</h3>
              <StockOptionsPanel
                token={token}
                tradierEnv={tradierEnv}
                accountMode={accountMode}
                account={account}
                optionsState={optionsState}
                openOptions={openOptions}
                closedOptions={closedOptions}
                optionsDailyLimit={optionsDailyLimit}
                showAccountSummary={false}
              />
              {openPositions.length > 0 && (
                <StockPositionsPanel
                  token={token}
                  account={account}
                  openPositions={openPositions}
                  closedPositions={closedPositions}
                  symbols={symbols}
                  accountMode={accountMode}
                  tradierEnv={tradierEnv}
                  showAccountSummary={false}
                />
              )}
            </section>

            {/* 4 — OTM Mispricing. Setup verdicts ("Why this trade?",
                TRA-4719 reasons-not-to-enter) render on each proposal/signal
                card, so they sit beside the proposal they judge. */}
            <section className="dashboard-primary__full-width" aria-label="OTM mispricing">
              <OtmMispricingPanel token={token} symbols={symbols} />
            </section>
          </div>
        )}

        {view === 'diagnostics' && (
          <DiagnosticsView items={diagnosticsItems} active={diagTab} onSelect={setDiagTab} />
        )}
       </ErrorBoundary>
      </main>

      {/* TRA-725 — daily P&L relocated from the top header to this bottom bar,
          mirroring how Tradier shows the portfolio "$X (Y%) Today" below the
          holdings. Always visible across tabs like the old header chips. */}
      <DashboardFooter account={account} optionsState={optionsState} />

      {/* TRA-569 (TRA-410 C2) — coach-mark tour. Self-contained: starts on the
          replay event (profile menu) or the first-run autostart breadcrumb.
          Renders nothing until then. */}
      <DashboardTour />
    </div>
  );
}
