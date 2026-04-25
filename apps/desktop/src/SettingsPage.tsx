import { useEffect, useState } from 'react';
import type { AccountSettings } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

interface Props {
  token: string;
  httpUrl: string;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export default function SettingsPage({ token, httpUrl }: Props) {
  const [settings, setSettings] = useState<AccountSettings>(DEFAULT_ACCOUNT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [resetPending, setResetPending] = useState(false);

  useEffect(() => {
    fetch(`${httpUrl}/api/account/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then((data: AccountSettings) => {
        setSettings({ ...DEFAULT_ACCOUNT_SETTINGS, ...data });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [token, httpUrl]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveStatus('saving');
    try {
      const r = await fetch(`${httpUrl}/api/account/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(settings),
      });
      if (r.ok) {
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        setSaveStatus('error');
      }
    } catch {
      setSaveStatus('error');
    }
  }

  async function handleResetDemo() {
    setResetPending(true);
    try {
      await fetch(`${httpUrl}/api/account/reset-demo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } finally {
      setResetPending(false);
    }
  }

  function set<K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) {
    setSettings(prev => ({ ...prev, [key]: value }));
  }

  if (loading) {
    return <div className="loading"><div className="spinner" /><p>Loading settings…</p></div>;
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
                  Connect a brokerage (e.g. Webull) to trade with real money.
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
              Changes take effect immediately and reset the demo account. Save first, then use "Reset Demo Account" to apply.
            </p>

            <div className="settings-grid">
              <div className="settings-field">
                <label>Starting Equity ($)</label>
                <input
                  type="number"
                  min={1000}
                  max={10000000}
                  step={1000}
                  value={settings.demoEquity}
                  onChange={e => set('demoEquity', Number(e.target.value))}
                />
                <span className="field-hint">Virtual starting balance (default: $25,000)</span>
              </div>

              <div className="settings-field">
                <label>Daily Trades Limit</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={settings.dailyTradesLimit}
                  onChange={e => set('dailyTradesLimit', Number(e.target.value))}
                />
                <span className="field-hint">Max options trades per day (default: 10)</span>
              </div>

              <div className="settings-field">
                <label>Managed Account Ratio (%)</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={Math.round(settings.managedAccountRatio * 100)}
                  onChange={e => set('managedAccountRatio', Number(e.target.value) / 100)}
                />
                <span className="field-hint">Portion of equity auto-traded (default: 50%)</span>
              </div>

              <div className="settings-field">
                <label>Risk Per Trade (%)</label>
                <input
                  type="number"
                  min={0.1}
                  max={50}
                  step={0.1}
                  value={+(settings.riskPerTrade * 100).toFixed(2)}
                  onChange={e => set('riskPerTrade', Number(e.target.value) / 100)}
                />
                <span className="field-hint">Max equity risked per trade (default: 1%)</span>
              </div>
            </div>

            <div className="settings-actions-row">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSettings(s => ({
                  ...s,
                  demoEquity: DEFAULT_ACCOUNT_SETTINGS.demoEquity,
                  dailyTradesLimit: DEFAULT_ACCOUNT_SETTINGS.dailyTradesLimit,
                  managedAccountRatio: DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio,
                  riskPerTrade: DEFAULT_ACCOUNT_SETTINGS.riskPerTrade,
                }))}
              >
                Revert to Defaults
              </button>
            </div>
          </section>
        )}

        {/* ── Live settings ─────────────────────────────────────────────── */}
        {settings.mode === 'live' && (
          <section className="settings-section">
            <h2 className="settings-section-title">Live Brokerage Connection</h2>

            <div className="settings-grid">
              <div className="settings-field">
                <label>Brokerage</label>
                <select
                  value={settings.liveBrokerageType ?? 'webull'}
                  onChange={e => set('liveBrokerageType', e.target.value as 'webull')}
                >
                  <option value="webull">Webull</option>
                </select>
              </div>

              <div className="settings-field">
                <label>API Key</label>
                <input
                  type="password"
                  placeholder="Enter your Webull API key"
                  value={settings.liveApiKey ?? ''}
                  onChange={e => set('liveApiKey', e.target.value)}
                />
              </div>

              <div className="settings-field">
                <label>Account ID</label>
                <input
                  type="text"
                  placeholder="Enter your Webull account ID"
                  value={settings.liveAccountId ?? ''}
                  onChange={e => set('liveAccountId', e.target.value)}
                />
              </div>
            </div>

            <div className="settings-field" style={{ marginTop: '1.25rem' }}>
              <label>Trading Mode</label>
              <div className="radio-group">
                <label className="radio-option">
                  <input
                    type="radio"
                    name="liveTradeMode"
                    value="ai_in_brokerage"
                    checked={(settings.liveTradeMode ?? 'ai_in_brokerage') === 'ai_in_brokerage'}
                    onChange={() => set('liveTradeMode', 'ai_in_brokerage')}
                  />
                  <div>
                    <strong>AI trades in Webull</strong>
                    <p className="field-hint">AI controls your Webull account directly. Trades execute inside Webull using your Webull balance.</p>
                  </div>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="liveTradeMode"
                    value="transfer_to_platform"
                    checked={settings.liveTradeMode === 'transfer_to_platform'}
                    onChange={() => set('liveTradeMode', 'transfer_to_platform')}
                  />
                  <div>
                    <strong>Transfer funds to platform</strong>
                    <p className="field-hint">Funds transfer from Webull into TradingAI, trades execute here, then profits transfer back to Webull.</p>
                  </div>
                </label>
              </div>
            </div>

            <div className="live-notice">
              <strong>Live trading is not yet active.</strong> Connect your brokerage credentials above and save — the integration will be enabled in a future update.
            </div>
          </section>
        )}

        {/* ── Save + Reset row ──────────────────────────────────────────── */}
        <div className="settings-footer">
          <button type="submit" className="btn-primary" disabled={saveStatus === 'saving'}>
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved!' : 'Save Settings'}
          </button>
          {saveStatus === 'error' && <span className="save-error">Save failed — check server connection.</span>}

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
    </div>
  );
}
