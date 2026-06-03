// TRA-569 (TRA-410 C2) — a single coach-mark: dimmed backdrop with a spotlight
// cut-out over one anchored element plus a positioned tooltip (design §3.3).
//
// Presentational only — it knows nothing about the tour sequence. The dimming is
// a pure-CSS trick: a transparent "spotlight" box sized to the target casts a
// huge `box-shadow` that darkens everything *except* the hole. A separate full-
// screen blocker captures clicks so the dimmed app can't be interacted with mid-
// tour. When `rect` is null (anchor missing) the tooltip centres and no spotlight
// is drawn — graceful degradation rather than a stuck tour.
//
// Standalone component (design §6): mounted via a portal, never spliced into the
// App.tsx / Dashboard shell markup.
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface CoachMarkProps {
  /** Target element's viewport rect, or null if the anchor can't be found. */
  rect: AnchorRect | null;
  title: string;
  body: string;
  /** 0-based position in the tour. */
  index: number;
  /** Total number of stops, for the "n / total" counter. */
  total: number;
  onBack: () => void;
  onNext: () => void;
  /** Skip / end the tour entirely. */
  onClose: () => void;
}

/** Padding (px) around the spotlight cut-out and between target and tooltip. */
const GAP = 10;
/** Conservative tooltip width used for horizontal clamping. */
const TIP_WIDTH = 300;
/** Conservative tooltip height used when deciding above-vs-below placement. */
const TIP_HEIGHT = 150;

export function CoachMark({ rect, title, body, index, total, onBack, onNext, onClose }: CoachMarkProps) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const tipRef = useRef<HTMLDivElement>(null);

  // Move focus into the tooltip so keyboard users land on the live coach-mark
  // and arrow/Esc keys (owned by the tour) have a sensible focus origin.
  useLayoutEffect(() => {
    tipRef.current?.focus();
  }, [index]);

  // Window dims are read at render; the tour re-renders this on resize/scroll so
  // the values stay fresh without a local listener here.
  const [vw, vh] = typicalViewport();

  const spotlightStyle = rect
    ? {
        top: rect.top - GAP,
        left: rect.left - GAP,
        width: rect.width + GAP * 2,
        height: rect.height + GAP * 2,
      }
    : undefined;

  let tipStyle: React.CSSProperties;
  if (rect) {
    const spaceBelow = vh - (rect.top + rect.height);
    const placeBelow = spaceBelow > TIP_HEIGHT + GAP * 2 || spaceBelow > rect.top;
    const top = placeBelow
      ? rect.top + rect.height + GAP * 2
      : Math.max(GAP, rect.top - GAP * 2 - TIP_HEIGHT);
    // Left-align with the target, clamped into the viewport.
    const left = Math.max(GAP, Math.min(rect.left, vw - TIP_WIDTH - GAP));
    tipStyle = { top, left };
  } else {
    tipStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }

  const titleId = `coachmark-title-${index}`;
  const bodyId = `coachmark-body-${index}`;

  return createPortal(
    <div className="coachmark-root" data-testid="coachmark">
      {/* Click-blocker so the dimmed app behind the tour is inert. */}
      <div className="coachmark-blocker" />
      {spotlightStyle && (
        <div className="coachmark-spotlight" style={spotlightStyle} aria-hidden="true" />
      )}
      <div
        ref={tipRef}
        className="coachmark-tooltip"
        style={{ ...tipStyle, maxWidth: TIP_WIDTH }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="coachmark-title">{title}</h3>
        <p id={bodyId} className="coachmark-body">{body}</p>
        <footer className="coachmark-footer">
          <button type="button" className="coachmark-skip" onClick={onClose}>
            Skip
          </button>
          <span className="coachmark-count" aria-hidden="true">
            {index + 1} / {total}
          </span>
          <div className="coachmark-nav">
            <button
              type="button"
              className="coachmark-back"
              onClick={onBack}
              disabled={isFirst}
            >
              Back
            </button>
            <button type="button" className="coachmark-next coachmark-primary" onClick={onNext}>
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body
  );
}

/** Viewport size with a jsdom-safe fallback (window dims are 0 in some tests). */
function typicalViewport(): [number, number] {
  const w = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024;
  const h = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 768;
  return [w, h];
}
