import { useEffect, useRef, useState } from 'react';
import { logger } from './lib/logger';
import { LIVE_ARM_FIELD_LABELS, diffSettingsForSave, partitionArmClamps, resolveClampedFields, touchesLiveArmField, type LiveArmField } from './lib/settings-save';
import { NotificationsSettings } from './components/notifications/NotificationsSettings';
import { type AccountMode, type AccountSettings, type BrokerageType, type LiveTradierMarkets, type TradierEnv, DEFAULT_ACCOUNT_SETTINGS, HARD_MAX_RISK_PER_TRADE, managedAccountRatioField, resolveLiveTradeEquitiesTradier, resolveManagedAccountRatio, resolveRiskPerTrade, riskPerTradeField } from '@trading-app/shared';
import { readLiveBrokerageTypeOptions, readLiveTradierEnvOptions, readLiveApiKeyOptions, readLiveAccountIdOptions, liveApiKeyOptionsField, liveAccountIdOptionsField, readLiveTradierMarkets } from './components/settings/live-credential-fields';
import { PasswordInput } from './components/settings/PasswordInput';
import type { SaveStatus } from './components/settings/types';
import { ProfileSection } from './components/settings/ProfileSection';
import { ChangePasswordSection } from './components/settings/ChangePasswordSection';
import { DeleteAccountSection } from './components/settings/DeleteAccountSection';
import { TwoFactorSection } from './components/settings/TwoFactorSection';
import { UserManagementSection } from './components/settings/UserManagementSection';
export { ChangePasswordSection } from './components/settings/ChangePasswordSection';
export { DeleteAccountSection } from './components/settings/DeleteAccountSection';
export { TwoFactorSection } from './components/settings/TwoFactorSection';
export { UserManagementSection } from './components/settings/UserManagementSection';

type Market = 'stocks';

interface Props {
  token: string;
  httpUrl: string;
  context?: 'stocks';
  onModeChange?: (mode: 'demo' | 'live') => void;
  // TRA-327 — fired after a successful PUT /api/account/settings so the
  // hosting dashboard can refetch /api/account/settings and refresh any
  // cached fields (e.g. the daily-options badge) without a hard reload.
  onSettingsSaved?: (settings: AccountSettings) => void;
  // TRA-397 — invoked when the initial settings fetch returns 401 so an
  // expired token logs the user out instead of silently rendering defaults.
  onLogout?: () => void;
  // TRA-506 — when the dashboard's missing-creds banner opens this modal,
  // it passes the AccountSettings field name of the first missing input. The
  // form scrolls + focuses that input on mount so the user lands on the
  // fix-it spot without scanning the whole Brokers section.
  focusCredField?: import('@trading-app/shared').LiveCredentialField | null;
}

export default function SettingsPage({ token, httpUrl, context, onModeChange, onSettingsSaved, onLogout, focusCredField }: Props) {
  const [settings, setSettings] = useState<AccountSettings>(DEFAULT_ACCOUNT_SETTINGS);
  const [loading, setLoading] = useState(true);
  // TRA-397 — set when the initial settings fetch fails with a non-OK status
  // (other than 401, which logs out) or a network/parse error, so the form
  // never renders defaults as if they were the user's saved settings.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  // TRA-511 — track the last-persisted snapshot so the footer can answer two
  // questions the previous "Saved!" toast left ambiguous:
  //   1. *When* did the last successful save actually happen? ("saved at HH:MM:SS")
  //   2. Are there pending edits that the user might think were saved? ("unsaved changes")
  // Both fall out naturally from comparing the live `settings` to the snapshot
  // captured on load and re-captured on every 200 PUT. We deliberately do NOT
  // mark the form dirty just because the saved snapshot disagrees in a
  // server-clamped field — handleSave merges the server's `data.settings`
  // back into both the live state AND the snapshot so the post-save diff is
  // empty even after clamps fired.
  const [lastSavedSettings, setLastSavedSettings] = useState<AccountSettings | null>(null);
  const [savedAtMs, setSavedAtMs] = useState<number | null>(null);
  // TRA-511 — distinguishes a network/5xx failure from the server's explicit
  // `settings_persist_failed` code so the operator sees "disk write failed,
  // your changes are NOT saved" instead of the generic connection message.
  const [saveErrorKind, setSaveErrorKind] = useState<'network' | 'persist' | null>(null);
  // TRA-1555 — the server rejects a save for reasons that have nothing to do
  // with connectivity (e.g. the TRA-532 promotion gate 422, or a 500 while the
  // gate is evaluated). Those responses carry a concrete, actionable `error`
  // string, but the footer used to collapse every non-persist failure into the
  // misleading "check server connection" — sending users who just saw the
  // connection test go green down the wrong path. Capture the server's message
  // so the footer can show *why* the save was refused.
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  // TRA-3833 — set when a 200 save came back with a SENT field holding a
  // different value than we sent (the server clamped/repaired it), or when the
  // response reported no settings at all while the save touched a live-arm
  // field. The old behavior merged the clamped value back into the form
  // (TRA-327) and reported a plain "Saved" — so unchecking "Tradier Live
  // trades equities" and saving showed success while the TRA-2649 write-path
  // arm kept the account trading live equities (ledger event
  // 2026-08-17T13:53:42Z). Same defect class as the TRA-3809 Demo toggle: the
  // response body was in hand and the UI claimed an outcome it never observed.
  const [saveClampNotice, setSaveClampNotice] = useState<
    | null
    | { kind: 'arm'; fields: LiveArmField[] }
    | { kind: 'other'; fields: string[] }
    | { kind: 'unverified' }
  >(null);
  const [resetPending, setResetPending] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // TRA-506 — per-env test state so each block ("Sandbox", "Production")
  // surfaces its own status and result independent of the saved
  // `liveTradierEnvOptions`. A user can confirm Production buying power
  // before flipping the env over.
  type TradierTestResult =
    | null
    | {
        ok: true;
        env: TradierEnv;
        accountNumber?: string;
        status?: string;
        classification?: string;
        buyingPower?: number | null;
      }
    | { ok: false; env?: TradierEnv; error: string };
  const [tradierTestStatusSandbox, setTradierTestStatusSandbox] = useState<'idle' | 'testing'>('idle');
  const [tradierTestResultSandbox, setTradierTestResultSandbox] = useState<TradierTestResult>(null);
  const [tradierTestStatusProduction, setTradierTestStatusProduction] = useState<'idle' | 'testing'>('idle');
  const [tradierTestResultProduction, setTradierTestResultProduction] = useState<TradierTestResult>(null);

  // TRA-397 — bumped to re-run the initial fetch when the user retries after
  // a transient load failure.
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetch(`${httpUrl}/api/account/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async r => {
        if (cancelled) return;
        // TRA-397 — an expired/invalid token must log the user out, matching
        // the 401 handling in App.tsx polling/WS code. Without this guard the
        // server's JSON error body would be spread into `settings` and the
        // form would render silently with default values.
        if (r.status === 401) {
          onLogout?.();
          return;
        }
        if (!r.ok) {
          setLoadError(`Couldn't load your settings (server returned ${r.status}).`);
          setLoading(false);
          return;
        }
        // TRA-485 — parse JSON inside its own try so a 200-OK-with-bad-body
        // (e.g. a reverse proxy interstitial, an HTML error page that slipped
        // past `r.ok`) surfaces as "bad response" instead of being mislabelled
        // as a connection problem by the outer `.catch`.
        let data: AccountSettings;
        try {
          data = (await r.json()) as AccountSettings;
        } catch (parseErr) {
          logger.warn('settings', 'settings load failed: invalid JSON body', parseErr);
          setLoadError("Couldn't load your settings — the server returned an unexpected response.");
          setLoading(false);
          return;
        }
        if (cancelled) return;
        const merged = { ...DEFAULT_ACCOUNT_SETTINGS, ...data };
        setSettings(merged);
        // TRA-511 — anchor the "unsaved changes" diff against what the server
        // says is currently persisted, NOT against DEFAULT_ACCOUNT_SETTINGS.
        // Without this anchor the form would render dirty on first paint for
        // every user who has any non-default field, which would defeat the
        // whole point of the indicator.
        setLastSavedSettings(merged);
        setSavedAtMs(null);
        setSaveErrorKind(null);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        // TRA-485 — only the network-failure path reaches here now (`r.json`
        // parse errors are caught above). Keep the original copy so the
        // existing "check your connection" message stays accurate, and log
        // the underlying reason for support diagnostics.
        logger.warn('settings', 'settings load failed (network)', err);
        setLoadError("Couldn't load your settings — check your connection and try again.");
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [token, httpUrl, loadAttempt, onLogout]);

  useEffect(() => {
    // Check if admin
    fetch(`${httpUrl}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.ok) setIsAdmin(true); })
      .catch(() => { /* not admin */ });
  }, [token, httpUrl]);

  // TRA-506 — when the dashboard's missing-creds banner opened this modal, it
  // passed the AccountSettings field name of the first missing input as
  // `focusCredField`. Scroll + focus that input once the form has loaded.
  // The Tradier inputs only render the pair matching the currently selected
  // env, so if the target is a production field and the form is on sandbox
  // (or vice versa), flip the local form state first — the user can save or
  // discard from there, but the field they need to fill is always in view.
  //
  // `appliedFocusRef` guards against re-focusing on every settings keystroke
  // after the user has moved cursor away. The effect runs again when settings
  // changes (so the env-flip path works), but only the first successful
  // focus per `focusCredField` value steals the cursor.
  const appliedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    if (!focusCredField) return;
    if (appliedFocusRef.current === focusCredField) return;
    const targetEnv: TradierEnv | null =
      focusCredField === 'liveApiKeyOptionsProduction' || focusCredField === 'liveAccountIdOptionsProduction'
        ? 'production'
        : focusCredField === 'liveApiKeyOptionsSandbox' || focusCredField === 'liveAccountIdOptionsSandbox'
          ? 'sandbox'
          : null;
    if (targetEnv && readLiveTradierEnvOptions(settings) !== targetEnv) {
      set('liveTradierEnvOptions', targetEnv);
      return;
    }
    const node = document.querySelector<HTMLElement>(`[data-cred-field="${focusCredField}"]`);
    if (!node) return;
    appliedFocusRef.current = focusCredField;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Give scrollIntoView a frame to complete before grabbing focus so the
    // viewport doesn't snap-jump on focus().
    requestAnimationFrame(() => node.focus());
  }, [loading, focusCredField, settings]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveStatus('saving');
    setSaveErrorKind(null);
    setSaveErrorMessage(null);
    setSaveClampNotice(null);
    // TRA-3833 — send ONLY the fields that changed since the last load/save.
    // The full-body `JSON.stringify(settings)` this replaces shipped all ~60
    // fields on every save, so any staleness anywhere in the form state rode
    // along and got written over disk — on 2026-08-17T13:53:42Z that vehicle
    // carried `liveTradeEquitiesTradier:false` into a live-equities demotion
    // attempt on the pinned operator (repaired by the TRA-2649 write-path arm;
    // durable ledger row on bqb1). The server PUT merges a partial body
    // against the persisted snapshot (TRA-485, same contract the
    // AccountModeSwitcher's `{mode}` body relies on), so an untouched field is
    // now simply never sent and cannot demote anything.
    const payload = diffSettingsForSave(settings, lastSavedSettings);
    try {
      const r = await fetch(`${httpUrl}/api/account/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        // TRA-327 — read the server-clamped settings back from the response so
        // the local form state and the parent dashboard reflect the values the
        // server actually persisted (no hard refresh required).
        const data = await r.json().catch(() => null) as { ok?: boolean; settings?: AccountSettings } | null;
        const persisted = data?.settings ?? settings;
        // TRA-511 — merge the persisted snapshot into BOTH the live form state
        // and the saved-snapshot baseline. Computing them in the same render
        // tick (instead of letting setSettings flow → effect → setSavedAtMs)
        // keeps the "saved at HH:MM:SS" indicator from flickering through a
        // transient "unsaved changes" state on every successful save.
        const mergedPersisted: AccountSettings = { ...settings, ...persisted };
        setSettings(mergedPersisted);
        setLastSavedSettings(mergedPersisted);
        setSavedAtMs(Date.now());
        setSaveStatus('saved');
        // TRA-3833 — report what the server DID, not what we asked. A 200 with
        // a sent field returned different means the server clamped it (the
        // TRA-2649 arm re-convergence, range clamps, preset fallback); a 200
        // with no settings object at all is a THIRD state — outcome
        // unobserved — and is only escalated when the save touched a live-arm
        // field, where an unverified claim is the exact TRA-3809 bug.
        const clamped = resolveClampedFields(payload, data?.settings);
        if (clamped === null) {
          if (touchesLiveArmField(payload)) {
            logger.warn('settings', 'save touched a live-arm field but the 200 carried no settings — outcome unverified');
            setSaveClampNotice({ kind: 'unverified' });
          }
        } else if (clamped.length > 0) {
          const { armClamped, otherClamped } = partitionArmClamps(clamped);
          if (armClamped.length > 0) {
            logger.warn('settings', `server kept live-arm field(s) on the ratified arm: ${armClamped.join(', ')}`);
            setSaveClampNotice({ kind: 'arm', fields: armClamped });
          } else {
            setSaveClampNotice({ kind: 'other', fields: otherClamped });
          }
        }
        onModeChange?.(persisted.mode);
        onSettingsSaved?.(persisted);
      } else {
        // TRA-511 — discriminate the new `settings_persist_failed` code from
        // a generic non-OK so the footer can tell the user their changes did
        // NOT make it to disk, rather than the older ambiguous "Save failed".
        const errData = await r.json().catch(() => null) as { code?: string; error?: string } | null;
        setSaveErrorKind(errData?.code === 'settings_persist_failed' ? 'persist' : 'network');
        // TRA-1555 — the server DID respond (so the connection is fine); surface
        // its concrete reason instead of blaming the connection. Covers the
        // promotion-gate 422 (`promotion_gate_blocked`), the gate-evaluation 500
        // (`promotion_gate_error`), and any other structured `{ error }` body.
        // If the server returned a bare status with no JSON body (e.g. an
        // uncaught-exception 500), still report it as a *server* rejection with
        // its HTTP status rather than blaming the network — the connection is
        // demonstrably fine (the Test-connection calls just succeeded).
        const serverMessage =
          typeof errData?.error === 'string' && errData.error.trim().length > 0
            ? errData.error.trim()
            : `the server rejected the save (HTTP ${r.status}). Please retry; if it persists, contact support.`;
        setSaveErrorMessage(serverMessage);
        setSaveStatus('error');
      }
    } catch {
      setSaveErrorKind('network');
      setSaveStatus('error');
    }
  }

  // TRA-506 — env-pinned probe. The server reads `env` from the body and
  // tests the saved pair for that env regardless of the currently selected
  // `liveTradierEnvOptions`, so the user can verify Production while their
  // saved env is still Sandbox.
  async function handleTestTradier(env: TradierEnv) {
    const setStatus = env === 'production' ? setTradierTestStatusProduction : setTradierTestStatusSandbox;
    const setResult = env === 'production' ? setTradierTestResultProduction : setTradierTestResultSandbox;
    setStatus('testing');
    setResult(null);
    try {
      const r = await fetch(`${httpUrl}/api/options/tradier/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ env }),
      });
      const data = await r.json();
      setResult(data);
    } catch (err) {
      setResult({ ok: false, env, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setStatus('idle');
    }
  }

  async function handleResetDemo() {
    setResetPending(true);
    try {
      // Scope the reset to the dashboard the user is viewing (TRA-192). The
      // global settings page (context undefined) resets every engine.
      await fetch(`${httpUrl}/api/account/reset-demo`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(context ? { market: context } : {}),
      });
    } finally {
      setResetPending(false);
    }
  }

  function set<K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) {
    setSettings(prev => ({ ...prev, [key]: value }));
  }

  // TRA-511 — compute "unsaved changes" against the snapshot anchored on the
  // last successful load/save. We stringify both sides instead of using a
  // shallow per-key compare because some fields are optional and may be
  // legitimately `undefined` vs absent; JSON.stringify normalizes both into
  // the same key omission, so we don't spuriously flag "dirty" right after
  // load just because the GET response omitted an optional field that the
  // form's local `set()` later wrote back as the same value.
  const hasUnsavedChanges = lastSavedSettings !== null
    && JSON.stringify(settings) !== JSON.stringify(lastSavedSettings);
  // TRA-511 — format the saved-at timestamp into "HH:MM:SS" using the user's
  // locale so the indicator matches the clock on their wall, not a UTC
  // surprise. `null` is the pre-save state and is hidden by the renderer.
  const savedAtLabel = savedAtMs === null
    ? null
    : new Date(savedAtMs).toLocaleTimeString();

  if (loading) {
    return <div className="loading"><div className="spinner" /><p>Loading settings…</p></div>;
  }

  // TRA-397 — a non-OK / network failure surfaces an explicit error with a
  // retry instead of rendering DEFAULT_ACCOUNT_SETTINGS as the user's saved
  // settings (which a blind save would then overwrite the real ones with).
  if (loadError) {
    return (
      <div className="loading">
        <p className="save-error">{loadError}</p>
        <button type="button" className="btn-primary" onClick={() => setLoadAttempt(n => n + 1)}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <form onSubmit={handleSave}>
        {/* ── Mode selector ─────────────────────────────────────────────── */}
        <section className="settings-section">
          <h2 className="settings-section-title">Account Mode</h2>
          <div className="mode-cards">
            <label className={`mode-card ${settings.mode === 'demo' ? 'active' : ''}`}>
              <input
                type="radio"
                name="mode"
                value="demo"
                checked={settings.mode === 'demo'}
                onChange={() => set('mode', 'demo')}
              />
              <div className="mode-card-inner">
                <span className="mode-card-title">Demo Account</span>
                <span className="mode-card-desc">
                  Paper-trade with virtual money. Full AI signal execution with no real risk.
                </span>
              </div>
            </label>
            <label className={`mode-card ${settings.mode === 'live' ? 'active' : ''}`}>
              <input
                type="radio"
                name="mode"
                value="live"
                checked={settings.mode === 'live'}
                onChange={() => set('mode', 'live')}
              />
              <div className="mode-card-inner">
                <span className="mode-card-title">Live Account</span>
                <span className="mode-card-desc">
                  Connect a brokerage to trade with real money.
                </span>
              </div>
            </label>
          </div>
        </section>

        {/* ── Demo settings ─────────────────────────────────────────────── */}
        {settings.mode === 'demo' && (
          <section className="settings-section">
            <h2 className="settings-section-title">Demo Account Settings</h2>
            <p className="settings-hint">
              Saving applies changes immediately while preserving open positions and today's P&amp;L. Use "Reset Demo Account" only when you want to wipe trades and start fresh from the configured starting balance.
            </p>

            <div className="settings-grid">
              {(!context || context === 'stocks') && (
                <div className="settings-field">
                  <label htmlFor="set-demoEquityStocks">{context === 'stocks' ? 'Starting Equity ($)' : 'Stock Starting Equity ($)'}</label>
                  <input
                    id="set-demoEquityStocks"
                    type="number"
                    min={1000}
                    max={10000000}
                    step={1000}
                    value={settings.demoEquityStocks ?? settings.demoEquity}
                    onChange={e => set('demoEquityStocks', Number(e.target.value))}
                  />
                  <span className="field-hint">Virtual starting balance for stocks (default: $25,000)</span>
                </div>
              )}

              {/* TRA-232 — Daily trade limits apply to stocks/options. */}
              {(!context || context === 'stocks') && (
                <div className="settings-field">
                  <label htmlFor="set-dailyTradesLimit">Stock Daily Trades Limit</label>
                  <input
                    id="set-dailyTradesLimit"
                    type="number"
                    min={1}
                    max={100}
                    value={settings.dailyTradesLimit}
                    onChange={e => set('dailyTradesLimit', Number(e.target.value))}
                  />
                  <span className="field-hint">Max stock trades per day (default: 10)</span>
                </div>
              )}

              {(!context || context === 'stocks') && (
                <div className="settings-field">
                  <label htmlFor="set-optionsDailyTradesLimit">Options Daily Trades Limit</label>
                  <input
                    id="set-optionsDailyTradesLimit"
                    type="number"
                    min={1}
                    max={100}
                    value={settings.optionsDailyTradesLimit}
                    onChange={e => set('optionsDailyTradesLimit', Number(e.target.value))}
                  />
                  <span className="field-hint">Max options trades per day across all scanners (default: 10)</span>
                </div>
              )}

              {/* TRA-346 — Managed Account Ratio + Risk Per Trade are stored
                  per (mode × dashboard) so Demo edits don't bleed into Live.
                  The standalone settings page (no `context`) writes to the
                  Stocks bucket by default to preserve the historical
                  behaviour where these inputs surfaced once globally. */}
              {(() => {
                const market: Market = context ?? 'stocks';
                const mode: AccountMode = 'demo';
                const ratioKey = managedAccountRatioField(market, mode);
                const riskKey = riskPerTradeField(market, mode);
                const ratio = resolveManagedAccountRatio(settings, market, mode);
                const risk = resolveRiskPerTrade(settings, market, mode);
                const labelSuffix = context === 'stocks' ? ' (Demo Stocks)' : '';
                return (
                  <>
                    <div className="settings-field">
                      <label htmlFor={`set-${ratioKey}`}>{`Managed Account Ratio (%)${labelSuffix}`}</label>
                      <input
                        id={`set-${ratioKey}`}
                        type="number"
                        min={1}
                        max={100}
                        value={Math.round(ratio * 100)}
                        onChange={e => setSettings(prev => ({
                          ...prev,
                          [ratioKey]: Number(e.target.value) / 100,
                        }))}
                      />
                      <span className="field-hint">
                        Portion of equity auto-traded (default: 50%). Only affects
                        {context === 'stocks' ? ' demo stocks/options' : ' demo'}.
                      </span>
                    </div>
                    <div className="settings-field">
                      <label htmlFor={`set-${riskKey}`}>{`Risk Per Trade (%)${labelSuffix}`}</label>
                      <input
                        id={`set-${riskKey}`}
                        type="number"
                        min={0.1}
                        max={50}
                        step={0.1}
                        value={+(risk * 100).toFixed(2)}
                        onChange={e => setSettings(prev => ({
                          ...prev,
                          [riskKey]: Number(e.target.value) / 100,
                        }))}
                      />
                      <span className="field-hint">
                        Max equity risked per trade (default: 1%). Only affects
                        {context === 'stocks' ? ' demo stocks/options' : ' demo'}.
                        {' '}<strong>Hard cap: {(HARD_MAX_RISK_PER_TRADE * 100).toFixed(0)}%</strong> — the
                        deterministic risk layer (TRA-526) clamps any larger value at trade time.
                      </span>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* TRA-389 — opt-in for the market-review regime gates. Default
                off (soft-launch): until checked the engine ignores the
                TRA-386 regime review entirely. Stocks-only — the gates
                govern equity (ORB) signals.

                ⚠️ TRA-3437 preconditions — read these BEFORE anyone ticks this
                box (mirrored at the default in `packages/shared/src/index.ts`):
                  1. TRA-3440 — a DARK 10Y must not increase size. Fixed in
                     `deriveGates` (`market-review.ts`): an unreadable `^TNX`
                     now takes the same 50% cut a `> 4.50%` print does. The
                     seam that consumes `sizingMultiplier` (`paper-account.ts`
                     `openPosition`'s third arg) is pre-built, so a regression
                     here reads as a sizing bug, not a feed bug.
                  2. UNDECIDED — `resolveCompositeTrend` SKIPS unreadable legs,
                     so losing the WEAKER leg turns a `down` fold into `up`
                     (`^NDX` binds today). Needs a ruling before enable.
                  3. The ±1% band and the `sessionDate` dwell lock assume ONE
                     read per session — do NOT re-sample intraday (the NO-GO
                     ruled on TRA-3437). */}
            {(!context || context === 'stocks') && (
              <div className="settings-field" style={{ marginTop: '0.5rem' }}>
                <label className="checkbox-option">
                  <input
                    type="checkbox"
                    checked={settings.marketReviewGatesEnabled === true}
                    onChange={e => set('marketReviewGatesEnabled', e.target.checked)}
                  />
                  <span>
                    <strong>Apply market-review regime gates</strong>
                    <p className="field-hint">
                      Let the automated pre-market review (S&amp;P 500 / VIX / 10Y
                      yield regime) gate the signal engine: suppress ORB long /
                      short and breakout entries in an unfavourable tape, and trim
                      position sizing in elevated-volatility or high-rate regimes.
                      Off by default — turn on to roll it out. Applies to demo and
                      live stock trading; the active regime shows on the Signals tab.
                    </p>
                  </span>
                </label>
              </div>
            )}

            <div className="settings-actions-row">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSettings(s => {
                  // TRA-346 — only revert the demo bucket; the Live bucket
                  // stays untouched.
                  const next: AccountSettings = {
                    ...s,
                    demoEquity: DEFAULT_ACCOUNT_SETTINGS.demoEquity,
                    demoEquityStocks: DEFAULT_ACCOUNT_SETTINGS.demoEquityStocks,
                    dailyTradesLimit: DEFAULT_ACCOUNT_SETTINGS.dailyTradesLimit,
                    optionsDailyTradesLimit: DEFAULT_ACCOUNT_SETTINGS.optionsDailyTradesLimit,
                  };
                  next.managedAccountRatioDemoStocks = DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
                  next.riskPerTradeDemoStocks = DEFAULT_ACCOUNT_SETTINGS.riskPerTrade;
                  return next;
                })}
              >
                Revert to Defaults
              </button>
            </div>
          </section>
        )}

        {/* ── Live settings ─────────────────────────────────────────────── */}
        {/*
          The Webull credential UI was removed in TRA-225; the Stocks dashboard
          now exposes only the Tradier (Options) live-trading credentials.
        */}
        {settings.mode === 'live' && (
          <section className="settings-section">
            <h2 className="settings-section-title">Live Brokerage Connection</h2>

            {/* TRA-232 — surface the risk knobs in Live mode too. Previously
                they were only editable in Demo, which left users unable to
                tell whether Live trading honored Managed Account Ratio,
                Risk Per Trade, or the daily trade limits (it does — the
                same engine code path drives sizing for stocks and options). */}
            <div className="live-brokerage-block">
              <h3 className="settings-subheading">Live Trading Risk</h3>
              <div className="settings-grid">
                {/* TRA-346 — scoped to (live × context) so saving here never
                    alters the Demo bucket. */}
                {(() => {
                  const market: Market = context ?? 'stocks';
                  const mode: AccountMode = 'live';
                  const ratioKey = managedAccountRatioField(market, mode);
                  const riskKey = riskPerTradeField(market, mode);
                  const ratio = resolveManagedAccountRatio(settings, market, mode);
                  const risk = resolveRiskPerTrade(settings, market, mode);
                  const liveBrokerLabel = context === 'stocks' ? 'live Tradier (options)' : 'live brokerage';
                  return (
                    <>
                      <div className="settings-field">
                        <label htmlFor={`set-${ratioKey}`}>Managed Account Ratio (%)</label>
                        <input
                          id={`set-${ratioKey}`}
                          type="number"
                          min={1}
                          max={100}
                          value={Math.round(ratio * 100)}
                          onChange={e => setSettings(prev => ({
                            ...prev,
                            [ratioKey]: Number(e.target.value) / 100,
                          }))}
                        />
                        <span className="field-hint">
                          Portion of equity auto-traded (default: 50%). Only affects {liveBrokerLabel} orders.
                        </span>
                      </div>
                      <div className="settings-field">
                        <label htmlFor={`set-${riskKey}`}>Risk Per Trade (%)</label>
                        <input
                          id={`set-${riskKey}`}
                          type="number"
                          min={0.1}
                          max={50}
                          step={0.1}
                          value={+(risk * 100).toFixed(2)}
                          onChange={e => setSettings(prev => ({
                            ...prev,
                            [riskKey]: Number(e.target.value) / 100,
                          }))}
                        />
                        <span className="field-hint">
                          Max equity risked per live trade (default: 1%). Only affects {liveBrokerLabel} sizing.
                          {' '}<strong>Hard cap: {(HARD_MAX_RISK_PER_TRADE * 100).toFixed(0)}%</strong> — the
                          deterministic risk layer (TRA-526) clamps any larger value at trade time.
                          {context === 'stocks' && (
                            <> On small live accounts (equity &lt; $2k) a $100 per-ticket floor takes over so
                            cheap RV contracts can still size to ≥1 contract; the 15%-of-equity per-position
                            cap (with a $100 floor) still applies.</>
                          )}
                        </span>
                      </div>
                    </>
                  );
                })()}
                {/* TRA-327 — Live limits bind to dailyTradesLimitLive /
                    optionsDailyTradesLimitLive so editing the Demo cap on
                    another visit never drags the Live cap with it. Falls back
                    to the legacy un-suffixed field when the user hasn't yet
                    saved a live-only value. */}
                {(!context || context === 'stocks') && (
                  <div className="settings-field">
                    <label htmlFor="set-dailyTradesLimitLive">Stock Daily Trades Limit</label>
                    <input
                      id="set-dailyTradesLimitLive"
                      type="number"
                      min={1}
                      max={100}
                      value={settings.dailyTradesLimitLive ?? settings.dailyTradesLimit}
                      onChange={e => set('dailyTradesLimitLive', Number(e.target.value))}
                    />
                    <span className="field-hint">Max stock trades per day in Live mode (default: 10)</span>
                  </div>
                )}
                {(!context || context === 'stocks') && (
                  <div className="settings-field">
                    <label htmlFor="set-optionsDailyTradesLimitLive">Options Daily Trades Limit</label>
                    <input
                      id="set-optionsDailyTradesLimitLive"
                      type="number"
                      min={1}
                      max={100}
                      value={settings.optionsDailyTradesLimitLive ?? settings.optionsDailyTradesLimit}
                      onChange={e => set('optionsDailyTradesLimitLive', Number(e.target.value))}
                    />
                    <span className="field-hint">Max options trades per day across all scanners in Live mode (default: 10)</span>
                  </div>
                )}
              </div>
            </div>

            {/* TRA-221 — Options live trading via Tradier. Rendered in the
                admin (no-context) and stocks-dashboard views, since options
                run on the same equity engine path. */}
            {(!context || context === 'stocks') && (
              <div className="live-brokerage-block" style={{ marginTop: !context ? '1.5rem' : 0 }}>
                {!context && <h3 className="settings-subheading">Options (Tradier)</h3>}

                <div className="settings-grid">
                  <div className="settings-field">
                    <label htmlFor="set-liveBrokerageTypeOptions">Brokerage</label>
                    <select
                      id="set-liveBrokerageTypeOptions"
                      value={readLiveBrokerageTypeOptions(settings)}
                      onChange={e => set('liveBrokerageTypeOptions', e.target.value as BrokerageType)}
                    >
                      <option value="tradier">Tradier</option>
                    </select>
                  </div>

                  <div className="settings-field">
                    <label htmlFor="set-liveTradierEnvOptions">Environment</label>
                    <select
                      id="set-liveTradierEnvOptions"
                      value={readLiveTradierEnvOptions(settings)}
                      onChange={e => set('liveTradierEnvOptions', e.target.value as TradierEnv)}
                    >
                      <option value="sandbox">Sandbox (paper)</option>
                      <option value="production">Production (live)</option>
                    </select>
                    <p className="field-hint">
                      Sandbox uses simulated fills with real chains — safe for first connection.
                      Switch to Production once you've verified the credentials work. The API
                      Token and Account ID below are stored separately per environment, so
                      flipping between Sandbox and Production keeps each set of credentials.
                    </p>
                  </div>

                  {/* TRA-336 — markets selector. Decides whether the live engine
                      routes options trades, equity (share) trades, or both
                      through Tradier. Default 'options' preserves the TRA-220
                      options-only behaviour for existing deployments. The
                      equity routing itself is wired by TRA-335; until that
                      lands, picking 'equity' or 'both' simply suppresses the
                      options mirror. */}
                  <div className="settings-field">
                    <label htmlFor="set-liveTradierMarkets">Trade</label>
                    <select
                      id="set-liveTradierMarkets"
                      value={readLiveTradierMarkets(settings)}
                      onChange={e => set('liveTradierMarkets', e.target.value as LiveTradierMarkets)}
                    >
                      <option value="options">Options only</option>
                      <option value="equity">Positions (equity) only</option>
                      <option value="both">Both options and positions</option>
                    </select>
                    <p className="field-hint">
                      Controls which Tradier markets the engine routes signals into when running live.
                      <em> Options only</em> mirrors the relative-value scanner to Tradier as
                      <code> buy_to_open</code> tickets (TRA-220 default).
                      <em> Positions (equity) only</em> routes ORB / BB-fade / Ichimoku stock-share signals
                      to Tradier as bracket orders and disables the options mirror. <em>Both</em> enables
                      both paths. Equity routing is delivered by TRA-335 — until it ships, picking
                      <em> equity</em> or <em> both</em> turns the options mirror off without yet
                      placing share orders.
                    </p>
                  </div>

                  <div className="settings-field">
                    <label>
                      API Token ({readLiveTradierEnvOptions(settings) === 'production' ? 'Production' : 'Sandbox'})
                    </label>
                    <PasswordInput
                      value={readLiveApiKeyOptions(settings, readLiveTradierEnvOptions(settings))}
                      onChange={v => set(liveApiKeyOptionsField(readLiveTradierEnvOptions(settings)), v)}
                      placeholder={'Tradier OAuth token (e.g. abc123XYZ…)'}
                      // TRA-778 — "new-password" (not "off", which Chromium ignores
                      // for password inputs) stops the browser from autofilling the
                      // saved app-login password into the broker API token field.
                      autoComplete="new-password"
                      dataCredField={liveApiKeyOptionsField(readLiveTradierEnvOptions(settings))}
                    />
                    <p className="field-hint">
                      Generate from Tradier dashboard → API Access. Production tokens are separate
                      from sandbox tokens — this field saves only to the selected environment above.
                    </p>
                  </div>

                  <div className="settings-field">
                    <label htmlFor="set-liveAccountIdOptions">
                      Account ID ({readLiveTradierEnvOptions(settings) === 'production' ? 'Production' : 'Sandbox'})
                    </label>
                    <input
                      id="set-liveAccountIdOptions"
                      type="text"
                      // TRA-778 — without these, Chromium treats this text input
                      // (it sits right before the password field) as a username
                      // field and autofills the app-login "admin" username into it.
                      name="tradier-account-id"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      data-form-type="other"
                      placeholder="Tradier account number (e.g. VA1234567)"
                      value={readLiveAccountIdOptions(settings, readLiveTradierEnvOptions(settings))}
                      onChange={e => set(liveAccountIdOptionsField(readLiveTradierEnvOptions(settings)), e.target.value)}
                      data-cred-field={liveAccountIdOptionsField(readLiveTradierEnvOptions(settings))}
                    />
                  </div>
                </div>

                {/* TRA-335 / TRA-370 — toggle for Tradier Live equity
                    (stock-share) trading. When on, BB-fade / ORB / Ichimoku
                    entries fire as OTOCO bracket orders against the same
                    Tradier account that powers options. TRA-370 — default ON
                    so a Live account mirrors Demo's signal flow (equity +
                    options) out of the box; uncheck to keep the
                    relative-value options scanner as the only live path. */}
                <div className="settings-field" style={{ marginTop: '1rem' }}>
                  <label className="checkbox-option">
                    <input
                      type="checkbox"
                      checked={resolveLiveTradeEquitiesTradier(settings)}
                      onChange={e => set('liveTradeEquitiesTradier', e.target.checked)}
                    />
                    <span>
                      <strong>Tradier Live trades equities</strong>
                      <p className="field-hint">
                        Mirror BB-fade / ORB / Ichimoku entries to Tradier as OTOCO bracket orders
                        (limit entry + OCO take-profit / stop-loss). Requires Tradier production
                        buying power. On by default (TRA-370) so Live matches Demo's signal flow;
                        uncheck to keep the relative-value options scanner as the only live path.
                      </p>
                    </span>
                  </label>
                </div>

                {/* TRA-361 — auto-manage Tradier-imported option positions.
                    When on, imports synced from Tradier flow through the
                    engine SL / TP1-partial / trailing-stop pipeline and exits
                    are mirrored back to Tradier as `sell_to_close` orders.
                    Default on so the user's stated bug ("no options are being
                    closed automatically") is fixed by default. */}
                <div className="settings-field" style={{ marginTop: '1rem' }}>
                  <label className="checkbox-option">
                    <input
                      type="checkbox"
                      checked={settings.autoManageImportedTradierOptions !== false}
                      onChange={e => set('autoManageImportedTradierOptions', e.target.checked)}
                    />
                    <span>
                      <strong>Auto-manage imported Tradier option positions</strong>
                      <p className="field-hint">
                        Apply the engine's stop-loss, partial-take-profit, and trailing-stop rules to
                        option positions imported from Tradier (synced or auto-reconciled). Exits are
                        mirrored to Tradier as <code>sell_to_close</code> orders — the local paper
                        cash bucket is never touched. Turn off to keep imports user-closed only.
                      </p>
                    </span>
                  </label>
                </div>

                {/* TRA-483 — hold live options overnight to avoid PDT. When
                    on (default), the engine's automatic SL / TP1 / trailing
                    exits don't fire on a live position the same day it
                    opened, so the round trip can't count as a day trade.
                    Manual closes are unaffected. */}
                <div className="settings-field" style={{ marginTop: '1rem' }}>
                  <label className="checkbox-option">
                    <input
                      type="checkbox"
                      checked={settings.holdLiveOptionsOvernightForPdt !== false}
                      onChange={e => set('holdLiveOptionsOvernightForPdt', e.target.checked)}
                    />
                    <span>
                      <strong>Hold live options overnight (avoid PDT)</strong>
                      <p className="field-hint">
                        Skip automatic stop-loss / partial-take-profit / trailing-stop exits on live
                        option positions opened earlier the same trading day, so the round trip
                        doesn't count as a day trade and burn Tradier's day-trade buying power.
                        Auto-exits resume on the next session. Manual closes from the dashboard
                        always fire regardless of this setting.
                      </p>
                    </span>
                  </label>
                </div>

                {/* TRA-1136 — swing-hold options. Opt-in (default off). When on,
                    the same-session exit suppression that already protects the
                    live RV book (TRA-495) is extended to the demo book too, so
                    RV option positions are held to the next trading session
                    instead of being booked out the same day — letting the
                    trailing stop run. Manual closes are unaffected. */}
                <div className="settings-field" style={{ marginTop: '1rem' }}>
                  <label className="checkbox-option">
                    <input
                      type="checkbox"
                      checked={settings.swingHoldOptions === true}
                      onChange={e => set('swingHoldOptions', e.target.checked)}
                    />
                    <span>
                      <strong>Swing-hold options (hold to next session)</strong>
                      <p className="field-hint">
                        Let Relative Value option positions swing-trade: skip automatic
                        structural / stop-loss / partial-take-profit / trailing-stop exits on
                        positions opened earlier the same trading day so they aren't closed out
                        on intraday noise. Auto-exits — including the trailing stop that lets
                        winners run — resume on the next session. Applies to both demo and live;
                        manual closes from the dashboard always fire regardless of this setting.
                      </p>
                    </span>
                  </label>
                </div>

                {/* TRA-506 — two env-pinned probes. Each button targets its
                    own saved cred pair so a user can verify Production
                    buying power before flipping the env over. The saved
                    `liveTradierEnvOptions` no longer decides which one
                    runs — the body's `env` field does. */}
                <div
                  className="settings-field"
                  style={{ marginTop: '1rem', display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}
                >
                  <div>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => handleTestTradier('sandbox')}
                      disabled={tradierTestStatusSandbox === 'testing'}
                    >
                      {tradierTestStatusSandbox === 'testing' ? 'Testing sandbox…' : 'Test Tradier sandbox connection'}
                    </button>
                    <p className="field-hint">
                      Reads your sandbox account profile and balance to verify the saved credentials.
                      No orders are placed. Save the form first if you just edited the API token.
                    </p>
                    {tradierTestResultSandbox && (
                      tradierTestResultSandbox.ok ? (
                        <div className="save-success" style={{ marginTop: '0.5rem' }}>
                          ✓ Sandbox OK{
                            typeof tradierTestResultSandbox.buyingPower === 'number'
                              ? `, $${tradierTestResultSandbox.buyingPower.toFixed(2)} buying power`
                              : ''
                          }. Account
                          {tradierTestResultSandbox.accountNumber ? ` ${tradierTestResultSandbox.accountNumber}` : ''}
                          {tradierTestResultSandbox.status ? `, status=${tradierTestResultSandbox.status}` : ''}
                          {tradierTestResultSandbox.classification ? `, ${tradierTestResultSandbox.classification}` : ''}.
                        </div>
                      ) : (
                        <div className="save-error" style={{ marginTop: '0.5rem' }}>
                          ✗ {tradierTestResultSandbox.error}
                        </div>
                      )
                    )}
                  </div>
                  <div>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => handleTestTradier('production')}
                      disabled={tradierTestStatusProduction === 'testing'}
                    >
                      {tradierTestStatusProduction === 'testing' ? 'Testing production…' : 'Test Tradier production connection'}
                    </button>
                    <p className="field-hint">
                      Reads your production account profile and balance to verify the saved credentials.
                      No orders are placed. Save the form first if you just edited the API token.
                    </p>
                    {tradierTestResultProduction && (
                      tradierTestResultProduction.ok ? (
                        <div className="save-success" style={{ marginTop: '0.5rem' }}>
                          ✓ Production OK{
                            typeof tradierTestResultProduction.buyingPower === 'number'
                              ? `, $${tradierTestResultProduction.buyingPower.toFixed(2)} buying power`
                              : ''
                          }. Account
                          {tradierTestResultProduction.accountNumber ? ` ${tradierTestResultProduction.accountNumber}` : ''}
                          {tradierTestResultProduction.status ? `, status=${tradierTestResultProduction.status}` : ''}
                          {tradierTestResultProduction.classification ? `, ${tradierTestResultProduction.classification}` : ''}.
                        </div>
                      ) : (
                        <div className="save-error" style={{ marginTop: '0.5rem' }}>
                          ✗ {tradierTestResultProduction.error}
                        </div>
                      )
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="live-notice">
              <strong>Live Tradier trading is enabled.</strong> Once you save a valid Tradier API token and Account ID and switch the account to <em>Live</em>, the engine routes signals based on the <em>Trade</em> selector above. <em>Options only</em> (default, TRA-220) sends the relative-value scanner to Tradier as <code>buy_to_open</code> market orders. <em>Positions (equity)</em> and <em>Both</em> activate stock-share routing — BB-fade / ORB / Ichimoku entries fire as Tradier OTOCO bracket orders when the &quot;Tradier Live trades equities&quot; toggle is also on (TRA-335).
            </div>
          </section>
        )}

        {/* ── Save + Reset row ──────────────────────────────────────────── */}
        <div className="settings-footer">
          <button type="submit" className="btn-primary" disabled={saveStatus === 'saving'}>
            {saveStatus === 'saving' ? 'Saving…' : 'Save Settings'}
          </button>
          {/* TRA-511 — three mutually-exclusive footer states (besides the
              raw "idle" no-pill default):
                · saving:     suppress all pills so the button label carries the spinner
                · error:      red pill, copy depends on whether server told us the
                              write itself failed (persist) or we never got a 2xx (network)
                · saved+dirty: amber "Unsaved changes" so the user knows the green
                              "saved at" timestamp from earlier is now stale
                · saved+clean: green "Saved at HH:MM:SS" — the concrete confirmation
                              the parent ticket called out as missing */}
          {saveStatus === 'error' && saveErrorKind === 'persist' && (
            <span className="save-error" data-testid="settings-save-state">
              Save failed on the server — your changes were not written to disk. Please retry.
            </span>
          )}
          {saveStatus === 'error' && saveErrorKind !== 'persist' && (
            <span className="save-error" data-testid="settings-save-state">
              {/* TRA-1555 — when the server responded with a concrete reason
                  (e.g. the promotion gate blocked the live transition), show it
                  verbatim. Only fall back to the connection message for a true
                  network/parse failure where we never got a structured body. */}
              {saveErrorMessage
                ? `Save failed — ${saveErrorMessage}`
                : 'Save failed — check server connection.'}
            </span>
          )}
          {saveStatus !== 'saving' && saveStatus !== 'error' && savedAtLabel && hasUnsavedChanges && (
            <span className="save-unsaved" data-testid="settings-save-state">
              Unsaved changes
            </span>
          )}
          {saveStatus !== 'saving' && saveStatus !== 'error' && savedAtLabel && !hasUnsavedChanges && (
            <span className="save-success" data-testid="settings-save-state">
              Saved at {savedAtLabel}
            </span>
          )}
          {/* TRA-3833 — the server clamped a field we sent, or (for a live-arm
              field) never reported the outcome. Rendered ALONGSIDE the saved
              pill, not instead of it: the save DID persist, but not with the
              values the user asked for, and for the real-money arm that
              difference must be said out loud rather than shown only as a
              checkbox quietly flipping back (same defect class as TRA-3809's
              "Switched to Demo account" over a clamped live arm). */}
          {saveStatus === 'saved' && saveClampNotice?.kind === 'arm' && (
            <span className="save-error" role="alert" data-testid="settings-arm-clamp-notice">
              {`The server kept ${saveClampNotice.fields.map(f => `“${LIVE_ARM_FIELD_LABELS[f]}”`).join(', ')} on the board-ratified live arm — this account is still trading live equities. `}
              A settings save cannot stand this arm down; the supported de-escalation is clearing{' '}
              <code>LIVE_EQUITY_BOOT_USER</code> on the service. Your other changes were saved.
            </span>
          )}
          {saveStatus === 'saved' && saveClampNotice?.kind === 'unverified' && (
            <span className="save-error" role="alert" data-testid="settings-arm-clamp-notice">
              Save accepted, but the server did not report the resulting settings. This save touched a
              live-trading field — reload and re-check it before trusting what the form shows.
            </span>
          )}
          {saveStatus === 'saved' && saveClampNotice?.kind === 'other' && (
            <span className="save-unsaved" data-testid="settings-clamp-notice">
              {`Saved — the server adjusted ${saveClampNotice.fields.join(', ')}; the form now shows the persisted values.`}
            </span>
          )}

          {settings.mode === 'demo' && (
            <button
              type="button"
              className="btn-danger"
              disabled={resetPending}
              onClick={handleResetDemo}
            >
              {resetPending ? 'Resetting…' : 'Reset Demo Account'}
            </button>
          )}
        </div>
      </form>

      {/* ── Profile / Change Password / Notifications / User Management (hidden in stocks context) */}
      {!context && <ProfileSection token={token} httpUrl={httpUrl} />}
      {!context && <ChangePasswordSection token={token} httpUrl={httpUrl} />}
      {/* TRA-1505 — email two-factor login enrollment (account-global). */}
      {!context && <TwoFactorSection token={token} httpUrl={httpUrl} />}
      {/* TRA-567 (TRA-410 A3) — standalone Notifications surface. Account-global,
          so it lives on the main Settings page next to Profile, not the
          per-market dashboard settings. */}
      {!context && <NotificationsSettings token={token} httpUrl={httpUrl} />}
      {isAdmin && <UserManagementSection token={token} httpUrl={httpUrl} />}
      {/* TRA-2421 — danger zone LAST: irreversible, and nothing below it should
          compete for the click. Account-global, so it is hidden in the per-market
          stocks context like the other account sections. */}
      {!context && <DeleteAccountSection token={token} httpUrl={httpUrl} onLogout={onLogout} />}
    </div>
  );
}
