import { useState } from 'react';
import { HTTP_URL } from './server-url';
import PasswordInput from './components/PasswordInput';
import { MIN_PASSWORD_LENGTH } from './password-policy';

// TRA-4479 — the reset link carries the username as well as the code, because a
// redemption is now keyed by username+code. Both are stripped from the URL below
// so neither is bookmarked or shared.
function getUrlResetParams(): { code: string; username: string } {
  const params = new URLSearchParams(window.location.search);
  return { code: params.get('reset_code') ?? '', username: params.get('reset_user') ?? '' };
}

type Step = 'request' | 'reset' | 'done';

interface Props {
  onBack: () => void;
}

export default function ForgotPasswordPage({ onBack }: Props) {
  const urlParams = getUrlResetParams();
  const [step, setStep] = useState<Step>(urlParams.code ? 'reset' : 'request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState(() => {
    if (urlParams.code) {
      // Remove the token from the URL so it isn't shared or bookmarked
      const url = new URL(window.location.href);
      url.searchParams.delete('reset_code');
      url.searchParams.delete('reset_user');
      window.history.replaceState(null, '', url.toString());
    }
    return urlParams.code;
  });
  const [username, setUsername] = useState(urlParams.username);
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
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (!username.trim()) {
      setError('Enter the username shown in your reset email');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${HTTP_URL}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, newPassword, username: username.trim() }),
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
            <p className="login-sub">Enter the username and 8-digit code from your email, and your new password</p>
            <form onSubmit={handleResetPassword} className="login-form">
              <label className="login-label">
                Username
                <input
                  className="login-input"
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                  disabled={loading}
                />
              </label>
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
                <PasswordInput
                  value={newPassword}
                  onChange={setNewPassword}
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  required
                  disabled={loading}
                />
              </label>
              <label className="login-label">
                Confirm Password
                <PasswordInput
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
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
