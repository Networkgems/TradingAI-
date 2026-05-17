import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider, ToastViewport, useToast } from './toast';

/** Harness exposing a button per toast kind. */
function ToastHarness() {
  const toast = useToast();
  return (
    <div>
      <button onClick={() => toast.success('saved ok')}>ok</button>
      <button onClick={() => toast.error('it failed')}>fail</button>
      <button onClick={() => toast.info('heads up', 0)}>sticky</button>
      <ToastViewport />
    </div>
  );
}

function renderHarness() {
  return render(
    <ToastProvider>
      <ToastHarness />
    </ToastProvider>,
  );
}

describe('ToastProvider / useToast', () => {
  afterEach(() => vi.useRealTimers());

  it('shows a success toast when an action succeeds', () => {
    renderHarness();
    fireEvent.click(screen.getByText('ok'));
    const toast = screen.getByText('saved ok').closest('.toast')!;
    expect(toast.className).toContain('toast-success');
    expect(toast).toHaveAttribute('role', 'status');
  });

  it('shows an error toast with role=alert', () => {
    renderHarness();
    fireEvent.click(screen.getByText('fail'));
    const toast = screen.getByText('it failed').closest('.toast')!;
    expect(toast).toHaveAttribute('role', 'alert');
  });

  it('auto-dismisses a success toast after its duration', () => {
    vi.useFakeTimers();
    renderHarness();
    fireEvent.click(screen.getByText('ok'));
    expect(screen.getByText('saved ok')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByText('saved ok')).not.toBeInTheDocument();
  });

  it('keeps a toast with duration 0 until dismissed manually', () => {
    vi.useFakeTimers();
    renderHarness();
    fireEvent.click(screen.getByText('sticky'));
    act(() => { vi.advanceTimersByTime(60000); });
    expect(screen.getByText('heads up')).toBeInTheDocument();
    const toast = screen.getByText('heads up').closest('.toast')!;
    fireEvent.click(within(toast as HTMLElement).getByLabelText('Dismiss notification'));
    expect(screen.queryByText('heads up')).not.toBeInTheDocument();
  });

  it('stacks multiple toasts', () => {
    renderHarness();
    fireEvent.click(screen.getByText('ok'));
    fireEvent.click(screen.getByText('fail'));
    expect(screen.getByText('saved ok')).toBeInTheDocument();
    expect(screen.getByText('it failed')).toBeInTheDocument();
  });

  it('throws when useToast is used outside a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ToastHarness />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});
