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
// TRA-4488 — the session token no longer rides in the upgrade URL.
import { buildSocketUrl, fetchWsTicket, WsTicketError } from '../lib/ws-ticket';
import { pickOptionsDailyLimit } from '../lib/settings';
import type { AppState } from '../types/app';

export interface StockEngine {
  state: AppState | null;
  connected: boolean;
  news: NewsItem[];
  isAdmin: boolean;
  /**
   * TRA-3910 — the BOOK the dashboard is showing (`viewMode ?? mode`). Labels
   * and panels read this. It is NOT the engine's routing mode; see `engineMode`.
   */
  accountMode: 'demo' | 'live';
  setAccountMode: (mode: 'demo' | 'live') => void;
  /**
   * TRA-3910 — the engine's ROUTING mode (`settings.mode`), i.e. which book
   * real orders go to. Differs from `accountMode` only while a view override is
   * set; the header renders a banner in that case so "viewing demo" can never be
   * read as "disarmed".
   */
  engineMode: 'demo' | 'live';
  /**
   * TRA-3910 — true when this user's `mode` is governed by the TRA-2649
   * live-broker arm (the pinned operator). The switcher then routes a Demo press
   * to `PUT /api/account/view-mode` instead of a `mode` write the arm would clamp.
   */
  liveBrokerArmPinned: boolean;
  tradierEnv: 'sandbox' | 'production';
  optionsDailyLimit: number;
  /**
   * TRA-506 — the full saved AccountSettings snapshot used by
   * `<LiveCredentialsBanner>` to detect a misconfigured live broker. `null`
   * while the initial fetch is in flight; partial saves over the wire are
   * merged into the previous snapshot so a body that omits a field doesn't
   * mask its actual value.
   */
  accountSettings: AccountSettings | null;
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
  const [engineMode, setEngineMode] = useState<'demo' | 'live'>('demo');
  const [liveBrokerArmPinned, setLiveBrokerArmPinned] = useState(false);
  // TRA-244 — drives the Calendar tab's per-account bucket; flipping
  // `liveTradierEnvOptions` swaps the rows shown for the active account.
  const [tradierEnv, setTradierEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [optionsDailyLimit, setOptionsDailyLimit] = useState<number>(
    DEFAULT_ACCOUNT_SETTINGS.optionsDailyTradesLimit,
  );
  // TRA-506 — keep the full settings snapshot so the dashboard banner can
  // detect missing live credentials without a second fetch round.
  const [accountSettings, setAccountSettings] = useState<AccountSettings | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // TRA-419 — exponential reconnect backoff (was a flat 3s timer that
    // hammered the server during an outage). reset() on a healthy open.
    const reconnect = createReconnectController();
    // TRA-4488 — `cancelled` guards the await below. Without it an unmount that
    // races an in-flight ticket fetch opens a socket nobody owns and nobody
    // closes, and the effect's cleanup has already run.
    let cancelled = false;
    // TRA-4488 — EVERY attempt mints its own ticket, reconnects included. The
    // ticket is single-use, so a retry loop that replayed one would be refused
    // forever: the dashboard would not degrade, it would never come back.
    // Fetching inside `connect` rather than once in the effect is what makes
    // that structurally impossible.
    async function connect() {
      if (cancelled) return;
      let ticket: string;
      try {
        ticket = await fetchWsTicket(token);
      } catch (err) {
        if (cancelled) return;
        // A 401 means the session itself is gone; no amount of backoff recovers
        // it, and retrying would spin until the user gave up on a dead page.
        if (err instanceof WsTicketError && err.status === 401) { onLogout(); return; }
        logger.warn('stock-ws', 'ws-ticket fetch failed; will retry', err);
        reconnectTimer.current = setTimeout(() => { void connect(); }, reconnect.nextDelay());
        return;
      }
      if (cancelled) return;
      const ws = new WebSocket(buildSocketUrl(SERVER_URL, ticket));
      wsRef.current = ws;

      ws.onopen = () => { setConnected(true); reconnect.reset(); };
      ws.onclose = (e) => {
        setConnected(false);
        if (e.code === 1008) {
          onLogout();
          return;
        }
        reconnectTimer.current = setTimeout(() => { void connect(); }, reconnect.nextDelay());
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

    void connect();
    return () => {
      cancelled = true;
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
    // TRA-3910 — `accountMode` is the BOOK SHOWN: the `viewMode` override when
    // set, else the routing mode. `engineMode` tracks routing alone.
    if (s.mode === 'demo' || s.mode === 'live') {
      setEngineMode(s.mode);
      setAccountMode(s.viewMode === 'demo' || s.viewMode === 'live' ? s.viewMode : s.mode);
    } else if (s.viewMode === 'demo' || s.viewMode === 'live') {
      setAccountMode(s.viewMode);
    }
    const pinned = (s as { liveBrokerArmPinned?: unknown }).liveBrokerArmPinned;
    if (typeof pinned === 'boolean') setLiveBrokerArmPinned(pinned);
    const limit = pickOptionsDailyLimit(s);
    if (typeof limit === 'number') setOptionsDailyLimit(limit);
    if (s.liveTradierEnvOptions === 'sandbox' || s.liveTradierEnvOptions === 'production') {
      setTradierEnv(s.liveTradierEnvOptions);
    }
    // TRA-506 — merge the partial into the previous snapshot so a save that
    // ships only `{ mode: 'live' }` doesn't blank out the cached cred fields
    // the banner reads.
    setAccountSettings(prev => ({
      ...(prev ?? DEFAULT_ACCOUNT_SETTINGS),
      ...s,
    }));
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
    accountMode, setAccountMode, engineMode, liveBrokerArmPinned, tradierEnv, optionsDailyLimit,
    accountSettings,
    applyAccountSettings,
  };
}
