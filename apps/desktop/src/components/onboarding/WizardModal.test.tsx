// TRA-565 — first-run wizard behaviour + accessibility.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WizardModal } from './WizardModal';

function renderWizard() {
  const onFinish = vi.fn();
  const onConnectBroker = vi.fn();
  render(<WizardModal onFinish={onFinish} onConnectBroker={onConnectBroker} />);
  return { onFinish, onConnectBroker };
}

describe('WizardModal', () => {
  it('opens on step 1 (Demo vs Live) with a 4-dot progress indicator', () => {
    renderWizard();
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Demo vs Live' })).toBeInTheDocument();
    expect(screen.getByLabelText('Step 1 of 4')).toBeInTheDocument();
  });

  it('advances through all four steps with the Next button and finishes completed', async () => {
    const user = userEvent.setup();
    const { onFinish } = renderWizard();
    await user.click(screen.getByRole('button', { name: 'Next →' }));
    expect(screen.getByRole('heading', { name: /Connect a broker/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next →' }));
    expect(screen.getByRole('heading', { name: 'Your dashboard' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next →' }));
    expect(screen.getByRole('heading', { name: "You're set" })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(onFinish).toHaveBeenCalledWith('completed');
  });

  it('navigates steps with the arrow keys (design §3.4)', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
  });

  it('does not advance past the last step or before the first', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.keyboard('{ArrowLeft}'); // already at step 1 — no-op
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument();
  });

  it('skips (finishes as skipped) from the Skip tour button', async () => {
    const user = userEvent.setup();
    const { onFinish } = renderWizard();
    await user.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(onFinish).toHaveBeenCalledWith('skipped');
  });

  it('Esc skips the wizard (focus-trap onEscape)', async () => {
    const user = userEvent.setup();
    const { onFinish } = renderWizard();
    await user.keyboard('{Escape}');
    expect(onFinish).toHaveBeenCalledWith('skipped');
  });

  it('the broker step fires onConnectBroker (deep-link to Settings)', async () => {
    const user = userEvent.setup();
    const { onConnectBroker, onFinish } = renderWizard();
    await user.click(screen.getByRole('button', { name: 'Next →' }));
    await user.click(screen.getByRole('button', { name: 'Open broker settings' }));
    expect(onConnectBroker).toHaveBeenCalledTimes(1);
    // The component leaves completion to the gate's onConnectBroker wrapper, so
    // it must NOT also call onFinish.
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('moves focus into the dialog on open (focus-trap)', () => {
    renderWizard();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
