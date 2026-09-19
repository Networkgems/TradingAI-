// TRA-4729 — moved verbatim out of SettingsPage.tsx; no behaviour change.
import { useEffect, useState } from 'react';
import type { SaveStatus } from './types';

export function ProfileSection({ token, httpUrl }: { token: string; httpUrl: string }) {
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

