import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from './lib/logger';
import { NotificationsSettings } from './components/notifications/NotificationsSettings';
import type {
  AccountMode,
  AccountSettings,
  BrokerageType,
  LiveTradierMarkets,
  StrategyPreset,
  StrategyPresetId,
  TradierEnv,
} from '@trading-app/shared';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  DEFAULT_STRATEGY_PRESET_ID,
  HARD_MAX_RISK_PER_TRADE,
  STRATEGY_PRESETS,
  managedAccountRatioField,
  resolveLiveTradeEquitiesTradier,
  resolveManagedAccountRatio,
  resolveRiskPerTrade,
  riskPerTradeField,
} from '@trading-app/shared';

type Market = 'crypto' | 'stocks';

// Live credentials are stored per-market (TRA-165) so a Coinbase key entered
// on the Crypto dashboard never appears on the Stock dashboard. Read-time
// helpers fall back to the legacy un-suffixed fields for users that saved
// before this split — new writes go straight to the scoped fields.
// TRA-457 — `readLiveBrokerageType` / `readLiveTradeMode` were removed with the
// crypto Brokerage selector and the Trading Mode radio: both controls were dead
// (single-option dropdown; no engine/server reader for the `liveTradeMode*`
// fields).
function readLiveApiKey(s: AccountSettings, m: Market): string {
  const scoped = m === 'crypto' ? s.liveApiKeyCrypto : s.liveApiKeyStocks;
  return scoped ?? s.liveApiKey ?? '';
}
function readLiveApiSecretCrypto(s: AccountSettings): string {
  return s.liveApiSecretCrypto ?? s.liveApiSecret ?? '';
}
// TRA-221 — Tradier (Options) live credentials. Stored on a dedicated set of
// fields so options auto-trading is independent from the crypto flow.
function readLiveBrokerageTypeOptions(s: AccountSettings): BrokerageType {
  return s.liveBrokerageTypeOptions ?? 'tradier';
}
function readLiveTradierEnvOptions(s: AccountSettings): TradierEnv {
  return s.liveTradierEnvOptions ?? 'sandbox';
}
// TRA-226 — Sandbox and Production credentials are stored on separate fields
// so flipping the Environment dropdown no longer clobbers the other env's API
// token / account number. The reader returns whichever pair matches the
// currently selected env. Sandbox falls back to the legacy un-suffixed fields
// for users who saved before the split (production never does — production
// creds must be entered explicitly to avoid leaking sandbox tokens).
function readLiveApiKeyOptions(s: AccountSettings, env: TradierEnv): string {
  if (env === 'production') return s.liveApiKeyOptionsProduction ?? '';
  return s.liveApiKeyOptionsSandbox ?? s.liveApiKeyOptions ?? '';
}
function readLiveAccountIdOptions(s: AccountSettings, env: TradierEnv): string {
  if (env === 'production') return s.liveAccountIdOptionsProduction ?? '';
  return s.liveAccountIdOptionsSandbox ?? s.liveAccountIdOptions ?? '';
}
function liveApiKeyOptionsField(
  env: TradierEnv,
): 'liveApiKeyOptionsSandbox' | 'liveApiKeyOptionsProduction' {
  return env === 'production' ? 'liveApiKeyOptionsProduction' : 'liveApiKeyOptionsSandbox';
}
function liveAccountIdOptionsField(
  env: TradierEnv,
): 'liveAccountIdOptionsSandbox' | 'liveAccountIdOptionsProduction' {
  return env === 'production' ? 'liveAccountIdOptionsProduction' : 'liveAccountIdOptionsSandbox';
}
// TRA-336 / TRA-370 — markets selector for Tradier Live. Default ('both')
// mirrors Demo's signal flow so a Live account trades both equity positions
// and options out of the box; matches the server-side resolver fallback.
function readLiveTradierMarkets(s: AccountSettings): LiveTradierMarkets {
  return s.liveTradierMarkets ?? 'both';
}

function PasswordInput({
  value,
  onChange,
  autoComplete,
  placeholder,
  disabled,
  required,
  minLength,
  // TRA-222 — set for the Coinbase CDP private key field so newlines survive
  // the paste. Single-line inputs strip newlines, breaking PEM parsing.
  multiline,
  rows,
  // TRA-506 — set on cred inputs so the dashboard's missing-creds banner can
  // querySelector → focus the right input on modal open.
  dataCredField,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  minLength?: number;
  multiline?: boolean;
  rows?: number;
  dataCredField?: string;
}) {
  const [show, setShow] = useState(false);
  // `-webkit-text-security: disc` is the only way to mask a textarea in
  // Chromium/Electron. Falls back to plain text on browsers that don't
  // support it, which is acceptable on a local desktop app.
  const maskedTextareaStyle: React.CSSProperties = show
    ? {}
    : { WebkitTextSecurity: 'disc' } as React.CSSProperties;
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: multiline ? 'flex-start' : 'center',
      }}
    >
      {multiline ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          minLength={minLength}
          rows={rows ?? 6}
          spellCheck={false}
          data-cred-field={dataCredField}
          style={{
            paddingRight: '2.5rem',
            width: '100%',
            boxSizing: 'border-box',
            fontFamily: 'monospace',
            fontSize: '0.85rem',
            resize: 'vertical',
            ...maskedTextareaStyle,
          }}
        />
      ) : (
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          minLength={minLength}
          data-cred-field={dataCredField}
          style={{ paddingRight: '2.5rem', width: '100%', boxSizing: 'border-box' }}
        />
      )}
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

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type PwStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SafeUser {
  username: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: string;
  // TRA-217 — admin lock toggle. Optional for back-compat with old payloads.
  locked?: boolean;
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
  // TRA-217 — admin password set + reset email + lock toggle, scoped to the
  // user being edited. Each action has its own status string so the UI can
  // give targeted feedback without one button blocking the others.
  const [editNewPassword, setEditNewPassword] = useState('');
  const [pwSetting, setPwSetting] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [resetSending, setResetSending] = useState(false);
  const [resetMessage, setResetMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const [lockMessage, setLockMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadUsers = useCallback(async () => {
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
  }, [token, httpUrl]);

  useEffect(() => { void loadUsers(); }, [loadUsers]);

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
    setEditNewPassword('');
    setPwMessage(null);
    setResetMessage(null);
    setLockMessage(null);
  }

  async function handleSetPassword() {
    if (!editUser) return;
    if (editNewPassword.length < 6) {
      setPwMessage({ kind: 'err', text: 'Password must be at least 6 characters' });
      return;
    }
    setPwSetting(true);
    setPwMessage(null);
    try {
      const r = await fetch(`${httpUrl}/api/admin/users/${encodeURIComponent(editUser.username)}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ newPassword: editNewPassword }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (r.ok && data.ok) {
        setPwMessage({ kind: 'ok', text: 'Password updated' });
        setEditNewPassword('');
      } else {
        setPwMessage({ kind: 'err', text: data.error ?? 'Failed to set password' });
      }
    } catch {
      setPwMessage({ kind: 'err', text: 'Cannot reach server' });
    } finally {
      setPwSetting(false);
    }
  }

  async function handleSendReset() {
    if (!editUser) return;
    setResetSending(true);
    setResetMessage(null);
    try {
      const r = await fetch(`${httpUrl}/api/admin/users/${encodeURIComponent(editUser.username)}/reset-password`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json() as { ok?: boolean; message?: string; error?: string };
      if (r.ok && data.ok) {
        setResetMessage({ kind: 'ok', text: data.message ?? 'Reset code emailed' });
      } else {
        setResetMessage({ kind: 'err', text: data.error ?? 'Failed to send reset email' });
      }
    } catch {
      setResetMessage({ kind: 'err', text: 'Cannot reach server' });
    } finally {
      setResetSending(false);
    }
  }

  async function handleToggleLock() {
    if (!editUser) return;
    const next = !(editUser.locked ?? false);
    setLockBusy(true);
    setLockMessage(null);
    try {
      const r = await fetch(`${httpUrl}/api/admin/users/${encodeURIComponent(editUser.username)}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ locked: next }),
      });
      const data = await r.json() as { ok?: boolean; locked?: boolean; error?: string };
      if (r.ok && data.ok) {
        setEditUser({ ...editUser, locked: data.locked ?? next });
        setLockMessage({ kind: 'ok', text: next ? 'Account locked' : 'Account unlocked' });
        await loadUsers();
      } else {
        setLockMessage({ kind: 'err', text: data.error ?? 'Failed to update lock state' });
      }
    } catch {
      setLockMessage({ kind: 'err', text: 'Cannot reach server' });
    } finally {
      setLockBusy(false);
    }
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
              <th>Status</th>
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
                <td>
                  {u.locked
                    ? <span style={{ color: 'var(--red, #f85149)', fontWeight: 600 }}>Locked</span>
                    : <span style={{ color: 'var(--green, #3fb950)' }}>Active</span>}
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
        // TRA-217 — backdrop-click closes the modal (matches the parent
        // Account Management modal in App.tsx); inner stopPropagation keeps
        // clicks inside from leaking through.
        <div className="modal-backdrop" onClick={() => setEditUser(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Edit User: {editUser.username}</h3>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setEditUser(null)}
                aria-label="Close"
                title="Close"
              >&#x2715;</button>
            </div>
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

            {/* TRA-217 — admin password actions. Stored passwords are scrypt-hashed
                and cannot be displayed, but admins can set a new one (with a
                show/hide toggle) or trigger a self-service reset PIN by email. */}
            <div style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid var(--border, #30363d)' }}>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 0.5rem' }}>Password</h4>
              <p className="settings-hint" style={{ margin: '0 0 0.75rem' }}>
                Stored passwords are hashed and cannot be revealed. Set a new password directly,
                or email a one-time reset code so the user can pick their own.
              </p>
              <div className="settings-field">
                <label>New password</label>
                <PasswordInput
                  value={editNewPassword}
                  onChange={setEditNewPassword}
                  autoComplete="new-password"
                  minLength={6}
                  disabled={pwSetting}
                />
                <span className="field-hint">Minimum 6 characters</span>
              </div>
              {pwMessage && (
                <p style={{ marginTop: '0.5rem', color: pwMessage.kind === 'ok' ? 'var(--green, #3fb950)' : 'var(--red, #f85149)' }}>
                  {pwMessage.text}
                </p>
              )}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={handleSetPassword}
                  disabled={pwSetting || editNewPassword.length < 6}
                >
                  {pwSetting ? 'Saving…' : 'Set Password'}
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={handleSendReset}
                  disabled={resetSending || !editUser.email}
                  title={editUser.email ? 'Email an 8-digit reset code to this user' : 'User has no email address on file'}
                >
                  {resetSending ? 'Sending…' : 'Email Reset Code'}
                </button>
              </div>
              {resetMessage && (
                <p style={{ marginTop: '0.5rem', color: resetMessage.kind === 'ok' ? 'var(--green, #3fb950)' : 'var(--red, #f85149)' }}>
                  {resetMessage.text}
                </p>
              )}
            </div>

            <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border, #30363d)' }}>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
                Account status: {editUser.locked ? 'Locked' : 'Active'}
              </h4>
              <p className="settings-hint" style={{ margin: '0 0 0.75rem' }}>
                Locked accounts cannot log in until an admin unlocks them.
              </p>
              <button
                type="button"
                className={editUser.locked ? 'btn-primary btn-sm' : 'btn-danger btn-sm'}
                onClick={handleToggleLock}
                disabled={lockBusy}
              >
                {lockBusy ? 'Working…' : editUser.locked ? 'Unlock Account' : 'Lock Account'}
              </button>
              {lockMessage && (
                <p style={{ marginTop: '0.5rem', color: lockMessage.kind === 'ok' ? 'var(--green, #3fb950)' : 'var(--red, #f85149)' }}>
                  {lockMessage.text}
                </p>
              )}
            </div>
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

/**
 * TRA-325 — strategy preset selector. Renders each preset from
 * `STRATEGY_PRESETS` as a radio card, expanded to show enabled strategies
 * and the symbol-filter (or "all watchlist symbols" when null). The active
 * id lives on `AccountSettings.activeStrategyPreset` so it saves on the
 * existing form submit alongside the other account settings.
 *
 * TRA-697 — the OOS-failed legacy roster (`legacy_5`, `bb_fade_sol_doge`,
 * `tra405_validated`) was retired after QuantTrader's TRA-695 NO-GO and the
 * TRA-693 board decision. The library now holds exactly two live-relevant
 * presets — `no_trade` (engine paused, the recommended posture) and
 * `crypto_core` (the go-forward DCA-only BTC/SOL forward-paper roster) — so the
 * picker shows both directly with no "Advanced" overflow.
 */
// TRA-521 / TRA-523 / TRA-697 — QuantTrader's fee-aware R&D (and the later
// TRA-695 re-validation) returned a NO-GO on the legacy roster: bb_fade and the
// other timing strategies are OOS-negative net of fees and fail Stage 1 of the
// Live-Trading Promotion Gate (TRA-532). Those presets are now retired. Until a
// strategy clears the gate, the recommended posture is to keep the engine
// paused (`no_trade`); `crypto_core` runs DCA as a demo/paper forward leg.
// Repoint this id once a strategy clears the promotion gate.
const RECOMMENDED_PRESET_ID: StrategyPresetId = 'no_trade';
// Presets surfaced in the primary list. With the legacy roster retired
// (TRA-697) the library is just these two, so there is no Advanced overflow.
// TRA-694 / TRA-698: `crypto_core` is the DCA-only BTC/SOL forward-paper roster.
const PRIMARY_PRESET_IDS: readonly StrategyPresetId[] = ['crypto_core', 'no_trade'];

function StrategyPresetCard({
  preset,
  active,
  onChange,
}: {
  preset: StrategyPreset;
  active: StrategyPresetId;
  onChange: (id: StrategyPresetId) => void;
}) {
  const isActive = preset.id === active;
  return (
    <label
      className={`mode-card ${isActive ? 'active' : ''}`}
      style={{ alignItems: 'flex-start' }}
    >
      <input
        type="radio"
        name="activeStrategyPreset"
        value={preset.id}
        checked={isActive}
        onChange={() => onChange(preset.id)}
      />
      <div className="mode-card-inner" style={{ width: '100%' }}>
        <span className="mode-card-title">
          {preset.displayName}
          {preset.id === RECOMMENDED_PRESET_ID && (
            <span
              style={{
                marginLeft: '0.5rem',
                fontSize: '0.7rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--green, #3fb950)',
              }}
            >
              Recommended
            </span>
          )}
        </span>
        <span className="mode-card-desc" style={{ marginBottom: '0.5rem' }}>
          {preset.description}
        </span>
        <div style={{ fontSize: '0.85rem', color: 'var(--muted, #8b949e)', display: 'grid', gap: '0.25rem' }}>
          <div>
            <strong>Strategies:</strong>{' '}
            {preset.enabledStrategies.length > 0
              ? preset.enabledStrategies.join(', ')
              : 'none (engine idle)'}
          </div>
          <div>
            <strong>Symbols:</strong>{' '}
            {preset.symbolFilter === null
              ? (preset.strategyUniverse
                  ? 'crypto watchlist, narrowed per strategy below'
                  : 'entire crypto watchlist')
              : preset.symbolFilter.join(', ')}
          </div>
          {preset.strategyUniverse && (
            <div>
              <strong>Per-strategy universe:</strong>{' '}
              {Object.entries(preset.strategyUniverse)
                .map(([strat, syms]) => `${strat} → ${(syms ?? []).join(', ') || 'none'}`)
                .join('; ')}
            </div>
          )}
        </div>
      </div>
    </label>
  );
}

function StrategyPresetSection({
  active,
  onChange,
}: {
  active: StrategyPresetId;
  onChange: (id: StrategyPresetId) => void;
}) {
  const primaryPresets = PRIMARY_PRESET_IDS.map(id => STRATEGY_PRESETS[id]);
  const advancedPresets = Object.values(STRATEGY_PRESETS).filter(
    p => !PRIMARY_PRESET_IDS.includes(p.id),
  );
  // Auto-open the Advanced list when the saved selection lives in it, so the
  // active radio is always visible (and the user can tell what's persisted).
  const activeIsAdvanced = advancedPresets.some(p => p.id === active);
  const [showAdvanced, setShowAdvanced] = useState(activeIsAdvanced);
  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Crypto Strategy Preset</h2>
      <p className="settings-hint">
        Choose which crypto strategies fire and on which symbols. Switching takes effect
        on the next engine tick (no restart required).
      </p>
      <p className="settings-hint" style={{ marginTop: '0.5rem' }}>
        Why is the engine paused by default? QuantTrader's fee-aware backtests (TRA-523,
        re-validated in TRA-695) re-ran every legacy roster net of Coinbase taker fees and
        found <strong>none</strong> profitable out-of-sample, so the OOS-failed legacy
        strategies were retired (TRA-697). Until a strategy clears the Live-Trading Promotion
        Gate, <strong>No-trade</strong> is the recommended setting; <strong>Crypto Core</strong>{' '}
        runs DCA on BTC/SOL as a demo/paper forward leg to gather forward evidence.
      </p>
      <div className="strategy-preset-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }}>
        {primaryPresets.map(preset => (
          <StrategyPresetCard key={preset.id} preset={preset} active={active} onChange={onChange} />
        ))}
      </div>

      {advancedPresets.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn-secondary btn-sm"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced(v => !v)}
          >
            {showAdvanced ? 'Hide advanced presets' : 'Advanced / show all presets'}
          </button>
          {showAdvanced && (
            <>
              <p className="settings-hint" style={{ marginTop: '0.5rem' }}>
                These legacy and experimental presets are kept for reference and live tests.
                They are higher-turnover and not recommended — taker fees make them
                unprofitable in practice.
              </p>
              <div
                className="strategy-preset-list"
                style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}
              >
                {advancedPresets.map(preset => (
                  <StrategyPresetCard key={preset.id} preset={preset} active={active} onChange={onChange} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <p className="settings-hint" style={{ marginTop: '0.75rem' }}>
        Note: this selection applies to the <strong>Live</strong> engine only. The Demo
        engine runs a fixed preset (<code>DEMO_STRATEGY_PRESET</code>, default{' '}
        <code>crypto_core</code> since TRA-698) so the demo dashboard stays actively trading
        on paper for evaluation. On the server the <code>LIVE_STRATEGY_PRESET</code> environment
        variable (when set) overrides this selection for the live engine — ops use it to
        pin a preset for live tests; drop the env var to release control back to this
        per-user setting.
      </p>
    </section>
  );
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
  const [resetPending, setResetPending] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [coinbaseTestStatus, setCoinbaseTestStatus] = useState<'idle' | 'testing'>('idle');
  const [coinbaseTestResult, setCoinbaseTestResult] = useState<
    | null
    | { ok: true; authScheme: 'hmac' | 'cdp'; accountCount: number; currencies: string[] }
    | { ok: false; authScheme?: 'hmac' | 'cdp'; error: string }
  >(null);
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
  // TRA-222 — one-shot $1 BTC-USD market BUY to verify the live order path
  // before flipping auto-trading on. The server caps quoteSize at $5.
  const [coinbaseOrderStatus, setCoinbaseOrderStatus] = useState<'idle' | 'placing'>('idle');
  const [coinbaseOrderResult, setCoinbaseOrderResult] = useState<
    | null
    | {
        ok: true;
        authScheme?: 'hmac' | 'cdp';
        orderId: string;
        productId: string;
        quoteSize: number;
        status: string;
        fillPrice?: number;
        fillSize?: number;
      }
    | { ok: false; authScheme?: 'hmac' | 'cdp'; error: string }
  >(null);

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
        onModeChange?.(persisted.mode);
        onSettingsSaved?.(persisted);
      } else {
        // TRA-511 — discriminate the new `settings_persist_failed` code from
        // a generic non-OK so the footer can tell the user their changes did
        // NOT make it to disk, rather than the older ambiguous "Save failed".
        const errData = await r.json().catch(() => null) as { code?: string } | null;
        setSaveErrorKind(errData?.code === 'settings_persist_failed' ? 'persist' : 'network');
        setSaveStatus('error');
      }
    } catch {
      setSaveErrorKind('network');
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

  async function handlePlaceCoinbaseTestOrder() {
    if (!window.confirm(
      'Place a real $1 USD market buy of BTC-USD against your live Coinbase account?\n\n'
      + 'This is intended as a one-shot smoke test to confirm orders clear before enabling auto-trading. '
      + 'The BTC will sit in your Coinbase wallet — manage it in the Coinbase app.',
    )) {
      return;
    }
    setCoinbaseOrderStatus('placing');
    setCoinbaseOrderResult(null);
    try {
      const r = await fetch(`${httpUrl}/api/crypto/coinbase/place-test-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ productId: 'BTC-USD', quoteSize: 1 }),
      });
      const data = await r.json();
      setCoinbaseOrderResult(data);
    } catch (err) {
      setCoinbaseOrderResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setCoinbaseOrderStatus('idle');
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

              {/* TRA-232 — Daily trade limits are stocks/options only today.
                  The crypto engine doesn't enforce a per-day cap, so on the
                  Crypto dashboard we hide both rows to stop showing irrelevant
                  stock settings on a crypto page. */}
              {(!context || context === 'stocks') && (
                <div className="settings-field">
                  <label>Stock Daily Trades Limit</label>
                  <input
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
                  <label>Options Daily Trades Limit</label>
                  <input
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
                  per (mode × dashboard) so the Crypto and Stocks dashboards
                  no longer share a slot, and Demo edits don't bleed into
                  Live. The standalone settings page (no `context`) writes to
                  the Stocks bucket by default to preserve the historical
                  behaviour where these inputs surfaced once globally. */}
              {(() => {
                const market: Market = context ?? 'stocks';
                const mode: AccountMode = 'demo';
                const ratioKey = managedAccountRatioField(market, mode);
                const riskKey = riskPerTradeField(market, mode);
                const ratio = resolveManagedAccountRatio(settings, market, mode);
                const risk = resolveRiskPerTrade(settings, market, mode);
                const labelSuffix = context === 'crypto'
                  ? ' (Demo Crypto)'
                  : context === 'stocks' ? ' (Demo Stocks)' : '';
                return (
                  <>
                    <div className="settings-field">
                      <label>{`Managed Account Ratio (%)${labelSuffix}`}</label>
                      <input
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
                        {context === 'crypto' ? ' demo crypto' : context === 'stocks' ? ' demo stocks/options' : ' demo'}.
                      </span>
                    </div>
                    <div className="settings-field">
                      <label>{`Risk Per Trade (%)${labelSuffix}`}</label>
                      <input
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
                        {context === 'crypto' ? ' demo crypto' : context === 'stocks' ? ' demo stocks/options' : ' demo'}.
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
                govern equity (ORB) signals. */}
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
                  // TRA-346 — only revert the demo bucket for the dashboard the
                  // user is on; the Live bucket and the *other* dashboard's
                  // values stay untouched. With no context we revert both demo
                  // buckets to keep parity with the pre-346 global page.
                  const market: Market | undefined = context;
                  const next: AccountSettings = {
                    ...s,
                    demoEquity: DEFAULT_ACCOUNT_SETTINGS.demoEquity,
                    demoEquityStocks: DEFAULT_ACCOUNT_SETTINGS.demoEquityStocks,
                    demoEquityCrypto: DEFAULT_ACCOUNT_SETTINGS.demoEquityCrypto,
                    dailyTradesLimit: DEFAULT_ACCOUNT_SETTINGS.dailyTradesLimit,
                    optionsDailyTradesLimit: DEFAULT_ACCOUNT_SETTINGS.optionsDailyTradesLimit,
                  };
                  if (!market || market === 'stocks') {
                    next.managedAccountRatioDemoStocks = DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
                    next.riskPerTradeDemoStocks = DEFAULT_ACCOUNT_SETTINGS.riskPerTrade;
                  }
                  if (!market || market === 'crypto') {
                    next.managedAccountRatioDemoCrypto = DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
                    next.riskPerTradeDemoCrypto = DEFAULT_ACCOUNT_SETTINGS.riskPerTrade;
                  }
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
          Live crypto credentials are stored per-market (TRA-165) so a Coinbase
          key on the Crypto dashboard never bleeds into the Stocks dashboard.
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
                same engine code path drives sizing for stocks, options,
                and crypto). Daily trade limits are stocks/options only,
                so they're hidden under the Crypto context. */}
            <div className="live-brokerage-block">
              <h3 className="settings-subheading">Live Trading Risk</h3>
              <div className="settings-grid">
                {/* TRA-346 — scoped to (live × context) so Crypto and Stocks
                    track separate live values, and saving here never alters
                    the Demo bucket. */}
                {(() => {
                  const market: Market = context ?? 'stocks';
                  const mode: AccountMode = 'live';
                  const ratioKey = managedAccountRatioField(market, mode);
                  const riskKey = riskPerTradeField(market, mode);
                  const ratio = resolveManagedAccountRatio(settings, market, mode);
                  const risk = resolveRiskPerTrade(settings, market, mode);
                  const liveBrokerLabel = context === 'crypto'
                    ? 'live Coinbase'
                    : context === 'stocks' ? 'live Tradier (options)' : 'live brokerage';
                  return (
                    <>
                      <div className="settings-field">
                        <label>Managed Account Ratio (%)</label>
                        <input
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
                        <label>Risk Per Trade (%)</label>
                        <input
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
                {/* TRA-341 — operator override for the §6 single-symbol short
                    cap on the live perp router (default 15% of strategy equity).
                    Crypto-only; the cross-strategy (20%) and total-book (30%)
                    ceilings still apply downstream. Blank = spec default. The
                    server also reads `LIVE_SINGLE_SYMBOL_SHORT_CAP` as a
                    process-wide fallback when this knob is unset, so an
                    operator can move the floor without per-user saves. */}
                {(!context || context === 'crypto') && (
                  <div className="settings-field">
                    <label>Single-Symbol Short Cap (%)</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={
                        settings.liveSingleSymbolShortCap === undefined
                          ? ''
                          : Math.round(settings.liveSingleSymbolShortCap * 100)
                      }
                      onChange={e => {
                        const raw = e.target.value;
                        if (raw === '') {
                          set('liveSingleSymbolShortCap', undefined);
                        } else {
                          set('liveSingleSymbolShortCap', Number(raw) / 100);
                        }
                      }}
                    />
                    <span className="field-hint">
                      Live perp shorts only. Max single-symbol notional per strategy as % of strategy equity (default: 15%). Blank → spec default. Cross-strategy (20%) and total-book (30%) ceilings still apply.
                    </span>
                  </div>
                )}
                {/* TRA-327 — Live limits bind to dailyTradesLimitLive /
                    optionsDailyTradesLimitLive so editing the Demo cap on
                    another visit never drags the Live cap with it. Falls back
                    to the legacy un-suffixed field when the user hasn't yet
                    saved a live-only value. */}
                {(!context || context === 'stocks') && (
                  <div className="settings-field">
                    <label>Stock Daily Trades Limit</label>
                    <input
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
                    <label>Options Daily Trades Limit</label>
                    <input
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

            {(!context || context === 'crypto') && (
              <div className="live-brokerage-block">
                {!context && <h3 className="settings-subheading">Crypto (Coinbase)</h3>}

                <div className="settings-grid">
                  {/* TRA-457 — Brokerage selector removed: Coinbase is the only
                      crypto broker, and the crypto engine deliberately never
                      gates on `liveBrokerageTypeCrypto`, so the single-option
                      dropdown was redundant clutter. */}
                  <div className="settings-field">
                    <label>API Key</label>
                    <PasswordInput
                      value={readLiveApiKey(settings, 'crypto')}
                      onChange={v => set('liveApiKeyCrypto', v)}
                      placeholder={'organizations/{org-id}/apiKeys/{key-id}'}
                      autoComplete="off"
                      dataCredField="liveApiKeyCrypto"
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
                      placeholder={'-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----'}
                      autoComplete="off"
                      multiline
                      rows={6}
                      dataCredField="liveApiSecretCrypto"
                    />
                    <p className="field-hint">
                      For CDP keys, paste the entire private key — including the
                      <code> -----BEGIN </code> and <code> -----END </code> lines and all the
                      lines in between. The full JSON file Coinbase gives you on download
                      also works. For legacy HMAC keys, paste the shared secret on a single line.
                    </p>
                  </div>
                </div>

                {/* TRA-457 — "Trading Mode" radio (AI-in-brokerage vs
                    transfer-to-platform) removed: it was dead. Nothing in
                    packages/server or packages/engine reads `liveTradeMode*`,
                    and the transfer-to-platform flow was never built — the
                    crypto engine always trades directly in Coinbase. */}

                {/* TRA-249-E — Live trading routing (spot / hybrid / perp-only). */}
                <div className="settings-field" style={{ marginTop: '1.25rem' }}>
                  <label>Live trading mode</label>
                  <div className="radio-group">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="liveTradeRouting-crypto"
                        value="spot_only"
                        checked={(settings.liveTradeRoutingCrypto ?? 'hybrid') === 'spot_only'}
                        onChange={() => set('liveTradeRoutingCrypto', 'spot_only')}
                      />
                      <div>
                        <strong>Spot only</strong>
                        <p className="field-hint">Only spot Coinbase orders. SELL signals on long-only spot accounts are skipped.</p>
                      </div>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="liveTradeRouting-crypto"
                        value="hybrid"
                        checked={(settings.liveTradeRoutingCrypto ?? 'hybrid') === 'hybrid'}
                        onChange={() => set('liveTradeRoutingCrypto', 'hybrid')}
                      />
                      <div>
                        <strong>Hybrid (recommended)</strong>
                        <p className="field-hint">BUY → spot, SELL → perp short when the symbol has a Coinbase INTX listing, else skipped.</p>
                      </div>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="liveTradeRouting-crypto"
                        value="perp_only"
                        checked={(settings.liveTradeRoutingCrypto ?? 'hybrid') === 'perp_only'}
                        onChange={() => set('liveTradeRoutingCrypto', 'perp_only')}
                      />
                      <div>
                        <strong>Perp only</strong>
                        <p className="field-hint">Both legs route to Coinbase INTX perpetual futures.</p>
                      </div>
                    </label>
                  </div>
                </div>

                {/* TRA-457 — "Max leverage" knob hidden (not deleted). It
                    round-trips to `AccountSettings.liveMaxLeverageCrypto` and
                    the server clamps it to [1,5], but the live engine pins
                    leverage at 1× (PERP_SHORT_LEVERAGE) and never reads the
                    field, so the control has no effect today. Hidden rather
                    than removed so a future leverage ramp can re-surface it
                    without a settings migration — restore the block below:

                <div className="settings-field" style={{ marginTop: '1.25rem' }}>
                  <label>Max leverage</label>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    step={1}
                    value={settings.liveMaxLeverageCrypto ?? 1}
                    onChange={e => set('liveMaxLeverageCrypto', Math.max(1, Math.min(5, Math.round(Number(e.target.value)))))}
                  />
                  <span className="field-hint">
                    Leverage ceiling for crypto perp positions (1-5). Phase-1 the engine pins leverage at 1x.
                  </span>
                </div>
                */}
              </div>
            )}

            {/* TRA-221 — Options live trading via Tradier. Rendered in the
                admin (no-context) and stocks-dashboard views, since options
                run on the same equity engine path. */}
            {(!context || context === 'stocks') && (
              <div className="live-brokerage-block" style={{ marginTop: !context ? '1.5rem' : 0 }}>
                {!context && <h3 className="settings-subheading">Options (Tradier)</h3>}

                <div className="settings-grid">
                  <div className="settings-field">
                    <label>Brokerage</label>
                    <select
                      value={readLiveBrokerageTypeOptions(settings)}
                      onChange={e => set('liveBrokerageTypeOptions', e.target.value as BrokerageType)}
                    >
                      <option value="tradier">Tradier</option>
                    </select>
                  </div>

                  <div className="settings-field">
                    <label>Environment</label>
                    <select
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
                    <label>Trade</label>
                    <select
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
                      autoComplete="off"
                      dataCredField={liveApiKeyOptionsField(readLiveTradierEnvOptions(settings))}
                    />
                    <p className="field-hint">
                      Generate from Tradier dashboard → API Access. Production tokens are separate
                      from sandbox tokens — this field saves only to the selected environment above.
                    </p>
                  </div>

                  <div className="settings-field">
                    <label>
                      Account ID ({readLiveTradierEnvOptions(settings) === 'production' ? 'Production' : 'Sandbox'})
                    </label>
                    <input
                      type="text"
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

            {/* TRA-222 — one-shot $1 test order. Only shown in Live mode so a
                misclick in demo can't burn real money on a user who hasn't
                explicitly switched over yet. */}
            {context === 'crypto' && settings.mode === 'live' && (
              <div className="settings-field" style={{ marginTop: '1rem' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handlePlaceCoinbaseTestOrder}
                  disabled={coinbaseOrderStatus === 'placing'}
                >
                  {coinbaseOrderStatus === 'placing' ? 'Placing $1 order…' : 'Place $1 BTC-USD test order'}
                </button>
                <p className="field-hint">
                  Places a real $1 USD market buy of BTC against your live Coinbase account so you can confirm
                  the order path works end-to-end before enabling auto-trading. The BTC stays in your Coinbase
                  wallet until you sell it (manage in the Coinbase app).
                </p>
                {coinbaseOrderResult && (
                  coinbaseOrderResult.ok ? (
                    <div className="save-success" style={{ marginTop: '0.5rem' }}>
                      ✓ Placed order {coinbaseOrderResult.orderId} ({coinbaseOrderResult.productId},
                      ${coinbaseOrderResult.quoteSize}, status={coinbaseOrderResult.status})
                      {coinbaseOrderResult.fillPrice != null && coinbaseOrderResult.fillSize != null && (
                        <> — filled {coinbaseOrderResult.fillSize} @ ${coinbaseOrderResult.fillPrice.toFixed(2)}</>
                      )}
                      .
                    </div>
                  ) : (
                    <div className="save-error" style={{ marginTop: '0.5rem' }}>
                      ✗ {coinbaseOrderResult.authScheme ? `auth=${coinbaseOrderResult.authScheme} — ` : ''}{coinbaseOrderResult.error}
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
                  <strong>Live Tradier trading is enabled.</strong> Once you save a valid Tradier API token and Account ID and switch the account to <em>Live</em>, the engine routes signals based on the <em>Trade</em> selector above. <em>Options only</em> (default, TRA-220) sends the relative-value scanner to Tradier as <code>buy_to_open</code> market orders. <em>Positions (equity)</em> and <em>Both</em> activate stock-share routing — BB-fade / ORB / Ichimoku entries fire as Tradier OTOCO bracket orders when the &quot;Tradier Live trades equities&quot; toggle is also on (TRA-335).
                </>
              )}
            </div>
          </section>
        )}

        {/* TRA-325 — Crypto strategy preset selector. Visible in admin (no-
            context) and crypto-dashboard views since the preset only affects
            CryptoSignalEngine today; hidden on the Stocks dashboard to avoid
            implying it gates equity trading. */}
        {(!context || context === 'crypto') && (
          <StrategyPresetSection
            active={settings.activeStrategyPreset ?? DEFAULT_STRATEGY_PRESET_ID}
            onChange={id => set('activeStrategyPreset', id)}
          />
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
              Save failed — check server connection.
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

      {/* ── Profile / Change Password / Notifications / User Management (hidden in crypto/stocks context) */}
      {!context && <ProfileSection token={token} httpUrl={httpUrl} />}
      {!context && <ChangePasswordSection token={token} httpUrl={httpUrl} />}
      {/* TRA-567 (TRA-410 A3) — standalone Notifications surface. Account-global,
          so it lives on the main Settings page next to Profile, not the
          per-market dashboard settings. */}
      {!context && <NotificationsSettings token={token} httpUrl={httpUrl} />}
      {isAdmin && <UserManagementSection token={token} httpUrl={httpUrl} />}
    </div>
  );
}
