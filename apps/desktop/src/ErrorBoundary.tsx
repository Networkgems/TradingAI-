import React from 'react';
import { HTTP_URL } from './server-url.ts';

// TRA-398 — React error boundary.
//
// Before this, any uncaught render-time exception in App.tsx or a child
// component unmounted the entire React tree and left the user on a blank
// white screen with no recovery path and nothing reported. For a live
// trading dashboard a single malformed broker/engine payload that reached
// render could take down desktop and mobile PWA alike.
//
// This boundary catches such errors, renders a fallback UI with a reload
// action, logs to the console, and makes a best-effort report to the server
// so QA/ops have visibility. Used at the top level (around <App/>) and at a
// finer grain around each dashboard's tab content so one bad tab does not
// white-screen the whole app.

interface ErrorBoundaryProps {
  /** Human-readable name of the wrapped region, used in the report + log. */
  label: string;
  /**
   * 'page' renders a full-screen fallback (top-level use); 'panel' renders an
   * inline fallback sized to the wrapped region (per-tab use).
   */
  variant?: 'page' | 'panel';
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Best-effort, fire-and-forget client error report. Never throws — a failure
// to report must not itself crash the fallback UI.
function reportClientError(label: string, error: Error, info: React.ErrorInfo): void {
  try {
    const payload = {
      label,
      message: String(error?.message ?? error),
      stack: error?.stack ?? null,
      componentStack: info?.componentStack ?? null,
      url: typeof window !== 'undefined' ? window.location.href : null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      time: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);
    // The body is JSON, but we send it as text/plain on purpose. An
    // application/json Content-Type is NOT a CORS-safelisted request header,
    // so cross-origin (e.g. the Tauri desktop webview hitting a remote API)
    // it forces a CORS preflight. Chromium sends the OPTIONS preflight but
    // then silently drops the sendBeacon POST — and sendBeacon still returns
    // true, so the lost report is invisible. text/plain is CORS-safelisted,
    // so no preflight is needed and the beacon delivers cross-origin. The
    // server parses /api/client-error as text and JSON.parses the body.
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(`${HTTP_URL}/api/client-error`, new Blob([body], { type: 'text/plain' }));
    } else {
      void fetch(`${HTTP_URL}/api/client-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
        keepalive: true,
      }).catch(() => { /* reporting is best-effort */ });
    }
  } catch {
    /* reporting is best-effort — never let it surface to the user */
  }
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);
    reportClientError(this.props.label, error, info);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleRetry = (): void => {
    // Clear the error so the wrapped subtree re-mounts. Useful for per-tab
    // boundaries where a transient bad payload may have since been replaced.
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const variant = this.props.variant ?? 'page';
    const message = String(error.message ?? error);

    return (
      <div className={variant === 'page' ? 'error-boundary error-boundary-page' : 'error-boundary error-boundary-panel'}>
        <div className="error-boundary-card">
          <div className="error-boundary-title">Something went wrong</div>
          <div className="error-boundary-text">
            {variant === 'page'
              ? 'The app hit an unexpected error and could not continue rendering.'
              : `This section ("${this.props.label}") hit an unexpected error.`}
          </div>
          <pre className="error-boundary-detail">{message}</pre>
          <div className="error-boundary-actions">
            {variant === 'panel' && (
              <button className="error-boundary-btn" onClick={this.handleRetry}>Try again</button>
            )}
            <button className="error-boundary-btn error-boundary-btn-primary" onClick={this.handleReload}>
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
