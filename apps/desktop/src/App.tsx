import { useEffect, useRef, useState } from 'react';
import LoginPage from './LoginPage.tsx';
import ForgotPasswordPage from './ForgotPasswordPage.tsx';
import SignUpPage from './SignUpPage.tsx';
import LandingPage from './LandingPage.tsx';
import FeaturesPage from './FeaturesPage.tsx';
import { HTTP_URL } from './server-url';
import { ThemeToggle, useTheme } from './components/ThemeToggle';
import { DashboardSelector } from './components/DashboardSelector';
import { SkippedSignalsPanel } from './components/SkippedSignalsPanel';
export { SkippedSignalsPanel };
import { OnboardingGate } from './components/onboarding/OnboardingGate';
import { ONBOARDING_DEEP_LINK_KEY, OPEN_BROKER_SETTINGS_EVENT } from './lib/onboarding-deep-link';
import CryptoDashboard from './CryptoDashboard';
import Dashboard from './Dashboard';
import './index.css';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_WARN_MS = 2 * 60 * 1000;

type AuthScreen = 'landing' | 'features' | 'login' | 'forgot' | 'signup';

export default function App() {
  const { theme, toggleTheme } = useTheme();

  const [token, setToken] = useState<string | null>(() => localStorage.getItem('auth_token'));
  const [tokenChecked, setTokenChecked] = useState<boolean>(() => !localStorage.getItem('auth_token'));
  const [authScreen, setAuthScreen] = useState<AuthScreen>(() =>
    new URLSearchParams(window.location.search).has('reset_code') ? 'forgot' : 'landing'
  );
  const [appMode, setAppMode] = useState<null | 'stocks' | 'crypto'>(() => {
    const stored = localStorage.getItem('tradingMode');
    return stored === 'stocks' || stored === 'crypto' ? stored : null;
  });
  const [idleWarning, setIdleWarning] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetIdleTimerRef = useRef<() => void>(() => {});

  function handleLogout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('tradingMode');
    setToken(null);
    setTokenChecked(true);
    setAuthScreen('login');
    setAppMode(null);
    setIdleWarning(false);
  }

  useEffect(() => {
    const stored = localStorage.getItem('auth_token');
    if (!stored) return;
    let cancelled = false;
    fetch(`${HTTP_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${stored}` },
    }).then(r => {
      if (cancelled) return;
      if (r.status === 401) {
        handleLogout();
      } else {
        setTokenChecked(true);
      }
    }).catch(() => {
      if (!cancelled) setTokenChecked(true);
    });
    return () => { cancelled = true; };
  }, []);

  function resetIdleTimer() {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
    setIdleWarning(false);
    warnTimerRef.current = setTimeout(() => setIdleWarning(true), IDLE_TIMEOUT_MS - IDLE_WARN_MS);
    idleTimerRef.current = setTimeout(handleLogout, IDLE_TIMEOUT_MS);
  }
  resetIdleTimerRef.current = resetIdleTimer;

  useEffect(() => {
    if (!token) return;
    const handler = () => resetIdleTimerRef.current();
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    events.forEach(ev => document.addEventListener(ev, handler, { passive: true }));
    resetIdleTimerRef.current();
    return () => {
      events.forEach(ev => document.removeEventListener(ev, handler));
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
    };
  }, [token]);

  function selectMode(mode: 'stocks' | 'crypto') {
    localStorage.setItem('tradingMode', mode);
    setAppMode(mode);
  }

  function goHome() {
    localStorage.removeItem('tradingMode');
    setAppMode(null);
  }

  // TRA-565 — onboarding step 2 "Open broker settings" deep-link. Brokers live
  // inside a dashboard's Settings modal, so we drop a breadcrumb and either
  // (a) mount the stocks dashboard if the user is still on the home selector —
  // the dashboard reads the breadcrumb on mount and pops Settings, or
  // (b) fire an event the already-mounted dashboard listens for.
  function handleConnectBroker() {
    localStorage.setItem(ONBOARDING_DEEP_LINK_KEY, 'brokers');
    if (appMode === null) {
      selectMode('stocks');
    } else {
      window.dispatchEvent(new CustomEvent(OPEN_BROKER_SETTINGS_EVENT));
    }
  }

  const floatingToggle = (
    <div className="theme-toggle-floating">
      <ThemeToggle theme={theme} onToggle={toggleTheme} />
    </div>
  );

  if (!token) {
    // TRA-1520 — the landing & features pages use the `.lp` fixed dark palette
    // (the light/dark toggle is a no-op there) and carry their own top nav with
    // a Sign-in button. The floating toggle sat on top of that Sign-in button on
    // mobile, making it untappable, so it is omitted on these two marketing
    // screens. It still renders on the theme-respecting login/signup/forgot pages.
    if (authScreen === 'landing') {
      return (
        <LandingPage
          onStart={() => setAuthScreen('signup')}
          onFeatures={() => setAuthScreen('features')}
          onSignIn={() => setAuthScreen('login')}
        />
      );
    }
    if (authScreen === 'features') {
      return (
        <FeaturesPage
          onStart={() => setAuthScreen('signup')}
          onHome={() => setAuthScreen('landing')}
          onSignIn={() => setAuthScreen('login')}
        />
      );
    }
    if (authScreen === 'forgot') {
      return (
        <>
          {floatingToggle}
          <ForgotPasswordPage onBack={() => setAuthScreen('login')} />
        </>
      );
    }
    if (authScreen === 'signup') {
      return (
        <>
          {floatingToggle}
          <SignUpPage onSignUp={(t) => { setTokenChecked(true); setToken(t); }} onBack={() => setAuthScreen('login')} />
        </>
      );
    }
    return (
      <>
        {floatingToggle}
        <LoginPage onLogin={(t) => { setTokenChecked(true); setToken(t); }} onForgotPassword={() => setAuthScreen('forgot')} onSignUp={() => setAuthScreen('signup')} onFeatures={() => setAuthScreen('features')} />
      </>
    );
  }

  if (!tokenChecked) return null;

  const mainContent = appMode === null
    ? <DashboardSelector onSelect={selectMode} onLogout={handleLogout} theme={theme} onToggleTheme={toggleTheme} />
    : appMode === 'crypto'
      ? <CryptoDashboard token={token} onBack={goHome} onLogout={handleLogout} onActivity={() => resetIdleTimerRef.current()} theme={theme} onToggleTheme={toggleTheme} />
      : <Dashboard token={token} onLogout={handleLogout} onGoHome={goHome} onActivity={() => resetIdleTimerRef.current()} theme={theme} onToggleTheme={toggleTheme} />;

  return (
    <>
      {mainContent}
      <OnboardingGate token={token} onConnectBroker={handleConnectBroker} />
      {idleWarning && (
        <div className="idle-warning-banner">
          <span>You've been idle — you'll be signed out automatically in 2 minutes.</span>
          <button className="idle-warning-btn" onClick={() => resetIdleTimerRef.current()}>Stay signed in</button>
        </div>
      )}
    </>
  );
}
