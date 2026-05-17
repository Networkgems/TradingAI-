// TRA-422 — connection + data-fetch layer for the Stocks dashboard, extracted
// from Dashboard.tsx so the component stays a thin composition root. Owns the
// WebSocket (with TRA-419 exponential reconnect backoff), the REST polling
// fallback, the news/admin/account-settings fetches, and the cached settings
// fields the panels read (account mode, Tradier env, daily-options limit).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NewsItem, AccountSettings } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import { SERVER_URL, HTTP_URL } from '../server-url';
import { logger } from '../lib/logger';
import { createReconnectController } from '../lib/backoff';
import { pickOptionsDailyLimit } from '../lib/settings';
import type { AppState } from '../types/app';

export interface StockEngine {
  state: AppState | null;
  connected: boolean;
  news: NewsItem[];
  isAdmin: boolean;
  accountMode: 'demo' | 'live';
  setAccountMode: (mode: 'demo' | 'live') => void;
  tradierEnv: 'sandbox' | 'production';
  optionsDailyLimit: number;
  applyAccountSettings: (s: Partial<AccountSettings> | null | undefined) => void;
}

export function useStockEngine(
  token: string,
  tab: string,
  onLogout: () => void,
  onActivity?: () => void,
): StockEngine {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [accountMode, setAccountMode] = useState<'demo' | 'live'>('demo');
  // TRA-244 — drives the Calendar tab's per-account bucket; flipping
  // `liveTradierEnvOptions` swaps the rows shown for the active account.
  const [tradierEnv, setTradierEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [optionsDailyLimit, setOptionsDailyLimit] = useState<number>(
    DEFAULT_ACCOUNT_SETTINGS.optionsDailyTradesLimit,
  );
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
        if (e.code === 1008) {
          onLogout();
          return;
        }
        reconnectTimer.current = setTimeout(connect, reconnect.nextDelay());
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === 'state') setState(msg.payload as AppState);
          // EOD report payloads are now consumed by the Calendar tab via the
          // `/api/reports/:date` REST endpoint, not pushed into the dashboard.
          onActivity?.();
        } catch (err) { logger.warn('stock-ws', 'dropped malformed WebSocket message', err); }
      };
    }

    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onActivity is an event-style callback; adding it would tear down and reconnect the WebSocket on every parent render
  }, [token, onLogout]);

  // Fallback REST polling when WS isn't connected.
  useEffect(() => {
    if (connected) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${HTTP_URL}/api/state`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.status === 401) { onLogout(); return; }
        if (r.ok) setState(await r.json() as AppState);
      } catch (err) { logger.warn('stock-http', 'state poll failed; will retry', err); }
    }, 5000);
    return () => clearInterval(id);
  }, [connected, token, onLogout]);

  useEffect(() => {
    async function loadNews() {
      try {
        const r = await fetch(`${HTTP_URL}/api/news`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) setNews(await r.json() as NewsItem[]);
      } catch (err) { logger.warn('stock-http', 'news fetch failed; keeping previous items', err); }
    }
    loadNews();
    const id = setInterval(loadNews, 5 * 60_000);
    return () => clearInterval(id);
  }, [token]);

  useEffect(() => {
    fetch(`${HTTP_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.ok) setIsAdmin(true); })
      // Background probe — a non-admin token gets 401/403, which is expected;
      // a network failure is logged (not toasted) so it stays diagnosable
      // without nagging the user on a screen they didn't ask anything of.
      .catch(err => logger.warn('admin-check', 'admin probe failed', err));
  }, [token]);

  // TRA-327 — apply a fresh AccountSettings snapshot to the dashboard's cached
  // fields (account mode, daily-options badge, Tradier env). Used by both the
  // initial fetch below and the SettingsPage `onSettingsSaved` callback so
  // saves take effect without a hard page refresh.
  const applyAccountSettings = useCallback((s: Partial<AccountSettings> | null | undefined) => {
    if (!s) return;
    if (s.mode === 'demo' || s.mode === 'live') setAccountMode(s.mode);
    const limit = pickOptionsDailyLimit(s);
    if (typeof limit === 'number') setOptionsDailyLimit(limit);
    if (s.liveTradierEnvOptions === 'sandbox' || s.liveTradierEnvOptions === 'production') {
      setTradierEnv(s.liveTradierEnvOptions);
    }
  }, []);

  useEffect(() => {
    fetch(`${HTTP_URL}/api/account/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then((s: Partial<AccountSettings> | null) => applyAccountSettings(s))
      // Background settings refresh on tab switch — log a fetch failure for
      // diagnosis; the cached settings stay in effect, so no toast is needed.
      .catch(err => logger.warn('account-settings', 'settings refresh failed', err));
  }, [tab, token, applyAccountSettings]);

  return {
    state, connected, news, isAdmin,
    accountMode, setAccountMode, tradierEnv, optionsDailyLimit,
    applyAccountSettings,
  };
}
