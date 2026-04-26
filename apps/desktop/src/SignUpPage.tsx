import { useState } from 'react';

const HTTP_URL = (import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:4242').replace(/^ws/, 'http');

interface Props {
  onSignUp: (token: string) => void;
  onBack: () => void;
}

export default function SignUpPage({ onSignUp, onBack }: Props) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      });
      const data = await r.json() as { token?: string; error?: string };
      if (r.ok && data.token) {
        localStorage.setItem('auth_token', data.token);
        onSignUp(data.token);
      } else {
        setError(data.error ?? 'Sign up failed');
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
        <p className="login-sub">Create your account</p>
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
            Email
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
          <label className="login-label">
            Password
            <input
              className="login-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
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
              required
              disabled={loading}
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" disabled={loading} className="login-btn">
            {loading ? 'Creating account…' : 'Sign Up'}
          </button>
          <button
            type="button"
            className="login-forgot-link"
            onClick={onBack}
            disabled={loading}
          >
            Already have an account? Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
