// TRA-422 — the Stocks dashboard header bar, extracted from Dashboard.tsx.
// Owns the account / options stat groups, the live-connection indicator, the
// auto-trading toggle (with its in-flight lock), and the theme + profile
// controls. The auto-trading POST lives here because nothing else needs it.
import { useState } from 'react';
import type { AccountState, OptionsAccountState } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { fmt, fmtDollar, timeAgo } from '../../lib/format';
import { ThemeToggle } from '../ThemeToggle';
import type { Theme } from '../ThemeToggle';
import { ProfileMenu } from '../ProfileMenu';
import { startTour } from '../onboarding/tour';
import { AccountModeSwitcher } from '../AccountModeSwitcher';
import { KillSwitchButton } from './KillSwitchButton';
import { TradingAgentsButton } from './TradingAgentsButton';
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
  accountMode,
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
  accountMode: 'demo' | 'live';
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
          <AccountModeSwitcher mode={accountMode} onChange={onAccountModeChange} market="stocks" token={token} />
        </span>
      </div>
      <div className="header-right">
        {/* TRA-544 (TRA-529 §2B) — "Trading Agents" master switch, centred in
            the banner between the DEMO/LIVE switcher and the equity stats. ON
            hands the trade decision to the multi-agent layer and suspends the
            deterministic auto-router. */}
        <div className="trading-agents-group">
          <TradingAgentsButton token={token} enabled={tradingAgentsEnabled} />
        </div>
        <div className="stat-divider" />
        {account && (
          <>
            <div className="stat-group">
              <div className="stat">
                <span className="stat-label">Equity</span>
                <span className="stat-value">${fmt(account.totalEquity)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Daily P&amp;L</span>
                <span className={`stat-value ${account.dailyPnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.dailyPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">Cash</span>
                <span className="stat-value">${fmt(account.availableCash)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Positions</span>
                <span className="stat-value">{openPositionsCount}</span>
              </div>
            </div>
            {optionsState && (
              <>
                <div className="stat-divider" />
                <div className="stat-group">
                  <div className="stat">
                    {/* TRA-475 — pill shows today's options P&L (realized
                        delta since ET-midnight + live MTM on open contracts)
                        so it resets daily, mirroring the equity Daily P&L pill
                        instead of holding yesterday's cumulative realized
                        forever. Cumulative "Total Options P&L" is still shown
                        on the Options tab footer. Legacy state files without
                        `dailyOptionsPnl` fall back to `optionsPnl` so a
                        first-tick render before the server rolls forward
                        doesn't render `$NaN`. */}
                    <span className="stat-label">Daily Opts P&amp;L</span>
                    {(() => {
                      const dailyOptsPnl = optionsState.dailyOptionsPnl ?? optionsState.optionsPnl;
                      return (
                        <span className={`stat-value ${dailyOptsPnl >= 0 ? 'green' : 'red'}`}>
                          {fmtDollar(dailyOptsPnl)}
                        </span>
                      );
                    })()}
                  </div>
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
