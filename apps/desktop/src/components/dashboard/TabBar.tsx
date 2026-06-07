// TRA-690 — grouped tab navigation. As features piled up, the flat tab bar
// sprawled to 8 (stocks) / 6 (crypto) buttons. This keeps the core trading
// workflow visible and collapses the secondary/reference surfaces into a single
// "More ▾" dropdown so the bar stays clean and scannable. The dropdown reuses
// the ProfileMenu portal pattern (transparent backdrop + fixed-position menu,
// `.profile-dropdown*` styles) so open/close behaviour matches the rest of the
// app.
import { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface TabDef<T extends string = string> {
  id: T;
  /** Visible button label (counts already interpolated by the caller). */
  label: string;
  /** Optional hover tooltip. */
  title?: string;
  /** Optional `data-tour="<id>"` anchor for the coach-mark tour. */
  dataTour?: string;
}

export function TabBar<T extends string>({
  active,
  onSelect,
  primary,
  more,
  moreLabel = 'More',
  moreTour,
}: {
  active: T;
  onSelect: (id: T) => void;
  /** Core tabs, always rendered flat. */
  primary: TabDef<T>[];
  /** Secondary tabs collapsed into the "More ▾" dropdown. */
  more?: TabDef<T>[];
  /** Trigger label when no `more` tab is active. */
  moreLabel?: string;
  /** `data-tour` anchor to keep on the trigger (so a tour stop whose tab now
   *  lives inside the dropdown still resolves to a visible element). */
  moreTour?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const hasMore = !!more && more.length > 0;
  const activeMoreTab = more?.find(t => t.id === active);

  // Position the dropdown under the trigger, clamped into the viewport, before
  // paint so it never flashes at (0,0). Mirrors ProfileMenu.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const left = Math.max(8, Math.min(rect.left, vw - 8 - 200));
    setPos({ top: rect.bottom + 4, left });
  }, [open]);

  // Close on viewport change (orientation, soft keyboard, address bar).
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
    <nav className="tabs">
      {primary.map(t => (
        <button
          key={t.id}
          data-tour={t.dataTour}
          className={`tab ${active === t.id ? 'active' : ''}`}
          onClick={() => onSelect(t.id)}
          title={t.title}
        >
          {t.label}
        </button>
      ))}

      {hasMore && (
        <div className="tab-more-wrap">
          <button
            ref={btnRef}
            data-tour={moreTour}
            className={`tab tab-more ${activeMoreTab ? 'active' : ''}`}
            onClick={() => setOpen(o => !o)}
            aria-haspopup="menu"
            aria-expanded={open}
            title="More views"
          >
            {activeMoreTab ? activeMoreTab.label : moreLabel} &#9660;
          </button>
          {open && createPortal(
            <>
              <div className="profile-dropdown-backdrop" onClick={() => setOpen(false)} />
              <div
                className="profile-dropdown tab-more-dropdown"
                role="menu"
                style={{ position: 'fixed', top: pos.top, left: pos.left }}
              >
                {more!.map(t => (
                  <button
                    key={t.id}
                    className={`profile-dropdown-item ${active === t.id ? 'active' : ''}`}
                    role="menuitem"
                    title={t.title}
                    onClick={() => { onSelect(t.id); setOpen(false); }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </>,
            document.body
          )}
        </div>
      )}
    </nav>
  );
}
