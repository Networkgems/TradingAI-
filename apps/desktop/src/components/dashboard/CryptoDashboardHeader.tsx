// TRA-422 — the Crypto dashboard header bar, extracted from CryptoDashboard.tsx.
// Owns the account stat group (including the optional weekly P&L stat), the
// live-connection indicator, the auto-trading toggle, and the theme + profile
// controls. The auto-trading POST lives here because nothing else needs it.
import { useState } from 'react';
import type { AccountState } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { fmt, fmtDollar, timeAgo } from '../../lib/format';
import { ThemeToggle } from '../ThemeToggle';
import type { Theme } from '../ThemeToggle';
import { ProfileMenu } from '../ProfileMenu';
import { AccountModeSwitcher } from '../AccountModeSwitcher';
import { KillSwitchButton } from './KillSwitchButton';
import type { ProfileModal } from './ProfileModals';

export function CryptoDashboardHeader({
  token,
  account,
  openPositionsCount,
  connected,
  lastTick,
  autoTradingEnabled,
  killSwitchEngaged,
  onKillSwitchToggled,
  accountMode,
  onAccountModeChange,
  theme,
  onToggleTheme,
  isAdmin,
  onOpenProfileModal,
  onBack,
  onLogout,
}: {
  token: string;
  account: AccountState | undefined;
  openPositionsCount: number;
  connected: boolean;
  lastTick: number | undefined;
  autoTradingEnabled: boolean;
  killSwitchEngaged: boolean;
  onKillSwitchToggled: (engaged: boolean) => void;
  accountMode: 'demo' | 'live';
  onAccountModeChange: (mode: 'demo' | 'live') => void;
  theme: Theme;
  onToggleTheme: () => void;
  isAdmin: boolean;
  onOpenProfileModal: (which: ProfileModal) => void;
  onBack: () => void;
  onLogout: () => void;
}) {
  const [tradingToggling, setTradingToggling] = useState(false);
  const toast = useToast();

  async function toggleAutoTrading() {
    setTradingToggling(true);
    const next = autoTradingEnabled ? 'stop' : 'start';
    try {
      const r = await fetch(`${HTTP_URL}/api/crypto/trading/${next}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        toast.success(next === 'start' ? 'Auto-trading started' : 'Auto-trading stopped');
      } else {
        logger.warn('crypto-trading', `${next} returned HTTP ${r.status}`);
        toast.error(`Could not ${next} auto-trading (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('crypto-trading', `failed to ${next} auto-trading`, err);
      toast.error(`Could not ${next} auto-trading — network error`);
    } finally {
      setTradingToggling(false);
    }
  }

  return (
    <header className="header">
      <div className="header-left">
        <button className="back-btn" onClick={onBack} title="Back to dashboard selector">&#8592; Home</button>
        <h1>TradingAI <span className="mode-badge crypto">Crypto</span></h1>
        <AccountModeSwitcher mode={accountMode} onChange={onAccountModeChange} market="crypto" token={token} />
      </div>
      <div className="header-right">
        {account && (
          <div className="stat-group">
            <div className="stat">
              <span className="stat-label">Equity</span>
              <span className="stat-value">${fmt(account.totalEquity)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Today P&amp;L</span>
              <span className={`stat-value ${account.dailyPnl >= 0 ? 'green' : 'red'}`}>
                {fmtDollar(account.dailyPnl)}
              </span>
            </div>
            {account.weeklyPnl !== undefined && (
              <div className="stat">
                <span className="stat-label">Week P&amp;L</span>
                <span className={`stat-value ${account.weeklyPnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.weeklyPnl)}
                </span>
              </div>
            )}
            <div className="stat">
              <span className="stat-label">Cash</span>
              <span className="stat-value">${fmt(account.availableCash)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Positions</span>
              <span className="stat-value">{openPositionsCount}</span>
            </div>
          </div>
        )}
        <div className="stat-divider" />
        <div className="status-group">
          <div className={`status-dot ${connected ? 'live' : 'offline'}`} title={connected ? 'Live' : 'Reconnecting...'} />
          <div className="status-text">
            <span className="status-label">{connected ? 'LIVE' : 'OFFLINE'}</span>
            {lastTick != null && <span className="last-tick">Updated {timeAgo(lastTick)}</span>}
          </div>
        </div>
        <div className="stat-divider" />
        <div className="action-group">
          <button
            className={`logout-btn${autoTradingEnabled ? ' trading-active' : ' trading-stopped'}`}
            onClick={toggleAutoTrading}
            disabled={tradingToggling}
            title={autoTradingEnabled ? 'Stop auto trading' : 'Start auto trading'}
          >
            {autoTradingEnabled ? '⏹ Stop Trading' : '▶ Start Trading'}
          </button>
          <KillSwitchButton token={token} engaged={killSwitchEngaged} onToggled={onKillSwitchToggled} />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <ProfileMenu
            onSettings={() => onOpenProfileModal('settings')}
            onChangePassword={() => onOpenProfileModal('change-password')}
            onUserManagement={() => onOpenProfileModal('user-management')}
            onLogout={onLogout}
            isAdmin={isAdmin}
          />
        </div>
      </div>
    </header>
  );
}
