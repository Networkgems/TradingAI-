import React from 'react';
import { captureClientError, newTraceId } from './lib/telemetry';

// TRA-398 — React error boundary.
//
// Before this, any uncaught render-time exception in App.tsx or a child
// component unmounted the entire React tree and left the user on a blank
// white screen with no recovery path and nothing reported. For a live
// trading dashboard a single malformed broker/engine payload that reached
// render could take down desktop and mobile PWA alike.
//
// This boundary catches such errors, renders a fallback UI with a reload
// action, logs to the console, and reports the error to the server.
//
// TRA-413 — the report now goes through `captureClientError`, which forwards
// it to the server's queryable error destination (`errors.jsonl` /
// `ERROR_WEBHOOK_URL`). Each error is filed under a trace id that the fallback
// UI shows, so a user can quote it in a bug report and ops can pull every
// correlated log line.

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
  /** Trace id the error was filed under — shown so the user can quote it. */
  traceId: string | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, traceId: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // Mint the trace id here so it is on screen the moment the fallback paints,
    // before the async report in componentDidCatch has even started.
    return { error, traceId: newTraceId() };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);
    captureClientError(this.props.label, error, {
      source: 'renderer',
      componentStack: info.componentStack ?? null,
      traceId: this.state.traceId ?? newTraceId(),
    });
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleRetry = (): void => {
    // Clear the error so the wrapped subtree re-mounts. Useful for per-tab
    // boundaries where a transient bad payload may have since been replaced.
    this.setState({ error: null, traceId: null });
  };

  render(): React.ReactNode {
    const { error, traceId } = this.state;
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
          {traceId && (
            <div className="error-boundary-trace">
              Reference id: <code>{traceId}</code>
              <div className="error-boundary-trace-hint">
                Quote this id in a bug report so we can trace what happened.
              </div>
            </div>
          )}
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
