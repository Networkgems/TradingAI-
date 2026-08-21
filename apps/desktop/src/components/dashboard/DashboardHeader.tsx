// TRA-422 — the Stocks dashboard header bar, extracted from Dashboard.tsx.
// Owns the account / options stat groups, the live-connection indicator, the
// auto-trading toggle (with its in-flight lock), and the theme + profile
// controls. The auto-trading POST lives here because nothing else needs it.
import { useState } from 'react';
import type { AccountState, OptionsAccountState } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { timeAgo } from '../../lib/format';
import { ThemeToggle } from '../ThemeToggle';
import type { Theme } from '../ThemeToggle';
import { ProfileMenu } from '../ProfileMenu';
import { startTour } from '../onboarding/tour';
import { AccountModeSwitcher } from '../AccountModeSwitcher';
import { KillSwitchButton } from './KillSwitchButton';
import { TradingAgentsButton } from './TradingAgentsButton';
import { AgentGatingButton } from './AgentGatingButton';
import { VersionChip } from './VersionChip';
import type { ProfileModal } from './ProfileModals';

export function DashboardHeader({
  token,
  account,
  optionsState,
  openPositionsCount,
  openOptionsCount,
  optionsDailyLimit,
  connected,
  lastTick,
  autoTradingEnabled,
  killSwitchEngaged,
  tradingAgentsEnabled,
  tradingAgentsGatingEnabled,
  accountMode,
  engineMode,
  liveBrokerArmPinned,
  onAccountModeChange,
  theme,
  onToggleTheme,
  isAdmin,
  onOpenProfileModal,
  onGoHome,
  onLogout,
}: {
  token: string;
  account: AccountState | undefined;
  optionsState: OptionsAccountState | undefined;
  openPositionsCount: number;
  openOptionsCount: number;
  optionsDailyLimit: number;
  connected: boolean;
  lastTick: number | undefined;
  autoTradingEnabled: boolean;
  killSwitchEngaged: boolean;
  /** TRA-544 — seed for the "Trading Agents" banner toggle (true ↔ the
   *  multi-agent layer is the active decision-maker). */
  tradingAgentsEnabled: boolean;
  /** TRA-895 (TRA-796) — seed for the demo-only "Auto-Trade" gating toggle
   *  (true ↔ agents auto-route paper orders). Optional so a pre-TRA-796 server
   *  state still type-checks. */
  tradingAgentsGatingEnabled?: boolean;
  /** TRA-3910 — the BOOK being shown (`viewMode ?? mode`). */
  accountMode: 'demo' | 'live';
  /** TRA-3910 — the engine's ROUTING mode. Optional so older callers type-check;
   *  defaults to `accountMode` (no override). */
  engineMode?: 'demo' | 'live';
  /** TRA-3910 — whether the TRA-2649 arm governs this user's `mode`. */
  liveBrokerArmPinned?: boolean;
  onAccountModeChange: (mode: 'demo' | 'live') => void;
  theme: Theme;
  onToggleTheme: () => void;
  isAdmin: boolean;
  onOpenProfileModal: (which: ProfileModal) => void;
  onGoHome: () => void;
  onLogout: () => void;
}) {
  const [tradingToggling, setTradingToggling] = useState(false);
  const toast = useToast();
  // TRA-3910 — routing mode; equals the shown book unless a view override is set.
  const routingMode: 'demo' | 'live' = engineMode ?? accountMode;
  const viewingOtherBook = routingMode !== accountMode;

  async function toggleAutoTrading() {
    setTradingToggling(true);
    const next = autoTradingEnabled ? 'stop' : 'start';
    try {
      const r = await fetch(`${HTTP_URL}/api/trading/${next}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        toast.success(next === 'start' ? 'Auto-trading started' : 'Auto-trading stopped');
      } else {
        logger.warn('stock-trading', `${next} returned HTTP ${r.status}`);
        toast.error(`Could not ${next} auto-trading (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('stock-trading', `failed to ${next} auto-trading`, err);
      toast.error(`Could not ${next} auto-trading — network error`);
    } finally {
      setTradingToggling(false);
    }
  }

  return (
    <header className="header">
      <div className="header-left">
        <button className="back-btn" onClick={onGoHome} title="Back to dashboard selector">&#8592; Home</button>
        <h1>TradingAI <span className="mode-badge stocks">Stocks</span></h1>
        {/* TRA-569 — coach-mark anchor for the account-mode stop (design §3.3). */}
        <span data-tour="account-mode" className="tour-anchor">
          <AccountModeSwitcher
            mode={accountMode}
            engineMode={routingMode}
            liveBrokerArmPinned={liveBrokerArmPinned ?? false}
            onChange={onAccountModeChange}
            market="stocks"
            token={token}
          />
        </span>
        {/* TRA-3910 — the shown book differs from the routed book. Say so in the
            header, every frame, so a demo VIEW can never be read as the live
            arm having been stood down. */}
        {viewingOtherBook && (
          <span
            className="book-view-banner"
            data-testid="book-view-banner"
            title={`The dashboard is showing the ${accountMode.toUpperCase()} book. The engine is still routing orders to the ${routingMode.toUpperCase()} account — nothing was disarmed.`}
          >
            Viewing {accountMode.toUpperCase()} book · engine is {routingMode.toUpperCase()}
          </span>
        )}
      </div>
      <div className="header-right">
        {/* TRA-544 (TRA-529 §2B) — "Trading Agents" master switch, centred in
            the banner between the DEMO/LIVE switcher and the equity stats. ON
            hands the trade decision to the multi-agent layer and suspends the
            deterministic auto-router. */}
        <div className="trading-agents-group">
          <TradingAgentsButton token={token} enabled={tradingAgentsEnabled} />
          {/* TRA-895 (TRA-796) — demo-only gating switch. Rendered only in demo
              (paper) mode so it can never arm live routing; it turns the agents
              from advisory-only into actually opening/monitoring/closing paper
              trades. Live agent routing stays behind the API-only board+CTO
              go-live gate. */}
          {/* TRA-3910 — gated on the ROUTING mode, not the shown book: a pinned
              live operator viewing the demo book must not be handed a routing
              control the live engine would act on. */}
          {routingMode === 'demo' && (
            <AgentGatingButton
              token={token}
              enabled={tradingAgentsGatingEnabled ?? false}
              agentsEnabled={tradingAgentsEnabled}
            />
          )}
        </div>
        <div className="stat-divider" />
        {account && (
          <>
            <div className="stat-group">
              <div className="stat">
                <span className="stat-label">Positions</span>
                <span className="stat-value">{openPositionsCount}</span>
              </div>
            </div>
            {optionsState && (
              <>
                <div className="stat-divider" />
                <div className="stat-group">
                  {/* TRA-725 — "Daily Opts P&L" relocated to the bottom
                      DashboardFooter alongside the equity Daily P&L. */}
                  <div className="stat">
                    <span className="stat-label">Options</span>
                    <span className="stat-value">{openOptionsCount}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Daily Trades</span>
                    <span className={`stat-value ${optionsState.dailyOptionsCount >= optionsDailyLimit ? 'red' : ''}`}>
                      {optionsState.dailyOptionsCount}/{optionsDailyLimit}
                    </span>
                  </div>
                </div>
              </>
            )}
          </>
        )}
        <div className="stat-divider" />
        <div className="status-group">
          <div className={`status-dot ${connected ? 'live' : 'offline'}`} title={connected ? 'Live data feed connected' : 'Reconnecting...'} />
          <div className="status-text">
            {/* TRA-704 — this badge reports the market-data feed/socket
                connection, NOT the DEMO/LIVE account mode. Labelled "CONNECTED"
                (was "LIVE") so it can't read as "real-money trading is on". */}
            <span className="status-label">{connected ? 'CONNECTED' : 'OFFLINE'}</span>
            {lastTick != null && <span className="last-tick">Updated {timeAgo(lastTick)}</span>}
          </div>
        </div>
        <div className="stat-divider" />
        <div className="action-group">
          <button
            /* TRA-569 — coach-mark anchor for the Auto-trading stop (design §3.3). */
            data-tour="auto-trading"
            className={`logout-btn${autoTradingEnabled ? ' trading-active' : ' trading-stopped'}`}
            onClick={toggleAutoTrading}
            disabled={tradingToggling}
            title={autoTradingEnabled ? 'Stop auto trading' : 'Start auto trading'}
          >
            {autoTradingEnabled ? '⏹ Stop Trading' : '▶ Start Trading'}
          </button>
          <KillSwitchButton token={token} engaged={killSwitchEngaged} />
          {/* TRA-539 — running build always visible so an operator can spot a
              stale binary vs origin/main at a glance. */}
          <VersionChip />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <ProfileMenu
            onSettings={() => onOpenProfileModal('settings')}
            onChangePassword={() => onOpenProfileModal('change-password')}
            onUserManagement={() => onOpenProfileModal('user-management')}
            onLogout={onLogout}
            isAdmin={isAdmin}
            /* TRA-569 — "Replay product tour" re-runs the coach-mark tour without
               resetting the onboarding completion flag (design §3.4). */
            onReplayTour={startTour}
          />
        </div>
      </div>
    </header>
  );
}
