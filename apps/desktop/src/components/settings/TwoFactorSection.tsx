// TRA-4729 — moved verbatim out of SettingsPage.tsx; no behaviour change.
import { useCallback, useEffect, useState } from 'react';
import { PasswordInput } from './PasswordInput';

// TRA-1505 — email two-factor login enrollment. Enabling re-checks the password
// and returns one-time backup codes that are shown exactly once. Disabling also
// requires the password.
export function TwoFactorSection({ token, httpUrl }: { token: string; httpUrl: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [backupRemaining, setBackupRemaining] = useState(0);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${httpUrl}/api/auth/2fa/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const data = await r.json() as { enabled: boolean; backupCodesRemaining: number };
        setEnabled(data.enabled);
        setBackupRemaining(data.backupCodesRemaining);
      }
    } catch { /* leave as unknown */ }
  }, [token, httpUrl]);

  useEffect(() => { void load(); }, [load]);

  async function handleToggle(enable: boolean) {
    setBusy(true);
    setError('');
    setBackupCodes(null);
    try {
      const r = await fetch(`${httpUrl}/api/auth/2fa/${enable ? 'enable' : 'disable'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password }),
      });
      const data = await r.json() as { ok?: boolean; error?: string; backupCodes?: string[] };
      if (r.ok && data.ok) {
        setPassword('');
        if (enable && data.backupCodes) setBackupCodes(data.backupCodes);
        await load();
      } else {
        setError(data.error ?? 'Request failed');
      }
    } catch {
      setError('Cannot reach server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Two-Factor Login (Email)</h2>
      <p className="field-hint" style={{ marginBottom: '0.75rem' }}>
        {enabled === null
          ? 'Loading…'
          : enabled
            ? `Enabled — you'll be emailed a 6-digit code at sign-in. ${backupRemaining} backup code${backupRemaining === 1 ? '' : 's'} remaining.`
            : 'Add a second step at sign-in: a one-time code sent to your account email.'}
      </p>

      {backupCodes && (
        <div className="settings-field" style={{ marginBottom: '1rem' }}>
          <label>Save your backup codes</label>
          <p className="field-hint">
            Each code works once if you can't get the email. Store them somewhere safe — they won't be shown again.
          </p>
          <pre style={{ background: 'var(--panel, #161b22)', border: '1px solid var(--border, #30363d)', borderRadius: 6, padding: '12px', fontFamily: 'monospace', letterSpacing: 1 }}>
            {backupCodes.join('\n')}
          </pre>
        </div>
      )}

      <div className="settings-field">
        <label>Current Password</label>
        <PasswordInput
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={busy}
        />
      </div>
      {error && <p className="save-error" style={{ marginTop: '0.5rem' }}>{error}</p>}
      <div className="settings-footer" style={{ marginTop: '1rem', paddingTop: 0, borderTop: 'none' }}>
        {enabled
          ? (
            <button type="button" className="btn-secondary" disabled={busy || !password} onClick={() => handleToggle(false)}>
              {busy ? 'Working…' : 'Disable Two-Factor'}
            </button>
          )
          : (
            <button type="button" className="btn-primary" disabled={busy || !password} onClick={() => handleToggle(true)}>
              {busy ? 'Working…' : 'Enable Two-Factor'}
            </button>
          )}
      </div>
    </section>
  );
}

