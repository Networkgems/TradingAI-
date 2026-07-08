import { useState } from 'react';
import { HTTP_URL } from './server-url';

interface Props {
  onLogin: (token: string) => void;
  onForgotPassword: () => void;
  onSignUp: () => void;
  /** Public link to the Features & Strategies page (logged-out accessible). */
  onFeatures: () => void;
}

export default function LoginPage({ onLogin, onForgotPassword, onSignUp, onFeatures }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // TRA-1505 — second-factor step. When the password step returns
  // `twoFactorRequired`, we hold the short-lived pending token and switch the
  // form to the code-entry step. A session token is only ever accepted from the
  // server after /api/auth/2fa/verify — there is no client-side "verified" flag.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');

  function completeLogin(token: string) {
    localStorage.setItem('auth_token', token);
    onLogin(token);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${HTTP_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await r.json() as { token?: string; error?: string; twoFactorRequired?: boolean; pendingToken?: string };
      if (r.ok && data.twoFactorRequired && data.pendingToken) {
        setPendingToken(data.pendingToken);
        setNotice('We emailed you a 6-digit code. Enter it below to finish signing in.');
      } else if (r.ok && data.token) {
        completeLogin(data.token);
      } else {
        setError(data.error ?? 'Invalid credentials');
      }
    } catch {
      setError('Cannot reach server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingToken) return;
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${HTTP_URL}/api/auth/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken, code: code.trim() }),
      });
      const data = await r.json() as { token?: string; error?: string };
      if (r.ok && data.token) {
        completeLogin(data.token);
      } else {
        setError(data.error ?? 'Incorrect code.');
      }
    } catch {
      setError('Cannot reach server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (!pendingToken) return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const r = await fetch(`${HTTP_URL}/api/auth/2fa/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken }),
      });
      const data = await r.json() as { ok?: boolean; error?: string; message?: string };
      if (r.ok && data.ok) {
        setNotice(data.message ?? 'A new code has been sent.');
      } else {
        setError(data.error ?? 'Could not resend the code.');
      }
    } catch {
      setError('Cannot reach server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  function backToPassword() {
    setPendingToken(null);
    setCode('');
    setError('');
    setNotice('');
  }

  if (pendingToken) {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1 className="login-title">TradingAI</h1>
          <p className="login-sub">Two-factor verification</p>
          <form onSubmit={handleVerify} className="login-form">
            {notice && <p className="login-sub">{notice}</p>}
            <label className="login-label">
              Verification code
              <input
                className="login-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder="6-digit code or backup code"
                autoFocus
                required
                disabled={loading}
              />
            </label>
            {error && <p className="login-error">{error}</p>}
            <button type="submit" disabled={loading} className="login-btn">
              {loading ? 'Verifying…' : 'Verify & sign in'}
            </button>
            <button type="button" className="login-forgot-link" onClick={handleResend} disabled={loading}>
              Resend code
            </button>
            <button type="button" className="login-forgot-link" onClick={backToPassword} disabled={loading}>
              Back to sign in
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <h1 className="login-title">TradingAI</h1>
        <p className="login-sub">Sign in to access the dashboard</p>
        <form onSubmit={handleSubmit} className="login-form">
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
            Password
            <input
              className="login-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              disabled={loading}
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" disabled={loading} className="login-btn">
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
          <button
            type="button"
            className="login-forgot-link"
            onClick={onForgotPassword}
            disabled={loading}
          >
            Forgot password?
          </button>
          <button
            type="button"
            className="login-forgot-link"
            onClick={onSignUp}
            disabled={loading}
          >
            Don't have an account? Sign up
          </button>
          <button
            type="button"
            className="login-forgot-link"
            onClick={onFeatures}
            disabled={loading}
          >
            See features &amp; strategies
          </button>
        </form>
      </div>
    </div>
  );
}
