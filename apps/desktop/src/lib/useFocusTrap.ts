// TRA-409 — accessibility hook for modal dialogs / drawers.
//
// The TRA-358 close drawer had no focus management: Tab could escape into the
// page behind it and Esc did nothing. useFocusTrap keeps Tab focus inside the
// container while it is open, moves focus in on open, restores focus to the
// previously-focused element on close, and calls onEscape when Esc is pressed.

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(el => el.getAttribute('aria-hidden') !== 'true');
}

/**
 * Trap keyboard focus inside the returned ref's element while `active` is true.
 *
 * @param active   Whether the trap is engaged (e.g. the drawer is open).
 * @param onEscape Called when Escape is pressed inside the container.
 * @returns A ref to attach to the dialog/drawer container element.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
  onEscape?: () => void,
) {
  const containerRef = useRef<T | null>(null);
  // Keep onEscape in a ref so changing the callback identity does not
  // re-run the effect and steal/restore focus on every parent render.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the dialog so keyboard users start inside it.
    const initial = focusableElements(container);
    if (initial.length > 0) {
      initial[0].focus();
    } else if (typeof container.focus === 'function') {
      container.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEscapeRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableElements(container as HTMLElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || activeEl === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Restore focus to wherever it was before the dialog opened.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active]);

  return containerRef;
}
