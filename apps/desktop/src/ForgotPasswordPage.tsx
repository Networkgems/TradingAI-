import { useState } from 'react';

const HTTP_URL = (import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:4242').replace(/^ws/, 'http');

type Step = 'request' | 'reset' | 'done';

interface Props {
  onBack: () => void;
}

export default function ForgotPasswordPage({ onBack }: Props) {
  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleRequestReset(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${HTTP_URL}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (r.ok) {
        setStep('reset');
      } else {
        const data = await r.json() as { error?: string };
        setError(data.error ?? 'Request failed');
      }
    } catch {
      setError('Cannot reach server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${HTTP_URL}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, newPassword }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (r.ok && data.ok) {
        setStep('done');
      } else {
        setError(data.error ?? 'Reset failed');
      }
    } catch {
      setError('Cannot reach server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <h1 className="login-title">TradingAI</h1>

        {step === 'request' && (
          <>
            <p className="login-sub">Enter your email to receive a reset code</p>
            <form onSubmit={handleRequestReset} className="login-form">
              <label className="login-label">
                Email Address
                <input
                  className="login-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                  disabled={loading}
                />
              </label>
              {error && <p className="login-error">{error}</p>}
              <button type="submit" disabled={loading} className="login-btn">
                {loading ? 'Sending…' : 'Send Reset Code'}
              </button>
              <button type="button" className="login-forgot-link" onClick={onBack} disabled={loading}>
                Back to Sign In
              </button>
            </form>
          </>
        )}

        {step === 'reset' && (
          <>
            <p className="login-sub">Enter the 8-digit code from your email and your new password</p>
            <form onSubmit={handleResetPassword} className="login-form">
              <label className="login-label">
                Reset Code
                <input
                  className="login-input"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{8}"
                  maxLength={8}
                  placeholder="00000000"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                  disabled={loading}
                />
              </label>
              <label className="login-label">
                New Password
                <input
                  className="login-input"
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={6}
                  required
                  disabled={loading}
                />
              </label>
              <label className="login-label">
                Confirm Password
                <input
                  className="login-input"
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={6}
                  required
                  disabled={loading}
                />
              </label>
              {error && <p className="login-error">{error}</p>}
              <button type="submit" disabled={loading} className="login-btn">
                {loading ? 'Resetting…' : 'Reset Password'}
              </button>
              <button
                type="button"
                className="login-forgot-link"
                onClick={() => { setStep('request'); setError(''); }}
                disabled={loading}
              >
                Request a new code
              </button>
            </form>
          </>
        )}

        {step === 'done' && (
          <>
            <p className="login-sub" style={{ color: 'var(--green)', textAlign: 'center' }}>
              Password reset successfully!
            </p>
            <div className="login-form">
              <button className="login-btn" onClick={onBack}>
                Back to Sign In
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
