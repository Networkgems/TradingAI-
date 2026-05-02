import { useState } from 'react';
import { HTTP_URL } from './server-url';

interface Props {
  onLogin: (token: string) => void;
  onForgotPassword: () => void;
  onSignUp: () => void;
}

export default function LoginPage({ onLogin, onForgotPassword, onSignUp }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      const data = await r.json() as { token?: string; error?: string };
      if (r.ok && data.token) {
        localStorage.setItem('auth_token', data.token);
        onLogin(data.token);
      } else {
        setError(data.error ?? 'Invalid credentials');
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
        </form>
      </div>
    </div>
  );
}
