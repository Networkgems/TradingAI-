import { useEffect, useState } from 'react';
import type {
  AccountSettings,
  BrokerageType,
  LiveTradeMode,
  LiveTradierMarkets,
  StrategyPresetId,
  TradierEnv,
} from '@trading-app/shared';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  DEFAULT_STRATEGY_PRESET_ID,
  STRATEGY_PRESETS,
} from '@trading-app/shared';

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
// TRA-336 — markets selector for Tradier Live. Default ('options') preserves
// the TRA-220 options-only behaviour for users who saved before the field
// existed.
function readLiveTradierMarkets(s: AccountSettings): LiveTradierMarkets {
  return s.liveTradierMarkets ?? 'options';
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
 * TRA-325 — strategy preset selector. Lists every preset from
 * `STRATEGY_PRESETS` as a radio card, expanded to show enabled strategies
 * and the symbol-filter (or "all watchlist symbols" when null). The active
 * id lives on `AccountSettings.activeStrategyPreset` so it saves on the
 * existing form submit alongside the other account settings.
 */
function StrategyPresetSection({
  active,
  onChange,
}: {
  active: StrategyPresetId;
  onChange: (id: StrategyPresetId) => void;
}) {
  const presets = Object.values(STRATEGY_PRESETS);
  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Crypto Strategy Preset</h2>
      <p className="settings-hint">
        Choose which crypto strategies fire and on which symbols. Presets are read-only —
        adding a new preset requires a code change. Switching takes effect on the next
        engine tick (no restart required).
      </p>
      <div className="strategy-preset-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }}>
        {presets.map(preset => {
          const isActive = preset.id === active;
          return (
            <label
              key={preset.id}
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
                <span className="mode-card-title">{preset.displayName}</span>
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
                      ? 'entire crypto watchlist'
                      : preset.symbolFilter.join(', ')}
                  </div>
                </div>
              </div>
            </label>
          );
        })}
      </div>
      <p className="settings-hint" style={{ marginTop: '0.75rem' }}>
        Note: the <code>LIVE_STRATEGY_PRESET</code> environment variable on the server
        (when set) overrides this selection process-wide. Used by ops to pin a preset
        across all users for live tests; drop the env var to release control back to
        per-user settings.
      </p>
    </section>
  );
}

export default function SettingsPage({ token, httpUrl, context, onModeChange, onSettingsSaved }: Props) {
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
  const [tradierTestStatus, setTradierTestStatus] = useState<'idle' | 'testing'>('idle');
  const [tradierTestResult, setTradierTestResult] = useState<
    | null
    | { ok: true; env: TradierEnv; accountNumber?: string; status?: string; classification?: string }
    | { ok: false; error: string }
  >(null);
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
        // TRA-327 — read the server-clamped settings back from the response so
        // the local form state and the parent dashboard reflect the values the
        // server actually persisted (no hard refresh required).
        const data = await r.json().catch(() => null) as { ok?: boolean; settings?: AccountSettings } | null;
        const persisted = data?.settings ?? settings;
        setSettings(prev => ({ ...prev, ...persisted }));
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
        onModeChange?.(persisted.mode);
        onSettingsSaved?.(persisted);
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

  async function handleTestTradier() {
    setTradierTestStatus('testing');
    setTradierTestResult(null);
    try {
      const r = await fetch(`${httpUrl}/api/options/tradier/test-connection`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      setTradierTestResult(data);
    } catch (err) {
      setTradierTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTradierTestStatus('idle');
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

              {/* TRA-232 — Managed Account Ratio + Risk Per Trade apply to all
                  three engines (stocks, options, crypto demo + live), so they
                  stay visible in every context. */}
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
                  optionsDailyTradesLimit: DEFAULT_ACCOUNT_SETTINGS.optionsDailyTradesLimit,
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
                <div className="settings-field">
                  <label>Managed Account Ratio (%)</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={Math.round(settings.managedAccountRatio * 100)}
                    onChange={e => set('managedAccountRatio', Number(e.target.value) / 100)}
                  />
                  <span className="field-hint">
                    Portion of equity auto-traded (default: 50%). Applies to live
                    {context === 'crypto' ? ' Coinbase' : context === 'stocks' ? ' Tradier (options)' : ' brokerage'} orders.
                  </span>
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
                  <span className="field-hint">
                    Max equity risked per live trade (default: 1%). Applied to position sizing on every order.
                  </span>
                </div>
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
                      placeholder={'-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----'}
                      autoComplete="off"
                      multiline
                      rows={6}
                    />
                    <p className="field-hint">
                      For CDP keys, paste the entire private key — including the
                      <code> -----BEGIN </code> and <code> -----END </code> lines and all the
                      lines in between. The full JSON file Coinbase gives you on download
                      also works. For legacy HMAC keys, paste the shared secret on a single line.
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

                {/* TRA-249-E — Live trading routing (spot / hybrid / perp-only)
                    and operator-facing leverage cap. The leverage cap is
                    surfaced even though the engine pins at 1× today so raising
                    the ceiling later doesn't require a settings migration. */}
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
                    Leverage ceiling for crypto perp positions (1–5). Phase-1 the engine pins leverage at 1× —
                    raising this above 1 has no effect today, but the setting is surfaced so future ramps don't
                    require a migration.
                  </span>
                </div>
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
                    />
                  </div>
                </div>

                <div className="settings-field" style={{ marginTop: '1rem' }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleTestTradier}
                    disabled={tradierTestStatus === 'testing'}
                  >
                    {tradierTestStatus === 'testing' ? 'Testing…' : 'Test Tradier Connection'}
                  </button>
                  <p className="field-hint">
                    Reads your account profile from Tradier to verify the saved credentials. No orders are placed.
                    Save the form first if you just edited the API token.
                  </p>
                  {tradierTestResult && (
                    tradierTestResult.ok ? (
                      <div className="save-success" style={{ marginTop: '0.5rem' }}>
                        ✓ Connected (env={tradierTestResult.env}). Tradier account
                        {tradierTestResult.accountNumber ? ` ${tradierTestResult.accountNumber}` : ''}
                        {tradierTestResult.status ? `, status=${tradierTestResult.status}` : ''}
                        {tradierTestResult.classification ? `, ${tradierTestResult.classification}` : ''}.
                      </div>
                    ) : (
                      <div className="save-error" style={{ marginTop: '0.5rem' }}>
                        ✗ {tradierTestResult.error}
                      </div>
                    )
                  )}
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
                  <strong>Live Tradier trading is enabled.</strong> Once you save a valid Tradier API token and Account ID and switch the account to <em>Live</em>, the engine routes signals based on the <em>Trade</em> selector above. <em>Options only</em> (default, TRA-220) sends the relative-value scanner to Tradier as <code>buy_to_open</code> market orders. <em>Positions (equity)</em> and <em>Both</em> activate stock-share routing — wired by TRA-335; until that ships, those modes only suppress the options mirror.
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
