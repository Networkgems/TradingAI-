// TRA-419 — ProfileMenu component extracted from App.tsx.
import { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';

export function ProfileMenu({ onSettings, onChangePassword, onUserManagement, onLogout, isAdmin, onReplayTour }: {
  onSettings: () => void;
  onChangePassword: () => void;
  onUserManagement: () => void;
  onLogout: () => void;
  isAdmin: boolean;
  /**
   * TRA-569 — optional "Replay product tour" entry. Only the Stocks dashboard
   * (which has the `data-tour` anchors + a mounted tour) passes this; the menu
   * item is hidden everywhere else so it never dead-ends.
   */
  onReplayTour?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  // Compute position synchronously before paint so the dropdown never flashes at (0,0).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const top = rect.bottom + 6;
    // Clamp `right` so the dropdown never escapes the viewport when the trigger
    // sits inside a horizontally-scrolled container (e.g. .header-right on mobile).
    const right = Math.max(8, Math.min(vw - 8, vw - rect.right));
    setPos({ top, right });
  }, [open]);

  // Close when the viewport changes (orientation, soft keyboard, address bar).
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    window.addEventListener('orientationchange', close);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('orientationchange', close);
    };
  }, [open]);

  return (
    <div className="profile-wrap">
      <button
        ref={btnRef}
        className="logout-btn"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Profile menu"
      >
        &#x1F464; Profile &#9660;
      </button>
      {open && createPortal(
        <>
          {/* Transparent full-viewport backdrop. Catches the next outside tap reliably
              on mobile, where document-level click listeners race with the synthetic
              click that opened the menu. */}
          <div
            className="profile-dropdown-backdrop"
            onClick={() => setOpen(false)}
          />
          <div
            className="profile-dropdown"
            role="menu"
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
          >
            <button
              className="profile-dropdown-item"
              role="menuitem"
              onClick={() => { onSettings(); setOpen(false); }}
            >
              Settings
            </button>
            <button
              className="profile-dropdown-item"
              role="menuitem"
              onClick={() => { onChangePassword(); setOpen(false); }}
            >
              Change Password
            </button>
            {isAdmin && (
              <button
                className="profile-dropdown-item"
                role="menuitem"
                onClick={() => { onUserManagement(); setOpen(false); }}
              >
                Account Management
              </button>
            )}
            {onReplayTour && (
              <>
                <div className="profile-dropdown-divider" />
                <button
                  className="profile-dropdown-item"
                  role="menuitem"
                  onClick={() => { setOpen(false); onReplayTour(); }}
                >
                  Replay product tour
                </button>
              </>
            )}
            <div className="profile-dropdown-divider" />
            <button
              className="profile-dropdown-item danger"
              role="menuitem"
              onClick={() => { setOpen(false); onLogout(); }}
            >
              Sign Out
            </button>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
