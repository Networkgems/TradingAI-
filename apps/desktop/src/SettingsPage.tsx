import { useEffect, useState } from 'react';
import type { AccountSettings, BrokerageType, LiveTradeMode } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

type Market = 'crypto' | 'stocks';

// Live credentials are stored per-market (TRA-165) so a Coinbase key entered
// on the Crypto dashboard never appears on the Stock dashboard. Read-time
// helpers fall back to the legacy un-suffixed fields for users that saved
// before this split — new writes go straight to the scoped fields.
function readLiveBrokerageType(s: AccountSettings, m: Market): BrokerageType {
  const scoped = m === 'crypto' ? s.liveBrokerageTypeCrypto : s.liveBrokerageTypeStocks;
  return scoped ?? s.liveBrokerageType ?? (m === 'crypto' ? 'coinbase' : 'webull');
}
function readLiveTradeMode(s: AccountSettings, m: Market): LiveTradeMode {
  const scoped = m === 'crypto' ? s.liveTradeModeCrypto : s.liveTradeModeStocks;
  return scoped ?? s.liveTradeMode ?? 'ai_in_brokerage';
}
function readLiveApiKey(s: AccountSettings, m: Market): string {
  const scoped = m === 'crypto' ? s.liveApiKeyCrypto : s.liveApiKeyStocks;
  return scoped ?? s.liveApiKey ?? '';
}
function readLiveApiSecretCrypto(s: AccountSettings): string {
  return s.liveApiSecretCrypto ?? s.liveApiSecret ?? '';
}
function readLiveAccountIdStocks(s: AccountSettings): string {
  return s.liveAccountIdStocks ?? s.liveAccountId ?? '';
}

function PasswordInput({
  value,
  onChange,
  autoComplete,
  placeholder,
  disabled,
  required,
  minLength,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  minLength?: number;
}) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        minLength={minLength}
        style={{ paddingRight: '2.5rem', width: '100%', boxSizing: 'border-box' }}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        disabled={disabled}
        tabIndex={-1}
        aria-label={show ? 'Hide password' : 'Show password'}
        style={{
          position: 'absolute',
          right: '0.5rem',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--muted, #888)',
          padding: '0.25rem',
          display: 'flex',
          alignItems: 'center',
          lineHeight: 0,
        }}
      >
        {show ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

interface Props {
  token: string;
  httpUrl: string;
  context?: 'crypto' | 'stocks';
  onModeChange?: (mode: 'demo' | 'live') => void;
}

interface StrategyEntry {
  name: string;
  summary: string;
  indicators: string[];
}

// Strategies and indicators reflect the engines actually wired up in the server:
// SignalEngine (stocks/options) in packages/server/src/signal-engine.ts and
// CryptoSignalEngine in packages/server/src/crypto-engine.ts. Update this list
// when strategies are added/removed there so the settings page stays accurate.
const STOCK_STRATEGIES: StrategyEntry[] = [
  {
    name: 'Opening Range Breakout (ORB)',
    summary: 'Breakout of the first 30-minute range with volume confirmation, gated to high-volume ET sessions.',
    indicators: ['30-min opening range', 'ADX (≥ 20 trend filter)', 'Volume spike (1.5× range avg)', 'Bid-ask spread guard'],
  },
  {
    name: 'RSI Reversal',
    summary: 'Mean-reversion entries at RSI extremes with MACD direction confluence; skipped in strong trends.',
    indicators: ['RSI(14) 70/30', 'RSI bullish/bearish divergence', 'MACD cross', 'ADX (≤ 25 ranging filter)', 'Candle patterns (engulfing / pin bar)'],
  },
  {
    name: 'MACD-Bollinger Confluence',
    summary: 'Trend pullback entries when MACD crosses near the BB midline with VWAP and volume confirmation.',
    indicators: ['MACD cross', 'Bollinger Bands (20, 2σ)', 'VWAP directional filter', 'ADX (≥ 25 trending bias)', 'Volume (≥ 1.5× avg)'],
  },
  {
    name: 'Ichimoku Cloud',
    summary: 'Trend-following breakout above/below the cloud confirmed by Tenkan-Kijun cross and Chikou span.',
    indicators: ['Tenkan-sen / Kijun-sen cross', 'Senkou A/B (cloud)', 'Chikou span', 'ADX (≥ 25 trending confirmation)'],
  },
];

const OPTIONS_STRATEGIES: StrategyEntry[] = [
  {
    name: 'OTM Mispricing Scanner',
    summary: 'Scans Tradier option chains every 5 minutes for out-of-the-money calls/puts trading below Black-Scholes fair value.',
    indicators: ['Black-Scholes pricing', 'Implied volatility (Theo IV / smvVol)', 'Delta filter', 'Days-to-expiration', 'Bid/ask & open-interest liquidity'],
  },
];

const CRYPTO_STRATEGIES: StrategyEntry[] = [
  {
    name: 'RSI Reversal (24/7)',
    summary: 'Reversal entries at RSI extremes — same 70/30 thresholds as stocks, with the ET time filter disabled for 24/7 markets.',
    indicators: ['RSI(14) 70/30', 'RSI divergence', 'MACD cross', 'ADX (≤ 25 ranging filter)', 'Candle patterns'],
  },
  {
    name: 'MACD-Bollinger (Crypto-tuned)',
    summary: 'Crypto-tuned MACD + Bollinger confluence with wider bands and a lower volume threshold for thinner crypto liquidity.',
    indicators: ['MACD cross', 'Bollinger Bands (14, 2.5σ)', 'VWAP directional filter', 'ADX (≥ 25 trending bias)', 'Volume (≥ 1.2× avg)'],
  },
  {
    name: 'Scalping (1-min)',
    summary: 'Short-timeframe pullback scalp using a 9/21 EMA cross with VWAP and RSI(9) confirmation. Stop ~0.75%, R:R 2:1.',
    indicators: ['EMA(9) / EMA(21) cross', 'VWAP', 'RSI(9) pullback zones (40-55 / 45-60)', 'Volume spike (≥ 1.5× avg)'],
  },
  {
    name: 'Swing (Daily)',
    summary: 'Macro-trend swing entries on daily candles — pullback to the 50 EMA inside a 50/200 EMA trend with momentum confirmation.',
    indicators: ['EMA(50) / EMA(200) macro trend', 'RSI(14) pullback zones (40-50 / 50-60)', 'MACD histogram', 'ADX (≥ 25)'],
  },
];

function StrategyList({ items }: { items: StrategyEntry[] }) {
  return (
    <ul className="strategy-list">
      {items.map(s => (
        <li key={s.name} className="strategy-item">
          <div className="strategy-name">{s.name}</div>
          <div className="strategy-summary">{s.summary}</div>
          <div className="strategy-indicators">
            {s.indicators.map(ind => (
              <span key={ind} className="strategy-indicator-tag">{ind}</span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function TradingStrategiesSection({ context }: { context?: 'crypto' | 'stocks' }) {
  const showStocks = !context || context === 'stocks';
  const showCrypto = !context || context === 'crypto';

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Trading Strategies &amp; Indicators</h2>
      <p className="settings-hint">
        Reference list of the AI strategies and technical indicators the engine currently uses to generate signals on this dashboard. These run automatically — no configuration is needed here.
      </p>

      {showStocks && (
        <div className="live-brokerage-block" style={{ marginBottom: showCrypto ? '1.5rem' : 0 }}>
          {!context && <h3 className="settings-subheading">Stocks</h3>}
          <StrategyList items={STOCK_STRATEGIES} />

          <h3 className="settings-subheading" style={{ marginTop: '1.25rem' }}>Options</h3>
          <StrategyList items={OPTIONS_STRATEGIES} />
        </div>
      )}

      {showCrypto && (
        <div className="live-brokerage-block">
          {!context && <h3 className="settings-subheading">Crypto</h3>}
          <StrategyList items={CRYPTO_STRATEGIES} />
        </div>
      )}
    </section>
  );
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type PwStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SafeUser {
  username: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: string;
}

function ProfileSection({ token, httpUrl }: { token: string; httpUrl: string }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${httpUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data: { email?: string }) => { if (data.email !== undefined) setEmail(data.email); })
      .catch(() => { /* ignore */ });
  }, [token, httpUrl]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('saving');
    setError('');
    try {
      const r = await fetch(`${httpUrl}/api/auth/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (r.ok && data.ok) {
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 3000);
      } else {
        setError(data.error ?? 'Failed to save email');
        setStatus('error');
      }
    } catch {
      setError('Cannot reach server');
      setStatus('error');
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Profile</h2>
      <form onSubmit={handleSubmit}>
        <div className="settings-grid">
          <div className="settings-field">
            <label>Email Address</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={status === 'saving'}
            />
            <span className="field-hint">Used for password reset. Leave blank to disable email recovery.</span>
          </div>
        </div>
        {error && <p className="save-error" style={{ marginTop: '0.5rem' }}>{error}</p>}
        {status === 'saved' && <p style={{ color: 'var(--green)', marginTop: '0.5rem' }}>Email saved!</p>}
        <div className="settings-footer" style={{ marginTop: '1rem', paddingTop: 0, borderTop: 'none' }}>
          <button type="submit" className="btn-primary" disabled={status === 'saving'}>
            {status === 'saving' ? 'Saving…' : 'Save Email'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function ChangePasswordSection({ token, httpUrl }: { token: string; httpUrl: string }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState<PwStatus>('idle');
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) { setError('Passwords do not match'); return; }
    if (newPassword.length < 6) { setError('New password must be at least 6 characters'); return; }
    setStatus('saving');
    setError('');
    try {
      const r = await fetch(`${httpUrl}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (r.ok && data.ok) {
        setStatus('saved');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setTimeout(() => setStatus('idle'), 3000);
      } else {
        setError(data.error ?? 'Password change failed');
        setStatus('error');
      }
    } catch {
      setError('Cannot reach server');
      setStatus('error');
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Change Password</h2>
      <form onSubmit={handleSubmit}>
        <div className="settings-grid">
          <div className="settings-field">
            <label>Current Password</label>
            <PasswordInput
              value={currentPassword}
              onChange={setCurrentPassword}
              autoComplete="current-password"
              required
              disabled={status === 'saving'}
            />
          </div>
          <div className="settings-field">
            <label>New Password</label>
            <PasswordInput
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              minLength={6}
              required
              disabled={status === 'saving'}
            />
            <span className="field-hint">Minimum 6 characters</span>
          </div>
          <div className="settings-field">
            <label>Confirm New Password</label>
            <PasswordInput
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              minLength={6}
              required
              disabled={status === 'saving'}
            />
          </div>
        </div>
        {error && <p className="save-error" style={{ marginTop: '0.5rem' }}>{error}</p>}
        {status === 'saved' && <p style={{ color: 'var(--green)', marginTop: '0.5rem' }}>Password changed successfully!</p>}
        <div className="settings-footer" style={{ marginTop: '1rem', paddingTop: 0, borderTop: 'none' }}>
          <button type="submit" className="btn-primary" disabled={status === 'saving'}>
            {status === 'saving' ? 'Saving…' : 'Change Password'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function UserManagementSection({ token, httpUrl }: { token: string; httpUrl: string }) {
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [editUser, setEditUser] = useState<SafeUser | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editUsernameVal, setEditUsernameVal] = useState('');
  const [editError, setEditError] = useState('');
  const [editing, setEditing] = useState(false);

  async function loadUsers() {
    try {
      const r = await fetch(`${httpUrl}/api/admin/users`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const data = await r.json() as { users: SafeUser[] };
        setUsers(data.users);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadUsers(); }, [token, httpUrl]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError('');
    try {
      const r = await fetch(`${httpUrl}/api/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username: newUsername, email: newEmail, password: newPassword, role: newRole }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (r.ok && data.ok) {
        setShowCreate(false);
        setNewUsername('');
        setNewEmail('');
        setNewPassword('');
        setNewRole('user');
        await loadUsers();
      } else {
        setCreateError(data.error ?? 'Failed to create user');
      }
    } catch {
      setCreateError('Cannot reach server');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(username: string) {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    try {
      const r = await fetch(`${httpUrl}/api/admin/users/${encodeURIComponent(username)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) await loadUsers();
    } catch { /* ignore */ }
  }

  function startEdit(user: SafeUser) {
    setEditUser(user);
    setEditEmail(user.email);
    setEditUsernameVal(user.username);
    setEditError('');
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setEditing(true);
    setEditError('');
    try {
      const r = await fetch(`${httpUrl}/api/admin/users/${encodeURIComponent(editUser.username)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          email: editEmail,
          newUsername: editUsernameVal !== editUser.username ? editUsernameVal : undefined,
        }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (r.ok && data.ok) {
        setEditUser(null);
        await loadUsers();
      } else {
        setEditError(data.error ?? 'Failed to update user');
      }
    } catch {
      setEditError('Cannot reach server');
    } finally {
      setEditing(false);
    }
  }

  if (loading) return <div className="loading"><div className="spinner" /><p>Loading users…</p></div>;

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Account Management</h2>
      <p className="settings-hint">Manage user accounts that can access TradingAI.</p>

      <div className="user-table-wrap">
        <table className="user-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Role</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.username}>
                <td className="symbol">{u.username}</td>
                <td className="muted">{u.email || '—'}</td>
                <td>
                  <span className={`role-badge ${u.role}`}>{u.role}</span>
                </td>
                <td className="muted">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>
                  <button className="btn-secondary btn-sm" onClick={() => startEdit(u)}>Edit</button>
                  {' '}
                  <button className="btn-danger btn-sm" onClick={() => handleDelete(u.username)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editUser && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3 style={{ marginBottom: '1rem' }}>Edit User: {editUser.username}</h3>
            <form onSubmit={handleEdit}>
              <div className="settings-field">
                <label>Username</label>
                <input
                  type="text"
                  value={editUsernameVal}
                  onChange={e => setEditUsernameVal(e.target.value)}
                  required
                  disabled={editing}
                />
              </div>
              <div className="settings-field" style={{ marginTop: '0.75rem' }}>
                <label>Email</label>
                <input
                  type="email"
                  value={editEmail}
                  onChange={e => setEditEmail(e.target.value)}
                  disabled={editing}
                />
              </div>
              {editError && <p className="save-error" style={{ marginTop: '0.5rem' }}>{editError}</p>}
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                <button type="submit" className="btn-primary" disabled={editing}>
                  {editing ? 'Saving…' : 'Save'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setEditUser(null)} disabled={editing}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div style={{ marginTop: '1rem' }}>
        {!showCreate ? (
          <button className="btn-secondary" onClick={() => setShowCreate(true)}>
            + Add User
          </button>
        ) : (
          <div className="create-user-form">
            <h3 style={{ marginBottom: '0.75rem' }}>Create New User</h3>
            <form onSubmit={handleCreate}>
              <div className="settings-grid">
                <div className="settings-field">
                  <label>Username</label>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={e => setNewUsername(e.target.value)}
                    required
                    disabled={creating}
                  />
                </div>
                <div className="settings-field">
                  <label>Email</label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    disabled={creating}
                  />
                </div>
                <div className="settings-field">
                  <label>Password</label>
                  <PasswordInput
                    value={newPassword}
                    onChange={setNewPassword}
                    minLength={6}
                    required
                    disabled={creating}
                  />
                  <span className="field-hint">Minimum 6 characters</span>
                </div>
                <div className="settings-field">
                  <label>Role</label>
                  <select
                    value={newRole}
                    onChange={e => setNewRole(e.target.value as 'admin' | 'user')}
                    disabled={creating}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              </div>
              {createError && <p className="save-error" style={{ marginTop: '0.5rem' }}>{createError}</p>}
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
                <button type="submit" className="btn-primary" disabled={creating}>
                  {creating ? 'Creating…' : 'Create User'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => { setShowCreate(false); setCreateError(''); }} disabled={creating}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}

export default function SettingsPage({ token, httpUrl, context, onModeChange }: Props) {
  const [settings, setSettings] = useState<AccountSettings>(DEFAULT_ACCOUNT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [resetPending, setResetPending] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [coinbaseTestStatus, setCoinbaseTestStatus] = useState<'idle' | 'testing'>('idle');
  const [coinbaseTestResult, setCoinbaseTestResult] = useState<
    | null
    | { ok: true; authScheme: 'hmac' | 'cdp'; accountCount: number; currencies: string[] }
    | { ok: false; authScheme?: 'hmac' | 'cdp'; error: string }
  >(null);

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

    // Check if admin
    fetch(`${httpUrl}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.ok) setIsAdmin(true); })
      .catch(() => { /* not admin */ });
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
        onModeChange?.(settings.mode);
      } else {
        setSaveStatus('error');
      }
    } catch {
      setSaveStatus('error');
    }
  }

  async function handleTestCoinbase() {
    setCoinbaseTestStatus('testing');
    setCoinbaseTestResult(null);
    try {
      const r = await fetch(`${httpUrl}/api/crypto/coinbase/test-connection`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      setCoinbaseTestResult(data);
    } catch (err) {
      setCoinbaseTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setCoinbaseTestStatus('idle');
    }
  }

  async function handleResetDemo() {
    setResetPending(true);
    try {
      // Scope the reset to the dashboard the user is viewing (TRA-192) so
      // resetting Stocks does not wipe Crypto and vice versa. The global
      // settings page (context undefined) still resets both engines.
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

        {/* ── Trading strategies & indicators (TRA-167) ────────────────── */}
        <TradingStrategiesSection context={context} />

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
                  <label>{context === 'stocks' ? 'Starting Equity ($)' : 'Stock Starting Equity ($)'}</label>
                  <input
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

              {(!context || context === 'crypto') && (
                <div className="settings-field">
                  <label>{context === 'crypto' ? 'Starting Equity ($)' : 'Crypto Starting Equity ($)'}</label>
                  <input
                    type="number"
                    min={1000}
                    max={10000000}
                    step={1000}
                    value={settings.demoEquityCrypto ?? settings.demoEquity}
                    onChange={e => set('demoEquityCrypto', Number(e.target.value))}
                  />
                  <span className="field-hint">Virtual starting balance for crypto (default: $25,000)</span>
                </div>
              )}

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
                  demoEquityStocks: DEFAULT_ACCOUNT_SETTINGS.demoEquityStocks,
                  demoEquityCrypto: DEFAULT_ACCOUNT_SETTINGS.demoEquityCrypto,
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
        {/*
          Live credentials are stored per-market (TRA-165). When `context` is
          set we render a single market's form scoped to its own fields; when
          undefined (admin view) we render both Crypto and Stocks sections so
          they can be configured side by side without bleeding into each other.
        */}
        {settings.mode === 'live' && (
          <section className="settings-section">
            <h2 className="settings-section-title">Live Brokerage Connection</h2>

            {(!context || context === 'crypto') && (
              <div className="live-brokerage-block" style={{ marginBottom: !context ? '1.5rem' : 0 }}>
                {!context && <h3 className="settings-subheading">Crypto (Coinbase)</h3>}

                <div className="settings-grid">
                  <div className="settings-field">
                    <label>Brokerage</label>
                    <select
                      value={readLiveBrokerageType(settings, 'crypto')}
                      onChange={e => set('liveBrokerageTypeCrypto', e.target.value as BrokerageType)}
                    >
                      <option value="coinbase">Coinbase</option>
                    </select>
                  </div>

                  <div className="settings-field">
                    <label>API Key</label>
                    <PasswordInput
                      value={readLiveApiKey(settings, 'crypto')}
                      onChange={v => set('liveApiKeyCrypto', v)}
                      placeholder={'organizations/{org-id}/apiKeys/{key-id}'}
                      autoComplete="off"
                    />
                    <p className="field-hint">
                      Paste the full <strong>API key name</strong> Coinbase shows when you create a CDP key
                      (looks like <code>organizations/.../apiKeys/...</code>). Legacy HMAC API keys also work.
                    </p>
                  </div>

                  <div className="settings-field">
                    <label>API Secret</label>
                    <PasswordInput
                      value={readLiveApiSecretCrypto(settings)}
                      onChange={v => set('liveApiSecretCrypto', v)}
                      placeholder={'-----BEGIN EC PRIVATE KEY----- ... -----END EC PRIVATE KEY-----'}
                      autoComplete="off"
                    />
                    <p className="field-hint">
                      For CDP keys, paste the entire private key including the
                      <code> -----BEGIN </code> and <code> -----END </code> lines. For legacy HMAC keys,
                      paste the shared secret.
                    </p>
                  </div>
                </div>

                <div className="settings-field" style={{ marginTop: '1.25rem' }}>
                  <label>Trading Mode</label>
                  <div className="radio-group">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="liveTradeMode-crypto"
                        value="ai_in_brokerage"
                        checked={readLiveTradeMode(settings, 'crypto') === 'ai_in_brokerage'}
                        onChange={() => set('liveTradeModeCrypto', 'ai_in_brokerage')}
                      />
                      <div>
                        <strong>AI trades in Coinbase</strong>
                        <p className="field-hint">AI controls your Coinbase account directly. Trades execute inside Coinbase using your balance.</p>
                      </div>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="liveTradeMode-crypto"
                        value="transfer_to_platform"
                        checked={readLiveTradeMode(settings, 'crypto') === 'transfer_to_platform'}
                        onChange={() => set('liveTradeModeCrypto', 'transfer_to_platform')}
                      />
                      <div>
                        <strong>Transfer funds to platform</strong>
                        <p className="field-hint">Funds transfer from Coinbase into TradingAI, trades execute here, then profits transfer back.</p>
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {(!context || context === 'stocks') && (
              <div className="live-brokerage-block">
                {!context && <h3 className="settings-subheading">Stocks (Webull)</h3>}

                <div className="settings-grid">
                  <div className="settings-field">
                    <label>Brokerage</label>
                    <select
                      value={readLiveBrokerageType(settings, 'stocks')}
                      onChange={e => set('liveBrokerageTypeStocks', e.target.value as BrokerageType)}
                    >
                      <option value="webull">Webull</option>
                    </select>
                  </div>

                  <div className="settings-field">
                    <label>API Key</label>
                    <PasswordInput
                      value={readLiveApiKey(settings, 'stocks')}
                      onChange={v => set('liveApiKeyStocks', v)}
                      placeholder={'Enter your Webull API key'}
                      autoComplete="off"
                    />
                  </div>

                  <div className="settings-field">
                    <label>Account ID</label>
                    <input
                      type="text"
                      placeholder="Enter your Webull account ID"
                      value={readLiveAccountIdStocks(settings)}
                      onChange={e => set('liveAccountIdStocks', e.target.value)}
                    />
                  </div>
                </div>

                <div className="settings-field" style={{ marginTop: '1.25rem' }}>
                  <label>Trading Mode</label>
                  <div className="radio-group">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="liveTradeMode-stocks"
                        value="ai_in_brokerage"
                        checked={readLiveTradeMode(settings, 'stocks') === 'ai_in_brokerage'}
                        onChange={() => set('liveTradeModeStocks', 'ai_in_brokerage')}
                      />
                      <div>
                        <strong>AI trades in Webull</strong>
                        <p className="field-hint">AI controls your Webull account directly. Trades execute inside Webull using your balance.</p>
                      </div>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="liveTradeMode-stocks"
                        value="transfer_to_platform"
                        checked={readLiveTradeMode(settings, 'stocks') === 'transfer_to_platform'}
                        onChange={() => set('liveTradeModeStocks', 'transfer_to_platform')}
                      />
                      <div>
                        <strong>Transfer funds to platform</strong>
                        <p className="field-hint">Funds transfer from Webull into TradingAI, trades execute here, then profits transfer back.</p>
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {context === 'crypto' && (
              <div className="settings-field" style={{ marginTop: '1rem' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleTestCoinbase}
                  disabled={coinbaseTestStatus === 'testing'}
                >
                  {coinbaseTestStatus === 'testing' ? 'Testing…' : 'Test Coinbase Connection'}
                </button>
                <p className="field-hint">
                  Reads your account balances from Coinbase to verify the saved credentials. No orders are placed.
                  Save the form first if you just edited the API key or secret.
                </p>
                {coinbaseTestResult && (
                  coinbaseTestResult.ok ? (
                    <div className="save-success" style={{ marginTop: '0.5rem' }}>
                      ✓ Connected (auth={coinbaseTestResult.authScheme}). Coinbase returned {coinbaseTestResult.accountCount} account
                      {coinbaseTestResult.accountCount === 1 ? '' : 's'}
                      {coinbaseTestResult.currencies.length > 0 && (
                        <> across {coinbaseTestResult.currencies.slice(0, 6).join(', ')}{coinbaseTestResult.currencies.length > 6 ? `, +${coinbaseTestResult.currencies.length - 6} more` : ''}</>
                      )}
                      .
                    </div>
                  ) : (
                    <div className="save-error" style={{ marginTop: '0.5rem' }}>
                      ✗ {coinbaseTestResult.authScheme ? `auth=${coinbaseTestResult.authScheme} — ` : ''}{coinbaseTestResult.error}
                    </div>
                  )
                )}
              </div>
            )}

            <div className="live-notice">
              {context === 'crypto' ? (
                <>
                  <strong>Live Coinbase trading is enabled.</strong> Once you save valid API credentials and switch the account to <em>Live</em>, the engine routes new signals to Coinbase using market orders. Make sure the API key has trade permissions on your Coinbase Advanced Trade account.
                </>
              ) : (
                <>
                  <strong>Live trading is not yet active.</strong> Connect your brokerage credentials above and save — the integration will be enabled in a future update.
                </>
              )}
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

      {/* ── Profile / Change Password / User Management (hidden in crypto/stocks context) */}
      {!context && <ProfileSection token={token} httpUrl={httpUrl} />}
      {!context && <ChangePasswordSection token={token} httpUrl={httpUrl} />}
      {isAdmin && <UserManagementSection token={token} httpUrl={httpUrl} />}
    </div>
  );
}
