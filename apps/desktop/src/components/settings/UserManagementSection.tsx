// TRA-4729 — moved verbatim out of SettingsPage.tsx; no behaviour change.
import { useCallback, useEffect, useState } from 'react';
import { MIN_PASSWORD_LENGTH } from '../../password-policy';
import { PasswordInput } from './PasswordInput';
import type { SafeUser } from './types';

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
    if (editNewPassword.length < MIN_PASSWORD_LENGTH) {
      setPwMessage({ kind: 'err', text: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
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
                  minLength={MIN_PASSWORD_LENGTH}
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
                  disabled={pwSetting || editNewPassword.length < MIN_PASSWORD_LENGTH}
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
                    minLength={MIN_PASSWORD_LENGTH}
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

