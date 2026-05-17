import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFocusTrap } from './useFocusTrap';

/** A minimal drawer that opens/closes and traps focus while open. */
function DrawerHarness({ onEscape }: { onEscape?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useFocusTrap<HTMLDivElement>(open, () => {
    onEscape?.();
    setOpen(false);
  });
  return (
    <div>
      <button data-testid="opener" onClick={() => setOpen(true)}>open</button>
      {open && (
        <div ref={ref} role="dialog" aria-label="Close position">
          <input data-testid="first" aria-label="price" />
          <button data-testid="middle">middle</button>
          <button data-testid="last">submit</button>
        </div>
      )}
    </div>
  );
}

describe('useFocusTrap', () => {
  it('moves focus to the first focusable element when the drawer opens', async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    await user.click(screen.getByTestId('opener'));
    expect(screen.getByTestId('first')).toHaveFocus();
  });

  it('wraps Tab from the last element back to the first', async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    await user.click(screen.getByTestId('opener'));
    screen.getByTestId('last').focus();
    await user.tab();
    expect(screen.getByTestId('first')).toHaveFocus();
  });

  it('wraps Shift+Tab from the first element to the last', async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    await user.click(screen.getByTestId('opener'));
    screen.getByTestId('first').focus();
    await user.tab({ shift: true });
    expect(screen.getByTestId('last')).toHaveFocus();
  });

  it('calls onEscape when Escape is pressed inside the drawer', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    render(<DrawerHarness onEscape={onEscape} />);
    await user.click(screen.getByTestId('opener'));
    await user.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('restores focus to the opener after the drawer closes', async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    const opener = screen.getByTestId('opener');
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });
});
