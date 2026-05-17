// TRA-413 — smoke test for the React error boundary. `apps/desktop` had no
// tests before (TRA-402 §6); this is the minimum the issue asks for: prove a
// thrown render error trips the fallback, shows a quotable trace id, and fires
// a telemetry report.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

// A component that throws during render, to trip the boundary.
function Boom() {
  throw new Error('kaboom-from-render');
}

describe('ErrorBoundary (TRA-413 smoke test)', () => {
  beforeEach(() => {
    // jsdom has no sendBeacon; stub it so telemetry delivery is an inert no-op.
    Object.defineProperty(navigator, 'sendBeacon', {
      value: vi.fn(() => true),
      configurable: true,
    });
    // React and the boundary both console.error a caught error; silence it so
    // test output stays readable without dropping the assertions below.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders the fallback with the error message and a quotable trace id', () => {
    render(
      <ErrorBoundary label="smoke-region">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText(/kaboom-from-render/)).toBeInTheDocument();
    // The trace id (a UUID) is shown so a user can quote it in a bug report.
    expect(screen.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-/i)).toBeInTheDocument();
    expect(navigator.sendBeacon).toHaveBeenCalledOnce();
  });

  it('renders children unchanged when nothing throws', () => {
    render(
      <ErrorBoundary label="healthy">
        <div>all good</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeInTheDocument();
  });
});
