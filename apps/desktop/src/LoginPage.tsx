import { useState } from 'react';
import { HTTP_URL } from './server-url';
import PasswordInput from './components/PasswordInput';

interface Props {
  onLogin: (token: string) => void;
  onForgotPassword: () => void;
  onSignUp: () => void;
  /** Public link to the Features & Strategies page (logged-out accessible). */
  onFeatures: () => void;
}

// TRA-2293 — the sign-in card is a small state machine rather than one form:
//
//   password ──password ok, 2FA on──▶ code ──▶ (backupCodes?) ──▶ backup ──▶ in
//        │                              ▲
//        │   "email me a code"          │
//        └──────────▶ codeRequest ──────┘
//        │
//        └──password ok, no email on file──▶ email ──▶ (enrolling?) ──▶ backup ──▶ in
//
// The `email` step exists because an account with no address on file — the seed
// `admin` is one — can neither receive a sign-in code nor enrol in two-factor.
// It runs AFTER the password check, never before: an address collected from an
// unauthenticated caller would let anyone who knows a username redirect that
// account's codes to their own inbox.
type Step = 'password' | 'codeRequest' | 'code' | 'email' | 'backup';

export default function LoginPage({ onLogin, onForgotPassword, onSignUp, onFeatures }: Props) {
  const [step, setStep] = useState<Step>('password');
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

  // TRA-2293 — login-screen two-factor opt-in, and the two things it can leave
  // behind: an address still to collect, and show-once backup codes.
  const [enrollTwoFactor, setEnrollTwoFactor] = useState(false);
  const [email, setEmail] = useState('');
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [enrollAfterEmail, setEnrollAfterEmail] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  function completeLogin(token: string) {
    localStorage.setItem('auth_token', token);
    onLogin(token);
  }

  /**
   * A password-step response that carries a real session token. Two things can
   * still stand between here and the dashboard: an email address we need before
   * the account can use codes at all, and backup codes the user must write down.
   */
  function finishWithToken(token: string, opts: { emailRequired?: boolean; twoFactorPending?: boolean }) {
    if (opts.emailRequired) {
      setSessionToken(token);
      setEnrollAfterEmail(opts.twoFactorPending === true);
      setNotice(
        opts.twoFactorPending
          ? 'Two-factor sign-in needs somewhere to send your codes. Add an email address to finish turning it on.'
          : 'Your account has no email address on file. Add one so we can send you sign-in and recovery codes.',
      );
      setStep('email');
      return;
    }
    completeLogin(token);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${HTTP_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, enrollTwoFactor }),
      });
      const data = await r.json() as {
        token?: string;
        error?: string;
        twoFactorRequired?: boolean;
        pendingToken?: string;
        emailRequired?: boolean;
        twoFactorPending?: boolean;
      };
      if (r.ok && data.twoFactorRequired && data.pendingToken) {
        setPendingToken(data.pendingToken);
        setNotice('We emailed you a 6-digit code. Enter it below to finish signing in.');
        setStep('code');
      } else if (r.ok && data.token) {
        finishWithToken(data.token, data);
      } else {
        setError(data.error ?? 'Invalid credentials');
      }
    } catch {
      setError('Cannot reach server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  // TRA-2293 — passwordless sign-in: mail a one-time code to the address already
  // on the account. The response is intentionally the same whether or not the
  // username exists, so the copy below promises nothing about the account.
  async function handleRequestLoginCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${HTTP_URL}/api/auth/login-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await r.json() as { ok?: boolean; pendingToken?: string; message?: string; error?: string };
      if (r.ok && data.ok && data.pendingToken) {
        setPendingToken(data.pendingToken);
        setNotice(data.message ?? 'If that account exists and has an email on file, a sign-in code is on its way.');
        setStep('code');
      } else {
        setError(data.error ?? 'Could not send a sign-in code.');
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
      const data = await r.json() as { token?: string; error?: string; backupCodes?: string[] };
      if (r.ok && data.token) {
        // Enrolled during this sign-in — show the recovery codes before handing
        // over the dashboard, since the server will never repeat them.
        if (data.backupCodes && data.backupCodes.length > 0) {
          setSessionToken(data.token);
          setBackupCodes(data.backupCodes);
          setStep('backup');
          return;
        }
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

  // TRA-2293 — attach an address to an account that had none, then honour the
  // two-factor opt-in that could not be applied without one.
  async function handleSaveEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionToken) return;
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${HTTP_URL}/api/auth/account/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (!r.ok || !data.ok) {
        setError(data.error ?? 'Could not save that email address.');
        return;
      }
      if (!enrollAfterEmail) {
        completeLogin(sessionToken);
        return;
      }
      // The opt-in was checked on a passwordless-capable account that had no
      // address; now that it does, turn two-factor on. `/2fa/enable`
      // re-authenticates with the password, which is still in form state.
      const e2 = await fetch(`${HTTP_URL}/api/auth/2fa/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ password }),
      });
      const d2 = await e2.json() as { ok?: boolean; error?: string; backupCodes?: string[] };
      if (e2.ok && d2.ok && d2.backupCodes) {
        setBackupCodes(d2.backupCodes);
        setStep('backup');
        return;
      }
      // The address saved even if enrolment did not — say so rather than
      // silently dropping the user into the dashboard with 2FA still off.
      setError(
        (d2.error ?? 'Could not turn on two-factor.') +
          ' Your email was saved — you can enable two-factor from Settings.',
      );
      setEnrollAfterEmail(false);
    } catch {
      setError('Cannot reach server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  function backToPassword() {
    setStep('password');
    setPendingToken(null);
    setCode('');
    setError('');
    setNotice('');
  }

  if (step === 'code') {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1 className="login-title">TradingAI</h1>
          <p className="login-sub">Check your email for a sign-in code</p>
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

  if (step === 'codeRequest') {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1 className="login-title">TradingAI</h1>
          <p className="login-sub">Sign in with an emailed code</p>
          <form onSubmit={handleRequestLoginCode} className="login-form">
            <p className="login-sub">
              We&apos;ll send a one-time code to the email address on your account. No password needed.
            </p>
            <label className="login-label">
              Username
              <input
                className="login-input"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
                disabled={loading}
              />
            </label>
            {error && <p className="login-error">{error}</p>}
            <button type="submit" disabled={loading} className="login-btn">
              {loading ? 'Sending…' : 'Email me a code'}
            </button>
            <button type="button" className="login-forgot-link" onClick={backToPassword} disabled={loading}>
              Use my password instead
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (step === 'email') {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1 className="login-title">TradingAI</h1>
          <p className="login-sub">Add your email address</p>
          <form onSubmit={handleSaveEmail} className="login-form">
            {notice && <p className="login-sub">{notice}</p>}
            <label className="login-label">
              Email address
              <input
                className="login-input"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
                required
                disabled={loading}
              />
            </label>
            {error && <p className="login-error">{error}</p>}
            <button type="submit" disabled={loading} className="login-btn">
              {loading ? 'Saving…' : 'Save & continue'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (step === 'backup') {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1 className="login-title">TradingAI</h1>
          <p className="login-sub">Two-factor is on — save your backup codes</p>
          <div className="login-form">
            <p className="login-sub">
              Each code works once if you can&apos;t reach your email. This is the only time they&apos;re shown.
            </p>
            <pre className="login-codes">{(backupCodes ?? []).join('\n')}</pre>
            <button
              type="button"
              className="login-btn"
              onClick={() => { if (sessionToken) completeLogin(sessionToken); }}
            >
              I&apos;ve saved them — continue
            </button>
          </div>
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
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              required
              disabled={loading}
            />
          </label>
          <label className="login-check">
            <input
              type="checkbox"
              checked={enrollTwoFactor}
              onChange={e => setEnrollTwoFactor(e.target.checked)}
              disabled={loading}
            />
            <span>
              Turn on two-factor authentication — we&apos;ll email a 6-digit code each time you sign in.
            </span>
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" disabled={loading} className="login-btn">
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
          <button
            type="button"
            className="login-forgot-link"
            onClick={() => { setStep('codeRequest'); setError(''); setNotice(''); }}
            disabled={loading}
          >
            Email me a sign-in code instead
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
