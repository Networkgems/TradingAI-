// TRA-422 — Crypto dashboard composition root. The 806-line single-component
// file was split into panel components under `components/dashboard/`; this file
// now owns the connection/data effects, the tab + profile-modal state, and
// wires the panels together. Behaviour (toast feedback, error surfacing, sort
// hooks, backoff lib from TRA-419) carries through unchanged.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CryptoEngineState, NewsItem, AccountSettings, LiveCredentialField } from '@trading-app/shared';
import { CalendarTab } from './CalendarTab.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { SERVER_URL, HTTP_URL } from './server-url';
import { logger } from './lib/logger';
import { createReconnectController } from './lib/backoff';
import type { Theme } from './components/ThemeToggle';
import { CryptoDashboardHeader } from './components/dashboard/CryptoDashboardHeader';
import { HaltBanner } from './components/dashboard/HaltBanner';
import { LiveCredentialsBanner } from './components/dashboard/LiveCredentialsBanner';
import { ProfileModals } from './components/dashboard/ProfileModals';
import type { ProfileModal } from './components/dashboard/ProfileModals';
import { CryptoWatchlistPanel } from './components/dashboard/CryptoWatchlistPanel';
import { CryptoSignalsPanel } from './components/dashboard/CryptoSignalsPanel';
import { CryptoPositionsPanel } from './components/dashboard/CryptoPositionsPanel';
import { NewsPanel } from './components/dashboard/NewsPanel';
import { PromotionGatePanel } from './components/dashboard/PromotionGatePanel';
import { TabBar } from './components/dashboard/TabBar';

type CryptoTab = 'watchlist' | 'signals' | 'positions' | 'news' | 'gate' | 'calendar';

export default function CryptoDashboard({ token, onBack, onLogout, onActivity, theme, onToggleTheme }: { token: string; onBack: () => void; onLogout: () => void; onActivity?: () => void; theme: Theme; onToggleTheme: () => void }) {
  const [state, setState] = useState<CryptoEngineState | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [tab, setTab] = useState<CryptoTab>('watchlist');
  const [profileModal, setProfileModal] = useState<ProfileModal | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [accountMode, setAccountMode] = useState<'demo' | 'live'>('demo');
  // TRA-798 — full settings snapshot so the crypto dashboard can surface its
  // own missing-Coinbase-creds banner (the warning used to only render on the
  // Stocks dashboard). `focusCredField` deep-links the banner → Settings.
  const [accountSettings, setAccountSettings] = useState<AccountSettings | null>(null);
  const [focusCredField, setFocusCredField] = useState<LiveCredentialField | null>(null);
  // TRA-535 — the global kill switch is a single account-settings flag shared
  // with the stock engine. Crypto's WebSocket state has no `tradingHalted`
  // field, so this is seeded from the settings fetch below and updated
  // optimistically by the header button; it drives both the header toggle and
  // the halt banner.
  const [killSwitchEngaged, setKillSwitchEngaged] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // TRA-419 — exponential reconnect backoff (was a flat 3s timer that
    // hammered the server during an outage). reset() on a healthy open.
    const reconnect = createReconnectController();
    function connect() {
      const ws = new WebSocket(`${SERVER_URL}?token=${token}`);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); reconnect.reset(); };
      ws.onclose = (e) => {
        setConnected(false);
        if (e.code === 1008) { onLogout(); return; }
        reconnectTimer.current = setTimeout(connect, reconnect.nextDelay());
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === 'crypto_state') { setState(msg.payload as CryptoEngineState); setEverConnected(true); }
          onActivity?.();
        } catch (err) { logger.warn('crypto-ws', 'dropped malformed WebSocket message', err); }
      };
    }
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onActivity/onLogout are event-style callbacks; adding them would tear down and reconnect the WebSocket on every parent render
  }, [token, onBack]);

  useEffect(() => {
    if (connected) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${HTTP_URL}/api/crypto/state`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.status === 401) { onLogout(); return; }
        if (r.ok) setState(await r.json() as CryptoEngineState);
      } catch (err) { logger.warn('crypto-http', 'state poll failed; will retry', err); }
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onLogout is an event-style callback; adding it would restart the polling interval on every parent render
  }, [connected, token, onBack]);

  useEffect(() => {
    async function loadNews() {
      try {
        const r = await fetch(`${HTTP_URL}/api/crypto/news`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) setNews(await r.json() as NewsItem[]);
      } catch (err) { logger.warn('crypto-http', 'news fetch failed; keeping previous items', err); }
    }
    loadNews();
    const id = setInterval(loadNews, 5 * 60_000);
    return () => clearInterval(id);
  }, [token]);

  useEffect(() => {
    fetch(`${HTTP_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.ok) setIsAdmin(true); })
      // Background probe — a non-admin token gets 401/403, which is expected;
      // a network failure is logged (not toasted) so it stays diagnosable.
      .catch(err => logger.warn('admin-check', 'admin probe failed', err));
  }, [token]);

  // TRA-327 — apply a fresh AccountSettings snapshot after the initial fetch
  // and after the SettingsPage `onSettingsSaved` callback so a save takes
  // effect without a hard refresh.
  // TRA-798 — also retain the merged snapshot so the missing-creds banner can
  // tell whether the Coinbase key/secret are still blank.
  const applyAccountSettings = useCallback((s: Partial<AccountSettings> | null | undefined) => {
    if (!s) return;
    if (s.mode === 'demo' || s.mode === 'live') setAccountMode(s.mode);
    setAccountSettings(prev => ({ ...(prev ?? {}), ...s } as AccountSettings));
  }, []);

  useEffect(() => {
    fetch(`${HTTP_URL}/api/account/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then((s: Partial<AccountSettings> | null) => {
        applyAccountSettings(s);
        // TRA-535 — re-seed the kill-switch state from the persisted flag so the
        // header toggle and halt banner survive a reload / reflect another
        // operator's change picked up on the next settings refresh.
        if (s) setKillSwitchEngaged(s.globalKillSwitchEngaged === true);
      })
      // Background settings refresh on tab switch — log a fetch failure for
      // diagnosis; the cached settings stay in effect, so no toast is needed.
      .catch(err => logger.warn('account-settings', 'settings refresh failed', err));
  }, [tab, token, applyAccountSettings]);

  const account = state?.account;
  const signals = state?.signals ?? [];
  const symbols = state?.symbols ?? [];
  const openPositions = account?.openPositions ?? [];
  // TRA-238 — closed crypto trades stay in the Positions tab until the 9 PM ET
  // archive sweep clears them; per-day history then lives under the Calendar.
  const closedPositions = state?.closedPositions ?? [];
  const autoTradingEnabled = state?.autoTradingEnabled ?? true;

  return (
    <div className="app">
      <CryptoDashboardHeader
        token={token}
        account={account}
        openPositionsCount={openPositions.length}
        connected={connected}
        lastTick={state?.lastTick}
        autoTradingEnabled={autoTradingEnabled}
        killSwitchEngaged={killSwitchEngaged}
        onKillSwitchToggled={setKillSwitchEngaged}
        accountMode={accountMode}
        onAccountModeChange={setAccountMode}
        theme={theme}
        onToggleTheme={onToggleTheme}
        isAdmin={isAdmin}
        onOpenProfileModal={setProfileModal}
        onBack={onBack}
        onLogout={onLogout}
      />

      {/* TRA-535 — crypto has no daily circuit-breaker surfaced in engine
          state, so the kill switch is its only halt source; drive the banner
          straight from the engaged flag. */}
      <HaltBanner halted={killSwitchEngaged} reason={null} />

      {/* TRA-798 — the missing-Coinbase-creds warning lives here on the Crypto
          dashboard (it previously only rendered on the Stocks dashboard).
          `market="crypto"` scopes it to the Coinbase key/secret. */}
      <LiveCredentialsBanner
        settings={accountSettings}
        market="crypto"
        onOpenSettings={(field) => { setFocusCredField(field); setProfileModal('settings'); }}
      />

      {/* TRA-690 — grouped nav: core trading surfaces stay flat; the Promotion
          Gate collapses into a "More ▾" dropdown to keep the bar clean.
          TRA-1158 — P&L Calendar promoted out of "More" to a primary tab so the
          daily P&L history is one click away and easy to read. */}
      <TabBar
        active={tab}
        onSelect={setTab}
        primary={[
          { id: 'watchlist', label: `Watchlist (${symbols.length})` },
          { id: 'signals', label: `Signals (${signals.length})` },
          { id: 'positions', label: `Positions (${openPositions.length})` },
          { id: 'news', label: `News (${news.length})` },
          { id: 'calendar', label: 'P&L Calendar', title: 'Daily P&L calendar and per-day EOD reports' },
        ]}
        more={[
          { id: 'gate', label: 'Gate', title: 'Crypto → real-capital promotion gate status' },
        ]}
      />

      <ProfileModals
        which={profileModal}
        onClose={() => { setProfileModal(null); setFocusCredField(null); }}
        token={token}
        httpUrl={HTTP_URL}
        context="crypto"
        isAdmin={isAdmin}
        onModeChange={setAccountMode}
        onSettingsSaved={applyAccountSettings}
        onLogout={onLogout}
        focusCredField={focusCredField}
      />

      <main className="content">
       {/* TRA-398 — per-tab error boundary. `key={tab}` remounts it on tab
           switch so a render crash in one tab cannot white-screen the app. */}
       <ErrorBoundary key={tab} label={`crypto:${tab}`} variant="panel">
        {!state && !everConnected && (
          <div className="loading">
            <div className="spinner" />
            <p>Connecting to crypto engine…</p>
          </div>
        )}
        {!state && everConnected && (
          <div className="loading">
            <div className="spinner" />
            <p>Connection lost — reconnecting…</p>
          </div>
        )}

        {state && tab === 'watchlist' && (
          <CryptoWatchlistPanel token={token} symbols={symbols} />
        )}

        {state && tab === 'signals' && (
          <CryptoSignalsPanel token={token} signals={signals} symbols={symbols} />
        )}

        {state && tab === 'positions' && (
          <CryptoPositionsPanel
            token={token}
            openPositions={openPositions}
            closedPositions={closedPositions}
            symbols={symbols}
            liveSkips={state.liveSkips ?? []}
          />
        )}

        {tab === 'news' && (
          <NewsPanel news={news} loadingText="Loading crypto news…" />
        )}

        {/* TRA-537 — the gate reads its own `/api/promotion/status` endpoint and
            is independent of the crypto WebSocket state, so it renders without
            waiting for the engine snapshot. */}
        {tab === 'gate' && (
          <PromotionGatePanel token={token} />
        )}

        {tab === 'calendar' && (
          <CalendarTab
            token={token}
            httpUrl={HTTP_URL}
            reportsPath="/api/crypto/reports"
            mode={accountMode}
            market="crypto"
          />
        )}
       </ErrorBoundary>
      </main>
    </div>
  );
}
